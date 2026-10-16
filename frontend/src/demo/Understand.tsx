import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { LineChart } from '../components/charts/LineChart'
import { Contour, CONTOUR_LEGEND, contourRamp } from './Contour'
import { useTheme } from './theme'
import {
  type BaseKey, type Metric, type Param, BASE_KEYS, METRIC_EXAMPLES, PARAM_EXAMPLES, CURVES, METRIC_SCALARS, STEP,
  effectRow, fmtSigned, makeMetric, makeParam, s11At, sweepParam,
} from './effects'
import { ExprError } from './expr'
import { type Design, VARS, excitation, metrics } from './model'
import { FIELD_COLORS, type FieldKind, THICK, phaseLabel } from './fieldsConst'
import { SmithPane } from './SmithPane'
import { SolveReport } from './SolveReport'
import { Workspace, layoutFrom, useSize, useWS } from './Workspace'
import { ArrayDesignerPane, ScanPane, UVPane } from './ArrayTools'
import { FreqScrubber } from './Scrubber'
import { RunTree } from './RunTree'
import { allMetrics, allParams, useDemo } from './store'
import type { DimInfo } from './EffectScene'

const EffectScene = lazy(() => import('./EffectScene').then((m) => ({ default: m.EffectScene })))
const FieldsScene = lazy(() => import('./FieldsScene').then((m) => ({ default: m.FieldsScene })))
const effectColor = (v: number, s: number) => {
  const t = Math.min(1, Math.max(0, s)) ** 0.7, to = v >= 0 ? [207, 69, 32] : [44, 74, 114], w = [181, 174, 159]
  return `rgb(${w.map((x, i) => Math.round(x + (to[i] - x) * t)).join(',')})`
}
const unitOf = (m: Metric) => (m.unit ? ` ${m.unit}` : '')
/** Lower-case a name for use mid-sentence, leaving acronyms like S11 alone. */
const lc = (n: string) => (/^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n)

/** Effects of +5% in every parameter on one metric, with strengths relative to the biggest. */
function useEffects(d: Design, m: Metric, params: Param[]) {
  return useMemo(() => {
    const vs = effectRow(d, m, params)
    const max = Math.max(...vs.map((v) => (Number.isFinite(v) ? Math.abs(v) : 0)), 1e-12)
    return params.map((p, i) => ({ p, v: vs[i], strength: Number.isFinite(vs[i]) ? Math.abs(vs[i]) / max : 0 }))
  }, [d, m, params])
}

// ---------------------------------------------------------------- effects card (geometry + bars)

function summary(m: Metric, rows: { p: Param; v: number; strength: number }[]) {
  const sorted = [...rows].filter((r) => Number.isFinite(r.v)).sort((a, b) => b.strength - a.strength)
  if (!sorted.length || sorted[0].strength === 0) return <>Nothing here moves {lc(m.name)} at this design.</>
  const [a, b] = sorted
  const quiet = sorted.filter((r) => r.strength < 0.08)
  const say = (r: typeof a) => <><b>{r.p.name.toLowerCase()}</b> ({fmtSigned(r.v)}{unitOf(m)})</>
  return (
    <>
      {m.name} is driven mostly by {say(a)}{b && b.strength >= 0.15 ? <> and {say(b)}</> : null}.
      {quiet.length > 0 && <> {quiet.length === 1 ? quiet[0].p.name : `${quiet.length} others`} barely move it.</>}
    </>
  )
}

function Bars({ m, rows, sel, hover, onPick, onHover }: { m: Metric; rows: { p: Param; v: number; strength: number }[]; sel: string; hover: string | null; onPick: (id: string) => void; onHover: (id: string | null) => void }) {
  const sorted = [...rows].sort((a, b) => (Number.isFinite(b.v) ? Math.abs(b.v) : -1) - (Number.isFinite(a.v) ? Math.abs(a.v) : -1))
  return (
    <div className="bars">
      {sorted.map((r) => (
        <button key={r.p.id} className={`bar-row${sel === r.p.id ? ' on' : ''}${hover === r.p.id ? ' hot' : ''}`} onClick={() => onPick(r.p.id)}
          onMouseEnter={() => onHover(r.p.id)} onMouseLeave={() => onHover(null)}>
          <span className="bn">{r.p.name}{r.p.custom && <i>custom</i>}</span>
          <span className="bt">
            <span className="b0" />
            {Number.isFinite(r.v) && <span className="bf" style={{ background: effectColor(r.v, r.strength), width: `${Math.max(1, r.strength * 50)}%`, ...(r.v >= 0 ? { left: '50%' } : { right: '50%' }) }} />}
          </span>
          <span className="bv">{Number.isFinite(r.v) ? fmtSigned(r.v) : 'n/a'}<small>{m.unit}</small></span>
        </button>
      ))}
    </div>
  )
}

