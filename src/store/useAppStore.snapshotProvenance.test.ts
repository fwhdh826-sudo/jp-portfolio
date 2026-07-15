import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, Holding } from '../types'
import { CSV_IMPORT_GENERATION_KEY, persistCsvImportTransaction } from './persist'
import { useAppStore } from './useAppStore'

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
  return JSON.stringify({
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
  })
}

describe('T9-A004-R2: portfolio snapshot provenance action contract', () => {
  const storage: Record<string, string> = {}
  let storageWrites = 0

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key]
    storage.v13_csv_import_committed_generation = 'canonical-before'
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

  it('operation timestamps cannot authorize a legacy/unknown snapshot over authoritative current content', () => {
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = useAppStore.getState().importPortfolioSnapshot(
      legacyV2Snapshot('2099-12-31T23:59:58.000Z'),
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

  it('an unknown legacy snapshot cannot replace content while retaining authoritative provenance', () => {
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = useAppStore.getState().importPortfolioSnapshot(legacyV2Snapshot(null))
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

  it('an older authoritative v3 snapshot is stale even when import/export operation times are newer', () => {
    const incoming = provenance({
      importedAt: '2099-12-31T23:59:58.000Z',
      sourceAsOf: '2026-07-15T08:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
      sourceFileName: 'older-source.csv',
      fileLastModified: '2099-12-31T23:59:57.000Z',
    })
    const raw = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-3',
      exportedAt: '2099-12-31T23:59:59.000Z',
      csvImportedAt: incoming.importedAt,
      csvImportProvenance: incoming,
      source: 'manual',
      holdings: [{ code: 'R2-TEST', name: 'R2テスト銘柄', eval: 100_000, pnlPct: 0 }],
      trust: [], portfolioPolicy: null, cashAssumptions: null,
    })

    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    const result = useAppStore.getState().importPortfolioSnapshot(raw)
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
    expect(useAppStore.getState().importPortfolioSnapshot(v3Snapshot(newer)))
      .toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(newer)
  })

  it('same sourceAsOf plus same strong identity is a duplicate no-op', () => {
    const incoming = provenance({
      importedAt: '2099-12-31T23:59:58.000Z',
      fileLastModified: '2099-12-31T23:59:57.000Z',
    })
    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })
    const result = useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))
    const repeated = useAppStore.getState().importPortfolioSnapshot(v3Snapshot({
      ...incoming,
      importedAt: '2099-12-31T23:59:56.000Z',
    }))
    unsubscribe()

    expect(result).toEqual({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
    expect(repeated).toEqual({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
    expect(useAppStore.getState()).toBe(before)
    expect(storageWrites).toBe(0)
    expect(notifications).toBe(0)
  })

  it('same sourceAsOf plus different strong identity is a conflict with zero side effects', () => {
    const incoming = provenance({
      importedAt: '2099-12-31T23:59:58.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
    })
    const before = useAppStore.getState()
    const storageBefore = { ...storage }
    const result = useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_CONFLICT' })
    expect(useAppStore.getState()).toBe(before)
    expect(storage).toEqual(storageBefore)
    expect(storageWrites).toBe(0)
  })

  it('a newer authoritative snapshot replaces content and provenance from the same generation', () => {
    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:22222222',
      sourceFileName: 'newer.csv',
    })
    const result = useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings[0]?.eval).toBe(100_000)
    expect(useAppStore.getState().system.csvLastImportedAt).toBe(incoming.importedAt)
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(incoming)
    expect(useAppStore.getState().system.csvImportProvenance?.semanticIdentity)
      .not.toBe(provenance().semanticIdentity)
  })

  it('coordinated canonical replacement persists incoming content with incoming provenance, never old provenance', () => {
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
    const result = useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const canonical = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
    expect(canonical.payload.holdings[0].eval).toBe(100_000)
    expect(canonical.payload.provenance).toEqual(incoming)
    expect(canonical.payload.provenance).not.toEqual(current)
  })

  it('current unknown accepts first-known authoritative but rejects unknown-to-unknown replacement', () => {
    useAppStore.setState(state => ({
      system: { ...state.system, csvImportProvenance: null, csvLastImportedAt: '2026-07-15T10:00:00.000Z' },
    }))
    const beforeUnknown = useAppStore.getState()
    const rejected = useAppStore.getState().importPortfolioSnapshot(legacyV2Snapshot(null))
    expect(rejected).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    expect(useAppStore.getState()).toBe(beforeUnknown)

    const incoming = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
    })
    const allowed = useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))
    expect(allowed).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(incoming)
  })

  it('legacy FNV-only provenance cannot prove a duplicate and remains conflict-safe', () => {
    const current = provenance()
    delete current.semanticIdentity
    useAppStore.setState(state => ({
      system: { ...state.system, csvImportProvenance: current },
    }))
    const incoming = { ...current, importedAt: '2026-07-15T11:00:00.000Z' }

    const result = useAppStore.getState().importPortfolioSnapshot(v3Snapshot(incoming))

    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_CONFLICT' })
    expect(storageWrites).toBe(0)
  })

  it('a malformed provenance reject releases the action for a valid retry', () => {
    const valid = provenance({
      importedAt: '2026-07-15T12:00:00.000Z',
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      semanticIdentity: `sha256:${'2'.repeat(64)}`,
    })
    const malformed = JSON.parse(v3Snapshot(valid))
    malformed.csvImportProvenance.semanticIdentity = 'fnv1a32:deadbeef'
    const before = useAppStore.getState()

    const rejected = useAppStore.getState().importPortfolioSnapshot(JSON.stringify(malformed))
    expect(rejected).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE' })
    expect(useAppStore.getState()).toBe(before)
    expect(storageWrites).toBe(0)

    const retried = useAppStore.getState().importPortfolioSnapshot(v3Snapshot(valid))
    expect(retried).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(valid)
  })

  it('a legacy snapshot remains compatible only for a genuinely empty/unknown first generation', () => {
    useAppStore.setState(state => ({
      holdings: [],
      trust: [],
      cashAssumptions: { ...state.cashAssumptions, manualOverrideEnabled: false },
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))

    const result = useAppStore.getState().importPortfolioSnapshot(legacyV2Snapshot(null))

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings[0]?.eval).toBe(100_000)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
    expect(useAppStore.getState().system.csvImportProvenance).toBeNull()
  })
})
