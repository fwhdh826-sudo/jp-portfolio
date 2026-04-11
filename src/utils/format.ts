// ═══════════════════════════════════════════════════════════
// 数値フォーマッタ — v9.0
// 方針: K/M表記は一切使わない。円は全桁表示（または万単位）
// ═══════════════════════════════════════════════════════════

/**
 * 円を全桁カンマ区切りで表示
 * 例: 3_642_146 → "3,642,146円"
 */
export function formatJPY(n: number | null | undefined, withUnit = true): string {
  if (n == null || !isFinite(n)) return '—'
  const s = Math.round(n).toLocaleString('ja-JP')
  return withUnit ? `${s}円` : s
}

/**
 * 円を万単位で表示（小数第1位まで）
 * 例: 3_642_146 → "364.2万円"
 * 例: 19_000_000 → "1,900.0万円"
 */
export function formatJPYMan(n: number | null | undefined, withUnit = true): string {
  if (n == null || !isFinite(n)) return '—'
  const man = n / 10_000
  const s = man.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return withUnit ? `${s}万円` : s
}

/**
 * 大きな金額は自動で万/億に切替（K/M英字は使わない）
 * 例: 380_000 → "38.0万円"
 * 例: 38_000_000 → "3,800.0万円"
 * 例: 380_000_000 → "3.80億円"
 */
export function formatJPYAuto(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 100_000_000) {
    const oku = n / 100_000_000
    return `${oku.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}億円`
  }
  if (abs >= 10_000) {
    const man = n / 10_000
    return `${man.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}万円`
  }
  return `${Math.round(n).toLocaleString('ja-JP')}円`
}

/**
 * パーセント表記（±表示）
 * 例: 0.0532 → "+5.32%"
 */
export function formatPct(n: number | null | undefined, decimals = 2, withSign = true): string {
  if (n == null || !isFinite(n)) return '—'
  const sign = withSign && n > 0 ? '+' : ''
  return `${sign}${n.toFixed(decimals)}%`
}

/**
 * 既に%単位の値をそのまま表示
 * 例: 5.32 → "+5.32%"
 */
export function formatPctRaw(n: number | null | undefined, decimals = 2, withSign = true): string {
  if (n == null || !isFinite(n)) return '—'
  const sign = withSign && n > 0 ? '+' : ''
  return `${sign}${n.toFixed(decimals)}%`
}

/**
 * 株数表示
 * 例: 1234 → "1,234株"
 */
export function formatShares(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return `${Math.round(n).toLocaleString('ja-JP')}株`
}

/**
 * 株価表示（円・小数0桁）
 * 例: 3456.78 → "3,457円"
 */
export function formatPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return `${Math.round(n).toLocaleString('ja-JP')}円`
}

/**
 * 指数表示（カンマ・小数2桁）
 * 例: 56388.12345 → "56,388.12"
 */
export function formatIndex(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return '—'
  return n.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/**
 * 日時表示（JST, YYYY-MM-DD HH:mm）
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

/**
 * 相対時間表示
 * 例: 5分前 / 2時間前 / 3日前
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso).getTime()
    const now = Date.now()
    const diff = Math.max(0, now - d)
    const min = Math.floor(diff / 60_000)
    if (min < 1) return 'たった今'
    if (min < 60) return `${min}分前`
    const h = Math.floor(min / 60)
    if (h < 24) return `${h}時間前`
    const day = Math.floor(h / 24)
    if (day < 30) return `${day}日前`
    return formatDateTime(iso)
  } catch {
    return iso
  }
}
