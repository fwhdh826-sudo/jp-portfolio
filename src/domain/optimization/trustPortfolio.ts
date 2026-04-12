import type {
  FlowData,
  MacroSnapshot,
  MarginData,
  Market,
  SQCalendar,
  Trust,
  TrustPolicy,
} from '../../types'
import type { TrustShortTrackingStats } from '../learning/trustShortTracker'

export type TrustSignalAction =
  | 'BULL'
  | 'BEAR'
  | 'WAIT'
  | 'BUY'
  | 'TRIM'
  | 'HOLD'
  | 'EXIT'

export type ConditionStatus = 'pass' | 'warn' | 'fail'

export interface TrustConditionRow {
  id: string
  label: string
  status: ConditionStatus
  detail: string
}

export interface TrustSignalRow {
  id: string
  name: string
  abbr: string
  action: TrustSignalAction
  role: 'CORE' | 'SATELLITE'
  leveraged: boolean
  score: number
  suggestedAmount: number
  rationale: string[]
  holdingStance: string
  entryRule: string
  takeProfitRule: string
  stopLossRule: string
  invalidationRule: string
}

export interface TrustPolicyRow {
  policy: TrustPolicy
  label: string
  currentValue: number
  currentRatio: number
  targetRatio: number
  targetValue: number
  diffValue: number
  recommendation: 'BUY' | 'TRIM' | 'HOLD'
  reason: string
}

export interface TrustExecutionItem {
  id: string
  title: string
  detail: string
  priority: 'high' | 'medium' | 'low'
  action: TrustSignalAction
}

export interface TrustShortMode {
  decision: 'BULL' | 'BEAR' | 'WAIT'
  candidateDirection: 'BULL' | 'BEAR' | 'WAIT'
  confidence: number
  conditionsPassed: number
  checklist: TrustConditionRow[]
  summary: string
  waitReasons: string[]
  canEnter: boolean
  blockedByDailyLimit: boolean
  entryLimitPerDay: number
  coreBudget: number
  satelliteBudget: number
  recommendedCoreBudget: number
  recommendedSatelliteBudget: number
  takeProfitRule: string
  partialTakeProfitRule: string
  stopLossRule: string
  maxHoldingRule: string
  invalidationRule: string
  leveragedWarning: string
  coreNote: string
}

export interface TrustPortfolioPlan {
  generatedAt: string
  shortTermSignal: 'BULL' | 'BEAR' | 'WAIT'
  shortTermSummary: string
  shortTermMode: TrustShortMode
  policyRows: TrustPolicyRow[]
  shortTermRows: TrustSignalRow[]
  executionQueue: TrustExecutionItem[]
  performance30d: TrustShortTrackingStats
  marketContext: {
    nikkeiDirection: number
    nikkeiFuturesDirection: number
    nikkeiVI: number
    vix: number
    volatilitySpread: number
    volatilitySpreadChg: number
    sqDays: number
    foreignFlow: number
    marginRatio: number
    todayEntryCount: number
  }
}

const POLICY_LABEL: Record<TrustPolicy, string> = {
  JAPAN_SHORTTERM: '日本株投信（超短期）',
  OVERSEAS_LONGTERM: '海外投信（中長期）',
  GOLD: 'ゴールド（分散）',
}

const EMPTY_STATS: TrustShortTrackingStats = {
  trackedDays: 0,
  executions: 0,
  waitDays: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  postWaitWins: 0,
  postWaitWinRate: 0,
}

const CORE_BUDGET = 4_500_000
const SATELLITE_BUDGET = 1_000_000
const ENTRY_CONFIDENCE_THRESHOLD = 90
const ENTRY_CONDITION_THRESHOLD = 3

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function roundToTenThousand(value: number) {
  return Math.max(0, Math.round(value / 10_000) * 10_000)
}

function isLeveragedTrust(item: Trust) {
  const lower = `${item.name} ${item.abbr}`.toLowerCase()
  return (
    lower.includes('ブル') ||
    lower.includes('ベア') ||
    lower.includes('レバ') ||
    lower.includes('3倍') ||
    lower.includes('4.3') ||
    item.sigma >= 0.4 ||
    item.cost >= 1.2
  )
}

