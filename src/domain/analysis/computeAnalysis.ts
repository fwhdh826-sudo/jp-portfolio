import type { Holding, Market, CorrelationData, NewsData, HoldingAnalysis, PortfolioMetrics, AgentDebate } from '../../types'
import { RF, INST_WEIGHTS, SECTOR_GROUPS } from '../../constants/market'

// ── 相関係数取得 ────────────────────────────────────────────────
function getCorr(ci: string, cj: string, corr: CorrelationData | null): number {
  if (ci === cj) return 1.0
  if (corr) {
    const ki = ci + '.T', kj = cj + '.T'
    if (corr.matrix[ki]?.[kj] !== undefined) return corr.matrix[ki][kj]
  }
  // fallback: セクターグループ相関
  const gi = Object.entries(SECTOR_GROUPS).filter(([, codes]) => codes.includes(ci)).map(([g]) => g)
  const gj = Object.entries(SECTOR_GROUPS).filter(([, codes]) => codes.includes(cj)).map(([g]) => g)
  if (gi.some(g => gj.includes(g))) return 0.68
  const related = [['三菱G','防衛重工'],['三菱G','資源'],['防衛重工','資源'],['三菱G','IT通信']]
  if (related.some(([a,b]) => (gi.includes(a) && gj.includes(b)) || (gi.includes(b) && gj.includes(a)))) return 0.35
  return 0.18
}

// ── ポートフォリオ指標 ──────────────────────────────────────────
export function calcPortfolioMetrics(holdings: Holding[], corrData: CorrelationData | null): PortfolioMetrics {
  const corr = corrData
  const totalEval = holdings.reduce((s, h) => s + h.eval, 0)
  const w = holdings.map(h => h.eval / Math.max(totalEval, 1))
  const mu = w.reduce((s, wi, i) => s + wi * holdings[i].mu, 0)

  let varP = 0
  for (let i = 0; i < holdings.length; i++) {
    for (let j = 0; j < holdings.length; j++) {
      varP += w[i] * w[j] * getCorr(holdings[i].code, holdings[j].code, corr) * holdings[i].sigma * holdings[j].sigma
    }
  }
  const sigma = Math.sqrt(Math.max(varP, 1e-8))
  const sharpe = (mu - RF) / sigma
  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval / Math.max(totalEval, 1), 0)
  const concP = Math.max(0, mitsuW - 0.35) * 0.35
  const mdd = -(sigma * 2.1 + concP)
  const calmar = mu / Math.abs(Math.min(mdd, -0.001))
  const cvar = mu - 1.645 * sigma
  const sortino = (mu - RF) / Math.max(sigma * 0.70, 0.001)

  return { mu, sigma, sharpe, sortino, mdd, calmar, cvar, totalEval }
}

// ── ファンダメンタルスコア (0-30 GS準拠) ────────────────────────
function calcFundamentalScore(h: Holding): number {
  let s = 0
  if (h.roe >= 15) s += 8; else if (h.roe >= 8) s += 5; else s -= 3
  if (h.epsG >= 15) s += 7; else if (h.epsG >= 5) s += 4; else if (h.epsG < 0) s -= 5
  if (h.cfOk) s += 6
  if (h.per > 0 && h.per <= 15) s += 5; else if (h.per > 0 && h.per <= 25) s += 2; else if (h.per > 40) s -= 4
  if (h.de <= 1.0) s += 4; else if (h.de > 3.0) s -= 3
  if (h.epsG < -15) s -= 8
  if (h.de > 6) s -= 6
  if (h.per > 60) s -= 5
  return Math.max(0, Math.min(30, s + 15))
}

// ── テクニカルスコア (0-20 MS準拠) ──────────────────────────────
function calcTechnicalScore(h: Holding): number {
  let s = 0
  if (h.ma && h.macd) s += 8; else if (h.ma || h.macd) s += 4; else s -= 4
  if (h.rsi >= 40 && h.rsi <= 65) s += 5; else if (h.rsi < 30) s += 3; else if (h.rsi > 75) s -= 4
  if (h.vol) s += 3
  if (h.mom3m > 8) s += 4; else if (h.mom3m > 0) s += 2; else if (h.mom3m < -5) s -= 4
  return Math.max(0, Math.min(20, s + 10))
}

