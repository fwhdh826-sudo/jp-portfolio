// ═══════════════════════════════════════════════════════════
// P5-B005-B1-R2: market-wide candidate funnel TypeScript contract。
//
// data/candidate_funnel_engine.py（P5-B005-A2 frozen scoring specification,
// /Users/ryo/jp-portfolio-audit-reports/p5-b005-a2-scoring-specification.md,
// audited SHA 665eba993b3d3ccfcf434c245a8784765f34bf43）と、これを限定修正する
// P5-B005-A2-S Frozen Specification Supplement
// （/Users/ryo/jp-portfolio-audit-reports/p5-b005-a2-s-scoring-specification-supplement.md,
// §25 が唯一の実装 authority）と exact に一致する version / enum / threshold
// 定数・型を定義する。
//
// この ticket の非 scope: candidate_funnel.json の生成（この契約は将来の
// artifact 用の型のみを定義する。file はまだ生成しない）。
//
// portfolio 関連型は一切含めない（action / BUY_NEW / WATCH / BLOCKED /
// headroom / amount / sizing / portfolio / holdings / cash / account /
// officialDecision は禁止 field）。
// ═══════════════════════════════════════════════════════════

// ── Version strings ──────────────────────────────────────────
export const CANDIDATE_FUNNEL_SCHEMA_VERSION = 'candidate-funnel-1' as const
export const CANDIDATE_FUNNEL_VERSION = 'candidate-funnel-v1' as const
export const CANDIDATE_FUNNEL_SCORE_VERSION = 'market-score-v1' as const

// ── Prior / Stage3 composite split（A2 §3.2） ─────────────────
export const CANDIDATE_FUNNEL_PRESCREEN_PRIOR_WEIGHT = 0.35
export const CANDIDATE_FUNNEL_STAGE3_COMPOSITE_WEIGHT = 0.65

// ── 10 component ids（A2 §4 表の #1-10 と同一順序、Python COMPONENT_IDS と parity） ──
export const CANDIDATE_FUNNEL_COMPONENT_IDS = [
  'valuation',
  'quality',
  'growth',
  'momentum',
  'financialStability',
  'earningsRevisionEvent',
  'themeDurability',
  'regimeFit',
  'risk',
  'dataConfidence',
] as const

export type CandidateFunnelComponentId = (typeof CANDIDATE_FUNNEL_COMPONENT_IDS)[number]

// ── component weights（A2 §4。合計1.0。正 weight は valuation/quality のみ） ──
export const CANDIDATE_FUNNEL_COMPONENT_WEIGHTS: Record<CandidateFunnelComponentId, number> = {
  valuation: 0.55,
  quality: 0.45,
  growth: 0.0,
  momentum: 0.0,
  financialStability: 0.0,
  earningsRevisionEvent: 0.0,
  themeDurability: 0.0,
  regimeFit: 0.0,
  risk: 0.0,
  dataConfidence: 0.0,
}

// valuation の sub-metric weight（A2 §17 valuationSubWeights。合計1.0）
export const CANDIDATE_FUNNEL_VALUATION_SUB_WEIGHTS = {
  earningsYield: 1 / 3,
  bookYield: 1 / 3,
  dividendYield: 1 / 3,
} as const

// ── Enums ─────────────────────────────────────────────────────
export const CANDIDATE_FUNNEL_TIERS = ['excluded', 'eligible', 'screened', 'deep_review', 'actionable'] as const
export type CandidateFunnelTier = (typeof CANDIDATE_FUNNEL_TIERS)[number]

export const CANDIDATE_FUNNEL_PIPELINE_PATHS = ['normal', 'cache_fallback', 'seed_fallback'] as const
export type CandidateFunnelPipelinePath = (typeof CANDIDATE_FUNNEL_PIPELINE_PATHS)[number]

export const CANDIDATE_FUNNEL_COMPONENT_STATUSES = [
  'available',
  'missing',
  'invalid',
  'reserved',
  'vetoed',
] as const
export type CandidateFunnelComponentStatus = (typeof CANDIDATE_FUNNEL_COMPONENT_STATUSES)[number]

export const CANDIDATE_FUNNEL_PRESCREEN_POOLS = ['main', 'newcomer'] as const
export type CandidateFunnelPrescreenPool = (typeof CANDIDATE_FUNNEL_PRESCREEN_POOLS)[number]

export const CANDIDATE_FUNNEL_DATA_STATUSES = ['ok', 'partial'] as const
export type CandidateFunnelDataStatus = (typeof CANDIDATE_FUNNEL_DATA_STATUSES)[number]

export const CANDIDATE_FUNNEL_REGIMES = ['bull_calm', 'bull_volatile', 'uncertain', 'bear', 'crisis'] as const
export type CandidateFunnelRegime = (typeof CANDIDATE_FUNNEL_REGIMES)[number]

