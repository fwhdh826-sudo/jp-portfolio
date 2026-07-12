"""
OrchestratorState Disk Persistence + Gap Detection — Card 3-9
Layer 3 永続化補助層。OrchestratorResult の歴史フィールドを disk に保存し、
カレンダー gap detection を提供する。

責務:
  - PersistedOrchestratorState の JSON 読み書き（write_json_atomic 経由）
  - gap detection（calendar gap > 1 日の判定）
  - update_persisted_state（レジーム変化検出 + 履歴フィールド更新）
  - enrich_regime_state_dict（regime_changed_at / previous_regime / duration_hours 充足）

実装しないこと:
  - HMMRegimeDetector.reset_history() の呼び出し（gap reset は呼び出し側責務）
  - public/data への本番書き込み（テストは tmp_path のみ）
  - Operation Routines 接続
  - GitHub Actions wiring

Persistent file format (orchestrator_state.json):
  {
    "last_run_date": "2026-05-05" | null,
    "last_regime": "bull_calm" | null,
    "previous_regime": "bear" | null,
    "regime_changed_at": "2026-05-03T07:00:00+00:00" | null
  }

Reference: docs/v13.3/07_v13.3_spec.md Section 11.1
Reference: docs/constitution/REGIME.md Section 8 (gap detection)
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

from backend.engine.regime.regime_orchestrator import OrchestratorResult
from backend.engine.snapshot.phase3_snapshot import write_json_atomic


# ── PersistedOrchestratorState ────────────────────────────────────────────────

@dataclass
class PersistedOrchestratorState:
    """
    disk に永続化する Orchestrator 状態。

    OrchestratorResult オブジェクト本体は保存しない（再起動でリセット）。
    daily-once guard に必要な last_run_date と、regime_state.json の歴史フィールド
    充足に必要な履歴情報だけを保持する。
    """
    last_run_date: date | None = None        # daily-once guard 用
    last_regime: str | None = None           # 直前レジーム（変化検出用）
    previous_regime: str | None = None       # 1つ前のレジーム
    regime_changed_at: str | None = None     # 現レジームへの切替 UTC ISO 文字列


# ── Load / Save ───────────────────────────────────────────────────────────────

def load_persisted_state(path: Path) -> PersistedOrchestratorState:
    """
    orchestrator_state.json から PersistedOrchestratorState を読み込む。
    ファイル不在・ディレクトリ不在・JSON 破損時は全フィールド None のデフォルトを返す。
    """
    path = Path(path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return PersistedOrchestratorState()

    last_run_date_str: str | None = raw.get("last_run_date")
    last_run_date: date | None = (
        date.fromisoformat(last_run_date_str) if last_run_date_str else None
    )
    return PersistedOrchestratorState(
        last_run_date=last_run_date,
        last_regime=raw.get("last_regime"),
        previous_regime=raw.get("previous_regime"),
        regime_changed_at=raw.get("regime_changed_at"),
    )


def save_persisted_state(state: PersistedOrchestratorState, path: Path) -> None:
    """
    PersistedOrchestratorState を orchestrator_state.json へ原子的に書き込む。
    path の親ディレクトリは事前に存在していること。

    テストでは tmp_path 配下のみ使用。public/data への本番書き込みは呼び出し側が管理。
    """
    data = {
        "last_run_date": state.last_run_date.isoformat() if state.last_run_date else None,
        "last_regime": state.last_regime,
        "previous_regime": state.previous_regime,
        "regime_changed_at": state.regime_changed_at,
    }
    write_json_atomic(data, path)


# ── Gap Detection ─────────────────────────────────────────────────────────────

def compute_gap_days(last_run_date: date | None, today: date) -> int:
    """
    前回実行日から今日までのカレンダー日数差を返す。
    last_run_date が None（未実行）の場合は 0 を返す。
    """
    if last_run_date is None:
        return 0
    return (today - last_run_date).days


def needs_gap_reset(last_run_date: date | None, today: date) -> bool:
    """
    HMM history のリセットが必要かどうかを判定する。

    True  : calendar gap > 1 日（2日以上の断絶）
    False : 未実行（初回）/ 同日 / 隣接日（gap = 1）

    ⚠️ リセット自体（hmm_detector.reset_history()）はここでは行わない。
       呼び出し側が needs_gap_reset() == True を確認後、自己責任でリセットすること。
       （HMMRegimeDetector への依存を持たない設計）
    """
    return compute_gap_days(last_run_date, today) > 1


# ── State Update ──────────────────────────────────────────────────────────────

def update_persisted_state(
    prev: PersistedOrchestratorState,
    result: OrchestratorResult,
    today: date,
) -> PersistedOrchestratorState:
    """
    新しい OrchestratorResult から PersistedOrchestratorState を更新する。

    レジームが変化したとき（または初回実行時）:
      regime_changed_at = result.checked_at（UTC ISO）
      previous_regime   = prev.last_regime（変化前のレジーム）

    レジームが継続しているとき:
      regime_changed_at / previous_regime は前回値を引き継ぐ
    """
    new_regime = result.regime
    regime_changed = (prev.last_regime is None) or (new_regime != prev.last_regime)

    if regime_changed:
        return PersistedOrchestratorState(
            last_run_date=today,
            last_regime=new_regime,
            previous_regime=prev.last_regime,
            regime_changed_at=result.checked_at.isoformat(),
        )
    else:
        return PersistedOrchestratorState(
            last_run_date=today,
            last_regime=new_regime,
            previous_regime=prev.previous_regime,
            regime_changed_at=prev.regime_changed_at,
        )


# ── Enrich ────────────────────────────────────────────────────────────────────

def enrich_regime_state_dict(
    regime_dict: dict,
    state: PersistedOrchestratorState,
    now: datetime,
) -> dict:
    """
    build_regime_state_dict() の出力に歴史フィールドを充足する。

    OrchestratorResult.to_dict() では以下が None 固定だった:
      regime_changed_at / previous_regime / duration_hours

    この関数で PersistedOrchestratorState から値を埋める。

    Args:
        regime_dict : build_regime_state_dict() の戻り値
                      {"regime_state": {...}, "_metadata": {...}}
        state       : 更新済み PersistedOrchestratorState
        now         : duration_hours 計算の基準時刻（UTC datetime 推奨）

    Returns:
        同じ dict オブジェクト（in-place 更新して返す）
    """
    rs = regime_dict["regime_state"]
    rs["regime_changed_at"] = state.regime_changed_at
    rs["previous_regime"] = state.previous_regime

    if state.regime_changed_at is not None:
        try:
            changed_at = datetime.fromisoformat(state.regime_changed_at)
            # timezone-aware 同士で計算（UTC に統一）
            if changed_at.tzinfo is None:
                changed_at = changed_at.replace(tzinfo=timezone.utc)
            if now.tzinfo is None:
                now = now.replace(tzinfo=timezone.utc)
            hours = (now - changed_at).total_seconds() / 3600
            rs["duration_hours"] = round(hours, 2)
        except (ValueError, TypeError):
            rs["duration_hours"] = None
    else:
        rs["duration_hours"] = None

    return regime_dict
