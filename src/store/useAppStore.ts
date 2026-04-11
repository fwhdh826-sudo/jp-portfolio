import { create } from 'zustand'
import type { AppState, Holding, Trust, TabId } from '../types'
import { INITIAL_HOLDINGS } from '../constants/holdings'
import { INITIAL_TRUST } from '../constants/trust'
import {
  STATIC_MARKET,
  INITIAL_CASH,
  INITIAL_CASH_RESERVE,
  INITIAL_ADD_ROOM,
} from '../constants/market'
import { refreshAllData as loadPublishedData } from '../services/loadStaticData'
import { computeAnalysis, calcPortfolioMetrics } from '../domain/analysis/computeAnalysis'
import { importPortfolioCsv } from '../domain/csv/importPortfolioCsv'
import {
  persistPortfolio,
  restorePortfolio,
  persistTrust,
  restoreTrust,
  persistLearning,
  restoreLearning,
} from './persist'
import { buildAssetUniverse } from '../domain/optimization/idealAllocation'
import { updatePerformanceTracker } from '../domain/learning/performanceTracker'

// ── アクション型 ─────────────────────────────────────────────
interface AppActions {
  // 起動時初期化
  initialize: () => Promise<void>
  // 全データ再取得 → 全再計算 → Store一括更新
  refreshAllData: () => Promise<void>
  // CSV取込 → 即時再分析
  importCsv: (file: File) => Promise<void>
  // タブ切替
  setTab: (tab: TabId) => void
  // holding手動更新（score等）
  updateHolding: (code: string, patch: Partial<Holding>) => void
  // trust手動更新
  updateTrust: (id: string, patch: Partial<Trust>) => void
}

// ── runFullAnalysis（内部ヘルパー）───────────────────────────
function runFullAnalysis(state: AppState): Pick<AppState, 'analysis' | 'metrics' | 'holdings' | 'trust' | 'universe' | 'learning'> {
  const adaptiveWeights =
    state.learning && state.learning.summary.total >= 20
      ? state.learning.suggestedWeights
      : null
  const analysis = computeAnalysis(
    state.holdings,
    state.market,
    state.correlation,
    state.news,
    adaptiveWeights,
  )
  const metrics = calcPortfolioMetrics(state.holdings, state.correlation)

  // holdingsにスコア・判定を書き戻す
  const holdings = state.holdings.map(h => {
    const a = analysis.find(x => x.code === h.code)
    if (!a) return h
    return { ...h, score: a.totalScore, decision: a.decision, ev: a.ev }
  })

  // trustスコア計算
  const totalTrust = state.trust.reduce((s, f) => s + f.eval, 0)
  const trust = state.trust.map(f => {
    const te = f.cost / 100
    const flowF = f.pnlPct > 20 ? 1.1 : f.pnlPct > 0 ? 1.0 : 0.9
    const sharpe = (f.mu - 0.005) / Math.max(f.sigma, 0.01)
    const sharpeF = sharpe > 1.2 ? 1.2 : sharpe > 0.8 ? 1.0 : 0.8
    const dd = Math.max(0, -f.pnlPct / 100) * 0.5
    const ev_fund = (f.mu - f.cost / 100 - te) * flowF * sharpeF - dd
    const divF = f.policy === 'GOLD' ? 1.15 : f.id.includes('fang') ? 0.85 : f.policy === 'OVERSEAS_LONGTERM' ? 1.05 : 0.90
    const corrF = f.policy === 'GOLD' ? 1.1 : f.id.includes('fang') ? 0.9 : 1.0
    const ev = +(ev_fund * divF * corrF).toFixed(4)
    const w = f.eval / Math.max(totalTrust, 1)
    let score = 40 + sharpe * 25 + ev * 200 + (f.pnlPct > 50 ? 10 : f.pnlPct > 0 ? 5 : -5) +
      (f.cost > 1.0 ? -15 : f.cost > 0.5 ? -8 : 0) + (f.policy === 'JAPAN_SHORTTERM' ? -5 : 0)
    score += w > 0.35 ? -4 : w > 0.25 ? -2 : w < 0.05 ? 2 : 0
    score = Math.max(0, Math.min(100, score))
    const decision: Trust['decision'] = f.pnlPct < -15 && f.policy === 'JAPAN_SHORTTERM' ? 'SELL' :
      score >= 75 ? 'BUY' : score >= 60 ? 'HOLD' : score >= 40 ? 'WAIT' : 'SELL'
    return { ...f, ev, score: Math.round(score), decision }
  })

  // ゼロベース理想PF構築（metrics計算後に呼ぶ）
  const stateWithComputed: AppState = { ...state, holdings, trust, metrics, analysis }
  const universe = buildAssetUniverse(stateWithComputed)
  const learning = updatePerformanceTracker(
    state.learning,
    holdings,
    analysis,
    new Date().toISOString(),
  )

  return { analysis, metrics, holdings, trust, universe, learning }
}

