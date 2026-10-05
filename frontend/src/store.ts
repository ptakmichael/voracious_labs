import { create } from 'zustand'
import type { ChatMsg, GeoObject, Project, RunEvent, Stage } from './types'
import { STAGES } from './types'

export const BUILTIN_MATERIALS = [
  { name: 'vacuum', eps_r: 1.0, tan_d: 0, kind: 'dielectric' },
  { name: 'air', eps_r: 1.0006, tan_d: 0, kind: 'dielectric' },
  { name: 'pec', eps_r: 1, tan_d: 0, kind: 'pec' },
  { name: 'copper', eps_r: 1, tan_d: 0, kind: 'pec', sigma: 5.8e7 },
  { name: 'fr4', eps_r: 4.4, tan_d: 0.02, kind: 'dielectric' },
  { name: 'ro4003c', eps_r: 3.38, tan_d: 0.0027, kind: 'dielectric' },
  { name: 'rt5880', eps_r: 2.2, tan_d: 0.0009, kind: 'dielectric' },
  { name: 'ro3010', eps_r: 10.2, tan_d: 0.0022, kind: 'dielectric' },
  { name: 'alumina', eps_r: 9.8, tan_d: 0.0001, kind: 'dielectric' },
] as const

export function defaultProject(): Project {
  // The default 2.4 GHz patch, sized from the design equations for f0 = 2.44 GHz on RO4003C.
  const h = 1.524
  return {
    name: 'patch_2g4',
    objects: [
      { id: 'substrate', name: 'Substrate', kind: 'box', role: 'substrate', material: 'ro4003c', pos: [0, 0, h / 2], size: [62.46, 71.0, h], color: '#b9cdb4' },
      { id: 'ground', name: 'Ground plane', kind: 'sheet', role: 'ground', material: 'pec', pos: [0, 0, 0], size: [62.46, 71.0, 0], color: '#9aa6b8' },
      { id: 'patch', name: 'Patch', kind: 'sheet', role: 'patch', material: 'pec', pos: [0, 0, h], size: [32.98, 41.51, 0], color: '#d9a03f' },
      { id: 'port1', name: 'Port 1', kind: 'port', role: 'port', material: 'pec', pos: [-5.44, 0, h / 2], size: [1, 0, h], impedance: 50, color: '#c2541e' },
    ],
    materials: [],
    boundary: { type: 'radiation', padding: 'auto' },
    settings: { f_start: 2.0, f_stop: 3.0, n_points: 201, accuracy: 'standard', sweep: 'adaptive', plots: ['s11', 'smith'], autonomy: 'balanced' },
    goal: { threshold_db: -10, f1: 2.4, f2: 2.48 },
    constraints: { length_pct: 10, feed_free: true },
  }
}

function loadProject(): Project {
  try {
    const s = localStorage.getItem('emsolver.project')
    if (s) return JSON.parse(s)
  } catch {
    /* ignore */
  }
  return defaultProject()
}

export interface RunView {
  id: string | null
  stage: Stage
  maxStage: number
  state: string
  events: RunEvent[]
  logs: { t: number; text: string; level: string; you?: boolean }[]
  features: any
  selection: any
  plan: any
  awaiting: any | null
  countdownEnd: number | null
  subrun: any
  progress: any
  partial: { f: number[]; s: number[] } | null
  convergence: { kind: string; value: number }[]
  verifications: any[]
  fixes: any[]
  goalCheck: any
  proposal: any
  history: any[]
  results: any
  finished: boolean
  status: string | null
  error: string | null
}

const emptyRun = (): RunView => ({
  id: null, stage: 'setup', maxStage: 0, state: 'draft', events: [], logs: [], features: null, selection: null,
  plan: null, awaiting: null, countdownEnd: null, subrun: null, progress: null, partial: null, convergence: [],
  verifications: [], fixes: [], goalCheck: null, proposal: null, history: [], results: null, finished: false,
  status: null, error: null,
})

interface Store {
  project: Project
  selectedId: string | null
  view: Stage
  followRun: boolean
  speed: number
  caps: any
  run: RunView
  chat: ChatMsg[]
  setProject: (fn: (p: Project) => Project) => void
  replaceProject: (p: Project) => void
  updateObject: (id: string, patch: Partial<GeoObject>) => void
  select: (id: string | null) => void
  setView: (s: Stage, manual?: boolean) => void
  setSpeed: (n: number) => void
  setCaps: (c: any) => void
  resetRun: (id: string | null) => void
  applyEvent: (e: RunEvent) => void
  pushChat: (m: ChatMsg) => void
  past: GeoSnap[]
  future: GeoSnap[]
  lastEdit: number
  undo: () => void
  redo: () => void
}

type GeoSnap = Pick<Project, 'objects' | 'materials'>
const HISTORY_LIMIT = 100
const COALESCE_MS = 600 // rapid edits (typing a dimension, nudging a value) become one undo step

