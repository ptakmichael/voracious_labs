import { Edges, GizmoHelper, GizmoViewport, Grid, Html, OrbitControls, TransformControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { ink3d, useTheme } from '../theme'
import { AXIS, type Draft, MATERIALS, type Obj, type Plane, type SnapPt, type Tool, type V3, centerOf, inPlane, isSheet, maxOf, snapPoints, useModel } from './model'

THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

const SIG = '#cf4520'
const SNAP_PX = 12

// ---------------------------------------------------------------- objects

function rotFor(kind: Obj['kind'], plane: Plane): [number, number, number] {
  if (kind === 'cyl') return plane === 'xy' ? [Math.PI / 2, 0, 0] : plane === 'xz' ? [0, 0, 0] : [0, 0, Math.PI / 2]
  return plane === 'xy' ? [0, 0, 0] : plane === 'xz' ? [Math.PI / 2, 0, 0] : [0, Math.PI / 2, 0]
}
const sheetArgs = (o: { plane: Plane; size: V3 }): [number, number] => (o.plane === 'xy' ? [o.size[0], o.size[1]] : o.plane === 'xz' ? [o.size[0], o.size[2]] : [o.size[2], o.size[1]])

function Geometry({ o }: { o: Pick<Obj, 'kind' | 'plane' | 'size'> }) {
  const [u] = inPlane(o.plane), n = AXIS[o.plane]
  if (o.kind === 'box') return <boxGeometry args={[Math.max(o.size[0], 1e-3), Math.max(o.size[1], 1e-3), Math.max(o.size[2], 1e-3)]} />
  if (o.kind === 'cyl') return <cylinderGeometry args={[o.size[u] / 2, o.size[u] / 2, Math.max(o.size[n], 1e-3), 48]} />
  if (o.kind === 'circle') return <circleGeometry args={[o.size[u] / 2, 48]} />
  return <planeGeometry args={sheetArgs(o as Obj)} />
}

function ObjMesh({ o, selected, tool, onSelect, refs }: { o: Obj; selected: boolean; tool: Tool; onSelect: () => void; refs: MutableRefObject<Map<string, THREE.Object3D>> }) {
  const [hover, setHover] = useState(false)
  const mat = MATERIALS[o.material] ?? MATERIALS.vacuum
  const sheet = isSheet(o)
  const color = o.port ? SIG : mat.color
  const opacity = o.port ? 0.55 : mat.metal ? 1 : 0.5
  return (
    <mesh ref={(m) => { if (m) refs.current.set(o.id, m); else refs.current.delete(o.id) }} userData={{ id: o.id }}
      position={centerOf(o)} rotation={rotFor(o.kind, o.plane)} visible={o.visible} renderOrder={sheet ? 2 : 1}
      onClick={(e) => { if (tool !== 'select' || e.delta > 4) return; e.stopPropagation(); onSelect() }}
      onPointerOver={(e) => { if (tool === 'select') { e.stopPropagation(); setHover(true) } }} onPointerOut={() => setHover(false)}>
      <Geometry o={o} />
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} side={THREE.DoubleSide} metalness={mat.metal ? 0.35 : 0} roughness={0.55}
        depthWrite={opacity === 1} polygonOffset={sheet} polygonOffsetFactor={-2} emissive={selected ? SIG : hover ? '#555' : '#000'} emissiveIntensity={selected ? 0.25 : hover ? 0.15 : 0} />
      <Edges color={selected ? SIG : ink3d(useTheme.getState().dark)} threshold={20} />
      {o.port && <Html center zIndexRange={[5, 0]}><div className="m-port">{o.port.n}</div></Html>}
    </mesh>
  )
}

function DraftMesh({ d }: { d: Draft }) {
  const shape = draftShape(d)
  if (!shape) return null
  return (
    <mesh position={centerOf(shape as Obj)} rotation={rotFor(shape.kind, shape.plane)} renderOrder={5}>
      <Geometry o={shape} />
      <meshBasicMaterial color={SIG} transparent opacity={0.28} side={THREE.DoubleSide} depthWrite={false} />
      <Edges color={SIG} />
    </mesh>
  )
}

