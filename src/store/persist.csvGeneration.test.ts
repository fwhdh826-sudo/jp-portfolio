import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvSyncSummary, Holding, Trust } from '../types'
import {
  CSV_IMPORT_GENERATION_KEY,
  CsvImportPersistenceError,
  persistCsvImportTransaction,
  restoreCsvImportGeneration,
  restoreCsvImportedAt,
  restoreCsvSyncSummary,
  restoreCsvTrustShortSnapshot,
  restoreLearning,
  restorePortfolio,
  restoreTrust,
  type CsvImportPersistencePayload,
} from './persist'

const LEGACY_KEYS = [
  'v81_portfolio',
  'v81_trust',
  'v10_csv_imported_at',
  'v13_csv_sync_summary',
  'v91_learning',
] as const

function holding(code: string, evalValue: number): Holding {
  return { code, eval: evalValue } as Holding
}

function trust(id: string, evalValue: number): Trust {
  return { id, eval: evalValue } as Trust
}

function summary(importedAt: string): CsvSyncSummary {
  return {
    importedAt,
    stock: { updated: 1, added: 0, removed: 0 },
    trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
  }
}

function payload(label: string): CsvImportPersistencePayload {
  const importedAt = `2026-07-${label === 'old' ? '14' : '15'}T00:00:00.000Z`
  return {
    holdings: [holding(label, label === 'old' ? 100 : 200)],
    trust: [trust(`${label}-fund`, label === 'old' ? 300 : 400)],
    learning: null,
    importedAt,
    syncSummary: summary(importedAt),
    trustShortSnapshot: {
      date: importedAt.slice(0, 10),
      total: label === 'old' ? 300 : 400,
      evalById: { [`${label}-fund`]: label === 'old' ? 300 : 400 },
    },
  }
}

