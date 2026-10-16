import { useEffect, useRef, useState } from 'react'
import { useModel } from '../modeler/model'
import { commandNames, runLine } from './commands'
import { useStudio } from './store'

/** Bottom dock: the command line (commands and questions for the solver) and the message log. */
export function Console() {
  const st = useStudio()
  const msgs = useModel((m) => m.msgs)
  const [draft, setDraft] = useState('')
  const [hi, setHi] = useState(-1) // position in history while browsing with ↑/↓
  const outRef = useRef<HTMLDivElement>(null)
  const inRef = useRef<HTMLInputElement>(null)
  useEffect(() => { outRef.current?.scrollTo(0, 1e9) }, [st.lines.length, msgs.length, st.dock])
  // typing anywhere outside a field goes to the command line, like AutoCAD
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === ':' || e.key === '?') { e.preventDefault(); inRef.current?.focus(); if (e.key === '?') setDraft('?') }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])
  const submit = () => { const l = draft; setDraft(''); setHi(-1); void runLine(l) }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); return }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const h = st.hist
      if (!h.length) return
      const i = e.key === 'ArrowUp' ? (hi < 0 ? h.length - 1 : Math.max(0, hi - 1)) : hi < 0 ? -1 : hi + 1
      if (i < 0 || i >= h.length) { setHi(-1); setDraft(''); return }
      setHi(i); setDraft(h[i])
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const w = draft.trim().toLowerCase()
      const hits = commandNames.filter((c) => c.startsWith(w))
      if (hits.length === 1) setDraft(hits[0] + ' ')
      else if (hits.length > 1) st.print('sys', hits.join('  '))
    }
    if (e.key === 'Escape') { setDraft(''); inRef.current?.blur() }
  }
  return (
    <div className="cn">
      <div className="cn-tabs">
        <button className={st.dock === 'console' ? 'on' : ''} onClick={() => st.set({ dock: 'console' })}>Console</button>
        <button className={st.dock === 'messages' ? 'on' : ''} onClick={() => st.set({ dock: 'messages' })}>Messages{msgs.some((m) => m.kind === 'warn' || m.kind === 'err') ? <i className="cn-dot" /> : null}</button>
        <span className="cn-hint">type a command or a question · Tab completes · ↑ history · : or ? to focus</span>
      </div>
      <div className="cn-out" ref={outRef} onClick={() => { if (!window.getSelection()?.toString()) inRef.current?.focus() }}>
        {st.dock === 'console'
          ? st.lines.map((l) => l.kind === 'sug'
            ? <div key={l.id} className="cl sug"><button onClick={(e) => { e.stopPropagation(); void runLine(l.text) }} title="Run this">$ {l.text}</button></div>
            : <div key={l.id} className={`cl ${l.kind}`}>{l.kind === 'in' ? <><b>›</b>{l.text}</> : l.kind === 'ai' ? <><b>solver</b>{l.text}</> : l.text}</div>)
          : msgs.map((m) => <div key={m.id} className={`cl msg ${m.kind}`}><b>{m.kind === 'ok' ? '✓' : m.kind === 'warn' ? '!' : m.kind === 'err' ? '✕' : 'i'}</b>{m.text}</div>)}
      </div>
      <div className="cn-in">
        <span>›</span>
        <input ref={inRef} value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
          placeholder={st.kind ? 'e.g.  report dB(S(1,1))   ·   set L 29.2   ·   why is the match poor at 2.48 GHz?' : 'insert patch  ·  insert array  ·  import paper  ·  help'} aria-label="Command line" />
      </div>
    </div>
  )
}