/** The object a draft would make, or null if it's still a point. */
export function draftShape(d: Draft): Pick<Obj, 'kind' | 'plane' | 'pos' | 'size'> | null {
  if (!d.p2) return null
  const n = AXIS[d.plane], [u, v] = inPlane(d.plane)
  const kind: Obj['kind'] = d.tool === 'box' ? 'box' : d.tool === 'cyl' ? 'cyl' : d.tool === 'circle' ? 'circle' : 'rect'
  const pos: V3 = [0, 0, 0], size: V3 = [0, 0, 0]
  if (kind === 'cyl' || kind === 'circle') {
    const r = Math.hypot(d.p2[u] - d.p1[u], d.p2[v] - d.p1[v])
    pos[u] = d.p1[u] - r; pos[v] = d.p1[v] - r; size[u] = 2 * r; size[v] = 2 * r
  } else {
    pos[u] = Math.min(d.p1[u], d.p2[u]); pos[v] = Math.min(d.p1[v], d.p2[v])
    size[u] = Math.abs(d.p2[u] - d.p1[u]); size[v] = Math.abs(d.p2[v] - d.p1[v])
  }
  const h = kind === 'box' || kind === 'cyl' ? d.h ?? 0 : 0
  pos[n] = Math.min(d.off, d.off + h); size[n] = Math.abs(h)
  return { kind, plane: d.plane, pos, size }
}

// ---------------------------------------------------------------- drawing

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z]

function DrawController({ meshes }: { meshes: MutableRefObject<Map<string, THREE.Object3D>> }) {
  const { camera, gl, size } = useThree()
  const down = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const toScreen = (p: V3) => { const q = new THREE.Vector3(...p).project(camera); return [(q.x + 1) / 2 * size.width, (1 - q.y) / 2 * size.height] }
    const evalPointer = (e: PointerEvent) => {
      const st = useModel.getState()
      const r = el.getBoundingClientRect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      ray.setFromCamera(new THREE.Vector2((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1), camera)
      const d = st.draft
      const n = AXIS[d?.plane ?? st.plane], [u, v] = inPlane(d?.plane ?? st.plane)
      const pick = (pts: SnapPt[], test: (p: V3) => boolean) => {
        let best: SnapPt | null = null, bd = SNAP_PX
        const order = { vertex: 0, mid: 1, center: 2, grid: 3 }
        for (const c of pts) {
          if (!st.snap[c.kind as 'vertex' | 'mid' | 'center'] || !test(c.p)) continue
          const [x, y] = toScreen(c.p)
          const dd = Math.hypot(x - sx, y - sy) + order[c.kind] * 2
          if (dd < bd) { bd = dd; best = c }
        }
        return best
      }
      // height phase: distance along the plane normal, read on a plane that contains the normal and faces the camera
      if (d && d.p2 && d.h !== undefined && (d.tool === 'box' || d.tool === 'cyl')) {
        const axis = new THREE.Vector3(); axis.setComponent(n, 1)
        const view = new THREE.Vector3(); camera.getWorldDirection(view)
        const nrm = view.clone().sub(axis.clone().multiplyScalar(view.dot(axis)))
        if (nrm.lengthSq() < 1e-6) return
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(nrm.normalize(), new THREE.Vector3(...d.p2))
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        let h = q.getComponent(n) - d.off
        if (st.snap.grid) h = Math.round(h / st.grid) * st.grid
        let hit: SnapPt | null = null
        const levels = [...new Set(snapPoints(st.objs).map((c) => +c.p[n].toFixed(4)))]
        for (const lv of levels) {
          const p: V3 = [...d.p2] as V3; p[n] = lv
          const [x, y] = toScreen(p)
          if (Math.hypot(x - sx, y - sy) < SNAP_PX && Math.abs(lv - d.off) > 1e-6) { h = lv - d.off; hit = { p, kind: 'vertex' }; break }
        }
        const p: V3 = [...d.p2] as V3; p[n] = d.off + h
        useModel.setState({ draft: { ...d, h }, cursor: p, hit: hit ?? { p, kind: 'grid' } })
        return
      }
      // drawing plane: a hovered face parallel to it, else the plane through the origin (or the first click)
      let off = d ? d.off : 0
      if (!d) {
        const hits = ray.intersectObjects([...meshes.current.values()].filter((m) => m.visible), false)
        const f = hits.find((h) => h.face)
        if (f && f.face) {
          const nw = f.face.normal.clone().transformDirection(f.object.matrixWorld)
          if (Math.abs(nw.getComponent(n)) > 0.95) off = f.point.getComponent(n)
        }
      }
      const pl = new THREE.Plane(new THREE.Vector3(...([0, 1, 2].map((k) => (k === n ? 1 : 0)) as V3)), -off)
      const q = new THREE.Vector3()
      if (!ray.ray.intersectPlane(pl, q)) return
      let p: V3 = v3(q)
      let hit: SnapPt | null = pick(snapPoints(st.objs), (q) => Math.abs(q[n] - off) < 1e-3)
      if (d?.p1 && !hit) { // the first corner snaps too, so you can close a shape exactly
        const [x, y] = toScreen(d.p1); if (Math.hypot(x - sx, y - sy) < SNAP_PX) hit = { p: d.p1, kind: 'vertex' }
      }
      if (hit) p = [...hit.p] as V3
      else if (st.snap.grid) { p[u] = Math.round(p[u] / st.grid) * st.grid; p[v] = Math.round(p[v] / st.grid) * st.grid; hit = { p, kind: 'grid' } }
      p[n] = off
      useModel.setState({ cursor: p, hit, ...(d ? { draft: { ...d, p2: p } } : { planeOff: off }) })
    }
    const onMove = (e: PointerEvent) => { if (useModel.getState().tool !== 'select' && !(e.buttons & 1)) evalPointer(e) }
    const onDown = (e: PointerEvent) => { if (e.button === 0) down.current = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      const st = useModel.getState()
      if (st.tool === 'select' || e.button !== 0 || !down.current) return
      if (Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 5) return // that was an orbit
      evalPointer(e)
      const s2 = useModel.getState(), p = s2.cursor
      if (!p) return
      const d = s2.draft
      const n = AXIS[s2.plane]
      if (!d) { useModel.setState({ draft: { tool: s2.tool, plane: s2.plane, off: p[n], p1: p } }); return }
      const shape = draftShape(d)
      if (!shape) return
      const [u, v] = inPlane(d.plane)
      if (shape.size[u] < 1e-3 || shape.size[v] < 1e-3) return
      if ((d.tool === 'box' || d.tool === 'cyl') && d.h === undefined) { useModel.setState({ draft: { ...d, h: 0 } }); return }
      if ((d.tool === 'box' || d.tool === 'cyl') && Math.abs(d.h ?? 0) < 1e-3) return
      const isPort = d.tool === 'port'
      s2.add({ ...shape, material: isPort ? 'PEC' : s2.material, port: isPort ? { z0: 50, n: s2.objs.filter((o) => o.port).length + 1 } : undefined })
      s2.log('ok', `${useModel.getState().objs[useModel.getState().objs.length - 1].name}: ${shape.size.filter((x) => x > 0).map((x) => x.toFixed(2)).join(' × ')} mm${isPort ? ', 50 Ω' : `, ${s2.material}`}.`)
      useModel.setState({ draft: null })
    }
    const onContext = (e: MouseEvent) => { if (useModel.getState().draft) { e.preventDefault(); useModel.setState({ draft: null }) } }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('contextmenu', onContext)
    return () => { el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); el.removeEventListener('contextmenu', onContext) }
  }, [camera, gl, size, meshes])
  return null
}

