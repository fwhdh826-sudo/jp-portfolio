import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Holding, Trust } from '../types'
import { useAppStore, shouldApplyPublishedSnapshot } from './useAppStore'

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
  const lsMock = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  function seedLocalStorage(opts: { holdings?: Holding[]; trust?: Trust[]; csvImportedAt?: string }) {
    if (opts.holdings) store['v81_portfolio'] = JSON.stringify({ data: opts.holdings, savedAt: Date.now() })
    if (opts.trust) store['v81_trust'] = JSON.stringify({ data: opts.trust, savedAt: Date.now() })
    if (opts.csvImportedAt) store['v10_csv_imported_at'] = JSON.stringify({ at: opts.csvImportedAt, savedAt: Date.now() })
  }

  beforeEach(() => {
    store = {}
    vi.stubGlobal('localStorage', lsMock)
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

  it('initialize: 古いCSV（古いcsvLastImportedAt） < 新しいpublished snapshot → 契約通りsnapshotが安全に適用される', async () => {
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
    expect(holding?.eval).toBe(999_999)
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

  it('initialize: stock（holdings）とtrust（trust_master）は個別に判定される（holdingsのみ新しい場合、holdingsだけ適用されtrustは維持）', async () => {
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
    expect(holding?.eval).toBe(999_999)
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

  it('refreshAllData: 古いCSV < 新しいpublished snapshot → 契約通り安全に適用される', async () => {
    useAppStore.setState({
      holdings: [makeHolding({ code: '7203', eval: 700_000 })],
      trust: [makeTrust({ id: 'sp500_sbi', eval: 4_000_000 })],
      system: {
        ...useAppStore.getState().system,
        status: 'idle',
        csvLastImportedAt: '2026-07-01T00:00:00+09:00',
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
})
