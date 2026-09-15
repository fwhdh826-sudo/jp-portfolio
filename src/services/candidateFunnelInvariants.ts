// ═══════════════════════════════════════════════════════════
// OPS_P5_B005_FCA_1_P1_REPAIR_R1: candidate_funnel artifact の producer
// 由来 invariant を 1 箇所で定義する。runtime parser
// （candidateFunnelParser）と typed downstream entry point
// （candidatePortfolioRecommendation の allocation adapter / composer）が
// 同じ predicate を共有し、parser を迂回した typed input でも同じ
// fail-closed 判定になるようにする（defense in depth）。
//
// ここで新しい policy を発明しない — 各 invariant は production backend
// authority の実装から直接導出する。
// ═══════════════════════════════════════════════════════════

import type { CandidateFunnelQualityGate } from '../types/candidateFunnelArtifact'

// ── FCA-1-P1-01: quality gate aggregate / gate-level status parity。
//    producer authority（data/candidate_funnel_batch.py compute_quality_report）:
//      _gate(): status == "FAIL" のとき hard_fail_ids.append(gate_id)
//      overall_pass = not hard_fail_ids
//    したがって publish された artifact では常に
//      hardFailIds === gates.filter(status === 'FAIL').map(id)（順序込み）
//      overallPass === (hardFailIds.length === 0)
//    が成立する。どちらかが破れた artifact は producer 出力ではなく、
//    aggregate が green でも信用できない（fail-closed）。 ─────────────
export function qualityGateAggregatesAgreeWithGates(
  gate: Pick<CandidateFunnelQualityGate, 'gates' | 'overallPass' | 'hardFailIds'>,
): boolean {
  const failedIds: string[] = []
  for (const entry of gate.gates) {
    if (entry.status === 'FAIL') failedIds.push(entry.id)
  }
  if (gate.hardFailIds.length !== failedIds.length) return false
  for (let i = 0; i < failedIds.length; i += 1) {
    if (gate.hardFailIds[i] !== failedIds[i]) return false
  }
  return gate.overallPass === (failedIds.length === 0)
}

// ── FCA-1-P1-02: canonical 1-based rank。
//    producer authority:
//      marketRank: data/candidate_funnel_engine.py build_candidate_funnel
//        market_rank[k] = rank_pos + 1（非 excluded）/ None（excluded）
//      prescreenRank: 同 engine が raw_rank > 0 の int のみ採用、それ以外 None
//    したがって non-null rank は常に正の整数。0 / 負 / 小数 / 非有限は
//    producer が emit し得ない malformed 値であり、null（= rank 無し）へ
//    正規化してはならない。 ────────────────────────────────
export function isCanonicalRank(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isCanonicalRankOrNull(value: unknown): value is number | null {
  return value === null || isCanonicalRank(value)
}
