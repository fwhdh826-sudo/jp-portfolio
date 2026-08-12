import { INITIAL_TRUST } from '../../constants/trust'
import type { Trust } from '../../types'
import type { CandidateInput } from '../../types/allocationPlan'

const CANONICAL_TRUST_IDS = new Set(INITIAL_TRUST.map(trust => trust.id))
const CANONICAL_TRUST_POLICIES = new Map(
  INITIAL_TRUST.map(trust => [trust.id, trust.policy] as const),
)

export interface TrustAllocationCandidateAdapterResult {
  readonly status: 'available' | 'invalid'
  readonly candidates: readonly CandidateInput[]
}

const INVALID_RESULT: TrustAllocationCandidateAdapterResult = Object.freeze({
  status: 'invalid',
  candidates: Object.freeze([]),
})

/** Canonical JP_TRUST identity shared by the instrument and candidate inputs. */
export function trustAllocationInstrumentId(
  trust: Pick<Trust, 'id'>,
): string | null {
  return typeof trust.id === 'string' && CANONICAL_TRUST_IDS.has(trust.id)
    ? `trust:${trust.id}`
    : null
}

/**
 * Pure registry-trust -> allocation candidate adapter. Monetary authority stays
 * in the allocation engine; this adapter emits identity, eligibility and order
 * inputs only.
 */
export function buildTrustAllocationCandidates(input: {
  readonly trust: readonly Trust[]
}): TrustAllocationCandidateAdapterResult {
  const identities = new Set<string>()
  const candidates: CandidateInput[] = []

  for (let artifactIndex = 0; artifactIndex < input.trust.length; artifactIndex += 1) {
    const trust = input.trust[artifactIndex]
    const instrumentId = trustAllocationInstrumentId(trust)
    if (
      instrumentId === null ||
      identities.has(instrumentId) ||
      CANONICAL_TRUST_POLICIES.get(trust.id) !== trust.policy
    ) return INVALID_RESULT
    identities.add(instrumentId)

    if (trust.policy !== 'JAPAN_SHORTTERM' || trust.notForTrading === true) continue
    candidates.push(Object.freeze({
      instrumentId,
      buyKind: trust.eval > 0 ? 'BUY_MORE' : 'BUY_NEW',
      marketRank: null,
      artifactIndex,
      confidence: null,
    }))
  }

  return Object.freeze({
    status: 'available',
    candidates: Object.freeze(candidates),
  })
}
