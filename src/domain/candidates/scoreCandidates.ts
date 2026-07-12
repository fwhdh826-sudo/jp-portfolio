import type { CandidateBlockedReason } from '../../types'
import type { CandidateAssetType, CandidateDecisionAction, CandidateItem, CandidateSignalState, CandidateConstraintState, CandidateSizingTier, SignalVerdict } from './candidateTypes'
import type { RawCandidate } from './buildCandidateUniverse'
import type { ConstraintContext } from './applyCandidateConstraints'
import { applyCandidateConstraints } from './applyCandidateConstraints'
import { inferTrustRole } from './roleExposure'
import { resolveTrendProxy } from './trendProxy'
import { resolveNewsSignal } from './newsSignal'
import { resolveRegimeSignal } from './regimeSignal'

// P4-A4: sigma 0.25以上はBUY_NEWにせずWATCH止まりにする（soft gate）
const VOL_SOFT_LIMIT = 0.25

// P4-A10-1: BUY_NEW 候補の tier別購入上限（過大投入抑制）
export const SIZING_TIER_LIMIT: Record<CandidateSizingTier, number> = {
  none: 0,
  min:  10_000,
  half: 25_000,
  full: 50_000,
}

// P4-A10-1: resolveAction 後段で tier を決定する純関数。
// 入力は一次情報のみ（score/sigma/maxAmount）。signals は絶対に使わない。
export function resolveSizingTier(
  action: CandidateDecisionAction,
  score: number,
  sigma: number,
  maxAmount: number,
): CandidateSizingTier {
  if (action !== 'BUY_NEW') return 'none'
  if (maxAmount < 10_000) return 'none'
  if (score >= 85 && sigma < 0.18) return 'full'
  if (sigma >= 0.20) return 'min'
  return 'half'
}

// P4-A7b: score飽和を抑えるため、mu係数とsigmaペナルティを軽量再較正
// Score = base(50) + (1-costRate)*20 + mu*150 - max(0, sigma-0.16)*80  clamped [0, 100]
// P4-A1: Trust.cost は percent-number（0.1022 = 0.1022%）として定義されている。
// cost gate も percent-number で比較しているため、score式では /100 して rate 化する。
export function computeScore(cost: number, mu: number, sigma: number): number {
  const costRate = Math.max(0, cost) / 100
  const raw =
    50 +
    Math.max(0, 1 - costRate) * 20 +
    mu * 150 -
    Math.max(0, sigma - 0.16) * 80
  return Math.min(100, Math.max(0, raw))
}

export function resolveAction(
  blocked: CandidateBlockedReason[],
  score: number,
  sigma: number,
  marketCaution: boolean,
): CandidateDecisionAction {
  if (blocked.length > 0) return 'BLOCKED'
  // P4-A6b: soft VOL gate と同様に、市場警戒時もBUY_NEWをWATCHに降格する
  const shouldDowngradeToWatch = sigma >= VOL_SOFT_LIMIT || marketCaution
  if (score >= 75) return shouldDowngradeToWatch ? 'WATCH' : 'BUY_NEW'
  if (score >= 50) return 'WATCH'
  return 'BLOCKED'
}

// Trust.cost は percent-number（0.1022 = 0.1022%）。表示時も *100 しない。
function buildReason(
  action: CandidateDecisionAction,
  cost: number,
  mu: number,
  sigma: number,
  score: number,
  blocked: CandidateBlockedReason[],
  marketCaution: boolean,
): string {
  if (action === 'BLOCKED') {
    const labels = blocked.map(r => BLOCKED_LABEL[r] ?? r).join('・')
    return `候補除外: ${labels}`
  }
  const costPct = Math.max(0, cost).toFixed(3)
  const base = `スコア${score.toFixed(0)}: 報酬${costPct}%、μ${(mu * 100).toFixed(0)}%、σ${(sigma * 100).toFixed(0)}%。`
  if (action === 'BUY_NEW') return `${base}新規採用候補。`
  // P4-A6c: 市場警戒モードによるWATCH降格は理由を明示する
  if (marketCaution) return `${base}市場警戒モードのため新規買付は見送り。継続監視。`
  return `${base}条件通過だが確信度未達。継続監視。`
}

// P4-A8a: 既存gate結果と市場情報を可視化用signalに変換する純関数。
// action判定（resolveAction / computeScore）には一切渡さない。
function buildSignalState(
  constraints: CandidateConstraintState,
  ctx: ConstraintContext,
  trend: SignalVerdict,
  news: SignalVerdict,
): CandidateSignalState {
  return {
    marketRisk: ctx.noTrade || ctx.marketCaution ? 'caution' : 'confirm',
    gap:
      constraints.classHeadroom === 'pass'
        ? 'confirm'
        : constraints.classHeadroom === 'na'
          ? 'neutral'
          : 'caution',
    role:
      constraints.duplicateRole === 'pass'
        ? 'confirm'
        : constraints.duplicateRole === 'na'
          ? 'neutral'
          : 'caution',
    regime: resolveRegimeSignal(ctx.regimeState, ctx.regimeStateSource),
    trend,
    news,
  }
}

