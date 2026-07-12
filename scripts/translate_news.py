#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/translate_news.py — UI-13-2
public/data/news.json の英語ニュースに titleJa / summaryJa を追加する。

使い方:
    python3 scripts/translate_news.py --dry-run          # 確認のみ（ファイル変更なし）
    python3 scripts/translate_news.py --write            # 翻訳して news.json を更新
    python3 scripts/translate_news.py --write --limit 20 # 最大20件翻訳

環境変数:
    ANTHROPIC_API_KEY  翻訳 API キー（未設定時は dry-run 相当）
    TRANSLATE_MODEL    使用モデル（デフォルト: claude-haiku-4-5-20251001）
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# ── 定数 ──────────────────────────────────────────────────────────────────

REPO_ROOT   = Path(__file__).parent.parent
DEFAULT_IN  = REPO_ROOT / "public" / "data" / "news.json"
DEFAULT_OUT = DEFAULT_IN
DEFAULT_MODEL = os.environ.get("TRANSLATE_MODEL", "claude-haiku-4-5-20251001")

# 日本語文字（ひらがな/カタカナ/漢字）
_JP_RE = re.compile(r"[぀-ゟ゠-ヿ一-鿿㐀-䶿]")
# 日本語原文と確定するソース名
_JA_ORIGINAL_SOURCES = {"NHK 経済", "NHK経済"}
# 日本語判定の閾値（タイトル内 JP 文字数）
_JP_CHAR_THRESHOLD = 3


# ── 言語判定 ──────────────────────────────────────────────────────────────

def _is_japanese_text(text: str) -> bool:
    return len(_JP_RE.findall(text)) >= _JP_CHAR_THRESHOLD


def classify_item(item: dict[str, Any]) -> str:
    """
    'skip'          既に翻訳済み / ja-original 処理済み
    'ja-original'   日本語原文と判定（翻訳不要だが translationStatus を付与する）
    'translate'     英語 → 日本語翻訳が必要
    'empty'         title が空でスキップ
    """
    if not item.get("title", "").strip():
        return "empty"

    # 既処理チェック
    existing_status = item.get("translationStatus", "")
    if existing_status in ("translated", "ja-original"):
        return "skip"
    if item.get("titleJa", "").strip():
        return "skip"

    # 日本語原文判定
    source = item.get("source", "")
    if source in _JA_ORIGINAL_SOURCES:
        return "ja-original"
    if _is_japanese_text(item.get("title", "")):
        return "ja-original"

    return "translate"


# ── Anthropic 翻訳 ────────────────────────────────────────────────────────

def _build_translate_prompt(title: str, summary: str) -> str:
    return f"""\
あなたは金融ニュースの翻訳者です。以下の英語ニュースを日本語に翻訳してください。

ルール:
- 銘柄名・企業名・指数名・ティッカーはそのまま保持する（例: Fed, S&P 500, Apple）
- 過度な意訳をしない。金融ニュースとして自然な日本語にする
- titleJa は1文で完結させる（原則 40 字以内）
- summaryJa は日本語で 2〜3 文以内にまとめる
- 投資助言・推奨表現に変換しない
- 出力は JSON のみ。説明文を付けない

入力:
title: {title}
summary: {summary}

出力形式（JSON のみ）:
{{"titleJa": "...", "summaryJa": "..."}}"""


def translate_item(
    client: Any,
    model: str,
    title: str,
    summary: str,
) -> dict[str, str] | None:
    """Anthropic API を呼び出して titleJa / summaryJa を返す。失敗時は None。"""
    try:
        message = client.messages.create(
            model=model,
            max_tokens=512,
            messages=[
                {"role": "user", "content": _build_translate_prompt(title, summary)},
            ],
        )
        raw = message.content[0].text.strip()
        # JSON 部分だけ抽出（前後に余計なテキストがある場合に対応）
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if not m:
            return None
        parsed = json.loads(m.group())
        title_ja   = parsed.get("titleJa", "").strip()
        summary_ja = parsed.get("summaryJa", "").strip()
        if not title_ja:
            return None
        return {"titleJa": title_ja, "summaryJa": summary_ja}
    except Exception as exc:  # noqa: BLE001
        print(f"    ⚠ 翻訳エラー: {exc}", file=sys.stderr)
        return None


# ── メインロジック ─────────────────────────────────────────────────────────

def load_news(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_news(data: dict[str, Any], path: Path) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"✓ 書き込み完了: {path}")


def _make_client(api_key: str, model: str) -> Any | None:
    """Anthropic クライアントを返す。SDK 未インストールまたはキー未設定時は None。"""
    try:
        import anthropic  # noqa: PLC0415
        return anthropic.Anthropic(api_key=api_key)
    except ImportError:
        print(
            "⚠ anthropic SDK が未インストールです。\n"
            "  pip3 install anthropic  でインストール後、再実行してください。",
            file=sys.stderr,
        )
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"⚠ Anthropic クライアント初期化失敗: {exc}", file=sys.stderr)
        return None


