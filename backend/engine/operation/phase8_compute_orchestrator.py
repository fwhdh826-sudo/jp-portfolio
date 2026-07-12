"""
phase8_compute_orchestrator.py — P2-D3-compute（Scope C）
Operation 層: Phase 8 raw → presentation public-data の thin batch orchestrator。

責務:
  - orchestrate_phase8_public_data() — 4 出力の per-output caller を batch 集約

Scope C（本 Card 範囲、P1-D3c-1）:
  実 compute は **一切呼ばない**（thin Flat-DI orchestrator）。
  raw .to_dict() 済み dict + 補助 DI を受け取り、既存
  phase8_public_data_caller.py の 4 write 関数を import reuse して
  batch 呼び出す薄い coordination 層。public/data には書かない
  （caller が output_dir 引数へ atomic write、tests は tmp_path）。

D 案（実 compute）= No-Go（別 Card、P3-Frontier-expose / P2-D3-compute-actual）:
  - FrontierStrategy.compute() は StrategyOutput のみ返し FrontierIndex を
    外部露出しない（frontier_index raw 取得不能）
  - 実 compute は 4 戦略 + frontier pipeline + scipy + Aggregator + DD10 +
    PF builder が必要で依存範囲が広すぎる
  - FrontierIndex 露出 Card を前提とする多段 effort のため分離

E 案（public/data 実 write）= No-Go（別 Card、P2-D2-actual）:
  - public/data/phase8 namespace 未 ratify
  - rollback / stale / schema-version / UI-consumer 整備とセットで別 Card 化

Flat DI 設計（P1-D3c-2）:
  FrontierStrategy / StrategyAggregator / IndexBuilder / DD10Calculator /
  JpEquityPfBuilder / FundPfBuilder / UnifiedView / ExpectedReturnModel /
  CovarianceModel / EfficientFrontierOptimizer / OpportunityLossCalculator /
  FutureBranchingCalculator を **import せず・呼ばない**。
  既存 caller（phase8_public_data_caller）の 4 write 関数のみ import reuse。
  caller / adapter / writer は変更しない。

partial 出力（P1-D3c-3）:
  *_raw が None のものは出力しない。DI された raw のみ caller へ渡す。
  全 4 出力を強制しない。戻り値は書いた分だけの dict[str, Path]。

generated_at / source は caller 供給（P1-D3c-4）:
  本モジュールは datetime.now() / time.time() を呼ばない。
  output_dir は keyword-only・デフォルトなし（explicit 必須）。
  not_for_trading は caller 側 build_presentation_document が true 固定。

設計原則:
  - stdlib（pathlib / typing）+ phase8_public_data_caller の import reuse のみ
  - pandas / numpy / scipy 禁止
  - 実 compute モジュールの直接 import・呼び出し禁止
  - public/data 書き込み禁止 / hardcoded path 禁止 /
    public/data デフォルトパス禁止
  - caller / adapter / writer / src/types / React UI / .github / data 変更禁止
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止

P1 記録:
  P1-D3c-1: Scope C。phase8_compute_orchestrator.py 新設、実 compute 非呼出。
  P1-D3c-2: Flat DI。4 raw dict + 補助 DI 受領。実 compute モジュール非 import。
  P1-D3c-3: 既存 caller 4 関数を batch 集約。partial 出力、全 4 強制しない。
  P1-D3c-4: explicit output_dir 必須。hardcoded path / public/data デフォルト
            なし。datetime.now() 不使用。
  P1-D3c-5: tests は tmp_path のみ。public/data 非書き込み・no-public-path・
            Flat DI（compute 非呼出）AST 検証。
  P1-D3c-6: caller / adapter / writer は import reuse のみ、変更しない。

P2/P3 記録（後続）:
  P3-Frontier-expose: FrontierStrategy が FrontierIndex raw を露出する Card。
  P2-D3-compute-actual: 実 compute orchestration（P3-Frontier-expose 後、多段）。
  P2-D2-actual: public/data/phase8 namespace ratify + 実 write。
  P2-D4: React UI を data/phase8/*.json に fetch 配線。
  P2-D5: GitHub Actions に Phase 8 public/data 生成を組み込む。
  P3-PA1-X: FrontierStrategy 側 identifier 公開定数 export（独立・小規模）。

Reference: backend/engine/operation/phase8_public_data_caller.py（P2-D3）
Reference: handover.md "P2-D3-compute Readiness Review"
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.engine.operation.phase8_public_data_caller import (
    write_frontier_index_presentation,
    write_future_branching_presentation,
    write_opportunity_loss_presentation,
    write_strategy_aggregate_presentation,
)


# ── 出力 kind キー ────────────────────────────────────────────────────────────

_KIND_FRONTIER_INDEX:    str = "frontier_index"
_KIND_STRATEGY_AGGREGATE: str = "strategy_aggregate"
_KIND_OPPORTUNITY_LOSS:  str = "opportunity_loss"
_KIND_FUTURE_BRANCHING:  str = "future_branching"


def orchestrate_phase8_public_data(
    *,
    output_dir: Any,
    generated_at: str,
    source: str,
    frontier_index_raw: dict | None = None,
    frontier_cash_pct: float = 0.0,
    frontier_fund_pct: float = 0.0,
    strategy_aggregate_raw: dict | None = None,
    strategy_aggregate_timestamp: str | None = None,
    strategy_outputs: dict | None = None,
    dd10_uniform_return: float | None = None,
    opportunity_loss_raw: dict | None = None,
    future_branching_raw: dict | None = None,
) -> dict[str, Path]:
    """
    DI された raw .to_dict() 出力を per-output caller へ batch で渡す。

    実 compute は一切呼ばない（Scope C）。raw が None の出力はスキップする
    （partial 許容、全 4 強制しない）。output_dir / generated_at / source の
    実バリデーション（non-empty 等）は caller 側に委譲する。

    Args:
        output_dir:                   出力ディレクトリ（explicit 必須、caller へ pass-through）
        generated_at:                 _meta.generated_at（caller 供給）
        source:                       _meta.source（caller 供給）
        frontier_index_raw:           FrontierIndex.to_dict()（None ならスキップ）
        frontier_cash_pct/fund_pct:   frontier_index 補助 DI
        strategy_aggregate_raw:       StrategyAggregateResult.to_dict()（None ならスキップ）
        strategy_aggregate_timestamp: StrategyAggregated.timestamp。
                                      strategy_aggregate_raw がある場合は必須
                                      （None なら ValueError）
        strategy_outputs:             strategy_aggregate 補助 DI（4 戦略個別出力）
        dd10_uniform_return:          strategy_aggregate 補助 DI（DD-10% KPI）
        opportunity_loss_raw:         OpportunityLossResult.to_dict()（None ならスキップ）
        future_branching_raw:         FutureBranchingResult.to_dict()（None ならスキップ）

    Returns:
        書き込んだ分の {kind: Path}。raw が None の kind は含まない。

    Raises:
        ValueError: strategy_aggregate_raw が与えられ
                    strategy_aggregate_timestamp が None の場合
        その他のバリデーション例外は caller（write_*）が送出する
    """
    written: dict[str, Path] = {}

    if frontier_index_raw is not None:
        written[_KIND_FRONTIER_INDEX] = write_frontier_index_presentation(
            frontier_index_raw,
            output_dir=output_dir,
            generated_at=generated_at,
            source=source,
            cash_pct=frontier_cash_pct,
            fund_pct=frontier_fund_pct,
        )

    if strategy_aggregate_raw is not None:
        if strategy_aggregate_timestamp is None:
            raise ValueError(
                "strategy_aggregate_timestamp is required when "
                "strategy_aggregate_raw is provided"
            )
        written[_KIND_STRATEGY_AGGREGATE] = write_strategy_aggregate_presentation(
            strategy_aggregate_raw,
            output_dir=output_dir,
            generated_at=generated_at,
            source=source,
            timestamp=strategy_aggregate_timestamp,
            strategy_outputs=strategy_outputs,
            dd10_uniform_return=dd10_uniform_return,
        )

    if opportunity_loss_raw is not None:
        written[_KIND_OPPORTUNITY_LOSS] = write_opportunity_loss_presentation(
            opportunity_loss_raw,
            output_dir=output_dir,
            generated_at=generated_at,
            source=source,
        )

    if future_branching_raw is not None:
        written[_KIND_FUTURE_BRANCHING] = write_future_branching_presentation(
            future_branching_raw,
            output_dir=output_dir,
            generated_at=generated_at,
            source=source,
        )

    return written
