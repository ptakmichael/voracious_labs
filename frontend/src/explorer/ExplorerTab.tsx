import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { MockBadge } from '../components/Shell'
import { patchGeo, resonance, turboCss } from '../setup/fields'
import { useStore } from '../store'
import { VariableBuilder } from './Builders'
import { handleInfo, strengthColor } from './handles'
import { ComputeNotice } from './MatrixTab'
import { fmtNum, fmtSigned, useExplorer, type Overlay } from './store'

const ExplorerViewport = lazy(() => import('./ExplorerViewport'))

const OVERLAYS: [Overlay, string][] = [['E', '|E| field'], ['J', 'Surface current'], ['sens', 'Sensitivity paint'], ['none', 'None']]

export default function ExplorerTab() {
  const { matrix: m, error, refresh, overlay, setOverlay, colorBy, setColorBy, selectedVar, selectVar, builder, setBuilder, setTab, selectCell } = useExplorer()
  const project = useStore((s) => s.project)
  const results = useStore((s) => s.run.results)
  const objects = results?.objects ?? project.objects
  const g = useMemo(() => patchGeo({ ...project, objects }), [project, objects])
  const fr = g ? resonance(g).fr : null
  const { f_start, f_stop } = project.settings
  const [freq, setFreq] = useState<number | null>(null)
  const [animate, setAnimate] = useState(false)
  useEffect(() => { if (!m) refresh() }, [m, refresh])
  const f = freq ?? fr ?? (f_start + f_stop) / 2

  const colMax = useMemo(() => {
    if (!m) return {}
    return Object.fromEntries(m.metrics.map((c) => [c.name, Math.max(0, ...m.variables
      .map((v) => m.cells[v.name]?.[c.name]).filter((x) => x && x.value !== null && !x.noisy).map((x) => Math.abs(x!.value!)))]))
  }, [m])
  const metric = m?.metrics.find((x) => x.name === colorBy)
  const handles = useMemo(() => {
    if (!m) return []
    const withH = m.variables.filter((v) => v.handle)
    const max = Math.max(1e-30, ...withH.map((v) => {
      const c = m.cells[v.name]?.[colorBy]
      return c && c.value !== null && !c.noisy ? Math.abs(c.value) : 0
    }))
    return withH.map((v) => {
      const c = m.cells[v.name]?.[colorBy]
      const s = c && c.value !== null && !c.noisy ? Math.abs(c.value) / max : 0
      return handleInfo(v, m.cells[v.name], m.metrics, colorBy, colMax, s)
    })
  }, [m, colorBy, colMax])

  if (error && !m) return <section className="panel"><div className="empty">{error}</div></section>
  if (!m) return <section className="panel"><div className="empty">Loading the explorer…</div></section>

  const listMax = Math.max(1e-30, ...m.variables.map((v) => {
    const c = m.cells[v.name]?.[colorBy]
    return c && c.value !== null && !c.noisy ? Math.abs(c.value) : 0
  }))
  const openRow = (v: string) => { selectCell(v, colorBy); setTab('matrix') }

  return (
    <>
      <div className="ex-toolbar">
        <div className="field">
          <span className="lbl">Overlay</span>
          <div className="seg" role="group" aria-label="Overlay">
            {OVERLAYS.map(([k, l]) => (
              <button key={k} className={overlay === k ? 'on' : ''} disabled={k === 'sens'} onClick={() => setOverlay(k)}
                title={k === 'sens' ? 'Unavailable: the sensitivity map has not been computed yet' : k === 'none' ? undefined : `${l} (analytic cavity model, MOCK)`}>{l}</button>
            ))}
          </div>
        </div>
        <div className="field" style={{ width: 270 }}>
          <label className="lbl" htmlFor="ex-colorby">Color handles by</label>
          <select id="ex-colorby" className="input" value={colorBy} onChange={(e) => setColorBy(e.target.value)}>
            {m.metrics.filter((x) => !x.na).map((x) => <option key={x.name} value={x.name}>{x.long} ({x.name})</option>)}
          </select>
        </div>
        <div className="field" style={{ minWidth: 240, flex: 1, maxWidth: 340 }}>
          <label className="lbl" htmlFor="ex-freq">Frequency · {f.toFixed(3)} GHz{fr && Math.abs(f - fr) < 5e-4 ? ' (resonance)' : ''}</label>
          <input id="ex-freq" type="range" min={f_start} max={f_stop} step={0.001} value={f} onChange={(e) => setFreq(+e.target.value)} disabled={overlay === 'none'} />
        </div>
        <button className={`btn ${animate ? 'dark' : ''}`} disabled={overlay === 'none'} onClick={() => setAnimate(!animate)} aria-pressed={animate}>
          {animate ? 'Stop phase' : 'Animate phase'}
        </button>
      </div>
      <ComputeNotice m={m} />
      <div className="ex-layout">
        <section className="panel ex-vars">
          <div className="panel-head">
            <h2>Variables</h2>
            <button className="btn sm" onClick={() => setBuilder('variable')}>+ New variable</button>
          </div>
          <div className="small muted" style={{ marginBottom: 8 }}>Effect on {metric?.label ?? colorBy} of a +5% change</div>
          <div className="ex-varlist">
            {m.variables.map((v) => {
              const c = m.cells[v.name]?.[colorBy]
              const w = c && c.value !== null && !c.noisy ? (100 * Math.abs(c.value)) / listMax : 0
              const sel = selectedVar === v.name
              return (
                <div key={v.name} className={`ex-var ${sel ? 'sel' : ''}`} role="button" tabIndex={0}
                  onClick={() => selectVar(sel ? null : v.name)} onKeyDown={(e) => { if (e.key === 'Enter') selectVar(sel ? null : v.name) }}>
                  <div className="ex-var-head">
                    <span className="mono nm">{v.name}</span>
                    {v.kind === 'derived' && <span className="tag custom">custom</span>}
                    <span className="mono val">{fmtNum(v.value, 4)}{v.unit ? ` ${v.unit}` : ''}</span>
                  </div>
                  {v.kind === 'derived' && (
                    <div className="mono small muted">= {v.expression} {v.hold_constant?.length ? `(holds ${v.hold_constant.join(', ')})` : '(nothing held)'}</div>
                  )}
                  <div className="ex-var-bar">
                    <div className="bar"><div style={{ width: `${w}%`, background: c?.value && c.value < 0 ? 'var(--orange)' : 'var(--blue)' }} /></div>
                    <span className="mono small">{c && c.value !== null ? `${fmtSigned(c.value)} ${c.unit}` : 'n/a'}{c?.noisy ? ' · noisy' : ''}</span>
                  </div>
                  {sel && (
                    <div className="small" style={{ marginTop: 6 }}>
                      {v.handle ? <span className="muted">Moves {v.handle.moves}. </span> : v.kind === 'base' && <span className="muted">Material parameter (no handle). </span>}
                      <button className="show-all" style={{ margin: 0 }} onClick={(e) => { e.stopPropagation(); openRow(v.name) }}>Open its row in the effect matrix →</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
        <section className="panel ex-view">
          <Suspense fallback={<div className="viewport-wrap" />}>
            <ExplorerViewport objects={objects} g={g} overlay={overlay} freq={f} animate={animate} handles={handles}
              selected={selectedVar} onSelect={(v) => selectVar(v)} />
          </Suspense>
          <div className="ex-legend-box">
            {(overlay === 'E' || overlay === 'J') && (
              <>
                <b>{overlay === 'E' ? '|E|' : '|Js|'} at {f.toFixed(2)} GHz</b> <MockBadge />
                <div className="fp-bar" style={{ background: turboCss(), marginTop: 4 }} />
                <div className="fp-ticks"><span>low</span><span>analytic cavity model</span><span>high</span></div>
              </>
            )}
            <div className="small" style={{ marginTop: 4 }}>
              Handles: <b style={{ color: strengthColor(1) }}>strong effect</b> · <b style={{ color: strengthColor(0) }}>weak effect</b> on {metric?.label}
            </div>
          </div>
        </section>
      </div>
      {builder === 'variable' && (
        <div className="overlay" onClick={() => setBuilder(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="nv-title">
            <div className="panel-head"><h2 id="nv-title">New variable</h2><button className="btn sm" onClick={() => setBuilder(null)}>Close</button></div>
            <VariableBuilder onDone={() => setBuilder(null)} />
          </div>
        </div>
      )}
    </>
  )
}
