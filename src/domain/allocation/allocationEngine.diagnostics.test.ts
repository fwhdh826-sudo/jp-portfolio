import { describe, expect, it } from 'vitest'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type AllocationPlanInput,
  type BlockedReason,
  type LimitingFactor,
} from '../../types/allocationPlan'
import { projectAllocationPlanSnapshot } from '../../store/allocationPlanSelectors'
import { buildAllocationPlanSnapshot } from './allocationEngine'

function input(overrides: Partial<AllocationPlanInput> = {}): AllocationPlanInput {
  const base: AllocationPlanInput = {
    generatedAt: '2026-08-01T00:00:00.000Z',
    snapshotId: 'd1-diagnostics',
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    sourceHoldingsSnapshotId: 'holdings-d1',
    sourceSettingsVersion: 'settings-d1',
    cash: { grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 0, longTermBudget: 1_000_000 },
    policy: {
      jpStockMaxRatio: 0.3,
      jpStockMaxAmountJpy: 500_000,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [
        { assetClass: 'JP_STOCK', targetRatio: 0.8, maximumRatio: null, maximumAmountJpy: null },
      ],
      instrumentPolicies: [{
        instrumentId: 'stock-1', targetAmountJpy: 800_000,
        maxPositionAmountJpy: 800_000, sectorHeadroomJpy: 800_000,
        concentrationHeadroomJpy: 800_000, liquidityHeadroomJpy: 800_000,
        defaultMaxPositionShare: 0.25, defaultMaxSectorShare: 0.35,
        minimumPurchaseUnitJpy: 100_000,
      }],
      roundingPolicies: [{ kind: 'jp_stock', purchaseUnitJpy: 100_000 }],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION',
      buyNewBaseShare: 1, buyMoreBaseShare: 1, confidenceUnknownFactor: 0.5,
      executionPriceBufferRatio: 0,
    },
    assetClasses: [{ assetClass: 'JP_STOCK', currentAmount: 0 }],
    instruments: [{
      instrumentId: 'stock-1', assetClass: 'JP_STOCK', kind: 'jp_stock',
      relationship: 'new_to_portfolio', currentAmount: 0, role: 'CORE', reason: 'D1 fixture',
      priceJpy: 1_000, lotSizeShares: 100,
    }],
    candidates: [{
      instrumentId: 'stock-1', buyKind: 'BUY_NEW', marketRank: 1,
      artifactIndex: 0, confidence: 1,
    }],
    safetyState: {
      safeMode: 'inactive', marketData: 'fresh', holdings: 'fresh', cash: 'known_fresh',
      target: 'known', pendingOrders: 'known', candidateArtifact: 'fresh', dqViolation: false,
      tierA: 'normal', crossTab: 'current', noTrade: 'normal',
    },
    regime: 'neutral', marketMode: 'normal',
  }
  return {
    ...base,
    ...overrides,
    cash: { ...base.cash, ...overrides.cash },
    budgets: { ...base.budgets, ...overrides.budgets },
    policy: { ...base.policy, ...overrides.policy },
    safetyState: { ...base.safetyState, ...overrides.safetyState },
  }
}

function stockClass(snapshot: ReturnType<typeof buildAllocationPlanSnapshot>) {
  const plan = snapshot.assetClassPlans.find(candidate => candidate.assetClass === 'JP_STOCK')
  expect(plan).toBeDefined()
  return plan!
}

function expectProduced(
  snapshot: ReturnType<typeof buildAllocationPlanSnapshot>,
  reason: BlockedReason,
): void {
  expect(stockClass(snapshot).blockedReasons).toContain(reason)
  expect(snapshot.blockedReasons).toContain(reason)
  expect(snapshot.instrumentPlans[0]?.blockedReasons).toContain(reason)
}

