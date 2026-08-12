import { describe, expect, it } from 'vitest'
import { buildAllocationPlanSnapshot, deriveCashModel } from '../domain/allocation'
import type { AppState } from '../types'
import type { AllocationPlanInput, BlockedReason } from '../types/allocationPlan'
import { buildAllocationPlanInput, useAppStore } from './useAppStore'

const GENERATED_AT = '2026-08-01T00:00:00.000Z'

function baseInput(): AllocationPlanInput {
  const state: AppState = { ...useAppStore.getState(), holdings: [], trust: [] }
  const input = buildAllocationPlanInput(state, {
    generatedAt: GENERATED_AT,
    holdingsFreshness: 'fresh',
    sourceHoldingsSnapshotId: 'reason-holdings', sourceSettingsVersion: 'reason-settings',
    cash: { grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 1_000_000, longTermBudget: 0 },
    instruments: [{ instrumentId: 'fund-1', assetClass: 'JP_TRUST', kind: 'jp_trust', relationship: 'new_to_portfolio', currentAmount: 0, role: 'CORE', reason: 'reason fixture', priceJpy: null, lotSizeShares: null }],
    candidates: [{ instrumentId: 'fund-1', buyKind: 'BUY_NEW', marketRank: 1, artifactIndex: 0, confidence: 1 }],
    policy: {
      jpStockMaxRatio: 0.3, jpStockMaxAmountJpy: null, jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [{ assetClass: 'JP_TRUST', targetRatio: 0.5, maximumRatio: null, maximumAmountJpy: null }],
      instrumentPolicies: [{ instrumentId: 'fund-1', targetAmountJpy: 500_000, maxPositionAmountJpy: 500_000, sectorHeadroomJpy: 500_000, concentrationHeadroomJpy: 500_000, liquidityHeadroomJpy: 500_000, defaultMaxPositionShare: 0.25, defaultMaxSectorShare: 0.35, minimumPurchaseUnitJpy: 10_000 }],
      roundingPolicies: [{ kind: 'jp_trust', purchaseUnitJpy: 10_000 }],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION', buyNewBaseShare: 1,
      buyMoreBaseShare: 1, confidenceUnknownFactor: 0.5, executionPriceBufferRatio: 0.03,
    },
    safetyState: { safeMode: 'inactive', marketData: 'fresh', cash: 'known_fresh', target: 'known', pendingOrders: 'known', candidateArtifact: 'fresh', dqViolation: false, tierA: 'normal', crossTab: 'current', noTrade: 'normal' },
  })
  if (input === null) throw new Error('fixture input must be valid')
  return input
}

function reasons(input: AllocationPlanInput): Set<BlockedReason> {
  const snapshot = buildAllocationPlanSnapshot(input)
  return new Set([
    ...snapshot.blockedReasons,
    ...snapshot.assetClassPlans.flatMap(plan => plan.blockedReasons),
    ...snapshot.instrumentPlans.flatMap(plan => plan.blockedReasons),
  ])
}

describe('HR-I2 reason producer pins', () => {
  it.each([
    ['CASH_AUTHORITY_STALE', (input: AllocationPlanInput) => ({ ...input, safetyState: { ...input.safetyState, cash: 'stale' as const } })],
    ['POLICY_AUTHORITY_UNAVAILABLE', (input: AllocationPlanInput) => ({ ...input, policy: { ...input.policy, buyNewBaseShare: 2 } })],
    ['CLASS_FULL', (input: AllocationPlanInput) => ({ ...input, budgets: { shortTermBudget: 0, longTermBudget: 0 } })],
    ['INSUFFICIENT_CASH', (input: AllocationPlanInput) => ({ ...input, cash: { ...input.cash, grossCash: 0 }, budgets: { shortTermBudget: 0, longTermBudget: 0 } })],
    ['NO_TRADE_EMERGENCY', (input: AllocationPlanInput) => ({ ...input, safetyState: { ...input.safetyState, noTrade: 'emergency' as const } })],
    ['HOLDINGS_STALE', (input: AllocationPlanInput) => ({ ...input, safetyState: { ...input.safetyState, holdings: 'stale' as const } })],
    ['CASH_DATA_STALE', (input: AllocationPlanInput) => ({ ...input, safetyState: { ...input.safetyState, cash: 'stale' as const } })],
    ['CROSS_TAB_STALE', (input: AllocationPlanInput) => ({ ...input, safetyState: { ...input.safetyState, crossTab: 'stale' as const } })],
  ] as const)('%s is emitted by its actual engine condition', (reason, mutate) => {
    expect(reasons(mutate(baseInput()))).toContain(reason)
  })

  it('removing the producer conditions removes the seven pinned unsafe reasons', () => {
    const actual = reasons(baseInput())
    for (const reason of ['CASH_AUTHORITY_STALE', 'POLICY_AUTHORITY_UNAVAILABLE', 'INSUFFICIENT_CASH', 'NO_TRADE_EMERGENCY', 'HOLDINGS_STALE', 'CASH_DATA_STALE', 'CROSS_TAB_STALE'] as const) {
      expect(actual).not.toContain(reason)
    }
  })

  it('RESERVED-NOT-PRODUCED codes never appear at any scope', () => {
    const actual = reasons(baseInput())
    expect(actual).not.toContain('CLASS_CAP_MISSING')
    expect(actual).not.toContain('JP_STOCK_CAP')
    expect(actual).not.toContain('JP_TRUST_TARGET_REACHED')
  })

  it('stale reserve replaces rather than adds to the supplied uncertainty reserve', () => {
    const input = baseInput()
    const cash = deriveCashModel(
      { grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 2_000_000 },
      { shortTermBudget: 5_000_000, longTermBudget: 0 },
      { ...input.safetyState, holdings: 'stale' },
    )
    expect(cash.dataUncertaintyReserve).toBe(5_000_000)
    expect(cash.deployableCash).toBe(0)
  })

  it('partial BUY_MORE remains estimate-only and cannot allocate', () => {
    const input = baseInput()
    const snapshot = buildAllocationPlanSnapshot({
      ...input,
      candidates: [{ ...input.candidates[0], buyKind: 'BUY_MORE' }],
      safetyState: { ...input.safetyState, holdings: 'partial' },
    })
    expect(snapshot.instrumentPlans[0]).toMatchObject({
      estimatedMaximumAmount: 500_000, finalSuggestedAmount: 0, allocatedAmount: 0, executable: false,
    })
    expect(snapshot.instrumentPlans[0].warningReasons).toEqual(expect.arrayContaining(['PORTFOLIO_SOURCE_PARTIAL', 'ESTIMATE_ONLY']))
  })
})
