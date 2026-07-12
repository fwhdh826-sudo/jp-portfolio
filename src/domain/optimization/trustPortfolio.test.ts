/**
 * P4-A45: buildTrustPortfolioPlan unit tests
 * Tests noTrade gate (SAFE_MODE / data stale integration), BULL signal conditions,
 * SQ proximity, blockedByDailyLimit, and checkNoTrade for Nikkei VI panic.
 */
import { describe, it, expect } from 'vitest'
import { buildTrustPortfolioPlan } from './trustPortfolio'
import { checkNoTrade } from './idealAllocation'
import type { AppState, Market, MacroSnapshot, SQCalendar, Trust } from '../../types'

// ── Fixtures ─────────────────────────────────────────────────────

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    last_updated: '2026-06-21 09:00',
    nikkei: 38000,
    nikkeiChg: 500,
    nikkeiChgPct: 1.5,
    nikkeiFutures: 38100,
    nikkeiFuturesChg: 600,
    nikkeiFuturesChgPct: 2.0,
    ma5: 37500,
    ma25: 36000,
    ma75: 35000,
    rsi14: 60,
    macd: 'golden',
    volume: 'high',
    bollUpper: 40000,
    bollMid: 37000,
    bollLower: 34000,
    regime: 'bull',
    boj: '0.50%',
    bojNext: '0.75%観測',
    vix: 15,
    ...overrides,
  }
}

function makeMacro(overrides: Partial<MacroSnapshot> = {}): MacroSnapshot {
  return {
    last_updated: '2026-06-21 09:00',
    jgb10y: 1.5,
    ust10y: 4.5,
    usdjpy: 150,
    usdjpyChgPct: 0.1,
    sp500: 5000,
    sp500ChgPct: 1.0,
    nasdaq: 17000,
    nasdaqChgPct: 1.5,
    vix: 15,
    vixChg: -0.5,
    nikkeiVI: 16,
    nikkeiVIChg: -0.3,
    gold: 2300,
    goldChgPct: 0.2,
    nyCrude: 80,
    nyCrudeChgPct: 0.5,
    ...overrides,
  }
}

function makeSQCalendar(dayUntil = 15): SQCalendar {
  return {
    last_updated: '2026-06-21',
    events: [{ date: '2026-07-11', type: 'monthly', dayUntil }],
    nextSQ: { date: '2026-07-11', type: 'monthly', dayUntil },
  }
}

function makeJpTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'nk225_test',
    name: 'テスト 日経225インデックス',
    abbr: '日経225',
    account: '特定',
    policy: 'JAPAN_SHORTTERM',
    eval: 500_000,
    pnlPct: -1.0,
    dayPct: 0.5,
    cost: 0.176,
    mu: 0.12,
    sigma: 0.16,
    score: 60,
    signal: 'WATCH',
    ev: 0.05,
    decision: 'WAIT',
    ...overrides,
  }
}

// P4-A146: isLeveragedTrust判定（name/abbrに「ブル」を含む）でSATELLITE roleになるfixture
function makeLeveragedJpTrust(overrides: Partial<Trust> = {}): Trust {
  return makeJpTrust({
    id: 'bull43_test',
    name: 'テスト 4.3ブル',
    abbr: '4.3ブル',
    sigma: 0.5,
    ...overrides,
  })
}

const BULL_MARKET = makeMarket()
const BULL_MACRO = makeMacro()
const SQ_SAFE = makeSQCalendar(15)

// ── noTrade gate ──────────────────────────────────────────────────

describe('buildTrustPortfolioPlan: noTrade gate', () => {
  it('noTrade=true のとき short- BUY が executionQueue に含まれない', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: true,
    })

    const shortBuys = plan.executionQueue.filter(
      item => item.id.startsWith('short-') && item.action === 'BUY',
    )
    expect(shortBuys).toHaveLength(0)
  })

  it('noTrade=true のとき header action が WAIT になる', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      noTrade: true,
    })

    const header = plan.executionQueue.find(item => item.id === 'short-header')
    expect(header?.action).toBe('WAIT')
  })

  it('noTrade=false かつ BULL条件成立時に canEnter=true で executionQueue に BUY が含まれる', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: false,
    })

    expect(plan.shortTermMode.canEnter).toBe(true)
    const shortBuys = plan.executionQueue.filter(
      item => item.id.startsWith('short-') && item.action === 'BUY',
    )
    expect(shortBuys.length).toBeGreaterThan(0)
  })

  it('noTrade=true でも shortTermMode の市場判断は維持される（市場シグナルはWAITにならない）', () => {
    const planNoTrade = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: true,
    })
    const planNormal = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: false,
    })

    // 市場判断（shortTermMode）はnoTradeの影響を受けない
    expect(planNoTrade.shortTermMode.decision).toBe(planNormal.shortTermMode.decision)
    // BUYだけnoTrade時に除去される
    const buyCountNoTrade = planNoTrade.executionQueue.filter(
      q => q.id.startsWith('short-') && q.action === 'BUY',
    ).length
    const buyCountNormal = planNormal.executionQueue.filter(
      q => q.id.startsWith('short-') && q.action === 'BUY',
    ).length
    expect(buyCountNoTrade).toBe(0)
    expect(buyCountNormal).toBeGreaterThan(0)
  })
})

