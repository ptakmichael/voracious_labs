import { LineChart, type Series } from '../components/charts/LineChart'
import { type Design, FREQS, F_RANGE, GOAL, VARS, curve, goalMet, metrics, tuneStep, worstInBand } from './model'
import { type Run, useDemo } from './store'
import { ARRAY_GOAL, F0, SCAN_MAX, arrayGoalMet, beam, lambda } from './arrayModel'

/**
 * Executive summary: the first thing shown when a solve or a tuning run finishes. What happened, where it ended up
 * against the goal, what changed, what it cost, how robust it is, and what to do next. All from the runs.
 */

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const BRUTE = 25 * 60 // fine mesh everywhere and a full sweep, per solve

function sourceLine(src: string | null, pdf: string | null) {
  if (src === 'paper') return `Built the antenna from ${pdf ?? 'the paper'} (Table 1, eq. 6, Fig. 3) and corrected four things in it that didn't add up.`
  if (src === 'cad') return 'Read the model you drew as an inset-fed patch and built it.'
  return 'Worked the dimensions out from the standard patch design equations and built it.'
}

function robustness(d: Design) {
  const lo = worstInBand({ ...d, er: d.er - 0.2 }), hi = worstInBand({ ...d, er: d.er + 0.2 })
  return { lo, hi, ok: lo <= GOAL.db && hi <= GOAL.db }
}

export function buildSummary(runs: Run[], src: string | null, pdf: string | null, issues: { title: string }[]) {
  const first = runs[0], last = runs[runs.length - 1]
  const met = goalMet(last.m)
  const tunes = runs.filter((r) => r.label.startsWith('Tune'))
  const changes = VARS.filter((v) => Math.abs((last.d[v.key] as number) - (first.d[v.key] as number)) > 1e-6)
  const sim = runs.reduce((a, r) => a + r.sim, 0)
  const story: string[] = [sourceLine(src, pdf)]
  story.push(`First solve: resonance at ${first.m.f0.toFixed(3)} GHz, worst in-band match ${first.m.worst.toFixed(1)} dB, so the ${GOAL.f1.toFixed(2)}–${GOAL.f2.toFixed(2)} GHz band was ${goalMet(first.m) ? 'already covered' : 'missed'}.`)
  if (tunes.length) story.push(`Tuning ran ${tunes.length} time${tunes.length > 1 ? 's' : ''}, moving ${changes.map((v) => v.name.toLowerCase()).join(' and ') || 'nothing'} together.`)
  else if (runs.length > 1) story.push(`${runs.length - 1} more solve${runs.length > 2 ? 's' : ''} of your edits.`)
  story.push(met ? `It now covers the whole band: worst case ${last.m.worst.toFixed(1)} dB, ${(GOAL.db - last.m.worst).toFixed(1)} dB better than the goal, with ${last.m.bw.toFixed(0)} MHz of bandwidth.` : `It doesn't meet the goal yet: worst in-band match is ${last.m.worst.toFixed(1)} dB against ${GOAL.db} dB.`)
  const rob = robustness(last.d)
  const thick = (() => { const t = tuneStep(tuneStep({ ...last.d, h: 2.4 }, 1), 1); return metrics(t) })()
  const next: string[] = met
    ? [
      rob.ok ? `Holds up to board variation: with εr ${(last.d.er - 0.2).toFixed(1)}–${(last.d.er + 0.2).toFixed(1)} (typical FR-4 spread) the worst case stays between ${Math.max(rob.lo, rob.hi).toFixed(1)} and ${Math.min(rob.lo, rob.hi).toFixed(1)} dB.`
        : `Sensitive to the board: at εr ${(last.d.er - 0.2).toFixed(1)} the worst case is ${rob.lo.toFixed(1)} dB and at ${(last.d.er + 0.2).toFixed(1)} it's ${rob.hi.toFixed(1)} dB, so a typical FR-4 spread can push it out of spec. Measure your laminate or add margin.`,
      `For more margin without a bigger footprint: a ${thick.bw.toFixed(0)} MHz bandwidth is possible on a 2.4 mm board, re-tuned (now ${last.m.bw.toFixed(0)} MHz).`,
      'Ready for a prototype: export the geometry, or check gain and pattern in Explore.',
    ]
    : ['Run Tune to goal: it adjusts patch length and inset depth together until the band is covered.', 'Or open Explore to see which dimension moves what.']
  return { n: runs.length, first, last, met, tunes, changes, sim, brute: runs.length * BRUTE, story, next, rob, issues }
}

