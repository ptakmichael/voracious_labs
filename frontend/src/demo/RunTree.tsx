import { useEffect, useMemo, useRef, useState } from 'react'
import { LineChart } from '../components/charts/LineChart'
import { type Design, type Metrics, FREQS, F_RANGE, GOAL, VARS, curve, edgeR, goalMet, metrics, resonance } from './model'
import { type Run, useDemo } from './store'

const SHORT: Record<keyof Design, string> = { L: 'length', W: 'width', y0: 'inset', h: 'height', er: 'εr', gs: 'ground' }
const r2 = (v: number) => Math.round(v * 100) / 100

interface TNode { id: string; col: number; lane: 0 | 1 | 2; d: Design; m: Metrics; title: string; kind: 'run' | 'probe' | 'alt'; n?: number; only?: 'L' | 'y0' }
interface TEdge { from: string; to: string; label: string[]; dashed?: boolean }

/** What changed between two designs, as short "length −0.42" strings. */
function diff(a: Design, b: Design) {
  return VARS.filter((v) => Math.abs((b[v.key] as number) - (a[v.key] as number)) > 0.005).map((v) => {
    const dv = (b[v.key] as number) - (a[v.key] as number)
    return v.key === 'h' || v.key === 'er' || v.key === 'gs' ? `${SHORT[v.key]} ${v.fmt(a[v.key] as number)}→${v.fmt(b[v.key] as number)}` : `${SHORT[v.key]} ${dv > 0 ? '+' : '−'}${Math.abs(dv).toFixed(2)}`
  })
}

/** Largest in-band difference between two S11 curves, dB. */
function inBandGap(a: Design, b: Design) {
  const ca = curve(a), cb = curve(b)
  let g = 0
  FREQS.forEach((f, i) => { if (f >= GOAL.f1 && f <= GOAL.f2) g = Math.max(g, Math.abs(ca[i] - cb[i])) })
  return g
}

/** Same resonance and same input resistance as `g`, but with patch width `W`: length and inset re-solved for it. */
function twinOf(g: Design, W: number): Design {
  const f0 = resonance(g), R = edgeR(g) * Math.cos((Math.PI * g.y0) / g.L) ** 2
  let a = 15, b = 60
  for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (resonance({ ...g, W, L: m }) > f0) a = m; else b = m }
  const L = (a + b) / 2
  const y0 = (Math.acos(Math.min(1, Math.sqrt(R / edgeR({ ...g, W, L })))) * L) / Math.PI
  return { ...g, W, L: r2(L), y0: r2(y0) }
}

/**
 * The runs as a tree. The trunk is what actually ran. Under each tuning step hangs the move the tuner rejected
 * (length on its own), and from the first run a second path that lands on a different design with the same response.
 */
