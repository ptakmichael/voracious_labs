import { type Node, ExprError, check, evaluate, names, parse } from './expr'
import { type Design, GOAL, METRICS, VARS, metrics, s11, zin } from './model'

/**
 * One list of parameters and one list of metrics, built-in and custom alike, so every view (geometry, bars,
 * matrix, drill-down) asks the same question: "grow this parameter 5%, how much does that metric move?"
 */

export type BaseKey = keyof Design
export const BASE_KEYS = VARS.map((v) => v.key)
export const STEP = 0.05

export interface Param {
  id: string
  name: string
  unit: string
  custom?: { src: string; hold: BaseKey[]; free: BaseKey[] }
  value: (d: Design) => number
  /** The design with this parameter scaled by `k`, moving only what it is allowed to move. */
  apply: (d: Design, k: number) => Design
  fmt: (v: number) => string
}

export interface Metric {
  id: string
  name: string
  unit: string
  custom?: { src: string }
  value: (d: Design) => number
  fmt: (v: number) => string
}

const nice = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3))

export const BASE_PARAMS: Param[] = VARS.map((v) => ({
  id: v.key, name: v.name, unit: v.unit, fmt: v.fmt,
  value: (d) => d[v.key] as number,
  apply: (d, k) => ({ ...d, [v.key]: (d[v.key] as number) * k }),
}))

/** metrics() is the expensive call; every view asks for the same handful of designs, so remember recent ones. */
const memo = new Map<string, ReturnType<typeof metrics>>()
export function metricsOf(d: Design) {
  const k = `${d.L},${d.W},${d.y0},${d.h},${d.er},${d.gs}`
  let m = memo.get(k)
  if (!m) { m = metrics(d); memo.set(k, m); if (memo.size > 600) memo.delete(memo.keys().next().value!) }
  return m
}

const scaleOf = (k: string) => (k === 'f0' ? 1000 : 1)
export const BASE_METRICS: Metric[] = METRICS.map((m) => ({
  id: m.key, name: m.name, unit: m.unit, fmt: (v) => m.fmt(v / scaleOf(m.key)),
  value: (d) => (metricsOf(d)[m.key] as number) * scaleOf(m.key),
}))

/** S11 at one frequency: the metric the frequency slider drives. */
export function s11At(f: number): Metric {
  return { id: 's11f', name: `S11 at ${f.toFixed(2)} GHz`, unit: 'dB', fmt: (v) => v.toFixed(1), value: (d) => s11(f, d) }
}

// ---------------------------------------------------------------- custom metrics

export const CURVES: Record<string, (d: Design) => (f: number) => number> = {
  S11_dB: (d) => (f) => s11(f, d),
  Zin_re: (d) => (f) => zin(f, d).r,
  Zin_im: (d) => (f) => zin(f, d).x,
  VSWR: (d) => (f) => { const g = 10 ** (s11(f, d) / 20); return (1 + g) / (1 - g) },
}
export const METRIC_SCALARS: Record<string, (d: Design, m: ReturnType<typeof metrics>) => number> = {
  f0: (_, m) => m.f0, bw: (_, m) => m.bw, worst: (_, m) => m.worst, R: (_, m) => m.R, gain: (_, m) => m.gain,
  L: (d) => d.L, W: (d) => d.W, y0: (d) => d.y0, h: (d) => d.h, er: (d) => d.er, gs: (d) => d.gs,
}

export function makeMetric(name: string, unit: string, src: string): Metric {
  const tree = parse(src)
  check(tree, Object.keys(METRIC_SCALARS), Object.keys(CURVES))
  const needsMetrics = [...names(tree)].some((n) => ['f0', 'bw', 'worst', 'R', 'gain'].includes(n))
  const value = (d: Design) => {
    const m = needsMetrics ? metricsOf(d) : (null as unknown as ReturnType<typeof metrics>)
    const scalars = Object.fromEntries(Object.entries(METRIC_SCALARS).map(([k, fn]) => [k, needsMetrics || !['f0', 'bw', 'worst', 'R', 'gain'].includes(k) ? fn(d, m) : NaN]))
    const curves = Object.fromEntries(Object.entries(CURVES).map(([k, fn]) => [k, fn(d)]))
    return evaluate(tree, { scalars, curves })
  }
  return { id: `m:${name}`, name, unit, custom: { src }, value, fmt: nice }
}

