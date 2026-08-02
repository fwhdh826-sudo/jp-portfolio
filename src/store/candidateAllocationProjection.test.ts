import { describe, expect, it } from 'vitest'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import type {
  AllocationPlanInput,
  AllocationPlanSnapshot,
  BlockedReason,
} from '../types/allocationPlan'
import type { CandidatePortfolioRecommendation } from '../types/candidatePortfolioRecommendation'
import { ALLOCATION_PLAN_AUTHORITY_VERSION } from '../types/allocationPlan'
import { projectCandidatePortfolioRecommendations } from './candidatePortfolioRecommendation'

const GENERATION = '2026-08-01T00:00:00.000Z'

function recommendation(code = '1001', artifactIndex = 0): CandidatePortfolioRecommendation {
  return {
    candidateRecordId: `artifact:${artifactIndex}`,
    artifactIndex,
    code,
    name: `candidate-${code}`,
    marketRank: artifactIndex + 1,
    action: 'BUY_NEW',
    reason: 'unchanged recommendation reason',
    allocation: null,
  }
}

function allocationInput(options: {
  ids?: readonly string[]
  executionData?: boolean
  holdings?: AllocationPlanInput['safetyState']['holdings']
  candidateArtifact?: AllocationPlanInput['safetyState']['candidateArtifact']
} = {}): AllocationPlanInput {
  const ids = options.ids ?? ['stock:1001']
  return {
    generatedAt: GENERATION,
    snapshotId: 'snapshot-hr-i3',
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    sourceHoldingsSnapshotId: 'holdings-generation-1',
    sourceSettingsVersion: 'settings-generation-1',
    cash: { grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 0, longTermBudget: 1_000_000 },
    policy: {
      jpStockMaxRatio: 0.8,
      jpStockMaxAmountJpy: null,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [
        { assetClass: 'JP_STOCK', targetRatio: 0.5, maximumRatio: 0.8, maximumAmountJpy: null },
      ],
      instrumentPolicies: ids.map(instrumentId => ({
        instrumentId,
        targetAmountJpy: 500_000,
        maxPositionAmountJpy: 500_000,
        sectorHeadroomJpy: 500_000,
        concentrationHeadroomJpy: 500_000,
        liquidityHeadroomJpy: 500_000,
        defaultMaxPositionShare: 0.5,
        defaultMaxSectorShare: 0.5,
        minimumPurchaseUnitJpy: 10_000,
      })),
      roundingPolicies: [{ kind: 'jp_stock', purchaseUnitJpy: 10_000 }],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION',
      buyNewBaseShare: 0.25,
      buyMoreBaseShare: 0.5,
      confidenceUnknownFactor: 0.5,
      executionPriceBufferRatio: 0.03,
    },
    assetClasses: [
      { assetClass: 'JP_STOCK', currentAmount: 0 },
    ],
    instruments: ids.map(instrumentId => ({
      instrumentId,
      assetClass: 'JP_STOCK',
      kind: 'jp_stock',
      relationship: 'new_to_portfolio',
      currentAmount: 0,
      role: '銀行業',
      reason: 'candidate input',
      priceJpy: options.executionData === false ? null : 1_000,
      lotSizeShares: options.executionData === false ? null : 100,
    })),
    candidates: ids.map((instrumentId, artifactIndex) => ({
      instrumentId,
      buyKind: 'BUY_NEW',
      marketRank: artifactIndex + 1,
      artifactIndex,
      confidence: 1,
    })),
    safetyState: {
      safeMode: 'inactive',
      marketData: 'fresh',
      holdings: options.holdings ?? 'fresh',
      cash: 'known_fresh',
      target: 'known',
      pendingOrders: 'known',
      candidateArtifact: options.candidateArtifact ?? 'fresh',
      dqViolation: false,
      tierA: 'normal',
      crossTab: 'current',
      noTrade: 'normal',
    },
    regime: 'neutral',
    marketMode: 'normal',
  }
}

