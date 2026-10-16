import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { LineChart, type Series } from '../components/charts/LineChart'
import { type ArrayDesign, PAPER_ARRAY, PAPER_ELEMENT } from './arrayModel'
import { type Design, PAPER_AS_WRITTEN } from './model'
import { type PaperPlot, PAPER_PLOTS } from './paperPlots'
import { arraySeries, music, patchSeries } from './paperPhysics'
import { useDemo } from './store'

/**
 * Paper vs ours: every results figure in the paper, with our solver's curves for the same quantity on top. Overlay
 * mode draws onto the original figure (cropped from the PDF, our curves placed with the figure's own axis
 * calibration); side-by-side mode re-plots both on clean axes.
 */

type Who = 'written' | 'built' | 'final'
const WHO: Record<Who, { label: string; color: string; dash?: string }> = {
  written: { label: 'Ours, paper as written', color: '#2c4a72', dash: '6 3' },
  built: { label: 'Ours, as built (run 1)', color: '#2f6a4c' },
  final: { label: 'Ours, final design', color: '#cf4520' },
}
const PAPER_COLOR = '#6f6a5f'

// ---------------------------------------------------------------- the original figure, cropped from the PDF

const docs = new WeakMap<ArrayBuffer, Promise<PDFDocumentProxy>>()
const getDoc = (data: ArrayBuffer) => { let p = docs.get(data); if (!p) { p = pdfjs.getDocument({ data: data.slice(0) }).promise; docs.set(data, p) } return p }

function Figure({ data, plot, width, children }: { data: ArrayBuffer; plot: PaperPlot; width: number; children?: (s: number) => React.ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [x0, y0, x1, y1] = plot.box
  const s = width / (x1 - x0), h = (y1 - y0) * s
  useEffect(() => {
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null, live = true
    getDoc(data).then(async (doc) => {
      const page = await doc.getPage(plot.page)
      if (!live || !ref.current) return
      const dpr = window.devicePixelRatio || 1
      const vp = page.getViewport({ scale: s * dpr, offsetX: -x0 * s * dpr, offsetY: -y0 * s * dpr })
      const c = ref.current
      c.width = Math.round(width * dpr); c.height = Math.round(h * dpr)
      task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp })
      task.promise.catch(() => {})
    })
    return () => { live = false; task?.cancel() }
  }, [data, plot.page, x0, y0, s, width, h])
  return (
    <div className="cmp-fig" style={{ width, height: h }}>
      <canvas ref={ref} style={{ width, height: h }} />
      {children && <svg width={width} height={h} className="cmp-svg">{children(s)}</svg>}
    </div>
  )
}

/** Our curves drawn in the figure's own coordinates. */
function Overlay({ plot, s, sets }: { plot: PaperPlot; s: number; sets: { who: Who; series: { label: string; data: [number, number][] }[] }[] }) {
  const [x0, y0] = plot.box
  const P = (v: [number, number]): [number, number] | null => {
    if (plot.kind === 'xy' && plot.map) return [(plot.map.x[0] * v[0] + plot.map.x[1] - x0) * s, (plot.map.y[0] * v[1] + plot.map.y[1] - y0) * s]
    if (plot.kind === 'polar' && plot.polar) {
      const p = plot.polar, r = (Math.max(v[1], p.floor) - p.floor) * p.ptPerDb, a = (v[0] * Math.PI) / 180
      return [(p.cx + r * Math.sin(a) - x0) * s, (p.cy - r * Math.cos(a) - y0) * s]
    }
    return null
  }
  // keep xy curves inside the plot frame
  const clip = plot.kind === 'xy' && plot.xDomain && plot.yDomain ? (() => {
    const a = P([plot.xDomain[0], plot.yDomain[1]])!, b = P([plot.xDomain[1], plot.yDomain[0]])!
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }
  })() : null
  const id = `clip-${plot.id}`
  return (
    <>
      {clip && <defs><clipPath id={id}><rect x={clip.x} y={clip.y} width={clip.w} height={clip.h} /></clipPath></defs>}
      <g clipPath={clip ? `url(#${id})` : undefined}>
        {sets.flatMap(({ who, series }) => series.map((sr, k) => {
          const pts = sr.data.map(P).filter(Boolean) as [number, number][]
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('')
          return (
            <g key={`${who}${k}`}>
              <path d={d} fill="none" stroke="#fff" strokeWidth={4.5} opacity={0.75} />
              <path d={d} fill="none" stroke={WHO[who].color} strokeWidth={2.2} strokeDasharray={k ? '2 3' : WHO[who].dash} />
            </g>
          )
        }))}
      </g>
    </>
  )
}

