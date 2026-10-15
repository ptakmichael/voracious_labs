import { Line } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { type MutableRefObject, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { FEED_W, type Design } from './model'
import { SLOT, Scene3D, frame } from './Scene3D'
import { FIELD_COLORS, type FieldKind, THICK } from './fieldsConst'

/**
 * Textbook fields of the patch's first mode (cavity model), animated through one cycle:
 *   E  = cos(πu)·cos ωt, vertical between patch and ground, fringing out past the two ends
 *   H  = sin(πu)·sin ωt, across the width, looping around the current
 *   J  = sin(πu)·sin ωt, along the patch length
 *   S  = E × H: sloshes between ends and middle inside; flows up and out of the two ends on average
 * u runs 0→1 from the feed end to the far end. The board is drawn 4× thicker so the inside is visible.
 */


type V3 = [number, number, number]
interface Item { p: V3; dir: V3; amp: (ph: number) => number }

const up = new THREE.Vector3(0, 1, 0)
/** Arrows whose length and direction follow amp(phase); drawn as instanced shafts and heads. */
function Arrows({ items, color, max, ph }: { items: Item[]; color: string; max: number; ph: MutableRefObject<number> }) {
  const shaft = useRef<THREE.InstancedMesh>(null)
  const head = useRef<THREE.InstancedMesh>(null)
  const m = useMemo(() => new THREE.Matrix4(), [])
  const q = useMemo(() => new THREE.Quaternion(), [])
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    if (!shaft.current || !head.current) return
    items.forEach((it, i) => {
      const a = it.amp(ph.current)
      const len = Math.abs(a) * max
      v.set(...it.dir).multiplyScalar(Math.sign(a) || 1)
      q.setFromUnitVectors(up, v)
      const hl = Math.min(len * 0.45, max * 0.35)
      const sl = Math.max(0.0001, len - hl)
      const base = new THREE.Vector3(...it.p).addScaledVector(v, -len / 2)
      m.compose(base.clone().addScaledVector(v, sl / 2), q, new THREE.Vector3(1, sl, 1))
      shaft.current!.setMatrixAt(i, m)
      m.compose(base.clone().addScaledVector(v, sl + hl / 2), q, new THREE.Vector3(Math.max(0.0001, hl / (max * 0.35)), Math.max(0.0001, hl), Math.max(0.0001, hl / (max * 0.35))))
      head.current!.setMatrixAt(i, m)
    })
    shaft.current.instanceMatrix.needsUpdate = true
    head.current.instanceMatrix.needsUpdate = true
  })
  return (
    <group>
      <instancedMesh ref={shaft} args={[undefined, undefined, items.length]} renderOrder={20}>
        <cylinderGeometry args={[max * 0.045, max * 0.045, 1, 6]} />
        <meshBasicMaterial color={color} />
      </instancedMesh>
      <instancedMesh ref={head} args={[undefined, undefined, items.length]} renderOrder={20}>
        <coneGeometry args={[max * 0.14, 1, 10]} />
        <meshBasicMaterial color={color} />
      </instancedMesh>
    </group>
  )
}

