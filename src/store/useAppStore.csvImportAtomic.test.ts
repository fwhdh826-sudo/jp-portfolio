import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { resetPortfolioGenerationLockAdapterForTest, setPortfolioGenerationLockAdapterForTest } from './useAppStore'

beforeEach(() => setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest()))
afterEach(() => resetPortfolioGenerationLockAdapterForTest())
import type { Holding, Trust } from '../types'
import type { HoldingEvidenceArtifact } from '../types/holdingEvidence'
import {
  computeCanonicalPortfolioGenerationIdentity,
  computeCanonicalPortfolioGenerationIdentityV2,
} from '../utils/snapshotGenerationIdentity'
import { runFullAnalysis, useAppStore } from './useAppStore'
import { csvImportFeedback } from '../components/tabs/T9_Settings'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
  restoreCsvImportGeneration,
  restoreCsvImportedAt,
  restoreCsvSyncSummary,
  restoreLearning,
  restorePortfolio,
  restoreTrust,
} from './persist'

class TestFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File) {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const originalFileReader = globalThis.FileReader
const baseMarket = useAppStore.getState().market
const baseSafeMode = useAppStore.getState().safeMode
const baseCashAssumptions = useAppStore.getState().cashAssumptions
const baseCandidatesNews = useAppStore.getState().candidatesNews
const baseCandidatesStocks = useAppStore.getState().candidatesStocks
const baseRegimeState = useAppStore.getState().regimeState

function holding(code = '1001', evalValue = 100_000): Holding {
  return {
    code,
    name: `銘柄${code}`,
    eval: evalValue,
    pnlPct: 1,
    mu: 0.08,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1,
    sector: 'テスト',
    target: 0,
    alert: 0,
    lock: false,
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

/**
 * 弱い指標を authoritative な published evidence として与える holding_evidence
 * artifact。persisted metadataStatus=known は R1 以降 runtime authority として
 * 生存しないため、legitimate な SELL を得るには fresh な evidence が必要。
 */
function weakHoldingEvidence(code: string, generatedAtMs: number): HoldingEvidenceArtifact {
  const iso = (ms: number) => new Date(ms).toISOString()
  const present = (v: number | boolean) => ({ v, status: 'present' as const })
  return {
    schemaVersion: 'holding-evidence-1',
    not_for_trading: true,
    _meta: {
      kind: 'holding_evidence',
      schemaVersion: 'holding-evidence-1',
      generatedAt: iso(generatedAtMs - 60 * 60 * 1000),
      not_for_trading: true,
    },
    entries: [{
      code, ticker: `${code}.T`, market: 'TSE',
      fundamentals: {
        asOf: iso(generatedAtMs - 24 * 60 * 60 * 1000), source: 'test',
        fields: {
          roe: present(1), per: present(120), pbr: present(9),
          epsG: present(-35), cfOk: present(false), de: present(9), divG: present(0),
        },
      },
      technicals: {
        asOf: iso(generatedAtMs - 60 * 60 * 1000), source: 'test', bars: 120,
        fields: {
          ma: present(false), rsi: present(82), macd: present(false),
          vol: present(false), mom3m: present(-25),
        },
      },
    }],
  }
}

function trust(): Trust {
  return {
    id: 'fund-1',
    name: 'テスト投信',
    abbr: 'テスト',
    account: '特定',
    policy: 'OVERSEAS_LONGTERM',
    eval: 200_000,
    pnlPct: 2,
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

function shortTrust(): Trust {
  return { ...trust(), policy: 'JAPAN_SHORTTERM' }
}

const VALID_CSV = [
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  'テスト投信,10000,250000,5.00,0.10,',
].join('\n')

function csvFile(content = VALID_CSV) {
  return new File([content], 'portfolio.csv', { type: 'text/csv' })
}

function csvWithSource(sourceAsOf: string, content = VALID_CSV) {
  return `データ基準日時,${sourceAsOf}\n${content}`
}

function relevantState() {
  const state = useAppStore.getState()
  return {
    holdings: state.holdings,
    trust: state.trust,
    csvLastImportedAt: state.system.csvLastImportedAt,
    csvImportProvenance: state.system.csvImportProvenance,
    csvSyncSummary: state.system.csvSyncSummary,
    analysisLastRunAt: state.system.analysisLastRunAt,
    analysis: state.analysis,
    metrics: state.metrics,
    learning: state.learning,
    universe: state.universe,
    zeroPlan: state.zeroPlan,
    stockPlan: state.stockPlan,
    trustPlan: state.trustPlan,
    officialDecision: state.officialDecision,
    stockCandidates: state.stockCandidates,
    candidatesNews: state.candidatesNews,
    candidatesStocks: state.candidatesStocks,
  }
}

function withoutGeneratedTimestamps<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutGeneratedTimestamps) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) =>
      key === 'generatedAt' || key === 'lastUpdatedAt'
        ? []
        : [[key, withoutGeneratedTimestamps(nested)]],
    )) as T
  }
  return value
}

function canonicalIdentityInput(payload: any) {
  return {
    holdings: payload.holdings,
    trust: payload.trust,
    learning: payload.learning,
    portfolioPolicy: payload.portfolioPolicy,
    cashAssumptions: payload.cashAssumptions,
    csvImportedAt: payload.csvImportedAt,
    csvImportProvenance: payload.provenance,
    syncSummary: payload.syncSummary,
    trustShortSnapshot: payload.trustShortSnapshot,
    origin: payload.origin,
    snapshotTransferIdentity: payload.snapshotTransferIdentity,
  }
}

function canonicalChecksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

