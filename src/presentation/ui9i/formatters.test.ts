import { describe, expect, it } from 'vitest'
import {
  formatJstHeaderDate,
  formatJstMonthDayTime,
  formatManYen,
  formatManYenParts,
  formatMonthDay,
  formatSignedPct1,
  formatYen,
} from './formatters'

describe('絶対時刻は JST', () => {
  it('ISO(+09:00 / Z) と タイムゾーン無し market 形式（JST 扱い）を同じ表記にする', () => {
    expect(formatJstMonthDayTime('2026-10-06T08:30:00+09:00')).toBe('10/6 8:30')
    expect(formatJstMonthDayTime('2026-10-05T23:30:00Z')).toBe('10/6 8:30')
    expect(formatJstMonthDayTime('2026-10-06 08:30')).toBe('10/6 8:30')
  })
  it('不明・不正は null（「正常」等に丸めない）', () => {
    expect(formatJstMonthDayTime(null)).toBeNull()
    expect(formatJstMonthDayTime('')).toBeNull()
    expect(formatJstMonthDayTime('not-a-date')).toBeNull()
  })
  it('ヘッダー日付', () => {
    expect(formatJstHeaderDate(new Date('2026-10-05T23:30:00Z'))).toBe('10月6日（火）')
  })
})

describe('金額 / 比率', () => {
  it('¥ 表記と万円表記', () => {
    expect(formatYen(400_000)).toBe('¥400,000')
    expect(formatYen(Number.NaN)).toBeNull()
    expect(formatManYen(38_000_000)).toBe('3,800万円')
    expect(formatManYen(1_900_000)).toBe('190万円')
    expect(formatManYen(5_000)).toBe('5,000円')
    expect(formatManYen(0)).toBe('0万円')
    expect(formatManYen(null)).toBeNull()
  })
  it('売却可能予定日 M/D', () => {
    expect(formatMonthDay('2026-10-30')).toBe('10/30')
    expect(formatMonthDay(null)).toBeNull()
    expect(formatMonthDay('bad')).toBeNull()
  })
  it('符号付き %', () => {
    expect(formatSignedPct1(0.6)).toBe('+0.6%')
    expect(formatSignedPct1(-0.1)).toBe('-0.1%')
    expect(formatSignedPct1(null)).toBeNull()
  })
})

describe('formatManYenParts: 大きな数字 + 小さな単位（formatManYen と同値）', () => {
  it('万円 / 円 の分割。値は formatManYen と常に一致する', () => {
    expect(formatManYenParts(38_000_000)).toEqual({ value: '3,800', unit: '万円' })
    expect(formatManYenParts(5_000)).toEqual({ value: '5,000', unit: '円' })
    expect(formatManYenParts(0)).toEqual({ value: '0', unit: '万円' })
    for (const n of [38_000_000, 5_000, 0, 1_140_000, -1_900_000, 9_999, 10_000]) {
      const p = formatManYenParts(n)!
      expect(`${p.value}${p.unit}`).toBe(formatManYen(n))
    }
  })
  it('非有限・null は null（0 に丸めない）', () => {
    expect(formatManYenParts(Number.NaN)).toBeNull()
    expect(formatManYenParts(Number.POSITIVE_INFINITY)).toBeNull()
    expect(formatManYenParts(null)).toBeNull()
    expect(formatManYenParts(undefined)).toBeNull()
  })
})
