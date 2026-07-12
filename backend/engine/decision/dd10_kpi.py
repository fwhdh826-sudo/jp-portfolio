"""
dd10_kpi.py — Card 5-10B
Phase 5 Decision Engine: DD-10% 統一リターン KPI 計算層。

責務:
  - _to_valid_floats()         — リターン系列を有効な算術リターン list に変換するヘルパー
  - _safe_mean()               — 有効値リストの平均（空なら 0.0）
  - calc_max_drawdown()        — 最大ドローダウンを計算（spec §6.3 で呼ばれるが本体定義なし → ここで定義）
  - calc_dd10_uniform_return() — DD-10% 統一リターンを計算（spec §6.3 の stdlib-only 実装）
  - DD10KPIResult              — 計算結果を保持する frozen dataclass
  - DD10Calculator             — compute() で DD10KPIResult を返すクラス

算術リターン有効値フィルタリング仕様 (_to_valid_floats):
  - float() 変換不能な値は除外
  - r < -1.0 は不正算術リターン（equity がマイナス化するため）として除外
  - r == -1.0 は -100% 損失として許容
  - 有効値ゼロ件 → 空リスト

calc_max_drawdown() 仕様:
  - 有効値ゼロ件 → 0.0
  - equity 初期値 = 1.0、equity *= (1.0 + r) で更新
  - peak = running maximum of equity
  - drawdown[t] = equity[t] / peak[t] - 1.0（常に <= 0）
  - max_drawdown = min(drawdowns)
  - 戻り値は常に <= 0.0

calc_dd10_uniform_return() 仕様（spec §6.3 の直接実装）:
  - actual_dd = calc_max_drawdown(returns)
  - dd_threshold <= 0 → DEFAULT_DD_THRESHOLD = 0.10 を使用
  - actual_dd >= 0: scale_factor = 1.0, scaled_mean = mean_r
  - actual_dd < 0:  scale_factor = abs(dd_threshold / actual_dd), scaled_mean = mean_r * scale_factor
  - scaled_mean <= -1.0 → dd10_uniform_return = -1.0（年率 -100% を数学的下限とする）
  - それ以外 → dd10_uniform_return = (1 + scaled_mean) ** periods_per_year - 1
  - この数学的下限処理以外では dd10_uniform_return を clamp しない

pandas / numpy 代替設計:
  - pd.Series.mean()  → sum(valid) / len(valid)
  - returns * scale   → [r * scale for r in valid]
  - pd.Series         → list[float]

実装しないこと:
  - BUY / SELL / HOLD / WAIT 等の判定
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended / rating
  - 3ヶ月売却不可ルールの実運用判断（Operation 層の責務）
  - 銘柄推奨・推奨順位・PF最適化
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / regime / operation / market_intel / news の import
  - public/data writer

[P2-DD1] returns は算術リターン前提。log return を渡すと equity curve が異なる。
         Operation 層配線時に caller がどちらを渡すか要確認。
[P2-DD2] periods_per_year=12 は月次リターン前提（spec §6.3 の ** 12 に準拠）。
         日次データを渡す場合は caller が periods_per_year=252 を指定する。
[P2-DD3] dd_threshold=0.10 は spec のデフォルト（-10% DD 統一）。
         異なるリスク水準は caller が dd_threshold を指定する。
[P2-DD4] r < -1.0 を不正値として除外。データ品質チェックは Operation 配線時に再確認。
         r == -1.0（-100% 損失）は許容し equity がゼロになる。

Reference: docs/v13.3/07_v13.3_spec.md Section 6.3
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-10
"""
from __future__ import annotations

from dataclasses import dataclass


# ── 定数 ─────────────────────────────────────────────────────────────────────

_DEFAULT_DD_THRESHOLD    = 0.10
_DEFAULT_PERIODS_PER_YEAR = 12


# ── ヘルパー ──────────────────────────────────────────────────────────────────

def _to_valid_floats(returns) -> list[float]:
    """
    リターン系列を有効な算術リターン list に変換する。

    フィルタリングルール:
      - float() 変換不能な値は除外
      - r < -1.0 は不正算術リターン（equity がマイナス化する）として除外
      - r == -1.0 は -100% 損失として許容
    """
    valid: list[float] = []
    for v in returns:
        try:
            r = float(v)
        except (TypeError, ValueError):
            continue
        if r < -1.0:
            continue  # 不正算術リターン（equity がマイナス化する）
        valid.append(r)
    return valid


def _safe_mean(valid: list[float]) -> float:
    """有効値リストの算術平均。空なら 0.0。"""
    if not valid:
        return 0.0
    return sum(valid) / len(valid)


# ── 公開関数 ─────────────────────────────────────────────────────────────────

def calc_max_drawdown(returns) -> float:
    """
    最大ドローダウンを計算する。

    算術リターン系列から equity curve を生成し、最大 peak-to-trough 下落率を返す。
      equity[0] = 1.0
      equity[t] = equity[t-1] * (1.0 + r[t])
      peak[t]   = max(equity[0..t])
      dd[t]     = equity[t] / peak[t] - 1.0
      max_drawdown = min(dd[t]) over all t

    r < -1.0 は不正値として除外。r == -1.0 は許容（equity がゼロになる）。
    変換不能値も除外。有効値ゼロ件 → 0.0。

    Returns:
        float: 最大ドローダウン（常に <= 0.0）
    """
    valid = _to_valid_floats(returns)
    if not valid:
        return 0.0

    equity   = 1.0
    peak     = 1.0
    max_dd   = 0.0

    for r in valid:
        equity = equity * (1.0 + r)
        if equity > peak:
            peak = equity
        if peak > 0.0:
            dd = equity / peak - 1.0
        else:
            dd = 0.0  # equity と peak が両方ゼロ（r == -1.0 が複数続いた場合）
        if dd < max_dd:
            max_dd = dd

    return max_dd


