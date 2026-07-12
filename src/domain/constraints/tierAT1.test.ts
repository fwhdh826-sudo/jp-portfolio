// P4-A150: checkTierAT1Violations — Tier A T1（ストップロス-40%）frontend検出テスト
// Fable監査S4対応: 自動売却は行わない検出専用ロジック。ロック中でも検出は消えないことを確認する。
import { describe, expect, it } from 'vitest'
import type { Holding } from '../../types'
import { TIER_A_T1_STOP_LOSS_PCT, checkTierAT1Violations } from './tierAT1'

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

describe('TIER_A_T1_STOP_LOSS_PCT', () => {
  it('-40と定数化されている', () => {
    expect(TIER_A_T1_STOP_LOSS_PCT).toBe(-40)
  })
})

describe('checkTierAT1Violations', () => {
  it('pnlPct = -40.0 で違反検出される（境界値: ちょうど閾値）', () => {
    const holdings = [makeHolding({ code: '0001', pnlPct: -40.0 })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(1)
    expect(violations[0].code).toBe('0001')
  })

  it('pnlPct = -39.9 では違反検出されない（境界値: 閾値未満）', () => {
    const holdings = [makeHolding({ code: '0002', pnlPct: -39.9 })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(0)
  })

  it('pnlPct = -50.0 で違反検出される', () => {
    const holdings = [makeHolding({ code: '0003', pnlPct: -50.0 })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(1)
    expect(violations[0].pnlPct).toBe(-50.0)
  })

  it('pnlPctがundefinedの場合は検出しない', () => {
    const holdings = [makeHolding({ code: '0004', pnlPct: undefined as unknown as number })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(0)
  })

  it('pnlPctがnullの場合は検出しない', () => {
    const holdings = [makeHolding({ code: '0005', pnlPct: null as unknown as number })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(0)
  })

  it('pnlPctがNaNの場合は検出しない', () => {
    const holdings = [makeHolding({ code: '0006', pnlPct: NaN })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(0)
  })

  it('ロック中銘柄（lock=true）でも違反検出は消えない', () => {
    const holdings = [makeHolding({ code: '0007', pnlPct: -45, lock: true })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(1)
    expect(violations[0].locked).toBe(true)
  })

  it('acquiredAt起因のロック中銘柄（取得直後）でも違反検出は消えない', () => {
    const today = new Date().toISOString().slice(0, 10)
    const holdings = [makeHolding({ code: '0008', pnlPct: -45, acquiredAt: today })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(1)
    expect(violations[0].locked).toBe(true)
  })

  it('ロック解除済み銘柄はlocked=falseで返る', () => {
    const acquired = new Date()
    acquired.setDate(acquired.getDate() - 91)
    const acquiredAt = acquired.toISOString().slice(0, 10)
    const holdings = [makeHolding({ code: '0009', pnlPct: -45, acquiredAt })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations).toHaveLength(1)
    expect(violations[0].locked).toBe(false)
  })

  it('holdingsが空配列なら違反0件', () => {
    expect(checkTierAT1Violations([])).toHaveLength(0)
  })

  it('返却情報にcode/name/pnlPct/eval/acquiredAt/lockedが含まれる', () => {
    const holdings = [makeHolding({
      code: '0010', name: 'テスト銘柄', pnlPct: -45, eval: 55_000, acquiredAt: '2026-01-01',
    })]
    const violations = checkTierAT1Violations(holdings)
    expect(violations[0]).toMatchObject({
      code: '0010',
      name: 'テスト銘柄',
      pnlPct: -45,
      eval: 55_000,
      acquiredAt: '2026-01-01',
    })
    expect(typeof violations[0].locked).toBe('boolean')
  })

  it('正の含み損益・軽微な含み損の銘柄は違反として検出しない', () => {
    const holdings = [
      makeHolding({ code: '0011', pnlPct: 20 }),
      makeHolding({ code: '0012', pnlPct: -10 }),
      makeHolding({ code: '0013', pnlPct: -39 }),
    ]
    expect(checkTierAT1Violations(holdings)).toHaveLength(0)
  })

  it('複数銘柄混在時、違反銘柄のみ抽出される', () => {
    const holdings = [
      makeHolding({ code: 'A', pnlPct: -45 }),
      makeHolding({ code: 'B', pnlPct: -10 }),
      makeHolding({ code: 'C', pnlPct: -41 }),
    ]
    const violations = checkTierAT1Violations(holdings)
    expect(violations.map(v => v.code).sort()).toEqual(['A', 'C'])
  })
})
