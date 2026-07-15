import type {
  Holding,
  Market,
  CorrelationData,
  NewsData,
  HoldingAnalysis,
  PortfolioMetrics,
  AgentDebate,
  StrategyRank,
  AdaptiveWeights,
} from '../../types'
import { RF, INST_WEIGHTS, SECTOR_GROUPS } from '../../constants/market'
import { VIX_WARNING, VIX_PANIC, VIX_HIGH_CAUTION } from '../risk/thresholds'
import { isSellLocked, getSellableDate } from '../constraints/stockLock'

// ── ユーティリティ ─────────────────────────────────────────────
function uniqueTop(items: string[], limit: number): string[] {
  return Array.from(new Set(items.filter(Boolean))).slice(0, limit)
}

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
  if (market.vix > VIX_PANIC) p += 2
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

// ── Phase 4: 8エージェントAI投資委員会 ────────────────────────
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
  now: Date,
): AgentDebate {
  const weights = INST_WEIGHTS.JAPAN_STOCK

  // ルネッサンス補正係数（モメンタム × ボラ）
  const momentumF = h.mom3m > 0 ? Math.min(1.2, 1 + h.mom3m / 100) : Math.max(0.8, 1 + h.mom3m / 100)
  const volF = h.sigma <= 0.15 ? 1.1 : h.sigma >= 0.35 ? 0.9 : 1.0
  const rnFactor = momentumF * volF

  // ── 各エージェントのスコア & 根拠生成（Phase 4: 行動理由・前提付き）────
  function makeAgent(
    agent: string,
    style: string,
    rawScore: number,
    genBull: () => string[],
    genBear: () => string[],
    opts: {
      genBuy?: () => string[]
      genWait?: () => string[]
      genSell?: () => string[]
      genPremise?: () => string[]
      genPremiseBreak?: () => string[]
    } = {},
  ) {
    const s = Math.max(0, Math.min(100, rawScore * rnFactor))
    const score = Math.round(s)
    return {
      agent, style, score,
      bullPoints:   score >= 60 ? genBull() : [],
      bearPoints:   score <  50 ? genBear() : [],
      buyReasons:   score >= 65 ? (opts.genBuy?.()        ?? []) : [],
      waitReasons:  (score >= 45 && score < 65) ? (opts.genWait?.() ?? []) : [],
      sellReasons:  score <  45 ? (opts.genSell?.()       ?? []) : [],
      premise:      opts.genPremise?.()      ?? [],
      premiseBreak: opts.genPremiseBreak?.() ?? [],
    }
  }

  // 1. ファンダ代理（Goldman Sachs型）
  const fAgent = makeAgent(
    'ファンダ代理', 'GS Fundamental',
    fundamentalScore / 30 * 100,
    () => {
      const pts: string[] = []
      if (h.roe >= 15)               pts.push(`ROE ${h.roe}% — 高収益`)
      if (h.epsG >= 10)              pts.push(`EPS成長 ${h.epsG}% — 増益継続`)
      if (h.cfOk)                    pts.push('CF良好 — キャッシュ創出力あり')
      if (h.per <= 15 && h.per > 0)  pts.push(`PER ${h.per.toFixed(1)}倍 — バリュー水準`)
      if (h.de <= 0.5)               pts.push(`D/E ${h.de.toFixed(1)} — 無借金経営`)
      return pts.length ? pts : [`ファンダ総合 ${fundamentalScore}/30点`]
    },
    () => {
      const pts: string[] = []
      if (h.epsG < 0)               pts.push(`EPS成長 ${h.epsG}% — 減益`)
      if (h.per > 40 && h.per > 0)  pts.push(`PER ${h.per.toFixed(1)}倍 — 割高`)
      if (h.de > 3)                  pts.push(`D/E ${h.de.toFixed(1)} — 高レバ`)
      if (h.roe < 8)                 pts.push(`ROE ${h.roe}% — 低収益`)
      return pts.length ? pts : [`ファンダ スコア不足 (${fundamentalScore}/30)`]
    },
    {
      genBuy:  () => [
        h.roe >= 15 ? `ROE ${h.roe}% & EPS+${h.epsG}% 確認 — バリュー買い条件充足` : '',
        h.cfOk && h.de <= 1.0 ? '財務健全・CF良好 — 今期業績支持' : '',
      ].filter(Boolean),
      genWait: () => [
        h.per > 25 ? `PER ${h.per.toFixed(1)}倍 — 割高修正を待ちたい` : '',
        h.epsG < 5 ? `EPS成長 ${h.epsG}% — 次決算の増益確認後に判断` : '',
      ].filter(Boolean),
      genSell: () => [
        h.epsG < 0  ? `EPS減益転落 (${h.epsG}%) — 前提崩れ・売り検討` : '',
        h.roe < 5   ? `ROE ${h.roe}% — 収益力低下で保有意義なし` : '',
      ].filter(Boolean),
      genPremise:      () => [`EPS成長継続（現 ${h.epsG}%）`, `ROE ${h.roe}% 維持`, h.cfOk ? 'CF良好継続' : ''],
      genPremiseBreak: () => [`EPS成長がマイナス転落`, `ROE 8% 割れ`, `D/E ${h.de.toFixed(1)} → 3超え`],
    },
  )

  // 2. テクニカル代理（Morgan Stanley型）
  const tAgent = makeAgent(
    'テクニカル代理', 'MS Technical',
    technicalScore / 20 * 100,
    () => {
      const pts: string[] = []
      if (h.ma && h.macd)               pts.push('MA上位 + MACD陽転 — テクニカル良好')
      else if (h.ma)                     pts.push('MA上位 — トレンド順行')
      if (h.rsi >= 40 && h.rsi <= 65)   pts.push(`RSI ${h.rsi.toFixed(0)} — 適正圏`)
      if (h.mom3m > 8)                   pts.push(`3Mモメンタム +${h.mom3m.toFixed(1)}% — 強い上昇`)
      if (h.vol)                         pts.push('出来高増加 — 需給改善')
      return pts.length ? pts : [`テクニカル ${technicalScore}/20点`]
    },
    () => {
      const pts: string[] = []
      if (!h.ma && !h.macd)  pts.push('MA下位 + MACD陰転 — テクニカル悪化')
      if (h.rsi > 75)        pts.push(`RSI ${h.rsi.toFixed(0)} — 買われすぎ`)
      if (h.mom3m < -5)      pts.push(`3Mモメンタム ${h.mom3m.toFixed(1)}% — 下降トレンド`)
      return pts.length ? pts : [`テクニカル スコア不足 (${technicalScore}/20)`]
    },
    {
      genBuy:  () => [
        h.ma && h.macd ? 'MA上位 + MACD陽転 — エントリーシグナル点灯' : '',
        h.rsi >= 40 && h.rsi <= 60 ? `RSI ${h.rsi.toFixed(0)} — 買い過熱なし` : '',
        h.vol ? '出来高急増 — 機関投資家参入の可能性' : '',
      ].filter(Boolean),
      genWait: () => [
        !h.macd ? 'MACD陽転待ち — トレンド確認後にエントリー' : '',
        h.rsi > 65 ? `RSI ${h.rsi.toFixed(0)} — 少し冷めてから参入` : '',
      ].filter(Boolean),
      genSell: () => [
        !h.ma && !h.macd ? 'MA + MACD 両方陰転 — トレンド崩壊' : '',
        h.rsi > 78 ? `RSI ${h.rsi.toFixed(0)} 過熱 — 利確推奨` : '',
        h.mom3m < -8 ? `3M下落 ${h.mom3m.toFixed(1)}% — 下降ピッチ加速` : '',
      ].filter(Boolean),
      genPremise:      () => [`MA上位維持`, `MACD ${h.macd ? '陽転中' : '— 転換待ち'}`, `RSI ${h.rsi.toFixed(0)} 適正圏`],
      genPremiseBreak: () => [`MACD デッドクロス確定`, `株価がMA25 を下抜け`, `RSI 80 超え → 急落リスク`],
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
      return pts.length ? pts : ['ニュース弱気シグナル']
    },
    {
      genBuy:  () => relatedNews.length === 0 ? ['ネガティブ材料なし — 買いを妨げる情報なし'] :
                     avgSent > 0.3 ? [`ポジティブ報道 ${relatedNews.length}件 — 買い支持`] : [],
      genWait: () => avgSent < 0 && avgSent > -0.3 ? ['ニュースセンチメント混在 — 材料整理後に判断'] : [],
      genSell: () => avgSent < -0.3 ? [`弱気報道 (平均センチメント ${avgSent.toFixed(2)}) — 売り材料あり`] : [],
      genPremise:      () => ['重大ネガティブ材料なし', relatedNews.length > 0 ? `関連報道 ${relatedNews.length}件 中立以上` : '材料なし中立'],
      genPremiseBreak: () => ['決算ミス・不正発覚などの重大ネガティブ報道', '格付け引き下げ報道'],
    },
  )

  // 4. センチメント代理（Market Sentiment型）
  const sectScore = Math.round(marketScore / 20 * 100 * 0.8 + fundamentalScore / 30 * 100 * 0.2)
  const sentAgent = makeAgent(
    'センチメント代理', 'Sentiment/Flow',
    sectScore,
    () => {
      const pts: string[] = []
      if (h.pnlPct > 15)            pts.push(`含み益 ${h.pnlPct.toFixed(1)}% — 市場評価高い`)
      if (market.regime === 'bull')  pts.push('強気レジーム — セクター全般追い風')
      return pts.length ? pts : ['センチメント良好']
    },
    () => {
      const pts: string[] = []
      if (h.pnlPct < -15)           pts.push(`含み損 ${h.pnlPct.toFixed(1)}% — 市場評価低下`)
      if (market.regime === 'bear')  pts.push('弱気レジーム — 慎重姿勢必要')
      return pts.length ? pts : ['センチメント弱め']
    },
    {
      genBuy:  () => [
        market.regime === 'bull' ? '強気相場 — セクター全体に資金流入' : '',
        h.pnlPct > 10 ? `市場が ${h.name} を高評価 — 追随買いしやすい` : '',
      ].filter(Boolean),
      genWait: () => [market.regime === 'neutral' ? 'レジーム中立 — 方向性確認待ち' : ''].filter(Boolean),
      genSell: () => [
        market.regime === 'bear' ? '弱気レジーム — センチメント悪化が加速しやすい' : '',
        h.pnlPct < -15 ? `含み損 ${h.pnlPct.toFixed(1)}% — 市場からの評価下落` : '',
      ].filter(Boolean),
      genPremise:      () => [`市場レジーム: ${market.regime}`, `含み損益 ${h.pnlPct.toFixed(1)}%`],
      genPremiseBreak: () => ['市場レジームが強気→弱気に転換', '急激な外国人売り越し継続'],
    },
  )

  // 5. マクロ/レジーム代理（Two Sigma型）
  const mAgent = makeAgent(
    'マクロ/レジーム代理', 'Two Sigma Macro',
    marketScore / 20 * 100,
    () => {
      const pts: string[] = []
      if (h.beta < 0.8)             pts.push(`β ${h.beta.toFixed(2)} — 低リスク・安定株`)
      if (market.vix < 20)          pts.push(`VIX ${market.vix.toFixed(1)} — 低ボラ環境良好`)
      if (market.regime === 'bull' && h.beta > 1.0)
        pts.push('強気相場 + 高ベータ — 上昇に乗りやすい')
      return pts.length ? pts : [`マクロ ${marketScore}/20点`]
    },
    () => {
      const pts: string[] = []
      if (market.vix >= VIX_WARNING)  pts.push(`VIX ${market.vix.toFixed(1)} — 市場不安定`)
      if (market.regime === 'bear')  pts.push('弱気レジーム — 全体売り圧力')
      return pts.length ? pts : [`マクロ環境 弱 (${marketScore}/20)`]
    },
    {
      genBuy:  () => [
        market.vix < 18 ? `VIX ${market.vix.toFixed(1)} — 低ボラ安定 — エントリー適期` : '',
        market.regime === 'bull' ? '強気レジーム — マクロ追い風' : '',
      ].filter(Boolean),
      genWait: () => [
        market.vix >= 20 && market.vix < VIX_HIGH_CAUTION ? `VIX ${market.vix.toFixed(1)} — やや警戒水準` : '',
        market.regime === 'neutral' ? 'レジーム中立 — 方向性待ち' : '',
      ].filter(Boolean),
      genSell: () => [
        market.vix >= 28 ? `VIX ${market.vix.toFixed(1)} — 高ボラ危険水準` : '',
        market.regime === 'bear' ? '弱気レジーム — 守りを優先' : '',
      ].filter(Boolean),
      genPremise:      () => [`VIX ${market.vix.toFixed(1)} 現状維持`, `レジーム: ${market.regime}`],
      genPremiseBreak: () => [`VIX 30 超え（現在 ${market.vix.toFixed(1)}）`, '中央銀行の急激な政策転換', '地政学リスクの急激な悪化'],
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
    {
      genBuy:  () => [
        h.sigma <= 0.20 ? `低ボラ σ${(h.sigma*100).toFixed(1)}% — ポジションサイズ拡大可` : '',
        riskPenalty <= 3 ? 'リスクペナルティ低 — フルエントリー検討可' : '',
      ].filter(Boolean),
      genWait: () => [
        h.sigma > 0.25 && h.sigma <= 0.35 ? `σ ${(h.sigma*100).toFixed(1)}% やや高め — サイズを抑えて打診買い` : '',
        h.mitsu ? '三菱集中リスクあり — 追加購入は慎重に' : '',
      ].filter(Boolean),
      genSell: () => [
        h.sigma > 0.35 ? `σ ${(h.sigma*100).toFixed(1)}% 高ボラ — ポジション圧縮推奨` : '',
        h.pnlPct < -20 ? `含み損 ${h.pnlPct.toFixed(1)}% — 損切ライン超過` : '',
      ].filter(Boolean),
      genPremise:      () => [`σ ${(h.sigma*100).toFixed(1)}% 許容範囲`, `リスクペナルティ ${riskPenalty}/15`],
      genPremiseBreak: () => [`σ 35% 超え`, `三菱集中度 50% 超`, `含み損 −25% 超え`],
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
      if (h.divG >= 3)           pts.push(`配当成長 ${h.divG}% — インカム貢献`)
      return pts.length ? pts : [`PF貢献度 良 (品質${qualityScore}/10)`]
    },
    () => {
      const pts: string[] = []
      if (!h.cfOk) pts.push('CF懸念 — ビジネスモデル要確認')
      if (h.de > 5) pts.push(`高D/E ${h.de.toFixed(1)} — 財務リスク`)
      return pts.length ? pts : [`PF貢献度 低 (品質${qualityScore}/10)`]
    },
    {
      genBuy:  () => [
        h.cfOk && h.de <= 1.0 ? 'CF良好 + 財務健全 — PF全体の安定柱として追加価値あり' : '',
        h.divG >= 3 ? `配当成長 ${h.divG}% — インカム源として長期保有適性` : '',
      ].filter(Boolean),
      genWait: () => [!h.cfOk ? 'CF状況を確認してから追加判断' : ''].filter(Boolean),
      genSell: () => [
        !h.cfOk && h.de > 3 ? 'CF懸念 + 高レバ — PF全体のリスク源' : '',
      ].filter(Boolean),
      genPremise:      () => [h.cfOk ? 'CF良好継続' : 'CF改善期待', `D/E ${h.de.toFixed(1)} 管理可能水準`],
      genPremiseBreak: () => ['CF がマイナス転落', `D/E ${h.de.toFixed(1)} → 5 超え`, '配当カット・無配転落'],
    },
  )

  // 8. マーケット代理（Market Dynamics型）— Phase 4 新設
  const mktRawScore = (() => {
    let s = 50
    if (market.regime === 'bull')    s += 20
    else if (market.regime === 'bear') s -= 20
    if (market.nikkeiChgPct > 0.5)  s += 10
    else if (market.nikkeiChgPct < -0.5) s -= 10
    if (market.vix < 18)            s += 8
    else if (market.vix > 25)       s -= 12
    if (market.ma25 > 0 && market.nikkei >= market.ma25) s += 7
    else if (market.ma25 > 0)       s -= 5
    return Math.max(0, Math.min(100, s))
  })()
  const mktAgent = makeAgent(
    'マーケット代理', 'Market Dynamics',
    mktRawScore,
    () => {
      const pts: string[] = []
      if (market.regime === 'bull')            pts.push('強気相場 — 市場全体が上昇トレンド')
      if (market.nikkeiChgPct > 0.5)           pts.push(`日経 +${market.nikkeiChgPct.toFixed(2)}% — 当日地合い良好`)
      if (market.vix < 18)                     pts.push(`VIX ${market.vix.toFixed(1)} — 市場の恐怖薄く安心感`)
      if (market.ma25 > 0 && market.nikkei >= market.ma25) pts.push('日経225 が MA25 上位 — 需給良好')
      return pts.length ? pts : [`市場環境スコア ${mktRawScore}/100`]
    },
    () => {
      const pts: string[] = []
      if (market.regime === 'bear')            pts.push('弱気相場 — 市場全体に売り圧力')
      if (market.nikkeiChgPct < -0.5)          pts.push(`日経 ${market.nikkeiChgPct.toFixed(2)}% — 当日地合い悪化`)
      if (market.vix > 25)                     pts.push(`VIX ${market.vix.toFixed(1)} — 市場の恐怖が高まる`)
      return pts.length ? pts : ['市場環境弱め']
    },
    {
      genBuy:  () => [
        market.regime === 'bull' && market.vix < 20 ? '強気レジーム + 低VIX — 市場参入の好機' : '',
        market.nikkeiChgPct > 1.0 ? `日経急騰 +${market.nikkeiChgPct.toFixed(2)}% — 勢いに乗る` : '',
      ].filter(Boolean),
      genWait: () => [
        market.regime === 'neutral' ? '中立レジーム — 明確な方向感が出るまで様子見' : '',
        market.vix >= 20 && market.vix < VIX_HIGH_CAUTION ? `VIX ${market.vix.toFixed(1)} — 少し待って安定を確認` : '',
      ].filter(Boolean),
      genSell: () => [
        market.regime === 'bear' ? '弱気レジーム — 個別株より市場全体の下落リスクを優先' : '',
        market.vix > 28 ? `VIX ${market.vix.toFixed(1)} 危険水域 — 市場全体のリスクオフ` : '',
      ].filter(Boolean),
      genPremise:      () => [`市場レジーム: ${market.regime}`, `日経: ${market.nikkeiChgPct >= 0 ? '+' : ''}${market.nikkeiChgPct.toFixed(2)}%`, `VIX ${market.vix.toFixed(1)}`],
      genPremiseBreak: () => ['日経225 がMA200 を下抜け', 'VIX 30 超え が3営業日以上継続', '大規模なパニック売り発生'],
    },
  )

  const agents = [fAgent, tAgent, nAgent, sentAgent, mAgent, rAgent, pfAgent, mktAgent]

  // 加重平均スコア（8エージェント）
  const w8 = [
    weights.gs_funda, weights.ms_tech,
    0.10, 0.06,  // news, sentiment
    weights.twosigma, weights.bridgewater, weights.citadel,
    0.07,        // market dynamics
  ]
  const sumW8 = w8.reduce((s, v) => s + v, 0)
  const debateScore = Math.min(100, Math.max(0,
    agents.reduce((s, a, i) => s + a.score * w8[i] / sumW8, 0)
  ))

  const variance = agents.reduce((s, a) => s + (a.score - debateScore) ** 2, 0) / agents.length
  const confidence = Math.max(0.3, Math.min(1.0, 1 - Math.sqrt(variance) / 100))
  const finalView: 'BUY' | 'HOLD' | 'SELL' = debateScore >= 72 ? 'BUY' : debateScore >= 48 ? 'HOLD' : 'SELL'

  // 統合強気・弱気理由（全エージェントから上位を集約）
  const bullReasons = agents.flatMap(a => a.bullPoints).slice(0, 4)
  const bearReasons = agents.flatMap(a => a.bearPoints).slice(0, 3)

  // ── Phase 4: 委員会統合出力 ──────────────────────────────────

  // ロック判定（3ヶ月売却不可）
  const isLocked = isSellLocked(h, now)
  const lockDate = getSellableDate(h)
  const lockDateLabel = lockDate ?? 'ロック解除日不明'

  // リスク承認ゲート（全代理が合意する最低条件）
  const riskGatePass =
    market.vix < VIX_HIGH_CAUTION &&
    market.regime !== 'bear' &&
    riskPenalty < 10 &&
    debateScore >= 45 &&
    confidence >= 0.45

  // 行動理由を統合（全代理から集約・重複排除）
  // ロック中銘柄はSELL実行理由を非表示にする
  const buyReasons   = uniqueTop(agents.flatMap(a => a.buyReasons),   4)
  const waitReasons  = uniqueTop(agents.flatMap(a => a.waitReasons),  3)
  const sellReasons  = isLocked
    ? []
    : uniqueTop(agents.flatMap(a => a.sellReasons), 3)

  // 推奨アクション（ロック中は実行系SELL文言を一切出さない）
  const recommendedAction = (() => {
    if (isLocked) {
      return `売却不可期間中（解除予定: ${lockDateLabel}）— 監視強化・新規買い停止・ロック解除後に削減候補`
    }
    if (!riskGatePass) {
      return `リスクゲート非通過 — 新規エントリー不可（VIX ${market.vix.toFixed(1)} / ${market.regime === 'bear' ? '弱気レジーム' : 'リスク過大'}）`
    }
    if (finalView === 'BUY' && confidence >= 0.70) {
      return `${h.name}を3分割エントリー推奨（信頼度 ${Math.round(confidence * 100)}%）`
    }
    if (finalView === 'BUY') {
      return `条件付きエントリー — MACD・出来高を確認後に第1回を執行`
    }
    if (finalView === 'HOLD' && debateScore >= 62) {
      return `継続保有 — 前提条件を週次でモニターしながら保持`
    }
    if (finalView === 'HOLD') {
      return `様子見継続 — 次回決算まで追加は見送り`
    }
    if (finalView === 'SELL' && confidence >= 0.70) {
      return `${h.name}を今週中に段階的縮小 — まず半量を撤退`
    }
    return `損失限定を優先 — 逆指値 −15% を設定し損切り準備`
  })()

  // 利確条件
  const takeProfitConditions = uniqueTop([
    h.target > 0 && h.currentPrice
      ? `目標株価 ${h.target.toLocaleString('ja-JP')}円 到達時（現在 ${h.currentPrice.toLocaleString('ja-JP')}円）`
      : '',
    h.rsi > 68 ? `RSI ${h.rsi.toFixed(0)} — 過熱圏で段階的利確` : 'RSI 75 超えで一部利確',
    h.mom3m > 20 ? `3Mモメンタム +${h.mom3m.toFixed(1)}% — 急騰後の利益確定` : `3Mモメンタム +20% 超で一部確定`,
    h.pnlPct > 25 ? `含み益 +${h.pnlPct.toFixed(1)}% 超過 — 利確水準` : '取得価格比 +25% で段階利確',
    'MACDデッドクロス確定時に50%を利確',
  ].filter(Boolean), 4)

  // 損切条件（ロック中は実行系損切文言を出さず、監視・ヘッジ対応のみ）
  const stopLossConditions = isLocked
    ? [
        `ロック期間中（解除予定: ${lockDateLabel}）— 売却・損切は不可`,
        `前提崩れ（EPS急落・格下げ等）時はアラートのみ — ヘッジまたは現金維持を優先`,
        `ロック解除後に改めて削減候補として評価する`,
      ]
    : uniqueTop([
        `取得価格から −15% で機械的損切（${h.name}）`,
        h.pnlPct < -10 ? `現在含み損 ${h.pnlPct.toFixed(1)}% — 損切ラインに接近` : '',
        `MA25 + MACD 両方陰転で撤退`,
        `VIX 30 超え + 弱気レジーム転換で全量撤退`,
        h.epsG < 0 ? `EPS減益転落（現在 ${h.epsG}%）で前提崩れ → 損切` : '',
      ].filter(Boolean), 4)

  // 前提崩れ条件（全代理から集約）
  const premiseBreakConditions = uniqueTop([
    ...agents.flatMap(a => a.premiseBreak).filter(Boolean),
  ], 5)

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
    buyReasons,
    waitReasons,
    sellReasons,
    recommendedAction,
    takeProfitConditions,
    stopLossConditions,
    premiseBreakConditions,
    riskGatePass,
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

const DEFAULT_WEIGHTS: AdaptiveWeights = {
  fundamental: 0.30,
  market: 0.20,
  technical: 0.20,
  news: 0.15,
  quality: 0.10,
  risk: 0.15,
}

function resolveWeights(adaptive: AdaptiveWeights | null): AdaptiveWeights {
  if (!adaptive) return DEFAULT_WEIGHTS

  const raw = {
    fundamental: Math.max(0, adaptive.fundamental),
    market: Math.max(0, adaptive.market),
    technical: Math.max(0, adaptive.technical),
    news: Math.max(0, adaptive.news),
    quality: Math.max(0, adaptive.quality),
    risk: Math.max(0, adaptive.risk),
  }
  const sum = raw.fundamental + raw.market + raw.technical + raw.news + raw.quality + raw.risk
  if (sum <= 0.0001) return DEFAULT_WEIGHTS

  // スコア式の既存スケール（0.95 - 0.15 = v8.x互換）を維持するため1.10へ再スケール
  const scale = 1.10 / sum
  return {
    fundamental: raw.fundamental * scale,
    market: raw.market * scale,
    technical: raw.technical * scale,
    news: raw.news * scale,
    quality: raw.quality * scale,
    risk: raw.risk * scale,
  }
}

// ── 全銘柄分析（main export）────────────────────────────────────
export function computeAnalysis(
  holdings: Holding[],
  market: Market,
  _corr: CorrelationData | null,
  news: NewsData | null,
  adaptiveWeights: AdaptiveWeights | null = null,
  nowMs = Date.now(),
): HoldingAnalysis[] {
  const totalEval = holdings.reduce((s, h) => s + h.eval, 0)
  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval / Math.max(totalEval, 1), 0)
  const w = resolveWeights(adaptiveWeights)

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
      fN * w.fundamental +
      mN * w.market +
      tN * w.technical +
      nN * w.news +
      qN * w.quality -
      rN * w.risk
    )

    const ev = calcEV(h, market)
    const decision: 'BUY' | 'HOLD' | 'SELL' =
      totalScore >= 75 && ev > 0 ? 'BUY' :
      totalScore >= 50 ? 'HOLD' : 'SELL'

    const debate = runAIDebate(
      h, fundamentalScore, technicalScore, marketScore,
      newsScore, qualityScore, riskPenalty, news, market, new Date(nowMs),
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
