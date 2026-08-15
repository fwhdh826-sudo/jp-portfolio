// ═══════════════════════════════════════════════════════════
// NEXT_3_CAND_SYN_1C_R1_OFFICIAL_DECISION_INVALIDATION
//
// D2/D12 generation atomicity: CandidateDecisionSynthesis unavailable, stale,
// null or invalid must mean the candidate compatibility component inside
// officialDecision.actions is absent in the SAME fail-closed state
// transition — never a later, separate cleanup. This file proves that
// atomicity for both production fail-closed paths (cash TTL expiry and
// cross-tab invalidation) and for the observable intermediate state a
// subscriber can see.
// ═══════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest'
import { CASH_AUTHORITY_TTL_MS } from '../domain/cash/cashAuthority'
import type { OfficialDecision } from '../types'
import { createAppStoreInstanceForTest, useAppStore } from './useAppStore'
import {
  createPortfolioGenerationInvalidationEvent,
  createPortfolioGenerationInvalidationTransport,
} from './portfolioGenerationInvalidationTransport'
import { FakeBroadcastChannelHub } from './testing/fakeBroadcastChannelHub'
import { FakeStorageEventHub } from './testing/fakeStorageEventHub'

const GENERATED_AT = '2026-08-14T01:00:00.000Z'

function baseDecisionWithCandidate(): OfficialDecision {
  return {
    generatedAt: GENERATED_AT,
    source: 'committee',
    headline: 'test',
    stance: 'neutral',
    noTrade: false,
    dataQualitySuppressed: false,
    actions: [
      { id: 'holding-1', assetType: 'stock', name: '保有銘柄', action: 'HOLD', reason: '既存判断', source: 'committee' },
      { id: 'holding-2', assetType: 'jp_trust', name: 'ブロック銘柄', action: 'BLOCKED', reason: 'リスクゲート', source: 'risk_gate' },
      {
        id: 'candidate-synthesis-1003',
        assetType: 'stock',
        code: '1003',
        name: 'テスト候補',
        action: 'BUY_NEW',
        reason: 'candidate reason',
        source: 'candidate',
        isCandidate: true,
        candidateSource: 'candidate_funnel',
      },
    ],
    risks: [],
    rationale: [],
  }
}

function candidateActionsOf(decision: OfficialDecision | null): number {
  return decision?.actions.filter(a => a.isCandidate).length ?? 0
}

describe('R1-F/R1-G/R1-H: cash TTL fail-closed invalidation strips the candidate component atomically', () => {
  it('R1-F candidate action count is 0 immediately after fail-closed invalidation, in the same phase as candidateDecisionSynthesis=null', () => {
    const staleUpdatedAt = new Date(Date.parse(GENERATED_AT) - CASH_AUTHORITY_TTL_MS - 60_000).toISOString()
    useAppStore.setState({
      officialDecision: baseDecisionWithCandidate(),
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: 0,
        updatedAt: staleUpdatedAt,
      },
    })
    expect(candidateActionsOf(useAppStore.getState().officialDecision)).toBe(1)

    const changed = useAppStore.getState().revalidateCashAuthorityExpiry(Date.parse(GENERATED_AT))
    expect(changed).toBe(true)

    const after = useAppStore.getState()
    expect(after.allocationPlanStatus).toBe('stale')
    expect(after.candidateDecisionSynthesis).toBeNull()
    expect(candidateActionsOf(after.officialDecision)).toBe(0)
  })

  it('R1-G cash TTL expiry preserves ordinary (non-candidate) holding actions exactly', () => {
    const staleUpdatedAt = new Date(Date.parse(GENERATED_AT) - CASH_AUTHORITY_TTL_MS - 60_000).toISOString()
    useAppStore.setState({
      officialDecision: baseDecisionWithCandidate(),
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: 0,
        updatedAt: staleUpdatedAt,
      },
    })

    useAppStore.getState().revalidateCashAuthorityExpiry(Date.parse(GENERATED_AT))

    const holdingActions = useAppStore.getState().officialDecision?.actions.filter(a => !a.isCandidate)
    expect(holdingActions).toEqual([
      { id: 'holding-1', assetType: 'stock', name: '保有銘柄', action: 'HOLD', reason: '既存判断', source: 'committee' },
      { id: 'holding-2', assetType: 'jp_trust', name: 'ブロック銘柄', action: 'BLOCKED', reason: 'リスクゲート', source: 'risk_gate' },
    ])
  })

  it('R1-H the stale-cash runFullAnalysis rebuild does not resurrect the stale candidate action', () => {
    const staleUpdatedAt = new Date(Date.parse(GENERATED_AT) - CASH_AUTHORITY_TTL_MS - 60_000).toISOString()
    useAppStore.setState({
      officialDecision: baseDecisionWithCandidate(),
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: 0,
        updatedAt: staleUpdatedAt,
      },
    })

    useAppStore.getState().revalidateCashAuthorityExpiry(Date.parse(GENERATED_AT))

    // Rebuild (runFullAnalysis) has already run synchronously inside revalidateCashAuthorityExpiry;
    // candidateDecisionSynthesis stays null (CAND-SYN-1B: runFullAnalysis alone never populates it),
    // so no candidate action can have been reintroduced by the rebuild step.
    const after = useAppStore.getState()
    expect(after.candidateDecisionSynthesis).toBeNull()
    expect(candidateActionsOf(after.officialDecision)).toBe(0)
  })
})

