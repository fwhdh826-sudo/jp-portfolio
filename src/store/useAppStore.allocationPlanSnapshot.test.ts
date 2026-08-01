// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { AllocationPlanInput } from '../types/allocationPlan'
import {
  buildAllocationPlanInput,
  createAppStoreInstanceForTest,
  runFullAnalysis,
  useAppStore,
  type AllocationPlanInputAdapterOptions,
} from './useAppStore'
import { snapshotExecutability } from './allocationPlanSelectors'

const NOW = Date.parse('2026-08-01T00:00:00.000Z')

function cleanState(): AppState {
  const state = useAppStore.getState()
  return { ...state, holdings: [], trust: [] }
}

function adapter(
  holdings: AllocationPlanInput['safetyState']['holdings'],
  identity: string,
): Omit<AllocationPlanInputAdapterOptions, 'generatedAt'> {
  return {
    holdingsFreshness: holdings,
    sourceHoldingsSnapshotId: identity,
    sourceSettingsVersion: 'settings-v1',
    cash: { grossCash: 10_000_000, safetyReserve: 1_000_000, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 9_000_000, longTermBudget: 0 },
    instruments: [{ instrumentId: 'fund-1', assetClass: 'JP_TRUST', kind: 'jp_trust', relationship: 'new_to_portfolio', currentAmount: 0, role: 'CORE', reason: 'S1 exact fixture', priceJpy: null, lotSizeShares: null }],
    candidates: [{ instrumentId: 'fund-1', buyKind: 'BUY_NEW', marketRank: 1, artifactIndex: 0, confidence: 1 }],
    policy: {
      jpStockMaxRatio: 0.3,
      jpStockMaxAmountJpy: null,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [
        { assetClass: 'JP_STOCK', targetRatio: 0.1, maximumRatio: 0.3, maximumAmountJpy: null },
        { assetClass: 'JP_TRUST', targetRatio: 0.3, maximumRatio: null, maximumAmountJpy: null },
        { assetClass: 'OVERSEAS_TRUST', targetRatio: 0.5, maximumRatio: null, maximumAmountJpy: null },
        { assetClass: 'GOLD', targetRatio: 0.1, maximumRatio: null, maximumAmountJpy: null },
      ],
      instrumentPolicies: [{ instrumentId: 'fund-1', targetAmountJpy: 700_000, maxPositionAmountJpy: 700_000, sectorHeadroomJpy: 700_000, concentrationHeadroomJpy: 700_000, liquidityHeadroomJpy: 700_000, defaultMaxPositionShare: 0.25, defaultMaxSectorShare: 0.35, minimumPurchaseUnitJpy: 10_000 }],
      roundingPolicies: [{ kind: 'jp_trust', purchaseUnitJpy: 10_000 }],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION', buyNewBaseShare: 1,
      buyMoreBaseShare: 1, confidenceUnknownFactor: 0.5, executionPriceBufferRatio: 0.03,
    },
    safetyState: { safeMode: 'inactive', marketData: 'fresh', cash: 'known_fresh', target: 'known', pendingOrders: 'known', candidateArtifact: 'fresh', dqViolation: false, tierA: 'normal', crossTab: 'current', noTrade: 'normal' },
  }
}

function calculate(holdings: AllocationPlanInput['safetyState']['holdings'], identity: string, nowMs = NOW) {
  return runFullAnalysis(cleanState(), { nowMs, allocationPlanInput: adapter(holdings, identity) })
}

