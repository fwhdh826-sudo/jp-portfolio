// ═══════════════════════════════════════════════════════════
// 数値フォーマッタ — v9.0
// 方針: K/M表記は一切使わない。円は全桁表示（または万単位）
// ═══════════════════════════════════════════════════════════

/**
 * toFixed/toLocaleString が生成しうる "-0" / "-0.0" 等の負のゼロ表記をASCII "0" 側へ
 * 正規化する（R2.4: 0の表示は符号なし）。Math.round(-0.3) === -0 のように、丸め後に
 * ちょうど0になる負の値がJSの数値→文字列変換でマイナス符号を保持してしまうことへの対処。
 */
function stripNegativeZero(numStr: string): string {
  return /^-0(\.0+)?$/.test(numStr) ? numStr.slice(1) : numStr
}

/**
 * 円を全桁カンマ区切りで表示
 * 例: 3_642_146 → "3,642,146円"
 */
export function formatJPY(n: number | null | undefined, withUnit = true): string {
  if (n == null || !isFinite(n)) return '—'
  const s = stripNegativeZero(Math.round(n).toLocaleString('ja-JP'))
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
  const s = stripNegativeZero(man.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
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
    const s = stripNegativeZero(oku.toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
    return `${s}億円`
  }
  if (abs >= 10_000) {
    const man = n / 10_000
    const s = stripNegativeZero(man.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
    return `${s}万円`
  }
  return `${stripNegativeZero(Math.round(n).toLocaleString('ja-JP'))}円`
}

/**
 * 比率(0-1)を%表示（符号なし・水準値用。delta表示には formatSignedPct を使う）
 * 例: 0.0532 → "5.32%"
 */
export function formatPct(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return '—'
  return `${stripNegativeZero((n * 100).toFixed(decimals))}%`
}

/**
 * 既に%単位の値をそのまま表示（符号なし・水準値用。formatPctとの違いは×100しないこと）
 * 例: 5.32 → "5.32%"
 */
export function formatPctRaw(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return '—'
  return `${stripNegativeZero(n.toFixed(decimals))}%`
}

/**
 * 符号付き%表示（delta値専用。呼び出し側で%スケール済みの値を渡す）
 * 例: 5.32 → "+5.32%" / -5.32 → "-5.32%" / 0 → "0.00%"
 */
export function formatSignedPct(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return '—'
  const displayValue = stripNegativeZero(n.toFixed(decimals))
  const sign = Number(displayValue) > 0 ? '+' : ''
  return `${sign}${displayValue}%`
}

/**
 * 「最終更新」表示の正典形式（UI-9H H-P1-9）。
 * 既定は絶対（相対）の併記形式。幅制約箇所は { relative: true } で相対のみへ縮退可。
 * ラベル語「最終更新」は呼出側で付与する（本関数は値部分のみを返す）。
 */
export function formatLastUpdated(iso: string | null | undefined, opts?: { relative?: boolean }): string {
  if (iso == null) return '—'
  if (opts?.relative) return formatRelativeTime(iso)
  return `${formatDateTime(iso)}（${formatRelativeTime(iso)}）`
}

/**
 * percentage-point表示（常にdelta・符号付き。呼び出し側で%スケール済みの値を渡す）
 * 例: 3.0 → "+3.0pt" / -3.0 → "-3.0pt" / 0 → "0.0pt"
 */
export function formatPt(n: number | null | undefined, decimals = 1): string {
  if (n == null || !isFinite(n)) return '—'
  const displayValue = stripNegativeZero(n.toFixed(decimals))
  const sign = Number(displayValue) > 0 ? '+' : ''
  return `${sign}${displayValue}pt`
}

/**
 * 符号付きJPY自動表示（formatJPYAuto に符号を付与するdelta専用ラッパー）
 * 例: 380000 → "+38.0万円" / -380000 → "-38.0万円" / 0 → "0円"
 */
export function formatSignedJPY(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  const displayValue = formatJPYAuto(n)
  const sign = displayValue === '0円' ? '' : n > 0 ? '+' : ''
  return `${sign}${displayValue}`
}

/**
 * 株数表示
 * 例: 1234 → "1,234株"
 */
export function formatShares(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return `${stripNegativeZero(Math.round(n).toLocaleString('ja-JP'))}株`
}

/**
 * 株価表示（円・小数0桁）
 * 例: 3456.78 → "3,457円"
 */
export function formatPrice(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  return `${stripNegativeZero(Math.round(n).toLocaleString('ja-JP'))}円`
}

/**
 * 指数表示（カンマ・小数2桁）
 * 例: 56388.12345 → "56,388.12"
 */
export function formatIndex(n: number | null | undefined, decimals = 2): string {
  if (n == null || !isFinite(n)) return '—'
  return stripNegativeZero(n.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }))
}

const JST_DATETIME_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * ローカルTZに依存せずJST(Asia/Tokyo)で YYYY-MM-DD HH:mm を生成する内部ヘルパー。
 * CandidateFunnelPanel.formatCandidateFunnelJstTimestamp と同一のIntl設定に揃えている。
 */
function formatJstYmdHm(d: Date): string {
  const parts = JST_DATETIME_FORMATTER.formatToParts(d)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/**
 * 絶対日時表示（JST固定, YYYY-MM-DD HH:mm JST）。ローカルTZに依存しない。
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!isFinite(d.getTime())) return iso
  return `${formatJstYmdHm(d)} JST`
}

/**
 * P4.5-A003: 銘柄コードから企業名をholdings配列限定で逆引きする（表示専用）。
 * 見つからなければnullを返す（呼び出し側でコードのみ表示にfallbackさせる）。
 * 新しい判断ロジックは追加しない — 既存holdings.nameの参照のみ。
 */
export function findHoldingName(code: string, holdings: { code: string; name: string }[]): string | null {
  return holdings.find(h => h.code === code)?.name ?? null
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
    return formatJstYmdHm(new Date(iso))
  } catch {
    return iso
  }
}
