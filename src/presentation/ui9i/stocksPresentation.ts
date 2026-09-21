// ═══════════════════════════════════════════════════════════
// UI-9I Phase 2B-1: 個別株（旧 T1）の presentation adapter。
//
// 権限は既存の T1 と同一（新しい判断は一切作らない）:
//   銘柄の現在の判断   = deriveDisplayDecision(holding.decision / officialDecision / DQ / SAFE_MODE / 上限 / ロック)
//   売却ロック         = isSellLocked() / getSellableDate()（now は注入。壁時計は自前で読まない）
//   SAFE_MODE          = selectEffectiveSafeModeActive（ローカル推定なし）
//   全体データ品質     = officialDecision.dataQualitySuppressed ?? selectMarketDataQuality
//   候補               = CandidateDecisionSynthesis（decisions → watchList の canonical 順を保持）
//   実行可否・金額     = entry.money のみ（Home と同じ projectCandidateRow を共有）
//   スコア             = HoldingAnalysis.totalScore（総合スコア）/ strategyRank（総合ランク）/ confidence（信頼度）
//                        StockScoreRecord（Phase 7 軸別スコア。calculation-only）
//
// このファイルは「読み取り結果 → 表示用の文言・値」の写像だけを持つ。
// 並べ替えは旧 StockList の順序（h.decision の BUY→HOLD→SELL、次に totalScore 降順）を
// そのまま移設したもの（orderStockHoldings）で、新しいランキングではない。
// ═══════════════════════════════════════════════════════════
import type {
  AppState,
  Holding,
  HoldingAnalysis,
  OfficialDecisionItem,
  StockScoreRecord,
  StrategyRank,
} from '../../types'
import type { CandidateDecisionSynthesisEntry, CandidateDecisionSynthesisSnapshot } from '../../types/candidateDecisionSynthesis'
import type { StockCandidateItem } from '../../types/candidatesStocks'
import { deriveDisplayDecision, type DisplayDecision } from '../../domain/analysis/displayDecision'
import { REGIME_DISPLAY_META, type RegimeId } from '../../types/regime'
import { isSellLocked, getSellableDate } from '../../domain/constraints/stockLock'
import { TIER_A_T1_STOP_LOSS_PCT } from '../../domain/constraints/tierAT1'
import { isCandidateFunnelRawAvailable } from '../../services/candidateFunnelFreshness'
import { selectCandidateDecisionSynthesis, selectEffectiveSafeModeActive, selectMarketDataQuality } from '../../store/selectors'
import { formatJPYAuto, formatSignedPct } from '../../utils/format'
import {
  SYNTHESIS_ACTION_LABEL,
  labelBlockedReasons,
  labelLimitingFactors,
  labelWarnings,
  synthesisNonExecutableReasonText,
} from '../../components/candidates/candidateDecisionSynthesisPresentation'
import { computeHoldingsStale } from '../../components/tabs/T0_Home'
import { projectCandidateRow, candidatePresentationSequence, type CandidatePreviewRow } from './candidatePresentation'
import { formatJstMonthDayTime, formatYen } from './formatters'
import { DATA_WAIT_ROW_LABEL, RELATIONSHIP_LABEL, UNAVAILABLE_LABEL } from './labels'
import { candidateProjectionContextFor, resolveHeroState, type HeroState } from './todayHome'

// ── ラベル ────────────────────────────────────────────────────

/**
 * 個別株の判断ラベル（enum は変えず、表示語だけを写像する）。
 * INSUFFICIENT_EVIDENCE は銘柄単位のローカル状態（全体 DATA_WAIT / SAFE_MODE にしない）。
 * DATA_WAIT は Home の候補行と同じ凍結語彙「更新待ち」。
 */
export const STOCK_DECISION_LABEL: Record<DisplayDecision, string> = {
  BUY: '買い',
  SELL: '売却',
  HOLD: '保有継続',
  WAIT: '待機',
  DATA_WAIT: DATA_WAIT_ROW_LABEL,
  INSUFFICIENT_EVIDENCE: '判断材料不足',
}

export type StockDecisionTone = 'buy' | 'sell' | 'hold' | 'wait' | 'insufficient'

export function stockDecisionTone(d: DisplayDecision): StockDecisionTone {
  if (d === 'BUY') return 'buy'
  if (d === 'SELL') return 'sell'
  if (d === 'INSUFFICIENT_EVIDENCE') return 'insufficient'
  if (d === 'WAIT' || d === 'DATA_WAIT') return 'wait'
  return 'hold'
}

/** 保有一覧の行は state.holdings 由来なので、canonical 関係は already_held（保有）。 */
const HELD_RELATIONSHIP = 'already_held' as const
export const STOCK_ROW_RELATIONSHIP_LABEL = RELATIONSHIP_LABEL[HELD_RELATIONSHIP]

/** 未知の関係値は推測せず null（ラベルを出さない）。 */
export function relationshipLabelOf(relationship: string): string | null {
  return relationship === 'already_held' || relationship === 'new_to_portfolio'
    ? RELATIONSHIP_LABEL[relationship]
    : null
}

export function stockRegimeDisplayLabel(regime: RegimeId): string {
  return REGIME_DISPLAY_META[regime].label
}

export function formatStockMetric(value: number | null | undefined, suffix = ''): string {
  return value === null || value === undefined ? '—' : `${value}${suffix}`
}

// ── 判断の導出（旧 T1 と同一の入力・同一の関数）──────────────────

export interface DecisionContext {
  readonly officialDecision: AppState['officialDecision']
  readonly dqSuppressed: boolean
  readonly capExceeded: boolean
  readonly safeModeActive: boolean
  readonly now: Date
}

function findOfficialAction(officialDecision: AppState['officialDecision'], h: Holding): OfficialDecisionItem | undefined {
  return officialDecision?.actions.find(oa => oa.assetType === 'stock' && (oa.code === h.code || oa.name === h.name))
}

