"""
Six-axis score orchestrator — composes the 5 fundamentals scorers and
the momentum scorer into a single Flat-DI dict-in / dict-out pure
compute entry. No file I/O, no network, no public/data writer.

公開 API:
  compute_axis_scores(*, ticker, financial_data, diagnostics_extra=None)
    -> {"ticker": str,
        "axes": {<6 axis>: AxisScore.to_dict()},
        "diagnostics": [str, ...]}

設計原則:
  - Flat-DI dict-in / dict-out。pure compute。
  - 既存 6 scorer（value/safety/shareholder_return/quality/growth/
    momentum）を compose するのみ。scorer は不変・継承/拡張しない。
  - 各 scorer は受け取った financial_data の余分なキーを無視し、
    自身の COMPONENT_WEIGHTS キーのみを _get_raw で参照する。
    欠損キーは scorer の MISSING_RAW_VALUES 中立 raw 値へ委譲。
    本 orchestrator は介入せず素通し。
  - file I/O / HTTP / 外部 API / pandas / numpy / pathlib / os は
    一切 import しない。public/data writer も持たない。
  - data/update_scores.py との接続・public/data/scoring 出力・
    update_phase8 scores migration・phase8 実 write は本モジュールの
    責務外（後続 Card）。

caller 責任（本モジュールでは行わない）:
  - volatility_252d を public/data/returns.json 由来の日次 returns
    から導出し financial_data に注入。
  - momentum 5 component（trend_score / ma_spread / credit_ratio /
    volume_z / relative_strength）を technical_suite 等で 0–100 に
    変換済みの値として financial_data に注入。caller が注入しない
    場合は scorer の MISSING_RAW_VALUES(50.0) → 中立 50 norm。
  - 4 passthrough component（moat_score / earnings_stab / guidance /
    tam_expansion）は別 upstream で 0–100 値を注入。不在なら同様に
    中立 50。

honesty:
  - 出力 scores は partial-real / hybrid（fundamentals 19 + caller
    注入の volatility_252d + caller 注入の 9 passthrough/technical /
    残りは scorer MISSING 中立）。
  - full real / full generated とは呼ばない。
  - data/fundamentals.json 由来部分は yfinance 1.2.0 単発スナップ
    ショットの lower bound（generated_at 時点）。
  - 金融・leasing セクターでは de_ratio / fcf_yield / equity_ratio
    が bounded だが意味的に低スコアになりやすい（documented hybrid
    limitation）。doe / buyback_yield / eps_growth_3y の scorer
    内部 normalize は飽和しやすく discrimination が低下する場合が
    ある（同じく bounded）。
  - 投資判断・銘柄推奨・PF 最適化・売買指示ではない。
    BUY / SELL / HOLD / WAIT 禁止、action / 推奨 / 判定ラベル禁止、
    rebalance_order / 具体株数金額 禁止。

Reference: backend/engine/scoring/{value,safety,shareholder_return,
           quality,growth,momentum}_score.py（不変）
Reference: handover.md「fundamentals result validation 監査結果」
"""
from __future__ import annotations

from typing import Any, Iterable

from backend.engine.scoring.growth_score import GrowthScorer
from backend.engine.scoring.momentum_score import MomentumScorer
from backend.engine.scoring.quality_score import QualityScorer
from backend.engine.scoring.safety_score import SafetyScorer
from backend.engine.scoring.shareholder_return_score import (
    ShareholderReturnScorer,
)
from backend.engine.scoring.value_score import ValueScorer

# 軸 ID 列挙（出力 axes キーの順序と一致）
AXIS_IDS: tuple[str, ...] = (
    "value", "safety", "shareholder_return", "quality", "growth", "momentum",
)

# 恒常診断文言（honesty / hybrid limitation の固定観察）
_DIAGNOSTICS_BASE: tuple[str, ...] = (
    "observation: scores are partial-real / hybrid "
    "(not full real / not full generated)",
    "observation: missing components fall back to scorer "
    "MISSING_RAW_VALUES neutral",
    "observation: financial-sector tickers may show bounded "
    "de_ratio/fcf_yield/equity_ratio distortion",
    "observation: momentum components are technical-deferred "
    "(financial_data 不在→中立 50)",
    "observation: volatility_252d expects caller-supplied value "
    "derived from returns.json",
)


def compute_axis_scores(
    *,
    ticker: str,
    financial_data: dict,
    diagnostics_extra: Iterable[str] | None = None,
) -> dict:
    """
    6 軸 scorer を Flat-DI で compose し dict-out を返す pure 関数。

    Args:
        ticker: 銘柄コード。各 scorer.calculate へ渡し、出力 dict にも
                含める。スコア値には影響しない（scorer 内部で説明等に
                使われるのみ）。
        financial_data: 29 component の present-or-absent dict。
                各 scorer は自身の COMPONENT_WEIGHTS キーのみを参照
                する（余分キー無視）。欠損キーは scorer の
                MISSING_RAW_VALUES 中立委譲。本 orchestrator は介入
                しない。dict でない場合は空 dict に正規化。
        diagnostics_extra: caller 任意の追加観察文。文字列のみ末尾に
                挿入（空文字列・非文字列は除外）。

    Returns:
        {"ticker": str, "axes": {<6 axis>: AxisScore.to_dict()},
         "diagnostics": [str, ...]}

    pure compute：file I/O / HTTP / 外部 API は一切呼ばない。
    投資注文・売買指示ではない（partial-real / hybrid 観察値）。
    """
    fd: dict = financial_data if isinstance(financial_data, dict) else {}

    axes: dict[str, dict] = {
        "value": ValueScorer().calculate(ticker, fd).to_dict(),
        "safety": SafetyScorer().calculate(ticker, fd).to_dict(),
        "shareholder_return": ShareholderReturnScorer().calculate(
            ticker, fd
        ).to_dict(),
        "quality": QualityScorer().calculate(ticker, fd).to_dict(),
        "growth": GrowthScorer().calculate(ticker, fd).to_dict(),
        "momentum": MomentumScorer().calculate(ticker, fd).to_dict(),
    }

    diagnostics: list[str] = list(_DIAGNOSTICS_BASE)
    if diagnostics_extra is not None:
        for d in diagnostics_extra:
            if isinstance(d, str) and d:
                diagnostics.append(d)

    return {
        "ticker": str(ticker),
        "axes": axes,
        "diagnostics": diagnostics,
    }
