import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { LineChart, type Series } from '../components/charts/LineChart'
import {
  type Design, FREQS, PAPER_FIXED, F_RANGE, GOAL, VARS, curve, lerp,
} from './model'
import { BUILD_SECS, READ_SECS, SOLVE_SECS, TUNE_SECS, VERIFY_SECS, type Msg, type Tab, now, useDemo } from './store'
import { PaperView } from './PaperView'
import { ExplorePane } from './Understand'
import { SolveReport } from './SolveReport'

const Scene3D = lazy(() => import('./Scene3D').then((m) => ({ default: m.Scene3D })))

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const same = (a: Design, b: Design) => VARS.every((v) => Math.abs((a[v.key] as number) - (b[v.key] as number)) < 1e-6)

function useClock() {
  const [t, setT] = useState(now())
  useEffect(() => {
    let raf = 0
    const loop = () => { const n = now(); useDemo.getState().tick(n); setT(n); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return t
}

// ---------------------------------------------------------------- top bar

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <rect x="0.5" y="0.5" width="21" height="21" fill="none" stroke="currentColor" />
      <path d="M3 11 C 5 4, 7 4, 9 11 S 13 18, 15 11 S 18 6, 19 11" fill="none" stroke="var(--sig)" strokeWidth="1.8" />
    </svg>
  )
}

function TopBar({ t }: { t: number }) {
  const s = useDemo()
  const step = s.tab === 'explore' && s.runs.length ? 3 : s.phase === 'tuning' || s.phase === 'done' ? 2 : s.phase === 'solving' || s.phase === 'solved' ? 1 : 0
  const doneUpTo = s.phase === 'done' ? 3 : s.runs.length ? 1 : s.phase === 'built' ? 0 : -1
  let sim = s.runs.reduce((a, r) => a + r.sim, 0)
  if (s.phase === 'solving') sim += clamp01((t - s.phaseAt) / (s.solveKind === 'first' ? SOLVE_SECS : VERIFY_SECS)) * (s.solveKind === 'first' ? 94 : 31)
  if (s.phase === 'tuning' && !s.paused) sim += clamp01(1 - (s.nextRunAt - t) / TUNE_SECS) * 31
  const busy = s.phase === 'reading' || s.phase === 'solving' || (s.phase === 'tuning' && !s.paused)
  const name = s.pdf ? s.pdf.name.replace(/\.pdf$/i, '') : s.source === 'text' ? 'patch-2g4' : 'untitled'
  return (
    <header className="bar">
      <div className="mark"><Mark />{BRAND}</div>
      <div className="proj">project <b title={name}>{name.length > 34 ? name.slice(0, 32) + '…' : name}</b></div>
      <nav className="steps">
        {['Describe', 'Solve', 'Tune', 'Understand'].map((n, i) => (
          <div key={n} className={`step${i === step ? ' on' : ''}${i <= doneUpTo && i !== step ? ' done' : ''}`}>
            <span className="n">0{i + 1}</span>{n}
            {i <= doneUpTo && i !== step && <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.5 5 9 10 3" fill="none" stroke="var(--ok)" strokeWidth="1.8" /></svg>}
          </div>
        ))}
      </nav>
      <div className="clock">
        <span><span className={`lamp${busy ? ' run' : s.phase === 'done' ? ' ok' : ''}`} />{busy ? (s.phase === 'reading' ? 'reading' : s.phase === 'tuning' ? 'tuning' : 'solving') : s.phase === 'done' ? 'goal met' : s.paused ? 'paused' : 'idle'}</span>
        <span>solver time <b>{mmss(sim)}</b></span>
        <span>runs <b>{s.runs.length}</b></span>
        <button className="link" onClick={s.toggleSound} title="Lego build sound">{s.sound ? 'sound on' : 'sound off'}</button>
        <button className="link" onClick={() => { if (confirm('Start over?')) s.reset() }}>reset</button>
      </div>
    </header>
  )
}

const BRAND = new URLSearchParams(location.search).get('name') ?? 'Smart EM'

// ---------------------------------------------------------------- left: spec sheet

const TAGS: Partial<Record<keyof Design, string>> = { L: 'Table 1', W: 'Table 1', y0: 'abstract', h: 'Table 1', er: 'fixed', gs: 'eq. 6' }

function SpecSheet({ t }: { t: number }) {
  const s = useDemo()
  const built = s.phase !== 'empty' && !(s.phase === 'reading' && t - s.phaseAt < (s.source === 'paper' ? READ_SECS : 2.4))
  const readT = s.phase === 'reading' ? t - s.phaseAt : 99
  const last = s.runs[s.runs.length - 1]
  const edited = last && !same(last.d, s.design)
  const locked = s.phase === 'tuning' || s.phase === 'solving' || !built
  return (
    <aside className="col left">
      <section className="sec">
        <h4>Goal</h4>
        <div className="goal">S11 below −10 dB<small>2.400 – 2.480 GHz · Wi-Fi / BLE</small></div>
      </section>
      <section className="sec">
        <h4>Source</h4>
        {s.pdf ? (
          <div className="src"><div className="doc" /><div><div className="ellip">{s.pdf.name}</div><div className="mono small mute">{s.source === 'paper' ? 'Table 1 · eq. (6) · Fig. 3' : 'attached'}</div></div></div>
        ) : s.source === 'text' ? <div className="src mute">Typed description · design equations</div> : <div className="src mute">Nothing yet</div>}
      </section>
      <section className="sec grow">
        <h4>Design <span>{built ? (locked ? 'locked while running' : 'drag to edit') : ''}</span></h4>
        {!built && <div className="mute small">{s.phase === 'reading' ? 'Pulling dimensions…' : 'Appears once the model is built.'}</div>}
        {VARS.map((v, i) => {
          const appear = s.source === 'paper' ? 0.6 + i * 0.5 : 0.3 + i * 0.25
          if (!built && readT < appear) return null
          const val = s.design[v.key] as number
          const fl = s.flash[v.key]
          const hot = fl !== undefined && t - fl < 1.6
          const orig = s.source === 'paper' ? PAPER_FIXED[v.key] : s.runs[0]?.d[v.key]
          const tag = orig !== undefined && Math.abs(val - orig) > 1e-6 ? (s.runs.some((r) => r.label.startsWith('Tune') && r.d[v.key] === val) ? 'tuned' : 'edited') : s.source === 'paper' ? TAGS[v.key] : 'eqs'
          return (
            <div key={v.key} className={`param fadein${hot ? ' hot' : ''}`}>
              <div className="param-h">
                <span>{v.name}{tag && <i className={tag !== 'Table 1' && tag !== 'abstract' && tag !== 'eqs' ? 're' : ''}>{tag}</i>}</span>
                <b>{v.fmt(val)}<small>{v.unit}</small></b>
              </div>
              <input type="range" min={v.min} max={v.max} step={v.step} value={val} disabled={locked}
                onChange={(e) => s.setVar(v.key, parseFloat(e.target.value))} />
            </div>
          )
        })}
      </section>
      {s.issues.length > 0 && (
        <section className="sec">
          <h4>Fixed from the paper <span>{s.issues.length}</span></h4>
          {s.issues.map((i) => <div key={i.title} className="issue"><b>!</b>{i.title}</div>)}
        </section>
      )}
      <section className="sec">
        <h4>Status</h4>
        {last ? (
          <>
            <div className="stat">resonance <b>{last.m.f0.toFixed(3)} GHz</b></div>
            <div className="stat">worst in band <b>{last.m.worst.toFixed(1)} dB</b></div>
            <div className="stat">bandwidth <b>{last.m.bw.toFixed(0)} MHz</b></div>
            <div className={`verdict ${last.m.worst <= GOAL.db ? 'good' : 'bad'}`}>{last.m.worst <= GOAL.db ? 'Goal met' : 'Goal not met'}{edited && <small>edited since</small>}</div>
          </>
        ) : <div className="mute small">No runs yet.</div>}
      </section>
    </aside>
  )
}

// ---------------------------------------------------------------- centre

function DropZone() {
  const attach = useDemo((s) => s.attach)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="drop">
      <div className="drop-in" onClick={() => input.current?.click()}>
        <div className="doc big" />
        <h2>Drop a paper here</h2>
        <p>or describe what you want in the chat on the right</p>
        <button className="btn">Choose a PDF</button>
        <input ref={input} type="file" accept="application/pdf" hidden onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])} />
      </div>
    </div>
  )
}

