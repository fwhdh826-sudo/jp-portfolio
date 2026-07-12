"""
expected_return_model.py — Card 8-1
Phase 8 Frontier Engine: 期待リターン推定モデル。

責務:
  - AssetMetaInput       — 銘柄メタ情報（frozen dataclass）
  - MarketIntelContext   — market_intel DI コンテナ（frozen dataclass）
  - ExpectedReturnInput  — 計算入力（frozen dataclass）
  - AssetExpectedReturn  — 銘柄別期待リターン結果（frozen dataclass）
  - ExpectedReturnResult — 全銘柄結果コンテナ（frozen dataclass）
  - ExpectedReturnModel  — 計算クラス

計算式:
  AXIS_ALPHA_SCALE = 0.006
  alpha_score  = Σ((clamp(total, 0, 100) - 50) / 50 * AXIS_ALPHA_SCALE * axis_weight)
  alpha_cross  = size_quality / 100 * 0.005 + anti_junk / 100 * 0.003
  size_premium = small_cap: 0.012 / mid_cap: 0.005 / large_cap: 0.000
  alpha_market = sentiment + keyword overlays（market_intel が None → 0.0）
  expected_return = mu_hist + alpha_score + alpha_cross + size_premium + alpha_market

設計原則:
  - stdlib-only（math のみ）
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/signal/decision/verdict/approve/reject 禁止
  - operation/market_intel/news/regime を直接 import しない（DI で受け取る）
  - expected_return は clamp しない（Card 8-3 optimizer の責務）
  - 全 diagnostics は "observation: " プレフィックス

P1 記録:
  P1-8A: mean_return_3y=0.0 は有効値。mu_hist の妥当性検証は呼び出し元責務。
  P1-8B: keywords のキーワードマッチは完全一致のみ（"資源高", "円安"）。
  P1-8C: get_expected_return(ticker) インタフェースは Card 8-3 消費のために固定。

P2 記録:
  P2-8A: expected_return は clamp なし。Card 8-3 optimizer が境界を担う。
  P2-8B: FrontierStrategy への接続は Card 8-3 に延期（P2-7D 継続）。
  P2-8C: AXIS_ALPHA_SCALE=0.006 → alpha_score の最大値 ≈ ±0.006（axis_weights 合計=1.0）。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 8-1
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from engine.dynamic_weight.regime_axis_weights import (
    CANONICAL_AXES,
    get_axis_weights,
)

# ── 定数 ─────────────────────────────────────────────────────────────────────

AXIS_ALPHA_SCALE: float = 0.006

_VALID_SIZE_SEGMENTS: frozenset[str] = frozenset({"small_cap", "mid_cap", "large_cap"})

_SIZE_PREMIUM: dict[str, float] = {
    "small_cap": 0.012,
    "mid_cap":   0.005,
    "large_cap": 0.000,
}

_SENTIMENT_HIGH_THRESHOLD: float = 70.0
_SENTIMENT_LOW_THRESHOLD:  float = 30.0


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
class AssetMetaInput:
    """銘柄メタ情報。frozen=True で不変。"""
    ticker: str
    mean_return_3y: float
    size_segment: str
    is_risk_on:   bool = False
    is_defensive: bool = False
    is_energy:    bool = False
    is_overseas:  bool = False

    def __post_init__(self) -> None:
        if not self.ticker or not isinstance(self.ticker, str):
            raise ValueError(f"ticker must be a non-empty string, got: {self.ticker!r}")
        # mean_return_3y を安全な float に正規化（frozen なので object.__setattr__ を使用）
        safe = _safe_float(self.mean_return_3y, default=0.0)
        object.__setattr__(self, "mean_return_3y", safe)


@dataclass(frozen=True)
class MarketIntelContext:
    """market_intel DI コンテナ。frozen=True で不変。"""
    sentiment_score: float
    keywords: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        clamped = _clamp(_safe_float(self.sentiment_score, 50.0), 0.0, 100.0)
        object.__setattr__(self, "sentiment_score", clamped)
        # list → tuple 変換
        if isinstance(self.keywords, list):
            object.__setattr__(self, "keywords", tuple(self.keywords))


@dataclass(frozen=True)
class ExpectedReturnInput:
    """期待リターン計算の全入力。frozen=True で不変。"""
    assets: tuple[AssetMetaInput, ...]
    six_axis_scores: dict[str, dict]
    cross_axis_signals: dict[str, dict]
    regime: str
    market_intel: MarketIntelContext | None = None
    context: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        # assets: list → tuple 変換
        if isinstance(self.assets, list):
            object.__setattr__(self, "assets", tuple(self.assets))
        # context: 無効値 → {}
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})
        # six_axis_scores / cross_axis_signals: 無効値 → {}
        if not isinstance(self.six_axis_scores, dict):
            object.__setattr__(self, "six_axis_scores", {})
        if not isinstance(self.cross_axis_signals, dict):
            object.__setattr__(self, "cross_axis_signals", {})


@dataclass(frozen=True)
class AssetExpectedReturn:
    """銘柄別期待リターン結果。frozen=True で不変。"""
    ticker: str
    expected_return: float
    mu_hist: float
    alpha_score: float
    alpha_cross: float
    size_premium: float
    alpha_market: float
    diagnostics: tuple[str, ...]

    def to_dict(self) -> dict:
        return {
            "ticker":          self.ticker,
            "expected_return": self.expected_return,
            "mu_hist":         self.mu_hist,
            "alpha_score":     self.alpha_score,
            "alpha_cross":     self.alpha_cross,
            "size_premium":    self.size_premium,
            "alpha_market":    self.alpha_market,
            "diagnostics":     list(self.diagnostics),
        }


@dataclass(frozen=True)
class ExpectedReturnResult:
    """全銘柄期待リターン結果コンテナ。frozen=True で不変。"""
    per_asset: tuple[AssetExpectedReturn, ...]
    regime_used: str
    market_intel_used: bool
    diagnostics: tuple[str, ...]

    def to_dict(self) -> dict:
        return {
            "per_asset":         [a.to_dict() for a in self.per_asset],
            "regime_used":       self.regime_used,
            "market_intel_used": self.market_intel_used,
            "diagnostics":       list(self.diagnostics),
        }

    def get_expected_return(self, ticker: str) -> float | None:
        for asset in self.per_asset:
            if asset.ticker == ticker:
                return asset.expected_return
        return None


# ── 計算クラス ────────────────────────────────────────────────────────────────

class ExpectedReturnModel:
    """
    期待リターン推定モデル（stdlib-only）。

    計算のみ。注文・推奨・判定は行わない。
    """

    def calculate(self, inp: ExpectedReturnInput) -> ExpectedReturnResult:
        regime_used = inp.regime if inp.regime in (
            "bull_calm", "bull_volatile", "bear", "crisis", "uncertain"
        ) else "uncertain"

        if regime_used != inp.regime:
            global_diag = [
                f"observation: unknown regime={inp.regime!r}; fallback to 'uncertain'"
            ]
        else:
            global_diag: list[str] = []

        axis_weights = get_axis_weights(regime_used)
        market_intel_used = inp.market_intel is not None

        per_asset: list[AssetExpectedReturn] = []
        for asset in inp.assets:
            result = self._calc_asset(asset, inp, axis_weights)
            per_asset.append(result)

        return ExpectedReturnResult(
            per_asset=tuple(per_asset),
            regime_used=regime_used,
            market_intel_used=market_intel_used,
            diagnostics=tuple(global_diag),
        )

    # ── 銘柄別計算 ────────────────────────────────────────────────────────────

    def _calc_asset(
        self,
        asset: AssetMetaInput,
        inp: ExpectedReturnInput,
        axis_weights: dict[str, float],
    ) -> AssetExpectedReturn:
        diag: list[str] = []
        ticker = asset.ticker
        mu_hist = asset.mean_return_3y

        alpha_score, score_diag = self._calc_alpha_score(ticker, inp.six_axis_scores, axis_weights)
        diag.extend(score_diag)

        alpha_cross, cross_diag = self._calc_alpha_cross(ticker, inp.cross_axis_signals)
        diag.extend(cross_diag)

        size_premium, size_diag = self._calc_size_premium(asset)
        diag.extend(size_diag)

        alpha_market, mkt_diag = self._calc_alpha_market(asset, inp.market_intel)
        diag.extend(mkt_diag)

        expected_return = mu_hist + alpha_score + alpha_cross + size_premium + alpha_market

        diag.append(
            "observation: expected_return is an estimate based on historical data and scoring "
            "adjustments; not a guarantee of future returns; calculation-only, not an order, "
            "not a recommendation"
        )

        return AssetExpectedReturn(
            ticker=ticker,
            expected_return=expected_return,
            mu_hist=mu_hist,
            alpha_score=alpha_score,
            alpha_cross=alpha_cross,
            size_premium=size_premium,
            alpha_market=alpha_market,
            diagnostics=tuple(diag),
        )

    def _calc_alpha_score(
        self,
        ticker: str,
        six_axis_scores: dict[str, dict],
        axis_weights: dict[str, float],
    ) -> tuple[float, list[str]]:
        diag: list[str] = []
        scores_for_ticker = six_axis_scores.get(ticker, {})
        alpha = 0.0
        for ax in CANONICAL_AXES:
            weight = axis_weights.get(ax, 0.0)
            ax_data = scores_for_ticker.get(ax, {})
            raw_total = ax_data.get("total") if isinstance(ax_data, dict) else None
            if raw_total is None:
                total = 50.0
                diag.append(
                    f"observation: {ticker} axis={ax} total missing; using neutral fallback 50.0"
                )
            else:
                total = _clamp(_safe_float(raw_total, 50.0), 0.0, 100.0)
            alpha += (total - 50.0) / 50.0 * AXIS_ALPHA_SCALE * weight
        return alpha, diag

    def _calc_alpha_cross(
        self,
        ticker: str,
        cross_axis_signals: dict[str, dict],
    ) -> tuple[float, list[str]]:
        diag: list[str] = []
        cross = cross_axis_signals.get(ticker)
        if cross is None:
            diag.append(
                f"observation: {ticker} not found in cross_axis_signals; alpha_cross=0.0"
            )
            return 0.0, diag

        size_quality = _safe_float(cross.get("size_quality"), 0.0)
        anti_junk    = _safe_float(cross.get("anti_junk"),    0.0)
        alpha = size_quality / 100.0 * 0.005 + anti_junk / 100.0 * 0.003
        return alpha, diag

    def _calc_size_premium(
        self,
        asset: AssetMetaInput,
    ) -> tuple[float, list[str]]:
        diag: list[str] = []
        seg = asset.size_segment
        if seg not in _VALID_SIZE_SEGMENTS:
            diag.append(
                f"observation: unknown size_segment={seg!r} for {asset.ticker}; size_premium=0.000"
            )
            return 0.0, diag
        return _SIZE_PREMIUM[seg], diag

    def _calc_alpha_market(
        self,
        asset: AssetMetaInput,
        market_intel: MarketIntelContext | None,
    ) -> tuple[float, list[str]]:
        diag: list[str] = []
        if market_intel is None:
            diag.append(
                "observation: market_intel not provided; alpha_market=0.0 (P2-7F)"
            )
            return 0.0, diag

        sentiment = market_intel.sentiment_score
        keywords  = market_intel.keywords
        alpha     = 0.0

        if sentiment > _SENTIMENT_HIGH_THRESHOLD and asset.is_risk_on:
            alpha += 0.005
        if sentiment < _SENTIMENT_LOW_THRESHOLD and asset.is_defensive:
            alpha += 0.003
        if sentiment < _SENTIMENT_LOW_THRESHOLD and not asset.is_defensive:
            alpha -= 0.003
        if "資源高" in keywords and asset.is_energy:
            alpha += 0.004
        if "円安" in keywords and asset.is_overseas:
            alpha += 0.002

        return alpha, diag
