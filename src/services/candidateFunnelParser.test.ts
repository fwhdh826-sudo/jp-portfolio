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

function requiredGate(artifact: ReturnType<typeof buildValidCandidateFunnelArtifact>, id: string) {
  return artifact._meta.qualityGate.gates.find((gate: { id: string }) => gate.id === id)!
}

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
    const p15 = requiredGate(artifact, 'P-15')
    p15.value = null
    const result = parseCandidateFunnelArtifact(artifact)
    expect(result.ok).toBe(true)
  })

  it('accepts P-15 WARN', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    const p15 = requiredGate(artifact, 'P-15')
    p15.value = 0.25
    p15.status = 'WARN'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(true)
  })

  it('keeps P-15 WARN nonblocking when overallPass=true and hardFailIds=[]', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, 'P-15').status = 'WARN'
    artifact._meta.qualityGate.overallPass = true
    artifact._meta.qualityGate.hardFailIds = []
    const result = parseCandidateFunnelArtifact(artifact)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data._meta.qualityGate.overallPass).toBe(true)
    expect(result.data._meta.qualityGate.hardFailIds).toEqual([])
  })

  it('accepts P-15 RECORD', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, 'P-15').status = 'RECORD'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(true)
  })

  it('preserves P-15 N/A parsing semantics', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, 'P-15').status = 'N/A'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(true)
  })

  it.each(['P-03', 'P-09'])('accepts backend-authorized nonblocking WARN for %s', (id) => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, id).status = 'WARN'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(true)
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
  it('rejects P-14 WARN', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, 'P-14').status = 'WARN'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects WARN on an arbitrary required gate', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, 'P-01').status = 'WARN'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects WARN on an unknown auxiliary gate', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    const auxiliary = artifact._meta.qualityGate.gates.find((gate: { id: string }) => gate.id === 'PRESCREEN_DUPLICATE')!
    auxiliary.status = 'WARN'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects overallPass=false', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, 'P-15').status = 'WARN'
    artifact._meta.qualityGate.overallPass = false
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('rejects non-empty hardFailIds', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    requiredGate(artifact, 'P-15').status = 'WARN'
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
    const p14 = requiredGate(artifact, 'P-14')
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

describe('P5-B005-B3-C-V2-R1 FIX A — final published artifact status contract', () => {
  it('rejects a published artifact whose top-level status is not_generated', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact.status = 'not_generated'
    const result = parseCandidateFunnelArtifact(artifact)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // not_generated は engine/batch の outcome であり published state ではない。
    expect(result.code).toBe('unpublished_status')
  })

  it('rejects an unknown status string distinctly from the not_generated case', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact as { status: string }).status = 'partially_generated'
    const result = parseCandidateFunnelArtifact(artifact)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('invalid_status')
  })

  it('still accepts a well-formed status=generated artifact', () => {
    expect(parseCandidateFunnelArtifact(buildValidCandidateFunnelArtifact()).ok).toBe(true)
  })
})

describe('P5-B005-B3-C-V2-R1 FIX E — final published tier contract (eligible rejected)', () => {
  it('rejects a candidate whose published tier is eligible', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact.candidates[0].tier = 'eligible'
    const result = parseCandidateFunnelArtifact(artifact)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('invalid_tier')
  })

  it('rejects a candidate with an unknown tier', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact.candidates[0] as { tier: string }).tier = 'promoted'
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })

  it('accepts the published final tiers screened / deep_review / actionable', () => {
    expect(parseCandidateFunnelArtifact(buildValidCandidateFunnelArtifact()).ok).toBe(true)
  })

  it('accepts a well-formed excluded candidate entry with hardExclusionReasons', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    const base = structuredClone(artifact.candidates[0])
    artifact.candidates.push({
      ...base,
      code: '9999',
      name: '除外テスト銘柄',
      prescreenScore: null,
      prescreenRank: null,
      prescreenPool: null,
      rawCompositeScore: null,
      dataConfidence: null,
      marketScore: null,
      marketRank: null,
      tier: 'excluded',
      selectedReasons: [],
      riskReasons: [],
      hardExclusionReasons: ['HARD_NOT_PRIME_DOMESTIC', 'HARD_INSUFFICIENT_HISTORY'],
    })
    artifact.counts = { ...artifact.counts, total: 4, excluded: 1 }
    artifact.excludedSummary = {
      total: 1,
      byReason: { HARD_NOT_PRIME_DOMESTIC: 1, HARD_INSUFFICIENT_HISTORY: 1 },
    }
    const result = parseCandidateFunnelArtifact(artifact)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`expected ok: ${result.code}`)
    expect(result.data.candidates.find(c => c.code === '9999')?.tier).toBe('excluded')
  })

  it('preserves fail-closed counts behaviour when an excluded tally mismatches', () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact.counts = { ...artifact.counts, excluded: 5 }
    expect(parseCandidateFunnelArtifact(artifact).ok).toBe(false)
  })
})

describe('P5-B005-B3-C-V2-R2 P2-1 — degradationReasons exact producer contract', () => {
  // production backend authority（data/candidate_funnel_engine.py）は
  // "<known code>: <non-empty detail>" のみを emit する。frontend parser は
  // その形式に一致させ、bare code / colon 無し / 空 detail / 未知 code を
  // fail-closed で reject する（producer 権限を広げない）。
  function withReasons(reasons: unknown): ReturnType<typeof buildValidCandidateFunnelArtifact> {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact as { degradationReasons: unknown }).degradationReasons = reasons
    return artifact
  }

  it('accepts [] (no degradation)', () => {
    expect(parseCandidateFunnelArtifact(withReasons([])).ok).toBe(true)
  })

  it('accepts the frozen engine format "<code>: human-readable detail"', () => {
    expect(
      parseCandidateFunnelArtifact(
        withReasons([
          'STALE_SOURCE: source age exceeded threshold',
          'CACHE_FALLBACK_PROVENANCE: pipelinePath=cache_fallback',
          'DUPLICATE_CANDIDATE_CODE: 1 duplicate code(s), 2 record(s) excluded',
        ]),
      ).ok,
    ).toBe(true)
  })

  it.each([
    ['bare known code, no colon', 'STALE_SOURCE'],
    ['known code + colon, empty detail', 'STALE_SOURCE:'],
    ['known code + colon, whitespace-only detail', 'STALE_SOURCE:    '],
    ['known code + space-separated suffix (no colon)', 'STALE_SOURCE EVIL'],
    ['unknown code with colon + detail', 'UNKNOWN_CODE: detail'],
    ['known-code prefix but different token', 'STALE_SOURCE_EVIL: detail'],
    ['known-code prefix, no colon', 'STALE_SOURCE_EVIL'],
    ['empty string', ''],
  ])('rejects %s (fail-closed as invalid_status)', (_label, entry) => {
    const result = parseCandidateFunnelArtifact(withReasons([entry]))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('invalid_status')
  })

  it('rejects a non-string degradationReasons entry', () => {
    expect(parseCandidateFunnelArtifact(withReasons([{ code: 'STALE_SOURCE' }])).ok).toBe(false)
    expect(parseCandidateFunnelArtifact(withReasons([123])).ok).toBe(false)
    expect(parseCandidateFunnelArtifact(withReasons([null])).ok).toBe(false)
  })

  it('rejects the whole list if any single entry violates the contract', () => {
    const result = parseCandidateFunnelArtifact(
      withReasons(['STALE_SOURCE: valid detail', 'STALE_SOURCE']),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('invalid_status')
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
