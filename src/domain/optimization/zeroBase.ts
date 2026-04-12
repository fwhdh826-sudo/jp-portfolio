import type {
  Holding,
  HoldingAnalysis,
  Market,
  Trust,
  MacroSnapshot,
  SQCalendar,
  PortfolioMetrics,
  AssetUniverse,
} from '../../types'
import type { AssetCategorySummary } from '../../types/universe'
import { getSellableDate, isSellLocked } from '../constraints/stockLock'

export type MarketMode = 'normal' | 'caution' | 'emergency'

export interface ProposalRule {
  entryRationale: string
  holdingPremise: string
  takeProfit: string
  stopLoss: string
  invalidation: string
  splitExecution: string
  reverseSignal: string
}

export interface TradeProposal {
  id: string
  action: 'BUY' | 'SELL' | 'WAIT'
  code: string
  name: string
  amount: number
  score: number
  ev: number
  confidence: number
  strategyRank: string
  reason: string
  rule: ProposalRule
}

export interface ConclusionBoard {
  marketMode: MarketMode
  modeLabel: string
  conclusion: string
  todo: string[]
  riskAlerts: string[]
  highConviction: TradeProposal[]
}

export interface ZeroBasePlan {
  generatedAt: string
  board: ConclusionBoard
  proposals: TradeProposal[]
  categoryDiffs: AssetCategorySummary[]
}

export interface ZeroBaseInput {
  holdings: Holding[]
  trust: Trust[]
  analysis: HoldingAnalysis[]
  market: Market
  macro: MacroSnapshot | null
  sqCalendar: SQCalendar | null
  metrics: PortfolioMetrics | null
  universe: AssetUniverse | null
  cash: number
  cashReserve: number
  addRoom: number
}

function roundToUnit(value: number, unit = 10_000): number {
  return Math.max(0, Math.round(value / unit) * unit)
}

function formatJPY(n: number): string {
  return `${Math.round(n).toLocaleString('ja-JP')}円`
}

function getModeLabel(mode: MarketMode): string {
  if (mode === 'emergency') return '緊急モード'
  if (mode === 'caution') return '警戒モード'
  return '通常モード'
}

function deriveMarketMode(
  market: Market,
  macro: MacroSnapshot | null,
  sqCalendar: SQCalendar | null,
): { mode: MarketMode; reasons: string[] } {
  const reasons: string[] = []
  const vix = market.vix
  const nikkeiVI = macro?.nikkeiVI ?? 0
  const sqDays = sqCalendar?.nextSQ?.dayUntil ?? 99

  if (vix >= 30) reasons.push(`VIX ${vix.toFixed(1)} が暴落水準`) 
  else if (vix >= 25) reasons.push(`VIX ${vix.toFixed(1)} が警戒水準`)

  if (nikkeiVI >= 35) reasons.push(`日経VI ${nikkeiVI.toFixed(1)} がパニック水準`)
  else if (nikkeiVI >= 25) reasons.push(`日経VI ${nikkeiVI.toFixed(1)} が高ボラ水準`)

  if (sqDays <= 2) reasons.push(`SQ直前（残り${sqDays}営業日）`)
  if (market.regime === 'bear') reasons.push('市場レジームがベア')

  const mode: MarketMode =
    vix >= 30 || nikkeiVI >= 35
      ? 'emergency'
      : reasons.length > 0
      ? 'caution'
      : 'normal'

  return { mode, reasons }
}

