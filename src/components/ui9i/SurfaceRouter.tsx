// UI-9I Phase 1/2A: UI 面（葉画面ではない面）の container 群。
import { useAppStore } from '../../store/useAppStore'
import { selectFundsHubViewModel, selectOtherHubViewModel } from '../../presentation/ui9i/hubPresentation'
import { selectPortfolioSurfaceViewModel } from '../../presentation/ui9i/portfolioSurface'
import { FundsHubView, OtherHubView, PortfolioSurfaceView } from './HubSurfaces'
import { useGoTo } from './useGoTo'

export function FundsHub() {
  const vm = useAppStore(state => selectFundsHubViewModel(state))
  const goTo = useGoTo()
  return <div className="u9"><FundsHubView vm={vm} onNavigate={goTo} /></div>
}

export function OtherHub() {
  const vm = useAppStore(state => selectOtherHubViewModel(state))
  const goTo = useGoTo()
  return <div className="u9"><OtherHubView vm={vm} onNavigate={goTo} /></div>
}

export function PortfolioSurface() {
  const vm = useAppStore(state => selectPortfolioSurfaceViewModel(state))
  const goTo = useGoTo()
  return <div className="u9"><PortfolioSurfaceView vm={vm} onNavigate={goTo} /></div>
}
