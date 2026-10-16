import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { LineChart, type Series } from '../components/charts/LineChart'
import {
  ARRAY_GOAL, type ArrayDesign, F0, PAPER_ARRAY, PAPER_BEAMS, SCAN_MAX, STEERS, type Taper, activeS11, arrayMetrics, beam, excitation,
  glFreeScan, lambda, patternGrid,
} from './arrayModel'
import { useDemo } from './store'
import { SolveReport } from './SolveReport'
import { useTheme } from './theme'

const ArrayScene = lazy(() => import('./ArrayScene').then((m) => ({ default: m.ArrayScene })))
const f1 = (v: number, n = 1) => v.toFixed(n)
const TAPERS: [Taper, string][] = [['uniform', 'Uniform'], ['taylor', 'Taylor'], ['cheb', 'Chebyshev']]

function Num({ label, value, min, max, step, unit, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="ad-num">
      <span>{label}<b>{fmt ? fmt(value) : value}{unit ? ` ${unit}` : ''}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  )
}

/** Every control a phased-array designer reaches for, on the live array. */
function Controls() {
  const s = useDemo(), a = s.arr, set = s.setArr
  const L = lambda(F0)
  const exportCsv = () => {
    const rows = excitation(a).map((e) => [e.i + 1, e.ix + 1, e.iy + 1, e.x.toFixed(2), e.y.toFixed(2), e.amp.toFixed(4), (20 * Math.log10(Math.max(e.amp, 1e-6))).toFixed(2), e.phase.toFixed(2), e.on ? 1 : 0].join(','))
    const csv = ['element,col,row,x_mm,y_mm,amplitude,amplitude_dB,phase_deg,on', ...rows].join('\n')
    const el = document.createElement('a'); el.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); el.download = `beam_${a.theta}deg_phi${a.phi}.csv`; el.click()
  }
  return (
    <div className="ad-ctl">
      <div className="ad-h">Aperture</div>
      <div className="ad-2">
        <Num label="columns" value={a.nx} min={2} max={16} step={1} onChange={(v) => set({ nx: v, failed: [] })} />
        <Num label="rows" value={a.ny} min={1} max={16} step={1} onChange={(v) => set({ ny: v, failed: [] })} />
      </div>
      <Num label="spacing x" value={a.dx} min={30} max={110} step={0.5} unit="mm" fmt={(v) => `${f1(v)} (${f1(v / L, 2)} λ)`} onChange={(v) => set({ dx: v })} />
      <Num label="spacing y" value={a.dy} min={30} max={110} step={0.5} unit="mm" fmt={(v) => `${f1(v)} (${f1(v / L, 2)} λ)`} onChange={(v) => set({ dy: v })} />
      <button className="link" onClick={() => set({ dy: a.dx })}>make square</button>
      <div className="ad-h">Beam</div>
      <Num label="steer θ" value={a.theta} min={0} max={70} step={1} unit="°" onChange={(v) => set({ theta: v })} />
      <Num label="plane φ" value={a.phi} min={0} max={90} step={5} unit="°" onChange={(v) => set({ phi: v })} />
      <div className="ad-h">Amplitude taper</div>
      <div className="seg">{TAPERS.map(([k, n]) => <button key={k} className={a.taper === k ? 'on' : ''} onClick={() => set({ taper: k })}>{n}</button>)}</div>
      {a.taper !== 'uniform' && <Num label="design sidelobes" value={a.sll} min={15} max={40} step={1} unit="dB" fmt={(v) => `−${v}`} onChange={(v) => set({ sll: v })} />}
      <div className="ad-h">Beam steering hardware</div>
      <div className="seg">{[0, 6, 5, 4, 3, 2].map((b) => <button key={b} className={a.bits === b ? 'on' : ''} onClick={() => set({ bits: b })}>{b ? `${b}-bit` : 'ideal'}</button>)}</div>
      <div className="seg">
        <button className={!a.ttd ? 'on' : ''} onClick={() => set({ ttd: false })}>Phase shifters</button>
        <button className={a.ttd ? 'on' : ''} onClick={() => set({ ttd: true })}>True-time delay</button>
      </div>
      <Num label="frequency" value={a.f} min={2.2} max={2.7} step={0.005} unit="GHz" fmt={(v) => f1(v, 3)} onChange={(v) => set({ f: v })} />
      <div className="ad-h">Failures</div>
      <div className="ad-row">
        <span className="mono small">{a.failed.length ? `${a.failed.length} off` : 'all working'}</span>
        <button className="link" onClick={() => set({ failed: [] })}>restore all</button>
        <button className="link" onClick={() => { const n = a.nx * a.ny; set({ failed: [Math.floor(Math.random() * n)] }) }}>fail a random one</button>
      </div>
      <div className="ad-row">
        <button className="btn" onClick={() => set({ ...PAPER_ARRAY, failed: [] })}>Paper's array</button>
        <button className="btn" onClick={() => { const r = s.runs[s.runs.length - 1]; if (r?.a) set({ ...r.a, failed: [] }) }}>Last run</button>
        <button className="btn" onClick={exportCsv}>Export weights (CSV)</button>
      </div>
    </div>
  )
}

