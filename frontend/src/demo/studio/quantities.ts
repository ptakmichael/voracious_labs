/**
 * Solution data: every quantity a report can plot, for any design. A quantity is evaluated on a solution (a solved
 * snapshot of the design) over one sweep variable, with optional fixed parameters (φ cut, steer angle, frequency).
 * Names follow HFSS where there is an equivalent.
 */
import { type ArrayDesign, F0, activeGamma, beam } from '../arrayModel'
import { type Design, quality, zin } from '../model'
import { directivity, patternPow, qc, radEff, tanD } from '../paperPhysics'

export type Kind = 'patch' | 'array'
export type XVar = 'Freq' | 'Theta' | 'ScanAng'
export type Fn = 'dB' | 'mag' | 're' | 'im' | 'ang' | 'dB10' | ''
export interface Params { phi?: number; steer?: number; freq?: number }

export interface Solution { id: number; name: string; kind: Kind; d: Design; a?: ArrayDesign; sweep: [number, number, number] }

export interface Quantity {
  name: string
  cat: string
  unit: string // unit of the raw value ('' when the function sets it)
  xs: XVar[] // sweep variables it can be plotted against
  fns: Fn[] // first is the default
  params: (keyof Params)[]
  kinds: Kind[]
  complex?: boolean
  /** Raw values at each x: [re, im] for complex quantities, a number otherwise. */
  at: (s: Solution, x: XVar, xv: number[], p: Required<Params>) => (number | [number, number])[]
}

export const X_LABEL: Record<XVar, string> = { Freq: 'Freq (GHz)', Theta: 'Theta (deg)', ScanAng: 'Scan angle (deg)' }

const D2R = Math.PI / 180
const P_STIM = 0.5 // W incident, as in HFSS's default 1 W peak / 0.5 W rms port drive
const db10 = (v: number) => 10 * Math.log10(Math.max(v, 1e-12))
const gammaC = (f: number, d: Design): [number, number] => {
  const z = zin(f, d), dr = z.r + 50, n = dr * dr + z.x * z.x
  return [((z.r - 50) * dr + z.x * z.x) / n, (z.x * dr - (z.r - 50) * z.x) / n]
}
const g2 = (f: number, d: Design) => { const [r, i] = gammaC(f, d); return r * r + i * i }
const arr = (s: Solution, p: Required<Params>, f = p.freq): ArrayDesign => ({ ...s.a!, theta: p.steer, f })

/** Realised (or IEEE) gain along a θ cut, −180…180°. Patch: φ cut of the cavity model. Array: steering-plane cut. */
function gainCut(s: Solution, th: number[], p: Required<Params>, realised: boolean): number[] {
  if (s.kind === 'array') {
    const b = beam(s.d, arr(s, p))
    const back = Math.max(...b.cut.map((c) => c.db)) - 24 // ground plane: front-to-back about 24 dB
    return th.map((t) => {
      if (Math.abs(t) > 90) return back - (180 - Math.abs(t)) / 9
      const i = Math.round((t + 90) * 2)
      return b.cut[Math.max(0, Math.min(b.cut.length - 1, i))].db
    })
  }
  const f = p.freq, g = directivity(s.d, f) * radEff(s.d, f) * (realised ? 1 - g2(f, s.d) : 1)
  return th.map((t) => db10(g * patternPow(s.d, f, Math.abs(t) * D2R, (p.phi + (t < 0 ? 180 : 0)) * D2R)))
}

