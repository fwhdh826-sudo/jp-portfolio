// @ts-expect-error - this repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { createStore } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AppState,
  CandidateFunnelArtifact,
  CashAssumptions,
  CsvImportProvenance,
  Holding,
  PortfolioPolicy,
} from '../types'
import type {
  CsvImportGenerationRestoreResult,
  CsvImportPersistencePayload,
} from './persist'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import {
  buildCandidatePortfolioFitInput,
  selectCandidatePortfolioFit,
  selectCandidatePortfolioFitCandidateSource,
} from './portfolioFitSelectors'

type CommittedGeneration = Extract<CsvImportGenerationRestoreResult, { status: 'committed' }>
type CandidateStatus = AppState['system']['dataSourceStatus']['candidateFunnel']

const EVALUATED_AT = '2026-07-26T08:00:00.000Z'
const HOUR_MS = 60 * 60 * 1000
const POLICY: PortfolioPolicy = { jpStockMaxRatio: 0.15 }
const CASH: CashAssumptions = {
  cashDeposits: 500_000,
  standbyFunds: 100_000,
  manualOverrideEnabled: true,
  manualUpdatedAt: '2026-07-26T07:00:00.000Z',
}
const PROVENANCE: CsvImportProvenance = {
  sourceAsOf: '2026-07-26T07:00:00.000Z',
  sourceAsOfKind: 'csv_explicit',
  sourceAsOfConfidence: 'authoritative',
  contentFingerprint: 'portfolio-fit-selector-authority',
  sourceFileName: 'portfolio.csv',
  fileLastModified: '2026-07-26T07:00:00.000Z',
  importedAt: '2026-07-26T07:05:00.000Z',
}

function artifact(): CandidateFunnelArtifact {
  return structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
}

function holding(code: string, evalValue = 100_000, sector = '銀行業'): Holding {
  return {
    code,
    name: `canonical-${code}`,
    eval: evalValue,
    sector,
    acquiredAt: '2026-01-15',
  } as Holding
}

function committed(holdings: Holding[] = [holding('1002')]): CommittedGeneration {
  const payload = {
    holdings,
    trust: [],
    learning: null,
    csvImportedAt: PROVENANCE.importedAt,
    syncSummary: null,
    trustShortSnapshot: {},
    provenance: PROVENANCE,
    portfolioPolicy: POLICY,
    cashAssumptions: CASH,
    origin: 'csv',
    snapshotGenerationIdentity: 'sha256:selector',
    snapshotTransferIdentity: null,
  } as unknown as CsvImportPersistencePayload
  return {
    status: 'committed',
    schemaVersion: 'csv-import-generation-5',
    generationId: 'canonical-generation-selector',
    savedAt: 1_785_049_500_000,
    payload,
  }
}

interface StateOptions {
  data?: CandidateFunnelArtifact | null
  status?: CandidateStatus
  timestamp?: string | null
  crossTabStale?: boolean
  ambientHoldings?: Holding[]
  official?: AppState['officialDecision']
}

function state(options: StateOptions = {}): AppState {
  const data = options.data === undefined ? artifact() : options.data
  const status = Object.prototype.hasOwnProperty.call(options, 'status')
    ? options.status
    : 'loaded'
  const timestamp = options.timestamp === undefined ? data?._meta.generatedAt ?? null : options.timestamp
  return {
    holdings: options.ambientHoldings ?? [],
    analysis: [],
    candidateFunnel: data,
    officialDecision: options.official ?? null,
    system: {
      dataSourceStatus: { candidateFunnel: status },
      dataTimestamps: { candidateFunnel: timestamp },
      crossTabInvalidation: options.crossTabStale ? { status: 'stale' } : undefined,
    },
  } as unknown as AppState
}

