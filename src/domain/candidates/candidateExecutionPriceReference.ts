// ═══════════════════════════════════════════════════════════
// CAND-SYN-1B / DDR-1: candidates_stocks.json execution-reference-price
// capture. Pure, bounded, evidence-only — it never feeds AllocationPlan
// monetary sizing (that activation is 1C/1E scope). Join direction is
// fixed: it starts from an authorized funnel candidate's code and looks
// that code up inside candidates_stocks; candidates_stocks itself is
// never a source of new candidate identity (DDR-1 §3.4/§3.10).
// ═══════════════════════════════════════════════════════════
import type { CandidatesStocksData, StockCandidateItem } from '../../types/candidatesStocks'
import { normalizePortfolioFitCode } from './portfolioFit'
import { isCandidatesStocksUsable } from './stockCandidates'
import {
  JP_DOMESTIC_LOT_SIZE_SHARES,
  normalizeCandidateExecutionReferencePrice,
} from './candidateDecisionSynthesis'

export const CANDIDATE_EXECUTION_PRICE_REFERENCE_STATUSES = [
  'AVAILABLE',
  'UNAVAILABLE',
  'STALE',
  'AMBIGUOUS',
  'INVALID',
] as const
export type CandidateExecutionPriceReferenceStatus =
  (typeof CANDIDATE_EXECUTION_PRICE_REFERENCE_STATUSES)[number]

export interface CandidateExecutionPriceReference {
  readonly instrumentId: string
  readonly code: string
  readonly status: CandidateExecutionPriceReferenceStatus
  readonly rawPrice: number | null
  readonly priceJpy: number | null
  readonly lotSizeShares: typeof JP_DOMESTIC_LOT_SIZE_SHARES | null
  readonly reason: 'EXECUTION_PRICE_UNAVAILABLE' | 'EXECUTION_PRICE_AMBIGUOUS' | null
}

export interface CandidateExecutionPriceDatasetProvenance {
  readonly usable: boolean
  readonly updatedAt: string | null
  readonly sourceUpdatedAt: string | null
  readonly runToken: string | null
}

export interface CandidateExecutionPriceReferenceCaptureResult {
  readonly datasetProvenance: CandidateExecutionPriceDatasetProvenance
  readonly references: readonly CandidateExecutionPriceReference[]
}

function unavailable(
  instrumentId: string,
  code: string,
  rawPrice: number | null = null,
): CandidateExecutionPriceReference {
  return {
    instrumentId,
    code,
    status: 'UNAVAILABLE',
    rawPrice,
    priceJpy: null,
    lotSizeShares: null,
    reason: 'EXECUTION_PRICE_UNAVAILABLE',
  }
}

function stale(instrumentId: string, code: string): CandidateExecutionPriceReference {
  return {
    instrumentId,
    code,
    status: 'STALE',
    rawPrice: null,
    priceJpy: null,
    lotSizeShares: null,
    reason: 'EXECUTION_PRICE_UNAVAILABLE',
  }
}

function invalid(instrumentId: string, code: string): CandidateExecutionPriceReference {
  return {
    instrumentId,
    code,
    status: 'INVALID',
    rawPrice: null,
    priceJpy: null,
    lotSizeShares: null,
    reason: null,
  }
}

function ambiguous(instrumentId: string, code: string): CandidateExecutionPriceReference {
  return {
    instrumentId,
    code,
    status: 'AMBIGUOUS',
    rawPrice: null,
    priceJpy: null,
    lotSizeShares: null,
    reason: 'EXECUTION_PRICE_AMBIGUOUS',
  }
}

/** Dataset-level structural validity, independent of the staleThresholdHours age gate. */
function isDatasetStructurallyValid(
  data: CandidatesStocksData,
  source: 'loaded' | 'default',
): boolean {
  if (source !== 'loaded') return false
  if (data.status === 'empty') return false
  return Number.isFinite(new Date(data.updatedAt).getTime())
}

export function captureCandidateExecutionPriceDatasetProvenance(
  candidatesStocks: CandidatesStocksData,
  candidatesStocksSource: 'loaded' | 'default',
  now: number,
): CandidateExecutionPriceDatasetProvenance {
  const usable = isCandidatesStocksUsable(candidatesStocks, candidatesStocksSource, now)
  if (!usable) return { usable: false, updatedAt: null, sourceUpdatedAt: null, runToken: null }
  return {
    usable: true,
    updatedAt: candidatesStocks.updatedAt,
    sourceUpdatedAt: candidatesStocks.sourceUpdatedAt,
    runToken: candidatesStocks._meta.runToken ?? null,
  }
}

/**
 * Bounded pure capture. Starts from the authorized funnel candidate's code
 * (never from candidates_stocks itself — DDR-1 §3.10 join direction) and
 * exact-normalizes into candidates_stocks. Zero/duplicate matches fail
 * closed per candidate; the dataset-level gate reuses the single existing
 * isCandidatesStocksUsable authority rather than re-deriving staleness.
 */
export function captureCandidateExecutionPriceReferences(input: {
  readonly candidatesStocks: CandidatesStocksData
  readonly candidatesStocksSource: 'loaded' | 'default'
  readonly now: number
  readonly candidates: readonly { instrumentId: string; code: string }[]
}): CandidateExecutionPriceReferenceCaptureResult {
  const { candidatesStocks, candidatesStocksSource, now, candidates } = input
  const datasetProvenance = captureCandidateExecutionPriceDatasetProvenance(
    candidatesStocks,
    candidatesStocksSource,
    now,
  )
  const usable = isCandidatesStocksUsable(candidatesStocks, candidatesStocksSource, now)
  const structurallyValid = isDatasetStructurallyValid(candidatesStocks, candidatesStocksSource)

  const byCode = new Map<string, StockCandidateItem[]>()
  if (usable) {
    for (const item of candidatesStocks.candidates) {
      const normalized = normalizePortfolioFitCode(item.code)
      if (normalized.status !== 'valid' || normalized.normalizedCode === null) continue
      const bucket = byCode.get(normalized.normalizedCode)
      if (bucket) bucket.push(item)
      else byCode.set(normalized.normalizedCode, [item])
    }
  }

  const references = candidates.map(({ instrumentId, code }) => {
    const normalized = normalizePortfolioFitCode(code)
    if (normalized.status !== 'valid' || normalized.normalizedCode === null) {
      return invalid(instrumentId, code)
    }
    if (!usable) {
      return structurallyValid ? stale(instrumentId, code) : unavailable(instrumentId, code)
    }
    const matches = byCode.get(normalized.normalizedCode) ?? []
    if (matches.length === 0) return unavailable(instrumentId, code)
    if (matches.length > 1) return ambiguous(instrumentId, code)
    const match = matches[0]
    if (match.dataStatus !== 'ok') return unavailable(instrumentId, code, match.price)
    const priceJpy = normalizeCandidateExecutionReferencePrice(match.price)
    if (priceJpy === null) return unavailable(instrumentId, code, match.price)
    return {
      instrumentId,
      code,
      status: 'AVAILABLE' as const,
      rawPrice: match.price,
      priceJpy,
      lotSizeShares: JP_DOMESTIC_LOT_SIZE_SHARES,
      reason: null,
    }
  })

  return { datasetProvenance, references }
}