function isBearTrust(item: Trust) {
  const lower = `${item.name} ${item.abbr}`.toLowerCase()
  return lower.includes('ベア') || lower.includes('インバース') || lower.includes('inverse')
}

function normalizePolicyRatio(input: Record<TrustPolicy, number>) {
  const sum = Object.values(input).reduce((acc, value) => acc + value, 0)
  if (sum <= 0.0001) return input
  return {
    JAPAN_SHORTTERM: input.JAPAN_SHORTTERM / sum,
    OVERSEAS_LONGTERM: input.OVERSEAS_LONGTERM / sum,
    GOLD: input.GOLD / sum,
  } as Record<TrustPolicy, number>
}

function statusFromValue(value: number, passThreshold: number, warnThreshold: number, highIsGood = true): ConditionStatus {
  if (highIsGood) {
    if (value >= passThreshold) return 'pass'
    if (value >= warnThreshold) return 'warn'
    return 'fail'
  }

  if (value <= passThreshold) return 'pass'
  if (value <= warnThreshold) return 'warn'
  return 'fail'
}

function countPass(rows: TrustConditionRow[]) {
  return rows.filter(row => row.status === 'pass').length
}

function countWarn(rows: TrustConditionRow[]) {
  return rows.filter(row => row.status === 'warn').length
}

function buildBullConditions(input: {
  futuresChgPct: number
  vix: number
  vixChg: number
  nikkeiVIChg: number
  spreadChg: number
  sqDays: number
}) {
  const momentum = statusFromValue(input.futuresChgPct, 1.2, 0.6, true)
  const vixStableOrDown = input.vix <= 17 && input.vixChg <= 0.2
  const vix = vixStableOrDown
    ? 'pass'
    : input.vix <= 19 && input.vixChg <= 0.8
    ? 'warn'
    : 'fail'
  const vi = input.nikkeiVIChg < 0 || input.spreadChg <= 0
    ? 'pass'
    : input.nikkeiVIChg <= 0.3 || input.spreadChg <= 0.25
    ? 'warn'
    : 'fail'
  const sq = statusFromValue(input.sqDays, 7, 5, true)

  return [
    {
      id: 'bull-momentum',
      label: '日経先物ChgPct ≥ +1.2%',
      status: momentum,
      detail: `現在 ${input.futuresChgPct >= 0 ? '+' : ''}${input.futuresChgPct.toFixed(2)}%`,
    },
    {
      id: 'bull-vix',
      label: 'VIX ≤ 17.0 かつ安定/低下',
      status: vix,
      detail: `VIX ${input.vix.toFixed(2)} / 前日差 ${input.vixChg >= 0 ? '+' : ''}${input.vixChg.toFixed(2)}`,
    },
    {
      id: 'bull-vi',
      label: '日経VI低下 or volatilitySpread縮小',
      status: vi,
      detail: `日経VI差 ${input.nikkeiVIChg >= 0 ? '+' : ''}${input.nikkeiVIChg.toFixed(2)} / spread差 ${input.spreadChg >= 0 ? '+' : ''}${input.spreadChg.toFixed(2)}`,
    },
    {
      id: 'bull-sq',
      label: 'SQ残り日数 ≥ 7日',
      status: sq,
      detail: `残り ${input.sqDays}営業日`,
    },
  ] satisfies TrustConditionRow[]
}

