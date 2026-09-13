import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  persistPortfolioPolicy, restorePortfolioPolicy,
  persistCashAssumptions, restoreCashAssumptions,
  persistPortfolio, restorePortfolio, getPortfolioStorageFreshness,
  persistTrust, restoreTrust, getTrustStorageFreshness,
  persistCsvSyncSummary, restoreCsvSyncSummary,
  persistCsvImportTransaction, CsvImportPersistenceError,
  restoreCsvImportGenerationFromRaw,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  CSV_IMPORT_GENERATION_SCHEMA_V6,
  CSV_IMPORT_GENERATION_KEY,
} from './persist'
import type { Holding, Trust, CsvSyncSummary, PortfolioImportAuthorityV1 } from '../types'
import { DEFAULT_PORTFOLIO_POLICY, DEFAULT_CASH_ASSUMPTIONS } from '../types'

const POLICY_KEY = 'v13_portfolio_policy'
const CASH_ASSUMPTIONS_KEY = 'v13_cash_assumptions'
const PORTFOLIO_KEY = 'v81_portfolio'
const TRUST_KEY = 'v81_trust'
const CSV_SYNC_SUMMARY_KEY = 'v13_csv_sync_summary'
const TTL_7D = 7 * 24 * 60 * 60 * 1000
const TTL_90D = 90 * 24 * 60 * 60 * 1000

describe('F003: CSV persistence survives rollback failure', () => {
  it('never restores a partially written generation when primary write and rollback both fail', () => {
    const oldHoldings = [{ code: 'OLD', eval: 10 }] as unknown as Holding[]
    const newHoldings = [{ code: 'NEW', eval: 20 }] as unknown as Holding[]
    const oldTrust = [{ id: 'old-fund', eval: 30 }] as unknown as Trust[]
    const newTrust = [{ id: 'new-fund', eval: 40 }] as unknown as Trust[]
    const store: Record<string, string> = {
      [PORTFOLIO_KEY]: JSON.stringify({ data: oldHoldings, savedAt: 1 }),
      [TRUST_KEY]: JSON.stringify({ data: oldTrust, savedAt: 1 }),
    }
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: () => { throw new Error('persistent primary quota failure') },
      removeItem: () => { throw new Error('rollback removeItem failure') },
    })

    expect(() => persistCsvImportTransaction({
      holdings: newHoldings,
      trust: newTrust,
      learning: null,
      importedAt: '2026-07-15T00:00:00.000Z',
      syncSummary: {
        importedAt: '2026-07-15T00:00:00.000Z',
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: { date: '2026-07-15', total: 40, evalById: { 'new-fund': 40 } },
    })).toThrow(CsvImportPersistenceError)

    expect(restorePortfolio()).toEqual(oldHoldings)
    expect(restoreTrust()).toEqual(oldTrust)
  })
})

