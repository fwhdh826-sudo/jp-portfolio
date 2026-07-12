"""
Tier A Soft Penalty — Card 1-3
T5-T8 + T_v3 の制約違反を検出しペナルティスコアを算出する。
Score only — 売買・リバランス・Frontier最適化は行わない。
将来 Frontier 最適化の penalty 項として使用される（Card 7-x で統合）。

Reference: docs/constitution/PRINCIPLES.md Section 4
Reference: docs/v13.3/07_v13.3_spec.md Section 7.2
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ── Constants (07_spec.md Section 7.2 + PRINCIPLES.md Section 4) ─────────────

T5_CORE_TARGET: float = 0.55      # Core 目標
T5_LOWER_WARN: float = 0.50       # warn: core < 50%
T5_LOWER_SEVERE: float = 0.45     # severe: core < 45%
T5_COEF_WARN: float = 5.0
T5_COEF_SEVERE: float = 50.0

T6_UPPER_WARN: float = 0.20       # warn: lev > 20%
T6_UPPER_SEVERE: float = 0.25     # severe: lev > 25%
T6_COEF_WARN: float = 10.0
T6_COEF_SEVERE: float = 100.0

T7_UPPER_WARN: float = 0.08       # warn: single > 8%
T7_UPPER_SEVERE: float = 0.12     # severe: single > 12%
T7_COEF_WARN: float = 8.0
T7_COEF_SEVERE: float = 80.0

T8_LOWER_WARN: float = 0.077      # warn: cash < 7.7% (300万/3900万)
T8_LOWER_SEVERE: float = 0.05     # severe: cash < 5%
T8_COEF_WARN: float = 6.0
T8_COEF_SEVERE: float = 60.0

TV3_COEF: float = 2.0             # v3.0 乖離ペナルティ係数


# ── Input dataclasses ─────────────────────────────────────────────────────────

@dataclass
class SoftAssetInput:
    ticker: str
    is_core: bool            # Core層 (T5 集計対象)
    is_leveraged: bool       # レバレッジ製品 (T6 集計対象)
    is_cash: bool            # 現金・MMF (T8 集計対象、T7 除外対象)
    weight: float            # PF内比率 0.0~1.0
    v3_target_weight: float  # v3.0 目標配分 (T_v3 比較対象)


@dataclass
class SoftPortfolioInput:
    assets: list[SoftAssetInput]


# ── Output dataclasses ────────────────────────────────────────────────────────

@dataclass
class SoftViolation:
    rule_id: str          # "T5" | "T6" | "T7" | "T8" | "T_v3"
    severity: str         # "ok" | "warn" | "severe"
    detail: str
    current_value: float
    penalty_score: float  # 0.0 if ok


@dataclass
class SoftPenaltyResult:
    violations: list[SoftViolation] = field(default_factory=list)
    total_penalty: float = 0.0
    any_warn: bool = False
    any_severe: bool = False


# ── Internal helpers ──────────────────────────────────────────────────────────

def _lower_bound_check(
    rule_id: str,
    current: float,
    lower_warn: float,
    lower_severe: float,
    coef_warn: float,
    coef_severe: float,
    label: str,
) -> SoftViolation:
    if current < lower_severe:
        return SoftViolation(
            rule_id=rule_id, severity="severe",
            detail=f"{label} {current:.1%} < severe閾値 {lower_severe:.1%}",
            current_value=current,
            penalty_score=coef_warn * (lower_warn - lower_severe) + coef_severe * (lower_severe - current),
        )
    if current < lower_warn:
        return SoftViolation(
            rule_id=rule_id, severity="warn",
            detail=f"{label} {current:.1%} < warn閾値 {lower_warn:.1%}",
            current_value=current,
            penalty_score=coef_warn * (lower_warn - current),
        )
    return SoftViolation(
        rule_id=rule_id, severity="ok",
        detail=f"{label} {current:.1%} — クリア",
        current_value=current,
        penalty_score=0.0,
    )


def _upper_bound_check(
    rule_id: str,
    current: float,
    upper_warn: float,
    upper_severe: float,
    coef_warn: float,
    coef_severe: float,
    label: str,
) -> SoftViolation:
    if current > upper_severe:
        return SoftViolation(
            rule_id=rule_id, severity="severe",
            detail=f"{label} {current:.1%} > severe閾値 {upper_severe:.1%}",
            current_value=current,
            penalty_score=coef_warn * (upper_severe - upper_warn) + coef_severe * (current - upper_severe),
        )
    if current > upper_warn:
        return SoftViolation(
            rule_id=rule_id, severity="warn",
            detail=f"{label} {current:.1%} > warn閾値 {upper_warn:.1%}",
            current_value=current,
            penalty_score=coef_warn * (current - upper_warn),
        )
    return SoftViolation(
        rule_id=rule_id, severity="ok",
        detail=f"{label} {current:.1%} — クリア",
        current_value=current,
        penalty_score=0.0,
    )


# ── T5-T8 + T_v3 checks ──────────────────────────────────────────────────────

def check_t5_core_ratio(assets: list[SoftAssetInput]) -> SoftViolation:
    """T5: Core層比率 目標55%、下限チェック（warn<50%、severe<45%）"""
    core_ratio = sum(a.weight for a in assets if a.is_core)
    return _lower_bound_check(
        "T5", core_ratio,
        T5_LOWER_WARN, T5_LOWER_SEVERE,
        T5_COEF_WARN, T5_COEF_SEVERE,
        "Core層比率",
    )


def check_t6_leverage_ratio(assets: list[SoftAssetInput]) -> SoftViolation:
    """T6: レバレッジ製品比率 上限チェック（warn>20%、severe>25%）"""
    lev_ratio = sum(a.weight for a in assets if a.is_leveraged)
    return _upper_bound_check(
        "T6", lev_ratio,
        T6_UPPER_WARN, T6_UPPER_SEVERE,
        T6_COEF_WARN, T6_COEF_SEVERE,
        "レバレッジ製品比率",
    )


def check_t7_single_concentration(assets: list[SoftAssetInput]) -> list[SoftViolation]:
    """T7: 単一銘柄集中 上限チェック（warn>8%、severe>12%）。現金は対象外。"""
    violations: list[SoftViolation] = []
    for a in assets:
        if a.is_cash:
            continue
        v = _upper_bound_check(
            "T7", a.weight,
            T7_UPPER_WARN, T7_UPPER_SEVERE,
            T7_COEF_WARN, T7_COEF_SEVERE,
            f"{a.ticker} 比率",
        )
        if v.severity != "ok":
            violations.append(v)
    return violations


def check_t8_cash_ratio(assets: list[SoftAssetInput]) -> SoftViolation:
    """T8: 現金比率 下限チェック（warn<7.7%、severe<5%）"""
    cash_ratio = sum(a.weight for a in assets if a.is_cash)
    return _lower_bound_check(
        "T8", cash_ratio,
        T8_LOWER_WARN, T8_LOWER_SEVERE,
        T8_COEF_WARN, T8_COEF_SEVERE,
        "現金比率",
    )


def check_tv3_diff(assets: list[SoftAssetInput]) -> SoftViolation:
    """T_v3: v3.0 配分との乖離ペナルティ（penalty_coef=2.0、閾値なし・連続）"""
    total_diff = sum(abs(a.weight - a.v3_target_weight) for a in assets)
    penalty = TV3_COEF * total_diff
    severity = "ok" if total_diff < 1e-9 else "warn"
    return SoftViolation(
        rule_id="T_v3",
        severity=severity,
        detail=f"v3.0乖離合計 {total_diff:.4f}",
        current_value=total_diff,
        penalty_score=penalty,
    )


# ── Aggregator ────────────────────────────────────────────────────────────────

def evaluate_soft_penalty(portfolio: SoftPortfolioInput) -> SoftPenaltyResult:
    """
    T5-T8 + T_v3 を評価し SoftPenaltyResult を返す。
    Score only — 売買・リバランス・Frontier最適化は行わない。
    T5/T6/T8/T_v3 は常に1エントリ出力。T7 は違反銘柄数だけ出力（0件ならサマリ1件）。
    """
    violations: list[SoftViolation] = []

    violations.append(check_t5_core_ratio(portfolio.assets))
    violations.append(check_t6_leverage_ratio(portfolio.assets))

    t7 = check_t7_single_concentration(portfolio.assets)
    if t7:
        violations.extend(t7)
    else:
        violations.append(SoftViolation(
            rule_id="T7", severity="ok",
            detail="全銘柄 T7 クリア",
            current_value=0.0, penalty_score=0.0,
        ))

    violations.append(check_t8_cash_ratio(portfolio.assets))
    violations.append(check_tv3_diff(portfolio.assets))

    total = sum(v.penalty_score for v in violations)
    return SoftPenaltyResult(
        violations=violations,
        total_penalty=total,
        any_warn=any(v.severity == "warn" for v in violations),
        any_severe=any(v.severity == "severe" for v in violations),
    )
