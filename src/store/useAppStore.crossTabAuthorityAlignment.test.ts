// OPS-SBI-P2-PREBUILD-PHASE2-R1-AUTHORITY-INTEGRITY-REPAIR (P2-02): inspectDurablePortfolioAlignment
// must include portfolioImportAuthority in its semantic comparison/identity domain, so a stale
// tab whose importAuthority differs from the durable canonical is rejected even when holdings/
// trust/policy/cash/CSV metadata are byte-identical (ticket sections 5/6). Uses the same
// established harness pattern as useAppStore.snapshotImportAtomic.r3d.test.ts (module-global
// useAppStore + a direct persistCsvImportTransaction canonical seed).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { resetPortfolioGenerationLockAdapterForTest, setPortfolioGenerationLockAdapterForTest } from './useAppStore'

beforeEach(() => setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest()))
afterEach(() => resetPortfolioGenerationLockAdapterForTest())
import type { Holding, PortfolioImportAuthorityV1 } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY, LEGACY_UNPROVEN_PORTFOLIO_IMPORT_AUTHORITY } from '../types'
import { useAppStore } from './useAppStore'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V6,
  persistCsvImportTransaction,
  type CsvImportPersistencePayload,
} from './persist'

const baseMarket = useAppStore.getState().market
const baseSafeMode = useAppStore.getState().safeMode
const baseCandidatesNews = useAppStore.getState().candidatesNews
const baseCandidatesStocks = useAppStore.getState().candidatesStocks
const baseRegimeState = useAppStore.getState().regimeState

const FIXED_NOW = new Date('2026-09-12T00:00:00.000Z')

function holding(code = '9999', evalValue = 200_000): Holding {
  return {
    code, name: `銘柄${code}`, eval: evalValue, pnlPct: 1, mu: 0.08, sigma: 0.2,
    sigmaSource: 'static', beta: 1, sector: 'テスト', target: 0, alert: 0,
    lock: false, mitsu: false, ma: true, rsi: 50, macd: true, vol: false, mom3m: 0,
    roe: 10, per: 15, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 1,
    score: 50, decision: 'HOLD', ev: 0,
  }
}

const COMPLETE_AUTHORITY: PortfolioImportAuthorityV1 = {
  authorityVersion: 'portfolio-import-authority-1',
  importMode: 'FULL_EXPORT',
  contractVersion: 'sbi-portfolio-import-2',
  profileId: 'sbi-portfolio-v1',
  authorityStatus: 'COMPLETE',
  selectedAssetClasses: null,
  preservedAssetClasses: null,
  provenanceScope: 'FULL_EXPORT',
  sectionCompleteness: [
    { sectionId: 'JP_STOCK_CUSTODY', status: 'VALID_NONEMPTY' },
    { sectionId: 'TRUST_TAXABLE', status: 'VALID_EMPTY' },
    { sectionId: 'TRUST_NISA_GROWTH', status: 'VALID_EMPTY' },
    { sectionId: 'TRUST_NISA_ACCUMULATION', status: 'VALID_EMPTY' },
  ],
}

const PARTIAL_AUTHORITY: PortfolioImportAuthorityV1 = {
  ...COMPLETE_AUTHORITY,
  importMode: 'PARTIAL_IMPORT',
  authorityStatus: 'PARTIAL',
  selectedAssetClasses: ['JP_STOCK'],
  preservedAssetClasses: ['INVESTMENT_TRUST'],
  provenanceScope: 'PARTIAL_IMPORT',
}