describe('PortfolioPolicy persist/restore', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('保存するとkey=v13_portfolio_policyにjpStockMaxRatioとsavedAtが格納される', () => {
    persistPortfolioPolicy({ jpStockMaxRatio: 0.08 })
    const snap = JSON.parse(store[POLICY_KEY])
    expect(snap.data.jpStockMaxRatio).toBe(0.08)
    expect(typeof snap.savedAt).toBe('number')
  })

  it.each([0.08, 0.10, 0.15])('valid ratio %s を保存→復元できる', (ratio) => {
    persistPortfolioPolicy({ jpStockMaxRatio: ratio })
    expect(restorePortfolioPolicy()).toEqual({ jpStockMaxRatio: ratio })
  })

  it('壊れたJSONはnull（fail-closed）', () => {
    store[POLICY_KEY] = 'corrupted{'
    expect(restorePortfolioPolicy()).toBeNull()
  })

  it.each([0.049, 0.301])('範囲外ratio %s はnull', (ratio) => {
    store[POLICY_KEY] = JSON.stringify({ data: { jpStockMaxRatio: ratio }, savedAt: Date.now() })
    expect(restorePortfolioPolicy()).toBeNull()
  })

  it('non-number ratio はnull', () => {
    store[POLICY_KEY] = JSON.stringify({ data: { jpStockMaxRatio: '0.10' }, savedAt: Date.now() })
    expect(restorePortfolioPolicy()).toBeNull()
  })

  it('TTL切れはnullを返しkeyを削除する', () => {
    store[POLICY_KEY] = JSON.stringify({ data: { jpStockMaxRatio: 0.10 }, savedAt: Date.now() - TTL_7D - 1 })
    expect(restorePortfolioPolicy()).toBeNull()
    expect(store[POLICY_KEY]).toBeUndefined()
  })

  it('keyなしはnull', () => {
    expect(restorePortfolioPolicy()).toBeNull()
  })

  it('localStorage.getItemがthrowしてもnullでfail-closed', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('quota') }, setItem: () => {}, removeItem: () => {} })
    expect(restorePortfolioPolicy()).toBeNull()
  })
})

