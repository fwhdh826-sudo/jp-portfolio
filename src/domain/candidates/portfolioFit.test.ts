// ═══════════════════════════════════════════════════════════
// P5-B005-C-B1: portfolioFit categorical v1 — behavioral domain tests。
//
// Authority: /Users/ryo/jp-portfolio-audit-reports/
//   p5-b005-c-a2-portfolio-fit-frozen-specification.md §13 (52 groups, T-01..T-52)
//
// Fixtureはすべてliteral expected valuesで記述する（production出力を
// oracleにしない）。evaluatedAtは全fixtureでcaller-injectedとし、
// engine内でDate.now/Math.random/localeCompare/network/localStorageを
// 一切使用しないことを前提に検証する。
// ═══════════════════════════════════════════════════════════

// このプロジェクトは @types/node を導入していない（package.json変更はticket
// scope外）。既存 src/types/candidateFunnel.contract.test.ts と同じ手法で
// 最小 ambient 宣言経由で fs.readFileSync のみを取得する。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function require(id: string): any
}

import { describe, expect, it } from 'vitest'
import type { CandidateFunnelArtifact, CandidateFunnelArtifactMeta } from '../../types/candidateFunnelArtifact'
import type { CandidateFunnelCandidate, CandidateFunnelTier } from '../../types/candidateFunnel'
import type { CashAssumptions, CsvImportProvenance, Holding, PortfolioPolicy, Trust } from '../../types/index'
import type {
  CandidatePortfolioFitCandidateSource,
  CandidatePortfolioFitInput,
  PortfolioFitSnapshotInput,
} from '../../types/candidatePortfolioFit'
import { aggregatePortfolioFitHoldings, computePortfolioFit, normalizePortfolioFitCode } from './portfolioFit'

// ── 固定時刻（Date.now禁止 — 全fixtureがevaluatedAtを注入する） ──────
const BASE = '2026-01-10T00:00:00.000Z'
const BASE_MS = Date.parse(BASE)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

// ── Fixture builders ──────────────────────────────────────────────────
function makeCandidate(overrides: Partial<CandidateFunnelCandidate> = {}): CandidateFunnelCandidate {
  return {
    code: '7203',
    name: 'Toyota',
    sector: 'Automobiles',
    prescreenScore: 80,
    prescreenRank: 1,
    prescreenPool: 'main',
    scoreBreakdown: [],
    rawCompositeScore: 70,
    dataConfidence: 0.9,
    marketScore: 70,
    marketRank: 1,
    tier: 'deep_review',
    selectedReasons: ['SELECTED_DEEP_REVIEW'],
    riskReasons: [],
    hardExclusionReasons: [],
    themes: [],
    themeStatus: 'unavailable',
    dataStatus: 'ok',
    ...overrides,
  }
}

function makeArtifact(
  candidates: CandidateFunnelCandidate[],
  metaOverrides: Partial<CandidateFunnelArtifactMeta> = {},
): CandidateFunnelArtifact {
  return {
    schemaVersion: 'candidate-funnel-1',
    funnelVersion: 'candidate-funnel-v1',
    scoreVersion: 'market-score-v1',
    not_for_trading: true,
    status: 'generated',
    degradationReasons: [],
    counts: {
      total: candidates.length,
      excluded: 0,
      screened: 0,
      deepReview: candidates.filter((c) => c.tier === 'deep_review').length,
      actionable: candidates.filter((c) => c.tier === 'actionable').length,
    },
    candidates,
    excludedSummary: { total: 0, byReason: {} },
    sectorDistribution: { screened: {}, deepReview: {}, actionable: {} },
    scoreDistribution: { count: candidates.length, min: null, max: null, mean: null, median: null },
    selectionObservability: {
      regimeApplied: null,
      actionableHardMaxApplied: null,
      actionableSectorCapApplied: null,
      deepReviewHardMaxApplied: null,
      deepReviewSectorCapApplied: null,
      deepReviewSectorCapRelaxed: false,
      actionableSectorCapRelaxed: false,
      deepReviewSectorCapOverflow: {},
      actionableSectorCapOverflow: {},
      deepReviewEligibleCount: 0,
      deepReviewSelectedCount: 0,
      actionableEligibleCount: 0,
      actionableSelectedCount: 0,
      sourceStale: false,
      fallbackProvenance: false,
    },
    _meta: {
      kind: 'candidate_funnel',
      not_for_trading: true,
      generatedAt: BASE,
      asOf: BASE,
      sourceUpdatedAt: null,
      pipelinePath: 'normal',
      regimeRequested: null,
      join: {
        candidateCount: candidates.length,
        prescreenCount: candidates.length,
        joinedCount: candidates.length,
        unmatchedCandidateCount: 0,
        unmatchedPrescreenCount: 0,
        joinRate: 1,
        unmatchedCandidateRate: 0,
      },
      qualityGate: { gates: [], overallPass: true, hardFailIds: [], notes: [] },
      ...metaOverrides,
    },
  }
}

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '7203',
    name: 'Toyota',
    eval: 1000,
    pnlPct: 0,
    mu: 0,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1,
    sector: 'Automobiles',
    target: 0,
    alert: 0,
    lock: false,
    mitsu: false,
    ma: false,
    rsi: 50,
    macd: false,
    vol: false,
    mom3m: 0,
    roe: 0,
    per: 0,
    pbr: 0,
    epsG: 0,
    cfOk: true,
    de: 0,
    divG: 0,
    score: 0,
    decision: 'HOLD',
    ev: 0,
    ...overrides,
  }
}

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 't1',
    name: 'Trust',
    abbr: 'T',
    account: 'a',
    policy: 'JAPAN_SHORTTERM',
    eval: 0,
    pnlPct: 0,
    dayPct: 0,
    cost: 0,
    mu: 0,
    sigma: 0,
    score: 0,
    signal: '',
    ev: 0,
    decision: 'HOLD',
    ...overrides,
  }
}

