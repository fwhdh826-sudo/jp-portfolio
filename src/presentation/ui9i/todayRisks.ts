// ═══════════════════════════════════════════════════════════
// UI-9I Phase 2B-2R2: T0（今日）「注目ポイント」に載せる canonical リスクの presentation adapter。
//
//   OfficialDecision.risks（唯一の権限）→ この adapter → React（TodayHomeView の AttentionCard）
//
// 旧ホームの RiskWarningCard を復元するものではない。あれは VIX / 日経VI / SQ / 保有名などの
// UI ローカル閾値から警告を合成していた（廃止済み: LEGACY_RISK_HEURISTICS = NOT_RESTORED）。
// ここは producer が既に確定させた文字列を、順序と文言を保ったまま到達可能にするだけである。
//
// 許可されること:
//   - OfficialDecision.risks の提示順をそのまま保つ
//   - 文言を verbatim で保持する（強めも弱めもしない）
//   - 先頭 N 件を初期表示にし、残りを同じ順序で到達可能にする
//   - 表示できない値（文字列でない / 空白のみ）を行にしない
//
// 許可されないこと:
//   sort / 重大度・確率の付与 / リスクの推論・生成 / 閾値判定 / 意味に基づく重複排除 /
//   リスクを action に変換すること / 「リスクなし」「安全」の推論。
//
// 状態:
//   unavailable : OfficialDecision が利用できない。risks=[] とは別の状態（行は作らない）
//   none        : 判断は有効で risks=[]。安全とは読ませないため、行も文言も出さない
//   available   : 1 件以上
// ═══════════════════════════════════════════════════════════
import type { OfficialDecision } from '../../types'

/** 初期表示の最大行数。残りは「他 N 件を見る」で提示順のまま到達できる。 */
export const TODAY_RISK_PREVIEW_LIMIT = 3

export type TodayRisksStatus = 'unavailable' | 'none' | 'available'

export interface TodayRiskRow {
  /** 同一文言が複数あっても React key が衝突しない、提示位置ベースの識別子。 */
  readonly id: string
  /** OfficialDecision.risks の文言（verbatim）。 */
  readonly text: string
}

export interface TodayRisksProjection {
  readonly status: TodayRisksStatus
  /** 初回表示（提示順の先頭 TODAY_RISK_PREVIEW_LIMIT 件）。 */
  readonly preview: readonly TodayRiskRow[]
  /** 残り（提示順のまま）。黙って捨てない。 */
  readonly more: readonly TodayRiskRow[]
  /** 表示対象の総数（preview + more）。 */
  readonly totalCount: number
}

const EMPTY_LIST: readonly TodayRiskRow[] = []

export const UNAVAILABLE_TODAY_RISKS: TodayRisksProjection = {
  status: 'unavailable', preview: EMPTY_LIST, more: EMPTY_LIST, totalCount: 0,
}

export const NO_TODAY_RISKS: TodayRisksProjection = {
  status: 'none', preview: EMPTY_LIST, more: EMPTY_LIST, totalCount: 0,
}

/**
 * @param decision 利用できる OfficialDecision。null = 利用不可（fail closed。risks=[] とは区別する）。
 *                 「利用できる」の判定は Hero と同じ権限（isOfficialDecisionUsable）を呼び出し側が使う。
 */
export function projectTodayRisks(decision: OfficialDecision | null): TodayRisksProjection {
  if (decision === null) return UNAVAILABLE_TODAY_RISKS

  const rows: TodayRiskRow[] = []
  const source: unknown = decision.risks
  if (Array.isArray(source)) {
    source.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') return
      rows.push({ id: `risk-${index}`, text: entry })
    })
  }
  if (rows.length === 0) return NO_TODAY_RISKS

  return {
    status: 'available',
    preview: rows.slice(0, TODAY_RISK_PREVIEW_LIMIT),
    more: rows.slice(TODAY_RISK_PREVIEW_LIMIT),
    totalCount: rows.length,
  }
}
