"""
Regime Orchestrator — Card 3-5
Layer 3: Rule-Based / HMM / LLM / Consensus を統合する pure orchestration layer。
Detection-only. No trades, no orders, no side effects.

Stub 状態: LLM は is_stub=True 固定（Card 3-7 で実 LLM 接続予定）。
           HMM は is_surrogate=True 固定（Card 3-X で実モデル置換予定）。

Operation Layer 接続方針（Card 3-5 では接続しない）:
  crisis 検出後の接続例:
    build_safe_mode_input(..., crisis_regime=result.is_crisis)
  ただし実際の呼び出しは Phase 3 完了後の Operation 配線 Card で実施。

Reference: docs/v13.3/07_v13.3_spec.md Section 11.1
Reference: docs/constitution/REGIME.md Section 8
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Protocol, runtime_checkable

from backend.engine.regime.hmm_detector import HMMFeatureVector, HMMRegimeDetector, HMMResult
from backend.engine.regime.llm_quality import LLMQualityDetector, LLMQualityInput, LLMQualityResult
from backend.engine.regime.regime_consensus import ConsensusInput, compute_consensus
from backend.engine.regime.rule_based import detect_regime_rule_based

# ── Constants ─────────────────────────────────────────────────────────────────

REGIME_LABELS: tuple[str, ...] = (
    "bull_calm",
    "bull_volatile",
    "bear",
    "crisis",
    "uncertain",
)


# ── Protocol for LLM detector injection (enables test isolation) ──────────────

@runtime_checkable
class _LLMDetectorProtocol(Protocol):
    def detect(self, inp: LLMQualityInput) -> LLMQualityResult: ...


# ── Input dataclass ───────────────────────────────────────────────────────────

@dataclass
class OrchestratorInput:
    """
    Layer 3 統合入力。各レイヤーに必要な生データをそれぞれのフォーマットで保持する。

    market_data  : Rule-Based 用 raw data（z-score 化不要）
    hmm_features : HMM 用 z-score 済み 5特徴量
    news_summary : LLM 用ニュースサマリーテキスト
    macro_state  : LLM 用マクロ数値
    run_date     : daily-once guard 用の実行日（None → date.today()）
    """
    market_data: dict    # keys: vix, nikkei_5d_return, nikkei_60ma, nikkei_200ma, sp500_dd_30d
    hmm_features: dict   # keys: returns_5d, vix_log, volume_z, spread_high_low, sentiment
    news_summary: str
    macro_state: dict    # keys: vix, nikkei_5d_return, usdjpy
    run_date: date | None = None


# ── Output dataclass ──────────────────────────────────────────────────────────

@dataclass
class OrchestratorResult:
    """
    Layer 3 統合判定結果。

    consensus / raw_consensus / confidence の使い分け（P1-C 解消）:
      raw_consensus : ConsensusResult.consensus の生値。override 時でも 1/3 を保持。
      consensus     : 表示用 consensus。override 時は effective_weights["llm"] に上書き。
      confidence    : 最終信頼度。override 時は effective_weights["llm"] に上書き。
                      通常時は ConsensusResult.weighted_consensus。

    layer_reliability（P1-B 解消）:
      各レイヤーの effective_weight / is_stub / is_surrogate / is_low_confidence を並走させる。
      stub LLM (weight=0) が raw vote_count に寄与していることを UI/Orchestrator が把握可能。
    """
    # ── Core ──────────────────────────────────────────────────────────────
    regime: str
    is_crisis: bool          # regime == "crisis" (Operation Layer 注入用フラグ)

    # ── Consensus fields ──────────────────────────────────────────────────
    raw_consensus: float     # ConsensusResult.consensus の生値（override 時でも 1/3）
    consensus: float         # 表示用（override 時は eff_weights["llm"]）
    confidence: float        # 最終信頼度（override 時は eff_weights["llm"]）
    is_override: bool        # structural_change_override が発動したか

    # ── Vote details ──────────────────────────────────────────────────────
    votes: dict[str, str]    # {"rule_based": "...", "hmm": "...", "llm": "..."}
    vote_count: int
    is_fallback: bool
    disagree_layers: list[str]

    # ── Layer reliability（P1-B） ──────────────────────────────────────────
    layer_reliability: dict
    # 構造:
    # {
    #   "rule_based": {"effective_weight": float, "is_surrogate": False,  "is_stub": False, "is_low_confidence": False},
    #   "hmm":        {"effective_weight": float, "is_surrogate": bool,   "is_stub": False, "is_low_confidence": bool},
    #   "llm":        {"effective_weight": float, "is_surrogate": False,  "is_stub": bool,  "is_low_confidence": bool},
    # }

    # ── Structural changes ────────────────────────────────────────────────
    structural_changes: list[str]

    # ── Layer flags ───────────────────────────────────────────────────────
    hmm_confirmed: bool
    hmm_is_surrogate: bool
    llm_is_stub: bool

    # ── Snapshot and timing ───────────────────────────────────────────────
    market_data_snapshot: dict  # spec 11.1 市場データスナップショット
    run_date: date
    checked_at: datetime        # UTC datetime

    # ── Raw layer outputs（透過情報） ──────────────────────────────────────
    layer_results: dict  # {"rule_based": {...}, "hmm": {...}, "llm": {...}}

    def __post_init__(self) -> None:
        if self.regime not in REGIME_LABELS:
            raise ValueError(f"Invalid regime: {self.regime!r}")

    def to_dict(self) -> dict:
        """
        regime_state.json 相当の出力スキーマを生成する（dict のみ返す）。
        ファイル書き込みは行わない。spec: docs/v13.3/07_v13.3_spec.md Section 11.1
        regime_changed_at / previous_regime / duration_hours は
        Orchestrator 永続化層（Card 3-5 以降の範囲外）で設定予定。現在は None。
        """
        hmm_lr = self.layer_results.get("hmm", {})
        llm_lr = self.layer_results.get("llm", {})
        return {
            "regime_state": {
                "timestamp": self.checked_at.isoformat(),
                "current_regime": self.regime,
                "consensus": self.consensus,
                "raw_consensus": self.raw_consensus,
                "confidence": self.confidence,
                "is_override": self.is_override,
                "is_crisis": self.is_crisis,
                "votes": {
                    "rule_based": self.votes["rule_based"],
                    "hmm": [self.votes["hmm"], hmm_lr.get("confidence", 0.0)],
                    "llm": {
                        "regime": self.votes["llm"],
                        "confidence": llm_lr.get("confidence", 0.0),
                        "structural_changes": llm_lr.get("structural_changes", []),
                    },
                },
                "layer_reliability": self.layer_reliability,
                "structural_changes": self.structural_changes,
                "vote_count": self.vote_count,
                "is_fallback": self.is_fallback,
                "disagree_layers": self.disagree_layers,
                "hmm_confirmed": self.hmm_confirmed,
                "hmm_is_surrogate": self.hmm_is_surrogate,
                "llm_is_stub": self.llm_is_stub,
                "market_data_snapshot": self.market_data_snapshot,
                "run_date": self.run_date.isoformat(),
                "regime_changed_at": None,
                "previous_regime": None,
                "duration_hours": None,
            }
        }


# ── OrchestratorState (daily-once guard) ──────────────────────────────────────

@dataclass
class OrchestratorState:
    """
    インメモリ状態。daily-once guard 用。
    ディスク永続化は Card 3-5 以降のスコープ外（Operation 配線 Card で追加）。
    """
    last_run_date: date | None = None
    last_result: OrchestratorResult | None = None


# ── RegimeOrchestrator ────────────────────────────────────────────────────────

class RegimeOrchestrator:
    """
    Layer 3 統合 Orchestrator。

    検出パイプライン:
      OrchestratorInput
        → detect_regime_rule_based(market_data)       [Rule-Based]
        → HMMRegimeDetector.predict(hmm_features)     [HMM Surrogate]
        → LLMQualityDetector.detect(llm_input)        [LLM Quality]
        → compute_consensus(...)                       [Consensus]
        → OrchestratorResult

    daily-once guard:
      already_run_today() == True の場合、run() はキャッシュ結果をそのまま返す。
      HMMRegimeDetector の history も再更新しない（冪等性保持）。

    ⚠️ P1-D（Opus 4.7 review 2026-05-02）— カレンダー連続性は本層では保証しない:
      HMM の confirmed フラグは「直近 N 回の予測が同一か」のみを見ており、
      呼び出し間のカレンダー日数は考慮しない。Card 3-5 はインメモリ guard のため
      プロセス再起動で history がリセットされ、本問題は顕在化しない。
      Card 3-7 以降で OrchestratorState をディスク永続化する際は、
      gap detection（例: (today - last_run_date).days > 1 のとき HMM history を
      reset_history() で初期化）を Orchestrator 永続化層で実装すること。
      HMM 側仕様は変更しない（spec 確定済み）。

    detector injection:
      hmm_detector / llm_detector 引数でテスト用モックを注入可能。
    """

    def __init__(
        self,
        state: OrchestratorState | None = None,
        hmm_detector: HMMRegimeDetector | None = None,
        llm_detector: _LLMDetectorProtocol | None = None,
    ) -> None:
        self._state = state if state is not None else OrchestratorState()
        self._hmm: HMMRegimeDetector = hmm_detector if hmm_detector is not None else HMMRegimeDetector()
        self._llm: _LLMDetectorProtocol = llm_detector if llm_detector is not None else LLMQualityDetector()

    def already_run_today(self, run_date: date | None = None) -> bool:
        today = run_date if run_date is not None else date.today()
        return self._state.last_run_date == today

    def run(self, inp: OrchestratorInput) -> OrchestratorResult:
        today = inp.run_date if inp.run_date is not None else date.today()
        if self.already_run_today(today) and self._state.last_result is not None:
            return self._state.last_result
        result = self._execute(inp, today)
        self._state.last_run_date = today
        self._state.last_result = result
        return result

    def _execute(self, inp: OrchestratorInput, today: date) -> OrchestratorResult:
        # ── Rule-Based ─────────────────────────────────────────────────────────
        rb_result = detect_regime_rule_based(inp.market_data)

        # ── HMM Surrogate ──────────────────────────────────────────────────────
        features = HMMFeatureVector(
            returns_5d=inp.hmm_features["returns_5d"],
            vix_log=inp.hmm_features["vix_log"],
            volume_z=inp.hmm_features["volume_z"],
            spread_high_low=inp.hmm_features["spread_high_low"],
            sentiment=inp.hmm_features["sentiment"],
        )
        hmm_result: HMMResult = self._hmm.predict(features)

        # ── LLM Quality ────────────────────────────────────────────────────────
        llm_inp = LLMQualityInput(
            news_summary=inp.news_summary,
            vix=inp.macro_state["vix"],
            nikkei_5d_return=inp.macro_state["nikkei_5d_return"],
            usdjpy=inp.macro_state["usdjpy"],
        )
        llm_result: LLMQualityResult = self._llm.detect(llm_inp)

        # ── Regime Consensus ───────────────────────────────────────────────────
        consensus_inp = ConsensusInput(
            rule_based_regime=rb_result["regime"],
            hmm_regime=hmm_result.regime,
            hmm_confidence=hmm_result.confidence,
            hmm_is_surrogate=hmm_result.is_surrogate,
            hmm_is_low_confidence=hmm_result.is_low_confidence,
            hmm_confirmed=hmm_result.confirmed,
            llm_regime=llm_result.regime,
            llm_confidence=llm_result.confidence,
            llm_is_stub=llm_result.is_stub,
            llm_is_low_confidence=llm_result.is_low_confidence,
            llm_has_structural_change=llm_result.has_structural_change,
            llm_structural_changes=llm_result.structural_changes,
        )
        consensus_result = compute_consensus(consensus_inp)

        # ── P1-C: consensus / confidence の上書き ──────────────────────────────
        is_override = consensus_result.has_structural_change_override
        raw_consensus = consensus_result.consensus  # 常に生値（override 時 = 1/3）
        if is_override:
            # override 時: LLM が単独で final regime を決定。
            # 表示 consensus と confidence は LLM の実効 weight で表現（P1-C 解消）。
            # LLM is_low_confidence=True の場合は weight が小さく表示される（意図通り）。
            display_consensus = consensus_result.effective_weights["llm"]
            confidence = consensus_result.effective_weights["llm"]
        else:
            display_consensus = consensus_result.consensus
            confidence = consensus_result.weighted_consensus

        # ── P1-B: layer_reliability ────────────────────────────────────────────
        eff = consensus_result.effective_weights
        layer_reliability = {
            "rule_based": {
                "effective_weight": eff["rule_based"],
                "is_surrogate": False,
                "is_stub": False,
                "is_low_confidence": False,
            },
            "hmm": {
                "effective_weight": eff["hmm"],
                "is_surrogate": hmm_result.is_surrogate,
                "is_stub": False,
                "is_low_confidence": hmm_result.is_low_confidence,
            },
            "llm": {
                "effective_weight": eff["llm"],
                "is_surrogate": False,
                "is_stub": llm_result.is_stub,
                "is_low_confidence": llm_result.is_low_confidence,
            },
        }

        # ── market_data_snapshot (spec 11.1) ───────────────────────────────────
        md = inp.market_data
        market_data_snapshot = {
            "vix": md.get("vix"),
            "nikkei_5d_return": md.get("nikkei_5d_return"),
            "nikkei_60ma": md.get("nikkei_60ma"),
            "nikkei_200ma": md.get("nikkei_200ma"),
            "sp500_dd_30d": md.get("sp500_dd_30d"),
        }

        # ── Raw layer results (透過情報) ────────────────────────────────────────
        layer_results = {
            "rule_based": rb_result,
            "hmm": {
                "regime": hmm_result.regime,
                "confidence": hmm_result.confidence,
                "is_trained": hmm_result.is_trained,
                "is_surrogate": hmm_result.is_surrogate,
                "is_low_confidence": hmm_result.is_low_confidence,
                "confirmed": hmm_result.confirmed,
                "history": hmm_result.history,
            },
            "llm": {
                "regime": llm_result.regime,
                "confidence": llm_result.confidence,
                "is_stub": llm_result.is_stub,
                "is_low_confidence": llm_result.is_low_confidence,
                "has_structural_change": llm_result.has_structural_change,
                "structural_changes": llm_result.structural_changes,
            },
        }

        return OrchestratorResult(
            regime=consensus_result.regime,
            is_crisis=(consensus_result.regime == "crisis"),
            raw_consensus=raw_consensus,
            consensus=display_consensus,
            confidence=confidence,
            is_override=is_override,
            votes=consensus_result.votes,
            vote_count=consensus_result.vote_count,
            is_fallback=consensus_result.is_fallback,
            disagree_layers=consensus_result.disagree_layers,
            layer_reliability=layer_reliability,
            structural_changes=consensus_result.structural_changes,
            hmm_confirmed=hmm_result.confirmed,
            hmm_is_surrogate=hmm_result.is_surrogate,
            llm_is_stub=llm_result.is_stub,
            market_data_snapshot=market_data_snapshot,
            run_date=today,
            checked_at=datetime.now(timezone.utc),
            layer_results=layer_results,
        )


# ── Public APIs ───────────────────────────────────────────────────────────────

def run_regime_orchestrator(inp: OrchestratorInput) -> OrchestratorResult:
    """
    Convenience function: stateless — 毎回新規 RegimeOrchestrator を生成する。

    ⚠️ P1-E（Opus 4.7 review 2026-05-02）— daily-once guard は適用されない:
      本関数は呼び出しごとに新規 RegimeOrchestrator() を生成するため、
      OrchestratorState.last_run_date が常に None で始まり guard は無効化される。
      HMM の history も毎回リセットされ confirmed が立たない。

      Operation 配線・Shadow Mode（Card 3-7）等で daily-once guard を効かせたい場合は、
      RegimeOrchestrator インスタンスを保持して .run(inp) を呼ぶこと。

      使用ガイド:
        - テスト・単発検証 → run_regime_orchestrator() で OK
        - 永続化・本番運用 → RegimeOrchestrator インスタンス + run() を必須使用
    """
    return RegimeOrchestrator().run(inp)


def detect_regime(
    market_data: dict,
    hmm_features: dict,
    news_summary: str,
    macro_state: dict,
) -> dict:
    """
    Layer 3 統合レジーム判定（dict インターフェース）。
    checked_at は isoformat 文字列として返す。

    ⚠️ P1-E（Opus 4.7 review 2026-05-02）— daily-once guard は適用されない:
      内部で run_regime_orchestrator() を呼ぶため、毎回新規 Orchestrator が生成される。
      永続化・本番運用では RegimeOrchestrator インスタンスを直接保持して run() を呼ぶこと。
    """
    inp = OrchestratorInput(
        market_data=market_data,
        hmm_features=hmm_features,
        news_summary=news_summary,
        macro_state=macro_state,
    )
    result = run_regime_orchestrator(inp)
    return {
        "regime": result.regime,
        "is_crisis": result.is_crisis,
        "consensus": result.consensus,
        "raw_consensus": result.raw_consensus,
        "confidence": result.confidence,
        "is_override": result.is_override,
        "votes": result.votes,
        "vote_count": result.vote_count,
        "is_fallback": result.is_fallback,
        "disagree_layers": result.disagree_layers,
        "layer_reliability": result.layer_reliability,
        "structural_changes": result.structural_changes,
        "hmm_confirmed": result.hmm_confirmed,
        "hmm_is_surrogate": result.hmm_is_surrogate,
        "llm_is_stub": result.llm_is_stub,
        "checked_at": result.checked_at.isoformat(),
    }
