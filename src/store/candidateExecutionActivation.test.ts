// ═══════════════════════════════════════════════════════════
// CAND-SYN-1C group M: JP_STOCK execution metadata activation.
//
// Population B (new stock, DDR-1 §3.4-§3.9) takes its execution reference
// price from candidates_stocks via an exact normalized join that always starts
// at the authorized funnel candidate. Population A (held stock, DDR-1 §7.2)
// takes it from the canonical holding projection's currentPrice. Both use the
// same Math.ceil normalization and the same frozen domestic lot of 100, and
// both fail closed to a non-executable zero rather than substituting any other
// source.
// ═══════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest'
import { INITIAL_TRUST } from '../constants/trust'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import { assertAllocationPlanInvariants } from '../domain/allocation/invariants'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import type {
  AppState,
  CandidateFunnelArtifact,
  CandidatesStocksData,
  Holding,
  Trust,
} from '../types'
import type { StockCandidateItem } from '../types/candidatesStocks'
import {
  buildAllocationPlanInput,
  useAppStore,
  type AllocationPlanInputAdapterOptions,
} from './useAppStore'

const NOW = Date.parse('2026-08-15T01:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()
const FUNNEL_GENERATION = '2026-08-14T22:14:38.374259+00:00'
const HOUR_MS = 60 * 60 * 1000

const jpTrustRegistry = (): Trust[] => INITIAL_TRUST
  .filter(trust => trust.policy === 'JAPAN_SHORTTERM')
  .map(trust => ({ ...trust }))

function holding(code: string, overrides: Partial<Holding> = {}): Holding {
  return {
    code, name: `Holding ${code}`, eval: 300_000, pnlPct: 0, mu: 0.08, sigma: 0.2,
    sigmaSource: 'static', beta: 1, sector: '銀行業', target: 0, alert: 0,
    lock: false, mitsu: false, ma: false, rsi: 50, macd: false, vol: false, mom3m: 0,
    roe: 10, per: 15, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 1,
    score: 0, decision: 'HOLD', ev: 0,
    ...overrides,
  }
}

function artifact(): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  value._meta.generatedAt = FUNNEL_GENERATION
  value._meta.asOf = FUNNEL_GENERATION
  value._meta.sourceUpdatedAt = FUNNEL_GENERATION
  return value
}

function stockRecord(code: string, price: number | null, overrides: Partial<StockCandidateItem> = {}): StockCandidateItem {
  return {
    code,
    name: `テスト銘柄${code}`,
    sector: '銀行業',
    price,
    per: 15, pbr: 1, roe: 10, dividendYield: 2, sigma252d: 0.2, mom3m: 0.01,
    screenReasons: [],
    dataStatus: 'ok',
    ...overrides,
  }
}

function candidatesStocks(
  candidates: StockCandidateItem[],
  overrides: Partial<CandidatesStocksData> = {},
): CandidatesStocksData {
  return {
    schemaVersion: 'candidates-stocks-1',
    updatedAt: new Date(NOW - HOUR_MS).toISOString(),
    sourceUpdatedAt: new Date(NOW - HOUR_MS).toISOString(),
    staleThresholdHours: 48,
    _meta: {
      kind: 'candidates_stocks',
      source: 'test',
      not_for_trading: true,
      universe: 'test',
      note: 'test fixture',
      runToken: 'run-token-1c',
    },
    candidates,
    missing: [],
    status: 'ok',
    ...overrides,
  }
}

function baseState(overrides: {
  holdings?: Holding[]
  candidatesStocks?: CandidatesStocksData
  candidatesStocksSource?: 'loaded' | 'default'
  candidateFunnel?: CandidateFunnelArtifact | null
} = {}): AppState {
  const state = useAppStore.getState()
  const funnel = overrides.candidateFunnel === undefined ? artifact() : overrides.candidateFunnel
  return {
    ...state,
    holdings: overrides.holdings ?? [],
    trust: jpTrustRegistry(),
    candidateFunnel: funnel,
    candidatesStocks: overrides.candidatesStocks ?? candidatesStocks([
      stockRecord('1002', 500),
      stockRecord('1003', 331.5),
    ]),
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: 10_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      updatedAt: NOW_ISO,
    },
    system: {
      ...state.system,
      csvLastImportedAt: NOW_ISO,
      dataSourceStatus: {
        ...state.system.dataSourceStatus,
        candidatesStocks: overrides.candidatesStocksSource ?? 'loaded',
      },
      dataTimestamps: {
        ...state.system.dataTimestamps!,
        market: NOW_ISO,
        candidateFunnel: funnel?._meta.generatedAt ?? null,
      },
    },
  }
}

