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
    // FCA-1-P1-03: the injected clock is the only clock. A nowMs 1s after
    // generatedAt is fresh; a nowMs 1s *before* generatedAt makes the artifact
    // future-dated and is no longer 'fresh' (see the P1-03 suite below).
    const result = loadedResult()
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS + 1000)).toBe('fresh')
    expect(evaluateCandidateFunnelFreshness(result, NOW_MS - 1000)).toBe('invalid')
  })
})

// ── OPS_P5_B005_FCA_1_P1_REPAIR_R1 / FCA-1-P1-03: strict timestamp authority
//    + future rejection（freshness 層の責務: nowMs との時間関係） ──────────
describe('FCA-1-P1-03 evaluateCandidateFunnelFreshness — strict timestamp / future authority', () => {
  const PRODUCER_GENERATED_AT = '2026-07-26T07:11:40.540540+00:00'
  const PRODUCER_MS = Date.UTC(2026, 6, 26, 7, 11, 40, 540)

  function producerResult(generatedAt = PRODUCER_GENERATED_AT, mutate?: (a: ReturnType<typeof buildValidCandidateFunnelArtifact>) => void): CandidateFunnelLoadResult {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.generatedAt = generatedAt
    mutate?.(artifact)
    return { status: 'loaded', data: artifact as unknown as CandidateFunnelLoadResult['data'] }
  }

  it('accepts the canonical producer microsecond ISO form and evaluates it at millisecond authority', () => {
    expect(evaluateCandidateFunnelFreshness(producerResult(), PRODUCER_MS)).toBe('fresh')
    expect(evaluateCandidateFunnelFreshness(producerResult(), PRODUCER_MS + 1)).toBe('fresh')
  })

  it('exact current time (generatedAt === nowMs) is deterministic: fresh, not future', () => {
    expect(evaluateCandidateFunnelFreshness(loadedResult(), NOW_MS)).toBe('fresh')
  })

  it('future generatedAt relative to nowMs is invalid, never fresh (1ms / 1s / 1 day)', () => {
    for (const delta of [1, 1000, 24 * 60 * 60 * 1000]) {
      expect(evaluateCandidateFunnelFreshness(loadedResult(), NOW_MS - delta)).toBe('invalid')
    }
  })

  it('future generatedAt is rejected before provenance/sourceStale mapping (no degraded/stale promotion)', () => {
    const degraded = producerResult(PRODUCER_GENERATED_AT, a => { a._meta.pipelinePath = 'cache_fallback' })
    expect(evaluateCandidateFunnelFreshness(degraded, PRODUCER_MS - 1)).toBe('invalid')
    const sourceStale = producerResult(PRODUCER_GENERATED_AT, a => { a.selectionObservability.sourceStale = true })
    expect(evaluateCandidateFunnelFreshness(sourceStale, PRODUCER_MS - 1)).toBe('invalid')
  })

  it('calendar-invalid generatedAt (2026-09-31) is invalid even though Date.parse would roll it over', () => {
    const rollover = '2026-09-31T00:00:00+00:00'
    expect(Number.isNaN(Date.parse(rollover))).toBe(false)
    const nowMs = Date.UTC(2026, 9, 1, 12, 0, 0)
    expect(evaluateCandidateFunnelFreshness(producerResult(rollover), nowMs)).toBe('invalid')
  })

  it('timezone-less / locale-style / date-only generatedAt is invalid', () => {
    for (const bad of ['2026-07-26T07:11:40', '2026-07-26', '07/26/2026 07:11:40', '2026-07-26 07:11:40Z', '']) {
      expect(evaluateCandidateFunnelFreshness(producerResult(bad), Date.UTC(2026, 6, 27))).toBe('invalid')
    }
  })

  it('old valid generatedAt is stale (48h inclusive boundary preserved)', () => {
    const boundary = NOW_MS + CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS
    expect(evaluateCandidateFunnelFreshness(loadedResult(), boundary)).toBe('fresh')
    expect(evaluateCandidateFunnelFreshness(loadedResult(), boundary + 1)).toBe('stale')
  })

  it('non-finite nowMs cannot evaluate a temporal relation: invalid, not fresh', () => {
    expect(evaluateCandidateFunnelFreshness(loadedResult(), Number.NaN)).toBe('invalid')
    expect(evaluateCandidateFunnelFreshness(loadedResult(), Number.POSITIVE_INFINITY)).toBe('invalid')
  })

  it('+09:00 and Z spellings of the same instant produce identical results regardless of host TZ', () => {
    const jst = producerResult('2026-07-26T16:11:40.540540+09:00')
    const utc = producerResult('2026-07-26T07:11:40.540540Z')
    for (const nowMs of [PRODUCER_MS - 1, PRODUCER_MS, PRODUCER_MS + 1, PRODUCER_MS + CANDIDATE_FUNNEL_DEFAULT_STALE_THRESHOLD_MS + 1]) {
      expect(evaluateCandidateFunnelFreshness(jst, nowMs)).toBe(evaluateCandidateFunnelFreshness(utc, nowMs))
    }
    expect(evaluateCandidateFunnelFreshness(jst, PRODUCER_MS - 1)).toBe('invalid')
    expect(evaluateCandidateFunnelFreshness(jst, PRODUCER_MS)).toBe('fresh')
  })
})

describe('FCA-1-P1-03 evaluateCandidateFunnelPresentationState — future / strict timestamp gating', () => {
  function input(generatedAt: string) {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.generatedAt = generatedAt
    return { status: 'loaded' as const, artifact: artifact as unknown as CandidateFunnelArtifact, generatedAtTimestamp: generatedAt }
  }

  it('future generatedAt with a finite clock is invalid (not displayed as fresh)', () => {
    const generatedAt = new Date(NOW_MS).toISOString()
    expect(evaluateCandidateFunnelPresentationState(input(generatedAt), NOW_MS - 1)).toMatchObject({
      availability: 'invalid',
      canDisplayCandidates: false,
      age: 'unknown',
    })
    expect(evaluateCandidateFunnelPresentationState(input(generatedAt), NOW_MS)).toMatchObject({
      availability: 'available',
      age: 'fresh',
    })
  })

  it('calendar-invalid generatedAt is invalid even when coherent with the store timestamp', () => {
    expect(evaluateCandidateFunnelPresentationState(input('2026-02-30T00:00:00+00:00'), NOW_MS)).toMatchObject({
      availability: 'invalid',
      canDisplayCandidates: false,
    })
    expect(isCandidateFunnelRawAvailable(input('2026-02-30T00:00:00+00:00'))).toBe(false)
  })

  it('clock-less availability (NaN nowMs) still does not evaluate a temporal relation', () => {
    expect(isCandidateFunnelRawAvailable(input('2026-07-26T07:11:40.540540+00:00'))).toBe(true)
  })

  it('generatedAtTimestamp / artifact._meta.generatedAt coherence remains strict', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.generatedAt = '2026-07-26T07:11:40.540540+00:00'
    const state = evaluateCandidateFunnelPresentationState(
      { status: 'loaded', artifact: artifact as unknown as CandidateFunnelArtifact, generatedAtTimestamp: '2026-07-26T07:11:40.540Z' },
      NOW_MS,
    )
    expect(state.availability).toBe('invalid')
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
