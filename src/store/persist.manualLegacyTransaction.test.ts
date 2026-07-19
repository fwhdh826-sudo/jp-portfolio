import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding, LearningState, Trust } from '../types'
import {
  CSV_IMPORT_GENERATION_KEY,
  persistLegacyPortfolioGenerationTransaction,
} from './persist'

const PORTFOLIO_KEY = 'v81_portfolio'
const TRUST_KEY = 'v81_trust'
const LEARNING_KEY = 'v91_learning'
const POLICY_KEY = 'v13_portfolio_policy'
const CASH_KEY = 'v13_cash_assumptions'
const NOW_MS = Date.parse('2026-07-19T00:00:00.000Z')
const holdings = [{ code: 'NEW', eval: 200 }] as unknown as Holding[]
const trust = [{ id: 'new-trust', eval: 300 }] as unknown as Trust[]
const learning = { lastUpdated: '2026-07-19T00:00:00.000Z' } as unknown as LearningState

describe('RA-006-AUDIT-F001 legacy portfolio generation transaction', () => {
  const storage: Record<string, string> = {}
  const getItem = vi.fn((key: string) => storage[key] ?? null)
  const setItem = vi.fn((key: string, value: string) => { storage[key] = value })
  const removeItem = vi.fn((key: string) => { delete storage[key] })

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key]
    getItem.mockReset().mockImplementation((key: string) => storage[key] ?? null)
    setItem.mockReset().mockImplementation((key: string, value: string) => { storage[key] = value })
    removeItem.mockReset().mockImplementation((key: string) => { delete storage[key] })
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function seedMixedPreviousGeneration(): Record<string, string | undefined> {
    storage[PORTFOLIO_KEY] = JSON.stringify({ data: [{ code: 'OLD' }], savedAt: 1 })
    storage[LEARNING_KEY] = JSON.stringify({ data: { lastUpdated: 'old' }, savedAt: 1 })
    storage[POLICY_KEY] = 'untouched-policy'
    storage[CASH_KEY] = 'untouched-cash'
    return {
      [PORTFOLIO_KEY]: storage[PORTFOLIO_KEY],
      [TRUST_KEY]: undefined,
      [LEARNING_KEY]: storage[LEARNING_KEY],
      [POLICY_KEY]: storage[POLICY_KEY],
      [CASH_KEY]: storage[CASH_KEY],
    }
  }

  function expectPrevious(previous: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(previous)) expect(storage[key]).toBe(value)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  }

  it('persists portfolio, trust, and learning in deterministic order with one savedAt', () => {
    storage[POLICY_KEY] = 'policy-before'
    storage[CASH_KEY] = 'cash-before'
    const writes: string[] = []
    setItem.mockImplementation((key: string, value: string) => {
      writes.push(key)
      storage[key] = value
    })

    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust, learning }, NOW_MS))
      .toEqual({ status: 'persisted' })

    expect(writes).toEqual([PORTFOLIO_KEY, TRUST_KEY, LEARNING_KEY])
    const raws = [PORTFOLIO_KEY, TRUST_KEY, LEARNING_KEY].map(key => storage[key])
    expect(raws.map(raw => JSON.parse(raw).savedAt)).toEqual([NOW_MS, NOW_MS, NOW_MS])
    expect(JSON.parse(raws[0]).data).toEqual(holdings)
    expect(JSON.parse(raws[1]).data).toEqual(trust)
    expect(JSON.parse(raws[2]).data).toEqual(learning)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(storage[POLICY_KEY]).toBe('policy-before')
    expect(storage[CASH_KEY]).toBe('cash-before')
  })

  it.each([
    ['policy', { portfolioPolicy: { jpStockMaxRatio: 0.17 } }, POLICY_KEY],
    ['cash', { cashAssumptions: {
      cashDeposits: 1,
      standbyFunds: 2,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-19T00:00:00.000Z',
    } }, CASH_KEY],
  ] as const)('%s selects only its explicitly requested key', (_label, input, expectedKey) => {
    storage[PORTFOLIO_KEY] = 'portfolio-before'
    storage[TRUST_KEY] = 'trust-before'
    expect(persistLegacyPortfolioGenerationTransaction(input, NOW_MS)).toEqual({ status: 'persisted' })
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(expectedKey, expect.any(String))
    expect(storage[PORTFOLIO_KEY]).toBe('portfolio-before')
    expect(storage[TRUST_KEY]).toBe('trust-before')
  })

  it('invalid transaction clock fails closed before any write', () => {
    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust }, Number.NaN))
      .toEqual({ status: 'failed', reason: 'indeterminate' })
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })

  it.each([
    ['first before mutation', 1, false],
    ['first after mutation', 1, true],
    ['middle before mutation', 2, false],
    ['middle after mutation', 2, true],
    ['final before mutation', 3, false],
    ['final after mutation', 3, true],
  ] as const)('%s throw rolls the whole generation back', (_label, failAt, writeThenThrow) => {
    const previous = seedMixedPreviousGeneration()
    let candidateWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      const isCandidate = JSON.parse(value).savedAt === NOW_MS
      if (isCandidate) {
        candidateWrites += 1
        if (candidateWrites === failAt) {
          if (writeThenThrow) storage[key] = value
          throw new Error('injected write failure')
        }
      }
      storage[key] = value
    })

    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust, learning }, NOW_MS))
      .toEqual({ status: 'failed', reason: 'rolled_back' })
    expectPrevious(previous)
  })

  it('protects third-party bytes and safely restores only still-owned earlier targets', () => {
    const previous = seedMixedPreviousGeneration()
    let candidateWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      if (JSON.parse(value).savedAt === NOW_MS) {
        candidateWrites += 1
        if (candidateWrites === 2) {
          storage[key] = 'third-party-trust'
          throw new Error('ownership replaced')
        }
      }
      storage[key] = value
    })

    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust, learning }, NOW_MS))
      .toEqual({ status: 'failed', reason: 'ownership_lost' })
    expect(storage[PORTFOLIO_KEY]).toBe(previous[PORTFOLIO_KEY])
    expect(storage[TRUST_KEY]).toBe('third-party-trust')
    expect(storage[LEARNING_KEY]).toBe(previous[LEARNING_KEY])
  })

  it('classifies failed previous-byte restore as rollback_failed', () => {
    const previous = seedMixedPreviousGeneration()
    let candidateWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      const parsed = JSON.parse(value)
      if (parsed.savedAt === NOW_MS) {
        candidateWrites += 1
        storage[key] = value
        if (candidateWrites === 2) throw new Error('stop after middle write')
        return
      }
      if (key === PORTFOLIO_KEY) throw new Error('restore failed')
      storage[key] = value
    })

    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust, learning }, NOW_MS))
      .toEqual({ status: 'failed', reason: 'rollback_failed' })
    expect(storage[PORTFOLIO_KEY]).not.toBe(previous[PORTFOLIO_KEY])
    expect(storage[TRUST_KEY]).toBeUndefined()
  })

  it('classifies failed absent-byte remove as rollback_failed', () => {
    seedMixedPreviousGeneration()
    let candidateWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      if (JSON.parse(value).savedAt === NOW_MS) {
        candidateWrites += 1
        storage[key] = value
        if (candidateWrites === 2) throw new Error('stop after middle write')
        return
      }
      storage[key] = value
    })
    removeItem.mockImplementation(key => {
      if (key === TRUST_KEY) throw new Error('remove failed')
      delete storage[key]
    })

    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust, learning }, NOW_MS))
      .toEqual({ status: 'failed', reason: 'rollback_failed' })
    expect(storage[TRUST_KEY]).toBeDefined()
  })

  it('accepts rollback write-then-throw when physical previous bytes were restored', () => {
    const previous = seedMixedPreviousGeneration()
    let candidateWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      const parsed = JSON.parse(value)
      if (parsed.savedAt === NOW_MS) {
        candidateWrites += 1
        storage[key] = value
        if (candidateWrites === 2) throw new Error('stop after middle write')
        return
      }
      storage[key] = value
      if (key === PORTFOLIO_KEY) throw new Error('restore acknowledgement lost')
    })

    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust, learning }, NOW_MS))
      .toEqual({ status: 'failed', reason: 'rolled_back' })
    expectPrevious(previous)
  })

  it('stops on canonical appearance, rolls back owned legacy bytes, and leaves canonical bytes untouched', () => {
    const previous = seedMixedPreviousGeneration()
    const externalCanonical = 'external-canonical-bytes'
    let candidateWrites = 0
    setItem.mockImplementation((key: string, value: string) => {
      storage[key] = value
      if (JSON.parse(value).savedAt === NOW_MS && ++candidateWrites === 1) {
        storage[CSV_IMPORT_GENERATION_KEY] = externalCanonical
      }
    })

    expect(persistLegacyPortfolioGenerationTransaction({ holdings, trust, learning }, NOW_MS))
      .toEqual({ status: 'blocked', reason: 'canonical_changed' })
    expect(storage[PORTFOLIO_KEY]).toBe(previous[PORTFOLIO_KEY])
    expect(storage[TRUST_KEY]).toBeUndefined()
    expect(storage[LEARNING_KEY]).toBe(previous[LEARNING_KEY])
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalCanonical)
  })

  it('serialization failure performs zero writes after complete preflight capture', () => {
    const unserializable = [{ code: 'BIG', eval: BigInt(1) }] as unknown as Holding[]
    expect(persistLegacyPortfolioGenerationTransaction({ holdings: unserializable, trust }, NOW_MS))
      .toEqual({ status: 'failed', reason: 'indeterminate' })
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })
})
