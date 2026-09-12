/**
 * OPS-SBI-P2-PREBUILD-PHASE2-STORE-AUTHORITY
 *
 * Stage B (trust resolution + final FULL_EXPORT authority) and the staged-diff builder that
 * store orchestration uses once COMPLETE is proven. Pure functions only — no Zustand/store
 * dependency, no localStorage access (see ticket section 7). This module deliberately
 * duplicates the handful of small normalization primitives it needs from
 * importPortfolioCsv.ts (normalizeForMatch/account normalization), the same way
 * sbiPortfolioImportV2.ts duplicates its own text primitives — see that file's header for why.
 *
 * Two-stage authority model (ticket section 4):
 *   Stage A (sbiPortfolioImportV2.ts) proves structural completeness.
 *   Stage B (this file) proves every non-empty trust row uniquely resolves against the live
 *   trust registry. Only Stage A + Stage B together may yield FULL_EXPORT / COMPLETE.
 */

import type { Trust } from '../../types'
import type {
  CompletenessReason,
  ProvisionalStockRow,
  ProvisionalTrustRow,
  RequiredSectionId,
  SbiPortfolioImportResultV2,
} from './sbiPortfolioImportV2'
import {
  PORTFOLIO_IMPORT_AUTHORITY_VERSION,
  type PortfolioImportAuthorityAssetClass,
  type PortfolioImportAuthorityV1,
  type PortfolioImportSectionCompletenessEntry,
} from '../../types/portfolioImportAuthority'

// ─────────────────────────────────────────────────────────────────────────────
// Trust resolution (Stage B) — frozen matching rules (ticket section 5):
//   NFKC-normalized exact identity / exact registered ID / exact alias / exact canonical name /
//   account-hint hard filtering / one CSV row → one registry identity / collision detection.
//   Forbidden: substring matching, fuzzy matching, monetary nearest-match, cross-account guess.
// ─────────────────────────────────────────────────────────────────────────────

export type TrustResolutionRowStatus =
  | 'RESOLVED'
  | 'UNKNOWN_TRUST'
  | 'AMBIGUOUS_TRUST'
  | 'ACCOUNT_MISMATCH'
  | 'TRUST_REGISTRY_MISS'

export interface TrustRowResolutionResult {
  row: ProvisionalTrustRow
  status: TrustResolutionRowStatus
  /** Non-null only when status === 'RESOLVED'. */
  matchedTrustId: string | null
}

type AccountLabel = '' | '特定' | 'NISA成長' | 'NISA積立'

function normalizeAccountLabel(raw: string): AccountLabel {
  const normalized = raw.trim().normalize('NFKC').replace(/\s/g, '')
  if (normalized.includes('特定')) return '特定'
  if (normalized.includes('NISA成長')) return 'NISA成長'
  if (normalized.includes('NISA積立')) return 'NISA積立'
  return ''
}

function normalizeForMatch(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・･\-_（）()[\]［］]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** Account-agnostic identity match: exact id > exact alias > exact canonical name > none. */
function nameMatchScore(row: ProvisionalTrustRow, fund: Trust, aliases: Readonly<Record<string, readonly string[]>>): number {
  const rowCode = normalizeForMatch(row.code)
  const rowName = normalizeForMatch(row.name)
  if (rowCode && rowCode === normalizeForMatch(fund.id)) return 300
  const aliasKeys = (aliases[fund.id] ?? []).map(normalizeForMatch)
  if (rowName && aliasKeys.includes(rowName)) return 200
  if (rowName && rowName === normalizeForMatch(fund.name)) return 150
  return 0
}

/**
 * Resolves every provisional trust row against the live registry. Deterministic and
 * fail-closed: a row is RESOLVED only when exactly one registry entry uniquely identifies it
 * (by identity match) AND that entry's account matches the row's CSV section account-hint AND
 * no other row in this same call also resolves to that same registry id (collision).
 */
