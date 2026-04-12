import type { Holding, HoldingAnalysis } from '../../types'
import { JP_STOCK_MAX_VALUE } from '../../constants/market'
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

export interface StockPortfolioPlanOptions {
  targetTotalValue?: number
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function roundToTenThousand(value: number) {
  return Math.round(value / 10_000) * 10_000
}

function calcZeroBaseScore(holding: Holding, analysis: HoldingAnalysis): number {
  const quality =
    analysis.totalScore * 0.55 +
    analysis.fundamentalScore * 1.1 +
    analysis.technicalScore * 0.8 +
    analysis.marketScore * 0.6 +
    analysis.newsScore * 0.55 +
    analysis.confidence * 24 +
    analysis.ev * 150

  const volatilityPenalty = Math.max(0, (holding.sigma - 0.24) * 120)
  const leveragePenalty = Math.max(0, (holding.de - 2.0) * 2.8)
  const valuationPenalty = holding.per > 36 ? (holding.per - 36) * 0.55 : 0
  const crashPenalty = holding.pnlPct < -18 ? Math.abs(holding.pnlPct + 18) * 0.35 : 0

  return clamp(quality - volatilityPenalty - leveragePenalty - valuationPenalty - crashPenalty, 6, 98)
}

function toSoftmaxWeights(scores: number[]): number[] {
  if (scores.length === 0) return []
  const scaled = scores.map(score => Math.exp(score / 18))
  const sum = scaled.reduce((acc, value) => acc + value, 0)
  if (sum <= 0) return scores.map(() => 1 / scores.length)
  return scaled.map(value => value / sum)
}

function normalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((acc, value) => acc + value, 0)
  if (total <= 0) return weights.map(() => 0)
  return weights.map(value => value / total)
}

function applySectorCap(
  holdings: Holding[],
  weights: number[],
  cap = 0.32,
): number[] {
  const next = [...weights]
  const sectorMap = new Map<string, number[]>()
  holdings.forEach((holding, index) => {
    const key = holding.sector || 'その他'
    const list = sectorMap.get(key) ?? []
    list.push(index)
    sectorMap.set(key, list)
  })

  let overflow = 0
  sectorMap.forEach(indexes => {
    const total = indexes.reduce((sum, index) => sum + next[index], 0)
    if (total <= cap) return
    const scale = cap / Math.max(total, 0.000001)
    indexes.forEach(index => {
      const reduced = next[index] * scale
      overflow += next[index] - reduced
      next[index] = reduced
    })
  })

  if (overflow > 0.000001) {
    const weightsBySector = new Map<string, number>()
    sectorMap.forEach((indexes, sector) => {
      const total = indexes.reduce((sum, index) => sum + next[index], 0)
      weightsBySector.set(sector, total)
    })

    const receivers = holdings
      .map((holding, index) => ({ index, sector: holding.sector || 'その他' }))
      .filter(row => (weightsBySector.get(row.sector) ?? 0) < cap)

    const receiverTotal = receivers.reduce((sum, row) => sum + next[row.index], 0)
    if (receiverTotal > 0) {
      receivers.forEach(row => {
        next[row.index] += overflow * (next[row.index] / receiverTotal)
      })
    } else {
      const add = overflow / Math.max(next.length, 1)
      for (let i = 0; i < next.length; i += 1) {
        next[i] += add
      }
    }
  }

  return normalizeWeights(next)
}

function determineRecommendation(
  diffValue: number,
  analysis: HoldingAnalysis,
  locked: boolean,
): StockRecommendation {
  if (diffValue >= 150_000 && analysis.decision !== 'SELL') return 'BUY'
  if (diffValue <= -150_000 && locked) return 'WAIT_LOCK'
  if (diffValue <= -150_000) {
    if (analysis.decision === 'BUY' && analysis.totalScore >= 78) return 'HOLD'
    return 'SELL'
  }
  if (analysis.decision === 'SELL' && diffValue < 0) return locked ? 'WAIT_LOCK' : 'SELL'
  return 'HOLD'
}

function determineStance(row: {
  targetWeight: number
  diffValue: number
  recommendation: StockRecommendation
}): StockPortfolioRow['stance'] {
  if (row.recommendation === 'SELL' || row.recommendation === 'WAIT_LOCK') return 'reduce'
  if (row.targetWeight >= 0.12) return 'core'
  if (row.targetWeight >= 0.065) return 'satellite'
  if (row.diffValue > 120_000) return 'satellite'
  return 'watch'
}

