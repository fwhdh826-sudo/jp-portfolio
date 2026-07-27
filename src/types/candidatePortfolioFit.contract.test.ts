// ═══════════════════════════════════════════════════════════
// P5-B005-C-B1: portfolioFit categorical v1 — pure TypeScript contract tests。
//
// Authority: /Users/ryo/jp-portfolio-audit-reports/
//   p5-b005-c-a2-portfolio-fit-frozen-specification.md §6・§10・§17
//
// ここでは「型契約そのもの」（exact version/union/interface shape、禁止
// fieldの型排除）を検証する。behavioral（52 test groups, T-01..T-52）は
// src/domain/candidates/portfolioFit.test.ts が担当する。
// ═══════════════════════════════════════════════════════════

import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CANDIDATE_HOLDING_RELATIONSHIPS,
  CANDIDATE_PORTFOLIO_CAPACITY_STATUSES,
  CANDIDATE_PORTFOLIO_FIT_COMPONENT_IDS,
  CANDIDATE_PORTFOLIO_FIT_COMPONENT_STATUSES,
  CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS,
  CANDIDATE_PORTFOLIO_FIT_QUALITY_GATE_IDS,
  CANDIDATE_PORTFOLIO_FIT_REASONS,
  CANDIDATE_PORTFOLIO_FIT_RISKS,
  CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
  CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
  CANDIDATE_PORTFOLIO_FIT_STATUSES,
  CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
  CANDIDATE_PORTFOLIO_FIT_VERSION,
  PORTFOLIO_FIT_CANDIDATE_STALE_THRESHOLD_MS,
  PORTFOLIO_FIT_FUTURE_TOLERANCE_MS,
  PORTFOLIO_FIT_INPUT_FRESHNESS_VALUES,
  PORTFOLIO_FIT_MANUAL_CASH_STALE_THRESHOLD_MS,
  PORTFOLIO_FIT_POLICY_MAX_RATIO,
  PORTFOLIO_FIT_POLICY_MIN_RATIO,
  PORTFOLIO_FIT_SNAPSHOT_SCHEMA_VERSIONS,
  PORTFOLIO_FIT_SOURCE_STALE_THRESHOLD_MS,
} from './candidatePortfolioFit'
import type {
  CandidatePortfolioFitCandidateSource,
  CandidatePortfolioFitComponent,
  CandidatePortfolioFitInput,
  CandidatePortfolioFitRecord,
  CandidatePortfolioFitResult,
  PortfolioFitCodeNormalizationResult,
  PortfolioFitSnapshotInput,
} from './candidatePortfolioFit'
import type { CandidateFunnelArtifact } from './candidateFunnelArtifact'
import { computePortfolioFit } from '../domain/candidates/portfolioFit'

