import { create } from 'zustand'
import {
  type Design, type Metrics, PAPER_FIXED, setGoal, VARS, METRICS, curve, effectMatrix, excitation, fromEquations, goalMet, metrics, sensAt, tuneStep, zin,
} from './model'
import { type Metric, type Param, BASE_METRICS, BASE_PARAMS } from './effects'
import { ARRAY_ISSUES, type ArrayDesign, type ArrayMetrics, F0, PAPER_ARRAY, PAPER_ELEMENT, SCAN_MAX, arrayGoalMet, arrayMetrics, beam, glFreeScan, lambda } from './arrayModel'
import { holdBuildSound, playBuildSound, preloadBuildSound, releaseBuildSound, stopBuildSound } from './sound'

export type Phase = 'empty' | 'reading' | 'built' | 'solving' | 'solved' | 'tuning' | 'done'
export type Tab = 'paper' | 'model' | 'summary' | 'compare' | 'results' | 'explore'

export interface Run { n: number; d: Design; m: Metrics; label: string; sim: number; a?: ArrayDesign; am?: ArrayMetrics }
export interface Act { label: string; do: () => void; primary?: boolean }
export interface Msg { id: number; who: 'user' | 'solver'; text: string; at: number; attach?: string; list?: string[]; acts?: Act[] }
export interface Issue { title: string; fix: string }

// The demo runs on its own clock so Stop can freeze every step: reading, building, solving and tuning all advance
// with now(), so holding it still holds them still, and Resume carries on from the same instant.
const wall = () => performance.now() / 1000
let heldTotal = 0
let heldSince: number | null = null
export const now = () => (heldSince ?? wall()) - heldTotal
const release = () => { if (heldSince !== null) { heldTotal += wall() - heldSince; heldSince = null } }

export const READ_SECS = 6.4
/** Seconds of 'reading' before the model starts flying together, by where the design came from. */
export const readDur = (src: 'paper' | 'text' | 'cad' | null) => (src === 'paper' ? READ_SECS : src === 'cad' ? 0.5 : 2.4)
export { BUILD_SECS } from './timing'
import { BUILD_SECS } from './timing'
export const SOLVE_SECS = 7.5
export const VERIFY_SECS = 2.4
export const TUNE_SECS = 2.2

export const PAPER_ISSUES: Issue[] = [
  { title: 'Patch is wider than the board', fix: 'Table 1: patch 39.19 mm, substrate 38.48 mm. Used eq. (6), W + 6h = 48.19 mm.' },
  { title: 'εr = 4.08 is the effective value', fix: "That's FR-4's effective permittivity, not the material's. Used 4.4." },
  { title: 'Height disagrees', fix: 'Text says 1.6 mm, Table 1 says 1.5 mm. Used 1.5 mm.' },
  { title: 'Feed line is about 85 Ω', fix: 'A 1.0 mm line on this board is not 50 Ω. Widened it to 2.9 mm.' },
]

interface State {
  phase: Phase
  phaseAt: number
  solveKind: 'first' | 'verify'
  tab: Tab
  pdf: { name: string; data: ArrayBuffer; pages: number; known?: boolean; paper?: 'patch' | 'array' | null } | null
  kind: 'patch' | 'array' // what's being designed: one antenna, or a phased array of them
  arr: ArrayDesign
  pdfSent: boolean
  source: 'paper' | 'text' | 'cad' | null
  screen: 'home' | 'modeler' | 'flow'
  modelerChat: ((text: string) => void) | null
  design: Design
  issues: Issue[]
  runs: Run[]
  shown: { from: number[]; at: number }
  paused: boolean
  nextRunAt: number
  msgs: Msg[]
  sel: { v: number; m: number }
  feedFocusAt: number
  flash: Partial<Record<keyof Design, number>>
  draft: string
  sound: boolean
  buildSoundFor: number // phaseAt of the build the sound already played for
  fq: number | null // frequency for "S11 at f" and the field view; null = the current resonance
  customParams: Param[]
  customMetrics: Metric[]
  geoMetric: 'sel' | 's11f' // geometry view follows the selected matrix metric, or shows S11 at the slider frequency
}

