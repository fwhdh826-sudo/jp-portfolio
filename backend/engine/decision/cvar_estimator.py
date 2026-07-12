"""
CVaR Estimator — Card 5-8
Phase 5 意思決定エンジン: CVaR（Conditional Value at Risk / 条件付き期待損失）計算。

責務:
  - CVaRInput      — CVaR計算入力を保持する frozen dataclass
  - CVaRResult     — CVaR計算結果を保持する frozen dataclass
  - CVaREstimator  — シナリオベース / パラメトリックの2モードでCVaRを計算
  - _FACTORS       — 正規分布 CVaR パーセンタイル別定数テーブル
  - CVaREstimator.estimate(input) → CVaRResult

CVaRモード:
  シナリオモード: scenarios が非空のとき
    - scenarios を float 変換して昇順ソート
    - cutoff = max(1, int(len(scenarios) * percentile))
    - cvar = mean(sorted[:cutoff])  ← lower-tail 平均
  パラメトリックモード: scenarios が空のとき
    - factor = _FACTORS.get(percentile, _FACTORS[0.05])（未知percentile→0.05 fallback）
    - cvar = ev_final - volatility * factor
    - 正規分布近似: 下側5%のE[X|X<μ-1.6449σ] ≈ μ - 2.063σ

CVaR値はクランプしない（深い損失シナリオを表現するため）。

売買判断の境界線:
  CVaREstimator は数値計算のみを行う補助指標モジュール。
  is_acceptable_risk などの判断フィールドは持たない。

実装しないこと:
  - BUY / SELL / HOLD / WAIT 等の判定
  - is_acceptable_risk などの判断フィールド
  - 銘柄推奨・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / regime / market_intel / news の import
  - backend.engine.decision.ev_calculator の import

Reference: docs/v13.3/05_v13.3_master_plan.md A6
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-8
"""
from __future__ import annotations

from dataclasses import dataclass

# ── 定数 ─────────────────────────────────────────────────────────────────────

# 正規分布における下側 CVaR の標準偏差倍率（事前計算値、scipy/numpy 不使用）
# 算出根拠: E[X | X < z_alpha] = -φ(z_alpha) / alpha
#   alpha=0.01: -φ(2.3263)/0.01 ≈ 2.665
#   alpha=0.05: -φ(1.6449)/0.05 ≈ 2.063
#   alpha=0.10: -φ(1.2816)/0.10 ≈ 1.755
_FACTORS: dict[float, float] = {
    0.01: 2.665,
    0.05: 2.063,
    0.10: 1.755,
}


# ── DataClasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CVaRInput:
    """CVaR計算入力。immutable。"""

    ticker:     str                    # 銘柄コード
    ev_final:   float                  # 期待リターン（EVResult.ev_final を平 float で受け取る）
    volatility: float                  # 年率ボラティリティ（例: 0.20 = 20%）、パラメトリック用
    scenarios:  tuple[float, ...] = () # 下落シナリオ群（空=パラメトリックモード）
    percentile: float = 0.05           # 下側パーセンタイル（デフォルト 5%）


@dataclass(frozen=True)
class CVaRResult:
    """CVaR計算結果。算術結果のみ保持し判断フィールドは持たない。immutable。"""

    ticker:         str    # 銘柄コード
    ev_final:       float  # 入力をそのまま保持
    cvar:           float  # 算出 CVaR（負になりうる、クランプしない）
    cvar_mode:      str    # "scenario" | "parametric"
    scenario_count: int    # シナリオ数（パラメトリック時 = 0）
    tail_cutoff:    int    # 使用した tail シナリオ数（パラメトリック時 = 0）
    # is_acceptable_risk などの判断フィールドは意図的に持たない


# ── CVaREstimator ─────────────────────────────────────────────────────────────

class CVaREstimator:
    """
    CVaR（Conditional Value at Risk）を計算する。補助指標モジュール。

    scenarios が非空ならシナリオモード、空ならパラメトリックモードを使用する。
    CVaR値はクランプしない。backend.engine.decision.ev_calculator を import しない。
    """

    def estimate(self, ev_input: CVaRInput) -> CVaRResult:
        """
        CVaRInput から CVaRResult を計算する。

        Args:
            ev_input: CVaR計算に必要な入力。
        Returns:
            CVaRResult: cvar / cvar_mode / scenario_count / tail_cutoff を含む結果。
        """
        if ev_input.scenarios:
            return self._estimate_scenario(ev_input)
        return self._estimate_parametric(ev_input)

    # ── scenario mode ─────────────────────────────────────────────────────────

    def _estimate_scenario(self, ev_input: CVaRInput) -> CVaRResult:
        """
        シナリオベース CVaR。
        lower-tail の平均を返す。scenarios 内の値は float に変換して処理。
        """
        floated = [float(x) for x in ev_input.scenarios]
        sorted_scenarios = sorted(floated)
        cutoff = max(1, int(len(sorted_scenarios) * ev_input.percentile))
        tail = sorted_scenarios[:cutoff]
        cvar = sum(tail) / len(tail)

        return CVaRResult(
            ticker=ev_input.ticker,
            ev_final=ev_input.ev_final,
            cvar=cvar,
            cvar_mode="scenario",
            scenario_count=len(sorted_scenarios),
            tail_cutoff=cutoff,
        )

    # ── parametric mode ───────────────────────────────────────────────────────

    def _estimate_parametric(self, ev_input: CVaRInput) -> CVaRResult:
        """
        パラメトリック CVaR（正規分布近似）。
        未知の percentile は 0.05 の factor にフォールバック。
        volatility=0.0 のとき cvar = ev_final（損失ゼロ）。
        """
        factor = _FACTORS.get(ev_input.percentile, _FACTORS[0.05])
        cvar   = ev_input.ev_final - ev_input.volatility * factor

        return CVaRResult(
            ticker=ev_input.ticker,
            ev_final=ev_input.ev_final,
            cvar=cvar,
            cvar_mode="parametric",
            scenario_count=0,
            tail_cutoff=0,
        )
