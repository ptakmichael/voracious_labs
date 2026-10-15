import { useStore } from './store'
import type { RunEvent } from './types'
import { useExplorer } from './explorer/store'

async function post(url: string, body?: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r.json()
}

let source: EventSource | null = null

export async function loadCaps() {
  try {
    const c = await (await fetch('/api/capabilities')).json()
    useStore.getState().setCaps(c)
  } catch {
    useStore.getState().setCaps({ offline: true })
  }
}

export async function startRun(opts: { sample?: boolean } = {}) {
  const st = useStore.getState()
  source?.close()
  // A sample run previews every screen: fully autonomous, fast, scripted orchestrator (no API calls).
  const project = opts.sample ? { ...st.project, settings: { ...st.project.settings, autonomy: 'auto' } } : st.project
  const { run_id } = await post('/api/runs', { project, speed: opts.sample ? 60 : st.speed, scripted: !!opts.sample })
  const view = st.view
  st.resetRun(run_id)
  useExplorer.getState().reset(run_id)
  if (opts.sample) useStore.setState({ view, followRun: false })
  else st.setView('analyze')
  source = new EventSource(`/api/runs/${run_id}/events`)
  // The stream stays open after run_finished: the effect matrix keeps computing in the background.
  source.onmessage = (m) => {
    const ev: RunEvent = JSON.parse(m.data)
    useStore.getState().applyEvent(ev)
    useExplorer.getState().onEvent(ev)
  }
}

export async function sendChat(text: string) {
  const st = useStore.getState()
  if (st.run.id) {
    // finished runs still take chat: explorer questions ("what does feed_x do?") are answered from the run
    const r = await post(`/api/runs/${st.run.id}/chat`, { text })
    if (r.ui) {
      useExplorer.getState().applyUi(r.ui)
      if (r.ui.tab) useStore.getState().setView('results', true)
    }
    return r
  }
  st.pushChat({ role: 'user', text })
  const r = await post('/api/chat', { text, project: summarizeProject() })
  useStore.getState().pushChat({ role: 'solver', text: r.reply })
  return r
}

function summarizeProject() {
  const p = useStore.getState().project
  return {
    name: p.name, settings: p.settings, goal: p.goal, constraints: p.constraints, boundary: p.boundary,
    objects: p.objects.map((o) => ({ name: o.name, kind: o.kind, material: o.material, size_mm: o.size, pos_mm: o.pos })),
    custom_materials: p.materials,
  }
}

export const approve = (target: string, extra: Record<string, unknown> = {}) =>
  post(`/api/runs/${useStore.getState().run.id}/approve`, { target, approved: true, ...extra })
export const hold = () => post(`/api/runs/${useStore.getState().run.id}/hold`)
export const cancelRun = () => post(`/api/runs/${useStore.getState().run.id}/cancel`)
export const exportUrl = (fmt: string) => `/api/runs/${useStore.getState().run.id}/export/${fmt}`

export async function patchTemplate(body: Record<string, unknown>) {
  return post('/api/templates/patch', body)
}
