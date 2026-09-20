// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: T0（今日）の view-model projector。
//
//   canonical selectors / snapshots → この projector → React（TodayHomeView）
//
// このファイルは「どの canonical 権限を、どの表示状態に写像するか」だけを持つ。
// 新しい投資判断・ランキング・金額・閾値は一切作らない（second decision engine 禁止）。
//
//  Hero 権限        : OfficialDecision（headline を verbatim）。副文は承認済み
//                     projection が無いため headline 単独が既定。
//  市場レジーム     : AllocationConsumerSnapshot.regime（3値）
//  運用モード       : AllocationConsumerSnapshot.marketMode（レジームとは結合しない）
//  候補             : CandidateDecisionSynthesis（decisions → watchList、先頭3件）
//  実行可能現金     : selectExecutableDeployableCash（unavailable を ¥0 に変換しない）
//  ポートフォリオ   : AllocationConsumerSnapshot.classes（canonical 順）
//  SAFE_MODE        : selectEffectiveSafeModeActive + safe_mode snapshot
//
// Hero 状態の優先順位（上から最初に該当したもの）:
//   boot > decision_unavailable > safe_mode > data_wait > normal
//
// decision_unavailable は「今日の判断を作れない」だけで、他の権限の無効を意味しない。
// Hero だけが状態を変え、各節は自分の権限が生きている限りそのまま残る
// （節ごとの利用不可は、その節の中で局所的に出す）。候補の実行提示だけは抑止する。
// ═══════════════════════════════════════════════════════════
import type { AppState, Holding, OfficialDecision, SystemState } from '../../types'
import type { AllocationConsumerSnapshot } from '../../types/allocationConsumer'
import type { CandidateDecisionSynthesisSnapshot } from '../../types/candidateDecisionSynthesis'
import {
  selectAllocationConsumerSnapshot,
  selectExecutableDeployableCash,
  type ExecutableDeployableCash,
} from '../../store/allocationConsumerSelectors'
import {
  selectCandidateDecisionSynthesis,
  selectEffectiveCashAssumptions,
  selectEffectiveSafeModeActive,
  selectMarketDataQuality,
  type EffectiveCashAssumptions,
} from '../../store/selectors'
import { getSellableDate, isSellLocked } from '../../domain/constraints/stockLock'
import {
  DATA_WAIT_ROW_LABEL,
  HOME_TIER_LABEL,
  MARKET_REGIME_LABEL,
  OPERATION_MODE_LABEL,
  UNAVAILABLE_LABEL,
  UNDETERMINABLE_LABEL,
} from './labels'
import {
  formatJstMonthDayTime,
  formatMonthDay,
} from './formatters'
import { projectPortfolio, type PortfolioProjection } from './portfolioPresentation'
import {
  projectCandidateSection,
  type CandidateProjectionContext,
  type CandidateSectionProjection,
} from './candidatePresentation'

export type HeroState = 'boot' | 'decision_unavailable' | 'safe_mode' | 'data_wait' | 'normal'
export type HeroTone = 'calm' | 'warm' | 'neutral' | 'critical'
export type HeroCtaTarget = 'audit'

export interface HeroViewModel {
  readonly state: HeroState
  readonly tone: HeroTone
  /** 「今日の判断」または「今日の状態」。 */
  readonly eyebrow: string
  readonly headline: string
  /** 承認済み projection が無い限り null（headline 単独で成立）。 */
  readonly secondaryCopy: string | null
  /** DATA_WAIT の誤読防止注記（HOLD / 弱気 / 売却ではない）。 */
  readonly guardNote: string | null
  /** SAFE MODE 帯を出すか。 */
  readonly safeModeBanner: boolean
  readonly cta: { readonly label: string; readonly target: HeroCtaTarget } | null
  readonly generatedAtLabel: string | null
}

export interface StateChip {
  /** 表示語。canonical が利用できない場合は「判定不能」。 */
  readonly label: string
  readonly available: boolean
}

