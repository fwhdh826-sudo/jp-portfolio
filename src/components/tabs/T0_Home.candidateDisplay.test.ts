// CAND-SYN-1D: CandidateCard/useHasCandidateSectionContentが共有する
// 表示対象算出の純関数に対する回帰guard。T0はcandidateDecisionSynthesis.decisions
// のみを読み、再フィルタ・再スライス・再ランクは行わない（D13）。
import { describe, it, expect } from 'vitest'
import type { HoldingAnalysis, Holding } from '../../types'
import type {
  CandidateDecisionSynthesisEntry,
  CandidateDecisionSynthesisSnapshot,
} from '../../types/candidateDecisionSynthesis'
import {
  computeSynthesisDecisionsForDisplay,
  computeTopCandidateSignalsForDisplay,
  isPortfolioSnapshotStale,
  candidateCardFooterText,
  computeHoldingsStale,
  computeSystemStatusNotices,
} from './T0_Home'
import { TAB_META_BY_ID } from '../../constants/tabs'

function makeEntry(overrides: Partial<CandidateDecisionSynthesisEntry> = {}): CandidateDecisionSynthesisEntry {
  return {
    entryId: overrides.entryId ?? 'JP_TRUST:trust:held_overseas',
    instrumentId: 'trust:held_overseas',
    assetClass: 'JP_TRUST',
    displayName: 'テストファンド',
    code: null,
    action: 'BUY_NEW',
    rank: 1,
    relationship: 'new_to_portfolio',
    candidateQuality: {
      source: 'trust_registry',
      marketRank: null,
      marketScore: null,
      tier: null,
      dataConfidence: null,
      selectedReasons: [],
      riskReasons: [],
    },
    portfolioFit: { status: 'not_evaluated', relationship: null, reasons: [], risks: [], hardGatePassed: true },
    allocationRole: { assetClassTargetGap: 0, assetClassTargetRatio: 0.1, classHeadroom: 0, instrumentHeadroom: 0 },
    money: { kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 },
    blockingReasons: [],
    warnings: [],
    limitingFactors: [],
    whyThis: [],
    whyNotExecutable: [],
    ...overrides,
  }
}

function makeSnapshot(
  decisions: CandidateDecisionSynthesisEntry[],
  overrides: Partial<CandidateDecisionSynthesisSnapshot> = {},
): CandidateDecisionSynthesisSnapshot {
  return {
    schemaVersion: 'candidate-decision-synthesis-1',
    authorityVersion: 'cand-syn-v1',
    synthesisId: 'candidate-decision-synthesis:test',
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'available',
    provenance: {} as CandidateDecisionSynthesisSnapshot['provenance'],
    decisions,
    watchList: [],
    datasetReasons: [],
    privacyMode: 'local_only',
    persistence: 'none',
    not_for_trading: true,
    ...overrides,
  }
}

describe('computeSynthesisDecisionsForDisplay', () => {
  it('synthesisがnullのとき空配列を返す（fail-closed、legacyフォールバックなし）', () => {
    expect(computeSynthesisDecisionsForDisplay(null)).toEqual([])
  })

  it('status !== available のとき空配列を返す', () => {
    expect(computeSynthesisDecisionsForDisplay(makeSnapshot([], { status: 'invalid' }))).toEqual([])
    expect(computeSynthesisDecisionsForDisplay(makeSnapshot([], { status: 'unavailable' }))).toEqual([])
  })

  it('status===available のとき synthesis.decisions をそのまま返す（再フィルタ・再スライスしない）', () => {
    const decisions = [
      makeEntry({ entryId: 'a' }),
      makeEntry({ entryId: 'b' }),
      makeEntry({ entryId: 'c' }),
    ]
    const result = computeSynthesisDecisionsForDisplay(makeSnapshot(decisions))
    expect(result).toBe(decisions) // 同一参照 — UI側でコピー・再ソートしない
  })

  it('decisions が空のとき空配列を返す（候補なし状態）', () => {
    expect(computeSynthesisDecisionsForDisplay(makeSnapshot([]))).toEqual([])
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
    expect(text).toBe('詳細はT1（個別株）で確認してください')
    expect(text).not.toContain('投信')
    expect(text).not.toContain('T7')
  })

  // H-P0-1: T0自身のtitleが「今日の判断」であり、T1への誘導文にT0の名前を
  // 誤って付けていた（UI-9H P0）。tabs.ts（TAB_META）のT1正典labelとの一致を
  // 固定し、再発（誤称への回帰）をRED化する。
  it('stock指定の誘導文言はtabs.ts（TAB_META）のT1正典labelと一致する（誤称回帰guard）', () => {
    const t1Label = TAB_META_BY_ID['T1'].label
    expect(t1Label).toBe('個別株')
    const text = candidateCardFooterText('stock')
    expect(text).toBe(`詳細はT1（${t1Label}）で確認してください`)
    // T0自身のtitle「今日の判断」を参照先タブの名前として使ってはならない
    expect(text).not.toContain('今日の判断')
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
    isRealSafeMode: false,
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
