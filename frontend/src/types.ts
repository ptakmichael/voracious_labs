export type Vec3 = [number, number, number]

export type ObjKind = 'box' | 'sheet' | 'cylinder' | 'port'

export interface GeoObject {
  id: string
  name: string
  kind: ObjKind
  role?: string
  material: string
  pos: Vec3 // centre, mm
  size: Vec3 // mm (sheet: z = 0; cylinder: [diameter, diameter, height])
  color?: string
  visible?: boolean
  impedance?: number
}

export interface Material {
  name: string
  eps_r: number
  tan_d: number
  kind: 'dielectric' | 'pec'
  sigma?: number
}

export type Accuracy = 'quick' | 'standard' | 'tight'
export type Autonomy = 'ask' | 'balanced' | 'auto'

export interface Project {
  name: string
  objects: GeoObject[]
  materials: Material[]
  boundary: { type: 'radiation' | 'pml' | 'pec'; padding: 'auto' | 'quarter' | 'half' }
  settings: {
    f_start: number
    f_stop: number
    n_points: number
    accuracy: Accuracy
    sweep: 'adaptive' | 'discrete' | 'interpolating'
    plots: string[]
    autonomy: Autonomy
  }
  goal: { threshold_db: number; f1: number; f2: number }
  constraints: { length_pct: number; feed_free: boolean }
}

export type Stage = 'setup' | 'analyze' | 'solve' | 'verify' | 'results'
export const STAGES: Stage[] = ['setup', 'analyze', 'solve', 'verify', 'results']

export interface RunEvent {
  ts: string
  t: number
  run_id: string
  type: string
  payload: any
}

export interface ChatMsg {
  role: 'solver' | 'user'
  text: string
}
