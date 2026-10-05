type P = { size?: number }
const s = (size = 16) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const })

export const Check = ({ size }: P) => <svg {...s(size)}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
export const X = ({ size }: P) => <svg {...s(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>
export const Play = ({ size }: P) => <svg {...s(size)}><path d="M7 5l12 7-12 7z" /></svg>
export const Send = ({ size }: P) => <svg {...s(size)}><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></svg>
export const Box = ({ size }: P) => <svg {...s(size)}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>
export const Cyl = ({ size }: P) => <svg {...s(size)}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /></svg>
export const Sheet = ({ size }: P) => <svg {...s(size)}><path d="M3 15l7-7h11l-7 7z" /></svg>
export const Port = ({ size }: P) => <svg {...s(size)}><circle cx="12" cy="7" r="3" /><path d="M12 10v10" /></svg>
export const Trash = ({ size }: P) => <svg {...s(size)}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>
export const Copy = ({ size }: P) => <svg {...s(size)}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></svg>
export const Eye = ({ size }: P) => <svg {...s(size)}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
export const EyeOff = ({ size }: P) => <svg {...s(size)}><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.2-1" /></svg>
export const Upload = ({ size }: P) => <svg {...s(size)}><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></svg>
export const Download = ({ size }: P) => <svg {...s(size)}><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></svg>
export const Move = ({ size }: P) => <svg {...s(size)}><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" /></svg>
export const Cursor = ({ size }: P) => <svg {...s(size)}><path d="M5 3l14 8-6 2-2 6z" /></svg>
export const Grid = ({ size }: P) => <svg {...s(size)}><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
export const Wand = ({ size }: P) => <svg {...s(size)}><path d="M4 20L16 8M14 4v2M20 10h-2M18 6l-1.5 1.5M12 2l.5 1.5" /></svg>
export const Layers = ({ size }: P) => <svg {...s(size)}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>
export const Fit = ({ size }: P) => <svg {...s(size)}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
export const Stop = ({ size }: P) => <svg {...s(size)}><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
export const Logo = ({ size = 26 }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#22345c" /><path d="M5 18c3 0 3-8 6-8s3 12 6 12 3-8 6-8 3 4 4 4" fill="none" stroke="#e07a45" strokeWidth="2.6" strokeLinecap="round" /></svg>
)
export const Undo = ({ size }: P) => <svg {...s(size)}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
export const Redo = ({ size }: P) => <svg {...s(size)}><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
