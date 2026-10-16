import { Edges, Html, OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import { type ArrayDesign, BOARD, F0, excitation, lambda, patternGrid } from './arrayModel'
import { type Design } from './model'
import { ink3d, useTheme } from './theme'

THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

const COPPER = '#c07a36', SUB = '#8fa3b8', SIG = '#cf4520'
const FEED_W = 1.12, CUT_W = 1.1, FEED_L = 10
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** One element: an inset-fed patch with its two cuts and a short feed stub, drawn in its own frame. */
function usePatch(d: Design) {
  return useMemo(() => {
    const a = FEED_W / 2 + CUT_W, f = FEED_W / 2, b = -d.L / 2, yi = -d.L / 2 + Math.min(d.y0, d.L * 0.8), W = d.W
    const s = new THREE.Shape()
    s.moveTo(-W / 2, b); s.lineTo(-a, b); s.lineTo(-a, yi); s.lineTo(-f, yi); s.lineTo(-f, b - FEED_L); s.lineTo(f, b - FEED_L); s.lineTo(f, yi); s.lineTo(a, yi); s.lineTo(a, b)
    s.lineTo(W / 2, b); s.lineTo(W / 2, d.L / 2); s.lineTo(-W / 2, d.L / 2); s.closePath()
    return new THREE.ExtrudeGeometry(s, { depth: 0.25, bevelEnabled: false })
  }, [d.L, d.W, d.y0])
}

/** The array's beam as a surface over the board: radius follows the pattern in dB, down to −30 dB. */
function Beam({ a, z }: { a: ArrayDesign; z: number }) {
  const key = JSON.stringify([a.nx, a.ny, a.dx, a.dy, a.theta, a.phi, a.taper, a.sll, a.bits, a.ttd, a.failed, a.f])
  const geo = useMemo(() => {
    const { dTh, dPh, rows } = patternGrid(a)
    const R = 120, pos: number[] = [], col: number[] = [], idx: number[] = []
    const nP = rows[0].length
    const c0 = new THREE.Color('#2c4a72'), c1 = new THREE.Color('#cf4520'), c = new THREE.Color()
    rows.forEach((row, i) => row.forEach((v, j) => {
      const db = Math.max(-30, 10 * Math.log10(Math.max(v, 1e-6)))
      const r = (R * (db + 30)) / 30, th = (i * dTh * Math.PI) / 180, ph = (j * dPh * Math.PI) / 180
      pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th))
      c.copy(c0).lerp(c1, (db + 30) / 30); col.push(c.r, c.g, c.b)
    }))
    for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < nP - 1; j++) {
      const p = i * nP + j
      idx.push(p, p + nP, p + 1, p + 1, p + nP, p + nP + 1)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    g.setIndex(idx); g.computeVertexNormals()
    return g
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const th = (a.theta * Math.PI) / 180, ph = (a.phi * Math.PI) / 180
  const tip: [number, number, number] = [132 * Math.sin(th) * Math.cos(ph), 132 * Math.sin(th) * Math.sin(ph), z + 132 * Math.cos(th)]
  return (
    <group>
      <mesh geometry={geo} position={[0, 0, z]} renderOrder={5}>
        <meshStandardMaterial vertexColors transparent opacity={0.62} side={THREE.DoubleSide} depthWrite={false} roughness={0.8} />
      </mesh>
      <Html position={tip} center zIndexRange={[8, 0]}><div className="v-label sig">beam → {a.theta.toFixed(0)}°{a.phi ? `, φ ${a.phi.toFixed(0)}°` : ''}</div></Html>
    </group>
  )
}

export interface ArraySceneProps { el: Design; a: ArrayDesign; bt?: number; labels?: boolean; beam?: boolean; phases?: boolean; spin?: boolean; far?: boolean; onPick?: (i: number) => void }

function Model({ el, a, bt = 99, labels = false, beam = false, phases = false, onPick }: ArraySceneProps) {
  const dark = useTheme((s) => s.dark)
  const INK = ink3d(dark)
  const geo = usePatch(el)
  const els = useMemo(() => excitation(a), [a])
  const h = el.h * 2 // drawn twice as thick so the board reads at this scale
  const bw = Math.max(BOARD.w, (a.nx - 1) * a.dx + el.W + 60), bh = Math.max(BOARD.h, (a.ny - 1) * a.dy + el.L + 60)
  const show = (at: number, dur = 0.6) => { const k = ease(clamp01((bt - at) / dur)); return { k, dz: (1 - k) * 60 } }
  const gnd = show(0), sub = show(0.35)
  const per = Math.min(0.12, 1.55 / els.length) // the last element lands on the minikit jingle
  return (
    <group>
      <mesh position={[0, 0, -0.3 + gnd.dz]} visible={gnd.k > 0}>
        <boxGeometry args={[bw, bh, 0.6]} />
        <meshStandardMaterial color={COPPER} metalness={0.3} roughness={0.55} transparent opacity={gnd.k} />
        <Edges color={INK} />
      </mesh>
      <mesh position={[0, 0, h / 2 + sub.dz]} visible={sub.k > 0}>
        <boxGeometry args={[bw, bh, h]} />
        <meshStandardMaterial color={SUB} transparent opacity={0.55 * sub.k} roughness={0.9} depthWrite={false} />
        <Edges color={INK} />
      </mesh>
      {els.map((e, n) => {
        const s = show(0.8 + n * per, 0.4)
        const col = !e.on ? '#55524b' : phases ? new THREE.Color().setHSL(e.phase / 360, 0.65, 0.5).getStyle() : COPPER
        return (
          <group key={e.i} position={[e.x, e.y, h + s.dz]} visible={s.k > 0}>
            <mesh geometry={geo} onClick={onPick ? (ev) => { ev.stopPropagation(); onPick(e.i) } : undefined}>
              <meshStandardMaterial color={col} metalness={phases ? 0 : 0.35} roughness={0.45} transparent opacity={s.k * (e.on ? 1 : 0.5)} />
              <Edges color={INK} />
            </mesh>
            <mesh position={[0, -el.L / 2 - FEED_L + 1, -h / 2]}>
              <cylinderGeometry args={[0.6, 0.6, h + 0.6, 10]} />
              <meshStandardMaterial color={SIG} transparent opacity={s.k} />
            </mesh>
            {phases && e.on && <Html position={[0, 0, 1]} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}><div className="ph-tag">{e.phase.toFixed(0)}°</div></Html>}
          </group>
        )
      })}
      {beam && <Beam a={a} z={h} />}
      {labels && (
        <>
          <Html position={[0, -bh / 2 - 8, 0]} center><div className="v-label">board {bw.toFixed(1)} × {bh.toFixed(1)} mm</div></Html>
          <Html position={[-bw / 2 - 6, 0, h]} center><div className="v-label">Rogers 6010.2LM · εr {el.er} · {el.h} mm</div></Html>
          <Html position={[0, bh / 2 + 8, h]} center><div className="v-label sig">{a.nx} × {a.ny} · pitch {a.dx.toFixed(1)} mm ({(a.dx / lambda(F0)).toFixed(2)} λ)</div></Html>
          <Html position={[els[0].x, els[0].y - el.L / 2 - 14, h]} center><div className="v-label">patch {el.W.toFixed(1)} × {el.L.toFixed(1)}, inset {el.y0.toFixed(1)}</div></Html>
        </>
      )}
    </group>
  )
}

export function ArrayScene(p: ArraySceneProps) {
  return (
    <Canvas camera={{ fov: 30, near: 1, far: 5000, position: p.far ? [300, -520, 430] : [210, -360, 300] }} gl={{ alpha: true, antialias: true }} dpr={[1, 2]}>
      <ambientLight intensity={0.85} />
      <directionalLight position={[160, -220, 380]} intensity={1.5} />
      <directionalLight position={[-220, 160, 100]} intensity={0.4} />
      <OrbitControls makeDefault autoRotate={p.spin} autoRotateSpeed={0.4} enableDamping target={[0, 0, p.beam ? 40 : 0]} minDistance={80} maxDistance={1500} />
      <Model {...p} />
    </Canvas>
  )
}
