"""
regime_axis_weights.py — Card 6-1
Phase 6 Dynamic Weight Engine: レジーム別6軸重みテーブル。

責務:
  - CANONICAL_AXES       — 6軸の正規 ID タプル（定義順）
  - VALID_REGIMES        — 有効レジーム名タプル
  - REGIME_AXIS_WEIGHTS  — レジーム → 軸重み dict（変更禁止の定数）
  - get_axis_weights()   — レジーム文字列を受け取り shallow copy を返す
  - validate_axis_weights()          — 単一重み dict の妥当性検証
  - validate_all_regime_axis_weights() — 全レジームの妥当性一括検証

get_axis_weights 仕様:
  - 引数: regime: str
  - 既知レジーム → 対応する重み dict の shallow copy を返す
  - 未知レジーム → "uncertain" の shallow copy を fallback として返す
  - 戻り値を書き換えても REGIME_AXIS_WEIGHTS 定数は変化しない
  - scoring / regime / decision / market_intel / news / operation を import しない
  - regime は str として DI で受け取る（外部モジュールに依存しない）

validate_axis_weights 仕様:
  - 6軸すべてが存在すること
  - 各 weight が 0.0 < weight <= 1.0 であること
  - abs(sum(values()) - 1.0) < 1e-9 であること
  - 条件を満たせば True、1つでも違反すれば False

weight 合計仕様:
  - 全レジームで sum(weights.values()) が 1.0 に近似（abs < 1e-9）
  - uncertain: 0.17×5 + 0.15 = 1.00（Python float: 0.85 + 0.15 = 1.00）
  - crisis:    0.15+0.25+0.05+0.40+0.05+0.10 = 1.00

実装しないこと:
  - calc_total_score_dynamic()（rating フィールドを返す仕様のため）
  - rating / S / A / B / C / D ラベル（判断フィールド相当）
  - BUY / SELL / HOLD / WAIT 判定
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended
  - get_strategy_weights() / get_time_horizon_weights()（Card 6-2/6-3）
  - 銘柄推奨・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / regime / decision / market_intel / news / operation の import
  - public/data writer

Reference: docs/constitution/REGIME.md Section 5
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-1
Reference: docs/v13.3/07_v13.3_spec.md Section 4.1
"""
from __future__ import annotations

# ── 定数 ─────────────────────────────────────────────────────────────────────

CANONICAL_AXES: tuple[str, ...] = (
    "value",
    "quality",
    "growth",
    "safety",
    "momentum",
    "shareholder_return",
)

# レジーム別 6軸重みテーブル（変更禁止）
# 出典: docs/constitution/REGIME.md §5 / 06_instructions Card 6-1 / 07_spec.md §4.1
# 全レジームで sum(weights.values()) == 1.0（abs < 1e-9 で検証済み）
REGIME_AXIS_WEIGHTS: dict[str, dict[str, float]] = {
    "bull_calm": {
        "value":             0.20,
        "quality":           0.15,
        "growth":            0.20,
        "safety":            0.10,
        "momentum":          0.20,
        "shareholder_return":0.15,
    },
    "bull_volatile": {
        "value":             0.15,
        "quality":           0.20,
        "growth":            0.15,
        "safety":            0.15,
        "momentum":          0.25,
        "shareholder_return":0.10,
    },
    "bear": {
        "value":             0.20,
        "quality":           0.25,
        "growth":            0.10,
        "safety":            0.25,
        "momentum":          0.05,
        "shareholder_return":0.15,
    },
    "crisis": {
        "value":             0.15,
        "quality":           0.25,
        "growth":            0.05,
        "safety":            0.40,
        "momentum":          0.05,
        "shareholder_return":0.10,
    },
    "uncertain": {
        "value":             0.17,
        "quality":           0.17,
        "growth":            0.17,
        "safety":            0.17,
        "momentum":          0.17,
        "shareholder_return":0.15,
    },
}

VALID_REGIMES: tuple[str, ...] = tuple(REGIME_AXIS_WEIGHTS.keys())


# ── 公開 API ─────────────────────────────────────────────────────────────────

def get_axis_weights(regime: str) -> dict[str, float]:
    """
    レジーム文字列 → 6軸重み dict（shallow copy）。

    未知レジームは "uncertain" にフォールバック。
    戻り値を変更しても REGIME_AXIS_WEIGHTS 定数は破壊されない。

    Args:
        regime: レジーム文字列（"bull_calm" / "bull_volatile" / "bear" / "crisis" / "uncertain"）
    Returns:
        dict[str, float]: 6軸名 → 重み の shallow copy
    """
    source = REGIME_AXIS_WEIGHTS.get(regime, REGIME_AXIS_WEIGHTS["uncertain"])
    return dict(source)


def validate_axis_weights(weights: dict[str, float]) -> bool:
    """
    軸重み dict の妥当性を検証する。

    条件:
      1. 6軸（CANONICAL_AXES）がすべて存在すること
      2. 各 weight が 0.0 < weight <= 1.0 であること
      3. abs(sum(values()) - 1.0) < 1e-9 であること

    Args:
        weights: 検証対象の軸重み dict
    Returns:
        bool: すべての条件を満たすとき True
    """
    if not isinstance(weights, dict):
        return False

    # 条件1: 6軸すべて存在
    for axis in CANONICAL_AXES:
        if axis not in weights:
            return False

    # 条件2: 各重みが範囲内
    for w in weights.values():
        try:
            fv = float(w)
        except (TypeError, ValueError):
            return False
        if not (0.0 < fv <= 1.0):
            return False

    # 条件3: 合計が 1.0 に近似
    total = sum(float(w) for w in weights.values())
    if abs(total - 1.0) >= 1e-9:
        return False

    return True


def validate_all_regime_axis_weights() -> bool:
    """
    REGIME_AXIS_WEIGHTS 全レジームの妥当性を一括検証する。

    Returns:
        bool: 全レジームで validate_axis_weights() が True のとき True
    """
    for regime, weights in REGIME_AXIS_WEIGHTS.items():
        if not validate_axis_weights(weights):
            return False
    return True
