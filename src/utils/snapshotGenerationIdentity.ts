import type {
  CashAssumptions,
  CsvImportProvenance,
  CsvSyncSummary,
  Holding,
  LearningState,
  PortfolioImportAuthorityV1,
  PortfolioPolicy,
  Trust,
} from '../types'
import type { TrustShortPortfolioSnapshot } from '../domain/learning/trustShortTracker'
import { compareUtf16CodeUnits, sha256Utf8Hex } from '../domain/csv/csvSemanticIdentity'
import { normalizeStrictTimestamp } from './strictTimestamp'

export const SNAPSHOT_GENERATION_CONTRACT = 'portfolio-snapshot-generation-1' as const
// OPS-SBI-P2-PREBUILD-PHASE2-R1-AUTHORITY-INTEGRITY-REPAIR (P2-01 ticket section 4): adds
// PortfolioImportAuthorityV1 to the manual cross-device transfer identity digest domain, so two
// otherwise-identical portfolio snapshots differing only in authorityStatus (e.g. COMPLETE vs
// LEGACY_UNPROVEN) can never share a transfer identity. V1 (above) is untouched — every existing
// call site (internal canonical-generation staged-transfer identities, none of which carry
// portfolioImportAuthority) keeps its exact historical digest input and output.
export const SNAPSHOT_GENERATION_CONTRACT_V2 = 'portfolio-snapshot-generation-2' as const
export const CANONICAL_GENERATION_CONTRACT_V1 = 'canonical-portfolio-generation-1' as const
export const CANONICAL_GENERATION_CONTRACT_V2 = 'canonical-portfolio-generation-2' as const
// OPS-SBI-P2-PREBUILD-PHASE2: canonical envelope v6 identity contract. Binds
// PortfolioImportAuthorityV1 into the digest so a COMPLETE generation and an otherwise
// byte-identical LEGACY_UNPROVEN/PARTIAL generation can never share an identity (ticket
// section 20/25 item 6).
export const CANONICAL_GENERATION_CONTRACT_V3 = 'canonical-portfolio-generation-3' as const
/** Backward-compatible name for the v4 canonical identity contract. */
export const CANONICAL_GENERATION_CONTRACT = CANONICAL_GENERATION_CONTRACT_V1

const CANONICAL_GENERATION_SCHEMA_V5 = 'csv-import-generation-5' as const
const CANONICAL_GENERATION_SCHEMA_V6 = 'csv-import-generation-6' as const

export interface SnapshotGenerationHolding {
  code: string
  name?: string
  eval: number
  pnlPct: number
  currentPrice?: number
  acquiredAt?: string | null
  sector?: string
  mu?: number
  sigma?: number
  sigmaSource?: 'yfinance' | 'static'
  beta?: number
  metadataStatus?: {
    fundamentals: 'known' | 'unknown'
    technicals: 'known' | 'unknown'
  }
}

export interface SnapshotGenerationTrust {
  id: string
  eval: number
  pnlPct: number
  dayPct?: number
  account?: string | null
}

export interface SnapshotGenerationInput {
  holdings: SnapshotGenerationHolding[]
  trust: SnapshotGenerationTrust[]
  portfolioPolicy: { jpStockMaxRatio: number } | null
  /**
   * CASH-AUTH-1: 現行スキーマ（source/grossCash/...）と、まだ移行されていない
   * legacy スキーマ（cashDeposits/standbyFunds/...）の両方を受け付ける。
   * legacy 形は移行前に保存された canonical payload の identity をそのまま
   * 再現できるよう、従来と同一のバイト列で canonical 化する。
   */
  cashAssumptions: CashAssumptions | LegacyCashAssumptionsIdentityShape | null
  csvImportedAt: string | null
  csvImportProvenance: CsvImportProvenance | null
}

/** CASH-AUTH-1 以前の永続化形。identity 再現のためだけに保持する */
export interface LegacyCashAssumptionsIdentityShape {
  cashDeposits: number
  standbyFunds: number
  manualOverrideEnabled: boolean
  manualUpdatedAt: string | null
}

