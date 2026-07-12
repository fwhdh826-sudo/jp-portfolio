"""
trading_frequency_cap.py — Card 6-7
Phase 6 Behavioral: 取引頻度指標計算層。

責務:
  - TradingFrequencyInput  — 計算への入力を保持する frozen dataclass
  - TradingFrequencyResult — 計算結果を保持する frozen dataclass
  - TradingFrequencyCalculator — calculate() で TradingFrequencyResult を返すクラス

取引頻度計算仕様:
  1. reference_date を date.fromisoformat() で変換（不正 → safe fallback）
  2. window_days <= 0 → DEFAULT_WINDOW_DAYS = 30 を使用
  3. window_start = reference_date - timedelta(days=window_days)
  4. trade_dates の各要素を date.fromisoformat() で変換（不正 → 除外）
  5. window_start <= trade_date <= reference_date をカウント
  6. days_since_last_trade: 最新取引日からの日数（取引なし → -1）
  7. max_trades_per_window <= 0 → frequency_ratio = 0.0
  8. frequency_ratio = trade_count_in_window / max_trades_per_window
  9. is_overtrading = frequency_ratio > 1.0
  10. is_cooling_required = frequency_ratio >= 1.5

観察値フラグについて:
  is_overtrading:      frequency_ratio > 1.0 の観察値フラグ。
  is_cooling_required: frequency_ratio >= 1.5 の観察値フラグ。
    どちらも「この頻度パターンが数値的に観察された」という計算上の事実。
    is_buy / is_sell / is_hold / is_recommended のような売買命令ではない。
    実際の発注制限・注文ブロックは Operation 層の責務。

invalid reference_date fallback:
  reference_date が不正な ISO 文字列の場合:
    trade_count_in_window=0, frequency_ratio=0.0, days_since_last_trade=-1,
    is_overtrading=False, is_cooling_required=False,
    caution_flags に "reference_date invalid" 観察文言を追加

設計原則:
  - 実際の売買制限・注文制限はしない（数値化のみ）
  - 実LLM/HTTP接続禁止
  - BUY/SELL/HOLD/WAIT 禁止
  - action/recommendation/is_buy/is_sell/is_hold/is_recommended/
    verdict/decision/rating/approve/reject/conditional 禁止
  - pandas/numpy 禁止（datetime stdlib のみ使用）
  - operation/market_intel/news/regime を直接 import しない

実装しないこと:
  - 実LLM/HTTP接続
  - 3ヶ月売却不可ルールの実運用判断
  - 発注制限・注文ブロック
  - BUY/SELL/HOLD/WAIT 判定
  - public/data writer

Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 6-7
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta


# ── 定数 ─────────────────────────────────────────────────────────────────────

DEFAULT_WINDOW_DAYS:       int   = 30
DEFAULT_MAX_TRADES:        int   = 8
OVERTRADING_THRESHOLD:     float = 1.0   # frequency_ratio > 1.0
COOLING_THRESHOLD:         float = 1.5   # frequency_ratio >= 1.5


# ── TradingFrequencyInput ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class TradingFrequencyInput:
    """
    TradingFrequencyCalculator への入力。immutable。

    trade_dates:          取引日リスト（ISO 8601: "YYYY-MM-DD"）。tuple で保持。
                          list が渡されても __post_init__ で tuple 化する。
    reference_date:       集計基準日（ISO 8601: "YYYY-MM-DD"）
    window_days:          集計ウィンドウ日数。0以下は DEFAULT_WINDOW_DAYS=30 fallback。
    max_trades_per_window: 参照上限（frequency_ratio の分母）。0以下は ratio=0.0 fallback。

    action/recommendation 等の判断フィールドは持たない。
    """

    trade_dates:           tuple[str, ...]
    reference_date:        str
    window_days:           int = DEFAULT_WINDOW_DAYS
    max_trades_per_window: int = DEFAULT_MAX_TRADES

    def __post_init__(self) -> None:
        # list や他の iterable が渡された場合に tuple 化する
        if not isinstance(self.trade_dates, tuple):
            object.__setattr__(self, "trade_dates", tuple(self.trade_dates))


# ── TradingFrequencyResult ────────────────────────────────────────────────────

@dataclass(frozen=True)
class TradingFrequencyResult:
    """
    取引頻度指標計算結果。immutable。

    「取引頻度パターンの数値化」であり売買命令ではない。

    trade_count_in_window: ウィンドウ内の取引件数
    frequency_ratio:       trade_count / max_trades_per_window（0.0 以上）
    days_since_last_trade: 最終取引からの経過日数（取引なし → -1）
    caution_flags:         観察された懸念パターン（文字列 tuple）

    is_overtrading: 観察値フラグ。frequency_ratio > 1.0 のとき True。
      「参照上限を超えた取引頻度が観察された」という計算上の事実。
      発注をブロックしない。Operation 層が対応を決める。

    is_cooling_required: 観察値フラグ。frequency_ratio >= 1.5 のとき True。
      「参照上限の 1.5 倍超の頻度が観察された」という計算上の事実。
      クーリングを強制しない。Operation 層が対応を決める。

    禁止フィールド:
      action / recommendation / is_buy / is_sell / is_hold / is_recommended /
      verdict / decision / rating / approve / reject / conditional
    """

    trade_count_in_window: int
    frequency_ratio:       float
    days_since_last_trade: int
    is_overtrading:        bool            # 観察値フラグ: frequency_ratio > 1.0
    is_cooling_required:   bool            # 観察値フラグ: frequency_ratio >= 1.5
    caution_flags:         tuple[str, ...] # 観察された懸念パターン

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（int / float / bool / list のみ）。"""
        return {
            "trade_count_in_window": self.trade_count_in_window,
            "frequency_ratio":       self.frequency_ratio,
            "days_since_last_trade": self.days_since_last_trade,
            "is_overtrading":        self.is_overtrading,
            "is_cooling_required":   self.is_cooling_required,
            "caution_flags":         list(self.caution_flags),
        }


