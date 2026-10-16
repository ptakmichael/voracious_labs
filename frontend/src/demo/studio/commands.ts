/**
 * The command line: scriptable commands, and questions for the solver. A line that isn't a command (or starts
 * with '?') is a question. It goes to the backend's AI with a snapshot of the model and its solution; offline, a
 * built-in engine answers from the same numbers. Answers may carry commands ("$ set L 29.1"): actions the user
 * asked for run at once, otherwise they're shown as one-click suggestions.
 */
import { type ArrayDesign, ARRAY_GOAL, arrayMetrics, beam, glFreeScan, lambda } from '../arrayModel'
import { type Design, GOAL, edgeR, inputR, metrics, quality, setGoal } from '../model'
import { useModel, validate } from '../modeler/model'
import { radEff } from '../paperPhysics'
import { useTheme } from '../theme'
import { addMarker, exportCsv, seriesNow } from './Report'
import { type Params, type Trace, type XVar, available, parseExpr, traceLabel } from './quantities'
import { CATALOG, isTool, plotDef } from './catalog'
import { newTraceId, traceStyle, useStudio } from './store'

const S = () => useStudio.getState()
const out = (t: string) => S().print('out', t)
const err = (t: string) => S().print('err', t)
const f = (v: number, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '—')

// ---------------------------------------------------------------- variables

export interface VarDef { key: string; unit: string; desc: string; get: () => number | string; set: (v: string) => boolean }
const dVar = (key: string, k: keyof Design, unit: string, desc: string): VarDef => ({
  key, unit, desc, get: () => S().d[k], set: (v) => { const n = parseFloat(v); if (!Number.isFinite(n) || n <= 0) return false; S().setVar(k, n); return true },
})
const aVar = (key: string, k: keyof ArrayDesign, unit: string, desc: string, int = false): VarDef => ({
  key, unit, desc, get: () => S().a[k] as number, set: (v) => { const n = parseFloat(v); if (!Number.isFinite(n)) return false; S().setArr({ [k]: int ? Math.round(n) : n } as Partial<ArrayDesign>); return true },
})
export function vars(): VarDef[] {
  const base = [dVar('L', 'L', 'mm', 'patch length'), dVar('W', 'W', 'mm', 'patch width'), dVar('inset', 'y0', 'mm', 'feed inset'), dVar('h', 'h', 'mm', 'substrate height'), dVar('er', 'er', '', 'substrate εr'), dVar('gs', 'gs', '×', 'ground size')]
  if (S().kind !== 'array') return base
  return [...base.slice(0, 5),
    aVar('nx', 'nx', '', 'columns', true), aVar('ny', 'ny', '', 'rows', true), aVar('dx', 'dx', 'mm', 'pitch x'), aVar('dy', 'dy', 'mm', 'pitch y'),
    aVar('steer', 'theta', 'deg', 'scan angle'), aVar('phi', 'phi', 'deg', 'scan plane'), aVar('sll', 'sll', 'dB', 'taper sidelobe level'), aVar('bits', 'bits', '', 'phase-shifter bits (0 = ideal)', true),
    { key: 'taper', unit: '', desc: 'uniform | taylor | cheb', get: () => S().a.taper, set: (v) => (['uniform', 'taylor', 'cheb'].includes(v) ? (S().setArr({ taper: v as ArrayDesign['taper'] }), true) : false) },
    { key: 'ttd', unit: '', desc: 'true-time delay 0 | 1', get: () => (S().a.ttd ? 1 : 0), set: (v) => (S().setArr({ ttd: v === '1' || v === 'true' }), true) },
  ]
}

// ---------------------------------------------------------------- commands

let fileInput: HTMLInputElement | null = null
export const bindFileInput = (el: HTMLInputElement | null) => { fileInput = el }

