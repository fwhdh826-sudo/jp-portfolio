#!/usr/bin/env python3
"""
JP株OS — fundamentals raw data 上流生成スクリプト skeleton（D: 接続入口）
使用（将来 / 本 D では実行しない）: python3 data/update_fundamentals.py
出力（将来）: data/fundamentals.json

目的:
  live yfinance trial（handover.md「E: live yfinance trial 結果記録」）で
  viable と判明した 19 component の raw 財務値を、将来
  data/fundamentals.json へ安定生成する入口。**本 D では skeleton +
  pure helper のみ。yfinance 実行 / data/fundamentals.json 生成 /
  public/data 出力 / GHA 接続は行わない**（実行は後続 Card）。

data/update_returns.py mirror:
  standalone data script（backend を import しない＝sys.path dual-root
  不要）。TICKERS は update_returns.py / update_correlation.py と同一
  16 JP .T。OUTPUT_PATH = data/fundamentals.json（data/ 側・public/data
  パスは持たない）。再生成前 backup-copy、失敗時 restore、空 /
  usable ゼロでは本番上書きしない。

正準 19 component_key（backend scorer の COMPONENT_WEIGHTS と一致。
ただし scorer を import せず静的に持つ＝data/ standalone 維持。key
drift は後続 H で reconcile）:
  value:              per_score pbr_score peg_score div_yield ev_ebitda
  safety:             equity_ratio de_ratio interest_cover beta_inverse
  shareholder_return: div_payout buyback_yield doe div_growth_5y total_yield
  quality:            roe_3y_avg roa fcf_yield
  growth:             revenue_cagr_3y eps_growth_3y

honesty / 非範囲:
  - volatility_252d は public/data/returns.json 由来であり fundamentals
    由来ではない（本 script は扱わない）。
  - 対象外 9（moat_score earnings_stab guidance tam_expansion +
    momentum 5: trend_score ma_spread credit_ratio volume_z
    relative_strength）は fundamentals upstream では解決しない。
  - よって scores は依然 partial-real / hybrid。
    full real / full generated とは呼ばない。
  - presence != correctness。derive_components で scorer 期待単位へ
    式・単位・符号を整合済（H）。info.dividendYield は D′ live tmp
    点検で解消済: yfinance 1.2.0 は本 JP 16 銘柄で percent 等倍
    （例 3.12=3.12%）を返す → div_yield/total_yield は等倍
    pass-through（×100 撤廃）。eps_growth_3y は net income 代用
    （厳密 EPS でない）。
    欠損 / 曖昧 / 分母0 は missing-safe（不在）で安全側。
  - CI 接続（public/data への cp + bot commit）は後続 Card。

設計原則:
  - missing-safe: 欠損 component_key は dict に入れない（0 埋め禁止 /
    捏造禁止）。scorer の _get_raw / MISSING_RAW_VALUES の中立 default
    へ委譲。missing list に {ticker, component, reason} を記録。
  - 実 HTTP は fetch_raw_per_ticker に薄く隔離（test は呼ばない /
    D では実行しない）。yfinance は fetch 内で遅延 import（module
    scope では import せず、未インストール環境でも skeleton は
    import 可能）。
  - generated_at は timezone 付き ISO8601。
  - BUY / SELL / HOLD / WAIT 禁止、action / 推奨 / 判定ラベル禁止、
    rebalance_order / 具体株数金額 禁止。

Reference: data/update_returns.py（mirror 元）
Reference: handover.md「E: live yfinance trial 結果記録」
Reference: handover.md「fundamental upstream Card Readiness 結果 /
           financial_data 源マップ」
"""
from __future__ import annotations

import json
import math
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# JP株 16銘柄（update_returns.py / update_correlation.py と一致）
TICKERS = [
    '6098.T', '8306.T', '9697.T', '4661.T', '8593.T', '4755.T',
    '5711.T', '1605.T', '5016.T', '8058.T', '9418.T', '1928.T',
    '7011.T', '7974.T', '9433.T', '7012.T',
]

OUTPUT_PATH = Path(__file__).parent / 'fundamentals.json'
BACKUP_PATH = Path(__file__).parent / 'fundamentals_backup.json'

META_VERSION = "v13.3"
META_KIND = "fundamentals_raw"
META_SOURCE = "yfinance"
META_NOTE = (
    "presence!=correctness / 19-of-29 / volatility_252d from returns.json"
    " / 9 passthrough+technical neutral-default / partial-real hybrid"
    " / not full real"
)

