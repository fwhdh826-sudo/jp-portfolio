/**
 * P5-B005-B3-A: candidate_funnel freshness/degraded判定 pure helper
 * regression tests。
 *
 * 表示・観測専用（BUY_NEW/officialDecisionを生成しない）。Date.now()を
 * 内部固定使用せずnowMsを注入することをここで固定する。
 */
import { describe, expect, it } from 'vitest'
import { evaluateCandidateFunnelFreshness, CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS } from './candidateFunnelFreshness'
import { buildValidCandidateFunnelArtifact } from './candidateFunnelArtifact.fixtures'
import type { CandidateFunnelLoadResult } from './loadStaticData'

const NOW_MS = Date.parse('2026-07-26T07:11:40.540540+00:00')

function loadedResult(mutate?: (a: ReturnType<typeof buildValidCandidateFunnelArtifact>) => void): CandidateFunnelLoadResult {
  const artifact = buildValidCandidateFunnelArtifact()
  artifact._meta.generatedAt = new Date(NOW_MS).toISOString()
  mutate?.(artifact)
  return { status: 'loaded', data: artifact as unknown as CandidateFunnelLoadResult['data'] }
}

describe('evaluateCandidateFunnelFreshness', () => {
  it('returns unavailable when the loader could not reach the resource', () => {
    const result: CandidateFunnelLoadResult = { status: 'unavailable', data: null }
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).toBe('unavailable')
  })

  it('returns invalid when the loader rejected the payload', () => {
    const result: CandidateFunnelLoadResult = { status: 'invalid', data: null }
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).toBe('invalid')
  })

  it('returns fresh for a recently generated normal-pipeline artifact', () => {
    const result = loadedResult()
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).toBe('fresh')
  })

  it('returns stale once generatedAt exceeds the threshold', () => {
    const result = loadedResult()
    const farFuture = NOW_MS + CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS + 1000
    expect(evaluateCandidateFunnelFreshness(result, farFuture)).toBe('stale')
  })

  it('returns stale when selectionObservability.sourceStale is true', () => {
    const result = loadedResult((a) => {
      a.selectionObservability.sourceStale = true
    })
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).toBe('stale')
  })

  it('returns degraded for cache_fallback pipelinePath', () => {
    const result = loadedResult((a) => {
      a._meta.pipelinePath = 'cache_fallback'
    })
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).toBe('degraded')
  })

  it('returns degraded for seed_fallback pipelinePath', () => {
    const result = loadedResult((a) => {
      a._meta.pipelinePath = 'seed_fallback'
    })
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).toBe('degraded')
  })

  it('does not treat a seed_fallback / not_generated artifact as actionable-usable (returns invalid, not fresh)', () => {
    const result = loadedResult((a) => {
      a.status = 'not_generated'
    })
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).not.toBe('fresh')
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS)).toBe('invalid')
  })

  it('accepts an injected nowMs rather than reading Date.now() internally', () => {
    const result = loadedResult()
    const past = NOW_MS - 1000
    expect(evaluateCandidateFunnelFreshness(result, past)).toBe('fresh')
  })
})
