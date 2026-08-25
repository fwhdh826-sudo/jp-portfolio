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

// UI-9H P1 H-P1-6: 可視グリフは英語token→日本語cfg.labelへ変更。旧英語tokenは
// data-signal属性に保持される（P0のtoken分離自体は不変）。
function dataSignalOf(html: string): string | null {
  const m = html.match(/data-signal="([^"]*)"/)
  return m ? m[1] : null
}

describe('UI9-H-H1-R1: WATCH完成contract — A監視/B待機/C抑制中の3義分離', () => {
  it('A: 真の監視 = WATCH は可視グリフ「監視」・aria-label「シグナル: 監視」・data-signal WATCH を持つ', () => {
    const html = renderToStaticMarkup(<SignalBadge signal="WATCH" />)
    expect(glyphOf(html)).toBe('監視')
    expect(ariaLabelOf(html)).toBe('シグナル: 監視')
    expect(dataSignalOf(html)).toBe('WATCH')
  })

  it('B: 条件未達WAIT = WAIT は可視グリフ「待機」・aria-label「シグナル: 待機」・data-signal WAIT を持つ', () => {
    const html = renderToStaticMarkup(<SignalBadge signal="WAIT" />)
    expect(glyphOf(html)).toBe('待機')
    expect(ariaLabelOf(html)).toBe('シグナル: 待機')
    expect(dataSignalOf(html)).toBe('WAIT')
  })

  it('C: BUY抑制 = SUPPRESSED は可視グリフ「抑制中」・aria-label「シグナル: 抑制中」・data-signal SUPPRESSED を持つ', () => {
    const html = renderToStaticMarkup(<SignalBadge signal={SUPPRESSED_VERDICT} />)
    expect(glyphOf(html)).toBe('抑制中')
    expect(ariaLabelOf(html)).toBe('シグナル: 抑制中')
    expect(dataSignalOf(html)).toBe('SUPPRESSED')
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

  it('A/B/C の3トークンは互いに異なるdata-signal（旧英語token）を持つ', () => {
    const tokens = (['WATCH', 'WAIT', 'SUPPRESSED'] as Signal[]).map(
      s => dataSignalOf(renderToStaticMarkup(<SignalBadge signal={s} />)),
    )
    expect(tokens).toEqual(['WATCH', 'WAIT', 'SUPPRESSED'])
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
