import { useEffect, useMemo, useState } from 'react'
import { LineChart, type Marker, type Series } from '../components/charts/LineChart'
import { SmithTrajectory } from '../components/charts/SmithChart'
import { Download, Play, X } from '../components/Icons'
import { MockBadge } from '../components/Shell'
import { useStore } from '../store'
import { exApi } from './api'
import { MetricBuilder, VariableBuilder } from './Builders'
import { cellKey, fmtMetricValue, fmtMin, fmtNum, fmtSigned, useExplorer, type Cell, type ExMetric, type ExVar, type Matrix } from './store'

/* ============================== shared bits ============================== */
export function ComputeNotice({ m }: { m: Matrix }) {
  const runId = useExplorer((s) => s.runId)
  const refresh = useExplorer((s) => s.refresh)
  const [err, setErr] = useState<string | null>(null)
  if (m.status === 'running') {
    const pct = m.progress.total ? (100 * m.progress.done) / m.progress.total : 0
    return (
      <div className="ex-progress">
        <div className="small"><b>Computing the effect matrix:</b> {m.progress.done}/{m.progress.total} coarse runs
          (fidelity {m.fd_fidelity}, {m.solver}) · simulated, MOCK</div>
        <div className="progress" style={{ height: 8 }}><div style={{ width: `${pct}%` }} /></div>
      </div>
    )
  }
  if (m.plan.n_runs === 0) return null
  const start = async () => {
    setErr(null)
    try { await exApi.startJacobian(runId!); await refresh() } catch (e: any) { setErr(e.message) }
  }
  const over = m.plan.n_runs > m.budget
  return (
    <div className="notice blue ex-notice">
      <div>
        {m.proposal?.reason ?? (m.coarse_runs || Object.keys(m.cells).length ? 'Some watched variables have no row yet.' : 'The effect matrix is not computed yet.')}
        {' '}It needs <b>{m.plan.n_runs} coarse runs</b> (2 per base variable) ≈ {fmtMin(m.plan.est_time_s)} simulated, budget {m.budget}.
        {err && <div className="err-text">{err}</div>}
      </div>
      <button className="btn primary sm" disabled={over} title={over ? 'Over the compute budget: raise it in Settings' : undefined} onClick={start}>
        <Play size={14} /> Compute · {m.plan.n_runs} runs
      </button>
    </div>
  )
}

function cellStyle(c: Cell | undefined, colMax: number) {
  if (!c || c.value === null || colMax <= 0) return {}
  const a = Math.min(1, Math.abs(c.value) / colMax)
  const alpha = 0.08 + 0.62 * a
  const rgb = c.value > 0 ? '44,93,158' : '194,84,30'
  return { background: `rgba(${rgb},${alpha.toFixed(3)})`, color: alpha > 0.5 ? '#fff' : 'var(--heading)' }
}

function cellTitle(v: ExVar, m: ExMetric, c?: Cell) {
  if (!c) return ''
  if (c.value === null) return `n/a: ${c.na_reason}`
  const bits = [`${m.long}: ${fmtSigned(c.value)} ${c.unit} per ${c.per} of ${v.name}`, `method: ${c.method}`]
  if (c.hold) bits.push(`${v.name} ${c.hold}`)
  if (c.noisy) bits.push('noisy: the change is within the solver’s repeatability')
  if (c.non_smooth) bits.push('non-smooth here: the active point jumps between the ± runs')
  return bits.join('\n')
}

function toCsv(m: Matrix, rows: ExVar[], cols: ExMetric[]) {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  const head = ['variable', 'kind', 'value', ...cols.map((c) => `${c.name} (${c.delta_unit || '-'} per +5%)`)]
  const lines = rows.map((v) => [v.name, v.kind, v.value ?? '', ...cols.map((c) => {
    const cell = m.cells[v.name]?.[c.name]
    if (!cell || cell.value === null) return `n/a: ${cell?.na_reason ?? ''}`
    return `${cell.value}${cell.noisy ? ' (noisy)' : ''}${cell.non_smooth ? ' (non-smooth)' : ''}`
  })])
  return [head, ...lines].map((r) => r.map((x) => q(String(x))).join(',')).join('\n') +
    `\n${q(`# ${m.cost_basis ?? ''}`)}\n`
}