export function isLegacyCashAssumptionsIdentityShape(
  value: CashAssumptions | LegacyCashAssumptionsIdentityShape,
): value is LegacyCashAssumptionsIdentityShape {
  return typeof (value as LegacyCashAssumptionsIdentityShape).manualOverrideEnabled === 'boolean'
}

export interface CanonicalPortfolioGenerationIdentityInput {
  holdings: Holding[]
  trust: Trust[]
  learning: LearningState | null
  portfolioPolicy: PortfolioPolicy
  cashAssumptions: CashAssumptions
  csvImportedAt: string | null
  csvImportProvenance: CsvImportProvenance | null
  syncSummary: CsvSyncSummary | null
  trustShortSnapshot: TrustShortPortfolioSnapshot
  origin: 'csv' | 'snapshot' | null
  snapshotTransferIdentity: string | null
  /** OPS-SBI-P2-PREBUILD-PHASE2: only read by serializeCanonicalPortfolioGenerationV3 (v6).
   *  V1/V2 ignore this field entirely, so their digest output is byte-for-byte unchanged. */
  importAuthority?: PortfolioImportAuthorityV1 | null
}

type CanonicalScalar = string | number | boolean | null
type CanonicalRow = CanonicalScalar[]

function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('snapshot generation contains a non-finite number')
  return Object.is(value, -0) ? 0 : value
}

function canonicalTimestamp(value: string | null): string | null {
  if (value === null) return null
  const normalized = normalizeStrictTimestamp(value)
  if (normalized === null) throw new TypeError('snapshot generation contains an invalid timestamp')
  return normalized
}

function sortCanonicalRows(rows: CanonicalRow[]): CanonicalRow[] {
  return rows
    .map(row => ({ row, key: JSON.stringify(row) }))
    .sort((left, right) => compareUtf16CodeUnits(left.key, right.key))
    .map(entry => entry.row)
}

function canonicalHolding(row: SnapshotGenerationHolding): CanonicalRow {
  const canonical: CanonicalRow = [
    row.code,
    row.name ?? null,
    canonicalNumber(row.eval),
    canonicalNumber(row.pnlPct),
    row.currentPrice === undefined ? null : canonicalNumber(row.currentPrice),
    row.acquiredAt ?? null,
    row.sector ?? null,
    row.mu === undefined ? null : canonicalNumber(row.mu),
    row.sigma === undefined ? null : canonicalNumber(row.sigma),
    row.sigmaSource ?? null,
    row.beta === undefined ? null : canonicalNumber(row.beta),
  ]
  // Additive compatibility: legacy snapshots omitted metadataStatus and retain
  // their exact historical digest input; new snapshots bind explicit provenance.
  if (row.metadataStatus !== undefined) {
    canonical.push(row.metadataStatus.fundamentals, row.metadataStatus.technicals)
  }
  return canonical
}

function canonicalTrust(row: SnapshotGenerationTrust): CanonicalRow {
  return [
    row.id,
    canonicalNumber(row.eval),
    canonicalNumber(row.pnlPct),
    row.dayPct === undefined ? null : canonicalNumber(row.dayPct),
    row.account ?? null,
  ]
}

function canonicalProvenance(value: CsvImportProvenance | null): CanonicalRow | null {
  if (value === null) return null
  return [
    canonicalTimestamp(value.importedAt),
    canonicalTimestamp(value.sourceAsOf),
    value.sourceAsOfKind,
    value.sourceAsOfConfidence,
    value.semanticIdentity ?? null,
    value.contentFingerprint,
    value.sourceFileName,
    canonicalTimestamp(value.fileLastModified),
  ]
}

/**
 * Canonical generation envelope for accidental corruption and generation-mixing detection.
 * This is an unkeyed digest input, not proof that a deliberate JSON author is authentic.
 * Export operation time and transport/file operation time outside provenance are excluded.
 */
