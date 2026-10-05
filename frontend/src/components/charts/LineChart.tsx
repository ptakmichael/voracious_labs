import { useEffect, useRef, useState } from 'react'

export interface Series { x: number[]; y: number[]; color: string; width?: number; dash?: string; label?: string; dot?: boolean }
export interface Band { x: number[]; lo: number[]; hi: number[]; color: string; opacity?: number }

interface Props {
  series: Series[]
  bands?: Band[]
  vbands?: { x1: number; x2: number; color: string; opacity?: number }[]
  hlines?: { y: number; color: string; dash?: string; label?: string }[]
  xDomain: [number, number]
  yDomain: [number, number]
  yLog?: boolean
  xTicks?: number[]
  yTicks?: number[]
  xLabel?: string
  yLabel?: string
  height?: number
  xFmt?: (v: number) => string
  yFmt?: (v: number) => string
  legend?: boolean
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((e) => setW(Math.max(200, e[0].contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export function LineChart(p: Props) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const H = p.height ?? 280
  const m = { l: 56, r: 16, t: 12, b: p.xLabel ? 44 : 28 }
  const [x0, x1] = p.xDomain
  const [y0, y1] = p.yDomain
  const tf = (v: number) => (p.yLog ? Math.log10(Math.max(v, 1e-30)) : v)
  const X = (v: number) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r)
  const Y = (v: number) => m.t + (1 - (tf(v) - tf(y0)) / (tf(y1) - tf(y0))) * (H - m.t - m.b)
  const clampY = (v: number) => Math.min(Math.max(Y(v), m.t), H - m.b)
  const xt = p.xTicks ?? Array.from({ length: 5 }, (_, i) => x0 + ((x1 - x0) * i) / 4)
  const yt = p.yTicks ?? Array.from({ length: 4 }, (_, i) => y0 + ((y1 - y0) * i) / 3)
  const xf = p.xFmt ?? ((v) => v.toFixed(2))
  const yf = p.yFmt ?? ((v) => `${Math.round(v)}`)
  const pts = (xs: number[], ys: number[]) => xs.map((x, i) => `${X(x).toFixed(1)},${clampY(ys[i]).toFixed(1)}`).join(' ')
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={W} height={H} style={{ display: 'block' }} role="img">
        <defs>
          <clipPath id={`clip-${W}-${H}`}><rect x={m.l} y={m.t} width={W - m.l - m.r} height={H - m.t - m.b} /></clipPath>
        </defs>
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={m.l} x2={W - m.r} y1={Y(v)} y2={Y(v)} stroke="#dde2ea" />
            <text x={m.l - 10} y={Y(v) + 4} fontSize={12.5} textAnchor="end" fill="#4a5568">{yf(v)}</text>
          </g>
        ))}
        {xt.map((v) => (
          <text key={`x${v}`} x={X(v)} y={H - m.b + 18} fontSize={12.5} textAnchor="middle" fill="#4a5568">{xf(v)}</text>
        ))}
        {p.xLabel && <text x={(m.l + W - m.r) / 2} y={H - 6} fontSize={12.5} textAnchor="middle" fill="#4a5568">{p.xLabel}</text>}
        {p.yLabel && <text transform={`translate(14 ${(m.t + H - m.b) / 2}) rotate(-90)`} fontSize={12.5} textAnchor="middle" fill="#4a5568">{p.yLabel}</text>}
        <g clipPath={`url(#clip-${W}-${H})`}>
          {p.vbands?.map((b, i) => (
            <rect key={i} x={X(b.x1)} y={m.t} width={Math.max(0, X(b.x2) - X(b.x1))} height={H - m.t - m.b} fill={b.color} opacity={b.opacity ?? 0.1} />
          ))}
          {p.bands?.map((b, i) => (
            <polygon key={i} points={`${pts(b.x, b.hi)} ${pts([...b.x].reverse(), [...b.lo].reverse())}`} fill={b.color} opacity={b.opacity ?? 0.18} />
          ))}
          {p.hlines?.map((h, i) => (
            <g key={i}>
              <line x1={m.l} x2={W - m.r} y1={Y(h.y)} y2={Y(h.y)} stroke={h.color} strokeDasharray={h.dash ?? '6 5'} strokeWidth={1.5} />
              {h.label && <text x={W - m.r - 4} y={Y(h.y) - 6} fontSize={12} textAnchor="end" fill={h.color}>{h.label}</text>}
            </g>
          ))}
          {p.series.map((s, i) => s.x.length > 1 && (
            <g key={i}>
              <polyline points={pts(s.x, s.y)} fill="none" stroke={s.color} strokeWidth={s.width ?? 2.2} strokeDasharray={s.dash} strokeLinejoin="round" />
              {s.dot && <circle cx={X(s.x[s.x.length - 1])} cy={clampY(s.y[s.y.length - 1])} r={5} fill={s.color} />}
            </g>
          ))}
        </g>
      </svg>
      {p.legend && (
        <div className="row wrap small muted" style={{ gap: 16, paddingLeft: m.l }}>
          {p.series.filter((s) => s.label).map((s) => (
            <span key={s.label} className="row" style={{ gap: 6 }}>
              <svg width="22" height="8"><line x1="0" x2="22" y1="4" y2="4" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} /></svg>{s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** S11 (dB) chart with the house style: blue goal band, dashed orange threshold. */
export function S11Chart({ f, s, goal, fRange, live, band, extra, height }: {
  f: number[]; s: number[]; goal: { threshold_db: number; f1: number; f2: number }; fRange: [number, number]
  live?: boolean; band?: { lo: number[]; hi: number[] }; extra?: Series[]; height?: number
}) {
  const minY = Math.min(-30, Math.floor(Math.min(...s, -30) / 10) * 10)
  const ticks = []
  for (let v = 0; v >= minY; v -= 10) ticks.push(v)
  return (
    <LineChart
      height={height ?? 300}
      xDomain={fRange}
      yDomain={[minY, 0.5]}
      yTicks={ticks}
      xLabel="Frequency (GHz)"
      vbands={[{ x1: goal.f1, x2: goal.f2, color: '#2c5d9e', opacity: 0.1 }]}
      hlines={[{ y: goal.threshold_db, color: '#c2541e' }]}
      bands={band ? [{ x: f, lo: band.lo, hi: band.hi, color: '#c2541e', opacity: 0.2 }] : []}
      series={[...(extra ?? []), { x: f, y: s, color: '#c2541e', width: 2.4, dot: live, label: 'S11' }]}
      legend={!!extra?.length}
    />
  )
}