function adapterOptions(
  overrides: Partial<AllocationPlanInputAdapterOptions> = {},
): AllocationPlanInputAdapterOptions {
  return {
    generatedAt: NOW_ISO,
    holdingsFreshness: 'fresh',
    sourceHoldingsSnapshotId: 'holdings-1c-fixture',
    sourceSettingsVersion: 'settings-1c-fixture',
    cash: { grossCash: 10_000_000, safetyReserve: 0, pendingOrderCash: 0, dataUncertaintyReserve: 0 },
    budgets: { shortTermBudget: 5_000_000, longTermBudget: 5_000_000 },
    safetyState: {
      safeMode: 'inactive', marketData: 'fresh', cash: 'known_fresh', target: 'known',
      pendingOrders: 'known', candidateArtifact: 'fresh', dqViolation: false,
      tierA: 'normal', crossTab: 'current', noTrade: 'normal',
    },
    ...overrides,
  }
}

function instrumentOf(state: AppState, instrumentId: string) {
  const input = buildAllocationPlanInput(state, adapterOptions())
  expect(input).not.toBeNull()
  return input!.instruments.find(item => item.instrumentId === instrumentId)
}

function planOf(state: AppState, instrumentId: string) {
  const input = buildAllocationPlanInput(state, adapterOptions())
  expect(input).not.toBeNull()
  const snapshot = buildAllocationPlanSnapshot(input!)
  expect(assertAllocationPlanInvariants(snapshot)).toEqual({ ok: true, violated: [] })
  return snapshot.instrumentPlans.find(plan => plan.instrumentId === instrumentId)
}

