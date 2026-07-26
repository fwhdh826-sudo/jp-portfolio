// ═══════════════════════════════════════════════════════════
// P5-B005-B3-A: candidate_funnel.json production artifact用 runtime
// validator/parser。
//
// unknownから CandidateFunnelArtifact を検証する。TypeScriptの型cast
// だけでは実行時のprivacy/provenance/quality gate契約を保証できないため、
// ここで独立したruntime parserを実装する（外部validation依存は追加しない）。
//
// throwしない: 例外（getter-throwing object / proxy / 循環参照等）は
// すべて捕捉し、構造化されたfailure結果へ変換する。raw payloadや例外
// messageはfailure結果へ含めない（UI/consoleへの情報漏洩防止）。
//
// B1（src/types/candidateFunnel.ts）のfrozen scoring契約とB2 artifact
// wrapper契約（src/types/candidateFunnelArtifact.ts）をauthorityとして
// 再利用し、ここで契約を再定義しない。
// ═══════════════════════════════════════════════════════════

import {
  CANDIDATE_FUNNEL_COMPONENT_IDS,
  CANDIDATE_FUNNEL_COMPONENT_STATUSES,
  CANDIDATE_FUNNEL_DATA_STATUSES,
  CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES,
  CANDIDATE_FUNNEL_HARD_REASON_CODES,
  CANDIDATE_FUNNEL_PIPELINE_PATHS,
  CANDIDATE_FUNNEL_PRESCREEN_POOLS,
  CANDIDATE_FUNNEL_REGIMES,
  CANDIDATE_FUNNEL_SCHEMA_VERSION,
  CANDIDATE_FUNNEL_SCORE_VERSION,
  CANDIDATE_FUNNEL_SELECTED_REASON_CODES,
  CANDIDATE_FUNNEL_SOFT_REASON_CODES,
  CANDIDATE_FUNNEL_STATUSES,
  CANDIDATE_FUNNEL_THEME_STATUSES,
  CANDIDATE_FUNNEL_TIERS,
  CANDIDATE_FUNNEL_VERSION,
} from '../types/candidateFunnel'
import type { CandidateFunnelCandidate, CandidateFunnelScoreComponent } from '../types/candidateFunnel'
import {
  CANDIDATE_FUNNEL_QUALITY_GATE_REQUIRED_IDS,
  CANDIDATE_FUNNEL_QUALITY_GATE_STATUSES,
} from '../types/candidateFunnelArtifact'
import type { CandidateFunnelArtifact, JsonValue } from '../types/candidateFunnelArtifact'

// ── 禁止key: payload全階層（top-level / candidate内部 / meta内部を含む
//    すべてのobject）に一切出現してはならない。portfolio/decision関連の
//    frontend概念がartifactへ混入していないことをここで保証する。 ──────
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'portfolio',
  'portfolioFit',
  'holdings',
  'cash',
  'account',
  'headroom',
  'amount',
  'sizing',
  'action',
  'officialDecision',
  'BUY_NEW',
  'WATCH',
  'BLOCKED',
])

export type CandidateFunnelLoadFailureCode =
  | 'malformed_root'
  | 'forbidden_key'
  | 'invalid_version'
  | 'privacy_violation'
  | 'invalid_status'
  | 'invalid_counts'
  | 'invalid_candidates'
  | 'invalid_distribution'
  | 'missing_meta'
  | 'invalid_meta'
  | 'invalid_provenance'
  | 'quality_gate_failed'
  | 'quality_gate_incomplete'
  | 'unknown'

export type CandidateFunnelParseResult =
  | { ok: true; data: CandidateFunnelArtifact }
  | { ok: false; code: CandidateFunnelLoadFailureCode }

// ── primitive guards ──────────────────────────────────────────
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function isEnumValue<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function isJsonValue(value: unknown, seen: Set<unknown> = new Set()): value is JsonValue {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value as number)
  if (t !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen))
  return Object.keys(value as object).every((key) => isJsonValue((value as Record<string, unknown>)[key], seen))
}