// ---------------------------------------------------------------- side by side

function polarPath(data: [number, number][], cx: number, cy: number, R: number, floor: number, top: number) {
  return data.map(([a, db], i) => {
    const r = (R * (Math.max(db, floor) - floor)) / (top - floor), t = (a * Math.PI) / 180
    return `${i ? 'L' : 'M'}${(cx + r * Math.sin(t)).toFixed(1)},${(cy - r * Math.cos(t)).toFixed(1)}`
  }).join('')
}

function PolarChart({ plot, sets, size }: { plot: PaperPlot; sets: { who: Who; series: { label: string; data: [number, number][] }[] }[]; size: number }) {
  const floor = plot.polar?.floor ?? -30
  const all = [...plot.series.flatMap((s) => s.data), ...sets.flatMap((x) => x.series.flatMap((s) => s.data))]
  const top = Math.ceil((Math.max(...all.map((p) => p[1])) + 2) / 5) * 5
  const cx = size / 2, cy = size / 2, R = size / 2 - 22
  const rings = []; for (let v = floor; v <= top; v += 10) rings.push(v)
  return (
    <svg width={size} height={size} className="cmp-polar">
      {rings.map((v) => <g key={v}><circle cx={cx} cy={cy} r={(R * (v - floor)) / (top - floor)} fill="none" stroke="var(--c-grid)" /><text x={cx + 3} y={cy - (R * (v - floor)) / (top - floor) + 10} fontSize={9.5} fill="var(--faint)">{v}</text></g>)}
      {[0, 30, 60, 90, 120, 150, 180, -30, -60, -90, -120, -150].map((a) => {
        const t = (a * Math.PI) / 180
        return <g key={a}><line x1={cx} y1={cy} x2={cx + R * Math.sin(t)} y2={cy - R * Math.cos(t)} stroke="var(--c-grid)" /><text x={cx + (R + 11) * Math.sin(t)} y={cy - (R + 11) * Math.cos(t) + 3} fontSize={9.5} textAnchor="middle" fill="var(--faint)">{Math.abs(a)}</text></g>
      })}
      {plot.series.map((s) => <path key={s.label} d={polarPath(s.data, cx, cy, R, floor, top)} fill="none" stroke={PAPER_COLOR} strokeWidth={2.4} strokeDasharray="5 3" />)}
      {sets.map(({ who, series }) => series.map((s) => <path key={who + s.label} d={polarPath(s.data, cx, cy, R, floor, top)} fill="none" stroke={WHO[who].color} strokeWidth={2} strokeDasharray={WHO[who].dash} />))}
      <text x={6} y={size - 6} fontSize={10} fill="var(--mute)">dBi</text>
    </svg>
  )
}

function SideBySide({ plot, sets, width }: { plot: PaperPlot; sets: { who: Who; series: { label: string; data: [number, number][] }[] }[]; width: number }) {
  if (plot.kind === 'polar') return <PolarChart plot={plot} sets={sets} size={Math.min(width, 330)} />
  const series: Series[] = [
    ...plot.series.map((s, k): Series => ({ x: s.data.map((p) => p[0]), y: s.data.map((p) => p[1]), color: PAPER_COLOR, width: 2.6, dash: k ? '2 3' : '6 3', label: `paper · ${s.label}` })),
    ...sets.flatMap(({ who, series: ss }) => ss.map((s, k): Series => ({ x: s.data.map((p) => p[0]), y: s.data.map((p) => p[1]), color: WHO[who].color, width: 2, dash: k ? '2 3' : WHO[who].dash, label: `${WHO[who].label.replace('Ours, ', 'ours · ')}${ss.length > 1 ? ` · ${s.label}` : ''}` }))),
  ]
  const yd = plot.yDomain ?? [-30, 5]
  return <LineChart height={230} xDomain={plot.xDomain ?? [2, 2.8]} yDomain={yd} xLabel={plot.xLabel} yLabel={plot.yLabel} xFmt={(v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))} yFmt={(v) => (Math.abs(yd[1] - yd[0]) < 0.1 ? v.toFixed(3) : Math.abs(yd[1] - yd[0]) < 2 ? v.toFixed(1) : v.toFixed(0))} series={series} legend />
}