function Tabs() {
  const s = useDemo()
  const tabs: [Tab, string, boolean][] = [
    ['paper', 'Paper', !!s.pdf],
    ['model', '3D model', s.phase !== 'empty'],
    ['results', 'Results', s.runs.length > 0 || s.phase === 'solving'],
    ['explore', 'Explore', s.runs.length > 0],
  ]
  return (
    <div className="tabs">
      {tabs.map(([k, n, on]) => <button key={k} className={`tab${s.tab === k ? ' on' : ''}`} disabled={!on} onClick={() => s.setTab(k)}>{n}</button>)}
    </div>
  )
}

function ModelPane({ t }: { t: number }) {
  const s = useDemo()
  const readDur = s.source === 'paper' ? READ_SECS : 2.4
  const bt = s.phase === 'reading' ? t - s.phaseAt - readDur : 99
  const pulse = t - s.feedFocusAt < 6 ? t - s.feedFocusAt : 0
  return (
    <div className="pane-fill">
      <Suspense fallback={null}>
        <Scene3D d={s.design} bt={bt} current={s.runs.length ? 1 : 0} pulse={pulse} labels={bt > BUILD_SECS - 0.3} fixes={s.source === 'paper'} spin={s.phase !== 'empty'} />
      </Suspense>
      {s.phase === 'reading' && bt < 0 && <div className="overlay-note">Working out the geometry…</div>}
      {s.runs.length > 0 && <div className="cap-l">surface current at {s.runs[s.runs.length - 1].m.f0.toFixed(2)} GHz</div>}
      <div className="hint">drag to orbit · scroll to zoom</div>
      {s.phase === 'built' && <button className="btn sig big-action" onClick={s.solve}>Solve  →</button>}
    </div>
  )
}

