import {
  DEFAULT_CASH_ASSUMPTIONS,
  DEFAULT_PORTFOLIO_POLICY,
  type Holding,
  type Trust,
  type LearningState,
  type PortfolioPolicy,
  type CashAssumptions,
  type CsvImportProvenance,
  type CsvSyncSummary,
} from '../types'
import { sanitizeLearningState } from '../domain/learning/performanceTracker'
import type { TrustShortPortfolioSnapshot } from '../domain/learning/trustShortTracker'
import { isStrictTimestamp, parseStrictTimestamp } from '../utils/strictTimestamp'
import { isCsvImportProvenance } from '../domain/csv/csvProvenance'
import {
  computeCanonicalPortfolioGenerationIdentity,
  computeCanonicalPortfolioGenerationIdentityV2,
  isSnapshotGenerationIdentity,
} from '../utils/snapshotGenerationIdentity'

const PORTFOLIO_KEY = 'v81_portfolio'
const TRUST_KEY = 'v81_trust'
const LEARNING_KEY = 'v91_learning'
const CSV_IMPORTED_AT_KEY = 'v10_csv_imported_at'  // Phase 8: CSV取込時刻永続化
const TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7日
const LEARNING_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const CSV_IMPORT_GENERATION_KEY = 'v13_csv_import_committed_generation'
const CSV_IMPORT_GENERATION_SCHEMA_V1 = 'csv-import-generation-1' as const
const CSV_IMPORT_GENERATION_SCHEMA_V2 = 'csv-import-generation-2' as const
const CSV_IMPORT_GENERATION_SCHEMA_V3 = 'csv-import-generation-3' as const
export const CSV_IMPORT_GENERATION_SCHEMA_V4 = 'csv-import-generation-4' as const
/** Backward-compatible default writer schema name. */
export const CSV_IMPORT_GENERATION_SCHEMA = CSV_IMPORT_GENERATION_SCHEMA_V4
export const CSV_IMPORT_GENERATION_SCHEMA_V5 = 'csv-import-generation-5' as const

export type CsvImportCanonicalWriteContract =
  | { schemaVersion: typeof CSV_IMPORT_GENERATION_SCHEMA }
  | { schemaVersion: typeof CSV_IMPORT_GENERATION_SCHEMA_V5 }

export type PortfolioGenerationOrigin = 'csv' | 'snapshot' | null

interface Snapshot<T> {
  data: T
  savedAt: number
}

export interface CsvImportPersistencePayload {
  holdings: Holding[]
  trust: Trust[]
  learning: LearningState | null
  /** Legacy v1-v3 field. New v4 envelopes never persist this key. */
  importedAt?: string
  /** Durable CSV source/import time. Null is preserved for snapshots without CSV metadata. */
  csvImportedAt?: string | null
  syncSummary: CsvSyncSummary | null
  trustShortSnapshot: TrustShortPortfolioSnapshot
  /** Absent only on legacy v1 callers/envelopes; every v2/v3 envelope contains this key. */
  provenance?: CsvImportProvenance | null
  /** Absent only on legacy v1/v2 callers/envelopes; every new v3 envelope contains these keys. */
  portfolioPolicy?: PortfolioPolicy
  cashAssumptions?: CashAssumptions
  origin?: PortfolioGenerationOrigin
  /** Complete durable canonical identity; absent only in legacy v1-v3 envelopes/callers. */
  snapshotGenerationIdentity?: string | null
  /** Incoming/export transfer identity used for pre-analysis duplicate classification. */
  snapshotTransferIdentity?: string | null
}

export interface CsvImportPersistenceReceipt {
  previousRaw: string | null
  committedRaw: string
}

interface CsvImportGenerationManifest {
  schemaVersion:
    | typeof CSV_IMPORT_GENERATION_SCHEMA_V5
    | typeof CSV_IMPORT_GENERATION_SCHEMA
    | typeof CSV_IMPORT_GENERATION_SCHEMA_V3
    | typeof CSV_IMPORT_GENERATION_SCHEMA_V2
    | typeof CSV_IMPORT_GENERATION_SCHEMA_V1
  generationId: string
  savedAt: number
  committed: true
  payloadChecksum: string
}

interface CsvImportGenerationEnvelope {
  manifest: CsvImportGenerationManifest
  payload: CsvImportPersistencePayload
}

export type CsvImportGenerationRestoreResult =
  | {
      status: 'committed'
      schemaVersion: CsvImportGenerationManifest['schemaVersion']
      generationId: string
      savedAt: number
      payload: CsvImportPersistencePayload
    }
  | { status: 'none' | 'invalid' }

export class CsvImportPersistenceError extends Error {
  readonly status: 'not_attempted' | 'rolled_back' | 'rollback_failed' | 'indeterminate'

  constructor(message: string, status: 'not_attempted' | 'rolled_back' | 'rollback_failed' | 'indeterminate') {
    super(message)
    this.name = 'CsvImportPersistenceError'
    this.status = status
  }
}

export class CsvImportPersistenceIndeterminateError extends CsvImportPersistenceError {
  constructor() {
    super('保存結果を確認できません。再読み込みして状態を確認してください。', 'indeterminate')
    this.name = 'CsvImportPersistenceIndeterminateError'
  }
}

export class CsvImportCanonicalConflictError extends CsvImportPersistenceError {
  constructor(message: string) {
    super(message, 'not_attempted')
    this.name = 'CsvImportCanonicalConflictError'
  }
}

// P4.5-A012d: localStorage保存データの鮮度（表示専用）。
// TTLを超えても値そのものは削除しないため、「保存されているか／古いか」を
// UI側でstale警告に使うための読み取り専用ヘルパー。
export interface StorageFreshness {
  exists: boolean
  isStale: boolean
  savedAt: number | null
  ageDays: number | null
}

const NOT_SAVED_FRESHNESS: StorageFreshness = { exists: false, isStale: false, savedAt: null, ageDays: null }

let generationSequence = 0

function checksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => allowed.has(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isNonNegativeNumber(value)
}

