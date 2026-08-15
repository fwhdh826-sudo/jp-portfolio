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
 * Identity predicate for the candidate compatibility component. Both markers
 * are set together by toOfficialDecisionItem above and by no other writer
 * (see synthesisOfficialDecisionProjection.test.ts N1/N3), so this is the
 * narrowest correct identity for "belongs to a CandidateDecisionSynthesis
 * generation" — never the action enum alone (BUY_NEW/BLOCKED are also valid
 * holding-committee actions).
 */
function isCandidateComponentAction(action: OfficialDecisionItem): boolean {
  return action.isCandidate === true && action.source === 'candidate'
}

/**
 * Removes the candidate compatibility component from an OfficialDecision,
 * regardless of which synthesis generation produced it. Pure, no money
 * calculation, no re-ranking; preserves every non-candidate action exactly
 * and in order. Idempotent: stripping twice equals stripping once.
 */
export function stripCandidateComponentFromOfficialDecision(
  decision: OfficialDecision | null,
): OfficialDecision | null {
  if (decision === null) return null
  const actions = decision.actions.filter(action => !isCandidateComponentAction(action))
  if (actions.length === decision.actions.length) return decision
  return { ...decision, actions }
}

/**
 * Replaces the candidate component of one already-authorized synthesis
 * generation: any previous candidate component (from an older generation) is
 * removed first, then exactly the current generation's projection is
 * appended once. An absent, unavailable or invalid synthesis leaves the
 * candidate component absent — fail-closed is the same answer the retired
 * appends gave for an unusable candidate generation, and generation
 * atomicity forbids retaining a stale generation's candidates.
 */
export function projectSynthesisToOfficialDecision(
  baseDecision: OfficialDecision | null,
  synthesis: CandidateDecisionSynthesisSnapshot | null,
): OfficialDecision | null {
  if (baseDecision === null) return null
  const stripped = stripCandidateComponentFromOfficialDecision(baseDecision)!
  if (synthesis === null || synthesis.status !== 'available') return stripped

  const entries = [...synthesis.decisions, ...synthesis.watchList]
  if (entries.length === 0) return stripped

  const seen = new Set<string>()
  const items: OfficialDecisionItem[] = []
  for (const entry of entries) {
    if (seen.has(entry.entryId)) return stripped // fail closed on duplicate identity
    seen.add(entry.entryId)
    items.push(toOfficialDecisionItem(entry))
  }

  return { ...stripped, actions: [...stripped.actions, ...items] }
}
