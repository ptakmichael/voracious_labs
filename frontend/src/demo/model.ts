/**
 * MOCK physics for the demo: an inset-fed rectangular patch on a single-resonator model. Resonance comes from the
 * transmission-line design equations, input resistance from the inset depth (cos² law), bandwidth from substrate
 * height and permittivity, plus a small feed reactance. Cheap enough to evaluate on every slider move.
 */

const C0 = 299.792458 // mm·GHz

export interface Design {
  L: number // patch length (resonant), mm
  W: number // patch width, mm
  y0: number // inset depth, mm
  h: number // substrate height, mm
  er: number // substrate relative permittivity
  gs: number // ground-plane scale (1 = paper size)
}

/** The band the design has to cover. Mutable: the phased-array demo narrows it to a 20 MHz channel. */
export const GOAL = { f1: 2.4, f2: 2.48, db: -10, label: 'Wi-Fi / BLE' }
export function setGoal(f1: number, f2: number, label: string) { GOAL.f1 = f1; GOAL.f2 = f2; GOAL.label = label }
export const F_RANGE: [number, number] = [2.1, 2.8]
export const FEED_W = 2.9 // 50 Ω line on 1.5 mm FR-4

/** Straight from Table 1, read literally (εr = 4.08, which is really the effective permittivity). */
export const PAPER_AS_WRITTEN: Design = { L: 30.58, W: 39.19, y0: 6, h: 1.5, er: 4.08, gs: 1 }
/** What actually gets built: real FR-4. */
export const PAPER_FIXED: Design = { ...PAPER_AS_WRITTEN, er: 4.4 }
export const SUBSTRATE = { len: 47.04, wid: 48.19, feedGap: 5.2 } // width from eq. (6): W + 6h

export function resonance(d: Design) {
  const ee = (d.er + 1) / 2 + ((d.er - 1) / 2) * (1 + (12 * d.h) / d.W) ** -0.5
  const dL = (0.412 * d.h * (ee + 0.3) * (d.W / d.h + 0.264)) / ((ee - 0.258) * (d.W / d.h + 0.8))
  return (C0 / (2 * (d.L + 2 * dL) * Math.sqrt(ee))) * (1 - 0.004 * (1 - d.gs))
}
export const edgeR = (d: Design) => 195 * (39.19 / d.W)
export const inputR = (d: Design) => edgeR(d) * Math.cos((Math.PI * d.y0) / d.L) ** 2
export const quality = (d: Design) => 15 * (1.5 / d.h) * Math.sqrt(d.er / 4.4)
const L_FEED = 0.35e-9

/** Input impedance: a parallel resonator seen through the inset, plus the feed's series inductance. */
export function zin(f: number, d: Design) {
  const fr = resonance(d)
  const R = inputR(d)
  const x = quality(d) * (f / fr - fr / f)
  const den = 1 + x * x
  return { r: R / den, x: (-R * x) / den + 2 * Math.PI * f * 1e9 * L_FEED }
}

export function s11(f: number, d: Design) {
  const z = zin(f, d)
  return 20 * Math.log10(Math.hypot(z.r - 50, z.x) / Math.hypot(z.r + 50, z.x))
}

/** How strongly the patch mode is excited at f (1 on resonance, falling off either side). */
export function excitation(f: number, d: Design) {
  const fr = resonance(d)
  const x = quality(d) * (f / fr - fr / f)
  return 1 / Math.sqrt(1 + x * x)
}

/** Change in S11 at one frequency (dB) for a +2% change in each variable, in VARS order. */
export function sensAt(f: number, d: Design) {
  const base = s11(f, d)
  return VARS.map((v) => s11(f, { ...d, [v.key]: (d[v.key] as number) * 1.02 }) - base)
}

export const FREQS = Array.from({ length: 281 }, (_, i) => F_RANGE[0] + ((F_RANGE[1] - F_RANGE[0]) * i) / 280)
export const curve = (d: Design) => FREQS.map((f) => s11(f, d))

export function worstInBand(d: Design, step = 0.002) {
  let w = -99
  for (let f = GOAL.f1; f <= GOAL.f2 + 1e-9; f += step) w = Math.max(w, s11(f, d))
  return w
}

export function gain(d: Design) {
  return 3.7 + 0.55 * (d.h - 1.5) - 0.45 * (d.er - 4.4) + 0.025 * (d.W - 39.19) + 1.1 * (d.gs - 1) - 0.002 * (d.L - 30.58) ** 2
}

export interface Metrics { f0: number; min: number; lo: number; hi: number; bw: number; worst: number; R: number; gain: number }

