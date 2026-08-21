import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Holding, HoldingAnalysis, Trust, LearningState, TabId } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

// UI-9D: 全タブ共通のheading contractを検証する。
// - PageHeaderによりh1は各タブ厳密に1件
// - 各タブは最低1件のh2を持つ（P0-2: T0/T5/T8/T9のzero-heading状態を解消）
// - DOM順でheading levelのskipは1を超えない（root h1から始まる正常な階層のみ許容）
// - role="heading"は使用しない（監査freeze仕様: native heading要素のみ）

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('store fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

import { T0_Home } from './T0_Home'
import { T1_Decision } from './T1_Decision'
import { T2_JpFund } from './T2_JpFund'
import { T3_GlobalFund } from './T3_GlobalFund'
import { T4_IdealPf } from './T4_IdealPf'
import { T5_News } from './T5_News'
import { T6_Committee } from './T6_Committee'
import { T7_Trust } from './T7_Trust'
import { T8_Learning } from './T8_Learning'
import { T9_Settings } from './T9_Settings'

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '7203', name: 'トヨタ自動車', eval: 500_000, pnlPct: 5,
    mu: 0.05, sigma: 0.2, sigmaSource: 'static', beta: 1.0, sector: '輸送用機器',
    target: 3200, alert: 2600, lock: false, mitsu: false,
    ma: true, rsi: 55, macd: true, vol: false, mom3m: 3,
    roe: 12, per: 15, pbr: 1.2, epsG: 5, cfOk: true, de: 0.5, divG: 2,
    score: 70, decision: 'HOLD', ev: 0.02,
    ...overrides,
  }
}

function makeAnalysis(overrides: Partial<HoldingAnalysis> = {}): HoldingAnalysis {
  return {
    code: '7203', fundamentalScore: 20, marketScore: 15, technicalScore: 15,
    newsScore: 10, qualityScore: 7, riskPenalty: 3, totalScore: 70,
    ev: 0.02, decision: 'HOLD', confidence: 0.6, strategyRank: 'B',
    debate: {
      agents: [],
      debateScore: 70, confidence: 0.6, finalView: 'HOLD',
      bullReasons: ['業績堅調'], bearReasons: ['円高リスク'],
      buyReasons: [], waitReasons: ['様子見'], sellReasons: [],
      recommendedAction: 'HOLD',
      takeProfitConditions: ['+20%到達'], stopLossConditions: ['-15%到達'],
      premiseBreakConditions: ['決算下方修正'],
      riskGatePass: true,
      sevenAxis: { growth: 60, valuation: 55, momentum: 60, macro: 50, quality: 65, risk: 40, news: 55 },
    },
    ...overrides,
  }
}

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'trust:test-1', name: 'テスト投信', abbr: 'TEST', account: 'test',
    policy: 'JAPAN_SHORTTERM', eval: 300_000, pnlPct: 2, dayPct: 0.3,
    cost: 0.2, mu: 0.04, sigma: 0.18, score: 60, signal: 'BULL', ev: 0.01,
    decision: 'HOLD',
    ...overrides,
  }
}

function makeDecisionSummary(): { count: number; wins: number; losses: number; flats: number; accuracy: number; avgReward: number } {
  return { count: 10, wins: 6, losses: 3, flats: 1, accuracy: 60, avgReward: 0.05 }
}

function makeLearning(): LearningState {
  return {
    lastUpdated: '2026-08-01T00:00:00.000Z',
    baselineCount: 10,
    baseline: [],
    outcomes: [{
      code: '7203', predictedAt: '2026-07-01T00:00:00.000Z', evaluatedAt: '2026-07-15T00:00:00.000Z',
      decision: 'BUY', score: 70, confidence: 0.6, prevPnlPct: 2, currPnlPct: 5, deltaPnlPct: 3,
      reward: 0.05, result: 'win', regime: 'bull',
    }],
    summary: {
      total: 10, wins: 6, losses: 3, flats: 1, accuracy: 60, avgReward: 0.05,
      byDecision: { BUY: makeDecisionSummary(), HOLD: makeDecisionSummary(), SELL: makeDecisionSummary() },
      driftSignals: ['安定稼働中'],
    },
    suggestedWeights: { fundamental: 30, market: 20, technical: 20, news: 15, quality: 10, risk: 15 },
  }
}

const HOLDING = makeHolding()
const ANALYSIS = makeAnalysis()
const TRUST_JP = makeTrust({ id: 'trust:jp', policy: 'JAPAN_SHORTTERM' })
const TRUST_GLOBAL = makeTrust({ id: 'trust:global', policy: 'OVERSEAS_LONGTERM', name: 'テスト海外投信' })
const LEARNING = makeLearning()

const TAB_OVERRIDES: Record<TabId, Partial<AppState>> = {
  T0: { holdings: [HOLDING], analysis: [ANALYSIS], trust: [TRUST_JP, TRUST_GLOBAL] },
  T1: { holdings: [HOLDING], analysis: [ANALYSIS] },
  T2: { trust: [TRUST_JP] },
  T3: { trust: [TRUST_GLOBAL] },
  T4: { holdings: [HOLDING], analysis: [ANALYSIS], trust: [TRUST_JP, TRUST_GLOBAL] },
  T5: {},
  T6: { holdings: [HOLDING], analysis: [ANALYSIS] },
  T7: { trust: [TRUST_JP] },
  T8: { learning: LEARNING },
  T9: {},
}

const TAB_COMPONENT: Record<TabId, () => JSX.Element> = {
  T0: T0_Home, T1: T1_Decision, T2: T2_JpFund, T3: T3_GlobalFund, T4: T4_IdealPf,
  T5: T5_News, T6: T6_Committee, T7: T7_Trust, T8: T8_Learning, T9: T9_Settings,
}

function renderTab(id: TabId): string {
  mockedStore.state = { ...BASE_APP_STATE, activeTab: id, ...TAB_OVERRIDES[id] }
  const Component = TAB_COMPONENT[id]
  return renderToStaticMarkup(<Component />)
}

function extractHeadingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])\b/g)].map(m => Number(m[1]))
}

function maxForwardSkip(levels: number[]): number {
  let maxSeen = 0
  let maxSkip = 0
  for (const lvl of levels) {
    if (lvl > maxSeen + 1) maxSkip = Math.max(maxSkip, lvl - (maxSeen + 1))
    maxSeen = Math.max(maxSeen, lvl)
  }
  return maxSkip
}

const ALL_TABS: TabId[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']

describe('UI-9D heading contract — T0-T9', () => {
  describe.each(ALL_TABS)('%s', id => {
    const html = renderTab(id)
    const levels = extractHeadingLevels(html)

    it('h1がちょうど1件', () => {
      expect(levels.filter(l => l === 1)).toHaveLength(1)
    })

    it('h2が1件以上存在する', () => {
      expect(levels.filter(l => l === 2).length).toBeGreaterThanOrEqual(1)
    })

    it('DOM順でheading levelのskipが1を超えない', () => {
      expect(maxForwardSkip(levels)).toBeLessThanOrEqual(1)
    })

    it('role="heading"を使用しない', () => {
      expect(html).not.toContain('role="heading"')
    })
  })
})
