// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AppState, CandidateFunnelArtifact } from '../types'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import {
  buildAllocationPlanInput,
  runFullAnalysis,
  useAppStore,
  mergeAllocationInstruments,
  type AllocationPlanInputAdapterOptions,
} from './useAppStore'

const source = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')
const persistenceSource = readFileSync(new URL('./persist.ts', import.meta.url), 'utf8')
const recommendationSource = readFileSync(new URL('./candidatePortfolioRecommendation.ts', import.meta.url), 'utf8')
const NOW = Date.parse('2026-07-26T08:00:00.000Z')

function candidateArtifact(generatedAt = '2026-07-26T07:11:40.540540+00:00'): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  value._meta.generatedAt = generatedAt
  value._meta.asOf = generatedAt
  return value
}

function stateWithArtifact(artifact: CandidateFunnelArtifact | null, holdings: AppState['holdings'] = []): AppState {
  const state = useAppStore.getState()
  return {
    ...state,
    holdings,
    trust: [],
    candidateFunnel: artifact,
    system: {
      ...state.system,
      csvLastImportedAt: new Date(NOW).toISOString(),
      dataSourceStatus: {
        ...state.system.dataSourceStatus,
        candidateFunnel: artifact === null ? 'unavailable' : 'loaded',
      },
      dataTimestamps: {
        ...state.system.dataTimestamps!,
        candidateFunnel: artifact?._meta.generatedAt ?? null,
      },
    },
  }
}

function adapterOptions(): AllocationPlanInputAdapterOptions {
  return {
    generatedAt: new Date(NOW).toISOString(),
    holdingsFreshness: 'fresh',
    sourceHoldingsSnapshotId: 'holdings-capture-1',
    sourceSettingsVersion: 'settings-capture-1',
    cash: {
      grossCash: 2_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      dataUncertaintyReserve: 0,
    },
    budgets: { shortTermBudget: 0, longTermBudget: 2_000_000 },
    safetyState: {
      safeMode: 'inactive',
      marketData: 'fresh',
      cash: 'known_fresh',
      target: 'known',
      pendingOrders: 'known',
      dqViolation: false,
      tierA: 'normal',
      crossTab: 'current',
      noTrade: 'normal',
    },
  }
}

