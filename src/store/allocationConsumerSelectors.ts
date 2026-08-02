import type { AppState, AllocationPlanSnapshotState } from '../types'
import type {
  AllocationConsumerSnapshot,
  AllocationClassProjection,
  AllocationInstrumentProjection,
} from '../types/allocationConsumer'
import type { AllocationPlanSnapshot, AssetClass } from '../types/allocationPlan'
import {
  classFullCause,
  orderBlockedReasons,
  orderLimitingFactors,
  orderWarningReasons,
  snapshotExecutability,
} from './allocationPlanSelectors'

type AvailableStatus = 'current' | 'estimate_only' | 'blocked'
type CacheEntry = {
  readonly status: AvailableStatus
  readonly generationId: string | null
  readonly value: AllocationConsumerSnapshot
}

const snapshotMemo = new WeakMap<AllocationPlanSnapshot, CacheEntry>()
const instrumentListMemo = new WeakMap<object, Map<AssetClass, readonly AllocationInstrumentProjection[]>>()
const t2ProjectionMemo = new WeakMap<object, T2AllocationProjection>()
const EMPTY_INSTRUMENTS = Object.freeze([]) as readonly AllocationInstrumentProjection[]

type AvailableAllocationConsumerSnapshot = Extract<
  AllocationConsumerSnapshot,
  { readonly availability: 'available' }
>

export interface T2AllocationProjection {
  readonly snapshot: AvailableAllocationConsumerSnapshot
  readonly jpTrustClass: AllocationClassProjection
}

const ABSENT = Object.freeze({
  availability: 'unavailable',
  status: 'absent',
  reasonKind: 'NOT_CALCULATED',
}) satisfies AllocationConsumerSnapshot
const INVALID = Object.freeze({
  availability: 'unavailable',
  status: 'invalid',
  reasonKind: 'INVALIDATED',
}) satisfies AllocationConsumerSnapshot
const STALE = Object.freeze({
  availability: 'unavailable',
  status: 'stale',
  reasonKind: 'INVALIDATED',
}) satisfies AllocationConsumerSnapshot

function unavailableForStatus(status: AllocationPlanSnapshotState): AllocationConsumerSnapshot {
  if (status === 'absent') return ABSENT
  if (status === 'stale') return STALE
  return INVALID
}

