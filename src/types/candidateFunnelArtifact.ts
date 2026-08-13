// ═══════════════════════════════════════════════════════════
// P5-B005-B3-A: candidate_funnel.json production artifact wrapper契約。
//
// src/types/candidateFunnel.ts（B1 frozen scoring engine契約）を authority
// として再利用し、その型を書き換えない。ここではB2 batch publish（frozen:
// data/candidate_funnel_batch.py）が実際に生成する production artifact —
// engine出力（CandidateFunnelData）に `_meta`（provenance / quality gate）
// を付与したwrapper — の型のみを追加する。
//
// この ticket の非 scope: portfolio / holdings / cash / account / headroom
// / amount / action / officialDecision / BUY_NEW / WATCH / BLOCKED /
// portfolioFit は一切含めない（禁止field）。
// ═══════════════════════════════════════════════════════════

import type { CandidateFunnelData, CandidateFunnelPipelinePath, CandidateFunnelRegime } from './candidateFunnel'

// ── quality gate entry value は metricごとに形が異なる（number / object /
//    null）ため、any へ逃げず安全なJSON value型で表現する ────────────
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// ── quality gate ID（P-01〜P-15。frozen A2-S §22.2/§25.20 exact 15件） ──
export const CANDIDATE_FUNNEL_QUALITY_GATE_REQUIRED_IDS = [
  'P-01',
  'P-02',
  'P-03',
  'P-04',
  'P-05',
  'P-06',
  'P-07',
  'P-08',
  'P-09',
  'P-10',
  'P-11',
  'P-12',
  'P-13',
  'P-14',
  'P-15',
] as const
export type CandidateFunnelQualityGateRequiredId = (typeof CANDIDATE_FUNNEL_QUALITY_GATE_REQUIRED_IDS)[number]

// ── gate自体のstatus（production batchが出力し得る全status）。WARNの許可
//    gateはruntime parserでbackend authorityに合わせて限定する。 ─────────
export const CANDIDATE_FUNNEL_QUALITY_GATE_STATUSES = ['PASS', 'FAIL', 'RECORD', 'WARN', 'N/A'] as const
export type CandidateFunnelQualityGateStatus = (typeof CANDIDATE_FUNNEL_QUALITY_GATE_STATUSES)[number]

export interface CandidateFunnelQualityGateEntry {
  id: string
  metric: string
  value: JsonValue
  threshold: string
  status: CandidateFunnelQualityGateStatus
  note: string
}

export interface CandidateFunnelQualityGate {
  gates: CandidateFunnelQualityGateEntry[]
  overallPass: boolean
  hardFailIds: string[]
  notes: string[]
}

export interface CandidateFunnelJoinStats {
  candidateCount: number
  prescreenCount: number
  joinedCount: number
  unmatchedCandidateCount: number
  unmatchedPrescreenCount: number
  joinRate: number
  unmatchedCandidateRate: number
}

// ── production artifactに固有の `_meta`（provenance / quality gate）。
//    B1 pure engine contractには存在しない — B2 batch publish wrapperのみ
//    が付与する。 ────────────────────────────────────────
export interface CandidateFunnelArtifactMeta {
  kind: 'candidate_funnel'
  not_for_trading: true
  generatedAt: string
  asOf: string
  sourceUpdatedAt: string | null
  pipelinePath: CandidateFunnelPipelinePath
  regimeRequested: CandidateFunnelRegime | null
  join: CandidateFunnelJoinStats
  qualityGate: CandidateFunnelQualityGate
}

// ── production artifact全体 = B1 engine contract（CandidateFunnelData）
//    + `_meta`。B1側のfieldをここで再定義しない。 ──────────────
export interface CandidateFunnelArtifact extends CandidateFunnelData {
  _meta: CandidateFunnelArtifactMeta
}
