// ═══════════════════════════════════════════════════════════
// CAND-SYN-1D: pure label projection for CandidateDecisionSynthesisSnapshot.
//
// This module maps already-frozen synthesis fields to Japanese display
// strings only. It does not filter, slice, re-rank, or recompute anything —
// T0/T1 read `synthesis.decisions` / `synthesis.watchList` verbatim (in
// canonical order) and use these helpers purely for label text. No internal
// invariant/audit codes (I-SYN-*, P2-*, DDR-*) are exposed here.
// ═══════════════════════════════════════════════════════════
import type { BlockedReason, LimitingFactor, WarningReason } from '../../types/allocationPlan'
import type {
  CandidateDecisionSynthesisEntry,
  SynthesisAction,
  SynthesisReasonCode,
} from '../../types/candidateDecisionSynthesis'

export const SYNTHESIS_ACTION_LABEL: Record<SynthesisAction, string> = {
  ADD: '追加検討',
  BUY_NEW: '新規検討',
  WATCH: '監視',
  BLOCKED: '除外',
}

export const SYNTHESIS_REASON_LABEL: Record<SynthesisReasonCode, string> = {
  PORTFOLIO_FIT_NOT_APPLICABLE: 'ポートフォリオ適合の評価対象外です',
  SELL_CONFLICT_SAME_INSTRUMENT: '同一銘柄に売却判断があるため見送りです',
  SAFE_MODE_ACTIVE: 'SAFE_MODE発動中のため実行できません',
  SAFE_MODE_UNAVAILABLE: 'SAFE_MODE状態が確認できません',
  DQ_SUPPRESSED: 'データ品質低下のため抑制中です',
  NO_TRADE_EMERGENCY: '緊急ノートレード中です',
  CANDIDATE_INPUT_STALE: '候補データが古い可能性があります',
  CANDIDATE_INPUT_INVALID: '候補データを検証できません',
  CASH_AUTHORITY_UNAVAILABLE: '資金前提が未設定です',
  CASH_DATA_STALE: '資金データが古い可能性があります',
  HOLDINGS_STALE: '保有データが古いため実行できません',
  HOLDINGS_DATA_STALE: '保有データが古い可能性があります',
  PORTFOLIO_SOURCE_PARTIAL: '保有データが一部のみ確認できています',
  ESTIMATE_ONLY: '参考値のみ（実行可能額ではありません）',
  EXECUTION_PRICE_UNAVAILABLE: '実行参照価格が取得できません',
  EXECUTION_PRICE_AMBIGUOUS: '実行参照価格が一意に定まりません',
}

export const BLOCKED_REASON_LABEL: Record<BlockedReason, string> = {
  INVALID_NUMERIC_INPUT: '入力データが不正です',
  CASH_AUTHORITY_UNAVAILABLE: '資金前提が未設定です',
  CASH_AUTHORITY_STALE: '資金前提が期限切れです',
  CASH_NEGATIVE: '利用可能資金がマイナスです',
  POLICY_AUTHORITY_UNAVAILABLE: 'ポートフォリオ方針が未設定です',
  CLASS_TARGET_MISSING: '資産クラスの目標配分が未設定です',
  CLASS_CAP_MISSING: '資産クラスの上限が未設定です',
  CLASS_FULL: '資産クラス配分が上限に到達しています',
  JP_STOCK_CAP: '国内株式の上限に到達しています',
  JP_TRUST_TARGET_REACHED: '国内投信の目標配分に到達しています',
  INSUFFICIENT_CASH: '利用可能資金が不足しています',
  BELOW_MINIMUM_UNIT: '最低購入単位に届きません',
  INSTRUMENT_AUTHORITY_UNAVAILABLE: '銘柄の実行権限情報が不足しています',
  JP_STOCK_EXECUTION_DATA_UNAVAILABLE: '実行参照価格が取得できません',
  SAFE_MODE_ACTIVE: 'SAFE_MODE発動中のため実行できません',
  SAFE_MODE_UNAVAILABLE: 'SAFE_MODE状態が確認できません',
  DQ_SUPPRESSED: 'データ品質低下のため抑制中です',
  NO_TRADE_EMERGENCY: '緊急ノートレード中です',
  MARKET_DATA_STALE: '市場データが古いため実行できません',
  HOLDINGS_STALE: '保有データが古いため実行できません',
  CASH_DATA_STALE: '資金データが古いため実行できません',
  CANDIDATE_INPUT_INVALID: '候補データを検証できません',
  CROSS_TAB_STALE: '別タブでの更新により再評価が必要です',
  TIER_A_HARD_VIOLATION: 'リスク上限に抵触しています',
  TARGET_AUTHORITY_UNAVAILABLE: '目標配分情報が取得できません',
}

