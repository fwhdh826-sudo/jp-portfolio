"""
protocol.py — Card 7-9
Phase 7 Multi-Strategy Engine: Pre-Mortem Protocol（事前検死プロトコル）。

責務:
  - PreMortemInput    — 事前検死計算への入力を保持する frozen dataclass（Flat DI）
  - PreMortemResult   — 計算結果を保持する frozen dataclass
  - PreMortemProtocol — conduct() で PreMortemResult を返すクラス

Pre-Mortem 計算アルゴリズム:
  1. behavioral risk 観察（behavioral_score >= 60.0 / behavioral_caution_count >= 2）
  2. committee risk 観察（committee_is_high_risk / committee_risk_level == "high"）
  3. vol 観察（is_vol_defined=False / exposure_multiplier >= 1.8）
  4. DD10 / CVaR 観察（optional DI）
  5. caution_count から sizing_multiplier_cap を計算（_CAP_TABLE）

_CAP_TABLE（P2-7AA）:
  caution_count=0 → 1.0
  caution_count=1 → 0.8
  caution_count=2 → 0.6
  caution_count=3 → 0.4
  caution_count>=4 → _CAP_MIN(0.2)

Flat DI 設計（P2-7AB）:
  behavioral / agents / decision の Result 型を直接 import しない。
  Operation 層が各 Result から数値を展開して渡す。

LLM 代替設計:
  docs/07 §8.3 の PreMortemProtocol 原案は call_llm_json を使用。
  当実装では禁止のため DI 済み数値入力のみで純計算する。
  LLM が生成する failure_scenarios テキストは Operation 層の責務とする。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - scipy / pandas / numpy 禁止（math stdlib のみ使用）
  - behavioral / agents / decision モジュールを直接 import しない

実装しないこと:
  - LLM による failure_scenarios テキスト生成
  - 発注指示・注文生成・差分売買
  - 銘柄推奨・売買命令
  - public / data writer

P1/P2 記録:
  P1-7Z: edge_factor に EDGE_FACTOR_MIN=0.1 を設定。完全停止判断は Operation 層に残す。
  P2-7AA: _CAP_TABLE は caution_count ベースの暫定表。Phase 8 以降でパラメータ化余地あり。
  P2-7AB: behavioral / committee / vol / DD10 / CVaR は flat DI。Result 型直接 import なし。
  P2-7AC: adjusted_size は weight であり、金額・株数変換は Operation 層。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-9
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


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


def _safe_int(raw: Any, fallback: int = 0) -> int:
    """None / str / NaN / inf → fallback。それ以外は int 変換（小数点切り捨て）。"""
    if raw is None:
        return fallback
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(val) or math.isinf(val):
        return fallback
    return int(val)


# ── 定数 ─────────────────────────────────────────────────────────────────────

_CAP_TABLE: dict[int, float] = {0: 1.0, 1: 0.8, 2: 0.6, 3: 0.4}
"""caution_count → sizing_multiplier_cap の変換表（P2-7AA 暫定）。"""

_CAP_MIN: float = 0.2
"""caution_count >= 4 のときの sizing_multiplier_cap 下限（観察的下限、売買停止命令ではない）。"""

_BEHAVIORAL_SCORE_THRESHOLD: float = 60.0
_BEHAVIORAL_CAUTION_COUNT_THRESHOLD: int = 2
_EXPOSURE_MULTIPLIER_HIGH_THRESHOLD: float = 1.8
_DD10_NEGATIVE_THRESHOLD: float = 0.0
_CVAR_DEEP_THRESHOLD: float = -0.15


# ── PreMortemInput ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PreMortemInput:
    """
    PreMortemProtocol.conduct() への入力。immutable。Flat DI 設計。

    behavioral / agents / decision の Result 型を直接受け取らない。
    Operation 層が各 Result から数値を展開して渡す（P2-7AB）。

    ticker:                      銘柄コード / 投信コード
    base_size:                   戦略層配分比率（weight, 0.0–1.0）
    behavioral_score:            行動バイアスリスクスコア（0.0–100.0）
                                 BehavioralScoreResult.behavioral_score から DI
    is_elevated_behavioral_risk: 観察値フラグ（behavioral_score >= 60.0）
                                 BehavioralScoreResult.is_elevated_risk から DI
    behavioral_caution_count:    観察された懸念パターン数（0 以上）
                                 len(BehavioralScoreResult.caution_flags) から DI
    committee_risk_level:        "low" / "moderate" / "high"
                                 CommitteeReport.aggregate_risk_level から DI
    committee_is_high_risk:      観察値フラグ（CommitteeReport.is_high_risk から DI）
    committee_confidence:        分析信頼度（0.0–1.0）
                                 CommitteeReport.aggregate_confidence から DI
    exposure_multiplier:         vol ターゲットスケール係数（>= 0）
                                 VolatilityTargetResult.exposure_multiplier から DI
    is_vol_defined:              vol 計算可否フラグ
                                 VolatilityTargetResult.is_vol_defined から DI
    dd10_uniform_return:         DD10 ユニフォームリターン（任意）
                                 DD10KPIResult から DI
    cvar_value:                  CVaR 値（任意）
                                 CVaRResult.cvar から DI
    regime:                      市況レジーム
    context:                     追加情報（任意）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / verdict / decision /
      approve / reject / conditional / go / no_go / pass_fail
    """

    ticker:                      str
    base_size:                   float
    behavioral_score:            float
    is_elevated_behavioral_risk: bool
    behavioral_caution_count:    int
    committee_risk_level:        str
    committee_is_high_risk:      bool
    committee_confidence:        float
    exposure_multiplier:         float
    is_vol_defined:              bool
    dd10_uniform_return:         float | None = None
    cvar_value:                  float | None = None
    regime:                      str  = "uncertain"
    context:                     dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "base_size",
            max(0.0, min(1.0, _safe_float(self.base_size, 0.0))),
        )
        object.__setattr__(
            self, "behavioral_score",
            max(0.0, min(100.0, _safe_float(self.behavioral_score, 0.0))),
        )
        object.__setattr__(
            self, "behavioral_caution_count",
            max(0, _safe_int(self.behavioral_caution_count, 0)),
        )
        object.__setattr__(
            self, "committee_confidence",
            max(0.0, min(1.0, _safe_float(self.committee_confidence, 0.0))),
        )
        object.__setattr__(
            self, "exposure_multiplier",
            max(0.0, _safe_float(self.exposure_multiplier, 1.0)),
        )
        if self.dd10_uniform_return is not None:
            object.__setattr__(
                self, "dd10_uniform_return",
                _safe_float(self.dd10_uniform_return, 0.0),
            )
        if self.cvar_value is not None:
            object.__setattr__(
                self, "cvar_value",
                _safe_float(self.cvar_value, 0.0),
            )
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})


# ── PreMortemResult ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PreMortemResult:
    """
    Pre-Mortem 計算結果。immutable。

    「リスク観察値の数値化」であり売買命令ではない。
    sizing_multiplier_cap は「観察的上限係数」（計算値）であり、
    「売買停止命令」「発注禁止命令」ではない。
    実際の発注・注文生成は Operation 層の責務。
    (calculation-only, not an order, not a recommendation)

    ticker:                銘柄コード / 投信コード
    sizing_multiplier_cap: 観察的上限係数（0.0–1.0）。caution_count → _CAP_TABLE 算出。
    caution_count:         観察された懸念数
    is_high_behavioral_risk: 観察値フラグ（is_elevated_behavioral_risk の引き継ぎ）
    is_high_committee_risk:  観察値フラグ（committee_is_high_risk の引き継ぎ）
    risk_observation_flags:  "observation:" prefix で統一された観察フラグ
    diagnostics:             計算過程の観察事実（"observation:" prefix 統一）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional /
      go / no_go / pass_fail / order / trade_order / rebalance_order
    """

    ticker:                  str
    sizing_multiplier_cap:   float
    caution_count:           int
    is_high_behavioral_risk: bool
    is_high_committee_risk:  bool
    risk_observation_flags:  tuple[str, ...]
    diagnostics:             tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.risk_observation_flags, tuple):
            object.__setattr__(self, "risk_observation_flags", tuple(self.risk_observation_flags))
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / int / bool / list のみ）。"""
        return {
            "ticker":                  self.ticker,
            "sizing_multiplier_cap":   self.sizing_multiplier_cap,
            "caution_count":           self.caution_count,
            "is_high_behavioral_risk": self.is_high_behavioral_risk,
            "is_high_committee_risk":  self.is_high_committee_risk,
            "risk_observation_flags":  list(self.risk_observation_flags),
            "diagnostics":             list(self.diagnostics),
        }


