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

import { extractExplicitSourceTimestamp, KNOWN_CSV_METADATA_LABELS, type ExplicitSourceTimestampResult } from './csvProvenance'

export const SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION = 'sbi-portfolio-import-2' as const
export const SBI_PORTFOLIO_PROFILE_ID = 'sbi-portfolio-v1' as const

export type ImportMode = 'FULL_EXPORT' | 'PARTIAL_IMPORT'
export type AssetClass = 'JP_STOCK' | 'INVESTMENT_TRUST'

export type RequiredSectionId =
  | 'JP_STOCK_CUSTODY'
  | 'TRUST_TAXABLE'
  | 'TRUST_NISA_GROWTH'
  | 'TRUST_NISA_ACCUMULATION'

export const REQUIRED_SECTION_IDS: readonly RequiredSectionId[] = [
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

// OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-02 ticket section 5): DUPLICATE_REQUIRED_SECTION marks a
// second (or later) occurrence of an already-seen required section label — never silently
// overwritten by, nor overwriting, whatever result the first occurrence already established.
export type SectionFailureReason =
  | 'SCHEMA_UNRECOGNIZED' | 'TRUNCATED' | 'REJECTED_ROWS' | 'TOTAL_MISMATCH' | 'DUPLICATE_REQUIRED_SECTION'

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
  // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-02 ticket section 5): a row belonging to a duplicate
  // (second-or-later) occurrence of an already-seen required section. Consumed/discarded —
  // never counted as an accepted/rejected position and never touches `sections[id]`.
  | 'duplicateSectionRow'
  // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02 STRICT PREAMBLE CLASSIFICATION): an unregistered line
  // that is neither an exact known informational signature nor position-row-shaped. Never
  // tolerated as harmless — see isKnownInformationalLine's own comment.
  | 'unknownPreambleLine'

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
  // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-02 ticket section 5): a required section label was seen
  // more than once — a specific, machine-readable reason distinct from the generic
  // SECTION_PARSE_FAILED that also always accompanies it.
  | 'SECTION_DUPLICATE_REQUIRED'
  | 'UNEXPLAINED_POSITION_ROW'
  | 'UNKNOWN_POSITION_SECTION'
  | 'UNSUPPORTED_POSITION_SECTION'
  | 'UNKNOWN_TRUST'
  | 'AMBIGUOUS_TRUST'
  | 'ACCOUNT_MISMATCH'
  | 'TRUST_REGISTRY_MISS'
  // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P2-01 ticket section 7): the grand-total ("総合計") footer's
  // value line never arrived before EOF, or arrived but was not a syntactically valid number.
  // Structural presence/numeric-authority only — this profile does not reconcile the grand total
  // against a cross-section sum (see evaluateFullExportCompleteness's own comment for why).
  | 'GRAND_TOTAL_TRUNCATED'
  | 'GRAND_TOTAL_INVALID'
  // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02 STRICT PREAMBLE CLASSIFICATION): a line that is not an
  // explicitly registered normalized class (blank, known title, known metadata, known
  // count/page-range informational row, or a registered section start) and does not itself
  // look like a position row (which instead raises UNEXPLAINED_POSITION_ROW/UNKNOWN_POSITION_SECTION)
  // is never silently tolerated as harmless — see isKnownInformationalLine's own comment.
  | 'UNKNOWN_PREAMBLE_LINE'

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
  /**
   * OPS-SBI-P2-PREBUILD-PHASE2: best-effort secondary fields, captured purely for the Stage B
   * store-authority value-merge layer (sbiPortfolioAuthorityV2.ts). Unlike `eval`, a malformed/
   * blank cell here never blocks completeness or trust resolution — it degrades to 0/null the
   * same way the legacy importPortfolioCsv.ts parser's non-authoritative fields do.
   */
  price: number
  pnlPct: number
  dayPct: number
  acquiredAt: string | null
}

/**
 * OPS-SBI-P2-PREBUILD-PHASE2: symmetric counterpart of ProvisionalTrustRow for the
 * JP_STOCK_CUSTODY section. Phase 1 deliberately captured only aggregate counts for stock rows
 * (this module never merges/mutates state); Phase 2's staged-diff builder needs the actual
 * accepted-row values, so this is captured the same additive, non-authoritative way as the trust
 * secondary fields above — it changes no existing status/completeness/diagnostic behavior.
 */