def calc_dd10_uniform_return(
    returns,
    dd_threshold:    float = _DEFAULT_DD_THRESHOLD,
    periods_per_year: int  = _DEFAULT_PERIODS_PER_YEAR,
) -> float:
    """
    DD-10% 統一リターンを計算する（spec §6.3 の直接実装）。

    actual_dd >= 0（ドローダウンなし）:
        dd10_uniform_return = (1 + mean_r) ** periods_per_year - 1

    actual_dd < 0:
        scale_factor = abs(dd_threshold / actual_dd)
        scaled_mean  = mean_r * scale_factor
        scaled_mean <= -1.0 → dd10_uniform_return = -1.0（数学的下限）
        それ以外             → (1 + scaled_mean) ** periods_per_year - 1

    dd_threshold <= 0 の場合は DEFAULT_DD_THRESHOLD を使用。

    Args:
        returns:          算術リターン系列
        dd_threshold:     ドローダウン閾値（デフォルト 0.10 = -10%）
        periods_per_year: 年率換算係数（デフォルト 12 = 月次）
    Returns:
        float: 年率換算 DD-10% 統一リターン
    """
    effective_threshold = dd_threshold if dd_threshold > 0 else _DEFAULT_DD_THRESHOLD

    valid  = _to_valid_floats(returns)
    mean_r = _safe_mean(valid)

    actual_dd = calc_max_drawdown(returns)

    if actual_dd >= 0.0:
        scale_factor = 1.0
        scaled_mean  = mean_r
    else:
        scale_factor = abs(effective_threshold / actual_dd)
        scaled_mean  = mean_r * scale_factor

    if scaled_mean <= -1.0:
        return -1.0

    return (1.0 + scaled_mean) ** periods_per_year - 1.0


# ── DataClass ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class DD10KPIResult:
    """
    DD-10% 統一リターン KPI の計算結果。immutable。

    action / recommendation / is_buy / is_sell / is_hold /
    is_recommended / rating 等の判断フィールドは意図的に持たない。
    dd10_uniform_return はリスク正規化後の年率リターン KPI 値であり、売買命令ではない。
    """

    actual_max_drawdown:  float  # 最大ドローダウン（常に <= 0.0）
    dd10_uniform_return:  float  # -10% DD 正規化後の年率リターン
    scale_factor:         float  # 適用したスケール係数（ドローダウンなし → 1.0）
    mean_return:          float  # 入力リターンの平均（スケール前）
    is_drawdown_defined:  bool   # 有効 returns が 1 件以上あるか
    periods_per_year:     int    # 年率換算係数

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（float / int / bool のみ）。"""
        return {
            "actual_max_drawdown":  self.actual_max_drawdown,
            "dd10_uniform_return":  self.dd10_uniform_return,
            "scale_factor":         self.scale_factor,
            "mean_return":          self.mean_return,
            "is_drawdown_defined":  self.is_drawdown_defined,
            "periods_per_year":     self.periods_per_year,
        }


# ── DD10Calculator ────────────────────────────────────────────────────────────

class DD10Calculator:
    """
    DD-10% 統一リターン KPI を計算するクラス。

    compute() は pure computation: 入力値を受け取り DD10KPIResult を返す。
    売買判断・注文生成は行わない。
    """

    DEFAULT_DD_THRESHOLD    = _DEFAULT_DD_THRESHOLD
    DEFAULT_PERIODS_PER_YEAR = _DEFAULT_PERIODS_PER_YEAR

    def compute(
        self,
        returns:          list[float],
        dd_threshold:     float = DEFAULT_DD_THRESHOLD,
        periods_per_year: int   = DEFAULT_PERIODS_PER_YEAR,
    ) -> DD10KPIResult:
        """
        DD-10% 統一リターン KPI を計算する。

        Args:
            returns:          算術リターン系列（r < -1.0 は除外）
            dd_threshold:     ドローダウン閾値（<= 0 なら DEFAULT 使用）
            periods_per_year: 年率換算係数（デフォルト 12 = 月次）
        Returns:
            DD10KPIResult
        """
        effective_threshold = dd_threshold if dd_threshold > 0 else self.DEFAULT_DD_THRESHOLD

        valid = _to_valid_floats(returns)

        if not valid:
            return DD10KPIResult(
                actual_max_drawdown=0.0,
                dd10_uniform_return=0.0,
                scale_factor=1.0,
                mean_return=0.0,
                is_drawdown_defined=False,
                periods_per_year=periods_per_year,
            )

        mean_r    = _safe_mean(valid)
        actual_dd = calc_max_drawdown(returns)

        if actual_dd >= 0.0:
            scale_factor = 1.0
            scaled_mean  = mean_r
        else:
            scale_factor = abs(effective_threshold / actual_dd)
            scaled_mean  = mean_r * scale_factor

        if scaled_mean <= -1.0:
            dd10_return = -1.0
        else:
            dd10_return = (1.0 + scaled_mean) ** periods_per_year - 1.0

        return DD10KPIResult(
            actual_max_drawdown=actual_dd,
            dd10_uniform_return=dd10_return,
            scale_factor=scale_factor,
            mean_return=mean_r,
            is_drawdown_defined=True,
            periods_per_year=periods_per_year,
        )
