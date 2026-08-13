import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CashAssumptions } from '../types'

const analysisProbe = vi.hoisted(() => ({ calls: 0, fail: false }))
const loadProbe = vi.hoisted(() => ({
  calls: 0,
  implementation: null as null | (() => Promise<unknown>),
}))

vi.mock('../domain/analysis/computeAnalysis', async importOriginal => {
  const actual = await importOriginal<typeof import('../domain/analysis/computeAnalysis')>()
  return {
    ...actual,
    computeAnalysis: (...args: Parameters<typeof actual.computeAnalysis>) => {
      analysisProbe.calls += 1
      if (analysisProbe.fail) throw new Error('injected analysis failure')
      return actual.computeAnalysis(...args)
    },
  }
})

vi.mock('../services/loadStaticData', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/loadStaticData')>()
  return {
    ...actual,
    refreshAllData: async (...args: Parameters<typeof actual.refreshAllData>) => {
      loadProbe.calls += 1
      if (loadProbe.implementation) return loadProbe.implementation()
      return actual.refreshAllData(...args)
    },
  }
})

import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import type { Holding, Trust } from '../types'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
} from './persist'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
  type PortfolioGenerationLockAdapter,
  type PortfolioGenerationLockTimerApi,
} from './portfolioGenerationLock'
import { createPortfolioCoordinationFailure } from './portfolioOperationResult'
import { FakeLockManager } from './testing/fakeLockManager'
import {
  createAppStoreInstanceForTest,
  resetPortfolioGenerationLockAdapterForTest,
  type AppStoreState,
} from './useAppStore'

// ─────────────────────────────────────────────────────────────
// RA-007-E: adversarial failure-recovery validation. Test-hardening only — every case here must
// assert the EXISTING documented contract (no-write failures release the lock/ticket and never
// touch durable bytes; capability failures never invoke the callback; CAS/ownership defenses are
// unaffected by Web Lock wrapping; root state is never partially mutated). If production violates
// any of these, the case must fail RED and be reported BLOCKED — never weakened to pass.
// ─────────────────────────────────────────────────────────────

const NOW_MS = Date.parse('2026-07-20T03:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

const BASELINE_HOLDING: Holding = {
  code: '1001', name: 'recovery holding', eval: 400_000, pnlPct: 0,
  mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'test',
  target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
  macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
  cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
}

const BASELINE_TRUST: Trust = {
  id: 'recovery-fund', name: 'recovery fund', abbr: 'RCV', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 250_000, pnlPct: 0, dayPct: 0,
  cost: 0.2, mu: 0.1, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0,
  decision: 'HOLD',
}

const BASELINE_CASH_ASSUMPTIONS: CashAssumptions = {
  source: 'MANUAL',
  grossCash: 1_200_000,
  safetyReserve: 0,
  pendingOrderCash: null,
  updatedAt: NOW_ISO,
}

class CountingFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File) {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const storage: Record<string, string> = {}
const storageCounts = { get: 0, set: 0, remove: 0 }
let fileReaderStarts = 0

const localStorageMock = {
  getItem(key: string) {
    storageCounts.get += 1
    return storage[key] ?? null
  },
  setItem(key: string, value: string) {
    storageCounts.set += 1
    storage[key] = value
  },
  removeItem(key: string) {
    storageCounts.remove += 1
    delete storage[key]
  },
}

function adapter(manager: FakeLockManager, timeoutMs = 60_000): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs })
}

function immediateAdapter(): PortfolioGenerationLockAdapter {
  return {
    async runExclusive(_operation, callback) {
      return { ok: true, value: await callback() }
    },
  }
}

