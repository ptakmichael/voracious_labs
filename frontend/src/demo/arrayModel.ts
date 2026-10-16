/**
 * MOCK phased-array model for the array demo. A planar nx × ny grid of patch elements: array factor with a cos^q
 * element pattern over the upper hemisphere, amplitude tapers, quantised phase shifters or true-time delay,
 * failed elements, grating lobes, and a scan-dependent active match from a simple mutual-coupling term.
 * Cheap enough to re-evaluate on every slider move.
 */
import { type Design, GOAL, s11 } from './model'

export const C0 = 299.792458 // mm·GHz
export const lambda = (f: number) => C0 / f

export type Taper = 'uniform' | 'taylor' | 'cheb'
export interface ArrayDesign {
  nx: number
  ny: number
  dx: number // mm, centre to centre
  dy: number
  theta: number // steering, degrees from broadside
  phi: number // steering plane, degrees from +x
  taper: Taper
  sll: number // design sidelobe level for Taylor / Chebyshev, dB (positive number)
  bits: number // phase-shifter bits, 0 = ideal (continuous)
  ttd: boolean // true-time delay instead of phase shifters (no beam squint)
  failed: number[] // element indices (row-major) that are switched off
  f: number // frequency the pattern is evaluated at, GHz
}

export const F0 = 2.43 // GHz: the phase shifters are set for this frequency
const Q_ELEM = 0.3 // element pattern exponent (a patch on a high-εr board radiates broadly)
const EFFICIENCY = 0.55 // ohmic, dielectric and feed-network loss, folded together

/** The paper as written: Saad et al., arXiv 2508.20905, Table I and Fig. 2. */
export const PAPER_ARRAY: ArrayDesign = { nx: 4, ny: 4, dx: 50, dy: 50, theta: 0, phi: 0, taper: 'uniform', sll: 25, bits: 0, ttd: false, failed: [], f: F0 }
/** The unit cell: 25.8 × 18.2 mm patch on 1.27 mm Rogers 6010.2LM (εr 10.2), inset cut 8.1 mm. The T-slot is
 * folded into an equivalent length (see ARRAY_ISSUES). */
export const PAPER_ELEMENT: Design = { L: 19.4, W: 25.8, y0: 8.1, h: 1.27, er: 10.2, gs: 0.7 }
export const BOARD = { w: 250.5, h: 229.8 } // mm, Fig. 2

export const ARRAY_ISSUES = [
  { title: 'Simulated with a different feed, at 2.377 GHz', fix: 'Fig. 3 used a coax feed, and its −25 dB dip is at 2.377 GHz, not the 2.4 GHz in the text. Table I describes an inset feed; modelled the inset feed that would be built.' },
  { title: '18.2 mm patch resonates near 2.56 GHz', fix: 'On εr 10.2 the cavity equations put an 18.2 mm patch at about 2.56 GHz; the 2.4 GHz depends on the T-slot, which Table I doesn\'t dimension. Folded the slot into an equivalent length (≈19.4 mm).' },
  { title: '20 MHz bandwidth, not the ISM band', fix: 'Fig. 3 shows a 20 MHz bandwidth; the 2.400–2.4835 GHz band is 83.5 MHz. Set the goal to a 20 MHz channel, 2.42–2.44 GHz.' },
  { title: 'Only the isolated element is matched', fix: 'At 0.4λ spacing neighbours couple strongly, so the match changes as the beam steers. Added the active match over the ±42° scan to the goal.' },
]

// ---------------------------------------------------------------- tapers

function taylor(n: number, sllDb: number, nbar = 4) {
  if (n <= 2) return Array(n).fill(1)
  const R = 10 ** (sllDb / 20), A = Math.acosh(R) / Math.PI
  const s2 = nbar ** 2 / (A ** 2 + (nbar - 0.5) ** 2)
  const F = (m: number) => {
    let num = 1, den = 1
    for (let i = 1; i < nbar; i++) num *= 1 - (m * m) / (s2 * (A * A + (i - 0.5) ** 2))
    for (let i = 1; i < nbar; i++) if (i !== m) den *= 1 - (m * m) / (i * i)
    return ((m % 2 ? 1 : -1) * num) / (2 * den)
  }
  const w = Array.from({ length: n }, (_, k) => {
    const x = (k - (n - 1) / 2) / n
    let a = 1
    for (let m = 1; m < nbar; m++) a += 2 * F(m) * Math.cos(2 * Math.PI * m * x)
    return a
  })
  const mx = Math.max(...w)
  return w.map((v) => v / mx)
}

