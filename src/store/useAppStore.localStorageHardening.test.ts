// RA-009-B1: localStorage persistence hardening — behavior tests for:
//  (P2) structured persistence-failure reason propagation out of
//       persistCurrentPortfolioGeneration()'s canonical replacement catch, and
//  (P3) v91_learning joining the legacy generation change-detection key inventory,
//       including the legacy self-persist shortcut's blind spot for learning content.
// Fault injection uses a partial ./persist module mock (persistCsvImportTransaction /
// persistLegacyPortfolioGenerationTransaction) so a real CsvImportCanonicalConflictError /
// CsvImportPersistenceError instance reaches the real, unmodified production classifier —
// production source is never changed to make this observable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const persistFault = vi.hoisted(() => ({
  csv: null as null | (() => Error),
  legacy: null as null | (() => Error),
}))

vi.mock('./persist', async importOriginal => {
  const actual = await importOriginal<typeof import('./persist')>()
  return {
    ...actual,
    persistCsvImportTransaction: (...args: Parameters<typeof actual.persistCsvImportTransaction>) => {
      if (persistFault.csv) {
        const build = persistFault.csv
        persistFault.csv = null
        throw build()
      }
      return actual.persistCsvImportTransaction(...args)
    },
    persistLegacyPortfolioGenerationTransaction: (
      ...args: Parameters<typeof actual.persistLegacyPortfolioGenerationTransaction>
    ) => {
      if (persistFault.legacy) {
        const build = persistFault.legacy
        persistFault.legacy = null
        throw build()
      }
      return actual.persistLegacyPortfolioGenerationTransaction(...args)
    },
  }
})

vi.mock('../services/loadStaticData', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/loadStaticData')>()
  return {
    ...actual,
    refreshAllData: async () => ({
      market: { data: BASE_MARKET_HOLDER.value, source: 'static' },
      correlation: { data: null, source: 'static' },
      news: { data: null, source: 'none' },
      trust: { data: null, source: 'static', lastUpdated: null },
      holdingsSnapshot: { data: null, source: 'none', lastUpdated: null },
      macro: { data: null, source: 'none' },
      nikkeiVI: { data: null, source: 'none' },
      sq: { data: null, source: 'none' },
      margin: { data: null, source: 'none' },
      flows: { data: null, source: 'none' },
      candidatesNews: { data: actual.DEFAULT_CANDIDATES_NEWS_DATA, source: 'default' },
      candidatesStocks: { data: actual.DEFAULT_CANDIDATES_STOCKS_DATA, source: 'default' },
      regimeState: { data: actual.DEFAULT_REGIME_STATE, source: 'default', generatedAt: null },
      safeMode: { data: actual.DEFAULT_SAFE_MODE_SNAPSHOT, source: 'default', lastChecked: null },
      tierAViolations: { data: actual.DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'default', generatedAt: null },
      tierAAlerts: { data: actual.DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'default', generatedAt: null },
    }),
  }
})

// `vi.mock` factories may not close over module-scope `let`/`const` declared after them, but a
// mutable holder object created before the factory runs is fine — populated once real imports
// below are available.
const BASE_MARKET_HOLDER: { value: unknown } = { value: null }

import type { CsvImportProvenance, LearningState } from '../types'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  CsvImportCanonicalConflictError,
  CsvImportPersistenceError,
  CsvImportPersistenceIndeterminateError,
  persistCsvImportTransaction,
  persistLearning,
  persistPortfolio,
  persistTrust,
  type CsvImportPersistencePayload,
} from './persist'
import {
  createAppStoreInstanceForTest,
  type AppStoreState,
} from './useAppStore'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
// Vite's `?raw` suffix returns a module's own source text as a plain string; see the identical
// pattern/rationale in src/components/StatusBar.crossTabInvalidation.test.tsx.
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import persistSource from './persist.ts?raw'
// @ts-expect-error -- resolved at build/test time by Vite's `?raw` import convention
import useAppStoreSource from './useAppStore.ts?raw'