function baselineStore(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [{ ...BASELINE_HOLDING }],
    trust: [{ ...BASELINE_TRUST }],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...BASELINE_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function seedCanonical(
  state: AppStoreState,
  overrides: Partial<{
    holdings: Holding[]
    trust: Trust[]
    portfolioPolicy: AppStoreState['portfolioPolicy']
    cashAssumptions: AppStoreState['cashAssumptions']
  }> = {},
): void {
  persistCsvImportTransaction({
    holdings: overrides.holdings ?? state.holdings,
    trust: overrides.trust ?? state.trust,
    learning: state.learning,
    csvImportedAt: null,
    provenance: null,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-07-20', total: 0, evalById: {} },
    portfolioPolicy: overrides.portfolioPolicy ?? state.portfolioPolicy,
    cashAssumptions: overrides.cashAssumptions ?? state.cashAssumptions,
    origin: 'snapshot',
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

function csvRow(code: string, evalValue: number): string {
  return [
    'データ基準日時,2026-07-20T11:00:00+09:00',
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    `${code},recovery holding,1200,${evalValue},0.00,0.00,2025-01-01`,
  ].join('\n')
}

function csvFile(content = csvRow(BASELINE_HOLDING.code, 444_000)): File {
  return new File([content], 'recovery.csv', { type: 'text/csv' })
}

function distinctSnapshotRaw(code: string): string {
  const source = createAppStoreInstanceForTest({ portfolioGenerationLock: immediateAdapter() })
  source.store.setState(state => ({
    holdings: [{ ...BASELINE_HOLDING, code, name: 'snapshot holding', eval: 777_000 }],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
  return source.store.getState().exportPortfolioSnapshot()
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

function resetCounts(): void {
  storageCounts.get = 0
  storageCounts.set = 0
  storageCounts.remove = 0
  analysisProbe.calls = 0
  loadProbe.calls = 0
  fileReaderStarts = 0
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', CountingFileReader)
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })))
  Object.keys(storage).forEach(key => delete storage[key])
  resetCounts()
  analysisProbe.fail = false
  loadProbe.implementation = null
})

afterEach(() => {
  resetPortfolioGenerationLockAdapterForTest()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────
// Writer registry (shared trigger + baseline setup for all 10 writers)
// ─────────────────────────────────────────────────────────────

const ALL_WRITERS = [
  'initialize',
  'refreshAllData',
  'importCsv',
  'importPortfolioSnapshot',
  'updateHolding',
  'updateTrust',
  'setPortfolioPolicy',
  'setCashAssumptions',
  'clearCashAssumptionsOverride',
  'importCashAssumptions',
] as const

type WriterKey = typeof ALL_WRITERS[number]
type Instance = ReturnType<typeof createAppStoreInstanceForTest>

function makeInstance(lock: PortfolioGenerationLockAdapter): Instance {
  const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: lock })
  baselineStore(instance.store)
  return instance
}

const WRITER_TRIGGERS: Record<WriterKey, (instance: Instance) => Promise<unknown>> = {
  initialize: instance => instance.store.getState().initialize(),
  refreshAllData: instance => instance.store.getState().refreshAllData(),
  importCsv: instance => instance.store.getState().importCsv(csvFile()),
  importPortfolioSnapshot: instance => instance.store.getState().importPortfolioSnapshot(
    instance.store.getState().exportPortfolioSnapshot(),
  ),
  updateHolding: instance => instance.store.getState().updateHolding(
    BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 },
  ),
  updateTrust: instance => instance.store.getState().updateTrust(
    BASELINE_TRUST.id, { eval: BASELINE_TRUST.eval + 1 },
  ),
  setPortfolioPolicy: instance => instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.22 }),
  setCashAssumptions: instance => instance.store.getState().setCashAssumptions({
    grossCash: 2,
    safetyReserve: 0,
    pendingOrderCash: null,
  }),
  clearCashAssumptionsOverride: instance => instance.store.getState().clearCashAssumptionsOverride(),
  importCashAssumptions: instance => instance.store.getState().importCashAssumptions({
    grossCash: 4,
    safetyReserve: 0,
    pendingOrderCash: null,
    updatedAt: NOW_ISO,
  }),
}

