import { describe, expect, it } from 'vitest'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type AllocationPlanInput,
  type AssetClassPlan,
} from '../types/allocationPlan'
import {
  BLOCKED_REASON_ORDER,
  LIMITING_FACTOR_ORDER,
  WARNING_REASON_ORDER,
  classFullCause,
  orderBlockedReasons,
  orderLimitingFactors,
  orderWarningReasons,
  projectAllocationPlanSnapshot,
  snapshotExecutability,
} from './allocationPlanSelectors'

function input(): AllocationPlanInput {
  return {
    generatedAt: '2026-08-01T00:00:00.000Z', snapshotId: 'snapshot-1',
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    sourceHoldingsSnapshotId: 'holdings-1', sourceSettingsVersion: 'settings-1',
    cash: { grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 1_000_000, longTermBudget: 0 },
    policy: {
      jpStockMaxRatio: 0.3, jpStockMaxAmountJpy: null, jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [{ assetClass: 'JP_TRUST', targetRatio: 0.5, maximumRatio: null, maximumAmountJpy: null }],
      instrumentPolicies: [{ instrumentId: 'fund-1', targetAmountJpy: 700_000, maxPositionAmountJpy: 700_000, sectorHeadroomJpy: 700_000, concentrationHeadroomJpy: 700_000, liquidityHeadroomJpy: 700_000, defaultMaxPositionShare: 0.25, defaultMaxSectorShare: 0.35, minimumPurchaseUnitJpy: 10_000 }],
      roundingPolicies: [{ kind: 'jp_trust', purchaseUnitJpy: 10_000 }],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION', buyNewBaseShare: 1,
      buyMoreBaseShare: 1, confidenceUnknownFactor: 0.5, executionPriceBufferRatio: 0.03,
    },
    assetClasses: [{ assetClass: 'JP_TRUST', currentAmount: 0 }],
    instruments: [{ instrumentId: 'fund-1', assetClass: 'JP_TRUST', kind: 'jp_trust', relationship: 'new_to_portfolio', currentAmount: 0, role: 'CORE', reason: 'fixture', priceJpy: null, lotSizeShares: null }],
    candidates: [{ instrumentId: 'fund-1', buyKind: 'BUY_NEW', marketRank: 1, artifactIndex: 0, confidence: 1 }],
    safetyState: { safeMode: 'inactive', marketData: 'fresh', holdings: 'fresh', cash: 'known_fresh', target: 'known', pendingOrders: 'known', candidateArtifact: 'fresh', dqViolation: false, tierA: 'normal', crossTab: 'current', noTrade: 'normal' },
    regime: 'neutral', marketMode: 'normal',
  }
}

function classPlan(overrides: Partial<AssetClassPlan>): AssetClassPlan {
  return {
    assetClass: 'JP_TRUST', currentAmount: 0, targetAmount: 1, targetRatio: 0.1,
    minimumAmount: null, maximumAmount: null, targetGap: 1, hardHeadroom: 1,
    softHeadroom: 1, effectiveHeadroom: 0, overweightAmount: 0, availableBudget: 1,
    allocatedAmount: 0, remainingHeadroom: 0, limitingFactors: [],
    blockedReasons: ['CLASS_FULL'], warningReasons: [], ...overrides,
  }
}

