"""
base_strategy.py — Card 7-1
Phase 7 Multi-Strategy Engine: 戦略基底型定義層。

責務:
  - VALID_STRATEGY_IDS    — 有効な戦略ID定数
  - validate_strategy_id  — 戦略ID妥当性確認 helper
  - StrategyInput         — 計算への入力を保持する frozen dataclass
  - StrategyOutput        — 計算結果を保持する frozen dataclass
  - BaseStrategy          — 全 4 戦略が実装する ABC

StrategyInput 仕様:
  - universe: tuple[str, ...] — __post_init__ で list→tuple、空文字 ticker は除外
  - scores:   dict[str, dict] — 外部 DI。mutation 禁止（deep-freeze は Card 7-6 で再確認）
  - regime:   str             — "bull_calm"/"bull_volatile"/"bear"/"crisis"/"uncertain"
  - horizon:  str             — "short_term"/"long_term"（default: "long_term"）
  - context:  dict            — 追加情報 (default_factory=dict)。mutation 禁止。

StrategyOutput 仕様:
  - ideal_pf: tuple[tuple[str, float], ...]
      __post_init__ で dict / list / tuple 入力を正規化する。
      weight は safe float + 0.0 以上に clamp。NaN/inf/None/str → 0.0。
      合計 1.0 正規化は行わない（BaseStrategy._normalize_weights の責務）。
  - expected_return:  safe float
  - expected_vol:     safe float + 0.0 以上 clamp
  - sharpe_ratio:     safe float
  - max_dd_estimate:  safe float + 0.0 以下 clamp（正値 → 0.0）
  - diagnostics: tuple[str, ...] — 計算上の観察事実（caution_flags と同設計哲学）

観察値フラグについて:
  StrategyOutput はポートフォリオ構成の数値化計算結果であり、売買命令ではない。
  ideal_pf の各重みは「このロジックの計算結果としての理想配分比率」であり、
  「この銘柄を買え/売れ」ではない。実際の発注・注文生成は Operation 層の責務。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実LLM/HTTP接続禁止
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/
    verdict/decision/rating/approve/reject/conditional 禁止
  - scipy / pandas / numpy 禁止（math stdlib のみ使用）
  - operation/market_intel/news/regime を直接 import しない

実装しないこと:
  - frontier_strategy / quality_size_strategy / fundamental_weighted_strategy / cross_factor_strategy
  - aggregator
  - scipy / numpy を使う最適化
  - BUY/SELL/HOLD/WAIT 判定
  - 3ヶ月売却不可ルールの実運用判断
  - public/data writer

P2 記録:
  P2-7A: StrategyInput.scores は dict のまま保持。
         Card 7-6 Aggregator 配線時に immutable 化または read-only wrapper を再確認。
  P2-7B: StrategyOutput.ideal_pf は tuple 化済みだが、
         Aggregator では _ideal_pf_as_dict() を使用すること。
  P2-7C: STRATEGY_ID の厳格な不正ID排除は Card 7-6 Aggregator で実装予定。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-1
"""
from __future__ import annotations

import math
from abc import ABC, abstractmethod
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


def _clamp(val: float, lo: float, hi: float) -> float:
    """val を [lo, hi] に clamp する。"""
    return max(lo, min(hi, val))


# ── 定数 ─────────────────────────────────────────────────────────────────────

VALID_STRATEGY_IDS: frozenset[str] = frozenset({
    "frontier",
    "quality_size",
    "fundamental",
    "cross_factor",
})


# ── validate helper ───────────────────────────────────────────────────────────

def validate_strategy_id(strategy_id: str) -> bool:
    """
    strategy_id が VALID_STRATEGY_IDS に含まれるかを確認する。

    STRATEGY_ID は REGIME_STRATEGY_WEIGHTS（dynamic_weight/regime_strategy_weights.py）
    のキーと完全一致させる必要がある。
    不正 ID の厳格な排除は Card 7-6 Aggregator で実装予定（P2-7C）。

    Returns:
        True  — 有効な strategy_id
        False — 無効な strategy_id（None / 空文字 / 未知ID）
    """
    if not isinstance(strategy_id, str) or not strategy_id:
        return False
    return strategy_id in VALID_STRATEGY_IDS


# ── ideal_pf 正規化 helper（モジュールレベル）────────────────────────────────

