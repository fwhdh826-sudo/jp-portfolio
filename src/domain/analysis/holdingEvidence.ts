// ═══════════════════════════════════════════════════════════
// HOLDING-EVIDENCE-1: holding_evidence.json の pure runtime validator と
// ephemeral evidence join。
//
//   state.holdings + state.holdingEvidence
//     → joinHoldingEvidence(holdings, artifact, nowMs)
//     → enriched holdings（analysis 入力専用・非永続）
//     → computeAnalysis(...)
//
// 原則:
//  - この module は Zustand / localStorage / network に一切触れない。
//  - Date.now() を内部固定使用しない（nowMs を注入する）。
//  - throw しない（getter-throwing object 等は失敗結果へ変換）。
//  - published evidence 由来の known / 数値は Holding へ書き戻さない
//    （呼び出し側は enriched 配列を analysis 入力としてのみ使う）。
//  - artifact 不在 / invalid / stale / identity mismatch は「NO EVIDENCE」であり
//    「NEGATIVE EVIDENCE」ではない（§9）。該当 group は unknown へ倒し、
//    数値は Holding 既存値のまま残す。
// ═══════════════════════════════════════════════════════════

import type { Holding, MetadataProvenance } from '../../types'
import { STOCK_CODE_FULL_RE } from '../csv/importPortfolioCsv'
import {
  HOLDING_EVIDENCE_FUNDAMENTALS_FIELDS,
  HOLDING_EVIDENCE_FUNDAMENTALS_TTL_MS,
  HOLDING_EVIDENCE_KIND,
  HOLDING_EVIDENCE_MARKET,
  HOLDING_EVIDENCE_MIN_TECHNICAL_BARS,
  HOLDING_EVIDENCE_NEUTRAL_DE,
  HOLDING_EVIDENCE_NOT_APPLICABLE_FIELDS,
  HOLDING_EVIDENCE_PIPELINE_TTL_MS,
  HOLDING_EVIDENCE_SCHEMA_VERSION,
  HOLDING_EVIDENCE_TECHNICALS_FIELDS,
  HOLDING_EVIDENCE_TECHNICALS_TTL_MS,
} from '../../types/holdingEvidence'
import type {
  HoldingAnalysisEvidence,
  HoldingEvidenceArtifact,
  HoldingEvidenceEntry,
  HoldingEvidenceField,
  HoldingEvidenceFundamentalsGroup,
  HoldingEvidenceGroupResolution,
  HoldingEvidenceJoinState,
  HoldingEvidenceReason,
  HoldingEvidenceTechnicalsGroup,
} from '../../types/holdingEvidence'

// ── primitive guards ─────────────────────────────────────────
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isFieldStatus(value: unknown): value is HoldingEvidenceField['status'] {
  return value === 'present' || value === 'missing' || value === 'not_applicable'
}

function isEvidenceField(value: unknown): value is HoldingEvidenceField {
  if (!isPlainObject(value)) return false
  if (!isFieldStatus(value.status)) return false
  const v = value.v
  return v === null || typeof v === 'boolean' || isFiniteNumber(v)
}

// ── parser ───────────────────────────────────────────────────
export type HoldingEvidenceParseFailureCode =
  | 'malformed_root'
  | 'invalid_schema'
  | 'privacy_violation'
  | 'invalid_meta'
  | 'invalid_entries'
  | 'unknown'

export type HoldingEvidenceParseResult =
  | { ok: true; data: HoldingEvidenceArtifact }
  | { ok: false; code: HoldingEvidenceParseFailureCode }

function fail(code: HoldingEvidenceParseFailureCode): HoldingEvidenceParseResult {
  return { ok: false, code }
}

function validateFieldMap(value: unknown, keys: readonly string[]): boolean {
  if (!isPlainObject(value)) return false
  const own = Object.keys(value)
  if (own.length !== keys.length) return false
  return keys.every((key) => isEvidenceField(value[key]))
}

