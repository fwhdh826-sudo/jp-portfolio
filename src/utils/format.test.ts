// P4.5-A003: findHoldingName — 銘柄コード比較表示への企業名併記のためのlookupヘルパー
// UI-9E: display convention formatter群のcontract test（R2/R3/R4/R6/R7）
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findHoldingName,
  formatDateTime,
  formatIndex,
  formatJPY,
  formatJPYAuto,
  formatJPYMan,
  formatLastUpdated,
  formatPct,
  formatPctRaw,
  formatPrice,
  formatPt,
  formatRelativeTime,
  formatShares,
  formatSignedJPY,
  formatSignedPct,
} from './format'

// U+2212 (MINUS SIGN) を表示に使ってはならない（R2.1）。ASCII '-' (U+002D) に統一する。
const MINUS_SIGN_U2212 = '−'

function expectNoU2212(s: string) {
  expect(s).not.toContain(MINUS_SIGN_U2212)
}

describe('findHoldingName', () => {
  const holdings = [
    { code: '6501', name: '日立製作所' },
    { code: '7203', name: 'トヨタ自動車' },
  ]

  it('codeが一致するholdingsのnameを返す', () => {
    expect(findHoldingName('6501', holdings)).toBe('日立製作所')
    expect(findHoldingName('7203', holdings)).toBe('トヨタ自動車')
  })

  it('一致するcodeがない場合はnullを返す（コードのみ表示へfallback）', () => {
    expect(findHoldingName('9999', holdings)).toBeNull()
  })

  it('holdingsが空配列の場合はnullを返す', () => {
    expect(findHoldingName('6501', [])).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────
// T-1 / T-2 / T-3: 全formatterの 正/負/0/null/Infinity/NaN 6ケース
// 負号はASCII '-'固定・0は符号なし・+0や±0を生成しない
// ─────────────────────────────────────────────────────────────

describe('formatJPY（水準値・符号なし）', () => {
  it('正の値: カンマ区切り+円', () => {
    expect(formatJPY(3_642_146)).toBe('3,642,146円')
  })
  it('負の値: ASCIIマイナス表記（水準値のため符号付与ロジックはなくtoLocaleString由来）', () => {
    const s = formatJPY(-3_642_146)
    expect(s).toBe('-3,642,146円')
    expectNoU2212(s)
  })
  it('0: 符号なし', () => {
    expect(formatJPY(0)).toBe('0円')
  })
  it('null/undefined: —', () => {
    expect(formatJPY(null)).toBe('—')
    expect(formatJPY(undefined)).toBe('—')
  })
  it('Infinity/NaN: —', () => {
    expect(formatJPY(Infinity)).toBe('—')
    expect(formatJPY(-Infinity)).toBe('—')
    expect(formatJPY(NaN)).toBe('—')
  })
})

describe('formatJPYAuto（水準値・円/万円/億円自動切替）', () => {
  it('正の値（万円スケール）', () => {
    expect(formatJPYAuto(380_000)).toBe('38.0万円')
  })
  it('正の値（億円スケール）', () => {
    expect(formatJPYAuto(380_000_000)).toBe('3.80億円')
  })
  it('負の値: ASCIIマイナス', () => {
    const s = formatJPYAuto(-380_000)
    expect(s).toBe('-38.0万円')
    expectNoU2212(s)
  })
  it('0: 符号なし', () => {
    expect(formatJPYAuto(0)).toBe('0円')
  })
  it('null/undefined: —', () => {
    expect(formatJPYAuto(null)).toBe('—')
    expect(formatJPYAuto(undefined)).toBe('—')
  })
  it('Infinity/NaN: —', () => {
    expect(formatJPYAuto(Infinity)).toBe('—')
    expect(formatJPYAuto(NaN)).toBe('—')
  })
})

describe('formatSignedJPY（delta専用・符号付き、R2.3/R2.4）', () => {
  it('正の値: +が付与される', () => {
    expect(formatSignedJPY(380_000)).toBe('+38.0万円')
  })
  it('負の値: ASCIIマイナスのみ（+は付与されない）', () => {
    const s = formatSignedJPY(-380_000)
    expect(s).toBe('-38.0万円')
    expectNoU2212(s)
  })
  it('0: 符号なし（+0を生成しない）', () => {
    expect(formatSignedJPY(0)).toBe('0円')
    expect(formatSignedJPY(0)).not.toMatch(/^\+/)
  })
  it.each([
    [0, '0円'], [-0, '0円'],
    [0.3, '0円'], [-0.3, '0円'],
    [0.49, '0円'], [-0.49, '0円'],
    [0.5, '+1円'], [-0.5, '0円'],
  ] as const)('rounded-zero境界: %s → %s', (input, expected) => {
    const actual = formatSignedJPY(input)
    expect(actual).toBe(expected)
    expectNoU2212(actual)
    if (/^[-+]?0(?:[.,]0+)?円$/.test(actual)) expect(actual).not.toMatch(/^[-+]/)
  })
  it.each([
    [9_999.49, '+9,999円'], [9_999.5, '+10,000円'], [10_000, '+1.0万円'],
    [-9_999.49, '-9,999円'], [-9_999.5, '-9,999円'], [-10_000, '-1.0万円'],
    [99_999_999.49, '+10,000.0万円'], [99_999_999.5, '+10,000.0万円'], [100_000_000, '+1.00億円'],
    [-99_999_999.49, '-10,000.0万円'], [-99_999_999.5, '-10,000.0万円'], [-100_000_000, '-1.00億円'],
  ] as const)('単位切替境界: %s → %s', (input, expected) => {
    const actual = formatSignedJPY(input)
    expect(actual).toBe(expected)
    expectNoU2212(actual)
  })
  it('null/undefined: —', () => {
    expect(formatSignedJPY(null)).toBe('—')
    expect(formatSignedJPY(undefined)).toBe('—')
  })
  it('Infinity/NaN: —', () => {
    expect(formatSignedJPY(Infinity)).toBe('—')
    expect(formatSignedJPY(NaN)).toBe('—')
  })
})

describe('formatPct（水準値・比率0-1→%・符号なし, T-5）', () => {
  it('ratio→%変換（0.0532 → "5.32%"、符号なし）', () => {
    expect(formatPct(0.0532)).toBe('5.32%')
  })
  it('負のratioでもASCIIマイナスのみ（符号付与ロジックなし）', () => {
    const s = formatPct(-0.0532)
    expect(s).toBe('-5.32%')
    expectNoU2212(s)
  })
  it('0: "0.00%"', () => {
    expect(formatPct(0)).toBe('0.00%')
  })
  it('null/undefined: —', () => {
    expect(formatPct(null)).toBe('—')
    expect(formatPct(undefined)).toBe('—')
  })
  it('Infinity/NaN: —', () => {
    expect(formatPct(Infinity)).toBe('—')
    expect(formatPct(NaN)).toBe('—')
  })
})

describe('formatPctRaw（水準値・既に%スケール・符号なし, T-5）', () => {
  it('×100しない（5.32 → "5.32%"）— formatPctとの差はスケール変換の有無', () => {
    expect(formatPctRaw(5.32)).toBe('5.32%')
    expect(formatPctRaw(5.32)).not.toBe(formatPct(5.32)) // formatPctは532.00%になり明確に異なる
  })
  it('0: "0.00%"', () => {
    expect(formatPctRaw(0)).toBe('0.00%')
  })
  it('null/undefined: —', () => {
    expect(formatPctRaw(null)).toBe('—')
  })
  it('Infinity/NaN: —', () => {
    expect(formatPctRaw(Infinity)).toBe('—')
    expect(formatPctRaw(NaN)).toBe('—')
  })
})

describe('formatSignedPct（delta専用・既に%スケール・符号付き, R2.3/R2.4）', () => {
  it('正の値: +が付与される', () => {
    expect(formatSignedPct(5.32)).toBe('+5.32%')
  })
  it('負の値: ASCIIマイナスのみ', () => {
    const s = formatSignedPct(-5.32)
    expect(s).toBe('-5.32%')
    expectNoU2212(s)
  })
  it('0: 符号なし（+0/±0を生成しない）', () => {
    expect(formatSignedPct(0)).toBe('0.00%')
  })
  it.each([
    [0, 0, '0%'], [-0, 0, '0%'], [0.004, 0, '0%'], [-0.004, 0, '0%'], [0.005, 0, '0%'], [-0.005, 0, '0%'], [0.009, 0, '0%'], [-0.009, 0, '0%'],
    [0, 1, '0.0%'], [-0, 1, '0.0%'], [0.004, 1, '0.0%'], [-0.004, 1, '0.0%'], [0.005, 1, '0.0%'], [-0.005, 1, '0.0%'], [0.009, 1, '0.0%'], [-0.009, 1, '0.0%'],
    [0, 2, '0.00%'], [-0, 2, '0.00%'], [0.004, 2, '0.00%'], [-0.004, 2, '0.00%'], [0.005, 2, '+0.01%'], [-0.005, 2, '-0.01%'], [0.009, 2, '+0.01%'], [-0.009, 2, '-0.01%'],
  ] as const)('rounded-zero境界: value=%s decimals=%s → %s', (input, decimals, expected) => {
    const actual = formatSignedPct(input, decimals)
    expect(actual).toBe(expected)
    expectNoU2212(actual)
    if (/^[-+]?0(?:\.0+)?%$/.test(actual)) expect(actual).not.toMatch(/^[-+]/)
  })
  it('null/undefined: —', () => {
    expect(formatSignedPct(null)).toBe('—')
    expect(formatSignedPct(undefined)).toBe('—')
  })
  it('Infinity/NaN: —', () => {
    expect(formatSignedPct(Infinity)).toBe('—')
    expect(formatSignedPct(NaN)).toBe('—')
  })
})

describe('formatPt（percentage-point・常にdelta・符号付き, R5）', () => {
  it('正の値: +pt', () => {
    expect(formatPt(3.0)).toBe('+3.0pt')
  })
  it('負の値: ASCIIマイナス+pt（U+2212は使わない）', () => {
    const s = formatPt(-3.0)
    expect(s).toBe('-3.0pt')
    expectNoU2212(s)
  })
  it('0: 符号なし（+0pt/±0ptを生成しない）', () => {
    expect(formatPt(0)).toBe('0.0pt')
  })
  it.each([
    [0.04, 0, '0pt'], [-0.04, 0, '0pt'], [0.05, 0, '0pt'], [-0.05, 0, '0pt'], [0.09, 0, '0pt'], [-0.09, 0, '0pt'],
    [0.04, 1, '0.0pt'], [-0.04, 1, '0.0pt'], [0.05, 1, '+0.1pt'], [-0.05, 1, '-0.1pt'], [0.09, 1, '+0.1pt'], [-0.09, 1, '-0.1pt'],
    [0.04, 2, '+0.04pt'], [-0.04, 2, '-0.04pt'], [0.05, 2, '+0.05pt'], [-0.05, 2, '-0.05pt'], [0.09, 2, '+0.09pt'], [-0.09, 2, '-0.09pt'],
  ] as const)('rounded-zero境界: value=%s decimals=%s → %s', (input, decimals, expected) => {
    const actual = formatPt(input, decimals)
    expect(actual).toBe(expected)
    expectNoU2212(actual)
    if (/^[-+]?0(?:\.0+)?pt$/.test(actual)) expect(actual).not.toMatch(/^[-+]/)
  })
  it('null/undefined: —', () => {
    expect(formatPt(null)).toBe('—')
    expect(formatPt(undefined)).toBe('—')
  })
  it('Infinity/NaN: —', () => {
    expect(formatPt(Infinity)).toBe('—')
    expect(formatPt(NaN)).toBe('—')
  })
  it('vixChg精度（decimals=2）: R4準拠', () => {
    expect(formatPt(0.66, 2)).toBe('+0.66pt')
  })
})

describe('負のゼロ（-0）正規化（R2.4回帰: Math.round(-0.3)===-0 由来の"-0円"等を防ぐ）', () => {
  // 実データ（v13.3-dev, 2026-08-22時点のT4「要削減」カード）で "-0円" が実際に描画される
  // ケースを再現した回帰テスト。totalToSellが四捨五入でちょうど0になる際に
  // formatSignedJPY(-totalToSell) が "-0円" を出さないことを保証する。
  it('formatJPYAuto: 丸めて0になる微小負値は"-0円"にならない', () => {
    expect(formatJPYAuto(-0.3)).toBe('0円')
    expect(formatJPYAuto(-0)).toBe('0円')
  })
  it('formatSignedJPY: 微小負値（要削減0件相当）は符号なし"0円"になる', () => {
    const totalToSell = 0.3
    expect(formatSignedJPY(-totalToSell)).toBe('0円')
  })
  it('formatJPY: 丸めて0になる微小負値は"-0円"にならない', () => {
    expect(formatJPY(-0.3)).toBe('0円')
  })
  it('formatJPYMan: 万円スケールで丸めて0.0になる微小負値は"-0.0万円"にならない', () => {
    expect(formatJPYMan(-1)).toBe('0.0万円')
  })
  it('formatPt: 丸めて0.0になる微小負値は"-0.0pt"にならない', () => {
    expect(formatPt(-0.01, 1)).toBe('0.0pt')
  })
  it('formatSignedPct: 丸めて0.00になる微小負値は"-0.00%"にならない', () => {
    expect(formatSignedPct(-0.001)).toBe('0.00%')
  })
})

describe('formatShares / formatPrice / formatIndex / formatJPYMan（水準値の null/Infinity/NaN 契約）', () => {
  it('formatShares', () => {
    expect(formatShares(1234)).toBe('1,234株')
    expect(formatShares(null)).toBe('—')
    expect(formatShares(Infinity)).toBe('—')
    expect(formatShares(NaN)).toBe('—')
  })
  it('formatPrice', () => {
    expect(formatPrice(3456.78)).toBe('3,457円')
    expect(formatPrice(null)).toBe('—')
    expect(formatPrice(Infinity)).toBe('—')
    expect(formatPrice(NaN)).toBe('—')
  })
  it('formatIndex', () => {
    expect(formatIndex(56388.12345)).toBe('56,388.12')
    expect(formatIndex(null)).toBe('—')
    expect(formatIndex(Infinity)).toBe('—')
    expect(formatIndex(NaN)).toBe('—')
  })
  it('formatJPYMan', () => {
    expect(formatJPYMan(3_642_146)).toBe('364.2万円')
    expect(formatJPYMan(null)).toBe('—')
    expect(formatJPYMan(Infinity)).toBe('—')
    expect(formatJPYMan(NaN)).toBe('—')
  })
})

// ─────────────────────────────────────────────────────────────
// T-4: formatDateTime は process.env.TZ に依存せず常にJSTを返す（R6.1）
// ─────────────────────────────────────────────────────────────

// @ts-expect-error -- repositoryは@types/node非依存だがVitestのNode runtimeでのみ使用する
const processRef: { env: Record<string, string | undefined> } = process

function setTZ(tz: string) {
  processRef.env.TZ = tz
}

describe('formatDateTime（JST固定, R6.1/R6.2/R6.3）', () => {
  const originalTZ = processRef.env.TZ
  afterEach(() => {
    processRef.env.TZ = originalTZ
  })

  it('TZ=UTC でもJST（+9h）で YYYY-MM-DD HH:mm JST を返す', () => {
    setTZ('UTC')
    expect(formatDateTime('2026-08-21T12:34:00Z')).toBe('2026-08-21 21:34 JST')
  })

  it('TZ=America/New_York でも同一のJST出力になる（TZ非依存）', () => {
    setTZ('America/New_York')
    expect(formatDateTime('2026-08-21T12:34:00Z')).toBe('2026-08-21 21:34 JST')
  })

  it('日付をまたぐUTC時刻でもJST変換後の正しい日付になる', () => {
    setTZ('UTC')
    // UTC 2026-08-21T20:00:00Z → JST 2026-08-22 05:00
    expect(formatDateTime('2026-08-21T20:00:00Z')).toBe('2026-08-22 05:00 JST')
  })

  it('null/undefined: —', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime(undefined)).toBe('—')
  })

  it('不正な文字列はそのまま返す（例外を投げない）', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })
})

// ─────────────────────────────────────────────────────────────
// UI-9H H-P1-9: formatLastUpdated — 「最終更新」表示の正典形式
// 既定＝絶対（相対）の併記。{ relative: true } で相対のみへ縮退。
// ─────────────────────────────────────────────────────────────

describe('formatLastUpdated（UI-9H H-P1-9正典契約）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('既定は "絶対（相対）" 併記形式を返す（T9正典）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:05:00Z'))
    expect(formatLastUpdated('2026-08-21T12:00:00Z')).toBe('2026-08-21 21:00 JST（5分前）')
  })

  it('{ relative: true } は相対のみを返す（絶対時刻を含まない・幅制約箇所の縮退形式）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:05:00Z'))
    const s = formatLastUpdated('2026-08-21T12:00:00Z', { relative: true })
    expect(s).toBe('5分前')
    expect(s).not.toContain('JST')
    expect(s).not.toContain('（')
  })

  it('null/undefined: —', () => {
    expect(formatLastUpdated(null)).toBe('—')
    expect(formatLastUpdated(undefined)).toBe('—')
    expect(formatLastUpdated(null, { relative: true })).toBe('—')
  })

  it('旧手書きフォーマット（絶対のみ・後置ラベル・括弧なし相対のみ）のいずれとも一致しない', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:05:00Z'))
    const full = formatLastUpdated('2026-08-21T12:00:00Z')
    // 旧StatusBar形式（絶対のみ、相対なし）
    expect(full).not.toBe(formatDateTime('2026-08-21T12:00:00Z'))
    // 旧T2/T3形式（相対のみ、括弧なし）
    expect(full).not.toBe(formatRelativeTime('2026-08-21T12:00:00Z'))
    // 括弧は全角（半角括弧を使わない）
    expect(full).toContain('（')
    expect(full).toContain('）')
    expect(full).not.toContain('(')
    expect(full).not.toContain(')')
  })
})

describe('formatRelativeTime（相対時刻はJST接尾辞なし, R6.3）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('1分未満は「たった今」', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:00:30Z'))
    expect(formatRelativeTime('2026-08-21T12:00:00Z')).toBe('たった今')
  })

  it('60分未満は「N分前」', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:05:00Z'))
    expect(formatRelativeTime('2026-08-21T12:00:00Z')).toBe('5分前')
  })

  it('30日以上前はJST絶対日時にフォールバックし、末尾に" JST"を付さない', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'))
    // 2026-01-01T03:00:00Z → JST 12:00 同日
    const s = formatRelativeTime('2026-01-01T03:00:00Z')
    expect(s).toBe('2026-01-01 12:00')
    expect(s).not.toContain('JST')
  })

  it('null/undefined: —', () => {
    expect(formatRelativeTime(null)).toBe('—')
    expect(formatRelativeTime(undefined)).toBe('—')
  })
})
