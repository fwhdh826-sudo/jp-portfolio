import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { selectIsLoading, selectTotalEval, selectTotalPnl } from '../store/selectors'
import { formatDateTime, formatJPYAuto, formatPt, formatSignedJPY, formatSignedPct } from '../utils/format'
import {
  createPortfolioLoadSingleFlight,
  executePortfolioLoadUiFlow,
  portfolioLoadButtonState,
  CROSS_TAB_STATE_STALE_MESSAGE,
  type PortfolioLoadFeedback,
} from './portfolioLoadUi'
import type { PortfolioLoadResult } from '../store/portfolioOperationResult'

export async function executeStatusBarRefreshFlow(
  refresh: () => Promise<PortfolioLoadResult>,
  singleFlight: ReturnType<typeof createPortfolioLoadSingleFlight>,
  setPending: (pending: boolean) => void,
  setFeedback: (feedback: PortfolioLoadFeedback | null) => void,
): Promise<void> {
  await singleFlight.run(() => executePortfolioLoadUiFlow(refresh, setPending, setFeedback))
}

/**
 * RA-008-D2: cross-tab warning表示中は通常refreshを完全に無効化する。stale中は
 * executeStatusBarRefreshFlow(既存single-flight契約は無変更)を一切呼び出さない。
 */
export async function executeStatusBarRefreshClickFlow(
  staleBlocked: boolean,
  refresh: () => Promise<PortfolioLoadResult>,
  singleFlight: ReturnType<typeof createPortfolioLoadSingleFlight>,
  setPending: (pending: boolean) => void,
  setFeedback: (feedback: PortfolioLoadFeedback | null) => void,
): Promise<void> {
  if (staleBlocked) return
  await executeStatusBarRefreshFlow(refresh, singleFlight, setPending, setFeedback)
}

/** RA-008-D2: reload失敗時にUIへ出す固定sanitized message。raw errorは一切保持しない。 */
export const CROSS_TAB_RELOAD_FAILURE_MESSAGE =
  '画面を再読み込みできませんでした。ブラウザの再読み込みを実行してください。'

const CROSS_TAB_RELOAD_IDLE_LABEL = '再読み込み'
const CROSS_TAB_RELOAD_PENDING_LABEL = '再読み込み中…'

/**
 * RA-008-D2: browser reloadをfail-softに呼ぶpure helper。throwせず、成功/失敗のbooleanのみ返す。
 * storeへは一切アクセスせず、warningのclearやinitialize/refreshの呼び出しも行わない。
 */
export function executeStatusBarCrossTabReload(reload: () => void): boolean {
  try {
    reload()
    return true
  } catch {
    return false
  }
}

// module import時にwindowへアクセスしない。参照はclick handler内でのみ評価する。
export function reloadBrowserPage(): void {
  if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') {
    throw new Error('reload unavailable')
  }
  window.location.reload()
}

/**
 * F-1: SQ残日数表示のinline color分岐を導出するpure predicate。判定条件・警告色は
 * ここ一箇所のみに存在する（非危険時は必ずundefinedを返し、CSSクラス側のtextOnNavy
 * ≈12.95:1へ委ねる。'inherit'等の明示的overrideを返してはならない）。
 */
export function statusBarSqValueColor(dayUntil: number | undefined): string | undefined {
  return (dayUntil ?? 99) <= 3 ? '#f07575' : undefined
}

/**
 * RA-008-D2: system.crossTabInvalidationからstale判定を導出するpure predicate。
 * 判定条件はここ一箇所のみに存在する。
 */
export function isCrossTabInvalidationStale(
  crossTabInvalidation: { status: 'stale' } | undefined,
): boolean {
  return crossTabInvalidation?.status === 'stale'
}

/**
 * RA-008-D2: cross-tab warning表示中は通常refresh buttonを無効化する。既存のglobal
 * loading／local pending disabled条件はそのまま維持し、staleをORで加える。
 */
export function statusBarRefreshButtonDisabled(baseDisabled: boolean, stale: boolean): boolean {
  return baseDisabled || stale
}

export interface CrossTabInvalidationViewModel {
  visible: boolean
  message: string
  reloadDisabled: boolean
  reloadLabel: string
  failureMessage: string | null
}

/**
 * RA-008-D2: cross-tab warning bannerの表示内容を決定するpure view model。
 * StatusBarはこの戻り値をそのままJSXへ反映するだけで、senderInstanceId等のraw event
 * dataは一切保持・表示しない。
 */
