import { Edges, GizmoHelper, GizmoViewport, Grid, Html, OrbitControls, TransformControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { FIELD_INFO, modeAmp, patchGeo, resonance, turboCss, type FieldKind, type PatchGeo } from './fields'
import { DEFAULT_PLANE, FieldOverlay, PLANE_LABEL, type PlaneKind } from './FieldOverlay'
import type { GeoObject } from '../types'
import { Box, Cursor, Cyl, Fit, Grid as GridIcon, Layers, Move, Port, Redo, Sheet, Undo } from '../components/Icons'

THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

type ViewName = 'iso' | 'top' | 'front' | 'right'
const C0 = 299.792458 // mm·GHz

function sceneExtent(objs: GeoObject[]) {
  const vis = objs.filter((o) => o.visible !== false)
  if (!vis.length) return { c: new THREE.Vector3(), r: 40, box: new THREE.Box3(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 5)) }
  const b = new THREE.Box3()
  vis.forEach((o) => {
    const h = new THREE.Vector3(o.size[0] / 2, o.size[1] / 2, o.size[2] / 2)
    const c = new THREE.Vector3(...o.pos)
    b.expandByPoint(c.clone().sub(h)); b.expandByPoint(c.clone().add(h))
  })
  const c = b.getCenter(new THREE.Vector3())
  return { c, r: Math.max(b.getSize(new THREE.Vector3()).length() / 2, 10), box: b }
}