/** For the selected parameter and metric: the actual before/after numbers behind one bar. */
function NumberSource({ d, p, m }: { d: Design; p: Param; m: Metric }) {
  const d2 = p.apply(d, 1 + STEP)
  const before = m.value(d), after = m.value(d2)
  const moved = BASE_KEYS.filter((k) => Math.abs((d2[k] as number) - (d[k] as number)) > 1e-9)
  const un = (k: BaseKey) => { const v = VARS.find((x) => x.key === k)!; return { name: v.name.toLowerCase(), u: v.unit, f: v.fmt } }
  return (
    <div className="nsrc">
      <div className="nsrc-h">Where <b>{fmtSigned(after - before)}{unitOf(m)}</b> comes from</div>
      <ol>
        <li>Today: {lc(p.name)} is <b>{p.fmt(p.value(d))}{p.unit ? ` ${p.unit}` : ''}</b> and {lc(m.name)} is <b>{m.fmt(before)}{unitOf(m)}</b>.</li>
        <li>Make {lc(p.name)} 5% bigger: <b>{p.fmt(p.value(d2))}{p.unit ? ` ${p.unit}` : ''}</b>{p.custom ? <> (that moves {moved.map((k, i) => <span key={k}>{i ? ', ' : ''}{un(k).name} {un(k).f(d[k] as number)} → {un(k).f(d2[k] as number)}{un(k).u ? ` ${un(k).u}` : ''}</span>)})</> : null}. Nothing else changes.</li>
        <li>Evaluate the antenna again: {lc(m.name)} becomes <b>{m.fmt(after)}{unitOf(m)}</b>.</li>
        <li>Difference: {m.fmt(after)} − {m.fmt(before)} = <b>{fmtSigned(after - before)}{unitOf(m)}</b>. That's the bar.</li>
      </ol>
      <div className="nsrc-f">In this demo "evaluate" is a fast patch model (cavity and transmission-line equations, about a millisecond). In the product it's the solver: a re-run of that one change, or an adjoint sensitivity taken from the last run at no extra cost.</div>
    </div>
  )
}

