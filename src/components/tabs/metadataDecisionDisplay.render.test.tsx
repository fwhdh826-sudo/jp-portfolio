import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Holding, HoldingAnalysis, StockDecision } from '../../types'
import { buildStockPortfolioPlan } from '../../domain/optimization/stockPortfolio'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const fixtures = vi.hoisted(() => ({
  state: null as AppState | null,
}))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (fixtures.state === null) throw new Error('display fixture is not initialized')
      return selector(fixtures.state)
    },
  }
})

import { T4_IdealPf } from './T4_IdealPf'
import { T6_Committee } from './T6_Committee'

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

const NOW_ISO = new Date().toISOString()

const HOLDING: Holding = {
  code: '7203', name: '表示契約テスト銘柄', eval: 500_000, pnlPct: 5,
  mu: 0.05, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: '輸送用機器',
  target: 3200, alert: 2600, lock: false, mitsu: false,
  ma: true, rsi: 55, macd: true, vol: false, mom3m: 3,
  roe: 12, per: 15, pbr: 1.2, epsG: 5, cfOk: true, de: 0.5, divG: 2,
  score: 70, decision: 'HOLD', ev: 0.02,
}

function makeAnalysis(decision: StockDecision): HoldingAnalysis {
  return {
    code: '7203', fundamentalScore: 20, marketScore: 15, technicalScore: 15,
    newsScore: 10, qualityScore: 7, riskPenalty: 3, totalScore: 70,
    ev: 0.02, decision, confidence: 0.6, strategyRank: 'B',
    debate: {
      agents: [], debateScore: 70, confidence: 0.6, finalView: decision,
      bullReasons: [], bearReasons: [], buyReasons: [], waitReasons: [], sellReasons: [],
      recommendedAction: decision === 'INSUFFICIENT_EVIDENCE' ? '取得後に再評価' : '表示契約を維持',
      takeProfitConditions: [], stopLossConditions: [], premiseBreakConditions: [],
      riskGatePass: true,
      sevenAxis: { growth: 60, valuation: 55, momentum: 60, macro: 50, quality: 65, risk: 40, news: 55 },
    },
  }
}

function setState(
  decision: StockDecision,
  suppressed = false,
  holdingOverrides: Partial<Holding> = {},
) {
  const holding = { ...HOLDING, decision, ...holdingOverrides }
  const analysis = { ...makeAnalysis(decision), code: holding.code }
  setPortfolioState([holding], [analysis], suppressed)
}

function setPortfolioState(
  holdings: Holding[],
  analysis: HoldingAnalysis[],
  suppressed = false,
  grossCash = 0,
) {
  fixtures.state = {
    ...BASE_APP_STATE,
    activeTab: 'T4',
    holdings,
    analysis,
    cashAssumptions: grossCash > 0
      ? {
          source: 'MANUAL', grossCash, safetyReserve: 0, pendingOrderCash: 0,
          updatedAt: NOW_ISO,
        }
      : BASE_APP_STATE.cashAssumptions,
    market: { ...BASE_APP_STATE.market, last_updated: NOW_ISO },
    system: {
      ...BASE_APP_STATE.system,
      status: 'success',
      dataSourceStatus: { ...BASE_APP_STATE.system.dataSourceStatus, market: 'loaded', safeMode: 'loaded' },
      dataTimestamps: { ...BASE_APP_STATE.system.dataTimestamps!, market: NOW_ISO, safeMode: NOW_ISO },
    },
    safeMode: {
      ...BASE_APP_STATE.safeMode,
      safe_mode: { ...BASE_APP_STATE.safeMode.safe_mode, active: suppressed, last_checked: NOW_ISO },
    },
  }
}

function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

