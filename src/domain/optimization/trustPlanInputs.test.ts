// P4-A144: buildTrustPlanGateInputs — T7/T2 が buildTrustPortfolioPlan へ渡す
// jpTrustHeadroom / noTrade ゲート入力を、store合成条件と同一式で算出することを守る。
import { describe, it, expect } from 'vitest'
import type { AssetUniverse, AssetCategorySummary } from '../../types'
import type { NoTradeResult } from './idealAllocation'
import { buildTrustPlanGateInputs } from './trustPlanInputs'

function makeCategory(overrides: Partial<AssetCategorySummary> = {}): AssetCategorySummary {
  return {
    class: 'JP_TRUST',
    label: '国内株投信',
    role: '短期需給対応',
    horizon: 'short',
    currentValue: 0,
    currentRatio: 0,
    targetRatio: 0.1,
    targetValue: 0,
    diffValue: 0,
    diffRatio: 0,
    score: 50,
    lastUpdatedAt: null,
    ...overrides,
  } as AssetCategorySummary
}

function makeUniverse(categories: AssetCategorySummary[]): AssetUniverse {
  return {
    totalValue: 10_000_000,
    categories,
    cash: 1_000_000,
    cashReserve: 5_000_000,
    lastUpdatedAt: '',
  }
}

const NO_TRADE_FALSE: NoTradeResult = { noTrade: false, reasons: [], mode: 'normal' }
const NO_TRADE_TRUE: NoTradeResult = { noTrade: true, reasons: ['VIX高い'], mode: 'emergency' }

describe('buildTrustPlanGateInputs: jpTrustHeadroom', () => {
  it('JP_TRUST diffValue=500000 のとき jpTrustHeadroom=500000', () => {
    const universe = makeUniverse([makeCategory({ diffValue: 500_000 })])
    const result = buildTrustPlanGateInputs({
      universe,
      noTradeResult: NO_TRADE_FALSE,
      safeModeActive: false,
      dqSuppressed: false,
    })
    expect(result.jpTrustHeadroom).toBe(500_000)
  })

  it('JP_TRUST diffValue が負数のとき jpTrustHeadroom=0', () => {
    const universe = makeUniverse([makeCategory({ diffValue: -300_000 })])
    const result = buildTrustPlanGateInputs({
      universe,
      noTradeResult: NO_TRADE_FALSE,
      safeModeActive: false,
      dqSuppressed: false,
    })
    expect(result.jpTrustHeadroom).toBe(0)
  })

  it('universe が null のとき jpTrustHeadroom=undefined', () => {
    const result = buildTrustPlanGateInputs({
      universe: null,
      noTradeResult: NO_TRADE_FALSE,
      safeModeActive: false,
      dqSuppressed: false,
    })
    expect(result.jpTrustHeadroom).toBeUndefined()
  })

  it('universe.categories に JP_TRUST が存在しないとき jpTrustHeadroom=undefined', () => {
    const universe = makeUniverse([makeCategory({ class: 'JP_STOCK', diffValue: 100_000 })])
    const result = buildTrustPlanGateInputs({
      universe,
      noTradeResult: NO_TRADE_FALSE,
      safeModeActive: false,
      dqSuppressed: false,
    })
    expect(result.jpTrustHeadroom).toBeUndefined()
  })
})

describe('buildTrustPlanGateInputs: noTrade合成', () => {
  const universe = makeUniverse([makeCategory({ diffValue: 500_000 })])

  it('noTradeResult.noTrade=true で noTrade=true', () => {
    const result = buildTrustPlanGateInputs({
      universe,
      noTradeResult: NO_TRADE_TRUE,
      safeModeActive: false,
      dqSuppressed: false,
    })
    expect(result.noTrade).toBe(true)
  })

  it('safeModeActive=true で noTrade=true', () => {
    const result = buildTrustPlanGateInputs({
      universe,
      noTradeResult: NO_TRADE_FALSE,
      safeModeActive: true,
      dqSuppressed: false,
    })
    expect(result.noTrade).toBe(true)
  })

  it('dqSuppressed=true で noTrade=true', () => {
    const result = buildTrustPlanGateInputs({
      universe,
      noTradeResult: NO_TRADE_FALSE,
      safeModeActive: false,
      dqSuppressed: true,
    })
    expect(result.noTrade).toBe(true)
  })

  it('すべてfalseなら noTrade=false', () => {
    const result = buildTrustPlanGateInputs({
      universe,
      noTradeResult: NO_TRADE_FALSE,
      safeModeActive: false,
      dqSuppressed: false,
    })
    expect(result.noTrade).toBe(false)
  })
})