// ---------------------------------------------------------------- what each figure tells us

const near = (data: [number, number][], x: number) => data.reduce((b, p) => (Math.abs(p[0] - x) < Math.abs(b[0] - x) ? p : b), data[0])
const minOf = (data: [number, number][]) => data.reduce((b, p) => (p[1] < b[1] ? p : b), data[0])
const maxOf = (data: [number, number][]) => data.reduce((b, p) => (p[1] > b[1] ? p : b), data[0])
const f2 = (v: number, n = 2) => v.toFixed(n)

function finding(plot: PaperPlot, sets: Record<Who, { label: string; data: [number, number][] }[] | undefined>): string {
  const paper = plot.series[0]?.data ?? []
  const w = sets.written?.[0]?.data ?? [], b = sets.built?.[0]?.data ?? [], fin = sets.final?.[0]?.data ?? []
  switch (`${plot.id}`) {
    case 'p5': { const p = minOf(paper), a = minOf(w), c = minOf(b), z = minOf(fin); return `Paper: ${f2(p[1], 1)} dB at ${f2(p[0], 3)} GHz. With εr = 4.08 as written we get the dip at ${f2(a[0], 3)} GHz; on real FR-4 (εr 4.4) it moves to ${f2(c[0], 3)} GHz and misses the band. After tuning: ${f2(z[1], 1)} dB at ${f2(z[0], 3)} GHz.` }
    case 'p4': case 'p6': { const p = minOf(paper), z = minOf(fin); return `Paper: VSWR ${f2(p[1])} at ${f2(p[0], 3)} GHz. Ours after tuning: ${f2(z[1])} at ${f2(z[0], 3)} GHz. Off resonance both climb past 20, as a single narrow resonance should.` }
    case 'p7': { const p = maxOf(paper), z = near(fin, 2.4), r = near(sets.final?.[1]?.data ?? [], 2.4); return `Paper: ${f2(p[1])} dBi at 2.40 GHz, falling ~4 dB by 2.0 and 2.8 GHz. A patch's IEEE gain shouldn't fall that fast; its realised gain (mismatch included, dotted) does, so the paper's curve behaves like realised gain. It is also computed at three frequencies only (straight lines). Ours: ${f2(z[1], 1)} dBi IEEE, ${f2(r[1], 1)} dBi realised at 2.40 GHz.` }
    case 'p8': { const z = near(fin, 2.4); return `Paper: 7.05 dBi at 2.40 GHz. Ours: ${f2(z[1])} dBi. Both are typical for a patch on a ground about 0.4 λ across; most of the 0.5 dB gap is the edge model.` }
    case 'p9': { const acc = near(sets.final?.[0]?.data ?? [], 2.4)[1], rad = near(sets.final?.[2]?.data ?? [], 2.4)[1]; return `Paper at 2.40 GHz: 0.50 W accepted, 0.23 W radiated (46%), 0.24 W lost in the FR-4. Ours after tuning: ${f2(acc)} W accepted, ${f2(rad)} W radiated (${((rad / acc) * 100).toFixed(0)}%). We use tan δ = 0.02; a higher value in their model would explain their lower efficiency.` }
    case 'p10': {
      const pk = maxOf(fin), half = fin.filter((q) => q[1] >= pk[1] - 3), bw = Math.max(...half.map((q) => q[0])) - Math.min(...half.map((q) => q[0]))
      const back = near(fin, 180)[1]
      return `Paper: 3.72 dBi peak, 87.8° beamwidth. Ours: ${f2(pk[1], 1)} dBi, ${bw.toFixed(0)}° beamwidth, ${f2(back, 1)} dBi straight behind. Same broad, single-lobed shape; the extra gain is our lower dielectric loss (see Fig. 9).`
    }
    case 'p12': { const z = near(fin, 180), nl = minOf(fin.filter((q) => q[0] > 100)); return `Paper: a rear null near 155° and −14.8 dBi straight behind. Ours: a null at ${nl[0].toFixed(0)}° and ${f2(z[1], 1)} dBi behind. The null is where the field leaking round the edge of the ground cancels the direct field, so its angle is set by the board size.` }
    case 'p13': return 'Paper: about 0.0024 W "absorbed at all ports" at every frequency, swinging negative at 2.05 and 2.15 GHz. Absorbed power can\'t be negative, and Fig. 9 shows ~0.4 W leaving the port off resonance, so this trace is numerical noise. Ours is the reflected power, 0.5·|S11|².'
    case 'p14': { const z = near(fin, 2.4); return `Paper: 0.239 W dielectric loss and 0.015 W metal loss at 2.40 GHz. Ours: ${f2(z[1], 3)} W dielectric. FR-4 is the dominant loss either way; a low-loss board (Rogers) would roughly double the radiated power.` }
    case 'p16': { const z = near(fin, 2.4); return `Paper: radiation efficiency −3.33 dB at 2.40 GHz, falling to −6.7 dB at 2.8 GHz. A resonator's loss split hardly changes across 0.8 GHz, so ours stays near ${f2(z[1], 1)} dB; their drop again points to far fields computed at three frequencies and joined with straight lines. Total efficiency matches in shape.` }
    case 'a3': { const p = minOf(paper), a = minOf(w), z = minOf(fin); return `Paper: −25 dB at ${f2(p[0], 3)} GHz, not 2.40 as the text says, and with a coax feed. With the inset feed in Table I we get ${f2(a[1], 1)} dB at ${f2(a[0], 3)} GHz; after optimising, ${f2(z[1], 1)} dB at ${f2(z[0], 3)} GHz.` }
  }
  if (plot.id.startsWith('a5')) {
    const p = maxOf(paper.filter((q) => Math.abs(q[0]) <= 90)), a = maxOf(w.filter((q) => Math.abs(q[0]) <= 90)), z = maxOf(fin.filter((q) => Math.abs(q[0]) <= 90))
    return `Paper: ${f2(p[1], 1)} dBi at ${f2(p[0], 0)}°. Ours as written: ${f2(a[1], 1)} dBi at ${f2(a[0], 1)}°; optimised: ${f2(z[1], 1)} dBi at ${f2(z[0], 1)}°. The beam lands short of the command because the element pattern pulls it toward broadside.`
  }
  return ''
}

