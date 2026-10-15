import { useState } from 'react'
import { LineChart } from '../components/charts/LineChart'
import { FEED_W, SUBSTRATE } from './model'
import { useDemo } from './store'

/**
 * What the solver did on the first solve and why, kept on screen after it finishes: the method and what it ruled
 * out, the setup (boundaries, materials, port, symmetry), the adaptive mesh, and the speed-ups with their savings.
 * Scripted for the demo, but consistent with the plan card (1:34 vs ~25:00, stop at < 0.5 MHz) and the run times.
 */

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const LAMBDA_MAX = 299.792458 / 2.1 // mm, longest wavelength in the sweep
// resonance on each adaptive pass, as an offset (MHz) from the converged value, and the element count
const PASSES = [
  { tets: 8.4, off: 24 }, { tets: 14.1, off: 9.6 }, { tets: 22.9, off: 3.9 },
  { tets: 34.6, off: 1.0 }, { tets: 47.8, off: 0.3 }, { tets: 58.3, off: 0 },
]
const TIME = [['Geometry and first mesh', 9], ['6 adaptive mesh passes', 51], ['Fast sweep, 281 points', 24], ['Fields and far-field', 10]] as const

type Tab = 'solver' | 'setup' | 'mesh' | 'speed' | 'steps'

function Row({ k, v, why }: { k: string; v: React.ReactNode; why?: React.ReactNode }) {
  return (
    <div className="sr-row">
      <div className="sr-k">{k}</div>
      <div className="sr-v">{v}{why && <div className="sr-why">{why}</div>}</div>
    </div>
  )
}