function buildBearConditions(input: {
  futuresChgPct: number
  vix: number
  vixChgPct: number
  nikkeiVI: number
  nikkeiVIChg: number
  spreadChg: number
}) {
  const momentum = statusFromValue(input.futuresChgPct, -1.2, -0.6, false)
  const vix = input.vix >= 26 || input.vixChgPct >= 5
    ? 'pass'
    : input.vix >= 23 || input.vixChgPct >= 3
    ? 'warn'
    : 'fail'
  const vi = input.nikkeiVI >= 24 || input.nikkeiVIChg > 0
    ? 'pass'
    : input.nikkeiVI >= 22 || input.nikkeiVIChg > -0.15
    ? 'warn'
    : 'fail'
  const spread = input.spreadChg > 0
    ? 'pass'
    : input.spreadChg > -0.2
    ? 'warn'
    : 'fail'

  return [
    {
      id: 'bear-momentum',
      label: '日経先物ChgPct ≤ -1.2%',
      status: momentum,
      detail: `現在 ${input.futuresChgPct >= 0 ? '+' : ''}${input.futuresChgPct.toFixed(2)}%`,
    },
    {
      id: 'bear-vix',
      label: 'VIX ≥ 26 または +5%以上スパイク',
      status: vix,
      detail: `VIX ${input.vix.toFixed(2)} / 前日比 ${input.vixChgPct >= 0 ? '+' : ''}${input.vixChgPct.toFixed(2)}%`,
    },
    {
      id: 'bear-vi',
      label: '日経VI高止まり or 上昇',
      status: vi,
      detail: `日経VI ${input.nikkeiVI.toFixed(2)} / 前日差 ${input.nikkeiVIChg >= 0 ? '+' : ''}${input.nikkeiVIChg.toFixed(2)}`,
    },
    {
      id: 'bear-spread',
      label: 'volatilitySpread が方向一致',
      status: spread,
      detail: `spread差 ${input.spreadChg >= 0 ? '+' : ''}${input.spreadChg.toFixed(2)}`,
    },
  ] satisfies TrustConditionRow[]
}

function calcBullConfidence(params: {
  pass: number
  warn: number
  futuresChgPct: number
  vix: number
  vixChg: number
  spreadChg: number
  sqDays: number
}) {
  const momentumBonus = clamp((params.futuresChgPct - 1.2) * 8, 0, 13)
  const vixBonus = clamp((17 - params.vix) * 2.2, 0, 9)
  const stableBonus = params.vixChg <= 0 ? 4 : params.vixChg <= 0.2 ? 2 : 0
  const spreadBonus = params.spreadChg <= 0 ? 4 : params.spreadChg <= 0.15 ? 2 : 0
  const sqBonus = params.sqDays >= 7 ? 5 : params.sqDays >= 5 ? 2 : 0
  const allMatchBonus = params.pass === 4 ? 10 : params.pass === 3 ? 4 : -8

  const score =
    44 +
    params.pass * 11 +
    params.warn * 4 +
    momentumBonus +
    vixBonus +
    stableBonus +
    spreadBonus +
    sqBonus +
    allMatchBonus

  return Math.round(clamp(score, 30, 98))
}

function calcBearConfidence(params: {
  pass: number
  warn: number
  futuresChgPct: number
  vix: number
  vixChgPct: number
  nikkeiVI: number
  nikkeiVIChg: number
  spreadChg: number
}) {
  const momentumBonus = clamp((-1.2 - params.futuresChgPct) * 8, 0, 13)
  const vixBonus = params.vix >= 26 ? 8 : params.vix >= 24 ? 4 : 0
  const vixSpikeBonus = params.vixChgPct >= 5 ? 6 : params.vixChgPct >= 3 ? 3 : 0
  const viBonus = params.nikkeiVI >= 24 ? 4 : 0
  const viChgBonus = params.nikkeiVIChg > 0 ? 4 : params.nikkeiVIChg > -0.1 ? 2 : 0
  const spreadBonus = params.spreadChg > 0 ? 5 : params.spreadChg > -0.15 ? 2 : 0
  const allMatchBonus = params.pass === 4 ? 10 : params.pass === 3 ? 4 : -8

  const score =
    43 +
    params.pass * 11 +
    params.warn * 4 +
    momentumBonus +
    vixBonus +
    vixSpikeBonus +
    viBonus +
    viChgBonus +
    spreadBonus +
    allMatchBonus

  return Math.round(clamp(score, 30, 98))
}

