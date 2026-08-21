import { describe, expect, it } from 'vitest'
import { typography } from './typography'

// UI-9D P1-8回帰防止: sectionTitle(L3) < cardTitle(L4) だったtoken逆転を解消したことを固定する。
// 凍結スケール: pageTitle(L1)=22 > sectionTitle(L3)=14 > cardTitle(L4)=13 > caption(L5)=11

function px(style: { fontSize?: string }): number {
  return Number(String(style.fontSize).replace('px', ''))
}

describe('UI-9D P1-8: typography scale — L1/L3/L4/L5の大小関係固定', () => {
  it('cardTitle(L4) < sectionTitle(L3) < pageTitle(L1)', () => {
    expect(px(typography.cardTitle)).toBeLessThan(px(typography.sectionTitle))
    expect(px(typography.sectionTitle)).toBeLessThan(px(typography.pageTitle))
  })

  it('caption(L5) <= cardTitle(L4)', () => {
    expect(px(typography.caption)).toBeLessThanOrEqual(px(typography.cardTitle))
  })

  it('凍結スケール数値そのものを固定する（22 / 14 / 13 / 11）', () => {
    expect(px(typography.pageTitle)).toBe(22)
    expect(px(typography.sectionTitle)).toBe(14)
    expect(px(typography.cardTitle)).toBe(13)
    expect(px(typography.caption)).toBe(11)
  })

  it('pageSubtitle トークンが存在し13px/400である', () => {
    expect(typography.pageSubtitle).toBeDefined()
    expect(px(typography.pageSubtitle)).toBe(13)
    expect(typography.pageSubtitle.fontWeight).toBe(400)
  })

  it('全heading系フォントサイズが11px floorを下回らない', () => {
    expect(px(typography.caption)).toBeGreaterThanOrEqual(11)
    expect(px(typography.cardTitle)).toBeGreaterThanOrEqual(11)
    expect(px(typography.sectionTitle)).toBeGreaterThanOrEqual(11)
    expect(px(typography.pageTitle)).toBeGreaterThanOrEqual(11)
  })
})
