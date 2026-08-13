// P4-A83: T2/T7 amount consistency guard tests
// buildAssetUniverse の JP_TRUST diffValue と JP_STOCK cap を固定し、
// T7 Trust提案・T2理想PF差分の整合が崩れないことを守る。
import { describe, it, expect } from 'vitest'
import type { AppState } from '../../types'
import { DEFAULT_PORTFOLIO_POLICY } from '../../types'
import { buildAssetUniverse, buildIdealPfPlan } from './idealAllocation'

// buildAssetUniverse / buildIdealPfPlan の最小 AppState ファクトリ
function makeState(overrides: {
  jpStockValue?: number
  jpTrustValue?: number
  cash?: number
  cashReserve?: number
  regime?: 'bull' | 'neutral' | 'bear'
  jpStockMaxRatio?: number
} = {}): AppState {
  const {
    jpStockValue   = 0,
    jpTrustValue   = 0,
    cash           = 1_000_000,
    cashReserve    = 5_000_000,
    regime         = 'neutral',
    jpStockMaxRatio = DEFAULT_PORTFOLIO_POLICY.jpStockMaxRatio,
  } = overrides

  return {
    holdings: jpStockValue > 0
      ? [{ code: '0001', name: 'Stock', eval: jpStockValue, pnlPct: 0, acquiredAt: undefined } as any]
      : [],
    trust: jpTrustValue > 0
      ? [{ id: 'jpt', policy: 'JAPAN_SHORTTERM', eval: jpTrustValue, score: 60 } as any]
      : [],
    cash,
    cashReserve,
    market: { regime, vix: 15, last_updated: '' } as any,
    macro: null as any,
    metrics: null,
    sqCalendar: null as any,
    portfolioPolicy: { jpStockMaxRatio },
    // 未使用フィールドを最小値で埋める
    analysis:       [] as any,
    learningState:  null as any,
    regimeState:    {} as any,
    system:         {} as any,
    candidatesNews: [] as any,
    officialDecision: null as any,
  } as unknown as AppState
}

// ── buildAssetUniverse: JP_TRUST diffValue — headroom consistency guard ───────
// useAppStore は JP_TRUST.diffValue をそのまま jpTrustHeadroom として trustPortfolio に渡す。
// diffValue > 0 → headroom 正 → T7 BUY 提案あり
// diffValue ≤ 0 → headroom 0以下 → T7 BUY=0（trustPortfolio.test.ts で確認済み）

describe('buildAssetUniverse: JP_TRUST diffValue — headroom consistency guard', () => {
  it('JP_TRUST currentValue < targetValue のとき diffValue > 0（T7 headroom 正 → BUY 提案可）', () => {
    // totalValue ≈ 6M / neutral JP_TRUST target = 10% = 600k
    // jpTrustValue = 0 → diffValue = 600k > 0
    const universe = buildAssetUniverse(makeState({ jpTrustValue: 0 }))
    const cat = universe.categories.find(c => c.class === 'JP_TRUST')!
    expect(cat.diffValue).toBeGreaterThan(0)
  })

  it('JP_TRUST currentValue >= targetValue のとき diffValue ≤ 0（T7 headroom=0 → BUY 提案なし）', () => {
    // totalValue ≈ 7M / neutral JP_TRUST target = 10% = 700k
    // jpTrustValue = 1,000,000 > 700k → diffValue < 0
    const universe = buildAssetUniverse(makeState({ jpTrustValue: 1_000_000 }))
    const cat = universe.categories.find(c => c.class === 'JP_TRUST')!
    expect(cat.diffValue).toBeLessThanOrEqual(0)
  })

  it('JP_TRUST diffValue = targetValue - currentValue の計算式が維持される', () => {
    const jpTrustValue = 300_000
    const universe = buildAssetUniverse(makeState({ jpTrustValue }))
    const cat = universe.categories.find(c => c.class === 'JP_TRUST')!
    const expected = cat.targetValue - jpTrustValue
    expect(cat.diffValue).toBeCloseTo(expected, 0)
  })
})