export function crossTabInvalidationViewModel(
  stale: boolean,
  reloadRequested: boolean,
  reloadFailure: string | null,
): CrossTabInvalidationViewModel {
  return {
    visible: stale,
    message: CROSS_TAB_STATE_STALE_MESSAGE,
    reloadDisabled: reloadRequested,
    reloadLabel: reloadRequested ? CROSS_TAB_RELOAD_PENDING_LABEL : CROSS_TAB_RELOAD_IDLE_LABEL,
    failureMessage: stale ? reloadFailure : null,
  }
}

/**
 * RA-008-D2: reload buttonのclick handler本体。duplicate clickをreloadRequestedでguardし、
 * storeやruntime pendingには一切触れない。clear authorityはRA-008-D1のinitialize SUCCESSのみ。
 */
export function executeStatusBarCrossTabReloadFlow(
  reload: () => void,
  reloadRequested: boolean,
  setReloadRequested: (value: boolean) => void,
  setReloadFailure: (value: string | null) => void,
): void {
  if (reloadRequested) return
  setReloadFailure(null)
  setReloadRequested(true)
  if (!executeStatusBarCrossTabReload(reload)) {
    setReloadRequested(false)
    setReloadFailure(CROSS_TAB_RELOAD_FAILURE_MESSAGE)
  }
}

/**
 * RA-008-D2: 外部clear(initialize SUCCESSによるcrossTabInvalidation===undefined化)を検出した
 * ときのUI-local cleanupのみを行うpure helper。clear authorityの追加ではない。
 */
export function statusBarCrossTabExternalClearReset(
  stale: boolean,
  setReloadRequested: (value: boolean) => void,
  setReloadFailure: (value: string | null) => void,
): void {
  if (stale) return
  setReloadRequested(false)
  setReloadFailure(null)
}

export function CrossTabInvalidationWarning(props: {
  viewModel: CrossTabInvalidationViewModel
  onReload: () => void
}) {
  const { viewModel, onReload } = props
  if (!viewModel.visible) return null
  return (
    <div
      role="alert"
      aria-label="別タブ更新通知"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 14px',
        background: 'rgba(240,117,117,0.14)',
        borderBottom: '1px solid rgba(240,117,117,0.35)',
        color: 'var(--color-text-on-navy)',
        fontSize: '11px',
      }}
    >
      <span style={{ flex: '1 1 240px', minWidth: 0 }}>{viewModel.message}</span>
      <button
        type="button"
        onClick={onReload}
        disabled={viewModel.reloadDisabled}
        style={{
          flexShrink: 0,
          minHeight: '44px',
          fontSize: '10px',
          padding: '3px 10px',
          background: viewModel.reloadDisabled ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.2)',
          color: 'var(--color-text-on-navy)',
          border: '1px solid rgba(255,255,255,0.25)',
          borderRadius: '4px',
          cursor: viewModel.reloadDisabled ? 'default' : 'pointer',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        }}
      >
        {viewModel.reloadLabel}
      </button>
      {viewModel.failureMessage && (
        <span style={{ fontSize: '10px', flexShrink: 0 }}>{viewModel.failureMessage}</span>
      )}
    </div>
  )
}

