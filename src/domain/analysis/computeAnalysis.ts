import type { Holding, Market, CorrelationData, NewsData, HoldingAnalysis, PortfolioMetrics, AgentDebate, StrategyRank } from '../../types'
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
// Sharpe調整EV: 期待超過リターン - σ調整ペナルティ
// 係数0.3はリスク許容度パラメータ（yfinance実測σ対応で0.7→0.3に調整済み）
function calcEV(h: Holding, market: Market): number {
  const regimeMult = market.regime === 'bull' ? 0.9 : market.regime === 'bear' ? 1.2 : 1.0
  const rf = 0.005  // 無リスク金利 ~0.5%
  const excessReturn = h.mu - rf
  const riskPenalty  = h.sigma * 0.3 * regimeMult
  return +(excessReturn - riskPenalty).toFixed(4)
}

// ── v9.1: 7エージェントAI投資委員会 ─────────────────────────
function runAIDebate(
  h: Holding,
  fundamentalScore: number,
  technicalScore: number,
  marketScore: number,
  newsScore: number,
  qualityScore: number,
  riskPenalty: number,
  news: NewsData | null,
  market: Market,
): AgentDebate {
  const weights = INST_WEIGHTS.JAPAN_STOCK

  // ルネッサンス補正係数（モメンタム × ボラ）
  const momentumF = h.mom3m > 0 ? Math.min(1.2, 1 + h.mom3m / 100) : Math.max(0.8, 1 + h.mom3m / 100)
  const volF = h.sigma <= 0.15 ? 1.1 : h.sigma >= 0.35 ? 0.9 : 1.0
  const rnFactor = momentumF * volF

  // ── 各エージェントのスコア & 根拠生成 ────────────────────
  function makeAgent(
    agent: string,
    style: string,
    rawScore: number,
    genBull: () => string[],
    genBear: () => string[],
  ) {
    const s = Math.max(0, Math.min(100, rawScore * rnFactor))
    const score = Math.round(s)
    return {
      agent, style, score,
      bullPoints: score >= 60 ? genBull() : [],
      bearPoints: score < 50  ? genBear() : [],
    }
  }

  // 1. ファンダ代理（Goldman Sachs型）
  const fAgent = makeAgent(
    'ファンダ代理', 'GS Fundamental',
    fundamentalScore / 30 * 100,
    () => {
      const pts: string[] = []
      if (h.roe >= 15)    pts.push(`ROE ${h.roe}% — 高収益`)
      if (h.epsG >= 10)   pts.push(`EPS成長 ${h.epsG}% — 増益継続`)
      if (h.cfOk)         pts.push('CF良好 — キャッシュ創出力あり')
      if (h.per <= 15 && h.per > 0) pts.push(`PER ${h.per.toFixed(1)}倍 — バリュー水準`)
      if (h.de <= 0.5)    pts.push(`D/E ${h.de.toFixed(1)} — 無借金経営`)
      return pts.length ? pts : [`ファンダ総合 ${fundamentalScore}/30点`]
    },
    () => {
      const pts: string[] = []
      if (h.epsG < 0)     pts.push(`EPS成長 ${h.epsG}% — 減益`)
      if (h.per > 40 && h.per > 0) pts.push(`PER ${h.per.toFixed(1)}倍 — 割高`)
      if (h.de > 3)       pts.push(`D/E ${h.de.toFixed(1)} — 高レバ`)
      if (h.roe < 8)      pts.push(`ROE ${h.roe}% — 低収益`)
      return pts.length ? pts : [`ファンダ スコア不足 (${fundamentalScore}/30)`]
    },
  )

  // 2. テクニカル代理（Morgan Stanley型）
  const tAgent = makeAgent(
    'テクニカル代理', 'MS Technical',
    technicalScore / 20 * 100,
    () => {
      const pts: string[] = []
      if (h.ma && h.macd)  pts.push('MA上位 + MACD陽転 — テクニカル良好')
      else if (h.ma)       pts.push('MA上位 — トレンド順行')
      if (h.rsi >= 40 && h.rsi <= 65) pts.push(`RSI ${h.rsi.toFixed(0)} — 適正圏`)
      if (h.mom3m > 8)     pts.push(`3Mモメンタム +${h.mom3m.toFixed(1)}% — 強い上昇`)
      if (h.vol)           pts.push('出来高増加 — 需給改善')
      return pts.length ? pts : [`テクニカル ${technicalScore}/20点`]
    },
    () => {
      const pts: string[] = []
      if (!h.ma && !h.macd) pts.push('MA下位 + MACD陰転 — テクニカル悪化')
      if (h.rsi > 75)      pts.push(`RSI ${h.rsi.toFixed(0)} — 買われすぎ`)
      if (h.mom3m < -5)    pts.push(`3Mモメンタム ${h.mom3m.toFixed(1)}% — 下降トレンド`)
      return pts.length ? pts : [`テクニカル スコア不足 (${technicalScore}/20)`]
    },
  )

  // 3. ニュース代理（Fundamental News型）
  const relatedNews = news?.stockNews.filter(n => n.tickers.includes(h.code)) ?? []
  const avgSent = relatedNews.length
    ? relatedNews.reduce((s, n) => s + n.sentimentScore, 0) / relatedNews.length
    : 0
  const nAgent = makeAgent(
    'ニュース代理', 'News Analyst',
    newsScore / 15 * 100,
    () => {
      const pts: string[] = []
      if (relatedNews.length > 0 && avgSent > 0.2)
        pts.push(`関連ニュース ${relatedNews.length}件 — センチメント強気(${avgSent.toFixed(2)})`)
      else if (relatedNews.length === 0)
        pts.push('ネガティブニュースなし — 問題なし')
      return pts.length ? pts : [`ニュース スコア ${newsScore}/15点`]
    },
    () => {
      const pts: string[] = []
      if (relatedNews.length > 0 && avgSent < -0.2)
        pts.push(`関連ニュース弱気 (センチメント ${avgSent.toFixed(2)}) — 注意`)
      return pts.length ? pts : [`ニュース弱気シグナル`]
    },
  )

  // 4. センチメント代理（Market Sentiment型）
  const sectScore = Math.round(marketScore / 20 * 100 * 0.8 + fundamentalScore / 30 * 100 * 0.2)
  const sentAgent = makeAgent(
    'センチメント代理', 'Sentiment/Flow',
    sectScore,
    () => {
      const pts: string[] = []
      if (h.pnlPct > 15)   pts.push(`含み益 ${h.pnlPct.toFixed(1)}% — 市場評価高い`)
      if (market.regime === 'bull') pts.push('強気レジーム — セクター全般追い風')
      return pts.length ? pts : ['センチメント良好']
    },
    () => {
      const pts: string[] = []
      if (h.pnlPct < -15)  pts.push(`含み損 ${h.pnlPct.toFixed(1)}% — 市場評価低下`)
      if (market.regime === 'bear') pts.push('弱気レジーム — 慎重姿勢必要')
      return pts.length ? pts : ['センチメント弱め']
    },
  )

  // 5. マクロ/レジーム代理（Two Sigma型）
  const mAgent = makeAgent(
    'マクロ/レジーム代理', 'Two Sigma Macro',
    marketScore / 20 * 100,
    () => {
      const pts: string[] = []
      if (h.beta < 0.8)    pts.push(`β ${h.beta.toFixed(2)} — 低リスク・安定株`)
      if (market.vix < 20) pts.push(`VIX ${market.vix.toFixed(1)} — 低ボラ環境良好`)
      if (market.regime === 'bull' && h.beta > 1.0)
        pts.push('強気相場 + 高ベータ — 上昇に乗りやすい')
      return pts.length ? pts : [`マクロ ${marketScore}/20点`]
    },
    () => {
      const pts: string[] = []
      if (market.vix >= 25) pts.push(`VIX ${market.vix.toFixed(1)} — 市場不安定`)
      if (market.regime === 'bear') pts.push('弱気レジーム — 全体売り圧力')
      return pts.length ? pts : [`マクロ環境 弱 (${marketScore}/20)`]
    },
  )

  // 6. リスク代理（Bridgewater型）
  const rAgent = makeAgent(
    'リスク代理', 'Bridgewater Risk',
    Math.max(0, 100 - riskPenalty * 5),
    () => {
      const pts: string[] = []
      if (h.sigma <= 0.20) pts.push(`σ ${(h.sigma * 100).toFixed(1)}% — 低ボラ安定`)
      if (!h.mitsu)        pts.push('三菱集中なし — 分散貢献')
      if (h.pnlPct >= 0)   pts.push('含み益 — 損切リスク低い')
      return pts.length ? pts : [`リスク管理 良 (ペナルティ${riskPenalty}/15)`]
    },
    () => {
      const pts: string[] = []
      if (h.sigma > 0.30)  pts.push(`σ ${(h.sigma * 100).toFixed(1)}% — 高ボラ警戒`)
      if (h.mitsu)         pts.push('三菱集中リスク — 集中度要確認')
      if (h.pnlPct < -20)  pts.push(`含み損 ${h.pnlPct.toFixed(1)}% — 損切検討`)
      return pts.length ? pts : [`リスクペナルティ高 (${riskPenalty}/15)`]
    },
  )

  // 7. ポートフォリオ統合代理（Citadel/Renaissance型）
  const pfScore = Math.round((qualityScore / 10 * 100 * 0.6) + (fundamentalScore / 30 * 100 * 0.4))
  const pfAgent = makeAgent(
    'PF統合代理', 'Portfolio Integrator',
    pfScore,
    () => {
      const pts: string[] = []
      if (h.cfOk && h.de <= 1.0) pts.push('CF + 財務健全 — 長期保有適性あり')
      if (h.divG >= 3) pts.push(`配当成長 ${h.divG}% — インカム貢献`)
      return pts.length ? pts : [`PF貢献度 良 (品質${qualityScore}/10)`]
    },
    () => {
      const pts: string[] = []
      if (!h.cfOk) pts.push('CF懸念 — ビジネスモデル要確認')
      if (h.de > 5) pts.push(`高D/E ${h.de.toFixed(1)} — 財務リスク`)
      return pts.length ? pts : [`PF貢献度 低 (品質${qualityScore}/10)`]
    },
  )

  const agents = [fAgent, tAgent, nAgent, sentAgent, mAgent, rAgent, pfAgent]

  // 加重平均スコア（7エージェント）
  const w7 = [
    weights.gs_funda, weights.ms_tech,
    0.10, 0.07,  // news, sentiment
    weights.twosigma, weights.bridgewater, weights.citadel,
  ]
  const sumW7 = w7.reduce((s, v) => s + v, 0)
  const debateScore = Math.min(100, Math.max(0,
    agents.reduce((s, a, i) => s + a.score * w7[i] / sumW7, 0)
  ))

  const variance = agents.reduce((s, a) => s + (a.score - debateScore) ** 2, 0) / agents.length
  const confidence = Math.max(0.3, Math.min(1.0, 1 - Math.sqrt(variance) / 100))
  const finalView: 'BUY' | 'HOLD' | 'SELL' = debateScore >= 72 ? 'BUY' : debateScore >= 48 ? 'HOLD' : 'SELL'

  // 統合強気・弱気理由（全エージェントから上位を集約）
  const bullReasons = agents.flatMap(a => a.bullPoints).slice(0, 4)
  const bearReasons = agents.flatMap(a => a.bearPoints).slice(0, 3)

  const sevenAxis = {
    growth:    Math.round(h.epsG >= 15 ? 85 : h.epsG >= 5 ? 65 : 35),
    valuation: Math.round(h.per <= 15 ? 80 : h.per <= 25 ? 60 : 30),
    momentum:  Math.round(h.mom3m > 8 ? 80 : h.mom3m > 0 ? 60 : 35),
    macro:     Math.round(marketScore / 20 * 100),
    quality:   Math.round(qualityScore / 10 * 100),
    risk:      Math.round(100 - riskPenalty * 5),
    news:      Math.round(newsScore / 15 * 100),
  }

  return {
    agents,
    debateScore: Math.round(debateScore),
    confidence: +confidence.toFixed(2),
    finalView,
    bullReasons,
    bearReasons,
    sevenAxis,
  }
}

