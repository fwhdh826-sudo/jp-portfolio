import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { resetPortfolioGenerationLockAdapterForTest, setPortfolioGenerationLockAdapterForTest } from './useAppStore'

beforeEach(() => setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest()))
afterEach(() => resetPortfolioGenerationLockAdapterForTest())
import type { CsvImportProvenance, Holding } from '../types'
import { CSV_IMPORT_GENERATION_KEY, persistCsvImportTransaction } from './persist'
import { useAppStore } from './useAppStore'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'

function makeHolding(evalValue: number): Holding {
  return {
    code: 'R2-TEST', name: 'R2テスト銘柄', eval: evalValue, pnlPct: 0,
    mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1, sector: 'テスト',
    target: 0, alert: 0, lock: false, mitsu: false, ma: false, rsi: 50,
    macd: false, vol: false, mom3m: 0, roe: 0, per: 0, pbr: 0, epsG: 0,
    cfOk: false, de: 0, divG: 0, score: 0, decision: 'HOLD', ev: 0,
  }
}

function provenance(overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return {
    importedAt: '2026-07-15T10:00:00.000Z',
    sourceAsOf: '2026-07-15T09:00:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${'1'.repeat(64)}`,
    contentFingerprint: 'fnv1a32:11111111',
    sourceFileName: 'current.csv',
    fileLastModified: '2026-07-15T09:30:00.000Z',
    ...overrides,
  }
}

function legacyV2Snapshot(csvImportedAt: string | null): string {
  return JSON.stringify({
    schemaVersion: 'portfolio-snapshot-2',
    exportedAt: '2099-12-31T23:59:59.000Z',
    csvImportedAt,
    source: 'manual',
    holdings: [{ code: 'R2-TEST', name: 'R2テスト銘柄', eval: 100_000, pnlPct: 0 }],
    trust: [],
    portfolioPolicy: null,
    cashAssumptions: null,
  })
}

function v3Snapshot(
  csvImportProvenance: CsvImportProvenance | null,
  overrides: Record<string, unknown> = {},
): string {
  const payload: Record<string, unknown> = {
    schemaVersion: 'portfolio-snapshot-3',
    exportedAt: '2099-12-31T23:59:59.000Z',
    csvImportedAt: csvImportProvenance?.importedAt ?? null,
    csvImportProvenance,
    source: 'manual',
    holdings: [{ code: 'R2-TEST', name: 'R2テスト銘柄', eval: 100_000, pnlPct: 0 }],
    trust: [],
    portfolioPolicy: null,
    cashAssumptions: null,
    ...overrides,
  }
  payload.snapshotGenerationIdentity = computeSnapshotGenerationIdentity({
    holdings: payload.holdings as any,
    trust: payload.trust as any,
    portfolioPolicy: payload.portfolioPolicy as any,
    cashAssumptions: payload.cashAssumptions as any,
    csvImportedAt: payload.csvImportedAt as string | null,
    csvImportProvenance: payload.csvImportProvenance as CsvImportProvenance | null,
  })
  return JSON.stringify(payload)
}

