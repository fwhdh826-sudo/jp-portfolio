"""
Regime → Operation Wiring Bridge — Card 3-9
Phase 3 の regime_state.json から Operation Layer が必要な bool 値を読み出す最小 bridge。

責務:
  - read_is_crisis(path, default) : regime_state.json から is_crisis を読んで bool で返す

実装しないこと:
  - run_morning_routine の呼び出し（呼び出し側の責務）
  - build_safe_mode_input の呼び出し
  - public/data への書き込み
  - GitHub Actions wiring
  - Discord 実通知

使用例（呼び出し側パターン）:
    from backend.engine.operation.regime_wiring import read_is_crisis
    from backend.engine.operation.r1_morning import run_morning_routine

    crisis = read_is_crisis(Path("public/data/regime_state.json"))
    result = run_morning_routine(..., crisis_regime=crisis)

Reference: docs/constitution/REGIME.md (crisis → SAFE_MODE 自動発動)
Reference: backend/engine/operation/_routine_common.py (crisis_regime kwarg)
"""
from __future__ import annotations

import json
from pathlib import Path


def read_is_crisis(path: Path, default: bool = False) -> bool:
    """
    regime_state.json を読み、regime_state.is_crisis の値を bool で返す。

    以下の場合はすべて default を返す（例外を上げない）:
      - ファイル不在
      - JSON 破損
      - キー "regime_state" / "is_crisis" が存在しない

    Args:
        path    : regime_state.json のパス（tmp_path または public/data/regime_state.json）
        default : ファイル不在・破損時のフォールバック値（デフォルト False）

    Returns:
        bool — is_crisis の値。不明時は default。
    """
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return bool(data["regime_state"]["is_crisis"])
    except (FileNotFoundError, OSError, json.JSONDecodeError, KeyError, TypeError):
        return default
