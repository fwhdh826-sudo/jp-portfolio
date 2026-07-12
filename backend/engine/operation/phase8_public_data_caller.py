"""
phase8_public_data_caller.py — P2-D3（Scope D）
Operation 層: Phase 8 raw .to_dict() → presentation → atomic JSON 書き込み
オーケストレーション。

責務:
  - write_frontier_index_presentation()      — frontier_index 出力
  - write_strategy_aggregate_presentation()   — strategy_aggregate 出力
  - write_opportunity_loss_presentation()     — opportunity_loss 出力
  - write_future_branching_presentation()     — future_branching 出力

各関数は次のチェーンを orchestrate する:
  adapt_*()                  （P2-D1-b adapter、raw→presentation dict）
  → build_presentation_document()（P2-D1-b、{_meta, payload} envelope）
  → write_json_atomic()      （Card D、explicit path への atomic write）
  → <output_dir>/<name>.json
  → 書き込んだ Path を返す

Scope D（本 Card 範囲、P1-D23-1）:
  caller foundation + tmp_path 統合テストのみ。**public/data には書かない**。
  output_dir は explicit 引数必須（hardcoded path / public/data デフォルトなし）。
  tests は tmp_path のみ。実 public/data write は P2-D2-actual（別ステップ）。

namespace 方針（P1-D23-2、本 Card では文書化のみ）:
  将来の実 public/data 出力先候補は public/data/phase8/*.json。
  public/data/contracts/v13.3 配下には置かない（Card 0-5 sample 層と分離）。
  本 Card では public/data/phase8 を作らない。caller は output_dir を受け取り、
  どこに書くかは呼び出し元（将来 P2-D2-actual / P2-D3-compute）の責務。

Flat DI 設計（P1-D23-4）:
  caller は raw .to_dict() 済み dict + 補助 DI を受け取り dict→Path の
  orchestration に限定。FrontierStrategy / StrategyAggregator / DD10 /
  PF builder 等の実 compute は呼ばない。Phase 8 dataclass を直接 import
  しない。adapter / write_json_atomic は import reuse のみ（変更しない）。

generated_at / source は caller 供給（P1-D23-9）:
  本モジュールは datetime.now() / time.time() を呼ばない（テスト決定論性）。
  not_for_trading は build_presentation_document が true 固定。

設計原則:
  - stdlib（pathlib / typing）+ P2-D1-b adapter + Card D write_json_atomic の
    import reuse のみ
  - pandas / numpy / scipy 禁止
  - Phase 8 dataclass / 実 compute（FrontierStrategy/Aggregator/DD10/PF builder）
    の直接 import・呼び出し禁止
  - public/data 書き込み禁止 / hardcoded path 禁止 /
    public/data デフォルトパス禁止
  - phase8_json_writer.py / phase8_presentation_adapter.py / src/types /
    React UI / .github / data の変更禁止
  - 実 HTTP / API / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止

P1 記録:
  P1-D23-1: Joint Readiness だが実装は P2-D3 caller + tmp_path 統合テストのみ。
  P1-D23-2: namespace は public/data/phase8/*.json。本 Card では書かず文書化のみ。
  P1-D23-3: caller 配置は backend/engine/operation/phase8_public_data_caller.py。
  P1-D23-4: caller は Flat DI。raw dict + 補助 DI 受領、実 compute 非呼出。
  P1-D23-5: presentation 出力は adapt_* → build_presentation_document →
            write_json_atomic。
  P1-D23-6: caller は explicit output_dir 必須。hardcoded / public/data
            デフォルトなし。
  P1-D23-7: tests は tmp_path のみ。public/data 非書き込み・no-public-path 検証。
  P1-D23-8: 4 出力サポートするが DI された分のみ書く。全 4 強制しない。
  P1-D23-9: generated_at/source/kind caller 供給、not_for_trading true、
            datetime.now() 不使用。

P2/P3 記録（後続）:
  P2-D2-actual: public/data/phase8 namespace ratify + 実 write。
  P2-D4: React UI を data/phase8/*.json に fetch 配線。
  P2-D5: GitHub Actions に Phase 8 public/data 生成を組み込む。
  P2-D3-compute: Operation 層で実 compute → caller へ DI する上位 orchestrator。
  P3-PA1-X: FrontierStrategy 側 identifier 公開定数 export。

Reference: backend/engine/operation/phase8_presentation_adapter.py（P2-D1-b）
Reference: backend/engine/frontier/phase8_json_writer.py（Card D write_json_atomic）
Reference: handover.md "P2-D2/P2-D3 Joint Readiness Review"
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.engine.frontier.phase8_json_writer import write_json_atomic
from backend.engine.operation.phase8_presentation_adapter import (
    adapt_frontier_index,
    adapt_future_branching,
    adapt_opportunity_loss,
    adapt_strategy_aggregate,
    build_presentation_document,
)


# ── 出力ファイル名 ────────────────────────────────────────────────────────────

_FILENAME_FRONTIER_INDEX:    str = "frontier_index.json"
_FILENAME_STRATEGY_AGGREGATE: str = "strategy_aggregate.json"
_FILENAME_OPPORTUNITY_LOSS:  str = "opportunity_loss.json"
_FILENAME_FUTURE_BRANCHING:  str = "future_branching.json"


# ── output_dir 解決（explicit 必須、hardcoded path なし）─────────────────────


def _resolve_output_path(output_dir: Any, filename: str) -> Path:
    """
    output_dir / filename を Path で返す。

    output_dir は explicit 必須。None / 空文字は ValueError。
    親ディレクトリ作成・atomic 書き込みは write_json_atomic が担う。
    """
    if output_dir is None:
        raise ValueError(
            "output_dir is required (no default; explicit path only)"
        )
    if isinstance(output_dir, str) and not output_dir:
        raise ValueError("output_dir must not be an empty string")
    return Path(output_dir) / filename


# ── frontier_index ────────────────────────────────────────────────────────────


def write_frontier_index_presentation(
    raw: dict,
    *,
    output_dir: Any,
    generated_at: str,
    source: str,
    cash_pct: float = 0.0,
    fund_pct: float = 0.0,
) -> Path:
    """
    FrontierIndex raw .to_dict() → presentation → <output_dir>/frontier_index.json。

    Returns:
        書き込んだ JSON の Path
    """
    presentation = adapt_frontier_index(
        raw,
        generated_at=generated_at,
        cash_pct=cash_pct,
        fund_pct=fund_pct,
    )
    document = build_presentation_document(
        presentation,
        kind="frontier_index",
        source=source,
        generated_at=generated_at,
    )
    path = _resolve_output_path(output_dir, _FILENAME_FRONTIER_INDEX)
    write_json_atomic(document, path)
    return path


# ── strategy_aggregate ────────────────────────────────────────────────────────


def write_strategy_aggregate_presentation(
    raw: dict,
    *,
    output_dir: Any,
    generated_at: str,
    source: str,
    timestamp: str,
    strategy_outputs: dict | None = None,
    dd10_uniform_return: float | None = None,
) -> Path:
    """
    StrategyAggregateResult raw → presentation → <output_dir>/strategy_aggregate.json。

    Returns:
        書き込んだ JSON の Path
    """
    presentation = adapt_strategy_aggregate(
        raw,
        timestamp=timestamp,
        strategy_outputs=strategy_outputs,
        dd10_uniform_return=dd10_uniform_return,
    )
    document = build_presentation_document(
        presentation,
        kind="strategy_aggregate",
        source=source,
        generated_at=generated_at,
    )
    path = _resolve_output_path(output_dir, _FILENAME_STRATEGY_AGGREGATE)
    write_json_atomic(document, path)
    return path


# ── opportunity_loss ──────────────────────────────────────────────────────────


def write_opportunity_loss_presentation(
    raw: dict,
    *,
    output_dir: Any,
    generated_at: str,
    source: str,
) -> Path:
    """
    OpportunityLossResult raw → presentation → <output_dir>/opportunity_loss.json。

    Returns:
        書き込んだ JSON の Path
    """
    presentation = adapt_opportunity_loss(raw)
    document = build_presentation_document(
        presentation,
        kind="opportunity_loss",
        source=source,
        generated_at=generated_at,
    )
    path = _resolve_output_path(output_dir, _FILENAME_OPPORTUNITY_LOSS)
    write_json_atomic(document, path)
    return path


# ── future_branching ──────────────────────────────────────────────────────────


def write_future_branching_presentation(
    raw: dict,
    *,
    output_dir: Any,
    generated_at: str,
    source: str,
) -> Path:
    """
    FutureBranchingResult raw → presentation → <output_dir>/future_branching.json。

    Returns:
        書き込んだ JSON の Path
    """
    presentation = adapt_future_branching(raw)
    document = build_presentation_document(
        presentation,
        kind="future_branching",
        source=source,
        generated_at=generated_at,
    )
    path = _resolve_output_path(output_dir, _FILENAME_FUTURE_BRANCHING)
    write_json_atomic(document, path)
    return path
