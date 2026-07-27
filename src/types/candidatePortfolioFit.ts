// ═══════════════════════════════════════════════════════════
// P5-B005-C-B1: portfolioFit categorical v1 — pure local domain contract。
//
// Authority: /Users/ryo/jp-portfolio-audit-reports/
//   p5-b005-c-a2-portfolio-fit-frozen-specification.md (frozen, exact)
//
// この契約は S3 (score/capacity/trade separation) と A3 (browser-local pure
// join) を実装する。categorical v1 のため portfolioFitScore/portfolioFitRank
// は常に null — numeric activation は将来の別 specification/version が必要。
//
// scope外（この契約に一切含めない）: action / officialDecision / BUY_NEW /
// BUY_MORE / SELL / WATCH / BLOCKED / amount / quantity / shares / order /
// limitPrice / recommendedTrade / executable / tradeGateStatus。
// store/selectors/localStorage/network は一切参照しない — pure types のみ。
// ═══════════════════════════════════════════════════════════

import type { CandidateFunnelArtifact } from './candidateFunnelArtifact'
import type { CandidateFunnelTier } from './candidateFunnel'
import type { CashAssumptions, CsvImportProvenance, Holding, PortfolioPolicy, Trust } from './index'

// ── Version / model literals（A2 §17 frozen constants register） ──────
export const CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION = 'candidate-portfolio-fit-1' as const
export const CANDIDATE_PORTFOLIO_FIT_VERSION = 'portfolio-fit-v1-categorical' as const
export const CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL = 'categorical_v1' as const
export const CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION = 'deep_review_and_actionable' as const

// ── Candidate source（A2 §4） ────────────────────────────────────────
export type CandidatePortfolioFitCandidateSource =
  | { status: 'available'; artifact: CandidateFunnelArtifact; freshness: 'fresh' | 'stale' | 'degraded' }
  | { status: 'unavailable' | 'invalid'; artifact: null; freshness: 'unavailable' | 'invalid' }

// ── Portfolio snapshot schema version union（A2 §4。既存 canonical
//    generation schema literal と exact 一致。ここでは独立に literal を
//    定義する — persist.ts（store）を import しない）。 ────────────
export const PORTFOLIO_FIT_SNAPSHOT_SCHEMA_VERSIONS = [
  'csv-import-generation-1',
  'csv-import-generation-2',
  'csv-import-generation-3',
  'csv-import-generation-4',
  'csv-import-generation-5',
] as const
export type PortfolioFitSnapshotSchemaVersion = (typeof PORTFOLIO_FIT_SNAPSHOT_SCHEMA_VERSIONS)[number]

export type PortfolioFitSnapshotInput =
  | {
      existence: 'present_empty' | 'present_nonempty'
      schemaVersion: PortfolioFitSnapshotSchemaVersion
      generationId: string
      savedAt: number
      holdings: readonly Holding[]
      trusts: readonly Trust[]
      portfolioPolicy: PortfolioPolicy | null
      cashAssumptions: CashAssumptions | null
      provenance: CsvImportProvenance | null
      csvImportedAt: string | null
      crossTabState: 'current' | 'stale'
    }
  | { existence: 'invalid'; error: 'CANONICAL_ENVELOPE_INVALID' }

export interface CandidatePortfolioFitInput {
  candidateSource: CandidatePortfolioFitCandidateSource
  portfolioSnapshot: PortfolioFitSnapshotInput | null
  evaluatedAt: string
}

// ── Exact code normalization result（A2 §5） ─────────────────────────
export interface PortfolioFitCodeNormalizationResult {
  status: 'valid' | 'invalid'
  normalizedCode: string | null
}

// ── Holding aggregate（A2 §6） ───────────────────────────────────────
export type PortfolioFitHoldingAggregateDataStatus = 'complete' | 'partial' | 'invalid'

export interface PortfolioFitHoldingAggregate {
  normalizedCode: string
  totalCurrentValue: number | null
  acquiredAtForLock: string | null
  sourceRecordCount: number
  dataStatus: PortfolioFitHoldingAggregateDataStatus
}

// ── Freshness（A2 §7） ───────────────────────────────────────────────
export const PORTFOLIO_FIT_INPUT_FRESHNESS_VALUES = [
  'fresh',
  'stale',
  'partial',
  'unavailable',
  'invalid',
] as const
export type PortfolioFitInputFreshness = (typeof PORTFOLIO_FIT_INPUT_FRESHNESS_VALUES)[number]

// ── Frozen freshness/capacity threshold constants（A2 §10・§17 exact） ──
export const PORTFOLIO_FIT_CANDIDATE_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000
export const PORTFOLIO_FIT_SOURCE_STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000
export const PORTFOLIO_FIT_MANUAL_CASH_STALE_THRESHOLD_MS = 168 * 60 * 60 * 1000
export const PORTFOLIO_FIT_FUTURE_TOLERANCE_MS = 0
export const PORTFOLIO_FIT_POLICY_MIN_RATIO = 0.05
export const PORTFOLIO_FIT_POLICY_MAX_RATIO = 0.30

// ── Status / relationship / capacity / component unions（A2 §8・§10） ──
export const CANDIDATE_PORTFOLIO_FIT_STATUSES = ['evaluated', 'partial', 'unavailable', 'invalid'] as const
export type CandidatePortfolioFitStatus = (typeof CANDIDATE_PORTFOLIO_FIT_STATUSES)[number]

