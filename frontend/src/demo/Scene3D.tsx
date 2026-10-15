import { Edges, Html, OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { type ReactNode, useMemo } from 'react'
import * as THREE from 'three'
import { FEED_W, SUBSTRATE, type Design } from './model'

THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

const INK = '#1c1b18'
const COPPER = '#c07a36'
const SUB = '#a9b48f'
const SIG = '#cf4520'
export const SLOT = 1.0 // inset slot gap, mm

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Surface-current magnitude in the first mode: strongest across the middle, zero at the radiating edges. */
function useCurrentTexture() {
  return useMemo(() => {
    const n = 128
    const c = document.createElement('canvas')
    c.width = c.height = n
    const g = c.getContext('2d')!
    const img = g.createImageData(n, n)
    const stops: [number, number, number][] = [[70, 32, 16], [207, 69, 32], [242, 196, 109], [250, 240, 214]]
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const u = i / (n - 1), v = j / (n - 1)
      const edge = 1 + 0.35 * (Math.exp(-u * 14) + Math.exp(-(1 - u) * 14))
      const m = Math.min(1, Math.sin(Math.PI * v) * edge * 0.92)
      const x = m * (stops.length - 1)
      const a = stops[Math.floor(x)], b = stops[Math.min(stops.length - 1, Math.floor(x) + 1)], k = x - Math.floor(x)
      const o = (j * n + i) * 4
      for (let ch = 0; ch < 3; ch++) img.data[o + ch] = a[ch] + (b[ch] - a[ch]) * k
      img.data[o + 3] = 255
    }
    g.putImageData(img, 0, 0)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [])
}

/** Patch outline with the two inset slots either side of the feed. */
function usePatchGeometry(L: number, W: number, y0: number) {
  return useMemo(() => {
    const a = FEED_W / 2 + SLOT, f = FEED_W / 2, b = -L / 2, yi = -L / 2 + y0
    const s = new THREE.Shape()
    s.moveTo(-W / 2, b); s.lineTo(-a, b); s.lineTo(-a, yi); s.lineTo(-f, yi); s.lineTo(-f, b)
    s.lineTo(f, b); s.lineTo(f, yi); s.lineTo(a, yi); s.lineTo(a, b); s.lineTo(W / 2, b)
    s.lineTo(W / 2, L / 2); s.lineTo(-W / 2, L / 2); s.closePath()
    return new THREE.ExtrudeGeometry(s, { depth: 0.18, bevelEnabled: false })
  }, [L, W, y0])
}

function Label({ at, children, sig, show }: { at: [number, number, number]; children: React.ReactNode; sig?: boolean; show: boolean }) {
  return (
    <Html position={at} center zIndexRange={[4, 0]}>
      <div className={`v-label${sig ? ' sig' : ''}`} style={{ opacity: show ? 1 : 0, transition: 'opacity .4s' }}>{children}</div>
    </Html>
  )
}

/** Where everything sits on the board (mm, board centred on the origin, feed coming in from −y). */
export function frame(d: Design) {
  const Ls = SUBSTRATE.len * d.gs, Ws = SUBSTRATE.wid * d.gs
  const py = -Ls / 2 + SUBSTRATE.feedGap * d.gs + d.L / 2
  return { Ls, Ws, py, feedEnd: py - d.L / 2 + d.y0 }
}

export interface SceneProps { d: Design; bt: number; current: number; pulse: number; labels: boolean; fixes: boolean; ghost?: boolean }

function Model({ d, bt, current, pulse, labels, fixes, ghost }: SceneProps) {
  const cu = ghost ? 0.28 : 1, di = ghost ? 0.25 : 1
  const tex = useCurrentTexture()
  const geo = usePatchGeometry(d.L, d.W, d.y0)
  const show = (at: number) => { const k = ease(clamp01((bt - at) / 0.7)); return { k, dz: (1 - k) * 28 } }
  const gnd = show(0), sub = show(0.5), pat = show(1.1), feed = show(1.6), port = show(2.0)
  const { Ls, Ws, py, feedEnd } = frame(d)
  const h = d.h
  const feedLen = feedEnd + Ls / 2
  const ring = 1 + 0.6 * ((pulse * 1.3) % 1)
  return (
    <group>
      <mesh position={[0, 0, -0.18 + gnd.dz]} visible={gnd.k > 0}>
        <boxGeometry args={[Ws, Ls, 0.35]} />
        <meshStandardMaterial color={COPPER} metalness={0.3} roughness={0.55} transparent opacity={gnd.k * (ghost ? 0.55 : 1)} depthWrite={!ghost} />
        <Edges color={INK} />
      </mesh>
      <mesh position={[0, 0, h / 2 + sub.dz]} visible={sub.k > 0}>
        <boxGeometry args={[Ws, Ls, h]} />
        <meshStandardMaterial color={SUB} transparent opacity={0.6 * sub.k * di} roughness={0.9} depthWrite={false} />
        <Edges color={INK} />
      </mesh>
      <group position={[0, py, h + pat.dz]} visible={pat.k > 0}>
        <mesh geometry={geo}>
          <meshStandardMaterial color={COPPER} metalness={0.35} roughness={0.45} transparent opacity={pat.k * cu} depthWrite={!ghost} />
          <Edges color={INK} />
        </mesh>
        <mesh position={[0, 0, 0.22]} visible={current > 0.01}>
          <planeGeometry args={[d.W, d.L]} />
          <meshBasicMaterial map={tex} transparent opacity={current * 0.92} />
        </mesh>
      </group>
      <mesh position={[0, -Ls / 2 + feedLen / 2, h + 0.09 + feed.dz]} visible={feed.k > 0}>
        <boxGeometry args={[FEED_W, feedLen, 0.18]} />
        <meshStandardMaterial color={COPPER} metalness={0.35} roughness={0.45} transparent opacity={feed.k * cu} depthWrite={!ghost} />
        <Edges color={INK} />
      </mesh>
      <mesh position={[0, -Ls / 2 - 1.2 - port.dz, h / 2]} visible={port.k > 0}>
        <boxGeometry args={[FEED_W * 2.2, 2.4, h + 2]} />
        <meshStandardMaterial color={SIG} transparent opacity={port.k} />
        <Edges color={INK} />
      </mesh>
      {pulse > 0 && (
        <mesh position={[0, feedEnd, h + 0.5]} scale={[ring, ring, 1]}>
          <ringGeometry args={[3.2, 4.0, 48]} />
          <meshBasicMaterial color={SIG} transparent opacity={Math.max(0, 1.6 - ring)} side={THREE.DoubleSide} />
        </mesh>
      )}
      <Label at={[Ws / 2 + 2, Ls / 2 - 4, 0]} show={labels} sig={fixes}>board {Ws.toFixed(2)} × {Ls.toFixed(2)}{fixes ? '  eq. 6' : ''}</Label>
      <Label at={[-Ws / 2 - 2, -Ls / 2 + 10, h]} show={labels} sig={fixes}>FR-4  εr {d.er.toFixed(2)}  h {d.h.toFixed(2)}</Label>
      <Label at={[0, py + d.L / 2 + 3, h + 1]} show={labels}>patch {d.W.toFixed(2)} × {d.L.toFixed(2)}</Label>
      <Label at={[FEED_W + 8, feedEnd, h + 1]} show={labels || pulse > 0} sig={pulse > 0}>inset {d.y0.toFixed(2)}</Label>
      <Label at={[0, -Ls / 2 - 5, -2]} show={labels} sig>port 1  50 Ω{fixes ? ' (line 2.9 mm)' : ''}</Label>
    </group>
  )
}

export function Scene3D(p: SceneProps & { spin: boolean; far?: boolean; cam?: [number, number, number]; children?: ReactNode }) {
  return (
    <Canvas camera={{ fov: 30, near: 1, far: 2000, position: p.cam ?? (p.far ? [118, -190, 150] : [62, -100, 82]) }} gl={{ alpha: true, antialias: true }} dpr={[1, 2]}>
      <ambientLight intensity={0.85} />
      <directionalLight position={[60, -80, 140]} intensity={1.6} />
      <directionalLight position={[-80, 60, 40]} intensity={0.4} />
      <OrbitControls makeDefault autoRotate={p.spin} autoRotateSpeed={0.5} enableDamping target={[0, 0, 0]} minDistance={50} maxDistance={400} />
      <Model {...p} />
      {p.children}
    </Canvas>
  )
}
