/**
 * P4-A66: loadNews source-status regression tests
 * Ensures P4-A65 fix (catch returns 'error', not 'none') does not regress.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadNews } from './loadStaticData'

const MINIMAL_NEWS_DATA = {
  updatedAt: '2026-06-21T00:00:00+09:00',
  sourceStatus: {},
  marketNews: [],
  stockNews: [],
  meta: { totalCount: 3, marketCount: 2, stockCount: 1, duplicateRemoved: 0 },
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

describe('loadNews', () => {
  it('happy path: returns source:loaded and non-null data', async () => {
    mockFetchOk(MINIMAL_NEWS_DATA)
    const result = await loadNews()
    expect(result.source).toBe('loaded')
    expect(result.data).not.toBeNull()
    expect(result.data?.meta.totalCount).toBe(3)
  })

  it('network error: returns source:error and null data', async () => {
    mockFetchNetworkError()
    const result = await loadNews()
    expect(result.source).toBe('error')
    expect(result.data).toBeNull()
  })

  it('HTTP 404: returns source:error and null data', async () => {
    mockFetchHttpError(404)
    const result = await loadNews()
    expect(result.source).toBe('error')
    expect(result.data).toBeNull()
  })

  it('fetch failure: does NOT return source:none (P4-A65 regression guard)', async () => {
    mockFetchNetworkError()
    const result = await loadNews()
    expect(result.source).not.toBe('none')
  })

  it('HTTP error: does NOT return source:none (P4-A65 regression guard)', async () => {
    mockFetchHttpError(500)
    const result = await loadNews()
    expect(result.source).not.toBe('none')
  })
})
