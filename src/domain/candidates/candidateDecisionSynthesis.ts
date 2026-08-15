import type { Holding } from '../../types'
import type {
  BlockedReason,
  CandidateInput,
  LimitingFactor,
  WarningReason,
} from '../../types/allocationPlan'
import {
  CANDIDATE_DECISION_SYNTHESIS_AUTHORITY_VERSION,
  CANDIDATE_DECISION_SYNTHESIS_DECISION_LIMIT,
  CANDIDATE_DECISION_SYNTHESIS_SCHEMA_VERSION,
  CANDIDATE_DECISION_SYNTHESIS_WATCH_LIMIT,
  SYNTHESIS_DATASET_REASONS,
  SYNTHESIS_REASON_CODES,
  type CandidateDecisionSynthesisCandidateInput,
  type CandidateDecisionSynthesisEntry,
  type CandidateDecisionSynthesisInput,
  type CandidateDecisionSynthesisInvariantContext,
  type CandidateDecisionSynthesisInvariantId,
  type CandidateDecisionSynthesisInvariantResult,
  type CandidateDecisionSynthesisProvenance,
  type CandidateDecisionSynthesisSnapshot,
  type CandidateSynthesisClassNeed,
  type CandidateSynthesisNamespace,
  type SynthesisAction,
  type SynthesisDatasetReason,
  type SynthesisReasonCode,
} from '../../types/candidateDecisionSynthesis'
import {
  CANDIDATE_HOLDING_RELATIONSHIPS,
  CANDIDATE_PORTFOLIO_FIT_REASONS,
  CANDIDATE_PORTFOLIO_FIT_RISKS,
} from '../../types/candidatePortfolioFit'
import {
  compareUtf16CodeUnits,
  sha256Utf8Hex,
  stableSerializeCsvSemanticContent,
} from '../csv/csvSemanticIdentity'
import { isStrictTimestamp } from '../../utils/strictTimestamp'
import { candidateAllocationInstrumentId } from './candidatePortfolioRecommendation'
import { trustAllocationInstrumentId } from './trustAllocationCandidates'

export const JP_DOMESTIC_LOT_SIZE_SHARES = 100 as const

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

const ALLOCATION_STATUSES = ['absent', 'current', 'estimate_only', 'blocked', 'invalid', 'stale'] as const
const CANDIDATE_FRESHNESS = ['fresh', 'stale', 'degraded', 'invalid', 'unavailable'] as const
const FIT_STATUSES = ['evaluated', 'partial', 'unavailable', 'invalid', 'not_evaluated'] as const
const NAMESPACES = ['jp_stock_funnel', 'jp_trust_registry'] as const
const DATASET_REASON_SET = new Set<string>(SYNTHESIS_DATASET_REASONS)
const SYNTHESIS_REASON_SET = new Set<string>(SYNTHESIS_REASON_CODES)

interface PreparedEntry {
  readonly entry: Omit<CandidateDecisionSynthesisEntry, 'rank'>
  readonly namespace: CandidateSynthesisNamespace
  readonly artifactIndex: number
  readonly classNeed: CandidateSynthesisClassNeed
  readonly usesCandidatesStocksExecutionPrice: boolean
}

export interface HoldingAllocationCandidateAdapterResult {
  readonly status: 'available' | 'invalid'
  readonly candidates: readonly CandidateInput[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isStrictTimestamp(value)
}

function isNullableNonemptyString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0)
}

function canonicalOrder<T extends string>(values: readonly T[], order: readonly T[]): readonly T[] | null {
  const rank = new Map<string, number>(order.map((value, index) => [value, index]))
  if (values.some(value => !rank.has(value))) return null
  return [...new Set(values)].sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0))
}

function orderedStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareUtf16CodeUnits)
}

function orderedSynthesisReasons(values: readonly SynthesisReasonCode[]): readonly SynthesisReasonCode[] {
  return canonicalOrder(values, SYNTHESIS_REASON_CODES) ?? []
}

