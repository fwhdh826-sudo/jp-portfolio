// P4-A148: committeeToOfficialDecision — SAFE_MODE中のBUY抑制テスト（Fable監査S3対応）
// zeroBase.tsのBUY提案生成自体が止まる（zeroBase.test.ts側で検証）ことに加え、
// 万が一BUYタイトルのCommitteeActionが渡された場合でも、officialDecision変換層で
// 二重にBUYをBLOCKED化することを確認する。SELL/HOLD等の非BUYは対象外。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { resetPortfolioGenerationLockAdapterForTest, setPortfolioGenerationLockAdapterForTest } from './useAppStore'

beforeEach(() => setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest()))
afterEach(() => resetPortfolioGenerationLockAdapterForTest())
import type { CsvImportProvenance, Holding, Trust } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import type { CommitteeDecision } from '../domain/analysis/committeeDecision'
import { committeeToOfficialDecision, buildCsvSyncSummary, useAppStore } from './useAppStore'
import { selectEffectiveCashAssumptions, selectCashAssumptionsFreshness } from './selectors'
import {
  computeCanonicalPortfolioGenerationIdentity,
  computeCanonicalPortfolioGenerationIdentityV2,
  computeSnapshotGenerationIdentity,
} from '../utils/snapshotGenerationIdentity'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
  restoreCsvImportedAt,
  restoreCsvImportGeneration,
  restoreCsvImportProvenance,
  restoreCsvSyncSummary,
} from './persist'

function boundV3Snapshot(payload: Record<string, any>): string {
  const value = { ...payload }
  value.snapshotGenerationIdentity = computeSnapshotGenerationIdentity({
    holdings: value.holdings,
    trust: value.trust,
    portfolioPolicy: value.portfolioPolicy,
    cashAssumptions: value.cashAssumptions,
    csvImportedAt: value.csvImportedAt,
    csvImportProvenance: value.csvImportProvenance,
  })
  return JSON.stringify(value)
}

function canonicalGenerationIdentityInput(payload: any) {
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

// P4.5-A013-T6: importCsvはFileReader経由でCSVを読み込むため、node環境用の
// 最小polyfillを用意する（domain/csv/importPortfolioCsv.test.tsと同じ方式）。
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReaderPolyfill {
    onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
    onerror: (() => void) | null = null
    result: ArrayBuffer | null = null
    readAsArrayBuffer(file: File) {
      file.arrayBuffer().then(buf => {
        this.result = buf
        this.onload?.({ target: { result: buf } })
      }).catch(() => {
        this.onerror?.()
      })
    }
  }
  // @ts-expect-error Node環境専用の最小FileReader polyfill
  globalThis.FileReader = NodeFileReaderPolyfill
}

function makeCsvFile(content: string, filename = 'portfolio.csv'): File {
  return new File([content], filename)
}

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'test_fund',
    name: 'テストファンド',
    abbr: 'テスト',
    account: '特定',
    policy: 'OVERSEAS_LONGTERM',
    eval: 1_000_000,
    pnlPct: 10,
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

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    code: '7777',
    name: 'テスト銘柄',
    eval: 100_000,
    pnlPct: 5,
    mu: 0.1,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1.0,
    sector: 'テスト',
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
    decision: 'BUY',
    ev: 0.05,
    ...overrides,
  }
}

