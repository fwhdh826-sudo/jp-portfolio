import type {
  AllocationPlanSnapshot,
  AssetClass,
  InvariantResult,
} from '../../types/allocationPlan'
import { isNonNegativeInteger } from './numeric'
import { summarizeJpTrust } from './allocationEngine'

function add(violated: Array<`I-${string}`>, id: `I-${string}`, condition: boolean): void {
  if (!condition) violated.push(id)
}

export function assertAllocationPlanInvariants(
  snapshot: AllocationPlanSnapshot,
): InvariantResult {
  const violated: Array<`I-${string}`> = []
  const classById = new Map(snapshot.assetClassPlans.map((plan) => [plan.assetClass, plan]))
  const allocatedTotal = snapshot.instrumentPlans.reduce(
    (sum, plan) => sum + plan.allocatedAmount,
    0,
  )
  const unsafeReasons = new Set([
    'SAFE_MODE_ACTIVE',
    'SAFE_MODE_UNAVAILABLE',
    'DQ_SUPPRESSED',
    'NO_TRADE_EMERGENCY',
    'MARKET_DATA_STALE',
    'HOLDINGS_STALE',
    'CASH_DATA_STALE',
    'CROSS_TAB_STALE',
    'TIER_A_HARD_VIOLATION',
  ])

  add(violated, 'I-01', snapshot.instrumentPlans.every(
    ({ finalSuggestedAmount }) => finalSuggestedAmount >= 0,
  ))
  add(violated, 'I-02', snapshot.instrumentPlans.every(
    ({ finalSuggestedAmount }) => finalSuggestedAmount <= snapshot.deployableCash,
  ))
  add(violated, 'I-03', snapshot.instrumentPlans.every((plan) =>
    plan.finalSuggestedAmount <= (classById.get(plan.assetClass)?.effectiveHeadroom ?? 0)))
  add(violated, 'I-04', snapshot.instrumentPlans.every(
    (plan) => plan.finalSuggestedAmount <= plan.effectiveInstrumentHeadroom,
  ))
  const jpTrust = summarizeJpTrust(snapshot)
  add(violated, 'I-05', jpTrust.jpTrustProposedAmount <= jpTrust.jpTrustRemainingTarget)
  add(violated, 'I-06', allocatedTotal <= snapshot.deployableCash)
  const jpStockClass = classById.get('JP_STOCK')
  const jpStockAllocated = snapshot.instrumentPlans
    .filter(({ assetClass }) => assetClass === 'JP_STOCK')
    .reduce((sum, plan) => sum + plan.allocatedAmount, 0)
  add(
    violated,
    'I-07',
    !jpStockClass
      || jpStockClass.maximumAmount === null
      || jpStockClass.currentAmount + jpStockAllocated <= jpStockClass.maximumAmount,
  )
  add(violated, 'I-08', snapshot.instrumentPlans.every(
    (plan) => plan.roundedSuggestedAmount <= plan.cappedSuggestedAmount,
  ))
  add(
    violated,
    'I-09',
    snapshot.snapshotId.length > 0
      && snapshot.instrumentPlans.every(
        ({ calculationSnapshotId }) => calculationSnapshotId === snapshot.snapshotId,
      ),
  )
  add(
    violated,
    'I-10',
    snapshot.instrumentPlans.every((plan) =>
      !(plan.buyKind === 'BUY_NEW'
        && plan.executable
        && plan.blockedReasons.some((reason) => unsafeReasons.has(reason)))),
  )
  add(
    violated,
    'I-11',
    snapshot.instrumentPlans.every((plan) =>
      plan.classHeadroom >= 0
      && plan.effectiveInstrumentHeadroom >= 0
      && !(plan.blockedReasons.includes('INSTRUMENT_AUTHORITY_UNAVAILABLE') && plan.executable)),
  )
  add(violated, 'I-12', snapshot.instrumentPlans.filter(({ executable }) => executable).length <= 1)

  const money: number[] = [
    snapshot.totalAssets,
    snapshot.grossCash,
    snapshot.deployableCash,
    snapshot.shortTermBudget,
    snapshot.longTermBudget,
    snapshot.remainingUnallocatedCash,
    ...snapshot.assetClassPlans.flatMap((plan) => [
      plan.currentAmount,
      plan.targetAmount,
      plan.targetGap,
      plan.hardHeadroom,
      plan.softHeadroom,
      plan.effectiveHeadroom,
      plan.overweightAmount,
      plan.availableBudget,
      plan.allocatedAmount,
      plan.remainingHeadroom,
      ...(plan.maximumAmount === null ? [] : [plan.maximumAmount]),
    ]),
    ...snapshot.instrumentPlans.flatMap((plan) => [
      plan.currentAmount,
      plan.classHeadroom,
      plan.effectiveInstrumentHeadroom,
      plan.rawSuggestedAmount,
      plan.cappedSuggestedAmount,
      plan.roundedSuggestedAmount,
      plan.finalSuggestedAmount,
      plan.estimatedMaximumAmount,
      plan.independentMaximum,
      plan.simultaneouslyExecutableAmount,
      plan.allocatedAmount,
      plan.roundingLoss,
    ]),
  ]
  add(violated, 'I-13', money.every(isNonNegativeInteger))

  const classes: AssetClass[] = [
    'JP_STOCK', 'JP_TRUST', 'OVERSEAS_TRUST', 'GOLD', 'CASH', 'CASH_RESERVE',
  ]
  add(violated, 'I-14', classes.every((assetClass) => {
    const allocated = snapshot.instrumentPlans
      .filter((plan) => plan.assetClass === assetClass)
      .reduce((sum, plan) => sum + plan.allocatedAmount, 0)
    return allocated <= (classById.get(assetClass)?.effectiveHeadroom ?? 0)
  }))
  add(
    violated,
    'I-15',
    snapshot.remainingUnallocatedCash === snapshot.deployableCash - allocatedTotal
      && snapshot.remainingUnallocatedCash >= 0,
  )
  add(
    violated,
    'I-16',
    snapshot.shortTermBudget + snapshot.longTermBudget === snapshot.deployableCash,
  )
  add(
    violated,
    'I-17',
    snapshot.generatedAt.length > 0
      && snapshot.sourceHoldingsSnapshotId.length > 0
      && snapshot.sourceSettingsVersion.length > 0,
  )
  add(
    violated,
    'I-18',
    snapshot.persistence === 'none'
      && snapshot.privacyMode === 'local_only'
      && snapshot.not_for_trading === true,
  )
  return { ok: violated.length === 0, violated }
}
