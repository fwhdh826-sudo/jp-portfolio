// ═══════════════════════════════════════════════════════════
// Path-Dependent Rebalance + Scenario Pre-Commitment Types — v13.3
// 参照: 07_spec.md Section 9 / 05_master_plan.md Section 9
// ═══════════════════════════════════════════════════════════

/** Core / Satellite / Tactical の3層区分 */
export type AssetTier = 'core' | 'satellite' | 'tactical'

/** リバランスアクション */
export type RebalanceAction =
  | 'buy'        // 通常の買い増し
  | 'sell'       // 通常の売却
  | 'buy_low'    // Buy Low（30日比でアンダーパフォーム中に買い増し）
  | 'sell_high'  // Sell High（30日比でアウトパフォーム中に利確）

/** リバランス優先度 */
export type RebalancePriority = 'high' | 'medium' | 'low'

/** パス依存リバランス1件の推奨（path_dependent_recommendations.json の1要素） */
export interface PathDependentRecommendation {
  ticker: string
  current: number                // 現在比率（0-1）
  target: number                 // 目標比率（0-1）
  action: RebalanceAction
  priority: RebalancePriority
  relative_perf_30d: number      // インデックス比30日相対パフォーマンス
  asset_tier: AssetTier
  reason: string                 // 根拠テキスト
}

/** Scenario Pre-Commitment の1アクション */
export interface ScenarioPreCommitmentAction {
  action:
    | 'reduce_tactical'
    | 'freeze_new_buys'
    | 'deploy_strategic_cash'
    | 'scale_up_satellite'
    | 'ensure_cash_pct'
    | 'reduce_new_size'
    | 'reduce_all_risk'
    | 'freeze_all_buys'
    | 'scale_down_risk'
  amount_pct?: number            // 削減率（%）
  amount_jpy?: number            // 投入額（円）
  target?: string                // 対象（例: 'core_global', 'leveraged'）
  min_cash_pct?: number
  scale?: number
  duration_hours?: number
  accounts?: string[]            // 対象口座（例: ['NISA_growth', 'specific']）
}

/** アラートレベル */
export type AlertLevel = 'NONE' | 'L1' | 'L2' | 'L3' | 'OPPORTUNITY'

/** シナリオトリガー評価結果 */
export interface ScenarioTrigger {
  id: string                               // シナリオID（例: 'vix_spike_30'）
  name: string                             // シナリオ名
  triggered: boolean
  conditions_met: number                   // 充足条件数（conditions_all の場合）
  pre_commitment: ScenarioPreCommitmentAction[]
  alert: AlertLevel
  expiry: string | null                    // 有効期限
}

/** Volatility Targeting の結果 */
export interface VolatilityTargetResult {
  base_size: number
  scaled_size: number
  current_vol: number           // 現在のボラティリティ
  target_vol: number            // 目標ボラティリティ（デフォルト 0.15）
  scale_factor: number          // target_vol / current_vol（0.5 ~ 2.0 にクランプ）
}

/** パス依存リバランス全体（path_dependent_recommendations.json 準拠） */
export interface PathDependentRebalanceResult {
  timestamp: string
  regime: string
  recommendations: PathDependentRecommendation[]
  total_high_priority: number
  monthly_trade_count: number   // 月次取引カウント（上限キャップ管理用）
}

/** シナリオ Pre-Commitment 全体（scenario_pre_commitments.json 準拠） */
export interface ScenarioPreCommitmentsResult {
  timestamp: string
  triggered_scenarios: ScenarioTrigger[]
  active_alert_level: AlertLevel
}