function chebyshev(n: number, sllDb: number) {
  if (n <= 2) return Array(n).fill(1)
  const R = 10 ** (sllDb / 20), x0 = Math.cosh(Math.acosh(R) / (n - 1))
  const T = (m: number, x: number) => (Math.abs(x) <= 1 ? Math.cos(m * Math.acos(x)) : Math.cosh(m * Math.acosh(Math.abs(x))) * (x < 0 && m % 2 ? -1 : 1))
  // sample the pattern at n points and invert the DFT
  const w = Array.from({ length: n }, (_, k) => {
    let a = 0
    for (let i = 0; i < n; i++) a += T(n - 1, x0 * Math.cos((Math.PI * i) / n)) * Math.cos((2 * Math.PI * i * (k - (n - 1) / 2)) / n)
    return a
  })
  const mx = Math.max(...w.map(Math.abs))
  return w.map((v) => Math.abs(v) / mx)
}

export function weights1d(n: number, t: Taper, sll: number) {
  return t === 'uniform' ? Array(n).fill(1) : t === 'taylor' ? taylor(n, sll) : chebyshev(n, sll)
}

// ---------------------------------------------------------------- excitation

export interface Element { i: number; ix: number; iy: number; x: number; y: number; amp: number; phase: number; on: boolean }

/** Every element's position (mm, centred), amplitude and phase-shifter setting (degrees, wrapped to 0–360). */
export function excitation(a: ArrayDesign): Element[] {
  const wx = weights1d(a.nx, a.taper, a.sll), wy = weights1d(a.ny, a.taper, a.sll)
  const th = (a.theta * Math.PI) / 180, ph = (a.phi * Math.PI) / 180
  const u0 = Math.sin(th) * Math.cos(ph), v0 = Math.sin(th) * Math.sin(ph)
  const k0 = (2 * Math.PI) / lambda(F0)
  const out: Element[] = []
  for (let iy = 0; iy < a.ny; iy++) for (let ix = 0; ix < a.nx; ix++) {
    const i = iy * a.nx + ix
    const x = (ix - (a.nx - 1) / 2) * a.dx, y = (iy - (a.ny - 1) / 2) * a.dy
    let p = -k0 * (x * u0 + y * v0)
    if (a.bits > 0) { const q = (2 * Math.PI) / 2 ** a.bits; p = Math.round(p / q) * q }
    const deg = (((p * 180) / Math.PI) % 360 + 360) % 360
    out.push({ i, ix, iy, x, y, amp: wx[ix] * wy[iy], phase: deg, on: !a.failed.includes(i) })
  }
  return out
}

/** Complex far field (array factor × element pattern) at direction (θ, φ) in radians. */
function field(a: ArrayDesign, els: Element[], th: number, ph: number) {
  if (th > Math.PI / 2) return 0
  const k = (2 * Math.PI) / lambda(a.f)
  const u = Math.sin(th) * Math.cos(ph), v = Math.sin(th) * Math.sin(ph)
  // true-time delay scales the steering phase with frequency; phase shifters keep the F0 setting (beam squint)
  const scale = a.f / F0
  let re = 0, im = 0
  for (const e of els) {
    if (!e.on) continue
    const ps = (e.phase * Math.PI) / 180
    const arg = k * (e.x * u + e.y * v) + (a.ttd ? scale * unwrap(e, a) : ps)
    re += e.amp * Math.cos(arg); im += e.amp * Math.sin(arg)
  }
  const ef = Math.cos(th) ** Q_ELEM
  return Math.hypot(re, im) * ef
}
/** Unwrapped steering phase for true-time delay. */
function unwrap(e: Element, a: ArrayDesign) {
  const th = (a.theta * Math.PI) / 180, ph = (a.phi * Math.PI) / 180
  return -((2 * Math.PI) / lambda(F0)) * (e.x * Math.sin(th) * Math.cos(ph) + e.y * Math.sin(th) * Math.sin(ph))
}

