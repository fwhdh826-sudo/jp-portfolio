import type { CsvImportProvenance } from '../types'
import { compareUtf16CodeUnits, sha256Utf8Hex } from '../domain/csv/csvSemanticIdentity'
import { normalizeStrictTimestamp } from './strictTimestamp'

export const SNAPSHOT_GENERATION_CONTRACT = 'portfolio-snapshot-generation-1' as const

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
  cashAssumptions: {
    cashDeposits: number
    standbyFunds: number
    manualOverrideEnabled: boolean
    manualUpdatedAt: string | null
  } | null
  csvImportedAt: string | null
  csvImportProvenance: CsvImportProvenance | null
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
  return [
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
      : [
          canonicalNumber(cash.cashDeposits),
          canonicalNumber(cash.standbyFunds),
          cash.manualOverrideEnabled,
          canonicalTimestamp(cash.manualUpdatedAt),
        ],
    csvImportedAt: canonicalTimestamp(input.csvImportedAt),
    csvImportProvenance: canonicalProvenance(input.csvImportProvenance),
  })
}

export function computeSnapshotGenerationIdentity(input: SnapshotGenerationInput): string {
  return `sha256:${sha256Utf8Hex(serializeSnapshotGeneration(input))}`
}

export function isSnapshotGenerationIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}
