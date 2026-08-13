import { describe, expect, it } from 'vitest'
import type {
  Holding,
  HoldingAnalysis,
  Market,
  Trust,
} from '../../types'
import { buildZeroBasePlan, type ZeroBaseInput } from './zeroBase'

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '9999',
    name: 'Locked Stock',
    eval: 500_000,
    pnlPct: -10,
    mu: 0.03,
    sigma: 0.25,
    sigmaSource: 'static',
    beta: 1.0,
    sector: 'テスト',
    target: 800,
    alert: 600,
    lock: false,
    mitsu: false,
    ma: false,
    rsi: 40,
    macd: false,
    vol: false,
    mom3m: -5,
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
    code: '9999',
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

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    last_updated: new Date().toISOString(),
    nikkei: 38000,
    nikkeiChg: 0,
    nikkeiChgPct: 0,
    ma5: 38000,
    ma25: 38000,
    ma75: 38000,
    rsi14: 50,
    macd: 'golden',
    volume: 'normal',
    bollUpper: 40000,
    bollMid: 38000,
    bollLower: 36000,
    regime: 'neutral',
    boj: '',
    bojNext: '',
    // VIX below VIX_WARNING(25) to stay in 'normal' mode
    vix: 15,
    ...overrides,
  }
}

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'trust-1',
    name: 'Test Trust',
    abbr: 'TT',
    account: 'NISA成長投資枠',
    policy: 'OVERSEAS_LONGTERM',
    eval: 500_000,
    pnlPct: 5,
    dayPct: 0,
    cost: 0.20,
    mu: 0.07,
    sigma: 0.15,
    score: 70,
    signal: '',
    ev: 0.05,
    decision: 'HOLD',
    ...overrides,
  }
}

function makeInput(overrides: Partial<ZeroBaseInput> = {}): ZeroBaseInput {
  return {
    holdings: [],
    trust: [],
    analysis: [],
    market: makeMarket(),
    macro: null,
    sqCalendar: null,
    metrics: null,
    universe: null,
    cash: 500_000,
    cashReserve: 9_000_000,
    ...overrides,
  }
}

// ── P4-A49: jpStockMaxRatio cap tests ────────────────────────────────────────

describe('buildZeroBasePlan: jpStockMaxRatio によるJP_STOCK上限制御', () => {
  // Setup: total assets ≈ 10M, current JP_STOCK = 1.2M (12% of total)
  // 0.08 cap → headroom = 0 → no BUY
  // 0.15 cap → headroom = 300k → BUY allowed
  const makeCapTestInput = (jpStockMaxRatio: number) => {
    const existingStock = makeHolding({ code: 'EXIST', eval: 1_100_000, score: 30, decision: 'SELL' as const })
    const candidateStock = makeHolding({ code: '7777', eval: 100_000, score: 85, decision: 'BUY' as const })
    const candidateAnalysis = makeAnalysis({ code: '7777', totalScore: 85, ev: 0.12, decision: 'BUY' as const, confidence: 0.9 })

    return makeInput({
      holdings: [existingStock, candidateStock],
      analysis: [candidateAnalysis],
      market: makeMarket({ regime: 'neutral' }),
      cash: 1_500_000,
      cashReserve: 7_300_000,
      jpStockMaxRatio,
    })
  }

  it('jpStockMaxRatio=0.08のとき JP_STOCK現在値>cap でBUY提案が出ない', () => {
    const plan = buildZeroBasePlan(makeCapTestInput(0.08))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    // currentJpStockValue=1.2M, jpStockCap=10M*0.08=800k → headroom=0 → no BUY
    expect(buyProposals).toHaveLength(0)
  })

  it('jpStockMaxRatio=0.15のとき JP_STOCK現在値<cap でBUY提案が出る', () => {
    const plan = buildZeroBasePlan(makeCapTestInput(0.15))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    // currentJpStockValue=1.2M, jpStockCap=10M*0.15=1.5M → headroom=300k → BUY allowed
    expect(buyProposals.length).toBeGreaterThan(0)
  })

  it('jpStockMaxRatio未指定(0.10)のとき JP_STOCK現在値>cap でBUY提案が出ない', () => {
    const plan = buildZeroBasePlan(makeCapTestInput(0.10))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    // currentJpStockValue=1.2M, jpStockCap=10M*0.10=1.0M → headroom=0 → no BUY
    expect(buyProposals).toHaveLength(0)
  })
})

// ── 既存テスト ──────────────────────────────────────────────────────────────

