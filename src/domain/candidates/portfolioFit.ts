// ═══════════════════════════════════════════════════════════
// P5-B005-C-B1(-R1): portfolioFit categorical v1 — pure local domain engine。
//
// Authority:
//   /Users/ryo/jp-portfolio-audit-reports/
//     p5-b005-c-a2-portfolio-fit-frozen-specification.md (frozen, exact)
//     p5-b005-c-b1-v-independent-audit.md (P1-01..P1-10 repair authority)
//
// pure function only — Date.now/Math.random/network/localStorage/
// mutable singleton は一切使用しない。evaluatedAt は呼び出し側が注入する。
// store/selectors/UI/legacy stockCandidates/officialDecision/SAFE_MODE/
// TierA は一切 import しない。
// ═══════════════════════════════════════════════════════════

import type { CandidateFunnelCandidate } from '../../types/candidateFunnel'
import type { Holding, Trust } from '../../types/index'
// CASH-AUTH-1: 現金権限の鮮度/数値契約は純ドメイン関数として共有する
// （store/selectors には依存しない）。
import { evaluateCashAuthorityFreshness } from '../cash/cashAuthority'
import {
  CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS,
  CANDIDATE_PORTFOLIO_FIT_REASONS,
  CANDIDATE_PORTFOLIO_FIT_RISKS,
  CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
  CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
  CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
  CANDIDATE_PORTFOLIO_FIT_VERSION,
  PORTFOLIO_FIT_CANDIDATE_STALE_THRESHOLD_MS,
  PORTFOLIO_FIT_FUTURE_TOLERANCE_MS,
  PORTFOLIO_FIT_POLICY_MAX_RATIO,
  PORTFOLIO_FIT_POLICY_MIN_RATIO,
  PORTFOLIO_FIT_SOURCE_STALE_THRESHOLD_MS,
} from '../../types/candidatePortfolioFit'
import type {
  CandidateHoldingRelationship,
  CandidatePortfolioCapacityAssessment,
  CandidatePortfolioCapacityStatus,
  CandidatePortfolioFitCandidateSource,
  CandidatePortfolioFitComponent,
  CandidatePortfolioFitComponentStatus,
  CandidatePortfolioFitDatasetReason,
  CandidatePortfolioFitInput,
  CandidatePortfolioFitQualityGateId,
  CandidatePortfolioFitReason,
  CandidatePortfolioFitRecord,
  CandidatePortfolioFitResult,
  CandidatePortfolioFitRisk,
  CandidatePortfolioFitStatus,
  PortfolioFitCodeNormalizationResult,
  PortfolioFitHoldingAggregate,
  PortfolioFitHoldingAggregateDataStatus,
  PortfolioFitInputFreshness,
  PortfolioFitSnapshotInput,
} from '../../types/candidatePortfolioFit'

// ── §5 Exact code normalization ──────────────────────────────────────
const CANONICAL_CODE_PATTERN = /^\d{3}[0-9A-HJ-NP-Z]$/

export function normalizePortfolioFitCode(raw: unknown): PortfolioFitCodeNormalizationResult {
  let str: string
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0 || !Number.isSafeInteger(raw)) {
      return { status: 'invalid', normalizedCode: null }
    }
    str = String(raw)
  } else if (typeof raw === 'string') {
    str = raw
  } else {
    return { status: 'invalid', normalizedCode: null }
  }

  str = str.normalize('NFKC').trim().toUpperCase()
  if (str.endsWith('.T')) {
    str = str.slice(0, -2)
  }
  if (!CANONICAL_CODE_PATTERN.test(str)) {
    return { status: 'invalid', normalizedCode: null }
  }
  return { status: 'valid', normalizedCode: str }
}

function isValidEvalValue(v: number): boolean {
  return Number.isFinite(v) && v >= 0
}

// ── §11 (P1-10) Strict acquiredAt — reject Date.parse's lenient/
//    calendar-invalid acceptance. Exact accepted formats: date-only
//    `YYYY-MM-DD`, or full ISO datetime with an explicit `Z`/offset.
//    Bare/locale/whitespace/calendar-invalid input is never a valid lock
//    date — it makes the holding aggregate partial instead. ──────────
const ACQUIRED_AT_DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const ACQUIRED_AT_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]
}

