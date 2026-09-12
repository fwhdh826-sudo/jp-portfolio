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
