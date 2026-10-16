import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { useMemo } from 'react'
import * as THREE from 'three'
import { beam, patternGrid } from '../arrayModel'
import { directivity, patternPow, radEff } from '../paperPhysics'
import { useTheme } from '../theme'
import type { Solution } from './quantities'

/**
 * 3D gain pattern: radius and shade both follow gain (dBi) over a 25 dB range below the peak. One hue, light to
 * dark (sequential), so the peak reads at a glance in either theme. Works for the patch and the steered array.
 */
const RANGE = 25, R = 60, DT = 3, DP = 6

function gainGrid(s: Solution, freq: number, steer: number): { g: number[][]; peak: number } {
  const g: number[][] = []
  if (s.kind === 'array' && s.a) {
    const a = { ...s.a, theta: steer, f: freq }
    const b = beam(s.d, a), pg = patternGrid(a, DT, DP)
    for (let t = 0; t <= 180; t += DT) {
      const row: number[] = []
      for (let p = 0; p <= 360; p += DP) {
        if (t <= 90) row.push(b.gain + 10 * Math.log10(Math.max(1e-9, pg.rows[t / DT][p / DP])))
        else row.push(b.gain - 24 - (t - 90) / 6) // behind the ground plane
      }
      g.push(row)
    }
    return { g, peak: b.gain }
  }
  const k = directivity(s.d, freq) * radEff(s.d, freq)
  let peak = -99
  for (let t = 0; t <= 180; t += DT) {
    const row: number[] = []
    for (let p = 0; p <= 360; p += DP) {
      const v = 10 * Math.log10(Math.max(1e-9, k * patternPow(s.d, freq, (t * Math.PI) / 180, (p * Math.PI) / 180)))
      row.push(v); if (v > peak) peak = v
    }
    g.push(row)
  }
  return { g, peak }
}

const LIGHT = [new THREE.Color('#f6e3d6'), new THREE.Color('#e08a5c'), new THREE.Color('#b8360f'), new THREE.Color('#6e1f07')]
const DARK = [new THREE.Color('#3a2a22'), new THREE.Color('#9a4a26'), new THREE.Color('#e0603a'), new THREE.Color('#ffc4a3')]
const ramp = (k: number, dark: boolean) => {
  const st = dark ? DARK : LIGHT, x = Math.max(0, Math.min(1, k)) * (st.length - 1), i = Math.min(st.length - 2, Math.floor(x))
  return st[i].clone().lerp(st[i + 1], x - i)
}

function Pattern({ g, peak, dark }: { g: number[][]; peak: number; dark: boolean }) {
  const geo = useMemo(() => {
    const nT = g.length, nP = g[0].length, pos: number[] = [], col: number[] = [], idx: number[] = []
    for (let i = 0; i < nT; i++) for (let j = 0; j < nP; j++) {
      const th = (i * DT * Math.PI) / 180, ph = (j * DP * Math.PI) / 180
      const k = Math.max(0, (g[i][j] - (peak - RANGE)) / RANGE), r = 4 + k * R
      pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th))
      const c = ramp(k, dark); col.push(c.r, c.g, c.b)
    }
    for (let i = 0; i < nT - 1; i++) for (let j = 0; j < nP - 1; j++) {
      const a = i * nP + j, b = a + nP
      idx.push(a, b, a + 1, a + 1, b, b + 1)
    }
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geom.setIndex(idx); geom.computeVertexNormals()
    return geom
  }, [g, peak, dark])
  return (
    <>
      <mesh geometry={geo}><meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.8} metalness={0} /></mesh>
      <mesh geometry={geo}><meshBasicMaterial color={dark ? '#000' : '#fff'} wireframe transparent opacity={0.08} /></mesh>
    </>
  )
}

function Axes({ dark }: { dark: boolean }) {
  const c = dark ? '#d9d3c6' : '#1c1b18'
  const L = R + 14
  const pts = (a: [number, number, number]) => new Float32Array([0, 0, 0, ...a])
  return (
    <group>
      {([[L, 0, 0], [0, L, 0], [0, 0, L]] as [number, number, number][]).map((a, i) => (
        <line key={i}>
          <bufferGeometry><bufferAttribute attach="attributes-position" args={[pts(a), 3]} /></bufferGeometry>
          <lineBasicMaterial color={c} transparent opacity={0.6} />
        </line>
      ))}
      <mesh position={[0, 0, -0.5]}><boxGeometry args={[34, 34, 1]} /><meshStandardMaterial color={dark ? '#5a5248' : '#b8b0a2'} /></mesh>
    </group>
  )
}

export function Gain3D({ sol, freq, steer }: { sol: Solution | undefined; freq: number; steer: number }) {
  const dark = useTheme((t) => t.dark)
  const data = useMemo(() => (sol ? gainGrid(sol, freq, steer) : null), [sol, freq, steer])
  if (!sol || !data) return <div className="rp-empty">No solution yet. Analyze first.</div>
  const ticks = [0, 5, 10, 15, 20, 25].map((k) => data.peak - k)
  return (
    <div className="g3">
      <Canvas camera={{ fov: 32, near: 1, far: 2000, position: [170, -190, 150], up: [0, 0, 1] }} gl={{ antialias: true, alpha: true }} dpr={[1, 2]}>
        <ambientLight intensity={0.75} />
        <directionalLight position={[120, -80, 200]} intensity={0.9} />
        <Pattern g={data.g} peak={data.peak} dark={dark} />
        <Axes dark={dark} />
        <OrbitControls makeDefault enableDamping />
      </Canvas>
      <div className="g3-legend">
        <b>Realized gain (dBi)</b>
        <div className="g3-bar" style={{ background: `linear-gradient(to top, ${(dark ? DARK : LIGHT).map((c) => `#${c.getHexString()}`).join(',')})` }} />
        <div className="g3-ticks">{ticks.map((t) => <span key={t}>{t.toFixed(1)}</span>)}</div>
      </div>
      <div className="g3-info">{sol.kind === 'array' ? `steer ${steer}°  ·  ` : ''}{freq} GHz  ·  run {sol.id}  ·  peak {data.peak.toFixed(2)} dBi  ·  z = broadside</div>
    </div>
  )
}
