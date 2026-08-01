import {
  ALLOCATION_PLAN_SCHEMA_VERSION,
  type AllocationPlanInput,
  type AllocationPlanSnapshot,
  type AssetClass,
  type AssetClassPlan,
  type BlockedReason,
  type CandidateInput,
  type InstrumentInput,
  type InstrumentPlan,
  type JpTrustPlanSummary,
  type WarningReason,
} from '../../types/allocationPlan'
import { deriveCashModel } from './cash'
import {
  computeAssetClassHeadroom,
  computeDomesticStockHeadroom,
  computeInstrumentHeadroom,
} from './headroom'
import { allValidMoney, isRatio01, roundDownToUnit, toIntegerJpy, unique } from './numeric'
import { computePurchaseAmount } from './purchaseAmount'
import { evaluateSafetyBehavior } from './safety'

const LONG_TERM_CLASSES = new Set<AssetClass>(['JP_STOCK', 'OVERSEAS_TRUST', 'GOLD'])

function rankCandidates(candidates: readonly CandidateInput[]): CandidateInput[] {
  return [...candidates].sort((left, right) => {
    const leftRank = left.marketRank ?? Number.MAX_SAFE_INTEGER
    const rightRank = right.marketRank ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank
      || left.artifactIndex - right.artifactIndex
      || (left.instrumentId < right.instrumentId ? -1 : left.instrumentId > right.instrumentId ? 1 : 0)
  })
}

function budgetForClass(
  assetClass: AssetClass,
  shortTermBudget: number,
  longTermBudget: number,
): number {
  if (assetClass === 'JP_TRUST') return shortTermBudget
  if (LONG_TERM_CLASSES.has(assetClass)) return longTermBudget
  return 0
}

function sumCurrentAssets(input: AllocationPlanInput): { totalAssets: number; invalid: boolean } {
  const investable = input.assetClasses
    .filter(({ assetClass }) => assetClass !== 'CASH' && assetClass !== 'CASH_RESERVE')
    .map(({ currentAmount }) => currentAmount)
  const invalid = !allValidMoney(investable)
  return {
    totalAssets: investable.reduce((sum, value) => sum + toIntegerJpy(value), 0)
      + toIntegerJpy(input.cash.grossCash ?? 0),
    invalid,
  }
}

function buildAssetClassPlans(
  input: AllocationPlanInput,
  totalAssets: number,
  deployableCash: number,
  shortTermBudget: number,
  longTermBudget: number,
): AssetClassPlan[] {
  return input.assetClasses.map((assetInput) => {
    const policy = input.policy.assetClassPolicies.find(
      (candidate) => candidate.assetClass === assetInput.assetClass,
    )
    if (!policy || !isRatio01(policy.targetRatio)) {
      return computeAssetClassHeadroom({
        assetClass: assetInput.assetClass,
        currentAmount: assetInput.currentAmount,
        totalAssets: 0,
        targetRatio: 0,
        maximumAmount: 0,
        availableBudget: 0,
      })
    }

    const availableBudget = Math.min(
      deployableCash,
      budgetForClass(assetInput.assetClass, shortTermBudget, longTermBudget),
    )
    let maximumAmount = policy.maximumAmountJpy
    if (policy.maximumRatio !== null && isRatio01(policy.maximumRatio)) {
      const ratioMaximum = Math.floor(totalAssets * policy.maximumRatio)
      maximumAmount = maximumAmount === null
        ? ratioMaximum
        : Math.min(toIntegerJpy(maximumAmount), ratioMaximum)
    }
    if (assetInput.assetClass === 'JP_STOCK') {
      const domestic = computeDomesticStockHeadroom({
        totalAssets,
        currentDomesticStockAmount: assetInput.currentAmount,
        jpStockMaxRatio: input.policy.jpStockMaxRatio === null
          ? null
          : input.policy.jpStockCapRegimeMode === 'min_with_regime'
            ? Math.min(input.policy.jpStockMaxRatio, policy.targetRatio)
            : input.policy.jpStockMaxRatio,
        jpStockMaxAmountJpy: input.policy.jpStockMaxAmountJpy,
      })
      maximumAmount = domestic.effectiveDomesticStockCap
    }

    return computeAssetClassHeadroom({
      assetClass: assetInput.assetClass,
      currentAmount: assetInput.currentAmount,
      totalAssets,
      targetRatio: policy.targetRatio,
      maximumAmount,
      availableBudget,
    })
  })
}

