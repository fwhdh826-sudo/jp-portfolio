// UI-9I Phase 1: 視覚検証用 dev ハーネス（Vite dev 専用）。
// `dev/ui9i-harness.html?state=<scenario>` で、固定 fixture（canonical 入力）を
// 本番と同じ projector（assembleTodayHomeViewModel）→ 同じ view（TodayHomeView）→
// 同じ shell（UserSidebarNav / UserDockNav）で描画する。
// Phase 2A: `?view=pf|funds|other`（+ `&alloc=unavailable`）で PF 面 / 投信ハブ / その他ハブを
// 本番と同じ adapter → view で描画する。
// vite build の入力は index.html のみのため、本番バンドルには含まれない。
import { useReducer } from 'react'
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
import {
  FIXTURE_NOW_MS,
  UNAVAILABLE_ALLOCATION,
  fixtureAllocation,
  fixtureDecision,
  fixtureEntry,
  fixtureExecutableDecision,
  fixtureReviewWatchList,
  fixtureStockHoldings,
  fixtureSynthesis,
} from '../presentation/ui9i/ui9i.fixtures'
import { assembleStockDetail, assembleStocksList, type DecisionContext } from '../presentation/ui9i/stocksPresentation'
import { useAppStore } from '../store/useAppStore'
import { useUiSurface } from '../store/uiSurface'
import { FundsHubView, OtherHubView, PortfolioSurfaceView } from '../components/ui9i/HubSurfaces'
import { StockDetailView, StocksListView } from '../components/ui9i/StocksViews'
import {
  CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
  CandidateFunnelPanelView,
  candidateFunnelViewReducer,
} from '../components/candidates/CandidateFunnelPanel'
import {
  CANDIDATE_FUNNEL_SCENARIO_NAMES,
  candidateFunnelScenario,
  type CandidateFunnelScenario,
  type CandidateFunnelScenarioName,
} from '../components/candidates/candidateFunnel.scenarios'
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

// Phase 2B-1R: 本番の個別株一覧は「一覧 + 市場候補ファネル」の合成（T1_Decision の funnelSlot）。
// `&funnel=normal|warning|quality|empty|unavailable|invalid` で実 CandidateFunnelPanelView を同じ位置に描画する
// （既定 normal、`&funnel=none` で非表示）。フィルタ / さらに表示は本番と同じ reducer で動く。
function FunnelHarness({ scenario: s }: { scenario: CandidateFunnelScenario }) {
  const [viewState, dispatch] = useReducer(candidateFunnelViewReducer, CANDIDATE_FUNNEL_INITIAL_VIEW_STATE)
  return (
    <CandidateFunnelPanelView
      artifact={s.artifact}
      freshness={s.freshness}
      portfolioFit={s.portfolioFit}
      viewState={viewState}
      onAction={dispatch}
      nowMs={s.nowMs}
    />
  )
}
const funnelParam = params.get('funnel')
const funnelName: CandidateFunnelScenarioName | null =
  funnelParam === 'none'
    ? null
    : CANDIDATE_FUNNEL_SCENARIO_NAMES.find(n => n === funnelParam) ?? 'normal'

// Phase 2B-1: `?view=stocks`（一覧）/ `?view=stocks&code=8306`（詳細）。`&mode=safe_mode` で SAFE_MODE 中の同一銘柄を確認できる。
function stocksSurface() {
  useAppStore.setState({ activeTab: 'T1' })
  const safe = params.get('mode') === 'safe_mode'
  const code = params.get('code')
  const { holdings, analysis } = fixtureStockHoldings()
  const decisionContext: DecisionContext = {
    officialDecision: fixtureDecision(), dqSuppressed: false, capExceeded: false, safeModeActive: safe,
    now: new Date(FIXTURE_NOW_MS),
  }
  const heroState = safe ? 'safe_mode' : 'normal'
  const synthesis = fixtureSynthesis(
    safe ? [] : [fixtureExecutableDecision()],
    [...fixtureReviewWatchList().slice(1), fixtureEntry('8058', { displayName: '三菱商事', action: 'BLOCKED', relationship: 'new_to_portfolio', blockingReasons: ['CLASS_FULL'] })],
  )
  const common = { holdings, analysis, decisionContext, analysisLastRunAt: '2026-10-06T08:30:00+09:00', holdingsStale: false, synthesis, rawCandidates: [], heroState } as const
  if (code !== null) {
    return <StockDetailView vm={assembleStockDetail({ ...common, code, stockScores6Axis: null })} onBack={noop} />
  }
  const funnel = funnelName === null ? null : candidateFunnelScenario(funnelName)
  const rawFunnelAvailable = funnel !== null && funnel.artifact !== null && funnel.freshness !== 'invalid' && funnel.freshness !== 'unavailable'
  return (
    <StocksListView
      vm={assembleStocksList({ ...common, dqReason: null, portfolioStale: false, rawFunnelAvailable })}
      onSelect={noop}
      funnelSlot={funnel === null ? undefined : <FunnelHarness scenario={funnel} />}
    />
  )
}

function surfaceFor(v: string | null) {
  if (v === 'stocks') return stocksSurface()
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
