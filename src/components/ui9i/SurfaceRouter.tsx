// UI-9I Phase 1: UI 面（葉画面ではない面）の container 群。
import { useAppStore } from '../../store/useAppStore'
import { selectPortfolioSurfaceViewModel } from '../../presentation/ui9i/portfolioSurface'
import { FundsHubView, OtherHubView, PortfolioSurfaceView } from './HubSurfaces'
import { useGoTo } from './useGoTo'

export function FundsHub() {
  const goTo = useGoTo()
  return <div className="u9"><FundsHubView onNavigate={goTo} /></div>
}

export function OtherHub() {
  const goTo = useGoTo()
  return <div className="u9"><OtherHubView onNavigate={goTo} /></div>
}

export function PortfolioSurface() {
  const vm = useAppStore(state => selectPortfolioSurfaceViewModel(state))
  const goTo = useGoTo()
  return <div className="u9"><PortfolioSurfaceView vm={vm} onNavigate={goTo} /></div>
}
