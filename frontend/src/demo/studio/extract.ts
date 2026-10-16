/**
 * What the solver pulls out of each known paper: every parameter, the value it will build with, what the paper
 * printed when that differs, where it was found, and whether it checks out. Rows with `bind` drive the model; the
 * engineer can edit any value before building.
 */
export type Status = 'ok' | 'fixed' | 'flag' | 'info'
export interface XRow {
  id: string
  group: string
  label: string
  value: string
  unit: string
  src: string
  paper?: string // as printed, when we build with something else
  status: Status
  note?: string
  bind?: 'f1' | 'f2' | 'L' | 'W' | 'inset' | 'h' | 'er' | 'gs' | 'nx' | 'ny' | 'dx' | 'dy'
}

const r = (id: string, group: string, label: string, value: string | number, unit: string, src: string, extra: Partial<XRow> = {}): XRow =>
  ({ id, group, label, value: String(value), unit, src, status: 'ok', ...extra })

export const PATCH_ROWS: XRow[] = [
  r('f0', 'Target', 'Design frequency', 2.4, 'GHz', 'Abstract'),
  r('f1', 'Target', 'Band low', 2.4, 'GHz', 'assumed', { status: 'info', note: 'paper gives no band; Wi-Fi/BLE', bind: 'f1' }),
  r('f2', 'Target', 'Band high', 2.48, 'GHz', 'assumed', { status: 'info', bind: 'f2' }),
  r('mat', 'Substrate', 'Material', 'FR-4', '', 'Table 1'),
  r('er', 'Substrate', 'εr', 4.4, '', 'Table 1', { paper: '4.08', status: 'fixed', note: '4.08 is FR-4’s εeff, not εr', bind: 'er' }),
  r('h', 'Substrate', 'Height', 1.5, 'mm', 'Table 1', { paper: '1.5 (text: 1.6)', status: 'flag', note: 'Table and text disagree', bind: 'h' }),
  r('subw', 'Substrate', 'Width', 48.19, 'mm', 'eq. (6)', { paper: '38.48', status: 'fixed', note: 'narrower than the patch; W + 6h', bind: 'gs' }),
  r('subl', 'Substrate', 'Length', 47.04, 'mm', 'Table 1'),
  r('W', 'Patch', 'Width W', 39.19, 'mm', 'Table 1', { bind: 'W' }),
  r('L', 'Patch', 'Length L', 30.58, 'mm', 'Table 1', { bind: 'L' }),
  r('inset', 'Feed', 'Inset depth', 6.0, 'mm', 'Fig. 3', { bind: 'inset' }),
  r('fw', 'Feed', 'Line width', 2.9, 'mm', 'Table 1', { paper: '1.0', status: 'fixed', note: '1.0 mm ≈ 85 Ω; 50 Ω needs 2.9 mm' }),
  r('fl', 'Feed', 'Line length', 5.2, 'mm', 'Table 1'),
  r('port', 'Feed', 'Port', '50 Ω lumped', '', 'implied'),
  r('rs11', 'Reported', 'S11 minimum', '−23.9 @ 2.40', 'dB @ GHz', 'Fig. 5', { status: 'info' }),
  r('rvswr', 'Reported', 'VSWR at f0', 1.15, '', 'Fig. 4', { status: 'info' }),
  r('rgain', 'Reported', 'Gain at f0', 3.7, 'dBi', 'Fig. 7', { status: 'info' }),
]

export const ARRAY_ROWS: XRow[] = [
  r('f0', 'Target', 'Design frequency', 2.4, 'GHz', 'Table I'),
  r('f1', 'Target', 'Band low', 2.42, 'GHz', 'Fig. 3', { status: 'fixed', paper: '“ISM band”', note: 'only 20 MHz wide', bind: 'f1' }),
  r('f2', 'Target', 'Band high', 2.44, 'GHz', 'Fig. 3', { status: 'fixed', bind: 'f2' }),
  r('scan', 'Target', 'Scan range', '±42', 'deg', 'Fig. 5'),
  r('mat', 'Substrate', 'Material', 'Rogers 6010.2LM', '', 'text'),
  r('er', 'Substrate', 'εr', 10.2, '', 'datasheet', { bind: 'er' }),
  r('h', 'Substrate', 'Height', 1.27, 'mm', 'Table I', { bind: 'h' }),
  r('W', 'Element', 'Patch width', 25.8, 'mm', 'Table I', { bind: 'W' }),
  r('L', 'Element', 'Patch length', 19.4, 'mm', 'Table I', { paper: '18.2', status: 'fixed', note: '18.2 mm → 2.56 GHz; T-slot folded in', bind: 'L' }),
  r('inset', 'Element', 'Slot / inset', 8.1, 'mm', 'Table I', { note: 'cut length' , bind: 'inset' }),
  r('cw', 'Element', 'Slot width', 1.1, 'mm', 'Table I'),
  r('fw', 'Feed', 'Line width', 1.12, 'mm', 'Table I'),
  r('fl', 'Feed', 'Line length', 10.03, 'mm', 'Table I'),
  r('feed', 'Feed', 'Simulated feed', 'inset', '', 'Fig. 3', { paper: 'coax', status: 'flag', note: 'Fig. 3 used a coax feed' }),
  r('nx', 'Array', 'Columns', 4, '', 'Fig. 2', { bind: 'nx' }),
  r('ny', 'Array', 'Rows', 4, '', 'Fig. 2', { bind: 'ny' }),
  r('dx', 'Array', 'Pitch x', 50, 'mm', 'Table I', { note: '0.4λ: strong coupling', status: 'flag', bind: 'dx' }),
  r('dy', 'Array', 'Pitch y', 50, 'mm', 'Table I', { bind: 'dy' }),
  r('board', 'Array', 'Board', '250.5 × 229.8', 'mm', 'Fig. 2'),
  r('rs11', 'Reported', 'S11 minimum', '−25 @ 2.377', 'dB @ GHz', 'Fig. 3', { status: 'flag', note: 'text says 2.4 GHz' }),
  r('rgain', 'Reported', 'Gain, broadside', 13.5, 'dBi', 'text', { status: 'info' }),
  r('rsteer', 'Reported', 'Gain at 11/22/32/42°', '13 / 12.7 / 12 / 10.7', 'dBi', 'Fig. 5', { status: 'info' }),
]