def run(
    *,
    input_path: Path,
    output_path: Path,
    dry_run: bool,
    limit: int | None,
    model: str,
    verbose: bool,
) -> None:
    data = load_news(input_path)
    all_items: list[dict[str, Any]] = data.get("marketNews", []) + data.get("stockNews", [])

    # ── 分類 ──────────────────────────────────────────────────────────────
    to_translate:   list[dict[str, Any]] = []
    to_ja_original: list[dict[str, Any]] = []
    skipped:        list[dict[str, Any]] = []
    empty:          list[dict[str, Any]] = []

    for item in all_items:
        cls = classify_item(item)
        if cls == "translate":
            to_translate.append(item)
        elif cls == "ja-original":
            to_ja_original.append(item)
        elif cls == "skip":
            skipped.append(item)
        else:
            empty.append(item)

    total       = len(all_items)
    n_translate = len(to_translate)
    n_jaori     = len(to_ja_original)
    n_skip      = len(skipped)
    n_empty     = len(empty)
    effective   = min(n_translate, limit) if limit else n_translate

    print(f"\n{'[dry-run] ' if dry_run else ''}=== translate_news.py ===")
    print(f"入力:          {input_path}")
    print(f"出力:          {output_path}")
    print(f"モデル:        {model}")
    print(f"合計:          {total} 件")
    print(f"翻訳対象:      {n_translate} 件  (今回処理: {effective} 件{'（limit適用）' if limit and limit < n_translate else ''})")
    print(f"日本語原文:    {n_jaori} 件")
    print(f"スキップ済み:  {n_skip} 件")
    print(f"空タイトル:    {n_empty} 件")

    if verbose and to_translate:
        print("\n[翻訳対象 サンプル（先頭 3 件）]")
        for item in to_translate[:3]:
            print(f"  id={item['id']}  source={item['source']}")
            print(f"  title: {item['title'][:70]}")

    if dry_run:
        print("\n⏸  dry-run モード — ファイルは変更されません。")
        print("   実際に翻訳するには --write を指定してください。")
        return

    # ── API キー確認 ────────────────────────────────────────────────────
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print(
            "\n⚠ ANTHROPIC_API_KEY が設定されていません。\n"
            "  export ANTHROPIC_API_KEY=sk-ant-... を設定してください。\n"
            "  ja-original の付与のみ実施します。",
            file=sys.stderr,
        )
        client = None
    else:
        client = _make_client(api_key, model)

    now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # ── ja-original 付与（API 不要） ─────────────────────────────────────
    ja_ori_count = 0
    if to_ja_original:
        print(f"\n[1/2] 日本語原文マーク付与: {n_jaori} 件")
        market_ids = {item["id"] for item in data.get("marketNews", [])}
        for section_key in ("marketNews", "stockNews"):
            for item in data[section_key]:
                if classify_item(item) == "ja-original":
                    item["titleJa"]          = item["title"]
                    item["summaryJa"]        = item.get("summary", "")
                    item["translationStatus"] = "ja-original"
                    item["translatedAt"]     = now_iso
                    ja_ori_count += 1
        print(f"  ✓ {ja_ori_count} 件 マーク済み")

    # ── 英語翻訳 ────────────────────────────────────────────────────────
    translated_count = 0
    failed_count     = 0

    if to_translate and effective > 0:
        print(f"\n[2/2] 英語 → 日本語翻訳: {effective} 件")
        if client is None:
            print("  ⏭ API クライアント未初期化 — 翻訳をスキップします。")
        else:
            # id → section/index マッピングで直接更新
            id_to_ref: dict[str, dict[str, Any]] = {}
            for section_key in ("marketNews", "stockNews"):
                for item in data[section_key]:
                    id_to_ref[item["id"]] = item

            processed = 0
            for item in to_translate:
                if processed >= effective:
                    break
                item_id = item["id"]
                title   = item.get("title", "")
                summary = item.get("summary", "")
                print(f"  [{processed + 1}/{effective}] {item_id}  {title[:50]}")

                result = translate_item(client, model, title, summary)
                target = id_to_ref.get(item_id)
                if target is None:
                    processed += 1
                    failed_count += 1
                    continue

                if result:
                    target["titleJa"]          = result["titleJa"]
                    target["summaryJa"]        = result["summaryJa"]
                    target["translationStatus"] = "translated"
                    target["translatedAt"]     = now_iso
                    translated_count += 1
                    if verbose:
                        print(f"    → {result['titleJa'][:60]}")
                else:
                    target["translationStatus"] = "pending"
                    failed_count += 1

                processed += 1

    # ── 書き込み ────────────────────────────────────────────────────────
    save_news(data, output_path)

    print(f"\n=== 完了 ===")
    print(f"ja-original 付与: {ja_ori_count} 件")
    print(f"翻訳成功:         {translated_count} 件")
    print(f"翻訳失敗/スキップ: {failed_count} 件")


# ── CLI ───────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="news.json の英語ニュースを日本語に翻訳して titleJa / summaryJa を追加する",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--dry-run", action="store_true",
        help="翻訳対象の件数を表示するのみ。ファイルを変更しない",
    )
    mode.add_argument(
        "--write", action="store_true",
        help="翻訳を実行して news.json を更新する",
    )
    parser.add_argument(
        "--input", type=Path, default=DEFAULT_IN,
        help=f"入力 JSON パス（デフォルト: {DEFAULT_IN}）",
    )
    parser.add_argument(
        "--output", type=Path, default=None,
        help="出力 JSON パス（デフォルト: 入力パスと同じ）",
    )
    parser.add_argument(
        "--model", default=DEFAULT_MODEL,
        help=f"翻訳モデル（デフォルト: {DEFAULT_MODEL}）",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="1 回の実行で翻訳する最大件数（コスト管理用）",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="翻訳結果を詳細表示する",
    )

    args = parser.parse_args()

    input_path  = args.input.resolve()
    output_path = (args.output or args.input).resolve()

    if not input_path.exists():
        print(f"✗ 入力ファイルが見つかりません: {input_path}", file=sys.stderr)
        sys.exit(1)

    run(
        input_path=input_path,
        output_path=output_path,
        dry_run=args.dry_run,
        limit=args.limit,
        model=args.model,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