// ── P4.5-A002: 資金前提（現金・待機資金）手動override persist/restore ──
describe('CashAssumptions persist/restore', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('保存と復元で往復する（manualOverrideEnabled=true）', () => {
    persistCashAssumptions({ source: 'MANUAL', grossCash: 3_000_000, safetyReserve: 0, pendingOrderCash: null, updatedAt: '2026-07-04T00:00:00.000Z' })
    expect(restoreCashAssumptions()).toEqual({
      source: 'MANUAL',
      grossCash: 3_000_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-07-04T00:00:00.000Z',
    })
  })

  it('保存と復元で往復する（manualOverrideEnabled=false, manualUpdatedAt=null）', () => {
    persistCashAssumptions({ source: 'DEFAULT', grossCash: 0, safetyReserve: 0, pendingOrderCash: null, updatedAt: null })
    expect(restoreCashAssumptions()).toEqual({
      source: 'DEFAULT',
      grossCash: 0,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: null,
    })
  })

  it('壊れたJSONはnull（fail-closed）', () => {
    store[CASH_ASSUMPTIONS_KEY] = 'corrupted{'
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('grossCashが負の場合はnull', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({ data: { source: 'MANUAL', grossCash: 100, safetyReserve: -1, pendingOrderCash: null, updatedAt: '2026-06-01T00:00:00.000Z' }, savedAt: Date.now() })
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('safetyReserveが不正な場合はnull', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({ data: { source: 'MANUAL', grossCash: -1, safetyReserve: 0, pendingOrderCash: null, updatedAt: null }, savedAt: Date.now() })
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('grossCashが数値でない場合はnull', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({ data: { source: 'MANUAL', grossCash: '1000', safetyReserve: 0, pendingOrderCash: null, updatedAt: null }, savedAt: Date.now() })
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('legacy manualOverrideEnabledがbooleanでない場合はnull', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({ data: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: 'true', manualUpdatedAt: null }, savedAt: Date.now() })
    expect(restoreCashAssumptions()).toBeNull()
  })

  // P4.5-A008: 資金前提はTTL失効による無警告revertを廃止した。savedAtがどれだけ古くても
  // 有効なデータである限り復元する（鮮度警告はselectCashAssumptionsFreshnessが別途担う）。
  it('savedAtが7日超過（旧TTL相当）でも有効なcashAssumptionsは復元される', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: { source: 'MANUAL', grossCash: 6_912_000, safetyReserve: 0, pendingOrderCash: null, updatedAt: '2026-06-01T00:00:00.000Z' },
      savedAt: Date.now() - TTL_7D - 1,
    })
    expect(restoreCashAssumptions()).toEqual({
      source: 'MANUAL',
      grossCash: 6_912_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-06-01T00:00:00.000Z',
    })
    expect(store[CASH_ASSUMPTIONS_KEY]).toBeDefined()
  })

  it('savedAtが1年超過でも有効なcashAssumptionsは復元される（TTL撤廃の確認）', () => {
    const oneYearMs = 365 * 24 * 60 * 60 * 1000
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: { source: 'MANUAL', grossCash: 300, safetyReserve: 0, pendingOrderCash: null, updatedAt: '2026-06-01T00:00:00.000Z' },
      savedAt: Date.now() - oneYearMs,
    })
    expect(restoreCashAssumptions()).toEqual({
      source: 'MANUAL',
      grossCash: 300,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-06-01T00:00:00.000Z',
    })
  })

  // CASH-AUTH-1: 保存済みレコードの数値契約・時刻契約を restore 側でも fail closed する
  it('CASH-AUTH-1: updatedAt欠損のMANUALレコードはnull（無警告でfreshにしない）', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: { source: 'MANUAL', grossCash: 300, safetyReserve: 0, pendingOrderCash: null, updatedAt: null },
      savedAt: Date.now(),
    })
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('CASH-AUTH-1: 準備金合計が総現金を超える保存値はnull（1円の二重確保を許さない）', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: {
        source: 'MANUAL', grossCash: 1_000_000, safetyReserve: 800_000,
        pendingOrderCash: 300_000, updatedAt: '2026-06-01T00:00:00.000Z',
      },
      savedAt: Date.now(),
    })
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('CASH-AUTH-1: legacy スキーマは一度だけ合算して現行スキーマへ移行される', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: {
        cashDeposits: 1_000_000, standbyFunds: 2_000_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-06-01T00:00:00.000Z',
      },
      savedAt: Date.now(),
    })
    const restored = restoreCashAssumptions()
    expect(restored).toEqual({
      source: 'MANUAL',
      grossCash: 3_000_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-06-01T00:00:00.000Z',
    })
    // 冪等: 移行結果を保存し直しても金額は変わらない
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({ data: restored, savedAt: Date.now() })
    expect(restoreCashAssumptions()).toEqual(restored)
  })

  it('CASH-AUTH-1: legacy manualOverrideEnabled=false は権限なしへ移行する', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: {
        cashDeposits: 1_000_000, standbyFunds: 2_000_000,
        manualOverrideEnabled: false, manualUpdatedAt: null,
      },
      savedAt: Date.now(),
    })
    expect(restoreCashAssumptions()).toEqual({
      source: 'DEFAULT', grossCash: 0, safetyReserve: 0, pendingOrderCash: null, updatedAt: null,
    })
  })

  it('CASH-AUTH-1: legacy manualUpdatedAt欠損は現在時刻を捏造せず権限なしへ倒す', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: {
        cashDeposits: 1_000_000, standbyFunds: 2_000_000,
        manualOverrideEnabled: true, manualUpdatedAt: null,
      },
      savedAt: Date.now(),
    })
    expect(restoreCashAssumptions()).toEqual({
      source: 'DEFAULT', grossCash: 0, safetyReserve: 0, pendingOrderCash: null, updatedAt: null,
    })
  })

  it('CASH-AUTH-1: legacy addRoom は移行されず grossCash にも加算されない', () => {
    store[CASH_ASSUMPTIONS_KEY] = JSON.stringify({
      data: {
        cashDeposits: 1_000_000, standbyFunds: 2_000_000, addRoom: 5_000_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-06-01T00:00:00.000Z',
      },
      savedAt: Date.now(),
    })
    expect(restoreCashAssumptions()?.grossCash).toBe(3_000_000)
  })

  it('keyなしはnull', () => {
    expect(restoreCashAssumptions()).toBeNull()
  })

  it('localStorage.getItemがthrowしてもnullでfail-closed', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('quota') }, setItem: () => {}, removeItem: () => {} })
    expect(restoreCashAssumptions()).toBeNull()
  })
})