describe('allocation plan selector authority', () => {
  it('S1-F01: empty snapshot reasons do not make an instrument-only blocked snapshot executable', () => {
    const base = buildAllocationPlanSnapshot(input())
    const blocked = {
      ...base,
      blockedReasons: [],
      assetClassPlans: base.assetClassPlans.map(plan => ({ ...plan, blockedReasons: [] })),
      instrumentPlans: base.instrumentPlans.map(plan => ({ ...plan, executable: false, finalSuggestedAmount: 0, blockedReasons: ['JP_STOCK_EXECUTION_DATA_UNAVAILABLE' as const] })),
    }
    expect(blocked.blockedReasons).toEqual([])
    expect(snapshotExecutability(blocked)).toBe('CALCULATED_NOT_EXECUTABLE')
  })

  it('P3-07: class-local CLASS_FULL does not hide another executable class', () => {
    const base = buildAllocationPlanSnapshot(input())
    const mixed = {
      ...base,
      blockedReasons: ['CLASS_FULL' as const],
      assetClassPlans: [...base.assetClassPlans, classPlan({ assetClass: 'JP_STOCK', limitingFactors: ['AVAILABLE_BUDGET'] })],
    }
    expect(mixed.instrumentPlans.some(plan => plan.executable)).toBe(true)
    expect(snapshotExecutability(mixed)).toBe('EXECUTABLE')
  })

  it.each([
    [classPlan({ limitingFactors: ['TARGET_GAP', 'CLASS_HEADROOM'] }), 'CLASS_TARGET_REACHED'],
    [classPlan({ maximumAmount: 1, limitingFactors: ['CLASS_HEADROOM'] }), 'CLASS_HARD_CAP_REACHED'],
    [classPlan({ limitingFactors: ['AVAILABLE_BUDGET'] }), 'CLASS_BUDGET_EXHAUSTED'],
    [classPlan({ blockedReasons: ['CLASS_TARGET_MISSING', 'CLASS_FULL'], limitingFactors: ['TARGET_GAP', 'CLASS_HEADROOM'] }), 'CLASS_DATA_UNAVAILABLE'],
  ] as const)('CLASS_FULL C4 preserves its limiting cause', (plan, expected) => {
    expect(classFullCause(plan)).toBe(expected)
  })

  it('orders and dedupes by canonical union index, independent of engine insertion order', () => {
    expect(orderBlockedReasons(['CLASS_FULL', 'CASH_AUTHORITY_STALE', 'CLASS_FULL'])).toEqual(['CASH_AUTHORITY_STALE', 'CLASS_FULL'])
    expect(orderWarningReasons(['ESTIMATE_ONLY', 'PORTFOLIO_SOURCE_PARTIAL'])).toEqual(['PORTFOLIO_SOURCE_PARTIAL', 'ESTIMATE_ONLY'])
    expect(orderLimitingFactors(['JP_STOCK_AMOUNT_CAP', 'JP_STOCK_RATIO_CAP', 'JP_STOCK_AMOUNT_CAP']))
      .toEqual(['JP_STOCK_RATIO_CAP', 'JP_STOCK_AMOUNT_CAP'])
  })

  it('keeps all three exhaustive order tables duplicate-free with unique ordinals', () => {
    for (const table of [BLOCKED_REASON_ORDER, WARNING_REASON_ORDER, LIMITING_FACTOR_ORDER]) {
      const keys = Object.keys(table)
      const ordinals = Object.values(table)
      expect(new Set(keys).size).toBe(keys.length)
      expect(new Set(ordinals).size).toBe(ordinals.length)
      expect(ordinals.every(value => Number.isInteger(value) && value >= 0)).toBe(true)
    }
  })

  it('places each activated D1 diagnostic in exactly its authoritative category', () => {
    for (const reason of [
      'POLICY_AUTHORITY_UNAVAILABLE',
      'TARGET_AUTHORITY_UNAVAILABLE',
      'INVALID_NUMERIC_INPUT',
    ] as const) {
      expect(BLOCKED_REASON_ORDER).toHaveProperty(reason)
      expect(WARNING_REASON_ORDER).not.toHaveProperty(reason)
      expect(LIMITING_FACTOR_ORDER).not.toHaveProperty(reason)
    }
    for (const factor of ['JP_STOCK_RATIO_CAP', 'JP_STOCK_AMOUNT_CAP'] as const) {
      expect(LIMITING_FACTOR_ORDER).toHaveProperty(factor)
      expect(BLOCKED_REASON_ORDER).not.toHaveProperty(factor)
      expect(WARNING_REASON_ORDER).not.toHaveProperty(factor)
    }
  })

  it('returns the same canonical result for each reason set regardless of insertion order', () => {
    expect(orderBlockedReasons([
      'TARGET_AUTHORITY_UNAVAILABLE', 'INVALID_NUMERIC_INPUT', 'POLICY_AUTHORITY_UNAVAILABLE',
    ])).toEqual(orderBlockedReasons([
      'POLICY_AUTHORITY_UNAVAILABLE', 'TARGET_AUTHORITY_UNAVAILABLE', 'INVALID_NUMERIC_INPUT',
    ]))
    expect(orderWarningReasons([
      'ESTIMATE_ONLY', 'MARKET_CAUTION', 'PORTFOLIO_SOURCE_PARTIAL',
    ])).toEqual(orderWarningReasons([
      'PORTFOLIO_SOURCE_PARTIAL', 'ESTIMATE_ONLY', 'MARKET_CAUTION',
    ]))
    expect(orderLimitingFactors([
      'JP_STOCK_AMOUNT_CAP', 'CLASS_HEADROOM', 'JP_STOCK_RATIO_CAP',
    ])).toEqual(orderLimitingFactors([
      'JP_STOCK_RATIO_CAP', 'JP_STOCK_AMOUNT_CAP', 'CLASS_HEADROOM',
    ]))
  })

  it('recognizes every member of every exhaustive order table', () => {
    expect(orderBlockedReasons(Object.keys(BLOCKED_REASON_ORDER) as Array<keyof typeof BLOCKED_REASON_ORDER>)).not.toBeNull()
    expect(orderWarningReasons(Object.keys(WARNING_REASON_ORDER) as Array<keyof typeof WARNING_REASON_ORDER>)).not.toBeNull()
    expect(orderLimitingFactors(Object.keys(LIMITING_FACTOR_ORDER) as Array<keyof typeof LIMITING_FACTOR_ORDER>)).not.toBeNull()
  })

  it('never promotes one instrument blocked reason or synthesizes CLASS_FULL at class/snapshot scope', () => {
    const base = buildAllocationPlanSnapshot(input())
    const childOnly = {
      ...base,
      blockedReasons: [],
      assetClassPlans: base.assetClassPlans.map(plan => ({ ...plan, blockedReasons: [] })),
      instrumentPlans: base.instrumentPlans.map(plan => ({ ...plan, executable: false, blockedReasons: ['JP_STOCK_EXECUTION_DATA_UNAVAILABLE' as const] })),
    }
    const projected = projectAllocationPlanSnapshot(childOnly)
    expect(projected?.blockedReasons).toEqual([])
    expect(projected?.assetClassPlans.every(plan => !plan.blockedReasons.includes('CLASS_FULL'))).toBe(true)
  })

  it('filters instrument selection warning from snapshot projection and fails closed on unknown codes', () => {
    const base = buildAllocationPlanSnapshot(input())
    const projected = projectAllocationPlanSnapshot({ ...base, warnings: [...base.warnings, 'NOT_SELECTED_FOR_EXECUTION'] })
    expect(projected?.warnings).not.toContain('NOT_SELECTED_FOR_EXECUTION')
    expect(projectAllocationPlanSnapshot({ ...base, blockedReasons: ['UNKNOWN' as never] })).toBeNull()
    expect(projectAllocationPlanSnapshot({ ...base, warnings: ['UNKNOWN' as never] })).toBeNull()
    expect(projectAllocationPlanSnapshot({
      ...base,
      assetClassPlans: base.assetClassPlans.map(plan => ({
        ...plan,
        limitingFactors: ['UNKNOWN' as never],
      })),
    })).toBeNull()
  })
})
