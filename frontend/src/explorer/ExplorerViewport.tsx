import { Html, Line, OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useMemo, useState } from 'react'
import { FieldOverlay } from '../setup/FieldOverlay'
import { modeAmp, type PatchGeo } from '../setup/fields'
import { CameraRig, Shape, type ViewName } from '../setup/Viewport3D'
import type { GeoObject, Vec3 } from '../types'
import { strengthColor, type HandleInfo } from './handles'
import type { Overlay } from './store'
import { useScene } from '../theme'

function offsetFor(dir: Vec3, k: number): Vec3 {
  // custom handles sit beside the base handle they drive so the two never overlap
  if (Math.abs(dir[2]) > 0.9) return [k, 0, 0]
  const n = Math.hypot(dir[0], dir[1]) || 1
  return [(dir[1] / n) * k, (-dir[0] / n) * k, 0.4]
}

function DimHandle({ info, selected, onSelect }: { info: HandleInfo; selected: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false)
  const h = info.v.handle!
  const off = h.via ? offsetFor(h.dir, 3.2) : ([0, 0, 0] as Vec3)
  const add = (p: Vec3): Vec3 => [p[0] + off[0], p[1] + off[1], p[2] + off[2] + 0.08]
  const a = add(h.a), b = add(h.b)
  // custom handles label a quarter of the way along (and raised) so they don't sit on the base handle's label
  const t = h.via ? 0.25 : 0.5
  const mid: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  const color = strengthColor(info.strength)
  const ext = h.ext.map((e, i) => [add(e), i === 0 ? a : b] as [Vec3, Vec3])
  return (
    <group>
      <Line points={[a, b]} color={color} lineWidth={selected || hover ? 4.5 : 3} dashed={!!h.via} dashSize={1.2} gapSize={0.8} />
      {ext.map(([p, q], i) => <Line key={i} points={[p, q]} color={color} lineWidth={1} transparent opacity={0.55} />)}
      {[a, b].map((p, i) => (
        <mesh key={i} position={p} onClick={(e) => { e.stopPropagation(); onSelect() }}
          onPointerOver={(e) => { e.stopPropagation(); setHover(true) }} onPointerOut={() => setHover(false)}>
          <sphereGeometry args={[selected ? 0.75 : 0.6, 18, 18]} />
          <meshStandardMaterial color={color} />
        </mesh>
      ))}
      <Html position={mid} center zIndexRange={hover ? [40, 30] : [20, 10]}>
        <div className={`ex-hlabel ${selected ? 'sel' : ''}`} style={{ color, marginTop: h.via ? -46 : 0 }} role="button" tabIndex={0}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={onSelect}
          onKeyDown={(e) => { if (e.key === 'Enter') onSelect() }} aria-label={`${info.v.name}: ${info.tip.lines.join(', ')}`}>
          {info.label}
          {hover && (
            <div className="ex-tip">
              <b>{info.tip.head}</b>
              {info.tip.lines.length ? <span>{info.tip.lines.join(' · ')}</span> : <span>No effects computed yet</span>}
              <em>moves {h.moves}{h.via ? ` (via ${h.via})` : ''} · click to select</em>
            </div>
          )}
        </div>
      </Html>
    </group>
  )
}

export default function ExplorerViewport({ objects, g, overlay, freq, animate, handles, selected, onSelect }: {
  objects: GeoObject[]; g: PatchGeo | null; overlay: Overlay; freq: number; animate: boolean
  handles: HandleInfo[]; selected: string | null; onSelect: (v: string) => void
}) {
  const sc = useScene()
  const [view, setView] = useState<ViewName>('iso')
  const [nonce, setNonce] = useState(0)
  const amp = g ? modeAmp(g, freq) : 0
  const kind = overlay === 'E' ? 'E' : overlay === 'J' ? 'J' : null
  const visible = useMemo(() => objects.filter((o) => o.visible !== false), [objects])
  const go = (v: ViewName) => { setView(v); setNonce((n) => n + 1) }
  return (
    <div className="viewport-wrap ex-viewport">
      <div className="ex-cam">
        <button className="btn sm" onClick={() => go(view)}>Fit view</button>
        <button className={`btn sm ${view === 'top' ? 'on' : ''}`} onClick={() => go('top')}>Top</button>
        <button className={`btn sm ${view === 'iso' ? 'on' : ''}`} onClick={() => go('iso')}>Iso</button>
      </div>
      <Canvas camera={{ fov: 35, near: 0.1, far: 5000, position: [80, -100, 90] }} dpr={[1, 2]} gl={{ antialias: true }}>
        <color attach="background" args={[sc.background]} />
        <ambientLight intensity={0.75} />
        <directionalLight position={[60, -80, 120]} intensity={1.1} />
        <directionalLight position={[-80, 60, 40]} intensity={0.35} />
        <CameraRig view={view} nonce={nonce} objects={visible} />
        {visible.map((o) => (
          <group key={o.id} position={o.pos}>
            <Shape o={o} selected={false} wire={false} ghost={!kind ? 'off' : kind === 'J' ? 'dielectric' : 'all'} mesh={0} onSelect={() => {}} />
          </group>
        ))}
        {kind && g && <FieldOverlay g={g} kind={kind} plane="xy_sub" amp={amp} showMag showVec={kind === 'J'} animate={animate} />}
        {handles.map((h) => <DimHandle key={h.v.name} info={h} selected={selected === h.v.name} onSelect={() => onSelect(h.v.name)} />)}
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      </Canvas>
    </div>
  )
}
