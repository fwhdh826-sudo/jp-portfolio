import { describe, expect, it } from 'vitest'
import type {
  InstrumentHeadroomInput,
  InstrumentPolicy,
  SafetyState,
} from '../../types/allocationPlan'
import { deriveCashModel } from './cash'
import {
  computeAssetClassHeadroom,
  computeDomesticStockHeadroom,
  computeInstrumentHeadroom,
} from './headroom'
import { roundDownToUnit, toIntegerJpy } from './numeric'

const NORMAL_SAFETY: SafetyState = {
  safeMode: 'inactive',
  marketData: 'fresh',
  holdings: 'fresh',
  cash: 'known_fresh',
  target: 'known',
  pendingOrders: 'known',
  candidateArtifact: 'fresh',
  dqViolation: false,
  tierA: 'normal',
  crossTab: 'current',
  noTrade: 'normal',
}

describe('monetary unit and cash contract', () => {
  it('truncates positive float input at the authority boundary', () => {
    expect(toIntegerJpy(10_000.99)).toBe(10_000)
  })

  it('rejects NaN, Infinity, and negative propagation as zero', () => {
    expect(toIntegerJpy(Number.NaN)).toBe(0)
    expect(toIntegerJpy(Number.POSITIVE_INFINITY)).toBe(0)
    expect(toIntegerJpy(-1)).toBe(0)
  })

  it('calculates exact reserve deductions including pending orders once (HR-M-01)', () => {
    const cash = deriveCashModel(
      {
        grossCash: 1_000_000,
        safetyReserve: 200_000,
        pendingOrderCash: 150_000,
        dataUncertaintyReserve: 50_000,
      },
      { shortTermBudget: 300_000, longTermBudget: 999_999 },
      NORMAL_SAFETY,
    )
    expect(cash.deployableCash).toBe(600_000)
    expect(cash.shortTermBudget).toBe(300_000)
    expect(cash.longTermBudget).toBe(300_000)
  })

  it.each([
    [0, 0],
    [100_000, 0],
    [250_000, 0],
  ])('reserve cannot make deployable cash negative: gross=%i', (grossCash, expected) => {
    const cash = deriveCashModel(
      {
        grossCash,
        safetyReserve: 250_000,
        pendingOrderCash: 0,
        dataUncertaintyReserve: 0,
      },
      { shortTermBudget: 50_000, longTermBudget: 50_000 },
      NORMAL_SAFETY,
    )
    expect(cash.deployableCash).toBe(expected)
  })

  it('pending-order unknown is explicit and does not invent a reserve', () => {
    const cash = deriveCashModel(
      {
        grossCash: 500_000,
        safetyReserve: 100_000,
        pendingOrderCash: null,
        dataUncertaintyReserve: 0,
      },
      { shortTermBudget: 100_000, longTermBudget: 300_000 },
      { ...NORMAL_SAFETY, pendingOrders: 'unknown' },
    )
    expect(cash.deployableCash).toBe(400_000)
    expect(cash.warnings).toContain('PENDING_ORDER_AUTHORITY_UNAVAILABLE')
  })

  it('unknown cash blocks and zeroes rather than becoming unlimited', () => {
    const cash = deriveCashModel(
      {
        grossCash: null,
        safetyReserve: 0,
        pendingOrderCash: 0,
        dataUncertaintyReserve: 0,
      },
      { shortTermBudget: 1_000_000, longTermBudget: 1_000_000 },
      { ...NORMAL_SAFETY, cash: 'unknown' },
    )
    expect(cash.deployableCash).toBe(0)
    expect(cash.blockedReasons).toContain('CASH_AUTHORITY_UNAVAILABLE')
  })

  it('stale holdings or cash reserves all gross cash as uncertainty', () => {
    for (const safety of [
      { ...NORMAL_SAFETY, holdings: 'stale' as const },
      { ...NORMAL_SAFETY, cash: 'stale' as const },
      { ...NORMAL_SAFETY, crossTab: 'stale' as const },
    ]) {
      const cash = deriveCashModel(
        {
          grossCash: 500_000,
          safetyReserve: 50_000,
          pendingOrderCash: 0,
          dataUncertaintyReserve: 0,
        },
        { shortTermBudget: 100_000, longTermBudget: 350_000 },
        safety,
      )
      expect(cash.dataUncertaintyReserve).toBe(500_000)
      expect(cash.deployableCash).toBe(0)
    }
  })

  it('negative and non-integer numeric inputs are blocked', () => {
    const negative = deriveCashModel(
      {
        grossCash: -1,
        safetyReserve: 0,
        pendingOrderCash: 0,
        dataUncertaintyReserve: 0,
      },
      { shortTermBudget: 0, longTermBudget: 0 },
      NORMAL_SAFETY,
    )
    expect(negative.deployableCash).toBe(0)
    expect(negative.blockedReasons).toContain('CASH_NEGATIVE')
    expect(negative.blockedReasons).toContain('INVALID_NUMERIC_INPUT')
  })
})