interface Actions {
  attach: (f: File) => Promise<void>
  send: (text: string) => void
  say: (text: string, extra?: Partial<Msg>) => void
  setTab: (t: Tab) => void
  solve: () => void
  tune: () => void
  togglePause: () => void
  takeOver: () => void
  setVar: (k: keyof Design, v: number) => void
  setDesign: (d: Partial<Design>) => void
  select: (v: number, m: number) => void
  selectParam: (v: number) => void // pick a parameter without touching which metric is shown
  setDraft: (s: string) => void
  setArr: (p: Partial<ArrayDesign>) => void
  setFq: (f: number | null) => void
  setGeoMetric: (id: string) => void
  addParam: (p: Param) => void
  addMetric: (m: Metric) => void
  removeParam: (id: string) => void
  removeMetric: (id: string) => void
  tick: (t: number) => void
  reset: () => void
  setScreen: (s: State['screen']) => void
  startFromModel: (d: Design, notes: string[]) => void
  toggleSound: () => void
}

let ids = 1
const fmt = (v: number, n = 2) => v.toFixed(n)
const SIM_FIRST = 94, SIM_RUN = 31

const initial = (): State => ({
  phase: 'empty', phaseAt: 0, solveKind: 'first', tab: 'paper', pdf: null, pdfSent: false, source: null, screen: 'home', modelerChat: null, kind: 'patch', arr: PAPER_ARRAY,
  design: PAPER_FIXED, issues: [], runs: [], shown: { from: [], at: 0 }, paused: false, nextRunAt: 0, msgs: [],
  sel: { v: 2, m: 3 }, feedFocusAt: -99, flash: {}, draft: '', sound: true, buildSoundFor: -1, fq: null, customParams: [], customMetrics: [], geoMetric: 'sel',
})