// P4.5-A012d: holdings/trustのTTL失効による無警告revertを廃止し、
// cashAssumptions（P4.5-A008）と同じ「値保持 + stale警告」方式へ寄せる
describe('Portfolio/Trust persist/restore（P4.5-A012d: TTL失効時も値を保持する）', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const testHoldings = [{ code: 'TEST-A', eval: 100_000, pnlPct: 5 }] as unknown as Holding[]
  const testTrust = [{ id: 'trust-a', eval: 500_000, pnlPct: 3 }] as unknown as Trust[]

  it('restorePortfolio: TTL内で保存値を返す', () => {
    persistPortfolio(testHoldings)
    expect(restorePortfolio()).toEqual(testHoldings)
  })

  it('restorePortfolio: TTL超過後も保存値を返し、removeItemしない', () => {
    store[PORTFOLIO_KEY] = JSON.stringify({ data: testHoldings, savedAt: Date.now() - TTL_7D - 1 })
    expect(restorePortfolio()).toEqual(testHoldings)
    expect(store[PORTFOLIO_KEY]).toBeDefined()
  })

  it('restorePortfolio: keyなしはnull', () => {
    expect(restorePortfolio()).toBeNull()
  })

  it('restorePortfolio: 壊れたJSONはnull（fail-closed）', () => {
    store[PORTFOLIO_KEY] = 'corrupted{'
    expect(restorePortfolio()).toBeNull()
  })

  it('restoreTrust: TTL内で保存値を返す', () => {
    persistTrust(testTrust)
    expect(restoreTrust()).toEqual(testTrust)
  })

  it('restoreTrust: TTL超過後も保存値を返し、removeItemしない', () => {
    store[TRUST_KEY] = JSON.stringify({ data: testTrust, savedAt: Date.now() - TTL_7D - 1 })
    expect(restoreTrust()).toEqual(testTrust)
    expect(store[TRUST_KEY]).toBeDefined()
  })

  it('restoreTrust: keyなしはnull', () => {
    expect(restoreTrust()).toBeNull()
  })

  it('getPortfolioStorageFreshness: 未保存はexists=false/isStale=false', () => {
    expect(getPortfolioStorageFreshness()).toEqual({ exists: false, isStale: false, savedAt: null, ageDays: null })
  })

  it('getPortfolioStorageFreshness: TTL内はexists=true/isStale=false', () => {
    const savedAt = Date.now() - 1000
    store[PORTFOLIO_KEY] = JSON.stringify({ data: testHoldings, savedAt })
    const freshness = getPortfolioStorageFreshness()
    expect(freshness.exists).toBe(true)
    expect(freshness.isStale).toBe(false)
    expect(freshness.savedAt).toBe(savedAt)
    expect(freshness.ageDays).not.toBeNull()
  })

  it('getPortfolioStorageFreshness: TTL超過はexists=true/isStale=true', () => {
    const savedAt = Date.now() - TTL_7D - 1000
    store[PORTFOLIO_KEY] = JSON.stringify({ data: testHoldings, savedAt })
    const freshness = getPortfolioStorageFreshness()
    expect(freshness.exists).toBe(true)
    expect(freshness.isStale).toBe(true)
  })

  it('getPortfolioStorageFreshness: 壊れたJSONはexists=false（fail-closed、例外を投げない）', () => {
    store[PORTFOLIO_KEY] = 'corrupted{'
    expect(getPortfolioStorageFreshness()).toEqual({ exists: false, isStale: false, savedAt: null, ageDays: null })
  })

  it('getTrustStorageFreshness: 未保存はexists=false', () => {
    expect(getTrustStorageFreshness()).toEqual({ exists: false, isStale: false, savedAt: null, ageDays: null })
  })

  it('getTrustStorageFreshness: TTL超過はisStale=true', () => {
    store[TRUST_KEY] = JSON.stringify({ data: testTrust, savedAt: Date.now() - TTL_7D - 1000 })
    expect(getTrustStorageFreshness().isStale).toBe(true)
  })

  it('getTrustStorageFreshness: TTL内はisStale=false', () => {
    store[TRUST_KEY] = JSON.stringify({ data: testTrust, savedAt: Date.now() - 1000 })
    expect(getTrustStorageFreshness().isStale).toBe(false)
  })
})

