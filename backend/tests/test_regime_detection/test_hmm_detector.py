"""
Card 3-2 — HMM Surrogate Regime Detector テスト
Detection-only であることを担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime

import pytest

from backend.engine.regime.hmm_detector import (
    CONFIRMED_STREAK,
    FEATURE_NAMES,
    HMM_PROTOTYPES,
    LOW_CONFIDENCE_THRESHOLD,
    REGIME_LABELS,
    SOFTMAX_ALPHA,
    HMMFeatureVector,
    HMMRegimeDetector,
    HMMResult,
    detect_regime_hmm,
)


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def make_feat(
    returns_5d: float = 0.0,
    vix_log: float = 0.0,
    volume_z: float = 0.0,
    spread_high_low: float = 0.0,
    sentiment: float = 0.0,
) -> HMMFeatureVector:
    return HMMFeatureVector(
        returns_5d=returns_5d,
        vix_log=vix_log,
        volume_z=volume_z,
        spread_high_low=spread_high_low,
        sentiment=sentiment,
    )


def make_dict(
    returns_5d: float = 0.0,
    vix_log: float = 0.0,
    volume_z: float = 0.0,
    spread_high_low: float = 0.0,
    sentiment: float = 0.0,
    history: list[str] | None = None,
) -> dict:
    return {
        "returns_5d": returns_5d,
        "vix_log": vix_log,
        "volume_z": volume_z,
        "spread_high_low": spread_high_low,
        "sentiment": sentiment,
        "history": history or [],
    }


def proto_feat(regime: str) -> HMMFeatureVector:
    """プロトタイプ中心点を HMMFeatureVector で返す。"""
    p = HMM_PROTOTYPES[regime]
    return HMMFeatureVector(
        returns_5d=p[0],
        vix_log=p[1],
        volume_z=p[2],
        spread_high_low=p[3],
        sentiment=p[4],
    )


# ── Constants ─────────────────────────────────────────────────────────────────

def test_regime_labels_complete():
    assert set(REGIME_LABELS) == {"bull_calm", "bull_volatile", "bear", "crisis", "uncertain"}


def test_feature_names_complete():
    assert FEATURE_NAMES == ("returns_5d", "vix_log", "volume_z", "spread_high_low", "sentiment")


def test_constants_values():
    assert LOW_CONFIDENCE_THRESHOLD == 0.50
    assert CONFIRMED_STREAK == 3
    assert SOFTMAX_ALPHA == 2.0


def test_prototypes_all_regimes_present():
    assert set(HMM_PROTOTYPES.keys()) == set(REGIME_LABELS)


def test_prototypes_dimension():
    for regime, proto in HMM_PROTOTYPES.items():
        assert len(proto) == len(FEATURE_NAMES), f"{regime} prototype length mismatch"


# ── HMMFeatureVector ──────────────────────────────────────────────────────────

def test_feature_vector_to_tuple():
    fv = make_feat(1.0, 2.0, 3.0, 4.0, 5.0)
    assert fv.to_tuple() == (1.0, 2.0, 3.0, 4.0, 5.0)


def test_feature_vector_to_tuple_order_matches_feature_names():
    """to_tuple の順序が FEATURE_NAMES と一致することを確認。"""
    fv = HMMFeatureVector(returns_5d=1.0, vix_log=2.0, volume_z=3.0, spread_high_low=4.0, sentiment=5.0)
    t = fv.to_tuple()
    assert t[0] == fv.returns_5d
    assert t[1] == fv.vix_log
    assert t[2] == fv.volume_z
    assert t[3] == fv.spread_high_low
    assert t[4] == fv.sentiment


# ── HMMResult validation ──────────────────────────────────────────────────────

def test_result_invalid_regime_raises():
    with pytest.raises(ValueError, match="Invalid regime"):
        HMMResult(
            regime="invalid",
            confidence=0.9,
            is_trained=False,
            is_surrogate=True,
            is_low_confidence=False,
            primary_signal="returns_5d",
            confirmed=False,
            history=[],
            checked_at=datetime(2026, 1, 1),
        )


def test_result_valid_all_regimes():
    for label in REGIME_LABELS:
        r = HMMResult(
            regime=label,
            confidence=0.8,
            is_trained=False,
            is_surrogate=True,
            is_low_confidence=False,
            primary_signal="returns_5d",
            confirmed=False,
            history=[],
            checked_at=datetime(2026, 1, 1),
        )
        assert r.regime == label


def test_result_checked_at_is_datetime():
    """HMMResult.checked_at は datetime オブジェクト。"""
    detector = HMMRegimeDetector()
    result = detector.predict(proto_feat("uncertain"))
    assert isinstance(result.checked_at, datetime)


# ── HMMRegimeDetector.__init__ ────────────────────────────────────────────────

def test_history_size_zero_raises():
    with pytest.raises(ValueError):
        HMMRegimeDetector(history_size=0)


def test_history_size_negative_raises():
    with pytest.raises(ValueError):
        HMMRegimeDetector(history_size=-1)


def test_history_size_one_valid():
    detector = HMMRegimeDetector(history_size=1)
    result = detector.predict(proto_feat("uncertain"))
    assert len(result.history) == 1


# ── is_trained / is_surrogate ─────────────────────────────────────────────────

def test_is_trained_always_false():
    detector = HMMRegimeDetector()
    result = detector.predict(proto_feat("uncertain"))
    assert result.is_trained is False


def test_is_surrogate_always_true():
    detector = HMMRegimeDetector()
    result = detector.predict(proto_feat("uncertain"))
    assert result.is_surrogate is True


def test_is_trained_false_across_all_regimes():
    """全プロトタイプ入力で is_trained=False / is_surrogate=True。"""
    detector = HMMRegimeDetector()
    for regime in REGIME_LABELS:
        r = detector.predict(proto_feat(regime))
        assert r.is_trained is False
        assert r.is_surrogate is True


# ── Regime detection ──────────────────────────────────────────────────────────

def test_bull_calm_detected():
    result = HMMRegimeDetector().predict(proto_feat("bull_calm"))
    assert result.regime == "bull_calm"


def test_bull_volatile_detected():
    result = HMMRegimeDetector().predict(proto_feat("bull_volatile"))
    assert result.regime == "bull_volatile"


def test_bear_detected():
    result = HMMRegimeDetector().predict(proto_feat("bear"))
    assert result.regime == "bear"


def test_crisis_detected():
    result = HMMRegimeDetector().predict(proto_feat("crisis"))
    assert result.regime == "crisis"


def test_uncertain_detected():
    result = HMMRegimeDetector().predict(proto_feat("uncertain"))
    assert result.regime == "uncertain"


def test_all_five_regimes_reachable():
    """5レジーム全て到達可能。"""
    detector = HMMRegimeDetector()
    regimes = {detector.predict(proto_feat(r)).regime for r in REGIME_LABELS}
    assert regimes == set(REGIME_LABELS)


# ── Confidence ────────────────────────────────────────────────────────────────

def test_confidence_in_range():
    detector = HMMRegimeDetector()
    for regime in REGIME_LABELS:
        r = detector.predict(proto_feat(regime))
        assert 0.0 < r.confidence <= 1.0


def test_confidence_high_at_prototype():
    """プロトタイプ中心点では confidence が 0.5 を超える。"""
    detector = HMMRegimeDetector()
    for regime in REGIME_LABELS:
        r = detector.predict(proto_feat(regime))
        assert r.confidence > LOW_CONFIDENCE_THRESHOLD, f"{regime}: confidence={r.confidence}"


def test_confidence_sums_to_one_invariant():
    """softmax 出力は確率分布（内部検証）。"""
    from backend.engine.regime.hmm_detector import _softmax_confidence, _squared_dist
    feat = proto_feat("crisis").to_tuple()
    distances = {r: _squared_dist(feat, p) for r, p in HMM_PROTOTYPES.items()}
    confs = _softmax_confidence(distances, SOFTMAX_ALPHA)
    assert abs(sum(confs.values()) - 1.0) < 1e-9


# ── is_low_confidence ─────────────────────────────────────────────────────────

def test_is_low_confidence_matches_threshold():
    """is_low_confidence は confidence < LOW_CONFIDENCE_THRESHOLD と一致。"""
    detector = HMMRegimeDetector()
    for regime in REGIME_LABELS:
        r = detector.predict(proto_feat(regime))
        assert r.is_low_confidence == (r.confidence < LOW_CONFIDENCE_THRESHOLD)


def test_is_low_confidence_does_not_override_regime():
    """is_low_confidence=True でも regime は best-match のまま（uncertain に丸めない）。"""
    detector = HMMRegimeDetector()
    for regime in REGIME_LABELS:
        r = detector.predict(proto_feat(regime))
        if r.is_low_confidence:
            assert r.regime in REGIME_LABELS


def test_is_low_confidence_false_at_prototype():
    """プロトタイプ中心では is_low_confidence=False。"""
    detector = HMMRegimeDetector()
    for regime in REGIME_LABELS:
        r = detector.predict(proto_feat(regime))
        assert r.is_low_confidence is False, f"{regime}: confidence={r.confidence}"


# ── primary_signal ────────────────────────────────────────────────────────────

def test_primary_signal_is_valid_feature_name():
    detector = HMMRegimeDetector()
    for regime in REGIME_LABELS:
        r = detector.predict(proto_feat(regime))
        assert r.primary_signal in FEATURE_NAMES


def test_primary_signal_vix_log_dominant():
    """uncertain 近傍で vix_log だけずらすと primary_signal = vix_log。"""
    # (0, 0.5, 0, 0, 0) → closest to uncertain, vix_log contribution が最大
    result = HMMRegimeDetector().predict(make_feat(vix_log=0.5))
    assert result.regime == "uncertain"
    assert result.primary_signal == "vix_log"


def test_primary_signal_sentiment_dominant():
    """bull_calm 中心で sentiment だけ大きくずらすと primary_signal = sentiment。"""
    # bull_calm proto = (1.0, -1.0, -0.2, -0.5, 1.0)
    # sentiment を 3.0 にずらす → bull_calm に最近接だが sentiment の寄与が最大
    result = HMMRegimeDetector().predict(
        make_feat(returns_5d=1.0, vix_log=-1.0, volume_z=-0.2, spread_high_low=-0.5, sentiment=3.0)
    )
    assert result.regime == "bull_calm"
    assert result.primary_signal == "sentiment"


# ── confirmed ─────────────────────────────────────────────────────────────────

def test_confirmed_false_first_call():
    detector = HMMRegimeDetector()
    result = detector.predict(proto_feat("crisis"))
    assert result.confirmed is False


def test_confirmed_false_second_call():
    detector = HMMRegimeDetector()
    detector.predict(proto_feat("crisis"))
    result = detector.predict(proto_feat("crisis"))
    assert result.confirmed is False


def test_confirmed_true_third_call():
    """3回連続同一レジーム → confirmed=True。"""
    detector = HMMRegimeDetector()
    detector.predict(proto_feat("crisis"))
    detector.predict(proto_feat("crisis"))
    result = detector.predict(proto_feat("crisis"))
    assert result.confirmed is True


def test_confirmed_resets_after_regime_change():
    """レジームが変わると連続カウントがリセット → confirmed=False。"""
    detector = HMMRegimeDetector(history_size=5)
    for _ in range(3):
        detector.predict(proto_feat("crisis"))
    detector.predict(proto_feat("bull_calm"))
    result = detector.predict(proto_feat("bull_calm"))
    assert result.confirmed is False


def test_confirmed_dict_api_true():
    """dict API: history 2件 + 今回で3連続 → confirmed=True。"""
    result = detect_regime_hmm(make_dict(history=["crisis", "crisis"], **{
        "returns_5d": HMM_PROTOTYPES["crisis"][0],
        "vix_log":    HMM_PROTOTYPES["crisis"][1],
        "volume_z":   HMM_PROTOTYPES["crisis"][2],
        "spread_high_low": HMM_PROTOTYPES["crisis"][3],
        "sentiment":  HMM_PROTOTYPES["crisis"][4],
    }))
    assert result["regime"] == "crisis"
    assert result["confirmed"] is True


# ── history ───────────────────────────────────────────────────────────────────

def test_history_length_grows():
    detector = HMMRegimeDetector()
    r1 = detector.predict(proto_feat("uncertain"))
    r2 = detector.predict(proto_feat("uncertain"))
    r3 = detector.predict(proto_feat("uncertain"))
    assert len(r1.history) == 1
    assert len(r2.history) == 2
    assert len(r3.history) == 3


def test_history_capped_at_history_size():
    """history は history_size を超えない。"""
    detector = HMMRegimeDetector(history_size=3)
    for _ in range(10):
        detector.predict(proto_feat("uncertain"))
    result = detector.predict(proto_feat("uncertain"))
    assert len(result.history) <= 3


def test_history_dict_api_capped_at_ten():
    """dict API: history は最大10件。"""
    long_history = ["uncertain"] * 15
    p = HMM_PROTOTYPES["uncertain"]
    result = detect_regime_hmm({
        "returns_5d": p[0], "vix_log": p[1], "volume_z": p[2],
        "spread_high_low": p[3], "sentiment": p[4],
        "history": long_history,
    })
    assert len(result["history"]) <= 10


def test_history_appends_current_regime():
    detector = HMMRegimeDetector()
    result = detector.predict(proto_feat("bull_calm"))
    assert result.history[-1] == result.regime


# ── reset_history ─────────────────────────────────────────────────────────────

def test_reset_history_clears_state():
    """reset_history 後は confirmed=False / history 1件に戻る。"""
    detector = HMMRegimeDetector()
    for _ in range(3):
        detector.predict(proto_feat("crisis"))
    detector.reset_history()
    result = detector.predict(proto_feat("crisis"))
    assert result.confirmed is False
    assert len(result.history) == 1


# ── checked_at ────────────────────────────────────────────────────────────────

def test_result_checked_at_type_is_datetime():
    """HMMResult.checked_at は datetime 型。"""
    result = HMMRegimeDetector().predict(proto_feat("uncertain"))
    assert isinstance(result.checked_at, datetime)


def test_dict_checked_at_is_isoformat_string():
    """detect_regime_hmm() の checked_at は isoformat 文字列。"""
    result = detect_regime_hmm(make_dict())
    assert isinstance(result["checked_at"], str)
    assert "T" in result["checked_at"]
    assert "+00:00" in result["checked_at"]


# ── dict interface ────────────────────────────────────────────────────────────

def test_dict_interface_required_keys():
    result = detect_regime_hmm(make_dict())
    expected = {
        "regime", "confidence", "is_trained", "is_surrogate",
        "is_low_confidence", "primary_signal", "confirmed", "history", "checked_at",
    }
    assert expected.issubset(result.keys())


def test_dict_interface_is_trained_false():
    assert detect_regime_hmm(make_dict())["is_trained"] is False


def test_dict_interface_is_surrogate_true():
    assert detect_regime_hmm(make_dict())["is_surrogate"] is True


def test_dict_interface_regime_valid():
    result = detect_regime_hmm(make_dict())
    assert result["regime"] in REGIME_LABELS


def test_dict_no_history_key_works():
    """history キーなし dict でも動作。"""
    data = {
        "returns_5d": 0.0, "vix_log": 0.0, "volume_z": 0.0,
        "spread_high_low": 0.0, "sentiment": 0.0,
    }
    result = detect_regime_hmm(data)
    assert isinstance(result["history"], list)
    assert len(result["history"]) == 1


# ── Detection-only 担保 ───────────────────────────────────────────────────────

def test_no_forbidden_fields_in_result():
    """HMMResult に order / trade / execute / action フィールドなし。"""
    result = HMMRegimeDetector().predict(proto_feat("crisis"))
    forbidden = {"order", "trade", "execute", "action"}
    assert set(vars(result)).isdisjoint(forbidden)


def test_no_side_effects():
    """同一入力を複数回呼び出しても regime が変わらない。"""
    feat = proto_feat("bear")
    detector = HMMRegimeDetector()
    regimes = [detector.predict(feat).regime for _ in range(5)]
    assert len(set(regimes)) == 1


def test_no_rule_based_import():
    """rule_based モジュールを import していない。"""
    import backend.engine.regime.hmm_detector as mod
    assert not hasattr(mod, "detect_regime_rule_based")
    assert not hasattr(mod, "evaluate_rule_based")
    assert not hasattr(mod, "RuleBasedInput")