function forbiddenKeys(value: unknown): string[] {
  const forbidden = new Set([
    'action',
    'officialDecision',
    'BUY_NEW',
    'BUY_MORE',
    'amount',
    'quantity',
    'shares',
    'order',
    'recommendedTrade',
    'executable',
  ])
  const found = new Set<string>()
  const seen = new WeakSet<object>()
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object') return
    if (seen.has(current)) return
    seen.add(current)
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    for (const [key, nested] of Object.entries(current)) {
      if (forbidden.has(key)) found.add(key)
      visit(nested)
    }
  }
  visit(value)
  return [...found]
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('P5-B005-C-B2 candidate source adapter', () => {
  it('maps loaded + fresh to available and preserves the current artifact', () => {
    const current = artifact()
    expect(selectCandidatePortfolioFitCandidateSource(
      state({ data: current }),
      EVALUATED_AT,
    )).toEqual({ status: 'available', artifact: current, freshness: 'fresh' })
  })

  it('maps loaded + stale to available/stale without promotion', () => {
    const current = artifact()
    const evaluatedAt = new Date(
      Date.parse(current._meta.generatedAt) + 49 * HOUR_MS,
    ).toISOString()
    expect(selectCandidatePortfolioFitCandidateSource(
      state({ data: current }),
      evaluatedAt,
    )).toEqual({ status: 'available', artifact: current, freshness: 'stale' })
  })

  it.each(['cache_fallback', 'seed_fallback'] as const)(
    'maps loaded + %s to available/degraded without promotion',
    pipelinePath => {
      const current = artifact()
      current._meta.pipelinePath = pipelinePath
      expect(selectCandidatePortfolioFitCandidateSource(
        state({ data: current }),
        EVALUATED_AT,
      )).toEqual({ status: 'available', artifact: current, freshness: 'degraded' })
    },
  )

  it('maps unavailable to unavailable with no artifact', () => {
    expect(selectCandidatePortfolioFitCandidateSource(
      state({ data: null, status: 'unavailable', timestamp: null }),
      EVALUATED_AT,
    )).toEqual({ status: 'unavailable', artifact: null, freshness: 'unavailable' })
  })

  it('maps invalid to invalid with no artifact', () => {
    expect(selectCandidatePortfolioFitCandidateSource(
      state({ data: null, status: 'invalid', timestamp: null }),
      EVALUATED_AT,
    )).toEqual({ status: 'invalid', artifact: null, freshness: 'invalid' })
  })

  it.each([
    ['loaded with null data', state({ data: null, status: 'loaded', timestamp: null })],
    ['loaded with mismatched timestamp', state({ timestamp: '2026-01-01T00:00:00.000Z' })],
    ['missing status with artifact', state({ status: undefined })],
  ])('maps status/data/timestamp inconsistency to invalid: %s', (_label, inconsistent) => {
    expect(selectCandidatePortfolioFitCandidateSource(
      inconsistent,
      EVALUATED_AT,
    )).toEqual({ status: 'invalid', artifact: null, freshness: 'invalid' })
  })

  it.each(['unavailable', 'invalid'] as const)(
    'never reuses an old artifact when status is %s',
    status => {
      expect(selectCandidatePortfolioFitCandidateSource(
        state({ status }),
        EVALUATED_AT,
      )).toEqual({ status: 'invalid', artifact: null, freshness: 'invalid' })
    },
  )
})