function decisionOf(h: Holding, ctx: DecisionContext): { decision: DisplayDecision; locked: boolean; officialAction: OfficialDecisionItem | undefined } {
  const locked = isSellLocked(h, ctx.now)
  const officialAction = findOfficialAction(ctx.officialDecision, h)
  const decision = deriveDisplayDecision({
    hDecision: h.decision,
    officialAction,
    dqSuppressed: ctx.dqSuppressed,
    locked,
    capExceeded: ctx.capExceeded,
    safeModeActive: ctx.safeModeActive,
  })
  return { decision, locked, officialAction }
}

function gatherDecisionContext(state: AppState, now: number): DecisionContext {
  const dq = selectMarketDataQuality(state, now)
  const jpStockCat = state.universe?.categories.find(c => c.class === 'JP_STOCK')
  return {
    officialDecision: state.officialDecision,
    dqSuppressed: state.officialDecision?.dataQualitySuppressed ?? dq.isSuppressed,
    // P4-A37: 国内個別株上限超過判定（上限は PortfolioPolicy.jpStockMaxRatio で可変）
    capExceeded: jpStockCat != null && jpStockCat.currentRatio > jpStockCat.targetRatio,
    safeModeActive: selectEffectiveSafeModeActive(state, now),
    now: new Date(now),
  }
}

/**
 * 旧 StockList の表示順の移設（新しいランキングではない）。
 * h.decision の BUY→HOLD→SELL、次に HoldingAnalysis.totalScore 降順。
 */
export function orderStockHoldings(holdings: readonly Holding[], analysis: readonly HoldingAnalysis[]): Holding[] {
  const analysisMap = new Map(analysis.map(a => [a.code, a]))
  const order: Record<string, number> = { BUY: 0, HOLD: 1, SELL: 2 }
  return [...holdings].sort((a, b) => {
    const ao = order[a.decision] ?? 1
    const bo = order[b.decision] ?? 1
    if (ao !== bo) return ao - bo
    const as_ = analysisMap.get(a.code)?.totalScore ?? 0
    const bs_ = analysisMap.get(b.code)?.totalScore ?? 0
    return bs_ - as_
  })
}

// ── 一覧 ──────────────────────────────────────────────────────

export interface StockRowViewModel {
  readonly code: string
  readonly name: string
  readonly sector: string
  readonly relationshipLabel: string
  /** deriveDisplayDecision の結果（enum。data-decision に保持する）。 */
  readonly decision: DisplayDecision
  readonly decisionLabel: string
  readonly tone: StockDecisionTone
  readonly locked: boolean
  /** 含み損が TIER_A_T1_STOP_LOSS_PCT 以下（警告のみ。自動売却はしない）。 */
  readonly stopLossWarning: boolean
  readonly pnlLabel: string
  readonly pnlSign: 'pos' | 'neg' | 'zero'
  /** HoldingAnalysis.totalScore（総合スコア）。判断材料不足の銘柄は表示しない（null）。 */
  readonly score: number | null
  readonly strategyRank: StrategyRank | null
  readonly rsiLabel: string
}

export type StockCandidateRowViewModel = CandidatePreviewRow & {
  readonly actionLabel: string
  readonly nonExecutableReason: string | null
  readonly executableAmountLabel: string | null
  /** money = EXECUTABLE だが現在は実行提案として出さない理由（SAFE_MODE など）。 */
  readonly suppressedNote: string | null
  readonly blockingLabels: readonly string[]
  readonly warningLabels: readonly string[]
  readonly limitingLabels: readonly string[]
  readonly metrics: readonly { readonly label: string; readonly value: string }[] | null
}

export type StockCandidateSectionViewModel =
  | { readonly status: 'unavailable'; readonly message: string; readonly detail: string }
  | {
    readonly status: 'available'
    readonly rows: readonly StockCandidateRowViewModel[]
    readonly countLabel: string
    readonly empty: boolean
  }

export interface StocksListViewModel {
  readonly rows: readonly StockRowViewModel[]
  readonly countLabel: string
  readonly analysisTimeLabel: string | null
  readonly notices: readonly { readonly id: 'data_quality' | 'holdings_stale' | 'safe_mode'; readonly text: string }[]
  readonly candidateNotice: string | null
  readonly candidates: StockCandidateSectionViewModel
}

export interface StocksListInputs {
  readonly holdings: readonly Holding[]
  readonly analysis: readonly HoldingAnalysis[]
  readonly decisionContext: DecisionContext
  readonly analysisLastRunAt: string | null
  readonly dqReason: string | null
  readonly holdingsStale: boolean
  readonly portfolioStale: boolean
  readonly synthesis: CandidateDecisionSynthesisSnapshot | null
  readonly rawCandidates: readonly StockCandidateItem[]
  readonly rawFunnelAvailable: boolean
  readonly heroState: HeroState
}

const pnlSignOf = (pct: number): 'pos' | 'neg' | 'zero' => (pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'zero')

function projectStockRow(h: Holding, a: HoldingAnalysis | undefined, ctx: DecisionContext): StockRowViewModel {
  const { decision, locked } = decisionOf(h, ctx)
  const insufficient = decision === 'INSUFFICIENT_EVIDENCE'
  return {
    code: h.code,
    name: h.name,
    sector: h.sector,
    relationshipLabel: STOCK_ROW_RELATIONSHIP_LABEL,
    decision,
    decisionLabel: STOCK_DECISION_LABEL[decision],
    tone: stockDecisionTone(decision),
    locked,
    stopLossWarning: h.pnlPct <= TIER_A_T1_STOP_LOSS_PCT,
    pnlLabel: formatSignedPct(h.pnlPct),
    pnlSign: pnlSignOf(h.pnlPct),
    // 分析データが揃っていない銘柄の総合スコアは、判断の根拠として提示しない。
    score: insufficient ? null : (a?.totalScore ?? h.score),
    strategyRank: insufficient ? null : (a?.strategyRank ?? null),
    rsiLabel: h.rsi.toFixed(0),
  }
}

const SUPPRESSED_NOTE: Partial<Record<HeroState, string>> = {
  safe_mode: 'SAFE_MODE 中のため実行できません（分析・レビューは有効です）',
  decision_unavailable: '現在の判断を利用できないため、実行提案は表示しません',
  data_wait: '更新待ちのため、実行可能額は表示しません',
}

