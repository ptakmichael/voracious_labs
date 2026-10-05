/**
 * MOCK field model for the field viewer. Not a solver: an analytic picture of a probe-fed patch in its
 * TM010 cavity mode (E vertical under the patch, cos-shaped; H and surface current sin-shaped), plus
 * line-charge fringing at the radiating edges and a cos-shaped radiated power flow. Amplitudes follow the
 * same single-resonator model as the mock solver, so fields fade off resonance.
 */
import { BUILTIN_MATERIALS } from '../store'
import type { GeoObject, Project } from '../types'

export type V3 = [number, number, number]
export type FieldKind = 'E' | 'H' | 'S' | 'J'

export const FIELD_INFO: Record<FieldKind, { name: string; quantity: string; unit: string; phase: 'cos' | 'sin' | 'avg' }> = {
  E: { name: 'E-field', quantity: '|E|', unit: 'V/m', phase: 'cos' },
  H: { name: 'H-field', quantity: '|H|', unit: 'A/m', phase: 'sin' },
  S: { name: 'Poynting vector', quantity: '|S| (time-avg)', unit: 'W/m²', phase: 'avg' },
  J: { name: 'Surface current', quantity: '|Js|', unit: 'A/m', phase: 'sin' },
}

export interface PatchGeo {
  cx: number; cy: number; L: number; W: number
  h: number // substrate thickness (patch height above ground)
  z0: number // ground z
  gx: [number, number]; gy: [number, number] // ground extents
  fx: number; fy: number // feed, local coords
  epsR: number; tanD: number
}

const C0 = 299.792458 // mm·GHz
const isPec = (o: GeoObject) => o.material === 'pec' || o.material === 'copper'

export function patchGeo(p: Project): PatchGeo | null {
  const objs = p.objects.filter((o) => o.visible !== false)
  const sheets = objs.filter((o) => o.kind === 'sheet' && isPec(o))
  const ground = objs.find((o) => o.role === 'ground') ?? [...sheets].sort((a, b) => a.pos[2] - b.pos[2])[0]
  const patch = objs.find((o) => o.role === 'patch')
    ?? sheets.filter((o) => o !== ground).sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])[0]
  if (!ground || !patch || patch.pos[2] <= ground.pos[2]) return null
  const sub = objs.find((o) => o.role === 'substrate') ?? objs.filter((o) => o.kind === 'box' && !isPec(o))
    .sort((a, b) => b.size[0] * b.size[1] * b.size[2] - a.size[0] * a.size[1] * a.size[2])[0]
  const mat = sub ? [...BUILTIN_MATERIALS, ...p.materials].find((m) => m.name === sub.material) : undefined
  const port = objs.find((o) => o.kind === 'port')
  return {
    cx: patch.pos[0], cy: patch.pos[1], L: patch.size[0], W: patch.size[1],
    h: patch.pos[2] - ground.pos[2], z0: ground.pos[2],
    gx: [ground.pos[0] - ground.size[0] / 2, ground.pos[0] + ground.size[0] / 2],
    gy: [ground.pos[1] - ground.size[1] / 2, ground.pos[1] + ground.size[1] / 2],
    fx: port ? port.pos[0] - patch.pos[0] : -patch.size[0] / 6, fy: port ? port.pos[1] - patch.pos[1] : 0,
    epsR: mat?.eps_r ?? 1, tanD: mat?.tan_d ?? 0,
  }
}

/** Same numbers as backend physics.py: TL-model resonance with the mock probe shift. */
export function resonance(g: PatchGeo) {
  const ee = (g.epsR + 1) / 2 + ((g.epsR - 1) / 2) * (1 + (12 * g.h) / g.W) ** -0.5
  const dL = (0.412 * g.h * (ee + 0.3) * (g.W / g.h + 0.264)) / ((ee - 0.258) * (g.W / g.h + 0.8))
  const fr = (C0 / (2 * (g.L + 2 * dL) * Math.sqrt(ee))) * 0.986 * 0.997
  const lam0 = C0 / fr
  const q = Math.min(Math.max((0.27 * Math.sqrt(g.epsR) * lam0) / (4 * g.h) / (1 + 40 * g.tanD), 5), 45)
  return { fr, q }
}

