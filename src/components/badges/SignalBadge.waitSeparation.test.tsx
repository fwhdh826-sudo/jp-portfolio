// UI-9H-H1-R1: WATCH の3義完成contract。
// A 真の監視     → WATCH  / 「監視」
// B 条件未達WAIT → WAIT   / 「待機」
// C BUY抑制      → SUPPRESSED / 「抑制中」
// の3トークンが SignalBadge レベルで相互に異なるグリフ・aria-labelを持つことを固定する。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SignalBadge } from './SignalBadge'
import { SUPPRESSED_VERDICT, suppressBuySignal } from '../shared/verdict'
import type { Signal } from './SignalBadge'

function ariaLabelOf(html: string): string | null {
  const m = html.match(/aria-label="([^"]*)"/)
  return m ? m[1] : null
}

function glyphOf(html: string): string | null {
  const m = html.match(/>([^<]*)<\/span>/)
  return m ? m[1] : null
}

describe('UI9-H-H1-R1: WATCH完成contract — A監視/B待機/C抑制中の3義分離', () => {
  it('A: 真の監視 = WATCH は可視グリフ WATCH・aria-label「シグナル: 監視」を持つ', () => {
    const html = renderToStaticMarkup(<SignalBadge signal="WATCH" />)
    expect(glyphOf(html)).toBe('WATCH')
    expect(ariaLabelOf(html)).toBe('シグナル: 監視')
  })

  it('B: 条件未達WAIT = WAIT は可視グリフ WAIT・aria-label「シグナル: 待機」を持つ', () => {
    const html = renderToStaticMarkup(<SignalBadge signal="WAIT" />)
    expect(glyphOf(html)).toBe('WAIT')
    expect(ariaLabelOf(html)).toBe('シグナル: 待機')
  })

  it('C: BUY抑制 = SUPPRESSED は可視グリフ SUPPRESSED・aria-label「シグナル: 抑制中」を持つ', () => {
    const html = renderToStaticMarkup(<SignalBadge signal={SUPPRESSED_VERDICT} />)
    expect(glyphOf(html)).toBe('SUPPRESSED')
    expect(ariaLabelOf(html)).toBe('シグナル: 抑制中')
  })

  it('A/B/C の3トークンは互いに異なるaria-labelを持つ', () => {
    const labels = (['WATCH', 'WAIT', 'SUPPRESSED'] as Signal[]).map(
      s => ariaLabelOf(renderToStaticMarkup(<SignalBadge signal={s} />)),
    )
    expect(new Set(labels).size).toBe(3)
  })

  it('A/B/C の3トークンは互いに異なる可視グリフを持つ', () => {
    const glyphs = (['WATCH', 'WAIT', 'SUPPRESSED'] as Signal[]).map(
      s => glyphOf(renderToStaticMarkup(<SignalBadge signal={s} />)),
    )
    expect(new Set(glyphs).size).toBe(3)
  })

  it('suppressBuySignal(BUY, true) が生成するCトークンはBUYへ漏れない', () => {
    const token = suppressBuySignal('BUY', true)
    expect(token).toBe(SUPPRESSED_VERDICT)
    expect(token).not.toBe('BUY')
  })

  // mutation guard: いずれか2トークンが同一aria-labelへ統合（3義のいずれかを1語に戻す）
  // 方向のmutationが起きるとこの一覧のsize<3でRED化する。
  it('[mutation guard] WATCH→WAIT統合、WAIT→WATCH統合、いずれの向きの回帰もRED化する', () => {
    const watch = ariaLabelOf(renderToStaticMarkup(<SignalBadge signal="WATCH" />))
    const wait  = ariaLabelOf(renderToStaticMarkup(<SignalBadge signal="WAIT" />))
    const supp  = ariaLabelOf(renderToStaticMarkup(<SignalBadge signal={SUPPRESSED_VERDICT} />))
    expect(watch).not.toBe(wait)
    expect(watch).not.toBe(supp)
    expect(wait).not.toBe(supp)
  })
})