function buildShortMode(params: {
  market: Market
  macro: MacroSnapshot | null
  sqCalendar: SQCalendar | null
  todayEntryCount: number
}): TrustShortMode {
  const futuresChgPct = Number.isFinite(params.market.nikkeiFuturesChgPct)
    ? Number(params.market.nikkeiFuturesChgPct)
    : params.market.nikkeiChgPct
  const vix = params.market.vix
  const vixChg = params.macro?.vixChg ?? 0
  const vixPrev = Math.max(0.1, vix - vixChg)
  const vixChgPct = (vixChg / vixPrev) * 100
  const nikkeiVI = params.macro?.nikkeiVI ?? vix * 0.95
  const nikkeiVIChg = params.macro?.nikkeiVIChg ?? vixChg * 0.95
  const spreadChg = nikkeiVIChg - vixChg
  const sqDays = params.sqCalendar?.nextSQ?.dayUntil ?? 99

  const bullChecklist = buildBullConditions({
    futuresChgPct,
    vix,
    vixChg,
    nikkeiVIChg,
    spreadChg,
    sqDays,
  })
  const bearChecklist = buildBearConditions({
    futuresChgPct,
    vix,
    vixChgPct,
    nikkeiVI,
    nikkeiVIChg,
    spreadChg,
  })

  const bullPass = countPass(bullChecklist)
  const bearPass = countPass(bearChecklist)
  const bullWarn = countWarn(bullChecklist)
  const bearWarn = countWarn(bearChecklist)

  const bullConfidence = calcBullConfidence({
    pass: bullPass,
    warn: bullWarn,
    futuresChgPct,
    vix,
    vixChg,
    spreadChg,
    sqDays,
  })
  const bearConfidence = calcBearConfidence({
    pass: bearPass,
    warn: bearWarn,
    futuresChgPct,
    vix,
    vixChgPct,
    nikkeiVI,
    nikkeiVIChg,
    spreadChg,
  })

  const candidateDirection: 'BULL' | 'BEAR' | 'WAIT' =
    bullConfidence >= bearConfidence + 6 && bullPass >= 2
      ? 'BULL'
      : bearConfidence >= bullConfidence + 6 && bearPass >= 2
      ? 'BEAR'
      : 'WAIT'

  const candidateChecklist =
    candidateDirection === 'BULL'
      ? bullChecklist
      : candidateDirection === 'BEAR'
      ? bearChecklist
      : bullConfidence >= bearConfidence
      ? bullChecklist
      : bearChecklist

  const candidateConfidence =
    candidateDirection === 'BULL'
      ? bullConfidence
      : candidateDirection === 'BEAR'
      ? bearConfidence
      : Math.max(bullConfidence, bearConfidence)

  const candidatePass =
    candidateDirection === 'BULL'
      ? bullPass
      : candidateDirection === 'BEAR'
      ? bearPass
      : Math.max(bullPass, bearPass)

  const blockedByDailyLimit = params.todayEntryCount >= 1
  const canEnter =
    candidateDirection !== 'WAIT' &&
    candidateConfidence >= ENTRY_CONFIDENCE_THRESHOLD &&
    candidatePass >= ENTRY_CONDITION_THRESHOLD &&
    !blockedByDailyLimit

  const decision: 'BULL' | 'BEAR' | 'WAIT' = canEnter ? candidateDirection : 'WAIT'

  const waitReasons: string[] = []
  if (candidateDirection === 'WAIT') {
    waitReasons.push('ブル/ベアの方向一致が弱く、待機優先。')
  }
  if (candidateConfidence < ENTRY_CONFIDENCE_THRESHOLD) {
    waitReasons.push(
      `OS確信度 ${candidateConfidence}% が実行基準 ${ENTRY_CONFIDENCE_THRESHOLD}% を下回る。`,
    )
  }
  if (candidatePass < ENTRY_CONDITION_THRESHOLD) {
    waitReasons.push(`4条件の一致数 ${candidatePass}/4（実行基準 3/4）`) 
  }
  if (blockedByDailyLimit) {
    waitReasons.push('1日最大エントリー1回の上限に到達。')
  }

  const recommendedCoreBudget = decision === 'WAIT' ? 0 : CORE_BUDGET
  const recommendedSatelliteBudget =
    decision === 'WAIT' ? 0 : candidateConfidence >= 93 ? SATELLITE_BUDGET : 0

  const summary =
    decision === 'BULL'
      ? `ブル推奨（確信度 ${candidateConfidence}%）。4条件 ${candidatePass}/4 一致のため、超短期回転を許可。`
      : decision === 'BEAR'
      ? `ベア推奨（確信度 ${candidateConfidence}%）。4条件 ${candidatePass}/4 一致のため、下落局面の短期回転を許可。`
      : `待機推奨。確信度 ${candidateConfidence}% / 条件一致 ${candidatePass}/4。実行条件が揃うまで見送る。`

  return {
    decision,
    candidateDirection,
    confidence: candidateConfidence,
    conditionsPassed: candidatePass,
    checklist: candidateChecklist,
    summary,
    waitReasons,
    canEnter,
    blockedByDailyLimit,
    entryLimitPerDay: 1,
    coreBudget: CORE_BUDGET,
    satelliteBudget: SATELLITE_BUDGET,
    recommendedCoreBudget,
    recommendedSatelliteBudget,
    takeProfitRule: '+5%到達 または シグナル弱まりで利確',
    partialTakeProfitRule: '+7%到達時に50%利確',
    stopLossRule: '-2.8%で即時売却',
    maxHoldingRule: '最長2営業日（中期保有禁止）',
    invalidationRule: '4条件のうち2条件以上が崩れたら前提崩れ',
    leveragedWarning: 'ブルベアは短期専用。即時売却必須。減価リスクが高いため中期保有は禁止。',
    coreNote: '現物コア枠は減価リスクが低く、中期待機を許容。',
  }
}

