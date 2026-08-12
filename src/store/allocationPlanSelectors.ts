import type { AppState } from '../types'
import type {
  AllocationPlanSnapshot,
  AssetClass,
  AssetClassPlan,
  BlockedReason,
  InstrumentPlan,
  LimitingFactor,
  WarningReason,
} from '../types/allocationPlan'

export type SnapshotExecutability =
  | 'NOT_CALCULATED'
  | 'BLOCKED_AT_INPUT_OR_CLASS'
  | 'NO_CANDIDATES'
  | 'CALCULATED_NOT_EXECUTABLE'
  | 'EXECUTABLE'

export type ClassFullCause =
  | 'CLASS_DATA_UNAVAILABLE'
  | 'CLASS_BUDGET_EXHAUSTED'
  | 'CLASS_HARD_CAP_REACHED'
  | 'CLASS_TARGET_REACHED'

export const BLOCKED_REASON_ORDER = {
  INVALID_NUMERIC_INPUT: 0, CASH_AUTHORITY_UNAVAILABLE: 1, CASH_AUTHORITY_STALE: 2,
  CASH_NEGATIVE: 3, POLICY_AUTHORITY_UNAVAILABLE: 4, CLASS_TARGET_MISSING: 5,
  CLASS_CAP_MISSING: 6, CLASS_FULL: 7, JP_STOCK_CAP: 8, JP_TRUST_TARGET_REACHED: 9,
  INSUFFICIENT_CASH: 10, BELOW_MINIMUM_UNIT: 11, INSTRUMENT_AUTHORITY_UNAVAILABLE: 12,
  JP_STOCK_EXECUTION_DATA_UNAVAILABLE: 13, SAFE_MODE_ACTIVE: 14, SAFE_MODE_UNAVAILABLE: 15,
  DQ_SUPPRESSED: 16, NO_TRADE_EMERGENCY: 17, MARKET_DATA_STALE: 18, HOLDINGS_STALE: 19,
  CASH_DATA_STALE: 20, CANDIDATE_INPUT_INVALID: 21, CROSS_TAB_STALE: 22,
  TIER_A_HARD_VIOLATION: 23, TARGET_AUTHORITY_UNAVAILABLE: 24,
} as const satisfies Readonly<Record<BlockedReason, number>>

export const WARNING_REASON_ORDER = {
  PENDING_ORDER_AUTHORITY_UNAVAILABLE: 0, FEE_AUTHORITY_UNAVAILABLE: 1,
  SECTOR_AUTHORITY_PARTIAL: 2, CONCENTRATION_UNAVAILABLE: 3, LIQUIDITY_UNAVAILABLE: 4,
  INSTRUMENT_TARGET_UNAVAILABLE: 5, CONFIDENCE_UNKNOWN: 6, MARKET_CAUTION: 7,
  TIER_A_SOFT_ALERT: 8, CANDIDATE_INPUT_STALE: 9, HOLDINGS_DATA_STALE: 10,
  CASH_DATA_STALE: 11, PORTFOLIO_SOURCE_PARTIAL: 12, ESTIMATE_ONLY: 13,
  NOT_SELECTED_FOR_EXECUTION: 14,
} as const satisfies Readonly<Record<WarningReason, number>>

export const LIMITING_FACTOR_ORDER = {
  DEPLOYABLE_CASH: 0, CLASS_HEADROOM: 1, INSTRUMENT_HEADROOM: 2, TARGET_GAP: 3,
  MAX_POSITION: 4, SECTOR: 5, CONCENTRATION: 6, LIQUIDITY: 7, LOT_SIZE: 8,
  AVAILABLE_BUDGET: 9, SIMULTANEOUS_BUDGET: 10, MINIMUM_UNIT: 11,
  JP_STOCK_RATIO_CAP: 12, JP_STOCK_AMOUNT_CAP: 13, JP_TRUST_REMAINING_TARGET: 14,
} as const satisfies Readonly<Record<LimitingFactor, number>>

function orderKnown<T extends string>(
  values: readonly T[],
  canonical: Readonly<Record<T, number>>,
): readonly T[] | null {
  if (values.some(value => !Object.prototype.hasOwnProperty.call(canonical, value))) return null
  return [...new Set(values)].sort((left, right) => canonical[left] - canonical[right])
}

export function orderBlockedReasons(values: readonly BlockedReason[]): readonly BlockedReason[] | null {
  return orderKnown(values, BLOCKED_REASON_ORDER)
}

export function orderWarningReasons(values: readonly WarningReason[]): readonly WarningReason[] | null {
  return orderKnown(values, WARNING_REASON_ORDER)
}