function markdown(s: ReturnType<typeof buildSummary>) {
  const rows = (['f0', 'worst', 'bw', 'R', 'gain'] as const).map((k) => {
    const n = { f0: 'Resonance (GHz)', worst: 'Worst in-band match (dB)', bw: 'Bandwidth (MHz)', R: 'Input resistance (Ω)', gain: 'Gain (dBi)' }[k]
    return `| ${n} | ${s.first.m[k].toFixed(k === 'f0' ? 3 : 1)} | ${s.last.m[k].toFixed(k === 'f0' ? 3 : 1)} |`
  }).join('\n')
  return `# Executive summary\n\n**${s.met ? 'Goal met' : 'Goal not met yet'}**: S11 below ${GOAL.db} dB from ${GOAL.f1} to ${GOAL.f2} GHz.\n\n${s.story.join(' ')}\n\n| | Start | Now |\n|---|---|---|\n${rows}\n\n## Design changes\n${s.changes.map((v) => `- ${v.name}: ${v.fmt(s.first.d[v.key] as number)} → ${v.fmt(s.last.d[v.key] as number)} ${v.unit}`).join('\n') || '- none'}\n\n## Effort\n${s.n} solve${s.n > 1 ? 's' : ''}, ${mmss(s.sim)} of solver time (brute force: ~${mmss(s.brute)}).\n\n## Next\n${s.next.map((x) => `- ${x}`).join('\n')}\n`
}

