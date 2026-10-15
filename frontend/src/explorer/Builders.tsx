import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { exApi } from './api'
import { fmtNum, useExplorer } from './store'

type Preview = { errors: { msg: string; pos?: number }[]; warnings: string[]; value: number | null; unit: string | null
  drives?: { var: string; dp_dq: number; unit: string }[] }

const BASE = ['L_res', 'W', 'feed_x', 'h', 'eps_r', 'margin']

/** Debounced server-side validation: the backend owns the (eval-free) parser, so preview and save agree. */
function usePreview(kind: 'variable' | 'metric', body: Record<string, unknown>, enabled: boolean) {
  const pid = useStore((s) => s.project.name)
  const runId = useExplorer((s) => s.runId)
  const [p, setP] = useState<Preview | null>(null)
  const key = JSON.stringify(body)
  useEffect(() => {
    if (!enabled) { setP(null); return }
    let live = true
    const t = setTimeout(async () => {
      try {
        const r = await exApi.preview(pid, { kind, run_id: runId, ...body })
        if (live) setP(r)
      } catch (e: any) {
        if (live) setP({ errors: [{ msg: e.message }], warnings: [], value: null, unit: null })
      }
    }, 280)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, pid, runId])
  return p
}

function Issues({ p }: { p: Preview | null }) {
  if (!p) return null
  return (
    <>
      {p.errors.map((e, i) => <div key={`e${i}`} className="err-text" role="alert">{e.msg}</div>)}
      {p.warnings.map((w, i) => <div key={`w${i}`} className="small warn-text">Warning: {w}</div>)}
    </>
  )
}

export function VariableBuilder({ onDone }: { onDone?: () => void }) {
  const pid = useStore((s) => s.project.name)
  const { runId, refresh } = useExplorer()
  const [name, setName] = useState('feed_ratio')
  const [expression, setExpression] = useState('feed_x / (L_res / 2)')
  const [hold, setHold] = useState<string[]>(['L_res', 'W', 'h', 'eps_r'])
  const [touchedHold, setTouchedHold] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  // until the user edits the checklist, hold everything except the first base variable in the expression
  useEffect(() => {
    if (touchedHold) return
    const first = (expression.match(/[A-Za-z_]\w*/g) ?? []).find((n) => BASE.includes(n))
    setHold(BASE.filter((b) => b !== first))
  }, [expression, touchedHold])
  const p = usePreview('variable', { name, expression, hold_constant: hold }, !!name.trim() && !!expression.trim())
  const ok = p && !p.errors.length
  const add = async () => {
    setBusy(true); setMsg(null)
    try {
      await exApi.addVariable(pid, { name: name.trim(), expression, hold_constant: hold, run_id: runId })
      setMsg(`Added ${name}. Its row fills from the chain rule, with no new runs.`)
      await refresh()
      onDone?.()
    } catch (e: any) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="builder">
      <div className="builder-row">
        <div className="field" style={{ flex: '0 0 34%' }}>
          <label htmlFor="nv-name">Name</label>
          <input id="nv-name" className="input mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="nv-expr">Expression</label>
          <input id="nv-expr" className={`input mono ${p?.errors.length ? 'err' : ''}`} value={expression}
            onChange={(e) => setExpression(e.target.value)} spellCheck={false} placeholder="e.g. W / L_res" />
        </div>
      </div>
      <div className="section-title" style={{ marginTop: 14 }}>When {name || 'it'} changes, hold constant:</div>
      <div className="row wrap" style={{ gap: 18 }}>
        {BASE.map((b) => (
          <label key={b} className="check mono" style={{ minHeight: 30 }}>
            <input type="checkbox" checked={hold.includes(b)}
              onChange={() => { setTouchedHold(true); setHold((h) => (h.includes(b) ? h.filter((x) => x !== b) : [...h, b])) }} />
            {b}
          </label>
        ))}
      </div>
      <div className="builder-preview small">
        <Issues p={p} />
        {ok && (
          <span className="muted">
            Now {fmtNum(p!.value, 4)}{p!.unit ? ` ${p!.unit}` : ''}. So {name} drives:{' '}
            {p!.drives!.map((d, i) => (
              <span key={d.var}>{i > 0 && ', '}<b className="mono">{d.var}</b> (∂{d.var}/∂{name} = {fmtNum(d.dp_dq)}{d.unit ? ` ${d.unit}` : ''})</span>
            ))}
            {p!.drives!.length > 1 && ' (minimum-norm move in normalised units)'}. Effects come from the chain rule, with no new simulations.
          </span>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!ok || busy} onClick={add}>Add variable</button>
        {msg && <span className="small muted" role="status">{msg}</span>}
      </div>
    </div>
  )
}

export function MetricBuilder() {
  const pid = useStore((s) => s.project.name)
  const goal = useStore((s) => s.project.goal)
  const { runId, refresh, matrix } = useExplorer()
  const [name, setName] = useState('goal_margin_dB')
  const [unit, setUnit] = useState('dB')
  const [expression, setExpression] = useState(`${goal.threshold_db} - max(S11_dB, ${goal.f1.toFixed(2)}, ${goal.f2.toFixed(2)})`)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const p = usePreview('metric', { name, expression, unit }, !!name.trim() && !!expression.trim())
  const ok = p && !p.errors.length
  const add = async () => {
    setBusy(true); setMsg(null)
    try {
      await exApi.addMetric(pid, { name: name.trim(), expression, unit, run_id: runId })
      setMsg(`Added ${name}. Its column fills from the existing runs.`)
      await refresh()
    } catch (e: any) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }
  const scalars = matrix?.metrics.filter((m) => m.kind === 'standard' && !m.na).map((m) => m.name) ?? []
  return (
    <div className="builder">
      <div className="builder-row">
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="nm-name">Name</label>
          <input id="nm-name" className="input mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </div>
        <div className="field" style={{ flex: '0 0 22%' }}>
          <label htmlFor="nm-unit">Unit</label>
          <input id="nm-unit" className="input mono" value={unit} onChange={(e) => setUnit(e.target.value)} spellCheck={false} />
        </div>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="nm-expr">Expression</label>
        <input id="nm-expr" className={`input mono ${p?.errors.length ? 'err' : ''}`} value={expression}
          onChange={(e) => setExpression(e.target.value)} spellCheck={false} />
      </div>
      <div className="builder-preview small">
        <Issues p={p} />
        {ok && <span className="muted">Now {fmtNum(p!.value, 4)} {p!.unit} on the verified result.</span>}
      </div>
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Built from standard metrics: <span className="mono">{scalars.join(', ')}</span>; band functions{' '}
        <span className="mono">max/min/mean(X, f1, f2)</span>, <span className="mono">at(X, f)</span>, <span className="mono">argmin(X, f1, f2)</span>{' '}
        over <span className="mono">S11_dB, S11_mag, S11_phase, Zin_re, Zin_im, VSWR</span> (f in GHz); and{' '}
        <span className="mono">sqrt abs log10 min max mean</span>. Gain and axial ratio need far-field export.
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!ok || busy} onClick={add}>Add metric</button>
        {msg && <span className="small muted" role="status">{msg}</span>}
      </div>
    </div>
  )
}