function fallbackUniverse(input: ZeroBaseInput): AssetCategorySummary[] {
  const jpStockValue = input.holdings.reduce((s, h) => s + h.eval, 0)
  const jpTrustValue = input.trust.filter(f => f.policy === 'JAPAN_SHORTTERM').reduce((s, f) => s + f.eval, 0)
  const ovTrustValue = input.trust.filter(f => f.policy === 'OVERSEAS_LONGTERM').reduce((s, f) => s + f.eval, 0)
  const goldValue = input.trust.filter(f => f.policy === 'GOLD').reduce((s, f) => s + f.eval, 0)
  const total = jpStockValue + jpTrustValue + ovTrustValue + goldValue + input.cash + input.cashReserve + input.addRoom

  const pack = (
    cls: AssetCategorySummary['class'],
    label: string,
    role: string,
    currentValue: number,
    targetRatio: number,
  ): AssetCategorySummary => {
    const currentRatio = total > 0 ? currentValue / total : 0
    const targetValue = total * targetRatio
    return {
      class: cls,
      label,
      role,
      horizon: 'mid_long',
      currentValue,
      currentRatio,
      targetRatio,
      targetValue,
      diffValue: targetValue - currentValue,
      diffRatio: targetRatio - currentRatio,
      score: 50,
      lastUpdatedAt: null,
    }
  }

  return [
    pack('JP_STOCK', '国内個別株', '成長の取り込み', jpStockValue, 0.15),
    pack('JP_TRUST', '国内株投信', '短期需給対応', jpTrustValue, 0.05),
    pack('OVERSEAS_TRUST', '海外株投信', '中長期の主軸', ovTrustValue, 0.55),
    pack('GOLD', 'ゴールド', '有事ヘッジ', goldValue, 0.05),
    pack('CASH', '現金', '機動資金', input.cash, 0.08),
    pack('CASH_RESERVE', '暴落待機資金', '暴落時の買い余力', input.cashReserve, 0.12),
  ]
}

function buildSellRule(analysis: HoldingAnalysis): ProposalRule {
  return {
    entryRationale: `総合スコア ${analysis.totalScore}/100、EV ${(analysis.ev * 100).toFixed(1)}% で期待値が低い。`,
    holdingPremise: '防御的リバランスを優先し、弱いポジションを縮小する。',
    takeProfit: '戻りで +5% 反発した場合も、残ポジションの段階売却を継続。',
    stopLoss: '売却保留中にさらに -5% 下落したら、保留分も全解消。',
    invalidation: analysis.debate.bullReasons[0]
      ? `前提崩れ解除条件: ${analysis.debate.bullReasons[0]}`
      : '決算上方修正と需給改善が確認できた場合のみ再評価。',
    splitExecution: '50% → 30% → 20% の分割売却。',
    reverseSignal: '再エントリーは score>=75 かつ EV>0 を満たした時のみ。',
  }
}

function buildBuyRule(holding: Holding, analysis: HoldingAnalysis, mode: MarketMode): ProposalRule {
  const priceTarget = holding.target > 0
    ? `目標株価 ${holding.target.toLocaleString('ja-JP')}円到達で50%利確。`
    : '含み益 +18% で50%利確、+25% で追加利確。'

  return {
    entryRationale: analysis.debate.bullReasons[0]
      ? `主根拠: ${analysis.debate.bullReasons[0]}`
      : `総合スコア ${analysis.totalScore}/100、EV ${(analysis.ev * 100).toFixed(1)}% のため。`,
    holdingPremise: 'ファンダメンタルとモメンタムの両立が継続すること。',
    takeProfit: priceTarget,
    stopLoss: '取得単価から -8% で半分、-12% で全決済。',
    invalidation: analysis.debate.bearReasons[0]
      ? `次の条件が出たら前提崩れ: ${analysis.debate.bearReasons[0]}`
      : '決算でEPS成長が急鈍化した場合は前提崩れ。',
    splitExecution: mode === 'normal' ? '30% → 30% → 40% の3分割買い。' : '20% → 80% の2分割で慎重に執行。',
    reverseSignal: '逆方向エントリーは不要。SELL判定へ転換した時のみ検討。',
  }
}

