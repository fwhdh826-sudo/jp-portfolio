// UI-9H P1 H-P1-6: RiskBadge の可視グリフを英語token（HIGH/MEDIUM/LOW）から
// 日本語cfg.label（高リスク/中リスク/低リスク）へ統一する。旧英語tokenは
// data-risk属性に保持し、SignalBadgeと同じ言語方針（可視=日本語・data-*=英語token）
// を適用する。値そのもの（RiskLevel union）は不変。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RiskBadge } from './RiskBadge'
import type { RiskLevel } from './RiskBadge'

function glyphOf(html: string): string | null {
  const m = html.match(/>([^<]*)<\/span>/)
  return m ? m[1] : null
}

function ariaLabelOf(html: string): string | null {
  const m = html.match(/aria-label="([^"]*)"/)
  return m ? m[1] : null
}

function dataRiskOf(html: string): string | null {
  const m = html.match(/data-risk="([^"]*)"/)
  return m ? m[1] : null
}

describe('UI-9H P1 H-P1-6: RiskBadge 可視グリフは日本語label、data-riskに旧英語token', () => {
  it('HIGH は可視グリフ「高リスク」・aria-label「高リスク」・data-risk HIGH を持つ', () => {
    const html = renderToStaticMarkup(<RiskBadge level="HIGH" />)
    expect(glyphOf(html)).toBe('高リスク')
    expect(ariaLabelOf(html)).toBe('高リスク')
    expect(dataRiskOf(html)).toBe('HIGH')
  })

  it('MEDIUM は可視グリフ「中リスク」・data-risk MEDIUM を持つ', () => {
    const html = renderToStaticMarkup(<RiskBadge level="MEDIUM" />)
    expect(glyphOf(html)).toBe('中リスク')
    expect(dataRiskOf(html)).toBe('MEDIUM')
  })

  it('LOW は可視グリフ「低リスク」・data-risk LOW を持つ', () => {
    const html = renderToStaticMarkup(<RiskBadge level="LOW" />)
    expect(glyphOf(html)).toBe('低リスク')
    expect(dataRiskOf(html)).toBe('LOW')
  })

  it('3レベルは互いに異なる可視グリフ・data-riskを持つ', () => {
    const levels: RiskLevel[] = ['HIGH', 'MEDIUM', 'LOW']
    const glyphs = levels.map(l => glyphOf(renderToStaticMarkup(<RiskBadge level={l} />)))
    const tokens = levels.map(l => dataRiskOf(renderToStaticMarkup(<RiskBadge level={l} />)))
    expect(new Set(glyphs).size).toBe(3)
    expect(tokens).toEqual(['HIGH', 'MEDIUM', 'LOW'])
  })

  // mutation guard: 可視グリフを旧英語token（{level}）へ戻すとRED化する。
  it('[mutation guard] 可視グリフは英語token（HIGH/MEDIUM/LOW）ではない', () => {
    const levels: RiskLevel[] = ['HIGH', 'MEDIUM', 'LOW']
    for (const l of levels) {
      const html = renderToStaticMarkup(<RiskBadge level={l} />)
      expect(glyphOf(html)).not.toBe(l)
    }
  })
})
