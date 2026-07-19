import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Holding, Trust } from '../types'
import { useAppStore, shouldApplyPublishedSnapshot } from './useAppStore'
import { CSV_IMPORT_GENERATION_KEY, persistCsvImportTransaction } from './persist'

// P4.5-A013-T4:
// initialize/refreshAllDataは、published holdings/trust snapshot（data/holdings.json /
// data/trust_master.json、現在はP4.5-A010-1aにより公開停止済み）を、csvLastImportedAt
// との時刻比較なしに無条件でユーザーのholdings/trust状態へマージしていた。将来この
// 配信経路が復活した場合、古いsnapshotが最新のCSV取込・localStorage状態を過去へ
// 逆行させてしまうリスクがある。ここではshouldApplyPublishedSnapshotの単体挙動と、
// initialize/refreshAllDataへの実際の配線の両方を確認する。

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '7203',
    name: 'トヨタ自動車',
    eval: 500_000,
    pnlPct: 5,
    mu: 0.1,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1.0,
    sector: '輸送用機器',
    target: 1000,
    alert: 800,
    lock: false,
    mitsu: false,
    ma: true,
    rsi: 55,
    macd: true,
    vol: true,
    mom3m: 5,
    roe: 12,
    per: 15,
    pbr: 1.2,
    epsG: 10,
    cfOk: true,
    de: 0.5,
    divG: 3,
    score: 80,
    decision: 'HOLD',
    ev: 0,
    ...overrides,
  }
}

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'sp500_sbi',
    name: 'SBI・V・S&P500',
    abbr: 'S&P500',
    account: '特定',
    policy: 'OVERSEAS_LONGTERM',
    eval: 4_000_000,
    pnlPct: 90,
    dayPct: 0,
    cost: 0.2,
    mu: 0.1,
    sigma: 0.15,
    score: 50,
    signal: 'HOLD',
    ev: 0,
    decision: 'HOLD',
    ...overrides,
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

// ═══════════════════════════════════════════════════════════
// shouldApplyPublishedSnapshot: 純粋関数の単体テスト
// ═══════════════════════════════════════════════════════════
describe('shouldApplyPublishedSnapshot', () => {
  it('snapshotがcsvLastImportedAtより新しい場合はtrue（安全に適用）', () => {
    expect(shouldApplyPublishedSnapshot('2026-07-10T00:00:00+09:00', '2026-07-01T00:00:00+09:00')).toBe(true)
  })

  it('snapshotがcsvLastImportedAtより古い場合はfalse（最新CSVを保護）', () => {
    expect(shouldApplyPublishedSnapshot('2026-07-01T00:00:00+09:00', '2026-07-10T00:00:00+09:00')).toBe(false)
  })

  it('timestamp同値の場合はfalse（新しいユーザー状態を上書きしない）', () => {
    const t = '2026-07-10T00:00:00+09:00'
    expect(shouldApplyPublishedSnapshot(t, t)).toBe(false)
  })

  it('csvLastImportedAtがnull（保護すべき更新時刻がない）場合はtrue', () => {
    expect(shouldApplyPublishedSnapshot('2026-07-10T00:00:00+09:00', null)).toBe(true)
  })

  it('snapshotのtimestampが未設定（undefined）の場合はfail-safeでfalse', () => {
    expect(shouldApplyPublishedSnapshot(undefined, null)).toBe(false)
    expect(shouldApplyPublishedSnapshot(undefined, '2026-07-01T00:00:00+09:00')).toBe(false)
  })

  it('snapshotのtimestampがnullの場合はfail-safeでfalse', () => {
    expect(shouldApplyPublishedSnapshot(null, null)).toBe(false)
  })

  it('snapshotのtimestampがparse不能な文字列の場合はfail-safeでfalse', () => {
    expect(shouldApplyPublishedSnapshot('not-a-date', '2026-07-01T00:00:00+09:00')).toBe(false)
    expect(shouldApplyPublishedSnapshot('not-a-date', null)).toBe(false)
  })

  it('market形式（YYYY-MM-DD HH:MM、JST扱い）のtimestampも比較できる', () => {
    expect(shouldApplyPublishedSnapshot('2026-07-10 15:00', '2026-07-01T00:00:00+09:00')).toBe(true)
    expect(shouldApplyPublishedSnapshot('2026-07-01 15:00', '2026-07-10T00:00:00+09:00')).toBe(false)
  })

  it('csvLastImportedAtがparse不能な場合は保護対象なしとしてtrue', () => {
    expect(shouldApplyPublishedSnapshot('2026-07-10T00:00:00+09:00', 'corrupted')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// initialize / refreshAllData への配線の統合テスト
// ═══════════════════════════════════════════════════════════
function mockFetchRouter(handlers: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    for (const [key, data] of Object.entries(handlers)) {
      if (url.includes(key)) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) })
      }
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
  }))
}

