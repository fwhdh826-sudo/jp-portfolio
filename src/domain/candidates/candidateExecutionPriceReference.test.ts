// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CandidatesStocksData, StockCandidateItem } from '../../types/candidatesStocks'
import { normalizePortfolioFitCode } from './portfolioFit'
import {
  captureCandidateExecutionPriceDatasetProvenance,
  captureCandidateExecutionPriceReferences,
} from './candidateExecutionPriceReference'

const NOW = Date.parse('2026-08-14T10:00:00.000Z')

function item(overrides: Partial<StockCandidateItem> = {}): StockCandidateItem {
  return {
    code: '5108',
    name: 'ブリヂストン',
    sector: 'ゴム製品',
    price: 4129,
    per: 20.9,
    pbr: 1.3,
    roe: 11.2,
    dividendYield: 3.0,
    sigma252d: 0.23,
    mom3m: 25.8,
    screenReasons: [],
    dataStatus: 'ok',
    ...overrides,
  }
}

function dataset(overrides: Partial<CandidatesStocksData> = {}): CandidatesStocksData {
  return {
    schemaVersion: 'candidates-stocks-1',
    updatedAt: '2026-08-14T07:10:58.528827+09:00',
    sourceUpdatedAt: '2026-08-14T07:10:58.528827+09:00',
    staleThresholdHours: 48,
    _meta: {
      kind: 'candidates_stocks',
      source: 'jpx',
      not_for_trading: true,
      universe: 'whole_market',
      note: 'note',
      runToken: 'run-1',
    },
    candidates: [item()],
    missing: [],
    status: 'ok',
    ...overrides,
  }
}

describe('CAND-SYN-1B captureCandidateExecutionPriceDatasetProvenance', () => {
  it('captures dataset provenance verbatim when usable', () => {
    const result = captureCandidateExecutionPriceDatasetProvenance(dataset(), 'loaded', NOW)
    expect(result).toEqual({
      usable: true,
      updatedAt: '2026-08-14T07:10:58.528827+09:00',
      sourceUpdatedAt: '2026-08-14T07:10:58.528827+09:00',
      runToken: 'run-1',
    })
  })

  it('B19 source=default yields unusable with null provenance (no fake token)', () => {
    const result = captureCandidateExecutionPriceDatasetProvenance(dataset(), 'default', NOW)
    expect(result).toEqual({ usable: false, updatedAt: null, sourceUpdatedAt: null, runToken: null })
  })

  it('B18 stale dataset yields unusable with null provenance', () => {
    const staleNow = Date.parse('2026-08-20T00:00:00.000Z') // > 48h past updatedAt
    const result = captureCandidateExecutionPriceDatasetProvenance(dataset(), 'loaded', staleNow)
    expect(result).toEqual({ usable: false, updatedAt: null, sourceUpdatedAt: null, runToken: null })
  })

  it('B20 missing runToken is preserved as null, never synthesized', () => {
    const noToken = dataset({ _meta: { ...dataset()._meta, runToken: undefined } })
    const result = captureCandidateExecutionPriceDatasetProvenance(noToken, 'loaded', NOW)
    expect(result.usable).toBe(true)
    expect(result.runToken).toBeNull()
  })

  it('status=empty is unusable', () => {
    const result = captureCandidateExecutionPriceDatasetProvenance(
      dataset({ status: 'empty' }),
      'loaded',
      NOW,
    )
    expect(result.usable).toBe(false)
  })
})