// ── 禁止key recursive scan（循環参照はWeakSet相当のSetでガードする） ──
function containsForbiddenKey(value: unknown, seen: Set<unknown> = new Set()): boolean {
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenKey(item, seen))
  }
  for (const key of Object.keys(value as object)) {
    if (FORBIDDEN_KEYS.has(key)) return true
    if (containsForbiddenKey((value as Record<string, unknown>)[key], seen)) return true
  }
  return false
}

function fail(code: CandidateFunnelLoadFailureCode): CandidateFunnelParseResult {
  return { ok: false, code }
}

// ── scoreBreakdown: exact 10 component ids（欠落・重複・未知IDを許容しない） ──
function validateScoreComponent(value: unknown): value is CandidateFunnelScoreComponent {
  if (!isPlainObject(value)) return false
  return (
    isEnumValue(value.id, CANDIDATE_FUNNEL_COMPONENT_IDS) &&
    isFiniteOrNull(value.value) &&
    isFiniteNumber(value.weight) &&
    isFiniteNumber(value.weightedContribution) &&
    isEnumValue(value.status, CANDIDATE_FUNNEL_COMPONENT_STATUSES) &&
    isStringArray(value.sourceFields)
  )
}

function validateScoreBreakdown(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== CANDIDATE_FUNNEL_COMPONENT_IDS.length) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (!validateScoreComponent(entry)) return false
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
  }
  return seen.size === CANDIDATE_FUNNEL_COMPONENT_IDS.length
}

function validateCandidate(value: unknown): value is CandidateFunnelCandidate {
  if (!isPlainObject(value)) return false
  return (
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.sector) &&
    isFiniteOrNull(value.prescreenScore) &&
    (value.prescreenRank === null || isNonNegativeInteger(value.prescreenRank)) &&
    (value.prescreenPool === null || isEnumValue(value.prescreenPool, CANDIDATE_FUNNEL_PRESCREEN_POOLS)) &&
    validateScoreBreakdown(value.scoreBreakdown) &&
    isFiniteOrNull(value.rawCompositeScore) &&
    isFiniteOrNull(value.dataConfidence) &&
    isFiniteOrNull(value.marketScore) &&
    (value.marketRank === null || isNonNegativeInteger(value.marketRank)) &&
    isEnumValue(value.tier, CANDIDATE_FUNNEL_TIERS) &&
    Array.isArray(value.selectedReasons) &&
    value.selectedReasons.every((r) => isEnumValue(r, CANDIDATE_FUNNEL_SELECTED_REASON_CODES)) &&
    Array.isArray(value.riskReasons) &&
    value.riskReasons.every((r) => isEnumValue(r, CANDIDATE_FUNNEL_SOFT_REASON_CODES)) &&
    Array.isArray(value.hardExclusionReasons) &&
    value.hardExclusionReasons.every((r) => isEnumValue(r, CANDIDATE_FUNNEL_HARD_REASON_CODES)) &&
    isStringArray(value.themes) &&
    isEnumValue(value.themeStatus, CANDIDATE_FUNNEL_THEME_STATUSES) &&
    (value.dataStatus === null || isEnumValue(value.dataStatus, CANDIDATE_FUNNEL_DATA_STATUSES))
  )
}

function validateCounts(value: unknown): value is CandidateFunnelArtifact['counts'] {
  if (!isPlainObject(value)) return false
  return (
    isNonNegativeInteger(value.total) &&
    isNonNegativeInteger(value.excluded) &&
    isNonNegativeInteger(value.screened) &&
    isNonNegativeInteger(value.deepReview) &&
    isNonNegativeInteger(value.actionable)
  )
}

function validateExcludedSummary(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  if (!isNonNegativeInteger(value.total)) return false
  if (!isPlainObject(value.byReason)) return false
  for (const [key, count] of Object.entries(value.byReason)) {
    if (!isEnumValue(key, CANDIDATE_FUNNEL_HARD_REASON_CODES)) return false
    if (!isNonNegativeInteger(count)) return false
  }
  return true
}

