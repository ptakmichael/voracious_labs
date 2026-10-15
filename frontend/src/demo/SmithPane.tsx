import { useEffect, useMemo, useRef, useState } from 'react'
import { type Param } from './effects'
import { type Design, FREQS, GOAL, metrics, s11, zin } from './model'
import { FreqScrubber } from './Scrubber'
import { allParams, useDemo } from './store'
import { useSize } from './Workspace'

const R_CIRCLES = [0.2, 0.5, 1, 2, 5]
const X_ARCS = [0.2, 0.5, 1, 2, 5]
const VSWR_CIRCLES = [1.5, 2, 3]
const GOAL_G = 10 ** (GOAL.db / 20) // |Γ| at −10 dB
const PARAM_COLORS = ['#cf4520', '#2c4a72', '#2f6a4c', '#8a5a14', '#7a3f8f', '#4d6b78', '#a23b5b', '#5a6b1e']

interface G { re: number; im: number; z: { r: number; x: number } }
const gamma = (f: number, d: Design): G => { const z = zin(f, d); const den = (z.r + 50) ** 2 + z.x ** 2; return { re: (z.r * z.r - 2500 + z.x * z.x) / den, im: (100 * z.x) / den, z } }
const zfmt = (z: { r: number; x: number }) => `${z.r.toFixed(1)} ${z.x >= 0 ? '+' : '−'} j${Math.abs(z.x).toFixed(1)} Ω`
const pct = (k: number) => `${k >= 0 ? '+' : '−'}${Math.abs(k)}%`

/** What changing the parameter by k% does to the loop, in words, from the model. */
function story(p: Param, d: Design, k: number) {
  const a = metrics(d), b = metrics(p.apply(d, 1 + k / 100))
  const df = (b.f0 - a.f0) * 1000, dR = b.R - a.R
  const parts: string[] = []
  if (Math.abs(df) >= 2) parts.push(`slides every point along the loop: resonance ${(a.f0 * 1000).toFixed(0)} → ${(b.f0 * 1000).toFixed(0)} MHz (${df > 0 ? '+' : '−'}${Math.abs(df).toFixed(0)}), so each frequency now sits where a ${df < 0 ? 'higher' : 'lower'} one used to`)
  if (Math.abs(dR) >= 0.5) parts.push(`${dR > 0 ? 'grows' : 'shrinks'} the loop: resistance at resonance ${a.R.toFixed(1)} → ${b.R.toFixed(1)} Ω, crossing the middle line ${Math.abs(b.R - 50) < Math.abs(a.R - 50) ? 'closer to' : 'further from'} the 50 Ω centre`)
  if (!parts.length) return `barely moves the loop (resonance ${Math.abs(df).toFixed(1)} MHz, resistance ${Math.abs(dR).toFixed(1)} Ω).`
  return parts.join('; it also ') + '.'
}

function LegendRow({ children, label }: { children: React.ReactNode; label: React.ReactNode }) {
  return <div className="lg-row"><svg width={34} height={14}>{children}</svg><span>{label}</span></div>
}

