import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { E, FIELD_INFO, H, J, S, turbo, type FieldKind, type PatchGeo, type V3 } from './fields'

export type PlaneKind = 'xy_sub' | 'xy_above' | 'xz' | 'yz'

export const PLANE_LABEL: Record<PlaneKind, string> = {
  xy_sub: 'XY · mid-substrate',
  xy_above: 'XY · above patch',
  xz: 'XZ · through feed (y = feed)',
  yz: 'YZ · patch centre (x = 0)',
}

export const DEFAULT_PLANE: Record<FieldKind, PlaneKind> = { E: 'xy_sub', H: 'yz', S: 'xz', J: 'xy_sub' }

// Full-scale values for the colour bar (normalised units, 1 W input, mode amplitude 1 at resonance)
const FULL: Record<FieldKind, number> = { E: 1.2, H: 1.0, S: 0.9, J: 1.2 }

interface SliceSpec {
  origin: THREE.Vector3
  u: THREE.Vector3
  v: THREE.Vector3
  uLen: number
  vLen: number
  fn: (p: THREE.Vector3) => V3 | null
}

let arrowGeo: THREE.BufferGeometry | null = null
function getArrowGeo() {
  if (arrowGeo) return arrowGeo
  const shaft = new THREE.CylinderGeometry(0.07, 0.07, 0.62, 8).translate(0, 0.31, 0)
  const head = new THREE.ConeGeometry(0.2, 0.38, 12).translate(0, 0.81, 0)
  arrowGeo = mergeGeometries([shaft, head])!
  return arrowGeo
}

const Y_UP = new THREE.Vector3(0, 1, 0)

/** One sampled surface: colour texture + arrow glyphs. Phase factor is applied per frame without re-sampling. */
function FieldSlice({ spec, kind, amp, showMag, showVec, phase, nu = 150, arrows = 24 }: {
  spec: SliceSpec; kind: FieldKind; amp: number; showMag: boolean; showVec: boolean
  phase: React.MutableRefObject<number>; nu?: number; arrows?: number
}) {
  const nv = Math.max(8, Math.round((nu * spec.vLen) / spec.uLen))
  const na = arrows
  const nb = Math.max(4, Math.round((na * spec.vLen) / spec.uLen))
  const scale = FULL[kind]
  const sqrt = true // √ scale keeps weak fringing fields visible next to the cavity peak
  const ampK = kind === 'S' ? amp * amp : amp

  // Sample magnitudes on the texture grid (phasor amplitude, before the time factor)
  const { mags, mask } = useMemo(() => {
    const mags = new Float32Array(nu * nv)
    const mask = new Uint8Array(nu * nv)
    const p = new THREE.Vector3()
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        p.copy(spec.origin).addScaledVector(spec.u, ((i + 0.5) / nu) * spec.uLen).addScaledVector(spec.v, ((j + 0.5) / nv) * spec.vLen)
        const f = spec.fn(p)
        if (f) { mags[j * nu + i] = Math.hypot(...f) * ampK; mask[j * nu + i] = 1 }
      }
    }
    return { mags, mask }
  }, [spec, nu, nv, ampK])

  // Arrow positions and phasor vectors
  const arrowData = useMemo(() => {
    const pos: THREE.Vector3[] = []
    const vec: THREE.Vector3[] = []
    for (let j = 0; j < nb; j++) {
      for (let i = 0; i < na; i++) {
        const p = spec.origin.clone().addScaledVector(spec.u, ((i + 0.5) / na) * spec.uLen).addScaledVector(spec.v, ((j + 0.5) / nb) * spec.vLen)
        const f = spec.fn(p)
        if (!f) continue
        pos.push(p)
        vec.push(new THREE.Vector3(...f).multiplyScalar(ampK))
      }
    }
    return { pos, vec }
  }, [spec, na, nb, ampK])

  const tex = useMemo(() => {
    const t = new THREE.DataTexture(new Uint8Array(nu * nv * 4), nu, nv, THREE.RGBAFormat)
    t.magFilter = THREE.LinearFilter
    t.minFilter = THREE.LinearFilter
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [nu, nv])
  useEffect(() => () => tex.dispose(), [tex])

  const inst = useRef<THREE.InstancedMesh>(null)
  const cell = spec.uLen / na
  const lastFactor = useRef<number | null>(null)

  const paint = (factor: number) => {
    const data = tex.image.data as Uint8Array
    const k = Math.abs(factor)
    for (let n = 0; n < mags.length; n++) {
      let t = (mags[n] * k) / scale
      if (sqrt) t = Math.sqrt(t)
      const [r, g, b] = turbo(t)
      data[4 * n] = r; data[4 * n + 1] = g; data[4 * n + 2] = b
      data[4 * n + 3] = mask[n] ? 225 : 0
    }
    tex.needsUpdate = true
    const im = inst.current
    if (!im) return
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), d = new THREE.Vector3(), c = new THREE.Color()
    arrowData.pos.forEach((p, idx) => {
      d.copy(arrowData.vec[idx]).multiplyScalar(factor)
      const mag = d.length()
      let t = mag / scale
      if (sqrt) t = Math.sqrt(t)
      const len = cell * 0.95 * Math.min(1, Math.sqrt(t))
      if (mag < 1e-4 || len < cell * 0.08) {
        m.makeScale(0, 0, 0)
      } else {
        q.setFromUnitVectors(Y_UP, d.normalize())
        s.set(cell * 0.55, len, cell * 0.55)
        m.compose(p, q, s)
      }
      im.setMatrixAt(idx, m)
      if (showMag) c.set('#ffffff')
      else c.setRGB(...(turbo(t).map((v) => v / 255) as [number, number, number])).convertSRGBToLinear()
      im.setColorAt(idx, c)
    })
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
  }

  useLayoutEffect(() => { lastFactor.current = null }, [mags, arrowData, showMag, showVec])
  useFrame(() => {
    const f = phase.current
    if (lastFactor.current !== null && Math.abs(f - lastFactor.current) < 1e-3) return
    lastFactor.current = f
    paint(f)
  })

  const quat = useMemo(() => {
    const n = new THREE.Vector3().crossVectors(spec.u, spec.v).normalize()
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(spec.u, spec.v, n))
  }, [spec])
  const center = useMemo(() => spec.origin.clone().addScaledVector(spec.u, spec.uLen / 2).addScaledVector(spec.v, spec.vLen / 2), [spec])

  return (
    <group>
      {showMag && (
        <mesh position={center} quaternion={quat} renderOrder={5}>
          <planeGeometry args={[spec.uLen, spec.vLen]} />
          <meshBasicMaterial map={tex} transparent side={THREE.DoubleSide} depthWrite={false} toneMapped={false} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
        </mesh>
      )}
      {showVec && arrowData.pos.length > 0 && (
        <instancedMesh key={arrowData.pos.length} ref={inst} args={[getArrowGeo(), undefined, arrowData.pos.length]} renderOrder={6}>
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
      )}
    </group>
  )
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

