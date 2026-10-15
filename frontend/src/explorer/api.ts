/** REST client for the 3D explorer and effect matrix (EXPLORER_README §6). */
async function req(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).detail ?? msg } catch { /* not JSON */ }
    throw new Error(msg)
  }
  return r.json()
}

const enc = encodeURIComponent

export const exApi = {
  matrix: (rid: string) => req('GET', `/api/runs/${rid}/jacobian`),
  startJacobian: (rid: string, variables?: string[]) => req('POST', `/api/runs/${rid}/jacobian`, { variables }),
  startSurface: (rid: string, body: { variable: string; metric: string; n_points: number; range_pct: number }) =>
    req('POST', `/api/runs/${rid}/surface`, body),
  surface: (rid: string, sid: string, f0?: number) =>
    req('GET', `/api/runs/${rid}/surface/${sid}${f0 ? `?f0=${f0}` : ''}`),
  target: (rid: string, body: { metric: string; value: number; variable: string }) =>
    req('POST', `/api/runs/${rid}/target`, body),
  verifyPoint: (rid: string, body: { variable: string; value: number; metric: string }) =>
    req('POST', `/api/runs/${rid}/verify-point`, body),
  apply: (rid: string, body: { variable: string; value: number }) => req('POST', `/api/runs/${rid}/apply`, body),
  preview: (pid: string, body: Record<string, unknown>) => req('POST', `/api/projects/${enc(pid)}/preview`, body),
  addVariable: (pid: string, body: Record<string, unknown>) => req('POST', `/api/projects/${enc(pid)}/variables`, body),
  addMetric: (pid: string, body: Record<string, unknown>) => req('POST', `/api/projects/${enc(pid)}/metrics`, body),
  removeVariable: (pid: string, name: string) => req('DELETE', `/api/projects/${enc(pid)}/variables/${enc(name)}`),
  removeMetric: (pid: string, name: string) => req('DELETE', `/api/projects/${enc(pid)}/metrics/${enc(name)}`),
  settings: (pid: string, body: { watched?: string[]; budget?: number }) =>
    req('PUT', `/api/projects/${enc(pid)}/explorer-settings`, body),
}