export const METRIC_EXAMPLES = [
  { name: 'Goal margin', unit: 'dB', src: `${GOAL.db} - max(S11_dB, ${GOAL.f1.toFixed(2)}, ${GOAL.f2.toFixed(2)})` },
  { name: 'Patch area', unit: 'mm²', src: 'W * L' },
  { name: 'Reactance at 2.44', unit: 'Ω', src: 'at(Zin_im, 2.44)' },
  { name: 'Worst VSWR in band', unit: '', src: `max(VSWR, ${GOAL.f1.toFixed(2)}, ${GOAL.f2.toFixed(2)})` },
]

// ---------------------------------------------------------------- custom parameters

/**
 * A parameter defined by an expression of the base ones. Scaling it moves only the base parameters it uses and
 * that aren't held, by the smallest move in relative terms (a few Newton steps).
 */
export function makeParam(name: string, unit: string, src: string, hold: BaseKey[]): Param {
  const tree: Node = parse(src)
  check(tree, BASE_KEYS as string[], [])
  const used = BASE_KEYS.filter((k) => names(tree).has(k))
  if (!used.length) throw new ExprError('Use at least one of L, W, y0, h, er, gs', 0)
  const free = used.filter((k) => !hold.includes(k))
  if (!free.length) throw new ExprError(`Everything it uses is held constant, so nothing can move. Un-hold one of ${used.join(', ')}.`, 0)
  const q = (d: Design) => evaluate(tree, { scalars: d as unknown as Record<string, number> })
  const apply = (d: Design, k: number) => {
    const goal = q(d) * k
    let x = { ...d }
    for (let it = 0; it < 6; it++) {
      const r = goal - q(x)
      if (Math.abs(r) < 1e-9 * Math.max(1, Math.abs(goal))) break
      const g = free.map((key) => { const h = 1e-4; const up = { ...x, [key]: (x[key] as number) * (1 + h) }; return (q(up) - q(x)) / h })
      const n2 = g.reduce((a, b) => a + b * b, 0)
      if (!n2) break
      const nx = { ...x }
      free.forEach((key, i) => { (nx[key] as number) = (x[key] as number) * (1 + (g[i] * r) / n2) })
      x = nx
    }
    return x
  }
  return { id: `p:${name}`, name, unit, custom: { src, hold, free }, value: q, apply, fmt: nice }
}

export const PARAM_EXAMPLES = [
  { name: 'Inset ratio', unit: '', src: 'y0 / L', hold: ['W', 'h', 'er', 'gs', 'L'] as BaseKey[] },
  { name: 'Aspect ratio', unit: '', src: 'W / L', hold: ['y0', 'h', 'er', 'gs', 'L'] as BaseKey[] },
  { name: 'Electrical length', unit: 'mm', src: 'L * sqrt(er)', hold: ['W', 'y0', 'h', 'gs', 'er'] as BaseKey[] },
]

// ---------------------------------------------------------------- effects

/** Change in metric for +5% of the parameter. */
export function effect(d: Design, p: Param, m: Metric, base = m.value(d)) {
  return m.value(p.apply(d, 1 + STEP)) - base
}

export function effectRow(d: Design, m: Metric, params: Param[]) {
  const base = m.value(d)
  return params.map((p) => effect(d, p, m, base))
}

/** One metric swept over one parameter (±15%), for the drill-down chart. */
export function sweepParam(d: Design, p: Param, m: Metric, n = 41) {
  const ks = Array.from({ length: n }, (_, i) => 0.85 + (0.3 * i) / (n - 1))
  const ds = ks.map((k) => p.apply(d, k))
  return { xs: ds.map((x) => p.value(x)), ys: ds.map((x) => m.value(x)) }
}

export function fmtSigned(v: number) {
  const a = Math.abs(v)
  if (a < 0.005) return '0'
  return `${v > 0 ? '+' : '−'}${a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a >= 1 ? a.toFixed(1) : a.toFixed(2)}`
}