function isTimestamp(value: unknown, allowDateOnly = true): value is string {
  return isStrictTimestamp(value, { allowDateOnly })
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isHolding(value: unknown): value is Holding {
  if (!isRecord(value) || !hasExactKeys(value, [
    'code', 'name', 'eval', 'pnlPct', 'mu', 'sigma', 'sigmaSource', 'beta', 'sector',
    'target', 'alert', 'lock', 'mitsu', 'ma', 'rsi', 'macd', 'vol', 'mom3m', 'roe',
    'per', 'pbr', 'epsG', 'cfOk', 'de', 'divG', 'score', 'decision', 'ev',
  ], ['currentPrice', 'acquiredAt'])) return false

  const finiteFields = [
    'eval', 'pnlPct', 'mu', 'sigma', 'beta', 'target', 'alert', 'rsi', 'mom3m',
    'roe', 'per', 'pbr', 'epsG', 'de', 'divG', 'score', 'ev',
  ] as const
  const booleanFields = ['lock', 'mitsu', 'ma', 'macd', 'vol', 'cfOk'] as const
  return isNonEmptyString(value.code) && isNonEmptyString(value.name) &&
    isNonEmptyString(value.sector) && finiteFields.every(field => isFiniteNumber(value[field])) &&
    isNonNegativeNumber(value.eval) && isNonNegativeNumber(value.sigma) &&
    booleanFields.every(field => typeof value[field] === 'boolean') &&
    (value.sigmaSource === 'yfinance' || value.sigmaSource === 'static') &&
    (value.decision === 'BUY' || value.decision === 'HOLD' || value.decision === 'SELL') &&
    (value.currentPrice === undefined || isFiniteNumber(value.currentPrice)) &&
    (value.acquiredAt === undefined || isTimestamp(value.acquiredAt))
}

function isTrust(value: unknown): value is Trust {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'name', 'abbr', 'account', 'policy', 'eval', 'pnlPct', 'dayPct', 'cost',
    'mu', 'sigma', 'score', 'signal', 'ev', 'decision',
  ], ['notForTrading'])) return false
  const finiteFields = ['eval', 'pnlPct', 'dayPct', 'cost', 'mu', 'sigma', 'score', 'ev'] as const
  return isNonEmptyString(value.id) && isNonEmptyString(value.name) &&
    isNonEmptyString(value.abbr) && isNonEmptyString(value.account) && isNonEmptyString(value.signal) &&
    finiteFields.every(field => isFiniteNumber(value[field])) && isNonNegativeNumber(value.eval) &&
    isNonNegativeNumber(value.cost) && isNonNegativeNumber(value.sigma) &&
    (value.policy === 'JAPAN_SHORTTERM' || value.policy === 'OVERSEAS_LONGTERM' || value.policy === 'GOLD') &&
    (value.decision === 'BUY' || value.decision === 'HOLD' || value.decision === 'WAIT' || value.decision === 'SELL') &&
    (value.notForTrading === undefined || typeof value.notForTrading === 'boolean')
}

function isDecisionSummary(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['count', 'wins', 'losses', 'flats', 'accuracy', 'avgReward'])) return false
  return isNonNegativeInteger(value.count) && isNonNegativeInteger(value.wins) &&
    isNonNegativeInteger(value.losses) && isNonNegativeInteger(value.flats) &&
    isFiniteNumber(value.accuracy) && isFiniteNumber(value.avgReward)
}

function isLearningBaseline(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value,
    ['code', 'predictedAt', 'decision', 'score', 'confidence', 'pnlPct'], ['regime'])) return false
  return isNonEmptyString(value.code) && isTimestamp(value.predictedAt, false) &&
    (value.decision === 'BUY' || value.decision === 'HOLD' || value.decision === 'SELL') &&
    isFiniteNumber(value.score) && isFiniteNumber(value.confidence) && isFiniteNumber(value.pnlPct) &&
    (value.regime === undefined || value.regime === 'bull' || value.regime === 'neutral' || value.regime === 'bear')
}

function isLearningOutcome(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'code', 'predictedAt', 'evaluatedAt', 'decision', 'score', 'confidence', 'prevPnlPct',
    'currPnlPct', 'deltaPnlPct', 'reward', 'result',
  ], ['regime'])) return false
  return isNonEmptyString(value.code) && isTimestamp(value.predictedAt, false) && isTimestamp(value.evaluatedAt, false) &&
    (value.decision === 'BUY' || value.decision === 'HOLD' || value.decision === 'SELL') &&
    ['score', 'confidence', 'prevPnlPct', 'currPnlPct', 'deltaPnlPct', 'reward']
      .every(field => isFiniteNumber(value[field])) &&
    (value.result === 'win' || value.result === 'loss' || value.result === 'flat') &&
    (value.regime === undefined || value.regime === 'bull' || value.regime === 'neutral' || value.regime === 'bear')
}

function isLearningState(value: unknown): value is LearningState {
  if (!isRecord(value) || !hasExactKeys(value,
    ['lastUpdated', 'baselineCount', 'baseline', 'outcomes', 'summary', 'suggestedWeights'])) return false
  if (!isTimestamp(value.lastUpdated, false) || !isNonNegativeInteger(value.baselineCount) ||
      !Array.isArray(value.baseline) || !value.baseline.every(isLearningBaseline) ||
      !Array.isArray(value.outcomes) || !value.outcomes.every(isLearningOutcome)) return false
  const summary = value.summary
  const weights = value.suggestedWeights
  if (!isRecord(summary) || !hasExactKeys(summary,
    ['total', 'wins', 'losses', 'flats', 'accuracy', 'avgReward', 'byDecision', 'driftSignals']) ||
      !isNonNegativeInteger(summary.total) || !isNonNegativeInteger(summary.wins) ||
      !isNonNegativeInteger(summary.losses) || !isNonNegativeInteger(summary.flats) ||
      !isFiniteNumber(summary.accuracy) || !isFiniteNumber(summary.avgReward) ||
      !isStringArray(summary.driftSignals)) return false
  if (!isRecord(summary.byDecision) || !hasExactKeys(summary.byDecision, ['BUY', 'HOLD', 'SELL']) ||
      !isDecisionSummary(summary.byDecision.BUY) || !isDecisionSummary(summary.byDecision.HOLD) ||
      !isDecisionSummary(summary.byDecision.SELL)) return false
  return isRecord(weights) && hasExactKeys(weights,
    ['fundamental', 'market', 'technical', 'news', 'quality', 'risk']) &&
    ['fundamental', 'market', 'technical', 'news', 'quality', 'risk']
      .every(field => isFiniteNumber(weights[field]))
}

function isCsvSyncSummary(value: unknown): value is CsvSyncSummary {
  if (!isRecord(value) || !hasExactKeys(value, ['importedAt', 'stock', 'trust']) ||
      !isTimestamp(value.importedAt, false) || !isRecord(value.stock) || !isRecord(value.trust)) return false
  const stock = value.stock
  const trust = value.trust
  if (!hasExactKeys(stock, ['updated', 'added', 'removed']) ||
      !['updated', 'added', 'removed'].every(field => isNonNegativeInteger(stock[field]))) return false
  if (!hasExactKeys(trust,
    ['updated', 'reheld', 'zeroed', 'unknownFunds', 'ambiguousFundIds']) ||
      !['updated', 'reheld', 'zeroed'].every(field => isNonNegativeInteger(trust[field])) ||
      !Array.isArray(trust.unknownFunds) || !isStringArray(trust.ambiguousFundIds)) return false
  return trust.unknownFunds.every(item => isRecord(item) && hasExactKeys(item, ['name', 'eval']) &&
    isNonEmptyString(item.name) && isNonNegativeNumber(item.eval))
}

