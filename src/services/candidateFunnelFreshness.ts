// ═══════════════════════════════════════════════════════════
// P5-B005-B3-A: candidate_funnel artifactのfreshness/degraded判定pure helper。
//
// 表示・観測専用（observability-only）。BUY_NEW/officialDecisionを一切
// 生成しない。UI接続前に利用できる形で独立させる。
//
// Date.now()を内部固定使用しない — nowMsを呼び出し側から注入する
// （テスト容易性・タイムゾーン非依存のため）。
// ═══════════════════════════════════════════════════════════

import type { CandidateFunnelLoadResult } from './loadStaticData'
import type { CandidateFunnelArtifact } from '../types/candidateFunnelArtifact'

export type CandidateFunnelFreshness = 'fresh' | 'stale' | 'degraded' | 'invalid' | 'unavailable'

// candidates_stocks.jsonのDEFAULT staleThresholdHours(48)と揃える。
export const CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000

export function evaluateCandidateFunnelFreshness(
  result: CandidateFunnelLoadResult,
  nowMs: number,
  staleThresholdMs: number = CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS,
): CandidateFunnelFreshness {
  if (result.status === 'unavailable') return 'unavailable'
  if (result.status === 'invalid' || !result.data) return 'invalid'

  const { data } = result
  const meta = data._meta

  // parserはstatus!=='generated'のartifactをoverallPass!==true経由で
  // 既にrejectしているが、freshness helper自体もdefense-in-depthとして
  // seed_fallback/not_generatedをactionable利用可能と判定しない。
  if (data.status !== 'generated') return 'invalid'
  if (meta.pipelinePath === 'cache_fallback' || meta.pipelinePath === 'seed_fallback') return 'degraded'
  if (data.selectionObservability.sourceStale) return 'stale'

  const generatedMs = Date.parse(meta.generatedAt)
  if (!Number.isFinite(generatedMs)) return 'invalid'
  if (nowMs - generatedMs > staleThresholdMs) return 'stale'

  return 'fresh'
}

// ═══════════════════════════════════════════════════════════
// P5-B005-B3-C-V2-R1 FIX B: provenance（生成経路）と freshness（鮮度）は
// 直交する。既存の evaluateCandidateFunnelFreshness は fallback を stale より
// 先に評価し 'degraded' に畳み込むため「代替経路 かつ 古い」を1状態でしか
// 表せない。この additive helper は両者を分けて保持する。
//
// 表示・観測専用（BUY_NEW/officialDecision を一切生成しない）。store 権限
// ロジック（selectCandidateFunnelFreshness / AllocationPlan / synthesis
// gating）は従来どおり evaluateCandidateFunnelFreshness を使う。この helper
// は presentation（CandidateFunnelPanel / T0 / T1）専用。
//
// 注: 生成結果 status=not_generated は engine/batch の outcome であり、
// candidate_funnel_batch は publish しない（fetch できた最終 artifact は
// 常に generated か、または不在=unavailable）。したがってここに
// not_generated という表示状態を作らない — status!=='generated' は invalid。
// ═══════════════════════════════════════════════════════════

export type CandidateFunnelAvailability = 'available' | 'invalid' | 'unavailable'
export type CandidateFunnelProvenanceKind = 'normal' | 'cache_fallback' | 'seed_fallback'
export type CandidateFunnelAgeKind = 'fresh' | 'stale' | 'unknown'

export interface CandidateFunnelPresentationState {
  /** 取得できたか。provenance / age とは独立 */
  availability: CandidateFunnelAvailability
  /** 取得できた published artifact の生成経路。available 以外では null */
  provenance: CandidateFunnelProvenanceKind | null
  /** artifact の鮮度。available 以外では 'unknown' */
  age: CandidateFunnelAgeKind
  /** provenance が normal 以外（= 代替データ経路） */
  fallback: boolean
  /** age === 'stale'（fallback と同時に true になり得る） */
  stale: boolean
  /** candidate list を表示してよいか（available のときのみ true） */
  canDisplayCandidates: boolean
}

export interface CandidateFunnelPresentationInput {
  /** state.system.dataSourceStatus.candidateFunnel */
  status: 'loaded' | 'unavailable' | 'invalid' | undefined
  /** state.candidateFunnel（parser を通過した artifact のみ） */
  artifact: CandidateFunnelArtifact | null
  /** state.system.dataTimestamps?.candidateFunnel（整合性チェック用。省略可） */
  generatedAtTimestamp: string | null | undefined
}

const PRESENTATION_UNAVAILABLE: CandidateFunnelPresentationState = {
  availability: 'unavailable',
  provenance: null,
  age: 'unknown',
  fallback: false,
  stale: false,
  canDisplayCandidates: false,
}

const PRESENTATION_INVALID: CandidateFunnelPresentationState = {
  availability: 'invalid',
  provenance: null,
  age: 'unknown',
  fallback: false,
  stale: false,
  canDisplayCandidates: false,
}

export function evaluateCandidateFunnelPresentationState(
  input: CandidateFunnelPresentationInput,
  nowMs: number,
  staleThresholdMs: number = CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS,
): CandidateFunnelPresentationState {
  const { status, artifact, generatedAtTimestamp } = input

  if (status === 'unavailable') return PRESENTATION_UNAVAILABLE
  if (status === undefined) {
    return artifact === null && generatedAtTimestamp == null
      ? PRESENTATION_UNAVAILABLE
      : PRESENTATION_INVALID
  }
  if (status === 'invalid' || artifact === null) return PRESENTATION_INVALID

  const meta = artifact._meta
  // defense-in-depth: parser は status!=='generated' と _meta 欠落を既に
  // reject しているが、手組みの state でも壊れないようにここでも確認する。
  if (artifact.status !== 'generated' || meta == null) return PRESENTATION_INVALID
  if (generatedAtTimestamp != null && generatedAtTimestamp !== meta.generatedAt) {
    return PRESENTATION_INVALID
  }

  const generatedMs = Date.parse(meta.generatedAt)
  if (!Number.isFinite(generatedMs)) return PRESENTATION_INVALID

  const provenance: CandidateFunnelProvenanceKind = meta.pipelinePath
  const fallback =
    provenance !== 'normal' || artifact.selectionObservability.fallbackProvenance === true

  const ageStale =
    artifact.selectionObservability.sourceStale === true ||
    (Number.isFinite(nowMs) && nowMs - generatedMs > staleThresholdMs)

  return {
    availability: 'available',
    provenance,
    age: ageStale ? 'stale' : 'fresh',
    fallback,
    stale: ageStale,
    canDisplayCandidates: true,
  }
}

// FIX F helper: raw candidate funnel artifact が表示可能な状態にあるか
// （synthesis / AllocationPlan 連携の待ちとは独立）。availability は nowMs に
// 依存しないため clock 不要。
export function isCandidateFunnelRawAvailable(input: CandidateFunnelPresentationInput): boolean {
  return evaluateCandidateFunnelPresentationState(input, Number.NaN).availability === 'available'
}