function resolvePolicyTargets(
  market: Market,
  shortMode: TrustShortMode,
): Record<TrustPolicy, number> {
  let target = {
    JAPAN_SHORTTERM: 0.14,
    OVERSEAS_LONGTERM: 0.72,
    GOLD: 0.14,
  } as Record<TrustPolicy, number>

  if (shortMode.decision !== 'WAIT') {
    target = {
      JAPAN_SHORTTERM: target.JAPAN_SHORTTERM + 0.03,
      OVERSEAS_LONGTERM: target.OVERSEAS_LONGTERM - 0.02,
      GOLD: target.GOLD - 0.01,
    }
  }

  if (market.regime === 'bear' || market.vix >= 26) {
    target = {
      JAPAN_SHORTTERM: target.JAPAN_SHORTTERM - 0.03,
      OVERSEAS_LONGTERM: target.OVERSEAS_LONGTERM - 0.01,
      GOLD: target.GOLD + 0.04,
    }
  }

  if (market.regime === 'bull' && market.vix <= 18 && shortMode.decision === 'BULL') {
    target = {
      JAPAN_SHORTTERM: target.JAPAN_SHORTTERM + 0.02,
      OVERSEAS_LONGTERM: target.OVERSEAS_LONGTERM - 0.02,
      GOLD: target.GOLD,
    }
  }

  target = {
    JAPAN_SHORTTERM: clamp(target.JAPAN_SHORTTERM, 0.08, 0.28),
    OVERSEAS_LONGTERM: clamp(target.OVERSEAS_LONGTERM, 0.52, 0.80),
    GOLD: clamp(target.GOLD, 0.08, 0.24),
  }

  return normalizePolicyRatio(target)
}

function buildPolicyRows(
  trust: Trust[],
  targetRatios: Record<TrustPolicy, number>,
  shortMode: TrustShortMode,
): TrustPolicyRow[] {
  const totals: Record<TrustPolicy, number> = {
    JAPAN_SHORTTERM: trust
      .filter(item => item.policy === 'JAPAN_SHORTTERM')
      .reduce((sum, item) => sum + item.eval, 0),
    OVERSEAS_LONGTERM: trust
      .filter(item => item.policy === 'OVERSEAS_LONGTERM')
      .reduce((sum, item) => sum + item.eval, 0),
    GOLD: trust
      .filter(item => item.policy === 'GOLD')
      .reduce((sum, item) => sum + item.eval, 0),
  }

  const totalValue = Object.values(totals).reduce((sum, value) => sum + value, 0)
  const policies: TrustPolicy[] = ['JAPAN_SHORTTERM', 'OVERSEAS_LONGTERM', 'GOLD']

  return policies.map(policy => {
    const currentValue = totals[policy]
    const currentRatio = totalValue > 0 ? currentValue / totalValue : 0
    const targetRatio = targetRatios[policy]
    const targetValue = totalValue * targetRatio
    const diffValue = targetValue - currentValue
    const recommendation =
      diffValue > 200_000 ? 'BUY' : diffValue < -200_000 ? 'TRIM' : 'HOLD'

    const reason =
      policy === 'JAPAN_SHORTTERM'
        ? shortMode.decision === 'WAIT'
          ? '条件未達日は回転枠を増やさず待機。'
          : '超短期ゾーンとして回転余力を確保。'
        : policy === 'OVERSEAS_LONGTERM'
        ? '中長期コアとして分散維持。短期シグナルで極端に動かさない。'
        : '高ボラ局面の緩衝材として維持。'

    return {
      policy,
      label: POLICY_LABEL[policy],
      currentValue,
      currentRatio,
      targetRatio,
      targetValue,
      diffValue,
      recommendation,
      reason,
    }
  })
}