function validateSectorCountMap(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return Object.values(value).every((v) => isNonNegativeInteger(v))
}

function validateSectorDistribution(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (
    validateSectorCountMap(value.screened) &&
    validateSectorCountMap(value.deepReview) &&
    validateSectorCountMap(value.actionable)
  )
}

function validateScoreDistribution(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (
    isNonNegativeInteger(value.count) &&
    isFiniteOrNull(value.min) &&
    isFiniteOrNull(value.max) &&
    isFiniteOrNull(value.mean) &&
    isFiniteOrNull(value.median)
  )
}

function validateSelectionObservability(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (
    (value.regimeApplied === null || isEnumValue(value.regimeApplied, CANDIDATE_FUNNEL_REGIMES)) &&
    (value.actionableHardMaxApplied === null || isNonNegativeInteger(value.actionableHardMaxApplied)) &&
    (value.actionableSectorCapApplied === null || isNonNegativeInteger(value.actionableSectorCapApplied)) &&
    (value.deepReviewHardMaxApplied === null || isNonNegativeInteger(value.deepReviewHardMaxApplied)) &&
    (value.deepReviewSectorCapApplied === null || isNonNegativeInteger(value.deepReviewSectorCapApplied)) &&
    typeof value.deepReviewSectorCapRelaxed === 'boolean' &&
    typeof value.actionableSectorCapRelaxed === 'boolean' &&
    validateSectorCountMap(value.deepReviewSectorCapOverflow) &&
    validateSectorCountMap(value.actionableSectorCapOverflow) &&
    isNonNegativeInteger(value.deepReviewEligibleCount) &&
    isNonNegativeInteger(value.deepReviewSelectedCount) &&
    isNonNegativeInteger(value.actionableEligibleCount) &&
    isNonNegativeInteger(value.actionableSelectedCount) &&
    typeof value.sourceStale === 'boolean' &&
    typeof value.fallbackProvenance === 'boolean'
  )
}

function validateQualityGateEntry(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.metric === 'string' &&
    isJsonValue(value.value) &&
    typeof value.threshold === 'string' &&
    isEnumValue(value.status, CANDIDATE_FUNNEL_QUALITY_GATE_STATUSES) &&
    typeof value.note === 'string'
  )
}

// ── qualityGate構造 + P-01〜P-15完全性のみを検査する。
//    overallPass / hardFailIds の合否判定は呼び出し元で行う
//    （構造不正 = quality_gate_incomplete、合否不正 = quality_gate_failed
//    を呼び分けるため）。 ────────────────────────────────
function validateQualityGateStructure(value: unknown): value is CandidateFunnelArtifact['_meta']['qualityGate'] {
  if (!isPlainObject(value)) return false
  if (!Array.isArray(value.gates) || !value.gates.every(validateQualityGateEntry)) return false
  if (typeof value.overallPass !== 'boolean') return false
  if (!isStringArray(value.hardFailIds)) return false
  if (!isStringArray(value.notes)) return false

  const idCounts = new Map<string, number>()
  for (const gate of value.gates as Array<{ id: string }>) {
    idCounts.set(gate.id, (idCounts.get(gate.id) ?? 0) + 1)
  }
  for (const requiredId of CANDIDATE_FUNNEL_QUALITY_GATE_REQUIRED_IDS) {
    if ((idCounts.get(requiredId) ?? 0) !== 1) return false
  }
  return true
}

function validateJoin(value: unknown): value is CandidateFunnelArtifact['_meta']['join'] {
  if (!isPlainObject(value)) return false
  return (
    isNonNegativeInteger(value.candidateCount) &&
    isNonNegativeInteger(value.prescreenCount) &&
    isNonNegativeInteger(value.joinedCount) &&
    isNonNegativeInteger(value.unmatchedCandidateCount) &&
    isNonNegativeInteger(value.unmatchedPrescreenCount) &&
    isFiniteNumber(value.joinRate) &&
    value.joinRate >= 0 &&
    isFiniteNumber(value.unmatchedCandidateRate) &&
    value.unmatchedCandidateRate >= 0
  )
}

