import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Mark { page: number; at: number; box: [number, number, number, number]; label: string; warn?: boolean }

/** Regions in arXiv 2211.13096 (PDF points, origin top-left), found with pdftotext -bbox. */
const PATCH_MARKS: Mark[] = [
  { page: 2, at: 0.5, box: [60, 360, 264, 560], label: 'Table 1  dimensions' },
  { page: 2, at: 1.5, box: [64, 424, 262, 498], label: 'patch wider than substrate', warn: true },
  { page: 2, at: 2.1, box: [62, 542, 262, 558], label: 'this is εeff, not εr', warn: true },
  { page: 2, at: 2.6, box: [64, 522, 262, 538], label: '1.0 mm line ≈ 85 Ω', warn: true },
  { page: 2, at: 3.1, box: [318, 205, 526, 300], label: 'eq. (6), (7)  ground size' },
  { page: 2, at: 3.6, box: [126, 305, 154, 321], label: 'text says 1.6 mm', warn: true },
  { page: 3, at: 4.3, box: [38, 34, 300, 168], label: 'Fig. 3  inset feed layout' },
  { page: 3, at: 5.0, box: [310, 112, 562, 224], label: 'Fig. 5  −23.9 dB at 2.40 GHz' },
]

/** Regions in arXiv 2508.20905 (Saad et al., 4×4 phased array), PDF points, origin top-left, from pdftotext -bbox. */
const ARRAY_MARKS: Mark[] = [
  { page: 2, at: 0.4, box: [310, 49, 565, 196], label: 'Table I  unit cell' },
  { page: 2, at: 1.0, box: [48, 404, 298, 600], label: 'Fig. 2  4×4, 50 mm pitch' },
  { page: 2, at: 1.6, box: [46, 49, 300, 69], label: 'simulated with a coax feed', warn: true },
  { page: 2, at: 2.1, box: [338, 131, 565, 141], label: '18.2 mm → ≈2.56 GHz on εr 10.2', warn: true },
  { page: 2, at: 2.6, box: [48, 176, 298, 352], label: 'Fig. 1  unit cell, T-slot' },
  { page: 2, at: 3.1, box: [310, 426, 565, 466], label: '20 MHz, not 83.5 MHz', warn: true },
  { page: 2, at: 3.6, box: [338, 185, 565, 195], label: '0.4λ: strong coupling', warn: true },
  { page: 3, at: 4.3, box: [46, 36, 566, 424], label: 'Fig. 5  steering 11–42°' },
  { page: 3, at: 5.0, box: [310, 680, 566, 694], label: '±42°, 13.5 dBi' },
]
/** The phased-array demo is still being built; while false, that paper reads as an unknown paper. */
export const ARRAY_DEMO = true
const MARKS_BY = { patch: PATCH_MARKS, array: ARRAY_MARKS }
export type KnownPaper = keyof typeof MARKS_BY

function Page({ doc, n, scale, t, marksAll, reading, near }: { doc: PDFDocumentProxy; n: number; scale: number; t: number | null; marksAll: Mark[]; reading: boolean; near: boolean }) {
  const known = marksAll.length > 0
  const MARKS = marksAll
  const ref = useRef<HTMLCanvasElement>(null)
  // Render once a page comes near the view, then keep it, so flipping back is instant.
  const [seen, setSeen] = useState(near)
  useEffect(() => { if (near) setSeen(true) }, [near])
  useEffect(() => {
    if (!seen) return
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    doc.getPage(n).then((p) => {
      const c = ref.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
      const vp = p.getViewport({ scale: scale * dpr })
      c.width = vp.width; c.height = vp.height
      c.style.width = `${vp.width / dpr}px`; c.style.height = `${vp.height / dpr}px`
      task = p.render({ canvasContext: c.getContext('2d')!, viewport: vp })
      task.promise.catch(() => {})
    })
    return () => task?.cancel()
  }, [doc, n, scale, seen])
  const marks = known ? MARKS.filter((m) => m.page === n && (t === null || t >= m.at)) : []
  const own = MARKS.filter((m) => m.page === n)
  const first = known && own.length ? Math.min(...own.map((m) => m.at)) : 0
  const last = known && own.length ? Math.max(...own.map((m) => m.at)) + 0.8 : -1
  const scan = reading && t !== null && t >= first - 0.4 && t <= last ? (t - first + 0.4) / (last - first + 0.4) : null
  return (
    <div className="pdf-page" style={{ width: 612 * scale, height: 792 * scale }}>
      <canvas ref={ref} />
      {scan !== null && <div className="scan" style={{ top: `${scan * 100}%` }} />}
      {marks.map((m) => (
        <div key={m.label} className={`hl${m.warn ? ' warn' : ''}${m.warn && m.box[2] > 400 ? ' above' : ''}`} style={{ left: m.box[0] * scale, top: m.box[1] * scale, width: (m.box[2] - m.box[0]) * scale, height: (m.box[3] - m.box[1]) * scale }}>
          <span>{m.label}</span>
        </div>
      ))}
      <div className="pno">p. {n}</div>
    </div>
  )
}

