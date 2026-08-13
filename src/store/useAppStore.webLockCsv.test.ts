import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
} from './portfolioGenerationLock'
import { createPortfolioCoordinationFailure } from './portfolioOperationResult'
import { FakeLockManager } from './testing/fakeLockManager'
import { createAppStoreInstanceForTest, type AppStoreState } from './useAppStore'

const NOW_MS = Date.parse('2026-07-20T03:00:00.000Z')
const storage: Record<string, string> = {}
const storageCounts = { get: 0, set: 0, remove: 0 }
let fileReaderStarts = 0

class CountingFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File) {
    fileReaderStarts += 1
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

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

const HOLDING: Holding = {
  code: '1001', name: '銘柄1001', eval: 100_000, pnlPct: 1, mu: 0.08, sigma: 0.2,
  sigmaSource: 'static', beta: 1, sector: 'テスト', target: 0, alert: 0,
  lock: false, mitsu: false, ma: true, rsi: 50, macd: true, vol: false, mom3m: 0,
  roe: 10, per: 15, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 1,
  score: 50, decision: 'HOLD', ev: 0,
}

const TRUST: Trust = {
  id: 'fund-1', name: 'テスト投信', abbr: 'テスト', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 200_000, pnlPct: 2, dayPct: 0, cost: 0.2,
  mu: 0.08, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0, decision: 'HOLD',
}

const CSV = [
  'データ基準日時,2026-07-20T11:00:00+09:00',
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  'テスト投信,10000,250000,5.00,0.10,',
].join('\n')

function csvFile(content = CSV): File {
  return new File([content], 'portfolio.csv', { type: 'text/csv' })
}

function adapter(manager: FakeLockManager): PortfolioGenerationLockAdapter {
  return createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 60_000 })
}

function immediateAdapter(
  onRequest: (operation: string) => void = () => undefined,
): PortfolioGenerationLockAdapter {
  return {
    async runExclusive(operation, callback) {
      onRequest(operation)
      return { ok: true, value: await callback() }
    },
  }
}