export function StatusBar() {
  const system   = useAppStore(s => s.system)
  const market   = useAppStore(s => s.market)
  const macro    = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const refresh  = useAppStore(s => s.refreshAllData)
  const isLoading = useAppStore(selectIsLoading)
  const totalEval = useAppStore(selectTotalEval)
  const totalPnl  = useAppStore(selectTotalPnl)
  const [refreshPending, setRefreshPending] = useState(false)
  const [refreshFeedback, setRefreshFeedback] = useState<PortfolioLoadFeedback | null>(null)
  const singleFlightRef = useRef(createPortfolioLoadSingleFlight())

  // RA-008-D2: system.crossTabInvalidationはD1で確立済みの唯一の投影。既存systemセレクタを
  // 再利用し、重複セレクタを増やさない。
  const stale = isCrossTabInvalidationStale(system.crossTabInvalidation)
  const [reloadRequested, setReloadRequested] = useState(false)
  const [reloadFailure, setReloadFailure] = useState<string | null>(null)

  // 外部clear(initialize SUCCESS)でwarningがundefinedになったらlocal reload状態もresetする。
  // これはUI-local cleanupであり、clear authorityの追加ではない。
  useEffect(() => {
    statusBarCrossTabExternalClearReset(stale, setReloadRequested, setReloadFailure)
  }, [stale])

  const crossTabViewModel = crossTabInvalidationViewModel(stale, reloadRequested, reloadFailure)

  const handleCrossTabReload = () => {
    executeStatusBarCrossTabReloadFlow(reloadBrowserPage, reloadRequested, setReloadRequested, setReloadFailure)
  }

  const refreshButton = portfolioLoadButtonState(isLoading, refreshPending, {
    idle: '更新',
    globallyLoading: '読込中…',
    locallyPending: '更新中…',
  })
  const refreshDisabled = statusBarRefreshButtonDisabled(refreshButton.disabled, stale)

  const handleRefresh = async () => {
    await executeStatusBarRefreshClickFlow(
      stale,
      refresh,
      singleFlightRef.current,
      setRefreshPending,
      setRefreshFeedback,
    )
  }

  const regime = market.regime
  const regimeLabel = regime === 'bull' ? '強気相場' : regime === 'bear' ? '弱気相場' : '中立相場'
  const regimeCls   = regime === 'bull' ? 'bull' : regime === 'bear' ? 'bear' : 'neutral'

  const indicators = [
    {
      label: '日経平均',
      value: market.nikkei.toLocaleString('ja-JP'),
      delta: formatSignedPct(market.nikkeiChgPct),
      up: market.nikkeiChgPct >= 0,
    },
    {
      label: 'VIX',
      value: market.vix.toFixed(1),
      delta: macro ? formatPt(macro.vixChg, 2) : '—',
      up: market.vix < 20,
    },
    {
      label: 'ドル円',
      value: macro ? `${macro.usdjpy.toFixed(2)}円` : '—',
      delta: macro ? formatSignedPct(macro.usdjpyChgPct) : '—',
      up: true,
    },
    {
      label: '評価額',
      value: formatJPYAuto(totalEval),
      delta: formatSignedJPY(totalPnl),
      up: totalPnl >= 0,
    },
  ]

  const sqLabel = sqCalendar?.nextSQ
    ? `SQ残${sqCalendar.nextSQ.dayUntil}日`
    : null

  return (
    <>
      <CrossTabInvalidationWarning viewModel={crossTabViewModel} onReload={handleCrossTabReload} />

      <div className="status-bar" role="status" aria-label="市場概況">
        {/* 市場モード */}
        <div className="status-bar__item">
          <span className="status-bar__label">市場モード</span>
          <span className={`status-bar__value regime-${regimeCls}`}>{regimeLabel}</span>
        </div>

        <div className="status-bar__divider" />

        {/* 主要指標 */}
        {indicators.map(ind => (
          <div key={ind.label} className="status-bar__item">
            <span className="status-bar__label">{ind.label}</span>
            <span className={`status-bar__value${ind.up ? ' text-up-bar' : ' text-down-bar'}`}>
              {ind.value}
              {' '}
              <span style={{ fontSize: '10px', opacity: 0.8 }}>{ind.delta}</span>
            </span>
          </div>
        ))}

        {sqLabel && (
          <>
            <div className="status-bar__divider" />
            <div className="status-bar__item">
              <span className="status-bar__label">先物</span>
              <span className="status-bar__value"
                style={{ color: statusBarSqValueColor(sqCalendar?.nextSQ?.dayUntil) }}>
                {sqLabel}
              </span>
            </div>
          </>
        )}

        <div className="status-bar__divider" />

        {/* 更新 */}
        <div className="status-bar__item" style={{ marginLeft: 'auto' }}>
          <span className="status-bar__label">最終更新</span>
          <span className="status-bar__value" style={{ fontSize: '10px' }}>
            {system.lastUpdated ? formatDateTime(system.lastUpdated) : '未更新'}
          </span>
        </div>

        <button
          onClick={handleRefresh}
          disabled={refreshDisabled}
          aria-busy={refreshButton.ariaBusy}
          type="button"
          style={{
            flexShrink: 0,
            minWidth: '44px',
            minHeight: '44px',
            fontSize: '10px',
            padding: '3px 10px',
            background: refreshDisabled ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.15)',
            color: 'var(--color-text-on-navy)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '4px',
            cursor: refreshDisabled ? 'default' : 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {refreshButton.label}
        </button>

        {refreshFeedback && (
          <span role="alert" style={{ fontSize: '10px', color: '#f07575', flexShrink: 0 }}>
            ⚠ {refreshFeedback.message}
          </span>
        )}

        {system.error && (
          <span style={{ fontSize: '10px', color: '#f07575', flexShrink: 0 }}>
            ⚠ データエラー
          </span>
        )}
      </div>
    </>
  )
}