describe('AllocationPlanSnapshot store authority', () => {
  it('B-01 has exactly one canonical engine call, inside runFullAnalysis', () => {
    const source = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')
    expect(source.match(/buildAllocationPlanSnapshot\(/g)).toHaveLength(1)
    expect(source.indexOf('buildAllocationPlanSnapshot(')).toBeGreaterThan(source.indexOf('export function runFullAnalysis'))
  })

  it('B-02 partial keeps the exact estimate but zeros executable/final allocation', () => {
    const result = calculate('partial', 'holdings-partial')
    const plan = result.allocationPlan?.instrumentPlans[0]
    expect(result.allocationPlan?.deployableCash).toBe(9_000_000)
    expect(plan?.estimatedMaximumAmount).toBe(700_000)
    expect(plan?.finalSuggestedAmount).toBe(0)
    expect(plan?.executable).toBe(false)
    expect(result.allocationPlanStatus).toBe('estimate_only')
  })

  it('B-03 stale replaces a supplied reserve with gross cash and zeros every amount', () => {
    const result = runFullAnalysis(cleanState(), {
      nowMs: NOW,
      allocationPlanInput: { ...adapter('stale', 'holdings-stale'), cash: { grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 2_000_000 } },
    })
    const plan = result.allocationPlan?.instrumentPlans[0]
    expect(result.allocationPlan?.grossCash).toBe(5_000_000)
    expect(result.allocationPlan?.deployableCash).toBe(0)
    expect(plan?.estimatedMaximumAmount).toBe(0)
    expect(plan?.finalSuggestedAmount).toBe(0)
    expect(plan?.executable).toBe(false)
    expect(result.allocationPlanStatus).toBe('stale')
  })

  it('B-05 remains absent in export payload and a new store hydration boundary', () => {
    const computed = calculate('fresh', 'holdings-persist')
    useAppStore.setState(computed)
    expect(useAppStore.getState().allocationPlan).not.toBeNull()
    const exported = JSON.parse(useAppStore.getState().exportPortfolioSnapshot())
    expect(exported).not.toHaveProperty('allocationPlan')
    expect(exported).not.toHaveProperty('allocationPlanStatus')
    const isolated = createAppStoreInstanceForTest()
    expect(isolated.store.getState().allocationPlan).toBeNull()
    expect(isolated.store.getState().allocationPlanStatus).toBe('absent')
    isolated.controls.dispose()
  })

  it('B-06/B-07 transitions invalidate the old identity and publish a complete snapshot atomically', () => {
    const isolated = createAppStoreInstanceForTest()
    const observations: Array<{ id: string | null; plans: number }> = []
    const unsubscribe = isolated.store.subscribe(state => observations.push({ id: state.allocationPlan?.snapshotId ?? null, plans: state.allocationPlan?.instrumentPlans.length ?? 0 }))
    const first = runFullAnalysis({ ...isolated.store.getState(), holdings: [], trust: [] }, { nowMs: NOW, allocationPlanInput: adapter('fresh', 'generation-1') })
    isolated.store.setState(first)
    const second = runFullAnalysis({ ...isolated.store.getState(), holdings: [], trust: [] }, { nowMs: NOW + 1, allocationPlanInput: adapter('partial', 'generation-2') })
    isolated.store.setState(second)
    expect(first.allocationPlan?.snapshotId).not.toBe(second.allocationPlan?.snapshotId)
    expect(isolated.store.getState().allocationPlan?.sourceHoldingsSnapshotId).toBe('generation-2')
    expect(isolated.store.getState().allocationPlanStatus).toBe('estimate_only')
    expect(observations).toEqual([
      { id: first.allocationPlan!.snapshotId, plans: 1 },
      { id: second.allocationPlan!.snapshotId, plans: 1 },
    ])
    unsubscribe(); isolated.controls.dispose()
  })

  it.each([
    ['fresh', 'partial'], ['partial', 'fresh'], ['fresh', 'stale'], ['stale', 'fresh'],
  ] as const)('transition %s -> %s replaces source identity and executability', (from, to) => {
    const before = calculate(from, `source-${from}`, NOW)
    const after = calculate(to, `source-${to}`, NOW + 1)
    expect(after.allocationPlan?.snapshotId).not.toBe(before.allocationPlan?.snapshotId)
    expect(after.allocationPlan?.sourceHoldingsSnapshotId).toBe(`source-${to}`)
    expect(snapshotExecutability(after.allocationPlan)).not.toBe('NOT_CALCULATED')
  })

  it('unavailable collapses fail-closed to stale, then complete can recover', () => {
    const input = buildAllocationPlanInput(cleanState(), { generatedAt: new Date(NOW).toISOString(), ...adapter('fresh', 'unknown-source'), holdingsFreshness: 'unavailable' })
    expect(input?.safetyState.holdings).toBe('stale')
    const recovered = calculate('fresh', 'complete-source', NOW + 1)
    expect(recovered.allocationPlan?.sourceHoldingsSnapshotId).toBe('complete-source')
  })

  it('invalid identity stores no corrupt snapshot and does not fail open', () => {
    const result = runFullAnalysis(cleanState(), { nowMs: NOW, allocationPlanInput: { ...adapter('fresh', 'unused'), sourceHoldingsSnapshotId: null } })
    expect(result.allocationPlan).toBeNull()
    expect(result.allocationPlanStatus).toBe('invalid')
    expect(snapshotExecutability(result.allocationPlan)).toBe('NOT_CALCULATED')
  })

  it('same captured input and identities serialize deterministically; injected time changes identity', () => {
    const first = calculate('fresh', 'deterministic', NOW)
    const replay = calculate('fresh', 'deterministic', NOW)
    const newer = calculate('fresh', 'deterministic', NOW + 1)
    expect(JSON.stringify(first.allocationPlan)).toBe(JSON.stringify(replay.allocationPlan))
    expect(newer.allocationPlan?.snapshotId).not.toBe(first.allocationPlan?.snapshotId)
  })

  it('runFullAnalysis is synchronous, so an older invocation cannot complete after a newer invocation', () => {
    const older = calculate('fresh', 'older', NOW)
    const newer = calculate('fresh', 'newer', NOW + 1)
    expect(older).not.toBeInstanceOf(Promise)
    expect(newer).not.toBeInstanceOf(Promise)
    expect(newer.allocationPlan?.sourceHoldingsSnapshotId).toBe('newer')
  })
})
