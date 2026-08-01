import { describe, expect, it } from 'vitest'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type AllocationPlanInput,
  type CandidateInput,
  type InstrumentInput,
  type InstrumentPolicy,
} from '../../types/allocationPlan'
import { buildAllocationPlanSnapshot, summarizeJpTrust } from './allocationEngine'
import { assertAllocationPlanInvariants } from './invariants'

function instrument(
  instrumentId: string,
  kind: InstrumentInput['kind'],
  assetClass: InstrumentInput['assetClass'],
  overrides: Partial<InstrumentInput> = {},
): InstrumentInput {
  return {
    instrumentId,
    kind,
    assetClass,
    relationship: 'new_to_portfolio',
    currentAmount: 0,
    role: null,
    reason: 'test fixture',
    priceJpy: null,
    lotSizeShares: null,
    ...overrides,
  }
}

function instrumentPolicy(
  instrumentId: string,
  overrides: Partial<InstrumentPolicy> = {},
): InstrumentPolicy {
  return {
    instrumentId,
    targetAmountJpy: 500_000,
    maxPositionAmountJpy: 500_000,
    sectorHeadroomJpy: 500_000,
    concentrationHeadroomJpy: 500_000,
    liquidityHeadroomJpy: 500_000,
    defaultMaxPositionShare: 0.25,
    defaultMaxSectorShare: 0.35,
    minimumPurchaseUnitJpy: 10_000,
    ...overrides,
  }
}

function candidate(
  instrumentId: string,
  marketRank: number | null,
  artifactIndex: number,
  overrides: Partial<CandidateInput> = {},
): CandidateInput {
  return {
    instrumentId,
    marketRank,
    artifactIndex,
    buyKind: 'BUY_NEW',
    confidence: 1,
    ...overrides,
  }
}

