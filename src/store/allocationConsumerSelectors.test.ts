import { describe, expect, it } from 'vitest'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import type { AppState, AllocationPlanSnapshotState } from '../types'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type AllocationPlanInput,
  type AllocationPlanSnapshot,
  type AssetClass,
} from '../types/allocationPlan'
import type { CandidatePortfolioRecommendation } from '../types/candidatePortfolioRecommendation'
import {
  selectAllocationClassProjection,
  selectAllocationConsumerSnapshot,
  selectAllocationInstrumentProjections,
} from './allocationConsumerSelectors'
import { projectCandidatePortfolioRecommendations } from './candidatePortfolioRecommendation'

const GENERATED_AT = '2026-08-02T00:00:00.000Z'
const CANDIDATE_GENERATION = 'candidate-generation-r3-a1'

function input(holdings: AllocationPlanInput['safetyState']['holdings'] = 'fresh'): AllocationPlanInput {
  const instrumentIds = ['stock:1001', 'stock:1002', 'trust:domestic-1'] as const
  return {
    generatedAt: GENERATED_AT,
    snapshotId: 'snapshot-r3-a1',
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    sourceHoldingsSnapshotId: 'holdings-r3-a1',
    sourceSettingsVersion: 'settings-r3-a1',
    cash: {
      grossCash: 2_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      dataUncertaintyReserve: 0,
    },
    budgets: { shortTermBudget: 800_000, longTermBudget: 1_200_000 },
    policy: {
      jpStockMaxRatio: 0.8,
      jpStockMaxAmountJpy: null,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [
        { assetClass: 'JP_STOCK', targetRatio: 0.5, maximumRatio: 0.8, maximumAmountJpy: null },
        { assetClass: 'JP_TRUST', targetRatio: 0.4, maximumRatio: null, maximumAmountJpy: null },
      ],
      instrumentPolicies: instrumentIds.map(instrumentId => ({
        instrumentId,
        targetAmountJpy: null,
        maxPositionAmountJpy: 1_000_000,
        sectorHeadroomJpy: 1_000_000,
        concentrationHeadroomJpy: 1_000_000,
        liquidityHeadroomJpy: 1_000_000,
        defaultMaxPositionShare: 0.5,
        defaultMaxSectorShare: 0.5,
        minimumPurchaseUnitJpy: 10_000,
      })),
      roundingPolicies: [
        { kind: 'jp_stock', purchaseUnitJpy: 10_000 },
        { kind: 'jp_trust', purchaseUnitJpy: 10_000 },
      ],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION',
      buyNewBaseShare: 1,
      buyMoreBaseShare: 1,
      confidenceUnknownFactor: 0.5,
      executionPriceBufferRatio: 0.03,
    },
    assetClasses: [
      { assetClass: 'JP_STOCK', currentAmount: 0 },
      { assetClass: 'JP_TRUST', currentAmount: 0 },
    ],
    instruments: instrumentIds.map(instrumentId => ({
      instrumentId,
      assetClass: instrumentId.startsWith('stock:') ? 'JP_STOCK' as const : 'JP_TRUST' as const,
      kind: instrumentId.startsWith('stock:') ? 'jp_stock' as const : 'jp_trust' as const,
      relationship: 'new_to_portfolio' as const,
      currentAmount: 0,
      role: null,
      reason: 'R3-a1 fixture',
      priceJpy: instrumentId.startsWith('stock:') ? 1_000 : null,
      lotSizeShares: instrumentId.startsWith('stock:') ? 100 : null,
    })),
    candidates: instrumentIds.map((instrumentId, artifactIndex) => ({
      instrumentId,
      buyKind: 'BUY_NEW',
      marketRank: artifactIndex + 1,
      artifactIndex,
      confidence: 1,
    })),
    safetyState: {
      safeMode: 'inactive',
      marketData: 'fresh',
      holdings,
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
}

function snapshot(holdings: AllocationPlanInput['safetyState']['holdings'] = 'fresh') {
  return buildAllocationPlanSnapshot(input(holdings))
}

function state(
  allocationPlan: AllocationPlanSnapshot | null,
  allocationPlanStatus: AllocationPlanSnapshotState = 'current',
  allocationPlanCandidateGenerationId: string | null = CANDIDATE_GENERATION,
): AppState {
  return {
    allocationPlan,
    allocationPlanStatus,
    allocationPlanCandidateGenerationId,
  } as unknown as AppState
}

function available(value: ReturnType<typeof selectAllocationConsumerSnapshot>) {
  expect(value.availability).toBe('available')
  if (value.availability !== 'available') throw new Error('expected available projection')
  return value
}

function recommendation(code = '1001'): CandidatePortfolioRecommendation {
  return {
    candidateRecordId: 'artifact:0',
    artifactIndex: 0,
    code,
    name: 'display code remains raw',
    marketRank: 1,
    action: 'BUY_NEW',
    reason: 'unchanged',
    allocation: null,
  }
}

function candidateProjection(plan: AllocationPlanSnapshot) {
  return projectCandidatePortfolioRecommendations({
    recommendations: [recommendation()],
    snapshot: plan,
    snapshotStatus: 'current',
    snapshotCandidateGenerationId: CANDIDATE_GENERATION,
    sourceCandidateGenerationId: CANDIDATE_GENERATION,
    sourceCandidateFreshness: 'fresh',
  })
}

function assertE01(plan: AllocationPlanSnapshot) {
  for (const classPlan of plan.assetClassPlans) {
    const total = plan.instrumentPlans
      .filter(item => item.assetClass === classPlan.assetClass)
      .reduce((sum, item) => sum + item.allocatedAmount, 0)
    expect(total).toBe(classPlan.allocatedAmount)
  }
}

describe('R3-a1 shared AllocationPlanSnapshot consumer contract', () => {
  it('S-T01/current projects all generation identities from one snapshot', () => {
    const plan = snapshot()
    const result = available(selectAllocationConsumerSnapshot(state(plan)))
    expect(result.generation).toEqual({
      snapshotId: plan.snapshotId,
      generatedAt: plan.generatedAt,
      sourceHoldingsSnapshotId: plan.sourceHoldingsSnapshotId,
      sourceSettingsVersion: plan.sourceSettingsVersion,
      sourceCandidateGenerationId: CANDIDATE_GENERATION,
    })
    expect(result.status).toBe('current')
  })

  it('projects the exact class contract and returns null for a missing class', () => {
    const plan = snapshot()
    const projected = selectAllocationClassProjection('JP_TRUST')(state(plan))
    expect(projected?.assetClass).toBe('JP_TRUST')
    expect(projected?.instrumentPlanCount).toBe(1)
    expect(selectAllocationClassProjection('GOLD')(state(plan))).toBeNull()
  })

  it('projects instrument order, stable references, and a shared frozen empty list', () => {
    const source = state(snapshot())
    const selectStock = selectAllocationInstrumentProjections('JP_STOCK')
    const first = selectStock(source)
    expect(first?.map(item => item.instrumentId)).toEqual(['stock:1001', 'stock:1002'])
    expect(selectStock(source)).toBe(first)
    const emptyA = selectAllocationInstrumentProjections('GOLD')(source)
    const emptyB = selectAllocationInstrumentProjections('GOLD')(state(snapshot()))
    expect(emptyA).toEqual([])
    expect(emptyB).toBe(emptyA)
  })

  it('S-T02/E-01 uses allocatedAmount for every class, never finalSuggestedAmount', () => {
    const plan = snapshot()
    assertE01(plan)
    expect(plan.assetClassPlans.find(item => item.assetClass === 'JP_STOCK'))
      .not.toHaveProperty('finalSuggestedAmount')
  })

  it('S-T03/E-02..E-04 preserves remaining and all class headroom bounds', () => {
    const plan = snapshot()
    for (const item of plan.assetClassPlans) {
      expect(item.remainingHeadroom).toBe(Math.max(0, item.effectiveHeadroom - item.allocatedAmount))
      expect(item.allocatedAmount).toBeLessThanOrEqual(item.effectiveHeadroom)
      const expected = item.blockedReasons.length > 0
        ? 0
        : Math.min(item.softHeadroom, item.hardHeadroom, item.availableBudget)
      expect(item.effectiveHeadroom).toBe(expected)
    }
  })

  it('S-T04/E-05..E-06 preserves short-term and deployable cash bounds', () => {
    const plan = snapshot()
    const trust = plan.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')!
    expect(trust.availableBudget).toBeLessThanOrEqual(plan.shortTermBudget)
    expect(plan.assetClassPlans.reduce((sum, item) => sum + item.allocatedAmount, 0))
      .toBeLessThanOrEqual(plan.deployableCash)
  })

  it('S-T05/E-07..E-09 preserves single execution and executable implication', () => {
    const plans = snapshot().instrumentPlans
    expect(plans.filter(item => item.finalSuggestedAmount > 0).length).toBeLessThanOrEqual(1)
    for (const item of plans) {
      expect(item.finalSuggestedAmount).toBeLessThanOrEqual(item.allocatedAmount)
      if (item.finalSuggestedAmount > 0) expect(item.executable).toBe(true)
    }
  })

  it('S-T06/E-10 accepts non-additive estimated maxima', () => {
    const plan = snapshot()
    const projected = available(selectAllocationConsumerSnapshot(state(plan)))
    const stock = projected.classes.find(item => item.assetClass === 'JP_STOCK')!
    const estimates = projected.instruments
      .filter(item => item.assetClass === 'JP_STOCK')
      .reduce((sum, item) => sum + item.estimatedMaximumAmount, 0)
    expect(estimates).toBeGreaterThan(stock.effectiveHeadroom)
  })

  it('S-T07/S-T08 copies every monetary field verbatim without recomputation or rounding', () => {
    const plan = snapshot()
    const projected = available(selectAllocationConsumerSnapshot(state(plan)))
    for (const item of projected.classes) {
      const source = plan.assetClassPlans.find(planItem => planItem.assetClass === item.assetClass)!
      expect(item).toMatchObject({
        currentAmount: source.currentAmount,
        targetAmount: source.targetAmount,
        targetRatio: source.targetRatio,
        targetGap: source.targetGap,
        overweightAmount: source.overweightAmount,
        maximumAmount: source.maximumAmount,
        hardHeadroom: source.hardHeadroom,
        softHeadroom: source.softHeadroom,
        effectiveHeadroom: source.effectiveHeadroom,
        availableBudget: source.availableBudget,
        allocatedAmount: source.allocatedAmount,
        remainingHeadroom: source.remainingHeadroom,
      })
    }
    for (const item of projected.instruments) {
      const source = plan.instrumentPlans.find(planItem => planItem.instrumentId === item.instrumentId)!
      expect(item).toMatchObject({
        currentAmount: source.currentAmount,
        instrumentTargetGap: source.instrumentTargetGap,
        classHeadroom: source.classHeadroom,
        effectiveInstrumentHeadroom: source.effectiveInstrumentHeadroom,
        estimatedMaximumAmount: source.estimatedMaximumAmount,
        independentMaximum: source.independentMaximum,
        simultaneouslyExecutableAmount: source.simultaneouslyExecutableAmount,
        allocatedAmount: source.allocatedAmount,
        finalSuggestedAmount: source.finalSuggestedAmount,
      })
    }
  })
  it('mutation sentinels prove selectors never derive monetary authority', () => {
    const plan = structuredClone(snapshot())
    const classPlan = plan.assetClassPlans[0]
    classPlan.currentAmount = 900_000
    classPlan.targetAmount = 100_000
    classPlan.targetGap = 17
    classPlan.allocatedAmount = 111_111
    classPlan.remainingHeadroom = 76_543
    const instrumentPlan = plan.instrumentPlans[0]
    instrumentPlan.allocatedAmount = 123_457
    instrumentPlan.finalSuggestedAmount = 23_457
    const projected = available(selectAllocationConsumerSnapshot(state(plan)))
    expect(projected.classes[0]).toMatchObject({
      currentAmount: 900_000,
      targetAmount: 100_000,
      targetGap: 17,
      allocatedAmount: 111_111,
      remainingHeadroom: 76_543,
    })
    expect(projected.instruments[0]).toMatchObject({
      allocatedAmount: 123_457,
      finalSuggestedAmount: 23_457,
    })
  })

  it('does not mutate the AllocationPlanSnapshot source object', () => {
    const plan = snapshot()
    const before = JSON.stringify(plan)
    selectAllocationConsumerSnapshot(state(plan))
    expect(JSON.stringify(plan)).toBe(before)
  })

  it.each([
    ['snapshot blocked', (value: AllocationPlanSnapshot) => { value.blockedReasons = ['UNKNOWN' as never] }],
    ['snapshot warning', (value: AllocationPlanSnapshot) => { value.warnings = ['UNKNOWN' as never] }],
    ['class blocked', (value: AllocationPlanSnapshot) => { value.assetClassPlans[0].blockedReasons = ['UNKNOWN' as never] }],
    ['class warning', (value: AllocationPlanSnapshot) => { value.assetClassPlans[0].warningReasons = ['UNKNOWN' as never] }],
    ['class limiting', (value: AllocationPlanSnapshot) => { value.assetClassPlans[0].limitingFactors = ['UNKNOWN' as never] }],
    ['instrument blocked', (value: AllocationPlanSnapshot) => { value.instrumentPlans[0].blockedReasons = ['UNKNOWN' as never] }],
    ['instrument warning', (value: AllocationPlanSnapshot) => { value.instrumentPlans[0].warningReasons = ['UNKNOWN' as never] }],
    ['instrument limiting', (value: AllocationPlanSnapshot) => { value.instrumentPlans[0].limitingFactors = ['UNKNOWN' as never] }],
  ] as const)('S-T09 unknown reason fails closed for %s', (_name, mutate) => {
    const plan = structuredClone(snapshot())
    mutate(plan)
    expect(selectAllocationConsumerSnapshot(state(plan))).toMatchObject({
      availability: 'unavailable',
      reasonKind: 'UNKNOWN_REASON_CODE',
    })
  })

  it('S-T10 estimate_only retains estimates while execution values stay zero', () => {
    const plan = snapshot('partial')
    const projected = available(selectAllocationConsumerSnapshot(state(plan, 'estimate_only')))
    expect(projected.status).toBe('estimate_only')
    expect(projected.instruments.some(item => item.estimatedMaximumAmount > 0)).toBe(true)
    expect(projected.instruments.every(item =>
      item.allocatedAmount === 0 &&
      item.finalSuggestedAmount === 0 &&
      item.simultaneouslyExecutableAmount === 0 &&
      item.executable === false &&
      item.warningReasons.includes('ESTIMATE_ONLY'),
    )).toBe(true)
  })

  it('blocked state remains available but never derives executability from reason length', () => {
    const plan = structuredClone(snapshot())
    plan.instrumentPlans.forEach(item => {
      item.executable = false
      item.finalSuggestedAmount = 0
    })
    const projected = available(selectAllocationConsumerSnapshot(state(plan, 'blocked')))
    expect(projected.status).toBe('blocked')
    expect(projected.instruments.every(item => item.executable === false)).toBe(true)
  })

  it('S-T11 stale is unavailable and has no amount-bearing union fields', () => {
    const result = selectAllocationConsumerSnapshot(state(snapshot(), 'stale'))
    expect(result).toEqual({ availability: 'unavailable', status: 'stale', reasonKind: 'INVALIDATED' })
    if (result.availability === 'unavailable') {
      // @ts-expect-error unavailable projections cannot expose stale classes.
      expect(result.classes).toBeUndefined()
    }
  })

  it.each([
    ['absent', 'NOT_CALCULATED'],
    ['invalid', 'INVALIDATED'],
    ['stale', 'INVALIDATED'],
  ] as const)('S-T12 null %s returns the frozen unavailable contract', (status, reasonKind) => {
    const first = selectAllocationConsumerSnapshot(state(null, status))
    const second = selectAllocationConsumerSnapshot(state(null, status))
    expect(first).toEqual({ availability: 'unavailable', status, reasonKind })
    expect(second).toBe(first)
  })

  it('S-T15 memoizes by snapshot object plus status and generation identity', () => {
    const plan = snapshot()
    const firstState = state(plan)
    const first = selectAllocationConsumerSnapshot(firstState)
    expect(selectAllocationConsumerSnapshot(firstState)).toBe(first)
    expect(selectAllocationConsumerSnapshot(state(structuredClone(plan)))).not.toBe(first)
    expect(selectAllocationConsumerSnapshot(state(plan, 'estimate_only'))).not.toBe(first)
    expect(selectAllocationConsumerSnapshot(state(plan, 'current', 'other-generation'))).not.toBe(first)
  })

  it('S-T16 canonicalizes and deduplicates all reason categories', () => {
    const plan = structuredClone(snapshot())
    plan.blockedReasons = ['SAFE_MODE_ACTIVE', 'INVALID_NUMERIC_INPUT', 'SAFE_MODE_ACTIVE']
    plan.warnings = ['ESTIMATE_ONLY', 'MARKET_CAUTION', 'ESTIMATE_ONLY']
    plan.assetClassPlans[0].limitingFactors = ['LOT_SIZE', 'CLASS_HEADROOM', 'LOT_SIZE']
    const projected = available(selectAllocationConsumerSnapshot(state(plan)))
    expect(projected.blockedReasons).toEqual(['INVALID_NUMERIC_INPUT', 'SAFE_MODE_ACTIVE'])
    expect(projected.warnings).toEqual(['MARKET_CAUTION', 'ESTIMATE_ONLY'])
    expect(projected.classes[0].limitingFactors).toEqual(['CLASS_HEADROOM', 'LOT_SIZE'])
  })

  it('S-T17 never generates reserved reasons', () => {
    const serialized = JSON.stringify(selectAllocationConsumerSnapshot(state(snapshot())))
    expect(serialized).not.toContain('CLASS_CAP_MISSING')
    expect(serialized).not.toContain('JP_STOCK_CAP')
    expect(serialized).not.toContain('JP_TRUST_TARGET_REACHED')
    expect(serialized).not.toContain('JP_TRUST_REMAINING_TARGET')
  })

  it.each([
    ['negative', -1],
    ['fraction', 0.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('S-T18 invalid integer boundary %s fails closed', (_name, invalid) => {
    const plan = structuredClone(snapshot())
    plan.instrumentPlans[0].allocatedAmount = invalid
    expect(selectAllocationConsumerSnapshot(state(plan))).toMatchObject({
      availability: 'unavailable',
      reasonKind: 'INVALIDATED',
    })
  })

  it('fails closed for duplicate plan identity or calculation generation mismatch', () => {
    const duplicate = structuredClone(snapshot())
    duplicate.instrumentPlans.push({ ...duplicate.instrumentPlans[0] })
    expect(selectAllocationConsumerSnapshot(state(duplicate)).availability).toBe('unavailable')
    const mismatch = structuredClone(snapshot())
    mismatch.instrumentPlans[0].calculationSnapshotId = 'other'
    expect(selectAllocationConsumerSnapshot(state(mismatch)).availability).toBe('unavailable')
  })

  it('S-T14 keeps shared projection independent while HR-I3 external join generation fails closed', () => {
    const plan = snapshot()
    expect(selectAllocationConsumerSnapshot(state(plan, 'current', 'new-generation')).availability)
      .toBe('available')
    const result = projectCandidatePortfolioRecommendations({
      recommendations: [recommendation()],
      snapshot: plan,
      snapshotStatus: 'current',
      snapshotCandidateGenerationId: 'old-generation',
      sourceCandidateGenerationId: 'new-generation',
      sourceCandidateFreshness: 'fresh',
    })
    expect(result[0].allocation).toBeNull()
  })

  it('S-T28 pins P3-05 legacy instrumentHeadroom to the shared source field', () => {
    const plan = snapshot()
    const legacy = candidateProjection(plan)[0].allocation
    const shared = selectAllocationInstrumentProjections('JP_STOCK')(state(plan))
      ?.find(item => item.instrumentId === legacy?.instrumentId)
    expect(legacy).not.toBeNull()
    expect(legacy?.instrumentHeadroom).toBe(shared?.effectiveInstrumentHeadroom)
  })

  it('zero-instrument classes stay available with count zero and an empty instrument projection', () => {
    const plan = buildAllocationPlanSnapshot({ ...input(), instruments: [], candidates: [] })
    const result = available(selectAllocationConsumerSnapshot(state(plan)))
    for (const item of result.classes) {
      expect(item.instrumentPlanCount).toBe(0)
      expect(item.allocatedAmount).toBe(0)
      expect(item.remainingHeadroom).toBe(item.effectiveHeadroom)
    }
    expect(selectAllocationInstrumentProjections('JP_STOCK')(state(plan))).toEqual([])
  })

  it('multiple classes and blocked instruments retain their own reason scopes', () => {
    const plan = snapshot()
    const result = available(selectAllocationConsumerSnapshot(state(plan)))
    expect(result.classes.map(item => item.assetClass)).toEqual(['JP_STOCK', 'JP_TRUST'])
    const blocked = result.instruments.filter(item => item.blockedReasons.length > 0)
    expect(blocked.every(item => !result.blockedReasons.includes(item.blockedReasons[0]))).toBe(true)
  })

  it.each(['JP_STOCK', 'JP_TRUST'] as readonly AssetClass[])(
    'class selector for %s returns the memoized canonical array member',
    assetClass => {
      const source = state(snapshot())
      const whole = available(selectAllocationConsumerSnapshot(source))
      expect(selectAllocationClassProjection(assetClass)(source))
        .toBe(whole.classes.find(item => item.assetClass === assetClass))
    },
  )
})
