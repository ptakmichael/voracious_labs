import { useEffect, useMemo, useRef, useState } from 'react'
import { type PMarker, type PSeries, Plot, fmtNum, yAt } from './Plot'
import { type Fn, type Params, type Solution, type Trace, type XVar, X_LABEL, available, evaluate, gammaSamples, quantity, traceLabel, traceUnit } from './quantities'
import { type Report, newTraceId, traceStyle, useStudio } from './store'

const solOf = (sols: Solution[], id: number) => (id === -1 ? sols[sols.length - 1] : sols.find((s) => s.id === id))

/** Series for a report, from its traces and the stored solutions. */
export function useSeries(rep: Report): PSeries[] {
  const sols = useStudio((s) => s.sols)
  return useMemo(() => rep.traces.filter((t) => !t.hidden).flatMap((t) => {
    if (rep.type === 'smith') {
      if (t.imported || t.q !== 'S(1,1)') return []
      const s = solOf(sols, t.sol)
      if (!s) return []
      const g = gammaSamples(s)
      return [{ id: t.id, label: 'S(1,1)', color: t.color, dash: t.dash, x: g.re, y: g.im, f: g.f }]
    }
    const v = evaluate(t, solOf(sols, t.sol))
    if (!v) return []
    const sfx = !t.imported && sols.length > 1 && t.sol !== -1 ? `  run ${t.sol}` : ''
    return [{ id: t.id, label: traceLabel(t) + sfx, color: t.color, dash: t.dash, ...v }]
  }), [rep.traces, rep.type, sols])
}

function yTitle(rep: Report) {
  const ts = rep.traces.filter((t) => !t.hidden && !t.imported)
  if (!ts.length) return ''
  const units = [...new Set(ts.map(traceUnit))]
  if (ts.length === 1) return `${traceLabel(ts[0])}${units[0] ? ` (${units[0]})` : ''}`
  return units.filter(Boolean).join(', ') || [...new Set(ts.map((t) => t.q))].join(', ')
}

function csv(rep: Report, series: PSeries[]) {
  if (!series.length) return
  const xs = series[0].x
  const head = ['x', ...series.map((s) => `"${s.label}"`)].join(',')
  const rows = xs.map((x) => [x, ...series.map((s) => yAt(s, x))].map((v) => +(+v).toPrecision(8)).join(','))
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([[head, ...rows].join('\n')], { type: 'text/csv' }))
  a.download = `${rep.name.replace(/[^\w.-]+/g, '_')}.csv`
  a.click()
}

export function exportCsv(rep: Report) { csv(rep, seriesNow(rep)) }
/** Non-hook version for commands. */
export function seriesNow(rep: Report): PSeries[] {
  const sols = useStudio.getState().sols
  return rep.traces.filter((t) => !t.hidden).flatMap((t) => { const v = evaluate(t, solOf(sols, t.sol)); return v ? [{ id: t.id, label: traceLabel(t), color: t.color, ...v }] : [] })
}

export function addMarker(rep: Report, at: 'max' | 'min' | number, series: PSeries[]) {
  const s = series[0]
  if (!s) return
  const x = typeof at === 'number' ? at : s.x[s.y.reduce((b, v, i) => ((at === 'max' ? v > s.y[b] : v < s.y[b]) ? i : b), 0)]
  const n = rep.markers.length ? Math.max(...rep.markers.map((m) => +m.id.slice(1))) + 1 : 1
  useStudio.getState().patchReport(rep.id, { markers: [...rep.markers, { id: `m${n}`, trace: s.id, x }] })
}