describe('buildZeroBasePlan: WAIT_LOCK branch in buildSellProposals', () => {
  it('locked stock with SELL decision produces WAIT proposal, never SELL', () => {
    // acquiredAt = today → within 90 days → locked
    const today = new Date().toISOString().slice(0, 10)
    const holding = makeHolding({ code: '9999', acquiredAt: today })
    const analysis = makeAnalysis({ code: '9999', decision: 'SELL', totalScore: 25 })

    const input = makeInput({
      holdings: [holding],
      trust: [makeTrust()],
      analysis: [analysis],
    })

    const plan = buildZeroBasePlan(input)
    const proposals = plan.proposals.filter(p => p.code === '9999')

    // There should be at least one proposal for this stock
    expect(proposals.length).toBeGreaterThan(0)

    // None of the proposals should be action='SELL'
    const sellProposals = proposals.filter(p => p.action === 'SELL')
    expect(sellProposals).toHaveLength(0)

    // The proposal should be action='WAIT' with amount=0
    const waitProposal = proposals.find(p => p.action === 'WAIT')
    expect(waitProposal).toBeDefined()
    expect(waitProposal?.amount).toBe(0)
  })

  it('unlocked stock with SELL decision produces SELL proposal', () => {
    // acquiredAt = 91 days ago → unlocked
    const acquired = new Date()
    acquired.setDate(acquired.getDate() - 91)
    const acquiredAt = acquired.toISOString().slice(0, 10)

    const holding = makeHolding({ code: '9998', acquiredAt })
    const analysis = makeAnalysis({ code: '9998', decision: 'SELL', totalScore: 25 })

    const input = makeInput({
      holdings: [holding],
      trust: [makeTrust()],
      analysis: [analysis],
    })

    const plan = buildZeroBasePlan(input)
    const proposals = plan.proposals.filter(p => p.code === '9998')

    const sellProposal = proposals.find(p => p.action === 'SELL')
    expect(sellProposal).toBeDefined()
  })
})

// ── P4-A148: SAFE_MODE / DQ抑制時の個別株BUY提案抑制（Fable監査S3対応）───────
// buildBuyProposalsはSELL提案（buildSellProposals）とは独立した関数のため、
// safeModeActive/dqSuppressedはBUYのみを止め、SELL/WAIT提案には影響しないことを確認する。

describe('buildZeroBasePlan: P4-A148 SAFE_MODE / DQ抑制によるBUY提案停止', () => {
  // BUYが生成される前提（jpStockMaxRatioテストと同じシナリオ: headroom=300k）
  const makeBuyableInput = (overrides: Partial<ZeroBaseInput> = {}) => {
    const existingStock = makeHolding({ code: 'EXIST', eval: 1_100_000, score: 30, decision: 'SELL' as const })
    const candidateStock = makeHolding({ code: '7777', eval: 100_000, score: 85, decision: 'BUY' as const })
    const candidateAnalysis = makeAnalysis({ code: '7777', totalScore: 85, ev: 0.12, decision: 'BUY' as const, confidence: 0.9 })

    return makeInput({
      holdings: [existingStock, candidateStock],
      analysis: [candidateAnalysis],
      market: makeMarket({ regime: 'neutral' }),
      cash: 1_500_000,
      cashReserve: 7_300_000,
      jpStockMaxRatio: 0.15,
      ...overrides,
    })
  }

  it('safeModeActive=true時、BUY proposalsが0件になる', () => {
    const plan = buildZeroBasePlan(makeBuyableInput({ safeModeActive: true }))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    expect(buyProposals).toHaveLength(0)
  })

  it('dqSuppressed=true時、BUY proposalsが0件になる', () => {
    const plan = buildZeroBasePlan(makeBuyableInput({ dqSuppressed: true }))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    expect(buyProposals).toHaveLength(0)
  })

  it('safeModeActive=false / dqSuppressed=false（省略時）は既存のBUY生成挙動を維持する', () => {
    const plan = buildZeroBasePlan(makeBuyableInput())
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    expect(buyProposals.length).toBeGreaterThan(0)
  })

  it('safeModeActive=true時でも、SELL提案（buildSellProposals由来）は維持される', () => {
    const acquired = new Date()
    acquired.setDate(acquired.getDate() - 91)
    const acquiredAt = acquired.toISOString().slice(0, 10)
    const holding = makeHolding({ code: '9998', acquiredAt })
    const analysis = makeAnalysis({ code: '9998', decision: 'SELL', totalScore: 25 })

    const input = makeInput({
      holdings: [holding],
      trust: [makeTrust()],
      analysis: [analysis],
      safeModeActive: true,
    })

    const plan = buildZeroBasePlan(input)
    const sellProposal = plan.proposals.find(p => p.code === '9998' && p.action === 'SELL')
    expect(sellProposal).toBeDefined()
  })

  it('dqSuppressed=true時でも、ロック中銘柄のWAIT提案（監視系）は維持される', () => {
    const today = new Date().toISOString().slice(0, 10)
    const holding = makeHolding({ code: '9999', acquiredAt: today })
    const analysis = makeAnalysis({ code: '9999', decision: 'SELL', totalScore: 25 })

    const input = makeInput({
      holdings: [holding],
      trust: [makeTrust()],
      analysis: [analysis],
      dqSuppressed: true,
    })

    const plan = buildZeroBasePlan(input)
    const waitProposal = plan.proposals.find(p => p.code === '9999' && p.action === 'WAIT')
    expect(waitProposal).toBeDefined()
  })
})

