// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { AppState, Trust } from '../types'
import type { AllocationPlanInput } from '../types/allocationPlan'
import {
  buildAllocationPlanInput,
  createAppStoreInstanceForTest,
  runFullAnalysis,
  useAppStore,
  type AllocationPlanInputAdapterOptions,
} from './useAppStore'
import {
  classFullCause,
  selectSnapshotExecutability,
  snapshotExecutability,
} from './allocationPlanSelectors'
import {
  createPortfolioGenerationInvalidationEvent,
  type PortfolioGenerationInvalidationTransport,
} from './portfolioGenerationInvalidationTransport'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'

const NOW = Date.parse('2026-08-01T00:00:00.000Z')

const dualAuthorityTypeProbe: AllocationPlanInputAdapterOptions = {
  generatedAt: new Date(NOW).toISOString(),
  holdingsFreshness: 'fresh',
  safetyState: {
    // @ts-expect-error holdingsFreshness is the adapter's only holdings authority.
    holdings: 'stale',
  },
}
void dualAuthorityTypeProbe

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

const TRUST_FIXTURE: Trust = {
  id: 'fund-1', name: 'allocation authority fixture', abbr: 'AAF', account: '特定',
  policy: 'JAPAN_SHORTTERM', eval: 0, pnlPct: 0, dayPct: 0, cost: 0,
  mu: 0.1, sigma: 0.1, score: 50, signal: 'HOLD', ev: 0, decision: 'HOLD',
}

function stateWithTrust(currentAmount: number): AppState {
  return {
    ...cleanState(),
    trust: [{ ...TRUST_FIXTURE, eval: currentAmount }],
  }
}

function jpStockAdapter(
  identity: string,
  instrumentIds: readonly ('blocked-stock' | 'allocatable-stock')[],
): Omit<AllocationPlanInputAdapterOptions, 'generatedAt'> {
  const base = adapter('fresh', identity)
  const policy = base.policy as AllocationPlanInput['policy']
  const instruments = {
    'blocked-stock': {
      instrumentId: 'blocked-stock', assetClass: 'JP_STOCK' as const, kind: 'jp_stock' as const,
      relationship: 'new_to_portfolio' as const, currentAmount: 0, role: 'CORE',
      reason: 'instrument-only execution authority unavailable', priceJpy: null, lotSizeShares: null,
    },
    'allocatable-stock': {
      instrumentId: 'allocatable-stock', assetClass: 'JP_STOCK' as const, kind: 'jp_stock' as const,
      relationship: 'new_to_portfolio' as const, currentAmount: 0, role: 'CORE',
      reason: 'allocatable sibling', priceJpy: 1_000, lotSizeShares: 100,
    },
  }
  return {
    ...base,
    cash: { grossCash: 2_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 1_000_000, longTermBudget: 1_000_000 },
    instruments: instrumentIds.map(instrumentId => instruments[instrumentId]),
    candidates: instrumentIds.map((instrumentId, artifactIndex) => ({
      instrumentId,
      buyKind: 'BUY_NEW' as const,
      marketRank: artifactIndex + 1,
      artifactIndex,
      confidence: 1,
    })),
    policy: {
      ...policy,
      jpStockMaxRatio: 0.8,
      assetClassPolicies: policy.assetClassPolicies.map(item => item.assetClass === 'JP_STOCK'
        ? { assetClass: 'JP_STOCK', targetRatio: 0.5, maximumRatio: 0.8, maximumAmountJpy: null }
        : item),
      instrumentPolicies: instrumentIds.map(instrumentId => ({
        instrumentId,
        targetAmountJpy: 1_000_000,
        maxPositionAmountJpy: 1_000_000,
        sectorHeadroomJpy: 1_000_000,
        concentrationHeadroomJpy: 1_000_000,
        liquidityHeadroomJpy: 1_000_000,
        defaultMaxPositionShare: 0.5,
        defaultMaxSectorShare: 0.5,
        minimumPurchaseUnitJpy: 10_000,
      })),
      roundingPolicies: [{ kind: 'jp_stock', purchaseUnitJpy: 10_000 }],
    },
  }
}

type ClassFullFixtureCause =
  | 'AVAILABLE_BUDGET'
  | 'CLASS_HEADROOM'
  | 'TARGET_GAP'
  | 'CLASS_TARGET_MISSING'