const FIXED_NOW = new Date('2026-07-20T03:00:00.000Z')

const storage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

function freshStore() {
  return createAppStoreInstanceForTest({
    portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
  vi.stubGlobal('localStorage', localStorageMock)
  Object.keys(storage).forEach(key => delete storage[key])
  persistFault.csv = null
  persistFault.legacy = null
  const seed = freshStore()
  BASE_MARKET_HOLDER.value = seed.store.getState().market
  seed.controls.dispose()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function provenance(overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return {
    importedAt: '2026-07-20T01:00:00.000Z',
    sourceAsOf: '2026-07-20T00:30:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${'9'.repeat(64)}`,
    contentFingerprint: 'fnv1a32:99999999',
    sourceFileName: 'hardening.csv',
    fileLastModified: '2026-07-20T00:45:00.000Z',
    ...overrides,
  }
}

function validLearning(overrides: Partial<LearningState> = {}): LearningState {
  const emptyDecisionSummary = { count: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0 }
  return {
    lastUpdated: '2026-07-20T00:00:00.000Z',
    baselineCount: 0,
    baseline: [],
    outcomes: [],
    summary: {
      total: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0,
      byDecision: { BUY: { ...emptyDecisionSummary }, HOLD: { ...emptyDecisionSummary }, SELL: { ...emptyDecisionSummary } },
      driftSignals: [],
    },
    suggestedWeights: { fundamental: 0.3, market: 0.2, technical: 0.2, news: 0.1, quality: 0.1, risk: 0.1 },
    ...overrides,
  }
}

/** Seeds a canonical committed generation whose identity fields come straight from the store's
 * own current state, so the alignment check trivially sees the store as aligned with it. */
function seedCommittedCanonicalFromState(state: AppStoreState, learning: LearningState | null = null): void {
  const csvImportedAt = '2026-07-20T01:00:00.000Z'
  const payload: CsvImportPersistencePayload = {
    holdings: state.holdings,
    trust: state.trust,
    learning,
    csvImportedAt,
    provenance: provenance({ importedAt: csvImportedAt }),
    syncSummary: null,
    trustShortSnapshot: { date: csvImportedAt.slice(0, 10), total: 0, evalById: {} },
    portfolioPolicy: state.portfolioPolicy,
    cashAssumptions: state.cashAssumptions,
    origin: null,
    snapshotTransferIdentity: null,
  }
  persistCsvImportTransaction(payload, 1_000, undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

function alignStateWithCanonical(store: ReturnType<typeof freshStore>['store'], learning: LearningState | null = null): void {
  store.setState(state => ({
    system: {
      ...state.system,
      csvLastImportedAt: '2026-07-20T01:00:00.000Z',
      csvImportProvenance: provenance({ importedAt: '2026-07-20T01:00:00.000Z' }),
      csvSyncSummary: null,
    },
    learning,
  }))
}

describe('RA-009-B1: canonical persistence error reason propagation', () => {
  it('canonical conflict during initialize maps to PORTFOLIO_GENERATION_CONFLICT with zero publish/invalidation', async () => {
    const { store, controls } = freshStore()
    seedCommittedCanonicalFromState(store.getState())
    const before = store.getState()
    persistFault.csv = () => new CsvImportCanonicalConflictError('injected canonical conflict')

    const result = await store.getState().initialize()

    expect(result).toEqual({ ok: false, operation: 'initialize', code: 'PORTFOLIO_GENERATION_CONFLICT', retryable: false })
    expect(store.getState()).toBe(before)
    expect(store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('injected canonical conflict')
    const ticket = controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(controls.releasePortfolioOperation(ticket)).toBe(true)
    controls.dispose()
  })

  it('canonical conflict during refreshAllData maps to PORTFOLIO_GENERATION_CONFLICT with zero publish/invalidation', async () => {
    const { store, controls } = freshStore()
    seedCommittedCanonicalFromState(store.getState())
    alignStateWithCanonical(store)
    const before = store.getState()
    persistFault.csv = () => new CsvImportCanonicalConflictError('injected canonical conflict')

    const result = await store.getState().refreshAllData()

    expect(result).toEqual({ ok: false, operation: 'refreshAllData', code: 'PORTFOLIO_GENERATION_CONFLICT', retryable: false })
    expect(store.getState()).toBe(before)
    expect(store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('injected canonical conflict')
    const ticket = controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(controls.releasePortfolioOperation(ticket)).toBe(true)
    controls.dispose()
  })

  it('canonical conflict during a manual writer (setCashAssumptions) maps to PORTFOLIO_GENERATION_CONFLICT, zero publish/invalidation, durable bytes preserved', async () => {
    const { store, controls } = freshStore()
    seedCommittedCanonicalFromState(store.getState())
    alignStateWithCanonical(store)
    const before = store.getState()
    const durableBefore = storage[CSV_IMPORT_GENERATION_KEY]
    persistFault.csv = () => new CsvImportCanonicalConflictError('injected canonical conflict')

    const result = await store.getState().setCashAssumptions({ cashDeposits: 500_000, standbyFunds: 100_000 })

    expect(result).toMatchObject({ ok: false, operation: 'setCashAssumptions', code: 'PORTFOLIO_GENERATION_CONFLICT', retryable: false })
    // local publication happens (system.status/error is set for user feedback) but the
    // durable-generation-bearing fields must not move, and no analysis/generation is published.
    expect(store.getState().holdings).toBe(before.holdings)
    expect(store.getState().cashAssumptions).toBe(before.cashAssumptions)
    expect(store.getState().analysis).toBe(before.analysis)
    expect(store.getState().system.crossTabInvalidation).toBeUndefined()
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(durableBefore)
    expect(JSON.stringify(result)).not.toContain('injected canonical conflict')
    const ticket = controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(controls.releasePortfolioOperation(ticket)).toBe(true)
    controls.dispose()
  })

  it.each([
    ['rolled_back', () => new CsvImportPersistenceError('injected rolled back', 'rolled_back')],
    ['rollback_failed', () => new CsvImportPersistenceError('injected rollback failed', 'rollback_failed')],
    ['indeterminate', () => new CsvImportPersistenceIndeterminateError()],
    ['not_attempted', () => new CsvImportPersistenceError('injected not attempted', 'not_attempted')],
    ['unknown error', () => new TypeError('injected unknown failure')],
  ] as const)('%s from the canonical write surfaces as a persistence failure (never SUCCESS/CONFLICT), with zero publish/invalidation/raw-message exposure', async (_label, buildError) => {
    const { store, controls } = freshStore()
    seedCommittedCanonicalFromState(store.getState())
    alignStateWithCanonical(store)
    const before = store.getState()
    persistFault.csv = buildError

    const result = await store.getState().setCashAssumptions({ cashDeposits: 500_000, standbyFunds: 100_000 })

    expect(result).toMatchObject({ ok: false, operation: 'setCashAssumptions', code: 'MANUAL_PERSISTENCE_ERROR', retryable: true })
    expect(store.getState().holdings).toBe(before.holdings)
    expect(store.getState().cashAssumptions).toBe(before.cashAssumptions)
    expect(store.getState().system.crossTabInvalidation).toBeUndefined()
    const message = JSON.stringify(result)
    expect(message).not.toContain('injected')
    const ticket = controls.acquirePortfolioOperation('manual')
    expect(ticket).not.toBeNull()
    if (ticket) expect(controls.releasePortfolioOperation(ticket)).toBe(true)
    controls.dispose()
  })
})

describe('RA-009-B1: legacy learning generation change detection', () => {
  it('v91_learning participates in the legacy key inventory (present + malformed alone forces staleness)', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    storage.v91_learning = '{not json'

    const result = await store.getState().refreshAllData()

    expect(result).toEqual({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })
    controls.dispose()
  })

  it('canonical absent, legacy learning absent: existing (pre-P3) baseline behavior is preserved', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)

    const result = await store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    controls.dispose()
  })

  it('canonical absent, legacy learning matches the store: aligned', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    const learning = validLearning()
    persistLearning(learning)
    store.setState({ learning })

    const result = await store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    controls.dispose()
  })

  it('canonical absent, legacy learning externally changed to a different valid snapshot: CROSS_TAB_STATE_STALE with zero writer side effects', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    const originalLearning = validLearning({ lastUpdated: '2026-07-19T00:00:00.000Z' })
    persistLearning(originalLearning)
    store.setState({ learning: originalLearning })
    // Bypasses the Web Lock entirely: a direct, non-cooperative mutation of v91_learning.
    persistLearning(validLearning({ lastUpdated: '2026-07-20T02:00:00.000Z' }))
    const before = store.getState()

    const result = await store.getState().refreshAllData()

    expect(result).toEqual({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })
    expect(store.getState()).toBe(before)
    expect(store.getState().system.crossTabInvalidation).toBeUndefined()
    controls.dispose()
  })

  it('canonical absent, malformed legacy learning: stale (fail-closed, same as a malformed holdings/trust snapshot)', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    store.setState({ learning: validLearning() })
    storage.v91_learning = '{"data":{"missing":"outcomes/summary/suggestedWeights"},"savedAt":1}'

    const result = await store.getState().refreshAllData()

    expect(result).toEqual({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })
    controls.dispose()
  })

  it('canonical absent, legacy learning key deleted after having existed: does NOT force staleness (optional-field parity with portfolioPolicy/cashAssumptions — an absent legacy key carries no overwrite authority)', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    const learning = validLearning()
    persistLearning(learning)
    store.setState({ learning })
    delete storage.v91_learning

    const result = await store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    controls.dispose()
  })

  it('committed canonical is the sole authority: a legacy v91_learning mutation is ignored entirely', async () => {
    const { store, controls } = freshStore()
    seedCommittedCanonicalFromState(store.getState(), validLearning({ lastUpdated: '2026-07-18T00:00:00.000Z' }))
    alignStateWithCanonical(store, validLearning({ lastUpdated: '2026-07-18T00:00:00.000Z' }))
    // Direct, non-cooperative mutation of the legacy learning key while canonical governs.
    storage.v91_learning = '{completely-corrupt-and-irrelevant'

    const result = await store.getState().setCashAssumptions({ cashDeposits: 250_000, standbyFunds: 50_000 })

    expect(result).toMatchObject({ ok: true, operation: 'setCashAssumptions', code: 'SUCCESS' })
    controls.dispose()
  })

  it('a store’s own legacy learning persist does not self-stale its very next writer', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    store.setState({ learning: validLearning({ lastUpdated: '2026-07-19T00:00:00.000Z' }) })

    const first = await store.getState().setCashAssumptions({ cashDeposits: 111_111, standbyFunds: 0 })
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    // The manual mutation's own analysis pass recomputes `learning` fresh (a new lastUpdated),
    // and that fresh value is what gets durably persisted alongside holdings/trust.
    expect(store.getState().learning).not.toBeNull()

    const second = await store.getState().setCashAssumptions({ cashDeposits: 222_222, standbyFunds: 0 })

    expect(second).toMatchObject({ ok: true, operation: 'setCashAssumptions', code: 'SUCCESS' })
    controls.dispose()
  })

  it('a load operation whose own durable legacy persist outran a publish-before-apply failure does not self-stale the very next refresh', async () => {
    const { store, controls } = freshStore()
    // Empties holdings/trust first: non-empty trust would otherwise pick up an unrelated
    // cross-call difference from the module-level trust-short tracker on the second analysis
    // pass, which would mask what this test is actually checking. With holdings/trust/policy/
    // cash never moving, only `learning` (freshly recomputed by every refresh's own analysis
    // pass) can possibly differ between the failed attempt's durable write and the retry.
    store.setState({ holdings: [], trust: [] })
    controls.setLoadPublishBeforeApplyHook(() => { throw new Error('injected publish failure') })
    const before = store.getState()

    const failed = await store.getState().refreshAllData()

    expect(failed).toMatchObject({ ok: false, operation: 'refreshAllData', code: 'LOAD_PUBLISH_ERROR' })
    // Persistence already committed durably even though publish never applied it locally.
    expect(store.getState()).toBe(before)

    const retry = await store.getState().refreshAllData()

    expect(retry).toMatchObject({ ok: true, operation: 'refreshAllData', code: 'SUCCESS' })
    controls.dispose()
  })

  it('the legacy self-persist shortcut does not unconditionally bypass a learning change: a primed shortcut still catches a subsequent non-cooperative direct v91_learning mutation', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    store.setState({ learning: validLearning({ lastUpdated: '2026-07-19T00:00:00.000Z' }) })

    // Primes runtime.lastLocallyPersistedLegacyProjection / …LegacyLearningFingerprint via a
    // real successful writer — this is the "local runtimeの既存alignment shortcutが存在" baseline
    // precondition from RA-009-B1 section 8, not merely an unset/never-written cache.
    const primed = await store.getState().setCashAssumptions({ cashDeposits: 111_111, standbyFunds: 0 })
    expect(primed).toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = store.getState()

    // Bypasses the Web Lock entirely: a direct, non-cooperative mutation of v91_learning after
    // the shortcut was primed by the store's own prior write.
    persistLearning(validLearning({ lastUpdated: '2026-07-20T02:00:00.000Z' }))

    const result = await store.getState().refreshAllData()

    expect(result).toEqual({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })
    expect(store.getState()).toBe(before)
    controls.dispose()
  })

  it('runtime isolation: store A’s legacy learning write does not leak into store B’s own-write recognition', async () => {
    const a = freshStore()
    const b = freshStore()
    persistPortfolio(a.store.getState().holdings)
    persistTrust(a.store.getState().trust)
    const sharedLearning = validLearning({ lastUpdated: '2026-07-19T00:00:00.000Z' })
    a.store.setState({ learning: sharedLearning })
    b.store.setState({ learning: sharedLearning })

    const aResult = await a.store.getState().setCashAssumptions({ cashDeposits: 111_111, standbyFunds: 0 })
    expect(aResult).toMatchObject({ ok: true, code: 'SUCCESS' })

    // B never observed A's write; from B's own runtime the disk now looks externally changed.
    const bResult = await b.store.getState().refreshAllData()
    expect(bResult).toEqual({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })

    a.controls.dispose()
    b.controls.dispose()
  })

  it('reset re-evaluates legacy alignment from storage evidence instead of a stale cached recognition', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    store.setState({ learning: validLearning({ lastUpdated: '2026-07-19T00:00:00.000Z' }) })

    const first = await store.getState().setCashAssumptions({ cashDeposits: 111_111, standbyFunds: 0 })
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })

    controls.reset()
    // Bypasses the Web Lock: a direct external mutation of the legacy learning key.
    persistLearning(validLearning({ lastUpdated: '2026-07-20T02:00:00.000Z' }))
    // The store's own in-memory learning was not touched by that external write.
    const beforeRetry = store.getState()

    const result = await store.getState().refreshAllData()

    expect(result).toEqual({ ok: false, operation: 'refreshAllData', code: 'CROSS_TAB_STATE_STALE', retryable: false })
    expect(store.getState()).toBe(beforeRetry)
    controls.dispose()
  })

  it('malformed legacy learning raw is never exposed to the caller (no raw bytes/parse error in the result)', async () => {
    const { store, controls } = freshStore()
    persistPortfolio(store.getState().holdings)
    persistTrust(store.getState().trust)
    store.setState({ learning: validLearning() })
    storage.v91_learning = '{"data":"::not-a-learning-state::","savedAt":1}'

    const result = await store.getState().refreshAllData()

    expect(JSON.stringify(result)).not.toContain('not-a-learning-state')
    controls.dispose()
  })
})

