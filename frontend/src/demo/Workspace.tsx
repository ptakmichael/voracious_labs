import { type ReactNode, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

/**
 * A small window manager in the spirit of HFSS: windows move by their title bar, resize from any edge, hold one or
 * more panes as tabs, merge when one window's title is dropped on another's tab strip, and split when a tab is
 * dragged out. Positions are fractions of the workspace so the layout survives the browser being resized.
 */

export interface Win { id: string; panes: string[]; active: string; x: number; y: number; w: number; h: number; z: number; max?: boolean }
type Drag =
  | { kind: 'move'; id: string; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'resize'; id: string; edge: string; sx: number; sy: number; o: Win }
  | { kind: 'tab'; id: string; pane: string; sx: number; sy: number }

interface WS {
  wins: Win[]
  top: number
  set: (wins: Win[]) => void
  focus: (id: string) => void
  update: (id: string, p: Partial<Win>) => void
}

let nid = 1
const newId = () => `w${nid++}`

export const useWS = create<WS>((set, get) => ({
  wins: [],
  top: 1,
  set: (wins) => set({ wins, top: Math.max(1, ...wins.map((w) => w.z)) }),
  focus: (id) => { const top = get().top + 1; set({ top, wins: get().wins.map((w) => (w.id === id ? { ...w, z: top } : w)) }) },
  update: (id, p) => set({ wins: get().wins.map((w) => (w.id === id ? { ...w, ...p } : w)) }),
}))

export function layoutFrom(groups: { panes: string[]; x: number; y: number; w: number; h: number }[]): Win[] {
  return groups.map((g, i) => ({ id: newId(), panes: g.panes, active: g.panes[0], x: g.x, y: g.y, w: g.w, h: g.h, z: i + 1 }))
}

/** Every open window in a grid, biggest panes first. */
function tile(wins: Win[]): Win[] {
  const n = wins.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols)
  return wins.map((w, i) => {
    const r = Math.floor(i / cols), c = i % cols, inRow = r === rows - 1 ? n - r * cols : cols
    return { ...w, max: false, x: c / inRow, y: r / rows, w: 1 / inRow, h: 1 / rows }
  })
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const MIN_W = 0.16, MIN_H = 0.16
const SNAP_PX = 22 // magnet distance to edges, in pixels
const ZONE_PX = 26 // pointer this close to the workspace edge = snap to a half or quarter

/** Edges (as fractions) a window can snap to along one axis: the workspace sides and every other window's sides. */
function targets(wins: Win[], id: string, axis: 'x' | 'y') {
  const t = [0, 1]
  for (const o of wins) if (o.id !== id && !o.max) { const a = axis === 'x' ? o.x : o.y, l = axis === 'x' ? o.w : o.h; t.push(a, a + l) }
  return t
}
/** Snap a span [pos, pos + len] so either end lands on a nearby target; returns the new start and the line it hit. */
function snapSpan(pos: number, len: number, ts: number[], tol: number) {
  let best: { d: number; pos: number; line: number } | null = null
  for (const t of ts) for (const [edge, off] of [[pos, 0], [pos + len, len]] as const) {
    const dd = Math.abs(edge - t)
    if (dd < tol && (!best || dd < best.d)) best = { d: dd, pos: t - off, line: t }
  }
  return best ? { pos: best.pos, line: best.line } : { pos, line: null as number | null }
}
/** Snap a single moving edge. */
function snapEdge(v: number, ts: number[], tol: number) {
  let best: number | null = null
  for (const t of ts) if (Math.abs(v - t) < tol && (best === null || Math.abs(v - t) < Math.abs(v - best))) best = t
  return best === null ? { v, line: null as number | null } : { v: best, line: best }
}

export function Workspace({ panes, initial }: { panes: Record<string, { title: string; render: () => ReactNode }>; initial: () => Win[] }) {
  const { wins, set, focus, update } = useWS()
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1000, h: 700 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] })
  const [zone, setZone] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  useEffect(() => { if (!useWS.getState().wins.length) set(initial()) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!box.current) return
    const ro = new ResizeObserver((e) => setSize({ w: e[0].contentRect.width, h: e[0].contentRect.height }))
    ro.observe(box.current)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const ws = useWS.getState().wins
      const dx = (e.clientX - drag.sx) / size.w, dy = (e.clientY - drag.sy) / size.h
      if (drag.kind === 'move') {
        const w = ws.find((x) => x.id === drag.id)
        if (!w) return
        // stay fully inside the workspace, and snap to its sides and to other windows' sides
        const tx = SNAP_PX / size.w, ty = SNAP_PX / size.h
        const sx = snapSpan(clamp(drag.ox + dx, 0, 1 - w.w), w.w, targets(ws, w.id, 'x'), tx)
        const sy = snapSpan(clamp(drag.oy + dy, 0, 1 - w.h), w.h, targets(ws, w.id, 'y'), ty)
        update(drag.id, { x: clamp(sx.pos, 0, 1 - w.w), y: clamp(sy.pos, 0, 1 - w.h), max: false })
        setGuides({ v: sx.line === null ? [] : [sx.line], h: sy.line === null ? [] : [sy.line] })
        // pointer pushed into an edge or corner: offer a half, a quarter, or the whole workspace
        const r = box.current!.getBoundingClientRect()
        const px = e.clientX - r.left, py = e.clientY - r.top
        const L = px < ZONE_PX, R = px > r.width - ZONE_PX, T = py < ZONE_PX, B = py > r.height - ZONE_PX
        setZone(L && T ? { x: 0, y: 0, w: 0.5, h: 0.5 } : R && T ? { x: 0.5, y: 0, w: 0.5, h: 0.5 }
          : L && B ? { x: 0, y: 0.5, w: 0.5, h: 0.5 } : R && B ? { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
            : L ? { x: 0, y: 0, w: 0.5, h: 1 } : R ? { x: 0.5, y: 0, w: 0.5, h: 1 }
              : T ? { x: 0, y: 0, w: 1, h: 1 } : B ? { x: 0, y: 0.5, w: 1, h: 0.5 } : null)
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-strip]') as HTMLElement | null
        const t = el?.dataset.strip
        setTarget(t && t !== drag.id ? t : null)
      } else if (drag.kind === 'resize') {
        const o = drag.o, p: Partial<Win> = {}
        const tx = SNAP_PX / size.w, ty = SNAP_PX / size.h, TX = targets(ws, o.id, 'x'), TY = targets(ws, o.id, 'y')
        const v: number[] = [], h: number[] = []
        if (drag.edge.includes('e')) { const e2 = snapEdge(clamp(o.x + o.w + dx, o.x + MIN_W, 1), TX, tx); p.w = e2.v - o.x; if (e2.line !== null) v.push(e2.line) }
        if (drag.edge.includes('s')) { const e2 = snapEdge(clamp(o.y + o.h + dy, o.y + MIN_H, 1), TY, ty); p.h = e2.v - o.y; if (e2.line !== null) h.push(e2.line) }
        if (drag.edge.includes('w')) { const e2 = snapEdge(clamp(o.x + dx, 0, o.x + o.w - MIN_W), TX, tx); p.x = e2.v; p.w = o.w + (o.x - e2.v); if (e2.line !== null) v.push(e2.line) }
        if (drag.edge.includes('n')) { const e2 = snapEdge(clamp(o.y + dy, 0, o.y + o.h - MIN_H), TY, ty); p.y = e2.v; p.h = o.h + (o.y - e2.v); if (e2.line !== null) h.push(e2.line) }
        update(drag.id, p)
        setGuides({ v, h })
      } else if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 12) {
        // a tab pulled out of its window becomes a window of its own, still under the pointer
        const src = ws.find((x) => x.id === drag.id)
        if (!src) return
        const r = box.current!.getBoundingClientRect()
        if (src.panes.length === 1) { setDrag({ kind: 'move', id: src.id, sx: drag.sx, sy: drag.sy, ox: src.x, oy: src.y }); return }
        const id = newId(), top = useWS.getState().top + 1
        const w = Math.max(0.3, src.w * 0.9), h = Math.max(0.3, src.h * 0.9)
        const nw: Win = { id, panes: [drag.pane], active: drag.pane, x: clamp((e.clientX - r.left) / size.w - 0.05, 0, 1 - w), y: clamp((e.clientY - r.top) / size.h - 0.012, 0, 1 - h), w, h, z: top }
        const rest = src.panes.filter((p) => p !== drag.pane)
        set([...ws.map((x) => (x.id === src.id ? { ...x, panes: rest, active: x.active === drag.pane ? rest[0] : x.active } : x)), nw])
        setDrag({ kind: 'move', id, sx: e.clientX, sy: e.clientY, ox: nw.x, oy: nw.y })
      }
    }
    const up = () => {
      if (drag.kind === 'move' && zone && !target) update(drag.id, { ...zone, max: false })
      else if (drag.kind === 'move' && target) {
        const ws = useWS.getState().wins
        const src = ws.find((x) => x.id === drag.id)!, dst = ws.find((x) => x.id === target)!
        set(ws.filter((x) => x.id !== src.id).map((x) => (x.id === dst.id ? { ...x, panes: [...x.panes, ...src.panes], active: src.active } : x)))
        focus(dst.id)
      }
      setDrag(null); setTarget(null); setGuides({ v: [], h: [] }); setZone(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [drag, target, zone, size, set, update, focus])

  const closeTab = (w: Win, p: string) => {
    const rest = w.panes.filter((x) => x !== p)
    set(rest.length ? wins.map((x) => (x.id === w.id ? { ...x, panes: rest, active: x.active === p ? rest[0] : x.active } : x)) : wins.filter((x) => x.id !== w.id))
  }
  const open = new Set(wins.flatMap((w) => w.panes))
  const reopen = (p: string) => {
    const top = useWS.getState().top + 1
    set([...wins, { id: newId(), panes: [p], active: p, x: 0.28, y: 0.2, w: 0.44, h: 0.55, z: top }])
    setMenu(false)
  }
  return (
    <div className="ws">
      <div className="ws-bar">
        <span className="ws-tip">drag a title to an edge or corner to snap it there · onto another window's tabs to combine · a tab out to split · edges to resize</span>
        <div className="ws-btns">
          <div className="ws-menu">
            <button className="chip" onClick={() => setMenu(!menu)}>Windows ▾</button>
            {menu && (
              <div className="ws-list">
                {Object.entries(panes).map(([k, p]) => (
                  <button key={k} disabled={open.has(k)} onClick={() => reopen(k)}>{open.has(k) ? '✓ ' : '+ '}{p.title}</button>
                ))}
              </div>
            )}
          </div>
          <button className="chip" onClick={() => set(tile(wins))}>Tile</button>
          <button className="chip" onClick={() => set(initial())}>Reset layout</button>
        </div>
      </div>
      <div className={`ws-area${drag ? ' busy' : ''}`} ref={box}>
        {wins.map((w) => {
          const st = w.max ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: 900 } : { left: `${w.x * 100}%`, top: `${w.y * 100}%`, width: `${w.w * 100}%`, height: `${w.h * 100}%`, zIndex: w.z }
          return (
            <section key={w.id} className={`win${drag && drag.id === w.id && drag.kind === 'move' ? ' dragging' : ''}${target === w.id ? ' target' : ''}`} style={st} onPointerDown={() => focus(w.id)}>
              <header className="win-h" data-strip={w.id}
                onPointerDown={(e) => { if ((e.target as HTMLElement).closest('button')) return; e.preventDefault(); setDrag({ kind: 'move', id: w.id, sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y }) }}
                onDoubleClick={() => update(w.id, { max: !w.max })}>
                <div className="win-tabs">
                  {w.panes.map((p) => (
                    <button key={p} className={`win-tab${p === w.active ? ' on' : ''}`}
                      onPointerDown={(e) => { e.stopPropagation(); focus(w.id); update(w.id, { active: p }); setDrag({ kind: 'tab', id: w.id, pane: p, sx: e.clientX, sy: e.clientY }) }}>
                      {panes[p]?.title ?? p}
                      <span className="win-x" onPointerDown={(e) => e.stopPropagation()} onClick={() => closeTab(w, p)} aria-label={`Close ${panes[p]?.title}`}>×</span>
                    </button>
                  ))}
                </div>
                <button className="win-max" onClick={() => update(w.id, { max: !w.max })} aria-label={w.max ? 'Restore' : 'Maximise'}>{w.max ? '❐' : '□'}</button>
              </header>
              <div className="win-b">{panes[w.active]?.render()}</div>
              {target === w.id && <div className="win-drop">drop to combine</div>}
              {!w.max && ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => (
                <div key={edge} className={`rz rz-${edge}`} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); focus(w.id); setDrag({ kind: 'resize', id: w.id, edge, sx: e.clientX, sy: e.clientY, o: w }) }} />
              ))}
            </section>
          )
        })}
        {drag && zone && !target && <div className="snap-zone" style={{ left: `${zone.x * 100}%`, top: `${zone.y * 100}%`, width: `${zone.w * 100}%`, height: `${zone.h * 100}%` }} />}
        {drag && guides.v.map((g) => <div key={`v${g}`} className="snap-v" style={{ left: `${g * 100}%` }} />)}
        {drag && guides.h.map((g) => <div key={`h${g}`} className="snap-h" style={{ top: `${g * 100}%` }} />)}
        {!wins.length && <div className="overlay-note">All windows closed. Use Windows ▾ or Reset layout.</div>}
      </div>
    </div>
  )
}

/** Width and height of an element, live. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [s, setS] = useState({ w: 400, h: 300 })
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((e) => setS({ w: e[0].contentRect.width, h: e[0].contentRect.height }))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, s] as const
}
