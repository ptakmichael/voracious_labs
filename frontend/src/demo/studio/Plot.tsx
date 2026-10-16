import { useState } from 'react'
import { useWidth } from '../../components/charts/LineChart'
import { SmithGrid } from '../../components/charts/SmithChart'

/**
 * The one plot every report uses: rectangular, polar or Smith. Axis titles, a legend, a crosshair readout on hover,
 * and click-to-place markers. Data in, pixels out; nothing here knows about antennas.
 */
export interface PSeries { id: string; label: string; color: string; dash?: string; x: number[]; y: number[]; f?: number[] }
export interface PMarker { id: string; name: string; series: string; x: number; y: number; color: string }
interface Props {
  kind: 'rect' | 'polar' | 'smith'
  series: PSeries[]
  xLabel: string
  yLabel: string
  xRange?: [number, number]
  yRange?: [number, number]
  markers: PMarker[]
  height: number
  onPick?: (x: number, series: string) => void
}

export function niceTicks(lo: number, hi: number, n = 6) {
  if (!(hi > lo)) { hi = lo + 1 }
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(12))
  return { ticks: out, step }
}
export const fmtNum = (v: number, step = 0) => {
  const d = step >= 1 || step === 0 ? (Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 2) : Math.min(4, Math.ceil(-Math.log10(step)) + (step * 10 ** Math.ceil(-Math.log10(step)) % 1 ? 1 : 0))
  return v.toFixed(Math.max(0, d))
}

/** y at x by linear interpolation on a series sorted by x. */
export function yAt(s: { x: number[]; y: number[] }, x: number) {
  const n = s.x.length
  if (!n) return NaN
  if (x <= s.x[0]) return s.y[0]
  if (x >= s.x[n - 1]) return s.y[n - 1]
  let i = 1
  while (i < n && s.x[i] < x) i++
  const k = (x - s.x[i - 1]) / (s.x[i] - s.x[i - 1] || 1)
  return s.y[i - 1] + k * (s.y[i] - s.y[i - 1])
}

function extent(series: PSeries[], key: 'x' | 'y', pad: number): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (const s of series) for (const v of s[key]) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v }
  if (!Number.isFinite(lo)) return [0, 1]
  const p = (hi - lo || Math.abs(hi) || 1) * pad
  return [lo - p, hi + p]
}

function Legend({ series }: { series: PSeries[] }) {
  if (series.length < 2) return null
  return (
    <div className="pl-legend">
      {series.map((s) => (
        <span key={s.id}><svg width="22" height="8"><line x1="0" x2="22" y1="4" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dash} /></svg>{s.label}</span>
      ))}
    </div>
  )
}

function Tip({ x, y, head, rows, W }: { x: number; y: number; head: string; rows: { label: string; v: string; color: string }[]; W: number }) {
  const left = x > W * 0.6
  return (
    <div className="pl-tip" style={{ left: left ? undefined : x + 12, right: left ? W - x + 12 : undefined, top: y }}>
      <b>{head}</b>
      {rows.map((r, i) => <div key={i}><i style={{ background: r.color }} />{r.label}<span>{r.v}</span></div>)}
    </div>
  )
}

/** Each kind measures its own width: switching kind swaps the element the size observer watches. */
export function Plot(p: Props) {
  if (p.kind === 'smith') return <Sized {...p} C={SmithPlot} key="smith" />
  if (p.kind === 'polar') return <Sized {...p} C={PolarPlot} key="polar" />
  return <Sized {...p} C={RectPlot} key="rect" />
}
type Inner = Props & { W: number; wref: React.RefObject<HTMLDivElement> }
function Sized({ C, ...p }: Props & { C: (q: Inner) => React.ReactElement }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  return <C {...p} W={W} wref={ref} />
}