function CameraRig({ view, nonce }: { view: ViewName; nonce: number }) {
  const { camera, controls } = useThree() as any
  const objects = useStore((s) => s.project.objects)
  useEffect(() => {
    const { c, r } = sceneExtent(objects)
    const d = r * 2.6
    const dir = {
      iso: new THREE.Vector3(0.9, -1.15, 0.95),
      top: new THREE.Vector3(0, -0.001, 1),
      front: new THREE.Vector3(0, -1, 0.001),
      right: new THREE.Vector3(1, 0, 0.001),
    }[view].normalize()
    camera.position.copy(c.clone().add(dir.multiplyScalar(d)))
    camera.up.set(0, 0, 1)
    camera.lookAt(c)
    if (controls) { controls.target.copy(c); controls.update() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, nonce, controls])
  return null
}

function Shape({ o, selected, wire: wireAll, ghost, mesh, onSelect }: { o: GeoObject; selected: boolean; wire: boolean; ghost: 'off' | 'dielectric' | 'all'; mesh: number; onSelect: () => void }) {
  const pec = o.material === 'pec' || o.material === 'copper'
  const color = o.color ?? (pec ? '#d9a03f' : '#b9cdb4')
  const edge = selected ? '#c2541e' : pec ? '#8a6420' : '#6f8a68'
  const [hover, setHover] = useState(false)
  const common = {
    onClick: (e: any) => { e.stopPropagation(); onSelect() },
    onPointerOver: (e: any) => { e.stopPropagation(); setHover(true) },
    onPointerOut: () => setHover(false),
  }
  const opacity = o.kind === 'box' && !pec ? 0.82 : 1
  // with a field overlay on, dielectrics go see-through so cut planes inside them stay visible
  const wire = wireAll || (ghost === 'dielectric' && !pec) || (ghost === 'all' && o.kind !== 'port')
  if (o.kind === 'port') {
    return (
      <group {...common}>
        <mesh>
          <boxGeometry args={[Math.max(o.size[0], 0.6), 0.25, o.size[2] || 1]} />
          <meshStandardMaterial color="#c2541e" emissive="#c2541e" emissiveIntensity={0.35} />
        </mesh>
        <mesh position={[0, 0, (o.size[2] || 1) / 2 + 0.9]}>
          <sphereGeometry args={[0.9, 20, 20]} />
          <meshStandardMaterial color="#c2541e" />
        </mesh>
        <Html position={[1.6, 0, (o.size[2] || 1) / 2 + 1.6]} zIndexRange={[1, 0]}><span className="vp-label">{o.name}</span></Html>
      </group>
    )
  }
  const sx = Math.max(o.size[0], 0.01), sy = Math.max(o.size[1], 0.01)
  const sz = o.kind === 'sheet' ? 0.06 : Math.max(o.size[2], 0.01)
  const seg = (v: number) => Math.max(1, Math.min(60, Math.round(v / mesh)))
  return (
    <group>
      <mesh {...common} rotation={o.kind === 'cylinder' ? [Math.PI / 2, 0, 0] : [0, 0, 0]}>
        {o.kind === 'cylinder'
          ? <cylinderGeometry args={[sx / 2, sx / 2, sz, 48]} />
          : <boxGeometry args={[sx, sy, sz]} />}
        <meshStandardMaterial color={hover && !selected ? new THREE.Color(color).offsetHSL(0, 0, 0.06) : color}
          transparent={opacity < 1 || wire} opacity={wire ? (pec ? 0.28 : 0.12) : opacity} depthWrite={!wire} metalness={pec ? 0.35 : 0} roughness={pec ? 0.45 : 0.85}
          polygonOffset polygonOffsetFactor={o.kind === 'sheet' ? -1 : 1} />
        <Edges color={edge} lineWidth={selected ? 2.2 : 1} threshold={20} />
      </mesh>
      {mesh > 0 && o.kind !== 'cylinder' && (
        <mesh>
          <boxGeometry args={[sx, sy, sz, seg(sx), seg(sy), o.kind === 'sheet' ? 1 : Math.max(2, seg(sz))]} />
          <meshBasicMaterial color="#14213d" wireframe transparent opacity={0.22} />
        </mesh>
      )}
    </group>
  )
}

function AirBox({ pad }: { pad: number }) {
  const objects = useStore((s) => s.project.objects)
  const { box } = sceneExtent(objects)
  const size = box.getSize(new THREE.Vector3()).addScalar(2 * pad)
  const c = box.getCenter(new THREE.Vector3())
  return (
    <mesh position={c}>
      <boxGeometry args={[size.x, size.y, size.z]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      <Edges color="#2c5d9e" lineWidth={1} />
    </mesh>
  )
}

export interface FieldState { g: PatchGeo; kind: FieldKind; plane: PlaneKind; amp: number; showMag: boolean; showVec: boolean; animate: boolean }

function Scene({ mode, wire, mesh, showGrid, air, view, nonce, field }: { mode: 'select' | 'move'; wire: boolean; mesh: number; showGrid: boolean; air: number; view: ViewName; nonce: number; field: FieldState | null }) {
  const { project, selectedId, select, updateObject } = useStore()
  const refs = useRef<Record<string, THREE.Object3D | null>>({})
  const sel = project.objects.find((o) => o.id === selectedId)
  const [target, setTarget] = useState<THREE.Object3D | null>(null)
  useEffect(() => { setTarget(sel ? refs.current[sel.id] ?? null : null) }, [sel?.id, project.objects])
  return (
    <>
      <ambientLight intensity={0.75} />
      <directionalLight position={[60, -80, 120]} intensity={1.1} />
      <directionalLight position={[-80, 60, 40]} intensity={0.35} />
      <CameraRig view={view} nonce={nonce} />
      {showGrid && (
        <Grid rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.05]} args={[400, 400]} cellSize={2} sectionSize={10}
          cellColor="#dfe4ec" sectionColor="#c7cfdb" fadeDistance={260} infiniteGrid />
      )}
      <group onPointerMissed={() => select(null)}>
        {project.objects.filter((o) => o.visible !== false).map((o) => (
          <group key={o.id} ref={(r) => { refs.current[o.id] = r }} position={o.pos}>
            <Shape o={o} selected={o.id === selectedId} wire={wire} ghost={!field ? 'off' : field.kind === 'J' ? 'dielectric' : 'all'} mesh={mesh} onSelect={() => select(o.id)} />
          </group>
        ))}
      </group>
      {air > 0 && <AirBox pad={air} />}
      {field && <FieldOverlay {...field} />}
      {mode === 'move' && sel && target && (
        <MoveGizmo key={sel.id} obj={sel} onCommit={(p) => updateObject(sel.id, {
          pos: [round(p.x), round(p.y), round(p.z)],
        })} target={target} />
      )}
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
        <GizmoViewport axisColors={['#c2541e', '#2c5d9e', '#14213d']} labelColor="#fff" />
      </GizmoHelper>
    </>
  )
}