function isTrustShortSnapshot(
  value: unknown,
  requireDateOnly = false,
): value is TrustShortPortfolioSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ['date', 'total', 'evalById']) ||
      (requireDateOnly
        ? parseStrictTimestamp(value.date, { allowDateOnly: true })?.kind !== 'date-only'
        : !isTimestamp(value.date)) ||
      !isNonNegativeNumber(value.total) || !isRecord(value.evalById)) return false
  return Object.values(value.evalById).every(isNonNegativeNumber)
}

function isPortfolioPolicy(value: unknown): value is PortfolioPolicy {
  return isRecord(value) && hasExactKeys(value, ['jpStockMaxRatio']) &&
    isFiniteNumber(value.jpStockMaxRatio) &&
    value.jpStockMaxRatio >= 0.05 && value.jpStockMaxRatio <= 0.30
}

function isCashAssumptions(value: unknown): value is CashAssumptions {
  return isRecord(value) && hasExactKeys(value, [
    'cashDeposits', 'standbyFunds', 'manualOverrideEnabled', 'manualUpdatedAt',
  ]) &&
    isNonNegativeNumber(value.cashDeposits) &&
    isNonNegativeNumber(value.standbyFunds) &&
    typeof value.manualOverrideEnabled === 'boolean' &&
    (value.manualUpdatedAt === null || isTimestamp(value.manualUpdatedAt, false))
}

function isCsvImportPayload(value: unknown, schemaVersion: string): value is CsvImportPersistencePayload {
  const isV1 = schemaVersion === CSV_IMPORT_GENERATION_SCHEMA_V1
  const isV2 = schemaVersion === CSV_IMPORT_GENERATION_SCHEMA_V2
  const isV3 = schemaVersion === CSV_IMPORT_GENERATION_SCHEMA_V3
  const isV4 = schemaVersion === CSV_IMPORT_GENERATION_SCHEMA
  const isV5 = schemaVersion === CSV_IMPORT_GENERATION_SCHEMA_V5
  if (!isV1 && !isV2 && !isV3 && !isV4 && !isV5) return false
  const baseKeys = ['holdings', 'trust', 'learning', 'importedAt', 'syncSummary', 'trustShortSnapshot'] as const
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, isV4 || isV5
    ? [
        'holdings', 'trust', 'learning', 'csvImportedAt', 'provenance', 'syncSummary',
        'trustShortSnapshot', 'portfolioPolicy', 'cashAssumptions', 'origin',
        'snapshotGenerationIdentity', 'snapshotTransferIdentity',
      ]
    : isV1
      ? baseKeys
      : isV2
        ? [...baseKeys, 'provenance']
        : [...baseKeys, 'provenance', 'portfolioPolicy', 'cashAssumptions', 'origin'])) return false

  const commonValid = Array.isArray(value.holdings) && value.holdings.every(isHolding) &&
    Array.isArray(value.trust) && value.trust.every(isTrust) &&
    (value.learning === null || isLearningState(value.learning)) &&
    isTrustShortSnapshot(value.trustShortSnapshot, isV5)
  if (!commonValid) return false

  if (!isV4 && !isV5) {
    return isTimestamp(value.importedAt, false) && isCsvSyncSummary(value.syncSummary) &&
      (isV1 || value.provenance === null ||
        (isCsvImportProvenance(value.provenance) && value.provenance.importedAt === value.importedAt)) &&
      (!isV3 || (
        isPortfolioPolicy(value.portfolioPolicy) &&
        isCashAssumptions(value.cashAssumptions) &&
        (value.origin === 'csv' || value.origin === 'snapshot')
      ))
  }

  const csvImportedAt = value.csvImportedAt
  const provenance = value.provenance
  const syncSummary = value.syncSummary
  const origin = value.origin
  if ((csvImportedAt !== null && !isTimestamp(csvImportedAt, false)) ||
      (provenance !== null && !isCsvImportProvenance(provenance)) ||
      (syncSummary !== null && !isCsvSyncSummary(syncSummary)) ||
      !isPortfolioPolicy(value.portfolioPolicy) ||
      !isCashAssumptions(value.cashAssumptions) ||
      (origin !== 'csv' && origin !== 'snapshot' && origin !== null) ||
      !isSnapshotGenerationIdentity(value.snapshotGenerationIdentity) ||
      (value.snapshotTransferIdentity !== null &&
        !isSnapshotGenerationIdentity(value.snapshotTransferIdentity))) return false

  if (provenance !== null && provenance.importedAt !== csvImportedAt) return false
  if (syncSummary !== null &&
      (csvImportedAt === null || syncSummary.importedAt !== csvImportedAt)) return false
  if (origin === 'csv' && (csvImportedAt === null || syncSummary === null)) return false
  // The current snapshot transfer schema has no summary field. Never bless an ambient store
  // summary as part of the incoming snapshot generation.
  if (origin === 'snapshot' && syncSummary !== null) return false
  const canonicalOrigin: PortfolioGenerationOrigin = origin === 'csv'
    ? 'csv'
    : origin === 'snapshot'
      ? 'snapshot'
      : null
  const identityInput = {
    holdings: value.holdings as Holding[],
    trust: value.trust as Trust[],
    learning: value.learning as LearningState | null,
    portfolioPolicy: value.portfolioPolicy,
    cashAssumptions: value.cashAssumptions,
    csvImportedAt,
    csvImportProvenance: provenance,
    syncSummary,
    trustShortSnapshot: value.trustShortSnapshot as TrustShortPortfolioSnapshot,
    origin: canonicalOrigin,
    snapshotTransferIdentity: value.snapshotTransferIdentity,
  }
  const expectedIdentity = isV5
    ? computeCanonicalPortfolioGenerationIdentityV2(identityInput)
    : computeCanonicalPortfolioGenerationIdentity(identityInput)
  if (value.snapshotGenerationIdentity !== expectedIdentity) return false
  return true
}

/**
 * Canonical CSV generation reader. A present but malformed envelope is invalid and must not
 * fall back to possibly partial legacy keys. Legacy fallback is allowed only when no envelope
 * exists, which preserves backward compatibility without blessing a damaged generation.
 */
export function restoreCsvImportGeneration(): CsvImportGenerationRestoreResult {
  if (typeof localStorage === 'undefined') return { status: 'invalid' }
  try {
    const raw = localStorage.getItem(CSV_IMPORT_GENERATION_KEY)
    return restoreCsvImportGenerationFromRaw(raw)
  } catch {
    return { status: 'invalid' }
  }
}