function projectCandidateEntry(
  entry: CandidateDecisionSynthesisEntry,
  rawByCode: ReadonlyMap<string, StockCandidateItem>,
  heroState: HeroState,
): StockCandidateRowViewModel {
  const row = projectCandidateRow(entry, candidateProjectionContextFor(heroState))
  const raw = entry.code !== null ? rawByCode.get(entry.code) : undefined
  const executable = entry.money.kind === 'EXECUTABLE'
  return {
    ...row,
    actionLabel: SYNTHESIS_ACTION_LABEL[entry.action],
    nonExecutableReason: executable ? null : synthesisNonExecutableReasonText(entry),
    executableAmountLabel: row.executableAmountJpy === null ? null : formatYen(row.executableAmountJpy),
    suppressedNote: executable && row.executableAmountJpy === null ? (SUPPRESSED_NOTE[heroState] ?? null) : null,
    blockingLabels: labelBlockedReasons(entry.blockingReasons),
    warningLabels: labelWarnings(entry.warnings),
    limitingLabels: labelLimitingFactors(entry.limitingFactors),
    metrics: raw === undefined
      ? null
      : [
        { label: 'PER', value: formatStockMetric(raw.per) },
        { label: 'PBR', value: formatStockMetric(raw.pbr) },
        { label: 'ROE', value: formatStockMetric(raw.roe, '%') },
        { label: '配当', value: formatStockMetric(raw.dividendYield, '%') },
        { label: 'σ252d', value: formatStockMetric(raw.sigma252d) },
        { label: '3M', value: formatStockMetric(raw.mom3m, '%') },
      ],
  }
}

export function projectStockCandidates(i: Pick<StocksListInputs, 'synthesis' | 'rawCandidates' | 'rawFunnelAvailable' | 'heroState'>): StockCandidateSectionViewModel {
  const synthesis = i.synthesis
  if (synthesis === null || synthesis.status !== 'available') {
    return {
      status: 'unavailable',
      message: synthesis?.status === 'invalid'
        ? '候補データの再計算が必要です'
        : i.rawFunnelAvailable ? 'ポートフォリオ連携結果を更新中です' : '候補データ更新待ちです',
      detail: i.rawFunnelAvailable ? '市場候補ファネルは下に表示しています' : '次回のデータ更新後に表示されます',
    }
  }
  const rawByCode = new Map(i.rawCandidates.map(c => [c.code, c]))
  // 提示順 = decisions → watchList（synthesis が確定した canonical 順。再ソート・再フィルタ・再スコアしない）
  const rows = candidatePresentationSequence(synthesis).map(e => projectCandidateEntry(e, rawByCode, i.heroState))
  return {
    status: 'available',
    rows,
    countLabel: `${rows.length}件`,
    empty: rows.length === 0,
  }
}

export function assembleStocksList(i: StocksListInputs): StocksListViewModel {
  const analysisMap = new Map(i.analysis.map(a => [a.code, a]))
  const ordered = orderStockHoldings(i.holdings, i.analysis)
  const rows = ordered.map(h => projectStockRow(h, analysisMap.get(h.code), i.decisionContext))
  const buyCount = rows.filter(r => r.decision === 'BUY').length
  const lockCount = rows.filter(r => r.locked).length

  const notices: Array<StocksListViewModel['notices'][number]> = []
  if (i.dqReason !== null) {
    notices.push({ id: 'data_quality', text: `データ品質低下 — ${i.dqReason}。買いシグナルは参考値です（実行推奨停止）。` })
  }
  if (i.holdingsStale) {
    notices.push({ id: 'holdings_stale', text: '保有データが古い可能性があります。CSV再取込または保有株・投信の同期（手動）を確認してください。' })
  }
  if (i.decisionContext.safeModeActive) {
    notices.push({ id: 'safe_mode', text: 'SAFE_MODE 中 — 新規買付は停止しています。分析・レビューの表示は有効です。' })
  }

  return {
    rows,
    countLabel: `${rows.length} 銘柄 — 買い ${buyCount} / ロック ${lockCount}`,
    analysisTimeLabel: formatJstMonthDayTime(i.analysisLastRunAt),
    notices,
    candidateNotice: i.portfolioStale
      ? '保有データが古い可能性があります。スマホからのportfolio snapshot同期を推奨します。'
      : null,
    candidates: projectStockCandidates(i),
  }
}

export function selectStocksListViewModel(state: AppState, now: number = Date.now()): StocksListViewModel {
  const ctx = gatherDecisionContext(state, now)
  const dq = selectMarketDataQuality(state, now)
  const system = state.system
  return assembleStocksList({
    holdings: state.holdings,
    analysis: state.analysis,
    decisionContext: ctx,
    analysisLastRunAt: system.analysisLastRunAt,
    dqReason: dq.isSuppressed ? dq.reason : null,
    holdingsStale: computeHoldingsStale(system),
    // P5-B003由来: 判断ロジックには影響しない表示専用の警告（P4.5-A012整合）。
    portfolioStale: system.localStorageFreshness?.portfolio.isStale ?? false,
    synthesis: selectCandidateDecisionSynthesis(state),
    rawCandidates: state.candidatesStocks.candidates,
    rawFunnelAvailable: isCandidateFunnelRawAvailable({
      status: system.dataSourceStatus.candidateFunnel,
      artifact: state.candidateFunnel,
      generatedAtTimestamp: system.dataTimestamps?.candidateFunnel,
    }),
    heroState: resolveHeroState(state, now),
  })
}

// ── 比較表（旧「銘柄スコア比較」。表示専用・色による閾値分類は持たない）────

export interface StockCompareRow {
  readonly code: string
  readonly name: string
  readonly locked: boolean
  readonly decisionLabel: string
  readonly decision: DisplayDecision
  readonly scoreLabel: string
  readonly pnlLabel: string
  readonly rsiLabel: string
  readonly rankLabel: string
}