function SnapMark() {
  const hit = useModel((s) => s.hit)
  const tool = useModel((s) => s.tool)
  if (!hit || tool === 'select') return null
  return (
    <Html position={hit.p} center zIndexRange={[50, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`snapmark ${hit.kind}`} title={hit.kind}><i /><span>{hit.kind === 'vertex' ? 'vertex' : hit.kind === 'mid' ? 'midpoint' : hit.kind === 'center' ? 'centre' : ''}{hit.of ? ` · ${hit.of}` : ''}</span></div>
    </Html>
  )
}

// ---------------------------------------------------------------- moving

/** Gizmo on the selected object: grid-snapped, and pulled flush to other objects' faces when within 0.8 mm. */
function Mover({ meshes }: { meshes: MutableRefObject<Map<string, THREE.Object3D>> }) {
  const sel = useModel((s) => s.sel)
  const tool = useModel((s) => s.tool)
  const grid = useModel((s) => s.grid)
  const [obj, setObj] = useState<THREE.Object3D | null>(null)
  useEffect(() => { setObj(sel ? meshes.current.get(sel) ?? null : null) }, [sel, meshes, useModel((s) => s.objs.length)]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!obj || tool !== 'select') return null
  const onChange = () => {
    const st = useModel.getState()
    const o = st.objs.find((x) => x.id === sel)
    if (!o) return
    const min: V3 = [obj.position.x - o.size[0] / 2, obj.position.y - o.size[1] / 2, obj.position.z - o.size[2] / 2]
    for (const k of [0, 1, 2] as const) {
      if (Math.abs(min[k] - o.pos[k]) < 1e-4) { min[k] = o.pos[k]; continue } // only the axis being dragged snaps
      if (st.snap.grid) min[k] = Math.round(min[k] / st.grid) * st.grid
      let best = 0.8, to: number | null = null
      for (const other of st.objs) {
        if (other.id === o.id || !other.visible) continue
        for (const face of [other.pos[k], maxOf(other)[k]]) for (const [edge, off] of [[min[k], 0], [min[k] + o.size[k], o.size[k]]] as const) {
          const dd = Math.abs(edge - face); if (dd < best) { best = dd; to = face - off }
        }
      }
      if (to !== null) min[k] = to
    }
    obj.position.set(min[0] + o.size[0] / 2, min[1] + o.size[1] / 2, min[2] + o.size[2] / 2)
    st.update(o.id, { pos: min.map((v) => Math.round(v * 1000) / 1000) as V3 }, false)
  }
  return <TransformControls object={obj} mode="translate" translationSnap={grid} size={1} onMouseDown={() => useModel.getState().commit()} onObjectChange={onChange} />
}

// ---------------------------------------------------------------- camera

function ViewRig() {
  const view = useModel((s) => s.view)
  const { camera, controls } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update: () => void } | null }
  useEffect(() => {
    const objs = useModel.getState().objs.filter((o) => o.visible)
    const lo = objs.length ? [0, 1, 2].map((k) => Math.min(...objs.map((o) => o.pos[k]))) : [-30, -30, 0]
    const hi = objs.length ? [0, 1, 2].map((k) => Math.max(...objs.map((o) => maxOf(o)[k]))) : [30, 30, 10]
    const c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
    const r = Math.max(20, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2)
    const k = 2.6 * r
    const dir = view.name === 'top' ? new THREE.Vector3(0, -0.001, 1) : view.name === 'front' ? new THREE.Vector3(0, -1, 0.12)
      : view.name === 'fit' && controls ? camera.position.clone().sub(controls.target).normalize() : new THREE.Vector3(0.55, -0.95, 0.8)
    camera.position.copy(c.clone().add(dir.normalize().multiplyScalar(k)))
    if (controls) { controls.target.copy(c); controls.update() }
  }, [view.nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

function RadBox() {
  const objs = useModel((s) => s.objs)
  const show = useModel((s) => s.showRad)
  if (!show || !objs.length) return null
  const pad = 299.792458 / 2.1 / 4
  const lo = [0, 1, 2].map((k) => Math.min(...objs.map((o) => o.pos[k])) - pad)
  const hi = [0, 1, 2].map((k) => Math.max(...objs.map((o) => maxOf(o)[k])) + pad)
  return (
    <mesh position={[(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]}>
      <boxGeometry args={[hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]} />
      <meshBasicMaterial color="#2c4a72" transparent opacity={0.04} depthWrite={false} side={THREE.BackSide} />
      <Edges color={useTheme.getState().dark ? '#86a6d1' : '#2c4a72'} />
    </mesh>
  )
}

function PlaneHint() {
  const plane = useModel((s) => s.plane)
  const tool = useModel((s) => s.tool)
  const draft = useModel((s) => s.draft)
  const off = useModel((s) => s.planeOff)
  if (tool === 'select' || plane === 'xy') return null
  const o = draft?.off ?? off
  return (
    <mesh position={plane === 'xz' ? [0, o, 15] : [o, 0, 15]} rotation={plane === 'xz' ? [Math.PI / 2, 0, 0] : [0, Math.PI / 2, 0]}>
      <planeGeometry args={[120, 60]} />
      <meshBasicMaterial color={SIG} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

export function Viewport() {
  const objs = useModel((s) => s.objs)
  const sel = useModel((s) => s.sel)
  const tool = useModel((s) => s.tool)
  const draft = useModel((s) => s.draft)
  const grid = useModel((s) => s.grid)
  const select = useModel((s) => s.select)
  const meshes = useRef(new Map<string, THREE.Object3D>())
  const gridCell = useMemo(() => (grid < 0.5 ? 1 : grid), [grid])
  const dark = useTheme((s) => s.dark)
  return (
    <Canvas camera={{ fov: 32, near: 0.5, far: 5000, position: [60, -100, 85] }} gl={{ antialias: true, alpha: true }} dpr={[1, 2]}
      onPointerMissed={(e) => { if (tool === 'select' && e.button === 0) select(null) }} style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}>
      <ambientLight intensity={0.85} />
      <directionalLight position={[60, -80, 140]} intensity={1.4} />
      <directionalLight position={[-80, 60, 40]} intensity={0.4} />
      <Grid rotation={[Math.PI / 2, 0, 0]} cellSize={gridCell} sectionSize={10} cellColor={dark ? '#2c2a26' : '#d9d3c5'} sectionColor={dark ? '#45423b' : '#b8b1a2'} fadeDistance={420} infiniteGrid cellThickness={0.6} sectionThickness={1} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      {objs.map((o) => <ObjMesh key={`${o.id}${dark ? 'd' : 'l'}`} o={o} selected={sel === o.id} tool={tool} onSelect={() => select(o.id)} refs={meshes} />)}
      {draft && <DraftMesh d={draft} />}
      <SnapMark />
      <Mover meshes={meshes} />
      <RadBox />
      <PlaneHint />
      <DrawController meshes={meshes} />
      <ViewRig />
      <GizmoHelper alignment="bottom-left" margin={[56, 56]}>
        <GizmoViewport axisColors={['#cf4520', '#2f6a4c', '#2c4a72']} labelColor="#fff" />
      </GizmoHelper>
    </Canvas>
  )
}
