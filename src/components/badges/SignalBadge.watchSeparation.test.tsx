// UI-9H H-P0-2: 可視トークン WATCH が「監視」「条件未達WAIT」「抑制されたBUY」の
// 3義を同一グリフで担っていた（同一リスト内で判別不能）。
// 最小 P0 修正は③（抑制）のみを専用トークン SUPPRESSED に分離するもので、
// ①監視=WATCH・③抑制=SUPPRESSED が別グリフ・別 aria-label を持つことを固定する。
// 統合方向（3者を1語に戻す）へのmutationはここでRED化する。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SignalBadge } from './SignalBadge'
import { SUPPRESSED_VERDICT, suppressBuySignal } from '../shared/verdict'

function ariaLabelOf(html: string): string | null {
  const m = html.match(/aria-label="([^"]*)"/)
  return m ? m[1] : null
}

function glyphOf(html: string): string | null {
  const m = html.match(/>([^<]*)<\/span>/)
  return m ? m[1] : null
}

describe('UI-9H H-P0-2: WATCH（監視）と SUPPRESSED（抑制）は別トークンである', () => {
  it('WATCH の可視グリフと aria-label は「監視」を示す', () => {
    const html = renderToStaticMarkup(<SignalBadge signal="WATCH" />)
    expect(glyphOf(html)).toBe('WATCH')
    expect(ariaLabelOf(html)).toBe('シグナル: 監視')
  })

  it('SUPPRESSED_VERDICT（抑制トークン）の可視グリフと aria-label は WATCH/監視と異なる', () => {
    const html = renderToStaticMarkup(<SignalBadge signal={SUPPRESSED_VERDICT} />)
    expect(glyphOf(html)).toBe('SUPPRESSED')
    expect(glyphOf(html)).not.toBe('WATCH')
    expect(ariaLabelOf(html)).toBe('シグナル: 抑制中')
    expect(ariaLabelOf(html)).not.toBe('シグナル: 監視')
  })

  it('suppressBuySignal(BUY, true) が生成するトークンは WATCH ではない（③抑制の分離）', () => {
    const token = suppressBuySignal('BUY', true)
    expect(token).not.toBe('WATCH')
    const html = renderToStaticMarkup(<SignalBadge signal={token} />)
    expect(ariaLabelOf(html)).not.toBe('シグナル: 監視')
  })

  // mutation guard: SUPPRESSED_VERDICT を 'WATCH' に戻す（＝3義統合）と RED になる
  it('[mutation guard] SUPPRESSED と WATCH の aria-label が一致しない', () => {
    const watchHtml      = renderToStaticMarkup(<SignalBadge signal="WATCH" />)
    const suppressedHtml = renderToStaticMarkup(<SignalBadge signal={SUPPRESSED_VERDICT} />)
    expect(ariaLabelOf(suppressedHtml)).not.toBe(ariaLabelOf(watchHtml))
  })
})
