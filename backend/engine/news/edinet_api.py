"""
EDINET API Layer — Card 4-3
Phase 4 Market Intelligence: EDINET 公式 API の URL 構築・response parse・NewsItem 正規化。

責務:
  - EdinetDocument / EdinetFetchResult dataclass 定義
  - build_documents_url: 日付 + 書類種別 → URL 文字列（pure）
  - parse_submit_datetime: "YYYY-MM-DD HH:MM"（JST）→ UTC datetime（pure）
  - normalize_document: API 結果 dict → EdinetDocument | None（pure）
  - parse_documents_response: /documents.json dict → list[EdinetDocument]（pure）
  - edinet_document_to_news_item: EdinetDocument → NewsItem（pure）
  - fetch_edinet_documents: fetcher_fn(DI) + date → EdinetFetchResult

実装しないこと:
  - 実 HTTP アクセス（fetcher_fn DI で分離、本番実装は後続 Card）
  - requests / httpx / aiohttp / urllib.request
  - API キー認証
  - asyncio
  - Shikiho スクレイプ（Card 4-4）
  - ticker 抽出 / sentiment / importance scoring（Card 4-x）
  - public/data 書き込み
  - Operation Layer import

EDINET API 仕様:
  Base URL : https://disclosure.edinet-fsa.go.jp/api/v2
  Endpoint : /documents.json?date=YYYY-MM-DD&type={1|2}
  type=1   : 提出書類一覧（差分含む）
  type=2   : 有価証券報告書等（主要書類のみ）
  認証     : 不要（無料 API）
  日付形式 : submitDateTime は "YYYY-MM-DD HH:MM"（JST 固定）

Reference: docs/v13.3/05_v13.3_master_plan.md Section 5.1
Reference: docs/v13.3/06_v13.3_claude_code_instructions.md Card 4-3
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Callable

from backend.engine.news.rss_fetcher import NewsItem

# ── 定数 ──────────────────────────────────────────────────────────────────────

EDINET_BASE = "https://disclosure.edinet-fsa.go.jp/api/v2"
DOC_TYPE_MAIN = 2   # 有価証券報告書等（主要書類）
DOC_TYPE_ALL = 1    # 提出書類一覧（差分含む）

_JST = timezone(timedelta(hours=9))


# ── EdinetDocument ────────────────────────────────────────────────────────────

@dataclass
class EdinetDocument:
    """
    EDINET /documents.json の 1 ドキュメントを表す中間表現。
    NewsItem への変換前に EDINET 固有フィールドを保持する。
    """
    doc_id: str                       # "S100ABCD"
    edinet_code: str                  # "E12345"
    filer_name: str                   # 提出者名（企業名）
    doc_description: str              # 書類種別名
    submit_datetime: str              # raw "2026-05-07 09:00"（JST）
    doc_type_code: str                # "120"（有価証券報告書等）
    url: str                          # f"{EDINET_BASE}/documents/{doc_id}"
    period_start: str | None = None   # "2025-04-01"（任意）
    period_end: str | None = None     # "2026-03-31"（任意）


# ── EdinetFetchResult ─────────────────────────────────────────────────────────

@dataclass
class EdinetFetchResult:
    """
    fetch_edinet_documents の取得結果。
    EDINET は単一エンドポイント / 単一日付への 1 リクエストなので
    success: bool + error: str | None で表現する。
    """
    target_date: date
    doc_type: int
    items: list[NewsItem] = field(default_factory=list)
    total_count: int = 0              # metadata.resultset.count（API 報告値）
    success: bool = False
    error: str | None = None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


# ── URL builder ───────────────────────────────────────────────────────────────

def build_documents_url(target_date: date, doc_type: int = 2) -> str:
    """
    EDINET /documents.json のリクエスト URL を構築して返す（pure）。

    Args:
        target_date : 取得対象日（YYYY-MM-DD 形式に変換）
        doc_type    : 1=全書類 / 2=有価証券報告書等（デフォルト 2）

    Returns:
        str — 完全な URL 文字列
    """
    date_str = target_date.strftime("%Y-%m-%d")
    return f"{EDINET_BASE}/documents.json?date={date_str}&type={doc_type}"


# ── Date parsing ──────────────────────────────────────────────────────────────

def parse_submit_datetime(s: str | None) -> datetime | None:
    """
    EDINET の submitDateTime 文字列を timezone-aware UTC datetime に変換する。

    EDINET の主フォーマット: "YYYY-MM-DD HH:MM"（JST 固定、timezone 表記なし）
    フォールバック: ISO 8601（タイムゾーン指定あり / なし両対応）

    None / 空 / 解析不能な値は None を返す（例外を上げない）。
    """
    if not s or not s.strip():
        return None
    stripped = s.strip()
    # EDINET 主フォーマット: "YYYY-MM-DD HH:MM"
    try:
        dt = datetime.strptime(stripped, "%Y-%m-%d %H:%M")
        return dt.replace(tzinfo=_JST).astimezone(timezone.utc)
    except ValueError:
        pass
    # ISO 8601 フォールバック
    try:
        dt = datetime.fromisoformat(stripped)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_JST)
        return dt.astimezone(timezone.utc)
    except ValueError:
        pass
    return None


# ── Document normalization ────────────────────────────────────────────────────

def normalize_document(doc: dict) -> EdinetDocument | None:
    """
    API 結果の 1 ドキュメント dict を EdinetDocument に変換する（pure）。

    docID または filerName が欠けている / 空の場合は None を返す（caller がスキップ）。
    """
    doc_id = doc.get("docID") or ""
    filer_name = doc.get("filerName") or ""
    if not doc_id.strip() or not filer_name.strip():
        return None
    return EdinetDocument(
        doc_id=doc_id.strip(),
        edinet_code=(doc.get("edinetCode") or "").strip(),
        filer_name=filer_name.strip(),
        doc_description=(doc.get("docDescription") or "").strip(),
        submit_datetime=(doc.get("submitDateTime") or "").strip(),
        doc_type_code=(doc.get("docTypeCode") or "").strip(),
        url=f"{EDINET_BASE}/documents/{doc_id.strip()}",
        period_start=doc.get("periodStart") or None,
        period_end=doc.get("periodEnd") or None,
    )


# ── Response parsing ──────────────────────────────────────────────────────────

def parse_documents_response(data: dict) -> list[EdinetDocument]:
    """
    EDINET /documents.json の API レスポンス全体 dict を parse して
    list[EdinetDocument] を返す（pure）。

    "results" キーが存在しない / None の場合は [] を返す（例外を上げない）。
    normalize_document が None を返したドキュメントはスキップする。
    """
    results = data.get("results") or []
    docs: list[EdinetDocument] = []
    for doc_dict in results:
        doc = normalize_document(doc_dict)
        if doc is not None:
            docs.append(doc)
    return docs


# ── EdinetDocument → NewsItem ─────────────────────────────────────────────────

def edinet_document_to_news_item(doc: EdinetDocument) -> NewsItem:
    """
    EdinetDocument を NewsItem に変換する（pure）。

    title   : "{filer_name} - {doc_description}"（doc_description 空の場合は filer_name のみ）
    source_id: "edinet"
    language : "ja"
    categories: ("disclosure", "regulatory")
    """
    title = (
        f"{doc.filer_name} - {doc.doc_description}"
        if doc.doc_description
        else doc.filer_name
    )
    return NewsItem(
        source_id="edinet",
        title=title,
        url=doc.url,
        summary=doc.doc_description,
        published_at=parse_submit_datetime(doc.submit_datetime),
        language="ja",
        categories=("disclosure", "regulatory"),
    )


# ── fetch_edinet_documents ────────────────────────────────────────────────────

def fetch_edinet_documents(
    target_date: date,
    fetcher_fn: Callable[[str], str],
    doc_type: int = 2,
) -> EdinetFetchResult:
    """
    EDINET /documents.json を fetcher_fn 経由で取得し、parse して
    EdinetFetchResult を返す。

    Args:
        target_date : 取得対象日
        fetcher_fn  : URL → JSON 文字列 を返す callable（必須; DI）
                      本番 HTTP fetcher は後続 Card で実装する
        doc_type    : 1=全書類 / 2=有価証券報告書等（デフォルト 2）

    fetcher_fn の例外 / JSON 破損 は success=False / error に記録して返す。
    results が空 / 存在しない場合は success=True / items=[] で返す。
    """
    result = EdinetFetchResult(
        target_date=target_date,
        doc_type=doc_type,
        fetched_at=datetime.now(timezone.utc),
    )
    url = build_documents_url(target_date, doc_type)
    try:
        json_text = fetcher_fn(url)
        data = json.loads(json_text)
        docs = parse_documents_response(data)
        result.total_count = (
            data.get("metadata", {})
                .get("resultset", {})
                .get("count", len(docs))
        )
        result.items = [edinet_document_to_news_item(d) for d in docs]
        result.success = True
    except Exception as exc:
        result.error = str(exc)
        result.success = False
    return result
