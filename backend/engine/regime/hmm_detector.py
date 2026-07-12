"""
HMM Surrogate Regime Detector — Card 3-2
Layer 3.2: Prototype Nearest-Neighbor Surrogate（HMM代理）。
Detection-only. No trades, no orders, no side effects.

NOT a trained HMM. is_trained=False, is_surrogate=True.
5特徴量 z-score 空間でプロトタイプ距離判定 + softmax(-alpha * dist²) confidence.

Reference: docs/v13.3/07_v13.3_spec.md Section 3.2
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

# ── Constants ─────────────────────────────────────────────────────────────────

REGIME_LABELS: tuple[str, ...] = (
    "bull_calm",
    "bull_volatile",
    "bear",
    "crisis",
    "uncertain",
)

FEATURE_NAMES: tuple[str, ...] = (
    "returns_5d",
    "vix_log",
    "volume_z",
    "spread_high_low",
    "sentiment",
)

LOW_CONFIDENCE_THRESHOLD: float = 0.50
CONFIRMED_STREAK: int = 3
SOFTMAX_ALPHA: float = 2.0

# Prototype centroids in z-score space
# Columns: returns_5d, vix_log, volume_z, spread_high_low, sentiment
HMM_PROTOTYPES: dict[str, tuple[float, ...]] = {
    "crisis":        (-2.5,  2.5,  2.5,  2.5, -2.0),
    "bear":          (-1.0,  0.8,  0.5,  0.5, -1.0),
    "uncertain":     ( 0.0,  0.0,  0.0,  0.0,  0.0),
    "bull_volatile": ( 0.5,  1.0,  0.8,  0.8,  0.0),
    "bull_calm":     ( 1.0, -1.0, -0.2, -0.5,  1.0),
}

_HISTORY_DICT_MAX: int = 10


# ── Input / Output dataclasses ────────────────────────────────────────────────

@dataclass
class HMMFeatureVector:
    returns_5d: float
    vix_log: float
    volume_z: float
    spread_high_low: float
    sentiment: float

    def to_tuple(self) -> tuple[float, ...]:
        return (
            self.returns_5d,
            self.vix_log,
            self.volume_z,
            self.spread_high_low,
            self.sentiment,
        )


@dataclass
class HMMResult:
    regime: str
    confidence: float
    is_trained: bool
    is_surrogate: bool
    is_low_confidence: bool
    primary_signal: str
    confirmed: bool
    history: list[str]
    checked_at: datetime          # datetime オブジェクト（dict API では .isoformat() に変換）

    def __post_init__(self) -> None:
        if self.regime not in REGIME_LABELS:
            raise ValueError(f"Invalid regime: {self.regime!r}")


# ── HMMRegimeDetector（ステートフル） ─────────────────────────────────────────

class HMMRegimeDetector:
    """
    ステートフル Surrogate 検出器。history を内部保持する。
    history_size: 保持する直近 regime 数（confirmed 判定に使用）。
    """

    def __init__(self, history_size: int = 3) -> None:
        if history_size < 1:
            raise ValueError(f"history_size must be >= 1, got {history_size}")
        self._history_size = history_size
        self._history: list[str] = []

    def predict(self, features: HMMFeatureVector) -> HMMResult:
        feat = features.to_tuple()
        distances = {r: _squared_dist(feat, p) for r, p in HMM_PROTOTYPES.items()}
        confs = _softmax_confidence(distances, SOFTMAX_ALPHA)

        best = max(confs, key=lambda r: confs[r])
        confidence = confs[best]
        confirmed = _is_confirmed(best, self._history, CONFIRMED_STREAK)

        self._history = (self._history + [best])[-self._history_size:]

        return HMMResult(
            regime=best,
            confidence=confidence,
            is_trained=False,
            is_surrogate=True,
            is_low_confidence=confidence < LOW_CONFIDENCE_THRESHOLD,
            primary_signal=_primary_signal_name(feat, HMM_PROTOTYPES[best]),
            confirmed=confirmed,
            history=list(self._history),
            checked_at=datetime.now(timezone.utc),
        )

    def reset_history(self) -> None:
        self._history = []


# ── Public dict API（ステートレス） ──────────────────────────────────────────

def detect_regime_hmm(features_dict: dict) -> dict:
    """
    Layer 3.2 HMM Surrogate レジーム判定（dict インターフェース・ステートレス）。
    history は features_dict["history"] から受け取り、更新版を返す。
    checked_at は isoformat 文字列として返す。
    """
    history_in: list[str] = list(features_dict.get("history", []))
    features = HMMFeatureVector(
        returns_5d=features_dict["returns_5d"],
        vix_log=features_dict["vix_log"],
        volume_z=features_dict["volume_z"],
        spread_high_low=features_dict["spread_high_low"],
        sentiment=features_dict["sentiment"],
    )
    feat = features.to_tuple()
    distances = {r: _squared_dist(feat, p) for r, p in HMM_PROTOTYPES.items()}
    confs = _softmax_confidence(distances, SOFTMAX_ALPHA)
    best = max(confs, key=lambda r: confs[r])
    confidence = confs[best]

    return {
        "regime": best,
        "confidence": confidence,
        "is_trained": False,
        "is_surrogate": True,
        "is_low_confidence": confidence < LOW_CONFIDENCE_THRESHOLD,
        "primary_signal": _primary_signal_name(feat, HMM_PROTOTYPES[best]),
        "confirmed": _is_confirmed(best, history_in, CONFIRMED_STREAK),
        "history": (history_in + [best])[-_HISTORY_DICT_MAX:],
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Internals ─────────────────────────────────────────────────────────────────

def _squared_dist(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b))


def _softmax_confidence(
    distances: dict[str, float],
    alpha: float,
) -> dict[str, float]:
    exps = {r: math.exp(-alpha * d) for r, d in distances.items()}
    total = sum(exps.values())
    return {r: e / total for r, e in exps.items()}


def _primary_signal_name(
    feat: tuple[float, ...],
    winner_proto: tuple[float, ...],
) -> str:
    """勝利 prototype への次元ごとの距離寄与 (f_i - p_i)² が最大の特徴量名。"""
    contribs = [(f - p) ** 2 for f, p in zip(feat, winner_proto)]
    return FEATURE_NAMES[contribs.index(max(contribs))]


def _is_confirmed(regime: str, history: list[str], streak: int) -> bool:
    recent = (history + [regime])[-streak:]
    return len(recent) >= streak and all(r == regime for r in recent)
