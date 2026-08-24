// UI-9F-B — shared verdict primitive（§6.1(1)）の契約テスト。
// 表示専用変換であり、domain の decision を書き換えないことを固定する。
import { describe, expect, it } from 'vitest'
import { SUPPRESSED_VERDICT, suppressBuySignal } from './verdict'
import type { Signal } from '../badges/SignalBadge'

const ALL: Signal[] = ['BUY', 'SELL', 'HOLD', 'WATCH', 'WAIT', 'SUPPRESSED']

describe('suppressBuySignal', () => {
  it('抑制中はBUYのみSUPPRESSED_VERDICT(SUPPRESSED)へ変換する', () => {
    expect(suppressBuySignal('BUY', true)).toBe(SUPPRESSED_VERDICT)
    expect(SUPPRESSED_VERDICT).toBe('SUPPRESSED')
  })

  // UI-9H H-P0-2: 抑制トークンは「真のWATCH（監視）」と区別できる別グリフでなければ
  // ならない。WATCHへ統合する方向のmutationが起きたらここでRED化する。
  it('SUPPRESSED_VERDICTはWATCHと異なるtokenである（3義統合の回帰guard）', () => {
    expect(SUPPRESSED_VERDICT).not.toBe('WATCH')
  })

  it('抑制中でもSELL/HOLD/WATCH/WAITは変換しない（防御・監視・待機表示を弱めない）', () => {
    expect(suppressBuySignal('SELL', true)).toBe('SELL')
    expect(suppressBuySignal('HOLD', true)).toBe('HOLD')
    expect(suppressBuySignal('WATCH', true)).toBe('WATCH')
    expect(suppressBuySignal('WAIT', true)).toBe('WAIT')
  })

  // UI-9H-H1-R1: 条件未達WAITは真の監視（WATCH）とも抑制（SUPPRESSED）とも
  // 異なるtokenである（3義分離の回帰guard）。
  it('WAITはWATCHともSUPPRESSEDとも異なるtokenである', () => {
    expect('WAIT').not.toBe('WATCH')
    expect('WAIT' as Signal).not.toBe(SUPPRESSED_VERDICT)
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
