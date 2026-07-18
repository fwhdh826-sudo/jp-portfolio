import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, CsvSyncSummary, Holding, LearningState, Trust } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { computeCanonicalPortfolioGenerationIdentity } from '../utils/snapshotGenerationIdentity'
import {
  CSV_IMPORT_GENERATION_KEY,
  CsvImportCanonicalConflictError,
  CsvImportPersistenceError,
  CsvImportPersistenceIndeterminateError,
  ownsCsvImportCanonicalBytes,
  persistCsvImportTransaction,
  persistCsvImportedAt,
  persistCsvSyncSummary,
  persistLearning,
  persistCashAssumptions,
  persistPortfolio,
  persistPortfolioPolicy,
  persistTrust,
  restoreCsvImportGeneration,
  restoreCsvImportedAt,
  restoreCsvSyncSummary,
  restoreCsvTrustShortSnapshot,
  restoreCsvTrustShortSnapshotState,
  rollbackCsvImportTransaction,
  restoreLearning,
  restoreCashAssumptions,
  restorePortfolio,
  restorePortfolioPolicy,
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

function v3Payload(label: string, origin: 'csv' | 'snapshot' = 'csv'): CsvImportPersistencePayload {
  return {
    ...payload(label),
    portfolioPolicy: { jpStockMaxRatio: 0.12 },
    cashAssumptions: {
      cashDeposits: 1_000_000,
      standbyFunds: 250_000,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-15T01:00:00.000Z',
    },
    origin,
  }
}

function v4Payload(
  label: string,
  origin: 'csv' | 'snapshot' | null = 'csv',
  csvImportedAt: string | null = `2026-07-${label === 'old' ? '14' : '15'}T00:00:00.000Z`,
): any {
  const legacyBase = v3Payload(label, origin === 'snapshot' ? 'snapshot' : 'csv')
  const base = {
    holdings: legacyBase.holdings,
    trust: legacyBase.trust,
    learning: legacyBase.learning,
    csvImportedAt,
    provenance: csvImportedAt === null ? null : provenance(csvImportedAt),
    syncSummary: origin === 'snapshot' ? null : csvImportedAt === null ? null : summary(csvImportedAt),
    trustShortSnapshot: legacyBase.trustShortSnapshot,
    portfolioPolicy: legacyBase.portfolioPolicy!,
    cashAssumptions: legacyBase.cashAssumptions!,
    origin,
    snapshotTransferIdentity: origin === 'snapshot' ? `sha256:${'ab'.repeat(32)}` : null,
  }
  return {
    ...base,
    snapshotGenerationIdentity: computeCanonicalPortfolioGenerationIdentity({
      holdings: base.holdings,
      trust: base.trust,
      learning: base.learning,
      portfolioPolicy: base.portfolioPolicy,
      cashAssumptions: base.cashAssumptions,
      csvImportedAt: base.csvImportedAt,
      csvImportProvenance: base.provenance,
      syncSummary: base.syncSummary,
      trustShortSnapshot: base.trustShortSnapshot,
      origin: base.origin,
      snapshotTransferIdentity: base.snapshotTransferIdentity,
    }),
  }
}

function persistedV4(input: CsvImportPersistencePayload): Record<string, unknown> {
  const base = {
    holdings: input.holdings,
    trust: input.trust,
    learning: input.learning,
    csvImportedAt: input.csvImportedAt ?? input.importedAt ?? null,
    provenance: input.provenance ?? null,
    syncSummary: input.syncSummary,
    trustShortSnapshot: input.trustShortSnapshot,
    portfolioPolicy: input.portfolioPolicy ?? DEFAULT_PORTFOLIO_POLICY,
    cashAssumptions: input.cashAssumptions ?? DEFAULT_CASH_ASSUMPTIONS,
    origin: input.origin ?? null,
    snapshotTransferIdentity: input.snapshotTransferIdentity ?? null,
  }
  return {
    ...base,
    snapshotGenerationIdentity: computeCanonicalPortfolioGenerationIdentity({
      holdings: base.holdings,
      trust: base.trust,
      learning: base.learning,
      portfolioPolicy: base.portfolioPolicy,
      cashAssumptions: base.cashAssumptions,
      csvImportedAt: base.csvImportedAt,
      csvImportProvenance: base.provenance,
      syncSummary: base.syncSummary,
      trustShortSnapshot: base.trustShortSnapshot,
      origin: base.origin,
      snapshotTransferIdentity: base.snapshotTransferIdentity,
    }),
  }
}

function writeCanonical(
  target: Record<string, string>,
  schemaVersion: string,
  canonicalPayload: CsvImportPersistencePayload,
): string {
  const serializedPayload = JSON.stringify(canonicalPayload)
  const raw = JSON.stringify({
    manifest: {
      schemaVersion,
      generationId: `test-${schemaVersion}`,
      savedAt: Date.parse('2026-07-15T03:00:00.000Z'),
      committed: true,
      payloadChecksum: checksum(serializedPayload),
    },
    payload: canonicalPayload,
  })
  target[CSV_IMPORT_GENERATION_KEY] = raw
  return raw
}

function provenance(importedAt: string): CsvImportProvenance {
  return {
    importedAt,
    sourceAsOf: '2026-07-15T00:00:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${'12'.repeat(32)}`,
    contentFingerprint: 'fnv1a32:12345678',
    sourceFileName: 'portfolio.csv',
    fileLastModified: '2026-07-15T01:00:00.000Z',
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
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: persistedV4(next) })
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

  it('T9-A004-R3-FIX-A: a snapshot caller forward-saves policy, cash, origin, and provenance as v4', () => {
    const next = payload('new')
    next.provenance = provenance(next.importedAt!)
    next.portfolioPolicy = { jpStockMaxRatio: 0.12 }
    next.cashAssumptions = {
      cashDeposits: 1_000_000,
      standbyFunds: 250_000,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-15T01:00:00.000Z',
    }
    next.origin = 'snapshot'
    next.syncSummary = null

    persistCsvImportTransaction(next, Date.parse('2026-07-15T03:00:00.000Z'))

    const physical = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    expect(physical.manifest.schemaVersion).toBe('csv-import-generation-4')
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: {
        provenance: next.provenance,
        portfolioPolicy: next.portfolioPolicy,
        cashAssumptions: next.cashAssumptions,
        origin: 'snapshot',
      },
    })
  })

  it.each([
    ['snapshot without CSV time', v4Payload('new', 'snapshot', null)],
    ['snapshot with CSV time', v4Payload('new', 'snapshot')],
    ['CSV generation', v4Payload('new', 'csv')],
  ])('T9-A004-R3-FIX-A: v4 %s round-trips exact metadata semantics', (_label, next) => {
    persistCsvImportTransaction(next, Date.parse('2026-07-16T03:00:00.000Z'))

    const physical = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    expect(physical.manifest.schemaVersion).toBe('csv-import-generation-4')
    expect(physical.payload).toEqual(next)
    expect(restoreCsvImportedAt()).toBe(next.csvImportedAt)
    expect(restoreCsvSyncSummary()).toEqual(next.syncSummary)
  })

  it.each([
    'csv-import-generation-1',
    'csv-import-generation-2',
    'csv-import-generation-3',
  ])('T9-A004-R3-FIX-A: %s read compatibility preserves physical bytes and next save alone migrates to v4', schemaVersion => {
    const legacy = schemaVersion === 'csv-import-generation-3' ? v3Payload('old') : payload('old')
    if (schemaVersion === 'csv-import-generation-3') legacy.provenance = null
    if (schemaVersion === 'csv-import-generation-2') legacy.provenance = provenance(legacy.importedAt!)
    const originalRaw = writeCanonical(store, schemaVersion, legacy)

    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed' })
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(originalRaw)
    expect(restoreCsvImportedAt()).toBe(legacy.importedAt)
    expect(restoreCsvSyncSummary()).toEqual(legacy.syncSummary)

    const next = v4Payload('new', 'csv')
    persistCsvImportTransaction(next, 2, originalRaw)
    expect(JSON.parse(store[CSV_IMPORT_GENERATION_KEY]).manifest.schemaVersion).toBe('csv-import-generation-4')
  })

  it.each([
    ['missing csvImportedAt', (value: any) => { delete value.csvImportedAt }],
    ['invalid origin', (value: any) => { value.origin = 'manual' }],
    ['extra payload key', (value: any) => { value.unexpected = true }],
    ['missing syncSummary', (value: any) => { delete value.syncSummary }],
    ['missing provenance', (value: any) => { delete value.provenance }],
    ['missing generation identity', (value: any) => { delete value.snapshotGenerationIdentity }],
    ['null-invalid policy', (value: any) => { value.portfolioPolicy = null }],
    ['null-invalid cash', (value: any) => { value.cashAssumptions = null }],
    ['invalid nullable field', (value: any) => { value.csvImportedAt = 0 }],
    ['invalid identity', (value: any) => { value.snapshotGenerationIdentity = 'fnv1a32:12345678' }],
    ['invalid transfer identity', (value: any) => { value.snapshotTransferIdentity = 'fnv1a32:12345678' }],
    ['identity does not bind changed holdings', (value: any) => { value.holdings[0].eval += 1 }],
    ['identity does not bind changed learning', (value: any) => { value.learning = learning() }],
    ['identity does not bind changed trust-short baseline', (value: any) => { value.trustShortSnapshot.total += 1 }],
  ])('T9-A004-R3-FIX-A: checksum-valid malformed v4 payload (%s) fails closed', (_label, mutate) => {
    const next = v4Payload('new', 'snapshot')
    mutate(next)
    writeCanonical(store, 'csv-import-generation-4', next)
    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
  })

  it.each([
    ['CSV without csvImportedAt', (value: any) => { value.csvImportedAt = null; value.provenance = null; value.syncSummary = null }],
    ['CSV without summary', (value: any) => { value.syncSummary = null }],
    ['summary from another generation', (value: any) => { value.syncSummary.importedAt = '2026-07-01T00:00:00.000Z' }],
    ['provenance from another generation', (value: any) => { value.provenance.importedAt = '2026-07-01T00:00:00.000Z' }],
    ['snapshot carrying CSV summary', (value: any) => { value.origin = 'snapshot' }],
  ])('T9-A004-R3-FIX-A: v4 origin/time/summary coherence rejects %s', (_label, mutate) => {
    const next = v4Payload('new', 'csv')
    mutate(next)
    writeCanonical(store, 'csv-import-generation-4', next)
    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
  })

  it('T9-A004-R1: existing FNV-only v2 canonical remains reload-compatible', () => {
    const next = payload('new')
    next.provenance = provenance(next.importedAt!)
    delete next.provenance.semanticIdentity
    const originalRaw = writeCanonical(store, 'csv-import-generation-2', next)

    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { provenance: { contentFingerprint: 'fnv1a32:12345678' } },
    })
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(originalRaw)
  })

  it('T9-A004-R1: a coordinated replacement migrates legacy v2 to persisted strong identity', () => {
    const legacy = payload('old')
    legacy.provenance = provenance(legacy.importedAt!)
    delete legacy.provenance.semanticIdentity
    const legacyRaw = writeCanonical(store, 'csv-import-generation-2', legacy)

    const next = payload('new')
    next.provenance = provenance(next.importedAt!)
    persistCsvImportTransaction(next, 2, legacyRaw)

    const physical = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    expect(physical.manifest.schemaVersion).toBe('csv-import-generation-4')
    expect(physical.payload).toMatchObject({
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
      cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
      origin: null,
    })
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { provenance: { semanticIdentity: `sha256:${'12'.repeat(32)}` } },
    })
  })

  it('T9-A004: checksum-valid v1 canonical without provenance remains reload-compatible', () => {
    const legacyPayload = payload('old')
    const serializedPayload = JSON.stringify(legacyPayload)
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify({
      manifest: {
        schemaVersion: 'csv-import-generation-1',
        generationId: 'legacy-generation',
        savedAt: Date.parse('2026-07-14T00:00:00.000Z'),
        committed: true,
        payloadChecksum: checksum(serializedPayload),
      },
      payload: legacyPayload,
    })

    const restored = restoreCsvImportGeneration()
    expect(restored).toMatchObject({ status: 'committed', generationId: 'legacy-generation' })
    if (restored.status !== 'committed') throw new Error('expected legacy committed generation')
    expect(restored.payload.provenance).toBeUndefined()
    expect(restorePortfolio()).toEqual(legacyPayload.holdings)
    expect(restoreTrust()).toEqual(legacyPayload.trust)
  })

  it('T9-A004-R3-FIX-A: the next coordinated replacement explicitly migrates v1 to v4', () => {
    const legacyPayload = payload('old')
    const serializedPayload = JSON.stringify(legacyPayload)
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify({
      manifest: {
        schemaVersion: 'csv-import-generation-1',
        generationId: 'legacy-generation',
        savedAt: 1,
        committed: true,
        payloadChecksum: checksum(serializedPayload),
      },
      payload: legacyPayload,
    })
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected legacy committed generation')

    persistCsvImportTransaction({ ...restored.payload, provenance: null }, 2, store[CSV_IMPORT_GENERATION_KEY])

    const migrated = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    expect(migrated.manifest.schemaVersion).toBe('csv-import-generation-4')
    expect(migrated.payload.provenance).toBeNull()
    expect(migrated.payload).toMatchObject({
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
      cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
      origin: null,
    })
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed' })
  })

  it.each([
    ['missing portfolioPolicy', (value: any) => { delete value.portfolioPolicy }],
    ['null portfolioPolicy', (value: any) => { value.portfolioPolicy = null }],
    ['missing cashAssumptions', (value: any) => { delete value.cashAssumptions }],
    ['null cashAssumptions', (value: any) => { value.cashAssumptions = null }],
    ['missing origin', (value: any) => { delete value.origin }],
    ['invalid origin', (value: any) => { value.origin = 'manual' }],
    ['malformed policy range', (value: any) => { value.portfolioPolicy.jpStockMaxRatio = 0.31 }],
    ['extra policy key', (value: any) => { value.portfolioPolicy.unexpected = true }],
    ['malformed cash scalar', (value: any) => { value.cashAssumptions.cashDeposits = '100' }],
    ['malformed cash timestamp', (value: any) => { value.cashAssumptions.manualUpdatedAt = '2026-02-30' }],
    ['missing nested cash key', (value: any) => { delete value.cashAssumptions.standbyFunds }],
    ['extra cash key', (value: any) => { value.cashAssumptions.unexpected = true }],
    ['extra payload key', (value: any) => { value.unexpected = true }],
  ])('T9-A004-R3b: checksum-valid malformed v3 payload (%s) fails closed', (_label, mutate) => {
    persistCsvImportTransaction(v3Payload('new'))
    const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    mutate(envelope.payload)
    envelope.manifest.payloadChecksum = checksum(JSON.stringify(envelope.payload))
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)

    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
    expect(restorePortfolioPolicy()).toBeNull()
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('T9-A004-R3b: v3 canonical policy/cash override contradictory legacy mirrors', () => {
    const canonical = v3Payload('new')
    persistCsvImportTransaction(canonical)
    persistPortfolioPolicy({ jpStockMaxRatio: 0.15 })
    persistCashAssumptions({
      cashDeposits: 9,
      standbyFunds: 8,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-10T00:00:00.000Z',
    })

    expect(restorePortfolioPolicy()).toEqual(canonical.portfolioPolicy)
    expect(restoreCashAssumptions()).toEqual(canonical.cashAssumptions)
  })

  it('T9-A004-R3b: legacy policy/cash are used only when canonical is absent', () => {
    const legacyPolicy = { jpStockMaxRatio: 0.15 }
    const legacyCash = {
      cashDeposits: 9,
      standbyFunds: 8,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-10T00:00:00.000Z',
    }
    persistPortfolioPolicy(legacyPolicy)
    persistCashAssumptions(legacyCash)
    expect(restorePortfolioPolicy()).toEqual(legacyPolicy)
    expect(restoreCashAssumptions()).toEqual(legacyCash)

    store[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    expect(restorePortfolioPolicy()).toBeNull()
    expect(restoreCashAssumptions()).toBeNull()
  })

  it.each(['csv-import-generation-1', 'csv-import-generation-2'])(
    'T9-A004-R3b: %s canonical does not mix legacy policy/cash and reading preserves exact bytes',
    schemaVersion => {
      const legacyPayload = payload('old')
      if (schemaVersion === 'csv-import-generation-2') legacyPayload.provenance = null
      const originalRaw = writeCanonical(store, schemaVersion, legacyPayload)
      persistPortfolioPolicy({ jpStockMaxRatio: 0.15 })
      persistCashAssumptions({
        cashDeposits: 9,
        standbyFunds: 8,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-10T00:00:00.000Z',
      })

      expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed' })
      expect(restorePortfolioPolicy()).toBeNull()
      expect(restoreCashAssumptions()).toBeNull()
      expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(originalRaw)
    },
  )

  it.each([
    ['missing provenance key', (value: any) => { delete value.provenance }],
    ['invalid source timestamp', (value: any) => { value.provenance.sourceAsOf = 'not-a-date' }],
    ['invalid fingerprint', (value: any) => { value.provenance.contentFingerprint = 'raw-hash' }],
    ['invalid semantic identity', (value: any) => { value.provenance.semanticIdentity = 'fnv1a32:12345678' }],
    ['unknown confidence', (value: any) => { value.provenance.sourceAsOfConfidence = 'certain' }],
    ['kind/confidence mismatch', (value: any) => { value.provenance.sourceAsOfKind = 'filename' }],
    ['importedAt mismatch', (value: any) => { value.provenance.importedAt = '2026-07-01T00:00:00.000Z' }],
    ['unknown provenance key', (value: any) => { value.provenance.unexpected = true }],
  ])('T9-A004: checksum-valid malformed v2 provenance (%s) fails closed', (_label, mutate) => {
    const next = payload('new')
    next.provenance = provenance(next.importedAt!)
    persistCsvImportTransaction(next)
    const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    mutate(envelope.payload)
    envelope.manifest.payloadChecksum = checksum(JSON.stringify(envelope.payload))
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)

    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
    expect(restorePortfolio()).toBeNull()
    expect(restoreTrust()).toBeNull()
  })

  it.each([
    ['sourceAsOf', '2026-02-30'],
    ['sourceAsOf leap day', '2025-02-29'],
    ['sourceAsOf month', '2026-13-01'],
    ['sourceAsOf hour', '2026-07-15T25:00:00Z'],
  ])('T9-A004-R1: checksum-valid v2 canonical rejects impossible %s', (_label, invalid) => {
    const next = payload('new')
    next.provenance = provenance(next.importedAt!)
    persistCsvImportTransaction(next)
    const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    envelope.payload.provenance.sourceAsOf = invalid
    envelope.manifest.payloadChecksum = checksum(JSON.stringify(envelope.payload))
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)

    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
  })

  it.each(['2026-02-30', '2025-02-29', '2026-07-15T09:00:00'])(
    'T9-A004-R1: checksum-valid v2 canonical rejects invalid importedAt %s',
    invalid => {
      const next = payload('new')
      next.provenance = provenance(next.importedAt!)
      persistCsvImportTransaction(next)
      const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
      envelope.payload.importedAt = invalid
      envelope.payload.syncSummary.importedAt = invalid
      envelope.payload.provenance.importedAt = invalid
      envelope.manifest.payloadChecksum = checksum(JSON.stringify(envelope.payload))
      store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)

      expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
    },
  )

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
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: persistedV4(payload('old')) })

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
      expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: persistedV4(payload('old')) })

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

  it('R4-A001 / FIXC-RA-F2: write-then-throw後に第三者bytesを観測した場合はrollback_failedとなり第三者bytesを破壊しない', () => {
    persistCsvImportTransaction(payload('old'))
    const previousRaw = store[CSV_IMPORT_GENERATION_KEY]
    const thirdPartyRaw = JSON.stringify({ owner: 'third-party', generation: 'external' })
    let attemptedEnvelope: string | null = null
    const setItem = vi.fn((key: string, value: string) => {
      attemptedEnvelope = value
      store[key] = thirdPartyRaw
      throw new Error('write completion notification failed after external replacement')
    })
    const removeItem = vi.fn((key: string) => { delete store[key] })
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem,
      setItem,
      removeItem,
    })

    let caught: unknown = null
    try { persistCsvImportTransaction(payload('new')) } catch (error) { caught = error }

    expect(caught).toBeInstanceOf(CsvImportPersistenceError)
    expect(caught).not.toBeInstanceOf(CsvImportPersistenceIndeterminateError)
    expect(caught).toMatchObject({ status: 'rollback_failed' })
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(removeItem).not.toHaveBeenCalled()
    expect(attemptedEnvelope).toBeTypeOf('string')
    expect(thirdPartyRaw).not.toBe(previousRaw)
    expect(thirdPartyRaw).not.toBe(attemptedEnvelope)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(thirdPartyRaw)
    expect(store[CSV_IMPORT_GENERATION_KEY]).not.toBe(previousRaw)
    expect(store[CSV_IMPORT_GENERATION_KEY]).not.toBe(attemptedEnvelope)

    // Third-party ownership detection must be the terminal operation: no rollback write/remove.
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(removeItem).toHaveBeenCalledTimes(0)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(thirdPartyRaw)
  })

  it('R3-FIX-C RA-001: durable write followed by an unreadable commit check is indeterminate and never rolls back', () => {
    let canonicalSetCalls = 0
    let removeCalls = 0
    let failCommitCheck = false
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY && failCommitCheck) {
          failCommitCheck = false
          throw new Error('raw commit-check read failure')
        }
        return store[key] ?? null
      },
      setItem: (key: string, value: string) => {
        canonicalSetCalls += 1
        store[key] = value
        failCommitCheck = true
        throw new Error('raw completion notification failure')
      },
      removeItem: () => { removeCalls += 1 },
    })

    let caught: unknown = null
    try { persistCsvImportTransaction(payload('new')) } catch (error) { caught = error }

    expect(caught).toMatchObject({
      name: 'CsvImportPersistenceIndeterminateError',
      status: 'indeterminate',
      message: '保存結果を確認できません。再読み込みして状態を確認してください。',
    })
    expect(canonicalSetCalls).toBe(1)
    expect(removeCalls).toBe(0)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBeTypeOf('string')
    vi.stubGlobal('localStorage', storage)
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { holdings: payload('new').holdings },
    })
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
    ['persistCsvImportedAt', () => persistCsvImportedAt(payload('new').importedAt!)],
    ['persistCsvSyncSummary', () => persistCsvSyncSummary(payload('new').syncSummary!)],
  ])('R4: %s cannot partially rewrite a committed canonical generation', (_label, persistOneField) => {
    const old = payload('old')
    persistCsvImportTransaction(old)
    const canonicalBefore = store[CSV_IMPORT_GENERATION_KEY]

    persistOneField()

    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed', payload: persistedV4(old) })
    expect(restorePortfolio()).toEqual(old.holdings)
    expect(restoreTrust()).toEqual(old.trust)
    expect(restoreCsvImportedAt()).toBe(old.importedAt)
    expect(restoreCsvSyncSummary()).toEqual(old.syncSummary)
  })

  it.each([
    ['persistPortfolio', () => persistPortfolio(payload('new').holdings)],
    ['persistTrust', () => persistTrust(payload('new').trust)],
    ['persistLearning', () => persistLearning(learning())],
    ['persistCsvImportedAt', () => persistCsvImportedAt(payload('new').importedAt!)],
    ['persistCsvSyncSummary', () => persistCsvSyncSummary(payload('new').syncSummary!)],
    ['persistPortfolioPolicy', () => persistPortfolioPolicy({ jpStockMaxRatio: 0.15 })],
    ['persistCashAssumptions', () => persistCashAssumptions({
      cashDeposits: 9,
      standbyFunds: 8,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-15T01:00:00.000Z',
    })],
  ])('R3-FIX-C RA-004: %s performs no legacy write while canonical is present-invalid', (_label, persistLegacy) => {
    store[CSV_IMPORT_GENERATION_KEY] = '{present-invalid'
    const before = { ...store }
    let writes = 0
    vi.stubGlobal('localStorage', {
      ...storage,
      setItem: (key: string, value: string) => {
        writes += 1
        store[key] = value
      },
    })

    persistLegacy()

    expect(writes).toBe(0)
    expect(store).toEqual(before)
  })
})
