// ═══════════════════════════════════════════════════════════
// Multi-Strategy Engine Types — v13.3
// 参照: 07_spec.md Section 5 / 05_master_plan.md Section 8
// 4戦略: Frontier / Quality-Adjusted Size / Fundamental / Cross-Factor
// ═══════════════════════════════════════════════════════════

import type { RegimeId } from './regime'

/** 4戦略のID */
export type StrategyId =
  | 'frontier'       // Frontier AI Index（v13.2コア）
  | 'quality_size'   // Quality-Adjusted Size（Asness 2018）
  | 'fundamental'    // Fundamental Weighted（Arnott 2005）
  | 'cross_factor'   // Cross-Factor（Alquist 2018）

/** 理想ポートフォリオ（ticker → 配分比率、合計1.0） */
export type IdealPortfolio = Record<string, number>

/** 1戦略の出力結果（StrategyOutput） */
export interface StrategyOutput {
  ideal_pf: IdealPortfolio
  expected_return: number       // 年率期待リターン
  expected_vol: number          // 年率ボラティリティ
  sharpe_ratio: number
  max_dd_estimate: number       // 最大DD推定（負値）
  strategy_id: StrategyId
  rationale: string             // 選出根拠テキスト
}

/** 戦略ペア間の相関係数マップ */
export type StrategyCorrelations = Record<string, number>
// キー例: 'frontier_vs_quality_size', 'quality_size_vs_fundamental' 等

/** レジーム別の戦略重み（合計1.0） */
export type RegimeStrategyWeights = Record<StrategyId, number>

/** 全レジームの戦略重みテーブル */
export type AllRegimeStrategyWeights = Record<RegimeId, RegimeStrategyWeights>

/** 4戦略の統合結果（strategy_aggregated.json 準拠） */
export interface StrategyAggregated {
  timestamp: string
  regime: RegimeId
  weights_used: RegimeStrategyWeights
  strategy_outputs: Record<StrategyId, StrategyOutput>
  strategy_correlations: StrategyCorrelations
  diversification_score: number   // 1 - max_correlation（高いほど良い）
  ideal_pf: IdealPortfolio        // 統合後ポートフォリオ
  expected_return: number
  dd10_uniform_return: number     // DD-10%統一リターンKPI（G1）
  high_correlation_warning: boolean  // 相関 > 0.7 で警告
}

/** 各戦略の個別JSON（strategy_a_frontier.json 等） */
export interface StrategyFile {
  timestamp: string
  strategy_id: StrategyId
  regime: RegimeId
  output: StrategyOutput
}

/** 時間軸重み（短期/中長期） */
export interface TimeHorizonWeights {
  short_term: {
    technical_momentum: number
    flow_microstructure: number
    sentiment: number
    fundamental: number
    factor_cross: number
    regime: number
  }
  long_term: {
    fundamental: number
    factor_cross: number
    quality_value: number
    growth: number
    shareholder_return: number
    regime: number
  }
}
