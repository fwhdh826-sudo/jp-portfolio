/**
 * App.tsx — V10 アプリシェル
 * ネイビーヘッダー + StatusBar + TabNav + コンテンツエリア
 * mobile: Bottom Dock / tablet: TabNav / desktop(≥1024px): 左サイドバー
 */
import { useEffect, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { colors, v13Colors } from './theme/tokens'
import { startCashAuthorityExpiryGuard } from './store/cashAuthorityLifecycle'
import { StatusBar } from './components/StatusBar'
import { TabNav } from './components/TabNav'
import { BottomDockNav } from './components/BottomDockNav'
import { TAB_META } from './constants/tabs'
import { T0_Home }       from './components/tabs/T0_Home'
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
import './styles/v10.css'

// ── UI-9-6: Header右側 — 日付 + システムステータスドット ────────
function HeaderRight() {
  const status = useAppStore(s => s.system.status)

  const now  = new Date()
  const yyyy = now.getFullYear()
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const dd   = String(now.getDate()).padStart(2, '0')
  const dow  = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()]

  const dotColor =
    status === 'success' ? v13Colors.success :
    status === 'loading' ? v13Colors.warning :
    status === 'error'   ? v13Colors.danger :
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

// ── UI-9-5-1/2: Desktop Sidebar（≥1024px で表示） ─────────────
const SIDEBAR_SECTIONS: { label: string; ids: string[] }[] = [
  { label: 'DASHBOARD', ids: ['T0'] },
  { label: 'PORTFOLIO', ids: ['T1', 'T2', 'T3', 'T4'] },
  { label: 'MARKET',    ids: ['T5', 'T6'] },
  { label: 'SYSTEM',    ids: ['T7', 'T8', 'T9'] },
]

export function DesktopSidebarNav() {
  const activeTab    = useAppStore(s => s.activeTab)
  const setTab       = useAppStore(s => s.setTab)
  const [isCollapsed, setIsCollapsed] = useState(false)

  return (
    <nav
      className={`app-sidebar${isCollapsed ? ' app-sidebar--collapsed' : ''}`}
      aria-label="Desktop navigation"
    >
      <button
        className="app-sidebar__toggle"
        onClick={() => setIsCollapsed(v => !v)}
        aria-label={isCollapsed ? 'サイドバーを展開' : 'サイドバーを折りたたむ'}
        type="button"
      >
        {isCollapsed ? '›' : '‹'}
      </button>
      <div className="app-sidebar__nav">
        {SIDEBAR_SECTIONS.map(section => (
          <div key={section.label} className="app-sidebar__group">
            <div className="app-sidebar__group-label" aria-hidden="true">{section.label}</div>
            {TAB_META
              .filter(tab => section.ids.includes(tab.id))
              .map(tab => (
                <button
                  key={tab.id}
                  className={`app-sidebar__item${activeTab === tab.id ? ' active' : ''}`}
                  onClick={() => setTab(tab.id)}
                  type="button"
                  aria-current={activeTab === tab.id ? 'page' : undefined}
                  title={tab.title}
                >
                  <span className="app-sidebar__icon" aria-hidden="true">{tab.icon}</span>
                  <span className="app-sidebar__label">{tab.label}</span>
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="app-sidebar__footer">
        <span className="app-sidebar__footer-badge">AI Engine</span>
        <span className="app-sidebar__footer-name">Capital Allocation OS</span>
      </div>
    </nav>
  )
}

// ── Phase 8: グローバルエラーバナー ──────────────────────────
function GlobalErrorBanner() {
  const error  = useAppStore(s => s.system.error)
  const status = useAppStore(s => s.system.status)
  const [dismissed, setDismissed] = useState(false)

  // エラーが新しくなったら再表示
  useEffect(() => {
    if (status === 'error') setDismissed(false)
  }, [error, status])

  if (status !== 'error' || !error || dismissed) return null
  return (
    <div className="global-error-banner">
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

function ActiveTabPanel() {
  const activeTab = useAppStore(s => s.activeTab)

  if (activeTab === 'T0') return <T0_Home />
  // T1: 個別株（V10 Phase 6 再構築済み）
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
  return <T0_Home />
}

export function App() {
  const initialize = useAppStore(s => s.initialize)
  const activeTab  = useAppStore(s => s.activeTab)
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

  // タブ切替時にコンテンツエリアをトップへ
  useEffect(() => {
    resetScrollOwnerToTop(window)
  }, [activeTab])

  return (
    <div className="app-shell" data-tab={activeTab}>
      {/* ネイビーヘッダー（常時表示） */}
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

      {/* Phase 8: グローバルエラーバナー */}
      <GlobalErrorBanner />

      {initializeFeedback && (
        <div className="global-error-banner" role="alert">
          <span className="global-error-banner__icon">⚠️</span>
          <span className="global-error-banner__text">{initializeFeedback.message}</span>
        </div>
      )}

      {/* app-shell-body: tablet以下=縦積み / desktop(≥1024px)=横並び(sidebar+content) */}
      <div className="app-shell-body">
        {/* デスクトップ左サイドバー（≥1024px で表示） */}
        <DesktopSidebarNav />

        {/* タブナビゲーション（tablet以下で表示、≥1024pxで非表示） */}
        <TabNav />

        {/* メインコンテンツ */}
        <main className="main-content">
          <ActiveTabPanel />
        </main>
      </div>

      {/* モバイル Bottom Dock（<840px で表示、T7 では非表示） */}
      <BottomDockNav />
    </div>
  )
}
