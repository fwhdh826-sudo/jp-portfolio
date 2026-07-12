"""
Phase 3 Snapshot Generator + Atomic Writer — Card 3-8
Layer 3+4 → JSON: regime_state + size_segments を一体化した snapshot dict を生成する。
本番書き込みは write_json_atomic(data, path) のみ使用可。
public/data/ への直接書き込みはテスト・本モジュール内では行わない。

atomic write: tmp ファイルに書き込んで rename — POSIX 原子性保証。

Reference: docs/v13.3/07_v13.3_spec.md Section 11 / 13
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from backend.engine.regime.regime_orchestrator import OrchestratorResult
from backend.engine.snapshot.regime_state_schema import build_regime_state_dict
from backend.engine.snapshot.size_segments_schema import build_size_segments_dict
from backend.engine.universe.size_segments import SizeResult

SCHEMA_VERSION = "3.8"


def write_json_atomic(data: dict, path: Path) -> None:
    """
    data を JSON として path に原子的に書き込む。

    tmp ファイルに書き込んで os.replace で rename する（POSIX 原子性）。
    path の親ディレクトリは事前に存在していること。
    """
    path = Path(path)
    dir_ = path.parent
    fd, tmp_path = tempfile.mkstemp(dir=dir_, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def build_phase3_snapshot(
    regime_result: OrchestratorResult,
    size_results: list[SizeResult],
    generated_at: datetime | None = None,
) -> dict:
    """
    Layer 3 (regime) + Layer 4 (size_segments) を結合した phase3_snapshot dict を生成する。

    Returns:
        {
            "phase3_snapshot": {
                "schema_version": "3.8",
                "generated_at": "...",
                "regime_state": {... regime_state fields ...},
                "size_segments": {... size_segments fields ...},
                "_metadata": {
                    "p1f_consensus_semantics": {...}
                }
            }
        }

    _metadata は phase3_snapshot dict 内で regime_state / size_segments キーと並列。
    schema_version は phase3_snapshot 直下に配置。
    """
    if generated_at is None:
        generated_at = datetime.now(timezone.utc)

    regime_dict = build_regime_state_dict(regime_result)
    size_dict = build_size_segments_dict(size_results, generated_at=generated_at)

    return {
        "phase3_snapshot": {
            "schema_version": SCHEMA_VERSION,
            "generated_at": generated_at.isoformat(),
            "regime_state": regime_dict["regime_state"],
            "size_segments": size_dict["size_segments"],
            "_metadata": regime_dict["_metadata"],
        }
    }