/** Parse "report dB(S(1,1)) vs Freq phi=90 steer=32 polar" into traces. */
function traceArgs(args: string[]): { traces: Trace[]; type?: 'rect' | 'polar' | 'smith' } | string {
  const exprs: string[] = [], params: Params = {}
  let x: XVar | undefined, type: 'rect' | 'polar' | 'smith' | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i], m = /^(phi|steer|freq)=([-\d.]+)$/i.exec(a)
    if (m) params[m[1].toLowerCase() as keyof Params] = +m[2]
    else if (a.toLowerCase() === 'vs') { const v = args[++i]?.toLowerCase(); x = v?.startsWith('th') ? 'Theta' : v?.startsWith('sc') ? 'ScanAng' : 'Freq' }
    else if (['polar', 'smith', 'rect'].includes(a.toLowerCase())) type = a.toLowerCase() as typeof type
    else exprs.push(a)
  }
  if (!exprs.length) return 'Which quantity? e.g. report dB(S(1,1))   (quantities: help report)'
  const traces: Trace[] = []
  for (const [i, e] of exprs.entries()) {
    const p = parseExpr(e)
    if (!p) return `Unknown quantity ${e}. Try: help report`
    traces.push({ id: newTraceId(), q: p.q, fn: p.fn, x: x ?? (p.q.includes('Gain') && !p.q.startsWith('Peak') ? 'Theta' : 'Freq'), sol: -1, params, ...traceStyle(i) })
  }
  return { traces, type }
}

const activeReport = () => S().reports.find((r) => r.id === S().active)

/** Open any plot or tool by its catalog id: standard plots as reports, 3D gain and tools in their own windows. */
export function openPlot(id: string, args: string[] = []) {
  const p = plotDef(id), s = S()
  if (!p) { err(`No plot ${id}. Try: plots`); return }
  if (!s.kind) { err('No design yet. insert patch | insert array | import paper'); return }
  if (!p.kinds.includes(s.kind)) { err(`${p.name} is for ${p.kinds.join(' / ')} designs.`); return }
  const num = (k: string) => { const m = args.map((a) => new RegExp(`^${k}=([-\\d.]+)$`, 'i').exec(a)).find(Boolean); return m ? +m[1] : undefined }
  const steer = num('steer') ?? s.a.theta
  if (p.report) { const c = p.report(s.kind, steer); s.print('sys', `$ ${c}`); void runLine(c, false); return }
  if (p.id === 'gain3d') { s.open(`g3d|${num('freq') ?? (s.kind === 'array' ? 2.43 : +((s.setup.f1 + s.setup.f2) / 2).toFixed(3))}|${steer}`); return }
  s.open(`tool:${p.id}`)
}

