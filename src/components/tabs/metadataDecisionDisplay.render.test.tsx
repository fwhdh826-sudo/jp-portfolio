import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Holding, HoldingAnalysis, StockDecision } from '../../types'
import type { StockRecommendation } from '../../domain/optimization/stockPortfolio'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const fixtures = vi.hoisted(() => ({
  state: null as AppState | null,
  recommendation: 'HOLD' as StockRecommendation,
  reason: '現状維持で監視。',
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

vi.mock('../../domain/optimization/stockPortfolio', async importOriginal => {
  const actual = await importOriginal<typeof import('../../domain/optimization/stockPortfolio')>()
  return {
    ...actual,
    buildStockPortfolioPlan: () => {
      const row = {
        code: '7203', name: '表示契約テスト銘柄', currentValue: 500_000, currentWeight: 1,
        targetValue: 500_000, targetWeight: 1, diffValue: 0,
        recommendation: fixtures.recommendation,
        stance: fixtures.recommendation === 'SELL' ? 'reduce' as const : 'watch' as const,
        locked: false, lockRemainingDays: 0, sellableAt: null,
        reason: fixtures.reason, holdingStyle: '表示契約テスト', confidence: 0.6, score: 70,
      }
      return {
        generatedAt: '2026-08-31T00:00:00.000Z', totalStockValue: 500_000,
        lockCount: 0, sellableCount: 1, rows: [row], rebalanceTop: [row], swapIdeas: [],
      }
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

function setState(decision: StockDecision, suppressed = false) {
  const analysis = makeAnalysis(decision)
  fixtures.state = {
    ...BASE_APP_STATE,
    activeTab: 'T4',
    holdings: [{ ...HOLDING, decision }],
    analysis: [analysis],
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

function renderT4StockRow(recommendation: StockRecommendation, suppressed = false): { markup: string; text: string } {
  fixtures.recommendation = recommendation
  fixtures.reason = recommendation === 'INSUFFICIENT_EVIDENCE'
    ? '分析データ不足。ファンダメンタル・テクニカル取得後に再評価。'
    : '現状維持で監視。'
  setState(recommendation === 'INSUFFICIENT_EVIDENCE' ? 'INSUFFICIENT_EVIDENCE' : recommendation === 'SELL' ? 'SELL' : 'HOLD', suppressed)
  const html = renderToStaticMarkup(<T4_IdealPf />)
  const start = html.indexOf('表示契約テスト銘柄')
  const end = html.indexOf(`${fixtures.reason} / スコア`, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const markup = html.slice(start, end + fixtures.reason.length)
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
  it('INSUFFICIENT_EVIDENCEを独立表示し、HOLD/BUY/SELL badgeへ渡さない', () => {
    const { markup, text } = renderT4StockRow('INSUFFICIENT_EVIDENCE')
    expect(text).toContain('分析データ不足')
    expect(text).toContain('取得後に再評価')
    expect(markup.match(/aria-label="シグナル: 保有"/g) ?? []).toHaveLength(0)
    expect(markup.match(/aria-label="シグナル: 買い"/g) ?? []).toHaveLength(0)
    expect(markup.match(/aria-label="シグナル: 売り"/g) ?? []).toHaveLength(0)
  })

  it('既知のHOLDとSELLは従来のSignalBadgeを維持する', () => {
    expect(renderT4StockRow('HOLD').markup).toContain('aria-label="シグナル: 保有"')
    expect(renderT4StockRow('SELL').markup).toContain('aria-label="シグナル: 売り"')
  })

  it('抑制されたBUYは従来どおりSUPPRESSED badgeになる', () => {
    const { markup, text } = renderT4StockRow('BUY', true)
    expect(markup).toContain('aria-label="シグナル: 抑制中"')
    expect(markup).not.toContain('aria-label="シグナル: 買い"')
    expect(text).toContain('抑制中')
  })
})