const PLAN = [
  'Quick look, 2.1–2.8 GHz, coarse mesh',
  'Find where the answer is still moving',
  'Refine the mesh only at the patch edges and inset slots',
  'Detailed sweep around the resonance only',
  'Stop when the resonance moves less than 0.5 MHz',
]

function PlanCard({ t }: { t: number }) {
  const s = useDemo()
  const first = s.phase === 'solving' && s.solveKind === 'first'
  const e = first ? t - s.phaseAt : 99
  const stepAt = [0.2, 2.6, 3.8, 4.6, 6.4]
  const bars = clamp01((e - 1.2) / 1.2)
  return (
    <div className="card">
      <div className="card-h"><h3>How I'm solving it</h3><span className="aside">picked for this problem</span></div>
      <div className="card-b plan">
        <ol>
          {PLAN.map((p, i) => {
            const st = e < stepAt[i] ? 'wait' : i < 4 && e >= stepAt[i + 1] ? 'dn' : e >= SOLVE_SECS - 0.4 ? 'dn' : 'act'
            return e >= i * 0.25 && (
              <li key={p} className={`fadein ${st}`}><span className="ix">{i + 1}</span>{p}<span className="st">{st === 'dn' ? 'done' : st === 'act' ? 'running' : ''}</span></li>
            )
          })}
        </ol>
        <div className="why">One port, one resonance, a narrow band. Nothing outside 2.1–2.8 GHz matters, and most of the board is quiet.</div>
        <div className="cmp" style={{ marginTop: 14, opacity: bars }}>
          <span>Fine mesh everywhere, full sweep</span><div className="track"><div className="fill" style={{ width: `${bars * 100}%`, background: 'var(--faint)' }} /></div><span className="t">~25:00</span>
          <span><b>This plan</b></span><div className="track"><div className="fill" style={{ width: `${bars * 6.3}%`, background: 'var(--sig)' }} /></div><span className="t"><b>1:34</b></span>
        </div>
      </div>
    </div>
  )
}

