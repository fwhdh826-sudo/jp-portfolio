// OPS-SBI-P2-PREBUILD-PHASE2-STORE-AUTHORITY
//
// Versioned authority metadata for the SBI portfolio import (section 8 of the ticket). This is
// pure data shape only — the logic that produces/validates it lives in
// src/domain/csv/sbiPortfolioAuthorityV2.ts (evaluation) and src/store/persist.ts (canonical v6
// envelope validation). Kept in types/ to match the existing repo convention of separating data
// shapes (types/) from the pure domain logic that derives them (domain/).

export const PORTFOLIO_IMPORT_AUTHORITY_VERSION = 'portfolio-import-authority-1' as const

/**
 * COMPLETE   — an authoritative FULL_EXPORT proved the complete supported stock/trust population
 *              for the registered profile (Stage A structural completeness + Stage B unique
 *              trust resolution both PASS).
 * PARTIAL    — a deliberately scoped subset import (selectedAssetClasses explicit). Types/core
 *              semantics only in this phase — never reachable from ordinary FULL_EXPORT failure,
 *              and not normally produced by any current store action (see ticket section 22).
 * LEGACY_UNPROVEN — every other case: pre-v6 canonical generations, a fresh/never-imported store,
 *              or any restore path that cannot re-derive a v6 authority object. Never silently
 *              promoted to COMPLETE by reload/transfer (see ticket sections 10/21/25).
 */
export type PortfolioImportAuthorityStatus = 'COMPLETE' | 'PARTIAL' | 'LEGACY_UNPROVEN'

export type PortfolioImportAuthorityAssetClass = 'JP_STOCK' | 'INVESTMENT_TRUST'

export type PortfolioImportProvenanceScope =
  /** A proven FULL_EXPORT: every supported asset class for the registered profile. */
  | 'FULL_EXPORT'
  /** A proven PARTIAL_IMPORT: only selectedAssetClasses are authoritative; the rest are preserved
   *  as-is from the prior generation (never zeroed/removed by this import). */
  | 'PARTIAL_IMPORT'
  /** No import has ever authoritatively proven this generation (legacy/fresh). */
  | 'UNKNOWN'

export interface PortfolioImportSectionCompletenessEntry {
  sectionId: string
  status: 'ABSENT' | 'VALID_EMPTY' | 'VALID_NONEMPTY' | 'PARSE_FAILED'
}

export interface PortfolioImportAuthorityV1 {
  authorityVersion: typeof PORTFOLIO_IMPORT_AUTHORITY_VERSION
  importMode: 'FULL_EXPORT' | 'PARTIAL_IMPORT' | null
  contractVersion: string | null
  profileId: string | null
  authorityStatus: PortfolioImportAuthorityStatus
  /** Non-null only for a proven PARTIAL authority; null for COMPLETE/LEGACY_UNPROVEN. */
  selectedAssetClasses: PortfolioImportAuthorityAssetClass[] | null
  /** Asset classes intentionally left untouched by a PARTIAL import (preserved as-is). */
  preservedAssetClasses: PortfolioImportAuthorityAssetClass[] | null
  provenanceScope: PortfolioImportProvenanceScope
  /** Per required-section completeness snapshot at proof time (observability only). */
  sectionCompleteness: PortfolioImportSectionCompletenessEntry[]
}

/**
 * The canonical "never proven" authority object. Used for: initial store state, every restore of
 * a pre-v6 (or absent) canonical generation, and every store action that has not itself proven a
 * FULL_EXPORT/PARTIAL_IMPORT (see ticket section 10 — v1-v5 canonical data remains readable, but
 * its authority is never silently promoted to COMPLETE).
 */
export const LEGACY_UNPROVEN_PORTFOLIO_IMPORT_AUTHORITY: PortfolioImportAuthorityV1 = {
  authorityVersion: PORTFOLIO_IMPORT_AUTHORITY_VERSION,
  importMode: null,
  contractVersion: null,
  profileId: null,
  authorityStatus: 'LEGACY_UNPROVEN',
  selectedAssetClasses: null,
  preservedAssetClasses: null,
  provenanceScope: 'UNKNOWN',
  sectionCompleteness: [],
}

