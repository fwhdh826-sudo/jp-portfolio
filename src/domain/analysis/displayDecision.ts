import type { Holding, OfficialDecisionItem } from '../../types'

export type DisplayDecision = 'BUY' | 'HOLD' | 'SELL' | 'WAIT' | 'DATA_WAIT' | 'INSUFFICIENT_EVIDENCE'

/**
 * P1-4B / P4-A37 / P4-A149: officialAction・DQ gate・SAFE_MODE・ロック・jpStockMaxRatio上限を統合した表示専用判定
 *
 * 優先順位:
 *   1. dqSuppressed + BUY    → DATA_WAIT（データ品質ゲート最優先）
 *   2. safeModeActive + BUY  → WAIT（SAFE_MODE発動中の新規買付停止）
 *   3. capExceeded + BUY     → WAIT（国内個別株上限超過: PortfolioPolicy.jpStockMaxRatioで可変）
 *   4. locked + SELL         → WAIT（3ヶ月売却ロック）
 *   5. officialAction        → officialAction.action に従う
 *   6. fallback              → hDecision をそのまま返す
 *
 * P4-A149: officialActionが該当銘柄について存在しない場合（zeroPlanでBUY提案自体が
 * 生成されなかった等）はhDecisionへフォールバックする。SAFE_MODE中はzeroBase.ts側で
 * BUY提案が生成されないためofficialActionが見つからないケースが増えるが、その場合でも
 * hDecision(生のcomputeAnalysis結果)がBUYならこのゲートで表示上WAITに変換する。
 */
export function deriveDisplayDecision(params: {
  hDecision: Holding['decision']
  officialAction?: OfficialDecisionItem
  dqSuppressed: boolean
  locked: boolean
  capExceeded?: boolean
  safeModeActive?: boolean
}): DisplayDecision {
  const { hDecision, officialAction, dqSuppressed, locked, capExceeded, safeModeActive } = params

  // Evidence abstention outranks any stale/downstream official SELL action.
  if (hDecision === 'INSUFFICIENT_EVIDENCE') return 'INSUFFICIENT_EVIDENCE'

  // DQ抑制 + BUY → 新規買い停止（最高優先度）
  if (dqSuppressed && hDecision === 'BUY') return 'DATA_WAIT'
  // SAFE_MODE発動中 + BUY → 新規買い停止（P4-A149。DQの次に優先）
  if (safeModeActive && hDecision === 'BUY') return 'WAIT'
  // 国内個別株上限超過 + BUY → 追加停止（PortfolioPolicy.jpStockMaxRatioで可変）
  if (capExceeded && hDecision === 'BUY') return 'WAIT'
  // ロック中 + SELL → 執行不可
  if (locked && hDecision === 'SELL') return 'WAIT'

  if (officialAction) {
    switch (officialAction.action) {
      case 'BUY':       return dqSuppressed ? 'DATA_WAIT' : safeModeActive ? 'WAIT' : capExceeded ? 'WAIT' : 'BUY'
      case 'SELL':      return locked ? 'WAIT' : 'SELL'
      case 'HOLD':      return 'HOLD'
      case 'WAIT':      return 'WAIT'
      case 'MONITOR':   return 'HOLD'
      case 'BLOCKED':   return 'WAIT'
      case 'DATA_WAIT': return hDecision === 'SELL' && !locked ? 'SELL' : 'DATA_WAIT'
      default:          return hDecision as DisplayDecision
    }
  }

  return hDecision as DisplayDecision
}
