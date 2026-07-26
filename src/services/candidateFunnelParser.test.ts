/**
 * P5-B005-B3-A: candidate_funnel.json production artifact runtime parser
 * regression tests。
 *
 * B2でproduction publish済みの実artifact（data/public両方）を安全にparse
 * できること、およびprivacy/provenance/quality gate契約への違反を確実に
 * rejectすることをここで固定する。malformed payloadでthrowしないことも
 * 保証する。
 */
import { describe, expect, it } from 'vitest'
import { parseCandidateFunnelArtifact } from './candidateFunnelParser'
import { buildValidCandidateFunnelArtifact } from './candidateFunnelArtifact.fixtures'
import dataArtifact from '../../data/candidate_funnel.json'
import publicArtifact from '../../public/data/candidate_funnel.json'

describe('parseCandidateFunnelArtifact — real production artifact', () => {
  it('parses data/candidate_funnel.json successfully', () => {
    const result = parseCandidateFunnelArtifact(dataArtifact)
    expect(result.ok).toBe(true)
  })

  it('parses public/data/candidate_funnel.json successfully', () => {
    const result = parseCandidateFunnelArtifact(publicArtifact)
    expect(result.ok).toBe(true)
  })

  it('data/public artifacts are byte-identical (structural)', () => {
    expect(dataArtifact).toEqual(publicArtifact)
  })

  it('candidate/count/tier consistency holds on the real artifact', () => {
    const result = parseCandidateFunnelArtifact(dataArtifact)
    if (!result.ok) throw new Error('expected ok')
    const { data } = result
    expect(data.candidates.length).toBe(data.counts.total)
    const tally = { screened: 0, deep_review: 0, actionable: 0, excluded: 0, eligible: 0 }
    for (const c of data.candidates) tally[c.tier] += 1
    expect(tally.screened).toBe(data.counts.screened)
    expect(tally.deep_review).toBe(data.counts.deepReview)
    expect(tally.actionable).toBe(data.counts.actionable)
    expect(tally.excluded).toBe(data.counts.excluded)
  })

  it('does not depend on a fixed 12 actionable / 40 deepReview snapshot — only contract-relevant assertions', () => {
    const result = parseCandidateFunnelArtifact(dataArtifact)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.counts.actionable).toBeGreaterThanOrEqual(0)
    expect(result.data.counts.deepReview).toBeGreaterThanOrEqual(0)
    expect(result.data._meta.qualityGate.overallPass).toBe(true)
    expect(result.data._meta.qualityGate.hardFailIds).toEqual([])
  })
})

describe('parseCandidateFunnelArtifact — valid fixture baseline', () => {
  it('accepts a well-formed minimal artifact', () => {
    const result = parseCandidateFunnelArtifact(buildValidCandidateFunnelArtifact())
    expect(result.ok).toBe(true)
  })

  it('accepts P-15 value=null (no prior baseline)', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    const p15 = artifact._meta.qualityGate.gates.find((g: { id: string }) => g.id === 'P-15')!
    p15.value = null
    const result = parseCandidateFunnelArtifact(artifact)
    expect(result.ok).toBe(true)
  })

  it('accepts auxiliary gates such as PRESCREEN_DUPLICATE alongside P-01..P-15', () => {
    const result = parseCandidateFunnelArtifact(buildValidCandidateFunnelArtifact())
    expect(result.ok).toBe(true)
  })
})

describe('parseCandidateFunnelArtifact — version mutation rejection', () => {
  it('rejects schemaVersion mutation', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact as { schemaVersion: string }).schemaVersion = 'candidate-funnel-2'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects funnelVersion mutation', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact as { funnelVersion: string }).funnelVersion = 'candidate-funnel-v2'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects scoreVersion mutation', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact as { scoreVersion: string }).scoreVersion = 'market-score-v2'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })
})

describe('parseCandidateFunnelArtifact — privacy / provenance rejection', () => {
  it('rejects not_for_trading=false', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact as { not_for_trading: boolean }).not_for_trading = false
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects missing _meta', () => {
    const artifact = buildValidCandidateFunnelArtifact() as Record<string, unknown>
    delete artifact._meta
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects invalid generatedAt', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.generatedAt = 'not-a-timestamp'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })
})

describe('parseCandidateFunnelArtifact — quality gate rejection', () => {
  it('rejects overallPass=false', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.qualityGate.overallPass = false
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects non-empty hardFailIds', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.qualityGate.hardFailIds = ['P-14']
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects a missing gate id in P-01..P-15 (e.g. P-14 dropped)', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.qualityGate.gates = artifact._meta.qualityGate.gates.filter((g: { id: string }) => g.id !== 'P-14')
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects a duplicated gate id in P-01..P-15', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    const p14 = artifact._meta.qualityGate.gates.find((g: { id: string }) => g.id === 'P-14')!
    artifact._meta.qualityGate.gates.push({ ...p14 })
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })
})

