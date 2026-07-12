"""
Phase 3 Shadow Mode — Card 3-7
Layer 3 (Regime Orchestrator) + Layer 4 (Universe/Size) の end-to-end 監査。
Detection-only. No trades, no orders, no file writes.

Reference: docs/v13.3/07_v13.3_spec.md Section 14.3
Reference: docs/constitution/REGIME.md

P1-F 方針 B (Card 3-7 採択):
  to_dict() の "consensus" キー名は維持する。
  override 時の consensus は display consensus（eff_weights["llm"]）として解釈する。
  UI 接続・regime_state 本番出力前に最終確定予定。
  乖離は ConsensusSemanticsAudit.semantics_diverge=True で記録する。

P1-E 対応:
  Shadow Mode では RegimeOrchestrator インスタンスを保持して .run() を呼ぶ。
  stateless convenience API (run_regime_orchestrator / detect_regime) は使わない。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from backend.engine.regime.llm_quality import LLMQualityInput, LLMQualityResult
from backend.engine.regime.regime_orchestrator import (
    OrchestratorInput,
    OrchestratorResult,
    OrchestratorState,
    RegimeOrchestrator,
)
from backend.engine.universe.size_segments import (
    SIZE_LABELS,
    SizeInput,
    SizeResult,
    classify_size_batch,
)


# ── Internal LLM mock ─────────────────────────────────────────────────────────

class _ShadowLLMMock:
    """Shadow Mode 専用 LLM モック。RegimeOrchestrator に inject する。"""
    def __init__(self, result: LLMQualityResult) -> None:
        self._result = result

    def detect(self, inp: LLMQualityInput) -> LLMQualityResult:
        return self._result


def _make_llm_stub(regime: str, confidence: float = 0.0) -> LLMQualityResult:
    """is_stub=True の LLM 結果（デフォルト LLMQualityDetector 相当）。"""
    return LLMQualityResult(
        regime=regime,
        confidence=confidence,
        structural_changes=[],
        is_llm=False,
        is_stub=True,
        is_low_confidence=True,
        primary_signal="news",
        has_structural_change=False,
        checked_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


def _make_llm_override(
    regime: str,
    confidence: float = 0.75,
    structural_changes: list[str] | None = None,
    is_low_confidence: bool = False,
) -> LLMQualityResult:
    """is_stub=False + structural_change あり（override 発動用）。"""
    sc = structural_changes if structural_changes is not None else ["geopolitical_risk"]
    return LLMQualityResult(
        regime=regime,
        confidence=confidence,
        structural_changes=sc,
        is_llm=True,
        is_stub=False,
        is_low_confidence=is_low_confidence,
        primary_signal="structural_change",
        has_structural_change=True,
        checked_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )


# ── Default stocks for size audit ─────────────────────────────────────────────
# Covers all 3 segments including both boundary values.

DEFAULT_STOCKS: list[SizeInput] = [
    SizeInput("SMALL_A",         100_000_000_000),  # small_cap
    SizeInput("MID_BOUND",       200_000_000_000),  # mid_cap  (= SMALL_CAP_THRESHOLD)
    SizeInput("MID_B",           500_000_000_000),  # mid_cap
    SizeInput("LARGE_BOUND",   1_000_000_000_000),  # large_cap (= LARGE_CAP_THRESHOLD)
    SizeInput("LARGE_C",       5_000_000_000_000),  # large_cap
]

EXPECTED_DEFAULT_SEGMENTS: list[str] = [
    "small_cap", "mid_cap", "mid_cap", "large_cap", "large_cap",
]


# ── Input dataclasses ─────────────────────────────────────────────────────────

@dataclass
class ShadowScenario:
    """
    Shadow Mode の監査シナリオ。

    llm_mock が None のとき、RegimeOrchestrator のデフォルト LLM（is_stub=True）が使われる。
    stocks が空のとき DEFAULT_STOCKS が使用される。

    expected_is_override / expected_is_fallback (P1-H):
      None  → assertion skip
      True  → must-be-True (Falseなら fail)
      False → must-be-False (Trueなら fail)
    """
    name: str
    market_data: dict
    hmm_features: dict
    news_summary: str
    macro_state: dict
    llm_mock: LLMQualityResult | None = None
    stocks: list[SizeInput] = field(default_factory=list)
    expected_regime: str = ""
    expected_is_crisis: bool = False
    expected_is_override: bool | None = None
    expected_is_fallback: bool | None = None


@dataclass
class ShadowAuditInput:
    scenarios: list[ShadowScenario]
    run_date: date | None = None


# ── Output dataclasses ────────────────────────────────────────────────────────

@dataclass
class ConsensusSemanticsAudit:
    """
    P1-F: override 時に consensus フィールドの意味論が乖離することを可視化・記録する。

    override=True のとき:
      raw_consensus     = 1/3 (ConsensusResult.consensus の生値)
      display_consensus = result.consensus = eff_weights["llm"] (表示用)
      semantics_diverge = True（両値が異なる場合）

    P1-F 方針 B（Card 3-7 採択）:
      "consensus" キーは維持。override 時は「display consensus」として解釈する。
      UI 接続・regime_state 本番出力前に最終確定する。
    """
    raw_consensus: float
    display_consensus: float    # = OrchestratorResult.consensus
    confidence: float
    is_override: bool
    semantics_diverge: bool     # True when is_override and raw != display


@dataclass
class ScenarioAuditResult:
    scenario_name: str
    regime_result: OrchestratorResult
    size_results: list[SizeResult]
    regime_assertion_passed: bool
    is_crisis_consistent: bool        # is_crisis == (regime == "crisis")
    is_fallback_asserted: bool        # expected_is_fallback=True → is_fallback=True
    is_override_asserted: bool        # expected_is_override=True → is_override=True
    layer_weights_ok: bool            # sum(effective_weight) ≈ 1.0
    surrogate_weight_reduced: bool    # HMM surrogate weight < rule_based weight
    stub_weight_zero: bool            # LLM stub → effective_weight ≈ 0.0
    size_labels_valid: bool           # all size_segment in SIZE_LABELS
    consensus_audit: ConsensusSemanticsAudit
    issues: list[str]

    @property
    def passed(self) -> bool:
        return len(self.issues) == 0 and self.regime_assertion_passed


@dataclass
class ShadowAuditResult:
    run_date: date
    checked_at: datetime
    scenarios_total: int
    scenarios_passed: int
    scenarios_failed: int
    p1_f_divergence_count: int      # override シナリオで semantics_diverge が発生した回数
    results: list[ScenarioAuditResult]
    issues_summary: list[str]


# ── Core audit engine ─────────────────────────────────────────────────────────

def run_shadow_audit(inp: ShadowAuditInput) -> ShadowAuditResult:
    """
    Phase 3 Shadow Mode 監査。Pure function — ファイル書き込みなし。

    ⚠️ P1-E 対応: シナリオごとに RegimeOrchestrator インスタンスを生成して .run() を呼ぶ。
      stateless convenience API（run_regime_orchestrator / detect_regime）は使用しない。
    """
    run_date = inp.run_date if inp.run_date is not None else date.today()
    results = [_audit_scenario(s, run_date) for s in inp.scenarios]

    passed = sum(1 for r in results if r.passed)
    p1f_count = sum(1 for r in results if r.consensus_audit.semantics_diverge)
    issues = [
        f"[{r.scenario_name}] {issue}"
        for r in results
        for issue in r.issues
    ]

    return ShadowAuditResult(
        run_date=run_date,
        checked_at=datetime.now(timezone.utc),
        scenarios_total=len(results),
        scenarios_passed=passed,
        scenarios_failed=len(results) - passed,
        p1_f_divergence_count=p1f_count,
        results=results,
        issues_summary=issues,
    )


def _audit_scenario(scenario: ShadowScenario, run_date: date) -> ScenarioAuditResult:
    """単一シナリオ監査。RegimeOrchestrator インスタンスを保持（P1-E 対応）。"""
    llm_detector = (
        _ShadowLLMMock(scenario.llm_mock) if scenario.llm_mock is not None else None
    )
    orchestrator = RegimeOrchestrator(
        state=OrchestratorState(),
        llm_detector=llm_detector,
    )
    orch_inp = OrchestratorInput(
        market_data=scenario.market_data,
        hmm_features=scenario.hmm_features,
        news_summary=scenario.news_summary,
        macro_state=scenario.macro_state,
        run_date=run_date,
    )
    rr = orchestrator.run(orch_inp)

    stocks = scenario.stocks if scenario.stocks else DEFAULT_STOCKS
    size_results = classify_size_batch(stocks)

    issues: list[str] = []

    # regime assertion
    regime_ok = True
    if scenario.expected_regime and rr.regime != scenario.expected_regime:
        regime_ok = False
        issues.append(
            f"regime: expected={scenario.expected_regime!r}, got={rr.regime!r}"
        )

    # is_crisis must always equal (regime == "crisis")
    crisis_ok = rr.is_crisis == (rr.regime == "crisis")
    if not crisis_ok:
        issues.append(
            f"is_crisis inconsistent: is_crisis={rr.is_crisis}, regime={rr.regime!r}"
        )

    # expected_is_crisis assertion
    if scenario.expected_is_crisis and not rr.is_crisis:
        issues.append(
            f"expected is_crisis=True but got False (regime={rr.regime!r})"
        )

    # expected_is_override assertion (P1-H: None=skip, True=must-True, False=must-False)
    override_ok = True
    if scenario.expected_is_override is not None:
        if rr.is_override != scenario.expected_is_override:
            override_ok = False
            issues.append(
                f"is_override: expected={scenario.expected_is_override}, got={rr.is_override}"
            )

    # expected_is_fallback assertion (P1-H: None=skip, True=must-True, False=must-False)
    fallback_ok = True
    if scenario.expected_is_fallback is not None:
        if rr.is_fallback != scenario.expected_is_fallback:
            fallback_ok = False
            issues.append(
                f"is_fallback: expected={scenario.expected_is_fallback}, got={rr.is_fallback}"
            )

    # layer_reliability: effective_weight sum ≈ 1.0
    weight_sum = sum(v["effective_weight"] for v in rr.layer_reliability.values())
    weights_ok = math.isclose(weight_sum, 1.0, abs_tol=1e-9)
    if not weights_ok:
        issues.append(f"layer weight sum != 1.0: got {weight_sum:.6f}")

    # HMM surrogate weight < rule_based weight (always true since HMM is always surrogate)
    hmm_w = rr.layer_reliability["hmm"]["effective_weight"]
    rb_w = rr.layer_reliability["rule_based"]["effective_weight"]
    surrogate_reduced = hmm_w < rb_w

    # LLM stub → effective_weight ≈ 0.0
    llm_w = rr.layer_reliability["llm"]["effective_weight"]
    stub_zero = (not rr.llm_is_stub) or math.isclose(llm_w, 0.0, abs_tol=1e-9)
    if not stub_zero:
        issues.append(f"LLM is_stub=True but effective_weight={llm_w:.6f} != 0.0")

    # size labels valid
    size_ok = all(r.size_segment in SIZE_LABELS for r in size_results)
    if not size_ok:
        bad = [r.size_segment for r in size_results if r.size_segment not in SIZE_LABELS]
        issues.append(f"invalid size labels: {bad}")

    # ── P1-F consensus semantics audit ────────────────────────────────────────
    raw_c = rr.raw_consensus
    disp_c = rr.consensus
    semantics_diverge = rr.is_override and not math.isclose(raw_c, disp_c, abs_tol=1e-9)

    consensus_audit = ConsensusSemanticsAudit(
        raw_consensus=raw_c,
        display_consensus=disp_c,
        confidence=rr.confidence,
        is_override=rr.is_override,
        semantics_diverge=semantics_diverge,
    )

    return ScenarioAuditResult(
        scenario_name=scenario.name,
        regime_result=rr,
        size_results=size_results,
        regime_assertion_passed=regime_ok,
        is_crisis_consistent=crisis_ok,
        is_fallback_asserted=fallback_ok,
        is_override_asserted=override_ok,
        layer_weights_ok=weights_ok,
        surrogate_weight_reduced=surrogate_reduced,
        stub_weight_zero=stub_zero,
        size_labels_valid=size_ok,
        consensus_audit=consensus_audit,
        issues=issues,
    )


# ── Predefined 7 scenarios ────────────────────────────────────────────────────

def make_default_scenarios() -> list[ShadowScenario]:
    """
    Phase 3 監査用 9 シナリオ。

    市場データは rule_based.py の閾値に基づいて構成:
      crisis:       vix > 40  or  sp500_dd < -0.20
      bear:         nikkei_60ma < nikkei_200ma  and  sp500_dd < -0.10
      bull_volatile: vix > 25  and  nikkei_5d > 0
      bull_calm:    vix < 18  and  nikkei_5d >= 0
      uncertain:    その他

    HMM 特徴量は hmm_detector.py の HMM_PROTOTYPES に基づいて構成:
      bull_calm:    (1.0, -1.0, -0.2, -0.5,  1.0)
      bear:        (-1.0,  0.8,  0.5,  0.5, -1.0)
      crisis:      (-2.5,  2.5,  2.5,  2.5, -2.0)
      bull_volatile:(0.5,  1.0,  0.8,  0.8,  0.0)
    """
    # ── market data ──────────────────────────────────────────────────────────
    bull_calm_mkt = {
        "vix": 15.0, "nikkei_5d_return": 0.02,
        "nikkei_60ma": 52000.0, "nikkei_200ma": 48000.0, "sp500_dd_30d": -0.02,
    }
    bear_mkt = {
        "vix": 22.0, "nikkei_5d_return": -0.02,
        "nikkei_60ma": 45000.0, "nikkei_200ma": 50000.0, "sp500_dd_30d": -0.15,
    }
    crisis_mkt = {
        "vix": 45.0, "nikkei_5d_return": -0.08,
        "nikkei_60ma": 40000.0, "nikkei_200ma": 50000.0, "sp500_dd_30d": -0.22,
    }
    bull_vol_mkt = {
        "vix": 27.0, "nikkei_5d_return": 0.03,
        "nikkei_60ma": 52000.0, "nikkei_200ma": 48000.0, "sp500_dd_30d": -0.04,
    }

    # ── HMM features (at prototypes) ─────────────────────────────────────────
    bull_calm_hmm = {
        "returns_5d": 1.0, "vix_log": -1.0, "volume_z": -0.2,
        "spread_high_low": -0.5, "sentiment": 1.0,
    }
    bear_hmm = {
        "returns_5d": -1.0, "vix_log": 0.8, "volume_z": 0.5,
        "spread_high_low": 0.5, "sentiment": -1.0,
    }
    crisis_hmm = {
        "returns_5d": -2.5, "vix_log": 2.5, "volume_z": 2.5,
        "spread_high_low": 2.5, "sentiment": -2.0,
    }
    bull_vol_hmm = {
        "returns_5d": 0.5, "vix_log": 1.0, "volume_z": 0.8,
        "spread_high_low": 0.8, "sentiment": 0.0,
    }

    # ── macro ─────────────────────────────────────────────────────────────────
    def macro(vix: float, ret: float = 0.02, usd: float = 150.0) -> dict:
        return {"vix": vix, "nikkei_5d_return": ret, "usdjpy": usd}

    return [
        # S1: bull_calm — 3層全一致（rule_based=bull_calm, HMM=bull_calm, LLM stub=bull_calm）
        # raw_consensus = 1.0 (3/3)
        ShadowScenario(
            name="S1_bull_calm_normal",
            market_data=bull_calm_mkt,
            hmm_features=bull_calm_hmm,
            news_summary="市場は安定しています。",
            macro_state=macro(15.0),
            llm_mock=_make_llm_stub("bull_calm"),
            expected_regime="bull_calm",
            expected_is_override=False,
            expected_is_fallback=False,
        ),

        # S2: bear — 2/3一致（rule_based=bear, HMM=bear, LLM stub=uncertain）
        # raw_consensus = 2/3
        ShadowScenario(
            name="S2_bear_two_thirds",
            market_data=bear_mkt,
            hmm_features=bear_hmm,
            news_summary="米国株安が続いています。リスクオフムード。",
            macro_state=macro(22.0, ret=-0.02, usd=140.0),
            llm_mock=_make_llm_stub("uncertain"),
            expected_regime="bear",
            expected_is_override=False,
            expected_is_fallback=False,
        ),

        # S3: crisis — 3層全一致（rule_based=crisis, HMM=crisis, LLM stub=crisis）
        # is_crisis=True
        ShadowScenario(
            name="S3_crisis_rule_based",
            market_data=crisis_mkt,
            hmm_features=crisis_hmm,
            news_summary="金融システムへの重大リスク。地政学的危機。",
            macro_state=macro(45.0, ret=-0.08, usd=130.0),
            llm_mock=_make_llm_stub("crisis"),
            expected_regime="crisis",
            expected_is_crisis=True,
            expected_is_override=False,
            expected_is_fallback=False,
        ),

        # S4: override — LLM structural_change_override (is_stub=False)
        # rule_based=bull_calm, HMM=bull_calm, LLM=bear(override)
        # P1-F: raw_consensus=1/3, consensus=eff_weights["llm"] → semantics_diverge=True
        ShadowScenario(
            name="S4_override_structural",
            market_data=bull_calm_mkt,
            hmm_features=bull_calm_hmm,
            news_summary="予期せぬ地政学的変動が発生。構造的変化の兆候。",
            macro_state=macro(15.0),
            llm_mock=_make_llm_override("bear", structural_changes=["geopolitical_risk"]),
            expected_regime="bear",
            expected_is_override=True,
            expected_is_fallback=False,
        ),

        # S5: fallback — 3層全不一致（rule_based=bull_calm, HMM=bear, LLM stub=crisis）
        # is_fallback=True → final_regime="uncertain"
        ShadowScenario(
            name="S5_fallback_all_disagree",
            market_data=bull_calm_mkt,
            hmm_features=bear_hmm,
            news_summary="市場シグナルが混在。方向感に欠ける。",
            macro_state=macro(15.0),
            llm_mock=_make_llm_stub("crisis"),
            expected_regime="uncertain",
            expected_is_override=False,
            expected_is_fallback=True,
        ),

        # S6: hmm_surrogate — HMM は常に is_surrogate=True（Card 3-X 実モデル待ち）
        # weight が BASE_WEIGHTS の 0.3 から 0.1 に削減されていることを確認
        ShadowScenario(
            name="S6_hmm_surrogate_weight",
            market_data=bull_vol_mkt,
            hmm_features=bull_vol_hmm,
            news_summary="ボラティリティ上昇中。上昇トレンドは継続。",
            macro_state=macro(27.0, ret=0.03, usd=148.0),
            llm_mock=_make_llm_stub("uncertain"),
            expected_regime="bull_volatile",
            expected_is_override=False,
            expected_is_fallback=False,
        ),

        # S7: llm_stub — LLM は bear に投票するが is_stub=True で weight=0
        # rule_based=bull_calm, HMM=bull_calm が 2/3 多数で勝つ
        ShadowScenario(
            name="S7_llm_stub_weight_zero",
            market_data=bull_calm_mkt,
            hmm_features=bull_calm_hmm,
            news_summary="市場は安定。LLM スタブは反対票を投じるが無視される。",
            macro_state=macro(15.0),
            llm_mock=_make_llm_stub("bear"),
            expected_regime="bull_calm",
            expected_is_override=False,
            expected_is_fallback=False,
        ),

        # S8: override_crisis — LLM override が crisis を強制（P1-G）
        # rule_based=bull_calm, HMM=bull_calm, LLM=crisis(override + financial_crisis)
        # is_override=True AND is_crisis=True の同時発生を確認
        # P1-F: raw_consensus=1/3, semantics_diverge=True（divergence_count=2 に加算）
        ShadowScenario(
            name="S8_override_crisis",
            market_data=bull_calm_mkt,
            hmm_features=bull_calm_hmm,
            news_summary="金融危機勃発。構造的変化が確認された。",
            macro_state=macro(15.0),
            llm_mock=_make_llm_override("crisis", structural_changes=["financial_crisis"]),
            expected_regime="crisis",
            expected_is_crisis=True,
            expected_is_override=True,
            expected_is_fallback=False,
        ),

        # S9: hmm_low_confidence — HMM 特徴量が bear と uncertain の中点（P1-I）
        # features at midpoint → softmax max_confidence ≈ 0.486 < LOW_CONFIDENCE_THRESHOLD 0.50
        # HMM effective_weight = 0.1 * 0.5 = 0.05 (通常 surrogate 0.1 の半分)
        # rule_based=bear, HMM=bear(is_low_confidence=True), LLM stub=uncertain → bear 2/3
        ShadowScenario(
            name="S9_hmm_low_confidence",
            market_data=bear_mkt,
            hmm_features={
                "returns_5d": -0.5, "vix_log": 0.4, "volume_z": 0.25,
                "spread_high_low": 0.25, "sentiment": -0.5,
            },
            news_summary="弱気な市場環境。シグナルは混在。",
            macro_state=macro(22.0, ret=-0.02, usd=140.0),
            llm_mock=_make_llm_stub("uncertain"),
            expected_regime="bear",
            expected_is_override=False,
            expected_is_fallback=False,
        ),
    ]


# ── Report formatter ──────────────────────────────────────────────────────────

def format_shadow_report(result: ShadowAuditResult) -> str:
    """
    Phase 3 Shadow Mode 監査レポートを str で返す。
    stdout 専用。ファイル書き込みなし。
    """
    sep = "=" * 72
    thin = "─" * 72
    lines: list[str] = [
        sep,
        "Phase 3 Shadow Mode Audit Report",
        f"run_date   : {result.run_date}",
        f"checked_at : {result.checked_at.isoformat()}",
        f"scenarios  : {result.scenarios_total} total  "
        f"{result.scenarios_passed} passed  {result.scenarios_failed} failed",
        sep,
    ]

    # ── P1-F Audit ────────────────────────────────────────────────────────────
    lines += [
        "",
        "P1-F Consensus Semantics Audit",
        thin,
        "  Policy B (Card 3-7): 'consensus' key in to_dict() is retained.",
        "  override=True  → consensus = display value (eff_weights['llm'])",
        "                   raw_consensus = vote fraction (always 1/3)",
        "  semantics_diverge=True flags the difference for downstream consumers.",
        "  Final semantics to be confirmed before UI / production regime_state output.",
        f"  Divergence events this run: {result.p1_f_divergence_count}",
        "",
        f"  {'Scenario':<32} {'override':<9} {'raw':>7} {'display':>9} {'conf':>7}  flag",
        f"  {'-'*32} {'-'*8} {'-'*7} {'-'*9} {'-'*7}  ----",
    ]
    for r in result.results:
        ca = r.consensus_audit
        flag = "*** DIVERGE ***" if ca.semantics_diverge else ""
        lines.append(
            f"  {r.scenario_name:<32} {str(ca.is_override):<9}"
            f" {ca.raw_consensus:>7.4f} {ca.display_consensus:>9.4f}"
            f" {ca.confidence:>7.4f}  {flag}"
        )

    # ── Scenario results ───────────────────────────────────────────────────────
    lines += ["", "Scenario Results", thin]
    for r in result.results:
        status = "PASS" if r.passed else "FAIL"
        rr = r.regime_result
        eff = {k: round(v["effective_weight"], 4) for k, v in rr.layer_reliability.items()}
        size_sum = {sr.ticker: sr.size_segment for sr in r.size_results}
        lines += [
            f"  [{status}] {r.scenario_name}",
            f"       regime={rr.regime!r:<16} is_crisis={rr.is_crisis}"
            f"  is_override={rr.is_override}  is_fallback={rr.is_fallback}",
            f"       votes={rr.votes}",
            f"       vote_count={rr.vote_count}  raw_consensus={rr.raw_consensus:.4f}"
            f"  consensus={rr.consensus:.4f}  confidence={rr.confidence:.4f}",
            f"       eff_weights={eff}",
            f"       size={size_sum}",
        ]
        for issue in r.issues:
            lines.append(f"       !! {issue}")

    # ── P1-D / P1-E notes ─────────────────────────────────────────────────────
    lines += [
        "",
        "P1-D / P1-E Notes",
        thin,
        "  P1-D: HMM 'confirmed' tracks call count, not calendar days.",
        "        Gap detection (skip days) must be implemented in persistence",
        "        layer (Card 3-8+) when OrchestratorState is persisted to disk.",
        "  P1-E: Shadow Mode uses RegimeOrchestrator instance per scenario.",
        "        Stateless APIs (run_regime_orchestrator / detect_regime) bypass",
        "        daily-once guard and are NOT used in Shadow Mode.",
    ]

    # ── Issues summary ─────────────────────────────────────────────────────────
    if result.issues_summary:
        lines += ["", "Issues", thin]
        for issue in result.issues_summary:
            lines.append(f"  !! {issue}")

    overall = "PASS" if result.scenarios_failed == 0 else "FAIL"
    lines += ["", sep, f"Overall: {overall}", sep]
    return "\n".join(lines)