export function EffectsPane({ onBuild }: { onBuild: (k: 'param' | 'metric') => void }) {
  const s = useDemo()
  const [hover, setHover] = useState<string | null>(null)
  const params = useMemo(() => allParams(s), [s.customParams]) // eslint-disable-line react-hooks/exhaustive-deps
  const mets = useMemo(() => allMetrics(s), [s.customMetrics]) // eslint-disable-line react-hooks/exhaustive-deps
  const f = s.fq ?? Math.round(metrics(s.design).f0 * 1000) / 1000
  const s11m = useMemo(() => s11At(f), [f])
  const m = s.geoMetric === 's11f' ? s11m : mets[s.sel.m] ?? mets[0]
  const rows = useEffects(s.design, m, params)
  const infos: DimInfo[] = rows.map((r) => ({ ...r, text: Number.isFinite(r.v) ? `${fmtSigned(r.v)}${unitOf(m)}` : 'n/a' }))
  const p = params[s.sel.v] ?? params[0]
  const pickParam = (id: string) => s.selectParam(params.findIndex((x) => x.id === id))
  return (
    <div className="pane effects">
      <div className="chips">
        <span className="chips-l">metric</span>
        {mets.map((x) => (
          <button key={x.id} className={`chip${s.geoMetric === 'sel' && m.id === x.id ? ' on' : ''}`} onClick={() => s.setGeoMetric(x.id)}>
            {x.name}{x.custom && <i>custom</i>}
          </button>
        ))}
        <button className={`chip${s.geoMetric === 's11f' ? ' on' : ''}`} onClick={() => s.setGeoMetric('s11f')}>S11 at a frequency</button>
        <button className="chip add" onClick={() => onBuild('metric')}>+ metric</button>
      </div>
      <div className="eff-body">
        <div className="geo">
          <Suspense fallback={null}>
            <EffectScene d={s.design} view="effects" f={f} infos={infos} sel={p.id} hover={hover} onPick={pickParam} onHover={setHover} />
          </Suspense>
          <div className="geo-key">
            <div>each dimension: change in <b>{lc(m.name)}</b> if only it grows 5%</div>
            <div className="gk-row"><span><i style={{ background: effectColor(1, 1) }} />raises it</span><span><i style={{ background: effectColor(-1, 1) }} />lowers it</span><span><i style={{ background: effectColor(1, 0) }} />little effect</span></div>
          </div>
          <div className="hint">drag to orbit · scroll to zoom · click a dimension</div>
        </div>
        <div className="eff-side">
          <p className="eff-sum">{summary(m, rows)}</p>
          <div className="eff-cap">change in {lc(m.name)}{m.unit ? ` (${m.unit})` : ''} when one parameter grows 5%</div>
          <Bars m={m} rows={rows} sel={p.id} hover={hover} onPick={pickParam} onHover={setHover} />
          <button className="chip add" onClick={() => onBuild('param')}>+ parameter</button>
          <NumberSource d={s.design} p={p} m={m} />
        </div>
      </div>
      {s.geoMetric === 's11f' && <FreqScrubber d={s.design} f={f} onF={s.setFq} />}
    </div>
  )
}

const FIELD_TEXT: Record<FieldKind, [string, string]> = {
  E: ['Electric field E', 'Between patch and ground. Strongest at the two ends, pointing opposite ways, zero in the middle. It bulges out past the ends; that bulge is what radiates.'],
  H: ['Magnetic field H', 'Wraps around the current, across the width. Strongest in the middle, zero at the ends. A quarter cycle behind E.'],
  J: ['Surface current J', 'Runs along the length of the patch, fed from the line, back and forth every cycle. Strongest in the middle.'],
  S: ['Power flow S = E × H', 'Inside, energy sloshes between the ends and the middle twice a cycle. On average it leaves upward out of the two ends: the radiated beam.'],
}

export function FieldsPane() {
  const s = useDemo()
  const d = s.design
  const f = s.fq ?? Math.round(metrics(d).f0 * 1000) / 1000
  const [show, setShow] = useState<FieldKind[]>(['E', 'J'])
  const [style, setStyle] = useState<'vectors' | 'lines'>('vectors')
  const [playing, setPlaying] = useState(true)
  const [phase, setPhase] = useState(0)
  const ph = useRef(0)
  const [label, setLabel] = useState('0.00 T')
  useEffect(() => { const t = setInterval(() => setLabel(phaseLabel(ph.current)), 120); return () => clearInterval(t) }, [])
  const toggle = (k: FieldKind) => setShow((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]))
  const amp = excitation(f, d)
  return (
    <div className="pane fieldsp">
      <div className="chips">
        <span className="chips-l">show</span>
        {(['E', 'H', 'J', 'S'] as FieldKind[]).map((k) => (
          <button key={k} className={`chip fk${show.includes(k) ? ' on' : ''}`} style={show.includes(k) ? { background: FIELD_COLORS[k], borderColor: FIELD_COLORS[k] } : undefined} onClick={() => toggle(k)}>{FIELD_TEXT[k][0]}</button>
        ))}
        <div className="seg" style={{ marginLeft: 'auto' }}>
          <button className={style === 'vectors' ? 'on' : ''} onClick={() => setStyle('vectors')}>Vectors</button>
          <button className={style === 'lines' ? 'on' : ''} onClick={() => setStyle('lines')}>Field lines</button>
        </div>
      </div>
      <div className="fieldsp-body">
        <div className="geo">
          <Suspense fallback={null}>
            <FieldsScene d={d} show={show} style={style} amp={amp} playing={playing} phase={phase} ph={ph} />
          </Suspense>
          <div className="geo-key">
            <div><b>{f.toFixed(3)} GHz</b> · patch {Math.round(amp * 100)}% excited · t = {label}</div>
            <div className="mute">board drawn {THICK}× thicker so you can see inside</div>
          </div>
          <div className="fp-ctl">
            <button className="btn play" onClick={() => { if (playing) setPhase(ph.current); setPlaying(!playing) }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
            {!playing && <input type="range" min={0} max={6.283} step={0.01} value={phase} onChange={(e) => setPhase(parseFloat(e.target.value))} />}
          </div>
        </div>
        <div className="fieldsp-side">
          {show.length === 0 && <p className="mute">Pick a field above.</p>}
          {show.map((k) => (
            <div key={k} className="fk-note"><b style={{ color: FIELD_COLORS[k] }}>{FIELD_TEXT[k][0]}</b><p>{FIELD_TEXT[k][1]}</p></div>
          ))}
          <p className="fk-foot">{style === 'vectors' ? 'Arrow length is field strength at that point, right now in the cycle.' : 'Dashes move the way the field points; lines fade as that field passes through zero.'} Away from resonance everything shrinks.</p>
        </div>
      </div>
      <FreqScrubber d={d} f={f} onF={s.setFq} />
    </div>
  )
}