describe('parseCandidateFunnelArtifact — candidate / scoreBreakdown rejection', () => {
  it('rejects a partially-invalid candidate (missing required field)', () => {
    const artifact = buildValidCandidateFunnelArtifact() as { candidates: Array<Record<string, unknown>> }
    delete artifact.candidates[0].code
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects scoreBreakdown with a missing component', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact.candidates[0].scoreBreakdown = artifact.candidates[0].scoreBreakdown.slice(0, 9)
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects scoreBreakdown with a duplicated component id', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    const [first] = artifact.candidates[0].scoreBreakdown
    artifact.candidates[0].scoreBreakdown[1] = { ...first }
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects scoreBreakdown with an unknown component id', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact.candidates[0].scoreBreakdown[0] = {
      ...artifact.candidates[0].scoreBreakdown[0],
      id: 'unknownComponent',
    }
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects counts/candidate tier mismatch', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact.counts.actionable = 999
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })
})

describe('parseCandidateFunnelArtifact — forbidden key rejection (recursive, all levels)', () => {
  it('rejects a forbidden key at the top level', () => {
    const artifact = buildValidCandidateFunnelArtifact() as Record<string, unknown>
    artifact.portfolioFit = { score: 1 }
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects a forbidden key nested inside a candidate', () => {
    const artifact = buildValidCandidateFunnelArtifact() as { candidates: Array<Record<string, unknown>> }
    artifact.candidates[0].officialDecision = 'BUY_NEW'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects a forbidden key nested inside _meta', () => {
    const artifact = buildValidCandidateFunnelArtifact() as unknown as { _meta: Record<string, unknown> }
    artifact._meta.headroom = 100000
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects BUY_NEW / WATCH / BLOCKED keys anywhere in the payload', () => {
    const artifact = buildValidCandidateFunnelArtifact() as Record<string, unknown>
    artifact.WATCH = []
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })
})

describe('parseCandidateFunnelArtifact — does not throw on malformed input', () => {
  it('does not throw and rejects null', () => {
    expect(() => parseCandidateFunnelArtifact(null)).not.toThrow()
    expect(parseCandidateFunnelArtifact(null).ok).toBe(false)
  })

  it('does not throw and rejects an array', () => {
    expect(() => parseCandidateFunnelArtifact([1, 2, 3])).not.toThrow()
    expect(parseCandidateFunnelArtifact([1, 2, 3]).ok).toBe(false)
  })

  it('does not throw and rejects a primitive string', () => {
    expect(() => parseCandidateFunnelArtifact('not an object')).not.toThrow()
    expect(parseCandidateFunnelArtifact('not an object').ok).toBe(false)
  })

  it('does not throw and rejects a primitive number', () => {
    expect(() => parseCandidateFunnelArtifact(42)).not.toThrow()
    expect(parseCandidateFunnelArtifact(42).ok).toBe(false)
  })

  it('does not throw and rejects undefined', () => {
    expect(() => parseCandidateFunnelArtifact(undefined)).not.toThrow()
    expect(parseCandidateFunnelArtifact(undefined).ok).toBe(false)
  })

  it('does not throw on a getter-throwing object', () => {
    const evil = {}
    Object.defineProperty(evil, 'schemaVersion', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    expect(() => parseCandidateFunnelArtifact(evil)).not.toThrow()
    expect(parseCandidateFunnelArtifact(evil).ok).toBe(false)
  })

  it('does not throw on a Proxy with a throwing ownKeys trap', () => {
    const evil = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom')
        },
      },
    )
    expect(() => parseCandidateFunnelArtifact(evil)).not.toThrow()
    expect(parseCandidateFunnelArtifact(evil).ok).toBe(false)
  })

  it('does not throw on NaN/Infinity-bearing values', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact.candidates[0].marketScore = Number.NaN
    expect(() => parseCandidateFunnelArtifact(artifact)).not.toThrow()
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)

    const artifact2 = buildValidCandidateFunnelArtifact()
    artifact2.candidates[0].marketScore = Number.POSITIVE_INFINITY
    expect(() => parseCandidateFunnelArtifact(artifact2)).not.toThrow()
    expect(parseCandidateFunnelArtifact(artifact2).ok).toBe(false)
  })

  it('does not throw on a self-referencing (circular) object', () => {
    const artifact = buildValidCandidateFunnelArtifact() as Record<string, unknown>
    ;(artifact as Record<string, unknown>).self = artifact
    expect(() => parseCandidateFunnelArtifact(artifact)).not.toThrow()
  })

  it('never leaks raw payload content into the failure result', () => {
    const secret = { schemaVersion: 'BAD', SECRET_TOKEN: 'do-not-leak' }
    const result = parseCandidateFunnelArtifact(secret)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(JSON.stringify(result)).not.toContain('do-not-leak')
  })
})
