// UI-9I Phase 1: 視覚検証用 dev ハーネス（Vite dev 専用）。
// `dev/ui9i-harness.html?state=<scenario>` で、固定 fixture（canonical 入力）を
// 本番と同じ projector（assembleTodayHomeViewModel）→ 同じ view（TodayHomeView）→
// 同じ shell（UserSidebarNav / UserDockNav）で描画する。
// Phase 2A: `?view=pf|funds|other`（+ `&alloc=unavailable`）で PF 面 / 投信ハブ / その他ハブを
// 本番と同じ adapter → view で描画する。
// vite build の入力は index.html のみのため、本番バンドルには含まれない。
import { useReducer } from 'react'
import type { OfficialDecisionItem } from '../types'
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
// Phase 2B-2R: `&todo=sell|blocked|data_wait|multi|zero|normal` で OfficialDecision.actions を差し替えて
// 「今日のToDo」を確認する（判断が無い state=decision_unavailable / boot では差し替えない）。
const TODO_FIXTURES: Record<string, OfficialDecisionItem[]> = {
  sell: [{ id: 'a-sell', assetType: 'stock', code: '7203', name: 'トヨタ自動車', action: 'SELL', reason: '損切ラインに到達しました。', source: 'committee' }],
  blocked: [{ id: 'a-blk', assetType: 'stock', code: '9432', name: 'NTT', action: 'BLOCKED', reason: 'リスクゲートを通過していません。', blockedReason: 'ノートレード解除後に再判定します。', source: 'risk_gate' }],
  data_wait: [{ id: 'a-dw', assetType: 'stock', code: '6758', name: 'ソニーグループ', action: 'DATA_WAIT', reason: 'データ品質低下のため新規買いを抑制中です。', blockedReason: '最新データが取得されてから判断します。', source: 'risk_gate' }],
  multi: [
    { id: 'm1', assetType: 'stock', code: '7203', name: 'トヨタ自動車', action: 'SELL', reason: '損切ラインに到達しました。', source: 'committee' },
    { id: 'm2', assetType: 'stock', code: '8306', name: '三菱UFJフィナンシャル・グループ', action: 'BUY', reason: '押し目で追加買いの条件を満たしています。', source: 'committee' },
    { id: 'm3', assetType: 'stock', code: '9432', name: 'NTT', action: 'BLOCKED', reason: 'リスクゲートを通過していません。', blockedReason: 'ノートレード解除後に再判定します。', source: 'risk_gate' },
    { id: 'm4', assetType: 'stock', code: '6758', name: 'ソニーグループ', action: 'DATA_WAIT', reason: 'データ品質低下です。', blockedReason: '最新データ取得後に判断します。', source: 'risk_gate' },
    { id: 'm5', assetType: 'gold', name: '金（現物）', action: 'HOLD', reason: '目標配分の範囲内です。', source: 'committee' },
    { id: 'm6', assetType: 'stock', code: '8725', name: 'MS&AD', action: 'BUY_NEW', reason: '候補です。', source: 'candidate', isCandidate: true },
  ],
  zero: [],
}
const todoParam = new URLSearchParams(window.location.search).get('todo')
const baseScenarioInputs = scenarioInputs(scenario)
const todoActions = todoParam !== null ? TODO_FIXTURES[todoParam] : undefined
// Phase 2B-2R2: `&risks=one|multi|zero` で OfficialDecision.risks を差し替えて「注目ポイント」内の
// canonical リスクを確認する（判断が無い state=decision_unavailable / boot では差し替えない）。
const RISK_FIXTURES: Record<string, string[]> = {
  one: ['決算発表を控えた銘柄の新規買付は、発表後の確認を待つ運用です。'],
  multi: [
    '決算発表を控えた銘柄の新規買付は、発表後の確認を待つ運用です。',
    '国内株の比率が目標上限に近い状態です。',
    '為替の変動が外貨建て資産の評価に影響しています。',
    '一部の投信は基準価額の更新が遅れています。',
    '金の保有比率は目標配分の範囲内です。',
  ],
  zero: [],
}
const riskParam = new URLSearchParams(window.location.search).get('risks')
const riskList = riskParam !== null ? RISK_FIXTURES[riskParam] : undefined
const scenarioWithActions = todoActions !== undefined && baseScenarioInputs.officialDecision !== null
  ? { ...baseScenarioInputs, officialDecision: { ...baseScenarioInputs.officialDecision, actions: todoActions } }
  : baseScenarioInputs
const vm = assembleTodayHomeViewModel(
  riskList !== undefined && scenarioWithActions.officialDecision !== null
    ? { ...scenarioWithActions, officialDecision: { ...scenarioWithActions.officialDecision, risks: riskList } }
    : scenarioWithActions,
)

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