/** Mode amplitude |1 / (1 + jQ(f/fr − fr/f))| (1 at resonance). */
export function modeAmp(g: PatchGeo, f: number) {
  const { fr, q } = resonance(g)
  const x = q * (f / fr - fr / f)
  return 1 / Math.sqrt(1 + x * x)
}

const clampMag = (v: V3, m: number): V3 => {
  const n = Math.hypot(...v)
  return n > m ? [(v[0] / n) * m, (v[1] / n) * m, (v[2] / n) * m] : v
}

// smooth window: 1 inside |t| < half, Gaussian roll-off outside
const win = (t: number, half: number, roll: number) => (Math.abs(t) <= half ? 1 : Math.exp(-(((Math.abs(t) - half) / roll) ** 2)))

/** E phasor (real, in phase with the drive). World coords in mm. */
export function E(g: PatchGeo, x: number, y: number, z: number): V3 | null {
  const X = x - g.cx, Y = y - g.cy, Z = z - g.z0
  if (Z < -1e-6) return null
  const { L, W, h } = g
  if (Math.abs(X) <= L / 2 && Math.abs(Y) <= W / 2 && Z <= h) return [0, 0, Math.cos((Math.PI * (X + L / 2)) / L)]
  // fringing: line charges at the radiating edges (−1 left, +1 right) with ground images
  let ex = 0, ez = 0
  for (const [xe, q] of [[-L / 2, -1], [L / 2, 1]] as const) {
    const d1x = X - xe, d1z = Z - h, d2z = Z + h
    const r1 = d1x * d1x + d1z * d1z + 0.02 * h * h
    const r2 = d1x * d1x + d2z * d2z
    ex += q * 0.55 * h * (d1x / r1 - d1x / r2)
    ez += q * 0.55 * h * (d1z / r1 - d2z / r2)
  }
  const wy = win(Y, W / 2, 1.5 * h)
  // non-radiating edges: weak Ey fringing that follows the cos mode
  const xIn = Math.max(-L / 2, Math.min(L / 2, X))
  const ny = Math.abs(Y) > W / 2 ? Math.sign(Y) * 0.5 * Math.cos((Math.PI * (xIn + L / 2)) / L) * Math.exp(-(Math.abs(Y) - W / 2) / h) * Math.exp(-Math.abs(Z - h) / h) * win(X, L / 2, 1.5 * h) : 0
  return clampMag([ex * wy, ny, ez * wy], 1.6)
}

/** H phasor (90° behind E). */
export function H(g: PatchGeo, x: number, y: number, z: number): V3 | null {
  const X = x - g.cx, Y = y - g.cy, Z = z - g.z0
  if (Z < -1e-6) return null
  const { L, W, h } = g
  const xIn = Math.max(-L / 2, Math.min(L / 2, X))
  const s = Math.sin((Math.PI * (xIn + L / 2)) / L) * win(X, L / 2, 2 * h)
  if (Math.abs(X) <= L / 2 && Math.abs(Y) <= W / 2 && Z <= h) return [0, s, 0]
  // H wraps around the patch current: −y above the patch, z-directed around the non-radiating edges
  const dy = Math.abs(Y) - W / 2
  const dz = Z - h
  const r = Math.hypot(Math.max(dy, 0), dz) + 0.25 * h
  const decay = Math.exp(-r / (2.2 * h))
  const ang = Math.atan2(dz, Math.max(dy, 1e-6))
  const hy = (Math.abs(Y) <= W / 2 ? -0.35 * Math.exp(-dz / (2 * h)) : -Math.sin(ang) * 0.7 * decay)
  const hz = Math.abs(Y) > W / 2 ? Math.sign(Y) * Math.cos(ang) * 0.7 * decay : 0
  return clampMag([0, hy * s, hz * s], 1.4)
}

