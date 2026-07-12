import { describe, expect, it } from 'vitest'
import type { Holding } from '../types'
import { applyHoldingsSnapshot } from './useAppStore'

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

describe('applyHoldingsSnapshot: acquiredAt fallback', () => {
  it('holding.acquiredAt が存在する場合、row.purchase_date があっても holding.acquiredAt を優先する', () => {
    const holdings = [makeHolding({ code: '1234', acquiredAt: '2024-01-10' })]
    const snapshot = { holdings: [{ code: '1234', eval: 50000, purchase_date: '2099-01-01' }] }
    const result = applyHoldingsSnapshot(holdings, snapshot)
    expect(result[0].acquiredAt).toBe('2024-01-10')
  })

  it('holding.acquiredAt がない場合、row.purchase_date を acquiredAt に採用する', () => {
    const holdings = [makeHolding({ code: '9999' })]
    const snapshot = { holdings: [{ code: '9999', eval: 60000, purchase_date: '2026-04-01' }] }
    const result = applyHoldingsSnapshot(holdings, snapshot)
    expect(result[0].acquiredAt).toBe('2026-04-01')
  })

  it('row.purchase_date がない場合、acquiredAt は undefined のまま', () => {
    const holdings = [makeHolding({ code: '9999' })]
    const snapshot = { holdings: [{ code: '9999', eval: 70000 }] }
    const result = applyHoldingsSnapshot(holdings, snapshot)
    expect(result[0].acquiredAt).toBeUndefined()
  })

  it('snapshot に対象 code がない場合、holding はそのまま返る', () => {
    const holdings = [makeHolding({ code: '1111', acquiredAt: '2025-01-01' })]
    const snapshot = { holdings: [{ code: '9999', eval: 80000 }] }
    const result = applyHoldingsSnapshot(holdings, snapshot)
    expect(result[0].acquiredAt).toBe('2025-01-01')
    expect(result[0].eval).toBe(100_000)
  })
})

describe('applyHoldingsSnapshot: eval / pnlPct / currentPrice の既存更新', () => {
  it('eval / pnlPct / currentPrice が snapshot 値で更新される', () => {
    const holdings = [makeHolding({ code: '1101', eval: 100_000, pnlPct: 10 })]
    const snapshot = { holdings: [{ code: '1101', eval: 56900, pnlPct: 342.63, price: 11380 }] }
    const result = applyHoldingsSnapshot(holdings, snapshot)
    expect(result[0].eval).toBe(56900)
    expect(result[0].pnlPct).toBe(342.63)
    expect(result[0].currentPrice).toBe(11380)
  })

  it('snapshot が null の場合、holdings をそのまま返す', () => {
    const holdings = [makeHolding({ code: '1101' })]
    const result = applyHoldingsSnapshot(holdings, null)
    expect(result).toEqual(holdings)
  })

  it('snapshot.holdings が空配列の場合、holdings をそのまま返す', () => {
    const holdings = [makeHolding({ code: '1101' })]
    const result = applyHoldingsSnapshot(holdings, { holdings: [] })
    expect(result).toEqual(holdings)
  })
})
