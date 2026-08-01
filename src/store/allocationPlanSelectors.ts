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

const BLOCKED_REASON_ORDER = [
  'INVALID_NUMERIC_INPUT', 'CASH_AUTHORITY_UNAVAILABLE', 'CASH_AUTHORITY_STALE',
  'CASH_NEGATIVE', 'POLICY_AUTHORITY_UNAVAILABLE', 'CLASS_TARGET_MISSING',
  'CLASS_CAP_MISSING', 'CLASS_FULL', 'JP_STOCK_CAP', 'JP_TRUST_TARGET_REACHED',
  'INSUFFICIENT_CASH', 'BELOW_MINIMUM_UNIT', 'INSTRUMENT_AUTHORITY_UNAVAILABLE',
  'JP_STOCK_EXECUTION_DATA_UNAVAILABLE', 'SAFE_MODE_ACTIVE', 'SAFE_MODE_UNAVAILABLE',
  'DQ_SUPPRESSED', 'NO_TRADE_EMERGENCY', 'MARKET_DATA_STALE', 'HOLDINGS_STALE',
  'CASH_DATA_STALE', 'CANDIDATE_INPUT_INVALID', 'CROSS_TAB_STALE',
  'TIER_A_HARD_VIOLATION', 'TARGET_AUTHORITY_UNAVAILABLE',
] as const satisfies readonly BlockedReason[]

const WARNING_REASON_ORDER = [
  'PENDING_ORDER_AUTHORITY_UNAVAILABLE', 'FEE_AUTHORITY_UNAVAILABLE',
  'SECTOR_AUTHORITY_PARTIAL', 'CONCENTRATION_UNAVAILABLE', 'LIQUIDITY_UNAVAILABLE',
  'INSTRUMENT_TARGET_UNAVAILABLE', 'CONFIDENCE_UNKNOWN', 'MARKET_CAUTION',
  'TIER_A_SOFT_ALERT', 'CANDIDATE_INPUT_STALE', 'HOLDINGS_DATA_STALE',
  'CASH_DATA_STALE', 'PORTFOLIO_SOURCE_PARTIAL', 'ESTIMATE_ONLY',
  'NOT_SELECTED_FOR_EXECUTION',
] as const satisfies readonly WarningReason[]

const LIMITING_FACTOR_ORDER = [
  'DEPLOYABLE_CASH', 'CLASS_HEADROOM', 'INSTRUMENT_HEADROOM', 'TARGET_GAP',
  'MAX_POSITION', 'SECTOR', 'CONCENTRATION', 'LIQUIDITY', 'LOT_SIZE',
  'AVAILABLE_BUDGET', 'SIMULTANEOUS_BUDGET', 'MINIMUM_UNIT',
  'JP_STOCK_RATIO_CAP', 'JP_STOCK_AMOUNT_CAP', 'JP_TRUST_REMAINING_TARGET',
] as const satisfies readonly LimitingFactor[]

function orderKnown<T extends string>(values: readonly T[], canonical: readonly T[]): readonly T[] | null {
  const index = new Map(canonical.map((value, position) => [value, position]))
  if (values.some(value => !index.has(value))) return null
  return [...new Set(values)].sort((left, right) => index.get(left)! - index.get(right)!)
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
