/**
 * P5-B002a: loadCandidatesStocks fail-soft regression tests
 *
 * candidates_stocks.json は市場公開情報のみのobservability-only JSON。
 * 404 / ネットワーク断 / schema不一致 / 型破損時は、既存の
 * loadCandidatesNews と同じくDEFAULT_CANDIDATES_STOCKS_DATAへfail-softする
 * ことをここで固定する（officialDecisionへの接続はB002b以降）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadCandidatesStocks, DEFAULT_CANDIDATES_STOCKS_DATA } from './loadStaticData'

const VALID_DATA = {
  schemaVersion: 'candidates-stocks-1',
  updatedAt: '2026-07-06T00:00:00+09:00',
  sourceUpdatedAt: '2026-07-06T00:00:00+09:00',
  staleThresholdHours: 48,
  _meta: {
    kind: 'candidates_stocks',
    source: 'data/build_candidates_stocks.py + yfinance',
    not_for_trading: true,
    universe: 'seed_list_v1',
    note: '市場公開情報のみ。個人資産・保有実額・現金・口座情報は含まない',
  },
  candidates: [
    {
      code: '7203', name: 'トヨタ自動車', sector: '自動車',
      price: 2923.0, per: 9.9, pbr: 0.95, roe: 10.23, dividendYield: 3.54,
      sigma252d: 0.3307, mom3m: -13.3, screenReasons: ['低PER', '高ROE'],
      dataStatus: 'ok',
    },
  ],
  missing: [],
  status: 'ok',
}

function mockFetchOk(data: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  }))
}

function mockFetchHttpError(status = 404) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  }))
}

function mockFetchNetworkError() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadCandidatesStocks', () => {
  it('happy path: 有効なschema → source:loaded, dataそのまま', async () => {
    mockFetchOk(VALID_DATA)
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('loaded')
    expect(result.data.candidates).toHaveLength(1)
    expect(result.data.candidates[0].code).toBe('7203')
  })

  it('空candidates配列は許容される（新規候補ゼロ日）', async () => {
    mockFetchOk({ ...VALID_DATA, candidates: [], missing: [], status: 'ok' })
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('loaded')
    expect(result.data.candidates).toEqual([])
  })

  it('HTTP 404: source:default, DEFAULT_CANDIDATES_STOCKS_DATAへfail-soft', async () => {
    mockFetchHttpError(404)
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('default')
    expect(result.data).toEqual(DEFAULT_CANDIDATES_STOCKS_DATA)
  })

  it('ネットワークエラー: source:default, DEFAULT_CANDIDATES_STOCKS_DATAへfail-soft', async () => {
    mockFetchNetworkError()
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('default')
    expect(result.data).toEqual(DEFAULT_CANDIDATES_STOCKS_DATA)
  })

  it('schemaVersion不一致: source:default', async () => {
    mockFetchOk({ ...VALID_DATA, schemaVersion: 'candidates-stocks-0' })
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('default')
  })

  it('candidatesが配列でない（型破損）: source:default', async () => {
    mockFetchOk({ ...VALID_DATA, candidates: 'not-an-array' })
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('default')
  })

  it('_meta.not_for_tradingがtrueでない: source:default', async () => {
    mockFetchOk({ ...VALID_DATA, _meta: { ...VALID_DATA._meta, not_for_trading: false } })
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('default')
  })

  it('statusが不正値: source:default', async () => {
    mockFetchOk({ ...VALID_DATA, status: 'unknown' })
    const result = await loadCandidatesStocks()
    expect(result.source).toBe('default')
  })

  it('DEFAULT_CANDIDATES_STOCKS_DATAはcandidates空・status:emptyである', () => {
    expect(DEFAULT_CANDIDATES_STOCKS_DATA.candidates).toEqual([])
    expect(DEFAULT_CANDIDATES_STOCKS_DATA.status).toBe('empty')
    expect(DEFAULT_CANDIDATES_STOCKS_DATA._meta.not_for_trading).toBe(true)
  })
})
