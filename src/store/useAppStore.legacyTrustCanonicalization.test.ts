// E2E-A1 canonical trust legacy sanitization (R1) — store-level regression.
//
// Reproduces the real-world shape with synthetic fixtures: the store was hydrated from a legacy
// `v81_trust` generation whose rows carry historical `csv_name` / `csv_account` metadata, no
// canonical generation exists yet, and the user performs a normal supported import.
//
//   T9  CSV import with legacy trust state       → canonical generation committed
//   T10 snapshot import with legacy trust state  → committed through the same writer boundary
//   +   store-published rows equal canonical rows (no store/canonical divergence after commit)
//   +   legacy v81_trust bytes are not rewritten by the import
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { resetPortfolioGenerationLockAdapterForTest, setPortfolioGenerationLockAdapterForTest } from './useAppStore'
beforeEach(() => setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest()))
afterEach(() => resetPortfolioGenerationLockAdapterForTest())
import type { CsvImportProvenance, Holding, Trust } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { useAppStore } from './useAppStore'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistPortfolio,
  persistTrust,
  restoreCsvImportGeneration,
  restorePortfolio,
  restoreTrust,
} from './persist'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'

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

function cleanTrust(): Trust {
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

/** Legacy v81_trust row shape: canonical fields plus the retired trust_master matching keys. */
function legacyTrust(): Trust {
  return { ...cleanTrust(), csv_name: 'テスト投信', csv_account: '特定' } as unknown as Trust
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

function incomingProvenance(tag: string): CsvImportProvenance {
  return {
    importedAt: '2026-07-15T12:00:00.000Z',
    sourceAsOf: '2026-07-15T11:00:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${tag.repeat(64)}`,
    contentFingerprint: `fnv1a32:${tag.repeat(8)}`,
    sourceFileName: `incoming-${tag}.csv`,
    fileLastModified: '2026-07-15T09:30:00.000Z',
  }
}

function v3Snapshot(csvImportProvenance: CsvImportProvenance, overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = {
    schemaVersion: 'portfolio-snapshot-3',
    exportedAt: '2026-07-15T12:30:00.000Z',
    csvImportedAt: csvImportProvenance.importedAt,
    csvImportProvenance,
    source: 'manual',
    holdings: [{ code: 'E2E-A1', name: 'E2E銘柄', eval: 100_000, pnlPct: 0 }],
    trust: [{ id: 'fund-1', eval: 260_000, pnlPct: 3, dayPct: 0.1, account: '特定' }],
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

function expectNoLegacyKeys(rows: unknown[]): void {
  for (const row of rows) {
    expect(row).not.toHaveProperty('csv_name')
    expect(row).not.toHaveProperty('csv_account')
  }
}

describe('E2E-A1: legacy trust metadata through the supported canonical writers', () => {
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
    // Legacy device state: v81_portfolio + v81_trust (rows carry the historical keys), no
    // canonical generation. The store is hydrated the way buildInitializeRestoredState does
    // (restorePortfolio/restoreTrust), so the legacy read boundary is part of the fixture.
    persistPortfolio([holding()])
    persistTrust([legacyTrust()])
    expect(storage.v81_trust).toContain('csv_name')
    const hydratedHoldings = restorePortfolio()
    const hydratedTrust = restoreTrust()
    if (!hydratedHoldings || !hydratedTrust) throw new Error('legacy hydration fixture failed')
    useAppStore.setState(state => ({
      holdings: hydratedHoldings,
      trust: hydratedTrust,
      correlation: null,
      market: baseMarket,
      safeMode: baseSafeMode,
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
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
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
        dataSourceOutcome: { loaded: 14, total: 14 },
      },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalFileReader) globalThis.FileReader = originalFileReader
  })

  it('T9: a supported SBI CSV import with legacy trust rows commits a canonical v5 generation', async () => {
    const legacyRawBefore = storage.v81_trust
    expect(legacyRawBefore).toContain('csv_name')

    const result = await useAppStore.getState().importCsv(csvFile())

    expect(result).toMatchObject({
      ok: true,
      analysisCommitted: true,
      officialDecisionCommitted: true,
      persistence: { status: 'committed' },
    })
    if (!result.ok) throw new Error('expected successful import')
    expect(result.diagnostics).toMatchObject({
      recognizedStockRows: 1,
      recognizedTrustRows: 1,
      matchedTrustRows: 1,
      failedGuard: null,
      committed: true,
    })

    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expect(restored.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V5)
    expect(restored.payload.origin).toBe('csv')
    expect(restored.payload.trust).toHaveLength(1)
    expect(restored.payload.trust[0]).toMatchObject({ id: 'fund-1', eval: 250_000 })
    expectNoLegacyKeys(restored.payload.trust)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain('csv_name')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain('csv_account')

    // Decision-relevant trust values survive the projection.
    const committed = restored.payload.trust[0]
    const source = cleanTrust()
    for (const key of ['id', 'name', 'abbr', 'account', 'policy', 'cost', 'mu', 'sigma'] as const) {
      expect(committed[key]).toBe(source[key])
    }

    // Legacy bytes are left alone by this repair (no migration/rewrite in this ticket).
    expect(storage.v81_trust).toBe(legacyRawBefore)
    // restoreTrust() now defers to the canonical generation.
    expect(restoreTrust()).toEqual(restored.payload.trust)

    // Store/canonical alignment: the published rows equal the committed rows, so the next manual
    // action is not rejected as CROSS_TAB_STATE_STALE.
    const state = useAppStore.getState()
    expect(state.trust).toEqual(restored.payload.trust)
    expectNoLegacyKeys(state.trust)
    const manual = await useAppStore.getState().updateTrust('fund-1', { notForTrading: true })
    expect(manual).toMatchObject({ ok: true })
  })

  it('T10: a supported snapshot import with legacy trust rows commits through the same writer boundary', async () => {
    // Snapshot import is only allowed without current portfolio content evidence (by design:
    // SNAPSHOT_OVERWRITE_BLOCKED otherwise). Model an unheld legacy registry: v81_trust rows
    // that carry the historical keys with eval 0, an empty v81_portfolio, default policy/cash,
    // hydrated through the same legacy read boundary as a real boot.
    const unheldLegacy = { ...legacyTrust(), eval: 0, pnlPct: 0, dayPct: 0 } as Trust
    persistPortfolio([])
    persistTrust([unheldLegacy])
    expect(storage.v81_trust).toContain('csv_name')
    useAppStore.setState({ holdings: restorePortfolio() ?? [], trust: restoreTrust() ?? [] })
    const raw = v3Snapshot(incomingProvenance('a'))

    const result = await useAppStore.getState().importPortfolioSnapshot(raw)

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expect(restored.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V5)
    expect(restored.payload.origin).toBe('snapshot')
    expect(restored.payload.trust).toHaveLength(1)
    expect(restored.payload.trust[0]).toMatchObject({ id: 'fund-1', eval: 260_000, pnlPct: 3 })
    expectNoLegacyKeys(restored.payload.trust)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain('csv_name')
    expect(useAppStore.getState().trust).toEqual(restored.payload.trust)
  })

  it('legacy hydration path: rows restored from v81_trust are canonical-shaped and value-identical while the bytes keep the keys', () => {
    // Simulate the real boot: canonical status none → legacy restore.
    expect(restoreTrust()).toEqual([cleanTrust()])
    expect(storage.v81_trust).toContain('csv_name')
    expect(storage.v81_trust).toContain('csv_account')
  })

  it('legacy-mode manual actions stay aligned with the projected legacy read (no false CROSS_TAB_STATE_STALE)', async () => {
    const manual = await useAppStore.getState().updateTrust('fund-1', { notForTrading: true })
    expect(manual).toMatchObject({ ok: true })
    expect(useAppStore.getState().trust[0]).toMatchObject({ id: 'fund-1', notForTrading: true })
    expectNoLegacyKeys(useAppStore.getState().trust)
  })

  it('writer boundary alone still commits when a store somehow carries legacy keys (canonical bytes stay clean)', async () => {
    // Defense in depth: even if rows with legacy keys reach the writer (e.g. a caller that
    // bypassed the legacy read boundary), the canonical payload is projected and committed.
    // Legacy persistence is cleared so this scenario is evaluated purely at the writer.
    delete storage.v81_portfolio
    delete storage.v81_trust
    useAppStore.setState({ trust: [legacyTrust()] })
    const result = await useAppStore.getState().importCsv(csvFile())
    expect(result).toMatchObject({ ok: true, persistence: { status: 'committed' } })
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expectNoLegacyKeys(restored.payload.trust)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain('csv_name')
  })
})
