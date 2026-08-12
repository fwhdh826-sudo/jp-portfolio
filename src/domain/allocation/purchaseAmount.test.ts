import { describe, expect, it } from 'vitest'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type PurchaseAmountInput,
  type SafetyState,
} from '../../types/allocationPlan'
import { computePurchaseAmount } from './purchaseAmount'
import { evaluateSafetyBehavior } from './safety'

const BASE: PurchaseAmountInput = {
  calculationSnapshotId: 'snapshot-1',
  authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
  kind: 'jp_trust',
  buyKind: 'BUY_NEW',
  deployableCash: 500_000,
  classHeadroom: 400_000,
  instrumentHeadroom: 300_000,
  targetGap: 250_000,
  confidence: 1,
  remainingSimultaneousBudget: 500_000,
  baseShare: 0.25,
  confidenceUnknownFactor: 0.5,
  roundingUnitJpy: 10_000,
  minimumPurchaseUnitJpy: 10_000,
  priceJpy: null,
  lotSizeShares: null,
  executionPriceBufferRatio: 0.03,
  behavior: 'NORMAL',
  behaviorBlockedReasons: [],
  behaviorWarnings: [],
}

const SAFETY: SafetyState = {
  safeMode: 'inactive',
  marketData: 'fresh',
  holdings: 'fresh',
  cash: 'known_fresh',
  target: 'known',
  pendingOrders: 'unknown',
  candidateArtifact: 'fresh',
  dqViolation: false,
  tierA: 'normal',
  crossTab: 'current',
  noTrade: 'normal',
}

describe('purchase amount cap and confidence contract', () => {
  it('confidence zero produces zero without converting score to JPY', () => {
    const result = computePurchaseAmount({ ...BASE, confidence: 0 })
    expect(result.rawSuggestedAmount).toBe(0)
    expect(result.finalSuggestedAmount).toBe(0)
  })

  it('confidence one remains inside every hard cap', () => {
    const result = computePurchaseAmount(BASE)
    expect(result.rawSuggestedAmount).toBe(62_500)
    expect(result.roundedSuggestedAmount).toBe(60_000)
    expect(result.finalSuggestedAmount).toBe(60_000)
    expect(result.finalSuggestedAmount).toBeLessThanOrEqual(BASE.deployableCash)
    expect(result.finalSuggestedAmount).toBeLessThanOrEqual(BASE.classHeadroom)
    expect(result.finalSuggestedAmount).toBeLessThanOrEqual(BASE.instrumentHeadroom)
    expect(result.finalSuggestedAmount).toBeLessThanOrEqual(BASE.targetGap as number)
  })

  it('intermediate confidence is only a multiplier inside the cap', () => {
    const result = computePurchaseAmount({ ...BASE, confidence: 0.4 })
    expect(result.rawSuggestedAmount).toBe(25_000)
    expect(result.finalSuggestedAmount).toBe(20_000)
  })

  it('confidence greater than one is clamped and cannot exceed the cap', () => {
    const normal = computePurchaseAmount(BASE)
    const excessive = computePurchaseAmount({ ...BASE, confidence: 1.5 })
    expect(excessive.finalSuggestedAmount).toBe(normal.finalSuggestedAmount)
    expect(excessive.estimatedMaximumAmount).toBeLessThanOrEqual(BASE.targetGap as number)
  })

  it('unknown confidence uses the explicit policy factor and warns', () => {
    const result = computePurchaseAmount({ ...BASE, confidence: null })
    expect(result.rawSuggestedAmount).toBe(31_250)
    expect(result.warningReasons).toContain('CONFIDENCE_UNKNOWN')
  })

  it('each cap independently binds and is reported', () => {
    const cases = [
      ['DEPLOYABLE_CASH', { deployableCash: 40_000 }],
      ['CLASS_HEADROOM', { classHeadroom: 40_000 }],
      ['INSTRUMENT_HEADROOM', { instrumentHeadroom: 40_000 }],
      ['TARGET_GAP', { targetGap: 40_000 }],
      ['SIMULTANEOUS_BUDGET', { remainingSimultaneousBudget: 40_000 }],
    ] as const
    for (const [factor, overrides] of cases) {
      const result = computePurchaseAmount({ ...BASE, baseShare: 1, ...overrides })
      expect(result.estimatedMaximumAmount).toBe(40_000)
      expect(result.limitingFactors).toContain(factor)
    }
  })

  it('applies cap before round-down and reasserts rounded <= capped', () => {
    const result = computePurchaseAmount({
      ...BASE,
      classHeadroom: 19_999,
      instrumentHeadroom: 100_000,
      targetGap: null,
      baseShare: 1,
    })
    expect(result.cappedSuggestedAmount).toBe(19_999)
    expect(result.roundedSuggestedAmount).toBe(10_000)
    expect(result.roundedSuggestedAmount).toBeLessThanOrEqual(result.cappedSuggestedAmount)
    expect(result.roundingLoss).toBe(9_999)
  })

  it('below the minimum unit is blocked and final is zero', () => {
    const result = computePurchaseAmount({
      ...BASE,
      deployableCash: 9_999,
      classHeadroom: 9_999,
      instrumentHeadroom: 9_999,
      targetGap: 9_999,
      baseShare: 1,
    })
    expect(result.finalSuggestedAmount).toBe(0)
    expect(result.blockedReasons).toContain('BELOW_MINIMUM_UNIT')
  })

  it('invalid and zero rounding units are blocked instead of silently accepted', () => {
    for (const unit of [0, -1, 1.5, Number.NaN]) {
      const result = computePurchaseAmount({ ...BASE, roundingUnitJpy: unit })
      expect(result.finalSuggestedAmount).toBe(0)
      expect(result.blockedReasons).toContain('INVALID_NUMERIC_INPUT')
    }
  })
})