/** 凍結デスクトップ状態ブロックの 4 セル目。候補の projection 済みの値のみを再掲する。 */
export interface CandidateStateChip extends StateChip {
  /** 2 行目（例: 「3 要レビュー」）。1 行で足りるときは null。 */
  readonly sub: string | null
}

export type AttentionGlyph = 'safe' | 'lock' | 'info'

export interface AttentionItem {
  readonly id: string
  readonly glyph: AttentionGlyph
  readonly title: string
  readonly detail: string
}

export type DataStatusMark = 'ok' | 'wait'

export interface DataStatusRow {
  readonly id: string
  readonly label: string
  readonly mark: DataStatusMark
  /** 絶対時刻（JST）または「利用不可」。全体の「正常」にはまとめない。 */
  readonly value: string
}

export type DeployableCashViewModel =
  | { readonly kind: 'available'; readonly amountJpy: number }
  | { readonly kind: 'unavailable' }

export type GrossCashViewModel =
  | { readonly kind: 'known'; readonly amountJpy: number }
  | { readonly kind: 'unknown' }

export interface MarketIndicator {
  readonly id: 'nikkei' | 'sp500' | 'vix' | 'nikkeiVi'
  readonly label: string
  readonly value: number | null
  readonly changePct: number | null
}

export interface MarketViewModel {
  readonly indicators: readonly MarketIndicator[]
  readonly asOfLabel: string | null
}

export interface TodayHomeViewModel {
  readonly hero: HeroViewModel
  /** decision_unavailable / boot では null（design M2-D はチップ列を出さない）。 */
  readonly chips: {
    readonly regime: StateChip
    readonly mode: StateChip
    readonly attentionCount: number
    /** 凍結デスクトップ 4 セル目（候補の状態）。新しい業務指標は作らない。 */
    readonly candidates: CandidateStateChip
  } | null
  readonly attention: readonly AttentionItem[]
  /** DATA_WAIT のときだけ non-empty（データセット別の鮮度）。 */
  readonly dataStatus: readonly DataStatusRow[]
  readonly candidates: CandidateSectionProjection
  readonly deployableCash: DeployableCashViewModel
  readonly grossCash: GrossCashViewModel
  /** null = 配分スナップショット利用不可（判定不能）。 */
  readonly portfolio: PortfolioProjection | null
  readonly market: MarketViewModel
  /** decision_unavailable 用: 利用できない / 安全に確認できる情報。 */
  readonly unavailableDetail: {
    readonly unavailable: readonly { id: string; label: string; value: string }[]
    readonly available: readonly { id: string; label: string; value: string | null }[]
  } | null
}

const NO_CANDIDATES: CandidateSectionProjection = {
  status: 'unavailable', rows: [], totalCount: 0, executableCount: 0, reviewCount: 0,
}

export function heroCopy(state: HeroState): Pick<HeroViewModel, 'eyebrow' | 'headline' | 'secondaryCopy' | 'guardNote' | 'cta'> | null {
  switch (state) {
    case 'safe_mode':
      return {
        eyebrow: '今日の判断',
        headline: '新規買付を停止しています',
        secondaryCopy: '運用は継続しています。',
        guardNote: null,
        cta: { label: '原因を見る', target: 'audit' },
      }
    case 'data_wait':
      return {
        eyebrow: '今日の状態',
        headline: 'データ更新待ち',
        secondaryCopy: '新規実行に必要なデータを確認しています。',
        guardNote: 'これは「様子見（HOLD）」でも弱気でも売却でもありません。',
        cta: { label: '状況を見る', target: 'audit' },
      }
    case 'decision_unavailable':
      return {
        eyebrow: '今日の状態',
        headline: '判断結果を利用できません',
        secondaryCopy: '今日の判断を取得できていません。過去の判断は現在のものとして扱いません。',
        guardNote: null,
        cta: { label: '原因を確認する', target: 'audit' },
      }
    default:
      return null
  }
}