export function serializeSnapshotGeneration(input: SnapshotGenerationInput): string {
  const cash = input.cashAssumptions
  return JSON.stringify({
    contract: SNAPSHOT_GENERATION_CONTRACT,
    holdings: sortCanonicalRows(input.holdings.map(canonicalHolding)),
    trustHoldings: sortCanonicalRows(input.trust.map(canonicalTrust)),
    portfolioPolicy: input.portfolioPolicy === null
      ? null
      : [canonicalNumber(input.portfolioPolicy.jpStockMaxRatio)],
    cashAssumptions: cash === null
      ? null
      // CASH-AUTH-1: legacy 形は従来と同一の4要素で canonical 化し、既存の
      // 保存済み identity を壊さない。現行スキーマは別の5要素になるため、
      // 現金権限の変更（金額・安全余力・未約定・更新時刻）は必ず
      // sourceSettingsVersion を変化させ、古い AllocationPlanSnapshot を無効化する。
      : isLegacyCashAssumptionsIdentityShape(cash)
        ? [
            canonicalNumber(cash.cashDeposits),
            canonicalNumber(cash.standbyFunds),
            cash.manualOverrideEnabled,
            canonicalTimestamp(cash.manualUpdatedAt),
          ]
        : [
            cash.source,
            canonicalNumber(cash.grossCash),
            canonicalNumber(cash.safetyReserve),
            cash.pendingOrderCash === null ? null : canonicalNumber(cash.pendingOrderCash),
            canonicalTimestamp(cash.updatedAt),
          ],
    csvImportedAt: canonicalTimestamp(input.csvImportedAt),
    csvImportProvenance: canonicalProvenance(input.csvImportProvenance),
  })
}

export function computeSnapshotGenerationIdentity(input: SnapshotGenerationInput): string {
  return `sha256:${sha256Utf8Hex(serializeSnapshotGeneration(input))}`
}

export interface SnapshotGenerationInputV2 extends SnapshotGenerationInput {
  /** OPS-SBI-P2-PREBUILD-PHASE2-R1-AUTHORITY-INTEGRITY-REPAIR: null only for a legacy (v1-v3)
   *  transfer that never carried authority metadata at all — a proven LEGACY_UNPROVEN authority
   *  object still participates in the digest like any other status, so it is never equated with
   *  the absence of the field. */
  importAuthority: PortfolioImportAuthorityV1 | null
}

/**
 * Transfer-identity contract for the versioned manual snapshot format (portfolio-snapshot-4):
 * binds PortfolioImportAuthorityV1 into the same digest domain as the rest of the transported
 * generation, so authority metadata cannot be swapped onto an otherwise-identical transfer
 * without changing its identity (ticket section 4: "Two otherwise identical portfolio snapshots
 * differing only in COMPLETE vs LEGACY_UNPROVEN must NOT share the same transfer/generation
 * identity"). The contract tag is part of the digest domain, so a V1-identity value can never
 * collide with a V2-identity value even for byte-identical non-authority content.
 */
export function serializeSnapshotGenerationV2(input: SnapshotGenerationInputV2): string {
  return JSON.stringify({
    ...JSON.parse(serializeSnapshotGeneration(input)),
    contract: SNAPSHOT_GENERATION_CONTRACT_V2,
    importAuthority: input.importAuthority,
  })
}

export function computeSnapshotGenerationIdentityV2(input: SnapshotGenerationInputV2): string {
  return `sha256:${sha256Utf8Hex(serializeSnapshotGenerationV2(input))}`
}

function stableCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonicalValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort(compareUtf16CodeUnits)
    return Object.fromEntries(keys.map(key => [key, stableCanonicalValue(record[key])]))
  }
  if (typeof value === 'number') return canonicalNumber(value)
  return value
}

function stableRows<T>(rows: T[]): unknown[] {
  return rows
    .map(row => stableCanonicalValue(row))
    .map(row => ({ row, key: JSON.stringify(row) }))
    .sort((left, right) => compareUtf16CodeUnits(left.key, right.key))
    .map(entry => entry.row)
}

/**
 * Identity of the complete durable canonical generation. Unlike the transfer identity, this
 * also binds derived holdings/trust fields, learning, tracker baseline, sync metadata, and origin.
 */
