import { useAppStore } from '../store/useAppStore'
import { TAB_META } from '../constants/tabs'

interface TabNavProps {
  variant: 'sidebar' | 'dock'
}

export function TabNav({ variant }: TabNavProps) {
  const active = useAppStore(s => s.activeTab)
  const setTab = useAppStore(s => s.setTab)

  if (variant === 'sidebar') {
    return (
      <nav className="nav-sidebar" aria-label="Primary">
        {TAB_META.map(tab => (
          <button
            key={tab.id}
            className={`nav-sidebar__item${active === tab.id ? ' active' : ''}`}
            onClick={() => setTab(tab.id)}
            type="button"
          >
            <span className="nav-sidebar__index">{tab.short}</span>
            <span className="nav-sidebar__body">
              <span className="nav-sidebar__label">{tab.label}</span>
              <span className="nav-sidebar__description">{tab.description}</span>
            </span>
          </button>
        ))}
      </nav>
    )
  }

  return (
    <nav className="nav-dock" aria-label="Quick navigation">
      {TAB_META.map(tab => (
        <button
          key={tab.id}
          className={`nav-dock__item${active === tab.id ? ' active' : ''}`}
          onClick={() => setTab(tab.id)}
          type="button"
        >
          <span className="nav-dock__index">{tab.short}</span>
          <span className="nav-dock__label">{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}
