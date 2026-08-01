import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  ALLOCATION_PLAN_SCHEMA_VERSION,
  type AllocationBehavior,
  type AllocationPlanSnapshot,
  type BlockedReason,
  type LimitingFactor,
  type SafetyState,
} from './allocationPlan'

describe('AllocationPlan contract', () => {
  it('uses frozen identity literals and persistence none', () => {
    expect(ALLOCATION_PLAN_AUTHORITY_VERSION).toBe('hr-allocation-plan-v1')
    expect(ALLOCATION_PLAN_SCHEMA_VERSION).toBe('allocation-plan-1')
    expectTypeOf<AllocationPlanSnapshot['persistence']>().toEqualTypeOf<'none'>()
    expectTypeOf<AllocationPlanSnapshot['privacyMode']>().toEqualTypeOf<'local_only'>()
    expectTypeOf<AllocationPlanSnapshot['not_for_trading']>().toEqualTypeOf<true>()
  })

  it('has type-safe blocked reasons and limiting factors', () => {
    const blocked: BlockedReason = 'JP_STOCK_EXECUTION_DATA_UNAVAILABLE'
    const limiting: LimitingFactor = 'SIMULTANEOUS_BUDGET'
    expect(blocked).toBe('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    expect(limiting).toBe('SIMULTANEOUS_BUDGET')
  })

  it('represents the complete behavior matrix as a discriminated union', () => {
    const behaviors: AllocationBehavior[] = [
      'BLOCK_AND_ZERO',
      'HOLD_EXISTING_ONLY',
      'DISPLAY_MAX_WITH_WARNING',
      'DISPLAY_ESTIMATE_ONLY',
      'NORMAL',
    ]
    expect(new Set(behaviors).size).toBe(5)
  })

  it('requires all safety-state authorities', () => {
    const state: SafetyState = {
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
    expect(Object.keys(state).sort()).toEqual([
      'candidateArtifact',
      'cash',
      'crossTab',
      'dqViolation',
      'holdings',
      'marketData',
      'noTrade',
      'pendingOrders',
      'safeMode',
      'target',
      'tierA',
    ])
  })

  it('snapshot output is JSON serializable and contains no non-finite sentinel', () => {
    const snapshot: AllocationPlanSnapshot = {
      authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
      schemaVersion: ALLOCATION_PLAN_SCHEMA_VERSION,
      snapshotId: 'snapshot-1',
      generatedAt: '2026-08-01T00:00:00.000Z',
      sourceHoldingsSnapshotId: 'holdings-1',
      sourceSettingsVersion: 'settings-1',
      totalAssets: 0,
      grossCash: 0,
      deployableCash: 0,
      shortTermBudget: 0,
      longTermBudget: 0,
      marketMode: 'normal',
      regime: 'neutral',
      assetClassPlans: [],
      instrumentPlans: [],
      remainingUnallocatedCash: 0,
      blockedReasons: [],
      warnings: [],
      not_for_trading: true,
      privacyMode: 'local_only',
      persistence: 'none',
    }
    const serialized = JSON.stringify(snapshot)
    expect(JSON.parse(serialized)).toEqual(snapshot)
    expect(serialized).not.toContain('Infinity')
    expect(serialized).not.toContain('NaN')
  })

  it('monetary fields are numeric contracts, not UI strings', () => {
    expectTypeOf<AllocationPlanSnapshot['grossCash']>().toEqualTypeOf<number>()
    expectTypeOf<AllocationPlanSnapshot['deployableCash']>().toEqualTypeOf<number>()
    expectTypeOf<AllocationPlanSnapshot['remainingUnallocatedCash']>().toEqualTypeOf<number>()
  })
})
