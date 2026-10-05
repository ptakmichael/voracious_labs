import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import { patchTemplate, startRun } from '../api'
import { BUILTIN_MATERIALS, defaultProject, useStore } from '../store'
import type { GeoObject, Material, ObjKind, Project } from '../types'
import { Box, Copy, Cyl, Download, Eye, EyeOff, Play, Port, Sheet, Trash, Upload, Wand } from '../components/Icons'

const Viewport3D = lazy(() => import('./Viewport3D'))

const C0 = 299.792458

export function allMaterials(p: Project): Material[] {
  return [...(BUILTIN_MATERIALS as unknown as Material[]), ...p.materials]
}

function describe(o: GeoObject, mats: Material[]) {
  const m = mats.find((x) => x.name === o.material)
  const f = (v: number) => +v.toFixed(2)
  if (o.kind === 'port') return `${o.impedance ?? 50} Ω lumped · probe feed`
  if (o.kind === 'sheet') return `${m?.kind === 'pec' ? 'PEC' : o.material} sheet · ${f(o.size[0])} × ${f(o.size[1])} mm`
  if (o.kind === 'cylinder') return `${o.material} · ⌀${f(o.size[0])} × ${f(o.size[2])} mm`
  return m?.kind === 'dielectric' ? `εr ${m.eps_r} · ${f(o.size[2])} mm` : `${o.material} · ${f(o.size[0])} × ${f(o.size[1])} × ${f(o.size[2])}`
}

function validate(p: Project) {
  const errs: Record<string, string> = {}
  const warns: string[] = []
  const s = p.settings
  if (!(s.f_start > 0)) errs.f_start = 'Must be > 0'
  if (!(s.f_stop > s.f_start)) errs.f_stop = 'Must exceed band start'
  if (!(s.n_points >= 21 && s.n_points <= 1001)) errs.n_points = '21 to 1001'
  if (!(p.goal.f2 > p.goal.f1)) errs.goal_f2 = 'Must exceed From'
  if (p.goal.f1 < s.f_start || p.goal.f2 > s.f_stop) errs.goal_f1 = 'Goal band must lie inside the sweep'
  if (p.goal.threshold_db >= 0) errs.threshold = 'Use a negative dB value'
  const vis = p.objects.filter((o) => o.visible !== false)
  if (!vis.some((o) => o.kind === 'port')) warns.push('No port: add a lumped port to excite the structure.')
  if (!vis.some((o) => o.material === 'pec' || o.material === 'copper')) warns.push('No conductors in the model.')
  vis.forEach((o) => { if (o.kind !== 'port' && o.size.some((v, i) => v < 0 || (v === 0 && !(o.kind === 'sheet' && i === 2)))) warns.push(`${o.name}: zero or negative dimension.`) })
  return { errs, warns, ok: Object.keys(errs).length === 0 && !warns.some((w) => w.startsWith('No port')) }
}

function newObject(kind: ObjKind, p: Project): GeoObject {
  const n = p.objects.filter((o) => o.kind === kind).length + 1
  const id = `${kind}${Date.now().toString(36)}`
  const top = Math.max(0, ...p.objects.filter((o) => o.kind !== 'port').map((o) => o.pos[2] + o.size[2] / 2))
  switch (kind) {
    case 'box': return { id, name: `Box${n}`, kind, material: 'fr4', pos: [0, 0, top + 2.5], size: [10, 10, 5], color: '#a9c2d9' }
    case 'cylinder': return { id, name: `Cylinder${n}`, kind, material: 'pec', pos: [0, 0, top + 2.5], size: [4, 4, 5], color: '#c9a35a' }
    case 'sheet': return { id, name: `Sheet${n}`, kind, material: 'pec', pos: [0, 0, top + 0.01], size: [10, 10, 0], color: '#d9a03f' }
    case 'port': return { id, name: `Port ${p.objects.filter((o) => o.kind === 'port').length + 1}`, kind, material: 'pec', pos: [0, 0, top / 2], size: [1, 0, Math.max(top, 1)], impedance: 50, color: '#c2541e' }
  }
}