function parseStrictAcquiredAt(raw: string): number | null {
  const dateOnly = ACQUIRED_AT_DATE_ONLY_PATTERN.exec(raw)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    if (!isValidCalendarDate(year, month, day)) return null
    const ms = Date.parse(`${raw}T00:00:00.000Z`)
    return Number.isFinite(ms) ? ms : null
  }
  const dateTime = ACQUIRED_AT_DATETIME_PATTERN.exec(raw)
  if (dateTime) {
    const year = Number(dateTime[1])
    const month = Number(dateTime[2])
    const day = Number(dateTime[3])
    if (!isValidCalendarDate(year, month, day)) return null
    const ms = Date.parse(raw)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

// ── §6 Holding normalization / aggregation ───────────────────────────
interface HoldingAggregationResult {
  aggregates: Map<string, PortfolioFitHoldingAggregate>
  hasInvalidCode: boolean
  hasDuplicateCode: boolean
  jpStockValidTotal: number
  hasPartialValue: boolean
}

function aggregateHoldings(holdings: readonly Holding[]): HoldingAggregationResult {
  const buckets = new Map<string, Holding[]>()
  let hasInvalidCode = false

  for (const h of holdings) {
    const norm = normalizePortfolioFitCode(h.code)
    if (norm.status === 'invalid' || norm.normalizedCode === null) {
      hasInvalidCode = true
      continue
    }
    const list = buckets.get(norm.normalizedCode)
    if (list) list.push(h)
    else buckets.set(norm.normalizedCode, [h])
  }

  const aggregates = new Map<string, PortfolioFitHoldingAggregate>()
  let hasDuplicateCode = false
  let jpStockValidTotal = 0
  let hasPartialValue = false

  for (const [code, list] of buckets) {
    if (list.length > 1) hasDuplicateCode = true

    let sum = 0
    let validCount = 0
    for (const h of list) {
      if (isValidEvalValue(h.eval)) {
        sum += h.eval
        validCount += 1
      }
    }

    let latestAcquiredAt: string | null = null
    let latestMs = -Infinity
    let dateMalformed = false
    for (const h of list) {
      if (h.acquiredAt === undefined || h.acquiredAt === null) continue
      const ms = parseStrictAcquiredAt(h.acquiredAt)
      if (ms === null) {
        dateMalformed = true
        continue
      }
      if (ms > latestMs) {
        latestMs = ms
        latestAcquiredAt = h.acquiredAt
      }
    }

    let dataStatus: PortfolioFitHoldingAggregateDataStatus
    let totalCurrentValue: number | null
    if (validCount === 0) {
      dataStatus = 'invalid'
      totalCurrentValue = null
    } else if (validCount < list.length || dateMalformed) {
      dataStatus = 'partial'
      totalCurrentValue = sum
    } else {
      dataStatus = 'complete'
      totalCurrentValue = sum
    }

    if (dataStatus !== 'complete') hasPartialValue = true
    if (totalCurrentValue !== null) jpStockValidTotal += totalCurrentValue

    aggregates.set(code, {
      normalizedCode: code,
      totalCurrentValue,
      acquiredAtForLock: latestAcquiredAt,
      sourceRecordCount: list.length,
      dataStatus,
    })
  }

  return { aggregates, hasInvalidCode, hasDuplicateCode, jpStockValidTotal, hasPartialValue }
}

// public wrapper — §6 の PortfolioFitHoldingAggregate 契約を直接検証できる
// ようにする（fit record自体はacquiredAtForLockを一切公開しない — lockは
// 実行専用metadataでありfit/capacityに影響しない）。
export function aggregatePortfolioFitHoldings(holdings: readonly Holding[]): {
  aggregates: readonly PortfolioFitHoldingAggregate[]
  hasInvalidCode: boolean
  hasDuplicateCode: boolean
  jpStockValidTotal: number
  hasPartialValue: boolean
} {
  const result = aggregateHoldings(holdings)
  return {
    aggregates: [...result.aggregates.values()],
    hasInvalidCode: result.hasInvalidCode,
    hasDuplicateCode: result.hasDuplicateCode,
    jpStockValidTotal: result.jpStockValidTotal,
    hasPartialValue: result.hasPartialValue,
  }
}

function sumValidTrustValue(trusts: readonly Trust[]): { total: number; hasPartial: boolean } {
  let total = 0
  let hasPartial = false
  for (const t of trusts) {
    if (isValidEvalValue(t.eval)) total += t.eval
    else hasPartial = true
  }
  return { total, hasPartial }
}

// (P1-03) sector population must match the exact same valid-code population
// used by jpStockValidTotal — a holding whose code fails normalization is
// excluded from both the numerator and the denominator alike. Before this
// fix, an invalid-code holding's `eval` still leaked into the numerator
// while jpStockValidTotal (denominator) excluded it, producing ratio>1.
function computeSectorExposure(
  holdings: readonly Holding[],
  candidateSector: string,
): { value: number; degraded: boolean } {
  let value = 0
  let degraded = false
  for (const h of holdings) {
    const norm = normalizePortfolioFitCode(h.code)
    if (norm.status === 'invalid') continue
    if (!isValidEvalValue(h.eval) || h.eval <= 0) continue
    const sectorOk = typeof h.sector === 'string' && h.sector !== '' && h.sector !== '未分類'
    if (!sectorOk) {
      degraded = true
      continue
    }
    if (h.sector === candidateSector) value += h.eval
  }
  return { value, degraded }
}

// ── §6 Relationship ───────────────────────────────────────────────────
function determineRelationship(
  normalizedCode: string | null,
  aggregates: Map<string, PortfolioFitHoldingAggregate>,
  hasInvalidCode: boolean,
): { relationship: CandidateHoldingRelationship; risks: CandidatePortfolioFitRisk[] } {
  if (normalizedCode === null) {
    return { relationship: 'holding_match_unknown', risks: ['HOLDING_MATCH_UNKNOWN'] }
  }
  const agg = aggregates.get(normalizedCode)
  if (agg && agg.totalCurrentValue !== null && agg.totalCurrentValue > 0) {
    return { relationship: 'already_held', risks: [] }
  }
  if (agg && agg.dataStatus === 'invalid') {
    return { relationship: 'holding_match_unknown', risks: ['HOLDING_MATCH_UNKNOWN'] }
  }
  if (hasInvalidCode) {
    return { relationship: 'holding_match_unknown', risks: ['HOLDING_MATCH_UNKNOWN'] }
  }
  return { relationship: 'new_to_portfolio', risks: [] }
}

// ── §7 Candidate freshness (defense-in-depth 48h re-check) ────────────
type CandidateFreshnessEffective = 'fresh' | 'stale_or_degraded' | 'unavailable' | 'invalid'

function assessCandidateFreshness(
  candidateSource: CandidatePortfolioFitCandidateSource,
  evaluatedAtMs: number,
): { effective: CandidateFreshnessEffective; generatedAt: string | null; reason: CandidatePortfolioFitDatasetReason | null } {
  if (candidateSource.status !== 'available') {
    if (candidateSource.status === 'unavailable') {
      return { effective: 'unavailable', generatedAt: null, reason: 'CANDIDATE_INPUT_UNAVAILABLE' }
    }
    return { effective: 'invalid', generatedAt: null, reason: 'CANDIDATE_INPUT_INVALID' }
  }

  const generatedAt = candidateSource.artifact._meta.generatedAt
  if (candidateSource.freshness === 'degraded') {
    return { effective: 'stale_or_degraded', generatedAt, reason: 'CANDIDATE_INPUT_DEGRADED' }
  }
  if (candidateSource.freshness === 'stale') {
    return { effective: 'stale_or_degraded', generatedAt, reason: 'CANDIDATE_INPUT_STALE' }
  }

  const generatedMs = Date.parse(generatedAt)
  if (!Number.isFinite(generatedMs) || evaluatedAtMs - generatedMs > PORTFOLIO_FIT_CANDIDATE_STALE_THRESHOLD_MS) {
    return { effective: 'stale_or_degraded', generatedAt, reason: 'CANDIDATE_INPUT_STALE' }
  }
  return { effective: 'fresh', generatedAt, reason: null }
}

// ── §7 Portfolio snapshot freshness ───────────────────────────────────
function assessPortfolioFreshness(
  snapshot: PortfolioFitSnapshotInput | null,
  evaluatedAtMs: number,
): { freshness: PortfolioFitInputFreshness; reasons: CandidatePortfolioFitDatasetReason[]; sourceAsOf: string | null } {
  if (snapshot === null) {
    return { freshness: 'unavailable', reasons: ['PORTFOLIO_SNAPSHOT_UNAVAILABLE'], sourceAsOf: null }
  }
  if (snapshot.existence === 'invalid') {
    return { freshness: 'invalid', reasons: ['PORTFOLIO_SNAPSHOT_INVALID'], sourceAsOf: null }
  }

  const claimedEmpty = snapshot.existence === 'present_empty'
  const actuallyEmpty = snapshot.holdings.length === 0
  if (claimedEmpty !== actuallyEmpty) {
    return { freshness: 'invalid', reasons: ['PORTFOLIO_SNAPSHOT_INVALID'], sourceAsOf: null }
  }

  if (snapshot.crossTabState === 'stale') {
    return { freshness: 'stale', reasons: ['CROSS_TAB_STATE_STALE'], sourceAsOf: snapshot.provenance?.sourceAsOf ?? null }
  }

  const provenance = snapshot.provenance
  const sourceAsOf = provenance?.sourceAsOf ?? null
  if (sourceAsOf === null) {
    return { freshness: 'partial', reasons: ['PORTFOLIO_SOURCE_AS_OF_MISSING'], sourceAsOf: null }
  }
  if (provenance!.sourceAsOfConfidence !== 'authoritative') {
    return { freshness: 'partial', reasons: ['PORTFOLIO_SOURCE_AS_OF_WEAK'], sourceAsOf }
  }
  const sourceMs = Date.parse(sourceAsOf)
  if (!Number.isFinite(sourceMs)) {
    return { freshness: 'invalid', reasons: ['PORTFOLIO_SNAPSHOT_INVALID'], sourceAsOf }
  }
  const deltaMs = evaluatedAtMs - sourceMs
  if (deltaMs < -PORTFOLIO_FIT_FUTURE_TOLERANCE_MS) {
    return { freshness: 'invalid', reasons: ['PORTFOLIO_SOURCE_FUTURE'], sourceAsOf }
  }
  if (deltaMs > PORTFOLIO_FIT_SOURCE_STALE_THRESHOLD_MS) {
    return { freshness: 'stale', reasons: ['PORTFOLIO_SOURCE_STALE'], sourceAsOf }
  }
  return { freshness: 'fresh', reasons: [], sourceAsOf }
}

// (P1-05) Global result precedence is `invalid > unavailable > partial >
// evaluated` (A2 §11) — the candidate axis and the portfolio axis must be
// combined by taking the MAX severity, never by letting one axis's forced
// label silently shadow a more severe state on the other axis.
function portfolioFreshnessLevel(freshness: PortfolioFitInputFreshness): number {
  if (freshness === 'invalid') return 3
  if (freshness === 'stale' || freshness === 'unavailable') return 2
  if (freshness === 'partial') return 1
  return 0
}

// ── §9/§12 Capacity (dataset-level, independent of per-record fit) ───
function computeCapacity(
  snapshot: PortfolioFitSnapshotInput | null,
  evaluatedAtMs: number,
  portfolioFreshness: PortfolioFitInputFreshness,
  portfolioFreshnessReasons: readonly CandidatePortfolioFitDatasetReason[],
  jpStockValidTotal: number,
  holdingHasPartialValue: boolean,
  trustCurrentValue: number,
  trustHasPartial: boolean,
): { capacity: CandidatePortfolioCapacityAssessment; unknownReasonDetected: boolean } {
  if (snapshot === null) {
    return {
      capacity: { assetClass: 'JP_STOCK', status: 'unavailable', reasons: ['PORTFOLIO_SNAPSHOT_UNAVAILABLE'] },
      unknownReasonDetected: false,
    }
  }
  if (snapshot.existence === 'invalid' || portfolioFreshness === 'invalid') {
    return {
      capacity: { assetClass: 'JP_STOCK', status: 'unavailable', reasons: ['PORTFOLIO_SNAPSHOT_INVALID'] },
      unknownReasonDetected: false,
    }
  }

  const policy = snapshot.portfolioPolicy
  const policyValid =
    policy != null &&
    Number.isFinite(policy.jpStockMaxRatio) &&
    policy.jpStockMaxRatio >= PORTFOLIO_FIT_POLICY_MIN_RATIO &&
    policy.jpStockMaxRatio <= PORTFOLIO_FIT_POLICY_MAX_RATIO
  if (!policyValid) {
    return {
      capacity: { assetClass: 'JP_STOCK', status: 'unavailable', reasons: ['POLICY_AUTHORITY_UNAVAILABLE'] },
      unknownReasonDetected: false,
    }
  }

  // (P1-01) required numeric authority (holding/trust valid-value totals)
  // must be complete. A2 §9 groups "required numeric invalid" under the
  // `unavailable` status — the same severity tier as a missing/invalid
  // snapshot or policy — never silently downgraded to `available`.
  const numericReasons: CandidatePortfolioFitDatasetReason[] = []
  if (holdingHasPartialValue) numericReasons.push('HOLDING_VALUE_PARTIAL')
  if (trustHasPartial) numericReasons.push('TRUST_VALUE_PARTIAL')
  if (numericReasons.length > 0) {
    const deduped = dedupePortfolioFitLiteralsStrict(numericReasons, CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS)
    return {
      capacity: { assetClass: 'JP_STOCK', status: 'unavailable', reasons: deduped.values },
      unknownReasonDetected: deduped.unknownValues.length > 0,
    }
  }

  const reasons: CandidatePortfolioFitDatasetReason[] = []
  let sourceUnknown = false
  if (portfolioFreshness === 'stale' || portfolioFreshness === 'partial') {
    sourceUnknown = true
    reasons.push(...portfolioFreshnessReasons)
  }

  // CASH-AUTH-1: 現金権限の鮮度・数値契約は cashAuthority に一元化されている。
  // ここは同じ判定結果を読むだけで、独自のTTL/数値検証は持たない。
  // 総資産分母には総現金（grossCash）を一度だけ加算する — safetyReserve /
  // pendingOrderCash は総現金の部分集合であり、加算も減算もしない。
  const cash = snapshot.cashAssumptions
  let cashTotal = 0
  let cashUnknown = false
  if (cash == null || cash.source !== 'MANUAL') {
    cashUnknown = true
    reasons.push('CASH_AUTHORITY_UNAVAILABLE')
  } else {
    const freshness = evaluateCashAuthorityFreshness(cash, evaluatedAtMs)
    if (freshness.state !== 'known_fresh') {
      cashUnknown = true
      reasons.push('CASH_AUTHORITY_STALE')
    } else {
      cashTotal = cash.grossCash
    }
  }

  if (sourceUnknown || cashUnknown) {
    const deduped = dedupePortfolioFitLiteralsStrict(reasons, CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS)
    return {
      capacity: { assetClass: 'JP_STOCK', status: 'unknown', reasons: deduped.values },
      unknownReasonDetected: deduped.unknownValues.length > 0,
    }
  }

  const portfolioTotalValue = jpStockValidTotal + trustCurrentValue + cashTotal
  if (portfolioTotalValue <= 0) {
    return {
      capacity: { assetClass: 'JP_STOCK', status: 'unknown', reasons: ['CAPACITY_UNAVAILABLE'] },
      unknownReasonDetected: false,
    }
  }
  const jpStockCap = policy!.jpStockMaxRatio * portfolioTotalValue
  const rawHeadroom = jpStockCap - jpStockValidTotal
  const status: CandidatePortfolioCapacityStatus = rawHeadroom > 0 ? 'available' : 'constrained'
  return { capacity: { assetClass: 'JP_STOCK', status, reasons: [] }, unknownReasonDetected: false }
}

// ── §8 Components (per record) ────────────────────────────────────────
function componentLevel(status: CandidatePortfolioFitComponentStatus): number {
  if (status === 'unavailable') return 2
  if (status === 'partial') return 1
  return 0 // evaluated / not_applicable / reserved
}

function computeComponentsForRecord(params: {
  candidate: CandidateFunnelCandidate
  normalizedCode: string | null
  relationship: CandidateHoldingRelationship
  existence: 'present_empty' | 'present_nonempty'
  jpStockValidTotal: number
  trustCurrentValue: number
  totalValuePartial: boolean
  aggregates: Map<string, PortfolioFitHoldingAggregate>
  holdings: readonly Holding[]
}): CandidatePortfolioFitComponent[] {
  const {
    candidate,
    normalizedCode,
    relationship,
    existence,
    jpStockValidTotal,
    trustCurrentValue,
    totalValuePartial,
    aggregates,
    holdings,
  } = params

  const sameCodeValue = relationship === 'already_held' ? 1 : relationship === 'new_to_portfolio' ? 0 : null
  const sameCodeStatus: CandidatePortfolioFitComponentStatus =
    relationship === 'holding_match_unknown' ? 'unavailable' : 'evaluated'
  const sameCodeReasons: CandidatePortfolioFitReason[] =
    relationship === 'already_held' ? ['ALREADY_HELD'] : relationship === 'new_to_portfolio' ? ['NEW_TO_PORTFOLIO'] : []
  const sameCodeRisks: CandidatePortfolioFitRisk[] =
    relationship === 'holding_match_unknown' ? ['HOLDING_MATCH_UNKNOWN'] : []

  // (P1-04) concentration denominator is the total current securities value
  // (JP-stock + trust), not the JP-stock subtotal alone — A2 §8: "same-code
  // aggregate / total current portfolio value".
  // (P1-02) when any holding/trust numeric authority is partial/invalid
  // anywhere in the snapshot, that shared denominator is unreliable for
  // every record — concentration must reflect `partial`, never a fabricated
  // complete ratio.
  let concentrationValue: number | null = null
  let concentrationStatus: CandidatePortfolioFitComponentStatus
  const concentrationReasons: CandidatePortfolioFitReason[] = []
  const concentrationRisks: CandidatePortfolioFitRisk[] = []
  const totalValueForConcentration = jpStockValidTotal + trustCurrentValue
  if (existence === 'present_empty') {
    concentrationValue = 0
    concentrationStatus = 'evaluated'
    concentrationReasons.push('EXISTING_CODE_CONCENTRATION_MEASURED')
  } else if (totalValueForConcentration <= 0) {
    concentrationValue = null
    concentrationStatus = 'unavailable'
    concentrationRisks.push('EXISTING_CONCENTRATION_UNAVAILABLE')
  } else if (totalValuePartial) {
    concentrationValue = null
    concentrationStatus = 'partial'
  } else if (normalizedCode !== null) {
    const agg = aggregates.get(normalizedCode)
    const positive = agg && agg.totalCurrentValue !== null && agg.totalCurrentValue > 0 ? agg.totalCurrentValue : 0
    concentrationValue = positive / totalValueForConcentration
    concentrationStatus = 'evaluated'
    concentrationReasons.push('EXISTING_CODE_CONCENTRATION_MEASURED')
  } else {
    concentrationValue = null
    concentrationStatus = 'unavailable'
    concentrationRisks.push('EXISTING_CONCENTRATION_UNAVAILABLE')
  }

  let sectorValue: number | null = null
  let sectorStatus: CandidatePortfolioFitComponentStatus
  const sectorReasons: CandidatePortfolioFitReason[] = []
  const sectorRisks: CandidatePortfolioFitRisk[] = []
  const candidateSectorValid = candidate.sector !== '' && candidate.sector !== '未分類'
  if (!candidateSectorValid) {
    sectorStatus = 'not_applicable'
  } else if (existence === 'present_empty') {
    sectorValue = 0
    sectorStatus = 'evaluated'
    sectorReasons.push('SECTOR_EXPOSURE_MEASURED')
  } else if (jpStockValidTotal <= 0) {
    sectorStatus = 'unavailable'
  } else {
    const { value, degraded } = computeSectorExposure(holdings, candidate.sector)
    if (degraded) {
      sectorStatus = 'partial'
      sectorValue = null
      sectorRisks.push('SECTOR_AUTHORITY_PARTIAL')
    } else {
      sectorStatus = 'evaluated'
      sectorValue = value / jpStockValidTotal
      sectorReasons.push('SECTOR_EXPOSURE_MEASURED')
    }
  }

  return [
    {
      id: 'same_code_relationship',
      value: sameCodeValue,
      status: sameCodeStatus,
      contribution: null,
      reasons: sameCodeReasons,
      risks: sameCodeRisks,
    },
    {
      id: 'existing_concentration',
      value: concentrationValue,
      status: concentrationStatus,
      contribution: null,
      reasons: concentrationReasons,
      risks: concentrationRisks,
    },
    {
      id: 'sector_diversification',
      value: sectorValue,
      status: sectorStatus,
      contribution: null,
      reasons: sectorReasons,
      risks: sectorRisks,
    },
  ]
}

// (P1-08 / M-28) fail-closed literal dedupe — an unknown/unexpected literal
// (e.g. a reserved `SOFT_PORTFOLIO_OVERLAP` leaking in from a corrupted
// internal push) is NEVER silently filtered away like a plain declaration-
// order intersection would do. It is excluded from the returned `values`
// (the output type cannot legitimately carry it) but is also surfaced via
// `unknownValues` so the caller can fail closed (hard-fail + invalid
// result) instead of returning a silently-laundered `evaluated` output.
export function dedupePortfolioFitLiteralsStrict<T extends string>(
  items: readonly string[],
  declarationOrder: readonly T[],
): { values: T[]; unknownValues: string[] } {
  const declared = new Set<string>(declarationOrder)
  const present = new Set<T>()
  const unknownValues: string[] = []
  for (const item of items) {
    if (!declared.has(item)) {
      if (!unknownValues.includes(item)) unknownValues.push(item)
      continue
    }
    present.add(item as T)
  }
  const values = declarationOrder.filter((o) => present.has(o))
  return { values, unknownValues }
}

const STATUS_LEVEL: Record<CandidatePortfolioFitStatus, number> = {
  evaluated: 0,
  partial: 1,
  unavailable: 2,
  invalid: 3,
}
const LEVEL_STATUS: readonly CandidatePortfolioFitStatus[] = ['evaluated', 'partial', 'unavailable', 'invalid']

// ── §11 (P1-06) Quality gate — real invariant checks, not a permanently
//    empty stub. All hard-fail conditions force the overall result status
//    to `invalid` (A2 §11: "All QG failures are hard for fit"). ─────────
function buildResult(params: {
  proposedStatus: CandidatePortfolioFitStatus
  records: CandidatePortfolioFitRecord[]
  candidateGeneratedAt: string | null
  portfolioSourceAsOf: string | null
  portfolioFreshness: PortfolioFitInputFreshness
  capacity: CandidatePortfolioCapacityAssessment
  evaluatedAt: string
  degradationReasons: CandidatePortfolioFitDatasetReason[]
  inputTargetCount: number
  candidateEffective: CandidateFreshnessEffective | null
  unknownLiteralDetected: boolean
}): CandidatePortfolioFitResult {
  const hardFailIds = new Set<CandidatePortfolioFitQualityGateId>()
  const warningIds = new Set<CandidatePortfolioFitQualityGateId>()

  if (params.candidateEffective === 'invalid') hardFailIds.add('PF-QG-01-CANDIDATE_CONTRACT')
  if (params.portfolioFreshness === 'invalid') hardFailIds.add('PF-QG-02-SNAPSHOT_CONTRACT')
  if (params.inputTargetCount !== params.records.length) hardFailIds.add('PF-QG-03-F2_COUNT_PARITY')

  const seenIds = new Set<string>()
  for (const r of params.records) {
    if (seenIds.has(r.candidateRecordId)) hardFailIds.add('PF-QG-04-RECORD_ID_UNIQUE')
    seenIds.add(r.candidateRecordId)
    if (r.portfolioFitScore !== null || r.portfolioFitRank !== null) {
      hardFailIds.add('PF-QG-07-SCORE_NULL_OR_FINITE')
    }
    for (const c of r.components) {
      if (c.value !== null && !Number.isFinite(c.value)) hardFailIds.add('PF-QG-07-SCORE_NULL_OR_FINITE')
    }
    if (r.candidateTier !== 'deep_review' && r.candidateTier !== 'actionable') {
      hardFailIds.add('PF-QG-12-F2_ONLY')
    }
  }

  if (params.unknownLiteralDetected) {
    // an unknown reason/risk/dataset-reason literal is exactly how a
    // reserved/legacy concept (e.g. `SOFT_PORTFOLIO_OVERLAP`) or a future
    // trade-scope concept could leak into this local-only categorical
    // output — A2 §11 groups QG-10/QG-11 together as release-blocking
    // privacy/scope failures, so both are raised together.
    hardFailIds.add('PF-QG-10-PRIVACY_KEYS')
    hardFailIds.add('PF-QG-11-TRADE_FIELDS_ABSENT')
  }

  // P1-06 / C-B1-R2 warning mapping. The frozen quality-gate union has
  // invariant families rather than degradation-specific literals, so soft
  // authority gaps reuse the matching input-contract family without turning
  // them into hard failures:
  //   PF-QG-01 = candidate-side soft authority/identity degradation
  //   PF-QG-02 = portfolio/snapshot/component/capacity soft degradation
  // Candidate is evaluated first, then portfolio, matching the frozen QG
  // declaration order. Sets keep repeated causes deterministic and unique.
  const degradationReasonSet = new Set(params.degradationReasons)
  const hasCandidateWarning =
    params.candidateEffective === 'stale_or_degraded' ||
    degradationReasonSet.has('CANDIDATE_INPUT_STALE') ||
    degradationReasonSet.has('CANDIDATE_INPUT_DEGRADED') ||
    degradationReasonSet.has('DUPLICATE_CANDIDATE_CODE')
  if (!hardFailIds.has('PF-QG-01-CANDIDATE_CONTRACT') && hasCandidateWarning) {
    warningIds.add('PF-QG-01-CANDIDATE_CONTRACT')
  }

  const portfolioWarningReasons: readonly CandidatePortfolioFitDatasetReason[] = [
    'PORTFOLIO_SOURCE_AS_OF_MISSING',
    'PORTFOLIO_SOURCE_AS_OF_WEAK',
    'HOLDING_CODE_INVALID',
    'HOLDING_VALUE_PARTIAL',
    'HOLDING_SECTOR_UNAVAILABLE',
    'TRUST_VALUE_PARTIAL',
    'CASH_AUTHORITY_UNAVAILABLE',
    'CASH_AUTHORITY_STALE',
    'POLICY_AUTHORITY_UNAVAILABLE',
    'CAPACITY_UNAVAILABLE',
    'DUPLICATE_HOLDING_CODE',
    'COMPONENT_COVERAGE_PARTIAL',
  ]
  const hasSectorAuthorityWarning = params.records.some((record) =>
    record.components.some((component) => component.risks.includes('SECTOR_AUTHORITY_PARTIAL')),
  )
  const hasPortfolioWarning =
    params.portfolioFreshness === 'partial' ||
    params.capacity.status === 'unknown' ||
    params.capacity.status === 'unavailable' ||
    hasSectorAuthorityWarning ||
    portfolioWarningReasons.some((reason) => degradationReasonSet.has(reason))
  if (!hardFailIds.has('PF-QG-02-SNAPSHOT_CONTRACT') && hasPortfolioWarning) {
    warningIds.add('PF-QG-02-SNAPSHOT_CONTRACT')
  }

  const status: CandidatePortfolioFitStatus = hardFailIds.size > 0 ? 'invalid' : params.proposedStatus

  return {
    schemaVersion: CANDIDATE_PORTFOLIO_FIT_SCHEMA_VERSION,
    fitVersion: CANDIDATE_PORTFOLIO_FIT_VERSION,
    scoreModel: CANDIDATE_PORTFOLIO_FIT_SCORE_MODEL,
    targetPopulation: CANDIDATE_PORTFOLIO_FIT_TARGET_POPULATION,
    not_for_trading: true,
    privacyMode: 'local_only',
    persistence: 'none',
    evaluatedAt: params.evaluatedAt,
    candidateGeneratedAt: params.candidateGeneratedAt,
    portfolioSourceAsOf: params.portfolioSourceAsOf,
    portfolioFreshness: params.portfolioFreshness,
    status,
    capacity: params.capacity,
    records: params.records,
    degradationReasons: params.degradationReasons,
    qualityGate: {
      inputTargetCount: params.inputTargetCount,
      outputRecordCount: params.records.length,
      hardFailIds: [...hardFailIds],
      warningIds: [...warningIds],
    },
  }
}

// ── Main entry point ───────────────────────────────────────────────────
export function computePortfolioFit(input: CandidatePortfolioFitInput): CandidatePortfolioFitResult {
  const { candidateSource, portfolioSnapshot, evaluatedAt } = input
  const evaluatedAtMs = Date.parse(evaluatedAt)
  const evaluatedAtValid = Number.isFinite(evaluatedAtMs)

  const degradationReasonsSet = new Set<CandidatePortfolioFitDatasetReason>()
  const addReason = (r: CandidatePortfolioFitDatasetReason) => degradationReasonsSet.add(r)
  let unknownLiteralDetected = false

  if (!evaluatedAtValid) {
    return buildResult({
      proposedStatus: 'invalid',
      records: [],
      candidateGeneratedAt: null,
      portfolioSourceAsOf: null,
      portfolioFreshness: 'invalid',
      capacity: { assetClass: 'JP_STOCK', status: 'unavailable', reasons: [] },
      evaluatedAt,
      degradationReasons: [],
      inputTargetCount: 0,
      candidateEffective: null,
      unknownLiteralDetected: false,
    })
  }

  const candidateAssessment = assessCandidateFreshness(candidateSource, evaluatedAtMs)
  const portfolioAssessment = assessPortfolioFreshness(portfolioSnapshot, evaluatedAtMs)

  const holdingAgg: HoldingAggregationResult =
    portfolioSnapshot && portfolioSnapshot.existence !== 'invalid'
      ? aggregateHoldings(portfolioSnapshot.holdings)
      : { aggregates: new Map(), hasInvalidCode: false, hasDuplicateCode: false, jpStockValidTotal: 0, hasPartialValue: false }

  const { total: trustCurrentValue, hasPartial: trustHasPartial } =
    portfolioSnapshot && portfolioSnapshot.existence !== 'invalid'
      ? sumValidTrustValue(portfolioSnapshot.trusts)
      : { total: 0, hasPartial: false }

  const { capacity, unknownReasonDetected: capacityUnknownReasonDetected } = computeCapacity(
    portfolioSnapshot,
    evaluatedAtMs,
    portfolioAssessment.freshness,
    portfolioAssessment.reasons,
    holdingAgg.jpStockValidTotal,
    holdingAgg.hasPartialValue,
    trustCurrentValue,
    trustHasPartial,
  )
  if (capacityUnknownReasonDetected) unknownLiteralDetected = true

  if (candidateAssessment.reason) addReason(candidateAssessment.reason)
  portfolioAssessment.reasons.forEach(addReason)
  capacity.reasons.forEach(addReason)
  if (holdingAgg.hasInvalidCode) addReason('HOLDING_CODE_INVALID')
  if (holdingAgg.hasPartialValue) addReason('HOLDING_VALUE_PARTIAL')
  if (holdingAgg.hasDuplicateCode) addReason('DUPLICATE_HOLDING_CODE')
  if (trustHasPartial) addReason('TRUST_VALUE_PARTIAL')

  if (candidateAssessment.effective === 'invalid' || candidateAssessment.effective === 'unavailable') {
    // (P1-05) global max precedence — a candidate-side unavailable/invalid
    // label must never shadow a more severe portfolio-side invalid state.
    const candidateLevel = candidateAssessment.effective === 'invalid' ? 3 : 2
    const portfolioLevel = portfolioFreshnessLevel(portfolioAssessment.freshness)
    const overallLevel = Math.max(candidateLevel, portfolioLevel)
    const degDeduped = dedupePortfolioFitLiteralsStrict([...degradationReasonsSet], CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS)
    if (degDeduped.unknownValues.length > 0) unknownLiteralDetected = true
    return buildResult({
      proposedStatus: LEVEL_STATUS[overallLevel],
      records: [],
      candidateGeneratedAt: null,
      portfolioSourceAsOf: portfolioAssessment.sourceAsOf,
      portfolioFreshness: portfolioAssessment.freshness,
      capacity,
      evaluatedAt,
      degradationReasons: degDeduped.values,
      inputTargetCount: 0,
      candidateEffective: candidateAssessment.effective,
      unknownLiteralDetected,
    })
  }

  // candidate available (fresh or stale/degraded) -> identify F2 target population
  const artifact = (candidateSource as Extract<CandidatePortfolioFitCandidateSource, { status: 'available' }>).artifact
  const candidateGeneratedAt = candidateAssessment.generatedAt

  const targets: { candidate: CandidateFunnelCandidate; artifactIndex: number }[] = []
  artifact.candidates.forEach((c, idx) => {
    if (c.tier === 'deep_review' || c.tier === 'actionable') targets.push({ candidate: c, artifactIndex: idx })
  })

  const targetNormalized: (string | null)[] = targets.map((t) => normalizePortfolioFitCode(t.candidate.code).normalizedCode)
  const codeCount = new Map<string, number>()
  targetNormalized.forEach((code) => {
    if (code !== null) codeCount.set(code, (codeCount.get(code) ?? 0) + 1)
  })
  const hasDuplicateCandidateCode = [...codeCount.values()].some((c) => c > 1)
  if (hasDuplicateCandidateCode) addReason('DUPLICATE_CANDIDATE_CODE')

  const candidateForcedUnavailable = candidateAssessment.effective === 'stale_or_degraded'

  const datasetFloorLevel = (() => {
    if (portfolioAssessment.freshness === 'partial') return 1
    if (hasDuplicateCandidateCode) return 1
    if (holdingAgg.hasDuplicateCode) return 1
    return 0
  })()

  const snapshotForRecords =
    portfolioSnapshot && portfolioSnapshot.existence !== 'invalid'
      ? (portfolioSnapshot as Extract<PortfolioFitSnapshotInput, { existence: 'present_empty' | 'present_nonempty' }>)
      : null

  const totalValuePartial = holdingAgg.hasPartialValue || trustHasPartial

  const records: CandidatePortfolioFitRecord[] = targets.map((t, i) => {
    const normalizedCode = targetNormalized[i]
    const candidateRecordId = `artifact:${t.artifactIndex}`
    const candidateTier = t.candidate.tier as 'deep_review' | 'actionable'

    const portfolioUnusable =
      candidateForcedUnavailable ||
      portfolioAssessment.freshness === 'unavailable' ||
      portfolioAssessment.freshness === 'invalid' ||
      portfolioAssessment.freshness === 'stale' ||
      snapshotForRecords === null

    if (portfolioUnusable) {
      // (P1-05) same global max precedence at record level.
      const candidateLevel = candidateForcedUnavailable ? 2 : 0
      const portfolioLevel = portfolioFreshnessLevel(portfolioAssessment.freshness)
      const forcedStatus = LEVEL_STATUS[Math.max(candidateLevel, portfolioLevel)]
      const components: CandidatePortfolioFitComponent[] = [
        {
          id: 'same_code_relationship',
          value: null,
          status: 'unavailable',
          contribution: null,
          reasons: [],
          risks: ['HOLDING_MATCH_UNKNOWN'],
        },
        {
          id: 'existing_concentration',
          value: null,
          status: 'unavailable',
          contribution: null,
          reasons: [],
          risks: ['EXISTING_CONCENTRATION_UNAVAILABLE'],
        },
        { id: 'sector_diversification', value: null, status: 'unavailable', contribution: null, reasons: [], risks: [] },
      ]
      return {
        candidateRecordId,
        artifactIndex: t.artifactIndex,
        code: t.candidate.code,
        normalizedCode,
        candidateMarketRank: t.candidate.marketRank,
        candidateTier,
        holdingRelationship: 'holding_match_unknown',
        portfolioFitScore: null,
        portfolioFitRank: null,
        portfolioFitStatus: forcedStatus,
        components,
        fitReasons: [],
        fitRisks: ['HOLDING_MATCH_UNKNOWN'],
      }
    }

    const snapshot = snapshotForRecords!
    const { relationship } = determineRelationship(normalizedCode, holdingAgg.aggregates, holdingAgg.hasInvalidCode)

    const components = computeComponentsForRecord({
      candidate: t.candidate,
      normalizedCode,
      relationship,
      existence: snapshot.existence,
      jpStockValidTotal: holdingAgg.jpStockValidTotal,
      trustCurrentValue,
      totalValuePartial,
      aggregates: holdingAgg.aggregates,
      holdings: snapshot.holdings,
    })

    const evaluatedCount = components.filter((c) => c.status === 'evaluated').length
    const componentCoveragePartial = evaluatedCount === 0

    const recordLevel = Math.max(...components.map((c) => componentLevel(c.status)))
    const finalLevel = Math.max(recordLevel, datasetFloorLevel)
    const portfolioFitStatus = LEVEL_STATUS[finalLevel]

    const reasonsDeduped = dedupePortfolioFitLiteralsStrict(
      components.flatMap((c) => c.reasons),
      CANDIDATE_PORTFOLIO_FIT_REASONS,
    )
    const fitRisksRaw: CandidatePortfolioFitRisk[] = components.flatMap((c) => c.risks)
    if (componentCoveragePartial) fitRisksRaw.push('COMPONENT_COVERAGE_PARTIAL')
    const risksDeduped = dedupePortfolioFitLiteralsStrict(fitRisksRaw, CANDIDATE_PORTFOLIO_FIT_RISKS)
    if (reasonsDeduped.unknownValues.length > 0 || risksDeduped.unknownValues.length > 0) {
      unknownLiteralDetected = true
    }

    if (componentCoveragePartial) addReason('COMPONENT_COVERAGE_PARTIAL')

    return {
      candidateRecordId,
      artifactIndex: t.artifactIndex,
      code: t.candidate.code,
      normalizedCode,
      candidateMarketRank: t.candidate.marketRank,
      candidateTier,
      holdingRelationship: relationship,
      portfolioFitScore: null,
      portfolioFitRank: null,
      portfolioFitStatus,
      components,
      fitReasons: reasonsDeduped.values,
      fitRisks: risksDeduped.values,
    }
  })

  const recordWorstLevel = records.length > 0 ? Math.max(...records.map((r) => STATUS_LEVEL[r.portfolioFitStatus])) : 0
  const overallLevel = Math.max(recordWorstLevel, datasetFloorLevel)
  const status = LEVEL_STATUS[overallLevel]

  const degDeduped = dedupePortfolioFitLiteralsStrict([...degradationReasonsSet], CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS)
  if (degDeduped.unknownValues.length > 0) unknownLiteralDetected = true

  return buildResult({
    proposedStatus: status,
    records,
    candidateGeneratedAt,
    portfolioSourceAsOf: portfolioAssessment.sourceAsOf,
    portfolioFreshness: portfolioAssessment.freshness,
    capacity,
    evaluatedAt,
    degradationReasons: degDeduped.values,
    inputTargetCount: targets.length,
    candidateEffective: candidateAssessment.effective,
    unknownLiteralDetected,
  })
}