function minimumAndUnit(
  input: AllocationPlanInput,
  instrument: InstrumentInput,
): { minimum: number; unit: number } {
  const instrumentPolicy = input.policy.instrumentPolicies.find(
    ({ instrumentId }) => instrumentId === instrument.instrumentId,
  )
  const rounding = input.policy.roundingPolicies.find(({ kind }) => kind === instrument.kind)
  const fallbackUnit = toIntegerJpy(rounding?.purchaseUnitJpy ?? 0)
  if (
    instrument.kind === 'jp_stock'
    && instrument.priceJpy !== null
    && instrument.lotSizeShares !== null
    && instrument.priceJpy > 0
    && instrument.lotSizeShares > 0
  ) {
    const lotUnit = Math.ceil(
      instrument.priceJpy
      * (1 + input.policy.executionPriceBufferRatio)
      * instrument.lotSizeShares,
    )
    return { minimum: lotUnit, unit: lotUnit }
  }
  return {
    minimum: toIntegerJpy(instrumentPolicy?.minimumPurchaseUnitJpy ?? fallbackUnit),
    unit: fallbackUnit,
  }
}

export function buildAllocationPlanSnapshot(
  input: AllocationPlanInput,
): AllocationPlanSnapshot {
  const cash = deriveCashModel(input.cash, input.budgets, input.safetyState)
  const total = sumCurrentAssets(input)
  const snapshotBlocked: BlockedReason[] = [...cash.blockedReasons]
  const snapshotWarnings: WarningReason[] = [...cash.warnings]
  if (total.invalid) snapshotBlocked.push('INVALID_NUMERIC_INPUT')
  if (
    input.authorityVersion !== 'hr-allocation-plan-v1'
    || input.policy.allocationMode !== 'RANK_SEQUENTIAL_SINGLE_EXECUTION'
    || !isRatio01(input.policy.buyNewBaseShare)
    || !isRatio01(input.policy.buyMoreBaseShare)
    || !isRatio01(input.policy.confidenceUnknownFactor)
    || !isRatio01(input.policy.executionPriceBufferRatio)
  ) {
    snapshotBlocked.push('POLICY_AUTHORITY_UNAVAILABLE')
  }

  const assetClassPlans = buildAssetClassPlans(
    input,
    total.totalAssets,
    cash.deployableCash,
    cash.shortTermBudget,
    cash.longTermBudget,
  )
  const classRemaining = new Map(
    assetClassPlans.map((plan) => [plan.assetClass, plan.effectiveHeadroom]),
  )
  let totalRemaining = cash.deployableCash
  let shortRemaining = cash.shortTermBudget
  let longRemaining = cash.longTermBudget
  let executionSelected = false
  const instrumentPlans: InstrumentPlan[] = []
  const instruments = new Map(input.instruments.map((item) => [item.instrumentId, item]))

  for (const candidate of rankCandidates(input.candidates)) {
    const instrument = instruments.get(candidate.instrumentId)
    if (!instrument) {
      snapshotBlocked.push('CANDIDATE_INPUT_INVALID')
      continue
    }
    const classPlan = assetClassPlans.find(({ assetClass }) => assetClass === instrument.assetClass)
    const instrumentPolicy = input.policy.instrumentPolicies.find(
      ({ instrumentId }) => instrumentId === instrument.instrumentId,
    ) ?? null
    const classHeadroom = classPlan?.effectiveHeadroom ?? 0
    const classBudget = budgetForClass(
      instrument.assetClass,
      cash.shortTermBudget,
      cash.longTermBudget,
    )
    const independentHeadroom = computeInstrumentHeadroom({
      ...instrument,
      classHeadroom: classPlan ? classHeadroom : null,
      availableBudget: classPlan ? classBudget : null,
      policy: instrumentPolicy,
    })
    const safety = evaluateSafetyBehavior(input.safetyState, candidate.buyKind)
    const { minimum, unit } = minimumAndUnit(input, instrument)
    const baseShare = candidate.buyKind === 'BUY_NEW'
      ? input.policy.buyNewBaseShare
      : input.policy.buyMoreBaseShare
    const independent = computePurchaseAmount({
      calculationSnapshotId: input.snapshotId,
      authorityVersion: input.authorityVersion,
      kind: instrument.kind,
      buyKind: candidate.buyKind,
      deployableCash: cash.deployableCash,
      classHeadroom,
      instrumentHeadroom: independentHeadroom.effectiveInstrumentHeadroom,
      targetGap: instrument.assetClass === 'JP_TRUST'
        ? classPlan?.targetGap ?? 0
        : independentHeadroom.instrumentTargetGap,
      confidence: candidate.confidence,
      remainingSimultaneousBudget: cash.deployableCash,
      baseShare,
      confidenceUnknownFactor: input.policy.confidenceUnknownFactor,
      roundingUnitJpy: unit,
      minimumPurchaseUnitJpy: minimum,
      priceJpy: instrument.priceJpy,
      lotSizeShares: instrument.lotSizeShares,
      executionPriceBufferRatio: input.policy.executionPriceBufferRatio,
      behavior: safety.behavior,
      behaviorBlockedReasons: [
        ...snapshotBlocked,
        ...(classPlan?.blockedReasons ?? ['CLASS_TARGET_MISSING']),
        ...independentHeadroom.blockedReasons,
        ...safety.blockedReasons,
      ],
      behaviorWarnings: [
        ...snapshotWarnings,
        ...(classPlan?.warningReasons ?? []),
        ...independentHeadroom.warningReasons,
        ...safety.warnings,
      ],
    })

    const bucketRemaining = instrument.assetClass === 'JP_TRUST' ? shortRemaining : longRemaining
    const simultaneousCeiling = Math.min(
      totalRemaining,
      bucketRemaining,
      classRemaining.get(instrument.assetClass) ?? 0,
    )
    const eligibleForAllocation = independent.blockedReasons.length === 0
      && safety.behavior === 'NORMAL'
      && independent.roundedSuggestedAmount > 0
    const simultaneousAmount = eligibleForAllocation
      ? Math.min(independent.roundedSuggestedAmount, simultaneousCeiling)
      : 0
    const roundedSimultaneous = roundDownToUnit(simultaneousAmount, Math.max(1, unit))
    if (roundedSimultaneous > 0) {
      totalRemaining -= roundedSimultaneous
      classRemaining.set(
        instrument.assetClass,
        (classRemaining.get(instrument.assetClass) ?? 0) - roundedSimultaneous,
      )
      if (instrument.assetClass === 'JP_TRUST') shortRemaining -= roundedSimultaneous
      else longRemaining -= roundedSimultaneous
    }

    const selected = !executionSelected && independent.executable && roundedSimultaneous > 0
    if (selected) executionSelected = true
    const finalSuggestedAmount = selected
      ? Math.min(independent.finalSuggestedAmount, roundedSimultaneous)
      : 0
    const warnings: WarningReason[] = selected || independent.blockedReasons.length > 0
      ? independent.warningReasons
      : unique([...independent.warningReasons, 'NOT_SELECTED_FOR_EXECUTION' as const])
    instrumentPlans.push({
      ...instrument,
      buyKind: candidate.buyKind,
      targetAmount: independentHeadroom.targetAmount,
      classHeadroom: independentHeadroom.classHeadroom,
      instrumentTargetGap: independentHeadroom.instrumentTargetGap,
      instrumentMaxPositionHeadroom: independentHeadroom.instrumentMaxPositionHeadroom,
      sectorHeadroom: independentHeadroom.sectorHeadroom,
      concentrationHeadroom: independentHeadroom.concentrationHeadroom,
      liquidityHeadroom: independentHeadroom.liquidityHeadroom,
      lotSizeHeadroom: independentHeadroom.lotSizeHeadroom,
      effectiveInstrumentHeadroom: independentHeadroom.effectiveInstrumentHeadroom,
      ...independent,
      finalSuggestedAmount,
      executable: selected,
      independentMaximum: independent.estimatedMaximumAmount,
      simultaneouslyExecutableAmount: roundedSimultaneous,
      allocatedAmount: roundedSimultaneous,
      warningReasons: warnings,
      limitingFactors: unique([
        ...independentHeadroom.limitingFactors,
        ...independent.limitingFactors,
        ...(roundedSimultaneous === simultaneousCeiling ? ['SIMULTANEOUS_BUDGET' as const] : []),
      ]),
    })
  }

  const allocatedByClass = new Map<AssetClass, number>()
  for (const plan of instrumentPlans) {
    allocatedByClass.set(
      plan.assetClass,
      (allocatedByClass.get(plan.assetClass) ?? 0) + plan.allocatedAmount,
    )
  }
  const completedClassPlans = assetClassPlans.map((plan) => {
    const allocatedAmount = allocatedByClass.get(plan.assetClass) ?? 0
    return {
      ...plan,
      allocatedAmount,
      remainingHeadroom: Math.max(0, plan.effectiveHeadroom - allocatedAmount),
    }
  })

  return {
    authorityVersion: input.authorityVersion,
    schemaVersion: ALLOCATION_PLAN_SCHEMA_VERSION,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt,
    sourceHoldingsSnapshotId: input.sourceHoldingsSnapshotId,
    sourceSettingsVersion: input.sourceSettingsVersion,
    totalAssets: total.totalAssets,
    grossCash: cash.grossCash,
    deployableCash: cash.deployableCash,
    shortTermBudget: cash.shortTermBudget,
    longTermBudget: cash.longTermBudget,
    marketMode: input.marketMode,
    regime: input.regime,
    assetClassPlans: completedClassPlans,
    instrumentPlans,
    remainingUnallocatedCash: totalRemaining,
    blockedReasons: unique([
      ...snapshotBlocked,
      ...completedClassPlans.flatMap(({ blockedReasons }) => blockedReasons),
    ]),
    warnings: unique([
      ...snapshotWarnings,
      ...instrumentPlans.flatMap(({ warningReasons }) => warningReasons),
    ]),
    not_for_trading: true,
    privacyMode: 'local_only',
    persistence: 'none',
  }
}

export function summarizeJpTrust(snapshot: AllocationPlanSnapshot): JpTrustPlanSummary {
  const classPlan = snapshot.assetClassPlans.find(({ assetClass }) => assetClass === 'JP_TRUST')
  const jpTrustProposedAmount = snapshot.instrumentPlans
    .filter(({ assetClass }) => assetClass === 'JP_TRUST')
    .reduce((sum, plan) => sum + plan.allocatedAmount, 0)
  return {
    jpTrustTargetAmount: classPlan?.targetAmount ?? 0,
    jpTrustCurrentAmount: classPlan?.currentAmount ?? 0,
    jpTrustRemainingTarget: classPlan?.targetGap ?? 0,
    jpTrustClassHeadroom: classPlan?.effectiveHeadroom ?? 0,
    jpTrustProposedAmount,
    availableShortTermBudget: snapshot.shortTermBudget,
  }
}
