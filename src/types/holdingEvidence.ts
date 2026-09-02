// ═══════════════════════════════════════════════════════════
// HOLDING-EVIDENCE-1: holding_evidence.json artifact contract（frozen semantics）
//
// 既存 Holding の fundamentals/technicals には本番 evidence を populate する経路が
// 存在しない（handover / production browser truth: metadataStatus 0/16、
// decision INSUFFICIENT_EVIDENCE 16/16）。このファイルは front-end 側の
// 契約型と定数のみを凍結する。
//
// 重要:
//  - この artifact 由来の evidence は analysis 実行時のみの ephemeral 値であり、
//    Holding へ永続化してはならない（joinHoldingEvidence の出力は
//    computeAnalysis の入力配列としてのみ使用する）。
//  - 本番 Python generator / GitHub Actions workflow / 実 artifact 生成は
//    HOLDING-EVIDENCE-2 の責務。ここでは絶対に実装しない。
//
// syntax は repository 慣習（regime_state.json / candidates_stocks.json の
// `_meta` + top-level `schemaVersion` + `not_for_trading`）に合わせる。
// semantics（TTL / identity / not_applicable 許容範囲 / bars）は凍結。
// ═══════════════════════════════════════════════════════════

import type { MetadataProvenance } from './index'

export const HOLDING_EVIDENCE_SCHEMA_VERSION = 'holding-evidence-1' as const
export const HOLDING_EVIDENCE_KIND = 'holding_evidence' as const

/** 東証コード（TSE）のみを identity 一致対象とする（frozen §7-4） */
export const HOLDING_EVIDENCE_MARKET = 'TSE' as const

// ── frozen provenance / freshness gates（§7）───────────────────
/** pipeline generatedAt の許容鮮度 */
export const HOLDING_EVIDENCE_PIPELINE_TTL_MS = 72 * 60 * 60 * 1000
/** fundamentals group asOf の許容鮮度 */
export const HOLDING_EVIDENCE_FUNDAMENTALS_TTL_MS = 45 * 24 * 60 * 60 * 1000
/** technicals group asOf の許容鮮度 */
export const HOLDING_EVIDENCE_TECHNICALS_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** technicals group が known になるための最低バー数（§7-9） */
export const HOLDING_EVIDENCE_MIN_TECHNICAL_BARS = 75

// ── フィールド定義 ────────────────────────────────────────────
export type HoldingEvidenceFieldStatus = 'present' | 'missing' | 'not_applicable'

export const HOLDING_EVIDENCE_FUNDAMENTALS_FIELDS = [
  'roe', 'per', 'pbr', 'epsG', 'cfOk', 'de', 'divG',
] as const
export const HOLDING_EVIDENCE_TECHNICALS_FIELDS = [
  'ma', 'rsi', 'macd', 'vol', 'mom3m',
] as const

export type HoldingEvidenceFundamentalsField = typeof HOLDING_EVIDENCE_FUNDAMENTALS_FIELDS[number]
export type HoldingEvidenceTechnicalsField = typeof HOLDING_EVIDENCE_TECHNICALS_FIELDS[number]

/**
 * not_applicable が契約上許容される唯一の required フィールド（§8）。
 * 証券区分により D/E が本質的に適用不能な場合のみ。それ以外の required
 * フィールドが not_applicable の場合、その group は unknown（§7-8）。
 */
export const HOLDING_EVIDENCE_NOT_APPLICABLE_FIELDS: ReadonlySet<string> = new Set<HoldingEvidenceFundamentalsField>(['de'])

/** de = not_applicable のときに ephemeral 分析入力へ与える中立値（既存 safe default と同一） */
export const HOLDING_EVIDENCE_NEUTRAL_DE = 1.5

export interface HoldingEvidenceField {
  /** present のときの値。cfOk/ma/macd/vol は boolean、それ以外は number。missing/not_applicable では null 可 */
  v: number | boolean | null
  status: HoldingEvidenceFieldStatus
}

export interface HoldingEvidenceFundamentalsGroup {
  asOf: string
  source: string
  fields: Record<HoldingEvidenceFundamentalsField, HoldingEvidenceField>
}

export interface HoldingEvidenceTechnicalsGroup {
  asOf: string
  source: string
  bars: number
  fields: Record<HoldingEvidenceTechnicalsField, HoldingEvidenceField>
}

export interface HoldingEvidenceEntry {
  /** repository canonical JP stock code（数字3桁 + 数字/英字1桁） */
  code: string
  /** `${code}.T` と厳密一致する必要がある（§7-4） */
  ticker: string
  market: typeof HOLDING_EVIDENCE_MARKET
  fundamentals: HoldingEvidenceFundamentalsGroup
  technicals: HoldingEvidenceTechnicalsGroup
}

export interface HoldingEvidenceArtifactMeta {
  kind: typeof HOLDING_EVIDENCE_KIND
  schemaVersion: typeof HOLDING_EVIDENCE_SCHEMA_VERSION
  /** pipeline 生成時刻（PIPELINE_TTL 判定に使用） */
  generatedAt: string
  not_for_trading: true
}

export interface HoldingEvidenceArtifact {
  schemaVersion: typeof HOLDING_EVIDENCE_SCHEMA_VERSION
  not_for_trading: true
  _meta: HoldingEvidenceArtifactMeta
  entries: HoldingEvidenceEntry[]
}

// ── analysis 実行時に導出される effective evidence 状態（表示 / observability 用）──
export type HoldingEvidenceReason =
  | 'ok'
  | 'no_artifact'
  | 'no_entry'
  | 'ambiguous_entry'
  | 'identity_mismatch'
  | 'future_pipeline'
  | 'stale_pipeline'
  | 'future_asof'
  | 'stale_group'
  | 'partial_fields'
  | 'insufficient_bars'
  | 'invalid_not_applicable'

/** effective status の出所。artifact = published evidence 由来、persisted = Holding 自身の metadataStatus fall-through */
export type HoldingEvidenceSource = 'artifact' | 'persisted'

export interface HoldingEvidenceGroupResolution {
  status: MetadataProvenance
  reason: HoldingEvidenceReason
}

export interface HoldingEvidenceJoinState {
  code: string
  source: HoldingEvidenceSource
  fundamentals: HoldingEvidenceGroupResolution
  technicals: HoldingEvidenceGroupResolution
  /** fundamentals・technicals の両方が published artifact 由来で known のときのみ true */
  authoritative: boolean
}

/** HoldingAnalysis へ露出する最小の evidence 状態（§5 / §11 authoritative vs provisional 区別用） */
export interface HoldingAnalysisEvidence {
  fundamentals: MetadataProvenance
  technicals: MetadataProvenance
  source: HoldingEvidenceSource
  fundamentalsReason: HoldingEvidenceReason
  technicalsReason: HoldingEvidenceReason
  authoritative: boolean
}