function heroToneFor(state: HeroState): HeroTone {
  return state === 'safe_mode' ? 'warm'
    : state === 'data_wait' ? 'neutral'
    : state === 'decision_unavailable' ? 'critical'
    : 'calm'
}

/** OfficialDecision が「Hero の権限として使える」か。null / headline 空は利用不可。 */
export function isOfficialDecisionUsable(decision: OfficialDecision | null): decision is OfficialDecision {
  return decision !== null && typeof decision.headline === 'string' && decision.headline.trim() !== ''
}

// ── 入力（canonical 権限の読み取り結果）──────────────────────────
// state から集める層（gatherTodayHomeInputs）と、純粋に組み立てる層
// （assembleTodayHomeViewModel）を分ける。後者は canonical 値だけを受け取り、
// store・時刻・selector に触れないため、テストと dev ハーネスが同じ組み立てを使える。
export interface TodayHomeInputs {
  /** 判定基準時刻（ms）。ロック判定・鮮度判定の now を注入する。 */
  readonly nowMs: number
  readonly systemStatus: SystemState['status']
  readonly officialDecision: OfficialDecision | null
  /** selectEffectiveSafeModeActive（raw OR fail-closed 鮮度）。 */
  readonly safeModeEffective: boolean
  readonly safeModeSource: { readonly loaded: boolean; readonly newBuysFrozen: boolean; readonly rebalanceFrozen: boolean }
  /** selectMarketDataQuality の実時間判定（全体データ品質）。 */
  readonly marketDataOk: boolean
  readonly allocation: AllocationConsumerSnapshot
  readonly deployableCash: ExecutableDeployableCash
  readonly synthesis: CandidateDecisionSynthesisSnapshot | null
  readonly holdings: readonly Pick<Holding, 'code' | 'acquiredAt' | 'lock'>[]
  readonly effectiveCash: Pick<EffectiveCashAssumptions, 'source' | 'grossCash'>
  readonly timestamps: {
    readonly market: string | null
    readonly candidates: string | null
  }
  readonly marketFeed: {
    readonly marketLoaded: boolean
    readonly macroLoaded: boolean
    readonly nikkeiViLoaded: boolean
    readonly nikkei: number | null
    readonly nikkeiChgPct: number | null
    readonly sp500: number | null
    readonly sp500ChgPct: number | null
    /** market.vix（米VIX） */
    readonly vix: number | null
    /** macro.nikkeiVI（日経VI）。vix とは別項目。 */
    readonly nikkeiVi: number | null
  }
}

export function resolveHeroStateFromInputs(i: Pick<TodayHomeInputs, 'systemStatus' | 'officialDecision' | 'safeModeEffective' | 'marketDataOk'>): HeroState {
  if (i.systemStatus === 'initializing') return 'boot'
  const decision = i.officialDecision
  if (!isOfficialDecisionUsable(decision)) return 'decision_unavailable'
  if (i.safeModeEffective) return 'safe_mode'
  const dqSuppressed = decision.stance === 'data_wait' || decision.dataQualitySuppressed || !i.marketDataOk
  return dqSuppressed ? 'data_wait' : 'normal'
}

export function resolveHeroState(state: AppState, now: number): HeroState {
  return resolveHeroStateFromInputs({
    systemStatus: state.system.status,
    officialDecision: state.officialDecision,
    safeModeEffective: selectEffectiveSafeModeActive(state, now),
    marketDataOk: !selectMarketDataQuality(state, now).isSuppressed,
  })
}

const finiteOrNull = (n: number | null | undefined): number | null =>
  (typeof n === 'number' && Number.isFinite(n) ? n : null)