// ── buildAssetUniverse: JP_STOCK cap — jpStockMaxRatio propagation guard ──────
// jpStockMaxRatio は PortfolioPolicy 由来（8/10/12/15%）。
// 固定10%に戻ったり、capが効かなくなると以下テストが落ちる。
//
// 実装: jpStockTargetValue = Math.min(jpStockCap, jpStockValue)
//   currentValue > cap → targetValue = cap = totalValue * jpStockMaxRatio
//   currentValue ≤ cap → targetValue = currentValue（現状維持）

describe('buildAssetUniverse: JP_STOCK cap — jpStockMaxRatio propagation guard', () => {
  // jpStockValue=800k, cash=1M, cashReserve=5M → totalValue=6.8M
  //   jpStockMaxRatio=0.08 → cap = 6.8M * 0.08 = 544k → 800k > cap → cap超過
  //   jpStockMaxRatio=0.15 → cap = 6.8M * 0.15 = 1.02M → 800k < cap → 範囲内

  it('jpStockMaxRatio=0.08 のとき currentValue > cap → targetValue = totalValue * 0.08', () => {
    const universe = buildAssetUniverse(makeState({ jpStockValue: 800_000, jpStockMaxRatio: 0.08 }))
    const cat = universe.categories.find(c => c.class === 'JP_STOCK')!
    expect(cat.targetValue).toBeCloseTo(universe.totalValue * 0.08, 0)
  })

  it('jpStockMaxRatio=0.15 のとき currentValue < cap → targetValue = currentValue（超過なし）', () => {
    const jpStockValue = 800_000
    const universe = buildAssetUniverse(makeState({ jpStockValue, jpStockMaxRatio: 0.15 }))
    const cat = universe.categories.find(c => c.class === 'JP_STOCK')!
    expect(cat.targetValue).toBeCloseTo(jpStockValue, 0)
  })

  // P4.5-A011: T4_IdealPf.tsxのpartialStateにportfolioPolicyが欠落していると、
  // T9で0.12（12%）に設定してもT4表示側はレジーム別デフォルト（10%）にフォールバックし、
  // store産universeとズレる。jpStockMaxRatio=0.12が正しく伝播することの回帰guard。
  it('jpStockMaxRatio=0.12 のとき currentValue > cap → targetValue = totalValue * 0.12', () => {
    const universe = buildAssetUniverse(makeState({ jpStockValue: 900_000, jpStockMaxRatio: 0.12 }))
    const cat = universe.categories.find(c => c.class === 'JP_STOCK')!
    expect(cat.targetValue).toBeCloseTo(universe.totalValue * 0.12, 0)
  })

  it('JP_STOCK currentValue > cap のとき diffValue < 0（売却要）', () => {
    // jpStockValue=800k, jpStockMaxRatio=0.08 → cap=544k → diffValue < 0
    const universe = buildAssetUniverse(makeState({ jpStockValue: 800_000, jpStockMaxRatio: 0.08 }))
    const cat = universe.categories.find(c => c.class === 'JP_STOCK')!
    expect(cat.diffValue).toBeLessThan(0)
  })
})

// ── buildIdealPfPlan: JP_STOCK 超過時の constraint guard ─────────────────────
// JP_STOCK 比率が jpStockMaxRatio を超えると class_cap constraint が追加される。
// 追加されなくなると T2/T4 の警告表示が消え、実装者に気づかせる機能が失われる。

describe('buildIdealPfPlan: JP_STOCK 超過時の constraint guard', () => {
  it('JP_STOCK 比率 > jpStockMaxRatio のとき constraints に class_cap が含まれる', () => {
    const state = makeState({ jpStockValue: 1_200_000, jpStockMaxRatio: 0.10 })
    const plan = buildIdealPfPlan(state)
    const caps = plan.constraints.filter(c => c.type === 'class_cap')
    expect(caps.length).toBeGreaterThan(0)
  })

  it('JP_STOCK 比率 ≤ jpStockMaxRatio のとき constraints に class_cap が含まれない', () => {
    const state = makeState({ jpStockValue: 500_000, jpStockMaxRatio: 0.15 })
    const plan = buildIdealPfPlan(state)
    const caps = plan.constraints.filter(c => c.type === 'class_cap')
    expect(caps).toHaveLength(0)
  })
})