function orderedDatasetReasons(values: readonly SynthesisDatasetReason[]): readonly SynthesisDatasetReason[] {
  return canonicalOrder(values, SYNTHESIS_DATASET_REASONS) ?? ['SYNTHESIS_INPUT_INVALID']
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function emptyProvenance(value: unknown): CandidateDecisionSynthesisProvenance {
  const source = isRecord(value) ? value : {}
  const stringOrEmpty = (key: string): string => typeof source[key] === 'string' ? source[key] : ''
  const nullableString = (key: string): string | null => source[key] === null || typeof source[key] !== 'string'
    ? null
    : source[key]
  return {
    candidateGenerationId: stringOrEmpty('candidateGenerationId'),
    candidatePublicationState: source.candidatePublicationState === 'published_pass'
      ? 'published_pass'
      : 'published_pass',
    candidateFreshness: isOneOf(source.candidateFreshness, CANDIDATE_FRESHNESS)
      ? source.candidateFreshness
      : 'invalid',
    allocationSnapshotId: stringOrEmpty('allocationSnapshotId'),
    allocationSnapshotGeneratedAt: stringOrEmpty('allocationSnapshotGeneratedAt'),
    allocationSnapshotStatus: isOneOf(source.allocationSnapshotStatus, ALLOCATION_STATUSES)
      ? source.allocationSnapshotStatus
      : 'invalid',
    sourceHoldingsSnapshotId: stringOrEmpty('sourceHoldingsSnapshotId'),
    sourceSettingsVersion: stringOrEmpty('sourceSettingsVersion'),
    cashAuthorityUpdatedAt: nullableString('cashAuthorityUpdatedAt'),
    marketDataAsOf: nullableString('marketDataAsOf'),
    portfolioFitEvaluatedAt: stringOrEmpty('portfolioFitEvaluatedAt'),
    candidatesStocksUpdatedAt: nullableString('candidatesStocksUpdatedAt'),
    candidatesStocksSourceUpdatedAt: nullableString('candidatesStocksSourceUpdatedAt'),
    candidatesStocksRunToken: nullableString('candidatesStocksRunToken'),
  }
}

/**
 * candidateGenerationId is an opaque exact upstream generation identity, not a
 * timestamp-arithmetic field. It must be preserved verbatim (including
 * sub-millisecond precision some upstream generations emit) and compared by
 * exact string equality, so it is validated as a non-empty string only.
 */
function isCandidateGenerationIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function validProvenance(value: unknown): value is CandidateDecisionSynthesisProvenance {
  if (!isRecord(value)) return false
  return (
    isCandidateGenerationIdentity(value.candidateGenerationId) &&
    value.candidatePublicationState === 'published_pass' &&
    isOneOf(value.candidateFreshness, CANDIDATE_FRESHNESS) &&
    typeof value.allocationSnapshotId === 'string' && value.allocationSnapshotId.length > 0 &&
    isStrictTimestamp(value.allocationSnapshotGeneratedAt) &&
    isOneOf(value.allocationSnapshotStatus, ALLOCATION_STATUSES) &&
    typeof value.sourceHoldingsSnapshotId === 'string' && value.sourceHoldingsSnapshotId.length > 0 &&
    typeof value.sourceSettingsVersion === 'string' && value.sourceSettingsVersion.length > 0 &&
    isNullableTimestamp(value.cashAuthorityUpdatedAt) &&
    isNullableTimestamp(value.marketDataAsOf) &&
    isStrictTimestamp(value.portfolioFitEvaluatedAt) &&
    isNullableTimestamp(value.candidatesStocksUpdatedAt) &&
    isNullableTimestamp(value.candidatesStocksSourceUpdatedAt) &&
    isNullableNonemptyString(value.candidatesStocksRunToken)
  )
}

function synthesisIdFor(
  provenance: CandidateDecisionSynthesisProvenance,
  entries: readonly PreparedEntry[],
): string {
  const entryIdentity = entries
    .map(item => ({
      instrumentId: item.entry.instrumentId,
      assetClass: item.entry.assetClass,
      namespace: item.namespace,
      artifactIndex: item.artifactIndex,
      relationship: item.entry.relationship,
    }))
    .sort((left, right) => compareUtf16CodeUnits(
      stableSerializeCsvSemanticContent(left),
      stableSerializeCsvSemanticContent(right),
    ))
  const semanticIdentity = stableSerializeCsvSemanticContent({
    authorityVersion: CANDIDATE_DECISION_SYNTHESIS_AUTHORITY_VERSION,
    ...provenance,
    entryIdentity,
  })
  return `candidate-decision-synthesis:${sha256Utf8Hex(semanticIdentity)}`
}

function invalidSnapshot(
  generatedAt: unknown,
  provenanceValue: unknown,
  reasons: readonly SynthesisDatasetReason[],
): CandidateDecisionSynthesisSnapshot {
  const provenance = emptyProvenance(provenanceValue)
  return deepFreeze({
    schemaVersion: CANDIDATE_DECISION_SYNTHESIS_SCHEMA_VERSION,
    authorityVersion: CANDIDATE_DECISION_SYNTHESIS_AUTHORITY_VERSION,
    synthesisId: synthesisIdFor(provenance, []),
    generatedAt: typeof generatedAt === 'string' ? generatedAt : '',
    status: 'invalid',
    provenance,
    decisions: [],
    watchList: [],
    datasetReasons: orderedDatasetReasons(reasons),
    privacyMode: 'local_only',
    persistence: 'none',
    not_for_trading: true,
  })
}

function classNeedTier(value: CandidateSynthesisClassNeed): 0 | 1 {
  return (
    value.blockedReasons.includes('CLASS_TARGET_MISSING') ||
    !isNonNegativeInteger(value.targetGap) ||
    !isNonNegativeInteger(value.targetAmount) ||
    value.targetAmount <= 0
  ) ? 1 : 0
}

/** R1 integer-exact targetGap/targetAmount comparison; higher need sorts first. */
export function compareCandidateClassNeed(
  left: CandidateSynthesisClassNeed,
  right: CandidateSynthesisClassNeed,
): number {
  const leftTier = classNeedTier(left)
  const rightTier = classNeedTier(right)
  if (leftTier !== rightTier) return leftTier - rightTier
  if (leftTier === 1) return 0
  const leftCross = BigInt(left.targetGap as number) * BigInt(right.targetAmount as number)
  const rightCross = BigInt(right.targetGap as number) * BigInt(left.targetAmount as number)
  return leftCross > rightCross ? -1 : leftCross < rightCross ? 1 : 0
}

export function candidateSynthesisActionRank(action: SynthesisAction): 0 | 1 | 2 {
  if (action === 'ADD' || action === 'BUY_NEW') return 0
  return action === 'WATCH' ? 1 : 2
}

function namespaceRank(namespace: CandidateSynthesisNamespace): 0 | 1 {
  return namespace === 'jp_stock_funnel' ? 0 : 1
}

function nullableRank(left: number | null, right: number | null): number {
  if (left === null && right !== null) return 1
  if (left !== null && right === null) return -1
  return left !== null && right !== null ? left - right : 0
}

function comparePreparedEntries(left: PreparedEntry, right: PreparedEntry): number {
  const leftMoneyRank = left.entry.money.kind === 'EXECUTABLE' ? 0 : 1
  const rightMoneyRank = right.entry.money.kind === 'EXECUTABLE' ? 0 : 1
  const moneyOrder = leftMoneyRank - rightMoneyRank
  if (moneyOrder !== 0) return moneyOrder

  const actionOrder = candidateSynthesisActionRank(left.entry.action) - candidateSynthesisActionRank(right.entry.action)
  if (actionOrder !== 0) return actionOrder

  const needOrder = compareCandidateClassNeed(left.classNeed, right.classNeed)
  if (needOrder !== 0) return needOrder

  const namespaceOrder = namespaceRank(left.namespace) - namespaceRank(right.namespace)
  if (namespaceOrder !== 0) return namespaceOrder

  const marketOrder = nullableRank(
    left.entry.candidateQuality.marketRank,
    right.entry.candidateQuality.marketRank,
  )
  if (marketOrder !== 0) return marketOrder

  const artifactOrder = left.artifactIndex - right.artifactIndex
  if (artifactOrder !== 0) return artifactOrder
  return compareUtf16CodeUnits(left.entry.instrumentId, right.entry.instrumentId)
}

function validStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function validKnownArray<T extends string>(value: unknown, allowed: ReadonlySet<string>): value is readonly T[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && allowed.has(item))
}

