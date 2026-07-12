/**
 * P4-A76: data / public/data JSON contract smoke tests
 *
 * 目的: frontend DQ/SafeMode/loader が参照する代表JSONの最低限の契約を固定する。
 * - JSON として parse できること（static import = parse成功が前提）
 * - frontend が参照する必須 field が存在すること
 * - timestamp field が文字列として存在すること（現時刻との差分はテストしない）
 * - data/ と public/data/ が同じ構造であること
 *
 * Non-goals:
 * - リアルタイム鮮度チェック（24h 以内かどうか）
 * - 値の正確性・投資判断の妥当性
 * - 相場営業日判定
 */
import { describe, it, expect } from 'vitest'

// static JSON import（resolveJsonModule: true / vite による ESM transform）
import dataMarket       from '../../data/market.json'
import publicMarket     from '../../public/data/market.json'
import dataSafeMode     from '../../data/safe_mode.json'
import publicSafeMode   from '../../public/data/safe_mode.json'
import dataRegime       from '../../data/regime_state.json'
import publicRegime     from '../../public/data/regime_state.json'
import dataCandidates   from '../../data/candidates_news.json'
import publicCandidates from '../../public/data/candidates_news.json'
import dataCandidatesStocks   from '../../data/candidates_stocks.json'
import publicCandidatesStocks from '../../public/data/candidates_stocks.json'

const VALID_REGIMES = new Set(['bull_calm', 'bull_volatile', 'bear', 'crisis', 'uncertain'])

// ── market.json ───────────────────────────────────────────────
describe('market.json contract', () => {
  const cases = [
    { label: 'data/market.json',        d: dataMarket   },
    { label: 'public/data/market.json', d: publicMarket },
  ] as const

  for (const { label, d } of cases) {
    it(`${label}: last_updated / 主要field`, () => {
      // DQ判定のtimestamp（selectMarketDataQuality参照）
      expect(typeof (d as Record<string, unknown>)['last_updated']).toBe('string')
      expect(((d as Record<string, unknown>)['last_updated'] as string).length).toBeGreaterThan(0)
      // frontend Market型の主要field（型: number）
      expect(typeof (d as Record<string, unknown>)['nikkei']).toBe('number')
      expect(typeof (d as Record<string, unknown>)['nikkeiChg']).toBe('number')
      expect(typeof (d as Record<string, unknown>)['nikkeiChgPct']).toBe('number')
    })
  }

  it('data/ と public/data/ のトップレベルkeyが一致', () => {
    const dKeys = new Set(Object.keys(dataMarket))
    const pKeys = new Set(Object.keys(publicMarket))
    expect([...dKeys].filter(k => !pKeys.has(k))).toEqual([])
    expect([...pKeys].filter(k => !dKeys.has(k))).toEqual([])
  })
})

// ── safe_mode.json ────────────────────────────────────────────
describe('safe_mode.json contract', () => {
  const cases = [
    { label: 'data/safe_mode.json',        d: dataSafeMode   },
    { label: 'public/data/safe_mode.json', d: publicSafeMode },
  ] as const

  for (const { label, d } of cases) {
    it(`${label}: fail-closed field`, () => {
      const meta = (d as Record<string, unknown>)['_meta'] as Record<string, unknown>
      expect(meta?.['kind']).toBe('operation_snapshot')
      const sm = (d as Record<string, unknown>)['safe_mode'] as Record<string, unknown>
      expect(typeof sm?.['active']).toBe('boolean')
      const r = sm?.['restrictions'] as Record<string, unknown>
      expect(typeof r?.['new_buys_frozen']).toBe('boolean')
    })
  }

  it('data/ と public/data/ のトップレベルkeyが一致', () => {
    const dKeys = new Set(Object.keys(dataSafeMode))
    const pKeys = new Set(Object.keys(publicSafeMode))
    expect([...dKeys].filter(k => !pKeys.has(k))).toEqual([])
    expect([...pKeys].filter(k => !dKeys.has(k))).toEqual([])
  })
})

