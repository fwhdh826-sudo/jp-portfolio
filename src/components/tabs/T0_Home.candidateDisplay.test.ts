// P5-PRE-1: CandidateCard/TopCandidatesCard/useHasCandidateSectionContentが共有する
// 表示対象算出の純関数に対する回帰guard。P5で候補種別が増えた際も、この3箇所が
// 常に同じ結果を返すことをこのテストで担保する。
import { describe, it, expect } from 'vitest'
import type { OfficialDecision, OfficialDecisionItem, HoldingAnalysis, Holding } from '../../types'
import {
  computeCandidateActionsForDisplay,
  computeStockCandidateActionsForDisplay,
  computeTopCandidateSignalsForDisplay,
  isPortfolioSnapshotStale,
  candidateCardFooterText,
  computeHoldingsStale,
  computeSystemStatusNotices,
} from './T0_Home'

function makeAction(overrides: Partial<OfficialDecisionItem> = {}): OfficialDecisionItem {
  return {
    id: overrides.id ?? 'a1',
    assetType: 'jp_trust',
    name: 'テストファンド',
    action: 'BUY_NEW',
    reason: 'テスト理由',
    source: 'candidate',
    isCandidate: true,
    ...overrides,
  }
}

function makeOfficialDecision(actions: OfficialDecisionItem[], dataQualitySuppressed = false): OfficialDecision {
  return {
    generatedAt: '2026-01-01T00:00:00Z',
    source: 'candidate',
    headline: 'test',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed,
    actions,
    risks: [],
  } as unknown as OfficialDecision
}

describe('computeCandidateActionsForDisplay', () => {
  it('officialDecisionがnullのとき空配列を返す', () => {
    expect(computeCandidateActionsForDisplay(null, false, false)).toEqual([])
  })

  it('isCandidate=falseのactionは含めない', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'buy-existing', isCandidate: false, action: 'BUY' }),
      makeAction({ id: 'new', isCandidate: true, action: 'BUY_NEW' }),
    ])
    const result = computeCandidateActionsForDisplay(decision, false, false)
    expect(result.map(a => a.id)).toEqual(['new'])
  })

  it('BUY_NEW/WATCH以外のisCandidateアクションは含めない', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'sell-candidate', isCandidate: true, action: 'SELL' }),
      makeAction({ id: 'watch', isCandidate: true, action: 'WATCH' }),
    ])
    const result = computeCandidateActionsForDisplay(decision, false, false)
    expect(result.map(a => a.id)).toEqual(['watch'])
  })

  it('BUY抑制中はBUY_NEWを除外するがWATCHは維持する', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'new', isCandidate: true, action: 'BUY_NEW' }),
      makeAction({ id: 'watch', isCandidate: true, action: 'WATCH' }),
    ], true) // dataQualitySuppressed = true
    const result = computeCandidateActionsForDisplay(decision, false, false)
    expect(result.map(a => a.id)).toEqual(['watch'])
  })

  it('safeModeActive時もBUY_NEWを除外する', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'new', isCandidate: true, action: 'BUY_NEW' }),
      makeAction({ id: 'watch', isCandidate: true, action: 'WATCH' }),
    ])
    const result = computeCandidateActionsForDisplay(decision, false, true) // safeModeActive = true
    expect(result.map(a => a.id)).toEqual(['watch'])
  })

  it('4件以上あっても先頭3件までに絞る', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'w1', isCandidate: true, action: 'WATCH' }),
      makeAction({ id: 'w2', isCandidate: true, action: 'WATCH' }),
      makeAction({ id: 'w3', isCandidate: true, action: 'WATCH' }),
      makeAction({ id: 'w4', isCandidate: true, action: 'WATCH' }),
    ])
    const result = computeCandidateActionsForDisplay(decision, false, false)
    expect(result).toHaveLength(3)
  })

  // P5-B003: 株候補（assetType==='stock'）は投信候補枠から除外される
  it('assetType===stock の候補は含めない（株候補枠を侵食しない）', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'stock-1', assetType: 'stock', code: '7203', action: 'BUY_NEW' }),
      makeAction({ id: 'trust-1', assetType: 'jp_trust', action: 'BUY_NEW' }),
    ])
    const result = computeCandidateActionsForDisplay(decision, false, false)
    expect(result.map(a => a.id)).toEqual(['trust-1'])
  })
})