# 正準 19 component_key（軸別・定義順）。scorer COMPONENT_WEIGHTS と一致。
CANONICAL_COMPONENTS: dict[str, tuple[str, ...]] = {
    "value": ("per_score", "pbr_score", "peg_score", "div_yield",
              "ev_ebitda"),
    "safety": ("equity_ratio", "de_ratio", "interest_cover",
               "beta_inverse"),
    "shareholder_return": ("div_payout", "buyback_yield", "doe",
                           "div_growth_5y", "total_yield"),
    "quality": ("roe_3y_avg", "roa", "fcf_yield"),
    "growth": ("revenue_cagr_3y", "eps_growth_3y"),
}
# flat 19（envelope に出す唯一の正準 key 集合）
CANONICAL_KEYS: tuple[str, ...] = tuple(
    k for ks in CANONICAL_COMPONENTS.values() for k in ks
)

# fundamentals upstream では解決しない 9（emit しない）。
OUT_OF_SCOPE_COMPONENTS: tuple[str, ...] = (
    "moat_score", "earnings_stab", "guidance", "tam_expansion",
    "trend_score", "ma_spread", "credit_ratio", "volume_z",
    "relative_strength",
)
# returns.json 由来（fundamentals 由来ではない。emit しない）。
RETURNS_DERIVED_COMPONENTS: tuple[str, ...] = ("volatility_252d",)


def now_iso_tz() -> str:
    """timezone 付き ISO8601（UTC）。UI stale 判定の一貫性のため tz 付き。"""
    return datetime.now(timezone.utc).isoformat()


def is_usable(x: Any) -> bool:
    """raw 値が有効数値か（bool 除外 / NaN・inf 除外 / None 除外）。"""
    if isinstance(x, bool):
        return False
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)


def build_fundamentals_doc(
    parsed_per_ticker: dict,
    *,
    generated_at: str | None = None,
) -> dict:
    """
    {ticker: {component_key: raw_value, ...}} → fundamentals_raw envelope。

    - 正準 19 key のみ採用。対象外 9 / volatility_252d / 未知 key は drop。
    - usable でない raw は不在（0 埋め禁止・捏造禁止）。missing に
      {ticker, component, reason} を記録。
    - usable component を 1 つ以上持つ ticker のみ tickers に載せる。
    - usable 総数 0 のとき status="inconclusive"（caller は本番を
      上書きしない）。それ以外 status="ok"。
    """
    ga = generated_at if generated_at else now_iso_tz()
    fundamentals: dict[str, dict] = {}
    missing: list[dict] = []
    fetched: list[str] = []
    usable_total = 0

    for ticker, comps in (parsed_per_ticker or {}).items():
        t = str(ticker)
        comps = comps if isinstance(comps, dict) else {}
        row: dict[str, float] = {}
        for key in CANONICAL_KEYS:
            if key not in comps:
                missing.append({"ticker": t, "component": key,
                                "reason": "absent"})
                continue
            raw = comps[key]
            if not is_usable(raw):
                missing.append({"ticker": t, "component": key,
                                "reason": "not_usable"})
                continue
            row[key] = float(raw)
        if row:
            fundamentals[t] = row
            fetched.append(t)
            usable_total += len(row)
        else:
            missing.append({"ticker": t, "component": "*",
                            "reason": "no_usable_component"})

    status = "ok" if usable_total > 0 else "inconclusive"
    return {
        "_meta": {
            "version": META_VERSION,
            "kind": META_KIND,
            "source": META_SOURCE,
            "generated_at": ga,
            "not_for_trading": True,
            "note": META_NOTE,
        },
        "last_updated": ga,
        "tickers": fetched,
        "missing": missing,
        "fundamentals": fundamentals,
        "status": status,
    }