def _normalize_ideal_pf(
    raw: Any,
) -> tuple[tuple[str, float], ...]:
    """
    dict / list / tuple を tuple[tuple[str, float], ...] に正規化する。

    入力形式:
      - dict[str, float]: {ticker: weight}
      - list / tuple: [(ticker, weight), ...] または ((ticker, weight), ...)
      - その他: ()

    weight 処理:
      - safe float 変換（NaN/inf/None/str → 0.0）
      - 0.0 以上に clamp（負値 → 0.0）
      - 合計 1.0 正規化は行わない（_normalize_weights の責務）

    並び順:
      - dict 入力: 挿入順維持
      - list/tuple 入力: 入力順維持
    """
    pairs: list[tuple[str, float]] = []

    if isinstance(raw, dict):
        for k, v in raw.items():
            ticker = str(k)
            weight = max(0.0, _safe_float(v, 0.0))
            pairs.append((ticker, weight))
    elif isinstance(raw, (list, tuple)):
        for item in raw:
            try:
                k, v = item[0], item[1]
            except (TypeError, IndexError, KeyError):
                continue
            ticker = str(k)
            weight = max(0.0, _safe_float(v, 0.0))
            pairs.append((ticker, weight))

    return tuple(pairs)


# ── StrategyInput ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class StrategyInput:
    """
    BaseStrategy.compute() への入力。immutable（フィールド自体は書き換え不可）。

    universe:  銘柄 ticker の一覧。__post_init__ で tuple 化。空文字 ticker は除外。
    scores:    {ticker: {axis_name: score}} の dict。外部から DI で渡す。
               frozen=True でも内部 dict は mutable なため、
               BaseStrategy / 各 strategy は scores / context を mutation してはならない。
               deep-freeze は Card 7-6 Aggregator 配線時に再確認（P2-7A）。
    regime:    市況レジーム文字列。
               "bull_calm"/"bull_volatile"/"bear"/"crisis"/"uncertain"
    horizon:   投資時間軸。"short_term"/"long_term"（default: "long_term"）
    context:   追加情報（任意）。default_factory=dict で各インスタンスが独立 dict を持つ。
               scores 同様に mutation 禁止。

    禁止フィールド:
      action/recommendation/is_buy/is_sell/is_hold/is_recommended/
      verdict/decision/rating/approve/reject/conditional
    """

    universe: tuple[str, ...]
    scores:   dict[str, dict]
    regime:   str
    horizon:  str  = "long_term"
    context:  dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        # universe を tuple 化し、空文字 ticker を除外する
        if not isinstance(self.universe, tuple):
            raw_iter = self.universe
        else:
            raw_iter = self.universe

        cleaned: tuple[str, ...] = tuple(
            str(t) for t in raw_iter if str(t) != ""
        )
        object.__setattr__(self, "universe", cleaned)


