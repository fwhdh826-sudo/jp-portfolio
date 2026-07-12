import { describe, expect, it } from 'vitest'
import type { Trust } from '../../types'
import { buildCandidateUniverse } from './buildCandidateUniverse'

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'test-fund',
    name: 'Test Fund',
    abbr: 'TF',
    account: 'NISA成長投資枠',
    policy: 'OVERSEAS_LONGTERM',
    eval: 0,
    pnlPct: 0,
    dayPct: 0,
    cost: 0.10,
    mu: 0.05,
    sigma: 0.10,
    score: 70,
    signal: '',
    ev: 0,
    decision: 'HOLD',
    ...overrides,
  }
}

describe('buildCandidateUniverse: candidate filter', () => {
  it('eval = 0: included as candidate', () => {
    const result = buildCandidateUniverse([makeTrust({ id: 'zero', eval: 0 })])
    expect(result).toHaveLength(1)
    expect(result[0].trust.id).toBe('zero')
  })

  it('eval < 0: included as candidate', () => {
    const result = buildCandidateUniverse([makeTrust({ id: 'negative', eval: -1 })])
    expect(result).toHaveLength(1)
    expect(result[0].trust.id).toBe('negative')
  })

  it('eval > 0: excluded from candidates', () => {
    const result = buildCandidateUniverse([makeTrust({ id: 'held', eval: 100_000 })])
    expect(result).toHaveLength(0)
  })

  it('mixed array: only eval <= 0 are returned', () => {
    const trusts = [
      makeTrust({ id: 'held-a',   eval: 500_000 }),
      makeTrust({ id: 'cand-a',   eval: 0       }),
      makeTrust({ id: 'held-b',   eval: 1        }),
      makeTrust({ id: 'cand-b',   eval: -500     }),
      makeTrust({ id: 'held-c',   eval: 100      }),
    ]
    const result = buildCandidateUniverse(trusts)
    expect(result).toHaveLength(2)
    expect(result.map(r => r.trust.id)).toEqual(['cand-a', 'cand-b'])
  })

  it('input order is preserved in output', () => {
    const trusts = [
      makeTrust({ id: 'first',  eval: 0  }),
      makeTrust({ id: 'second', eval: -1 }),
      makeTrust({ id: 'third',  eval: 0  }),
    ]
    const result = buildCandidateUniverse(trusts)
    expect(result.map(r => r.trust.id)).toEqual(['first', 'second', 'third'])
  })
})

describe('buildCandidateUniverse: asset type mapping', () => {
  it('JAPAN_SHORTTERM -> jp_trust', () => {
    const result = buildCandidateUniverse([makeTrust({ policy: 'JAPAN_SHORTTERM' })])
    expect(result[0].assetType).toBe('jp_trust')
  })

  it('OVERSEAS_LONGTERM -> global_trust', () => {
    const result = buildCandidateUniverse([makeTrust({ policy: 'OVERSEAS_LONGTERM' })])
    expect(result[0].assetType).toBe('global_trust')
  })

  it('GOLD -> gold', () => {
    const result = buildCandidateUniverse([makeTrust({ policy: 'GOLD' })])
    expect(result[0].assetType).toBe('gold')
  })

  it('unknown policy -> global_trust (fallback)', () => {
    const result = buildCandidateUniverse([
      makeTrust({ policy: 'UNKNOWN_POLICY' as unknown as Trust['policy'] }),
    ])
    expect(result[0].assetType).toBe('global_trust')
  })
})
