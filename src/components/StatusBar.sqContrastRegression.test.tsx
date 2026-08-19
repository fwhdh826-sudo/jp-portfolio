import { describe, expect, it } from 'vitest'
import { statusBarSqValueColor } from './StatusBar'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import statusBarSource from './StatusBar.tsx?raw'

describe('F-1 StatusBar SQ表示 — inline color回帰検知（実際のbranch outputを直接検証）', () => {
  it('通常日（dayUntil>3）はundefinedを返し、CSSクラス側のtextOnNavy（約12.95:1）へ委ねる', () => {
    expect(statusBarSqValueColor(10)).toBeUndefined()
    expect(statusBarSqValueColor(4)).toBeUndefined()
    // 旧M3bバグ（三項else = 'inherit'）はここでinheritを返し、StatusBar実測で
    // 12.95:1→1.06:1に劣化させていた。'inherit'はもちろん、undefined以外の
    // いかなる値も返してはならない。
    expect(statusBarSqValueColor(10)).not.toBe('inherit')
  })

  it('未取得（undefined）は非危険扱い（99日相当）でundefinedを返す', () => {
    expect(statusBarSqValueColor(undefined)).toBeUndefined()
  })

  it('境界（dayUntil===3）と直近日は引き続き警告色 #f07575 を明示する（既存分岐は無変更）', () => {
    expect(statusBarSqValueColor(3)).toBe('#f07575')
    expect(statusBarSqValueColor(0)).toBe('#f07575')
  })

  it('StatusBar.tsxのSQ span colorは単一の exported pure predicate 経由のみで導出される（inline三項の再導入を防ぐ配線ガード）', () => {
    const spanBlock = statusBarSource.slice(
      statusBarSource.indexOf('先物'),
      statusBarSource.indexOf('先物') + 300,
    )
    expect(spanBlock).toContain('color: statusBarSqValueColor(sqCalendar?.nextSQ?.dayUntil)')
    expect(spanBlock).not.toMatch(/dayUntil.*<=\s*3\s*\?/)
  })
})