export function projectCompareRows(rows: readonly StockRowViewModel[]): StockCompareRow[] {
  return rows.map(r => ({
    code: r.code,
    name: r.name,
    locked: r.locked,
    decisionLabel: r.decisionLabel,
    decision: r.decision,
    scoreLabel: r.score === null ? '—' : String(r.score),
    pnlLabel: r.pnlLabel,
    rsiLabel: r.rsiLabel,
    rankLabel: r.strategyRank ?? '—',
  }))
}

// ── 詳細 ──────────────────────────────────────────────────────

export interface LabeledValue { readonly label: string; readonly value: string }

export type RowTone = 'positive' | 'neutral' | 'negative'

export interface AnalysisRow {
  readonly label: string
  readonly value: string
  readonly evalLabel: string
  readonly reason: string
  readonly tone: RowTone
}

export interface AxisScore {
  readonly label: string
  readonly value: number
  readonly reason: string
}

export interface StockAnalysisViewModel {
  /** 8 軸（0–100 に正規化した観察値）。 */
  readonly axes: readonly AxisScore[]
  readonly keyMetrics: readonly { readonly label: string; readonly value: string; readonly evalLabel: string; readonly tone: RowTone }[]
  readonly fundamentals: readonly AnalysisRow[]
  readonly technicals: readonly (AnalysisRow & { readonly signal: 'bull' | 'bear' | 'neutral' })[]
}

export interface StockDetailFound {
  readonly found: true
  readonly code: string
  readonly name: string
  readonly sectorLine: string
  readonly relationshipLabel: string
  readonly analysisAtLabel: string | null
  readonly currentPriceLabel: string | null

  readonly decision: DisplayDecision
  readonly decisionLabel: string
  readonly tone: StockDecisionTone
  readonly insufficient: boolean
  readonly stance: string
  readonly recommendedAction: string
  readonly comment: string
  readonly conclusionTitle: string
  readonly conclusionText: string
  readonly highlight: string | null
  readonly caution: string | null
  readonly premiseBreak: readonly string[]
  /** null = 分析結果なし（判定不能。「非通過」とは区別する）。 */
  readonly riskGate: { readonly pass: boolean; readonly label: string; readonly sub: string } | null
  readonly confidenceLabel: string | null
  readonly score: number | null
  readonly rank: StrategyRank | null

  readonly constraints: readonly { readonly id: string; readonly title: string; readonly text: string }[]
  readonly locked: boolean
  readonly lockNote: { readonly title: string; readonly text: string } | null
  readonly lockReleasedNote: string | null
  readonly stopLossNote: { readonly title: string; readonly text: string } | null

  readonly position: readonly LabeledValue[]
  readonly executionPlan: {
    readonly targetPriceLabel: string
    readonly targetSub: string | null
    readonly alertPriceLabel: string
    readonly alertSub: string | null
    readonly takeProfit: string | null
    readonly stopLoss: string | null
  }
  readonly reasons: {
    readonly bull: readonly string[]
    readonly bear: readonly string[]
    readonly entry: readonly string[]
    readonly takeProfit: readonly string[]
    readonly stopLoss: readonly string[]
    readonly wait: readonly string[]
  }
  readonly portfolioRole: { readonly headline: string; readonly sectorLine: string; readonly concentration: string | null }
  readonly portfolioStanding: { readonly summary: string; readonly text: string }

  readonly candidate: StockCandidateRowViewModel | null
  readonly evidence: readonly { readonly label: string; readonly value: string }[]
  readonly evidenceNote: string | null
  readonly holdingsStale: boolean

  /** null = 分析結果なし。 */
  readonly analysis: StockAnalysisViewModel | null
  readonly phase7: StockScoreRecord | null
}

export type StockDetailViewModel = StockDetailFound | { readonly found: false; readonly code: string }

// 旧 T1 の officialAction → 表示テキスト（移設）。
function officialActionText(oa: OfficialDecisionItem): string {
  if (oa.action === 'BUY') return `公式判断: 買い候補 — ${oa.reason}`
  if (oa.action === 'SELL') return `公式判断: 売却確認 — ${oa.reason}`
  if (oa.action === 'HOLD') return `公式判断: 継続保有 — ${oa.reason}`
  if (oa.action === 'WAIT') return `公式判断: 待機 — ${oa.reason}`
  if (oa.action === 'MONITOR') return `公式判断: 監視強化 — ${oa.reason}`
  if (oa.action === 'BLOCKED') return `公式判断: 新規買い停止 — ${oa.blockedReason ?? oa.reason}`
  if (oa.action === 'DATA_WAIT') return `公式判断: データ更新待ち — ${oa.reason}`
  return oa.reason
}

const num = (n: number) => n.toLocaleString('ja-JP')
const tone3 = (positive: boolean, negative: boolean): RowTone => (positive ? 'positive' : negative ? 'negative' : 'neutral')

