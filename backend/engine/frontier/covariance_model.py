"""
covariance_model.py — Card 8-2
Phase 8 Frontier Engine: 共分散行列モデル。

責務:
  - CovarianceInput   — 共分散計算入力（frozen dataclass）
  - CovarianceResult  — 共分散行列・相関行列・ボラティリティ結果（frozen dataclass）
  - CovarianceModel   — 計算クラス

計算仕様:
  1. strict intersection（min(len) を使用、末尾優先）
  2. サンプル共分散（n-1 分母）
  3. James-Stein 対角収縮（avg_variance; shrinkage_alpha=0 → shrinkage_applied=False）
  4. 年次化（cov_monthly × 12）
  5. ボラティリティ = sqrt(max(cov_annual[i][i], 0.0))
  6. 相関行列: zero-vol → identity fallback（i==j: 1.0, i!=j: 0.0）
  7. missing ticker: 局所 fallback（diagonal=DEFAULT_MONTHLY_VARIANCE×12, off-diagonal=0.0）
  8. n_obs < min_periods: 全体 fallback

設計原則:
  - stdlib-only（math のみ）
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/signal/decision/verdict/approve/reject 禁止
  - 実 HTTP / API / LLM 接続禁止
  - 全 diagnostics は "observation: " プレフィックス
  - expected_return 計算 / 注文生成は行わない

P1 記録:
  P1-8D: returns_data 単位は月次リターン小数（2% → 0.02）。呼び出し元責務。
  P1-8E: strict intersection = min(len(series))、末尾優先。
  P1-8F: cov_matrix は tuple[tuple[float,...],...]（frozen）。Card 8-3 はインデックスアクセスで消費。

P2 記録:
  P2-8D: Ledoit-Wolf 最適収縮は延期。James-Stein 対角収縮（avg_variance）で近似。
  P2-8E: 正定値保証・near-singular ε 正規化は Card 8-3 optimizer が担う。
  P2-8F: per-pair 最大データ使用は延期。strict intersection を継続。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 8-2
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# ── 定数 ─────────────────────────────────────────────────────────────────────

# missing ticker / zero-variance fallback の月次分散デフォルト（1%月次リターン分散）
DEFAULT_MONTHLY_VARIANCE: float = 0.01 ** 2


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
class CovarianceInput:
    """共分散計算入力。frozen=True で不変。"""
    tickers: tuple[str, ...]
    returns_data: dict[str, list[float]]
    shrinkage_alpha: float = 0.1
    min_periods: int = 3
    regime: str = "uncertain"
    context: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if isinstance(self.tickers, list):
            object.__setattr__(self, "tickers", tuple(self.tickers))
        clamped = _clamp(_safe_float(self.shrinkage_alpha, 0.0), 0.0, 1.0)
        object.__setattr__(self, "shrinkage_alpha", clamped)
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})
        if not isinstance(self.returns_data, dict):
            object.__setattr__(self, "returns_data", {})


@dataclass(frozen=True)
class CovarianceResult:
    """共分散行列・相関行列・ボラティリティ結果。frozen=True で不変。"""
    tickers: tuple[str, ...]
    cov_matrix: tuple[tuple[float, ...], ...]       # n×n, 年次
    correlation_matrix: tuple[tuple[float, ...], ...]  # n×n
    volatilities: tuple[float, ...]                 # 年次 vol
    shrinkage_applied: bool
    fallback_used: bool
    diagnostics: tuple[str, ...]

    def get_portfolio_variance(self, weights: list[float]) -> float:
        """ポートフォリオ分散 w^T Σ w を計算（stdlib ループ、O(n²)）。"""
        n = len(self.tickers)
        if n == 0:
            return 0.0
        # Σw: matrix-vector product
        Sw = [
            sum(self.cov_matrix[i][j] * weights[j] for j in range(n))
            for i in range(n)
        ]
        # w^T (Σw): dot product
        return sum(weights[i] * Sw[i] for i in range(n))

    def get_portfolio_vol(self, weights: list[float]) -> float:
        """ポートフォリオ年次ボラティリティ sqrt(w^T Σ w)。"""
        return math.sqrt(max(self.get_portfolio_variance(weights), 0.0))

    def to_dict(self) -> dict:
        return {
            "tickers":            list(self.tickers),
            "cov_matrix":         [list(row) for row in self.cov_matrix],
            "correlation_matrix": [list(row) for row in self.correlation_matrix],
            "volatilities":       list(self.volatilities),
            "shrinkage_applied":  self.shrinkage_applied,
            "fallback_used":      self.fallback_used,
            "diagnostics":        list(self.diagnostics),
        }


# ── 計算クラス ────────────────────────────────────────────────────────────────

class CovarianceModel:
    """
    共分散行列推定モデル（stdlib-only）。

    計算のみ。注文・推奨・判定は行わない。
    """

    def calculate(self, inp: CovarianceInput) -> CovarianceResult:
        tickers = inp.tickers
        n = len(tickers)
        diag: list[str] = []

        # ── 空 tickers ────────────────────────────────────────────────────────
        if n == 0:
            diag.append("observation: tickers is empty; covariance_matrix is empty")
            return CovarianceResult(
                tickers=(), cov_matrix=(), correlation_matrix=(),
                volatilities=(), shrinkage_applied=False, fallback_used=False,
                diagnostics=tuple(diag),
            )

        # ── valid / missing tickers 分類 ──────────────────────────────────────
        valid_indices: list[int] = []
        missing_indices: list[int] = []
        for i, t in enumerate(tickers):
            series = inp.returns_data.get(t)
            if series is not None and len(series) > 0:
                valid_indices.append(i)
            else:
                missing_indices.append(i)
                if series is None:
                    diag.append(
                        f"observation: ticker {t} not in returns_data; "
                        "diagonal fallback used and off-diagonal covariance set to 0.0"
                    )
                else:
                    diag.append(
                        f"observation: ticker {t} has empty returns series; "
                        "diagonal fallback used and off-diagonal covariance set to 0.0"
                    )

        # ── n×n 行列初期化（ゼロ埋め） ─────────────────────────────────────────
        cov_full: list[list[float]] = [[0.0] * n for _ in range(n)]
        fallback_used = len(missing_indices) > 0
        shrinkage_applied = False

        # ── 全 ticker missing → 全体 fallback ────────────────────────────────
        if not valid_indices:
            fallback_used = True
            diag.append(
                "observation: no valid returns data for any ticker; "
                "full diagonal fallback covariance used"
            )
            for i in range(n):
                cov_full[i][i] = DEFAULT_MONTHLY_VARIANCE * 12

        else:
            # ── strict intersection ───────────────────────────────────────────
            n_obs = min(len(inp.returns_data[tickers[i]]) for i in valid_indices)

            # ── データ不足 → 全体 fallback ────────────────────────────────────
            if n_obs < inp.min_periods or n_obs < 2:
                fallback_used = True
                diag.append(
                    f"observation: insufficient data (n_obs={n_obs}) < min_periods="
                    f"{inp.min_periods}; fallback diagonal covariance used"
                )
                for i in range(n):
                    cov_full[i][i] = DEFAULT_MONTHLY_VARIANCE * 12

            else:
                # ── アライメント（末尾 n_obs を使用） ────────────────────────
                aligned: list[list[float]] = [
                    list(inp.returns_data[tickers[vi]][-n_obs:])
                    for vi in valid_indices
                ]

                # ── サンプル共分散（月次） ───────────────────────────────────
                cov_valid = self._sample_cov(aligned)

                # ── James-Stein 対角収縮 ─────────────────────────────────────
                if inp.shrinkage_alpha > 0.0:
                    cov_valid = self._apply_shrinkage(cov_valid, inp.shrinkage_alpha)
                    shrinkage_applied = True
                    diag.append(
                        f"observation: James-Stein diagonal shrinkage applied "
                        f"(alpha={inp.shrinkage_alpha})"
                    )

                # ── 年次化（× 12） ────────────────────────────────────────────
                nv = len(valid_indices)
                cov_valid_annual = [
                    [cov_valid[i][j] * 12 for j in range(nv)]
                    for i in range(nv)
                ]

                # ── 全体行列に valid tickers を配置 ──────────────────────────
                for vi, gi in enumerate(valid_indices):
                    for vj, gj in enumerate(valid_indices):
                        cov_full[gi][gj] = cov_valid_annual[vi][vj]

                # ── missing tickers の局所 fallback（対角のみ） ──────────────
                for mi in missing_indices:
                    cov_full[mi][mi] = DEFAULT_MONTHLY_VARIANCE * 12

        # ── ボラティリティ計算 ────────────────────────────────────────────────
        vols: list[float] = [math.sqrt(max(cov_full[i][i], 0.0)) for i in range(n)]

        # ── 相関行列（zero-vol → identity fallback） ──────────────────────────
        corr_full: list[list[float]] = [[0.0] * n for _ in range(n)]
        zero_vol_used = False
        for i in range(n):
            for j in range(n):
                if vols[i] == 0.0 or vols[j] == 0.0:
                    corr_full[i][j] = 1.0 if i == j else 0.0
                    zero_vol_used = True
                else:
                    raw = cov_full[i][j] / (vols[i] * vols[j])
                    corr_full[i][j] = max(-1.0, min(1.0, raw))

        if zero_vol_used:
            diag.append(
                "observation: zero variance detected; "
                "correlation fallback uses identity structure"
            )

        return CovarianceResult(
            tickers=tickers,
            cov_matrix=tuple(tuple(row) for row in cov_full),
            correlation_matrix=tuple(tuple(row) for row in corr_full),
            volatilities=tuple(vols),
            shrinkage_applied=shrinkage_applied,
            fallback_used=fallback_used,
            diagnostics=tuple(diag),
        )

    # ── 内部計算メソッド ──────────────────────────────────────────────────────

    def _sample_cov(self, aligned: list[list[float]]) -> list[list[float]]:
        """n×n サンプル共分散行列を計算（月次、n-1 分母、対称性保証）。"""
        nv = len(aligned)
        t = len(aligned[0])
        means = [sum(r) / t for r in aligned]
        cov: list[list[float]] = [[0.0] * nv for _ in range(nv)]
        denom = t - 1
        for i in range(nv):
            for j in range(i, nv):
                val = sum(
                    (aligned[i][k] - means[i]) * (aligned[j][k] - means[j])
                    for k in range(t)
                ) / denom
                cov[i][j] = val
                cov[j][i] = val
        return cov

    def _apply_shrinkage(self, cov: list[list[float]], alpha: float) -> list[list[float]]:
        """James-Stein 対角収縮: Σ_shrunk = (1-α)Σ + α * avg_variance * I。"""
        nv = len(cov)
        avg_variance = sum(cov[i][i] for i in range(nv)) / nv if nv > 0 else 0.0
        result: list[list[float]] = [[0.0] * nv for _ in range(nv)]
        for i in range(nv):
            for j in range(nv):
                shrink_target = avg_variance if i == j else 0.0
                result[i][j] = (1.0 - alpha) * cov[i][j] + alpha * shrink_target
        return result