export const QUANTITIES: Quantity[] = [
  { name: 'S(1,1)', cat: 'S Parameter', unit: '', xs: ['Freq'], fns: ['dB', 'mag', 're', 'im', 'ang'], params: [], kinds: ['patch', 'array'], complex: true,
    at: (s, _x, xv) => xv.map((f) => gammaC(f, s.d)) },
  { name: 'Z(1,1)', cat: 'Z Parameter', unit: 'Ω', xs: ['Freq'], fns: ['re', 'im', 'mag'], params: [], kinds: ['patch', 'array'], complex: true,
    at: (s, _x, xv) => xv.map((f) => { const z = zin(f, s.d); return [z.r, z.x] }) },
  { name: 'VSWR(1)', cat: 'VSWR', unit: '', xs: ['Freq'], fns: [''], params: [], kinds: ['patch', 'array'],
    at: (s, _x, xv) => xv.map((f) => { const g = Math.sqrt(g2(f, s.d)); return Math.min(40, (1 + g) / (1 - g)) }) },
  { name: 'ActiveS(1,1)', cat: 'Active S Parameter', unit: '', xs: ['Freq', 'ScanAng'], fns: ['dB', 'mag'], params: ['steer', 'freq'], kinds: ['array'],
    at: (s, x, xv, p) => xv.map((v) => (x === 'Freq' ? activeGamma(s.d, s.a!, v, p.steer) : activeGamma(s.d, s.a!, p.freq, v))) },
  { name: 'GainTotal', cat: 'Far Fields', unit: 'dBi', xs: ['Theta'], fns: [''], params: ['phi', 'freq'], kinds: ['patch'],
    at: (s, _x, xv, p) => gainCut(s, xv, p, false) },
  { name: 'RealizedGainTotal', cat: 'Far Fields', unit: 'dBi', xs: ['Theta'], fns: [''], params: ['phi', 'steer', 'freq'], kinds: ['patch', 'array'],
    at: (s, _x, xv, p) => gainCut(s, xv, p, true) },
  { name: 'PeakGain', cat: 'Antenna Params', unit: 'dBi', xs: ['Freq'], fns: [''], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => db10(directivity(s.d, f) * radEff(s.d, f))) },
  { name: 'PeakRealizedGain', cat: 'Antenna Params', unit: 'dBi', xs: ['Freq', 'ScanAng'], fns: [''], params: ['steer', 'freq'], kinds: ['patch', 'array'],
    at: (s, x, xv, p) => s.kind === 'array'
      ? xv.map((v) => beam(s.d, x === 'Freq' ? arr(s, p, v) : { ...arr(s, p), theta: v }).gain)
      : xv.map((f) => db10(directivity(s.d, f) * radEff(s.d, f) * (1 - g2(f, s.d)))) },
  { name: 'PeakDirectivity', cat: 'Antenna Params', unit: 'dBi', xs: ['Freq', 'ScanAng'], fns: [''], params: ['steer', 'freq'], kinds: ['patch', 'array'],
    at: (s, x, xv, p) => s.kind === 'array'
      ? xv.map((v) => beam(s.d, x === 'Freq' ? arr(s, p, v) : { ...arr(s, p), theta: v }).dir)
      : xv.map((f) => db10(directivity(s.d, f))) },
  { name: 'RadiationEfficiency', cat: 'Antenna Params', unit: '', xs: ['Freq'], fns: ['', 'dB10'], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => radEff(s.d, f)) },
  { name: 'TotalEfficiency', cat: 'Antenna Params', unit: '', xs: ['Freq'], fns: ['', 'dB10'], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => radEff(s.d, f) * (1 - g2(f, s.d))) },
  { name: 'AcceptedPower', cat: 'Power', unit: 'W', xs: ['Freq'], fns: [''], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => P_STIM * (1 - g2(f, s.d))) },
  { name: 'ReflectedPower', cat: 'Power', unit: 'W', xs: ['Freq'], fns: [''], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => P_STIM * g2(f, s.d)) },
  { name: 'RadiatedPower', cat: 'Power', unit: 'W', xs: ['Freq'], fns: [''], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => P_STIM * (1 - g2(f, s.d)) * radEff(s.d, f)) },
  { name: 'DielectricLoss', cat: 'Power', unit: 'W', xs: ['Freq'], fns: [''], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => P_STIM * (1 - g2(f, s.d)) * tanD(s.d) * quality(s.d)) },
  { name: 'ConductorLoss', cat: 'Power', unit: 'W', xs: ['Freq'], fns: [''], params: [], kinds: ['patch'],
    at: (s, _x, xv) => xv.map((f) => (P_STIM * (1 - g2(f, s.d)) * quality(s.d)) / qc(s.d, f)) },
  { name: 'BeamPointing', cat: 'Array', unit: 'deg', xs: ['Freq'], fns: [''], params: ['steer'], kinds: ['array'],
    at: (s, _x, xv, p) => xv.map((f) => beam(s.d, arr(s, p, f)).point) },
  { name: 'SideLobeLevel', cat: 'Array', unit: 'dB', xs: ['ScanAng'], fns: [''], params: ['freq'], kinds: ['array'],
    at: (s, _x, xv, p) => xv.map((t) => beam(s.d, { ...arr(s, p), theta: t }).sll) },
]

export const quantity = (name: string) => QUANTITIES.find((q) => q.name === name)
export const available = (k: Kind) => QUANTITIES.filter((q) => q.kinds.includes(k))

