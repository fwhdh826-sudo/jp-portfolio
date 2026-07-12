import type { CandidateBlockedReason, OfficialDecisionAction } from '../../types'

export type CandidateAssetType = 'jp_trust' | 'global_trust' | 'gold'

export type CandidateDecisionAction = Extract<
  OfficialDecisionAction,
  'BUY_NEW' | 'WATCH' | 'BLOCKED' | 'DATA_WAIT'
>

export interface CandidateConstraintState {
  dqGate: 'pass' | 'fail'
  noTradeGate: 'pass' | 'fail'
  classHeadroom: 'pass' | 'fail' | 'na'
  duplicateRole: 'pass' | 'fail' | 'na'
  volatility: 'pass' | 'fail'
  cashBudget: 'pass' | 'fail'
  eligibility: 'pass' | 'fail'
  cost: 'pass' | 'fail' | 'na'
  notForTrading: 'pass' | 'fail'
  safeMode: 'pass' | 'fail'
}

// P4-A8a: signal observability — gatingには使わず可視化のみ
export type SignalVerdict = 'confirm' | 'neutral' | 'caution' | 'unavailable'

export interface CandidateSignalState {
  // checkNoTrade / marketCaution 由来。gatingには使わず可視化のみ。
  marketRisk: SignalVerdict
  // class headroom 由来。既存gateの結果を可視化するだけ。
  gap: SignalVerdict
  // duplicate role 由来。既存gateの結果を可視化するだけ。
  role: SignalVerdict
  // market.regime 由来。bull/neutral/bear を可視化するだけ。
  regime: SignalVerdict
  // P4-A9b: asset class proxy trend（observabilityのみ、gatingには使わない）
  trend: SignalVerdict
  // P4-A9c: candidates_news summary-only接続。score/action非接続。
  news: SignalVerdict
}

// P4-A10-1: BUY_NEW 候補の購入量を確信度・ボラで段階化。過大投入抑制が目的。
export type CandidateSizingTier = 'none' | 'min' | 'half' | 'full'

export interface CandidateItem {
  id: string
  name: string
  assetType: CandidateAssetType
  action: CandidateDecisionAction
  score: number
  sizingTier: CandidateSizingTier
  suggestedAmount: number
  maxAmount: number
  blockedReasons: CandidateBlockedReason[]
  constraints: CandidateConstraintState
  signals: CandidateSignalState
  reason: string
  source: 'trust_master'
}