// ---------------------------------------------------------------- matrix + drill-down

export function Matrix({ onBuild }: { onBuild: (k: 'param' | 'metric') => void }) {
  const s = useDemo()
  const params = useMemo(() => allParams(s), [s.customParams]) // eslint-disable-line react-hooks/exhaustive-deps
  const mets = useMemo(() => allMetrics(s), [s.customMetrics]) // eslint-disable-line react-hooks/exhaustive-deps
  const cols = useMemo(() => mets.map((m) => effectRow(s.design, m, params)), [s.design, mets, params])
  const colMax = cols.map((c) => Math.max(...c.map((v) => (Number.isFinite(v) ? Math.abs(v) : 0)), 1e-9))
  return (
    <div className="card">
      <div className="card-h"><h3>What moves what</h3><span className="aside">change for +5% of each parameter · click a cell</span></div>
      <div className="card-b">
        <div className="matrix" style={{ gridTemplateColumns: `140px repeat(${mets.length}, minmax(0, 1fr))` }}>
          <div />
          {mets.map((x) => (
            <div key={x.id} className="mh">
              {x.name}<small>{x.unit || '–'}</small>
              {x.custom && <button className="mx" title={`= ${x.custom.src}`} onClick={() => s.removeMetric(x.id)} aria-label={`Remove ${x.name}`}>×</button>}
            </div>
          ))}
          {params.map((p, i) => (
            <div key={p.id} style={{ display: 'contents' }}>
              <div className={`rh${s.sel.v === i ? ' on' : ''}`} title={p.custom ? `= ${p.custom.src} · moves ${p.custom.free.join(', ')}` : undefined}>
                {p.name}{p.custom && <button className="mx" onClick={() => s.removeParam(p.id)} aria-label={`Remove ${p.name}`}>×</button>}
              </div>
              {mets.map((x, j) => {
                const v = cols[j][i]
                const a = Number.isFinite(v) ? Math.sqrt(Math.abs(v) / colMax[j]) : 0
                const bg = !Number.isFinite(v) ? 'var(--sheet-2)' : v >= 0 ? `rgba(207,69,32,${(a * 0.85).toFixed(3)})` : `rgba(44,74,114,${(a * 0.85).toFixed(3)})`
                return (
                  <button key={x.id} className={`cell${s.sel.v === i && s.sel.m === j ? ' hi' : ''}`} style={{ background: bg, color: a > 0.55 ? '#fff' : 'var(--ink)' }} onClick={() => s.select(i, j)}>
                    {!Number.isFinite(v) ? 'n/a' : Math.abs(v) < 0.005 ? '·' : fmtSigned(v)}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="matrix-foot">
          <div className="legend" style={{ marginTop: 0 }}><span>goes down</span><i style={{ background: 'linear-gradient(90deg, rgba(44,74,114,.85), rgba(44,74,114,0))' }} /><i style={{ background: 'linear-gradient(90deg, rgba(207,69,32,0), rgba(207,69,32,.85))' }} /><span>goes up</span></div>
          <div className="row-btns" style={{ marginTop: 0 }}>
            <button className="chip add" onClick={() => onBuild('param')}>+ parameter</button>
            <button className="chip add" onClick={() => onBuild('metric')}>+ metric</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Drill() {
  const s = useDemo()
  const [ref, size] = useSize<HTMLDivElement>()
  const params = allParams(s), mets = allMetrics(s)
  const p = params[s.sel.v] ?? params[0], m = mets[s.sel.m] ?? mets[0]
  const sw = useMemo(() => sweepParam(s.design, p, m), [s.design, p, m])
  const cur = p.value(s.design), curY = m.value(s.design)
  const ys = sw.ys.filter(Number.isFinite)
  const lo = Math.min(...ys), hi = Math.max(...ys)
  const pad = Math.max((hi - lo) * 0.15, 0.5)
  return (
    <div className="card fill" ref={ref}>
      <div className="card-h"><h3>{m.name} vs {p.name.toLowerCase()}</h3><span className="aside">±15% around the current design · pick a cell in What moves what</span></div>
      <div className="card-b chart">
        <LineChart height={Math.max(160, size.h - 70)} xDomain={[Math.min(...sw.xs), Math.max(...sw.xs)]} yDomain={[lo - pad, hi + pad]}
          xFmt={(x) => (Math.abs(x) < 10 ? x.toFixed(2) : x.toFixed(1))} yFmt={(y) => (Math.abs(hi - lo) < 5 ? y.toFixed(1) : y.toFixed(0))}
          xLabel={`${p.name.toLowerCase()}${p.unit ? ` (${p.unit})` : ''}`} yLabel={m.unit}
          hlines={m.id === 'worst' ? [{ y: -10, color: 'var(--sig)', dash: '5 4' }] : m.id === 'R' ? [{ y: 50, color: 'var(--sig)', dash: '5 4', label: '50 Ω' }] : []}
          series={[{ x: sw.xs, y: sw.ys, color: 'var(--ink)', width: 2 }]} points={[{ x: cur, y: curY, color: 'var(--sig)', r: 6 }]} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- builders

function ErrLine({ e }: { e: string | null }) {
  return e ? <div className="b-err" role="alert">{e}</div> : null
}

export function MetricBuilder({ onClose }: { onClose: () => void }) {
  const s = useDemo()
  const [name, setName] = useState(METRIC_EXAMPLES[0].name)
  const [unit, setUnit] = useState(METRIC_EXAMPLES[0].unit)
  const [src, setSrc] = useState(METRIC_EXAMPLES[0].src)
  let err: string | null = null, val: number | null = null, built: Metric | null = null
  try {
    if (!name.trim()) throw new ExprError('Give it a name', 0)
    built = makeMetric(name.trim(), unit.trim(), src)
    val = built.value(s.design)
    if (!Number.isFinite(val)) throw new ExprError("That doesn't give a number on this design", 0)
  } catch (e) { err = (e as Error).message; built = null }
  const top = useMemo(() => {
    if (!built) return []
    const params = allParams(s)
    const vs = effectRow(s.design, built, params)
    return params.map((p, i) => ({ p, v: vs[i] })).filter((x) => Number.isFinite(x.v)).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 2)
  }, [built?.custom?.src, s.design]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="builder">
      <div className="b-h"><h3>Add a metric</h3><button className="link" onClick={onClose}>close</button></div>
      <div className="b-ex">try: {METRIC_EXAMPLES.map((x) => <button key={x.name} className="chip" onClick={() => { setName(x.name); setUnit(x.unit); setSrc(x.src) }}>{x.name}</button>)}</div>
      <div className="b-row">
        <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} /></label>
        <label className="u"><span>Unit</span><input value={unit} onChange={(e) => setUnit(e.target.value)} spellCheck={false} /></label>
      </div>
      <label><span>Expression</span><input className={`mono${err ? ' bad' : ''}`} value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} /></label>
      <ErrLine e={err} />
      {built && val !== null && (
        <div className="b-prev">Now <b>{built.fmt(val)}{unitOf(built)}</b>.{top.length > 0 && <> Moved most by {top.map((t, i) => <span key={t.p.id}>{i ? ' and ' : ''}<b>{t.p.name.toLowerCase()}</b> ({fmtSigned(t.v)}{unitOf(built!)})</span>)}.</>} It gets a column in the map from the same model, no new runs.</div>
      )}
      <div className="b-help">
        Numbers: <span className="mono">{Object.keys(METRIC_SCALARS).join(' ')}</span> (f0 in GHz, bw in MHz).
        Curves: <span className="mono">{Object.keys(CURVES).join(' ')}</span>, used as <span className="mono">max/min/mean(curve, f1, f2)</span> or <span className="mono">at(curve, f)</span>.
        Also <span className="mono">sqrt abs log10 min max</span>.
      </div>
      <div className="row-btns"><button className="btn pri" disabled={!built} onClick={() => { s.addMetric(built!); onClose() }}>Add metric</button></div>
    </div>
  )
}

export function ParamBuilder({ onClose }: { onClose: () => void }) {
  const s = useDemo()
  const [name, setName] = useState(PARAM_EXAMPLES[0].name)
  const [unit, setUnit] = useState(PARAM_EXAMPLES[0].unit)
  const [src, setSrc] = useState(PARAM_EXAMPLES[0].src)
  const [hold, setHold] = useState<BaseKey[]>(PARAM_EXAMPLES[0].hold)
  const [touched, setTouched] = useState(false)
  // until the checklist is touched, hold everything except the first base parameter the expression uses
  useEffect(() => {
    if (touched) return
    const first = (src.match(/[A-Za-z_]\w*/g) ?? []).find((n) => (BASE_KEYS as string[]).includes(n))
    setHold(BASE_KEYS.filter((k) => k !== first))
  }, [src, touched])
  let err: string | null = null, built: Param | null = null, val: number | null = null
  try {
    if (!name.trim()) throw new ExprError('Give it a name', 0)
    built = makeParam(name.trim(), unit.trim(), src, hold)
    val = built.value(s.design)
    if (!Number.isFinite(val)) throw new ExprError("That doesn't give a number on this design", 0)
  } catch (e) { err = (e as Error).message; built = null }
  const moved = built ? (() => { const d2 = built.apply(s.design, 1 + STEP); return BASE_KEYS.filter((k) => Math.abs((d2[k] as number) - (s.design[k] as number)) > 1e-6).map((k) => ({ k, pct: ((d2[k] as number) / (s.design[k] as number) - 1) * 100 })) })() : []
  const label: Record<BaseKey, string> = { L: 'L length', W: 'W width', y0: 'y0 inset', h: 'h height', er: 'er εr', gs: 'gs ground' }
  return (
    <div className="builder">
      <div className="b-h"><h3>Add a parameter</h3><button className="link" onClick={onClose}>close</button></div>
      <div className="b-ex">try: {PARAM_EXAMPLES.map((x) => <button key={x.name} className="chip" onClick={() => { setName(x.name); setUnit(x.unit); setSrc(x.src); setHold(x.hold); setTouched(true) }}>{x.name}</button>)}</div>
      <div className="b-row">
        <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} /></label>
        <label className="u"><span>Unit</span><input value={unit} onChange={(e) => setUnit(e.target.value)} spellCheck={false} /></label>
      </div>
      <label><span>Expression, in terms of <span className="mono">L W y0 h er gs</span></span><input className={`mono${err ? ' bad' : ''}`} value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} /></label>
      <div className="b-hold">
        <span>When it changes, hold constant:</span>
        {BASE_KEYS.map((k) => (
          <label key={k} className="ck"><input type="checkbox" checked={hold.includes(k)} onChange={() => { setTouched(true); setHold((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k])) }} />{label[k]}</label>
        ))}
      </div>
      <ErrLine e={err} />
      {built && val !== null && (
        <div className="b-prev">Now <b>{built.fmt(val)}{built.unit ? ` ${built.unit}` : ''}</b>. Growing it 5% moves {moved.map((x, i) => <span key={x.k}>{i ? ', ' : ''}<b>{label[x.k].split(' ')[1]}</b> {x.pct >= 0 ? '+' : '−'}{Math.abs(x.pct).toFixed(1)}%</span>)}. It gets a row in the map and a dashed dimension on the model.</div>
      )}
      <div className="row-btns"><button className="btn pri" disabled={!built} onClick={() => { s.addParam(built!); onClose() }}>Add parameter</button></div>
    </div>
  )
}

// ---------------------------------------------------------------- pane

export function ContourPane() {
  const s = useDemo()
  const dark = useTheme((t) => t.dark)
  const [ref, size] = useSize<HTMLDivElement>()
  const path = s.runs.filter((r) => r.d.W === s.design.W && r.d.h === s.design.h && r.d.er === s.design.er && r.d.gs === s.design.gs).map((r) => r.d)
  return (
    <div className="card fill" ref={ref}>
      <div className="card-h"><h3>Where the good designs are</h3><span className="aside">worst in-band match · click to move there</span></div>
      <div className="card-b chart">
        <Contour d={s.design} path={path} onPick={(L, y0) => s.setDesign({ L, y0 })} height={Math.max(220, size.h - 110)} />
        <div className="legend">
          <span>dB</span>
          {CONTOUR_LEGEND.LEVELS.map((l, i) => <span key={l} className="sw"><i style={{ background: contourRamp(dark)[i] }} />{l}</span>)}
          <span className="sw"><i style={{ background: 'var(--sig)', height: 2 }} />goal</span>
        </div>
        <div className="explain small">Narrow in length, wide in inset: length sets the frequency, inset only the match. Dots are the runs.</div>
      </div>
    </div>
  )
}

// one full-size window with every view as a tab; drag a tab out to see two side by side
const DEFAULT_LAYOUT = () => layoutFrom([
  { panes: ['effects', 'smith', 'fields', 'matrix', 'drill', 'tree', 'contour', 'method'], x: 0, y: 0, w: 1, h: 1 },
])
// the array opens on its own tools; the element-level views are still there for the unit cell
const ARRAY_LAYOUT = () => layoutFrom([
  { panes: ['designer', 'uv', 'scan', 'smith', 'effects', 'fields', 'method'], x: 0, y: 0, w: 1, h: 1 },
])

let layoutKind: string | null = null

export function ExplorePane() {
  const [build, setBuild] = useState<'param' | 'metric' | null>(null)
  const kind = useDemo((x) => x.kind)
  const layout = kind === 'array' ? ARRAY_LAYOUT : DEFAULT_LAYOUT
  // switch to the right default windows when the kind of design changes (even if Explore wasn't open at the time)
  useEffect(() => { if (layoutKind !== kind) { const had = layoutKind !== null; layoutKind = kind; if (had || useWS.getState().wins.length) useWS.getState().set(layout()) } }, [kind]) // eslint-disable-line react-hooks/exhaustive-deps
  const panes = {
    effects: { title: 'Effects on geometry', render: () => <EffectsPane onBuild={setBuild} /> },
    fields: { title: 'Fields: E, H, J, S', render: () => <FieldsPane /> },
    smith: { title: 'Smith chart', render: () => <SmithPane /> },
    matrix: { title: 'What moves what', render: () => <Matrix onBuild={setBuild} /> },
    drill: { title: 'Drill-down', render: () => <Drill /> },
    tree: { title: 'How it got here', render: () => <RunTree /> },
    contour: { title: 'Where the good designs are', render: () => <ContourPane /> },
    method: { title: 'How it was solved', render: () => <SolveReport framed={false} /> },
    designer: { title: 'Array designer', render: () => <ArrayDesignerPane /> },
    uv: { title: 'u-v space', render: () => <UVPane /> },
    scan: { title: 'Scan performance', render: () => <ScanPane /> },
  }
  return (
    <div className="pane-fill">
      <Workspace panes={panes} initial={layout} />
      {build && (
        <div className="b-scrim" onClick={(e) => { if (e.target === e.currentTarget) setBuild(null) }}>
          {build === 'metric' ? <MetricBuilder onClose={() => setBuild(null)} /> : <ParamBuilder onClose={() => setBuild(null)} />}
        </div>
      )}
    </div>
  )
}
