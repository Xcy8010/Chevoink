import {
  BookCopy,
  Brain,
  Network,
  GitCompareArrows,
  PanelLeftClose,
  PanelLeftOpen,
  Wrench,
} from 'lucide-react'

import type { WorkInspectorTab } from './WorkInspector'

export type IdeRailProps = {
  tab: WorkInspectorTab
  open: boolean
  onSelect: (tab: WorkInspectorTab) => void
  onToggle: () => void
  more?: boolean
}

const navigationItems = [
  { key: 'work' as const, label: '作品', icon: BookCopy },
  { key: 'memory' as const, label: '关系网', icon: Network },
  { key: 'context' as const, label: '记忆', icon: Brain },
  { key: 'changes' as const, label: '变更', icon: GitCompareArrows },
  { key: 'skills' as const, label: '技能', icon: Wrench },
]

/** Work and changes stay one click away, additional tools share the rail's More card. */
export default function IdeNavigationRail({ tab, open, onSelect, onToggle, more = false }: IdeRailProps) {
  const items = navigationItems.filter(item => (item.key === 'work' || item.key === 'changes') !== more)
  return <>
    {!more && <button type="button" onClick={onToggle} className="studio-rail-button"
      aria-label={open ? '收起左侧面板' : '展开左侧面板'}>
      {open ? <PanelLeftClose /> : <PanelLeftOpen />}
    </button>}
    {items.map(({ key, label, icon: Icon }) => (
      <button key={key} type="button" onClick={() => onSelect(key)}
        className={more ? undefined : 'studio-rail-button'} aria-label={label} aria-pressed={tab === key && open}>
        <Icon />{more && label}
      </button>
    ))}
  </>
}
