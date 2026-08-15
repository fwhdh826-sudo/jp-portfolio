// CAND-SYN-1B-R1: Population A (held JP_STOCK) canonical candidate injection.
//
// buildAllocationPlanInput previously omitted holdingCandidateCapture from
// AllocationPlanInput.candidates, so an existing JP_STOCK holding had a
// canonical InstrumentInput but no matching CandidateInput. The engine never
// produced an instrumentPlan for it, and downstream synthesis dropped the
// holding as MISSING_INSTRUMENT_MAPPING. This repair injects the existing
// buildHoldingAllocationCandidates() population as BUY_MORE candidates.
//
// Scope: mapping/authority only. Monetary activation (lotSizeShares,
// price/lot execution) stays NOT_ACTIVE — that is 1C's responsibility.
import { describe, expect, it } from 'vitest'
import { INITIAL_TRUST } from '../constants/trust'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import { buildCandidateDecisionSynthesisFromState } from './candidateDecisionSynthesisComposer'
import type { AppState, CandidateFunnelArtifact, Holding, Trust } from '../types'
import {
  buildCandidateAllocationInputs,
  type CandidateAllocationInputAdapterResult,
} from '../domain/candidates/candidatePortfolioRecommendation'
import { buildTrustAllocationCandidates } from '../domain/candidates/trustAllocationCandidates'
import type { CandidatePortfolioFitResult } from '../types/candidatePortfolioFit'
import {
  CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
  CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
  CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
  CANDIDATE_PORTFOLIO_FIT_VERSION,
} from '../types/candidatePortfolioFit'
import {
  buildAllocationPlanInput,
  useAppStore,
  type AllocationPlanInputAdapterOptions,
} from './useAppStore'

const NOW = Date.parse('2026-08-14T01:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const FUNNEL_GENERATION = '2026-08-13T22:14:38.374259+00:00'

const jpTrustRegistry = () => INITIAL_TRUST
  .filter(trust => trust.policy === 'JAPAN_SHORTTERM')
  .map(trust => ({ ...trust }))

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

function artifact(): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  value._meta.generatedAt = FUNNEL_GENERATION
  value._meta.asOf = FUNNEL_GENERATION
  value._meta.sourceUpdatedAt = FUNNEL_GENERATION
  return value
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
    },
  }
}

function emptyFitResult(): CandidatePortfolioFitResult {
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
    records: [],
    degradationReasons: [],
    qualityGate: { inputTargetCount: 0, outputRecordCount: 0, hardFailIds: [], warningIds: [] },
  }
}

function adapterOptions(overrides: Partial<AllocationPlanInputAdapterOptions> = {}): AllocationPlanInputAdapterOptions {
  return {
    generatedAt: NOW_ISO,
    holdingsFreshness: 'fresh',
    sourceHoldingsSnapshotId: 'holdings-1b-r1-fixture',
    sourceSettingsVersion: 'settings-1b-r1-fixture',
    cash: { grossCash: 10_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 5_000_000, longTermBudget: 5_000_000 },
    safetyState: {
      safeMode: 'inactive', marketData: 'fresh', cash: 'known_fresh', target: 'known',
      pendingOrders: 'known', candidateArtifact: 'fresh', dqViolation: false,
      tierA: 'normal', crossTab: 'current', noTrade: 'normal',
    },
    ...overrides,
  }
}

