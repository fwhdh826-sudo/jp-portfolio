import type { Holding, Market, PortfolioMetrics } from '../../types'
import type { ZeroBasePlan } from '../optimization/zeroBase'
import type { StockPortfolioPlan } from '../optimization/stockPortfolio'
import type { TrustPortfolioPlan } from '../optimization/trustPortfolio'

export interface CommitteeAction {
  id: string
  title: string
  detail: string
  reason: string
  priority: 'high' | 'medium' | 'low'
  domain: 'stock' | 'trust' | 'risk'
  holdingStatus: '保有' | '非保有' | '共通'
}

export interface CommitteeDecision {
  generatedAt: string
  verdict: {
    label: string
    tone: 'positive' | 'caution' | 'negative'
    noTrade: boolean
    summary: string
  }
  stance: string
  rationale: string[]
  focusPoints: string[]
  risks: string[]
  actions: CommitteeAction[]
}

function uniqueTop(items: string[], limit: number) {
  return Array.from(new Set(items.filter(Boolean))).slice(0, limit)
}

function resolveVerdict(
  mode: ZeroBasePlan['board']['marketMode'],
  shortTermSignal: TrustPortfolioPlan['shortTermSignal'],
) {
  if (mode === 'emergency') {
    return {
      label: '防御最優先',
      tone: 'negative' as const,
      noTrade: true,
    }
  }
  if (mode === 'caution' || shortTermSignal === 'BEAR' || shortTermSignal === 'WAIT') {
    return {
      label: '慎重運用',
      tone: 'caution' as const,
      noTrade: false,
    }
  }
  return {
    label: '攻守バランス',
    tone: 'positive' as const,
    noTrade: false,
  }
}

function buildActionList(input: {
  zeroPlan: ZeroBasePlan
  trustPlan: TrustPortfolioPlan
  holdings: Holding[]
  noTrade: boolean
}): CommitteeAction[] {
  const holdingCodes = new Set(input.holdings.map(holding => holding.code))
  const items: CommitteeAction[] = []

  input.zeroPlan.proposals.slice(0, 4).forEach((proposal, index) => {
    const priority =
      proposal.action === 'SELL'
        ? 'high'
        : proposal.action === 'BUY'
        ? 'medium'
        : 'low'
    items.push({
      id: `stock-${proposal.id}`,
      title: `${proposal.action} ${proposal.name}`,
      detail:
        proposal.amount > 0
          ? `${Math.round(proposal.amount).toLocaleString('ja-JP')}円を分割執行。`
          : '執行条件が揃うまで待機。',
      reason: proposal.reason,
      priority,
      domain: 'stock',
      holdingStatus: holdingCodes.has(proposal.code) ? '保有' : '非保有',
    })
    if (index >= 3) return
  })

  input.trustPlan.executionQueue.slice(0, 3).forEach(item => {
    items.push({
      id: item.id,
      title: item.title,
      detail: item.detail,
      reason: '投信専用の短期シグナルと配分差分から算出。',
      priority: item.priority,
      domain: 'trust',
      holdingStatus: '共通',
    })
  })

  if (input.noTrade) {
    items.unshift({
      id: 'risk-notrade',
      title: 'ノートレード判定',
      detail: '新規エントリーを停止し、既存ポジションのリスク圧縮を優先。',
      reason: '市場ボラティリティが高く、執行コストと下振れ確率が高いため。',
      priority: 'high',
      domain: 'risk',
      holdingStatus: '共通',
    })
  }

  const rank = { high: 0, medium: 1, low: 2 }
  return items
    .sort((left, right) => rank[left.priority] - rank[right.priority])
    .slice(0, 8)
}

export function buildCommitteeDecision(input: {
  zeroPlan: ZeroBasePlan
  stockPlan: StockPortfolioPlan
  trustPlan: TrustPortfolioPlan
  metrics: PortfolioMetrics | null
  market: Market
  holdings: Holding[]
}): CommitteeDecision {
  const verdict = resolveVerdict(
    input.zeroPlan.board.marketMode,
    input.trustPlan.shortTermSignal,
  )
  const risks = uniqueTop(
    [
      ...input.zeroPlan.board.riskAlerts,
      input.metrics && input.metrics.sharpe < 0.8
        ? `Sharpe ${input.metrics.sharpe.toFixed(2)} と低位。リスク対比の効率が悪化。`
        : '',
      input.metrics && input.metrics.sigma > 0.25
        ? `想定ボラ ${(input.metrics.sigma * 100).toFixed(1)}% で高め。`
        : '',
      input.stockPlan.lockCount > 0
        ? `個別株 ${input.stockPlan.lockCount}銘柄が売却ロック中。`
        : '',
      input.trustPlan.shortTermSignal === 'WAIT'
        ? '日本株投信は条件未達。待機優先で無理な回転を避ける。'
        : '',
      input.trustPlan.shortTermSignal === 'BEAR'
        ? '日本株投信はベア判定。リスク資産の追撃を抑える。'
        : '',
    ],
    6,
  )

  const rationale = uniqueTop(
    [
      input.zeroPlan.board.conclusion,
      ...input.zeroPlan.board.highConviction.map(
        item =>
          `${item.name}: ${item.rule.entryRationale}（確信度 ${Math.round(item.confidence * 100)}%）`,
      ),
      input.trustPlan.shortTermSummary,
      `市場モード ${input.zeroPlan.board.modeLabel} / 日経 ${input.market.nikkeiChgPct >= 0 ? '+' : ''}${input.market.nikkeiChgPct.toFixed(2)}% / VIX ${input.market.vix.toFixed(1)}`,
    ],
    5,
  )

  const focusPoints = uniqueTop(
    [
      ...input.stockPlan.rebalanceTop.slice(0, 4).map(item => {
        const direction = item.diffValue >= 0 ? '積み増し' : '圧縮'
        return `${item.name}: 推奨比率 ${(item.targetWeight * 100).toFixed(1)}%（${direction} ${Math.abs(Math.round(item.diffValue)).toLocaleString('ja-JP')}円）`
      }),
      ...input.trustPlan.policyRows.map(
        item =>
          `${item.label}: 現在 ${(item.currentRatio * 100).toFixed(1)}% / 目標 ${(item.targetRatio * 100).toFixed(1)}%`,
      ),
    ],
    6,
  )

  const actions = buildActionList({
    zeroPlan: input.zeroPlan,
    trustPlan: input.trustPlan,
    holdings: input.holdings,
    noTrade: verdict.noTrade,
  })

  return {
    generatedAt: new Date().toISOString(),
    verdict: {
      ...verdict,
      summary: input.zeroPlan.board.conclusion,
    },
    stance: verdict.noTrade
      ? '新規は止め、既存ポジションの前提崩れ監視を優先'
      : verdict.tone === 'caution'
      ? '分割執行でサイズを抑えつつ差分調整'
      : '高確信銘柄を中心に理想PFとの差分を埋める',
    rationale,
    focusPoints,
    risks: risks.length > 0 ? risks : ['重大なリスク警告なし'],
    actions,
  }
}