function baseline(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [{ ...HOLDING }],
    trust: [{ ...TRUST }],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system,
      status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function instanceWith(lock: PortfolioGenerationLockAdapter) {
  const instance = createAppStoreInstanceForTest({ portfolioGenerationLock: lock })
  baseline(instance.store)
  return instance
}

function pair(manager = new FakeLockManager()) {
  return {
    manager,
    a: instanceWith(adapter(manager)),
    b: instanceWith(adapter(manager)),
  }
}

function seedCanonical(state: AppStoreState, overrides: Partial<Pick<
  AppStoreState,
  'holdings' | 'trust' | 'portfolioPolicy' | 'cashAssumptions'
>> & Partial<{
  csvImportedAt: string | null
  provenance: AppStoreState['system']['csvImportProvenance']
  syncSummary: AppStoreState['system']['csvSyncSummary']
}> = {}): void {
  persistCsvImportTransaction({
    holdings: overrides.holdings ?? state.holdings,
    trust: overrides.trust ?? state.trust,
    learning: state.learning,
    csvImportedAt: overrides.csvImportedAt ?? null,
    provenance: overrides.provenance ?? null,
    syncSummary: overrides.syncSummary ?? null,
    trustShortSnapshot: { date: '2026-07-20', total: 0, evalById: {} },
    portfolioPolicy: overrides.portfolioPolicy ?? state.portfolioPolicy,
    cashAssumptions: overrides.cashAssumptions ?? state.cashAssumptions,
    origin: 'snapshot',
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

function emptyStore(store: ReturnType<typeof createAppStoreInstanceForTest>['store']): void {
  store.setState(state => ({
    holdings: [], trust: [], portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    system: {
      ...state.system, status: 'idle', error: null, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
    },
  }))
}

function snapshotRaw(): string {
  const source = instanceWith(immediateAdapter())
  source.store.setState(state => ({
    holdings: [{ ...HOLDING, code: 'SNAPSHOT', name: 'snapshot' }],
    trust: [],
    system: {
      ...state.system, csvLastImportedAt: null,
      csvImportProvenance: null, csvSyncSummary: null,
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', CountingFileReader)
  Object.keys(storage).forEach(key => delete storage[key])
  storageCounts.get = 0
  storageCounts.set = 0
  storageCounts.remove = 0
  fileReaderStarts = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RA-007-D1 CSV Web Lock grant boundary', () => {
  it('holds the local ticket for the entire queued wait', async () => {
    const manager = new FakeLockManager()
    const instance = instanceWith(adapter(manager))
    const pending = instance.store.getState().importCsv(csvFile())
    expect(instance.controls.inspect().activeOperationKind).toBe('csv')
    await expect(grant(manager, pending)).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
  })

  it('requests exact importCsv and performs no state/storage/FileReader/transaction work before grant while holding the local ticket', async () => {
    const manager = new FakeLockManager()
    const instance = instanceWith(adapter(manager))
    const action = instance.store.getState().importCsv
    const root = instance.store.getState()
    let holdingsReads = 0
    const holdings = root.holdings
    Object.defineProperty(root, 'holdings', {
      configurable: true,
      get: () => { holdingsReads += 1; return holdings },
    })

    const pending = action(csvFile())
    expect(manager.requests).toHaveLength(1)
    expect(manager.requests[0]?.name).toBe(PORTFOLIO_GENERATION_LOCK_NAME)
    expect(instance.controls.inspect()).toMatchObject({
      activeOperationKind: 'csv',
      activeGenerationOrigin: null,
      activeGenerationPhase: null,
    })
    expect({ holdingsReads, storageCounts: { ...storageCounts }, fileReaderStarts }).toEqual({
      holdingsReads: 0,
      storageCounts: { get: 0, set: 0, remove: 0 },
      fileReaderStarts: 0,
    })

    const duplicate = await action(csvFile())
    expect(duplicate).toEqual(createPortfolioCoordinationFailure('importCsv', 'LOCAL_OPERATION_BUSY'))
    expect(manager.requests).toHaveLength(1)

    await expect(grant(manager, pending)).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(holdingsReads).toBeGreaterThan(0)
    expect(fileReaderStarts).toBe(1)
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
  })

  it('creates the CSV transaction only after grant and holds the lock through READING', async () => {
    const manager = new FakeLockManager()
    const instance = instanceWith(adapter(manager))
    let resolveFile!: (value: ArrayBuffer) => void
    const file = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { resolveFile = resolve }),
    } as File
    const pending = instance.store.getState().importCsv(file)
    expect(instance.controls.inspect().activeGenerationOrigin).toBeNull()
    manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)
    await flush()
    expect(instance.controls.inspect()).toMatchObject({
      activeOperationKind: 'csv', activeGenerationOrigin: 'csv', activeGenerationPhase: 'READING',
    })
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
    resolveFile(new TextEncoder().encode(CSV).buffer)
    await expect(pending).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(false)
  })
})

describe('RA-007-D1 CSV FIFO and cross-operation stale policy', () => {
  it('serializes CSV to CSV FIFO: A succeeds and queued B is stale without reading its file', async () => {
    const { manager, a, b } = pair()
    const aPromise = a.store.getState().importCsv(csvFile())
    const bPromise = b.store.getState().importCsv(csvFile(CSV.replace('150000', '175000')))
    expect(manager.pendingWaiterIds(PORTFOLIO_GENERATION_LOCK_NAME)).toEqual([1, 2])
    expect(await grant(manager, aPromise)).toMatchObject({ ok: true, code: 'SUCCESS' })
    const readsAfterA = fileReaderStarts
    expect(await grant(manager, bPromise)).toEqual(
      createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE'),
    )
    expect(fileReaderStarts).toBe(readsAfterA)
    expect(manager.events.filter(event => event.type === 'granted').map(event => event.waiterId))
      .toEqual([1, 2])
  })

  it('manual to CSV and CSV to manual both serialize and reject the stale second store', async () => {
    const first = pair()
    const manual = first.a.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    const csv = first.b.store.getState().importCsv(csvFile())
    expect(await grant(first.manager, manual)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(await grant(first.manager, csv)).toEqual(
      createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE'),
    )

    Object.keys(storage).forEach(key => delete storage[key])
    const second = pair()
    const csvFirst = second.a.store.getState().importCsv(csvFile())
    const manualSecond = second.b.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    expect(await grant(second.manager, csvFirst)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(await grant(second.manager, manualSecond)).toEqual(
      createPortfolioCoordinationFailure('setPortfolioPolicy', 'CROSS_TAB_STATE_STALE'),
    )
  })

  it('snapshot to CSV and CSV to snapshot both serialize and reject the stale second store', async () => {
    const first = pair()
    emptyStore(first.a.store)
    const snapshot = first.a.store.getState().importPortfolioSnapshot(snapshotRaw())
    const csv = first.b.store.getState().importCsv(csvFile())
    expect(await grant(first.manager, snapshot)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(await grant(first.manager, csv)).toEqual(
      createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE'),
    )

    Object.keys(storage).forEach(key => delete storage[key])
    const second = pair()
    const csvFirst = second.a.store.getState().importCsv(csvFile())
    const snapshotSecond = second.b.store.getState().importPortfolioSnapshot(snapshotRaw())
    expect(await grant(second.manager, csvFirst)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(await grant(second.manager, snapshotSecond)).toEqual(
      createPortfolioCoordinationFailure('importPortfolioSnapshot', 'CROSS_TAB_STATE_STALE'),
    )
  })

  it('a no-write CSV failure releases the lock and lets the queued aligned CSV continue', async () => {
    const { manager, a, b } = pair()
    const failed = a.store.getState().importCsv(csvFile(''))
    const queued = b.store.getState().importCsv(csvFile())
    expect(await grant(manager, failed)).toMatchObject({ ok: false, code: 'NO_VALID_ROWS' })
    expect(await grant(manager, queued)).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

describe('RA-007-D1 lock lifetime and coordination classification', () => {
  it('keeps Web Lock and local ticket through the final synchronous subscriber and blocks nested CSV without another request', async () => {
    const manager = new FakeLockManager()
    const instance = instanceWith(adapter(manager))
    let heldInSubscriber = false
    let ownerInSubscriber: string | null = null
    let nested: Promise<unknown> | null = null
    let nestedManual: Promise<unknown> | null = null
    instance.store.subscribe(state => {
      if (state.system.status !== 'success' || nested) return
      heldInSubscriber = manager.isHeld(PORTFOLIO_GENERATION_LOCK_NAME)
      ownerInSubscriber = instance.controls.inspect().activeOperationKind
      nested = state.importCsv(csvFile())
      nestedManual = state.setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    })
    const outer = instance.store.getState().importCsv(csvFile())
    await expect(grant(manager, outer)).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect({ heldInSubscriber, ownerInSubscriber, requests: manager.requests.length }).toEqual({
      heldInSubscriber: true, ownerInSubscriber: 'csv', requests: 1,
    })
    await expect(nested).resolves.toEqual(
      createPortfolioCoordinationFailure('importCsv', 'LOCAL_OPERATION_BUSY'),
    )
    await expect(nestedManual).resolves.toEqual(
      createPortfolioCoordinationFailure('setPortfolioPolicy', 'LOCAL_OPERATION_BUSY'),
    )
  })

  it.each([
    ['WEB_LOCK_UNAVAILABLE', false],
    ['WEB_LOCK_ABORTED', true],
    ['WEB_LOCK_REQUEST_FAILED', true],
  ] as const)('returns %s without fallback and releases the ticket', async (code, retryable) => {
    let callbackCalls = 0
    const lock: PortfolioGenerationLockAdapter = {
      async runExclusive(operation) {
        return createPortfolioCoordinationFailure(operation, code)
      },
    }
    const instance = instanceWith(lock)
    const before = { ...storageCounts }
    const result = await instance.store.getState().importCsv(csvFile())
    expect(result).toEqual({ ok: false, operation: 'importCsv', code, retryable })
    expect({ callbackCalls, fileReaderStarts, storageCounts }).toEqual({
      callbackCalls: 0, fileReaderStarts: 0, storageCounts: before,
    })
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
  })

  it('classifies a real pending timeout and permits a later retry', async () => {
    const manager = new FakeLockManager()
    const timed = createPortfolioGenerationLockAdapter({ lockManager: manager, timeoutMs: 10 })
    const instance = instanceWith(timed)
    const pending = instance.store.getState().importCsv(csvFile())
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toEqual(
      createPortfolioCoordinationFailure('importCsv', 'WEB_LOCK_TIMEOUT'),
    )
    expect(instance.controls.inspect().activeOperationKind).toBeNull()
    instance.store.setState(instance.store.getState())

    const retryManager = new FakeLockManager()
    const retry = instanceWith(adapter(retryManager))
    await expect(grant(retryManager, retry.store.getState().importCsv(csvFile())))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('RA-007-D2: also activates the same injected Web Lock for initialize and refreshAllData', async () => {
    const operations: string[] = []
    const instance = instanceWith(immediateAdapter(operation => operations.push(operation)))
    const initializeResult = await instance.store.getState().initialize()
    const refreshResult = await instance.store.getState().refreshAllData()
    expect(operations).toEqual(['initialize', 'refreshAllData'])
    expect(initializeResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(refreshResult).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

describe('RA-007-D1 durable alignment classifications', () => {
  it('allows a first import with no durable evidence', async () => {
    const instance = instanceWith(immediateAdapter())
    await expect(instance.store.getState().importCsv(csvFile()))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('classifies present-invalid canonical as CSV_CANONICAL_INVALID, not stale', async () => {
    storage[CSV_IMPORT_GENERATION_KEY] = '{invalid'
    const instance = instanceWith(immediateAdapter())
    await expect(instance.store.getState().importCsv(csvFile())).resolves.toMatchObject({
      ok: false, code: 'CSV_CANONICAL_INVALID',
    })
    expect(fileReaderStarts).toBe(0)
  })

  it('keeps existing transaction CAS conflict classification when canonical changes during FileReader', async () => {
    const instance = instanceWith(immediateAdapter())
    seedCanonical(instance.store.getState())
    let resolveFile!: (value: ArrayBuffer) => void
    const file = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { resolveFile = resolve }),
    } as File
    const pending = instance.store.getState().importCsv(file)
    await flush()
    const previousRaw = storage[CSV_IMPORT_GENERATION_KEY]
    storage[CSV_IMPORT_GENERATION_KEY] = `${previousRaw} `
    resolveFile(new TextEncoder().encode(CSV).buffer)
    await expect(pending).resolves.toMatchObject({
      ok: false, code: 'IMPORT_CONFLICT', persistence: { status: 'not_attempted' },
    })
  })

  it.each([
    ['holdings', (state: AppStoreState) => ({ holdings: [{ ...state.holdings[0]!, eval: 999_000 }] })],
    ['trust', (state: AppStoreState) => ({ trust: [{ ...state.trust[0]!, eval: 999_000 }] })],
    ['portfolioPolicy', (_state: AppStoreState) => ({ portfolioPolicy: { jpStockMaxRatio: 0.15 } })],
    ['cashAssumptions', (state: AppStoreState) => ({ cashAssumptions: {
      ...state.cashAssumptions,
      source: 'MANUAL' as const,
      grossCash: 999_000,
      updatedAt: '2026-07-10T00:00:00.000Z',
    } })],
  ] as const)('detects stale %s projection before FileReader or write', async (_field, mutate) => {
    const instance = instanceWith(immediateAdapter())
    seedCanonical(instance.store.getState(), mutate(instance.store.getState()))
    storageCounts.set = 0
    const rootBefore = instance.store.getState()
    let notifications = 0
    const unsubscribe = instance.store.subscribe(() => { notifications += 1 })
    const result = await instance.store.getState().importCsv(csvFile())
    unsubscribe()
    expect(result).toEqual(createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE'))
    expect({ fileReaderStarts, writes: storageCounts.set, notifications }).toEqual({
      fileReaderStarts: 0, writes: 0, notifications: 0,
    })
    expect(instance.store.getState()).toBe(rootBefore)
  })

  it.each(['csvLastImportedAt', 'csvImportProvenance', 'csvSyncSummary'] as const)(
    'detects stale %s metadata projection before FileReader or write',
    async field => {
      const instance = instanceWith(immediateAdapter())
      await expect(instance.store.getState().importCsv(csvFile()))
        .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
      instance.store.setState(state => ({
        system: {
          ...state.system,
          csvLastImportedAt: field === 'csvLastImportedAt'
            ? '2026-07-20T02:00:00.000Z'
            : state.system.csvLastImportedAt,
          csvImportProvenance: field === 'csvImportProvenance' && state.system.csvImportProvenance
            ? { ...state.system.csvImportProvenance, contentFingerprint: 'fnv1a32:87654321' }
            : state.system.csvImportProvenance,
          csvSyncSummary: field === 'csvSyncSummary' && state.system.csvSyncSummary
            ? {
                ...state.system.csvSyncSummary,
                stock: { ...state.system.csvSyncSummary.stock, updated: 2 },
              }
            : state.system.csvSyncSummary,
        },
      }))
      storageCounts.set = 0
      fileReaderStarts = 0
      const result = await instance.store.getState().importCsv(csvFile())
      expect(result).toEqual(createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE'))
      expect({ fileReaderStarts, writes: storageCounts.set }).toEqual({ fileReaderStarts: 0, writes: 0 })
    },
  )

  it.each([
    ['expired', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
    ['future', '2026-07-21T00:00:00.000Z', '2026-07-22T00:00:00.000Z'],
  ] as const)('normalizes different %s metadata on both sides and permits aligned content', async (_case, localAt, durableAt) => {
    const instance = instanceWith(immediateAdapter())
    instance.store.setState(state => ({
      system: { ...state.system, csvLastImportedAt: localAt },
    }))
    seedCanonical(instance.store.getState(), { csvImportedAt: durableAt })
    await expect(instance.store.getState().importCsv(csvFile()))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('ignores derived-only differences when the durable portfolio projection is aligned', async () => {
    const instance = instanceWith(immediateAdapter())
    seedCanonical(instance.store.getState())
    instance.store.setState(state => ({
      system: { ...state.system, status: 'error', error: 'derived-only' },
    }))
    await expect(instance.store.getState().importCsv(csvFile()))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('rejects unsafe partial legacy evidence without transaction, read, write, or publish', async () => {
    storage.v81_portfolio = JSON.stringify({ holdings: [HOLDING], savedAt: NOW_MS })
    const instance = instanceWith(immediateAdapter())
    storageCounts.set = 0
    const rootBefore = instance.store.getState()
    const result = await rootBefore.importCsv(csvFile())
    expect(result).toEqual(createPortfolioCoordinationFailure('importCsv', 'CROSS_TAB_STATE_STALE'))
    expect({ fileReaderStarts, writes: storageCounts.set, phase: instance.controls.inspect().activeGenerationPhase })
      .toEqual({ fileReaderStarts: 0, writes: 0, phase: null })
    expect(instance.store.getState()).toBe(rootBefore)
  })
})
