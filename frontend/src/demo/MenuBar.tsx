import { useEffect, useRef, useState } from 'react'
import { solveModel } from './modeler/Modeler'
import { type Obj, type Plane, type Tool, useModel, validate } from './modeler/model'
import { useDemo } from './store'
import { useTheme } from './theme'

/**
 * A desktop-style menu bar: File, Edit, View, Draw, Solve, Help. Menus open on click and follow the pointer once
 * one is open; items that don't apply on the current screen are greyed out; shortcuts are shown on the right.
 */

interface Item { label: string; key?: string; run?: () => void; off?: boolean; on?: boolean }
type Menu = { name: string; items: (Item | '-')[] }

const SHORTCUTS: [string, string][] = [
  ['B / C / R / O / P', 'box, cylinder, rectangle, circle, port'], ['S', 'select and move'], ['1 / 2 / 3', 'draw in the XY / XZ / YZ plane'],
  ['Esc', 'cancel the shape, then the tool'], ['Ctrl+Z / Ctrl+Y', 'undo / redo'], ['Ctrl+D', 'duplicate'], ['Del', 'delete'], ['F', 'fit the view'],
  ['Ctrl+S', 'save the project to a file'], ['Tab, Enter', 'in the chat: type the suggestion, send'],
]

function download(name: string, text: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function MenuBar() {
  const s = useDemo()
  const m = useModel()
  const dark = useTheme((x) => x.dark)
  const [open, setOpen] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const pdfIn = useRef<HTMLInputElement>(null)
  const projIn = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('mousedown', close); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [open])

  const inModeler = s.screen === 'modeler'
  const inFlow = s.screen === 'flow'
  const running = s.phase === 'reading' || s.phase === 'solving' || s.phase === 'tuning'
  const busy = running && !s.paused
  const newDesign = () => {
    const work = useModel.getState().objs.length > 0 || s.phase !== 'empty'
    if (work && !confirm('Start a new empty design? The current one will be closed. Use File ▸ Save project first if you want to keep it.')) return
    s.reset(); useModel.getState().clear(); useDemo.getState().setScreen('modeler')
  }
  const save = () => {
    const st = useModel.getState(), d = useDemo.getState()
    download(`${st.project}.smartem.json`, JSON.stringify({ app: 'smart-em', version: 1, project: st.project, objects: st.objs, design: d.phase !== 'empty' ? d.design : null }, null, 2))
    st.log('ok', `Saved ${st.project}.smartem.json (${st.objs.length} objects).`)
  }
  const openProject = async (f: File) => {
    try {
      const j = JSON.parse(await f.text())
      if (j.app !== 'smart-em' || !Array.isArray(j.objects)) throw new Error('not a Smart EM project')
      s.reset(); useModel.getState().load(j.objects as Obj[], j.project); useDemo.getState().setScreen('modeler')
    } catch (e) { alert(`Couldn't open ${f.name}: ${(e as Error).message}`) }
  }
  const tool = (t: Tool, label: string, key: string): Item => ({ label, key, on: inModeler && m.tool === t, off: !inModeler, run: () => m.setTool(t) })
  const plane = (p: Plane, key: string): Item => ({ label: `Draw in ${p.toUpperCase()}`, key, on: inModeler && m.plane === p, off: !inModeler, run: () => m.setPlane(p) })

  const menus: Menu[] = [
    { name: 'File', items: [
      { label: 'New empty design', run: newDesign },
      { label: 'Upload a paper…', run: () => pdfIn.current?.click() },
      '-',
      { label: 'Open project file…', run: () => projIn.current?.click() },
      { label: 'Save project', key: 'Ctrl+S', off: !m.objs.length, run: save },
      '-',
      { label: 'All projects', off: s.screen === 'home', run: () => s.setScreen('home') },
      { label: 'Close design', off: s.screen === 'home', run: () => { if (confirm('Close this design and start over?')) { s.reset(); useModel.getState().clear() } } },
    ] },
    { name: 'Edit', items: [
      { label: 'Undo', key: 'Ctrl+Z', off: !inModeler || !m.past.length, run: m.undo },
      { label: 'Redo', key: 'Ctrl+Y', off: !inModeler || !m.future.length, run: m.redo },
      '-',
      { label: 'Duplicate', key: 'Ctrl+D', off: !inModeler || !m.sel, run: () => m.sel && m.duplicate(m.sel) },
      { label: 'Delete', key: 'Del', off: !inModeler || !m.sel, run: () => m.sel && m.remove(m.sel) },
      { label: 'Deselect', key: 'Esc', off: !inModeler || !m.sel, run: () => m.select(null) },
    ] },
    { name: 'View', items: [
      { label: 'All projects', on: s.screen === 'home', run: () => s.setScreen('home') },
      { label: 'Modeler', on: inModeler, off: !m.objs.length && !inModeler, run: () => s.setScreen('modeler') },
      { label: 'Paper', on: inFlow && s.tab === 'paper', off: !s.pdf, run: () => { s.setScreen('flow'); s.setTab('paper') } },
      { label: '3D model', on: inFlow && s.tab === 'model', off: s.phase === 'empty', run: () => { s.setScreen('flow'); s.setTab('model') } },
      { label: 'Summary', on: inFlow && s.tab === 'summary', off: !s.runs.length, run: () => { s.setScreen('flow'); s.setTab('summary') } },
      { label: 'Paper vs ours', on: inFlow && s.tab === 'compare', off: !s.runs.length || !(s.kind === 'array' || s.pdf?.known), run: () => { s.setScreen('flow'); s.setTab('compare') } },
      { label: 'Results', on: inFlow && s.tab === 'results', off: !s.runs.length && s.phase !== 'solving', run: () => { s.setScreen('flow'); s.setTab('results') } },
      { label: 'Explore', on: inFlow && s.tab === 'explore', off: !s.runs.length, run: () => { s.setScreen('flow'); s.setTab('explore') } },
      '-',
      { label: 'Fit', key: 'F', off: !inModeler, run: () => m.setView('fit') },
      { label: 'Iso', off: !inModeler, run: () => m.setView('iso') },
      { label: 'Top', off: !inModeler, run: () => m.setView('top') },
      { label: 'Front', off: !inModeler, run: () => m.setView('front') },
      { label: 'Radiation box', on: m.showRad, off: !inModeler, run: () => m.set({ showRad: !m.showRad }) },
      '-',
      { label: 'Dark mode', on: dark, run: useTheme.getState().toggle },
    ] },
    { name: 'Draw', items: [
      tool('select', 'Select / move', 'S'), tool('box', 'Box', 'B'), tool('cyl', 'Cylinder', 'C'), tool('rect', 'Rectangle', 'R'), tool('circle', 'Circle', 'O'), tool('port', 'Port', 'P'),
      '-',
      plane('xy', '1'), plane('xz', '2'), plane('yz', '3'),
      '-',
      { label: 'Insert patch antenna', off: !inModeler, run: m.insertPatch },
    ] },
    { name: 'Solve', items: [
      { label: 'Validate model', off: !inModeler, run: () => validate(m.objs).forEach((c) => m.log(c.kind, c.text)) },
      { label: inModeler ? 'Solve this model' : 'Solve', off: running || (inModeler ? !m.objs.length : s.phase === 'empty'), run: () => (inModeler ? solveModel() : s.solve()) },
      { label: 'Tune to goal', off: !s.runs.length || running, run: () => { s.setScreen('flow'); s.tune() } },
      '-',
      { label: s.paused ? 'Resume' : 'Stop', off: !running, run: s.togglePause },
      { label: 'Take over from the tuner', off: s.phase !== 'tuning', run: s.takeOver },
      '-',
      { label: 'How it was solved', off: !s.runs.length, run: () => { s.setScreen('flow'); s.setTab('results') } },
      { label: 'Start over', off: busy, run: () => { if (confirm('Start over? This clears the design and its runs.')) { s.reset(); useModel.getState().clear() } } },
    ] },
    { name: 'Help', items: [
      { label: 'Keyboard shortcuts', key: '?', run: () => setHelp(true) },
      { label: s.sound ? 'Turn build sound off' : 'Turn build sound on', run: s.toggleSound },
    ] },
  ]

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (useModel.getState().objs.length) save() }
      else if (e.key === '?' && tag !== 'INPUT' && tag !== 'TEXTAREA') setHelp(true)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  const where = s.screen === 'home' ? 'All projects'
    : s.screen === 'modeler' ? `${m.project} › ${m.design} › Modeler`
      : `${s.pdf ? s.pdf.name.replace(/\.pdf$/i, '') : m.project} › Design1 › ${s.tab === 'paper' ? 'Paper' : s.tab === 'model' ? '3D model' : s.tab === 'summary' ? 'Summary' : s.tab === 'compare' ? 'Paper vs ours' : s.tab === 'results' ? 'Results' : 'Explore'}`
  return (
    <div className="menubar" ref={bar}>
      {menus.map((mn) => (
        <div key={mn.name} className="mn">
          <button className={`mn-b${open === mn.name ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); setOpen(open === mn.name ? null : mn.name) }} onMouseEnter={() => { if (open) setOpen(mn.name) }}>{mn.name}</button>
          {open === mn.name && (
            <div className="mn-list">
              {mn.items.map((it, i) => it === '-' ? <div key={i} className="mn-sep" /> : (
                <button key={it.label} className={`mn-i${it.on ? ' chk' : ''}`} disabled={it.off} onClick={() => { setOpen(null); it.run?.() }}>
                  <span className="mn-c">{it.on ? '✓' : ''}</span><span>{it.label}</span><span className="mn-k">{it.key ?? ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <span className="mn-where">{where}</span>
      <input ref={pdfIn} type="file" accept="application/pdf" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (s.phase !== 'empty') s.reset(); await useDemo.getState().attach(f); useDemo.getState().setScreen('flow') }} />
      <input ref={projIn} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void openProject(f) }} />
      {help && (
        <div className="b-scrim" onClick={() => setHelp(false)}>
          <div className="builder" onClick={(e) => e.stopPropagation()}>
            <div className="b-h"><h3>Keyboard shortcuts</h3><button className="link" onClick={() => setHelp(false)}>close</button></div>
            <div className="kb-list">{SHORTCUTS.map(([k, v]) => <div key={k}><kbd>{k}</kbd><span>{v}</span></div>)}</div>
          </div>
        </div>
      )}
    </div>
  )
}
