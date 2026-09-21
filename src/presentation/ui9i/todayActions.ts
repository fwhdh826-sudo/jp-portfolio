// ═══════════════════════════════════════════════════════════
// UI-9I Phase 2B-2R: T0（今日）「今日のToDo」の presentation adapter。
//
//   OfficialDecision.actions（唯一の権限）→ この adapter → React（TodayHomeView）
//
// これは「今日、何をすべきか」を R4.1 の Today に戻すための、表示だけの写像である。
// 新しい意思決定は一切作らない（second decision engine 禁止）。
//
// 許可されること（旧 TodoCard の canonical 経路と同一の表示規則のみ）:
//   - OfficialDecision.actions の順序をそのまま保つ（producer が順序の権限）
//   - isCandidate=true の行を除外する（候補は Today の「候補」節が担う。表示の重複排除のみ）
//   - 実効 SAFE_MODE / DQ 抑制時に BUY 行を表示しない
//     （旧 TodoCard と同一の computeBuyDisplaySuppressed / 同一の述語。新しい推論は作らない）
//   - action → 既存の承認済み日本語語彙への写像、reason / blockedReason の露出
//
// 許可されないこと:
//   sort / rank / score 比較 / 優先度づけ / 保有・VIX・SQ・投信・現金からの action 合成 /
//   OfficialDecision が無いときの代替提案（LEGACY_FALLBACK_SYNTHESIS = NOT_RESTORED）。
//
// 旧 TodoCard が OfficialDecision.dataQualitySuppressed のとき末尾へ足していた
// 「データ更新待ち」文言行は action ではなく状態表示だったため復元しない
// （Hero の data_wait とデータの状態カードが同じ権限を担う）。
// ═══════════════════════════════════════════════════════════
import type { OfficialDecision, OfficialDecisionAction, OfficialDecisionItem } from '../../types'
import { TODAY_ACTION_LABEL } from './labels'

/** 初期表示の最大行数。残りは「他 N 件を見る」で提示順のまま到達できる。 */
export const TODAY_ACTION_PREVIEW_LIMIT = 3

/** 状態語は文字で示す。tone は色・字形の補助であり、色だけに依存しない。 */
export type TodayActionTone = 'sell' | 'buy' | 'hold' | 'wait' | 'data_wait' | 'blocked' | 'monitor'

const TONE_BY_ACTION: Record<OfficialDecisionAction, TodayActionTone> = {
  BUY: 'buy',
  BUY_NEW: 'buy',
  ADD_EXISTING: 'buy',
  SELL: 'sell',
  HOLD: 'hold',
  WAIT: 'wait',
  DATA_WAIT: 'data_wait',
  BLOCKED: 'blocked',
  MONITOR: 'monitor',
  WATCH: 'monitor',
}

export interface TodayActionRow {
  readonly id: string
  readonly action: OfficialDecisionAction
  /** 承認済みの日本語語彙（生の enum は出さない）。 */
  readonly actionLabel: string
  readonly tone: TodayActionTone
  /** 「コード 名称」。コードが無ければ名称のみ。 */
  readonly title: string
  /** 権限が持つ reason。空なら null（補完しない）。 */
  readonly reason: string | null
  /** 権限が持つ blockedReason（実行条件 / 次の確認）。無ければ null。 */
  readonly blockedReason: string | null
}

export type TodayActionsStatus = 'boot' | 'unavailable' | 'empty' | 'available'

export interface TodayActionsProjection {
  readonly status: TodayActionsStatus
  /** 初回表示（提示順の先頭 TODAY_ACTION_PREVIEW_LIMIT 件）。 */
  readonly preview: readonly TodayActionRow[]
  /** 残り（提示順のまま）。黙って捨てない。 */
  readonly more: readonly TodayActionRow[]
  /** 表示対象の総数（preview + more）。 */
  readonly totalCount: number
  /** 実効 SAFE_MODE / DQ 抑制のため表示しなかった BUY 行数（黙って消さないための注記用）。 */
  readonly suppressedBuyCount: number
}

export interface TodayActionsContext {
  /** computeBuyDisplaySuppressed(...) の結果。ここでは推論しない。 */
  readonly buySuppressed: boolean
}

const EMPTY_LIST: readonly TodayActionRow[] = []

export const BOOT_TODAY_ACTIONS: TodayActionsProjection = {
  status: 'boot', preview: EMPTY_LIST, more: EMPTY_LIST, totalCount: 0, suppressedBuyCount: 0,
}

/** OfficialDecision が利用できない: 代替提案は作らない（HOLD / WAIT / 0件 とは別状態）。 */
export const UNAVAILABLE_TODAY_ACTIONS: TodayActionsProjection = {
  status: 'unavailable', preview: EMPTY_LIST, more: EMPTY_LIST, totalCount: 0, suppressedBuyCount: 0,
}

const nonBlank = (v: string | undefined | null): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null

function titleOf(item: OfficialDecisionItem): string {
  const parts = [nonBlank(item.code), nonBlank(item.name)].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join(' ') : '対象の記載なし'
}

export function projectTodayActionRow(item: OfficialDecisionItem): TodayActionRow {
  return {
    id: item.id,
    action: item.action,
    actionLabel: TODAY_ACTION_LABEL[item.action],
    tone: TONE_BY_ACTION[item.action],
    title: titleOf(item),
    reason: nonBlank(item.reason),
    blockedReason: nonBlank(item.blockedReason),
  }
}

/**
 * @param decision 利用できる OfficialDecision。null = 利用不可（fail closed）。
 *                 「利用できる」の判定は Hero と同じ権限（isOfficialDecisionUsable）を呼び出し側が使う。
 */
export function projectTodayActions(
  decision: OfficialDecision | null,
  ctx: TodayActionsContext,
): TodayActionsProjection {
  if (decision === null) return UNAVAILABLE_TODAY_ACTIONS

  // 順序は producer のまま。sort / rank はしない。
  let suppressedBuyCount = 0
  const shown: TodayActionRow[] = []
  for (const item of decision.actions) {
    if (item.isCandidate === true) continue // 候補は「候補」節（CandidateDecisionSynthesis）が担う
    if (ctx.buySuppressed && item.action === 'BUY') {
      suppressedBuyCount += 1
      continue
    }
    shown.push(projectTodayActionRow(item))
  }

  if (shown.length === 0) {
    return { status: 'empty', preview: EMPTY_LIST, more: EMPTY_LIST, totalCount: 0, suppressedBuyCount }
  }
  return {
    status: 'available',
    preview: shown.slice(0, TODAY_ACTION_PREVIEW_LIMIT),
    more: shown.slice(TODAY_ACTION_PREVIEW_LIMIT),
    totalCount: shown.length,
    suppressedBuyCount,
  }
}