export function FieldOverlay({ g, kind, plane, amp, showMag, showVec, animate }: {
  g: PatchGeo; kind: FieldKind; plane: PlaneKind; amp: number; showMag: boolean; showVec: boolean; animate: boolean
}) {
  const phase = useRef(1)
  const t0 = useRef(performance.now())
  const mode = FIELD_INFO[kind].phase
  useFrame(() => {
    if (mode === 'avg' || !animate) { phase.current = 1; return }
    const w = ((performance.now() - t0.current) / 1000) * Math.PI * 0.9 // ~0.45 Hz visual cycle
    phase.current = mode === 'cos' ? Math.cos(w) : Math.sin(w)
  })

  const specs: SliceSpec[] = useMemo(() => {
    const spanX = g.gx[1] - g.gx[0], spanY = g.gy[1] - g.gy[0]
    const mx = 0.12 * spanX, my = 0.12 * spanY
    const x0 = g.gx[0] - mx, x1 = g.gx[1] + mx, y0 = g.gy[0] - my, y1 = g.gy[1] + my
    const big = Math.max(g.L, g.W)
    if (kind === 'J') {
      const pz = g.z0 + g.h + 0.12, gz = g.z0 + 0.12
      return [
        { origin: V(g.cx - g.L / 2, g.cy - g.W / 2, pz), u: V(1, 0, 0), v: V(0, 1, 0), uLen: g.L, vLen: g.W, fn: (p) => J(g, p.x, p.y, 'patch') },
        { origin: V(g.gx[0], g.gy[0], gz), u: V(1, 0, 0), v: V(0, 1, 0), uLen: spanX, vLen: spanY, fn: (p) => J(g, p.x, p.y, 'ground') },
      ]
    }
    const fn = kind === 'E' ? (p: THREE.Vector3) => E(g, p.x, p.y, p.z)
      : kind === 'H' ? (p: THREE.Vector3) => H(g, p.x, p.y, p.z)
        : (p: THREE.Vector3) => S(g, p.x, p.y, p.z)
    const top = kind === 'S' ? 1.1 * big : Math.max(10 * g.h, 0.3 * big)
    const zb = g.z0 - 0.15 * top
    switch (plane) {
      case 'xy_sub': return [{ origin: V(x0, y0, g.z0 + g.h / 2), u: V(1, 0, 0), v: V(0, 1, 0), uLen: x1 - x0, vLen: y1 - y0, fn }]
      case 'xy_above': {
        const z = g.z0 + g.h + (kind === 'S' ? 0.4 * big : 1.5 * g.h)
        return [{ origin: V(x0, y0, z), u: V(1, 0, 0), v: V(0, 1, 0), uLen: x1 - x0, vLen: y1 - y0, fn }]
      }
      case 'xz': return [{ origin: V(x0, g.cy + g.fy, zb), u: V(1, 0, 0), v: V(0, 0, 1), uLen: x1 - x0, vLen: top - (zb - g.z0), fn }]
      case 'yz': return [{ origin: V(g.cx, y0, zb), u: V(0, 1, 0), v: V(0, 0, 1), uLen: y1 - y0, vLen: top - (zb - g.z0), fn }]
    }
  }, [g, kind, plane])

  return (
    <group>
      {specs.map((s, i) => (
        <FieldSlice key={`${kind}-${plane}-${i}`} spec={s} kind={kind} amp={amp} showMag={showMag} showVec={showVec} phase={phase}
          arrows={kind === 'J' ? (i === 0 ? 16 : 24) : 26} />
      ))}
    </group>
  )
}
