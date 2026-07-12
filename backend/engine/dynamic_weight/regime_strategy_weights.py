"""
regime_strategy_weights.py — Card 6-2
Phase 6 Dynamic Weight Engine: レジーム別戦略重みテーブル。

責務:
  - CANONICAL_STRATEGIES     — 4戦略の正規 ID タプル（定義順）
  - VALID_REGIMES            — 有効レジーム名タプル
  - REGIME_STRATEGY_WEIGHTS  — レジーム → 戦略重み dict（変更禁止の定数）
  - get_strategy_weights()   — レジーム文字列を受け取り shallow copy を返す
  - validate_strategy_weights()              — 単一重み dict の妥当性検証
  - validate_all_regime_strategy_weights()   — 全レジームの妥当性一括検証

get_strategy_weights 仕様:
  - 引数: regime: str
  - 既知レジーム → 対応する重み dict の shallow copy を返す
  - 未知レジーム → "uncertain" の shallow copy を fallback として返す
  - 戻り値を書き換えても REGIME_STRATEGY_WEIGHTS 定数は変化しない
  - 各呼び出しが独立オブジェクトを返す

validate_strategy_weights 仕様:
  - CANONICAL_STRATEGIES（4戦略）がすべて存在すること
  - 各 weight が 0.0 < weight <= 1.0 であること
  - CANONICAL_STRATEGIES の4戦略のみで sum を計算し abs(sum - 1.0) < 1e-9 であること
  - 余分なキーは許容する（将来の戦略追加で既存テーブルが invalid にならないため）
  - 余分なキーの weight は sum 判定に含めない
  - 条件を満たせば True、1つでも違反すれば False

weight 合計仕様:
  - 全レジームで canonical 4戦略の sum が 1.0 に近似（abs < 1e-9）
  - 余分なキーが存在する場合でも canonical 4戦略の sum のみで判定

実装しないこと:
  - strategy 実装本体（FrontierStrategy 等）: Card 7-2〜7-5 の範囲
  - calc_total_score_dynamic(): rating フィールドを返す仕様のため
  - rating / S / A / B / C / D ラベル: 判断フィールド相当
  - BUY / SELL / HOLD / WAIT 判定
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended
  - get_axis_weights()（Card 6-1 済み）/ get_time_horizon_weights()（Card 6-3）
  - aggregate() / correlations: Card 7-6 Aggregator の範囲
  - 銘柄推奨・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / decision / regime / operation / market_intel / news の import
  - public/data writer

[P2-6B] 余分キー許容仕様は Card 7-6 Aggregator 配線時に再確認が必要。
  将来戦略追加時に「余分キーの weight を合計に含めないまま」でよいか検討。

Reference: docs/constitution/REGIME.md Section 6
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-2
Reference: docs/v13.3/07_v13.3_spec.md Section 4.2
"""
from __future__ import annotations

# ── 定数 ─────────────────────────────────────────────────────────────────────

CANONICAL_STRATEGIES: tuple[str, ...] = (
    "frontier",
    "quality_size",
    "fundamental",
    "cross_factor",
)

# レジーム別 戦略重みテーブル（変更禁止）
# 出典: docs/constitution/REGIME.md §6 / 06_instructions Card 6-2 / 07_spec.md §4.2
# canonical 4戦略の sum(weights) == 1.0（abs < 1e-9 で検証済み）
REGIME_STRATEGY_WEIGHTS: dict[str, dict[str, float]] = {
    "bull_calm": {
        "frontier":     0.40,
        "quality_size": 0.25,
        "fundamental":  0.20,
        "cross_factor": 0.15,
    },
    "bull_volatile": {
        "frontier":     0.30,
        "quality_size": 0.20,
        "fundamental":  0.30,
        "cross_factor": 0.20,
    },
    "bear": {
        "frontier":     0.50,
        "quality_size": 0.10,
        "fundamental":  0.15,
        "cross_factor": 0.25,
    },
    "crisis": {
        "frontier":     0.70,
        "quality_size": 0.05,
        "fundamental":  0.05,
        "cross_factor": 0.20,
    },
    "uncertain": {
        "frontier":     0.40,
        "quality_size": 0.20,
        "fundamental":  0.20,
        "cross_factor": 0.20,
    },
}

VALID_REGIMES: tuple[str, ...] = tuple(REGIME_STRATEGY_WEIGHTS.keys())


# ── 公開 API ─────────────────────────────────────────────────────────────────

def get_strategy_weights(regime: str) -> dict[str, float]:
    """
    レジーム文字列 → 戦略重み dict（shallow copy）。

    未知レジームは "uncertain" にフォールバック。
    戻り値を変更しても REGIME_STRATEGY_WEIGHTS 定数は破壊されない。

    Args:
        regime: レジーム文字列（"bull_calm" / "bull_volatile" / "bear" / "crisis" / "uncertain"）
    Returns:
        dict[str, float]: 戦略名 → 重み の shallow copy
    """
    source = REGIME_STRATEGY_WEIGHTS.get(regime, REGIME_STRATEGY_WEIGHTS["uncertain"])
    return dict(source)


def validate_strategy_weights(weights: dict[str, float]) -> bool:
    """
    戦略重み dict の妥当性を検証する。

    条件:
      1. CANONICAL_STRATEGIES（4戦略）がすべて存在すること
      2. CANONICAL_STRATEGIES に含まれる各 weight が 0.0 < weight <= 1.0 であること
      3. CANONICAL_STRATEGIES の4戦略のみで sum を計算し abs(sum - 1.0) < 1e-9 であること

    余分なキーは許容する（将来の戦略追加で既存テーブルが invalid にならないため）。
    余分なキーの weight は sum 判定に含めない。

    Args:
        weights: 検証対象の戦略重み dict
    Returns:
        bool: すべての条件を満たすとき True
    """
    if not isinstance(weights, dict):
        return False

    # 条件1: canonical 4戦略すべて存在
    for strategy in CANONICAL_STRATEGIES:
        if strategy not in weights:
            return False

    # 条件2: canonical 戦略の各重みが範囲内
    for strategy in CANONICAL_STRATEGIES:
        try:
            fv = float(weights[strategy])
        except (TypeError, ValueError):
            return False
        if not (0.0 < fv <= 1.0):
            return False

    # 条件3: canonical 4戦略のみで合計が 1.0 に近似（余分キーは除外）
    canonical_sum = sum(float(weights[s]) for s in CANONICAL_STRATEGIES)
    if abs(canonical_sum - 1.0) >= 1e-9:
        return False

    return True


def validate_all_regime_strategy_weights() -> bool:
    """
    REGIME_STRATEGY_WEIGHTS 全レジームの妥当性を一括検証する。

    Returns:
        bool: 全レジームで validate_strategy_weights() が True のとき True
    """
    for regime, weights in REGIME_STRATEGY_WEIGHTS.items():
        if not validate_strategy_weights(weights):
            return False
    return True