def write_doc(path: Any, doc: dict) -> Path:
    """doc を JSON へ書く（atomic: tmp→replace）。返り値は書込先 Path。"""
    p = Path(path)
    tmp = p.with_name(p.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
    tmp.replace(p)
    return p


def backup_existing(output_path: Any, backup_path: Any) -> bool:
    """既存 OUTPUT があれば backup-copy。コピーしたら True。"""
    o, b = Path(output_path), Path(backup_path)
    if o.exists():
        shutil.copy(o, b)
        return True
    return False


def restore_backup(output_path: Any, backup_path: Any) -> bool:
    """backup があれば OUTPUT へ restore。復元したら True。"""
    o, b = Path(output_path), Path(backup_path)
    if b.exists():
        shutil.copy(b, o)
        return True
    return False


def _num(v: Any) -> Any:
    """usable な数値なら float、でなければ None（捏造しない）。"""
    return float(v) if is_usable(v) else None


def _row_values(df: Any, candidates: tuple[str, ...]) -> list:
    """statement DataFrame から候補行ラベルの usable 数値列を返す。"""
    try:
        if df is None or getattr(df, "empty", True):
            return []
        for ridx in df.index:
            rl = str(ridx).lower()
            if any(c in rl for c in candidates):
                return [float(v) for v in df.loc[ridx].tolist()
                        if is_usable(v)]
    except Exception:
        return []
    return []


def _div_year_sums(div: Any) -> dict:
    """配当 Series → {year: 年合計}（pure・例外時 {}・捏造しない）。"""
    out: dict = {}
    try:
        if div is None or len(div) == 0:
            return {}
        for ts, val in div.items():
            y = getattr(ts, "year", None)
            if y is None or not is_usable(val):
                continue
            out[int(y)] = out.get(int(y), 0.0) + float(val)
    except Exception:
        return {}
    return out


def derive_components(info: Any, bs: Any, fin: Any, cf: Any,
                      div: Any, fast: Any) -> dict:
    """
    yfinance 各 surface（注入）→ 正準 component raw（scorer 期待単位）。

    **yfinance 非依存・network 非依存の pure 変換**（fixture test 可）。
    scorer docstring の単位契約に整合させる:
      - fraction→% (×100): equity_ratio roe_3y_avg roa fcf_yield
        revenue_cagr_3y eps_growth_3y div_growth_5y buyback_yield
      - percent 等倍 pass-through（×100 しない）: div_yield
        total_yield（yfinance 1.2.0 は dividendYield を percent
        等倍で返す＝D′ 実測・JP16・単発）
      - ratio 維持: div_payout（payoutRatio raw 0–1）
      - 生値 passthrough: per_score pbr_score peg_score ev_ebitda /
        beta_inverse（生 β、scorer 内で反転）
      - interest_cover = EBIT / abs(interest_expense)（yfinance の
        interest expense は負値になり得るため正値化）
      - de_ratio = Total Liabilities / Equity（倍率・%化しない。
        行選択妥当性は要追検証）
      - doe = abs(cashflow 配当支払) / Equity * 100（堅牢に導出
        できなければ不在＝missing-safe。壊れたスケール値を出さない）
      - buyback_yield = 発行株式数の減少率 * 100
    順序前提: yfinance statement は列＝期で **最新が先頭**
      （[0]=最新 / [-1]=最古）。必要年数不足は missing-safe。
    残差（presence != correctness）:
      - info.dividendYield: D′ live tmp 点検で解消済。yfinance 1.2.0
        は本 JP 16 銘柄で dividendYield を percent 等倍（~3.12）で
        返す → div_yield/total_yield は等倍 pass-through（×100 撤廃）。
      - eps_growth_3y は net income 代用（厳密 EPS でない／株数
        変動無視）。
      - 取得不能・曖昧・分母0 は不在（0 埋め禁止・捏造禁止）。
    """
    out: dict[str, float] = {}

    def put(key: str, val: Any) -> None:
        n = _num(val)
        if n is not None:
            out[key] = n

    info = info if isinstance(info, dict) else {}

    # ── .info スカラ ──
    put("per_score", info.get("trailingPE"))
    put("pbr_score", info.get("priceToBook"))
    put("peg_score", info.get("pegRatio", info.get("trailingPegRatio")))
    put("ev_ebitda", info.get("enterpriseToEbitda"))
    put("beta_inverse", info.get("beta"))          # 生 β（scorer 内反転）
    put("div_payout", info.get("payoutRatio"))     # ratio 0–1 維持
    dy = _num(info.get("dividendYield"))
    if dy is not None:
        # yfinance 1.2.0 は本 JP 16 銘柄で dividendYield を percent
        # 等倍（例 3.12=3.12%）で返す（D′ live tmp 点検で確認）。
        # scorer は % 単位期待 → ×100 せず等倍 pass-through。
        put("div_yield", dy)
        put("total_yield", dy)                     # 配当のみ近似・%

    # ── statement 由来（最新先頭前提）──
    eq = _row_values(bs, ("stockholders equity",
                          "total stockholder equity",
                          "common stock equity"))
    at = _row_values(bs, ("total assets",))
    lb = _row_values(bs, ("total liabilities", "total liab"))
    ebit = _row_values(fin, ("ebit", "operating income"))
    inte = _row_values(fin, ("interest expense",))
    rev = _row_values(fin, ("total revenue",))
    ni = _row_values(fin, ("net income",))
    ocf = _row_values(cf, ("operating cash flow",
                           "total cash from operating activities"))
    capex = _row_values(cf, ("capital expenditure",))
    dpaid = _row_values(cf, ("cash dividends paid",
                             "common stock dividend",
                             "dividends paid",
                             "payments of dividends"))
    sc = _row_values(bs, ("share issued", "ordinary share",
                          "common stock"))

    if eq and at and at[0]:
        put("equity_ratio", eq[0] / at[0] * 100.0)          # %
    if lb and eq and eq[0]:
        put("de_ratio", lb[0] / eq[0])                      # 倍率（%化せず）
    if ebit and inte and abs(inte[0]) > 0.0:
        put("interest_cover", ebit[0] / abs(inte[0]))       # 符号正値化
    if len(ni) >= 3 and len(eq) >= 3:
        mean_eq = sum(eq[:3]) / 3.0
        if mean_eq:
            put("roe_3y_avg",
                (sum(ni[:3]) / 3.0) / mean_eq * 100.0)       # %
    if ni and at and at[0]:
        put("roa", ni[0] / at[0] * 100.0)                   # %
    if ocf and capex:
        mc = getattr(fast, "market_cap", None)
        if is_usable(mc) and float(mc):
            put("fcf_yield",
                (ocf[0] - abs(capex[0])) / float(mc) * 100.0)  # %
    if len(rev) >= 3 and rev[0] > 0 and rev[-1] > 0:
        n = len(rev) - 1
        put("revenue_cagr_3y",
            ((rev[0] / rev[-1]) ** (1.0 / n) - 1.0) * 100.0)   # %
    if len(ni) >= 3 and ni[0] > 0 and ni[-1] > 0:
        n = len(ni) - 1
        put("eps_growth_3y",
            ((ni[0] / ni[-1]) ** (1.0 / n) - 1.0) * 100.0)     # % NI 代用
    if len(sc) >= 2 and sc[-1]:
        put("buyback_yield",
            (sc[-1] - sc[0]) / sc[-1] * 100.0)              # 減少率 %
    if dpaid and eq and eq[0]:
        put("doe", abs(dpaid[0]) / eq[0] * 100.0)           # %

    ds = _div_year_sums(div)
    yrs = sorted(ds.keys())
    if len(yrs) >= 5:
        first, last = ds[yrs[0]], ds[yrs[-1]]
        span = yrs[-1] - yrs[0]
        if first > 0 and last > 0 and span > 0:
            put("div_growth_5y",
                ((last / first) ** (1.0 / span) - 1.0) * 100.0)  # %
    return out


def fetch_raw_per_ticker(ticker: str) -> dict:
    """
    1 銘柄の surface を yfinance から取得し derive_components へ委譲。

    **本系の D/H では呼ばない（test も呼ばない）。実行は後続 Card**。
    network はこの薄い wrapper に隔離。yfinance は遅延 import
    （module scope 非 import / 非インストール環境でも import 可能）。
    式・単位・符号・順序の正しさは pure な derive_components 側で
    担保し、本関数は surface 取得＋委譲のみ。
    """
    import yfinance as yf

    tk = yf.Ticker(ticker)
    try:
        info = tk.info or {}
    except Exception:
        info = {}

    def _surface(attr: str) -> Any:
        try:
            return getattr(tk, attr)
        except Exception:
            return None

    return derive_components(
        info,
        _surface("balance_sheet"),
        _surface("financials"),
        _surface("cashflow"),
        _surface("dividends"),
        _surface("fast_info"),
    )


def main(
    output_path: Any = OUTPUT_PATH,
    backup_path: Any = BACKUP_PATH,
) -> bool:
    """
    将来 / 後続 Card 用 entry。**本 D では実行しない**
    （yfinance fetch / data/fundamentals.json 生成は後続 Card）。

    backup→fetch→build→（usable>0 のみ）write→失敗時 restore。
    空 / usable ゼロでは本番を上書きしない。
    """
    had_backup = backup_existing(output_path, backup_path)
    try:
        parsed: dict[str, dict] = {}
        for t in TICKERS:
            row: dict = {}
            for _attempt in range(2):
                try:
                    row = fetch_raw_per_ticker(t)
                    break
                except Exception:
                    row = {}
            if row:
                parsed[t] = row
        doc = build_fundamentals_doc(parsed)
        if doc["status"] != "ok" or not doc["fundamentals"]:
            print("  ! usable fundamentals ゼロ / inconclusive: "
                  "本番を上書きしません")
            return False
        write_doc(output_path, doc)
        print(f"  OK {Path(output_path)} 生成 / tickers="
              f"{len(doc['tickers'])} missing={len(doc['missing'])}")
        return True
    except Exception as e:
        print(f"  ERROR: {e}")
        if restore_backup(output_path, backup_path):
            print("  -> backup を restore しました")
        elif not had_backup:
            print("  -> backup なし: 既存なし / 後続は missing-safe")
        return False


if __name__ == "__main__":
    # D ではこの経路は使わない。yfinance fetch / data/fundamentals.json
    # 生成 / public/data 出力 / GHA 接続は後続 Card。
    sys.exit(0 if main() else 1)
