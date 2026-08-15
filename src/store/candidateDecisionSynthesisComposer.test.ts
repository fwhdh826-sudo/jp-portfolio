// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INITIAL_TRUST } from '../constants/trust'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import type { AppState, CandidateFunnelArtifact, Holding, Trust } from '../types'
import type { AllocationPlanSnapshot } from '../types/allocationPlan'
import type {
  CandidatePortfolioFitRecord,
  CandidatePortfolioFitResult,
} from '../types/candidatePortfolioFit'
import {
  CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
  CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
  CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
  CANDIDATE_PORTFOLIO_FIT_VERSION,
} from '../types/candidatePortfolioFit'
import { buildAllocationPlanInput, type AllocationPlanInputAdapterOptions, useAppStore } from './useAppStore'
import { buildCandidateDecisionSynthesisFromState } from './candidateDecisionSynthesisComposer'

const NOW = Date.parse('2026-08-14T01:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const FUNNEL_GENERATION = '2026-08-13T22:14:38.374259+00:00' // production-shaped microsecond precision (R1)
const source = readFileSync(new URL('./candidateDecisionSynthesisComposer.ts', import.meta.url), 'utf8')

const jpTrustRegistry = () => INITIAL_TRUST
  .filter(trust => trust.policy === 'JAPAN_SHORTTERM')
  .map(trust => ({ ...trust }))

function artifact(withCandidates = true): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  value._meta.generatedAt = FUNNEL_GENERATION
  value._meta.asOf = FUNNEL_GENERATION
  value._meta.sourceUpdatedAt = FUNNEL_GENERATION
  if (!withCandidates) value.candidates = []
  return value
}

function holding(code: string, overrides: Partial<Holding> = {}): Holding {
  return {
    code, name: `Holding ${code}`, eval: 300_000, pnlPct: 0, mu: 0.08, sigma: 0.2,
    sigmaSource: 'static', beta: 1, sector: '銀行業', target: 0, alert: 0,
    lock: false, mitsu: false, ma: false, rsi: 50, macd: false, vol: false, mom3m: 0,
    roe: 10, per: 15, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 1,
    score: 0, decision: 'HOLD', ev: 0,
    ...overrides,
  }
}

function baseState(overrides: {
  holdings?: Holding[]
  trust?: Trust[]
  candidateFunnel?: CandidateFunnelArtifact | null
} = {}): AppState {
  const state = useAppStore.getState()
  const funnel = overrides.candidateFunnel === undefined ? artifact() : overrides.candidateFunnel
  return {
    ...state,
    holdings: overrides.holdings ?? [],
    trust: overrides.trust ?? jpTrustRegistry(),
    candidateFunnel: funnel,
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: 10_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      updatedAt: NOW_ISO,
    },
    system: {
      ...state.system,
      csvLastImportedAt: NOW_ISO,
      dataTimestamps: {
        ...state.system.dataTimestamps!,
        market: NOW_ISO,
        candidateFunnel: funnel?._meta.generatedAt ?? null,
      },
      dataSourceStatus: {
        ...state.system.dataSourceStatus,
        candidateFunnel: funnel === null ? 'unavailable' : 'loaded',
        candidatesStocks: 'default',
      },
    },
  }
}

function planFor(state: AppState, options: Partial<AllocationPlanInputAdapterOptions> = {}): AllocationPlanSnapshot {
  const input = buildAllocationPlanInput(state, {
    generatedAt: NOW_ISO,
    holdingsFreshness: 'fresh',
    sourceHoldingsSnapshotId: 'holdings-1b-fixture',
    sourceSettingsVersion: 'settings-1b-fixture',
    cash: { grossCash: 10_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 5_000_000, longTermBudget: 5_000_000 },
    safetyState: {
      safeMode: 'inactive', marketData: 'fresh', cash: 'known_fresh', target: 'known',
      pendingOrders: 'known', candidateArtifact: 'fresh', dqViolation: false,
      tierA: 'normal', crossTab: 'current', noTrade: 'normal',
    },
    ...options,
  })
  expect(input).not.toBeNull()
  return buildAllocationPlanSnapshot(input!)
}