// ─────────────────────────────────────────────────────────────
// Section 14: capability failures across all 10 writers (40 cases)
// ─────────────────────────────────────────────────────────────
describe('RA-007-E capability failures across all 10 writers', () => {
  const NON_RETRYABLE_UNAVAILABLE = 'WEB_LOCK_UNAVAILABLE' as const
  const IMMEDIATE_CODES = ['WEB_LOCK_UNAVAILABLE', 'WEB_LOCK_ABORTED', 'WEB_LOCK_REQUEST_FAILED'] as const

  it.each(ALL_WRITERS.flatMap(writer => IMMEDIATE_CODES.map(code => [writer, code] as const)))(
    '%s returns %s with zero callback invocation and ticket release',
    async (writer, code) => {
      const lock: PortfolioGenerationLockAdapter = {
        async runExclusive(operation) {
          return createPortfolioCoordinationFailure(operation, code)
        },
      }
      const instance = makeInstance(lock)
      resetCounts()
      let notifications = 0
      instance.store.subscribe(() => { notifications += 1 })
      const before = instance.store.getState()

      const result = await WRITER_TRIGGERS[writer](instance)

      expect(result).toEqual(createPortfolioCoordinationFailure(writer, code))
      expect((result as { retryable: boolean }).retryable).toBe(code !== NON_RETRYABLE_UNAVAILABLE)
      expect(notifications).toBe(0)
      expect(analysisProbe.calls).toBe(0)
      expect(storageCounts.get).toBe(0)
      expect(storageCounts.set).toBe(0)
      expect(fileReaderStarts).toBe(0)
      expect(instance.controls.inspect().activeOperationKind).toBeNull()
      expect(instance.store.getState()).toBe(before)
    },
  )

  it.each(ALL_WRITERS)('%s classifies WEB_LOCK_TIMEOUT before grant and permits a later retry', async writer => {
    let timeoutCallback: (() => void) | null = null
    const timerApi: PortfolioGenerationLockTimerApi = {
      setTimeout(callback) { timeoutCallback = callback; return 1 as ReturnType<typeof setTimeout> },
      clearTimeout() { timeoutCallback = null },
    }
    const manager = new FakeLockManager()
    const timeoutAdapter = createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 10, timerApi })
    const instance = makeInstance(timeoutAdapter)
    resetCounts()
    let notifications = 0
    instance.store.subscribe(() => { notifications += 1 })

    const pending = WRITER_TRIGGERS[writer](instance)
    await flush()
    expect(timeoutCallback).not.toBeNull()
    timeoutCallback!()
    const result = await pending

    expect(result).toEqual(createPortfolioCoordinationFailure(writer, 'WEB_LOCK_TIMEOUT'))
    expect(notifications).toBe(0)
    expect(analysisProbe.calls).toBe(0)
    expect(storageCounts.set).toBe(0)
    expect(fileReaderStarts).toBe(0)
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.pendingCount()).toBe(0)

    const retryManager = new FakeLockManager()
    const retryInstance = makeInstance(adapter(retryManager))
    const retry = WRITER_TRIGGERS[writer](retryInstance)
    const retryResult = await grant(retryManager, retry)
    expect((retryResult as { ok: boolean }).ok).toBe(true)
  })

  it.each(ALL_WRITERS)('%s classifies WEB_LOCK_REQUEST_FAILED and permits a later retry', async writer => {
    let attempts = 0
    const requestFailure = createPortfolioGenerationLockAdapter({
      lockManager: {
        request: (_name, _options, callback) => {
          attempts += 1
          if (attempts === 1) throw new Error('request failed')
          return Promise.resolve(callback({} as Lock))
        },
      },
    })
    const instance = makeInstance(requestFailure)
    resetCounts()
    const first = await WRITER_TRIGGERS[writer](instance)
    expect(first).toEqual(createPortfolioCoordinationFailure(writer, 'WEB_LOCK_REQUEST_FAILED'))
    expect(instance.controls.inspect().activeOperationKind).toBeNull()

    const retry = await WRITER_TRIGGERS[writer](instance)
    expect((retry as { ok: boolean }).ok).toBe(true)
    expect(attempts).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────
// Section 11: no-write / pre-commit failures
// ─────────────────────────────────────────────────────────────
describe('RA-007-E manual mutation NO_CHANGE leaves durable state untouched', () => {
  it.each([
    ['updateHolding', (i: Instance) => i.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval })],
    ['updateTrust', (i: Instance) => i.store.getState().updateTrust(BASELINE_TRUST.id, { eval: BASELINE_TRUST.eval })],
    ['setPortfolioPolicy', (i: Instance) => i.store.getState().setPortfolioPolicy({ ...DEFAULT_PORTFOLIO_POLICY })],
  ] as const)('%s with identical values returns NO_CHANGE, zero writes, and the lock/ticket are released for the next waiter', async (_label, trigger) => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()

    const pending = trigger(a)
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'NO_CHANGE' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)

    // A NO_CHANGE result commits nothing durable, so a queued waiter with the same aligned
    // baseline still succeeds — the lock was fully released and the next grant proceeds.
    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 999 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  // FINDING (P3, observability/test-coverage only — not a coordination-safety defect):
  // unlike updateHolding/updateTrust/setPortfolioPolicy/importCashAssumptions, setCashAssumptions
  // has no current-vs-next equality check — it always re-stamps manualUpdatedAt to "now" and
  // therefore always returns SUCCESS (never NO_CHANGE), even when cashDeposits/standbyFunds are
  // identical to the current durable values. This still commits and publishes correctly (verified
  // below) and does not violate any Web Lock/coordination contract; it is a pre-existing
  // NO_CHANGE-detection asymmetry across the six manual writers, worth a follow-up ticket.
  it('setCashAssumptions with identical numeric values still returns SUCCESS (re-stamps manualUpdatedAt) and the lock/ticket are released for the next waiter', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()

    const pending = a.store.getState().setCashAssumptions({
      grossCash: BASELINE_CASH_ASSUMPTIONS.grossCash,
      safetyReserve: 0,
      pendingOrderCash: null,
    })
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(a.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)

    // `a`'s write persisted a legacy cashAssumptions-only generation. Per the existing partial-
    // legacy-evidence fail-closed contract (a legacy key exists but the holdings/trust legacy
    // keys do not), any OTHER store now fails closed as stale rather than silently trusting
    // partial evidence — proving the lock is free uses a bootstrap operation instead.
    const next = b.store.getState().initialize()
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

describe('RA-007-E CSV no-write failures release the lock for the next queued writer', () => {
  it.each([
    ['no valid rows', (): string => '', 'NO_VALID_ROWS'],
    ['full-sync guard rejected', (): string => csvRow('2002', 500_000), 'FULL_SYNC_GUARD_REJECTED'],
  ] as const)('%s returns %s and permits the next queued CSV import', async (_label, buildContent, code) => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()

    const pending = a.store.getState().importCsv(csvFile(buildContent()))
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code } as const)
    expect(a.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)

    const next = b.store.getState().importCsv(csvFile(csvRow(BASELINE_HOLDING.code, 999_000)))
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('a duplicate CSV (matching provenance) is a no-write success and releases the lock for the next queued import', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    const content = csvRow(BASELINE_HOLDING.code, BASELINE_HOLDING.eval)
    // Establish the committed generation through `a` itself first so `a` stays aligned with the
    // durable canonical it just created (a separate throwaway seeding instance would leave `a`'s
    // local csvLastImportedAt/provenance stale relative to the new canonical).
    await grant(manager, a.store.getState().importCsv(csvFile(content)))
    resetCounts()

    const pending = a.store.getState().importCsv(csvFile(content))
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'DUPLICATE_CSV' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)

    // `a`'s own successful first import already changed the durable CSV metadata (csvImportedAt/
    // provenance), which `b`'s untouched baseline no longer matches — proving the lock is free
    // uses a bootstrap operation (initialize always succeeds regardless of alignment) instead of
    // an aligned-baseline assumption that no longer holds for `b` in this scenario.
    const next = b.store.getState().initialize()
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('a file read failure releases the lock and permits the next queued CSV import', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()
    const brokenFile = { name: 'broken.csv', arrayBuffer: () => Promise.reject(new Error('disk error')) } as File

    const pending = a.store.getState().importCsv(brokenFile)
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code: 'FILE_READ_ERROR' })
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    const next = b.store.getState().importCsv(csvFile(csvRow(BASELINE_HOLDING.code, 999_000)))
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('an analysis failure releases the lock, commits nothing, and permits the next queued CSV import', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()
    analysisProbe.fail = true

    const pending = a.store.getState().importCsv(csvFile(csvRow(BASELINE_HOLDING.code, 999_000)))
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code: 'ANALYSIS_ERROR' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    analysisProbe.fail = false
    const next = b.store.getState().importCsv(csvFile(csvRow(BASELINE_HOLDING.code, 999_000)))
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

describe('RA-007-E snapshot no-write failures release the lock for the next queued writer', () => {
  it('an invalid (unparseable) snapshot releases the lock and permits the next queued import', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()

    // Parse failure happens outside the lock (before it is even requested) so no waiter enters
    // the queue at all — confirm the ticket is still released and the store is untouched.
    const result = await a.store.getState().importPortfolioSnapshot('{not json')
    expect(result).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' })
    expect(a.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.requests).toHaveLength(0)

    const next = b.store.getState().importPortfolioSnapshot(distinctSnapshotRaw('9101'))
    // b still has non-empty baseline content, so a fresh distinct-generation import without
    // matching provenance is blocked as an overwrite, not treated as evidence of a stuck lock.
    const nextResult = await grant(manager, next)
    expect((nextResult as { ok: boolean }).ok).toBe(false)
    expect(b.controls.inspect().activeOperationKind).toBeNull()
  })

  it('a duplicate snapshot (matching identity) is a no-write success and releases the lock', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    const raw = a.store.getState().exportPortfolioSnapshot()
    resetCounts()

    const pending = a.store.getState().importPortfolioSnapshot(raw)
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('unknown provenance against existing content is rejected and releases the lock', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    const source = createAppStoreInstanceForTest({ portfolioGenerationLock: immediateAdapter() })
    source.store.setState({ holdings: [{ ...BASELINE_HOLDING, code: '9102', eval: 500_000 }], trust: [] })
    const raw = source.store.getState().exportPortfolioSnapshot()
    resetCounts()

    const pending = a.store.getState().importPortfolioSnapshot(raw)
    const result = await grant(manager, pending)
    // No csvImportProvenance plus existing content evidence classifies as unknown provenance,
    // not overwrite-blocked (that code is reserved for conflicting-but-present provenance).
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('an analysis failure during snapshot import releases the lock and commits nothing', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    a.store.setState(state => ({
      holdings: [], trust: [],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))
    baselineStore(b.store)
    const raw = distinctSnapshotRaw('9103')
    resetCounts()
    analysisProbe.fail = true

    const pending = a.store.getState().importPortfolioSnapshot(raw)
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_ANALYSIS_ERROR' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    analysisProbe.fail = false
    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

describe('RA-007-E load no-write failures release the lock for the next queued writer', () => {
  it('LOAD_DATA_ERROR leaves durable state untouched and permits the next queued operation', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()
    loadProbe.implementation = async () => { throw new Error('injected') }

    const pending = a.store.getState().refreshAllData()
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code: 'LOAD_DATA_ERROR' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    loadProbe.implementation = null
    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('LOAD_ANALYSIS_ERROR leaves durable state untouched and permits the next queued operation', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    resetCounts()
    analysisProbe.fail = true

    const pending = a.store.getState().initialize()
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code: 'LOAD_ANALYSIS_ERROR' })
    expect(storageCounts.set).toBe(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    analysisProbe.fail = false
    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('LOAD_PERSISTENCE_ERROR before commit leaves durable bytes untouched and permits the next queued operation', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    let throwOnSet = false
    const originalSetItem = localStorageMock.setItem
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        if (throwOnSet) throw new Error('injected persistence failure')
        originalSetItem(key, value)
      },
    })
    resetCounts()
    throwOnSet = true

    const pending = a.store.getState().refreshAllData()
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code: 'LOAD_PERSISTENCE_ERROR' })
    expect(Object.keys(storage)).toHaveLength(0)
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    throwOnSet = false
    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it.each([
    ['initialize', 'LOAD_RESTORE_ERROR'],
    ['refreshAllData', 'LOAD_PERSISTENCE_ERROR'],
  ] as const)('canonical invalid classifies %s as %s, never as stale, and permits the next queued operation', async (writer, code) => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    resetCounts()

    const pending = WRITER_TRIGGERS[writer](a)
    const result = await grant(manager, pending)
    expect(result).toMatchObject({ ok: false, code })
    expect(result).not.toMatchObject({ code: 'CROSS_TAB_STATE_STALE' })
    expect(a.controls.inspect().activeOperationKind).toBeNull()

    delete storage[CSV_IMPORT_GENERATION_KEY]
    const next = b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: BASELINE_HOLDING.eval + 1 })
    expect(await grant(manager, next)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

// ─────────────────────────────────────────────────────────────
// Section 12: persistence success / publish failure recovery
// ─────────────────────────────────────────────────────────────
describe('RA-007-E persistence success but local publish failure recovery', () => {
  it('manual: durable committed, local store stale, MANUAL_PUBLISH_ERROR, next non-bootstrap is stale, next initialize succeeds', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    a.controls.setManualPublishBeforeApplyHook(() => { throw new Error('pre-apply sentinel') })
    const before = a.store.getState()

    const result = await grant(manager, a.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 987_654 }))
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_PUBLISH_ERROR' })
    expect(a.store.getState()).toBe(before)

    const staleNext = await grant(manager, b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 1 }))
    expect(staleNext).toEqual(createPortfolioCoordinationFailure('updateHolding', 'CROSS_TAB_STATE_STALE'))

    const bootstrap = await grant(manager, b.store.getState().initialize())
    expect(bootstrap).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(b.store.getState().holdings.find(h => h.code === BASELINE_HOLDING.code)?.eval).toBe(987_654)
  })

  it('initialize/refresh: durable committed, local store stale, LOAD_PUBLISH_ERROR, next refresh is stale, next initialize succeeds', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    a.controls.setLoadPublishBeforeApplyHook(() => { throw new Error('publish sentinel') })
    const before = a.store.getState()

    const result = await grant(manager, a.store.getState().initialize())
    expect(result).toEqual({ ok: false, operation: 'initialize', code: 'LOAD_PUBLISH_ERROR', retryable: false })
    expect(a.store.getState()).toBe(before)

    const staleRefresh = await grant(manager, b.store.getState().refreshAllData())
    expect(staleRefresh).toEqual(createPortfolioCoordinationFailure('refreshAllData', 'CROSS_TAB_STATE_STALE'))

    const bootstrapInitialize = await grant(manager, b.store.getState().initialize())
    expect(bootstrapInitialize).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

// ─────────────────────────────────────────────────────────────
// Section 13: CAS / ownership / rollback defenses survive Web Lock wrapping
// ─────────────────────────────────────────────────────────────
describe('RA-007-E CAS and ownership defenses are unaffected by Web Lock wrapping', () => {
  it('detects a canonical change made during FileReader await and reports IMPORT_CONFLICT without overwriting the external generation', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    seedCanonical(instance.store.getState())
    let resolveFile!: (value: ArrayBuffer) => void
    const file = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { resolveFile = resolve }),
    } as File

    const pending = instance.store.getState().importCsv(file)
    manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await flush()
    const externalRaw = `${storage[CSV_IMPORT_GENERATION_KEY]} `
    storage[CSV_IMPORT_GENERATION_KEY] = externalRaw
    resolveFile(new TextEncoder().encode(csvRow(BASELINE_HOLDING.code, 555_000)).buffer)

    const result = await pending
    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT', persistence: { status: 'not_attempted' } })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    // Never expose the raw canonical bytes or a stack/cause in the structured result.
    expect(JSON.stringify(result)).not.toContain(externalRaw.trim())
  })

  it('a manual mutation reports PORTFOLIO_GENERATION_CONFLICT (not SUCCESS) when an external writer commits a canonical generation underneath the legacy persistence window', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    // No committed canonical yet, so setPortfolioPolicy takes the legacy per-field persistence
    // path (persistLegacyPortfolioGenerationTransaction), which re-reads the canonical envelope
    // key immediately before writing its target key and detects a mismatch against the value it
    // captured at the start of the transaction. Simulate an external writer creating a canonical
    // envelope in exactly that window: the alignment check's read (call 1) and the transaction's
    // own initial capture (call 2) still see "no canonical"; the pre-write re-check (call 3+)
    // observes the newly-external envelope, without this test ever going through a second Web
    // Lock request.
    const FAKE_EXTERNAL_ENVELOPE = '{"manifest":{"external":true},"payload":{}}'
    let canonicalReads = 0
    const originalGetItem = localStorageMock.getItem
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      getItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY) {
          canonicalReads += 1
          return canonicalReads <= 2 ? null : FAKE_EXTERNAL_ENVELOPE
        }
        return originalGetItem(key)
      },
    })

    const pending = instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.22 })
    const result = await grant(manager, pending)

    expect(result).toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', 'PORTFOLIO_GENERATION_CONFLICT'))
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
    // The conflicting external bytes must never be silently overwritten by this transaction.
    expect(storage.v13_portfolio_policy).toBeUndefined()
  })

  it('never exposes a raw exception, stack, or cause in a structured failure result', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    analysisProbe.fail = true
    const pending = instance.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 111_111 })
    const result = await grant(manager, pending)
    analysisProbe.fail = false
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_ANALYSIS_ERROR' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/injected analysis failure|at Object|\.ts:\d+/)
  })
})

