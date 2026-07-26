// ── Holding (日本株 個別銘柄) ──────────────────────────────────
export interface Holding {
  code: string
  name: string
  eval: number        // 評価額（円）
  pnlPct: number      // 損益率（%）
  currentPrice?: number // 現在価格（円）
  mu: number          // 期待リターン
  sigma: number       // ボラティリティ（実測 or 推定）
  sigmaSource: 'yfinance' | 'static'
  beta: number
  sector: string
  target: number      // 目標株価
  alert: number       // アラート株価
  lock: boolean       // ロック中（売却不可期間）
  acquiredAt?: string // 取得日（YYYY-MM-DD）
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
  notForTrading?: boolean  // 取引不可フラグ（サンプル契約・非売品など）
}

// ── Market ────────────────────────────────────────────────────
export interface Market {
  last_updated: string
  nikkei: number
  nikkeiChg: number
  nikkeiChgPct: number
  nikkeiFutures?: number
  nikkeiFuturesChg?: number
  nikkeiFuturesChgPct?: number
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
  // v9.1 追加: 意思決定支援フィールド
  impact?: 'positive' | 'negative' | 'neutral'
  whyImportant?: string    // なぜ重要か
  recommendation?: string  // 推奨アクション
  // UI-13-1: 日本語表示フィールド（翻訳スクリプト完成後に populate される）
  titleJa?: string
  summaryJa?: string
  translationStatus?: 'translated' | 'pending' | 'ja-original'
  translatedAt?: string
}

export interface NewsData {
  updatedAt: string
  sourceStatus: Record<string, 'ok' | 'error' | 'timeout'>
  sourceUpdatedAt?: Record<string, string | null> // ソース別最終更新
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

export type StrategyRank = 'S' | 'A' | 'B' | 'C' | 'D' | 'E'

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
  strategyRank: StrategyRank // S/A/B/C/D/E 総合ランク
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
  // Phase 4: 行動理由 & 前提管理（代理ごとの独立評価）
  buyReasons: string[]      // 今買う理由
  waitReasons: string[]     // 待つ理由
  sellReasons: string[]     // 売る理由
  premise: string[]         // 前提条件
  premiseBreak: string[]    // 前提崩れ条件
}