export function serializeCanonicalPortfolioGeneration(
  input: CanonicalPortfolioGenerationIdentityInput,
): string {
  return JSON.stringify(stableCanonicalValue({
    contract: CANONICAL_GENERATION_CONTRACT_V1,
    holdings: stableRows(input.holdings),
    trust: stableRows(input.trust),
    learning: input.learning,
    transferGeneration: JSON.parse(serializeSnapshotGeneration({
      holdings: input.holdings,
      trust: input.trust,
      portfolioPolicy: input.portfolioPolicy,
      cashAssumptions: input.cashAssumptions,
      csvImportedAt: input.csvImportedAt,
      csvImportProvenance: input.csvImportProvenance,
    })),
    syncSummary: input.syncSummary,
    trustShortSnapshot: input.trustShortSnapshot,
    origin: input.origin,
    snapshotTransferIdentity: input.snapshotTransferIdentity,
  }))
}

export function computeCanonicalPortfolioGenerationIdentity(
  input: CanonicalPortfolioGenerationIdentityInput,
): string {
  return `sha256:${sha256Utf8Hex(serializeCanonicalPortfolioGeneration(input))}`
}

/**
 * Identity contract for canonical schema v5. The schema tag is deliberately part of the
 * digest domain so byte-equivalent v4 and v5 payloads cannot share an identity.
 */
export function serializeCanonicalPortfolioGenerationV2(
  input: CanonicalPortfolioGenerationIdentityInput,
): string {
  return JSON.stringify(stableCanonicalValue({
    contract: CANONICAL_GENERATION_CONTRACT_V2,
    schemaVersion: CANONICAL_GENERATION_SCHEMA_V5,
    holdings: stableRows(input.holdings),
    trust: stableRows(input.trust),
    learning: input.learning,
    transferGeneration: JSON.parse(serializeSnapshotGeneration({
      holdings: input.holdings,
      trust: input.trust,
      portfolioPolicy: input.portfolioPolicy,
      cashAssumptions: input.cashAssumptions,
      csvImportedAt: input.csvImportedAt,
      csvImportProvenance: input.csvImportProvenance,
    })),
    syncSummary: input.syncSummary,
    trustShortSnapshot: input.trustShortSnapshot,
    origin: input.origin,
    snapshotTransferIdentity: input.snapshotTransferIdentity,
  }))
}

export function computeCanonicalPortfolioGenerationIdentityV2(
  input: CanonicalPortfolioGenerationIdentityInput,
): string {
  return `sha256:${sha256Utf8Hex(serializeCanonicalPortfolioGenerationV2(input))}`
}

/**
 * Identity contract for canonical schema v6 (OPS-SBI-P2-PREBUILD-PHASE2). Adds
 * PortfolioImportAuthorityV1 to the digest domain on top of v5's shape, so authority metadata is
 * part of canonical/generation identity (ticket section 9/20): two payloads differing only in
 * authorityStatus can never share an identity, and reload cannot silently change one into the
 * other without also changing the generation identity.
 */
export function serializeCanonicalPortfolioGenerationV3(
  input: CanonicalPortfolioGenerationIdentityInput,
): string {
  return JSON.stringify(stableCanonicalValue({
    contract: CANONICAL_GENERATION_CONTRACT_V3,
    schemaVersion: CANONICAL_GENERATION_SCHEMA_V6,
    holdings: stableRows(input.holdings),
    trust: stableRows(input.trust),
    learning: input.learning,
    transferGeneration: JSON.parse(serializeSnapshotGeneration({
      holdings: input.holdings,
      trust: input.trust,
      portfolioPolicy: input.portfolioPolicy,
      cashAssumptions: input.cashAssumptions,
      csvImportedAt: input.csvImportedAt,
      csvImportProvenance: input.csvImportProvenance,
    })),
    syncSummary: input.syncSummary,
    trustShortSnapshot: input.trustShortSnapshot,
    origin: input.origin,
    snapshotTransferIdentity: input.snapshotTransferIdentity,
    importAuthority: input.importAuthority ?? null,
  }))
}

export function computeCanonicalPortfolioGenerationIdentityV3(
  input: CanonicalPortfolioGenerationIdentityInput,
): string {
  return `sha256:${sha256Utf8Hex(serializeCanonicalPortfolioGenerationV3(input))}`
}

export function isSnapshotGenerationIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}