// ── マーケットスコア (0-20 TwoSigma準拠) ────────────────────────
function calcMarketScore(h: Holding, market: Market): number {
  let s = 0
  const sectorBonus: Record<string, number> = {
    '銀行': 4, '防衛/重工': 5, 'HR/テック': 4, 'ゲーム': 3,
    '通信': 2, '非鉄金属': -1, 'テーマパーク': -4, 'EC/金融': -2,
  }
  s += (sectorBonus[h.sector] ?? 0)
  if (h.beta < 0.8) s += 3; else if (h.beta > 1.3) s -= 2
  if (h.pnlPct > 20) s += 3
  // レジームボーナス
  if (market.regime === 'bull' && h.beta > 1.0) s += 2
  if (market.regime === 'bear' && h.beta < 0.8) s += 2
  return Math.max(0, Math.min(20, s + 10))
}

// ── ニューススコア (0-15) ────────────────────────────────────────
function calcNewsScore(h: Holding, news: NewsData | null): number {
  if (!news) return 8  // データなし = 中立
  const related = news.stockNews.filter(n => n.tickers.includes(h.code))
  if (related.length === 0) return 8
  const avgSentiment = related.reduce((s, n) => s + n.sentimentScore, 0) / related.length
  const avgImportance = related.reduce((s, n) => s + n.importance, 0) / related.length
  const base = 8 + avgSentiment * 5 * avgImportance
  return Math.max(0, Math.min(15, Math.round(base)))
}

// ── 品質スコア (0-10) ────────────────────────────────────────────
function calcQualityScore(h: Holding): number {
  let s = 5
  if (h.cfOk) s += 2
  if (h.de <= 0.5) s += 2; else if (h.de > 5) s -= 2
  if (h.divG >= 4) s += 1
  return Math.max(0, Math.min(10, s))
}

// ── リスクペナルティ (0-15) ──────────────────────────────────────
function calcRiskPenalty(h: Holding, mitsuW: number, market: Market): number {
  let p = 0
  if (h.sigma > 0.35) p += 5; else if (h.sigma > 0.25) p += 2
  if (h.mitsu && mitsuW > 0.40) p += 4
  if (h.pnlPct < -25) p += 4
  if (market.vix > 30) p += 2
  if (market.regime === 'bear') p += 2
  return Math.max(0, Math.min(15, p))
}

// ── EV算出 ───────────────────────────────────────────────────────
function calcEV(h: Holding, market: Market): number {
  const regimeMult = market.regime === 'bull' ? 1.0 : market.regime === 'bear' ? 1.3 : 1.1
  const expectedUpside = h.target > 0 ? (h.target / Math.max(h.pnlPct + 100, 50) - 1) * 0.7 : h.mu
  const expectedDownside = h.sigma * 0.7 * regimeMult
  return +(expectedUpside - expectedDownside).toFixed(4)
}

