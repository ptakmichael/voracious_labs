import { useEffect, useState } from 'react'
import { Plot } from './Plot'
import { type Report, useStudio } from './store'
import { useSeries } from './Report'
import { X_LABEL } from './quantities'
import type { XRow } from './extract'

/** Right-hand panel, only after context is uploaded: what the solver read from it, editable, then build and run. */
export function ContextPanel() {
  const st = useStudio()
  const c = st.ctx
  if (!c?.open) return null
  const rows = c.rows.slice(0, c.shown)
  const groups = [...new Set(c.rows.map((r) => r.group))]
  const flags = c.rows.filter((r) => r.status === 'flag').length, fixed = c.rows.filter((r) => r.status === 'fixed').length
  const figs = st.reports.filter((r) => r.fig).length
  const reading = c.stage === 'reading'
  return (
    <aside className="cx">
      <div className="cx-h">
        <span>Context</span>
        <button onClick={() => st.set({ ctx: { ...c, open: false } })} aria-label="Close context panel">×</button>
      </div>
      <div className="cx-file" title={c.name}>{c.name}</div>
      <div className="cx-sum">
        <div><b>{reading ? `${c.shown}/${c.rows.length}` : c.rows.length}</b><span>parameters</span></div>
        <div><b className={fixed ? 'warn' : ''}>{fixed}</b><span>corrected</span></div>
        <div><b className={flags ? 'bad' : ''}>{flags}</b><span>flagged</span></div>
        <div><b>{figs}</b><span>figures</span></div>
      </div>
      {!c.which && !reading && <div className="cx-none">Not a recognised layout. Nothing extracted.</div>}
      <div className="cx-body">
        {groups.map((g) => {
          const rs = rows.filter((r) => r.group === g)
          return rs.length ? (
            <section key={g}>
              <div className="cx-g">{g}</div>
              {rs.map((r) => <Row key={r.id} r={r} locked={c.stage === 'building'} />)}
            </section>
          ) : null
        })}
        {reading && <div className="cx-reading">reading…</div>}
      </div>
      <div className="cx-foot">
        {c.stage === 'review' && c.which && <button className="pri" onClick={() => void st.buildFromContext()}>Build model</button>}
        {c.stage === 'building' && <button disabled>Building…</button>}
        {(c.stage === 'built' || (c.stage === 'solved' && st.dirty)) && <button className="pri" disabled={!!st.busy} onClick={() => void st.runContext()}>Run and compare</button>}
        {c.stage === 'solved' && !st.dirty && <button onClick={() => void st.optimize()} disabled={!!st.busy}>Optimize</button>}
        {figs > 0 && <button onClick={() => st.open('paperres')}>Paper results</button>}
        <button onClick={() => st.open('paper')}>PDF</button>
      </div>
    </aside>
  )
}

function Row({ r, locked }: { r: XRow; locked: boolean }) {
  const setRow = useStudio((s) => s.setRow)
  const [v, setV] = useState(r.value)
  useEffect(() => setV(r.value), [r.value])
  return (
    <div className={`cx-r ${r.status}`} title={r.note}>
      <span className="cx-l">{r.label}</span>
      <input value={v} disabled={locked} onChange={(e) => setV(e.target.value)} onBlur={() => v !== r.value && setRow(r.id, v)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label={r.label} />
      <span className="cx-u">{r.unit}</span>
      <span className="cx-s">{r.src}</span>
      {(r.paper || r.note) && <span className="cx-n">{r.paper ? `paper ${r.paper}` : ''}{r.paper && r.note ? ' · ' : ''}{r.note}</span>}
    </div>
  )
}

/** All of the paper's results, digitised and re-plotted in our plot style; ours overlay once a run exists. */
export function PaperResults() {
  const st = useStudio()
  const figs = st.reports.filter((r) => r.fig)
  const last = st.sols[st.sols.length - 1]
  return (
    <div className="pr">
      <div className="pr-h">
        <b>Paper results</b>
        <span>{figs.length} figures digitised · {last ? `run ${last.id} overlaid (solid) on the paper (dashed)` : 'paper curves only · Build model, then Run and compare'}</span>
      </div>
      <div className="pr-grid">{figs.map((r) => <Fig key={r.id} rep={r} />)}</div>
    </div>
  )
}

function Fig({ rep }: { rep: Report }) {
  const open = useStudio((s) => s.open)
  const series = useSeries(rep)
  const x = rep.traces[0]?.x ?? 'Freq'
  return (
    <div className="pr-card" onClick={() => open(rep.id)} title="Open as a report">
      <div className="pr-t">{rep.name}<i>↗</i></div>
      <Plot kind={rep.type} series={series} xLabel={rep.type === 'polar' ? '' : X_LABEL[x]} yLabel="" xRange={rep.xRange} yRange={rep.yRange} markers={[]} height={210} />
    </div>
  )
}
