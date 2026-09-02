/**
 * HOLDING-EVIDENCE-1 R1: loadHoldingEvidence fetch/parser 統合の result taxonomy を固定する。
 *
 *  - fetch throw / HTTP !ok         → 'unavailable'（HE-2 generator 未実装のため fail-soft）
 *  - JSON 破損 / parser 拒否         → 'invalid'（data は常に null。合成 evidence へ fallback しない）
 *  - well-formed artifact           → 'loaded'
 *  - well-formed だが stale         → loader は 'loaded'（鮮度判定は join / dataSourceStatus の責務）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadHoldingEvidence } from './loadStaticData'
import type { HoldingEvidenceArtifact, HoldingEvidenceEntry } from '../types/holdingEvidence'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()
const present = (v: number | boolean) => ({ v, status: 'present' as const })

function entry(): HoldingEvidenceEntry {
  return {
    code: '6098', ticker: '6098.T', market: 'TSE',
    fundamentals: {
      asOf: iso(Date.now() - DAY), source: 'test',
      fields: {
        roe: present(22), per: present(12), pbr: present(1.4),
        epsG: present(18), cfOk: present(true), de: present(0.4), divG: present(6),
      },
    },
    technicals: {
      asOf: iso(Date.now() - HOUR), source: 'test', bars: 120,
      fields: {
        ma: present(true), rsi: present(55), macd: present(true),
        vol: present(true), mom3m: present(12),
      },
    },
  }
}

function artifact(generatedAtMs = Date.now() - HOUR): HoldingEvidenceArtifact {
  return {
    schemaVersion: 'holding-evidence-1',
    not_for_trading: true,
    _meta: { kind: 'holding_evidence', schemaVersion: 'holding-evidence-1', generatedAt: iso(generatedAtMs), not_for_trading: true },
    entries: [entry()],
  }
}

function mockFetchOk(data: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(data) }))
}
function mockFetchOkBadJson() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad json')) }))
}
function mockFetchHttpError(status = 404) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: () => Promise.resolve({}) }))
}
function mockFetchNetworkError() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadHoldingEvidence', () => {
  it('fetch throw → unavailable', async () => {
    mockFetchNetworkError()
    const r = await loadHoldingEvidence()
    expect(r).toEqual({ status: 'unavailable', data: null })
  })

  it('HTTP !ok → unavailable', async () => {
    mockFetchHttpError(404)
    const r = await loadHoldingEvidence()
    expect(r).toEqual({ status: 'unavailable', data: null })
  })

  it('JSON parse failure → invalid', async () => {
    mockFetchOkBadJson()
    const r = await loadHoldingEvidence()
    expect(r).toEqual({ status: 'invalid', data: null })
  })

  it('parser rejection (bad schemaVersion) → invalid', async () => {
    mockFetchOk({ ...artifact(), schemaVersion: 'x' })
    const r = await loadHoldingEvidence()
    expect(r).toEqual({ status: 'invalid', data: null })
  })

  it('parser rejection (timezone-less asOf) → invalid', async () => {
    const bad = artifact()
    ;(bad.entries[0].fundamentals as { asOf: string }).asOf = '2026-03-02T00:00:00'
    mockFetchOk(bad)
    const r = await loadHoldingEvidence()
    expect(r).toEqual({ status: 'invalid', data: null })
  })

  it('valid artifact → loaded', async () => {
    mockFetchOk(artifact())
    const r = await loadHoldingEvidence()
    expect(r.status).toBe('loaded')
    expect(r.data?.entries).toHaveLength(1)
  })

  it('valid but stale artifact → loader still loaded (freshness is the join/status layer)', async () => {
    mockFetchOk(artifact(Date.now() - 100 * HOUR))
    const r = await loadHoldingEvidence()
    expect(r.status).toBe('loaded')
    expect(r.data).not.toBeNull()
  })
})
