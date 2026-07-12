"""
volatility_targeting.py — Card 5-10A
Phase 5 Decision Engine: ボラティリティターゲット ポジションサイズ計算層。

責務:
  - calc_realized_vol()    — リターン系列から年率換算実現ボラティリティを計算
  - VolatilityTargetResult — 計算結果を保持する frozen dataclass
  - VolatilityCalculator   — compute() でボラティリティターゲットサイズを計算するクラス

calc_realized_vol() 仕様:
  - 引数: returns: list[float], annualize_factor: int = 252
  - 各要素を float() 変換。変換不能な値は除外する（スキップ）。
    有効値が 2 件未満なら (0.0, False) を返す。
  - len(valid_returns) < 2 → (0.0, False)
  - len(valid_returns) >= 2 → (statistics.stdev(valid_returns) * sqrt(annualize_factor), True)
  - all-zero returns は stdev=0.0 なので (0.0, True)
  - 返り値: tuple[float, bool] = (realized_vol, is_vol_defined)

compute() 仕様:
  - effective_target_vol = target_vol if target_vol > 0 else DEFAULT_TARGET_VOL
  - effective_base_size  = max(0.0, base_size)
  - effective_min_scale  = max(0.0, min_scale)
  - effective_max_scale  = max(max_scale, effective_min_scale)
  - realized_vol <= 0.0 または is_vol_defined=False → exposure_multiplier=1.0 fallback
  - realized_vol > 0.0 → raw_scale = effective_target_vol / realized_vol
                          exposure_multiplier = clamp(raw_scale, effective_min_scale, effective_max_scale)
  - scaled_position = effective_base_size * exposure_multiplier（常に >= 0）

VolatilityTargetResult.target_vol には入力値ではなく effective_target_vol を格納する。
  例: target_vol=-1.0 → result.target_vol == 0.15（DEFAULT_TARGET_VOL）

scaled_position は売買命令ではなく計算結果:
  「このポジションサイズが volatility target と整合している」という数値情報。
  実際の執行判断は Operation 層が行う。

pandas / numpy 代替設計:
  statistics.stdev()  ← pd.Series.std() の代替（標本標準偏差 n-1）
  math.sqrt(252)      ← np.sqrt(252) の代替
  list comprehension  ← pd.Series * scalar の代替
  sum() / len()       ← pd.Series.mean() の代替

実装しないこと:
  - BUY / SELL / HOLD / WAIT 等の判定
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended / rating
  - 注文生成・執行ロジック
  - 3ヶ月売却不可ルールの実運用判断（Operation 層の責務）
  - dd10_kpi.py（別 Card）
  - PF最適化
  - 銘柄推奨・推奨順位
  - 実 LLM / HTTP / 外部 API
  - pandas / numpy
  - backend.engine.scoring / regime / operation / market_intel / news の import
  - public/data writer

[P2-VT1] returns の種別（日次 log return / 算術 return）は caller が統一する前提。
         モジュール内ではどちらかを強制しない。Operation 層配線時に要確認。
[P2-VT2] annualize_factor=252 は日次 returns 前提。
         週次 returns の場合は caller が 52 を、月次は 12 を渡すこと。
[P2-VT3] stdev は標本標準偏差（n-1 分母）= statistics.stdev()。
         母標準偏差（n 分母）が必要な場合は将来の計算仕様変更として検討。

Reference: docs/v13.3/07_v13.3_spec.md Section 9.2
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 5-10
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass


# ── 公開関数 ─────────────────────────────────────────────────────────────────

def calc_realized_vol(
    returns: list[float],
    annualize_factor: int = 252,
) -> tuple[float, bool]:
    """
    リターン系列から年率換算実現ボラティリティを計算する。

    変換不能な値（None / str 等）は除外してから計算する。
    有効値が 2 件未満の場合は (0.0, False) を返す。
    all-zero returns は stdev=0.0 → (0.0, True)。

    Args:
        returns:          日次リターン系列（float 変換可能な値を含む）
        annualize_factor: 年率換算係数（デフォルト 252 = 日次）
    Returns:
        tuple[float, bool]: (realized_vol, is_vol_defined)
          is_vol_defined=False → 計算不能（有効値 < 2 件）
    """
    valid: list[float] = []
    for v in returns:
        try:
            valid.append(float(v))
        except (TypeError, ValueError):
            continue  # 変換不能値は除外

    if len(valid) < 2:
        return 0.0, False

    daily_std = statistics.stdev(valid)  # 標本標準偏差（n-1）
    realized = daily_std * math.sqrt(annualize_factor)
    return realized, True


# ── DataClass ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class VolatilityTargetResult:
    """
    ボラティリティターゲット計算結果。immutable。

    action / recommendation / is_buy / is_sell / is_hold /
    is_recommended / rating 等の判断フィールドは意図的に持たない。
    scaled_position は計算結果であり、売買命令ではない。
    """

    realized_vol:        float  # 年率換算実現ボラティリティ（>= 0）
    target_vol:          float  # 実際に使用した effective_target_vol
    exposure_multiplier: float  # clamp済みスケール係数
    scaled_position:     float  # effective_base_size * exposure_multiplier（>= 0）
    is_vol_defined:      bool   # 実現ボラティリティが計算可能だったか
    annualize_factor:    int    # 年率換算係数

    def to_dict(self) -> dict:
        """JSON serializable な dict を返す（float / int / bool / str のみ）。"""
        return {
            "realized_vol":        self.realized_vol,
            "target_vol":          self.target_vol,
            "exposure_multiplier": self.exposure_multiplier,
            "scaled_position":     self.scaled_position,
            "is_vol_defined":      self.is_vol_defined,
            "annualize_factor":    self.annualize_factor,
        }


# ── VolatilityCalculator ──────────────────────────────────────────────────────

class VolatilityCalculator:
    """
    ボラティリティターゲットに基づくポジションサイズスケールを計算する。

    compute() は pure computation: 入力値を受け取り VolatilityTargetResult を返す。
    売買判断・注文生成は行わない。
    """

    DEFAULT_TARGET_VOL: float = 0.15
    DEFAULT_MAX_SCALE:  float = 2.0
    DEFAULT_MIN_SCALE:  float = 0.5
    DEFAULT_ANNUALIZE:  int   = 252

    def compute(
        self,
        returns:          list[float],
        base_size:        float,
        target_vol:       float = DEFAULT_TARGET_VOL,
        max_scale:        float = DEFAULT_MAX_SCALE,
        min_scale:        float = DEFAULT_MIN_SCALE,
        annualize_factor: int   = DEFAULT_ANNUALIZE,
    ) -> VolatilityTargetResult:
        """
        リターン系列とベースサイズからボラティリティターゲットサイズを計算する。

        target_vol <= 0 の場合は DEFAULT_TARGET_VOL を使用し、
        result.target_vol には実際に使用した値（effective_target_vol）を格納する。

        Args:
            returns:          日次リターン系列
            base_size:        基準ポジションサイズ（負の場合は 0.0 に clamp）
            target_vol:       目標年率ボラティリティ（<= 0 なら DEFAULT 使用）
            max_scale:        最大スケール上限
            min_scale:        最小スケール下限
            annualize_factor: 年率換算係数（デフォルト 252）
        Returns:
            VolatilityTargetResult
        """
        # ── 有効値クランプ ──────────────────────────────────────────────────
        effective_target_vol = target_vol if target_vol > 0 else self.DEFAULT_TARGET_VOL
        effective_base_size  = max(0.0, float(base_size))
        effective_min_scale  = max(0.0, float(min_scale))
        effective_max_scale  = max(float(max_scale), effective_min_scale)

        # ── 実現ボラティリティ計算 ──────────────────────────────────────────
        realized_vol, is_vol_defined = calc_realized_vol(returns, annualize_factor)

        # ── exposure_multiplier 計算 ────────────────────────────────────────
        if not is_vol_defined or realized_vol <= 0.0:
            exposure_multiplier = 1.0
        else:
            raw_scale = effective_target_vol / realized_vol
            exposure_multiplier = max(
                effective_min_scale,
                min(effective_max_scale, raw_scale),
            )

        scaled_position = effective_base_size * exposure_multiplier

        return VolatilityTargetResult(
            realized_vol=realized_vol,
            target_vol=effective_target_vol,
            exposure_multiplier=exposure_multiplier,
            scaled_position=scaled_position,
            is_vol_defined=is_vol_defined,
            annualize_factor=annualize_factor,
        )