function validIdentity(candidate: CandidateDecisionSynthesisCandidateInput): boolean {
  if (candidate.assetClass === 'JP_STOCK') {
    return candidate.namespace === 'jp_stock_funnel' &&
      candidate.candidateQuality.source === 'candidate_funnel' &&
      candidate.code !== null &&
      candidateAllocationInstrumentId(candidate.code) === candidate.instrumentId
  }
  if (candidate.assetClass === 'JP_TRUST') {
    const prefix = 'trust:'
    if (!candidate.instrumentId.startsWith(prefix)) return false
    const id = candidate.instrumentId.slice(prefix.length)
    return candidate.namespace === 'jp_trust_registry' &&
      candidate.candidateQuality.source === 'trust_registry' &&
      candidate.code === null &&
      trustAllocationInstrumentId({ id }) === candidate.instrumentId
  }
  return false
}

function prepareCandidate(value: unknown): PreparedEntry | null {
  if (!isRecord(value)) return null
  const candidate = value as unknown as CandidateDecisionSynthesisCandidateInput
  const quality = candidate.candidateQuality
  const fit = candidate.portfolioFit
  const allocation = candidate.canonicalAllocation
  if (
    !isOneOf(candidate.namespace, NAMESPACES) ||
    (candidate.assetClass !== 'JP_STOCK' && candidate.assetClass !== 'JP_TRUST') ||
    typeof candidate.instrumentId !== 'string' || candidate.instrumentId.length === 0 ||
    typeof candidate.displayName !== 'string' || candidate.displayName.length === 0 ||
    !isNonNegativeInteger(candidate.artifactIndex) ||
    !isRecord(quality) || !isRecord(fit) || !isRecord(allocation) ||
    !validIdentity(candidate)
  ) return null

  const marketRank = quality.marketRank
  const marketScore = quality.marketScore
  const dataConfidence = quality.dataConfidence
  if (
    (quality.source !== 'candidate_funnel' && quality.source !== 'trust_registry') ||
    !(marketRank === null || (Number.isSafeInteger(marketRank) && marketRank > 0)) ||
    !(marketScore === null || (typeof marketScore === 'number' && Number.isFinite(marketScore))) ||
    !(quality.tier === null || quality.tier === 'actionable' || quality.tier === 'deep_review') ||
    !(dataConfidence === null || (typeof dataConfidence === 'number' && Number.isFinite(dataConfidence) && dataConfidence >= 0 && dataConfidence <= 1)) ||
    !validStringArray(quality.selectedReasons) || !validStringArray(quality.riskReasons)
  ) return null

  if (
    !isOneOf(fit.status, FIT_STATUSES) ||
    !(fit.relationship === null || isOneOf(fit.relationship, CANDIDATE_HOLDING_RELATIONSHIPS)) ||
    !validKnownArray(fit.reasons, new Set(CANDIDATE_PORTFOLIO_FIT_REASONS)) ||
    !validKnownArray(fit.risks, new Set(CANDIDATE_PORTFOLIO_FIT_RISKS)) ||
    typeof fit.hardGatePassed !== 'boolean'
  ) return null

  if (
    allocation.relationship !== 'already_held' &&
    allocation.relationship !== 'new_to_portfolio' &&
    allocation.relationship !== 'unknown'
  ) return null
  if (allocation.relationship === 'unknown') return null
  if (
    typeof allocation.executable !== 'boolean' ||
    !isNonNegativeInteger(allocation.finalSuggestedAmount) ||
    typeof allocation.calculationSnapshotId !== 'string' || allocation.calculationSnapshotId.length === 0 ||
    !isRecord(allocation.classNeed) || !Array.isArray(allocation.classNeed.blockedReasons) ||
    !isRecord(allocation.allocationRole) ||
    !isNonNegativeInteger(allocation.allocationRole.assetClassTargetGap) ||
    !isFiniteNonNegative(allocation.allocationRole.assetClassTargetRatio) ||
    !isNonNegativeInteger(allocation.allocationRole.classHeadroom) ||
    !isNonNegativeInteger(allocation.allocationRole.instrumentHeadroom) ||
    !Array.isArray(allocation.blockedReasons) || !Array.isArray(allocation.warnings) ||
    !Array.isArray(allocation.limitingFactors) ||
    !validKnownArray(candidate.whyThis, SYNTHESIS_REASON_SET) ||
    !validKnownArray(candidate.whyNotExecutable, SYNTHESIS_REASON_SET) ||
    typeof candidate.usesCandidatesStocksExecutionPrice !== 'boolean'
  ) return null

  const classBlocked = canonicalOrder(allocation.classNeed.blockedReasons, BLOCKED_REASON_ORDER)
  const blockedReasons = canonicalOrder(allocation.blockedReasons, BLOCKED_REASON_ORDER)
  const warnings = canonicalOrder(allocation.warnings, WARNING_REASON_ORDER)
  const limitingFactors = canonicalOrder(allocation.limitingFactors, LIMITING_FACTOR_ORDER)
  if (classBlocked === null || blockedReasons === null || warnings === null || limitingFactors === null) return null
  if (allocation.executable !== (allocation.finalSuggestedAmount > 0)) return null
  if (allocation.executable && (
    allocation.finalSuggestedAmount > allocation.allocationRole.classHeadroom ||
    allocation.finalSuggestedAmount > allocation.allocationRole.instrumentHeadroom ||
    (classNeedTier(allocation.classNeed) === 0 &&
      allocation.finalSuggestedAmount > (allocation.classNeed.targetGap as number))
  )) return null

  const blocked = blockedReasons.length > 0 || fit.relationship === 'holding_match_unknown'
  const executable = allocation.executable && fit.hardGatePassed && !blocked
  const action: SynthesisAction = blocked
    ? 'BLOCKED'
    : !fit.hardGatePassed
      ? 'WATCH'
      : allocation.relationship === 'already_held'
        ? 'ADD'
        : 'BUY_NEW'

  const money: CandidateDecisionSynthesisEntry['money'] = executable
    ? {
        kind: 'EXECUTABLE',
        executableAmountJpy: allocation.finalSuggestedAmount,
        calculationSnapshotId: allocation.calculationSnapshotId,
      }
    : { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 }

  const entryId = `${candidate.assetClass}:${candidate.instrumentId}`
  return {
    entry: {
      entryId,
      instrumentId: candidate.instrumentId,
      assetClass: candidate.assetClass,
      displayName: candidate.displayName,
      code: candidate.code,
      action,
      relationship: allocation.relationship,
      candidateQuality: {
        source: quality.source,
        marketRank,
        marketScore,
        tier: quality.tier,
        dataConfidence,
        selectedReasons: orderedStrings(quality.selectedReasons),
        riskReasons: orderedStrings(quality.riskReasons),
      },
      portfolioFit: {
        status: fit.status,
        relationship: fit.relationship,
        reasons: canonicalOrder(fit.reasons, CANDIDATE_PORTFOLIO_FIT_REASONS) ?? [],
        risks: canonicalOrder(fit.risks, CANDIDATE_PORTFOLIO_FIT_RISKS) ?? [],
        hardGatePassed: fit.hardGatePassed,
      },
      allocationRole: { ...allocation.allocationRole },
      money,
      blockingReasons: blockedReasons,
      warnings,
      limitingFactors,
      whyThis: orderedSynthesisReasons(candidate.whyThis),
      whyNotExecutable: orderedSynthesisReasons(candidate.whyNotExecutable),
    },
    namespace: candidate.namespace,
    artifactIndex: candidate.artifactIndex,
    classNeed: {
      targetGap: allocation.classNeed.targetGap,
      targetAmount: allocation.classNeed.targetAmount,
      blockedReasons: classBlocked,
    },
    usesCandidatesStocksExecutionPrice: candidate.usesCandidatesStocksExecutionPrice,
  }
}