/** 旧 T1 詳細のファンダメンタル / テクニカル / 8 軸の行（数式・閾値・文言は移設。新しい評価は作らない）。 */
export function buildStockAnalysis(h: Holding, a: HoldingAnalysis): StockAnalysisViewModel {
  const debate = a.debate
  const fundaRows: AnalysisRow[] = [
    {
      label: '稼ぐ力 — ROE',
      value: `${h.roe}%`,
      evalLabel: h.roe >= 15 ? '高収益' : h.roe >= 8 ? '標準' : '低収益',
      reason: h.roe >= 15 ? '資本効率が高く、利益創出力が強い' : h.roe >= 8 ? '平均的な収益性を維持' : '収益力の改善が課題',
      tone: tone3(h.roe >= 15, h.roe < 8),
    },
    {
      label: '成長性 — EPS成長率',
      value: `${h.epsG >= 0 ? '+' : ''}${h.epsG}%`,
      evalLabel: h.epsG >= 15 ? '高成長' : h.epsG >= 5 ? '増益' : h.epsG >= 0 ? '横ばい' : '減益',
      reason: h.epsG >= 15 ? '二桁増益継続、将来性が高い' : h.epsG >= 5 ? '安定した利益成長が続く' : h.epsG >= 0 ? '成長鈍化、横ばい推移' : 'EPS減少は前提崩れのリスク',
      tone: tone3(h.epsG >= 5, h.epsG < 0),
    },
    {
      label: '割安度 — PER',
      value: h.per > 0 ? `${h.per.toFixed(1)}倍` : '—',
      evalLabel: h.per > 0 && h.per <= 15 ? '割安' : h.per > 0 && h.per <= 25 ? '適正' : h.per > 40 ? '割高' : '—',
      reason: h.per > 0 && h.per <= 15 ? 'バリュー水準、PER低め' : h.per > 0 && h.per <= 25 ? '業種比較で適正水準' : h.per > 40 ? '高PER、期待先行に注意' : 'PERデータなし',
      tone: tone3(h.per > 0 && h.per <= 15, h.per > 40),
    },
    {
      label: '割安度 — PBR',
      value: h.pbr > 0 ? `${h.pbr.toFixed(2)}倍` : '—',
      evalLabel: h.pbr > 0 && h.pbr < 1 ? '解散価値以下' : h.pbr <= 1.5 ? '低PBR' : h.pbr <= 3 ? '標準' : '割高',
      reason: h.pbr > 0 && h.pbr < 1 ? '株価が純資産を下回る。資本効率改善期待' : h.pbr <= 1.5 ? '比較的低PBR、割安感あり' : h.pbr <= 3 ? '標準的なPBR水準' : '高PBR、成長期待を反映',
      tone: tone3(h.pbr > 0 && h.pbr < 1.5, h.pbr > 4),
    },
    {
      label: '安全性 — D/Eレシオ',
      value: `${h.de.toFixed(1)}倍`,
      evalLabel: h.de <= 0.5 ? '無借金' : h.de <= 1.0 ? '健全' : h.de <= 3.0 ? '標準' : '高レバ',
      reason: h.de <= 0.5 ? '財務体質が非常に堅固' : h.de <= 1.0 ? '健全な財務バランスを維持' : h.de <= 3.0 ? '業種平均的な負債水準' : '高負債比率、金利上昇リスクあり',
      tone: tone3(h.de <= 1.0, h.de > 3.0),
    },
    {
      label: '安全性 — CF良否',
      value: h.cfOk ? '良好' : '要確認',
      evalLabel: h.cfOk ? '本業安定' : '注意',
      reason: h.cfOk ? '本業での現金創出力が確認できる' : 'CF改善余地あり、利益の質を要確認',
      tone: h.cfOk ? 'positive' : 'negative',
    },
    {
      label: '株主還元 — 配当成長率',
      value: `${h.divG >= 0 ? '+' : ''}${h.divG}%`,
      evalLabel: h.divG >= 8 ? '高成長還元' : h.divG >= 3 ? '安定成長' : h.divG >= 0 ? '横ばい' : '減配',
      reason: h.divG >= 8 ? '配当を継続増配、株主還元姿勢が優れる' : h.divG >= 3 ? '着実な増配実績あり' : h.divG >= 0 ? '配当維持、特段の変化なし' : '減配は株主還元姿勢の後退を示す',
      tone: tone3(h.divG >= 3, h.divG < 0),
    },
    {
      label: '事業の強さ — 品質スコア',
      value: `${a.qualityScore} / 10`,
      evalLabel: a.qualityScore >= 8 ? '高品質' : a.qualityScore >= 5 ? '標準' : '要改善',
      reason: `セクター: ${h.sector}${h.mitsu ? ' (三菱Gグループ)' : ''} / β ${h.beta.toFixed(2)}`,
      tone: tone3(a.qualityScore >= 7, a.qualityScore < 4),
    },
  ]

  const techRows: Array<AnalysisRow & { signal: 'bull' | 'bear' | 'neutral' }> = [
    {
      label: '中期トレンド',
      value: h.ma && h.macd ? 'MA上位 + MACD陽転' : h.ma ? 'MA上位のみ' : h.macd ? 'MACD陽転のみ' : 'MA下位 + MACD陰転',
      evalLabel: h.ma && h.macd ? '強気' : h.ma || h.macd ? '中立' : '弱気',
      reason: h.ma && h.macd ? '移動平均線上位+MACDが上向き。上昇トレンド継続' : !h.ma && !h.macd ? 'MA下位・MACD陰転。下降トレンドに注意' : 'トレンド混在。方向感確認が必要',
      signal: h.ma && h.macd ? 'bull' : !h.ma && !h.macd ? 'bear' : 'neutral',
      tone: 'neutral',
    },
    {
      label: '短期トレンド — RSI',
      value: `RSI ${h.rsi.toFixed(0)}`,
      evalLabel: h.rsi < 30 ? '売られすぎ' : h.rsi <= 65 ? '適正圏' : '買われすぎ',
      reason: h.rsi < 30 ? 'RSI低水準。短期反転の可能性あり' : h.rsi <= 65 ? '過熱感なく安定した水準' : 'RSI高水準。短期調整に注意',
      signal: h.rsi < 30 ? 'neutral' : h.rsi > 75 ? 'bear' : 'bull',
      tone: 'neutral',
    },
    {
      label: 'モメンタム — 3M',
      value: formatSignedPct(h.mom3m, 1),
      evalLabel: h.mom3m > 8 ? '強い上昇' : h.mom3m > 0 ? 'プラス圏' : h.mom3m > -5 ? '弱含み' : '下降圧力',
      reason: h.mom3m > 8 ? '直近3ヶ月で強い上昇モメンタム。トレンドフォロー有利' : h.mom3m < -5 ? '3ヶ月下落継続。底打ち確認まで慎重' : '緩やかな値動き',
      signal: h.mom3m > 0 ? 'bull' : h.mom3m < -5 ? 'bear' : 'neutral',
      tone: 'neutral',
    },
    {
      label: '出来高',
      value: h.vol ? '増加傾向' : '通常水準',
      evalLabel: h.vol ? '需給改善' : '変化なし',
      reason: h.vol ? '出来高増加は機関参入の可能性。需給改善シグナル' : '通常の出来高水準、特段の動きなし',
      signal: h.vol ? 'bull' : 'neutral',
      tone: 'neutral',
    },
    {
      label: 'サポート / レジスタンス',
      value: h.currentPrice ? `現値 ${num(h.currentPrice)}円` : `評価額 ${formatJPYAuto(h.eval)}`,
      evalLabel: `目標 ${num(h.target)}円`,
      reason: `アラートライン ${num(h.alert)}円。このラインを下回ったら損切り検討`,
      signal: 'neutral',
      tone: 'neutral',
    },
    {
      label: '過熱感',
      value: h.rsi > 75 ? '過熱' : h.rsi < 35 ? '割安感あり' : '正常',
      evalLabel: h.rsi > 75 ? '注意' : h.rsi < 35 ? 'チャンス' : '良好',
      reason: `RSI ${h.rsi.toFixed(0)} — ${h.rsi > 75 ? '高水準での追加購入は短期リスクが高い' : '過熱感なし'}`,
      signal: h.rsi > 75 ? 'bear' : h.rsi < 35 ? 'bull' : 'neutral',
      tone: 'neutral',
    },
    {
      label: '需給',
      value: `含み損益 ${formatSignedPct(h.pnlPct)}`,
      evalLabel: h.vol && h.pnlPct > 5 ? '良好' : h.pnlPct < -10 ? '悪化' : '中立',
      reason: h.pnlPct > 20 ? '大きな含み益あり。一部利確の検討も' : h.pnlPct < -15 ? '含み損拡大。損切りラインを要確認' : '需給は比較的安定',
      signal: h.vol && h.pnlPct > 5 ? 'bull' : h.pnlPct < -10 ? 'bear' : 'neutral',
      tone: 'neutral',
    },
  ]

  // 8 軸（0–100 正規化）。値の作り方は旧 T1 と同一。
  const axisValues = [
    debate.sevenAxis.valuation,
    a.fundamentalScore / 30 * 100,
    debate.sevenAxis.growth,
    a.qualityScore / 10 * 100,
    debate.sevenAxis.momentum,
    a.technicalScore / 20 * 100,
    Math.min(100, Math.max(0, h.divG * 12 + 50)),
    debate.sevenAxis.quality,
  ]
  const axisReasons = [
    `PER: ${fundaRows[2].value} — ${fundaRows[2].reason}。PBR: ${fundaRows[3].value} — ${fundaRows[3].reason}`,
    `ROE ${fundaRows[0].value} — ${fundaRows[0].reason}`,
    `EPS成長率 ${fundaRows[1].value} — ${fundaRows[1].reason}`,
    `D/Eレシオ ${fundaRows[4].value} — ${fundaRows[4].reason}。CF: ${fundaRows[5].value}`,
    `${techRows[0].value} — ${techRows[0].reason}`,
    `${techRows[6].value} — ${techRows[6].reason}`,
    `配当成長率 ${fundaRows[6].value} — ${fundaRows[6].reason}`,
    fundaRows[7].reason,
  ]
  const axisLabels = ['割安度', '稼ぐ力', '成長性', '安全性', 'トレンド', '需給', '還元力', '事業独自性']
  const axes = axisLabels.map((label, i) => ({ label, value: axisValues[i], reason: axisReasons[i] }))

  const keyMetrics = [
    { label: 'PER', value: fundaRows[2].value, evalLabel: fundaRows[2].evalLabel, tone: fundaRows[2].tone },
    { label: 'PBR', value: fundaRows[3].value, evalLabel: h.pbr > 0 && h.pbr < 1 ? '割安' : fundaRows[3].evalLabel, tone: fundaRows[3].tone },
    { label: 'ROE', value: fundaRows[0].value, evalLabel: fundaRows[0].evalLabel, tone: fundaRows[0].tone },
    { label: 'EPS成長', value: fundaRows[1].value, evalLabel: fundaRows[1].evalLabel, tone: fundaRows[1].tone },
    { label: 'D/Eレシオ', value: fundaRows[4].value, evalLabel: fundaRows[4].evalLabel, tone: fundaRows[4].tone },
    { label: '配当成長', value: fundaRows[6].value, evalLabel: fundaRows[6].evalLabel, tone: fundaRows[6].tone },
  ]

  return { axes, keyMetrics, fundamentals: fundaRows, technicals: techRows }
}

