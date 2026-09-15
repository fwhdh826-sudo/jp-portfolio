// ═══════════════════════════════════════════════════════════
// OPS_P5_B005_FCA_1_P1_REPAIR_R1 (FCA-1-P1-03): candidate_funnel artifact
// timestamp の single strict authority。
//
// producer authority（data/candidate_funnel_batch.py build_artifact_payload
// / build_batch_context）は timezone-aware datetime の `isoformat()` を emit
// する: `YYYY-MM-DDTHH:MM:SS[.ffffff]+HH:MM`（microsecond は 0 のとき省略）。
// date-only 値・timezone 無し値・locale 依存形式は producer が emit しない
// ため受理しない。
//
// parser（構文/暦の妥当性）・freshness（nowMs との時間関係）・presentation・
// portfolio-fit・allocation adapter は全てこの 1 関数を経由し、
// Date.parse() の rollover 正規化（例: 2026-09-31 → 10-01）に依存しない。
// ═══════════════════════════════════════════════════════════

import { parseStrictTimestamp } from './strictTimestamp'
import type { StrictTimestamp } from './strictTimestamp'

const CANDIDATE_FUNNEL_TIMESTAMP_OPTIONS = {
  allowDateOnly: false,
  allowMicrosecondFraction: true,
} as const

/**
 * Strict, calendar-validated, offset-qualified parse of a candidate_funnel
 * producer timestamp. Returns null for anything the producer cannot emit
 * (impossible dates, timezone-less values, non-strings, empty strings).
 */
export function parseCandidateFunnelTimestamp(value: unknown): StrictTimestamp | null {
  return parseStrictTimestamp(value, CANDIDATE_FUNNEL_TIMESTAMP_OPTIONS)
}

export function isCandidateFunnelTimestamp(value: unknown): value is string {
  return parseCandidateFunnelTimestamp(value) !== null
}
