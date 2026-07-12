"""
Card 3-3 — LLM Quality Detection テスト
Detection-only / Stub 実装を担保するテスト群。
"""
from __future__ import annotations

from datetime import datetime

import pytest

from backend.engine.regime.llm_quality import (
    LOW_CONFIDENCE_THRESHOLD,
    REGIME_LABELS,
    VALID_PRIMARY_SIGNALS,
    VALID_STRUCTURAL_CHANGES,
    LLMQualityDetector,
    LLMQualityInput,
    LLMQualityResult,
    _derive_primary_signal,
    _parse_structural_changes,
    _validate_llm_response,
    detect_regime_llm,
    evaluate_llm_quality,
    evaluate_llm_response,
)


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def make_input(
    news_summary: str = "市場は安定しています。",
    vix: float = 20.0,
    nikkei_5d_return: float = 0.01,
    usdjpy: float = 150.0,
) -> LLMQualityInput:
    return LLMQualityInput(
        news_summary=news_summary,
        vix=vix,
        nikkei_5d_return=nikkei_5d_return,
        usdjpy=usdjpy,
    )


def make_raw(
    regime: str = "uncertain",
    confidence: float = 0.0,
    structural_changes: list | None = None,
) -> dict:
    return {
        "regime": regime,
        "confidence": confidence,
        "structural_changes": structural_changes if structural_changes is not None else [],
    }


def make_macro(
    vix: float = 20.0,
    nikkei_5d_return: float = 0.01,
    usdjpy: float = 150.0,
) -> dict:
    return {"vix": vix, "nikkei_5d_return": nikkei_5d_return, "usdjpy": usdjpy}


# ── Constants ─────────────────────────────────────────────────────────────────

def test_valid_structural_changes_set():
    assert VALID_STRUCTURAL_CHANGES == frozenset({
        "financial_crisis_signs",
        "geopolitical_risk",
        "major_policy_change",
    })


def test_valid_primary_signals_set():
    assert VALID_PRIMARY_SIGNALS == frozenset({"structural_change", "news", "macro"})


def test_regime_labels_complete():
    assert set(REGIME_LABELS) == {"bull_calm", "bull_volatile", "bear", "crisis", "uncertain"}


def test_low_confidence_threshold_value():
    assert LOW_CONFIDENCE_THRESHOLD == 0.50


# ── LLMQualityInput ───────────────────────────────────────────────────────────

def test_input_construction():
    inp = make_input()
    assert inp.news_summary == "市場は安定しています。"
    assert inp.vix == 20.0
    assert inp.nikkei_5d_return == 0.01
    assert inp.usdjpy == 150.0


def test_input_fields():
    inp = LLMQualityInput(
        news_summary="test",
        vix=25.0,
        nikkei_5d_return=-0.02,
        usdjpy=155.0,
    )
    assert inp.vix == 25.0
    assert inp.nikkei_5d_return == -0.02


# ── LLMQualityResult validation ───────────────────────────────────────────────

def test_result_invalid_regime_raises():
    with pytest.raises(ValueError, match="Invalid regime"):
        LLMQualityResult(
            regime="invalid",
            confidence=0.5,
            structural_changes=[],
            is_llm=True,
            is_stub=True,
            is_low_confidence=False,
            primary_signal="news",
            has_structural_change=False,
            checked_at=datetime(2026, 1, 1),
        )


def test_result_valid_all_regimes():
    for label in REGIME_LABELS:
        r = LLMQualityResult(
            regime=label,
            confidence=0.6,
            structural_changes=[],
            is_llm=True,
            is_stub=True,
            is_low_confidence=False,
            primary_signal="news",
            has_structural_change=False,
            checked_at=datetime(2026, 1, 1),
        )
        assert r.regime == label


def test_result_checked_at_is_datetime():
    result = LLMQualityDetector().detect(make_input())
    assert isinstance(result.checked_at, datetime)


# ── _validate_llm_response ────────────────────────────────────────────────────

def test_validate_valid_response():
    assert _validate_llm_response(make_raw("bull_calm", 0.7)) is True


def test_validate_missing_regime():
    raw = {"confidence": 0.5, "structural_changes": []}
    assert _validate_llm_response(raw) is False


def test_validate_invalid_regime_value():
    assert _validate_llm_response(make_raw(regime="unknown_regime")) is False


def test_validate_missing_confidence():
    raw = {"regime": "uncertain", "structural_changes": []}
    assert _validate_llm_response(raw) is False


def test_validate_confidence_out_of_range_high():
    assert _validate_llm_response(make_raw("uncertain", confidence=1.1)) is False


def test_validate_confidence_out_of_range_low():
    assert _validate_llm_response(make_raw("uncertain", confidence=-0.1)) is False


