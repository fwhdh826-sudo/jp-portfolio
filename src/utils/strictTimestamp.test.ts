import { describe, expect, it } from 'vitest'
import { normalizeStrictTimestamp, parseStrictTimestamp } from './strictTimestamp'

describe('T9-A004-R1 strict timestamp parser', () => {
  it.each([
    ['2026-07-15T00:00:00Z', '2026-07-15T00:00:00.000Z'],
    ['2026-07-15T09:00:00+09:00', '2026-07-15T00:00:00.000Z'],
    ['2026-07-15T09:00:00.000+09:00', '2026-07-15T00:00:00.000Z'],
    ['2024-02-29T23:59:59.12Z', '2024-02-29T23:59:59.120Z'],
  ])('accepts strict timezone-qualified ISO %s', (input, expected) => {
    expect(normalizeStrictTimestamp(input)).toBe(expected)
  })

  it.each([
    '2025-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-01',
    '2026-07-00',
    '2026-07-32',
    '2026-07-15T25:00:00Z',
    '2026-07-15T23:60:00Z',
    '2026-07-15T23:59:60Z',
    '2026-07-15T09:00:00',
    '2026-07-15 09:00:00Z',
  ])('rejects invalid or timezone-less input %s', input => {
    expect(parseStrictTimestamp(input, { allowDateOnly: true })).toBeNull()
  })

  it('accepts valid date-only values only under the explicit JST snapshot policy', () => {
    expect(normalizeStrictTimestamp('2024-02-29')).toBeNull()
    expect(normalizeStrictTimestamp('2024-02-29', { allowDateOnly: true }))
      .toBe('2024-02-28T15:00:00.000Z')
  })
})
