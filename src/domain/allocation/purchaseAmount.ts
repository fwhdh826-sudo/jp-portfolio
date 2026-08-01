import type {
  BlockedReason,
  LimitingFactor,
  PurchaseAmountInput,
  PurchaseAmountResult,
  WarningReason,
} from '../../types/allocationPlan'
import {
  allValidMoney,
  clampRatio01,
  isNonNegativeInteger,
  limitingFactorsForMinimum,
  roundDownToUnit,
  toIntegerJpy,
  unique,
} from './numeric'

export function computePurchaseAmount(input: PurchaseAmountInput): PurchaseAmountResult {
  const blockedReasons: BlockedReason[] = [...input.behaviorBlockedReasons]
  const warningReasons: WarningReason[] = [...input.behaviorWarnings]
  const money = [
    input.deployableCash,
    input.classHeadroom,
    input.instrumentHeadroom,
    input.targetGap,
    input.remainingSimultaneousBudget,
    input.roundingUnitJpy,
    input.minimumPurchaseUnitJpy,
    input.priceJpy,
    input.lotSizeShares,
  ]
  if (
    !allValidMoney(money)
    || !Number.isFinite(input.baseShare)
    || !Number.isFinite(input.confidenceUnknownFactor)
    || !Number.isFinite(input.executionPriceBufferRatio)
    || input.executionPriceBufferRatio < 0
    || input.roundingUnitJpy <= 0
    || input.minimumPurchaseUnitJpy <= 0
  ) {
    blockedReasons.push('INVALID_NUMERIC_INPUT')
  }

  const terms: Array<{ factor: LimitingFactor; amount: number }> = [
    { factor: 'DEPLOYABLE_CASH', amount: toIntegerJpy(input.deployableCash) },
    { factor: 'CLASS_HEADROOM', amount: toIntegerJpy(input.classHeadroom) },
    { factor: 'INSTRUMENT_HEADROOM', amount: toIntegerJpy(input.instrumentHeadroom) },
    { factor: 'SIMULTANEOUS_BUDGET', amount: toIntegerJpy(input.remainingSimultaneousBudget) },
  ]
  if (input.targetGap !== null) {
    terms.push({ factor: 'TARGET_GAP', amount: toIntegerJpy(input.targetGap) })
  }
  const ceiling = Math.min(...terms.map(({ amount }) => amount))
  const confidenceFactor = input.confidence === null
    ? clampRatio01(input.confidenceUnknownFactor)
    : clampRatio01(input.confidence)
  if (input.confidence === null) warningReasons.push('CONFIDENCE_UNKNOWN')
  const sizingShare = clampRatio01(input.baseShare) * confidenceFactor
  const rawSuggestedAmount = Math.floor(ceiling * sizingShare)
  const cappedSuggestedAmount = Math.min(rawSuggestedAmount, ceiling)

  const hasStockExecutionAuthority = input.kind !== 'jp_stock'
    || (
      input.priceJpy !== null
      && input.lotSizeShares !== null
      && isNonNegativeInteger(input.priceJpy)
      && input.priceJpy > 0
      && isNonNegativeInteger(input.lotSizeShares)
      && input.lotSizeShares > 0
    )
  const effectiveUnit = input.kind === 'jp_stock' && hasStockExecutionAuthority
    ? Math.ceil(
      (input.priceJpy as number)
      * (1 + input.executionPriceBufferRatio)
      * (input.lotSizeShares as number),
    )
    : toIntegerJpy(input.roundingUnitJpy)
  const roundedSuggestedAmount = roundDownToUnit(cappedSuggestedAmount, effectiveUnit)
  const estimatedMaximumAmount = roundDownToUnit(ceiling, effectiveUnit)
  const belowMinimum = roundedSuggestedAmount < toIntegerJpy(input.minimumPurchaseUnitJpy)
  if (belowMinimum) blockedReasons.push('BELOW_MINIMUM_UNIT')
  if (!hasStockExecutionAuthority) {
    blockedReasons.push('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    warningReasons.push('ESTIMATE_ONLY')
  }
  if (ceiling <= 0) blockedReasons.push('INSUFFICIENT_CASH')

  const displayOnly = input.behavior === 'DISPLAY_MAX_WITH_WARNING'
    || input.behavior === 'DISPLAY_ESTIMATE_ONLY'
  if (displayOnly) warningReasons.push('ESTIMATE_ONLY')
  const mustZero = input.behavior === 'BLOCK_AND_ZERO'
    || input.behavior === 'HOLD_EXISTING_ONLY'
    || blockedReasons.length > 0
    || !hasStockExecutionAuthority
  const finalSuggestedAmount = mustZero ? 0 : roundedSuggestedAmount
  const executable = !displayOnly && finalSuggestedAmount > 0 && blockedReasons.length === 0

  return {
    rawSuggestedAmount,
    cappedSuggestedAmount,
    roundedSuggestedAmount,
    finalSuggestedAmount,
    estimatedMaximumAmount,
    roundingLoss: cappedSuggestedAmount - roundedSuggestedAmount,
    executable,
    limitingFactors: unique([
      ...limitingFactorsForMinimum(terms),
      ...(belowMinimum ? ['MINIMUM_UNIT' as const] : []),
      ...(!hasStockExecutionAuthority ? ['LOT_SIZE' as const] : []),
    ]),
    blockedReasons: unique(blockedReasons),
    warningReasons: unique(warningReasons),
    calculationSnapshotId: input.calculationSnapshotId,
    authorityVersion: input.authorityVersion,
  }
}
