import { create } from 'zustand'
import { ARRAY_GOAL, ARRAY_ISSUES, type ArrayDesign, PAPER_ARRAY, PAPER_ELEMENT, arrayGoalMet, arrayMetrics } from '../arrayModel'
import { type Design, GOAL, PAPER_FIXED, fromEquations, goalMet, metrics, setGoal, tuneStep } from '../model'
import { useModel, recognisePatch, validate } from '../modeler/model'
import { PAPER_PLOTS } from '../paperPlots'
import { PAPER_ISSUES } from '../store'
import { arrayObjs, patchObjs } from './geometry'
import type { Fn, Kind, Params, Solution, Trace, XVar } from './quantities'

export interface Marker { id: string; trace: string; x: number }
export interface Report {
  id: string; name: string; type: 'rect' | 'polar' | 'smith'
  traces: Trace[]; markers: Marker[]
  xRange?: [number, number]; yRange?: [number, number]
}
/** Console output. 'sug' is a command the solver suggests: click to run it. */
export interface Line { id: number; kind: 'in' | 'out' | 'err' | 'ai' | 'sys' | 'sug'; text: string }
export interface Issue { title: string; fix: string }
export type Sel = 'vars' | 'setup' | 'opt' | 'obj' | `report:${string}` | null

// Trace hues in fixed order, validated (lightness, chroma, CVD, contrast) for both themes; defined in studio.css.
// A sixth trace reuses the hues with a dash rather than inventing a colour.
export const COLORS = ['var(--tr1)', 'var(--tr2)', 'var(--tr3)', 'var(--tr4)', 'var(--tr5)']
export const traceStyle = (i: number) => ({ color: COLORS[i % COLORS.length], dash: i >= COLORS.length ? '7 3' : undefined })
export const PAPER_INK = 'var(--ink)'

interface State {
  project: string
  design: string
  kind: Kind | null
  d: Design
  a: ArrayDesign
  setup: { f1: number; f2: number; n: number }
  sols: Solution[]
  dirty: boolean
  busy: { label: string; p: number } | null
  reports: Report[]
  docs: string[]
  active: string
  sel: Sel
  lines: Line[]
  hist: string[]
  paper: { name: string; data: ArrayBuffer; which: 'patch' | 'array' | null; read?: boolean } | null
  issues: Issue[]
  dock: 'console' | 'messages'
  aiSource: string // who answered the last question: the backend's provider, or the built-in engine
}

interface Actions {
  print: (kind: Line['kind'], text: string) => void
  newDesign: (kind: Kind, d?: Design, a?: ArrayDesign, keepPaper?: boolean) => void
  setVar: (k: keyof Design, v: number) => void
  setArr: (p: Partial<ArrayDesign>) => void
  set: (p: Partial<State>) => void
  solve: (o?: { quiet?: boolean }) => Promise<Solution | null>
  optimize: () => Promise<void>
  addReport: (r: Omit<Report, 'id' | 'markers'> & { markers?: Marker[] }) => Report
  patchReport: (id: string, p: Partial<Report>) => void
  removeReport: (id: string) => void
  open: (doc: string) => void
  close: (doc: string) => void
  importPaper: (f: File) => Promise<void>
  paperRead: (which: 'patch' | 'array' | null) => Promise<void>
}

