import { describe, expect, it } from 'vitest'
import { INITIAL_TRUST } from '../../constants/trust'
import type { Trust } from '../../types'
import {
  buildTrustAllocationCandidates,
  trustAllocationInstrumentId,
} from './trustAllocationCandidates'

const shortTermTrusts = INITIAL_TRUST.filter(trust => trust.policy === 'JAPAN_SHORTTERM')

describe('R3-c1 canonical JP_TRUST candidate adapter', () => {
  it('J-T01 emits the same canonical identity used by trust instruments', () => {
    const result = buildTrustAllocationCandidates({ trust: INITIAL_TRUST })
    expect(result.status).toBe('available')
    expect(result.candidates.map(candidate => candidate.instrumentId)).toEqual(
      shortTermTrusts.map(trust => trustAllocationInstrumentId(trust)),
    )
    expect(result.candidates.every(candidate => candidate.instrumentId.startsWith('trust:'))).toBe(true)
  })

  it('J-T02 admits only E4-eligible trusts', () => {
    const blocked = { ...shortTermTrusts[0], notForTrading: true }
    const input = [
      blocked,
      ...INITIAL_TRUST.filter(trust => trust.id !== blocked.id),
    ]
    const result = buildTrustAllocationCandidates({ trust: input })
    const eligibleIds = new Set(
      input
        .filter(trust => trust.policy === 'JAPAN_SHORTTERM' && trust.notForTrading !== true)
        .map(trust => `trust:${trust.id}`),
    )
    expect(new Set(result.candidates.map(candidate => candidate.instrumentId))).toEqual(eligibleIds)
    expect(result.candidates).toHaveLength(shortTermTrusts.length - 1)
  })

  it('J-T08 fails closed for duplicate canonical identity', () => {
    const duplicate = [INITIAL_TRUST[0], { ...INITIAL_TRUST[0] }]
    expect(buildTrustAllocationCandidates({ trust: duplicate })).toEqual({
      status: 'invalid',
      candidates: [],
    })
  })

  it.each([
    ['empty', ''],
    ['unknown', 'unknown-trust-id'],
    ['null', null],
  ] as const)('fails closed for %s registry identity', (_case, id) => {
    const malformed = { ...INITIAL_TRUST[0], id } as unknown as Trust
    expect(trustAllocationInstrumentId(malformed)).toBeNull()
    expect(buildTrustAllocationCandidates({ trust: [malformed] })).toEqual({
      status: 'invalid',
      candidates: [],
    })
  })

  it('fails closed when a registry identity is presented under the wrong asset-class policy', () => {
    const classMismatch = { ...INITIAL_TRUST[0], policy: 'OVERSEAS_LONGTERM' as const }
    expect(buildTrustAllocationCandidates({ trust: [classMismatch] })).toEqual({
      status: 'invalid',
      candidates: [],
    })
  })

  it('J-T09 treats an absent trust master as a valid empty candidate set', () => {
    expect(buildTrustAllocationCandidates({ trust: [] })).toEqual({
      status: 'available',
      candidates: [],
    })
  })

  it('J-T11 derives BUY_MORE only from positive current evaluation', () => {
    const [first, second] = shortTermTrusts
    const result = buildTrustAllocationCandidates({
      trust: [{ ...first, eval: 1 }, { ...second, eval: 0 }],
    })
    expect(result.candidates.map(candidate => candidate.buyKind)).toEqual(['BUY_MORE', 'BUY_NEW'])
  })

  it('J-T12 keeps registry positions as deterministic artifact indexes', () => {
    const result = buildTrustAllocationCandidates({ trust: INITIAL_TRUST })
    expect(result.candidates.map(candidate => candidate.artifactIndex)).toEqual(
      INITIAL_TRUST.flatMap((trust, index) => trust.policy === 'JAPAN_SHORTTERM' ? [index] : []),
    )
    expect(result.candidates.map(candidate => candidate.marketRank)).toEqual(
      result.candidates.map(() => null),
    )
  })

  it('J-T13 never converts score, mu, sigma, or ev into confidence or rank', () => {
    const trust = {
      ...shortTermTrusts[0],
      score: 100,
      mu: 999,
      sigma: 0.0001,
      ev: 999,
    }
    const [candidate] = buildTrustAllocationCandidates({ trust: [trust] }).candidates
    expect(candidate).toMatchObject({ confidence: null, marketRank: null })
    expect(candidate).not.toHaveProperty('amount')
    expect(candidate).not.toHaveProperty('targetGap')
    expect(candidate).not.toHaveProperty('budget')
  })

  it('returns deeply immutable adapter output', () => {
    const result = buildTrustAllocationCandidates({ trust: shortTermTrusts })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.candidates)).toBe(true)
    expect(result.candidates.every(Object.isFrozen)).toBe(true)
  })
})