function validateFundamentalsGroup(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (
    isValidTimestamp(value.asOf) &&
    typeof value.source === 'string' &&
    validateFieldMap(value.fields, HOLDING_EVIDENCE_FUNDAMENTALS_FIELDS)
  )
}

function validateTechnicalsGroup(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return (
    isValidTimestamp(value.asOf) &&
    typeof value.source === 'string' &&
    isFiniteNumber(value.bars) &&
    value.bars >= 0 &&
    validateFieldMap(value.fields, HOLDING_EVIDENCE_TECHNICALS_FIELDS)
  )
}

function validateEntry(value: unknown): value is HoldingEvidenceEntry {
  if (!isPlainObject(value)) return false
  return (
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.ticker) &&
    value.market === HOLDING_EVIDENCE_MARKET &&
    validateFundamentalsGroup(value.fundamentals) &&
    validateTechnicalsGroup(value.technicals)
  )
}

function doParse(input: unknown): HoldingEvidenceParseResult {
  if (!isPlainObject(input)) return fail('malformed_root')
  if (input.schemaVersion !== HOLDING_EVIDENCE_SCHEMA_VERSION) return fail('invalid_schema')
  if (input.not_for_trading !== true) return fail('privacy_violation')

  const meta = input._meta
  if (!isPlainObject(meta)) return fail('invalid_meta')
  if (meta.kind !== HOLDING_EVIDENCE_KIND) return fail('invalid_meta')
  if (meta.schemaVersion !== HOLDING_EVIDENCE_SCHEMA_VERSION) return fail('invalid_meta')
  if (meta.not_for_trading !== true) return fail('invalid_meta')
  if (!isValidTimestamp(meta.generatedAt)) return fail('invalid_meta')

  if (!Array.isArray(input.entries)) return fail('invalid_entries')
  if (!input.entries.every(validateEntry)) return fail('invalid_entries')

  return { ok: true, data: input as unknown as HoldingEvidenceArtifact }
}

export function parseHoldingEvidenceArtifact(input: unknown): HoldingEvidenceParseResult {
  try {
    return doParse(input)
  } catch {
    return fail('unknown')
  }
}

// ── pipeline 鮮度（dataSourceStatus 用にも再利用）─────────────
export type HoldingEvidencePipelineFreshness = 'fresh' | 'future' | 'stale'

export function evaluateHoldingEvidencePipelineFreshness(
  artifact: HoldingEvidenceArtifact,
  nowMs: number,
): HoldingEvidencePipelineFreshness {
  const generatedMs = Date.parse(artifact._meta.generatedAt)
  if (!Number.isFinite(generatedMs)) return 'stale'
  if (generatedMs > nowMs) return 'future'
  if (nowMs - generatedMs > HOLDING_EVIDENCE_PIPELINE_TTL_MS) return 'stale'
  return 'fresh'
}

export function isHoldingEvidencePipelineFresh(
  artifact: HoldingEvidenceArtifact,
  nowMs: number,
): boolean {
  return evaluateHoldingEvidencePipelineFreshness(artifact, nowMs) === 'fresh'
}

// ── group resolution ─────────────────────────────────────────
interface GroupResolution {
  status: MetadataProvenance
  reason: HoldingEvidenceReason
  /** known のときに ephemeral holding へ書き込む値（reason='ok'） */
  values: Record<string, number | boolean> | null
}

function unknownGroup(reason: HoldingEvidenceReason): GroupResolution {
  return { status: 'unknown', reason, values: null }
}

function resolveGroupAsOf(asOf: string, nowMs: number, ttlMs: number): HoldingEvidenceReason | null {
  const asOfMs = Date.parse(asOf)
  if (!Number.isFinite(asOfMs)) return 'stale_group'
  if (asOfMs > nowMs) return 'future_asof'
  if (nowMs - asOfMs > ttlMs) return 'stale_group'
  return null
}

function fieldValueValid(field: HoldingEvidenceField, expectBoolean: boolean): boolean {
  return expectBoolean ? typeof field.v === 'boolean' : isFiniteNumber(field.v)
}