function GeometryPanel({ onWizard, onMaterials }: { onWizard: () => void; onMaterials: () => void }) {
  const { project, selectedId, select, setProject, updateObject } = useStore()
  const mats = allMaterials(project)
  const fileRef = useRef<HTMLInputElement>(null)
  const [stepNote, setStepNote] = useState(false)
  const add = (k: ObjKind) => {
    const o = newObject(k, project)
    setProject((p) => ({ ...p, objects: [...p.objects, o] }))
    select(o.id)
  }
  const groups: [string, (o: GeoObject) => boolean][] = [
    ['Solids', (o) => o.kind === 'box' || o.kind === 'cylinder'],
    ['Sheets', (o) => o.kind === 'sheet'],
    ['Excitations', (o) => o.kind === 'port'],
  ]
  const swatch = (o: GeoObject) => (o.kind === 'port' ? '#c2541e' : o.material === 'pec' || o.material === 'copper' ? '#a4711b' : '#5a7254')
  return (
    <section className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="panel-head" style={{ marginBottom: 2 }}>
        <h2>Geometry</h2>
        <button className="btn sm" onClick={onWizard} title="Patch antenna template"><Wand size={15} /> Patch wizard</button>
      </div>
      <div className="tree" style={{ flex: 1, overflow: 'auto' }}>
        {groups.map(([g, f]) => {
          const items = project.objects.filter(f)
          if (!items.length) return null
          return (
            <div key={g}>
              <div className="tree-group"><span>{g}</span><span>{items.length}</span></div>
              {items.map((o) => (
                <div key={o.id} className={`tree-item ${o.id === selectedId ? 'sel' : ''}`} onClick={() => select(o.id)}
                  role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(o.id)} style={{ opacity: o.visible === false ? 0.5 : 1 }}>
                  <span className="sw" style={{ borderColor: swatch(o) }} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{o.name}</div>
                    <div className="ds">{describe(o, mats)}</div>
                  </div>
                  <button className="eye" title={o.visible === false ? 'Show' : 'Hide'}
                    onClick={(e) => { e.stopPropagation(); updateObject(o.id, { visible: o.visible === false }) }}>
                    {o.visible === false ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              ))}
            </div>
          )
        })}
        <div className="tree-group"><span>Boundaries</span></div>
        <div className="tree-item" onClick={() => select(null)}>
          <span className="sw" style={{ borderColor: '#2c5d9e' }} />
          <div><div className="nm">{project.boundary.type === 'pec' ? 'PEC enclosure' : project.boundary.type === 'pml' ? 'PML' : 'Radiation'}</div>
            <div className="ds">air box, padding {project.boundary.padding === 'half' ? 'λ/2' : project.boundary.padding === 'quarter' ? 'λ/4' : 'auto (solver picks)'}</div></div>
        </div>
        <div className="tree-group"><span>Materials</span><button className="show-all" style={{ margin: 0, fontSize: 12 }} onClick={onMaterials}>Library</button></div>
        <div className="small muted" style={{ padding: '0 10px' }}>
          {[...new Set(project.objects.map((o) => o.material))].join(' · ')}
        </div>
      </div>
      <div className="add-row">
        <button className="btn sm" onClick={() => add('box')}><Box size={15} /> Box</button>
        <button className="btn sm" onClick={() => add('cylinder')}><Cyl size={15} /> Cylinder</button>
        <button className="btn sm" onClick={() => add('sheet')}><Sheet size={15} /> Sheet</button>
        <button className="btn sm" onClick={() => add('port')}><Port size={15} /> Port</button>
        <button className="btn sm" onClick={() => setStepNote(true)}><Upload size={15} /> Import STEP</button>
        <button className="btn sm" onClick={() => fileRef.current?.click()} title="Open a saved project (.json)"><Upload size={15} /> Open</button>
        <button className="btn sm" onClick={() => {
          const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${project.name}.json`; a.click()
        }}><Download size={15} /> Save</button>
        <button className="btn sm" onClick={() => { if (confirm('Reset to the default 2.4 GHz patch?')) { setProject(() => defaultProject()); select('patch') } }}>Reset</button>
      </div>
      <input ref={fileRef} type="file" accept=".json" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return
        try { const p = JSON.parse(await f.text()); setProject(() => ({ ...defaultProject(), ...p })) } catch { alert('Not a valid project file') }
        e.target.value = ''
      }} />
      {stepNote && (
        <div className="overlay" onClick={() => setStepNote(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Import STEP</h2>
            <p className="muted">STEP/CAD import is planned. In this demo, build geometry with the primitives or the patch wizard, or open a saved project (.json).</p>
            <div className="modal-foot"><button className="btn" onClick={() => setStepNote(false)}>OK</button></div>
          </div>
        </div>
      )}
    </section>
  )
}

function Num({ value, onChange, step = 0.1, disabled }: { value: number; onChange: (v: number) => void; step?: number; disabled?: boolean }) {
  const [txt, setTxt] = useState<string | null>(null)
  return (
    <input className="input sm" type="number" step={step} disabled={disabled}
      value={txt ?? String(+value.toPrecision(6))}
      onChange={(e) => { setTxt(e.target.value); const v = parseFloat(e.target.value); if (!Number.isNaN(v)) onChange(v) }}
      onBlur={() => setTxt(null)} />
  )
}

function PropertiesPanel() {
  const { project, selectedId, updateObject, setProject, select } = useStore()
  const o = project.objects.find((x) => x.id === selectedId)
  const mats = allMaterials(project)
  if (!o) {
    return (
      <section className="panel props">
        <div className="panel-head"><h2>Properties</h2></div>
        <section>
          <div className="section-title">Boundary</div>
          <div className="field"><label>Type</label>
            <select className="input sm" value={project.boundary.type} onChange={(e) => setProject((p) => ({ ...p, boundary: { ...p.boundary, type: e.target.value as any } }))}>
              <option value="radiation">Radiation (absorbing)</option><option value="pml">PML</option><option value="pec">PEC enclosure</option>
            </select></div>
          <div className="field" style={{ marginTop: 8 }}><label>Air padding</label>
            <select className="input sm" value={project.boundary.padding} onChange={(e) => setProject((p) => ({ ...p, boundary: { ...p.boundary, padding: e.target.value as any } }))}>
              <option value="auto">Auto (solver picks, λ/4 start)</option><option value="quarter">λ/4 at f min</option><option value="half">λ/2 at f min</option>
            </select></div>
        </section>
        <p className="muted small">Select an object in the tree or the 3D view to edit it. Use Move to drag it with the gizmo.</p>
      </section>
    )
  }
  const set = (patch: Partial<GeoObject>) => updateObject(o.id, patch)
  const setV = (key: 'pos' | 'size', i: number, v: number) => { const a = [...o[key]] as [number, number, number]; a[i] = v; set({ [key]: a } as any) }
  const sizeLabels = o.kind === 'cylinder' ? ['⌀', '', 'height'] : ['x', 'y', 'z']
  return (
    <section className="panel props">
      <div className="panel-head">
        <h2>Properties</h2>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn icon ghost" title="Duplicate" onClick={() => {
            const c = { ...o, id: `${o.kind}${Date.now().toString(36)}`, name: `${o.name}_copy`, role: undefined, pos: [o.pos[0] + 5, o.pos[1] + 5, o.pos[2]] as any }
            setProject((p) => ({ ...p, objects: [...p.objects, c] })); select(c.id)
          }}><Copy size={16} /></button>
          <button className="btn icon ghost" title="Delete" onClick={() => { setProject((p) => ({ ...p, objects: p.objects.filter((x) => x.id !== o.id) })); select(null) }}><Trash size={16} /></button>
        </div>
      </div>
      <section>
        <div className="field"><label>Name</label><input className="input sm" value={o.name} onChange={(e) => set({ name: e.target.value })} /></div>
        <div className="row" style={{ marginTop: 8 }}>
          <div className="field" style={{ flex: 1 }}><label>Type</label><input className="input sm" value={o.kind} disabled /></div>
          {o.kind === 'port'
            ? <div className="field" style={{ flex: 1 }}><label>Impedance (Ω)</label><Num value={o.impedance ?? 50} step={1} onChange={(v) => set({ impedance: v })} /></div>
            : <div className="field" style={{ flex: 1.4 }}><label>Material</label>
              <select className="input sm" value={o.material} onChange={(e) => set({ material: e.target.value })}>
                {mats.map((m) => <option key={m.name} value={m.name}>{m.name}{m.kind === 'dielectric' ? ` (εr ${m.eps_r})` : ''}</option>)}
              </select></div>}
        </div>
      </section>
      <section>
        <div className="section-title">Position (mm, centre)</div>
        <div className="grid3">{[0, 1, 2].map((i) => <div key={i}><Num value={o.pos[i]} onChange={(v) => setV('pos', i, v)} /><div className="axis">{'xyz'[i]}</div></div>)}</div>
      </section>
      <section>
        <div className="section-title">{o.kind === 'port' ? 'Port sheet (width, –, height)' : 'Size (mm)'}</div>
        <div className="grid3">{[0, 1, 2].map((i) => (
          <div key={i}>
            <Num value={o.size[i]} disabled={(o.kind === 'sheet' && i === 2) || (o.kind === 'cylinder' && i === 1) || (o.kind === 'port' && i === 1)}
              onChange={(v) => { if (o.kind === 'cylinder' && i === 0) set({ size: [v, v, o.size[2]] }); else setV('size', i, v) }} />
            <div className="axis">{sizeLabels[i]}</div>
          </div>))}
        </div>
      </section>
      {o.role === 'patch' && (
        <div className="notice blue small">Resonant length is the x dimension. The design optimizer may change it within your constraint.</div>
      )}
      {o.kind !== 'port' && (
        <section style={{ marginTop: 12 }}>
          <div className="row"><label className="lbl">Colour</label><input type="color" value={o.color ?? '#cccccc'} onChange={(e) => set({ color: e.target.value })} /></div>
        </section>
      )}
    </section>
  )
}

function PatchWizard({ onClose }: { onClose: () => void }) {
  const { setProject, select, project } = useStore()
  const [f0, setF0] = useState(2.44)
  const [mat, setMat] = useState('ro4003c')
  const [eps, setEps] = useState(3.38)
  const [h, setH] = useState(1.524)
  const [tand, setTand] = useState(0.0027)
  const [feed, setFeed] = useState(0.33)
  const [busy, setBusy] = useState(false)
  const preview = useMemo(() => {
    const W = (C0 / (2 * f0)) * Math.sqrt(2 / (eps + 1))
    const ee = (eps + 1) / 2 + ((eps - 1) / 2) * (1 + (12 * h) / W) ** -0.5
    const dL = (0.412 * h * (ee + 0.3) * (W / h + 0.264)) / ((ee - 0.258) * (W / h + 0.8))
    const L = C0 / (2 * f0 * Math.sqrt(ee)) - 2 * dL
    return { W, ee, dL, L }
  }, [f0, eps, h])
  const pickMat = (m: string) => {
    setMat(m)
    const x = BUILTIN_MATERIALS.find((b) => b.name === m)
    if (x) { setEps(x.eps_r); setTand(x.tan_d) }
  }
  const create = async () => {
    setBusy(true)
    try {
      const builtin = BUILTIN_MATERIALS.find((b) => b.name === mat && b.eps_r === eps && b.tan_d === tand)
      const t = await patchTemplate({ f0, eps_r: eps, h, tan_d: tand, feed_frac: feed, material: builtin ? mat : null })
      const lo = Math.round((f0 * 0.82) * 10) / 10, hi = Math.round((f0 * 1.23) * 10) / 10
      setProject((p) => ({
        ...p, name: `patch_${f0.toFixed(2).replace('.', 'g')}`, objects: t.objects,
        materials: [...p.materials.filter((m) => m.name !== 'substrate_custom'), ...t.materials],
        settings: { ...p.settings, f_start: lo, f_stop: hi },
        goal: { ...p.goal, f1: +(f0 - 0.04).toFixed(2), f2: +(f0 + 0.04).toFixed(2) },
      }))
      select('patch')
      onClose()
    } catch {
      alert('Backend not reachable')
    } finally { setBusy(false) }
  }
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head"><h2>Patch antenna wizard</h2><span className="sub">Transmission-line design equations</span></div>
        <div className="settings-grid three">
          <div className="field"><label>Design frequency f₀ (GHz)</label><Num value={f0} step={0.01} onChange={setF0} /></div>
          <div className="field"><label>Substrate</label>
            <select className="input sm" value={mat} onChange={(e) => pickMat(e.target.value)}>
              {BUILTIN_MATERIALS.filter((m) => m.kind === 'dielectric' && m.eps_r > 1.5).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
              <option value="custom">custom</option>
            </select></div>
          <div className="field"><label>εr</label><Num value={eps} step={0.01} onChange={(v) => { setEps(v); setMat('custom') }} /></div>
          <div className="field"><label>Thickness h (mm)</label><Num value={h} step={0.001} onChange={setH} /></div>
          <div className="field"><label>tan δ</label><Num value={tand} step={0.0001} onChange={(v) => { setTand(v); setMat('custom') }} /></div>
          <div className="field"><label>Feed offset (fraction of L/2)</label><Num value={feed} step={0.01} onChange={setFeed} /></div>
        </div>
        <div className="calc" style={{ marginTop: 18 }}>
          W  = c/(2f₀)·√(2/(εr+1))            = {preview.W.toFixed(2)} mm (non-resonant)<br />
          εeff = {preview.ee.toFixed(3)}   ΔL = {preview.dL.toFixed(3)} mm<br />
          L  = c/(2f₀√εeff) − 2ΔL             = {preview.L.toFixed(2)} mm (resonant)<br />
          feed x = −{feed}·L/2 = {(-feed * preview.L / 2).toFixed(2)} mm
        </div>
        <p className="small muted">Creates substrate, ground plane, patch and a 50 Ω probe port, and centres the sweep and goal band on f₀. This replaces the {project.objects.length} current objects.</p>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={create}><Wand size={16} /> Create geometry</button>
        </div>
      </div>
    </div>
  )
}

function MaterialsModal({ onClose }: { onClose: () => void }) {
  const { project, setProject } = useStore()
  const [name, setName] = useState('')
  const [eps, setEps] = useState(2.94)
  const [tand, setTand] = useState(0.0012)
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head"><h2>Material library</h2></div>
        <table className="mats">
          <thead><tr><th>Name</th><th>Type</th><th>εr</th><th>tan δ</th><th /></tr></thead>
          <tbody>
            {allMaterials(project).map((m) => (
              <tr key={m.name}><td className="mono">{m.name}</td><td>{m.kind === 'pec' ? 'conductor' : 'dielectric'}</td>
                <td>{m.kind === 'pec' ? '–' : m.eps_r}</td><td>{m.kind === 'pec' ? '–' : m.tan_d}</td>
                <td>{project.materials.includes(m) && <button className="btn sm ghost" onClick={() => setProject((p) => ({ ...p, materials: p.materials.filter((x) => x !== m) }))}><Trash size={14} /></button>}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="section-title" style={{ marginTop: 18 }}>Add dielectric</div>
        <div className="row">
          <input className="input sm" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Num value={eps} step={0.01} onChange={setEps} />
          <Num value={tand} step={0.0001} onChange={setTand} />
          <button className="btn sm" disabled={!name.trim()} onClick={() => { setProject((p) => ({ ...p, materials: [...p.materials, { name: name.trim().toLowerCase(), eps_r: eps, tan_d: tand, kind: 'dielectric' }] })); setName('') }}>Add</button>
        </div>
        <div className="modal-foot"><button className="btn" onClick={onClose}>Done</button></div>
      </div>
    </div>
  )
}

function SolveSettings() {
  const { project, setProject, speed, setSpeed, run } = useStore()
  const s = project.settings
  const v = validate(project)
  const [starting, setStarting] = useState(false)
  const setS = (patch: Partial<Project['settings']>) => setProject((p) => ({ ...p, settings: { ...p.settings, ...patch } }))
  const setG = (patch: Partial<Project['goal']>) => setProject((p) => ({ ...p, goal: { ...p.goal, ...patch } }))
  const plots = [['s11', 'S11 (dB)'], ['smith', 'Smith chart'], ['impedance', 'Input impedance'], ['vswr', 'VSWR'], ['farfield', 'Far-field gain']]
  const lam = C0 / ((s.f_start + s.f_stop) / 2)
  const running = !!run.id && !run.finished
  return (
    <section className="panel">
      <div className="panel-head"><h2>Solve settings</h2><span className="sub">λ₀ at band centre = {lam.toFixed(1)} mm</span></div>
      <div className="settings-grid">
        <div className="field"><label>Band start (GHz)</label><Num value={s.f_start} onChange={(x) => setS({ f_start: x })} />{v.errs.f_start && <span className="err-text">{v.errs.f_start}</span>}</div>
        <div className="field"><label>Band stop (GHz)</label><Num value={s.f_stop} onChange={(x) => setS({ f_stop: x })} />{v.errs.f_stop && <span className="err-text">{v.errs.f_stop}</span>}</div>
        <div className="field"><label>Frequency points</label><Num value={s.n_points} step={1} onChange={(x) => setS({ n_points: Math.round(x) })} />{v.errs.n_points && <span className="err-text">{v.errs.n_points}</span>}</div>
        <div className="field"><label>Accuracy target</label>
          <select className="input" value={s.accuracy} onChange={(e) => setS({ accuracy: e.target.value as any })}>
            <option value="quick">Quick look (±0.1)</option><option value="standard">Standard (±0.03)</option><option value="tight">Tight (±0.01)</option>
          </select></div>
      </div>
      <div className="settings-split">
        <div>
          <div className="section-title">Design goal</div>
          <div className="settings-grid three">
            <div className="field"><label>S11 below (dB)</label><Num value={project.goal.threshold_db} step={1} onChange={(x) => setG({ threshold_db: x })} />{v.errs.threshold && <span className="err-text">{v.errs.threshold}</span>}</div>
            <div className="field"><label>From (GHz)</label><Num value={project.goal.f1} step={0.01} onChange={(x) => setG({ f1: x })} />{v.errs.goal_f1 && <span className="err-text">{v.errs.goal_f1}</span>}</div>
            <div className="field"><label>To (GHz)</label><Num value={project.goal.f2} step={0.01} onChange={(x) => setG({ f2: x })} />{v.errs.goal_f2 && <span className="err-text">{v.errs.goal_f2}</span>}</div>
          </div>
          <div className="row wrap small muted" style={{ marginTop: 10 }}>
            Constraints for redesign: patch length ±
            <input className="input sm" type="number" style={{ width: 64 }} value={project.constraints.length_pct}
              onChange={(e) => setProject((p) => ({ ...p, constraints: { ...p.constraints, length_pct: +e.target.value } }))} />%,
            <label className="check" style={{ minHeight: 0 }}><input type="checkbox" checked={project.constraints.feed_free}
              onChange={(e) => setProject((p) => ({ ...p, constraints: { ...p.constraints, feed_free: e.target.checked } }))} /> feed position free</label>
          </div>
          <div className="row wrap" style={{ marginTop: 18, gap: 22 }}>
            <div className="field"><label>Frequency sweep</label>
              <select className="input sm" style={{ width: 190 }} value={s.sweep} onChange={(e) => setS({ sweep: e.target.value as any })}>
                <option value="adaptive">Adaptive (solver picks)</option><option value="interpolating">Interpolating</option><option value="discrete">Discrete</option>
              </select></div>
            <div className="field"><label>Demo speed</label>
              <select className="input sm" style={{ width: 130 }} value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                <option value={0.75}>0.75× (slow)</option><option value={1}>1×</option><option value={1.5}>1.5×</option><option value={3}>3×</option><option value={8}>8× (fast)</option>
              </select></div>
          </div>
        </div>
        <div>
          <div className="section-title">Plots</div>
          {plots.map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" checked={s.plots.includes(k)}
              onChange={(e) => setS({ plots: e.target.checked ? [...s.plots, k] : s.plots.filter((x) => x !== k) })} />
              {l}{k === 'farfield' && <span className="tag">analytic estimate</span>}</label>
          ))}
        </div>
      </div>
      {v.warns.length > 0 && <div className="notice" style={{ marginTop: 16 }}>{v.warns.map((w) => <div key={w}>{w}</div>)}</div>}
      <div className="run-row">
        <div>
          <div className="section-title">Autonomy</div>
          <div className="seg" role="radiogroup">
            {([['ask', 'Ask me first'], ['balanced', 'Balanced'], ['auto', 'Fully autonomous']] as const).map(([k, l]) => (
              <button key={k} className={s.autonomy === k ? 'on' : ''} role="radio" aria-checked={s.autonomy === k} onClick={() => setS({ autonomy: k })}>{l}</button>
            ))}
          </div>
        </div>
        <button className="btn primary" style={{ minHeight: 48, padding: '0 26px', fontSize: 16 }} disabled={!v.ok || starting || running}
          onClick={async () => { setStarting(true); try { await startRun() } catch { alert('Could not start the run. Is the backend running?') } finally { setStarting(false) } }}>
          <Play size={17} /> {running ? 'Running…' : 'Run'}
        </button>
      </div>
    </section>
  )
}

export default function SetupPage() {
  const [wizard, setWizard] = useState(false)
  const [mats, setMats] = useState(false)
  return (
    <>
      <div className="modeler">
        <GeometryPanel onWizard={() => setWizard(true)} onMaterials={() => setMats(true)} />
        <section className="panel" style={{ display: 'flex', flexDirection: 'column', padding: 14 }}>
          <div className="panel-head" style={{ padding: '4px 6px 0' }}>
            <h2>3D view</h2>
            <span className="sub">Drag to orbit · scroll to zoom · right-drag to pan</span>
          </div>
          <div style={{ flex: 1 }}>
            <Suspense fallback={<div className="viewport-wrap" />}><Viewport3D /></Suspense>
          </div>
        </section>
        <PropertiesPanel />
      </div>
      <SolveSettings />
      {wizard && <PatchWizard onClose={() => setWizard(false)} />}
      {mats && <MaterialsModal onClose={() => setMats(false)} />}
    </>
  )
}
