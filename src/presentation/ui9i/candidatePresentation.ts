// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: 候補（CandidateDecisionSynthesis）の presentation adapter。
//
// 権限: CandidateDecisionSynthesis のみ。
//   提示順 = decisions → watchList。各配列内の canonical 順を保持する。
//   T0 プレビュー = 提示順の先頭 3 件。再ランク・並べ替え・フィルタはしない
//   （marketScore / rank / amount / tier でのソートは禁止）。
//
// 金額は entry.money が EXECUTABLE のときだけ露出し、React 側で計算しない。
// ═══════════════════════════════════════════════════════════
import type {
  CandidateDecisionSynthesisEntry,
  CandidateDecisionSynthesisSnapshot,
} from '../../types/candidateDecisionSynthesis'
import { DATA_WAIT_ROW_LABEL, HOME_TIER_LABEL, RELATIONSHIP_LABEL } from './labels'

export const HOME_CANDIDATE_PREVIEW_LIMIT = 3

export type CandidateRowKind = 'executable' | 'review' | 'data_wait' | 'none'

export interface CandidatePreviewRow {
  readonly entryId: string
  readonly code: string | null
  readonly displayName: string
  readonly relationship: CandidateDecisionSynthesisEntry['relationship']
  readonly relationshipLabel: string
  readonly kind: CandidateRowKind
  /** Home の状態語（実行可能 / 要レビュー / 更新待ち）。tier 不明かつ非 review は null。 */
  readonly stateLabel: string | null
  readonly marketScore: number | null
  /** money.kind === 'EXECUTABLE' かつ実行抑止中でないときだけ non-null。 */
  readonly executableAmountJpy: number | null
}

export interface CandidateSectionProjection {
  /** unavailable: synthesis が無い / unavailable / invalid。「候補なし」とは別状態。 */
  readonly status: 'available' | 'unavailable'
  readonly rows: readonly CandidatePreviewRow[]
  readonly totalCount: number
  readonly executableCount: number
  readonly reviewCount: number
}

export interface CandidateProjectionContext {
  /** SAFE_MODE(effective) など、いま実行が抑止されている。実行可能語・金額を出さない。 */
  readonly executionSuppressed: boolean
  /** DATA_WAIT（全体データ品質による抑止）。行の状態語を「更新待ち」にする。 */
  readonly dataWait: boolean
}

export function candidatePresentationSequence(
  synthesis: CandidateDecisionSynthesisSnapshot | null,
): readonly CandidateDecisionSynthesisEntry[] {
  if (synthesis === null || synthesis.status !== 'available') return []
  return [...synthesis.decisions, ...synthesis.watchList]
}

function projectRow(
  entry: CandidateDecisionSynthesisEntry,
  ctx: CandidateProjectionContext,
): CandidatePreviewRow {
  const tier = entry.candidateQuality.tier
  const proposesExecution = entry.action === 'ADD' || entry.action === 'BUY_NEW'
  let kind: CandidateRowKind
  let stateLabel: string | null
  if (ctx.dataWait) {
    kind = 'data_wait'
    stateLabel = DATA_WAIT_ROW_LABEL
  } else if (!ctx.executionSuppressed && proposesExecution && tier === 'actionable') {
    kind = 'executable'
    stateLabel = HOME_TIER_LABEL.actionable
  } else if (tier === 'deep_review' || !proposesExecution || ctx.executionSuppressed) {
    kind = 'review'
    stateLabel = HOME_TIER_LABEL.deep_review
  } else {
    kind = 'none'
    stateLabel = null
  }
  const showMoney = !ctx.executionSuppressed && !ctx.dataWait && entry.money.kind === 'EXECUTABLE'
  return {
    entryId: entry.entryId,
    code: entry.code,
    displayName: entry.displayName,
    relationship: entry.relationship,
    relationshipLabel: RELATIONSHIP_LABEL[entry.relationship],
    kind,
    stateLabel,
    marketScore: entry.candidateQuality.marketScore,
    executableAmountJpy: showMoney && entry.money.kind === 'EXECUTABLE' ? entry.money.executableAmountJpy : null,
  }
}

export function projectCandidateSection(
  synthesis: CandidateDecisionSynthesisSnapshot | null,
  ctx: CandidateProjectionContext,
): CandidateSectionProjection {
  if (synthesis === null || synthesis.status !== 'available') {
    return { status: 'unavailable', rows: [], totalCount: 0, executableCount: 0, reviewCount: 0 }
  }
  const all = candidatePresentationSequence(synthesis).map(entry => projectRow(entry, ctx))
  return {
    status: 'available',
    rows: all.slice(0, HOME_CANDIDATE_PREVIEW_LIMIT),
    totalCount: all.length,
    executableCount: all.filter(r => r.kind === 'executable').length,
    reviewCount: all.filter(r => r.kind === 'review').length,
  }
}