describe('T9-A001/A002: structured CSV result and atomic store commit', () => {
  const storage: Record<string, string> = {}
  let storageWriteCount = 0
  let storageRemoveCount = 0
  const storageWriteKeys: string[] = []
  let failStorageWriteAt: number | null = null
  let storageReentry: ((key: string) => void) | null = null
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storageWriteCount += 1
      storageWriteKeys.push(key)
      if (storageWriteCount === failStorageWriteAt) throw new Error('forced quota failure')
      storage[key] = value
      storageReentry?.(key)
    },
    removeItem: (key: string) => { storageRemoveCount += 1; delete storage[key] },
  }

  beforeEach(() => {
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    storageWriteCount = 0
    storageRemoveCount = 0
    storageWriteKeys.length = 0
    failStorageWriteAt = null
    storageReentry = null
    useAppStore.setState(state => ({
      holdings: [holding()],
      trust: [trust()],
      correlation: null,
      market: baseMarket,
      safeMode: baseSafeMode,
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
      cashAssumptions: baseCashAssumptions,
      candidatesNews: baseCandidatesNews,
      candidatesStocks: baseCandidatesStocks,
      regimeState: baseRegimeState,
      learning: null,
      universe: null,
      zeroPlan: null,
      stockPlan: null,
      trustPlan: null,
      stockCandidates: [],
      analysis: [],
      metrics: null,
      officialDecision: null,
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: '2026-07-01T00:00:00.000Z',
        csvImportProvenance: null,
        csvSyncSummary: null,
        // R1-P1-1: CSV importはdataSourceOutcome既知のときだけ'success'を主張する。
        // このsuiteは「取込自体はsuccessになる」ことを前提にしているため明示する。
        dataSourceOutcome: { loaded: 14, total: 14 },
      },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalFileReader) globalThis.FileReader = originalFileReader
  })

  it('valid import returns structured success only after analysis, officialDecision, persistence, and commit', async () => {
    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({
      ok: true,
      analysisCommitted: true,
      officialDecisionCommitted: true,
      persistence: { status: 'committed' },
    })
    if (!result.ok) throw new Error('expected successful import')
    expect(result.imported.stock.updated).toBe(1)
    expect(result.diagnostics).toMatchObject({
      recognizedStockRows: 1,
      recognizedTrustRows: 1,
      matchedTrustRows: 1,
      unknownTrustRows: 0,
      ambiguousTrustRows: 0,
      failedGuard: null,
      committed: true,
    })
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)
    expect(useAppStore.getState().trust[0].eval).toBe(250_000)
    expect(useAppStore.getState().analysis.length).toBeGreaterThan(0)
    expect(useAppStore.getState().officialDecision).not.toBeNull()
    expect(useAppStore.getState().system.csvLastImportedAt).not.toBe('2026-07-01T00:00:00.000Z')

    const state = useAppStore.getState()
    const physical = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY]) as {
      manifest: { generationId: string; schemaVersion: string }
    }
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expect(physical.manifest.generationId).toBe(restored.generationId)
    expect(physical.manifest.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V5)
    expect(restored.payload.snapshotGenerationIdentity).toBe(
      computeCanonicalPortfolioGenerationIdentityV2(canonicalIdentityInput(restored.payload)),
    )
    expect(restored.payload.snapshotGenerationIdentity).not.toBe(
      computeCanonicalPortfolioGenerationIdentity(canonicalIdentityInput(restored.payload)),
    )
    expect(restored.payload.holdings).toEqual(state.holdings)
    expect(restored.payload.trust).toEqual(state.trust)
    expect(restored.payload).not.toHaveProperty('diagnostics')
    expect(restored.payload.learning).toEqual(state.learning)
    expect(restored.payload.csvImportedAt).toBe(state.system.csvLastImportedAt)
    expect(restored.payload.syncSummary?.importedAt).toBe(restored.payload.csvImportedAt)
    expect(state.system.csvSyncSummary?.importedAt).toBe(state.system.csvLastImportedAt)
    expect(restored.payload.portfolioPolicy).toEqual(state.portfolioPolicy)
    expect(restored.payload.cashAssumptions).toEqual(state.cashAssumptions)
    expect(restored.payload.origin).toBe('csv')
    expect(restorePortfolio()).toEqual(state.holdings)
    expect(restoreTrust()).toEqual(state.trust)
    expect(restoreLearning()).toEqual(state.learning)
    expect(restoreCsvImportedAt()).toBe(state.system.csvLastImportedAt)
    expect(restoreCsvSyncSummary()).toEqual(state.system.csvSyncSummary)
  })

  it.each([
    ['2026-07-18T14:59:59.999Z', '2026-07-18'],
    ['2026-07-18T15:00:00.000Z', '2026-07-19'],
  ])('R4-A004b: fresh CSV at %s writes canonical v5 with JST baseline %s', async (now, date) => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const result = await useAppStore.getState().importCsv(csvFile(csvWithSource(
        '2026-07-18T09:00:00+09:00',
      )))
      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      const generation = restoreCsvImportGeneration()
      expect(generation).toMatchObject({
        status: 'committed',
        schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
        payload: { trustShortSnapshot: { date } },
      })
      if (generation.status !== 'committed') throw new Error('expected committed v5 generation')
      expect(generation.payload.snapshotGenerationIdentity).toBe(
        computeCanonicalPortfolioGenerationIdentityV2(canonicalIdentityInput(generation.payload)),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['duplicate', true, 'DUPLICATE_CSV'],
    ['stale', false, 'STALE_CSV'],
    ['conflict', false, 'CSV_PROVENANCE_CONFLICT'],
    ['unknown', false, 'CSV_PROVENANCE_UNKNOWN'],
    ['parse', false, 'NO_VALID_ROWS'],
    ['analysis', false, 'ANALYSIS_ERROR'],
    ['official', false, 'OFFICIAL_DECISION_ERROR'],
    ['persistence', false, 'PERSISTENCE_ERROR'],
  ] as const)('R4-A004c: CSV %s no-migration preserves current v5 raw/schema/generation/savedAt/baseline', async (failureCase, expectedOk, expectedCode) => {
    const currentCsv = csvWithSource('2026-07-15T09:00:00+09:00')
    await expect(useAppStore.getState().importCsv(csvFile(currentCsv)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]
    const envelopeBefore = JSON.parse(canonicalBefore)
    storageWriteCount = 0
    storageRemoveCount = 0
    storageWriteKeys.length = 0

    let candidate: File
    if (failureCase === 'duplicate') {
      candidate = csvFile(currentCsv)
    } else if (failureCase === 'stale') {
      candidate = csvFile(csvWithSource(
        '2026-07-14T09:00:00+09:00',
        VALID_CSV.replace('150000,8.00', '140000,7.00'),
      ))
    } else if (failureCase === 'conflict') {
      candidate = csvFile(csvWithSource(
        '2026-07-15T09:00:00+09:00',
        VALID_CSV.replace('150000,8.00', '151000,8.10'),
      ))
    } else if (failureCase === 'unknown') {
      candidate = new File(
        [VALID_CSV.replace('150000,8.00', '152000,8.20')],
        'portfolio.csv',
        { type: 'text/csv', lastModified: 0 },
      )
    } else if (failureCase === 'parse') {
      candidate = csvFile('')
    } else {
      candidate = csvFile(csvWithSource(
        '2026-07-16T09:00:00+09:00',
        VALID_CSV.replace('150000,8.00', '160000,9.00'),
      ))
      if (failureCase === 'analysis') {
        const currentMarket = useAppStore.getState().market
        useAppStore.setState({
          market: new Proxy(currentMarket, {
            get(target, property) {
              if (property === 'regime') throw new Error('forced A004c analysis failure')
              return Reflect.get(target, property)
            },
          }),
        })
      } else if (failureCase === 'official') {
        const currentSafeMode = useAppStore.getState().safeMode
        useAppStore.setState({
          safeMode: new Proxy(currentSafeMode, {
            get(target, property) {
              if (property === 'safe_mode') throw new Error('forced A004c official failure')
              return Reflect.get(target, property)
            },
          }),
        })
      } else {
        failStorageWriteAt = 1
      }
    }

    const result = await useAppStore.getState().importCsv(candidate)

    expect(result).toMatchObject({ ok: expectedOk, code: expectedCode })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
    const envelopeAfter = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
    expect(envelopeAfter.manifest).toEqual(envelopeBefore.manifest)
    expect(envelopeAfter.payload.trustShortSnapshot).toEqual(envelopeBefore.payload.trustShortSnapshot)
    expect(envelopeAfter.manifest.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V5)
    expect(storageWriteKeys.every(key => key === CSV_IMPORT_GENERATION_KEY)).toBe(true)
    expect(storageRemoveCount).toBe(0)
    for (const legacyKey of [
      'v81_portfolio', 'v81_trust', 'v91_learning', 'v10_csv_imported_at',
      'v13_csv_sync_summary', 'v13_portfolio_policy', 'v13_cash_assumptions',
      'v95_trust_short_snapshot',
    ]) {
      expect(storage[legacyKey]).toBeUndefined()
    }
  })

  it.each([
    'absent',
    'csv-import-generation-1',
    'csv-import-generation-2',
    'csv-import-generation-3',
    'csv-import-generation-4',
    CSV_IMPORT_GENERATION_SCHEMA_V5,
  ] as const)('R4-A004c: newer authoritative CSV migrates current canonical %s to one v5/JST generation', async currentSchema => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-07-19T00:00:00.000Z')
    try {
      const currentImportedAt = '2026-07-10T00:00:00.000Z'
      const currentProvenance = {
        importedAt: currentImportedAt,
        sourceAsOf: '2026-07-10T00:00:00.000Z',
        sourceAsOfKind: 'csv_explicit' as const,
        sourceAsOfConfidence: 'authoritative' as const,
        semanticIdentity: `sha256:${'0'.repeat(64)}`,
        contentFingerprint: 'fnv1a32:00000000',
        sourceFileName: 'current.csv',
        fileLastModified: currentImportedAt,
      }
      const currentSummary = {
        importedAt: currentImportedAt,
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      }
      const state = useAppStore.getState()
      if (currentSchema !== 'absent') {
        useAppStore.setState(current => ({
          system: {
            ...current.system,
            csvLastImportedAt: currentImportedAt,
            csvImportProvenance: currentSchema === 'csv-import-generation-1'
              ? null
              : currentProvenance,
            csvSyncSummary: currentSummary,
          },
        }))
      }
      const legacyBase = {
        holdings: state.holdings,
        trust: state.trust,
        learning: state.learning,
        importedAt: currentImportedAt,
        syncSummary: currentSummary,
        trustShortSnapshot: {
          date: '2026-07-10T00:00:00.000Z',
          total: state.trust.reduce((sum, item) => sum + item.eval, 0),
          evalById: Object.fromEntries(state.trust.map(item => [item.id, item.eval])),
        },
      }
      if (currentSchema !== 'absent') {
        if (currentSchema === 'csv-import-generation-4' || currentSchema === CSV_IMPORT_GENERATION_SCHEMA_V5) {
          persistCsvImportTransaction({
            holdings: state.holdings,
            trust: state.trust,
            learning: state.learning,
            csvImportedAt: currentImportedAt,
            provenance: currentProvenance,
            syncSummary: currentSummary,
            trustShortSnapshot: {
              ...legacyBase.trustShortSnapshot,
              date: '2026-07-10',
            },
            portfolioPolicy: state.portfolioPolicy,
            cashAssumptions: state.cashAssumptions,
            origin: 'csv',
          }, Date.parse('2026-07-10T01:00:00.000Z'), undefined, { schemaVersion: currentSchema })
        } else {
          const payload = currentSchema === 'csv-import-generation-1'
            ? legacyBase
            : currentSchema === 'csv-import-generation-2'
              ? { ...legacyBase, provenance: currentProvenance }
              : {
                  ...legacyBase,
                  provenance: currentProvenance,
                  portfolioPolicy: state.portfolioPolicy,
                  cashAssumptions: state.cashAssumptions,
                  origin: 'csv',
                }
          const serializedPayload = JSON.stringify(payload)
          storage[CSV_IMPORT_GENERATION_KEY] = JSON.stringify({
            manifest: {
              schemaVersion: currentSchema,
              generationId: `seed-${currentSchema}`,
              savedAt: Date.parse('2026-07-10T01:00:00.000Z'),
              committed: true,
              payloadChecksum: canonicalChecksum(serializedPayload),
            },
            payload,
          })
        }
      }
      const previousRaw = storage[CSV_IMPORT_GENERATION_KEY] ?? null
      storageWriteCount = 0
      storageRemoveCount = 0

      const result = await useAppStore.getState().importCsv(csvFile(csvWithSource(
        '2026-07-18T09:00:00+09:00',
      )))

      expect(result).toMatchObject({
        ok: true,
        code: 'SUCCESS',
        persistence: { status: 'committed' },
      })
      expect(storageWriteCount).toBe(1)
      expect(storageRemoveCount).toBe(0)
      expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toBe(previousRaw)
      expect(Object.keys(storage)).toEqual([CSV_IMPORT_GENERATION_KEY])
      const generation = restoreCsvImportGeneration()
      expect(generation).toMatchObject({
        status: 'committed',
        schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
        payload: {
          trustShortSnapshot: { date: '2026-07-19' },
          origin: 'csv',
        },
      })
      if (generation.status !== 'committed') throw new Error('expected migrated v5 generation')
      expect(generation.payload.snapshotGenerationIdentity).toBe(
        computeCanonicalPortfolioGenerationIdentityV2(canonicalIdentityInput(generation.payload)),
      )
      expect(generation.payload.snapshotGenerationIdentity).not.toBe(
        computeCanonicalPortfolioGenerationIdentity(canonicalIdentityInput(generation.payload)),
      )
      expect(generation.payload.holdings).toEqual(useAppStore.getState().holdings)
      expect(generation.payload.trust).toEqual(useAppStore.getState().trust)
      expect(generation.payload.csvImportedAt).toBe(useAppStore.getState().system.csvLastImportedAt)
      for (const legacyKey of [
        'v81_portfolio', 'v81_trust', 'v91_learning', 'v10_csv_imported_at',
        'v13_csv_sync_summary', 'v13_portfolio_policy', 'v13_cash_assumptions',
        'v95_trust_short_snapshot',
      ]) {
        expect(storage[legacyKey]).toBeUndefined()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    '2026-02-30',
    '2025-02-29',
    '2026-07-15T09:00:00',
    '2026-13-01',
    '2026-07-15T25:00:00Z',
  ])('T9-A004-R1-F1: invalid explicit authority %s rejects before analysis, persistence, tracker, and publication', async invalid => {
    const before = relevantState()
    const storageBefore = structuredClone(storage)
    const writesBefore = storageWriteCount
    let portfolioNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings || state.trust !== previous.trust ||
          state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision) {
        portfolioNotifications += 1
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile(csvWithSource(invalid)))
    unsubscribe()

    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID_CSV_SOURCE_TIMESTAMP',
      message: 'CSVのデータ基準日時が不正です。日時を確認し、タイムゾーン付きISO形式または日付形式で再試行してください。状態は変更されていません。',
      analysisCommitted: false,
      officialDecisionCommitted: false,
      persistence: { status: 'not_attempted' },
    })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual(storageBefore)
    expect(storageWriteCount).toBe(writesBefore)
    expect(portfolioNotifications).toBe(0)
    expect(useAppStore.getState().system.status).not.toBe('loading')

    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource(invalid))))
      .resolves.toMatchObject({ ok: false, code: 'INVALID_CSV_SOURCE_TIMESTAMP' })
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-16T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('T9-A004-R1-F1: an invalid explicit rejection releases the lock and does not turn absent metadata into invalid', async () => {
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-02-30'))))
      .resolves.toMatchObject({ ok: false, code: 'INVALID_CSV_SOURCE_TIMESTAMP' })

    const absent = new File([VALID_CSV], 'portfolio.csv', { type: 'text/csv', lastModified: 0 })
    const retry = await useAppStore.getState().importCsv(absent)
    expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
    if (!retry.ok) throw new Error('expected absent-metadata first import to preserve unknown policy')
    expect(retry.provenance).toMatchObject({
      sourceAsOf: null,
      sourceAsOfKind: 'unknown',
      sourceAsOfConfidence: 'unknown',
    })
  })

  it('T9-A004 RED: an explicitly older CSV cannot overwrite a newer committed generation', async () => {
    const newerCsv = [
      'データ基準日時,2026-07-15T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '190000,9.00'),
    ].join('\n')
    const olderCsv = [
      'データ基準日時,2026-07-14T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '110000,1.00'),
    ].join('\n')

    await expect(useAppStore.getState().importCsv(csvFile(newerCsv)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = relevantState()
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]
    const storageBefore = structuredClone(storage)
    let portfolioNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings || state.trust !== previous.trust ||
          state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision) {
        portfolioNotifications += 1
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile(olderCsv))
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'STALE_CSV' })
    expect(relevantState()).toEqual(before)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
    expect(storage).toEqual(storageBefore)
    expect(portfolioNotifications).toBe(0)
    expect(useAppStore.getState().system.status).not.toBe('loading')

    const retry = csvWithSource(
      '2026-07-16T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '210000,10.00'),
    )
    await expect(useAppStore.getState().importCsv(csvFile(retry)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('T9-A004: same source time with different semantic content is a structured conflict', async () => {
    const first = csvWithSource('2026-07-15T09:00:00+09:00')
    const conflict = csvWithSource(
      '2026-07-15T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '175000,8.50'),
    )
    await expect(useAppStore.getState().importCsv(csvFile(first)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const stateBefore = relevantState()
    const storageBefore = structuredClone(storage)

    await expect(useAppStore.getState().importCsv(csvFile(conflict)))
      .resolves.toMatchObject({ ok: false, code: 'CSV_PROVENANCE_CONFLICT' })

    expect(relevantState()).toEqual(stateBefore)
    expect(storage).toEqual(storageBefore)
  })

  it('T9-A004: repeated semantic CSV is a no-op without generation/importedAt/analysis/tracker churn', async () => {
    const repeated = csvWithSource('2026-07-15T09:00:00+09:00')
    await expect(useAppStore.getState().importCsv(csvFile(repeated)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const stateBefore = useAppStore.getState()
    const relevantBefore = relevantState()
    const storageBefore = structuredClone(storage)
    const writesBefore = storageWriteCount
    let portfolioNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings || state.trust !== previous.trust ||
          state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision) {
        portfolioNotifications += 1
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile(repeated))
    unsubscribe()

    expect(result).toMatchObject({
      ok: true,
      code: 'DUPLICATE_CSV',
      analysisCommitted: false,
      persistence: { status: 'not_attempted' },
    })
    expect(relevantState()).toEqual(relevantBefore)
    expect(useAppStore.getState().analysis).toBe(stateBefore.analysis)
    expect(useAppStore.getState().officialDecision).toBe(stateBefore.officialDecision)
    expect(storage).toEqual(storageBefore)
    expect(storageWriteCount).toBe(writesBefore)
    expect(portfolioNotifications).toBe(0)
  })

  it('T9-A004-R1: FNV-only v2 is preserved, fails closed at same time, and migrates on newer authority', async () => {
    const first = csvWithSource('2026-07-15T09:00:00+09:00')
    await expect(useAppStore.getState().importCsv(csvFile(first)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })

    const strongGeneration = restoreCsvImportGeneration()
    if (strongGeneration.status !== 'committed' || !strongGeneration.payload.provenance) {
      throw new Error('expected committed provenance')
    }
    const legacyPayload = structuredClone(strongGeneration.payload)
    delete legacyPayload.provenance?.semanticIdentity
    const strongRaw = storage[CSV_IMPORT_GENERATION_KEY]
    persistCsvImportTransaction(legacyPayload, Date.now(), strongRaw)
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed', payload: { provenance: { contentFingerprint: expect.any(String) } },
    })
    const legacyGeneration = restoreCsvImportGeneration()
    if (legacyGeneration.status !== 'committed') throw new Error('expected legacy v2 generation')
    expect(legacyGeneration.payload.provenance?.semanticIdentity).toBeUndefined()
    useAppStore.setState(state => ({
      system: {
        ...state.system,
        csvImportProvenance: legacyGeneration.payload.provenance ?? null,
      },
    }))

    await expect(useAppStore.getState().importCsv(csvFile(first)))
      .resolves.toMatchObject({ ok: false, code: 'CSV_PROVENANCE_CONFLICT' })

    const newer = csvWithSource('2026-07-16T09:00:00+09:00')
    await expect(useAppStore.getState().importCsv(csvFile(newer)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
      payload: { provenance: { semanticIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) } },
    })
  })

  it('T9-A004: unknown incoming provenance cannot overwrite an authoritative generation', async () => {
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-15T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = relevantState()
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]

    await expect(useAppStore.getState().importCsv(csvFile(VALID_CSV.replace('150000,8.00', '180000,9.00'))))
      .resolves.toMatchObject({ ok: false, code: 'CSV_PROVENANCE_UNKNOWN' })

    expect(relevantState()).toEqual(before)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
  })

  it('T9-A004: authoritative incoming provenance may establish first-known provenance over unknown current', async () => {
    await expect(useAppStore.getState().importCsv(csvFile()))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const next = csvWithSource(
      '2026-07-15T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '180000,9.00'),
    )

    await expect(useAppStore.getState().importCsv(csvFile(next)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvImportProvenance).toMatchObject({
      sourceAsOfKind: 'csv_explicit',
      sourceAsOfConfidence: 'authoritative',
    })
  })

  it('T9-A004: two unknown different CSVs do not use later import operation time as freshness', async () => {
    const unknownFile = (content: string) => new File([content], 'portfolio.csv', {
      type: 'text/csv',
      lastModified: 0,
    })
    await expect(useAppStore.getState().importCsv(unknownFile(VALID_CSV)))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const importedAt = useAppStore.getState().system.csvLastImportedAt

    const nextUnknown = unknownFile(VALID_CSV.replace('150000,8.00', '180000,9.00'))
    await expect(useAppStore.getState().importCsv(nextUnknown))
      .resolves.toMatchObject({ ok: false, code: 'CSV_PROVENANCE_UNKNOWN' })
    expect(useAppStore.getState().system.csvLastImportedAt).toBe(importedAt)

    const confirmed = await useAppStore.getState().importCsv(nextUnknown, { confirmUnknownProvenance: true })
    expect(confirmed).toMatchObject({ ok: true, code: 'SUCCESS' })
    if (!confirmed.ok) throw new Error('expected confirmed import success')
    expect(confirmed.warnings).toContain('CSVデータの基準時刻が不明または参考情報のため、明示確認により取り込みました。')
    expect(useAppStore.getState().holdings[0].eval).toBe(180_000)
  })

  it('T9-A004: a newer filesystem mtime cannot outrank authoritative current provenance', async () => {
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-15T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const weakFile = new File(
      [VALID_CSV.replace('150000,8.00', '180000,9.00')],
      'portfolio.csv',
      { type: 'text/csv', lastModified: Date.parse('2099-01-01T00:00:00.000Z') },
    )

    await expect(useAppStore.getState().importCsv(weakFile))
      .resolves.toMatchObject({ ok: false, code: 'CSV_PROVENANCE_UNKNOWN' })
  })

  it('subscribers observe exactly one portfolio-generation commit, never new holdings with an old decision', async () => {
    const generations: Array<{
      holdingEval: number
      analysisLength: number
      hasOfficialDecision: boolean
    }> = []
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.holdings !== previous.holdings ||
        state.trust !== previous.trust ||
        state.analysis !== previous.analysis ||
        state.officialDecision !== previous.officialDecision
      ) {
        generations.push({
          holdingEval: state.holdings[0]?.eval ?? 0,
          analysisLength: state.analysis.length,
          hasOfficialDecision: state.officialDecision !== null,
        })
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(result.ok).toBe(true)
    expect(generations).toEqual([{
      holdingEval: 150_000,
      analysisLength: 1,
      hasOfficialDecision: true,
    }])
  })

  it('R1: a throwing final-commit subscriber cannot turn a durable published generation into false failure', async () => {
    let laterSubscriberCalls = 0
    const unsubscribeThrowing = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) throw new Error('observer exploded after commit')
    })
    const unsubscribeLater = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) laterSubscriberCalls += 1
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribeThrowing()
    unsubscribeLater()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS', persistence: { status: 'committed' } })
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { holdings: [{ eval: 150_000 }] },
    })
    expect(useAppStore.getState().system.status).toBe('success')
    expect(laterSubscriberCalls).toBe(1)

    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })

  it('R4: manual portfolio actions rebuild the complete canonical payload in one replacement', async () => {
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
    const before = restoreCsvImportGeneration()
    if (before.status !== 'committed') throw new Error('expected committed generation')

    await useAppStore.getState().updateHolding('1001', { eval: 175_000 })
    const afterHolding = restoreCsvImportGeneration()
    if (afterHolding.status !== 'committed') throw new Error('expected committed generation')
    expect(afterHolding.payload.holdings[0].eval).toBe(175_000)
    expect(afterHolding.payload.trust).toEqual(before.payload.trust)
    expect(afterHolding.payload.csvImportedAt).toBe(before.payload.csvImportedAt)
    expect(afterHolding.payload.syncSummary).toEqual(before.payload.syncSummary)

    await useAppStore.getState().updateTrust('fund-1', { eval: 275_000 })
    const afterTrust = restoreCsvImportGeneration()
    if (afterTrust.status !== 'committed') throw new Error('expected committed generation')
    expect(afterTrust.payload.holdings[0].eval).toBe(175_000)
    expect(afterTrust.payload.trust[0].eval).toBe(275_000)
    expect(afterTrust.payload.csvImportedAt).toBe(before.payload.csvImportedAt)
    expect(afterTrust.payload.syncSummary).toEqual(before.payload.syncSummary)

    await useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    const afterPolicy = restoreCsvImportGeneration()
    if (afterPolicy.status !== 'committed') throw new Error('expected committed generation')
    expect(afterPolicy.payload.portfolioPolicy).toEqual({ jpStockMaxRatio: 0.12 })
    expect(afterPolicy.payload.cashAssumptions).toEqual(before.payload.cashAssumptions)
    expect(afterPolicy.payload.origin).toBe('csv')

    await useAppStore.getState().setCashAssumptions({ grossCash: 1_999_999, safetyReserve: 0, pendingOrderCash: null })
    const afterCash = restoreCsvImportGeneration()
    if (afterCash.status !== 'committed') throw new Error('expected committed generation')
    expect(afterCash.payload.portfolioPolicy).toEqual({ jpStockMaxRatio: 0.12 })
    expect(afterCash.payload.cashAssumptions).toMatchObject({
      source: 'MANUAL',
      grossCash: 1_999_999,
      safetyReserve: 0,
      pendingOrderCash: null,
      // CASH-AUTH-1: updatedAt は保存操作時刻で確定する
      updatedAt: expect.any(String),
    })
    expect(afterCash.payload.origin).toBe('csv')
  })

  it('parser/no-valid-rows failure returns NO_VALID_ROWS and leaves all relevant state and persistence unchanged', async () => {
    const before = relevantState()
    const result = await useAppStore.getState().importCsv(csvFile(''))

    expect(result).toMatchObject({ ok: false, code: 'NO_VALID_ROWS', persistence: { status: 'not_attempted' } })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('full-sync guard rejection returns FULL_SYNC_GUARD_REJECTED and commits nothing', async () => {
    useAppStore.setState({ holdings: [holding('1001'), holding('1002'), holding('1003')] })
    const before = relevantState()
    const guardedCsv = VALID_CSV.replace('1001,銘柄1001', '9999,別銘柄')
    const result = await useAppStore.getState().importCsv(csvFile(guardedCsv))

    expect(result).toMatchObject({
      ok: false,
      code: 'FULL_SYNC_GUARD_REJECTED',
      diagnostics: {
        recognizedStockRows: 1,
        recognizedTrustRows: 1,
        matchedTrustRows: 1,
        unknownTrustRows: 0,
        ambiguousTrustRows: 0,
        failedGuard: 'STOCK_REMOVAL_LIMIT',
        committed: false,
      },
    })
    expect(csvImportFeedback(result).details).toEqual([
      '今回の取込試行: 株式1件 / 投信1件を認識',
      '投信: 1一致 / 0未照合 / 0競合',
      '安全性ガードにより取込を中止',
      '反映件数: 0',
    ])
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('trust unknown guard returns current-attempt matching diagnostics and atomically leaves parsed stock uncommitted', async () => {
    const before = relevantState()
    const unknownRows = ['未知投信A', '未知投信B', '未知投信C', '未知投信D', '未知投信E', '未知投信F']
      .map((name, index) => `${name},10000,${50_000 + index},1.00,0.10,`)
    const guardedCsv = [VALID_CSV, ...unknownRows].join('\n')

    const result = await useAppStore.getState().importCsv(csvFile(guardedCsv))

    expect(result).toMatchObject({
      ok: false,
      code: 'FULL_SYNC_GUARD_REJECTED',
      diagnostics: {
        recognizedStockRows: 1,
        recognizedTrustRows: 7,
        matchedTrustRows: 1,
        unknownTrustRows: 6,
        ambiguousTrustRows: 0,
        unknownTrustNames: unknownRows.map(row => row.split(',')[0]),
        failedGuard: 'TRUST_UNKNOWN_LIMIT',
        committed: false,
      },
    })
    expect(csvImportFeedback(result).details).toEqual([
      '今回の取込試行: 株式1件 / 投信7件を認識',
      '投信: 1一致 / 6未照合 / 0競合',
      '未照合商品: 未知投信A、未知投信B、未知投信C、未知投信D、未知投信E',
      '安全性ガードにより取込を中止',
      '反映件数: 0',
    ])
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('analysis exception after parse/full-sync returns ANALYSIS_ERROR without exposing a partial generation', async () => {
    const currentMarket = useAppStore.getState().market
    const throwingMarket = new Proxy(currentMarket, {
      get(target, property) {
        if (property === 'regime') throw new Error('forced analysis failure')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ market: throwingMarket })
    const before = relevantState()
    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'ANALYSIS_ERROR' })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('officialDecision generation failure is not swallowed and commits nothing', async () => {
    const currentSafeMode = useAppStore.getState().safeMode
    const throwingSafeMode = new Proxy(currentSafeMode, {
      get(target, property) {
        if (property === 'safe_mode') throw new Error('forced official decision failure')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ safeMode: throwingSafeMode })
    const before = relevantState()
    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'OFFICIAL_DECISION_ERROR' })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('F001: analysis failure does not mutate the pre-existing trust-short snapshot', async () => {
    const oldSnapshot = '{"date":"2026-07-01","total":200000,"evalById":{"fund-1":200000}}'
    storage.v95_trust_short_snapshot = oldSnapshot
    vi.stubGlobal('window', { localStorage: localStorageMock })
    useAppStore.setState({ trust: [shortTrust()] })
    const currentMarket = useAppStore.getState().market
    const throwingMarket = new Proxy(currentMarket, {
      get(target, property) {
        if (property === 'regime') throw new Error('forced analysis failure after staging')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ market: throwingMarket })
    const before = structuredClone(relevantState())

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'ANALYSIS_ERROR' })
    expect(structuredClone(relevantState())).toEqual(before)
    expect(storage.v95_trust_short_snapshot).toBe(oldSnapshot)
  })

  it('FileReader failure returns FILE_READ_ERROR and commits nothing', async () => {
    const before = relevantState()
    const brokenFile = {
      name: 'broken.csv',
      arrayBuffer: () => Promise.reject(new Error('disk read failed')),
    } as File
    const result = await useAppStore.getState().importCsv(brokenFile)

    expect(result).toMatchObject({ ok: false, code: 'FILE_READ_ERROR' })
    expect(relevantState()).toEqual(before)
    expect(storage).toEqual({})
  })

  it('R2: async onload callback exceptions settle structurally, release loading, and allow retry', async () => {
    class CallbackThrowReader {
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      readAsArrayBuffer() {
        queueMicrotask(() => {
          try {
            this.onload?.({
              target: { get result() { throw new Error('async result getter exploded') } },
            } as unknown as ProgressEvent<FileReader>)
          } catch {
            // Event callback exceptions are reported outside the Promise by browsers.
          }
        })
      }
    }
    vi.stubGlobal('FileReader', CallbackThrowReader)

    const settled = await Promise.race([
      useAppStore.getState().importCsv(csvFile()),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 40)),
    ])

    expect(settled).not.toBe('timeout')
    expect(settled).toMatchObject({ ok: false, code: 'FILE_READ_ERROR' })
    expect(useAppStore.getState().system.status).not.toBe('loading')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()

    vi.stubGlobal('FileReader', TestFileReader)
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })

  it('unsafe partial legacy evidence is rejected before persistence and leaves the store generation unchanged', async () => {
    storage.v81_portfolio = 'old-portfolio'
    storage.v81_trust = 'old-trust'
    storage.v10_csv_imported_at = 'old-imported-at'
    storage.v13_csv_sync_summary = 'old-summary'
    storage.v91_learning = 'old-learning'
    const persistedBefore = { ...storage }
    const stateBefore = relevantState()
    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({
      ok: false,
      code: 'CROSS_TAB_STATE_STALE',
      retryable: false,
    })
    expect(storageWriteCount).toBe(0)
    expect(relevantState()).toEqual(stateBefore)
    expect(storage).toEqual(persistedBefore)
  })

  it('R3-FIX-C RA-001: write-then-throw plus unreadable commit check returns indeterminate without publishing', async () => {
    const before = relevantState()
    let failCommitCheck = false
    let removeCalls = 0
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY && failCommitCheck) {
          failCommitCheck = false
          throw new Error('raw commit-check read failure')
        }
        return storage[key] ?? null
      },
      setItem: (key: string, value: string) => {
        storage[key] = value
        if (key === CSV_IMPORT_GENERATION_KEY) {
          failCommitCheck = true
          throw new Error('raw completion notification failure')
        }
      },
      removeItem: (key: string) => {
        removeCalls += 1
        delete storage[key]
      },
    })
    let generationNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings || state.trust !== previous.trust ||
          state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision) {
        generationNotifications += 1
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(result).toMatchObject({
      ok: false,
      code: 'PERSISTENCE_INDETERMINATE',
      message: '保存結果を確認できません。再読み込みして状態を確認してください。',
      persistence: { status: 'indeterminate' },
    })
    expect(relevantState()).toEqual(before)
    expect(generationNotifications).toBe(0)
    expect(removeCalls).toBe(0)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeTypeOf('string')

    vi.stubGlobal('localStorage', localStorageMock)
    expect(restorePortfolio()?.[0].eval).toBe(150_000)
    delete storage[CSV_IMPORT_GENERATION_KEY]
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('deep state and all portfolio-generation references remain unchanged on forced persistence failure', async () => {
    useAppStore.setState(runFullAnalysis(useAppStore.getState()))
    const beforeReferences = relevantState()
    const beforeDeep = structuredClone(beforeReferences)
    let portfolioNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        state.holdings !== previous.holdings || state.trust !== previous.trust ||
        state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision ||
        state.learning !== previous.learning || state.universe !== previous.universe ||
        state.zeroPlan !== previous.zeroPlan || state.stockPlan !== previous.stockPlan ||
        state.trustPlan !== previous.trustPlan || state.stockCandidates !== previous.stockCandidates
      ) portfolioNotifications += 1
    })
    failStorageWriteAt = 1

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_ERROR' })
    expect(relevantState()).toEqual(beforeReferences)
    expect(structuredClone(relevantState())).toEqual(beforeDeep)
    expect(portfolioNotifications).toBe(0)
  })

  it('a second import while one is pending is explicitly rejected', async () => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File

    const first = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    const second = await useAppStore.getState().importCsv(csvFile())
    expect(second).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })

    release(new TextEncoder().encode(VALID_CSV).buffer)
    await first
  })

  it('RA-006: a cash manual action while reading the CSV is rejected and the outer import continues', async () => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File

    const first = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    const duringReading = useAppStore.getState()
    await useAppStore.getState().setCashAssumptions({ grossCash: 17_000_000, safetyReserve: 0, pendingOrderCash: null })
    expect(useAppStore.getState()).toBe(duringReading)
    release(new TextEncoder().encode(VALID_CSV).buffer)

    await expect(first).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().cashAssumptions).toBe(duringReading.cashAssumptions)
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)

    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })

  it('canonical changed after transaction capture is rejected by pre-write CAS and a stale local retry is rejected', async () => {
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
    const previousGlobal = structuredClone(relevantState())
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File

    const importing = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    const previous = restoreCsvImportGeneration()
    if (previous.status !== 'committed') throw new Error('expected committed generation')
    persistCsvImportTransaction({
      ...previous.payload,
      holdings: previous.payload.holdings.map(item => ({ ...item, eval: 888_000 })),
    }, previous.savedAt + 1)
    const externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
    release(new TextEncoder().encode(VALID_CSV.replace('150000,8.00', '175000,8.00')).buffer)

    await expect(importing).resolves.toMatchObject({
      ok: false,
      code: 'IMPORT_CONFLICT',
      persistence: { status: 'not_attempted' },
    })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    expect(relevantState()).toEqual(previousGlobal)
    expect(restorePortfolio()?.[0].eval).toBe(888_000)
    expect(useAppStore.getState().system.status).toBe('error')

    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({
      ok: false,
      code: 'CROSS_TAB_STATE_STALE',
    })
  })

  it.each([
    ['standby cash manual action', true, () => useAppStore.getState().setCashAssumptions({ grossCash: 8_000_000, safetyReserve: 0, pendingOrderCash: null })],
    ['portfolio policy manual action', true, () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.15 })],
    ['market external dependency', false, () => useAppStore.setState(state => ({ market: { ...state.market, nikkeiChgPct: state.market.nikkeiChgPct + 0.01 } }))],
    ['SAFE_MODE external dependency', false, () => useAppStore.setState(state => ({
      safeMode: { ...state.safeMode, safe_mode: { ...state.safeMode.safe_mode, active: !state.safeMode.safe_mode.active } },
    }))],
  ] as const)('concurrent %s cannot silently commit stale analysis', async (_label, manualRejected, mutate) => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File
    const first = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()
    const beforeMutation = useAppStore.getState()
    const mutationResult = mutate()
    if (manualRejected) {
      await expect(mutationResult).resolves.toMatchObject({
        ok: false,
        code: 'LOCAL_OPERATION_BUSY',
        retryable: true,
      })
    }
    if (manualRejected) expect(useAppStore.getState()).toBe(beforeMutation)
    else expect(useAppStore.getState()).not.toBe(beforeMutation)
    release(new TextEncoder().encode(VALID_CSV).buffer)

    await expect(first).resolves.toMatchObject(manualRejected
      ? { ok: true, code: 'SUCCESS' }
      : { ok: false, code: 'IMPORT_CONFLICT' })
    expect(useAppStore.getState().holdings[0].eval).toBe(manualRejected ? 150_000 : 100_000)
    expect(useAppStore.getState().system.status).not.toBe('loading')
  })

  it.each([
    ['cash', () => useAppStore.setState(state => ({
      cashAssumptions: { ...state.cashAssumptions, cashDeposits: state.cashAssumptions.grossCash + 123_456 },
    }))],
    ['market', () => useAppStore.setState(state => ({
      market: { ...state.market, nikkeiChgPct: state.market.nikkeiChgPct + 3.25 },
    }))],
    ['policy', () => useAppStore.setState(state => ({
      portfolioPolicy: { jpStockMaxRatio: state.portfolioPolicy.jpStockMaxRatio + 0.01 },
    }))],
    ['SAFE_MODE', () => useAppStore.setState(state => ({
      safeMode: { ...state.safeMode, safe_mode: { ...state.safeMode.safe_mode, active: !state.safeMode.safe_mode.active } },
    }))],
  ])('R5: synchronous storage reentry changing %s cannot publish stale derived SUCCESS', async (_label, mutate) => {
    let fired = false
    storageReentry = () => {
      if (fired) return
      fired = true
      mutate()
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    storageReentry = null
    const state = useAppStore.getState()
    const recomputed = runFullAnalysis(state, { requireOfficialDecision: true })

    expect(result.ok).toBe(true)
    expect(withoutGeneratedTimestamps(state.analysis)).toEqual(withoutGeneratedTimestamps(recomputed.analysis))
    expect(withoutGeneratedTimestamps(state.universe)).toEqual(withoutGeneratedTimestamps(recomputed.universe))
    expect(withoutGeneratedTimestamps(state.zeroPlan)).toEqual(withoutGeneratedTimestamps(recomputed.zeroPlan))
    expect(withoutGeneratedTimestamps(state.stockPlan)).toEqual(withoutGeneratedTimestamps(recomputed.stockPlan))
    expect(withoutGeneratedTimestamps(state.trustPlan)).toEqual(withoutGeneratedTimestamps(recomputed.trustPlan))
    expect(withoutGeneratedTimestamps(state.officialDecision)).toEqual(withoutGeneratedTimestamps(recomputed.officialDecision))
  })

  it('R5: repeated mixed action/public-set reentry is rejected for the critical section and remains retryable', async () => {
    const cashBefore = useAppStore.getState().cashAssumptions
    const policyBefore = useAppStore.getState().portfolioPolicy
    let manualResults: Array<ReturnType<ReturnType<typeof useAppStore.getState>['setPortfolioPolicy']>> = []
    storageReentry = () => {
      manualResults = [
        useAppStore.getState().setCashAssumptions({ grossCash: 17_000_000, safetyReserve: 0, pendingOrderCash: null }),
        useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.2 }),
      ]
      useAppStore.setState(state => ({ market: { ...state.market, nikkeiChgPct: 99 } }))
      useAppStore.setState(state => ({
        safeMode: { ...state.safeMode, safe_mode: { ...state.safeMode.safe_mode, active: true } },
      }))
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    await expect(Promise.all(manualResults)).resolves.toEqual([
      { ok: false, operation: 'setCashAssumptions', code: 'LOCAL_OPERATION_BUSY', retryable: true },
      { ok: false, operation: 'setPortfolioPolicy', code: 'LOCAL_OPERATION_BUSY', retryable: true },
    ])
    storageReentry = null
    const state = useAppStore.getState()
    const recomputed = runFullAnalysis(state, { requireOfficialDecision: true })

    expect(result.ok).toBe(true)
    expect(state.cashAssumptions).toEqual(cashBefore)
    expect(state.portfolioPolicy).toEqual(policyBefore)
    expect(withoutGeneratedTimestamps(state.officialDecision)).toEqual(withoutGeneratedTimestamps(recomputed.officialDecision))
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('R5: a final-publish subscriber cannot synchronously replace dependencies before later observers run', async () => {
    const marketBefore = useAppStore.getState().market
    let laterObservedConsistent = false
    const unsubscribeMutating = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) {
        useAppStore.setState(current => ({
          market: { ...current.market, nikkeiChgPct: current.market.nikkeiChgPct + 42 },
        }))
      }
    })
    const unsubscribeLater = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) {
        const recomputed = runFullAnalysis(state, { requireOfficialDecision: true })
        laterObservedConsistent = withoutGeneratedTimestamps(state.officialDecision) === null
          ? recomputed.officialDecision === null
          : JSON.stringify(withoutGeneratedTimestamps(state.officialDecision)) ===
            JSON.stringify(withoutGeneratedTimestamps(recomputed.officialDecision))
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribeMutating()
    unsubscribeLater()

    expect(result.ok).toBe(true)
    expect(useAppStore.getState().market).toEqual(marketBefore)
    expect(laterObservedConsistent).toBe(true)
  })

  it('F1: nested import from a publish subscriber is rejected without releasing the outer mutation guard', async () => {
    const marketBefore = useAppStore.getState().market
    let nestedResult: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>> | null = null
    let nestedPromise: Promise<void> | null = null
    let nestedAttempts = 0
    const unsubscribeNested = useAppStore.subscribe((state, previous) => {
      if (state.holdings === previous.holdings || nestedAttempts > 0) return
      nestedAttempts += 1
      nestedPromise = useAppStore.getState().importCsv(csvFile()).then(result => {
        nestedResult = result
      })
    })
    const unsubscribeMutating = useAppStore.subscribe((state, previous) => {
      if (state.holdings === previous.holdings) return
      useAppStore.setState(current => ({
        market: { ...current.market, nikkeiChgPct: current.market.nikkeiChgPct + 42 },
      }))
    })

    const outerResult = await useAppStore.getState().importCsv(csvFile())
    if (nestedPromise) await nestedPromise
    unsubscribeNested()
    unsubscribeMutating()

    expect(outerResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(nestedResult).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(useAppStore.getState().market).toEqual(marketBefore)
    expect(useAppStore.getState().system.status).toBe('success')
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('F2: tracker mutation during canonical write cannot publish stale tracker-derived SUCCESS', async () => {
    const nextTracker = JSON.stringify({
      entries: [{
        date: '2026-07-15', decision: 'BULL', confidence: 90, executed: true,
        outcome: 'win', nikkeiChgPct: 1, futuresChgPct: 1, conditionsPassed: 5,
        vix: 15, nikkeiVI: 18, volatilitySpread: 0, updatedAt: '2026-07-15T00:00:00.000Z',
      }],
    })
    let fired = false
    let nestedResult: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>> | null = null
    let nestedPromise: Promise<void> | null = null
    storageReentry = () => {
      if (fired) return
      fired = true
      storage.v95_trust_short_tracker = nextTracker
      nestedPromise = useAppStore.getState().importCsv(csvFile()).then(value => { nestedResult = value })
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    if (nestedPromise) await nestedPromise
    storageReentry = null

    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT' })
    expect(nestedResult).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(storage.v95_trust_short_tracker).toBeUndefined()
    expect(useAppStore.getState().holdings[0].eval).toBe(100_000)
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('C1: valid external canonical replacement loses exact-byte ownership without publishing or rollback', async () => {
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-14T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true })
    const previousGlobalEval = useAppStore.getState().holdings[0].eval
    const previousRaw = storage[CSV_IMPORT_GENERATION_KEY]
    const previous = restoreCsvImportGeneration()
    if (previous.status !== 'committed') throw new Error('expected committed baseline generation')

    persistCsvImportTransaction({
      ...previous.payload,
      holdings: previous.payload.holdings.map(item => ({ ...item, eval: 999_000 })),
    }, previous.savedAt + 1)
    const externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
    storage[CSV_IMPORT_GENERATION_KEY] = previousRaw

    let transactionCommittedRaw: string | null = null
    let replaced = false
    storageReentry = key => {
      if (key !== CSV_IMPORT_GENERATION_KEY || replaced) return
      replaced = true
      transactionCommittedRaw = storage[key]
      storage[key] = externalRaw
    }

    const nextCsv = csvWithSource(
      '2026-07-15T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '175000,8.00'),
    )
    const result = await useAppStore.getState().importCsv(csvFile(nextCsv))
    storageReentry = null

    expect(transactionCommittedRaw).not.toBeNull()
    expect(transactionCommittedRaw).not.toBe(externalRaw)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    expect(result).toMatchObject({
      ok: false,
      code: 'IMPORT_CONFLICT',
      persistence: { status: 'ownership_lost' },
    })
    expect(useAppStore.getState().holdings[0].eval).toBe(previousGlobalEval)
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { holdings: [{ eval: 999_000 }] },
    })
    expect(restorePortfolio()?.[0].eval).toBe(999_000)
    expect(useAppStore.getState().system.status).toBe('error')

    storageReentry = null
    await expect(useAppStore.getState().importCsv(csvFile(nextCsv))).resolves.toMatchObject({
      ok: false,
      code: 'CROSS_TAB_STATE_STALE',
    })
  })

  it('C2: sell-lock boundary crossing keeps analysis, plans, and official decision on one transaction clock', async () => {
    vi.useFakeTimers()
    const analysisNow = new Date('2026-07-15T14:00:00.000Z').getTime()
    const afterThreshold = analysisNow + 12 * 60 * 60 * 1000
    vi.setSystemTime(analysisNow)
    useAppStore.setState(state => ({
      holdings: [{
        ...holding(),
        // C2 exercises the lock clock. The weak indicators that drive SELL are
        // supplied as authoritative published evidence (holdingEvidence below);
        // persisted metadataStatus=known no longer survives as runtime authority (R1).
        mu: -0.2,
        sigma: 0.5,
        beta: 1.5,
      }],
      holdingEvidence: weakHoldingEvidence('1001', analysisNow),
      system: {
        ...state.system,
        dataSourceStatus: {
          ...state.system.dataSourceStatus,
          market: 'loaded',
          safeMode: 'loaded',
        },
        dataTimestamps: {
          ...state.system.dataTimestamps,
          market: new Date(analysisNow).toISOString(),
          safeMode: new Date(analysisNow).toISOString(),
        } as NonNullable<typeof state.system.dataTimestamps>,
      },
    }))
    const boundaryCsv = csvWithSource(
      '2026-07-14T09:00:00+09:00',
      VALID_CSV.replace('2025-01-01', '2026-04-17'),
    )

    class BoundaryCrossingReader extends TestFileReader {
      override readAsArrayBuffer(file: File) {
        file.arrayBuffer()
          .then(result => {
            vi.setSystemTime(afterThreshold)
            this.onload?.({ target: { result } })
          })
          .catch(() => this.onerror?.())
      }
    }
    vi.stubGlobal('FileReader', BoundaryCrossingReader)

    try {
      const result = await useAppStore.getState().importCsv(csvFile(boundaryCsv))
      const state = useAppStore.getState()
      const analysis = state.analysis.find(item => item.code === '1001')
      const stockRow = state.stockPlan?.rows.find(item => item.code === '1001')
      const zeroAction = state.zeroPlan?.proposals.find(item => item.code === '1001')
      const officialAction = state.officialDecision?.actions.find(item => item.code === '1001')

      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(state.system.analysisLastRunAt).toBe(new Date(analysisNow).toISOString())
      expect(state.stockPlan?.generatedAt).toBe(new Date(analysisNow).toISOString())
      expect(state.zeroPlan?.generatedAt).toBe(new Date(analysisNow).toISOString())
      expect(state.trustPlan?.generatedAt).toBe(new Date(analysisNow).toISOString())
      expect(state.officialDecision?.generatedAt).toBe(new Date(analysisNow).toISOString())
      const firstGeneration = restoreCsvImportGeneration()
      if (firstGeneration.status !== 'committed') throw new Error('expected committed generation')
      expect(firstGeneration.payload.csvImportedAt).toBe(new Date(analysisNow).toISOString())
      expect(firstGeneration.savedAt).toBe(afterThreshold)
      expect(analysis?.debate.recommendedAction).toContain('売却不可期間中')
      expect(stockRow?.locked).toBe(true)
      expect(zeroAction?.action).toBe('WAIT')
      expect(officialAction?.action).toBe('HOLD')

      vi.stubGlobal('FileReader', TestFileReader)
      const nextBoundaryCsv = csvWithSource(
        '2026-07-15T09:00:00+09:00',
        VALID_CSV.replace('2025-01-01', '2026-04-17').replace('150000,8.00', '150001,8.00'),
      )
      const nextResult = await useAppStore.getState().importCsv(csvFile(nextBoundaryCsv))
      const nextState = useAppStore.getState()
      const nextAnalysis = nextState.analysis.find(item => item.code === '1001')
      const nextStockRow = nextState.stockPlan?.rows.find(item => item.code === '1001')
      const nextZeroAction = nextState.zeroPlan?.proposals.find(item => item.code === '1001')
      const nextOfficialAction = nextState.officialDecision?.actions.find(item => item.code === '1001')

      expect(nextResult).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(nextState.system.analysisLastRunAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.stockPlan?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.zeroPlan?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.trustPlan?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextState.officialDecision?.generatedAt).toBe(new Date(afterThreshold).toISOString())
      expect(nextAnalysis?.debate.recommendedAction).not.toContain('売却不可期間中')
      expect(nextStockRow?.locked).toBe(false)
      expect(nextZeroAction?.action).toBe('SELL')
      expect(nextOfficialAction?.action).toBe('SELL')
    } finally {
      vi.stubGlobal('FileReader', TestFileReader)
      vi.useRealTimers()
    }
  })

  it('F3: persistence-time clock crossing cannot change a transaction-scoped analysis result', async () => {
    vi.useFakeTimers()
    const analysisNow = new Date('2026-07-15T14:00:00.000Z').getTime()
    vi.setSystemTime(analysisNow)
    storage.v95_trust_short_tracker = JSON.stringify({
      entries: [{
        date: '2026-06-15', decision: 'BULL', confidence: 90, executed: true,
        outcome: 'win', nikkeiChgPct: 1, futuresChgPct: 1, conditionsPassed: 5,
        vix: 15, nikkeiVI: 18, volatilitySpread: 0, updatedAt: '2026-06-15T00:00:00.000Z',
      }],
    })
    useAppStore.setState(state => ({
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(analysisNow - 167 * 60 * 60 * 1000).toISOString(),
      },
      system: {
        ...state.system,
        dataSourceStatus: {
          ...state.system.dataSourceStatus,
          market: 'loaded',
          safeMode: 'loaded',
        },
        dataTimestamps: {
          ...state.system.dataTimestamps,
          market: new Date(analysisNow - 23 * 60 * 60 * 1000).toISOString(),
          safeMode: new Date(analysisNow - 95 * 60 * 60 * 1000).toISOString(),
        } as NonNullable<typeof state.system.dataTimestamps>,
      },
    }))
    let fired = false
    storageReentry = () => {
      if (fired) return
      fired = true
      vi.setSystemTime(analysisNow + 2 * 60 * 60 * 1000)
    }

    try {
      const result = await useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-14T09:00:00+09:00')))
      storageReentry = null
      const state = useAppStore.getState()
      const fixedRecomputed = runFullAnalysis(state, {
        requireOfficialDecision: true,
        nowMs: analysisNow,
      } as { requireOfficialDecision: true; nowMs: number })

      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(state.system.analysisLastRunAt).toBe(new Date(analysisNow).toISOString())
      expect(withoutGeneratedTimestamps(state.officialDecision))
        .toEqual(withoutGeneratedTimestamps(fixedRecomputed.officialDecision))
      expect(state.officialDecision?.dataQualitySuppressed).toBe(false)
      expect(state.trustPlan?.performance30d.trackedDays).toBe(1)

      const nextResult = await useAppStore.getState().importCsv(csvFile(csvWithSource(
        '2026-07-15T09:00:00+09:00',
        VALID_CSV.replace('150000,8.00', '150001,8.00'),
      )))
      expect(nextResult).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(useAppStore.getState().officialDecision?.dataQualitySuppressed).toBe(true)
      expect(useAppStore.getState().trustPlan?.performance30d.trackedDays).toBe(0)
    } finally {
      storageReentry = null
      vi.useRealTimers()
    }
  })

  it('multiple nested publish attempts plus a throwing observer preserve one outer generation and retryability', async () => {
    const nestedResults: Array<Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>>> = []
    const nestedPromises: Promise<void>[] = []
    const subscribeNested = () => useAppStore.subscribe((state, previous) => {
      if (state.holdings === previous.holdings) return
      nestedPromises.push(useAppStore.getState().importCsv(csvFile()).then(result => { nestedResults.push(result) }))
    })
    const unsubscribeFirst = subscribeNested()
    const unsubscribeThrowing = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) throw new Error('nested observer failure')
    })
    const unsubscribeSecond = subscribeNested()
    let laterCalls = 0
    const unsubscribeLater = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) laterCalls += 1
    })

    const outer = await useAppStore.getState().importCsv(csvFile())
    await Promise.all(nestedPromises)
    unsubscribeFirst()
    unsubscribeThrowing()
    unsubscribeSecond()
    unsubscribeLater()

    expect(outer).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(nestedResults).toHaveLength(2)
    expect(nestedResults.every(result => !result.ok && result.code === 'LOCAL_OPERATION_BUSY')).toBe(true)
    expect(laterCalls).toBe(1)
    expect(useAppStore.getState().system.status).toBe('success')
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  it('R6: absent canonical permits legacy trust snapshot baseline and PUBLISHED rejects nested telemetry import', async () => {
    useAppStore.setState({ trust: [shortTrust()] })
    storage.v95_trust_short_snapshot = JSON.stringify({
      date: '2026-07-01',
      total: 1,
      evalById: { 'fund-1': 0 },
    })
    let nestedResult: Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>> | null = null
    let nestedPromise: Promise<void> | null = null
    storageReentry = key => {
      if (key !== 'v95_trust_short_tracker' || nestedPromise) return
      nestedPromise = useAppStore.getState().importCsv(csvFile()).then(result => { nestedResult = result })
    }

    const result = await useAppStore.getState().importCsv(csvFile())
    if (nestedPromise) await nestedPromise
    storageReentry = null

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(storage.v95_trust_short_tracker).toBeDefined()
    expect(nestedResult).toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
    expect(useAppStore.getState().system.status).toBe('success')
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true })
  })

  // T9-A004-R3-FIX-B (R3-F004): 旧契約「present-invalid canonicalでもCSV importは
  // SUCCESSし、legacy trust snapshot fallbackだけを禁止する」を置き換える。
  // present-invalid canonicalの通常CSV importはfail-closedし、修復自体を行わない
  // （legacy fallback禁止はrejectにより自明に維持される）。
  it('R6: present-invalid canonical fails the import closed and forbids legacy trust snapshot fallback', async () => {
    useAppStore.setState({ trust: [shortTrust()] })
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    storage.v95_trust_short_snapshot = JSON.stringify({
      date: '2026-07-01',
      total: 1,
      evalById: { 'fund-1': 0 },
    })

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({
      ok: false,
      code: 'CSV_CANONICAL_INVALID',
      persistence: { status: 'not_attempted' },
    })
    expect(storage.v95_trust_short_tracker).toBeUndefined()
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe('{malformed')
    expect(restoreCsvImportGeneration()).toEqual({ status: 'invalid' })
  })

  it('F004: an unexpected staging exception is structured and always releases loading', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Number.NaN)
    const before = structuredClone(relevantState())
    try {
      const result = await useAppStore.getState().importCsv(csvFile())
      expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
      expect(useAppStore.getState().system.status).not.toBe('loading')
      expect(structuredClone(relevantState())).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry.ok).toBe(true)
  })
})