// P4-A8b: signal状態を日本語ラベルに変換する（reason文字列への追記用）
function signalLabel(value: CandidateSignalState[keyof CandidateSignalState]): string {
  switch (value) {
    case 'confirm':      return '良好'
    case 'neutral':      return '中立'
    case 'caution':      return '警戒'
    case 'unavailable':  return '未接続'
  }
}

function buildSignalSummary(signals: CandidateSignalState): string {
  return `signal: 市況${signalLabel(signals.marketRisk)}・余地${signalLabel(signals.gap)}・役割${signalLabel(signals.role)}・レジーム${signalLabel(signals.regime)}・trend${signalLabel(signals.trend)}・news${signalLabel(signals.news)}`
}

// P4-A9a: データ鮮度をreasonに追記する（observabilityのみ。gate/DATA_STALE化はしない）。
function formatAgeDays(ageDays: number | null): string {
  if (ageDays == null) return '不明'
  if (ageDays <= 0) return '当日'
  return `${ageDays}日前`
}

function buildFreshnessSummary(ctx: ConstraintContext): string {
  return `鮮度: 市場${formatAgeDays(ctx.marketDataAgeDays)}・投信${formatAgeDays(ctx.trustDataAgeDays)}`
}

const BLOCKED_LABEL: Record<CandidateBlockedReason, string> = {
  DQ_SUPPRESSED:       'データ品質抑制中',
  NO_TRADE_EMERGENCY:  '緊急ノートレード',
  CLASS_FULL:          'クラス上限到達',
  CLASS_TARGET_MISSING: 'クラス目標額未取得',
  INSUFFICIENT_CASH:   '現金不足',
  JP_STOCK_CAP:        '日本株上限',
  NOT_FOR_TRADING:     '売買不可',
  SAMPLE_CONTRACT:     'サンプル契約',
  NOT_ELIGIBLE:        '適格外（NISA積立は手動買付不可）',
  SCORE_TOO_LOW:       'スコア不足',
  DUPLICATE_ROLE:      '役割重複',
  VOL_TOO_HIGH:        'ボラティリティ過大',
  COST_TOO_HIGH:       '信託報酬過大',
  DATA_STALE:          'データ陳腐化',
  SAFE_MODE_ACTIVE:    'SAFE_MODE発動中',
}

export function scoreCandidates(
  rawCandidates: RawCandidate[],
  ctx: ConstraintContext,
): CandidateItem[] {
  return rawCandidates.map(({ trust, assetType }) => {
    const constraintResult = applyCandidateConstraints(trust, assetType, ctx)
    const blocked = [...constraintResult.blocked]
    const score = Math.round(computeScore(trust.cost, trust.mu, trust.sigma) * 10) / 10
    const action = resolveAction(blocked, score, trust.sigma, ctx.marketCaution)

    // P4-A5a: gateは通ったが score不足でBLOCKEDの場合に理由を明示する
    if (action === 'BLOCKED' && blocked.length === 0) {
      blocked.push('SCORE_TOO_LOW')
    }

    const maxAmount = constraintResult.maxAmount
    const sizingTier = resolveSizingTier(action, score, trust.sigma, maxAmount)
    const suggestedAmount = Math.min(SIZING_TIER_LIMIT[sizingTier], maxAmount)

    const role = inferTrustRole(trust)
    const trend = resolveTrendProxy(assetType, role, {
      marketNikkeiChgPct: ctx.marketNikkeiChgPct,
      macroSp500ChgPct: ctx.macroSp500ChgPct,
      macroNasdaqChgPct: ctx.macroNasdaqChgPct,
      macroGoldChgPct: ctx.macroGoldChgPct,
    })
    const news = resolveNewsSignal(role, ctx.candidatesNews, ctx.candidatesNewsSource)
    const signals = buildSignalState(constraintResult.constraints, ctx, trend, news)
    const reason = `${buildReason(action, trust.cost, trust.mu, trust.sigma, score, blocked, ctx.marketCaution)} ${buildSignalSummary(signals)} ${buildFreshnessSummary(ctx)}`

    return {
      id: trust.id,
      name: trust.name,
      assetType: assetType as CandidateAssetType,
      action,
      score,
      sizingTier,
      suggestedAmount,
      maxAmount,
      blockedReasons: blocked,
      constraints: constraintResult.constraints,
      signals,
      reason,
      source: 'trust_master',
    }
  })
}
