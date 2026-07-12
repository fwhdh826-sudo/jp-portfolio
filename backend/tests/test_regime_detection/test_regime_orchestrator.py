"""
Card 3-5 — Regime Orchestrator テスト
Detection-only / 統合 Orchestration 実装を担保するテスト群。
"""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from backend.engine.regime.llm_quality import LLMQualityInput, LLMQualityResult
from backend.engine.regime.regime_orchestrator import (
    REGIME_LABELS,
    OrchestratorInput,
    OrchestratorResult,
    OrchestratorState,
    RegimeOrchestrator,
    detect_regime,
    run_regime_orchestrator,
)


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def make_bull_calm_market() -> dict:
    """rule_based → bull_calm: vix<18 AND nikkei_5d>=0"""
    return {
        "vix": 15.0,
        "nikkei_5d_return": 0.02,
        "nikkei_60ma": 50000.0,
        "nikkei_200ma": 48000.0,
        "sp500_dd_30d": -0.02,
    }


def make_bull_calm_hmm() -> dict:
    """HMM prototype for bull_calm: (1.0, -1.0, -0.2, -0.5, 1.0)"""
    return {
        "returns_5d": 1.0,
        "vix_log": -1.0,
        "volume_z": -0.2,
        "spread_high_low": -0.5,
        "sentiment": 1.0,
    }


def make_crisis_market() -> dict:
    """rule_based → crisis: vix>40"""
    return {
        "vix": 45.0,
        "nikkei_5d_return": -0.05,
        "nikkei_60ma": 45000.0,
        "nikkei_200ma": 50000.0,
        "sp500_dd_30d": -0.25,
    }


def make_crisis_hmm() -> dict:
    """HMM prototype for crisis: (-2.5, 2.5, 2.5, 2.5, -2.0)"""
    return {
        "returns_5d": -2.5,
        "vix_log": 2.5,
        "volume_z": 2.5,
        "spread_high_low": 2.5,
        "sentiment": -2.0,
    }


def make_macro(vix: float = 15.0) -> dict:
    return {"vix": vix, "nikkei_5d_return": 0.02, "usdjpy": 150.0}


def make_input(
    market_data: dict | None = None,
    hmm_features: dict | None = None,
    news_summary: str = "市場は安定しています。",
    macro_state: dict | None = None,
    run_date: date | None = None,
) -> OrchestratorInput:
    return OrchestratorInput(
        market_data=market_data or make_bull_calm_market(),
        hmm_features=hmm_features or make_bull_calm_hmm(),
        news_summary=news_summary,
        macro_state=macro_state or make_macro(),
        run_date=run_date,
    )


# ── Mock LLM detector for override tests ──────────────────────────────────────

class _MockLLMDetector:
    """テスト用モック。LLMQualityResult を直接返す。"""
    def __init__(self, result: LLMQualityResult) -> None:
        self._result = result

    def detect(self, inp: LLMQualityInput) -> LLMQualityResult:
        return self._result