// Supplementary to the behavior tests above. `rolled_back`/`rollback_failed`/`indeterminate`
// all currently collapse to the identical public MANUAL_PERSISTENCE_ERROR / LOAD_PERSISTENCE_ERROR
// result (retryable: true, no `reason` field on the public type) — every consumer of the
// internal reason only branches on `canonical_changed`/`canonical_committed`/`metadata_misaligned`/
// `ownership_lost` for conflict classification. That is a real, provable architectural fact of
// the current codebase (confirmed by grep for every `.reason ===` read site), not a testing
// shortcut: no black-box behavior assertion can distinguish "reason discarded" from "reason kept"
// for these three statuses without adding a new public result code, which is explicitly out of
// scope. This structural check exists only to keep those three reason-preservation mutations
// (RA-009-B1 mutation-catching items 2-4) individually catchable.
describe('RA-009-B1: internal persistence-failure reason mapping (structural — no public observable distinction exists today)', () => {
  it('classifyCurrentPortfolioPersistenceError preserves each CsvImportPersistenceError status as its own reason', () => {
    const classifierSection = useAppStoreSource.slice(
      useAppStoreSource.indexOf('function classifyCurrentPortfolioPersistenceError'),
      useAppStoreSource.indexOf('function persistCurrentPortfolioGeneration'),
    )
    expect(classifierSection).toContain("case 'rolled_back':")
    expect(classifierSection).toContain("reason: 'rolled_back'")
    expect(classifierSection).toContain("case 'rollback_failed':")
    expect(classifierSection).toContain("reason: 'rollback_failed'")
    // 'indeterminate' is reachable via two distinct branches — the CsvImportPersistenceIndeterminateError
    // subclass special-case and the plain-CsvImportPersistenceError switch's own 'indeterminate' case —
    // so this must count both occurrences rather than merely assert presence of at least one.
    expect(classifierSection.match(/reason: 'indeterminate'/g)?.length).toBe(2)
  })

  it('classifyCurrentPortfolioPersistenceError never threads the raw error/message into the returned reason (not_attempted and unknown-error both fall back to a bare { status: \'failed\' })', () => {
    const classifierSection = useAppStoreSource.slice(
      useAppStoreSource.indexOf('function classifyCurrentPortfolioPersistenceError'),
      useAppStoreSource.indexOf('function persistCurrentPortfolioGeneration'),
    )
    // not_attempted (inside the switch) and the final unknown-error fallback (after it) are the
    // only two branches with no reason at all.
    expect(classifierSection.match(/return \{ status: 'failed' \}/g)?.length).toBe(2)
    expect(classifierSection).not.toMatch(/reason:[^,}]*error/)
  })
})

describe('RA-009-B1: CAS terminology clarification', () => {
  it('persist.ts no longer describes localStorage compare/restore as a true atomic CAS', () => {
    expect(persistSource).not.toContain('for a later compare-and-swap')
    expect(persistSource).not.toMatch(/\bcompare-and-swap\b/i)
  })

  it('the compare-and-restore limitation against non-cooperating writers is documented on both helpers', () => {
    expect(persistSource).toContain('conditional compare-and-restore')
    expect(persistSource).toContain('not a true atomic CAS')
    expect(persistSource).toContain('cooperative safety under the shared Web Lock')
    expect(persistSource).toContain('best-effort only')
  })
})