// P5-B003: computeStockCandidateActionsForDisplay — computeCandidateActionsForDisplayと
// 対称のロジックで、assetType==='stock' の候補だけを最大3件返す。
describe('computeStockCandidateActionsForDisplay', () => {
  it('officialDecisionがnullのとき空配列を返す', () => {
    expect(computeStockCandidateActionsForDisplay(null, false, false)).toEqual([])
  })

  it('assetType===jp_trust等の投信候補は含めない', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'trust-1', assetType: 'jp_trust', action: 'BUY_NEW' }),
      makeAction({ id: 'stock-1', assetType: 'stock', code: '7203', action: 'BUY_NEW' }),
    ])
    const result = computeStockCandidateActionsForDisplay(decision, false, false)
    expect(result.map(a => a.id)).toEqual(['stock-1'])
  })

  it('isCandidate=falseのstock actionは含めない', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'stock-buy', assetType: 'stock', code: '7203', isCandidate: false, action: 'BUY' }),
      makeAction({ id: 'stock-new', assetType: 'stock', code: '9984', isCandidate: true, action: 'BUY_NEW' }),
    ])
    const result = computeStockCandidateActionsForDisplay(decision, false, false)
    expect(result.map(a => a.id)).toEqual(['stock-new'])
  })

  it('BUY抑制中はBUY_NEWを除外するがWATCHは維持する', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'stock-new', assetType: 'stock', code: '7203', action: 'BUY_NEW' }),
      makeAction({ id: 'stock-watch', assetType: 'stock', code: '9984', action: 'WATCH' }),
    ], true)
    const result = computeStockCandidateActionsForDisplay(decision, false, false)
    expect(result.map(a => a.id)).toEqual(['stock-watch'])
  })

  it('safeModeActive時もBUY_NEWを除外する', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'stock-new', assetType: 'stock', code: '7203', action: 'BUY_NEW' }),
      makeAction({ id: 'stock-watch', assetType: 'stock', code: '9984', action: 'WATCH' }),
    ])
    const result = computeStockCandidateActionsForDisplay(decision, false, true)
    expect(result.map(a => a.id)).toEqual(['stock-watch'])
  })

  it('4件以上あっても先頭3件までに絞る', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 's1', assetType: 'stock', code: '1', action: 'WATCH' }),
      makeAction({ id: 's2', assetType: 'stock', code: '2', action: 'WATCH' }),
      makeAction({ id: 's3', assetType: 'stock', code: '3', action: 'WATCH' }),
      makeAction({ id: 's4', assetType: 'stock', code: '4', action: 'WATCH' }),
    ])
    const result = computeStockCandidateActionsForDisplay(decision, false, false)
    expect(result).toHaveLength(3)
  })

  it('投信候補・株候補が混在していても互いの枠を侵食しない', () => {
    const decision = makeOfficialDecision([
      makeAction({ id: 'trust-1', assetType: 'jp_trust', action: 'BUY_NEW' }),
      makeAction({ id: 'trust-2', assetType: 'global_trust', action: 'WATCH' }),
      makeAction({ id: 'stock-1', assetType: 'stock', code: '7203', action: 'BUY_NEW' }),
      makeAction({ id: 'stock-2', assetType: 'stock', code: '9984', action: 'WATCH' }),
    ])
    const fundResult  = computeCandidateActionsForDisplay(decision, false, false)
    const stockResult = computeStockCandidateActionsForDisplay(decision, false, false)
    expect(fundResult.map(a => a.id)).toEqual(['trust-1', 'trust-2'])
    expect(stockResult.map(a => a.id)).toEqual(['stock-1', 'stock-2'])
  })
})