def test_validate_missing_structural_changes():
    raw = {"regime": "uncertain", "confidence": 0.5}
    assert _validate_llm_response(raw) is False


def test_validate_structural_changes_not_list():
    raw = {"regime": "uncertain", "confidence": 0.5, "structural_changes": "geopolitical_risk"}
    assert _validate_llm_response(raw) is False


def test_validate_confidence_boundary_zero():
    """confidence=0.0 は有効。"""
    assert _validate_llm_response(make_raw("uncertain", confidence=0.0)) is True


def test_validate_confidence_boundary_one():
    """confidence=1.0 は有効。"""
    assert _validate_llm_response(make_raw("crisis", confidence=1.0)) is True


def test_validate_bool_confidence_rejected():
    """bool は int のサブクラスだが confidence として無効。"""
    raw = {"regime": "uncertain", "confidence": True, "structural_changes": []}
    assert _validate_llm_response(raw) is False


def test_validate_structural_changes_with_invalid_items_passes():
    """structural_changes の内容検証はしない（_parse でフィルタ）。リストであれば valid。"""
    raw = {"regime": "uncertain", "confidence": 0.5, "structural_changes": ["invalid_type"]}
    assert _validate_llm_response(raw) is True


# ── _parse_structural_changes ─────────────────────────────────────────────────

def test_parse_valid_list():
    result = _parse_structural_changes(["financial_crisis_signs", "geopolitical_risk"])
    assert set(result) == {"financial_crisis_signs", "geopolitical_risk"}


def test_parse_invalid_items_filtered():
    result = _parse_structural_changes(["unknown_signal", "geopolitical_risk"])
    assert result == ["geopolitical_risk"]


def test_parse_empty_list():
    assert _parse_structural_changes([]) == []


def test_parse_mixed_valid_invalid():
    raw = ["financial_crisis_signs", "invalid_type", "major_policy_change", 123]
    result = _parse_structural_changes(raw)
    assert set(result) == {"financial_crisis_signs", "major_policy_change"}


# ── _derive_primary_signal ────────────────────────────────────────────────────

def test_primary_signal_with_structural_change():
    assert _derive_primary_signal(["geopolitical_risk"]) == "structural_change"


def test_primary_signal_no_structural_change():
    assert _derive_primary_signal([]) == "news"


def test_primary_signal_multiple_changes():
    result = _derive_primary_signal(["financial_crisis_signs", "major_policy_change"])
    assert result == "structural_change"


# ── evaluate_llm_response ─────────────────────────────────────────────────────

def test_evaluate_valid_response():
    raw = make_raw("bull_volatile", 0.72)
    result = evaluate_llm_response(raw)
    assert result.regime == "bull_volatile"
    assert result.confidence == 0.72
    assert result.is_llm is True
    assert result.is_stub is True


def test_evaluate_with_structural_changes():
    raw = make_raw("crisis", 0.85, structural_changes=["financial_crisis_signs"])
    result = evaluate_llm_response(raw)
    assert result.regime == "crisis"
    assert "financial_crisis_signs" in result.structural_changes
    assert result.has_structural_change is True
    assert result.primary_signal == "structural_change"


def test_evaluate_invalid_response_returns_fallback():
    raw = {"regime": "not_a_regime", "confidence": 0.5, "structural_changes": []}
    result = evaluate_llm_response(raw)
    assert result.regime == "uncertain"
    assert result.confidence == 0.0
    assert result.is_low_confidence is True


def test_evaluate_is_llm_always_true():
    assert evaluate_llm_response(make_raw()).is_llm is True


def test_evaluate_has_structural_change_false_when_empty():
    result = evaluate_llm_response(make_raw("uncertain", 0.0))
    assert result.has_structural_change is False


def test_evaluate_invalid_items_in_structural_changes_filtered():
    """structural_changes の無効要素はフィルタされ has_structural_change=False になる。"""
    raw = make_raw("bear", 0.7, structural_changes=["invalid_type_only"])
    result = evaluate_llm_response(raw)
    assert result.structural_changes == []
    assert result.has_structural_change is False
    assert result.primary_signal == "news"


# ── LLMQualityDetector ────────────────────────────────────────────────────────

def test_detector_default_stub_returns_result():
    result = LLMQualityDetector().detect(make_input())
    assert isinstance(result, LLMQualityResult)


def test_detector_default_stub_regime_uncertain():
    """default stub は uncertain / confidence=0.0 を返す。"""
    result = LLMQualityDetector().detect(make_input())
    assert result.regime == "uncertain"
    assert result.confidence == 0.0


