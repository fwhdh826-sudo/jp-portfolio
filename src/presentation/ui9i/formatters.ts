// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: 表示専用フォーマッタ（純関数）。
// 値の意味は変えず、桁・単位・時刻表記だけを整える。
// ═══════════════════════════════════════════════════════════

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const NAIVE_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/

/** タイムゾーン無しの "YYYY-MM-DD HH:mm" は JST として扱う（既存 market 形式と同じ）。 */
function parseInstant(value: string): number | null {
  const naive = NAIVE_TS.exec(value)
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, s === undefined ? 0 : +s) - JST_OFFSET_MS
    return Number.isNaN(ms) ? null : ms
  }
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** 絶対時刻（JST）。例: 10/6 8:30。不明・不正は null（呼び出し側が「—」等を選ぶ）。 */
export function formatJstMonthDayTime(value: string | null | undefined): string | null {
  if (value == null || value === '') return null
  const ms = parseInstant(value)
  if (ms === null) return null
  const jst = new Date(ms + JST_OFFSET_MS)
  const mm = jst.getUTCMonth() + 1
  const dd = jst.getUTCDate()
  const hh = jst.getUTCHours()
  const mi = String(jst.getUTCMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}

/** 10/6（月） 形式のヘッダー日付。now は呼び出し側から注入する。 */
export function formatJstHeaderDate(now: Date): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS)
  const dow = ['日', '月', '火', '水', '木', '金', '土'][jst.getUTCDay()]
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日（${dow}）`
}

/** 2026年 形式（デスクトップのヘッダー日付のみで使う）。 */
export function formatJstHeaderYear(now: Date): string {
  return `${new Date(now.getTime() + JST_OFFSET_MS).getUTCFullYear()}年`
}

/** YYYY-MM-DD → M/D。売却可能予定日の表示用。 */
export function formatMonthDay(isoDate: string | null | undefined): string | null {
  if (isoDate == null) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate)
  if (!m) return null
  return `${+m[2]}/${+m[3]}`
}

/** ¥400,000 形式。非有限値は null。 */
export function formatYen(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null
  return `¥${Math.round(n).toLocaleString('ja-JP')}`
}

/** 数値部分と単位に分けた万円表記（総資産の大きな数字 + 小さな単位のため）。非有限値は null。 */
export function formatManYenParts(n: number | null | undefined): { value: string; unit: '万円' | '円' } | null {
  if (n == null || !Number.isFinite(n)) return null
  const abs = Math.abs(n)
  if (abs !== 0 && abs < 10_000) return { value: Math.round(n).toLocaleString('ja-JP'), unit: '円' }
  return { value: Math.round(n / 10_000).toLocaleString('ja-JP'), unit: '万円' }
}

/** 万円単位（整数丸め）。1万円未満は円表記。非有限値は null。 */
export function formatManYen(n: number | null | undefined): string | null {
  const parts = formatManYenParts(n)
  return parts === null ? null : `${parts.value}${parts.unit}`
}

/** 表示用の比率（%）。小数 0.35 ではなく 35 を受け取る。整数丸め。 */
export function formatRatioPct(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) return null
  return `${Math.round(pct)}%`
}

export function formatSignedPct1(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) return null
  const rounded = Math.round(pct * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`
}