def make_override_llm_result(
    regime: str = "crisis",
    confidence: float = 0.85,
    structural_changes: list | None = None,
    is_low_confidence: bool = False,
) -> LLMQualityResult:
    """is_stub=False（real LLM を想定）の override 用 LLMQualityResult。"""
    sc = structural_changes if structural_changes is not None else ["geopolitical_risk"]
    return LLMQualityResult(
        regime=regime,
        confidence=confidence,
        structural_changes=sc,
        is_llm=True,
        is_stub=False,
        is_low_confidence=is_low_confidence,
        primary_signal="structural_change",
        has_structural_change=bool(sc),
        checked_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


# ── Constants ─────────────────────────────────────────────────────────────────

def test_regime_labels_complete():
    assert set(REGIME_LABELS) == {"bull_calm", "bull_volatile", "bear", "crisis", "uncertain"}


# ── OrchestratorState ─────────────────────────────────────────────────────────

def test_orchestrator_state_default():
    state = OrchestratorState()
    assert state.last_run_date is None
    assert state.last_result is None


# ── OrchestratorInput ─────────────────────────────────────────────────────────

def test_input_construction():
    inp = make_input()
    assert inp.news_summary == "市場は安定しています。"
    assert inp.market_data["vix"] == 15.0


def test_input_run_date_defaults_to_none():
    inp = make_input()
    assert inp.run_date is None


# ── OrchestratorResult validation ─────────────────────────────────────────────

def test_result_invalid_regime_raises():
    with pytest.raises(ValueError, match="Invalid regime"):
        OrchestratorResult(
            regime="invalid",
            is_crisis=False,
            raw_consensus=0.67,
            consensus=0.67,
            confidence=0.57,
            is_override=False,
            votes={},
            vote_count=2,
            is_fallback=False,
            disagree_layers=[],
            layer_reliability={},
            structural_changes=[],
            hmm_confirmed=False,
            hmm_is_surrogate=True,
            llm_is_stub=True,
            market_data_snapshot={},
            run_date=date(2026, 1, 1),
            checked_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            layer_results={},
        )


# ── run() — 基本統合フロー ────────────────────────────────────────────────────

def test_run_returns_orchestrator_result():
    result = run_regime_orchestrator(make_input())
    assert isinstance(result, OrchestratorResult)


def test_run_regime_valid_label():
    result = run_regime_orchestrator(make_input())
    assert result.regime in REGIME_LABELS


def test_run_is_crisis_false_when_bull_calm():
    result = run_regime_orchestrator(make_input())
    assert result.is_crisis is False


def test_run_is_crisis_true_when_crisis():
    """vix=45 → rule_based=crisis, HMM=crisis → 2票以上一致 → crisis / is_crisis=True"""
    result = run_regime_orchestrator(make_input(
        market_data=make_crisis_market(),
        hmm_features=make_crisis_hmm(),
        macro_state=make_macro(vix=45.0),
    ))
    assert result.is_crisis is True
    assert result.regime == "crisis"


def test_run_votes_keys():
    result = run_regime_orchestrator(make_input())
    assert set(result.votes.keys()) == {"rule_based", "hmm", "llm"}


def test_run_checked_at_is_datetime():
    result = run_regime_orchestrator(make_input())
    assert isinstance(result.checked_at, datetime)


def test_run_checked_at_is_utc():
    result = run_regime_orchestrator(make_input())
    assert result.checked_at.tzinfo == timezone.utc


def test_run_run_date_stored():
    d = date(2026, 5, 1)
    result = run_regime_orchestrator(make_input(run_date=d))
    assert result.run_date == d


# ── layer_reliability（P1-B 解消） ────────────────────────────────────────────

def test_layer_reliability_keys():
    result = run_regime_orchestrator(make_input())
    assert set(result.layer_reliability.keys()) == {"rule_based", "hmm", "llm"}


def test_layer_reliability_each_entry_keys():
    result = run_regime_orchestrator(make_input())
    for layer in ("rule_based", "hmm", "llm"):
        assert set(result.layer_reliability[layer].keys()) == {
            "effective_weight", "is_surrogate", "is_stub", "is_low_confidence"
        }


def test_layer_reliability_effective_weights_sum():
    result = run_regime_orchestrator(make_input())
    total = sum(v["effective_weight"] for v in result.layer_reliability.values())
    assert abs(total - 1.0) < 1e-9


def test_layer_reliability_hmm_is_surrogate_true():
    """HMM は常に is_surrogate=True（Card 3-X 実学習前）"""
    result = run_regime_orchestrator(make_input())
    assert result.layer_reliability["hmm"]["is_surrogate"] is True


def test_layer_reliability_llm_is_stub_true():
    """LLM は常に is_stub=True（Card 3-7 実 LLM 接続前）"""
    result = run_regime_orchestrator(make_input())
    assert result.layer_reliability["llm"]["is_stub"] is True


def test_layer_reliability_rule_based_not_surrogate():
    result = run_regime_orchestrator(make_input())
    assert result.layer_reliability["rule_based"]["is_surrogate"] is False
    assert result.layer_reliability["rule_based"]["is_stub"] is False


def test_layer_reliability_llm_stub_effective_weight_zero():
    """LLM is_stub=True のとき effective_weight=0.0（P1-B: raw vote には残るが weight は 0）"""
    result = run_regime_orchestrator(make_input())
    assert result.layer_reliability["llm"]["effective_weight"] == pytest.approx(0.0)


# ── daily-once guard ──────────────────────────────────────────────────────────

def test_already_run_today_false_initially():
    orch = RegimeOrchestrator()
    assert orch.already_run_today(date(2026, 5, 1)) is False


def test_already_run_today_true_after_run():
    orch = RegimeOrchestrator()
    orch.run(make_input(run_date=date(2026, 5, 1)))
    assert orch.already_run_today(date(2026, 5, 1)) is True


def test_already_run_today_false_next_day():
    orch = RegimeOrchestrator()
    orch.run(make_input(run_date=date(2026, 5, 1)))
    assert orch.already_run_today(date(2026, 5, 2)) is False


def test_run_returns_cached_on_same_day():
    """同日2回目はキャッシュ結果を返す（checked_at が同一）"""
    orch = RegimeOrchestrator()
    d = date(2026, 5, 1)
    r1 = orch.run(make_input(run_date=d))
    r2 = orch.run(make_input(run_date=d))
    assert r1 is r2  # 同一オブジェクト


def test_run_cached_regime_matches():
    orch = RegimeOrchestrator()
    d = date(2026, 5, 1)
    r1 = orch.run(make_input(run_date=d))
    r2 = orch.run(make_input(run_date=d))
    assert r1.regime == r2.regime


def test_run_recalculates_next_day():
    """翌日は再計算（新しい checked_at）"""
    orch = RegimeOrchestrator()
    r1 = orch.run(make_input(run_date=date(2026, 5, 1)))
    r2 = orch.run(make_input(run_date=date(2026, 5, 2)))
    assert r1 is not r2
    assert r2.run_date == date(2026, 5, 2)


# ── structural_change_override + consensus（P1-C 解消） ───────────────────────

def test_override_fires_when_not_stub_with_structural_change():
    """LLM is_stub=False + has_structural_change=True → override 発動"""
    llm = _MockLLMDetector(make_override_llm_result("crisis", 0.85))
    orch = RegimeOrchestrator(llm_detector=llm)
    result = orch.run(make_input())
    assert result.is_override is True
    assert result.regime == "crisis"


def test_override_suppressed_when_stub():
    """LLM is_stub=True の場合は override 発動しない（bull_calm 2票で勝つ）"""
    result = run_regime_orchestrator(make_input(
        market_data=make_bull_calm_market(),
        hmm_features=make_bull_calm_hmm(),
    ))
    assert result.is_override is False
    assert result.regime == "bull_calm"


def test_raw_consensus_is_one_third_on_override():
    """override 発動時でも raw_consensus = 1/3 を保持（P1-C）"""
    llm = _MockLLMDetector(make_override_llm_result("crisis", 0.85))
    orch = RegimeOrchestrator(llm_detector=llm)
    result = orch.run(make_input())
    assert result.raw_consensus == pytest.approx(1 / 3)


def test_consensus_reflects_llm_weight_on_override():
    """override 発動時の表示 consensus は effective_weights["llm"]（P1-C）"""
    llm = _MockLLMDetector(make_override_llm_result("crisis", 0.85))
    orch = RegimeOrchestrator(llm_detector=llm)
    result = orch.run(make_input())
    # 通常時 LLM stub → weight=0 だが override 用 LLM は is_stub=False、is_low_confidence=False
    # rule_based=0.4, hmm=0.1(surrogate), llm=0.3 → total=0.8 → llm_weight=0.3/0.8=0.375
    assert result.consensus == pytest.approx(result.layer_reliability["llm"]["effective_weight"])
    assert result.consensus > 0.0


def test_confidence_reflects_llm_weight_on_override():
    """override 発動時の confidence は effective_weights["llm"]（P1-C）"""
    llm = _MockLLMDetector(make_override_llm_result("crisis", 0.85))
    orch = RegimeOrchestrator(llm_detector=llm)
    result = orch.run(make_input())
    assert result.confidence == pytest.approx(result.consensus)
    assert result.confidence == pytest.approx(result.layer_reliability["llm"]["effective_weight"])


def test_llm_low_confidence_override_confidence_lower():
    """LLM low_confidence=True + override 時、confidence が通常より低くなる"""
    llm_normal = _MockLLMDetector(make_override_llm_result("crisis", 0.85, is_low_confidence=False))
    llm_low = _MockLLMDetector(make_override_llm_result("crisis", 0.40, is_low_confidence=True))

    orch_normal = RegimeOrchestrator(llm_detector=llm_normal)
    orch_low = RegimeOrchestrator(llm_detector=llm_low)

    r_normal = orch_normal.run(make_input())
    r_low = orch_low.run(make_input())

    assert r_low.confidence < r_normal.confidence
    assert r_low.layer_reliability["llm"]["is_low_confidence"] is True


def test_llm_low_confidence_override_still_fires():
    """LLM low_confidence=True でも override は発動する（is_stub=False が条件）"""
    llm = _MockLLMDetector(make_override_llm_result("crisis", 0.40, is_low_confidence=True))
    orch = RegimeOrchestrator(llm_detector=llm)
    result = orch.run(make_input())
    assert result.is_override is True
    assert result.regime == "crisis"


def test_override_structural_changes_in_result():
    """override 発動時、structural_changes が OrchestratorResult に伝搬する"""
    llm = _MockLLMDetector(make_override_llm_result(
        structural_changes=["financial_crisis_signs", "geopolitical_risk"]
    ))
    orch = RegimeOrchestrator(llm_detector=llm)
    result = orch.run(make_input())
    assert "financial_crisis_signs" in result.structural_changes
    assert "geopolitical_risk" in result.structural_changes


def test_no_override_structural_changes_empty():
    """override なし（stub LLM）の場合、structural_changes は空リスト"""
    result = run_regime_orchestrator(make_input())
    assert result.structural_changes == []


# ── is_fallback / disagree_layers ────────────────────────────────────────────

def test_is_fallback_flag_exists():
    result = run_regime_orchestrator(make_input())
    assert isinstance(result.is_fallback, bool)


def test_disagree_layers_is_list():
    result = run_regime_orchestrator(make_input())
    assert isinstance(result.disagree_layers, list)


# ── hmm_confirmed / hmm_is_surrogate / llm_is_stub ───────────────────────────

def test_hmm_is_surrogate_true():
    result = run_regime_orchestrator(make_input())
    assert result.hmm_is_surrogate is True


def test_llm_is_stub_true():
    result = run_regime_orchestrator(make_input())
    assert result.llm_is_stub is True


def test_hmm_confirmed_is_bool():
    result = run_regime_orchestrator(make_input())
    assert isinstance(result.hmm_confirmed, bool)


# ── to_dict() schema ─────────────────────────────────────────────────────────

def test_to_dict_returns_dict():
    result = run_regime_orchestrator(make_input())
    d = result.to_dict()
    assert isinstance(d, dict)


def test_to_dict_top_level_key():
    d = run_regime_orchestrator(make_input()).to_dict()
    assert "regime_state" in d


def test_to_dict_required_keys():
    d = run_regime_orchestrator(make_input()).to_dict()["regime_state"]
    required = {
        "timestamp", "current_regime", "consensus", "raw_consensus", "confidence",
        "is_override", "is_crisis", "votes", "layer_reliability",
        "structural_changes", "vote_count", "is_fallback", "disagree_layers",
        "hmm_confirmed", "hmm_is_surrogate", "llm_is_stub",
        "market_data_snapshot", "run_date",
    }
    assert required.issubset(d.keys())


def test_to_dict_checked_at_isoformat():
    d = run_regime_orchestrator(make_input()).to_dict()["regime_state"]
    assert isinstance(d["timestamp"], str)
    assert "T" in d["timestamp"]
    assert "+00:00" in d["timestamp"]


def test_to_dict_is_crisis_present():
    d = run_regime_orchestrator(make_input()).to_dict()["regime_state"]
    assert "is_crisis" in d
    assert isinstance(d["is_crisis"], bool)


def test_to_dict_layer_reliability_present():
    d = run_regime_orchestrator(make_input()).to_dict()["regime_state"]
    assert "layer_reliability" in d
    assert set(d["layer_reliability"].keys()) == {"rule_based", "hmm", "llm"}


def test_to_dict_raw_consensus_present():
    d = run_regime_orchestrator(make_input()).to_dict()["regime_state"]
    assert "raw_consensus" in d
    assert isinstance(d["raw_consensus"], float)


def test_to_dict_votes_spec_format():
    """spec 11.1 の votes 形式: hmm は [regime, confidence] のリスト"""
    d = run_regime_orchestrator(make_input()).to_dict()["regime_state"]
    votes = d["votes"]
    assert isinstance(votes["rule_based"], str)
    assert isinstance(votes["hmm"], list)
    assert len(votes["hmm"]) == 2
    assert isinstance(votes["llm"], dict)
    assert "regime" in votes["llm"]
    assert "confidence" in votes["llm"]
    assert "structural_changes" in votes["llm"]


def test_to_dict_market_data_snapshot_keys():
    d = run_regime_orchestrator(make_input()).to_dict()["regime_state"]
    snap = d["market_data_snapshot"]
    assert "vix" in snap
    assert "nikkei_5d_return" in snap
    assert "sp500_dd_30d" in snap


def test_to_dict_does_not_write_file(tmp_path):
    """to_dict() はファイルを書き込まない（戻り値は dict のみ）"""
    result = run_regime_orchestrator(make_input())
    d = result.to_dict()
    assert isinstance(d, dict)
    # tmp_path に何も書き込まれていない
    assert list(tmp_path.iterdir()) == []


# ── detect_regime dict API ────────────────────────────────────────────────────

def test_dict_api_required_keys():
    result = detect_regime(
        market_data=make_bull_calm_market(),
        hmm_features=make_bull_calm_hmm(),
        news_summary="テスト",
        macro_state=make_macro(),
    )
    expected = {
        "regime", "is_crisis", "consensus", "raw_consensus", "confidence",
        "is_override", "votes", "vote_count", "is_fallback", "disagree_layers",
        "layer_reliability", "structural_changes",
        "hmm_confirmed", "hmm_is_surrogate", "llm_is_stub", "checked_at",
    }
    assert expected.issubset(result.keys())


def test_dict_api_regime_valid():
    result = detect_regime(
        market_data=make_bull_calm_market(),
        hmm_features=make_bull_calm_hmm(),
        news_summary="テスト",
        macro_state=make_macro(),
    )
    assert result["regime"] in REGIME_LABELS


def test_dict_api_checked_at_isoformat():
    result = detect_regime(
        market_data=make_bull_calm_market(),
        hmm_features=make_bull_calm_hmm(),
        news_summary="テスト",
        macro_state=make_macro(),
    )
    assert isinstance(result["checked_at"], str)
    assert "T" in result["checked_at"]
    assert "+00:00" in result["checked_at"]


def test_dict_api_is_crisis_bool():
    result = detect_regime(
        market_data=make_bull_calm_market(),
        hmm_features=make_bull_calm_hmm(),
        news_summary="テスト",
        macro_state=make_macro(),
    )
    assert isinstance(result["is_crisis"], bool)


# ── Detection-only 担保 ───────────────────────────────────────────────────────

def test_no_forbidden_fields():
    result = run_regime_orchestrator(make_input())
    forbidden = {"order", "trade", "execute", "action"}
    assert set(vars(result)).isdisjoint(forbidden)


def test_no_side_effects_same_input():
    """同一入力を新規 Orchestrator で複数回呼び出しても regime が変わらない"""
    inp = make_input(run_date=date(2026, 5, 1))
    regimes = [run_regime_orchestrator(inp).regime for _ in range(5)]
    assert len(set(regimes)) == 1


def test_no_operation_layer_import():
    """Orchestrator が operation モジュールを直接 import していない"""
    import backend.engine.regime.regime_orchestrator as mod
    assert not hasattr(mod, "build_safe_mode_input")
    assert not hasattr(mod, "SafeModeInput")
    assert not hasattr(mod, "run_r1_routine")


def test_to_dict_is_not_none():
    """to_dict() は None を返さない（ファイル書き込みなし確認の副産物）"""
    result = run_regime_orchestrator(make_input())
    assert result.to_dict() is not None
