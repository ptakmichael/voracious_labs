import { Html, Line } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { type BaseKey, type Param } from './effects'
import { FEED_W, type Design, excitation } from './model'
import { SLOT, Scene3D, frame } from './Scene3D'

type V3 = [number, number, number]
interface Dim { a: V3; b: V3; ext: [V3, V3][]; side: 'l' | 'r' | 'c' | 'b'; at?: V3 }

const UP = [207, 69, 32], DOWN = [44, 74, 114], WEAK = [181, 174, 159]
/** Colour for an effect: grey when it barely matters, vermilion when it pushes the metric up, blue when down. */
export function effectColor(v: number, strength: number) {
  const t = Math.min(1, Math.max(0, strength)) ** 0.7
  const to = v >= 0 ? UP : DOWN
  return `rgb(${WEAK.map((w, i) => Math.round(w + (to[i] - w) * t)).join(',')})`
}

/** Where each built-in parameter is drawn, as a dimension line in the board frame (mm). */
function dims(d: Design): Record<BaseKey, Dim> {
  const { Ls, Ws, py } = frame(d)
  const yb = py - d.L / 2, yt = py + d.L / 2, a = FEED_W / 2 + SLOT, z = d.h + 0.4
  const xL = d.W / 2 + 2.6, yW = yt + 3, xY = -a - 2.2, xG = -Ws / 2 - 4
  return {
    L: { a: [xL, yb, z], b: [xL, yt, z], ext: [[[d.W / 2, yb, z], [xL + 1, yb, z]], [[d.W / 2, yt, z], [xL + 1, yt, z]]], side: 'r' },
    W: { a: [-d.W / 2, yW, z], b: [d.W / 2, yW, z], ext: [[[-d.W / 2, yt, z], [-d.W / 2, yW + 1, z]], [[d.W / 2, yt, z], [d.W / 2, yW + 1, z]]], side: 'c' },
    y0: { a: [xY, yb, z], b: [xY, yb + d.y0, z], ext: [[[-a, yb + d.y0, z], [xY - 1, yb + d.y0, z]]], side: 'l' },
    h: { a: [-Ws / 2 - 1.5, -Ls / 2, 0], b: [-Ws / 2 - 1.5, -Ls / 2, d.h], ext: [], side: 'l', at: [-Ws / 2 - 2, -Ls / 2, d.h / 2] },
    er: { a: [Ws / 2, -Ls / 4, d.h / 2], b: [Ws / 2 + 5, -Ls / 4, d.h / 2], ext: [], side: 'r', at: [Ws / 2 + 5, -Ls / 4, d.h / 2] },
    gs: { a: [xG, -Ls / 2, 0], b: [xG, Ls / 2, 0], ext: [[[-Ws / 2, -Ls / 2, 0], [xG - 1, -Ls / 2, 0]], [[-Ws / 2, Ls / 2, 0], [xG - 1, Ls / 2, 0]]], side: 'l' },
  }
}

const shift = (p: V3, o: V3): V3 => [p[0] + o[0], p[1] + o[1], p[2] + o[2]]

export interface DimInfo { p: Param; v: number; strength: number; text: string }

function DimLine({ dim, info, on, hot, onPick, onHover, offset }: { dim: Dim; info: DimInfo; on: boolean; hot: boolean; onPick: () => void; onHover: (h: boolean) => void; offset?: V3 }) {
  const o = offset ?? [0, 0, 0]
  const a = shift(dim.a, o), b = shift(dim.b, o)
  const col = effectColor(info.v, info.strength)
  const w = 1.4 + 3.6 * info.strength + (on || hot ? 1.5 : 0)
  const mid: V3 = dim.at ? shift(dim.at, o) : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  const tick = (p: V3): [V3, V3] => dim.side === 'c' || dim.side === 'b' ? [[p[0], p[1] - 1, p[2]], [p[0], p[1] + 1, p[2]]] : [[p[0] - 1, p[1], p[2]], [p[0] + 1, p[1], p[2]]]
  return (
    <group>
      <Line points={[a, b]} color={col} lineWidth={w} dashed={!!offset} dashSize={1.2} gapSize={0.7} />
      {!dim.at && [a, b].map((p, i) => <Line key={i} points={tick(p)} color={col} lineWidth={w} />)}
      {dim.ext.map(([p, q], i) => <Line key={`e${i}`} points={[shift(p, o), shift(q, o)]} color={col} lineWidth={1} transparent opacity={0.6} />)}
      <Html position={mid} zIndexRange={[on || hot ? 30 : 10, 0]}>
        <button className={`dim ${dim.side}${offset ? ' sub' : ''}${on ? ' on' : ''}${hot ? ' hot' : ''}`} style={{ '--c': col } as React.CSSProperties}
          onClick={onPick} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
          <span>{info.p.name}</span><b>{info.text}</b>
        </button>
      </Html>
    </group>
  )
}