export function gatherTodayHomeInputs(state: AppState, now: number): TodayHomeInputs {
  const ds = state.system.dataSourceStatus
  const ts = state.system.dataTimestamps
  const macro = state.macro
  const restrictions = state.safeMode.safe_mode.restrictions
  return {
    nowMs: now,
    systemStatus: state.system.status,
    officialDecision: state.officialDecision,
    safeModeEffective: selectEffectiveSafeModeActive(state, now),
    safeModeSource: {
      loaded: ds.safeMode === 'loaded',
      newBuysFrozen: restrictions.new_buys_frozen,
      rebalanceFrozen: restrictions.rebalance_frozen,
    },
    marketDataOk: !selectMarketDataQuality(state, now).isSuppressed,
    allocation: selectAllocationConsumerSnapshot(state),
    deployableCash: selectExecutableDeployableCash(state),
    synthesis: selectCandidateDecisionSynthesis(state),
    holdings: state.holdings,
    effectiveCash: selectEffectiveCashAssumptions(state),
    timestamps: {
      market: ts?.market ?? state.market.last_updated ?? null,
      candidates: ts?.candidateFunnel ?? ts?.candidatesStocks ?? null,
    },
    marketFeed: {
      marketLoaded: ds.market === 'loaded',
      macroLoaded: ds.macro === 'loaded',
      nikkeiViLoaded: ds.nikkeiVI === 'loaded',
      nikkei: finiteOrNull(state.market.nikkei),
      nikkeiChgPct: finiteOrNull(state.market.nikkeiChgPct),
      sp500: finiteOrNull(macro?.sp500),
      sp500ChgPct: finiteOrNull(macro?.sp500ChgPct),
      vix: finiteOrNull(state.market.vix),
      nikkeiVi: finiteOrNull(macro?.nikkeiVI),
    },
  }
}

function safeModeAttentionDetail(i: TodayHomeInputs): string {
  const { loaded, newBuysFrozen, rebalanceFrozen } = i.safeModeSource
  if (loaded && newBuysFrozen && rebalanceFrozen) return '新規買付・リバランスを停止中'
  return '新規買付を停止中'
}

/**
 * Home と Decision Audit が同じ候補提示文脈を使うための単一の写像。
 * 実行抑止の判定をふたつの場所で作らない。
 */
export function candidateProjectionContextFor(heroState: HeroState): CandidateProjectionContext {
  return {
    // 現在の判断が無い状態（decision_unavailable）では、canonical に EXECUTABLE でも
    // 実行提案として提示しない。判断が無いだけで候補の参照自体は残す。
    executionSuppressed: heroState === 'safe_mode' || heroState === 'decision_unavailable',
    dataWait: heroState === 'data_wait',
  }
}

export function projectAttention(i: TodayHomeInputs, heroState: HeroState, candidates: CandidateSectionProjection): AttentionItem[] {
  const items: AttentionItem[] = []
  // SAFE_MODE は自分の権限で成立する制約。Hero が別状態（判断不能）でも残す。
  if (i.safeModeEffective) {
    items.push({ id: 'safe-mode', glyph: 'safe', title: 'セーフモードが有効です', detail: safeModeAttentionDetail(i) })
  }
  if (heroState === 'data_wait') {
    items.push({ id: 'data-wait', glyph: 'info', title: '一部データの更新を待っています', detail: '鮮度はデータセットごとに扱います' })
  }
  if (candidates.status === 'unavailable') {
    items.push({ id: 'candidate-unavailable', glyph: 'info', title: '候補データを取得できていません', detail: '候補の評価のみに影響しています' })
  }
  const now = new Date(i.nowMs)
  for (const holding of i.holdings) {
    if (!isSellLocked(holding as Holding, now)) continue
    const sellable = formatMonthDay(getSellableDate(holding as Holding))
    items.push({
      id: `lock-${holding.code}`,
      glyph: 'lock',
      title: `${holding.code} は 90日ロック中`,
      detail: sellable === null ? '売却可能予定日は不明です' : `売却可能予定日 ${sellable}`,
    })
  }
  return items
}