/** Normalised power pattern on a (θ, φ) grid over the upper hemisphere, for the 3D beam. */
export function patternGrid(a: ArrayDesign, dTh = 3, dPh = 6) {
  const els = excitation(a)
  const rows: number[][] = []
  let mx = 1e-12
  for (let t = 0; t <= 90; t += dTh) {
    const row: number[] = []
    for (let p = 0; p <= 360; p += dPh) { const v = field(a, els, (t * Math.PI) / 180, (p * Math.PI) / 180) ** 2; row.push(v); if (v > mx) mx = v }
    rows.push(row)
  }
  return { dTh, dPh, rows: rows.map((r) => r.map((v) => v / mx)) }
}

// ---------------------------------------------------------------- match

/** Active reflection coefficient of the element at f while the beam points at θ: the isolated element's
 * mismatch plus coupling from its neighbours, which grows with scan angle and shrinks with spacing. */
export function activeGamma(el: Design, a: ArrayDesign, f: number, thetaDeg: number) {
  const g0 = 10 ** (s11(f, el) / 20)
  const dl = Math.min(a.dx, a.dy) / lambda(F0)
  const c = 0.73 * Math.exp(-9 * (dl - 0.4))
  const s = Math.sin((Math.abs(thetaDeg) * Math.PI) / 180)
  return Math.min(0.999, Math.hypot(g0, c * s ** 1.5))
}
export const activeS11 = (el: Design, a: ArrayDesign, f: number, th: number) => 20 * Math.log10(activeGamma(el, a, f, th))

// ---------------------------------------------------------------- pattern metrics

export interface Beam {
  gain: number // realised, dBi
  dir: number // directivity, dBi
  point: number // where the beam actually points, degrees, in the steering plane
  hpbw: number // degrees
  sll: number // dB below the peak, in the steering plane
  grating: [number, number][] // (u, v) of grating lobes inside the visible region
  cut: { th: number; db: number }[] // realised gain, steering plane, −90…90°
}

const DTH = 2, DPH = 4

export function beam(el: Design, a: ArrayDesign): Beam {
  const els = excitation(a)
  const ph = (a.phi * Math.PI) / 180
  // directivity: integrate |F|² over the upper hemisphere
  let total = 0, peak = 0
  for (let t = DTH / 2; t < 90; t += DTH) {
    const th = (t * Math.PI) / 180, w = Math.sin(th)
    for (let p = 0; p < 360; p += DPH) { const f2 = field(a, els, th, (p * Math.PI) / 180) ** 2; total += f2 * w }
  }
  total *= ((DTH * Math.PI) / 180) * ((DPH * Math.PI) / 180)
  // steering-plane cut at 0.5° steps
  const cut: { th: number; f2: number }[] = []
  for (let t = -90; t <= 90; t += 0.5) {
    const th = (Math.abs(t) * Math.PI) / 180, pp = t < 0 ? ph + Math.PI : ph
    const f2 = field(a, els, th, pp) ** 2
    cut.push({ th: t, f2 }); if (f2 > peak) peak = f2
  }
  const D = (4 * Math.PI * peak) / (total || 1)
  const ipk = cut.reduce((b, c, i) => (c.f2 > cut[b].f2 ? i : b), 0)
  let lo = ipk, hi = ipk
  while (lo > 0 && cut[lo].f2 > peak / 2) lo--
  while (hi < cut.length - 1 && cut[hi].f2 > peak / 2) hi++
  // first nulls either side, then the biggest lobe beyond them
  let nl = ipk, nh = ipk
  while (nl > 0 && cut[nl - 1].f2 < cut[nl].f2) nl--
  while (nh < cut.length - 1 && cut[nh + 1].f2 < cut[nh].f2) nh++
  let side = 0
  cut.forEach((c, i) => { if ((i < nl || i > nh) && c.f2 > side) side = c.f2 })
  const g = activeGamma(el, a, a.f, a.theta)
  const gainLin = D * EFFICIENCY * (1 - g * g)
  // grating lobes: main beam position shifted by whole multiples of λ/d in u and v
  const th0 = (a.theta * Math.PI) / 180
  const u0 = Math.sin(th0) * Math.cos(ph), v0 = Math.sin(th0) * Math.sin(ph), L = lambda(a.f)
  const grating: [number, number][] = []
  for (let p = -3; p <= 3; p++) for (let q = -3; q <= 3; q++) {
    if (!p && !q) continue
    const u = u0 * (a.ttd ? 1 : F0 / a.f) + (p * L) / a.dx, v = v0 * (a.ttd ? 1 : F0 / a.f) + (q * L) / a.dy
    if (u * u + v * v < 1) grating.push([u, v])
  }
  const dbOf = (f2: number) => 10 * Math.log10(Math.max(1e-12, f2 / peak)) + 10 * Math.log10(gainLin)
  return {
    gain: 10 * Math.log10(gainLin), dir: 10 * Math.log10(D), point: cut[ipk].th, hpbw: (hi - lo) * 0.5,
    sll: side > 0 ? 10 * Math.log10(side / peak) : -60, grating,
    cut: cut.map((c) => ({ th: c.th, db: dbOf(c.f2) })),
  }
}