export function resolveTrustRows(
  rows: readonly ProvisionalTrustRow[],
  registry: readonly Trust[],
  aliases: Readonly<Record<string, readonly string[]>>,
): TrustRowResolutionResult[] {
  if (registry.length === 0) {
    return rows.map(row => ({ row, status: 'TRUST_REGISTRY_MISS', matchedTrustId: null }))
  }

  // Pass 1: per-row candidate resolution (account-hint hard filter applied after identity match,
  // so UNKNOWN_TRUST and ACCOUNT_MISMATCH stay distinguishable).
  const provisional: Array<{ row: ProvisionalTrustRow; status: TrustResolutionRowStatus; matchedTrustId: string | null }> = []
  for (const row of rows) {
    const rowAccount = normalizeAccountLabel(row.accountHint)
    const scored = registry
      .map(fund => ({ fund, score: nameMatchScore(row, fund, aliases) }))
      .filter(entry => entry.score > 0)
    if (scored.length === 0) {
      provisional.push({ row, status: 'UNKNOWN_TRUST', matchedTrustId: null })
      continue
    }
    const topScore = Math.max(...scored.map(entry => entry.score))
    const identityMatches = scored.filter(entry => entry.score === topScore).map(entry => entry.fund)
    const accountMatches = identityMatches.filter(fund => normalizeAccountLabel(fund.account) === rowAccount)
    if (accountMatches.length === 0) {
      provisional.push({ row, status: 'ACCOUNT_MISMATCH', matchedTrustId: null })
      continue
    }
    if (accountMatches.length > 1) {
      provisional.push({ row, status: 'AMBIGUOUS_TRUST', matchedTrustId: null })
      continue
    }
    provisional.push({ row, status: 'RESOLVED', matchedTrustId: accountMatches[0].id })
  }

  // Pass 2: collision detection — one CSV row → one registry identity (section 5). If two
  // distinct rows resolved to the same trust id, neither can be trusted as authoritative.
  const resolvedIdCounts = new Map<string, number>()
  for (const entry of provisional) {
    if (entry.status === 'RESOLVED' && entry.matchedTrustId) {
      resolvedIdCounts.set(entry.matchedTrustId, (resolvedIdCounts.get(entry.matchedTrustId) ?? 0) + 1)
    }
  }
  return provisional.map(entry => {
    if (entry.status === 'RESOLVED' && entry.matchedTrustId && (resolvedIdCounts.get(entry.matchedTrustId) ?? 0) > 1) {
      return { row: entry.row, status: 'AMBIGUOUS_TRUST' as const, matchedTrustId: null }
    }
    return entry
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Final FULL_EXPORT completeness authority (ticket section 6)
// ─────────────────────────────────────────────────────────────────────────────

export type FinalFullExportAuthorityResult =
  | { status: 'PASS' }
  | { status: 'FAIL'; reasons: CompletenessReason[] }
  | { status: 'NOT_APPLICABLE' }

/**
 * PASS only if Stage A structural completeness passes (independent of trust-registry
 * availability) AND every non-empty trust row uniquely resolved (Stage B). A FULL_EXPORT PASS
 * here means the file proves the complete authoritative portfolio population for the
 * registered profile (ticket section 6).
 */
export function evaluateFinalFullExportAuthority(
  parsed: SbiPortfolioImportResultV2,
  trustRowResolutions: readonly TrustRowResolutionResult[],
): FinalFullExportAuthorityResult {
  if (parsed.mode !== 'FULL_EXPORT') return { status: 'NOT_APPLICABLE' }

  const reasons = new Set<CompletenessReason>()
  if (parsed.completeness.status === 'FAIL') {
    for (const reason of parsed.completeness.reasons) {
      // TRUST_REGISTRY_MISS from Stage A means only "no registry was supplied to Stage A" (it
      // never is — Stage A is a pure text-only parser). Stage B re-derives the real trust
      // reasons below from the live registry instead of trusting Stage A's placeholder.
      if (reason !== 'TRUST_REGISTRY_MISS') reasons.add(reason)
    }
  } else if (parsed.completeness.status === 'NOT_APPLICABLE') {
    // Unreachable for mode === 'FULL_EXPORT' (see parseSbiPortfolioImportV2), but fail closed
    // rather than silently PASS if this invariant is ever violated upstream.
    reasons.add('ZERO_STRUCTURAL_SECTIONS')
  }

  for (const entry of trustRowResolutions) {
    if (entry.status === 'UNKNOWN_TRUST') reasons.add('UNKNOWN_TRUST')
    if (entry.status === 'AMBIGUOUS_TRUST') reasons.add('AMBIGUOUS_TRUST')
    if (entry.status === 'ACCOUNT_MISMATCH') reasons.add('ACCOUNT_MISMATCH')
    if (entry.status === 'TRUST_REGISTRY_MISS') reasons.add('TRUST_REGISTRY_MISS')
  }

  return reasons.size > 0 ? { status: 'FAIL', reasons: [...reasons] } : { status: 'PASS' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Versioned authority metadata (ticket section 8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the COMPLETE authority object for a proven FULL_EXPORT. Callers must only invoke this
 * after evaluateFinalFullExportAuthority returned {status:'PASS'} — this function does not
 * itself re-verify that invariant (single call site: the store's FULL_EXPORT commit path).
 */
export function buildCompleteFullExportAuthority(parsed: SbiPortfolioImportResultV2): PortfolioImportAuthorityV1 {
  const sectionCompleteness: PortfolioImportSectionCompletenessEntry[] =
    (Object.keys(parsed.sections) as RequiredSectionId[]).map(sectionId => ({
      sectionId,
      status: parsed.sections[sectionId].status,
    }))
  return {
    authorityVersion: PORTFOLIO_IMPORT_AUTHORITY_VERSION,
    importMode: 'FULL_EXPORT',
    contractVersion: parsed.contractVersion,
    profileId: parsed.profileId,
    authorityStatus: 'COMPLETE',
    selectedAssetClasses: null,
    preservedAssetClasses: null,
    provenanceScope: 'FULL_EXPORT',
    sectionCompleteness,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Staged diff (ticket section 13) — only ever built by the caller after COMPLETE is proven.
// ─────────────────────────────────────────────────────────────────────────────

export interface StagedStockUpsert {
  code: string
  name: string
  eval: number
  price: number
  pnlPct: number
  dayPct: number
  acquiredAt: string | null
}

export interface StagedTrustUpsert {
  id: string
  eval: number
  pnlPct: number
  dayPct: number
}

export interface FullExportStagedDiff {
  stock: {
    add: StagedStockUpsert[]
    update: StagedStockUpsert[]
    remove: string[]
  }
  trust: {
    /** Resolved trust rows to write (eval/pnlPct/dayPct updated; id/policy/account/mu/sigma
     *  registry metadata preserved by the caller, same model as the legacy CSV full-sync). */
    update: StagedTrustUpsert[]
    /** Registered trust ids not present among resolved rows this generation: eval→0 (never
     *  physically removed — same registry-preserving model as legacy full-sync). */
    zero: string[]
  }
  removedStockCount: number
  removedStockRatio: number
  /** true when the stock removal alone crosses the destructive-change thresholds (ticket
   *  section 14) — trust zeroing never gates confirmation independently in this phase. */
  destructive: boolean
}

export function buildFullExportStagedDiff(params: {
  provisionalStockRows: readonly ProvisionalStockRow[]
  trustRowResolutions: readonly TrustRowResolutionResult[]
  currentHoldingCodes: readonly string[]
  currentTrust: readonly { id: string; eval: number }[]
  removalRatioThreshold: number
  removalAbsoluteCap: number
}): FullExportStagedDiff {
  const aggregated = new Map<string, StagedStockUpsert>()
  for (const row of params.provisionalStockRows) {
    const existing = aggregated.get(row.code)
    aggregated.set(row.code, {
      code: row.code,
      name: row.name || existing?.name || row.code,
      eval: (existing?.eval ?? 0) + row.eval,
      price: row.price > 0 ? row.price : (existing?.price ?? 0),
      pnlPct: row.pnlPct !== 0 ? row.pnlPct : (existing?.pnlPct ?? 0),
      dayPct: row.dayPct !== 0 ? row.dayPct : (existing?.dayPct ?? 0),
      acquiredAt: row.acquiredAt ?? existing?.acquiredAt ?? null,
    })
  }
  const csvCodes = new Set(aggregated.keys())
  const currentCodes = new Set(params.currentHoldingCodes)
  const add = [...aggregated.values()].filter(row => !currentCodes.has(row.code))
  const update = [...aggregated.values()].filter(row => currentCodes.has(row.code))
  const remove = params.currentHoldingCodes.filter(code => !csvCodes.has(code))

  const resolvedByTrustId = new Map<string, ProvisionalTrustRow>()
  for (const entry of params.trustRowResolutions) {
    if (entry.status === 'RESOLVED' && entry.matchedTrustId) {
      resolvedByTrustId.set(entry.matchedTrustId, entry.row)
    }
  }
  const trustUpdate: StagedTrustUpsert[] = [...resolvedByTrustId.entries()].map(([id, row]) => ({
    id,
    eval: row.eval,
    pnlPct: row.pnlPct,
    dayPct: row.dayPct,
  }))
  const trustZero = params.currentTrust
    .filter(fund => fund.eval > 0 && !resolvedByTrustId.has(fund.id))
    .map(fund => fund.id)

  const removedStockCount = remove.length
  const removedStockRatio = params.currentHoldingCodes.length > 0
    ? removedStockCount / params.currentHoldingCodes.length
    : 0
  const destructive = params.currentHoldingCodes.length > 0 && (
    removedStockRatio > params.removalRatioThreshold ||
    removedStockCount > params.removalAbsoluteCap
  )

  return {
    stock: { add, update, remove },
    trust: { update: trustUpdate, zero: trustZero },
    removedStockCount,
    removedStockRatio,
    destructive,
  }
}

export type { PortfolioImportAuthorityAssetClass }