export interface AgentDebate {
  agents: AgentScore[]      // Phase 4: 8代理
  debateScore: number
  confidence: number
  finalView: 'BUY' | 'HOLD' | 'SELL'
  // v9.1: 統合強気・弱気理由（全エージェントから集約）
  bullReasons: string[]
  bearReasons: string[]
  // Phase 4: 行動理由 & 条件管理（委員会統合）
  buyReasons: string[]              // 今買う理由（統合）
  waitReasons: string[]             // 待つ理由（統合）
  sellReasons: string[]             // 売る理由（統合）
  recommendedAction: string         // 推奨アクション
  takeProfitConditions: string[]    // 利確条件
  stopLossConditions: string[]      // 損切条件
  premiseBreakConditions: string[]  // 前提崩れ条件
  riskGatePass: boolean             // リスク承認ゲート
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

// ── Learning (自己強化) ───────────────────────────────────────
export interface LearningOutcome {
  code: string
  predictedAt: string
  evaluatedAt: string
  decision: 'BUY' | 'HOLD' | 'SELL'
  score: number
  confidence: number
  prevPnlPct: number
  currPnlPct: number
  deltaPnlPct: number
  reward: number
  result: 'win' | 'loss' | 'flat'
  regime?: 'bull' | 'neutral' | 'bear'  // Phase 8: レジーム別有効性追跡
}

export interface LearningBaseline {
  code: string
  predictedAt: string
  decision: 'BUY' | 'HOLD' | 'SELL'
  score: number
  confidence: number
  pnlPct: number
  regime?: 'bull' | 'neutral' | 'bear'  // Phase 8: 予測時のレジーム
}

export interface DecisionSummary {
  count: number
  wins: number
  losses: number
  flats: number
  accuracy: number
  avgReward: number
}

export interface AdaptiveWeights {
  fundamental: number
  market: number
  technical: number
  news: number
  quality: number
  risk: number
}

export interface LearningSummary {
  total: number
  wins: number
  losses: number
  flats: number
  accuracy: number
  avgReward: number
  byDecision: {
    BUY: DecisionSummary
    HOLD: DecisionSummary
    SELL: DecisionSummary
  }
  driftSignals: string[]
}

export interface LearningState {
  lastUpdated: string
  baselineCount: number
  baseline: LearningBaseline[]
  outcomes: LearningOutcome[]
  summary: LearningSummary
  suggestedWeights: AdaptiveWeights
}

// ── System ────────────────────────────────────────────────────
export type SystemStatus = 'idle' | 'loading' | 'success' | 'error'

export interface DataSourceInfo {
  status: 'loaded' | 'static' | 'none' | 'error'
  lastUpdatedAt: string | null   // v9.0: 各ソースの最終更新日時
}

export interface SystemState {
  version: '8.1' | '8.3' | '9.0' | '9.1' | '9.5' | '10.0'
  status: SystemStatus
  lastUpdated: string | null
  csvLastImportedAt: string | null
  // T9-A004: csvLastImportedAtは取込操作時刻。CSVデータ自体の基準時点は
  // csvImportProvenance.sourceAsOfとして別に保持し、両者を鮮度比較で混同しない。
  csvImportProvenance?: CsvImportProvenance | null
  analysisLastRunAt: string | null
  error: string | null
  dataSourceStatus: {
    market: 'loaded' | 'static' | 'error'
    correlation: 'loaded' | 'static' | 'error'
    news: 'loaded' | 'none' | 'error'
    trust: 'loaded' | 'static' | 'csv'
    holdings?: 'loaded' | 'static' | 'csv' | 'none' | 'error'
    // v9.0 追加
    macro?: 'loaded' | 'static' | 'none' | 'error'
    nikkeiVI?: 'loaded' | 'static' | 'none' | 'error'
    sq?: 'loaded' | 'static' | 'none' | 'error'
    margin?: 'loaded' | 'none' | 'error'
    flows?: 'loaded' | 'none' | 'error'
    // P4-A9c-data-4d: observability only, signals.news未接続
    candidatesNews?: 'loaded' | 'default'
    // P5-B002a: 新規個別株候補（observability only, officialDecision未接続）
    candidatesStocks?: 'loaded' | 'default'
    // P5-B005-B3-B: candidate funnel artifact（observability only）
    candidateFunnel?: 'loaded' | 'unavailable' | 'invalid'
    // P4-A9d: 5-regime live state（observability only）
    regime?: 'loaded' | 'default'
    // P4-A24: SAFE_MODE / TierA live snapshot（observability only）
    safeMode?: 'loaded' | 'default'
    tierAViolations?: 'loaded' | 'default'
    tierAAlerts?: 'loaded' | 'default'
  }
  // v9.0: 各データソースの最終更新日時
  dataTimestamps?: {
    market: string | null
    correlation: string | null
    news: string | null
    trust: string | null
    holdings?: string | null
    macro: string | null
    nikkeiVI: string | null
    sq: string | null
    margin: string | null
    flows: string | null
    candidatesNews?: string | null
    candidatesStocks?: string | null
    candidateFunnel?: string | null
    regime?: string | null
    // P4-A24
    safeMode?: string | null
    tierAViolations?: string | null
    tierAAlerts?: string | null
  }
  // P4.5-A012d: localStorage保存data(holdings/trust)の鮮度。表示専用の警告用。
  // TTLを超えても値は削除されないため、UI側でstale警告を出すためだけの情報。
  // 投資判断ロジック（headroom/candidate/officialDecision等）は参照しない。
  localStorageFreshness?: {
    portfolio: { isStale: boolean; ageDays: number | null }
    trust: { isStale: boolean; ageDays: number | null }
  }
  // P4.5-A013-T6: 直近CSV取込結果の集計（表示専用）。importPortfolioCsv成功時のみ更新し、
  // 失敗時・portfolio snapshot importでは変更しない（虚偽の成功表示を避けるため）。
  csvSyncSummary?: CsvSyncSummary | null
  /**
   * RA-008-D1: 別タブでdurable portfolio generationが更新された可能性を示す表示専用状態。
   * portfolio dataのauthorityではなく、投資判断ロジックや永続化には使用しない。
   * undefinedは警告なしを表す。clearできるのはWeb-Lock-verified initialize SUCCESSのみ。
   */
  crossTabInvalidation?: CrossTabInvalidationState
}

// RA-008-D1: Zustand投影専用のUI状態。messageId/senderInstanceId/committedAt/operationなど
// event由来のraw dataは一切保持しない（表示にはstale/not-staleの二値で十分なため）。
export interface CrossTabInvalidationState {
  status: 'stale'
}

export type CsvSourceAsOfKind =
  | 'csv_explicit'
  | 'csv_exported_at'
  | 'filename'
  | 'file_last_modified'
  | 'unknown'

export type CsvSourceAsOfConfidence = 'authoritative' | 'weak' | 'unknown'

export interface CsvSourceProvenance {
  sourceAsOf: string | null
  sourceAsOfKind: CsvSourceAsOfKind
  sourceAsOfConfidence: CsvSourceAsOfConfidence
  /** SHA-256 of normalized semantic CSV content. Absent only on legacy canonical v2 state. */
  semanticIdentity?: string
  /** Legacy FNV-1a checksum retained for canonical v2 migration compatibility. */
  contentFingerprint: string
  sourceFileName: string | null
  fileLastModified: string | null
}

export interface CsvImportProvenance extends CsvSourceProvenance {
  /** CSV取込操作を開始した時刻。sourceAsOfの代用品にはしない。 */
  importedAt: string
}

// P4.5-A013-T6: CSV取込1回分の変更点サマリ（表示専用。投資判断ロジックは参照しない）。
export interface CsvSyncSummary {
  importedAt: string
  stock: {
    updated: number
    added: number
    removed: number
  }
  trust: {
    updated: number
    reheld: number
    zeroed: number
    unknownFunds: { name: string; eval: number }[]
    ambiguousFundIds: string[]
  }
}

// ── P1-3A: Official Decision 型（committee接続の安定インターフェース） ──
// 判断の最終出力型。UI はこの型を参照し、内部実装（committee/compute）には依存しない。
export type OfficialDecisionSource =
  | 'committee'         // buildCommitteeDecision 経由（P1-3B以降）
  | 'compute_analysis'  // computeAnalysis 暫定パス（現在の実装）
  | 'trust_short'       // trustPortfolio 短期シグナル
  | 'risk_gate'         // DQ gate / noTrade 強制
  | 'manual'
  | 'candidate'         // 未保有候補発掘エンジン由来

export type OfficialDecisionAction =
  | 'BUY'          // 保有中の追加買い
  | 'HOLD'
  | 'WAIT'
  | 'SELL'
  | 'MONITOR'      // ロック中・監視強化
  | 'BLOCKED'      // リスクゲート非通過
  | 'DATA_WAIT'    // DQ gate 抑制中
  | 'BUY_NEW'      // 未保有商品の新規採用候補
  | 'ADD_EXISTING' // 保有中商品の追加買い（BUYとの将来分離用受け皿）
  | 'WATCH'        // 候補として監視。条件未達のため今は買わない

// 未保有候補のブロック理由
export type CandidateBlockedReason =
  | 'DQ_SUPPRESSED'
  | 'NO_TRADE_EMERGENCY'
  | 'CLASS_FULL'
  | 'CLASS_TARGET_MISSING'
  | 'INSUFFICIENT_CASH'
  | 'JP_STOCK_CAP'
  | 'NOT_FOR_TRADING'
  | 'SAMPLE_CONTRACT'
  | 'NOT_ELIGIBLE'
  | 'SCORE_TOO_LOW'
  | 'DUPLICATE_ROLE'
  | 'VOL_TOO_HIGH'
  | 'COST_TOO_HIGH'
  | 'DATA_STALE'
  | 'SAFE_MODE_ACTIVE'

export interface OfficialDecisionItem {
  id: string
  assetType: 'stock' | 'jp_trust' | 'global_trust' | 'gold' | 'cash' | 'portfolio'
  code?: string
  name: string
  action: OfficialDecisionAction
  reason: string
  amount?: number
  confidence?: number
  candidateScore?: number   // P4-A7c: candidate.score を 0-1 に正規化した参考スコア
  blockedReason?: string
  source: OfficialDecisionSource
  // 未保有候補フィールド（既存 holding item では undefined）
  isCandidate?: boolean
  suggestedAmount?: number
  maxAmount?: number
  // P4-A10-1: 購入量 tier（過大投入抑制。循環回避のため inline union）
  candidateSizingTier?: 'none' | 'min' | 'half' | 'full'
  candidateSource?: 'trust_master' | 'stock_scores_6axis' | 'candidates_stocks' | 'manual' | 'future_pipeline'
  constraintsPassed?: string[]
  constraintsBlocked?: CandidateBlockedReason[]
}

export interface OfficialDecision {
  generatedAt: string
  source: OfficialDecisionSource
  headline: string
  stance: 'risk_on' | 'neutral' | 'risk_off' | 'data_wait'
  noTrade: boolean
  dataQualitySuppressed: boolean
  actions: OfficialDecisionItem[]
  risks: string[]
  rationale: string[]
}

// ── App Store ─────────────────────────────────────────────────
import type { MacroSnapshot, SQCalendar, MarginData, FlowData } from './macro'
import type { AssetUniverse } from './universe'
import type { CandidatesNewsData } from './news'
import type { RegimeState } from './regime'
import type { CandidatesStocksData } from './candidatesStocks'
import type { CandidateFunnelArtifact } from './candidateFunnelArtifact'
export type { MacroSnapshot, SQCalendar, MarginData, FlowData } from './macro'
export type {
  AssetClass,
  Horizon,
  AssetCategorySummary,
  AssetUniverse,
  ScoringWeights,
} from './universe'

// P4-A47: 国内個別株上限比率ポリシー（ユーザー設定可能）
export interface PortfolioPolicy {
  /** 国内個別株の目標上限比率。初期値 0.10（10%）。OS内で 0.08/0.10/0.12/0.15 から選択予定 */
  jpStockMaxRatio: number
}

export const DEFAULT_PORTFOLIO_POLICY: PortfolioPolicy = {
  jpStockMaxRatio: 0.10,
}

// P4.5-A002: 資金前提の手動override（CSV/既定値より優先できる、加算ではなく置き換え）
export interface CashAssumptions {
  /** 現金・預貯金（手動入力値）。manualOverrideEnabled=trueのときのみ実効値として使われる */
  cashDeposits: number
  /** 待機・追加資金（手動入力値）。manualOverrideEnabled=trueのときのみ実効値として使われる */
  standbyFunds: number
  /** true: 手動入力値を実効値として使用。false: 既定値（constants/market.ts）を使用 */
  manualOverrideEnabled: boolean
  /** 手動値を最後に保存したISO時刻。manualOverrideEnabled=falseの場合はnull */
  manualUpdatedAt: string | null
}

export const DEFAULT_CASH_ASSUMPTIONS: CashAssumptions = {
  cashDeposits: 0,
  standbyFunds: 0,
  manualOverrideEnabled: false,
  manualUpdatedAt: null,
}

// P4.5-A009: 資金前提のPC/スマホ間「手動」同期用export/importペイロード。
// JSON文字列としてユーザーがコピー/貼り付けするためだけの形。
// public repo / public data JSON / workflow / backend には一切書き出さない。
export const CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION = 'cash-assumptions-export-1' as const

export interface CashAssumptionsExportPayload {
  schemaVersion: typeof CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION
  exportedAt: string
  cashDeposits: number
  standbyFunds: number
  manualOverrideEnabled: boolean
  manualUpdatedAt: string | null
}

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
  // v9.0 追加
  macro: MacroSnapshot | null
  sqCalendar: SQCalendar | null
  margin: MarginData | null
  flows: FlowData | null
  universe: AssetUniverse | null
  learning: LearningState | null
  // 現金・待機資金・追加枠（運用方針に基づく）
  cash: number
  cashReserve: number
  addRoom: number
  // Phase 7 — 計算観察値（Card 7-10/7-11）calculation-only
  stockScores6Axis: import('./scoring').StockScoreRecord[] | null
  fundPhase7: import('./scoring').FundPhase7Map | null
  // P1-3A: Official Decision（buildCommitteeDecision 接続済み・UIは未接続）
  officialDecision: OfficialDecision | null
  // P1-3B: Plan snapshots（各タブの独立生成を排除し store で一元管理）
  zeroPlan: import('../domain/optimization/zeroBase').ZeroBasePlan | null
  stockPlan: import('../domain/optimization/stockPortfolio').StockPortfolioPlan | null
  trustPlan: import('../domain/optimization/trustPortfolio').TrustPortfolioPlan | null
  // P4-A9c-data-4c: role-unit candidates news（observability用・意思決定未接続）
  candidatesNews: CandidatesNewsData
  // P5-B002a: 新規個別株候補（市場公開情報のみ。observability用・officialDecision未接続）
  candidatesStocks: CandidatesStocksData
  // P5-B005-B3-B: production candidate funnel（observability用・意思決定未接続）
  candidateFunnel: CandidateFunnelArtifact | null
  // P5-B002b-1: candidatesStocks由来のscore/headroom/gate計算済み内部候補リスト
  // （officialDecision未接続・UI未接続。B003で接続予定）
  stockCandidates: import('../domain/candidates/stockCandidates').StockCandidateItem[]
  // P4-A9d: 5-regime live state（observability用・意思決定未接続）
  regimeState: RegimeState
  // P4-A24: SAFE_MODE / TierA live snapshot（observability用・意思決定未接続）
  safeMode: import('./tierA').SafeModeSnapshot
  tierAViolations: import('./tierA').TierAViolationsSnapshot
  tierAAlerts: import('./tierA').TierAAlertsSnapshot
  // P4-A47: ユーザー設定可能なポートフォリオ方針
  portfolioPolicy: PortfolioPolicy
  // P4.5-A002: 資金前提の手動override（現金・待機資金）
  cashAssumptions: CashAssumptions
}