function stanceText(d: DisplayDecision): string {
  switch (d) {
    case 'INSUFFICIENT_EVIDENCE': return '判断材料不足 / 再評価待ち'
    case 'BUY': return '積極保有 / 追加検討'
    case 'SELL': return '売却推奨 / 条件確認'
    case 'DATA_WAIT': return 'データ更新待ち / シグナル参考値のみ'
    case 'WAIT': return '待機 / 条件未達'
    default: return '継続保有 / 様子見'
  }
}

function conclusionTitleOf(d: DisplayDecision): string {
  switch (d) {
    case 'BUY': return '中長期で有望'
    case 'INSUFFICIENT_EVIDENCE': return '判断材料不足'
    case 'SELL': return '売却を検討'
    case 'DATA_WAIT': return 'データ更新待ち'
    case 'WAIT': return '待機（見送り）'
    default: return '現状維持'
  }
}

const isBuySignal = (h: Holding) => h.decision === 'BUY'

function projectConstraints(h: Holding, d: DisplayDecision, ctx: DecisionContext): StockDetailFound['constraints'] {
  const out: Array<StockDetailFound['constraints'][number]> = []
  if (d === 'INSUFFICIENT_EVIDENCE') {
    out.push({ id: 'insufficient', title: '判断材料不足', text: '分析データが揃っていないため、この銘柄の売買判断は行いません（他の銘柄・全体の状態には影響しません）。' })
  }
  if (ctx.dqSuppressed && isBuySignal(h)) {
    out.push({ id: 'data_quality', title: '更新待ち', text: 'データ品質低下のため新規買いを抑制中です。シグナルは参考値のみです。' })
  }
  if (ctx.safeModeActive && isBuySignal(h)) {
    out.push({ id: 'safe_mode', title: 'SAFE_MODE', text: 'SAFE_MODE発動中のため新規買付は停止しています。分析・レビューは有効で、解除後に再判定されます。' })
  }
  if (ctx.capExceeded && isBuySignal(h)) {
    out.push({ id: 'cap_exceeded', title: '国内個別株の上限', text: '国内個別株の上限超過のため新規買付は停止しています。上限が解消されると再判定されます。' })
  }
  // 売却ロックは lockNote（取得日 / 売却可能予定日）として別枠で表示する（ここでは重複させない）。
  return out
}

