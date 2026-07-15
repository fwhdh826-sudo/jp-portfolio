import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvSyncSummary, Holding, LearningState, Trust } from '../types'
import {
  CSV_IMPORT_GENERATION_KEY,
  CsvImportCanonicalConflictError,
  CsvImportPersistenceError,
  ownsCsvImportCanonicalBytes,
  persistCsvImportTransaction,
  persistCsvImportedAt,
  persistCsvSyncSummary,
  persistLearning,
  persistPortfolio,
  persistTrust,
  restoreCsvImportGeneration,
  restoreCsvImportedAt,
  restoreCsvSyncSummary,
  restoreCsvTrustShortSnapshot,
  restoreCsvTrustShortSnapshotState,
  rollbackCsvImportTransaction,
  restoreLearning,
  restorePortfolio,
  restoreTrust,
  readCsvImportCanonicalRaw,
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
  return {
    code,
    name: `holding-${code}`,
    eval: evalValue,
    pnlPct: 1,
    currentPrice: 100,
    mu: 0.08,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1,
    sector: 'test',
    target: 0,
    alert: 0,
    lock: false,
    acquiredAt: '2026-01-01',
    mitsu: false,
    ma: true,
    rsi: 50,
    macd: true,
    vol: false,
    mom3m: 0,
    roe: 10,
    per: 15,
    pbr: 1,
    epsG: 5,
    cfOk: true,
    de: 0.5,
    divG: 1,
    score: 50,
    decision: 'HOLD',
    ev: 0,
  }
}

function trust(id: string, evalValue: number): Trust {
  return {
    id,
    name: `trust-${id}`,
    abbr: id,
    account: '特定',
    policy: 'OVERSEAS_LONGTERM',
    eval: evalValue,
    pnlPct: 1,
    dayPct: 0,
    cost: 0.2,
    mu: 0.08,
    sigma: 0.15,
    score: 50,
    signal: 'HOLD',
    ev: 0,
    decision: 'HOLD',
  }
}

function learning(): LearningState {
  const emptyDecision = { count: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0 }
  return {
    lastUpdated: '2026-07-15T00:00:00.000Z',
    baselineCount: 0,
    baseline: [],
    outcomes: [],
    summary: {
      total: 0, wins: 0, losses: 0, flats: 0, accuracy: 0, avgReward: 0,
      byDecision: { BUY: { ...emptyDecision }, HOLD: { ...emptyDecision }, SELL: { ...emptyDecision } },
      driftSignals: [],
    },
    suggestedWeights: { fundamental: 0.3, market: 0.2, technical: 0.2, news: 0.15, quality: 0.1, risk: 0.05 },
  }
}

function checksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
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
    expect(restoreCsvTrustShortSnapshotState()).toEqual({
      status: 'committed',
      snapshot: next.trustShortSnapshot,
    })
  })

  it('tracker canonical status distinguishes absent and present-invalid without legacy ambiguity', () => {
    store.v95_trust_short_snapshot = JSON.stringify(payload('old').trustShortSnapshot)
    expect(restoreCsvTrustShortSnapshotState()).toEqual({ status: 'none', snapshot: null })

    store[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    expect(restoreCsvTrustShortSnapshotState()).toEqual({ status: 'invalid', snapshot: null })
    expect(restoreCsvTrustShortSnapshot()).toBeNull()
  })

  it('tentative canonical replacement rolls back only its own exact bytes', () => {
    persistCsvImportTransaction(payload('old'))
    const oldRaw = store[CSV_IMPORT_GENERATION_KEY]
    const receipt = persistCsvImportTransaction(payload('new'))

    expect(rollbackCsvImportTransaction(receipt)).toBe(true)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(oldRaw)
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: payload('old') })

    const staleReceipt = persistCsvImportTransaction(payload('new'))
    store[CSV_IMPORT_GENERATION_KEY] = oldRaw
    expect(rollbackCsvImportTransaction(staleReceipt)).toBe(false)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(oldRaw)
  })

  describe('canonical exact-byte ownership', () => {
    it('pre-write CAS accepts exact old bytes and exact absence', () => {
      const absentReceipt = persistCsvImportTransaction(payload('old'), 1, null)
      expect(absentReceipt.previousRaw).toBeNull()
      expect(ownsCsvImportCanonicalBytes(absentReceipt)).toBe(true)

      const oldRaw = readCsvImportCanonicalRaw()
      const nextReceipt = persistCsvImportTransaction(payload('new'), 2, oldRaw)
      expect(nextReceipt.previousRaw).toBe(oldRaw)
      expect(ownsCsvImportCanonicalBytes(nextReceipt)).toBe(true)
    })

    it.each([
      ['absent to external valid generation', null, 'valid'],
      ['valid old to different valid generation', 'old', 'valid'],
      ['valid old to corrupt raw', 'old', 'corrupt'],
    ] as const)('pre-write CAS rejects %s without destroying current bytes', (_label, baseline, replacement) => {
      if (baseline === 'old') persistCsvImportTransaction(payload('old'), 10)
      const expected = readCsvImportCanonicalRaw()
      if (replacement === 'valid') persistCsvImportTransaction(payload('new'), 11)
      else store[CSV_IMPORT_GENERATION_KEY] = '{external-corrupt'
      const externalRaw = store[CSV_IMPORT_GENERATION_KEY]

      expect(() => persistCsvImportTransaction(payload('old'), 12, expected))
        .toThrow(CsvImportCanonicalConflictError)
      expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    })

    it('post-write verification rejects every non-exact physical representation', () => {
      const receipt = persistCsvImportTransaction(payload('new'), 20)
      const exact = receipt.committedRaw
      const parsed = JSON.parse(exact) as {
        manifest: { generationId: string; savedAt: number }
        payload: CsvImportPersistencePayload
      }
      expect(ownsCsvImportCanonicalBytes(receipt)).toBe(true)

      const variants: Array<[string, string | null]> = [
        ['different checksum-valid generation', persistCsvImportTransaction(payload('old'), 21).committedRaw],
        ['same payload with generationId changed', JSON.stringify({
          ...parsed,
          manifest: { ...parsed.manifest, generationId: `${parsed.manifest.generationId}-external` },
        })],
        ['same payload with savedAt changed', JSON.stringify({
          ...parsed,
          manifest: { ...parsed.manifest, savedAt: parsed.manifest.savedAt + 1 },
        })],
        ['same payload with property order changed', JSON.stringify({
          payload: parsed.payload,
          manifest: parsed.manifest,
        })],
        ['malformed external raw', '{malformed'],
        ['canonical removed', null],
      ]

      for (const [, raw] of variants) {
        if (raw === null) delete store[CSV_IMPORT_GENERATION_KEY]
        else store[CSV_IMPORT_GENERATION_KEY] = raw
        expect(ownsCsvImportCanonicalBytes(receipt)).toBe(false)
      }
    })

    it('post-write verification fails closed when canonical read is inaccessible or throws repeatedly', () => {
      const receipt = persistCsvImportTransaction(payload('new'), 30)
      vi.stubGlobal('localStorage', {
        ...storage,
        getItem: () => { throw new Error('storage inaccessible') },
      })
      expect(ownsCsvImportCanonicalBytes(receipt)).toBe(false)
      expect(ownsCsvImportCanonicalBytes(receipt)).toBe(false)
      expect(() => readCsvImportCanonicalRaw()).toThrow(CsvImportPersistenceError)
    })

    it('rollback restores/removes only owned bytes and is idempotently safe after ownership loss', () => {
      persistCsvImportTransaction(payload('old'), 40)
      const oldRaw = store[CSV_IMPORT_GENERATION_KEY]
      const owned = persistCsvImportTransaction(payload('new'), 41)
      expect(rollbackCsvImportTransaction(owned)).toBe(true)
      expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(oldRaw)
      expect(rollbackCsvImportTransaction(owned)).toBe(false)

      delete store[CSV_IMPORT_GENERATION_KEY]
      const created = persistCsvImportTransaction(payload('new'), 42, null)
      expect(rollbackCsvImportTransaction(created)).toBe(true)
      expect(store[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()

      const overwritten = persistCsvImportTransaction(payload('new'), 43, null)
      persistCsvImportTransaction(payload('old'), 44, overwritten.committedRaw)
      const externalRaw = store[CSV_IMPORT_GENERATION_KEY]
      expect(rollbackCsvImportTransaction(overwritten)).toBe(false)
      expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
      expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: payload('old') })

      const deleted = persistCsvImportTransaction(payload('new'), 45, externalRaw)
      delete store[CSV_IMPORT_GENERATION_KEY]
      expect(rollbackCsvImportTransaction(deleted)).toBe(false)
      expect(store[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
      expect(restoreCsvImportGeneration()).toEqual({ status: 'none' })
    })

    it.each(['setItem', 'removeItem'] as const)('rollback %s failure is reported without claiming success', operation => {
      if (operation === 'setItem') persistCsvImportTransaction(payload('old'), 50)
      const receipt = persistCsvImportTransaction(payload('new'), 51)
      vi.stubGlobal('localStorage', {
        ...storage,
        setItem: operation === 'setItem'
          ? () => { throw new Error('rollback set failed') }
          : storage.setItem,
        removeItem: operation === 'removeItem'
          ? () => { throw new Error('rollback remove failed') }
          : storage.removeItem,
      })
      expect(rollbackCsvImportTransaction(receipt)).toBe(false)
    })
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

  it.each([
    ['holdings [null]', (value: any) => { value.holdings = [null] }],
    ['holdings [{}]', (value: any) => { value.holdings = [{}] }],
    ['trust [null]', (value: any) => { value.trust = [null] }],
    ['trust [{}]', (value: any) => { value.trust = [{}] }],
    ['syncSummary {}', (value: any) => { value.syncSummary = {} }],
    ['learning malformed', (value: any) => { value.learning = { baseline: [null] } }],
    ['invalid importedAt', (value: any) => { value.importedAt = 'not-a-timestamp' }],
    ['invalid trust snapshot', (value: any) => { value.trustShortSnapshot.evalById = { fund: 'NaN' } }],
    ['required nested field missing', (value: any) => { delete value.syncSummary.trust.unknownFunds }],
    ['wrong scalar type', (value: any) => { value.holdings[0].eval = '200' }],
    ['non-finite JSON representation', (value: any) => { value.trust[0].sigma = null }],
    ['extra malformed nested object', (value: any) => { value.syncSummary.unexpected = { rows: [null] } }],
  ])('R3: checksum-valid semantic-invalid payload (%s) is rejected', (_label, mutate) => {
    persistCsvImportTransaction(payload('old'))
    const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    mutate(envelope.payload)
    envelope.manifest.payloadChecksum = checksum(JSON.stringify(envelope.payload))
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)
    store.v81_portfolio = JSON.stringify({ data: payload('new').holdings, savedAt: Date.now() })

    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
    expect(restorePortfolio()).toBeNull()
    expect(restoreTrust()).toBeNull()
    expect(restoreLearning()).toBeNull()
    expect(restoreCsvImportedAt()).toBeNull()
    expect(restoreCsvSyncSummary()).toBeNull()
  })

  it.each([
    ['persistPortfolio', () => persistPortfolio(payload('new').holdings)],
    ['persistTrust', () => persistTrust(payload('new').trust)],
    ['persistLearning', () => persistLearning(learning())],
    ['persistCsvImportedAt', () => persistCsvImportedAt(payload('new').importedAt)],
    ['persistCsvSyncSummary', () => persistCsvSyncSummary(payload('new').syncSummary)],
  ])('R4: %s cannot partially rewrite a committed canonical generation', (_label, persistOneField) => {
    const old = payload('old')
    persistCsvImportTransaction(old)
    const canonicalBefore = store[CSV_IMPORT_GENERATION_KEY]

    persistOneField()

    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: old })
    expect(restorePortfolio()).toEqual(old.holdings)
    expect(restoreTrust()).toEqual(old.trust)
    expect(restoreCsvImportedAt()).toBe(old.importedAt)
    expect(restoreCsvSyncSummary()).toEqual(old.syncSummary)
  })
})
