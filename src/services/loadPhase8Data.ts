// ═══════════════════════════════════════════════════════════
// Phase 8 missing-safe data loader — v13.3 / C: loader-only skeleton
// 参照: handover.md "P2-D4 / P2-D5 Joint Readiness Review / 設計記録"
//        "C: missing-safe UI skeleton Readiness Review"
//
// 目的:
//   public/data/phase8/*.json が存在しなくても UI が壊れない typed
//   missing-safe loader 境界を確立する。本ファイルは loader のみ。
//   store / component / refreshAllData へは未配線（描画は後続
//   「P2-D4 UI 本配線」別 Card）。本 loader が呼ばれたときだけ
//   runtime fetch が発生する。
//
// 設計:
//   - src/services/loadStaticData.ts は変更しない。helper（buildJsonUrl /
//     fetchJson）は本ファイルで自己完結に複製する（既存 critical loader の
//     回帰面を隔離する目的）。
//   - 不在 / 404 / non-ok / JSON parse 失敗は fetchJson が throw し、
//     public API 側で catch して { data: null, source: 'none' } を返す。
//     合成 document は作らない（捏造しない＝不在は不在として表現）。
//   - console.error / console.warn は出さない（loadStaticData 前例に一致）。
//   - 型は src/types/phase8.ts を import type で使用（presentation 契約）。
//
// 注: public/data/phase8 namespace は未作成（P2-D2-actual で実 write は
//     現時点 No-Go）。本 loader は不在時に必ず source:'none' を返す。
// ═══════════════════════════════════════════════════════════

import type {
  Phase8Document,
  FrontierIndexPresentation,
  OpportunityLossPresentation,
  FutureBranchingPresentation,
  StrategyAggregated,
} from '../types/phase8'

const BASE =
  (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'

export type Phase8LoadSource = 'loaded' | 'none'

export interface Phase8LoadResult<T> {
  data: Phase8Document<T> | null
  source: Phase8LoadSource
}

// ── helper（自己完結・loadStaticData.ts は変更しない）───────────────────────

function buildJsonUrl(path: string): string {
  const normalizedBase = BASE.endsWith('/') ? BASE : `${BASE}/`
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path
  return `${normalizedBase}${normalizedPath}`
}

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(buildJsonUrl(path), {
    cache: 'no-store',
    headers: {
      pragma: 'no-cache',
      'cache-control': 'no-cache',
    },
  })
  if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`)
  return r.json() as Promise<T>
}

async function loadPhase8Document<T>(
  path: string,
): Promise<Phase8LoadResult<T>> {
  try {
    const data = await fetchJson<Phase8Document<T>>(path)
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

// ── public API（4 出力、未配線・呼ばれたときだけ fetch）─────────────────────

export function loadPhase8FrontierIndex(): Promise<
  Phase8LoadResult<FrontierIndexPresentation>
> {
  return loadPhase8Document<FrontierIndexPresentation>(
    'data/phase8/frontier_index.json',
  )
}

export function loadPhase8StrategyAggregate(): Promise<
  Phase8LoadResult<StrategyAggregated>
> {
  return loadPhase8Document<StrategyAggregated>(
    'data/phase8/strategy_aggregate.json',
  )
}

export function loadPhase8OpportunityLoss(): Promise<
  Phase8LoadResult<OpportunityLossPresentation>
> {
  return loadPhase8Document<OpportunityLossPresentation>(
    'data/phase8/opportunity_loss.json',
  )
}

export function loadPhase8FutureBranching(): Promise<
  Phase8LoadResult<FutureBranchingPresentation>
> {
  return loadPhase8Document<FutureBranchingPresentation>(
    'data/phase8/future_branching.json',
  )
}
