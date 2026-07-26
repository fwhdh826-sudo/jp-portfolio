// テスト専用fixture。production artifactの実shapeを最小candidate数で
// 再現する（candidateFunnelParser.test.ts / loadCandidateFunnel.test.ts
// で共有する）。実contractとは無関係な値のsnapshot固定を避けるため、
// 呼び出し側は必ずstructuredClone(buildValidCandidateFunnelArtifact())で
// 独立コピーを取ってからmutateすること。
import {
  CANDIDATE_FUNNEL_COMPONENT_IDS,
  CANDIDATE_FUNNEL_SCHEMA_VERSION,
  CANDIDATE_FUNNEL_SCORE_VERSION,
  CANDIDATE_FUNNEL_VERSION,
} from '../types/candidateFunnel'
import { CANDIDATE_FUNNEL_QUALITY_GATE_REQUIRED_IDS } from '../types/candidateFunnelArtifact'

function buildScoreBreakdown() {
  return CANDIDATE_FUNNEL_COMPONENT_IDS.map((id) => ({
    id,
    value: id === 'valuation' || id === 'quality' ? 0.6 : null,
    weight: id === 'valuation' ? 0.55 : id === 'quality' ? 0.45 : 0.0,
    weightedContribution: id === 'valuation' ? 0.33 : id === 'quality' ? 0.27 : 0.0,
    status: id === 'valuation' || id === 'quality' ? 'available' : 'reserved',
    sourceFields: id === 'valuation' ? ['per', 'pbr'] : id === 'quality' ? ['roe'] : [],
  }))
}

function buildCandidate(code: string, tier: 'screened' | 'deep_review' | 'actionable', marketScore: number) {
  return {
    code,
    name: `テスト銘柄${code}`,
    sector: '銀行業',
    prescreenScore: 0.8,
    prescreenRank: 1,
    prescreenPool: 'main',
    scoreBreakdown: buildScoreBreakdown(),
    rawCompositeScore: 0.6,
    dataConfidence: 1.0,
    marketScore,
    marketRank: 1,
    tier,
    selectedReasons: tier === 'actionable' ? ['SELECTED_ACTIONABLE'] : tier === 'deep_review' ? ['SELECTED_DEEP_REVIEW'] : [],
    riskReasons: [],
    hardExclusionReasons: [],
    themes: [],
    themeStatus: 'unavailable',
    dataStatus: 'ok',
  }
}

function buildQualityGateEntry(id: string) {
  const value =
    id === 'P-06' || id === 'P-07' || id === 'P-10' || id === 'P-11' || id === 'P-12' || id === 'P-13'
      ? { note: 'record' }
      : id === 'P-15'
        ? null
        : 1
  const status = ['P-02', 'P-04', 'P-07', 'P-08', 'P-10', 'P-12', 'P-13', 'P-14'].includes(id) ? 'PASS' : 'RECORD'
  return { id, metric: `metric-${id}`, value, threshold: '記録', status, note: '' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildValidCandidateFunnelArtifact(): any {
  const gates = [
    ...CANDIDATE_FUNNEL_QUALITY_GATE_REQUIRED_IDS.map(buildQualityGateEntry),
    { id: 'PRESCREEN_DUPLICATE', metric: 'duplicate code', value: 0, threshold: '== 0', status: 'PASS', note: '' },
  ]

  return {
    schemaVersion: CANDIDATE_FUNNEL_SCHEMA_VERSION,
    funnelVersion: CANDIDATE_FUNNEL_VERSION,
    scoreVersion: CANDIDATE_FUNNEL_SCORE_VERSION,
    not_for_trading: true,
    status: 'generated',
    degradationReasons: [],
    counts: { total: 3, excluded: 0, screened: 1, deepReview: 1, actionable: 1 },
    candidates: [
      buildCandidate('1001', 'screened', 40.0),
      buildCandidate('1002', 'deep_review', 60.0),
      buildCandidate('1003', 'actionable', 75.0),
    ],
    excludedSummary: { total: 0, byReason: {} },
    sectorDistribution: {
      screened: { 銀行業: 1 },
      deepReview: { 銀行業: 1 },
      actionable: { 銀行業: 1 },
    },
    scoreDistribution: { count: 3, min: 40.0, max: 75.0, mean: 58.3, median: 60.0 },
    selectionObservability: {
      regimeApplied: 'uncertain',
      actionableHardMaxApplied: 12,
      actionableSectorCapApplied: 2,
      deepReviewHardMaxApplied: 40,
      deepReviewSectorCapApplied: 6,
      deepReviewSectorCapRelaxed: false,
      actionableSectorCapRelaxed: false,
      deepReviewSectorCapOverflow: {},
      actionableSectorCapOverflow: {},
      deepReviewEligibleCount: 2,
      deepReviewSelectedCount: 1,
      actionableEligibleCount: 1,
      actionableSelectedCount: 1,
      sourceStale: false,
      fallbackProvenance: false,
    },
    _meta: {
      kind: 'candidate_funnel',
      not_for_trading: true,
      generatedAt: '2026-07-26T07:11:40.540540+00:00',
      asOf: '2026-07-26T07:11:40.540540+00:00',
      sourceUpdatedAt: '2026-07-26T16:09:01.662779+09:00',
      pipelinePath: 'normal',
      regimeRequested: 'uncertain',
      join: {
        candidateCount: 3,
        prescreenCount: 3,
        joinedCount: 3,
        unmatchedCandidateCount: 0,
        unmatchedPrescreenCount: 0,
        joinRate: 1.0,
        unmatchedCandidateRate: 0.0,
      },
      qualityGate: {
        gates,
        overallPass: true,
        hardFailIds: [],
        notes: [],
      },
    },
  }
}
