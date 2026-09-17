import { describe, expect, it } from 'vitest'
import type { CandidateFunnelArtifact, Holding } from '../../types'
import { buildValidCandidateFunnelArtifact } from '../../services/candidateFunnelArtifact.fixtures'
import {
  buildCandidateAllocationInputs,
  candidateAllocationInstrumentId,
} from './candidatePortfolioRecommendation'

function artifact(): CandidateFunnelArtifact {
  return structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
}

function holding(code: string, evalAmount = 1): Holding {
  return {
    code,
    name: 'holding',
    eval: evalAmount,
    pnlPct: 0,
    mu: 0,
    sigma: 0.1,
    sigmaSource: 'static',
    beta: 1,
    sector: '銀行業',
    target: 0,
    alert: 0,
    lock: false,
    mitsu: false,
    ma: false,
    rsi: 50,
    macd: false,
    vol: false,
    mom3m: 0,
    roe: 0,
    per: 0,
    pbr: 0,
    epsG: 0,
    cfOk: false,
    de: 0,
    divG: 0,
    score: 0,
    decision: 'HOLD',
    ev: 0,
  }
}

describe('HR-I3 canonical candidate allocation input adapter', () => {
  it('normalizes one canonical identity without using a display label', () => {
    expect(candidateAllocationInstrumentId(' １００３.t ')).toBe('stock:1003')
    expect(candidateAllocationInstrumentId('テスト銘柄1003')).toBeNull()
  })

  it('keeps asset-class identity separated by the stock namespace', () => {
    const result = buildCandidateAllocationInputs({ artifact: artifact(), holdings: [] })
    expect(result.instruments.map(item => item.instrumentId)).toEqual(['stock:1002', 'stock:1003'])
    expect(result.instruments.every(item => item.assetClass === 'JP_STOCK')).toBe(true)
    expect(result.instruments.every(item => !item.instrumentId.startsWith('trust:'))).toBe(true)
  })

  it('fails closed for a missing identity without manufacturing an id', () => {
    const value = artifact()
    value.candidates[1].code = ''
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result).toMatchObject({ status: 'invalid', instruments: [], candidates: [] })
  })

  it('fails closed for duplicate normalized identities instead of silent overwrite', () => {
    const value = artifact()
    value.candidates[2].code = '１００２.T'
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result).toMatchObject({ status: 'invalid', instruments: [], candidates: [] })
  })

  it('does not join by title, label, or array position', () => {
    const value = artifact()
    value.candidates[1].name = value.candidates[2].name
    value.candidates.reverse()
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result.status).toBe('available')
    expect(result.candidates.map(item => item.instrumentId)).toEqual(['stock:1003', 'stock:1002'])
    expect(result.candidates.map(item => item.artifactIndex)).toEqual([0, 1])
  })

  it('uses stable market-rank then artifact ordering', () => {
    const value = artifact()
    value.candidates[1].marketRank = 3
    value.candidates[2].marketRank = 1
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result.candidates.map(item => item.instrumentId)).toEqual(['stock:1003', 'stock:1002'])
  })

  it('is deterministic and retains the source candidate generation', () => {
    const value = artifact()
    const first = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    const second = buildCandidateAllocationInputs({ artifact: structuredClone(value), holdings: [] })
    expect(second).toEqual(first)
    expect(first.sourceCandidateGenerationId).toBe(value._meta.generatedAt)
  })

  it('excludes an exact held identity but not a same-name candidate', () => {
    const value = artifact()
    value.candidates[2].name = 'holding'
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [holding('1002.T')] })
    expect(result.candidates.map(item => item.instrumentId)).toEqual(['stock:1003'])
  })

  it('never synthesizes price, lot, or 100 shares', () => {
    const result = buildCandidateAllocationInputs({ artifact: artifact(), holdings: [] })
    expect(result.instruments).not.toHaveLength(0)
    for (const instrument of result.instruments) {
      expect(instrument.priceJpy).toBeNull()
      expect(instrument.lotSizeShares).toBeNull()
      expect(JSON.stringify(instrument)).not.toContain('100 shares')
    }
  })

  it('does not convert score or confidence into JPY', () => {
    const value = artifact()
    value.candidates[2].dataConfidence = 0.37
    value.candidates[2].marketScore = 99_999_999
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result.candidates.find(item => item.instrumentId === 'stock:1003')?.confidence).toBe(0.37)
    expect(JSON.stringify(result)).not.toContain('99999999')
  })

  it('returns no fake candidate when the loader is unavailable or the set is empty', () => {
    expect(buildCandidateAllocationInputs({ artifact: null, holdings: [] }))
      .toEqual({ status: 'unavailable', sourceCandidateGenerationId: null, instruments: [], candidates: [] })
    const value = artifact()
    value.candidates = value.candidates.map(candidate => ({ ...candidate, tier: 'screened' }))
    expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] })).toMatchObject({
      status: 'available',
      instruments: [],
      candidates: [],
    })
  })

  it('fails closed for invalid artifact authority and invalid holding identity', () => {
    const invalid = artifact()
    invalid._meta.qualityGate.overallPass = false
    expect(buildCandidateAllocationInputs({ artifact: invalid, holdings: [] }).status).toBe('invalid')
    expect(buildCandidateAllocationInputs({ artifact: artifact(), holdings: [holding('bad code')] }))
      .toMatchObject({ status: 'invalid', instruments: [], candidates: [] })
  })
  it('S-T20 excludes a normalized held identity even when eval is zero', () => {
    const result = buildCandidateAllocationInputs({
      artifact: artifact(),
      holdings: [holding(' １００２.t ', 0)],
    })
    expect(result.status).toBe('available')
    expect(result.candidates.map(item => item.instrumentId)).toEqual(['stock:1003'])
  })

  it('keeps the raw candidate display code while canonical identity is separate', () => {
    const value = artifact()
    value.candidates[1].code = ' １００２.t '
    const raw = value.candidates[1].code
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(value.candidates[1].code).toBe(raw)
    expect(result.instruments.map(item => item.instrumentId)).toContain('stock:1002')
  })
})

