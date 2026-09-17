import { describe, expect, it } from 'vitest'
import { normalizeStrictTimestamp, parseStrictTimestamp } from './strictTimestamp'

describe('T9-A004-R1 strict timestamp parser', () => {
  it.each([
    ['2026-07-15T00:00:00Z', '2026-07-15T00:00:00.000Z'],
    ['2026-07-15T09:00:00+09:00', '2026-07-15T00:00:00.000Z'],
    ['2026-07-15T09:00:00.000+09:00', '2026-07-15T00:00:00.000Z'],
    ['2024-02-29T23:59:59.12Z', '2024-02-29T23:59:59.120Z'],
    // OPS-P5-B005-E2E-A1-PROVENANCE-R1: repaired data/update_market.py producer shape
    // (seconds now present) must keep parsing as before.
    ['2026-09-17T01:33:00+00:00', '2026-09-17T01:33:00.000Z'],
    ['2026-09-17T10:33:00+09:00', '2026-09-17T01:33:00.000Z'],
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
    // OPS-P5-B005-E2E-A1-PROVENANCE-R1: exact observed production market.json
    // last_updated value that triggered candidateDecisionSynthesis
    // MISSING_REQUIRED_PROVENANCE (minute precision, explicit UTC offset, no
    // seconds). This grammar stays strict; the producer was repaired instead.
    '2026-09-17T01:33+00:00',
  ])('rejects invalid or timezone-less input %s', input => {
    expect(parseStrictTimestamp(input, { allowDateOnly: true })).toBeNull()
  })

  it('accepts valid date-only values only under the explicit JST snapshot policy', () => {
    expect(normalizeStrictTimestamp('2024-02-29')).toBeNull()
    expect(normalizeStrictTimestamp('2024-02-29', { allowDateOnly: true }))
      .toBe('2024-02-28T15:00:00.000Z')
  })
})

describe('FCA-1-P1-03 allowMicrosecondFraction (Python isoformat compatibility)', () => {
  it('is off by default: 4-6 fraction digits remain rejected for existing callers', () => {
    expect(parseStrictTimestamp('2026-07-26T07:11:40.540540+00:00')).toBeNull()
    expect(parseStrictTimestamp('2026-07-26T07:11:40.5405+00:00')).toBeNull()
  })

  it.each([
    ['2026-07-26T07:11:40.540540+00:00', '2026-07-26T07:11:40.540Z'],
    ['2026-07-26T07:11:40.540999+00:00', '2026-07-26T07:11:40.540Z'],
    ['2026-07-26T07:11:40.5+00:00', '2026-07-26T07:11:40.500Z'],
    ['2026-07-26T07:11:40+00:00', '2026-07-26T07:11:40.000Z'],
    ['2026-07-26T16:11:40.540540+09:00', '2026-07-26T07:11:40.540Z'],
  ])('truncates (never rounds) %s to millisecond authority %s', (input, expected) => {
    expect(normalizeStrictTimestamp(input, { allowMicrosecondFraction: true })).toBe(expected)
  })

  it.each([
    '2026-07-26T07:11:40.5405401+00:00',
    '2026-09-31T00:00:00.000000+00:00',
    '2026-07-26T07:11:40.540540',
    '2026-07-26',
  ])('still rejects %s under the microsecond option', (input) => {
    expect(parseStrictTimestamp(input, { allowMicrosecondFraction: true })).toBeNull()
  })
})