/** Element grid: phase as hue, amplitude as size, click to fail or restore. */
function ElementGrid({ a, onToggle }: { a: ArrayDesign; onToggle: (i: number) => void }) {
  const els = excitation(a)
  const cell = Math.max(18, Math.min(44, 240 / Math.max(a.nx, a.ny)))
  return (
    <div className="ad-grid" style={{ gridTemplateColumns: `repeat(${a.nx}, ${cell}px)` }}>
      {[...els].sort((p, q) => q.iy - p.iy || p.ix - q.ix).map((e) => (
        <button key={e.i} className={`ad-el${e.on ? '' : ' off'}`} style={{ width: cell, height: cell }} title={`#${e.i + 1}: ${f1(20 * Math.log10(Math.max(e.amp, 1e-6)))} dB, ${f1(e.phase, 0)}°${e.on ? '' : ' (off)'}`} onClick={() => onToggle(e.i)}>
          <i style={{ background: `hsl(${e.phase} 65% 50%)`, transform: `scale(${0.35 + 0.65 * e.amp})` }} />
          {cell >= 30 && <span>{e.on ? `${f1(e.phase, 0)}°` : '×'}</span>}
        </button>
      ))}
    </div>
  )
}

export function ArrayDesignerPane() {
  const s = useDemo(), a = s.arr, el = s.design
  const [view, setView] = useState<'beam' | 'phase'>('beam')
  const b = useMemo(() => beam(el, a), [el, a])
  const ref = useMemo(() => beam(el, { ...a, taper: 'uniform', bits: 0, failed: [], f: F0 }), [el, a])
  const paper = PAPER_BEAMS[a.theta]
  const gl = glFreeScan(a)
  const act = activeS11(el, a, a.f, a.theta)
  const toggle = (i: number) => s.setArr({ failed: a.failed.includes(i) ? a.failed.filter((x) => x !== i) : [...a.failed, i] })
  const series: Series[] = [
    { x: ref.cut.map((c) => c.th), y: ref.cut.map((c) => c.db), color: 'var(--faint)', width: 1.4, dash: '5 4', label: 'ideal, uniform' },
    { x: b.cut.map((c) => c.th), y: b.cut.map((c) => c.db), color: 'var(--sig)', width: 2.4, label: 'this setting' },
  ]
  return (
    <div className="pane ad">
      <Controls />
      <div className="ad-view">
        <div className="seg ad-seg"><button className={view === 'beam' ? 'on' : ''} onClick={() => setView('beam')}>3D beam</button><button className={view === 'phase' ? 'on' : ''} onClick={() => setView('phase')}>Element phases</button></div>
        <Suspense fallback={null}><ArrayScene el={el} a={a} beam={view === 'beam'} phases={view === 'phase'} onPick={toggle} /></Suspense>
        <div className="hint">drag to orbit · click an element to fail or restore it</div>
      </div>
      <div className="ad-side">
        <div className="ad-read">
          <div><span>realised gain</span><b>{f1(b.gain)} dBi</b></div>
          <div><span>beam points at</span><b className={Math.abs(b.point - a.theta) > 2 ? 'warn' : ''}>{f1(b.point)}°</b></div>
          <div><span>beamwidth (3 dB)</span><b>{f1(b.hpbw)}°</b></div>
          <div><span>worst sidelobe</span><b className={b.sll > ARRAY_GOAL.sll ? 'bad' : 'good'}>{f1(b.sll)} dB</b></div>
          <div><span>active S11 here</span><b className={act > ARRAY_GOAL.active ? 'bad' : 'good'}>{f1(act)} dB</b></div>
          <div><span>grating-lobe-free to</span><b className={gl < a.theta ? 'bad' : ''}>{gl >= 90 ? '90' : f1(gl, 0)}°</b></div>
        </div>
        {b.grating.length > 0 && <div className="ad-warn">Grating lobe in view at {b.grating.map(([u, v]) => `θ ${f1((Math.asin(Math.min(1, Math.hypot(u, v))) * 180) / Math.PI, 0)}°`).join(', ')}. Close the spacing or steer less.</div>}
        {paper && a.f === F0 && <div className="ad-paper">Paper at {a.theta}°: {paper.gain} dBi, {paper.hpbw}° wide, {paper.sll} dB sidelobes.</div>}
        <LineChart height={190} xDomain={[-90, 90]} yDomain={[Math.round(b.gain) - 35, Math.round(b.gain) + 3]} xTicks={[-90, -60, -30, 0, 30, 60, 90]} xFmt={(v) => `${v}`} xLabel={`θ (deg), φ = ${a.phi}° cut`} yLabel="dBi" series={series} legend
          points={[{ x: b.point, y: b.gain, color: 'var(--sig)', r: 4 }]} hlines={[]} vbands={[{ x1: a.theta - 0.4, x2: a.theta + 0.4, color: 'var(--ink)', opacity: 0.4 }]} />
        <div className="ad-h">Elements <span>hue = phase, size = amplitude</span></div>
        <ElementGrid a={a} onToggle={toggle} />
      </div>
    </div>
  )
}