// V10: T0=ホーム T1=個別株 T2=国内株投信 T3=海外投信 T4=理想PF T5=ニュース T6=AI委員会 T7=実行プラン T8=学習/検証 T9=設定
export type TabId = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9'

// V10: 資産クラス識別型（ロジック分離の核）
export type AssetType = 'jp_stock' | 'jp_fund' | 'global_fund'

// ── v13.3 新規型（既存型は変更しない） ──────────────────────
export type {
  CandidateFunnelArtifact,
  CandidateFunnelArtifactMeta,
  CandidateFunnelQualityGate,
  CandidateFunnelQualityGateEntry,
  CandidateFunnelQualityGateRequiredId,
  CandidateFunnelQualityGateStatus,
  CandidateFunnelJoinStats,
  JsonValue as CandidateFunnelJsonValue,
} from './candidateFunnelArtifact'

export type {
  RegimeId,
  LlmRegimeVote,
  HmmRegimeVote,
  RegimeVotes,
  RegimeMarketSnapshot,
  RegimeState,
  RegimeHistoryEntry,
  RegimeConsensus,
  RegimeDisplayMeta,
} from './regime'
export { REGIME_DISPLAY_META } from './regime'

export type {
  NewsSourceId,
  NewsSourceStatus,
  NewsCategory,
  MarketNewsItemV13,
  TickerNewsSummary,
  HoldingsNewsV13,
  CandidatesNewsV13,
  EarningsEvent,
  EarningsCalendar,
  NewsSourcesStatus,
  NewsAggregatedV13,
  CandidatesNewsRoleKey,
  CandidatesNewsItem,
  CandidatesNewsRoleEntry,
  CandidatesNewsData,
} from './news'

