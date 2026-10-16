import type { Kind } from './quantities'

/**
 * Every plot and analysis tool, by the name the console uses (`plot <id>`). Standard plots open as ordinary
 * reports; 3D gain and the analysis tools open in their own windows.
 */
export interface PlotDef {
  id: string
  name: string
  group: 'Standard' | 'Insight' | 'Array' | 'Solve'
  kinds: Kind[]
  report?: (k: Kind, steer: number) => string // console command that builds the report
}

export const CATALOG: PlotDef[] = [
  { id: 's11', name: 'Return loss S11', group: 'Standard', kinds: ['patch', 'array'], report: () => 'report dB(S(1,1))' },
  { id: 'smith', name: 'Smith chart', group: 'Standard', kinds: ['patch', 'array'], report: () => 'report S(1,1) smith' },
  { id: 'z', name: 'Input impedance', group: 'Standard', kinds: ['patch', 'array'], report: () => 'report re(Z(1,1)) im(Z(1,1))' },
  { id: 'vswr', name: 'VSWR', group: 'Standard', kinds: ['patch', 'array'], report: () => 'report VSWR(1)' },
  { id: 'pattern', name: 'Gain pattern (polar)', group: 'Standard', kinds: ['patch', 'array'], report: (k, st) => (k === 'array' ? `report RealizedGainTotal vs Theta steer=${st} polar` : 'report RealizedGainTotal GainTotal vs Theta phi=90 polar') },
  { id: 'gain3d', name: '3D gain', group: 'Standard', kinds: ['patch', 'array'] },
  { id: 'gain', name: 'Peak gain vs frequency', group: 'Standard', kinds: ['patch', 'array'], report: (k) => (k === 'array' ? 'report PeakRealizedGain PeakDirectivity' : 'report PeakGain PeakRealizedGain PeakDirectivity') },
  { id: 'eff', name: 'Efficiency', group: 'Standard', kinds: ['patch'], report: () => 'report dB10(RadiationEfficiency) dB10(TotalEfficiency)' },
  { id: 'power', name: 'Power budget', group: 'Standard', kinds: ['patch'], report: () => 'report AcceptedPower RadiatedPower DielectricLoss ConductorLoss' },
  { id: 'effects', name: 'Effects on geometry', group: 'Insight', kinds: ['patch', 'array'] },
  { id: 'matrix', name: 'What moves what', group: 'Insight', kinds: ['patch', 'array'] },
  { id: 'drill', name: 'Drill-down', group: 'Insight', kinds: ['patch', 'array'] },
  { id: 'contour', name: 'Where the good designs are', group: 'Insight', kinds: ['patch', 'array'] },
  { id: 'smithloops', name: 'Smith loops per parameter', group: 'Insight', kinds: ['patch', 'array'] },
  { id: 'fields', name: 'Fields E, H, J, S', group: 'Insight', kinds: ['patch'] },
  { id: 'designer', name: 'Array designer', group: 'Array', kinds: ['array'] },
  { id: 'uv', name: 'u-v space', group: 'Array', kinds: ['array'] },
  { id: 'scan', name: 'Scan performance', group: 'Array', kinds: ['array'] },
  { id: 'active', name: 'Active S11 vs scan', group: 'Array', kinds: ['array'], report: () => 'report dB(ActiveS(1,1)) vs ScanAng' },
  { id: 'pointing', name: 'Beam squint', group: 'Array', kinds: ['array'], report: (_k, st) => `report BeamPointing steer=${st || 32}` },
  { id: 'sll', name: 'Sidelobes vs scan', group: 'Array', kinds: ['array'], report: () => 'report SideLobeLevel vs ScanAng' },
  { id: 'history', name: 'Run history and reasons', group: 'Solve', kinds: ['patch', 'array'] },
  { id: 'solver', name: 'Why the solver chose this', group: 'Solve', kinds: ['patch', 'array'] },
]

export const plotDef = (id: string) => CATALOG.find((p) => p.id === id.toLowerCase())
export const isTool = (p: PlotDef) => !p.report && p.id !== 'gain3d'