function ArraySummary() {
  const st = useDemo()
  const first = st.runs[0], last = st.runs[st.runs.length - 1]
  const a0 = first.a!, a1 = last.a!, m0 = first.am!, m1 = last.am!
  const met = arrayGoalMet(m1)
  const sim = st.runs.reduce((x, r) => x + r.sim, 0), brute = st.runs.length * 16 * 25 * 60
  const el = last.d
  const b30 = beam(el, { ...a1, theta: 32 })
  // fewest phase-shifter bits that keep gain within 0.3 dB and the worst sidelobe within 1.5 dB of ideal steering
  const bits = [3, 4, 5, 6].find((n) => { const q = beam(el, { ...a1, theta: 32, bits: n }); return b30.gain - q.gain < 0.3 && q.sll - b30.sll < 1.5 }) ?? 6
  const b30q = beam(el, { ...a1, theta: 32, bits })
  const fail = beam(el, { ...a1, theta: 0, failed: [5, 10] }), ok = beam(el, { ...a1, theta: 0 })
  const sq = [beam(el, { ...a1, theta: SCAN_MAX, f: 2.42 }).point, beam(el, { ...a1, theta: SCAN_MAX, f: 2.44 }).point]
  const story = [
    `Built the 4×4 array from ${st.pdf?.name ?? 'the paper'} (Table I, Fig. 2) and corrected four things in it.`,
    `First solve, the paper's design with the inset feed it describes: the element is matched to only ${first.m.worst.toFixed(1)} dB, and while steering the worst active match is ${m0.activeWorst.toFixed(1)} dB with sidelobes up to ${m0.sllWorst.toFixed(1)} dB at ${SCAN_MAX}°.`,
    `Optimised in ${st.runs.length - 1} run${st.runs.length > 2 ? 's' : ''}: re-centred the element, opened the pitch from ${a0.dx.toFixed(0)} to ${a1.dx.toFixed(0)} mm to cut coupling${a1.taper !== a0.taper ? `, and added a ${a1.taper === 'cheb' ? 'Chebyshev' : 'Taylor'} −${a1.sll} dB taper for the sidelobes` : ''}.`,
    met ? `It now steers to ±${SCAN_MAX}° with the active match at ${m1.activeWorst.toFixed(1)} dB or better and sidelobes at ${m1.sllWorst.toFixed(1)} dB or lower. Gain ${m1.gain0.toFixed(1)} dBi at broadside, ${m1.gainMax.toFixed(1)} dBi at ${SCAN_MAX}°.` : `Not there yet: active match ${m1.activeWorst.toFixed(1)} dB, sidelobes ${m1.sllWorst.toFixed(1)} dB.`,
  ]
  const rows: [string, number, number, string, boolean?][] = [
    ['Active match, worst over ±42°', m0.activeWorst, m1.activeWorst, 'dB', true],
    ['Sidelobes, worst over ±42°', m0.sllWorst, m1.sllWorst, 'dB', true],
    ['Gain at broadside', m0.gain0, m1.gain0, 'dBi'],
    [`Gain at ${SCAN_MAX}°`, m0.gainMax, m1.gainMax, 'dBi'],
    ['Scan loss', m0.scanLoss, m1.scanLoss, 'dB'],
    ['Element match (alone)', first.m.worst, last.m.worst, 'dB'],
  ]
  const changes: [string, string, string][] = [
    ['Pitch', `${a0.dx.toFixed(1)} mm (${(a0.dx / lambda(F0)).toFixed(2)} λ)`, `${a1.dx.toFixed(1)} mm (${(a1.dx / lambda(F0)).toFixed(2)} λ)`],
    ['Taper', a0.taper, a1.taper === 'uniform' ? 'uniform' : `${a1.taper === 'cheb' ? 'Chebyshev' : 'Taylor'} −${a1.sll} dB`],
    ['Patch length', `${first.d.L.toFixed(2)} mm`, `${el.L.toFixed(2)} mm`],
    ['Inset', `${first.d.y0.toFixed(2)} mm`, `${el.y0.toFixed(2)} mm`],
    ['Board', `${(3 * a0.dx + 60).toFixed(0)} mm square`, `${(3 * a1.dx + 60).toFixed(0)} mm square`],
  ].filter(([, x, y]) => x !== y) as [string, string, string][]
  const next = [
    `Phase shifters: ${bits} bits are enough. At 32°, ideal steering gives ${b30.gain.toFixed(1)} dBi and ${b30.sll.toFixed(1)} dB sidelobes; ${bits}-bit gives ${b30q.gain.toFixed(1)} dBi and ${b30q.sll.toFixed(1)} dB. Fewer bits raise quantisation lobes.`,
    `Failures: losing two centre elements costs ${(ok.gain - fail.gain).toFixed(1)} dB of gain and raises the worst sidelobe to ${fail.sll.toFixed(1)} dB. Plan for monitoring, or a 5×5 with a spare ring.`,
    `Beam squint across the channel at ${SCAN_MAX}°: ${Math.abs(sq[0] - sq[1]).toFixed(1)}°. Phase shifters are fine; true-time delay isn't needed.`,
    'Pointing: the beam lands a few degrees short of the command at wide angles. Use the pointing table from Explore ▸ Array designer.',
  ]
  return (
    <div className="pane-grid summary">
      <div className="sum-main">
        <div className={`sum-verdict ${met ? 'good' : 'bad'}`}>
          <div>
            <div className="sv-k">Executive summary · after run {last.n}</div>
            <div className="sv-h">{met ? 'Goal met.' : 'Goal not met yet.'} <span>steer ±{SCAN_MAX}°, active S11 &lt; {ARRAY_GOAL.active} dB, sidelobes &lt; {ARRAY_GOAL.sll} dB</span></div>
          </div>
          <div className="sv-num"><b>{m1.activeWorst.toFixed(1)} dB</b><span>worst active match</span></div>
        </div>
        <div className="card">
          <div className="card-h"><h3>What happened</h3><span className="aside">{st.runs.length} solves · {mmss(sim)} solver time</span></div>
          <div className="card-b"><ol className="sum-story">{story.map((x) => <li key={x}>{x}</li>)}</ol>
            <div className="sum-issues"><b>Fixed in the paper:</b> {st.issues.map((i, k) => (k ? i.title[0].toLowerCase() + i.title.slice(1) : i.title)).join('; ')}.</div>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Steered to {SCAN_MAX}°, before and after</h3><span className="aside">run 1 → run {last.n}</span></div>
          <div className="card-b chart">
            <LineChart height={230} xDomain={[-90, 90]} yDomain={[-25, 16]} xTicks={[-90, -60, -30, 0, 30, 60, 90]} xFmt={(v) => `${v}`} xLabel="θ (deg)" yLabel="dBi" legend
              series={[
                ...(first !== last ? [{ x: m0.beams[SCAN_MAX].cut.map((c) => c.th), y: m0.beams[SCAN_MAX].cut.map((c) => c.db), color: 'var(--faint)', width: 1.6, dash: '5 4', label: `run 1 · ${first.label}` }] : []),
                { x: m1.beams[SCAN_MAX].cut.map((c) => c.th), y: m1.beams[SCAN_MAX].cut.map((c) => c.db), color: 'var(--sig)', width: 2.6, label: `run ${last.n} · ${last.label}` },
              ]} hlines={[{ y: m1.gainMax + ARRAY_GOAL.sll, color: 'var(--sig)', dash: '5 4', label: 'sidelobe goal' }]} />
          </div>
        </div>
      </div>
      <div className="sum-side">
        <div className="card">
          <div className="card-h"><h3>Key numbers</h3><span className="aside">start → now</span></div>
          <div className="card-b" style={{ padding: 0 }}>
            <table className="sum-tbl"><tbody>
              {rows.map(([n, x, y, u, goal]) => <tr key={n}><td>{n}</td><td>{x.toFixed(1)}</td><td>→</td><td className={goal ? (y <= (n.startsWith('Active') ? ARRAY_GOAL.active : ARRAY_GOAL.sll) ? 'good' : 'bad') : ''}><b>{y.toFixed(1)}</b></td><td>{u}</td></tr>)}
            </tbody></table>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>What changed in the design</h3></div>
          <div className="card-b"><table className="sum-tbl plain"><tbody>{changes.map(([n, x, y]) => <tr key={n}><td>{n}</td><td>{x}</td><td>→</td><td><b>{y}</b></td><td /></tr>)}</tbody></table></div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Effort</h3></div>
          <div className="card-b sum-effort">
            <div><b>{st.runs.length}</b><span>solves</span></div>
            <div><b>{mmss(sim)}</b><span>solver time</span></div>
            <div><b>~{Math.round(brute / sim)}×</b><span>faster than meshing all 16 elements every time (~{mmss(brute)})</span></div>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Risks and next steps</h3></div>
          <div className="card-b"><ul className="sum-next">{next.map((x) => <li key={x}>{x}</li>)}</ul></div>
        </div>
        <div className="row-btns">
          <button className="btn pri" onClick={() => st.setTab('compare')}>Compare with the paper</button>
          <button className="btn" onClick={() => st.setTab('explore')}>Open the array tools</button>
          {!met && st.phase !== 'tuning' && <button className="btn sig" onClick={st.tune}>Optimise</button>}
        </div>
      </div>
    </div>
  )
}

