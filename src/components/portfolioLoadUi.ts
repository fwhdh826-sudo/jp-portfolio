import type {
  PortfolioCoordinationErrorCode,
  PortfolioLoadResult,
} from '../store/portfolioOperationResult'

export interface PortfolioLoadFeedback {
  tone: 'info' | 'error'
  message: string
}

export interface PortfolioLoadButtonState {
  disabled: boolean
  ariaBusy: boolean
  label: string
}

export function portfolioLoadButtonState(
  globallyLoading: boolean,
  locallyPending: boolean,
  labels: { idle: string; globallyLoading: string; locallyPending: string },
): PortfolioLoadButtonState {
  return {
    disabled: globallyLoading || locallyPending,
    ariaBusy: locallyPending,
    label: locallyPending
      ? labels.locallyPending
      : globallyLoading
        ? labels.globallyLoading
        : labels.idle,
  }
}

const COORDINATION_MESSAGES: Record<PortfolioCoordinationErrorCode, string> = {
  LOCAL_OPERATION_BUSY: '別のポートフォリオ処理が実行中です。完了後に再試行してください。',
  WEB_LOCK_UNAVAILABLE: 'この環境では安全な複数タブ同期を利用できません。対応ブラウザのHTTPS環境で再読み込みしてください。',
  WEB_LOCK_TIMEOUT: '別タブの処理待機がタイムアウトしました。別タブを確認して再読み込みしてください。',
  WEB_LOCK_ABORTED: '処理開始前に操作が中断されました。再試行してください。',
  WEB_LOCK_REQUEST_FAILED: '安全な排他制御を開始できませんでした。再読み込み後に再試行してください。',
  CROSS_TAB_STATE_STALE: '別タブで更新された状態を検出しました。画面を再読み込みしてください。',
  PORTFOLIO_GENERATION_CONFLICT: '保存世代の競合を検出しました。画面を再読み込みしてください。',
}

const LOAD_MESSAGES = {
  LOAD_RESTORE_ERROR: '保存データを安全に復元できませんでした。状態を確認してください。',
  LOAD_DATA_ERROR: '最新データを取得できませんでした。通信状態を確認して再試行してください。',
  LOAD_ANALYSIS_ERROR: 'データ取得後の再計算に失敗しました。再試行してください。',
  LOAD_PERSISTENCE_ERROR: '更新結果を保存できませんでした。画面を再読み込みして状態を確認してください。',
  LOAD_PUBLISH_ERROR: '更新結果を画面へ反映できませんでした。画面を再読み込みしてください。',
} as const

export const PORTFOLIO_LOAD_REJECTION_FEEDBACK: PortfolioLoadFeedback = {
  tone: 'error',
  message: '更新処理を安全に完了できませんでした。再読み込み後に再試行してください。',
}

export function portfolioLoadFeedback(result: PortfolioLoadResult): PortfolioLoadFeedback | null {
  if (result.ok) return null
  const message = result.code in LOAD_MESSAGES
    ? LOAD_MESSAGES[result.code as keyof typeof LOAD_MESSAGES]
    : COORDINATION_MESSAGES[result.code as PortfolioCoordinationErrorCode]
  return { tone: 'error', message }
}

export function createPortfolioLoadSingleFlight() {
  let active = false
  return {
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      if (active) return null
      active = true
      try {
        return await task()
      } finally {
        active = false
      }
    },
  }
}

export async function executePortfolioLoadUiFlow(
  action: () => Promise<PortfolioLoadResult>,
  setPending: (pending: boolean) => void,
  setFeedback: (feedback: PortfolioLoadFeedback | null) => void,
): Promise<PortfolioLoadResult | null> {
  setPending(true)
  setFeedback(null)
  try {
    const result = await action()
    setFeedback(portfolioLoadFeedback(result))
    return result
  } catch {
    setFeedback(PORTFOLIO_LOAD_REJECTION_FEEDBACK)
    return null
  } finally {
    setPending(false)
  }
}