function TuneCard({ t }: { t: number }) {
  const s = useDemo()
  const tuning = s.phase === 'tuning'
  const n = s.runs.filter((r) => r.label.startsWith('Tune')).length
  const k = tuning && !s.paused ? clamp01(1 - (s.nextRunAt - t) / TUNE_SECS) : 0
  const last = s.runs[s.runs.length - 1]
  return (
    <div className="card">
      <div className="card-h"><h3>{tuning ? 'Tuning on its own' : s.phase === 'done' ? 'Goal met' : 'Next step'}</h3><span className="aside">{tuning ? `run ${n + 1}` : ''}</span></div>
      <div className="card-b">
        {tuning ? (
          <>
            <p className="tight">Moving patch length and inset depth together until the whole band is under −10 dB. You can leave this running.</p>
            <div className="track thin"><div className="fill" style={{ width: `${k * 100}%`, background: s.paused ? 'var(--faint)' : 'var(--sig)' }} /></div>
            <div className="row-btns">
              <button className="btn" onClick={s.togglePause}>{s.paused ? 'Resume' : 'Pause'}</button>
              <button className="btn" onClick={s.takeOver}>Take over</button>
            </div>
          </>
        ) : s.phase === 'done' ? (
          <>
            <p className="tight">2.40–2.48 GHz covered after {s.runs.length} runs. Worst case <b>{last?.m.worst.toFixed(1)} dB</b>, bandwidth <b>{last?.m.bw.toFixed(0)} MHz</b>.</p>
            <div className="row-btns"><button className="btn pri" onClick={() => s.setTab('explore')}>See what drives it  →</button></div>
          </>
        ) : (
          <>
            <p className="tight">{last ? `Worst in-band match is ${last.m.worst.toFixed(1)} dB.` : ''} I can adjust the design until it meets the goal, or you can drag the sliders yourself.</p>
            <div className="row-btns"><button className="btn sig" onClick={s.tune}>Tune to goal</button></div>
          </>
        )}
      </div>
    </div>
  )
}

function S11Card({ t, height }: { t: number; height: number }) {
  const s = useDemo()
  const solvingFirst = s.phase === 'solving' && s.solveKind === 'first'
  const e = t - s.phaseAt
  const last = s.runs[s.runs.length - 1]
  const series: Series[] = []
  const points: { x: number; y: number; color: string; r?: number; hollow?: boolean }[] = []
  if (solvingFirst) {
    const c = curve(s.design)
    const coarse = FREQS.map((f, i) => ({ f, i })).filter((_, i) => i % 28 === 0)
    coarse.forEach(({ f, i }, j) => { if (e > 2.0 + j * 0.12) points.push({ x: f, y: c[i], color: 'var(--ink)', r: 3.5, hollow: true }) })
    const reveal = clamp01((e - 3.6) / 3.2)
    const n = Math.floor(reveal * FREQS.length)
    if (n > 1) series.push({ x: FREQS.slice(0, n), y: c.slice(0, n), color: 'var(--sig)', width: 2.4, dot: reveal < 1 })
  } else if (last) {
    s.runs.slice(0, -1).forEach((r) => series.push({ x: FREQS, y: curve(r.d), color: '#bdb6a6', width: 1.2 }))
    const to = curve(last.d)
    const k = clamp01((t - s.shown.at) / 0.8)
    const kk = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
    series.push({ x: FREQS, y: to.map((v, i) => lerp(s.shown.from[i] ?? v, v, kk)), color: 'var(--sig)', width: 2.6, label: `run ${last.n}` })
    if (!same(last.d, s.design)) series.push({ x: FREQS, y: curve(s.design), color: 'var(--cool)', width: 2, dash: '6 4', label: 'your edit (estimate)' })
  }
  const edited = last && !same(last.d, s.design) && s.phase !== 'tuning' && s.phase !== 'solving'
  return (
    <div className="card">
      <div className="card-h">
        <h3>Reflection, S11</h3>
        <span className="aside">{solvingFirst ? (e < 3.6 ? 'coarse pass' : 'refining near resonance') : last ? `run ${last.n} · ${last.label}` : ''}</span>
      </div>
      <div className="card-b chart">
        <LineChart height={height} xDomain={F_RANGE} yDomain={[-40, 1]} yTicks={[0, -10, -20, -30, -40]} xTicks={[2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8]}
          xLabel="frequency (GHz)" yLabel="dB" xFmt={(v) => v.toFixed(1)}
          vbands={[{ x1: GOAL.f1, x2: GOAL.f2, color: 'var(--ok)', opacity: 0.13 }]}
          hlines={[{ y: GOAL.db, color: 'var(--sig)', dash: '5 4', label: '−10 dB goal' }]}
          series={series} points={points} legend={series.some((x) => x.label === 'your edit (estimate)')} />
        {edited && <button className="btn pri float-btn" onClick={s.solve}>Solve this edit</button>}
      </div>
    </div>
  )
}