describe('CsvSyncSummary persist/restore（P4.5-A013-T6）', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const testSummary: CsvSyncSummary = {
    importedAt: '2026-07-11T05:00:00.000Z',
    stock: { updated: 2, added: 1, removed: 1 },
    trust: { updated: 3, reheld: 1, zeroed: 1, unknownFunds: [{ name: '謎の投信', eval: 50_000 }], ambiguousFundIds: ['dup_a', 'dup_b'] },
  }

  it('restoreCsvSyncSummary: keyなしはnull', () => {
    expect(restoreCsvSyncSummary()).toBeNull()
  })

  it('restoreCsvSyncSummary: TTL内（fresh）で保存値を返す', () => {
    persistCsvSyncSummary(testSummary)
    expect(restoreCsvSyncSummary()).toEqual(testSummary)
  })

  it('restoreCsvSyncSummary: TTL超過（stale）はnullを返しremoveItemする', () => {
    const staleSummary = {
      ...testSummary,
      importedAt: new Date(Date.now() - TTL_90D - 1000).toISOString(),
    }
    store[CSV_SYNC_SUMMARY_KEY] = JSON.stringify({ data: staleSummary, savedAt: Date.now() })
    expect(restoreCsvSyncSummary()).toBeNull()
    expect(store[CSV_SYNC_SUMMARY_KEY]).toBeUndefined()
  })

  it('restoreCsvSyncSummary: 壊れたJSONはnull（fail-closed、例外を投げない）', () => {
    store[CSV_SYNC_SUMMARY_KEY] = 'corrupted{'
    expect(restoreCsvSyncSummary()).toBeNull()
  })
})