/** u-v space: where the beam and any grating lobes sit, the visible circle, and the safe scan region. */
export function UVPane() {
  const s = useDemo(), a = s.arr
  const dark = useTheme((t) => t.dark)
  const ref = useRef<HTMLCanvasElement>(null)
  const N = 220
  const L = lambda(a.f)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = c.height = N
    const g = c.getContext('2d')!, img = g.createImageData(N, N)
    // sample the pattern grid once and look up (u, v) → (θ, φ)
    const pg = patternGrid(a, 2, 4)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = (i / (N - 1)) * 2 - 1, v = 1 - (j / (N - 1)) * 2, r = Math.hypot(u, v), o = (j * N + i) * 4
      if (r > 1) { const bg = dark ? 31 : 248; img.data[o] = bg; img.data[o + 1] = bg - 2; img.data[o + 2] = bg - 6; img.data[o + 3] = 255; continue }
      const th = (Math.asin(r) * 180) / Math.PI, ph = ((Math.atan2(v, u) * 180) / Math.PI + 360) % 360
      const val = pg.rows[Math.round(th / pg.dTh)][Math.round(ph / pg.dPh)]
      const db = Math.max(-40, 10 * Math.log10(Math.max(val, 1e-6)))
      const k = (db + 40) / 40
      const c0 = dark ? [20, 30, 45] : [235, 238, 244], c1 = [207, 69, 32]
      img.data[o] = c0[0] + (c1[0] - c0[0]) * k ** 1.4; img.data[o + 1] = c0[1] + (c1[1] - c0[1]) * k ** 1.4; img.data[o + 2] = c0[2] + (c1[2] - c0[2]) * k ** 1.4; img.data[o + 3] = 255
    }
    g.putImageData(img, 0, 0)
  }, [a, dark])
  const b = beam(s.design, a)
  const th0 = (a.theta * Math.PI) / 180, ph0 = (a.phi * Math.PI) / 180
  const u0 = Math.sin(th0) * Math.cos(ph0), v0 = Math.sin(th0) * Math.sin(ph0)
  const S = 400, X = (u: number) => ((u + 1.3) / 2.6) * S, Y = (v: number) => ((1.3 - v) / 2.6) * S
  const safe = Math.max(0, Math.min(1, L / Math.max(a.dx, a.dy) - 1))
  const lattice: [number, number][] = []
  for (let p = -3; p <= 3; p++) for (let q = -3; q <= 3; q++) if (p || q) lattice.push([u0 + (p * L) / a.dx, v0 + (q * L) / a.dy])
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), u = ((e.clientX - r.left) / r.width) * 2.6 - 1.3, v = 1.3 - ((e.clientY - r.top) / r.height) * 2.6
    const rr = Math.hypot(u, v)
    if (rr >= 0.999) return
    s.setArr({ theta: Math.round((Math.asin(rr) * 180) / Math.PI), phi: Math.round(((Math.atan2(v, u) * 180) / Math.PI + 360) % 180) })
  }
  return (
    <div className="pane uv">
      <svg width={S} height={S} className="uv-svg" onClick={click}>
        <foreignObject x={X(-1)} y={Y(1)} width={X(1) - X(-1)} height={Y(-1) - Y(1)}><canvas ref={ref} style={{ width: '100%', height: '100%', borderRadius: '50%' }} /></foreignObject>
        <circle cx={X(0)} cy={Y(0)} r={X(1) - X(0)} fill="none" stroke="var(--ink)" strokeWidth={1.4} />
        {safe > 0 && <circle cx={X(0)} cy={Y(0)} r={(X(1) - X(0)) * safe} fill="none" stroke="var(--ok)" strokeDasharray="5 4" strokeWidth={1.5} />}
        <circle cx={X(0)} cy={Y(0)} r={(X(1) - X(0)) * Math.sin((SCAN_MAX * Math.PI) / 180)} fill="none" stroke="var(--faint)" strokeDasharray="2 3" />
        <line x1={X(-1.3)} x2={X(1.3)} y1={Y(0)} y2={Y(0)} stroke="var(--rule)" /><line x1={X(0)} x2={X(0)} y1={Y(-1.3)} y2={Y(1.3)} stroke="var(--rule)" />
        {lattice.filter(([u, v]) => Math.abs(u) < 1.28 && Math.abs(v) < 1.28).map(([u, v], i) => {
          const vis = Math.hypot(u, v) < 1
          return <g key={i}><circle cx={X(u)} cy={Y(v)} r={vis ? 7 : 4} fill={vis ? 'var(--sig)' : 'none'} stroke="var(--sig)" strokeWidth={1.5} opacity={vis ? 1 : 0.5} />{vis && <text x={X(u) + 9} y={Y(v) + 4} fontSize={10} fill="var(--sig)">grating lobe</text>}</g>
        })}
        <circle cx={X(u0)} cy={Y(v0)} r={6} fill="var(--ink)" stroke="var(--sheet)" strokeWidth={1.5} />
        <text x={X(u0) + 9} y={Y(v0) - 6} fontSize={10.5} fill="var(--ink)">main beam</text>
        <text x={X(0)} y={Y(-1.12)} fontSize={10} fill="var(--mute)" textAnchor="middle">edge of the circle = horizon</text>
      </svg>
      <div className="uv-side">
        <p><b>u-v space</b> is the sky seen from above: the centre is broadside, the circle's edge is the horizon. Steering slides the whole pattern; its copies sit one λ/d apart. A copy inside the circle is a <b className="bad">grating lobe</b>.</p>
        <div className="ad-read">
          <div><span>copies are</span><b>{f1(L / a.dx, 2)} × {f1(L / a.dy, 2)} apart</b></div>
          <div><span>safe scan (green)</span><b>{safe >= 1 ? 'everywhere' : `up to ${f1((Math.asin(safe) * 180) / Math.PI, 0)}°`}</b></div>
          <div><span>needed (dotted)</span><b>±{SCAN_MAX}°</b></div>
          <div><span>grating lobes now</span><b className={b.grating.length ? 'bad' : 'good'}>{b.grating.length || 'none'}</b></div>
        </div>
        <p className="mute small">Click anywhere inside the circle to steer there. Open the spacing in the array designer to watch the copies move in.</p>
      </div>
    </div>
  )
}