describe('asset-class headroom', () => {
  const calculate = (overrides: Partial<Parameters<typeof computeAssetClassHeadroom>[0]> = {}) =>
    computeAssetClassHeadroom({
      assetClass: 'JP_TRUST',
      currentAmount: 200_000,
      totalAssets: 1_000_000,
      targetRatio: 0.4,
      maximumAmount: 500_000,
      availableBudget: 300_000,
      ...overrides,
    })

  it('distinguishes target gap, hard cap, and budget', () => {
    const plan = calculate()
    expect(plan.targetAmount).toBe(400_000)
    expect(plan.targetGap).toBe(200_000)
    expect(plan.hardHeadroom).toBe(300_000)
    expect(plan.effectiveHeadroom).toBe(200_000)
    expect(plan.limitingFactors).toContain('TARGET_GAP')
  })

  it('returns zero at target and above target without false purchase headroom', () => {
    expect(calculate({ currentAmount: 400_000 }).effectiveHeadroom).toBe(0)
    const above = calculate({ currentAmount: 450_000 })
    expect(above.effectiveHeadroom).toBe(0)
    expect(above.overweightAmount).toBe(50_000)
  })

  it('returns zero at an exact hard cap', () => {
    const plan = calculate({ currentAmount: 500_000, targetRatio: 0.8 })
    expect(plan.hardHeadroom).toBe(0)
    expect(plan.effectiveHeadroom).toBe(0)
  })

  it('uses the finite point target when an optional hard cap is absent', () => {
    const plan = calculate({ maximumAmount: null })
    expect(plan.hardHeadroom).toBe(plan.targetGap)
    expect(Number.isFinite(plan.hardHeadroom)).toBe(true)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'invalid or zero total assets %s fail closed',
    (totalAssets) => {
      const plan = calculate({ totalAssets })
      expect(plan.effectiveHeadroom).toBe(0)
      expect(plan.blockedReasons).toContain(totalAssets === 0 ? 'CLASS_TARGET_MISSING' : 'INVALID_NUMERIC_INPUT')
    },
  )
})

describe('domestic-stock cap', () => {
  it('ratio cap binds', () => {
    const result = computeDomesticStockHeadroom({
      totalAssets: 10_000_000,
      currentDomesticStockAmount: 500_000,
      jpStockMaxRatio: 0.08,
      jpStockMaxAmountJpy: 2_000_000,
    })
    expect(result.effectiveDomesticStockCap).toBe(800_000)
    expect(result.domesticStockHardHeadroom).toBe(300_000)
  })

  it('amount cap binds and both caps use the smaller value (HR-M-02)', () => {
    const result = computeDomesticStockHeadroom({
      totalAssets: 20_000_000,
      currentDomesticStockAmount: 500_000,
      jpStockMaxRatio: 0.15,
      jpStockMaxAmountJpy: 900_000,
    })
    expect(result.ratioCapAmount).toBe(3_000_000)
    expect(result.effectiveDomesticStockCap).toBe(900_000)
    expect(result.limitingFactors).toContain('JP_STOCK_AMOUNT_CAP')
  })

  it('supports either configured cap but never invents 10% or 8,000,000', () => {
    expect(computeDomesticStockHeadroom({
      totalAssets: 7_654_321,
      currentDomesticStockAmount: 0,
      jpStockMaxRatio: 0.123,
      jpStockMaxAmountJpy: null,
    }).effectiveDomesticStockCap).toBe(Math.floor(7_654_321 * 0.123))
    expect(computeDomesticStockHeadroom({
      totalAssets: 7_654_321,
      currentDomesticStockAmount: 0,
      jpStockMaxRatio: null,
      jpStockMaxAmountJpy: 456_789,
    }).effectiveDomesticStockCap).toBe(456_789)
  })

  it('fails closed when both policies or a ratio base are unavailable', () => {
    expect(computeDomesticStockHeadroom({
      totalAssets: 1_000_000,
      currentDomesticStockAmount: 0,
      jpStockMaxRatio: null,
      jpStockMaxAmountJpy: null,
    }).domesticStockHardHeadroom).toBe(0)
    expect(computeDomesticStockHeadroom({
      totalAssets: 0,
      currentDomesticStockAmount: 0,
      jpStockMaxRatio: 0.1,
      jpStockMaxAmountJpy: null,
    }).blockedReasons).toContain('TARGET_AUTHORITY_UNAVAILABLE')
  })

  it('already-over-cap holdings cannot create positive BUY_NEW or BUY_MORE headroom', () => {
    const result = computeDomesticStockHeadroom({
      totalAssets: 1_000_000,
      currentDomesticStockAmount: 300_000,
      jpStockMaxRatio: 0.2,
      jpStockMaxAmountJpy: 250_000,
    })
    expect(result.domesticStockHardHeadroom).toBe(0)
  })
})

describe('instrument headroom', () => {
  const policy: InstrumentPolicy = {
    instrumentId: 'fund-1',
    targetAmountJpy: 900_000,
    maxPositionAmountJpy: 800_000,
    sectorHeadroomJpy: 700_000,
    concentrationHeadroomJpy: 600_000,
    liquidityHeadroomJpy: 500_000,
    defaultMaxPositionShare: 0.25,
    defaultMaxSectorShare: 0.35,
    minimumPurchaseUnitJpy: 10_000,
  }
  const make = (overrides: Partial<InstrumentHeadroomInput> = {}) =>
    computeInstrumentHeadroom({
      instrumentId: 'fund-1',
      assetClass: 'JP_TRUST',
      kind: 'jp_trust',
      relationship: 'new_to_portfolio',
      currentAmount: 100_000,
      role: 'CORE',
      reason: 'fixture',
      priceJpy: null,
      lotSizeShares: null,
      classHeadroom: 400_000,
      availableBudget: 300_000,
      policy,
      ...overrides,
    })

  it.each([
    ['CLASS_HEADROOM', { classHeadroom: 50_000 }],
    ['AVAILABLE_BUDGET', { availableBudget: 60_000 }],
  ] as const)('%s independently binds', (factor, overrides) => {
    const result = make(overrides)
    expect(result.limitingFactors).toContain(factor)
  })

  it.each([
    ['TARGET_GAP', { ...policy, targetAmountJpy: 120_000 }],
    ['MAX_POSITION', { ...policy, maxPositionAmountJpy: 130_000 }],
    ['SECTOR', { ...policy, sectorHeadroomJpy: 40_000 }],
    ['CONCENTRATION', { ...policy, concentrationHeadroomJpy: 30_000 }],
    ['LIQUIDITY', { ...policy, liquidityHeadroomJpy: 20_000 }],
  ] as const)('%s policy independently binds', (factor, policyOverride) => {
    const result = make({ policy: policyOverride })
    expect(result.limitingFactors).toContain(factor)
  })

  it('missing max-position and sector use finite policy fallbacks with warnings', () => {
    const result = make({
      classHeadroom: 200_000,
      policy: { ...policy, maxPositionAmountJpy: null, sectorHeadroomJpy: null },
    })
    expect(result.instrumentMaxPositionHeadroom).toBe(50_000)
    expect(result.sectorHeadroom).toBe(70_000)
    expect(result.warningReasons).toContain('SECTOR_AUTHORITY_PARTIAL')
    expect(Number.isFinite(result.effectiveInstrumentHeadroom)).toBe(true)
  })

  it('missing instrument policy fails closed rather than becoming Infinity', () => {
    const result = make({ policy: null })
    expect(result.effectiveInstrumentHeadroom).toBe(0)
    expect(result.blockedReasons).toContain('INSTRUMENT_AUTHORITY_UNAVAILABLE')
  })
})

describe('rounding primitive', () => {
  it('rounds down after cap and never rounds upward (HR-M-03)', () => {
    expect(roundDownToUnit(19_999, 10_000)).toBe(10_000)
    expect(roundDownToUnit(20_000, 10_000)).toBe(20_000)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid unit %s',
    (unit) => expect(roundDownToUnit(50_000, unit)).toBe(0),
  )
})
