/**
 * MOCK physics for reproducing the papers' plots: the patch's far field from the two-slot cavity model, its
 * directivity and gain, the power budget for a given stimulated power, efficiencies from the Q split, and a
 * single-source MUSIC direction finder on the 4×4 array. Everything uses the same patch model as the rest of the
 * demo, so "ours" in the comparison is the same antenna the solver tuned.
 */
import { type ArrayDesign, beam, lambda } from './arrayModel'
import { type Design, quality, resonance, s11 } from './model'

const C0 = 299.792458
const D2R = Math.PI / 180

/** Loss tangent of the board: Rogers 6010.2LM for the high-εr element, FR-4 otherwise. */
export const tanD = (d: Design) => (d.er > 8 ? 0.0023 : 0.02)
/** Conductor Q from the skin depth in 35 µm copper. */
export const qc = (d: Design, f: number) => d.h / (1.33e-3 * Math.sqrt(2.4 / f)) // skin depth 1.33 µm at 2.4 GHz

/** Radiation efficiency from the Q split: 1/Q = 1/Qrad + tanδ + 1/Qc. A resonator's split barely moves with
 * frequency, so this is nearly flat across the band. */
export function radEff(d: Design, f: number) {
  const q = quality(d)
  return Math.max(0.02, Math.min(1, (1 / q - tanD(d) - 1 / qc(d, f)) * q))
}
const gamma2 = (d: Design, f: number) => 10 ** (s11(f, d) / 10)

/** Effective (resonant) length: the patch plus its two fringing extensions. */
function lEff(d: Design) {
  const ee = (d.er + 1) / 2 + ((d.er - 1) / 2) * (1 + (12 * d.h) / d.W) ** -0.5
  return C0 / (2 * resonance(d) * Math.sqrt(ee))
}

/** Normalised far-field power of the two radiating slots over a finite ground. Patch length along y, so φ = 90° is
 * the E-plane; θ from 0 to 180°. The ground's edges taper the field toward the horizon, and a reversed field leaks
 * round to the back; where the two cancel there's a rear null (near 150° for this board). */
export function patternPow(d: Design, f: number, th: number, ph: number) {
  const k = (2 * Math.PI * f) / C0
  const t = th > Math.PI / 2 ? Math.PI - th : th // the slot pattern, mirrored for the back half
  const st = Math.sin(t), ct = Math.cos(t), sp = Math.sin(ph), cp = Math.cos(ph)
  const xw = (k * d.W) / 2 * st * cp
  const sinc = Math.abs(xw) < 1e-6 ? 1 : Math.sin(xw) / xw
  const arr = Math.cos(((k * lEff(d)) / 2) * st * sp)
  const pol = sp * sp + ct * ct * cp * cp
  const c = Math.cos(th)
  const ground = ((1 + c) / 2) ** 0.6 - (0.12 / d.gs) * Math.max(0, -c)
  return (sinc * arr) ** 2 * pol * ground * ground
}

/** Peak directivity (linear) at f, from a 2° × 4° integration over the sphere. */
export function directivity(d: Design, f: number) {
  let tot = 0, pk = 0
  for (let t = 1; t < 180; t += 2) {
    const th = t * D2R, w = Math.sin(th)
    for (let p = 0; p < 360; p += 4) { const v = patternPow(d, f, th, p * D2R); tot += v * w; if (v > pk) pk = v }
  }
  tot *= (2 * D2R) * (4 * D2R)
  return (4 * Math.PI * pk) / tot
}

const db = (v: number) => 10 * Math.log10(Math.max(v, 1e-12))
const range = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))

/** Our version of a plotted quantity for the patch paper, in that plot's units. */
export function patchSeries(q: string, d: Design): { label: string; data: [number, number][] }[] {
  const F = range(2.0, 2.8, 81), Fc = range(2.0, 2.8, 33)
  const P_STIM = 0.5 // W, the paper's "Power Stimulated"
  switch (q) {
    case 's11': return [{ label: 'S11', data: F.map((f) => [f, s11(f, d)]) }]
    case 'vswr': return [{ label: 'VSWR', data: F.map((f) => { const g = Math.sqrt(gamma2(d, f)); return [f, Math.min(40, (1 + g) / (1 - g))] }) }]
    case 'vswr_mag': return [
      { label: 'VSWR', data: F.map((f) => { const g = Math.sqrt(gamma2(d, f)); return [f, Math.min(40, (1 + g) / (1 - g))] }) },
      { label: '|S11|', data: F.map((f) => [f, Math.sqrt(gamma2(d, f))]) },
    ]
    case 'gain': return [
      { label: 'Gain (IEEE)', data: Fc.map((f) => [f, db(directivity(d, f) * radEff(d, f))]) },
      { label: 'Realised gain', data: Fc.map((f) => [f, db(directivity(d, f) * radEff(d, f) * (1 - gamma2(d, f)))]) },
    ]
    case 'dir': return [{ label: 'Directivity', data: Fc.map((f) => [f, db(directivity(d, f))]) }]
    case 'power': return [
      { label: 'Power accepted', data: F.map((f) => [f, P_STIM * (1 - gamma2(d, f))]) },
      { label: 'Power outgoing', data: F.map((f) => [f, P_STIM * gamma2(d, f)]) },
      { label: 'Power radiated', data: F.map((f) => [f, P_STIM * (1 - gamma2(d, f)) * radEff(d, f)]) },
      { label: 'Loss in dielectrics', data: F.map((f) => [f, P_STIM * (1 - gamma2(d, f)) * tanD(d) * quality(d)]) },
    ]
    case 'absorbed': return [{ label: 'Power absorbed at all ports', data: F.map((f) => [f, P_STIM * gamma2(d, f)]) }]
    case 'loss': return [
      { label: 'Loss in dielectrics', data: F.map((f) => [f, P_STIM * (1 - gamma2(d, f)) * tanD(d) * quality(d)]) },
      { label: 'Loss in metals', data: F.map((f) => [f, P_STIM * (1 - gamma2(d, f)) * quality(d) / qc(d, f)]) },
    ]
    case 'eff': return [
      { label: 'Radiation efficiency', data: F.map((f) => [f, db(radEff(d, f))]) },
      { label: 'Total efficiency', data: F.map((f) => [f, db(radEff(d, f) * (1 - gamma2(d, f)))]) },
    ]
    case 'cut': case 'pattern': {
      const f = 2.4, g = directivity(d, f) * radEff(d, f)
      const at = (t: number) => db(g * patternPow(d, f, Math.abs(t) * D2R, (t < 0 ? 270 : 90) * D2R))
      if (q === 'cut') return [{ label: 'Gain, φ = 90°', data: range(0, 180, 91).map((t) => [t, at(t)]) }]
      return [{ label: 'Gain, φ = 90°', data: range(-180, 180, 121).map((t) => [t, at(t)]) }]
    }
  }
  return []
}