describe('CAND-SYN-1B captureCandidateExecutionPriceReferences (join direction: funnel -> candidates_stocks)', () => {
  it('B12 authorized funnel candidate with exact code match -> AVAILABLE, priceJpy = ceil(raw)', () => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset({ candidates: [item({ code: '5108', price: 4129.4 })] }),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references).toEqual([{
      instrumentId: 'stock:5108',
      code: '5108',
      status: 'AVAILABLE',
      rawPrice: 4129.4,
      priceJpy: 4130,
      lotSizeShares: 100,
      reason: null,
    }])
  })

  it('B13 missing price match -> UNAVAILABLE, no executable price authority', () => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset({ candidates: [item({ code: '9999' })] }),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0]).toMatchObject({ status: 'UNAVAILABLE', reason: 'EXECUTION_PRICE_UNAVAILABLE', priceJpy: null })
  })

  it('B14 duplicate normalized code in candidates_stocks -> fail-closed AMBIGUOUS (does not silently pick first)', () => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset({ candidates: [item({ code: '5108', price: 100 }), item({ code: '5108.T', price: 200 })] }),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0]).toMatchObject({ status: 'AMBIGUOUS', reason: 'EXECUTION_PRICE_AMBIGUOUS', priceJpy: null })
  })

  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -5],
  ])('B15 non-positive/NaN price (%s) -> UNAVAILABLE, not INVALID', (_label, price) => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset({ candidates: [item({ code: '5108', price })] }),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0].status).toBe('UNAVAILABLE')
    expect(result.references[0].priceJpy).toBeNull()
  })

  it.each([
    [331.5, 332],
    [677.7, 678],
    [2958.5, 2959],
    [100, 100],
  ])('B16 decimal raw price %s -> Math.ceil exact normalization %s', (raw, expected) => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset({ candidates: [item({ code: '5108', price: raw })] }),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0].priceJpy).toBe(expected)
  })

  it('B17 AVAILABLE result always carries lotSizeShares=100 and no price×lot computation is present', () => {
    const source = readFileSync(new URL('./candidateExecutionPriceReference.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/priceJpy\s*\*|lotSizeShares\s*\*|\*\s*lotSizeShares/)
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset(),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0].lotSizeShares).toBe(100)
  })

  it('B18 stale dataset marks per-candidate references STALE, not UNAVAILABLE, distinguishing cause', () => {
    const staleNow = Date.parse('2026-08-20T00:00:00.000Z')
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset(),
      candidatesStocksSource: 'loaded',
      now: staleNow,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0].status).toBe('STALE')
    expect(result.datasetProvenance.usable).toBe(false)
  })

  it('B19 source=default (never loaded) -> UNAVAILABLE, not STALE', () => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset(),
      candidatesStocksSource: 'default',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0].status).toBe('UNAVAILABLE')
  })

  it('malformed candidate code -> INVALID (fail closed, no join attempted)', () => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset(),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:bad', code: '' }],
    })
    expect(result.references[0].status).toBe('INVALID')
  })

  it('dataStatus=partial in candidates_stocks -> UNAVAILABLE (not treated as a valid price authority)', () => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset({ candidates: [item({ code: '5108', dataStatus: 'partial' })] }),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references[0].status).toBe('UNAVAILABLE')
  })

  it('a symbol present only in candidates_stocks never surfaces as a reference (join starts from the funnel candidate list)', () => {
    const result = captureCandidateExecutionPriceReferences({
      candidatesStocks: dataset({ candidates: [item({ code: '5108' }), item({ code: '9999', name: 'stocks-only' })] }),
      candidatesStocksSource: 'loaded',
      now: NOW,
      candidates: [{ instrumentId: 'stock:5108', code: '5108' }],
    })
    expect(result.references).toHaveLength(1)
    expect(result.references[0].code).toBe('5108')
  })
})

