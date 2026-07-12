import { useAppStore } from '../store/useAppStore'
import { TAB_META } from '../constants/tabs'

export function TabNav() {
  const active = useAppStore(s => s.activeTab)
  const setTab = useAppStore(s => s.setTab)

  return (
    <nav className="tab-nav" aria-label="メインナビゲーション">
      {TAB_META.map(tab => (
        <button
          key={tab.id}
          className={`tab-nav__item${active === tab.id ? ' active' : ''}`}
          onClick={() => setTab(tab.id)}
          type="button"
          aria-selected={active === tab.id}
          title={tab.title}
        >
          <span className="tab-nav__icon" aria-hidden="true">{tab.icon}</span>
          <span className="tab-nav__label">{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}
