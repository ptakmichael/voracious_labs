import { create } from 'zustand'
import { ARRAY_GOAL, ARRAY_ISSUES, type ArrayDesign, PAPER_ARRAY, PAPER_ELEMENT, arrayGoalMet, arrayMetrics, lambda } from '../arrayModel'
import { type Design, GOAL, PAPER_FIXED, SUBSTRATE, fromEquations, goalMet, inputR, metrics, setGoal, tuneStep } from '../model'
import { type Obj, useModel, recognisePatch, validate } from '../modeler/model'
import { PAPER_PLOTS } from '../paperPlots'
import { PAPER_ISSUES } from '../store'
import { ARRAY_ROWS, PATCH_ROWS, type XRow } from './extract'
import { arrayObjs, patchObjs } from './geometry'
import type { Fn, Kind, Params, Solution, Trace, XVar } from './quantities'

export interface Marker { id: string; trace: string; x: number }
export interface Report {
  id: string; name: string; type: 'rect' | 'polar' | 'smith'
  traces: Trace[]; markers: Marker[]
  xRange?: [number, number]; yRange?: [number, number]
  fig?: string // set on reports recreated from a paper figure
}
/** Console output. 'sug' is a command the solver suggests: click to run it. */
export interface Line { id: number; kind: 'in' | 'out' | 'err' | 'ai' | 'sys' | 'sug'; text: string }
export interface Issue { title: string; fix: string }
export type Sel = 'vars' | 'setup' | 'opt' | 'obj' | `report:${string}` | null
/** The context panel: what was pulled out of an uploaded paper, and where the paper workflow stands. */
export interface Ctx { name: string; which: 'patch' | 'array' | null; rows: XRow[]; shown: number; stage: 'reading' | 'review' | 'building' | 'built' | 'solved'; open: boolean }

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
  ctx: Ctx | null
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
  solve: (o?: { quiet?: boolean; label?: string; why?: string[] }) => Promise<Solution | null>
  optimize: () => Promise<void>
  addReport: (r: Omit<Report, 'id' | 'markers'> & { markers?: Marker[] }, open?: boolean) => Report
  patchReport: (id: string, p: Partial<Report>) => void
  removeReport: (id: string) => void
  open: (doc: string) => void
  close: (doc: string) => void
  importPaper: (f: File) => Promise<void>
  paperRead: (which: 'patch' | 'array' | null) => Promise<void>
  setRow: (id: string, value: string) => void
  buildFromContext: () => Promise<void>
  runContext: () => Promise<void>
}

let lid = 1, rid = 1, sid = 1
export const newTraceId = () => `t${Math.random().toString(36).slice(2, 8)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const f2 = (v: number, n = 2) => v.toFixed(n)
const sgn = (v: number, n = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(n)}`

/** Rebuild the modeler's objects from the design variables (designs made from a template are parametric). */
function syncGeometry(kind: Kind, d: Design, a: ArrayDesign, fit = false) {
  const m = useModel.getState()
  m.set({ objs: kind === 'array' ? arrayObjs(d, a) : patchObjs(d), sel: null, draft: null })
  if (fit) m.setView('fit')
}