// OPS-SBI-P2-PREBUILD-PHASE2: canonical envelope v6 (importAuthority).
describe('canonical v6 (importAuthority) persist/restore', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
  })
  afterEach(() => { vi.unstubAllGlobals() })

  function buildHolding(overrides: Partial<Holding> = {}): Holding {
    return {
      code: '6501', name: '日立製作所', eval: 900_000, pnlPct: 15.2, mu: 0.1, sigma: 0.2,
      sigmaSource: 'static', beta: 1.0, sector: '未分類', target: 0, alert: 0, lock: false,
      mitsu: false, ma: false, rsi: 50, macd: false, vol: false, mom3m: 0, roe: 0, per: 0,
      pbr: 0, epsG: 0, cfOk: false, de: 1.5, divG: 0, score: 0, decision: 'HOLD', ev: 0,
      ...overrides,
    }
  }

  function buildTrust(overrides: Partial<Trust> = {}): Trust {
    return {
      id: 'sp500_sbi', name: 'SBI V S&P500', abbr: 'S&P500', account: '特定', policy: 'OVERSEAS_LONGTERM',
      eval: 4_500_000, pnlPct: 95.5, dayPct: -1.8, cost: 0.06, mu: 0.14, sigma: 0.17,
      score: 0, signal: 'HOLD', ev: 0, decision: 'HOLD',
      ...overrides,
    }
  }

  // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (RA-P3-01): a genuine COMPLETE authority always carries a
  // sectionCompleteness entry for every required section (see
  // isSemanticallyValidPortfolioImportAuthority in sbiPortfolioAuthorityV2.ts) — the v6 envelope
  // admission gate now enforces that same semantic predicate, not just the structural shape.
  const completeAuthority: PortfolioImportAuthorityV1 = {
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
      { sectionId: 'TRUST_TAXABLE', status: 'VALID_NONEMPTY' },
      { sectionId: 'TRUST_NISA_GROWTH', status: 'VALID_EMPTY' },
      { sectionId: 'TRUST_NISA_ACCUMULATION', status: 'VALID_EMPTY' },
    ],
  }

  function persistV6(overrides: { holdings?: Holding[]; trust?: Trust[]; importAuthority?: PortfolioImportAuthorityV1 } = {}) {
    return persistCsvImportTransaction({
      holdings: overrides.holdings ?? [buildHolding()],
      trust: overrides.trust ?? [buildTrust()],
      learning: null,
      csvImportedAt: '2026-09-12T00:00:00+09:00',
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-09-12', total: 0, evalById: {} },
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      origin: null,
      snapshotGenerationIdentity: null,
      snapshotTransferIdentity: null,
      importAuthority: overrides.importAuthority ?? completeAuthority,
    }, Date.now(), undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V6 })
  }

  it('test 1: v6 COMPLETE round-trip persists exact authority', () => {
    persistV6()
    const restored = restoreCsvImportGenerationFromRaw(store[CSV_IMPORT_GENERATION_KEY])
    expect(restored.status).toBe('committed')
    if (restored.status === 'committed') {
      expect(restored.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V6)
      expect(restored.payload.importAuthority).toEqual(completeAuthority)
    }
  })

  it('test 9: a malformed v6 authority object is rejected fail-closed', () => {
    persistV6()
    const raw = store[CSV_IMPORT_GENERATION_KEY]
    const envelope = JSON.parse(raw)
    envelope.payload.importAuthority = { ...completeAuthority, authorityStatus: 'NOT_A_REAL_STATUS' }
    // Re-point the checksum-unaware corruption at storage directly (bypassing the writer).
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)
    expect(restoreCsvImportGenerationFromRaw(store[CSV_IMPORT_GENERATION_KEY]).status).toBe('invalid')
  })

  it('test 10: an unknown future authorityVersion fails closed', () => {
    persistV6()
    const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    envelope.payload.importAuthority = { ...completeAuthority, authorityVersion: 'portfolio-import-authority-99' }
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)
    expect(restoreCsvImportGenerationFromRaw(store[CSV_IMPORT_GENERATION_KEY]).status).toBe('invalid')
  })

  it('a v6 envelope missing importAuthority entirely fails closed (exact-key contract)', () => {
    persistV6()
    const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    delete envelope.payload.importAuthority
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)
    expect(restoreCsvImportGenerationFromRaw(store[CSV_IMPORT_GENERATION_KEY]).status).toBe('invalid')
  })

  it('v5 and v6 payloads with equivalent content never share a canonical identity', () => {
    persistV6()
    const v6Identity = restoreCsvImportGenerationFromRaw(store[CSV_IMPORT_GENERATION_KEY])
    for (const k in store) delete store[k]
    persistCsvImportTransaction({
      holdings: [buildHolding()],
      trust: [buildTrust()],
      learning: null,
      csvImportedAt: '2026-09-12T00:00:00+09:00',
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-09-12', total: 0, evalById: {} },
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      origin: null,
      snapshotGenerationIdentity: null,
      snapshotTransferIdentity: null,
    }, Date.now(), undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
    const v5Identity = restoreCsvImportGenerationFromRaw(store[CSV_IMPORT_GENERATION_KEY])
    expect(v6Identity.status).toBe('committed')
    expect(v5Identity.status).toBe('committed')
    if (v6Identity.status === 'committed' && v5Identity.status === 'committed') {
      expect(v6Identity.generationId).not.toBe(v5Identity.generationId) // sanity: distinct writes
      expect((v6Identity.payload as { snapshotGenerationIdentity?: string }).snapshotGenerationIdentity)
        .not.toBe((v5Identity.payload as { snapshotGenerationIdentity?: string }).snapshotGenerationIdentity)
    }
  })
})