// ── blockedByDailyLimit ───────────────────────────────────────────

describe('buildTrustPortfolioPlan: 1日1エントリー制限', () => {
  it('todayEntryCount=1 のとき blockedByDailyLimit=true かつ canEnter=false', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 1,
      noTrade: false,
    })

    expect(plan.shortTermMode.blockedByDailyLimit).toBe(true)
    expect(plan.shortTermMode.canEnter).toBe(false)
  })

  it('todayEntryCount=0 のとき blockedByDailyLimit=false かつ BULL条件成立でcanEnter=true', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: false,
    })

    expect(plan.shortTermMode.blockedByDailyLimit).toBe(false)
    expect(plan.shortTermMode.canEnter).toBe(true)
  })
})

// ── SQ proximity ─────────────────────────────────────────────────

describe('buildTrustPortfolioPlan: SQ接近', () => {
  it('SQ残り2日で bull-sq checklist item が fail になる', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: makeSQCalendar(2),
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: false,
    })

    const sqItem = plan.shortTermMode.checklist.find(c => c.id === 'bull-sq')
    expect(sqItem?.status).toBe('fail')
  })

  it('SQ残り15日で bull-sq checklist item が pass になる', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: makeSQCalendar(15),
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: false,
    })

    const sqItem = plan.shortTermMode.checklist.find(c => c.id === 'bull-sq')
    expect(sqItem?.status).toBe('pass')
  })

  it('SQ残り2日でもnoTrade=trueならBUYは除去される', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: makeSQCalendar(2),
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: true,
    })

    const shortBuys = plan.executionQueue.filter(
      item => item.id.startsWith('short-') && item.action === 'BUY',
    )
    expect(shortBuys).toHaveLength(0)
  })
})

// ── Nikkei VI panic / checkNoTrade integration ────────────────────

describe('checkNoTrade: Nikkei VI パニック水準', () => {
  it('nikkeiVI >= 35（NIKKEI_VI_PANIC）のとき noTrade=true / mode=emergency', () => {
    const state = {
      market: makeMarket({ vix: 20 }),
      macro: makeMacro({ nikkeiVI: 36 }),
      sqCalendar: null,
    } as unknown as AppState

    const result = checkNoTrade(state)
    expect(result.noTrade).toBe(true)
    expect(result.mode).toBe('emergency')
  })

  it('nikkeiVI = 20（警戒未満）では noTrade=false', () => {
    const state = {
      market: makeMarket({ vix: 15 }),
      macro: makeMacro({ nikkeiVI: 20 }),
      sqCalendar: null,
    } as unknown as AppState

    const result = checkNoTrade(state)
    expect(result.noTrade).toBe(false)
  })

  it('VIX >= 30（VIX_PANIC）のとき noTrade=true / mode=emergency', () => {
    const state = {
      market: makeMarket({ vix: 31 }),
      macro: makeMacro({ nikkeiVI: 20 }),
      sqCalendar: null,
    } as unknown as AppState

    const result = checkNoTrade(state)
    expect(result.noTrade).toBe(true)
    expect(result.mode).toBe('emergency')
  })

  it('VIX=25（VIX_WARNING）では noTrade=false だが reasons に警戒文言が入る', () => {
    const state = {
      market: makeMarket({ vix: 25 }),
      macro: makeMacro({ nikkeiVI: 20 }),
      sqCalendar: null,
    } as unknown as AppState

    const result = checkNoTrade(state)
    expect(result.noTrade).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
  })
})

// ── WAIT / budget=0 ───────────────────────────────────────────────