export function SmithPane() {
  const s = useDemo()
  const params = allParams(s)
  const [ref, size] = useSize<HTMLDivElement>()
  const [k, setK] = useState(5)
  const [zoom, setZoom] = useState(1)
  const [showVals, setShowVals] = useState(true)
  const [showVswr, setShowVswr] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [peek, setPeek] = useState<number | null>(null) // parameter previewed by hovering its chip
  const svg = useRef<SVGSVGElement>(null)
  const dragging = useRef(false)
  const d = s.design
  const f = s.fq ?? Math.round(metrics(d).f0 * 1000) / 1000
  const pi = peek ?? Math.min(s.sel.v, params.length - 1)
  const p = params[pi]
  const col = PARAM_COLORS[pi % PARAM_COLORS.length]
  const wide = size.w > 700
  const side = Math.max(260, Math.min(wide ? size.w - 350 : size.w - 4, wide ? size.h - 96 : Math.max(size.h * 0.6, 320)) - 8)
  const loop = useMemo(() => FREQS.map((x) => gamma(x, d)), [d])
  // zooming closes in on your band rather than the middle of the chart
  const inBand = loop.filter((_, i) => FREQS[i] >= GOAL.f1 && FREQS[i] <= GOAL.f2)
  const focus = inBand.reduce((a, g) => ({ re: a.re + g.re / inBand.length, im: a.im + g.im / inBand.length }), { re: 0, im: 0 })
  const pull = 1 - 1 / zoom
  const R = (side / 2 - 22) * zoom, cx = side / 2 - focus.re * pull * R, cy = side / 2 + focus.im * pull * R
  const P = (g: { re: number; im: number }) => [cx + g.re * R, cy - g.im * R] as const
  const dk = useMemo(() => p.apply(d, 1 + k / 100), [d, p, k])
  const ghost = useMemo(() => FREQS.map((x) => gamma(x, dk)), [dk])
  const at = gamma(f, d)
  const mag = Math.hypot(at.re, at.im), ang = (Math.atan2(at.im, at.re) * 180) / Math.PI
  const path = (pts: { re: number; im: number }[]) => pts.map((g, i) => `${i ? 'L' : 'M'}${P(g)[0].toFixed(1)},${P(g)[1].toFixed(1)}`).join('')
  const band = FREQS.map((x, i) => [x, loop[i]] as const).filter(([x]) => x >= GOAL.f1 && x <= GOAL.f2).map(([, g]) => g)
  const ticks = [2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8].map((t) => ({ t, g: gamma(t, d) }))
  // one arrow: the frequency under the pointer (or the selected one) from where it is now to where the change puts it
  const fa = hover !== null ? FREQS[hover] : f
  const from = gamma(fa, d), to = gamma(fa, dk)
  const ghostTicks = [2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8].map((t) => gamma(t, dk))

  // wheel zoom needs a non-passive listener so the window body doesn't scroll instead
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const wheel = (e: WheelEvent) => { e.preventDefault(); setZoom((z) => Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const nearest = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    let best = -1, bd = 1e9
    loop.forEach((g, i) => { const [x, y] = P(g); const dd = (x - mx) ** 2 + (y - my) ** 2; if (dd < bd) { bd = dd; best = i } })
    return { i: best, dist: Math.sqrt(bd) }
  }
  const onMove = (e: React.PointerEvent) => {
    const n = nearest(e)
    if (dragging.current) { s.setFq(Math.round(FREQS[n.i] * 1000) / 1000); setHover(n.i); return }
    setHover(n.dist < 16 ? n.i : null)
  }
  const onDown = (e: React.PointerEvent) => {
    const n = nearest(e)
    if (n.dist > 16) return
    dragging.current = true
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    s.setFq(Math.round(FREQS[n.i] * 1000) / 1000)
  }
  const hv = hover !== null ? { f: FREQS[hover], g: loop[hover] } : null

  return (
    <div className="smith-wrap" ref={ref}>
      <div className="smith-pane" style={{ flexDirection: wide ? 'row' : 'column' }}>
        <div className="smith-chart">
          <div className="sm-tools">
            <span>zoom</span>
            {[1, 2, 4].map((z) => <button key={z} className={`chip${Math.abs(zoom - z) < 0.01 ? ' on' : ''}`} onClick={() => setZoom(z)}>{z}×</button>)}
            <label className="ck"><input type="checkbox" checked={showVals} onChange={() => setShowVals(!showVals)} />grid values</label>
            <label className="ck"><input type="checkbox" checked={showVswr} onChange={() => setShowVswr(!showVswr)} />VSWR circles</label>
          </div>
          <svg ref={svg} width={side} height={side} className="smith-svg" onPointerMove={onMove} onPointerDown={onDown}
            onPointerUp={() => { dragging.current = false }} onPointerLeave={() => { if (!dragging.current) setHover(null) }}
            style={{ cursor: hover !== null ? 'pointer' : 'crosshair' }}>
            <defs>
              <clipPath id="sm-view"><rect x={0} y={0} width={side} height={side} /></clipPath>
              <clipPath id="sm-unit"><circle cx={cx} cy={cy} r={R} /></clipPath>
              {PARAM_COLORS.map((c, i) => <marker key={i} id={`sa${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill={c} /></marker>)}
            </defs>
            <g clipPath="url(#sm-view)">
              <circle cx={cx} cy={cy} r={R} fill="#fffdf8" stroke="var(--ink)" strokeWidth={1.2} />
              <g clipPath="url(#sm-unit)" fill="none">
                <rect x={cx - R} y={cy - R} width={2 * R} height={R} fill="rgba(207,69,32,.035)" />
                <rect x={cx - R} y={cy} width={2 * R} height={R} fill="rgba(44,74,114,.035)" />
                <g stroke="#e1dbcd">
                  {R_CIRCLES.map((r) => <circle key={r} cx={cx + (r / (1 + r)) * R} cy={cy} r={R / (1 + r)} />)}
                  {X_ARCS.map((x) => <g key={x}><circle cx={cx + R} cy={cy - R / x} r={R / x} /><circle cx={cx + R} cy={cy + R / x} r={R / x} /></g>)}
                  <line x1={cx - R} x2={cx + R} y1={cy} y2={cy} />
                </g>
                {showVswr && VSWR_CIRCLES.map((v) => { const g = (v - 1) / (v + 1); return <g key={v}><circle cx={cx} cy={cy} r={g * R} stroke="#9c968a" strokeDasharray="1 3" /><text x={cx - g * R * 0.707 - 3} y={cy + g * R * 0.707 + 10} fontSize={9.5} fill="var(--mute)" textAnchor="end">VSWR {v}</text></g> })}
              </g>
              {showVals && R_CIRCLES.map((r) => <text key={r} x={cx + ((r - 1) / (r + 1)) * R + 3} y={cy + 11} fontSize={9.5} fill="var(--faint)">{(r * 50).toFixed(0)}</text>)}
              {showVals && X_ARCS.map((x) => [1, -1].map((sg) => {
                const re = (x * x - 1) / (x * x + 1), im = (sg * 2 * x) / (x * x + 1)
                return <text key={`${x}${sg}`} x={cx + re * R * 1.07} y={cy - im * R * 1.07 + 3} fontSize={9.5} fill={sg > 0 ? '#c0705a' : '#6b86ab'} textAnchor="middle">{sg > 0 ? '+' : '−'}j{(x * 50).toFixed(0)}</text>
              }))}
              <text x={cx} y={cy - R + 14} fontSize={10} fill="var(--sig)" textAnchor="middle">inductive half</text>
              <text x={cx} y={cy + R - 6} fontSize={10} fill="var(--cool)" textAnchor="middle">capacitive half</text>
              <circle cx={cx} cy={cy} r={GOAL_G * R} fill="rgba(47,106,76,.08)" stroke="var(--ok)" strokeDasharray="4 3" />
              {ghost.length > 0 && <path d={path(ghost)} fill="none" stroke={col} strokeWidth={1.8} strokeDasharray="6 4" />}
              <path d={path(loop)} fill="none" stroke="var(--ink)" strokeWidth={1.7} />
              <path d={path(band)} fill="none" stroke="var(--ok)" strokeWidth={4.5} strokeLinecap="round" />
              {ticks.map(({ t, g }) => { const [x, y] = P(g); return <g key={t}><circle cx={x} cy={y} r={2.6} fill="var(--ink)" /><text x={x + 5} y={y - 5} fontSize={10} fill="var(--ink-2)">{t.toFixed(1)}</text></g> })}
              {ghostTicks.map((g, i) => { const [x, y] = P(g); return <circle key={i} cx={x} cy={y} r={2.4} fill="#fffdf8" stroke={col} strokeWidth={1.3} /> })}
              {(() => {
                const [x1, y1] = P(from), [x2, y2] = P(to)
                const len = Math.hypot(x2 - x1, y2 - y1)
                const ux = len ? (x2 - x1) / len : 1, uy = len ? (y2 - y1) / len : 0
                return (
                  <g pointerEvents="none">
                    {len > 4 && <line x1={x1 + ux * 6} y1={y1 + uy * 6} x2={x2 - ux * 5} y2={y2 - uy * 5} stroke={col} strokeWidth={2.4} markerEnd={`url(#sa${pi % PARAM_COLORS.length})`} />}
                    <circle cx={x1} cy={y1} r={5} fill="#fffdf8" stroke={col} strokeWidth={2} />
                    <circle cx={x2} cy={y2} r={5} fill={col} stroke="#fff" strokeWidth={1.5} />
                    <text x={x2 + (ux >= 0 ? 9 : -9)} y={y2 + 14} fontSize={10.5} fontWeight={600} fill={col} textAnchor={ux >= 0 ? 'start' : 'end'}>{fa.toFixed(3)} GHz after</text>
                  </g>
                )
              })()}
              <circle cx={cx} cy={cy} r={3.5} fill="var(--ink)" />
              <circle cx={P(at)[0]} cy={P(at)[1]} r={7} fill="var(--sig)" stroke="#fff" strokeWidth={2} />
              <text x={P(at)[0] + 10} y={P(at)[1] + 4} fontSize={11} fontWeight={600} fill="var(--sig)">{f.toFixed(3)} GHz</text>
              {hv && (() => {
                const [x, y] = P(hv.g), right = x < side - 210
                return (
                  <g pointerEvents="none">
                    <circle cx={x} cy={y} r={6} fill="none" stroke="var(--ink)" strokeWidth={1.5} />
                    <g transform={`translate(${right ? x + 12 : x - 202} ${Math.max(8, Math.min(side - 62, y - 30))})`}>
                      <rect width={192} height={54} fill="var(--ink)" />
                      <text x={8} y={16} fontSize={11} fill="#fff" fontWeight={600}>{hv.f.toFixed(3)} GHz{hv.f >= GOAL.f1 && hv.f <= GOAL.f2 ? '  · in band' : ''}</text>
                      <text x={8} y={31} fontSize={10.5} fill="#e8e3d8">{zfmt(hv.g.z)}</text>
                      <text x={8} y={46} fontSize={10.5} fill="#e8e3d8">S11 {s11(hv.f, d).toFixed(1)} dB · click to select</text>
                    </g>
                  </g>
                )
              })()}
            </g>
          </svg>
          <div className="sm-hint">hover the curve to read it · click or drag along it to pick a frequency · scroll to zoom</div>
        </div>
        <div className="smith-side">
          <div className="sm-legend">
            <div className="lg-h">Legend</div>
            <LegendRow label="antenna impedance, 2.1 → 2.8 GHz (dot every 0.1 GHz)"><line x1={2} x2={32} y1={7} y2={7} stroke="var(--ink)" strokeWidth={1.7} /><circle cx={17} cy={7} r={2.4} fill="var(--ink)" /></LegendRow>
            <LegendRow label="your band, 2.40 – 2.48 GHz"><line x1={2} x2={32} y1={7} y2={7} stroke="var(--ok)" strokeWidth={4.5} strokeLinecap="round" /></LegendRow>
            <LegendRow label="−10 dB circle: inside it, the goal is met"><circle cx={17} cy={7} r={6} fill="rgba(47,106,76,.12)" stroke="var(--ok)" strokeDasharray="3 2" /></LegendRow>
            <LegendRow label={<>selected frequency, <b>{f.toFixed(3)} GHz</b></>}><circle cx={17} cy={7} r={5} fill="var(--sig)" /></LegendRow>
            <LegendRow label="centre: 50 Ω, a perfect match"><circle cx={17} cy={7} r={3} fill="var(--ink)" /></LegendRow>
            <LegendRow label={<>{p.name.toLowerCase()} {pct(k)}: the what-if curve (hollow dots every 0.1 GHz)</>}><line x1={2} x2={32} y1={7} y2={7} stroke={col} strokeWidth={1.8} strokeDasharray="6 4" /><circle cx={17} cy={7} r={2.4} fill="#fffdf8" stroke={col} strokeWidth={1.3} /></LegendRow>
            <LegendRow label={<>{hover !== null ? 'hovered' : 'selected'} frequency: now (hollow) → after the change (filled)</>}><circle cx={4} cy={7} r={3} fill="#fffdf8" stroke={col} strokeWidth={1.5} /><line x1={8} x2={26} y1={7} y2={7} stroke={col} strokeWidth={2} markerEnd={`url(#sa${pi % PARAM_COLORS.length})`} /><circle cx={30} cy={7} r={3} fill={col} /></LegendRow>
            <div className="lg-note">Grid: circles are constant resistance, arcs constant reactance (values in Ω). Top half inductive, bottom half capacitive.</div>
          </div>
          <div className="sm-read">
            <div className="sm-grid">
              <span>impedance</span><b>{zfmt(at.z)}</b>
              <span>reflection Γ</span><b>{mag.toFixed(3)} ∠ {ang.toFixed(0)}°</b>
              <span>VSWR</span><b>{((1 + mag) / (1 - mag)).toFixed(2)}</b>
              <span>S11</span><b className={mag <= GOAL_G ? 'good' : 'bad'}>{(20 * Math.log10(mag)).toFixed(1)} dB</b>
            </div>
          </div>
          <div className="sm-whatif">
            <div className="lg-h">What if…</div>
            <div className="sm-params">
                {params.map((q, i) => (
                  <button key={q.id} className={`chip${i === pi ? ' on' : ''}`} style={i === pi ? { background: PARAM_COLORS[i % PARAM_COLORS.length], borderColor: PARAM_COLORS[i % PARAM_COLORS.length] } : undefined}
                    onMouseEnter={() => setPeek(i)} onMouseLeave={() => setPeek(null)} onClick={() => { setPeek(null); s.selectParam(i) }}>{q.name}</button>
                ))}
            </div>
            <div className="sm-k">
              <span>{p.name}</span>
              <input type="range" min={-15} max={15} step={1} value={k} onChange={(e) => setK(parseInt(e.target.value) || 1)} />
              <b>{pct(k)}</b>
            </div>
            <p className="sm-story">{p.name} {pct(k)} ({p.fmt(p.value(d))} → {p.fmt(p.value(dk))}{p.unit ? ` ${p.unit}` : ''}) {story(p, d, k)}</p>
            <p className="sm-story">At <b>{fa.toFixed(3)} GHz</b>: {zfmt(from.z)} → {zfmt(to.z)}, S11 {s11(fa, d).toFixed(1)} → {s11(fa, dk).toFixed(1)} dB. Hover the black curve to move the arrow.</p>
            <button className="btn" onClick={() => s.setDesign(dk)}>Apply this change to the design</button>
          </div>
        </div>
      </div>
      <FreqScrubber d={d} f={f} onF={s.setFq} />
    </div>
  )
}