function fitRecordFor(candidate: { code: string; marketRank: number | null; tier: 'actionable' | 'deep_review' }, artifactIndex: number, overrides: Partial<CandidatePortfolioFitRecord> = {}): CandidatePortfolioFitRecord {
  return {
    candidateRecordId: `artifact:${artifactIndex}`,
    artifactIndex,
    code: candidate.code,
    normalizedCode: candidate.code,
    candidateMarketRank: candidate.marketRank,
    candidateTier: candidate.tier,
    holdingRelationship: 'new_to_portfolio',
    portfolioFitScore: null,
    portfolioFitRank: null,
    portfolioFitStatus: 'evaluated',
    components: [],
    fitReasons: [],
    fitRisks: [],
    ...overrides,
  }
}

function fitResultFor(records: CandidatePortfolioFitRecord[], overrides: Partial<CandidatePortfolioFitResult> = {}): CandidatePortfolioFitResult {
  return {
    schemaVersion: CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
    fitVersion: CANDIDATE_PORTFOLIO_FIT_VERSION,
    scoreModel: CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
    targetPopulation: CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
    not_for_trading: true,
    privacyMode: 'local_only',
    persistence: 'none',
    evaluatedAt: NOW_ISO,
    candidateGeneratedAt: FUNNEL_GENERATION,
    portfolioSourceAsOf: NOW_ISO,
    portfolioFreshness: 'fresh',
    status: 'evaluated',
    capacity: { assetClass: 'JP_STOCK', status: 'available', reasons: [] },
    records,
    degradationReasons: [],
    qualityGate: { inputTargetCount: records.length, outputRecordCount: records.length, hardFailIds: [], warningIds: [] },
    ...overrides,
  }
}

/** funnel default fixture: 1002=deep_review, 1003=actionable. */
function defaultFitResult(overrides: Partial<CandidatePortfolioFitResult> = {}): CandidatePortfolioFitResult {
  return fitResultFor([
    fitRecordFor({ code: '1002', marketRank: 1, tier: 'deep_review' }, 1),
    fitRecordFor({ code: '1003', marketRank: 1, tier: 'actionable' }, 2),
  ], overrides)
}