function projectDataStatus(i: TodayHomeInputs): DataStatusRow[] {
  const marketAt = formatJstMonthDayTime(i.timestamps.market)
  const candidateAt = formatJstMonthDayTime(i.timestamps.candidates)
  const synthesis = i.synthesis
  return [
    { id: 'market', label: '市場データ', mark: i.marketDataOk ? 'ok' : 'wait', value: marketAt ?? UNAVAILABLE_LABEL },
    { id: 'cash', label: '現金権限', mark: i.deployableCash.available ? 'ok' : 'wait', value: i.deployableCash.available ? '利用可能' : UNAVAILABLE_LABEL },
    {
      id: 'candidates',
      label: '候補データ',
      mark: synthesis !== null && synthesis.status === 'available' && synthesis.provenance.candidateFreshness === 'fresh' ? 'ok' : 'wait',
      value: candidateAt ?? UNAVAILABLE_LABEL,
    },
    {
      id: 'allocation',
      label: '配分スナップショット',
      mark: i.allocation.availability === 'available' ? 'ok' : 'wait',
      value: i.allocation.availability === 'available'
        ? (formatJstMonthDayTime(i.allocation.generation.generatedAt) ?? UNAVAILABLE_LABEL)
        : UNAVAILABLE_LABEL,
    },
  ]
}

/** 凍結 4 セル目の値。候補 projection の既存値だけを文字にする（再集計しない）。 */
function projectCandidateChip(c: CandidateSectionProjection, heroState: HeroState): CandidateStateChip {
  if (c.status === 'unavailable') return { label: UNDETERMINABLE_LABEL, sub: null, available: false }
  if (heroState === 'data_wait') return { label: DATA_WAIT_ROW_LABEL, sub: null, available: false }
  if (c.totalCount === 0) return { label: '候補なし', sub: null, available: true }
  return {
    label: `${c.executableCount} ${HOME_TIER_LABEL.actionable}`,
    sub: `${c.reviewCount} ${HOME_TIER_LABEL.deep_review}`,
    available: true,
  }
}

function projectMarket(i: TodayHomeInputs): MarketViewModel {
  const f = i.marketFeed
  return {
    indicators: [
      { id: 'nikkei', label: '日経平均', value: f.marketLoaded ? f.nikkei : null, changePct: f.marketLoaded ? f.nikkeiChgPct : null },
      // S&P 500 は macro スナップショット側の項目（market には無い）。
      { id: 'sp500', label: 'S&P 500', value: f.macroLoaded ? f.sp500 : null, changePct: f.macroLoaded ? f.sp500ChgPct : null },
      // VIX（米: market.vix）と日経VI（macro.nikkeiVI）は別項目。取り違えない。
      { id: 'vix', label: 'VIX（米）', value: f.marketLoaded ? f.vix : null, changePct: null },
      { id: 'nikkeiVi', label: '日経VI', value: f.nikkeiViLoaded ? f.nikkeiVi : null, changePct: null },
    ],
    asOfLabel: f.marketLoaded ? formatJstMonthDayTime(i.timestamps.market) : null,
  }
}

export function projectGrossCashFromInputs(i: Pick<TodayHomeInputs, 'allocation' | 'effectiveCash'>): GrossCashViewModel {
  if (i.allocation.availability === 'available') return { kind: 'known', amountJpy: i.allocation.grossCash }
  // DEFAULT（権限未設定）の 0 は「未設定」であり確認済みの 0 ではない。
  return i.effectiveCash.source === 'manual' ? { kind: 'known', amountJpy: i.effectiveCash.grossCash } : { kind: 'unknown' }
}

export function projectGrossCash(state: AppState): GrossCashViewModel {
  return projectGrossCashFromInputs({
    allocation: selectAllocationConsumerSnapshot(state),
    effectiveCash: selectEffectiveCashAssumptions(state),
  })
}

