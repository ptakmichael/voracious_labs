import { type ReactNode, useState } from 'react'

/** A project-manager tree: folders open and close, rows can be selected, and rows can carry a control on the right. */
export interface TNode {
  id: string
  label: ReactNode
  icon?: ReactNode
  children?: TNode[]
  open?: boolean
  selected?: boolean
  muted?: boolean
  badge?: string
  right?: ReactNode
  onClick?: () => void
}

export const Ico = {
  project: <svg width="13" height="13" viewBox="0 0 13 13"><rect x="1" y="2.5" width="11" height="8.5" fill="none" stroke="currentColor" /><path d="M1 4.5h11" stroke="currentColor" /></svg>,
  design: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M6.5 1.5l5 5-5 5-5-5z" fill="none" stroke="currentColor" /></svg>,
  folder: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M1 3h4l1 1.5h6V11H1z" fill="none" stroke="currentColor" /></svg>,
  solid: (c: string) => <svg width="13" height="13" viewBox="0 0 13 13"><path d="M2 4l4.5-2.5L11 4v5L6.5 11.5 2 9z" fill={c} stroke="var(--ink)" strokeWidth=".8" /></svg>,
  sheet: (c: string) => <svg width="13" height="13" viewBox="0 0 13 13"><path d="M1.5 8.5l4-4h6l-4 4z" fill={c} stroke="var(--ink)" strokeWidth=".8" /></svg>,
  port: <svg width="13" height="13" viewBox="0 0 13 13"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="#cf4520" strokeWidth="1.4" /><circle cx="6.5" cy="6.5" r="1.6" fill="#cf4520" /></svg>,
  boundary: <svg width="13" height="13" viewBox="0 0 13 13"><rect x="1.5" y="1.5" width="10" height="10" fill="none" stroke="var(--cool)" strokeDasharray="2 1.5" /></svg>,
  analysis: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M1 8c2-6 3-6 4 0s2 6 3 0 2-5 4-1" fill="none" stroke="currentColor" /></svg>,
  results: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M1.5 11.5v-9M1.5 11.5h10M3.5 9l2.5-3 2 2 3-4" fill="none" stroke="currentColor" /></svg>,
  axes: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M2 11V2M2 11h9M2 11l5-4" fill="none" stroke="currentColor" /></svg>,
  mesh: <svg width="13" height="13" viewBox="0 0 13 13"><path d="M1.5 11.5l5-10 5 10zM4 6.5h5M6.5 11.5L4 6.5M6.5 11.5L9 6.5" fill="none" stroke="currentColor" strokeWidth=".9" /></svg>,
}

function Row({ n, depth }: { n: TNode; depth: number }) {
  const [open, setOpen] = useState(n.open ?? true)
  const kids = n.children ?? []
  return (
    <>
      <div className={`tr-row${n.selected ? ' on' : ''}${n.muted ? ' muted' : ''}${n.onClick ? ' click' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => { if (n.onClick) n.onClick(); else if (kids.length) setOpen(!open) }}>
        <span className="tr-car" onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>{kids.length ? (open ? '▾' : '▸') : ''}</span>
        {n.icon && <span className="tr-ico">{n.icon}</span>}
        <span className="tr-lbl">{n.label}</span>
        {n.badge && <span className="tr-badge">{n.badge}</span>}
        {n.right && <span className="tr-right" onClick={(e) => e.stopPropagation()}>{n.right}</span>}
      </div>
      {open && kids.map((k) => <Row key={k.id} n={k} depth={depth + 1} />)}
    </>
  )
}

export function Tree({ nodes }: { nodes: TNode[] }) {
  return <div className="tree-pm">{nodes.map((n) => <Row key={n.id} n={n} depth={0} />)}</div>
}