export function ReportView({ rep }: { rep: Report }) {
  const st = useStudio()
  const series = useSeries(rep)
  const [dlg, setDlg] = useState(false)
  const [axes, setAxes] = useState(false)
  const x = rep.traces[0]?.x ?? 'Freq'
  const markers: PMarker[] = rep.markers.flatMap((m) => {
    const s = series.find((q) => q.id === m.trace) ?? series[0]
    return s ? [{ id: m.id, name: m.id, series: s.id, x: m.x, y: rep.type === 'smith' ? 0 : yAt(s, m.x), color: s.color }] : []
  })
  const last = st.sols[st.sols.length - 1]
  // the plot takes whatever height the window gives it, after the toolbar and the trace table
  const box = useRef<HTMLDivElement>(null)
  const [ph, setPh] = useState(360)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver((e) => setPh(Math.max(200, Math.floor(e[0].contentRect.height) - (series.length > 1 ? 34 : 12))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [series.length])
  return (
    <div className="rp">
      <div className="rp-bar">
        <button onClick={() => setDlg(true)}>Add Trace…</button>
        <div className="seg">{(['rect', 'polar', 'smith'] as const).map((k) => <button key={k} className={rep.type === k ? 'on' : ''} onClick={() => st.patchReport(rep.id, { type: k })}>{k === 'rect' ? 'Rectangular' : k === 'polar' ? 'Polar' : 'Smith'}</button>)}</div>
        <span className="rp-sep" />
        <button onClick={() => addMarker(rep, 'max', series)} disabled={!series.length}>Marker: max</button>
        <button onClick={() => addMarker(rep, 'min', series)} disabled={!series.length}>min</button>
        <button onClick={() => st.patchReport(rep.id, { markers: [] })} disabled={!rep.markers.length}>Clear</button>
        <span className="rp-sep" />
        <button className={axes ? 'on' : ''} onClick={() => setAxes(!axes)}>Axes…</button>
        <button onClick={() => csv(rep, series)} disabled={!series.length}>Export CSV</button>
        <span className="rp-info">{last ? `${last.name}${st.dirty ? ' · design changed, re-analyze' : ''}` : 'no solution · Analyze first'}</span>
      </div>
      {axes && <AxesRow rep={rep} />}
      <div className="rp-plot" ref={box}>
        <Plot kind={rep.type} series={series} xLabel={rep.type === 'smith' ? '' : X_LABEL[x]} yLabel={rep.type === 'smith' ? 'S(1,1)' : yTitle(rep)} xRange={rep.xRange} yRange={rep.yRange} markers={markers}
          height={ph} onPick={(xv) => addMarker(rep, +xv.toFixed(rep.type === 'rect' && x === 'Freq' ? 4 : 1), series)} />
        {!series.length && <div className="rp-empty">{st.sols.length ? 'No trace data for this report type.' : 'No solution yet. Analyze (F5) or type: solve'}</div>}
      </div>
      <div className="rp-tables">
        <table className="grid">
          <thead><tr><th /><th>Trace</th><th>Solution</th><th /></tr></thead>
          <tbody>{rep.traces.map((t) => (
            <tr key={t.id} className={t.hidden ? 'off' : ''}>
              <td><svg width="20" height="8"><line x1="0" x2="20" y1="4" y2="4" stroke={t.color} strokeWidth="2" strokeDasharray={t.dash} /></svg></td>
              <td className="mono">{rep.type === 'smith' && !t.imported ? t.q : traceLabel(t)}</td>
              <td className="mono">{t.imported ? 'imported' : t.sol === -1 ? 'latest' : `run ${t.sol}`}</td>
              <td className="act">
                <button title={t.hidden ? 'Show' : 'Hide'} onClick={() => st.patchReport(rep.id, { traces: rep.traces.map((q) => (q.id === t.id ? { ...q, hidden: !q.hidden } : q)) })}>{t.hidden ? '○' : '◉'}</button>
                <button title="Delete trace" onClick={() => st.patchReport(rep.id, { traces: rep.traces.filter((q) => q.id !== t.id), markers: rep.markers.filter((m) => m.trace !== t.id) })}>×</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
        {markers.length > 0 && (
          <table className="grid">
            <thead><tr><th>Marker</th><th>{rep.type === 'polar' ? 'Theta' : X_LABEL[x].split(' ')[0]}</th><th>{rep.type === 'smith' ? '' : 'Value'}</th><th /></tr></thead>
            <tbody>{markers.map((m) => (
              <tr key={m.id}><td className="mono">{m.name}</td><td className="mono">{fmtNum(m.x, 0.0001)}</td><td className="mono">{rep.type === 'smith' ? '' : fmtNum(m.y, 0.01)}</td>
                <td className="act"><button onClick={() => st.patchReport(rep.id, { markers: rep.markers.filter((q) => q.id !== m.id) })}>×</button></td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {dlg && <TraceDialog rep={rep} onClose={() => setDlg(false)} />}
    </div>
  )
}

function AxesRow({ rep }: { rep: Report }) {
  const st = useStudio()
  const [v, setV] = useState({ x0: rep.xRange?.[0] ?? '', x1: rep.xRange?.[1] ?? '', y0: rep.yRange?.[0] ?? '', y1: rep.yRange?.[1] ?? '' })
  const num = (s: string | number) => (s === '' ? NaN : +s)
  const apply = () => {
    const xr: [number, number] = [num(v.x0), num(v.x1)], yr: [number, number] = [num(v.y0), num(v.y1)]
    st.patchReport(rep.id, { xRange: xr.every(Number.isFinite) && xr[1] > xr[0] ? xr : undefined, yRange: yr.every(Number.isFinite) && yr[1] > yr[0] ? yr : undefined })
  }
  const f = (k: keyof typeof v) => <input value={v[k]} placeholder="auto" onChange={(e) => setV({ ...v, [k]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && apply()} />
  return (
    <div className="rp-axes">
      <span>X</span>{f('x0')}<span>to</span>{f('x1')}<span>Y</span>{f('y0')}<span>to</span>{f('y1')}
      <button onClick={apply}>Apply</button>
      <button onClick={() => { setV({ x0: '', x1: '', y0: '', y1: '' }); st.patchReport(rep.id, { xRange: undefined, yRange: undefined }) }}>Auto</button>
    </div>
  )
}

/** HFSS-style report dialog: solution, category, quantity, function, sweep variable, fixed parameters. */
export function TraceDialog({ rep, onClose }: { rep?: Report; onClose: () => void }) {
  const st = useStudio()
  const kind = st.kind ?? 'patch'
  const qs = available(kind)
  const cats = [...new Set(qs.map((q) => q.cat))]
  const [cat, setCat] = useState(rep?.traces.find((t) => !t.imported) ? quantity(rep.traces.find((t) => !t.imported)!.q)?.cat ?? cats[0] : cats[0])
  const inCat = qs.filter((q) => q.cat === cat)
  const [qn, setQn] = useState<string[]>([inCat[0]?.name])
  const q0 = quantity(qn[0]) ?? inCat[0]
  const [fn, setFn] = useState<Fn>(q0?.fns[0] ?? '')
  const [x, setX] = useState<XVar>(q0?.xs[0] ?? 'Freq')
  const [sol, setSol] = useState(-1)
  const [params, setParams] = useState<Params>({})
  const pickCat = (c: string) => { setCat(c); const q = qs.find((z) => z.cat === c)!; setQn([q.name]); setFn(q.fns[0]); setX(q.xs[0]) }
  const pickQ = (name: string, multi: boolean) => {
    const q = quantity(name)!
    if (multi) setQn(qn.includes(name) ? qn.filter((z) => z !== name) : [...qn, name])
    else { setQn([name]); setFn(q.fns[0]); setX(q.xs.includes(x) ? x : q.xs[0]) }
  }
  const fns = q0?.fns ?? ['']
  const xs = q0?.xs ?? ['Freq']
  const make = (base: number): Trace[] => qn.map((name, i) => ({ id: newTraceId(), q: name, fn: quantity(name)!.fns.includes(fn) ? fn : quantity(name)!.fns[0], x, sol, params: { ...params }, ...traceStyle(base + i) }))
  const add = () => { if (!rep) return; st.patchReport(rep.id, { traces: [...rep.traces, ...make(rep.traces.filter((t) => !t.imported).length)] }) }
  const create = () => { const t = make(0); st.addReport({ name: `${t.map(traceLabel).join(', ').slice(0, 40)}`, type: x === 'Theta' ? 'polar' : 'rect', traces: t }); onClose() }
  const pkeys = (q0?.params ?? []).filter((k) => !(k === 'freq' && x === 'Freq') && !(k === 'steer' && x === 'ScanAng'))
  return (
    <div className="dlg-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg" role="dialog" aria-label="Report">
        <div className="dlg-h">{rep ? `Add Trace · ${rep.name}` : 'New Report'}<button onClick={onClose} aria-label="Close">×</button></div>
        <div className="dlg-row">
          <label>Solution<select value={sol} onChange={(e) => setSol(+e.target.value)}>
            <option value={-1}>Setup1 : Sweep (latest)</option>
            {st.sols.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
          <label>Primary sweep<select value={x} onChange={(e) => setX(e.target.value as XVar)}>{xs.map((v) => <option key={v} value={v}>{X_LABEL[v]}</option>)}</select></label>
        </div>
        <div className="dlg-cols">
          <div><div className="dlg-l">Category</div><div className="dlg-list">{cats.map((c) => <button key={c} className={c === cat ? 'on' : ''} onClick={() => pickCat(c)}>{c}</button>)}</div></div>
          <div><div className="dlg-l">Quantity <span>ctrl-click: several</span></div><div className="dlg-list">{inCat.map((z) => <button key={z.name} className={qn.includes(z.name) ? 'on' : ''} onClick={(e) => pickQ(z.name, e.ctrlKey || e.metaKey)}>{z.name}</button>)}</div></div>
          <div><div className="dlg-l">Function</div><div className="dlg-list">{fns.map((f) => <button key={f || 'none'} className={f === fn ? 'on' : ''} onClick={() => setFn(f)}>{f === '' ? '<none>' : f}</button>)}</div></div>
        </div>
        {pkeys.length > 0 && (
          <div className="dlg-row">
            {pkeys.map((k) => (
              <label key={k}>{k === 'phi' ? 'Phi (deg)' : k === 'steer' ? 'Steer (deg)' : 'Freq (GHz)'}
                <input value={params[k] ?? ''} placeholder={k === 'phi' ? '90' : k === 'steer' ? String(st.a.theta) : kind === 'array' ? '2.43' : 'centre'} onChange={(e) => setParams({ ...params, [k]: e.target.value === '' ? undefined : +e.target.value })} />
              </label>
            ))}
          </div>
        )}
        <div className="dlg-foot">
          <span className="mono">{qn.map((n) => traceLabel({ id: '', q: n, fn: quantity(n)!.fns.includes(fn) ? fn : quantity(n)!.fns[0], x, sol, params, color: '' })).join('  ·  ')}</span>
          <button onClick={create} disabled={!qn.length}>New Report</button>
          {rep && <button className="pri" onClick={add} disabled={!qn.length}>Add Trace</button>}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