function makeHoldingAnalysis(code: string): HoldingAnalysis {
  return {
    code,
    fundamentalScore: 20, marketScore: 15, technicalScore: 15,
    newsScore: 10, qualityScore: 8, riskPenalty: 2,
    totalScore: 70, ev: 0.05, decision: 'BUY', confidence: 0.8,
    strategyRank: 'B',
    debate: { agents: [], debateScore: 0, confidence: 0.8, finalView: 'BUY', bullReasons: [], bearReasons: [] },
  } as unknown as HoldingAnalysis
}

function makeHolding(code: string, overrides: Partial<Holding> = {}): Holding {
  return {
    code, name: code, eval: 100000, pnlPct: 0,
    mu: 0, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
    target: 0, alert: 0, lock: false, mitsu: false,
    ma: false, rsi: 50, macd: false, vol: false, mom3m: 0,
    roe: 0, per: 0, pbr: 0, epsG: 0, cfOk: true, de: 0, divG: 0,
    score: 70, decision: 'BUY', ev: 0.05,
    ...overrides,
  } as Holding
}

describe('computeTopCandidateSignalsForDisplay', () => {
  it('BUY抑制中はtopBuyを空にするがtopSellには影響しない', () => {
    const buyList  = [makeHoldingAnalysis('1001')]
    const sellList = [makeHoldingAnalysis('2001')]
    const holdings = [makeHolding('1001'), makeHolding('2001')]

    const result = computeTopCandidateSignalsForDisplay(buyList, sellList, holdings, false, false, true)
    expect(result.topBuy).toEqual([])
    expect(result.topSell.map(a => a.code)).toEqual(['2001'])
  })

  it('ロック中銘柄はtopSellから除外する', () => {
    const sellList = [makeHoldingAnalysis('2001'), makeHoldingAnalysis('2002')]
    const holdings = [makeHolding('2001', { lock: true }), makeHolding('2002', { lock: false })]

    const result = computeTopCandidateSignalsForDisplay([], sellList, holdings, false, false, false)
    expect(result.topSell.map(a => a.code)).toEqual(['2002'])
  })

  it('4件以上あっても先頭3件までに絞る', () => {
    const buyList = ['1', '2', '3', '4'].map(makeHoldingAnalysis)
    const result = computeTopCandidateSignalsForDisplay(buyList, [], [], false, false, false)
    expect(result.topBuy).toHaveLength(3)
  })

  it('新規候補・シグナルともにゼロのとき両方とも空配列', () => {
    const result = computeTopCandidateSignalsForDisplay([], [], [], false, false, false)
    expect(result.topBuy).toEqual([])
    expect(result.topSell).toEqual([])
  })
})

// P5-B003: フッター誘導文言 — 「投信候補」固定文言を株候補に使わないための分岐guard
describe('candidateCardFooterText', () => {
  it('fund指定でT7誘導文言を返す', () => {
    expect(candidateCardFooterText('fund')).toBe('詳細評価はT7（投信管理）で確認してください')
  })

  it('stock指定でT1誘導文言を返す（投信固定文言は使わない）', () => {
    const text = candidateCardFooterText('stock')
    expect(text).toBe('詳細はT1（今日の判断）で確認してください')
    expect(text).not.toContain('投信')
    expect(text).not.toContain('T7')
  })
})

