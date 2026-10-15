import { fmtNum, fmtSigned, type Cell, type ExMetric, type ExVar } from './store'

export interface HandleInfo {
  v: ExVar
  strength: number // 0..1 relative effect on the colour-by metric
  label: string
  tip: { head: string; lines: string[] }
}

const GREY = [0x9a, 0xa6, 0xb8]
const ORANGE = [0xc2, 0x54, 0x1e]

/** Effect-strength colour: grey (weak) → orange accent (strong). */
export function strengthColor(s: number) {
  const t = Math.max(0, Math.min(1, s))
  return '#' + GREY.map((g, i) => Math.round(g + (ORANGE[i] - g) * t).toString(16).padStart(2, '0')).join('')
}

/** Hover text and label for a handle, from its Jacobian row. */
export function handleInfo(v: ExVar, row: Record<string, Cell> | undefined, metrics: ExMetric[], colorBy: string,
  colMax: Record<string, number>, strength: number): HandleInfo {
  const c = row?.[colorBy]
  const m = metrics.find((x) => x.name === colorBy)
  let label = `${v.name} ${fmtNum(v.value, 4)}${v.unit ? ` ${v.unit}` : ''}`
  if (c && c.value !== null && m) {
    label += v.kind === 'base' && v.unit && c.deriv !== undefined
      ? ` · ${fmtSigned(c.deriv * m.delta_scale)} ${m.delta_unit}/${v.unit}`
      : ` · ${fmtSigned(c.value)} ${m.delta_unit} per +5%`
  }
  const lines = Object.values(row ?? {})
    .filter((x) => x.value !== null && !x.noisy)
    .map((x) => ({ x, rel: Math.abs(x.value!) / (colMax[x.metric] || 1) }))
    .sort((p, q) => q.rel - p.rel).slice(0, 3)
    .map(({ x }) => `${metrics.find((mm) => mm.name === x.metric)?.label} ${fmtSigned(x.value!)} ${x.unit}`.trim())
  const step = row && Object.values(row)[0]?.per
  const head = `${v.name} = ${fmtNum(v.value, 4)}${v.unit ? ` ${v.unit}` : ''} (${step ?? '+5%'} →)` + (v.kind === 'derived' ? ` · holds ${v.hold_constant?.join(', ') || 'nothing'}` : '')
  return { v, strength, label, tip: { head, lines } }
}