function makeProvenance(overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return {
    sourceAsOf: BASE,
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    contentFingerprint: 'fp',
    sourceFileName: 'x.csv',
    fileLastModified: null,
    importedAt: BASE,
    ...overrides,
  }
}

function makePolicy(overrides: Partial<PortfolioPolicy> = {}): PortfolioPolicy {
  return { jpStockMaxRatio: 0.1, ...overrides }
}

function makeSnapshot(
  holdings: Holding[] = [],
  overrides: Partial<Extract<PortfolioFitSnapshotInput, { existence: 'present_empty' | 'present_nonempty' }>> = {},
): PortfolioFitSnapshotInput {
  return {
    existence: holdings.length === 0 ? 'present_empty' : 'present_nonempty',
    schemaVersion: 'csv-import-generation-5',
    generationId: 'gen-1',
    savedAt: 0,
    holdings,
    trusts: [],
    portfolioPolicy: makePolicy(),
    cashAssumptions: null,
    provenance: makeProvenance(),
    csvImportedAt: null,
    crossTabState: 'current',
    ...overrides,
  }
}

function availableSource(
  artifact: CandidateFunnelArtifact,
  freshness: 'fresh' | 'stale' | 'degraded' = 'fresh',
): CandidatePortfolioFitCandidateSource {
  return { status: 'available', artifact, freshness }
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    Object.values(obj as Record<string, unknown>).forEach((v) => deepFreeze(v))
    Object.freeze(obj)
  }
  return obj
}

