"""
drawdown_estimator.py — Card C（P2-8N）
Phase 8 Frontier Engine: returns_data ベースの portfolio 観測最大ドローダウン。

責務:
  - DrawdownEstimatorInput  — 計算入力（frozen dataclass、Flat DI）
  - DrawdownEstimatorResult — 結果コンテナ（frozen dataclass）
  - DrawdownEstimator       — estimate() で DrawdownEstimatorResult を返す

観測最大ドローダウン（pure computation）:
  weights と returns_data から portfolio リターン系列を合成し、その系列の
  過去最大ドローダウンを観察値として返す。予測ではなく履歴ベースの観測値。

calc_max_drawdown 再利用（P1-C2）:
  decision.dd10_kpi.calc_max_drawdown（spec §6.3 の canonical 実装）を本
  モジュール内でのみ import して再利用する。同一金融計算の局所再実装を避け
  drift を防ぐ。dd10_uniform_return / DD10Calculator / DD10KPIResult は使わない
  （max_dd とは別 KPI のため）。

weights 非再正規化（P1-C3）:
  returns_data に重複する ticker のみで portfolio リターンを合成するが、
  欠損 ticker 分を残存 ticker へ再配分（合計 1.0 再正規化）しない。
  欠損は coverage_weight / missing_tickers として観察範囲の制約を明示する。
  理由: 再正規化すると欠損 ticker を「無かったこと」にして残存へ 100% 再配分
  した観察値になり実態を歪めるため。

alignment（CovarianceModel P1-8E と整合）:
  strict intersection。n_obs = min(len(valid series))。各 series は末尾 n_obs。
  returns_data は月次算術リターン小数前提（P1-8D / dd10_kpi P2-DD1）。

設計原則:
  - stdlib-only（math のみ）+ decision.dd10_kpi.calc_max_drawdown（1 leaf 関数）
  - pandas / numpy / scipy 禁止
  - dd10_uniform_return / DD10Calculator / DD10KPIResult 不使用
  - Monte Carlo 不使用（P2-C1）
  - 入力 / context を mutation しない
  - 実 HTTP / LLM 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - max_drawdown は常に <= 0.0（calc_max_drawdown 仕様 + 防御 clamp）

P1 記録:
  P1-C1: Option B。本モジュールを新設、FrontierStrategy は sibling として import。
  P1-C2: calc_max_drawdown を decision.dd10_kpi から import 再利用。
  P1-C3: intersection 後の weights を再正規化しない。coverage diagnostic を出す。
  P1-C5: returns_data 欠損/不足は is_drawdown_defined=False（呼び出し元 fallback）。
  P1-C9: Monte Carlo なし。

P2 記録（後続 Card 候補）:
  P2-C1: Monte Carlo / 多期間 max drawdown simulation。
  P2-C2: parametric（vol ベース）max drawdown 推定の併用。
  P2-C3: weights 再正規化方式の高度化（coverage 加味）。

Reference: backend/engine/decision/dd10_kpi.py（calc_max_drawdown / spec §6.3）
Reference: backend/engine/frontier/covariance_model.py（strict intersection / P1-8E）
Reference: handover.md "Card C Readiness Review" セクション
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from engine.decision.dd10_kpi import calc_max_drawdown


# ── safe helpers ──────────────────────────────────────────────────────────────


def _safe_float(raw: Any, fallback: float = 0.0) -> float:
    """None / str / NaN / inf → fallback。それ以外は float 変換。"""
    if raw is None:
        return fallback
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(val) or math.isinf(val):
        return fallback
    return val


def _is_finite_number(raw: Any) -> bool:
    """raw が有限な float に変換可能か（None / str / NaN / inf は False）。"""
    if raw is None:
        return False
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return False
    return not (math.isnan(val) or math.isinf(val))


def _to_float_series(raw: Any) -> list | None:
    """
    list / tuple を float list へ変換（長さ保持、無効要素は 0.0 へ coerce）。
    list/tuple でなければ None。

    長さ保持の理由: 複数 ticker の index-aligned 加重和を取るため、
    途中要素を filter すると alignment が崩れる（P1-8D 呼び出し元責務）。
    """
    if not isinstance(raw, (list, tuple)):
        return None
    return [_safe_float(x, 0.0) for x in raw]


def _finite_count(raw: Any) -> int:
    """raw 内の有限 float 変換可能要素数。list/tuple でなければ 0。"""
    if not isinstance(raw, (list, tuple)):
        return 0
    return sum(1 for x in raw if _is_finite_number(x))


# ── DrawdownEstimatorInput ────────────────────────────────────────────────────


@dataclass(frozen=True)
class DrawdownEstimatorInput:
    """
    DrawdownEstimator.estimate() への入力。immutable。Flat DI。

    tickers / weights は同じ順序で対応（i 番目 ticker の weight が weights[i]）。
    長さ不一致は短い方に合わせて truncate（diagnostic 記録）。
    returns_data は月次算術リターン小数の dict[str, list[float]]。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / approve / reject / conditional / rating /
      rebalance_order / buy_amount / sell_amount / shares / quantity
    """

    tickers:      tuple
    weights:      tuple
    returns_data: dict
    min_periods:  int  = 2
    context:      dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        # tickers: tuple[str, ...]
        if not isinstance(self.tickers, tuple):
            try:
                object.__setattr__(self, "tickers", tuple(self.tickers))
            except TypeError:
                object.__setattr__(self, "tickers", ())
        object.__setattr__(
            self, "tickers", tuple(str(t) for t in self.tickers)
        )

        # weights: tuple[float, ...]
        if not isinstance(self.weights, tuple):
            try:
                object.__setattr__(self, "weights", tuple(self.weights))
            except TypeError:
                object.__setattr__(self, "weights", ())
        object.__setattr__(
            self, "weights", tuple(_safe_float(w, 0.0) for w in self.weights)
        )

        # returns_data: dict（非 dict → {}）
        if not isinstance(self.returns_data, dict):
            object.__setattr__(self, "returns_data", {})

        # min_periods: int >= 2
        mp = self.min_periods
        try:
            mp = int(mp)
        except (TypeError, ValueError):
            mp = 2
        if mp < 2:
            mp = 2
        object.__setattr__(self, "min_periods", mp)

        # context: dict（非 dict → {}）
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})


# ── DrawdownEstimatorResult ───────────────────────────────────────────────────


@dataclass(frozen=True)
class DrawdownEstimatorResult:
    """
    DrawdownEstimator.estimate() の結果。immutable。

    portfolio_returns:   合成された portfolio リターン系列（観測区間、tail n_obs）
    max_drawdown:        観測最大ドローダウン（常に <= 0.0）
    is_drawdown_defined: True=計算成功 / False=undefined（呼び出し元 fallback 判断用）
    coverage_weight:     used_tickers の weight 合計（再正規化しないため <= Σweights）
    used_tickers:        合成に使った ticker（returns_data に有効データあり）
    missing_tickers:     returns_data 欠損 / 無効 series の ticker
    diagnostics:         "observation: " 接頭辞の観察文字列 tuple

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / approve / reject / conditional / rating /
      rebalance_order / buy_amount / sell_amount / shares / quantity /
      final_verdict / order / amount / entry_price / stop_loss / take_profit
    """

    portfolio_returns:   tuple
    max_drawdown:        float
    is_drawdown_defined: bool
    coverage_weight:     float
    used_tickers:        tuple
    missing_tickers:     tuple
    diagnostics:         tuple = ()

    def __post_init__(self) -> None:
        if not isinstance(self.portfolio_returns, tuple):
            object.__setattr__(
                self, "portfolio_returns", tuple(self.portfolio_returns)
            )
        # max_drawdown: safe float + 0.0 以下 clamp
        object.__setattr__(
            self, "max_drawdown", min(0.0, _safe_float(self.max_drawdown, 0.0))
        )
        object.__setattr__(self, "is_drawdown_defined", bool(self.is_drawdown_defined))
        object.__setattr__(
            self, "coverage_weight", _safe_float(self.coverage_weight, 0.0)
        )
        if not isinstance(self.used_tickers, tuple):
            object.__setattr__(self, "used_tickers", tuple(self.used_tickers))
        if not isinstance(self.missing_tickers, tuple):
            object.__setattr__(self, "missing_tickers", tuple(self.missing_tickers))
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict（str / float / bool / list のみ）。"""
        return {
            "portfolio_returns":   [float(r) for r in self.portfolio_returns],
            "max_drawdown":        self.max_drawdown,
            "is_drawdown_defined": self.is_drawdown_defined,
            "coverage_weight":     self.coverage_weight,
            "used_tickers":        list(self.used_tickers),
            "missing_tickers":     list(self.missing_tickers),
            "diagnostics":         list(self.diagnostics),
        }