describe('HR-I3 candidate allocation production path', () => {
  it('feeds canonical public candidate inputs into the existing writer input', () => {
    const artifact = candidateArtifact()
    const source = stateWithArtifact(artifact)
    source.cashAssumptions = {
      source: 'MANUAL',
      grossCash: 2_000_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: new Date(NOW).toISOString(),
    }
    const input = buildAllocationPlanInput(source, adapterOptions())
    expect(input?.candidates.map(item => item.instrumentId)).toEqual(['stock:1002', 'stock:1003'])
    expect(input?.budgets).toEqual({ shortTermBudget: 0, longTermBudget: 2_000_000 })
    expect(input?.instruments.filter(item => item.relationship === 'new_to_portfolio').map(item => ({
      instrumentId: item.instrumentId,
      priceJpy: item.priceJpy,
      lotSizeShares: item.lotSizeShares,
    }))).toEqual([
      { instrumentId: 'stock:1002', priceJpy: null, lotSizeShares: null },
      { instrumentId: 'stock:1003', priceJpy: null, lotSizeShares: null },
    ])
  })

  it('M-R3-09 derives the production short-term budget without an adapter budget override', () => {
    const source = stateWithArtifact(candidateArtifact())
    source.cashAssumptions = {
      source: 'MANUAL',
      grossCash: 9_000_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: new Date(NOW).toISOString(),
    }
    const input = buildAllocationPlanInput(source, {
      generatedAt: new Date(NOW).toISOString(),
      holdingsFreshness: 'fresh',
      sourceHoldingsSnapshotId: 'holdings-production-budget-fixture',
      sourceSettingsVersion: 'settings-production-budget-fixture',
      safetyState: {
        safeMode: 'inactive',
        marketData: 'fresh',
        cash: 'known_fresh',
        target: 'known',
        pendingOrders: 'known',
        dqViolation: false,
        tierA: 'normal',
        crossTab: 'current',
        noTrade: 'normal',
      },
    })

    expect(input).not.toBeNull()
    expect(input?.cash.grossCash).toBe(9_000_000)
    expect(input?.budgets).toEqual({
      shortTermBudget: 5_500_000,
      longTermBudget: 3_500_000,
    })
    expect(input?.budgets.shortTermBudget).not.toBe(input?.cash.grossCash)

    const snapshot = buildAllocationPlanSnapshot(input!)
    const jpTrust = snapshot.assetClassPlans.find(item => item.assetClass === 'JP_TRUST')
    expect(snapshot.shortTermBudget).toBe(5_500_000)
    expect(jpTrust?.availableBudget).toBe(5_500_000)
    expect(jpTrust!.availableBudget!).toBeLessThan(input!.cash.grossCash!)
  })

  it('S-T19 fails closed when a holding identity cannot be normalized', () => {
    const holdings = [{ code: 'bad code', eval: 0 }] as AppState['holdings']
    expect(buildAllocationPlanInput(stateWithArtifact(candidateArtifact(), holdings), adapterOptions()))
      .toBeNull()
  })

  it('N1 rejects duplicate normalized holding identities without silent overwrite', () => {
    const holdings = [
      { code: '１００２.t', eval: 0 },
      { code: ' 1002 ', eval: 0 },
    ] as AppState['holdings']
    expect(buildAllocationPlanInput(stateWithArtifact(candidateArtifact(), holdings), adapterOptions()))
      .toBeNull()
  })

  it('N1 aligns eval-zero heldIds with canonical default instruments', () => {
    const holdings = [{ code: ' １００２.t ', eval: 0, sector: '銀行業' }] as AppState['holdings']
    const result = buildAllocationPlanInput(stateWithArtifact(candidateArtifact(), holdings), adapterOptions())
    expect(result).not.toBeNull()
    expect(result?.candidates.map(item => item.instrumentId)).toEqual(['stock:1003'])
    expect(result?.instruments.filter(item => item.instrumentId === 'stock:1002')).toHaveLength(1)
  })

  it('S-T21 keeps the duplicate merge backstop fail-closed', () => {
    const instrument = {
      instrumentId: 'stock:1002',
      assetClass: 'JP_STOCK' as const,
      kind: 'jp_stock' as const,
      relationship: 'already_held' as const,
      currentAmount: 0,
      role: null,
      reason: 'duplicate backstop fixture',
      priceJpy: null,
      lotSizeShares: null,
    }
    expect(mergeAllocationInstruments([instrument], [{ ...instrument }])).toBeNull()
  })

  it('captures candidate generation on the canonical run and creates exact instrument plans', () => {
    const artifact = candidateArtifact()
    const computed = runFullAnalysis(stateWithArtifact(artifact), {
      nowMs: NOW,
      allocationPlanInput: adapterOptions(),
    })
    expect(computed.allocationPlanCandidateGenerationId).toBe(artifact._meta.generatedAt)
    expect(computed.allocationPlan?.instrumentPlans.map(item => item.instrumentId))
      .toEqual(['stock:1002', 'stock:1003'])
    expect(computed.allocationPlan?.instrumentPlans.every(item =>
      item.finalSuggestedAmount === 0 &&
      item.executable === false &&
      item.blockedReasons.includes('JP_STOCK_EXECUTION_DATA_UNAVAILABLE'),
    )).toBe(true)
  })

  it('candidate generation change invalidates snapshot identity at the same analysis instant', () => {
    const oldArtifact = candidateArtifact('2026-07-26T07:00:00.000Z')
    const newArtifact = candidateArtifact('2026-07-26T07:30:00.000Z')
    const oldRun = runFullAnalysis(stateWithArtifact(oldArtifact), {
      nowMs: NOW,
      allocationPlanInput: adapterOptions(),
    })
    const newRun = runFullAnalysis(stateWithArtifact(newArtifact), {
      nowMs: NOW,
      allocationPlanInput: adapterOptions(),
    })
    expect(oldRun.allocationPlanCandidateGenerationId).toBe(oldArtifact._meta.generatedAt)
    expect(newRun.allocationPlanCandidateGenerationId).toBe(newArtifact._meta.generatedAt)
    expect(newRun.allocationPlan?.snapshotId).not.toBe(oldRun.allocationPlan?.snapshotId)
  })

  it('unavailable loader creates no fake candidate and captures no generation', () => {
    const input = buildAllocationPlanInput(stateWithArtifact(null), adapterOptions())
    expect(input?.candidates).toEqual([])
    const computed = runFullAnalysis(stateWithArtifact(null), {
      nowMs: NOW,
      allocationPlanInput: adapterOptions(),
    })
    expect(computed.allocationPlan?.instrumentPlans).toEqual([])
    expect(computed.allocationPlanCandidateGenerationId).toBeNull()
  })

  it('invalid or stale artifact remains fail-closed at input safety authority', () => {
    const invalidArtifact = candidateArtifact()
    invalidArtifact._meta.qualityGate.overallPass = false
    expect(buildAllocationPlanInput(stateWithArtifact(invalidArtifact), adapterOptions())
      ?.safetyState.candidateArtifact).toBe('invalid')

    const staleArtifact = candidateArtifact('2026-07-20T00:00:00.000Z')
    expect(buildAllocationPlanInput(stateWithArtifact(staleArtifact), adapterOptions())
      ?.safetyState.candidateArtifact).toBe('stale')
  })

  it('maintains exactly one buildAllocationPlanSnapshot production call', () => {
    expect(source.match(/buildAllocationPlanSnapshot\(/g)).toHaveLength(1)
    const call = source.indexOf('buildAllocationPlanSnapshot(allocationInput)')
    const composition = source.indexOf('function appendCommittedCandidatePortfolioRecommendations')
    expect(call).toBeGreaterThanOrEqual(0)
    expect(composition).toBeGreaterThan(call)
  })

  it('captures one AppState generation without a later get() in the writer adapter', () => {
    const start = source.indexOf('export function runFullAnalysis')
    const end = source.indexOf('type FullAnalysisResult', start)
    const writer = source.slice(start, end)
    expect(writer).toContain('const allocationState: AppState = {')
    expect(writer).toContain('candidateCapture,')
    expect(writer).not.toMatch(/\.getState\(|\bget\(\)/)
  })

  it('keeps the architecture one-way and projection formula-free', () => {
    expect(recommendationSource).toContain('plan.estimatedMaximumAmount')
    expect(recommendationSource).toContain('plan.finalSuggestedAmount')
    expect(recommendationSource).not.toMatch(/deployableCash\s*[*/+-]|estimatedMaximumAmount\s*[*/+-]|finalSuggestedAmount\s*[*/+-]/)
    const helper = source.slice(
      source.indexOf('function appendCommittedCandidatePortfolioRecommendations'),
      source.indexOf('function reportSubscriberException'),
    )
    expect(helper).not.toContain('buildAllocationPlanSnapshot')
    expect(helper).not.toMatch(/sort\(|marketRank\s*=|score\s*=/)
  })

  it('cross-tab invalidation atomically removes both snapshot and old projection', () => {
    const invalidation = source.slice(
      source.indexOf('allocationPlan: null,'),
      source.indexOf('allocationPlan: null,') + 250,
    )
    expect(invalidation).toContain("allocationPlanStatus: 'stale'")
    expect(invalidation).toContain('allocationPlanCandidateGenerationId: null')
    expect(invalidation).toContain('candidatePortfolioRecommendations: []')
  })

  it('does not persist or publish private projection fields', () => {
    expect(persistenceSource).not.toContain('candidatePortfolioRecommendations')
    expect(persistenceSource).not.toContain('allocationPlanCandidateGenerationId')
    expect(source).not.toMatch(/candidateFunnel\s*:[\s\S]{0,120}candidatePortfolioRecommendations/)
  })

  it('keeps OfficialDecision amount and projection connection absent', () => {
    const officialAdapter = recommendationSource.slice(
      recommendationSource.indexOf('export function appendCandidatePortfolioRecommendations'),
    )
    expect(officialAdapter).not.toMatch(/allocation|amount|headroom|executable|blockedReasons|warningReasons|limitingFactors/)
    expect(officialAdapter).not.toMatch(/title|parse/)
  })
})
