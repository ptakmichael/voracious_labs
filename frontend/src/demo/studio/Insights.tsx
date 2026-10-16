import { useState } from 'react'
import { ArrayDesignerPane, ScanPane, UVPane } from '../ArrayTools'
import { arrayMetrics } from '../arrayModel'
import { metrics } from '../model'
import { RunTree } from '../RunTree'
import { SmithPane } from '../SmithPane'
import { SolveReport } from '../SolveReport'
import { ContourPane, Drill, EffectsPane, FieldsPane, Matrix, MetricBuilder, ParamBuilder } from '../Understand'
import { CATALOG, type PlotDef, isTool } from './catalog'
import { openPlot } from './commands'
import { useStudio } from './store'

/** One analysis tool in its own window. The tools are the original ones; `.ins` strips their explanatory prose. */
export function ToolView({ id }: { id: string }) {
  const [build, setBuild] = useState<'param' | 'metric' | null>(null)
  const sols = useStudio((s) => s.sols)
  if (!sols.length && id !== 'designer' && id !== 'uv') return <div className="rp-empty">No solution yet. Analyze first.</div>
  const body = (() => {
    switch (id) {
      case 'effects': return <EffectsPane onBuild={setBuild} />
      case 'matrix': return <Matrix onBuild={setBuild} />
      case 'drill': return <Drill />
      case 'contour': return <ContourPane />
      case 'smithloops': return <SmithPane />
      case 'fields': return <FieldsPane />
      case 'designer': return <ArrayDesignerPane />
      case 'uv': return <UVPane />
      case 'scan': return <ScanPane />
      case 'history': return <History />
      case 'solver': return <div className="pane"><SolveReport framed={false} /></div>
      default: return <div className="rp-empty">Unknown tool {id}</div>
    }
  })()
  return (
    <div className="ins">
      {body}
      {build && (
        <div className="b-scrim" onClick={(e) => { if (e.target === e.currentTarget) setBuild(null) }}>
          {build === 'metric' ? <MetricBuilder onClose={() => setBuild(null)} /> : <ParamBuilder onClose={() => setBuild(null)} />}
        </div>
      )}
    </div>
  )
}

/** Version history: every run as a tree (what actually ran, rejected moves, an equivalent design), and per run
 * what changed and why the solver did it. */
function History() {
  const st = useStudio()
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="hist">
      <div className="hist-tree"><RunTree /></div>
      <table className="grid hist-tbl">
        <thead><tr><th>Run</th><th>Step</th><th>{st.kind === 'array' ? 'Active S11' : 'f0'}</th><th>{st.kind === 'array' ? 'SLL' : 'Worst in band'}</th><th>Why</th></tr></thead>
        <tbody>{st.sols.map((s) => {
          const m = metrics(s.d), am = s.a ? arrayMetrics(s.d, s.a) : null
          const short = s.why[0] ?? ''
          return (
            <tr key={s.id} onClick={() => setOpen(open === s.id ? null : s.id)} className="click">
              <td className="mono">{s.id}</td>
              <td>{s.label}</td>
              <td className="mono">{am ? `${am.activeWorst.toFixed(1)} dB` : `${m.f0.toFixed(3)} GHz`}</td>
              <td className="mono">{am ? `${am.sllWorst.toFixed(1)} dB` : `${m.worst.toFixed(1)} dB`}</td>
              <td className="why">{open === s.id ? s.why.map((w, i) => <div key={i}>{w}</div>) : <>{short}{s.why.length > 1 && <span className="more"> +{s.why.length - 1}</span>}</>}</td>
            </tr>
          )
        })}</tbody>
      </table>
    </div>
  )
}

/** Old + new results in one place: pick a tool, it opens beside the list. Standard plots open as reports. */
export function InsightsDoc() {
  const st = useStudio()
  const kind = st.kind ?? 'patch'
  const [sel, setSel] = useState('effects')
  const list = CATALOG.filter((p) => p.kinds.includes(kind))
  const groups: PlotDef['group'][] = ['Insight', 'Solve', ...(kind === 'array' ? ['Array' as const] : []), 'Standard']
  const cur = list.find((p) => p.id === sel && isTool(p)) ?? list.find(isTool)!
  return (
    <div className="insd">
      <nav className="insd-list">
        {groups.map((g) => (
          <div key={g}>
            <div className="insd-g">{g}</div>
            {list.filter((p) => p.group === g).map((p) => (
              <button key={p.id} className={isTool(p) && cur.id === p.id ? 'on' : ''} title={`plot ${p.id}`}
                onClick={() => (isTool(p) ? setSel(p.id) : openPlot(p.id))}>
                <span>{p.name}</span>{!isTool(p) && <i>↗</i>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="insd-body">
        <div className="insd-h"><b>{cur.name}</b><span className="mono">plot {cur.id}</span><button onClick={() => st.open(`tool:${cur.id}`)}>Open in window ↗</button></div>
        <ToolView key={cur.id} id={cur.id} />
      </div>
    </div>
  )
}
