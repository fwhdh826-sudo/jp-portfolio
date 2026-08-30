import { describe, expect, it } from 'vitest'
import type { Holding, Market } from '../../types'
import { buildNewHoldingFromCsvRow } from '../csv/importPortfolioCsv'
import { updatePerformanceTracker } from '../learning/performanceTracker'
import { buildCommitteeDecision } from './committeeDecision'
import { computeAnalysis } from './computeAnalysis'
import { deriveDisplayDecision } from './displayDecision'
import { buildStockPortfolioPlan } from '../optimization/stockPortfolio'
import { buildTrustPortfolioPlan } from '../optimization/trustPortfolio'
import { buildZeroBasePlan } from '../optimization/zeroBase'
import { committeeToOfficialDecision, applyHoldingsFullSyncFromSnapshot } from '../../store/useAppStore'
import {
  parsePortfolioSnapshotImport,
  serializePortfolioSnapshotExport,
} from '../../utils/portfolioSnapshotTransfer'

const NOW_MS = Date.parse('2026-08-31T00:00:00.000Z')

function makeMarket(regime: Market['regime'] = 'neutral'): Market {
  return {
    last_updated: '2026-08-31T00:00:00.000Z',
    nikkei: 38_000,
    nikkeiChg: 0,
    nikkeiChgPct: 0,
    ma5: 38_000,
    ma25: 38_000,
    ma75: 38_000,
    rsi14: 50,
    macd: 'golden',
    volume: 'normal',
    bollUpper: 40_000,
    bollMid: 38_000,
    bollLower: 36_000,
    regime,
    boj: '',
    bojNext: '',
    vix: 15,
  }
}

function makeSafeDefault(overrides: Partial<Holding> = {}): Holding {
  return {
    ...buildNewHoldingFromCsvRow({
      assetType: 'stock',
      code: '6701',
      name: '日本電気',
      eval: 220_000,
      pnlPct: 0,
      dayPct: 0,
      price: 2_200,
      acquiredAt: undefined,
      accountHint: '',
    }),
    ...overrides,
  }
}

function analyze(holding: Holding, market = makeMarket()) {
  return computeAnalysis([holding], market, null, null, null, NOW_MS)[0]
}