export const CANDIDATE_HOLDING_RELATIONSHIPS = [
  'new_to_portfolio',
  'already_held',
  'holding_match_unknown',
] as const
export type CandidateHoldingRelationship = (typeof CANDIDATE_HOLDING_RELATIONSHIPS)[number]

export const CANDIDATE_PORTFOLIO_CAPACITY_STATUSES = [
  'available',
  'constrained',
  'unavailable',
  'unknown',
] as const
export type CandidatePortfolioCapacityStatus = (typeof CANDIDATE_PORTFOLIO_CAPACITY_STATUSES)[number]

export const CANDIDATE_PORTFOLIO_FIT_COMPONENT_STATUSES = [
  'evaluated',
  'partial',
  'unavailable',
  'reserved',
  'not_applicable',
] as const
export type CandidatePortfolioFitComponentStatus = (typeof CANDIDATE_PORTFOLIO_FIT_COMPONENT_STATUSES)[number]

// component order は deterministic — 配列順が同時に契約上の component order。
export const CANDIDATE_PORTFOLIO_FIT_COMPONENT_IDS = [
  'same_code_relationship',
  'existing_concentration',
  'sector_diversification',
] as const
export type CandidatePortfolioFitComponentId = (typeof CANDIDATE_PORTFOLIO_FIT_COMPONENT_IDS)[number]

export const CANDIDATE_PORTFOLIO_FIT_REASONS = [
  'NEW_TO_PORTFOLIO',
  'ALREADY_HELD',
  'SECTOR_EXPOSURE_MEASURED',
  'EXISTING_CODE_CONCENTRATION_MEASURED',
] as const
export type CandidatePortfolioFitReason = (typeof CANDIDATE_PORTFOLIO_FIT_REASONS)[number]

export const CANDIDATE_PORTFOLIO_FIT_RISKS = [
  'HOLDING_MATCH_UNKNOWN',
  'SECTOR_AUTHORITY_PARTIAL',
  'EXISTING_CONCENTRATION_UNAVAILABLE',
  'COMPONENT_COVERAGE_PARTIAL',
] as const
export type CandidatePortfolioFitRisk = (typeof CANDIDATE_PORTFOLIO_FIT_RISKS)[number]

export const CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS = [
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
] as const
export type CandidatePortfolioFitDatasetReason = (typeof CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS)[number]

// ── Result shapes（A2 §10） ──────────────────────────────────────────
export interface CandidatePortfolioFitComponent {
  id: CandidatePortfolioFitComponentId
  value: number | null
  status: CandidatePortfolioFitComponentStatus
  contribution: null
  reasons: readonly CandidatePortfolioFitReason[]
  risks: readonly CandidatePortfolioFitRisk[]
}

export interface CandidatePortfolioFitRecord {
  candidateRecordId: string
  artifactIndex: number
  code: string
  normalizedCode: string | null
  candidateMarketRank: number | null
  candidateTier: Extract<CandidateFunnelTier, 'deep_review' | 'actionable'>
  holdingRelationship: CandidateHoldingRelationship
  portfolioFitScore: null
  portfolioFitRank: null
  portfolioFitStatus: CandidatePortfolioFitStatus
  components: readonly CandidatePortfolioFitComponent[]
  fitReasons: readonly CandidatePortfolioFitReason[]
  fitRisks: readonly CandidatePortfolioFitRisk[]
}

export interface CandidatePortfolioCapacityAssessment {
  assetClass: 'JP_STOCK'
  status: CandidatePortfolioCapacityStatus
  reasons: readonly CandidatePortfolioFitDatasetReason[]
}

export const CANDIDATE_PORTFOLIO_FIT_QUALITY_GATE_IDS = [
  'PF-QG-01-CANDIDATE_CONTRACT',
  'PF-QG-02-SNAPSHOT_CONTRACT',
  'PF-QG-03-F2_COUNT_PARITY',
  'PF-QG-04-RECORD_ID_UNIQUE',
  'PF-QG-05-CANDIDATE_IMMUTABLE',
  'PF-QG-06-MARKET_FIELDS_UNCHANGED',
  'PF-QG-07-SCORE_NULL_OR_FINITE',
  'PF-QG-08-RANK_CONTRACT',
  'PF-QG-09-DETERMINISTIC_REPLAY',
  'PF-QG-10-PRIVACY_KEYS',
  'PF-QG-11-TRADE_FIELDS_ABSENT',
  'PF-QG-12-F2_ONLY',
] as const
export type CandidatePortfolioFitQualityGateId = (typeof CANDIDATE_PORTFOLIO_FIT_QUALITY_GATE_IDS)[number]

export interface CandidatePortfolioFitResult {
  schemaVersion: typeof CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION
  fitVersion: typeof CANDIDATE_PORTFOLIO_FIT_VERSION
  scoreModel: typeof CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL
  targetPopulation: typeof CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION
  not_for_trading: true
  privacyMode: 'local_only'
  persistence: 'none'
  evaluatedAt: string
  candidateGeneratedAt: string | null
  portfolioSourceAsOf: string | null
  portfolioFreshness: PortfolioFitInputFreshness
  status: CandidatePortfolioFitStatus
  capacity: CandidatePortfolioCapacityAssessment
  records: readonly CandidatePortfolioFitRecord[]
  degradationReasons: readonly CandidatePortfolioFitDatasetReason[]
  qualityGate: {
    inputTargetCount: number
    outputRecordCount: number
    hardFailIds: readonly CandidatePortfolioFitQualityGateId[]
    warningIds: readonly CandidatePortfolioFitQualityGateId[]
  }
}