export function orderLimitingFactors(values: readonly LimitingFactor[]): readonly LimitingFactor[] | null {
  return orderKnown(values, LIMITING_FACTOR_ORDER)
}

export function classFullCause(plan: AssetClassPlan): ClassFullCause | null {
  if (!plan.blockedReasons.includes('CLASS_FULL')) return null
  if (plan.blockedReasons.includes('CLASS_TARGET_MISSING')) return 'CLASS_DATA_UNAVAILABLE'
  if (plan.limitingFactors.includes('AVAILABLE_BUDGET')) return 'CLASS_BUDGET_EXHAUSTED'
  if (plan.maximumAmount !== null && plan.limitingFactors.includes('CLASS_HEADROOM') && !plan.limitingFactors.includes('TARGET_GAP')) {
    return 'CLASS_HARD_CAP_REACHED'
  }
  if (plan.limitingFactors.includes('TARGET_GAP')) return 'CLASS_TARGET_REACHED'
  return 'CLASS_DATA_UNAVAILABLE'
}

export function snapshotExecutability(snapshot: AllocationPlanSnapshot | null): SnapshotExecutability {
  if (snapshot === null) return 'NOT_CALCULATED'
  const classReasons = new Set(snapshot.assetClassPlans.flatMap(plan => plan.blockedReasons))
  const inputReasons = snapshot.blockedReasons.filter(reason => !classReasons.has(reason))
  if (inputReasons.length > 0) return 'BLOCKED_AT_INPUT_OR_CLASS'
  if (snapshot.instrumentPlans.length === 0) return 'NO_CANDIDATES'
  if (snapshot.instrumentPlans.some(plan => plan.executable)) return 'EXECUTABLE'
  if (snapshot.assetClassPlans.some(plan => plan.blockedReasons.length > 0)) {
    return 'BLOCKED_AT_INPUT_OR_CLASS'
  }
  return 'CALCULATED_NOT_EXECUTABLE'
}

function projectClassPlan(plan: AssetClassPlan): AssetClassPlan | null {
  const blockedReasons = orderBlockedReasons(plan.blockedReasons)
  const warningReasons = orderWarningReasons(plan.warningReasons)
  const limitingFactors = orderLimitingFactors(plan.limitingFactors)
  if (blockedReasons === null || warningReasons === null || limitingFactors === null) return null
  return { ...plan, blockedReasons: [...blockedReasons], warningReasons: [...warningReasons], limitingFactors: [...limitingFactors] }
}

function projectInstrumentPlan(plan: InstrumentPlan): InstrumentPlan | null {
  const blockedReasons = orderBlockedReasons(plan.blockedReasons)
  const warningReasons = orderWarningReasons(plan.warningReasons)
  const limitingFactors = orderLimitingFactors(plan.limitingFactors)
  if (blockedReasons === null || warningReasons === null || limitingFactors === null) return null
  return { ...plan, blockedReasons: [...blockedReasons], warningReasons: [...warningReasons], limitingFactors: [...limitingFactors] }
}

export function projectAllocationPlanSnapshot(snapshot: AllocationPlanSnapshot): AllocationPlanSnapshot | null {
  const blockedReasons = orderBlockedReasons(snapshot.blockedReasons)
  const warnings = orderWarningReasons(snapshot.warnings.filter(reason => reason !== 'NOT_SELECTED_FOR_EXECUTION'))
  if (blockedReasons === null || warnings === null) return null
  const assetClassPlans = snapshot.assetClassPlans.map(projectClassPlan)
  const instrumentPlans = snapshot.instrumentPlans.map(projectInstrumentPlan)
  if (assetClassPlans.some(plan => plan === null) || instrumentPlans.some(plan => plan === null)) return null
  return { ...snapshot, blockedReasons: [...blockedReasons], warnings: [...warnings], assetClassPlans: assetClassPlans as AssetClassPlan[], instrumentPlans: instrumentPlans as InstrumentPlan[] }
}

export const selectAllocationPlanSnapshot = (state: AppState) => state.allocationPlan
export const selectAllocationPlanSnapshotState = (state: AppState) => state.allocationPlanStatus
export const selectSnapshotExecutability = (state: AppState) => snapshotExecutability(state.allocationPlan)
export const selectAllocationPlanForAssetClass = (assetClass: AssetClass) =>
  (state: AppState): AssetClassPlan | null => state.allocationPlan?.assetClassPlans.find(plan => plan.assetClass === assetClass) ?? null
export const selectAllocationPlanForInstrument = (instrumentId: string) =>
  (state: AppState): InstrumentPlan | null => state.allocationPlan?.instrumentPlans.find(plan => plan.instrumentId === instrumentId) ?? null
