"""
jp_equity_pf_builder.py — Card 7-7
Phase 7 Multi-Strategy Engine: Japanese Equity Portfolio Builder（3ヶ月ロック制約）。

責務:
  - EquityHoldingInfo  — 保有銘柄情報を保持する frozen dataclass（入力）
  - LockObservation    — 各保有銘柄のロック状態観察値を保持する frozen dataclass
  - EquityPfInput      — 計算への入力を保持する frozen dataclass
  - EquityPfResult     — 計算結果を保持する frozen dataclass
  - JpEquityPfBuilder  — 3ヶ月ロック制約を適用して constrained_ideal_pf を計算するクラス

3ヶ月ロック制約仕様:
  LOCK_DAYS = 91（3ヶ月近似）
  is_lock_period_active = days_since_purchase < LOCK_DAYS
  lock_days_remaining   = max(0, LOCK_DAYS - days_since_purchase)
  lock_floor_weight     = current_weight（is_lock_period_active=True の場合）
                        = 0.0（is_lock_period_active=False の場合）

  - is_lock_period_active はロック期間内にあるという観察事実。売買命令ではない。
  - lock_floor_weight は制約計算において保有比率の下限として扱う計算値。
    「保有し続けよ」という命令ではない。
  - constrained_ideal_pf はロック制約適用後の理想配分比率の計算値であり、
    発注指示・推奨・売買命令ではない（calculation-only, not an order）。

constrained_ideal_pf 計算アルゴリズム:
  1. equity_ideal_pf を dict 化（ターゲット配分）
  2. current_holdings から LockObservation を作成
  3. ロック対象銘柄: is_lock_period_active=True
     → constrained_weight = max(ideal_weight, lock_floor_weight)
  4. ideal_pf 外のロック対象銘柄: lock_floor_weight で constrained_pf に含める
     → tickers_included_by_lock_floor に記録
  5. locked_total = sum(constrained_weight for locked tickers)
  6a. locked_total < 1.0（通常ケース）:
     → remaining = 1.0 - locked_total
     → アンロック銘柄の ideal_weight を remaining に比例配分
     → 全ゼロなら等加重 fallback
  6b. locked_total >= 1.0（制約 fallback）:
     → ロック銘柄のみで再正規化
     → アンロック寄与 = 0.0
     → diagnostics に記録
  7. weight 降順 + ticker 昇順で tuple 化

個別株専用設計:
  この計算層は日本個別株 PF 専用。
  投信短期売買ロジック（fund_short_term_risk.py / fund_pf_builder.py）と混在しない。
  分離は splitter.py（同 Card 7-7）が担保する。

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実 LLM / HTTP 接続禁止
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / rating / approve / reject / conditional 禁止
  - scipy / pandas / numpy 禁止（math stdlib のみ使用）
  - operation / market_intel / news / regime を直接 import しない
  - public / data writer 禁止

実装しないこと:
  - 売買命令・注文生成・発注制限
  - 差分売買（現在PFとの比較）
  - 株数・金額計算
  - Tier A ハード制約の実適用（Phase 8 の責務）
  - 投信ロジックとの混在
  - days_since_purchase の日付計算（Operation 層の責務: P2-7S）
  - public / data writer

P2 記録:
  P2-7S: days_since_purchase は整数 DI。
         purchase_date から today までの日付計算は Operation 層に委ねる。
  P2-7T: locked_total >= 1.0 では unlocked allocation がゼロになる。
         これは制約計算 fallback であり、Operation 接続前に再確認が必要。
  P1-7X: full pytest absolute import issue は継続。Card 7-7 では修正しない。

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 7-7
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


# ── 定数 ─────────────────────────────────────────────────────────────────────

LOCK_DAYS: int = 91  # 3ヶ月ロック期間（91日近似）


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


# ── 内部 helper ───────────────────────────────────────────────────────────────

def _renormalize_dict(d: dict[str, float]) -> dict[str, float]:
    """
    dict[str, float] を合計 1.0 に正規化する。

    - 空 dict → {}
    - 全ゼロ → 等加重 fallback（計算 fallback、推奨ではない）
    """
    if not d:
        return {}
    total = sum(d.values())
    if total > 0.0:
        return {t: w / total for t, w in d.items()}
    n = len(d)
    return {t: 1.0 / n for t in d}


# ── EquityHoldingInfo ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EquityHoldingInfo:
    """
    個別株保有銘柄情報。immutable。

    ticker:              銘柄コード
    current_weight:      現在の保有比率（観察値）。safe float + 0.0以上 clamp。
    days_since_purchase: 購入からの経過日数（観察値）。safe int + 0以上 clamp。
                         purchase_date から今日までの計算は Operation 層の責務（P2-7S）。

    禁止フィールド:
      action / is_buy / is_sell / buy_amount / sell_amount / order / verdict
    """

    ticker:              str
    current_weight:      float
    days_since_purchase: int

    def __post_init__(self) -> None:
        # current_weight: safe float + 0.0以上 clamp
        cw = max(0.0, _safe_float(self.current_weight, 0.0))
        object.__setattr__(self, "current_weight", cw)
        # days_since_purchase: safe int + 0以上 clamp
        dsp = max(0, _safe_int(self.days_since_purchase, 0))
        object.__setattr__(self, "days_since_purchase", dsp)


# ── LockObservation ───────────────────────────────────────────────────────────

@dataclass(frozen=True)
class LockObservation:
    """
    個別保有銘柄のロック状態観察値。immutable。

    全フィールドは「数値的に観察された事実」であり、
    「保有し続けよ」「売却するな」という命令ではない。
    実際の対応判断は Operation 層の責務。

    ticker:               銘柄コード
    current_weight:       現在の保有比率（観察値）
    days_since_purchase:  購入からの経過日数（観察値）
    is_lock_period_active: days_since_purchase < LOCK_DAYS という観察事実。
                           True = ロック期間内にある（命令ではない）
    lock_days_remaining:  max(0, LOCK_DAYS - days_since_purchase)
    lock_floor_weight:    is_lock_period_active=True → current_weight
                          is_lock_period_active=False → 0.0
                          constrained_ideal_pf 計算で使用する下限値（命令ではない）

    禁止フィールド:
      action / is_buy / is_sell / is_hold / sell_locked / can_sell / buy_allowed /
      buy_amount / sell_amount / order / verdict / decision
    """

    ticker:               str
    current_weight:       float
    days_since_purchase:  int
    is_lock_period_active: bool
    lock_days_remaining:  int
    lock_floor_weight:    float

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "current_weight",
            max(0.0, _safe_float(self.current_weight, 0.0)),
        )
        object.__setattr__(
            self, "days_since_purchase",
            max(0, _safe_int(self.days_since_purchase, 0)),
        )
        object.__setattr__(self, "is_lock_period_active", bool(self.is_lock_period_active))
        object.__setattr__(
            self, "lock_days_remaining",
            max(0, _safe_int(self.lock_days_remaining, 0)),
        )
        object.__setattr__(
            self, "lock_floor_weight",
            max(0.0, _safe_float(self.lock_floor_weight, 0.0)),
        )


# ── EquityPfInput ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EquityPfInput:
    """
    JpEquityPfBuilder.build() への入力。immutable。

    equity_ideal_pf:  SplitResult.equity_ideal_pf を想定。
                      個別株サブセットの理想配分比率（再正規化済み）。
    current_holdings: tuple[EquityHoldingInfo, ...] — 現在の保有銘柄情報。
    regime:           市況レジーム文字列（コンテキスト）。
    context:          追加情報（任意）。default_factory=dict。mutation 禁止。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / verdict / decision
    """

    equity_ideal_pf:  tuple[tuple[str, float], ...]
    current_holdings: tuple[EquityHoldingInfo, ...]
    regime:           str
    context:          dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.equity_ideal_pf, tuple):
            object.__setattr__(self, "equity_ideal_pf", tuple(self.equity_ideal_pf))
        if not isinstance(self.current_holdings, tuple):
            object.__setattr__(self, "current_holdings", tuple(self.current_holdings))
        if not isinstance(self.context, dict):
            object.__setattr__(self, "context", {})


# ── EquityPfResult ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EquityPfResult:
    """
    3ヶ月ロック制約適用後の個別株 PF 計算結果。immutable。

    「ポートフォリオ構成の数値計算結果」であり売買命令ではない。
    constrained_ideal_pf の各重みは
    「ロック制約適用後の理想配分比率の計算値」であり、
    「この銘柄を取得せよ / 保持せよ」ではない。
    実際の発注・注文生成は Operation 層の責務。
    (calculation-only, not an order, not a recommendation)

    constrained_ideal_pf:        ロック制約適用後の理想配分比率（weight降順 + ticker昇順）
    lock_observations:           各保有銘柄の観察値（LockObservation）
    tickers_included_by_lock_floor: ideal_pf 外だがロック制約計算により含まれた ticker
                                 「追加取得」ではなく制約計算上の含有
    diagnostics:                 計算上の観察事実（"observation:" prefix 統一）

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional /
      buy_amount / sell_amount / order / trade_order / rebalance_order
    """

    constrained_ideal_pf:           tuple[tuple[str, float], ...]
    lock_observations:              tuple[LockObservation, ...]
    tickers_included_by_lock_floor: tuple[str, ...]
    diagnostics:                    tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.constrained_ideal_pf, tuple):
            object.__setattr__(self, "constrained_ideal_pf", ())
        if not isinstance(self.lock_observations, tuple):
            object.__setattr__(self, "lock_observations", ())
        if not isinstance(self.tickers_included_by_lock_floor, tuple):
            object.__setattr__(
                self, "tickers_included_by_lock_floor",
                tuple(self.tickers_included_by_lock_floor),
            )
        if not isinstance(self.diagnostics, tuple):
            object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（str / float / bool / int / list / dict のみ）。"""
        return {
            "constrained_ideal_pf": dict(self.constrained_ideal_pf),
            "lock_observations": [
                {
                    "ticker":               obs.ticker,
                    "current_weight":       obs.current_weight,
                    "days_since_purchase":  obs.days_since_purchase,
                    "is_lock_period_active": obs.is_lock_period_active,
                    "lock_days_remaining":  obs.lock_days_remaining,
                    "lock_floor_weight":    obs.lock_floor_weight,
                }
                for obs in self.lock_observations
            ],
            "tickers_included_by_lock_floor": list(self.tickers_included_by_lock_floor),
            "diagnostics": list(self.diagnostics),
        }