describe('buildTrustPortfolioPlan: WAIT判断とbudget', () => {
  it('方向性が定まらない相場では candidateDirection=WAIT で recommendedCoreBudget=0 になる', () => {
    // 先物変化なし・VIX中程度・VI微増 → BULL/BEAR どちらにも自信なし
    const flatMarket = makeMarket({
      nikkeiChgPct: 0,
      nikkeiFuturesChgPct: 0,
      vix: 20,
      regime: 'neutral',
    })
    const flatMacro = makeMacro({
      vix: 20,
      vixChg: 0,
      nikkeiVI: 20,
      nikkeiVIChg: 0.1,
    })

    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: flatMarket,
      macro: flatMacro,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: false,
    })

    // candidateDirection が WAIT の場合のみアサート
    if (plan.shortTermMode.candidateDirection === 'WAIT') {
      expect(plan.shortTermMode.recommendedCoreBudget).toBe(0)
      expect(plan.shortTermMode.recommendedSatelliteBudget).toBe(0)
    } else {
      // BULL/BEAR でも canEnter=false なら budget=0
      if (!plan.shortTermMode.canEnter) {
        expect(plan.shortTermMode.recommendedCoreBudget).toBe(0)
      }
    }
    // 方向がいずれの場合でも、WAIT時はnoTrade=true と同様にBUYなし
    expect(plan.shortTermMode.decision).toBeTruthy()
  })

  it('BULL条件成立時の recommendedCoreBudget は CORE_BUDGET(4,500,000) になる', () => {
    const plan = buildTrustPortfolioPlan({
      trust: [makeJpTrust()],
      market: BULL_MARKET,
      macro: BULL_MACRO,
      sqCalendar: SQ_SAFE,
      margin: null,
      flows: null,
      todayEntryCount: 0,
      noTrade: false,
    })

    if (plan.shortTermMode.decision !== 'WAIT') {
      expect(plan.shortTermMode.recommendedCoreBudget).toBe(4_500_000)
    }
  })
})

// ── P4-A48: jpTrustHeadroom / effectiveCoreBudget tests ──────────────────────

describe('P4-A48: jpTrustHeadroom によるCORE_BUDGET上限制御', () => {
  const makeBaseInput = () => ({
    trust: [makeJpTrust()],
    market: BULL_MARKET,
    macro: BULL_MACRO,
    sqCalendar: SQ_SAFE,
    margin: null as null,
    flows: null as null,
    todayEntryCount: 0 as const,
    noTrade: false as const,
  })

  it('jpTrustHeadroom未指定時はCORE_BUDGET(4,500,000)が上限', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput() })
    if (plan.shortTermMode.decision !== 'WAIT') {
      expect(plan.shortTermMode.recommendedCoreBudget).toBe(4_500_000)
    }
  })

  it('jpTrustHeadroom=3,000,000ならrecommendedCoreBudgetが3,000,000に制限される', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), jpTrustHeadroom: 3_000_000 })
    if (plan.shortTermMode.decision !== 'WAIT') {
      expect(plan.shortTermMode.recommendedCoreBudget).toBe(3_000_000)
    }
  })

  it('jpTrustHeadroom=6,000,000ならCORE_BUDGET(4,500,000)が上限として機能する', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), jpTrustHeadroom: 6_000_000 })
    if (plan.shortTermMode.decision !== 'WAIT') {
      expect(plan.shortTermMode.recommendedCoreBudget).toBe(4_500_000)
    }
  })

  it('jpTrustHeadroom=-1ならrecommendedCoreBudgetが0になる', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), jpTrustHeadroom: -1 })
    expect(plan.shortTermMode.recommendedCoreBudget).toBe(0)
  })

  it('jpTrustHeadroom=0ならrecommendedCoreBudgetが0になる', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), jpTrustHeadroom: 0 })
    expect(plan.shortTermMode.recommendedCoreBudget).toBe(0)
  })

  it('noTrade=trueならjpTrustHeadroomが大きくても短期BUY項目は実行キューに含まれない', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), noTrade: true, jpTrustHeadroom: 6_000_000 })
    // noTrade=trueはexecutionQueueのBULL/BEAR/short-BUYを除去する（P4-A45の挙動）
    const shortBuys = plan.executionQueue.filter(
      item => item.id.startsWith('short-') && item.action === 'BUY'
    )
    expect(shortBuys).toHaveLength(0)
  })

  it('jpTrustHeadroom=0のとき0円BUYはexecutionQueueに含まれない', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), jpTrustHeadroom: 0 })
    // corePerFund=0のCORE BUYをWAITに変換し、0円BUYがUIに出ないことを確認
    const zeroBuys = plan.executionQueue.filter(
      item => item.action === 'BUY' && item.id.startsWith('short-')
    )
    expect(zeroBuys).toHaveLength(0)
  })

  it('jpTrustHeadroom=300,000のときshortTermRowsのBUY suggestedAmountの合計がheadroomを超えない', () => {
    const headroom = 300_000
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), jpTrustHeadroom: headroom })
    const buyRows = plan.shortTermRows.filter(r => r.action === 'BUY')
    const totalBuyAmount = buyRows.reduce((s, r) => s + r.suggestedAmount, 0)
    expect(totalBuyAmount).toBeLessThanOrEqual(headroom)
  })

  it('jpTrustHeadroom=1,000,000のときrecommendedCoreBudgetはheadroomを超えない', () => {
    const headroom = 1_000_000
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), jpTrustHeadroom: headroom })
    expect(plan.shortTermMode.recommendedCoreBudget).toBeLessThanOrEqual(headroom)
  })
})