// ── Store ─────────────────────────────────────────────────────
export const useAppStore = create<AppState & AppActions>((set, get) => ({
  // 初期値
  holdings: INITIAL_HOLDINGS,
  trust: INITIAL_TRUST,
  market: STATIC_MARKET,
  correlation: null,
  news: null,
  metrics: null,
  analysis: [],
  activeTab: 'T1',
  // v9.0 — 全資産統合
  macro: null,
  sqCalendar: null,
  margin: null,
  flows: null,
  universe: null,
  learning: null,
  cash: INITIAL_CASH,
  cashReserve: INITIAL_CASH_RESERVE,
  addRoom: INITIAL_ADD_ROOM,
  system: {
    version: '9.1',
    status: 'idle',
    lastUpdated: null,
    csvLastImportedAt: null,
    analysisLastRunAt: null,
    error: null,
    dataSourceStatus: {
      market: 'static',
      correlation: 'static',
      news: 'none',
      trust: 'static',
      macro: 'none',
      nikkeiVI: 'none',
      sq: 'none',
      margin: 'none',
      flows: 'none',
    },
    dataTimestamps: {
      market: null,
      correlation: null,
      news: null,
      trust: null,
      macro: null,
      nikkeiVI: null,
      sq: null,
      margin: null,
      flows: null,
    },
  },

  // ── 起動時初期化 ──────────────────────────────────────────
  initialize: async () => {
    if (get().system.status === 'loading') return
    set(s => ({ system: { ...s.system, status: 'loading' } }))
    try {
      // localStorage復元（TTL付き）
      const savedPortfolio = restorePortfolio()
      const savedTrust = restoreTrust()
      const savedLearning = restoreLearning()
      if (savedPortfolio) set({ holdings: savedPortfolio })
      if (savedTrust) set({ trust: savedTrust })
      if (savedLearning) set({ learning: savedLearning })

      // データ取得（macro / nikkei VI / SQ 含む）
      const result = await loadPublishedData({ bustCache: true })
      const { market, correlation, news, trust, macro, nikkeiVI, sq, margin, flows } = result

      set(s => {
        const nextTrust = trust.data
          ? s.trust.map(f => { const d = trust.data!.find(x => x.id === f.id); return d ? { ...f, ...d } : f })
          : s.trust
        // volatilities反映
        const holdingsWithVol = correlation.data
          ? s.holdings.map(h => {
              const v = correlation.data!.volatilities[h.code + '.T']
              return v ? { ...h, sigma: +v.toFixed(3), sigmaSource: 'yfinance' as const } : h
            })
          : s.holdings
        return {
          market: market.data,
          correlation: correlation.data,
          news: news.data,
          trust: nextTrust,
          holdings: holdingsWithVol,
          macro: macro.data,
          sqCalendar: sq.data,
          margin: margin.data,
          flows: flows.data,
          system: {
            ...s.system,
            dataSourceStatus: {
              market: market.source,
              correlation: correlation.source,
              news: news.source,
              trust: trust.source,
              macro: macro.source,
              nikkeiVI: nikkeiVI.source,
              sq: sq.source,
              margin: margin.source,
              flows: flows.source,
            },
            dataTimestamps: {
              market: market.data?.last_updated ?? null,
              correlation: correlation.data?.last_updated ?? null,
              news: news.data?.updatedAt ?? null,
              trust: null,
              macro: macro.data?.last_updated ?? null,
              nikkeiVI: nikkeiVI.data?.last_updated ?? null,
              sq: sq.data?.last_updated ?? null,
              margin: margin.data?.last_updated ?? null,
              flows: flows.data?.last_updated ?? null,
            },
          },
        }
      })

      // NikkeiVI を market に合流（v9.0 では market型にまだフィールドないので macro経由で表示）
      if (nikkeiVI.data && get().macro) {
        set(s => ({ macro: s.macro ? { ...s.macro, nikkeiVI: nikkeiVI.data!.vi, nikkeiVIChg: nikkeiVI.data!.viChg } : s.macro }))
      }

      // 全再計算
      const computed = runFullAnalysis(get())
      const now = new Date().toISOString()
      set(s => ({
        ...computed,
        system: { ...s.system, status: 'success', lastUpdated: now, analysisLastRunAt: now, error: null },
      }))

      // 永続化
      persistPortfolio(get().holdings)
      persistTrust(get().trust)
      const learning = get().learning
      if (learning) persistLearning(learning)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set(s => ({ system: { ...s.system, status: 'error', error: msg } }))
    }
  },

  // ── 全データ再取得 ────────────────────────────────────────
  refreshAllData: async () => {
    if (get().system.status === 'loading') return
    set(s => ({ system: { ...s.system, status: 'loading', error: null } }))
    try {
      const result = await loadPublishedData({ bustCache: true })
      const { market, correlation, news, trust, macro, nikkeiVI, sq, margin, flows } = result

      set(s => {
        const nextTrust = trust.data
          ? s.trust.map(f => { const d = trust.data!.find(x => x.id === f.id); return d ? { ...f, ...d } : f })
          : s.trust
        const holdingsWithVol = correlation.data
          ? s.holdings.map(h => {
              const v = correlation.data!.volatilities[h.code + '.T']
              return v ? { ...h, sigma: +v.toFixed(3), sigmaSource: 'yfinance' as const } : h
            })
          : s.holdings
        return {
          market: market.data, correlation: correlation.data, news: news.data,
          trust: nextTrust, holdings: holdingsWithVol,
          macro: macro.data, sqCalendar: sq.data, margin: margin.data, flows: flows.data,
          system: {
            ...s.system,
            dataSourceStatus: {
              market: market.source, correlation: correlation.source,
              news: news.source, trust: trust.source,
              macro: macro.source, nikkeiVI: nikkeiVI.source, sq: sq.source,
              margin: margin.source, flows: flows.source,
            },
            dataTimestamps: {
              market: market.data?.last_updated ?? null,
              correlation: correlation.data?.last_updated ?? null,
              news: news.data?.updatedAt ?? null,
              trust: null,
              macro: macro.data?.last_updated ?? null,
              nikkeiVI: nikkeiVI.data?.last_updated ?? null,
              sq: sq.data?.last_updated ?? null,
              margin: margin.data?.last_updated ?? null,
              flows: flows.data?.last_updated ?? null,
            },
          },
        }
      })

      if (nikkeiVI.data && get().macro) {
        set(s => ({ macro: s.macro ? { ...s.macro, nikkeiVI: nikkeiVI.data!.vi, nikkeiVIChg: nikkeiVI.data!.viChg } : s.macro }))
      }

      const computed = runFullAnalysis(get())
      const now = new Date().toISOString()
      set(s => ({
        ...computed,
        system: { ...s.system, status: 'success', lastUpdated: now, analysisLastRunAt: now, error: null },
      }))

      persistPortfolio(get().holdings)
      persistTrust(get().trust)
      const learning = get().learning
      if (learning) persistLearning(learning)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set(s => ({ system: { ...s.system, status: 'error', error: msg } }))
    }
  },

  // ── CSV取込（個別株 + 投信 両対応）──────────────────────────
  importCsv: async (file: File) => {
    if (get().system.status === 'loading') return
    set(s => ({ system: { ...s.system, status: 'loading', error: null } }))
    try {
      const { holdings: updatedH, trust: updatedT } = await importPortfolioCsv(
        file,
        get().holdings,
        get().trust,
      )
      const now = new Date().toISOString()
      set({ holdings: updatedH, trust: updatedT })
      const computed = runFullAnalysis(get())
      set(s => ({
        ...computed,
        system: {
          ...s.system,
          status: 'success',
          csvLastImportedAt: now,
          analysisLastRunAt: now,
          error: null,
        },
      }))
      persistPortfolio(get().holdings)
      persistTrust(get().trust)
      const learning = get().learning
      if (learning) persistLearning(learning)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set(s => ({ system: { ...s.system, status: 'error', error: msg } }))
    }
  },

  setTab: (tab) => set({ activeTab: tab }),

  updateHolding: (code, patch) => {
    set(s => ({ holdings: s.holdings.map(h => h.code === code ? { ...h, ...patch } : h) }))
    const computed = runFullAnalysis(get())
    set(computed)
    persistPortfolio(get().holdings)
    const learning = get().learning
    if (learning) persistLearning(learning)
  },

  updateTrust: (id, patch) => {
    set(s => ({ trust: s.trust.map(f => f.id === id ? { ...f, ...patch } : f) }))
    const computed = runFullAnalysis(get())
    set(computed)
    persistTrust(get().trust)
    const learning = get().learning
    if (learning) persistLearning(learning)
  },
}))
