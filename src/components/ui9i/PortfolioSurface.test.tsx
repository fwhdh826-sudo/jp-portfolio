// UI-9I Phase 1: PF 面 / ハブの render 契約（canonical 順・利用不可の扱い）。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PortfolioSurfaceViewModel } from '../../presentation/ui9i/portfolioSurface'
import { projectPortfolio } from '../../presentation/ui9i/portfolioPresentation'
import { UNAVAILABLE_ALLOCATION, fixtureAllocation } from '../../presentation/ui9i/ui9i.fixtures'
import { FundsHubView, OtherHubView, PortfolioSurfaceView } from './HubSurfaces'

const available: PortfolioSurfaceViewModel = {
  portfolio: projectPortfolio(fixtureAllocation()),
  snapshotLabel: '10/6 8:30',
  grossCash: { kind: 'known', amountJpy: 2_660_000 },
  deployableCash: { kind: 'available', amountJpy: 1_200_000 },
}

describe('PF 面', () => {
  const html = renderToStaticMarkup(<PortfolioSurfaceView vm={available} onNavigate={() => {}} />)

  it('6 クラスを canonical 順で全件表示（UI 側で並べ替えない）', () => {
    const labels = ['国内個別株', '国内投信', '海外投信', '金', '現金', '現金リザーブ']
    const gaps = html.slice(html.indexOf('data-testid="portfolio-gaps"'), html.indexOf('data-testid="portfolio-cash"'))
    const positions = labels.map(l => gaps.indexOf(`u9-gap__label">${l}<`))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('ドーナツ=構成（総資産）、バー=目標との差（現在 → 目標）。方向は 不足 / 超過 / 目標水準', () => {
    expect(html).toContain('3,800万円')
    expect(html).toContain('現在 ▮ / 目標 ▏')
    expect(html).toContain('35 / 30 ・超過 190万円')
    expect(html).toContain('7 / 10 ・不足 114万円')
    expect(html).toContain('20 / 20 ・目標水準')
    expect(html).toContain('u9-bar__target')
  })

  it('総現金と実行可能現金を分離表示', () => {
    expect(html).toMatch(/data-testid="gross-cash">266万円</)
    expect(html).toMatch(/data-testid="deployable-cash"[^>]*>¥1,200,000</)
    expect(html).toContain('実行可能現金は現金残高とは別の権限です')
  })

  it('配分スナップショット不可: 判定不能 + 実行可能現金は「利用不可」（¥0 にしない）', () => {
    const vm: PortfolioSurfaceViewModel = {
      portfolio: projectPortfolio(UNAVAILABLE_ALLOCATION), snapshotLabel: null,
      grossCash: { kind: 'unknown' }, deployableCash: { kind: 'unavailable' },
    }
    const out = renderToStaticMarkup(<PortfolioSurfaceView vm={vm} onNavigate={() => {}} />)
    expect(out).toContain('配分の判定不能')
    expect(out).toMatch(/data-testid="deployable-cash" data-unavailable="true">利用不可</)
    expect(out).toContain('未設定')
    expect(out).not.toContain('¥0')
  })

  it('旧 T4（理想ポートフォリオ / 差分）へ到達できる', () => {
    expect(html).toContain('理想ポートフォリオ / 差分')
  })
})

describe('ハブ', () => {
  it('投信ハブは判断を持たない', () => {
    const html = renderToStaticMarkup(<FundsHubView onNavigate={() => {}} />)
    expect(html).toContain('ハブ自体は判断を持ちません')
    expect(html.match(/data-hub-link=/g)?.length).toBe(3)
  })

  it('その他ハブ: AI委員会は Home の最終判断（OfficialDecision）と競合させない', () => {
    const html = renderToStaticMarkup(<OtherHubView onNavigate={() => {}} />)
    expect(html).toContain('AI委員会は最終判断ではありません。最終判断は「今日」に表示します。')
    expect(html.match(/data-hub-link=/g)?.length).toBe(5)
  })

  it('44px 以上のタップ領域を持つ項目クラスである（CSS 契約は ui9i.css.test で検証）', () => {
    expect(renderToStaticMarkup(<FundsHubView onNavigate={() => {}} />)).toContain('u9-hub-item')
  })
})