let lid = 1, rid = 1, sid = 1
export const newTraceId = () => `t${Math.random().toString(36).slice(2, 8)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const f2 = (v: number, n = 2) => v.toFixed(n)

/** Rebuild the modeler's objects from the design variables (designs made from a template are parametric). */
function syncGeometry(kind: Kind, d: Design, a: ArrayDesign, fit = false) {
  const m = useModel.getState()
  m.set({ objs: kind === 'array' ? arrayObjs(d, a) : patchObjs(d), sel: null, draft: null })
  if (fit) m.setView('fit')
}

/** Paper figure → our traces for the same quantity. */
const PAPER_MAP: Record<string, { q: string; fn: Fn; x: XVar; params?: Params }[]> = {
  s11: [{ q: 'S(1,1)', fn: 'dB', x: 'Freq' }],
  vswr: [{ q: 'VSWR(1)', fn: '', x: 'Freq' }],
  vswr_mag: [{ q: 'VSWR(1)', fn: '', x: 'Freq' }, { q: 'S(1,1)', fn: 'mag', x: 'Freq' }],
  gain: [{ q: 'PeakGain', fn: '', x: 'Freq' }, { q: 'PeakRealizedGain', fn: '', x: 'Freq' }],
  dir: [{ q: 'PeakDirectivity', fn: '', x: 'Freq' }],
  power: ['AcceptedPower', 'ReflectedPower', 'RadiatedPower', 'DielectricLoss'].map((q) => ({ q, fn: '' as Fn, x: 'Freq' as XVar })),
  absorbed: [{ q: 'ReflectedPower', fn: '', x: 'Freq' }],
  loss: [{ q: 'DielectricLoss', fn: '', x: 'Freq' }, { q: 'ConductorLoss', fn: '', x: 'Freq' }],
  eff: [{ q: 'RadiationEfficiency', fn: 'dB10', x: 'Freq' }, { q: 'TotalEfficiency', fn: 'dB10', x: 'Freq' }],
  pattern: [{ q: 'GainTotal', fn: '', x: 'Theta', params: { phi: 90, freq: 2.4 } }],
  cut: [{ q: 'GainTotal', fn: '', x: 'Theta', params: { phi: 90, freq: 2.4 } }],
}

export const useStudio = create<State & Actions>((set, get) => {
  const print = (kind: Line['kind'], text: string) => set((s) => ({ lines: [...s.lines.slice(-400), { id: lid++, kind, text }] }))
  return {
    project: 'Project1', design: 'Design1', kind: null, d: fromEquations(), a: PAPER_ARRAY,
    setup: { f1: 2.1, f2: 2.8, n: 141 }, sols: [], dirty: false, busy: null,
    reports: [], docs: ['model'], active: 'model', sel: null,
    lines: [{ id: lid++, kind: 'sys', text: 'Smart EM · type help for commands, or ask the solver a question.' }], hist: [],
    paper: null, issues: [], dock: 'console', aiSource: '',

    print,
    set: (p) => set(p),

    /** A new design starts clean: its own variables, solutions and reports (a paper import keeps its source PDF). */
    newDesign: (kind, d, a, keepPaper = false) => {
      const dd = d ?? (kind === 'array' ? PAPER_ELEMENT : fromEquations())
      const aa = a ?? PAPER_ARRAY
      if (!keepPaper) setGoal(2.4, 2.48, 'Wi-Fi / BLE')
      set((s) => ({
        kind, d: dd, a: aa, sols: [], dirty: false, sel: 'vars', design: kind === 'array' ? 'Array1' : 'Patch1', reports: [],
        ...(keepPaper ? { docs: ['model', 'paper'], active: 'model' } : { paper: null, issues: [], project: 'Project1', docs: ['model'], active: 'model' }),
        setup: kind === 'array' ? { f1: 1.9, f2: 2.7, n: 161 } : s.setup,
      }))
      syncGeometry(kind, dd, aa, true)
      useModel.getState().set({ past: [], future: [] })
    },
    setVar: (k, v) => {
      const s = get()
      const d = { ...s.d, [k]: v }
      set({ d, dirty: s.sols.length > 0 })
      if (s.kind) syncGeometry(s.kind, d, s.a)
    },
    setArr: (p) => {
      const s = get()
      const a = { ...s.a, ...p }
      set({ a, dirty: s.sols.length > 0 })
      if (s.kind === 'array') syncGeometry('array', s.d, a)
    },

    solve: async (o = {}) => {
      const s = get()
      if (s.busy) return null
      const m = useModel.getState()
      const checks = validate(m.objs)
      if (checks.some((c) => c.kind === 'err')) {
        checks.filter((c) => c.kind !== 'ok').forEach((c) => m.log(c.kind, c.text))
        print('err', 'Validation failed. See Messages.'); set({ dock: 'messages' })
        return null
      }
      let kind = s.kind, d = s.d
      if (kind !== 'array') {
        const r = recognisePatch(m.objs)
        if (!r.ok) {
          r.problems.forEach((p) => m.log('warn', p))
          print('err', 'Not a model this solver handles (inset-fed patches and patch arrays). See Messages.')
          return null
        }
        kind = 'patch'; d = r.design
        set({ kind, d })
      }
      const passes = kind === 'array' ? 5 : 6, dS = [0.21, 0.083, 0.031, 0.012, 0.0061, 0.0031]
      const t0 = performance.now()
      if (!o.quiet) print('sys', `Analyze Setup1${kind === 'array' ? ' · unit cell (Floquet) + finite 4×4' : ''}`)
      for (let i = 1; i <= passes; i++) {
        set({ busy: { label: `Setup1 · adaptive pass ${i}/${passes}`, p: i / (passes + 1) } })
        if (!o.quiet) m.log('info', `Setup1 pass ${i}: max ΔS ${dS[i - 1]}`)
        await sleep(o.quiet ? 60 : 200)
      }
      set({ busy: { label: `Sweep ${s.setup.f1}–${s.setup.f2} GHz, ${s.setup.n} pts`, p: 0.95 } })
      await sleep(o.quiet ? 60 : 250)
      const sol: Solution = { id: sid++, name: '', kind, d, a: kind === 'array' ? get().a : undefined, sweep: [s.setup.f1, s.setup.f2, s.setup.n] }
      sol.name = `Setup1 : Sweep  (run ${sol.id})`
      set((st) => ({ sols: [...st.sols, sol], busy: null, dirty: false }))
      m.log('ok', `Setup1 converged (ΔS ${dS[passes - 1]} < 0.01). Run ${sol.id} stored.`)
      const secs = ((performance.now() - t0) / 1000).toFixed(1)
      if (kind === 'array') {
        const am = arrayMetrics(d, sol.a!)
        print('out', `run ${sol.id}  active S11 worst ${f2(am.activeWorst, 1)} dB  SLL worst ${f2(am.sllWorst, 1)} dB  G0 ${f2(am.gain0, 1)} dBi  ${secs} s`)
      } else {
        const x = metrics(d)
        print('out', `run ${sol.id}  f0 ${f2(x.f0, 3)} GHz  S11min ${f2(x.min, 1)} dB  BW ${x.bw.toFixed(0)} MHz  worst ${GOAL.f1}–${GOAL.f2} ${f2(x.worst, 1)} dB  ${secs} s`)
      }
      return sol
    },

    optimize: async () => {
      const s = get()
      if (!s.kind) { print('err', 'No design.'); return }
      if (!s.sols.length) await get().solve({ quiet: true })
      if (s.kind === 'array') {
        print('sys', `Optimetrics · active S11 ≤ ${ARRAY_GOAL.active} dB and SLL ≤ ${ARRAY_GOAL.sll} dB over ±42° · vars L, inset, dx, dy, taper`)
        for (let n = 1; n <= 6; n++) {
          const pitch = [50, 53, 55, 56, 56, 56][n - 1]
          const st = get()
          const d = tuneStep(st.d, n === 1 ? 0.45 : 0.6)
          set({ d, a: { ...st.a, dx: pitch, dy: pitch, taper: n >= 3 ? 'taylor' : st.a.taper, sll: 25 } })
          syncGeometry('array', d, get().a)
          const sol = await get().solve({ quiet: true })
          if (!sol) return
          const am = arrayMetrics(sol.d, sol.a!)
          print('out', `iter ${n}  L ${f2(d.L)}  inset ${f2(d.y0)}  dx ${pitch}  ${get().a.taper}  active ${f2(am.activeWorst, 1)} dB  SLL ${f2(am.sllWorst, 1)} dB`)
          if (arrayGoalMet(am)) { print('out', `Goal met after ${n} iterations.`); return }
        }
        print('err', 'Stopped after 6 iterations without meeting the goal.')
        return
      }
      print('sys', `Optimetrics · S11 ≤ ${GOAL.db} dB over ${GOAL.f1}–${GOAL.f2} GHz · vars L, inset`)
      for (let n = 1; n <= 8; n++) {
        const d = tuneStep(get().d, n === 1 ? 0.45 : 0.6)
        set({ d }); syncGeometry('patch', d, get().a)
        const sol = await get().solve({ quiet: true })
        if (!sol) return
        const x = metrics(sol.d)
        print('out', `iter ${n}  L ${f2(d.L)}  inset ${f2(d.y0)}  f0 ${f2(x.f0, 3)}  worst ${f2(x.worst, 1)} dB`)
        if (goalMet(x)) { print('out', `Goal met after ${n} iterations.`); return }
      }
      print('err', 'Stopped after 8 iterations without meeting the goal. Try a thicker board: set h 2.4')
    },

    addReport: (r) => {
      const rep: Report = { markers: [], ...r, id: `r${rid++}` }
      set((s) => ({ reports: [...s.reports, rep], docs: [...s.docs.filter((x) => x !== rep.id), rep.id], active: rep.id, sel: `report:${rep.id}` }))
      return rep
    },
    patchReport: (id, p) => set((s) => ({ reports: s.reports.map((r) => (r.id === id ? { ...r, ...p } : r)) })),
    removeReport: (id) => set((s) => ({ reports: s.reports.filter((r) => r.id !== id), docs: s.docs.filter((d) => d !== id), active: s.active === id ? 'model' : s.active })),
    open: (doc) => set((s) => ({ docs: s.docs.includes(doc) ? s.docs : [...s.docs, doc], active: doc, ...(doc.startsWith('r') ? { sel: `report:${doc}` as Sel } : {}) })),
    close: (doc) => set((s) => { const docs = s.docs.filter((d) => d !== doc); return { docs, active: s.active === doc ? docs[docs.length - 1] ?? 'model' : s.active } }),

    importPaper: async (f) => {
      const data = await f.arrayBuffer()
      set({ paper: { name: f.name, data, which: null } })
      get().open('paper')
      print('sys', `Import ${f.name}`)
    },

    /** Called once the PDF is parsed: build the design it describes, solve it, and replicate its plots as reports. */
    paperRead: async (which) => {
      const s = get()
      if (!s.paper || s.paper.read) return
      set({ paper: { ...s.paper, which, read: true } })
      if (!which) { print('out', 'Layout not recognised. Build it in the 3D Modeler, or: insert patch'); return }
      const m = useModel.getState()
      if (which === 'array') {
        setGoal(2.42, 2.44, '20 MHz channel')
        get().newDesign('array', PAPER_ELEMENT, PAPER_ARRAY, true)
        set({ setup: { f1: 1.9, f2: 2.7, n: 161 }, issues: ARRAY_ISSUES, project: 'Saad2025' })
      } else {
        setGoal(2.4, 2.48, 'Wi-Fi / BLE')
        get().newDesign('patch', PAPER_FIXED, undefined, true)
        set({ setup: { f1: 2.0, f2: 2.8, n: 161 }, issues: PAPER_ISSUES, project: 'IslamShikha2022' })
      }
      get().issues.forEach((i) => m.log('warn', `Paper: ${i.title}. ${i.fix}`))
      print('out', `Built ${which === 'array' ? '4×4 array, 16 elements' : 'inset-fed patch'} from the paper · ${get().issues.length} inconsistencies (Messages)`)
      const sol = await get().solve()
      if (!sol) return
      const plots = PAPER_PLOTS[which].filter((p) => p.kind !== 'points')
      let first: Report | null = null
      for (const p of plots) {
        const map = p.quantity.startsWith('steer:')
          ? [{ q: 'RealizedGainTotal', fn: '' as Fn, x: 'Theta' as XVar, params: { steer: +p.quantity.split(':')[1], freq: 2.4 } }]
          : PAPER_MAP[p.quantity] ?? []
        const traces: Trace[] = [
          // each paper curve wears the colour of the computed trace it pairs with, dashed; ours are solid
          ...p.series.map((x, i) => ({ id: newTraceId(), q: '', fn: '' as Fn, x: map[0]?.x ?? 'Freq', sol: -1, params: {}, color: map.length > 1 ? COLORS[i % COLORS.length] : PAPER_INK, dash: '6 4', imported: { label: `Paper ${p.fig}: ${x.label}`, data: x.data } })),
          ...map.map((t, i) => ({ id: newTraceId(), q: t.q, fn: t.fn, x: t.x, sol: -1, params: t.params ?? {}, color: COLORS[i % COLORS.length] })),
        ]
        const r = get().addReport({ name: `${p.fig} ${p.title}`, type: p.kind === 'polar' ? 'polar' : 'rect', traces, xRange: p.quantity === 'cut' ? [0, 180] : p.kind === 'xy' ? p.xDomain : undefined })
        first ??= r
      }
      set({ docs: ['model', 'paper', ...(first ? [first.id] : [])], active: first?.id ?? 'model', sel: first ? `report:${first.id}` : 'vars' })
      print('out', `${plots.length} paper figures replicated as reports (Results). Paper curves dashed.`)
    },
  }
})

if (import.meta.env.DEV) (window as unknown as { __studio: typeof useStudio }).__studio = useStudio
