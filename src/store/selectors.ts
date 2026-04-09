import type { AppState, HoldingAnalysis, Holding, Trust } from '../types'

// ── ポートフォリオ集計 ─────────────────────────────────────────
export const selectTotalEval = (s: AppState) =>
  s.holdings.reduce((sum, h) => sum + h.eval, 0)

export const selectTotalPnl = (s: AppState) => {
  return s.holdings.reduce((sum, h) => {
    const cost = h.eval / (1 + h.pnlPct / 100)
    return sum + (h.eval - cost)
  }, 0)
}

export const selectBuyList = (s: AppState): HoldingAnalysis[] =>
  s.analysis.filter(a => a.decision === 'BUY').sort((a, b) => b.totalScore - a.totalScore)

export const selectSellList = (s: AppState): HoldingAnalysis[] =>
  s.analysis.filter(a => a.decision === 'SELL').sort((a, b) => a.totalScore - b.totalScore)

export const selectHoldList = (s: AppState): HoldingAnalysis[] =>
  s.analysis.filter(a => a.decision === 'HOLD').sort((a, b) => b.totalScore - a.totalScore)

export const selectHoldingByCode = (code: string) => (s: AppState): Holding | undefined =>
  s.holdings.find(h => h.code === code)

export const selectAnalysisByCode = (code: string) => (s: AppState): HoldingAnalysis | undefined =>
  s.analysis.find(a => a.code === code)

// ── 投資信託集計 ───────────────────────────────────────────────
export const selectTrustTotalEval = (s: AppState) =>
  s.trust.reduce((sum, f) => sum + f.eval, 0)

export const selectTrustByPolicy = (policy: Trust['policy']) => (s: AppState) =>
  s.trust.filter(f => f.policy === policy)

// ── レジーム ───────────────────────────────────────────────────
export const selectRegime = (s: AppState) => s.market.regime

// ── システム状態 ───────────────────────────────────────────────
export const selectIsLoading = (s: AppState) => s.system.status === 'loading'
export const selectStatusColor = (s: AppState) => {
  switch (s.system.status) {
    case 'loading': return '#d4a017'
    case 'success': return '#6896c8'
    case 'error':   return '#e8405a'
    default:        return '#4a6070'
  }
}
