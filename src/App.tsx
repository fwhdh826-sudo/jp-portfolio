/**
 * App.tsx — V10 アプリシェル
 * ネイビーヘッダー + StatusBar + コンテンツエリア
 * 主ナビは UserDockNav（mobile）/ UserSidebarNav（desktop ≥1024px）の 1 系統のみ
 */
import { useEffect, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { colors, v13Colors } from './theme/tokens'
import { startCashAuthorityExpiryGuard } from './store/cashAuthorityLifecycle'
import { StatusBar } from './components/StatusBar'
import { AppErrorBoundary } from './components/shared/AppErrorBoundary'
import { T1_Decision }   from './components/tabs/T1_Decision'
import { T2_JpFund }     from './components/tabs/T2_JpFund'     // Phase 2: 国内株投信
import { T3_GlobalFund } from './components/tabs/T3_GlobalFund' // Phase 2: 海外投信
import { T4_IdealPf }     from './components/tabs/T4_IdealPf'      // Phase 3: 理想PF/差分
import { T5_News }      from './components/tabs/T5_News'      // Phase 5: ニュース/材料
import { T6_Committee } from './components/tabs/T6_Committee' // Phase 4: AI投資委員会
import { T7_Trust }      from './components/tabs/T7_Trust'
import { T8_Learning }   from './components/tabs/T8_Learning'  // Phase 9: 学習/検証
import { T9_Settings }   from './components/tabs/T9_Settings'  // Phase 9: 設定/CSV取込
import {
  portfolioLoadFeedback,
  PORTFOLIO_LOAD_REJECTION_FEEDBACK,
  type PortfolioLoadFeedback,
} from './components/portfolioLoadUi'
import type { PortfolioLoadResult } from './store/portfolioOperationResult'
import { useUiSurface } from './store/uiSurface'
import type { UiSurface } from './presentation/ui9i/navigation'
import { TodayHome } from './components/ui9i/TodayHome'
import { DecisionAudit } from './components/ui9i/DecisionAudit.container'
import { FundsHub, OtherHub, PortfolioSurface } from './components/ui9i/SurfaceRouter'
import { UserDockNav, UserSidebarNav } from './components/ui9i/UserNav'
// UI-9I R4.1 の数値メトリクスは Space Mono（--u9-mono の先頭フォント）。
// @fontsource が同梱する woff2 を bundle するため、実行時の外部ネットワーク依存は無い。
// import するのは実際に使う normal 400 / 700 の latin subset のみ（italic は使わない）。
import '@fontsource/space-mono/latin-400.css'
import '@fontsource/space-mono/latin-700.css'
import './styles/v10.css'
import './styles/ui9i.css'

// ── UI-9-6: Header右側 — 日付 + システムステータスドット ────────
function HeaderRight() {
  const status = useAppStore(s => s.system.status)

  const now  = new Date()
  const yyyy = now.getFullYear()
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const dd   = String(now.getDate()).padStart(2, '0')
  const dow  = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()]

  const dotColor =
    status === 'success'      ? v13Colors.success :
    status === 'partial'      ? v13Colors.warning :
    status === 'failed'       ? v13Colors.danger :
    status === 'loading'      ? v13Colors.warning :
    status === 'initializing' ? colors.neutral :
    status === 'error'        ? v13Colors.danger :
    colors.neutral

  return (
    <div className="app-header__meta">
      <span
        className="app-header__status-dot"
        style={{ background: dotColor }}
        title={`System: ${status}`}
      />
      <div className="app-header__date">
        <span className="app-header__date-main">{yyyy}/{mm}/{dd}</span>
        <span className="app-header__date-dow">{dow}曜日</span>
      </div>
    </div>
  )
}