function RunsCard() {
  const runs = useDemo((s) => s.runs)
  return (
    <div className="card">
      <div className="card-h"><h3>Runs</h3><span className="aside">{runs.length ? `${runs.length} so far` : ''}</span></div>
      <div className="card-b" style={{ padding: 0 }}>
        <table className="runs">
          <thead><tr><th>#</th><th>what</th><th>length</th><th>inset</th><th>resonance</th><th>worst in band</th></tr></thead>
          <tbody>
            {runs.slice(-6).map((r, i, a) => (
              <tr key={r.n} className={`fadein${i === a.length - 1 ? ' cur' : ''}`}>
                <td>{r.n}</td><td>{r.label}</td><td>{r.d.L.toFixed(2)}</td><td>{r.d.y0.toFixed(2)}</td><td>{r.m.f0.toFixed(3)}</td>
                <td className={r.m.worst <= GOAL.db ? 'good' : 'bad'}>{r.m.worst.toFixed(1)} dB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ResultsPane({ t }: { t: number }) {
  const s = useDemo()
  const showPlan = s.phase === 'solving' && s.solveKind === 'first' || (s.runs.length === 1 && s.phase === 'solved' && t - s.phaseAt < 1.5)
  return (
    <div className="pane-grid results">
      <div className="stack">
        <S11Card t={t} height={360} />
        <RunsCard />
      </div>
      <div className="stack">
        {showPlan ? <PlanCard t={t} /> : <TuneCard t={t} />}
        {!showPlan && <SolveReport />}
        <div className="card mini3d">
          <Suspense fallback={null}>
            <Scene3D d={s.design} bt={99} current={s.runs.length ? 1 : 0} pulse={0} labels={false} fixes={false} spin far />
          </Suspense>
        </div>
      </div>
    </div>
  )
}

function Center({ t }: { t: number }) {
  const s = useDemo()
  const paperT = s.phase === 'reading' ? t - s.phaseAt : s.source === 'paper' ? null : -1
  return (
    <main className="col center">
      {(s.pdf || s.phase !== 'empty') && <Tabs />}
      <div className="pane-host">
        {!s.pdf && s.phase === 'empty' && <DropZone />}
        {s.pdf && s.tab === 'paper' && <PaperView data={s.pdf.data} name={s.pdf.name} t={paperT} reading={s.phase === 'reading'} onInfo={(pages, known) => useDemo.setState((st) => ({ pdf: st.pdf && { ...st.pdf, pages, known } }))} />}
        {s.tab === 'model' && s.phase !== 'empty' && <ModelPane t={t} />}
        {s.tab === 'results' && <ResultsPane t={t} />}
        {s.tab === 'explore' && s.runs.length > 0 && <ExplorePane />}
        {s.pdf && s.phase === 'empty' && s.tab === 'paper' && <div className="paper-prompt">Attached. Tell me what you want from it →</div>}
      </div>
    </main>
  )
}

// ---------------------------------------------------------------- chat

const QUESTIONS = [
  'Why did it keep moving the inset every time it changed the length?',
  'Can I get more bandwidth without making it bigger?',
  'Which parts of the patch matter most at the top of the band?',
  'What does substrate height do?',
  'What was wrong with the paper?',
  'Why did you solve it that way?',
]

function suggestion(s: ReturnType<typeof useDemo.getState>) {
  if (s.phase === 'empty') return s.pdf ? 'Build the antenna in this paper on real FR-4 and tune it to cover 2.40 to 2.48 GHz.' : 'Build a 2.4 GHz inset-fed patch on 1.6 mm FR-4 that covers 2.40 to 2.48 GHz.'
  if (s.phase === 'built') return 'Solve it.'
  if (s.phase === 'solved') return 'Tune it until the whole band is under −10 dB.'
  if (s.phase === 'done') {
    const asked = new Set(s.msgs.filter((m) => m.who === 'user').map((m) => m.text))
    return QUESTIONS.find((q) => !asked.has(q)) ?? ''
  }
  return ''
}

function Message({ m, t }: { m: Msg; t: number }) {
  if (m.who === 'user') {
    return (
      <div className="msg user">
        {m.attach && <div className="att"><div className="doc" />{m.attach}</div>}
        {m.text}
      </div>
    )
  }
  const n = Math.floor((t - m.at) * 110)
  const streaming = n < m.text.length
  const listDone = (m.list?.length ?? 0)
  const shownList = streaming ? 0 : Math.min(listDone, Math.floor((t - m.at - m.text.length / 110) / 0.35) + 1)
  const ready = !streaming && shownList >= listDone
  return (
    <div className="msg solver">
      <div className="who">solver</div>
      {m.text.slice(0, n)}{streaming && <span className="caret" />}
      {m.list && shownList > 0 && <ul className="mlist">{m.list.slice(0, shownList).map((l) => <li key={l} className="fadein">{l}</li>)}</ul>}
      {m.acts && ready && <div className="acts fadein">{m.acts.map((a) => <button key={a.label} className={`btn${a.primary ? ' sig' : ''}`} onClick={a.do}>{a.label}</button>)}</div>}
    </div>
  )
}

function Chat({ t }: { t: number }) {
  const s = useDemo()
  const ta = useRef<HTMLTextAreaElement>(null)
  const auto = useRef<{ text: string; start: number } | null>(null)
  const ghost = suggestion(s)
  // Tab "types" the suggestion at a human-ish speed, so it reads naturally on a screen recording
  if (auto.current) {
    const n = Math.floor((t - auto.current.start) * 38)
    const want = auto.current.text.slice(0, n)
    if (want !== s.draft) queueMicrotask(() => useDemo.getState().setDraft(want))
    if (n >= auto.current.text.length) auto.current = null
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && ghost && !s.draft) { e.preventDefault(); auto.current = { text: ghost, start: now() } }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); auto.current = null; s.send(s.draft) }
  }
  useEffect(() => { ta.current?.focus() }, [])
  const visible = s.msgs.filter((m) => m.at <= t)
  return (
    <aside className="col right">
      <div className="chat-h"><h4>Solver</h4><span>ask it anything about the design</span></div>
      <div className="thread">
        {visible.length === 0 && <div className="empty-chat">Drop in a paper or describe a structure. I'll build the model, pick how to solve it, and tune it to your spec. Ask me why anything happens.</div>}
        {visible.map((m) => <Message key={m.id} m={m} t={t} />)}
      </div>
      <div className="composer">
        {s.pdf && !s.pdfSent && <div className="chip-att"><div className="doc" />{s.pdf.name.length > 40 ? s.pdf.name.slice(0, 38) + '…' : s.pdf.name}</div>}
        <div className="box">
          <textarea ref={ta} rows={3} value={s.draft} onChange={(e) => { auto.current = null; s.setDraft(e.target.value) }} onKeyDown={onKey}
            placeholder={ghost ? `${ghost}` : 'Ask about the design…'} />
        </div>
        <div className="row">
          <span>{ghost && !s.draft ? 'tab to use the suggestion · enter to send' : 'enter to send'}</span>
          <button className={`send${s.draft ? ' go' : ''}`} onClick={() => s.send(s.draft)} aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 7h9M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
          </button>
        </div>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------- root

export default function Demo() {
  const t = useClock()
  const attach = useDemo((s) => s.attach)
  const [over, setOver] = useState(false)
  useEffect(() => {
    const dragover = (e: DragEvent) => { e.preventDefault(); setOver(true) }
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setOver(false) }
    const drop = (e: DragEvent) => {
      e.preventDefault(); setOver(false)
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'))
      if (f && useDemo.getState().phase === 'empty') attach(f)
    }
    window.addEventListener('dragover', dragover); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop)
    return () => { window.removeEventListener('dragover', dragover); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop) }
  }, [attach])
  return (
    <div className="stage">
      <TopBar t={t} />
      <div className="body">
        <SpecSheet t={t} />
        <Center t={t} />
        <Chat t={t} />
      </div>
      {over && <div className="dropping"><div>Drop the PDF</div></div>}
    </div>
  )
}
