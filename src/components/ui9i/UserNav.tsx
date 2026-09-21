// UI-9I Phase 1: ユーザー向けナビ（モバイル下部 / デスクトップ左サイドバー）。
// 内部 T 番号は露出しない。
// モバイル: 今日 / 個別株 / 投信 / PF / その他。
// デスクトップ: 今日 / 個別株 / 投信 / ポートフォリオ / ニュース / その他。
import { useAppStore } from '../../store/useAppStore'
import { useUiSurface } from '../../store/uiSurface'
import {
  DESKTOP_NAV,
  DESKTOP_NAV_TARGET,
  PRIMARY_NAV,
  PRIMARY_NAV_TARGET,
  resolveDesktopNav,
  resolvePrimaryNav,
} from '../../presentation/ui9i/navigation'
import { APP_VERSION_LABEL } from '../../presentation/ui9i/labels'
import { useGoTo } from './useGoTo'

function useActivePrimary() {
  const activeTab = useAppStore(s => s.activeTab)
  const surface = useUiSurface(s => s.surface)
  return resolvePrimaryNav(activeTab, surface)
}

function useActiveDesktop() {
  const activeTab = useAppStore(s => s.activeTab)
  const surface = useUiSurface(s => s.surface)
  return resolveDesktopNav(activeTab, surface)
}

export function UserDockNav() {
  const active = useActivePrimary()
  const goTo = useGoTo()
  return (
    <nav className="u9 u9-dock" aria-label="メインナビゲーション">
      {PRIMARY_NAV.map(item => (
        <button
          key={item.id}
          type="button"
          className={`u9-dock__item${active === item.id ? ' is-active' : ''}`}
          aria-current={active === item.id ? 'page' : undefined}
          onClick={() => goTo(PRIMARY_NAV_TARGET[item.id])}
        >
          <span className="u9-dock__glyph" aria-hidden="true">{item.glyph}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}

export function UserSidebarNav() {
  const active = useActiveDesktop()
  const goTo = useGoTo()
  return (
    <nav className="u9 u9-sidebar" aria-label="サイドナビゲーション">
      <span className="u9-sidebar__brand">Investment OS</span>
      {DESKTOP_NAV.map(item => (
        <button
          key={item.id}
          type="button"
          className={`u9-sidebar__item${active === item.id ? ' is-active' : ''}`}
          aria-current={active === item.id ? 'page' : undefined}
          onClick={() => goTo(DESKTOP_NAV_TARGET[item.id])}
        >
          {item.label}
        </button>
      ))}
      <span className="u9-sidebar__foot">v{APP_VERSION_LABEL}</span>
    </nav>
  )
}
