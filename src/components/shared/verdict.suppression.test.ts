// UI-9F-B — shared verdict primitive（§6.1(1)）の契約テスト。
// 表示専用変換であり、domain の decision を書き換えないことを固定する。
import { describe, expect, it } from 'vitest'
import { SUPPRESSED_VERDICT, suppressBuySignal } from './verdict'
import type { Signal } from '../badges/SignalBadge'

const ALL: Signal[] = ['BUY', 'SELL', 'HOLD', 'WATCH']

describe('suppressBuySignal', () => {
  it('抑制中はBUYのみSUPPRESSED_VERDICT(WATCH)へ変換する', () => {
    expect(suppressBuySignal('BUY', true)).toBe(SUPPRESSED_VERDICT)
    expect(SUPPRESSED_VERDICT).toBe('WATCH')
  })

  it('抑制中でもSELL/HOLD/WATCHは変換しない（防御・監視表示を弱めない）', () => {
    expect(suppressBuySignal('SELL', true)).toBe('SELL')
    expect(suppressBuySignal('HOLD', true)).toBe('HOLD')
    expect(suppressBuySignal('WATCH', true)).toBe('WATCH')
  })

  it('非抑制時は全tokenを素通しする', () => {
    for (const s of ALL) expect(suppressBuySignal(s, false)).toBe(s)
  })

  it('抑制後にBUYが残るtokenは存在しない', () => {
    expect(ALL.map(s => suppressBuySignal(s, true)).filter(s => s === 'BUY')).toHaveLength(0)
  })

  it('入力オブジェクトを持たない純関数であり、呼び出しは冪等', () => {
    expect(suppressBuySignal(suppressBuySignal('BUY', true), true)).toBe(SUPPRESSED_VERDICT)
  })
})
