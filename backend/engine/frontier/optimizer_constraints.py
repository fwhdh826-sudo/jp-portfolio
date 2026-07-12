"""
optimizer_constraints.py — Card 8-2
Phase 8 Frontier Engine: オプティマイザー制約定義。

責務:
  - BoundConstraint      — 銘柄別 hard bounds（frozen dataclass）
  - SectorCapConstraint  — セクター別重み上限（T2）（frozen dataclass）
  - GroupConstraint      — グループ別重み範囲（情報的グルーピング）（frozen dataclass）
  - SoftPenaltyParam     — ソフト制約の閾値・係数定義（T5/T6/T7/T8）（frozen dataclass）
  - ConstraintInput      — 制約構築入力（frozen dataclass）
  - OptimizerConstraints — 全制約バンドル（frozen dataclass）
  - ConstraintBuilder    — 制約構築クラス

hard / soft 境界:
  - BoundConstraint: hard bounds（SLSQP の bounds=に渡す）
    - locked_weights 銘柄 → lower=upper=locked_weight（3ヶ月ロック）
    - 通常銘柄 → lower=0.0, upper=1.0
    - T7 max_single_weight → hard bound ではなく SoftPenaltyParam（T7）として扱う
  - SectorCapConstraint: T2 sector_cap 35%（Card 8-3 が inequality constraint として消費）
  - SoftPenaltyParam: T5（core floor）/ T6（leverage cap）/ T7（単一銘柄上限）/ T8（現金下限）
    - GroupConstraint は情報的グルーピングデータ。Card 8-3 が soft penalty として消費する前提。
  - T1（ストップロス -40%）/ T3（PF DD-30%）/ T4（L3キャピチュレーション）: 実行時チェック → 含まない

Tier A 参照値（固定値）:
  T5 core floor warn=0.55, severe=0.45, coef_warn=5.0, coef_severe=50.0
  T6 leverage cap warn=0.20, severe=0.25, coef_warn=10.0, coef_severe=100.0
  T7 single cap warn=max_single_weight(0.08), severe=0.12, coef_warn=8.0, coef_severe=80.0
  T8 cash floor warn=0.077, severe=0.05, coef_warn=6.0, coef_severe=60.0（tickers=空）

設計原則:
  - stdlib-only（計算なし・純データ定義）
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/signal/decision/verdict/approve/reject 禁止
  - 実注文・株数・金額 禁止
  - 全 diagnostics は "observation: " プレフィックス
  - Card 8-3 efficient_frontier.py がこの制約データを消費する

P1 記録:
  P1-8G: asset_meta 欠損キー（sector/is_leveraged/is_core）→ デフォルト補完 + diagnostic
  P1-8H: locked_weights 合計 > 1.0 → diagnostic のみ。Card 8-3 optimizer が feasibility を確認。

P2 記録:
  P2-8G: T8 cash floor は tickers 外（現金枠）のため tickers=() の空グループ。Operation 層が管理。
  P2-8H: Card 8-3 での scipy.optimize.minimize 導入可否は Card 8-3 レビュー時に別途確認。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 8-2
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# ── 定数 ─────────────────────────────────────────────────────────────────────

_VALID_REGIMES: frozenset[str] = frozenset({
    "bull_calm", "bull_volatile", "bear", "crisis", "uncertain",
})

# Tier A soft constraint 固定係数（spec §7.2 準拠）
_T5_LOWER_WARN:     float = 0.50
_T5_LOWER_SEVERE:   float = 0.45
_T5_COEF_WARN:      float = 5.0
_T5_COEF_SEVERE:    float = 50.0

_T6_UPPER_WARN:     float = 0.20
_T6_UPPER_SEVERE:   float = 0.25
_T6_COEF_WARN:      float = 10.0
_T6_COEF_SEVERE:    float = 100.0

_T7_UPPER_SEVERE:   float = 0.12
_T7_COEF_WARN:      float = 8.0
_T7_COEF_SEVERE:    float = 80.0

_T8_LOWER_WARN:     float = 0.077
_T8_LOWER_SEVERE:   float = 0.05
_T8_COEF_WARN:      float = 6.0
_T8_COEF_SEVERE:    float = 60.0


# ── ヘルパー ─────────────────────────────────────────────────────────────────

def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
        if math.isnan(result) or math.isinf(result):
            return default
        return result
    except (TypeError, ValueError):
        return default


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _get_meta(asset_meta: dict[str, dict], ticker: str, diag: list[str]) -> dict:
    """asset_meta から ticker の meta を安全に取得。欠損 → デフォルト + diagnostic。"""
    raw = asset_meta.get(ticker)
    if raw is None:
        diag.append(
            f"observation: asset_meta missing for ticker {ticker}; "
            "using defaults (sector='unknown', is_leveraged=False, is_core=False)"
        )
        return {}
    if not isinstance(raw, dict):
        diag.append(
            f"observation: asset_meta[{ticker}] is not a dict; "
            "using defaults (sector='unknown', is_leveraged=False, is_core=False)"
        )
        return {}
    return raw


# ── データクラス ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class BoundConstraint:
    """銘柄別 hard bounds（SLSQP の bounds= に渡す）。frozen=True で不変。"""
    ticker: str
    lower: float = 0.0
    upper: float = 1.0


@dataclass(frozen=True)
class SectorCapConstraint:
    """セクター別重み上限（T2 sector_cap=0.35）。frozen=True で不変。"""
    sector_id: str
    tickers: tuple[str, ...]
    max_weight: float = 0.35

    def __post_init__(self) -> None:
        if isinstance(self.tickers, list):
            object.__setattr__(self, "tickers", tuple(self.tickers))


@dataclass(frozen=True)
class GroupConstraint:
    """
    グループ別重み範囲（情報的グルーピング）。frozen=True で不変。

    Card 8-3 が soft penalty として消費する前提のデータ。
    core / leverage グループを明示的にまとめる。
    """
    group_id: str
    tickers: tuple[str, ...]
    min_weight: float = 0.0
    max_weight: float = 1.0

    def __post_init__(self) -> None:
        if isinstance(self.tickers, list):
            object.__setattr__(self, "tickers", tuple(self.tickers))


@dataclass(frozen=True)
class SoftPenaltyParam:
    """
    ソフト制約の閾値・係数定義（T5/T6/T7/T8）。frozen=True で不変。

    計算（penalty値の算出）は Card 8-3 efficient_frontier.py が行う。
    このクラスは純データ定義のみ。
    """
    constraint_id: str
    tickers: tuple[str, ...]
    lower_warn: float = 0.0
    upper_warn: float = 1.0
    penalty_coef_warn: float = 0.0
    lower_severe: float = 0.0
    upper_severe: float = 1.0
    penalty_coef_severe: float = 0.0

    def __post_init__(self) -> None:
        if isinstance(self.tickers, list):
            object.__setattr__(self, "tickers", tuple(self.tickers))


@dataclass(frozen=True)
class ConstraintInput:
    """制約構築入力。frozen=True で不変。"""
    tickers: tuple[str, ...]
    asset_meta: dict[str, dict]       # {ticker: {"sector": str, "is_leveraged": bool, "is_core": bool}}
    locked_weights: dict[str, float]  # {ticker: fixed_weight}（3ヶ月ロック中）
    regime: str = "uncertain"
    max_single_weight: float = 0.08   # T7 warn upper（hard bound には使わない）
    sector_cap: float = 0.35          # T2
    leverage_cap: float = 0.20        # T6 warn upper
    core_floor: float = 0.55          # T5 warn lower
    risk_aversion: float = 3.0
    context: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if isinstance(self.tickers, list):
            object.__setattr__(self, "tickers", tuple(self.tickers))
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})
        if not isinstance(self.asset_meta, dict):
            object.__setattr__(self, "asset_meta", {})
        if not isinstance(self.locked_weights, dict):
            object.__setattr__(self, "locked_weights", {})


@dataclass(frozen=True)
class OptimizerConstraints:
    """全制約をバンドルした frozen dataclass。Card 8-3 optimizer が消費する。"""
    tickers: tuple[str, ...]
    bounds: tuple[BoundConstraint, ...]
    sector_caps: tuple[SectorCapConstraint, ...]
    group_constraints: tuple[GroupConstraint, ...]
    soft_penalties: tuple[SoftPenaltyParam, ...]
    risk_aversion: float
    budget_sum: float
    regime_used: str
    diagnostics: tuple[str, ...]

    def get_bounds_as_pairs(self) -> list[tuple[float, float]]:
        """Card 8-3 の scipy.optimize.minimize bounds= 向け: [(lower, upper), ...]。"""
        return [(b.lower, b.upper) for b in self.bounds]

    def to_dict(self) -> dict:
        return {
            "tickers":           list(self.tickers),
            "bounds":            [
                {"ticker": b.ticker, "lower": b.lower, "upper": b.upper}
                for b in self.bounds
            ],
            "sector_caps":       [
                {
                    "sector_id":  s.sector_id,
                    "tickers":    list(s.tickers),
                    "max_weight": s.max_weight,
                }
                for s in self.sector_caps
            ],
            "group_constraints": [
                {
                    "group_id":   g.group_id,
                    "tickers":    list(g.tickers),
                    "min_weight": g.min_weight,
                    "max_weight": g.max_weight,
                }
                for g in self.group_constraints
            ],
            "soft_penalties":    [
                {
                    "constraint_id":    sp.constraint_id,
                    "tickers":          list(sp.tickers),
                    "lower_warn":       sp.lower_warn,
                    "upper_warn":       sp.upper_warn,
                    "penalty_coef_warn":   sp.penalty_coef_warn,
                    "lower_severe":     sp.lower_severe,
                    "upper_severe":     sp.upper_severe,
                    "penalty_coef_severe": sp.penalty_coef_severe,
                }
                for sp in self.soft_penalties
            ],
            "risk_aversion": self.risk_aversion,
            "budget_sum":    self.budget_sum,
            "regime_used":   self.regime_used,
            "diagnostics":   list(self.diagnostics),
        }


# ── 制約構築クラス ────────────────────────────────────────────────────────────

class ConstraintBuilder:
    """
    ConstraintInput から OptimizerConstraints を構築する。

    制約データの定義のみ。最適化ロジック・注文生成・売買判断は行わない。
    """

    def build(self, inp: ConstraintInput) -> OptimizerConstraints:
        diag: list[str] = []

        regime_used = inp.regime if inp.regime in _VALID_REGIMES else "uncertain"
        if regime_used != inp.regime:
            diag.append(
                f"observation: unknown regime={inp.regime!r}; fallback to 'uncertain'"
            )

        bounds         = self._build_bounds(inp, diag)
        sector_caps    = self._build_sector_caps(inp, diag)
        group_consts   = self._build_group_constraints(inp, diag)
        soft_penalties = self._build_soft_penalties(inp, diag)

        return OptimizerConstraints(
            tickers=inp.tickers,
            bounds=tuple(bounds),
            sector_caps=tuple(sector_caps),
            group_constraints=tuple(group_consts),
            soft_penalties=tuple(soft_penalties),
            risk_aversion=inp.risk_aversion,
            budget_sum=1.0,
            regime_used=regime_used,
            diagnostics=tuple(diag),
        )

    # ── private: bounds ───────────────────────────────────────────────────────

    def _build_bounds(
        self, inp: ConstraintInput, diag: list[str]
    ) -> list[BoundConstraint]:
        # locked_weights 合計チェック（tickers に含まれる分のみ）
        relevant_locked = {
            t: inp.locked_weights[t]
            for t in inp.tickers
            if t in inp.locked_weights
        }
        locked_sum = sum(
            _clamp(_safe_float(v, 0.0), 0.0, 1.0)
            for v in relevant_locked.values()
        )
        if locked_sum > 1.0:
            diag.append(
                f"observation: locked_weights sum exceeds 1.0 (sum={locked_sum:.4f}); "
                "optimizer feasibility must be checked by Card 8-3"
            )

        bounds: list[BoundConstraint] = []
        for ticker in inp.tickers:
            if ticker in relevant_locked:
                locked_w = _clamp(_safe_float(relevant_locked[ticker], 0.0), 0.0, 1.0)
                bounds.append(BoundConstraint(ticker=ticker, lower=locked_w, upper=locked_w))
                diag.append(
                    f"observation: ticker {ticker} has locked weight {locked_w:.4f}; "
                    f"bound set to [{locked_w:.4f}, {locked_w:.4f}]"
                )
            else:
                bounds.append(BoundConstraint(ticker=ticker, lower=0.0, upper=1.0))
        return bounds

    # ── private: sector caps ──────────────────────────────────────────────────

    def _build_sector_caps(
        self, inp: ConstraintInput, diag: list[str]
    ) -> list[SectorCapConstraint]:
        sector_to_tickers: dict[str, list[str]] = {}
        for ticker in inp.tickers:
            meta = _get_meta(inp.asset_meta, ticker, diag)
            sector = meta.get("sector", "unknown")
            if not isinstance(sector, str) or not sector:
                sector = "unknown"
            sector_to_tickers.setdefault(sector, []).append(ticker)

        return [
            SectorCapConstraint(
                sector_id=sector_id,
                tickers=tuple(tickers_in_sector),
                max_weight=inp.sector_cap,
            )
            for sector_id, tickers_in_sector in sector_to_tickers.items()
        ]

    # ── private: group constraints ────────────────────────────────────────────

    def _build_group_constraints(
        self, inp: ConstraintInput, diag: list[str]
    ) -> list[GroupConstraint]:
        core_tickers: list[str] = []
        leverage_tickers: list[str] = []
        for ticker in inp.tickers:
            meta = _get_meta(inp.asset_meta, ticker, diag)
            if bool(meta.get("is_core", False)):
                core_tickers.append(ticker)
            if bool(meta.get("is_leveraged", False)):
                leverage_tickers.append(ticker)

        result: list[GroupConstraint] = []
        if core_tickers:
            result.append(GroupConstraint(
                group_id="core",
                tickers=tuple(core_tickers),
                min_weight=inp.core_floor,
                max_weight=1.0,
            ))
        if leverage_tickers:
            result.append(GroupConstraint(
                group_id="leverage",
                tickers=tuple(leverage_tickers),
                min_weight=0.0,
                max_weight=inp.leverage_cap,
            ))
        return result

    # ── private: soft penalties ───────────────────────────────────────────────

    def _build_soft_penalties(
        self, inp: ConstraintInput, diag: list[str]
    ) -> list[SoftPenaltyParam]:
        result: list[SoftPenaltyParam] = []

        # T7: per-ticker 単一銘柄集中上限（max_single_weight は soft のみ）
        for ticker in inp.tickers:
            result.append(SoftPenaltyParam(
                constraint_id="T7",
                tickers=(ticker,),
                lower_warn=0.0,
                upper_warn=inp.max_single_weight,
                penalty_coef_warn=_T7_COEF_WARN,
                lower_severe=0.0,
                upper_severe=_T7_UPPER_SEVERE,
                penalty_coef_severe=_T7_COEF_SEVERE,
            ))

        # T5: core グループ floor（is_core=True 銘柄の合計重み）
        core_tickers = tuple(
            t for t in inp.tickers
            if bool((_get_meta_silent(inp.asset_meta, t)).get("is_core", False))
        )
        if core_tickers:
            result.append(SoftPenaltyParam(
                constraint_id="T5",
                tickers=core_tickers,
                lower_warn=inp.core_floor,
                upper_warn=1.0,
                penalty_coef_warn=_T5_COEF_WARN,
                lower_severe=_T5_LOWER_SEVERE,
                upper_severe=1.0,
                penalty_coef_severe=_T5_COEF_SEVERE,
            ))

        # T6: leverage グループ cap（is_leveraged=True 銘柄の合計重み）
        leverage_tickers = tuple(
            t for t in inp.tickers
            if bool((_get_meta_silent(inp.asset_meta, t)).get("is_leveraged", False))
        )
        if leverage_tickers:
            result.append(SoftPenaltyParam(
                constraint_id="T6",
                tickers=leverage_tickers,
                lower_warn=0.0,
                upper_warn=inp.leverage_cap,
                penalty_coef_warn=_T6_COEF_WARN,
                lower_severe=0.0,
                upper_severe=_T6_UPPER_SEVERE,
                penalty_coef_severe=_T6_COEF_SEVERE,
            ))

        # T8: 現金比率下限（現金は tickers 外 → tickers=()、Operation 層が管理）
        result.append(SoftPenaltyParam(
            constraint_id="T8",
            tickers=(),
            lower_warn=_T8_LOWER_WARN,
            upper_warn=1.0,
            penalty_coef_warn=_T8_COEF_WARN,
            lower_severe=_T8_LOWER_SEVERE,
            upper_severe=1.0,
            penalty_coef_severe=_T8_COEF_SEVERE,
        ))

        return result


def _get_meta_silent(asset_meta: dict[str, dict], ticker: str) -> dict:
    """diagnostic なしで asset_meta を安全取得（soft_penalties 構築時の内部用）。"""
    raw = asset_meta.get(ticker)
    if isinstance(raw, dict):
        return raw
    return {}
