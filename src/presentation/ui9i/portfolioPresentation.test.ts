import { describe, expect, it } from 'vitest'
import { projectPortfolio, resolvePortfolioDirection } from './portfolioPresentation'
import { CANONICAL_CLASS_ORDER, UNAVAILABLE_ALLOCATION, fixtureAllocation, fixtureClasses } from './ui9i.fixtures'

describe('Portfolio adapter: canonical 順を保つ', () => {
  it('snapshot.classes の順序をそのまま返す（JP_STOCK → … → CASH_RESERVE）', () => {
    const pf = projectPortfolio(fixtureAllocation())!
    expect(pf.rows.map(r => r.assetClass)).toEqual([...CANONICAL_CLASS_ORDER])
    expect(pf.rows.map(r => r.label)).toEqual(['国内個別株', '国内投信', '海外投信', '金', '現金', '現金リザーブ'])
  })

  it('入力が canonical 順でなくても並べ替えない（adapter は権限の順序を上書きしない）', () => {
    const shuffled = [...fixtureClasses()].reverse()
    const pf = projectPortfolio(fixtureAllocation({ classes: shuffled }))!
    expect(pf.rows.map(r => r.assetClass)).toEqual(shuffled.map(c => c.assetClass))
  })

  it('スナップショット利用不可は null（判定不能）', () => {
    expect(projectPortfolio(UNAVAILABLE_ALLOCATION)).toBeNull()
  })
})

describe('方向: targetGap / overweightAmount のみで決める', () => {
  it('不足 / 超過 / 目標水準 / 判定不能', () => {
    expect(resolvePortfolioDirection(1_140_000, 0)).toBe('shortfall')
    expect(resolvePortfolioDirection(0, 1_900_000)).toBe('excess')
    expect(resolvePortfolioDirection(0, 0)).toBe('on_target')
    expect(resolvePortfolioDirection(Number.NaN, 0)).toBe('undeterminable')
    expect(resolvePortfolioDirection(-1, 0)).toBe('undeterminable')
    expect(resolvePortfolioDirection(10, 10)).toBe('undeterminable')
  })

  it('design モックデータの 6 クラスが期待どおりの方向・金額になる', () => {
    const pf = projectPortfolio(fixtureAllocation())!
    const byClass = Object.fromEntries(pf.rows.map(r => [r.assetClass, r]))
    expect(byClass.JP_STOCK).toMatchObject({ direction: 'excess', directionLabel: '超過', gapAmount: 1_900_000 })
    expect(byClass.JP_TRUST).toMatchObject({ direction: 'on_target', directionLabel: '目標水準', gapAmount: null })
    expect(byClass.CASH).toMatchObject({ direction: 'shortfall', directionLabel: '不足', gapAmount: 1_140_000 })
    expect(byClass.CASH_RESERVE).toMatchObject({ direction: 'shortfall', gapAmount: 760_000 })
  })

  it('「大きな乖離」「ほぼ目標」など閾値語彙を作らない', () => {
    const labels = projectPortfolio(fixtureAllocation())!.rows.map(r => r.directionLabel)
    expect(new Set(labels)).toEqual(new Set(['超過', '目標水準', '不足']))
  })
})

describe('現在比率は表示専用（総資産から算出）', () => {
  it('currentRatioPct = currentAmount / totalAssets * 100、targetRatioPct = targetRatio * 100', () => {
    const pf = projectPortfolio(fixtureAllocation())!
    const stock = pf.rows[0]
    expect(stock.currentRatioPct).toBeCloseTo(35, 5)
    expect(stock.targetRatioPct).toBeCloseTo(30, 5)
  })

  it('総資産が 0 / 不正なら現在比率は null（0% と偽らない）', () => {
    const pf = projectPortfolio(fixtureAllocation({ totalAssets: 0 }))!
    expect(pf.rows.every(r => r.currentRatioPct === null)).toBe(true)
  })

  it('比率は方向判定に影響しない（方向は targetGap / overweightAmount のみ）', () => {
    const a = projectPortfolio(fixtureAllocation({ totalAssets: 38_000_000 }))!
    const b = projectPortfolio(fixtureAllocation({ totalAssets: 1 }))!
    expect(a.rows.map(r => r.direction)).toEqual(b.rows.map(r => r.direction))
  })
})