describe('R1-I/R1-J: cross-tab fail-closed invalidation flush strips the candidate component atomically', () => {
  function harness() {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const context = storageHub.createContext()
    const transport = createPortfolioGenerationInvalidationTransport({
      instanceId: 'a',
      createBroadcastChannel: bcHub.createFactory(),
      storage: context.storage,
      storageEventTarget: context.eventTarget,
    })
    const created = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: { instanceId: 'a', transport },
    })
    const publisherContext = storageHub.createContext()
    const publisher = createPortfolioGenerationInvalidationTransport({
      instanceId: 'external',
      createBroadcastChannel: bcHub.createFactory(),
      storage: publisherContext.storage,
      storageEventTarget: publisherContext.eventTarget,
    })
    return { created, publisher }
  }

  it('R1-I candidate action count is 0 after the cross-tab invalidation flush', () => {
    const { created, publisher } = harness()
    created.store.setState({ officialDecision: baseDecisionWithCandidate() })
    expect(candidateActionsOf(created.store.getState().officialDecision)).toBe(1)

    publisher.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'external',
      operation: 'importCsv',
    }))

    const after = created.store.getState()
    expect(after.allocationPlanStatus).toBe('stale')
    expect(after.candidateDecisionSynthesis).toBeNull()
    expect(candidateActionsOf(after.officialDecision)).toBe(0)

    created.controls.dispose()
    publisher.dispose()
  })

  it('R1-J cross-tab invalidation preserves ordinary (non-candidate) holding actions exactly', () => {
    const { created, publisher } = harness()
    created.store.setState({ officialDecision: baseDecisionWithCandidate() })

    publisher.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'external',
      operation: 'importCsv',
    }))

    const holdingActions = created.store.getState().officialDecision?.actions.filter(a => !a.isCandidate)
    expect(holdingActions).toEqual([
      { id: 'holding-1', assetType: 'stock', name: '保有銘柄', action: 'HOLD', reason: '既存判断', source: 'committee' },
      { id: 'holding-2', assetType: 'jp_trust', name: 'ブロック銘柄', action: 'BLOCKED', reason: 'リスクゲート', source: 'risk_gate' },
    ])

    created.controls.dispose()
    publisher.dispose()
  })
})

describe('R1 observer-state atomicity: no intermediate state may pair synthesis=null with a stale candidate action', () => {
  function violatesAtomicity(state: ReturnType<typeof useAppStore.getState>): boolean {
    return state.candidateDecisionSynthesis === null && candidateActionsOf(state.officialDecision) > 0
  }

  it('cash TTL expiry: every observed state transition satisfies atomicity once invalidation begins', () => {
    const staleUpdatedAt = new Date(Date.parse(GENERATED_AT) - CASH_AUTHORITY_TTL_MS - 60_000).toISOString()
    useAppStore.setState({
      officialDecision: baseDecisionWithCandidate(),
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: 0,
        updatedAt: staleUpdatedAt,
      },
    })

    const violations: unknown[] = []
    const unsubscribe = useAppStore.subscribe(state => {
      if (violatesAtomicity(state)) violations.push({ candidateDecisionSynthesis: state.candidateDecisionSynthesis })
    })

    useAppStore.getState().revalidateCashAuthorityExpiry(Date.parse(GENERATED_AT))

    unsubscribe()
    expect(violations).toEqual([])
  })

  it('cross-tab invalidation flush: every observed state transition satisfies atomicity once invalidation begins', () => {
    const bcHub = new FakeBroadcastChannelHub()
    const storageHub = new FakeStorageEventHub()
    const context = storageHub.createContext()
    const transport = createPortfolioGenerationInvalidationTransport({
      instanceId: 'a',
      createBroadcastChannel: bcHub.createFactory(),
      storage: context.storage,
      storageEventTarget: context.eventTarget,
    })
    const created = createAppStoreInstanceForTest({
      portfolioGenerationInvalidation: { instanceId: 'a', transport },
    })
    created.store.setState({ officialDecision: baseDecisionWithCandidate() })

    const publisherContext = storageHub.createContext()
    const publisher = createPortfolioGenerationInvalidationTransport({
      instanceId: 'external',
      createBroadcastChannel: bcHub.createFactory(),
      storage: publisherContext.storage,
      storageEventTarget: publisherContext.eventTarget,
    })

    const violations: unknown[] = []
    const unsubscribe = created.store.subscribe(state => {
      if (violatesAtomicity(state)) violations.push({ candidateDecisionSynthesis: state.candidateDecisionSynthesis })
    })

    publisher.publish(createPortfolioGenerationInvalidationEvent({
      senderInstanceId: 'external',
      operation: 'importCsv',
    }))

    unsubscribe()
    expect(violations).toEqual([])

    created.controls.dispose()
    publisher.dispose()
  })
})