describe('P5-B005-C-B1 candidatePortfolioFit — exact contract', () => {
  it('version / model literals are exact (A2 §17)', () => {
    expect(CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION).toBe('candidate-portfolio-fit-1')
    expect(CANDIDATE_PORTFOLIO_FIT_VERSION).toBe('portfolio-fit-v1-categorical')
    expect(CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL).toBe('categorical_v1')
    expect(CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION).toBe('deep_review_and_actionable')
  })

  it('frozen threshold constants are exact (A2 §10/§17)', () => {
    expect(PORTFOLIO_FIT_CANDIDATE_STALE_THRESHOLD_MS).toBe(48 * 60 * 60 * 1000)
    expect(PORTFOLIO_FIT_SOURCE_STALE_THRESHOLD_MS).toBe(90 * 24 * 60 * 60 * 1000)
    expect(PORTFOLIO_FIT_MANUAL_CASH_STALE_THRESHOLD_MS).toBe(168 * 60 * 60 * 1000)
    expect(PORTFOLIO_FIT_FUTURE_TOLERANCE_MS).toBe(0)
    expect(PORTFOLIO_FIT_POLICY_MIN_RATIO).toBe(0.05)
    expect(PORTFOLIO_FIT_POLICY_MAX_RATIO).toBe(0.3)
  })

  it('snapshot schema version union is exact 5-member set (A2 §4)', () => {
    expect(PORTFOLIO_FIT_SNAPSHOT_SCHEMA_VERSIONS).toEqual([
      'csv-import-generation-1',
      'csv-import-generation-2',
      'csv-import-generation-3',
      'csv-import-generation-4',
      'csv-import-generation-5',
    ])
  })

  it('status/relationship/capacity/component-status unions are exact (A2 §8/§10)', () => {
    expect(CANDIDATE_PORTFOLIO_FIT_STATUSES).toEqual(['evaluated', 'partial', 'unavailable', 'invalid'])
    expect(CANDIDATE_HOLDING_RELATIONSHIPS).toEqual(['new_to_portfolio', 'already_held', 'holding_match_unknown'])
    expect(CANDIDATE_PORTFOLIO_CAPACITY_STATUSES).toEqual(['available', 'constrained', 'unavailable', 'unknown'])
    expect(CANDIDATE_PORTFOLIO_FIT_COMPONENT_STATUSES).toEqual([
      'evaluated',
      'partial',
      'unavailable',
      'reserved',
      'not_applicable',
    ])
    expect(PORTFOLIO_FIT_INPUT_FRESHNESS_VALUES).toEqual(['fresh', 'stale', 'partial', 'unavailable', 'invalid'])
  })

  it('component id order is exact and deterministic (A2 §17: same-code, concentration, sector)', () => {
    expect(CANDIDATE_PORTFOLIO_FIT_COMPONENT_IDS).toEqual([
      'same_code_relationship',
      'existing_concentration',
      'sector_diversification',
    ])
  })

  it('reason / risk unions are exact (A2 §10)', () => {
    expect(CANDIDATE_PORTFOLIO_FIT_REASONS).toEqual([
      'NEW_TO_PORTFOLIO',
      'ALREADY_HELD',
      'SECTOR_EXPOSURE_MEASURED',
      'EXISTING_CODE_CONCENTRATION_MEASURED',
    ])
    expect(CANDIDATE_PORTFOLIO_FIT_RISKS).toEqual([
      'HOLDING_MATCH_UNKNOWN',
      'SECTOR_AUTHORITY_PARTIAL',
      'EXISTING_CONCENTRATION_UNAVAILABLE',
      'COMPONENT_COVERAGE_PARTIAL',
    ])
  })

  it('dataset degradation reason union is exact 22-member set (A2 §10)', () => {
    expect(CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS).toHaveLength(22)
    expect(CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS).toEqual([
      'CANDIDATE_INPUT_UNAVAILABLE',
      'CANDIDATE_INPUT_INVALID',
      'CANDIDATE_INPUT_STALE',
      'CANDIDATE_INPUT_DEGRADED',
      'PORTFOLIO_SNAPSHOT_UNAVAILABLE',
      'PORTFOLIO_SNAPSHOT_INVALID',
      'PORTFOLIO_SOURCE_AS_OF_MISSING',
      'PORTFOLIO_SOURCE_AS_OF_WEAK',
      'PORTFOLIO_SOURCE_STALE',
      'PORTFOLIO_SOURCE_FUTURE',
      'CROSS_TAB_STATE_STALE',
      'HOLDING_CODE_INVALID',
      'HOLDING_VALUE_PARTIAL',
      'HOLDING_SECTOR_UNAVAILABLE',
      'TRUST_VALUE_PARTIAL',
      'CASH_AUTHORITY_UNAVAILABLE',
      'CASH_AUTHORITY_STALE',
      'POLICY_AUTHORITY_UNAVAILABLE',
      'CAPACITY_UNAVAILABLE',
      'DUPLICATE_CANDIDATE_CODE',
      'DUPLICATE_HOLDING_CODE',
      'COMPONENT_COVERAGE_PARTIAL',
    ])
  })

  it('quality gate id union is exact 12-member set (A2 §11)', () => {
    expect(CANDIDATE_PORTFOLIO_FIT_QUALITY_GATE_IDS).toHaveLength(12)
    expect(CANDIDATE_PORTFOLIO_FIT_QUALITY_GATE_IDS[0]).toBe('PF-QG-01-CANDIDATE_CONTRACT')
    expect(CANDIDATE_PORTFOLIO_FIT_QUALITY_GATE_IDS[11]).toBe('PF-QG-12-F2_ONLY')
  })

  it('CandidatePortfolioFitCandidateSource is an exact discriminated union (A2 §4)', () => {
    const available: CandidatePortfolioFitCandidateSource = {
      status: 'available',
      artifact: {} as CandidateFunnelArtifact,
      freshness: 'fresh',
    }
    const unavailable: CandidatePortfolioFitCandidateSource = { status: 'unavailable', artifact: null, freshness: 'unavailable' }
    const invalid: CandidatePortfolioFitCandidateSource = { status: 'invalid', artifact: null, freshness: 'invalid' }
    expect(available.status).toBe('available')
    expect(unavailable.artifact).toBeNull()
    expect(invalid.artifact).toBeNull()

    // @ts-expect-error status='available' must carry a non-null artifact
    const invalidCombo: CandidatePortfolioFitCandidateSource = { status: 'available', artifact: null, freshness: 'fresh' }
    void invalidCombo
  })

  it('PortfolioFitSnapshotInput invalid variant carries only the CANONICAL_ENVELOPE_INVALID error (A2 §4)', () => {
    const invalid: PortfolioFitSnapshotInput = { existence: 'invalid', error: 'CANONICAL_ENVELOPE_INVALID' }
    expect(invalid.error).toBe('CANONICAL_ENVELOPE_INVALID')

    // @ts-expect-error existence='invalid' must not carry holdings/provenance fields
    const invalidCombo: PortfolioFitSnapshotInput = { existence: 'invalid', error: 'CANONICAL_ENVELOPE_INVALID', holdings: [] }
    void invalidCombo
  })

  it('score/rank are compile-time literal null — never numeric (A2 §8/§10)', () => {
    expectTypeOf<CandidatePortfolioFitRecord['portfolioFitScore']>().toEqualTypeOf<null>()
    expectTypeOf<CandidatePortfolioFitRecord['portfolioFitRank']>().toEqualTypeOf<null>()
    expectTypeOf<CandidatePortfolioFitComponent['contribution']>().toEqualTypeOf<null>()
  })

  it('privacy / scope literal fields are exact (A2 §3/§10)', () => {
    expectTypeOf<CandidatePortfolioFitResult['privacyMode']>().toEqualTypeOf<'local_only'>()
    expectTypeOf<CandidatePortfolioFitResult['persistence']>().toEqualTypeOf<'none'>()
    expectTypeOf<CandidatePortfolioFitResult['not_for_trading']>().toEqualTypeOf<true>()
  })

  it('normalizePortfolioFitCode result shape matches PortfolioFitCodeNormalizationResult (A2 §5)', () => {
    const valid: PortfolioFitCodeNormalizationResult = { status: 'valid', normalizedCode: '7203' }
    const invalid: PortfolioFitCodeNormalizationResult = { status: 'invalid', normalizedCode: null }
    expect(valid.normalizedCode).toBe('7203')
    expect(invalid.normalizedCode).toBeNull()
  })

  it('CandidatePortfolioFitRecord has exactly the frozen field set — no forbidden keys (A2 §10/§6)', () => {
    const artifact: CandidateFunnelArtifact = {
      schemaVersion: 'candidate-funnel-1',
      funnelVersion: 'candidate-funnel-v1',
      scoreVersion: 'market-score-v1',
      not_for_trading: true,
      status: 'generated',
      degradationReasons: [],
      counts: { total: 1, excluded: 0, screened: 0, deepReview: 1, actionable: 0 },
      candidates: [
        {
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
        },
      ],
      excludedSummary: { total: 0, byReason: {} },
      sectorDistribution: { screened: {}, deepReview: {}, actionable: {} },
      scoreDistribution: { count: 1, min: null, max: null, mean: null, median: null },
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
        generatedAt: '2026-01-10T00:00:00.000Z',
        asOf: '2026-01-10T00:00:00.000Z',
        sourceUpdatedAt: null,
        pipelinePath: 'normal',
        regimeRequested: null,
        join: {
          candidateCount: 1,
          prescreenCount: 1,
          joinedCount: 1,
          unmatchedCandidateCount: 0,
          unmatchedPrescreenCount: 0,
          joinRate: 1,
          unmatchedCandidateRate: 0,
        },
        qualityGate: { gates: [], overallPass: true, hardFailIds: [], notes: [] },
      },
    }

    const input: CandidatePortfolioFitInput = {
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: null,
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    }
    const result = computePortfolioFit(input)

    const allowedResultKeys = new Set([
      'schemaVersion',
      'fitVersion',
      'scoreModel',
      'targetPopulation',
      'not_for_trading',
      'privacyMode',
      'persistence',
      'evaluatedAt',
      'candidateGeneratedAt',
      'portfolioSourceAsOf',
      'portfolioFreshness',
      'status',
      'capacity',
      'records',
      'degradationReasons',
      'qualityGate',
    ])
    expect(Object.keys(result).sort()).toEqual([...allowedResultKeys].sort())

    const allowedRecordKeys = new Set([
      'candidateRecordId',
      'artifactIndex',
      'code',
      'normalizedCode',
      'candidateMarketRank',
      'candidateTier',
      'holdingRelationship',
      'portfolioFitScore',
      'portfolioFitRank',
      'portfolioFitStatus',
      'components',
      'fitReasons',
      'fitRisks',
    ])
    expect(result.records).toHaveLength(1)
    expect(Object.keys(result.records[0]).sort()).toEqual([...allowedRecordKeys].sort())
    expect(result.records[0].portfolioFitScore).toBeNull()
    expect(result.records[0].portfolioFitRank).toBeNull()

    const forbiddenKeys = [
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
    ]
    for (const key of forbiddenKeys) {
      expect(Object.keys(result)).not.toContain(key)
      expect(Object.keys(result.records[0])).not.toContain(key)
    }
  })

  it('CandidatePortfolioCapacityAssessment has exactly assetClass/status/reasons (A2 §10)', () => {
    const artifact: CandidateFunnelArtifact = {
      schemaVersion: 'candidate-funnel-1',
      funnelVersion: 'candidate-funnel-v1',
      scoreVersion: 'market-score-v1',
      not_for_trading: true,
      status: 'generated',
      degradationReasons: [],
      counts: { total: 0, excluded: 0, screened: 0, deepReview: 0, actionable: 0 },
      candidates: [],
      excludedSummary: { total: 0, byReason: {} },
      sectorDistribution: { screened: {}, deepReview: {}, actionable: {} },
      scoreDistribution: { count: 0, min: null, max: null, mean: null, median: null },
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
        generatedAt: '2026-01-10T00:00:00.000Z',
        asOf: '2026-01-10T00:00:00.000Z',
        sourceUpdatedAt: null,
        pipelinePath: 'normal',
        regimeRequested: null,
        join: {
          candidateCount: 0,
          prescreenCount: 0,
          joinedCount: 0,
          unmatchedCandidateCount: 0,
          unmatchedPrescreenCount: 0,
          joinRate: 1,
          unmatchedCandidateRate: 0,
        },
        qualityGate: { gates: [], overallPass: true, hardFailIds: [], notes: [] },
      },
    }
    const result = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: null,
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    expect(result.capacity.assetClass).toBe('JP_STOCK')
    expect(Object.keys(result.capacity).sort()).toEqual(['assetClass', 'reasons', 'status'])
  })
})
