import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, Holding, HoldingAnalysis } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

// UI-9D P0-4回帰防止: T4 StockRow（個別株差分ランキング）の銘柄名が
// 390px以下で1文字縦列に崩壊するバグの修正確認。
// 内側flex行がminWidth:0を持ち、名前spanがnowrap+ellipsisで通常の横書きを維持することを
// レンダリング後の実HTML（renderToStaticMarkup）で検証する（source regexのみに依存しない）。

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

import { T4_IdealPf } from './T4_IdealPf'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t4Source from './T4_IdealPf.tsx?raw'

const isolated = createAppStoreInstanceForTest()
const BASE_APP_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()

const HOLDING: Holding = {
  code: '7203', name: 'トヨタ自動車', eval: 500_000, pnlPct: 5,
  mu: 0.05, sigma: 0.2, sigmaSource: 'static', beta: 1.0, sector: '輸送用機器',
  target: 3200, alert: 2600, lock: false, mitsu: false,
  ma: true, rsi: 55, macd: true, vol: false, mom3m: 3,
  roe: 12, per: 15, pbr: 1.2, epsG: 5, cfOk: true, de: 0.5, divG: 2,
  score: 70, decision: 'HOLD', ev: 0.02,
}

const ANALYSIS: HoldingAnalysis = {
  code: '7203', fundamentalScore: 20, marketScore: 15, technicalScore: 15,
  newsScore: 10, qualityScore: 7, riskPenalty: 3, totalScore: 70,
  ev: 0.02, decision: 'HOLD', confidence: 0.6, strategyRank: 'B',
  debate: {
    agents: [],
    debateScore: 70, confidence: 0.6, finalView: 'HOLD',
    bullReasons: [], bearReasons: [],
    buyReasons: [], waitReasons: [], sellReasons: [],
    recommendedAction: 'HOLD',
    takeProfitConditions: [], stopLossConditions: [], premiseBreakConditions: [],
    riskGatePass: true,
    sevenAxis: { growth: 60, valuation: 55, momentum: 60, macro: 50, quality: 65, risk: 40, news: 55 },
  },
}

function renderT4(): string {
  mockedStore.state = { ...BASE_APP_STATE, activeTab: 'T4', holdings: [HOLDING], analysis: [ANALYSIS] }
  return renderToStaticMarkup(<T4_IdealPf />)
}

describe('T4 StockRow — P0-4: 390px銘柄名1文字縦列化の回帰防止', () => {
  it('個別株差分ランキングに対象銘柄が実際にレンダリングされる（前提確認）', () => {
    const html = renderT4()
    expect(html).toContain('トヨタ自動車')
  })

  it('銘柄名を囲む内側flex行がmin-width:0を持つ（行全体が縮小可能）', () => {
    const html = renderT4()
    const rowMatch = html.match(/<div style="[^"]*display:flex[^"]*"[^>]*><span style="[^"]*">トヨタ自動車<\/span>/)
    expect(rowMatch).toBeTruthy()
    expect(rowMatch![0]).toContain('min-width:0')
  })

  it('銘柄名spanがnowrap+ellipsisで通常の横書き状態を維持する', () => {
    const html = renderT4()
    const nameSpanMatch = html.match(/<span style="([^"]*)">トヨタ自動車<\/span>/)
    expect(nameSpanMatch).toBeTruthy()
    const style = nameSpanMatch![1]
    expect(style).toContain('white-space:nowrap')
    expect(style).toContain('min-width:0')
    expect(style).toContain('text-overflow:ellipsis')
  })

  it('ソース上もStockRow内側行にminWidth:0契約が存在する（構造的回帰防止の二重チェック）', () => {
    const stockRowSection = t4Source.slice(t4Source.indexOf('function StockRow'))
    const innerFlexRow = stockRowSection.slice(0, stockRowSection.indexOf('SignalBadge'))
    expect(innerFlexRow).toContain('minWidth: 0')
    expect(innerFlexRow).toContain('whiteSpace: \'nowrap\'')
  })
})