export const WARNING_REASON_LABEL: Record<WarningReason, string> = {
  PENDING_ORDER_AUTHORITY_UNAVAILABLE: '未約定注文情報が不足しています',
  FEE_AUTHORITY_UNAVAILABLE: '手数料情報が不足しています',
  SECTOR_AUTHORITY_PARTIAL: 'セクター情報が一部不足しています',
  CONCENTRATION_UNAVAILABLE: '集中度情報が取得できません',
  LIQUIDITY_UNAVAILABLE: '流動性情報が取得できません',
  INSTRUMENT_TARGET_UNAVAILABLE: '銘柄別目標が未設定です',
  CONFIDENCE_UNKNOWN: '確信度が不明です',
  MARKET_CAUTION: '市場が警戒水準です',
  TIER_A_SOFT_ALERT: 'リスク警戒水準です',
  CANDIDATE_INPUT_STALE: '候補データが古い可能性があります',
  HOLDINGS_DATA_STALE: '保有データが古い可能性があります',
  CASH_DATA_STALE: '資金データが古い可能性があります',
  PORTFOLIO_SOURCE_PARTIAL: '保有データが一部のみ確認できています',
  ESTIMATE_ONLY: '参考値のみ（実行可能額ではありません）',
  NOT_SELECTED_FOR_EXECUTION: '本日の実行枠には選定されていません',
}

export const LIMITING_FACTOR_LABEL: Record<LimitingFactor, string> = {
  DEPLOYABLE_CASH: '投資可能現金',
  CLASS_HEADROOM: '資産クラス余力',
  INSTRUMENT_HEADROOM: '銘柄別余力',
  TARGET_GAP: '目標乖離額',
  MAX_POSITION: '最大保有比率',
  SECTOR: 'セクター集中度',
  CONCENTRATION: '銘柄集中度',
  LIQUIDITY: '流動性',
  LOT_SIZE: '売買単位',
  AVAILABLE_BUDGET: '利用可能予算',
  SIMULTANEOUS_BUDGET: '同時実行予算',
  MINIMUM_UNIT: '最低購入単位',
  JP_STOCK_RATIO_CAP: '国内株式比率上限',
  JP_STOCK_AMOUNT_CAP: '国内株式金額上限',
  JP_TRUST_REMAINING_TARGET: '国内投信残り目標',
}

export const CANDIDATE_QUALITY_TIER_LABEL: Record<'actionable' | 'deep_review', string> = {
  actionable: '実行検討',
  deep_review: '精査対象',
}

export const PORTFOLIO_FIT_STATUS_LABEL: Record<
  CandidateDecisionSynthesisEntry['portfolioFit']['status'],
  string
> = {
  evaluated: '評価済み',
  partial: '一部評価',
  unavailable: '評価不可',
  invalid: '検証不可',
  not_evaluated: '評価対象外',
}

export function labelBlockedReasons(reasons: readonly BlockedReason[]): string[] {
  return reasons.map(r => BLOCKED_REASON_LABEL[r] ?? r)
}

export function labelWarnings(warnings: readonly WarningReason[]): string[] {
  return warnings.map(w => WARNING_REASON_LABEL[w] ?? w)
}

export function labelLimitingFactors(factors: readonly LimitingFactor[]): string[] {
  return factors.map(f => LIMITING_FACTOR_LABEL[f] ?? f)
}

export function labelSynthesisReasons(codes: readonly SynthesisReasonCode[]): string[] {
  return codes.map(c => SYNTHESIS_REASON_LABEL[c] ?? c)
}

/**
 * The single frozen state-text projector for "why does this candidate have no
 * amount shown" (D26). Prefers the entry's own whyNotExecutable/blockingReasons
 * evidence; never invents a number or a legacy sizing label.
 */
export function synthesisNonExecutableReasonText(entry: CandidateDecisionSynthesisEntry): string | null {
  if (entry.money.kind === 'EXECUTABLE') return null
  const blocked = labelBlockedReasons(entry.blockingReasons)
  if (blocked.length > 0) return blocked[0]
  const whyNot = labelSynthesisReasons(entry.whyNotExecutable)
  if (whyNot.length > 0) return whyNot[0]
  return entry.action === 'WATCH' ? '実行条件を満たしていません' : null
}