// ── CASH-AUTH-1 R1: stale/unknown cash 権限で新規BUY金額を生成しない ─────────
// stale/unknown 時でも input.cash（legacy display値）は参考値としてそのまま渡り得るが、
// cashAuthorityUsable===false のときは buyBudget を計算前に0にする — SELL/WAITには影響しない。

describe('buildZeroBasePlan: CASH-AUTH-1 R1 cashAuthorityUsable による新規BUY金額の fail-closed 化', () => {
  const makeBuyableInput = (overrides: Partial<ZeroBaseInput> = {}) => {
    const existingStock = makeHolding({ code: 'EXIST', eval: 1_100_000, score: 30, decision: 'SELL' as const })
    const candidateStock = makeHolding({ code: '7777', eval: 100_000, score: 85, decision: 'BUY' as const })
    const candidateAnalysis = makeAnalysis({ code: '7777', totalScore: 85, ev: 0.12, decision: 'BUY' as const, confidence: 0.9 })

    return makeInput({
      holdings: [existingStock, candidateStock],
      analysis: [candidateAnalysis],
      market: makeMarket({ regime: 'neutral' }),
      cash: 1_500_000,
      cashReserve: 7_300_000,
      jpStockMaxRatio: 0.15,
      ...overrides,
    })
  }

  it('cashAuthorityUsable=false（stale/unknown 168h+1ms相当）ではBUY proposalsが0件になる', () => {
    const plan = buildZeroBasePlan(makeBuyableInput({ cashAuthorityUsable: false }))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    expect(buyProposals).toHaveLength(0)
  })

  it('cashAuthorityUsable=false でも input.cash に高額な参考値が入っていてもBUYは生成されない', () => {
    // stale な参考値として巨額の cash が渡っても、usable=false なら予算計算前に0扱いになる
    const plan = buildZeroBasePlan(makeBuyableInput({ cashAuthorityUsable: false, cash: 50_000_000 }))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    expect(buyProposals).toHaveLength(0)
  })

  it('cashAuthorityUsable=true（168hちょうど相当）は既存のBUY生成挙動を維持する', () => {
    const plan = buildZeroBasePlan(makeBuyableInput({ cashAuthorityUsable: true }))
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    expect(buyProposals.length).toBeGreaterThan(0)
  })

  it('cashAuthorityUsable省略時（現行互換）は既存のBUY生成挙動を維持する', () => {
    const plan = buildZeroBasePlan(makeBuyableInput())
    const buyProposals = plan.proposals.filter(p => p.action === 'BUY')
    expect(buyProposals.length).toBeGreaterThan(0)
  })

  it('cashAuthorityUsable=false でも、SELL提案（buildSellProposals由来）は維持される', () => {
    const acquired = new Date()
    acquired.setDate(acquired.getDate() - 91)
    const acquiredAt = acquired.toISOString().slice(0, 10)
    const holding = makeHolding({ code: '9998', acquiredAt })
    const analysis = makeAnalysis({ code: '9998', decision: 'SELL', totalScore: 25 })

    const input = makeInput({
      holdings: [holding],
      trust: [makeTrust()],
      analysis: [analysis],
      cashAuthorityUsable: false,
    })

    const plan = buildZeroBasePlan(input)
    const sellProposal = plan.proposals.find(p => p.code === '9998' && p.action === 'SELL')
    expect(sellProposal).toBeDefined()
  })

  it('cashAuthorityUsable=false でも、ロック中銘柄のWAIT提案（監視系）は維持される', () => {
    const today = new Date().toISOString().slice(0, 10)
    const holding = makeHolding({ code: '9999', acquiredAt: today })
    const analysis = makeAnalysis({ code: '9999', decision: 'SELL', totalScore: 25 })

    const input = makeInput({
      holdings: [holding],
      trust: [makeTrust()],
      analysis: [analysis],
      cashAuthorityUsable: false,
    })

    const plan = buildZeroBasePlan(input)
    const waitProposal = plan.proposals.find(p => p.code === '9999' && p.action === 'WAIT')
    expect(waitProposal).toBeDefined()
  })
})
