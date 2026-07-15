// P4-A148: committeeToOfficialDecision — SAFE_MODE中のBUY抑制テスト（Fable監査S3対応）
// zeroBase.tsのBUY提案生成自体が止まる（zeroBase.test.ts側で検証）ことに加え、
// 万が一BUYタイトルのCommitteeActionが渡された場合でも、officialDecision変換層で
// 二重にBUYをBLOCKED化することを確認する。SELL/HOLD等の非BUYは対象外。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { Holding, Trust } from '../types'
import type { CommitteeDecision } from '../domain/analysis/committeeDecision'
import { committeeToOfficialDecision, buildCsvSyncSummary, useAppStore } from './useAppStore'
import { selectEffectiveCashAssumptions, selectCashAssumptionsFreshness } from './selectors'

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

  it('setCashAssumptionsで手動値が実効値になり、cashTotalが自動計算される', () => {
    useAppStore.getState().setCashAssumptions({ cashDeposits: 1_000_000, standbyFunds: 2_000_000 })
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

  it('setCashAssumptionsの入力は0以上の整数に丸められる（負数・小数のガード）', () => {
    useAppStore.getState().setCashAssumptions({ cashDeposits: -500, standbyFunds: 1234.6 })
    const state = useAppStore.getState()
    expect(state.cashAssumptions.cashDeposits).toBe(0)
    expect(state.cashAssumptions.standbyFunds).toBe(1235)
  })

  it('保存するとlocalStorage（persist.ts経由）に反映される', () => {
    useAppStore.getState().setCashAssumptions({ cashDeposits: 500_000, standbyFunds: 700_000 })
    const raw = store['v13_cash_assumptions']
    expect(raw).toBeDefined()
    const saved = JSON.parse(raw)
    expect(saved.data.cashDeposits).toBe(500_000)
    expect(saved.data.standbyFunds).toBe(700_000)
    expect(saved.data.manualOverrideEnabled).toBe(true)
  })

  it('clearCashAssumptionsOverrideで既定値に戻る', () => {
    useAppStore.getState().setCashAssumptions({ cashDeposits: 1_000_000, standbyFunds: 2_000_000 })
    expect(selectEffectiveCashAssumptions(useAppStore.getState()).source).toBe('manual')

    useAppStore.getState().clearCashAssumptionsOverride()
    const state = useAppStore.getState()
    expect(state.cashAssumptions.manualOverrideEnabled).toBe(false)
    expect(state.cashAssumptions.manualUpdatedAt).toBeNull()
    expect(selectEffectiveCashAssumptions(state).source).toBe('default')
  })

  it('手動値と既定値のcashフィールドは加算されない（置き換えのみ）', () => {
    // P0-PRIVACY-HOTFIX: INITIAL_CASHが0になったため、加算されていないことを
    // 検証するにはdefaultCashが非ゼロであることをテスト側で明示する必要がある。
    useAppStore.setState({ cash: 100 })
    const defaultCash = useAppStore.getState().cash
    useAppStore.getState().setCashAssumptions({ cashDeposits: 10, standbyFunds: 20 })
    const eff = selectEffectiveCashAssumptions(useAppStore.getState())
    expect(eff.cash).toBe(10)
    expect(eff.cash).not.toBe(defaultCash + 10)
  })

  it('P4.5-A008: clearCashAssumptionsOverride後はstale警告（isStale）も消える', () => {
    const staleUpdatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    useAppStore.setState({
      cashAssumptions: { cashDeposits: 1, standbyFunds: 2, manualOverrideEnabled: true, manualUpdatedAt: staleUpdatedAt },
    })
    expect(selectCashAssumptionsFreshness(useAppStore.getState()).isStale).toBe(true)

    useAppStore.getState().clearCashAssumptionsOverride()
    expect(selectCashAssumptionsFreshness(useAppStore.getState()).isStale).toBe(false)
  })

  it('P4.5-A009: importCashAssumptionsでmanualOverrideEnabled=trueになり、既存値が置き換わる', () => {
    useAppStore.getState().setCashAssumptions({ cashDeposits: 111, standbyFunds: 222 })
    expect(useAppStore.getState().cashAssumptions.cashDeposits).toBe(111)

    useAppStore.getState().importCashAssumptions({ cashDeposits: 3_000_000, standbyFunds: 7_000_000, manualUpdatedAt: '2026-06-20T00:00:00.000Z' })
    const state = useAppStore.getState()
    expect(state.cashAssumptions.manualOverrideEnabled).toBe(true)
    expect(state.cashAssumptions.cashDeposits).toBe(3_000_000)
    expect(state.cashAssumptions.standbyFunds).toBe(7_000_000)

    const eff = selectEffectiveCashAssumptions(state)
    expect(eff.cash).toBe(3_000_000)
    expect(eff.cashReserve).toBe(7_000_000)
    expect(eff.source).toBe('manual')
  })

  it('P4.5-A009: importCashAssumptionsはmanualUpdatedAtを現在時刻で上書きせず、渡された値をそのまま使う', () => {
    useAppStore.getState().importCashAssumptions({ cashDeposits: 1, standbyFunds: 2, manualUpdatedAt: '2020-01-01T00:00:00.000Z' })
    expect(useAppStore.getState().cashAssumptions.manualUpdatedAt).toBe('2020-01-01T00:00:00.000Z')
  })

  it('P4.5-A009: importCashAssumptionsにmanualUpdatedAt=nullを渡すとstale扱いになる', () => {
    useAppStore.getState().importCashAssumptions({ cashDeposits: 1, standbyFunds: 2, manualUpdatedAt: null })
    const state = useAppStore.getState()
    expect(state.cashAssumptions.manualUpdatedAt).toBeNull()
    expect(selectCashAssumptionsFreshness(state).isStale).toBe(true)
  })

  it('P4.5-A009: localStorageに反映される（persist.ts経由）', () => {
    useAppStore.getState().importCashAssumptions({ cashDeposits: 500_000, standbyFunds: 600_000, manualUpdatedAt: '2026-07-01T00:00:00.000Z' })
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
  const lsMock = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
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
    useAppStore.setState(s => ({
      holdings: [testHoldingA, testHoldingB],
      trust: [testTrust],
      portfolioPolicy: { jpStockMaxRatio: 0.10 },
      cashAssumptions: { cashDeposits: 0, standbyFunds: 0, manualOverrideEnabled: false, manualUpdatedAt: null },
      system: { ...s.system, csvLastImportedAt: '2026-07-01T00:00:00.000Z' },
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('exportPortfolioSnapshotがJSON文字列を返す（P4.5-A013-T7: v2形式）', () => {
    const json = useAppStore.getState().exportPortfolioSnapshot()
    expect(typeof json).toBe('string')
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe('portfolio-snapshot-2')
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

  it('importPortfolioSnapshot happy path: holdings/trust/portfolioPolicy/cashAssumptions/csvImportedAtが反映される', () => {
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: '2026-07-05T23:00:00.000Z',
      source: 'manual',
      holdings: [
        { code: 'TEST-A', eval: 150_000, pnlPct: 8, currentPrice: 1500, acquiredAt: '2026-01-01' },
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
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
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
  })

  it('parse失敗時はstoreを変更しない', () => {
    const before = useAppStore.getState()
    const result = useAppStore.getState().importPortfolioSnapshot('{invalid json')
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.trust).toEqual(before.trust)
    expect(after.portfolioPolicy).toEqual(before.portfolioPolicy)
  })

  it('未知のholding codeが含まれるとrejectされstoreを変更しない', () => {
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
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('UNKNOWN-CODE')
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
  })

  it('未知のtrust idが含まれるとrejectされstoreを変更しない', () => {
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
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('unknown-trust-id')
    const after = useAppStore.getState()
    expect(after.trust).toEqual(before.trust)
  })

  it('import後にlocalStorageへpersistされる（holdings/trust/portfolioPolicy/cashAssumptions/csvImportedAt）', () => {
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: '2026-07-05T23:00:00.000Z',
      source: 'manual',
      holdings: [{ code: 'TEST-A', eval: 150_000, pnlPct: 8 }],
      trust: [{ id: 'trust-a', eval: 600_000, pnlPct: 4 }],
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 5_000_000, standbyFunds: 3_000_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-07-05T00:00:00.000Z',
      },
    })
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)

    expect(store['v81_portfolio']).toBeDefined()
    expect(store['v81_trust']).toBeDefined()
    expect(store['v13_portfolio_policy']).toBeDefined()
    expect(store['v13_cash_assumptions']).toBeDefined()
    expect(store['v10_csv_imported_at']).toBeDefined()

    const savedPolicy = JSON.parse(store['v13_portfolio_policy'])
    expect(savedPolicy.data.jpStockMaxRatio).toBe(0.12)
    const savedCash = JSON.parse(store['v13_cash_assumptions'])
    expect(savedCash.data.cashDeposits).toBe(5_000_000)
  })

  it('csvImportedAtがnullの場合、既存のcsvLastImportedAtが維持されpersistCsvImportedAtは呼ばれない（P4.5-A013-HARDENING-F2）', () => {
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
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvLastImportedAt).toBe('2026-07-01T00:00:00.000Z')
    // 既存localStorageの古いcsvImportedAtの削除は次チケット扱い（今回は書き込みしないだけ）
    expect(store['v10_csv_imported_at']).toBeUndefined()
  })

  it('current/snapshotともにcsvImportedAtが無い場合、nullのまま維持される（P4.5-A013-HARDENING-F2）', () => {
    useAppStore.setState(s => ({ system: { ...s.system, csvLastImportedAt: null } }))
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
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()
  })

  it('portfolio snapshot importはcsvSyncSummaryを書き換えない（CSV取込結果として偽装しない）', () => {
    useAppStore.setState(s => ({ system: { ...s.system, csvSyncSummary: null } }))
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-06T00:00:00.000Z',
      csvImportedAt: '2026-07-05T23:00:00.000Z',
      source: 'manual',
      holdings: [{ code: 'TEST-A', eval: 150_000, pnlPct: 8 }],
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvSyncSummary).toBeNull()
    expect(store['v13_csv_sync_summary']).toBeUndefined()
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

  it('portfolio snapshot import成功: stale状態からでも同一ターンでfreshnessがfreshになり、csvSyncSummaryは変更されない', () => {
    const snapshotJson = JSON.stringify({
      schemaVersion: 'portfolio-snapshot-1',
      exportedAt: '2026-07-11T00:00:00.000Z',
      csvImportedAt: null,
      source: 'manual',
      holdings: [{ code: '1001', eval: 150_000, pnlPct: 8 }],
      trust: [{ id: 'fund1', eval: 600_000, pnlPct: 4 }],
      portfolioPolicy: null,
      cashAssumptions: null,
    })
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
    expect(result.ok).toBe(true)
    const state = useAppStore.getState()
    expect(state.system.localStorageFreshness?.portfolio.isStale).toBe(false)
    expect(state.system.localStorageFreshness?.trust.isStale).toBe(false)
    // snapshot importはCSV取込結果として偽装しない（csvSyncSummaryは不変のまま）
    expect(state.system.csvSyncSummary).toBeNull()
  })

  it('portfolio snapshot import失敗（未知の銘柄コード）: localStorageFreshnessは変更されない', () => {
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
    const result = useAppStore.getState().importPortfolioSnapshot(snapshotJson)
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
      system: { ...s.system, csvSyncSummary: null, csvLastImportedAt: '2026-07-01T00:00:00.000Z', status: 'idle', error: null },
    }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  function makeV2Snapshot(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      schemaVersion: 'portfolio-snapshot-2',
      exportedAt: '2026-07-11T00:00:00.000Z',
      csvImportedAt: '2026-07-10T00:00:00.000Z',
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

  it('v2既存個別株更新: eval/pnlPctは更新されるが、既存metadata(sector/mu/sigma/beta)は上書きされない', () => {
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    const state = useAppStore.getState()
    const a = state.holdings.find(h => h.code === 'HOLD-A')!
    expect(a.eval).toBe(150_000)
    expect(a.pnlPct).toBe(8)
    // 既存のsector/mu/sigma/betaは、snapshot側に異なる値があっても上書きされない
    expect(a.sector).toBe('既存業種A')
    expect(a.mu).toBe(0.11)
    expect(a.sigma).toBe(0.21)
    expect(a.beta).toBe(1.05)
  })

  it('v2新規個別株追加: snapshotにしかないcodeが安全なmetadataとともに新規追加される', () => {
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
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

  it('v2 safe metadata: sector/mu/sigma/beta未指定の新規銘柄はT2と同じsafe defaultになる', () => {
    const snapshot = makeV2Snapshot({
      holdings: [
        { code: 'HOLD-A', name: '既存銘柄A', eval: 150_000, pnlPct: 8 },
        { code: 'HOLD-B', name: '既存銘柄B', eval: 250_000, pnlPct: -1 },
        { code: 'HOLD-NEW2', name: 'metadata無し新規銘柄', eval: 30_000, pnlPct: 0 },
      ],
    })
    const result = useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(true)
    const created = useAppStore.getState().holdings.find(h => h.code === 'HOLD-NEW2')!
    expect(created.sector).toBe('未分類')
    expect(created.mu).toBe(0.005)
    expect(created.sigma).toBe(0.25)
    expect(created.sigmaSource).toBe('static')
    expect(created.beta).toBe(1.0)
  })

  it('v2送信元から消えた個別株の同期: 受信端末だけに残るcodeは削除される（構成一致）', () => {
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    const state = useAppStore.getState()
    expect(state.holdings.find(h => h.code === 'HOLD-REMOVE')).toBeUndefined()
  })

  it('v2 acquiredAt維持: 既存holdingのacquiredAtがある場合、snapshot側の値があっても優先されない', () => {
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    const b = useAppStore.getState().holdings.find(h => h.code === 'HOLD-B')!
    expect(b.acquiredAt).toBe('2024-01-01')
  })

  it('v2 unknown trust: 未登録の投信idはsilent ignoreされずskippedTrustIdsとして報告され、trust masterに捏造されない', () => {
    const snapshot = makeV2Snapshot({
      trust: [
        { id: 'fund-known', eval: 320_000, pnlPct: 3 },
        { id: 'fund-unknown-on-device', eval: 999_999, pnlPct: 10 },
      ],
    })
    const result = useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.skippedTrustIds).toEqual(['fund-unknown-on-device'])
    const state = useAppStore.getState()
    // 既知のfund-knownは通常通り更新される（unknown混在で巻き添えrejectされない）
    expect(state.trust.find(t => t.id === 'fund-known')?.eval).toBe(320_000)
    // 未登録idはtrust masterに新規追加されない（捏造しない）
    expect(state.trust.find(t => t.id === 'fund-unknown-on-device')).toBeUndefined()
    expect(state.trust).toHaveLength(2)
  })

  it('v2再保有投信: eval=0だった登録済み投信がsnapshotで再度eval>0になる', () => {
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    const resold = useAppStore.getState().trust.find(t => t.id === 'fund-resold')!
    expect(resold.eval).toBe(400_000)
    expect(resold.pnlPct).toBe(6)
    // 静的属性(name/policy/abbr等)はimport処理自体が上書きしないことを確認
    expect(resold.name).toBe('解約済ファンド')
    expect(resold.policy).toBe('JAPAN_SHORTTERM')
  })

  it('malformed payload（壊れたJSON）はreject、storeは一切変更されない', () => {
    const before = useAppStore.getState()
    const result = useAppStore.getState().importPortfolioSnapshot('{not valid json')
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.trust).toEqual(before.trust)
  })

  it('unknown schema（v1でもv2でもない）はreject、storeは一切変更されない', () => {
    const snapshot = makeV2Snapshot({ schemaVersion: 'portfolio-snapshot-999' })
    const before = useAppStore.getState()
    const result = useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(before.holdings)
    expect(after.trust).toEqual(before.trust)
  })

  it('atomicity: 消滅率ガード超過で拒否された場合、holdings/trust/localStorage/freshness/csvSyncSummaryとも一切変更されない', () => {
    // 受信端末の3銘柄中、snapshotに1つも一致しない（消滅率100% > 50%閾値）
    const snapshot = makeV2Snapshot({
      holdings: [{ code: 'TOTALLY-DIFFERENT', name: '別銘柄', eval: 100, pnlPct: 0 }],
    })
    const beforeState = useAppStore.getState()
    const result = useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(beforeState.holdings)
    expect(after.trust).toEqual(beforeState.trust)
    expect(after.system.csvSyncSummary).toBeNull()
    expect(after.system.csvLastImportedAt).toBe('2026-07-01T00:00:00.000Z')
    expect(store['v81_portfolio']).toBeUndefined()
    expect(store['v81_trust']).toBeUndefined()
  })

  it('古いsnapshot逆行防止: snapshotのcsvImportedAtがこの端末より古い場合は拒否し、一切変更しない', () => {
    // beforeEachで端末側csvLastImportedAt='2026-07-01T00:00:00.000Z'を設定済み。
    // snapshot側をそれより古い日付にする。
    const snapshot = makeV2Snapshot({ csvImportedAt: '2026-06-01T00:00:00.000Z' })
    const beforeState = useAppStore.getState()
    const result = useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(false)
    const after = useAppStore.getState()
    expect(after.holdings).toEqual(beforeState.holdings)
    expect(after.trust).toEqual(beforeState.trust)
  })

  it('snapshotのcsvImportedAtがこの端末より新しい場合は許可される（逆行ではない）', () => {
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot({ csvImportedAt: '2026-07-10T00:00:00.000Z' }))
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvLastImportedAt).toBe('2026-07-10T00:00:00.000Z')
  })

  it('snapshot側のcsvImportedAtがnullの場合は逆行防止ガードの対象外で許可される', () => {
    // beforeEachで端末側csvLastImportedAt='2026-07-01T00:00:00.000Z'を設定済み。
    // 許可はされるが（P4.5-A013-HARDENING-F2）既存のcsvLastImportedAtを消してはいけない。
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot({ csvImportedAt: null }))
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvLastImportedAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('freshness即時更新: stale状態からv2 import成功で同一ターンにfreshになる', () => {
    store['v81_portfolio'] = JSON.stringify({ data: baseHoldings, savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    store['v81_trust'] = JSON.stringify({ data: baseTrust, savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
    useAppStore.setState(s => ({
      system: {
        ...s.system,
        localStorageFreshness: { portfolio: { isStale: true, ageDays: 8 }, trust: { isStale: true, ageDays: 8 } },
      },
    }))
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    const freshness = useAppStore.getState().system.localStorageFreshness
    expect(freshness?.portfolio.isStale).toBe(false)
    expect(freshness?.trust.isStale).toBe(false)
  })

  it('csvSyncSummary不変: v2 importはcsvSyncSummaryを一切変更しない（CSV取込結果として偽装しない）', () => {
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
    const before = useAppStore.getState().system.csvSyncSummary
    const result = useAppStore.getState().importPortfolioSnapshot(makeV2Snapshot())
    expect(result.ok).toBe(true)
    expect(useAppStore.getState().system.csvSyncSummary).toEqual(before)
  })

  it('portfolioPolicy/cashAssumptionsがv2 snapshotに含まれる場合は反映される', () => {
    const snapshot = makeV2Snapshot({
      portfolioPolicy: { jpStockMaxRatio: 0.15 },
      cashAssumptions: {
        cashDeposits: 1_000_000, standbyFunds: 500_000,
        manualOverrideEnabled: true, manualUpdatedAt: '2026-07-09T00:00:00.000Z',
      },
    })
    const result = useAppStore.getState().importPortfolioSnapshot(snapshot)
    expect(result.ok).toBe(true)
    const state = useAppStore.getState()
    expect(state.portfolioPolicy.jpStockMaxRatio).toBe(0.15)
    expect(state.cashAssumptions.cashDeposits).toBe(1_000_000)
    expect(state.cashAssumptions.standbyFunds).toBe(500_000)
  })
})