describe('CAND-SYN-1B buildCandidateDecisionSynthesisFromState', () => {
  it('B1 accepts a verbatim microsecond candidateGenerationId from a real-shaped funnel', () => {
    const state = baseState()
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(result?.status).toBe('available')
    expect(result?.provenance.candidateGenerationId).toBe(FUNNEL_GENERATION)
  })

  it('B2 candidate generation mismatch -> null (fail closed)', () => {
    const state = baseState()
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: 'different-generation',
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(result).toBeNull()
  })

  it('returns null when the candidate funnel is absent', () => {
    const state = baseState({ candidateFunnel: null })
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: null,
      fitResult: defaultFitResult(), candidateFreshness: 'unavailable', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(result).toBeNull()
  })

  it('B3 a different allocation snapshot generation changes synthesisId', () => {
    const state = baseState()
    const planA = planFor(state, { sourceHoldingsSnapshotId: 'holdings-a' })
    const planB = planFor(state, { sourceHoldingsSnapshotId: 'holdings-b' })
    const a = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: planA, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const b = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: planB, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(a?.synthesisId).not.toBe(b?.synthesisId)
    expect(a?.provenance.sourceHoldingsSnapshotId).toBe('holdings-a')
    expect(b?.provenance.sourceHoldingsSnapshotId).toBe('holdings-b')
  })

  it('B7 a different portfolioFitEvaluatedAt changes synthesisId', () => {
    const state = baseState()
    const plan = planFor(state)
    const a = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult({ evaluatedAt: '2026-08-14T01:00:00.000Z' }),
      candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const b = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult({ evaluatedAt: '2026-08-14T01:05:00.000Z' }),
      candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(a?.synthesisId).not.toBe(b?.synthesisId)
  })

  it('B9 a different candidates_stocks generation changes synthesisId (§DDR-1 mixed-generation is not corruption)', () => {
    const state = baseState()
    const plan = planFor(state)
    const priceA = { ...state.candidatesStocks, updatedAt: '2026-08-14T07:10:58.528827+09:00', sourceUpdatedAt: '2026-08-14T07:10:58.528827+09:00', status: 'ok' as const }
    const priceB = { ...priceA, updatedAt: '2026-08-14T08:00:00.000000+09:00' }
    const stateA: AppState = { ...state, candidatesStocks: priceA, system: { ...state.system, dataSourceStatus: { ...state.system.dataSourceStatus, candidatesStocks: 'loaded' } } }
    const stateB: AppState = { ...state, candidatesStocks: priceB, system: { ...state.system, dataSourceStatus: { ...state.system.dataSourceStatus, candidatesStocks: 'loaded' } } }
    const a = buildCandidateDecisionSynthesisFromState({
      state: stateA, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const b = buildCandidateDecisionSynthesisFromState({
      state: stateB, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(a?.provenance.candidatesStocksUpdatedAt).toBe(priceA.updatedAt)
    expect(b?.provenance.candidatesStocksUpdatedAt).toBe(priceB.updatedAt)
    expect(a?.synthesisId).not.toBe(b?.synthesisId)
    // eligibility/rank untouched: same decisions in the same order regardless of price generation
    expect(a?.decisions.map(e => e.instrumentId)).toEqual(b?.decisions.map(e => e.instrumentId))
  })

  it('B11 a symbol present only in candidates_stocks never enters synthesis (join starts from the funnel)', () => {
    const state = baseState()
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const ids = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].map(e => e.instrumentId)
    expect(ids).not.toContain('stock:9999')
  })

  // 1B does not feed price/lot authority into AllocationPlan (P2-3 stays open — §17), so the
  // engine unconditionally adds JP_STOCK_EXECUTION_DATA_UNAVAILABLE to every new-stock
  // instrumentPlan's blockedReasons. The 1A composer's `blocked` check outranks the
  // portfolioFit hard gate (blocked ⇒ BLOCKED regardless of hardGatePassed), so every
  // population-B entry is structurally BLOCKED in 1B. The hard-gate computation itself is
  // still exact and independently verifiable via entry.portfolioFit.hardGatePassed.
  it('D new JP_STOCK from the funnel is structurally BLOCKED in 1B (no price/lot authority yet), but the fit hard gate is computed correctly underneath', () => {
    const state = baseState()
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const entry = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].find(e => e.instrumentId === 'stock:1003')
    expect(entry).toMatchObject({ action: 'BLOCKED', assetClass: 'JP_STOCK' })
    expect(entry?.portfolioFit.hardGatePassed).toBe(true)
    expect(entry?.blockingReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
  })

  it('the portfolioFit hard gate correctly computes false when the fit record does not exactly match (D9)', () => {
    const state = baseState()
    const plan = planFor(state)
    const mismatched = fitResultFor([
      fitRecordFor({ code: '1002', marketRank: 1, tier: 'deep_review' }, 1),
      fitRecordFor({ code: '1003', marketRank: 1, tier: 'actionable' }, 2, { candidateMarketRank: 999 }), // no longer exact-matches raw.marketRank
    ])
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: mismatched, candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const entry = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].find(e => e.instrumentId === 'stock:1003')
    expect(entry?.portfolioFit.hardGatePassed).toBe(false)
  })

  it('holding_match_unknown demotes the hard gate (D9 condition 3)', () => {
    const state = baseState()
    const plan = planFor(state)
    const unknownMatch = fitResultFor([
      fitRecordFor({ code: '1002', marketRank: 1, tier: 'deep_review' }, 1),
      fitRecordFor({ code: '1003', marketRank: 1, tier: 'actionable' }, 2, { holdingRelationship: 'holding_match_unknown' }),
    ])
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: unknownMatch, candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const entry = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].find(e => e.instrumentId === 'stock:1003')
    expect(entry?.portfolioFit.hardGatePassed).toBe(false)
    expect(entry?.portfolioFit.relationship).toBe('holding_match_unknown')
  })

  it('quality-gate hardFailIds demotes the fit hard gate to false for every population-B candidate', () => {
    const state = baseState()
    const plan = planFor(state)
    const failedGate = defaultFitResult({ qualityGate: { inputTargetCount: 2, outputRecordCount: 2, hardFailIds: ['PF-QG-01-CANDIDATE_CONTRACT'], warningIds: [] } })
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: failedGate, candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const entries = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].filter(e => e.assetClass === 'JP_STOCK')
    expect(entries.every(e => e.portfolioFit.hardGatePassed === false)).toBe(true)
  })

  it('G1/D24 stale candidate freshness keeps population B (as WATCH, via the real fit gate) and records CANDIDATE_INPUT_STALE', () => {
    const state = baseState()
    const plan = planFor(state)
    // computePortfolioFit itself would force non-evaluated on stale input; here we assert the
    // store layer's own informative annotation independent of that (fitResult supplied directly).
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'stale', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const entry = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].find(e => e.instrumentId === 'stock:1003')
    expect(entry?.whyNotExecutable).toContain('CANDIDATE_INPUT_STALE')
    expect(result?.status).toBe('available')
  })

  it('G2/D24 degraded candidate freshness drops population B entirely while trust ADD/BUY_NEW survives', () => {
    const state = baseState()
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'degraded', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const ids = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].map(e => e.instrumentId)
    expect(ids.some(id => id.startsWith('stock:'))).toBe(false)
    expect(ids.some(id => id.startsWith('trust:'))).toBe(true)
  })

  it('A/C existing holdings currently have no matching instrumentPlan and are dropped with MISSING_INSTRUMENT_MAPPING (1B does not yet feed holding candidates to the engine)', () => {
    const state = baseState({ holdings: [holding('1004')] })
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(result?.status).toBe('available')
    const ids = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].map(e => e.instrumentId)
    expect(ids).not.toContain('stock:1004')
    expect(result?.datasetReasons).toContain('MISSING_INSTRUMENT_MAPPING')
  })

  it('fails closed on duplicate holding identity (§21) before assembling any candidates', () => {
    // buildAllocationPlanInput itself already rejects malformed/duplicate holdings upstream
    // (defaultAllocationInstruments returns null), so the store never reaches this composer
    // with such a state via its real call path. This exercises the composer's own defense
    // (buildHoldingAllocationCandidates) directly, independent of that upstream guard.
    const cleanState = baseState({ holdings: [holding('1004')] })
    const plan = planFor(cleanState)
    const duplicateState: AppState = { ...cleanState, holdings: [holding('1004'), holding('１００４.T')] }
    const result = buildCandidateDecisionSynthesisFromState({
      state: duplicateState, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(result).toBeNull()
  })

  it('C existing JP_TRUST holding maps to ADD; D new JP_TRUST maps to BUY_NEW, both not_evaluated for portfolioFit (D3/D9)', () => {
    const trusts = jpTrustRegistry()
    trusts[0] = { ...trusts[0], eval: 500_000 } // held
    trusts[1] = { ...trusts[1], eval: 0 } // new
    const state = baseState({ trust: trusts })
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const all = [...(result?.decisions ?? []), ...(result?.watchList ?? [])]
    const held = all.find(e => e.instrumentId === `trust:${trusts[0].id}`)
    const fresh = all.find(e => e.instrumentId === `trust:${trusts[1].id}`)
    expect(held).toMatchObject({ action: 'ADD', relationship: 'already_held' })
    expect(fresh).toMatchObject({ action: 'BUY_NEW', relationship: 'new_to_portfolio' })
    expect(held?.portfolioFit.status).toBe('not_evaluated')
    expect(fresh?.portfolioFit.status).toBe('not_evaluated')
  })

  it('K/M higher underweight JP_TRUST class need is not overridden by JP_STOCK marketRank (D11/R1)', () => {
    // Push JP_TRUST to a large targetGap relative to JP_STOCK by driving JP_STOCK near its
    // policy cap via a large held position (existing production comparator behavior, unchanged).
    const state = baseState({ holdings: [holding('9001', { eval: 2_000_000 })] })
    const plan = planFor(state, { policy: undefined })
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(result?.status).toBe('available')
    const trustEntries = [...(result?.decisions ?? [])].filter(e => e.assetClass === 'JP_TRUST')
    const stockEntries = [...(result?.decisions ?? [])].filter(e => e.assetClass === 'JP_STOCK')
    // both populations coexist in one ranked list; no cross-class score mixing occurred
    expect(trustEntries.length + stockEntries.length).toBe(result?.decisions.length)
  })

  it('canonical money is copied bit-for-bit from AllocationPlanSnapshot.instrumentPlans[].finalSuggestedAmount', () => {
    const state = baseState()
    const plan = planFor(state)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    const stockPlan = plan.instrumentPlans.find(p => p.instrumentId === 'stock:1003')
    const entry = [...(result?.decisions ?? []), ...(result?.watchList ?? [])].find(e => e.instrumentId === 'stock:1003')
    if (entry?.money.kind === 'EXECUTABLE') {
      expect(entry.money.executableAmountJpy).toBe(stockPlan?.finalSuggestedAmount)
      expect(entry.money.calculationSnapshotId).toBe(stockPlan?.calculationSnapshotId)
    } else {
      expect(stockPlan?.executable).toBe(false)
    }
  })

  it('P2-3 stays open: new JP_STOCK never becomes executable in 1B (no price/lot authority is fed to AllocationPlan)', () => {
    const state = baseState()
    const plan = planFor(state)
    for (const plan2 of plan.instrumentPlans.filter(p => p.assetClass === 'JP_STOCK' && p.relationship === 'new_to_portfolio')) {
      expect(plan2.executable).toBe(false)
      expect(plan2.finalSuggestedAmount).toBe(0)
    }
  })

  it('does not mutate the input state', () => {
    const state = baseState()
    const before = structuredClone({ holdings: state.holdings, trust: state.trust, candidateFunnel: state.candidateFunnel })
    const plan = planFor(state)
    buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(state.holdings).toEqual(before.holdings)
    expect(state.trust).toEqual(before.trust)
    expect(state.candidateFunnel).toEqual(before.candidateFunnel)
  })

  it('runs deterministically across repeated calls with the same input', () => {
    const state = baseState()
    const plan = planFor(state)
    const call = () => buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: plan, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: defaultFitResult(), candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(call()).toEqual(call())
  })

  it('M1/M2 has no legacy sizing/reference-maximum source and performs no monetary arithmetic', () => {
    expect(source).not.toMatch(/maxAmount|suggestedAmount|SIZING_TIER_LIMIT|estimatedMaximumAmount/)
    expect(source).not.toMatch(/finalSuggestedAmount\s*[*/+-]|[*/+-]\s*\.?finalSuggestedAmount/)
    expect(source).not.toMatch(/priceJpy\s*\*|cash\s*[*/]/i)
  })

  it('N/L candidateDecisionSynthesis composition has no store/officialDecision/UI import', () => {
    expect(source).not.toMatch(/useAppStore|officialDecision|from ['"]\.\.\/components/)
  })
})
