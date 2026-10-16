import { create } from 'zustand'
import { type Design, FEED_W, SUBSTRATE, fromEquations, target } from '../model'

/**
 * The CAD modeler's data. Every object is axis-aligned and described by its bounding box (`pos` = min corner,
 * `size` in mm). Sheets have zero size along their normal; cylinders and circles are round in their plane and
 * extruded along its normal. Simple on purpose: it covers what planar antennas are made of.
 */

export type V3 = [number, number, number]
export type Kind = 'box' | 'cyl' | 'rect' | 'circle'
export type Plane = 'xy' | 'xz' | 'yz'
export type Tool = 'select' | 'box' | 'cyl' | 'rect' | 'circle' | 'port'

export interface Obj {
  id: string
  name: string
  kind: Kind
  plane: Plane // sheets: the plane they lie in; solids: the plane their base was drawn in
  pos: V3
  size: V3
  material: string
  port?: { z0: number; n: number }
  visible: boolean
}

export interface Mat { eps: number; tand: number; metal: boolean; color: string }
export const MATERIALS: Record<string, Mat> = {
  vacuum: { eps: 1, tand: 0, metal: false, color: '#c9d3df' },
  'FR-4': { eps: 4.4, tand: 0.02, metal: false, color: '#a9b48f' },
  'Rogers RO4003C': { eps: 3.55, tand: 0.0027, metal: false, color: '#9fb3c8' },
  'Rogers RT5880': { eps: 2.2, tand: 0.0009, metal: false, color: '#d2c6a2' },
  'Rogers 6010.2LM': { eps: 10.2, tand: 0.0023, metal: false, color: '#b9a98a' },
  copper: { eps: 1, tand: 0, metal: true, color: '#c07a36' },
  PEC: { eps: 1, tand: 0, metal: true, color: '#8d8a83' },
}

export const AXIS: Record<Plane, 0 | 1 | 2> = { xy: 2, xz: 1, yz: 0 } // normal axis of each plane
export const inPlane = (p: Plane): [0 | 1 | 2, 0 | 1 | 2] => (p === 'xy' ? [0, 1] : p === 'xz' ? [0, 2] : [1, 2])
export const isSheet = (o: Obj) => o.kind === 'rect' || o.kind === 'circle'
export const maxOf = (o: Obj): V3 => [o.pos[0] + o.size[0], o.pos[1] + o.size[1], o.pos[2] + o.size[2]]
export const centerOf = (o: Obj): V3 => [o.pos[0] + o.size[0] / 2, o.pos[1] + o.size[1] / 2, o.pos[2] + o.size[2] / 2]
const r3 = (v: number) => Math.round(v * 1000) / 1000

export type SnapKind = 'vertex' | 'mid' | 'center' | 'grid'
export interface SnapPt { p: V3; kind: SnapKind; of?: string }

/** Points an object offers to snap to: corners, edge midpoints, face centres (round shapes: rim quadrants and centres). */
export function snapPoints(objs: Obj[]): SnapPt[] {
  const out: SnapPt[] = []
  for (const o of objs) {
    if (!o.visible) continue
    const a = o.pos, b = maxOf(o)
    const xs = [a[0], b[0]], ys = [a[1], b[1]], zs = [a[2], b[2]]
    const c = centerOf(o)
    if (o.kind === 'cyl' || o.kind === 'circle') {
      const n = AXIS[o.plane], [u, v] = inPlane(o.plane)
      for (const end of n === 0 ? xs : n === 1 ? ys : zs) {
        const cc: V3 = [...c] as V3; cc[n] = end
        out.push({ p: cc, kind: 'center', of: o.name })
        for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const q: V3 = [...cc] as V3; q[u] += (du * o.size[u]) / 2; q[v] += (dv * o.size[v]) / 2
          out.push({ p: q, kind: 'vertex', of: o.name })
        }
      }
      continue
    }
    for (const x of xs) for (const y of ys) for (const z of zs) out.push({ p: [x, y, z], kind: 'vertex', of: o.name })
    // edge midpoints and face centres
    for (const ax of [0, 1, 2] as const) {
      const others = ([0, 1, 2] as const).filter((k) => k !== ax)
      for (const e0 of [a[others[0]], b[others[0]]]) for (const e1 of [a[others[1]], b[others[1]]]) {
        if (o.size[ax] === 0) continue
        const q: V3 = [0, 0, 0]; q[ax] = c[ax]; q[others[0]] = e0; q[others[1]] = e1
        out.push({ p: q, kind: 'mid', of: o.name })
      }
      for (const end of [a[ax], b[ax]]) { const q: V3 = [...c] as V3; q[ax] = end; out.push({ p: q, kind: 'center', of: o.name }) }
    }
  }
  return out
}

