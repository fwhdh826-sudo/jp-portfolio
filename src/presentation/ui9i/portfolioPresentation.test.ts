import { describe, expect, it } from 'vitest'
import { currentAmountText, gapText, projectPortfolio, resolvePortfolioDirection } from './portfolioPresentation'
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

describe('canonical 順・ランキング禁止（Phase 2A 追加）', () => {
  it('gap の大小・金額・比率で並べ替えない（入力順 = 出力順、どの並びでも保存）', () => {
    const base = fixtureClasses()
    const bySizeDesc = [...base].sort((a, b) => (b.targetGap + b.overweightAmount) - (a.targetGap + a.overweightAmount))
    const byAmountAsc = [...base].sort((a, b) => a.currentAmount - b.currentAmount)
    for (const order of [bySizeDesc, byAmountAsc]) {
      const pf = projectPortfolio(fixtureAllocation({ classes: order }))!
      expect(pf.rows.map(r => r.assetClass)).toEqual(order.map(c => c.assetClass))
    }
    // canonical 入力（product 順）では常に JP_STOCK → … → CASH_RESERVE
    expect(projectPortfolio(fixtureAllocation())!.rows.map(r => r.assetClass)).toEqual([...CANONICAL_CLASS_ORDER])
  })

  it('adapter は 重要度 / 警告 / 順位 / スコアに相当するフィールドを row に持たない', () => {
    const row = projectPortfolio(fixtureAllocation())!.rows[0]
    expect(Object.keys(row).sort()).toEqual([
      'assetClass', 'currentAmount', 'currentRatioPct', 'direction', 'directionLabel', 'gapAmount', 'label', 'targetAmount', 'targetRatioPct',
    ])
  })
})

describe('gapText: 唯一の生成点', () => {
  it('現在% / 目標% ・方向 金額（design のモックと同一文字列）', () => {
    const rows = projectPortfolio(fixtureAllocation())!.rows.map(gapText)
    expect(rows).toEqual([
      '35 / 30 ・超過 190万円',
      '20 / 20 ・目標水準',
      '25 / 25 ・目標水準',
      '10 / 10 ・目標水準',
      '7 / 10 ・不足 114万円',
      '3 / 5 ・不足 76万円',
    ])
  })

  it('判定不能は方向語のみ（0 や 目標水準 に偽装しない）', () => {
    const classes = fixtureClasses().map(c => (c.assetClass === 'GOLD' ? { ...c, targetGap: Number.NaN } : c))
    const gold = projectPortfolio(fixtureAllocation({ classes }))!.rows[3]
    expect(gapText(gold)).toBe('判定不能')
  })
})

describe('currentAmountText: 凡例の現在額は canonical currentAmount のみ', () => {
  it('万円表記。総資産・比率に依存しない', () => {
    const a = projectPortfolio(fixtureAllocation({ totalAssets: 38_000_000 }))!.rows.map(currentAmountText)
    const b = projectPortfolio(fixtureAllocation({ totalAssets: 1 }))!.rows.map(currentAmountText)
    expect(a).toEqual(['1,330万円', '760万円', '950万円', '380万円', '266万円', '114万円'])
    expect(b).toEqual(a)
  })

  it('非有限値は「—」（¥0 / 0万円 にしない）', () => {
    expect(currentAmountText({ currentAmount: Number.NaN })).toBe('—')
  })
})

describe('表示専用の現在比率は business state に影響しない', () => {
  it('currentRatioPct を変えうる totalAssets の差で direction / gapAmount / 金額は不変', () => {
    const a = projectPortfolio(fixtureAllocation({ totalAssets: 38_000_000 }))!
    const b = projectPortfolio(fixtureAllocation({ totalAssets: 9_999_999 }))!
    expect(a.rows.map(r => r.currentRatioPct)).not.toEqual(b.rows.map(r => r.currentRatioPct))
    expect(a.rows.map(r => [r.direction, r.gapAmount, r.currentAmount, r.targetAmount]))
      .toEqual(b.rows.map(r => [r.direction, r.gapAmount, r.currentAmount, r.targetAmount]))
  })
})