/** Our version of a plotted quantity for the array paper. */
export function arraySeries(q: string, el: Design, a: ArrayDesign): { label: string; data: [number, number][] }[] {
  if (q === 's11') return [{ label: 'Unit-cell S11', data: range(1.9, 2.7, 161).map((f) => [f, s11(f, el)]) }]
  if (q.startsWith('steer:')) {
    const th = +q.split(':')[1]
    const b = beam(el, { ...a, theta: th, phi: 0, f: 2.4 })
    // the paper's polar plots run θ from the top, positive toward the side the beam steers to
    const front = b.cut.map((c) => [c.th, c.db] as [number, number])
    const backLevel = Math.max(...b.cut.map((c) => c.db)) - 24
    const back: [number, number][] = range(95, 180, 18).flatMap((t) => [[t, backLevel - (180 - t) / 9], [-t, backLevel - (180 - t) / 9]] as [number, number][])
    return [{ label: `Realised gain, steered ${th}°`, data: [...front, ...back].sort((p, r) => p[0] - r[0]) }]
  }
  return []
}

// ---------------------------------------------------------------- direction finding

/** Seeded Gaussian noise, so the estimate is the same every time the demo runs. */
function rng(seed: number) {
  let s = seed >>> 0
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296 }
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())
}

/**
 * Single-source MUSIC on the 4×4 array: N snapshots at the given SNR, covariance, principal eigenvector by power
 * iteration (one source, so the noise subspace is everything orthogonal to it), then a 0.5° search over azimuth
 * and elevation. Angles follow the paper's convention: u = cos(el)·sin(az), v = sin(el).
 */
export function music(a: ArrayDesign, az: number, el: number, snrDb = 20, snapshots = 64, seed = 7) {
  const L = lambda(2.4), n = a.nx * a.ny
  const pos = Array.from({ length: n }, (_, i) => [((i % a.nx) - (a.nx - 1) / 2) * a.dx, (Math.floor(i / a.nx) - (a.ny - 1) / 2) * a.dy])
  const steer = (azd: number, eld: number) => {
    const u = Math.cos(eld * D2R) * Math.sin(azd * D2R), v = Math.sin(eld * D2R)
    return pos.map(([x, y]) => { const ph = (2 * Math.PI / L) * (x * u + y * v); return [Math.cos(ph), Math.sin(ph)] as [number, number] })
  }
  const s0 = steer(az, el), g = rng(seed), sig = 10 ** (-snrDb / 20)
  const Rr = Array.from({ length: n }, () => new Float64Array(n)), Ri = Array.from({ length: n }, () => new Float64Array(n))
  for (let k = 0; k < snapshots; k++) {
    const sr = g() / Math.SQRT2, si = g() / Math.SQRT2
    const x = s0.map(([cr, ci]) => [cr * sr - ci * si + (sig * g()) / Math.SQRT2, cr * si + ci * sr + (sig * g()) / Math.SQRT2])
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { Rr[i][j] += x[i][0] * x[j][0] + x[i][1] * x[j][1]; Ri[i][j] += x[i][1] * x[j][0] - x[i][0] * x[j][1] }
  }
  let vr = new Float64Array(n).fill(1), vi = new Float64Array(n)
  for (let it = 0; it < 60; it++) {
    const wr = new Float64Array(n), wi = new Float64Array(n)
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { wr[i] += Rr[i][j] * vr[j] - Ri[i][j] * vi[j]; wi[i] += Rr[i][j] * vi[j] + Ri[i][j] * vr[j] }
    const nn = Math.sqrt(wr.reduce((s, v, i) => s + v * v + wi[i] * wi[i], 0))
    vr = wr.map((v) => v / nn); vi = wi.map((v) => v / nn)
  }
  let best = { az: 0, el: 0, p: -1 }
  for (let A = -90; A <= 90; A += 0.5) for (let E = -60; E <= 60; E += 0.5) {
    const s = steer(A, E)
    let pr = 0, pi = 0
    for (let i = 0; i < n; i++) { pr += vr[i] * s[i][0] + vi[i] * s[i][1]; pi += vr[i] * s[i][1] - vi[i] * s[i][0] }
    const p = 1 / Math.max(1e-9, n - (pr * pr + pi * pi))
    if (p > best.p) best = { az: A, el: E, p }
  }
  return { az: best.az, el: best.el, snapshots, snrDb }
}
