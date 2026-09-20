// UI-9I Phase 1: 視覚検証用 dev ハーネス（Vite dev 専用）。
// `dev/ui9i-harness.html?state=<scenario>` で、固定 fixture（canonical 入力）を
// 本番と同じ projector（assembleTodayHomeViewModel）→ 同じ view（TodayHomeView）→
// 同じ shell（UserSidebarNav / UserDockNav）で描画する。
// Phase 2A: `?view=pf|funds|other`（+ `&alloc=unavailable`）で PF 面 / 投信ハブ / その他ハブを
// 本番と同じ adapter → view で描画する。
// vite build の入力は index.html のみのため、本番バンドルには含まれない。
import { createRoot } from 'react-dom/client'
// 本番（App.tsx）と同じ Space Mono 供給元を使う（視覚検証がフォント代替にならないように）。
import '@fontsource/space-mono/latin-400.css'
import '@fontsource/space-mono/latin-700.css'
import '../styles/v10.css'
import '../styles/ui9i.css'
import { applyTheme } from '../theme/tokens'
import { assembleTodayHomeViewModel } from '../presentation/ui9i/todayHome'
import { scenarioInputs, type HomeScenario } from '../presentation/ui9i/ui9i.fixtures'
import { projectFundsHub, assembleOtherHub } from '../presentation/ui9i/hubPresentation'
import { projectPortfolio } from '../presentation/ui9i/portfolioPresentation'
import { UNAVAILABLE_ALLOCATION, fixtureAllocation } from '../presentation/ui9i/ui9i.fixtures'
import { useUiSurface } from '../store/uiSurface'
import { FundsHubView, OtherHubView, PortfolioSurfaceView } from '../components/ui9i/HubSurfaces'
import { TodayHomeView } from '../components/ui9i/TodayHomeView'
import { UserDockNav, UserSidebarNav } from '../components/ui9i/UserNav'

applyTheme()

const SCENARIOS: HomeScenario[] = ['normal', 'actionable', 'candidate_unavailable', 'safe_mode', 'data_wait', 'decision_unavailable', 'boot']
const requested = new URLSearchParams(window.location.search).get('state') as HomeScenario | null
const scenario: HomeScenario = requested !== null && SCENARIOS.includes(requested) ? requested : 'normal'
const vm = assembleTodayHomeViewModel(scenarioInputs(scenario))

const params = new URLSearchParams(window.location.search)
const view = params.get('view')
const allocUnavailable = params.get('alloc') === 'unavailable'
const pfProjection = projectPortfolio(allocUnavailable ? UNAVAILABLE_ALLOCATION : fixtureAllocation())
const noop = () => {}

function surfaceFor(v: string | null) {
  if (v === 'pf') {
    useUiSurface.getState().openSurface('pf')
    return (
      <PortfolioSurfaceView
        onNavigate={noop}
        vm={{
          portfolio: pfProjection,
          snapshotLabel: allocUnavailable ? null : '10/6 8:30',
          grossCash: allocUnavailable ? { kind: 'unknown' } : { kind: 'known', amountJpy: 2_660_000 },
          deployableCash: allocUnavailable ? { kind: 'unavailable' } : { kind: 'available', amountJpy: 1_200_000 },
        }}
      />
    )
  }
  if (v === 'funds') {
    useUiSurface.getState().openSurface('funds_hub')
    return <FundsHubView vm={projectFundsHub(pfProjection)} onNavigate={noop} />
  }
  if (v === 'other') {
    useUiSurface.getState().openSurface('other_hub')
    return (
      <OtherHubView
        onNavigate={noop}
        vm={assembleOtherHub({
          decisionGeneratedAt: '2026-10-06T08:30:00+09:00',
          marketAt: '2026-10-06 08:30',
          candidatesAt: '2026-10-06T07:55:00+09:00',
        })}
      />
    )
  }
  return null
}
const surface = surfaceFor(view)

createRoot(document.getElementById('root')!).render(
  <div className="app-shell" data-ui9i="true" data-harness-state={scenario}>
    <div className="app-shell-body">
      <UserSidebarNav />
      <main className="main-content u9-main">
        <div className="u9">
          {surface ?? (
            <TodayHomeView
              vm={vm}
              dateLabel="10月6日（月）"
              yearLabel="2026年"
              actions={{ onOpenAudit: () => {}, onOpenPortfolio: () => {}, onOpenCandidates: () => {} }}
            />
          )}
        </div>
      </main>
    </div>
    <UserDockNav />
  </div>,
)
