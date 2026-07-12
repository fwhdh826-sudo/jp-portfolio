"""
efficient_frontier.py — Card 8-3
Phase 8 Frontier Engine: Sharpe 最大化最適化（SLSQP）。

責務:
  - EfficientFrontierInput   — 最適化入力（frozen dataclass）
  - OptimalWeights           — 最適ウェイト結果（frozen dataclass）
  - EfficientFrontierResult  — 最適化全結果（frozen dataclass）
  - EfficientFrontierOptimizer — 最適化クラス

最適化問題:
  minimize neg_utility(w) = -(w^T μ - 0.5 * λ * w^T Σ w - soft_penalty(w))
  subject to:
    sum(w) == 1.0                               （budget equality）
    lower_i ≤ w_i ≤ upper_i                     （bounds; locked: lower=upper）
    sum(w_S) ≤ sector_cap                       （T2 sector cap hard inequality）

  λ = constraints.risk_aversion (default 3.0)
  soft_penalty includes T5/T6/T7 piecewise linear penalties
  T8 (cash floor) は tickers 外なので optimizer 内では skip

設計原則:
  - scipy.optimize.minimize / method="SLSQP" を使用
  - import numpy は自コードに書かない（scipy callback の w は [float(x) for x in w] で list 変換）
  - pandas 禁止
  - 全 diagnostics は "observation: " プレフィックス
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/verdict/decision/approve/reject 禁止
  - 実 HTTP / API / LLM 接続禁止
  - 注文・株数・金額 生成禁止

fallback:
  - scipy 未インストール → solver_converged=False、_fallback_weights を返す
  - SLSQP 非収束        → solver_converged=False、_fallback_weights を返す
  - fallback weights:
      locked ticker は locked_weight を維持
      free ticker は残余を等分
      locked sum > 1.0 → locked を合計1.0へ正規化、free=0.0

P0/P1/P2 記録:
  P0-8X: scipy インストール承認済み（pip install scipy）
  P1-8I: EfficientFrontierInput.tickers が正規順序。missing expected_return は 0.0 fallback。
  P1-8J: cov_result.tickers と input.tickers の順序差は index dict でアライメント。
  P1-8K: SLSQP 非収束時は solver_converged=False + fallback weights。
  P1-8L: risk_free_rate=0.0 デフォルト（Sharpe 計算用、P2-8K で実値 DI 化予定）。
  P1-8M: T2 sector_cap は SLSQP の hard inequality として実装。
  P2-8I: FrontierStrategy 接続は Card 8-4 以降に延期。
  P2-8J: efficient frontier curve（n_frontier_points > 0）は後続 Card。
  P2-8K: risk_free_rate 実値 DI は後続 Card。
  P2-8L: v3_diff_penalty（v3.0 配分との乖離ペナルティ）は未実装。
  P2-8M: Ledoit-Wolf 最適収縮は後続 Card。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 8-3
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from engine.frontier.covariance_model import CovarianceResult, DEFAULT_MONTHLY_VARIANCE
from engine.frontier.optimizer_constraints import OptimizerConstraints

# ── scipy 可用性チェック（import numpy は書かない） ───────────────────────────

try:
    from scipy.optimize import minimize as _scipy_minimize  # type: ignore
    _SCIPY_AVAILABLE = True
except ImportError:
    _scipy_minimize = None  # type: ignore
    _SCIPY_AVAILABLE = False


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


# ── データクラス ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EfficientFrontierInput:
    """最適化入力。frozen=True で不変。"""
    tickers: tuple[str, ...]
    expected_returns: dict[str, float]
    cov_result: CovarianceResult
    constraints: OptimizerConstraints
    risk_free_rate: float = 0.0
    n_frontier_points: int = 0
    context: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if isinstance(self.tickers, list):
            object.__setattr__(self, "tickers", tuple(self.tickers))
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})
        if not isinstance(self.expected_returns, dict):
            object.__setattr__(self, "expected_returns", {})


@dataclass(frozen=True)
class OptimalWeights:
    """最適ウェイト結果。frozen=True で不変。"""
    tickers: tuple[str, ...]
    weights: tuple[float, ...]
    expected_return: float
    expected_vol: float
    sharpe_ratio: float
    soft_penalty: float
    solver_converged: bool
    solver_message: str
    diagnostics: tuple[str, ...]

    def as_weight_dict(self) -> dict[str, float]:
        return {t: float(w) for t, w in zip(self.tickers, self.weights)}

    def get_weight(self, ticker: str) -> float:
        for t, w in zip(self.tickers, self.weights):
            if t == ticker:
                return float(w)
        return 0.0

    def to_dict(self) -> dict:
        return {
            "tickers":          list(self.tickers),
            "weights":          list(self.weights),
            "expected_return":  self.expected_return,
            "expected_vol":     self.expected_vol,
            "sharpe_ratio":     self.sharpe_ratio,
            "soft_penalty":     self.soft_penalty,
            "solver_converged": self.solver_converged,
            "solver_message":   self.solver_message,
            "diagnostics":      list(self.diagnostics),
        }


@dataclass(frozen=True)
class EfficientFrontierResult:
    """最適化全結果。frozen=True で不変。"""
    optimal: OptimalWeights
    regime_used: str
    frontier_points: tuple[OptimalWeights, ...]
    diagnostics: tuple[str, ...]

    def get_weight(self, ticker: str) -> float:
        return self.optimal.get_weight(ticker)

    def to_dict(self) -> dict:
        return {
            "optimal":         self.optimal.to_dict(),
            "regime_used":     self.regime_used,
            "frontier_points": [fp.to_dict() for fp in self.frontier_points],
            "diagnostics":     list(self.diagnostics),
        }


# ── 最適化クラス ──────────────────────────────────────────────────────────────

class EfficientFrontierOptimizer:
    """
    Sharpe 最大化最適化（SLSQP）。

    計算のみ。注文・推奨・判定は行わない。
    """

    SLSQP_MAXITER: int = 200
    SLSQP_FTOL:    float = 1e-8

    def optimize(self, inp: EfficientFrontierInput) -> EfficientFrontierResult:
        diag: list[str] = []
        regime_used = inp.constraints.regime_used
        n = len(inp.tickers)

        # ── 空 tickers ────────────────────────────────────────────────────────
        if n == 0:
            diag.append("observation: tickers is empty; optimization skipped")
            empty_opt = OptimalWeights(
                tickers=(), weights=(),
                expected_return=0.0, expected_vol=0.0,
                sharpe_ratio=0.0, soft_penalty=0.0,
                solver_converged=False,
                solver_message="empty tickers",
                diagnostics=tuple(diag),
            )
            return EfficientFrontierResult(
                optimal=empty_opt, regime_used=regime_used,
                frontier_points=(), diagnostics=tuple(diag),
            )

        # ── ベクトル / 行列のアライメント ─────────────────────────────────────
        mu_vec      = self._align_expected_returns(inp.tickers, inp.expected_returns, diag)
        aligned_cov = self._align_cov_matrix(inp.tickers, inp.cov_result, diag)
        bounds      = inp.constraints.get_bounds_as_pairs()
        risk_aversion = float(inp.constraints.risk_aversion)

        # ── 初期ウェイト ──────────────────────────────────────────────────────
        w0 = self._build_initial_weights(inp.tickers, bounds)

        # ── scipy 未インストール → fallback ───────────────────────────────────
        if not _SCIPY_AVAILABLE:
            diag.append("observation: scipy not available; SLSQP optimization skipped, fallback weights used")
            fb_w = self._fallback_weights(inp.tickers, bounds)
            return self._build_result_from_weights(
                inp, fb_w, mu_vec, aligned_cov, regime_used,
                solver_converged=False,
                solver_message="scipy unavailable",
                diag=diag,
            )

        # ── SLSQP 制約構築 ────────────────────────────────────────────────────
        slsqp_constraints = self._build_slsqp_constraints(inp.tickers, inp.constraints)

        # ── objective function（closure） ─────────────────────────────────────
        def neg_utility(w: Any) -> float:
            w_list = [float(x) for x in w]
            ret     = self._calc_portfolio_expected_return(w_list, mu_vec)
            var     = self._calc_portfolio_variance(w_list, aligned_cov)
            penalty = self._calc_soft_penalty(w_list, inp.constraints, inp.tickers)
            return -(ret - 0.5 * risk_aversion * var - penalty)

        # ── SLSQP 実行 ────────────────────────────────────────────────────────
        try:
            result = _scipy_minimize(  # type: ignore[misc]
                neg_utility, w0,
                method="SLSQP",
                bounds=bounds,
                constraints=slsqp_constraints,
                options={"maxiter": self.SLSQP_MAXITER, "ftol": self.SLSQP_FTOL},
            )
        except Exception as exc:  # noqa: BLE001 — scipy may raise various errors
            diag.append(f"observation: SLSQP raised exception: {type(exc).__name__}; fallback weights used")
            fb_w = self._fallback_weights(inp.tickers, bounds)
            return self._build_result_from_weights(
                inp, fb_w, mu_vec, aligned_cov, regime_used,
                solver_converged=False,
                solver_message=f"exception: {type(exc).__name__}",
                diag=diag,
            )

        solver_msg = str(result.message) if hasattr(result, "message") else ""
        if not bool(result.success):
            diag.append(f"observation: SLSQP did not converge ({solver_msg}); fallback weights used")
            fb_w = self._fallback_weights(inp.tickers, bounds)
            return self._build_result_from_weights(
                inp, fb_w, mu_vec, aligned_cov, regime_used,
                solver_converged=False,
                solver_message=solver_msg or "non-convergence",
                diag=diag,
            )

        # ── 成功: scipy 結果を Python list に変換 ────────────────────────────
        optimal_w = [float(x) for x in result.x]
        # 数値誤差で bounds をわずかに逸脱した場合の clip
        for i, (lo, hi) in enumerate(bounds):
            optimal_w[i] = _clamp(optimal_w[i], lo, hi)

        diag.append(f"observation: SLSQP converged ({solver_msg})")
        return self._build_result_from_weights(
            inp, optimal_w, mu_vec, aligned_cov, regime_used,
            solver_converged=True,
            solver_message=solver_msg or "converged",
            diag=diag,
        )

    # ── 結果構築ヘルパー ──────────────────────────────────────────────────────

    def _build_result_from_weights(
        self,
        inp: EfficientFrontierInput,
        weights: list[float],
        mu_vec: list[float],
        aligned_cov: list[list[float]],
        regime_used: str,
        *,
        solver_converged: bool,
        solver_message: str,
        diag: list[str],
    ) -> EfficientFrontierResult:
        expected_return = self._calc_portfolio_expected_return(weights, mu_vec)
        variance        = self._calc_portfolio_variance(weights, aligned_cov)
        expected_vol    = math.sqrt(max(variance, 0.0))
        sharpe          = self._calc_sharpe_ratio(expected_return, expected_vol, inp.risk_free_rate)
        soft_penalty    = self._calc_soft_penalty(weights, inp.constraints, inp.tickers)

        opt = OptimalWeights(
            tickers=inp.tickers,
            weights=tuple(weights),
            expected_return=expected_return,
            expected_vol=expected_vol,
            sharpe_ratio=sharpe,
            soft_penalty=soft_penalty,
            solver_converged=solver_converged,
            solver_message=solver_message,
            diagnostics=tuple(diag),
        )
        return EfficientFrontierResult(
            optimal=opt,
            regime_used=regime_used,
            frontier_points=(),
            diagnostics=tuple(diag),
        )

    # ── アライメント ──────────────────────────────────────────────────────────

    def _align_expected_returns(
        self, tickers: tuple[str, ...], expected_returns: dict[str, float], diag: list[str]
    ) -> list[float]:
        result: list[float] = []
        for t in tickers:
            if t in expected_returns:
                result.append(_safe_float(expected_returns[t], 0.0))
            else:
                result.append(0.0)
                diag.append(f"observation: expected_return missing for {t}; using 0.0 fallback")
        return result

    def _align_cov_matrix(
        self, tickers: tuple[str, ...], cov_result: CovarianceResult, diag: list[str]
    ) -> list[list[float]]:
        n = len(tickers)
        if n == 0:
            return []

        cov_ticker_idx = {t: i for i, t in enumerate(cov_result.tickers)}
        aligned: list[list[float]] = [[0.0] * n for _ in range(n)]
        fallback_var = DEFAULT_MONTHLY_VARIANCE * 12

        missing: list[str] = []
        for i, ti in enumerate(tickers):
            if ti not in cov_ticker_idx:
                missing.append(ti)
            for j, tj in enumerate(tickers):
                if ti in cov_ticker_idx and tj in cov_ticker_idx:
                    ci = cov_ticker_idx[ti]
                    cj = cov_ticker_idx[tj]
                    aligned[i][j] = float(cov_result.cov_matrix[ci][cj])
                elif ti == tj:
                    aligned[i][j] = fallback_var

        for t in missing:
            diag.append(
                f"observation: cov_matrix missing for {t}; "
                "diagonal fallback used and off-diagonal covariance set to 0.0"
            )

        return aligned

    # ── ポートフォリオ計算 ────────────────────────────────────────────────────

    def _calc_portfolio_expected_return(
        self, weights: list[float], mu_vec: list[float]
    ) -> float:
        return sum(weights[i] * mu_vec[i] for i in range(len(weights)))

    def _calc_portfolio_variance(
        self, weights: list[float], aligned_cov: list[list[float]]
    ) -> float:
        n = len(weights)
        if n == 0:
            return 0.0
        # Σw: matrix-vector product
        Sw = [
            sum(aligned_cov[i][j] * weights[j] for j in range(n))
            for i in range(n)
        ]
        # w^T (Σw)
        return sum(weights[i] * Sw[i] for i in range(n))

    def _calc_portfolio_vol(
        self, weights: list[float], aligned_cov: list[list[float]]
    ) -> float:
        return math.sqrt(max(self._calc_portfolio_variance(weights, aligned_cov), 0.0))

    def _calc_sharpe_ratio(
        self, expected_return: float, expected_vol: float, risk_free_rate: float
    ) -> float:
        if expected_vol <= 0.0:
            return 0.0
        return (expected_return - risk_free_rate) / expected_vol

    # ── soft penalty ─────────────────────────────────────────────────────────

    def _calc_soft_penalty(
        self,
        weights: list[float],
        constraints: OptimizerConstraints,
        tickers: tuple[str, ...],
    ) -> float:
        ticker_idx = {t: i for i, t in enumerate(tickers)}
        penalty = 0.0
        for sp in constraints.soft_penalties:
            if not sp.tickers:                       # T8 など tickers=() は skip
                continue
            sp_indices = [ticker_idx[t] for t in sp.tickers if t in ticker_idx]
            if not sp_indices:
                continue
            group_w = sum(weights[i] for i in sp_indices)

            # Lower violations（T5 core floor）
            lower_viol_warn   = max(0.0, sp.lower_warn   - group_w)
            lower_viol_severe = max(0.0, sp.lower_severe - group_w)
            # Upper violations（T6 leverage cap, T7 per-ticker）
            upper_viol_warn   = max(0.0, group_w - sp.upper_warn)
            upper_viol_severe = max(0.0, group_w - sp.upper_severe)

            penalty += sp.penalty_coef_warn   * lower_viol_warn
            penalty += sp.penalty_coef_severe * lower_viol_severe
            penalty += sp.penalty_coef_warn   * upper_viol_warn
            penalty += sp.penalty_coef_severe * upper_viol_severe

        return penalty

    # ── 初期ウェイト ──────────────────────────────────────────────────────────

    def _build_initial_weights(
        self, tickers: tuple[str, ...], bounds: list[tuple[float, float]]
    ) -> list[float]:
        """初期ウェイト: locked → 固定、free → 残余を等分。"""
        return self._fallback_weights(tickers, bounds)

    # ── SLSQP 制約 ────────────────────────────────────────────────────────────

    def _build_slsqp_constraints(
        self, tickers: tuple[str, ...], constraints: OptimizerConstraints
    ) -> list[dict]:
        ticker_idx = {t: i for i, t in enumerate(tickers)}

        # Budget equality: sum(w) - 1 == 0
        slsqp_list: list[dict] = [
            {
                "type": "eq",
                "fun": lambda w: sum(float(x) for x in w) - 1.0,
            }
        ]

        # Sector caps: cap - sum(w_sector) >= 0
        for sc in constraints.sector_caps:
            cap_indices = [ticker_idx[t] for t in sc.tickers if t in ticker_idx]
            if not cap_indices:
                continue
            slsqp_list.append({
                "type": "ineq",
                "fun": (
                    lambda w, idx=cap_indices, cap=sc.max_weight:
                    cap - sum(float(w[i]) for i in idx)
                ),
            })

        return slsqp_list

    # ── fallback ──────────────────────────────────────────────────────────────

    def _fallback_weights(
        self, tickers: tuple[str, ...], bounds: list[tuple[float, float]]
    ) -> list[float]:
        """
        fallback ウェイト:
          - locked ticker: locked_weight を維持
          - free ticker:   残余を等分
          - locked sum > 1.0: locked を合計1.0に正規化、free=0.0
        """
        n = len(tickers)
        if n == 0:
            return []

        locked: list[tuple[int, float]] = []
        free_indices: list[int] = []
        for i, (lo, hi) in enumerate(bounds):
            if lo == hi:
                locked.append((i, float(lo)))
            else:
                free_indices.append(i)

        locked_sum = sum(w for _, w in locked)
        w = [0.0] * n

        if locked_sum > 1.0 and locked_sum > 0.0:
            # locked を合計1.0に正規化、free=0.0
            scale = 1.0 / locked_sum
            for i, lw in locked:
                w[i] = lw * scale
            # free は 0.0 のまま
        else:
            for i, lw in locked:
                w[i] = lw
            remaining = max(0.0, 1.0 - locked_sum)
            if free_indices and remaining > 0.0:
                per_free = remaining / len(free_indices)
                for i in free_indices:
                    w[i] = per_free

        return w
