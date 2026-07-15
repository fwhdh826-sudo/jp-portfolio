import type {
  CsvImportProvenance,
  CsvSourceAsOfConfidence,
  CsvSourceAsOfKind,
  CsvSourceProvenance,
} from '../../types'
import { parseStrictTimestamp, normalizeStrictTimestamp } from '../../utils/strictTimestamp'
import {
  fingerprintLegacyCsvSemanticContent,
  identifyCsvSemanticContent,
} from './csvSemanticIdentity'

const AUTHORITATIVE_LABELS = new Set([
  'データ基準日時',
  'データ基準日',
  'スナップショット日時',
  'スナップショット時点',
])
const WEAK_EXPORT_LABELS = new Set(['出力日時', 'エクスポート日時', 'ダウンロード日時', '作成日時'])

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').replace(/^\uFEFF/, '').trim().replace(/\s+/g, '')
}

function parseMetadataLine(line: string): [string, string] | null {
  const separator = line.includes('\t') ? '\t' : ','
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else quoted = !quoted
    } else if (char === separator && !quoted) {
      parts.push(current.trim())
      current = ''
    } else current += char
  }
  parts.push(current.trim())
  if (parts.length < 2) return null
  return [normalizeLabel(parts[0] ?? ''), parts[1] ?? '']
}

function normalizeTimestamp(value: string): string | null {
  const raw = value.normalize('NFKC').trim()
  return normalizeStrictTimestamp(raw, { allowDateOnly: true })
}

interface ExtractedTimestamp {
  sourceAsOf: string
  sourceAsOfKind: CsvSourceAsOfKind
  sourceAsOfConfidence: CsvSourceAsOfConfidence
}

export type ExplicitSourceTimestampResult =
  | { status: 'absent' }
  | { status: 'valid'; value: ExtractedTimestamp }
  | { status: 'invalid'; rawValue: string; reason: 'invalid_timestamp' }

export class InvalidCsvSourceTimestampError extends Error {
  readonly code = 'INVALID_CSV_SOURCE_TIMESTAMP' as const
  readonly reason = 'invalid_timestamp' as const

  constructor(readonly rawValue: string) {
    super('recognized authoritative CSV timestamp is invalid')
    this.name = 'InvalidCsvSourceTimestampError'
  }
}

export function extractExplicitSourceTimestamp(text: string): ExplicitSourceTimestampResult {
  let valid: ExtractedTimestamp | null = null
  for (const line of text.split(/\r?\n/)) {
    const metadata = parseMetadataLine(line.trim())
    if (!metadata) continue
    const [label, rawTimestamp] = metadata
    if (!AUTHORITATIVE_LABELS.has(label)) continue
    const timestamp = normalizeTimestamp(rawTimestamp)
    if (!timestamp) {
      return { status: 'invalid', rawValue: rawTimestamp.normalize('NFKC').trim(), reason: 'invalid_timestamp' }
    }
    if (valid === null) {
      valid = {
        sourceAsOf: timestamp,
        sourceAsOfKind: 'csv_explicit',
        sourceAsOfConfidence: 'authoritative',
      }
    }
  }
  return valid === null ? { status: 'absent' } : { status: 'valid', value: valid }
}

function extractWeakStructuredTimestamp(text: string): ExtractedTimestamp | null {
  let weak: ExtractedTimestamp | null = null
  for (const line of text.split(/\r?\n/)) {
    const metadata = parseMetadataLine(line.trim())
    if (!metadata) continue
    const [label, rawTimestamp] = metadata
    if (!WEAK_EXPORT_LABELS.has(label)) continue
    const timestamp = normalizeTimestamp(rawTimestamp)
    if (timestamp && weak === null) {
      weak = {
        sourceAsOf: timestamp,
        sourceAsOfKind: 'csv_exported_at',
        sourceAsOfConfidence: 'weak',
      }
    }
  }
  return weak
}