export interface Msg { id: number; kind: 'info' | 'ok' | 'warn' | 'err'; text: string }
export interface Draft { tool: Tool; plane: Plane; off: number; p1: V3; p2?: V3; h?: number }

interface State {
  project: string
  design: string
  objs: Obj[]
  sel: string | null
  tool: Tool
  plane: Plane
  grid: number
  snap: { grid: boolean; vertex: boolean; mid: boolean; center: boolean }
  material: string // material for the next object drawn
  cursor: V3 | null
  planeOff: number // where the drawing plane sits along its normal (follows a hovered face)
  hit: SnapPt | null
  draft: Draft | null
  msgs: Msg[]
  past: Obj[][]
  future: Obj[][]
  counters: Record<string, number>
  showRad: boolean
  view: { name: 'iso' | 'top' | 'front' | 'fit'; nonce: number }
}

interface Actions {
  add: (o: Omit<Obj, 'id' | 'name' | 'visible'> & { name?: string }) => Obj
  update: (id: string, p: Partial<Obj>, commit?: boolean) => void
  commit: () => void
  remove: (id: string) => void
  duplicate: (id: string) => void
  select: (id: string | null) => void
  setTool: (t: Tool) => void
  setPlane: (p: Plane) => void
  undo: () => void
  redo: () => void
  log: (kind: Msg['kind'], text: string) => void
  insertPatch: () => void
  setView: (name: State['view']['name']) => void
  set: (p: Partial<State>) => void
  clear: () => void
  load: (objs: Obj[], project?: string) => void
}

let mid = 1
const BASE: Record<string, string> = { box: 'Box', cyl: 'Cylinder', rect: 'Rectangle', circle: 'Circle', port: 'Port' }