export const CANDIDATE_FUNNEL_STATUSES = ['generated', 'not_generated'] as const
export type CandidateFunnelStatus = (typeof CANDIDATE_FUNNEL_STATUSES)[number]

// ── Hard exclusion reason codes（A2 §13。8件 exact） ───────────
export const CANDIDATE_FUNNEL_HARD_REASON_CODES = [
  'HARD_NOT_PRIME_DOMESTIC',
  'HARD_NON_EQUITY_INSTRUMENT',
  'HARD_PREFERRED_OR_NONSTANDARD_CODE',
  'HARD_INSUFFICIENT_HISTORY',
  'HARD_BELOW_MAIN_FLOOR',
  'HARD_NONFINITE_SERIES',
  'HARD_CONTRACT_VIOLATION',
  'HARD_NO_TRADABLE_SERIES',
] as const
export type CandidateFunnelHardReason = (typeof CANDIDATE_FUNNEL_HARD_REASON_CODES)[number]

// ── Soft penalty reason codes（A2-S §25.6。frozen 13件 exact。
//    index 0-9 は A2 §14 と完全に同一、文字列・順序・意味とも不変。
//    index 10-12 は A2-S で追加。） ────────────
export const CANDIDATE_FUNNEL_SOFT_REASON_CODES = [
  'SOFT_ELEVATED_VOLATILITY',
  'SOFT_WEAK_MOMENTUM',
  'SOFT_DEEP_DRAWDOWN',
  'SOFT_WEAK_TREND',
  'SOFT_SECTOR_CROWDING',
  'SOFT_THEME_CROWDING',
  'SOFT_LOW_DATA_CONFIDENCE',
  'SOFT_STALE_SOURCE',
  'SOFT_PORTFOLIO_OVERLAP',
  'SOFT_FALLBACK_PROVENANCE',
  'SOFT_PRESCREEN_METADATA_MISSING',
  'SOFT_VOLATILITY_RED_FLAG',
  'SOFT_VOLATILITY_UNAVAILABLE',
] as const
export type CandidateFunnelSoftReason = (typeof CANDIDATE_FUNNEL_SOFT_REASON_CODES)[number]

// ── selectedReasons exact enum（A2-S §25.12。2件のみ。tier 確定後にのみ
//    生成する。DEEP_REVIEW_THRESHOLD_MET / ACTIONABLE_THRESHOLD_MET は廃止。） ──
export const CANDIDATE_FUNNEL_SELECTED_REASON_CODES = ['SELECTED_DEEP_REVIEW', 'SELECTED_ACTIONABLE'] as const
export type CandidateFunnelSelectedReason = (typeof CANDIDATE_FUNNEL_SELECTED_REASON_CODES)[number]

// ── theme output status（A2-S §25.14。v1 では "unavailable" のみ出力。
//    themes: [] かつ themeStatus: "unavailable" は「未評価」を意味し、
//    「テーマ無し」ではない — source（per-stock theme taxonomy）が未接続。） ──
export const CANDIDATE_FUNNEL_THEME_STATUSES = ['unavailable', 'available'] as const
export type CandidateFunnelThemeStatus = (typeof CANDIDATE_FUNNEL_THEME_STATUSES)[number]

// ── dataset-level degradation reason codes（A2-S §25.14。順序= index 昇順） ──
export const CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES = [
  'SEED_FALLBACK_PIPELINE_PATH',
  'CACHE_FALLBACK_PROVENANCE',
  'STALE_SOURCE',
  'PRESCREEN_FALLBACK_USED',
  'PRESCREEN_METADATA_MISSING',
  'DUPLICATE_CANDIDATE_CODE',
] as const
export type CandidateFunnelDegradationReasonCode = (typeof CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES)[number]

// ── Normalization / thresholds（A2 §8・§9・§10・§17） ──────────
export const CANDIDATE_FUNNEL_WINSORIZE_LOWER_PCT = 0.01
export const CANDIDATE_FUNNEL_WINSORIZE_UPPER_PCT = 0.99

export const CANDIDATE_FUNNEL_MIN_USABLE_AXES = 4

export const CANDIDATE_FUNNEL_DEEP_REVIEW_MIN_MARKET_SCORE = 55.0
export const CANDIDATE_FUNNEL_DEEP_REVIEW_MIN_DATA_CONFIDENCE = 0.5
export const CANDIDATE_FUNNEL_DEEP_REVIEW_HARD_MAX = 40
export const CANDIDATE_FUNNEL_DEEP_REVIEW_SECTOR_HARD_CAP = 6

