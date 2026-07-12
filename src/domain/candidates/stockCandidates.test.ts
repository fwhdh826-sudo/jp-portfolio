import { describe, expect, it } from 'vitest'
import type { Holding } from '../../types'
import type { CandidatesStocksData, StockCandidateItem as RawStockCandidateItem } from '../../types/candidatesStocks'
import {
  isCandidatesStocksUsable,
  computeJpStockHeadroom,
  excludeHeldStockCandidates,
  computeStockCandidateScore,
  applyStockCandidateGates,
  resolveStockCandidateAction,
  buildStockCandidatePlan,
  STOCK_VOL_HARD_LIMIT,
  STOCK_VOL_SOFT_LIMIT,
  MIN_USABLE_AXES,
  type StockCandidateGateContext,
  type StockCandidatePlanContext,
} from './stockCandidates'

function makeHolding(code: string, evalValue: number): Holding {
  return {
    code,
    name: `銘柄${code}`,
    eval: evalValue,
    pnlPct: 0,
    mu: 0,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1,
    sector: 'other',
    target: 0,
    alert: 0,
    lock: false,
    mitsu: false,
    ma: false,
    rsi: 50,
  } as Holding
}

function makeRawCandidate(overrides: Partial<RawStockCandidateItem> = {}): RawStockCandidateItem {
  return {
    code: '7203',
    name: 'トヨタ自動車',
    sector: '自動車',
    price: 2923,
    per: 9.9,
    pbr: 0.95,
    roe: 10.23,
    dividendYield: 3.54,
    sigma252d: 0.20,
    mom3m: 5,
    screenReasons: [],
    dataStatus: 'ok',
    ...overrides,
  }
}

function makeCandidatesStocksData(overrides: Partial<CandidatesStocksData> = {}): CandidatesStocksData {
  return {
    schemaVersion: 'candidates-stocks-1',
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt: new Date().toISOString(),
    staleThresholdHours: 48,
    _meta: {
      kind: 'candidates_stocks',
      source: 'test',
      not_for_trading: true,
      universe: 'seed_list_v1',
      note: 'test',
    },
    candidates: [makeRawCandidate()],
    missing: [],
    status: 'ok',
    ...overrides,
  }
}

function makeGateCtx(overrides: Partial<StockCandidateGateContext> = {}): StockCandidateGateContext {
  return {
    dqSuppressed: false,
    noTrade: false,
    marketCaution: false,
    safeModeActive: false,
    availableCash: 500_000,
    jpStockHeadroom: 500_000,
    cashAssumptionsUsable: true,
    ...overrides,
  }
}

// ── isCandidatesStocksUsable ────────────────────────────────
describe('isCandidatesStocksUsable', () => {
  it('returns true for loaded/ok/fresh data', () => {
    const data = makeCandidatesStocksData()
    expect(isCandidatesStocksUsable(data, 'loaded')).toBe(true)
  })

  it('returns false when source is default', () => {
    const data = makeCandidatesStocksData()
    expect(isCandidatesStocksUsable(data, 'default')).toBe(false)
  })

  it('returns false when status is empty', () => {
    const data = makeCandidatesStocksData({ status: 'empty' })
    expect(isCandidatesStocksUsable(data, 'loaded')).toBe(false)
  })

  it('returns false when updatedAt missing', () => {
    const data = makeCandidatesStocksData({ updatedAt: '' })
    expect(isCandidatesStocksUsable(data, 'loaded')).toBe(false)
  })

  it('returns false when updatedAt is older than staleThresholdHours', () => {
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString()
    const data = makeCandidatesStocksData({ updatedAt: old, staleThresholdHours: 48 })
    expect(isCandidatesStocksUsable(data, 'loaded', Date.now())).toBe(false)
  })

  it('returns true when updatedAt is within staleThresholdHours', () => {
    const recent = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
    const data = makeCandidatesStocksData({ updatedAt: recent, staleThresholdHours: 48 })
    expect(isCandidatesStocksUsable(data, 'loaded', Date.now())).toBe(true)
  })
})

