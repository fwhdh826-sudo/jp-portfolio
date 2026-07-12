"""
Rule-Based Regime Detection — Card 3-1
Layer 3.1: 即応ルールベースレジーム判定。
Detection-only. No trades, no orders, no side effects.

Reference: docs/constitution/REGIME.md Section 2
Reference: docs/v13.3/07_v13.3_spec.md Section 3.1
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ── 5レジームラベル ────────────────────────────────────────────────────────────
REGIME_LABELS: tuple[str, ...] = (
    "bull_calm",
    "bull_volatile",
    "bear",
    "crisis",
    "uncertain",
)

# ── 判定定数（REGIME.md Section 2 / SSOT） ──────────────────────────────────
CRISIS_VIX_THRESHOLD: float = 40.0          # VIX > 40 → crisis
CRISIS_SP500_DD_THRESHOLD: float = -0.20    # sp500_dd_30d < -20% → crisis
BEAR_SP500_DD_THRESHOLD: float = -0.10      # sp500_dd_30d < -10% + death cross → bear
BULL_VOLATILE_VIX_THRESHOLD: float = 25.0   # VIX > 25 + nikkei_5d > 0 → bull_volatile
BULL_CALM_VIX_THRESHOLD: float = 18.0       # VIX < 18 + nikkei_5d >= 0 → bull_calm


# ── Input / Output dataclasses ────────────────────────────────────────────────

@dataclass
class RuleBasedInput:
    vix: float              # VIX 現在値
    nikkei_5d_return: float # 日経 5日リターン（例: 0.02 = +2%）
    nikkei_60ma: float      # 日経 60日移動平均
    nikkei_200ma: float     # 日経 200日移動平均
    sp500_dd_30d: float     # S&P500 30日ドローダウン（例: -0.15 = -15%）


@dataclass
class RuleBasedResult:
    regime: str                              # 5レジームのいずれか
    primary_rule: str                        # 判定の根拠ルール名
    rules_evaluated: list[tuple[str, bool]] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.regime not in REGIME_LABELS:
            raise ValueError(f"Invalid regime: {self.regime!r}")


# ── Public API ────────────────────────────────────────────────────────────────

def detect_regime_rule_based(market_data: dict) -> dict:
    """
    Layer 3.1 Rule-Based レジーム判定（dict インターフェース）。
    優先順位: crisis > bear > bull_volatile > bull_calm > uncertain
    Returns dict compatible with spec Section 3.1.
    """
    result = _evaluate(RuleBasedInput(
        vix=market_data["vix"],
        nikkei_5d_return=market_data["nikkei_5d_return"],
        nikkei_60ma=market_data["nikkei_60ma"],
        nikkei_200ma=market_data["nikkei_200ma"],
        sp500_dd_30d=market_data["sp500_dd_30d"],
    ))
    return {
        "regime": result.regime,
        "primary_rule": result.primary_rule,
        "rules_evaluated": result.rules_evaluated,
    }


def evaluate_rule_based(inp: RuleBasedInput) -> RuleBasedResult:
    """Typed interface: RuleBasedInput → RuleBasedResult."""
    return _evaluate(inp)


# ── 内部判定ロジック ──────────────────────────────────────────────────────────

def _evaluate(inp: RuleBasedInput) -> RuleBasedResult:
    # Crisis（最優先）: VIX > 40 OR sp500_dd < -20%
    crisis_conditions: list[tuple[str, bool]] = [
        ("vix > 40", inp.vix > CRISIS_VIX_THRESHOLD),
        ("sp500_dd_30d < -20%", inp.sp500_dd_30d < CRISIS_SP500_DD_THRESHOLD),
    ]
    if any(c[1] for c in crisis_conditions):
        return RuleBasedResult(
            regime="crisis",
            primary_rule=next(c[0] for c in crisis_conditions if c[1]),
            rules_evaluated=crisis_conditions,
        )

    # Bear: デスクロス（60MA < 200MA）AND sp500_dd < -10%
    bear_conditions: list[tuple[str, bool]] = [
        ("60MA < 200MA", inp.nikkei_60ma < inp.nikkei_200ma),
        ("sp500_dd_30d < -10%", inp.sp500_dd_30d < BEAR_SP500_DD_THRESHOLD),
    ]
    if all(c[1] for c in bear_conditions):
        return RuleBasedResult(
            regime="bear",
            primary_rule="death_cross + dd",
            rules_evaluated=bear_conditions,
        )

    # Bull Volatile: VIX > 25 AND nikkei_5d > 0
    bull_vol_conditions: list[tuple[str, bool]] = [
        ("vix > 25", inp.vix > BULL_VOLATILE_VIX_THRESHOLD),
        ("nikkei_5d > 0", inp.nikkei_5d_return > 0),
    ]
    if all(c[1] for c in bull_vol_conditions):
        return RuleBasedResult(
            regime="bull_volatile",
            primary_rule="high_vol_uptrend",
            rules_evaluated=bull_vol_conditions,
        )

    # Bull Calm: VIX < 18 AND nikkei_5d >= 0
    bull_calm_conditions: list[tuple[str, bool]] = [
        ("vix < 18", inp.vix < BULL_CALM_VIX_THRESHOLD),
        ("nikkei_5d >= 0", inp.nikkei_5d_return >= 0),
    ]
    if all(c[1] for c in bull_calm_conditions):
        return RuleBasedResult(
            regime="bull_calm",
            primary_rule="low_vol_uptrend",
            rules_evaluated=bull_calm_conditions,
        )

    # Uncertain（デフォルト）
    return RuleBasedResult(
        regime="uncertain",
        primary_rule="no_match",
        rules_evaluated=[],
    )