function buildBuyProposals(
  input: ZeroBaseInput,
  mode: MarketMode,
  baseBudget: number,
): TradeProposal[] {
  if (baseBudget < 100_000 || mode === 'emergency') return []

  const totalAssets = (input.universe?.totalValue ?? 0) ||
    input.holdings.reduce((s, h) => s + h.eval, 0) +
    input.trust.reduce((s, f) => s + f.eval, 0) +
    input.cash + input.cashReserve + input.addRoom

  const rawCandidates = input.analysis
    .filter(a => a.decision === 'BUY' && a.ev > 0)
    .sort((a, b) => (b.totalScore + b.confidence * 25) - (a.totalScore + a.confidence * 25))
    .slice(0, 5)

  if (rawCandidates.length === 0) return []

  const scored = rawCandidates.map(a => {
    const attractiveness = Math.max(0.1, (a.totalScore / 100) * (1 + a.ev * 1.5) * (0.6 + a.confidence))
    return { analysis: a, attractiveness }
  })
  const sum = scored.reduce((s, x) => s + x.attractiveness, 0)

  let remaining = roundToUnit(baseBudget)
  const results: TradeProposal[] = []

  for (let i = 0; i < scored.length; i += 1) {
    const { analysis, attractiveness } = scored[i]
    const holding = input.holdings.find(h => h.code === analysis.code)
    if (!holding) continue

    const maxPerPosition = totalAssets * 0.14
    const cap = Math.max(0, maxPerPosition - holding.eval)
    if (cap < 100_000) continue

    const base = i === scored.length - 1
      ? remaining
      : roundToUnit((baseBudget * attractiveness) / Math.max(sum, 0.001))
    const amount = roundToUnit(Math.min(base, cap, remaining))
    if (amount < 100_000) continue

    remaining = Math.max(0, remaining - amount)

    results.push({
      id: `BUY_${holding.code}`,
      action: 'BUY',
      code: holding.code,
      name: holding.name,
      amount,
      score: analysis.totalScore,
      ev: analysis.ev,
      confidence: analysis.confidence,
      strategyRank: analysis.strategyRank,
      reason: `${holding.name} は score ${analysis.totalScore}/100、EV ${(analysis.ev * 100).toFixed(1)}%。理想PFとの差分を埋める候補。`,
      rule: buildBuyRule(holding, analysis, mode),
    })
  }

  return results
}

function buildSellProposals(
  holdings: Holding[],
  analysisByCode: Map<string, HoldingAnalysis>,
  mode: MarketMode,
): TradeProposal[] {
  const results: TradeProposal[] = []

  const sorted = holdings
    .map(h => ({ h, analysis: analysisByCode.get(h.code) }))
    .filter((x): x is { h: Holding; analysis: HoldingAnalysis } => Boolean(x.analysis))
    .filter(x => x.analysis.decision === 'SELL')
    .sort((a, b) => a.analysis.totalScore - b.analysis.totalScore)

  for (const { h, analysis } of sorted) {
    const locked = isSellLocked(h)
    const sellable = !locked

    if (!sellable) {
      const sellableAt = getSellableDate(h)
      results.push({
        id: `WAIT_${h.code}`,
        action: 'WAIT',
        code: h.code,
        name: h.name,
        amount: 0,
        score: analysis.totalScore,
        ev: analysis.ev,
        confidence: analysis.confidence,
        strategyRank: analysis.strategyRank,
        reason: sellableAt
          ? `売却推奨だが、取得3ヶ月ルールで ${sellableAt} まで売却不可。`
          : '売却推奨だが、取得3ヶ月ルールにより現時点では売却不可。',
        rule: {
          entryRationale: `現状は売却ロック中（score ${analysis.totalScore}/100）。`,
          holdingPremise: 'ロック解除までは新規買いを行わず、ポジション維持で監視。',
          takeProfit: sellableAt
            ? `ロック解除予定日(${sellableAt})以降、戻り局面で分割売却。`
            : 'ロック解除後、戻り局面で分割売却。',
          stopLoss: 'ロック解除後に-5%追加下落で即時売却。',
          invalidation: '業績改善とニュース好転でSELL判定が解除された場合。',
          splitExecution: '解除時点で 60% → 40% の2段階売却。',
          reverseSignal: '逆方向エントリーはロック解除後に再分析して判断。',
        },
      })
      continue
    }

    const fraction = mode === 'emergency' ? 1.0 : analysis.totalScore < 35 ? 0.7 : 0.5
    const amount = roundToUnit(h.eval * fraction)

    results.push({
      id: `SELL_${h.code}`,
      action: 'SELL',
      code: h.code,
      name: h.name,
      amount,
      score: analysis.totalScore,
      ev: analysis.ev,
      confidence: analysis.confidence,
      strategyRank: analysis.strategyRank,
      reason: `${h.name} は期待値が弱く、防御的リバランスのため売却。`,
      rule: buildSellRule(analysis),
    })
  }

  return results
}