export function SummaryPane() {
  const st = useDemo()
  if (!st.runs.length) return null
  if (st.kind === 'array' && st.runs[0].am) return <ArraySummary />
  const s = buildSummary(st.runs, st.source, st.pdf?.name ?? null, st.issues)
  const series: Series[] = []
  if (s.first !== s.last) series.push({ x: FREQS, y: curve(s.first.d), color: 'var(--faint)', width: 1.6, dash: '5 4', label: `run 1 · ${s.first.label}` })
  series.push({ x: FREQS, y: curve(s.last.d), color: 'var(--sig)', width: 2.6, label: `run ${s.last.n} · ${s.last.label}` })
  const metricRows: [string, number, number, string, (v: number) => string, boolean?][] = [
    ['Resonance', s.first.m.f0, s.last.m.f0, 'GHz', (v) => v.toFixed(3)],
    ['Worst in-band match', s.first.m.worst, s.last.m.worst, 'dB', (v) => v.toFixed(1), true],
    ['Bandwidth (−10 dB)', s.first.m.bw, s.last.m.bw, 'MHz', (v) => v.toFixed(0)],
    ['Input resistance', s.first.m.R, s.last.m.R, 'Ω', (v) => v.toFixed(1)],
    ['Gain', s.first.m.gain, s.last.m.gain, 'dBi', (v) => v.toFixed(2)],
  ]
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([markdown(s)], { type: 'text/markdown' }))
    a.download = 'executive-summary.md'; a.click()
  }
  return (
    <div className="pane-grid summary">
      <div className="sum-main">
        <div className={`sum-verdict ${s.met ? 'good' : 'bad'}`}>
          <div>
            <div className="sv-k">Executive summary · after run {s.last.n}</div>
            <div className="sv-h">{s.met ? 'Goal met.' : 'Goal not met yet.'} <span>S11 below {GOAL.db} dB, {GOAL.f1.toFixed(2)}–{GOAL.f2.toFixed(2)} GHz</span></div>
          </div>
          <div className="sv-num"><b>{s.last.m.worst.toFixed(1)} dB</b><span>worst in band</span></div>
        </div>
        <div className="card">
          <div className="card-h"><h3>What happened</h3><span className="aside">{st.runs.length} solve{st.runs.length > 1 ? 's' : ''} · {mmss(s.sim)} solver time</span></div>
          <div className="card-b"><ol className="sum-story">{s.story.map((x) => <li key={x}>{x}</li>)}</ol>
            {s.issues.length > 0 && <div className="sum-issues"><b>Fixed in the paper:</b> {s.issues.map((i, k) => (k ? i.title[0].toLowerCase() + i.title.slice(1) : i.title)).join('; ')}.</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Before and after</h3><span className="aside">run 1 → run {s.last.n}</span></div>
          <div className="card-b chart">
            <LineChart height={230} xDomain={F_RANGE} yDomain={[-40, 1]} yTicks={[0, -10, -20, -30, -40]} xTicks={[2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8]} xFmt={(v) => v.toFixed(1)}
              xLabel="frequency (GHz)" yLabel="dB" vbands={[{ x1: GOAL.f1, x2: GOAL.f2, color: 'var(--ok)', opacity: 0.13 }]}
              hlines={[{ y: GOAL.db, color: 'var(--sig)', dash: '5 4', label: '−10 dB goal' }]} series={series} legend={series.length > 1} />
          </div>
        </div>
      </div>
      <div className="sum-side">
        <div className="card">
          <div className="card-h"><h3>Key numbers</h3><span className="aside">start → now</span></div>
          <div className="card-b" style={{ padding: 0 }}>
            <table className="sum-tbl">
              <tbody>
                {metricRows.map(([n, a, b, u, f, goal]) => (
                  <tr key={n}><td>{n}</td><td>{f(a)}</td><td>→</td><td className={goal ? (b <= GOAL.db ? 'good' : 'bad') : ''}><b>{f(b)}</b></td><td>{u}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>What changed in the design</h3></div>
          <div className="card-b">
            {s.changes.length ? (
              <table className="sum-tbl plain"><tbody>
                {s.changes.map((v) => <tr key={v.key}><td>{v.name}</td><td>{v.fmt(s.first.d[v.key] as number)}</td><td>→</td><td><b>{v.fmt(s.last.d[v.key] as number)}</b></td><td>{v.unit}</td></tr>)}
              </tbody></table>
            ) : <div className="mute small">Nothing yet: this is the design as built.</div>}
            {s.changes.length > 0 && <div className="mute small" style={{ marginTop: 6 }}>Everything else is as built.</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Effort</h3></div>
          <div className="card-b sum-effort">
            <div><b>{st.runs.length}</b><span>solves</span></div>
            <div><b>{mmss(s.sim)}</b><span>solver time</span></div>
            <div><b>~{Math.round(s.brute / s.sim)}×</b><span>faster than brute force (~{mmss(s.brute)})</span></div>
          </div>
        </div>
        <div className="card">
          <div className="card-h"><h3>Risks and next steps</h3></div>
          <div className="card-b"><ul className="sum-next">{s.next.map((x) => <li key={x}>{x}</li>)}</ul></div>
        </div>
        <div className="row-btns">
          <button className="btn pri" onClick={() => st.setTab('results')}>Detailed results</button>
          {st.pdf?.known && <button className="btn" onClick={() => st.setTab('compare')}>Compare with the paper</button>}
          {s.met && <button className="btn" onClick={() => st.setTab('explore')}>Explore what drives it</button>}
          {!s.met && st.phase !== 'tuning' && <button className="btn sig" onClick={st.tune}>Tune to goal</button>}
          <button className="btn" onClick={download}>Download summary</button>
        </div>
      </div>
    </div>
  )
}