export function SolveReport({ framed = true }: { framed?: boolean }) {
  const s = useDemo()
  const [tab, setTab] = useState<Tab>('solver')
  const first = s.runs[0]
  if (!first) return null
  const d = first.d
  const Ws = SUBSTRATE.wid * d.gs, Ls = SUBSTRATE.len * d.gs
  const f0 = first.m.f0 * 1000
  const pml = LAMBDA_MAX / 4
  const tunes = s.runs.slice(1)
  const tuneTime = tunes.reduce((a, r) => a + r.sim, 0)
  const body = (
    <>
      <div className="sr-tabs">
        {([['solver', 'Solver'], ['setup', 'Setup & boundaries'], ['mesh', 'Mesh'], ['speed', 'Speed-ups'], ['steps', 'Steps']] as [Tab, string][]).map(([k, n]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n}</button>
        ))}
      </div>
      <div className="sr-body">
        {tab === 'solver' && (
          <>
            <div className="sr-pick">
              <div className="sr-pick-h">Frequency-domain finite elements (FEM)</div>
              <div className="sr-pick-s">2nd-order tetrahedra · direct sparse solver · one frequency at a time</div>
              <p>Fills the board and the air around it with small tetrahedra and solves for the fields at each frequency.</p>
            </div>
            <div className="sr-h">Why this one</div>
            <ul className="sr-list">
              <li><b>A single narrow resonance</b> (Q ≈ 15). Solving frequency by frequency is exact at each point and never waits for the patch to stop ringing.</li>
              <li><b>The finite board matters.</b> Your ground plane is {Ws.toFixed(1)} × {Ls.toFixed(1)} mm and ground size is one of your parameters: it moves gain by about 1 dB. A volume method models the real board edges.</li>
              <li><b>Thin, fine features.</b> A {d.h.toFixed(1)} mm substrate and 1.0 mm inset slots: tetrahedra fit them exactly, with no staircasing.</li>
            </ul>
            <div className="sr-h">Ruled out</div>
            <ul className="sr-list no">
              <li><b>Planar method of moments.</b> The fastest for patches, but it assumes an infinite board and ground plane, so it can't see what ground size does.</li>
              <li><b>Time domain (FDTD).</b> A Q ≈ 15 resonance rings for thousands of time steps, and resolving the 1 mm slots needs ~0.2 mm cells: about 8 minutes a run instead of 1½.</li>
            </ul>
          </>
        )}
        {tab === 'setup' && (
          <>
            <Row k="Radiation boundary" v={<>PML, 6 layers, {pml.toFixed(0)} mm from the board on every side</>} why={<>λ/4 at the lowest frequency (2.1 GHz). Keeps the absorber out of the near field; reflections below −40 dB.</>} />
            <Row k="Copper" v={<>patch, feed and ground: 35 µm copper, σ = 5.8 × 10⁷ S/m, as a surface impedance</>} why="Far thinner than any element, so it's a sheet with the right loss instead of a meshed slab." />
            <Row k="Substrate" v={<>FR-4, εr {d.er.toFixed(2)}, tan δ 0.02, {d.h.toFixed(2)} mm</>} why={s.source === 'paper' ? 'εr is 4.4, not the paper\'s 4.08: that was the effective value. Dispersion off: it would move resonance by under 1 MHz here.' : 'Dispersion off: it would move resonance by under 1 MHz here.'} />
            <Row k="Ground plane" v={<>finite, {Ws.toFixed(2)} × {Ls.toFixed(2)} mm, same as the board</>} why="Modelled as built; an infinite ground would overstate gain." />
            <Row k="Port" v={<>50 Ω wave port on the {FEED_W} mm feed line at the board edge, 1 mode</>} why="Solves the line's own mode, so the reference is the real line: 50.3 Ω for this width." />
            <Row k="Symmetry" v={<>magnetic wall (PMC) through the feed, x = 0: half the board is solved</>} why="Geometry and feed are mirror-symmetric, so the fields are too. Switched off only for cross-polarisation." />
            <Row k="Outputs" v="S11 and input impedance 2.1–2.8 GHz; surface current, fields and far-field at resonance" />
          </>
        )}
        {tab === 'mesh' && (
          <>
            <p className="sr-p">Started coarse (λ/4 everywhere) and refined only where the answer was still moving. Stopped when resonance changed by less than 0.5 MHz between passes.</p>
            <div className="sr-mesh">
              <table className="sr-tbl">
                <thead><tr><th>pass</th><th>elements</th><th>resonance</th><th>change</th></tr></thead>
                <tbody>
                  {PASSES.map((p, i) => (
                    <tr key={i} className={i === PASSES.length - 1 ? 'ok' : ''}><td>{i + 1}</td><td>{p.tets.toFixed(1)}k</td><td>{(f0 + p.off).toFixed(1)} MHz</td><td>{i ? `${(PASSES[i - 1].off - p.off).toFixed(1)} MHz` : '–'}</td></tr>
                  ))}
                </tbody>
              </table>
              <LineChart height={150} xDomain={[1, 6]} yDomain={[f0 - 4, f0 + 28]} xTicks={[1, 2, 3, 4, 5, 6]} xFmt={(v) => v.toFixed(0)} yFmt={(v) => v.toFixed(0)} xLabel="pass" yLabel="MHz"
                hlines={[{ y: f0, color: 'var(--ok)', dash: '4 3', label: 'converged' }]}
                series={[{ x: [1, 2, 3, 4, 5, 6], y: PASSES.map((p) => f0 + p.off), color: 'var(--ink)', width: 2, dot: true }]} />
            </div>
            <Row k="Where it refined" v="73% of new elements at the radiating edges and inset slots, 18% along the feed, 9% elsewhere" why="That's where the fields change fastest. The air far from the board kept its coarse mesh." />
            <Row k="Final mesh" v="58.3k second-order tetrahedra (half model), 1.9 GB peak memory" why="A uniform mesh this fine everywhere would be about 410k elements." />
          </>
        )}
        {tab === 'speed' && (
          <>
            <table className="sr-tbl wide">
              <thead><tr><th>speed-up</th><th>what it does</th><th>saves</th></tr></thead>
              <tbody>
                <tr><td>Symmetry plane</td><td>solves half the board</td><td>~2×</td></tr>
                <tr><td>Adaptive mesh</td><td>58k elements where needed instead of ~410k everywhere</td><td>~7×</td></tr>
                <tr><td>Fast sweep</td><td>281 frequency points from 4 full solves plus a reduced-order model; spot-checked at 3 points, error under 0.05 dB</td><td>~12×</td></tr>
                <tr><td>Coarse first look</td><td>finds the resonance on a coarse mesh before refining, so effort goes to the right band</td><td>avoids rework</td></tr>
                <tr><td>Warm-started tuning</td><td>each tuning run morphs the converged mesh instead of rebuilding it: one refinement pass</td><td>94 s → 31 s a run</td></tr>
                <tr><td>Adjoint sensitivities</td><td>derivatives with respect to every dimension from each run, ~10% extra; they set the tuner's steps and the Explore numbers</td><td>no extra runs</td></tr>
              </tbody>
            </table>
            <div className="sr-time">
              <div className="sr-h">First solve: {mmss(first.sim)}</div>
              {TIME.map(([k, v]) => (
                <div key={k} className="sr-bar"><span>{k}</span><div className="track"><div className="fill" style={{ width: `${(v / 94) * 100}%`, background: 'var(--sig)' }} /></div><b>{mmss(v)}</b></div>
              ))}
              <div className="sr-cmp">Fine mesh everywhere and a full sweep: about <b>25:00</b>.{tunes.length > 0 && <> Tuning: {tunes.length} run{tunes.length > 1 ? 's' : ''}, {mmss(tuneTime)} in total (brute force: ~{tunes.length * 25}:00).</>}</div>
            </div>
          </>
        )}
        {tab === 'steps' && (
          <ol className="sr-steps">
            <li><b>Quick look</b>, 2.1–2.8 GHz on a coarse mesh: resonance near {(f0 + 24).toFixed(0)} MHz. <span>0:09</span></li>
            <li><b>Found where the answer was still moving</b>: the radiating edges and inset slots. <span>0:12</span></li>
            <li><b>Refined the mesh there only</b>, 5 more passes, 8.4k → 58.3k elements. <span>0:39</span></li>
            <li><b>Detailed sweep around the resonance</b>, 281 points from 4 solves. <span>0:24</span></li>
            <li><b>Stopped</b>: resonance moved 0.3 MHz on the last pass, under the 0.5 MHz limit. Fields and far-field computed. <span>0:10</span></li>
          </ol>
        )}
      </div>
    </>
  )
  if (!framed) return <div className="sr">{body}</div>
  return (
    <div className="card sr">
      <div className="card-h"><h3>How I solved it</h3><span className="aside">run 1 · {mmss(first.sim)} · kept for reference</span></div>
      {body}
    </div>
  )
}