/** Parse the exact canonical bytes captured by a transaction, without a second storage read. */
export function restoreCsvImportGenerationFromRaw(raw: string | null): CsvImportGenerationRestoreResult {
  try {
    if (raw === null) return { status: 'none' }
    const envelope = JSON.parse(raw) as unknown
    if (!isRecord(envelope) || !hasExactKeys(envelope, ['manifest', 'payload']) || !isRecord(envelope.manifest)) {
      return { status: 'invalid' }
    }
    const manifest = envelope.manifest
    if (
      !hasExactKeys(manifest, ['schemaVersion', 'generationId', 'savedAt', 'committed', 'payloadChecksum']) ||
      (manifest.schemaVersion !== CSV_IMPORT_GENERATION_SCHEMA_V5 &&
        manifest.schemaVersion !== CSV_IMPORT_GENERATION_SCHEMA &&
        manifest.schemaVersion !== CSV_IMPORT_GENERATION_SCHEMA_V3 &&
        manifest.schemaVersion !== CSV_IMPORT_GENERATION_SCHEMA_V2 &&
        manifest.schemaVersion !== CSV_IMPORT_GENERATION_SCHEMA_V1) ||
      typeof manifest.generationId !== 'string' || manifest.generationId.length === 0 ||
      typeof manifest.savedAt !== 'number' || !Number.isFinite(manifest.savedAt) ||
      manifest.committed !== true ||
      typeof manifest.payloadChecksum !== 'string' ||
      !isCsvImportPayload(envelope.payload, manifest.schemaVersion as string)
    ) return { status: 'invalid' }
    const serializedPayload = JSON.stringify(envelope.payload)
    if (checksum(serializedPayload) !== manifest.payloadChecksum) return { status: 'invalid' }
    return {
      status: 'committed',
      schemaVersion: manifest.schemaVersion,
      generationId: manifest.generationId,
      savedAt: manifest.savedAt,
      payload: envelope.payload,
    }
  } catch { return { status: 'invalid' } }
}

function readStorageFreshness(key: string, ttlMs: number, nowMs = Date.now()): StorageFreshness {
  try {
    if (key === PORTFOLIO_KEY || key === TRUST_KEY) {
      const generation = restoreCsvImportGeneration()
      if (generation.status === 'committed') {
        const ageMs = nowMs - generation.savedAt
        return {
          exists: true,
          isStale: ageMs > ttlMs,
          savedAt: generation.savedAt,
          ageDays: ageMs / (24 * 60 * 60 * 1000),
        }
      }
      if (generation.status === 'invalid') return NOT_SAVED_FRESHNESS
    }
    const raw = localStorage.getItem(key)
    if (!raw) return NOT_SAVED_FRESHNESS
    const snap = JSON.parse(raw) as Snapshot<unknown>
    if (typeof snap?.savedAt !== 'number') return NOT_SAVED_FRESHNESS
    const ageMs = nowMs - snap.savedAt
    return {
      exists: true,
      isStale: ageMs > ttlMs,
      savedAt: snap.savedAt,
      ageDays: ageMs / (24 * 60 * 60 * 1000),
    }
  } catch { return NOT_SAVED_FRESHNESS }
}

export type LegacyPersistenceResult =
  | { status: 'persisted' }
  | { status: 'blocked'; reason: 'canonical_committed' | 'canonical_invalid' }
  | { status: 'failed' }

export interface LegacyPortfolioGenerationTransactionInput {
  holdings?: Holding[]
  trust?: Trust[]
  learning?: LearningState
  portfolioPolicy?: PortfolioPolicy
  cashAssumptions?: CashAssumptions
}

export type LegacyPortfolioGenerationTransactionResult =
  | { status: 'persisted' }
  | {
      status: 'blocked'
      reason: 'canonical_committed' | 'canonical_invalid' | 'canonical_changed'
    }
  | {
      status: 'failed'
      reason: 'rolled_back' | 'rollback_failed' | 'ownership_lost' | 'indeterminate'
    }

interface LegacyTransactionTarget {
  key: string
  previousRaw: string | null
  intendedRaw: string
}

function readExactStorageBytes(key: string): { ok: true; raw: string | null } | { ok: false } {
  try {
    return { ok: true, raw: localStorage.getItem(key) }
  } catch {
    return { ok: false }
  }
}

/**
 * Persist one explicitly selected legacy portfolio generation with exact-byte ownership.
 * All reads and serialization complete before the first write; a failed write rolls owned
 * targets back in reverse order without touching bytes installed by another writer.
 */
