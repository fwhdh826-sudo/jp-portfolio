import type { Holding, HoldingAnalysis } from '../../types'
import {
  getSellLockRemainingDays,
  getSellableDate,
  isSellLocked,
} from '../constraints/stockLock'

export type StockRecommendation = 'BUY' | 'HOLD' | 'SELL' | 'WAIT_LOCK'

export interface StockPortfolioRow {
  code: string
  name: string
  currentValue: number
  currentWeight: number
  targetValue: number
  targetWeight: number
  diffValue: number
  recommendation: StockRecommendation
  stance: 'core' | 'satellite' | 'reduce' | 'watch'
  locked: boolean
  lockRemainingDays: number
  sellableAt: string | null
  reason: string
  holdingStyle: string
  confidence: number
  score: number
}

export interface StockSwapIdea {
  sellCode: string
  sellName: string
  buyCode: string
  buyName: string
  reason: string
}

export interface StockPortfolioPlan {
  generatedAt: string
  totalStockValue: number
  lockCount: number
  sellableCount: number
  rows: StockPortfolioRow[]
  rebalanceTop: StockPortfolioRow[]
  swapIdeas: StockSwapIdea[]
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function roundToTenThousand(value: number) {
  return Math.round(value / 10_000) * 10_000
}

function calcSeed(analysis: HoldingAnalysis, locked: boolean) {
  const directional =
    analysis.decision === 'BUY'
      ? 12
      : analysis.decision === 'SELL'
      ? -18
      : 0
  const lockAdjust = locked && analysis.decision === 'SELL' ? 10 : 0
  const evAdjust = analysis.ev * 120
  const confidenceAdjust = analysis.confidence * 18
  const riskAdjust = analysis.riskPenalty * 1.1
  const value =
    12 +
    analysis.totalScore * 0.62 +
    analysis.fundamentalScore * 0.35 +
    analysis.qualityScore * 0.7 +
    directional +
    lockAdjust +
    evAdjust +
    confidenceAdjust -
    riskAdjust
  return clamp(value, 6, 120)
}

function determineRecommendation(
  diffValue: number,
  analysis: HoldingAnalysis,
  locked: boolean,
): StockRecommendation {
  if (diffValue >= 120_000) return 'BUY'
  if (diffValue <= -120_000 && locked) return 'WAIT_LOCK'
  if (diffValue <= -120_000 && analysis.decision === 'SELL') return 'SELL'
  return 'HOLD'
}

function determineStance(row: {
  targetWeight: number
  diffValue: number
  recommendation: StockRecommendation
}): StockPortfolioRow['stance'] {
  if (row.recommendation === 'SELL') return 'reduce'
  if (row.targetWeight >= 0.11) return 'core'
  if (row.targetWeight >= 0.065) return 'satellite'
  if (row.diffValue <= -100_000) return 'reduce'
  return 'watch'
}

function resolveReason(
  analysis: HoldingAnalysis,
  recommendation: StockRecommendation,
  locked: boolean,
  sellableAt: string | null,
) {
  if (recommendation === 'BUY') {
    return (
      analysis.debate.bullReasons[0] ??
      `スコア${analysis.totalScore}/100、確信度${Math.round(analysis.confidence * 100)}%で追加候補。`
    )
  }
  if (recommendation === 'SELL') {
    return (
      analysis.debate.bearReasons[0] ??
      `スコア${analysis.totalScore}/100で優先縮小候補。`
    )
  }
  if (recommendation === 'WAIT_LOCK') {
    return sellableAt
      ? `売却ロック中。${sellableAt}以降に縮小候補として再判定。`
      : '売却ロック中。解除後に縮小判定へ移行。'
  }
  if (locked) {
    return 'ロック期間中は維持し、解除前に出口条件だけ更新します。'
  }
  return analysis.debate.bullReasons[0] ?? analysis.debate.bearReasons[0] ?? '現行比率を維持して監視。'
}

function resolveHoldingStyle(
  recommendation: StockRecommendation,
  analysis: HoldingAnalysis,
  locked: boolean,
) {
  if (recommendation === 'SELL' || recommendation === 'WAIT_LOCK') return 'ロック解除後に段階縮小'
  if (analysis.decision === 'BUY') return '最低3ヶ月の分割積み上げ'
  if (locked) return '解除日まで監視保有'
  return '中期保有で継続監視'
}

function buildSwapIdeas(rows: StockPortfolioRow[]): StockSwapIdea[] {
  const sells = rows
    .filter(row => row.recommendation === 'SELL')
    .sort((left, right) => left.diffValue - right.diffValue)
    .slice(0, 3)
  const buys = rows
    .filter(row => row.recommendation === 'BUY')
    .sort((left, right) => right.diffValue - left.diffValue)
    .slice(0, 3)

  const length = Math.min(sells.length, buys.length)
  const ideas: StockSwapIdea[] = []

  for (let index = 0; index < length; index += 1) {
    const sell = sells[index]
    const buy = buys[index]
    ideas.push({
      sellCode: sell.code,
      sellName: sell.name,
      buyCode: buy.code,
      buyName: buy.name,
      reason: `${sell.name}の縮小で${buy.name}へ再配分し、期待値と中期成長のバランスを改善する。`,
    })
  }

  return ideas
}

export function buildStockPortfolioPlan(
  holdings: Holding[],
  analysis: HoldingAnalysis[],
): StockPortfolioPlan {
  const totalStockValue = holdings.reduce((sum, holding) => sum + holding.eval, 0)
  if (holdings.length === 0 || totalStockValue <= 0) {
    return {
      generatedAt: new Date().toISOString(),
      totalStockValue: 0,
      lockCount: 0,
      sellableCount: 0,
      rows: [],
      rebalanceTop: [],
      swapIdeas: [],
    }
  }

  const analysisByCode = new Map(analysis.map(item => [item.code, item]))
  const seeds = holdings.map(holding => {
    const item = analysisByCode.get(holding.code)
    const locked = isSellLocked(holding)
    const scoreSeed = item ? calcSeed(item, locked) : 35
    return {
      holding,
      analysis: item,
      locked,
      scoreSeed,
    }
  })

  const sumSeed = seeds.reduce((sum, item) => sum + item.scoreSeed, 0)
  const rows = seeds
    .map(item => {
      const targetWeight = item.scoreSeed / Math.max(sumSeed, 1)
      const targetValue = roundToTenThousand(totalStockValue * targetWeight)
      const currentWeight = item.holding.eval / totalStockValue
      const diffValue = targetValue - item.holding.eval
      const lockRemainingDays = getSellLockRemainingDays(item.holding)
      const sellableAt = getSellableDate(item.holding)
      const recommendation = item.analysis
        ? determineRecommendation(diffValue, item.analysis, item.locked)
        : 'HOLD'
      const stance = determineStance({
        targetWeight,
        diffValue,
        recommendation,
      })

      return {
        code: item.holding.code,
        name: item.holding.name,
        currentValue: item.holding.eval,
        currentWeight,
        targetValue,
        targetWeight,
        diffValue,
        recommendation,
        stance,
        locked: item.locked,
        lockRemainingDays,
        sellableAt: item.locked && sellableAt ? sellableAt : null,
        reason: item.analysis
          ? resolveReason(item.analysis, recommendation, item.locked, sellableAt)
          : '分析データ未取得のため監視継続。',
        holdingStyle: item.analysis
          ? resolveHoldingStyle(recommendation, item.analysis, item.locked)
          : '監視維持',
        confidence: item.analysis?.confidence ?? 0.5,
        score: item.analysis?.totalScore ?? 50,
      } satisfies StockPortfolioRow
    })
    .sort((left, right) => Math.abs(right.diffValue) - Math.abs(left.diffValue))

  const lockCount = rows.filter(row => row.locked).length
  const sellableCount = rows.length - lockCount
  const rebalanceTop = rows.slice(0, 8)
  const swapIdeas = buildSwapIdeas(rows)

  return {
    generatedAt: new Date().toISOString(),
    totalStockValue,
    lockCount,
    sellableCount,
    rows,
    rebalanceTop,
    swapIdeas,
  }
}
