"""
P4-A9d-1a: live regime_state.json generator

入力: public/data/market_intel.json (fallback: data/market_intel.json)
出力: data/regime_state.json + public/data/regime_state.json

schema: regime-state-1
kind:   live_regime_state (not sample_contract)
"""
from __future__ import annotations

import json
import math
import pathlib
import sys
from datetime import datetime, timezone
from typing import Any

# Standalone実行時に repo root を sys.path に追加する（pytest では conftest が解決済み）
_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

SCHEMA_VERSION = "regime-state-1"
GENERATOR = "data/update_regime_state.py"

VALID_REGIME_IDS: frozenset[str] = frozenset({
    "bull_calm",
    "bull_volatile",
    "bear",
    "crisis",
    "uncertain",
})

DEFAULT_MARKET_INTEL_PATHS = [
    pathlib.Path("public/data/market_intel.json"),
    pathlib.Path("data/market_intel.json"),
]

DEFAULT_OUTPUT_PATHS = [
    pathlib.Path("data/regime_state.json"),
    pathlib.Path("public/data/regime_state.json"),
]


# ---------------------------------------------------------------------------
# Market intel loader
# ---------------------------------------------------------------------------

def load_market_intel(
    paths: list[pathlib.Path] | None = None,
) -> tuple[dict[str, Any] | None, str]:
    """Try each path in order. Returns (data, source_path_str) or (None, 'not_found')."""
    if paths is None:
        paths = DEFAULT_MARKET_INTEL_PATHS
    for p in paths:
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data, str(p)
            except (json.JSONDecodeError, OSError):
                continue
    return None, "not_found"


# ---------------------------------------------------------------------------
# HMM feature derivation (z-score approximation from market_intel fields)
# ---------------------------------------------------------------------------

def build_hmm_features(intel: dict[str, Any]) -> dict[str, float]:
    """
    Derive approximate z-score HMM features from market_intel fields.

    Scaling rationale (matches HMM prototype space):
      returns_5d    : nikkei_5d_return / 0.025  (2.5%/5d ≈ 1 std)
      vix_log       : log(vix / 20.0) / 0.3     (log-VIX z-score, VIX 20 = baseline)
      volume_z      : 0.0  (not available from market_intel)
      spread_high_low: 0.0 (not available from market_intel)
      sentiment     : (sentiment_score - 50) / 25  (0-100 scale, 50 = neutral)
    """
    returns_5d_raw: float = float(intel.get("nikkei_5d_return", 0.0))
    vix_raw: float = float(intel.get("vix", 20.0))
    narrative = intel.get("narrative")
    sentiment_score: float = 50.0
    if isinstance(narrative, dict):
        raw_score = narrative.get("sentiment_score")
        if isinstance(raw_score, (int, float)):
            sentiment_score = float(raw_score)

    returns_5d = returns_5d_raw / 0.025
    vix_log = math.log(max(vix_raw, 1.0) / 20.0) / 0.3
    sentiment = (sentiment_score - 50.0) / 25.0

    return {
        "returns_5d": round(returns_5d, 4),
        "vix_log": round(vix_log, 4),
        "volume_z": 0.0,
        "spread_high_low": 0.0,
        "sentiment": round(sentiment, 4),
    }


def build_news_summary(intel: dict[str, Any]) -> str:
    """Extract narrative text from market_intel for LLM quality layer."""
    narrative = intel.get("narrative")
    if not isinstance(narrative, dict):
        return ""
    body_lines = narrative.get("body_lines")
    if isinstance(body_lines, list) and body_lines:
        return " ".join(str(line) for line in body_lines if line)
    headline = narrative.get("headline", "")
    return str(headline) if headline else ""


# ---------------------------------------------------------------------------
# Fallback output (when market_intel not found or engine fails)
# ---------------------------------------------------------------------------

