// ═══════════════════════════════════════════════════════════
// CAND-SYN-1B / DDR-1: candidates_stocks.json execution-reference-price
// capture. Join direction is fixed: it starts from an authorized funnel
// candidate's code and looks that code up inside candidates_stocks;
// candidates_stocks itself is never a source of new candidate identity
// (DDR-1 §3.4/§3.10).
//
// CAND-SYN-1C activates the captured reference as AllocationPlan execution
// metadata (priceJpy + lotSizeShares). It stays execution authority only:
// candidate eligibility, tier, marketRank, P-14 and portfolioFit are all
// untouched (DDR-1 §3.3). The single permitted effect of a missing, stale,
// ambiguous or invalid price is that executable sizing does not hold.
// ═══════════════════════════════════════════════════════════
import type { InstrumentInput } from '../../types/allocationPlan'
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

/**
 * CAND-SYN-1C / DDR-1 §3.9: activates AVAILABLE execution references on the
 * matching canonical AllocationInstrumentInput for new JP_STOCK. Every other
 * status leaves priceJpy/lotSizeShares null so the engine's existing
 * JP_STOCK_EXECUTION_DATA_UNAVAILABLE gate fail-closes the amount to 0 — there
 * is no fallback to legacy maxAmount, a holding price, or a synthetic unit.
 * A duplicated reference identity is treated as no authority at all.
 */
export function applyCandidateExecutionPriceReferences(
  instruments: readonly InstrumentInput[],
  references: readonly CandidateExecutionPriceReference[],
): InstrumentInput[] {
  const available = new Map<string, CandidateExecutionPriceReference | null>()
  for (const reference of references) {
    if (available.has(reference.instrumentId)) {
      available.set(reference.instrumentId, null)
      continue
    }
    available.set(
      reference.instrumentId,
      reference.status === 'AVAILABLE' && reference.priceJpy !== null && reference.lotSizeShares !== null
        ? reference
        : null,
    )
  }
  return instruments.map((instrument) => {
    if (instrument.kind !== 'jp_stock' || instrument.assetClass !== 'JP_STOCK') return instrument
    const reference = available.get(instrument.instrumentId) ?? null
    if (reference === null) return instrument
    return {
      ...instrument,
      priceJpy: reference.priceJpy,
      lotSizeShares: reference.lotSizeShares,
    }
  })
}

/**
 * CAND-SYN-1C / DDR-1 §7.2: execution metadata for an already-held JP_STOCK.
 * The only accepted price authority is the canonical holding projection's
 * `currentPrice` (whose freshness is already bound to the holdings generation
 * identity); there is deliberately no v1 fallback, so an absent or non-finite
 * price leaves the position non-executable rather than guessed. Routing held
 * stocks through candidates_stocks is forbidden — it would make execution
 * depend on whether a held code happens to appear in a public artifact.
 */
export function resolveHoldingExecutionMetadata(currentPrice: unknown): {
  readonly priceJpy: number | null
  readonly lotSizeShares: typeof JP_DOMESTIC_LOT_SIZE_SHARES | null
} {
  const priceJpy = normalizeCandidateExecutionReferencePrice(currentPrice)
  return {
    priceJpy,
    lotSizeShares: priceJpy === null ? null : JP_DOMESTIC_LOT_SIZE_SHARES,
  }
}