export function persistLegacyPortfolioGenerationTransaction(
  input: LegacyPortfolioGenerationTransactionInput,
  nowMs = Date.now(),
): LegacyPortfolioGenerationTransactionResult {
  if (typeof localStorage === 'undefined' || !Number.isFinite(nowMs)) {
    return { status: 'failed', reason: 'indeterminate' }
  }

  const canonicalCapture = readExactStorageBytes(CSV_IMPORT_GENERATION_KEY)
  if (!canonicalCapture.ok) return { status: 'failed', reason: 'indeterminate' }
  const canonical = restoreCsvImportGenerationFromRaw(canonicalCapture.raw)
  if (canonical.status === 'committed') {
    return { status: 'blocked', reason: 'canonical_committed' }
  }
  if (canonical.status === 'invalid') {
    return { status: 'blocked', reason: 'canonical_invalid' }
  }

  const definitions: Array<[string, unknown] | null> = [
    Object.prototype.hasOwnProperty.call(input, 'holdings')
      ? [PORTFOLIO_KEY, { data: input.holdings, savedAt: nowMs } satisfies Snapshot<Holding[] | undefined>]
      : null,
    Object.prototype.hasOwnProperty.call(input, 'trust')
      ? [TRUST_KEY, { data: input.trust, savedAt: nowMs } satisfies Snapshot<Trust[] | undefined>]
      : null,
    Object.prototype.hasOwnProperty.call(input, 'learning')
      ? [LEARNING_KEY, { data: input.learning, savedAt: nowMs } satisfies Snapshot<LearningState | undefined>]
      : null,
    Object.prototype.hasOwnProperty.call(input, 'portfolioPolicy')
      ? [PORTFOLIO_POLICY_KEY, { data: input.portfolioPolicy, savedAt: nowMs } satisfies Snapshot<PortfolioPolicy | undefined>]
      : null,
    Object.prototype.hasOwnProperty.call(input, 'cashAssumptions')
      ? [CASH_ASSUMPTIONS_KEY, { data: input.cashAssumptions, savedAt: nowMs } satisfies Snapshot<CashAssumptions | undefined>]
      : null,
  ]

  const capturedTargets: Array<{
    key: string
    previousRaw: string | null
    value: unknown
  }> = []
  for (const definition of definitions) {
    if (definition === null) continue
    const [key, value] = definition
    const previous = readExactStorageBytes(key)
    if (!previous.ok) return { status: 'failed', reason: 'indeterminate' }
    capturedTargets.push({ key, previousRaw: previous.raw, value })
  }

  const targets: LegacyTransactionTarget[] = []
  try {
    for (const target of capturedTargets) {
      targets.push({
        key: target.key,
        previousRaw: target.previousRaw,
        intendedRaw: JSON.stringify(target.value),
      })
    }
  } catch {
    return { status: 'failed', reason: 'indeterminate' }
  }

  const owned: LegacyTransactionTarget[] = []
  let primaryResult: LegacyPortfolioGenerationTransactionResult | null = null

  for (const target of targets) {
    const canonicalBeforeWrite = readExactStorageBytes(CSV_IMPORT_GENERATION_KEY)
    if (!canonicalBeforeWrite.ok) {
      primaryResult = { status: 'failed', reason: 'indeterminate' }
      break
    }
    if (canonicalBeforeWrite.raw !== canonicalCapture.raw) {
      primaryResult = { status: 'blocked', reason: 'canonical_changed' }
      break
    }

    let writeThrew = false
    try {
      localStorage.setItem(target.key, target.intendedRaw)
    } catch {
      writeThrew = true
    }

    const physical = readExactStorageBytes(target.key)
    if (!physical.ok) {
      primaryResult = { status: 'failed', reason: 'indeterminate' }
      break
    }
    if (physical.raw === target.intendedRaw) {
      owned.push(target)
      if (writeThrew) {
        primaryResult = { status: 'failed', reason: 'rolled_back' }
        break
      }
    } else if (physical.raw === target.previousRaw) {
      primaryResult = { status: 'failed', reason: 'rolled_back' }
      break
    } else {
      primaryResult = { status: 'failed', reason: 'ownership_lost' }
      break
    }

    const canonicalAfterWrite = readExactStorageBytes(CSV_IMPORT_GENERATION_KEY)
    if (!canonicalAfterWrite.ok) {
      primaryResult = { status: 'failed', reason: 'indeterminate' }
      break
    }
    if (canonicalAfterWrite.raw !== canonicalCapture.raw) {
      primaryResult = { status: 'blocked', reason: 'canonical_changed' }
      break
    }
  }

  if (primaryResult === null) {
    const canonicalAtCommit = readExactStorageBytes(CSV_IMPORT_GENERATION_KEY)
    if (!canonicalAtCommit.ok) primaryResult = { status: 'failed', reason: 'indeterminate' }
    else if (canonicalAtCommit.raw !== canonicalCapture.raw) {
      primaryResult = { status: 'blocked', reason: 'canonical_changed' }
    } else {
      return { status: 'persisted' }
    }
  }

  let rollbackFailure = false
  let ownershipLost = primaryResult.status === 'failed' && primaryResult.reason === 'ownership_lost'
  let indeterminate = primaryResult.status === 'failed' && primaryResult.reason === 'indeterminate'

  for (let index = owned.length - 1; index >= 0; index -= 1) {
    const target = owned[index]
    const current = readExactStorageBytes(target.key)
    if (!current.ok) {
      indeterminate = true
      continue
    }
    if (current.raw !== target.intendedRaw) {
      if (current.raw !== target.previousRaw) ownershipLost = true
      continue
    }
    try {
      if (target.previousRaw === null) localStorage.removeItem(target.key)
      else localStorage.setItem(target.key, target.previousRaw)
    } catch {
      // Re-read physical bytes below; write-then-throw may still have restored the target.
    }
    const restored = readExactStorageBytes(target.key)
    if (!restored.ok) indeterminate = true
    else if (restored.raw !== target.previousRaw) rollbackFailure = true
  }

  for (const target of targets) {
    const restored = readExactStorageBytes(target.key)
    if (!restored.ok) indeterminate = true
    else if (restored.raw !== target.previousRaw && restored.raw !== target.intendedRaw) ownershipLost = true
    else if (restored.raw === target.intendedRaw && target.intendedRaw !== target.previousRaw) rollbackFailure = true
  }

  const canonicalAfterRollback = readExactStorageBytes(CSV_IMPORT_GENERATION_KEY)
  if (!canonicalAfterRollback.ok) indeterminate = true
  const canonicalChanged = canonicalAfterRollback.ok &&
    canonicalAfterRollback.raw !== canonicalCapture.raw

  if (indeterminate) return { status: 'failed', reason: 'indeterminate' }
  if (ownershipLost) return { status: 'failed', reason: 'ownership_lost' }
  if (rollbackFailure) return { status: 'failed', reason: 'rollback_failed' }
  if (canonicalChanged) return { status: 'blocked', reason: 'canonical_changed' }
  return primaryResult.status === 'blocked'
    ? primaryResult
    : { status: 'failed', reason: 'rolled_back' }
}

function persistLegacyValue(key: string, value: string): LegacyPersistenceResult {
  const canonical = restoreCsvImportGeneration()
  if (canonical.status === 'committed') return { status: 'blocked', reason: 'canonical_committed' }
  if (canonical.status === 'invalid') return { status: 'blocked', reason: 'canonical_invalid' }
  try {
    localStorage.setItem(key, value)
    return { status: 'persisted' }
  } catch {
    return { status: 'failed' }
  }
}

export function persistPortfolio(holdings: Holding[]): LegacyPersistenceResult {
  const snap: Snapshot<Holding[]> = { data: holdings, savedAt: Date.now() }
  return persistLegacyValue(PORTFOLIO_KEY, JSON.stringify(snap))
}

// P4.5-A012d: TTL失効による無警告revertを廃止する（P4.5-A008のcashAssumptionsと同じ
// 思想）。CSVで取り込んだ保有株の実額が、7日経過しただけで黙って初期値（constants
// fallback）へ戻ってしまうと、資産配分・headroom等の判断が気づかれずに変わって
// しまうため。鮮度はgetPortfolioStorageFreshness()で表示専用に扱う。
export function restorePortfolio(): Holding[] | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') return generation.payload.holdings
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(PORTFOLIO_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<Holding[]>
    return snap.data
  } catch { return null }
}

export function getPortfolioStorageFreshness(nowMs = Date.now()): StorageFreshness {
  return readStorageFreshness(PORTFOLIO_KEY, TTL_MS, nowMs)
}