// ── regime_state.json ─────────────────────────────────────────
describe('regime_state.json contract', () => {
  const cases = [
    { label: 'data/regime_state.json',        d: dataRegime   },
    { label: 'public/data/regime_state.json', d: publicRegime },
  ] as const

  for (const { label, d } of cases) {
    it(`${label}: _meta + current_regime`, () => {
      const meta = (d as Record<string, unknown>)['_meta'] as Record<string, unknown>
      expect(meta?.['schemaVersion']).toBe('regime-state-1')
      expect(meta?.['kind']).toBe('live_regime_state')
      expect('not_for_trading' in (meta ?? {})).toBe(true)
      const rs = (d as Record<string, unknown>)['regime_state'] as Record<string, unknown>
      expect(VALID_REGIMES.has(rs?.['current_regime'] as string)).toBe(true)
    })
  }

  it('data/ と public/data/ のトップレベルkeyが一致', () => {
    const dKeys = new Set(Object.keys(dataRegime))
    const pKeys = new Set(Object.keys(publicRegime))
    expect([...dKeys].filter(k => !pKeys.has(k))).toEqual([])
    expect([...pKeys].filter(k => !dKeys.has(k))).toEqual([])
  })
})

// ── candidates_news.json ──────────────────────────────────────
describe('candidates_news.json contract', () => {
  const cases = [
    { label: 'data/candidates_news.json',        d: dataCandidates   },
    { label: 'public/data/candidates_news.json', d: publicCandidates },
  ] as const

  for (const { label, d } of cases) {
    it(`${label}: schemaVersion / assetClassNews`, () => {
      expect((d as Record<string, unknown>)['schemaVersion']).toBe('candidates-news-1')
      expect(typeof (d as Record<string, unknown>)['assetClassNews']).toBe('object')
      expect((d as Record<string, unknown>)['assetClassNews']).not.toBeNull()
      expect(typeof (d as Record<string, unknown>)['staleThresholdHours']).toBe('number')
    })
  }

  it('data/ と public/data/ のトップレベルkeyが一致', () => {
    const dKeys = new Set(Object.keys(dataCandidates))
    const pKeys = new Set(Object.keys(publicCandidates))
    expect([...dKeys].filter(k => !pKeys.has(k))).toEqual([])
    expect([...pKeys].filter(k => !dKeys.has(k))).toEqual([])
  })
})

// ── candidates_stocks.json（P5-B002a: 新規個別株候補、observability-only）──
// P4.5-A010/A010-1a方針: 個人資産・保有実額・現金実額・口座種別・CSV取込値・
// score/action/提案金額はこのJSONに一切含めない。ここで再公開防止guardとして固定する。
describe('candidates_stocks.json contract', () => {
  const cases = [
    { label: 'data/candidates_stocks.json',        d: dataCandidatesStocks   },
    { label: 'public/data/candidates_stocks.json', d: publicCandidatesStocks },
  ] as const

  const FORBIDDEN_CANDIDATE_KEYS = [
    'eval', 'pnlPct', 'purchase_date', 'acquiredAt', 'account', 'accountType',
    'holdings', 'cash', 'reserve', 'amount', 'maxAmount', 'sizing', 'headroom',
    'score', 'action', 'BUY', 'SELL', 'WATCH',
  ]

  for (const { label, d } of cases) {
    it(`${label}: schemaVersion / _meta / status`, () => {
      const doc = d as Record<string, unknown>
      expect(doc['schemaVersion']).toBe('candidates-stocks-1')
      expect(Array.isArray(doc['candidates'])).toBe(true)
      expect(Array.isArray(doc['missing'])).toBe(true)
      expect(typeof doc['staleThresholdHours']).toBe('number')
      const meta = doc['_meta'] as Record<string, unknown>
      expect(meta?.['kind']).toBe('candidates_stocks')
      expect(meta?.['not_for_trading']).toBe(true)
      expect(typeof meta?.['universe']).toBe('string')
      expect(['ok', 'partial', 'empty']).toContain(doc['status'])
    })

    it(`${label}: candidate itemに個人資産・実額・判定フィールドを含まない`, () => {
      const doc = d as Record<string, unknown>
      const candidates = doc['candidates'] as Array<Record<string, unknown>>
      for (const c of candidates) {
        const leaked = FORBIDDEN_CANDIDATE_KEYS.filter(k => k in c)
        expect(leaked, `${label} code=${c['code']}: forbidden keys ${leaked.join(',')}`).toEqual([])
      }
    })
  }

  it('data/ と public/data/ のトップレベルkeyが一致', () => {
    const dKeys = new Set(Object.keys(dataCandidatesStocks))
    const pKeys = new Set(Object.keys(publicCandidatesStocks))
    expect([...dKeys].filter(k => !pKeys.has(k))).toEqual([])
    expect([...pKeys].filter(k => !dKeys.has(k))).toEqual([])
  })
})
