import type { AssetUniverse } from '../../types'
import type { NoTradeResult } from './idealAllocation'

export interface TrustPlanGateInputs {
  jpTrustHeadroom: number | undefined
  noTrade: boolean
}

/**
 * buildTrustPlanGateInputs — T7/T2 が buildTrustPortfolioPlan へ渡すゲート入力を、
 * store(useAppStore.runFullAnalysis)の合成条件と同一の式で算出する。
 *
 * jpTrustHeadroom: universe.categories の JP_TRUST.diffValue を安全側（負値は0）に丸める。
 *   universe / 対象カテゴリが欠ける場合は undefined を返し、
 *   buildTrustPortfolioPlan 側の「未指定時はCORE_BUDGET上限で動作」という既存フォールバックに委ねる。
 * noTrade: VIX/VI/SQ由来のnoTradeResult、SAFE_MODE、DQ抑制のいずれかが真なら true。
 */
export function buildTrustPlanGateInputs(params: {
  universe: AssetUniverse | null
  noTradeResult: NoTradeResult
  safeModeActive: boolean
  dqSuppressed: boolean
}): TrustPlanGateInputs {
  const jpTrustCategory = params.universe?.categories.find(c => c.class === 'JP_TRUST')
  const jpTrustHeadroom = jpTrustCategory ? Math.max(0, jpTrustCategory.diffValue) : undefined

  const noTrade =
    params.noTradeResult.noTrade ||
    params.safeModeActive ||
    params.dqSuppressed

  return { jpTrustHeadroom, noTrade }
}