/** Pure Q7 normalization only; it is not a price join or a sizing calculation. */
export function normalizeCandidateExecutionReferencePrice(rawPrice: unknown): number | null {
  return typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0
    ? Math.ceil(rawPrice)
    : null
}

/** Pure population-A adapter. Price/lot wiring remains outside tranche 1A. */
export function buildHoldingAllocationCandidates(input: {
  readonly holdings: readonly Holding[]
}): HoldingAllocationCandidateAdapterResult {
  const identities = new Set<string>()
  const instrumentIds: string[] = []
  for (const holding of input.holdings) {
    const instrumentId = candidateAllocationInstrumentId(holding.code)
    if (instrumentId === null || identities.has(instrumentId)) {
      return deepFreeze({ status: 'invalid', candidates: [] })
    }
    identities.add(instrumentId)
    instrumentIds.push(instrumentId)
  }
  instrumentIds.sort(compareUtf16CodeUnits)
  return deepFreeze({
    status: 'available',
    candidates: instrumentIds.map((instrumentId, artifactIndex) => ({
      instrumentId,
      buyKind: 'BUY_MORE',
      marketRank: null,
      artifactIndex,
      confidence: null,
    })),
  })
}

export function assertCandidateDecisionSynthesisInvariants(
  snapshot: CandidateDecisionSynthesisSnapshot,
  context: CandidateDecisionSynthesisInvariantContext,
): CandidateDecisionSynthesisInvariantResult {
  const violated: CandidateDecisionSynthesisInvariantId[] = []
  if (context.allocationPlanCandidateGenerationId !== snapshot.provenance.candidateGenerationId) {
    violated.push('I-SYN-1')
  }
  if (snapshot.decisions.concat(snapshot.watchList).some(entry =>
    entry.money.kind === 'EXECUTABLE' &&
    entry.money.calculationSnapshotId !== snapshot.provenance.allocationSnapshotId)) {
    violated.push('I-SYN-2')
  }
  if (['absent', 'invalid', 'stale'].includes(snapshot.provenance.allocationSnapshotStatus)) {
    violated.push('I-SYN-3')
  }
  if (snapshot.provenance.sourceHoldingsSnapshotId.length === 0 || snapshot.provenance.sourceSettingsVersion.length === 0) {
    violated.push('I-SYN-4')
  }
  if (!isStrictTimestamp(snapshot.provenance.portfolioFitEvaluatedAt)) violated.push('I-SYN-5')
  if (snapshot.synthesisId !== context.expectedSynthesisId) violated.push('I-SYN-6', 'I-SYN-8')
  if (context.usesCandidatesStocksExecutionPrice && snapshot.provenance.candidatesStocksUpdatedAt === null) {
    violated.push('I-SYN-7')
  }
  return deepFreeze({ ok: violated.length === 0, violated })
}

