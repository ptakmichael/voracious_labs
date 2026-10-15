import { useEffect, useRef, useState } from 'react'
import { approve, cancelRun, sendChat } from '../api'
import { useStore } from '../store'
import { useTheme, type ThemeMode } from '../theme'
import { STAGES, type Stage } from '../types'
import { Check, Logo, Send, Stop } from './Icons'

const AUTONOMY_LABEL = { ask: 'Ask me first', balanced: 'Balanced', auto: 'Fully autonomous' }

export function TopBar() {
  const { project, run, view, setView, caps, setProject } = useStore()
  const { mode, setMode } = useTheme()
  const label = (s: Stage) => (s === 'setup' ? 'Model' : s[0].toUpperCase() + s.slice(1))
  const running = run.id && !run.finished
  return (
    <header className="topbar">
      <div className="brand"><Logo /> <span className="brand-text">Smart EM Solver</span></div>
      <div className="projname">
        Project:{' '}
        <input value={project.name} disabled={!!running} aria-label="Project name"
          onChange={(e) => setProject((p) => ({ ...p, name: e.target.value.replace(/\s+/g, '_') }))} />
      </div>
      <nav className="pills" aria-label="Stages">
        {STAGES.map((s, i) => {
          const cur = run.id ? STAGES.indexOf(run.stage) : 0
          const isCurrent = i === cur
          const done = !!run.id && !isCurrent && i <= Math.max(run.maxStage, cur) && (i < cur || i <= run.maxStage)
          return (
            <button key={s} className={`pill ${isCurrent ? 'current' : done ? 'done' : ''} ${view === s ? 'viewing' : ''}`}
              onClick={() => setView(s, true)} aria-current={view === s ? 'page' : undefined}>
              {done && <Check size={14} />}{label(s)}
            </button>
          )
        })}
      </nav>
      <div className="spacer" />
      <div className="chips">
      {running && <button className="chip" style={{ background: 'transparent', cursor: 'pointer' }} onClick={() => cancelRun()}><Stop size={13} /> Stop run</button>}
      <span className="chip" title={caps?.model ? `Orchestrator: ${caps.label} (${caps.model})` : 'No LLM key on the backend; using the scripted orchestrator'}>
        <span className={`dot ${caps?.model ? '' : 'off'}`} />
        {caps?.offline ? 'Backend offline' : `${caps?.label ?? 'Scripted'} orchestrator`}
      </span>
      <span className="chip warn" title="openEMS and Palace are not installed; every result is from the mock solver">Mock solvers</span>
      <span className="chip">Autonomy: {AUTONOMY_LABEL[project.settings.autonomy]}</span>
      <select className="chip theme-select" value={mode} onChange={(e) => setMode(e.target.value as ThemeMode)} aria-label="Colour theme" title="Colour theme (Auto follows your system setting)">
        <option value="system">◐ Auto</option>
        <option value="light">☀ Light</option>
        <option value="dark">☾ Dark</option>
      </select>
      </div>
    </header>
  )
}

const fmtT = (t: number) => {
  const s = Math.floor(t)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function EventLog({ filter, title = 'Event log' }: { filter?: (l: any) => boolean; title?: string }) {
  const logs = useStore((s) => s.run.logs)
  const ref = useRef<HTMLDivElement>(null)
  const items = filter ? logs.filter(filter) : logs
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }) }, [items.length])
  return (
    <section className="panel">
      <div className="panel-head"><h2>{title}</h2><span className="sub">{items.length} events</span></div>
      <div className="log" ref={ref}>
        {items.length === 0 && <div className="muted small">Waiting for the orchestrator…</div>}
        {items.map((l, i) => (
          <div key={i} className={`log-line ${l.level} ${l.you ? 'you' : ''}`}>
            <span className="ts">{fmtT(l.t)}</span>
            <span className="tx">{l.you ? <><b>You:</b> {l.text}</> : l.text}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

export function Composer({ onQuick }: { onQuick?: (q: string) => boolean }) {
  const { chat, run } = useStore()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const last = chat.slice(-2)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const quick: string[] = run.awaiting?.quick_replies
    ?? (run.finished && run.results ? ['Add gain patterns', 'Export report', 'Start a new design'] : [])

  const send = async (t: string) => {
    if (!t.trim()) return
    setBusy(true)
    try {
      await sendChat(t.trim())
    } catch {
      useStore.getState().pushChat({ role: 'solver', text: 'I could not reach the backend. Is it running on port 8000?' })
    } finally {
      setBusy(false)
    }
  }
  const quickClick = async (q: string) => {
    if (onQuick?.(q)) return
    if (run.awaiting && /^(looks good|approve)$/i.test(q)) {
      await approve(run.awaiting.target)
      return
    }
    send(q)
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        {last.map((m, i) => (
          <p key={chat.length - last.length + i} className={`last-msg ${m.role === 'user' ? 'you' : ''}`}>
            <b>{m.role === 'user' ? 'You' : 'Solver'} ·</b> {m.text}
          </p>
        ))}
        {chat.length > 2 && <button className="show-all" onClick={() => setOpen(true)}>Show full conversation ({chat.length})</button>}
        {quick.length > 0 && (
          <div className="quick">{quick.map((q) => <button key={q} onClick={() => quickClick(q)}>{q}</button>)}</div>
        )}
        <form className="input-bar" onSubmit={(e) => { e.preventDefault(); const t = text; setText(''); send(t) }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder='Message the solver, e.g. “use FEM” or “why this mesh?”' aria-label="Message the solver" />
          <button className="send" disabled={busy || !text.trim()} aria-label="Send"><Send size={19} /></button>
        </form>
      </div>
      {open && (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-head"><h2>Conversation</h2><button className="btn sm" onClick={() => setOpen(false)}>Close</button></div>
            <div className="convo">
              {chat.map((m, i) => <p key={i} className={m.role === 'user' ? 'you' : ''}><b>{m.role === 'user' ? 'You' : 'Solver'} ·</b> {m.text}</p>)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function MockBadge() {
  return <span className="badge-mock" title="openEMS / Palace not installed">MOCK · not a real simulation</span>
}