export const useModel = create<State & Actions>((set, get) => {
  const snapshot = () => set((s) => ({ past: [...s.past.slice(-60), s.objs], future: [] }))
  return {
    project: 'Project1', design: 'Design1',
    objs: [], sel: null, tool: 'select', plane: 'xy', grid: 0.5,
    snap: { grid: true, vertex: true, mid: true, center: true }, material: 'FR-4',
    cursor: null, planeOff: 0, hit: null, draft: null, msgs: [{ id: 0, kind: 'info', text: 'New design. Pick a tool above (or press B for a box) and click on the grid to start drawing.' }],
    past: [], future: [], counters: {}, showRad: false, view: { name: 'iso', nonce: 0 },

    add: (o) => {
      snapshot()
      const isPort = !!o.port
      const base = o.name ?? (isPort ? 'Port' : BASE[o.kind])
      const n = (get().counters[base] ?? 0) + 1
      const obj: Obj = { ...o, id: `o${mid++}`, name: o.name ?? `${base}${n}`, visible: true, pos: o.pos.map(r3) as V3, size: o.size.map(r3) as V3 }
      set((s) => ({ objs: [...s.objs, obj], sel: obj.id, counters: { ...s.counters, [base]: n } }))
      return obj
    },
    update: (id, p, commit = true) => {
      if (commit) snapshot()
      set((s) => ({ objs: s.objs.map((o) => (o.id === id ? { ...o, ...p } : o)) }))
    },
    commit: snapshot,
    remove: (id) => { snapshot(); set((s) => ({ objs: s.objs.filter((o) => o.id !== id), sel: s.sel === id ? null : s.sel })) },
    duplicate: (id) => {
      const o = get().objs.find((x) => x.id === id)
      if (!o) return
      const shift: V3 = [0, 0, 0]; shift[inPlane(o.plane)[0]] = o.size[inPlane(o.plane)[0]] + 2
      get().add({ kind: o.kind, plane: o.plane, pos: o.pos.map((v, i) => v + shift[i]) as V3, size: o.size, material: o.material, port: o.port ? { ...o.port, n: get().objs.filter((x) => x.port).length + 1 } : undefined })
    },
    select: (sel) => set({ sel }),
    setTool: (tool) => set({ tool, draft: null }),
    setPlane: (plane) => set({ plane, draft: null }),
    undo: () => { const s = get(); if (!s.past.length) return; set({ objs: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.objs, ...s.future], sel: null }) },
    redo: () => { const s = get(); if (!s.future.length) return; set({ objs: s.future[0], future: s.future.slice(1), past: [...s.past, s.objs], sel: null }) },
    log: (kind, text) => set((s) => ({ msgs: [...s.msgs.slice(-40), { id: Date.now() + Math.random(), kind, text }] })),
    setView: (name) => set((s) => ({ view: { name, nonce: s.view.nonce + 1 } })),
    set: (p) => set(p),
    clear: () => { set({ objs: [], sel: null, draft: null, past: [], future: [], counters: {}, tool: 'select', msgs: [{ id: Date.now(), kind: 'info', text: 'New design. Pick a tool above (or press B for a box) and click on the grid to start drawing.' }] }); get().setView('iso') },
    load: (objs, project) => {
      const counters: Record<string, number> = {}
      for (const o of objs) { const m = /^(\D+?)(\d+)$/.exec(o.name); if (m) counters[m[1]] = Math.max(counters[m[1]] ?? 0, +m[2]) }
      mid = Math.max(mid, ...objs.map((o) => +o.id.replace(/\D/g, '') + 1 || 0))
      set({ objs, sel: null, draft: null, past: [], future: [], counters, project: project ?? get().project, tool: 'select' })
      get().log('ok', `Opened ${objs.length} objects.`)
      get().setView('fit')
    },

    insertPatch: () => {
      const d = fromEquations()
      const Ws = SUBSTRATE.wid * d.gs, Ls = SUBSTRATE.len * d.gs
      const yb = -Ls / 2 + SUBSTRATE.feedGap * d.gs
      const add = get().add
      add({ name: 'Substrate', kind: 'box', plane: 'xy', pos: [-Ws / 2, -Ls / 2, 0], size: [Ws, Ls, d.h], material: 'FR-4' })
      add({ name: 'Ground', kind: 'rect', plane: 'xy', pos: [-Ws / 2, -Ls / 2, 0], size: [Ws, Ls, 0], material: 'copper' })
      add({ name: 'Patch', kind: 'rect', plane: 'xy', pos: [-d.W / 2, yb, d.h], size: [d.W, d.L, 0], material: 'copper' })
      add({ name: 'Feed', kind: 'rect', plane: 'xy', pos: [-FEED_W / 2, -Ls / 2, d.h], size: [FEED_W, yb - -Ls / 2 + d.y0, 0], material: 'copper' })
      add({ name: 'Port1', kind: 'rect', plane: 'xz', pos: [-FEED_W * 1.5, -Ls / 2, 0], size: [FEED_W * 3, 0, d.h], material: 'PEC', port: { z0: 50, n: 1 } })
      set({ sel: null, tool: 'select' })
      get().setView('fit')
      get().log('ok', `Inserted a parametric inset-fed patch for 2.44 GHz on ${d.h} mm FR-4: patch ${d.W.toFixed(2)} × ${d.L.toFixed(2)} mm, feed inset ${d.y0.toFixed(2)} mm, 50 Ω port. Every piece is an ordinary object you can edit.`)
    },
  }
})

// ---------------------------------------------------------------- checks and hand-off to the solver

export interface Check { kind: 'ok' | 'warn' | 'err'; text: string }

