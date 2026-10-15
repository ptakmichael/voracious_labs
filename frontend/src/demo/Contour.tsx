import { useEffect, useMemo, useRef, useState } from 'react'
import { type Design, worstInBand } from './model'

const LEVELS = [-25, -20, -15, -12, -10, -8, -6, -4, -2]
// good (deep match) is dark green ink, bad fades into the paper
const RAMP = ['#1f4a35', '#2f6a4c', '#4f8566', '#7aa287', '#a9c0a8', '#d8d4c2', '#e4ded0', '#ebe6da', '#f0ece3', '#f5f2ec']
const X: [number, number] = [4, 12] // inset depth
const Y: [number, number] = [27.6, 31.4] // patch length
const NX = 81, NY = 61

/** Worst in-band match over patch length × inset depth. Click anywhere to move the design there. */
export function Contour({ d, path, onPick, height = 330 }: { d: Design; path: Design[]; onPick: (L: number, y0: number) => void; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const [W, setW] = useState(500)
  const m = { l: 52, r: 12, t: 10, b: 40 }
  const pw = W - m.l - m.r, ph = height - m.t - m.b
  const grid = useMemo(() => {
    const g = new Float32Array(NX * NY)
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const y0 = X[0] + ((X[1] - X[0]) * i) / (NX - 1), L = Y[1] - ((Y[1] - Y[0]) * j) / (NY - 1)
      g[j * NX + i] = worstInBand({ ...d, L, y0 }, 0.004)
    }
    return g
    // board settings change the landscape; L and y0 only move the marker
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.W, d.h, d.er, d.gs])
  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver((e) => setW(Math.max(260, e[0].contentRect.width)))
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const c = cv.current
    if (!c) return
    const w = Math.round(pw), h = Math.round(ph)
    c.width = w; c.height = h
    const g = c.getContext('2d')!
    const img = g.createImageData(w, h)
    const lvl = new Int8Array(w * h)
    const at = (x: number, y: number) => {
      const fx = (x / (w - 1)) * (NX - 1), fy = (y / (h - 1)) * (NY - 1)
      const i = Math.min(NX - 2, Math.floor(fx)), j = Math.min(NY - 2, Math.floor(fy)), a = fx - i, b = fy - j
      const v = grid[j * NX + i] * (1 - a) * (1 - b) + grid[j * NX + i + 1] * a * (1 - b) + grid[(j + 1) * NX + i] * (1 - a) * b + grid[(j + 1) * NX + i + 1] * a * b
      let k = 0
      while (k < LEVELS.length && v > LEVELS[k]) k++
      return k
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lvl[y * w + x] = at(x, y)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = lvl[y * w + x]
      const edge = (x + 1 < w && lvl[y * w + x + 1] !== k) || (y + 1 < h && lvl[(y + 1) * w + x] !== k)
      const goalEdge = edge && (Math.min(k, x + 1 < w ? lvl[y * w + x + 1] : k, y + 1 < h ? lvl[(y + 1) * w + x] : k) === 4)
      const hex = goalEdge ? '#cf4520' : edge ? '#3b3934' : RAMP[k]
      const o = (y * w + x) * 4
      img.data[o] = parseInt(hex.slice(1, 3), 16); img.data[o + 1] = parseInt(hex.slice(3, 5), 16); img.data[o + 2] = parseInt(hex.slice(5, 7), 16)
      img.data[o + 3] = edge && !goalEdge ? 150 : 255
    }
    g.putImageData(img, 0, 0)
  }, [grid, pw, ph])
  const px = (y0: number) => m.l + ((y0 - X[0]) / (X[1] - X[0])) * pw
  const py = (L: number) => m.t + ((Y[1] - L) / (Y[1] - Y[0])) * ph
  const pick = (e: React.MouseEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const x = e.clientX - r.left, y = e.clientY - r.top
    if (x < m.l || x > m.l + pw || y < m.t || y > m.t + ph) return
    onPick(Math.round((Y[1] - ((y - m.t) / ph) * (Y[1] - Y[0])) * 100) / 100, Math.round((X[0] + ((x - m.l) / pw) * (X[1] - X[0])) * 100) / 100)
  }
  const pts = path.filter((p) => p.L >= Y[0] && p.L <= Y[1])
  return (
    <div ref={wrap} style={{ position: 'relative', width: '100%', height }}>
      <canvas ref={cv} style={{ position: 'absolute', left: m.l, top: m.t, width: pw, height: ph }} />
      <svg width={W} height={height} style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }} onClick={pick}>
        <rect x={m.l} y={m.t} width={pw} height={ph} fill="none" stroke="var(--ink)" />
        {[4, 6, 8, 10, 12].map((v) => <text key={v} x={px(v)} y={height - m.b + 16} fontSize={11} textAnchor="middle" fill="var(--mute)">{v}</text>)}
        {[28, 29, 30, 31].map((v) => <text key={v} x={m.l - 8} y={py(v) + 4} fontSize={11} textAnchor="end" fill="var(--mute)">{v}</text>)}
        <text x={m.l + pw / 2} y={height - 6} fontSize={11.5} textAnchor="middle" fill="var(--ink-2)">inset depth (mm)</text>
        <text transform={`translate(13 ${m.t + ph / 2}) rotate(-90)`} fontSize={11.5} textAnchor="middle" fill="var(--ink-2)">patch length (mm)</text>
        {pts.length > 1 && <polyline points={pts.map((p) => `${px(p.y0)},${py(p.L)}`).join(' ')} fill="none" stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="4 3" />}
        {pts.map((p, i) => <circle key={i} cx={px(p.y0)} cy={py(p.L)} r={3.5} fill="var(--sheet)" stroke="var(--ink)" strokeWidth={1.5} />)}
        <g transform={`translate(${px(d.y0)} ${py(d.L)})`}>
          <line x1={-10} x2={10} stroke="var(--sig)" strokeWidth={2} /><line y1={-10} y2={10} stroke="var(--sig)" strokeWidth={2} />
          <circle r={5} fill="none" stroke="var(--sig)" strokeWidth={2} />
        </g>
      </svg>
    </div>
  )
}

export const CONTOUR_LEGEND = { LEVELS, RAMP }