# ── DrawdownEstimator ─────────────────────────────────────────────────────────


class DrawdownEstimator:
    """
    DrawdownEstimatorInput を受け取り DrawdownEstimatorResult を返す pure computation。

    売買判断・注文生成・予測は行わない。入力 / context を mutation しない。
    """

    def estimate(self, inp: DrawdownEstimatorInput) -> DrawdownEstimatorResult:
        """
        weights × returns_data から portfolio 観測最大ドローダウンを計算する。

        Args:
            inp: DrawdownEstimatorInput
        Returns:
            DrawdownEstimatorResult
        """
        diagnostics: list = []

        tickers = inp.tickers
        weights = inp.weights
        returns_data = inp.returns_data

        # ── tickers / weights 長さ整合 ───────────────────────────────────────
        n_pairs = min(len(tickers), len(weights))
        if len(tickers) != len(weights):
            diagnostics.append(
                f"observation: tickers/weights length mismatch "
                f"({len(tickers)} vs {len(weights)}) — truncated to {n_pairs}"
            )
        tickers = tickers[:n_pairs]
        weights = weights[:n_pairs]

        # ── 有効 ticker 抽出（returns_data あり / list 化可 / 有効 float >= 2）─
        valid: list = []           # (ticker, weight, float_series)
        missing: list = []
        for t, w in zip(tickers, weights):
            raw = returns_data.get(t)
            series = _to_float_series(raw)
            if series is None or _finite_count(raw) < 2:
                missing.append(t)
                continue
            valid.append((t, w, series))

        used_tickers = tuple(t for t, _, _ in valid)
        missing_tickers = tuple(missing)
        coverage_weight = sum(w for _, w, _ in valid)

        if missing:
            diagnostics.append(
                f"observation: {len(missing)} ticker(s) missing or invalid in "
                f"returns_data — excluded; coverage_weight="
                f"{coverage_weight:.6f} (weights NOT renormalized, P1-C3)"
            )

        # ── 重複 ticker ゼロ → undefined ─────────────────────────────────────
        if not valid:
            diagnostics.append(
                "observation: no ticker overlap with returns_data — "
                "max_drawdown undefined"
            )
            return DrawdownEstimatorResult(
                portfolio_returns=(),
                max_drawdown=0.0,
                is_drawdown_defined=False,
                coverage_weight=0.0,
                used_tickers=(),
                missing_tickers=missing_tickers,
                diagnostics=tuple(diagnostics),
            )

        # ── strict intersection: n_obs = min(len(series))、末尾優先 ──────────
        n_obs = min(len(series) for _, _, series in valid)
        if n_obs < inp.min_periods or n_obs < 2:
            diagnostics.append(
                f"observation: insufficient overlapping periods "
                f"(n_obs={n_obs} < min_periods={inp.min_periods}) — "
                f"max_drawdown undefined"
            )
            return DrawdownEstimatorResult(
                portfolio_returns=(),
                max_drawdown=0.0,
                is_drawdown_defined=False,
                coverage_weight=coverage_weight,
                used_tickers=used_tickers,
                missing_tickers=missing_tickers,
                diagnostics=tuple(diagnostics),
            )

        # ── portfolio_returns[t] = Σ weight_i * series_i_tail[t] ─────────────
        tails = [(w, series[-n_obs:]) for _, w, series in valid]
        portfolio_returns: list = []
        for t_idx in range(n_obs):
            pr = 0.0
            for w, tail in tails:
                pr += w * tail[t_idx]
            portfolio_returns.append(pr)

        # ── calc_max_drawdown 再利用（decision.dd10_kpi、P1-C2）──────────────
        raw_dd = calc_max_drawdown(portfolio_returns)

        if raw_dd is None or (
            isinstance(raw_dd, float) and (math.isnan(raw_dd) or math.isinf(raw_dd))
        ):
            diagnostics.append(
                "observation: max_drawdown computation produced non-finite "
                "value — treated as undefined"
            )
            return DrawdownEstimatorResult(
                portfolio_returns=(),
                max_drawdown=0.0,
                is_drawdown_defined=False,
                coverage_weight=coverage_weight,
                used_tickers=used_tickers,
                missing_tickers=missing_tickers,
                diagnostics=tuple(diagnostics),
            )

        max_dd = min(0.0, _safe_float(raw_dd, 0.0))
        diagnostics.append(
            f"observation: observed max drawdown computed from "
            f"{len(used_tickers)} ticker(s), {n_obs} period(s) "
            f"(calculation-only, not a prediction)"
        )

        return DrawdownEstimatorResult(
            portfolio_returns=tuple(portfolio_returns),
            max_drawdown=max_dd,
            is_drawdown_defined=True,
            coverage_weight=coverage_weight,
            used_tickers=used_tickers,
            missing_tickers=missing_tickers,
            diagnostics=tuple(diagnostics),
        )