const round = (v: number) => Math.round(v * 100) / 100

function MoveGizmo({ target, onCommit }: { obj: GeoObject; target: THREE.Object3D; onCommit: (d: THREE.Vector3) => void }) {
  const ref = useRef<any>(null)
  useEffect(() => {
    const tc = ref.current
    if (!tc) return
    const onUp = () => onCommit(target.position.clone())
    tc.addEventListener('mouseUp', onUp)
    return () => tc.removeEventListener('mouseUp', onUp)
  }, [target, onCommit])
  return <TransformControls ref={ref} object={target} mode="translate" translationSnap={0.1} size={0.8} />
}

export default function Viewport3D() {
  const project = useStore((s) => s.project)
  const sel = useStore((s) => s.project.objects.find((o) => o.id === s.selectedId))
  const { undo, redo } = useStore()
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]')) return // keep native undo in fields
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])
  const [mode, setMode] = useState<'select' | 'move'>('select')
  const [view, setView] = useState<ViewName>('iso')
  const [nonce, setNonce] = useState(0)
  const [wire, setWire] = useState(false)
  const [meshOn, setMeshOn] = useState(false)
  const [grid, setGrid] = useState(true)
  const [air, setAir] = useState(false)
  const [fieldKind, setFieldKind] = useState<FieldKind | null>(null)
  const [plane, setPlane] = useState<PlaneKind>('xy_sub')
  const [showMag, setShowMag] = useState(true)
  const [showVec, setShowVec] = useState(true)
  const [animate, setAnimate] = useState(true)
  const [freq, setFreq] = useState<number | null>(null)
  const g = useMemo(() => patchGeo(project), [project])
  const fr = g ? resonance(g).fr : null
  const f = freq ?? fr ?? (project.settings.f_start + project.settings.f_stop) / 2
  const amp = g ? modeAmp(g, f) : 0
  const pickField = (k: FieldKind) => {
    if (fieldKind === k) { setFieldKind(null); return }
    setFieldKind(k)
    setPlane(DEFAULT_PLANE[k])
  }
  const field: FieldState | null = fieldKind && g ? { g, kind: fieldKind, plane, amp, showMag, showVec, animate } : null
  const lamMin = C0 / project.settings.f_stop
  const pad = C0 / project.settings.f_start / (project.boundary.padding === 'half' ? 2 : 4)
  const meshSize = lamMin / 10
  const setV = (v: ViewName) => { setView(v); setNonce((n) => n + 1) }
  const stats = useMemo(() => {
    const { box } = sceneExtent(project.objects)
    const s = box.getSize(new THREE.Vector3())
    return `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(2)} mm`
  }, [project.objects])
  return (
    <div className="viewport-wrap">
      <div className="vp-toolbar">
        <div className="vp-group">
          <button onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo size={15} /></button>
          <button onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z / Ctrl+Y)" aria-label="Redo"><Redo size={15} /></button>
        </div>
        <div className="vp-group">
          <button className={mode === 'select' ? 'on' : ''} onClick={() => setMode('select')} title="Select"><Cursor size={14} /> Select</button>
          <button className={mode === 'move' ? 'on' : ''} onClick={() => setMode('move')} title="Move the selected object"><Move size={14} /> Move</button>
        </div>
        <div className="vp-group">
          {(['iso', 'top', 'front', 'right'] as ViewName[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setV(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
          ))}
          <button onClick={() => setV(view)} title="Fit all"><Fit size={14} /></button>
        </div>
        <div className="vp-group">
          <button className={wire ? 'on' : ''} onClick={() => setWire(!wire)} title="X-ray view"><Layers size={14} /> X-ray</button>
          <button className={meshOn ? 'on' : ''} onClick={() => setMeshOn(!meshOn)} title={`Initial mesh preview (λ/10 at ${project.settings.f_stop} GHz)`}>Mesh</button>
          <button className={air ? 'on' : ''} onClick={() => setAir(!air)} title="Radiation boundary / air box">Air box</button>
          <button className={grid ? 'on' : ''} onClick={() => setGrid(!grid)} title="Grid"><GridIcon size={14} /></button>
        </div>
        <div className="vp-group">
          <span className="vp-group-label">Fields</span>
          {([['E', 'E'], ['H', 'H'], ['S', 'Poynting'], ['J', 'Current']] as [FieldKind, string][]).map(([k, l]) => (
            <button key={k} className={fieldKind === k ? 'on' : ''} onClick={() => pickField(k)} title={`${FIELD_INFO[k].name} (mock)`}>{l}</button>
          ))}
        </div>
      </div>
      <Canvas camera={{ fov: 35, near: 0.1, far: 5000, position: [80, -100, 90] }} dpr={[1, 2]} gl={{ antialias: true }}>
        <color attach="background" args={['#f3f5f9']} />
        <Scene mode={mode} wire={wire} mesh={meshOn ? meshSize : 0} showGrid={grid} air={air ? pad : 0} view={view} nonce={nonce} field={field} />
      </Canvas>
      {fieldKind && (
        <div className="field-panel">
          <div className="fp-head">
            <b>{FIELD_INFO[fieldKind].name}</b>
            <span className="badge-mock">MOCK</span>
            <button className="fp-close" onClick={() => setFieldKind(null)} aria-label="Close field viewer">×</button>
          </div>
          {!g ? (
            <p className="small muted" style={{ margin: 0 }}>The field viewer needs a patch-type structure: a conductor sheet above a ground sheet. Try the Patch wizard.</p>
          ) : (
            <>
              {fieldKind !== 'J' ? (
                <select className="input sm" value={plane} onChange={(e) => setPlane(e.target.value as PlaneKind)} aria-label="Cut plane">
                  {(Object.keys(PLANE_LABEL) as PlaneKind[]).map((k) => <option key={k} value={k}>{PLANE_LABEL[k]}</option>)}
                </select>
              ) : <div className="small muted">On patch (top) and ground plane</div>}
              <div className="fp-toggles">
                <label><input type="checkbox" checked={showMag} onChange={(e) => setShowMag(e.target.checked)} /> Magnitude</label>
                <label><input type="checkbox" checked={showVec} onChange={(e) => setShowVec(e.target.checked)} /> Vectors</label>
                <label title={fieldKind === 'S' ? 'Poynting vector is time-averaged' : 'Animate phase ωt'}>
                  <input type="checkbox" checked={animate && fieldKind !== 'S'} disabled={fieldKind === 'S'} onChange={(e) => setAnimate(e.target.checked)} /> Animate
                </label>
              </div>
              <div className="fp-freq">
                <span>f = {f.toFixed(3)} GHz</span>
                {fr && Math.abs(f - fr) > 5e-4 && <button className="show-all" style={{ margin: 0 }} onClick={() => setFreq(null)}>snap to resonance</button>}
              </div>
              <input type="range" min={project.settings.f_start} max={project.settings.f_stop} step={0.001} value={f}
                onChange={(e) => setFreq(+e.target.value)} aria-label="Frequency (GHz)" style={{ width: '100%' }} />
              <div className="fp-legend">
                <div className="fp-bar" style={{ background: turboCss() }} />
                <div className="fp-ticks"><span>0</span><span>{FIELD_INFO[fieldKind].quantity} · {FIELD_INFO[fieldKind].unit}, normalised, √ scale</span><span>max</span></div>
              </div>
              <div className="small muted">Mode amplitude {(amp * 100).toFixed(0)}% of peak · resonance {fr?.toFixed(3)} GHz. Analytic cavity-model picture, not solver fields.</div>
            </>
          )}
        </div>
      )}
      <div className="vp-status">
        {sel ? `${sel.name} · ${sel.kind} · ${sel.material}` : 'Nothing selected'} · extent {stats}
        {meshOn && ` · mesh λ/10 = ${meshSize.toFixed(1)} mm`}{air && ` · air padding ${pad.toFixed(1)} mm`}
      </div>
    </div>
  )
}

export const AddIcons = { Box, Cyl, Sheet, Port }
