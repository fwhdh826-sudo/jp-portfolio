#!/usr/bin/env python3
"""
JP株OS — Phase 8 public-data 生成スクリプト skeleton（C: 接続入口）
使用（将来 / 本 C では実行しない）: python3 data/update_phase8.py
出力（将来）: public/data/phase8/{frontier_index,strategy_aggregate,
              opportunity_loss,future_branching}.json

目的:
  input_orchestrator → orchestrate_phase8_public_data の接続入口。
  returns.json（P2-D5、yfinance 実）と sample_contract scores を読み、
  Phase 8 producer 群を assemble して public/data/phase8 へ write する
  駆動 entry。**本 C では script 作成のみ・本番実行しない**
  （public/data/phase8 実 write は別 Card、handover §9 No-Go 解除条件待ち。
  特に scores=sample_contract のまま commit 可否は user 判断待ち）。

hybrid honesty（handover §2）:
  returns=yfinance-real だが scores=sample_contract、cash_weight /
  regime_probabilities / expected_return_by_ticker は missing-safe default。
  → 出力は full generated ではなく **hybrid**。`_meta.kind` は adapter が
  出力種別固定（"frontier_index" 等）であり hybrid を入れる場所ではない。
  hybrid 性は **`_meta.source`（本 script 供給の provenance 文字列）+
  README/manifest（後続 D）** で表現する。

初の data → backend import script:
  data/update_*.py で backend を import する初の script。standalone 実行用
  に script 自身が repo root を sys.path へ追加し、`backend.engine.*` root
  import で統一する（conftest は pytest 用で standalone に効かない）。

設計原則:
  - 本 script の path read（returns.json / contract scores）は data 系
    生成 script の責務として許容（operation 層 Flat-DI no-path-read とは
    別レイヤ）
  - generated_at / strategy_aggregate_timestamp は timezone 付き ISO8601
    （data script は datetime 可。operation 層の datetime ban は非適用）
  - output_dir は引数化。__main__ default は public/data/phase8 だが
    C では実行しない（テストは tmp_path を渡す）
  - 実 HTTP / API / LLM 接続なし（returns_doc は parsed dict、compute は
    in-process。yfinance/requests/urllib を import しない）
  - BUY / SELL / HOLD / WAIT 禁止
  - action / recommendation / is_buy / is_sell / is_hold / is_recommended /
    verdict / decision / approve / reject / conditional / rating 禁止
  - rebalance_order / buy_amount / sell_amount / shares / quantity 禁止
  - 具体的な株数・金額・注文生成なし

Reference: backend/engine/operation/phase8_input_orchestrator.py
Reference: backend/engine/operation/phase8_compute_orchestrator.py
Reference: handover.md "public/data/phase8 実write Card Readiness 結果 /
           hybrid write 設計"
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

# 初の data → backend import。standalone 実行用に sys.path を解決する
# （冪等。pytest では conftest が既に追加済のため二重挿入しない）。
# script の explicit import は backend.engine.* root に統一するが、
# それらのモジュールは内部で engine.* root を transitive 参照する既存
# 二重 convention（producers/input_orchestrator=engine.*、orchestrator/
# caller=backend.engine.*）のため、repo root（→ backend.engine.*）と
# backend root（→ engine.*）の両方を sys.path へ追加する。
_REPO_ROOT = Path(__file__).resolve().parent.parent
_BACKEND_ROOT = _REPO_ROOT / "backend"
for _p in (str(_REPO_ROOT), str(_BACKEND_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from backend.engine.frontier.expected_return_model import (
    AssetMetaInput,
    ExpectedReturnInput,
    ExpectedReturnModel,
)
from backend.engine.operation.phase8_compute_orchestrator import (
    orchestrate_phase8_public_data,
)
from backend.engine.operation.phase8_input_orchestrator import (
    assemble_phase8_public_data_inputs,
)
from backend.engine.portfolio.jp_equity_pf_builder import (
    LOCK_DAYS as BACKEND_LOCK_DAYS,
    EquityHoldingInfo,
    EquityPfInput,
    JpEquityPfBuilder,
)
from backend.engine.regime.rule_based import detect_regime_rule_based

# default 出力先（将来 / GHA 用。C では実行しないため書き込まれない）。
DEFAULT_OUTPUT_DIR = _REPO_ROOT / "public" / "data" / "phase8"
RETURNS_JSON_PATH = _REPO_ROOT / "public" / "data" / "returns.json"
SCORES_CONTRACT_PATH = (
    _REPO_ROOT / "public" / "data" / "contracts" / "v13.3" / "scoring"
    / "stock_scores_6axis.json"
)

# scoring INPUT 公開先（D′ で CI bot により自動生成・update_scores.py
# 由来）。migration では本 path を優先し、不在/空/不正なら
# SCORES_CONTRACT_PATH へ fallback する
# （build_scores_from_scoring_or_contract 参照）。
SCORES_PUBLIC_PATH = (
    _REPO_ROOT / "public" / "data" / "scoring" / "stock_scores_6axis.json"
)

# Card C-2b: phase8 asset_meta reference（sector / size_segment /
# risk_flags / is_core / is_leveraged の手動 mapping）。C-2a で
# 作成済。update_phase8 が base_context に DI して frontier_strategy
# の SectorCapConstraint / size_premium / alpha_market を駆動する。
# missing / parse 失敗時は空 dict に degrade し旧挙動（全 sector=
# 'unknown' 集約・equal-weight fallback）に戻る（下方互換）。
ASSET_META_PATH = (
    _REPO_ROOT / "public" / "data" / "contracts" / "v13.3" / "universe"
    / "asset_meta_phase8.json"
)

# Card C-4a: holdings snapshot（手動更新の SBI 評価額。eval を正規化して
# Phase 8 opportunity_loss の current_pf として DI する）。
# live holdings ではなく snapshot proxy（last_updated 日付を provenance に
# 明示）。missing / parse 失敗時は空 dict に degrade し旧挙動
# （current_pf empty fallback）に戻る。
HOLDINGS_JSON_PATH = _REPO_ROOT / "public" / "data" / "holdings.json"

# Card C-4a: 前回コミット済 frontier_index.json を ideal_pf 入力として
# 読む（self-referential、1-run lag 許容）。本 script の OUTPUT でも
# あるが、INPUT としては前回 snapshot を参照する。missing 時は
# 空 dict に degrade（ideal_pf empty fallback）。
FRONTIER_INDEX_PATH = (
    _REPO_ROOT / "public" / "data" / "phase8" / "frontier_index.json"
)

# Card D2b: market_intel freshness 判定用パスと stale 閾値。
# stale_threshold_hours > 72h → stale_not_used と判定し、
# future_branching diagnostics に age を記録して uniform 維持を透明化。
MARKET_INTEL_JSON_PATH = _REPO_ROOT / "public" / "data" / "market_intel.json"
MARKET_INTEL_STALE_HOURS: float = 72.0

# hybrid provenance（_meta.source に渡す。full generated ではない明示）。
# 既存 sample_contract デフォルト文字列。migration 後の main() では
# derive_source_provenance(label) で動的 dispatch する（本定数は
# label="sample_contract" 時の値として温存）。
SOURCE_PROVENANCE: str = (
    "phase8_hybrid: returns=yfinance-real, scores=sample_contract, "
    "others=missing-safe-default"
)


def now_iso_tz() -> str:
    """timezone 付き ISO8601（UTC）。UI stale 判定の一貫性のため tz 付き。"""
    return datetime.now(timezone.utc).isoformat()


def read_returns_doc(path: Any) -> dict:
    """public/data/returns.json を parsed dict 化。欠損/不正は {}（捏造しない）。"""
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError):
        return {}
    return doc if isinstance(doc, dict) else {}


def build_scores_from_contract(path: Any) -> dict:
    """
    stock_scores_6axis.json → {ticker: {axis: {"total": float}}}。

    six_axis[axis]["total"] のみ抽出（rating(S/A/B/C/D) 等の判断ラベルは
    producer DI へ伝播しない）。欠損/不正は {}（捏造しない）。
    """
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError):
        return {}
    rows = doc.get("stock_scores_6axis") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        return {}
    scores: dict = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        ticker = row.get("ticker")
        six = row.get("six_axis")
        if not isinstance(ticker, str) or not isinstance(six, dict):
            continue
        axis_map: dict = {}
        for axis, body in six.items():
            if isinstance(body, dict) and "total" in body:
                try:
                    axis_map[str(axis)] = {"total": float(body["total"])}
                except (TypeError, ValueError):
                    continue
        if axis_map:
            scores[ticker] = axis_map
    return scores


def build_scores_from_scoring_or_contract(
    scoring_path: Any, contract_path: Any
) -> tuple[dict, str]:
    """
    public/data/scoring を優先・不在/空/不正なら contracts sample へ
    fallback。

    返り値: (scores_dict, provenance_label)
      - scoring_path から build_scores_from_contract 経由で読込 → 非空
        なら ({...}, "public_scoring")
      - 空（不在/不正/rows 空）なら contract_path を試行 → 非空なら
        ({...}, "sample_contract")
      - 双方空なら ({}, "missing")
    schema 互換性: build_scores_from_contract が両 path に同形（
    stock_scores_6axis list / row.six_axis[axis].total）を仮定。
    本関数自体は network 不要・pure compute（path read のみ）。
    """
    scores = build_scores_from_contract(scoring_path)
    if scores:
        return scores, "public_scoring"
    scores = build_scores_from_contract(contract_path)
    if scores:
        return scores, "sample_contract"
    return {}, "missing"


def derive_source_provenance(label: str) -> str:
    """
    scores source ラベル → _meta.source 用 hybrid provenance 文字列。

    label ∈ {"public_scoring", "sample_contract", "missing"} を期待。
    未知 label は missing と同等の fallback 文字列。phase8 出力の
    _meta.source に渡され、partial-real / hybrid 性質（full real /
    full generated ではない）を表現する。
    """
    if label == "public_scoring":
        return (
            "phase8_hybrid: returns=yfinance-real, "
            "scores=public_scoring, others=missing-safe-default"
        )
    if label == "sample_contract":
        return SOURCE_PROVENANCE
    return (
        "phase8_hybrid: returns=yfinance-real, "
        "scores=missing, others=missing-safe-default"
    )


def derive_source_provenance_v2(
    scores_label: str, *, asset_meta_present: bool
) -> str:
    """
    scores source ラベル + asset_meta 接続有無 → _meta.source 用 hybrid
    provenance 文字列（Card C-2b 拡張版）。

    既存 derive_source_provenance (v1) は test 後方互換 + 旧経路用に温存。
    main() は本 v2 を使用する。

    生成例:
      ("public_scoring", asset_meta_present=True)
        → "phase8_hybrid: returns=yfinance-real, scores=public_scoring, "
          "asset_meta=manual-mapping, others=missing-safe-default"
      ("public_scoring", asset_meta_present=False)
        → "phase8_hybrid: returns=yfinance-real, scores=public_scoring, "
          "asset_meta=missing, others=missing-safe-default"
    """
    parts: list[str] = ["returns=yfinance-real"]
    if scores_label == "public_scoring":
        parts.append("scores=public_scoring")
    elif scores_label == "sample_contract":
        parts.append("scores=sample_contract")
    else:
        parts.append("scores=missing")
    parts.append(
        "asset_meta=" + ("manual-mapping" if asset_meta_present else "missing")
    )
    parts.append("others=missing-safe-default")
    return "phase8_hybrid: " + ", ".join(parts)


MEAN_RETURN_LABEL_DEFAULT: str = "returns_yfinance_52w_annualized"

# Card D1a: regime scenario reference tables for Phase 8 future_branching DI.
#
# Source: backend/engine/strategies/frontier_strategy.py
#   _REGIME_EXPECTED_RETURN / _REGIME_EXPECTED_VOL / _REGIME_MAX_DD
# Static scenario table for Phase 8 hybrid observation, not prediction.
# 本テーブルは既存 frontier_strategy.py の Phase 7 fallback / Phase 8 max_dd
# reference として運用中の static SSOT を data 層に複製したものであり、
# 新規金融ロジック創作ではない（CLAUDE.md "新規創作禁止" 非該当）。
# REGIME.md §1 の 5 regime と整合。DRY 違反は P2 Card で backend 側
# regime_tables.py 抽出により解消予定。
# provenance label "regime_table=manual_regime_constitution_v13_3" で
# hybrid honesty を維持する（full real / full generated ではない）。
REGIME_EXPECTED_RETURNS_DEFAULT: dict = {
    "bull_calm":     0.090,
    "bull_volatile": 0.070,
    "bear":          0.030,
    "crisis":        0.010,
    "uncertain":     0.060,
}

REGIME_EXPECTED_VOLS_DEFAULT: dict = {
    "bull_calm":     0.120,
    "bull_volatile": 0.180,
    "bear":          0.200,
    "crisis":        0.300,
    "uncertain":     0.150,
}

REGIME_MAX_DDS_DEFAULT: dict = {
    "bull_calm":     -0.08,
    "bull_volatile": -0.15,
    "bear":          -0.20,
    "crisis":        -0.35,
    "uncertain":     -0.12,
}

# uniform 1/5: "regime probability is calculation-only, not a forecast"
# 思想に整合（FutureBranchingCalculator の P1-B11 uniform fallback と
# 同値だが、明示 DI することで diagnostic を消し provenance を透明化）。
# D2 Card で market_intel base 集中型 / 動的化を検討。
REGIME_PROBABILITIES_UNIFORM: dict = {
    "bull_calm":     0.2,
    "bull_volatile": 0.2,
    "bear":          0.2,
    "crisis":        0.2,
    "uncertain":     0.2,
}

REGIME_TABLE_LABEL_DEFAULT: str = "manual_regime_constitution_v13_3"

# Card D2c1: detected regime への集中度。
# rule_based 単層判定の信頼度として 0.60 を配分し、
# 残り 0.40 を他 4 regime に均等配分（0.10 × 4）する。
# 3 層合議制（REGIME.md §3）が完成するまでの暫定値。
DETECTED_REGIME_CONCENTRATION: float = 0.60


def build_concentrated_regime_probabilities(detected_regime: str) -> dict[str, float]:
    """
    detected_regime に DETECTED_REGIME_CONCENTRATION (0.60)、
    他 4 regime に均等配分（0.10 × 4）する probability dict を返す（pure）。

    detected_regime が REGIME_PROBABILITIES_UNIFORM のキー外 /
    空文字 / None の場合は uniform 1/5 の shallow copy を返す。

    既存 module 定数（REGIME_PROBABILITIES_UNIFORM 等）は変更しない。

    Returns:
        dict[str, float] — REGIME_PROBABILITIES_UNIFORM と同じキーセット、
        sum ≈ 1.0 (floating-point tolerance 以内)。
    """
    if (
        not isinstance(detected_regime, str)
        or detected_regime not in REGIME_PROBABILITIES_UNIFORM
    ):
        return dict(REGIME_PROBABILITIES_UNIFORM)
    non_detected = (1.0 - DETECTED_REGIME_CONCENTRATION) / (
        len(REGIME_PROBABILITIES_UNIFORM) - 1
    )
    return {
        r: (DETECTED_REGIME_CONCENTRATION if r == detected_regime else non_detected)
        for r in REGIME_PROBABILITIES_UNIFORM
    }


def build_regime_reference_tables() -> tuple:
    """
    regime scenario reference tables の shallow copy を 4 つ tuple で返す。

    pure function。各 dict は新規 shallow copy（呼出側 mutation が module
    定数を破壊しない）。Card D1a の future_branching DI 用。

    Returns:
        (regime_expected_returns,
         regime_expected_vols,
         regime_max_dds,
         regime_probabilities)
        いずれも CANONICAL_REGIMES の 5 key を含む dict[str, float]。
    """
    return (
        dict(REGIME_EXPECTED_RETURNS_DEFAULT),
        dict(REGIME_EXPECTED_VOLS_DEFAULT),
        dict(REGIME_MAX_DDS_DEFAULT),
        dict(REGIME_PROBABILITIES_UNIFORM),
    )


def assess_market_intel_freshness(
    path: Any = None,
    *,
    stale_threshold_hours: float = MARKET_INTEL_STALE_HOURS,
) -> tuple[str, str]:
    """
    market_intel.json の fetched_at を読み、鮮度を判定する。

    Returns (diagnostic_line, source_label).

    source_label:
      "fresh"             → age < 24h（diagnostic なし）
      "warn"              → 24h <= age < stale_threshold_hours
      "stale_not_used"    → age >= stale_threshold_hours
      "missing"           → ファイル不在 / fetched_at キーなし
      "timestamp_invalid" → parse 失敗

    diagnostic_line は "observation: " prefix（schema 整合）。
    regime_probabilities は変更しない（uniform 1/5 維持を明示するのみ）。
    market_intel の stale 値を計算に使用しない。
    """
    p = Path(path) if path is not None else MARKET_INTEL_JSON_PATH
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return (
            "observation: market_intel_missing; regime_probabilities kept uniform_1_5",
            "missing",
        )
    fetched_at = doc.get("fetched_at")
    if not isinstance(fetched_at, str) or not fetched_at:
        return (
            "observation: market_intel_missing; regime_probabilities kept uniform_1_5",
            "missing",
        )
    try:
        ts = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return (
            "observation: market_intel_timestamp_invalid; regime_probabilities kept uniform_1_5",
            "timestamp_invalid",
        )
    age_hours = (datetime.now(timezone.utc) - ts).total_seconds() / 3600.0
    if age_hours >= stale_threshold_hours:
        return (
            f"observation: market_intel_stale age_hours={age_hours:.1f}"
            f" threshold_hours={stale_threshold_hours:.0f};"
            " regime_probabilities kept uniform_1_5",
            "stale_not_used",
        )
    if age_hours >= 24.0:
        return (
            f"observation: market_intel_warn age_hours={age_hours:.1f};"
            " regime_probabilities kept uniform_1_5",
            "warn",
        )
    return (
        f"observation: market_intel_fresh age_hours={age_hours:.1f}",
        "fresh",
    )


# Card D2c2: rule_based 判定が要求する 5 マクロフィールド名。
# REGIME.md §2 / docs/v13.3/07_v13.3_spec.md §3.1 と整合（rule_based.py の
# RuleBasedInput と一致）。
_RULE_BASED_REQUIRED_FIELDS: tuple = (
    "vix",
    "nikkei_5d_return",
    "nikkei_60ma",
    "nikkei_200ma",
    "sp500_dd_30d",
)


def read_market_intel_for_regime(path: Any = None) -> dict | None:
    """
    market_intel.json から rule_based 判定に必要な 5 フィールドを float dict
    で返す（Card D2c2）。

    必須 5 フィールド: vix / nikkei_5d_return / nikkei_60ma / nikkei_200ma /
    sp500_dd_30d。

    file 不在 / JSON parse 失敗 / dict でない / 必須フィールド欠如 /
    非数値 / non-finite の場合は None を返す（捏造しない）。assess_
    market_intel_freshness とは独立に呼ぶ前提（freshness は別軸で判定済）。

    Returns:
        dict[str, float] — 全 5 フィールドが finite float で揃った場合
        None — そうでない場合
    """
    p = Path(path) if path is not None else MARKET_INTEL_JSON_PATH
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None
    out: dict[str, float] = {}
    for k in _RULE_BASED_REQUIRED_FIELDS:
        if k not in doc:
            return None
        raw = doc.get(k)
        if isinstance(raw, bool):
            return None
        try:
            f = float(raw)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(f):
            return None
        out[k] = f
    return out


LOCK_CALC_LABEL_DEFAULT: str = "purchase_date_days_since_purchase_utc"


def derive_source_provenance_v6(
    scores_label: str,
    *,
    asset_meta_present: bool,
    holdings_snapshot_label: str | None = None,
    mean_return_label: str | None = None,
    regime_table_label: str | None = None,
    lock_calc_label: str | None = None,
    market_intel_label: str | None = None,
) -> str:
    """
    scores / asset_meta / holdings / mean_return / regime_table /
    lock_calc provenance を含む _meta.source 用文字列（Card C-4c1
    拡張版）。

    既存 v1 / v2 / v3 / v4 / v5 は test 後方互換 / 旧経路用に温存。
    main() は本 v6 を使用する。

    lock_calc_label:
      - "purchase_date_days_since_purchase_utc" — holdings.json
        purchase_date から today(UTC) との days_since_purchase を計算し
        JpEquityPfBuilder LOCK_DAYS=91 で is_lock_period_active を判定
      - None / 空文字 → "lock_calc=missing"

    生成例:
      ("public_scoring", asset_meta_present=True,
       holdings_snapshot_label="public_holdings_snapshot_2026-04-06",
       mean_return_label="returns_yfinance_52w_annualized",
       regime_table_label="manual_regime_constitution_v13_3",
       lock_calc_label="purchase_date_days_since_purchase_utc")
        → "phase8_hybrid: returns=yfinance-real, scores=public_scoring, "
          "asset_meta=manual-mapping, "
          "holdings=public_holdings_snapshot_2026-04-06, "
          "mean_return=returns_yfinance_52w_annualized, "
          "regime_table=manual_regime_constitution_v13_3, "
          "lock_calc=purchase_date_days_since_purchase_utc, "
          "others=missing-safe-default"
    """
    parts: list[str] = ["returns=yfinance-real"]
    if scores_label == "public_scoring":
        parts.append("scores=public_scoring")
    elif scores_label == "sample_contract":
        parts.append("scores=sample_contract")
    else:
        parts.append("scores=missing")
    parts.append(
        "asset_meta=" + ("manual-mapping" if asset_meta_present else "missing")
    )
    if isinstance(holdings_snapshot_label, str) and holdings_snapshot_label:
        parts.append("holdings=" + holdings_snapshot_label)
    else:
        parts.append("holdings=missing")
    if isinstance(mean_return_label, str) and mean_return_label:
        parts.append("mean_return=" + mean_return_label)
    else:
        parts.append("mean_return=missing")
    if isinstance(regime_table_label, str) and regime_table_label:
        parts.append("regime_table=" + regime_table_label)
    else:
        parts.append("regime_table=missing")
    if isinstance(lock_calc_label, str) and lock_calc_label:
        parts.append("lock_calc=" + lock_calc_label)
    else:
        parts.append("lock_calc=missing")
    if isinstance(market_intel_label, str) and market_intel_label:
        parts.append("market_intel=" + market_intel_label)
    parts.append("others=missing-safe-default")
    return "phase8_hybrid: " + ", ".join(parts)


def derive_source_provenance_v7(
    scores_label: str,
    *,
    asset_meta_present: bool,
    holdings_snapshot_label: str | None = None,
    mean_return_label: str | None = None,
    regime_table_label: str | None = None,
    lock_calc_label: str | None = None,
    market_intel_label: str | None = None,
    regime_probabilities_label: str | None = None,
) -> str:
    """
    scores / asset_meta / holdings / mean_return / regime_table / lock_calc /
    market_intel / regime_probabilities provenance を含む _meta.source 用
    文字列（Card D2c2 拡張版）。

    既存 v1 / v2 / v3 / v4 / v5 / v6 は test 後方互換 / 旧経路用に温存。
    main() は本 v7 を使用する。

    regime_probabilities_label:
      - "rule_based_concentrated_0_60_<regime>" — market_intel fresh / warn で
        rule_based 単層判定成功時。detected_regime に 0.60 集中、他 4 regime
        に 0.10 × 4 分配（DETECTED_REGIME_CONCENTRATION）。
      - "uniform_1_5" — market_intel stale / missing / timestamp_invalid、
        または rule_based read 失敗 / detected invalid 時の safety fallback。
      - None / 空文字 → "regime_probabilities=uniform_1_5"（safety default）

    生成例:
      ("public_scoring", asset_meta_present=True,
       holdings_snapshot_label="public_holdings_snapshot_2026-04-06",
       mean_return_label="returns_yfinance_52w_annualized",
       regime_table_label="manual_regime_constitution_v13_3",
       lock_calc_label="purchase_date_days_since_purchase_utc",
       market_intel_label="fresh",
       regime_probabilities_label="rule_based_concentrated_0_60_bull_calm")
        → "phase8_hybrid: returns=yfinance-real, scores=public_scoring, "
          "asset_meta=manual-mapping, "
          "holdings=public_holdings_snapshot_2026-04-06, "
          "mean_return=returns_yfinance_52w_annualized, "
          "regime_table=manual_regime_constitution_v13_3, "
          "lock_calc=purchase_date_days_since_purchase_utc, "
          "market_intel=fresh, "
          "regime_probabilities=rule_based_concentrated_0_60_bull_calm, "
          "others=missing-safe-default"
    """
    parts: list[str] = ["returns=yfinance-real"]
    if scores_label == "public_scoring":
        parts.append("scores=public_scoring")
    elif scores_label == "sample_contract":
        parts.append("scores=sample_contract")
    else:
        parts.append("scores=missing")
    parts.append(
        "asset_meta=" + ("manual-mapping" if asset_meta_present else "missing")
    )
    if isinstance(holdings_snapshot_label, str) and holdings_snapshot_label:
        parts.append("holdings=" + holdings_snapshot_label)
    else:
        parts.append("holdings=missing")
    if isinstance(mean_return_label, str) and mean_return_label:
        parts.append("mean_return=" + mean_return_label)
    else:
        parts.append("mean_return=missing")
    if isinstance(regime_table_label, str) and regime_table_label:
        parts.append("regime_table=" + regime_table_label)
    else:
        parts.append("regime_table=missing")
    if isinstance(lock_calc_label, str) and lock_calc_label:
        parts.append("lock_calc=" + lock_calc_label)
    else:
        parts.append("lock_calc=missing")
    if isinstance(market_intel_label, str) and market_intel_label:
        parts.append("market_intel=" + market_intel_label)
    if isinstance(regime_probabilities_label, str) and regime_probabilities_label:
        parts.append("regime_probabilities=" + regime_probabilities_label)
    else:
        parts.append("regime_probabilities=uniform_1_5")
    parts.append("others=missing-safe-default")
    return "phase8_hybrid: " + ", ".join(parts)


def derive_source_provenance_v5(
    scores_label: str,
    *,
    asset_meta_present: bool,
    holdings_snapshot_label: str | None = None,
    mean_return_label: str | None = None,
    regime_table_label: str | None = None,
) -> str:
    """
    scores / asset_meta / holdings / mean_return / regime_table provenance
    を含む _meta.source 用文字列（Card D1a 拡張版）。

    既存 v1 / v2 / v3 / v4 は test 後方互換 / 旧経路用に温存。main() は
    本 v5 を使用する。

    regime_table_label:
      - "manual_regime_constitution_v13_3" — REGIME.md §1 整合の static
        scenario table（frontier_strategy._REGIME_EXPECTED_* と同値の
        data 層複製）。"predict" ではなく "scenario calculation"。
      - None / 空文字 → "regime_table=missing"

    生成例:
      ("public_scoring", asset_meta_present=True,
       holdings_snapshot_label="public_holdings_snapshot_2026-04-06",
       mean_return_label="returns_yfinance_52w_annualized",
       regime_table_label="manual_regime_constitution_v13_3")
        → "phase8_hybrid: returns=yfinance-real, scores=public_scoring, "
          "asset_meta=manual-mapping, "
          "holdings=public_holdings_snapshot_2026-04-06, "
          "mean_return=returns_yfinance_52w_annualized, "
          "regime_table=manual_regime_constitution_v13_3, "
          "others=missing-safe-default"
    """
    parts: list[str] = ["returns=yfinance-real"]
    if scores_label == "public_scoring":
        parts.append("scores=public_scoring")
    elif scores_label == "sample_contract":
        parts.append("scores=sample_contract")
    else:
        parts.append("scores=missing")
    parts.append(
        "asset_meta=" + ("manual-mapping" if asset_meta_present else "missing")
    )
    if isinstance(holdings_snapshot_label, str) and holdings_snapshot_label:
        parts.append("holdings=" + holdings_snapshot_label)
    else:
        parts.append("holdings=missing")
    if isinstance(mean_return_label, str) and mean_return_label:
        parts.append("mean_return=" + mean_return_label)
    else:
        parts.append("mean_return=missing")
    if isinstance(regime_table_label, str) and regime_table_label:
        parts.append("regime_table=" + regime_table_label)
    else:
        parts.append("regime_table=missing")
    parts.append("others=missing-safe-default")
    return "phase8_hybrid: " + ", ".join(parts)


def derive_source_provenance_v4(
    scores_label: str,
    *,
    asset_meta_present: bool,
    holdings_snapshot_label: str | None = None,
    mean_return_label: str | None = None,
) -> str:
    """
    scores / asset_meta / holdings / mean_return provenance を含む
    _meta.source 用文字列（Card C-4b1 拡張版）。

    既存 v1 / v2 / v3 は test 後方互換 / 旧経路用に温存。main() は本 v4
    を使用する。

    mean_return_label:
      - "returns_yfinance_52w_annualized" — returns.json 52w daily mean
        × 252 で年率化した proxy（真の 3y mean ではない）
      - None / 空文字 → "mean_return=missing"

    生成例:
      ("public_scoring", asset_meta_present=True,
       holdings_snapshot_label="public_holdings_snapshot_2026-04-06",
       mean_return_label="returns_yfinance_52w_annualized")
        → "phase8_hybrid: returns=yfinance-real, scores=public_scoring, "
          "asset_meta=manual-mapping, "
          "holdings=public_holdings_snapshot_2026-04-06, "
          "mean_return=returns_yfinance_52w_annualized, "
          "others=missing-safe-default"
    """
    parts: list[str] = ["returns=yfinance-real"]
    if scores_label == "public_scoring":
        parts.append("scores=public_scoring")
    elif scores_label == "sample_contract":
        parts.append("scores=sample_contract")
    else:
        parts.append("scores=missing")
    parts.append(
        "asset_meta=" + ("manual-mapping" if asset_meta_present else "missing")
    )
    if isinstance(holdings_snapshot_label, str) and holdings_snapshot_label:
        parts.append("holdings=" + holdings_snapshot_label)
    else:
        parts.append("holdings=missing")
    if isinstance(mean_return_label, str) and mean_return_label:
        parts.append("mean_return=" + mean_return_label)
    else:
        parts.append("mean_return=missing")
    parts.append("others=missing-safe-default")
    return "phase8_hybrid: " + ", ".join(parts)


def derive_source_provenance_v3(
    scores_label: str,
    *,
    asset_meta_present: bool,
    holdings_snapshot_label: str | None = None,
) -> str:
    """
    scores / asset_meta / holdings provenance を含む _meta.source 用文字列
    （Card C-4a 拡張版）。

    既存 v2 は test 互換 / 旧経路用に温存。main() は本 v3 を使用する。

    holdings_snapshot_label:
      - "public_holdings_snapshot_2026-04-06" 形式（holdings.last_updated
        ベース。last_updated 欠損時は "public_holdings_snapshot_unknown"）
      - None / 空文字 → "holdings=missing"

    生成例:
      ("public_scoring", asset_meta_present=True,
       holdings_snapshot_label="public_holdings_snapshot_2026-04-06")
        → "phase8_hybrid: returns=yfinance-real, scores=public_scoring, "
          "asset_meta=manual-mapping, "
          "holdings=public_holdings_snapshot_2026-04-06, "
          "others=missing-safe-default"
    """
    parts: list[str] = ["returns=yfinance-real"]
    if scores_label == "public_scoring":
        parts.append("scores=public_scoring")
    elif scores_label == "sample_contract":
        parts.append("scores=sample_contract")
    else:
        parts.append("scores=missing")
    parts.append(
        "asset_meta=" + ("manual-mapping" if asset_meta_present else "missing")
    )
    if isinstance(holdings_snapshot_label, str) and holdings_snapshot_label:
        parts.append("holdings=" + holdings_snapshot_label)
    else:
        parts.append("holdings=missing")
    parts.append("others=missing-safe-default")
    return "phase8_hybrid: " + ", ".join(parts)


def read_asset_meta_phase8(path: Any) -> dict:
    """
    asset_meta_phase8.json を parsed dict 化。欠損 / 不正は {}（捏造しない）。

    本 path は data 系生成 script の path-read 責務として許容（operation
    層 Flat-DI no-path-read とは別レイヤ）。
    """
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError):
        return {}
    return doc if isinstance(doc, dict) else {}


def split_asset_meta(doc: Any) -> tuple[dict, dict, dict]:
    """
    asset_meta_phase8 doc を 3 つの Phase 8 context dict に解体。

    Returns:
        (asset_meta_by_ticker, size_segment_by_ticker, risk_flags_by_ticker)

    各 dict のキー / 値は backend 側
    （frontier_strategy._compute_phase8 → ConstraintBuilder /
    ExpectedReturnModel）が期待する型に正規化する。

    asset_meta_by_ticker:
      {ticker: {"sector": str, "is_core": bool, "is_leveraged": bool}}
      ConstraintBuilder.SectorCapConstraint / GroupConstraint /
      SoftPenalty の T2 sector_cap / T5 core / T6 leverage を駆動。
    size_segment_by_ticker:
      {ticker: "large_cap" | "mid_cap" | "small_cap"}
      ExpectedReturnModel.size_premium（+0.000 / +0.005 / +0.012）を駆動。
    risk_flags_by_ticker:
      {ticker: {"is_risk_on": bool, "is_defensive": bool,
                "is_energy": bool, "is_overseas": bool}}
      ExpectedReturnModel.alpha_market（sentiment / keyword overlay）を駆動。

    欠損 / 不正は空 dict（捏造しない）。backend は missing 時
    sector="unknown" / size_segment="large_cap" / 全 flag=False に degrade。
    """
    if not isinstance(doc, dict):
        return {}, {}, {}
    body = doc.get("asset_meta_phase8", {})
    if not isinstance(body, dict):
        return {}, {}, {}
    by_ticker = body.get("by_ticker", {})
    if not isinstance(by_ticker, dict):
        return {}, {}, {}

    asset_meta_by_ticker: dict = {}
    size_segment_by_ticker: dict = {}
    risk_flags_by_ticker: dict = {}

    for t, v in by_ticker.items():
        if not isinstance(t, str) or not isinstance(v, dict):
            continue
        sector_raw = v.get("sector", "")
        asset_meta_by_ticker[t] = {
            "sector": (
                sector_raw if isinstance(sector_raw, str) and sector_raw
                else "unknown"
            ),
            "is_core":      bool(v.get("is_core",      False)),
            "is_leveraged": bool(v.get("is_leveraged", False)),
        }
        seg = v.get("size_segment", "")
        if isinstance(seg, str) and seg:
            size_segment_by_ticker[t] = seg
        rf = v.get("risk_flags", {})
        if isinstance(rf, dict):
            risk_flags_by_ticker[t] = {
                "is_risk_on":   bool(rf.get("is_risk_on",   False)),
                "is_defensive": bool(rf.get("is_defensive", False)),
                "is_energy":    bool(rf.get("is_energy",    False)),
                "is_overseas":  bool(rf.get("is_overseas",  False)),
            }
    return asset_meta_by_ticker, size_segment_by_ticker, risk_flags_by_ticker


def build_phase8_base_context(asset_meta_doc: Any) -> dict:
    """
    Phase 8 _compute_phase8 が読む base_context を組み立てる。

    input_orchestrator.assemble_phase8_public_data_inputs は base_context
    を mutation せず dict(safe_base) で複製してから returns_data を merge
    する（input_orchestrator P1-IO-3）。本関数は base_context として渡す
    dict を返すだけで副作用なし。

    asset_meta_doc が空 / 欠損 → 全 dict が空 → backend は missing-safe で
    旧挙動（全 sector='unknown' 集約）に degrade。下方互換を確保する。
    """
    am, seg, rf = split_asset_meta(asset_meta_doc)
    return {
        "asset_meta_by_ticker":   am,
        "size_segment_by_ticker": seg,
        "risk_flags_by_ticker":   rf,
    }


def read_holdings_doc(path: Any) -> dict:
    """
    public/data/holdings.json を parsed dict 化。欠損 / 不正は {}
    （捏造しない）。

    本 path は data 系生成 script の path-read 責務として許容。
    holdings.json は手動更新の SBI 評価額 snapshot（live ではない）。
    """
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError):
        return {}
    return doc if isinstance(doc, dict) else {}


def extract_holdings_snapshot_label(doc: Any) -> str:
    """
    holdings_doc → provenance label。

    doc.last_updated が ISO 風 str → "public_holdings_snapshot_<date>"
    欠損 → "public_holdings_snapshot_unknown"
    doc 全体が空 → "" (= derive_source_provenance_v3 が "holdings=missing"
    に degrade)
    """
    if not isinstance(doc, dict) or not doc:
        return ""
    raw = doc.get("last_updated")
    if isinstance(raw, str) and raw:
        return "public_holdings_snapshot_" + raw
    return "public_holdings_snapshot_unknown"


def build_current_pf_from_holdings(doc: Any) -> dict:
    """
    holdings.json → current_pf dict[ticker, weight]。

    holdings[].eval を合計で正規化する。code は str 化して ticker と
    して扱う。eval が None / NaN / inf / <=0 のエントリは寄与 0 として
    除外する。total <= 0 / holdings 空 / doc malformed は {} に degrade
    （OpportunityLossInput が "observation: current_pf is empty" を出す）。

    本 weight は live ではなく snapshot proxy（last_updated 日付を
    provenance に明示する）。

    Returns:
        dict[str, float] — sum to ~1.0、空 dict 許容（missing-safe）
    """
    if not isinstance(doc, dict):
        return {}
    holdings = doc.get("holdings")
    if not isinstance(holdings, list) or not holdings:
        return {}

    raw_evals: dict[str, float] = {}
    for entry in holdings:
        if not isinstance(entry, dict):
            continue
        code = entry.get("code")
        if not isinstance(code, str) or not code:
            try:
                code = str(code)
            except Exception:
                continue
            if not code:
                continue
        ticker = str(code)
        raw_eval = entry.get("eval")
        try:
            ev = float(raw_eval)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(ev) or ev <= 0.0:
            continue
        # 同一 ticker は最後の値で上書き（holdings.json は重複前提なし）
        raw_evals[ticker] = ev

    if not raw_evals:
        return {}
    total = sum(raw_evals.values())
    if total <= 0.0:
        return {}
    return {t: ev / total for t, ev in raw_evals.items()}


def read_frontier_index_doc(path: Any) -> dict:
    """
    public/data/phase8/frontier_index.json を parsed dict 化。欠損 /
    不正は {}（捏造しない）。

    本 path は run_phase8() の OUTPUT でもあるため self-referential。
    INPUT としては前回 commit 済 snapshot を参照する（1-run lag）。
    initial run / file 不在では {} に degrade し ideal_pf empty fallback。
    """
    p = Path(path)
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (ValueError, OSError):
        return {}
    return doc if isinstance(doc, dict) else {}


def build_ideal_pf_from_frontier_index(doc: Any) -> dict:
    """
    frontier_index.json → ideal_pf dict[ticker, weight]。

    payload.constituents から ticker→weight を抽出する。weight が None /
    NaN / inf / <0 のエントリは寄与 0 として除外する。total > 0 なら
    再正規化して sum 1.0 に揃える（既に 1.0 でも numerical drift 補正）。
    constituents 空 / doc malformed は {} に degrade
    （OpportunityLossInput が "observation: ideal_pf is empty" を出す）。

    Returns:
        dict[str, float] — sum to ~1.0、空 dict 許容（missing-safe）
    """
    if not isinstance(doc, dict):
        return {}
    payload = doc.get("payload")
    if not isinstance(payload, dict):
        return {}
    constituents = payload.get("constituents")
    if not isinstance(constituents, dict) or not constituents:
        return {}

    raw_weights: dict[str, float] = {}
    for k, v in constituents.items():
        ticker = str(k)
        if not ticker:
            continue
        try:
            w = float(v)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(w) or w < 0.0:
            continue
        raw_weights[ticker] = w

    if not raw_weights:
        return {}
    total = sum(raw_weights.values())
    if total <= 0.0:
        return {}
    return {t: w / total for t, w in raw_weights.items()}


def build_mean_return_proxy_from_returns(
    returns_doc: Any, ticker_normalize: bool = True
) -> dict:
    """
    returns.json → ticker 別 mean_return 年率 proxy（dict[str, float]）。

    52w 日次 return の平均を ×252 で年率化（mean_return_3y proxy）。
    52w sample のため真の 3y mean ではなく proxy。provenance には
    "mean_return=returns_yfinance_52w_annualized" を明示する。
    ticker_normalize=True で ".T" suffix を除去（universe / asset_meta
    と整合）。finite な return を 1 個以上含む ticker のみ採用する。
    return list が空 / 非 list / 全 NaN / 全 inf の ticker はエントリ
    なし（missing-safe degrade、捏造しない）。

    Returns:
        dict[str, float] — bare ticker → annualized mean。空 dict 許容。
    """
    if not isinstance(returns_doc, dict):
        return {}
    rmap = returns_doc.get("returns")
    if not isinstance(rmap, dict):
        return {}
    out: dict[str, float] = {}
    for raw_t, series in rmap.items():
        if not isinstance(series, list):
            continue
        ticker = str(raw_t)
        if ticker_normalize and ticker.endswith(".T"):
            ticker = ticker[:-2]
        if not ticker:
            continue
        finite_vals: list[float] = []
        for x in series:
            if isinstance(x, bool):
                continue
            try:
                v = float(x)
            except (TypeError, ValueError):
                continue
            if math.isfinite(v):
                finite_vals.append(v)
        if not finite_vals:
            continue
        daily_mean = sum(finite_vals) / len(finite_vals)
        annualized = daily_mean * 252.0
        if not math.isfinite(annualized):
            continue
        out[ticker] = annualized
    return out


def build_expected_return_by_ticker(
    returns_doc: Any,
    scores: Any,
    asset_meta_doc: Any,
    regime: str = "uncertain",
) -> dict:
    """
    ExpectedReturnModel を data 層で呼び ticker 別 expected_return を
    返す（Card C-4b1）。

    backend.engine.frontier.expected_return_model.ExpectedReturnModel の
    public API のみ使用（backend 無変更）。cross_axis_signals /
    market_intel は本 Card 範囲外（ExpectedReturnModel が "market_intel
    not provided" / "not found in cross_axis_signals" diagnostic で
    透明化）。

    mean_return_3y は build_mean_return_proxy_from_returns 由来の 52w
    年率 proxy（真の 3y mean ではない、provenance 明示）。

    universe / scores / asset_meta は ".T" suffix を除去した bare key
    に揃える（ExpectedReturnModel._calc_alpha_score の ticker lookup
    と整合）。

    Returns:
        dict[str, float] — bare ticker → expected_return。空 dict 許容
        （universe 空 / asset_meta 全欠損 / per_asset 全 NaN の場合）。
    """
    universe = derive_universe(returns_doc)
    if not universe:
        return {}

    mean_return_map = build_mean_return_proxy_from_returns(returns_doc)
    _am, size_segment_by_ticker, risk_flags_by_ticker = split_asset_meta(
        asset_meta_doc
    )

    # scores は ".T" key 形式（build_scores_from_contract 由来）。
    # ExpectedReturnModel は universe ticker（bare）で lookup するため
    # 同形に normalize する（".T" 末尾除去）。元 dict は mutation しない。
    safe_scores: dict = {}
    if isinstance(scores, dict):
        for raw_t, body in scores.items():
            t = str(raw_t)
            if t.endswith(".T"):
                t = t[:-2]
            if not t:
                continue
            safe_scores[t] = body

    assets: list = []
    for t in universe:
        seg_raw = size_segment_by_ticker.get(t, "large_cap")
        seg = seg_raw if isinstance(seg_raw, str) and seg_raw else "large_cap"
        flags = risk_flags_by_ticker.get(t, {})
        if not isinstance(flags, dict):
            flags = {}
        assets.append(AssetMetaInput(
            ticker=t,
            mean_return_3y=float(mean_return_map.get(t, 0.0)),
            size_segment=seg,
            is_risk_on=  bool(flags.get("is_risk_on",   False)),
            is_defensive=bool(flags.get("is_defensive", False)),
            is_energy=   bool(flags.get("is_energy",    False)),
            is_overseas= bool(flags.get("is_overseas",  False)),
        ))
    if not assets:
        return {}

    er_input = ExpectedReturnInput(
        assets=tuple(assets),
        six_axis_scores=safe_scores,
        cross_axis_signals={},
        regime=regime,
        market_intel=None,
    )
    er_result = ExpectedReturnModel().calculate(er_input)

    out: dict[str, float] = {}
    for a in er_result.per_asset:
        try:
            v = float(a.expected_return)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(v):
            continue
        out[a.ticker] = v
    return out


def compute_days_since_purchase(
    purchase_date_str: Any, today: date | None = None
) -> tuple:
    """
    purchase_date 文字列 (YYYY-MM-DD) と today から days_since_purchase を
    返す。Card C-4c1 で JpEquityPfBuilder に DI する。

    Returns:
        (days_since_purchase: int, status: str)
          status: "valid" / "missing" / "malformed"
          - missing  : None / 空文字 / 不在 → days = BACKEND_LOCK_DAYS
            (= unlocked sentinel)
          - malformed: parse 失敗 / future date → days = BACKEND_LOCK_DAYS
            (= unlocked sentinel) + diagnostic 対象
          - valid    : ISO YYYY-MM-DD で past date / today → (today - d).days

    unlocked sentinel 採用理由:
      「未入力 / 不正 = 制約計算上 unlocked」を機械的に表現
      （C-4c readiness review §2 推奨案 A）。
    """
    if today is None:
        today = datetime.now(timezone.utc).date()
    if not isinstance(purchase_date_str, str) or not purchase_date_str:
        return BACKEND_LOCK_DAYS, "missing"
    try:
        y_s, m_s, d_s = purchase_date_str.split("-")
        purchase = date(int(y_s), int(m_s), int(d_s))
    except (ValueError, TypeError):
        return BACKEND_LOCK_DAYS, "malformed"
    delta = (today - purchase).days
    if delta < 0:
        # future date → 不正扱い (unlocked sentinel)
        return BACKEND_LOCK_DAYS, "malformed"
    return delta, "valid"


def build_constrained_ideal_pf_via_lock(
    holdings_doc: Any,
    current_pf: Any,
    ideal_pf: Any,
    today: date | None = None,
) -> tuple:
    """
    holdings.json snapshot から purchase_date を読み取り、JpEquityPfBuilder
    の lock 制約を適用して constrained_ideal_pf を返す（Card C-4c1）。

    backend.engine.portfolio.jp_equity_pf_builder.JpEquityPfBuilder の
    既存 public API のみ使用（backend 無変更）。

    Args:
        holdings_doc: read_holdings_doc() の戻り値
        current_pf:   build_current_pf_from_holdings() の戻り値
                      (dict[bare_ticker, weight])
        ideal_pf:     build_ideal_pf_from_frontier_index() の戻り値
                      (dict[bare_ticker, weight])
        today:        lock 判定基準日 (UTC date)。None → datetime.now(UTC).date()

    Returns:
        (constrained_ideal_pf: dict[str, float],
         lock_diagnostics: list[str],
         lock_summary: dict[str, int])
        lock_summary は {"active": N, "expired": M, "valid": V, "missing": U,
                         "malformed": W} を返す。観察値として provenance 透明化用。

    missing-safe:
      - holdings_doc が空 / current_pf 空 → ideal_pf を pass-through、
        diagnostic で透明化 (旧 C-4a 経路と等価 degrade)
      - ideal_pf が空 → 空 dict pass-through
    """
    if today is None:
        today = datetime.now(timezone.utc).date()

    diagnostics: list[str] = []
    summary: dict[str, int] = {
        "active": 0, "expired": 0,
        "valid": 0, "missing": 0, "malformed": 0,
    }

    safe_ideal: dict = dict(ideal_pf) if isinstance(ideal_pf, dict) else {}

    if not isinstance(holdings_doc, dict) or not isinstance(current_pf, dict):
        diagnostics.append(
            "observation: holdings_doc or current_pf unavailable — "
            "constrained_ideal_pf falls back to ideal_pf "
            "(lock constraint not applied)"
        )
        return safe_ideal, diagnostics, summary

    if not current_pf or not safe_ideal:
        diagnostics.append(
            "observation: current_pf or ideal_pf empty — "
            "constrained_ideal_pf falls back to ideal_pf "
            "(lock constraint not applied)"
        )
        return safe_ideal, diagnostics, summary

    holdings_list = holdings_doc.get("holdings")
    if not isinstance(holdings_list, list) or not holdings_list:
        diagnostics.append(
            "observation: holdings list empty — constrained_ideal_pf "
            "falls back to ideal_pf (lock constraint not applied)"
        )
        return safe_ideal, diagnostics, summary

    # EquityHoldingInfo list 構築
    holding_infos: list = []
    seen_codes: set = set()
    for entry in holdings_list:
        if not isinstance(entry, dict):
            continue
        code_raw = entry.get("code")
        if not isinstance(code_raw, str) or not code_raw:
            continue
        ticker = str(code_raw)
        if ticker in seen_codes:
            continue
        seen_codes.add(ticker)
        cw = float(current_pf.get(ticker, 0.0))
        days, status = compute_days_since_purchase(
            entry.get("purchase_date"), today=today
        )
        summary[status] = summary.get(status, 0) + 1
        if status == "valid" and days < BACKEND_LOCK_DAYS:
            summary["active"] += 1
        else:
            summary["expired"] += 1
        holding_infos.append(EquityHoldingInfo(
            ticker=ticker,
            current_weight=cw,
            days_since_purchase=days,
        ))

    if not holding_infos:
        diagnostics.append(
            "observation: no valid holding rows in holdings.json — "
            "constrained_ideal_pf falls back to ideal_pf "
            "(lock constraint not applied)"
        )
        return safe_ideal, diagnostics, summary

    # equity_ideal_pf を tuple[tuple[str, float], ...] に整形
    equity_ideal_tuple: tuple = tuple(
        (t, float(w)) for t, w in safe_ideal.items()
    )

    pf_input = EquityPfInput(
        equity_ideal_pf=equity_ideal_tuple,
        current_holdings=tuple(holding_infos),
        regime="uncertain",
    )
    pf_result = JpEquityPfBuilder().build(pf_input)

    constrained: dict[str, float] = {
        t: float(w) for t, w in pf_result.constrained_ideal_pf
    }

    # builder 由来 diagnostic を継承
    for line in pf_result.diagnostics:
        diagnostics.append(str(line))

    # lock 計算メタ観察
    diagnostics.append(
        f"observation: lock_calc_date={today.isoformat()} UTC; "
        f"LOCK_DAYS={BACKEND_LOCK_DAYS}"
    )
    diagnostics.append(
        f"observation: {summary['active']} holding(s) observed as lock active "
        f"using purchase_date snapshot "
        f"(expired={summary['expired']}, "
        f"valid={summary['valid']}, missing={summary['missing']}, "
        f"malformed={summary['malformed']})"
    )
    if summary["missing"] > 0 or summary["malformed"] > 0:
        diagnostics.append(
            f"observation: {summary['missing'] + summary['malformed']} "
            "holding(s) without valid purchase_date treated as "
            "days_since_purchase=LOCK_DAYS (unlocked) — input data "
            "quality observation"
        )

    return constrained, diagnostics, summary


def derive_universe(returns_doc: Any, ticker_normalize: bool = True) -> tuple:
    """returns_doc['returns'] のキーから universe（normalize 後 bare）を導出。"""
    rmap = returns_doc.get("returns") if isinstance(returns_doc, dict) else None
    if not isinstance(rmap, dict):
        return ()
    out: list[str] = []
    for t in rmap.keys():
        s = str(t)
        if ticker_normalize and s.endswith(".T"):
            s = s[:-2]
        out.append(s)
    return tuple(out)


def run_phase8(
    *,
    returns_doc: dict,
    scores: dict,
    universe: Any,
    output_dir: Any,
    generated_at: str,
    source: str,
    strategy_aggregate_timestamp: str,
    regime: str = "uncertain",
    horizon: str = "long_term",
    base_context: Any = None,
    pf_weights: Any = None,
    current_pf: Any = None,
    ideal_pf: Any = None,
    constrained_ideal_pf: Any = None,
    expected_return_by_ticker: Any = None,
    expected_vol: float = 0.0,
    sharpe_ratio: float = 0.0,
    account_holdings: Any = None,
    cash_weight: float = 0.0,
    equity_constrained_pf: Any = None,
    fund_pf: Any = None,
    regime_expected_returns: Any = None,
    regime_expected_vols: Any = None,
    regime_expected_max_dds: Any = None,
    regime_probabilities: Any = None,
    downside_z_score: Any = None,
    ticker_normalize: bool = True,
) -> dict:
    """
    assemble_phase8_public_data_inputs → orchestrate_phase8_public_data を
    接続し、output_dir へ 4 JSON を書く。返り値は書込結果 + diagnostics。

    output_dir は呼出側が指定（tmp_path / public/data/phase8）。本 script は
    public/data/phase8 をハードコードで強制書き込みしない（C では tmp_path
    のみ）。
    """
    assembled = assemble_phase8_public_data_inputs(
        returns_doc=returns_doc,
        universe=universe,
        scores=scores,
        regime=regime,
        horizon=horizon,
        base_context=base_context,
        pf_weights=pf_weights,
        current_pf=current_pf,
        ideal_pf=ideal_pf,
        constrained_ideal_pf=constrained_ideal_pf,
        expected_return_by_ticker=expected_return_by_ticker,
        expected_vol=expected_vol,
        sharpe_ratio=sharpe_ratio,
        account_holdings=account_holdings,
        cash_weight=cash_weight,
        equity_constrained_pf=equity_constrained_pf,
        fund_pf=fund_pf,
        regime_expected_returns=regime_expected_returns,
        regime_expected_vols=regime_expected_vols,
        regime_expected_max_dds=regime_expected_max_dds,
        regime_probabilities=regime_probabilities,
        downside_z_score=downside_z_score,
        ticker_normalize=ticker_normalize,
    )

    written = orchestrate_phase8_public_data(
        output_dir=output_dir,
        generated_at=generated_at,
        source=source,
        frontier_index_raw=assembled.get("frontier_index_raw"),
        frontier_cash_pct=assembled.get("frontier_cash_pct") or 0.0,
        frontier_fund_pct=assembled.get("frontier_fund_pct") or 0.0,
        strategy_aggregate_raw=assembled.get("strategy_aggregate_raw"),
        strategy_aggregate_timestamp=strategy_aggregate_timestamp,
        strategy_outputs=assembled.get("strategy_outputs"),
        dd10_uniform_return=assembled.get("dd10_uniform_return"),
        opportunity_loss_raw=assembled.get("opportunity_loss_raw"),
        future_branching_raw=assembled.get("future_branching_raw"),
    )

    return {
        "written": {k: str(v) for k, v in written.items()},
        "resolver_diagnostics": list(
            assembled.get("resolver_diagnostics", [])
        ),
        "diagnostics": list(assembled.get("diagnostics", [])),
    }


def main(output_dir: Any = DEFAULT_OUTPUT_DIR) -> dict:
    """
    将来 / GHA 用 entry。C では実行しない（public/data/phase8 実 write は
    別 Card、handover §9 解除条件待ち）。

    Card C-2b で asset_meta_phase8.json を base_context に DI する経路を
    追加。missing 時は空 dict で旧挙動に degrade（下方互換）。

    Card C-4a で holdings.json snapshot から current_pf、前回 commit 済
    frontier_index.json から ideal_pf を読み、opportunity_loss の weight
    drift を非ゼロ化する経路を追加。purchase_date 欠如のため lock 制約は
    本 Card 範囲外（constrained_ideal_pf = ideal_pf として degrade、
    constraint_return_gap = 0.0）。

    Card C-4b1 で ExpectedReturnModel を data 層で呼び ticker 別
    expected_return を構成して run_phase8 に渡す経路を追加。mean_return_3y
    は returns.json 52w daily mean × 252 の年率 proxy（真の 3y mean では
    ない、provenance "mean_return=returns_yfinance_52w_annualized" で
    透明化）。これにより opportunity_loss の drift_return_gap /
    estimated_opportunity_return_gap が非ゼロ化する。constraint_return_gap
    は lock 制約未接続のため 0.0 のまま。cross_axis_signals / market_intel
    は本 Card 範囲外。

    Card D1a で REGIME.md §1 整合の static regime scenario tables
    （frontier_strategy._REGIME_EXPECTED_* と同値の data 層複製）と
    uniform 1/5 regime_probabilities を future_branching に DI する経路を
    追加。base_regime は "uncertain" 固定（D2 Card で market_intel 由来
    動的化）。これにより future_branching の weighted_expected_return /
    vol / worst_case_dd が非ゼロ化する。新規金融ロジックの創作ではなく
    既存 SSOT の複製であり provenance "regime_table=
    manual_regime_constitution_v13_3" で透明化。missing / parse 失敗時は
    None pass-through で旧挙動（empty fallback）に degrade。

    Card C-4c1 で purchase_date + 3ヶ月 lock 制約を constrained_ideal_pf
    に反映する経路を追加。holdings.json snapshot から purchase_date を
    読み、today(UTC) との days_since_purchase を計算し、既存
    JpEquityPfBuilder (LOCK_DAYS=91) を data 層で呼ぶ。constrained_ideal_pf
    は ideal_pf 直渡しから builder 出力に切替。これにより opportunity_loss
    の constraint_return_gap が non-zero 化する。lock 観察 diagnostic は
    既存 opportunity_loss diagnostics に追加され、provenance "lock_calc=
    purchase_date_days_since_purchase_utc" で透明化。backend / src は無変更
    （既存 builder の public API 利用のみ）。

    Card D2b で market_intel.json の fetched_at を調べ、stale / missing /
    timestamp_invalid の場合に future_branching diagnostics へ観察文を追記。
    regime_probabilities は変更しない（uniform 1/5 維持）。market_intel の
    stale 値を計算に使用しない。_meta.source に market_intel=stale_not_used
    等を追加し、provenance を透明化する。

    Card D2c2 で market_intel が fresh / warn の場合のみ rule_based 単層
    regime 判定を行い、detected_regime に 0.60 集中・他 4 regime に 0.10 ×
    4 分配した regime_probabilities を future_branching に DI する。stale /
    missing / timestamp_invalid、または rule_based read 失敗 / detected
    invalid の場合は uniform 1/5 を維持し、_meta.source の
    regime_probabilities= で透明化する。base_regime は本 Card 範囲外
    （"uncertain" 固定。regime cascade は別 Card で扱う）。rule_based 検出
    成功時は future_branching diagnostics 先頭に "rule_based regime
    detected ..." 観察文を prepend する。
    """
    returns_doc = read_returns_doc(RETURNS_JSON_PATH)
    scores, _scores_label = build_scores_from_scoring_or_contract(
        SCORES_PUBLIC_PATH,
        SCORES_CONTRACT_PATH,
    )
    asset_meta_doc = read_asset_meta_phase8(ASSET_META_PATH)
    base_context = build_phase8_base_context(asset_meta_doc)

    # Card C-4a: holdings snapshot → current_pf
    holdings_doc = read_holdings_doc(HOLDINGS_JSON_PATH)
    current_pf = build_current_pf_from_holdings(holdings_doc)
    holdings_label = extract_holdings_snapshot_label(holdings_doc)

    # Card C-4a: 前回 frontier_index snapshot → ideal_pf
    frontier_doc = read_frontier_index_doc(FRONTIER_INDEX_PATH)
    ideal_pf = build_ideal_pf_from_frontier_index(frontier_doc)

    # Card C-4b1: ExpectedReturnModel → ticker 別 expected_return
    expected_return_by_ticker = build_expected_return_by_ticker(
        returns_doc, scores, asset_meta_doc, regime="uncertain"
    )
    mean_return_label = (
        MEAN_RETURN_LABEL_DEFAULT if expected_return_by_ticker else None
    )

    # Card D1a: REGIME.md §1 整合の static regime scenario tables
    # + uniform 1/5 probability を future_branching に DI
    (
        regime_expected_returns,
        regime_expected_vols,
        regime_expected_max_dds,
        regime_probabilities,
    ) = build_regime_reference_tables()

    # Card D2b: market_intel freshness 判定（stale値は計算に使わない）
    market_intel_diag, market_intel_label = assess_market_intel_freshness()

    # Card D2c2: market_intel fresh / warn の場合のみ rule_based 単層判定
    # で regime を検出し、detected_regime に 0.60 集中・他 4 regime に 0.10
    # × 4 分配した regime_probabilities を future_branching に DI する。
    # base_regime は本 Card 範囲外（"uncertain" 固定）。
    # stale / missing / invalid、または read 失敗 / detected invalid 時は
    # uniform 1/5 を維持し safety fallback diagnostic を生成する。
    regime_probabilities_label: str = "uniform_1_5"
    regime_prob_diag: str | None = None
    if market_intel_label in ("fresh", "warn"):
        mi_fields = read_market_intel_for_regime()
        if mi_fields is None:
            regime_prob_diag = (
                "observation: market_intel fields unavailable for "
                "rule_based detection; regime_probabilities kept uniform_1_5"
            )
        else:
            try:
                rb_result = detect_regime_rule_based(mi_fields)
            except (KeyError, TypeError, ValueError):
                rb_result = None
            if isinstance(rb_result, dict):
                detected_regime_raw = rb_result.get("regime")
                primary_rule_raw = rb_result.get("primary_rule")
                if (
                    isinstance(detected_regime_raw, str)
                    and detected_regime_raw in REGIME_PROBABILITIES_UNIFORM
                ):
                    detected_regime = detected_regime_raw
                    primary_rule = (
                        primary_rule_raw
                        if isinstance(primary_rule_raw, str) and primary_rule_raw
                        else "unknown"
                    )
                    regime_probabilities = build_concentrated_regime_probabilities(
                        detected_regime
                    )
                    regime_probabilities_label = (
                        "rule_based_concentrated_0_60_" + detected_regime
                    )
                    regime_prob_diag = (
                        f"observation: rule_based regime detected "
                        f"{detected_regime} (primary_rule={primary_rule}); "
                        "regime_probabilities concentrated 0.60 on detected, "
                        "0.10 each on others; not a forecast"
                    )
                else:
                    regime_prob_diag = (
                        "observation: rule_based detected_regime not in "
                        "canonical 5; regime_probabilities kept uniform_1_5"
                    )
            else:
                regime_prob_diag = (
                    "observation: rule_based detection failed; "
                    "regime_probabilities kept uniform_1_5"
                )

    # Card C-4c1: purchase_date + 3ヶ月 lock 制約を constrained_ideal_pf
    # に反映 (既存 JpEquityPfBuilder を data 層で呼ぶ、backend 無変更)
    today_utc = datetime.now(timezone.utc).date()
    constrained_ideal_pf, lock_diagnostics, lock_summary = (
        build_constrained_ideal_pf_via_lock(
            holdings_doc, current_pf, ideal_pf, today=today_utc
        )
    )
    lock_calc_label = (
        LOCK_CALC_LABEL_DEFAULT
        if lock_summary.get("valid", 0) > 0
        else None
    )

    universe = derive_universe(returns_doc)
    ts = now_iso_tz()
    result = run_phase8(
        returns_doc=returns_doc,
        scores=scores,
        universe=universe,
        output_dir=output_dir,
        generated_at=ts,
        source=derive_source_provenance_v7(
            _scores_label,
            asset_meta_present=bool(asset_meta_doc),
            holdings_snapshot_label=holdings_label,
            mean_return_label=mean_return_label,
            regime_table_label=REGIME_TABLE_LABEL_DEFAULT,
            lock_calc_label=lock_calc_label,
            market_intel_label=market_intel_label,
            regime_probabilities_label=regime_probabilities_label,
        ),
        strategy_aggregate_timestamp=ts,
        regime="uncertain",
        base_context=base_context,
        current_pf=current_pf if current_pf else None,
        ideal_pf=ideal_pf if ideal_pf else None,
        constrained_ideal_pf=constrained_ideal_pf if constrained_ideal_pf else None,
        expected_return_by_ticker=(
            expected_return_by_ticker if expected_return_by_ticker else None
        ),
        regime_expected_returns=regime_expected_returns,
        regime_expected_vols=regime_expected_vols,
        regime_expected_max_dds=regime_expected_max_dds,
        regime_probabilities=regime_probabilities,
    )

    # Card C-4c1: data 層で計算した lock observation 文を opportunity_loss
    # の diagnostics へ prepend する。backend OpportunityLossCalculator は
    # 外部 lock observation を受け付けない（context は使用しない）ため、
    # writer 出力後の post-process でマージする。schema 不変（diagnostics
    # は list[str] のまま）、disclaimer 3 行は維持。backend 変更を回避する
    # ための data 層責務として実施。
    if lock_diagnostics:
        opp_path = Path(output_dir) / "opportunity_loss.json"
        if opp_path.exists():
            try:
                with open(opp_path, encoding="utf-8") as fh:
                    opp_doc = json.load(fh)
                payload = opp_doc.get("payload")
                if isinstance(payload, dict):
                    existing = payload.get("diagnostics")
                    if not isinstance(existing, list):
                        existing = []
                    merged = list(lock_diagnostics) + list(existing)
                    payload["diagnostics"] = merged
                    with open(opp_path, "w", encoding="utf-8") as fh:
                        json.dump(opp_doc, fh, ensure_ascii=False, indent=2)
            except (ValueError, OSError):
                # post-process 失敗時は run_phase8 出力を温存（fail-soft）
                pass

    # Card D2b: market_intel diagnostic を future_branching diagnostics に
    # prepend する。stale / missing / timestamp_invalid 時のみ追記
    # （fresh は diagnostic なし）。schema 不変（diagnostics は list[str]）。
    if market_intel_label not in ("fresh",):
        future_path = Path(output_dir) / "future_branching.json"
        if future_path.exists():
            try:
                with open(future_path, encoding="utf-8") as fh:
                    future_doc = json.load(fh)
                payload = future_doc.get("payload")
                if isinstance(payload, dict):
                    existing = payload.get("diagnostics")
                    if not isinstance(existing, list):
                        existing = []
                    payload["diagnostics"] = [market_intel_diag] + list(existing)
                    with open(future_path, "w", encoding="utf-8") as fh:
                        json.dump(future_doc, fh, ensure_ascii=False, indent=2)
            except (ValueError, OSError):
                pass

    # Card D2c2: rule_based regime probability diagnostic を
    # future_branching diagnostics に prepend する。D2b post-process より
    # 後に実行することで rule_based 観察文を index 0 に固定する
    # （warn ケースで market_intel_warn 観察文と共存しても先頭は
    # rule_based）。fresh / warn で detection 成功 / 失敗時のみ追記し、
    # stale / missing / invalid 時は D2b 既存 diagnostic を維持する。
    if regime_prob_diag is not None:
        future_path = Path(output_dir) / "future_branching.json"
        if future_path.exists():
            try:
                with open(future_path, encoding="utf-8") as fh:
                    future_doc = json.load(fh)
                payload = future_doc.get("payload")
                if isinstance(payload, dict):
                    existing = payload.get("diagnostics")
                    if not isinstance(existing, list):
                        existing = []
                    payload["diagnostics"] = [regime_prob_diag] + list(existing)
                    with open(future_path, "w", encoding="utf-8") as fh:
                        json.dump(future_doc, fh, ensure_ascii=False, indent=2)
            except (ValueError, OSError):
                pass

    return result


if __name__ == "__main__":
    # C ではこの経路は使わない。public/data/phase8 実 write は別 Card。
    result = main()
    print(json.dumps(result, ensure_ascii=False, indent=2))