// ---------------------------------------------------------------- tab

function DoaCard({ plot, data, a, width }: { plot: PaperPlot; data: ArrayBuffer; a: ArrayDesign; width: number }) {
  const el = plot.id === 'a6'
  const truth = { az: -30, el: 22.94 }
  const one = useMemo(() => music(a, truth.az, truth.el, 20, 1), [a]) // eslint-disable-line react-hooks/exhaustive-deps
  const many = useMemo(() => music(a, truth.az, truth.el, 20, 64), [a]) // eslint-disable-line react-hooks/exhaustive-deps
  const rows: [string, number, string][] = [
    ['true', el ? truth.el : truth.az, 'var(--ink)'], ['paper', el ? -34 : 20, PAPER_COLOR],
    ['ours, 1 snapshot', el ? one.el : one.az, WHO.final.color], ['ours, 64 snapshots', el ? many.el : many.az, WHO.built.color],
  ]
  const S = 170, c = S / 2, R = S / 2 - 16
  return (
    <div className="cmp-doa">
      <Figure data={data} plot={plot} width={Math.min(width * 0.55, 300)} />
      <div>
        <svg width={S} height={S}>
          <circle cx={c} cy={c} r={R} fill="none" stroke="var(--c-grid)" />
          <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="var(--c-grid)" /><line x1={c} y1={c - R} x2={c} y2={c + R} stroke="var(--c-grid)" />
          {rows.map(([k, v, col], i) => { const t = (v * Math.PI) / 180; return <line key={k} x1={c} y1={c} x2={c + (R - i * 6) * Math.cos(t)} y2={c - (R - i * 6) * Math.sin(t)} stroke={col} strokeWidth={2.4} strokeDasharray={k === 'paper' ? '4 3' : undefined} /> })}
        </svg>
        <table className="cmp-tbl"><tbody>{rows.map(([k, v, col]) => <tr key={k}><td><i style={{ background: col }} />{k}</td><td>{v.toFixed(1)}°</td></tr>)}</tbody></table>
      </div>
    </div>
  )
}

