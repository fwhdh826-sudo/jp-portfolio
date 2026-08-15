// ═══════════════════════════════════════════════════════════
// CAND-SYN-1C / DDR-R1: canonical cross-class execution priority.
//
// This module is the single comparator authority the AllocationPlan engine
// owns (DDR-R1 §5.1/§6). It decides which candidate receives the one
// RANK_SEQUENTIAL_SINGLE_EXECUTION slot — i.e. which instrument gets
// `executable === true` and a positive `finalSuggestedAmount`. Nothing else
// may re-rank that decision: CandidateDecisionSynthesis may present the
// result, never replace it (MONETARY_SELECTION_AUTHORITY_COUNT = 1).
//
//   K0  eligibility gate (not a sort key): independently executable AND
//       roundedSimultaneous > 0. Ineligible candidates never consume the slot;
//       the engine keeps its existing sequential gate for this.
//   K1  actionRank        ADD/BUY_NEW(0) < WATCH(1) < BLOCKED(2)
//   K2  classNeedRank     integer-exact targetGap/targetAmount, need descending
//   K3  namespace         jp_stock_funnel(0) < jp_trust_registry(1)
//   K4  marketRank        ascending, WITHIN a namespace only (null last)
//   K5  artifactIndex     ascending, WITHIN a namespace only
//   K6  instrumentId      lexical total order (final tie-break)
//
// marketRank is calibrated by JP_STOCK funnel scoring only. Mapping a null
// JP_TRUST marketRank onto MAX_SAFE_INTEGER and comparing it across asset
// classes is forbidden (DDR-R1 §4) — K3 separates the namespaces before K4 is
// ever consulted, so K4/K5 are structurally within-namespace.
// ═══════════════════════════════════════════════════════════
import type {
  AssetClass,
  BlockedReason,
  BuyKind,
  CandidateInput,
} from '../../types/allocationPlan'

/** Canonical AssetClassPlan need authority. Never recomputed outside the engine. */
export interface ExecutionPriorityClassNeed {
  readonly targetGap: number | null
  readonly targetAmount: number | null
  readonly blockedReasons: readonly BlockedReason[]
}

export interface ExecutionPriorityCandidate {
  readonly instrumentId: string
  readonly buyKind: BuyKind
  readonly assetClass: AssetClass | null
  readonly marketRank: number | null
  readonly artifactIndex: number
  readonly classNeed: ExecutionPriorityClassNeed | null
}

/**
 * D11 key 2, adopted verbatim: ADD and BUY_NEW share rank 0 so an existing
 * holding and a new candidate compete on allocation need, not on novelty.
 * WATCH/BLOCKED are synthesis-only actions and never reach the engine, so this
 * table is constant here; it is kept so a future BuyKind cannot diverge silently.
 */
const EXECUTION_ACTION_RANK: Record<BuyKind, 0 | 1 | 2> = {
  BUY_NEW: 0,
  BUY_MORE: 0,
}

export function executionActionRank(buyKind: BuyKind): 0 | 1 | 2 {
  return EXECUTION_ACTION_RANK[buyKind] ?? 2
}

/**
 * jp_stock_funnel(0) < jp_trust_registry(1). Asset classes with no candidate
 * discovery source in v1 (OVERSEAS_TRUST / GOLD / CASH — design-audit D3
 * population E is OUT) have no namespace authority and sort after both; K6
 * still yields a total order.
 */
export function executionNamespaceRank(assetClass: AssetClass | null): 0 | 1 | 2 {
  if (assetClass === 'JP_STOCK') return 0
  if (assetClass === 'JP_TRUST') return 1
  return 2
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * tier 1 = class need authority does not hold (missing plan, CLASS_TARGET_MISSING,
 * non-positive or non-integer target). Fail-closed: always last, and strictly
 * after a fully-funded tier-0 class whose targetGap is 0.
 */
export function allocationClassNeedTier(
  need: ExecutionPriorityClassNeed | null,
): 0 | 1 {
  if (need === null) return 1
  return (
    need.blockedReasons.includes('CLASS_TARGET_MISSING') ||
    !isNonNegativeInteger(need.targetGap) ||
    !isNonNegativeInteger(need.targetAmount) ||
    need.targetAmount <= 0
  ) ? 1 : 0
}

/**
 * Integer-exact need comparison, higher need first. The cross product is taken
 * in BigInt so `targetGap / targetAmount` never becomes a float division:
 * no tolerance constant, no NaN/Infinity path, no precision loss above 2^53.
 */
export function compareAllocationClassNeed(
  left: ExecutionPriorityClassNeed | null,
  right: ExecutionPriorityClassNeed | null,
): number {
  const leftTier = allocationClassNeedTier(left)
  const rightTier = allocationClassNeedTier(right)
  if (leftTier !== rightTier) return leftTier - rightTier
  if (leftTier === 1 || left === null || right === null) return 0
  const leftCross = BigInt(left.targetGap as number) * BigInt(right.targetAmount as number)
  const rightCross = BigInt(right.targetGap as number) * BigInt(left.targetAmount as number)
  return leftCross > rightCross ? -1 : leftCross < rightCross ? 1 : 0
}

/** The engine's single execution-priority comparator (DDR-R1 §5.1). Pure, 2-arity. */
export function compareExecutionPriority(
  left: ExecutionPriorityCandidate,
  right: ExecutionPriorityCandidate,
): number {
  const actionOrder = executionActionRank(left.buyKind) - executionActionRank(right.buyKind)
  if (actionOrder !== 0) return actionOrder

  const needOrder = compareAllocationClassNeed(left.classNeed, right.classNeed)
  if (needOrder !== 0) return needOrder

  const namespaceOrder = executionNamespaceRank(left.assetClass) - executionNamespaceRank(right.assetClass)
  if (namespaceOrder !== 0) return namespaceOrder

  // K4/K5 are reached only when both candidates share a namespace.
  if (left.marketRank === null && right.marketRank !== null) return 1
  if (left.marketRank !== null && right.marketRank === null) return -1
  if (left.marketRank !== null && right.marketRank !== null && left.marketRank !== right.marketRank) {
    return left.marketRank - right.marketRank
  }

  const artifactOrder = left.artifactIndex - right.artifactIndex
  if (artifactOrder !== 0) return artifactOrder

  return left.instrumentId < right.instrumentId
    ? -1
    : left.instrumentId > right.instrumentId ? 1 : 0
}

/**
 * Resolves a raw CandidateInput into comparator terms using only canonical
 * authorities: the instrument's own assetClass and the AssetClassPlan the
 * engine already built. No second target-gap calculation exists.
 */
export function toExecutionPriorityCandidate(
  candidate: CandidateInput,
  assetClass: AssetClass | null,
  classNeed: ExecutionPriorityClassNeed | null,
): ExecutionPriorityCandidate {
  return {
    instrumentId: candidate.instrumentId,
    buyKind: candidate.buyKind,
    assetClass,
    marketRank: candidate.marketRank,
    artifactIndex: candidate.artifactIndex,
    classNeed,
  }
}