# ── PreMortemProtocol ─────────────────────────────────────────────────────────

class PreMortemProtocol:
    """
    新規ポジション事前検死プロトコル。

    conduct() は pure computation:
      - PreMortemInput を受け取り PreMortemResult を返す
      - 売買判断・注文生成・発注制限は行わない
      - LLM / HTTP 接続は行わない（docs/07 §8.3 原案の call_llm_json は禁止）
      - behavioral / agents / decision モジュールを直接 import しない（flat DI）
      - scipy / numpy / pandas を使用しない

    sizing_multiplier_cap の計算（_CAP_TABLE / P2-7AA 暫定表）:
      caution_count=0 → 1.0 / 1 → 0.8 / 2 → 0.6 / 3 → 0.4 / >=4 → _CAP_MIN(0.2)
    """

    def conduct(self, pm_input: PreMortemInput) -> PreMortemResult:
        """
        リスク観察値を集計し PreMortemResult を返す。

        sizing_multiplier_cap は「観察的上限係数」（計算値）であり、
        発注指示・推奨・売買命令ではない。
        (calculation-only, not an order, not a recommendation)

        Args:
            pm_input: PreMortemInput（各リスク指標を flat DI）

        Returns:
            PreMortemResult

        制約:
          - PreMortemInput を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - 実 HTTP / LLM 接続を行ってはならない
          - scipy / numpy / pandas を使用してはならない
          - behavioral / agents / decision を import してはならない
        """
        flags, diag = self._build_risk_observation_flags(pm_input)
        caution_count = len(flags)
        cap = self._calc_sizing_multiplier_cap(caution_count)

        return PreMortemResult(
            ticker=pm_input.ticker,
            sizing_multiplier_cap=cap,
            caution_count=caution_count,
            is_high_behavioral_risk=pm_input.is_elevated_behavioral_risk,
            is_high_committee_risk=pm_input.committee_is_high_risk,
            risk_observation_flags=tuple(flags),
            diagnostics=tuple(diag),
        )

    def _build_risk_observation_flags(
        self,
        pm_input: PreMortemInput,
    ) -> tuple[list[str], list[str]]:
        """
        観察フラグと diagnostics を構築する。

        全フラグは "observation:" prefix 統一。
        売買命令・推奨・判定は含まない。

        Returns:
            (flags, diagnostics)
        """
        flags: list[str] = []
        diag: list[str] = []

        # ── Step 1: behavioral risk 観察 ──────────────────────────────────────
        if pm_input.behavioral_score >= _BEHAVIORAL_SCORE_THRESHOLD:
            flags.append(
                f"observation: behavioral_score={pm_input.behavioral_score:.1f}"
                f" >= {_BEHAVIORAL_SCORE_THRESHOLD:.1f}"
                " — elevated behavioral risk observed"
            )
        if pm_input.behavioral_caution_count >= _BEHAVIORAL_CAUTION_COUNT_THRESHOLD:
            flags.append(
                f"observation: behavioral_caution_count={pm_input.behavioral_caution_count}"
                f" >= {_BEHAVIORAL_CAUTION_COUNT_THRESHOLD}"
                " — multiple behavioral caution patterns observed"
            )

        # ── Step 2: committee risk 観察 ───────────────────────────────────────
        if pm_input.committee_is_high_risk:
            flags.append(
                "observation: committee_is_high_risk=True"
                " — committee analysis indicates elevated risk environment"
            )
        elif pm_input.committee_risk_level == "high":
            flags.append(
                "observation: committee_risk_level=high (is_high_risk=False)"
                " — committee risk level observation"
            )

        # ── Step 3: vol 観察 ──────────────────────────────────────────────────
        if not pm_input.is_vol_defined:
            flags.append(
                "observation: is_vol_defined=False"
                " — volatility not defined; exposure_multiplier fallback used"
            )
        if pm_input.exposure_multiplier >= _EXPOSURE_MULTIPLIER_HIGH_THRESHOLD:
            flags.append(
                f"observation: exposure_multiplier={pm_input.exposure_multiplier:.3f}"
                f" >= {_EXPOSURE_MULTIPLIER_HIGH_THRESHOLD:.1f}"
                " — high volatility scaling observed"
            )

        # ── Step 4: DD10 / CVaR 観察（optional）──────────────────────────────
        if pm_input.dd10_uniform_return is not None:
            if pm_input.dd10_uniform_return < _DD10_NEGATIVE_THRESHOLD:
                flags.append(
                    f"observation: dd10_uniform_return={pm_input.dd10_uniform_return:.4f}"
                    " — negative DD10 uniform return observed"
                )
        if pm_input.cvar_value is not None:
            if pm_input.cvar_value < _CVAR_DEEP_THRESHOLD:
                flags.append(
                    f"observation: cvar={pm_input.cvar_value:.4f}"
                    f" < {_CVAR_DEEP_THRESHOLD:.2f} — tail risk observation"
                )

        diag.append(
            "observation: pre-mortem calculation-only;"
            " sizing_multiplier_cap is not a trade order or execution decision"
        )

        return flags, diag

    def _calc_sizing_multiplier_cap(self, caution_count: int) -> float:
        """
        caution_count から sizing_multiplier_cap を算出する。

        _CAP_TABLE（P2-7AA 暫定表）:
          0 → 1.0 / 1 → 0.8 / 2 → 0.6 / 3 → 0.4 / >=4 → _CAP_MIN(0.2)

        sizing_multiplier_cap は「観察的上限係数」（計算値）であり売買停止命令ではない。
        """
        return _CAP_TABLE.get(caution_count, _CAP_MIN)