def test_detector_is_stub_true():
    assert LLMQualityDetector().detect(make_input()).is_stub is True


def test_detector_is_llm_true():
    assert LLMQualityDetector().detect(make_input()).is_llm is True


def test_detector_custom_stub_response():
    """カスタム stub で任意のレジームを返せる。"""
    custom = make_raw("crisis", 0.90, structural_changes=["geopolitical_risk"])
    result = LLMQualityDetector(stub_response=custom).detect(make_input())
    assert result.regime == "crisis"
    assert result.confidence == 0.90
    assert result.has_structural_change is True
    assert "geopolitical_risk" in result.structural_changes


def test_detector_invalid_stub_falls_back():
    """無効な stub は fallback に移行する。"""
    bad = {"regime": "invalid_regime", "confidence": 2.0, "structural_changes": []}
    result = LLMQualityDetector(stub_response=bad).detect(make_input())
    assert result.regime == "uncertain"
    assert result.confidence == 0.0


def test_detector_checked_at_is_datetime():
    result = LLMQualityDetector().detect(make_input())
    assert isinstance(result.checked_at, datetime)


# ── evaluate_llm_quality ──────────────────────────────────────────────────────

def test_evaluate_llm_quality_returns_result():
    assert isinstance(evaluate_llm_quality(make_input()), LLMQualityResult)


def test_evaluate_llm_quality_is_llm_true():
    assert evaluate_llm_quality(make_input()).is_llm is True


def test_evaluate_llm_quality_is_stub_true():
    assert evaluate_llm_quality(make_input()).is_stub is True


# ── confidence / is_low_confidence ────────────────────────────────────────────

def test_is_low_confidence_true_when_below_threshold():
    result = evaluate_llm_response(make_raw("uncertain", 0.40))
    assert result.is_low_confidence is True


def test_is_low_confidence_false_when_above_threshold():
    result = evaluate_llm_response(make_raw("bull_calm", 0.70))
    assert result.is_low_confidence is False


def test_is_low_confidence_at_threshold_is_false():
    """confidence = 0.50 は strictly less than 判定で is_low_confidence=False。"""
    result = evaluate_llm_response(make_raw("uncertain", LOW_CONFIDENCE_THRESHOLD))
    assert result.is_low_confidence is False


def test_fallback_confidence_zero_and_low_confidence():
    invalid = {"regime": "bad_value", "confidence": 0.5, "structural_changes": []}
    result = evaluate_llm_response(invalid)
    assert result.confidence == 0.0
    assert result.is_low_confidence is True


# ── detect_regime_llm dict API ────────────────────────────────────────────────

def test_dict_interface_required_keys():
    result = detect_regime_llm("市場安定。", make_macro())
    expected = {
        "regime", "confidence", "structural_changes",
        "is_llm", "is_stub", "is_low_confidence",
        "primary_signal", "has_structural_change", "checked_at",
    }
    assert expected.issubset(result.keys())


def test_dict_interface_regime_valid():
    result = detect_regime_llm("市場安定。", make_macro())
    assert result["regime"] in REGIME_LABELS


def test_dict_interface_is_llm_true():
    assert detect_regime_llm("test", make_macro())["is_llm"] is True


def test_dict_interface_is_stub_true():
    assert detect_regime_llm("test", make_macro())["is_stub"] is True


def test_dict_interface_checked_at_is_isoformat_string():
    result = detect_regime_llm("test", make_macro())
    assert isinstance(result["checked_at"], str)
    assert "T" in result["checked_at"]
    assert "+00:00" in result["checked_at"]


def test_dict_interface_confidence_in_range():
    result = detect_regime_llm("test", make_macro())
    assert 0.0 <= result["confidence"] <= 1.0


# ── Detection-only 担保 ───────────────────────────────────────────────────────

def test_no_forbidden_fields():
    """LLMQualityResult に order / trade / execute / action フィールドなし。"""
    result = LLMQualityDetector().detect(make_input())
    forbidden = {"order", "trade", "execute", "action"}
    assert set(vars(result)).isdisjoint(forbidden)


def test_no_side_effects():
    """同一入力を複数回呼び出しても regime が変わらない。"""
    detector = LLMQualityDetector()
    inp = make_input()
    regimes = [detector.detect(inp).regime for _ in range(5)]
    assert len(set(regimes)) == 1


def test_no_rule_based_or_hmm_import():
    """rule_based / hmm_detector モジュールを import していない。"""
    import backend.engine.regime.llm_quality as mod
    assert not hasattr(mod, "detect_regime_rule_based")
    assert not hasattr(mod, "evaluate_rule_based")
    assert not hasattr(mod, "evaluate_hmm")
    assert not hasattr(mod, "HMMRegimeDetector")