export function metrics(d: Design): Metrics {
  let min = 0, f0 = resonance(d)
  for (let f = F_RANGE[0]; f <= F_RANGE[1]; f += 0.0005) { const s = s11(f, d); if (s < min) { min = s; f0 = f } }
  let lo = NaN, hi = NaN
  if (min < GOAL.db) {
    lo = f0; while (lo > F_RANGE[0] && s11(lo, d) < GOAL.db) lo -= 0.0005
    hi = f0; while (hi < F_RANGE[1] && s11(hi, d) < GOAL.db) hi += 0.0005
  }
  return { f0, min, lo, hi, bw: Number.isNaN(lo) ? 0 : (hi - lo) * 1000, worst: worstInBand(d), R: inputR(d), gain: gain(d) }
}

export const goalMet = (m: Metrics) => m.worst <= GOAL.db

/** Where the tuner is heading: the length that centres the band and the inset depth that gives ~52 Ω. */
export function target(d: Design): Design {
  const fc = 2.43
  let a = 15, b = 60
  for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (resonance({ ...d, L: m }) > fc) a = m; else b = m }
  const L = (a + b) / 2
  const c = Math.sqrt(52 / edgeR({ ...d, L }))
  const y0 = (Math.acos(Math.min(1, c)) * L) / Math.PI
  return { ...d, L, y0 }
}

/** One tuning run: move length and inset most of the way toward the target, like a damped Newton step. */
export function tuneStep(d: Design, k: number): Design {
  const t = target(d)
  const r = (v: number) => Math.round(v * 100) / 100
  const near = Math.abs(t.L - d.L) < 0.15 && Math.abs(t.y0 - d.y0) < 0.2
  const a = near ? 1 : k
  return { ...d, L: r(d.L + (t.L - d.L) * a), y0: r(d.y0 + (t.y0 - d.y0) * a) }
}

/** Design from the equations alone, for a text-only prompt. A touch long, so tuning has something to do. */
export function fromEquations(f = 2.44, er = 4.4, h = 1.6): Design {
  const W = (C0 / (2 * f)) * Math.sqrt(2 / (er + 1))
  const t = target({ L: 30, W, y0: 8, h, er, gs: 1 })
  return { ...t, L: Math.round(t.L * 1.018 * 100) / 100, y0: Math.round((t.y0 - 1.2) * 100) / 100, W: Math.round(W * 100) / 100 }
}

export const lerp = (a: number, b: number, k: number) => a + (b - a) * k

// ---------- effect map ----------
export interface Var { key: keyof Design; name: string; unit: string; min: number; max: number; step: number; fmt: (v: number) => string }
export const VARS: Var[] = [
  { key: 'L', name: 'Patch length', unit: 'mm', min: 26, max: 33, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'W', name: 'Patch width', unit: 'mm', min: 30, max: 46, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'y0', name: 'Inset depth', unit: 'mm', min: 3, max: 13, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'h', name: 'Substrate height', unit: 'mm', min: 0.8, max: 3.2, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'er', name: 'Substrate εr', unit: '', min: 2.2, max: 6.15, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'gs', name: 'Ground size', unit: '×', min: 0.7, max: 1.6, step: 0.01, fmt: (v) => v.toFixed(2) },
]
export interface MetricDef { key: keyof Metrics; name: string; unit: string; fmt: (v: number) => string }
export const METRICS: MetricDef[] = [
  { key: 'f0', name: 'Resonance', unit: 'MHz', fmt: (v) => (v * 1000).toFixed(0) },
  { key: 'bw', name: 'Bandwidth', unit: 'MHz', fmt: (v) => v.toFixed(0) },
  { key: 'worst', name: 'Worst in-band match', unit: 'dB', fmt: (v) => v.toFixed(1) },
  { key: 'R', name: 'Input resistance', unit: 'Ω', fmt: (v) => v.toFixed(1) },
  { key: 'gain', name: 'Gain', unit: 'dBi', fmt: (v) => v.toFixed(2) },
]
const mScale = (k: keyof Metrics) => (k === 'f0' ? 1000 : 1)

/** Change in each metric for a +5% change in each variable, at the current design. */
export function effectMatrix(d: Design) {
  const base = metrics(d)
  return VARS.map((v) => {
    const up = metrics({ ...d, [v.key]: (d[v.key] as number) * 1.05 })
    const dn = metrics({ ...d, [v.key]: (d[v.key] as number) * 0.95 })
    return METRICS.map((m) => {
      const s = mScale(m.key)
      const a = ((up[m.key] as number) - (base[m.key] as number)) * s
      const b = ((dn[m.key] as number) - (base[m.key] as number)) * s
      return { up: a, size: Math.max(Math.abs(a), Math.abs(b)) }
    })
  })
}

/** One metric swept over one variable (±15%), for the drill-down chart. */
export function sweep(d: Design, v: Var, m: MetricDef, n = 41) {
  const c = d[v.key] as number
  const xs = Array.from({ length: n }, (_, i) => c * (0.85 + (0.3 * i) / (n - 1)))
  return { xs, ys: xs.map((x) => (metrics({ ...d, [v.key]: x })[m.key] as number) * mScale(m.key)) }
}
