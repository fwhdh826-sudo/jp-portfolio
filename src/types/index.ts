// ── Holding (日本株 個別銘柄) ──────────────────────────────────
export interface Holding {
  code: string
  name: string
  eval: number        // 評価額（円）
  pnlPct: number      // 損益率（%）
  mu: number          // 期待リターン
  sigma: number       // ボラティリティ（実測 or 推定）
  sigmaSource: 'yfinance' | 'static'
  beta: number
  sector: string
  target: number      // 目標株価
  alert: number       // アラート株価
  lock: boolean       // ロック中（売却不可期間）
  mitsu: boolean      // 三菱グループフラグ
  // テクニカル
  ma: boolean         // MA上位
  rsi: number
  macd: boolean       // MACD陽転
  vol: boolean        // 出来高増
  mom3m: number       // 3ヶ月モメンタム（%）
  // ファンダメンタル
  roe: number
  per: number
  pbr: number
  epsG: number        // EPS成長率（%）
  cfOk: boolean       // CF良好
  de: number          // D/Eレシオ
  divG: number        // 配当成長率（%）
  // 計算結果（Storeで付与）
  score: number
  decision: 'BUY' | 'HOLD' | 'SELL'
  ev: number          // Expected Value
}

// ── Trust (投資信託) ───────────────────────────────────────────
export type TrustPolicy = 'JAPAN_SHORTTERM' | 'OVERSEAS_LONGTERM' | 'GOLD'

export interface Trust {
  id: string
  name: string
  abbr: string
  account: string
  policy: TrustPolicy
  eval: number
  pnlPct: number
  dayPct: number
  cost: number        // 信託報酬（%）
  mu: number
  sigma: number
  score: number
  signal: string
  ev: number
  decision: 'BUY' | 'HOLD' | 'WAIT' | 'SELL'
}

// ── Market ────────────────────────────────────────────────────
export interface Market {
  last_updated: string
  nikkei: number
  nikkeiChg: number
  nikkeiChgPct: number
  ma5: number
  ma25: number
  ma75: number
  rsi14: number
  macd: 'golden' | 'dead'
  volume: 'high' | 'normal' | 'low'
  bollUpper: number
  bollMid: number
  bollLower: number
  regime: 'bull' | 'neutral' | 'bear'
  boj: string
  bojNext: string
  vix: number
}

// ── Correlation ───────────────────────────────────────────────
export interface CorrelationData {
  last_updated: string
  period: string
  tickers: string[]
  matrix: Record<string, Record<string, number>>
  volatilities: Record<string, number>
  status: 'ok' | 'error'
}

// ── News ──────────────────────────────────────────────────────
export type Sentiment = 'positive' | 'neutral' | 'negative'

export interface NewsItem {
  id: string
  source: string
  title: string
  summary: string
  url: string
  publishedAt: string
  sentiment: Sentiment
  sentimentScore: number   // -1.0 ~ 1.0
  importance: number       // 0 ~ 1
  tags: string[]
  tickers: string[]        // 関連銘柄コード
}

export interface NewsData {
  updatedAt: string
  sourceStatus: Record<string, 'ok' | 'error' | 'timeout'>
  marketNews: NewsItem[]
  stockNews: NewsItem[]
  meta: {
    totalCount: number
    marketCount: number
    stockCount: number
    duplicateRemoved: number
  }
}

// ── Analysis (計算結果) ───────────────────────────────────────
export interface PortfolioMetrics {
  mu: number          // 期待リターン
  sigma: number       // ポートフォリオσ
  sharpe: number
  sortino: number
  mdd: number         // 最大DD（推定）
  calmar: number
  cvar: number        // CVaR 95%
  totalEval: number
}

export interface HoldingAnalysis {
  code: string
  fundamentalScore: number   // 0-30
  marketScore: number        // 0-20
  technicalScore: number     // 0-20
  newsScore: number          // 0-15
  qualityScore: number       // 0-10
  riskPenalty: number        // 0-15
  totalScore: number         // 0-100
  ev: number
  decision: 'BUY' | 'HOLD' | 'SELL'
  confidence: number         // 0-1
  // AI討論
  debate: AgentDebate
}

// ── AI討論 ────────────────────────────────────────────────────
export interface AgentScore {
  agent: string
  style: string
  score: number      // 0-100
  bullPoints: string[]
  bearPoints: string[]
}

export interface AgentDebate {
  agents: AgentScore[]
  debateScore: number
  confidence: number
  finalView: 'BUY' | 'HOLD' | 'SELL'
  sevenAxis: {
    growth: number
    valuation: number
    momentum: number
    macro: number
    quality: number
    risk: number
    news: number
  }
}

// ── System ────────────────────────────────────────────────────
export type SystemStatus = 'idle' | 'loading' | 'success' | 'error'

export interface SystemState {
  version: '8.1' | '8.3'
  status: SystemStatus
  lastUpdated: string | null
  csvLastImportedAt: string | null
  analysisLastRunAt: string | null
  error: string | null
  dataSourceStatus: {
    market: 'loaded' | 'static' | 'error'
    correlation: 'loaded' | 'static' | 'error'
    news: 'loaded' | 'none' | 'error'
    trust: 'loaded' | 'static'
  }
}

// ── App Store ─────────────────────────────────────────────────
export interface AppState {
  holdings: Holding[]
  trust: Trust[]
  market: Market
  correlation: CorrelationData | null
  news: NewsData | null
  metrics: PortfolioMetrics | null
  analysis: HoldingAnalysis[]
  system: SystemState
  activeTab: TabId
}

export type TabId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7'
