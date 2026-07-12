import { describe, expect, it } from 'vitest'
import type { Holding, HoldingAnalysis } from '../../types'
import { buildStockPortfolioPlan } from './stockPortfolio'

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '1234',
    name: 'Test Stock',
    eval: 500_000,
    pnlPct: -5,
    mu: 0.03,
    sigma: 0.20,
    sigmaSource: 'static',
    beta: 1.0,
    sector: 'テスト',
    target: 900,
    alert: 700,
    lock: false,
    mitsu: false,
    ma: false,
    rsi: 40,
    macd: false,
    vol: false,
    mom3m: -3,
    roe: 5,
    per: 20,
    pbr: 1.5,
    epsG: 0,
    cfOk: false,
    de: 1.0,
    divG: 0,
    score: 30,
    decision: 'SELL',
    ev: -0.05,
    ...overrides,
  }
}

function makeAnalysis(overrides: Partial<HoldingAnalysis> = {}): HoldingAnalysis {
  return {
    code: '1234',
    fundamentalScore: 5,
    marketScore: 5,
    technicalScore: 5,
    newsScore: 5,
    qualityScore: 5,
    riskPenalty: 5,
    totalScore: 30,
    ev: -0.05,
    decision: 'SELL',
    confidence: 0.6,
    strategyRank: 'D',
    debate: {
      agents: [],
      debateScore: 30,
      confidence: 0.6,
      finalView: 'SELL',
      bullReasons: [],
      bearReasons: [],
      buyReasons: [],
      waitReasons: [],
      sellReasons: [],
      recommendedAction: 'SELL',
      takeProfitConditions: [],
      stopLossConditions: [],
      premiseBreakConditions: [],
      riskGatePass: false,
      sevenAxis: { growth: 0, valuation: 0, momentum: 0, macro: 0, quality: 0, risk: 0, news: 0 },
    },
    ...overrides,
  }
}

// Helper: build a plan and return the row for code='1234'
function getRow(holding: Holding, analysis: HoldingAnalysis, targetTotalValue?: number) {
  const plan = buildStockPortfolioPlan([holding], [analysis], { targetTotalValue })
  return plan.rows[0]
}

describe('determineRecommendation via buildStockPortfolioPlan: WAIT_LOCK branch', () => {
  it('locked=true + diffValue <= -150000 returns WAIT_LOCK', () => {
    // acquiredAt = today → locked
    const today = new Date().toISOString().slice(0, 10)
    // currentValue=500000, targetTotalValue=300000 → diffValue = 300000 - 500000 = -200000
    const holding = makeHolding({ code: '1234', eval: 500_000, acquiredAt: today })
    const analysis = makeAnalysis({ code: '1234', decision: 'HOLD', totalScore: 60 })

    const row = getRow(holding, analysis, 300_000)
    expect(row.locked).toBe(true)
    expect(row.diffValue).toBeLessThanOrEqual(-150_000)
    expect(row.recommendation).toBe('WAIT_LOCK')
  })

  it('locked=true + decision=SELL + diffValue < 0 returns WAIT_LOCK', () => {
    // acquiredAt = today → locked
    const today = new Date().toISOString().slice(0, 10)
    // currentValue=500000, targetTotalValue=450000 → diffValue = -50000 (between -150k and 0)
    const holding = makeHolding({ code: '1234', eval: 500_000, acquiredAt: today })
    const analysis = makeAnalysis({ code: '1234', decision: 'SELL', totalScore: 25 })

    const row = getRow(holding, analysis, 450_000)
    expect(row.locked).toBe(true)
    expect(row.diffValue).toBeLessThan(0)
    expect(row.diffValue).toBeGreaterThan(-150_000)
    expect(row.recommendation).toBe('WAIT_LOCK')
  })

  it('locked=false + diffValue <= -150000 returns SELL (not WAIT_LOCK)', () => {
    // acquiredAt = 91 days ago → NOT locked
    const acquired = new Date()
    acquired.setDate(acquired.getDate() - 91)
    const acquiredAt = acquired.toISOString().slice(0, 10)

    const holding = makeHolding({ code: '1234', eval: 500_000, acquiredAt })
    const analysis = makeAnalysis({ code: '1234', decision: 'HOLD', totalScore: 60 })

    const row = getRow(holding, analysis, 300_000)
    expect(row.locked).toBe(false)
    expect(row.diffValue).toBeLessThanOrEqual(-150_000)
    expect(row.recommendation).toBe('SELL')
  })

  it('locked=false + decision=SELL + diffValue < 0 returns SELL (not WAIT_LOCK)', () => {
    // acquiredAt = 91 days ago → NOT locked
    const acquired = new Date()
    acquired.setDate(acquired.getDate() - 91)
    const acquiredAt = acquired.toISOString().slice(0, 10)

    const holding = makeHolding({ code: '1234', eval: 500_000, acquiredAt })
    const analysis = makeAnalysis({ code: '1234', decision: 'SELL', totalScore: 25 })

    const row = getRow(holding, analysis, 450_000)
    expect(row.locked).toBe(false)
    expect(row.diffValue).toBeLessThan(0)
    expect(row.recommendation).toBe('SELL')
  })
})