function classFullFixture(cause: ClassFullFixtureCause): {
  state: AppState
  options: Omit<AllocationPlanInputAdapterOptions, 'generatedAt'>
} {
  const currentAmount = cause === 'CLASS_HEADROOM' || cause === 'TARGET_GAP' ? 1_000_000 : 0
  const base = adapter('fresh', `class-full-${cause}`)
  const policy = base.policy as AllocationPlanInput['policy']
  const targetRatio = cause === 'CLASS_TARGET_MISSING'
    ? 0
    : cause === 'CLASS_HEADROOM' ? 0.8 : 0.5
  const maximumAmountJpy = cause === 'CLASS_HEADROOM' ? 1_000_000 : null
  const shortTermBudget = cause === 'AVAILABLE_BUDGET' ? 0 : 1_000_000
  return {
    state: stateWithTrust(currentAmount),
    options: {
      ...base,
      cash: { grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
      budgets: { shortTermBudget, longTermBudget: 0 },
      policy: {
        ...policy,
        assetClassPolicies: policy.assetClassPolicies.map(item => item.assetClass === 'JP_TRUST'
          ? { assetClass: 'JP_TRUST', targetRatio, maximumRatio: null, maximumAmountJpy }
          : item),
      },
    },
  }
}

function publishWriterOutput(
  state: AppState,
  allocationPlanInput: Omit<AllocationPlanInputAdapterOptions, 'generatedAt'>,
  nowMs = NOW,
) {
  const created = createAppStoreInstanceForTest()
  created.store.setState(state)
  const computed = runFullAnalysis(created.store.getState(), { nowMs, allocationPlanInput })
  created.store.setState(computed)
  return created
}

function manualInvalidationTransport() {
  let listener: ((event: ReturnType<typeof createPortfolioGenerationInvalidationEvent>) => void) | null = null
  const transport: PortfolioGenerationInvalidationTransport = {
    publish: () => {},
    subscribe: next => {
      listener = next
      return () => { listener = null }
    },
    dispose: () => { listener = null },
  }
  return {
    transport,
    emit: () => {
      if (listener === null) throw new Error('invalidation listener is not bound')
      listener(createPortfolioGenerationInvalidationEvent({
        senderInstanceId: 'remote-writer',
        operation: 'setCashAssumptions',
        committedAt: new Date(NOW).toISOString(),
        messageId: 'hr-i2-r1-cross-tab',
      }))
    },
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
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

  it('holdingsFreshness remains the sole adapter authority while other safety overrides are retained', () => {
    const base = adapter('partial', 'single-holdings-authority')
    const input = buildAllocationPlanInput(cleanState(), {
      generatedAt: new Date(NOW).toISOString(),
      ...base,
      safetyState: { ...base.safetyState, cash: 'stale' },
    })
    expect(input?.safetyState.holdings).toBe('partial')
    expect(input?.safetyState.cash).toBe('stale')
  })

  it('real writer output keeps an instrument-only JP-stock reason out of snapshot scope', () => {
    const created = publishWriterOutput(
      cleanState(),
      jpStockAdapter('real-s1-f01', ['blocked-stock']),
    )
    const snapshot = created.store.getState().allocationPlan
    const instrument = snapshot?.instrumentPlans.find(plan => plan.instrumentId === 'blocked-stock')
    expect(instrument).toMatchObject({
      executable: false,
      finalSuggestedAmount: 0,
    })
    expect(instrument?.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    expect(snapshot?.blockedReasons).not.toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    expect(snapshotExecutability(snapshot)).toBe('CALCULATED_NOT_EXECUTABLE')
    created.controls.dispose()
  })

  it('real mixed JP-stock class retains its allocatable sibling and never synthesizes CLASS_FULL', () => {
    const created = publishWriterOutput(
      cleanState(),
      jpStockAdapter('real-mixed-class', ['blocked-stock', 'allocatable-stock']),
    )
    const snapshot = created.store.getState().allocationPlan
    const classPlan = snapshot?.assetClassPlans.find(plan => plan.assetClass === 'JP_STOCK')
    const blocked = snapshot?.instrumentPlans.find(plan => plan.instrumentId === 'blocked-stock')
    const allocatable = snapshot?.instrumentPlans.find(plan => plan.instrumentId === 'allocatable-stock')
    expect(blocked?.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    expect(allocatable).toMatchObject({ executable: true })
    expect(allocatable?.finalSuggestedAmount).toBeGreaterThan(0)
    expect(classPlan?.blockedReasons).not.toContain('CLASS_FULL')
    expect(snapshot?.blockedReasons).not.toContain('CLASS_FULL')
    expect(snapshotExecutability(snapshot)).toBe('EXECUTABLE')
    created.controls.dispose()
  })

  it.each([
    ['AVAILABLE_BUDGET', 'AVAILABLE_BUDGET', 'CLASS_BUDGET_EXHAUSTED'],
    ['CLASS_HEADROOM', 'CLASS_HEADROOM', 'CLASS_HARD_CAP_REACHED'],
    ['TARGET_GAP', 'TARGET_GAP', 'CLASS_TARGET_REACHED'],
    ['CLASS_TARGET_MISSING', 'TARGET_GAP', 'CLASS_DATA_UNAVAILABLE'],
  ] as const)(
    'real writer output derives genuine CLASS_FULL from %s',
    (cause, limitingFactor, expectedCause) => {
      const fixture = classFullFixture(cause)
      const created = publishWriterOutput(fixture.state, fixture.options)
      const plan = created.store.getState().allocationPlan?.assetClassPlans
        .find(item => item.assetClass === 'JP_TRUST')
      expect(plan?.blockedReasons).toContain('CLASS_FULL')
      expect(plan?.limitingFactors).toContain(limitingFactor)
      if (cause === 'CLASS_TARGET_MISSING') {
        expect(plan?.blockedReasons).toContain('CLASS_TARGET_MISSING')
        expect(plan?.limitingFactors).toContain('CLASS_HEADROOM')
      }
      expect(plan && classFullCause(plan)).toBe(expectedCause)
      created.controls.dispose()
    },
  )

  it('cross-tab invalidation atomically removes the current snapshot until the next canonical writer', () => {
    const invalidation = manualInvalidationTransport()
    const created = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: {
        instanceId: 'local-writer',
        transport: invalidation.transport,
      },
    })
    const first = runFullAnalysis(cleanState(), {
      nowMs: NOW,
      allocationPlanInput: adapter('fresh', 'cross-tab-before'),
    })
    created.store.setState({
      ...first,
      allocationPlanCandidateGenerationId: 'old-candidate-generation',
      candidatePortfolioRecommendations: [{
        candidateRecordId: 'artifact:0', artifactIndex: 0, code: '1001', name: 'old candidate',
        marketRank: 1, action: 'BUY_NEW', reason: 'old projection', allocation: null,
      }],
    })
    const oldId = created.store.getState().allocationPlan?.snapshotId
    expect(oldId).toBeTruthy()
    expect(created.store.getState().allocationPlanStatus).toBe('current')

    const observations: Array<{
      crossTab: string | undefined
      snapshotId: string | null
      status: AppState['allocationPlanStatus']
      executability: ReturnType<typeof selectSnapshotExecutability>
    }> = []
    const unsubscribe = created.store.subscribe(state => observations.push({
      crossTab: state.system.crossTabInvalidation?.status,
      snapshotId: state.allocationPlan?.snapshotId ?? null,
      status: state.allocationPlanStatus,
      executability: selectSnapshotExecutability(state),
    }))

    invalidation.emit()

    expect(observations).toEqual([{
      crossTab: 'stale',
      snapshotId: null,
      status: 'stale',
      executability: 'NOT_CALCULATED',
    }])
    const invalidated = created.store.getState()
    expect(invalidated.allocationPlan).toBeNull()
    expect(invalidated.allocationPlanStatus).toBe('stale')
    expect(invalidated.allocationPlanCandidateGenerationId).toBeNull()
    expect(invalidated.candidatePortfolioRecommendations).toEqual([])
    expect(selectSnapshotExecutability(invalidated)).toBe('NOT_CALCULATED')

    const alignedState: AppState = {
      ...invalidated,
      system: { ...invalidated.system, crossTabInvalidation: undefined },
    }
    const regenerated = runFullAnalysis(alignedState, {
      nowMs: NOW + 1,
      allocationPlanInput: adapter('fresh', 'cross-tab-after'),
    })
    created.store.setState({ ...regenerated, system: alignedState.system })
    const current = created.store.getState()
    expect(current.allocationPlan?.snapshotId).not.toBe(oldId)
    expect(current.allocationPlan?.sourceHoldingsSnapshotId).toBe('cross-tab-after')
    expect(current.allocationPlanStatus).toBe('current')
    expect(selectSnapshotExecutability(current)).toBe('EXECUTABLE')

    unsubscribe()
    created.controls.dispose()
  })

  it('real rejection seam publishes only the accepted generation and cannot revive an older completion', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const created = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
    })
    try {
      const older = calculate('fresh', 'race-older', NOW)
      created.store.setState(older)
      let completeOlder!: (value: typeof older) => void
      const olderCompletion = new Promise<typeof older>(resolve => { completeOlder = resolve })
      const ticket = created.controls.acquirePortfolioOperation('manual')
      expect(ticket).not.toBeNull()

      const observations: Array<string | null> = []
      const unsubscribe = created.store.subscribe(state => {
        observations.push(state.allocationPlan?.snapshotId ?? null)
      })
      const rejected = await created.store.getState().setCashAssumptions({
        cashDeposits: 3_000_000,
        standbyFunds: 500_000,
      })
      expect(rejected).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
      expect(observations).toEqual([])
      expect(created.controls.releasePortfolioOperation(ticket!)).toBe(true)

      const accepted = await created.store.getState().setCashAssumptions({
        cashDeposits: 4_000_000,
        standbyFunds: 500_000,
      })
      expect(accepted).toMatchObject({ ok: true, code: 'SUCCESS' })
      const acceptedId = created.store.getState().allocationPlan?.snapshotId ?? null
      expect(acceptedId).toBeTruthy()
      expect(acceptedId).not.toBe(older.allocationPlan?.snapshotId)
      expect(observations).toEqual([acceptedId])

      completeOlder(older)
      await olderCompletion
      expect(created.store.getState().allocationPlan?.snapshotId).toBe(acceptedId)
      expect(observations).toEqual([acceptedId])
      unsubscribe()
    } finally {
      created.controls.dispose()
      warning.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