function resolveReason(input: {
  analysis: HoldingAnalysis
  recommendation: StockRecommendation
  targetWeight: number
  zeroBaseScore: number
  locked: boolean
  sellableAt: string | null
}): string {
  const target = (input.targetWeight * 100).toFixed(1)
  if (input.recommendation === 'BUY') {
    return `ゼロベース配分で目標比率${target}%。スコア${input.zeroBaseScore.toFixed(1)}で追加候補。`
  }
  if (input.recommendation === 'SELL') {
    return `ゼロベース配分で目標比率${target}%。現保有が過大なため段階縮小。`
  }
  if (input.recommendation === 'WAIT_LOCK') {
    return input.sellableAt
      ? `目標比率${target}%だがロック中。${input.sellableAt}以降に縮小。`
      : `目標比率${target}%だがロック中。解除後に縮小。`
  }
  if (input.locked) {
    return `目標比率${target}%。ロック解除日まで監視継続。`
  }
  return (
    input.analysis.debate.bullReasons[0] ??
    input.analysis.debate.bearReasons[0] ??
    `目標比率${target}%。現状維持で監視。`
  )
}

function resolveHoldingStyle(
  recommendation: StockRecommendation,
  analysis: HoldingAnalysis,
  locked: boolean,
): string {
  if (recommendation === 'SELL' || recommendation === 'WAIT_LOCK') return '段階縮小（ロック中は解除待ち）'
  if (analysis.decision === 'BUY') return '分割エントリー（2〜3回）'
  if (locked) return '解除日まで監視'
  return '維持監視（週次見直し）'
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

  const ideas: StockSwapIdea[] = []
  const length = Math.min(sells.length, buys.length)

  for (let index = 0; index < length; index += 1) {
    const sell = sells[index]
    const buy = buys[index]
    ideas.push({
      sellCode: sell.code,
      sellName: sell.name,
      buyCode: buy.code,
      buyName: buy.name,
      reason: `${sell.name}を縮小し、${buy.name}へ再配分してゼロベース比率へ近づける。`,
    })
  }

  return ideas
}

export function buildStockPortfolioPlan(
  holdings: Holding[],
  analysis: HoldingAnalysis[],
  options: StockPortfolioPlanOptions = {},
): StockPortfolioPlan {
  const totalStockValue = holdings.reduce((sum, holding) => sum + holding.eval, 0)
  if (holdings.length === 0) {
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
  const targetTotalValue = Math.max(4_000_000, roundToTenThousand(options.targetTotalValue ?? JP_STOCK_MAX_VALUE))

  const zeroBaseScores = holdings.map(holding => {
    const item = analysisByCode.get(holding.code)
    const score = item ? calcZeroBaseScore(holding, item) : 25
    return score
  })

  const softmaxWeights = toSoftmaxWeights(zeroBaseScores)
  const adjustedWeights = applySectorCap(holdings, softmaxWeights)

  const rows = holdings
    .map((holding, index) => {
      const item = analysisByCode.get(holding.code)
      const targetWeight = adjustedWeights[index] ?? 0
      const targetValue = roundToTenThousand(targetTotalValue * targetWeight)
      const currentWeight = totalStockValue > 0 ? holding.eval / totalStockValue : 0
      const diffValue = targetValue - holding.eval
      const locked = isSellLocked(holding)
      const lockRemainingDays = getSellLockRemainingDays(holding)
      const sellableAt = getSellableDate(holding)
      const recommendation = item
        ? determineRecommendation(diffValue, item, locked)
        : 'HOLD'

      const stance = determineStance({
        targetWeight,
        diffValue,
        recommendation,
      })

      return {
        code: holding.code,
        name: holding.name,
        currentValue: holding.eval,
        currentWeight,
        targetValue,
        targetWeight,
        diffValue,
        recommendation,
        stance,
        locked,
        lockRemainingDays,
        sellableAt: locked && sellableAt ? sellableAt : null,
        reason: item
          ? resolveReason({
              analysis: item,
              recommendation,
              targetWeight,
              zeroBaseScore: zeroBaseScores[index],
              locked,
              sellableAt,
            })
          : '分析データ未取得のため監視継続。',
        holdingStyle: item
          ? resolveHoldingStyle(recommendation, item, locked)
          : '監視継続',
        confidence: item?.confidence ?? 0.45,
        score: item?.totalScore ?? Math.round(zeroBaseScores[index]),
      } satisfies StockPortfolioRow
    })
    .sort((left, right) => Math.abs(right.diffValue) - Math.abs(left.diffValue))

  const lockCount = rows.filter(row => row.locked).length
  const sellableCount = rows.length - lockCount
  const rebalanceTop = rows.slice(0, 10)
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