export type {
  ScoreAxisId,
  ScoreRating,
  SizeSegment,
  ScoreComponent,
  AxisScore,
  SixAxisScore,
  CrossAxisSignals,
  DynamicTotalScore,
  StockScoreRecord,
  AxisWeights,
  RegimeAxisWeights,
  FundPhase7Entry,
  FundPhase7Map,
} from './scoring'

export type {
  StrategyId,
  IdealPortfolio,
  StrategyOutput,
  StrategyCorrelations,
  RegimeStrategyWeights,
  AllRegimeStrategyWeights,
  StrategyAggregated,
  StrategyFile,
  TimeHorizonWeights,
} from './strategy'

// P2-D1-a: Phase 8 presentation 型契約（方式1 Adapter 層の UI 入力境界）。
// StrategyAggregated は ./strategy から既に re-export 済みのため
// ./phase8 経由では再 re-export しない（重複 export 衝突回避、P1-D1a-6）。
export type {
  Phase8Meta,
  FrontierIndexPresentation,
  OpportunityLossPresentation,
  FutureBranchPresentation,
  FutureBranchingPresentation,
  Phase8Document,
} from './phase8'

export type {
  AssetTier,
  RebalanceAction,
  RebalancePriority,
  PathDependentRecommendation,
  ScenarioPreCommitmentAction,
  AlertLevel,
  ScenarioTrigger,
  VolatilityTargetResult,
  PathDependentRebalanceResult,
  ScenarioPreCommitmentsResult,
} from './rebalance'

export type {
  TierAHardRuleId,
  TierASoftRuleId,
  TierAHardViolation,
  TierASoftViolation,
  CapitulationConditionState,
  CapitulationState,
  TierAResult,
  TierAAlert,
  SafeModeData,
  SafeModeSnapshot,
  TierAViolationCode,
  TierAViolationsStatus,
  TierAViolationEntry,
  TierAViolationsSnapshot,
  TierAAlertCode,
  TierAAlertsStatus,
  TierAAlertEntry,
  TierAAlertsSnapshot,
} from './tierA'

export type {
  StockCandidateDataStatus,
  StockCandidateItem,
  CandidatesStocksData,
} from './candidatesStocks'