# ── StrategyOutput ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class StrategyOutput:
    """
    戦略計算結果。immutable。

    「ポートフォリオ構成の数値計算結果」であり売買命令ではない。
    ideal_pf の各重みは「このロジックの計算結果としての理想配分比率」であり、
    「この銘柄を買え/売れ」ではない。実際の発注・注文生成は Operation 層の責務。

    strategy_id:     戦略識別子（VALID_STRATEGY_IDS のいずれか）
    strategy_name:   人間可読名
    ideal_pf:        tuple[tuple[str, float], ...]
                     __post_init__ で dict / list / tuple 入力を正規化する。
                     weight は safe float + 0.0 以上 clamp。
                     合計 1.0 正規化は行わない（BaseStrategy._normalize_weights の責務）。
    expected_return: 期待リターン（年率）。safe float。
    expected_vol:    期待ボラティリティ（年率）。safe float + 0.0 以上 clamp。
    sharpe_ratio:    シャープレシオ。safe float。
    max_dd_estimate: 最大ドローダウン推定。0.0 以下に clamp（正値 → 0.0）。
    rationale:       計算根拠の記述。
    diagnostics:     計算上の観察事実（文字列 tuple）。caution_flags と同設計哲学。

    禁止フィールド:
      action/recommendation/is_buy/is_sell/is_hold/is_recommended/
      verdict/decision/rating/approve/reject/conditional/
      final_verdict/order/amount/entry_price/stop_loss/take_profit
    """

    strategy_id:      str
    strategy_name:    str
    ideal_pf:         tuple[tuple[str, float], ...]
    expected_return:  float
    expected_vol:     float
    sharpe_ratio:     float
    max_dd_estimate:  float
    rationale:        str
    diagnostics:      tuple[str, ...] = ()

    def __post_init__(self) -> None:
        # ideal_pf を正規化
        raw_pf = self.ideal_pf
        if not isinstance(raw_pf, tuple) or (
            raw_pf and not isinstance(raw_pf[0], tuple)
        ):
            normalized = _normalize_ideal_pf(raw_pf)
        else:
            # すでに tuple[tuple[...]] の形でも weight の safe/clamp を適用する
            normalized = _normalize_ideal_pf(raw_pf)
        object.__setattr__(self, "ideal_pf", normalized)

        # expected_return: safe float
        object.__setattr__(self, "expected_return", _safe_float(self.expected_return))

        # expected_vol: safe float + 0.0 以上 clamp
        object.__setattr__(self, "expected_vol",
                           max(0.0, _safe_float(self.expected_vol)))

        # sharpe_ratio: safe float
        object.__setattr__(self, "sharpe_ratio", _safe_float(self.sharpe_ratio))

        # max_dd_estimate: safe float + 0.0 以下 clamp（正値 → 0.0）
        object.__setattr__(self, "max_dd_estimate",
                           min(0.0, _safe_float(self.max_dd_estimate)))

        # diagnostics: tuple 化
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / bool / list のみ）。"""
        return {
            "strategy_id":      self.strategy_id,
            "strategy_name":    self.strategy_name,
            "ideal_pf":         dict(self.ideal_pf),
            "expected_return":  self.expected_return,
            "expected_vol":     self.expected_vol,
            "sharpe_ratio":     self.sharpe_ratio,
            "max_dd_estimate":  self.max_dd_estimate,
            "rationale":        self.rationale,
            "diagnostics":      list(self.diagnostics),
        }

    def _ideal_pf_as_dict(self) -> dict[str, float]:
        """ideal_pf を dict[str, float] に変換して返す。Card 7-6 Aggregator で使用。"""
        return dict(self.ideal_pf)


# ── BaseStrategy ──────────────────────────────────────────────────────────────

class BaseStrategy(ABC):
    """
    Multi-Strategy Engine の抽象基底クラス。

    各 concrete strategy は STRATEGY_ID / STRATEGY_NAME を上書きし、
    compute() を実装する。

    compute() は pure computation: StrategyInput を受け取り StrategyOutput を返す。
    売買判断・注文生成・発注制限は行わない。

    各サブクラスは scores / context を mutation してはならない（P2-7A 参照）。
    """

    STRATEGY_ID:   str = ""  # 各 subclass で上書き。VALID_STRATEGY_IDS のいずれか。
    STRATEGY_NAME: str = ""  # 各 subclass で上書き。人間可読名。

    @abstractmethod
    def compute(self, strategy_input: StrategyInput) -> StrategyOutput:
        """
        StrategyInput を受け取り StrategyOutput を返す pure computation。

        Args:
            strategy_input: StrategyInput（universe / scores / regime / horizon を DI）
        Returns:
            StrategyOutput

        制約:
          - strategy_input.scores / context を mutation してはならない
          - BUY/SELL/HOLD/WAIT 判定を行ってはならない
          - 実HTTP/LLM接続を行ってはならない
          - scipy/numpy/pandas を使用してはならない
        """
        ...

    # ── helpers（サブクラスで継承可能）───────────────────────────────────────

    def _safe_float(self, raw: Any, fallback: float = 0.0) -> float:
        """None / str / NaN / inf → fallback。"""
        return _safe_float(raw, fallback)

    def _safe_int(self, raw: Any, fallback: int = 0) -> int:
        """None / str / NaN / inf → fallback。"""
        return _safe_int(raw, fallback)

    def _clamp(self, val: float, lo: float, hi: float) -> float:
        """val を [lo, hi] に clamp する。"""
        return _clamp(val, lo, hi)

    def _normalize_weights(
        self, weights: dict[str, float]
    ) -> dict[str, float]:
        """
        weight dict を合計 1.0 に正規化して返す。

        処理:
          - 各 weight を safe float 変換
          - NaN / inf / None / str → 0.0
          - 負値 → 0.0
          - 正値合計 > 0 → 合計 1.0 に正規化
          - 正値合計 == 0 かつ tickers が存在 → 等加重（1 / len）
          - 入力空 → {}

        Returns:
            dict[str, float]（合計 ~1.0 または {}）
        """
        if not weights:
            return {}

        cleaned: dict[str, float] = {
            ticker: max(0.0, _safe_float(w, 0.0))
            for ticker, w in weights.items()
        }

        total = sum(cleaned.values())

        if total > 0.0:
            return {t: w / total for t, w in cleaned.items()}

        # 全ゼロ → 等加重
        n = len(cleaned)
        if n > 0:
            eq = 1.0 / n
            return {t: eq for t in cleaned}

        return {}

    def _to_ideal_pf_tuple(
        self, weights: dict[str, float]
    ) -> tuple[tuple[str, float], ...]:
        """
        dict[str, float] を tuple[tuple[str, float], ...] に変換する。

        weight: safe float + 0.0 以上 clamp。合計 1.0 正規化は行わない。
        順序: dict insertion order 維持（deterministic）。

        Returns:
            tuple[tuple[str, float], ...]
        """
        return tuple(
            (ticker, max(0.0, _safe_float(w, 0.0)))
            for ticker, w in weights.items()
        )

    @staticmethod
    def _is_valid_strategy_id(strategy_id: str) -> bool:
        """
        strategy_id が VALID_STRATEGY_IDS に含まれるかを確認する。

        不正 ID の厳格な排除は Card 7-6 Aggregator で実装予定（P2-7C）。

        Returns:
            True  — 有効
            False — 無効
        """
        return validate_strategy_id(strategy_id)
