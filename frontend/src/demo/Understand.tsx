import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { LineChart } from '../components/charts/LineChart'
import { Contour, CONTOUR_LEGEND } from './Contour'
import {
  type BaseKey, type Metric, type Param, BASE_KEYS, METRIC_EXAMPLES, PARAM_EXAMPLES, CURVES, METRIC_SCALARS, STEP,
  effectRow, fmtSigned, makeMetric, makeParam, s11At, sweepParam,
} from './effects'
import { ExprError } from './expr'
import { type Design, VARS, excitation, metrics, zin } from './model'
import { FIELD_COLORS, type FieldKind, THICK, phaseLabel } from './fieldsConst'
import { SmithPane } from './SmithPane'
import { SolveReport } from './SolveReport'
import { Workspace, layoutFrom, useSize } from './Workspace'
import { FreqScrubber } from './Scrubber'
import { RunTree } from './RunTree'
import { allMetrics, allParams, now, useDemo } from './store'
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

function EffectsPane({ onBuild }: { onBuild: (k: 'param' | 'metric') => void }) {
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

/** Side view of the patch through one cycle: charge at the ends, current through the middle, energy trading places. */
function ChargePane() {
  const s = useDemo()
  const d = s.design
  const f = s.fq ?? Math.round(metrics(d).f0 * 1000) / 1000
  const [playing, setPlaying] = useState(true)
  const [ph, setPh] = useState(0)
  const [ref, size] = useSize<HTMLDivElement>()
  useEffect(() => {
    if (!playing) return
    let raf = 0, last = now()
    const loop = () => { const n = now(); setPh((p) => (p + (n - last) * 1.6) % (2 * Math.PI)); last = n; raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  const f0 = metrics(d).f0, z = zin(f, d), ex = excitation(f, d)
  const ce = Math.cos(ph), cj = Math.sin(ph)
  const look = Math.abs(z.x) < 4 ? 'resistive' : z.x > 0 ? 'inductive' : 'capacitive'
  const W = Math.max(320, Math.min(size.w - 24, 760)), Hh = 190
  const x0 = 70, x1 = W - 70, zg = 150, zp = 92 // ground and patch heights in the drawing
  const X = (u: number) => x0 + (x1 - x0) * u
  const eArrows = [0.04, 0.13, 0.24, 0.76, 0.87, 0.96]
  const charges = (u0: number, sign: number) => Array.from({ length: 5 }, (_, i) => ({ x: X(u0 + (u0 < 0.5 ? 1 : -1) * i * 0.035), sign }))
  return (
    <div className="pane lcp" ref={ref}>
      <div className="lcp-top">
        <button className="btn play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
        {!playing && <input type="range" min={0} max={6.283} step={0.01} value={ph} onChange={(e) => setPh(parseFloat(e.target.value))} style={{ width: 160 }} />}
        <span className="mono small mute">side view, one cycle{playing ? ' (slowed down a billion times)' : ''}</span>
      </div>
      <svg width={W} height={Hh} className="lcp-svg" onClick={() => setPlaying(!playing)} style={{ cursor: 'pointer' }}>
        <defs>
          <marker id="lcE" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#2c4a72" /></marker>
          <marker id="lcJ" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="#cf4520" /></marker>
        </defs>
        <rect x={20} y={zp} width={W - 40} height={zg - zp} fill="#dfe3cf" />
        <line x1={20} x2={W - 20} y1={zg} y2={zg} stroke="#b07436" strokeWidth={5} />
        <text x={24} y={zg + 18} fontSize={11} fill="var(--mute)">ground plane</text>
        <text x={W - 24} y={zg - 8} fontSize={11} fill="var(--mute)" textAnchor="end">board</text>
        <line x1={x0} x2={x1} y1={zp} y2={zp} stroke="#b07436" strokeWidth={6} />
        <text x={(x0 + x1) / 2} y={zp - 48} fontSize={11} fill="var(--mute)" textAnchor="middle">patch, seen from the side · charge marks show + and − at the two ends</text>
        {eArrows.map((u) => {
          const v = Math.cos(Math.PI * u) * ce
          if (Math.abs(v) < 0.08) return null
          const x = X(u), dn = v > 0
          return <line key={u} x1={x} x2={x} y1={dn ? zp + 6 : zg - 6} y2={dn ? zg - 6 : zp + 6} stroke="#2c4a72" strokeWidth={1 + 2.2 * Math.abs(v)} opacity={0.25 + 0.75 * Math.abs(v)} markerEnd="url(#lcE)" />
        })}
        {[[x0, -1], [x1, 1]].map(([xe, sg]) => [16, 30].map((r) => {
          const v = (sg < 0 ? 1 : -1) * ce
          return <path key={`${xe}${r}`} d={`M${xe},${zp} C${xe + sg * r},${zp - r * 0.7} ${xe + sg * r * 1.3},${zg - 4} ${xe + sg * r * 0.6},${zg}`} fill="none" stroke="#2c4a72" strokeWidth={1.4} strokeDasharray="4 3" opacity={0.15 + 0.7 * Math.abs(v)} markerEnd={v > 0 ? 'url(#lcE)' : undefined} markerStart={v < 0 ? 'url(#lcE)' : undefined} />
        }))}
        {[...charges(0.02, 1), ...charges(0.98, -1)].map((q, i) => {
          const sign = q.sign * Math.sign(ce)
          return <text key={i} x={q.x} y={zp - 8} fontSize={19} fontWeight={700} textAnchor="middle" fill={sign > 0 ? '#cf4520' : '#2c4a72'} opacity={0.15 + 0.85 * Math.abs(ce)}>{sign > 0 ? '+' : '−'}</text>
        })}
        {Math.abs(cj) > 0.06 && (
          <line x1={cj > 0 ? X(0.3) : X(0.7)} x2={cj > 0 ? X(0.7) : X(0.3)} y1={zp - 14} y2={zp - 14} stroke="#cf4520" strokeWidth={2 + 4 * Math.abs(cj)} opacity={0.3 + 0.7 * Math.abs(cj)} markerEnd="url(#lcJ)" />
        )}
        {Math.abs(cj) > 0.06 && <text x={X(0.5)} y={zp - 24} fontSize={11.5} textAnchor="middle" fill="#cf4520" opacity={0.4 + 0.6 * Math.abs(cj)}>current</text>}
        <text x={X(0.12)} y={zg + 30} fontSize={11.5} textAnchor="middle" fill="#2c4a72" opacity={0.35 + 0.65 * Math.abs(ce)}>electric field</text>
        <text x={X(0.88)} y={zg + 30} fontSize={11.5} textAnchor="middle" fill="#2c4a72" opacity={0.35 + 0.65 * Math.abs(ce)}>electric field</text>
      </svg>
      <div className="lcp-energy-h">where the energy is right now <span>· moves with the animation, swaps twice a cycle · click to {playing ? 'pause' : 'play'}</span></div>
      <div className="lcp-energy" onClick={() => setPlaying(!playing)} style={{ cursor: 'pointer' }}>
        <span>energy in the ends (electric, like a capacitor)</span><div className="track"><div className="fill" style={{ width: `${ce * ce * 100}%`, background: '#2c4a72' }} /></div>
        <span>energy in the middle (magnetic, like an inductor)</span><div className="track"><div className="fill" style={{ width: `${cj * cj * 100}%`, background: '#cf4520' }} /></div>
      </div>
      <ol className="lcp-text">
        <li><b className="cap">The ends hold charge.</b> One end goes +, the other −. The electric field between patch and ground there stores energy, like a capacitor.</li>
        <li><b className="ind">The middle carries current.</b> That charge flows through the middle to the other end, and the magnetic field around it stores energy, like an inductor.</li>
        <li><b>Resonance is the rhythm of that hand-off</b>: {f0.toFixed(3)} GHz for this patch. A longer patch means a longer trip, so a lower frequency. That's why patch length moves resonance so much.</li>
      </ol>
      <div className={`fp-read ${look}`}>
        <div>At <b>{f.toFixed(2)} GHz</b> the input looks <b>{look}</b> ({z.r.toFixed(0)} {z.x >= 0 ? '+' : '−'} j{Math.abs(z.x).toFixed(0)} Ω)</div>
        <small>{f < f0 - 0.005 ? 'below resonance the current (inductor) side wins' : f > f0 + 0.005 ? 'above resonance the charge (capacitor) side wins' : 'at resonance the two cancel and only resistance is left'} · the patch is {Math.round(ex * 100)}% excited here</small>
      </div>
      <FreqScrubber d={d} f={f} onF={s.setFq} />
    </div>
  )
}

const FIELD_TEXT: Record<FieldKind, [string, string]> = {
  E: ['Electric field E', 'Between patch and ground. Strongest at the two ends, pointing opposite ways, zero in the middle. It bulges out past the ends; that bulge is what radiates.'],
  H: ['Magnetic field H', 'Wraps around the current, across the width. Strongest in the middle, zero at the ends. A quarter cycle behind E.'],
  J: ['Surface current J', 'Runs along the length of the patch, fed from the line, back and forth every cycle. Strongest in the middle.'],
  S: ['Power flow S = E × H', 'Inside, energy sloshes between the ends and the middle twice a cycle. On average it leaves upward out of the two ends: the radiated beam.'],
}

function FieldsPane() {
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
          <p className="fk-foot">{style === 'vectors' ? 'Arrow length is field strength at that point, right now in the cycle.' : 'Dashes move the way the field points; lines fade as that field passes through zero.'} Frequency follows the slider in Charge &amp; current. Away from resonance everything shrinks.</p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- matrix + drill-down

function Matrix({ onBuild }: { onBuild: (k: 'param' | 'metric') => void }) {
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

function Drill() {
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

function MetricBuilder({ onClose }: { onClose: () => void }) {
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

function ParamBuilder({ onClose }: { onClose: () => void }) {
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

function ContourPane() {
  const s = useDemo()
  const [ref, size] = useSize<HTMLDivElement>()
  const path = s.runs.filter((r) => r.d.W === s.design.W && r.d.h === s.design.h && r.d.er === s.design.er && r.d.gs === s.design.gs).map((r) => r.d)
  return (
    <div className="card fill" ref={ref}>
      <div className="card-h"><h3>Where the good designs are</h3><span className="aside">worst in-band match · click to move there</span></div>
      <div className="card-b chart">
        <Contour d={s.design} path={path} onPick={(L, y0) => s.setDesign({ L, y0 })} height={Math.max(220, size.h - 110)} />
        <div className="legend">
          <span>dB</span>
          {CONTOUR_LEGEND.LEVELS.map((l, i) => <span key={l} className="sw"><i style={{ background: CONTOUR_LEGEND.RAMP[i] }} />{l}</span>)}
          <span className="sw"><i style={{ background: 'var(--sig)', height: 2 }} />goal</span>
        </div>
        <div className="explain small">Narrow in length, wide in inset: length sets the frequency, inset only the match. Dots are the runs.</div>
      </div>
    </div>
  )
}

const DEFAULT_LAYOUT = () => layoutFrom([
  { panes: ['effects', 'fields', 'charge'], x: 0, y: 0, w: 0.6, h: 0.6 },
  { panes: ['smith'], x: 0.6, y: 0, w: 0.4, h: 0.6 },
  { panes: ['matrix', 'drill'], x: 0, y: 0.6, w: 0.55, h: 0.4 },
  { panes: ['tree', 'contour'], x: 0.55, y: 0.6, w: 0.45, h: 0.4 },
])

export function ExplorePane() {
  const [build, setBuild] = useState<'param' | 'metric' | null>(null)
  const panes = {
    effects: { title: 'Effects on geometry', render: () => <EffectsPane onBuild={setBuild} /> },
    fields: { title: 'Fields: E, H, J, S', render: () => <FieldsPane /> },
    charge: { title: 'Charge & current', render: () => <ChargePane /> },
    smith: { title: 'Smith chart', render: () => <SmithPane /> },
    matrix: { title: 'What moves what', render: () => <Matrix onBuild={setBuild} /> },
    drill: { title: 'Drill-down', render: () => <Drill /> },
    tree: { title: 'How it got here', render: () => <RunTree /> },
    contour: { title: 'Where the good designs are', render: () => <ContourPane /> },
    method: { title: 'How it was solved', render: () => <SolveReport framed={false} /> },
  }
  return (
    <div className="pane-fill">
      <Workspace panes={panes} initial={DEFAULT_LAYOUT} />
      {build && (
        <div className="b-scrim" onClick={(e) => { if (e.target === e.currentTarget) setBuild(null) }}>
          {build === 'metric' ? <MetricBuilder onClose={() => setBuild(null)} /> : <ParamBuilder onClose={() => setBuild(null)} />}
        </div>
      )}
    </div>
  )
}
