import type {
  AssetClass,
  AssetClassPlan,
  BlockedReason,
  DomesticStockHeadroom,
  InstrumentHeadroomInput,
  LimitingFactor,
  WarningReason,
} from '../../types/allocationPlan'
import {
  allValidMoney,
  isNonNegativeInteger,
  isRatio01,
  limitingFactorsForMinimum,
  toIntegerJpy,
  unique,
} from './numeric'

export interface AssetClassHeadroomInput {
  assetClass: AssetClass
  currentAmount: number
  totalAssets: number
  targetRatio: number
  maximumAmount: number | null
  availableBudget: number
}

export interface InstrumentHeadroomResult {
  targetAmount: number | null
  classHeadroom: number
  instrumentTargetGap: number | null
  instrumentMaxPositionHeadroom: number | null
  sectorHeadroom: number | null
  concentrationHeadroom: number | null
  liquidityHeadroom: number | null
  lotSizeHeadroom: number | null
  effectiveInstrumentHeadroom: number
  limitingFactors: LimitingFactor[]
  blockedReasons: BlockedReason[]
  warningReasons: WarningReason[]
}

export function computeDomesticStockHeadroom(input: {
  totalAssets: number
  currentDomesticStockAmount: number
  jpStockMaxRatio: number | null
  jpStockMaxAmountJpy: number | null
}): DomesticStockHeadroom {
  const blockedReasons: BlockedReason[] = []
  if (
    !isNonNegativeInteger(input.totalAssets)
    || !isNonNegativeInteger(input.currentDomesticStockAmount)
    || (input.jpStockMaxRatio !== null && !isRatio01(input.jpStockMaxRatio))
    || (input.jpStockMaxAmountJpy !== null && !isNonNegativeInteger(input.jpStockMaxAmountJpy))
  ) {
    blockedReasons.push('INVALID_NUMERIC_INPUT')
  }
  if (input.jpStockMaxRatio === null && input.jpStockMaxAmountJpy === null) {
    blockedReasons.push('POLICY_AUTHORITY_UNAVAILABLE')
  }
  if (input.jpStockMaxRatio !== null && input.totalAssets <= 0) {
    blockedReasons.push('TARGET_AUTHORITY_UNAVAILABLE')
  }

  const ratioCapAmount = input.jpStockMaxRatio === null || input.totalAssets <= 0
    ? null
    : Math.floor(input.totalAssets * input.jpStockMaxRatio)
  const amountCap = input.jpStockMaxAmountJpy === null
    ? null
    : toIntegerJpy(input.jpStockMaxAmountJpy)
  const caps = [ratioCapAmount, amountCap].filter((value): value is number => value !== null)
  const effectiveDomesticStockCap = blockedReasons.length > 0 || caps.length === 0
    ? 0
    : Math.min(...caps)
  const currentDomesticStockAmount = toIntegerJpy(input.currentDomesticStockAmount)
  const domesticStockHardHeadroom = Math.max(
    0,
    effectiveDomesticStockCap - currentDomesticStockAmount,
  )
  const limitingFactors: LimitingFactor[] = []
  if (ratioCapAmount !== null && ratioCapAmount === effectiveDomesticStockCap) {
    limitingFactors.push('JP_STOCK_RATIO_CAP')
  }
  if (amountCap !== null && amountCap === effectiveDomesticStockCap) {
    limitingFactors.push('JP_STOCK_AMOUNT_CAP')
  }
  return {
    ratioCapAmount,
    amountCap,
    effectiveDomesticStockCap,
    currentDomesticStockAmount,
    domesticStockHardHeadroom,
    limitingFactors,
    blockedReasons: unique(blockedReasons),
  }
}

export function computeAssetClassHeadroom(input: AssetClassHeadroomInput): AssetClassPlan {
  const blockedReasons: BlockedReason[] = []
  const warningReasons: WarningReason[] = []
  if (
    !allValidMoney([
      input.currentAmount,
      input.totalAssets,
      input.maximumAmount,
      input.availableBudget,
    ])
    || !isRatio01(input.targetRatio)
  ) {
    blockedReasons.push('INVALID_NUMERIC_INPUT')
  }
  if (input.totalAssets <= 0 || input.targetRatio <= 0) {
    blockedReasons.push('CLASS_TARGET_MISSING')
  }

  const currentAmount = toIntegerJpy(input.currentAmount)
  const targetAmount = Math.floor(toIntegerJpy(input.totalAssets) * (
    isRatio01(input.targetRatio) ? input.targetRatio : 0
  ))
  const targetGap = Math.max(0, targetAmount - currentAmount)
  const overweightAmount = Math.max(0, currentAmount - targetAmount)
  const softHeadroom = targetGap
  const maximumAmount = input.maximumAmount === null
    ? null
    : toIntegerJpy(input.maximumAmount)
  // A missing hard cap never becomes an emitted Infinity. The point target is the
  // finite v1 ceiling, so the hard and soft paths converge safely.
  const hardHeadroom = maximumAmount === null
    ? targetGap
    : Math.max(0, maximumAmount - currentAmount)
  const availableBudget = toIntegerJpy(input.availableBudget)
  const terms = [
    { factor: 'TARGET_GAP' as const, amount: softHeadroom },
    { factor: 'CLASS_HEADROOM' as const, amount: hardHeadroom },
    { factor: 'AVAILABLE_BUDGET' as const, amount: availableBudget },
  ]
  const effectiveHeadroom = blockedReasons.length > 0
    ? 0
    : Math.min(...terms.map(({ amount }) => amount))
  if (effectiveHeadroom === 0) blockedReasons.push('CLASS_FULL')

  return {
    assetClass: input.assetClass,
    currentAmount,
    targetAmount,
    targetRatio: isRatio01(input.targetRatio) ? input.targetRatio : 0,
    minimumAmount: null,
    maximumAmount,
    targetGap,
    hardHeadroom,
    softHeadroom,
    effectiveHeadroom,
    overweightAmount,
    availableBudget,
    allocatedAmount: 0,
    remainingHeadroom: effectiveHeadroom,
    limitingFactors: limitingFactorsForMinimum(terms),
    blockedReasons: unique(blockedReasons),
    warningReasons,
  }
}