// ═══════════════════════════════════════════════════════════
// §13 T-01..T-52
// ═══════════════════════════════════════════════════════════
describe('P5-B005-C-B1 portfolioFit — 52 frozen test groups', () => {
  it('T-01: marketScore unchanged after engine run', () => {
    const candidate = makeCandidate({ marketScore: 63.25 })
    const artifact = makeArtifact([candidate])
    const clone = JSON.parse(JSON.stringify(artifact))
    const input = deepFreeze({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    computePortfolioFit(input)
    expect(artifact.candidates[0].marketScore).toBe(63.25)
    expect(artifact).toEqual(clone)
  })

  it('T-02: marketRank unchanged after engine run', () => {
    const candidate = makeCandidate({ marketRank: 7 })
    const artifact = makeArtifact([candidate])
    const input = deepFreeze({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    computePortfolioFit(input)
    expect(artifact.candidates[0].marketRank).toBe(7)
  })

  it('T-03: tier unchanged after engine run', () => {
    const candidate = makeCandidate({ tier: 'actionable' })
    const artifact = makeArtifact([candidate])
    const input = deepFreeze({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    computePortfolioFit(input)
    expect(artifact.candidates[0].tier).toBe('actionable')
  })

  it('T-04: whole frozen candidate input deep-equal after run (no mutation)', () => {
    const candidates = [makeCandidate({ code: '7203' }), makeCandidate({ code: '9432', tier: 'actionable' })]
    const artifact = makeArtifact(candidates)
    const before = JSON.parse(JSON.stringify(artifact))
    const input = deepFreeze({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    computePortfolioFit(input)
    expect(artifact).toEqual(before)
  })

  it('T-05: all five tiers -> only deep_review/actionable records emitted', () => {
    const tiers: CandidateFunnelTier[] = ['excluded', 'eligible', 'screened', 'deep_review', 'actionable']
    const candidates = tiers.map((tier, i) => makeCandidate({ code: `100${i}`, tier }))
    const artifact = makeArtifact(candidates)
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records.map((r) => r.candidateTier)).toEqual(['deep_review', 'actionable'])
    expect(result.records).toHaveLength(2)
  })

  it('T-06: screened record -> no output record', () => {
    const artifact = makeArtifact([makeCandidate({ tier: 'screened' })])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records).toHaveLength(0)
  })

  it('T-07: actionable+deep_review -> both emitted, artifact order preserved', () => {
    const candidates = [
      makeCandidate({ code: '1001', tier: 'actionable' }),
      makeCandidate({ code: '1002', tier: 'deep_review' }),
    ]
    const artifact = makeArtifact(candidates)
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records.map((r) => r.code)).toEqual(['1001', '1002'])
    expect(result.records.map((r) => r.artifactIndex)).toEqual([0, 1])
  })

  it('T-08: 7203 holding eval>0 -> already_held', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const snapshot = makeSnapshot([makeHolding({ code: '7203', eval: 500 })])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.records[0].holdingRelationship).toBe('already_held')
    // already_held is descriptive only — never an automatic penalty on status.
    expect(result.records[0].portfolioFitStatus).toBe('evaluated')
  })

  it('T-09: candidate without match -> new_to_portfolio', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const snapshot = makeSnapshot([makeHolding({ code: '9999', eval: 500 })])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.records[0].holdingRelationship).toBe('new_to_portfolio')
  })

  it('T-10: invalid holding code, no positive match -> unknown + HOLDING_MATCH_UNKNOWN', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const snapshot = makeSnapshot([makeHolding({ code: '72 03', eval: 500 })])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.records[0].holdingRelationship).toBe('holding_match_unknown')
    expect(result.records[0].fitRisks).toContain('HOLDING_MATCH_UNKNOWN')
    const sameCode = result.records[0].components.find((c) => c.id === 'same_code_relationship')!
    expect(sameCode.value).toBeNull() // never a dummy fabricated value when unknown
  })

  it('T-11: whitespace/full-width codes -> canonical 7203', () => {
    expect(normalizePortfolioFitCode(' 7203 ').normalizedCode).toBe('7203')
    expect(normalizePortfolioFitCode('７２０３').normalizedCode).toBe('7203')
    expect(normalizePortfolioFitCode('7203.T').normalizedCode).toBe('7203')
  })

  it('T-12: number/string 7203 -> same canonical', () => {
    expect(normalizePortfolioFitCode(7203).normalizedCode).toBe('7203')
    expect(normalizePortfolioFitCode('7203').normalizedCode).toBe('7203')
  })

  it('T-13: leading zero preserved (0130)', () => {
    expect(normalizePortfolioFitCode('0130')).toEqual({ status: 'valid', normalizedCode: '0130' })
  })

  it('T-14: alphanumeric suffix -> 130A', () => {
    expect(normalizePortfolioFitCode('130a.T')).toEqual({ status: 'valid', normalizedCode: '130A' })
  })

  it('T-15: decimal/fraction/I/O codes -> invalid', () => {
    expect(normalizePortfolioFitCode(7203.5).status).toBe('invalid')
    expect(normalizePortfolioFitCode('7203.0').status).toBe('invalid')
    expect(normalizePortfolioFitCode('').status).toBe('invalid')
    expect(normalizePortfolioFitCode('720').status).toBe('invalid')
    expect(normalizePortfolioFitCode('72030').status).toBe('invalid')
    expect(normalizePortfolioFitCode('72 03').status).toBe('invalid')
    expect(normalizePortfolioFitCode('720I').status).toBe('invalid')
    expect(normalizePortfolioFitCode('720O').status).toBe('invalid')
  })

  it('T-16: duplicate holding values 100+200 -> aggregate total 300 / count 2', () => {
    const agg = aggregatePortfolioFitHoldings([
      makeHolding({ code: '7203', eval: 100 }),
      makeHolding({ code: '7203', eval: 200 }),
    ])
    expect(agg.aggregates).toHaveLength(1)
    expect(agg.aggregates[0]).toMatchObject({ normalizedCode: '7203', totalCurrentValue: 300, sourceRecordCount: 2, dataStatus: 'complete' })
    expect(agg.hasDuplicateCode).toBe(true)
  })

  it('T-17: duplicate valid100+missing -> total100/partial', () => {
    const agg = aggregatePortfolioFitHoldings([
      makeHolding({ code: '7203', eval: 100 }),
      makeHolding({ code: '7203', eval: Number.NaN }),
    ])
    expect(agg.aggregates[0]).toMatchObject({ totalCurrentValue: 100, sourceRecordCount: 2, dataStatus: 'partial' })
    expect(agg.hasPartialValue).toBe(true)
  })

  it('T-18: all values invalid -> null/invalid', () => {
    const agg = aggregatePortfolioFitHoldings([
      makeHolding({ code: '7203', eval: Number.NaN }),
      makeHolding({ code: '7203', eval: -5 }),
    ])
    expect(agg.aggregates[0]).toMatchObject({ totalCurrentValue: null, dataStatus: 'invalid' })
  })

  it('T-19: multiple acquiredAt -> latest valid date retained', () => {
    const agg = aggregatePortfolioFitHoldings([
      makeHolding({ code: '7203', eval: 100, acquiredAt: '2020-01-01' }),
      makeHolding({ code: '7203', eval: 100, acquiredAt: '2022-06-15' }),
      makeHolding({ code: '7203', eval: 100, acquiredAt: 'not-a-date' }),
    ])
    expect(agg.aggregates[0].acquiredAtForLock).toBe('2022-06-15')
    expect(agg.aggregates[0].dataStatus).toBe('partial') // malformed date makes partial
  })

  it('T-20: snapshot null -> unavailable/unknown/nulls', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: null, evaluatedAt: BASE })
    expect(result.portfolioFreshness).toBe('unavailable')
    expect(result.status).toBe('unavailable')
    expect(result.capacity.status).toBe('unavailable')
    expect(result.records[0].holdingRelationship).toBe('holding_match_unknown')
    expect(result.records[0].portfolioFitScore).toBeNull()
    expect(result.records[0].portfolioFitRank).toBeNull()
  })

  it('T-21: committed present_empty -> new; exposure/concentration 0', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203', sector: 'Automobiles' })])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records[0].holdingRelationship).toBe('new_to_portfolio')
    const concentration = result.records[0].components.find((c) => c.id === 'existing_concentration')!
    const sector = result.records[0].components.find((c) => c.id === 'sector_diversification')!
    expect(concentration.value).toBe(0)
    expect(sector.value).toBe(0)
  })

  it('T-22: invalid envelope -> invalid fit; market unchanged', () => {
    const candidate = makeCandidate({ code: '7203', marketScore: 55 })
    const artifact = makeArtifact([candidate])
    const snapshot: PortfolioFitSnapshotInput = { existence: 'invalid', error: 'CANONICAL_ENVELOPE_INVALID' }
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.portfolioFreshness).toBe('invalid')
    expect(result.records[0].portfolioFitStatus).toBe('invalid')
    expect(artifact.candidates[0].marketScore).toBe(55)
  })

  it('T-23: source exactly 90d -> fresh', () => {
    const artifact = makeArtifact([makeCandidate()])
    const snapshot = makeSnapshot([], { provenance: makeProvenance({ sourceAsOf: iso(BASE_MS - 90 * DAY) }) })
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.portfolioFreshness).toBe('fresh')
  })

  it('T-24: source 90d+1ms -> stale/no evaluation', () => {
    const artifact = makeArtifact([makeCandidate()])
    const snapshot = makeSnapshot([], { provenance: makeProvenance({ sourceAsOf: iso(BASE_MS - 90 * DAY - 1) }) })
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.portfolioFreshness).toBe('stale')
    expect(result.records[0].portfolioFitStatus).toBe('unavailable')
  })

  it('T-25: source missing, importedAt current -> partial, never fresh', () => {
    const artifact = makeArtifact([makeCandidate()])
    const snapshot = makeSnapshot([], {
      // confidence自体はauthoritativeでも、sourceAsOfが欠落している限りimportedAt
      // へのfallbackは禁止 — partialのまま（fresh昇格禁止）でなければならない。
      provenance: makeProvenance({ sourceAsOf: null, sourceAsOfKind: 'unknown', sourceAsOfConfidence: 'authoritative' }),
      csvImportedAt: BASE,
    })
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.portfolioFreshness).toBe('partial')
  })

  it('T-26: source future+1ms -> invalid', () => {
    const artifact = makeArtifact([makeCandidate()])
    const snapshot = makeSnapshot([], { provenance: makeProvenance({ sourceAsOf: iso(BASE_MS + 1) }) })
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.portfolioFreshness).toBe('invalid')
  })

  it('T-27: candidate exactly 48h -> fresh', () => {
    const artifact = makeArtifact([makeCandidate()], { generatedAt: iso(BASE_MS - 48 * HOUR) })
    const result = computePortfolioFit({
      candidateSource: availableSource(artifact, 'fresh'),
      portfolioSnapshot: makeSnapshot([]),
      evaluatedAt: BASE,
    })
    expect(result.status).not.toBe('unavailable')
    expect(result.records[0].holdingRelationship).toBe('new_to_portfolio')
  })

  it('T-28: candidate 48h+1ms -> unavailable', () => {
    const artifact = makeArtifact([makeCandidate()], { generatedAt: iso(BASE_MS - 48 * HOUR - 1) })
    const result = computePortfolioFit({
      candidateSource: availableSource(artifact, 'fresh'),
      portfolioSnapshot: makeSnapshot([]),
      evaluatedAt: BASE,
    })
    expect(result.status).toBe('unavailable')
    expect(result.records[0].holdingRelationship).toBe('holding_match_unknown')
    expect(result.degradationReasons).toContain('CANDIDATE_INPUT_STALE')
  })

  it('T-29: sector missing/未分類 on a positive holding -> partial/value null', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203', sector: 'Automobiles' })])
    const snapshot = makeSnapshot([
      makeHolding({ code: '7203', eval: 100, sector: 'Automobiles' }),
      makeHolding({ code: '9999', eval: 50, sector: '未分類' }),
    ])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    const sector = result.records[0].components.find((c) => c.id === 'sector_diversification')!
    expect(sector.status).toBe('partial')
    expect(sector.value).toBeNull()
    expect(sector.risks).toContain('SECTOR_AUTHORITY_PARTIAL')
  })

  it('T-30: complete sectors -> exact exposure ratio', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203', sector: 'Automobiles' })])
    const snapshot = makeSnapshot([
      makeHolding({ code: '7203', eval: 100, sector: 'Automobiles' }),
      makeHolding({ code: '9999', eval: 300, sector: 'Banks' }),
    ])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    const sector = result.records[0].components.find((c) => c.id === 'sector_diversification')!
    expect(sector.status).toBe('evaluated')
    expect(sector.value).toBe(100 / 400)
  })

  it('T-31: fresh manual cash, delta>0 -> capacity available', () => {
    const artifact = makeArtifact([makeCandidate()])
    const cash: CashAssumptions = { cashDeposits: 1_000_000, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: BASE }
    const snapshot = makeSnapshot([], {
      trusts: [makeTrust({ eval: 200_000 })],
      cashAssumptions: cash,
      portfolioPolicy: makePolicy({ jpStockMaxRatio: 0.3 }),
    })
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.capacity.status).toBe('available')
  })

  it('T-32: fresh inputs, delta<=0 -> constrained', () => {
    const artifact = makeArtifact([makeCandidate()])
    const cash: CashAssumptions = { cashDeposits: 100, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: BASE }
    const snapshot = makeSnapshot([makeHolding({ code: '1234', eval: 100_000 })], {
      cashAssumptions: cash,
      portfolioPolicy: makePolicy({ jpStockMaxRatio: 0.05 }),
    })
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.capacity.status).toBe('constrained')
  })

  it('T-33: disabled/default cash -> capacity unknown', () => {
    const artifact = makeArtifact([makeCandidate()])
    const cash: CashAssumptions = { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null }
    const snapshot = makeSnapshot([makeHolding({ code: '1234', eval: 1000 })], { cashAssumptions: cash })
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    expect(result.capacity.status).toBe('unknown')
    expect(result.capacity.reasons).toContain('CASH_AUTHORITY_UNAVAILABLE')
  })

  it('T-34: missing cash vs manual zero -> different status', () => {
    const artifact = makeArtifact([makeCandidate()])
    const holdings = [makeHolding({ code: '1234', eval: 1000 })]
    const missingCashSnapshot = makeSnapshot(holdings, { cashAssumptions: null })
    const manualZeroSnapshot = makeSnapshot(holdings, {
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: BASE },
      portfolioPolicy: makePolicy({ jpStockMaxRatio: 0.3 }),
    })
    const missingResult = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: missingCashSnapshot, evaluatedAt: BASE })
    const zeroResult = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: manualZeroSnapshot, evaluatedAt: BASE })
    expect(missingResult.capacity.status).toBe('unknown')
    expect(zeroResult.capacity.status).not.toBe('unknown')
  })

  it('T-35: absent vs present_empty -> different result', () => {
    const artifact = makeArtifact([makeCandidate()])
    const absentResult = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: null, evaluatedAt: BASE })
    const emptyResult = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(absentResult.records[0].holdingRelationship).toBe('holding_match_unknown')
    expect(emptyResult.records[0].holdingRelationship).toBe('new_to_portfolio')
    expect(absentResult.status).not.toBe(emptyResult.status)
  })

  it('T-36: capacity delta positive/zero/negative -> fit records deep-equal', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const holdings = [makeHolding({ code: '7203', eval: 1000 })]
    const base = makeSnapshot(holdings, { cashAssumptions: { cashDeposits: 9000, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: BASE } })
    const withHeadroom = { ...base, portfolioPolicy: makePolicy({ jpStockMaxRatio: 0.3 }) }
    const constrained = { ...base, portfolioPolicy: makePolicy({ jpStockMaxRatio: 0.05 }) }
    const r1 = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: withHeadroom, evaluatedAt: BASE })
    const r2 = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: constrained, evaluatedAt: BASE })
    expect(r1.records).toEqual(r2.records)
    expect(r1.capacity.status).not.toBe(r2.capacity.status)
  })

  it('T-37: no SAFE_MODE coupling — identical logical input -> deep-equal fit', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const snapshot = makeSnapshot([makeHolding({ code: '7203', eval: 100 })])
    const input: CandidatePortfolioFitInput = { candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE }
    const r1 = computePortfolioFit(input)
    const r2 = computePortfolioFit(input)
    expect(r1.records).toEqual(r2.records)
  })

  it('T-38: no TierA coupling — identical logical input -> deep-equal fit', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const snapshot = makeSnapshot([makeHolding({ code: '7203', eval: 100 })])
    const input: CandidatePortfolioFitInput = { candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE }
    const r1 = computePortfolioFit(input)
    const r2 = computePortfolioFit(input)
    expect(r1.records).toEqual(r2.records)
  })

  it('T-39: lock/acquiredAt variants -> fit/capacity deep-equal', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const snapshotA = makeSnapshot([makeHolding({ code: '7203', eval: 100, lock: true, acquiredAt: '2020-01-01' })])
    const snapshotB = makeSnapshot([makeHolding({ code: '7203', eval: 100, lock: false, acquiredAt: '2024-05-05' })])
    const rA = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshotA, evaluatedAt: BASE })
    const rB = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshotB, evaluatedAt: BASE })
    expect(rA.records).toEqual(rB.records)
    expect(rA.capacity).toEqual(rB.capacity)
  })

  it('T-40: duplicate candidate code -> both records kept, unique IDs', () => {
    const candidates = [makeCandidate({ code: '7203' }), makeCandidate({ code: ' 7203 ', tier: 'actionable' })]
    const artifact = makeArtifact(candidates)
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records).toHaveLength(2)
    expect(result.records.map((r) => r.candidateRecordId)).toEqual(['artifact:0', 'artifact:1'])
    expect(result.degradationReasons).toContain('DUPLICATE_CANDIDATE_CODE')
  })

  it('T-41: categorical output -> every score/rank null', () => {
    const candidates = [makeCandidate({ code: '7203' }), makeCandidate({ code: '9432', tier: 'actionable' })]
    const artifact = makeArtifact(candidates)
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: null, evaluatedAt: BASE })
    for (const r of result.records) {
      expect(r.portfolioFitScore).toBeNull()
      expect(r.portfolioFitRank).toBeNull()
    }

    // headroom<=0 (constrained capacity) must never degrade score/rank into a
    // dummy numeric value either — capacity and fit score are independent.
    const constrainedSnapshot = makeSnapshot([makeHolding({ code: '1234', eval: 100_000 })], {
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: BASE },
      portfolioPolicy: makePolicy({ jpStockMaxRatio: 0.05 }),
    })
    const constrainedResult = computePortfolioFit({
      candidateSource: availableSource(artifact),
      portfolioSnapshot: constrainedSnapshot,
      evaluatedAt: BASE,
    })
    expect(constrainedResult.capacity.status).toBe('constrained')
    for (const r of constrainedResult.records) {
      expect(r.portfolioFitScore).toBeNull()
      expect(r.portfolioFitRank).toBeNull()
    }
  })

  it('T-42: no active numeric tie-break — output order is artifact order regardless of marketRank', () => {
    const candidates = [
      makeCandidate({ code: '1001', marketRank: 5, marketScore: 60 }),
      makeCandidate({ code: '1002', marketRank: 1, marketScore: 90 }),
      makeCandidate({ code: '1003', marketRank: 3, marketScore: 75 }),
    ]
    const artifact = makeArtifact(candidates)
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records.map((r) => r.code)).toEqual(['1001', '1002', '1003'])
    expect(result.records.map((r) => r.artifactIndex)).toEqual([0, 1, 2])
  })

  it('T-43: unavailable/invalid records -> null rank, stable artifact-order tail', () => {
    const candidates = [
      makeCandidate({ code: '7203' }), // will resolve cleanly
      makeCandidate({ code: '72 03X', tier: 'actionable' }), // invalid code -> unknown
    ]
    const artifact = makeArtifact(candidates)
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records.map((r) => r.artifactIndex)).toEqual([0, 1])
    result.records.forEach((r) => expect(r.portfolioFitRank).toBeNull())
  })

  it('T-44: recursive result scan — forbidden keys absent', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' })])
    const snapshot = makeSnapshot([makeHolding({ code: '7203', eval: 100 })])
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE })
    const forbidden = [
      'action',
      'officialDecision',
      'BUY_NEW',
      'BUY_MORE',
      'SELL',
      'WATCH',
      'BLOCKED',
      'amount',
      'quantity',
      'shares',
      'order',
      'limitPrice',
      'recommendedTrade',
      'executable',
      'tradeGateStatus',
      'SOFT_PORTFOLIO_OVERLAP',
    ]
    // 値としての漏洩（例: reasons配列にSOFT_PORTFOLIO_OVERLAPを紛れ込ませる）
    // もkeyスキャンと同様に禁止する — reuse foridden不可のreserved market
    // reason codeがdataset/fit reasonへ紛れないことを保証する。
    const forbiddenValues = ['SOFT_PORTFOLIO_OVERLAP', 'BUY_NEW', 'BUY_MORE', 'officialDecision']
    const seen = new Set<object>()
    const visit = (v: unknown) => {
      if (typeof v === 'string') {
        expect(forbiddenValues).not.toContain(v)
        return
      }
      if (v === null || typeof v !== 'object') return
      if (seen.has(v as object)) return
      seen.add(v as object)
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        expect(forbidden).not.toContain(k)
        visit(val)
      }
    }
    visit(result)
  })

  // ソースコードそのもの（実行される文/識別子）のみをscanする —
  // ticketで意図的に記述されている「禁止用語」の説明コメント行は除外する。
  function stripLineComments(src: string): string {
    return src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
  }
  function readEngineSource(): string {
    const { readFileSync } = require('fs') as { readFileSync: (p: string, enc: string) => string }
    return stripLineComments(readFileSync('src/domain/candidates/portfolioFit.ts', 'utf-8'))
  }
  function readTypesSource(): string {
    const { readFileSync } = require('fs') as { readFileSync: (p: string, enc: string) => string }
    return stripLineComments(readFileSync('src/types/candidatePortfolioFit.ts', 'utf-8'))
  }

  it('T-45: source scan — officialDecision absent', () => {
    const engineSrc = readEngineSource()
    const typesSrc = readTypesSource()
    expect(engineSrc).not.toContain('officialDecision')
    expect(typesSrc).not.toContain('officialDecision')
    expect(engineSrc).not.toMatch(/\buseAppStore\b/)
    expect(engineSrc).not.toMatch(/\bSAFE_MODE\b/)
    expect(engineSrc).not.toMatch(/\btierA\b/i)
    expect(engineSrc).not.toMatch(/\bstockCandidates\b/)
    expect(engineSrc).not.toMatch(/\bapplyCandidateConstraints\b/)
    // determinism guards — no wall-clock read, no locale-dependent compare.
    expect(engineSrc).not.toMatch(/Date\.now\(\)/)
    expect(engineSrc).not.toMatch(/localeCompare/)
  })

  it('T-46: source/result scan — BUY_NEW/BUY_MORE absent', () => {
    const engineSrc = readEngineSource()
    expect(engineSrc).not.toContain('BUY_NEW')
    expect(engineSrc).not.toContain('BUY_MORE')
  })

  it('T-47: source/result scan — amount/quantity/order absent', () => {
    const engineSrc = readEngineSource()
    expect(engineSrc).not.toMatch(/\bamount\b/)
    expect(engineSrc).not.toMatch(/\bquantity\b/)
    expect(engineSrc).not.toMatch(/\border\b/)
    expect(engineSrc).not.toMatch(/\blimitPrice\b/)
  })

  it('T-48: repository/source scan — no public fit artifact/write', () => {
    const engineSrc = readEngineSource()
    expect(engineSrc).not.toMatch(/localStorage/)
    expect(engineSrc).not.toMatch(/fetch\(/)
    expect(engineSrc).not.toMatch(/XMLHttpRequest/)
    expect(engineSrc).not.toMatch(/writeFile/)
    expect(engineSrc).not.toMatch(/candidate_portfolio_fit/)
  })

  it('T-49: 100 replays -> deep-equal logical output (determinism)', () => {
    const artifact = makeArtifact([makeCandidate({ code: '7203' }), makeCandidate({ code: '9432', tier: 'actionable' })])
    const snapshot = makeSnapshot([makeHolding({ code: '7203', eval: 100 }), makeHolding({ code: '1111', eval: 50 })])
    const input: CandidatePortfolioFitInput = { candidateSource: availableSource(artifact), portfolioSnapshot: snapshot, evaluatedAt: BASE }
    const first = computePortfolioFit(input)
    for (let i = 0; i < 100; i++) {
      expect(computePortfolioFit(input)).toEqual(first)
    }
  })

  it('T-50: duplicate holding permutations -> same aggregate/reasons regardless of order', () => {
    const a = aggregatePortfolioFitHoldings([
      makeHolding({ code: '7203', eval: 100, acquiredAt: '2020-01-01' }),
      makeHolding({ code: '7203', eval: 200, acquiredAt: '2022-06-15' }),
    ])
    const b = aggregatePortfolioFitHoldings([
      makeHolding({ code: '7203', eval: 200, acquiredAt: '2022-06-15' }),
      makeHolding({ code: '7203', eval: 100, acquiredAt: '2020-01-01' }),
    ])
    expect(a.aggregates).toEqual(b.aggregates)
    expect(a.hasDuplicateCode).toBe(b.hasDuplicateCode)
  })

  it('T-51: market reason arrays — exact content/order unchanged', () => {
    const candidate = makeCandidate({
      selectedReasons: ['SELECTED_DEEP_REVIEW'],
      riskReasons: ['SOFT_WEAK_MOMENTUM', 'SOFT_STALE_SOURCE'],
      hardExclusionReasons: [],
    })
    const artifact = makeArtifact([candidate])
    computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(artifact.candidates[0].selectedReasons).toEqual(['SELECTED_DEEP_REVIEW'])
    expect(artifact.candidates[0].riskReasons).toEqual(['SOFT_WEAK_MOMENTUM', 'SOFT_STALE_SOURCE'])
  })

  it('T-52: F2 count — output count exactly matches input target count', () => {
    const candidates = [
      makeCandidate({ code: '1001', tier: 'excluded' }),
      makeCandidate({ code: '1002', tier: 'eligible' }),
      makeCandidate({ code: '1003', tier: 'screened' }),
      makeCandidate({ code: '1004', tier: 'deep_review' }),
      makeCandidate({ code: '1005', tier: 'actionable' }),
      makeCandidate({ code: '1006', tier: 'deep_review' }),
    ]
    const artifact = makeArtifact(candidates)
    const result = computePortfolioFit({ candidateSource: availableSource(artifact), portfolioSnapshot: makeSnapshot([]), evaluatedAt: BASE })
    expect(result.records).toHaveLength(3)
    expect(result.qualityGate.inputTargetCount).toBe(3)
    expect(result.qualityGate.outputRecordCount).toBe(3)
  })
})
