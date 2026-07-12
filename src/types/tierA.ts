// ═══════════════════════════════════════════════════════════
// Tier A Gate Types — v13.3
// 参照: 07_spec.md Section 7 / docs/constitution/PRINCIPLES.md
// Hard Gate (T1-T4) + Soft Penalty (T5-T8) + Capitulation Signal
// ═══════════════════════════════════════════════════════════

import type { AlertLevel } from './rebalance'

/** Hard Constraint ルールID */
export type TierAHardRuleId = 'T1' | 'T2' | 'T3' | 'T4'

/** Soft Constraint ルールID */
export type TierASoftRuleId = 'T5' | 'T6' | 'T7' | 'T8' | 'T_v3'

/** Hard Constraint の評価結果（強制修正あり・例外なし） */
export interface TierAHardViolation {
  rule_id: TierAHardRuleId
  name: string               // ルール名（例: 'ストップロス -40%'）
  triggered: boolean
  current_value: number      // 実際の値
  threshold: number          // 閾値
  action_taken: string       // 実行されたアクション（例: 'force_sell'）
}

/** Soft Constraint の評価結果（ペナルティ項として Frontier に組込） */
export interface TierASoftViolation {
  rule_id: TierASoftRuleId
  name: string
  in_warn_zone: boolean      // 警告閾値を超えた
  in_severe_zone: boolean    // 深刻閾値を超えた
  current_value: number
  warn_threshold: number
  severe_threshold: number
  penalty_score: number      // 計算されたペナルティ値
}

/** Capitulation Signal の4条件それぞれの状態 */
export interface CapitulationConditionState {
  condition: string          // 条件式（例: 'vix > 35'）
  current_value: number
  met: boolean
}

/** Capitulation Signal の全体状態（capitulation_signal.json 準拠） */
export interface CapitulationState {
  timestamp: string
  conditions: {
    vix_spike:      CapitulationConditionState
    panic_selling:  CapitulationConditionState
    oversold:       CapitulationConditionState
    volume_spike:   CapitulationConditionState
  }
  conditions_met: number       // 0 ~ 4
  is_capitulation: boolean     // conditions_met >= 4
  is_partial_capitulation: boolean  // conditions_met >= 3
  alert_level: AlertLevel
  deployment_recommendation: string | null  // 投入推奨（例: '戦略的現金400万投入'）
}

/** Tier A 全体の評価結果（tier_a_violations.json + tier_a_alerts.json 統合） */
export interface TierAResult {
  timestamp: string
  hard_violations: TierAHardViolation[]
  soft_violations: TierASoftViolation[]
  capitulation: CapitulationState
  active_alert_level: AlertLevel
  any_hard_violation: boolean
  any_soft_violation: boolean
  safe_mode_active: boolean    // T3 発動 or crisis レジーム時 true
  total_soft_penalty: number   // Soft ペナルティの合計値
}

/** Tier A アラート発報の1件（tier_a_alerts.json の1要素） */
export interface TierAAlert {
  alert_id: string
  rule_id: TierAHardRuleId | TierASoftRuleId | 'CAPITULATION'
  level: AlertLevel
  message: string
  triggered_at: string
  resolved_at: string | null
}

// ═══════════════════════════════════════════════════════════
// P4-A24: v13.3 live snapshot types (matching writer output)
// safe_mode.json / tier_a_violations.json / tier_a_alerts.json
// ═══════════════════════════════════════════════════════════

export interface SafeModeData {
  active: boolean
  triggered_at: string | null
  trigger_reason: string | null
  trigger_reason_detail: string | null
  trigger_conditions: {
    tier1_data_stale: boolean
    tier_a_t3_violated: boolean
    crisis_regime: boolean
    system_error: boolean
  }
  restrictions: {
    new_buys_frozen: boolean
    rebalance_frozen: boolean
    force_sell_active: boolean
  }
  estimated_resume_at: string | null
  last_checked: string
}

export interface SafeModeSnapshot {
  _meta: {
    version: string
    kind: 'operation_snapshot'
    not_for_trading: boolean
  }
  safe_mode: SafeModeData
}

export type TierAViolationCode = 'T1' | 'T2' | 'T3' | 'T4'
export type TierAViolationsStatus = 'ok' | 'degraded' | 'unavailable'

export interface TierAViolationEntry {
  code: TierAViolationCode
  triggered: boolean
  severity: string
  target_type: 'holding' | 'portfolio' | 'system'
  message: string
  safe_mode_related: boolean
}

export interface TierAViolationsSnapshot {
  _meta: {
    version: string
    kind: 'live_tier_a_violations'
    not_for_trading: boolean
  }
  generated_at?: string
  status: TierAViolationsStatus
  violations: TierAViolationEntry[]
  summary: {
    total_violations: number
    t3_count: number
    safe_mode_related_count: number
  }
}

export type TierAAlertCode = 'L1' | 'L2' | 'L3' | 'OPPORTUNITY'
export type TierAAlertsStatus = 'ok' | 'degraded' | 'unavailable'

export interface TierAAlertEntry {
  code: TierAAlertCode
  triggered: boolean
  severity: string
  message: string
  recommended_action_type: string
}

export interface TierAAlertsSnapshot {
  _meta: {
    version: string
    kind: 'live_tier_a_alerts'
    not_for_trading: boolean
  }
  generated_at?: string
  status: TierAAlertsStatus
  alerts: TierAAlertEntry[]
  summary: {
    total_triggered: number
    highest_level: string
  }
}