/** Book-style spreads: page 1 on its own, then 2–3, 4–5, … (keeps the marked-up pages 2 and 3 together). */
function spreadsOf(n: number): number[][] {
  const out: number[][] = [[1]]
  for (let p = 2; p <= n; p += 2) out.push(p + 1 <= n ? [p, p + 1] : [p])
  return out
}

/** The uploaded paper as two-page spreads with what the solver pulled out of it marked up. Scroll, click or use the arrow keys to page through. */
export function PaperView({ data, name, t, reading, onInfo }: { data: ArrayBuffer; name: string; t: number | null; reading: boolean; onInfo?: (pages: number, known: boolean, paper: KnownPaper | null) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [paper, setPaper] = useState<KnownPaper | null>(null)
  const known = paper !== null
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1000, h: 700 })
  const [cur, setCur] = useState(0)
  useEffect(() => {
    let alive = true
    pdfjs.getDocument({ data: data.slice(0) }).promise.then(async (d) => {
      if (!alive) return
      // recognise the two demo papers by their text
      const text = async (n: number) => (await (await d.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' ')
      let k: KnownPaper | null = null
      if (d.numPages >= 3 && (await text(2)).includes('Antenna design dimension')) k = 'patch'
      else if (ARRAY_DEMO && (await text(1)).includes('Real-Time Tracking Antenna')) k = 'array'
      if (!alive) return
      setPaper(k); setDoc(d); onInfo?.(d.numPages, k === 'patch', k)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver((e) => setSize({ w: e[0].contentRect.width, h: e[0].contentRect.height }))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])
  const spreads = doc ? spreadsOf(doc.numPages) : []
  const scale = Math.max(0.3, Math.min((size.w - 24) / 2 / 612, (size.h - 36) / 792))
  const go = (i: number, smooth = true) => {
    const el = box.current
    if (!el || !spreads.length) return
    const j = Math.max(0, Math.min(spreads.length - 1, i))
    el.scrollTo({ top: j * el.clientHeight, behavior: smooth ? 'smooth' : 'auto' })
    setCur(j)
  }
  // Open on the spread the solver reads from (pages 2–3), and go back there when reading starts.
  useEffect(() => { if (doc && known) go(1, false) }, [doc, known, size.h]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (reading && known) go(1) }, [reading, known]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT') return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(cur + 1) }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur - 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const onScroll = () => {
    const el = box.current
    if (el && el.clientHeight) setCur(Math.round(el.scrollTop / el.clientHeight))
  }
  const sp = spreads[cur]
  return (
    <div className="paper">
      <div className="paper-name">
        {name}{doc && <span>{doc.numPages} pages</span>}
        {spreads.length > 1 && (
          <div className="paper-nav">
            <button onClick={() => go(cur - 1)} disabled={cur === 0} aria-label="Previous pages">‹</button>
            <span>p. {sp && (sp.length > 1 ? `${sp[0]}–${sp[1]}` : sp[0])} / {doc!.numPages}</span>
            <button onClick={() => go(cur + 1)} disabled={cur === spreads.length - 1} aria-label="Next pages">›</button>
          </div>
        )}
      </div>
      <div className="pages" ref={box} onScroll={onScroll}>
        {doc && spreads.map((ps, i) => (
          <div className="spread" key={i}>
            {ps.map((n) => <Page key={n} doc={doc} n={n} scale={scale} t={t} marksAll={paper ? MARKS_BY[paper] : []} reading={reading} near={Math.abs(i - cur) <= 1} />)}
          </div>
        ))}
      </div>
    </div>
  )
}