const BOOLEAN_FUNDAMENTALS_FIELDS: ReadonlySet<string> = new Set(['cfOk'])
const BOOLEAN_TECHNICALS_FIELDS: ReadonlySet<string> = new Set(['ma', 'macd', 'vol'])

function resolveFundamentals(group: HoldingEvidenceFundamentalsGroup, nowMs: number): GroupResolution {
  const asOfReason = resolveGroupAsOf(group.asOf, nowMs, HOLDING_EVIDENCE_FUNDAMENTALS_TTL_MS)
  if (asOfReason) return unknownGroup(asOfReason)

  const values: Record<string, number | boolean> = {}
  for (const key of HOLDING_EVIDENCE_FUNDAMENTALS_FIELDS) {
    const field = group.fields[key]
    if (field.status === 'missing') return unknownGroup('partial_fields')
    if (field.status === 'not_applicable') {
      // de のみ契約上許容。それ以外は group=unknown（§7-8）。
      if (!HOLDING_EVIDENCE_NOT_APPLICABLE_FIELDS.has(key)) return unknownGroup('invalid_not_applicable')
      values[key] = HOLDING_EVIDENCE_NEUTRAL_DE
      continue
    }
    const expectBoolean = BOOLEAN_FUNDAMENTALS_FIELDS.has(key)
    if (!fieldValueValid(field, expectBoolean)) return unknownGroup('partial_fields')
    values[key] = field.v as number | boolean
  }
  return { status: 'known', reason: 'ok', values }
}

function resolveTechnicals(group: HoldingEvidenceTechnicalsGroup, nowMs: number): GroupResolution {
  const asOfReason = resolveGroupAsOf(group.asOf, nowMs, HOLDING_EVIDENCE_TECHNICALS_TTL_MS)
  if (asOfReason) return unknownGroup(asOfReason)
  if (!(group.bars >= HOLDING_EVIDENCE_MIN_TECHNICAL_BARS)) return unknownGroup('insufficient_bars')

  const values: Record<string, number | boolean> = {}
  for (const key of HOLDING_EVIDENCE_TECHNICALS_FIELDS) {
    const field = group.fields[key]
    if (field.status === 'missing') return unknownGroup('partial_fields')
    // technicals では not_applicable を許容しない（§7-8）
    if (field.status === 'not_applicable') return unknownGroup('invalid_not_applicable')
    const expectBoolean = BOOLEAN_TECHNICALS_FIELDS.has(key)
    if (!fieldValueValid(field, expectBoolean)) return unknownGroup('partial_fields')
    values[key] = field.v as number | boolean
  }
  return { status: 'known', reason: 'ok', values }
}

// ── join ─────────────────────────────────────────────────────
export interface JoinHoldingEvidenceResult {
  /** analysis 入力専用の enriched holdings（非永続） */
  holdings: Holding[]
  /** code → effective evidence 状態 */
  states: Map<string, HoldingEvidenceJoinState>
}

function persistedResolution(h: Holding, group: 'fundamentals' | 'technicals'): HoldingEvidenceGroupResolution {
  return {
    status: h.metadataStatus?.[group] === 'known' ? 'known' : 'unknown',
    reason: 'no_artifact',
  }
}

function persistedState(h: Holding, reason: HoldingEvidenceReason): HoldingEvidenceJoinState {
  const fundamentals: HoldingEvidenceGroupResolution = { ...persistedResolution(h, 'fundamentals'), reason }
  const technicals: HoldingEvidenceGroupResolution = { ...persistedResolution(h, 'technicals'), reason }
  return { code: h.code, source: 'persisted', fundamentals, technicals, authoritative: false }
}

/**
 * state.holdings と holding_evidence artifact を pure に join する。
 * origin 非依存: legacy v81 / canonical CSV / snapshot 復元 / 将来 schema の
 * いずれの Holding でも同一の runtime enrichment logic を通す。
 */
