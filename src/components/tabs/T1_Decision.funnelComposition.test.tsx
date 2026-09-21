// UI-9I Phase 2B-1R: 本番の個別株面は「一覧 + 市場候補ファネル」の合成。
// Phase 2B-1 では container test が CandidateFunnelPanel を mock していたため、
// 旧 UI（SectionHeader の青い左罫線 / legacy トークン）のまま R4.1 面に混在しても検出できなかった。
// ここでは funnel を mock せず、実 T1_Decision + 実 CandidateFunnelPanel（実 store）の合成を検証する。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { T1_Decision } from './T1_Decision'

// SSR は zustand の initial state（boot・保有なし・funnel 未取得）を描画する。実 store / 実 panel のまま。
function renderRealT1(): string {
  return renderToStaticMarkup(<T1_Decision />)
}

describe('T1 + 実 Candidate Funnel の合成（P1-01 回帰）', () => {
  it('一覧の下に、同じ .u9 面の R4.1 カードとして funnel が描画される', () => {
    const html = renderRealT1()
    expect(html.startsWith('<div class="u9">')).toBe(true)
    expect(html).toContain('data-testid="stocks-surface"')
    expect(html).toContain('<section class="candidate-funnel u9-card" aria-label="市場候補ファネル">')
    // 候補（AllocationPlan認可）カードの後ろ = 本番の funnelSlot 位置
    expect(html.indexOf('data-testid="stocks-candidates"'))
      .toBeLessThan(html.indexOf('class="candidate-funnel u9-card"'))
  })

  it('旧 UI の痕跡（SectionHeader の青い左罫線 / legacy 見出しクラス）が残っていない', () => {
    const html = renderRealT1()
    const funnel = html.slice(html.indexOf('class="candidate-funnel u9-card"'))
    expect(funnel).not.toContain('border-left:4px solid')
    expect(funnel).not.toContain('section-heading')
    expect(funnel).not.toContain('section-kicker')
    expect(funnel).not.toMatch(/style="[^"]*var\(--color-/)
  })

  it('funnel の状態にかかわらず「取引判断には使用しません」が常に読める', () => {
    const html = renderRealT1()
    const funnel = html.slice(html.indexOf('class="candidate-funnel u9-card"'))
    expect(funnel).toContain('取引判断には使用しません')
  })

  it('funnel の見出しは面内の h2（一覧・比較・候補カードと同階層）', () => {
    const html = renderRealT1()
    expect(html).toMatch(/<h2 class="candidate-funnel__title">市場候補ファネル<\/h2>/)
  })
})