/* ============================== matrix ============================== */
function EffectMatrix({ m }: { m: Matrix }) {
  const { cell, selectCell, sort, setSort, selectedVar, refresh } = useExplorer()
  const pid = useStore((s) => s.project.name)
  const [filter, setFilter] = useState('')
  const [hidden, setHidden] = useState<string[]>([])
  const [settings, setSettings] = useState(false)
  const f = filter.trim().toLowerCase()
  const cols = m.metrics.filter((c) => !hidden.includes(c.name) && (!f || c.name.toLowerCase().includes(f) || c.label.toLowerCase().includes(f)
    || m.variables.some((v) => v.name.toLowerCase().includes(f))))
  let rows = m.variables.filter((v) => !f || v.name.toLowerCase().includes(f) || m.metrics.some((c) => c.name.toLowerCase().includes(f) || c.label.toLowerCase().includes(f)))
  if (sort) {
    const val = (v: ExVar) => { const c = m.cells[v.name]?.[sort.metric]; return c && c.value !== null ? Math.abs(c.value) : -1 }
    rows = [...rows].sort((a, b) => (val(b) - val(a)) * (sort.dir === -1 ? 1 : -1))
  }
  const colMax = useMemo(() => Object.fromEntries(m.metrics.map((c) => [c.name, Math.max(0, ...m.variables
    .map((v) => m.cells[v.name]?.[c.name]).filter((x) => x && x.value !== null && !x.noisy).map((x) => Math.abs(x!.value!)))])), [m])
  const csv = () => {
    const blob = new Blob([toCsv(m, rows, cols)], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${pid}_effect_matrix.csv`; a.click()
  }
  const remove = async (kind: 'variable' | 'metric', name: string) => {
    if (!confirm(`Remove custom ${kind} ${name}?`)) return
    try { await (kind === 'variable' ? exApi.removeVariable(pid, name) : exApi.removeMetric(pid, name)); refresh() } catch (e: any) { alert(e.message) }
  }
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Effect of every variable on every metric</h2>
        <span className="sub">{m.cost_basis ?? 'Not computed yet'}</span>
      </div>
      <ComputeNotice m={m} />
      <div className="row wrap ex-tools">
        <input className="input sm" style={{ width: 220 }} placeholder="Filter variables or metrics" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter rows and columns" />
        <details className="ex-cols">
          <summary className="btn sm">Columns ({cols.length}/{m.metrics.length})</summary>
          <div className="ex-pop">
            {m.metrics.map((c) => (
              <label key={c.name} className="check" style={{ minHeight: 28 }}>
                <input type="checkbox" checked={!hidden.includes(c.name)} onChange={() => setHidden((h) => (h.includes(c.name) ? h.filter((x) => x !== c.name) : [...h, c.name]))} />
                {c.label} <span className="muted small mono">{c.name}</span>
              </label>
            ))}
          </div>
        </details>
        <button className="btn sm" onClick={() => setSettings(!settings)} aria-expanded={settings}>Compute settings</button>
        <button className="btn sm" onClick={csv}><Download size={14} /> Export CSV</button>
        <span className="spacer" />
        <MockBadge />
      </div>
      {settings && <ComputeSettings m={m} onClose={() => setSettings(false)} />}
      <div className="ex-matrix-wrap">
        <table className="ex-matrix">
          <thead>
            <tr>
              <th className="corner">Variable ↓ / Metric →</th>
              {cols.map((c) => (
                <th key={c.name} className={sort?.metric === c.name ? 'sorted' : ''}>
                  <button onClick={() => setSort(c.name)} title={`${c.long}${c.note ? ` (${c.note})` : ''}\nClick to sort by effect size`}>
                    <span className="h">{c.label}{sort?.metric === c.name ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}</span>
                    <span className="u">{c.na ? `${c.unit || '–'} per +5%` : `${c.delta_unit || '–'} per +5%`}</span>
                  </button>
                  {c.kind === 'custom' && <button className="ex-x" onClick={() => remove('metric', c.name)} aria-label={`Remove metric ${c.name}`}><X size={12} /></button>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.name} className={selectedVar === v.name ? 'hl' : ''}>
                <th scope="row" title={v.kind === 'derived' ? `${v.name} = ${v.expression} (${v.hold_constant?.length ? `holds ${v.hold_constant.join(', ')}` : 'nothing held'})` : v.label}>
                  <span className="mono">{v.name}</span>{v.kind === 'derived' && <span className="tag custom">custom</span>}
                  {v.kind === 'derived' && <button className="ex-x" onClick={() => remove('variable', v.name)} aria-label={`Remove variable ${v.name}`}><X size={12} /></button>}
                </th>
                {cols.map((c) => {
                  const x = m.cells[v.name]?.[c.name]
                  const sel = cell?.[0] === v.name && cell?.[1] === c.name
                  return (
                    <td key={c.name} className={`${sel ? 'sel' : ''} ${x?.noisy ? 'noisy' : ''} ${x?.value === null || !x ? 'na' : ''}`}
                      style={x?.noisy ? {} : cellStyle(x, colMax[c.name])} title={cellTitle(v, c, x)}>
                      <button onClick={() => selectCell(v.name, c.name)} aria-label={`${v.name} on ${c.label}`}>
                        {!x || x.value === null ? 'n/a' : fmtSigned(x.value)}
                        {x?.noisy && <span className="flag">noisy</span>}
                        {x?.non_smooth && <span className="flag">non-smooth here</span>}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ex-legend small muted">
        <span><i className="sw up" /> increases the metric</span>
        <span><i className="sw down" /> decreases the metric</span>
        <span><i className="sw hatch" /> noisy (within solver repeatability)</span>
        <span>Shade = size relative to the column · custom inputs use the chain rule and state what they hold</span>
        {m.metrics.filter((c) => c.na).map((c) => <span key={c.name}>n/a {c.label}: {c.na}</span>)}
      </div>
    </section>
  )
}

function ComputeSettings({ m, onClose }: { m: Matrix; onClose: () => void }) {
  const pid = useStore((s) => s.project.name)
  const refresh = useExplorer((s) => s.refresh)
  const [watched, setWatched] = useState<string[]>(m.watched)
  const [budget, setBudget] = useState(m.budget)
  const save = async () => { await exApi.settings(pid, { watched, budget }); await refresh(); onClose() }
  const base = m.variables.filter((v) => v.kind === 'base')
  return (
    <div className="ex-settings">
      <div className="section-title">Watched base variables (precomputed after each verified run)</div>
      <div className="row wrap" style={{ gap: 16 }}>
        {base.map((v) => (
          <label key={v.name} className="check mono" style={{ minHeight: 30 }}>
            <input type="checkbox" checked={watched.includes(v.name)} onChange={() => setWatched((w) => (w.includes(v.name) ? w.filter((x) => x !== v.name) : [...w, v.name]))} />
            {v.name}
          </label>
        ))}
      </div>
      <div className="row wrap" style={{ marginTop: 10 }}>
        <label className="lbl" htmlFor="ex-budget">Compute budget (coarse runs)</label>
        <input id="ex-budget" className="input sm" type="number" min={2} max={200} style={{ width: 90 }} value={budget} onChange={(e) => setBudget(+e.target.value)} />
        <span className="small muted">{2 * watched.length} runs for the watched set ≈ {fmtMin(2 * watched.length * m.cost_coarse_s)} simulated · autonomy {m.autonomy}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={onClose}>Cancel</button>
        <button className="btn sm primary" onClick={save}>Save</button>
      </div>
    </div>
  )
}

/* ============================== drill-down ============================== */
function DrillDown({ m, v, mt }: { m: Matrix; v: ExVar; mt: ExMetric }) {
  const { runId, surfaces, targets, verifications, setTarget, setVerification, refresh } = useExplorer()
  const setProject = useStore((s) => s.setProject)
  const pushChat = useStore((s) => s.pushChat)
  const key = cellKey(v.name, mt.name)
  const surf = surfaces[key]
  const tgt = targets[key]
  const ver = verifications[key]
  const c = m.cells[v.name]?.[mt.name]
  const y0 = m.values[mt.name]?.value ?? null
  const [rangePct, setRangePct] = useState(5)
  const [targetText, setTargetText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  useEffect(() => {
    setErr(null); setApplied(null)
    setTargetText(mt.name === 'Zin_re_fc' ? '50' : mt.name === 'goal_margin' ? '1' : '')
  }, [key, mt.name])

  const fit = async (nPoints: number) => {
    setBusy('fit'); setErr(null)
    try {
      const sv = await exApi.startSurface(runId!, { variable: v.name, metric: mt.name, n_points: nPoints, range_pct: rangePct })
      useExplorer.setState((s) => ({ surfaces: { ...s.surfaces, [key]: sv } }))
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const solve = async () => {
    const val = parseFloat(targetText)
    if (!Number.isFinite(val)) { setErr('Enter a target value'); return }
    setBusy('solve'); setErr(null)
    try { setTarget(key, await exApi.target(runId!, { metric: mt.name, value: val, variable: v.name })) } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  // re-solve when a fresh surface lands so the sentence reflects it
  useEffect(() => {
    if (surf?.status === 'ready' && tgt) solve()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surf?.status, surf?.id])
  const verify = async () => {
    setBusy('verify'); setErr(null)
    try { setVerification(key, await exApi.verifyPoint(runId!, { variable: v.name, value: tgt.solution, metric: mt.name })); refresh() } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const apply = async () => {
    setBusy('apply'); setErr(null)
    try {
      const r = await exApi.apply(runId!, { variable: v.name, value: tgt.solution })
      setProject((p) => ({ ...p, objects: r.objects, materials: r.materials }))
      const moved = Object.entries(r.values as Record<string, number>).filter(([k, x]) => Math.abs(x - (m.variables.find((y) => y.name === k)?.value ?? x)) > 1e-9)
      const msg = `Applied ${v.name} = ${fmtNum(tgt.solution, 4)} to the model (${moved.map(([k, x]) => `${k} → ${fmtNum(x, 4)}`).join(', ')}). Press Run on the Model tab to verify the whole pipeline.`
      setApplied(msg)
      pushChat({ role: 'solver', text: msg })
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }

  // chart data: verified surface if ready, else the first-order tangent around the current design
  const x0 = v.value ?? 0
  const ready = surf?.status === 'ready' && surf.curve
  const series: Series[] = []
  const pts: Marker[] = []
  let xs: number[] = []
  let ys: number[] = []
  if (ready) {
    series.push({ x: surf.curve.x, y: surf.curve.y, color: 'var(--c-orange)', width: 2.6, label: `response surface (${surf.points.length} verified runs + gradient)` })
    if (surf.tangent) series.push({ x: surf.tangent.x, y: surf.tangent.y, color: 'var(--c-ink)', dash: '6 5', width: 1.6, label: 'first-order tangent' })
    surf.points.filter((p: any) => p.y !== null).forEach((p: any) => pts.push({ x: p.x, y: p.y, color: 'var(--c-ink)', title: `verified: ${fmtNum(p.x, 4)} → ${fmtNum(p.y, 4)}` }))
    xs = surf.curve.x; ys = [...surf.curve.y, ...surf.points.map((p: any) => p.y).filter((y: any) => y !== null)]
  } else if (c?.deriv !== undefined && c.value !== null && y0 !== null) {
    const dx = Math.abs(x0) * 0.08 || 0.08
    const tx = [x0 - dx, x0 + dx]
    const ty = tx.map((x) => y0 + c.deriv! * (x - x0))
    series.push({ x: tx, y: ty, color: 'var(--c-ink)', dash: '6 5', width: 1.8, label: 'first-order tangent (coarse FD)' })
    pts.push({ x: x0, y: y0, color: 'var(--c-ink)', title: 'current verified design' })
    xs = tx; ys = ty
  }
  const tv = parseFloat(targetText)
  if (tgt) {
    pts.push({ x: tgt.solution, y: tgt.predicted, color: 'var(--c-blue)', hollow: true, r: 7, title: `predicted solution ${fmtNum(tgt.solution, 4)}` })
    xs = [...xs, tgt.solution]; ys = [...ys, tgt.predicted]
  }
  if (Number.isFinite(tv)) ys = [...ys, tv]
  const xd: [number, number] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1]
  const yr = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 1]
  const ypad = (yr[1] - yr[0]) * 0.12 || Math.abs(yr[0]) * 0.05 || 1
  const yd: [number, number] = [yr[0] - ypad, yr[1] + ypad]
  const yScale = mt.unit === 'GHz' ? 1000 : 1
  const yUnit = mt.unit === 'GHz' ? 'MHz' : mt.unit

  const expandCost = 2 * m.cost_verified_s
  const fitRuns = 2
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{mt.label} vs. {v.name}</h2>
        <span className="tag-strong">Selected cell</span>
      </div>
      <p className="small" style={{ marginTop: 0 }}>
        {c?.value !== null && c?.value !== undefined
          ? <>First-order: <b>{fmtSigned(c.value)} {c.unit}</b> per {c.per} of {v.name} ({c.method}, fidelity {m.fd_fidelity}){c.noisy ? ' · noisy' : ''}{c.non_smooth ? ' · non-smooth here' : ''}.</>
          : <>No first-order effect: {c?.na_reason}.</>}
        {v.kind === 'derived' && <> <b>{v.name} {c?.hold ?? `holds ${v.hold_constant?.join(', ') || 'nothing'}`}.</b></>}
      </p>
      {xs.length > 0 ? (
        <LineChart height={290} xDomain={xd} yDomain={yd} xLabel={`${v.name}${v.unit ? ` (${v.unit})` : ''}`} legend
          xFmt={(x) => fmtNum(x, 3)} yFmt={(y) => (mt.unit === 'GHz' ? (y * yScale).toFixed(0) : fmtNum(y, 3))}
          yLabel={yUnit}
          hlines={Number.isFinite(tv) ? [{ y: tv, color: 'var(--c-blue)', label: `${fmtNum(tv)} ${mt.unit} target` }] : []}
          series={series} points={pts} />
      ) : <div className="empty">Waiting for the effect matrix…</div>}
      <div className="chart-cap">
        {ready ? `Orange: local response surface (${surf.points.length} verified runs at fidelity ${surf.fidelity} + FD gradient, rms residual ${fmtNum(surf.rms_resid, 2)}) · dashed: first-order tangent · dots: verified runs`
          : 'Dashed: first-order tangent from the coarse FD Jacobian · dot: current verified design. A prediction, not an answer: fit a response surface or verify.'}
        {tgt && ' · open circle: predicted solution'}
      </div>

      <div className="row wrap" style={{ marginTop: 12 }}>
        {surf?.status === 'running'
          ? <span className="small muted">Fitting: {surf.new_runs} verified runs (≈ {fmtMin(surf.est_time_s)} simulated)…</span>
          : (
            <>
              <select className="input sm" style={{ width: 92 }} value={rangePct} onChange={(e) => setRangePct(+e.target.value)} aria-label="Range">
                {[2, 5, 10, 20].map((r) => <option key={r} value={r}>±{r}%</option>)}
              </select>
              <button className="btn sm" disabled={!!busy || c?.value === null} onClick={() => fit(3)}>
                {ready ? 'Refit' : 'Fit response surface'} · {fitRuns} verified runs ≈ {fmtMin(fitRuns * m.cost_verified_s)}
              </button>
            </>
          )}
      </div>

      <div className="ex-target">
        <label className="lbl" htmlFor="ex-tv">Reach {mt.label} =</label>
        <input id="ex-tv" className="input sm" style={{ width: 110 }} value={targetText} onChange={(e) => setTargetText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') solve() }} placeholder={fmtNum(y0, 4)} />
        <span className="small muted">{mt.unit} using {v.name}</span>
        <button className="btn sm" disabled={!!busy || c?.value === null} onClick={solve}>Solve</button>
      </div>
      {tgt && (
        <p style={{ marginBottom: 6 }}>
          <b>{tgt.method === 'response surface' ? 'Response-surface prediction' : 'First-order prediction'}.</b> {tgt.sentence}
        </p>
      )}
      {tgt && !tgt.in_range && tgt.method === 'response surface' && (
        <button className="btn sm" disabled={!!busy || surf?.status === 'running'} onClick={() => fit(5)} style={{ marginBottom: 8 }}>
          Expand the range · 2 more verified runs ≈ {fmtMin(expandCost)}
        </button>
      )}
      {ver && (
        <div className={`notice ${ver.within_trust ? 'blue' : ''}`} style={{ marginBottom: 8 }}>
          Verified at {v.name} = {fmtNum(ver.x, 4)} ({m.solver}, fidelity {ver.fidelity}, MOCK): {mt.label} {fmtMetricValue(mt, ver.actual)} vs.
          predicted {fmtMetricValue(mt, ver.predicted)} (error {ver.error !== null ? fmtSigned(ver.error * yScale) : 'n/a'} {yUnit}) ·{' '}
          {ver.within_trust ? 'inside the trust region' : 'outside the trust region'}
        </div>
      )}
      {applied && <div className="notice blue" style={{ marginBottom: 8 }}>{applied}</div>}
      {err && <div className="err-text" role="alert">{err}</div>}
      <div className="row wrap" style={{ marginTop: 6 }}>
        <button className="btn primary" disabled={!tgt || !!busy} onClick={verify} title="Runs one solver run at the verified fidelity">
          {busy === 'verify' ? 'Verifying…' : `Verify with solver · 1 run ≈ ${fmtMin(m.cost_verified_s)}`}
        </button>
        <button className="btn" disabled={!tgt || !!busy} onClick={apply}>Apply to design</button>
      </div>
    </section>
  )
}

function SmithPanel({ m, v, mt }: { m: Matrix; v: ExVar; mt: ExMetric }) {
  const { surfaces, loadSurface } = useExplorer()
  const surf = surfaces[cellKey(v.name, mt.name)]
  const [f0, setF0] = useState('')
  const sm = surf?.smith
  useEffect(() => { if (sm) setF0(sm.f0.toFixed(3)) }, [sm])
  const fmtZ = (z: [number, number]) => `${Math.round(z[0])}${Math.abs(z[1]) >= 1 ? `${z[1] >= 0 ? '+' : '−'}j${Math.round(Math.abs(z[1]))}` : ''} Ω`
  return (
    <section className="panel">
      <div className="panel-head"><h2>Smith chart</h2></div>
      {!mt.impedance ? (
        <div className="empty">The impedance trajectory appears for impedance and S11 metrics. Pick a Re Zin, Im Zin, |S11| or VSWR cell.</div>
      ) : !sm ? (
        <div className="empty">Fit a response surface for {mt.label} vs. {v.name} to see how Zin moves as {v.name} changes.</div>
      ) : (
        <>
          <SmithTrajectory path={sm.path} now={sm.now} height={300} fmtEnd={fmtZ} />
          <p className="small" style={{ margin: '6px 0' }}>
            Arrow: direction Zin moves as {v.name} increases ({fmtNum(sm.path[0].x, 3)} → {fmtNum(sm.path[sm.path.length - 1].x, 3)}). Dot: current design.
          </p>
          <div className="row small">
            <label className="lbl" htmlFor="ex-f0">Zin at f₀ =</label>
            <input id="ex-f0" className="input sm" style={{ width: 90 }} value={f0} onChange={(e) => setF0(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && surf) loadSurface(surf.id, parseFloat(f0) || undefined) }} />
            <span className="muted">GHz (default: verified f_res {fmtNum(m.values.f_res?.value, 4)} GHz)</span>
            <button className="btn sm" onClick={() => surf && loadSurface(surf.id, parseFloat(f0) || undefined)}>Update</button>
          </div>
        </>
      )}
    </section>
  )
}

/* ============================== tab ============================== */
export default function MatrixTab() {
  const { matrix: m, error, cell, refresh } = useExplorer()
  useEffect(() => { if (!m) refresh() }, [m, refresh])
  if (error && !m) return <section className="panel"><div className="empty">{error}</div></section>
  if (!m) return <section className="panel"><div className="empty">Loading the effect matrix…</div></section>
  const v = cell ? m.variables.find((x) => x.name === cell[0]) : undefined
  const mt = cell ? m.metrics.find((x) => x.name === cell[1]) : undefined
  return (
    <>
      <EffectMatrix m={m} />
      {v && mt ? (
        <div className="grid-results">
          <DrillDown m={m} v={v} mt={mt} />
          <SmithPanel m={m} v={v} mt={mt} />
        </div>
      ) : (
        <section className="panel notice-panel"><div className="small muted">Click a cell to open its drill-down: the metric against the variable, a local response surface, a “reach this target” solver and, for impedance metrics, the Smith-chart trajectory.</div></section>
      )}
      <div className="grid2">
        <section className="panel"><div className="panel-head"><h2>New variable</h2></div><VariableBuilder /></section>
        <section className="panel"><div className="panel-head"><h2>New metric</h2></div><MetricBuilder /></section>
      </div>
    </>
  )
}
