import { useWidth } from './LineChart'

const R_CIRCLES = [0.2, 0.5, 1, 2, 5]
const X_ARCS = [0.2, 0.5, 1, 2, 5]

/** Constant-resistance circles and reactance arcs, clipped to the unit circle. */
function SmithGrid({ cx, cy, R, id }: { cx: number; cy: number; R: number; id: string }) {
  return (
    <>
      <defs><clipPath id={id}><circle cx={cx} cy={cy} r={R} /></clipPath></defs>
      <circle cx={cx} cy={cy} r={R} fill="var(--c-paper)" stroke="var(--c-grey)" strokeWidth={1.4} />
      <g clipPath={`url(#${id})`} stroke="var(--c-smith)" fill="none">
        {R_CIRCLES.map((r) => <circle key={r} cx={cx + (r / (1 + r)) * R} cy={cy} r={R / (1 + r)} />)}
        {X_ARCS.map((x) => (
          <g key={x}>
            <circle cx={cx + R} cy={cy - R / x} r={R / x} />
            <circle cx={cx + R} cy={cy + R / x} r={R / x} />
          </g>
        ))}
        <line x1={cx - R} x2={cx + R} y1={cy} y2={cy} />
      </g>
      {R_CIRCLES.map((r) => (
        <text key={r} x={cx + ((r - 1) / (r + 1)) * R + 3} y={cy - 4} fontSize={10} fill="var(--c-label)">{r}</text>
      ))}
    </>
  )
}

/** Impedance Smith chart. Input: complex reflection coefficient samples. */
export function SmithChart({ re, im, marker, height = 300 }: { re: number[]; im: number[]; marker?: number; height?: number }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const R = Math.min(W, height) / 2 - 14
  const cx = W / 2
  const cy = height / 2
  const P = (x: number, y: number) => [cx + x * R, cy - y * R]
  const pts = re.map((r, i) => P(r, im[i]).map((v) => v.toFixed(1)).join(',')).join(' ')
  const mk = marker !== undefined ? P(re[marker], im[marker]) : null
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={W} height={height} style={{ display: 'block' }}>
        <SmithGrid cx={cx} cy={cy} R={R} id="smith-clip" />
        <polyline points={pts} fill="none" stroke="var(--c-orange)" strokeWidth={2.2} strokeLinejoin="round" />
        <circle cx={cx} cy={cy} r={2.5} fill="var(--c-grey)" />
        {mk && <circle cx={mk[0]} cy={mk[1]} r={5.5} fill="var(--c-ink)" stroke="var(--c-paper)" strokeWidth={1.5} />}
      </svg>
    </div>
  )
}

/** Impedance trajectory as a design variable sweeps its range: arrow toward increasing variable, a dot at the
 * current design, and labelled endpoints (EXPLORER_README §2.6). */
export function SmithTrajectory({ path, now, height = 300, fmtEnd }: {
  path: { re: number; im: number; z: [number, number] }[]
  now: { re: number; im: number; z: [number, number] }
  height?: number
  fmtEnd: (z: [number, number]) => string
}) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const R = Math.min(W, height) / 2 - 14
  const cx = W / 2
  const cy = height / 2
  const P = (x: number, y: number) => [cx + x * R, cy - y * R]
  if (path.length < 2) return <div ref={ref} />
  const pts = path.map((p) => P(p.re, p.im).map((v) => v.toFixed(1)).join(',')).join(' ')
  const a = P(path[0].re, path[0].im)
  const b = P(path[path.length - 1].re, path[path.length - 1].im)
  const pen = P(path[path.length - 2].re, path[path.length - 2].im)
  const ang = Math.atan2(b[1] - pen[1], b[0] - pen[0])
  const head = (len: number, w: number) => [
    [b[0] + Math.cos(ang) * len * 0.4, b[1] + Math.sin(ang) * len * 0.4],
    [b[0] - Math.cos(ang) * len + Math.sin(ang) * w, b[1] - Math.sin(ang) * len - Math.cos(ang) * w],
    [b[0] - Math.cos(ang) * len - Math.sin(ang) * w, b[1] - Math.sin(ang) * len + Math.cos(ang) * w],
  ].map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ')
  const n = P(now.re, now.im)
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg width={W} height={height} style={{ display: 'block' }} role="img">
        <SmithGrid cx={cx} cy={cy} R={R} id="smith-traj-clip" />
        <polyline points={pts} fill="none" stroke="var(--c-orange)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        <polygon points={head(13, 7)} fill="var(--c-orange)" />
        <circle cx={a[0]} cy={a[1]} r={4} fill="var(--c-orange)" />
        <circle cx={n[0]} cy={n[1]} r={6} fill="var(--c-ink)" stroke="var(--c-paper)" strokeWidth={1.5} />
        {/* start label on the far side of the start point, end label beyond the arrow, so short paths stay legible */}
        <text x={a[0] - Math.cos(ang) * 10} y={a[1] - Math.sin(ang) * 10 - 10} fontSize={11.5} textAnchor={Math.cos(ang) >= 0 ? 'end' : 'start'} fill="var(--c-text)">{fmtEnd(path[0].z)}</text>
        <text x={b[0] + Math.cos(ang) * 14} y={b[1] + Math.sin(ang) * 14 - 10} fontSize={11.5} textAnchor={Math.cos(ang) >= 0 ? 'start' : 'end'} fill="var(--c-text)">{fmtEnd(path[path.length - 1].z)}</text>
        <text x={n[0]} y={n[1] + 22} fontSize={11.5} fontWeight={600} textAnchor="middle" fill="var(--c-ink)">now {fmtEnd(now.z)}</text>
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
            <path d={`M ${cx - rr(d)} ${cy} A ${rr(d)} ${rr(d)} 0 0 1 ${cx + rr(d)} ${cy}`} fill="none" stroke="var(--c-grid)" />
            <text x={cx + rr(d) + 2} y={cy + 14} fontSize={10.5} fill="var(--c-label)" textAnchor="middle">{d}</text>
          </g>
        ))}
        {[-90, -60, -30, 0, 30, 60, 90].map((t) => {
          const [x, y] = P(t, 0)
          return (
            <g key={t}>
              <line x1={cx} y1={cy} x2={x} y2={y} stroke="var(--c-grid-2)" />
              <text x={cx + (R + 10) * Math.sin((t * Math.PI) / 180)} y={cy - (R + 6) * Math.cos((t * Math.PI) / 180)} fontSize={10.5} fill="var(--c-label)" textAnchor="middle">{t}°</text>
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