/** Charge (edges) and current (middle) on the patch at one frequency, as a smooth wash. */
function Fields({ d, f }: { d: Design; f: number }) {
  const canvas = useMemo(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 128; return c }, [])
  const tex = useMemo(() => { const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; return t }, [canvas])
  const amp = excitation(f, d)
  useEffect(() => {
    const g = canvas.getContext('2d')!
    const img = g.createImageData(64, 128)
    for (let j = 0; j < 128; j++) {
      const u = 1 - j / 127 // 0 at the feed edge, 1 at the far edge
      const e = Math.cos(Math.PI * u) ** 2, m = Math.sin(Math.PI * u) ** 2
      for (let i = 0; i < 64; i++) {
        const o = (j * 64 + i) * 4
        const c = e > m ? DOWN : UP
        const k = Math.abs(e - m) * amp
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = Math.round(235 * k ** 0.8)
      }
    }
    g.putImageData(img, 0, 0)
    tex.needsUpdate = true
  }, [canvas, tex, amp])
  const { py } = frame(d)
  const z = d.h + 0.35
  return (
    <group>
      <mesh position={[0, py, z]} renderOrder={10}>
        <planeGeometry args={[d.W, d.L]} />
        <meshBasicMaterial map={tex} transparent depthWrite={false} />
      </mesh>
      <Html position={[0, py + d.L / 2, z]} zIndexRange={[20, 0]}>
        <div className="fcall cap c">charge piles up at the ends<b>acts like a capacitor</b></div>
      </Html>
      <Html position={[0, py, z]} center zIndexRange={[20, 0]}>
        <div className="fcall ind">current flows through the middle<b>acts like an inductor</b></div>
      </Html>
    </group>
  )
}

export function EffectScene({ d, view, f, infos, sel, hover, onPick, onHover }: {
  d: Design; view: 'effects' | 'fields'; f: number; infos: DimInfo[]; sel: string | null; hover: string | null
  onPick: (id: string) => void; onHover: (id: string | null) => void
}) {
  const all = dims(d)
  // custom parameters sit beside the first base dimension they move, dashed, stacked outward
  const seen: Partial<Record<BaseKey, number>> = {}
  return (
    <Scene3D d={d} bt={99} current={0} pulse={0} labels={false} fixes={false} spin={false} cam={[16, -74, 150]}>
      {view === 'fields' ? <Fields d={d} f={f} /> : infos.map((info) => {
        const key = (info.p.custom ? info.p.custom.free[0] : info.p.id) as BaseKey
        const dim = all[key]
        if (!dim) return null
        let offset: V3 | undefined
        if (info.p.custom) {
          const n = (seen[key] = (seen[key] ?? 0) + 1)
          const s = 3.2 * n
          offset = dim.side === 'r' ? [s, 0, 0.3] : dim.side === 'l' ? [-s, 0, 0.3] : [0, s, 0.3]
        }
        return <DimLine key={info.p.id} dim={dim} info={info} on={sel === info.p.id} hot={hover === info.p.id} offset={offset}
          onPick={() => onPick(info.p.id)} onHover={(h) => onHover(h ? info.p.id : null)} />
      })}
    </Scene3D>
  )
}