export function ComparePane() {
  const s = useDemo()
  const which: 'patch' | 'array' | null = s.kind === 'array' ? 'array' : s.pdf?.paper === 'patch' || s.pdf?.known ? 'patch' : null
  const [mode, setMode] = useState<'overlay' | 'side'>('overlay')
  const [show, setShow] = useState<Record<Who, boolean>>({ written: true, built: false, final: true })
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  const first = s.runs[0], last = s.runs[s.runs.length - 1]
  const designs = useMemo(() => {
    if (!which || !first) return null
    if (which === 'patch') return { written: { d: PAPER_AS_WRITTEN as Design }, built: { d: first.d }, final: { d: last.d } }
    return { written: { d: PAPER_ELEMENT, a: PAPER_ARRAY }, built: { d: first.d, a: first.a ?? PAPER_ARRAY }, final: { d: last.d, a: last.a ?? s.arr } }
  }, [which, first, last]) // eslint-disable-line react-hooks/exhaustive-deps
  const plots = which ? PAPER_PLOTS[which] : []
  const computed = useMemo(() => {
    if (!designs) return {}
    const out: Record<string, Record<Who, { label: string; data: [number, number][] }[]>> = {}
    for (const p of plots) {
      if (p.kind === 'points') continue
      out[p.id] = Object.fromEntries((Object.keys(designs) as Who[]).map((k) => {
        const dd = designs[k] as { d: Design; a?: ArrayDesign }
        return [k, which === 'patch' ? patchSeries(p.quantity, dd.d) : arraySeries(p.quantity, dd.d, dd.a ?? PAPER_ARRAY)]
      })) as Record<Who, { label: string; data: [number, number][] }[]>
    }
    return out
  }, [designs, plots, which])
  if (!which || !s.pdf || !first) return <div className="overlay-note">Solve the design to compare it with the paper.</div>
  const cardW = w > 1100 ? (w - 16 * 3) / 2 : w - 32
  const figW = Math.min(cardW - 28, 560)
  return (
    <div className="pane-grid compare" ref={box}>
      <div className="cmp-bar">
        <div>
          <b>Paper vs ours</b> · every results figure in {which === 'patch' ? 'Islam & Shikha (arXiv 2211.13096)' : 'Saad et al. (arXiv 2508.20905)'}, digitised, with our solver's result for the same quantity on top.
        </div>
        <div className="cmp-ctl">
          <div className="seg"><button className={mode === 'overlay' ? 'on' : ''} onClick={() => setMode('overlay')}>On the original figure</button><button className={mode === 'side' ? 'on' : ''} onClick={() => setMode('side')}>Side by side</button></div>
          {(Object.keys(WHO) as Who[]).map((k) => (
            <label key={k} className="cmp-key"><input type="checkbox" checked={show[k]} onChange={() => setShow({ ...show, [k]: !show[k] })} /><i style={{ borderColor: WHO[k].color, borderStyle: WHO[k].dash ? 'dashed' : 'solid' }} />{WHO[k].label}</label>
          ))}
          {mode === 'side' && <span className="cmp-key"><i style={{ borderColor: PAPER_COLOR, borderStyle: 'dashed' }} />Paper (digitised)</span>}
        </div>
      </div>
      {plots.map((p) => {
        const sets = (Object.keys(WHO) as Who[]).filter((k) => show[k] && computed[p.id]?.[k]).map((k) => ({ who: k, series: computed[p.id][k] }))
        return (
          <div key={p.id} className="card cmp-card" style={{ width: cardW }}>
            <div className="card-h"><h3>{p.fig} · {p.title}</h3><span className="aside">p. {p.page}{p.kind === 'xy' && p.series.length ? ` · ${p.series.reduce((n, x) => n + x.data.length, 0)} points digitised` : ''}</span></div>
            <div className="card-b">
              {p.kind === 'points' ? <DoaCard plot={p} data={s.pdf!.data} a={designs!.final.a ?? PAPER_ARRAY} width={cardW - 28} />
                : mode === 'overlay' ? <Figure data={s.pdf!.data} plot={p} width={figW}>{(sc) => <Overlay plot={p} s={sc} sets={sets} />}</Figure>
                  : <SideBySide plot={p} sets={sets} width={cardW - 28} />}
              <p className="cmp-find">{p.kind === 'points'
                ? `The paper's single-snapshot MUSIC lands ${p.id === 'a6' ? '57° off in elevation' : '50° off in azimuth'}. On the same 4×4 array, at the same 20 dB SNR and a single snapshot, our MUSIC gets within a degree or two; 64 snapshots tighten it further. The paper's error is more likely a sign or axis mix-up than a limit of the array.`
                : finding(p, computed[p.id] ?? ({} as Record<Who, undefined>))}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
