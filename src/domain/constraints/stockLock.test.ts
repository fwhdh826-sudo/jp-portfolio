import { describe, expect, it } from 'vitest'
import type { Holding } from '../../types'
import {
  STOCK_SELL_LOCK_DAYS,
  getSellLockRemainingDays,
  getSellableDate,
  isSellLocked,
} from './stockLock'

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '1234',
    name: 'Test Stock',
    eval: 100_000,
    pnlPct: 0,
    mu: 0.05,
    sigma: 0.20,
    sigmaSource: 'static',
    beta: 1.0,
    sector: 'テスト',
    target: 1000,
    alert: 800,
    lock: false,
    mitsu: false,
    ma: true,
    rsi: 50,
    macd: true,
    vol: false,
    mom3m: 0,
    roe: 10,
    per: 15,
    pbr: 1.0,
    epsG: 5,
    cfOk: true,
    de: 0.5,
    divG: 3,
    score: 70,
    decision: 'HOLD',
    ev: 0,
    ...overrides,
  }
}

function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

describe('isSellLocked: acquiredAt-based lock', () => {
  it('returns true when acquiredAt is today (0 days elapsed)', () => {
    const h = makeHolding({ acquiredAt: daysAgo(0) })
    expect(isSellLocked(h)).toBe(true)
  })

  it('returns true when acquiredAt is 89 days ago', () => {
    const h = makeHolding({ acquiredAt: daysAgo(89) })
    expect(isSellLocked(h)).toBe(true)
  })

  it('returns false when acquiredAt is exactly 90 days ago', () => {
    const h = makeHolding({ acquiredAt: daysAgo(90) })
    expect(isSellLocked(h)).toBe(false)
  })

  it('returns false when acquiredAt is 91 days ago', () => {
    const h = makeHolding({ acquiredAt: daysAgo(91) })
    expect(isSellLocked(h)).toBe(false)
  })
})

describe('isSellLocked: fallback to holding.lock when acquiredAt absent', () => {
  it('returns true when acquiredAt is absent and holding.lock=true', () => {
    const h = makeHolding({ lock: true })
    expect(isSellLocked(h)).toBe(true)
  })

  it('returns false when acquiredAt is absent and holding.lock=false', () => {
    const h = makeHolding({ lock: false })
    expect(isSellLocked(h)).toBe(false)
  })
})

describe('getSellLockRemainingDays', () => {
  it('returns 0 when acquiredAt is exactly 90 days ago', () => {
    const h = makeHolding({ acquiredAt: daysAgo(STOCK_SELL_LOCK_DAYS) })
    expect(getSellLockRemainingDays(h)).toBe(0)
  })

  it('returns 0 when acquiredAt is more than 90 days ago', () => {
    const h = makeHolding({ acquiredAt: daysAgo(100) })
    expect(getSellLockRemainingDays(h)).toBe(0)
  })

  it('returns 1 when acquiredAt is 89 days ago', () => {
    const h = makeHolding({ acquiredAt: daysAgo(89) })
    expect(getSellLockRemainingDays(h)).toBe(1)
  })

  it('returns STOCK_SELL_LOCK_DAYS when acquiredAt is absent and lock=true', () => {
    const h = makeHolding({ lock: true })
    expect(getSellLockRemainingDays(h)).toBe(STOCK_SELL_LOCK_DAYS)
  })

  it('returns 0 when acquiredAt is absent and lock=false', () => {
    const h = makeHolding({ lock: false })
    expect(getSellLockRemainingDays(h)).toBe(0)
  })
})

describe('getSellableDate', () => {
  it('returns YYYY-MM-DD string 90 days after acquiredAt', () => {
    const acquired = '2025-01-01'
    const h = makeHolding({ acquiredAt: acquired })
    const result = getSellableDate(h)
    // 90 days after 2025-01-01 is 2025-04-01
    expect(result).toBe('2025-04-01')
  })

  it('returns a string matching YYYY-MM-DD format', () => {
    const h = makeHolding({ acquiredAt: daysAgo(30) })
    const result = getSellableDate(h)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns null when acquiredAt is absent', () => {
    const h = makeHolding()
    expect(getSellableDate(h)).toBeNull()
  })
})

// P4-A38: 90日判定 vs setMonth+3の差異を固定日で回帰テスト（日付はテスト用の例示値）
// 参照日: 2001-04-01
//   取得日 2000-12-31 → 91日経過 → domain: 解除済み; setMonth+3=2001-04-02 > ref → locked (1日ズレ)
//   取得日 2001-01-01 → 90日経過 → domain: 解除済み; setMonth+3=2001-04-01 > ref → locked (1日ズレ)
//   取得日 2001-01-02 → 89日経過 → domain: locked; setMonth+3=2001-04-02 > ref → locked (一致)
describe('isSellLocked: 90-day rule vs setMonth+3 discrepancy (fixed date 2001-04-01)', () => {
  const refDate = new Date('2001-04-01')

  it('2000-12-31 acquired → unlocked at 2001-04-01 (91 days elapsed >= 90)', () => {
    const h = makeHolding({ acquiredAt: '2000-12-31' })
    expect(isSellLocked(h, refDate)).toBe(false)
  })

  it('2001-01-01 acquired → unlocked at 2001-04-01 (90 days elapsed, boundary)', () => {
    // setMonth+3 would still show locked (2001-04-01 > ref boundary); domain correctly unlocks at exactly 90 days
    const h = makeHolding({ acquiredAt: '2001-01-01' })
    expect(isSellLocked(h, refDate)).toBe(false)
  })

  it('2001-01-02 acquired → still locked at 2001-04-01 (89 days elapsed < 90)', () => {
    const h = makeHolding({ acquiredAt: '2001-01-02' })
    expect(isSellLocked(h, refDate)).toBe(true)
  })

  it('getSellableDate returns 2001-04-01 for acquiredAt 2001-01-01 (exactly 90 days later)', () => {
    const h = makeHolding({ acquiredAt: '2001-01-01' })
    expect(getSellableDate(h)).toBe('2001-04-01')
  })
})