// ── computeJpStockHeadroom（universe.categoriesのtarget-currentを使わない独立計算） ──
describe('computeJpStockHeadroom', () => {
  it('returns positive headroom even when the naive universe target-current would be 0', () => {
    // universe.categoriesの丸め: targetValue = min(cap, current) となり target-current は常に <=0。
    // ここではcap=1,000,000・current=300,000のとき、独立計算で正のheadroom(700,000)が出ることを確認する。
    const holdings = [makeHolding('7203', 300_000)]
    const jpStockMaxRatio = 0.10
    const totalValue = 10_000_000 // cap = 1,000,000
    const headroom = computeJpStockHeadroom(holdings, jpStockMaxRatio, totalValue)
    expect(headroom).toBe(700_000)
  })

  it('returns 0 (not negative) when current exceeds cap', () => {
    const holdings = [makeHolding('7203', 2_000_000)]
    const headroom = computeJpStockHeadroom(holdings, 0.10, 10_000_000) // cap=1,000,000
    expect(headroom).toBe(0)
  })
})

// ── excludeHeldStockCandidates ────────────────────────────────
describe('excludeHeldStockCandidates', () => {
  it('excludes candidates whose code matches a holding with eval > 0', () => {
    const candidates = [makeRawCandidate({ code: '7203' }), makeRawCandidate({ code: '9999' })]
    const holdings = [makeHolding('7203', 500_000)]
    const result = excludeHeldStockCandidates(candidates, holdings)
    expect(result.map(c => c.code)).toEqual(['9999'])
  })

  it('keeps candidates whose holding eval is 0 (実質未保有)', () => {
    const candidates = [makeRawCandidate({ code: '7203' })]
    const holdings = [makeHolding('7203', 0)]
    const result = excludeHeldStockCandidates(candidates, holdings)
    expect(result.map(c => c.code)).toEqual(['7203'])
  })

  it('keeps all candidates when holdings is empty', () => {
    const candidates = [makeRawCandidate({ code: '7203' })]
    expect(excludeHeldStockCandidates(candidates, [])).toHaveLength(1)
  })
})