function buildShortTermRows(
  trust: Trust[],
  shortMode: TrustShortMode,
): TrustSignalRow[] {
  const japanTrust = trust.filter(item => item.policy === 'JAPAN_SHORTTERM')
  const coreFunds = japanTrust.filter(item => !isLeveragedTrust(item))
  const satelliteFunds = japanTrust.filter(item => isLeveragedTrust(item))

  const corePerFund =
    coreFunds.length > 0
      ? roundToTenThousand(shortMode.recommendedCoreBudget / coreFunds.length)
      : 0
  const satPerFund =
    satelliteFunds.length > 0
      ? roundToTenThousand(shortMode.recommendedSatelliteBudget / satelliteFunds.length)
      : 0

  return japanTrust.map(item => {
    const leveraged = isLeveragedTrust(item)
    const bearProduct = isBearTrust(item)
    const role: 'CORE' | 'SATELLITE' = leveraged ? 'SATELLITE' : 'CORE'

    let action: TrustSignalAction = 'WAIT'
    let suggestedAmount = 0

    if (shortMode.decision === 'BULL') {
      if (role === 'CORE') {
        action = 'BUY'
        suggestedAmount = corePerFund
      } else if (!bearProduct) {
        action = satPerFund > 0 ? 'BUY' : 'WAIT'
        suggestedAmount = satPerFund
      } else {
        action = 'EXIT'
      }
    } else if (shortMode.decision === 'BEAR') {
      if (role === 'CORE') {
        action = 'TRIM'
      } else if (bearProduct) {
        action = satPerFund > 0 ? 'BUY' : 'WAIT'
        suggestedAmount = satPerFund
      } else {
        action = 'EXIT'
      }
    } else {
      action = role === 'SATELLITE' ? 'EXIT' : 'WAIT'
    }

    const rationale = [
      `${role === 'CORE' ? 'コア回転枠' : 'サテライト高確信枠'}で管理。`,
      `確信度 ${shortMode.confidence}% / 条件一致 ${shortMode.conditionsPassed}/4`,
      leveraged
        ? 'ブルベア減価を避けるため、2営業日以内の解消を前提。'
        : '現物は減価リスクが低く、待機中心で回転。',
    ]

    const holdingStance = leveraged
      ? '当日〜2営業日以内で解消（中期保有禁止）'
      : '条件未達時は待機。執行しても最長2営業日で再評価'

    return {
      id: item.id,
      name: item.name,
      abbr: item.abbr,
      action,
      role,
      leveraged,
      score: shortMode.confidence,
      suggestedAmount,
      rationale,
      holdingStance,
      entryRule:
        '4条件ほぼ一致（3/4以上）かつOS確信度90%以上で、1日1回のみ実行。',
      takeProfitRule: `${shortMode.takeProfitRule} / ${shortMode.partialTakeProfitRule}`,
      stopLossRule: shortMode.stopLossRule,
      invalidationRule: shortMode.invalidationRule,
    } satisfies TrustSignalRow
  })
}

function resolveQueuePriority(action: TrustSignalAction): 'high' | 'medium' | 'low' {
  if (action === 'EXIT' || action === 'TRIM') return 'high'
  if (action === 'BUY' || action === 'BEAR' || action === 'BULL') return 'medium'
  return 'low'
}

