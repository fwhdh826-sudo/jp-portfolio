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