describe('useAppStore.initialize / refreshAllData: published snapshot優先順位（P4.5-A013-T4）', () => {
  let store: Record<string, string>
  let writeLog: string[]
  const lsMock = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { writeLog.push(k); store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  function seedLocalStorage(opts: { holdings?: Holding[]; trust?: Trust[]; csvImportedAt?: string }) {
    if (opts.holdings) store['v81_portfolio'] = JSON.stringify({ data: opts.holdings, savedAt: Date.now() })
    if (opts.trust) store['v81_trust'] = JSON.stringify({ data: opts.trust, savedAt: Date.now() })
    if (opts.csvImportedAt) store['v10_csv_imported_at'] = JSON.stringify({ at: opts.csvImportedAt, savedAt: Date.now() })
  }

  beforeEach(() => {
    store = {}
    writeLog = []
    vi.stubGlobal('localStorage', lsMock)
    useAppStore.setState(state => ({
      system: { ...state.system, status: 'idle', csvLastImportedAt: null, csvImportProvenance: null },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('initialize: 最新CSV（新しいcsvLastImportedAt） > 古いpublished snapshot → CSV由来のholdingsが維持される', async () => {
    seedLocalStorage({
      holdings: [makeHolding({ code: '7203', eval: 555_000 })],
      csvImportedAt: '2026-07-10T10:00:00+09:00',
    })
    mockFetchRouter({
      'holdings.json': {
        last_updated: '2026-07-01T00:00:00+09:00', // csvより古い
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
    })

    await useAppStore.getState().initialize()

    const holding = useAppStore.getState().holdings.find(h => h.code === '7203')
    expect(holding?.eval).toBe(555_000)
  })

  it('initialize: clean committed envelope is hydrated as the canonical portfolio generation', async () => {
    const committedHolding = makeHolding({ code: '7203', eval: 654_321 })
    const committedTrust = makeTrust({ id: 'sp500_sbi', eval: 3_210_000 })
    persistCsvImportTransaction({
      holdings: [committedHolding],
      trust: [committedTrust],
      learning: null,
      importedAt: '2026-07-15T00:00:00.000Z',
      syncSummary: {
        importedAt: '2026-07-15T00:00:00.000Z',
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: { date: '2026-07-15', total: 0, evalById: {} },
      provenance: {
        importedAt: '2026-07-15T00:00:00.000Z',
        sourceAsOf: '2026-07-14T00:00:00.000Z',
        sourceAsOfKind: 'csv_explicit',
        sourceAsOfConfidence: 'authoritative',
        contentFingerprint: 'fnv1a32:12345678',
        sourceFileName: 'portfolio.csv',
        fileLastModified: null,
      },
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 1_250_000,
        standbyFunds: 350_000,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-14T12:00:00.000Z',
      },
      origin: 'csv',
    })
    store.v13_portfolio_policy = JSON.stringify({
      data: { jpStockMaxRatio: 0.15 },
      savedAt: Date.now(),
    })
    store.v13_cash_assumptions = JSON.stringify({
      data: {
        cashDeposits: 9,
        standbyFunds: 8,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2099-07-01T00:00:00.000Z',
      },
      savedAt: Date.now(),
    })
    mockFetchRouter({})
    useAppStore.setState(state => ({ system: { ...state.system, status: 'idle' } }))

    await useAppStore.getState().initialize()

    expect(useAppStore.getState().holdings.find(item => item.code === '7203')?.eval).toBe(654_321)
    expect(useAppStore.getState().trust.find(item => item.id === 'sp500_sbi')?.eval).toBe(3_210_000)
    expect(useAppStore.getState().system.csvLastImportedAt).toBe('2026-07-15T00:00:00.000Z')
    expect(useAppStore.getState().system.csvImportProvenance?.sourceAsOf).toBe('2026-07-14T00:00:00.000Z')
    expect(useAppStore.getState().portfolioPolicy).toEqual({ jpStockMaxRatio: 0.12 })
    expect(useAppStore.getState().cashAssumptions).toEqual({
      cashDeposits: 1_250_000,
      standbyFunds: 350_000,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-14T12:00:00.000Z',
    })
  })

  it.each([
    ['older', '2026-07-18T00:00:00.000Z'],
    ['newer', '2026-07-20T00:00:00.000Z'],
  ] as const)('RA-005: committed canonical with future sourceAsOf protects state from %s published snapshots without comparing the future value', async (_label, publishedAt) => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    const importedAt = '2026-07-18T00:00:00.000Z'
    const futureSourceAsOf = '2026-07-19T00:00:00.001Z'
    const committedHolding = makeHolding({ code: '7203', eval: 654_321 })
    const committedTrust = makeTrust({ id: 'sp500_sbi', eval: 3_210_000 })
    persistCsvImportTransaction({
      holdings: [committedHolding],
      trust: [committedTrust],
      learning: null,
      csvImportedAt: importedAt,
      syncSummary: {
        importedAt,
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: { date: '2026-07-19', total: 3_210_000, evalById: { sp500_sbi: 3_210_000 } },
      provenance: {
        importedAt,
        sourceAsOf: futureSourceAsOf,
        sourceAsOfKind: 'csv_explicit',
        sourceAsOfConfidence: 'authoritative',
        contentFingerprint: 'fnv1a32:12345678',
        sourceFileName: 'portfolio.csv',
        fileLastModified: null,
      },
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 1_250_000,
        standbyFunds: 350_000,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-18T00:00:00.000Z',
      },
      origin: 'csv',
    }, nowMs)
    mockFetchRouter({
      'holdings.json': {
        last_updated: publishedAt,
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
      'trust_master.json': {
        last_updated: publishedAt,
        source: 'sbi_csv',
        funds: [{ id: 'sp500_sbi', eval: 1_234_567 }],
      },
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs)

    await useAppStore.getState().initialize()

    const state = useAppStore.getState()
    expect(state.holdings.find(item => item.code === '7203')?.eval).toBe(654_321)
    expect(state.trust.find(item => item.id === 'sp500_sbi')?.eval).toBe(3_210_000)
    expect(state.system.csvLastImportedAt).toBeNull()
    expect(state.system.csvSyncSummary).toBeNull()
    expect(state.system.csvImportProvenance).toBeNull()
    expect(JSON.stringify(state.system)).not.toContain(futureSourceAsOf)
    nowSpy.mockRestore()
  })

  it('RA-005: refresh keeps committed canonical generation evidence when future importedAt makes csvLastImportedAt null', async () => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    const futureImportedAt = '2026-07-19T00:00:00.001Z'
    const committedHolding = makeHolding({ code: '7203', eval: 700_000 })
    const committedTrust = makeTrust({ id: 'sp500_sbi', eval: 4_000_000 })
    persistCsvImportTransaction({
      holdings: [committedHolding],
      trust: [committedTrust],
      learning: null,
      csvImportedAt: futureImportedAt,
      syncSummary: {
        importedAt: futureImportedAt,
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: { date: '2026-07-19', total: 4_000_000, evalById: { sp500_sbi: 4_000_000 } },
      provenance: {
        importedAt: futureImportedAt,
        sourceAsOf: '2026-07-18T00:00:00.000Z',
        sourceAsOfKind: 'csv_explicit',
        sourceAsOfConfidence: 'authoritative',
        contentFingerprint: 'fnv1a32:12345678',
        sourceFileName: 'portfolio.csv',
        fileLastModified: null,
      },
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 0, standbyFunds: 0,
        manualOverrideEnabled: false, manualUpdatedAt: null,
      },
      origin: 'csv',
    }, nowMs)
    useAppStore.setState(state => ({
      holdings: [committedHolding],
      trust: [committedTrust],
      system: {
        ...state.system,
        status: 'idle',
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
      },
    }))
    mockFetchRouter({
      'holdings.json': {
        last_updated: '2026-07-20T00:00:00.000Z',
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
      'trust_master.json': {
        last_updated: '2026-07-20T00:00:00.000Z',
        source: 'sbi_csv',
        funds: [{ id: 'sp500_sbi', eval: 1_234_567 }],
      },
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs)

    await useAppStore.getState().refreshAllData()

    expect(useAppStore.getState().holdings.find(item => item.code === '7203')?.eval).toBe(700_000)
    expect(useAppStore.getState().trust.find(item => item.id === 'sp500_sbi')?.eval).toBe(4_000_000)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
    nowSpy.mockRestore()
  })

  it('RA-005: canonical absent keeps the existing valid published snapshot application contract', async () => {
    useAppStore.setState(state => ({
      holdings: [makeHolding({ code: '7203', eval: 700_000 })],
      trust: [makeTrust({ id: 'sp500_sbi', eval: 4_000_000 })],
      system: {
        ...state.system,
        status: 'idle',
        csvLastImportedAt: null,
        csvImportProvenance: null,
      },
    }))
    mockFetchRouter({
      'holdings.json': {
        last_updated: '2026-07-20T00:00:00.000Z',
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
      'trust_master.json': {
        last_updated: '2026-07-20T00:00:00.000Z',
        source: 'sbi_csv',
        funds: [{ id: 'sp500_sbi', eval: 1_234_567 }],
      },
    })

    await useAppStore.getState().refreshAllData()

    expect(useAppStore.getState().holdings.find(item => item.code === '7203')?.eval).toBe(999_999)
    expect(useAppStore.getState().trust.find(item => item.id === 'sp500_sbi')?.eval).toBe(1_234_567)
  })

  it('initialize: corrupted envelope refuses partial legacy fallback', async () => {
    store[CSV_IMPORT_GENERATION_KEY] = '{"manifest":{"committed":false}}'
    seedLocalStorage({
      holdings: [makeHolding({ code: 'PARTIAL', eval: 999_999 })],
      trust: [makeTrust({ id: 'partial-fund', eval: 999_999 })],
      csvImportedAt: '2099-07-15T00:00:00.000Z',
    })
    mockFetchRouter({})
    useAppStore.setState(state => ({
      holdings: [makeHolding({ code: 'BASE', eval: 111_111 })],
      trust: [makeTrust({ id: 'base-fund', eval: 222_222 })],
      system: { ...state.system, status: 'idle', csvLastImportedAt: null },
    }))

    await useAppStore.getState().initialize()

    expect(useAppStore.getState().holdings.some(item => item.code === 'PARTIAL')).toBe(false)
    expect(useAppStore.getState().trust.some(item => item.id === 'partial-fund')).toBe(false)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
  })

  it('initialize: checksum-valid deep-malformed canonical is not hydrated and cannot use legacy fallback', async () => {
    persistCsvImportTransaction({
      holdings: [makeHolding()],
      trust: [makeTrust()],
      learning: null,
      importedAt: '2026-07-15T00:00:00.000Z',
      syncSummary: {
        importedAt: '2026-07-15T00:00:00.000Z',
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 1, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: { date: '2026-07-15', total: 0, evalById: {} },
    })
    const envelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    envelope.payload.holdings = [null]
    envelope.manifest.payloadChecksum = checksum(JSON.stringify(envelope.payload))
    store[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)
    seedLocalStorage({
      holdings: [makeHolding({ code: 'LEGACY-PARTIAL', eval: 999_999 })],
      trust: [makeTrust({ id: 'legacy-partial-fund', eval: 999_999 })],
      csvImportedAt: '2099-07-15T00:00:00.000Z',
    })
    mockFetchRouter({})
    useAppStore.setState(state => ({
      holdings: [makeHolding({ code: 'BASE', eval: 111_111 })],
      trust: [makeTrust({ id: 'base-fund', eval: 222_222 })],
      system: { ...state.system, status: 'idle', csvLastImportedAt: null },
    }))

    await useAppStore.getState().initialize()

    expect(useAppStore.getState().holdings.some(item => item.code === 'LEGACY-PARTIAL')).toBe(false)
    expect(useAppStore.getState().trust.some(item => item.id === 'legacy-partial-fund')).toBe(false)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
  })

  it('R3-FIX-C RA-004: initialize performs zero canonical/legacy generation writes while canonical is present-invalid', async () => {
    store[CSV_IMPORT_GENERATION_KEY] = '{present-invalid'
    seedLocalStorage({
      holdings: [makeHolding({ code: 'LEGACY', eval: 111_000 })],
      trust: [makeTrust({ id: 'legacy', eval: 222_000 })],
      csvImportedAt: '2026-01-01T00:00:00.000Z',
    })
    store.v13_portfolio_policy = JSON.stringify({ data: { jpStockMaxRatio: 0.08 }, savedAt: 1 })
    store.v13_cash_assumptions = JSON.stringify({ data: {}, savedAt: 1 })
    store.v13_csv_sync_summary = JSON.stringify({ data: {}, savedAt: 1 })
    const before = { ...store }
    writeLog.length = 0
    mockFetchRouter({})

    await useAppStore.getState().initialize()

    expect(writeLog).toEqual([])
    expect(store).toEqual(before)
    expect(useAppStore.getState().system).toMatchObject({ status: 'error' })
    expect(useAppStore.getState().system.error).not.toMatch(/JSON|parse|token/i)
  })

  it('initialize: legacy operation timeだけではsource freshnessを証明できずpublished snapshotを適用しない', async () => {
    seedLocalStorage({
      holdings: [makeHolding({ code: '7203', eval: 555_000 })],
      csvImportedAt: '2026-07-01T00:00:00+09:00',
    })
    mockFetchRouter({
      'holdings.json': {
        last_updated: '2026-07-10T00:00:00+09:00', // csvより新しい
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
    })

    await useAppStore.getState().initialize()

    const holding = useAppStore.getState().holdings.find(h => h.code === '7203')
    expect(holding?.eval).toBe(555_000)
  })

  it('initialize: timestamp同値の場合はsnapshotを適用せず、既存のユーザー状態を保持する', async () => {
    const sameTimestamp = '2026-07-10T00:00:00+09:00'
    seedLocalStorage({
      holdings: [makeHolding({ code: '7203', eval: 555_000 })],
      csvImportedAt: sameTimestamp,
    })
    mockFetchRouter({
      'holdings.json': {
        last_updated: sameTimestamp,
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
    })

    await useAppStore.getState().initialize()

    const holding = useAppStore.getState().holdings.find(h => h.code === '7203')
    expect(holding?.eval).toBe(555_000)
  })

  it('initialize: timestamp不明（last_updated欠落）のsnapshotはfail-safeで適用されない', async () => {
    seedLocalStorage({
      holdings: [makeHolding({ code: '7203', eval: 555_000 })],
      csvImportedAt: '2026-07-01T00:00:00+09:00',
    })
    mockFetchRouter({
      'holdings.json': {
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
        // last_updatedが存在しない
      },
    })

    await useAppStore.getState().initialize()

    const holding = useAppStore.getState().holdings.find(h => h.code === '7203')
    expect(holding?.eval).toBe(555_000)
  })

  it('initialize: legacy operation timeしかない場合はholdings/trustともunknown provenanceとして保護する', async () => {
    seedLocalStorage({
      holdings: [makeHolding({ code: '7203', eval: 555_000 })],
      trust: [makeTrust({ id: 'sp500_sbi', eval: 4_000_000 })],
      csvImportedAt: '2026-07-05T00:00:00+09:00',
    })
    mockFetchRouter({
      'holdings.json': {
        last_updated: '2026-07-10T00:00:00+09:00', // csvより新しい → 適用される
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
      'trust_master.json': {
        last_updated: '2026-07-01T00:00:00+09:00', // csvより古い → 適用されない
        source: 'sbi_csv',
        funds: [{ id: 'sp500_sbi', eval: 1_234_567 }],
      },
    })

    await useAppStore.getState().initialize()

    const holding = useAppStore.getState().holdings.find(h => h.code === '7203')
    const trust = useAppStore.getState().trust.find(t => t.id === 'sp500_sbi')
    expect(holding?.eval).toBe(555_000)
    expect(trust?.eval).toBe(4_000_000)
  })

  it('refreshAllData: 最新CSV > 古いpublished snapshot → CSV由来の状態が維持される', async () => {
    useAppStore.setState({
      holdings: [makeHolding({ code: '7203', eval: 700_000 })],
      trust: [makeTrust({ id: 'sp500_sbi', eval: 4_000_000 })],
      system: {
        ...useAppStore.getState().system,
        status: 'idle',
        csvLastImportedAt: '2026-07-10T10:00:00+09:00',
      },
    })
    mockFetchRouter({
      'holdings.json': {
        last_updated: '2026-07-01T00:00:00+09:00',
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
      'trust_master.json': {
        last_updated: '2026-07-01T00:00:00+09:00',
        source: 'sbi_csv',
        funds: [{ id: 'sp500_sbi', eval: 1_234_567 }],
      },
    })

    await useAppStore.getState().refreshAllData()

    const holding = useAppStore.getState().holdings.find(h => h.code === '7203')
    const trust = useAppStore.getState().trust.find(t => t.id === 'sp500_sbi')
    expect(holding?.eval).toBe(700_000)
    expect(trust?.eval).toBe(4_000_000)
  })

  it('refreshAllData: authoritative sourceAsOfより新しいpublished snapshotは適用される', async () => {
    useAppStore.setState({
      holdings: [makeHolding({ code: '7203', eval: 700_000 })],
      trust: [makeTrust({ id: 'sp500_sbi', eval: 4_000_000 })],
      system: {
        ...useAppStore.getState().system,
        status: 'idle',
        csvLastImportedAt: '2026-07-01T00:00:00+09:00',
        csvImportProvenance: {
          importedAt: '2026-07-01T00:00:00+09:00',
          sourceAsOf: '2026-07-01T00:00:00.000Z',
          sourceAsOfKind: 'csv_explicit',
          sourceAsOfConfidence: 'authoritative',
          contentFingerprint: 'fnv1a32:12345678',
          sourceFileName: 'portfolio.csv',
          fileLastModified: null,
        },
      },
    })
    mockFetchRouter({
      'holdings.json': {
        last_updated: '2026-07-10T00:00:00+09:00',
        source: 'sbi_csv',
        holdings: [{ code: '7203', eval: 999_999 }],
      },
      'trust_master.json': {
        last_updated: '2026-07-10T00:00:00+09:00',
        source: 'sbi_csv',
        funds: [{ id: 'sp500_sbi', eval: 1_234_567 }],
      },
    })

    await useAppStore.getState().refreshAllData()

    const holding = useAppStore.getState().holdings.find(h => h.code === '7203')
    const trust = useAppStore.getState().trust.find(t => t.id === 'sp500_sbi')
    expect(holding?.eval).toBe(999_999)
    expect(trust?.eval).toBe(1_234_567)
  })

  it('R3-FIX-C RA-004: refreshAllData does not create dead legacy state behind present-invalid canonical', async () => {
    store[CSV_IMPORT_GENERATION_KEY] = '{present-invalid'
    seedLocalStorage({
      holdings: [makeHolding({ code: 'LEGACY', eval: 333_000 })],
      trust: [makeTrust({ id: 'legacy', eval: 444_000 })],
      csvImportedAt: '2026-01-01T00:00:00.000Z',
    })
    const before = { ...store }
    writeLog.length = 0
    useAppStore.setState({
      holdings: [makeHolding({ code: '7203', eval: 700_000 })],
      trust: [makeTrust({ id: 'sp500_sbi', eval: 4_000_000 })],
      system: { ...useAppStore.getState().system, status: 'idle' },
    })
    mockFetchRouter({})

    await useAppStore.getState().refreshAllData()

    expect(writeLog).toEqual([])
    expect(store).toEqual(before)
    expect(useAppStore.getState().system).toMatchObject({ status: 'error' })
  })
})