export function assembleTodayHomeViewModel(i: TodayHomeInputs): TodayHomeViewModel {
  const heroState = resolveHeroStateFromInputs(i)
  const decision = i.officialDecision
  const copy = heroCopy(heroState)
  const generatedAtLabel = decision === null ? null : formatJstMonthDayTime(decision.generatedAt)

  const hero: HeroViewModel = copy !== null
    ? {
        state: heroState,
        tone: heroToneFor(heroState),
        ...copy,
        safeModeBanner: heroState === 'safe_mode',
        generatedAtLabel,
      }
    : heroState === 'boot'
      ? {
          state: 'boot', tone: 'calm', eyebrow: '今日の状態', headline: '起動中',
          secondaryCopy: 'データを取得しています。', guardNote: null, safeModeBanner: false, cta: null, generatedAtLabel: null,
        }
      : {
          // normal: OfficialDecision.headline を verbatim（UI 合成・副文なし）
          state: 'normal', tone: 'calm', eyebrow: '今日の判断', headline: (decision as OfficialDecision).headline,
          secondaryCopy: null, guardNote: null, safeModeBanner: false,
          cta: { label: '判断の詳細', target: 'audit' }, generatedAtLabel,
        }

  const snapshot = i.allocation
  const deployableCash: DeployableCashViewModel = i.deployableCash.available
    ? { kind: 'available', amountJpy: i.deployableCash.amount }
    : { kind: 'unavailable' } // unavailable を ¥0 に変換しない

  if (heroState === 'boot') {
    return {
      hero, chips: null, attention: [], dataStatus: [], candidates: NO_CANDIDATES,
      deployableCash, grossCash: { kind: 'unknown' }, portfolio: null,
      market: projectMarket(i), unavailableDetail: null,
    }
  }

  const candidates = projectCandidateSection(i.synthesis, candidateProjectionContextFor(heroState))
  const attention = projectAttention(i, heroState, candidates)
  const market = projectMarket(i)
  const allocationAtLabel = snapshot.availability === 'available'
    ? formatJstMonthDayTime(snapshot.generation.generatedAt)
    : UNAVAILABLE_LABEL
  // 判断不能 = 「今日の判断を作れない」だけ。他の権限が生きている情報は消さない。
  const decisionUnavailable = heroState === 'decision_unavailable'

  return {
    hero,
    // M2-D: 判断不能ではチップ列を出さない（レジーム / 運用モードは
    // 「安全に確認できる情報」に残るため、生きている情報は失われない）。
    chips: decisionUnavailable ? null : {
      regime: snapshot.availability === 'available'
        ? { label: MARKET_REGIME_LABEL[snapshot.regime], available: true }
        : { label: UNDETERMINABLE_LABEL, available: false },
      mode: snapshot.availability === 'available'
        ? { label: OPERATION_MODE_LABEL[snapshot.marketMode], available: true }
        : { label: UNDETERMINABLE_LABEL, available: false },
      attentionCount: attention.length,
      candidates: projectCandidateChip(candidates, heroState),
    },
    attention,
    dataStatus: heroState === 'data_wait' ? projectDataStatus(i) : [],
    candidates,
    deployableCash,
    grossCash: projectGrossCashFromInputs(i),
    portfolio: projectPortfolio(snapshot),
    market,
    unavailableDetail: decisionUnavailable
      ? {
          unavailable: [
            { id: 'decision', label: '今日の判断', value: '取得できません' },
            { id: 'candidate-execution', label: '候補の実行判断', value: UNAVAILABLE_LABEL },
          ],
          available: [
            { id: 'market', label: '市場データ', value: market.asOfLabel },
            { id: 'allocation', label: '配分と目標の比較', value: allocationAtLabel },
            {
              id: 'regime',
              label: '市場レジーム / 運用モード',
              value: snapshot.availability === 'available'
                ? `${MARKET_REGIME_LABEL[snapshot.regime]} / ${OPERATION_MODE_LABEL[snapshot.marketMode]}`
                : UNAVAILABLE_LABEL,
            },
          ],
        }
      : null,
  }
}

export function selectTodayHomeViewModel(state: AppState, now: number = Date.now()): TodayHomeViewModel {
  return assembleTodayHomeViewModel(gatherTodayHomeInputs(state, now))
}