export function joinHoldingEvidence(
  holdings: Holding[],
  artifact: HoldingEvidenceArtifact | null | undefined,
  nowMs: number,
): JoinHoldingEvidenceResult {
  const states = new Map<string, HoldingEvidenceJoinState>()

  // artifact 不在 / null → 全 holding は自身の persisted metadataStatus のまま。
  if (!artifact) {
    const out = holdings.map((h) => {
      states.set(h.code, persistedState(h, 'no_artifact'))
      return h
    })
    return { holdings: out, states }
  }

  const pipelineFreshness = evaluateHoldingEvidencePipelineFreshness(artifact, nowMs)

  const out = holdings.map((h) => {
    const matches = artifact.entries.filter((e) => e.code === h.code)

    // このコードを扱う entry が無い → NO EVIDENCE。persisted のまま。
    if (matches.length === 0) {
      states.set(h.code, persistedState(h, 'no_entry'))
      return h
    }

    // 同一コードの entry が複数 → 曖昧。fail-closed で unknown。
    if (matches.length > 1) {
      const res: HoldingEvidenceGroupResolution = { status: 'unknown', reason: 'ambiguous_entry' }
      states.set(h.code, {
        code: h.code, source: 'artifact',
        fundamentals: res, technicals: { ...res }, authoritative: false,
      })
      return h
    }

    const entry = matches[0]

    // identity 厳密一致（§7-4）: canonical JP code / ticker=`${code}.T` / market=TSE
    const identityOk =
      STOCK_CODE_FULL_RE.test(h.code) &&
      entry.ticker === `${h.code}.T` &&
      entry.market === HOLDING_EVIDENCE_MARKET
    if (!identityOk) {
      const res: HoldingEvidenceGroupResolution = { status: 'unknown', reason: 'identity_mismatch' }
      states.set(h.code, {
        code: h.code, source: 'artifact',
        fundamentals: res, technicals: { ...res }, authoritative: false,
      })
      return h
    }

    // pipeline TTL（§7-3）
    if (pipelineFreshness !== 'fresh') {
      const reason: HoldingEvidenceReason = pipelineFreshness === 'future' ? 'future_pipeline' : 'stale_pipeline'
      const res: HoldingEvidenceGroupResolution = { status: 'unknown', reason }
      states.set(h.code, {
        code: h.code, source: 'artifact',
        fundamentals: res, technicals: { ...res }, authoritative: false,
      })
      return h
    }

    const fRes = resolveFundamentals(entry.fundamentals, nowMs)
    const tRes = resolveTechnicals(entry.technicals, nowMs)

    let enriched: Holding = {
      ...h,
      metadataStatus: { fundamentals: fRes.status, technicals: tRes.status },
    }
    if (fRes.values) {
      const v = fRes.values
      enriched = {
        ...enriched,
        roe: v.roe as number,
        per: v.per as number,
        pbr: v.pbr as number,
        epsG: v.epsG as number,
        cfOk: v.cfOk as boolean,
        de: v.de as number,
        divG: v.divG as number,
      }
    }
    if (tRes.values) {
      const v = tRes.values
      enriched = {
        ...enriched,
        ma: v.ma as boolean,
        rsi: v.rsi as number,
        macd: v.macd as boolean,
        vol: v.vol as boolean,
        mom3m: v.mom3m as number,
      }
    }

    states.set(h.code, {
      code: h.code,
      source: 'artifact',
      fundamentals: { status: fRes.status, reason: fRes.reason },
      technicals: { status: tRes.status, reason: tRes.reason },
      authoritative: fRes.status === 'known' && tRes.status === 'known',
    })
    return enriched
  })

  return { holdings: out, states }
}

/** join state → HoldingAnalysis へ露出する最小 view（§5 / §11）。 */
export function buildHoldingAnalysisEvidence(
  state: HoldingEvidenceJoinState | undefined,
): HoldingAnalysisEvidence | undefined {
  if (!state) return undefined
  return {
    fundamentals: state.fundamentals.status,
    technicals: state.technicals.status,
    source: state.source,
    fundamentalsReason: state.fundamentals.reason,
    technicalsReason: state.technicals.reason,
    authoritative: state.authoritative,
  }
}