describe('CAND-SYN-1C group M: population B (new JP_STOCK) execution price', () => {
  it('M1 an authorized funnel candidate with a valid fresh price gets ceil(raw) and lot 100', () => {
    const state = baseState()
    // 331.5 -> 332: ceil, never round or truncate, so one lot is never underfunded.
    expect(instrumentOf(state, 'stock:1003')).toMatchObject({ priceJpy: 332, lotSizeShares: 100 })
    expect(instrumentOf(state, 'stock:1002')).toMatchObject({ priceJpy: 500, lotSizeShares: 100 })

    const plan = planOf(state, 'stock:1003')
    expect(plan?.blockedReasons).not.toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    expect(plan?.limitingFactors).not.toContain('LOT_SIZE')
    // with execution authority present the engine can now produce a positive amount
    expect(plan?.estimatedMaximumAmount).toBeGreaterThan(0)
  })

  it('M2 a missing price record leaves the candidate non-executable with no fallback', () => {
    const state = baseState({ candidatesStocks: candidatesStocks([stockRecord('9999', 1_000)]) })
    expect(instrumentOf(state, 'stock:1003')).toMatchObject({ priceJpy: null, lotSizeShares: null })
    const plan = planOf(state, 'stock:1003')
    expect(plan?.executable).toBe(false)
    expect(plan?.finalSuggestedAmount).toBe(0)
    expect(plan?.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
  })

  it('M3 a stale candidates_stocks dataset yields zero, independently of funnel freshness', () => {
    const state = baseState({
      candidatesStocks: candidatesStocks(
        [stockRecord('1003', 331.5)],
        { updatedAt: new Date(NOW - 49 * HOUR_MS).toISOString() },
      ),
    })
    expect(instrumentOf(state, 'stock:1003')).toMatchObject({ priceJpy: null, lotSizeShares: null })
    expect(planOf(state, 'stock:1003')?.finalSuggestedAmount).toBe(0)
  })

  it('M3b an unloaded dataset source is equally unusable', () => {
    const state = baseState({ candidatesStocksSource: 'default' })
    expect(instrumentOf(state, 'stock:1003')).toMatchObject({ priceJpy: null, lotSizeShares: null })
  })

  it('M4 a duplicated normalized code fails closed rather than picking one', () => {
    const state = baseState({
      candidatesStocks: candidatesStocks([
        stockRecord('1003', 331.5),
        stockRecord('1003.T', 900),
      ]),
    })
    expect(instrumentOf(state, 'stock:1003')).toMatchObject({ priceJpy: null, lotSizeShares: null })
    expect(planOf(state, 'stock:1003')?.executable).toBe(false)
  })

  it('M4b a partial dataStatus record is not price authority', () => {
    const state = baseState({
      candidatesStocks: candidatesStocks([stockRecord('1003', 331.5, { dataStatus: 'partial' })]),
    })
    expect(instrumentOf(state, 'stock:1003')).toMatchObject({ priceJpy: null, lotSizeShares: null })
  })

  it('M5 a code present only in candidates_stocks never becomes a candidate', () => {
    const state = baseState({
      candidatesStocks: candidatesStocks([stockRecord('1003', 331.5), stockRecord('7777', 1_200)]),
    })
    const input = buildAllocationPlanInput(state, adapterOptions())
    expect(input!.instruments.some(item => item.instrumentId === 'stock:7777')).toBe(false)
    expect(input!.candidates.some(item => item.instrumentId === 'stock:7777')).toBe(false)
  })

  it('the join never changes candidate eligibility, tier order, or marketRank', () => {
    const withPrices = buildAllocationPlanInput(baseState(), adapterOptions())!
    const withoutPrices = buildAllocationPlanInput(
      baseState({ candidatesStocks: candidatesStocks([]) }),
      adapterOptions(),
    )!
    expect(withPrices.candidates).toEqual(withoutPrices.candidates)
    expect(withPrices.instruments.map(item => item.instrumentId))
      .toEqual(withoutPrices.instruments.map(item => item.instrumentId))
  })
})

describe('CAND-SYN-1C group M: population A (held JP_STOCK) execution metadata', () => {
  it('M6 a valid holding currentPrice activates ceil(price) + lot 100 on the BUY_MORE plan', () => {
    const state = baseState({ holdings: [holding('1004', { currentPrice: 2_958.5 })] })
    expect(instrumentOf(state, 'stock:1004')).toMatchObject({
      relationship: 'already_held',
      priceJpy: 2_959,
      lotSizeShares: 100,
    })
    const plan = planOf(state, 'stock:1004')
    expect(plan?.buyKind).toBe('BUY_MORE')
    expect(plan?.blockedReasons).not.toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
  })

  it('M7 a missing or invalid holding price stays fail-closed with no guessed price', () => {
    for (const currentPrice of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = baseState({ holdings: [holding('1004', { currentPrice })] })
      expect(instrumentOf(state, 'stock:1004')).toMatchObject({ priceJpy: null, lotSizeShares: null })
      const plan = planOf(state, 'stock:1004')
      expect(plan?.executable).toBe(false)
      expect(plan?.finalSuggestedAmount).toBe(0)
      expect(plan?.blockedReasons).toContain('JP_STOCK_EXECUTION_DATA_UNAVAILABLE')
    }
  })

  it('held-stock price never comes from candidates_stocks', () => {
    // The held code is present in candidates_stocks with a price, yet the
    // holding has none: routing through the public artifact is forbidden
    // (DDR-1 §7.2), so the position must stay non-executable.
    const state = baseState({
      holdings: [holding('1004', { currentPrice: undefined })],
      candidatesStocks: candidatesStocks([stockRecord('1004', 5_000)]),
    })
    expect(instrumentOf(state, 'stock:1004')).toMatchObject({ priceJpy: null, lotSizeShares: null })
  })

  it('a held code cannot appear as both BUY_MORE and BUY_NEW', () => {
    const state = baseState({ holdings: [holding('1003', { currentPrice: 1_000 })] })
    const input = buildAllocationPlanInput(state, adapterOptions())!
    const entries = input.candidates.filter(item => item.instrumentId === 'stock:1003')
    expect(entries).toHaveLength(1)
    expect(entries[0].buyKind).toBe('BUY_MORE')
  })
})