function makeInput(overrides: Partial<AllocationPlanInput> = {}): AllocationPlanInput {
  const base: AllocationPlanInput = {
    generatedAt: '2026-08-01T00:00:00.000Z',
    snapshotId: 'allocation-snapshot-1',
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    sourceHoldingsSnapshotId: 'holdings-snapshot-1',
    sourceSettingsVersion: 'settings-version-1',
    cash: {
      grossCash: 1_000_000,
      safetyReserve: 100_000,
      pendingOrderCash: 50_000,
      dataUncertaintyReserve: 0,
    },
    budgets: { shortTermBudget: 300_000, longTermBudget: 550_000 },
    policy: {
      jpStockMaxRatio: 0.4,
      jpStockMaxAmountJpy: 700_000,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [
        { assetClass: 'JP_STOCK', targetRatio: 0.3, maximumRatio: null, maximumAmountJpy: null },
        { assetClass: 'JP_TRUST', targetRatio: 0.3, maximumRatio: 0.4, maximumAmountJpy: null },
        { assetClass: 'OVERSEAS_TRUST', targetRatio: 0.3, maximumRatio: 0.4, maximumAmountJpy: null },
        { assetClass: 'GOLD', targetRatio: 0.1, maximumRatio: 0.15, maximumAmountJpy: null },
      ],
      instrumentPolicies: [
        instrumentPolicy('trust-1'),
        instrumentPolicy('trust-2'),
        instrumentPolicy('stock-1'),
        instrumentPolicy('global-1'),
      ],
      roundingPolicies: [
        { kind: 'jp_stock', purchaseUnitJpy: 10_000 },
        { kind: 'jp_trust', purchaseUnitJpy: 10_000 },
        { kind: 'global_trust', purchaseUnitJpy: 10_000 },
        { kind: 'gold', purchaseUnitJpy: 10_000 },
      ],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION',
      buyNewBaseShare: 0.25,
      buyMoreBaseShare: 0.5,
      confidenceUnknownFactor: 0.5,
      executionPriceBufferRatio: 0.03,
    },
    assetClasses: [
      { assetClass: 'JP_STOCK', currentAmount: 150_000 },
      { assetClass: 'JP_TRUST', currentAmount: 100_000 },
      { assetClass: 'OVERSEAS_TRUST', currentAmount: 250_000 },
      { assetClass: 'GOLD', currentAmount: 0 },
    ],
    instruments: [
      instrument('trust-1', 'jp_trust', 'JP_TRUST', { role: 'CORE' }),
      instrument('trust-2', 'jp_trust', 'JP_TRUST', { role: 'SATELLITE' }),
      instrument('stock-1', 'jp_stock', 'JP_STOCK'),
      instrument('global-1', 'global_trust', 'OVERSEAS_TRUST'),
    ],
    candidates: [
      candidate('trust-1', 1, 0),
      candidate('stock-1', 2, 1),
      candidate('global-1', 3, 2),
    ],
    safetyState: {
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
    },
    regime: 'neutral',
    marketMode: 'normal',
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

describe('AllocationPlanSnapshot', () => {
  it('builds one authoritative, local-only, non-persistent snapshot', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput())
    expect(snapshot.snapshotId).toBe('allocation-snapshot-1')
    expect(snapshot.persistence).toBe('none')
    expect(snapshot.privacyMode).toBe('local_only')
    expect(snapshot.not_for_trading).toBe(true)
    expect(snapshot.instrumentPlans.every(
      ({ calculationSnapshotId }) => calculationSnapshotId === snapshot.snapshotId,
    )).toBe(true)
  })

  it('computes deployable cash with pending reserve and separates budgets', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput())
    expect(snapshot.deployableCash).toBe(850_000)
    expect(snapshot.shortTermBudget).toBe(300_000)
    expect(snapshot.longTermBudget).toBe(550_000)
    expect(snapshot.shortTermBudget + snapshot.longTermBudget).toBe(snapshot.deployableCash)
  })

  it('computes total assets from holdings/trust values plus gross cash without addRoom', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput())
    expect(snapshot.totalAssets).toBe(1_500_000)
  })

  it('does not hardcode 10% or 8,000,000 in domestic-stock cap', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      policy: { ...makeInput().policy, jpStockMaxRatio: 0.4, jpStockMaxAmountJpy: 700_000 },
    }))
    const stock = snapshot.assetClassPlans.find(({ assetClass }) => assetClass === 'JP_STOCK')
    expect(stock?.maximumAmount).toBe(600_000)
    expect(stock?.hardHeadroom).toBe(450_000)
  })

  it('min_with_regime applies the smaller resolved regime ratio', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      policy: { ...makeInput().policy, jpStockMaxRatio: 0.4, jpStockCapRegimeMode: 'min_with_regime' },
    }))
    const stock = snapshot.assetClassPlans.find(({ assetClass }) => assetClass === 'JP_STOCK')
    expect(stock?.maximumAmount).toBe(450_000)
  })

  it('zero candidates leaves all deployable cash unallocated', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({ candidates: [] }))
    expect(snapshot.instrumentPlans).toEqual([])
    expect(snapshot.remainingUnallocatedCash).toBe(snapshot.deployableCash)
  })

  it('one candidate allocates once and is the sole executable proposal', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      candidates: [candidate('trust-1', 1, 0)],
    }))
    expect(snapshot.instrumentPlans).toHaveLength(1)
    expect(snapshot.instrumentPlans[0].simultaneouslyExecutableAmount).toBeGreaterThan(0)
    expect(snapshot.instrumentPlans[0].executable).toBe(true)
    expect(snapshot.remainingUnallocatedCash).toBe(
      snapshot.deployableCash - snapshot.instrumentPlans[0].allocatedAmount,
    )
  })

  it('multiple candidates distinguish independent maximum from simultaneous allocation', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput())
    for (const plan of snapshot.instrumentPlans) {
      expect(plan).toHaveProperty('independentMaximum')
      expect(plan).toHaveProperty('simultaneouslyExecutableAmount')
    }
    expect(snapshot.instrumentPlans.filter(({ executable }) => executable)).toHaveLength(1)
    expect(snapshot.instrumentPlans.find(({ instrumentId }) => instrumentId === 'stock-1')
      ?.simultaneouslyExecutableAmount).toBe(0)
  })

  it('never double-spends cash across candidates (HR-M-06)', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      candidates: [
        candidate('trust-1', 1, 0),
        candidate('trust-2', 2, 1),
        candidate('global-1', 3, 2),
      ],
    }))
    const allocated = snapshot.instrumentPlans.reduce((sum, plan) => sum + plan.allocatedAmount, 0)
    expect(allocated).toBeLessThanOrEqual(snapshot.deployableCash)
    expect(snapshot.remainingUnallocatedCash).toBe(snapshot.deployableCash - allocated)
    expect(snapshot.instrumentPlans.every(
      ({ allocatedAmount }) => allocatedAmount < snapshot.deployableCash,
    )).toBe(true)
  })

  it('insufficient shared budget is consumed once across equal-class candidates', () => {
    const base = makeInput()
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      cash: { grossCash: 100_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
      budgets: { shortTermBudget: 100_000, longTermBudget: 0 },
      policy: { ...base.policy, buyNewBaseShare: 1 },
      assetClasses: base.assetClasses.map((item) => item.assetClass === 'JP_TRUST'
        ? { ...item, currentAmount: 0 }
        : item),
      candidates: [candidate('trust-1', 1, 0), candidate('trust-2', 2, 1)],
    }))
    const amounts = snapshot.instrumentPlans.map(({ allocatedAmount }) => allocatedAmount)
    expect(amounts).toEqual([100_000, 0])
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(100_000)
  })

  it('blocked candidates reserve no cash and leave the estimate distinguishable', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      candidates: [candidate('stock-1', 1, 0)],
    }))
    const stock = snapshot.instrumentPlans[0]
    expect(stock.independentMaximum).toBeGreaterThan(0)
    expect(stock.allocatedAmount).toBe(0)
    expect(stock.finalSuggestedAmount).toBe(0)
    expect(stock.executable).toBe(false)
    expect(snapshot.remainingUnallocatedCash).toBe(snapshot.deployableCash)
  })

  it('is deterministic for identical injected input', () => {
    const input = makeInput()
    expect(buildAllocationPlanSnapshot(input)).toEqual(buildAllocationPlanSnapshot(input))
    expect(JSON.stringify(buildAllocationPlanSnapshot(input))).toBe(
      JSON.stringify(buildAllocationPlanSnapshot(input)),
    )
  })

  it('equal rank is deterministically ordered by artifact index then id', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      candidates: [
        candidate('trust-2', 1, 2),
        candidate('trust-1', 1, 1),
      ],
    }))
    expect(snapshot.instrumentPlans.map(({ instrumentId }) => instrumentId)).toEqual([
      'trust-1',
      'trust-2',
    ])
  })

  it('explicit rank order is intentionally allocation-dependent', () => {
    const first = buildAllocationPlanSnapshot(makeInput({
      budgets: { shortTermBudget: 50_000, longTermBudget: 800_000 },
      policy: { ...makeInput().policy, buyNewBaseShare: 1 },
      candidates: [candidate('trust-1', 1, 0), candidate('trust-2', 2, 1)],
    }))
    const second = buildAllocationPlanSnapshot(makeInput({
      budgets: { shortTermBudget: 50_000, longTermBudget: 800_000 },
      policy: { ...makeInput().policy, buyNewBaseShare: 1 },
      candidates: [candidate('trust-1', 2, 0), candidate('trust-2', 1, 1)],
    }))
    expect(first.instrumentPlans.find(({ instrumentId }) => instrumentId === 'trust-1')
      ?.allocatedAmount).toBeGreaterThan(0)
    expect(second.instrumentPlans.find(({ instrumentId }) => instrumentId === 'trust-1')
      ?.allocatedAmount).toBe(0)
  })
})