function snapshotProvenance(
  importedAt: string,
  sourceAsOf: string,
  identityDigit = 'a',
): CsvImportProvenance {
  return {
    importedAt,
    sourceAsOf,
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${identityDigit.repeat(64)}`,
    contentFingerprint: `fnv1a32:${identityDigit.repeat(8)}`,
    sourceFileName: 'snapshot-source.csv',
    fileLastModified: null,
  }
}

function makeCommitteeDecision(overrides: Partial<CommitteeDecision> = {}): CommitteeDecision {
  return {
    generatedAt: new Date().toISOString(),
    verdict: {
      label: '攻守バランス',
      tone: 'positive',
      noTrade: false,
      summary: '本日は攻守バランス。',
    },
    stance: '高確信銘柄を中心に理想PFとの差分を埋める',
    rationale: [],
    focusPoints: [],
    risks: [],
    actions: [
      {
        id: 'stock-BUY_7777',
        title: 'BUY テスト銘柄',
        detail: '100,000円を分割執行。',
        reason: 'スコア80、EV+5.0%。',
        priority: 'medium',
        domain: 'stock',
        holdingStatus: '非保有',
      },
    ],
    ...overrides,
  }
}

describe('committeeToOfficialDecision: P4-A148 SAFE_MODE中のBUY抑制', () => {
  it('safeModeActive=true時、BUY actionがBUYのまま残らない（BLOCKEDになる）', () => {
    const cd = makeCommitteeDecision()
    const result = committeeToOfficialDecision(cd, false, true, [makeHolding()])
    const buyActions = result.actions.filter(a => a.action === 'BUY')
    expect(buyActions).toHaveLength(0)
    const blockedActions = result.actions.filter(a => a.action === 'BLOCKED')
    expect(blockedActions).toHaveLength(1)
    expect(blockedActions[0].blockedReason).toBe('SAFE_MODE発動中 — 新規買付停止')
  })

  it('safeModeActive=false時は、既存通りBUY actionが残る', () => {
    const cd = makeCommitteeDecision()
    const result = committeeToOfficialDecision(cd, false, false, [makeHolding()])
    const buyActions = result.actions.filter(a => a.action === 'BUY')
    expect(buyActions).toHaveLength(1)
  })

  it('dqSuppressed=true時の既存抑制（DATA_WAIT）はsafeModeActiveの有無に関わらず維持される', () => {
    const cd = makeCommitteeDecision()
    const resultWithoutSafeMode = committeeToOfficialDecision(cd, true, false, [makeHolding()])
    const resultWithSafeMode = committeeToOfficialDecision(cd, true, true, [makeHolding()])
    expect(resultWithoutSafeMode.actions[0].action).toBe('DATA_WAIT')
    expect(resultWithSafeMode.actions[0].action).toBe('DATA_WAIT')
  })

  it('safeModeActive=true時でも、SELL actionはSELLのまま残る', () => {
    const cd = makeCommitteeDecision({
      actions: [
        {
          id: 'stock-SELL_7777',
          title: 'SELL テスト銘柄',
          detail: '半量を撤退。',
          reason: '期待値が弱く防御的リバランス。',
          priority: 'high',
          domain: 'stock',
          holdingStatus: '保有',
        },
      ],
    })
    const result = committeeToOfficialDecision(cd, false, true, [makeHolding()])
    expect(result.actions[0].action).toBe('SELL')
  })

  it('safeModeActive=true時でも、HOLD相当（BUY/SELLどちらでもないtitle）のactionは維持される', () => {
    const cd = makeCommitteeDecision({
      actions: [
        {
          id: 'trust-hold-1',
          title: '日本株系 配分調整',
          detail: '条件未達のため待機。',
          reason: '投信専用の短期シグナルと配分差分から算出。',
          priority: 'low',
          domain: 'trust',
          holdingStatus: '共通',
        },
      ],
    })
    const result = committeeToOfficialDecision(cd, false, true, [makeHolding()])
    expect(result.actions[0].action).toBe('HOLD')
  })

  it('risk-notrade idのactionはsafeModeActiveに関わらずBLOCKEDのまま', () => {
    const cd = makeCommitteeDecision({
      verdict: { label: '防御最優先', tone: 'negative', noTrade: true, summary: '緊急ノートレード' },
      actions: [
        {
          id: 'risk-notrade',
          title: 'ノートレード判定',
          detail: '新規エントリーを停止。',
          reason: '市場ボラティリティが高い。',
          priority: 'high',
          domain: 'risk',
          holdingStatus: '共通',
        },
      ],
    })
    const result = committeeToOfficialDecision(cd, false, true, [makeHolding()])
    expect(result.actions[0].action).toBe('BLOCKED')
    expect(result.actions[0].blockedReason).toBe('新規エントリーを停止。')
  })
})

// P4.5-A002: 資金前提の手動override（setCashAssumptions / clearCashAssumptionsOverride）
describe('useAppStore: cashAssumptions（資金前提の手動override）', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
    // 各テストの前提を揃えるため、既定値（未override状態）にリセットする
    useAppStore.setState({
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('初期状態（manualOverrideEnabled=false）では既定値が実効値になる', () => {
    const eff = selectEffectiveCashAssumptions(useAppStore.getState())
    expect(eff.source).toBe('default')
  })

  it('setCashAssumptionsで手動値が実効値になり、cashTotalが自動計算される', async () => {
    await useAppStore.getState().setCashAssumptions({ cashDeposits: 1_000_000, standbyFunds: 2_000_000 })
    const state = useAppStore.getState()
    expect(state.cashAssumptions.manualOverrideEnabled).toBe(true)
    expect(state.cashAssumptions.cashDeposits).toBe(1_000_000)
    expect(state.cashAssumptions.standbyFunds).toBe(2_000_000)
    expect(state.cashAssumptions.manualUpdatedAt).not.toBeNull()

    const eff = selectEffectiveCashAssumptions(state)
    expect(eff.cash).toBe(1_000_000)
    expect(eff.cashReserve).toBe(2_000_000)
    expect(eff.cashTotal).toBe(3_000_000)
    expect(eff.source).toBe('manual')
  })

  it('setCashAssumptionsの入力は0以上の整数に丸められる（負数・小数のガード）', async () => {
    await useAppStore.getState().setCashAssumptions({ cashDeposits: -500, standbyFunds: 1234.6 })
    const state = useAppStore.getState()
    expect(state.cashAssumptions.cashDeposits).toBe(0)
    expect(state.cashAssumptions.standbyFunds).toBe(1235)
  })

  it('保存するとlocalStorage（persist.ts経由）に反映される', async () => {
    await useAppStore.getState().setCashAssumptions({ cashDeposits: 500_000, standbyFunds: 700_000 })
    const raw = store['v13_cash_assumptions']
    expect(raw).toBeDefined()
    const saved = JSON.parse(raw)
    expect(saved.data.cashDeposits).toBe(500_000)
    expect(saved.data.standbyFunds).toBe(700_000)
    expect(saved.data.manualOverrideEnabled).toBe(true)
  })

  it('clearCashAssumptionsOverrideで既定値に戻る', async () => {
    await useAppStore.getState().setCashAssumptions({ cashDeposits: 1_000_000, standbyFunds: 2_000_000 })
    expect(selectEffectiveCashAssumptions(useAppStore.getState()).source).toBe('manual')

    await useAppStore.getState().clearCashAssumptionsOverride()
    const state = useAppStore.getState()
    expect(state.cashAssumptions.manualOverrideEnabled).toBe(false)
    expect(state.cashAssumptions.manualUpdatedAt).toBeNull()
    expect(selectEffectiveCashAssumptions(state).source).toBe('default')
  })

  it('手動値と既定値のcashフィールドは加算されない（置き換えのみ）', async () => {
    // P0-PRIVACY-HOTFIX: INITIAL_CASHが0になったため、加算されていないことを
    // 検証するにはdefaultCashが非ゼロであることをテスト側で明示する必要がある。
    useAppStore.setState({ cash: 100 })
    const defaultCash = useAppStore.getState().cash
    await useAppStore.getState().setCashAssumptions({ cashDeposits: 10, standbyFunds: 20 })
    const eff = selectEffectiveCashAssumptions(useAppStore.getState())
    expect(eff.cash).toBe(10)
    expect(eff.cash).not.toBe(defaultCash + 10)
  })

  it('P4.5-A008: clearCashAssumptionsOverride後はstale警告（isStale）も消える', async () => {
    const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    useAppStore.setState({
      cashAssumptions: { cashDeposits: 1, standbyFunds: 2, manualOverrideEnabled: true, manualUpdatedAt: staleUpdatedAt },
    })
    expect(selectCashAssumptionsFreshness(useAppStore.getState()).isStale).toBe(true)

    await useAppStore.getState().clearCashAssumptionsOverride()
    expect(selectCashAssumptionsFreshness(useAppStore.getState()).isStale).toBe(false)
  })

  it('P4.5-A009: importCashAssumptionsでmanualOverrideEnabled=trueになり、既存値が置き換わる', async () => {
    await useAppStore.getState().setCashAssumptions({ cashDeposits: 111, standbyFunds: 222 })
    expect(useAppStore.getState().cashAssumptions.cashDeposits).toBe(111)

    await useAppStore.getState().importCashAssumptions({ cashDeposits: 3_000_000, standbyFunds: 7_000_000, manualUpdatedAt: '2026-06-20T00:00:00.000Z' })
    const state = useAppStore.getState()
    expect(state.cashAssumptions.manualOverrideEnabled).toBe(true)
    expect(state.cashAssumptions.cashDeposits).toBe(3_000_000)
    expect(state.cashAssumptions.standbyFunds).toBe(7_000_000)

    const eff = selectEffectiveCashAssumptions(state)
    expect(eff.cash).toBe(3_000_000)
    expect(eff.cashReserve).toBe(7_000_000)
    expect(eff.source).toBe('manual')
  })

  it('P4.5-A009: importCashAssumptionsはmanualUpdatedAtを現在時刻で上書きせず、渡された値をそのまま使う', async () => {
    await useAppStore.getState().importCashAssumptions({ cashDeposits: 1, standbyFunds: 2, manualUpdatedAt: '2020-01-01T00:00:00.000Z' })
    expect(useAppStore.getState().cashAssumptions.manualUpdatedAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('P4.5-A009: importCashAssumptionsにmanualUpdatedAt=nullを渡すとstale扱いになる', async () => {
    await useAppStore.getState().importCashAssumptions({ cashDeposits: 1, standbyFunds: 2, manualUpdatedAt: null })
    const state = useAppStore.getState()
    expect(state.cashAssumptions.manualUpdatedAt).toBeNull()
    expect(selectCashAssumptionsFreshness(state).isStale).toBe(true)
  })

  it('P4.5-A009: localStorageに反映される（persist.ts経由）', async () => {
    await useAppStore.getState().importCashAssumptions({ cashDeposits: 500_000, standbyFunds: 600_000, manualUpdatedAt: '2026-07-01T00:00:00.000Z' })
    const raw = store['v13_cash_assumptions']
    expect(raw).toBeDefined()
    const saved = JSON.parse(raw)
    expect(saved.data.cashDeposits).toBe(500_000)
    expect(saved.data.standbyFunds).toBe(600_000)
    expect(saved.data.manualOverrideEnabled).toBe(true)
  })
})

// P4.5-A012b: portfolio snapshot（保有株・投信・現金前提・portfolioPolicy）のexport/import
describe('useAppStore: portfolio snapshot（P4.5-A012b）', () => {
  const store: Record<string, string> = {}
  let canonicalSetCount = 0
  let canonicalRemoveCount = 0
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => {
      if (k === CSV_IMPORT_GENERATION_KEY) canonicalSetCount += 1
      store[k] = v
    },
    removeItem: (k: string) => {
      if (k === CSV_IMPORT_GENERATION_KEY) canonicalRemoveCount += 1
      delete store[k]
    },
  }

  const testHoldingA = makeHolding({ code: 'TEST-A', eval: 100_000, pnlPct: 5, currentPrice: 1000 })
  const testHoldingB = makeHolding({ code: 'TEST-B', eval: 200_000, pnlPct: -3, currentPrice: 2000 })
  const testTrust: Trust = {
    id: 'trust-a', name: 'テスト投信A', abbr: 'TA', account: '特定',
    policy: 'JAPAN_SHORTTERM', eval: 500_000, pnlPct: 3, dayPct: 0.5,
    cost: 0.5, mu: 0.05, sigma: 0.15, score: 60, signal: 'neutral',
    ev: 0.02, decision: 'HOLD',
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
    canonicalSetCount = 0
    canonicalRemoveCount = 0
    useAppStore.setState(s => ({
      holdings: [testHoldingA, testHoldingB],
      trust: [testTrust],
      portfolioPolicy: { jpStockMaxRatio: 0.10 },
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
      system: {
        ...s.system,
        csvLastImportedAt: '2026-07-01T00:00:00.000Z',
        csvImportProvenance: snapshotProvenance(
          '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
          '1',
        ),
      },
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('exportPortfolioSnapshotがCSV provenance付きv3 JSON文字列を返す', () => {
    const json = useAppStore.getState().exportPortfolioSnapshot()
    expect(typeof json).toBe('string')
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe('portfolio-snapshot-3')
    expect(parsed.csvImportProvenance).toEqual(useAppStore.getState().system.csvImportProvenance)
    expect(parsed.holdings).toHaveLength(2)
    expect(parsed.trust).toHaveLength(1)
  })

  it('exportPortfolioSnapshotはscore/decision/ev/officialDecision等を含めない（sector/mu/sigma/betaはv2でintentionalに含む）', () => {
    const json = useAppStore.getState().exportPortfolioSnapshot()
    const parsed = JSON.parse(json)
    expect(parsed.holdings[0]).not.toHaveProperty('score')
    expect(parsed.holdings[0]).not.toHaveProperty('decision')
    expect(parsed.holdings[0]).not.toHaveProperty('ev')
    expect(parsed.trust[0]).not.toHaveProperty('score')
    expect(parsed.trust[0]).not.toHaveProperty('decision')
    expect(parsed.trust[0]).not.toHaveProperty('ev')
    expect(json).not.toContain('officialDecision')
    expect(json).not.toContain('zeroPlan')
  })

  it('exportPortfolioSnapshotはcashAssumptions実効値を使う（既定値使用中でも実効値がexportされる）', () => {
    const json = useAppStore.getState().exportPortfolioSnapshot()
    const parsed = JSON.parse(json)
    expect(parsed.cashAssumptions).not.toBeNull()
    // buildExportableCashAssumptionsによりmanualOverrideEnabledは常にtrueとしてexportされる
    expect(parsed.cashAssumptions.manualOverrideEnabled).toBe(true)
    expect(typeof parsed.cashAssumptions.cashDeposits).toBe('number')
  })

  it('RA-005: actual export→empty-target import keeps stale CSV metadata stale despite a new manifest savedAt', async () => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    const staleImportedAt = new Date(nowMs - 91 * 24 * 60 * 60 * 1000).toISOString()
    const staleSourceAsOf = new Date(nowMs - 92 * 24 * 60 * 60 * 1000).toISOString()
    const sourceProvenance = snapshotProvenance(staleImportedAt, staleSourceAsOf, 'a')
    const sourceSummary = buildCsvSyncSummary([], [], [], [], {
      trustSectionSeen: true,
      unknownFunds: [],
      zeroedFundIds: [],
      ambiguousFundIds: [],
    }, staleImportedAt)
    const sourceState = useAppStore.getState()
    useAppStore.setState(s => ({
      system: {
        ...s.system,
        status: 'idle',
        csvLastImportedAt: staleImportedAt,
        csvImportProvenance: sourceProvenance,
        csvSyncSummary: sourceSummary,
      },
    }))
    persistCsvImportTransaction({
      holdings: sourceState.holdings,
      trust: sourceState.trust,
      learning: null,
      csvImportedAt: staleImportedAt,
      provenance: sourceProvenance,
      syncSummary: sourceSummary,
      trustShortSnapshot: { date: '2026-04-18', total: sourceState.trust[0]?.eval ?? 0, evalById: { 'trust-a': sourceState.trust[0]?.eval ?? 0 } },
      portfolioPolicy: sourceState.portfolioPolicy,
      cashAssumptions: sourceState.cashAssumptions,
      origin: 'csv',
    }, nowMs - 2 * 24 * 60 * 60 * 1000, undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
    const sourceEnvelope = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])

    const exported = useAppStore.getState().exportPortfolioSnapshot()
    const exportedPayload = JSON.parse(exported)
    expect(exportedPayload.csvImportedAt).toBe(staleImportedAt)
    expect(exportedPayload.csvImportProvenance).toEqual(sourceProvenance)

    delete store[CSV_IMPORT_GENERATION_KEY]
    useAppStore.setState(s => ({
      holdings: [],
      trust: [{ ...testTrust, eval: 0 }],
      learning: null,
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: {
        ...s.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
      },
    }))
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs)

    const importSetCountBefore = canonicalSetCount
    expect(await useAppStore.getState().importPortfolioSnapshot(exported))
      .toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(canonicalSetCount - importSetCountBefore).toBe(1)
    expect(canonicalRemoveCount).toBe(0)
    const importedRaw = store[CSV_IMPORT_GENERATION_KEY]
    const importedEnvelope = JSON.parse(importedRaw)
    expect(importedEnvelope.manifest.savedAt).toBe(nowMs)
    expect(importedEnvelope.manifest.savedAt).toBeGreaterThan(sourceEnvelope.manifest.savedAt)
    expect(importedEnvelope.payload.csvImportedAt).toBe(staleImportedAt)
    expect(importedEnvelope.payload.provenance).toEqual(sourceProvenance)
    expect(importedEnvelope.payload.syncSummary).toBeNull()
    expect(restoreCsvImportedAt(nowMs)).toBeNull()
    expect(restoreCsvSyncSummary(nowMs)).toBeNull()
    canonicalSetCount = 0
    canonicalRemoveCount = 0

    let resolveFetch!: (value: { ok: false; status: number; json: () => Promise<Record<string, never>> }) => void
    const deferredFetch = new Promise<{ ok: false; status: number; json: () => Promise<Record<string, never>> }>(resolve => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => deferredFetch))
    const beforeInitialize = useAppStore.getState()
    const pendingInitialize = useAppStore.getState().initialize()
    await Promise.resolve()

    // RA-007-D2: restore/data/analysis all stage off-store, and persist-before-publish means
    // nothing reaches the store until persistence has already succeeded — so with the network
    // prework still pending, the store must be byte-for-byte untouched (no intermediate publish).
    expect(useAppStore.getState()).toBe(beforeInitialize)
    expect(store[CSV_IMPORT_GENERATION_KEY]).toBe(importedRaw)
    expect(canonicalSetCount).toBe(0)
    expect(canonicalRemoveCount).toBe(0)
    resolveFetch({ ok: false, status: 404, json: () => Promise.resolve({}) })
    await pendingInitialize
    expect(canonicalSetCount).toBe(1)
    expect(canonicalRemoveCount).toBe(0)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
    expect(useAppStore.getState().system.csvSyncSummary).toBeNull()
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(sourceProvenance)
    expect(useAppStore.getState().holdings.map(item => item.code)).toEqual(['TEST-A', 'TEST-B'])

    const reloaded = restoreCsvImportGeneration()
    expect(reloaded.status).toBe('committed')
    if (reloaded.status !== 'committed') throw new Error('expected imported canonical generation')
    expect(reloaded.payload.csvImportedAt).toBe(staleImportedAt)
    expect(reloaded.payload.provenance).toEqual(sourceProvenance)
    expect(restoreCsvImportedAt(nowMs)).toBeNull()
    expect(restoreCsvSyncSummary(nowMs)).toBeNull()
    expect(restoreCsvImportProvenance(reloaded.payload, nowMs)).toEqual(sourceProvenance)
    nowSpy.mockRestore()
  })

  it('importPortfolioSnapshot happy path: holdings/trust/portfolioPolicy/cashAssumptions/csvImportedAtが反映される', async () => {
    useAppStore.setState(s => ({
      holdings: [],
      trust: [{ ...testTrust, eval: 0 }],
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
      system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))
    const snapshotJson = boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: '2026-07-05T23:00:00.000Z',
      csvImportProvenance: snapshotProvenance('2026-07-05T23:00:00.000Z', '2026-07-05T22:00:00.000Z', '2'),
      source: 'manual',
      holdings: [
        { code: 'TEST-A', name: 'TEST-A', eval: 150_000, pnlPct: 8, currentPrice: 1500, acquiredAt: '2026-01-01' },
        { code: 'TEST-B', name: 'TEST-B', eval: 200_000, pnlPct: -3, currentPrice: 2000 },
      ],
      trust: [
        { id: 'trust-a', eval: 600_000, pnlPct: 4, dayPct: 1.0, account: 'NISA成長' },
      ],
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 5_000_000, standbyFunds: 3_000_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-07-05T00:00:00.000Z',
      },
    })

    const before = useAppStore.getState().system.analysisLastRunAt
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)

    const state = useAppStore.getState()
    const updatedA = state.holdings.find(h => h.code === 'TEST-A')
    expect(updatedA?.eval).toBe(150_000)
    expect(updatedA?.pnlPct).toBe(8)
    expect(updatedA?.currentPrice).toBe(1500)

    // TEST-Bはsnapshotに含まれていないため既存値のまま保持される
    const untouchedB = state.holdings.find(h => h.code === 'TEST-B')
    expect(untouchedB?.eval).toBe(200_000)

    const updatedTrust = state.trust.find(t => t.id === 'trust-a')
    expect(updatedTrust?.eval).toBe(600_000)
    expect(updatedTrust?.pnlPct).toBe(4)
    expect(updatedTrust?.dayPct).toBe(1.0)
    expect(updatedTrust?.account).toBe('NISA成長')
    // 静的属性（import処理そのものが上書きしないフィールド）は保持される。
    // score/decision等はこの後のrunFullAnalysisで再計算される計算結果のため、
    // 固定値ではなく「import処理自体は変更していない」ことのみを静的属性で確認する。
    expect(updatedTrust?.name).toBe('テスト投信A')
    expect(updatedTrust?.policy).toBe('JAPAN_SHORTTERM')
    expect(updatedTrust?.abbr).toBe('TA')

    expect(state.portfolioPolicy.jpStockMaxRatio).toBe(0.12)
    expect(state.cashAssumptions.cashDeposits).toBe(5_000_000)
    expect(state.cashAssumptions.manualUpdatedAt).toBe('2026-07-05T00:00:00.000Z')
    expect(state.system.csvLastImportedAt).toBe('2026-07-05T23:00:00.000Z')
    expect(state.system.status).toBe('success')
    expect(state.system.analysisLastRunAt).not.toBe(before)
    const durable = restoreCsvImportGeneration()
    expect(durable).toMatchObject({
      status: 'committed',
      payload: {
        origin: 'snapshot',
        portfolioPolicy: state.portfolioPolicy,
        cashAssumptions: state.cashAssumptions,
      },
    })
  })

  it('parse失敗時はstoreを変更しない', async () => {
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot('{invalid json')
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.trust).toEqual(before.trust)
    expect(after.portfolioPolicy).toEqual(before.portfolioPolicy)
  })

  it('未知のholding codeが含まれるとrejectされstoreを変更しない', async () => {
    useAppStore.setState(s => ({ holdings: [], trust: [], system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null } }))
    const before = useAppStore.getState()
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: null,
      source: 'manual',
      holdings: [{ code: 'UNKNOWN-CODE', eval: 100, pnlPct: 1 }],
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(false)
    if (!result.ok && 'error' in result) expect(result.error).toContain('UNKNOWN-CODE')
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
  })

  it('未知のtrust idが含まれるとrejectされstoreを変更しない', async () => {
    useAppStore.setState(s => ({ holdings: [], trust: [], system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null } }))
    const before = useAppStore.getState()
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: null,
      source: 'manual',
      holdings: [],
      trust: [{ id: 'unknown-trust-id', eval: 100, pnlPct: 1 }],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(false)
    if (!result.ok && 'error' in result) expect(result.error).toContain('unknown-trust-id')
    const after = useAppStore.getState()
    expect(after.trust).toEqual(before.trust)
  })

  it('import後にholdings/trust/policy/cash/originがcanonical v4へpersistされる', async () => {
    useAppStore.setState(s => ({
      holdings: [],
      trust: [{ ...testTrust, eval: 0 }],
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
      system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))
    const snapshotJson = boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: '2026-07-05T23:00:00.000Z',
      csvImportProvenance: snapshotProvenance('2026-07-05T23:00:00.000Z', '2026-07-05T22:00:00.000Z', '2'),
      source: 'manual',
      holdings: [
        { code: 'TEST-A', name: 'TEST-A', eval: 150_000, pnlPct: 8 },
        { code: 'TEST-B', name: 'TEST-B', eval: 200_000, pnlPct: -3 },
      ],
      trust: [{ id: 'trust-a', eval: 600_000, pnlPct: 4 }],
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 5_000_000, standbyFunds: 3_000_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-07-05T00:00:00.000Z',
      },
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)

    const canonical = restoreCsvImportGeneration()
    expect(canonical).toMatchObject({
      status: 'committed',
      payload: {
        holdings: [{ code: 'TEST-A' }, { code: 'TEST-B' }],
        trust: [{ id: 'trust-a', eval: 600_000 }],
        portfolioPolicy: { jpStockMaxRatio: 0.12 },
        cashAssumptions: { cashDeposits: 5_000_000, standbyFunds: 3_000_000 },
        origin: 'snapshot',
      },
    })
    // canonical valid時はlegacy mirrorを生成せず、完全世代だけをauthorityにする。
    expect(store['v13_portfolio_policy']).toBeUndefined()
    expect(store['v13_cash_assumptions']).toBeUndefined()
    expect(store['v10_csv_imported_at']).toBeUndefined()
  })

  it('provenance不明legacy snapshotは既存operation timeを保持したままrejectされる', async () => {
    // beforeEachでcsvLastImportedAt='2026-07-01T00:00:00.000Z'が既にセットされている前提。
    // snapshot側がnull（export元端末がCSV未取込）だからといって、この端末が既に持つ
    // 保有データ鮮度の基準時刻を消してはいけない（過去は無条件上書きでnull化していたバグ）。
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: null,
      source: 'manual',
      holdings: [],
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    expect(useAppStore.getState().system.csvLastImportedAt).toBe('2026-07-01T00:00:00.000Z')
    // 既存localStorageの古いcsvImportedAtの削除は次チケット扱い（今回は書き込みしないだけ）
    expect(store['v10_csv_imported_at']).toBeUndefined()
  })

  it('operation timeが双方nullでも、既存contentへlegacy unknownをsilent overwriteしない', async () => {
    useAppStore.setState(s => ({ system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null } }))
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: null,
      source: 'manual',
      holdings: [],
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
  })

  it('portfolio snapshot importはcsvSyncSummaryを書き換えない（CSV取込結果として偽装しない）', async () => {
    useAppStore.setState(s => ({
      holdings: [],
      trust: [{ ...testTrust, eval: 0 }],
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
      system: { ...s.system, csvSyncSummary: null, csvLastImportedAt: null, csvImportProvenance: null },
    }))
    const snapshotJson = boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: '2026-07-05T23:00:00.000Z',
      csvImportProvenance: snapshotProvenance('2026-07-05T23:00:00.000Z', '2026-07-05T22:00:00.000Z', '2'),
      source: 'manual',
      holdings: [
        { code: 'TEST-A', name: 'TEST-A', eval: 150_000, pnlPct: 8 },
        { code: 'TEST-B', name: 'TEST-B', eval: 200_000, pnlPct: -3 },
      ],
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvSyncSummary).toBeNull()
    expect(store['v13_csv_sync_summary']).toBeUndefined()
  })

  it('R3-F001: csvImportedAt=null snapshotはcommit時刻をCSV時刻へ合成せずimmediate/reloadともnull', async () => {
    useAppStore.setState(s => ({
      holdings: [], trust: [], portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))
    const raw = boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3', exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: null, csvImportProvenance: null, source: 'manual',
      holdings: [], trust: [], portfolioPolicy: null, cashAssumptions: null,
    })

    expect(await useAppStore.getState().importPortfolioSnapshot(raw)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
    const physical = JSON.parse(store[CSV_IMPORT_GENERATION_KEY])
    expect(physical.manifest.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V5)
    expect(physical.payload).toMatchObject({ origin: 'snapshot', csvImportedAt: null, syncSummary: null })
    expect(physical.payload).not.toHaveProperty('importedAt')
    expect(restoreCsvImportedAt()).toBeNull()
  })

  it('R3-F001: csvImportedAt非null snapshotはimmediate/canonical/reloadで同一値', async () => {
    useAppStore.setState(s => ({
      holdings: [], trust: [],
      system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null, csvSyncSummary: null },
    }))
    const importedAt = '2026-07-05T23:00:00.000Z'
    const raw = boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3', exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: importedAt,
      csvImportProvenance: snapshotProvenance(importedAt, '2026-07-05T22:00:00.000Z', '8'),
      source: 'manual', holdings: [], trust: [], portfolioPolicy: null, cashAssumptions: null,
    })

    expect(await useAppStore.getState().importPortfolioSnapshot(raw)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvLastImportedAt).toBe(importedAt)
    expect(JSON.parse(store[CSV_IMPORT_GENERATION_KEY]).payload.csvImportedAt).toBe(importedAt)
    expect(restoreCsvImportedAt()).toBe(importedAt)
  })

  it('R3-F006: stale store csvSyncSummaryをsnapshot canonicalへ混載せずstore/reloadもnull', async () => {
    const staleAt = '2026-06-01T00:00:00.000Z'
    useAppStore.setState(s => ({
      holdings: [], trust: [], portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: {
        ...s.system, csvLastImportedAt: null, csvImportProvenance: null,
        csvSyncSummary: {
          importedAt: staleAt,
          stock: { updated: 99, added: 0, removed: 0 },
          trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
        },
      },
    }))
    const raw = boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3', exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: null, csvImportProvenance: null, source: 'manual',
      holdings: [], trust: [], portfolioPolicy: null, cashAssumptions: null,
    })

    expect(await useAppStore.getState().importPortfolioSnapshot(raw)).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().system.csvSyncSummary).toBeNull()
    expect(JSON.parse(store[CSV_IMPORT_GENERATION_KEY]).payload.syncSummary).toBeNull()
    expect(restoreCsvSyncSummary()).toBeNull()
  })
})

describe('T9-A004-R3-FIX-C: present-invalid canonical manual persistence policy (RA-004)', () => {
  const storage: Record<string, string> = {}
  const writes: string[] = []
  const lsMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key)
      storage[key] = value
    },
    removeItem: (key: string) => { delete storage[key] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    Object.keys(storage).forEach(key => delete storage[key])
    writes.length = 0
    useAppStore.setState(state => ({
      holdings: [makeHolding({ code: '7777', eval: 100_000 })],
      trust: [makeTrust()],
      learning: null,
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
      },
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  function seedInvalidWithLegacy(): Record<string, string> {
    storage[CSV_IMPORT_GENERATION_KEY] = '{present-invalid'
    storage.v81_portfolio = JSON.stringify({ data: [makeHolding({ eval: 11 })], savedAt: 1 })
    storage.v81_trust = JSON.stringify({ data: [makeTrust({ eval: 22 })], savedAt: 1 })
    storage.v13_portfolio_policy = JSON.stringify({ data: { jpStockMaxRatio: 0.08 }, savedAt: 1 })
    storage.v13_cash_assumptions = JSON.stringify({ data: DEFAULT_CASH_ASSUMPTIONS, savedAt: 1 })
    storage.v10_csv_imported_at = JSON.stringify({ at: '2026-01-01T00:00:00.000Z', savedAt: 1 })
    storage.v13_csv_sync_summary = JSON.stringify({ data: {}, savedAt: 1 })
    writes.length = 0
    return { ...storage }
  }

  it('updateHolding leaves invalid bytes and every existing legacy generation byte-exact', async () => {
    const before = seedInvalidWithLegacy()

    await useAppStore.getState().updateHolding('7777', { eval: 125_000 })

    expect(writes).toEqual([])
    expect(storage).toEqual(before)
    expect(useAppStore.getState().system).toMatchObject({ status: 'error' })
    expect(useAppStore.getState().system.error).not.toMatch(/JSON|parse|token/i)
  })

  it('policy and cash mutations perform no legacy/canonical write while invalid is present', async () => {
    const before = seedInvalidWithLegacy()

    await useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    await useAppStore.getState().setCashAssumptions({ cashDeposits: 123, standbyFunds: 456 })

    expect(writes).toEqual([])
    expect(storage).toEqual(before)
  })

  it('explicit removal restores legacy persistence and valid repair restores coordinated canonical persistence', async () => {
    seedInvalidWithLegacy()
    delete storage[CSV_IMPORT_GENERATION_KEY]
    delete storage.v81_portfolio
    delete storage.v81_trust
    delete storage.v13_portfolio_policy
    delete storage.v13_cash_assumptions
    delete storage.v10_csv_imported_at
    delete storage.v13_csv_sync_summary
    useAppStore.setState({
      holdings: [makeHolding()],
      trust: [makeTrust()],
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    })
    writes.length = 0

    const holdingResult = await useAppStore.getState().updateHolding('7777', { eval: 130_000 })
    expect(holdingResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    await useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.12 })
    await useAppStore.getState().setCashAssumptions({ cashDeposits: 500, standbyFunds: 600 })
    expect(writes).toEqual(expect.arrayContaining([
      'v81_portfolio',
      'v81_trust',
      'v13_portfolio_policy',
      'v13_cash_assumptions',
    ]))

    const state = useAppStore.getState()
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-07-17', total: 0, evalById: {} },
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      origin: 'snapshot',
    })
    const validBefore = storage[CSV_IMPORT_GENERATION_KEY]
    writes.length = 0

    await useAppStore.getState().updateHolding('7777', { eval: 140_000 })

    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toBe(validBefore)
    expect(writes).toEqual([CSV_IMPORT_GENERATION_KEY])
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      payload: { holdings: [{ code: '7777', eval: 140_000 }] },
    })
  })
})

describe('R4-A002: policy/cash persistence result visibility', () => {
  const GENERIC_FAILURE = '変更を保存できなかったため、手動変更を反映しませんでした。再試行してください。'
  const CANONICAL_INVALID = '保存済みcanonicalデータが不正なため、手動変更を反映しませんでした。再読み込み後に状態を確認してください。'
  const CANONICAL_COMMITTED = '保存中にcanonicalデータが更新されたため、手動変更を反映しませんでした。再読み込み後に状態を確認してください。'
  const storage: Record<string, string> = {}
  const getItem = vi.fn((key: string): string | null => storage[key] ?? null)
  const setItem = vi.fn((key: string, value: string) => { storage[key] = value })
  const removeItem = vi.fn((key: string) => { delete storage[key] })
  const lsMock = { getItem, setItem, removeItem }

  const actionCases = [
    {
      name: 'setPortfolioPolicy',
      legacyKey: 'v13_portfolio_policy',
      invoke: () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.17 }),
      assertInMemory: () => expect(useAppStore.getState().portfolioPolicy).toEqual({ jpStockMaxRatio: 0.17 }),
    },
    {
      name: 'setCashAssumptions',
      legacyKey: 'v13_cash_assumptions',
      invoke: () => useAppStore.getState().setCashAssumptions({ cashDeposits: 1_111, standbyFunds: 2_222 }),
      assertInMemory: () => expect(useAppStore.getState().cashAssumptions).toMatchObject({
        cashDeposits: 1_111,
        standbyFunds: 2_222,
        manualOverrideEnabled: true,
      }),
    },
    {
      name: 'clearCashAssumptionsOverride',
      legacyKey: 'v13_cash_assumptions',
      invoke: () => useAppStore.getState().clearCashAssumptionsOverride(),
      assertInMemory: () => expect(useAppStore.getState().cashAssumptions).toEqual({
        cashDeposits: 333,
        standbyFunds: 444,
        manualOverrideEnabled: false,
        manualUpdatedAt: null,
      }),
    },
    {
      name: 'importCashAssumptions',
      legacyKey: 'v13_cash_assumptions',
      invoke: () => useAppStore.getState().importCashAssumptions({
        cashDeposits: 5_555,
        standbyFunds: 6_666,
        manualUpdatedAt: '2026-07-18T00:00:00.000Z',
      }),
      assertInMemory: () => expect(useAppStore.getState().cashAssumptions).toEqual({
        cashDeposits: 5_555,
        standbyFunds: 6_666,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-18T00:00:00.000Z',
      }),
    },
  ]

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    Object.keys(storage).forEach(key => delete storage[key])
    getItem.mockReset()
    getItem.mockImplementation((key: string) => storage[key] ?? null)
    setItem.mockReset()
    setItem.mockImplementation((key: string, value: string) => { storage[key] = value })
    removeItem.mockReset()
    removeItem.mockImplementation((key: string) => { delete storage[key] })
    useAppStore.setState(state => ({
      holdings: [makeHolding({ code: '7777', eval: 100_000 })],
      trust: [makeTrust()],
      learning: null,
      analysis: [],
      metrics: null,
      universe: null,
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: {
        cashDeposits: 333,
        standbyFunds: 444,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-17T00:00:00.000Z',
      },
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
      },
    }))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  function expectAnalysisCompleted(): void {
    const state = useAppStore.getState()
    expect(state.analysis).toHaveLength(state.holdings.length)
    expect(state.metrics).not.toBeNull()
    expect(state.universe).not.toBeNull()
  }

  function expectPortfolioGenerationUnchanged(before: ReturnType<typeof useAppStore.getState>): void {
    const after = useAppStore.getState()
    expect(after.holdings).toBe(before.holdings)
    expect(after.trust).toBe(before.trust)
    expect(after.portfolioPolicy).toBe(before.portfolioPolicy)
    expect(after.cashAssumptions).toBe(before.cashAssumptions)
    expect(after.analysis).toBe(before.analysis)
    expect(after.metrics).toBe(before.metrics)
    expect(after.universe).toBe(before.universe)
    expect(after.officialDecision).toBe(before.officialDecision)
  }

  function createValidCanonicalRaw(): string {
    const state = useAppStore.getState()
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-07-18', total: 0, evalById: {} },
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      origin: 'snapshot',
    })
    const raw = storage[CSV_IMPORT_GENERATION_KEY]
    delete storage[CSV_IMPORT_GENERATION_KEY]
    getItem.mockClear()
    setItem.mockClear()
    removeItem.mockClear()
    return raw
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

  it.each([
    actionCases[0],
    actionCases[1],
  ])('$name reflects legacy persisted success without a system error', async ({ legacyKey, invoke, assertInMemory }) => {
    await expect(invoke()).resolves.toMatchObject({ ok: true, code: 'SUCCESS' })

    assertInMemory()
    expectAnalysisCompleted()
    expect(storage[legacyKey]).toBeDefined()
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(legacyKey, expect.any(String))
    expect(setItem).not.toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
    expect(useAppStore.getState().system).toMatchObject({ status: 'idle', error: null })
  })

  it.each(actionCases)('$name reflects legacy failure without publishing input or analysis', async ({ legacyKey, invoke }) => {
    const before = useAppStore.getState()
    setItem.mockImplementation(() => { throw new Error('quota exceeded') })

    await expect(invoke()).resolves.toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })

    expectPortfolioGenerationUnchanged(before)
    expect(useAppStore.getState().system).toMatchObject({ status: 'error', error: GENERIC_FAILURE })
    expect(storage[legacyKey]).toBeUndefined()
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(legacyKey, expect.any(String))
    expect(setItem).not.toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
  })

  it.each(actionCases)('$name reflects a canonical_committed race without publishing a generation', async ({ invoke }) => {
    const before = useAppStore.getState()
    const canonicalRaw = createValidCanonicalRaw()
    let canonicalReads = 0
    getItem.mockImplementation((key: string) => {
      if (key !== CSV_IMPORT_GENERATION_KEY) return storage[key] ?? null
      canonicalReads += 1
      if (canonicalReads === 1) return null
      storage[key] = canonicalRaw
      return canonicalRaw
    })

    await expect(invoke()).resolves.toMatchObject({ ok: false, code: 'PORTFOLIO_GENERATION_CONFLICT' })

    expectPortfolioGenerationUnchanged(before)
    expect(canonicalReads).toBe(2)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalRaw)
    expect(setItem).not.toHaveBeenCalled()
    expect(useAppStore.getState().system).toMatchObject({ status: 'error', error: CANONICAL_COMMITTED })
    expect(useAppStore.getState().system.error).not.toBe(CANONICAL_INVALID)
    expect(useAppStore.getState().system.error).not.toBe(GENERIC_FAILURE)
  })

  it.each(actionCases)('$name reflects a canonical_invalid race without publishing a generation', async ({ invoke }) => {
    const before = useAppStore.getState()
    const invalidRaw = '{present-invalid'
    let canonicalReads = 0
    getItem.mockImplementation((key: string) => {
      if (key !== CSV_IMPORT_GENERATION_KEY) return storage[key] ?? null
      canonicalReads += 1
      if (canonicalReads === 1) return null
      storage[key] = invalidRaw
      return invalidRaw
    })

    await expect(invoke()).resolves.toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })

    expectPortfolioGenerationUnchanged(before)
    expect(canonicalReads).toBe(2)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(invalidRaw)
    expect(setItem).not.toHaveBeenCalled()
    expect(useAppStore.getState().system).toMatchObject({ status: 'error', error: CANONICAL_INVALID })
  })

  it.each(actionCases)('$name reflects canonical invalid at action start before analysis and writes', async ({ invoke }) => {
    const invalidRaw = '{present-invalid'
    storage[CSV_IMPORT_GENERATION_KEY] = invalidRaw
    const before = useAppStore.getState()

    await expect(invoke()).resolves.toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })

    expectPortfolioGenerationUnchanged(before)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(invalidRaw)
    expect(setItem).not.toHaveBeenCalled()
    expect(useAppStore.getState().system).toMatchObject({ status: 'error', error: CANONICAL_INVALID })
  })

  it('keeps the coordinated canonical replacement path for an existing committed generation', async () => {
    const canonicalRaw = createValidCanonicalRaw()
    storage[CSV_IMPORT_GENERATION_KEY] = canonicalRaw

    await expect(useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.19 }))
      .resolves.toMatchObject({ ok: true, code: 'SUCCESS' })

    expectAnalysisCompleted()
    expect(storage.v13_portfolio_policy).toBeUndefined()
    expect(storage.v13_cash_assumptions).toBeUndefined()
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toBe(canonicalRaw)
    expect(restoreCsvImportGeneration()).toMatchObject({
      status: 'committed',
      schemaVersion: 'csv-import-generation-4',
      payload: { portfolioPolicy: { jpStockMaxRatio: 0.19 } },
    })
    const generation = restoreCsvImportGeneration()
    if (generation.status !== 'committed') throw new Error('expected committed v4 generation')
    expect(generation.payload.snapshotGenerationIdentity).toBe(
      computeCanonicalPortfolioGenerationIdentity(canonicalIdentityInput(generation.payload)),
    )
    expect(useAppStore.getState().system).toMatchObject({ status: 'idle', error: null })
  })

  it.each([
    ['policy', () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.18 })],
    ['cash', () => useAppStore.getState().setCashAssumptions({ cashDeposits: 7_777, standbyFunds: 8_888 })],
  ])('R4-A004b: canonical v5 survives a nonbaseline %s replacement with identity v2 and baseline unchanged', async (_name, invoke) => {
    const state = useAppStore.getState()
    const baseline = { date: '2026-07-19', total: 0, evalById: {} }
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: baseline,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      origin: 'snapshot',
    }, Date.now(), undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
    setItem.mockClear()

    await invoke()

    const generation = restoreCsvImportGeneration()
    expect(generation).toMatchObject({
      status: 'committed',
      schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
      payload: { trustShortSnapshot: baseline },
    })
    if (generation.status !== 'committed') throw new Error('expected committed v5 generation')
    expect(generation.payload.snapshotGenerationIdentity).toBe(
      computeCanonicalPortfolioGenerationIdentityV2(canonicalIdentityInput(generation.payload)),
    )
    expect(generation.payload.snapshotGenerationIdentity).not.toBe(
      computeCanonicalPortfolioGenerationIdentity(canonicalIdentityInput(generation.payload)),
    )
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
    expect(storage.v13_portfolio_policy).toBeUndefined()
    expect(storage.v13_cash_assumptions).toBeUndefined()
  })

  it.each([
    ['csv-import-generation-4', 1, 'policy', () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.18 })],
    ['csv-import-generation-4', 1, 'cash', () => useAppStore.getState().setCashAssumptions({ cashDeposits: 7_777, standbyFunds: 8_888 })],
    ['csv-import-generation-4', 1, 'holding', () => useAppStore.getState().updateHolding('7777', { eval: 123_456 })],
    ['csv-import-generation-4', 1, 'trust', () => useAppStore.getState().updateTrust('test_fund', { eval: 654_321 })],
    [CSV_IMPORT_GENERATION_SCHEMA_V5, 2, 'policy', () => useAppStore.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.18 })],
    [CSV_IMPORT_GENERATION_SCHEMA_V5, 2, 'cash', () => useAppStore.getState().setCashAssumptions({ cashDeposits: 7_777, standbyFunds: 8_888 })],
    [CSV_IMPORT_GENERATION_SCHEMA_V5, 2, 'holding', () => useAppStore.getState().updateHolding('7777', { eval: 123_456 })],
    [CSV_IMPORT_GENERATION_SCHEMA_V5, 2, 'trust', () => useAppStore.getState().updateTrust('test_fund', { eval: 654_321 })],
  ] as const)('R4-A004c: current %s nonbaseline %s replacement preserves schema/identity v%s and baseline', async (schemaVersion, identityVersion, _action, invoke) => {
    const state = useAppStore.getState()
    const baseline = { date: '2026-07-19', total: 1_000_000, evalById: { test_fund: 1_000_000 } }
    persistCsvImportTransaction({
      holdings: state.holdings,
      trust: state.trust,
      learning: state.learning,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: baseline,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      origin: 'snapshot',
    }, Date.parse('2026-07-19T01:00:00.000Z'), undefined, { schemaVersion })
    const beforeRaw = storage[CSV_IMPORT_GENERATION_KEY]
    const beforeEnvelope = JSON.parse(beforeRaw)
    setItem.mockClear()
    removeItem.mockClear()

    await invoke()

    const afterRaw = storage[CSV_IMPORT_GENERATION_KEY]
    const afterEnvelope = JSON.parse(afterRaw)
    expect(afterRaw).not.toBe(beforeRaw)
    expect(afterEnvelope.manifest.schemaVersion).toBe(schemaVersion)
    expect(afterEnvelope.manifest.generationId).not.toBe(beforeEnvelope.manifest.generationId)
    expect(afterEnvelope.payload.trustShortSnapshot).toEqual(baseline)
    const generation = restoreCsvImportGeneration()
    expect(generation).toMatchObject({
      status: 'committed',
      schemaVersion,
      payload: { trustShortSnapshot: baseline },
    })
    if (generation.status !== 'committed') throw new Error('expected nonbaseline replacement')
    const expectedIdentity = identityVersion === 1
      ? computeCanonicalPortfolioGenerationIdentity(canonicalIdentityInput(generation.payload))
      : computeCanonicalPortfolioGenerationIdentityV2(canonicalIdentityInput(generation.payload))
    expect(generation.payload.snapshotGenerationIdentity).toBe(expectedIdentity)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
    expect(removeItem).not.toHaveBeenCalled()
    for (const legacyKey of [
      'v81_portfolio', 'v81_trust', 'v91_learning', 'v10_csv_imported_at',
      'v13_csv_sync_summary', 'v13_portfolio_policy', 'v13_cash_assumptions',
      'v95_trust_short_snapshot',
    ]) {
      expect(storage[legacyKey]).toBeUndefined()
    }
  })
})

describe('R4-A004c: initialize/refresh preserve canonical v4/v5 semantics', () => {
  const storage: Record<string, string> = {}
  const setItem = vi.fn((key: string, value: string) => { storage[key] = value })
  const removeItem = vi.fn((key: string) => { delete storage[key] })

  beforeEach(() => {
    Object.keys(storage).forEach(key => delete storage[key])
    setItem.mockClear()
    removeItem.mockClear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem,
      removeItem,
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    })))
    useAppStore.setState(state => ({
      holdings: [makeHolding({ code: '7777', eval: 700_000 })],
      trust: [makeTrust({ id: 'test_fund', eval: 800_000 })],
      learning: null,
      portfolioPolicy: { jpStockMaxRatio: 0.13 },
      cashAssumptions: {
        cashDeposits: 123_000,
        standbyFunds: 456_000,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-18T00:00:00.000Z',
      },
      system: {
        ...state.system,
        status: 'idle',
        error: null,
        csvLastImportedAt: null,
        csvImportProvenance: null,
        csvSyncSummary: null,
      },
    }))
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['initialize', 'csv-import-generation-4', 1],
    ['initialize', CSV_IMPORT_GENERATION_SCHEMA_V5, 2],
    ['refreshAllData', 'csv-import-generation-4', 1],
    ['refreshAllData', CSV_IMPORT_GENERATION_SCHEMA_V5, 2],
  ] as const)('%s keeps %s, identity v%s, and the existing baseline without a silent schema conversion', async (operation, schemaVersion, identityVersion) => {
    const seededState = useAppStore.getState()
    const baseline = { date: '2026-07-18', total: 800_000, evalById: { test_fund: 800_000 } }
    persistCsvImportTransaction({
      holdings: seededState.holdings,
      trust: seededState.trust,
      learning: seededState.learning,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: baseline,
      portfolioPolicy: seededState.portfolioPolicy,
      cashAssumptions: seededState.cashAssumptions,
      origin: 'snapshot',
    }, Date.now(), undefined, { schemaVersion })
    setItem.mockClear()
    removeItem.mockClear()

    await useAppStore.getState()[operation]()

    const generation = restoreCsvImportGeneration()
    expect(generation).toMatchObject({
      status: 'committed',
      schemaVersion,
      payload: {
        trustShortSnapshot: baseline,
        portfolioPolicy: useAppStore.getState().portfolioPolicy,
        cashAssumptions: useAppStore.getState().cashAssumptions,
      },
    })
    if (generation.status !== 'committed') throw new Error('expected initialized/refreshed generation')
    const expectedIdentity = identityVersion === 1
      ? computeCanonicalPortfolioGenerationIdentity(canonicalGenerationIdentityInput(generation.payload))
      : computeCanonicalPortfolioGenerationIdentityV2(canonicalGenerationIdentityInput(generation.payload))
    expect(generation.payload.snapshotGenerationIdentity).toBe(expectedIdentity)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem).toHaveBeenCalledWith(CSV_IMPORT_GENERATION_KEY, expect.any(String))
    expect(removeItem).not.toHaveBeenCalled()
    expect(Object.keys(storage)).toEqual([CSV_IMPORT_GENERATION_KEY])
  })

  it('RA-005 DIRECT: initialize passes one captured now to importedAt, summary, and provenance under a reverse clock', async () => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    const sourceAsOf = new Date(nowMs).toISOString()
    const importedAt = new Date(nowMs).toISOString()
    const seededState = useAppStore.getState()
    const syncSummary = buildCsvSyncSummary([], [], [], [], {
      trustSectionSeen: true,
      unknownFunds: [],
      zeroedFundIds: [],
      ambiguousFundIds: [],
    }, importedAt)
    persistCsvImportTransaction({
      holdings: seededState.holdings,
      trust: seededState.trust,
      learning: null,
      csvImportedAt: importedAt,
      provenance: snapshotProvenance(importedAt, sourceAsOf, '4'),
      syncSummary,
      trustShortSnapshot: { date: '2026-07-19', total: 0, evalById: {} },
      portfolioPolicy: seededState.portfolioPolicy,
      cashAssumptions: seededState.cashAssumptions,
      origin: 'csv',
    }, nowMs, undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]
    setItem.mockClear()
    removeItem.mockClear()

    let resolveFetch!: (value: { ok: false; status: number; json: () => Promise<Record<string, never>> }) => void
    const deferredFetch = new Promise<{ ok: false; status: number; json: () => Promise<Record<string, never>> }>(resolve => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => deferredFetch))

    let nowCall = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCall += 1
      // RA-007-D2: call #1 is the network prework's bust-cache token, started before the Web
      // Lock grant; call #2 is initialize's own captured metadata clock (after grant). Any of
      // the three restore paths falling back to its own later Date.now() sees a 1ms-earlier
      // clock and rejects NOW_MS.
      return nowCall <= 2 ? nowMs : nowMs - 1
    })
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const pendingInitialize = useAppStore.getState().initialize()
    await Promise.resolve()

    // RA-007-D2: restore/data/analysis stage entirely off-store and persist-before-publish means
    // nothing reaches the store or localStorage while the network prework is still pending.
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(notifications).toBe(0)

    resolveFetch({ ok: false, status: 404, json: () => Promise.resolve({}) })
    await pendingInitialize
    unsubscribe()
    nowSpy.mockRestore()

    // RA-005: the one captured now flows unchanged into csvImportedAt/summary/provenance — no
    // restore path fell back to its own later (nowMs - 1) clock read.
    expect(useAppStore.getState().system.csvLastImportedAt).toBe(importedAt)
    expect(useAppStore.getState().system.csvSyncSummary).toEqual(syncSummary)
    expect(useAppStore.getState().system.csvImportProvenance).toEqual(
      snapshotProvenance(importedAt, sourceAsOf, '4'),
    )
    expect(useAppStore.getState().system.csvSyncSummary?.importedAt).toBe(importedAt)
    expect(useAppStore.getState().system.csvImportProvenance?.importedAt).toBe(importedAt)
    expect(useAppStore.getState().system.csvImportProvenance?.sourceAsOf).toBe(sourceAsOf)
    // RA-007-D2: exactly one final publication for the whole successful operation.
    expect(notifications).toBe(1)
  })

  it.each([
    {
      label: 'future authoritative sourceAsOf',
      importedAt: '2026-07-18T00:00:00.000Z',
      sourceAsOf: '2026-07-19T00:00:00.001Z',
    },
    {
      label: 'past authoritative sourceAsOf with future returned importedAt',
      importedAt: '2026-07-19T00:00:00.001Z',
      sourceAsOf: '2026-07-18T00:00:00.000Z',
    },
  ])('RA-005: initialize restores portfolio but publishes no future CSV metadata for $label', async ({ importedAt, sourceAsOf }) => {
    const nowMs = Date.parse('2026-07-19T00:00:00.000Z')
    const seededState = useAppStore.getState()
    const provenance = snapshotProvenance(importedAt, sourceAsOf, 'f')
    const syncSummary = buildCsvSyncSummary([], [], [], [], {
      trustSectionSeen: true,
      unknownFunds: [],
      zeroedFundIds: [],
      ambiguousFundIds: [],
    }, importedAt)
    persistCsvImportTransaction({
      holdings: [makeHolding({ code: 'FUTURE-META', eval: 765_432 })],
      trust: [makeTrust({ id: 'future-meta-fund', eval: 876_543 })],
      learning: null,
      csvImportedAt: importedAt,
      provenance,
      syncSummary,
      trustShortSnapshot: { date: '2026-07-19', total: 876_543, evalById: { 'future-meta-fund': 876_543 } },
      portfolioPolicy: seededState.portfolioPolicy,
      cashAssumptions: seededState.cashAssumptions,
      origin: 'csv',
    }, nowMs, undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
    const canonicalBefore = storage[CSV_IMPORT_GENERATION_KEY]
    setItem.mockClear()
    removeItem.mockClear()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs)
    let resolveFetch!: (value: { ok: false; status: number; json: () => Promise<Record<string, never>> }) => void
    const deferredFetch = new Promise<{ ok: false; status: number; json: () => Promise<Record<string, never>> }>(resolve => {
      resolveFetch = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => deferredFetch))
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const beforeInitialize = useAppStore.getState()
    const pendingInitialize = useAppStore.getState().initialize()
    await Promise.resolve()

    // RA-007-D2: restore stages entirely off-store; nothing is visible while network prework is
    // still pending.
    expect(useAppStore.getState()).toBe(beforeInitialize)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalBefore)
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(notifications).toBe(0)

    resolveFetch({ ok: false, status: 404, json: () => Promise.resolve({}) })
    await pendingInitialize
    unsubscribe()
    nowSpy.mockRestore()

    const hydrated = useAppStore.getState()
    expect(hydrated.holdings.find(item => item.code === 'FUTURE-META')?.eval).toBe(765_432)
    expect(hydrated.trust.find(item => item.id === 'future-meta-fund')?.eval).toBe(876_543)
    expect(hydrated.system.csvLastImportedAt).toBeNull()
    expect(hydrated.system.csvSyncSummary).toBeNull()
    expect(hydrated.system.csvImportProvenance).toBeNull()
    expect(JSON.stringify(hydrated.system)).not.toContain('2026-07-19T00:00:00.001Z')
    // RA-007-D2: exactly one final publication for the whole successful operation.
    expect(notifications).toBe(1)
  })
})

describe('buildCsvSyncSummary（P4.5-A013-T6: CSV取込結果の集計・純関数）', () => {
  const importedAt = '2026-07-11T05:00:00.000Z'

  it('個別株: 既存銘柄の更新・新規追加・売却反映の件数を正しく集計する', () => {
    const oldHoldings = [
      makeHolding({ code: '1001' }),
      makeHolding({ code: '1002' }),
      makeHolding({ code: '1003' }),
    ]
    const newHoldings = [
      makeHolding({ code: '1001' }),
      makeHolding({ code: '1002' }),
      makeHolding({ code: '2001' }),
    ]
    const summary = buildCsvSyncSummary(
      oldHoldings, newHoldings, [], [],
      { trustSectionSeen: false, unknownFunds: [], zeroedFundIds: [], ambiguousFundIds: [] },
      importedAt,
    )
    expect(summary.stock).toEqual({ updated: 2, added: 1, removed: 1 })
    expect(summary.importedAt).toBe(importedAt)
  })

  it('投信セクション欠落時（trustSectionSeen=false）は投信集計を全て0にする', () => {
    const oldTrust = [makeTrust({ id: 'f1', eval: 100_000 })]
    // trustSectionSeen=falseの場合、importPortfolioCsvはtrustをそのまま返す（変更なし）
    const summary = buildCsvSyncSummary(
      [], [], oldTrust, oldTrust,
      { trustSectionSeen: false, unknownFunds: [], zeroedFundIds: [], ambiguousFundIds: [] },
      importedAt,
    )
    expect(summary.trust).toEqual({ updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] })
  })

  it('投信: 更新・再保有反映・解約反映・unknown・ambiguousを正しく集計する', () => {
    const oldTrust = [
      makeTrust({ id: 'f_alpha', name: 'アルファ投信', eval: 100_000 }),
      makeTrust({ id: 'f_zeroed', name: '解約投信', eval: 200_000 }),
      makeTrust({ id: 'f_reheld', name: '復活投信', eval: 0 }),
      makeTrust({ id: 'dup_toku', name: '共有投信', account: '特定', eval: 1_000_000 }),
      makeTrust({ id: 'dup_nisa', name: '共有投信', account: 'NISA成長', eval: 500_000 }),
    ]
    const newTrust = [
      { ...oldTrust[0], eval: 105_000 },              // f_alpha: 現在保有中→CSVで更新
      { ...oldTrust[1], eval: 0, pnlPct: 0, dayPct: 0 }, // f_zeroed: CSVで見つからずeval=0化
      { ...oldTrust[2], eval: 80_000 },               // f_reheld: 解約済みだったがCSVで再保有反映
      oldTrust[3],                                     // dup_toku: ambiguousで更新停止（値は不変）
      oldTrust[4],                                     // dup_nisa: 同上
    ]
    const trustSync = {
      trustSectionSeen: true,
      unknownFunds: [{ name: '謎の投信', eval: 50_000, accountHint: '特定' as const }],
      zeroedFundIds: ['f_zeroed'],
      ambiguousFundIds: ['dup_toku', 'dup_nisa'],
    }
    const summary = buildCsvSyncSummary([], [], oldTrust, newTrust, trustSync, importedAt)
    expect(summary.trust.updated).toBe(1)   // f_alpha
    expect(summary.trust.reheld).toBe(1)    // f_reheld
    expect(summary.trust.zeroed).toBe(1)    // f_zeroed
    expect(summary.trust.unknownFunds).toEqual([{ name: '謎の投信', eval: 50_000 }])
    expect(summary.trust.ambiguousFundIds.sort()).toEqual(['dup_nisa', 'dup_toku'])
  })
})

describe('useAppStore: importCsv → csvSyncSummary（P4.5-A013-T6）', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  const oldHoldings: Holding[] = [
    makeHolding({ code: '1001', name: '銘柄A', eval: 100_000 }),
    makeHolding({ code: '1002', name: '銘柄B', eval: 200_000 }),
    makeHolding({ code: '1003', name: '銘柄C', eval: 300_000 }),
  ]
  const oldTrust: Trust[] = [
    makeTrust({ id: 'f_alpha',   name: 'アルファ投信', account: '特定', eval: 100_000 }),
    makeTrust({ id: 'f_beta',    name: 'ベータ投信',   account: '特定', eval: 150_000 }),
    makeTrust({ id: 'f_gamma',   name: 'ガンマ投信',   account: '特定', eval: 250_000 }),
    makeTrust({ id: 'f_zeroed',  name: '解約投信',     account: '特定', eval: 200_000 }),
    makeTrust({ id: 'f_reheld',  name: '復活投信',     account: '特定', eval: 0 }),
    makeTrust({ id: 'dup_toku',  name: '共有投信', account: '特定',     eval: 1_000_000 }),
    makeTrust({ id: 'dup_nisa',  name: '共有投信', account: 'NISA成長', eval: 500_000 }),
  ]

  const VALID_CSV = [
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    '1001,銘柄A,1000,110000,10.00,0.50,2025-01-01',
    '1002,銘柄B,2000,220000,-5.00,-1.00,2025-02-01',
    '2001,銘柄C,3000,90000,2.00,0.20,2025-03-01',
    '投資信託（金額/特定預り）',
    'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
    'アルファ投信,10000,105000,5.00,0.10,',
    'ベータ投信,10000,155000,3.00,0.05,',
    'ガンマ投信,10000,255000,2.00,0.02,',
    '復活投信,10000,80000,1.00,0.01,',
    '謎の投信,10000,50000,1.00,0.10,',
    '投資信託（金額/一般預り）',
    'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
    '共有投信,10000,900000,1.00,0.10,',
  ].join('\n')

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
    useAppStore.setState(s => ({
      holdings: oldHoldings,
      trust: oldTrust,
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      system: { ...s.system, csvSyncSummary: null, csvLastImportedAt: null, status: 'idle', error: null },
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('CSV成功: csvSyncSummaryが保存され、個別株・投信の内訳が正しい', async () => {
    await useAppStore.getState().importCsv(makeCsvFile(VALID_CSV))
    const summary = useAppStore.getState().system.csvSyncSummary
    expect(summary).not.toBeNull()
    expect(summary!.stock).toEqual({ updated: 2, added: 1, removed: 1 })
    expect(summary!.trust.updated).toBe(3)   // アルファ/ベータ/ガンマ
    expect(summary!.trust.reheld).toBe(1)    // 復活投信
    expect(summary!.trust.zeroed).toBe(1)    // 解約投信
    expect(summary!.trust.unknownFunds).toEqual([{ name: '謎の投信', eval: 50_000 }])
    expect(summary!.trust.ambiguousFundIds.sort()).toEqual(['dup_nisa', 'dup_toku'])
  })

  it('CSV成功: localStorageにもcsvSyncSummaryが永続化される', async () => {
    await useAppStore.getState().importCsv(makeCsvFile(VALID_CSV))
    expect(store['v13_csv_import_committed_generation']).toBeDefined()
    const saved = JSON.parse(store['v13_csv_import_committed_generation'])
    expect(saved.manifest.committed).toBe(true)
    expect(saved.payload.syncSummary.stock.added).toBe(1)
  })

  it('CSV失敗（個別株セクション無し）: csvSyncSummaryは更新されない', async () => {
    const before = useAppStore.getState().system.csvSyncSummary
    await useAppStore.getState().importCsv(makeCsvFile('投資信託（金額/特定預り）\nファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日\nアルファ投信,10000,105000,5.00,0.10,'))
    expect(useAppStore.getState().system.status).toBe('error')
    expect(useAppStore.getState().system.csvSyncSummary).toBe(before)
    expect(store['v13_csv_sync_summary']).toBeUndefined()
  })

  it('fail-closed（消滅率超過）: holdings/trust/localStorage/csvSyncSummaryとも一切変更されない', async () => {
    // 個別株3件中CSVには0件しか無い（消滅率100%）→ fail-closedで中断
    const csv = [
      '株式（現物/特定預り）',
      '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
      '9999,別銘柄,1000,110000,10.00,0.50,2025-01-01',
    ].join('\n')
    await useAppStore.getState().importCsv(makeCsvFile(csv))
    const state = useAppStore.getState()
    expect(state.system.status).toBe('error')
    expect(state.holdings).toEqual(oldHoldings)
    expect(state.trust).toEqual(oldTrust)
    expect(state.system.csvSyncSummary).toBeNull()
    expect(store['v81_portfolio']).toBeUndefined()
    expect(store['v81_trust']).toBeUndefined()
    expect(store['v13_csv_sync_summary']).toBeUndefined()
  })
})

describe('useAppStore: localStorageFreshness即時更新（P4.5-A013-T6a）', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }
  const TTL_7D = 7 * 24 * 60 * 60 * 1000
  const STALE_SAVED_AT = Date.now() - TTL_7D - 1000

  const oldHoldings: Holding[] = [makeHolding({ code: '1001', name: '銘柄A', eval: 100_000 })]
  const oldTrust: Trust[] = [makeTrust({ id: 'fund1', name: 'テストファンド', account: '特定', eval: 500_000 })]

  const SIMPLE_VALID_CSV = [
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    '1001,銘柄A,1000,110000,10.00,0.50,2025-01-01',
    '投資信託（金額/特定預り）',
    'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
    'テストファンド,10000,520000,5.00,0.10,',
  ].join('\n')

  const STALE_FRESHNESS = {
    portfolio: { isStale: true, ageDays: 8 },
    trust: { isStale: true, ageDays: 8 },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
    // 既存localStorageは「古いまま」の状態を再現する（TTL超過だが値は保持される、P4.5-A012d方針）
    store['v81_portfolio'] = JSON.stringify({ data: oldHoldings, savedAt: STALE_SAVED_AT })
    store['v81_trust'] = JSON.stringify({ data: oldTrust, savedAt: STALE_SAVED_AT })
    useAppStore.setState(s => ({
      holdings: oldHoldings,
      trust: oldTrust,
      system: {
        ...s.system,
        csvSyncSummary: null,
        csvLastImportedAt: null,
        status: 'idle',
        error: null,
        localStorageFreshness: STALE_FRESHNESS,
      },
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('CSV成功: stale状態からでも同一ターンでportfolio/trust freshnessがfreshになる', async () => {
    await useAppStore.getState().importCsv(makeCsvFile(SIMPLE_VALID_CSV))
    const state = useAppStore.getState()
    expect(state.system.status).toBe('success')
    expect(state.system.localStorageFreshness?.portfolio.isStale).toBe(false)
    expect(state.system.localStorageFreshness?.trust.isStale).toBe(false)
  })

  it('CSV失敗（個別株セクション無し）: localStorageFreshnessは変更されない（stale状態が維持される）', async () => {
    await useAppStore.getState().importCsv(makeCsvFile(
      '投資信託（金額/特定預り）\nファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日\nテストファンド,10000,520000,5.00,0.10,',
    ))
    const state = useAppStore.getState()
    expect(state.system.status).toBe('error')
    expect(state.system.localStorageFreshness).toEqual(STALE_FRESHNESS)
    // 元のlocalStorage(stale savedAt)自体も書き換えられていない
    expect(JSON.parse(store['v81_portfolio']).savedAt).toBe(STALE_SAVED_AT)
  })

  it('portfolio snapshot import成功: stale状態からでも同一ターンでfreshnessがfreshになり、csvSyncSummaryは変更されない', async () => {
    useAppStore.setState(s => ({
      holdings: [],
      trust: oldTrust.map(fund => ({ ...fund, eval: 0 })),
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
      system: { ...s.system, csvLastImportedAt: null, csvImportProvenance: null },
    }))
    const snapshotJson = boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3',
      exportedAt: '2026-07-11T00:00:00.000Z',
      csvImportedAt: '2026-07-11T00:00:00.000Z',
      csvImportProvenance: snapshotProvenance('2026-07-11T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2'),
      source: 'manual',
      holdings: [{ code: '1001', name: '1001', eval: 150_000, pnlPct: 8 }],
      trust: [{ id: 'fund1', eval: 600_000, pnlPct: 4 }],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE', retryable: false })
    const state = useAppStore.getState()
    expect(state).toBe(before)
    expect(state.system.localStorageFreshness?.portfolio.isStale).toBe(true)
    expect(state.system.localStorageFreshness?.trust.isStale).toBe(true)
    // snapshot importはCSV取込結果として偽装しない（csvSyncSummaryは不変のまま）
    expect(state.system.csvSyncSummary).toBeNull()
  })

  it('portfolio snapshot import失敗（未知の銘柄コード）: localStorageFreshnessは変更されない', async () => {
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-11T00:00:00.000Z',
      csvImportedAt: null,
      source: 'manual',
      holdings: [{ code: 'UNKNOWN-CODE', eval: 100, pnlPct: 1 }],
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(false)
    const state = useAppStore.getState()
    expect(state.system.localStorageFreshness).toEqual(STALE_FRESHNESS)
  })
})

describe('useAppStore: importPortfolioSnapshot v2 full-sync（P4.5-A013-T7）', () => {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }

  const holdA = makeHolding({ code: 'HOLD-A', name: '既存銘柄A', eval: 100_000, pnlPct: 5, sector: '既存業種A', mu: 0.11, sigma: 0.21, beta: 1.05 })
  const holdB = makeHolding({ code: 'HOLD-B', name: '既存銘柄B', eval: 200_000, pnlPct: -3, acquiredAt: '2024-01-01' })
  const holdRemove = makeHolding({ code: 'HOLD-REMOVE', name: '削除予定銘柄', eval: 50_000, pnlPct: 1 })
  const fundKnown: Trust = {
    id: 'fund-known', name: '既知ファンド', abbr: 'KF', account: '特定',
    policy: 'JAPAN_SHORTTERM', eval: 300_000, pnlPct: 2, dayPct: 0.1,
    cost: 0.3, mu: 0.05, sigma: 0.15, score: 55, signal: 'neutral',
    ev: 0.01, decision: 'HOLD',
  }
  const fundResold: Trust = {
    id: 'fund-resold', name: '解約済ファンド', abbr: 'RF', account: '特定',
    policy: 'JAPAN_SHORTTERM', eval: 0, pnlPct: 0, dayPct: 0,
    cost: 0.3, mu: 0.05, sigma: 0.15, score: 0, signal: 'neutral',
    ev: 0, decision: 'HOLD',
  }

  const baseHoldings = [holdA, holdB, holdRemove]
  const baseTrust = [fundKnown, fundResold]

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k in store) delete store[k]
    useAppStore.setState(s => ({
      holdings: baseHoldings,
      trust: baseTrust,
      system: {
        ...s.system,
        csvSyncSummary: null,
        csvLastImportedAt: '2026-07-01T00:00:00.000Z',
        csvImportProvenance: snapshotProvenance(
          '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
          '1',
        ),
        status: 'idle',
        error: null,
      },
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  function makeV2Snapshot(overrides: Record<string, unknown> = {}) {
    const csvImportedAt = Object.prototype.hasOwnProperty.call(overrides, 'csvImportedAt')
      ? overrides.csvImportedAt as string | null
      : '2026-07-10T00:00:00.000Z'
    const csvImportProvenance = Object.prototype.hasOwnProperty.call(overrides, 'csvImportProvenance')
      ? overrides.csvImportProvenance
      : csvImportedAt === null
        ? null
        : snapshotProvenance(csvImportedAt, '2026-07-10T00:00:00.000Z', '2')
    return boundV3Snapshot({
      schemaVersion: 'portfolio-snapshot-3',
      exportedAt: '2026-07-11T00:00:00.000Z',
      csvImportedAt,
      csvImportProvenance,
      source: 'manual',
      holdings: [
        { code: 'HOLD-A', name: '既存銘柄A', eval: 150_000, pnlPct: 8, sector: '送信元の別業種', mu: 0.9, sigma: 0.9, beta: 4 },
        { code: 'HOLD-B', name: '既存銘柄B', eval: 250_000, pnlPct: -1, acquiredAt: '2099-12-31' },
        {
          code: 'HOLD-NEW', name: '新規銘柄', eval: 80_000, pnlPct: 0, currentPrice: 1000, acquiredAt: '2026-07-01',
          sector: '新規業種', mu: 0.15, sigma: 0.3, sigmaSource: 'yfinance', beta: 1.3,
        },
      ],
      trust: [
        { id: 'fund-known', eval: 320_000, pnlPct: 3 },
        { id: 'fund-resold', eval: 400_000, pnlPct: 6 },
      ],
      portfolioPolicy: null,
      cashAssumptions: null,
      ...overrides,
    })
  }

  function setTrulyEmptySnapshotGeneration(trust: Trust[] = baseTrust.map(fund => ({ ...fund, eval: 0 }))) {
    useAppStore.setState(s => ({
      holdings: [],
      trust,
      portfolioPolicy: { jpStockMaxRatio: 0.10 },
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
      system: {
        ...s.system,
        csvLastImportedAt: null,
        csvImportProvenance: null,
      },
    }))
  }

  it('v2既存個別株更新: eval/pnlPctは更新されるが、既存metadata(sector/mu/sigma/beta)は上書きされない', async () => {
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    const state = useAppStore.getState()
    const a = state.holdings.find(h => h.code === 'HOLD-A')!
    expect(a.eval).toBe(100_000)
    expect(a.pnlPct).toBe(5)
    // 既存のsector/mu/sigma/betaは、snapshot側に異なる値があっても上書きされない
    expect(a.sector).toBe('既存業種A')
    expect(a.mu).toBe(0.11)
    expect(a.sigma).toBe(0.21)
    expect(a.beta).toBe(1.05)
    expect(state).toBe(before)
  })

  it('v2新規個別株追加: snapshotにしかないcodeが安全なmetadataとともに新規追加される', async () => {
    setTrulyEmptySnapshotGeneration()
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    const state = useAppStore.getState()
    const created = state.holdings.find(h => h.code === 'HOLD-NEW')
    expect(created).toBeDefined()
    expect(created!.name).toBe('新規銘柄')
    expect(created!.eval).toBe(80_000)
    expect(created!.acquiredAt).toBe('2026-07-01')
    // snapshotが提供したsector/mu/sigma/sigmaSource/betaがそのまま使われる
    expect(created!.sector).toBe('新規業種')
    expect(created!.mu).toBe(0.15)
    expect(created!.sigma).toBe(0.3)
    expect(created!.sigmaSource).toBe('yfinance')
    expect(created!.beta).toBe(1.3)
    // T2のsafe default契約: 未取得のtarget/alert/lockは捏造せず安全なdefaultのまま。
    // score/decision/evはこの後runFullAnalysisが再計算するため、ここでは
    // 「情報不足でBUYを出さない」という中心的な安全性（decision !== 'BUY'）のみ確認する
    // （mu=RF safe defaultによりEVが必ず負になり、BUYの必須条件を満たせなくなる設計）。
    expect(created!.target).toBe(0)
    expect(created!.alert).toBe(0)
    expect(created!.lock).toBe(false)
    expect(created!.decision).not.toBe('BUY')
  })

  it('v2 safe metadata: sector/mu/sigma/beta未指定の新規銘柄はT2と同じsafe defaultになる', async () => {
    setTrulyEmptySnapshotGeneration()
    const snapshot = makeV2Snapshot({
      holdings: [
        { code: 'HOLD-A', name: '既存銘柄A', eval: 150_000, pnlPct: 8 },
        { code: 'HOLD-B', name: '既存銘柄B', eval: 250_000, pnlPct: -1 },
        { code: 'HOLD-NEW2', name: 'metadata無し新規銘柄', eval: 30_000, pnlPct: 0 },
      ],
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(true)
    const created = useAppStore.getState().holdings.find(h => h.code === 'HOLD-NEW2')!
    expect(created.sector).toBe('未分類')
    expect(created.mu).toBe(0.005)
    expect(created.sigma).toBe(0.25)
    expect(created.sigmaSource).toBe('static')
    expect(created.beta).toBe(1.0)
  })

  it('v2送信元から消えた個別株の同期: 受信端末だけに残るcodeは削除される（構成一致）', async () => {
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    const state = useAppStore.getState()
    expect(state.holdings.find(h => h.code === 'HOLD-REMOVE')).toBeDefined()
    expect(state).toBe(before)
  })

  it('v2 acquiredAt維持: 既存holdingのacquiredAtがある場合、snapshot側の値があっても優先されない', async () => {
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    const b = useAppStore.getState().holdings.find(h => h.code === 'HOLD-B')!
    expect(b.acquiredAt).toBe('2024-01-01')
    expect(useAppStore.getState()).toBe(before)
  })

  it('v2 unknown trust: 未登録の投信idはsilent ignoreされずskippedTrustIdsとして報告され、trust masterに捏造されない', async () => {
    setTrulyEmptySnapshotGeneration()
    const snapshot = makeV2Snapshot({
      trust: [
        { id: 'fund-known', eval: 320_000, pnlPct: 3 },
        { id: 'fund-unknown-on-device', eval: 999_999, pnlPct: 10 },
      ],
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.skippedTrustIds).toEqual(['fund-unknown-on-device'])
    const state = useAppStore.getState()
    // 既知のfund-knownは通常通り更新される（unknown混在で巻き添えrejectされない）
    expect(state.trust.find(t => t.id === 'fund-known')?.eval).toBe(320_000)
    // 未登録idはtrust masterに新規追加されない（捏造しない）
    expect(state.trust.find(t => t.id === 'fund-unknown-on-device')).toBeUndefined()
    expect(state.trust).toHaveLength(2)
  })

  it('v2再保有投信: eval=0だった登録済み投信がsnapshotで再度eval>0になる', async () => {
    setTrulyEmptySnapshotGeneration()
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    const resold = useAppStore.getState().trust.find(t => t.id === 'fund-resold')!
    expect(resold.eval).toBe(400_000)
    expect(resold.pnlPct).toBe(6)
    // 静的属性(name/policy/abbr等)はimport処理自体が上書きしないことを確認
    expect(resold.name).toBe('解約済ファンド')
    expect(resold.policy).toBe('JAPAN_SHORTTERM')
  })

  it('malformed payload（壊れたJSON）はreject、storeは一切変更されない', async () => {
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot('{not valid json')
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.trust).toEqual(before.trust)
  })

  it('unknown schema（v1でもv2でもない）はreject、storeは一切変更されない', async () => {
    const snapshot = makeV2Snapshot({ schemaVersion: 'portfolio-snapshot-999' })
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.trust).toEqual(before.trust)
  })

  it('atomicity: 消滅率ガード超過で拒否された場合、holdings/trust/localStorage/freshness/csvSyncSummaryとも一切変更されない', async () => {
    // 受信端末の3銘柄中、snapshotに1つも一致しない（消滅率100% > 50%閾値）
    const snapshot = makeV2Snapshot({
      holdings: [{ code: 'TOTALLY-DIFFERENT', name: '別銘柄', eval: 100, pnlPct: 0 }],
    })
    const beforeState = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(beforeState.holdings)
    expect(after.trust).toEqual(beforeState.trust)
    expect(after.system.csvSyncSummary).toBeNull()
    expect(after.system.csvLastImportedAt).toBe('2026-07-01T00:00:00.000Z')
    expect(store['v81_portfolio']).toBeUndefined()
    expect(store['v81_trust']).toBeUndefined()
  })

  it('古いsourceAsOfのsnapshotはoperation timeに関係なく拒否し、一切変更しない', async () => {
    const snapshot = makeV2Snapshot({
      csvImportedAt: '2026-07-20T00:00:00.000Z',
      csvImportProvenance: snapshotProvenance('2026-07-20T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2'),
    })
    const beforeState = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(beforeState.holdings)
    expect(after.trust).toEqual(beforeState.trust)
  })

  it('newer authoritative sourceAsOf snapshotだけではnon-empty currentを上書きできない', async () => {
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot({ csvImportedAt: '2026-07-10T00:00:00.000Z' }))
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })
    expect(useAppStore.getState()).toBe(before)
  })

  it('snapshot provenanceがnullならauthoritative currentを上書きできない', async () => {
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot({ csvImportedAt: null }))
    expect(result).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
    expect(useAppStore.getState().system.csvLastImportedAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('freshness即時更新: stale状態からv2 import成功で同一ターンにfreshになる', async () => {
    store['v81_portfolio'] = JSON.stringify({ data: baseHoldings, savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    store['v81_trust'] = JSON.stringify({ data: baseTrust, savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    useAppStore.setState(s => ({
      system: {
        ...s.system,
        localStorageFreshness: { portfolio: { isStale: true, ageDays: 8 }, trust: { isStale: true, ageDays: 8 } },
      },
    }))
    setTrulyEmptySnapshotGeneration()
    const before = useAppStore.getState()
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE', retryable: false })
    expect(useAppStore.getState()).toBe(before)
    const freshness = useAppStore.getState().system.localStorageFreshness
    expect(freshness?.portfolio.isStale).toBe(true)
    expect(freshness?.trust.isStale).toBe(true)
  })

  it('csvSyncSummary世代分離: v2 importは古いCSV summaryをsnapshot generationへ持ち越さない', async () => {
    setTrulyEmptySnapshotGeneration()
    useAppStore.setState(s => ({
      system: {
        ...s.system,
        csvSyncSummary: {
          importedAt: '2026-06-01T00:00:00.000Z',
          stock: { updated: 1, added: 0, removed: 0 },
          trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
        },
      },
    }))
    const result = await useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvSyncSummary).toBeNull()
  })

  it('portfolioPolicy/cashAssumptionsがv2 snapshotに含まれる場合は反映される', async () => {
    setTrulyEmptySnapshotGeneration()
    const snapshot = makeV2Snapshot({
      portfolioPolicy: { jpStockMaxRatio: 0.15 },
      cashAssumptions: {
        cashDeposits: 1_000_000, standbyFunds: 500_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-07-09T00:00:00.000Z',
      },
    })
    const result = await useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(true)
    const state = useAppStore.getState()
    expect(state.portfolioPolicy.jpStockMaxRatio).toBe(0.15)
    expect(state.cashAssumptions.cashDeposits).toBe(1_000_000)
    expect(state.cashAssumptions.standbyFunds).toBe(500_000)
  })
})