interface Cmd { name: string; usage: string; help: string; run: (a: string[]) => void | Promise<void> }
export const COMMANDS: Cmd[] = [
  { name: 'help', usage: 'help [command]', help: 'list commands', run: (a) => {
    if (a[0] === 'report') { out('quantities: S(1,1) Z(1,1) VSWR(1) ActiveS(1,1) GainTotal RealizedGainTotal PeakGain PeakRealizedGain PeakDirectivity RadiationEfficiency TotalEfficiency AcceptedPower ReflectedPower RadiatedPower DielectricLoss ConductorLoss BeamPointing SideLobeLevel'); out('functions: dB mag re im ang dB10 · sweeps: vs Freq | Theta | ScanAng · params: phi= steer= freq= · type: rect polar smith'); return }
    const c = COMMANDS.find((x) => x.name === a[0])
    if (c) { out(`${c.usage}  ${c.help}`); return }
    for (const x of COMMANDS) out(`${x.usage.padEnd(34)} ${x.help}`)
    out('Anything else is a question for the solver, e.g.  why is the match poor at 2.48?')
  } },
  { name: 'insert', usage: 'insert patch | array', help: 'new design from a template', run: (a) => {
    const k = a[0]?.startsWith('arr') ? 'array' : 'patch'
    S().newDesign(k); S().open('model'); out(k === 'array' ? '4×4 patch array, 50 mm pitch, εr 10.2' : 'inset-fed patch, 2.44 GHz, 1.6 mm FR-4')
  } },
  { name: 'vars', usage: 'vars', help: 'list design variables', run: () => {
    if (!S().kind) { err('No design. insert patch | insert array | import paper'); return }
    for (const v of vars()) out(`${v.key.padEnd(6)} ${String(typeof v.get() === 'number' ? f(v.get() as number, 3) : v.get()).padStart(9)} ${v.unit.padEnd(4)} ${v.desc}`)
  } },
  { name: 'set', usage: 'set <var> <value>', help: 'change a design variable', run: (a) => {
    const v = vars().find((x) => x.key.toLowerCase() === a[0]?.toLowerCase())
    if (!v || a[1] === undefined) { err(`usage: set <var> <value>   vars: ${vars().map((x) => x.key).join(' ')}`); return }
    if (!v.set(a[1])) { err(`bad value for ${v.key}`); return }
    out(`${v.key} = ${a[1]} ${v.unit}`)
  } },
  { name: 'validate', usage: 'validate', help: 'check the model', run: () => { const c = validate(useModel.getState().objs); c.forEach((x) => useModel.getState().log(x.kind, x.text)); out(c.some((x) => x.kind === 'err') ? 'Validation failed (Messages)' : `Validation passed · ${useModel.getState().objs.length} objects`) } },
  { name: 'solve', usage: 'solve', help: 'analyze Setup1 (F5)', run: async () => { await S().solve() } },
  { name: 'optimize', usage: 'optimize', help: 'run Optimetrics toward the goal', run: async () => { await S().optimize() } },
  { name: 'goal', usage: 'goal <f1> <f2> [dB]', help: 'match goal band', run: (a) => {
    const [f1, f2, db] = a.map(Number)
    if (!(f2 > f1)) { out(`goal: S11 ≤ ${GOAL.db} dB, ${GOAL.f1}–${GOAL.f2} GHz`); return }
    setGoal(f1, f2, 'custom'); if (Number.isFinite(db)) GOAL.db = db; out(`goal: S11 ≤ ${GOAL.db} dB, ${f1}–${f2} GHz`)
  } },
  { name: 'setup', usage: 'setup <f1> <f2> [points]', help: 'frequency sweep', run: (a) => {
    const [f1, f2, n] = a.map(Number)
    if (!(f2 > f1)) { const s = S().setup; out(`Setup1 sweep ${s.f1}–${s.f2} GHz, ${s.n} pts`); return }
    S().set({ setup: { f1, f2, n: Number.isFinite(n) ? Math.max(11, Math.round(n)) : S().setup.n }, dirty: S().sols.length > 0 }); out(`Setup1 sweep ${f1}–${f2} GHz`)
  } },
  { name: 'report', usage: 'report <expr> [vs X] [k=v] [polar]', help: 'new report, e.g. report dB(S(1,1))', run: (a) => {
    const r = traceArgs(a)
    if (typeof r === 'string') { err(r); return }
    const rep = S().addReport({ name: r.type === 'smith' ? `${r.traces[0].q} Smith` : r.traces.map(traceLabel).join(', ').slice(0, 40), type: r.type ?? (r.traces[0].x === 'Theta' ? 'polar' : 'rect'), traces: r.traces })
    if (!S().sols.length) out(`${rep.name} created · no solution yet: solve`)
  } },
  { name: 'trace', usage: 'trace <expr> [vs X] [k=v]', help: 'add trace to the active report', run: (a) => {
    const rep = activeReport()
    if (!rep) { err('No active report. Use report <expr>'); return }
    const r = traceArgs(a)
    if (typeof r === 'string') { err(r); return }
    const n = rep.traces.filter((t) => !t.imported).length
    S().patchReport(rep.id, { traces: [...rep.traces, ...r.traces.map((t, i) => ({ ...t, ...traceStyle(n + i) }))] })
  } },
  { name: 'marker', usage: 'marker max | min | <x>', help: 'marker on the active report', run: (a) => {
    const rep = activeReport()
    if (!rep) { err('No active report.'); return }
    const at = a[0] === 'min' ? 'min' : a[0] === 'max' || !a[0] ? 'max' : +a[0]
    addMarker(rep, at as 'max' | 'min' | number, seriesNow(rep))
  } },
  { name: 'plot', usage: 'plot <name> [freq=] [steer=]', help: 'open any plot or tool (see: plots)', run: (a) => { if (!a[0]) { err('usage: plot <name>   names: plots'); return } openPlot(a[0], a.slice(1)) } },
  { name: 'plots', usage: 'plots', help: 'list every plot and tool', run: () => {
    const k = S().kind ?? 'patch'
    for (const g of ['Standard', 'Insight', 'Array', 'Solve'] as const) {
      const ps = CATALOG.filter((p) => p.group === g && p.kinds.includes(k))
      if (ps.length) out(`${g.padEnd(9)} ${ps.map((p) => p.id + (isTool(p) ? '*' : '')).join('  ')}`)
    }
    out('* opens in its own window · e.g.  plot gain3d   plot effects   plot history')
  } },
  { name: 'build', usage: 'build', help: 'build the model from the context summary', run: async () => { if (!S().ctx?.which) { err('No paper context. import paper'); return } await S().buildFromContext() } },
  { name: 'run', usage: 'run', help: 'solve and overlay on the paper figures', run: async () => { if (S().ctx?.which) await S().runContext(); else await S().solve() } },
  { name: 'context', usage: 'context', help: 'show the context panel', run: () => { const c = S().ctx; if (!c) { err('No context uploaded.'); return } S().set({ ctx: { ...c, open: !c.open } }) } },
  { name: 'reports', usage: 'reports', help: 'list reports', run: () => { const r = S().reports; if (!r.length) out('No reports.'); r.forEach((x) => out(`${x.id.padEnd(4)} ${x.name}`)) } },
  { name: 'open', usage: 'open <model|paper|report>', help: 'bring a window forward', run: (a) => {
    const k = a.join(' ').toLowerCase()
    if (k === 'model' || k === 'paper') { S().open(k); return }
    const r = S().reports.find((x) => x.id === k || x.name.toLowerCase().includes(k))
    if (r) S().open(r.id); else err(`No window ${k}`)
  } },
  { name: 'export', usage: 'export csv', help: 'active report data as CSV', run: () => { const r = activeReport(); if (r) exportCsv(r); else err('No active report.') } },
  { name: 'import', usage: 'import paper', help: 'open a PDF and replicate it', run: () => { fileInput?.click() } },
  { name: 'steer', usage: 'steer <deg>', help: 'array scan angle', run: (a) => { if (S().kind !== 'array') { err('Not an array design.'); return } S().setArr({ theta: +a[0] || 0 }); out(`steer = ${+a[0] || 0} deg`) } },
  { name: 'theme', usage: 'theme light | dark', help: 'colour theme', run: (a) => { const t = useTheme.getState(); if ((a[0] === 'dark') !== t.dark) t.toggle() } },
  { name: 'clear', usage: 'clear', help: 'clear the console', run: () => S().set({ lines: [] }) },
]

