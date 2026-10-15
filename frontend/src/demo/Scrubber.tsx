import { useEffect, useMemo, useRef, useState } from 'react'
import { type Design, FREQS, F_RANGE, GOAL, curve, s11, zin } from './model'
import { now } from './store'

/** S11 strip you can drag along to pick a frequency. Play sweeps the whole range. */
export function FreqScrubber({ d, f, onF }: { d: Design; f: number; onF: (f: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(500)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!playing) return
    let raf = 0, last = now(), cur = f >= F_RANGE[1] - 0.005 ? F_RANGE[0] : f
    const loop = () => {
      const n = now(); cur += (n - last) * 0.09; last = n
      if (cur >= F_RANGE[1]) { onF(F_RANGE[1]); setPlaying(false); return }
      onF(cur); raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])
  const H = 46, top = 4
  const c = useMemo(() => curve(d), [d])
  const X = (v: number) => ((v - F_RANGE[0]) / (F_RANGE[1] - F_RANGE[0])) * w
  const Y = (db: number) => top + (Math.min(0, Math.max(-35, db)) / -35) * (H - top - 2)
  const pick = (e: React.PointerEvent) => {
    if (e.type === 'pointermove' && !(e.buttons & 1)) return
    const r = ref.current!.getBoundingClientRect()
    const v = F_RANGE[0] + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (F_RANGE[1] - F_RANGE[0])
    setPlaying(false); onF(Math.round(v * 1000) / 1000)
  }
  const z = zin(f, d), db = s11(f, d)
  return (
    <div className="scrub">
      <button className="btn play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause sweep' : 'Sweep frequency'}>{playing ? '❚❚' : '▶'}</button>
      <div className="scrub-main">
        <div className="scrub-cap">frequency · drag along the S11 curve</div>
        <div className="scrub-strip" ref={ref} onPointerDown={pick} onPointerMove={pick}>
          <svg width={w} height={H}>
            <rect x={X(GOAL.f1)} y={0} width={X(GOAL.f2) - X(GOAL.f1)} height={H} fill="var(--ok)" opacity={0.13} />
            <line x1={0} x2={w} y1={Y(-10)} y2={Y(-10)} stroke="var(--sig)" strokeDasharray="4 3" strokeWidth={1} />
            <polyline points={FREQS.map((x, i) => `${X(x).toFixed(1)},${Y(c[i]).toFixed(1)}`).join(' ')} fill="none" stroke="var(--ink)" strokeWidth={1.6} />
            <line x1={X(f)} x2={X(f)} y1={0} y2={H} stroke="var(--sig)" strokeWidth={2} />
            <circle cx={X(f)} cy={Y(db)} r={4.5} fill="var(--sig)" />
          </svg>
        </div>
        <div className="scrub-axis">{[2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8].map((v) => <span key={v} style={{ left: X(v) }}>{v.toFixed(1)}</span>)}</div>
      </div>
      <div className="scrub-read">
        <b>{f.toFixed(3)} GHz</b>
        <span>S11 {db.toFixed(1)} dB</span>
        <span>input {z.r.toFixed(0)} {z.x >= 0 ? '+' : '−'} j{Math.abs(z.x).toFixed(0)} Ω</span>
      </div>
    </div>
  )
}