export function persistTrust(trust: Trust[]): LegacyPersistenceResult {
  const snap: Snapshot<Trust[]> = { data: trust, savedAt: Date.now() }
  return persistLegacyValue(TRUST_KEY, JSON.stringify(snap))
}

// P4.5-A012d: restorePortfolioと同じ理由でTTL失効による無警告revertを廃止する。
export function restoreTrust(): Trust[] | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') return generation.payload.trust
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(TRUST_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<Trust[]>
    return snap.data
  } catch { return null }
}

export function getTrustStorageFreshness(nowMs = Date.now()): StorageFreshness {
  return readStorageFreshness(TRUST_KEY, TTL_MS, nowMs)
}

export function persistLearning(learning: LearningState): LegacyPersistenceResult {
  const snap: Snapshot<LearningState> = { data: learning, savedAt: Date.now() }
  return persistLegacyValue(LEARNING_KEY, JSON.stringify(snap))
}

export function restoreLearning(): LearningState | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      if (Date.now() - generation.savedAt > LEARNING_TTL_MS) return null
      return generation.payload.learning ? sanitizeLearningState(generation.payload.learning) : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(LEARNING_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<unknown>
    if (Date.now() - snap.savedAt > LEARNING_TTL_MS) {
      localStorage.removeItem(LEARNING_KEY)
      return null
    }
    return sanitizeLearningState(snap.data)
  } catch { return null }
}

// ── Phase 8: CSV取込時刻の永続化（リロード跨ぎ・90日TTL） ─────
const CSV_TTL_MS = 90 * 24 * 60 * 60 * 1000  // 90日

interface CsvSnapshot { at: string; savedAt: number }

export interface CsvMetadataReferenceInput {
  provenance?: CsvImportProvenance | null
  csvImportedAt?: string | null
  importedAt?: string | null
  legacySnapshotAt?: string | null
  syncSummaryImportedAt?: string | null
}

/**
 * Resolve the immutable timestamp used only for the 90-day CSV metadata retention window.
 * Physical persistence clocks (manifest/wrapper savedAt) are intentionally not inputs.
 */
export function resolveCsvMetadataReferenceEpochMs(input: CsvMetadataReferenceInput): number | null {
  const provenance = input.provenance
  if (provenance?.sourceAsOfConfidence === 'authoritative' && provenance.sourceAsOf !== null) {
    const sourceAsOf = parseStrictTimestamp(provenance.sourceAsOf)
    return sourceAsOf?.epochMs ?? null
  }

  for (const candidate of [
    input.csvImportedAt,
    input.importedAt,
    provenance?.importedAt,
    input.legacySnapshotAt,
    input.syncSummaryImportedAt,
  ]) {
    if (candidate !== null && candidate !== undefined) {
      return parseStrictTimestamp(candidate)?.epochMs ?? null
    }
  }
  return null
}

export function isCsvMetadataReferenceWithinTtl(
  input: CsvMetadataReferenceInput,
  nowMs: number,
): boolean {
  if (!Number.isFinite(nowMs)) return false
  const referenceEpochMs = resolveCsvMetadataReferenceEpochMs(input)
  if (referenceEpochMs === null) return false
  const ageMs = nowMs - referenceEpochMs
  return ageMs >= 0 && ageMs <= CSV_TTL_MS
}

/**
 * Validate a timestamp that will be returned or published as CSV metadata.
 * This is intentionally independent from the 90-day retention window: an old metadata
 * timestamp remains publishable when the immutable retention reference is still fresh.
 */
export function isCsvMetadataTimestampNotFuture(
  timestamp: unknown,
  nowMs: number,
): timestamp is string {
  if (!Number.isFinite(nowMs)) return false
  const parsed = parseStrictTimestamp(timestamp)
  return parsed !== null && parsed.epochMs <= nowMs
}

/** Validate and clone provenance before it crosses the persistence/store boundary. */
export function validateCsvImportProvenanceForRestore(
  provenance: CsvImportProvenance | null | undefined,
  nowMs: number,
): CsvImportProvenance | null {
  if (!Number.isFinite(nowMs) || !isCsvImportProvenance(provenance)) return null
  if (!isCsvMetadataTimestampNotFuture(provenance.importedAt, nowMs)) return null
  if (provenance.sourceAsOf !== null &&
      !isCsvMetadataTimestampNotFuture(provenance.sourceAsOf, nowMs)) return null
  return { ...provenance }
}

/** Restore canonical provenance without mutating or rewriting the canonical payload. */
export function restoreCsvImportProvenance(
  payload: CsvImportPersistencePayload,
  nowMs = Date.now(),
): CsvImportProvenance | null {
  return validateCsvImportProvenanceForRestore(payload.provenance, nowMs)
}

function canonicalCsvMetadataReferenceInput(
  payload: CsvImportPersistencePayload,
): CsvMetadataReferenceInput {
  return {
    provenance: payload.provenance,
    csvImportedAt: Object.prototype.hasOwnProperty.call(payload, 'csvImportedAt')
      ? payload.csvImportedAt ?? null
      : null,
    importedAt: payload.importedAt,
    syncSummaryImportedAt: payload.syncSummary?.importedAt,
  }
}

export function persistCsvImportedAt(at: string): LegacyPersistenceResult {
  const snap: CsvSnapshot = { at, savedAt: Date.now() }
  return persistLegacyValue(CSV_IMPORTED_AT_KEY, JSON.stringify(snap))
}

/** Interpret CSV source/import time without rewriting legacy v1-v3 payload bytes. */
export function getCsvImportPayloadCsvImportedAt(payload: CsvImportPersistencePayload): string | null {
  return Object.prototype.hasOwnProperty.call(payload, 'csvImportedAt')
    ? payload.csvImportedAt ?? null
    : payload.importedAt ?? null
}

export function restoreCsvImportedAt(nowMs = Date.now()): string | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      if (!isCsvMetadataReferenceWithinTtl(
        canonicalCsvMetadataReferenceInput(generation.payload),
        nowMs,
      )) return null
      const returnedTimestamp = getCsvImportPayloadCsvImportedAt(generation.payload)
      return isCsvMetadataTimestampNotFuture(returnedTimestamp, nowMs)
        ? returnedTimestamp
        : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(CSV_IMPORTED_AT_KEY)
    if (!raw) return null
    // レガシー: 生のISO文字列だった場合は移行
    if (!raw.startsWith('{')) {
      localStorage.removeItem(CSV_IMPORTED_AT_KEY)
      return null
    }
    const snap = JSON.parse(raw) as CsvSnapshot
    const referenceEpochMs = resolveCsvMetadataReferenceEpochMs({ legacySnapshotAt: snap.at })
    if (referenceEpochMs === null || !isCsvMetadataTimestampNotFuture(snap.at, nowMs)) return null
    if (nowMs - referenceEpochMs > CSV_TTL_MS) {
      localStorage.removeItem(CSV_IMPORTED_AT_KEY)
      return null
    }
    return snap.at
  } catch { return null }
}