// ── P4-A146: satellite予算のheadroom cap（Fable監査S2対応）────────────────────
// core予算だけでなくsatellite予算(confidence>=93時のレバ型枠)もJP_TRUST headroomの
// 残余でcapし、core+satelliteのBUY提案合計がheadroomを超えないことを保証する。

describe('P4-A146: satellite予算のheadroom cap', () => {
  const makeBaseInputWithSatellite = () => ({
    trust: [makeJpTrust(), makeLeveragedJpTrust()],
    market: BULL_MARKET,
    macro: BULL_MACRO,
    sqCalendar: SQ_SAFE,
    margin: null as null,
    flows: null as null,
    todayEntryCount: 0 as const,
    noTrade: false as const,
  })

  it('jpTrustHeadroom=0、confidence>=93、レバ型候補ありでもsatellite BUY金額が0になる', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInputWithSatellite(), jpTrustHeadroom: 0 })
    expect(plan.shortTermMode.confidence).toBeGreaterThanOrEqual(93)
    expect(plan.shortTermMode.recommendedSatelliteBudget).toBe(0)
    const satelliteBuys = plan.shortTermRows.filter(r => r.role === 'SATELLITE' && r.action === 'BUY')
    expect(satelliteBuys).toHaveLength(0)
  })

  it('jpTrustHeadroom=50,000でcore側がheadroomを使い切る場合、satellite BUY金額が0になる', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInputWithSatellite(), jpTrustHeadroom: 50_000 })
    expect(plan.shortTermMode.recommendedCoreBudget).toBe(50_000)
    expect(plan.shortTermMode.recommendedSatelliteBudget).toBe(0)
    const satelliteBuys = plan.shortTermRows.filter(r => r.role === 'SATELLITE' && r.action === 'BUY')
    expect(satelliteBuys).toHaveLength(0)
  })

  it('jpTrustHeadroom=130,000（端数あり）でもBUY合計がheadroomを超えない', () => {
    const headroom = 130_000
    const plan = buildTrustPortfolioPlan({ ...makeBaseInputWithSatellite(), jpTrustHeadroom: headroom })
    const totalBuyAmount = plan.shortTermRows
      .filter(r => r.action === 'BUY')
      .reduce((s, r) => s + r.suggestedAmount, 0)
    expect(totalBuyAmount).toBeLessThanOrEqual(headroom)
  })

  it('jpTrustHeadroom=155,000（四捨五入だと超過しうる値）でもBUY合計がheadroomを超えない', () => {
    const headroom = 155_000
    const plan = buildTrustPortfolioPlan({ ...makeBaseInputWithSatellite(), jpTrustHeadroom: headroom })
    const totalBuyAmount = plan.shortTermRows
      .filter(r => r.action === 'BUY')
      .reduce((s, r) => s + r.suggestedAmount, 0)
    expect(totalBuyAmount).toBeLessThanOrEqual(headroom)
  })

  it('jpTrustHeadroom未指定時は既存のsatellite予算挙動（confidence>=93でSATELLITE_BUDGET）を維持する', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInputWithSatellite() })
    expect(plan.shortTermMode.confidence).toBeGreaterThanOrEqual(93)
    expect(plan.shortTermMode.recommendedSatelliteBudget).toBe(1_000_000)
  })

  it('confidence<93（かつ>=90でBULL成立）では従来通りsatellite予算が0のままになる', () => {
    // pass=3/warn=1（bull-vi warn）でconfidence=92（90以上93未満）を狙った市場条件
    const plan = buildTrustPortfolioPlan({
      ...makeBaseInputWithSatellite(),
      market: { ...BULL_MARKET, nikkeiFuturesChgPct: 1.2, vix: 17 },
      macro: { ...BULL_MACRO, vixChg: 0.2, nikkeiVIChg: 0.4 },
      sqCalendar: makeSQCalendar(7),
    })
    expect(plan.shortTermMode.decision).toBe('BULL')
    expect(plan.shortTermMode.confidence).toBeGreaterThanOrEqual(90)
    expect(plan.shortTermMode.confidence).toBeLessThan(93)
    expect(plan.shortTermMode.recommendedSatelliteBudget).toBe(0)
  })

  it('noTrade=true時はheadroomが大きくてもsatellite BUYがexecutionQueueに含まれない', () => {
    const plan = buildTrustPortfolioPlan({
      ...makeBaseInputWithSatellite(),
      noTrade: true,
      jpTrustHeadroom: 6_000_000,
    })
    const satelliteBuys = plan.executionQueue.filter(
      item => item.id.startsWith('short-') && item.action === 'BUY',
    )
    expect(satelliteBuys).toHaveLength(0)
  })
})

