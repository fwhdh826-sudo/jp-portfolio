import { useAppStore } from '../store/useAppStore'
import type { TabId } from '../types'

const TABS: { id: TabId; icon: string; label: string }[] = [
  { id: 'T1', icon: '⚡', label: '判断' },
  { id: 'T2', icon: '📊', label: 'PF分析' },
  { id: 'T3', icon: '🔬', label: '分析' },
  { id: 'T4', icon: '🛡', label: 'リスク' },
  { id: 'T5', icon: '💹', label: '売買' },
  { id: 'T6', icon: '📂', label: '更新' },
  { id: 'T7', icon: '💼', label: '投信' },
]

export function TabNav() {
  const active = useAppStore(s => s.activeTab)
  const setTab = useAppStore(s => s.setTab)

  return (
    <nav className="bot-nav">
      {TABS.map(t => (
        <button
          key={t.id}
          className={`nav-btn${active === t.id ? ' active' : ''}`}
          onClick={() => setTab(t.id)}
        >
          <span className="nav-ico">{t.icon}</span>
          <span className="nav-lbl">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