function buildTree(runs: Run[]) {
  const nodes: TNode[] = runs.map((r, i) => ({ id: `r${r.n}`, col: i, lane: 0, d: r.d, m: r.m, title: `Run ${r.n} · ${r.label}`, kind: 'run', n: r.n }))
  const edges: TEdge[] = runs.slice(1).map((r, i) => ({ from: `r${runs[i].n}`, to: `r${r.n}`, label: diff(runs[i].d, r.d) }))
  runs.forEach((r, i) => {
    if (!i || !r.label.startsWith('Tune')) return
    const p = runs[i - 1]
    if (Math.abs(r.d.y0 - p.d.y0) < 0.01 || Math.abs(r.d.L - p.d.L) < 0.01) return
    // the single-dimension version of this step; only worth showing when it is clearly worse than moving both
    const tries = (['L', 'y0'] as const).map((k) => { const d = { ...p.d, [k]: r.d[k] }; return { k, d, m: metrics(d) } })
    const worst = tries.sort((a, b) => b.m.worst - a.m.worst)[0]
    if (worst.m.worst - r.m.worst < 0.8) return
    nodes.push({ id: `p${r.n}`, col: i - 0.5, lane: 1, d: worst.d, m: worst.m, title: `Rejected · ${worst.k === 'L' ? 'length' : 'inset'} alone after run ${p.n}`, kind: 'probe', only: worst.k })
    edges.push({ from: `r${p.n}`, to: `p${r.n}`, label: [], dashed: true })
  })
  let equiv: { a: string; b: string; gap: number } | null = null
  let gi = -1
  runs.forEach((r, i) => { if (r.label.startsWith('Tune') && goalMet(r.m)) gi = i })
  if (gi > 0) {
    const g = runs[gi], base = runs[0]
    const W = r2(Math.max(VARS[1].min, g.d.W * 0.84))
    const a1 = { ...base.d, W }
    const a2 = twinOf(g.d, W)
    const am = metrics(a2)
    if (goalMet(am)) {
      const c1 = Math.max(1, Math.round(gi / 2))
      nodes.push({ id: 'a1', col: c1, lane: 2, d: a1, m: metrics(a1), title: 'Other path · narrower patch', kind: 'alt' })
      nodes.push({ id: 'a2', col: gi, lane: 2, d: a2, m: am, title: 'Other path · re-tuned', kind: 'alt' })
      edges.push({ from: `r${base.n}`, to: 'a1', label: diff(base.d, a1), dashed: true })
      edges.push({ from: 'a1', to: 'a2', label: diff(a1, a2), dashed: true })
      equiv = { a: `r${g.n}`, b: 'a2', gap: inBandGap(g.d, a2) }
    }
  }
  return { nodes, edges, equiv }
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(560)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export function RunTree() {
  const s = useDemo()
  const { nodes, edges, equiv } = useMemo(() => buildTree(s.runs), [s.runs])
  const [sel, setSel] = useState<string | null>(null)
  const [wrap, W] = useWidth<HTMLDivElement>()
  const cols = Math.max(1, s.runs.length - 1)
  const pad = 52
  const step = Math.min(120, (W - pad * 2) / cols)
  const LANE = [62, 124, 186]
  const H = equiv ? 236 : 160
  const pos = (n: TNode) => ({ x: pad + n.col * step, y: LANE[n.lane] })
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const cur = sel && byId[sel] ? byId[sel] : nodes.find((n) => n.id === `r${s.runs[s.runs.length - 1]?.n}`)
  const parent = cur && edges.find((e) => e.to === cur.id)
  const pd = parent ? byId[parent.from] : undefined
  const twin = (equiv && cur && (cur.id === equiv.a ? byId[equiv.b] : cur.id === equiv.b ? byId[equiv.a] : undefined)) || undefined
  const cmp = twin ?? pd
  const loaded = cur && VARS.every((v) => Math.abs((cur.d[v.key] as number) - (s.design[v.key] as number)) < 1e-6)
  const probes = nodes.filter((n) => n.kind === 'probe')
  const g = equiv && byId[equiv.a], a2 = equiv && byId[equiv.b]
  return (
    <div className="card">
      <div className="card-h"><h3>How it got here</h3><span className="aside">every run, what changed · click a node</span></div>
      <div className="card-b tree" ref={wrap}>
        <svg width={W} height={H} style={{ display: 'block' }}>
          <text x={4} y={LANE[0] + 4} className="lane">ran</text>
          {probes.length > 0 && <text x={4} y={LANE[1] + 4} className="lane">tried</text>}
          {equiv && <text x={4} y={LANE[2] + 4} className="lane">alt</text>}
          {edges.map((e) => {
            const a = pos(byId[e.from]), b = pos(byId[e.to])
            const path = a.y === b.y ? `M${a.x},${a.y}L${b.x},${b.y}` : `M${a.x},${a.y}C${a.x},${(a.y + b.y) / 2} ${a.x + 8},${b.y} ${Math.max(a.x + 14, b.x - 20)},${b.y}L${b.x},${b.y}`
            const mx = (a.x + b.x) / 2
            return (
              <g key={e.from + e.to} className="fadein">
                <path d={path} fill="none" stroke={e.dashed ? 'var(--faint)' : 'var(--ink)'} strokeWidth={e.dashed ? 1.2 : 1.6} strokeDasharray={e.dashed ? '4 3' : undefined} />
                {a.y === b.y && e.label.slice(0, 3).map((l, i, all) => (
                  <text key={l} x={mx} y={(a.y === LANE[0] ? a.y - 16 : a.y + 22) - (a.y === LANE[0] ? (all.length - 1 - i) * 11 : -i * 11)} className="elab" textAnchor="middle">{l}</text>
                ))}
              </g>
            )
          })}
          {g && a2 && (
            <g className="fadein">
              <line x1={pos(g).x} y1={pos(g).y + 12} x2={pos(a2).x} y2={pos(a2).y - 12} stroke="var(--ok)" strokeWidth={1.6} strokeDasharray="2 3" />
              <text x={pos(g).x - 16} y={LANE[2] - 20} className="eq" textAnchor="end">same response</text>
              <text x={pos(g).x - 16} y={LANE[2] - 8} className="elab" textAnchor="end">within {equiv!.gap.toFixed(1)} dB in band</text>
            </g>
          )}
          {nodes.map((n) => {
            const p = pos(n), ok = goalMet(n.m), on = cur?.id === n.id
            return (
              <g key={n.id} transform={`translate(${p.x} ${p.y})`} className="tnode fadein" onClick={() => setSel(n.id)}>
                {on && <circle r={n.kind === 'probe' ? 11 : 15} fill="none" stroke="var(--sig)" strokeWidth={2} />}
                {n.kind === 'probe' ? (
                  <g><circle r={7} fill="var(--sheet)" stroke="var(--faint)" strokeWidth={1.2} /><path d="M-3,-3L3,3M3,-3L-3,3" stroke="var(--sig)" strokeWidth={1.5} /></g>
                ) : (
                  <circle r={11} fill={ok ? 'var(--ok)' : 'var(--sheet)'} stroke={n.kind === 'alt' ? 'var(--ok)' : 'var(--ink)'} strokeWidth={1.5} strokeDasharray={n.kind === 'alt' && !ok ? '3 2' : undefined} />
                )}
                {n.kind !== 'probe' && <text y={4} textAnchor="middle" className="nlab" fill={ok ? '#fff' : 'var(--ink)'}>{n.kind === 'alt' ? (n.id === 'a1' ? 'A1' : 'A2') : n.n}</text>}
                <text y={n.kind === 'probe' ? 20 : 26} textAnchor="middle" className="nval" fill={ok ? 'var(--ok)' : 'var(--sig)'}>{n.m.worst.toFixed(1)}</text>
              </g>
            )
          })}
        </svg>
        <div className="tree-key"><span><i className="k-ok" />meets goal</span><span><i className="k-no" />misses</span><span><i className="k-x">×</i>rejected step</span><span>numbers: worst in-band dB</span></div>
        {cur && (
          <div className="tree-detail fadein" key={cur.id}>
            <div className="td-text">
              <div className="td-h">{cur.title}</div>
              <div className="td-stats">
                <span>resonance <b>{cur.m.f0.toFixed(3)}</b> GHz</span><span>worst <b className={goalMet(cur.m) ? 'good' : 'bad'}>{cur.m.worst.toFixed(1)}</b> dB</span><span>bandwidth <b>{cur.m.bw.toFixed(0)}</b> MHz</span>
              </div>
              <p>{explain(cur, pd, twin)}</p>
              {cmp && <div className="td-diff">{twin ? 'vs its twin' : 'vs previous'}: {diff(cmp.d, cur.d).join(' · ') || 'no change'}</div>}
              {!loaded && <button className="btn" onClick={() => s.setDesign(cur.d)}>Load this design</button>}
              {loaded && <div className="mono small mute">this is the design on screen</div>}
            </div>
            <div className="td-chart">
              <LineChart height={130} xDomain={F_RANGE} yDomain={[-35, 1]} yTicks={[0, -10, -20, -30]} xTicks={[2.2, 2.4, 2.6, 2.8]} xFmt={(v) => v.toFixed(1)}
                vbands={[{ x1: GOAL.f1, x2: GOAL.f2, color: 'var(--ok)', opacity: 0.13 }]} hlines={[{ y: GOAL.db, color: 'var(--sig)', dash: '5 4' }]}
                series={[
                  ...(cmp ? [{ x: FREQS, y: curve(cmp.d), color: twin ? 'var(--ok)' : '#bdb6a6', width: twin ? 2 : 1.4, dash: twin ? '5 3' : undefined }] : []),
                  { x: FREQS, y: curve(cur.d), color: cur.kind === 'probe' ? 'var(--faint)' : 'var(--sig)', width: 2.2 },
                ]} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function explain(n: TNode, p: TNode | undefined, twin: TNode | undefined) {
  if (n.kind === 'probe') return n.only === 'L'
    ? `Moving the length on its own shifts the resonance but loses the match (${n.m.worst.toFixed(1)} dB): the inset's resistance depends on its depth relative to the length. So the tuner moved both.`
    : `Moving the inset on its own improves the match, but the resonance stays at ${n.m.f0.toFixed(2)} GHz and the band is still missed (${n.m.worst.toFixed(1)} dB). Length sets the frequency, so it had to move too.`
  if (twin) {
    const narrow = n.d.W < twin.d.W ? n : twin, wide = narrow === n ? twin : n
    return `Two different designs, same S11 in band. The ${narrow.d.W.toFixed(1)} mm patch needs a ${narrow.d.y0 > wide.d.y0 ? 'deeper' : 'shallower'} inset (${narrow.d.y0.toFixed(2)} vs ${wide.d.y0.toFixed(2)} mm) to reach 50 Ω, because a narrower patch has a higher edge resistance. Pick on size or gain (${narrow.m.gain.toFixed(1)} vs ${wide.m.gain.toFixed(1)} dBi), not on match.`
  }
  if (n.kind === 'alt') return 'A narrower patch, then length and inset re-tuned for it. Explored alongside the main path.'
  if (!p) return 'Where it started. Everything after this is measured against it.'
  const df = (n.m.f0 - p.m.f0) * 1000, dw = n.m.worst - p.m.worst
  return `Resonance ${df >= 0 ? 'up' : 'down'} ${Math.abs(df).toFixed(0)} MHz and worst in-band match ${dw <= 0 ? 'better' : 'worse'} by ${Math.abs(dw).toFixed(1)} dB compared with run ${p.n ?? ''}.`
}
