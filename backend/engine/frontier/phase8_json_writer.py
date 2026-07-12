"""
phase8_json_writer.py — Card D（Scope B: writer 基盤のみ）
Phase 8 Frontier Engine: Phase 8 出力 JSON envelope ビルダー + atomic writer。

責務:
  - build_phase8_document()    — payload dict を `_meta` envelope で包む純変換
  - assert_json_serializable() — JSON serializable 検証（失敗時 TypeError）
  - write_json_atomic()        — explicit path への atomic write（tmp→os.replace）

Scope B（本 Card 範囲、P1-D1）:
  - writer 基盤のみ。public/data には **一切書かない**。
  - 実 JSON 出力・UI 接続・GitHub Actions 接続・Operation 層 caller は後続 Card。
  - 単体テストは pytest tmp_path のみ使用。public/ 配下に書かない。

Flat DI 設計（P1-D3）:
  Phase 8 dataclass（FrontierIndex / StrategyAggregateResult /
  OpportunityLossResult / FutureBranchingResult）を **直接 import しない**。
  caller が各 result の `.to_dict()` 出力（dict）を渡す前提。
  writer は payload を解釈せず、mutation もしない（deepcopy で snapshot 化）。

generated_at は caller 供給（P1-D4）:
  writer 内で datetime.now() を呼ばない。テスト決定論性・再現性を保つため
  ISO8601 文字列等を caller が渡す。writer は format 検証しない（非解釈方針）。

atomic write（P1-D5、recovery_log_writer.py 同型）:
  output_path.parent.mkdir(parents=True, exist_ok=True)
  tempfile.mkstemp(dir=output_path.parent, prefix=".tmp_", suffix=".json")
  json.dump(..., ensure_ascii=False, indent=2)
  os.replace(tmp, output_path)
  例外時 tmp unlink（partial write なし）
  explicit output_path 必須。デフォルトパスなし。

_meta 5 フィールド固定（P1-D6）:
  version / kind / source / generated_at / not_for_trading

設計原則:
  - stdlib-only（json / os / tempfile / copy / pathlib）
  - pandas / numpy / scipy 禁止
  - 実 HTTP / API / LLM 接続禁止
  - public/data への実書き込み禁止（本 Card）
  - 既存 contracts サンプル上書き禁止
  - src/types 同期・React UI 変更・GitHub Actions 変更禁止
  - Operation 層 caller 実装禁止（本 Card 範囲外）
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - ハードコード path（特に public/data）を持たない

P1 記録:
  P1-D1: Scope B writer 基盤のみ、public/data 非書き込み。
  P1-D2: 配置は backend/engine/frontier/phase8_json_writer.py。
  P1-D3: Flat DI。Phase 8 dataclass 非 import。
  P1-D4: generated_at は caller 供給。
  P1-D5: atomic write は recovery_log_writer.py 同型。
  P1-D6: _meta 5 フィールド固定、not_for_trading true。
  P1-D7: テストは tmp_path のみ、public/ 非書き込み。
  P1-D8: contracts schema reconcile は本 Card 範囲外。
  P1-D9: テスト件数 50〜70 件目安。

P2/P3 記録（後続 Card 候補）:
  P2-D1: Phase 8 .to_dict() ↔ src/types/*.ts ↔ Card 0-5 contracts schema reconcile。
  P2-D2: 実 public/data 配線（phase8/ namespace or 既存契約パス更新の判断）。
  P2-D3: Operation 層 caller 実装（writer を呼んで実 public/data に書く）。
  P2-D4: React UI を Phase 8 出力に配線。
  P2-D5: GitHub Actions に writer 実行を組み込む。
  P3-D1: 本番データ層と契約サンプル層の責務境界 README 整理。

Reference: backend/engine/operation/recovery_log_writer.py（atomic write 前例）
Reference: public/data/contracts/v13.3/README.md（sample_contract / not_for_trading）
Reference: handover.md "Card D Readiness Review" セクション
"""
from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Any