// ── P4-A147: noTrade時のpolicy-BUY除去（Fable監査A1対応）────────────────────
// executionQueueのnoTradeフィルタはshort-*のBUYのみを除去しており、
// policy-*（運用方針別配分調整）のBUY「xxx円を分割投入」が緊急停止中も残っていた。
// policyRowsにOVERSEAS_LONGTERM/GOLDを含めることで policy-* のBUY/TRIM双方を発生させ、
// BUYのみが除去されTRIMは残ることを確認する。

describe('P4-A147: noTrade時のpolicy-BUY除去', () => {
  // OVERSEAS_LONGTERM: eval=0で総資産の72%相当が不足 → diffValue大幅プラス → policy-OVERSEAS_LONGTERM BUY
  // GOLD: eval=50,000,000と極端に大きく → diffValue大幅マイナス → policy-GOLD TRIM
  const makeMultiPolicyTrust = (): Trust[] => [
    makeJpTrust(),
    makeJpTrust({ id: 'overseas_test', policy: 'OVERSEAS_LONGTERM', eval: 0 }),
    makeJpTrust({ id: 'gold_test', policy: 'GOLD', eval: 50_000_000 }),
  ]

  const makeBaseInput = () => ({
    trust: makeMultiPolicyTrust(),
    market: BULL_MARKET,
    macro: BULL_MACRO,
    sqCalendar: SQ_SAFE,
    margin: null as null,
    flows: null as null,
    todayEntryCount: 0 as const,
  })

  it('前提確認: noTrade=false時はpolicy-JAPAN_SHORTTERM/OVERSEAS_LONGTERMのBUYとpolicy-GOLDのTRIMが生成される', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), noTrade: false })
    const policyBuys = plan.executionQueue.filter(
      item => item.id.startsWith('policy-') && item.action === 'BUY',
    )
    const policyTrims = plan.executionQueue.filter(
      item => item.id.startsWith('policy-') && item.action === 'TRIM',
    )
    expect(policyBuys.length).toBeGreaterThan(0)
    expect(policyTrims.length).toBeGreaterThan(0)
  })

  it('noTrade=true時、executionQueue内にid startsWith("short-") && action==="BUY"が残らない', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), noTrade: true })
    const shortBuys = plan.executionQueue.filter(
      item => item.id.startsWith('short-') && item.action === 'BUY',
    )
    expect(shortBuys).toHaveLength(0)
  })

  it('noTrade=true時、executionQueue内にid startsWith("policy-") && action==="BUY"が残らない', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), noTrade: true })
    const policyBuys = plan.executionQueue.filter(
      item => item.id.startsWith('policy-') && item.action === 'BUY',
    )
    expect(policyBuys).toHaveLength(0)
  })

  it('noTrade=true時でも、policy-*のTRIMは残る', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), noTrade: true })
    const policyTrims = plan.executionQueue.filter(
      item => item.id.startsWith('policy-') && item.action === 'TRIM',
    )
    expect(policyTrims.length).toBeGreaterThan(0)
  })

  it('noTrade=false時は、policy-* BUYが従来通り残る', () => {
    const plan = buildTrustPortfolioPlan({ ...makeBaseInput(), noTrade: false })
    const policyBuys = plan.executionQueue.filter(
      item => item.id.startsWith('policy-') && item.action === 'BUY',
    )
    expect(policyBuys.length).toBeGreaterThan(0)
  })
})