describe('JP_TRUST contract', () => {
  it('exposes target, current, remaining target, class headroom, and proposed amount', () => {
    const summary = summarizeJpTrust(buildAllocationPlanSnapshot(makeInput()))
    expect(summary.jpTrustTargetAmount).toBe(450_000)
    expect(summary.jpTrustCurrentAmount).toBe(100_000)
    expect(summary.jpTrustRemainingTarget).toBe(350_000)
    expect(summary.jpTrustClassHeadroom).toBe(300_000)
    expect(summary.jpTrustProposedAmount).toBeLessThanOrEqual(summary.jpTrustRemainingTarget)
    expect(summary.jpTrustProposedAmount).toBeLessThanOrEqual(summary.jpTrustClassHeadroom)
    expect(summary.jpTrustProposedAmount).toBeLessThanOrEqual(summary.availableShortTermBudget)
  })

  it('target reached or exceeded produces zero JP_TRUST allocation', () => {
    for (const currentAmount of [600_000, 700_000]) {
      const input = makeInput({
        assetClasses: [
          { assetClass: 'JP_STOCK', currentAmount: 150_000 },
          { assetClass: 'JP_TRUST', currentAmount },
          { assetClass: 'OVERSEAS_TRUST', currentAmount: 250_000 },
          { assetClass: 'GOLD', currentAmount: 0 },
        ],
        candidates: [candidate('trust-1', 1, 0)],
      })
      const summary = summarizeJpTrust(buildAllocationPlanSnapshot(input))
      expect(summary.jpTrustProposedAmount).toBe(0)
    }
  })

  it('short-term budget binds JP_TRUST and stock residual never flows into it (HR-M-04)', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      budgets: { shortTermBudget: 20_000, longTermBudget: 830_000 },
      candidates: [candidate('trust-1', 1, 0), candidate('stock-1', 2, 1)],
    }))
    const summary = summarizeJpTrust(snapshot)
    expect(summary.jpTrustProposedAmount).toBeLessThanOrEqual(20_000)
    expect(summary.jpTrustProposedAmount).not.toBeGreaterThan(summary.availableShortTermBudget)
  })

  it('rounding does not exceed a small remaining target', () => {
    const base = makeInput()
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      assetClasses: base.assetClasses.map((item) => item.assetClass === 'JP_TRUST'
        ? { ...item, currentAmount: 585_715 }
        : item),
      candidates: [candidate('trust-1', 1, 0)],
    }))
    const summary = summarizeJpTrust(snapshot)
    expect(summary.jpTrustProposedAmount).toBe(0)
    expect(summary.jpTrustProposedAmount).toBeLessThanOrEqual(summary.jpTrustRemainingTarget)
  })
})

