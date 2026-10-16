import { create } from 'zustand'

/**
 * Light or dark. CSS follows the data-theme attribute on <html>; the 3D views and canvas charts, which can't read
 * CSS variables, read `dark` from here. Starts from the saved choice, else the system setting.
 */
const KEY = 'smartem-theme'
const saved = (() => { try { return localStorage.getItem(KEY) } catch { return null } })()
const initial = saved ? saved === 'dark' : typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
const apply = (dark: boolean) => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }
apply(initial)

export const useTheme = create<{ dark: boolean; toggle: () => void }>((set, get) => ({
  dark: initial,
  toggle: () => {
    const dark = !get().dark
    apply(dark)
    try { localStorage.setItem(KEY, dark ? 'dark' : 'light') } catch { /* private window: just don't remember */ }
    set({ dark })
  },
}))

/** Colours for things drawn outside CSS (WebGL edges, grids, canvas ramps). */
export const ink3d = (dark: boolean) => (dark ? '#d9d3c6' : '#1c1b18')
