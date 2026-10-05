import { useWidth } from './LineChart'

/** Impedance Smith chart. Input: complex reflection coefficient samples. */
export function SmithChart({ re, im, marker, height = 300 }: { re: number[]; im: number[]; marker?: number; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const R = Math.min(W, height) / 2 - 14
  const cx = W / 2
  const cy = height / 2
  const P = (x: number, y: number) => [cx + x * R, cy - y * R]
  const rCircles = [0.2, 0.5, 1, 2, 5]
  const xArcs = [0.2, 0.5, 1, 2, 5]
  const pts = re.map((r, i) => P(r, im[i]).map((v) => v.toFixed(1)).join(',')).join(' ')
  const mk = marker !== undefined ? P(re[marker], im[marker]) : null
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={W} height={height} style={{ display: 'block' }}>
        <defs><clipPath id="smith-clip"><circle cx={cx} cy={cy} r={R} /></clipPath></defs>
        <circle cx={cx} cy={cy} r={R} fill="#fff" stroke="#9aa6b8" strokeWidth={1.4} />
        <g clipPath="url(#smith-clip)" stroke="#d5dbe4" fill="none">
          {rCircles.map((r) => <circle key={r} cx={cx + (r / (1 + r)) * R} cy={cy} r={R / (1 + r)} />)}
          {xArcs.map((x) => (
            <g key={x}>
              <circle cx={cx + R} cy={cy - R / x} r={R / x} />
              <circle cx={cx + R} cy={cy + R / x} r={R / x} />
            </g>
          ))}
          <line x1={cx - R} x2={cx + R} y1={cy} y2={cy} />
        </g>
        {rCircles.map((r) => (
          <text key={r} x={cx + ((r - 1) / (r + 1)) * R + 3} y={cy - 4} fontSize={10} fill="#7a8496">{r}</text>
        ))}
        <polyline points={pts} fill="none" stroke="#c2541e" strokeWidth={2.2} strokeLinejoin="round" />
        <circle cx={cx} cy={cy} r={2.5} fill="#9aa6b8" />
        {mk && <circle cx={mk[0]} cy={mk[1]} r={5.5} fill="#14213d" stroke="#fff" strokeWidth={1.5} />}
      </svg>
    </div>
  )
}

/** Polar pattern plot (dB, normalised), theta from -90..90 drawn as upper half-plane cut. */
export function PolarChart({ theta, series, height = 300, floor = -30 }: {
  theta: number[]; series: { y: number[]; color: string; label: string; dash?: string }[]; height?: number; floor?: number
}) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const R = Math.min(W / 2, height - 30) - 12
  const cx = W / 2
  const cy = height - 22
  const rr = (db: number) => (Math.max(db, floor) - floor) / -floor * R
  const P = (t: number, db: number) => [cx + rr(db) * Math.sin((t * Math.PI) / 180), cy - rr(db) * Math.cos((t * Math.PI) / 180)]
  const rings = [0, -10, -20, -30].filter((v) => v >= floor)
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={W} height={height} style={{ display: 'block' }}>
        {rings.map((d) => (
          <g key={d}>
            <path d={`M ${cx - rr(d)} ${cy} A ${rr(d)} ${rr(d)} 0 0 1 ${cx + rr(d)} ${cy}`} fill="none" stroke="#dde2ea" />
            <text x={cx + rr(d) + 2} y={cy + 14} fontSize={10.5} fill="#7a8496" textAnchor="middle">{d}</text>
          </g>
        ))}
        {[-90, -60, -30, 0, 30, 60, 90].map((t) => {
          const [x, y] = P(t, 0)
          return (
            <g key={t}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="#e7eaf0" />
              <text x={cx + (R + 10) * Math.sin((t * Math.PI) / 180)} y={cy - (R + 6) * Math.cos((t * Math.PI) / 180)} fontSize={10.5} fill="#7a8496" textAnchor="middle">{t}°</text>
            </g>
          )
        })}
        {series.map((s) => (
          <polyline key={s.label} fill="none" stroke={s.color} strokeWidth={2.2} strokeDasharray={s.dash}
            points={theta.map((t, i) => P(t, s.y[i]).map((v) => v.toFixed(1)).join(',')).join(' ')} />
        ))}
      </svg>
      <div className="row small muted" style={{ justifyContent: 'center', gap: 18 }}>
        {series.map((s) => (
          <span key={s.label} className="row" style={{ gap: 6 }}>
            <svg width="22" height="8"><line x1="0" x2="22" y1="4" y2="4" stroke={s.color} strokeWidth="2.5" strokeDasharray={s.dash} /></svg>{s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
