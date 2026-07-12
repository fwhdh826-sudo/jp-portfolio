// ═══════════════════════════════════════════════════════════
// 6軸スコア + Cross-Axis + Dynamic Weight Types — v13.3
// 参照: 07_spec.md Section 1-2 / 05_master_plan.md Section 4
// ═══════════════════════════════════════════════════════════

import type { RegimeId } from './regime'

/** 6軸スコアのID */
export type ScoreAxisId =
  | 'value'              // バリュー
  | 'quality'            // クオリティ
  | 'growth'             // グロース
  | 'safety'             // 安全性
  | 'momentum'           // モメンタム
  | 'shareholder_return' // 還元力

/** スコアの総合ランク */
export type ScoreRating = 'S' | 'A' | 'B' | 'C' | 'D'

/** Sizeセグメント（aidatalab Alquist 2018 準拠） */
export type SizeSegment = 'large_cap' | 'mid_cap' | 'small_cap'

/** 各軸のサブコンポーネント */
export interface ScoreComponent {
  name: string           // コンポーネント名（例: 'per_score'）
  weight: number         // 軸内ウェイト（合計1.0）
  raw_value: number      // 生の数値
  normalized: number     // 0 ~ 100 正規化済み
  description: string    // 根拠説明文
}

/** 1軸分のスコア結果 */
export interface AxisScore {
  axis: ScoreAxisId
  name_ja: string                // 日本語名（例: 'バリュー'）
  total: number                  // 0 ~ 100
  rating: ScoreRating
  components: ScoreComponent[]
  explanation: string            // 軸全体の根拠説明
}

/** 6軸スコア全体 */
export type SixAxisScore = Record<ScoreAxisId, AxisScore>

/** Cross-Axis Signal（aidatalab Asness 2018 / Alquist 2018 準拠） */
export interface CrossAxisSignals {
  quality_value: number    // Quality × Value（バリュー罠回避）
  quality_growth: number   // Quality × Growth（グロース罠回避）
  size_quality: number     // Size × Quality（小型×高品質）
  size_value: number       // Size × Value（小型×割安）
  size_momentum: number    // Size × Momentum（小型×トレンド）
  anti_junk: number        // max(0, quality - 50)（低品質除外）
}

/** レジーム別動的総合スコア */
export interface DynamicTotalScore {
  total: number
  rating: ScoreRating
  axes: Record<ScoreAxisId, number>  // 各軸の total のみ
  regime_used: RegimeId
  weights_used: Record<ScoreAxisId, number>
}

/** 銘柄ごとのスコア完全記録（stock_scores_6axis.json の1銘柄分） */
// 本番 partial-real ファイルは six_axis + diagnostics のみ保持し、他フィールドは省略
export interface StockScoreRecord {
  ticker: string
  six_axis: SixAxisScore
  // 以下は contracts/v13.3 フィクスチャ形式に含まれるが、本番ファイルでは省略される任意フィールド
  company_name?: string
  size_segment?: SizeSegment
  market_cap?: number
  cross_axis?: CrossAxisSignals
  dynamic_total?: DynamicTotalScore
  scored_at?: string
  diagnostics?: string[]
}

/** 6軸重みテーブル（REGIME_AXIS_WEIGHTS の1レジーム分） */
export type AxisWeights = Record<ScoreAxisId, number>

/** 全レジームの6軸重みテーブル */
export type RegimeAxisWeights = Record<RegimeId, AxisWeights>

// ── Phase 7 Fund Observation Types (Card 7-11) ──────────────
// calculation-only, not an order, not a recommendation

export interface FundPhase7Entry {
  fund_id: string
  fund_name: string
  domain: 'domestic_fund'
  behavioral_score: number
  sizing_multiplier_cap: number
  committee_confidence: number
  adjusted_size: number
  diagnostics: string[]
}

export type FundPhase7Map = Record<string, FundPhase7Entry>