// ── Phase 8: グローバルエラーバナー ──────────────────────────
// F-P0-2: CSV系('error')に加え、initialize/refreshAllDataのデータソース取得結果
// ('failed'='partial'=1件以上fallback)でも到達可能なerror stateを作る。
export function GlobalErrorBanner() {
  const error            = useAppStore(s => s.system.error)
  const status            = useAppStore(s => s.system.status)
  const dataSourceOutcome = useAppStore(s => s.system.dataSourceOutcome)
  const refreshAllData    = useAppStore(s => s.refreshAllData)
  const [dismissed, setDismissed] = useState(false)
  const [retryPending, setRetryPending] = useState(false)

  // 状態が新しくなったら再表示
  useEffect(() => {
    if (status === 'error' || status === 'failed' || status === 'partial') setDismissed(false)
  }, [status, error])

  if (dismissed) return null

  if (status === 'error' && error) {
    return (
      <div className="global-error-banner" role="alert">
        <span className="global-error-banner__icon">⚠️</span>
        <span className="global-error-banner__text">データ取得エラー: {error}</span>
        <button
          className="global-error-banner__dismiss"
          onClick={() => setDismissed(true)}
          aria-label="閉じる"
        >×</button>
      </div>
    )
  }

  if (status === 'failed' || status === 'partial') {
    const handleRetry = () => {
      setRetryPending(true)
      void refreshAllData().finally(() => setRetryPending(false))
    }
    const missing = dataSourceOutcome ? dataSourceOutcome.total - dataSourceOutcome.loaded : null
    const text = status === 'failed'
      ? '最新データを取得できませんでした。表示中の値はビルド同梱の初期値です。'
      : `一部データを取得できませんでした（${missing ?? '?'}/${dataSourceOutcome?.total ?? '?'}）。T9（設定）でデータソース状態を確認できます。`
    return (
      <div
        className="global-error-banner"
        role="alert"
        style={status === 'partial'
          ? { background: 'var(--color-warning-bg)', color: 'var(--color-warning-text)', borderBottomColor: 'var(--color-warning)' }
          : undefined}
      >
        <span className="global-error-banner__icon">⚠️</span>
        <span className="global-error-banner__text">{text}</span>
        <button
          className="global-error-banner__dismiss"
          onClick={handleRetry}
          disabled={retryPending}
          aria-label="再試行"
          style={{ width: 'auto', minWidth: '44px', minHeight: '44px', fontSize: '12px' }}
        >{retryPending ? '再試行中…' : '再試行'}</button>
      </div>
    )
  }

  return null
}

export async function executeAppInitializeUiFlow(
  initialize: () => Promise<PortfolioLoadResult>,
  isActive: () => boolean,
  setFeedback: (feedback: PortfolioLoadFeedback | null) => void,
): Promise<void> {
  try {
    const result = await initialize()
    if (!isActive()) return
    if (!result.ok && result.code === 'LOCAL_OPERATION_BUSY') {
      setFeedback(null)
      return
    }
    setFeedback(portfolioLoadFeedback(result))
  } catch {
    if (isActive()) setFeedback(PORTFOLIO_LOAD_REJECTION_FEEDBACK)
  }
}

// P0-4: activeTab切替時にactual scroll owner(window)をtopへ戻す。
// RCA実測: .main-content は flex:1 のみで高さが確定せず常に scrollHeight===clientHeight
// となるため内部スクロールが発生しない。実際のscroll ownerはdesktop/mobile共にwindow側。
// html { scroll-behavior: smooth } の影響を受けないよう behavior:'instant' で明示上書きする。
export function resetScrollOwnerToTop(target: { scrollTo: (options: ScrollToOptions) => void }): void {
  target.scrollTo({ top: 0, left: 0, behavior: 'instant' })
}

// UI-9I Phase 1: R4.1 の UI 面（葉画面ではない面）。activeTab（葉画面の権限）は温存し、
// その上に重ねる。既存 T0–T9 はすべて到達可能（主ナビ / ハブ / PF 面経由）。
// Phase 2B-1: T1（個別株）も R4.1 の面（葉画面 activeTab === 'T1' のまま視覚だけ移行）。
export function isUi9iSurface(activeTab: string, surface: UiSurface | null): boolean {
  if (surface !== null) return true
  return activeTab === 'T0' || activeTab === 'T1'
}

function ActiveTabPanel() {
  const activeTab = useAppStore(s => s.activeTab)
  const surface = useUiSurface(s => s.surface)

  // UI 面ごとに独立した境界を置く（key=surface で面の切替が復旧導線になる）。
  if (surface !== null) {
    return (
      <AppErrorBoundary key={surface}>
        {surface === 'audit' ? <DecisionAudit />
          : surface === 'funds_hub' ? <FundsHub />
          : surface === 'pf' ? <PortfolioSurface />
          : <OtherHub />}
      </AppErrorBoundary>
    )
  }

  if (activeTab === 'T0') return <TodayHome />
  // T1: 個別株（V10 Phase 6 再構築済み → UI-9I Phase 2B-1 で R4.1 へ視覚移行）
  if (activeTab === 'T1') return <T1_Decision />
  // T2: 国内株投信（Phase 2 V10 新実装）
  if (activeTab === 'T2') return <T2_JpFund />
  // T3: 海外投信（Phase 2 V10 新実装）
  if (activeTab === 'T3') return <T3_GlobalFund />
  // T4: 理想PF（Phase 3 V10 新実装）
  if (activeTab === 'T4') return <T4_IdealPf />
  if (activeTab === 'T5') return <T5_News />      // Phase 5: ニュース/材料（V10新実装）
  if (activeTab === 'T6') return <T6_Committee />  // Phase 4: AI委員会（V10新実装）
  if (activeTab === 'T7') return <T7_Trust />
  if (activeTab === 'T8') return <T8_Learning />   // Phase 9: 学習/検証（実装済み）
  if (activeTab === 'T9') return <T9_Settings />   // Phase 9: 設定/CSV取込（実装済み）
  return <TodayHome />
}