// ── 戦略ランク算出 ────────────────────────────────────────────
function calcStrategyRank(totalScore: number, ev: number, confidence: number): StrategyRank {
  if (totalScore >= 80 && ev > 0.05 && confidence >= 0.75) return 'S'
  if (totalScore >= 70 && ev > 0.02 && confidence >= 0.65) return 'A'
  if (totalScore >= 60 && ev > 0)                          return 'B'
  if (totalScore >= 50)                                    return 'C'
  if (totalScore >= 35)                                    return 'D'
  return 'E'
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

    const fN = fundamentalScore / 30 * 100
    const tN = technicalScore   / 20 * 100
    const mN = marketScore      / 20 * 100
    const nN = newsScore        / 15 * 100
    const qN = qualityScore     / 10 * 100
    const rN = riskPenalty      / 15 * 100

    const totalScore = Math.round(
      fN * 0.30 +
      mN * 0.20 +
      tN * 0.20 +
      nN * 0.15 +
      qN * 0.10 -
      rN * 0.15
    )

    const ev = calcEV(h, market)
    const decision: 'BUY' | 'HOLD' | 'SELL' =
      totalScore >= 75 && ev > 0 ? 'BUY' :
      totalScore >= 50 ? 'HOLD' : 'SELL'

    const debate = runAIDebate(
      h, fundamentalScore, technicalScore, marketScore,
      newsScore, qualityScore, riskPenalty, news, market,
    )

    const capped = Math.max(0, Math.min(100, totalScore))
    const strategyRank = calcStrategyRank(capped, ev, debate.confidence)

    return {
      code: h.code,
      fundamentalScore,
      marketScore,
      technicalScore,
      newsScore,
      qualityScore,
      riskPenalty,
      totalScore: capped,
      ev,
      decision,
      confidence: debate.confidence,
      strategyRank,
      debate,
    }
  })
}