describe('STOCK-DECISION-METADATA-CORRECTNESS-A2', () => {
  it('first CSV full-sync holding explicitly carries unknown provenance and abstains', () => {
    const holding = makeSafeDefault()
    expect(holding.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
    expect(analyze(holding).decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it.each(['neutral', 'bull', 'bear'] as const)(
    'safe-default remains neutral for unknown score groups in %s regime across P/L',
    regime => {
      for (const pnlPct of [40, 0, -40]) {
        const result = analyze(makeSafeDefault({ pnlPct }), makeMarket(regime))
        expect(result.fundamentalScore).toBe(15)
        expect(result.technicalScore).toBe(10)
        expect(result.qualityScore).toBe(5)
        expect(result.decision).toBe('INSUFFICIENT_EVIDENCE')
        expect(result.debate.finalView).toBe('INSUFFICIENT_EVIDENCE')
        expect(result.debate.recommendedAction).toContain('分析データ不足')
        expect(result.debate.sellReasons).toEqual([])
      }
    },
  )

  it('unknown ROE is neutral and differs from authoritative known-low ROE', () => {
    const unknown = analyze(makeSafeDefault({ metadataStatus: { fundamentals: 'unknown', technicals: 'known' } }))
    const knownLow = analyze(makeSafeDefault({ metadataStatus: { fundamentals: 'known', technicals: 'known' } }))
    expect(unknown.fundamentalScore).toBe(15)
    expect(knownLow.fundamentalScore).toBe(12)
    expect(unknown.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(knownLow.decision).not.toBe('INSUFFICIENT_EVIDENCE')
  })

  it('known-false MA/MACD remains bearish evidence and differs from unknown', () => {
    const unknown = analyze(makeSafeDefault({ metadataStatus: { fundamentals: 'known', technicals: 'unknown' } }))
    const knownFalse = analyze(makeSafeDefault({ metadataStatus: { fundamentals: 'known', technicals: 'known' } }))
    expect(unknown.technicalScore).toBe(10)
    expect(knownFalse.technicalScore).toBe(11)
    expect(unknown.debate.agents.find(a => a.agent === 'テクニカル代理')?.waitReasons).toEqual([])
    expect(knownFalse.debate.agents.find(a => a.agent === 'テクニカル代理')?.waitReasons)
      .toContain('MACD陽転待ち — トレンド確認後にエントリー')
  })

  it('legacy undefined metadataStatus fails closed without inferring provenance from values', () => {
    const legacy = makeSafeDefault({
      metadataStatus: undefined,
      roe: 25,
      cfOk: true,
      ma: true,
      macd: true,
      mom3m: 20,
    })
    const result = analyze(legacy)
    expect(result.fundamentalScore).toBe(15)
    expect(result.technicalScore).toBe(10)
    expect(result.decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('snapshot export, parse, and full-sync restore preserve explicit unknown provenance', () => {
    const holding = makeSafeDefault()
    const raw = serializePortfolioSnapshotExport({
      holdings: [holding],
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
      csvImportedAt: null,
      csvImportProvenance: null,
    })
    const parsed = parsePortfolioSnapshotImport(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.holdings[0].metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
    const restored = applyHoldingsFullSyncFromSnapshot([], parsed.data.holdings)
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.holdings[0].metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
    expect(analyze(restored.holdings[0]).decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('zeroBase -> committee -> official produces no stock SELL or reduction amount for abstention', () => {
    const holding = makeSafeDefault({ eval: 900_000, pnlPct: -40 })
    const analysis = [analyze(holding, makeMarket('bear'))]
    const zeroPlan = buildZeroBasePlan({
      holdings: [holding],
      trust: [],
      analysis,
      market: makeMarket('bear'),
      macro: null,
      sqCalendar: null,
      metrics: null,
      universe: null,
      cash: 0,
      cashReserve: 0,
      nowMs: NOW_MS,
    })
    const stockPlan = buildStockPortfolioPlan([holding], analysis, {
      targetTotalValue: 100_000,
      nowMs: NOW_MS,
    })
    const trustPlan = buildTrustPortfolioPlan({
      trust: [],
      market: makeMarket('bear'),
      macro: null,
      sqCalendar: null,
      margin: null,
      flows: null,
      noTrade: true,
      nowMs: NOW_MS,
    })
    const committee = buildCommitteeDecision({
      zeroPlan,
      stockPlan,
      trustPlan,
      metrics: null,
      market: makeMarket('bear'),
      holdings: [holding],
      nowMs: NOW_MS,
    })
    const official = committeeToOfficialDecision(committee, false, false, [holding])

    expect(zeroPlan.proposals.filter(p => p.code === holding.code)).toEqual([])
    expect(zeroPlan.board.todo.some(item => item.includes(holding.name) && item.includes('SELL'))).toBe(false)
    expect(stockPlan.rows[0]).toMatchObject({
      recommendation: 'INSUFFICIENT_EVIDENCE',
      targetValue: holding.eval,
      diffValue: 0,
    })
    expect(stockPlan.rebalanceTop).toEqual([])
    expect(committee.actions.some(a => a.domain === 'stock' && a.title.startsWith('SELL '))).toBe(false)
    expect(committee.focusPoints.some(item => item.includes(holding.name))).toBe(false)
    expect(official.actions.some(a => a.assetType === 'stock' && a.action === 'SELL')).toBe(false)
  })

  it('display abstention outranks an inconsistent official SELL and never becomes a sell/TODO state', () => {
    expect(deriveDisplayDecision({
      hDecision: 'INSUFFICIENT_EVIDENCE',
      officialAction: {
        id: 'stale-sell',
        assetType: 'stock',
        code: '6701',
        name: '日本電気',
        action: 'SELL',
        reason: 'stale',
        source: 'committee',
      },
      dqSuppressed: false,
      locked: false,
    })).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('known good and known bad fixtures retain exact score/decision regressions', () => {
    const known = { fundamentals: 'known', technicals: 'known' } as const
    const good = analyze(makeSafeDefault({
      metadataStatus: known,
      pnlPct: 25,
      mu: 0.20,
      sigma: 0.15,
      roe: 20,
      per: 10,
      pbr: 1,
      epsG: 20,
      cfOk: true,
      de: 0.5,
      divG: 5,
      ma: true,
      rsi: 50,
      macd: true,
      vol: true,
      mom3m: 10,
    }))
    const bad = analyze(makeSafeDefault({
      metadataStatus: known,
      pnlPct: -40,
      mu: -0.05,
      sigma: 0.40,
      roe: 0,
      per: 70,
      pbr: 6,
      epsG: -20,
      cfOk: false,
      de: 7,
      divG: -10,
      ma: false,
      rsi: 80,
      macd: false,
      vol: false,
      mom3m: -10,
    }))
    expect(good).toMatchObject({ totalScore: 81, decision: 'BUY' })
    expect(bad).toMatchObject({ totalScore: 12, decision: 'SELL' })
  })

  it('mu=RF continues to suppress BUY for otherwise known-good data', () => {
    const result = analyze(makeSafeDefault({
      metadataStatus: { fundamentals: 'known', technicals: 'known' },
      mu: 0.005,
      sigma: 0.25,
      roe: 20,
      per: 10,
      epsG: 20,
      cfOk: true,
      de: 0.5,
      divG: 5,
      ma: true,
      macd: true,
      vol: true,
      mom3m: 10,
    }))
    expect(result.ev).toBeLessThan(0)
    expect(result.decision).toBe('HOLD')
  })

  it('abstention creates no SELL learning record and preserves existing history', () => {
    const knownBadHolding = makeSafeDefault({
      metadataStatus: { fundamentals: 'known', technicals: 'known' },
      pnlPct: 0,
      roe: 0,
      per: 70,
      epsG: -20,
      de: 7,
      rsi: 80,
      mom3m: -10,
      sigma: 0.4,
    })
    const at0 = '2026-08-30T00:00:00.000Z'
    const baseline = updatePerformanceTracker(null, [knownBadHolding], [analyze(knownBadHolding)], at0, 'neutral')
    const afterOutcomeHolding = { ...knownBadHolding, pnlPct: -10 }
    const withHistory = updatePerformanceTracker(
      baseline,
      [afterOutcomeHolding],
      [analyze(afterOutcomeHolding)],
      '2026-08-30T05:00:00.000Z',
      'neutral',
    )
    expect(withHistory.outcomes).toHaveLength(1)
    expect(withHistory.outcomes[0].decision).toBe('SELL')

    const unknown = makeSafeDefault({ pnlPct: -20 })
    const next = updatePerformanceTracker(
      withHistory,
      [unknown],
      [analyze(unknown)],
      '2026-08-30T06:00:00.000Z',
      'neutral',
    )
    expect(next.outcomes).toEqual(withHistory.outcomes)
    expect(next.baseline).toEqual([])
    expect(next.baselineCount).toBe(0)
    expect(next.summary.byDecision.SELL.count).toBe(1)
  })
})