export const commandNames = COMMANDS.map((c) => c.name)

export async function runLine(raw: string, echo = true) {
  const line = raw.trim()
  if (!line) return
  if (echo) { S().print('in', line); S().set({ hist: [...S().hist.filter((h) => h !== line).slice(-80), line] }) }
  const [head, ...args] = line.replace(/^\$\s*/, '').split(/\s+/)
  const c = !line.startsWith('?') && COMMANDS.find((x) => x.name === head.toLowerCase() || (head.toLowerCase() === 'analyze' && x.name === 'solve'))
  if (c) { try { await c.run(args) } catch (e) { err(String(e)) } return }
  await ask(line.replace(/^\?\s*/, ''))
}

// ---------------------------------------------------------------- the solver answers

/** What the solver knows right now: design, latest solution, sensitivities, paper findings. Sent to the AI. */
export function snapshot() {
  const s = S(), last = s.sols[s.sols.length - 1]
  const snap: Record<string, unknown> = {
    design: s.kind, variables: Object.fromEntries(vars().map((v) => [v.key, v.get()])), units: 'mm, GHz, dB',
    setup: s.setup, goal: s.kind === 'array' ? { activeS11_max_dB: ARRAY_GOAL.active, sll_max_dB: ARRAY_GOAL.sll, scan_deg: 42, band_GHz: [GOAL.f1, GOAL.f2] } : { S11_max_dB: GOAL.db, band_GHz: [GOAL.f1, GOAL.f2] },
    solved_runs: s.sols.length, design_changed_since_last_run: s.dirty,
    reports: s.reports.map((r) => r.name), paper_issues: s.issues.map((i) => `${i.title}: ${i.fix}`),
    report_syntax: 'report <fn>(<quantity>) [<fn>(<quantity>) …] [vs Freq|Theta|ScanAng] [phi=<deg>] [steer=<deg>] [freq=<GHz>] [rect|polar|smith]',
    report_quantities: available(s.kind ?? 'patch').map((q) => `${q.name} (fns: ${q.fns.map((f) => f || 'none').join('/')}; vs ${q.xs.join('/')}${q.params.length ? `; params ${q.params.join(',')}` : ''})`),
    report_examples: ['report dB(S(1,1))', 'report S(1,1) smith', 'report RealizedGainTotal vs Theta phi=90 polar', 'report dB(ActiveS(1,1)) vs ScanAng', 'report PeakRealizedGain vs ScanAng'],
    variable_names: vars().map((v) => v.key),
    plot_names: CATALOG.filter((p) => p.kinds.includes(s.kind ?? 'patch')).map((p) => `${p.id}: ${p.name}`),
    plot_usage: 'plot <name> opens any of plot_names (3D gain, Smith, analysis tools, run history)',
  }
  if (last) {
    const m = metrics(last.d)
    snap.latest_element = { f0_GHz: +m.f0.toFixed(4), S11_min_dB: +m.min.toFixed(2), bw_10dB_MHz: Math.round(m.bw), worst_in_goal_band_dB: +m.worst.toFixed(2), Rin_at_f0_ohm: +inputR(last.d).toFixed(1), R_edge_ohm: +edgeR(last.d).toFixed(1), Q: +quality(last.d).toFixed(1), gain_dBi: +m.gain.toFixed(2), rad_eff: +radEff(last.d, m.f0).toFixed(3) }
    snap.sensitivity_per_plus2pct = sens(last.d)
    if (last.a) {
      const am = arrayMetrics(last.d, last.a), b = beam(last.d, { ...last.a, f: 2.43 })
      snap.latest_array = { active_S11_worst_dB: +am.activeWorst.toFixed(2), sll_worst_dB: +am.sllWorst.toFixed(2), gain_broadside_dBi: +am.gain0.toFixed(2), gain_at_42_dBi: +am.gainMax.toFixed(2), beam_points_at_deg: b.point, commanded_deg: last.a.theta, grating_lobe_free_to_deg: +glFreeScan(last.a, 2.43).toFixed(1), pitch_lambda: +(last.a.dx / lambda(2.43)).toFixed(3) }
    }
  }
  return snap
}