function RectPlot(p: Inner) {
  const [hover, setHover] = useState<{ px: number; py: number; x: number } | null>(null)
  const H = p.height, W = p.W, ref = p.wref
  const live = p.series.filter((s) => s.x.length)
  const m = { l: 62, r: 18, t: 14, b: 46 }
  const dom = { x: p.xRange ?? extent(live, 'x', 0), y: p.yRange ?? extent(live, 'y', 0.06) }
  const xt = niceTicks(dom.x[0], dom.x[1], Math.max(3, Math.round((W - 80) / 90)))
  const yt = niceTicks(dom.y[0], dom.y[1], Math.max(3, Math.round((H - 60) / 50)))
  const X = (v: number) => m.l + ((v - dom.x[0]) / (dom.x[1] - dom.x[0] || 1)) * (W - m.l - m.r)
  const Y = (v: number) => m.t + (1 - (v - dom.y[0]) / (dom.y[1] - dom.y[0] || 1)) * (H - m.t - m.b)
  const inv = (px: number) => dom.x[0] + ((px - m.l) / (W - m.l - m.r)) * (dom.x[1] - dom.x[0])
  const clip = `pc${W}${H}`
  const path = (s: PSeries) => s.x.map((x, i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(s.y[i]).toFixed(1)}`).join('')
  const hx = hover ? Math.min(dom.x[1], Math.max(dom.x[0], hover.x)) : 0
  return (
    <div className="pl" ref={ref}>
      <svg width={W} height={H} className="pl-svg"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top; setHover(px > m.l && px < W - m.r && py > m.t && py < H - m.b ? { px, py, x: inv(px) } : null) }}
        onMouseLeave={() => setHover(null)}
        onClick={() => { if (hover && live[0] && p.onPick) p.onPick(hover.x, live[0].id) }}>
        <defs><clipPath id={clip}><rect x={m.l} y={m.t} width={Math.max(0, W - m.l - m.r)} height={Math.max(0, H - m.t - m.b)} /></clipPath></defs>
        <rect x={m.l} y={m.t} width={Math.max(0, W - m.l - m.r)} height={Math.max(0, H - m.t - m.b)} className="pl-area" />
        {yt.ticks.map((v) => <g key={`y${v}`}><line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} className="pl-grid" /><text x={m.l - 8} y={Y(v) + 4} textAnchor="end" className="pl-tick">{fmtNum(v, yt.step)}</text></g>)}
        {xt.ticks.map((v) => <g key={`x${v}`}><line x1={X(v)} x2={X(v)} y1={m.t} y2={H - m.b} className="pl-grid" /><text x={X(v)} y={H - m.b + 17} textAnchor="middle" className="pl-tick">{fmtNum(v, xt.step)}</text></g>)}
        <text x={(m.l + W - m.r) / 2} y={H - 8} textAnchor="middle" className="pl-title">{p.xLabel}</text>
        <text transform={`translate(15 ${(m.t + H - m.b) / 2}) rotate(-90)`} textAnchor="middle" className="pl-title">{p.yLabel}</text>
        <g clipPath={`url(#${clip})`}>
          {live.map((s) => <path key={s.id} d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" />)}
          {hover && <line x1={X(hx)} x2={X(hx)} y1={m.t} y2={H - m.b} className="pl-cross" />}
          {hover && live.map((s) => { const y = yAt(s, hx); return Number.isFinite(y) ? <circle key={s.id} cx={X(hx)} cy={Y(y)} r={4} fill={s.color} className="pl-dot" /> : null })}
        </g>
        {p.markers.map((mk) => (
          <g key={mk.id}>
            <circle cx={X(mk.x)} cy={Y(mk.y)} r={4.5} fill="none" stroke={mk.color} strokeWidth={2} className="pl-mk" />
            <text x={X(mk.x) + 7} y={Y(mk.y) - 7} className="pl-mk-l">{mk.name}</text>
          </g>
        ))}
      </svg>
      {hover && <Tip x={hover.px} y={hover.py} W={W} head={`${p.xLabel.split(' (')[0]} ${fmtNum(hx, xt.step / 10)}`} rows={live.map((s) => ({ label: s.label, v: fmtNum(yAt(s, hx), yt.step / 10), color: s.color }))} />}
      <Legend series={live} />
    </div>
  )
}

function PolarPlot(p: Props & { W: number; wref: React.RefObject<HTMLDivElement> }) {
  const [hover, setHover] = useState<{ px: number; py: number; a: number } | null>(null)
  const live = p.series.filter((s) => s.x.length)
  const H = p.height, W = p.W
  const R = Math.max(40, Math.min(W, H) / 2 - 34), cx = W / 2, cy = H / 2
  const [ylo, yhi] = p.yRange ?? (() => { const e = extent(live, 'y', 0); const hi = Math.ceil(e[1] / 5) * 5; return [hi - 40, hi] as [number, number] })()
  const rings = niceTicks(ylo, yhi, 4).ticks.filter((v) => v > ylo)
  const rr = (v: number) => (Math.max(0, Math.min(1, (v - ylo) / (yhi - ylo || 1)))) * R
  const pt = (deg: number, v: number) => { const a = (deg * Math.PI) / 180; return [cx + rr(v) * Math.sin(a), cy - rr(v) * Math.cos(a)] }
  const path = (s: PSeries) => s.x.map((x, i) => { const [a, b] = pt(x, s.y[i]); return `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}` }).join('')
  const ang = hover ? hover.a : 0
  return (
    <div className="pl" ref={p.wref}>
      <svg width={W} height={H} className="pl-svg"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top; const a = (Math.atan2(px - cx, cy - py) * 180) / Math.PI; setHover(Math.hypot(px - cx, py - cy) <= R + 6 ? { px, py, a: Math.round(a) } : null) }}
        onMouseLeave={() => setHover(null)}
        onClick={() => { if (hover && live[0] && p.onPick) p.onPick(hover.a, live[0].id) }}>
        <circle cx={cx} cy={cy} r={R} className="pl-area" />
        {rings.map((v) => <g key={v}><circle cx={cx} cy={cy} r={rr(v)} className="pl-grid" fill="none" /><text x={cx + 3} y={cy - rr(v) + 12} className="pl-tick">{fmtNum(v)}</text></g>)}
        {Array.from({ length: 12 }, (_, i) => i * 30).map((d) => { const [a, b] = pt(d, yhi); const [la, lb] = [cx + (R + 14) * Math.sin((d * Math.PI) / 180), cy - (R + 14) * Math.cos((d * Math.PI) / 180)]; return <g key={d}><line x1={cx} y1={cy} x2={a} y2={b} className="pl-grid" /><text x={la} y={lb + 4} textAnchor="middle" className="pl-tick">{d > 180 ? d - 360 : d}</text></g> })}
        {live.map((s) => <path key={s.id} d={path(s)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} />)}
        {hover && (() => { const [a, b] = pt(ang, yhi); return <line x1={cx} y1={cy} x2={a} y2={b} className="pl-cross" /> })()}
        {hover && live.map((s) => { const [a, b] = pt(ang, yAt(s, ang)); return <circle key={s.id} cx={a} cy={b} r={4} fill={s.color} className="pl-dot" /> })}
        {p.markers.map((mk) => { const [a, b] = pt(mk.x, mk.y); return <g key={mk.id}><circle cx={a} cy={b} r={4.5} fill="none" stroke={mk.color} strokeWidth={2} /><text x={a + 7} y={b - 7} className="pl-mk-l">{mk.name}</text></g> })}
        <text x={8} y={16} className="pl-title" textAnchor="start">{p.yLabel}</text>
        <text x={W - 8} y={16} className="pl-title" textAnchor="end">{p.xLabel}</text>
      </svg>
      {hover && <Tip x={hover.px} y={hover.py} W={W} head={`Theta ${ang}°`} rows={live.map((s) => ({ label: s.label, v: fmtNum(yAt(s, ang), 0.01), color: s.color }))} />}
      <Legend series={live} />
    </div>
  )
}

function SmithPlot(p: Props & { W: number; wref: React.RefObject<HTMLDivElement> }) {
  const [hover, setHover] = useState<{ px: number; py: number; s: PSeries; i: number } | null>(null)
  const live = p.series.filter((s) => s.x.length)
  const H = p.height, W = p.W
  const R = Math.max(40, Math.min(W, H) / 2 - 20), cx = W / 2, cy = H / 2
  const P = (re: number, im: number) => [cx + re * R, cy - im * R]
  const id = `sm${W}${H}`
  return (
    <div className="pl" ref={p.wref}>
      <svg width={W} height={H} className="pl-svg"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top
          let best: { s: PSeries; i: number; d: number } | null = null
          for (const s of live) s.x.forEach((re, i) => { const [a, b] = P(re, s.y[i]); const d = Math.hypot(a - px, b - py); if (!best || d < best.d) best = { s, i, d } })
          const b = best as { s: PSeries; i: number; d: number } | null
          setHover(b && b.d < 30 ? { px, py, s: b.s, i: b.i } : null)
        }}
        onMouseLeave={() => setHover(null)}
        onClick={() => { if (hover && p.onPick && hover.s.f) p.onPick(hover.s.f[hover.i], hover.s.id) }}>
        <SmithGrid cx={cx} cy={cy} R={R} id={id} />
        {live.map((s) => <path key={s.id} d={s.x.map((re, i) => { const [a, b] = P(re, s.y[i]); return `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}` }).join('')} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} />)}
        {hover && (() => { const [a, b] = P(hover.s.x[hover.i], hover.s.y[hover.i]); return <circle cx={a} cy={b} r={4.5} fill={hover.s.color} className="pl-dot" /> })()}
        {p.markers.map((mk) => { const s = live.find((x) => x.id === mk.series); if (!s?.f) return null; const i = s.f.reduce((b, f, k) => (Math.abs(f - mk.x) < Math.abs(s.f![b] - mk.x) ? k : b), 0); const [a, b] = P(s.x[i], s.y[i]); return <g key={mk.id}><circle cx={a} cy={b} r={4.5} fill="none" stroke={mk.color} strokeWidth={2} /><text x={a + 7} y={b - 7} className="pl-mk-l">{mk.name}</text></g> })}
      </svg>
      {hover && (() => {
        const g = { r: hover.s.x[hover.i], i: hover.s.y[hover.i] }, d = (1 - g.r) ** 2 + g.i ** 2
        const z = { r: (50 * (1 - g.r * g.r - g.i * g.i)) / d, x: (50 * 2 * g.i) / d }
        return <Tip x={hover.px} y={hover.py} W={W} head={`Freq ${hover.s.f?.[hover.i].toFixed(3)} GHz`} rows={[{ label: 'Z (Ω)', v: `${z.r.toFixed(1)} ${z.x < 0 ? '−' : '+'} j${Math.abs(z.x).toFixed(1)}`, color: hover.s.color }, { label: '|Γ|', v: Math.hypot(g.r, g.i).toFixed(3), color: hover.s.color }]} />
      })()}
      <Legend series={live} />
    </div>
  )
}