describe('CAND-SYN-1B real production artifact compatibility (§33)', () => {
  // public/data/candidates_stocks.json is mutable generated production data:
  // candidate membership legitimately changes between valid scheduled runs
  // (e.g. the current seed-fallback pipeline publishes 41 seed names and no
  // 5108). Compatibility here means "a candidate actually present in the
  // checked-in artifact joins correctly", never "5108 is present forever".
  const ARTIFACT_URL = new URL('../../../public/data/candidates_stocks.json', import.meta.url)
  const raw = readFileSync(ARTIFACT_URL, 'utf8')
  const real = JSON.parse(raw) as CandidatesStocksData

  interface UsableRealEntry {
    readonly normalizedCode: string
    readonly price: number
  }

  /**
   * Test-side usability predicate for the real-artifact positive join probe,
   * grounded in the production join contract:
   *  - the code normalizes 'valid' under the same normalizePortfolioFitCode
   *    authority the runtime joins on
   *  - dataStatus === 'ok'
   *  - price is finite and strictly positive
   *  - the normalized code is unambiguous within the artifact (the runtime
   *    fail-closes a duplicated normalized code to AMBIGUOUS).
   * Result is sorted deterministically by normalized code — no reliance on
   * array position, a fixed code/name/sector, or today's candidate count.
   */
  function usableRealEntries(data: CandidatesStocksData): UsableRealEntry[] {
    const normalizedCounts = new Map<string, number>()
    for (const c of data.candidates) {
      const n = normalizePortfolioFitCode(c.code)
      if (n.status !== 'valid' || n.normalizedCode === null) continue
      normalizedCounts.set(n.normalizedCode, (normalizedCounts.get(n.normalizedCode) ?? 0) + 1)
    }
    return data.candidates
      .map((item): UsableRealEntry | null => {
        const n = normalizePortfolioFitCode(item.code)
        if (n.status !== 'valid' || n.normalizedCode === null) return null
        if ((normalizedCounts.get(n.normalizedCode) ?? 0) !== 1) return null
        const price = item.price
        if (item.dataStatus !== 'ok') return null
        if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null
        return { normalizedCode: n.normalizedCode, price }
      })
      .filter((e): e is UsableRealEntry => e !== null)
      .sort((a, b) => a.normalizedCode.localeCompare(b.normalizedCode))
  }

  it('captures real dataset provenance without mutating the file', () => {
    const before = readFileSync(ARTIFACT_URL, 'utf8')
    const provenance = captureCandidateExecutionPriceDatasetProvenance(real, 'loaded', Date.parse(real.updatedAt))
    expect(provenance.updatedAt).toBe(real.updatedAt)
    expect(provenance.sourceUpdatedAt).toBe(real.sourceUpdatedAt)
    expect(provenance.runToken).toBe(real._meta.runToken ?? null)
    const after = readFileSync(ARTIFACT_URL, 'utf8')
    expect(after).toBe(before)
  })

  it('real authorized-funnel-shaped join resolves a currently-present usable candidate (dynamic membership, not a fixed 5108)', () => {
    const before = readFileSync(ARTIFACT_URL, 'utf8')
    const usable = usableRealEntries(real)

    if (real.candidates.length === 0) {
      // CASE A — genuinely empty artifact: fail closed, never fabricate a
      // usable entry or an AVAILABLE reference.
      expect(usable).toHaveLength(0)
      const result = captureCandidateExecutionPriceReferences({
        candidatesStocks: real,
        candidatesStocksSource: 'loaded',
        now: Date.parse(real.updatedAt),
        candidates: [],
      })
      expect(result.references).toEqual([])
    } else if (usable.length === 0) {
      // CASE B — non-empty artifact with no usable execution-price entry:
      // deterministic probes of the actual candidates must not manufacture a
      // fake AVAILABLE executable price; executable price/lot stays null.
      const probes = [...real.candidates]
        .map(c => normalizePortfolioFitCode(c.code).normalizedCode)
        .filter((c): c is string => c !== null)
        .sort((a, b) => a.localeCompare(b))
        .map(code => ({ instrumentId: `stock:${code}`, code }))
      const result = captureCandidateExecutionPriceReferences({
        candidatesStocks: real,
        candidatesStocksSource: 'loaded',
        now: Date.parse(real.updatedAt),
        candidates: probes,
      })
      for (const ref of result.references) {
        expect(ref.status).not.toBe('AVAILABLE')
        expect(ref.priceJpy).toBeNull()
        expect(ref.lotSizeShares).toBeNull()
      }
    } else {
      // Positive real-artifact join: first usable entry by normalized code.
      const selected = usable[0]
      const result = captureCandidateExecutionPriceReferences({
        candidatesStocks: real,
        candidatesStocksSource: 'loaded',
        now: Date.parse(real.updatedAt),
        candidates: [{ instrumentId: `stock:${selected.normalizedCode}`, code: selected.normalizedCode }],
      })
      expect(result.references).toHaveLength(1)
      const ref = result.references[0]
      expect(ref.status).toBe('AVAILABLE')
      expect(ref.code).toBe(selected.normalizedCode)
      expect(ref.rawPrice).toBe(selected.price)
      expect(ref.priceJpy).toBe(Math.ceil(selected.price))
      expect(ref.priceJpy).toBeGreaterThan(0)
      expect(ref.lotSizeShares).toBe(100)
      expect(ref.reason).toBeNull()
      expect(result.datasetProvenance.usable).toBe(true)
    }

    // §10 file immutability: exact byte equality, no write path.
    expect(readFileSync(ARTIFACT_URL, 'utf8')).toBe(before)
  })

  it('the real-artifact join contract does not depend on code 5108 being a member', () => {
    // 5108 is legitimately absent under the current seed-fallback artifact.
    // Prove the positive join path is driven by dynamic membership: removing
    // 5108 from a production-like clone leaves the contract intact whenever
    // another usable entry exists, and a direct "must contain 5108" assertion
    // would fail against the current artifact.
    const has5108 = real.candidates.some(
      c => normalizePortfolioFitCode(c.code).normalizedCode === '5108',
    )
    const without5108: CandidatesStocksData = {
      ...real,
      candidates: real.candidates.filter(
        c => normalizePortfolioFitCode(c.code).normalizedCode !== '5108',
      ),
    }
    const usable = usableRealEntries(without5108)

    if (usable.length > 0) {
      const selected = usable[0]
      expect(selected.normalizedCode).not.toBe('5108')
      const result = captureCandidateExecutionPriceReferences({
        candidatesStocks: without5108,
        candidatesStocksSource: 'loaded',
        now: Date.parse(without5108.updatedAt),
        candidates: [{ instrumentId: `stock:${selected.normalizedCode}`, code: selected.normalizedCode }],
      })
      expect(result.references[0].status).toBe('AVAILABLE')
      expect(result.references[0].lotSizeShares).toBe(100)
    } else {
      // No usable entry once 5108 is excluded — then 5108 cannot have been a
      // silent load-bearing member of the real artifact either.
      expect(has5108).toBe(false)
    }
  })

  it('every real candidates_stocks price, when finite and positive, normalizes deterministically', () => {
    const candidates = real.candidates.slice(0, 50).map(c => ({ instrumentId: `stock:${c.code}`, code: c.code }))
    const first = captureCandidateExecutionPriceReferences({
      candidatesStocks: real, candidatesStocksSource: 'loaded', now: Date.parse(real.updatedAt), candidates,
    })
    const second = captureCandidateExecutionPriceReferences({
      candidatesStocks: real, candidatesStocksSource: 'loaded', now: Date.parse(real.updatedAt), candidates: [...candidates].reverse(),
    })
    const byInstrument = (list: typeof first.references) =>
      [...list].sort((a, b) => a.instrumentId.localeCompare(b.instrumentId))
    expect(byInstrument(second.references)).toEqual(byInstrument(first.references))
  })
})
