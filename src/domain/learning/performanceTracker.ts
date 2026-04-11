import type {
  Holding,
  HoldingAnalysis,
  LearningBaseline,
  LearningOutcome,
  LearningState,
  LearningSummary,
  AdaptiveWeights,
  DecisionSummary,
} from '../../types'

type BaselineItem = LearningBaseline

const MAX_OUTCOMES = 500
const RESULT_THRESHOLD = 0.5

function createDecisionSummary(): DecisionSummary {
  return {
    count: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    accuracy: 0,
    avgReward: 0,
  }
}

function baseWeights(): AdaptiveWeights {
  return {
    fundamental: 0.30,
    market: 0.20,
    technical: 0.20,
    news: 0.15,
    quality: 0.10,
    risk: 0.15,
  }
}

function normalizeWeights(weights: AdaptiveWeights): AdaptiveWeights {
  const clamped: AdaptiveWeights = {
    fundamental: Math.max(0.05, weights.fundamental),
    market: Math.max(0.05, weights.market),
    technical: Math.max(0.05, weights.technical),
    news: Math.max(0.03, weights.news),
    quality: Math.max(0.03, weights.quality),
    risk: Math.max(0.05, weights.risk),
  }

  const sum = clamped.fundamental + clamped.market + clamped.technical + clamped.news + clamped.quality + clamped.risk
  if (sum <= 0) return baseWeights()

  return {
    fundamental: +(clamped.fundamental / sum).toFixed(4),
    market: +(clamped.market / sum).toFixed(4),
    technical: +(clamped.technical / sum).toFixed(4),
    news: +(clamped.news / sum).toFixed(4),
    quality: +(clamped.quality / sum).toFixed(4),
    risk: +(clamped.risk / sum).toFixed(4),
  }
}

function buildBaseline(holdings: Holding[], analysis: HoldingAnalysis[], at: string): BaselineItem[] {
  return analysis
    .map(a => {
      const h = holdings.find(x => x.code === a.code)
      if (!h) return null
      return {
        code: a.code,
        predictedAt: at,
        decision: a.decision,
        score: a.totalScore,
        confidence: a.confidence,
        pnlPct: h.pnlPct,
      }
    })
    .filter((x): x is BaselineItem => Boolean(x))
}

function judgeOutcome(
  decision: 'BUY' | 'HOLD' | 'SELL',
  deltaPnlPct: number,
): { result: 'win' | 'loss' | 'flat'; reward: number } {
  if (decision === 'BUY') {
    if (deltaPnlPct > RESULT_THRESHOLD) return { result: 'win', reward: deltaPnlPct }
    if (deltaPnlPct < -RESULT_THRESHOLD) return { result: 'loss', reward: deltaPnlPct }
    return { result: 'flat', reward: deltaPnlPct * 0.5 }
  }

  if (decision === 'SELL') {
    if (deltaPnlPct < -RESULT_THRESHOLD) return { result: 'win', reward: -deltaPnlPct }
    if (deltaPnlPct > RESULT_THRESHOLD) return { result: 'loss', reward: -deltaPnlPct }
    return { result: 'flat', reward: -deltaPnlPct * 0.5 }
  }

  const absDelta = Math.abs(deltaPnlPct)
  if (absDelta <= 1.2) return { result: 'win', reward: 1.2 - absDelta }
  if (absDelta >= 3.0) return { result: 'loss', reward: -(absDelta - 1.2) }
  return { result: 'flat', reward: 0 }
}