function commentText(h: Holding, a: HoldingAnalysis | undefined, d: DisplayDecision, locked: boolean, unlockDate: string | null, ctx: DecisionContext, officialAction: OfficialDecisionItem | undefined): string {
  const debate = a?.debate
  if (d === 'INSUFFICIENT_EVIDENCE') return '判断材料不足 — ファンダメンタル・テクニカル取得後に再評価します。'
  if (d === 'DATA_WAIT') return 'データ更新待ち — データ品質低下のため新規買いを抑制中。シグナルは参考値のみです。'
  if (ctx.safeModeActive && h.decision === 'BUY') {
    return officialAction?.blockedReason ?? `${h.name} はSAFE_MODE発動中のため新規買付停止中（待機）。解除後に再判定されます。`
  }
  if (debate?.recommendedAction) return debate.recommendedAction
  if (d === 'BUY') return `${h.name} は買いシグナルです。投資妙味・リスク条件を確認してください。`
  if (d === 'SELL') return `${h.name} は売却シグナルです。損切・利確条件を確認してください。`
  if (d === 'WAIT') {
    if (ctx.capExceeded && h.decision === 'BUY') {
      return `${h.name} は国内個別株上限超過のため新規買付停止中（待機）。上限が解消されると再判定されます。必要ならその他 › 設定で方針比率を見直せます。`
    }
    if (locked) {
      return `${h.name} は3ヶ月売却ロック中のため売却不可（待機）。${unlockDate ? `${unlockDate}以降に再判定します。` : '解除後に再判定します。'}`
    }
    return `${h.name} は待機判定です。条件未達のため次のシグナルを待ちます。`
  }
  return `${h.name} は保有継続シグナルです。継続監視をお勧めします。`
}

function recommendedActionText(h: Holding, a: HoldingAnalysis | undefined, d: DisplayDecision, ctx: DecisionContext, officialAction: OfficialDecisionItem | undefined): string {
  if (d === 'INSUFFICIENT_EVIDENCE') return '判断材料不足 — 売買判断を行わず、データ取得後に再評価。'
  if (ctx.dqSuppressed && h.decision === 'BUY') return 'データ更新待ち — データ品質低下のため新規買いを抑制中。シグナルは参考値のみ。'
  if (officialAction != null) return officialActionText(officialAction)
  if (ctx.safeModeActive && h.decision === 'BUY') return 'SAFE_MODE発動中 — 新規買付停止。解除後に再判定されます。'
  return a?.debate.recommendedAction ?? '—'
}

function standingText(h: Holding, d: DisplayDecision, ctx: DecisionContext): string {
  if (d === 'BUY') return '積極的に保有継続。追加余地あり。'
  if (d === 'INSUFFICIENT_EVIDENCE') return '判断材料不足。売買判断は行わず、取得後に再評価してください。'
  if (d === 'DATA_WAIT') return '最新データ取得後に再判定してください。'
  if (d === 'SELL') return '売却を検討してください。損切・利確条件を確認してください。'
  if (d === 'WAIT') {
    if (ctx.safeModeActive && h.decision === 'BUY') return 'SAFE_MODE発動中 — 新規買付停止。解除後に再判定されます。'
    if (ctx.capExceeded && h.decision === 'BUY') {
      return '国内個別株上限超過のため新規買付停止（待機）。上限超過が解消されると再判定されます。必要ならその他 › 設定で方針比率を見直せます。'
    }
    return '待機。ロック制約または条件未達のため、次のシグナルを待ちます。'
  }
  return '現状維持。次のシグナルを待つ。'
}

const nonEmpty = (xs: readonly string[] | undefined): string[] => (xs ?? []).filter(Boolean)

export interface StockDetailInputs {
  readonly code: string
  readonly holdings: readonly Holding[]
  readonly analysis: readonly HoldingAnalysis[]
  readonly stockScores6Axis: readonly StockScoreRecord[] | null
  readonly decisionContext: DecisionContext
  readonly analysisLastRunAt: string | null
  readonly holdingsStale: boolean
  readonly synthesis: CandidateDecisionSynthesisSnapshot | null
  readonly rawCandidates: readonly StockCandidateItem[]
  readonly heroState: HeroState
}