function sens(d: Design) {
  const base = metrics(d)
  return Object.fromEntries((['L', 'W', 'y0', 'h', 'er'] as (keyof Design)[]).map((k) => {
    const m = metrics({ ...d, [k]: d[k] * 1.02 })
    return [k === 'y0' ? 'inset' : k, { df0_MHz: Math.round((m.f0 - base.f0) * 1000), dWorst_dB: +(m.worst - base.worst).toFixed(2), dRin_ohm: +(inputR({ ...d, [k]: d[k] * 1.02 }) - inputR(d)).toFixed(1) }]
  }))
}

async function ask(q: string) {
  const st = S()
  st.set({ busy: st.busy ?? { label: 'Solver is thinking', p: 0 } })
  let reply: string | null = null, src = ''
  try {
    const history = st.lines.filter((l) => l.kind === 'in' || l.kind === 'ai').slice(-10).map((l) => ({ role: l.kind === 'in' ? 'engineer' : 'solver', text: l.text }))
    const r = await fetch('/api/studio/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q, state: snapshot(), history, commands: COMMANDS.map((c) => c.usage) }) })
    if (r.ok) { const j = await r.json(); reply = j.answer ?? null; src = j.provider ?? '' }
  } catch { /* backend offline: answer locally */ }
  if (S().busy?.label === 'Solver is thinking') S().set({ busy: null })
  const local = reply ? null : localAnswer(q)
  const text = reply ?? local!.text
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const cmds = lines.filter((l) => l.startsWith('$ ')).map((l) => l.slice(2))
  lines.filter((l) => !l.startsWith('$ ')).forEach((l) => S().print('ai', l))
  S().set({ aiSource: src || 'built-in' })
  const act = local ? local.act : /^(please |can you |could you )?(plot|show|make|set|change|tune|optimi[sz]e|solve|run|analy[sz]e|insert|build|create|add|steer|open|fix|move|center|centre)\b/i.test(q)
  for (const c of cmds) { if (act) { S().print('sys', `$ ${c}`); await runLine(c, false) } else S().print('sug', c) }
}

const near = (q: string, re: RegExp) => re.test(q.toLowerCase())

/** Offline answers, computed from the model. Terse, numbers first. */
export function localAnswer(q: string): { text: string; act: boolean } {
  const s = S(), last = s.sols[s.sols.length - 1]
  const go = (cmd: string, note = '') => ({ text: `${note ? note + '\n' : ''}$ ${cmd}`, act: true })
  // actions
  if (near(q, /\b(build|make|insert|create|new)\b.*\barray\b/)) return go('insert array')
  if (near(q, /\b(build|make|insert|create|new)\b.*\b(patch|antenna)\b/)) return go('insert patch')
  if (near(q, /\b(optimi[sz]e|tune it|meet the goal|fix (it|the match))\b/)) return go('optimize')
  if (near(q, /^(solve|simulate|analy[sz]e|run)\b/)) return go('solve')
  if (near(q, /\b(plot|show|graph|draw|open)\b/) && near(q, /3d|three.?d/)) return go('plot gain3d')
  if (near(q, /\b(plot|show|open)\b/)) {
    const tool = [['effect', 'effects'], ['what moves', 'matrix'], ['contour|good designs', 'contour'], ['field', 'fields'], ['loop', 'smithloops'], ['history|tree|version', 'history'], ['why|choice|solver', 'solver'], ['designer', 'designer'], ['u-?v', 'uv'], ['scan perf', 'scan']].find(([re]) => near(q, new RegExp(re)))
    if (tool) return go(`plot ${tool[1]}`)
  }
  if (near(q, /\b(plot|show|graph|draw)\b/)) {
    if (near(q, /smith/)) return go('report S(1,1) smith')
    if (near(q, /impedance|z11|resistance/)) return go('report re(Z(1,1)) im(Z(1,1))')
    if (near(q, /vswr/)) return go('report VSWR(1)')
    if (near(q, /active/)) return go('report dB(ActiveS(1,1)) vs ScanAng')
    if (near(q, /squint|point/)) return go('report BeamPointing')
    if (near(q, /side ?lobe|sll/)) return go('report SideLobeLevel vs ScanAng')
    if (near(q, /pattern|radiation|far ?field/)) return go(s.kind === 'array' ? `report RealizedGainTotal vs Theta steer=${s.a.theta}` : 'report RealizedGainTotal vs Theta phi=90 polar')
    if (near(q, /gain|directiv/)) return go(s.kind === 'array' ? 'report PeakRealizedGain vs ScanAng' : 'report PeakGain PeakRealizedGain')
    if (near(q, /efficien/)) return go('report dB10(RadiationEfficiency) dB10(TotalEfficiency)')
    if (near(q, /power|loss/)) return go('report AcceptedPower RadiatedPower DielectricLoss ConductorLoss')
    return go('report dB(S(1,1))')
  }
  const target = /(?:at|to)\s+([\d.]+)\s*ghz/i.exec(q)
  if (target && near(q, /resonat|tune|move|cent(er|re)|shift/) && last) {
    const ft = +target[1], m = metrics(last.d), L = (last.d.L * m.f0) / ft
    return { text: `f0 scales ≈ 1/L. ${f(m.f0, 3)} → ${ft} GHz needs L ≈ ${f(L)} mm (inset kept at the same fraction).\n$ set L ${f(L)}\n$ set inset ${f((last.d.y0 * L) / last.d.L)}\n$ solve`, act: near(q, /^(tune|move|make|set|cent|shift)/) }
  }
  if (!s.kind) return { text: 'No design yet. insert patch, insert array, or import paper.', act: false }
  if (!last) return { text: 'Not solved yet.\n$ solve', act: false }
  const d = last.d, m = metrics(d)
  if (s.kind === 'array' && last.a) {
    const a = last.a, am = arrayMetrics(d, a)
    if (near(q, /point|squint|steer|where/)) {
      const m1 = /(\d+)\s*(°|deg)/.exec(q)
      const th = m1 ? +m1[1] : a.theta || 42
      const b = beam(d, { ...a, theta: th, f: 2.43 }), lo = beam(d, { ...a, theta: th, f: GOAL.f1 }), hi = beam(d, { ...a, theta: th, f: GOAL.f2 })
      return { text: `Commanded ${th}° → peak at ${f(b.point, 1)}° (element pattern pulls it toward broadside). Across ${GOAL.f1}–${GOAL.f2} GHz: ${f(lo.point, 1)}° to ${f(hi.point, 1)}° (${a.ttd ? 'TTD' : 'phase shifters'}).\n$ report BeamPointing steer=${th}`, act: false }
    }
    if (near(q, /grating|spacing|pitch/)) {
      const L = lambda(2.43), dmax = L / (1 + Math.sin((60 * Math.PI) / 180))
      return { text: `Pitch ${f(a.dx, 1)} mm = ${f(a.dx / L, 3)} λ. Grating-lobe free to ${f(glFreeScan(a, 2.43), 0)}°. For 60° scan: d ≤ ${f(dmax, 1)} mm.`, act: false }
    }
    if (near(q, /side ?lobe|sll|taper/)) return { text: `Worst SLL over ±42°: ${f(am.sllWorst, 1)} dB (goal ${ARRAY_GOAL.sll}). Taper ${a.taper}${a.taper !== 'uniform' ? ` ${a.sll} dB` : ''}.${a.taper === 'uniform' ? '\n$ set taper taylor' : ''}`, act: false }
    if (near(q, /active|match|coupl/)) return { text: `Worst active S11 over ±42°: ${f(am.activeWorst, 1)} dB (goal ${ARRAY_GOAL.active}). Isolated element ${f(m.worst, 1)} dB; the rest is mutual coupling at ${f(a.dx / lambda(2.43), 2)} λ.\n$ report dB(ActiveS(1,1)) vs ScanAng`, act: false }
    if (near(q, /gain|scan loss/)) return { text: `Broadside ${f(am.gain0, 1)} dBi, at 42° ${f(am.gainMax, 1)} dBi (scan loss ${f(am.scanLoss, 1)} dB).`, act: false }
    if (near(q, /fail|dead|broken/)) {
      const ok = beam(d, { ...a, theta: 32, f: 2.43 }), bad = beam(d, { ...a, theta: 32, f: 2.43, failed: [5, 10] })
      return { text: `Two centre elements off (6, 11) at 32°: gain ${f(ok.gain - bad.gain, 1)} dB lower, worst sidelobe ${f(ok.sll, 1)} → ${f(bad.sll, 1)} dB.`, act: false }
    }
    if (near(q, /bit|phase shifter|quanti/)) {
      const rows = [0, 6, 4, 3, 2].map((bits) => { const b = beam(d, { ...a, bits, theta: 32, f: 2.43 }); return `${bits ? bits + '-bit' : 'ideal'} ${f(b.gain, 1)} dBi / ${f(b.sll, 1)} dB` })
      return { text: `At 32°: ${rows.join(' · ')}`, act: false }
    }
  }
  if (near(q, /resonan|f0|where.*(tuned|resonat)/)) return { text: `f0 ${f(m.f0, 3)} GHz · S11 ${f(m.min, 1)} dB there · Rin ${f(inputR(d), 1)} Ω.`, act: false }
  if (near(q, /bandwidth|\bbw\b|wider|broad/)) {
    const thick = metrics({ ...d, h: d.h + 0.8 })
    return { text: `BW(−10 dB) ${m.bw.toFixed(0)} MHz, Q ${f(quality(d), 1)}. h +0.8 mm → ~${thick.bw.toFixed(0)} MHz (re-tune L after).\n$ set h ${f(d.h + 0.8, 1)}`, act: false }
  }
  if (near(q, /match|impedance|resistance|50|inset|why.*(poor|bad|not)/)) {
    const R = inputR(d), Re = edgeR(d), y0 = (d.L / Math.PI) * Math.acos(Math.sqrt(Math.min(1, 50 / Re)))
    const band = m.worst <= GOAL.db ? `meets ${GOAL.db} dB across ${GOAL.f1}–${GOAL.f2}` : `worst ${f(m.worst, 1)} dB in ${GOAL.f1}–${GOAL.f2}${m.f0 < GOAL.f1 || m.f0 > GOAL.f2 ? `: f0 ${f(m.f0, 3)} is outside the band` : ''}`
    return { text: `Rin at f0 ${f(R, 1)} Ω (edge ${f(Re, 0)} Ω × cos²(π·inset/L)). ${band}. Inset for 50 Ω: ${f(y0)} mm.\n$ set inset ${f(y0)}`, act: false }
  }
  if (near(q, /sensitiv|matter|which|most|tolerance|affect/)) {
    const sv = sens(d)
    const top = Object.entries(sv).sort((x, y) => Math.abs(y[1].df0_MHz) - Math.abs(x[1].df0_MHz))
    return { text: `+2% on each: ${top.map(([k, v]) => `${k} ${v.df0_MHz >= 0 ? '+' : ''}${v.df0_MHz} MHz`).join(' · ')}. Match moves most with inset (${sv.inset.dRin_ohm} Ω).`, act: false }
  }
  if (near(q, /gain|directiv|efficien/)) return { text: `Peak gain ${f(m.gain, 2)} dBi · radiation efficiency ${f(radEff(d, m.f0) * 100, 0)}%.`, act: false }
  if (near(q, /mesh|converg|pass|accura|how.*solv/)) return { text: `Setup1: ${s.kind === 'array' ? 5 : 6} adaptive passes, max ΔS 0.0031 < 0.01. Mock solver: cavity/transmission-line model, not full-wave.`, act: false }
  if (near(q, /paper|wrong|issue|mistake/)) return { text: s.issues.length ? s.issues.map((i, k) => `${k + 1}. ${i.title}: ${i.fix}`).join('\n') : 'No paper imported.', act: false }
  return { text: 'No offline answer for that. Connect an AI provider in backend/.env for open questions, or type help.', act: false }
}