/** A field line whose dashes march along it at speed(phase) and fade with weight(phase). */
function Flow({ pts, color, speed, weight, ph, width = 2 }: { pts: V3[]; color: string; speed: (ph: number) => number; weight: (ph: number) => number; ph: MutableRefObject<number>; width?: number }) {
  const ref = useRef<{ material: { dashOffset: number; opacity: number } } | null>(null)
  useFrame((_, dt) => {
    const mat = ref.current?.material
    if (!mat) return
    mat.dashOffset -= speed(ph.current) * dt * 6
    mat.opacity = 0.35 + 0.65 * Math.min(1, Math.abs(weight(ph.current)))
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <Line ref={ref as any} points={pts} color={color} lineWidth={width} dashed dashSize={1.4} gapSize={0.9} transparent renderOrder={20} />
}

function PhaseClock({ ph, playing, fixed }: { ph: MutableRefObject<number>; playing: boolean; fixed: number }) {
  useFrame((_, dt) => { if (playing) ph.current = (ph.current + dt * Math.PI * 0.55) % (Math.PI * 2); else ph.current = fixed })
  return null
}

function Fields({ d, show, style, amp, ph }: { d: Design; show: FieldKind[]; style: 'vectors' | 'lines'; amp: number; ph: MutableRefObject<number> }) {
  const H = d.h * THICK
  const { Ls, py } = frame(d)
  const yb = py - d.L / 2, L = d.L, a = FEED_W / 2 + SLOT
  const U = (y: number) => (y - yb) / L
  const xs = (n: number, m = 0.85) => Array.from({ length: n }, (_, i) => -d.W / 2 * m + (d.W * m * i) / (n - 1))
  const ys = (n: number, lo = 0.04, hi = 0.96) => Array.from({ length: n }, (_, i) => yb + L * (lo + ((hi - lo) * i) / (n - 1)))
  const c = Math.cos, s = Math.sin, PI = Math.PI
  const out: JSX.Element[] = []

  if (show.includes('E')) {
    if (style === 'vectors') {
      const items: Item[] = []
      for (const x of xs(5)) for (const y of ys(9)) { const u = U(y); items.push({ p: [x, y, H / 2], dir: [0, 0, 1], amp: (t) => amp * c(PI * u) * c(t) }) }
      // fringing at the two ends, pointing out of / into the patch edge
      for (const x of xs(5)) for (const [y0, sg] of [[yb, -1], [yb + L, 1]] as const) items.push({ p: [x, y0 + sg * 1.6, H + 0.4], dir: [0, sg, 0], amp: (t) => amp * (sg > 0 ? -1 : 1) * c(t) * 0.8 })
      out.push(<Arrows key="Ev" items={items} color={FIELD_COLORS.E} max={H * 0.8} ph={ph} />)
    } else {
      for (const x of xs(4)) {
        for (const y of ys(6, 0.03, 0.3).concat(ys(6, 0.7, 0.97))) {
          const u = U(y)
          out.push(<Flow key={`El${x}${y}`} pts={[[x, y, 0.05], [x, y, H]]} color={FIELD_COLORS.E} ph={ph} width={1.6} speed={(t) => c(PI * u) * c(t)} weight={(t) => c(PI * u) * c(t)} />)
        }
        for (const [ye, sg] of [[yb, -1], [yb + L, 1]] as const) {
          for (const r of [2, 4, 6.5]) {
            // from the patch edge, out through the air and back down to the ground beyond the edge
            const pts: V3[] = Array.from({ length: 17 }, (_, i) => { const th = (PI * i) / 16; return [x, ye + sg * r * s(th) * 1.1 + sg * r * 0.15 * (1 - c(th)), (H / 2) * (1 + c(th)) + 0.5 * r * s(th)] as V3 })
            out.push(<Flow key={`Ef${x}${ye}${r}`} pts={pts} color={FIELD_COLORS.E} ph={ph} width={1.6} speed={(t) => (sg > 0 ? -1 : 1) * c(t)} weight={(t) => c(t) * (1 - r / 10)} />)
          }
        }
      }
    }
  }

  if (show.includes('H')) {
    if (style === 'vectors') {
      const items: Item[] = []
      for (const x of xs(5)) for (const y of ys(9)) { const u = U(y); items.push({ p: [x, y, H / 2], dir: [1, 0, 0], amp: (t) => amp * s(PI * u) * s(t) }) }
      out.push(<Arrows key="Hv" items={items} color={FIELD_COLORS.H} max={3.2} ph={ph} />)
    } else {
      for (const y of ys(5, 0.2, 0.8)) {
        const u = U(y), w = d.W / 2 + 2, zt = H + 3, zb = H * 0.25
        const loop: V3[] = [[-w, y, zb], [w, y, zb], [w, y, zt], [-w, y, zt], [-w, y, zb]]
        out.push(<Flow key={`Hl${y}`} pts={loop} color={FIELD_COLORS.H} ph={ph} width={1.8} speed={(t) => s(PI * u) * s(t)} weight={(t) => s(PI * u) * s(t)} />)
      }
    }
  }

  if (show.includes('J')) {
    if (style === 'vectors') {
      const items: Item[] = []
      for (const x of xs(7, 0.9)) for (const y of ys(9)) {
        if (Math.abs(x) < a && y < yb + d.y0) continue
        const u = U(y); items.push({ p: [x, y, H + 0.5], dir: [0, 1, 0], amp: (t) => amp * s(PI * u) * s(t) })
      }
      for (const y of [-Ls / 2 + 3, -Ls / 2 + 7]) if (y < yb + d.y0) items.push({ p: [0, y, H + 0.5], dir: [0, 1, 0], amp: (t) => amp * 0.9 * s(t) })
      out.push(<Arrows key="Jv" items={items} color={FIELD_COLORS.J} max={3.4} ph={ph} />)
    } else {
      for (const x of xs(9, 0.92)) {
        const y0 = Math.abs(x) < a ? yb + d.y0 : yb
        const pts: V3[] = Array.from({ length: 12 }, (_, i) => [x, y0 + ((yb + L - y0) * i) / 11, H + 0.3] as V3)
        out.push(<Flow key={`Jl${x}`} pts={pts} color={FIELD_COLORS.J} ph={ph} width={2.4} speed={(t) => s(t)} weight={(t) => s(t) * (Math.abs(x) < a ? 1 : 0.85)} />)
      }
      out.push(<Flow key="Jfeed" pts={[[0, -Ls / 2, H + 0.3], [0, yb + d.y0, H + 0.3]]} color={FIELD_COLORS.J} ph={ph} width={3} speed={(t) => s(t)} weight={(t) => s(t)} />)
    }
  }

  if (show.includes('S')) {
    if (style === 'vectors') {
      const inside: Item[] = []
      for (const x of xs(3)) for (const y of ys(9)) { const u = U(y); inside.push({ p: [x, y, H / 2], dir: [0, 1, 0], amp: (t) => amp * amp * s(2 * PI * u) * s(2 * t) * 0.5 }) }
      const outside: Item[] = []
      for (const x of xs(5)) for (const [ye, sg] of [[yb, -1], [yb + L, 1]] as const) for (const k of [0, 1, 2]) {
        const tilt = 0.25 + 0.35 * k
        const n = Math.hypot(tilt, 1)
        outside.push({ p: [x, ye + sg * (1 + k * 2.5), H + 3 + k * 2.5], dir: [0, (sg * tilt) / n, 1 / n], amp: (t) => amp * amp * (0.75 + 0.25 * c(2 * t)) })
      }
      out.push(<Arrows key="Sv1" items={inside} color={FIELD_COLORS.S} max={3} ph={ph} />)
      out.push(<Arrows key="Sv2" items={outside} color={FIELD_COLORS.S} max={4.2} ph={ph} />)
    } else {
      for (const x of xs(4)) for (const [ye, sg] of [[yb, -1], [yb + L, 1]] as const) for (const k of [0, 1, 2]) {
        const pts: V3[] = Array.from({ length: 14 }, (_, i) => { const t = i / 13; return [x, ye + sg * (0.5 + t * (3 + k * 4)), H + 0.4 + t * (16 - k * 3)] as V3 })
        out.push(<Flow key={`Sl${x}${ye}${k}`} pts={pts} color={FIELD_COLORS.S} ph={ph} width={2} speed={() => amp * amp * 1.2} weight={() => amp * amp} />)
      }
    }
  }
  return <group>{out}</group>
}

export function FieldsScene({ d, show, style, amp, playing, phase, ph }: { d: Design; show: FieldKind[]; style: 'vectors' | 'lines'; amp: number; playing: boolean; phase: number; ph: MutableRefObject<number> }) {
  const disp = useMemo(() => ({ ...d, h: d.h * THICK }), [d])
  useLayoutEffect(() => { if (!playing) ph.current = phase }, [phase, playing, ph])
  return (
    <Scene3D d={disp} bt={99} current={0} pulse={0} labels={false} fixes={false} spin={false} ghost cam={[70, -112, 92]}>
      <PhaseClock ph={ph} playing={playing} fixed={phase} />
      <Fields d={d} show={show} style={style} amp={amp} ph={ph} />
    </Scene3D>
  )
}