# ── 定数 ─────────────────────────────────────────────────────────────────────

_META_VERSION: str = "v13.3"
_META_NOT_FOR_TRADING: bool = True

# 許可される _meta.kind（allowlist）。Phase 8 の 4 出力種別に対応。
ALLOWED_KINDS: frozenset = frozenset({
    "frontier_index",
    "strategy_aggregate",
    "opportunity_loss",
    "future_branching",
})


# ── envelope builder（純変換）─────────────────────────────────────────────────


def build_phase8_document(
    payload: dict,
    kind: str,
    source: str,
    generated_at: str,
    payload_key: str,
) -> dict:
    """
    payload dict を `_meta` envelope で包んだ新規 dict を返す。

    payload は deepcopy で snapshot 化するため、呼び出し元 dict も
    返り値 document も相互に独立（payload を mutation しない、P1-D3）。

    Args:
        payload:      caller の `.to_dict()` 出力（dict 必須）
        kind:         ALLOWED_KINDS のいずれか
        source:       生成元の識別子（non-empty str、caller 供給）
        generated_at: 生成時刻（non-empty str、caller 供給。format は検証しない）
        payload_key:  payload を格納するトップキー（non-empty str）

    Returns:
        {
          "_meta": {version, kind, source, generated_at, not_for_trading},
          "<payload_key>": { ...payload deepcopy... }
        }

    Raises:
        TypeError:  payload が dict でない
        ValueError: kind が ALLOWED_KINDS 外 / payload_key・source・
                    generated_at が non-empty str でない
    """
    if not isinstance(payload, dict):
        raise TypeError(
            f"payload must be dict, got {type(payload).__name__}"
        )
    if kind not in ALLOWED_KINDS:
        raise ValueError(
            f"kind '{kind}' not in ALLOWED_KINDS {sorted(ALLOWED_KINDS)}"
        )
    if not isinstance(payload_key, str) or not payload_key:
        raise ValueError("payload_key must be a non-empty str")
    if not isinstance(source, str) or not source:
        raise ValueError("source must be a non-empty str")
    if not isinstance(generated_at, str) or not generated_at:
        raise ValueError("generated_at must be a non-empty str")

    return {
        "_meta": {
            "version": _META_VERSION,
            "kind": kind,
            "source": source,
            "generated_at": generated_at,
            "not_for_trading": _META_NOT_FOR_TRADING,
        },
        payload_key: copy.deepcopy(payload),
    }


# ── JSON serializable 検証 ────────────────────────────────────────────────────


def assert_json_serializable(data: Any) -> None:
    """
    data が JSON serializable か検証する。失敗時 TypeError。

    - dict / list / str / int / float / bool / None: OK
    - tuple: JSON 上 list になるため OK（例外なし）
    - set / 任意オブジェクト: TypeError

    json.dumps が TypeError / ValueError を投げた場合は TypeError に統一。
    """
    try:
        json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"data is not JSON serializable: {exc}") from exc


# ── atomic write helper ───────────────────────────────────────────────────────


def write_json_atomic(data: dict, output_path: Any) -> None:
    """
    data を output_path へ atomic に JSON 書き込みする。

    explicit output_path 必須（デフォルトパスなし、P1-D5）。
    serializable 検証を先に行うため、非 serializable 時は tmp を作らない。
    成功時 .tmp_* は残らない。失敗時 partial file / tmp は残らない。

    Args:
        data:        書き込む dict（JSON serializable であること）
        output_path: 書き込み先（Path | str。内部で Path 化）

    Raises:
        TypeError: data が JSON serializable でない（tmp 作成前に検出）
        その他 I/O 例外は tmp を unlink して re-raise
    """
    path = Path(output_path)

    # fail fast: serializable でなければ tmp を作らずに TypeError
    assert_json_serializable(data)

    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=".tmp_",
        suffix=".json",
    )
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
