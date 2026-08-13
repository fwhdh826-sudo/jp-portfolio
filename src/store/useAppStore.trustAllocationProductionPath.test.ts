// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INITIAL_TRUST } from '../constants/trust'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import type { AppState, CandidateFunnelArtifact, OfficialDecision, Trust } from '../types'
import type { AllocationPlanInput } from '../types/allocationPlan'
import type { CandidatePortfolioRecommendation } from '../types/candidatePortfolioRecommendation'
import { selectAllocationConsumerSnapshot, selectT2AllocationProjection } from './allocationConsumerSelectors'
import { projectCandidatePortfolioRecommendations } from './candidatePortfolioRecommendation'
import {
  buildAllocationPlanInput,
  runFullAnalysis,
  useAppStore,
  type AllocationPlanInputAdapterOptions,
} from './useAppStore'

const NOW = Date.parse('2026-08-03T00:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const SOURCE_GENERATION = '2026-08-02T23:00:00.000Z'
const source = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')

const jpTrustRegistry = () => INITIAL_TRUST
  .filter(trust => trust.policy === 'JAPAN_SHORTTERM')
  .map(trust => ({ ...trust }))

function freshArtifact(withCandidates = false): CandidateFunnelArtifact {
  const artifact = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  artifact._meta.generatedAt = SOURCE_GENERATION
  artifact._meta.asOf = SOURCE_GENERATION
  artifact._meta.sourceUpdatedAt = SOURCE_GENERATION
  if (!withCandidates) artifact.candidates = []
  return artifact
}

function stateWithTrust(
  trust: readonly Trust[] = jpTrustRegistry(),
  withStockCandidates = false,
): AppState {
  const state = useAppStore.getState()
  const candidateFunnel = freshArtifact(withStockCandidates)
  return {
    ...state,
    holdings: [],
    trust: trust.map(item => ({ ...item })),
    candidateFunnel,
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: 10_000_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: NOW_ISO,
    },
    system: {
      ...state.system,
      csvLastImportedAt: NOW_ISO,
      dataSourceStatus: {
        ...state.system.dataSourceStatus,
        candidateFunnel: 'loaded',
      },
      dataTimestamps: {
        ...state.system.dataTimestamps!,
        candidateFunnel: SOURCE_GENERATION,
      },
    },
  }
}

function options(overrides: Partial<AllocationPlanInputAdapterOptions> = {}): AllocationPlanInputAdapterOptions {
  return {
    generatedAt: NOW_ISO,
    holdingsFreshness: 'fresh',
    sourceHoldingsSnapshotId: 'holdings-r3-c1',
    sourceSettingsVersion: 'settings-r3-c1',
    cash: {
      grossCash: 10_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      dataUncertaintyReserve: 0,
    },
    budgets: { shortTermBudget: 2_000_000, longTermBudget: 8_000_000 },
    safetyState: {
      safeMode: 'inactive',
      marketData: 'fresh',
      cash: 'known_fresh',
      target: 'known',
      pendingOrders: 'known',
      candidateArtifact: 'fresh',
      dqViolation: false,
      tierA: 'normal',
      crossTab: 'current',
      noTrade: 'normal',
    },
    ...overrides,
  }
}

function inputFor(
  state: AppState = stateWithTrust(),
  overrides: Partial<AllocationPlanInputAdapterOptions> = {},
): AllocationPlanInput {
  const input = buildAllocationPlanInput(state, options(overrides))
  expect(input).not.toBeNull()
  return input!
}

function jpTrustAmounts(input: AllocationPlanInput) {
  const snapshot = buildAllocationPlanSnapshot(input)
  const instruments = snapshot.instrumentPlans.filter(plan => plan.assetClass === 'JP_TRUST')
  const classPlan = snapshot.assetClassPlans.find(plan => plan.assetClass === 'JP_TRUST')!
  return {
    snapshot,
    instruments,
    classPlan,
    allocated: instruments.reduce((sum, plan) => sum + plan.allocatedAmount, 0),
  }
}