// ─────────────────────────────────────────────────────────────────────────────
// OPS-SBI-P2-PREBUILD-PHASE2-R1-AUTHORITY-INTEGRITY-REPAIR: the single shared runtime
// validator for PortfolioImportAuthorityV1's wire shape. Every caller that must trust a
// serialized authority object (the canonical v6 envelope in store/persist.ts, and the
// portfolio-snapshot-4 manual transfer wire format in utils/portfolioSnapshotTransfer.ts)
// reuses this exact function rather than each re-implementing its own copy — an unknown
// future authorityVersion, or any malformed field, is rejected (fail closed). This module
// duplicates the handful of tiny structural-validation primitives it needs (isRecord/
// hasExactKeys) rather than importing them from store/ or domain/, so this pure data-shape
// file has no dependency on either layer (same rationale as sbiPortfolioImportV2.ts's own
// header comment for duplicating its text primitives).
// ─────────────────────────────────────────────────────────────────────────────

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

const PORTFOLIO_IMPORT_AUTHORITY_STATUSES = ['COMPLETE', 'PARTIAL', 'LEGACY_UNPROVEN'] as const
const PORTFOLIO_IMPORT_AUTHORITY_ASSET_CLASSES = ['JP_STOCK', 'INVESTMENT_TRUST'] as const
const PORTFOLIO_IMPORT_PROVENANCE_SCOPES = ['FULL_EXPORT', 'PARTIAL_IMPORT', 'UNKNOWN'] as const
const PORTFOLIO_IMPORT_SECTION_STATUSES = ['ABSENT', 'VALID_EMPTY', 'VALID_NONEMPTY', 'PARSE_FAILED'] as const

function isPortfolioImportAuthorityAssetClassArrayOrNull(
  value: unknown,
): value is PortfolioImportAuthorityAssetClass[] | null {
  if (value === null) return true
  return Array.isArray(value) &&
    value.every(item => (PORTFOLIO_IMPORT_AUTHORITY_ASSET_CLASSES as readonly unknown[]).includes(item))
}

function isPortfolioImportSectionCompletenessEntry(value: unknown): value is PortfolioImportSectionCompletenessEntry {
  return isRecord(value) && hasExactKeys(value, ['sectionId', 'status']) &&
    isNonEmptyString(value.sectionId) &&
    (PORTFOLIO_IMPORT_SECTION_STATUSES as readonly unknown[]).includes(value.status)
}

/**
 * Exact-key, fail-closed validation for PortfolioImportAuthorityV1 — an unknown future
 * authorityVersion, or any malformed field, is rejected. This function never trusts the JSON
 * author; callers that treat the wire object as proof of a specific generation additionally
 * never trust this shape alone — they also recompute and compare a content-bound identity.
 */
export function isPortfolioImportAuthorityV1(value: unknown): value is PortfolioImportAuthorityV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'authorityVersion', 'importMode', 'contractVersion', 'profileId', 'authorityStatus',
    'selectedAssetClasses', 'preservedAssetClasses', 'provenanceScope', 'sectionCompleteness',
  ])) return false
  if (value.authorityVersion !== PORTFOLIO_IMPORT_AUTHORITY_VERSION) return false
  if (value.importMode !== 'FULL_EXPORT' && value.importMode !== 'PARTIAL_IMPORT' && value.importMode !== null) return false
  if (value.contractVersion !== null && !isNonEmptyString(value.contractVersion)) return false
  if (value.profileId !== null && !isNonEmptyString(value.profileId)) return false
  if (!(PORTFOLIO_IMPORT_AUTHORITY_STATUSES as readonly unknown[]).includes(value.authorityStatus)) return false
  if (!isPortfolioImportAuthorityAssetClassArrayOrNull(value.selectedAssetClasses)) return false
  if (!isPortfolioImportAuthorityAssetClassArrayOrNull(value.preservedAssetClasses)) return false
  if (!(PORTFOLIO_IMPORT_PROVENANCE_SCOPES as readonly unknown[]).includes(value.provenanceScope)) return false
  return Array.isArray(value.sectionCompleteness) &&
    value.sectionCompleteness.every(isPortfolioImportSectionCompletenessEntry)
}