// ── P4.5-A013-T6: CSV取込結果summaryの永続化（表示専用・90日TTL） ──────
// csvLastImportedAtと同じimmutable reference（authoritative sourceAsOf優先、
// importedAt fallback）によるTTLを使う。詳細summaryだけが残っても意味がないため、
// 両metadataは同じreference/clockで失効する。portfolio snapshot importはこのkeyへ一切書き込まない
// （snapshot importの結果をCSV取込結果として偽装しないため）。
const CSV_SYNC_SUMMARY_KEY = 'v13_csv_sync_summary'

interface CsvSyncSummarySnapshot { data: CsvSyncSummary; savedAt: number }

/**
 * CSV import専用の同期永続化境界。
 *
 * 通常の個別persist helperは既存互換のためquota例外を握り潰すが、CSV importは
 * UI成功判定へ結果を返す必要がある。payload・manifest・commit markerを単一envelopeへ
 * serializeし、canonical keyを1回だけ置換する。localStorageの単一setItemが失敗した
 * 場合は旧envelopeが有効なままで、multi-key rollbackやその再失敗に依存しない。
 */
export function persistCsvImportTransaction(
  payload: CsvImportPersistencePayload,
  savedAt = Date.now(),
  expectedPreviousRaw?: string | null,
  writeContract: CsvImportCanonicalWriteContract = { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA },
): CsvImportPersistenceReceipt {
  if (typeof localStorage === 'undefined') {
    throw new CsvImportPersistenceError('永続化ストレージを利用できません', 'not_attempted')
  }

  const previousRaw = readCsvImportCanonicalRaw()
  if (expectedPreviousRaw !== undefined && previousRaw !== expectedPreviousRaw) {
    throw new CsvImportCanonicalConflictError(
      'CSV取込データの保存前にcanonical世代が変更されました。外部の世代を維持して取込を中断しました。',
    )
  }
  let serializedEnvelope: string
  try {
    const hasCsvImportedAt = Object.prototype.hasOwnProperty.call(payload, 'csvImportedAt')
    const {
      importedAt: legacyImportedAt,
      csvImportedAt: requestedCsvImportedAt,
      snapshotGenerationIdentity: _requestedSnapshotGenerationIdentity,
      snapshotTransferIdentity: requestedSnapshotTransferIdentity,
      ...payloadWithoutTimestampAliases
    } = payload
    const normalizedBase = {
      ...payloadWithoutTimestampAliases,
      csvImportedAt: hasCsvImportedAt ? requestedCsvImportedAt ?? null : legacyImportedAt ?? null,
      provenance: payload.provenance ?? null,
      portfolioPolicy: Object.prototype.hasOwnProperty.call(payload, 'portfolioPolicy')
        ? payload.portfolioPolicy
        : { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: Object.prototype.hasOwnProperty.call(payload, 'cashAssumptions')
        ? payload.cashAssumptions
        : { ...DEFAULT_CASH_ASSUMPTIONS },
      // Missing origin belongs to a legacy/unknown caller. Do not infer CSV merely because
      // v1/v2 had no origin key; production CSV and snapshot commits always pass it explicitly.
      origin: payload.origin ?? null,
      snapshotTransferIdentity: requestedSnapshotTransferIdentity ?? null,
    }
    const identityInput = {
      holdings: normalizedBase.holdings,
      trust: normalizedBase.trust,
      learning: normalizedBase.learning,
      portfolioPolicy: normalizedBase.portfolioPolicy!,
      cashAssumptions: normalizedBase.cashAssumptions!,
      csvImportedAt: normalizedBase.csvImportedAt,
      csvImportProvenance: normalizedBase.provenance,
      syncSummary: normalizedBase.syncSummary,
      trustShortSnapshot: normalizedBase.trustShortSnapshot,
      origin: normalizedBase.origin,
      snapshotTransferIdentity: normalizedBase.snapshotTransferIdentity,
    }
    const normalizedPayload: CsvImportPersistencePayload = {
      ...normalizedBase,
      snapshotGenerationIdentity: writeContract.schemaVersion === CSV_IMPORT_GENERATION_SCHEMA_V5
        ? computeCanonicalPortfolioGenerationIdentityV2(identityInput)
        : computeCanonicalPortfolioGenerationIdentity(identityInput),
    }
    if (!isCsvImportPayload(normalizedPayload, writeContract.schemaVersion)) {
      throw new Error('canonical payload schema validation failed')
    }
    const serializedPayload = JSON.stringify(normalizedPayload)
    const generationId = `${savedAt.toString(36)}-${(generationSequence += 1).toString(36)}`
    serializedEnvelope = JSON.stringify({
      manifest: {
        schemaVersion: writeContract.schemaVersion,
        generationId,
        savedAt,
        committed: true,
        payloadChecksum: checksum(serializedPayload),
      },
      payload: normalizedPayload,
    } satisfies CsvImportGenerationEnvelope)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CsvImportPersistenceError(`CSV取込データを保存形式へ変換できませんでした: ${detail}`, 'not_attempted')
  }

  try {
    localStorage.setItem(CSV_IMPORT_GENERATION_KEY, serializedEnvelope)
    return { previousRaw, committedRaw: serializedEnvelope }
  } catch (error) {
    // T9-A004-R3c: setItemのthrowはbytesが物理的に書かれなかったことを保証しない
    // （書込成功後・完了通知前のcrash相当例外）。物理bytesが新envelopeへ置換済みなら
    // commitは成立している — 「rolled_back」と偽ってreloadで失敗世代が出現する
    // 偽状態を作らず、成立したtransactionとしてreceiptを返す。
    let physicalRaw: string | null
    try {
      physicalRaw = localStorage.getItem(CSV_IMPORT_GENERATION_KEY)
    } catch {
      // Ownership cannot be established, so neither rollback nor recovery is safe. In
      // particular, never claim rolled_back while the new bytes may already be physical.
      throw new CsvImportPersistenceIndeterminateError()
    }
    if (physicalRaw === serializedEnvelope) {
      return { previousRaw, committedRaw: serializedEnvelope }
    }
    if (physicalRaw !== previousRaw) {
      throw new CsvImportPersistenceError(
        'CSV取込データの保存後にcanonical世代が変更されました。再読み込み後に状態を確認してください。',
        'rollback_failed',
      )
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new CsvImportPersistenceError(`CSV取込データの永続化に失敗しました: ${detail}`, 'rolled_back')
  }
}

/** Capture the exact physical canonical bytes for a later compare-and-swap. */
export function readCsvImportCanonicalRaw(): string | null {
  if (typeof localStorage === 'undefined') {
    throw new CsvImportPersistenceError('永続化ストレージを利用できません', 'not_attempted')
  }
  try {
    return localStorage.getItem(CSV_IMPORT_GENERATION_KEY)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CsvImportPersistenceError(`CSV取込データの既存世代を確認できませんでした: ${detail}`, 'not_attempted')
  }
}

/** Publish is allowed only while the exact bytes written by this transaction remain physical. */
export function ownsCsvImportCanonicalBytes(receipt: CsvImportPersistenceReceipt): boolean {
  try {
    return localStorage.getItem(CSV_IMPORT_GENERATION_KEY) === receipt.committedRaw
  } catch {
    return false
  }
}

/** Roll back only the exact tentative generation written by this transaction. */
export function rollbackCsvImportTransaction(receipt: CsvImportPersistenceReceipt): boolean {
  try {
    if (localStorage.getItem(CSV_IMPORT_GENERATION_KEY) !== receipt.committedRaw) return false
    if (receipt.previousRaw === null) localStorage.removeItem(CSV_IMPORT_GENERATION_KEY)
    else localStorage.setItem(CSV_IMPORT_GENERATION_KEY, receipt.previousRaw)
    return localStorage.getItem(CSV_IMPORT_GENERATION_KEY) === receipt.previousRaw
  } catch {
    return false
  }
}

export function persistCsvSyncSummary(summary: CsvSyncSummary): LegacyPersistenceResult {
  const snap: CsvSyncSummarySnapshot = { data: summary, savedAt: Date.now() }
  return persistLegacyValue(CSV_SYNC_SUMMARY_KEY, JSON.stringify(snap))
}

export function restoreCsvSyncSummary(nowMs = Date.now()): CsvSyncSummary | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      if (!isCsvMetadataReferenceWithinTtl(
        canonicalCsvMetadataReferenceInput(generation.payload),
        nowMs,
      )) return null
      const summary = generation.payload.syncSummary
      return summary !== null && isCsvMetadataTimestampNotFuture(summary.importedAt, nowMs)
        ? summary
        : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(CSV_SYNC_SUMMARY_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as CsvSyncSummarySnapshot
    if (!isCsvSyncSummary(snap.data)) return null
    const referenceEpochMs = resolveCsvMetadataReferenceEpochMs({
      syncSummaryImportedAt: snap.data.importedAt,
    })
    if (referenceEpochMs === null ||
        !isCsvMetadataTimestampNotFuture(snap.data.importedAt, nowMs)) return null
    if (nowMs - referenceEpochMs > CSV_TTL_MS) {
      localStorage.removeItem(CSV_SYNC_SUMMARY_KEY)
      return null
    }
    return snap.data
  } catch { return null }
}

export function restoreCsvTrustShortSnapshot(): TrustShortPortfolioSnapshot | null {
  const generation = restoreCsvImportGeneration()
  return generation.status === 'committed' ? generation.payload.trustShortSnapshot : null
}

export type CsvTrustShortSnapshotRestoreResult =
  | { status: 'committed'; snapshot: TrustShortPortfolioSnapshot }
  | { status: 'none' | 'invalid'; snapshot: null }

export function restoreCsvTrustShortSnapshotState(): CsvTrustShortSnapshotRestoreResult {
  const generation = restoreCsvImportGeneration()
  if (generation.status === 'committed') {
    return { status: 'committed', snapshot: generation.payload.trustShortSnapshot }
  }
  return { status: generation.status, snapshot: null }
}

// ── P4-A47: PortfolioPolicy 永続化（TTL: 7日） ─────────────
const PORTFOLIO_POLICY_KEY = 'v13_portfolio_policy'

export function persistPortfolioPolicy(policy: PortfolioPolicy): LegacyPersistenceResult {
  const snap: Snapshot<PortfolioPolicy> = { data: policy, savedAt: Date.now() }
  return persistLegacyValue(PORTFOLIO_POLICY_KEY, JSON.stringify(snap))
}

export function restorePortfolioPolicy(): PortfolioPolicy | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      return generation.payload.portfolioPolicy
        ? { ...generation.payload.portfolioPolicy }
        : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(PORTFOLIO_POLICY_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<PortfolioPolicy>
    if (Date.now() - snap.savedAt > TTL_MS) {
      localStorage.removeItem(PORTFOLIO_POLICY_KEY)
      return null
    }
    const r = snap.data?.jpStockMaxRatio
    if (typeof r !== 'number' || r < 0.05 || r > 0.30) return null
    return { jpStockMaxRatio: r }
  } catch { return null }
}