/** Scan performance: gain and match across the scan, and where the beam goes as frequency changes. */
export function ScanPane() {
  const s = useDemo(), a = s.arr, el = s.design
  const TH = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]
  const data = useMemo(() => {
    const g = TH.map((t) => beam(el, { ...a, theta: t, f: F0 }))
    const act = TH.map((t) => activeS11(el, a, F0, t))
    const FR = Array.from({ length: 21 }, (_, i) => 2.25 + i * 0.02)
    const ps = FR.map((f) => beam(el, { ...a, f, ttd: false }).point), td = FR.map((f) => beam(el, { ...a, f, ttd: true }).point)
    return { g, act, FR, ps, td }
  }, [el, a]) // eslint-disable-line react-hooks/exhaustive-deps
  const pt = Object.entries(PAPER_BEAMS)
  return (
    <div className="pane scanp">
      <div className="card"><div className="card-h"><h3>Gain across the scan</h3><span className="aside">realised, at {F0} GHz</span></div><div className="card-b chart">
        <LineChart height={200} xDomain={[0, 60]} yDomain={[Math.floor(Math.min(...data.g.map((x) => x.gain)) - 2), Math.ceil(Math.max(...data.g.map((x) => x.gain)) + 2)]} xFmt={(v) => `${v}`} xLabel="steer θ (deg)" yLabel="dBi"
          vbands={[{ x1: 0, x2: SCAN_MAX, color: 'var(--ok)', opacity: 0.08 }]}
          series={[{ x: TH, y: data.g.map((x) => x.gain), color: 'var(--sig)', width: 2.2, label: 'ours', dot: true }]}
          points={pt.map(([t, v]) => ({ x: +t, y: v.gain, color: 'var(--ink)', r: 4, hollow: true, title: 'paper' }))} />
        <div className="legend"><span className="sw"><i style={{ background: 'var(--sig)', height: 2 }} />ours</span><span className="sw"><i style={{ border: '1.5px solid var(--ink)', borderRadius: '50%', width: 8, height: 8 }} />paper, Fig. 5</span><span>scan loss to {SCAN_MAX}°: {f1(data.g[0].gain - beam(el, { ...a, theta: SCAN_MAX, f: F0 }).gain)} dB</span></div>
      </div></div>
      <div className="card"><div className="card-h"><h3>Active match across the scan</h3><span className="aside">all elements driven</span></div><div className="card-b chart">
        <LineChart height={200} xDomain={[0, 60]} yDomain={[-35, 0]} xFmt={(v) => `${v}`} xLabel="steer θ (deg)" yLabel="dB" hlines={[{ y: ARRAY_GOAL.active, color: 'var(--sig)', dash: '5 4', label: 'goal' }]}
          vbands={[{ x1: 0, x2: SCAN_MAX, color: 'var(--ok)', opacity: 0.08 }]}
          series={[{ x: TH, y: data.act, color: 'var(--cool)', width: 2.2, label: 'active S11', dot: true }]} />
      </div></div>
      <div className="card"><div className="card-h"><h3>Beam squint</h3><span className="aside">steered to {a.theta}°, set at {F0} GHz</span></div><div className="card-b chart">
        <LineChart height={200} xDomain={[2.25, 2.65]} yDomain={[Math.max(0, a.theta - 12), a.theta + 8]} xLabel="frequency (GHz)" yLabel="points at (deg)" xFmt={(v) => v.toFixed(2)}
          vbands={[{ x1: 2.42, x2: 2.44, color: 'var(--ok)', opacity: 0.18 }]}
          series={[{ x: data.FR, y: data.ps, color: 'var(--sig)', width: 2.2, label: 'phase shifters' }, { x: data.FR, y: data.td, color: 'var(--ok)', width: 2.2, label: 'true-time delay' }]} legend />
      </div></div>
    </div>
  )
}