function doParse(input: unknown): CandidateFunnelParseResult {
  if (!isPlainObject(input)) return fail('malformed_root')
  if (containsForbiddenKey(input)) return fail('forbidden_key')

  if (input.schemaVersion !== CANDIDATE_FUNNEL_SCHEMA_VERSION) return fail('invalid_version')
  if (input.funnelVersion !== CANDIDATE_FUNNEL_VERSION) return fail('invalid_version')
  if (input.scoreVersion !== CANDIDATE_FUNNEL_SCORE_VERSION) return fail('invalid_version')
  if (input.not_for_trading !== true) return fail('privacy_violation')
  if (!isEnumValue(input.status, CANDIDATE_FUNNEL_STATUSES)) return fail('invalid_status')
  if (!isStringArray(input.degradationReasons)) return fail('invalid_status')
  if (!input.degradationReasons.every((r) => isEnumValue(r, CANDIDATE_FUNNEL_DEGRADATION_REASON_CODES))) {
    return fail('invalid_status')
  }

  if (!validateCounts(input.counts)) return fail('invalid_counts')
  const counts = input.counts as CandidateFunnelArtifact['counts']

  if (!Array.isArray(input.candidates)) return fail('invalid_candidates')
  if (!input.candidates.every(validateCandidate)) return fail('invalid_candidates')
  const candidates = input.candidates as CandidateFunnelCandidate[]

  if (candidates.length !== counts.total) return fail('invalid_counts')
  const tally = { excluded: 0, screened: 0, deep_review: 0, actionable: 0, eligible: 0 }
  for (const c of candidates) {
    tally[c.tier] += 1
  }
  if (
    tally.excluded !== counts.excluded ||
    tally.screened !== counts.screened ||
    tally.deep_review !== counts.deepReview ||
    tally.actionable !== counts.actionable
  ) {
    return fail('invalid_counts')
  }

  if (!validateExcludedSummary(input.excludedSummary)) return fail('invalid_distribution')
  if (!validateSectorDistribution(input.sectorDistribution)) return fail('invalid_distribution')
  if (!validateScoreDistribution(input.scoreDistribution)) return fail('invalid_distribution')
  if (!validateSelectionObservability(input.selectionObservability)) return fail('invalid_distribution')

  if (!isPlainObject(input._meta)) return fail('missing_meta')
  const meta = input._meta

  if (meta.kind !== 'candidate_funnel') return fail('invalid_meta')
  if (meta.not_for_trading !== true) return fail('invalid_meta')
  if (!isValidTimestamp(meta.generatedAt)) return fail('invalid_meta')
  if (!isValidTimestamp(meta.asOf)) return fail('invalid_meta')
  if (meta.sourceUpdatedAt !== null && !isValidTimestamp(meta.sourceUpdatedAt)) return fail('invalid_meta')

  if (!isEnumValue(meta.pipelinePath, CANDIDATE_FUNNEL_PIPELINE_PATHS)) return fail('invalid_provenance')
  if (meta.regimeRequested !== null && !isEnumValue(meta.regimeRequested, CANDIDATE_FUNNEL_REGIMES)) {
    return fail('invalid_provenance')
  }
  if (!validateJoin(meta.join)) return fail('invalid_provenance')

  if (!validateQualityGateStructure(meta.qualityGate)) return fail('quality_gate_incomplete')
  if (meta.qualityGate.overallPass !== true) return fail('quality_gate_failed')
  if (meta.qualityGate.hardFailIds.length !== 0) return fail('quality_gate_failed')

  return { ok: true, data: input as unknown as CandidateFunnelArtifact }
}

export function parseCandidateFunnelArtifact(input: unknown): CandidateFunnelParseResult {
  try {
    return doParse(input)
  } catch {
    return fail('unknown')
  }
}
