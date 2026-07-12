// ═══════════════════════════════════════════════════════════
// Regime Detection Types — v13.3
// 参照: docs/constitution/REGIME.md / 07_spec.md Section 11.1
// ═══════════════════════════════════════════════════════════

/** 5レジームID */
export type RegimeId =
  | 'bull_calm'      // 強気・低ボラ
  | 'bull_volatile'  // 強気・高ボラ
  | 'bear'           // 弱気
  | 'crisis'         // 危機（SAFE_MODE自動発動）
  | 'uncertain'      // 不確実（待機）

/** LLM Quality Detection の投票結果 */
export interface LlmRegimeVote {
  regime: RegimeId
  confidence: number          // 0.0 ~ 1.0
  structural_changes: string[] // 構造変化シグナル（地政学・危機兆候等）
}

/** HMM の投票結果: [レジームID, 確率] */
export type HmmRegimeVote = [RegimeId, number]

/** 3層それぞれの投票結果 */
export interface RegimeVotes {
  rule_based: RegimeId
  hmm: HmmRegimeVote
  llm: LlmRegimeVote
}

/** Regime判定に使用したマーケットデータのスナップショット */
export interface RegimeMarketSnapshot {
  vix: number
  nikkei_5d_return: number
  nikkei_60ma: number
  nikkei_200ma: number
  sp500_dd_30d: number
}

/** 現在のレジーム状態（regime_state.json 準拠） */
export interface RegimeState {
  timestamp: string                  // ISO8601
  current_regime: RegimeId
  consensus: number                  // 0.33 ~ 1.0（2/3 or 3/3）
  votes: RegimeVotes
  market_data_snapshot: RegimeMarketSnapshot
  regime_changed_at: string          // 直近レジーム変化日時
  previous_regime: RegimeId | null
  duration_hours: number             // 現在レジームの継続時間
}

/** 過去レジームの履歴エントリ（regime_history.json 用軽量版） */
export interface RegimeHistoryEntry {
  timestamp: string
  regime: RegimeId
  consensus: number
  duration_hours: number
}

/** 3層合議の詳細結果（regime_consensus.json 準拠） */
export interface RegimeConsensus {
  timestamp: string
  final_regime: RegimeId
  consensus_ratio: number            // 一致した層数 / 3
  votes: RegimeVotes
  structural_changes: string[]
  override_active: boolean           // LLM構造変化検出による優先発動中か
}

/** レジームごとの表示メタ情報（UI用） */
export interface RegimeDisplayMeta {
  label: string        // 日本語ラベル
  icon: string         // 絵文字
  colorVar: string     // CSS変数名（例: var(--color-success)）
}

export const REGIME_DISPLAY_META: Record<RegimeId, RegimeDisplayMeta> = {
  bull_calm:     { label: '強気・低ボラ', icon: '🟢', colorVar: 'var(--color-success)'  },
  bull_volatile: { label: '強気・高ボラ', icon: '🟡', colorVar: 'var(--color-warning)'  },
  bear:          { label: '弱気',        icon: '🔴', colorVar: 'var(--color-danger)'   },
  crisis:        { label: '危機',        icon: '🚨', colorVar: 'var(--color-critical)' },
  uncertain:     { label: '不確実',      icon: '⚪', colorVar: 'var(--color-neutral)'  },
}
