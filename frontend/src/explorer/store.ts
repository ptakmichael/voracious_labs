import { create } from 'zustand'
import type { RunEvent, Vec3 } from '../types'
import { exApi } from './api'

export type ResultsTab = 'summary' | 'explorer' | 'matrix' | 'exports'
export type Overlay = 'E' | 'J' | 'sens' | 'none'

export interface Handle { a: Vec3; b: Vec3; ext: Vec3[]; moves: string; dir: Vec3; via?: string }
export interface ExVar {
  name: string; kind: 'base' | 'derived'; label: string; unit: string; value: number | null
  handle?: Handle; expression?: string; hold_constant?: string[]; error?: string
  drives?: { var: string; dp_dq: number; unit: string }[]; watched?: boolean; computed?: boolean
}
export interface ExMetric {
  name: string; label: string; long: string; unit: string; kind: 'standard' | 'custom'
  delta_unit: string; delta_scale: number; impedance: boolean; na?: string; note?: string; expression?: string
}
export interface Cell {
  variable: string; metric: string; value: number | null; deriv?: number; unit?: string; per?: string
  noisy?: boolean; non_smooth?: boolean; na_reason?: string | null; method?: string; hold?: string | null
}
export interface Matrix {
  status: 'idle' | 'running' | 'done'; progress: { done: number; total: number }; cost_basis: string | null
  variables: ExVar[]; metrics: ExMetric[]; cells: Record<string, Record<string, Cell>>
  values: Record<string, { value: number | null; na_reason: string | null }>
  solver: string; fidelity: number; fd_fidelity: number; coarse_runs: number; verified_runs: number
  cost_coarse_s: number; cost_verified_s: number
  budget: number; watched: string[]; proposal: any; plan: { variables: string[]; n_runs: number; est_time_s: number; budget: number }
  predictions: any[]; trust_pct: number; autonomy: string; mock: boolean
}

export const cellKey = (v: string, m: string) => `${v}|${m}`

interface ExplorerStore {
  tab: ResultsTab
  runId: string | null
  matrix: Matrix | null
  error: string | null
  selectedVar: string | null
  colorBy: string
  overlay: Overlay
  cell: [string, string] | null
  sort: { metric: string; dir: 1 | -1 } | null
  surfaces: Record<string, any>
  targets: Record<string, any>
  verifications: Record<string, any>
  builder: 'variable' | null
  setTab: (t: ResultsTab) => void
  reset: (runId: string | null) => void
  refresh: () => Promise<void>
  onEvent: (e: RunEvent) => void
  applyUi: (ui: any) => void
  selectVar: (v: string | null) => void
  setColorBy: (m: string) => void
  setOverlay: (o: Overlay) => void
  selectCell: (v: string, m: string) => void
  setSort: (m: string) => void
  setBuilder: (b: 'variable' | null) => void
  loadSurface: (sid: string, f0?: number) => Promise<void>
  setTarget: (key: string, t: any) => void
  setVerification: (key: string, v: any) => void
}

let inflight = false
let again = false
let timer: ReturnType<typeof setTimeout> | null = null

export const useExplorer = create<ExplorerStore>((set, get) => ({
  tab: 'summary',
  runId: null,
  matrix: null,
  error: null,
  selectedVar: null,
  colorBy: 'f_res',
  overlay: 'E',
  cell: null,
  sort: null,
  surfaces: {},
  targets: {},
  verifications: {},
  builder: null,

  setTab: (t) => set({ tab: t }),
  reset: (runId) => set({ runId, matrix: null, error: null, surfaces: {}, targets: {}, verifications: {}, tab: 'summary', cell: null }),

  refresh: async () => {
    const rid = get().runId
    if (!rid) return
    if (inflight) { again = true; return }
    inflight = true
    try {
      const m = await exApi.matrix(rid)
      if (get().runId === rid) set({ matrix: m, error: null })
    } catch (e: any) {
      if (get().runId === rid) set({ error: e.message })
    } finally {
      inflight = false
      if (again) { again = false; get().refresh() }
    }
  },

  onEvent: (e) => {
    const s = get()
    if (e.run_id !== s.runId) return
    const throttled = () => {
      if (timer) return
      timer = setTimeout(() => { timer = null; get().refresh() }, 350)
    }
    switch (e.type) {
      case 'run_finished':
      case 'jacobian_started':
      case 'jacobian_done':
      case 'jacobian_proposed':
        get().refresh()
        break
      case 'jacobian_cell': {
        const m = s.matrix
        if (m) set({ matrix: { ...m, status: 'running', progress: { done: e.payload.runs_done, total: e.payload.runs_total } } })
        throttled()
        break
      }
      case 'surface_ready':
        get().loadSurface(e.payload.surface_id)
        break
    }
  },

  applyUi: (ui) => {
    if (!ui) return
    const patch: Partial<ExplorerStore> = {}
    if (ui.tab) patch.tab = ui.tab
    if (ui.colorBy) patch.colorBy = ui.colorBy
    if (ui.overlay) patch.overlay = ui.overlay
    if (ui.select) patch.selectedVar = ui.select
    if (ui.cell) { patch.cell = ui.cell; patch.selectedVar = ui.cell[0] }
    if (ui.sort) patch.sort = { metric: ui.sort, dir: -1 }
    set(patch)
    if (ui.refresh || ui.cell) get().refresh()
  },

  selectVar: (v) => set({ selectedVar: v }),
  setColorBy: (m) => set({ colorBy: m }),
  setOverlay: (o) => set({ overlay: o }),
  selectCell: (v, m) => set({ cell: [v, m], selectedVar: v }),
  setSort: (m) => set((s) => ({ sort: s.sort?.metric === m ? (s.sort.dir === -1 ? { metric: m, dir: 1 } : null) : { metric: m, dir: -1 } })),
  setBuilder: (b) => set({ builder: b }),
  loadSurface: async (sid, f0) => {
    const rid = get().runId
    if (!rid) return
    try {
      const sv = await exApi.surface(rid, sid, f0)
      set((s) => ({ surfaces: { ...s.surfaces, [cellKey(sv.variable, sv.metric)]: sv } }))
    } catch (e: any) {
      set({ error: e.message })
    }
  },
  setTarget: (key, t) => set((s) => ({ targets: { ...s.targets, [key]: t } })),
  setVerification: (key, v) => set((s) => ({ verifications: { ...s.verifications, [key]: v } })),
}))

/* ---------- shared formatting ---------- */
export function fmtNum(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a'
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a >= 1000) return v.toFixed(0)
  if (a >= 100) return v.toFixed(1)
  return Number(v.toPrecision(digits)).toString()
}

export const fmtSigned = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtNum(Math.abs(v))

/** Value of a metric in display units (GHz metrics shown as GHz values but MHz deltas). */
export function fmtMetricValue(m: ExMetric, v: number | null | undefined) {
  if (v === null || v === undefined) return 'n/a'
  if (m.unit === 'GHz') return Math.abs(v) < 0.5 ? `${(v * 1000).toFixed(1)} MHz` : `${v.toFixed(3)} GHz`
  return `${fmtNum(v, 4)}${m.unit ? ` ${m.unit}` : ''}`
}

export const fmtMin = (s: number) => (s >= 60 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`)
