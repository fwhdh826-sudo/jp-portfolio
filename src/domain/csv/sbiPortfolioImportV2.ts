/**
 * OPS-SBI-P2-PREBUILD-PHASE1-PARSER-COMPLETENESS
 *
 * Frozen root cause (see ops ticket): the existing pipeline in ./importPortfolioCsv.ts
 * (importPortfolioCsv() / parseRows()) exposes only an aggregated row list plus a single
 * `trustSectionSeen` boolean. That is not enough structured evidence for a caller to prove
 * a FULL_EXPORT CSV is a *complete* authoritative snapshot:
 *   - a missing/unrecognized trust section can look equivalent to legitimate absence
 *   - a malformed position row can silently disappear
 *   - parseNum turns malformed/blank numeric cells into 0, indistinguishable from a
 *     genuine zero
 *   - "success" can be inferred purely from the presence of valid stock rows
 *
 * Required principle: successful parse != complete authoritative snapshot.
 *
 * This module is Phase 1 only: a versioned, strict, ADDITIVE analysis layer.
 *   - it is a pure function of CSV text only (no Holding[]/Trust[] input)
 *   - it does not merge, mutate, or replace any existing application state
 *   - it is NOT wired into importPortfolioCsv() or the store in this phase
 *   - it duplicates the handful of small text-normalization primitives it needs
 *     (normalizeCell/splitCsvLine) rather than importing them from
 *     importPortfolioCsv.ts, so this file can be added/removed/reworked with
 *     zero diff to the existing production parser
 *
 * Phase 1 explicitly does NOT implement: canonical v6, PortfolioImportAuthorityV1,
 * store mutation gate, officialDecision gate, T9 confirmation UI, or true trust
 * registry resolution (that needs the live Trust[] master list, which this pure
 * text-only parser does not take as input — see `TrustResolutionStatus`).
 */

import { extractExplicitSourceTimestamp, type ExplicitSourceTimestampResult } from './csvProvenance'

export const SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION = 'sbi-portfolio-import-2' as const
export const SBI_PORTFOLIO_PROFILE_ID = 'sbi-portfolio-v1' as const

export type ImportMode = 'FULL_EXPORT' | 'PARTIAL_IMPORT'
export type AssetClass = 'JP_STOCK' | 'INVESTMENT_TRUST'

export type RequiredSectionId =
  | 'JP_STOCK_CUSTODY'
  | 'TRUST_TAXABLE'
  | 'TRUST_NISA_GROWTH'
  | 'TRUST_NISA_ACCUMULATION'

const REQUIRED_SECTION_IDS: readonly RequiredSectionId[] = [
  'JP_STOCK_CUSTODY',
  'TRUST_TAXABLE',
  'TRUST_NISA_GROWTH',
  'TRUST_NISA_ACCUMULATION',
]

type SectionAssetType = 'stock' | 'trust'

interface RequiredSectionSignature {
  /** Exact registered label after normalizeSignature() — no substring matching. */
  label: string
  assetType: SectionAssetType
  accountHint: string
}

// Section 8/9: currently verified SBI export profile only. A materially different
// layout (unregistered section label) is NOT fuzzily accepted — see detectSectionSignature.
const REQUIRED_SECTION_SIGNATURES: Record<RequiredSectionId, RequiredSectionSignature> = {
  JP_STOCK_CUSTODY: { label: '株式(現物/特定預り)', assetType: 'stock', accountHint: '特定' },
  TRUST_TAXABLE: { label: '投資信託(金額/特定預り)', assetType: 'trust', accountHint: '特定' },
  TRUST_NISA_GROWTH: { label: '投資信託(金額/NISA預り(成長投資枠))', assetType: 'trust', accountHint: 'NISA成長' },
  TRUST_NISA_ACCUMULATION: { label: '投資信託(金額/NISA預り(つみたて投資枠))', assetType: 'trust', accountHint: 'NISA積立' },
}

export type SectionStatus = 'ABSENT' | 'VALID_EMPTY' | 'VALID_NONEMPTY' | 'PARSE_FAILED'

export type SectionFailureReason = 'SCHEMA_UNRECOGNIZED' | 'TRUNCATED' | 'REJECTED_ROWS' | 'TOTAL_MISMATCH'

/**
 * Deliberately a single flat shape (not a discriminated union per status) so the
 * strict state machine below can mutate one record in place. `positionRowCount`
 * is always `acceptedRowCount + rejectedPositionRowCount` by construction
 * (test 18 asserts this invariant).
 */
export interface SectionResult {
  id: RequiredSectionId
  status: SectionStatus
  schemaId: string | null
  positionRowCount: number
  acceptedRowCount: number
  rejectedPositionRowCount: number
  failureReasons: SectionFailureReason[]
}