/** Surface current phasor on the patch (top) or the ground plane. */
export function J(g: PatchGeo, x: number, y: number, surface: 'patch' | 'ground'): V3 | null {
  const X = x - g.cx, Y = y - g.cy
  const { L, W, h } = g
  if (surface === 'patch') {
    if (Math.abs(X) > L / 2 || Math.abs(Y) > W / 2) return null
    const edge = Math.min(1 / Math.sqrt(Math.max(1 - (2 * Y / W) ** 2, 0.04)), 3.5) / 1.6
    let jx = Math.sin((Math.PI * (X + L / 2)) / L) * edge
    let jy = 0
    const dx = X - g.fx, dy = Y - g.fy, r = Math.hypot(dx, dy) + 1e-6
    const feed = 0.9 * Math.exp(-r / (L / 7))
    jx += (dx / r) * feed
    jy += (dy / r) * feed
    return clampMag([jx, jy, 0], 1.6)
  }
  if (x < g.gx[0] || x > g.gx[1] || y < g.gy[0] || y > g.gy[1]) return null
  const xIn = Math.max(-L / 2, Math.min(L / 2, X))
  const sx = Math.sin((Math.PI * (xIn + L / 2)) / L) * win(X, L / 2, 3 * h)
  let jx = -0.85 * sx * win(Y, W / 2, 4 * h)
  let jy = 0
  const dx = X - g.fx, dy = Y - g.fy, r = Math.hypot(dx, dy) + 1e-6
  const feed = 0.8 * Math.exp(-r / (L / 7))
  jx -= (dx / r) * feed
  jy -= (dy / r) * feed
  return clampMag([jx, jy, 0], 1.6)
}

/** Time-averaged Poynting vector: power leaves the radiating edges and flows up in a broadside lobe. */
export function S(g: PatchGeo, x: number, y: number, z: number): V3 | null {
  const X = x - g.cx, Y = y - g.cy, Z = z - g.z0
  if (Z < -1e-6) return null
  const { L, W, h } = g
  if (Math.abs(X) <= L / 2 && Math.abs(Y) <= W / 2 && Z <= h) {
    // inside the cavity: net power flows from the feed toward the radiating edges
    const d = X - g.fx
    return [Math.sign(d) * 0.35 * Math.min(Math.abs(d) / (L / 4), 1), 0, 0]
  }
  const Rx = X, Ry = Y, Rz = Z - h
  const r = Math.hypot(Rx, Ry, Rz) + 1e-6
  const cosT = Rz / r
  const sinPhi = Math.abs(Ry) / (Math.hypot(Rx, Ry) + 1e-6)
  // broadside lobe, a little wider in the H-plane; weak grazing radiation near the ground
  const pat = (Math.max(cosT, 0) ** (1.3 + 0.5 * (1 - sinPhi)) + 0.06) * (Rz < 0 ? 0.25 : 1)
  const near = 1 / (1 + (r / (0.6 * Math.max(L, W))) ** 2)
  const m = pat * near * 1.1
  return [(Rx / r) * m, (Ry / r) * m, (Rz / r) * m]
}

/** Turbo colormap (Mikhailov 2019 polynomial approximation), t in [0,1] → rgb 0..255 */
export function turbo(t: number): [number, number, number] {
  t = Math.min(1, Math.max(0, t))
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))))
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))))
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))))
  return [Math.round(255 * Math.min(1, Math.max(0, r))), Math.round(255 * Math.min(1, Math.max(0, g))), Math.round(255 * Math.min(1, Math.max(0, b)))]
}

export const turboCss = () =>
  `linear-gradient(to right, ${Array.from({ length: 9 }, (_, i) => `rgb(${turbo(i / 8).join(',')})`).join(', ')})`
