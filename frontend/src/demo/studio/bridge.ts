/**
 * Keeps the original demo's store in step with the studio, so the earlier analysis tools (effects map, what moves
 * what, contour, fields, Smith loops, run tree, solver choices, array tools) run unchanged on the studio's design.
 * Edits made inside those tools flow back as studio variable changes.
 */
import { arrayMetrics } from '../arrayModel'
import { metrics } from '../model'
import { type Run, useDemo } from '../store'
import { useStudio } from './store'

let pushing = false

function push() {
  const s = useStudio.getState()
  pushing = true
  const runs: Run[] = s.sols.map((x) => ({ n: x.id, d: x.d, m: metrics(x.d), label: x.label, sim: 31, ...(x.a ? { a: x.a, am: arrayMetrics(x.d, x.a) } : {}) }))
  useDemo.setState({
    kind: s.kind ?? 'patch', design: s.d, arr: s.a, runs, issues: s.issues,
    phase: runs.length ? 'done' : s.kind ? 'built' : 'empty', source: s.ctx ? 'paper' : 'cad', screen: 'flow',
  })
  pushing = false
}

export function startBridge() {
  push()
  const offA = useStudio.subscribe((s, p) => { if (s.d !== p.d || s.a !== p.a || s.sols !== p.sols || s.kind !== p.kind || s.issues !== p.issues) push() })
  const offB = useDemo.subscribe((s, p) => {
    if (pushing) return
    const st = useStudio.getState()
    if (s.design !== p.design && s.design !== st.d) for (const k of Object.keys(s.design) as (keyof typeof s.design)[]) if (s.design[k] !== st.d[k]) st.setVar(k, s.design[k])
    if (s.arr !== p.arr && s.arr !== st.a) st.setArr(s.arr)
  })
  return () => { offA(); offB() }
}