// 新describe共通のstore baseline（main describeのbeforeEachと同一内容）。
function seedCsvImportBaselineState() {
  useAppStore.setState(state => ({
    holdings: [holding()],
    trust: [trust()],
    correlation: null,
    market: baseMarket,
    safeMode: baseSafeMode,
    portfolioPolicy: { jpStockMaxRatio: 0.1 },
    cashAssumptions: baseCashAssumptions,
    candidatesNews: baseCandidatesNews,
    candidatesStocks: baseCandidatesStocks,
    regimeState: baseRegimeState,
    learning: null,
    universe: null,
    zeroPlan: null,
    stockPlan: null,
    trustPlan: null,
    stockCandidates: [],
    analysis: [],
    metrics: null,
    officialDecision: null,
    system: {
      ...state.system,
      status: 'idle',
      error: null,
      csvLastImportedAt: '2026-07-01T00:00:00.000Z',
      csvImportProvenance: null,
      csvSyncSummary: null,
      // R1-P1-1: CSV importはdataSourceOutcome既知のときだけ'success'を主張する。
      // このsuiteは「取込自体はsuccessになる」ことを前提にしているため明示する。
      dataSourceOutcome: { loaded: 14, total: 14 },
    },
  }))
}

// T9-A004-R3-FIX-B (R3-F004): present-invalid canonicalの通常CSV importはfail-closed。
// absent（ALLOW_FIRST_IMPORT可）とpresent-invalidを同一視せず、stale CSVによる
// canonical/store世代の逆行・自動修復・legacy fallbackを禁止する。修復は将来の
// 明示repair actionへ分離する（本チケットでは未実装）。
describe('T9-A004-R3-FIX-B: present-invalid canonical CSV write policy (R3-F004)', () => {
  const storage: Record<string, string> = {}
  let storageWriteCount = 0
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      storageWriteCount += 1
      storage[key] = value
    },
    removeItem: (key: string) => { delete storage[key] },
  }

  function subscribeGenerationNotifications(counter: { count: number }) {
    return useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings || state.trust !== previous.trust ||
          state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision) {
        counter.count += 1
      }
    })
  }

  beforeEach(() => {
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    storageWriteCount = 0
    seedCsvImportBaselineState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalFileReader) globalThis.FileReader = originalFileReader
  })

  it('F004-1: store generation A + present-invalid canonical + stale CSV Bは逆行できない（reject・A維持・invalid bytes維持）', async () => {
    // store/canonicalへauthoritative generation A（2026-07-15基準）を確立する
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-15T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    const before = relevantState()
    const writesBefore = storageWriteCount
    const notifications = { count: 0 }
    const unsubscribe = subscribeGenerationNotifications(notifications)

    // Aより古い基準時刻のstale CSV B。present-invalidをabsent扱いすると
    // ALLOW_FIRST_IMPORTで逆行取込が成立してしまう。
    const staleCsvB = csvWithSource(
      '2026-07-14T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '110000,1.00'),
    )
    const result = await useAppStore.getState().importCsv(csvFile(staleCsvB))
    unsubscribe()

    expect(result).toMatchObject({
      ok: false,
      code: 'CSV_CANONICAL_INVALID',
      persistence: { status: 'not_attempted' },
      analysisCommitted: false,
      officialDecisionCommitted: false,
    })
    expect(relevantState()).toEqual(before)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe('{malformed')
    expect(storageWriteCount).toBe(writesBefore)
    expect(notifications.count).toBe(0)
    expect(useAppStore.getState().system.status).not.toBe('loading')
  })

  it('F004-2: store empty + present-invalid canonicalでもCSV importはrejectされる', async () => {
    useAppStore.setState(state => ({
      holdings: [],
      trust: [],
      system: { ...state.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    const writesBefore = storageWriteCount

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'CSV_CANONICAL_INVALID' })
    expect(useAppStore.getState().holdings).toEqual([])
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe('{malformed')
    expect(storageWriteCount).toBe(writesBefore)
  })

  it('F004-3: 有効なlegacy keysが存在してもpresent-invalid canonicalはlegacy fallbackせずrejectされる', async () => {
    const legacyPortfolioRaw = JSON.stringify({ data: [holding('8888', 800_000)], savedAt: Date.now() })
    const legacyTrustRaw = JSON.stringify({ data: [trust()], savedAt: Date.now() })
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    storage.v81_portfolio = legacyPortfolioRaw
    storage.v81_trust = legacyTrustRaw
    const writesBefore = storageWriteCount

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({ ok: false, code: 'CSV_CANONICAL_INVALID' })
    expect(storage.v81_portfolio).toBe(legacyPortfolioRaw)
    expect(storage.v81_trust).toBe(legacyTrustRaw)
    expect(storageWriteCount).toBe(writesBefore)
    // invalid canonicalがある限りreload読取はlegacyへfallbackしない（dead write禁止の前提）
    expect(restorePortfolio()).toBeNull()
  })

  it.each([
    ['malformed JSON', () => '{malformed'],
    ['checksum mismatch', (raw: string) => {
      const envelope = JSON.parse(raw)
      envelope.payload.holdings[0].eval += 1
      return JSON.stringify(envelope)
    }],
    ['manifest committed marker欠落', (raw: string) => {
      const envelope = JSON.parse(raw)
      envelope.manifest.committed = false
      return JSON.stringify(envelope)
    }],
    ['deep validation不正（負のeval）', (raw: string) => {
      const envelope = JSON.parse(raw)
      envelope.payload.holdings[0].eval = -1
      return JSON.stringify(envelope)
    }],
    ['未知schema version', (raw: string) => {
      const envelope = JSON.parse(raw)
      envelope.manifest.schemaVersion = 'csv-import-generation-99'
      return JSON.stringify(envelope)
    }],
  ])('F004-4: %s のpresent-invalid canonicalは構造化fail-closedし、raw parser/storage詳細をUIへ出さない', async (_label, corrupt) => {
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-15T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const corruptedRaw = corrupt(storage[CSV_IMPORT_GENERATION_KEY])
    storage[CSV_IMPORT_GENERATION_KEY] = corruptedRaw
    const before = relevantState()

    const result = await useAppStore.getState().importCsv(csvFile(csvWithSource(
      '2026-07-16T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '175000,8.00'),
    )))

    expect(result).toMatchObject({ ok: false, code: 'CSV_CANONICAL_INVALID' })
    if (!result.ok && !('operation' in result)) {
      expect(result.message).not.toMatch(/Unexpected|JSON|token|checksum|parse|schema/i)
    }
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(corruptedRaw)
    expect(relevantState()).toEqual(before)
  })

  it('F004-5: reject後にcanonicalを明示除去（absent化）したretryはfirst importとして成功する', async () => {
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    await expect(useAppStore.getState().importCsv(csvFile()))
      .resolves.toMatchObject({ ok: false, code: 'CSV_CANONICAL_INVALID' })

    delete storage[CSV_IMPORT_GENERATION_KEY]
    const retry = await useAppStore.getState().importCsv(csvFile())

    expect(retry).toMatchObject({ ok: true, code: 'SUCCESS', persistence: { status: 'committed' } })
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)
    expect(restoreCsvImportGeneration()).toMatchObject({ status: 'committed' })
    expect(restorePortfolio()).toEqual(useAppStore.getState().holdings)
  })

  it('F004-6: reject後にvalid canonicalへ修復したretryは通常のduplicate/stale/monotonicity判定へ戻る', async () => {
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-15T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const validRaw = storage[CSV_IMPORT_GENERATION_KEY]
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'

    const staleCsv = csvFile(csvWithSource(
      '2026-07-14T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '110000,1.00'),
    ))
    await expect(useAppStore.getState().importCsv(staleCsv))
      .resolves.toMatchObject({ ok: false, code: 'CSV_CANONICAL_INVALID' })

    // 修復（valid committed世代へ復元）後は通常判定が再開される
    storage[CSV_IMPORT_GENERATION_KEY] = validRaw
    await expect(useAppStore.getState().importCsv(staleCsv))
      .resolves.toMatchObject({ ok: false, code: 'STALE_CSV' })
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-15T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'DUPLICATE_CSV' })
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource(
      '2026-07-16T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '175000,8.00'),
    )))).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings[0].eval).toBe(175_000)
  })

  it('F004-7: reject時はanalysisも実行されない（analysis失敗を強制してもcodeはCSV_CANONICAL_INVALIDのまま・lock残留なし）', async () => {
    const throwingMarket = new Proxy(baseMarket, {
      get(target, property) {
        if (property === 'regime') throw new Error('forced analysis failure')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ market: throwingMarket })
    storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
    const writesBefore = storageWriteCount
    const notifications = { count: 0 }
    const unsubscribe = subscribeGenerationNotifications(notifications)

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(result).toMatchObject({ ok: false, code: 'CSV_CANONICAL_INVALID' })
    expect(storageWriteCount).toBe(writesBefore)
    expect(notifications.count).toBe(0)
    expect(useAppStore.getState().system.status).not.toBe('loading')

    // 修復後のretryが完全実行できる（transaction lock残留なし）
    useAppStore.setState({ market: baseMarket })
    delete storage[CSV_IMPORT_GENERATION_KEY]
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

// T9-A004-R3-FIX-B (R3-F003): CSV canonical receipt取得後〜Zustand publish完了までを
// 明示的なfailure boundaryとして扱う。durableCommittedだけを根拠にSUCCESSを返さず、
// canonical/store/resultの三者を必ず物理状態と一致させる。
describe('T9-A004-R3-FIX-B: CSV post-receipt failure boundary (R3-F003)', () => {
  const storage: Record<string, string> = {}
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value },
    removeItem: (key: string) => { delete storage[key] },
  }

  beforeEach(() => {
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    seedCsvImportBaselineState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalFileReader) globalThis.FileReader = originalFileReader
  })

  it('F003-1: receipt取得後・fingerprint処理前の例外はcommitted世代をbyte-exact rollbackし、durableCommittedだけでSUCCESSにしない', async () => {
    const before = relevantState()
    let canonicalWritten = false
    let injected = false
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        storage[key] = value
        if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
      },
    })
    const stateBeforeProxy = useAppStore.getState()
    useAppStore.setState(new Proxy(stateBeforeProxy, {
      get(target, property, receiver) {
        if (property === 'holdings' && canonicalWritten && !injected) {
          injected = true
          throw new Error('injected failure after durable commit')
        }
        return Reflect.get(target, property, receiver)
      },
    }), true)
    let generationNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings || state.trust !== previous.trust ||
          state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision) {
        generationNotifications += 1
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(injected).toBe(true)
    // 三者整合: canonical=旧（absentへ復旧）/ store=旧 / result=構造化failure
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR', persistence: { status: 'rolled_back' } })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(restoreCsvImportGeneration()).toEqual({ status: 'none' })
    expect(relevantState()).toEqual(before)
    expect(generationNotifications).toBe(0)
    expect(useAppStore.getState().system.status).not.toBe('loading')

    // lock解放・retry可能
    vi.stubGlobal('localStorage', localStorageMock)
    const retry = await useAppStore.getState().importCsv(csvFile())
    expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)
    expect(restorePortfolio()).toEqual(useAppStore.getState().holdings)
  })

  it('F003-2: fingerprint確認後・Zustand set直前の例外はcanonicalを前世代bytesへ復旧し、canonical新/store旧のSUCCESSを禁止する', async () => {
    await expect(useAppStore.getState().importCsv(csvFile(csvWithSource('2026-07-14T09:00:00+09:00'))))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
    const gen1Raw = storage[CSV_IMPORT_GENERATION_KEY]
    const before = relevantState()
    let canonicalWritten = false
    let postCommitCanonicalReads = 0
    let throwOnSystemRead = false
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      getItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY && canonicalWritten) {
          postCommitCanonicalReads += 1
          if (postCommitCanonicalReads === 4) throwOnSystemRead = true
        }
        return storage[key] ?? null
      },
      setItem: (key: string, value: string) => {
        storage[key] = value
        if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
      },
    })
    const stateBeforeProxy = useAppStore.getState()
    useAppStore.setState(new Proxy(stateBeforeProxy, {
      get(target, property, receiver) {
        if (property === 'system' && throwOnSystemRead) {
          throwOnSystemRead = false
          throw new Error('injected failure before publish')
        }
        return Reflect.get(target, property, receiver)
      },
    }), true)

    const nextCsv = csvWithSource(
      '2026-07-15T09:00:00+09:00',
      VALID_CSV.replace('150000,8.00', '175000,8.00'),
    )
    const result = await useAppStore.getState().importCsv(csvFile(nextCsv))

    // 三者整合: canonical=gen1（byte-exact復旧）/ store=gen1 / result=構造化failure
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR', persistence: { status: 'rolled_back' } })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(gen1Raw)
    expect(relevantState()).toEqual(before)
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)

    // false rollbackなし: rolled_back報告どおり、reloadしてもgen2は出現しない
    expect(restorePortfolio()?.[0].eval).toBe(150_000)

    vi.stubGlobal('localStorage', localStorageMock)
    const retry = await useAppStore.getState().importCsv(csvFile(nextCsv))
    expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings[0].eval).toBe(175_000)
    expect(restorePortfolio()?.[0].eval).toBe(175_000)
  })

  it('R3-FIX-C RA-002: normal-return pre-publish storage seam replacement is caught by final ownership', async () => {
    persistCsvImportTransaction({
      holdings: [holding('EXTERNAL', 999_000)],
      trust: [trust()],
      learning: null,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-07-16', total: 0, evalById: {} },
      portfolioPolicy: { jpStockMaxRatio: 0.1 },
      cashAssumptions: baseCashAssumptions,
      origin: 'snapshot',
    })
    const externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
    delete storage[CSV_IMPORT_GENERATION_KEY]
    const before = relevantState()
    let canonicalWritten = false
    let postCommitCanonicalReads = 0
    let replaced = false
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      getItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY && canonicalWritten) {
          postCommitCanonicalReads += 1
          if (postCommitCanonicalReads === 2 && !replaced) {
            replaced = true
            storage[CSV_IMPORT_GENERATION_KEY] = externalRaw
          }
        }
        return storage[key] ?? null
      },
      setItem: (key: string, value: string) => {
        storage[key] = value
        if (key === CSV_IMPORT_GENERATION_KEY) canonicalWritten = true
      },
    })
    let generationNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings || state.trust !== previous.trust ||
          state.analysis !== previous.analysis || state.officialDecision !== previous.officialDecision) {
        generationNotifications += 1
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(replaced).toBe(true)
    expect(result).toMatchObject({
      ok: false,
      code: 'IMPORT_CONFLICT',
      persistence: { status: 'ownership_lost' },
    })
    expect(relevantState()).toEqual(before)
    expect(generationNotifications).toBe(0)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalRaw)
    vi.stubGlobal('localStorage', localStorageMock)
    delete storage[CSV_IMPORT_GENERATION_KEY]
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('F003-3: Zustand state適用後・result返却前の例外は、generation identity一致を確認した上でSUCCESSを返す（false rollbackなし）', async () => {
    let subscriberCalls = 0
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.holdings !== previous.holdings) {
        subscriberCalls += 1
        throw new Error('injected observer failure after publish')
      }
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()

    expect(subscriberCalls).toBe(1)
    // 三者整合: canonical=新 / store=新 / result=SUCCESS
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS', persistence: { status: 'committed' } })
    expect(useAppStore.getState().holdings[0].eval).toBe(150_000)
    expect(useAppStore.getState().system.status).toBe('success')
    const durable = restoreCsvImportGeneration()
    if (durable.status !== 'committed') throw new Error('expected committed generation')
    expect(durable.payload.holdings).toEqual(useAppStore.getState().holdings)
  })

  it('F003-4: receipt後に外部writerがcanonicalを置換した場合、例外recoveryは外部bytesへ触れずownership喪失を報告する', async () => {
    const externalBytes = 'external-transaction-bytes'
    let replaced = false
    vi.stubGlobal('localStorage', {
      ...localStorageMock,
      setItem: (key: string, value: string) => {
        storage[key] = value
        if (key === CSV_IMPORT_GENERATION_KEY && !replaced) {
          replaced = true
          storage[key] = externalBytes
        }
      },
    })
    const before = relevantState()

    const result = await useAppStore.getState().importCsv(csvFile())

    // 三者整合: canonical=外部bytes（無傷）/ store=旧 / result=ownership喪失の構造化failure
    expect(result).toMatchObject({ ok: false, code: 'IMPORT_CONFLICT', persistence: { status: 'ownership_lost' } })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(externalBytes)
    expect(relevantState()).toEqual(before)
    expect(useAppStore.getState().holdings[0].eval).toBe(100_000)

    // 外部世代を除去した上でretry可能（lock残留なし）
    vi.stubGlobal('localStorage', localStorageMock)
    delete storage[CSV_IMPORT_GENERATION_KEY]
    await expect(useAppStore.getState().importCsv(csvFile())).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})
