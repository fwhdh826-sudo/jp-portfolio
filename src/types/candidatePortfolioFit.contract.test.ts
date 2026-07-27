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
import type { CandidateFunnelCandidate } from './candidateFunnel'
import type { Holding } from './index'
import { aggregatePortfolioFitHoldings, computePortfolioFit } from '../domain/candidates/portfolioFit'

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

  // ═══════════════════════════════════════════════════════════
  // P5-B005-C-B1-R1: independent audit P1-07 hardening — runtime exact-key
  // contract for component / qualityGate. Excess-property checking alone
  // (TypeScript compile-time) does not catch `{...component,
  // arbitraryUnknownField:true}` style corruption — this must be an
  // Object.keys() runtime assertion (A2-audit §7/§16).
  //
  // Authority: /Users/ryo/jp-portfolio-audit-reports/
  //   p5-b005-c-b1-v-independent-audit.md §19 P1-07
  // ═══════════════════════════════════════════════════════════

  function minimalCandidate(overrides: Partial<CandidateFunnelCandidate> = {}): CandidateFunnelCandidate {
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

  function minimalArtifact(candidates: CandidateFunnelCandidate[]): CandidateFunnelArtifact {
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
        generatedAt: '2026-01-10T00:00:00.000Z',
        asOf: '2026-01-10T00:00:00.000Z',
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
      },
    }
  }

  function minimalHolding(overrides: Partial<Holding> = {}): Holding {
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

  // present_nonempty snapshot with a real holding — this is required to
  // actually exercise computeComponentsForRecord's own component
  // construction. `portfolioSnapshot: null` only exercises the hardcoded
  // "portfolioUnusable" forced-component branch and would miss a mutation
  // injected into computeComponentsForRecord's real component objects.
  function minimalSnapshot(holdings: Holding[] = [minimalHolding()]): PortfolioFitSnapshotInput {
    return {
      existence: 'present_nonempty',
      schemaVersion: 'csv-import-generation-5',
      generationId: 'gen-1',
      savedAt: 0,
      holdings,
      trusts: [],
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
      cashAssumptions: null,
      provenance: {
        sourceAsOf: '2026-01-10T00:00:00.000Z',
        sourceAsOfKind: 'csv_explicit',
        sourceAsOfConfidence: 'authoritative',
        contentFingerprint: 'fp',
        sourceFileName: 'x.csv',
        fileLastModified: null,
        importedAt: '2026-01-10T00:00:00.000Z',
      },
      csvImportedAt: null,
      crossTabState: 'current',
    }
  }

  it('R1-P1-07: CandidatePortfolioFitComponent has exactly the frozen field set for every component in every record', () => {
    const artifact = minimalArtifact([minimalCandidate(), minimalCandidate({ code: '9432', tier: 'actionable' })])
    const result = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: minimalSnapshot(),
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    const allowedComponentKeys = ['contribution', 'id', 'reasons', 'risks', 'status', 'value']
    expect(result.records.length).toBeGreaterThan(0)
    for (const record of result.records) {
      expect(record.components).toHaveLength(3)
      for (const component of record.components) {
        expect(Object.keys(component).sort()).toEqual(allowedComponentKeys)
      }
      // component id order/union is exact — a mutation renaming or adding a
      // component id outside the frozen union must fail here.
      expect(record.components.map((c) => c.id)).toEqual([
        'same_code_relationship',
        'existing_concentration',
        'sector_diversification',
      ])
    }
  })

  it('R1-P1-07: CandidatePortfolioFitResult.qualityGate has exactly the frozen field set', () => {
    const artifact = minimalArtifact([minimalCandidate()])
    const result = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: null,
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    expect(Object.keys(result.qualityGate).sort()).toEqual([
      'hardFailIds',
      'inputTargetCount',
      'outputRecordCount',
      'warningIds',
    ])
    expect(Array.isArray(result.qualityGate.hardFailIds)).toBe(true)
    expect(Array.isArray(result.qualityGate.warningIds)).toBe(true)
  })

  it('R1-P1-07: no component carries an arbitrary extra field (excess-property defense, runtime not just compile-time)', () => {
    const artifact = minimalArtifact([minimalCandidate()])
    const resultForced = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: null,
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    const resultComputed = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: minimalSnapshot(),
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    for (const result of [resultForced, resultComputed]) {
      for (const record of result.records) {
        for (const component of record.components) {
          expect(Object.prototype.hasOwnProperty.call(component, 'arbitraryUnknownField')).toBe(false)
          expect(Object.keys(component)).toHaveLength(6)
        }
      }
    }
  })

  it('R1-P1-07/P1-08: every reason/risk in every record and component is a declared literal only (no unknown runtime value, no SOFT_PORTFOLIO_OVERLAP)', () => {
    const artifact = minimalArtifact([minimalCandidate({ code: '7203' }), minimalCandidate({ code: '9432', tier: 'actionable' })])
    const result = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: minimalSnapshot([minimalHolding({ code: '7203' }), minimalHolding({ code: '9432', sector: '未分類' })]),
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    const declaredReasons = new Set(CANDIDATE_PORTFOLIO_FIT_REASONS as readonly string[])
    const declaredRisks = new Set(CANDIDATE_PORTFOLIO_FIT_RISKS as readonly string[])
    const declaredDatasetReasons = new Set(CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS as readonly string[])
    for (const record of result.records) {
      for (const r of record.fitReasons) expect(declaredReasons.has(r)).toBe(true)
      for (const r of record.fitRisks) expect(declaredRisks.has(r)).toBe(true)
      for (const c of record.components) {
        for (const r of c.reasons) expect(declaredReasons.has(r)).toBe(true)
        for (const r of c.risks) expect(declaredRisks.has(r)).toBe(true)
      }
    }
    for (const r of result.degradationReasons) expect(declaredDatasetReasons.has(r)).toBe(true)
    for (const r of result.capacity.reasons) expect(declaredDatasetReasons.has(r)).toBe(true)
  })

  it('R1-P1-07: recursive forbidden-key scan at every nesting level (result/record/component)', () => {
    const artifact = minimalArtifact([minimalCandidate()])
    const result = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: null,
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
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
      'SOFT_PORTFOLIO_OVERLAP',
    ]
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
        expect(forbiddenKeys).not.toContain(k)
        visit(val)
      }
    }
    visit(result)
  })

  it('R1-P1-07: no nonfinite number anywhere in the result (component values, ranks, indices)', () => {
    const artifact = minimalArtifact([minimalCandidate({ code: '7203' }), minimalCandidate({ code: '9432', tier: 'actionable' })])
    const result = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: null,
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    const seen = new Set<object>()
    const visit = (v: unknown) => {
      if (typeof v === 'number') {
        expect(Number.isFinite(v)).toBe(true)
        return
      }
      if (v === null || typeof v !== 'object') return
      if (seen.has(v as object)) return
      seen.add(v as object)
      for (const val of Object.values(v as Record<string, unknown>)) visit(val)
    }
    visit(result)
  })

  it('R1-P1-07: no duplicate candidateRecordId across the output', () => {
    const artifact = minimalArtifact([
      minimalCandidate({ code: '7203' }),
      minimalCandidate({ code: ' 7203 ', tier: 'actionable' }), // duplicate normalized code — still unique record IDs
    ])
    const result = computePortfolioFit({
      candidateSource: { status: 'available', artifact, freshness: 'fresh' },
      portfolioSnapshot: null,
      evaluatedAt: '2026-01-10T00:00:00.000Z',
    })
    const ids = result.records.map((r) => r.candidateRecordId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(result.qualityGate.hardFailIds).not.toContain('PF-QG-04-RECORD_ID_UNIQUE')
  })

  const exactRecordKeys = [
    'artifactIndex',
    'candidateMarketRank',
    'candidateRecordId',
    'candidateTier',
    'code',
    'components',
    'fitReasons',
    'fitRisks',
    'holdingRelationship',
    'normalizedCode',
    'portfolioFitRank',
    'portfolioFitScore',
    'portfolioFitStatus',
  ]
  const exactComponentKeys = ['contribution', 'id', 'reasons', 'risks', 'status', 'value']
  const exactAggregateWrapperKeys = [
    'aggregates',
    'hasDuplicateCode',
    'hasInvalidCode',
    'hasPartialValue',
    'jpStockValidTotal',
  ]
  const exactAggregateElementKeys = [
    'acquiredAtForLock',
    'dataStatus',
    'normalizedCode',
    'sourceRecordCount',
    'totalCurrentValue',
  ]

  function computedRecordResults() {
    const artifact = minimalArtifact([
      minimalCandidate({ code: '7203' }),
      minimalCandidate({ code: '9432', tier: 'actionable' }),
    ])
    return {
      normal: computePortfolioFit({
        candidateSource: { status: 'available', artifact, freshness: 'fresh' },
        portfolioSnapshot: minimalSnapshot([
          minimalHolding({ code: '7203' }),
          minimalHolding({ code: '9432', sector: 'Technology' }),
        ]),
        evaluatedAt: '2026-01-10T00:00:00.000Z',
      }),
      unavailable: computePortfolioFit({
        candidateSource: { status: 'available', artifact, freshness: 'fresh' },
        portfolioSnapshot: null,
        evaluatedAt: '2026-01-10T00:00:00.000Z',
      }),
    }
  }

  it('R2-M02/P1-07: every normal and unavailable computed record has the exact frozen keys', () => {
    const results = computedRecordResults()
    for (const [branch, result] of Object.entries(results)) {
      expect(result.records.length, `${branch} branch must produce records`).toBeGreaterThan(0)
      for (const record of result.records) {
        expect(Object.keys(record).sort(), `${branch}:${record.candidateRecordId}`).toEqual(exactRecordKeys)
      }
    }
  })

  it('R2-P1-07: every component in normal and unavailable computed records has the exact frozen keys', () => {
    const results = computedRecordResults()
    for (const [branch, result] of Object.entries(results)) {
      for (const record of result.records) {
        expect(record.components).toHaveLength(3)
        for (const component of record.components) {
          expect(Object.keys(component).sort(), `${branch}:${record.candidateRecordId}:${component.id}`).toEqual(
            exactComponentKeys,
          )
        }
      }
    }
  })

  it('R2-M03/P1-07: the public aggregate wrapper has the exact frozen keys', () => {
    const wrapper = aggregatePortfolioFitHoldings([minimalHolding()])
    expect(Object.keys(wrapper).sort()).toEqual(exactAggregateWrapperKeys)
  })

  it('R2-M04/P1-07: every complete, partial, and invalid public aggregate element has exact frozen keys', () => {
    const wrapper = aggregatePortfolioFitHoldings([
      minimalHolding({ code: '7203', eval: 100 }),
      minimalHolding({ code: '9432', eval: 100 }),
      minimalHolding({ code: '9432', eval: Number.NaN }),
      minimalHolding({ code: '1301', eval: Number.NaN }),
    ])
    expect(wrapper.aggregates.map((aggregate) => aggregate.dataStatus).sort()).toEqual([
      'complete',
      'invalid',
      'partial',
    ])
    for (const aggregate of wrapper.aggregates) {
      expect(Object.keys(aggregate).sort(), aggregate.normalizedCode).toEqual(exactAggregateElementKeys)
    }
  })

  it('R2-P1-07: recursive forbidden-key scan covers computed results and public aggregates', () => {
    const results = computedRecordResults()
    const aggregateWrapper = aggregatePortfolioFitHoldings([
      minimalHolding({ code: '7203', eval: 100 }),
      minimalHolding({ code: '9432', eval: Number.NaN }),
    ])
    const forbiddenKeys = new Set([
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
      'unexpectedField',
      'arbitraryUnknownField',
    ])
    const seen = new Set<object>()
    const visit = (value: unknown) => {
      if (value === null || typeof value !== 'object' || seen.has(value as object)) return
      seen.add(value as object)
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        expect(forbiddenKeys.has(key), `forbidden runtime key: ${key}`).toBe(false)
        visit(nested)
      }
    }
    visit(results.normal)
    visit(results.unavailable)
    visit(aggregateWrapper)
  })
})