function buildConclusion(
  mode: MarketMode,
  modeReasons: string[],
  proposals: TradeProposal[],
  categories: AssetCategorySummary[],
  metrics: PortfolioMetrics | null,
  holdings: Holding[],
  cashReserve: number,
): ConclusionBoard {
  const sellCount = proposals.filter(p => p.action === 'SELL').length
  const buyCount = proposals.filter(p => p.action === 'BUY').length

  const conclusion =
    mode === 'emergency'
      ? '本日は緊急モード。新規買いを停止し、売却可能な弱い銘柄の解消を優先。'
      : sellCount > buyCount
      ? '本日は防御寄り。理想PFとの差分を埋めるため、弱い銘柄整理を優先。'
      : buyCount > 0
      ? '本日は攻守バランス。高確信候補を分割で買い、差分を縮める。'
      : '本日は様子見。大きな売買はせず、データ更新を優先。'

  const diffHighlights = [...categories]
    .sort((a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue))
    .slice(0, 3)

  const todo = proposals
    .slice(0, 4)
    .map(p => `${p.action} ${p.name}${p.amount > 0 ? ` ${formatJPY(p.amount)}` : ''}`)

  diffHighlights.forEach(d => {
    if (Math.abs(d.diffValue) >= 500_000) {
      const direction = d.diffValue > 0 ? '買い増し' : '圧縮'
      todo.push(`理想PF差分: ${d.label} を ${direction} ${formatJPY(Math.abs(d.diffValue))}`)
    }
  })

  if (todo.length === 0) {
    todo.push('売買指示なし。次回更新まで監視を継続。')
  }

  const mitsuWeight = holdings
    .filter(h => h.mitsu)
    .reduce((s, h) => s + h.eval, 0) / Math.max(holdings.reduce((s, h) => s + h.eval, 0), 1)

  const riskAlerts = [...modeReasons]
  if (mitsuWeight > 0.35) riskAlerts.push(`三菱系集中 ${(mitsuWeight * 100).toFixed(1)}%（目安35%超）`)
  if ((metrics?.sigma ?? 0) > 0.25) riskAlerts.push(`PFボラ ${(metrics!.sigma * 100).toFixed(1)}%（目安25%超）`)
  if (cashReserve < 5_000_000) riskAlerts.push(`暴落待機資金 ${formatJPY(cashReserve)}（目安5,000,000円未満）`)

  if (riskAlerts.length === 0) riskAlerts.push('重大な警告なし')

  const highConviction = proposals
    .filter(p => p.action === 'BUY' && (p.strategyRank === 'S' || p.strategyRank === 'A' || p.confidence >= 0.72))
    .slice(0, 3)

  return {
    marketMode: mode,
    modeLabel: getModeLabel(mode),
    conclusion,
    todo: Array.from(new Set(todo)).slice(0, 6),
    riskAlerts,
    highConviction,
  }
}

export function buildZeroBasePlan(input: ZeroBaseInput): ZeroBasePlan {
  const { mode, reasons } = deriveMarketMode(input.market, input.macro, input.sqCalendar)

  const analysisByCode = new Map(input.analysis.map(a => [a.code, a]))
  const categoryDiffs = input.universe?.categories ?? fallbackUniverse(input)

  const sellProposals = buildSellProposals(input.holdings, analysisByCode, mode)
  const soldAmount = sellProposals
    .filter(p => p.action === 'SELL')
    .reduce((s, p) => s + p.amount, 0)

  // 待機資金: コア5,000,000円は cashReserve で保持、
  // 追加2,000,000円は市場モードで可変バッファとして管理する。
  const variableBuffer =
    mode === 'normal' ? 1_000_000 : mode === 'caution' ? 2_000_000 : 3_000_000
  const deployableCash = Math.max(0, input.cash - variableBuffer)
  const rawBudget = input.addRoom + deployableCash + soldAmount * 0.7
  const buyBudget = mode === 'normal' ? rawBudget : mode === 'caution' ? rawBudget * 0.5 : 0

  const buyProposals = buildBuyProposals(input, mode, buyBudget)
  const proposals = [...sellProposals, ...buyProposals]
    .sort((a, b) => {
      const order = { SELL: 0, BUY: 1, WAIT: 2 }
      if (order[a.action] !== order[b.action]) return order[a.action] - order[b.action]
      return b.score - a.score
    })

  const board = buildConclusion(
    mode,
    reasons,
    proposals,
    categoryDiffs,
    input.metrics,
    input.holdings,
    input.cashReserve,
  )

  return {
    generatedAt: new Date().toISOString(),
    board,
    proposals,
    categoryDiffs,
  }
}
