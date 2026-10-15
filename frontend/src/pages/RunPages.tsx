import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { approve, exportUrl, hold, startRun } from '../api'
import { useStore } from '../store'
import { LineChart, S11Chart } from '../components/charts/LineChart'
import { PolarChart, SmithChart } from '../components/charts/SmithChart'
import { Check, Download, Play, X } from '../components/Icons'
import { EventLog, MockBadge } from '../components/Shell'
import { useExplorer, type ResultsTab } from '../explorer/store'

const ExplorerTab = lazy(() => import('../explorer/ExplorerTab'))
const MatrixTab = lazy(() => import('../explorer/MatrixTab'))

const SOLVER = { palace: 'Palace (FEM)', openems: 'openEMS (FDTD)' } as Record<string, string>
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
const fmtMin = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`)

function Waiting({ what }: { what: string }) {
  return <div className="empty">{what}</div>
}

/** Shown on run screens before any run exists, so every stage can be previewed. */
function NoRun() {
  const { run, setView } = useStore()
  const [busy, setBusy] = useState(false)
  if (run.id) return null
  return (
    <section className="panel notice-panel">
      <div>
        <h3>No run yet</h3>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          Press Run on the Model tab to solve your geometry, or load a sample run to preview this screen. The sample uses the
          scripted orchestrator and the mock solver, and finishes in a few seconds.
        </p>
      </div>
      <div className="row">
        <button className="btn" onClick={() => setView('setup', true)}>Go to Model</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await startRun({ sample: true }) } catch { alert('Could not reach the backend on port 8000.') } finally { setBusy(false) }
        }}><Play size={16} /> {busy ? 'Loading…' : 'Load sample run'}</button>
      </div>
    </section>
  )
}

function Status({ ok, label }: { ok: boolean; label?: string }) {
  return <span className={`st ${ok ? 'pass' : 'fail'}`}>{ok ? <Check size={15} /> : <X size={15} />}{label ?? (ok ? 'Pass' : 'Fail')}</span>
}

/* ============================== ANALYZE ============================== */
function useCountdown(end: number | null) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!end) return
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [end])
  return end ? Math.max(0, Math.ceil((end - now) / 1000)) : null
}

export function AnalyzePage() {
  const { run } = useStore()
  const f = run.features
  const sel = run.selection
  const plan = run.plan
  const awaitingPlan = run.awaiting?.target === 'plan'
  const secs = useCountdown(awaitingPlan ? run.countdownEnd : null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<any>(null)
  useEffect(() => { if (!editing) setDraft(null) }, [editing])
  useEffect(() => { if (!awaitingPlan) setEditing(false) }, [awaitingPlan])
  const p = draft ?? plan
  const toggle = (key: string) => {
    if (!awaitingPlan) return
    if (!editing) { hold(); setEditing(true) }
    const base = draft ?? plan
    setDraft({ ...base, optimizations: base.optimizations.map((o: any) => (o.key === key ? { ...o, enabled: !o.enabled } : o)) })
  }
  const start = () => {
    const extra = draft ? { plan: { solver: draft.solver, fidelity: draft.fidelity, cross_check: draft.cross_check, enabled: Object.fromEntries(draft.optimizations.map((o: any) => [o.key, o.enabled])) } } : {}
    approve('plan', extra)
    setEditing(false)
  }
  return (
    <>
      <NoRun />
      <section className="panel">
        <div className="panel-head"><h2>Geometry analysis</h2>{f && <span className="sub">{f.n_objects} objects · estimated resonance {f.f_estimate_ghz} GHz (design equations)</span>}</div>
        {!f ? <Waiting what="Analyzing geometry…" /> : (
          <div className="tiles">
            <div className="tile"><div className="k">Electrical size</div><div className="v">{f.electrical_size} λ₀</div></div>
            <div className="tile"><div className="k">Substrate thickness</div><div className="v">{f.h_over_lambda_d} λd</div>{f.thin && <div className="n">Thin: FDTD cells get tiny</div>}</div>
            <div className="tile"><div className="k">Permittivity</div><div className="v">εr {f.eps_r}</div><div className="n blue">tan δ {f.tan_d}</div></div>
            <div className="tile"><div className="k">Boundary</div><div className="v">{f.boundary}</div></div>
            <div className="tile"><div className="k">Ports</div><div className="v">{f.port_label}</div></div>
            <div className="tile"><div className="k">Band</div><div className="v">{f.band[0]}–{f.band[1]} GHz</div><div className="n">±{f.band_pct}% around centre</div></div>
          </div>
        )}
      </section>
      <div className="grid2">
        <section className="panel">
          <div className="panel-head"><h2>Method selector</h2><span className="tag">rule-based · estimates</span></div>
          {!sel ? <Waiting what="Waiting for features…" /> : (
            <>
              {sel.options.map((o: any, i: number) => (
                <div key={o.solver} style={{ marginBottom: 14 }}>
                  <div className="opt-head">
                    <span>{o.label}</span>
                    <span style={{ color: i === 0 ? 'var(--orange-dark)' : 'var(--blue)' }}>{Math.round(o.p_fastest * 100)}%{i === 0 ? ' likely fastest' : ''}</span>
                  </div>
                  <div className="bar"><div style={{ width: `${o.p_fastest * 100}%`, background: i === 0 ? 'var(--orange)' : 'var(--blue)' }} /></div>
                  <div className="small muted">Predicted {(o.pred_cost_s / 60).toFixed(1)} min to reach ±{useStore.getState().project.settings.accuracy === 'tight' ? '0.01' : useStore.getState().project.settings.accuracy === 'quick' ? '0.1' : '0.03'} · fidelity {o.fidelity}</div>
                </div>
              ))}
              <p style={{ marginTop: 6 }}><b style={{ color: 'var(--navy)' }}>Why:</b> {sel.reason}</p>
              <div className="small muted">Shelf: openEMS · FDTD <span className="tag">mock</span> · Palace · FEM <span className="tag">mock</span> · MoM/BEM <span className="tag">planned</span> · Hybrid DDM <span className="tag">planned</span></div>
            </>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Plan</h2>
            {awaitingPlan && secs !== null && !editing && <span className="countdown">Starting in {secs} s unless you change something</span>}
            {awaitingPlan && (secs === null || editing) && <span className="countdown">Waiting for your approval</span>}
            {!awaitingPlan && run.plan && <span className="tag">{run.stage === 'analyze' ? 'proposed' : 'accepted'}</span>}
          </div>
          {!p ? <Waiting what="Waiting for the selector…" /> : (
            <>
              {editing ? (
                <div className="row wrap" style={{ marginBottom: 10 }}>
                  <select className="input sm" style={{ width: 170 }} value={p.solver} onChange={(e) => setDraft({ ...p, solver: e.target.value })}>
                    <option value="palace">Palace (FEM)</option><option value="openems">openEMS (FDTD)</option>
                  </select>
                  <select className="input sm" style={{ width: 120 }} value={p.fidelity} onChange={(e) => setDraft({ ...p, fidelity: +e.target.value })}>
                    <option value={0}>fidelity 0</option><option value={1}>fidelity 1</option><option value={2}>fidelity 2</option>
                  </select>
                </div>
              ) : (
                <p style={{ margin: '0 0 8px', fontSize: 16 }}><b style={{ color: 'var(--navy)' }}>{SOLVER[p.solver]}</b> · fidelity {p.fidelity}{p.order ? ` · element order ${p.order}` : ''}</p>
              )}
              <div className="small muted" style={{ marginBottom: 8 }}>{p.fidelity_desc}</div>
              {p.optimizations.map((o: any) => (
                <label key={o.key} className="check" style={{ opacity: o.status === 'planned' ? 0.55 : 1 }}>
                  <input type="checkbox" checked={o.enabled} disabled={o.status === 'planned' || !awaitingPlan} onChange={() => toggle(o.key)} />
                  {o.name}{o.status === 'planned' && <span className="tag">planned</span>}
                </label>
              ))}
              <label className="check">
                <input type="checkbox" checked={!!p.cross_check} disabled={!awaitingPlan}
                  onChange={() => { if (!editing) { hold(); setEditing(true) } setDraft({ ...p, cross_check: !p.cross_check }) }} />
                Cross-check with {p.solver === 'palace' ? 'openEMS' : 'Palace'} (fidelity 1)
              </label>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn primary" disabled={!awaitingPlan} onClick={start}><Play size={16} /> Start solve</button>
                <button className="btn" disabled={!awaitingPlan || editing} onClick={() => { hold(); setEditing(true) }}>Edit plan</button>
              </div>
            </>
          )}
        </section>
      </div>
      <EventLog />
    </>
  )
}

/* ============================== SOLVE ============================== */
export function SolvePage() {
  const { run, project } = useStore()
  const sub = run.subrun
  const pr = run.progress
  const stats = pr?.stats ?? sub?.stats ?? {}
  const conv = run.convergence
  const residual = conv.length && conv[0].kind === 'residual'
  const purposeLabel: Record<string, string> = { primary: '', cross_check: ' · cross-check', convergence: ' · convergence check', explore: ' · design exploration' }
  return (
    <>
      <NoRun />
      <section className="panel">
        <div className="panel-head">
          <h2>{sub ? `${sub.finished ? 'Solved' : 'Solving'} with ${SOLVER[sub.solver]} · fidelity ${sub.fidelity}${purposeLabel[sub.purpose] ?? ''}` : 'Preparing solve…'}</h2>
          <div className="row"><MockBadge />{pr && <span className="sub">ETA ≈ {fmtMin(pr.eta_s ?? 0)} (simulated)</span>}</div>
        </div>
        <div className="progress" style={{ marginBottom: 14 }}><div style={{ width: `${pr?.percent ?? 0}%` }} /></div>
        <div className="tiles">
          <div className="tile"><div className="k">Progress</div><div className="v">{pr?.percent ?? 0}%</div></div>
          {stats.tets !== undefined ? (
            <>
              <div className="tile"><div className="k">Tetrahedra</div><div className="v">{fmtK(stats.tets)}</div>
                {run.plan?.optimizations?.some((o: any) => o.key === 'symmetry' && o.enabled) && <div className="n">half domain (symmetry)</div>}</div>
              <div className="tile"><div className="k">Unknowns</div><div className="v">{fmtK(stats.unknowns)}</div><div className="n blue">order {stats.order}</div></div>
            </>
          ) : (
            <>
              <div className="tile"><div className="k">Cells</div><div className="v">{stats.cells ? fmtK(stats.cells) : '–'}</div></div>
              <div className="tile"><div className="k">Time steps</div><div className="v">{stats.timesteps ? fmtK(stats.timesteps) : '–'}</div></div>
            </>
          )}
          <div className="tile"><div className="k">Memory</div><div className="v">{stats.mem_mb ? (stats.mem_mb > 1000 ? `${(stats.mem_mb / 1000).toFixed(1)} GB` : `${stats.mem_mb} MB`) : '–'}</div></div>
          <div className="tile"><div className="k">Compute so far</div><div className="v">{fmtMin(pr?.elapsed_sim_s ?? 0)}</div><div className="n blue">4 cores</div></div>
        </div>
      </section>
      <div className="grid2">
        <section className="panel">
          <div className="panel-head"><h2>S11 so far (live)</h2></div>
          {run.partial && run.partial.f.length > 1
            ? <S11Chart f={run.partial.f} s={run.partial.s} goal={project.goal} fRange={[project.settings.f_start, project.settings.f_stop]} live={!sub?.finished} />
            : <Waiting what="S11 appears as frequency samples converge…" />}
          <div className="chart-cap">Shaded: goal band {project.goal.f1.toFixed(2)}–{project.goal.f2.toFixed(2)} GHz · dashed: {project.goal.threshold_db} dB</div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>{residual ? 'Linear solver convergence' : 'FDTD energy decay'}</h2><span className="tag">synthetic</span></div>
          {conv.length < 2 ? <Waiting what="Waiting for solver iterations…" /> : residual ? (
            <LineChart height={280} xDomain={[0, Math.max(conv.length - 1, 10)]} yDomain={[1e-10, 2]} yLog
              yTicks={[1, 1e-3, 1e-6, 1e-9]} yFmt={(v) => (v === 1 ? '1e0' : v.toExponential(0).replace('+', ''))} xFmt={(v) => `${Math.round(v)}`}
              xTicks={[]} xLabel="Iteration (current frequency sample)"
              hlines={[{ y: 1e-8, color: 'var(--c-blue)', label: 'target 1e-8' }]}
              series={[{ x: conv.map((_, i) => i), y: conv.map((c) => c.value), color: 'var(--c-ink)', width: 1.8 }]} />
          ) : (
            <LineChart height={280} xDomain={[0, Math.max(conv.length - 1, 10)]} yDomain={[-90, 0]} yTicks={[0, -30, -60, -90]}
              xTicks={[]} xLabel="Time step" yFmt={(v) => `${v} dB`}
              hlines={[{ y: -80, color: 'var(--c-blue)', label: 'end criterion −80 dB' }]}
              series={[{ x: conv.map((_, i) => i), y: conv.map((c) => c.value), color: 'var(--c-ink)', width: 1.8 }]} />
          )}
        </section>
      </div>
      <EventLog />
    </>
  )
}

/* ============================== VERIFY ============================== */
export function VerifyPage() {
  const { run, project } = useStore()
  const vs = run.verifications
  const last = vs[vs.length - 1]
  const g = run.goalCheck
  const prop = run.proposal
  const awaitingDesign = run.awaiting?.target === 'design'
  const awaitingFix = run.awaiting?.target === 'fix'
  const [edit, setEdit] = useState<number | null>(null)
  useEffect(() => { setEdit(null) }, [prop])
  // Show each check name once per iteration, collapsing repeats of passing passivity/convergence rows
  const rows = useMemo(() => {
    const out: any[] = []
    vs.forEach((v: any, vi: number) => v.checks.forEach((c: any) => {
      const isX = c.name.startsWith('Cross')
      if (!isX && vi < vs.length - 1) return
      out.push({ ...c, key: `${vi}-${c.name}` })
    }))
    const xs = out.filter((r) => r.name.startsWith('Cross'))
    return [...out.filter((r) => !r.name.startsWith('Cross')), ...xs]
  }, [vs])
  return (
    <>
      <NoRun />
      <section className="panel">
        <div className="panel-head"><h2>Verification{last ? ` (iteration ${last.iteration})` : ''}</h2><MockBadge /></div>
        {!last ? <Waiting what="Verification runs after the solve…" /> : (
          <>
            <table className="checks">
              <thead><tr><th>Check</th><th>Result</th><th>Status</th></tr></thead>
              <tbody>{rows.map((c) => <tr key={c.key}><td>{c.name}</td><td>{c.result}</td><td><Status ok={c.passed} /></td></tr>)}</tbody>
            </table>
            <p style={{ marginBottom: 0 }}>
              {last.passed
                ? <><b style={{ color: 'var(--navy)' }}>Verified:</b> S11 error ≤ ±{last.error_bar} across the band.</>
                : <><b style={{ color: 'var(--orange-dark)' }}>Not yet verified.</b> The numerical loop will adjust mesh, padding or method.</>}
            </p>
            {run.fixes.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="section-title">Numerical-fix history</div>
                <ul className="hist">{run.fixes.map((f: any) => <li key={f.attempt}><span>{f.attempt}</span><span>{f.change}: {f.reason}</span></li>)}</ul>
              </div>
            )}
            {awaitingFix && (
              <div className="row" style={{ marginTop: 12 }}>
                <span>{run.awaiting.summary}</span>
                <button className="btn primary sm" onClick={() => approve('fix')}>Approve fix</button>
              </div>
            )}
          </>
        )}
      </section>
      <div className="grid2">
        <section className="panel">
          <div className="panel-head"><h2>Goal check</h2></div>
          {!g ? <Waiting what="Checked once the result is verified…" /> : (
            <>
              <S11Chart f={g.freqs} s={g.s11_db} goal={project.goal} fRange={[project.settings.f_start, project.settings.f_stop]} height={270} />
              <p style={{ marginBottom: 0 }}>
                {g.met ? <b style={{ color: 'var(--blue)' }}>Goal met. </b> : <b style={{ color: 'var(--orange-dark)' }}>Goal not met. </b>}
                {g.measured_band
                  ? `S11 is below ${g.threshold_db} dB ${g.met ? 'across' : 'only from'} ${g.measured_band[0].toFixed(2)} to ${g.measured_band[1].toFixed(2)} GHz; the goal is ${g.goal_band[0].toFixed(2)}–${g.goal_band[1].toFixed(2)} GHz.`
                  : `S11 never drops below ${g.threshold_db} dB in the band.`}
              </p>
            </>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Design optimizer proposal</h2></div>
          {!prop ? <Waiting what={g?.met ? 'No change needed: the goal is met.' : 'Runs if the verified result misses the goal…'} /> : (
            <>
              <p style={{ marginTop: 0, fontSize: 15.5 }}>
                {prop.change.label[0].toUpperCase() + prop.change.label.slice(1)}{' '}
                <b style={{ color: 'var(--navy)' }}>{prop.change.from} → {edit ?? prop.change.to} {prop.change.unit}</b>. {prop.rationale}
              </p>
              <p className="small muted">Explored with {prop.coarse_runs} coarse runs (fidelity 0); a verified run will confirm. {prop.constraint[0].toUpperCase() + prop.constraint.slice(1)}.</p>
              {awaitingDesign && (
                <div className="row wrap">
                  <button className="btn primary" onClick={() => approve('design', edit !== null ? { value: edit } : {})}>Approve and re-run</button>
                  {edit === null
                    ? <button className="btn" onClick={() => { hold(); setEdit(prop.change.to) }}>Edit change</button>
                    : <input className="input" type="number" step={0.05} style={{ width: 120 }} value={edit} onChange={(e) => setEdit(+e.target.value)} aria-label="New value (mm)" />}
                </div>
              )}
            </>
          )}
          {run.history.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="section-title">Iteration history</div>
              <ul className="hist">{run.history.map((h: any, i: number) => <li key={i}><span>{i + 1}</span><span>{h.label}{h.status === 'awaiting approval' ? ' · awaiting approval' : h.status === 'declined' ? ' · declined' : ''}</span></li>)}</ul>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

/* ============================== RESULTS ============================== */
const RESULT_TABS: [ResultsTab, string][] = [['summary', 'Summary'], ['explorer', '3D explorer'], ['matrix', 'Effect matrix'], ['exports', 'Exports']]

export function ResultsPage() {
  const { run } = useStore()
  const tab = useExplorer((s) => s.tab)
  const setTab = useExplorer((s) => s.setTab)
  const progress = useExplorer((s) => s.matrix?.status === 'running' ? s.matrix.progress : null)
  if (!run.results) {
    if (!run.id) return <NoRun />
    return <section className="panel"><Waiting what={run.status === 'cancelled' ? 'Run cancelled.' : run.status === 'failed' ? 'Run failed. See the event log.' : 'Results appear when the run finishes…'} /></section>
  }
  return (
    <>
      <nav className="tabs page-tabs" aria-label="Results">
        {RESULT_TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
            {l}{k === 'matrix' && progress && <span className="tab-badge">{progress.done}/{progress.total}</span>}
          </button>
        ))}
      </nav>
      {tab === 'summary' && <ResultsSummary />}
      <Suspense fallback={<section className="panel"><Waiting what="Loading…" /></section>}>
        {tab === 'explorer' && <ExplorerTab />}
        {tab === 'matrix' && <MatrixTab />}
      </Suspense>
      {tab === 'exports' && <ExportsTab />}
    </>
  )
}

function ExportsTab() {
  const items = [
    ['report', 'Report (HTML)', 'Run summary, verification checks, S11 with the error bar, method and compute. Opens in a new tab.'],
    ['s1p', 'Touchstone .s1p', 'Verified S11 for circuit simulators.'],
    ['script', 'Python script', 'Reproduces this run headless with the same settings.'],
    ['yaml', 'Problem YAML', 'The canonical problem description (geometry, materials, ports, settings, goals).'],
  ]
  return (
    <section className="panel">
      <div className="panel-head"><h2>Exports</h2><MockBadge /></div>
      <div className="export-list">
        {items.map(([fmt, label, desc]) => (
          <div key={fmt} className="export-item">
            <div><b>{label}</b><div className="small muted">{desc}</div></div>
            <a className="btn" href={exportUrl(fmt)} target={fmt === 'report' ? '_blank' : undefined} rel="noreferrer"><Download size={15} /> {label.split(' (')[0]}</a>
          </div>
        ))}
        <div className="export-item">
          <div><b>Effect matrix (CSV)</b><div className="small muted">Every variable × metric effect per +5%, with noisy and n/a flags. Export it from the Effect matrix tab.</div></div>
          <button className="btn" onClick={() => useExplorer.getState().setTab('matrix')}>Open effect matrix</button>
        </div>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>All results come from the mock solver; every export carries the MOCK label.</p>
    </section>
  )
}

function ResultsSummary() {
  const { run, project } = useStore()
  const r = run.results
  const [tab, setTab] = useState('s11')
  const ok = r.status === 'met_verified'
  const title = { met_verified: 'Goal met and verified', verified_not_met: 'Verified, goal not met', not_verified: 'Not verified' }[r.status as string] ?? r.status
  const g = r.goal
  const iRes = r.freqs.reduce((bi: number, f: number, i: number) => (Math.abs(f - r.resonance_ghz) < Math.abs(r.freqs[bi] - r.resonance_ghz) ? i : bi), 0)
  const fr: [number, number] = [r.freqs[0], r.freqs[r.freqs.length - 1]]
  const t = r.tiles
  const tabs = [['s11', 'S11 (dB)'], ['impedance', 'Input impedance'], ['vswr', 'VSWR'], ['farfield', 'Far-field']]
  return (
    <>
      <section className="panel">
        <div className="banner">
          <div className={`ico ${ok ? '' : 'bad'}`}>{ok ? <Check size={26} /> : <X size={26} />}</div>
          <div>
            <h1>{title} <span className="badge-mock" style={{ verticalAlign: 'middle' }}>MOCK</span></h1>
            <div className="muted">S11 below {g.threshold_db} dB across {g.f1.toFixed(2)}–{g.f2.toFixed(2)} GHz · error ≤ ±{r.error_bar}{r.headline ? ` · ${r.headline}` : ''}</div>
          </div>
          <div className="exports">
            <a className="btn" href={exportUrl('report')} target="_blank" rel="noreferrer"><Download size={15} /> Report (HTML)</a>
            <a className="btn" href={exportUrl('s1p')}><Download size={15} /> Touchstone .s1p</a>
            <a className="btn" href={exportUrl('script')}><Download size={15} /> Python script</a>
            <a className="btn" href={exportUrl('yaml')}><Download size={15} /> Problem YAML</a>
          </div>
        </div>
      </section>
      <div className="grid-results">
        <section className="panel">
          <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{project.settings.plots.includes(k) ? '' : ''}</button>)}</div>
          {tab === 's11' && (
            <>
              <S11Chart f={r.freqs} s={r.s_db} goal={g} fRange={fr} band={{ lo: r.err_lo_db, hi: r.err_hi_db }} height={330} />
              <div className="chart-cap">Shaded blue: goal band · orange band: verified error bar (±{r.error_bar}) · resonance {r.resonance_ghz.toFixed(3)} GHz, min {r.min_s11_db.toFixed(1)} dB</div>
            </>
          )}
          {tab === 'impedance' && (
            <>
              <LineChart height={330} xDomain={fr} yDomain={[Math.min(-60, ...r.z_im) - 5, Math.max(80, ...r.z_re) + 5]} xLabel="Frequency (GHz)" yLabel="Ω" legend
                hlines={[{ y: 50, color: 'var(--c-grey)', dash: '3 4', label: '50 Ω' }]}
                series={[{ x: r.freqs, y: r.z_re, color: 'var(--c-orange)', label: 'Re Z' }, { x: r.freqs, y: r.z_im, color: 'var(--c-blue)', label: 'Im Z', dash: '7 4' }]} />
              <div className="chart-cap">Z at resonance: {r.z_res[0]} {r.z_res[1] >= 0 ? '+' : '−'} j{Math.abs(r.z_res[1])} Ω</div>
            </>
          )}
          {tab === 'vswr' && (
            <>
              <LineChart height={330} xDomain={fr} yDomain={[1, 6]} yTicks={[1, 2, 3, 4, 5, 6]} xLabel="Frequency (GHz)" yLabel="VSWR"
                vbands={[{ x1: g.f1, x2: g.f2, color: 'var(--c-blue)', opacity: 0.1 }]} hlines={[{ y: 2, color: 'var(--c-orange)', label: 'VSWR 2' }]}
                series={[{ x: r.freqs, y: r.vswr.map((v: number) => Math.min(v, 6)), color: 'var(--c-orange)' }]} />
              <div className="chart-cap">Minimum VSWR {Math.min(...r.vswr).toFixed(2)}</div>
            </>
          )}
          {tab === 'farfield' && (
            <>
              <PolarChart height={330} theta={r.pattern.theta_deg} series={[{ y: r.pattern.e_plane_db, color: 'var(--c-orange)', label: 'E-plane (φ = 0°)' }, { y: r.pattern.h_plane_db, color: 'var(--c-blue)', label: 'H-plane (φ = 90°)', dash: '7 4' }]} />
              <div className="chart-cap">Analytic cavity-model estimate at {r.pattern.f_ghz.toFixed(3)} GHz · peak gain ≈ {r.pattern.peak_gain_dbi} dBi. A far-field post-processor from solver fields is coming soon.</div>
            </>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Smith chart</h2></div>
          <SmithChart re={r.s_re} im={r.s_im} marker={iRes} height={300} />
          <p className="small" style={{ marginBottom: 0 }}>Z at {r.resonance_ghz.toFixed(2)} GHz: {r.z_res[0]} {r.z_res[1] >= 0 ? '+' : '−'} j{Math.abs(r.z_res[1])} Ω</p>
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><h2>Run summary</h2><span className="sub">orchestrator: {({ claude: 'Claude', bigpickle: 'Big Pickle', scripted: 'scripted' } as Record<string, string>)[r.orchestrator] ?? r.orchestrator} · {t.subruns} solver runs</span></div>
        <div className="tiles">
          <div className="tile"><div className="k">Method</div><div className="v">{t.method}</div><div className="n">{t.method_sub}</div></div>
          <div className="tile"><div className="k">Design iterations</div><div className="v">{t.design_iterations}</div></div>
          <div className="tile"><div className="k">Numerical fixes</div><div className="v">{t.numerical_fixes}</div><div className="n">{t.fix_sub}</div></div>
          <div className="tile"><div className="k">Compute</div><div className="v">{t.compute_min} min</div><div className="n">{t.cores} cores · simulated</div></div>
          <div className="tile"><div className="k">Saving vs. default</div><div className="v">{t.saving}</div><div className="n">measure in the pilot</div></div>
          <div className="tile"><div className="k">Manual setup steps</div><div className="v">{t.manual_steps}</div></div>
        </div>
      </section>
    </>
  )
}
