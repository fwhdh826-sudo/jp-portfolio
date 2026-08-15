// ═══════════════════════════════════════════════════════════
// CAND-SYN-1C / design-audit D2 + D14: the single officialDecision candidate
// writer. It replaces both retired appends —
//   appendCandidatePortfolioRecommendations (funnel) and the L1 legacy
//   candidateToOfficialDecisionItem append (trust) —
// so `officialDecision.actions` has exactly one candidate writer.
//
// This is a compatibility projection, not a second decision engine. It ranks
// nothing, calculates nothing, and carries no yen: `amount`,
// `suggestedAmount`, `maxAmount` and `candidateSizingTier` are deliberately
// never set. Executable money stays canonical in
// AllocationPlanSnapshot.instrumentPlans[].finalSuggestedAmount, projected to
// the user through CandidateDecisionSynthesis only.
//
// Holding decisions (BUY/SELL/HOLD/WAIT/MONITOR/BLOCKED/DATA_WAIT from the
// committee) remain the existing officialDecision authority and are untouched.
// ═══════════════════════════════════════════════════════════
import type {
  OfficialDecision,
  OfficialDecisionAction,
  OfficialDecisionItem,
} from '../types'
import type {
  CandidateDecisionSynthesisEntry,
  CandidateDecisionSynthesisSnapshot,
  SynthesisAction,
} from '../types/candidateDecisionSynthesis'

/**
 * Frozen action mapping. `ADD_EXISTING` is the existing schema slot for
 * "保有中商品の追加買い"; synthesis never emits SELL/HOLD/NO_ACTION (D4/§23),
 * so no sell-side candidate behaviour is invented here.
 */
const OFFICIAL_DECISION_ACTION: Record<SynthesisAction, OfficialDecisionAction> = {
  ADD: 'ADD_EXISTING',
  BUY_NEW: 'BUY_NEW',
  WATCH: 'WATCH',
  BLOCKED: 'BLOCKED',
}

/**
 * Compatibility prose for the schema's required `reason` field, keyed by action
 * only. It states the authority boundary and never a number — WATCH/BLOCKED in
 * particular must expose no yen figure at all (D8).
 */
const OFFICIAL_DECISION_REASON: Record<SynthesisAction, string> = {
  ADD: '保有中の銘柄で、AllocationPlanが追加買付の実行枠を評価しました。実行可能額はAllocationPlanが唯一の権限です。',
  BUY_NEW: '未保有の重点候補で、適合判定と資産クラス余力を確認しました。実行可能額はAllocationPlanが唯一の権限です。',
  WATCH: '実行条件を満たさないため監視します。売買執行・金額算定は未実施です。',
  BLOCKED: '遮断条件に該当するため実行しません。売買執行・金額算定は未実施です。',
}

function toOfficialDecisionItem(entry: CandidateDecisionSynthesisEntry): OfficialDecisionItem {
  const item: OfficialDecisionItem = {
    id: `candidate-synthesis-${entry.entryId}`,
    assetType: entry.assetClass === 'JP_STOCK' ? 'stock' : 'jp_trust',
    name: entry.displayName,
    action: OFFICIAL_DECISION_ACTION[entry.action],
    reason: OFFICIAL_DECISION_REASON[entry.action],
    source: 'candidate',
    isCandidate: true,
    candidateSource: entry.assetClass === 'JP_STOCK' ? 'candidate_funnel' : 'trust_master',
  }
  return {
    ...item,
    ...(entry.code === null ? {} : { code: entry.code }),
    ...(entry.blockingReasons.length === 0 ? {} : { blockedReason: entry.blockingReasons[0] }),
  }
}

/**
 * Appends the candidate component of one already-authorized synthesis
 * generation. An absent, unavailable or invalid synthesis appends nothing:
 * fail-closed is the same answer the retired appends gave for an unusable
 * candidate generation.
 */
export function projectSynthesisToOfficialDecision(
  baseDecision: OfficialDecision | null,
  synthesis: CandidateDecisionSynthesisSnapshot | null,
): OfficialDecision | null {
  if (baseDecision === null) return null
  if (synthesis === null || synthesis.status !== 'available') return baseDecision

  const entries = [...synthesis.decisions, ...synthesis.watchList]
  if (entries.length === 0) return baseDecision

  const seen = new Set<string>()
  const items: OfficialDecisionItem[] = []
  for (const entry of entries) {
    if (seen.has(entry.entryId)) return baseDecision // fail closed on duplicate identity
    seen.add(entry.entryId)
    items.push(toOfficialDecisionItem(entry))
  }

  return { ...baseDecision, actions: [...baseDecision.actions, ...items] }
}