describe('P2-02: cross-tab durable alignment includes importAuthority', () => {
  const storage: Record<string, string> = {}
  const writeLog: string[] = []
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { writeLog.push(key); storage[key] = value },
    removeItem: (key: string) => { delete storage[key] },
  }

  function canonicalPayload(importAuthority: PortfolioImportAuthorityV1 | null): CsvImportPersistencePayload {
    return {
      holdings: [holding()],
      trust: [],
      learning: null,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-09-01', total: 0, evalById: {} },
      portfolioPolicy: DEFAULT_PORTFOLIO_POLICY,
      cashAssumptions: DEFAULT_CASH_ASSUMPTIONS,
      origin: 'snapshot',
      snapshotTransferIdentity: null,
      ...(importAuthority ? { importAuthority } : {}),
    }
  }

  // committed canonical世代をseedし、seed書込自体をwriteLogから除外して返す。
  function seedCommittedCanonical(importAuthority: PortfolioImportAuthorityV1 | null): string {
    persistCsvImportTransaction(
      canonicalPayload(importAuthority),
      Date.parse('2026-09-11T03:00:00.000Z'),
      undefined,
      { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V6 },
    )
    writeLog.length = 0
    return storage[CSV_IMPORT_GENERATION_KEY]
  }

  // publishedなlive stateをcanonicalのholdings/trust/policy/cash/csvと一致させ、
  // importAuthorityだけを差し替える（それ以外の全フィールドは意図的に同一）。
  function setPublishedState(importAuthority: PortfolioImportAuthorityV1): void {
    useAppStore.setState(state => ({
      holdings: [holding()],
      trust: [],
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
      portfolioImportAuthority: importAuthority,
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
      },
    }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    writeLog.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('case 1: COMPLETE v6 current vs identical LEGACY_UNPROVEN stale writer → stale writer rejected', async () => {
    const seededRaw = seedCommittedCanonical(COMPLETE_AUTHORITY)
    setPublishedState(LEGACY_UNPROVEN_PORTFOLIO_IMPORT_AUTHORITY)
    const before = useAppStore.getState()

    const result = await useAppStore.getState().updateHolding('9999', { eval: 999_999 })

    expect(result).toMatchObject({ ok: false, operation: 'updateHolding', code: 'CROSS_TAB_STATE_STALE' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(seededRaw)
    expect(useAppStore.getState()).toBe(before)
    expect(writeLog.length).toBe(0)
  })

  it('case 2: COMPLETE v6 current vs identical PARTIAL stale writer → rejected', async () => {
    const seededRaw = seedCommittedCanonical(COMPLETE_AUTHORITY)
    setPublishedState(PARTIAL_AUTHORITY)
    const before = useAppStore.getState()

    const result = await useAppStore.getState().updateHolding('9999', { eval: 999_999 })

    expect(result).toMatchObject({ ok: false, operation: 'updateHolding', code: 'CROSS_TAB_STATE_STALE' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(seededRaw)
    expect(useAppStore.getState()).toBe(before)
  })

  it('case 3: identical COMPLETE authority and identical portfolio → aligned, the write proceeds normally', async () => {
    seedCommittedCanonical(COMPLETE_AUTHORITY)
    setPublishedState(COMPLETE_AUTHORITY)

    const result = await useAppStore.getState().updateHolding('9999', { eval: 999_999 })

    expect(result).toMatchObject({ ok: true })
    expect(useAppStore.getState().holdings.find(h => h.code === '9999')?.eval).toBe(999_999)
    // Authority-preserving replacement write: the v6 tier and its COMPLETE authority survive
    // this otherwise-unrelated manual field edit (P5-B005-B4-A precedent, untouched by P2).
    expect(useAppStore.getState().portfolioImportAuthority).toEqual(COMPLETE_AUTHORITY)
  })

  it('case 4: authority differs only in sectionCompleteness → treated as a different generation (stale writer rejected)', async () => {
    const differentSections: PortfolioImportAuthorityV1 = {
      ...COMPLETE_AUTHORITY,
      sectionCompleteness: COMPLETE_AUTHORITY.sectionCompleteness.map(entry =>
        entry.sectionId === 'TRUST_TAXABLE' ? { ...entry, status: 'VALID_NONEMPTY' } : entry),
    }
    const seededRaw = seedCommittedCanonical(COMPLETE_AUTHORITY)
    setPublishedState(differentSections)
    const before = useAppStore.getState()

    const result = await useAppStore.getState().updateHolding('9999', { eval: 999_999 })

    expect(result).toMatchObject({ ok: false, operation: 'updateHolding', code: 'CROSS_TAB_STATE_STALE' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(seededRaw)
    expect(useAppStore.getState()).toBe(before)
  })

  it('case 5: authority differs only in contractVersion/profileId → treated as a different generation (stale writer rejected)', async () => {
    const differentProfile: PortfolioImportAuthorityV1 = {
      ...COMPLETE_AUTHORITY,
      contractVersion: 'sbi-portfolio-import-999',
      profileId: 'other-profile-v1',
    }
    const seededRaw = seedCommittedCanonical(COMPLETE_AUTHORITY)
    setPublishedState(differentProfile)
    const before = useAppStore.getState()

    const result = await useAppStore.getState().updateHolding('9999', { eval: 999_999 })

    expect(result).toMatchObject({ ok: false, operation: 'updateHolding', code: 'CROSS_TAB_STATE_STALE' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(seededRaw)
    expect(useAppStore.getState()).toBe(before)
  })

  it('a stale LEGACY_UNPROVEN tab must not overwrite a COMPLETE generation even via a no-op-looking write', async () => {
    seedCommittedCanonical(COMPLETE_AUTHORITY)
    setPublishedState(LEGACY_UNPROVEN_PORTFOLIO_IMPORT_AUTHORITY)
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]

    // Even a patch that would be a semantic no-op against the (stale) live value must still be
    // rejected before it can observe/derive anything from the mismatched durable generation.
    const result = await useAppStore.getState().updateHolding('9999', { eval: 200_000 })

    expect(result).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
  })
})