describe('R3-c1 JP_TRUST production writer input', () => {
  it('J-T01/Test A feeds canonical trust candidates into the existing writer input', () => {
    const input = inputFor()
    const trustCandidates = input.candidates.filter(candidate => candidate.instrumentId.startsWith('trust:'))
    expect(trustCandidates.map(candidate => candidate.instrumentId)).toEqual(
      jpTrustRegistry().map(trust => `trust:${trust.id}`),
    )
    const { instruments } = jpTrustAmounts(input)
    expect(instruments.map(plan => plan.instrumentId)).toEqual(
      trustCandidates.map(candidate => candidate.instrumentId),
    )
    expect(instruments.some(plan => plan.allocatedAmount > 0)).toBe(true)
  })

  it('J-T03/Test B caps aggregate allocation at the JP_TRUST target gap', () => {
    const { allocated, classPlan } = jpTrustAmounts(inputFor())
    expect(allocated).toBeLessThanOrEqual(classPlan.targetGap)
    expect(classPlan.remainingHeadroom).toBeGreaterThanOrEqual(0)
  })

  it('J-T04/Test F allocates zero after the class target is reached', () => {
    const trusts = jpTrustRegistry().map(trust => ({ ...trust, eval: 10_000_000 }))
    const { allocated, instruments, classPlan } = jpTrustAmounts(inputFor(stateWithTrust(trusts), {
      cash: { grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
      budgets: { shortTermBudget: 1_000_000, longTermBudget: 0 },
    }))
    expect(classPlan.targetGap).toBe(0)
    expect(classPlan.blockedReasons).toContain('CLASS_FULL')
    expect(allocated).toBe(0)
    expect(instruments.every(plan => plan.allocatedAmount === 0)).toBe(true)
  })

  it('J-T05/Test K creates one plan per eligible trust and preserves class/instrument equality', () => {
    const { allocated, instruments, classPlan } = jpTrustAmounts(inputFor())
    expect(instruments).toHaveLength(jpTrustRegistry().length)
    expect(allocated).toBe(classPlan.allocatedAmount)
  })

  it('J-T06/Test C uses only shortTermBudget for JP_TRUST', () => {
    const { allocated, snapshot } = jpTrustAmounts(inputFor())
    expect(allocated).toBeLessThanOrEqual(snapshot.shortTermBudget)
    expect(snapshot.longTermBudget).toBe(8_000_000)
  })

  it('J-T07 changes snapshot identity for trust candidate content without changing funnel generation', () => {
    const before = runFullAnalysis(stateWithTrust(), { nowMs: NOW, allocationPlanInput: options() })
    const changedTrust = jpTrustRegistry().map((trust, index) => index === 0
      ? { ...trust, notForTrading: true }
      : trust)
    const after = runFullAnalysis(stateWithTrust(changedTrust), { nowMs: NOW, allocationPlanInput: options() })
    expect(before.allocationPlanCandidateGenerationId).toBe(SOURCE_GENERATION)
    expect(after.allocationPlanCandidateGenerationId).toBe(SOURCE_GENERATION)
    expect(after.allocationPlan?.snapshotId).not.toBe(before.allocationPlan?.snapshotId)
    expect(after.allocationPlan?.instrumentPlans.some(plan => plan.instrumentId === `trust:${changedTrust[0].id}`)).toBe(false)
  })

  it('J-T08 fails the writer input closed for duplicate trust identity', () => {
    const duplicate = [jpTrustRegistry()[0], { ...jpTrustRegistry()[0] }]
    expect(buildAllocationPlanInput(stateWithTrust(duplicate), options())).toBeNull()
  })

  it('J-T09 keeps an empty trust source as a valid zero-candidate snapshot', () => {
    const input = inputFor(stateWithTrust([]))
    const { snapshot, classPlan } = jpTrustAmounts(input)
    expect(input.candidates.filter(candidate => candidate.instrumentId.startsWith('trust:'))).toEqual([])
    expect(snapshot.instrumentPlans.filter(plan => plan.assetClass === 'JP_TRUST')).toEqual([])
    expect(classPlan.allocatedAmount).toBe(0)
  })

  it('J-T10/Test D does not transfer long-term or JP_STOCK residual into JP_TRUST', () => {
    const overseas = INITIAL_TRUST.find(trust => trust.policy === 'OVERSEAS_LONGTERM')!
    const state = stateWithTrust([...jpTrustRegistry(), { ...overseas, eval: 50_000_000 }])
    state.cashAssumptions = { ...state.cashAssumptions, source: 'MANUAL', grossCash: 9_000_000, updatedAt: NOW_ISO }
    const input = buildAllocationPlanInput(state, {
      generatedAt: NOW_ISO,
      holdingsFreshness: 'fresh',
      sourceHoldingsSnapshotId: 'holdings-no-residual',
      sourceSettingsVersion: 'settings-no-residual',
      safetyState: options().safetyState,
    })!
    const { allocated, snapshot, classPlan } = jpTrustAmounts(input)
    expect(snapshot.shortTermBudget).toBe(5_500_000)
    expect(allocated).toBeLessThanOrEqual(5_500_000)
    expect(allocated).toBeLessThanOrEqual(classPlan.targetGap)
    expect(snapshot.remainingUnallocatedCash).toBeGreaterThan(0)
  })

  it('J-T11 keeps holding relationship and buyKind aligned', () => {
    const trusts = jpTrustRegistry().map((trust, index) => ({ ...trust, eval: index === 0 ? 100_000 : 0 }))
    const input = inputFor(stateWithTrust(trusts))
    const firstId = `trust:${trusts[0].id}`
    expect(input.candidates.find(candidate => candidate.instrumentId === firstId)?.buyKind).toBe('BUY_MORE')
    expect(input.instruments.find(instrument => instrument.instrumentId === firstId)?.relationship).toBe('already_held')
    expect(input.candidates.filter(candidate => candidate.instrumentId !== firstId).every(candidate => candidate.buyKind === 'BUY_NEW')).toBe(true)
  })

  it('J-T12/Test I is invariant to candidate array ordering at the writer', () => {
    const input = inputFor()
    const reversed = { ...input, candidates: [...input.candidates].reverse() }
    const original = buildAllocationPlanSnapshot(input)
    const replay = buildAllocationPlanSnapshot(reversed)
    expect(replay.instrumentPlans).toEqual(original.instrumentPlans)
    expect(replay.assetClassPlans).toEqual(original.assetClassPlans)
  })

  it('J-T14 keeps exact JP_STOCK projection alive beside JP_TRUST plans', () => {
    const input = inputFor(stateWithTrust(jpTrustRegistry(), true))
    const snapshot = buildAllocationPlanSnapshot(input)
    const stockPlan = snapshot.instrumentPlans.find(plan => plan.assetClass === 'JP_STOCK')!
    expect(stockPlan).toBeDefined()
    expect(snapshot.instrumentPlans.some(plan => plan.assetClass === 'JP_TRUST')).toBe(true)
    const recommendation: CandidatePortfolioRecommendation = {
      candidateRecordId: 'artifact:0',
      artifactIndex: 0,
      code: stockPlan.instrumentId.slice('stock:'.length),
      name: 'stock projection survivor',
      marketRank: 1,
      action: 'BUY_NEW',
      reason: 'projection survival fixture',
      allocation: null,
    }
    const [projected] = projectCandidatePortfolioRecommendations({
      recommendations: [recommendation],
      snapshot,
      snapshotStatus: 'current',
      snapshotCandidateGenerationId: SOURCE_GENERATION,
      sourceCandidateGenerationId: SOURCE_GENERATION,
      sourceCandidateFreshness: 'fresh',
    })
    expect(projected.allocation?.instrumentId).toBe(stockPlan.instrumentId)
  })

  it('J-T15 preserves exactly one production snapshot writer', () => {
    expect(source.match(/buildAllocationPlanSnapshot\(/g)).toHaveLength(1)
    expect(source).toContain('buildAllocationPlanSnapshot(allocationInput)')
  })

  it('J-T16 exposes the same nonzero JP_TRUST class allocation through the T2 projection', () => {
    const result = runFullAnalysis(stateWithTrust(), { nowMs: NOW, allocationPlanInput: options() })
    const state = { ...stateWithTrust(), ...result }
    const consumer = selectAllocationConsumerSnapshot(state)
    const t2 = selectT2AllocationProjection(state)
    expect(consumer.availability).toBe('available')
    expect(t2?.jpTrustClass.allocatedAmount).toBeGreaterThan(0)
    expect(t2?.jpTrustClass.allocatedAmount).toBe(
      t2?.snapshot.instruments
        .filter(plan => plan.assetClass === 'JP_TRUST')
        .reduce((sum, plan) => sum + plan.allocatedAmount, 0),
    )
  })

  it('Test E ignores expected sale proceeds represented by legacy decision amounts', () => {
    const state = stateWithTrust()
    const baseline = inputFor(state)
    const legacySaleDecision: OfficialDecision = {
      generatedAt: NOW_ISO,
      source: 'committee',
      headline: 'legacy sale proceeds fixture',
      stance: 'neutral',
      noTrade: false,
      dataQualitySuppressed: false,
      actions: [{
        id: 'sell-1', assetType: 'stock', code: '7203', name: 'sale fixture',
        action: 'SELL', reason: 'fixture', amount: 99_000_000, suggestedAmount: 99_000_000,
        source: 'committee',
      }],
      risks: [],
      rationale: [],
    }
    const withSale = inputFor({ ...state, officialDecision: legacySaleDecision })
    expect(withSale.cash).toEqual(baseline.cash)
    expect(withSale.budgets).toEqual(baseline.budgets)
    expect(jpTrustAmounts(withSale).allocated).toBe(jpTrustAmounts(baseline).allocated)
  })

  it('Test L merges an existing holding and its candidate into one canonical instrument plan', () => {
    const trusts = jpTrustRegistry().map((trust, index) => ({ ...trust, eval: index === 0 ? 500_000 : 0 }))
    const input = inputFor(stateWithTrust(trusts))
    const snapshot = buildAllocationPlanSnapshot(input)
    const id = `trust:${trusts[0].id}`
    expect(input.instruments.filter(instrument => instrument.instrumentId === id)).toHaveLength(1)
    expect(input.candidates.filter(candidate => candidate.instrumentId === id)).toHaveLength(1)
    expect(snapshot.instrumentPlans.filter(plan => plan.instrumentId === id)).toHaveLength(1)
  })

  it.each(Array.from({ length: 25 }, (_, index) => index))(
    '25-case parent/target fingerprint preserves non-JP_TRUST authority: case %s',
    (caseIndex) => {
      const trusts = jpTrustRegistry().map((trust, index) => ({
        ...trust,
        eval: index === caseIndex % jpTrustRegistry().length ? caseIndex * 10_000 : 0,
        notForTrading: index === 0 && caseIndex % 5 === 4 ? true : undefined,
      }))
      const state = stateWithTrust(trusts)
      const targetInput = inputFor(state)
      const parentShapedInput = inputFor(state, { candidates: [] })
      const target = buildAllocationPlanSnapshot(targetInput)
      const parentShaped = buildAllocationPlanSnapshot(parentShapedInput)

      expect({
        totalAssets: target.totalAssets,
        grossCash: target.grossCash,
        deployableCash: target.deployableCash,
        shortTermBudget: target.shortTermBudget,
        longTermBudget: target.longTermBudget,
        marketMode: target.marketMode,
        regime: target.regime,
      }).toEqual({
        totalAssets: parentShaped.totalAssets,
        grossCash: parentShaped.grossCash,
        deployableCash: parentShaped.deployableCash,
        shortTermBudget: parentShaped.shortTermBudget,
        longTermBudget: parentShaped.longTermBudget,
        marketMode: parentShaped.marketMode,
        regime: parentShaped.regime,
      })
      expect(target.assetClassPlans.filter(plan => plan.assetClass !== 'JP_TRUST')).toEqual(
        parentShaped.assetClassPlans.filter(plan => plan.assetClass !== 'JP_TRUST'),
      )
      expect(target.instrumentPlans.filter(plan => plan.assetClass !== 'JP_TRUST')).toEqual(
        parentShaped.instrumentPlans.filter(plan => plan.assetClass !== 'JP_TRUST'),
      )
      expect(target.assetClassPlans.find(plan => plan.assetClass === 'JP_TRUST')?.currentAmount)
        .toBe(parentShaped.assetClassPlans.find(plan => plan.assetClass === 'JP_TRUST')?.currentAmount)
    },
  )

  it('stale trust holdings remain fail-closed by the existing writer safety authority', () => {
    const input = inputFor(stateWithTrust(), { holdingsFreshness: 'stale' })
    const { snapshot, instruments } = jpTrustAmounts(input)
    expect(snapshot.deployableCash).toBe(0)
    expect(instruments.every(plan => plan.allocatedAmount === 0 && plan.executable === false)).toBe(true)
  })
})