describe('T9-A004-R2: portfolio snapshot provenance action contract', () => {
  const storage: Record<string, string> = {}
  let storageWrites = 0

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key]
    // T9-A004-R3d以降、present-invalidなcanonical（旧: 'canonical-before' sentinel）は
    // 全importをfail-closedさせる。R2契約はcanonical absent（store側evidenceのみ）を
    // baselineに固定する。canonical present時の判定契約はsnapshotImportAtomic.r3d側。
    storage.v95_trust_short_snapshot = 'tracker-before'
    storageWrites = 0
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => { storageWrites += 1; storage[key] = value },
      removeItem: (key: string) => { storageWrites += 1; delete storage[key] },
    })
    const currentProvenance = provenance()
    useAppStore.setState(state => ({
      holdings: [makeHolding(200_000)],
      trust: [],
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
      cashAssumptions: {
        cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null,
      },
      system: {
        ...state.system,
        status: 'idle', error: null,
        csvLastImportedAt: currentProvenance.importedAt,
        csvImportProvenance: currentProvenance,
        csvSyncSummary: null,
      },
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it('R2-F1 RED: self-asserted newer provenance cannot authorize content substitution over a non-empty generation', async () => {
    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'3'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:33333333',
      sourceFileName: 'untrusted-newer.csv',
    })
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()

    const result = await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming, {
      holdings: [{ code: 'R2-TEST', name: 'substituted content B', eval: 999_999, pnlPct: 42 }],
    }))
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    expect(useAppStore.getState()).toBe(before)
    expect(storage).toEqual(storageBefore)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('a binding mismatch rejects before all store, subscriber, canonical, tracker, and storage effects', async () => {
    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'4'.repeat(64)}`,
    })
    const validRaw = v3Snapshot(incoming)
    const payload = JSON.parse(validRaw)
    payload.holdings[0].name = 'identity計算後の差し替え'
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = await useAppStore.getState().importPortfolioSnapshot(JSON.stringify(payload))
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT_GENERATION' })
    expect(useAppStore.getState()).toBe(before)
    expect(storage).toEqual(storageBefore)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)

    expect(await useAppStore.getState().importPortfolioSnapshot(validRaw))
      .toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
  })

  it('operation timestamps cannot authorize a legacy/unknown snapshot over authoritative current content', async () => {
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = await useAppStore.getState().importPortfolioSnapshot(
      legacyV2Snapshot('2026-07-15T11:00:00.000Z'),
    )
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.system.csvLastImportedAt).toBe(before.system.csvLastImportedAt)
    expect(after.system.csvImportProvenance).toEqual(before.system.csvImportProvenance)
    expect(after).toBe(before)
    expect(storage).toEqual(storageBefore)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)
  })

  it('an unknown legacy snapshot cannot replace content while retaining authoritative provenance', async () => {
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = await useAppStore.getState().importPortfolioSnapshot(legacyV2Snapshot(null))
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.system.csvImportProvenance).toEqual(before.system.csvImportProvenance)
    expect(after).toBe(before)
    expect(storage).toEqual(storageBefore)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)
  })

  it('an older authoritative v3 snapshot is stale even when import/export operation times are newer', async () => {
    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T08:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
      sourceFileName: 'older-source.csv',
      fileLastModified: '2026-07-15T11:59:00.000Z',
    })
    const raw = v3Snapshot(incoming, {
      holdings: [{ code: 'R2-TEST', name: 'R2テスト銘柄', eval: 100_000, pnlPct: 0 }],
      trust: [], portfolioPolicy: null, cashAssumptions: null,
    })

    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    const result = await useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_STALE' })
    expect(useAppStore.getState().holdings[0]?.eval).toBe(200_000)
    expect(useAppStore.getState()).toBe(before)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)

    const newer = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
    })
    expect(await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(newer)))
      .toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(provenance())
  })

  it('the exact current snapshot generation is a duplicate no-op', async () => {
    useAppStore.setState(state => ({
      cashAssumptions: {
        ...state.cashAssumptions,
        manualOverrideEnabled: true,
      },
    }))
    const incoming = provenance()
    const raw = v3Snapshot(incoming, {
      holdings: [{
        code: 'R2-TEST', name: 'R2テスト銘柄', eval: 200_000, pnlPct: 0,
        sector: 'テスト', mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1,
      }],
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
      cashAssumptions: {
        cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: null,
      },
    })
    const before = useAppStore.getState()
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    const result = await useAppStore.getState().importPortfolioSnapshot(raw)
    const repeated = await useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    expect(result).toEqual({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
    expect(repeated).toEqual({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
    expect(useAppStore.getState()).toBe(before)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('same sourceAsOf plus different strong identity is a conflict with zero side effects', async () => {
    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
    })
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    const result = await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_CONFLICT' })
    expect(useAppStore.getState()).toBe(before)
    expect(storage).toEqual(storageBefore)
    expect(storageWrites).toBe(0)
  })

  it('a newer authoritative snapshot cannot automatically replace a non-empty generation', async () => {
    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
      sourceFileName: 'newer.csv',
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    expect(useAppStore.getState().holdings[0]?.eval).toBe(200_000)
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(provenance())
  })

  it('a blocked replacement leaves coordinated canonical content and provenance byte-for-byte unchanged', async () => {
    const current = provenance()
    const state = useAppStore.getState()
    delete storage[CSV_IMPORT_GENERATION_KEY]
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      importedAt: current.importedAt,
      provenance: current,
      syncSummary: {
        importedAt: current.importedAt,
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: { date: '2026-07-15', total: 200_000, evalById: {} },
    })
    storageWrites = 0

    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE', retryable: false })
    const canonical = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
    expect(canonical.payload.holdings[0].eval).toBe(200_000)
    expect(canonical.payload.provenance).toEqual(current)
  })

  it('current unknown accepts first-known authoritative but rejects unknown-to-unknown replacement', async () => {
    useAppStore.setState(state => ({
      system: { ...state.system, csvImportProvenance: null, csvLastImportedAt: '2026-07-15T10:00:00.000Z' },
    }))
    const beforeUnknown = useAppStore.getState()
    const rejected = await useAppStore.getState().importPortfolioSnapshot(legacyV2Snapshot(null))
    expect(rejected).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    expect(useAppStore.getState()).toBe(beforeUnknown)

    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
    })
    const allowed = await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))
    expect(allowed).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    expect(useAppStore.getState().system.csvImportProvenance).toBeNull()
  })

  it('legacy FNV-only provenance cannot prove a duplicate and remains conflict-safe', async () => {
    const current = provenance()
    delete current.semanticIdentity
    useAppStore.setState(state => ({
      system: { ...state.system, csvImportProvenance: current },
    }))
    const incoming = { ...current, importedAt: '2026-07-15T11:00:00.000Z' }

    const result = await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_CONFLICT' })
    expect(storageWrites).toBe(0)
  })

  it('malformed semanticIdentity rejects and releases the action', async () => {
    const valid = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
    })
    const malformed = JSON.parse(v3Snapshot(valid))
    malformed.csvImportProvenance.semanticIdentity = 'fnv1a32:deadbeef'
    const before = useAppStore.getState()

    const rejected = await useAppStore.getState().importPortfolioSnapshot(JSON.stringify(malformed))
    expect(rejected).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE' })
    expect(useAppStore.getState()).toBe(before)
    expect(storageWrites).toBe(0)

    const retried = await useAppStore.getState().importPortfolioSnapshot(v3Snapshot(valid))
    expect(retried).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(provenance())
  })

  it('a legacy snapshot remains compatible only for a genuinely empty/unknown first generation', async () => {
    useAppStore.setState(state => ({
      holdings: [],
      trust: [],
      cashAssumptions: { ...state.cashAssumptions, manualOverrideEnabled: false },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))

    const result = await useAppStore.getState().importPortfolioSnapshot(legacyV2Snapshot(null))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings[0]?.eval).toBe(100_000)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
    expect(useAppStore.getState().system.csvImportProvenance).toBeNull()
  })

  it('a valid bound v3 imports into a truly empty generation and exact retry is deterministic duplicate', async () => {
    useAppStore.setState(state => ({
      holdings: [],
      trust: [],
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
      cashAssumptions: {
        cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null,
      },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))
    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'5'.repeat(64)}`,
    })
    const raw = v3Snapshot(incoming, {
      holdings: [{ code: 'NEW', name: '新規 📈', eval: 123_456, pnlPct: 1.5 }],
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 500_000, standbyFunds: 200_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-07-15T10:30:00.000Z',
      },
    })

    expect(await useAppStore.getState().importPortfolioSnapshot(raw))
      .toMatchObject({ ok: true, code: 'SUCCESS' })
    const afterSuccess = useAppStore.getState()
    const storageAfterSuccess = { ...storage }
    storageWrites = 0
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    const retry = await useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    expect(retry).toEqual({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
    expect(useAppStore.getState()).toBe(afterSuccess)
    expect(storage).toEqual(storageAfterSuccess)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)
  })
})