describe('P5-B005-C-B2 canonical authority and cross-tab join', () => {
  it('builds an input from canonical holdings rather than different ambient holdings', () => {
    const canonical = committed([holding('1002')])
    const input = buildCandidatePortfolioFitInput({
      state: state({ ambientHoldings: [holding('1003', 999_999)] }),
      canonicalGeneration: canonical,
      evaluatedAt: EVALUATED_AT,
    })
    expect(input.portfolioSnapshot).toMatchObject({
      existence: 'present_nonempty',
      holdings: canonical.payload.holdings,
    })
    if (input.portfolioSnapshot?.existence !== 'present_nonempty') {
      throw new Error('expected committed snapshot')
    }
    expect(input.portfolioSnapshot.holdings).toBe(canonical.payload.holdings)
  })

  it('does not fall back to ambient holdings when canonical is none', () => {
    const input = buildCandidatePortfolioFitInput({
      state: state({ ambientHoldings: [holding('1002')] }),
      canonicalGeneration: { status: 'none' },
      evaluatedAt: EVALUATED_AT,
    })
    expect(input.portfolioSnapshot).toBeNull()
  })

  it('does not fall back to ambient holdings when canonical is invalid', () => {
    const input = buildCandidatePortfolioFitInput({
      state: state({ ambientHoldings: [holding('1002')] }),
      canonicalGeneration: { status: 'invalid' },
      evaluatedAt: EVALUATED_AT,
    })
    expect(input.portfolioSnapshot).toEqual({
      existence: 'invalid',
      error: 'CANONICAL_ENVELOPE_INVALID',
    })
  })

  it('maps no invalidation to current', () => {
    expect(buildCandidatePortfolioFitInput({
      state: state(),
      canonicalGeneration: committed(),
      evaluatedAt: EVALUATED_AT,
    }).portfolioSnapshot).toMatchObject({ crossTabState: 'current' })
  })

  it('maps stale invalidation to stale without changing canonical payload', () => {
    const canonical = committed()
    const before = structuredClone(canonical)
    expect(buildCandidatePortfolioFitInput({
      state: state({ crossTabStale: true }),
      canonicalGeneration: canonical,
      evaluatedAt: EVALUATED_AT,
    }).portfolioSnapshot).toMatchObject({ crossTabState: 'stale' })
    expect(canonical).toEqual(before)
  })

  it('propagates cross-tab stale through the engine as unavailable freshness', () => {
    const result = selectCandidatePortfolioFit(
      state({ crossTabStale: true }),
      committed(),
      EVALUATED_AT,
    )
    expect(result.portfolioFreshness).toBe('stale')
    expect(result.status).toBe('unavailable')
    expect(result.degradationReasons).toContain('CROSS_TAB_STATE_STALE')
  })

  it('leaves market fields unchanged when cross-tab state is stale', () => {
    const current = artifact()
    const marketBefore = structuredClone(current.candidates)
    const result = selectCandidatePortfolioFit(
      state({ data: current, crossTabStale: true }),
      committed(),
      EVALUATED_AT,
    )
    expect(current.candidates).toEqual(marketBefore)
    expect(result.records.map(record => ({
      marketRank: record.candidateMarketRank,
      tier: record.candidateTier,
    }))).toEqual(current.candidates
      .filter(candidate => candidate.tier === 'deep_review' || candidate.tier === 'actionable')
      .map(candidate => ({ marketRank: candidate.marketRank, tier: candidate.tier })))
  })
})