// P5-B003: P4.5-A012整合 — portfolio localStorage鮮度の表示専用警告判定
describe('isPortfolioSnapshotStale', () => {
  it('localStorageFreshnessが未設定のときfalseを返す', () => {
    expect(isPortfolioSnapshotStale({})).toBe(false)
  })

  it('portfolio.isStale=trueのときtrueを返す', () => {
    expect(isPortfolioSnapshotStale({
      localStorageFreshness: { portfolio: { isStale: true } },
    })).toBe(true)
  })

  it('portfolio.isStale=falseのときfalseを返す', () => {
    expect(isPortfolioSnapshotStale({
      localStorageFreshness: { portfolio: { isStale: false } },
    })).toBe(false)
  })
})

// P4.5-A013-T6a: T0(SystemStatusBar)とT1(StockList)が共有する「保有データが古い」
// 判定の回帰guard。T1側もこの関数をそのままimportして使うため、ここで固定した
// 挙動がT0/T1双方のstale/fresh表示を担保する。
describe('computeHoldingsStale（T0/T1共通の保有データstale判定）', () => {
  it('localStorageFreshnessが未設定のときfalseを返す', () => {
    expect(computeHoldingsStale({})).toBe(false)
  })

  it('portfolio/trustともにfreshのときfalse（fresh状態→警告非表示）', () => {
    expect(computeHoldingsStale({
      localStorageFreshness: { portfolio: { isStale: false }, trust: { isStale: false } },
    })).toBe(false)
  })

  it('portfolioのみstaleのときtrue（stale状態→警告表示）', () => {
    expect(computeHoldingsStale({
      localStorageFreshness: { portfolio: { isStale: true }, trust: { isStale: false } },
    })).toBe(true)
  })

  it('trustのみstaleのときtrue（stale状態→警告表示）', () => {
    expect(computeHoldingsStale({
      localStorageFreshness: { portfolio: { isStale: false }, trust: { isStale: true } },
    })).toBe(true)
  })

  it('両方staleのときtrue', () => {
    expect(computeHoldingsStale({
      localStorageFreshness: { portfolio: { isStale: true }, trust: { isStale: true } },
    })).toBe(true)
  })
})

describe('computeSystemStatusNotices（T0 SystemStatusBarの表示内容・回帰guard）', () => {
  const baseInput = {
    safeModeRaw: false,
    safeModeDataStale: false,
    safeModeActive: false,
    dqSuppressed: false,
    noTrade: false,
    cashStale: false,
    holdingsStale: false,
  }

  it('全フラグfalseのときhasWarning=false（「✓ 判断可能」表示に対応）', () => {
    const result = computeSystemStatusNotices(baseInput)
    expect(result.hasWarning).toBe(false)
    expect(result.notices).toEqual([])
    expect(result.isSevere).toBe(false)
  })

  it('holdingsStale=trueのみでhasWarning=trueかつ保有データ警告文言を含む（T0: stale→警告表示）', () => {
    const result = computeSystemStatusNotices({ ...baseInput, holdingsStale: true })
    expect(result.hasWarning).toBe(true)
    expect(result.notices).toEqual(['📦 保有データが古い可能性 — CSV再取込/snapshot同期を推奨'])
    expect(result.isSevere).toBe(false)
  })

  it('holdingsStale=falseで他も全てfalseならhasWarning=false（T0: fresh→警告非表示）', () => {
    const result = computeSystemStatusNotices({ ...baseInput, holdingsStale: false })
    expect(result.hasWarning).toBe(false)
    expect(result.notices).not.toContain('📦 保有データが古い可能性 — CSV再取込/snapshot同期を推奨')
  })

  it('dqSuppressed=trueのときisSevere=true（severe表示の分岐を保つ）', () => {
    const result = computeSystemStatusNotices({ ...baseInput, dqSuppressed: true })
    expect(result.isSevere).toBe(true)
    expect(result.hasWarning).toBe(true)
  })

  it('safeModeActive=falseかつdqSuppressed=falseならholdingsStale単独ではisSevere=false', () => {
    const result = computeSystemStatusNotices({ ...baseInput, holdingsStale: true })
    expect(result.isSevere).toBe(false)
  })
})