export function App() {
  const initialize = useAppStore(s => s.initialize)
  const activeTab  = useAppStore(s => s.activeTab)
  const surface    = useUiSurface(s => s.surface)
  const clearSurface = useUiSurface(s => s.clearSurface)
  const [initializeFeedback, setInitializeFeedback] = useState<PortfolioLoadFeedback | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      await executeAppInitializeUiFlow(initialize, () => active, setInitializeFeedback)
    })()
    return () => {
      active = false
    }
  }, [initialize])

  // CASH-AUTH-1: 現金権限 TTL のローカルガード。開いたままのタブが168hの境界を
  // 越えても実行可能な AllocationPlanSnapshot を持ち続けないようにする。
  // ネットワークは使わず、権限の値や updatedAt も一切書き換えない。
  useEffect(() => startCashAuthorityExpiryGuard(useAppStore), [])

  // 葉画面（activeTab）が外部から切り替わったら UI 面（ハブ / 判断の詳細 等）を解除する。
  useEffect(() => {
    clearSurface()
  }, [activeTab, clearSurface])

  // タブ切替時にコンテンツエリアをトップへ
  useEffect(() => {
    resetScrollOwnerToTop(window)
  }, [activeTab])

  // UI 面（ハブ / 判断の詳細 / PF 面）の切替時もトップへ
  useEffect(() => {
    resetScrollOwnerToTop(window)
  }, [surface])

  // R4.1 の面ではネイビーヘッダー / StatusBar を出さない。従来画面（T2–T9）では
  // 更新ボタンや市場ティッカーを含む従来のヘッダー群をそのまま提供する（機能を削除しない）。
  const ui9i = isUi9iSurface(activeTab, surface)

  return (
    <div className="app-shell" data-tab={activeTab} data-ui9i={ui9i ? 'true' : 'false'}>
      {!ui9i && (
        <>
          {/* ネイビーヘッダー（従来画面） */}
          <header className="app-header">
            <div>
              <div className="app-header__title">Capital Allocation OS</div>
              <div className="app-header__subtitle">観察・分析ダッシュボード</div>
            </div>
            <div className="app-header__right">
              <HeaderRight />
            </div>
          </header>

          {/* 市場指標ステータスバー */}
          <StatusBar />
        </>
      )}

      {/* Phase 8: グローバルエラーバナー */}
      <GlobalErrorBanner />

      {initializeFeedback && (
        <div className="global-error-banner" role="alert">
          <span className="global-error-banner__icon">⚠️</span>
          <span className="global-error-banner__text">{initializeFeedback.message}</span>
        </div>
      )}

      {/* app-shell-body: モバイル=縦積み / desktop(≥1024px)=横並び(sidebar+content) */}
      <div className="app-shell-body">
        {/* デスクトップ左サイドバー（≥1024px）: 今日 / 個別株 / 投信 / ポートフォリオ / その他 */}
        <UserSidebarNav />

        {/* メインコンテンツ */}
        {/* F-P0-4: tab panel の描画例外で app-shell（header / StatusBar / nav）まで
            unmount されないよう、main-content の内側に境界を1段置く。
            key={activeTab} によりタブ切替が復旧導線になる。UI 面は ActiveTabPanel 内で個別に境界を持つ。 */}
        <main className="main-content u9-main">
          <AppErrorBoundary key={activeTab}>
            <ActiveTabPanel />
          </AppErrorBoundary>
        </main>
      </div>

      {/* モバイル Bottom Nav（<1024px）: 今日 / 個別株 / 投信 / PF / その他 */}
      <UserDockNav />
    </div>
  )
}