// ---------------------------------------------------------------- results tab and sidebar

export function ArrayResults({ top }: { top?: React.ReactNode }) {
  const s = useDemo()
  const last = s.runs[s.runs.length - 1]
  if (!last?.a || !last.am) return null
  const el = last.d, a = last.a
  const cuts: Series[] = STEERS.slice(1).map((t, i) => {
    const b = beam(el, { ...a, theta: t, f: F0 })
    return { x: b.cut.map((c) => c.th), y: b.cut.map((c) => c.db), color: ['#2c4a72', '#2f6a4c', '#b07d12', '#cf4520'][i], width: 2, label: `${t}°` }
  })
  return (
    <div className="pane-grid results">
      <div className="stack">
        <div className="card"><div className="card-h"><h3>Steered patterns</h3><span className="aside">run {last.n} · φ = 0 cut · {F0} GHz</span></div><div className="card-b chart">
          <LineChart height={300} xDomain={[-90, 90]} yDomain={[-25, 16]} xTicks={[-90, -60, -30, 0, 30, 60, 90]} xFmt={(v) => `${v}`} xLabel="θ (deg)" yLabel="dBi" series={cuts} legend />
        </div></div>
        <div className="card"><div className="card-h"><h3>Runs</h3><span className="aside">{s.runs.length} so far</span></div><div className="card-b" style={{ padding: 0 }}>
          <table className="runs">
            <thead><tr><th>#</th><th>what</th><th>pitch</th><th>taper</th><th>length</th><th>inset</th><th>active worst</th><th>sidelobes</th></tr></thead>
            <tbody>{s.runs.map((r) => (
              <tr key={r.n} className={r === last ? 'cur' : ''}><td>{r.n}</td><td>{r.label}</td><td>{r.a?.dx.toFixed(0)}</td><td>{r.a?.taper}</td><td>{r.d.L.toFixed(2)}</td><td>{r.d.y0.toFixed(2)}</td>
                <td className={(r.am?.activeWorst ?? 0) <= ARRAY_GOAL.active ? 'good' : 'bad'}>{r.am?.activeWorst.toFixed(1)} dB</td><td className={(r.am?.sllWorst ?? 0) <= ARRAY_GOAL.sll ? 'good' : 'bad'}>{r.am?.sllWorst.toFixed(1)} dB</td></tr>
            ))}</tbody>
          </table>
        </div></div>
      </div>
      <div className="stack">
        {top}
        <div className="card"><div className="card-h"><h3>Steering vs the paper</h3><span className="aside">ours, paper below · Fig. 5</span></div><div className="card-b" style={{ padding: 0 }}>
          <table className="runs">
            <thead><tr><th>steer</th><th>gain dBi</th><th>points at</th><th>width</th><th>sidelobes</th></tr></thead>
            <tbody>{STEERS.slice(1).map((t) => { const b = last.am!.beams[t], p = PAPER_BEAMS[t]; return (
              <tr key={t}><td>{t}°</td><td>{f1(b.gain)}<br /><span className="mute">{p.gain}</span></td><td>{f1(b.point)}°</td><td>{f1(b.hpbw)}°<br /><span className="mute">{p.hpbw}°</span></td><td>{f1(b.sll)}<br /><span className="mute">{p.sll}</span></td></tr>
            ) })}</tbody>
          </table>
        </div></div>
        <SolveReport />
      </div>
    </div>
  )
}

