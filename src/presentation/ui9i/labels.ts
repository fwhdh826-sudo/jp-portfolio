// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: ユーザー向け表示ラベル（純粋な文言辞書）。
//
// canonical な列挙値 → 日本語ラベルの写像のみ。判定・並べ替え・閾値は持たない。
// Presentation adapts to authority — ここで投資判断の意味を作らない。
// ═══════════════════════════════════════════════════════════
import type { AssetClass } from '../../types/allocationPlan'
import type { CandidateSynthesisRelationship } from '../../types/candidateDecisionSynthesis'
import type { OfficialDecisionAction } from '../../types'

// AllocationConsumerSnapshot.regime（3値）。5区分の regimeState は T0 の主状態にしない。
export const MARKET_REGIME_LABEL = {
  bull: '強気',
  neutral: '中立',
  bear: '弱気',
} as const

// AllocationConsumerSnapshot.marketMode。市場レジームとは別軸のため結合しない。
export const OPERATION_MODE_LABEL = {
  normal: '通常',
  caution: '警戒',
  emergency: '緊急',
} as const

export const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  JP_STOCK: '国内個別株',
  JP_TRUST: '国内投信',
  OVERSEAS_TRUST: '海外投信',
  GOLD: '金',
  CASH: '現金',
  CASH_RESERVE: '現金リザーブ',
}

// Home では BUY_NEW を前面に出さず、保有関係を文字で示す。
export const RELATIONSHIP_LABEL: Record<CandidateSynthesisRelationship, string> = {
  already_held: '保有',
  new_to_portfolio: '新規',
}

// Home 用の tier 表示語。Detail / Audit 用（実行検討 / 精査対象）は
// candidateDecisionSynthesisPresentation.CANDIDATE_QUALITY_TIER_LABEL を使う。
export const HOME_TIER_LABEL = {
  actionable: '実行可能',
  deep_review: '要レビュー',
} as const

/**
 * 今日のToDo 行の状態語（OfficialDecision.actions の action → 表示語）。enum は変えず語彙だけを写像する。
 * 個別株 STOCK_DECISION_LABEL / 候補 SYNTHESIS_ACTION_LABEL と同じ語を再利用し、
 * BLOCKED / DATA_WAIT / WAIT は別の語のまま区別する（BLOCKED を HOLD / WAIT に丸めない）。
 * 「おすすめ」「強く買い」等の格付け語は作らない。
 */
export const TODAY_ACTION_LABEL: Record<OfficialDecisionAction, string> = {
  BUY: '買い',
  SELL: '売却',
  HOLD: '保有継続',
  WAIT: '待機',
  DATA_WAIT: '更新待ち',
  MONITOR: '監視',
  WATCH: '監視',
  BLOCKED: '実行不可',
  BUY_NEW: '新規検討',
  ADD_EXISTING: '追加検討',
}

export const DATA_WAIT_ROW_LABEL = '更新待ち'
export const UNAVAILABLE_LABEL = '利用不可'
export const UNDETERMINABLE_LABEL = '判定不能'

/** ユーザー向けのバージョン表記（サイドバー脚注・その他ハブのシステム欄）。 */
export const APP_VERSION_LABEL = '13.3'