/**
 * Canonical local-only synthesis writer. It validates and copies an upstream
 * AllocationPlan projection; it never calculates cash, headroom, target gap,
 * purchase units, or an executable yen amount.
 */
export function buildCandidateDecisionSynthesis(
  input: CandidateDecisionSynthesisInput,
): CandidateDecisionSynthesisSnapshot {
  try {
    if (!isRecord(input) || !isStrictTimestamp(input.generatedAt) || !validProvenance(input.provenance)) {
      return invalidSnapshot(input?.generatedAt, input?.provenance, ['MISSING_REQUIRED_PROVENANCE'])
    }
    if (!Array.isArray(input.candidates) || !Array.isArray(input.datasetReasons) ||
      !validKnownArray(input.datasetReasons, DATASET_REASON_SET)) {
      return invalidSnapshot(input.generatedAt, input.provenance, ['SYNTHESIS_INPUT_INVALID'])
    }
    if (input.allocationPlanCandidateGenerationId !== input.provenance.candidateGenerationId) {
      return invalidSnapshot(input.generatedAt, input.provenance, ['ALLOCATION_CANDIDATE_GENERATION_MISMATCH'])
    }
    if (['absent', 'invalid', 'stale'].includes(input.provenance.allocationSnapshotStatus)) {
      return invalidSnapshot(input.generatedAt, input.provenance, ['ALLOCATION_SNAPSHOT_UNAVAILABLE'])
    }

    const prepared: PreparedEntry[] = []
    for (const candidate of input.candidates) {
      const normalized = prepareCandidate(candidate)
      if (normalized === null) {
        const candidateRecord = isRecord(candidate) ? candidate : {}
        const assetClass = candidateRecord.assetClass
        const namespace = candidateRecord.namespace
        const reason: SynthesisDatasetReason =
          assetClass !== 'JP_STOCK' && assetClass !== 'JP_TRUST'
            ? 'UNSUPPORTED_ASSET_CLASS'
            : !isOneOf(namespace, NAMESPACES)
              ? 'UNKNOWN_NAMESPACE'
              : 'MALFORMED_ALLOCATION_PROJECTION'
        return invalidSnapshot(input.generatedAt, input.provenance, [reason])
      }
      if (normalized.entry.money.kind === 'EXECUTABLE' &&
        normalized.entry.money.calculationSnapshotId !== input.provenance.allocationSnapshotId) {
        return invalidSnapshot(input.generatedAt, input.provenance, ['ALLOCATION_SNAPSHOT_ID_MISMATCH'])
      }
      if (normalized.usesCandidatesStocksExecutionPrice && input.provenance.candidatesStocksUpdatedAt === null) {
        return invalidSnapshot(input.generatedAt, input.provenance, ['EXECUTION_PRICE_PROVENANCE_MISSING'])
      }
      prepared.push(normalized)
    }

    const instrumentIds = new Set<string>()
    const entryIds = new Set<string>()
    for (const item of prepared) {
      if (instrumentIds.has(item.entry.instrumentId)) {
        return invalidSnapshot(input.generatedAt, input.provenance, ['DUPLICATE_INSTRUMENT_ID'])
      }
      if (entryIds.has(item.entry.entryId)) {
        return invalidSnapshot(input.generatedAt, input.provenance, ['DUPLICATE_ENTRY_ID'])
      }
      instrumentIds.add(item.entry.instrumentId)
      entryIds.add(item.entry.entryId)
    }

    const ordered = [...prepared].sort(comparePreparedEntries)
    const synthesisId = synthesisIdFor(input.provenance, ordered)
    const decisions = ordered
      .filter(item => item.entry.action === 'ADD' || item.entry.action === 'BUY_NEW')
      .slice(0, CANDIDATE_DECISION_SYNTHESIS_DECISION_LIMIT)
      .map((item, index) => ({ ...item.entry, rank: index + 1 }))
    const watchList = ordered
      .filter(item => item.entry.action === 'WATCH' || item.entry.action === 'BLOCKED')
      .slice(0, CANDIDATE_DECISION_SYNTHESIS_WATCH_LIMIT)
      .map((item, index) => ({ ...item.entry, rank: index + 1 }))

    const snapshot: CandidateDecisionSynthesisSnapshot = {
      schemaVersion: CANDIDATE_DECISION_SYNTHESIS_SCHEMA_VERSION,
      authorityVersion: CANDIDATE_DECISION_SYNTHESIS_AUTHORITY_VERSION,
      synthesisId,
      generatedAt: input.generatedAt,
      status: 'available',
      provenance: { ...input.provenance },
      decisions,
      watchList,
      datasetReasons: orderedDatasetReasons(input.datasetReasons),
      privacyMode: 'local_only',
      persistence: 'none',
      not_for_trading: true,
    }
    const invariantResult = assertCandidateDecisionSynthesisInvariants(snapshot, {
      allocationPlanCandidateGenerationId: input.allocationPlanCandidateGenerationId,
      usesCandidatesStocksExecutionPrice: ordered.some(item => item.usesCandidatesStocksExecutionPrice),
      expectedSynthesisId: synthesisId,
    })
    return invariantResult.ok
      ? deepFreeze(snapshot)
      : invalidSnapshot(input.generatedAt, input.provenance, ['SYNTHESIS_INPUT_INVALID'])
  } catch {
    return invalidSnapshot(input?.generatedAt, input?.provenance, ['SYNTHESIS_INPUT_INVALID'])
  }
}
