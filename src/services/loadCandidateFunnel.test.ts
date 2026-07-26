/**
 * P5-B005-B3-A: loadCandidateFunnel fetch/parser統合 regression tests。
 *
 * candidate_funnel.jsonは市場情報＋quality gate＋privacy boundaryを含む
 * production artifactであり、loadCandidatesStocksのような単純castへ
 * fail-softしない。404/network error/JSON破損/schema不一致/quality gate
 * 不正を区別可能なresult taxonomyへ落とすことをここで固定する。
 *
 * DEFAULTのdummy/actionable候補データは存在しない — invalid時のdataは
 * 常にnull。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCandidateFunnel } from './loadStaticData'
import { buildValidCandidateFunnelArtifact } from './candidateFunnelArtifact.fixtures'

function mockFetchOk(data: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    }),
  )
}

function mockFetchOkBadJson() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token in JSON')),
    }),
  )
}

function mockFetchHttpError(status = 404) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve({}),
    }),
  )
}

function mockFetchNetworkError() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadCandidateFunnel', () => {
  it('returns loaded status with parsed data on a valid artifact', async () => {
    mockFetchOk(buildValidCandidateFunnelArtifact())
    const result = await loadCandidateFunnel()
    expect(result.status).toBe('loaded')
    expect(result.data).not.toBeNull()
    expect(result.data?.counts.total).toBe(3)
  })

  it('returns unavailable on HTTP 404', async () => {
    mockFetchHttpError(404)
    const result = await loadCandidateFunnel()
    expect(result.status).toBe('unavailable')
    expect(result.data).toBeNull()
  })

  it('returns unavailable on network rejection', async () => {
    mockFetchNetworkError()
    const result = await loadCandidateFunnel()
    expect(result.status).toBe('unavailable')
    expect(result.data).toBeNull()
  })

  it('returns invalid on malformed JSON body', async () => {
    mockFetchOkBadJson()
    const result = await loadCandidateFunnel()
    expect(result.status).toBe('invalid')
    expect(result.data).toBeNull()
  })

  it('returns invalid on schema-mismatched payload (never falls back to dummy candidates)', async () => {
    const artifact = buildValidCandidateFunnelArtifact()
    ;(artifact as { schemaVersion: string }).schemaVersion = 'wrong-version'
    mockFetchOk(artifact)
    const result = await loadCandidateFunnel()
    expect(result.status).toBe('invalid')
    expect(result.data).toBeNull()
  })

  it('returns invalid on quality-gate-failing payload', async () => {
    const artifact = buildValidCandidateFunnelArtifact()
    artifact._meta.qualityGate.overallPass = false
    mockFetchOk(artifact)
    const result = await loadCandidateFunnel()
    expect(result.status).toBe('invalid')
    expect(result.data).toBeNull()
  })

  it('never returns 12 dummy/actionable candidates on failure', async () => {
    mockFetchHttpError(404)
    const result = await loadCandidateFunnel()
    expect(result.data).toBeNull()
  })

  it('applies cache-bust token to the request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(buildValidCandidateFunnelArtifact()),
    })
    vi.stubGlobal('fetch', fetchMock)
    await loadCandidateFunnel({ bustToken: 'abc123' })
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('candidate_funnel.json')
    expect(calledUrl).toContain('ts=abc123')
  })

  it('requests with no-store cache policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(buildValidCandidateFunnelArtifact()),
    })
    vi.stubGlobal('fetch', fetchMock)
    await loadCandidateFunnel()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.cache).toBe('no-store')
  })

  it('resolves to the same result shape when called twice (no hidden mutable state)', async () => {
    mockFetchOk(buildValidCandidateFunnelArtifact())
    const first = await loadCandidateFunnel()
    const second = await loadCandidateFunnel()
    expect(first.status).toBe(second.status)
    expect(first.data).toEqual(second.data)
  })

})