export const useStore = create<Store>((set, get) => ({
  project: loadProject(),
  selectedId: 'patch',
  view: 'setup',
  followRun: true,
  speed: 1.5,
  caps: null,
  run: emptyRun(),
  chat: [{ role: 'solver', text: 'Build or import your geometry, set your goals, and press Run. I’ll explain every choice as I go.' }],

  past: [],
  future: [],
  lastEdit: 0,

  setProject: (fn) => set((s) => {
    const p = fn(s.project)
    try { localStorage.setItem('emsolver.project', JSON.stringify(p)) } catch { /* ignore */ }
    if (p.objects === s.project.objects && p.materials === s.project.materials) return { project: p }
    // geometry changed: record an undo step
    const now = Date.now()
    const snap = { objects: s.project.objects, materials: s.project.materials }
    const past = now - s.lastEdit < COALESCE_MS && s.past.length ? s.past : [...s.past, snap].slice(-HISTORY_LIMIT)
    return { project: p, past, future: [], lastEdit: now }
  }),
  undo: () => set((s) => {
    const prev = s.past[s.past.length - 1]
    if (!prev) return {}
    const project = { ...s.project, ...prev }
    try { localStorage.setItem('emsolver.project', JSON.stringify(project)) } catch { /* ignore */ }
    return {
      project, past: s.past.slice(0, -1), lastEdit: 0,
      future: [{ objects: s.project.objects, materials: s.project.materials }, ...s.future],
      selectedId: project.objects.some((o) => o.id === s.selectedId) ? s.selectedId : null,
    }
  }),
  redo: () => set((s) => {
    const next = s.future[0]
    if (!next) return {}
    const project = { ...s.project, ...next }
    try { localStorage.setItem('emsolver.project', JSON.stringify(project)) } catch { /* ignore */ }
    return {
      project, future: s.future.slice(1), lastEdit: 0,
      past: [...s.past, { objects: s.project.objects, materials: s.project.materials }],
      selectedId: project.objects.some((o) => o.id === s.selectedId) ? s.selectedId : null,
    }
  }),
  replaceProject: (p) => get().setProject(() => p),
  updateObject: (id, patch) => get().setProject((p) => ({
    ...p, objects: p.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)),
  })),
  select: (id) => set({ selectedId: id }),
  setView: (v, manual) => set((s) => ({ view: v, followRun: manual ? v === s.run.stage : s.followRun })),
  setSpeed: (n) => set({ speed: n }),
  setCaps: (c) => set({ caps: c }),
  resetRun: (id) => set({ run: { ...emptyRun(), id, stage: id ? 'analyze' : 'setup', maxStage: id ? 1 : 0, state: id ? 'building' : 'draft' }, followRun: true }),
  pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),

  applyEvent: (e) => set((s) => {
    const r: RunView = { ...s.run, events: [...s.run.events, e] }
    const p = e.payload
    const log = (text: string, level = 'info', you = false) => { r.logs = [...r.logs, { t: e.t, text, level, you }] }
    let chat = s.chat
    let view = s.view
    let project = s.project
    switch (e.type) {
      case 'stage_changed': {
        r.stage = p.stage
        r.state = p.state
        r.maxStage = Math.max(r.maxStage, STAGES.indexOf(p.stage))
        if (s.followRun) view = p.stage
        break
      }
      case 'log': log(p.text, p.level); break
      case 'features': r.features = p; break
      case 'selection': r.selection = p; break
      case 'plan': r.plan = p; break
      case 'awaiting_approval':
        r.awaiting = p
        r.countdownEnd = p.countdown_s ? Date.now() + p.countdown_s * 1000 : null
        break
      case 'hold': r.countdownEnd = null; break
      case 'approval_resolved': r.awaiting = null; r.countdownEnd = null; break
      case 'subrun_started':
        r.subrun = p
        r.progress = { percent: 0, eta_s: p.sim_total_s, stats: p.stats }
        if (p.purpose !== 'convergence') { r.partial = null; r.convergence = [] }
        break
      case 'progress': r.progress = p; break
      case 'partial_result': r.partial = { f: p.freqs_ghz, s: p.s11_db }; break
      case 'convergence_point': r.convergence = [...r.convergence, p]; break
      case 'subrun_finished': r.subrun = { ...r.subrun, finished: true, ...p }; break
      case 'verification': r.verifications = [...r.verifications, p]; break
      case 'numerical_fix': r.fixes = [...r.fixes, p]; break
      case 'goal_check': r.goalCheck = p; break
      case 'design_proposal': r.proposal = p; break
      case 'history': r.history = p.items; break
      case 'geometry_updated':
        project = { ...s.project, objects: p.objects }
        try { localStorage.setItem('emsolver.project', JSON.stringify(project)) } catch { /* ignore */ }
        break
      case 'message':
        chat = [...chat, { role: p.role, text: p.text }]
        if (p.role === 'user') log(p.text, 'info', true)
        break
      case 'error': r.error = p.message; log(p.message, 'warn'); break
      case 'run_finished':
        r.finished = true
        r.status = p.status
        r.awaiting = null
        if (p.freqs) r.results = p
        if (p.status === 'cancelled') log('Run cancelled', 'warn')
        if (p.status === 'failed') log('Run failed', 'warn')
        break
    }
    return { run: r, chat, view, project }
  }),
}))