function absentSection(id: RequiredSectionId): SectionResult {
  return { id, status: 'ABSENT', schemaId: null, positionRowCount: 0, acceptedRowCount: 0, rejectedPositionRowCount: 0, failureReasons: [] }
}

export type RowClassificationKind =
  | 'registeredHeader'
  | 'sectionTotal'
  | 'grandTotalFooter'
  | 'registeredInformational'
  | 'supportedNonPosition'
  | 'acceptedPosition'
  | 'rejectedPosition'

export type RowRejectionReason =
  | 'INVALID_CODE'
  | 'MISSING_NAME'
  | 'INVALID_EVAL_BLANK'
  | 'INVALID_EVAL_MALFORMED'
  | 'INVALID_EVAL_NON_FINITE'

export interface RowDiagnosticEntry {
  lineNumber: number
  kind: RowClassificationKind
  sectionId: RequiredSectionId | null
  unsupportedSectionLabel: string | null
  rejectionReason?: RowRejectionReason
}

export interface UnsupportedSectionResult {
  label: string
  assetType: SectionAssetType
  /** e.g. a stock credit/margin ("信用") section: recognized as a specific known
   *  category that is out of scope for this profile, vs. a wholly unrecognized label. */
  recognizedButOutOfScope: boolean
  nonEmpty: boolean
  rowCount: number
}

// Section 16: machine-readable completeness reason vocabulary. Only the reasons this
// parser-only layer can authoritatively establish are ever emitted by
// evaluateFullExportCompleteness() below — UNKNOWN_TRUST / AMBIGUOUS_TRUST /
// ACCOUNT_MISMATCH require the live trust registry and are declared here for forward
// API compatibility only (see section 14/17: TRUST_REGISTRY_MISS is what Phase 1 emits
// in their place).
export type CompletenessReason =
  | 'EMPTY_FILE'
  | 'ZERO_STRUCTURAL_SECTIONS'
  | 'EXPECTED_SECTION_ABSENT'
  | 'SECTION_SCHEMA_UNRECOGNIZED'
  | 'SECTION_PARSE_FAILED'
  | 'SECTION_TRUNCATED'
  | 'SECTION_TOTAL_MISMATCH'
  | 'UNEXPLAINED_POSITION_ROW'
  | 'UNKNOWN_POSITION_SECTION'
  | 'UNSUPPORTED_POSITION_SECTION'
  | 'UNKNOWN_TRUST'
  | 'AMBIGUOUS_TRUST'
  | 'ACCOUNT_MISMATCH'
  | 'TRUST_REGISTRY_MISS'

export type CompletenessResult =
  | { status: 'PASS' }
  | { status: 'FAIL'; reasons: CompletenessReason[] }
  | { status: 'NOT_APPLICABLE' }

// Section 14: parser proves structural row validity and (for trust rows) the account
// partition; it cannot prove *unique* trust-master identity without the live registry.
export type TrustResolutionStatus =
  | 'NOT_APPLICABLE'
  | 'STRUCTURALLY_VALID_BUT_TRUST_RESOLUTION_REQUIRED'
  | 'BLOCKED_BY_STRUCTURAL_FAILURE'

export interface ProvisionalTrustRow {
  sectionId: RequiredSectionId
  accountHint: string
  name: string
  code: string
  eval: number
}

export interface SbiPortfolioImportResultV2 {
  contractVersion: typeof SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION
  profileId: typeof SBI_PORTFOLIO_PROFILE_ID | null
  mode: ImportMode
  selectedAssetClasses: AssetClass[] | null
  /** true iff at least one structural (registered or unsupported) section signature was recognized. */
  parsed: boolean
  sections: Record<RequiredSectionId, SectionResult>
  unsupportedSections: UnsupportedSectionResult[]
  rowDiagnostics: RowDiagnosticEntry[]
  /** Position-looking rows encountered with no section open at all (never silently dropped). */
  orphanPositionRowCount: number
  completeness: CompletenessResult
  trustResolution: TrustResolutionStatus
  provisionalTrustRows: ProvisionalTrustRow[]
  provenance: {
    /** Pure text-derived provenance only — this layer does not know the source file name/mtime. */
    explicitSourceTimestamp: ExplicitSourceTimestampResult
  }
}