def build_fallback_output(generated_at: str, reason: str) -> dict[str, Any]:
    """Build a safe uncertain fallback output (not sample_contract)."""
    return {
        "_meta": {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "live_regime_state",
            "not_for_trading": False,
            "generatedAt": generated_at,
            "source": "fallback",
            "fallback_reason": reason,
        },
        "regime_state": {
            "timestamp": generated_at,
            "current_regime": "uncertain",
            "consensus": 0.33,
            "raw_consensus": 0.33,
            "confidence": 0.0,
            "is_override": False,
            "is_crisis": False,
            "votes": {
                "rule_based": "uncertain",
                "hmm": ["uncertain", 0.0],
                "llm": {
                    "regime": "uncertain",
                    "confidence": 0.0,
                    "structural_changes": [],
                },
            },
            "layer_reliability": {
                "rule_based": {
                    "effective_weight": 0.33,
                    "is_surrogate": False,
                    "is_stub": False,
                    "is_low_confidence": True,
                },
                "hmm": {
                    "effective_weight": 0.33,
                    "is_surrogate": True,
                    "is_stub": False,
                    "is_low_confidence": True,
                },
                "llm": {
                    "effective_weight": 0.33,
                    "is_surrogate": False,
                    "is_stub": True,
                    "is_low_confidence": True,
                },
            },
            "structural_changes": [],
            "vote_count": 0,
            "is_fallback": True,
            "disagree_layers": [],
            "hmm_confirmed": False,
            "hmm_is_surrogate": True,
            "llm_is_stub": True,
            "market_data_snapshot": {
                "vix": None,
                "nikkei_5d_return": None,
                "nikkei_60ma": None,
                "nikkei_200ma": None,
                "sp500_dd_30d": None,
            },
            "run_date": generated_at[:10],
            "regime_changed_at": None,
            "previous_regime": None,
            "duration_hours": None,
        },
    }


# ---------------------------------------------------------------------------
# Main builder
# ---------------------------------------------------------------------------

def build_regime_state(
    intel: dict[str, Any],
    source: str,
    generated_at: str,
) -> dict[str, Any]:
    """Call backend regime engine with market_intel data. Returns full output dict."""
    from backend.engine.regime.regime_orchestrator import (
        OrchestratorInput,
        run_regime_orchestrator,
    )

    market_data = {
        "vix": float(intel["vix"]),
        "nikkei_5d_return": float(intel["nikkei_5d_return"]),
        "nikkei_60ma": float(intel["nikkei_60ma"]),
        "nikkei_200ma": float(intel["nikkei_200ma"]),
        "sp500_dd_30d": float(intel["sp500_dd_30d"]),
    }
    hmm_features = build_hmm_features(intel)
    news_summary = build_news_summary(intel)
    macro_state = {
        "vix": float(intel["vix"]),
        "nikkei_5d_return": float(intel["nikkei_5d_return"]),
        "usdjpy": float(intel.get("usdjpy", 150.0)),
    }

    inp = OrchestratorInput(
        market_data=market_data,
        hmm_features=hmm_features,
        news_summary=news_summary,
        macro_state=macro_state,
    )
    result = run_regime_orchestrator(inp)
    regime_dict = result.to_dict()

    return {
        "_meta": {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "live_regime_state",
            "not_for_trading": False,
            "generatedAt": generated_at,
            "source": source,
        },
        **regime_dict,
    }


# ---------------------------------------------------------------------------
# File writer
# ---------------------------------------------------------------------------

def write_outputs(
    output: dict[str, Any],
    output_paths: list[pathlib.Path] | None = None,
) -> None:
    if output_paths is None:
        output_paths = DEFAULT_OUTPUT_PATHS
    for p in output_paths:
        p.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  ✓ {p}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(
    market_intel_paths: list[pathlib.Path] | None = None,
    output_paths: list[pathlib.Path] | None = None,
) -> dict[str, Any]:
    generated_at = datetime.now(timezone.utc).isoformat()

    intel, source = load_market_intel(market_intel_paths)

    if intel is None:
        print("  ⚠ market_intel.json not found — uncertain fallback", file=sys.stderr)
        output = build_fallback_output(generated_at, "market_intel.json not found")
    else:
        try:
            output = build_regime_state(intel, source, generated_at)
        except Exception as exc:
            print(f"  ⚠ regime engine error: {exc} — uncertain fallback", file=sys.stderr)
            output = build_fallback_output(generated_at, f"engine error: {exc}")

    current_regime = output["regime_state"]["current_regime"]
    if current_regime not in VALID_REGIME_IDS:
        raise ValueError(f"Invalid current_regime: {current_regime!r}")

    write_outputs(output, output_paths)
    print(f"  regime: {current_regime}")
    print(f"  source: {output['_meta']['source']}")
    return output


if __name__ == "__main__":
    main()
