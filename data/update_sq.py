#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════
# update_sq.py — v9.0
# 日経225 SQ（特別清算指数）カレンダーを生成
# SQ日: 毎月第2金曜日
#   3/6/9/12月 = 先物SQ（四半期SQ、ボラ高い）
#   その他 = 月次SQ（オプションのみ）
#
# 出力:
#   data/sq_calendar.json
#   public/data/sq_calendar.json
# ═══════════════════════════════════════════════════════════

import json
import datetime as dt
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"
PUBLIC_DIR = PROJECT_ROOT / "public" / "data"
OUT_FILES = [DATA_DIR / "sq_calendar.json", PUBLIC_DIR / "sq_calendar.json"]


def log(msg: str):
    print(f"[update_sq] {msg}", flush=True)


def second_friday(year: int, month: int) -> dt.date:
    """その月の第2金曜日を返す"""
    d = dt.date(year, month, 1)
    # 1日の曜日（月=0, 火=1, ..., 金=4, 土=5, 日=6）
    offset = (4 - d.weekday()) % 7   # 最初の金曜日までの日数
    first_friday = d + dt.timedelta(days=offset)
    return first_friday + dt.timedelta(days=7)


def is_business_day(d: dt.date) -> bool:
    return d.weekday() < 5   # 月〜金


def business_days_between(start: dt.date, end: dt.date) -> int:
    """start から end までの営業日数（start/end 含む場合の end-start 営業日数を近似）"""
    if end < start:
        return -business_days_between(end, start)
    days = 0
    d = start
    while d < end:
        d += dt.timedelta(days=1)
        if is_business_day(d):
            days += 1
    return days


def generate_sq_calendar(months_ahead: int = 6) -> dict:
    today = dt.date.today()
    events = []
    year, month = today.year, today.month

    for _ in range(months_ahead + 1):
        sq_date = second_friday(year, month)
        if sq_date >= today:
            is_quarterly = month in (3, 6, 9, 12)
            day_until = business_days_between(today, sq_date)
            events.append({
                "date": sq_date.strftime("%Y-%m-%d"),
                "type": "quarterly" if is_quarterly else "monthly",
                "dayUntil": day_until,
            })
        # 次月
        if month == 12:
            year += 1
            month = 1
        else:
            month += 1

    next_sq = events[0] if events else None
    return {
        "last_updated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "events": events,
        "nextSQ": next_sq,
    }


def main():
    log("start")
    data = generate_sq_calendar(months_ahead=6)
    log(f"  generated {len(data['events'])} SQ events")
    if data["nextSQ"]:
        log(f"  next SQ: {data['nextSQ']['date']} ({data['nextSQ']['type']}, {data['nextSQ']['dayUntil']} business days)")

    for out in OUT_FILES:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"  wrote {out}")

    log("done")
    return 0


if __name__ == "__main__":
    import sys
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e}")
        sys.exit(0)