/** One plotted curve: a quantity, a function of it, a solution and fixed parameters. Or imported data. */
export interface Trace {
  id: string
  q: string
  fn: Fn
  x: XVar
  sol: number // solution id; −1 = latest
  params: Params
  color: string
  dash?: string
  hidden?: boolean
  imported?: { label: string; data: [number, number][] }
}

const FN_UNIT: Partial<Record<Fn, string>> = { dB: 'dB', dB10: 'dB', ang: 'deg' }
export const traceLabel = (t: Trace) => {
  if (t.imported) return t.imported.label
  const q = quantity(t.q)
  const core = t.fn ? `${t.fn}(${t.q})` : t.q
  const ps = (q?.params ?? []).filter((k) => t.params[k] !== undefined && !(k === 'freq' && t.x === 'Freq') && !(k === 'steer' && t.x === 'ScanAng'))
    .map((k) => `${k}=${t.params[k]}${k === 'freq' ? 'GHz' : 'deg'}`)
  return ps.length ? `${core} [${ps.join(', ')}]` : core
}
export const traceUnit = (t: Trace) => (t.imported ? '' : FN_UNIT[t.fn] ?? (t.fn === 're' || t.fn === 'im' || t.fn === 'mag' ? quantity(t.q)?.unit ?? '' : quantity(t.q)?.unit ?? ''))

export function xValues(x: XVar, s: Solution): number[] {
  if (x === 'Freq') { const [a, b, n] = s.sweep; return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1)) }
  if (x === 'Theta') return Array.from({ length: 361 }, (_, i) => i - 180)
  return Array.from({ length: 31 }, (_, i) => i * 2)
}

export function defaults(s: Solution, p: Params): Required<Params> {
  return { phi: p.phi ?? 90, steer: p.steer ?? s.a?.theta ?? 0, freq: p.freq ?? (s.kind === 'array' ? F0 : (s.sweep[0] + s.sweep[1]) / 2) }
}

/** Evaluate a trace on a solution. Returns null when the quantity doesn't exist for that design. */
export function evaluate(t: Trace, s: Solution | undefined): { x: number[]; y: number[] } | null {
  if (t.imported) return { x: t.imported.data.map((d) => d[0]), y: t.imported.data.map((d) => d[1]) }
  const q = quantity(t.q)
  if (!q || !s || !q.kinds.includes(s.kind) || !q.xs.includes(t.x)) return null
  const xs = xValues(t.x, s)
  const raw = q.at(s, t.x, xs, defaults(s, t.params))
  const y = raw.map((v) => {
    if (typeof v === 'number') return t.fn === 'dB10' ? db10(v) : t.fn === 'dB' ? 20 * Math.log10(Math.max(v, 1e-9)) : v
    const [r, i] = v
    switch (t.fn) {
      case 'dB': return 20 * Math.log10(Math.max(Math.hypot(r, i), 1e-9))
      case 'mag': return Math.hypot(r, i)
      case 're': return r
      case 'im': return i
      case 'ang': return (Math.atan2(i, r) * 180) / Math.PI
      default: return Math.hypot(r, i)
    }
  })
  return { x: xs, y }
}

/** Complex samples for a Smith chart (S(1,1) only). */
export function gammaSamples(s: Solution): { re: number[]; im: number[]; f: number[] } {
  const f = xValues('Freq', s), g = f.map((v) => gammaC(v, s.d))
  return { re: g.map((v) => v[0]), im: g.map((v) => v[1]), f }
}

/** Parse "dB(S(1,1))", "RealizedGainTotal", "mag(Z(1,1))" into quantity + function. */
export function parseExpr(src: string): { q: string; fn: Fn } | null {
  const s = src.replace(/\s+/g, '')
  const m = /^(dB10|dB|mag|re|im|ang)\((.+)\)$/i.exec(s)
  const fn = (m ? (['dB10', 'dB', 'mag', 're', 'im', 'ang'].find((f) => f.toLowerCase() === m[1].toLowerCase()) as Fn) : '') as Fn
  const name = (m ? m[2] : s).toLowerCase().replace(/^s11$/, 's(1,1)').replace(/^z11$/, 'z(1,1)').replace(/^vswr$/, 'vswr(1)').replace(/^actives11$/, 'actives(1,1)')
  const q = QUANTITIES.find((x) => x.name.toLowerCase() === name)
  if (!q) return null
  return { q: q.name, fn: m ? fn : q.fns[0] }
}
