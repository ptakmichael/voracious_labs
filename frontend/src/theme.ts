import { create } from 'zustand'

export type ThemeMode = 'system' | 'light' | 'dark'
export type Resolved = 'light' | 'dark'

const KEY = 'emsolver.theme'
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage blocked */ }
  return 'system'
}

const resolve = (m: ThemeMode): Resolved => (m === 'system' ? (media?.matches ? 'dark' : 'light') : m)

function apply(r: Resolved) {
  document.documentElement.dataset.theme = r
}

interface ThemeStore {
  mode: ThemeMode
  resolved: Resolved
  setMode: (m: ThemeMode) => void
}

export const useTheme = create<ThemeStore>((set) => {
  const mode = readMode()
  const resolved = resolve(mode)
  apply(resolved) // before first render, so there's no light flash
  media?.addEventListener('change', () => {
    const { mode: m } = useTheme.getState()
    if (m !== 'system') return
    const r = resolve(m)
    apply(r)
    set({ resolved: r })
  })
  return {
    mode,
    resolved,
    setMode: (m) => {
      try { localStorage.setItem(KEY, m) } catch { /* storage blocked */ }
      const r = resolve(m)
      apply(r)
      set({ mode: m, resolved: r })
    },
  }
})

/** Colours for WebGL scenes, which can't read CSS variables. */
export const SCENE = {
  light: { background: '#f3f5f9', cell: '#dfe4ec', section: '#c7cfdb', ink: '#14213d', air: '#2c5d9e' },
  dark: { background: '#0f1828', cell: '#1f2b40', section: '#2c3a54', ink: '#c8d1df', air: '#7fa8e3' },
}
export const useScene = () => SCENE[useTheme((s) => s.resolved)]
