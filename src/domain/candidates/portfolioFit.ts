// ═══════════════════════════════════════════════════════════
// P5-B005-C-B1: portfolioFit categorical v1 — pure local domain engine。
//
// Authority: /Users/ryo/jp-portfolio-audit-reports/
//   p5-b005-c-a2-portfolio-fit-frozen-specification.md (frozen, exact)
//
// pure function only — Date.now/Math.random/network/localStorage/
// mutable singleton は一切使用しない。evaluatedAt は呼び出し側が注入する。
// store/selectors/UI/legacy stockCandidates/officialDecision/SAFE_MODE/
// TierA は一切 import しない。
// ═══════════════════════════════════════════════════════════

import type { CandidateFunnelCandidate } from '../../types/candidateFunnel'
import type { Holding, Trust } from '../../types/index'
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
  PORTFOLIO_FIT_MANUAL_CASH_STALE_THRESHOLD_MS,
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
      const ms = Date.parse(h.acquiredAt)
      if (!Number.isFinite(ms)) {
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

function computeSectorExposure(
  holdings: readonly Holding[],
  candidateSector: string,
): { value: number; degraded: boolean } {
  let value = 0
  let degraded = false
  for (const h of holdings) {
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

// ── §9/§12 Capacity (dataset-level, independent of per-record fit) ───
function computeCapacity(
  snapshot: PortfolioFitSnapshotInput | null,
  evaluatedAtMs: number,
  portfolioFreshness: PortfolioFitInputFreshness,
  portfolioFreshnessReasons: readonly CandidatePortfolioFitDatasetReason[],
  jpStockValidTotal: number,
): CandidatePortfolioCapacityAssessment {
  if (snapshot === null) {
    return { assetClass: 'JP_STOCK', status: 'unavailable', reasons: ['PORTFOLIO_SNAPSHOT_UNAVAILABLE'] }
  }
  if (snapshot.existence === 'invalid' || portfolioFreshness === 'invalid') {
    return { assetClass: 'JP_STOCK', status: 'unavailable', reasons: ['PORTFOLIO_SNAPSHOT_INVALID'] }
  }

  const policy = snapshot.portfolioPolicy
  const policyValid =
    policy != null &&
    Number.isFinite(policy.jpStockMaxRatio) &&
    policy.jpStockMaxRatio >= PORTFOLIO_FIT_POLICY_MIN_RATIO &&
    policy.jpStockMaxRatio <= PORTFOLIO_FIT_POLICY_MAX_RATIO
  if (!policyValid) {
    return { assetClass: 'JP_STOCK', status: 'unavailable', reasons: ['POLICY_AUTHORITY_UNAVAILABLE'] }
  }

  const { total: trustCurrentValue } = sumValidTrustValue(snapshot.trusts)

  const reasons: CandidatePortfolioFitDatasetReason[] = []
  let sourceUnknown = false
  if (portfolioFreshness === 'stale' || portfolioFreshness === 'partial') {
    sourceUnknown = true
    reasons.push(...portfolioFreshnessReasons)
  }

  const cash = snapshot.cashAssumptions
  let cashTotal = 0
  let cashUnknown = false
  if (cash == null || !cash.manualOverrideEnabled || cash.manualUpdatedAt == null) {
    cashUnknown = true
    reasons.push('CASH_AUTHORITY_UNAVAILABLE')
  } else {
    const updatedMs = Date.parse(cash.manualUpdatedAt)
    const ageMs = evaluatedAtMs - updatedMs
    const cashValuesValid =
      Number.isFinite(cash.cashDeposits) &&
      cash.cashDeposits >= 0 &&
      Number.isFinite(cash.standbyFunds) &&
      cash.standbyFunds >= 0
    if (!Number.isFinite(updatedMs) || ageMs < 0 || ageMs > PORTFOLIO_FIT_MANUAL_CASH_STALE_THRESHOLD_MS || !cashValuesValid) {
      cashUnknown = true
      reasons.push('CASH_AUTHORITY_STALE')
    } else {
      cashTotal = cash.cashDeposits + cash.standbyFunds
    }
  }

  if (sourceUnknown || cashUnknown) {
    return {
      assetClass: 'JP_STOCK',
      status: 'unknown',
      reasons: dedupeInOrder(reasons, CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS),
    }
  }

  const portfolioTotalValue = jpStockValidTotal + trustCurrentValue + cashTotal
  if (portfolioTotalValue <= 0) {
    return { assetClass: 'JP_STOCK', status: 'unknown', reasons: ['CAPACITY_UNAVAILABLE'] }
  }
  const jpStockCap = policy!.jpStockMaxRatio * portfolioTotalValue
  const rawHeadroom = jpStockCap - jpStockValidTotal
  const status: CandidatePortfolioCapacityStatus = rawHeadroom > 0 ? 'available' : 'constrained'
  return { assetClass: 'JP_STOCK', status, reasons: [] }
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
  aggregates: Map<string, PortfolioFitHoldingAggregate>
  holdings: readonly Holding[]
}): CandidatePortfolioFitComponent[] {
  const { candidate, normalizedCode, relationship, existence, jpStockValidTotal, aggregates, holdings } = params

  const sameCodeValue = relationship === 'already_held' ? 1 : relationship === 'new_to_portfolio' ? 0 : null
  const sameCodeStatus: CandidatePortfolioFitComponentStatus =
    relationship === 'holding_match_unknown' ? 'unavailable' : 'evaluated'
  const sameCodeReasons: CandidatePortfolioFitReason[] =
    relationship === 'already_held' ? ['ALREADY_HELD'] : relationship === 'new_to_portfolio' ? ['NEW_TO_PORTFOLIO'] : []
  const sameCodeRisks: CandidatePortfolioFitRisk[] =
    relationship === 'holding_match_unknown' ? ['HOLDING_MATCH_UNKNOWN'] : []

  let concentrationValue: number | null = null
  let concentrationStatus: CandidatePortfolioFitComponentStatus
  const concentrationReasons: CandidatePortfolioFitReason[] = []
  const concentrationRisks: CandidatePortfolioFitRisk[] = []
  if (existence === 'present_empty') {
    concentrationValue = 0
    concentrationStatus = 'evaluated'
    concentrationReasons.push('EXISTING_CODE_CONCENTRATION_MEASURED')
  } else if (jpStockValidTotal > 0 && normalizedCode !== null) {
    const agg = aggregates.get(normalizedCode)
    const positive = agg && agg.totalCurrentValue !== null && agg.totalCurrentValue > 0 ? agg.totalCurrentValue : 0
    concentrationValue = positive / jpStockValidTotal
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

function dedupeInOrder<T extends string>(items: readonly T[], declarationOrder: readonly T[]): T[] {
  const set = new Set<T>(items)
  return declarationOrder.filter((o) => set.has(o))
}

const STATUS_LEVEL: Record<CandidatePortfolioFitStatus, number> = {
  evaluated: 0,
  partial: 1,
  unavailable: 2,
  invalid: 3,
}
const LEVEL_STATUS: readonly CandidatePortfolioFitStatus[] = ['evaluated', 'partial', 'unavailable', 'invalid']

function buildResult(params: {
  status: CandidatePortfolioFitStatus
  records: CandidatePortfolioFitRecord[]
  candidateGeneratedAt: string | null
  portfolioSourceAsOf: string | null
  portfolioFreshness: PortfolioFitInputFreshness
  capacity: CandidatePortfolioCapacityAssessment
  evaluatedAt: string
  degradationReasons: CandidatePortfolioFitDatasetReason[]
  inputTargetCount: number
}): CandidatePortfolioFitResult {
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
    status: params.status,
    capacity: params.capacity,
    records: params.records,
    degradationReasons: params.degradationReasons,
    qualityGate: {
      inputTargetCount: params.inputTargetCount,
      outputRecordCount: params.records.length,
      hardFailIds: [],
      warningIds: [],
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

  if (!evaluatedAtValid) {
    return buildResult({
      status: 'invalid',
      records: [],
      candidateGeneratedAt: null,
      portfolioSourceAsOf: null,
      portfolioFreshness: 'invalid',
      capacity: { assetClass: 'JP_STOCK', status: 'unavailable', reasons: [] },
      evaluatedAt,
      degradationReasons: [],
      inputTargetCount: 0,
    })
  }

  const candidateAssessment = assessCandidateFreshness(candidateSource, evaluatedAtMs)
  const portfolioAssessment = assessPortfolioFreshness(portfolioSnapshot, evaluatedAtMs)

  const holdingAgg: HoldingAggregationResult =
    portfolioSnapshot && portfolioSnapshot.existence !== 'invalid'
      ? aggregateHoldings(portfolioSnapshot.holdings)
      : { aggregates: new Map(), hasInvalidCode: false, hasDuplicateCode: false, jpStockValidTotal: 0, hasPartialValue: false }

  const capacity = computeCapacity(
    portfolioSnapshot,
    evaluatedAtMs,
    portfolioAssessment.freshness,
    portfolioAssessment.reasons,
    holdingAgg.jpStockValidTotal,
  )

  if (candidateAssessment.reason) addReason(candidateAssessment.reason)
  portfolioAssessment.reasons.forEach(addReason)
  capacity.reasons.forEach(addReason)
  if (holdingAgg.hasInvalidCode) addReason('HOLDING_CODE_INVALID')
  if (holdingAgg.hasPartialValue) addReason('HOLDING_VALUE_PARTIAL')
  if (holdingAgg.hasDuplicateCode) addReason('DUPLICATE_HOLDING_CODE')

  if (candidateAssessment.effective === 'invalid') {
    return buildResult({
      status: 'invalid',
      records: [],
      candidateGeneratedAt: null,
      portfolioSourceAsOf: portfolioAssessment.sourceAsOf,
      portfolioFreshness: portfolioAssessment.freshness,
      capacity,
      evaluatedAt,
      degradationReasons: dedupeInOrder([...degradationReasonsSet], CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS),
      inputTargetCount: 0,
    })
  }
  if (candidateAssessment.effective === 'unavailable') {
    return buildResult({
      status: 'unavailable',
      records: [],
      candidateGeneratedAt: null,
      portfolioSourceAsOf: portfolioAssessment.sourceAsOf,
      portfolioFreshness: portfolioAssessment.freshness,
      capacity,
      evaluatedAt,
      degradationReasons: dedupeInOrder([...degradationReasonsSet], CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS),
      inputTargetCount: 0,
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
      const forcedStatus: CandidatePortfolioFitStatus = candidateForcedUnavailable
        ? 'unavailable'
        : portfolioAssessment.freshness === 'invalid'
          ? 'invalid'
          : 'unavailable'
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
      aggregates: holdingAgg.aggregates,
      holdings: snapshot.holdings,
    })

    const evaluatedCount = components.filter((c) => c.status === 'evaluated').length
    const componentCoveragePartial = evaluatedCount === 0

    const recordLevel = Math.max(...components.map((c) => componentLevel(c.status)))
    const finalLevel = Math.max(recordLevel, datasetFloorLevel)
    const portfolioFitStatus = LEVEL_STATUS[finalLevel]

    const fitReasons = dedupeInOrder(components.flatMap((c) => c.reasons), CANDIDATE_PORTFOLIO_FIT_REASONS)
    const fitRisksRaw: CandidatePortfolioFitRisk[] = components.flatMap((c) => c.risks)
    if (componentCoveragePartial) fitRisksRaw.push('COMPONENT_COVERAGE_PARTIAL')
    const fitRisks = dedupeInOrder(fitRisksRaw, CANDIDATE_PORTFOLIO_FIT_RISKS)

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
      fitReasons,
      fitRisks,
    }
  })

  const recordWorstLevel = records.length > 0 ? Math.max(...records.map((r) => STATUS_LEVEL[r.portfolioFitStatus])) : 0
  const overallLevel = Math.max(recordWorstLevel, datasetFloorLevel)
  const status = LEVEL_STATUS[overallLevel]

  return buildResult({
    status,
    records,
    candidateGeneratedAt,
    portfolioSourceAsOf: portfolioAssessment.sourceAsOf,
    portfolioFreshness: portfolioAssessment.freshness,
    capacity,
    evaluatedAt,
    degradationReasons: dedupeInOrder([...degradationReasonsSet], CANDIDATE_PORTFOLIO_FIT_DATASET_REASONS),
    inputTargetCount: targets.length,
  })
}
