/**
 * OPS_P5_B005_FCA_1_P1_REPAIR_R1 cross-layer adversarial suite.
 *
 * Shared invariant for FCA-1-P1-01 / P1-02 / P1-03:
 *   MALFORMED_OR_CONTRADICTORY_EVIDENCE must never be promoted into
 *   AVAILABLE_ALLOCATION_EVIDENCE (an executable BUY_NEW input).
 *
 * Each finding is exercised on two boundaries:
 *   1. loader boundary  — the artifact is fetched and goes through the runtime
 *      parser exactly as production does (loadCandidateFunnel), then the loader
 *      outcome is mapped into the store the way the boot path does.
 *   2. typed bypass     — the artifact is injected into AppState directly
 *      (as a typed internal caller/test could), and the allocation adapter +
 *      safety authority must still refuse to produce executable BUY_NEW.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState, CandidateFunnelArtifact } from '../types'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import { loadCandidateFunnel } from '../services/loadStaticData'
import { parseCandidateFunnelArtifact } from '../services/candidateFunnelParser'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import { selectCandidateFunnelFreshness } from './selectors'
import {
  buildAllocationPlanInput,
  useAppStore,
  type AllocationPlanInputAdapterOptions,
} from './useAppStore'

const NOW_ISO = '2026-07-26T08:00:00.000Z'
const NOW = Date.parse(NOW_ISO)
const GENERATED_AT = '2026-07-26T07:11:40.540540+00:00'

function candidateArtifact(mutate?: (a: CandidateFunnelArtifact) => void): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  value._meta.generatedAt = GENERATED_AT
  value._meta.asOf = GENERATED_AT
  mutate?.(value)
  return value
}

function stateWith(
  artifact: CandidateFunnelArtifact | null,
  status: 'loaded' | 'invalid' | 'unavailable' = artifact === null ? 'unavailable' : 'loaded',
): AppState {
  const state = useAppStore.getState()
  return {
    ...state,
    holdings: [],
    trust: [],
    candidateFunnel: artifact,
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: 2_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      updatedAt: NOW_ISO,
    },
    system: {
      ...state.system,
      csvLastImportedAt: NOW_ISO,
      dataSourceStatus: { ...state.system.dataSourceStatus, candidateFunnel: status },
      dataTimestamps: { ...state.system.dataTimestamps!, candidateFunnel: artifact?._meta.generatedAt ?? null },
    },
  }
}

function adapterOptions(generatedAt = NOW_ISO): AllocationPlanInputAdapterOptions {
  return {
    generatedAt,
    holdingsFreshness: 'fresh',
    sourceHoldingsSnapshotId: 'holdings-capture-fca1',
    sourceSettingsVersion: 'settings-capture-fca1',
    cash: { grossCash: 2_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 2_000_000, longTermBudget: 0 },
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

/** Mirrors the production loader→store mapping (useAppStore boot path). */
async function loadThroughParser(raw: unknown): Promise<AppState> {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(raw)) })))
  const result = await loadCandidateFunnel()
  return stateWith(result.status === 'loaded' ? result.data : null, result.status)
}

function buyNewCandidates(state: AppState, options = adapterOptions()) {
  const input = buildAllocationPlanInput(state, options)
  return {
    input,
    buyNew: input?.candidates.filter(c => c.buyKind === 'BUY_NEW') ?? [],
    candidateArtifact: input?.safetyState.candidateArtifact ?? null,
  }
}