function renderT6Hero(decision: StockDecision, suppressed = false): string {
  setState(decision, suppressed)
  const html = renderToStaticMarkup(<T6_Committee />)
  const start = html.indexOf('1 / 参考見解')
  const end = html.indexOf('2 / AI討論ログ', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return visibleText(html.slice(start, end))
}

function renderT4StockRow(
  decision: StockDecision,
  suppressed = false,
  holdingOverrides: Partial<Holding> = {},
): { html: string; markup: string; text: string } {
  setState(decision, suppressed, holdingOverrides)
  const html = renderToStaticMarkup(<T4_IdealPf />)
  const name = holdingOverrides.name ?? HOLDING.name
  const start = html.indexOf(name)
  const end = html.indexOf('/ スコア', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const markup = html.slice(start, end)
  return { html, markup, text: visibleText(markup) }
}

function renderT4SuppressedBuyRow(): { markup: string; text: string } {
  const buyHolding: Holding = {
    ...HOLDING, code: '7203', name: '既知BUYテスト銘柄', eval: 100_000,
    sector: 'BUYテスト', decision: 'BUY',
  }
  const otherHolding: Holding = {
    ...HOLDING, code: '9999', name: '配分比較銘柄', eval: 900_000,
    sector: '比較テスト', decision: 'SELL',
  }
  const buyAnalysis: HoldingAnalysis = {
    ...makeAnalysis('BUY'), code: buyHolding.code, totalScore: 95,
  }
  const otherAnalysis: HoldingAnalysis = {
    ...makeAnalysis('SELL'), code: otherHolding.code,
    fundamentalScore: 0, marketScore: 0, technicalScore: 0,
    newsScore: 0, qualityScore: 0, totalScore: 10, confidence: 0, ev: 0,
  }
  setPortfolioState(
    [buyHolding, otherHolding],
    [buyAnalysis, otherAnalysis],
    true,
    9_000_000,
  )
  const html = renderToStaticMarkup(<T4_IdealPf />)
  const start = html.indexOf(buyHolding.name)
  const end = html.indexOf('/ スコア', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const markup = html.slice(start, end)
  return { markup, text: visibleText(markup) }
}

describe('T6 HeroVerdictPanel metadata display', () => {
  it('INSUFFICIENT_EVIDENCEを分析データ不足として表示し、raw/HOLD/WAITを表示しない', () => {
    const text = renderT6Hero('INSUFFICIENT_EVIDENCE')
    expect(text).toContain('分析データ不足')
    expect(text.match(/INSUFFICIENT_EVIDENCE/g) ?? []).toHaveLength(0)
    expect(text).not.toMatch(/\b(?:HOLD|WAIT)\b/)
  })

  it('既知のHOLDとSELLは従来表示を維持する', () => {
    expect(renderT6Hero('HOLD')).toContain('HOLD')
    expect(renderT6Hero('SELL')).toContain('SELL')
  })

  it('抑制されたBUYは従来どおりWAIT表示になる', () => {
    const text = renderT6Hero('BUY', true)
    expect(text).toContain('WAIT')
    expect(text).toContain('買付は参考停止')
    expect(text).not.toMatch(/\bBUY\b/)
  })
})

describe('T4 StockRow metadata display', () => {
  it('実runtimeのrowsからINSUFFICIENT_EVIDENCEを分析待ちsectionへ表示し、action badgeへ渡さない', () => {
    const { html, markup, text } = renderT4StockRow('INSUFFICIENT_EVIDENCE', true)
    expect(html).toContain('個別株 分析待ち')
    expect(html).toContain('ファンダメンタル・テクニカル取得後に再評価')
    expect(html).not.toContain('個別株 差分ランキング')
    expect(text).toContain('分析データ不足')
    expect(text).toContain('表示契約テスト銘柄')
    expect(text).toContain('取得後に再評価')
    expect(markup.match(/aria-label="シグナル: 保有"/g) ?? []).toHaveLength(0)
    expect(markup.match(/aria-label="シグナル: 買い"/g) ?? []).toHaveLength(0)
    expect(markup.match(/aria-label="シグナル: 売り"/g) ?? []).toHaveLength(0)
    expect(markup.match(/aria-label="シグナル: 抑制中"/g) ?? []).toHaveLength(0)

    const plan = buildStockPortfolioPlan(
      [{ ...HOLDING, decision: 'INSUFFICIENT_EVIDENCE' }],
      [makeAnalysis('INSUFFICIENT_EVIDENCE')],
      { targetTotalValue: 50_000 },
    )
    expect(plan.rows[0].recommendation).toBe('INSUFFICIENT_EVIDENCE')
    expect(plan.rebalanceTop.some(row => row.code === HOLDING.code)).toBe(false)
  })

  it('既知のHOLDとSELLは従来のSignalBadgeを維持する', () => {
    const hold = renderT4StockRow('HOLD', false, { eval: 100_000 })
    expect(hold.html).toContain('個別株 差分ランキング')
    expect(hold.markup).toContain('aria-label="シグナル: 保有"')

    const sell = renderT4StockRow('SELL', false, { eval: 500_000 })
    expect(sell.html).toContain('個別株 差分ランキング')
    expect(sell.markup).toContain('aria-label="シグナル: 売り"')
  })

  it('実runtimeで抑制されたBUYは従来どおりSUPPRESSED badgeになる', () => {
    const { markup, text } = renderT4SuppressedBuyRow()
    expect(markup).toContain('aria-label="シグナル: 抑制中"')
    expect(markup).not.toContain('aria-label="シグナル: 買い"')
    expect(text).toContain('抑制中')
  })
})