# ── TradingFrequencyCalculator ────────────────────────────────────────────────

class TradingFrequencyCalculator:
    """
    取引頻度指標を計算する。

    calculate() は pure computation: 入力値を受け取り TradingFrequencyResult を返す。
    売買判断・注文生成・発注制限は行わない。
    """

    DEFAULT_WINDOW_DAYS: int   = DEFAULT_WINDOW_DAYS
    OVERTRADING_THRESHOLD: float = OVERTRADING_THRESHOLD
    COOLING_THRESHOLD:     float = COOLING_THRESHOLD

    def calculate(self, freq_input: TradingFrequencyInput) -> TradingFrequencyResult:
        """
        取引頻度指標を計算して TradingFrequencyResult を返す。

        reference_date が不正な ISO 文字列の場合は safe fallback:
          trade_count_in_window=0, frequency_ratio=0.0, days_since_last_trade=-1,
          is_overtrading=False, is_cooling_required=False,
          caution_flags=("caution: reference_date invalid ...",)

        Args:
            freq_input: TradingFrequencyInput（全 DI）
        Returns:
            TradingFrequencyResult
        """
        # ── reference_date 変換 ───────────────────────────────────────────────
        try:
            ref_date = date.fromisoformat(freq_input.reference_date)
        except (ValueError, TypeError, AttributeError):
            return TradingFrequencyResult(
                trade_count_in_window=0,
                frequency_ratio=0.0,
                days_since_last_trade=-1,
                is_overtrading=False,
                is_cooling_required=False,
                caution_flags=(
                    f"caution: reference_date invalid "
                    f"(value={freq_input.reference_date!r}) — frequency calculation skipped",
                ),
            )

        # ── window_days fallback ──────────────────────────────────────────────
        window_days = (
            freq_input.window_days
            if freq_input.window_days > 0
            else self.DEFAULT_WINDOW_DAYS
        )
        window_start = ref_date - timedelta(days=window_days)

        # ── trade_dates フィルタリング ─────────────────────────────────────────
        valid_dates: list[date] = []
        for d_str in freq_input.trade_dates:
            try:
                d = date.fromisoformat(d_str)
            except (ValueError, TypeError, AttributeError):
                continue  # 不正日付は除外
            valid_dates.append(d)

        # ウィンドウ内の取引日
        in_window: list[date] = [
            d for d in valid_dates
            if window_start <= d <= ref_date
        ]
        trade_count_in_window = len(in_window)

        # ── days_since_last_trade ─────────────────────────────────────────────
        if not in_window:
            days_since_last_trade = -1
        else:
            last_trade = max(in_window)
            days_since_last_trade = (ref_date - last_trade).days

        # ── frequency_ratio ───────────────────────────────────────────────────
        max_trades = freq_input.max_trades_per_window
        if max_trades <= 0:
            frequency_ratio = 0.0
        else:
            frequency_ratio = trade_count_in_window / max_trades

        # ── 観察値フラグ ──────────────────────────────────────────────────────
        is_overtrading      = frequency_ratio > self.OVERTRADING_THRESHOLD
        is_cooling_required = frequency_ratio >= self.COOLING_THRESHOLD

        # ── caution_flags ─────────────────────────────────────────────────────
        flags: list[str] = []

        if is_cooling_required:
            flags.append(
                f"caution: cooling_required (frequency_ratio={frequency_ratio:.2f}) — "
                f"trade count ({trade_count_in_window}) exceeds {self.COOLING_THRESHOLD}x reference limit"
            )
        elif is_overtrading:
            flags.append(
                f"caution: overtrading (frequency_ratio={frequency_ratio:.2f}) — "
                f"trade count ({trade_count_in_window}) exceeds reference limit "
                f"({freq_input.max_trades_per_window})"
            )

        return TradingFrequencyResult(
            trade_count_in_window=trade_count_in_window,
            frequency_ratio=frequency_ratio,
            days_since_last_trade=days_since_last_trade,
            is_overtrading=is_overtrading,
            is_cooling_required=is_cooling_required,
            caution_flags=tuple(flags),
        )