describe('CAND-SYN-1B-R1 Population A candidate injection', () => {
  it('R1-A/R1-D valid existing JP_STOCK holding injects a BUY_MORE CandidateInput', () => {
    const state = baseState({ holdings: [holding('1004')], candidateFunnel: null })
    const input = buildAllocationPlanInput(state, adapterOptions())
    expect(input).not.toBeNull()
    const candidate = input!.candidates.find(c => c.instrumentId === 'stock:1004')
    expect(candidate).toBeDefined()
    expect(candidate?.buyKind).toBe('BUY_MORE')
  })

  it('R1-B/R1-C/R1-H canonical InstrumentPlan exists with already_held relationship and lotSizeShares stays null', () => {
    const state = baseState({ holdings: [holding('1004')], candidateFunnel: null })
    const input = buildAllocationPlanInput(state, adapterOptions())
    expect(input).not.toBeNull()
    const instrument = input!.instruments.find(i => i.instrumentId === 'stock:1004')
    expect(instrument).toMatchObject({ relationship: 'already_held', lotSizeShares: null })

    const snapshot = buildAllocationPlanSnapshot(input!)
    const plan = snapshot.instrumentPlans.find(p => p.instrumentId === 'stock:1004')
    expect(plan).toBeDefined()
    expect(plan?.relationship).toBe('already_held')
    expect(plan?.buyKind).toBe('BUY_MORE')
    expect(plan?.lotSizeShares).toBeNull()
  })

  it('R1-I Population A remains non-executable while JP_STOCK execution metadata is incomplete', () => {
    const state = baseState({ holdings: [holding('1004')], candidateFunnel: null })
    const input = buildAllocationPlanInput(state, adapterOptions())
    const snapshot = buildAllocationPlanSnapshot(input!)
    const plan = snapshot.instrumentPlans.find(p => p.instrumentId === 'stock:1004')
    expect(plan?.executable).toBe(false)
    expect(plan?.finalSuggestedAmount).toBe(0)
    expect(plan?.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
  })

  it('R1-E CandidateDecisionSynthesis no longer drops a valid held JP_STOCK as MISSING_INSTRUMENT_MAPPING', () => {
    const state = baseState({ holdings: [holding('1004')] })
    const input = buildAllocationPlanInput(state, adapterOptions())
    const snapshot = buildAllocationPlanSnapshot(input!)
    const result = buildCandidateDecisionSynthesisFromState({
      state, allocationPlan: snapshot, allocationPlanStatus: 'current',
      allocationPlanCandidateGenerationId: FUNNEL_GENERATION,
      fitResult: emptyFitResult(),
      candidateFreshness: 'fresh', evaluatedAt: NOW_ISO, nowMs: NOW,
    })
    expect(result?.status).toBe('available')
    const all = [...(result?.decisions ?? []), ...(result?.watchList ?? [])]
    const entry = all.find(e => e.instrumentId === 'stock:1004')
    expect(entry).toMatchObject({ relationship: 'already_held' })
    expect(result?.datasetReasons).not.toContain('MISSING_INSTRUMENT_MAPPING')
  })

  it('R1-F fails closed on duplicate normalized holding identity', () => {
    const state = baseState({
      holdings: [holding('1004'), holding('１００４.T')],
      candidateFunnel: null,
    })
    expect(buildAllocationPlanInput(state, adapterOptions())).toBeNull()
  })

  it('R1-F fails closed on a holding identity that cannot be normalized', () => {
    const state = baseState({ holdings: [holding('bad code')], candidateFunnel: null })
    expect(buildAllocationPlanInput(state, adapterOptions())).toBeNull()
  })

  it('R1-G the same instrumentId cannot appear as both BUY_MORE and BUY_NEW — fails closed on collision', () => {
    const state = baseState({ holdings: [holding('1004')], candidateFunnel: null })
    const collidingCandidateCapture: CandidateAllocationInputAdapterResult = {
      status: 'available',
      sourceCandidateGenerationId: 'r1-g-collision-fixture',
      instruments: [],
      candidates: [{ instrumentId: 'stock:1004', buyKind: 'BUY_NEW', marketRank: null, artifactIndex: 0, confidence: null }],
    }
    const result = buildAllocationPlanInput(state, adapterOptions({ candidateCapture: collidingCandidateCapture }))
    expect(result).toBeNull()
  })

  it('does not inject anything when the candidate population is explicitly overridden', () => {
    const state = baseState({ holdings: [holding('1004')], candidateFunnel: null })
    const input = buildAllocationPlanInput(state, adapterOptions({ candidates: [] }))
    expect(input?.candidates).toEqual([])
  })

  it('R1-K Population B (new JP_STOCK from funnel) remains structurally non-executable', () => {
    const state = baseState({ holdings: [] })
    const input = buildAllocationPlanInput(state, adapterOptions())
    const snapshot = buildAllocationPlanSnapshot(input!)
    const newStockPlans = snapshot.instrumentPlans.filter(p => p.relationship === 'new_to_portfolio' && p.assetClass === 'JP_STOCK')
    expect(newStockPlans.length).toBeGreaterThan(0)
    expect(newStockPlans.every(p => p.executable === false)).toBe(true)
  })

  it('R1-J/R1-L before/after repair regression: same state, only the candidate population differs', () => {
    // Isolates the effect of the repair itself: identical holdings/instruments
    // (so JP_STOCK currentAmount, totalAssets, and JP_TRUST target amounts are
    // unchanged) — only the presence of the Population A BUY_MORE candidate
    // differs, exactly like the pre-repair vs. post-repair candidate lists.
    const state = baseState({ holdings: [holding('1004')] })
    const preRepairCandidates = [
      ...buildCandidateAllocationInputs({ artifact: state.candidateFunnel, holdings: state.holdings }).candidates,
      ...buildTrustAllocationCandidates({ trust: state.trust }).candidates,
    ]

    const inputBefore = buildAllocationPlanInput(state, adapterOptions({ candidates: preRepairCandidates }))!
    const inputAfter = buildAllocationPlanInput(state, adapterOptions())!

    const snapshotBefore = buildAllocationPlanSnapshot(inputBefore)
    const snapshotAfter = buildAllocationPlanSnapshot(inputAfter)

    // Pre-repair: stock:1004 has no candidate at all -> no instrumentPlan (the
    // exact defect this repair closes).
    expect(snapshotBefore.instrumentPlans.some(p => p.instrumentId === 'stock:1004')).toBe(false)
    // Post-repair: stock:1004 has a canonical, blocked instrumentPlan.
    const postPlan = snapshotAfter.instrumentPlans.find(p => p.instrumentId === 'stock:1004')
    expect(postPlan).toMatchObject({ relationship: 'already_held', buyKind: 'BUY_MORE', executable: false })

    // JP_TRUST (Population C/D) instrument plans are unchanged before/after,
    // apart from calculationSnapshotId (which is expected to change because it
    // is derived from the candidate-set identity itself, not from monetary state).
    const stripSnapshotId = (p: (typeof snapshotBefore.instrumentPlans)[number]) => {
      const { calculationSnapshotId: _calculationSnapshotId, ...rest } = p
      return rest
    }
    const trustBefore = snapshotBefore.instrumentPlans.filter(p => p.assetClass === 'JP_TRUST').map(stripSnapshotId)
    const trustAfter = snapshotAfter.instrumentPlans.filter(p => p.assetClass === 'JP_TRUST').map(stripSnapshotId)
    expect(trustAfter).toEqual(trustBefore)

    // JP_TRUST class-level totals are unchanged.
    const classBefore = snapshotBefore.assetClassPlans.find(p => p.assetClass === 'JP_TRUST')!
    const classAfter = snapshotAfter.assetClassPlans.find(p => p.assetClass === 'JP_TRUST')!
    expect(classAfter).toEqual(classBefore)

    // Previously-executable JP_STOCK (new_to_portfolio funnel) candidates are unchanged.
    const newStockBefore = snapshotBefore.instrumentPlans.filter(p => p.relationship === 'new_to_portfolio').map(stripSnapshotId)
    const newStockAfter = snapshotAfter.instrumentPlans.filter(p => p.relationship === 'new_to_portfolio').map(stripSnapshotId)
    expect(newStockAfter).toEqual(newStockBefore)
  })

  it('R1-K Population B new-stock instrument plans are unaffected by Population A injection (targeted amount check)', () => {
    const state = baseState({ holdings: [holding('1004')] })
    const input = buildAllocationPlanInput(state, adapterOptions())!
    const snapshot = buildAllocationPlanSnapshot(input)
    const newStockPlans = snapshot.instrumentPlans.filter(p => p.relationship === 'new_to_portfolio' && p.assetClass === 'JP_STOCK')
    expect(newStockPlans.length).toBeGreaterThan(0)
    expect(newStockPlans.every(p => p.executable === false && p.finalSuggestedAmount === 0)).toBe(true)
  })
})