function unknownReason(status: AvailableStatus): AllocationConsumerSnapshot {
  return Object.freeze({
    availability: 'unavailable',
    status,
    reasonKind: 'UNKNOWN_REASON_CODE',
  })
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validNullableAmount(value: number | null): boolean {
  return value === null || isNonNegativeInteger(value)
}

function validSnapshotAmounts(snapshot: AllocationPlanSnapshot): boolean {
  if (![
    snapshot.totalAssets,
    snapshot.grossCash,
    snapshot.deployableCash,
    snapshot.shortTermBudget,
    snapshot.longTermBudget,
    snapshot.remainingUnallocatedCash,
  ].every(isNonNegativeInteger)) return false

  if (!snapshot.assetClassPlans.every(plan =>
    [
      plan.currentAmount,
      plan.targetAmount,
      plan.targetGap,
      plan.overweightAmount,
      plan.hardHeadroom,
      plan.softHeadroom,
      plan.effectiveHeadroom,
      plan.availableBudget,
      plan.allocatedAmount,
      plan.remainingHeadroom,
    ].every(isNonNegativeInteger) &&
    validNullableAmount(plan.maximumAmount),
  )) return false

  return snapshot.instrumentPlans.every(plan =>
    [
      plan.currentAmount,
      plan.classHeadroom,
      plan.effectiveInstrumentHeadroom,
      plan.estimatedMaximumAmount,
      plan.independentMaximum,
      plan.simultaneouslyExecutableAmount,
      plan.allocatedAmount,
      plan.finalSuggestedAmount,
    ].every(isNonNegativeInteger) &&
    validNullableAmount(plan.instrumentTargetGap),
  )
}

function projectSnapshot(
  snapshot: AllocationPlanSnapshot,
  status: AvailableStatus,
  sourceCandidateGenerationId: string | null,
): AllocationConsumerSnapshot {
  if (
    snapshot.snapshotId.length === 0 ||
    snapshot.generatedAt.length === 0 ||
    snapshot.sourceHoldingsSnapshotId.length === 0 ||
    snapshot.sourceSettingsVersion.length === 0 ||
    !validSnapshotAmounts(snapshot)
  ) return INVALID

  const blockedReasons = orderBlockedReasons(snapshot.blockedReasons)
  const warnings = orderWarningReasons(snapshot.warnings)
  if (blockedReasons === null || warnings === null) return unknownReason(status)

  const seenAssetClasses = new Set<AssetClass>()
  const classes: AllocationClassProjection[] = []
  for (const plan of snapshot.assetClassPlans) {
    if (seenAssetClasses.has(plan.assetClass)) return INVALID
    seenAssetClasses.add(plan.assetClass)
    const classBlockedReasons = orderBlockedReasons(plan.blockedReasons)
    const classWarningReasons = orderWarningReasons(plan.warningReasons)
    const classLimitingFactors = orderLimitingFactors(plan.limitingFactors)
    if (
      classBlockedReasons === null ||
      classWarningReasons === null ||
      classLimitingFactors === null
    ) return unknownReason(status)
    classes.push(Object.freeze({
      assetClass: plan.assetClass,
      currentAmount: plan.currentAmount,
      targetAmount: plan.targetAmount,
      targetRatio: plan.targetRatio,
      targetGap: plan.targetGap,
      overweightAmount: plan.overweightAmount,
      maximumAmount: plan.maximumAmount,
      hardHeadroom: plan.hardHeadroom,
      softHeadroom: plan.softHeadroom,
      effectiveHeadroom: plan.effectiveHeadroom,
      availableBudget: plan.availableBudget,
      allocatedAmount: plan.allocatedAmount,
      remainingHeadroom: plan.remainingHeadroom,
      instrumentPlanCount: snapshot.instrumentPlans.filter(
        instrument => instrument.assetClass === plan.assetClass,
      ).length,
      classFullCause: classFullCause(plan),
      blockedReasons: Object.freeze([...classBlockedReasons]),
      warningReasons: Object.freeze([...classWarningReasons]),
      limitingFactors: Object.freeze([...classLimitingFactors]),
    }))
  }

  const seenInstrumentIds = new Set<string>()
  const instruments: AllocationInstrumentProjection[] = []
  for (const plan of snapshot.instrumentPlans) {
    if (
      plan.instrumentId.length === 0 ||
      seenInstrumentIds.has(plan.instrumentId) ||
      plan.calculationSnapshotId !== snapshot.snapshotId
    ) return INVALID
    seenInstrumentIds.add(plan.instrumentId)
    const instrumentBlockedReasons = orderBlockedReasons(plan.blockedReasons)
    const instrumentWarningReasons = orderWarningReasons(plan.warningReasons)
    const instrumentLimitingFactors = orderLimitingFactors(plan.limitingFactors)
    if (
      instrumentBlockedReasons === null ||
      instrumentWarningReasons === null ||
      instrumentLimitingFactors === null
    ) return unknownReason(status)
    instruments.push(Object.freeze({
      instrumentId: plan.instrumentId,
      assetClass: plan.assetClass,
      kind: plan.kind,
      relationship: plan.relationship,
      buyKind: plan.buyKind,
      role: plan.role,
      currentAmount: plan.currentAmount,
      instrumentTargetGap: plan.instrumentTargetGap,
      classHeadroom: plan.classHeadroom,
      effectiveInstrumentHeadroom: plan.effectiveInstrumentHeadroom,
      estimatedMaximumAmount: plan.estimatedMaximumAmount,
      independentMaximum: plan.independentMaximum,
      simultaneouslyExecutableAmount: plan.simultaneouslyExecutableAmount,
      allocatedAmount: plan.allocatedAmount,
      finalSuggestedAmount: plan.finalSuggestedAmount,
      executable: plan.executable,
      calculationSnapshotId: plan.calculationSnapshotId,
      blockedReasons: Object.freeze([...instrumentBlockedReasons]),
      warningReasons: Object.freeze([...instrumentWarningReasons]),
      limitingFactors: Object.freeze([...instrumentLimitingFactors]),
    }))
  }

  return Object.freeze({
    availability: 'available',
    status,
    generation: Object.freeze({
      snapshotId: snapshot.snapshotId,
      generatedAt: snapshot.generatedAt,
      sourceHoldingsSnapshotId: snapshot.sourceHoldingsSnapshotId,
      sourceSettingsVersion: snapshot.sourceSettingsVersion,
      sourceCandidateGenerationId,
    }),
    snapshotExecutability: snapshotExecutability(snapshot),
    totalAssets: snapshot.totalAssets,
    grossCash: snapshot.grossCash,
    deployableCash: snapshot.deployableCash,
    shortTermBudget: snapshot.shortTermBudget,
    longTermBudget: snapshot.longTermBudget,
    remainingUnallocatedCash: snapshot.remainingUnallocatedCash,
    marketMode: snapshot.marketMode,
    regime: snapshot.regime,
    classes: Object.freeze(classes),
    instruments: Object.freeze(instruments),
    blockedReasons: Object.freeze([...blockedReasons]),
    warnings: Object.freeze([...warnings]),
  })
}

export function selectAllocationConsumerSnapshot(state: AppState): AllocationConsumerSnapshot {
  if (
    state.allocationPlan === null ||
    state.allocationPlanStatus === 'absent' ||
    state.allocationPlanStatus === 'invalid' ||
    state.allocationPlanStatus === 'stale'
  ) return unavailableForStatus(state.allocationPlanStatus)

  const cached = snapshotMemo.get(state.allocationPlan)
  if (
    cached !== undefined &&
    cached.status === state.allocationPlanStatus &&
    cached.generationId === state.allocationPlanCandidateGenerationId
  ) return cached.value

  const value = projectSnapshot(
    state.allocationPlan,
    state.allocationPlanStatus,
    state.allocationPlanCandidateGenerationId,
  )
  snapshotMemo.set(state.allocationPlan, {
    status: state.allocationPlanStatus,
    generationId: state.allocationPlanCandidateGenerationId,
    value,
  })
  return value
}

export const selectAllocationClassProjection = (assetClass: AssetClass) =>
  (state: AppState): AllocationClassProjection | null => {
    const snapshot = selectAllocationConsumerSnapshot(state)
    if (snapshot.availability === 'unavailable') return null
    return snapshot.classes.find(plan => plan.assetClass === assetClass) ?? null
  }

export const selectAllocationInstrumentProjections = (assetClass: AssetClass) =>
  (state: AppState): readonly AllocationInstrumentProjection[] | null => {
    const snapshot = selectAllocationConsumerSnapshot(state)
    if (snapshot.availability === 'unavailable') return null
    let byClass = instrumentListMemo.get(snapshot)
    if (byClass === undefined) {
      byClass = new Map()
      instrumentListMemo.set(snapshot, byClass)
    }
    const cached = byClass.get(assetClass)
    if (cached !== undefined) return cached
    const selected = snapshot.instruments.filter(plan => plan.assetClass === assetClass)
    const value = selected.length === 0 ? EMPTY_INSTRUMENTS : Object.freeze(selected)
    byClass.set(assetClass, value)
    return value
  }

export function selectT2AllocationProjection(state: AppState): T2AllocationProjection | null {
  const snapshot = selectAllocationConsumerSnapshot(state)
  if (snapshot.availability === 'unavailable') return null
  const jpTrustClass = snapshot.classes.find(plan => plan.assetClass === 'JP_TRUST')
  if (jpTrustClass === undefined) return null
  const cached = t2ProjectionMemo.get(snapshot)
  if (cached !== undefined) return cached
  const value = Object.freeze({ snapshot, jpTrustClass })
  t2ProjectionMemo.set(snapshot, value)
  return value
}
