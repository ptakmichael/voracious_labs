import { useRef, useState } from 'react'
import { useModel } from './modeler/model'
import { Ico, type TNode, Tree } from './modeler/Tree'
import { useDemo } from './store'

const TEMPLATES = ['Patch antenna', 'Dipole', 'Monopole', 'Horn', 'Microstrip filter', 'Branch-line coupler']

/** Example projects, shown the way the project manager will show saved work. They open once templates ship. */
const EXAMPLES: { name: string; design: string; parts: [string, string][] }[] = [
  { name: 'wifi_patch_2g4', design: 'Inset-fed patch', parts: [['Model', '5 objects'], ['Boundaries', 'radiation'], ['Excitations', 'Port1 · 50 Ω'], ['Analysis', 'Setup1 · 2.44 GHz'], ['Results', 'S11, gain, fields']] },
  { name: 'lora_dipole_915', design: 'Printed dipole', parts: [['Model', '4 objects'], ['Boundaries', 'radiation'], ['Excitations', 'Port1 · 73 Ω'], ['Analysis', 'Setup1 · 915 MHz'], ['Results', 'S11, pattern']] },
  { name: 'xband_horn', design: 'Pyramidal horn', parts: [['Model', '3 objects'], ['Boundaries', 'radiation, PEC'], ['Excitations', 'WavePort1'], ['Analysis', 'Setup1 · 10 GHz'], ['Results', 'gain, pattern']] },
]

function Choice({ n, title, body, children, soon, onClick }: { n: string; title: string; body: string; children?: React.ReactNode; soon?: boolean; onClick?: () => void }) {
  return (
    <div className={`hc${soon ? ' soon' : ''}${onClick ? ' click' : ''}`} onClick={onClick}>
      <div className="hc-n">{n}{soon && <span className="hc-soon">coming soon</span>}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {children}
    </div>
  )
}

export function Home() {
  const s = useDemo()
  const objs = useModel((m) => m.objs)
  const project = useModel((m) => m.project)
  const input = useRef<HTMLInputElement>(null)
  const [desc, setDesc] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const started = s.phase !== 'empty' || !!s.pdf
  const drew = objs.length > 0
  const openFile = async (f: File) => { await s.attach(f); s.setScreen('flow') }
  const session: TNode[] = []
  if (started || drew) {
    const where = started ? 'flow' : 'modeler'
    const name = s.pdf ? s.pdf.name.replace(/\.pdf$/i, '') : started && s.source !== 'cad' ? 'patch-2g4' : project
    session.push({
      id: 'cur', label: <><b>{name}</b> <span className="tr-dim">· open now</span></>, icon: Ico.project, onClick: () => s.setScreen(where), children: [{
        id: 'cur-d', label: <>Design1 <span className="tr-dim">· {s.runs.length ? `${s.runs.length} run${s.runs.length > 1 ? 's' : ''}` : started ? 'built' : `${objs.length} objects`}</span></>, icon: Ico.design, onClick: () => s.setScreen(where), children: [
          { id: 'cur-m', label: <>Model <span className="tr-dim">· {drew ? `${objs.length} objects` : 'from the paper'}</span></>, icon: Ico.folder, onClick: () => s.setScreen(where) },
          { id: 'cur-b', label: 'Boundaries', icon: Ico.boundary, onClick: () => s.setScreen(where) },
          { id: 'cur-e', label: 'Excitations', icon: Ico.port, onClick: () => s.setScreen(where) },
          { id: 'cur-a', label: 'Analysis', icon: Ico.analysis, onClick: () => s.setScreen(where) },
          { id: 'cur-r', label: <>Results <span className="tr-dim">· {s.runs.length ? `${s.runs.length} solves` : 'none yet'}</span></>, icon: Ico.results, onClick: () => { s.setScreen(where); if (s.runs.length) s.setTab('results') } },
        ],
      }],
    })
  }
  const nodes: TNode[] = [{
    id: 'root', label: <b>Projects</b>, icon: Ico.folder, children: [
      ...session,
      ...EXAMPLES.map((e, i): TNode => ({
        id: `ex${i}`, label: <>{e.name} <span className="tr-dim">· example</span></>, icon: Ico.project, open: i === 0 && !session.length, muted: true,
        onClick: () => setNote(`${e.name} is an example of how saved projects will look. It opens once templates ship.`),
        children: [{ id: `ex${i}d`, label: <>Design1 <span className="tr-dim">· {e.design}</span></>, icon: Ico.design, muted: true, children: e.parts.map(([k, v], j) => ({ id: `ex${i}p${j}`, label: <>{k} <span className="tr-dim">· {v}</span></>, icon: k === 'Results' ? Ico.results : k === 'Analysis' ? Ico.analysis : k === 'Excitations' ? Ico.port : k === 'Boundaries' ? Ico.boundary : Ico.folder, muted: true })) }],
      })),
    ],
  }]
  return (
    <div className="home">
      <aside className="home-left">
        <div className="mod-sec-h">Project manager</div>
        <div className="mod-tree"><Tree nodes={nodes} /></div>
        {note && <div className="home-note" onClick={() => setNote(null)}>{note}</div>}
      </aside>
      <main className="home-main">
        <div className="home-h">
          <h1>Start a design</h1>
          <p>Draw it yourself, start from a template, or give me something to read and I'll build it.</p>
        </div>
        <div className="home-cards">
          <Choice n="01" title="Empty design" body="Build the model yourself: boxes, cylinders, sheets and ports, drawn on a grid. Everything snaps to the grid and to other objects. Then solve it like any other design." onClick={() => s.setScreen('modeler')}>
            <div className="hc-art grid-art"><svg viewBox="0 0 120 70"><path d="M20 48l40-18 40 18-40 18z" fill="#a9b48f" fillOpacity=".6" stroke="var(--ink)" /><path d="M42 46l18-8 18 8-18 8z" fill="#c07a36" stroke="var(--ink)" /><circle cx="78" cy="46" r="3.5" fill="none" stroke="#cf4520" strokeWidth="1.5" /></svg></div>
            <button className="btn pri" onClick={(e) => { e.stopPropagation(); s.setScreen('modeler') }}>{drew ? 'Back to the modeler' : 'New empty design'} →</button>
          </Choice>
          <Choice n="02" title="From a template" body="Parameterised starting points you can edit and solve straight away." soon>
            <div className="hc-tpl">{TEMPLATES.map((t) => <span key={t}>{t}</span>)}</div>
            <button className="btn" disabled>Browse templates</button>
          </Choice>
          <Choice n="03" title="Upload context" body="Drop a paper, datasheet or sketch, or describe what you want. I'll read it, fix what doesn't add up, and build the model.">
            <div className={`hc-drop${over ? ' over' : ''}`} onClick={() => input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true) }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); const f = [...e.dataTransfer.files].find((x) => x.name.toLowerCase().endsWith('.pdf')); if (f) void openFile(f) }}>
              <div className="doc" /><span>Drop a PDF here or <u>choose one</u></span>
              <input ref={input} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && void openFile(e.target.files[0])} />
            </div>
            <form className="hc-desc" onSubmit={(e) => { e.preventDefault(); if (!desc.trim()) return; s.setScreen('flow'); s.send(desc) }}>
              <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="or describe it: a 2.4 GHz patch on 1.6 mm FR-4…" />
              <button className="btn sig" type="submit" disabled={!desc.trim()}>Build</button>
            </form>
          </Choice>
        </div>
      </main>
    </div>
  )
}