export function computeInstrumentHeadroom(
  input: InstrumentHeadroomInput,
): InstrumentHeadroomResult {
  const blockedReasons: BlockedReason[] = []
  const warningReasons: WarningReason[] = []
  if (
    input.classHeadroom === null
    || input.availableBudget === null
    || !isNonNegativeInteger(input.classHeadroom)
    || !isNonNegativeInteger(input.availableBudget)
    || !isNonNegativeInteger(input.currentAmount)
  ) {
    blockedReasons.push('INSTRUMENT_AUTHORITY_UNAVAILABLE')
  }
  if (input.policy === null) blockedReasons.push('INSTRUMENT_AUTHORITY_UNAVAILABLE')

  const classHeadroom = toIntegerJpy(input.classHeadroom ?? 0)
  const availableBudget = toIntegerJpy(input.availableBudget ?? 0)
  const policy = input.policy
  const targetAmount = policy?.targetAmountJpy ?? null
  const instrumentTargetGap = targetAmount === null
    ? null
    : Math.max(0, toIntegerJpy(targetAmount) - toIntegerJpy(input.currentAmount))
  if (targetAmount === null) warningReasons.push('INSTRUMENT_TARGET_UNAVAILABLE')

  const fallbackMaxPosition = Math.floor(
    classHeadroom * (policy && isRatio01(policy.defaultMaxPositionShare)
      ? policy.defaultMaxPositionShare
      : 0),
  )
  const instrumentMaxPositionHeadroom = policy?.maxPositionAmountJpy === null
    ? fallbackMaxPosition
    : Math.max(0, toIntegerJpy(policy?.maxPositionAmountJpy ?? 0) - toIntegerJpy(input.currentAmount))
  const sectorHeadroom = policy?.sectorHeadroomJpy === null
    ? Math.floor(classHeadroom * (isRatio01(policy?.defaultMaxSectorShare)
      ? policy.defaultMaxSectorShare
      : 0))
    : toIntegerJpy(policy?.sectorHeadroomJpy ?? 0)
  if (policy?.sectorHeadroomJpy === null) warningReasons.push('SECTOR_AUTHORITY_PARTIAL')
  const concentrationHeadroom = policy?.concentrationHeadroomJpy ?? null
  if (concentrationHeadroom === null) warningReasons.push('CONCENTRATION_UNAVAILABLE')
  const liquidityHeadroom = policy?.liquidityHeadroomJpy ?? null
  if (liquidityHeadroom === null) warningReasons.push('LIQUIDITY_UNAVAILABLE')
  const lotSizeHeadroom = input.priceJpy !== null && input.lotSizeShares !== null
    && isNonNegativeInteger(input.priceJpy) && isNonNegativeInteger(input.lotSizeShares)
    ? classHeadroom
    : null

  const terms: Array<{ factor: LimitingFactor; amount: number }> = [
    { factor: 'CLASS_HEADROOM', amount: classHeadroom },
    { factor: 'MAX_POSITION', amount: instrumentMaxPositionHeadroom },
    { factor: 'SECTOR', amount: sectorHeadroom },
    { factor: 'AVAILABLE_BUDGET', amount: availableBudget },
  ]
  if (instrumentTargetGap !== null) terms.push({ factor: 'TARGET_GAP', amount: instrumentTargetGap })
  if (concentrationHeadroom !== null) terms.push({ factor: 'CONCENTRATION', amount: toIntegerJpy(concentrationHeadroom) })
  if (liquidityHeadroom !== null) terms.push({ factor: 'LIQUIDITY', amount: toIntegerJpy(liquidityHeadroom) })
  const effectiveInstrumentHeadroom = blockedReasons.length > 0
    ? 0
    : Math.min(...terms.map(({ amount }) => amount))

  return {
    targetAmount,
    classHeadroom,
    instrumentTargetGap,
    instrumentMaxPositionHeadroom,
    sectorHeadroom,
    concentrationHeadroom,
    liquidityHeadroom,
    lotSizeHeadroom,
    effectiveInstrumentHeadroom,
    limitingFactors: limitingFactorsForMinimum(terms),
    blockedReasons: unique(blockedReasons),
    warningReasons: unique(warningReasons),
  }
}
