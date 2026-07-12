"""
regime_state.json Schema Generator — Card 3-8
Layer 3 → JSON: OrchestratorResult を regime_state.json 相当の dict に変換する。
Detection-only. No file writes. No Operation Routines connection. No shadow_mode import.

P1-F 方針B:
  "consensus" キー名は維持。override 時の値は display_consensus (eff_weights["llm"])。
  raw_consensus を共存。_metadata.p1f_consensus_semantics で乖離を可視化。

schema_version は "regime_state" dict 内に埋め込む。
_metadata は "regime_state" キーと並列に配置。

Reference: docs/v13.3/07_v13.3_spec.md Section 11.1
"""
from __future__ import annotations

from backend.engine.regime.regime_orchestrator import OrchestratorResult

SCHEMA_VERSION = "3.8"


def build_regime_state_dict(result: OrchestratorResult) -> dict:
    """
    OrchestratorResult から regime_state.json 相当の dict を生成する。

    Returns:
        {
            "regime_state": {
                "schema_version": "3.8",
                "timestamp": ...,
                "current_regime": ...,
                "consensus": ...,       # display_consensus (方針B: キー名維持)
                "raw_consensus": ...,   # vote 生値 (override 時でも 1/3)
                ...
            },
            "_metadata": {
                "p1f_consensus_semantics": {
                    "raw_consensus": float,
                    "display_consensus": float,
                    "confidence": float,
                    "is_override": bool,
                    "semantics_diverge": bool,
                }
            }
        }
    """
    regime_state = result.to_dict()["regime_state"]
    regime_state["schema_version"] = SCHEMA_VERSION

    # Override itself denotes display-vs-raw consensus semantic divergence:
    # when is_override=True, LLM alone determines final regime regardless of vote fraction,
    # so raw_consensus (1/3) and display_consensus (eff_weights["llm"]) always differ
    # semantically even if their float values happened to coincide under future weight changes.
    semantics_diverge = result.is_override

    return {
        "regime_state": regime_state,
        "_metadata": {
            "p1f_consensus_semantics": {
                "raw_consensus": result.raw_consensus,
                "display_consensus": result.consensus,
                "confidence": result.confidence,
                "is_override": result.is_override,
                "semantics_diverge": semantics_diverge,
            }
        },
    }
