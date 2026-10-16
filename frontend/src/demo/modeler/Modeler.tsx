import { type ReactNode, Suspense, lazy, useEffect, useRef, useState } from 'react'
import { useDemo } from '../store'
import { AXIS, MATERIALS, type Obj, type Plane, type Tool, type V3, inPlane, isSheet, recognisePatch, useModel, validate } from './model'
import { Ico, type TNode, Tree } from './Tree'

const Viewport = lazy(() => import('./Viewport').then((m) => ({ default: m.Viewport })))

export const TOOLS: { t: Tool; key: string; name: string; icon: ReactNode }[] = [
  { t: 'select', key: 'S', name: 'Select / move', icon: <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 2l9 5-4 1-1.5 4z" fill="currentColor" /></svg> },
  { t: 'box', key: 'B', name: 'Box', icon: <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg> },
  { t: 'cyl', key: 'C', name: 'Cylinder', icon: <svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5" ry="2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg> },
  { t: 'rect', key: 'R', name: 'Rectangle (sheet)', icon: <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1.5 11l4-6h9l-4 6z" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg> },
  { t: 'circle', key: 'O', name: 'Circle (sheet)', icon: <svg width="16" height="16" viewBox="0 0 16 16"><ellipse cx="8" cy="8.5" rx="6" ry="3.5" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg> },
  { t: 'port', key: 'P', name: 'Port (50 Ω)', icon: <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg> },
]
const STEPS = [0.1, 0.25, 0.5, 1, 2]

const hintFor = (tool: Tool, phase: number) => {
  if (tool === 'select') return 'Click an object to select it; drag the arrows to move it. It snaps to the grid and to nearby faces.'
  const shape = tool === 'box' ? 'Box' : tool === 'cyl' ? 'Cylinder' : tool === 'circle' ? 'Circle' : tool === 'port' ? 'Port' : 'Rectangle'
  const round = tool === 'cyl' || tool === 'circle'
  if (phase === 0) return `${shape}: click the ${round ? 'centre' : 'first corner'}. Hover a face to draw on it. Esc to stop.`
  if (phase === 1) return `${shape}: click the ${round ? 'radius' : 'opposite corner'}.`
  return `${shape}: move to set the height, click to finish. It snaps to the grid and to other objects' heights.`
}

// ---------------------------------------------------------------- toolbar

function Toolbar({ onSolve }: { onSolve: () => void }) {
  const m = useModel()
  const [menu, setMenu] = useState(false)
  return (
    <div className="mod-bar">
      <div className="mb-g">
        {TOOLS.map((x) => (
          <button key={x.t} className={`mb-tool${m.tool === x.t ? ' on' : ''}`} title={`${x.name} (${x.key})`} onClick={() => m.setTool(x.t)}>{x.icon}<span>{x.key}</span></button>
        ))}
      </div>
      <div className="mb-g">
        <span className="mb-l">plane</span>
        <div className="seg">{(['xy', 'xz', 'yz'] as Plane[]).map((p, i) => <button key={p} className={m.plane === p ? 'on' : ''} title={`Draw in the ${p.toUpperCase()} plane (${i + 1})`} onClick={() => m.setPlane(p)}>{p.toUpperCase()}</button>)}</div>
      </div>
      <div className="mb-g">
        <span className="mb-l">material</span>
        <select value={m.material} onChange={(e) => m.set({ material: e.target.value })}>{Object.keys(MATERIALS).map((k) => <option key={k}>{k}</option>)}</select>
      </div>
      <div className="mb-g">
        <span className="mb-l">snap</span>
        <select value={m.grid} onChange={(e) => m.set({ grid: parseFloat(e.target.value) })} title="Grid step">{STEPS.map((g) => <option key={g} value={g}>{g} mm</option>)}</select>
        {(['grid', 'vertex', 'mid', 'center'] as const).map((k) => (
          <button key={k} className={`mb-snap ${k}${m.snap[k] ? ' on' : ''}`} title={`Snap to ${k === 'mid' ? 'edge midpoints' : k === 'center' ? 'face centres' : k === 'vertex' ? 'corners' : 'grid'}`} onClick={() => m.set({ snap: { ...m.snap, [k]: !m.snap[k] } })}><i />{k === 'mid' ? 'mid' : k === 'center' ? 'centre' : k}</button>
        ))}
      </div>
      <div className="mb-g">
        <button className="mb-btn" title="Undo (Ctrl+Z)" disabled={!m.past.length} onClick={m.undo}>↶</button>
        <button className="mb-btn" title="Redo (Ctrl+Y)" disabled={!m.future.length} onClick={m.redo}>↷</button>
        <button className="mb-btn" title="Duplicate (Ctrl+D)" disabled={!m.sel} onClick={() => m.sel && m.duplicate(m.sel)}>⧉</button>
        <button className="mb-btn" title="Delete (Del)" disabled={!m.sel} onClick={() => m.sel && m.remove(m.sel)}>⌫</button>
      </div>
      <div className="mb-g">
        <span className="mb-l">view</span>
        {(['fit', 'iso', 'top', 'front'] as const).map((v) => <button key={v} className="mb-btn txt" onClick={() => m.setView(v)}>{v === 'fit' ? 'Fit (F)' : v[0].toUpperCase() + v.slice(1)}</button>)}
      </div>
      <div className="mb-g mb-ins">
        <button className="mb-btn txt" onClick={() => setMenu(!menu)}>Insert ▾</button>
        {menu && (
          <div className="mb-menu" onMouseLeave={() => setMenu(false)}>
            <button onClick={() => { m.insertPatch(); setMenu(false) }}><b>Patch antenna</b><span>parametric, inset-fed, 2.44 GHz on FR-4</span></button>
            <button disabled><b>Dipole</b><span>coming with templates</span></button>
            <button disabled><b>Microstrip line</b><span>coming with templates</span></button>
          </div>
        )}
      </div>
      <div className="mb-g mb-end">
        <button className="btn" onClick={() => { const c = validate(m.objs); c.forEach((x) => m.log(x.kind, x.text)) }}>Validate</button>
        <button className="btn sig" onClick={onSolve}>Solve →</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- project tree and properties

function useDesignTree(): TNode[] {
  const m = useModel()
  const objRow = (o: Obj): TNode => ({
    id: o.id, label: o.name, selected: m.sel === o.id, muted: !o.visible,
    icon: o.port ? Ico.port : isSheet(o) ? Ico.sheet(MATERIALS[o.material]?.color ?? '#ccc') : Ico.solid(MATERIALS[o.material]?.color ?? '#ccc'),
    onClick: () => { m.select(o.id); m.setTool('select') },
    right: <button className="tr-eye" title={o.visible ? 'Hide' : 'Show'} onClick={() => m.update(o.id, { visible: !o.visible })}>{o.visible ? '◉' : '○'}</button>,
  })
  const byMat = (list: Obj[], idp: string): TNode[] => [...new Set(list.map((o) => o.material))].map((mat) => ({
    id: `${idp}-${mat}`, label: mat, icon: Ico.folder, children: list.filter((o) => o.material === mat).map(objRow),
  }))
  const solids = m.objs.filter((o) => !isSheet(o) && !o.port), sheets = m.objs.filter((o) => isSheet(o) && !o.port), ports = m.objs.filter((o) => o.port)
  const metalSheets = sheets.filter((o) => MATERIALS[o.material]?.metal)
  return [{
    id: 'proj', label: <b>{m.project}</b>, icon: Ico.project, children: [{
      id: 'des', label: <><b>{m.design}</b> <span className="tr-dim">· driven modal</span></>, icon: Ico.design, children: [
        { id: 'model', label: 'Model', icon: Ico.folder, badge: String(m.objs.length), children: [
          { id: 'solids', label: 'Solids', icon: Ico.folder, children: solids.length ? byMat(solids, 's') : [{ id: 's0', label: 'none yet', muted: true }] },
          { id: 'sheets', label: 'Sheets', icon: Ico.folder, children: sheets.length ? byMat(sheets, 'h') : [{ id: 'h0', label: 'none yet', muted: true }] },
          { id: 'cs', label: 'Coordinate systems', icon: Ico.folder, open: false, children: [{ id: 'gcs', label: 'Global', icon: Ico.axes }] },
        ] },
        { id: 'bnd', label: 'Boundaries', icon: Ico.folder, children: [
          { id: 'rad', label: <>Radiation <span className="tr-dim">· automatic</span></>, icon: Ico.boundary, right: <button className="tr-eye" title="Show the radiation box" onClick={() => m.set({ showRad: !m.showRad })}>{m.showRad ? '◉' : '○'}</button> },
          ...(metalSheets.length ? [{ id: 'pe', label: <>Finite conductivity <span className="tr-dim">· {metalSheets.length} metal sheet{metalSheets.length > 1 ? 's' : ''}</span></>, icon: Ico.boundary }] : []),
        ] },
        { id: 'exc', label: 'Excitations', icon: Ico.folder, children: ports.length ? ports.map((p) => ({ ...objRow(p), label: <>{p.name} <span className="tr-dim">· {p.port!.z0} Ω</span></> })) : [{ id: 'e0', label: 'no ports yet', muted: true }] },
        { id: 'mesh', label: <>Mesh <span className="tr-dim">· adaptive, automatic</span></>, icon: Ico.mesh },
        { id: 'ana', label: 'Analysis', icon: Ico.folder, children: [{ id: 'setup1', label: <>Setup1 <span className="tr-dim">· 2.44 GHz</span></>, icon: Ico.analysis, children: [{ id: 'sw', label: <>Sweep <span className="tr-dim">· 2.1–2.8 GHz, 281 pts</span></>, icon: Ico.analysis }] }] },
        { id: 'opt', label: 'Optimetrics', icon: Ico.folder, children: [{ id: 'o0', label: 'goal: S11 < −10 dB, 2.40–2.48 GHz', muted: true }] },
        { id: 'res', label: 'Results', icon: Ico.results, children: [{ id: 'r0', label: 'solve to see results', muted: true }] },
      ],
    }],
  }]
}

function NumField({ label, value, onCommit, disabled }: { label: string; value: number; onCommit: (v: number) => void; disabled?: boolean }) {
  const [txt, setTxt] = useState(value.toFixed(3))
  useEffect(() => { setTxt(value.toFixed(3)) }, [value])
  const commit = () => { const v = parseFloat(txt); if (Number.isFinite(v) && Math.abs(v - value) > 1e-9) onCommit(v); else setTxt(value.toFixed(3)) }
  return (
    <label className="pf"><span>{label}</span>
      <input value={txt} disabled={disabled} onChange={(e) => setTxt(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}

export function Props() {
  const m = useModel()
  const o = m.objs.find((x) => x.id === m.sel)
  if (!o) return <div className="props-empty">Select an object to edit it. New objects use the material in the toolbar.</div>
  const n = AXIS[o.plane], [u, v] = inPlane(o.plane)
  const round = o.kind === 'cyl' || o.kind === 'circle'
  const setPos = (k: number, val: number) => { const p = [...o.pos] as V3; p[k] = val; m.update(o.id, { pos: p }) }
  const setSize = (k: number, val: number) => {
    const s = [...o.size] as V3; s[k] = Math.max(0.001, val)
    if (round && (k === u || k === v)) { s[u] = s[k]; s[v] = s[k] }
    m.update(o.id, { size: s })
  }
  const kind = o.port ? 'Port' : o.kind === 'box' ? 'Box' : o.kind === 'cyl' ? 'Cylinder' : o.kind === 'circle' ? 'Circle sheet' : 'Rectangle sheet'
  return (
    <div className="props">
      <label className="pf wide"><span>Name</span><input value={o.name} onChange={(e) => m.update(o.id, { name: e.target.value }, false)} onBlur={() => m.commit()} /></label>
      <div className="pf-kind">{kind} · {o.plane.toUpperCase()} plane</div>
      {!o.port && (
        <label className="pf wide"><span>Material</span>
          <select value={o.material} onChange={(e) => m.update(o.id, { material: e.target.value })}>{Object.keys(MATERIALS).map((k) => <option key={k}>{k}</option>)}</select>
        </label>
      )}
      {o.port && <NumField label="Z0 (Ω)" value={o.port.z0} onCommit={(z0) => m.update(o.id, { port: { ...o.port!, z0 } })} />}
      <div className="pf-h">Position (min corner, mm)</div>
      <div className="pf-row">{(['X', 'Y', 'Z'] as const).map((l, k) => <NumField key={l} label={l} value={o.pos[k]} onCommit={(val) => setPos(k, val)} />)}</div>
      <div className="pf-h">{round ? 'Diameter and height (mm)' : 'Size (mm)'}</div>
      <div className="pf-row">{(['dX', 'dY', 'dZ'] as const).map((l, k) => <NumField key={l} label={l} value={o.size[k]} disabled={(isSheet(o) && k === n) || (round && k === v)} onCommit={(val) => setSize(k, val)} />)}</div>
      <div className="row-btns" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => m.duplicate(o.id)}>Duplicate</button>
        <button className="btn" onClick={() => m.remove(o.id)}>Delete</button>
      </div>
    </div>
  )
}

function Messages() {
  const msgs = useModel((s) => s.msgs)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo(0, 1e9) }, [msgs.length])
  return (
    <div className="mod-msgs" ref={ref}>
      {msgs.map((x) => <div key={x.id} className={`mm ${x.kind}`}><i>{x.kind === 'ok' ? '✓' : x.kind === 'warn' ? '!' : x.kind === 'err' ? '✕' : 'i'}</i>{x.text}</div>)}
    </div>
  )
}

function StatusBar() {
  const m = useModel()
  const phase = !m.draft ? 0 : m.draft.h !== undefined ? 2 : 1
  return (
    <div className="mod-status">
      <span className="ms-hint">{hintFor(m.tool, phase)}</span>
      <span>{m.cursor ? `X ${m.cursor[0].toFixed(2)}  Y ${m.cursor[1].toFixed(2)}  Z ${m.cursor[2].toFixed(2)} mm` : '—'}</span>
      <span>{m.hit && m.tool !== 'select' ? `snap: ${m.hit.kind === 'mid' ? 'midpoint' : m.hit.kind}` : ''}</span>
      <span>{m.plane.toUpperCase()} · grid {m.grid} mm · {m.objs.length} object{m.objs.length === 1 ? '' : 's'}</span>
    </div>
  )
}

// ---------------------------------------------------------------- page

/** Check the drawn model and, if it reads as an inset-fed patch, hand it to the solver flow. */
export function solveModel() {
  const st = useModel.getState()
  const checks = validate(st.objs)
  if (checks.some((c) => c.kind === 'err')) { checks.filter((c) => c.kind !== 'ok').forEach((c) => st.log(c.kind, c.text)); return }
  const r = recognisePatch(st.objs)
  if (!r.ok) {
    st.log('err', "The demo's solver models inset-fed patch antennas only, and this model doesn't read as one yet:")
    r.problems.forEach((p) => st.log('warn', p))
    st.log('info', 'Insert ▸ Patch antenna drops in a complete one you can edit.')
    return
  }
  r.notes.forEach((n) => st.log('ok', n))
  useDemo.getState().startFromModel(r.design, r.notes)
}

export function Modeler({ right }: { right: ReactNode }) {
  const m = useModel()
  const tree = useDesignTree()
  const solve = solveModel
  // the chat on the right talks to the modeler while the design is still being drawn
  useEffect(() => {
    useDemo.setState({
      modelerChat: (text: string) => {
        const say = useDemo.getState().say, st = useModel.getState(), lc = text.toLowerCase()
        if (/patch|antenna|insert|template|start/.test(lc)) { st.insertPatch(); say('Inserted a parametric inset-fed patch for 2.44 GHz on 1.6 mm FR-4: substrate, ground, patch, feed and a 50 Ω port. Everything is a normal object, so drag or edit any of it, then press Solve.') }
        else if (/solve|simulate|run|go/.test(lc)) { say('Checking the model and handing it to the solver.'); solve() }
        else if (/valid|check/.test(lc)) { const c = validate(st.objs); c.forEach((x) => st.log(x.kind, x.text)); say(c.some((x) => x.kind === 'err') ? `Not yet: ${c.filter((x) => x.kind === 'err').map((x) => x.text).join(' ')}` : 'It checks out. See the message log under the model.') }
        else say("While you're drawing I can insert a parametric patch (\"insert a patch\"), check the model (\"validate\"), or solve it (\"solve\"). Use the tools above for anything else: everything snaps to the grid and to other objects.")
      },
    })
    return () => { useDemo.setState({ modelerChat: null }) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const st = useModel.getState(), k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) st.redo(); else st.undo(); return }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); st.redo(); return }
      if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); if (st.sel) st.duplicate(st.sel); return }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (k === 'escape') { if (st.draft) st.set({ draft: null }); else if (st.tool !== 'select') st.setTool('select'); else st.select(null); return }
      if ((k === 'delete' || k === 'backspace') && st.sel) { e.preventDefault(); st.remove(st.sel); return }
      const tool = TOOLS.find((x) => x.key.toLowerCase() === k)
      if (tool) { st.setTool(tool.t); return }
      if (k === '1' || k === '2' || k === '3') { st.setPlane((['xy', 'xz', 'yz'] as Plane[])[+k - 1]); return }
      if (k === 'f') st.setView('fit')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  return (
    <div className="mod">
      <aside className="mod-left">
        <div className="mod-sec-h">Project manager</div>
        <div className="mod-tree"><Tree nodes={tree} /></div>
        <div className="mod-sec-h">Properties</div>
        <Props />
      </aside>
      <section className="mod-center">
        <Toolbar onSolve={solve} />
        <div className="mod-view">
          <Suspense fallback={null}><Viewport /></Suspense>
          {!m.objs.length && !m.draft && (
            <div className="mod-empty">
              <b>Empty design</b>
              <span>Press <kbd>B</kbd> and click on the grid to draw a box, or use <b>Insert ▸ Patch antenna</b>.</span>
            </div>
          )}
        </div>
        <Messages />
        <StatusBar />
      </section>
      {right}
    </div>
  )
}