describe('P5-B005-C-B2 pure runtime selector', () => {
  it('emits only the F2 deep_review/actionable records in artifact order', () => {
    const result = selectCandidatePortfolioFit(state(), committed(), EVALUATED_AT)
    expect(result.records.map(record => [record.code, record.candidateTier])).toEqual([
      ['1002', 'deep_review'],
      ['1003', 'actionable'],
    ])
  })

  it('keeps every categorical score and rank null', () => {
    const result = selectCandidatePortfolioFit(state(), committed(), EVALUATED_AT)
    expect(result.records.every(record =>
      record.portfolioFitScore === null && record.portfolioFitRank === null,
    )).toBe(true)
  })

  it('uses canonical holdings when ambient holdings disagree', () => {
    const result = selectCandidatePortfolioFit(
      state({ ambientHoldings: [holding('1003')] }),
      committed([holding('1002')]),
      EVALUATED_AT,
    )
    expect(result.records.map(record => [record.code, record.holdingRelationship])).toEqual([
      ['1002', 'already_held'],
      ['1003', 'new_to_portfolio'],
    ])
  })

  it('keeps canonical absent distinct from committed present_empty', () => {
    const current = state({ ambientHoldings: [holding('1002')] })
    const absent = selectCandidatePortfolioFit(current, { status: 'none' }, EVALUATED_AT)
    const empty = selectCandidatePortfolioFit(current, committed([]), EVALUATED_AT)
    expect(absent.status).toBe('unavailable')
    expect(absent.portfolioFreshness).toBe('unavailable')
    expect(empty.portfolioFreshness).toBe('fresh')
    expect(empty.records.map(record => record.holdingRelationship)).toEqual([
      'new_to_portfolio',
      'new_to_portfolio',
    ])
    expect(empty).not.toEqual(absent)
  })

  it('keeps canonical invalid distinct from absent and never evaluates ambient holdings', () => {
    const current = state({ ambientHoldings: [holding('1002')] })
    const absent = selectCandidatePortfolioFit(current, { status: 'none' }, EVALUATED_AT)
    const invalid = selectCandidatePortfolioFit(current, { status: 'invalid' }, EVALUATED_AT)
    expect(invalid.status).toBe('invalid')
    expect(invalid.portfolioFreshness).toBe('invalid')
    expect(invalid.records.every(record =>
      record.holdingRelationship === 'holding_match_unknown',
    )).toBe(true)
    expect(invalid).not.toEqual(absent)
  })

  it('passes the caller-injected evaluatedAt through exactly', () => {
    expect(selectCandidatePortfolioFit(
      state(),
      committed(),
      '2026-07-26T08:00:00.123Z',
    ).evaluatedAt).toBe('2026-07-26T08:00:00.123Z')
  })

  it('fail-closes an invalid caller-injected evaluatedAt', () => {
    const result = selectCandidatePortfolioFit(state(), committed(), 'not-a-timestamp')
    expect(result.status).toBe('invalid')
    expect(result.records).toEqual([])
  })

  it('is deep-equal over 100 deterministic replays', () => {
    const current = state()
    const canonical = committed()
    const expected = selectCandidatePortfolioFit(current, canonical, EVALUATED_AT)
    for (let index = 0; index < 100; index += 1) {
      expect(selectCandidatePortfolioFit(current, canonical, EVALUATED_AT)).toEqual(expected)
    }
  })

  it('does not mutate its state, canonical input, or candidate artifact', () => {
    const current = state()
    const canonical = committed()
    const stateBefore = structuredClone(current)
    const canonicalBefore = structuredClone(canonical)
    selectCandidatePortfolioFit(current, canonical, EVALUATED_AT)
    expect(current).toEqual(stateBefore)
    expect(canonical).toEqual(canonicalBefore)
  })

  it('does not notify Zustand subscribers', () => {
    const current = state()
    const store = createStore<AppState>(() => current)
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })
    selectCandidatePortfolioFit(store.getState(), committed(), EVALUATED_AT)
    unsubscribe()
    expect(notifications).toBe(0)
    expect(store.getState()).toBe(current)
  })

  it('leaves the ambient decision reference and analysis inputs unchanged', () => {
    const official = { marker: 'unchanged' } as unknown as AppState['officialDecision']
    const current = state({ official })
    const analysisBefore = current.analysis
    selectCandidatePortfolioFit(current, committed(), EVALUATED_AT)
    expect(current.officialDecision).toBe(official)
    expect(current.analysis).toBe(analysisBefore)
  })

  it('does not persist or send the result', () => {
    const setItem = vi.fn()
    const fetchSpy = vi.fn()
    const sendBeacon = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem,
      removeItem: vi.fn(),
    })
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('navigator', { sendBeacon })
    selectCandidatePortfolioFit(state(), committed(), EVALUATED_AT)
    expect(setItem).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(sendBeacon).not.toHaveBeenCalled()
  })

  it('emits no forbidden trade or sizing output key', () => {
    expect(forbiddenKeys(
      selectCandidatePortfolioFit(state(), committed(), EVALUATED_AT),
    )).toEqual([])
  })

  it('preserves candidate marketRank, tier, and complete artifact bytes', () => {
    const currentArtifact = artifact()
    const before = structuredClone(currentArtifact)
    const result = selectCandidatePortfolioFit(
      state({ data: currentArtifact }),
      committed(),
      EVALUATED_AT,
    )
    expect(currentArtifact).toEqual(before)
    expect(result.records.map(record => record.candidateMarketRank)).toEqual([1, 1])
    expect(result.records.map(record => record.candidateTier)).toEqual([
      'deep_review',
      'actionable',
    ])
  })

  it('source contract contains no persistence, network, legacy, decision, or trade seam', () => {
    const source = readFileSync(new URL('./portfolioFitSelectors.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/Date\.now|new Date|Math\.random|localeCompare/)
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|CacheStorage/)
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|analytics/)
    expect(source).not.toMatch(/public\/data|candidate_portfolio_fit|writeFile|console\.log/)
    expect(source).not.toMatch(/stockCandidates|candidatesStocks|applyCandidateConstraints|committeeDecision/)
    expect(source).not.toMatch(/\bofficialDecision\b|\bBUY_NEW\b|\bBUY_MORE\b/)
    expect(source).not.toMatch(/\bSAFE_MODE\b|\bTierA\b|\bsizing\b/)
    expect(source).not.toMatch(/\bamount\b|\bquantity\b|\border\b/)
  })
})