// ── P4.5-A002: 資金前提（現金・待機資金）手動override 永続化（TTL: 7日） ──
// この端末（ブラウザ）にのみ保存される。PC/スマホ間の自動共有は未実装（次チケットで検討）。
const CASH_ASSUMPTIONS_KEY = 'v13_cash_assumptions'

export function persistCashAssumptions(assumptions: CashAssumptions): LegacyPersistenceResult {
  const snap: Snapshot<CashAssumptions> = { data: assumptions, savedAt: Date.now() }
  return persistLegacyValue(CASH_ASSUMPTIONS_KEY, JSON.stringify(snap))
}

export function restoreCashAssumptions(): CashAssumptions | null {
  try {
    const generation = restoreCsvImportGeneration()
    if (generation.status === 'committed') {
      return generation.payload.cashAssumptions
        ? { ...generation.payload.cashAssumptions }
        : null
    }
    if (generation.status === 'invalid') return null
    const raw = localStorage.getItem(CASH_ASSUMPTIONS_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<CashAssumptions>
    // P4.5-A008: 資金前提はTTL失効による無警告revertを廃止する（手動値が黙って既定値へ
    // 戻ると、総資産分母・headroom・P5買付余力が気づかれずに変わってしまうため）。
    // 鮮度はmanualUpdatedAt基準のstale警告（selectCashAssumptionsFreshness）で表示専用に扱う。
    const d = snap.data
    if (
      typeof d?.cashDeposits !== 'number' || !Number.isFinite(d.cashDeposits) || d.cashDeposits < 0 ||
      typeof d?.standbyFunds !== 'number' || !Number.isFinite(d.standbyFunds) || d.standbyFunds < 0 ||
      typeof d?.manualOverrideEnabled !== 'boolean'
    ) return null
    return {
      cashDeposits: d.cashDeposits,
      standbyFunds: d.standbyFunds,
      manualOverrideEnabled: d.manualOverrideEnabled,
      manualUpdatedAt: typeof d.manualUpdatedAt === 'string' ? d.manualUpdatedAt : null,
    }
  } catch { return null }
}