function buildExecutionQueue(
  shortMode: TrustShortMode,
  policyRows: TrustPolicyRow[],
  shortRows: TrustSignalRow[],
): TrustExecutionItem[] {
  const headerItem: TrustExecutionItem = {
    id: 'short-header',
    title:
      shortMode.decision === 'BULL'
        ? '今日の判断: ブル推奨'
        : shortMode.decision === 'BEAR'
        ? '今日の判断: ベア推奨'
        : '今日の判断: 待機推奨',
    detail:
      shortMode.decision === 'WAIT'
        ? `${shortMode.summary} ${shortMode.waitReasons[0] ?? ''}`.trim()
        : `${shortMode.summary} 利確 ${shortMode.takeProfitRule} / 損切 ${shortMode.stopLossRule}`,
    priority: shortMode.decision === 'WAIT' ? 'low' : 'high',
    action: shortMode.decision,
  }

  const shortItems = shortRows
    .filter(row => row.action !== 'HOLD')
    .map(row => ({
      id: `short-${row.id}`,
      title: `${row.abbr} ${row.role === 'CORE' ? 'コア' : 'サテライト'}運用`,
      detail:
        row.action === 'BUY'
          ? `${Math.round(row.suggestedAmount).toLocaleString('ja-JP')}円を上限に短期回転。${row.holdingStance}`
          : row.action === 'EXIT'
          ? 'レバ型の持ち越しを避けるため、即時売却を優先。'
          : row.action === 'TRIM'
          ? '弱気局面のためコア枠を縮小し、現金待機へ。'
          : '条件未達のため待機。',
      priority: resolveQueuePriority(row.action),
      action: row.action,
    })) satisfies TrustExecutionItem[]

  const policyItems = policyRows
    .filter(row => Math.abs(row.diffValue) >= 200_000)
    .map(row => ({
      id: `policy-${row.policy}`,
      title: `${row.label} 配分調整`,
      detail:
        row.recommendation === 'BUY'
          ? `${Math.round(row.diffValue).toLocaleString('ja-JP')}円を分割投入。${row.reason}`
          : `${Math.round(Math.abs(row.diffValue)).toLocaleString('ja-JP')}円を圧縮。${row.reason}`,
      priority: resolveQueuePriority(row.recommendation === 'BUY' ? 'BUY' : 'TRIM'),
      action: row.recommendation === 'BUY' ? 'BUY' : 'TRIM',
    })) satisfies TrustExecutionItem[]

  const priorityRank = { high: 0, medium: 1, low: 2 }
  return [headerItem, ...shortItems, ...policyItems]
    .sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority])
    .slice(0, 10)
}

export function buildTrustPortfolioPlan(input: {
  trust: Trust[]
  market: Market
  macro: MacroSnapshot | null
  sqCalendar: SQCalendar | null
  margin: MarginData | null
  flows: FlowData | null
  todayEntryCount?: number
  performance30d?: TrustShortTrackingStats
}): TrustPortfolioPlan {
  const shortMode = buildShortMode({
    market: input.market,
    macro: input.macro,
    sqCalendar: input.sqCalendar,
    todayEntryCount: input.todayEntryCount ?? 0,
  })

  const targetRatios = resolvePolicyTargets(input.market, shortMode)
  const policyRows = buildPolicyRows(input.trust, targetRatios, shortMode)
  const shortTermRows = buildShortTermRows(input.trust, shortMode)
  const executionQueue = buildExecutionQueue(shortMode, policyRows, shortTermRows)

  const nikkeiVI = input.macro?.nikkeiVI ?? input.market.vix * 0.95
  const nikkeiVIChg = input.macro?.nikkeiVIChg ?? (input.macro?.vixChg ?? 0) * 0.95
  const vix = input.market.vix
  const vixChg = input.macro?.vixChg ?? 0
  const volatilitySpread = nikkeiVI - vix
  const volatilitySpreadChg = nikkeiVIChg - vixChg
  const futuresChgPct = Number.isFinite(input.market.nikkeiFuturesChgPct)
    ? Number(input.market.nikkeiFuturesChgPct)
    : input.market.nikkeiChgPct

  return {
    generatedAt: new Date().toISOString(),
    shortTermSignal: shortMode.decision,
    shortTermSummary: shortMode.summary,
    shortTermMode: shortMode,
    policyRows,
    shortTermRows,
    executionQueue,
    performance30d: input.performance30d ?? EMPTY_STATS,
    marketContext: {
      nikkeiDirection: input.market.nikkeiChgPct,
      nikkeiFuturesDirection: futuresChgPct,
      nikkeiVI,
      vix,
      volatilitySpread,
      volatilitySpreadChg,
      sqDays: input.sqCalendar?.nextSQ?.dayUntil ?? 99,
      foreignFlow: input.flows?.foreignNet ?? 0,
      marginRatio: input.margin?.ratio ?? 0,
      todayEntryCount: input.todayEntryCount ?? 0,
    },
  }
}
