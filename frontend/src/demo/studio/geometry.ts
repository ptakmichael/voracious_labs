import type { ArrayDesign } from '../arrayModel'
import { type Design, FEED_W, SUBSTRATE } from '../model'
import { MATERIALS, type Obj, type V3 } from '../modeler/model'

/** Parametric geometry: design variables → modeler objects. The modeler stays general; these are just templates. */

let n = 1
const o = (name: string, kind: Obj['kind'], plane: Obj['plane'], pos: V3, size: V3, material: string, port?: Obj['port']): Obj =>
  ({ id: `g${n++}`, name, kind, plane, pos, size, material, visible: true, ...(port ? { port } : {}) })

const boardMat = (er: number) => Object.entries(MATERIALS).find(([, m]) => !m.metal && Math.abs(m.eps - er) < 0.05)?.[0] ?? (er > 8 ? 'Rogers 6010.2LM' : 'FR-4')

export function patchObjs(d: Design): Obj[] {
  const Ws = SUBSTRATE.wid * d.gs, Ls = SUBSTRATE.len * d.gs
  const yb = -Ls / 2 + SUBSTRATE.feedGap * d.gs
  return [
    o('Substrate', 'box', 'xy', [-Ws / 2, -Ls / 2, 0], [Ws, Ls, d.h], boardMat(d.er)),
    o('Ground', 'rect', 'xy', [-Ws / 2, -Ls / 2, 0], [Ws, Ls, 0], 'copper'),
    o('Patch', 'rect', 'xy', [-d.W / 2, yb, d.h], [d.W, d.L, 0], 'copper'),
    o('Feed', 'rect', 'xy', [-FEED_W / 2, -Ls / 2, d.h], [FEED_W, yb + Ls / 2 + d.y0, 0], 'copper'),
    o('Port1', 'rect', 'xz', [-FEED_W * 1.5, -Ls / 2, 0], [FEED_W * 3, 0, d.h], 'PEC', { z0: 50, n: 1 }),
  ]
}

const FEED_A = 1.1 // mm, the array element's 50 Ω line on 1.27 mm εr 10.2

export function arrayObjs(el: Design, a: ArrayDesign): Obj[] {
  const bw = a.nx * a.dx + 30, bh = a.ny * a.dy + 30
  const out = [
    o('Substrate', 'box', 'xy', [-bw / 2, -bh / 2, 0], [bw, bh, el.h], boardMat(el.er)),
    o('Ground', 'rect', 'xy', [-bw / 2, -bh / 2, 0], [bw, bh, 0], 'copper'),
  ]
  let k = 1
  for (let j = 0; j < a.ny; j++) for (let i = 0; i < a.nx; i++, k++) {
    const cx = (i - (a.nx - 1) / 2) * a.dx, cy = (j - (a.ny - 1) / 2) * a.dy
    const y0 = cy - el.L / 2, feedLen = Math.min(8, a.dy / 2 - el.L / 2 - 1)
    const off = a.failed.includes(k - 1)
    out.push(o(`Patch${k}`, 'rect', 'xy', [cx - el.W / 2, y0, el.h], [el.W, el.L, 0], off ? 'PEC' : 'copper'))
    out.push(o(`Feed${k}`, 'rect', 'xy', [cx - FEED_A / 2, y0 - feedLen, el.h], [FEED_A, feedLen + el.y0, 0], 'copper'))
    out.push(o(`Port${k}`, 'rect', 'xz', [cx - FEED_A * 1.5, y0 - feedLen, 0], [FEED_A * 3, 0, el.h], 'PEC', { z0: 50, n: k }))
  }
  return out
}
