"""
time_horizon_weights.py — Card 6-3
Phase 6 Dynamic Weight Engine: 時間軸別因子重みテーブル。

責務:
  - SHORT_TERM_FACTORS      — short_term の canonical 因子タプル（6因子）
  - LONG_TERM_FACTORS       — long_term の canonical 因子タプル（6因子）
  - HORIZON_FACTORS         — horizon → canonical 因子タプル の dict
  - VALID_HORIZONS          — 有効 horizon 名タプル
  - TIME_HORIZON_WEIGHTS    — horizon → 因子重み dict（変更禁止の定数）
  - get_time_horizon_weights()          — horizon 文字列を受け取り shallow copy を返す
  - validate_time_horizon_weights()     — 単一重み dict + horizon の妥当性検証（2引数）
  - validate_all_time_horizon_weights() — 全 horizon の妥当性一括検証

get_time_horizon_weights 仕様:
  - 引数: horizon: str
  - 既知 horizon → 対応する重み dict の shallow copy を返す
  - 未知 horizon → "long_term" の shallow copy を fallback として返す
  - 戻り値を書き換えても TIME_HORIZON_WEIGHTS 定数は変化しない
  - 各呼び出しが独立オブジェクトを返す

validate_time_horizon_weights 仕様:
  - 引数: weights: dict[str, float], horizon: str（2引数）
  - horizon が VALID_HORIZONS に含まれない → False
  - HORIZON_FACTORS[horizon] の canonical 因子がすべて存在すること
  - 各 canonical weight が 0.0 < weight <= 1.0 であること
  - HORIZON_FACTORS[horizon] の canonical 因子のみで sum を計算し abs(sum - 1.0) < 1e-9 であること
  - 余分なキーは許容する（将来の因子追加で既存テーブルが invalid にならないため）
  - 余分なキーの weight は sum 判定に含めない
  - 条件を満たせば True、1つでも違反すれば False

short_term / long_term の canonical 因子は異なるため HORIZON_FACTORS で管理。
共通因子: fundamental, factor_cross, regime
short_term 専用: technical_momentum, flow_microstructure, sentiment
long_term 専用:  quality_value, growth, shareholder_return

実装しないこと:
  - strategy / axis 実装本体: Card 7 の範囲
  - short_long_split.py: 別モジュール（将来 Card）
  - calc_total_score_dynamic(): rating フィールドを返す仕様のため
  - rating / S / A / B / C / D ラベル: 判断フィールド相当
  - BUY / SELL / HOLD / WAIT 判定
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended
  - get_axis_weights()（Card 6-1 済み）/ get_strategy_weights()（Card 6-2 済み）
  - aggregate() / correlations: Card 7-6 Aggregator の範囲
  - 銘柄推奨・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / decision / regime / operation / market_intel / news の import
  - public/data writer

[P2-6C] 未知 horizon の fallback は "long_term"（短期よりも保守的・基本的なため）。
[P2-6D] validate_time_horizon_weights は 2引数（weights, horizon）— Card 6-1/6-2 の 1引数とは異なる。
         horizon ごとに canonical 因子セットが異なるため、どの因子セットで検証するか明示が必要。
[P2-6E] short_term / long_term は因子セットが異なるが各 6因子の sum == 1.0 の制約は共通。
         余分キーは Card 6-2 同様に許容し、canonical 因子のみ sum 検証する。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-3
Reference: docs/v13.3/07_v13.3_spec.md Section 4.3
"""
from __future__ import annotations

# ── 定数 ─────────────────────────────────────────────────────────────────────

SHORT_TERM_FACTORS: tuple[str, ...] = (
    "technical_momentum",
    "flow_microstructure",
    "sentiment",
    "fundamental",
    "factor_cross",
    "regime",
)

LONG_TERM_FACTORS: tuple[str, ...] = (
    "fundamental",
    "factor_cross",
    "quality_value",
    "growth",
    "shareholder_return",
    "regime",
)

HORIZON_FACTORS: dict[str, tuple[str, ...]] = {
    "short_term": SHORT_TERM_FACTORS,
    "long_term":  LONG_TERM_FACTORS,
}

VALID_HORIZONS: tuple[str, ...] = ("short_term", "long_term")

# horizon 別 因子重みテーブル（変更禁止）
# 出典: docs/v13.3/06_instructions Card 6-3 / 07_spec.md §4.3
# 各 horizon で canonical 因子の sum(weights) == 1.0（abs < 1e-9 で検証済み）
TIME_HORIZON_WEIGHTS: dict[str, dict[str, float]] = {
    "short_term": {
        "technical_momentum":  0.40,
        "flow_microstructure": 0.20,
        "sentiment":           0.15,
        "fundamental":         0.10,
        "factor_cross":        0.10,
        "regime":              0.05,
    },
    "long_term": {
        "fundamental":         0.30,
        "factor_cross":        0.20,
        "quality_value":       0.20,
        "growth":              0.15,
        "shareholder_return":  0.10,
        "regime":              0.05,
    },
}


# ── 公開 API ─────────────────────────────────────────────────────────────────

def get_time_horizon_weights(horizon: str) -> dict[str, float]:
    """
    horizon 文字列 → 因子重み dict（shallow copy）。

    未知 horizon は "long_term" にフォールバック。
    戻り値を変更しても TIME_HORIZON_WEIGHTS 定数は破壊されない。

    Args:
        horizon: horizon 文字列（"short_term" / "long_term"）
    Returns:
        dict[str, float]: 因子名 → 重み の shallow copy
    """
    source = TIME_HORIZON_WEIGHTS.get(horizon, TIME_HORIZON_WEIGHTS["long_term"])
    return dict(source)


def validate_time_horizon_weights(weights: dict[str, float], horizon: str) -> bool:
    """
    因子重み dict の妥当性を検証する（horizon 指定必須）。

    条件:
      1. horizon が VALID_HORIZONS に含まれること
      2. HORIZON_FACTORS[horizon] の canonical 因子がすべて存在すること
      3. canonical 因子の各 weight が 0.0 < weight <= 1.0 であること
      4. canonical 因子のみで sum を計算し abs(sum - 1.0) < 1e-9 であること

    余分なキーは許容する（将来の因子追加で既存テーブルが invalid にならないため）。
    余分なキーの weight は sum 判定に含めない。

    Args:
        weights: 検証対象の因子重み dict
        horizon: 検証に用いる horizon 文字列
    Returns:
        bool: すべての条件を満たすとき True
    """
    if not isinstance(weights, dict):
        return False

    # 条件1: horizon が有効
    if horizon not in VALID_HORIZONS:
        return False

    canonical_factors = HORIZON_FACTORS[horizon]

    # 条件2: canonical 因子すべて存在
    for factor in canonical_factors:
        if factor not in weights:
            return False

    # 条件3: canonical 因子の各重みが範囲内
    for factor in canonical_factors:
        try:
            fv = float(weights[factor])
        except (TypeError, ValueError):
            return False
        if not (0.0 < fv <= 1.0):
            return False

    # 条件4: canonical 因子のみで合計が 1.0 に近似（余分キーは除外）
    canonical_sum = sum(float(weights[f]) for f in canonical_factors)
    if abs(canonical_sum - 1.0) >= 1e-9:
        return False

    return True


def validate_all_time_horizon_weights() -> bool:
    """
    TIME_HORIZON_WEIGHTS 全 horizon の妥当性を一括検証する。

    Returns:
        bool: 全 horizon で validate_time_horizon_weights() が True のとき True
    """
    for horizon, weights in TIME_HORIZON_WEIGHTS.items():
        if not validate_time_horizon_weights(weights, horizon):
            return False
    return True
