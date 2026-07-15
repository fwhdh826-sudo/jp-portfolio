import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareCsvSemanticRows,
  fingerprintLegacyCsvSemanticContent,
  identifyCsvSemanticContent,
  serializeCsvSemanticRowForOrdering,
  stableSerializeCsvSemanticContent,
  type CsvSemanticRow,
} from './csvSemanticIdentity'

describe('T9-A004-R1 strong semantic identity', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses deterministic key ordering and UTF-8 SHA-256', () => {
    expect(stableSerializeCsvSemanticContent({ b: 2, a: '日本' }))
      .toBe(stableSerializeCsvSemanticContent({ a: '日本', b: 2 }))
    expect(identifyCsvSemanticContent('abc'))
      .toBe('sha256:6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25')
    expect(identifyCsvSemanticContent('a'.repeat(100)))
      .toBe('sha256:9391a07725c98cf85690b4a992a923ca96c7026e9291ef811844d9868734f4e3')
    expect(identifyCsvSemanticContent('日本語✅'))
      .toBe('sha256:de20f24ff831104aeb11d6e6df3a1c906af1a150a7355a80f2c304565fd98af2')
  })

  it.each([
    ['empty', '', '12ae32cb1ec02d01eda3581b127c1fee3b0dc53572ed6baf239721a03d82e126'],
    ['abc', 'abc', '6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25'],
    ['Japanese', '日本語', 'd2b94e6e664483bbf04d80902abc235527ab68cecf488e8abe22112a6dd62bd4'],
    ['emoji', '😀✅', '43f3e3bfb972e299e0a987eb6fca7ae3dc482a2e627bb1cdaf34a906f82694f5'],
    ['55 serialized bytes', 'a'.repeat(53), '2ae89a8121a3f9d2709899b414da4c60234316951093ce35f41ce954a09533f4'],
    ['56 serialized bytes', 'a'.repeat(54), '9b68496ab8c784a9ed22d25a7e3aada1736d7097061bb3149f3d66f1e22ceeef'],
    ['63 serialized bytes', 'a'.repeat(61), '813662a26c997431c1990ca2424fad200f23983afe7b5543e2daf2748da424a2'],
    ['64 serialized bytes', 'a'.repeat(62), '1cd1b6277a35426076612315059afa72e6903b84575ebdd1507d73697be9dbd3'],
    ['65 serialized bytes', 'a'.repeat(63), 'e7d55ca10614618e5755859f93ac280712a04f76466e7bc65e4f488f1153ec70'],
    ['multi-block', 'a'.repeat(300), '807cbaadeb1a11f45b5166c861556d2f766e98b1f2c043f45f3f7f68f0eb0bae'],
  ])('matches an independent standard SHA-256 oracle vector for %s', (_label, value, expected) => {
    expect(stableSerializeCsvSemanticContent(value).length).toBeGreaterThan(0)
    expect(identifyCsvSemanticContent(value)).toBe(`sha256:${expected}`)
  })

  it('keeps legacy FNV available only for persistence compatibility', () => {
    expect(fingerprintLegacyCsvSemanticContent({ rows: [] })).toMatch(/^fnv1a32:[0-9a-f]{8}$/)
  })

  it('fails closed when strong identity generation is unavailable', () => {
    class ThrowingTextEncoder {
      encode(): Uint8Array { throw new Error('encoder unavailable') }
    }
    vi.stubGlobal('TextEncoder', ThrowingTextEncoder)

    expect(() => identifyCsvSemanticContent({ rows: [] })).toThrow('encoder unavailable')
  })
})

describe('T9-A004-R1-F1 semantic row comparator', () => {
  const base: CsvSemanticRow = {
    assetType: 'stock',
    code: '6501',
    name: '日立製作所',
    eval: 900_000,
    pnlPct: 15.2,
    dayPct: 1.1,
    price: 8500,
    acquiredAt: '2025-06-01',
    accountHint: '特定',
  }

  it.each([
    ['assetType', { assetType: 'trust' as const }],
    ['code', { code: '7203' }],
    ['name あ/ア', { name: 'あ' }],
    ['name A/a', { name: 'a' }],
    ['name é/e', { name: 'é' }],
    ['name emoji/surrogate pair', { name: '😀' }],
    ['name empty', { name: '' }],
    ['eval', { eval: 900_001 }],
    ['pnlPct', { pnlPct: 15.21 }],
    ['dayPct', { dayPct: 1.11 }],
    ['price', { price: 8501 }],
    ['acquiredAt', { acquiredAt: null }],
    ['accountHint', { accountHint: 'NISA成長' as const }],
  ])('orders distinct normalized rows by %s without returning zero', (_label, change) => {
    const other = { ...base, ...change }
    const forward = compareCsvSemanticRows(base, other)
    const reverse = compareCsvSemanticRows(other, base)
    expect(forward).not.toBe(0)
    expect(reverse).toBe(-forward)
    expect(serializeCsvSemanticRowForOrdering(base))
      .not.toBe(serializeCsvSemanticRowForOrdering(other))
  })

  it('treats NFKC-equivalent strings and numeric 0/-0 as exact semantic key equality', () => {
    const normalized = (name: string, dayPct: number): CsvSemanticRow => ({
      ...base,
      name: name.normalize('NFKC'),
      dayPct,
    })
    expect(compareCsvSemanticRows(normalized('ＡＢＣ', -0), normalized('ABC', 0))).toBe(0)
    expect(compareCsvSemanticRows(normalized('e\u0301', -0), normalized('é', 0))).toBe(0)
  })

  it('forms a deterministic total order across repeated permutations', () => {
    const rows: CsvSemanticRow[] = [
      { ...base, name: 'ア' },
      { ...base, name: 'あ' },
      { ...base, name: 'A' },
      { ...base, name: 'a' },
      { ...base, name: 'é' },
      { ...base, name: 'e' },
      { ...base, name: '😀' },
      { ...base, name: '' },
      { ...base, acquiredAt: null },
      { ...base, accountHint: 'NISA積立' },
    ]
    const expected = [...rows].sort(compareCsvSemanticRows).map(serializeCsvSemanticRowForOrdering)
    for (let offset = 0; offset < rows.length; offset += 1) {
      const permuted = [...rows.slice(offset), ...rows.slice(0, offset)].reverse()
      expect(permuted.sort(compareCsvSemanticRows).map(serializeCsvSemanticRowForOrdering)).toEqual(expected)
    }
  })
})