// ═══════════════════════════════════════════════════════════
// OPS_P5_B005_FCA_1_P1_REPAIR_R1: typed entry point defense in depth.
// These calls bypass the runtime parser on purpose (typed internal input)
// and must still fail closed on malformed producer evidence.
// ═══════════════════════════════════════════════════════════
describe('FCA-1-P1-02 direct adapter path: invalid non-null rank never becomes an available null-ranked candidate', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'marketRank %s on an actionable candidate => status invalid, no candidates',
    (rank) => {
      const value = artifact()
      value.candidates[2].marketRank = rank
      const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
      expect(result).toMatchObject({ status: 'invalid', instruments: [], candidates: [] })
      expect(JSON.stringify(result)).not.toContain('BUY_NEW')
    },
  )

  it('marketRank 0 on a non-allocation (screened) candidate still invalidates the artifact', () => {
    const value = artifact()
    value.candidates[0].marketRank = 0
    expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] }).status).toBe('invalid')
  })

  // FCA-1-P1-02 (R2): producer emits marketRank=null only for tier=excluded.
  // A non-excluded null rank is malformed evidence; it is no longer a
  // "legitimate null" that sorts last — the whole artifact fails closed.
  it.each([
    ['actionable', 2],
    ['deep_review', 1],
    ['screened', 0],
  ] as const)('%s candidate (index %i) with marketRank=null => status invalid, no candidates, no BUY_NEW', (_tier, index) => {
    const value = artifact()
    expect(value.candidates[index].tier).toBe(_tier)
    value.candidates[index].marketRank = null
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result).toMatchObject({ status: 'invalid', instruments: [], candidates: [] })
    expect(JSON.stringify(result)).not.toContain('BUY_NEW')
    expect(result.candidates.some(item => item.marketRank === null)).toBe(false)
  })

  it('excluded candidate with marketRank=null is accepted and never enters the allocation set', () => {
    const value = artifact()
    value.candidates[0] = {
      ...value.candidates[0],
      tier: 'excluded',
      marketRank: null,
      prescreenRank: null,
      marketScore: null,
      selectedReasons: [],
      hardExclusionReasons: ['HARD_NOT_PRIME_DOMESTIC'],
    }
    value.candidates[1].marketRank = 2
    value.candidates[2].marketRank = 1
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result.status).toBe('available')
    expect(result.candidates.map(item => [item.instrumentId, item.marketRank])).toEqual([
      ['stock:1003', 1],
      ['stock:1002', 2],
    ])
  })

  it('excluded candidate with a non-null marketRank is malformed and fails closed', () => {
    const value = artifact()
    value.candidates[0] = { ...value.candidates[0], tier: 'excluded', marketRank: 3, selectedReasons: [] }
    expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] }).status).toBe('invalid')
  })

  it('valid rank order is unchanged: marketRank ascending', () => {
    const value = artifact()
    value.candidates[1].marketRank = 2
    value.candidates[2].marketRank = 1
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result.candidates.map(item => item.instrumentId)).toEqual(['stock:1003', 'stock:1002'])
  })

  it('artifactIndex tie-break is unchanged for equal valid ranks', () => {
    const value = artifact()
    value.candidates[1].marketRank = 1
    value.candidates[2].marketRank = 1
    const result = buildCandidateAllocationInputs({ artifact: value, holdings: [] })
    expect(result.candidates.map(item => item.artifactIndex)).toEqual([1, 2])
  })
})

describe('FCA-1-P1-01 direct adapter path: contradictory quality gate is not available evidence', () => {
  it('gate FAIL with green aggregates => invalid', () => {
    const value = artifact()
    value._meta.qualityGate.gates.find(g => g.id === 'P-02')!.status = 'FAIL'
    expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] }))
      .toMatchObject({ status: 'invalid', candidates: [] })
  })

  it('hardFailIds naming a passing gate => invalid', () => {
    const value = artifact()
    value._meta.qualityGate.overallPass = false
    value._meta.qualityGate.hardFailIds = ['P-02']
    expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] }).status).toBe('invalid')
  })

  it('allowed P-14 WARN with coherent green aggregates stays available', () => {
    const value = artifact()
    value._meta.qualityGate.gates.find(g => g.id === 'P-14')!.status = 'WARN'
    expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] }).status).toBe('available')
  })
})

describe('FCA-1-P1-03 direct adapter path: generatedAt must be a strict producer timestamp', () => {
  it.each(['', '2026-09-31T00:00:00+00:00', '2026-07-26T07:11:40', 'not-a-timestamp'])(
    'generatedAt %j => invalid',
    (generatedAt) => {
      const value = artifact()
      value._meta.generatedAt = generatedAt
      expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] }))
        .toMatchObject({ status: 'invalid', candidates: [] })
    },
  )

  it('canonical microsecond producer timestamp stays available', () => {
    const value = artifact()
    value._meta.generatedAt = '2026-07-26T07:11:40.540540+00:00'
    expect(buildCandidateAllocationInputs({ artifact: value, holdings: [] }).status).toBe('available')
  })
})
