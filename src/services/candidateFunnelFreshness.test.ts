/**
 * P5-B005-B3-A: candidate_funnel freshness/degraded判定 pure helper
 * regression tests。
 *
 * 表示・観測専用（BUY_NEW/officialDecisionを生成しない）。Date.now()を
 * 内部固定使用せずnowMsを注入することをここで固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  evaluateCandidateFunnelFreshness,
  evaluateCandidateFunnelPresentationState,
  isCandidateFunnelRawAvailable,
  CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS,
} from './candidateFunnelFreshness'
import { buildValidCandidateFunnelArtifact } from './candidateFunnelArtifact.fixtures'
import type { CandidateFunnelArtifact } from '../types/candidateFunnelArtifact'
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

// ── P5-B005-B3-C-V2-R1 FIX B: provenance × freshness の直交表現 ──────
function presentationArtifact(
  mutate?: (a: ReturnType<typeof buildValidCandidateFunnelArtifact>) => void,
): CandidateFunnelArtifact {
  const artifact = buildValidCandidateFunnelArtifact()
  artifact._meta.generatedAt = new Date(NOW_MS).toISOString()
  mutate?.(artifact)
  return artifact as unknown as CandidateFunnelArtifact
}

function stateInput(artifact: CandidateFunnelArtifact | null, status: 'loaded' | 'unavailable' | 'invalid' | undefined = 'loaded') {
  return {
    status,
    artifact,
    generatedAtTimestamp: artifact?._meta.generatedAt ?? null,
  }
}

describe('evaluateCandidateFunnelPresentationState (FIX B — orthogonal provenance/age)', () => {
  it('fresh generated: available / normal / fresh, no fallback, no stale', () => {
    const s = evaluateCandidateFunnelPresentationState(stateInput(presentationArtifact()), NOW_MS)
    expect(s).toMatchObject({ availability: 'available', provenance: 'normal', age: 'fresh', fallback: false, stale: false, canDisplayCandidates: true })
  })

  it('stale generated (generatedAt age): stale but not fallback', () => {
    const s = evaluateCandidateFunnelPresentationState(
      stateInput(presentationArtifact()),
      NOW_MS + CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS + 1000,
    )
    expect(s).toMatchObject({ availability: 'available', provenance: 'normal', fallback: false, stale: true, age: 'stale' })
  })

  it('stale generated (sourceStale flag): stale but not fallback, without a clock', () => {
    const s = evaluateCandidateFunnelPresentationState(
      stateInput(presentationArtifact(a => { a.selectionObservability.sourceStale = true })),
      Number.NaN,
    )
    expect(s).toMatchObject({ fallback: false, stale: true, age: 'stale' })
  })

  it('cache fallback fresh: fallback true, stale false', () => {
    const s = evaluateCandidateFunnelPresentationState(
      stateInput(presentationArtifact(a => { a._meta.pipelinePath = 'cache_fallback' })),
      NOW_MS,
    )
    expect(s).toMatchObject({ availability: 'available', provenance: 'cache_fallback', fallback: true, stale: false, age: 'fresh' })
  })

  it('cache fallback + stale (sourceStale): BOTH properties preserved — no collapse', () => {
    const s = evaluateCandidateFunnelPresentationState(
      stateInput(presentationArtifact(a => {
        a._meta.pipelinePath = 'cache_fallback'
        a.selectionObservability.sourceStale = true
      })),
      NOW_MS,
    )
    expect(s.fallback).toBe(true)
    expect(s.stale).toBe(true)
    expect(s.provenance).toBe('cache_fallback')
    expect(s.age).toBe('stale')
  })

  it('cache fallback + age-stale (clock): BOTH properties preserved', () => {
    const s = evaluateCandidateFunnelPresentationState(
      stateInput(presentationArtifact(a => { a._meta.pipelinePath = 'cache_fallback' })),
      NOW_MS + CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS + 1,
    )
    expect(s.fallback).toBe(true)
    expect(s.stale).toBe(true)
  })

  it('seed fallback provenance flag alone marks fallback', () => {
    const s = evaluateCandidateFunnelPresentationState(
      stateInput(presentationArtifact(a => { a.selectionObservability.fallbackProvenance = true })),
      NOW_MS,
    )
    expect(s.fallback).toBe(true)
  })

  it('published status other than generated collapses to invalid (no not_generated presentation state)', () => {
    const s = evaluateCandidateFunnelPresentationState(
      stateInput(presentationArtifact(a => { a.status = 'not_generated' })),
      NOW_MS,
    )
    expect(s.availability).toBe('invalid')
    expect(s.canDisplayCandidates).toBe(false)
  })

  it('loader invalid → invalid; loader unavailable → unavailable', () => {
    expect(evaluateCandidateFunnelPresentationState({ status: 'invalid', artifact: null, generatedAtTimestamp: null }, NOW_MS).availability).toBe('invalid')
    expect(evaluateCandidateFunnelPresentationState({ status: 'unavailable', artifact: null, generatedAtTimestamp: null }, NOW_MS).availability).toBe('unavailable')
  })

  it('undefined status + no artifact + no timestamp → unavailable; with a stray timestamp → invalid', () => {
    expect(evaluateCandidateFunnelPresentationState({ status: undefined, artifact: null, generatedAtTimestamp: null }, NOW_MS).availability).toBe('unavailable')
    expect(evaluateCandidateFunnelPresentationState({ status: undefined, artifact: null, generatedAtTimestamp: '2026-07-26T00:00:00Z' }, NOW_MS).availability).toBe('invalid')
  })

  it('timestamp inconsistency between dataTimestamps and _meta.generatedAt → invalid', () => {
    const artifact = presentationArtifact()
    const s = evaluateCandidateFunnelPresentationState(
      { status: 'loaded', artifact, generatedAtTimestamp: '2000-01-01T00:00:00Z' },
      NOW_MS,
    )
    expect(s.availability).toBe('invalid')
  })
})

// ── P5-B005-B3-C-V2-R2 P2-2: runtime store は artifact / load status /
//    data timestamp を atomic に publish する。したがって status='loaded' かつ
//    valid artifact なのに coherent な generatedAt timestamp を伴わない state は
//    正当ではなく、fail-closed で invalid にする。
describe('evaluateCandidateFunnelPresentationState (P2-2 — timestamp fail-closed)', () => {
  it('loaded + valid artifact + matching timestamp → available', () => {
    const artifact = presentationArtifact()
    const s = evaluateCandidateFunnelPresentationState(
      { status: 'loaded', artifact, generatedAtTimestamp: artifact._meta.generatedAt },
      NOW_MS,
    )
    expect(s.availability).toBe('available')
    expect(s.canDisplayCandidates).toBe(true)
  })

  it('loaded + valid artifact + null timestamp → invalid', () => {
    const artifact = presentationArtifact()
    const s = evaluateCandidateFunnelPresentationState(
      { status: 'loaded', artifact, generatedAtTimestamp: null },
      NOW_MS,
    )
    expect(s.availability).toBe('invalid')
    expect(s.canDisplayCandidates).toBe(false)
  })

  it('loaded + valid artifact + undefined timestamp → invalid', () => {
    const artifact = presentationArtifact()
    const s = evaluateCandidateFunnelPresentationState(
      { status: 'loaded', artifact, generatedAtTimestamp: undefined },
      NOW_MS,
    )
    expect(s.availability).toBe('invalid')
  })

  it('loaded + valid artifact + malformed timestamp → invalid', () => {
    const artifact = presentationArtifact()
    const s = evaluateCandidateFunnelPresentationState(
      { status: 'loaded', artifact, generatedAtTimestamp: 'not-a-timestamp' },
      NOW_MS,
    )
    expect(s.availability).toBe('invalid')
  })

  it('loaded + valid artifact + mismatching (but valid) timestamp → invalid', () => {
    const artifact = presentationArtifact()
    const s = evaluateCandidateFunnelPresentationState(
      { status: 'loaded', artifact, generatedAtTimestamp: '2020-01-01T00:00:00.000Z' },
      NOW_MS,
    )
    expect(s.availability).toBe('invalid')
  })

  it('loaded + null artifact → invalid regardless of timestamp', () => {
    expect(
      evaluateCandidateFunnelPresentationState(
        { status: 'loaded', artifact: null, generatedAtTimestamp: null },
        NOW_MS,
      ).availability,
    ).toBe('invalid')
    expect(
      evaluateCandidateFunnelPresentationState(
        { status: 'loaded', artifact: null, generatedAtTimestamp: '2026-07-26T07:11:40.540Z' },
        NOW_MS,
      ).availability,
    ).toBe('invalid')
  })

  it('no boot-order exception: a matching timestamp is required even for a fallback/stale artifact', () => {
    const stale = evaluateCandidateFunnelPresentationState(
      {
        status: 'loaded',
        artifact: presentationArtifact(a => { a.selectionObservability.sourceStale = true }),
        generatedAtTimestamp: null,
      },
      Number.NaN,
    )
    expect(stale.availability).toBe('invalid')

    const fallback = evaluateCandidateFunnelPresentationState(
      {
        status: 'loaded',
        artifact: presentationArtifact(a => { a._meta.pipelinePath = 'cache_fallback' }),
        generatedAtTimestamp: undefined,
      },
      NOW_MS,
    )
    expect(fallback.availability).toBe('invalid')
  })
})

describe('isCandidateFunnelRawAvailable (FIX F helper)', () => {
  it('true for a fresh generated artifact', () => {
    expect(isCandidateFunnelRawAvailable(stateInput(presentationArtifact()))).toBe(true)
  })

  it('true for a stale generated artifact (age does not gate availability)', () => {
    expect(isCandidateFunnelRawAvailable(stateInput(presentationArtifact(a => { a.selectionObservability.sourceStale = true })))).toBe(true)
  })

  it('false for unavailable / invalid / not_generated', () => {
    expect(isCandidateFunnelRawAvailable({ status: 'unavailable', artifact: null, generatedAtTimestamp: null })).toBe(false)
    expect(isCandidateFunnelRawAvailable({ status: 'invalid', artifact: null, generatedAtTimestamp: null })).toBe(false)
    expect(isCandidateFunnelRawAvailable(stateInput(presentationArtifact(a => { a.status = 'not_generated' })))).toBe(false)
  })

  // P2-2: freshness は raw availability を決めない — 一致した timestamp があれば
  // fresh でも stale でも fallback でも true、timestamp が欠落/不正/不一致なら false。
  it.each([
    ['matching timestamp', (a: CandidateFunnelArtifact) => a._meta.generatedAt as string | null | undefined, true],
    ['null timestamp', () => null, false],
    ['undefined timestamp', () => undefined, false],
    ['malformed timestamp', () => 'nope', false],
    ['mismatching timestamp', () => '2020-01-01T00:00:00.000Z', false],
  ] as const)('%s → %s', (_label, pick, expected) => {
    const artifact = presentationArtifact()
    expect(
      isCandidateFunnelRawAvailable({
        status: 'loaded',
        artifact,
        generatedAtTimestamp: pick(artifact),
      }),
    ).toBe(expected)
  })

  it('stale-but-otherwise-valid and fallback-but-otherwise-valid remain raw-available (age/provenance do not gate)', () => {
    const stale = presentationArtifact(a => { a.selectionObservability.sourceStale = true })
    expect(isCandidateFunnelRawAvailable({ status: 'loaded', artifact: stale, generatedAtTimestamp: stale._meta.generatedAt })).toBe(true)
    const fallback = presentationArtifact(a => { a._meta.pipelinePath = 'cache_fallback' })
    expect(isCandidateFunnelRawAvailable({ status: 'loaded', artifact: fallback, generatedAtTimestamp: fallback._meta.generatedAt })).toBe(true)
  })
})