describe('HR-I1-D1 domestic-stock diagnostic production', () => {
  it('produces POLICY_AUTHORITY_UNAVAILABLE when both domestic caps are missing', () => {
    const snapshot = buildAllocationPlanSnapshot(input({
      policy: { ...input().policy, jpStockMaxRatio: null, jpStockMaxAmountJpy: null },
    }))
    expectProduced(snapshot, 'POLICY_AUTHORITY_UNAVAILABLE')
    expect(snapshot.instrumentPlans[0]?.finalSuggestedAmount).toBe(0)
    expect(snapshot.instrumentPlans[0]?.executable).toBe(false)
  })

  it('does not produce POLICY_AUTHORITY_UNAVAILABLE when either cap exists', () => {
    for (const policy of [
      { jpStockMaxRatio: 0.3, jpStockMaxAmountJpy: null },
      { jpStockMaxRatio: null, jpStockMaxAmountJpy: 500_000 },
    ] as const) {
      const snapshot = buildAllocationPlanSnapshot(input({ policy: { ...input().policy, ...policy } }))
      expect(stockClass(snapshot).blockedReasons).not.toContain('POLICY_AUTHORITY_UNAVAILABLE')
    }
  })

  it('produces TARGET_AUTHORITY_UNAVAILABLE when a ratio cap has no positive total-assets base', () => {
    const snapshot = buildAllocationPlanSnapshot(input({
      cash: { grossCash: 0, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
      budgets: { shortTermBudget: 0, longTermBudget: 0 },
      policy: { ...input().policy, jpStockMaxRatio: 0.3, jpStockMaxAmountJpy: null },
    }))
    expectProduced(snapshot, 'TARGET_AUTHORITY_UNAVAILABLE')
  })

  it('does not produce TARGET_AUTHORITY_UNAVAILABLE at the one-yen total-assets boundary', () => {
    const snapshot = buildAllocationPlanSnapshot(input({
      cash: { grossCash: 1, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
      budgets: { shortTermBudget: 0, longTermBudget: 1 },
      policy: { ...input().policy, jpStockMaxRatio: 0.3, jpStockMaxAmountJpy: null },
      candidates: [],
    }))
    expect(stockClass(snapshot).blockedReasons).not.toContain('TARGET_AUTHORITY_UNAVAILABLE')
  })

  it.each([
    ['ratio', { jpStockMaxRatio: Number.NaN, jpStockMaxAmountJpy: 500_000 }],
    ['amount', { jpStockMaxRatio: null, jpStockMaxAmountJpy: 1.5 }],
  ] as const)('produces INVALID_NUMERIC_INPUT for an invalid %s cap', (_label, cap) => {
    const snapshot = buildAllocationPlanSnapshot(input({ policy: { ...input().policy, ...cap } }))
    expectProduced(snapshot, 'INVALID_NUMERIC_INPUT')
  })

  it('propagates the ratio-cap limiting factor into the JP_STOCK class plan', () => {
    const plan = stockClass(buildAllocationPlanSnapshot(input({
      policy: { ...input().policy, jpStockMaxRatio: 0.3, jpStockMaxAmountJpy: 500_000 },
    })))
    expect(plan.maximumAmount).toBe(300_000)
    expect(plan.effectiveHeadroom).toBe(300_000)
    expect(plan.limitingFactors).toContain('JP_STOCK_RATIO_CAP')
    expect(plan.limitingFactors).not.toContain('JP_STOCK_AMOUNT_CAP')
  })

  it('propagates the amount-cap limiting factor into the JP_STOCK class plan', () => {
    const plan = stockClass(buildAllocationPlanSnapshot(input({
      policy: { ...input().policy, jpStockMaxRatio: 0.7, jpStockMaxAmountJpy: 250_000 },
    })))
    expect(plan.maximumAmount).toBe(250_000)
    expect(plan.effectiveHeadroom).toBe(250_000)
    expect(plan.limitingFactors).toContain('JP_STOCK_AMOUNT_CAP')
    expect(plan.limitingFactors).not.toContain('JP_STOCK_RATIO_CAP')
  })

  it('keeps both limiting factors exactly once when ratio and amount caps tie', () => {
    const plan = stockClass(buildAllocationPlanSnapshot(input({
      policy: { ...input().policy, jpStockMaxRatio: 0.3, jpStockMaxAmountJpy: 300_000 },
    })))
    const domesticFactors: LimitingFactor[] = plan.limitingFactors.filter(
      factor => factor === 'JP_STOCK_RATIO_CAP' || factor === 'JP_STOCK_AMOUNT_CAP',
    )
    expect(domesticFactors).toEqual(['JP_STOCK_RATIO_CAP', 'JP_STOCK_AMOUNT_CAP'])
  })

  it('dedupes one invalid code across snapshot and class production paths', () => {
    const snapshot = buildAllocationPlanSnapshot(input({
      cash: { grossCash: 1_000_000.5, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
      assetClasses: [{ assetClass: 'JP_STOCK', currentAmount: 1.5 }],
    }))
    expect(snapshot.blockedReasons.filter(reason => reason === 'INVALID_NUMERIC_INPUT')).toHaveLength(1)
    expect(stockClass(snapshot).blockedReasons.filter(reason => reason === 'INVALID_NUMERIC_INPUT')).toHaveLength(1)
  })

  it('leaves non-JP class diagnostics untouched', () => {
    const base = input()
    const snapshot = buildAllocationPlanSnapshot(input({
      policy: {
        ...base.policy,
        assetClassPolicies: [{ assetClass: 'JP_TRUST', targetRatio: 0.8, maximumRatio: null, maximumAmountJpy: null }],
      },
      assetClasses: [{ assetClass: 'JP_TRUST', currentAmount: 0 }],
      instruments: [], candidates: [],
    }))
    const plan = snapshot.assetClassPlans[0]
    expect(plan.blockedReasons).not.toContain('POLICY_AUTHORITY_UNAVAILABLE')
    expect(plan.blockedReasons).not.toContain('TARGET_AUTHORITY_UNAVAILABLE')
    expect(plan.limitingFactors).not.toContain('JP_STOCK_RATIO_CAP')
    expect(plan.limitingFactors).not.toContain('JP_STOCK_AMOUNT_CAP')
  })

  it('preserves numeric allocation outputs while exposing the ratio-cap cause', () => {
    const snapshot = buildAllocationPlanSnapshot(input())
    const plan = stockClass(snapshot)
    expect({
      totalAssets: snapshot.totalAssets,
      deployableCash: snapshot.deployableCash,
      targetAmount: plan.targetAmount,
      maximumAmount: plan.maximumAmount,
      hardHeadroom: plan.hardHeadroom,
      effectiveHeadroom: plan.effectiveHeadroom,
      allocatedAmount: plan.allocatedAmount,
      remainingUnallocatedCash: snapshot.remainingUnallocatedCash,
    }).toEqual({
      totalAssets: 1_000_000,
      deployableCash: 1_000_000,
      targetAmount: 800_000,
      maximumAmount: 300_000,
      hardHeadroom: 300_000,
      effectiveHeadroom: 300_000,
      allocatedAmount: 300_000,
      remainingUnallocatedCash: 700_000,
    })
    expect(plan.limitingFactors).toContain('JP_STOCK_RATIO_CAP')
  })

  it('projects every produced D1 diagnostic with known canonical order', () => {
    const snapshot = buildAllocationPlanSnapshot(input({
      policy: { ...input().policy, jpStockMaxRatio: null, jpStockMaxAmountJpy: null },
    }))
    const projected = projectAllocationPlanSnapshot(snapshot)
    expect(projected).not.toBeNull()
    expect(projected?.assetClassPlans[0].blockedReasons).toEqual([
      'POLICY_AUTHORITY_UNAVAILABLE', 'CLASS_FULL',
    ])
  })

  it('keeps authority-reserved codes unproduced', () => {
    const snapshots = [
      buildAllocationPlanSnapshot(input()),
      buildAllocationPlanSnapshot(input({
        policy: { ...input().policy, jpStockMaxRatio: null, jpStockMaxAmountJpy: null },
      })),
    ]
    for (const snapshot of snapshots) {
      const all = [
        ...snapshot.blockedReasons,
        ...snapshot.assetClassPlans.flatMap(plan => plan.blockedReasons),
        ...snapshot.instrumentPlans.flatMap(plan => plan.blockedReasons),
      ]
      expect(all).not.toContain('CLASS_CAP_MISSING')
      expect(all).not.toContain('JP_STOCK_CAP')
      expect(all).not.toContain('JP_TRUST_TARGET_REACHED')
    }
  })
})
