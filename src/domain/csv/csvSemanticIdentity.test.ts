import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fingerprintLegacyCsvSemanticContent,
  identifyCsvSemanticContent,
  stableSerializeCsvSemanticContent,
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