describe('T9-A003: committed CSV generation durability and recovery', () => {
  const store: Record<string, string> = {}
  const storage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
  }

  beforeEach(() => {
    Object.keys(store).forEach(key => delete store[key])
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('clean committed generation hydrates every coordinated field from one envelope', () => {
    const next = payload('new')
    persistCsvImportTransaction(next)

    expect(Object.keys(store)).toEqual([CSV_IMPORT_GENERATION_KEY])
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: next })
    expect(restorePortfolio()).toEqual(next.holdings)
    expect(restoreTrust()).toEqual(next.trust)
    expect(restoreLearning()).toBeNull()
    expect(restoreCsvImportedAt()).toBe(next.importedAt)
    expect(restoreCsvSyncSummary()).toEqual(next.syncSummary)
    expect(restoreCsvTrustShortSnapshot()).toEqual(next.trustShortSnapshot)
  })

  it.each(LEGACY_KEYS)(
    'first/middle/last legacy-key failure trap %s is never touched by strict commit',
    blockedKey => {
      vi.stubGlobal('localStorage', {
        ...storage,
        setItem: (key: string, value: string) => {
          if (key === blockedKey) throw new Error(`legacy write forbidden: ${key}`)
          store[key] = value
        },
      })
      expect(() => persistCsvImportTransaction(payload('new'))).not.toThrow()
      expect(restorePortfolio()).toEqual(payload('new').holdings)
    },
  )

  it('canonical write/commit-marker failure retains the previous committed generation', () => {
    const previous = payload('old')
    persistCsvImportTransaction(previous)
    const previousRaw = store[CSV_IMPORT_GENERATION_KEY]
    vi.stubGlobal('localStorage', {
      ...storage,
      setItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY) throw new Error('commit marker quota failure')
      },
      removeItem: () => { throw new Error('rollback remove failure') },
    })

    expect(() => persistCsvImportTransaction(payload('new'))).toThrow(CsvImportPersistenceError)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(previousRaw)
    expect(restorePortfolio()).toEqual(previous.holdings)
    expect(restoreTrust()).toEqual(previous.trust)
  })

  it('persistent quota failure never invokes rollback set/remove and remains retryable', () => {
    let setCalls = 0
    let removeCalls = 0
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem,
      setItem: () => { setCalls += 1; throw new Error('persistent quota') },
      removeItem: () => { removeCalls += 1; throw new Error('rollback remove') },
    })

    expect(() => persistCsvImportTransaction(payload('new'))).toThrow(CsvImportPersistenceError)
    expect(setCalls).toBe(1)
    expect(removeCalls).toBe(0)
    vi.stubGlobal('localStorage', storage)
    expect(() => persistCsvImportTransaction(payload('new'))).not.toThrow()
  })

  it('serialization/manifest preparation failure leaves the old envelope byte-for-byte intact', () => {
    persistCsvImportTransaction(payload('old'))
    const previousRaw = store[CSV_IMPORT_GENERATION_KEY]
    const cyclic = payload('new') as CsvImportPersistencePayload & { loop?: unknown }
    cyclic.loop = cyclic

    expect(() => persistCsvImportTransaction(cyclic)).toThrow(CsvImportPersistenceError)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(previousRaw)
    expect(restorePortfolio()).toEqual(payload('old').holdings)
  })

  it('storage unavailable and getItem failure fail closed without accepting legacy partial data', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => persistCsvImportTransaction(payload('new'))).toThrow(CsvImportPersistenceError)
    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })

    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => {},
      removeItem: () => {},
    })
    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
    expect(restorePortfolio()).toBeNull()
  })

  it('legacy-only state remains backward compatible, including missing optional keys', () => {
    const old = payload('old')
    store.v81_portfolio = JSON.stringify({ data: old.holdings, savedAt: Date.now() })
    store.v81_trust = JSON.stringify({ data: old.trust, savedAt: Date.now() })
    expect(restoreCsvImportGeneration()).toEqual({ status: 'none' })
    expect(restorePortfolio()).toEqual(old.holdings)
    expect(restoreTrust()).toEqual(old.trust)
    expect(restoreCsvSyncSummary()).toBeNull()
  })

  it.each([
    ['missing commit marker', (raw: any) => { delete raw.manifest.committed }],
    ['uncommitted pending generation', (raw: any) => { raw.manifest.committed = false }],
    ['corrupted manifest schema', (raw: any) => { raw.manifest.schemaVersion = 'unknown' }],
    ['corrupted checksum/payload', (raw: any) => { raw.payload.holdings[0].eval += 1 }],
  ])('%s is invalid and does not fall back to partial legacy keys', (_label, corrupt) => {
    persistCsvImportTransaction(payload('old'))
    const raw = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    corrupt(raw)
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(raw)
    store.v81_portfolio = JSON.stringify({ data: payload('new').holdings, savedAt: Date.now() })
    store.v81_trust = JSON.stringify({ data: payload('old').trust, savedAt: Date.now() })

    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
    expect(restorePortfolio()).toBeNull()
    expect(restoreTrust()).toBeNull()
  })

  it('crash-equivalent before canonical replace ignores orphan prepared data', () => {
    const old = payload('old')
    store.v81_portfolio = JSON.stringify({ data: old.holdings, savedAt: Date.now() })
    store['v13_csv_import_pending_orphan'] = JSON.stringify(payload('new'))
    expect(restoreCsvImportGeneration()).toEqual({ status: 'none' })
    expect(restorePortfolio()).toEqual(old.holdings)
  })

  it('crash-equivalent after canonical replace but before global commit hydrates the new generation', () => {
    const next = payload('new')
    persistCsvImportTransaction(next)
    // No Zustand commit is performed here: this is the process-interruption boundary.
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed' })
    expect(restorePortfolio()).toEqual(next.holdings)
    expect(restoreTrust()).toEqual(next.trust)
    expect(restoreCsvImportedAt()).toBe(next.importedAt)
  })
})