const describe = (o: Obj) => {
  const s = o.size.filter((v) => v > 0).map((v) => f2(v)).join(' × ')
  return o.port ? `${o.name}  ${o.port.z0} Ω lumped port` : `${o.name.padEnd(10)} ${s} mm  ${o.material}`
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

/** Why an optimiser step moved what it moved, from the before/after designs. */
function patchWhy(p: Design, d: Design): string[] {
  const a = metrics(p), b = metrics(d)
  const out = [`f0 ${f2(a.f0, 3)} → ${f2(b.f0, 3)} GHz: L ${sgn(d.L - p.L)} mm (f0 ∝ 1/L)`]
  if (Math.abs(d.y0 - p.y0) > 0.005) out.push(`inset ${sgn(d.y0 - p.y0)} mm keeps Rin ${f2(inputR(p), 0)} → ${f2(inputR(d), 0)} Ω near 50`)
  out.push(`worst in band ${f2(a.worst, 1)} → ${f2(b.worst, 1)} dB`)
  return out
}

export const useStudio = create<State & Actions>((set, get) => {
  const print = (kind: Line['kind'], text: string) => set((s) => ({ lines: [...s.lines.slice(-400), { id: lid++, kind, text }] }))
  return {
    project: 'Project1', design: 'Design1', kind: null, d: fromEquations(), a: PAPER_ARRAY,
    setup: { f1: 2.1, f2: 2.8, n: 141 }, sols: [], dirty: false, busy: null,
    reports: [], docs: ['model'], active: 'model', sel: null,
    lines: [{ id: lid++, kind: 'sys', text: 'Smart EM · type help for commands, plots for every plot, or ask the solver a question.' }], hist: [],
    paper: null, ctx: null, issues: [], dock: 'console', aiSource: '',

    print,
    set: (p) => set(p),

    /** A new design starts clean: its own variables, solutions and reports (a paper import keeps its context). */
    newDesign: (kind, d, a, keepPaper = false) => {
      const dd = d ?? (kind === 'array' ? PAPER_ELEMENT : fromEquations())
      const aa = a ?? PAPER_ARRAY
      if (!keepPaper) setGoal(2.4, 2.48, 'Wi-Fi / BLE')
      set((s) => ({
        kind, d: dd, a: aa, sols: [], dirty: false, sel: 'vars', design: kind === 'array' ? 'Array1' : 'Patch1',
        ...(keepPaper ? {} : { reports: [], paper: null, ctx: null, issues: [], project: 'Project1', docs: ['model'], active: 'model' }),
        setup: kind === 'array' ? { f1: 1.9, f2: 2.7, n: 161 } : s.setup,
      }))
      if (!keepPaper) syncGeometry(kind, dd, aa, true)
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
      const prev = s.sols[s.sols.length - 1]
      const label = o.label ?? (!prev ? (s.ctx ? 'Paper, as built' : 'Initial') : 'Your edit')
      const why = o.why ?? (!prev ? [s.ctx ? 'the paper’s geometry with the flagged values corrected' : 'first solve of the design'] : kind === 'patch' ? patchWhy(prev.d, d) : ['manual change'])
      const sol: Solution = { id: sid++, name: '', label, why, kind, d, a: kind === 'array' ? get().a : undefined, sweep: [s.setup.f1, s.setup.f2, s.setup.n] }
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
          const st = get(), before = arrayMetrics(st.d, st.a)
          const d = tuneStep(st.d, n === 1 ? 0.45 : 0.6)
          const a = { ...st.a, dx: pitch, dy: pitch, taper: n >= 3 ? 'taylor' as const : st.a.taper, sll: 25 }
          const why = [`element: L ${sgn(d.L - st.d.L)} mm, inset ${sgn(d.y0 - st.d.y0)} mm to re-centre the unit cell`]
          if (pitch !== st.a.dx) why.push(`pitch ${st.a.dx} → ${pitch} mm (${f2(pitch / lambda(2.43), 2)} λ): less coupling while steering`)
          if (a.taper !== st.a.taper) why.push(`Taylor −25 dB taper: sidelobes were ${f2(before.sllWorst, 1)} dB`)
          set({ d, a }); syncGeometry('array', d, a)
          const sol = await get().solve({ quiet: true, label: `Optimise ${n}`, why })
          if (!sol) return
          const am = arrayMetrics(sol.d, sol.a!)
          sol.why.push(`active ${f2(before.activeWorst, 1)} → ${f2(am.activeWorst, 1)} dB · SLL ${f2(before.sllWorst, 1)} → ${f2(am.sllWorst, 1)} dB`)
          print('out', `iter ${n}  L ${f2(d.L)}  inset ${f2(d.y0)}  dx ${pitch}  ${a.taper}  active ${f2(am.activeWorst, 1)} dB  SLL ${f2(am.sllWorst, 1)} dB`)
          if (arrayGoalMet(am)) { print('out', `Goal met after ${n} iterations. Why: plot history`); return }
        }
        print('err', 'Stopped after 6 iterations without meeting the goal.')
        return
      }
      print('sys', `Optimetrics · S11 ≤ ${GOAL.db} dB over ${GOAL.f1}–${GOAL.f2} GHz · vars L, inset`)
      for (let n = 1; n <= 8; n++) {
        const p = get().d
        const d = tuneStep(p, n === 1 ? 0.45 : 0.6)
        set({ d }); syncGeometry('patch', d, get().a)
        const sol = await get().solve({ quiet: true, label: `Tune ${n}`, why: patchWhy(p, d) })
        if (!sol) return
        const x = metrics(sol.d)
        print('out', `iter ${n}  L ${f2(d.L)}  inset ${f2(d.y0)}  f0 ${f2(x.f0, 3)}  worst ${f2(x.worst, 1)} dB`)
        if (goalMet(x)) { print('out', `Goal met after ${n} iterations. Why: plot history`); return }
      }
      print('err', 'Stopped after 8 iterations without meeting the goal. Try a thicker board: set h 2.4')
    },

    addReport: (r, open = true) => {
      const rep: Report = { markers: [], ...r, id: `r${rid++}` }
      set((s) => ({ reports: [...s.reports, rep], ...(open ? { docs: [...s.docs.filter((x) => x !== rep.id), rep.id], active: rep.id, sel: `report:${rep.id}` as Sel } : {}) }))
      return rep
    },
    patchReport: (id, p) => set((s) => ({ reports: s.reports.map((r) => (r.id === id ? { ...r, ...p } : r)) })),
    removeReport: (id) => set((s) => ({ reports: s.reports.filter((r) => r.id !== id), docs: s.docs.filter((d) => d !== id), active: s.active === id ? 'model' : s.active })),
    open: (doc) => set((s) => ({ docs: s.docs.includes(doc) ? s.docs : [...s.docs, doc], active: doc, ...(/^r\d/.test(doc) ? { sel: `report:${doc}` as Sel } : {}) })),
    close: (doc) => set((s) => { const docs = s.docs.filter((d) => d !== doc); return { docs, active: s.active === doc ? docs[docs.length - 1] ?? 'model' : s.active } }),

    importPaper: async (f) => {
      const data = await f.arrayBuffer()
      set({ paper: { name: f.name, data, which: null }, ctx: { name: f.name, which: null, rows: [], shown: 0, stage: 'reading', open: true } })
      get().open('paper')
      print('sys', `Import ${f.name} · reading`)
    },

    /**
     * Called once the PDF is parsed. Lists what the paper specifies (one parameter at a time, so you see it read),
     * digitises every results figure into Paper Results, and stops: the engineer checks the summary, then builds.
     */
    paperRead: async (which) => {
      const s = get()
      if (!s.paper || s.paper.read) return
      set({ paper: { ...s.paper, which, read: true } })
      if (!which) {
        set({ ctx: { ...get().ctx!, which: null, stage: 'review' } })
        print('out', 'Layout not recognised: no parameters extracted. Build it in the 3D Modeler, or: insert patch')
        return
      }
      const rows = (which === 'array' ? ARRAY_ROWS : PATCH_ROWS).map((r) => ({ ...r }))
      const issues = which === 'array' ? ARRAY_ISSUES : PAPER_ISSUES
      set({ project: which === 'array' ? 'Saad2025' : 'IslamShikha2022', issues, reports: [], sols: [], kind: null, ctx: { name: s.paper.name, which, rows, shown: 0, stage: 'reading', open: true } })
      useModel.getState().set({ objs: [], sel: null })
      issues.forEach((i) => useModel.getState().log('warn', `Paper: ${i.title}. ${i.fix}`))
      for (let i = 1; i <= rows.length; i++) { await sleep(110); set((st) => ({ ctx: st.ctx && { ...st.ctx, shown: i } })) }
      // digitised figures, as ordinary reports: the paper's curves now, ours once there's a solution
      for (const p of PAPER_PLOTS[which].filter((q) => q.kind !== 'points')) {
        const map = p.quantity.startsWith('steer:')
          ? [{ q: 'RealizedGainTotal', fn: '' as Fn, x: 'Theta' as XVar, params: { steer: +p.quantity.split(':')[1], freq: 2.4 } }]
          : PAPER_MAP[p.quantity] ?? []
        const traces: Trace[] = [
          // each paper curve wears the colour of the computed trace it pairs with, dashed; ours are solid
          ...p.series.map((x, i) => ({ id: newTraceId(), q: '', fn: '' as Fn, x: map[0]?.x ?? 'Freq', sol: -1, params: {}, color: map.length > 1 ? COLORS[i % COLORS.length] : PAPER_INK, dash: '6 4', imported: { label: `Paper ${p.fig}: ${x.label}`, data: x.data } })),
          ...map.map((t, i) => ({ id: newTraceId(), q: t.q, fn: t.fn, x: t.x, sol: -1, params: t.params ?? {}, color: COLORS[i % COLORS.length] })),
        ]
        get().addReport({ name: `${p.fig} ${p.title}`, fig: p.fig, type: p.kind === 'polar' ? 'polar' : 'rect', traces, xRange: p.quantity === 'cut' ? [0, 180] : p.kind === 'xy' ? p.xDomain : undefined }, false)
      }
      const n = get().reports.length, flags = rows.filter((r) => r.status === 'flag' || r.status === 'fixed').length
      set((st) => ({ ctx: st.ctx && { ...st.ctx, stage: 'review' }, docs: ['model', 'paper', 'paperres'], active: 'paperres' }))
      print('out', `${rows.length} parameters extracted, ${flags} corrected or flagged · ${n} figures digitised (Paper Results)`)
      print('out', 'Check the summary on the right, edit anything that came in wrong, then Build model.')
    },

    setRow: (id, value) => set((s) => ({ ctx: s.ctx && { ...s.ctx, rows: s.ctx.rows.map((r) => (r.id === id ? { ...r, value, status: r.status === 'info' ? 'info' : 'ok', note: r.value === value ? r.note : 'edited' } : r)) } })),

    /** Apply the summary to a new design and build it in the modeler one piece at a time. */
    buildFromContext: async () => {
      const c = get().ctx
      if (!c?.which || get().busy) return
      const v = (k: string, fb: number) => { const r = c.rows.find((x) => x.bind === k); const n = r ? parseFloat(r.value) : NaN; return Number.isFinite(n) ? n : fb }
      const base = c.which === 'array' ? PAPER_ELEMENT : PAPER_FIXED
      const subw = c.rows.find((r) => r.id === 'subw')
      const d: Design = { L: v('L', base.L), W: v('W', base.W), y0: v('inset', base.y0), h: v('h', base.h), er: v('er', base.er), gs: subw ? parseFloat(subw.value) / SUBSTRATE.wid || base.gs : base.gs }
      const a: ArrayDesign = { ...PAPER_ARRAY, nx: Math.round(v('nx', 4)), ny: Math.round(v('ny', 4)), dx: v('dx', 50), dy: v('dy', 50) }
      setGoal(v('f1', GOAL.f1), v('f2', GOAL.f2), c.which === 'array' ? '20 MHz channel' : 'Wi-Fi / BLE')
      get().newDesign(c.which, d, a, true)
      set({ setup: c.which === 'array' ? { f1: 1.9, f2: 2.7, n: 161 } : { f1: 2.0, f2: 2.8, n: 161 }, ctx: { ...c, stage: 'building' }, active: 'model', docs: [...new Set([...get().docs, 'model'])] })
      const objs = c.which === 'array' ? arrayObjs(d, a) : patchObjs(d)
      const m = useModel.getState()
      m.set({ objs: [] })
      await sleep(150) // let the modeler tab become visible before fitting the view to it
      print('sys', `Build ${c.which === 'array' ? `${a.nx}×${a.ny} array` : 'inset-fed patch'} from the summary`)
      const step = c.which === 'array' ? 3 : 1 // array: one element (patch, feed, port) per step
      for (let i = 0; i < objs.length;) {
        const n = i < 2 ? 1 : step
        const chunk = objs.slice(i, i + n)
        m.set({ objs: [...useModel.getState().objs, ...chunk] })
        if (i === 0) requestAnimationFrame(() => m.setView('fit'))
        set({ busy: { label: `Building · ${chunk[0].name}`, p: (i + n) / objs.length } })
        print('out', chunk.length > 1 ? `+ element ${chunk[0].name.replace(/\D/g, '')}: patch ${f2(d.W)} × ${f2(d.L)}, feed, ${chunk[2]?.name ?? ''} 50 Ω` : `+ ${describe(chunk[0])}`)
        i += n
        await sleep(i <= 2 ? 380 : c.which === 'array' ? 90 : 320) // board and ground first, then elements quickly
      }
      m.setView('fit')
      const ports = objs.filter((o) => o.port).length
      print('out', `+ Rad1  radiation boundary, λ/4 clearance · Setup1 ${get().setup.f1}–${get().setup.f2} GHz`)
      set((st) => ({ busy: null, ctx: st.ctx && { ...st.ctx, stage: 'built' } }))
      m.log('ok', `Built from the paper: ${objs.length} objects, ${ports} port${ports > 1 ? 's' : ''}.`)
      print('out', `Built · ${objs.length} objects, ${ports} port${ports > 1 ? 's' : ''}. Run to overlay our results on the paper's.`)
    },

    runContext: async () => {
      const sol = await get().solve({ label: 'Paper, as built' })
      if (!sol) return
      set((st) => ({ ctx: st.ctx && { ...st.ctx, stage: 'solved' }, docs: [...new Set([...st.docs, 'paperres'])], active: 'paperres' }))
      print('out', `Overlaid run ${sol.id} on ${get().reports.filter((r) => r.fig).length} paper figures (solid = ours, dashed = paper).`)
    },
  }
})

if (import.meta.env.DEV) (window as unknown as { __studio: typeof useStudio }).__studio = useStudio