function extractFilenameTimestamp(fileName: string): string | null {
  const normalized = fileName.normalize('NFKC')
  const match = normalized.match(/(?:^|[^\d])(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[T_ -]?([0-2]\d)[-_:]?([0-5]\d)(?:[-_:]?([0-5]\d))?)?(?:[^\d]|$)/)
  if (!match) return null
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match
  return normalizeTimestamp(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`)
}

/** Legacy compatibility checksum. Duplicate identity must never depend on this value alone. */
export function fingerprintCsvSemanticContent(value: unknown): string {
  return fingerprintLegacyCsvSemanticContent(value)
}

export function buildCsvSourceProvenance(input: {
  text: string
  fileName: string
  fileLastModified: number
  semanticContent: unknown
}): CsvSourceProvenance {
  const explicit = extractExplicitSourceTimestamp(input.text)
  if (explicit.status === 'invalid') throw new InvalidCsvSourceTimestampError(explicit.rawValue)
  const structured = explicit.status === 'valid' ? explicit.value : extractWeakStructuredTimestamp(input.text)
  let fileLastModified: string | null = null
  if (Number.isFinite(input.fileLastModified) && input.fileLastModified > 0) {
    const fileDate = new Date(input.fileLastModified)
    if (Number.isFinite(fileDate.getTime())) fileLastModified = fileDate.toISOString()
  }
  const filenameTimestamp = extractFilenameTimestamp(input.fileName)
  const selected = structured ?? (filenameTimestamp
    ? { sourceAsOf: filenameTimestamp, sourceAsOfKind: 'filename' as const, sourceAsOfConfidence: 'weak' as const }
    : fileLastModified
      ? { sourceAsOf: fileLastModified, sourceAsOfKind: 'file_last_modified' as const, sourceAsOfConfidence: 'weak' as const }
      : { sourceAsOf: null, sourceAsOfKind: 'unknown' as const, sourceAsOfConfidence: 'unknown' as const })

  return {
    ...selected,
    contentFingerprint: fingerprintCsvSemanticContent(input.semanticContent),
    semanticIdentity: identifyCsvSemanticContent(input.semanticContent),
    sourceFileName: input.fileName || null,
    fileLastModified,
  }
}

export type CsvImportMonotonicityDecision =
  | 'ALLOW_FIRST_IMPORT'
  | 'ALLOW_NEWER'
  | 'ALLOW_FIRST_KNOWN'
  | 'DUPLICATE'
  | 'REJECT_STALE'
  | 'REJECT_CONFLICT'
  | 'REJECT_UNKNOWN_DOWNGRADE'

export function evaluateCsvImportMonotonicity(input: {
  incoming: CsvImportProvenance
  current: CsvImportProvenance | null
  currentGenerationExists: boolean
}): { decision: CsvImportMonotonicityDecision } {
  const { incoming, current, currentGenerationExists } = input
  if (!currentGenerationExists) return { decision: 'ALLOW_FIRST_IMPORT' }
  // FNV-only canonical v2 values remain valid legacy state, but cannot prove equality. They
  // migrate only through a normal allowed replacement (for example a newer authoritative CSV).
  const sameContent = current !== null &&
    incoming.semanticIdentity !== undefined &&
    current.semanticIdentity !== undefined &&
    incoming.semanticIdentity === current.semanticIdentity

  const incomingAuthoritative = incoming.sourceAsOfConfidence === 'authoritative' && incoming.sourceAsOf !== null
  const currentAuthoritative = current?.sourceAsOfConfidence === 'authoritative' && current.sourceAsOf !== null

  if (incomingAuthoritative && currentAuthoritative && current) {
    const incomingTime = parseStrictTimestamp(incoming.sourceAsOf!)?.epochMs
    const currentTime = parseStrictTimestamp(current.sourceAsOf!)?.epochMs
    if (incomingTime === undefined || currentTime === undefined) return { decision: 'REJECT_CONFLICT' }
    if (incomingTime > currentTime) return { decision: 'ALLOW_NEWER' }
    if (incomingTime < currentTime) return { decision: sameContent ? 'DUPLICATE' : 'REJECT_STALE' }
    return { decision: sameContent ? 'DUPLICATE' : 'REJECT_CONFLICT' }
  }
  if (incomingAuthoritative && !currentAuthoritative) return { decision: 'ALLOW_FIRST_KNOWN' }
  if (sameContent) {
    // Copying/renaming the same semantic CSV can change weak file metadata. A metadata downgrade
    // or an older identical snapshot preserves the current (stronger/newer) provenance as a no-op.
    return { decision: 'DUPLICATE' }
  }
  if (!incomingAuthoritative && currentAuthoritative) return { decision: 'REJECT_UNKNOWN_DOWNGRADE' }

  // Weak/unknown timestamps are retained for provenance display but never authorize a silent
  // overwrite. In particular, import operation time and a freshly copied file's mtime are not
  // evidence that the portfolio snapshot itself is newer.
  return { decision: 'REJECT_UNKNOWN_DOWNGRADE' }
}
