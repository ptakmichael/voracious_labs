import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Mark { page: number; at: number; box: [number, number, number, number]; label: string; warn?: boolean }

/** Regions in arXiv 2211.13096 (PDF points, origin top-left), found with pdftotext -bbox. */
const MARKS: Mark[] = [
  { page: 2, at: 0.5, box: [60, 360, 264, 560], label: 'Table 1  dimensions' },
  { page: 2, at: 1.5, box: [64, 424, 262, 498], label: 'patch wider than substrate', warn: true },
  { page: 2, at: 2.1, box: [62, 542, 262, 558], label: 'this is εeff, not εr', warn: true },
  { page: 2, at: 2.6, box: [64, 522, 262, 538], label: '1.0 mm line ≈ 85 Ω', warn: true },
  { page: 2, at: 3.1, box: [318, 205, 526, 300], label: 'eq. (6), (7)  ground size' },
  { page: 2, at: 3.6, box: [126, 305, 154, 321], label: 'text says 1.6 mm', warn: true },
  { page: 3, at: 4.3, box: [38, 34, 300, 168], label: 'Fig. 3  inset feed layout' },
  { page: 3, at: 5.0, box: [310, 112, 562, 224], label: 'Fig. 5  −23.9 dB at 2.40 GHz' },
]

function Page({ doc, n, scale, t, known, reading, near }: { doc: PDFDocumentProxy; n: number; scale: number; t: number | null; known: boolean; reading: boolean; near: boolean }) {
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
        <div key={m.label} className={`hl${m.warn ? ' warn' : ''}`} style={{ left: m.box[0] * scale, top: m.box[1] * scale, width: (m.box[2] - m.box[0]) * scale, height: (m.box[3] - m.box[1]) * scale }}>
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
export function PaperView({ data, name, t, reading, onInfo }: { data: ArrayBuffer; name: string; t: number | null; reading: boolean; onInfo?: (pages: number, known: boolean) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [known, setKnown] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1000, h: 700 })
  const [cur, setCur] = useState(0)
  useEffect(() => {
    let alive = true
    pdfjs.getDocument({ data: data.slice(0) }).promise.then(async (d) => {
      if (!alive) return
      let k = false
      if (d.numPages >= 3) {
        const tc = await (await d.getPage(2)).getTextContent()
        k = tc.items.map((i) => ('str' in i ? i.str : '')).join(' ').includes('Antenna design dimension')
      }
      setKnown(k); setDoc(d); onInfo?.(d.numPages, k)
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
            {ps.map((n) => <Page key={n} doc={doc} n={n} scale={scale} t={t} known={known} reading={reading} near={Math.abs(i - cur) <= 1} />)}
          </div>
        ))}
      </div>
    </div>
  )
}