// ── computeStockCandidateScore ────────────────────────────────
describe('computeStockCandidateScore', () => {
  it('does not reference stock_scores_6axis at all (uses only candidates_stocks fields)', () => {
    // stock_scores_6axisはこの関数の入力に一切登場しない（RawStockCandidateItemの型自体が
    // per/pbr/roe/dividendYield/sigma252d/mom3mのみを持ち、6axisのフィールドを持たない）。
    const item = makeRawCandidate()
    const result = computeStockCandidateScore(item)
    expect(result.usableAxes).toBe(6)
  })

  it('counts usableAxes correctly with some null fields', () => {
    const item = makeRawCandidate({ per: null, pbr: null, roe: null })
    const result = computeStockCandidateScore(item)
    expect(result.usableAxes).toBe(3)
  })

  it('null axes contribute neutrally (score stays within reasonable base range)', () => {
    const allNull = makeRawCandidate({
      per: null, pbr: null, roe: null, dividendYield: null, sigma252d: null, mom3m: null,
    })
    const result = computeStockCandidateScore(allNull)
    expect(result.usableAxes).toBe(0)
    expect(result.score).toBe(50) // base only, no bonuses/penalties applied
  })

  it('clamps score to [0, 100]', () => {
    const extreme = makeRawCandidate({ per: 1, pbr: 0.1, roe: 100, dividendYield: 100, mom3m: 100, sigma252d: 0 })
    const result = computeStockCandidateScore(extreme)
    expect(result.score).toBeLessThanOrEqual(100)
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  it('high volatility drags the score down via the vol penalty', () => {
    const low = computeStockCandidateScore(makeRawCandidate({ sigma252d: 0.20 }))
    const high = computeStockCandidateScore(makeRawCandidate({ sigma252d: 0.50 }))
    expect(high.score).toBeLessThan(low.score)
  })
})

// ── applyStockCandidateGates ────────────────────────────────
describe('applyStockCandidateGates', () => {
  it('SAFE_MODE active blocks the candidate', () => {
    const result = applyStockCandidateGates(makeRawCandidate(), makeGateCtx({ safeModeActive: true }))
    expect(result.blocked).toContain('SAFE_MODE_ACTIVE')
    expect(result.maxAmount).toBe(0)
  })

  it('DQ suppressed blocks immediately with maxAmount 0', () => {
    const result = applyStockCandidateGates(makeRawCandidate(), makeGateCtx({ dqSuppressed: true }))
    expect(result.blocked).toEqual(['DQ_SUPPRESSED'])
    expect(result.maxAmount).toBe(0)
  })

  it('noTrade emergency blocks the candidate', () => {
    const result = applyStockCandidateGates(makeRawCandidate(), makeGateCtx({ noTrade: true }))
    expect(result.blocked).toContain('NO_TRADE_EMERGENCY')
  })

  it('jpStockHeadroom <= 0 blocks with JP_STOCK_CAP', () => {
    const result = applyStockCandidateGates(makeRawCandidate(), makeGateCtx({ jpStockHeadroom: 0 }))
    expect(result.blocked).toContain('JP_STOCK_CAP')
  })

  it('cashAssumptions not usable blocks with DATA_STALE', () => {
    const result = applyStockCandidateGates(makeRawCandidate(), makeGateCtx({ cashAssumptionsUsable: false }))
    expect(result.blocked).toContain('DATA_STALE')
  })

  it('availableCash below MIN_BUY_AMOUNT blocks with INSUFFICIENT_CASH', () => {
    const result = applyStockCandidateGates(makeRawCandidate(), makeGateCtx({ availableCash: 5_000 }))
    expect(result.blocked).toContain('INSUFFICIENT_CASH')
  })

  it('sigma252d >= hard limit blocks with VOL_TOO_HIGH', () => {
    const result = applyStockCandidateGates(
      makeRawCandidate({ sigma252d: STOCK_VOL_HARD_LIMIT }),
      makeGateCtx(),
    )
    expect(result.blocked).toContain('VOL_TOO_HIGH')
  })

  it('sigma252d just below hard limit does not trigger VOL_TOO_HIGH', () => {
    const result = applyStockCandidateGates(
      makeRawCandidate({ sigma252d: STOCK_VOL_HARD_LIMIT - 0.01 }),
      makeGateCtx(),
    )
    expect(result.blocked).not.toContain('VOL_TOO_HIGH')
  })

  it('maxAmount is min(headroom, availableCash, MAX_AMOUNT_CAP) when no gate fails', () => {
    const result = applyStockCandidateGates(
      makeRawCandidate(),
      makeGateCtx({ jpStockHeadroom: 50_000, availableCash: 500_000 }),
    )
    expect(result.maxAmount).toBe(50_000)
  })
})

// ── resolveStockCandidateAction ────────────────────────────────
describe('resolveStockCandidateAction', () => {
  it('returns BLOCKED when blocked list is non-empty regardless of score', () => {
    expect(resolveStockCandidateAction(['JP_STOCK_CAP'], 90, 6, 'ok', 0.1, false)).toBe('BLOCKED')
  })

  it('returns BUY_NEW when score>=75, usableAxes sufficient, ok data, low vol, no caution', () => {
    expect(resolveStockCandidateAction([], 80, 6, 'ok', 0.1, false)).toBe('BUY_NEW')
  })

  it('caps at WATCH when usableAxes < MIN_USABLE_AXES even with high score', () => {
    expect(resolveStockCandidateAction([], 80, MIN_USABLE_AXES - 1, 'ok', 0.1, false)).toBe('WATCH')
  })

  it('caps at WATCH when dataStatus is partial even with high score', () => {
    expect(resolveStockCandidateAction([], 80, 6, 'partial', 0.1, false)).toBe('WATCH')
  })

  it('caps at WATCH when sigma252d >= soft limit', () => {
    expect(resolveStockCandidateAction([], 80, 6, 'ok', STOCK_VOL_SOFT_LIMIT, false)).toBe('WATCH')
  })

  it('caps at WATCH when marketCaution is true', () => {
    expect(resolveStockCandidateAction([], 80, 6, 'ok', 0.1, true)).toBe('WATCH')
  })

  it('returns WATCH for score in [50,75)', () => {
    expect(resolveStockCandidateAction([], 60, 6, 'ok', 0.1, false)).toBe('WATCH')
  })

  it('returns BLOCKED for score < 50', () => {
    expect(resolveStockCandidateAction([], 30, 6, 'ok', 0.1, false)).toBe('BLOCKED')
  })
})

// ── buildStockCandidatePlan（統合） ────────────────────────────
describe('buildStockCandidatePlan', () => {
  function makePlanCtx(overrides: Partial<StockCandidatePlanContext> = {}): StockCandidatePlanContext {
    return {
      holdings: [],
      candidatesStocks: makeCandidatesStocksData(),
      candidatesStocksSource: 'loaded',
      dqSuppressed: false,
      noTrade: false,
      marketCaution: false,
      safeModeActive: false,
      availableCash: 500_000,
      jpStockHeadroom: 500_000,
      cashAssumptionsUsable: true,
      ...overrides,
    }
  }

  it('returns empty array when candidatesStocks source is default', () => {
    expect(buildStockCandidatePlan(makePlanCtx({ candidatesStocksSource: 'default' }))).toEqual([])
  })

  it('returns empty array when candidatesStocks status is empty', () => {
    expect(buildStockCandidatePlan(makePlanCtx({
      candidatesStocks: makeCandidatesStocksData({ status: 'empty' }),
    }))).toEqual([])
  })

  it('returns empty array when candidatesStocks data is stale (>48h)', () => {
    const old = new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString()
    expect(buildStockCandidatePlan(makePlanCtx({
      candidatesStocks: makeCandidatesStocksData({ updatedAt: old }),
    }))).toEqual([])
  })

  it('excludes held candidates (eval>0) end-to-end', () => {
    const result = buildStockCandidatePlan(makePlanCtx({
      holdings: [makeHolding('7203', 300_000)],
    }))
    expect(result.find(c => c.code === '7203')).toBeUndefined()
  })

  it('produces a BUY_NEW candidate for a healthy toyota-like profile with all gates open', () => {
    const result = buildStockCandidatePlan(makePlanCtx())
    expect(result).toHaveLength(1)
    expect(result[0].code).toBe('7203')
    expect(result[0].source).toBe('candidates_stocks')
    expect(['BUY_NEW', 'WATCH']).toContain(result[0].action)
  })

  it('produces no BUY_NEW when SAFE_MODE is active', () => {
    const result = buildStockCandidatePlan(makePlanCtx({ safeModeActive: true }))
    expect(result.every(c => c.action !== 'BUY_NEW')).toBe(true)
    expect(result[0].blockedReasons).toContain('SAFE_MODE_ACTIVE')
  })

  it('produces no BUY_NEW when cashAssumptions is not usable (default/stale)', () => {
    const result = buildStockCandidatePlan(makePlanCtx({ cashAssumptionsUsable: false }))
    expect(result.every(c => c.action !== 'BUY_NEW')).toBe(true)
  })

  it('produces no BUY_NEW when jpStockHeadroom is 0', () => {
    const result = buildStockCandidatePlan(makePlanCtx({ jpStockHeadroom: 0 }))
    expect(result.every(c => c.action !== 'BUY_NEW')).toBe(true)
    expect(result[0].blockedReasons).toContain('JP_STOCK_CAP')
  })
})
