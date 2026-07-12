// ═══════════════════════════════════════════════════════════
// Phase 8 Presentation Types — v13.3 / P2-D1-a
// 参照: handover.md "P2-D1 schema reconcile 決定" / "P2-D1-a Readiness Review"
//
// 方式1 Adapter 層（P2-D1 確定）:
//   Phase 8 backend の raw .to_dict() 出力（FrontierIndex /
//   StrategyAggregateResult / OpportunityLossResult /
//   FutureBranchingResult）は computation snapshot であり、本 frontend
//   境界には置かない。Operation 層 adapter（P2-D1-b、後続）が raw を
//   下記 presentation schema へ変換し、public/data 経由（P2-D2）で
//   React UI（P2-D4）が消費する。
//
//   raw schema と presentation schema を混同しない。本ファイルは
//   adapter の出力 / UI の入力契約のみを定義する（presentation 型のみ、
//   raw 型は含めない）。
//
// strategy_aggregate:
//   既存 src/types/strategy.ts の StrategyAggregated（strategy_aggregated.json
//   準拠）を再利用する。再定義しない（P1-D1a-2）。
//
// frontier_index:
//   Card 0-5 public/data/contracts/v13.3/frontier/frontier_index.json 整合
//   （constituents / total_weight / cash_pct / fund_pct）。adapter が raw
//   tickers[] + weights[] を constituents へ畳み込む前提（P1-D1a-3）。
//
// opportunity_loss / future_branching:
//   既存 contracts / src/types に対応型なし → net-new presentation 設計
//   （P1-D1a-4）。
//
// Phase8Document<T>:
//   Card D writer の raw envelope とは別に、adapter 後 presentation 出力の
//   _meta 付き型境界として使う（P1-D1a-5/6）。
// ═══════════════════════════════════════════════════════════

import type { RegimeId } from './regime'
import type { StrategyAggregated } from './strategy'

/**
 * Phase 8 出力 JSON の _meta ブロック。
 * Card D writer（backend/engine/frontier/phase8_json_writer.py の
 * build_phase8_document）および Card 0-5 contracts の _meta と整合。
 * not_for_trading は常に true（観察値・非売買命令）。
 */
export interface Phase8Meta {
  version: string
  kind: string
  source: string
  generated_at: string
  not_for_trading: boolean
}

/**
 * Frontier AI Index の presentation schema。
 * Card 0-5 frontier_index.json 整合。
 * constituents は adapter が raw tickers[] + weights[] を畳み込んだ
 * { ticker: weight } マップ。total_weight / cash_pct / fund_pct は
 * Operation 層 adapter が PF 集約値として合成する。
 */
export interface FrontierIndexPresentation {
  generated_at: string
  regime: RegimeId
  constituents: Record<string, number>
  total_weight: number
  cash_pct: number
  fund_pct: number
  expected_return: number
  expected_vol: number
  sharpe_ratio: number
  diagnostics: string[]
}

/**
 * Opportunity Loss の presentation schema（net-new）。
 * weight_drift は adapter が raw weight_drift_per_ticker（[ticker, drift][]）
 * を { ticker: drift } マップへ整形したもの。
 * return gap 群は比較値であり実現損失ではない（観察値）。
 */
export interface OpportunityLossPresentation {
  weight_drift: Record<string, number>
  total_drift_l1: number
  total_drift_l2: number
  constraint_return_gap: number
  drift_return_gap: number
  estimated_opportunity_return_gap: number
  regime: RegimeId
  diagnostics: string[]
}

/**
 * Future Branching の 1 regime 分岐 presentation schema（net-new）。
 * scenario calculation であり予測ではない（観察値）。
 */
export interface FutureBranchPresentation {
  regime: RegimeId
  expected_return: number
  expected_vol: number
  sharpe_ratio: number
  max_dd_estimate: number
  downside_case: number
  upside_case: number
  probability: number
  is_base_regime: boolean
}

/**
 * Future Branching 全体の presentation schema（net-new）。
 * weighted_expected_vol は線形加重和（covariance-aware ではない）。
 */
export interface FutureBranchingPresentation {
  branches: FutureBranchPresentation[]
  base_regime: RegimeId
  weighted_expected_return: number
  weighted_expected_vol: number
  worst_case_dd: number
  worst_case_downside: number
  best_case_upside: number
  diagnostics: string[]
}

/**
 * adapter 後 presentation 出力の _meta 付きドキュメント型境界。
 * Card D writer の raw envelope（{_meta, <payload_key>}）とは別系統で、
 * adapter（P2-D1-b）が presentation payload を本型で公開する想定。
 */
export interface Phase8Document<T> {
  _meta: Phase8Meta
  payload: T
}

// strategy_aggregate の presentation は既存 StrategyAggregated を再利用する。
// phase8.ts 単体名前空間としても解決できるよう re-export する。
// （src/types/index.ts では StrategyAggregated を ./strategy から既に
//   re-export しているため、index.ts では phase8 経由で再 re-export しない＝
//   重複 export 衝突回避、P1-D1a-6）。
export type { StrategyAggregated }