export interface ProvisionalStockRow {
  sectionId: 'JP_STOCK_CUSTODY'
  code: string
  name: string
  eval: number
  price: number
  pnlPct: number
  dayPct: number
  acquiredAt: string | null
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
  /** OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02): unregistered, non-position-looking lines — never
   *  silently tolerated merely because they fail the position-row heuristic. See
   *  isKnownInformationalLine's own comment for the exact registered allow-list. */
  unknownPreambleLineCount: number
  /** OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P2-01 ticket section 7): the grand-total ("総合計") footer
   *  label was seen but EOF arrived before its value line. Structural presence only — see
   *  evaluateFullExportCompleteness's own comment on why this profile does not go further. */
  grandTotalTruncated: boolean
  /** The grand-total value line was present but not a syntactically valid numeric literal. */
  grandTotalInvalid: boolean
  completeness: CompletenessResult
  trustResolution: TrustResolutionStatus
  provisionalTrustRows: ProvisionalTrustRow[]
  /** OPS-SBI-P2-PREBUILD-PHASE2: accepted JP_STOCK_CUSTODY rows, additive (see ProvisionalStockRow). */
  provisionalStockRows: ProvisionalStockRow[]
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

// OPS-SBI-P2-PREBUILD-PHASE2: lenient secondary-field parsing (price/pnlPct/dayPct/acquiredAt).
// Deliberately mirrors legacy importPortfolioCsv.ts's parseNum/normalizeDate: unlike `eval`
// (parseAuthoritativeNumber above), a malformed/blank secondary field degrades to 0/null instead
// of rejecting the row — these fields never participate in completeness or trust resolution.
function parseLenientNumber(raw: string): number {
  const normalized = normalizeCell(raw).replace(/,/g, '').replace(/[−―]/g, '-')
  if (!normalized) return 0
  const value = Number.parseFloat(normalized)
  return Number.isFinite(value) ? value : 0
}

function parseLenientDate(raw: string): string | null {
  if (!raw) return null
  const cleaned = normalizeCell(raw)
  if (!cleaned || cleaned.includes('----')) return null
  const match = cleaned.match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/)
  if (!match) return null
  const y = match[1]
  const m = match[2].padStart(2, '0')
  const d = match[3].padStart(2, '0')
  return `${y}-${m}-${d}`
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

interface PositionRowAccepted {
  accepted: true
  code: string
  name: string
  eval: number
  price: number
  pnlPct: number
  dayPct: number
  acquiredAt: string | null
}
interface PositionRowRejected { accepted: false; rejectionReason: RowRejectionReason }
type PositionRowOutcome = PositionRowAccepted | PositionRowRejected

function parsePositionRow(assetType: SectionAssetType, normalizedCols: string[], schema: ColumnSchema): PositionRowOutcome {
  const cell = (idx: number) => (idx >= 0 && idx < normalizedCols.length ? normalizedCols[idx] : '')
  const evalOutcome = parseAuthoritativeNumber(cell(schema.fieldIndex.eval))
  const secondaryFields = {
    price: parseLenientNumber(cell(schema.fieldIndex.price)),
    pnlPct: parseLenientNumber(cell(schema.fieldIndex.pnlPct)),
    dayPct: parseLenientNumber(cell(schema.fieldIndex.dayPct)),
    acquiredAt: parseLenientDate(cell(schema.fieldIndex.acquiredAt)),
  }

  if (assetType === 'stock') {
    const codeCell = cell(schema.fieldIndex.code) || cell(schema.fieldIndex.name)
    const code = extractStockCode(codeCell)
    if (!code) return { accepted: false, rejectionReason: 'INVALID_CODE' }
    const name = cleanupPositionName(cell(schema.fieldIndex.name), code)
    if (!name) return { accepted: false, rejectionReason: 'MISSING_NAME' }
    if (evalOutcome.kind !== 'valid') return { accepted: false, rejectionReason: evalRejectionReason(evalOutcome) }
    return { accepted: true, code, name, eval: evalOutcome.value, ...secondaryFields }
  }

  const name = cell(schema.fieldIndex.name)
  if (!name) return { accepted: false, rejectionReason: 'MISSING_NAME' }
  if (evalOutcome.kind !== 'valid') return { accepted: false, rejectionReason: evalRejectionReason(evalOutcome) }
  const code = schema.fieldIndex.code >= 0 ? cell(schema.fieldIndex.code) : ''
  return { accepted: true, code, name, eval: evalOutcome.value, ...secondaryFields }
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

/** Best-effort fallback heuristic for a line with no section open at all (section 11: never silently drop). */
function looksLikePositionRow(cols: string[]): boolean {
  return cols.length >= 2 && cols.slice(1).some(cell => /\d/.test(cell))
}

// OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02 STRICT PREAMBLE CLASSIFICATION): registered
// "ラベル：値" / "ラベル:値" informational rows only — an exact bare label, or the label
// immediately followed by one of these two colon variants, is accepted; a label with arbitrary
// text glued directly onto it with NO separator (the independent audit's reproduced
// `総件数FAKE,900000,100`) is never accepted as this registered class. This is a fixed,
// enumerable structural signature — not a fuzzy `startsWith` treated as authority over otherwise
// unknown text (the classifier below never falls back to "unknown but harmless").
const KNOWN_COUNT_OR_PAGE_LABELS: readonly string[] = ['総件数', '選択範囲', 'ページ']

function isKnownCountOrPageInformationalLine(noSpace: string): boolean {
  return KNOWN_COUNT_OR_PAGE_LABELS.some(label =>
    noSpace === label || noSpace.startsWith(`${label}：`) || noSpace.startsWith(`${label}:`))
}

// OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02 STRICT PREAMBLE CLASSIFICATION): the frozen root cause
// this replaces — an arbitrary line was inferred "safe" merely because it failed a loose
// position-looking heuristic (`beforeAnyStructuralSection && !looksLikePositionRow`), and a blank
// FIRST cell or a `startsWith` label-prefix match were each independently treated as authority
// over otherwise-unknown text. The independent audit reproduced two concrete escapes:
//   `,900000,100,200`          — blank first cell, but cols[1..] carry real numeric data.
//   `総件数FAKE,900000,100`     — `startsWith('総件数')` accepted arbitrary glued-on text.
// Both must fail. This function now ALLOWS only an explicitly registered normalized class —
// never `startsWith`/`contains`/`!looksLikePositionRow` as authority for unknown text — and is
// applied uniformly (preamble and mid-file): every other line falls through to the
// looksLikePositionRow check (UNEXPLAINED_POSITION_ROW) or, failing that too, becomes
// UNKNOWN_PREAMBLE_LINE. Never confuse "not registered" with "must look like a position row" —
// both outcomes are failures, just distinguished for diagnostics.
function isKnownInformationalLine(firstCellNormalized: string, cols: string[]): boolean {
  const noSpace = firstCellNormalized.replace(/\s/g, '')
  // A truly empty line never reaches here (the caller's `if (!line) continue` already skips it).
  // This covers the comma-noise variant only: EVERY cell blank (e.g. ",,,"). A blank first cell
  // with real data in a later cell (`,900000,100,200`) is deliberately NOT covered here — it
  // falls through to the ordinary looksLikePositionRow check below, exactly like any other row.
  if (cols.every(cell => !normalizeCell(cell))) return true
  if (noSpace === 'ポートフォリオ一覧' || noSpace === '個別表示' || noSpace === 'PTS株価非表示') return true
  // A "label,timestamp" preamble line (データ基準日時 etc. — see csvProvenance.ts's own frozen
  // vocabulary) legitimately has a digit-bearing second cell; it is exact known content, never a
  // position row, regardless of the looksLikePositionRow heuristic below.
  if (KNOWN_CSV_METADATA_LABELS.has(noSpace)) return true
  if (isKnownCountOrPageInformationalLine(noSpace)) return true
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser: a strict single-pass line-by-line section-state machine.
// ─────────────────────────────────────────────────────────────────────────────

// OPS-SBI-P2-PREBUILD-PHASE2-R2-R1 (P2-01 residual closure): states fall into two groups that
// must never be confused with each other:
//
//   REQUIRED-STRUCTURE states — SCANNING / AWAITING_HEADER / OPEN / IN_UNSUPPORTED /
//   IN_DUPLICATE_SECTION. While the state machine is in one of these for a given section, that
//   section's REQUIRED closing boundary (its own "◯◯合計" line) has not yet been proven, and
//   `sections[id]` may not legally read VALID_EMPTY/VALID_NONEMPTY yet — see
//   closeOpenSectionAsTruncated() and the EOF handling below, which fail these closed.
//
//   CLOSED_SECTION_* states — CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_HEADER /
//   CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_VALUE. Entry into either of these is only possible
//   from closeOpenSectionAtBoundary(), i.e. AFTER the section's REQUIRED closing boundary line has
//   already been seen and `sections[id]` has already been finalized (VALID_EMPTY / VALID_NONEMPTY
//   / PARSE_FAILED). These two states exist purely to check for an OPTIONAL trailing
//   "評価額 / 含み損益 / …" summary block that this profile treats as bonus evidence, never as
//   part of the required closing contract (see the module header and closeOpenSectionAtBoundary's
//   own comment). Reaching EOF while in either of these therefore does NOT mean "the required
//   section is still incomplete" — the required section already closed; only the optional summary
//   was left unresolved. (An audit once misread the older name `AWAITING_TOTALS_HEADER` as
//   implying an incomplete REQUIRED state; it was not — the section had already closed — but the
//   name invited that misreading, so it was renamed here to make the state's true meaning
//   unambiguous. An optional summary block that STARTS (its header line matched) but does not
//   finish correctly before EOF, or whose value is malformed, still fails the section — see the
//   CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_VALUE handling below and in-loop.)
type ParserState =
  | 'SCANNING'
  | 'AWAITING_HEADER'
  | 'OPEN'
  | 'IN_UNSUPPORTED'
  | 'CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_HEADER'
  | 'CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_VALUE'
  | 'AWAITING_GRAND_TOTAL_VALUE'
  // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-02 ticket section 5): consuming the body of a duplicate
  // (second-or-later) required-section occurrence — every line is discarded until the next
  // section-starting signature, `sections[duplicateSectionId]` is never touched while here.
  | 'IN_DUPLICATE_SECTION'

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
  const provisionalStockRows: ProvisionalStockRow[] = []
  let orphanPositionRowCount = 0
  let unknownPreambleLineCount = 0
  let anyStructuralSectionSeen = false
  let grandTotalTruncated = false
  let grandTotalInvalid = false
  // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-02 ticket section 5): each required section label may
  // legitimately be seen once. Tracked from the FIRST occurrence's header line onward (not just
  // once fully closed), so a duplicate mid-section (before its own boundary) is caught too.
  const seenRequiredSectionIds = new Set<RequiredSectionId>()

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
    duplicateSectionId: RequiredSectionId | null
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
    duplicateSectionId: null,
  }
  // Per-section accepted-eval sum, captured at boundary-close time so the totals-value
  // line (seen a line or two later) can reconcile against it (section 10/17).
  const openAcceptedEvalSumBySection: Partial<Record<RequiredSectionId, number>> = {}

  // Called only upon seeing this section's own "◯◯合計" line — i.e. its REQUIRED closing
  // boundary has just been proven. `sections[id]` is finalized to a genuine VALID_EMPTY /
  // VALID_NONEMPTY / PARSE_FAILED status right here; nothing that happens afterward (including
  // EOF) can walk that status back to an incomplete/ABSENT one. The CLOSED_SECTION_* state
  // entered below exists solely to look for the OPTIONAL trailing summary block — see the
  // ParserState comment above.
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
    ctx.state = 'CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_HEADER'
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
      if (seenRequiredSectionIds.has(matchedRequiredId)) {
        // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-02 ticket section 5): a duplicate required section.
        // Permanently fail it — merging the DUPLICATE_REQUIRED_SECTION reason into whatever
        // failureReasons the first occurrence already established — and never let this (or any
        // later) occurrence's body overwrite/upgrade sections[id] again. The duplicate's own body
        // is consumed and discarded (IN_DUPLICATE_SECTION), never counted as accepted/rejected
        // positions and never treated as harmless orphan/informational content.
        const existing = sections[matchedRequiredId]
        sections[matchedRequiredId] = {
          ...existing,
          status: 'PARSE_FAILED',
          failureReasons: [...new Set([...existing.failureReasons, 'DUPLICATE_REQUIRED_SECTION' as const])],
        }
        rowDiagnostics.push({ lineNumber, kind: 'duplicateSectionRow', sectionId: matchedRequiredId, unsupportedSectionLabel: null })
        ctx.state = 'IN_DUPLICATE_SECTION'
        ctx.duplicateSectionId = matchedRequiredId
        return
      }
      seenRequiredSectionIds.add(matchedRequiredId)
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

    if (isKnownInformationalLine(first, cols)) {
      rowDiagnostics.push({ lineNumber, kind: 'registeredInformational', sectionId: null, unsupportedSectionLabel: null })
      return
    }

    if (looksLikePositionRow(cols)) {
      orphanPositionRowCount += 1
      rowDiagnostics.push({ lineNumber, kind: 'rejectedPosition', sectionId: null, unsupportedSectionLabel: null })
      return
    }

    // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02): an unregistered line that also does not look like
    // a position row is no longer assumed harmless — fail closed rather than manufacture a false
    // PASS over content this profile cannot prove safe (UNKNOWN_PREAMBLE_LINE).
    unknownPreambleLineCount += 1
    rowDiagnostics.push({ lineNumber, kind: 'unknownPreambleLine', sectionId: null, unsupportedSectionLabel: null })
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

      if (ctx.state === 'CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_VALUE' && ctx.pendingTotalsFor) {
        const id = ctx.pendingTotalsFor
        const outcome = parseAuthoritativeNumber(normalizedCols[0] ?? '')
        if (outcome.kind === 'valid') {
          const current = sections[id]
          const expectedSum = current.acceptedRowCount === 0 ? 0 : openAcceptedEvalSumBySection[id] ?? 0
          if (Math.abs(outcome.value - expectedSum) > 0.01) {
            sections[id] = { ...current, status: 'PARSE_FAILED', failureReasons: [...new Set([...current.failureReasons, 'TOTAL_MISMATCH' as const])] }
          }
        } else {
          // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P2-01 ticket section 7): an OPTIONAL summary block
          // that committed to providing a reconciliation value (its header already matched) must
          // not silently pass when that value is blank/malformed/non-finite — it can never
          // reconcile because it is not even a comparable number. An optional block that STARTS
          // must be internally complete (section 4): starting it and then failing to deliver a
          // valid value is illegal, even though never starting it at all remains legal. Reuses
          // TOTAL_MISMATCH (a blank/malformed total trivially fails to reconcile) rather than
          // inventing a second, redundant reason.
          const current = sections[id]
          sections[id] = { ...current, status: 'PARSE_FAILED', failureReasons: [...new Set([...current.failureReasons, 'TOTAL_MISMATCH' as const])] }
        }
        rowDiagnostics.push({ lineNumber, kind: 'sectionTotal', sectionId: id, unsupportedSectionLabel: null })
        ctx.pendingTotalsFor = null
        ctx.state = 'SCANNING'
        continue
      }

      if (ctx.state === 'CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_HEADER' && ctx.pendingTotalsFor) {
        if ((normalizedCols[0] ?? '') === '評価額') {
          rowDiagnostics.push({ lineNumber, kind: 'sectionTotal', sectionId: ctx.pendingTotalsFor, unsupportedSectionLabel: null })
          ctx.state = 'CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_VALUE'
          continue
        }
        // Not an optional summary block after all — abandon reconciliation and reprocess this
        // line normally. (Frozen, deliberate: the 2-line summary block is optional bonus evidence,
        // never a required part of "recognized matching 合計/end boundary" — see the module header
        // and test 2/10's own comments. `sections[id]` was already finalized as the REQUIRED
        // closing boundary was already proven back in closeOpenSectionAtBoundary(); nothing here
        // reopens or downgrades it. EOF while still in this state is exactly this same case — the
        // optional summary was simply never offered — and must stay VALID_EMPTY/VALID_NONEMPTY,
        // not be downgraded; see the EOF handling below, which deliberately does nothing for this
        // state.)
        ctx.pendingTotalsFor = null
        ctx.state = 'SCANNING'
        // fall through to SCANNING handling below
      }

      if (ctx.state === 'AWAITING_GRAND_TOTAL_VALUE') {
        // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P2-01 ticket section 7/8): structural presence +
        // basic numeric authority only — this profile does not reconcile the grand total against
        // a cross-section sum (no established contract for what exactly it should sum over ABSENT
        // sections; inventing one here would be exactly the "wide tolerance" section 8 forbids).
        // A malformed/blank value is still evidence worth surfacing (GRAND_TOTAL_INVALID) rather
        // than silently accepted.
        if (parseAuthoritativeNumber(normalizedCols[0] ?? '').kind !== 'valid') grandTotalInvalid = true
        rowDiagnostics.push({ lineNumber, kind: 'grandTotalFooter', sectionId: null, unsupportedSectionLabel: null })
        ctx.state = 'SCANNING'
        continue
      }

      if (ctx.state === 'IN_DUPLICATE_SECTION' && ctx.duplicateSectionId) {
        const duplicateId = ctx.duplicateSectionId
        const matchedNewRequired = REQUIRED_SECTION_IDS.some(otherId => REQUIRED_SECTION_SIGNATURES[otherId].label === sig)
        const matchedGeneric = detectGenericSectionSignature(sig)
        const boundaryLabel = `${REQUIRED_SECTION_SIGNATURES[duplicateId].label}合計`
        if (matchedNewRequired || matchedGeneric || sig === '総合計') {
          ctx.duplicateSectionId = null
          ctx.state = 'SCANNING'
          handleScanningLine(lineNumber, line, cols, normalizedCols)
          continue
        }
        // Everything else — including the duplicate's own header/rows/boundary total line — is
        // discarded evidence-only; sections[duplicateId] was already permanently fixed above.
        rowDiagnostics.push({
          lineNumber,
          kind: 'duplicateSectionRow',
          sectionId: duplicateId,
          unsupportedSectionLabel: sig === boundaryLabel ? boundaryLabel : null,
        })
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
              price: outcome.price,
              pnlPct: outcome.pnlPct,
              dayPct: outcome.dayPct,
              acquiredAt: outcome.acquiredAt,
            })
          } else {
            provisionalStockRows.push({
              sectionId: 'JP_STOCK_CUSTODY',
              code: outcome.code,
              name: outcome.name,
              eval: outcome.eval,
              price: outcome.price,
              pnlPct: outcome.pnlPct,
              dayPct: outcome.dayPct,
              acquiredAt: outcome.acquiredAt,
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
    // OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P2-01 ticket section 7): EOF while an OPTIONAL summary
    // block that already committed to a value (its header line matched) never delivered that
    // value is a genuine truncation — downgrade the section sections[id] already recorded at
    // boundary-close time. Unlike CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_HEADER (no optional
    // summary block ever offered — frozen as fine, see that branch's own comment), this state is
    // unreachable without the header line having already matched, so there is no "never offered"
    // ambiguity to preserve here.
    if (ctx.state === 'CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_VALUE' && ctx.pendingTotalsFor) {
      const id = ctx.pendingTotalsFor
      const current = sections[id]
      sections[id] = { ...current, status: 'PARSE_FAILED', failureReasons: [...new Set([...current.failureReasons, 'TRUNCATED' as const])] }
    }
    // OPS-SBI-P2-PREBUILD-PHASE2-R2-R1 (P2-01 residual closure): deliberately no branch for
    // CLOSED_SECTION_AWAITING_OPTIONAL_SUMMARY_HEADER here. Reaching EOF in that state means the
    // section's REQUIRED closing boundary was already proven (closeOpenSectionAtBoundary already
    // ran and finalized sections[id]) and the OPTIONAL summary block simply was never offered —
    // exactly as legal as never offering it at all. There is nothing to downgrade.
    // EOF after the grand-total footer label but before its value line ever arrived.
    if (ctx.state === 'AWAITING_GRAND_TOTAL_VALUE') grandTotalTruncated = true
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
    unknownPreambleLineCount,
    grandTotalTruncated,
    grandTotalInvalid,
    trustResolution,
    provisionalTrustRows,
    provisionalStockRows,
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
      if (section.failureReasons.includes('DUPLICATE_REQUIRED_SECTION')) reasons.add('SECTION_DUPLICATE_REQUIRED')
    }
  }

  if (result.orphanPositionRowCount > 0) reasons.add('UNEXPLAINED_POSITION_ROW')
  if (result.unknownPreambleLineCount > 0) reasons.add('UNKNOWN_PREAMBLE_LINE')
  if (result.grandTotalTruncated) reasons.add('GRAND_TOTAL_TRUNCATED')
  if (result.grandTotalInvalid) reasons.add('GRAND_TOTAL_INVALID')

  for (const unsupported of result.unsupportedSections) {
    if (!unsupported.nonEmpty) continue
    reasons.add(unsupported.recognizedButOutOfScope ? 'UNSUPPORTED_POSITION_SECTION' : 'UNKNOWN_POSITION_SECTION')
  }

  // Section 14/17: this layer cannot prove unique trust-master identity (no registry
  // input) — a non-empty trust section can never yield a bare FULL_EXPORT PASS here.
  // (sbiPortfolioAuthorityV2.ts's evaluateFinalFullExportAuthority strips this specific
  // reason back out once Stage B has independently proven trust identity against the live
  // registry — see that function's comment.)
  if (result.trustResolution === 'STRUCTURALLY_VALID_BUT_TRUST_RESOLUTION_REQUIRED') {
    reasons.add('TRUST_REGISTRY_MISS')
  }

  if (reasons.size > 0) return { status: 'FAIL', reasons: [...reasons] }
  return { status: 'PASS' }
}