describe('TBD-01 domestic-stock execution gate', () => {
  const stock = (overrides: Partial<PurchaseAmountInput> = {}) =>
    computePurchaseAmount({
      ...BASE,
      kind: 'jp_stock',
      buyKind: 'BUY_NEW',
      baseShare: 1,
      ...overrides,
    })

  it.each([
    ['price', { priceJpy: null, lotSizeShares: 100 }],
    ['lot', { priceJpy: 1_000, lotSizeShares: null }],
    ['both', { priceJpy: null, lotSizeShares: null }],
  ] as const)('missing %s keeps estimate but cannot emit an executable amount', (_name, overrides) => {
    const result = stock(overrides)
    expect(result.estimatedMaximumAmount).toBeGreaterThan(0)
    expect(result.finalSuggestedAmount).toBe(0)
    expect(result.executable).toBe(false)
    expect(result.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
  })

  it('nonzero headroom cannot bypass missing price/lot (HR-M-07)', () => {
    const result = stock({ classHeadroom: 1_000_000, instrumentHeadroom: 1_000_000 })
    expect(result.estimatedMaximumAmount).toBeGreaterThan(0)
    expect(result.finalSuggestedAmount).toBe(0)
  })

  it('uses injected price and lot, never a synthetic 100-share assumption', () => {
    const result = stock({
      priceJpy: 1_000,
      lotSizeShares: 37,
      deployableCash: 500_000,
      classHeadroom: 500_000,
      instrumentHeadroom: 500_000,
      targetGap: null,
      minimumPurchaseUnitJpy: 38_110,
    })
    expect(result.roundedSuggestedAmount % 38_110).toBe(0)
    expect(result.executable).toBe(true)
  })
})

describe('SAFE_MODE / stale / missing state matrix', () => {
  it.each([
    ['SAFE_MODE active', { safeMode: 'active' as const }, 'SAFE_MODE_ACTIVE'],
    ['SAFE_MODE stale', { safeMode: 'stale' as const }, 'SAFE_MODE_UNAVAILABLE'],
    ['market stale', { marketData: 'stale' as const }, 'MARKET_DATA_STALE'],
    ['DQ violation', { dqViolation: true }, 'DQ_SUPPRESSED'],
    ['Tier A hard', { tierA: 'hard' as const }, 'TIER_A_HARD_VIOLATION'],
    ['cash unknown', { cash: 'unknown' as const }, 'CASH_AUTHORITY_UNAVAILABLE'],
    ['target unknown', { target: 'unknown' as const }, 'TARGET_AUTHORITY_UNAVAILABLE'],
    ['candidate invalid', { candidateArtifact: 'invalid' as const }, 'CANDIDATE_INPUT_INVALID'],
  ])('%s blocks and zeroes BUY_NEW', (_label, override, reason) => {
    const safety = evaluateSafetyBehavior({ ...SAFETY, ...override }, 'BUY_NEW')
    const result = computePurchaseAmount({
      ...BASE,
      behavior: safety.behavior,
      behaviorBlockedReasons: safety.blockedReasons,
      behaviorWarnings: safety.warnings,
    })
    expect(safety.behavior).toBe('BLOCK_AND_ZERO')
    expect(result.finalSuggestedAmount).toBe(0)
    expect(result.executable).toBe(false)
    expect(result.blockedReasons).toContain(reason)
  })

  it('SAFE_MODE BUY_MORE is HOLD_EXISTING_ONLY and zero (HR-M-08)', () => {
    const safety = evaluateSafetyBehavior({ ...SAFETY, safeMode: 'active' }, 'BUY_MORE')
    expect(safety.behavior).toBe('HOLD_EXISTING_ONLY')
    const result = computePurchaseAmount({
      ...BASE,
      buyKind: 'BUY_MORE',
      behavior: safety.behavior,
      behaviorBlockedReasons: safety.blockedReasons,
      behaviorWarnings: safety.warnings,
    })
    expect(result.finalSuggestedAmount).toBe(0)
    expect(result.executable).toBe(false)
  })

  it('holdings stale differs for BUY_NEW and BUY_MORE', () => {
    expect(evaluateSafetyBehavior(
      { ...SAFETY, holdings: 'stale' },
      'BUY_NEW',
    ).behavior).toBe('BLOCK_AND_ZERO')
    expect(evaluateSafetyBehavior(
      { ...SAFETY, holdings: 'stale' },
      'BUY_MORE',
    ).behavior).toBe('DISPLAY_MAX_WITH_WARNING')
  })

  it('cash stale differs for BUY_NEW and BUY_MORE', () => {
    expect(evaluateSafetyBehavior(
      { ...SAFETY, cash: 'stale' },
      'BUY_NEW',
    ).behavior).toBe('BLOCK_AND_ZERO')
    expect(evaluateSafetyBehavior(
      { ...SAFETY, cash: 'stale' },
      'BUY_MORE',
    ).behavior).toBe('DISPLAY_MAX_WITH_WARNING')
  })

  it('candidate stale is estimate-only for BUY_NEW and ignored for BUY_MORE', () => {
    expect(evaluateSafetyBehavior(
      { ...SAFETY, candidateArtifact: 'stale' },
      'BUY_NEW',
    ).behavior).toBe('DISPLAY_ESTIMATE_ONLY')
    expect(evaluateSafetyBehavior(
      { ...SAFETY, candidateArtifact: 'stale' },
      'BUY_MORE',
    ).behavior).toBe('NORMAL')
  })

  it('pending order unknown is NORMAL and handled as an explicit cash warning', () => {
    expect(evaluateSafetyBehavior(
      { ...SAFETY, pendingOrders: 'unknown' },
      'BUY_NEW',
    ).behavior).toBe('NORMAL')
  })

  it('soft Tier A and caution mode display maximum with warning', () => {
    expect(evaluateSafetyBehavior(
      { ...SAFETY, tierA: 'soft' },
      'BUY_NEW',
    ).behavior).toBe('DISPLAY_MAX_WITH_WARNING')
    expect(evaluateSafetyBehavior(
      { ...SAFETY, noTrade: 'caution' },
      'BUY_MORE',
    ).behavior).toBe('DISPLAY_MAX_WITH_WARNING')
  })
})

describe('property-style purchase boundaries', () => {
  it('amount is integer, nonnegative, and never exceeds every cap', () => {
    const values = [0, 1, 9_999, 10_000, 10_001, 99_999, 100_000, 1_000_000]
    for (const cash of values) {
      for (const classHeadroom of values) {
        for (const confidence of [0, 0.25, 0.5, 1, 2]) {
          const result = computePurchaseAmount({
            ...BASE,
            deployableCash: cash,
            classHeadroom,
            instrumentHeadroom: 1_000_000,
            targetGap: null,
            remainingSimultaneousBudget: 1_000_000,
            confidence,
          })
          expect(Number.isInteger(result.finalSuggestedAmount)).toBe(true)
          expect(result.finalSuggestedAmount).toBeGreaterThanOrEqual(0)
          expect(result.finalSuggestedAmount).toBeLessThanOrEqual(cash)
          expect(result.finalSuggestedAmount).toBeLessThanOrEqual(classHeadroom)
        }
      }
    }
  })
})