export const CANDIDATE_FUNNEL_ACTIONABLE_MIN_MARKET_SCORE = 68.0
// A2-S §25.3: literal 0.67 の使用を禁止する（4/6 = 0.6666... < 0.67 で
// 4軸を落としてしまう算術矛盾のため）。gate 比較は丸め前の internal 値に対して行う。
export const CANDIDATE_FUNNEL_ACTIONABLE_MIN_DATA_CONFIDENCE = 2 / 3
export const CANDIDATE_FUNNEL_ACTIONABLE_HARD_MAX = 12
export const CANDIDATE_FUNNEL_ACTIONABLE_SECTOR_HARD_CAP = 2
export const CANDIDATE_FUNNEL_ACTIONABLE_MIN_VALUATION_PERCENTILE = 0.4
export const CANDIDATE_FUNNEL_ACTIONABLE_MIN_QUALITY_PERCENTILE = 0.4

export const CANDIDATE_FUNNEL_BEAR_CRISIS_ACTIONABLE_HARD_MAX = 5
export const CANDIDATE_FUNNEL_BEAR_CRISIS_ACTIONABLE_SECTOR_HARD_CAP = 2

export const CANDIDATE_FUNNEL_VOL_HARD_LIMIT = 0.45
export const CANDIDATE_FUNNEL_VOL_SOFT_LIMIT = 0.35

export const CANDIDATE_FUNNEL_SECTOR_CAP_RELAXATION = false as const

// ── Score component（scoreBreakdown 1件分） ────────────────────
export interface CandidateFunnelScoreComponent {
  id: CandidateFunnelComponentId
  value: number | null
  weight: number
  weightedContribution: number
  status: CandidateFunnelComponentStatus
  sourceFields: string[]
}

// ── Candidate 結果（1銘柄分） ────────────────────────────────
export interface CandidateFunnelCandidate {
  code: string
  name: string
  sector: string
  prescreenScore: number | null
  prescreenRank: number | null
  prescreenPool: CandidateFunnelPrescreenPool | null
  scoreBreakdown: CandidateFunnelScoreComponent[]
  rawCompositeScore: number | null
  dataConfidence: number | null
  marketScore: number | null
  marketRank: number | null
  tier: CandidateFunnelTier
  selectedReasons: CandidateFunnelSelectedReason[]
  riskReasons: CandidateFunnelSoftReason[]
  // A2-S §25.13: blockedReasons を rename（frontend 専用の同名 concept との
  // 名称衝突を解消。旧 key は出力に残さない）。
  hardExclusionReasons: CandidateFunnelHardReason[]
  // A2-S §25.14: themes == [] かつ themeStatus == "unavailable" は
  // 「未評価（source 未接続）」を意味する。「テーマ無し」と解釈してはならない。
  themes: string[]
  themeStatus: CandidateFunnelThemeStatus
  dataStatus: CandidateFunnelDataStatus | null
}

// ── dataset-level 集計 ────────────────────────────────────────
export interface CandidateFunnelCounts {
  total: number
  excluded: number
  screened: number
  deepReview: number
  actionable: number
}

export interface CandidateFunnelExcludedSummary {
  total: number
  byReason: Partial<Record<CandidateFunnelHardReason, number>>
}

export interface CandidateFunnelSectorDistribution {
  screened: Record<string, number>
  deepReview: Record<string, number>
  actionable: Record<string, number>
}

export interface CandidateFunnelScoreDistribution {
  count: number
  min: number | null
  max: number | null
  mean: number | null
  median: number | null
}

export interface CandidateFunnelSelectionObservability {
  regimeApplied: CandidateFunnelRegime | null
  actionableHardMaxApplied: number | null
  actionableSectorCapApplied: number | null
  deepReviewHardMaxApplied: number | null
  deepReviewSectorCapApplied: number | null
  deepReviewSectorCapRelaxed: boolean
  actionableSectorCapRelaxed: boolean
  deepReviewSectorCapOverflow: Record<string, number>
  actionableSectorCapOverflow: Record<string, number>
  deepReviewEligibleCount: number
  deepReviewSelectedCount: number
  actionableEligibleCount: number
  actionableSelectedCount: number
  sourceStale: boolean
  fallbackProvenance: boolean
}

// ── dataset 全体の結果（将来 candidate_funnel.json artifact の型。
//    B1 では file 未生成。not_for_trading を契約へ明示する） ────
export interface CandidateFunnelData {
  schemaVersion: typeof CANDIDATE_FUNNEL_SCHEMA_VERSION
  funnelVersion: typeof CANDIDATE_FUNNEL_VERSION
  scoreVersion: typeof CANDIDATE_FUNNEL_SCORE_VERSION
  not_for_trading: true
  status: CandidateFunnelStatus
  degradationReasons: string[]
  counts: CandidateFunnelCounts
  candidates: CandidateFunnelCandidate[]
  excludedSummary: CandidateFunnelExcludedSummary
  sectorDistribution: CandidateFunnelSectorDistribution
  scoreDistribution: CandidateFunnelScoreDistribution
  selectionObservability: CandidateFunnelSelectionObservability
}