# ── JpEquityPfBuilder ─────────────────────────────────────────────────────────

class JpEquityPfBuilder:
    """
    3ヶ月ロック制約を適用して constrained_ideal_pf を計算するクラス。

    build() は pure computation:
      - EquityPfInput を受け取り EquityPfResult を返す
      - 売買判断・注文生成・発注制限は行わない
      - 投信ロジックと混在しない
      - days_since_purchase の日付計算は行わない（Operation 層の責務: P2-7S）

    current_holdings / context を mutation してはならない。
    """

    def build(self, pf_input: EquityPfInput) -> EquityPfResult:
        """
        equity_ideal_pf に3ヶ月ロック制約を適用して constrained_ideal_pf を計算する。

        計算結果（constrained_ideal_pf）は「制約適用後の理想配分比率」であり、
        発注指示・推奨・売買命令ではない
        (calculation-only, not an order, not a recommendation)。

        Args:
            pf_input: EquityPfInput（equity_ideal_pf / current_holdings / regime を DI）

        Returns:
            EquityPfResult

        制約:
          - current_holdings / context を mutation してはならない
          - BUY / SELL / HOLD / WAIT 判定を行ってはならない
          - 実 HTTP / LLM 接続を行ってはならない
          - scipy / numpy / pandas を使用してはならない
        """
        diag: list[str] = []

        # ── Step 1: ideal_pf を dict 化 ───────────────────────────────────────
        ideal_dict: dict[str, float] = {}
        for ticker, raw_w in pf_input.equity_ideal_pf:
            ideal_dict[ticker] = max(0.0, _safe_float(raw_w, 0.0))

        # ── Step 2: LockObservation を構築（重複 ticker は最初のみ）────────────
        seen: set[str] = set()
        lock_obs_list: list[LockObservation] = []

        for holding in pf_input.current_holdings:
            t = holding.ticker
            if t in seen:
                diag.append(
                    f"observation: duplicate ticker '{t}' in current_holdings"
                    " — first occurrence used"
                )
                continue
            seen.add(t)

            cw  = max(0.0, _safe_float(holding.current_weight, 0.0))
            dsp = max(0, _safe_int(holding.days_since_purchase, 0))
            is_active  = dsp < LOCK_DAYS
            remaining  = max(0, LOCK_DAYS - dsp)
            floor_w    = cw if is_active else 0.0

            lock_obs_list.append(LockObservation(
                ticker=t,
                current_weight=cw,
                days_since_purchase=dsp,
                is_lock_period_active=is_active,
                lock_days_remaining=remaining,
                lock_floor_weight=floor_w,
            ))

        # ── Step 3: 入力データ品質観察 ────────────────────────────────────────
        total_cw = sum(obs.current_weight for obs in lock_obs_list)
        if total_cw > 1.0 + 1e-6:
            diag.append(
                f"observation: current_holdings current_weight sum {total_cw:.4f} > 1.0"
                " — input data quality observation"
            )

        # ── Step 4: ロック対象銘柄を特定 ─────────────────────────────────────
        locked_obs: dict[str, LockObservation] = {
            obs.ticker: obs for obs in lock_obs_list if obs.is_lock_period_active
        }

        # ── Step 5: ロック銘柄の constrained weight を計算 ───────────────────
        # ロック銘柄: constrained_weight = max(ideal_weight, lock_floor_weight)
        locked_constrained: dict[str, float] = {}
        tickers_included_by_lock_floor: list[str] = []

        for ticker, obs in locked_obs.items():
            ideal_w = ideal_dict.get(ticker, 0.0)
            floor_w = obs.lock_floor_weight
            locked_constrained[ticker] = max(ideal_w, floor_w)
            if ticker not in ideal_dict:
                # ideal_pf 外のロック銘柄: 制約計算により含有（追加取得ではない）
                tickers_included_by_lock_floor.append(ticker)

        locked_total = sum(locked_constrained.values())

        # ── Step 6: constrained_final を構築 ─────────────────────────────────
        if locked_total >= 1.0:
            # 制約 fallback: ロック銘柄のみで再正規化、アンロック寄与 = 0.0 (P2-7T)
            diag.append(
                "observation: locked floor weights exceed or equal 1.0;"
                " unlocked allocation is zero after constraint normalization"
                " (calculation-only, not an order)"
            )
            constrained_final = _renormalize_dict(locked_constrained)

        else:
            # 通常ケース: 残余をアンロック銘柄に比例配分
            remaining = 1.0 - locked_total

            unlocked_ideal: dict[str, float] = {
                t: w for t, w in ideal_dict.items()
                if t not in locked_obs
            }

            unlocked_total = sum(unlocked_ideal.values())
            if unlocked_total > 0.0:
                unlocked_scaled = {
                    t: w / unlocked_total * remaining
                    for t, w in unlocked_ideal.items()
                }
            elif unlocked_ideal:
                # 全ゼロ → 等加重 fallback（計算 fallback、推奨ではない）
                n_u = len(unlocked_ideal)
                unlocked_scaled = {t: remaining / n_u for t in unlocked_ideal}
            else:
                unlocked_scaled = {}

            constrained_final: dict[str, float] = dict(locked_constrained)
            constrained_final.update(unlocked_scaled)

        # ── Step 7: 出力整形 ─────────────────────────────────────────────────
        sorted_pf = sorted(constrained_final.items(), key=lambda x: (-x[1], x[0]))

        # diagnostics
        n_locked = len(locked_obs)
        if n_locked > 0:
            diag.append(
                f"observation: {n_locked} holding(s) observed as is_lock_period_active=True"
                f" (days_since_purchase < {LOCK_DAYS})"
                " — lock floor weights applied in constrained_ideal_pf"
                " (calculation-only, not an order)"
            )
        if tickers_included_by_lock_floor:
            diag.append(
                f"observation: {len(tickers_included_by_lock_floor)} ticker(s) included in"
                " constrained_ideal_pf by lock floor only"
                " (not present in equity_ideal_pf)"
                " (calculation-only, not an order)"
            )

        return EquityPfResult(
            constrained_ideal_pf=tuple(sorted_pf),
            lock_observations=tuple(lock_obs_list),
            tickers_included_by_lock_floor=tuple(sorted(tickers_included_by_lock_floor)),
            diagnostics=tuple(diag),
        )