export interface ParseSbiPortfolioImportV2Options {
  /** @default 'FULL_EXPORT' */
  mode?: ImportMode
  /** Required (non-empty) iff mode === 'PARTIAL_IMPORT'. See section 18. */
  selectedAssetClasses?: AssetClass[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Text normalization primitives (local copies — see file header for why).
// ─────────────────────────────────────────────────────────────────────────────

function normalizeCell(value: string): string {
  return (value ?? '').trim().normalize('NFKC')
}

/** Exact structural signature comparison: NFKC + whitespace-stripped, never substring matching. */
function normalizeSignature(raw: string): string {
  return normalizeCell(raw).replace(/\s+/g, '')
}

// Quote-aware CSV line splitter (copy of importPortfolioCsv.ts's splitCsvLine —
// duplicated deliberately, see file header).
function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  result.push(current.trim())
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Registered column schemas (section 9): exact array-equality matching only.
// Both variants below are evidenced by the current fixture corpus (see
// STOCK_HEADER/TRUST_HEADER vs. makeSanitizedCurrentSbiLayoutFixture() in
// importPortfolioCsv.test.ts) and are each given an explicit schema id.
// ─────────────────────────────────────────────────────────────────────────────

interface ColumnSchema {
  id: string
  assetType: SectionAssetType
  headerCells: string[]
  fieldIndex: { code: number; name: number; eval: number; pnlPct: number; dayPct: number; price: number; acquiredAt: number }
}

const STOCK_SCHEMAS: ColumnSchema[] = [
  {
    id: 'stock-canonical-v1',
    assetType: 'stock',
    headerCells: ['銘柄コード', '銘柄名', '現在値', '評価額', '損益(%)', '前日比(%)', '取得日'],
    fieldIndex: { code: 0, name: 1, price: 2, eval: 3, pnlPct: 4, dayPct: 5, acquiredAt: 6 },
  },
  {
    id: 'stock-sanitized-current-v1',
    assetType: 'stock',
    headerCells: ['評価額', '銘柄名', '前日比(%)', '銘柄コード', '損益(%)', '取得日', '現在値'],
    fieldIndex: { eval: 0, name: 1, dayPct: 2, code: 3, pnlPct: 4, acquiredAt: 5, price: 6 },
  },
]

const TRUST_SCHEMAS: ColumnSchema[] = [
  {
    id: 'trust-canonical-v1',
    assetType: 'trust',
    headerCells: ['ファンド名', '基準価額', '評価額', '損益(%)', '前日比(%)', '取得日'],
    fieldIndex: { code: -1, name: 0, price: 1, eval: 2, pnlPct: 3, dayPct: 4, acquiredAt: 5 },
  },
  {
    id: 'trust-sanitized-current-v1',
    assetType: 'trust',
    headerCells: ['評価額', 'ファンド名', '前日比(%)', '基準価額', '損益(%)', '取得日'],
    fieldIndex: { eval: 0, name: 1, dayPct: 2, price: 3, pnlPct: 4, acquiredAt: 5, code: -1 },
  },
]

function findMatchingSchema(schemas: ColumnSchema[], normalizedCols: string[]): ColumnSchema | null {
  return schemas.find(schema =>
    schema.headerCells.length === normalizedCols.length &&
    schema.headerCells.every((cell, idx) => cell === normalizedCols[idx]),
  ) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 12: numeric authority. Blank / malformed / NaN / infinite must never
// collapse into a silent zero — only a syntactically genuine numeric literal is 'valid'.
// ─────────────────────────────────────────────────────────────────────────────

type NumberOutcome =
  | { kind: 'valid'; value: number }
  | { kind: 'blank' }
  | { kind: 'malformed' }
  | { kind: 'nonFinite' }

function parseAuthoritativeNumber(raw: string): NumberOutcome {
  const normalized = normalizeCell(raw)
    .replace(/,/g, '')
    .replace(/[−―]/g, '-')
  if (!normalized || normalized === '-' || normalized === '--' || normalized.includes('----')) return { kind: 'blank' }
  // Reject partial parses (e.g. "12abc") that Number.parseFloat would happily read as 12 —
  // an authoritative field must be an unambiguous numeric literal, not a fuzzy prefix match.
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return { kind: 'malformed' }
  const value = Number.parseFloat(normalized)
  if (Number.isNaN(value)) return { kind: 'malformed' }
  if (!Number.isFinite(value)) return { kind: 'nonFinite' }
  return { kind: 'valid', value }
}

function evalRejectionReason(outcome: Exclude<NumberOutcome, { kind: 'valid' }>): RowRejectionReason {
  if (outcome.kind === 'blank') return 'INVALID_EVAL_BLANK'
  if (outcome.kind === 'nonFinite') return 'INVALID_EVAL_NON_FINITE'
  return 'INVALID_EVAL_MALFORMED'
}

// Section 13: preserve the existing safe JPX code charset (P4.5-A013-HARDENING-F3) —
// 3 digits + 1 alphanumeric (excluding visually-confusable I/O).
const STOCK_CODE_SEARCH_RE = /\d{3}[0-9A-HJ-NP-Z]/

function extractStockCode(raw: string): string {
  const match = normalizeCell(raw).match(STOCK_CODE_SEARCH_RE)
  return match ? match[0] : ''
}

function cleanupPositionName(raw: string, code: string): string {
  const normalized = normalizeCell(raw)
  return normalized
    .replace(new RegExp(`^${code}\\s*`), '')
    .replace(/^[\-\s]+/, '')
    .trim()
}

interface PositionRowAccepted { accepted: true; code: string; name: string; eval: number }
interface PositionRowRejected { accepted: false; rejectionReason: RowRejectionReason }
type PositionRowOutcome = PositionRowAccepted | PositionRowRejected

function parsePositionRow(assetType: SectionAssetType, normalizedCols: string[], schema: ColumnSchema): PositionRowOutcome {
  const cell = (idx: number) => (idx >= 0 && idx < normalizedCols.length ? normalizedCols[idx] : '')
  const evalOutcome = parseAuthoritativeNumber(cell(schema.fieldIndex.eval))

  if (assetType === 'stock') {
    const codeCell = cell(schema.fieldIndex.code) || cell(schema.fieldIndex.name)
    const code = extractStockCode(codeCell)
    if (!code) return { accepted: false, rejectionReason: 'INVALID_CODE' }
    const name = cleanupPositionName(cell(schema.fieldIndex.name), code)
    if (!name) return { accepted: false, rejectionReason: 'MISSING_NAME' }
    if (evalOutcome.kind !== 'valid') return { accepted: false, rejectionReason: evalRejectionReason(evalOutcome) }
    return { accepted: true, code, name, eval: evalOutcome.value }
  }

  const name = cell(schema.fieldIndex.name)
  if (!name) return { accepted: false, rejectionReason: 'MISSING_NAME' }
  if (evalOutcome.kind !== 'valid') return { accepted: false, rejectionReason: evalRejectionReason(evalOutcome) }
  const code = schema.fieldIndex.code >= 0 ? cell(schema.fieldIndex.code) : ''
  return { accepted: true, code, name, eval: evalOutcome.value }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 15: a recognized-but-out-of-scope or wholly unrecognized position-bearing
// section header. Registered signatures are checked first (see main loop); this only
// fires for section-label-shaped lines that are NOT one of the four registered ones.
// ─────────────────────────────────────────────────────────────────────────────

function detectGenericSectionSignature(normalizedSig: string): { assetType: SectionAssetType; recognizedButOutOfScope: boolean } | null {
  const match = normalizedSig.match(/^(株式|投資信託)\(.+\)$/)
  if (!match) return null
  const assetType: SectionAssetType = match[1] === '株式' ? 'stock' : 'trust'
  // Frozen example (section 15): a non-empty stock credit/margin section must block
  // FULL_EXPORT as UNSUPPORTED_POSITION_SECTION, not be treated as another asset class.
  const recognizedButOutOfScope = normalizedSig.includes('信用')
  return { assetType, recognizedButOutOfScope }
}

function isKnownInformationalLine(firstCellNormalized: string, beforeAnyStructuralSection: boolean): boolean {
  if (beforeAnyStructuralSection) return true // preamble/title/notes ahead of the first recognized section
  const noSpace = firstCellNormalized.replace(/\s/g, '')
  if (!noSpace) return true
  if (noSpace.startsWith('総件数')) return true
  if (noSpace.startsWith('選択範囲')) return true
  if (noSpace.startsWith('ページ')) return true
  if (noSpace === 'ポートフォリオ一覧' || noSpace === '個別表示' || noSpace === 'PTS株価非表示') return true
  return false
}

/** Best-effort fallback heuristic for a line with no section open at all (section 11: never silently drop). */
function looksLikePositionRow(cols: string[]): boolean {
  return cols.length >= 2 && cols.slice(1).some(cell => /\d/.test(cell))
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser: a strict single-pass line-by-line section-state machine.
// ─────────────────────────────────────────────────────────────────────────────

type ParserState =
  | 'SCANNING'
  | 'AWAITING_HEADER'
  | 'OPEN'
  | 'IN_UNSUPPORTED'
  | 'AWAITING_TOTALS_HEADER'
  | 'AWAITING_TOTALS_VALUE'
  | 'AWAITING_GRAND_TOTAL_VALUE'

interface OpenUnsupportedSection {
  label: string
  assetType: SectionAssetType
  recognizedButOutOfScope: boolean
  dataLineCount: number
}

export function parseSbiPortfolioImportV2(
  text: string,
  options: ParseSbiPortfolioImportV2Options = {},
): SbiPortfolioImportResultV2 {
  const mode: ImportMode = options.mode ?? 'FULL_EXPORT'
  if (mode === 'PARTIAL_IMPORT' && (!options.selectedAssetClasses || options.selectedAssetClasses.length === 0)) {
    throw new Error('sbi-portfolio-import-2: PARTIAL_IMPORT requires explicit non-empty selectedAssetClasses')
  }
  const selectedAssetClasses = mode === 'PARTIAL_IMPORT' ? [...options.selectedAssetClasses!] : null

  const rawTextEmpty = text.trim().length === 0
  // Section 4: provenance describes what the CSV text itself proves — nothing more.
  // This layer never throws on an invalid explicit timestamp (unlike importPortfolioCsv());
  // it is a pure description stage and reports the 'invalid' status as evidence instead.
  const explicitSourceTimestamp = extractExplicitSourceTimestamp(text)

  const sections: Record<RequiredSectionId, SectionResult> = {
    JP_STOCK_CUSTODY: absentSection('JP_STOCK_CUSTODY'),
    TRUST_TAXABLE: absentSection('TRUST_TAXABLE'),
    TRUST_NISA_GROWTH: absentSection('TRUST_NISA_GROWTH'),
    TRUST_NISA_ACCUMULATION: absentSection('TRUST_NISA_ACCUMULATION'),
  }
  const unsupportedSections: UnsupportedSectionResult[] = []
  const rowDiagnostics: RowDiagnosticEntry[] = []
  const provisionalTrustRows: ProvisionalTrustRow[] = []
  let orphanPositionRowCount = 0
  let anyStructuralSectionSeen = false

  // All state-machine-relevant mutable fields live on one `ctx` object rather than as
  // bare closured `let`s. TypeScript's control-flow narrowing for a bare `let` that is
  // reassigned inside a nested function declaration (handleScanningLine, closeXxx below)
  // is unreliable — it can under-count which literal values are reachable and narrow a
  // later `state === 'X'` comparison to `never` even though X is genuinely reachable at
  // runtime. Mutating properties of a stable object reference instead is both correct at
  // runtime (identical semantics) and keeps the type checker's narrowing conservative
  // (a property read after a function call is never over-narrowed).
  const ctx: {
    state: ParserState
    pendingHeaderFor: RequiredSectionId | null
    openSectionId: RequiredSectionId | null
    openSchema: ColumnSchema | null
    openAcceptedCount: number
    openRejectedCount: number
    openAcceptedEvalSum: number
    openUnsupported: OpenUnsupportedSection | null
    pendingTotalsFor: RequiredSectionId | null
  } = {
    state: 'SCANNING',
    pendingHeaderFor: null,
    openSectionId: null,
    openSchema: null,
    openAcceptedCount: 0,
    openRejectedCount: 0,
    openAcceptedEvalSum: 0,
    openUnsupported: null,
    pendingTotalsFor: null,
  }
  // Per-section accepted-eval sum, captured at boundary-close time so the totals-value
  // line (seen a line or two later) can reconcile against it (section 10/17).
  const openAcceptedEvalSumBySection: Partial<Record<RequiredSectionId, number>> = {}

  function closeOpenSectionAtBoundary(lineNumber: number) {
    const id = ctx.openSectionId!
    const status: SectionStatus = ctx.openRejectedCount > 0
      ? 'PARSE_FAILED'
      : (ctx.openAcceptedCount === 0 ? 'VALID_EMPTY' : 'VALID_NONEMPTY')
    sections[id] = {
      id,
      status,
      schemaId: ctx.openSchema!.id,
      positionRowCount: ctx.openAcceptedCount + ctx.openRejectedCount,
      acceptedRowCount: ctx.openAcceptedCount,
      rejectedPositionRowCount: ctx.openRejectedCount,
      failureReasons: ctx.openRejectedCount > 0 ? ['REJECTED_ROWS'] : [],
    }
    rowDiagnostics.push({ lineNumber, kind: 'sectionTotal', sectionId: id, unsupportedSectionLabel: null })
    ctx.openSectionId = null
    ctx.openSchema = null
    ctx.state = 'AWAITING_TOTALS_HEADER'
    ctx.pendingTotalsFor = id
  }

  function closeOpenSectionAsTruncated() {
    if (!ctx.openSectionId) return
    const id = ctx.openSectionId
    sections[id] = {
      id,
      status: 'PARSE_FAILED',
      schemaId: ctx.openSchema?.id ?? null,
      positionRowCount: ctx.openAcceptedCount + ctx.openRejectedCount,
      acceptedRowCount: ctx.openAcceptedCount,
      rejectedPositionRowCount: ctx.openRejectedCount,
      failureReasons: ['TRUNCATED'],
    }
    ctx.openSectionId = null
    ctx.openSchema = null
  }

  function closeUnsupportedSection() {
    if (!ctx.openUnsupported) return
    unsupportedSections.push({
      label: ctx.openUnsupported.label,
      assetType: ctx.openUnsupported.assetType,
      recognizedButOutOfScope: ctx.openUnsupported.recognizedButOutOfScope,
      nonEmpty: ctx.openUnsupported.dataLineCount > 0,
      rowCount: ctx.openUnsupported.dataLineCount,
    })
    ctx.openUnsupported = null
  }

  function handleScanningLine(lineNumber: number, line: string, cols: string[], normalizedCols: string[]) {
    const sig = normalizeSignature(line)
    const first = normalizedCols[0] ?? ''

    const matchedRequiredId = REQUIRED_SECTION_IDS.find(id => REQUIRED_SECTION_SIGNATURES[id].label === sig)
    if (matchedRequiredId) {
      anyStructuralSectionSeen = true
      // Pessimistic placeholder: overwritten once the header (or EOF/interruption) resolves it.
      // This guarantees every reachable exit path leaves a correct, non-ABSENT status behind.
      sections[matchedRequiredId] = {
        id: matchedRequiredId,
        status: 'PARSE_FAILED',
        schemaId: null,
        positionRowCount: 0,
        acceptedRowCount: 0,
        rejectedPositionRowCount: 0,
        failureReasons: ['TRUNCATED'],
      }
      rowDiagnostics.push({ lineNumber, kind: 'registeredHeader', sectionId: matchedRequiredId, unsupportedSectionLabel: null })
      ctx.state = 'AWAITING_HEADER'
      ctx.pendingHeaderFor = matchedRequiredId
      return
    }

    const generic = detectGenericSectionSignature(sig)
    if (generic) {
      anyStructuralSectionSeen = true
      rowDiagnostics.push({ lineNumber, kind: 'supportedNonPosition', sectionId: null, unsupportedSectionLabel: sig })
      ctx.openUnsupported = { label: sig, assetType: generic.assetType, recognizedButOutOfScope: generic.recognizedButOutOfScope, dataLineCount: 0 }
      ctx.state = 'IN_UNSUPPORTED'
      return
    }

    if (sig === '総合計') {
      rowDiagnostics.push({ lineNumber, kind: 'grandTotalFooter', sectionId: null, unsupportedSectionLabel: null })
      ctx.state = 'AWAITING_GRAND_TOTAL_VALUE'
      return
    }

    if (isKnownInformationalLine(first, !anyStructuralSectionSeen)) {
      rowDiagnostics.push({ lineNumber, kind: 'registeredInformational', sectionId: null, unsupportedSectionLabel: null })
      return
    }

    if (looksLikePositionRow(cols)) {
      orphanPositionRowCount += 1
      rowDiagnostics.push({ lineNumber, kind: 'rejectedPosition', sectionId: null, unsupportedSectionLabel: null })
      return
    }

    // Genuinely ambiguous content with no open section: tolerate as informational rather
    // than manufacture a false failure over content this Phase 1 profile does not model.
    rowDiagnostics.push({ lineNumber, kind: 'registeredInformational', sectionId: null, unsupportedSectionLabel: null })
  }

  if (!rawTextEmpty) {
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const lineNumber = i + 1
      const line = lines[i].trim()
      if (!line) continue
      const cols = splitCsvLine(line)
      const normalizedCols = cols.map(normalizeCell)
      const sig = normalizeSignature(line)

      if (ctx.state === 'AWAITING_TOTALS_VALUE' && ctx.pendingTotalsFor) {
        const id = ctx.pendingTotalsFor
        const outcome = parseAuthoritativeNumber(normalizedCols[0] ?? '')
        if (outcome.kind === 'valid') {
          const current = sections[id]
          const expectedSum = current.acceptedRowCount === 0 ? 0 : openAcceptedEvalSumBySection[id] ?? 0
          if (Math.abs(outcome.value - expectedSum) > 0.01) {
            sections[id] = { ...current, status: 'PARSE_FAILED', failureReasons: [...new Set([...current.failureReasons, 'TOTAL_MISMATCH' as const])] }
          }
        }
        rowDiagnostics.push({ lineNumber, kind: 'sectionTotal', sectionId: id, unsupportedSectionLabel: null })
        ctx.pendingTotalsFor = null
        ctx.state = 'SCANNING'
        continue
      }

      if (ctx.state === 'AWAITING_TOTALS_HEADER' && ctx.pendingTotalsFor) {
        if ((normalizedCols[0] ?? '') === '評価額') {
          rowDiagnostics.push({ lineNumber, kind: 'sectionTotal', sectionId: ctx.pendingTotalsFor, unsupportedSectionLabel: null })
          ctx.state = 'AWAITING_TOTALS_VALUE'
          continue
        }
        // Not a totals block after all — abandon reconciliation and reprocess this line normally.
        ctx.pendingTotalsFor = null
        ctx.state = 'SCANNING'
        // fall through to SCANNING handling below
      }

      if (ctx.state === 'AWAITING_GRAND_TOTAL_VALUE') {
        rowDiagnostics.push({ lineNumber, kind: 'grandTotalFooter', sectionId: null, unsupportedSectionLabel: null })
        ctx.state = 'SCANNING'
        continue
      }

      if (ctx.state === 'AWAITING_HEADER' && ctx.pendingHeaderFor) {
        const id = ctx.pendingHeaderFor
        const assetType = REQUIRED_SECTION_SIGNATURES[id].assetType
        const schemas = assetType === 'stock' ? STOCK_SCHEMAS : TRUST_SCHEMAS
        const matched = findMatchingSchema(schemas, normalizedCols)
        if (matched) {
          rowDiagnostics.push({ lineNumber, kind: 'registeredHeader', sectionId: id, unsupportedSectionLabel: null })
          ctx.openSectionId = id
          ctx.openSchema = matched
          ctx.openAcceptedCount = 0
          ctx.openRejectedCount = 0
          openAcceptedEvalSumBySection[id] = 0
          ctx.pendingHeaderFor = null
          ctx.state = 'OPEN'
          continue
        }
        // Header never matched a registered schema for this section — section/profile
        // failure (section 20 test 4), NOT VALID_EMPTY. Reprocess this line at top level:
        // it may itself be the next section's start label, or ordinary informational content.
        sections[id] = {
          id,
          status: 'PARSE_FAILED',
          schemaId: null,
          positionRowCount: 0,
          acceptedRowCount: 0,
          rejectedPositionRowCount: 0,
          failureReasons: ['SCHEMA_UNRECOGNIZED'],
        }
        ctx.pendingHeaderFor = null
        ctx.state = 'SCANNING'
        handleScanningLine(lineNumber, line, cols, normalizedCols)
        continue
      }

      if (ctx.state === 'OPEN' && ctx.openSectionId && ctx.openSchema) {
        const id = ctx.openSectionId
        const schema = ctx.openSchema
        const boundaryLabel = `${REQUIRED_SECTION_SIGNATURES[id].label}合計`
        if (sig === boundaryLabel) {
          openAcceptedEvalSumBySection[id] = ctx.openAcceptedEvalSum
          closeOpenSectionAtBoundary(lineNumber)
          ctx.openAcceptedEvalSum = 0
          continue
        }
        const matchedNewRequired = REQUIRED_SECTION_IDS.some(otherId => REQUIRED_SECTION_SIGNATURES[otherId].label === sig)
        const matchedGeneric = detectGenericSectionSignature(sig)
        if (matchedNewRequired || matchedGeneric || sig === '総合計') {
          // This section never reached its own boundary — truncated, not VALID_EMPTY/NONEMPTY.
          closeOpenSectionAsTruncated()
          ctx.openAcceptedEvalSum = 0
          ctx.state = 'SCANNING'
          handleScanningLine(lineNumber, line, cols, normalizedCols)
          continue
        }
        // Ordinary position candidate row — every line inside an open section is classified
        // (section 11: TOLERATED_UNEXPLAINED_POSITION_ROWS = 0).
        const outcome = parsePositionRow(REQUIRED_SECTION_SIGNATURES[id].assetType, normalizedCols, schema)
        if (outcome.accepted) {
          ctx.openAcceptedCount += 1
          ctx.openAcceptedEvalSum += outcome.eval
          rowDiagnostics.push({ lineNumber, kind: 'acceptedPosition', sectionId: id, unsupportedSectionLabel: null })
          if (REQUIRED_SECTION_SIGNATURES[id].assetType === 'trust') {
            provisionalTrustRows.push({
              sectionId: id,
              accountHint: REQUIRED_SECTION_SIGNATURES[id].accountHint,
              name: outcome.name,
              code: outcome.code,
              eval: outcome.eval,
            })
          }
        } else {
          ctx.openRejectedCount += 1
          rowDiagnostics.push({ lineNumber, kind: 'rejectedPosition', sectionId: id, unsupportedSectionLabel: null, rejectionReason: outcome.rejectionReason })
        }
        continue
      }

      if (ctx.state === 'IN_UNSUPPORTED' && ctx.openUnsupported) {
        const openUnsupported = ctx.openUnsupported
        const boundaryLabel = `${openUnsupported.label}合計`
        const matchedNewRequired = REQUIRED_SECTION_IDS.some(otherId => REQUIRED_SECTION_SIGNATURES[otherId].label === sig)
        const matchedGeneric = detectGenericSectionSignature(sig)
        if (sig === boundaryLabel) {
          rowDiagnostics.push({ lineNumber, kind: 'sectionTotal', sectionId: null, unsupportedSectionLabel: openUnsupported.label })
          closeUnsupportedSection()
          ctx.state = 'SCANNING'
          continue
        }
        if (matchedNewRequired || matchedGeneric || sig === '総合計') {
          closeUnsupportedSection()
          ctx.state = 'SCANNING'
          handleScanningLine(lineNumber, line, cols, normalizedCols)
          continue
        }
        const schemas = openUnsupported.assetType === 'stock' ? STOCK_SCHEMAS : TRUST_SCHEMAS
        const isOwnHeader = findMatchingSchema(schemas, normalizedCols) !== null
        if (!isOwnHeader) openUnsupported.dataLineCount += 1
        rowDiagnostics.push({ lineNumber, kind: 'supportedNonPosition', sectionId: null, unsupportedSectionLabel: openUnsupported.label })
        continue
      }

      // SCANNING (default)
      handleScanningLine(lineNumber, line, cols, normalizedCols)
    }

    if (ctx.state === 'OPEN') closeOpenSectionAsTruncated()
    if (ctx.state === 'IN_UNSUPPORTED') closeUnsupportedSection()
  }

  const parsed = anyStructuralSectionSeen
  const profileId = parsed ? SBI_PORTFOLIO_PROFILE_ID : null

  const trustSectionIds: RequiredSectionId[] = ['TRUST_TAXABLE', 'TRUST_NISA_GROWTH', 'TRUST_NISA_ACCUMULATION']
  const anyTrustParseFailed = trustSectionIds.some(id => sections[id].status === 'PARSE_FAILED')
  const anyTrustNonEmpty = trustSectionIds.some(id => sections[id].status === 'VALID_NONEMPTY')
  const trustResolution: TrustResolutionStatus = anyTrustParseFailed
    ? 'BLOCKED_BY_STRUCTURAL_FAILURE'
    : (anyTrustNonEmpty ? 'STRUCTURALLY_VALID_BUT_TRUST_RESOLUTION_REQUIRED' : 'NOT_APPLICABLE')

  const draft = {
    contractVersion: SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION,
    profileId,
    mode,
    selectedAssetClasses,
    parsed,
    sections,
    unsupportedSections,
    rowDiagnostics,
    orphanPositionRowCount,
    trustResolution,
    provisionalTrustRows,
    provenance: { explicitSourceTimestamp },
  } satisfies Omit<SbiPortfolioImportResultV2, 'completeness'>

  const completeness: CompletenessResult = mode === 'PARTIAL_IMPORT'
    ? { status: 'NOT_APPLICABLE' }
    : evaluateFullExportCompleteness(draft, rawTextEmpty)

  return { ...draft, completeness }
}

/**
 * Section 17: pure completeness gate for FULL_EXPORT. Returns exactly PASS or
 * FAIL + a reason set — never invents a false PASS (section 14/28).
 */
export function evaluateFullExportCompleteness(
  result: Omit<SbiPortfolioImportResultV2, 'completeness'>,
  rawTextEmpty = false,
): CompletenessResult {
  if (rawTextEmpty) return { status: 'FAIL', reasons: ['EMPTY_FILE'] }
  if (!result.parsed) return { status: 'FAIL', reasons: ['ZERO_STRUCTURAL_SECTIONS'] }

  const reasons = new Set<CompletenessReason>()

  for (const id of REQUIRED_SECTION_IDS) {
    const section = result.sections[id]
    if (section.status === 'ABSENT') {
      reasons.add('EXPECTED_SECTION_ABSENT')
    } else if (section.status === 'PARSE_FAILED') {
      reasons.add('SECTION_PARSE_FAILED')
      if (section.failureReasons.includes('SCHEMA_UNRECOGNIZED')) reasons.add('SECTION_SCHEMA_UNRECOGNIZED')
      if (section.failureReasons.includes('TRUNCATED')) reasons.add('SECTION_TRUNCATED')
      if (section.failureReasons.includes('TOTAL_MISMATCH')) reasons.add('SECTION_TOTAL_MISMATCH')
    }
  }

  if (result.orphanPositionRowCount > 0) reasons.add('UNEXPLAINED_POSITION_ROW')

  for (const unsupported of result.unsupportedSections) {
    if (!unsupported.nonEmpty) continue
    reasons.add(unsupported.recognizedButOutOfScope ? 'UNSUPPORTED_POSITION_SECTION' : 'UNKNOWN_POSITION_SECTION')
  }

  // Section 14/17: this layer cannot prove unique trust-master identity (no registry
  // input) — a non-empty trust section can never yield a bare FULL_EXPORT PASS here.
  if (result.trustResolution === 'STRUCTURALLY_VALID_BUT_TRUST_RESOLUTION_REQUIRED') {
    reasons.add('TRUST_REGISTRY_MISS')
  }

  if (reasons.size > 0) return { status: 'FAIL', reasons: [...reasons] }
  return { status: 'PASS' }
}