export const useDemo = create<State & Actions>((set, get) => {
  const push = (m: Omit<Msg, 'id' | 'at'> & { at?: number }) => set((s) => ({ msgs: [...s.msgs, { id: ids++, at: now(), ...m }] }))
  const say = (text: string, extra: Partial<Msg> = {}) => push({ who: 'solver', text, ...extra })
  const addRun = (d: Design, label: string, sim: number) => {
    const s = get()
    set({ shown: { from: s.runs.length ? curve(s.runs[s.runs.length - 1].d) : curve(d).map(() => 0), at: now() } })
    const a = s.kind === 'array' ? get().arr : undefined
    const run: Run = { n: s.runs.length + 1, d, m: metrics(d), label, sim, ...(a ? { a, am: arrayMetrics(d, a) } : {}) }
    set({ runs: [...s.runs, run], design: d })
    return run
  }
  const flashKeys = (keys: (keyof Design)[]) => set((s) => ({ flash: { ...s.flash, ...Object.fromEntries(keys.map((k) => [k, now()])) } }))

  const startBuild = () => {
    preloadBuildSound()
    const pdf = get().pdf
    if (pdf?.paper === 'array') {
      setGoal(2.42, 2.44, '20 MHz ISM channel')
      set({ kind: 'array', arr: PAPER_ARRAY, phase: 'reading', phaseAt: now(), source: 'paper', design: PAPER_ELEMENT, tab: 'paper' })
      say('Reading it. The unit cell is in Table I and Fig. 1, the 4×4 layout in Fig. 2, and the steering results in Fig. 5.')
      return
    }
    setGoal(2.4, 2.48, 'Wi-Fi / BLE')
    set({ kind: 'patch' })
    const usePaper = !!pdf?.known
    const d = usePaper ? PAPER_FIXED : fromEquations()
    set({ phase: 'reading', phaseAt: now(), source: usePaper ? 'paper' : 'text', design: d, tab: usePaper ? 'paper' : 'model' })
    if (usePaper) say('Reading it. The dimensions are in Table 1, the feed layout is in Fig. 3.')
    else if (pdf) say("I couldn't find a dimensions table in this paper, so I worked the dimensions out from the standard patch equations for 2.40 to 2.48 GHz on 1.6 mm FR-4.")
    else say('No paper, so I worked the dimensions out from the standard patch equations for that band on 1.6 mm FR-4.')
  }

  const intents: [RegExp, () => void][] = [
    [/^(yes|yep|sure|do it|run it|go ahead|ok)\b/, () => {
      const last = [...get().msgs].reverse().find((m) => m.who === 'solver' && m.acts?.length)
      if (last?.acts?.[0]) last.acts[0].do(); else say('Nothing is waiting on a yes right now.')
    }],
    [/(feed|inset).*(length|move|moving|chang)|(length).*(feed|inset)/, () => {
      set({ tab: 'explore', geoMetric: 'sel', sel: { v: 2, m: 3 }, feedFocusAt: now() })
      say("The inset's resistance depends on how deep it sits relative to the patch length, not on its absolute depth. Shorten the patch and the same inset is effectively deeper, so the match drifts. That's why every length change came with an inset change, and why the runs walk diagonally across the map.")
    }],
    [/bandwidth|wider band|broader|more band/, () => {
      const d = get().design
      const m0 = metrics(d), t = tuneStep({ ...d, h: 2.4 }, 1)
      const m1 = metrics(tuneStep(t, 1))
      set({ tab: 'explore', geoMetric: 'sel', sel: { v: 3, m: 1 } })
      say(`Substrate height is the biggest lever that leaves the footprint alone. Going from ${fmt(d.h, 1)} to 2.4 mm takes you from about ${m0.bw.toFixed(0)} to ${m1.bw.toFixed(0)} MHz, and gain goes up ${(m1.gain - m0.gain).toFixed(1)} dB. I'd have to re-tune length and inset afterwards. Want me to run it?`, {
        acts: [{ label: 'Run it', primary: true, do: () => { get().setDesign({ h: 2.4 }); get().tune() } }, { label: 'Not now', do: () => say('Okay. It stays at the current height.') }],
      })
    }],
    [/which part|where.*(matter|sensitiv)|sensitiv|capacit|inductiv|edge/, () => {
      const d = get().design
      const f = /top|upper|2\.48|high/.test(get().msgs[get().msgs.length - 1]?.text.toLowerCase() ?? '') ? 2.48 : /bottom|lower|2\.40|low/.test(get().msgs[get().msgs.length - 1]?.text.toLowerCase() ?? '') ? 2.4 : metrics(d).f0
      const sv = sensAt(f, d).map(Math.abs), tot = sv.reduce((a, b) => a + b, 0) || 1
      const order = sv.map((v, k) => ({ k, p: v / tot })).sort((a, b) => b.p - a.p)
      const where = ['the two radiating edges (patch length)', 'the side edges (patch width)', 'the inset notch', 'the board thickness', 'the board material', 'the ground edge']
      const z = zin(f, d)
      set({ tab: 'explore', fq: f, geoMetric: 's11f', sel: { v: order[0].k, m: 2 } })
      say(`At ${f.toFixed(2)} GHz, ${Math.round(order[0].p * 100)}% of what moves S11 is ${where[order[0].k]}, then ${where[order[1].k]} at ${Math.round(order[1].p * 100)}%. The ends of the patch hold the charge, so they act like a capacitor; the middle carries the current, so it acts like an inductor. Here the input looks ${z.x >= 0 ? 'inductive' : 'capacitive'} (${z.r.toFixed(0)} ${z.x >= 0 ? '+' : '−'} j${Math.abs(z.x).toFixed(0)} Ω)${excitation(f, d) < 0.5 ? ', and the patch is only weakly excited this far from resonance' : ''}. Drag the frequency under the model to watch it shift.`)
    }],
    [/why.*(plan|way|fast|quick|that order|solver|method)|how.*(solv|fast)|brute|which solver|boundar|mesh/, () => {
      if (get().runs.length) set({ tab: 'results' })
      say("I used frequency-domain finite elements: it's exact at each frequency for one narrow resonance, and it models the real, finite board, which matters because ground size moves gain. Planar method of moments would assume an infinite ground; time domain would spend most of its time waiting for the resonance to ring down. Then I took a rough look everywhere and spent the fine mesh and the dense sweep only where the answer was still moving, solved half the board using its mirror symmetry, and got the 281-point sweep from 4 full solves. 1:34 instead of about 25 minutes. Every detail, including the boundaries, is in How I solved it on the Results tab.")
    }],
    [/paper|wrong|issue|mistake|table|didn.?t add/, () => {
      set({ tab: 'paper' })
      say('Four things in the paper don\'t hold together:', { list: get().issues.length ? get().issues.map((i) => `${i.title}. ${i.fix}`) : PAPER_ISSUES.map((i) => `${i.title}. ${i.fix}`) })
    }],
    [/2\.3|low|resonan|frequency|off/, () => get().source !== 'paper' ? (set({ tab: 'explore', geoMetric: 'sel', sel: { v: 0, m: 0 } }), say(`Resonance is set almost entirely by patch length and the board's permittivity: a 5% longer patch drops it by about 110 MHz. It's at ${metrics(get().design).f0.toFixed(3)} GHz now. The equations don't account for the inset slots, which is why the first build came out a little off.`)) : say(`The paper lists εr = 4.08, which is FR-4's effective permittivity. If you simulate with 4.08 as the material you get 2.40 GHz, which is probably what the authors did. Real FR-4 is about 4.4, and that pulls the resonance down to ${(metrics(PAPER_FIXED).f0).toFixed(2)} GHz.`)],
    [/smaller|shrink|compact|size/, () => { set({ tab: 'explore', geoMetric: 'sel', sel: { v: 4, m: 0 } }); say('Higher permittivity shrinks it. Going from 4.4 to 6.15 cuts the length by about 15%, but you lose roughly a third of the bandwidth and about 0.8 dB of gain. Patch length is fixed by the band you want, so the board is the only real knob.') }],
    [/gain/, () => { set({ tab: 'explore', geoMetric: 'sel', sel: { v: 5, m: 4 } }); say(`It's at ${metrics(get().design).gain.toFixed(1)} dBi. A bigger ground plane helps most per millimetre, then a thicker board. Width helps a little. The match barely notices any of them.`) }],
    [/tune|optimi|fix it|hit|meet|goal/, () => get().tune()],
    [/solve|simulate|run/, () => get().solve()],
  ]

  // questions a phased-array designer asks, answered from the array model on the current design
  const arrayIntents: [RegExp, () => void][] = [
    [/paper|wrong|issue|mistake|didn.?t add/, () => { set({ tab: 'paper' }); say('Four things in the paper need care:', { list: ARRAY_ISSUES.map((i) => `${i.title}. ${i.fix}`) }) }],
    [/grating|spacing|pitch|60|wider scan|further/, () => {
      const a = get().arr, L = lambda(F0), lim = glFreeScan(a, F0), d60 = L / (1 + Math.sin(Math.PI / 3))
      set({ tab: 'explore', arr: { ...a, theta: 60 } })
      say(`At ${a.dx.toFixed(0)} mm (${(a.dx / L).toFixed(2)} λ) no grating lobe appears until ${lim >= 90 ? 'beyond 90°' : `${lim.toFixed(0)}°`}, so the spacing isn't what limits the scan. To steer to 60° without one you'd need d ≤ λ/(1 + sin 60°) = ${d60.toFixed(0)} mm. What does limit it is scan loss and the active match: at 60° the element pattern and coupling cost about ${(beam(get().design, { ...a, theta: 0 }).gain - beam(get().design, { ...a, theta: 60 }).gain).toFixed(1)} dB of gain. I've pointed the array tools at 60° so you can see it.`)
    }],
    [/bit|quantis|quantiz|phase shifter/, () => {
      const a = { ...get().arr, theta: 32 }, d = get().design
      const rows = [0, 6, 5, 4, 3].map((b) => { const r = beam(d, { ...a, bits: b }); return `${b ? `${b}-bit` : 'ideal'}: ${r.gain.toFixed(1)} dBi, sidelobes ${r.sll.toFixed(1)} dB, beam at ${r.point.toFixed(1)}°` })
      set({ tab: 'explore', arr: { ...get().arr, theta: 32, bits: 4 } })
      say('Steering to 32°, by phase-shifter resolution:', { list: rows })
    }],
    [/fail|broken|dead|lose|losing/, () => {
      const a = get().arr, d = get().design, ok = beam(d, a), bad = beam(d, { ...a, failed: [5, 10] })
      set({ tab: 'explore', arr: { ...a, failed: [5, 10] } })
      say(`With two of the four centre elements dead, gain drops ${(ok.gain - bad.gain).toFixed(1)} dB and the worst sidelobe goes from ${ok.sll.toFixed(1)} to ${bad.sll.toFixed(1)} dB. Centre elements carry the most of a tapered aperture, so they hurt most. I've switched them off in the array tools; click any element to toggle it.`)
    }],
    [/squint|true.?time|ttd|delay|wideband|bandwidth/, () => {
      const a = { ...get().arr, theta: 32 }, d = get().design
      const at = (f: number, ttd: boolean) => beam(d, { ...a, f, ttd }).point.toFixed(1)
      set({ tab: 'explore', arr: { ...get().arr, theta: 32 } })
      say(`Phase shifters are set for ${F0} GHz, so the beam moves with frequency: steered to 32°, it points at ${at(2.3, false)}° at 2.30 GHz and ${at(2.56, false)}° at 2.56 GHz. True-time delay keeps it at ${at(2.3, true)}° and ${at(2.56, true)}°. Over this 20 MHz channel the squint is under half a degree, so phase shifters are fine here.`)
    }],
    [/taper|sidelobe|side lobe|taylor|chebyshev/, () => {
      const a = { ...get().arr, theta: 32 }, d = get().design
      const rows = (['uniform', 'taylor', 'cheb'] as const).map((tp) => { const r = beam(d, { ...a, taper: tp, sll: 25 }); return `${tp === 'cheb' ? 'Chebyshev −25 dB' : tp === 'taylor' ? 'Taylor −25 dB' : 'Uniform'}: sidelobes ${r.sll.toFixed(1)} dB, gain ${r.gain.toFixed(1)} dBi, beamwidth ${r.hpbw.toFixed(1)}°` })
      set({ tab: 'explore' })
      say('Steering to 32°, by amplitude taper. With only four elements per side a taper buys a lot of sidelobe for a little gain:', { list: rows })
    }],
    [/point|accura|where.*beam|42/, () => {
      const r = beam(get().design, { ...get().arr, theta: 42 })
      set({ tab: 'explore', arr: { ...get().arr, theta: 42 } })
      say(`Commanded to 42°, the beam peaks at ${r.point.toFixed(1)}°. With only four elements the array factor is broad, and the element pattern falls off with angle, so the product leans back toward broadside. Steer to about ${(42 + (42 - r.point)).toFixed(0)}° to land at 42°, or calibrate the pointing table.`)
    }],
  ]

  const whatDoes = (text: string) => {
    const i = VARS.findIndex((v) => text.includes(v.name.toLowerCase()) || text.includes(v.name.toLowerCase().replace('patch ', '').replace('substrate ', '')))
    if (i < 0 || !/what|does|effect|do\b|matter/.test(text)) return false
    const row = effectMatrix(get().design)[i]
    const order = row.map((c, j) => ({ j, k: c.size / scaleOf(j) })).sort((a, b) => b.k - a.k)
    const top = order.slice(0, 2).map(({ j }) => `${METRICS[j].name.toLowerCase()} (${row[j].up >= 0 ? '+' : ''}${METRICS[j].fmt(row[j].up / (j === 0 ? 1000 : 1))} ${METRICS[j].unit} for +5%)`)
    set({ tab: 'explore', geoMetric: 'sel', sel: { v: i, m: order[0].j } })
    say(`${VARS[i].name} mostly moves ${top.join(' and ')}. Everything else barely notices it. I've opened that cell in the map.`)
    return true
  }
  const scaleOf = (j: number) => [60, 30, 4, 20, 0.4][j]

  return {
    ...initial(),
    say,
    setDraft: (draft) => set({ draft }),
    setFq: (fq) => set({ fq }),
    setGeoMetric: (id) => {
      if (id === 's11f') return set({ geoMetric: 's11f' })
      const j = allMetrics(get()).findIndex((m) => m.id === id)
      if (j >= 0) set({ geoMetric: 'sel', sel: { v: get().sel.v, m: j } })
    },
    addParam: (p) => {
      set((s) => ({ customParams: [...s.customParams.filter((x) => x.id !== p.id), p] }))
      set((s) => ({ sel: { v: allParams(s).findIndex((x) => x.id === p.id), m: s.sel.m } }))
    },
    addMetric: (m) => {
      set((s) => ({ customMetrics: [...s.customMetrics.filter((x) => x.id !== m.id), m] }))
      set((s) => ({ geoMetric: 'sel', sel: { v: s.sel.v, m: allMetrics(s).findIndex((x) => x.id === m.id) } }))
    },
    removeParam: (id) => set((s) => {
      const customParams = s.customParams.filter((x) => x.id !== id)
      return { customParams, sel: { v: Math.min(s.sel.v, BASE_PARAMS.length + customParams.length - 1), m: s.sel.m } }
    }),
    removeMetric: (id) => set((s) => {
      const customMetrics = s.customMetrics.filter((x) => x.id !== id)
      return { customMetrics, sel: { v: s.sel.v, m: Math.min(s.sel.m, BASE_METRICS.length + customMetrics.length - 1) } }
    }),
    setTab: (tab) => set({ tab }),
    selectParam: (v) => set((s) => ({ sel: { v, m: s.sel.m } })),
    select: (v, m) => set(() => ({ sel: { v, m }, geoMetric: 'sel', ...(VARS[v]?.key === 'y0' ? { feedFocusAt: now() } : {}) })),

    attach: async (f) => {
      const data = await f.arrayBuffer()
      set({ pdf: { name: f.name, data, pages: 0 }, pdfSent: false, tab: 'paper' })
      preloadBuildSound()
    },

    send: (raw) => {
      const text = raw.trim()
      if (!text) return
      const s = get()
      if (s.screen === 'modeler' && s.phase === 'empty' && s.modelerChat) {
        push({ who: 'user', text }); set({ draft: '' })
        const fn = s.modelerChat
        setTimeout(() => fn(text), 450)
        return
      }
      push({ who: 'user', text, attach: s.pdf && !s.pdfSent ? s.pdf.name : undefined })
      set({ pdfSent: true, draft: '' })
      const lc = text.toLowerCase()
      setTimeout(() => {
        const st = get()
        if (st.phase === 'empty') return startBuild()
        if (st.phase === 'reading' || st.phase === 'solving') return say("Give me a second, I'm still on the last step.")
        if (st.kind === 'array') for (const [re, fn] of arrayIntents) if (re.test(lc)) return fn()
        if (whatDoes(lc)) return
        for (const [re, fn] of intents) if (re.test(lc)) return fn()
        say("I don't have an answer for that in this build. Try asking what one part of the design does, why a number changed, or how to get more bandwidth.")
      }, 450)
    },

    solve: () => {
      if (get().paused) { release(); set({ paused: false }) }
      const s = get()
      if (s.phase === 'empty' || s.phase === 'reading' || s.phase === 'solving' || s.phase === 'tuning') return
      const first = s.runs.length === 0
      set({ phase: 'solving', phaseAt: now(), solveKind: first ? 'first' : 'verify', tab: 'results' })
      if (first) say('Rough pass first, then I only spend effort where the answer is still moving. About a minute and a half instead of 25.')
    },

    tune: () => {
      if (get().paused) { release(); set({ paused: false }) }
      const s = get()
      if (s.phase === 'solving' || s.phase === 'reading' || s.phase === 'empty') return
      if (!s.runs.length) { s.solve(); return }
      set({ phase: 'tuning', phaseAt: now(), paused: false, nextRunAt: now() + 1.2, tab: 'results' })
      if (get().kind === 'array') say("Optimising: first the element's length and inset, then the spacing to cut coupling while it steers, then a taper for the sidelobes. You don't need to watch this.", { acts: [{ label: 'Stop / resume', do: () => get().togglePause() }, { label: 'Take over', do: () => get().takeOver() }] })
      else say("Adjusting patch length and inset depth until the whole band is under −10 dB. You don't need to watch this. I'll tell you when it's done.", {
        acts: [{ label: 'Stop / resume', do: () => get().togglePause() }, { label: 'Take over', do: () => get().takeOver() }],
      })
    },

    togglePause: () => {
      const s = get()
      if (s.paused) { release(); set({ paused: false }); releaseBuildSound(); return }
      if (s.phase !== 'reading' && s.phase !== 'solving' && s.phase !== 'tuning') return
      heldSince = wall(); set({ paused: true }); holdBuildSound()
    },

    takeOver: () => {
      if (get().phase !== 'tuning') return
      release(); releaseBuildSound()
      set({ phase: 'solved', paused: false })
      flashKeys(['L', 'y0'])
      say("Stopped. The sliders on the left are yours. I'll show a quick estimate as you drag; press Solve to check it properly.")
    },

    setVar: (k, v) => {
      const s = get()
      if (s.phase === 'empty' || s.phase === 'reading') return
      set({ design: { ...s.design, [k]: v } })
    },
    setDesign: (p) => {
      const s = get()
      set({ design: { ...s.design, ...p } })
      flashKeys(Object.keys(p) as (keyof Design)[])
    },

    tick: (t) => {
      const s = get()
      if (s.phase === 'reading') {
        const dur = readDur(s.source)
        if (s.source === 'paper' && s.tab === 'paper' && t - s.phaseAt > dur - 0.6) set({ tab: 'model' })
        // the pieces start flying in: clicks while they land, the minikit jingle when the last one does
        if (t - s.phaseAt >= dur && s.buildSoundFor !== s.phaseAt) {
          set({ buildSoundFor: s.phaseAt })
          if (s.sound && t - s.phaseAt - dur < 0.5) playBuildSound(t - s.phaseAt - dur)
        }
        if (t - s.phaseAt > dur + BUILD_SECS) {
          set({ phase: 'built', phaseAt: t, issues: s.kind === 'array' ? ARRAY_ISSUES : s.source === 'paper' ? PAPER_ISSUES : [], tab: 'model' })
          if (s.kind === 'array') say(`Built the 4×4 array from Table I and Fig. 2: 16 inset-fed patches on a ${fmt(s.arr.dx, 0)} mm pitch (${(s.arr.dx / lambda(2.43)).toFixed(2)} λ) on 1.27 mm Rogers 6010.2LM. Four things in the paper need care:`, {
            list: ARRAY_ISSUES.map((i) => `${i.title}. ${i.fix}`),
            acts: [{ label: 'Solve', primary: true, do: () => get().solve() }],
          })
          else if (s.source === 'paper') say('Built it from Table 1, eq. (6) and Fig. 3. Four things in the paper didn\'t add up, so I fixed them:', {
            list: PAPER_ISSUES.map((i) => `${i.title}. ${i.fix}`),
            acts: [{ label: 'Solve', primary: true, do: () => get().solve() }],
          })
          else if (s.source === 'cad') say(`Built from your model: ${fmt(s.design.W)} × ${fmt(s.design.L)} mm patch on ${fmt(s.design.h)} mm, εr ${fmt(s.design.er)}, inset ${fmt(s.design.y0)} mm. Ready to solve.`, { acts: [{ label: 'Solve', primary: true, do: () => get().solve() }] })
          else say(`Built: ${fmt(s.design.W)} × ${fmt(s.design.L)} mm patch, inset ${fmt(s.design.y0)} mm. Ready to solve.`, { acts: [{ label: 'Solve', primary: true, do: () => get().solve() }] })
        }
      } else if (s.phase === 'solving') {
        const dur = s.solveKind === 'first' ? SOLVE_SECS : VERIFY_SECS
        if (t - s.phaseAt > dur) {
          const run = addRun(s.design, s.solveKind === 'first' ? (s.kind === 'array' ? 'Paper, inset feed' : s.source === 'paper' ? 'Paper, real FR-4' : 'From equations') : 'Your edit', s.solveKind === 'first' ? SIM_FIRST : SIM_RUN)
          const met = run.am ? arrayGoalMet(run.am) : goalMet(run.m)
          set({ phase: met ? 'done' : 'solved', phaseAt: t, tab: 'summary' }) // the executive summary comes first
          if (run.am) {
            const am = run.am
            if (met) say(`It meets the goal: worst active match ${am.activeWorst.toFixed(1)} dB over ±${SCAN_MAX}°, sidelobes ${am.sllWorst.toFixed(1)} dB.`, { acts: [{ label: 'Open Explore', do: () => set({ tab: 'explore' }) }] })
            else say(`Solved the unit cell and the full 4×4. With the inset feed from Table I the element is only matched to ${run.m.worst.toFixed(1)} dB (the paper's −25 dB was the coax feed). While steering, the worst active match is ${am.activeWorst.toFixed(1)} dB, and sidelobes reach ${am.sllWorst.toFixed(1)} dB at ${SCAN_MAX}°. Broadside gain ${am.gain0.toFixed(1)} dBi. It misses the goal. Want me to optimise it?`, { acts: [{ label: 'Optimise it', primary: true, do: () => get().tune() }] })
            return
          }
          if (goalMet(run.m)) say(`That covers the band. Worst case ${run.m.worst.toFixed(1)} dB between 2.40 and 2.48 GHz.`, { acts: [{ label: 'Open Explore', do: () => set({ tab: 'explore' }) }] })
          else if (s.solveKind === 'first' && s.source === 'paper') say(`With real FR-4 it resonates at ${run.m.f0.toFixed(2)} GHz, not the 2.40 the paper reports, and the best match is only ${run.m.min.toFixed(1)} dB. It misses your band. How I solved it (method, boundaries, mesh, speed-ups) is on the right. Want me to tune it?`, { acts: [{ label: 'Tune it', primary: true, do: () => get().tune() }] })
          else say(`Resonance ${run.m.f0.toFixed(3)} GHz, worst in-band ${run.m.worst.toFixed(1)} dB. Not there yet. Want me to tune it?`, { acts: [{ label: 'Tune it', primary: true, do: () => get().tune() }] })
        }
      } else if (s.phase === 'tuning' && !s.paused && t >= s.nextRunAt && s.kind === 'array') {
        // element length and inset first, then open the spacing to cut coupling, then taper the sidelobes down
        const n = s.runs.filter((r) => r.label.startsWith('Optimise')).length + 1
        const d = tuneStep(s.design, n === 1 ? 0.45 : 0.6)
        const pitch = [50, 53, 55, 56, 56, 56][Math.min(5, n - 1)]
        set({ arr: { ...s.arr, dx: pitch, dy: pitch, taper: n >= 3 ? 'taylor' : s.arr.taper, sll: 25 } })
        const run = addRun(d, `Optimise ${n}`, SIM_RUN)
        flashKeys(['L', 'y0'])
        if ((run.am && arrayGoalMet(run.am)) || n >= 6) {
          set({ phase: 'done', phaseAt: t, tab: 'summary' })
          const am = run.am!, first = get().runs[0]
          say(`Done after ${get().runs.length} runs. It now steers to ±${SCAN_MAX}° with the worst active match at ${am.activeWorst.toFixed(1)} dB and sidelobes at ${am.sllWorst.toFixed(1)} dB. I re-centred the element (length ${fmt(first.d.L)} → ${fmt(d.L)} mm, inset ${fmt(first.d.y0)} → ${fmt(d.y0)} mm), opened the pitch from ${fmt(first.a!.dx, 0)} to ${fmt(pitch, 0)} mm (${(pitch / lambda(2.43)).toFixed(2)} λ) to cut coupling, and added a Taylor taper for the sidelobes.`, {
            acts: [{ label: 'Open the array tools', primary: true, do: () => set({ tab: 'explore' }) }],
          })
        } else set({ nextRunAt: t + TUNE_SECS })
      } else if (s.phase === 'tuning' && !s.paused && t >= s.nextRunAt) {
        const first = s.runs.filter((r) => r.label.startsWith('Tune')).length === 0
        const d = tuneStep(s.design, first ? 0.45 : 0.6)
        const n = s.runs.filter((r) => r.label.startsWith('Tune')).length + 1
        const run = addRun(d, `Tune ${n}`, SIM_RUN)
        flashKeys(['L', 'y0'])
        if (goalMet(run.m) && run.m.worst < -11.5 || n >= 6) {
          set({ phase: 'done', phaseAt: t, tab: 'summary' })
          const total = get().runs.length
          say(`Done after ${total} runs. 2.40 to 2.48 GHz is covered, worst case ${run.m.worst.toFixed(1)} dB. Length ${fmt(d.L)} mm, inset ${fmt(d.y0)} mm.`, {
            acts: [{ label: 'Open Explore', primary: true, do: () => set({ tab: 'explore' }) }],
          })
        } else set({ nextRunAt: t + TUNE_SECS })
      }
    },

    reset: () => { ids = 1; release(); stopBuildSound(); setGoal(2.4, 2.48, 'Wi-Fi / BLE'); set({ ...initial(), sound: get().sound, modelerChat: get().modelerChat }) },
    setArr: (p) => set((s) => ({ arr: { ...s.arr, ...p } })),
    setScreen: (screen) => set({ screen }),
    startFromModel: (d, notes) => {
      preloadBuildSound()
      set({ design: d, phase: 'reading', phaseAt: now(), source: 'cad', tab: 'model', screen: 'flow', pdf: null, pdfSent: true })
      say(notes[0], notes.length > 1 ? { list: notes.slice(1) } : {})
    },
    toggleSound: () => { const on = !get().sound; if (!on) stopBuildSound(); set({ sound: on }) },
  }

})


export const curveOfRun = (r: Run) => curve(r.d)

/** Every parameter and every matrix metric, built-in first, so indices into the built-in lists stay valid. */
export const allParams = (s: { customParams: Param[] }) => [...BASE_PARAMS, ...s.customParams]
export const allMetrics = (s: { customMetrics: Metric[] }) => [...BASE_METRICS, ...s.customMetrics]