export function assembleStockDetail(i: StockDetailInputs): StockDetailViewModel {
  const h = i.holdings.find(x => x.code === i.code)
  if (!h) return { found: false, code: i.code }
  const a = i.analysis.find(x => x.code === i.code)
  const ctx = i.decisionContext
  const { decision, locked, officialAction } = decisionOf(h, ctx)
  const unlockDate = getSellableDate(h)
  const debate = a?.debate
  const insufficient = decision === 'INSUFFICIENT_EVIDENCE'
  const stopLossWarning = h.pnlPct <= TIER_A_T1_STOP_LOSS_PCT

  const entry = candidatePresentationSequence(i.synthesis).find(e => e.code === h.code)
  const rawByCode = new Map(i.rawCandidates.map(c => [c.code, c]))

  const priceOk = h.currentPrice != null && h.currentPrice > 0
  const bull = nonEmpty(debate?.bullReasons)
  const bear = nonEmpty(debate?.bearReasons)
  const buy = nonEmpty(debate?.buyReasons)
  const tp = nonEmpty(debate?.takeProfitConditions)
  const sl = nonEmpty(debate?.stopLossConditions)

  const fundamentalsKnown = h.metadataStatus?.fundamentals === 'known'
  const technicalsKnown = h.metadataStatus?.technicals === 'known'

  return {
    found: true,
    code: h.code,
    name: h.name,
    sectorLine: `${h.sector}${h.mitsu ? ' / 三菱G' : ''} / β ${h.beta.toFixed(2)}`,
    relationshipLabel: STOCK_ROW_RELATIONSHIP_LABEL,
    analysisAtLabel: formatJstMonthDayTime(i.analysisLastRunAt),
    currentPriceLabel: h.currentPrice != null ? `${num(h.currentPrice)}円` : null,

    decision,
    decisionLabel: STOCK_DECISION_LABEL[decision],
    tone: stockDecisionTone(decision),
    insufficient,
    stance: stanceText(decision),
    recommendedAction: recommendedActionText(h, a, decision, ctx, officialAction),
    comment: commentText(h, a, decision, locked, unlockDate, ctx, officialAction),
    conclusionTitle: conclusionTitleOf(decision),
    conclusionText: insufficient
      ? 'ファンダメンタル・テクニカル取得後に再評価してください。'
      : decision === 'DATA_WAIT'
        ? 'データ品質低下のためシグナルは参考値のみです。最新データ取得後に再判定してください。'
        : debate?.buyReasons?.[0] ?? (
          decision === 'BUY' ? '現在の水準では投資妙味あり'
            : decision === 'SELL' ? '損切・利確条件を確認してください'
              : '継続監視をお勧めします'
        ),
    highlight: debate?.bullReasons?.[0] ?? null,
    caution: debate?.bearReasons?.[0] ?? null,
    premiseBreak: nonEmpty(debate?.premiseBreakConditions),
    riskGate: debate === undefined
      ? null
      : debate.riskGatePass
        ? { pass: true, label: '通過 — 実行可', sub: '実行条件を充足' }
        : { pass: false, label: '非通過 — 実行抑制', sub: '追加リスク確認が必要' },
    confidenceLabel: a ? `${(a.confidence * 100).toFixed(0)}%` : null,
    score: insufficient ? null : (a?.totalScore ?? null),
    rank: insufficient ? null : (a?.strategyRank ?? null),

    constraints: projectConstraints(h, decision, ctx),
    locked,
    lockNote: locked && unlockDate
      ? { title: '3ヶ月制約中 — 売却不可', text: `売却可能予定日: ${unlockDate} / 取得日: ${h.acquiredAt ?? '—'}` }
      : null,
    lockReleasedNote: h.lock && !locked ? `ロック期間終了 — 売却可能です（取得日: ${h.acquiredAt ?? '—'}）` : null,
    stopLossNote: stopLossWarning
      ? {
        title: `TierA T1警告 — 含み損 ${formatSignedPct(h.pnlPct)}（-40%以下）`,
        text: `強制売却ルール対象。ただし最終判断は人間が行う（自動売却は行いません）。${locked ? '3ヶ月ロック中でもこの警告は表示され続けます。' : ''}`,
      }
      : null,

    position: [
      { label: '評価額', value: formatJPYAuto(h.eval) },
      { label: '損益率', value: formatSignedPct(h.pnlPct) },
      { label: '3Mモメンタム', value: formatSignedPct(h.mom3m, 1) },
      { label: 'EV', value: formatSignedPct(h.ev * 100, 1) },
      { label: 'RSI', value: h.rsi.toFixed(0) },
      { label: 'β（ベータ）', value: h.beta.toFixed(2) },
    ],
    executionPlan: {
      targetPriceLabel: `${num(h.target)}円`,
      targetSub: priceOk ? `${((h.target / (h.currentPrice as number) - 1) * 100).toFixed(1)}% 上昇余地` : null,
      alertPriceLabel: `${num(h.alert)}円`,
      alertSub: priceOk ? `${((h.alert / (h.currentPrice as number) - 1) * 100).toFixed(1)}% 下落で発動` : null,
      takeProfit: tp[0] ?? null,
      stopLoss: sl[0] ?? null,
    },
    reasons: {
      bull, bear, entry: buy, takeProfit: tp, stopLoss: sl, wait: nonEmpty(debate?.waitReasons),
    },
    portfolioRole: {
      headline: h.beta >= 1.2
        ? '高ベータ成長株 — ブル相場での収益牽引役として積極保有'
        : h.beta <= 0.8
          ? 'ディフェンシブ株 — 下落局面での損失抑制役として重要'
          : '標準ベータ株 — バランス型のコアポジション',
      sectorLine: `セクター: ${h.sector} / β ${h.beta.toFixed(2)}`,
      concentration: h.mitsu ? '三菱Gグループ — 集中リスクあり（40%超でリバランス検討）' : null,
    },
    portfolioStanding: {
      summary: `評価額 ${formatJPYAuto(h.eval)} / 損益 ${formatSignedPct(h.pnlPct)}`,
      text: standingText(h, decision, ctx),
    },

    candidate: entry === undefined ? null : projectCandidateEntry(entry, rawByCode, i.heroState),
    evidence: [
      { label: 'ファンダメンタル', value: fundamentalsKnown ? '取得済み' : '未取得' },
      { label: 'テクニカル', value: technicalsKnown ? '取得済み' : '未取得' },
      { label: '分析実行', value: formatJstMonthDayTime(i.analysisLastRunAt) ?? UNAVAILABLE_LABEL },
    ],
    evidenceNote: insufficient
      ? '取得できていない項目があるため、以下の分析値は参考表示です。売買判断には使われません。'
      : null,
    holdingsStale: i.holdingsStale,

    analysis: a ? buildStockAnalysis(h, a) : null,
    phase7: i.stockScores6Axis?.find(r => r.ticker === h.code) ?? null,
  }
}

export function selectStockDetailViewModel(state: AppState, code: string, now: number = Date.now()): StockDetailViewModel {
  return assembleStockDetail({
    code,
    holdings: state.holdings,
    analysis: state.analysis,
    stockScores6Axis: state.stockScores6Axis,
    decisionContext: gatherDecisionContext(state, now),
    analysisLastRunAt: state.system.analysisLastRunAt,
    holdingsStale: computeHoldingsStale(state.system),
    synthesis: selectCandidateDecisionSynthesis(state),
    rawCandidates: state.candidatesStocks.candidates,
    heroState: resolveHeroState(state, now),
  })
}