function project(
  recommendations: readonly CandidatePortfolioRecommendation[],
  snapshot: AllocationPlanSnapshot | null,
  overrides: Partial<Parameters<typeof projectCandidatePortfolioRecommendations>[0]> = {},
) {
  return projectCandidatePortfolioRecommendations({
    recommendations,
    snapshot,
    snapshotStatus: 'current',
    snapshotCandidateGenerationId: GENERATION,
    sourceCandidateGenerationId: GENERATION,
    sourceCandidateFreshness: 'fresh',
    ...overrides,
  })
}

describe('HR-I3 read-only candidate allocation projection', () => {
  it('joins exact identity even when recommendation order differs from plan order', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput({ ids: ['stock:1001', 'stock:1002'] }))
    const result = project([recommendation('1002', 1), recommendation('1001', 0)], snapshot)
    expect(result.map(item => item.allocation?.instrumentId)).toEqual(['stock:1002', 'stock:1001'])
  })

  it('copies every monetary and identity field verbatim from the snapshot', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput())
    const plan = snapshot.instrumentPlans[0]
    const classPlan = snapshot.assetClassPlans.find(item => item.assetClass === plan.assetClass)
    const allocation = project([recommendation()], snapshot)[0].allocation
    expect(allocation).toMatchObject({
      snapshotId: snapshot.snapshotId,
      snapshotGeneratedAt: snapshot.generatedAt,
      snapshotStatus: 'current',
      sourceCandidateGenerationId: GENERATION,
      sourceHoldingsSnapshotId: snapshot.sourceHoldingsSnapshotId,
      sourceSettingsVersion: snapshot.sourceSettingsVersion,
      instrumentId: plan.instrumentId,
      estimatedMaximumAmount: plan.estimatedMaximumAmount,
      finalSuggestedAmount: plan.finalSuggestedAmount,
      executable: plan.executable,
      classHeadroom: plan.classHeadroom,
      instrumentHeadroom: plan.effectiveInstrumentHeadroom,
      remainingHeadroom: classPlan?.remainingHeadroom,
    })
  })

  it('keeps estimated maximum separate from simultaneous final amount', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput({ executionData: false }))
    const allocation = project([recommendation()], snapshot)[0].allocation
    expect(allocation?.estimatedMaximumAmount).toBeGreaterThan(0)
    expect(allocation?.finalSuggestedAmount).toBe(0)
    expect(allocation?.executable).toBe(false)
    expect(allocation?.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
  })

  it('preserves partial estimate-only authority with zero final amount', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput({ holdings: 'partial' }))
    const allocation = project([recommendation()], snapshot, { snapshotStatus: 'estimate_only' })[0].allocation
    expect(allocation?.snapshotStatus).toBe('estimate_only')
    expect(allocation?.estimatedMaximumAmount).toBeGreaterThan(0)
    expect(allocation?.finalSuggestedAmount).toBe(0)
    expect(allocation?.executable).toBe(false)
  })

  it.each(['absent', 'invalid', 'stale'] as const)(
    'returns unavailable for %s snapshot status',
    snapshotStatus => {
      const snapshot = buildAllocationPlanSnapshot(allocationInput())
      expect(project([recommendation()], snapshot, { snapshotStatus })[0].allocation).toBeNull()
    },
  )

  it('returns unavailable for null snapshot and both generation mismatch directions', () => {
    expect(project([recommendation()], null)[0].allocation).toBeNull()
    const snapshot = buildAllocationPlanSnapshot(allocationInput())
    expect(project([recommendation()], snapshot, { snapshotCandidateGenerationId: 'old' })[0].allocation).toBeNull()
    expect(project([recommendation()], snapshot, { sourceCandidateGenerationId: 'new' })[0].allocation).toBeNull()
  })

  it.each([
    ['duplicate plan', (snapshot: AllocationPlanSnapshot) => { snapshot.instrumentPlans.push({ ...snapshot.instrumentPlans[0] }) }],
    ['asset-class mismatch', (snapshot: AllocationPlanSnapshot) => { snapshot.instrumentPlans[0].assetClass = 'JP_TRUST' }],
    ['snapshot calculation mismatch', (snapshot: AllocationPlanSnapshot) => { snapshot.instrumentPlans[0].calculationSnapshotId = 'other' }],
  ] as const)('fails closed for %s', (_name, mutate) => {
    const snapshot = structuredClone(buildAllocationPlanSnapshot(allocationInput()))
    mutate(snapshot)
    expect(project([recommendation()], snapshot)[0].allocation).toBeNull()
  })
  it('S-T23/J1 keeps exact matches when one of three candidate plans is missing', () => {
    const plan = structuredClone(buildAllocationPlanSnapshot(
      allocationInput({ ids: ['stock:1001', 'stock:1002', 'stock:1003'] }),
    ))
    plan.instrumentPlans = plan.instrumentPlans.filter(item => item.instrumentId !== 'stock:1002')
    const result = project([
      recommendation('1001', 0),
      recommendation('1002', 1),
      recommendation('1003', 2),
    ], plan)
    expect(result.map(item => item.allocation?.instrumentId ?? null))
      .toEqual(['stock:1001', null, 'stock:1003'])
  })

  it('S-T24/J1 ignores an extra JP_TRUST plan without disabling JP_STOCK matches', () => {
    const plan = structuredClone(buildAllocationPlanSnapshot(allocationInput()))
    plan.instrumentPlans.push({
      ...plan.instrumentPlans[0],
      instrumentId: 'trust:extra',
      assetClass: 'JP_TRUST',
      kind: 'jp_trust',
    })
    expect(project([recommendation()], plan)[0].allocation?.instrumentId).toBe('stock:1001')
  })

  it('J1 isolates a calculation-generation mismatch to its candidate', () => {
    const plan = structuredClone(buildAllocationPlanSnapshot(
      allocationInput({ ids: ['stock:1001', 'stock:1002'] }),
    ))
    plan.instrumentPlans[1].calculationSnapshotId = 'other-generation'
    const result = project([recommendation('1001', 0), recommendation('1002', 1)], plan)
    expect(result[0].allocation?.instrumentId).toBe('stock:1001')
    expect(result[1].allocation).toBeNull()
  })

  it('fails closed for duplicate, missing, and ambiguous recommendation identity', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput())
    expect(project([recommendation(), recommendation()], snapshot).every(item => item.allocation === null)).toBe(true)
    expect(project([recommendation('')], snapshot)[0].allocation).toBeNull()
    expect(project([recommendation('candidate 1001')], snapshot)[0].allocation).toBeNull()
  })

  it('canonicalizes, deduplicates, and preserves reason categories', () => {
    const snapshot = structuredClone(buildAllocationPlanSnapshot(allocationInput()))
    const plan = snapshot.instrumentPlans[0]
    plan.blockedReasons = ['SAFE_MODE_ACTIVE', 'JP_STOCK_EXECUTION_DATA_UNAVAILABLE', 'SAFE_MODE_ACTIVE']
    plan.warningReasons = ['NOT_SELECTED_FOR_EXECUTION', 'MARKET_CAUTION', 'MARKET_CAUTION']
    plan.limitingFactors = ['LOT_SIZE', 'CLASS_HEADROOM', 'LOT_SIZE']
    const allocation = project([recommendation()], snapshot)[0].allocation
    expect(allocation?.blockedReasons).toEqual(['JP_STOCK_EXECUTION_DATA_UNAVAILABLE', 'SAFE_MODE_ACTIVE'])
    expect(allocation?.warningReasons).toEqual(['MARKET_CAUTION', 'NOT_SELECTED_FOR_EXECUTION'])
    expect(allocation?.limitingFactors).toEqual([
      'CLASS_HEADROOM', 'TARGET_GAP', 'LOT_SIZE', 'JP_STOCK_RATIO_CAP',
    ])
  })

  it('fails closed for unknown reason without manufacturing a replacement', () => {
    const snapshot = structuredClone(buildAllocationPlanSnapshot(allocationInput()))
    snapshot.instrumentPlans[0].blockedReasons = ['UNKNOWN_REASON' as BlockedReason]
    expect(project([recommendation()], snapshot)[0].allocation).toBeNull()
  })

  it('does not promote instrument-only blocked reasons to snapshot scope', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput({ executionData: false }))
    expect(snapshot.blockedReasons).not.toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    const allocation = project([recommendation()], snapshot)[0].allocation
    expect(allocation?.blockedReasons)
      .toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    expect(allocation?.snapshotExecutability).toBe('CALCULATED_NOT_EXECUTABLE')
  })

  it.each([
    ['POLICY_AUTHORITY_UNAVAILABLE', (input: AllocationPlanInput) => {
      input.policy.jpStockMaxRatio = null
      input.policy.jpStockMaxAmountJpy = null
    }],
    ['TARGET_AUTHORITY_UNAVAILABLE', (input: AllocationPlanInput) => {
      input.cash.grossCash = 0
      input.budgets.longTermBudget = 0
      input.policy.jpStockMaxAmountJpy = null
    }],
    ['INVALID_NUMERIC_INPUT', (input: AllocationPlanInput) => {
      input.policy.jpStockMaxRatio = Number.NaN
      input.policy.jpStockMaxAmountJpy = 500_000
    }],
  ] as const)('projects active D1 blocked reason %s through the production engine', (reason, mutate) => {
    const input = allocationInput()
    mutate(input)
    const snapshot = buildAllocationPlanSnapshot(input)
    expect(snapshot.instrumentPlans[0].blockedReasons).toContain(reason)
    expect(project([recommendation()], snapshot)[0].allocation?.blockedReasons).toContain(reason)
  })

  it.each([
    ['JP_STOCK_RATIO_CAP', (input: AllocationPlanInput) => {
      input.policy.jpStockMaxRatio = 0.3
      input.policy.jpStockMaxAmountJpy = 500_000
    }],
    ['JP_STOCK_AMOUNT_CAP', (input: AllocationPlanInput) => {
      input.policy.jpStockMaxRatio = 0.7
      input.policy.jpStockMaxAmountJpy = 250_000
    }],
  ] as const)('projects active D1 class limiting factor %s onto its candidate', (factor, mutate) => {
    const input = allocationInput()
    mutate(input)
    const snapshot = buildAllocationPlanSnapshot(input)
    const classPlan = snapshot.assetClassPlans.find(item => item.assetClass === 'JP_STOCK')
    expect(classPlan?.limitingFactors).toContain(factor)
    expect(project([recommendation()], snapshot)[0].allocation?.limitingFactors).toContain(factor)
  })

  it('keeps reserved reason codes absent from candidate projection', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput())
    const allocation = project([recommendation()], snapshot)[0].allocation
    expect(allocation?.blockedReasons).not.toEqual(expect.arrayContaining([
      'CLASS_CAP_MISSING', 'JP_STOCK_CAP', 'JP_TRUST_TARGET_REACHED',
    ]))
    expect(allocation?.warningReasons).not.toContain('FEE_AUTHORITY_UNAVAILABLE')
    expect(allocation?.limitingFactors).not.toContain('JP_TRUST_REMAINING_TARGET')
  })

  it('keeps multi-candidate simultaneous total within deployable cash', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput({ ids: ['stock:1001', 'stock:1002'] }))
    const result = project([recommendation('1001', 0), recommendation('1002', 1)], snapshot)
    const total = result.reduce((sum, item) => sum + (item.allocation?.finalSuggestedAmount ?? 0), 0)
    expect(total).toBeLessThanOrEqual(snapshot.deployableCash)
    expect(result.map(item => item.allocation?.finalSuggestedAmount))
      .toEqual(snapshot.instrumentPlans.map(item => item.finalSuggestedAmount))
  })

  it('preserves candidate order, rank, score-free semantics, and non-allocation fingerprint', () => {
    const recommendations = [recommendation('1001', 0), recommendation('1002', 1)]
    const before = recommendations.map(({ allocation: _allocation, ...item }) => item)
    const snapshot = buildAllocationPlanSnapshot(allocationInput({ ids: ['stock:1001', 'stock:1002'] }))
    const result = project(recommendations, snapshot)
    expect(result.map(({ allocation: _allocation, ...item }) => item)).toEqual(before)
    expect(result.map(item => item.marketRank)).toEqual([1, 2])
  })

  it('does not expose projection when no candidates exist', () => {
    const snapshot = buildAllocationPlanSnapshot(allocationInput({ ids: [] }))
    expect(project([], snapshot)).toEqual([])
  })
})
