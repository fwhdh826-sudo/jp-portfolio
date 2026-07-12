"""
Regime Consensus — Card 3-4
Layer 3: 3レイヤー合議制レジーム判定。
Detection-only. No trades, no orders, no side effects.

Reference: docs/v13.3/07_v13.3_spec.md Section 3.4
Reference: docs/constitution/REGIME.md Section 3
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

# ── Constants ─────────────────────────────────────────────────────────────────

BASE_WEIGHTS: dict[str, float] = {
    "rule_based": 0.4,
    "hmm": 0.3,
    "llm": 0.3,
}

HMM_SURROGATE_WEIGHT: float = 0.1   # is_surrogate=True: 0.3 → 0.1
LLM_STUB_WEIGHT: float = 0.0        # is_stub=True: 0.3 → 0.0
LOW_CONFIDENCE_WEIGHT_FACTOR: float = 0.5
MIN_VOTE_COUNT: int = 2

REGIME_LABELS: tuple[str, ...] = (
    "bull_calm",
    "bull_volatile",
    "bear",
    "crisis",
    "uncertain",
)

# 3層投票では数学的に tie は発生しない（合計票数=3 で 2+2+2=6 は不可）。
# 4層以上への拡張に備えた予約定数。現在 compute_consensus からは参照しない（P1-A 解消）。
SAFER_ORDER: tuple[str, ...] = (
    "crisis",
    "bear",
    "uncertain",
    "bull_volatile",
    "bull_calm",
)

FALLBACK_REGIME: str = "uncertain"


# ── Input / Output dataclasses ────────────────────────────────────────────────

@dataclass
class ConsensusInput:
    rule_based_regime: str
    hmm_regime: str
    hmm_confidence: float
    hmm_is_surrogate: bool
    hmm_is_low_confidence: bool
    hmm_confirmed: bool
    llm_regime: str
    llm_confidence: float
    llm_is_stub: bool
    llm_is_low_confidence: bool
    llm_has_structural_change: bool
    llm_structural_changes: list[str]

    def __post_init__(self) -> None:
        for field, val in [
            ("rule_based_regime", self.rule_based_regime),
            ("hmm_regime", self.hmm_regime),
            ("llm_regime", self.llm_regime),
        ]:
            if val not in REGIME_LABELS:
                raise ValueError(f"Invalid regime in {field}: {val!r}")


@dataclass
class ConsensusResult:
    regime: str
    consensus: float                       # fraction of agreeing votes (e.g. 0.67 = 2/3)
    vote_count: int                        # number of layers that agreed on final regime
    votes: dict[str, str]                  # {"rule_based": "bull_calm", "hmm": "...", "llm": "..."}
    weighted_consensus: float              # sum of effective weights for winning regime
    effective_weights: dict[str, float]    # normalized weights after adjustments
    has_structural_change_override: bool
    structural_changes: list[str]
    is_fallback: bool                      # True when all 3 layers disagree (1+1+1)
    disagree_layers: list[str]             # layers that voted differently from final regime
    hmm_surrogate_adjusted: bool
    hmm_confirmed: bool
    checked_at: datetime

    def __post_init__(self) -> None:
        if self.regime not in REGIME_LABELS:
            raise ValueError(f"Invalid regime: {self.regime!r}")


# ── Public typed API ──────────────────────────────────────────────────────────

def compute_consensus(inp: ConsensusInput) -> ConsensusResult:
    """Typed interface: ConsensusInput → ConsensusResult."""
    checked_at = datetime.now(timezone.utc)
    votes = {
        "rule_based": inp.rule_based_regime,
        "hmm": inp.hmm_regime,
        "llm": inp.llm_regime,
    }

    # ── structural_change_override ────────────────────────────────────────────
    # Fires ONLY when LLM reports structural change AND is NOT a stub.
    # When llm_is_stub=True, override is suppressed even if structural_changes is non-empty.
    if inp.llm_has_structural_change and not inp.llm_is_stub:
        eff_weights = _compute_effective_weights(inp)
        disagree = [
            layer for layer, v in votes.items() if v != inp.llm_regime
        ]
        return ConsensusResult(
            regime=inp.llm_regime,
            consensus=1 / 3,
            vote_count=1,
            votes=votes,
            weighted_consensus=eff_weights["llm"],
            effective_weights=eff_weights,
            has_structural_change_override=True,
            structural_changes=inp.llm_structural_changes,
            is_fallback=False,
            disagree_layers=disagree,
            hmm_surrogate_adjusted=inp.hmm_is_surrogate,
            hmm_confirmed=inp.hmm_confirmed,
            checked_at=checked_at,
        )

    # ── Weight computation ────────────────────────────────────────────────────
    eff_weights = _compute_effective_weights(inp)

    # ── Majority vote (weighted) ──────────────────────────────────────────────
    regime_scores: dict[str, float] = {}
    for layer, label in votes.items():
        regime_scores[label] = regime_scores.get(label, 0.0) + eff_weights[layer]

    # Count raw votes (number of layers per regime, unweighted)
    vote_counts: dict[str, int] = {}
    for label in votes.values():
        vote_counts[label] = vote_counts.get(label, 0) + 1

    max_raw_votes = max(vote_counts.values())
    is_fallback = max_raw_votes < MIN_VOTE_COUNT

    if is_fallback:
        # All 3 layers disagree → fallback
        final_regime = FALLBACK_REGIME
    else:
        # Pick regime with highest weighted score among those with >= MIN_VOTE_COUNT raw votes
        candidates = {r: s for r, s in regime_scores.items() if vote_counts[r] >= MIN_VOTE_COUNT}
        final_regime = max(candidates, key=lambda r: candidates[r])

    final_vote_count = vote_counts.get(final_regime, 1)
    final_consensus = final_vote_count / 3.0
    final_weighted = regime_scores.get(final_regime, 0.0)

    disagree = [layer for layer, v in votes.items() if v != final_regime]

    return ConsensusResult(
        regime=final_regime,
        consensus=final_consensus,
        vote_count=final_vote_count,
        votes=votes,
        weighted_consensus=final_weighted,
        effective_weights=eff_weights,
        has_structural_change_override=False,
        structural_changes=inp.llm_structural_changes if inp.llm_has_structural_change and not inp.llm_is_stub else [],
        is_fallback=is_fallback,
        disagree_layers=disagree,
        hmm_surrogate_adjusted=inp.hmm_is_surrogate,
        hmm_confirmed=inp.hmm_confirmed,
        checked_at=checked_at,
    )


# ── Public dict API ───────────────────────────────────────────────────────────

def run_consensus(layer_results: dict) -> dict:
    """
    Layer 3 合議制 dict インターフェース。
    layer_results: {"rule_based": {...}, "hmm": {...}, "llm": {...}}
    checked_at は isoformat 文字列として返す。
    """
    rb = layer_results["rule_based"]
    hmm = layer_results["hmm"]
    llm = layer_results["llm"]

    inp = ConsensusInput(
        rule_based_regime=rb["regime"],
        hmm_regime=hmm["regime"],
        hmm_confidence=hmm["confidence"],
        hmm_is_surrogate=hmm["is_surrogate"],
        hmm_is_low_confidence=hmm["is_low_confidence"],
        hmm_confirmed=hmm.get("confirmed", False),
        llm_regime=llm["regime"],
        llm_confidence=llm["confidence"],
        llm_is_stub=llm["is_stub"],
        llm_is_low_confidence=llm["is_low_confidence"],
        llm_has_structural_change=llm["has_structural_change"],
        llm_structural_changes=llm["structural_changes"],
    )
    result = compute_consensus(inp)
    return {
        "regime": result.regime,
        "consensus": result.consensus,
        "vote_count": result.vote_count,
        "votes": result.votes,
        "weighted_consensus": result.weighted_consensus,
        "effective_weights": result.effective_weights,
        "has_structural_change_override": result.has_structural_change_override,
        "structural_changes": result.structural_changes,
        "is_fallback": result.is_fallback,
        "disagree_layers": result.disagree_layers,
        "hmm_surrogate_adjusted": result.hmm_surrogate_adjusted,
        "hmm_confirmed": result.hmm_confirmed,
        "checked_at": result.checked_at.isoformat(),
    }


# ── Internals ─────────────────────────────────────────────────────────────────

def _compute_effective_weights(inp: ConsensusInput) -> dict[str, float]:
    """
    BASE_WEIGHTS から調整:
    1. HMM surrogate → weight = HMM_SURROGATE_WEIGHT
    2. LLM stub → weight = LLM_STUB_WEIGHT (0.0)
    3. Low confidence → weight *= LOW_CONFIDENCE_WEIGHT_FACTOR
    4. Normalize to sum = 1.0
    """
    w = dict(BASE_WEIGHTS)

    if inp.hmm_is_surrogate:
        w["hmm"] = HMM_SURROGATE_WEIGHT
    if inp.llm_is_stub:
        w["llm"] = LLM_STUB_WEIGHT

    if inp.hmm_is_low_confidence:
        w["hmm"] *= LOW_CONFIDENCE_WEIGHT_FACTOR
    if inp.llm_is_low_confidence and not inp.llm_is_stub:
        w["llm"] *= LOW_CONFIDENCE_WEIGHT_FACTOR

    total = sum(w.values())
    if total == 0.0:
        # Edge case: all weights zeroed (e.g. only rule_based but also zeroed)
        return {k: 1.0 / len(w) for k in w}
    return {k: v / total for k, v in w.items()}