export function validate(objs: Obj[]): Check[] {
  const out: Check[] = []
  const vis = objs.filter((o) => o.visible)
  if (!vis.length) return [{ kind: 'err', text: 'The model is empty.' }]
  const ports = vis.filter((o) => o.port)
  if (!ports.length) out.push({ kind: 'err', text: 'No port. Draw one with the Port tool (P) across the end of the feed line.' })
  for (const p of ports) {
    const touches = vis.some((o) => !o.port && MATERIALS[o.material]?.metal && overlaps(o, p, 0.05))
    out.push(touches ? { kind: 'ok', text: `${p.name}: ${p.port!.z0} Ω, touches metal.` } : { kind: 'warn', text: `${p.name} doesn't touch any metal, so it has nothing to excite.` })
  }
  const solids = vis.filter((o) => !isSheet(o))
  for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
    if (overlaps(solids[i], solids[j], -0.01)) out.push({ kind: 'warn', text: `${solids[i].name} and ${solids[j].name} overlap; the later one wins where they do.` })
  }
  out.push({ kind: 'ok', text: 'Radiation boundary: automatic, λ/4 at the lowest frequency from every side.' })
  if (!out.some((c) => c.kind === 'err')) out.unshift({ kind: 'ok', text: `Validation passed: ${vis.length} objects, ${ports.length} port${ports.length === 1 ? '' : 's'}.` })
  return out
}

function overlaps(a: Obj, b: Obj, tol: number) {
  const A = maxOf(a), B = maxOf(b)
  return [0, 1, 2].every((k) => a.pos[k] <= B[k] + tol && b.pos[k] <= A[k] + tol)
}

/**
 * The demo's solver is a patch model, so a drawn model can be solved when it reads as an inset-fed patch:
 * a dielectric box, a metal sheet under it, a metal sheet on top, a feed line from the board edge, and a port.
 */
export function recognisePatch(objs: Obj[]): { ok: true; design: Design; notes: string[] } | { ok: false; problems: string[] } {
  const vis = objs.filter((o) => o.visible)
  const problems: string[] = []
  const metal = (o: Obj) => MATERIALS[o.material]?.metal
  const sub = vis.filter((o) => o.kind === 'box' && !metal(o)).sort((a, b) => b.size[0] * b.size[1] * b.size[2] - a.size[0] * a.size[1] * a.size[2])[0]
  if (!sub) return { ok: false, problems: ['No substrate: draw a box (B) and give it a dielectric such as FR-4.'] }
  const z0 = sub.pos[2], zt = z0 + sub.size[2]
  const flat = (o: Obj, z: number) => metal(o) && !o.port && o.plane === 'xy' && Math.abs(o.pos[2] - z) < 0.05 && o.size[2] < 0.2
  const ground = vis.find((o) => flat(o, z0) && o.size[0] * o.size[1] >= 0.6 * sub.size[0] * sub.size[1])
  if (!ground) problems.push(`No ground plane: a copper rectangle under the substrate, at z = ${z0.toFixed(2)} mm.`)
  const tops = vis.filter((o) => flat(o, zt)).sort((a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1])
  const patch = tops[0]
  if (!patch) problems.push(`No patch: a copper rectangle on top of the substrate, at z = ${zt.toFixed(2)} mm.`)
  const feed = tops.slice(1).find((o) => Math.abs(o.pos[1] - sub.pos[1]) < 0.3)
  if (patch && !feed) problems.push('No feed line: a narrow copper rectangle from the bottom edge of the board (−y) into the patch.')
  if (!vis.some((o) => o.port)) problems.push('No port: draw one with the Port tool (P) at the end of the feed line.')
  if (problems.length) return { ok: false, problems }
  const er = MATERIALS[sub.material].eps
  const L = patch!.size[1], W = patch!.size[0], h = sub.size[2]
  const notes: string[] = []
  let y0 = maxOf(feed!)[1] - patch!.pos[1]
  if (y0 < 0.3) { y0 = target({ L, W, y0: 8, h, er, gs: 1 }).y0; notes.push(`The feed stops at the patch edge, so I started the inset at ${y0.toFixed(2)} mm from the design equations.`) }
  const gs = Math.min(1.6, Math.max(0.7, sub.size[0] / SUBSTRATE.wid))
  notes.unshift(`Read it as an inset-fed patch: ${W.toFixed(2)} × ${L.toFixed(2)} mm on ${h.toFixed(2)} mm ${sub.material} (εr ${er}), inset ${y0.toFixed(2)} mm, board ${sub.size[0].toFixed(1)} × ${sub.size[1].toFixed(1)} mm.`)
  return { ok: true, design: { L, W, y0, h, er, gs }, notes }
}

// handy when poking at the modeler from the browser console in development
if (import.meta.env.DEV) (window as unknown as { __model: typeof useModel }).__model = useModel