describe('invariant property loops', () => {
  it('allocation sums and every hard cap hold over boundary grids', () => {
    for (const grossCash of [0, 10_000, 50_000, 100_000, 1_000_000, 5_000_000]) {
      for (const shortTermBudget of [0, 10_000, 100_000, 1_000_000]) {
        const snapshot = buildAllocationPlanSnapshot(makeInput({
          cash: {
            grossCash,
            safetyReserve: 0,
            pendingOrderCash: 0,
            dataUncertaintyReserve: 0,
          },
          budgets: { shortTermBudget, longTermBudget: grossCash },
          candidates: [
            candidate('trust-1', 1, 0),
            candidate('trust-2', 2, 1),
            candidate('global-1', 3, 2),
          ],
        }))
        expect(assertAllocationPlanInvariants(snapshot)).toEqual({ ok: true, violated: [] })
      }
    }
  })

  it('missing values never produce an unlimited executable amount', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput({
      policy: { ...makeInput().policy, instrumentPolicies: [] },
    }))
    expect(snapshot.instrumentPlans.every(({ executable }) => executable === false)).toBe(true)
    expect(snapshot.instrumentPlans.every(
      ({ effectiveInstrumentHeadroom }) => Number.isFinite(effectiveInstrumentHeadroom),
    )).toBe(true)
  })
})

describe('frozen invariants I-01 through I-18', () => {
  const invariants = [
    ['I-01 final amount is non-negative', 'I-01'],
    ['I-02 final amount does not exceed deployable cash', 'I-02'],
    ['I-03 final amount does not exceed class headroom', 'I-03'],
    ['I-04 final amount does not exceed instrument headroom', 'I-04'],
    ['I-05 JP_TRUST does not exceed remaining target', 'I-05'],
    ['I-06 simultaneous allocations do not exceed budget', 'I-06'],
    ['I-07 domestic-stock post-purchase total does not exceed configured cap', 'I-07'],
    ['I-08 rounded amount does not exceed pre-round cap', 'I-08'],
    ['I-09 one allocation snapshot is authoritative', 'I-09'],
    ['I-10 unsafe or stale state cannot emit executable BUY_NEW', 'I-10'],
    ['I-11 missing authority is not silently unlimited', 'I-11'],
    ['I-12 at most one plan is executable', 'I-12'],
    ['I-13 every monetary field is finite non-negative integer JPY', 'I-13'],
    ['I-14 class allocation sum does not exceed class headroom', 'I-14'],
    ['I-15 remaining cash equals deployable minus allocations', 'I-15'],
    ['I-16 short and long budgets partition deployable cash', 'I-16'],
    ['I-17 injected identical identity produces deterministic snapshot', 'I-17'],
    ['I-18 allocation snapshot remains local-only and non-persistent', 'I-18'],
  ] as const

  it.each(invariants)('%s', (_name, invariant) => {
    const snapshot = buildAllocationPlanSnapshot(makeInput())
    expect(assertAllocationPlanInvariants(snapshot).violated).not.toContain(invariant)
  })

  it('reports concrete violations instead of silently accepting a corrupt snapshot', () => {
    const snapshot = buildAllocationPlanSnapshot(makeInput())
    const corrupt = {
      ...snapshot,
      remainingUnallocatedCash: snapshot.deployableCash + 1,
    }
    expect(assertAllocationPlanInvariants(corrupt).violated).toContain('I-15')
  })
})