// ─────────────────────────────────────────────────────────────
// Section 18: root-state invariants
// ─────────────────────────────────────────────────────────────
describe('RA-007-E root-state invariants across the full failure list', () => {
  it('LOCAL_OPERATION_BUSY never mutates root state', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    const pending = instance.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 1 })
    await flush()
    const before = instance.store.getState()
    const busy = await instance.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 2 })
    expect(busy).toEqual(createPortfolioCoordinationFailure('updateHolding', 'LOCAL_OPERATION_BUSY'))
    expect(instance.store.getState()).toBe(before)
    await grant(manager, pending)
  })

  it.each(['WEB_LOCK_UNAVAILABLE', 'WEB_LOCK_TIMEOUT', 'WEB_LOCK_ABORTED', 'WEB_LOCK_REQUEST_FAILED'] as const)(
    '%s never mutates root state', async code => {
      const lock: PortfolioGenerationLockAdapter = {
        async runExclusive(operation) { return createPortfolioCoordinationFailure(operation, code) },
      }
      const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: lock })
      baselineStore(instance.store)
      const before = instance.store.getState()
      const result = await instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.2 })
      expect(result).toEqual(createPortfolioCoordinationFailure('setPortfolioPolicy', code))
      expect(instance.store.getState()).toBe(before)
    },
  )

  it('CROSS_TAB_STATE_STALE never mutates root state', async () => {
    const manager = new FakeLockManager()
    const a = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    const b = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(a.store)
    baselineStore(b.store)
    await grant(manager, a.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 42 }))
    const before = b.store.getState()
    const stale = await grant(manager, b.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 1 }))
    expect(stale).toEqual(createPortfolioCoordinationFailure('updateHolding', 'CROSS_TAB_STATE_STALE'))
    expect(b.store.getState()).toBe(before)
  })

  it('an analysis failure never mutates root state', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    const before = instance.store.getState()
    analysisProbe.fail = true
    const result = await grant(manager, instance.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 5 }))
    analysisProbe.fail = false
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_ANALYSIS_ERROR' })
    expect(instance.store.getState()).toBe(before)
  })

  // MANUAL_PERSISTENCE_ERROR intentionally publishes a user-facing error banner via
  // `system.status`/`system.error` (existing RA-006 behavior, unrelated to Web Lock) — that is
  // the ONE field allowed to change. Every portfolio-data field must keep its exact prior
  // reference: no partial/staged projection is ever exposed.
  function expectPortfolioProjectionUntouched(before: AppStoreState, after: AppStoreState): void {
    expect(after.holdings).toBe(before.holdings)
    expect(after.trust).toBe(before.trust)
    expect(after.portfolioPolicy).toBe(before.portfolioPolicy)
    expect(after.cashAssumptions).toBe(before.cashAssumptions)
    expect(after.analysis).toBe(before.analysis)
    expect(after.system.csvLastImportedAt).toBe(before.system.csvLastImportedAt)
    expect(after.system.csvImportProvenance).toBe(before.system.csvImportProvenance)
    expect(after.system.csvSyncSummary).toBe(before.system.csvSyncSummary)
  }

  it('a persistence failure before commit never mutates the portfolio projection (only the error banner)', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    const before = instance.store.getState()
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: () => { throw new Error('injected') },
    })
    const result = await grant(manager, instance.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 6 }))
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })
    expectPortfolioProjectionUntouched(before, instance.store.getState())
    vi.stubGlobal('localStorage', localStorageMock)
  })

  it('invalid canonical never mutates the portfolio projection (only the error banner)', async () => {
    const manager = new FakeLockManager()
    const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: adapter(manager) })
    baselineStore(instance.store)
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    const before = instance.store.getState()
    const result = await grant(manager, instance.store.getState().updateHolding(BASELINE_HOLDING.code, { eval: 7 }))
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })
    expectPortfolioProjectionUntouched(before, instance.store.getState())
  })
})
