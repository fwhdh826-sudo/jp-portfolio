import { describe, expect, it } from 'vitest'
import type { AppState, CandidateFunnelArtifact } from '../types'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import { selectCandidateFunnelFreshness } from './selectors'

const HOUR_MS = 60 * 60 * 1000

function artifact(): CandidateFunnelArtifact {
  return structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
}

function state(
  data: CandidateFunnelArtifact | null,
  status: AppState['system']['dataSourceStatus']['candidateFunnel'],
  timestamp: string | null | undefined = data?._meta.generatedAt ?? null,
): AppState {
  return {
    candidateFunnel: data,
    system: {
      dataSourceStatus: { candidateFunnel: status },
      dataTimestamps: { candidateFunnel: timestamp },
    },
  } as AppState
}

describe('selectCandidateFunnelFreshness', () => {
  it('returns fresh for a current normal-pipeline artifact', () => {
    const data = artifact()
    const nowMs = Date.parse(data._meta.generatedAt) + HOUR_MS
    expect(selectCandidateFunnelFreshness(state(data, 'loaded'), nowMs)).toBe('fresh')
  })

  it('returns stale when generatedAt is older than the freshness threshold', () => {
    const data = artifact()
    const nowMs = Date.parse(data._meta.generatedAt) + 49 * HOUR_MS
    expect(selectCandidateFunnelFreshness(state(data, 'loaded'), nowMs)).toBe('stale')
  })

  it.each(['cache_fallback', 'seed_fallback'] as const)(
    'returns degraded for %s and never treats fallback data as fresh',
    pipelinePath => {
      const data = artifact()
      data._meta.pipelinePath = pipelinePath
      const nowMs = Date.parse(data._meta.generatedAt) + HOUR_MS
      expect(selectCandidateFunnelFreshness(state(data, 'loaded'), nowMs)).toBe('degraded')
    },
  )

  it('returns unavailable for a fail-closed unavailable load result', () => {
    expect(selectCandidateFunnelFreshness(state(null, 'unavailable'), Date.now())).toBe('unavailable')
  })

  it('returns invalid for a fail-closed invalid load result', () => {
    expect(selectCandidateFunnelFreshness(state(null, 'invalid'), Date.now())).toBe('invalid')
  })

  it('returns invalid for loaded + null inconsistency', () => {
    expect(selectCandidateFunnelFreshness(state(null, 'loaded'), Date.now())).toBe('invalid')
  })

  it('returns invalid when a failure status still carries old artifact data', () => {
    expect(selectCandidateFunnelFreshness(state(artifact(), 'unavailable'), Date.now())).toBe('invalid')
  })

  it('returns invalid when the stored timestamp does not match artifact generatedAt', () => {
    const data = artifact()
    expect(selectCandidateFunnelFreshness(
      state(data, 'loaded', '2026-01-01T00:00:00.000Z'),
      Date.parse(data._meta.generatedAt) + HOUR_MS,
    )).toBe('invalid')
  })

  it('treats the pre-load optional status shape as unavailable only when data is null', () => {
    expect(selectCandidateFunnelFreshness(state(null, undefined, undefined), Date.now())).toBe('unavailable')
    expect(selectCandidateFunnelFreshness(state(artifact(), undefined, undefined), Date.now())).toBe('invalid')
  })
})
