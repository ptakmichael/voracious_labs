import { useEffect } from 'react'
import { exportUrl, loadCaps } from './api'
import { useStore } from './store'
import { Composer, TopBar } from './components/Shell'
import SetupPage from './setup/SetupPage'
import { AnalyzePage, ResultsPage, SolvePage, VerifyPage } from './pages/RunPages'

export default function App() {
  const view = useStore((s) => s.view)
  useEffect(() => { loadCaps() }, [])
  useEffect(() => { window.scrollTo({ top: 0 }) }, [view])
  const onQuick = (q: string) => {
    const st = useStore.getState()
    if (q === 'Export report') { window.open(exportUrl('report'), '_blank'); return true }
    if (q === 'Start a new design') {
      st.resetRun(null)
      st.setView('setup', true)
      st.pushChat({ role: 'solver', text: 'Back to the Model tab. Edit the geometry or goals and press Run.' })
      return true
    }
    if (q === 'Add gain patterns') {
      st.pushChat({ role: 'user', text: q })
      st.pushChat({ role: 'solver', text: 'Added E- and H-plane patterns under Results › Far-field. They are an analytic cavity-model estimate; a field-based post-processor is coming soon.' })
      st.setProject((p) => ({ ...p, settings: { ...p.settings, plots: [...new Set([...p.settings.plots, 'farfield'])] } }))
      return true
    }
    return false
  }
  return (
    <div className="app">
      <TopBar />
      <main className="content">
        {view === 'setup' && <SetupPage />}
        {view === 'analyze' && <AnalyzePage />}
        {view === 'solve' && <SolvePage />}
        {view === 'verify' && <VerifyPage />}
        {view === 'results' && <ResultsPage />}
      </main>
      <Composer onQuick={onQuick} />
    </div>
  )
}