/** Largest scan angle (degrees) before a grating lobe enters visible space, along the worse axis. */
export function glFreeScan(a: ArrayDesign, f = a.f) {
  const r = lambda(f) / Math.max(a.dx, a.dy) - 1
  return r >= 1 ? 90 : r <= 0 ? 0 : (Math.asin(r) * 180) / Math.PI
}

// ---------------------------------------------------------------- the array's own goal

export const SCAN_MAX = 42
export const STEERS = [0, 11, 22, 32, 42]
export const ARRAY_GOAL = { active: -10, sll: -13 }
/** The paper's Fig. 5 numbers, for comparison. */
export const PAPER_BEAMS: Record<number, { gain: number; hpbw: number; sll: number }> = {
  11: { gain: 13, hpbw: 34.3, sll: -21 }, 22: { gain: 12.7, hpbw: 35.5, sll: -19 }, 32: { gain: 12, hpbw: 36.8, sll: -17.4 }, 42: { gain: 10.7, hpbw: 36.9, sll: -14.8 },
}

export interface ArrayMetrics {
  activeWorst: number // dB, worst active S11 over the channel and the scan range
  sllWorst: number // dB, worst sidelobe over the scan range
  gain0: number // dBi at broadside
  gainMax: number // dBi at the edge of the scan
  scanLoss: number // dB
  grating: boolean // any grating lobe within the scan range
  beams: Record<number, Beam>
}

export function arrayMetrics(el: Design, a: ArrayDesign): ArrayMetrics {
  const beams: Record<number, Beam> = {}
  for (const th of STEERS) beams[th] = beam(el, { ...a, theta: th, f: F0 })
  let activeWorst = -99
  for (const f of [GOAL.f1, (GOAL.f1 + GOAL.f2) / 2, GOAL.f2]) for (const th of STEERS) activeWorst = Math.max(activeWorst, activeS11(el, a, f, th))
  const sllWorst = Math.max(...STEERS.map((t) => beams[t].sll))
  return {
    activeWorst, sllWorst, gain0: beams[0].gain, gainMax: beams[SCAN_MAX].gain, scanLoss: beams[0].gain - beams[SCAN_MAX].gain,
    grating: STEERS.some((t) => beams[t].grating.length > 0), beams,
  }
}

export const arrayGoalMet = (m: ArrayMetrics) => m.activeWorst <= ARRAY_GOAL.active && m.sllWorst <= ARRAY_GOAL.sll && !m.grating