function summarize(outcomes: LearningOutcome[]): LearningSummary {
  const byDecision: LearningSummary['byDecision'] = {
    BUY: createDecisionSummary(),
    HOLD: createDecisionSummary(),
    SELL: createDecisionSummary(),
  }

  let wins = 0
  let losses = 0
  let flats = 0
  let rewardSum = 0

  outcomes.forEach(o => {
    const ds = byDecision[o.decision]
    ds.count += 1
    rewardSum += o.reward
    if (o.result === 'win') {
      wins += 1
      ds.wins += 1
    } else if (o.result === 'loss') {
      losses += 1
      ds.losses += 1
    } else {
      flats += 1
      ds.flats += 1
    }
  })

  ;(['BUY', 'HOLD', 'SELL'] as const).forEach(key => {
    const ds = byDecision[key]
    const judged = ds.wins + ds.losses
    ds.accuracy = judged > 0 ? +(ds.wins / judged * 100).toFixed(1) : 0
    const rewards = outcomes.filter(o => o.decision === key)
    ds.avgReward = rewards.length > 0
      ? +(rewards.reduce((s, r) => s + r.reward, 0) / rewards.length).toFixed(3)
      : 0
  })

  const judgedTotal = wins + losses
  const accuracy = judgedTotal > 0 ? +(wins / judgedTotal * 100).toFixed(1) : 0
  const avgReward = outcomes.length > 0 ? +(rewardSum / outcomes.length).toFixed(3) : 0

  const driftSignals: string[] = []
  if (byDecision.BUY.count >= 6 && byDecision.BUY.accuracy < 45) {
    driftSignals.push('BUY精度が低下。テクニカル偏重を抑え、リスク重みを上げる。')
  }
  if (byDecision.SELL.count >= 6 && byDecision.SELL.accuracy < 45) {
    driftSignals.push('SELL精度が低下。マクロとリスク判定を優先。')
  }
  if (byDecision.HOLD.count >= 6 && byDecision.HOLD.accuracy < 45) {
    driftSignals.push('HOLD精度が低下。ファンダと品質を優先して再判定。')
  }
  if (accuracy >= 60) {
    driftSignals.push('現行重みは安定。大幅な変更は不要。')
  }

  return {
    total: outcomes.length,
    wins,
    losses,
    flats,
    accuracy,
    avgReward,
    byDecision,
    driftSignals,
  }
}

function suggestWeights(summary: LearningSummary): AdaptiveWeights {
  const w = baseWeights()

  if (summary.byDecision.BUY.count >= 6 && summary.byDecision.BUY.accuracy < 45) {
    w.technical -= 0.03
    w.news -= 0.01
    w.risk += 0.02
    w.fundamental += 0.02
  }

  if (summary.byDecision.SELL.count >= 6 && summary.byDecision.SELL.accuracy < 45) {
    w.market += 0.03
    w.risk += 0.02
    w.technical -= 0.03
    w.news -= 0.02
  }

  if (summary.byDecision.HOLD.count >= 6 && summary.byDecision.HOLD.accuracy < 45) {
    w.fundamental += 0.03
    w.quality += 0.02
    w.technical -= 0.03
    w.market -= 0.01
  }

  if (summary.accuracy >= 62) {
    w.risk -= 0.01
    w.fundamental += 0.01
  }

  return normalizeWeights(w)
}

function evaluateOutcomes(
  prevBaseline: BaselineItem[],
  holdings: Holding[],
  at: string,
): LearningOutcome[] {
  const outcomes: LearningOutcome[] = []

  prevBaseline.forEach(seed => {
    const h = holdings.find(x => x.code === seed.code)
    if (!h) return

    const deltaPnlPct = +(h.pnlPct - seed.pnlPct).toFixed(2)
    const judged = judgeOutcome(seed.decision, deltaPnlPct)

    outcomes.push({
      code: seed.code,
      predictedAt: seed.predictedAt,
      evaluatedAt: at,
      decision: seed.decision,
      score: seed.score,
      confidence: seed.confidence,
      prevPnlPct: seed.pnlPct,
      currPnlPct: h.pnlPct,
      deltaPnlPct,
      reward: +judged.reward.toFixed(3),
      result: judged.result,
    })
  })

  return outcomes
}

export function updatePerformanceTracker(
  prev: LearningState | null,
  holdings: Holding[],
  analysis: HoldingAnalysis[],
  at: string,
): LearningState {
  const prevBaseline = Array.isArray(prev?.baseline) ? prev.baseline : []

  const newOutcomes = evaluateOutcomes(prevBaseline, holdings, at)
  const outcomes = [...newOutcomes, ...(prev?.outcomes ?? [])].slice(0, MAX_OUTCOMES)
  const summary = summarize(outcomes)
  const suggestedWeights = suggestWeights(summary)
  const nextBaseline = buildBaseline(holdings, analysis, at)

  return {
    lastUpdated: at,
    baselineCount: nextBaseline.length,
    baseline: nextBaseline,
    outcomes,
    summary,
    suggestedWeights,
  }
}

export function sanitizeLearningState(raw: unknown): LearningState | null {
  if (!raw || typeof raw !== 'object') return null
  const state = raw as Partial<LearningState>
  if (!Array.isArray(state.outcomes) || !state.summary || !state.suggestedWeights) return null

  return {
    lastUpdated: typeof state.lastUpdated === 'string' ? state.lastUpdated : new Date().toISOString(),
    baselineCount: typeof state.baselineCount === 'number' ? state.baselineCount : 0,
    baseline: Array.isArray(state.baseline) ? state.baseline : [],
    outcomes: state.outcomes.slice(0, MAX_OUTCOMES),
    summary: state.summary,
    suggestedWeights: state.suggestedWeights,
  }
}