export function ArraySide({ built }: { built: boolean }) {
  const s = useDemo(), a = s.arr, el = s.design
  const last = s.runs[s.runs.length - 1]
  const m = useMemo(() => (last?.a ? arrayMetrics(last.d, last.a) : null), [last])
  if (!built) return null
  return (
    <>
      <section className="sec grow">
        <h4>Array <span>{s.phase === 'tuning' || s.phase === 'solving' ? 'locked while running' : 'edit in Explore'}</span></h4>
        <div className="stat">elements <b>{a.nx} × {a.ny} = {a.nx * a.ny}</b></div>
        <div className="stat">pitch <b>{f1(a.dx)} × {f1(a.dy)} mm ({f1(a.dx / lambda(F0), 2)} λ)</b></div>
        <div className="stat">taper <b>{a.taper === 'uniform' ? 'uniform' : `${a.taper === 'cheb' ? 'Chebyshev' : 'Taylor'} −${a.sll} dB`}</b></div>
        <div className="stat">steering <b>{a.bits ? `${a.bits}-bit` : 'ideal'} {a.ttd ? 'TTD' : 'phase shifters'}</b></div>
        <h4 style={{ marginTop: 12 }}>Element</h4>
        <div className="stat">patch <b>{f1(el.W, 2)} × {f1(el.L, 2)} mm</b></div>
        <div className="stat">inset <b>{f1(el.y0, 2)} mm</b></div>
        <div className="stat">board <b>εr {el.er} · {el.h} mm</b></div>
      </section>
      {s.issues.length > 0 && (
        <section className="sec">
          <h4>Fixed from the paper <span>{s.issues.length}</span></h4>
          {s.issues.map((i) => <div key={i.title} className="issue"><b>!</b>{i.title}</div>)}
        </section>
      )}
      <section className="sec">
        <h4>Status</h4>
        {m ? (
          <>
            <div className="stat">active match, worst <b>{f1(m.activeWorst)} dB</b></div>
            <div className="stat">sidelobes, worst <b>{f1(m.sllWorst)} dB</b></div>
            <div className="stat">gain 0° / {SCAN_MAX}° <b>{f1(m.gain0)} / {f1(m.gainMax)} dBi</b></div>
            <div className={`verdict ${m.activeWorst <= ARRAY_GOAL.active && m.sllWorst <= ARRAY_GOAL.sll ? 'good' : 'bad'}`}>{m.activeWorst <= ARRAY_GOAL.active && m.sllWorst <= ARRAY_GOAL.sll ? 'Goal met' : 'Goal not met'}</div>
          </>
        ) : <div className="mute small">No runs yet.</div>}
      </section>
    </>
  )
}
