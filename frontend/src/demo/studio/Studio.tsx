import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { GOAL } from '../model'
import { MATERIALS, type Obj, type Plane, isSheet, useModel } from '../modeler/model'
import { Props, TOOLS } from '../modeler/Modeler'
import { Ico, type TNode, Tree } from '../modeler/Tree'
import { PaperView } from '../PaperView'
import { useTheme } from '../theme'
import { startBridge } from './bridge'
import { bindFileInput, openPlot, runLine, vars } from './commands'
import { Console } from './Console'
import { ContextPanel, PaperResults } from './Context'
import { CATALOG } from './catalog'
import { Gain3D } from './Gain3D'
import { InsightsDoc, ToolView } from './Insights'
import { ReportView, TraceDialog, exportCsv } from './Report'
import { useStudio } from './store'
import './studio.css'

const Viewport = lazy(() => import('../modeler/Viewport').then((m) => ({ default: m.Viewport })))

// ---------------------------------------------------------------- menu bar

interface Item { label: string; key?: string; run?: () => void; off?: boolean; sep?: boolean }
function MenuBar({ onReport }: { onReport: () => void }) {
  const st = useStudio(), m = useModel(), th = useTheme()
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])
  const rep = st.reports.find((r) => r.id === st.active)
  const menus: Record<string, Item[]> = {
    File: [
      { label: 'New patch design', run: () => void runLine('insert patch') },
      { label: 'New array design', run: () => void runLine('insert array') },
      { label: '', sep: true },
      { label: 'Import paper (PDF)…', key: 'Ctrl+I', run: () => void runLine('import paper', false) },
      { label: 'Export report data (CSV)', off: !rep, run: () => rep && exportCsv(rep) },
      { label: '', sep: true },
      { label: 'Classic demo', run: () => { location.search = '?classic' } },
    ],
    Edit: [
      { label: 'Undo', key: 'Ctrl+Z', off: !m.past.length, run: m.undo },
      { label: 'Redo', key: 'Ctrl+Y', off: !m.future.length, run: m.redo },
      { label: 'Delete', key: 'Del', off: !m.sel, run: () => m.sel && m.remove(m.sel) },
    ],
    View: [
      { label: 'Fit all', key: 'F', run: () => { st.open('model'); m.setView('fit') } },
      { label: 'Isometric', run: () => m.setView('iso') }, { label: 'Top', run: () => m.setView('top') }, { label: 'Front', run: () => m.setView('front') },
      { label: '', sep: true },
      { label: th.dark ? 'Light theme' : 'Dark theme', run: th.toggle },
      { label: 'Context panel', off: !st.ctx, run: () => st.ctx && st.set({ ctx: { ...st.ctx, open: !st.ctx.open } }) },
    ],
    Draw: TOOLS.map((t) => ({ label: t.name, key: t.key, run: () => { st.open('model'); m.setTool(t.t) } })),
    Simulation: [
      { label: 'Validate', run: () => void runLine('validate') },
      { label: 'Analyze all', key: 'F5', off: !!st.busy, run: () => void runLine('solve') },
      { label: 'Optimize', off: !!st.busy || !st.kind, run: () => void runLine('optimize') },
    ],
    Results: [
      { label: 'Create report…', off: !st.kind, run: onReport },
      { label: 'S-parameter report', off: !st.kind, run: () => void runLine('report dB(S(1,1))') },
      { label: 'Smith chart', off: !st.kind, run: () => void runLine('report S(1,1) smith') },
      { label: 'Far-field pattern', off: !st.kind, run: () => openPlot('pattern') },
      { label: '3D gain', off: !st.kind, run: () => openPlot('gain3d') },
      { label: '', sep: true },
      { label: 'Insights (all tools)', off: !st.kind, run: () => st.open('insights') },
      { label: 'Run history and reasons', off: !st.kind, run: () => openPlot('history') },
      { label: 'Why the solver chose this', off: !st.kind, run: () => openPlot('solver') },
      { label: 'Paper results', off: !st.reports.some((r) => r.fig), run: () => st.open('paperres') },
    ],
    Help: [{ label: 'Commands', run: () => void runLine('help') }],
  }
  return (
    <div className="st-menu" ref={ref}>
      {Object.entries(menus).map(([name, items]) => (
        <div key={name} className="st-m">
          <button className={open === name ? 'on' : ''} onMouseDown={() => setOpen(open === name ? null : name)} onMouseEnter={() => open && setOpen(name)}>{name}</button>
          {open === name && (
            <div className="st-drop">
              {items.map((it, i) => it.sep ? <hr key={i} /> : (
                <button key={it.label} disabled={it.off} onClick={() => { setOpen(null); it.run?.() }}><span>{it.label}</span>{it.key && <kbd>{it.key}</kbd>}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      <span className="st-path">{st.project} › {st.design}{st.kind ? ` · ${st.kind === 'array' ? 'Driven Modal, finite array' : 'Driven Modal'}` : ''}</span>
    </div>
  )
}

// ---------------------------------------------------------------- toolbar

function Toolbar({ onReport }: { onReport: () => void }) {
  const st = useStudio(), m = useModel()
  return (
    <div className="st-tools">
      {TOOLS.map((t) => <button key={t.t} className={m.tool === t.t ? 'on' : ''} title={`${t.name} (${t.key})`} onClick={() => { st.open('model'); m.setTool(t.t) }}>{t.icon}</button>)}
      <i />
      <div className="seg">{(['xy', 'xz', 'yz'] as Plane[]).map((p) => <button key={p} className={m.plane === p ? 'on' : ''} onClick={() => m.setPlane(p)}>{p.toUpperCase()}</button>)}</div>
      <select value={m.material} onChange={(e) => m.set({ material: e.target.value })} title="Material for new objects">{Object.keys(MATERIALS).map((k) => <option key={k}>{k}</option>)}</select>
      <i />
      <button title="Fit (F)" onClick={() => { st.open('model'); m.setView('fit') }}>⤢</button>
      <i />
      <button className="txt" onClick={() => void runLine('validate')}>✓ Validate</button>
      <button className="txt go" disabled={!!st.busy} onClick={() => void runLine('solve')}>▶ Analyze</button>
      <button className="txt" disabled={!!st.busy || !st.kind} onClick={() => void runLine('optimize')}>Optimize</button>
      <button className="txt" disabled={!st.kind} onClick={onReport}>＋ Report</button>
      <button className="txt" disabled={!st.kind} onClick={() => st.open('insights')}>◇ Insights</button>
    </div>
  )
}

// ---------------------------------------------------------------- project tree and properties

function useTree(onReport: () => void): TNode[] {
  const st = useStudio(), m = useModel()
  const obj = (o: Obj): TNode => ({
    id: o.id, label: o.name, selected: m.sel === o.id, muted: !o.visible,
    icon: o.port ? Ico.port : isSheet(o) ? Ico.sheet(MATERIALS[o.material]?.color ?? '#ccc') : Ico.solid(MATERIALS[o.material]?.color ?? '#ccc'),
    onClick: () => { st.open('model'); st.set({ sel: 'obj' }); m.select(o.id); m.setTool('select') },
    right: <button className="tr-eye" onClick={() => m.update(o.id, { visible: !o.visible })}>{o.visible ? '◉' : '○'}</button>,
  })
  const group = (list: Obj[], idp: string): TNode[] => [...new Set(list.map((o) => o.material))].map((mat) => ({ id: `${idp}${mat}`, label: mat, icon: Ico.folder, open: list.length < 12, children: list.filter((o) => o.material === mat).map(obj) }))
  const solids = m.objs.filter((o) => !isSheet(o) && !o.port), sheets = m.objs.filter((o) => isSheet(o) && !o.port), ports = m.objs.filter((o) => o.port)
  const last = st.sols[st.sols.length - 1]
  return [{
    id: 'p', label: <b>{st.project}</b>, icon: Ico.project, children: [{
      id: 'd', label: <><b>{st.design}</b>{st.dirty && <span className="tr-dim"> · modified</span>}</>, icon: Ico.design, children: [
        { id: 'model', label: 'Model', icon: Ico.folder, badge: String(m.objs.length), children: [
          { id: 'so', label: 'Solids', icon: Ico.folder, children: group(solids, 's') },
          { id: 'sh', label: 'Sheets', icon: Ico.folder, open: sheets.length < 12, children: group(sheets, 'h') },
        ] },
        { id: 'vars', label: <>Variables <span className="tr-dim">{st.kind ? vars().length : 0}</span></>, icon: Ico.axes, selected: st.sel === 'vars', onClick: () => st.set({ sel: 'vars' }) },
        { id: 'bnd', label: 'Boundaries', icon: Ico.folder, children: [{ id: 'rad', label: <>Rad1 <span className="tr-dim">· radiation</span></>, icon: Ico.boundary }] },
        { id: 'exc', label: <>Excitations <span className="tr-dim">{ports.length}</span></>, icon: Ico.folder, open: ports.length < 5, children: ports.map(obj) },
        { id: 'mesh', label: <>Mesh <span className="tr-dim">· adaptive</span></>, icon: Ico.mesh },
        { id: 'ana', label: 'Analysis', icon: Ico.folder, children: [{ id: 'su', label: <>Setup1 <span className="tr-dim">· {st.setup.f1}–{st.setup.f2} GHz</span></>, icon: Ico.analysis, selected: st.sel === 'setup', onClick: () => st.set({ sel: 'setup' }), badge: last ? `${st.sols.length} run${st.sols.length > 1 ? 's' : ''}` : undefined },
          { id: 'hist', label: 'Run history', icon: Ico.results, muted: !last, selected: st.active === 'tool:history', onClick: () => openPlot('history') }] },
        { id: 'opt', label: 'Optimetrics', icon: Ico.folder, children: [{ id: 'o1', label: 'Optimization1', icon: Ico.analysis, selected: st.sel === 'opt', onClick: () => st.set({ sel: 'opt' }) }] },
        { id: 'res', label: 'Results', icon: Ico.results, children: [
          ...(st.reports.some((r) => r.fig) ? [{ id: 'pres', label: <>Paper results <span className="tr-dim">{st.reports.filter((r) => r.fig).length}</span></>, icon: Ico.folder, open: false, selected: st.active === 'paperres', onClick: () => st.open('paperres'),
            children: st.reports.filter((r) => r.fig).map((r) => ({ id: r.id, label: r.name, icon: Ico.results, selected: st.active === r.id, onClick: () => st.open(r.id) })) }] : []),
          ...st.reports.filter((r) => !r.fig).map((r) => ({ id: r.id, label: r.name, icon: Ico.results, selected: st.active === r.id, onClick: () => st.open(r.id) })),
          { id: 'ins', label: 'Insights', icon: Ico.design, selected: st.active === 'insights', onClick: () => st.open('insights') },
          { id: 'newrep', label: <span className="tr-dim">Create report…</span>, onClick: onReport },
        ] },
        ...(st.paper ? [{ id: 'paper', label: <>{st.paper.name.replace(/\.pdf$/i, '').slice(0, 26)} <span className="tr-dim">· source</span></>, icon: Ico.folder, selected: st.active === 'paper', onClick: () => st.open('paper') }] : []),
      ],
    }],
  }]
}

function Field({ label, value, unit, onCommit }: { label: string; value: string | number; unit?: string; onCommit: (v: string) => void }) {
  const [t, setT] = useState(String(value))
  useEffect(() => { setT(String(value)) }, [value])
  return (
    <tr>
      <td>{label}</td>
      <td><input value={t} onChange={(e) => setT(e.target.value)} onBlur={() => t !== String(value) && onCommit(t)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></td>
      <td>{unit}</td>
    </tr>
  )
}

function PropGrid() {
  const st = useStudio()
  if (st.sel === 'obj') return <Props />
  if (st.sel === 'vars') {
    if (!st.kind) return <div className="pg-empty">No design.</div>
    return (
      <table className="pg"><tbody>
        {vars().map((v) => <Field key={v.key} label={v.key} unit={v.unit} value={typeof v.get() === 'number' ? +(+v.get()).toFixed(4) : v.get()} onCommit={(x) => void runLine(`set ${v.key} ${x}`)} />)}
      </tbody></table>
    )
  }
  if (st.sel === 'setup') return (
    <table className="pg"><tbody>
      <Field label="start" unit="GHz" value={st.setup.f1} onCommit={(x) => void runLine(`setup ${x} ${st.setup.f2} ${st.setup.n}`)} />
      <Field label="stop" unit="GHz" value={st.setup.f2} onCommit={(x) => void runLine(`setup ${st.setup.f1} ${x} ${st.setup.n}`)} />
      <Field label="points" value={st.setup.n} onCommit={(x) => void runLine(`setup ${st.setup.f1} ${st.setup.f2} ${x}`)} />
      <tr><td>max ΔS</td><td className="ro">0.01</td><td /></tr>
      <tr><td>passes</td><td className="ro">≤ 6</td><td /></tr>
    </tbody></table>
  )
  if (st.sel === 'opt') return (
    <table className="pg"><tbody>
      <Field label="band lo" unit="GHz" value={GOAL.f1} onCommit={(x) => void runLine(`goal ${x} ${GOAL.f2} ${GOAL.db}`)} />
      <Field label="band hi" unit="GHz" value={GOAL.f2} onCommit={(x) => void runLine(`goal ${GOAL.f1} ${x} ${GOAL.db}`)} />
      <Field label="S11 ≤" unit="dB" value={GOAL.db} onCommit={(x) => void runLine(`goal ${GOAL.f1} ${GOAL.f2} ${x}`)} />
      <tr><td>vars</td><td className="ro">{st.kind === 'array' ? 'L, inset, dx, dy, taper' : 'L, inset'}</td><td /></tr>
      <tr><td colSpan={3}><button className="pg-btn" disabled={!!st.busy || !st.kind} onClick={() => void runLine('optimize')}>Run optimization</button></td></tr>
    </tbody></table>
  )
  const rep = st.sel?.startsWith('report:') ? st.reports.find((r) => `report:${r.id}` === st.sel) : undefined
  if (rep) return (
    <table className="pg"><tbody>
      <Field label="name" value={rep.name} onCommit={(x) => st.patchReport(rep.id, { name: x })} />
      <tr><td>type</td><td className="ro">{rep.type}</td><td /></tr>
      <tr><td>traces</td><td className="ro">{rep.traces.length}</td><td /></tr>
      <tr><td colSpan={3}><button className="pg-btn" onClick={() => st.removeReport(rep.id)}>Delete report</button></td></tr>
    </tbody></table>
  )
  return <div className="pg-empty">Select an item.</div>
}

// ---------------------------------------------------------------- document area

function DocTabs() {
  const st = useStudio()
  const title = (d: string) => d === 'model' ? '3D Modeler' : d === 'paper' ? st.paper?.name ?? 'Paper' : d === 'paperres' ? 'Paper results' : d === 'insights' ? 'Insights'
    : d.startsWith('tool:') ? CATALOG.find((p) => `tool:${p.id}` === d)?.name ?? d : d.startsWith('g3d|') ? `3D gain · ${d.split('|')[1]} GHz${st.kind === 'array' ? ` · ${d.split('|')[2]}°` : ''}` : st.reports.find((r) => r.id === d)?.name ?? d
  return (
    <div className="st-tabs">
      {st.docs.map((d) => (
        <button key={d} className={st.active === d ? 'on' : ''} onClick={() => st.open(d)} onAuxClick={(e) => e.button === 1 && d !== 'model' && st.close(d)}>
          <span>{title(d)}</span>
          {d !== 'model' && <i onClick={(e) => { e.stopPropagation(); st.close(d) }} aria-label={`Close ${title(d)}`}>×</i>}
        </button>
      ))}
    </div>
  )
}

function Doc() {
  const st = useStudio(), m = useModel()
  const rep = st.reports.find((r) => r.id === st.active)
  return (
    <div className="st-doc">
      <div className="st-view" style={{ display: st.active === 'model' ? undefined : 'none' }}>
        <Suspense fallback={null}><Viewport /></Suspense>
        {!m.objs.length && !m.draft && (
          <div className="st-empty">
            <button onClick={() => void runLine('insert patch')}>Patch antenna</button>
            <button onClick={() => void runLine('insert array')}>4×4 patch array</button>
            <button onClick={() => void runLine('import paper', false)}>Import paper…</button>
            <span>or draw: B box · R rectangle · P port</span>
          </div>
        )}
      </div>
      {st.paper && <div className="st-paper" style={{ display: st.active === 'paper' ? undefined : 'none' }}>
        <PaperView data={st.paper.data} name={st.paper.name} t={null} reading={false} onInfo={(_n, _k, which) => void st.paperRead(which ?? null)} />
      </div>}
      {rep && <ReportView key={rep.id} rep={rep} />}
      {st.active === 'paperres' && <PaperResults />}
      {st.active === 'insights' && <InsightsDoc />}
      {st.active.startsWith('tool:') && <div className="st-tool"><ToolView key={st.active} id={st.active.slice(5)} /></div>}
      {st.active.startsWith('g3d|') && <Gain3D sol={st.sols[st.sols.length - 1]} freq={+st.active.split('|')[1]} steer={+st.active.split('|')[2]} />}
    </div>
  )
}

function StatusBar() {
  const st = useStudio(), m = useModel()
  return (
    <div className="st-status">
      <span className="st-prog">{st.busy ? <><i style={{ width: `${Math.round(st.busy.p * 100)}%` }} />{st.busy.label}</> : 'Ready'}</span>
      <span>{m.cursor ? `X ${m.cursor[0].toFixed(2)}  Y ${m.cursor[1].toFixed(2)}  Z ${m.cursor[2].toFixed(2)}` : ''}</span>
      <span>{st.sols.length} run{st.sols.length === 1 ? '' : 's'}</span>
      <span>solver Q&amp;A: {st.aiSource || '—'}</span>
      <span>mm · GHz</span>
    </div>
  )
}

// ---------------------------------------------------------------- page

export default function Studio() {
  const st = useStudio()
  const [dlg, setDlg] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const tree = useTree(() => setDlg(true))
  const [dock, setDock] = useState(true)
  useEffect(() => { bindFileInput(file.current) }, [])
  useEffect(() => startBridge(), [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (e.key === 'F5') { e.preventDefault(); void runLine('solve'); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); file.current?.click(); return }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || useStudio.getState().active !== 'model') return
      const m = useModel.getState(), key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); if (e.shiftKey) m.redo(); else m.undo(); return }
      if ((e.ctrlKey || e.metaKey) && key === 'y') { e.preventDefault(); m.redo(); return }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (key === 'escape') { if (m.draft) m.set({ draft: null }); else if (m.tool !== 'select') m.setTool('select'); else m.select(null); return }
      if ((key === 'delete' || key === 'backspace') && m.sel) { e.preventDefault(); m.remove(m.sel); return }
      const t = TOOLS.find((x) => x.key.toLowerCase() === key)
      if (t) { m.setTool(t.t); return }
      if (key === '1' || key === '2' || key === '3') { m.setPlane((['xy', 'xz', 'yz'] as Plane[])[+key - 1]); return }
      if (key === 'f') m.setView('fit')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  // selecting an object in the 3D view shows its properties
  useEffect(() => useModel.subscribe((m, p) => { if (m.sel && m.sel !== p.sel) useStudio.getState().set({ sel: 'obj' }) }), [])
  useEffect(() => { if (!useModel.getState().objs.length) useModel.getState().set({ msgs: [] }) }, [])
  return (
    <div className="st" onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = [...e.dataTransfer.files].find((x) => x.name.toLowerCase().endsWith('.pdf')); if (f) void st.importPaper(f) }}>
      <MenuBar onReport={() => setDlg(true)} />
      <Toolbar onReport={() => setDlg(true)} />
      <div className={`st-body${st.ctx?.open ? ' cx-on' : ''}`}>
        <aside className="st-left">
          <div className="st-h">Project Manager</div>
          <div className="st-tree"><Tree nodes={tree} /></div>
          <div className="st-h">Properties</div>
          <div className="st-props"><PropGrid /></div>
        </aside>
        <main className="st-main">
          <DocTabs />
          <Doc />
          <div className={`st-dock${dock ? '' : ' min'}`}>
            <button className="st-dock-t" onClick={() => setDock(!dock)} title={dock ? 'Collapse' : 'Expand'}>{dock ? '▾' : '▴'}</button>
            <Console />
          </div>
        </main>
        <ContextPanel />
      </div>
      <StatusBar />
      <input ref={file} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void st.importPaper(f) }} />
      {dlg && <TraceDialog onClose={() => setDlg(false)} rep={st.reports.find((r) => r.id === st.active)} />}
    </div>
  )
}