// ── AI討論（5エージェント固定）────────────────────────────────
function runAIDebate(h: Holding, fundamentalScore: number, technicalScore: number, marketScore: number, newsScore: number, qualityScore: number, riskPenalty: number): AgentDebate {
  const weights = INST_WEIGHTS.JAPAN_STOCK
  const totalW = Object.values(weights).reduce((s, v) => s + v, 0)

  // ルネッサンス補正係数
  const momentumF = h.mom3m > 0 ? Math.min(1.2, 1 + h.mom3m / 100) : Math.max(0.8, 1 + h.mom3m / 100)
  const volF = h.sigma <= 0.15 ? 1.1 : h.sigma >= 0.35 ? 0.9 : 1.0
  const rnFactor = momentumF * volF

  const agentRaw = [
    { agent:'Fundamental Bull', style:'GS Fundamental', score: fundamentalScore / 30 * 100 },
    { agent:'Technical/Flow',   style:'MS Technical',   score: technicalScore / 20 * 100 },
    { agent:'Macro',            style:'Two Sigma Macro', score: marketScore / 20 * 100 },
    { agent:'Risk Manager',     style:'Bridgewater',    score: Math.max(0, 100 - riskPenalty * 4) },
    { agent:'Fundamental Bear', style:'Citadel',        score: qualityScore / 10 * 100 },
  ]

  const agents = agentRaw.map(a => {
    const s = Math.max(0, Math.min(100, a.score * rnFactor))
    return {
      agent: a.agent,
      style: a.style,
      score: Math.round(s),
      bullPoints: s >= 65 ? [`${a.style}: スコア${s.toFixed(0)}点`] : [],
      bearPoints: s < 50  ? [`${a.style}: スコア${s.toFixed(0)}点 — 改善余地あり`] : [],
    }
  })

  const debateScore = Math.min(100, Math.max(0,
    agents[0].score * weights.gs_funda / totalW +
    agents[1].score * weights.ms_tech / totalW +
    agents[2].score * weights.twosigma / totalW +
    agents[3].score * weights.bridgewater / totalW +
    agents[4].score * weights.citadel / totalW
  ))

  const variance = agents.reduce((s, a) => s + (a.score - debateScore) ** 2, 0) / agents.length
  const confidence = Math.max(0.3, Math.min(1.0, 1 - Math.sqrt(variance) / 100))

  const finalView: 'BUY' | 'HOLD' | 'SELL' = debateScore >= 75 ? 'BUY' : debateScore >= 50 ? 'HOLD' : 'SELL'

  const sevenAxis = {
    growth:    Math.round(h.epsG >= 15 ? 85 : h.epsG >= 5 ? 65 : 35),
    valuation: Math.round(h.per <= 15 ? 80 : h.per <= 25 ? 60 : 30),
    momentum:  Math.round(h.mom3m > 8 ? 80 : h.mom3m > 0 ? 60 : 35),
    macro:     Math.round(marketScore / 20 * 100),
    quality:   Math.round(qualityScore / 10 * 100),
    risk:      Math.round(100 - riskPenalty * 5),
    news:      Math.round(newsScore / 15 * 100),
  }

  return { agents, debateScore: Math.round(debateScore), confidence: +confidence.toFixed(2), finalView, sevenAxis }
}

// ── 全銘柄分析（main export）────────────────────────────────────
export function computeAnalysis(
  holdings: Holding[],
  market: Market,
  _corr: CorrelationData | null,
  news: NewsData | null,
): HoldingAnalysis[] {
  const totalEval = holdings.reduce((s, h) => s + h.eval, 0)
  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval / Math.max(totalEval, 1), 0)

  return holdings.map(h => {
    const fundamentalScore = calcFundamentalScore(h)
    const technicalScore   = calcTechnicalScore(h)
    const marketScore      = calcMarketScore(h, market)
    const newsScore        = calcNewsScore(h, news)
    const qualityScore     = calcQualityScore(h)
    const riskPenalty      = calcRiskPenalty(h, mitsuW, market)

    // handover.md のスコアリング仕様通り
    const totalScore = Math.round(
      fundamentalScore * 0.30 +
      marketScore      * 0.20 +
      technicalScore   * 0.20 +
      newsScore        * 0.15 +
      qualityScore     * 0.10 -
      riskPenalty      * 0.15
    )

    const ev = calcEV(h, market)
    const decision: 'BUY' | 'HOLD' | 'SELL' =
      totalScore >= 75 && ev > 0 ? 'BUY' :
      totalScore >= 50 ? 'HOLD' : 'SELL'

    const debate = runAIDebate(h, fundamentalScore, technicalScore, marketScore, newsScore, qualityScore, riskPenalty)

    return {
      code: h.code,
      fundamentalScore,
      marketScore,
      technicalScore,
      newsScore,
      qualityScore,
      riskPenalty,
      totalScore: Math.max(0, Math.min(100, totalScore)),
      ev,
      decision,
      confidence: debate.confidence,
      debate,
    }
  })
}