function assertNoExecutableBuyNew(state: AppState, options = adapterOptions()) {
  const { input, buyNew, candidateArtifact } = buyNewCandidates(state, options)
  expect(input).not.toBeNull()
  expect(candidateArtifact).toBe('invalid')
  if (buyNew.length > 0) {
    // typed bypass may still carry the instrument identity; the safety
    // authority must then block it with CANDIDATE_INPUT_INVALID.
    const snapshot = buildAllocationPlanSnapshot(input!)
    const plans = snapshot.instrumentPlans.filter(plan => plan.buyKind === 'BUY_NEW')
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      expect(plan.executable).toBe(false)
      expect(plan.independentlyExecutable).toBe(false)
      expect(plan.finalSuggestedAmount).toBe(0)
      expect(plan.blockedReasons).toContain('CANDIDATE_INPUT_INVALID')
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('FCA-1 baseline control: coherent fresh artifact yields available BUY_NEW evidence', () => {
  it('loader boundary', async () => {
    const state = await loadThroughParser(candidateArtifact())
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(artifactState).toBe('fresh')
    expect(buyNew.map(c => c.instrumentId)).toEqual(['stock:1002', 'stock:1003'])
  })

  it('allowed P-14 WARN with coherent aggregates remains available BUY_NEW evidence', async () => {
    const state = await loadThroughParser(candidateArtifact(a => {
      a._meta.qualityGate.gates.find(g => g.id === 'P-14')!.status = 'WARN'
    }))
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(artifactState).toBe('fresh')
    expect(buyNew).toHaveLength(2)
  })
})

describe('FCA-1-P1-01 cross-layer: contradictory quality gate cannot reach allocation as available BUY_NEW', () => {
  const contradictory = () => candidateArtifact(a => {
    a._meta.qualityGate.gates.find(g => g.id === 'P-02')!.status = 'FAIL'
    a._meta.qualityGate.overallPass = true
    a._meta.qualityGate.hardFailIds = []
  })

  it('G. loader boundary: parser rejects, store holds no artifact, no BUY_NEW candidate exists', async () => {
    expect(parseCandidateFunnelArtifact(contradictory()).ok).toBe(false)
    const state = await loadThroughParser(contradictory())
    expect(state.candidateFunnel).toBeNull()
    expect(state.system.dataSourceStatus.candidateFunnel).toBe('invalid')
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(buyNew).toEqual([])
    expect(artifactState).toBe('invalid')
  })

  it('G. typed bypass: adapter returns invalid, safety state invalid, no executable BUY_NEW', () => {
    const state = stateWith(contradictory())
    const { buyNew } = buyNewCandidates(state)
    expect(buyNew).toEqual([])
    assertNoExecutableBuyNew(state)
  })

  it('G. auxiliary PRESCREEN_DUPLICATE FAIL with green aggregates is equally fail-closed', async () => {
    const state = await loadThroughParser(candidateArtifact(a => {
      a._meta.qualityGate.gates.find(g => g.id === 'PRESCREEN_DUPLICATE')!.status = 'FAIL'
    }))
    expect(state.candidateFunnel).toBeNull()
    expect(buyNewCandidates(state).buyNew).toEqual([])
  })
})

describe('FCA-1-P1-02 cross-layer: marketRank=0 cannot become an available null-ranked BUY_NEW candidate', () => {
  const zeroRank = () => candidateArtifact(a => { a.candidates[2].marketRank = 0 })

  it('loader boundary: parser rejects, no BUY_NEW candidate exists', async () => {
    expect(parseCandidateFunnelArtifact(zeroRank())).toEqual({ ok: false, code: 'invalid_candidates' })
    const state = await loadThroughParser(zeroRank())
    expect(state.candidateFunnel).toBeNull()
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(buyNew).toEqual([])
    expect(artifactState).toBe('invalid')
  })

  it.each([0, -1, 1.5])('typed bypass with marketRank %s: adapter invalid, never available via null coercion', (rank) => {
    const state = stateWith(candidateArtifact(a => { a.candidates[2].marketRank = rank }))
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(buyNew).toEqual([])
    expect(artifactState).toBe('invalid')
    expect(buyNew.some(c => c.marketRank === null)).toBe(false)
  })

  it('control: positive ranks remain available and ordered marketRank ascending', () => {
    const state = stateWith(candidateArtifact(a => {
      a.candidates[1].marketRank = 2
      a.candidates[2].marketRank = 1
    }))
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(artifactState).toBe('fresh')
    expect(buyNew.map(c => [c.instrumentId, c.marketRank])).toEqual([['stock:1003', 1], ['stock:1002', 2]])
  })
})

// FCA-1-P1-02 (R2): producer authority (data/candidate_funnel_engine.py
// build_candidate_funnel) emits marketRank = rank_pos + 1 for every
// non-excluded candidate and marketRank = null only for tier=excluded. A
// non-excluded candidate with marketRank=null is therefore malformed evidence
// and must never become AVAILABLE_ALLOCATION_EVIDENCE or a BUY_NEW candidate.
describe('FCA-1-P1-02 cross-layer (R2): non-excluded marketRank=null cannot become available BUY_NEW evidence', () => {
  const nullRankAt = (index: number) => candidateArtifact(a => { a.candidates[index].marketRank = null })
  const cases = [
    ['actionable', 2],
    ['deep_review', 1],
    ['screened', 0],
  ] as const

  it.each(cases)('loader boundary: %s (index %i) with marketRank=null is rejected by the parser, no BUY_NEW', async (tier, index) => {
    const raw = nullRankAt(index)
    expect(raw.candidates[index].tier).toBe(tier)
    expect(parseCandidateFunnelArtifact(raw)).toEqual({ ok: false, code: 'invalid_candidates' })
    const state = await loadThroughParser(raw)
    expect(state.candidateFunnel).toBeNull()
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(buyNew).toEqual([])
    expect(artifactState).toBe('invalid')
  })

  it.each(cases)('typed bypass: %s (index %i) with marketRank=null => adapter invalid, no executable BUY_NEW, no null-ranked candidate', (_tier, index) => {
    const state = stateWith(nullRankAt(index))
    assertNoExecutableBuyNew(state)
    const { buyNew } = buyNewCandidates(state)
    expect(buyNew).toEqual([])
    expect(buyNew.some(c => c.marketRank === null)).toBe(false)
  })

  it('control: excluded candidate with marketRank=null is accepted at both boundaries and never becomes BUY_NEW', async () => {
    const raw = candidateArtifact(a => {
      a.candidates[0] = {
        ...a.candidates[0],
        tier: 'excluded',
        marketRank: null,
        prescreenRank: null,
        prescreenPool: null,
        prescreenScore: null,
        rawCompositeScore: null,
        dataConfidence: null,
        marketScore: null,
        selectedReasons: [],
        hardExclusionReasons: ['HARD_NOT_PRIME_DOMESTIC'],
      }
      a.counts = { ...a.counts, excluded: 1, screened: 0 }
      a.excludedSummary = { total: 1, byReason: { HARD_NOT_PRIME_DOMESTIC: 1 } }
      a.sectorDistribution = { ...a.sectorDistribution, screened: {} }
      a.candidates[1].marketRank = 2
      a.candidates[2].marketRank = 1
    })
    expect(parseCandidateFunnelArtifact(raw).ok).toBe(true)
    const state = await loadThroughParser(raw)
    expect(state.candidateFunnel).not.toBeNull()
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(artifactState).toBe('fresh')
    expect(buyNew.map(c => [c.instrumentId, c.marketRank])).toEqual([['stock:1003', 1], ['stock:1002', 2]])
    expect(buyNew.some(c => c.instrumentId === 'stock:1001')).toBe(false)
  })

  it('excluded candidate with a non-null marketRank is malformed at both boundaries', () => {
    const raw = candidateArtifact(a => {
      a.candidates[0] = { ...a.candidates[0], tier: 'excluded', marketRank: 5, selectedReasons: [] }
      a.counts = { ...a.counts, excluded: 1, screened: 0 }
    })
    expect(parseCandidateFunnelArtifact(raw)).toEqual({ ok: false, code: 'invalid_candidates' })
    const state = stateWith(raw)
    assertNoExecutableBuyNew(state)
  })
})

describe('FCA-1-P1-03 cross-layer: future / calendar-invalid generatedAt cannot become fresh BUY_NEW evidence', () => {
  it('calendar-invalid generatedAt (2026-09-31): parser rejects at the loader boundary', async () => {
    const rollover = candidateArtifact(a => { a._meta.generatedAt = '2026-09-31T00:00:00+00:00' })
    expect(parseCandidateFunnelArtifact(rollover)).toEqual({ ok: false, code: 'invalid_meta' })
    const state = await loadThroughParser(rollover)
    expect(state.candidateFunnel).toBeNull()
    expect(buyNewCandidates(state, adapterOptions('2026-10-01T12:00:00.000Z')).buyNew).toEqual([])
  })

  it('calendar-invalid generatedAt via typed bypass: adapter invalid, no executable BUY_NEW', () => {
    const state = stateWith(candidateArtifact(a => { a._meta.generatedAt = '2026-09-31T00:00:00+00:00' }))
    state.system.dataTimestamps!.candidateFunnel = state.candidateFunnel!._meta.generatedAt
    assertNoExecutableBuyNew(state, adapterOptions('2026-10-01T12:00:00.000Z'))
  })

  it('future generatedAt (well-formed, +1ms .. +1 day) parses but is invalid freshness and blocked BUY_NEW', async () => {
    for (const deltaMs of [1, 1000, 24 * 60 * 60 * 1000]) {
      const futureIso = new Date(NOW + deltaMs).toISOString()
      const raw = candidateArtifact(a => { a._meta.generatedAt = futureIso; a._meta.asOf = futureIso })
      expect(parseCandidateFunnelArtifact(raw).ok).toBe(true)
      const state = await loadThroughParser(raw)
      expect(state.candidateFunnel).not.toBeNull()
      expect(selectCandidateFunnelFreshness(state, NOW)).toBe('invalid')
      assertNoExecutableBuyNew(state)
      const { buyNew } = buyNewCandidates(state)
      // the candidate identity may still be captured, but it is never executable
      const snapshot = buildAllocationPlanSnapshot(buildAllocationPlanInput(state, adapterOptions())!)
      expect(snapshot.instrumentPlans.filter(p => p.buyKind === 'BUY_NEW').every(p => !p.executable)).toBe(true)
      expect(buyNew.length).toBeGreaterThan(0)
    }
  })

  it('exact current time (generatedAt === operation clock) is fresh and available', async () => {
    const state = await loadThroughParser(candidateArtifact(a => { a._meta.generatedAt = NOW_ISO; a._meta.asOf = NOW_ISO }))
    const { buyNew, candidateArtifact: artifactState } = buyNewCandidates(state)
    expect(artifactState).toBe('fresh')
    expect(buyNew).toHaveLength(2)
  })

  it('old valid generatedAt is stale (estimate-only), not invalid and not fresh', async () => {
    const state = await loadThroughParser(candidateArtifact(a => {
      a._meta.generatedAt = '2026-07-20T00:00:00+00:00'
      a._meta.asOf = '2026-07-20T00:00:00+00:00'
    }))
    expect(buyNewCandidates(state).candidateArtifact).toBe('stale')
  })

  it('UTC and JST spellings of the same future instant are both invalid', async () => {
    // microseconds below the millisecond authority are truncated, so +1µs is
    // "exact now" (fresh); +1ms is the smallest future offset.
    const exactJst = candidateArtifact(a => { a._meta.generatedAt = '2026-07-26T17:00:00.000999+09:00' })
    expect(selectCandidateFunnelFreshness(await loadThroughParser(exactJst), NOW)).toBe('fresh')

    const jst = candidateArtifact(a => { a._meta.generatedAt = '2026-07-26T17:00:00.001000+09:00' })
    const utc = candidateArtifact(a => { a._meta.generatedAt = '2026-07-26T08:00:00.001000+00:00' })
    for (const raw of [jst, utc]) {
      const state = await loadThroughParser(raw)
      expect(selectCandidateFunnelFreshness(state, NOW)).toBe('invalid')
      expect(buyNewCandidates(state).candidateArtifact).toBe('invalid')
    }
  })
})
