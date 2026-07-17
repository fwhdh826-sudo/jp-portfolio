// T9-A004-R3c: snapshot/CSV importのatomic commit契約を固定する追加test。
// R3-RED file（useAppStore.snapshotImportAtomic.test.ts）の反例を修正後の
// 正契約として恒久固定する:
//   stage → analysis → pre-persist CAS → 単一durable commit → ownership確認
//   → 単一set() publish → SUCCESS
// failure時（analysis/persistence/ownership loss）はstore・subscriber・storageの
// 副作用0で構造化failureを返す。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, Holding } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { useAppStore } from './useAppStore'
import {
  CSV_IMPORT_GENERATION_KEY,
  persistCsvImportTransaction,
  restoreCashAssumptions,
  restoreCsvImportGeneration,
  restoreCsvImportedAt,
  restorePortfolio,
  restorePortfolioPolicy,
  type CsvImportPersistencePayload,
} from './persist'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'
import type { TrustShortPortfolioSnapshot } from '../domain/learning/trustShortTracker'

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

const FIXED_NOW = new Date('2026-07-16T00:00:00.000Z')

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

// 各test caseで一意のsemanticIdentity/contentFingerprintを使い、module levelの
// lastAppliedSnapshotGenerationによるtest間のDUPLICATE誤判定を排除する。
function incomingProvenance(tag: string, overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return {
    importedAt: '2026-07-15T12:00:00.000Z',
    sourceAsOf: '2026-07-15T11:00:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${tag.repeat(64)}`,
    contentFingerprint: `fnv1a32:${tag.repeat(8)}`,
    sourceFileName: `incoming-${tag}.csv`,
    fileLastModified: '2026-07-15T09:30:00.000Z',
    ...overrides,
  }
}

function v3Snapshot(
  csvImportProvenance: CsvImportProvenance,
  overrides: Record<string, unknown> = {},
): string {
  const payload: Record<string, unknown> = {
    schemaVersion: 'portfolio-snapshot-3',
    exportedAt: '2026-07-15T12:30:00.000Z',
    csvImportedAt: csvImportProvenance.importedAt,
    csvImportProvenance,
    source: 'manual',
    holdings: [{ code: 'R3C-DEFAULT', name: 'R3C既定銘柄', eval: 100_000, pnlPct: 0 }],
    trust: [],
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

const VALID_CSV = [
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1001,銘柄1001,1200,150000,8.00,0.50,2025-01-01',
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  'テスト投信,10000,250000,5.00,0.10,',
].join('\n')

describe('T9-A004-R3c: snapshot import atomic commit contract', () => {
  const storage: Record<string, string> = {}
  const failKeys = new Set<string>()
  const crashAfterStoreKeys = new Set<string>()
  let failAllWrites = false
  let storageReentry: ((key: string) => void) | null = null
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      if (failAllWrites) throw new Error('forced quota failure (all writes)')
      if (failKeys.has(key)) throw new Error(`forced quota failure (${key})`)
      storage[key] = value
      storageReentry?.(key)
      if (crashAfterStoreKeys.has(key)) {
        crashAfterStoreKeys.delete(key)
        // durable bytesは既に保存済み。書込成功後・完了通知前のcrash相当境界。
        throw new Error('crash-equivalent failure after durable write')
      }
    },
    removeItem: (key: string) => { delete storage[key] },
  }

  const OLD_TRUST_SHORT_BASELINE: TrustShortPortfolioSnapshot = {
    date: '2026-07-01',
    total: 200_000,
    evalById: { 'fund-old': 200_000 },
  }

  function oldGenerationPayload(): CsvImportPersistencePayload {
    return {
      holdings: [holding('9999', 200_000)],
      trust: [],
      learning: null,
      importedAt: '2026-07-10T00:00:00.000Z',
      provenance: {
        importedAt: '2026-07-10T00:00:00.000Z',
        sourceAsOf: '2026-07-10T00:00:00.000Z',
        sourceAsOfKind: 'csv_explicit',
        sourceAsOfConfidence: 'authoritative',
        semanticIdentity: `sha256:${'0'.repeat(64)}`,
        contentFingerprint: 'fnv1a32:00000000',
        sourceFileName: 'old-generation.csv',
        fileLastModified: '2026-07-10T00:00:00.000Z',
      },
      syncSummary: {
        importedAt: '2026-07-10T00:00:00.000Z',
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: structuredClone(OLD_TRUST_SHORT_BASELINE),
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    failKeys.clear()
    crashAfterStoreKeys.clear()
    failAllWrites = false
    storageReentry = null
    useAppStore.setState(state => ({
      holdings: [],
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

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    if (originalFileReader) globalThis.FileReader = originalFileReader
  })

  it('analysis失敗は構造化failureを返し、store/subscriber/storageの副作用が0である', () => {
    const raw = v3Snapshot(incomingProvenance('1'), {
      holdings: [{ code: 'R3C-CASE1', name: 'R3C-1銘柄', eval: 111_000, pnlPct: 0 }],
    })
    const throwingMarket = new Proxy(baseMarket, {
      get(target, property) {
        if (property === 'regime') throw new Error('forced analysis failure')
        return Reflect.get(target, property)
      },
    })
    useAppStore.setState({ market: throwingMarket })
    const analysisBefore = useAppStore.getState().analysis
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    const state = useAppStore.getState()
    expect({
      resultOk: result.ok,
      resultCode: result.code,
      notifications,
      holdingsAfter: state.holdings,
      csvLastImportedAt: state.system.csvLastImportedAt,
      analysisUnchanged: state.analysis === analysisBefore,
      persistedKeys: Object.keys(storage),
    }).toEqual({
      resultOk: false,
      resultCode: 'SNAPSHOT_ANALYSIS_ERROR',
      notifications: 0,
      holdingsAfter: [],
      csvLastImportedAt: null,
      analysisUnchanged: true,
      persistedKeys: [],
    })
  })

  it('永続化失敗は構造化failureを返し、storage世代もstore通知も発生しない', () => {
    const raw = v3Snapshot(incomingProvenance('2'), {
      holdings: [{ code: 'R3C-CASE2', name: 'R3C-2銘柄', eval: 222_000, pnlPct: 0 }],
    })
    failAllWrites = true
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    const state = useAppStore.getState()
    expect({
      resultOk: result.ok,
      resultCode: result.code,
      notifications,
      holdingsAfter: state.holdings,
      statusAfter: state.system.status,
      persistedKeys: Object.keys(storage),
    }).toEqual({
      resultOk: false,
      resultCode: 'SNAPSHOT_PERSISTENCE_ERROR',
      notifications: 0,
      holdingsAfter: [],
      statusAfter: 'idle',
      persistedKeys: [],
    })
  })

  it('durable書込直後の所有権喪失ではpublishせず、外部transactionのbytesを維持する', () => {
    const raw = v3Snapshot(incomingProvenance('3'), {
      holdings: [{ code: 'R3C-CASE3', name: 'R3C-3銘柄', eval: 333_000, pnlPct: 0 }],
    })
    const externalBytes = 'external-transaction-bytes'
    let canonicalWriteHappened = false
    storageReentry = key => {
      if (key !== CSV_IMPORT_GENERATION_KEY || canonicalWriteHappened) return
      canonicalWriteHappened = true
      storage[CSV_IMPORT_GENERATION_KEY] = externalBytes
    }
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()
    storageReentry = null

    expect({
      resultOk: result.ok,
      resultCode: result.code,
      notifications,
      externalBytesPreserved: storage[CSV_IMPORT_GENERATION_KEY] === externalBytes,
      storeHoldings: useAppStore.getState().holdings,
    }).toEqual({
      resultOk: false,
      resultCode: 'SNAPSHOT_OWNERSHIP_LOST',
      notifications: 0,
      externalBytesPreserved: true,
      storeHoldings: [],
    })
  })

  it('CSV importのdurable commit後・publish直前のcrash相当例外は、committed世代へrecoverしてSUCCESSを返す', async () => {
    crashAfterStoreKeys.add(CSV_IMPORT_GENERATION_KEY)

    const result = await useAppStore.getState().importCsv(
      new File([VALID_CSV], 'portfolio.csv', { type: 'text/csv' }),
    )

    const durable = restoreCsvImportGeneration()
    expect({
      resultOk: result.ok,
      resultCode: result.code,
      persistence: result.ok ? result.persistence.status : null,
      durableIsNew: durable.status === 'committed' &&
        durable.payload.holdings.some(h => h.eval === 150_000),
      storeIsNew: useAppStore.getState().holdings.some(h => h.eval === 150_000),
      statusAfter: useAppStore.getState().system.status,
    }).toEqual({
      resultOk: true,
      resultCode: 'SUCCESS',
      persistence: 'committed',
      durableIsNew: true,
      storeIsNew: true,
      statusAfter: 'success',
    })
  })

  it('snapshot importのdurable commit後・publish直前のcrash相当例外でも、reloadはpublish済みstore世代と一致する', () => {
    crashAfterStoreKeys.add(CSV_IMPORT_GENERATION_KEY)
    const raw = v3Snapshot(incomingProvenance('4'), {
      holdings: [{ code: 'R3C-CASE5', name: 'R3C-5銘柄', eval: 555_000, pnlPct: 0 }],
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: {
        cashDeposits: 640_000,
        standbyFunds: 160_000,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-15T10:30:00.000Z',
      },
    })

    const result = useAppStore.getState().importPortfolioSnapshot(raw)

    const state = useAppStore.getState()
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect({
      reloadHoldings: restorePortfolio(),
      reloadCsvImportedAt: restoreCsvImportedAt(),
      reloadPolicy: restorePortfolioPolicy(),
      reloadCash: restoreCashAssumptions(),
    }).toEqual({
      reloadHoldings: state.holdings,
      reloadCsvImportedAt: state.system.csvLastImportedAt,
      reloadPolicy: state.portfolioPolicy,
      reloadCash: state.cashAssumptions,
    })
  })

  it('成功時のsubscriberはcomplete generationをちょうど1回の通知として観測する', () => {
    const raw = v3Snapshot(incomingProvenance('6'), {
      holdings: [{ code: 'R3C-CASE6', name: 'R3C-6銘柄', eval: 666_000, pnlPct: 0 }],
    })
    const records: Array<{
      holdingsEval: number | null
      analysisLength: number
      status: string
      csvLastImportedAt: string | null
    }> = []
    const unsubscribe = useAppStore.subscribe(state => {
      records.push({
        holdingsEval: state.holdings[0]?.eval ?? null,
        analysisLength: state.analysis.length,
        status: state.system.status,
        csvLastImportedAt: state.system.csvLastImportedAt,
      })
    })

    const result = useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(records).toEqual([{
      holdingsEval: 666_000,
      analysisLength: 1,
      status: 'success',
      csvLastImportedAt: '2026-07-15T12:00:00.000Z',
    }])
  })

  it('永続化失敗したimportの同一snapshot再試行は完全再実行され、durable世代とstore世代が一致する', () => {
    const raw = v3Snapshot(incomingProvenance('7'), {
      holdings: [{ code: 'R3C-CASE7', name: 'R3C-7銘柄', eval: 777_000, pnlPct: 0 }],
    })
    failAllWrites = true
    const first = useAppStore.getState().importPortfolioSnapshot(raw)
    failAllWrites = false

    const retry = useAppStore.getState().importPortfolioSnapshot(raw)

    const state = useAppStore.getState()
    expect({
      firstCode: first.code,
      retryCode: retry.code,
      durableHoldings: restorePortfolio()?.map(h => ({ code: h.code, eval: h.eval })) ?? null,
    }).toEqual({
      firstCode: 'SNAPSHOT_PERSISTENCE_ERROR',
      retryCode: 'SUCCESS',
      durableHoldings: state.holdings.map(h => ({ code: h.code, eval: h.eval })),
    })
  })

  it('新世代envelopeのtrust-short baselineはincoming generationからstageされ、旧canonical baselineを再添付しない', () => {
    // T9-A004-R3d以降、store emptyでもcommitted canonicalはgeneration evidenceとして
    // 別generation snapshotの置換自体をblockする（旧envelope＝旧baselineはbyte単位で温存）。
    persistCsvImportTransaction(oldGenerationPayload())
    const seededRaw = localStorage.getItem(CSV_IMPORT_GENERATION_KEY)
    const raw = v3Snapshot(incomingProvenance('8'), {
      holdings: [{ code: 'R3C-CASE8', name: 'R3C-8銘柄', eval: 888_000, pnlPct: 0 }],
    })

    const blocked = useAppStore.getState().importPortfolioSnapshot(raw)
    expect(blocked.ok).toBe(false)
    expect(localStorage.getItem(CSV_IMPORT_GENERATION_KEY)).toBe(seededRaw)

    // canonicalを正しく除去（absent化）した上での取込だけが新envelopeを書ける。
    // その新envelopeのbaselineはincoming generationからstageされたものであり、
    // 旧canonical世代の実行判定baselineを再添付してはならない。
    localStorage.removeItem(CSV_IMPORT_GENERATION_KEY)
    const result = useAppStore.getState().importPortfolioSnapshot(raw)

    const generation = restoreCsvImportGeneration()
    if (generation.status !== 'committed') throw new Error('expected committed generation after import')
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(generation.payload.trustShortSnapshot).not.toEqual(OLD_TRUST_SHORT_BASELINE)
    // incoming generation（trust構成は空・基準時刻は2026-07-15）から導出されたbaseline。
    expect(generation.payload.trustShortSnapshot).toEqual({
      date: '2026-07-15',
      total: 0,
      evalById: {},
    })
  })

  it('R3-F002: legacy mirror書込中の外部canonical置換はpublish直前のfinal ownership checkで検出し、incoming世代をpublishしない', () => {
    // 外部writerが書くvalid committed canonical bytesを先に構築し、canonicalはabsentへ戻す
    // （pre-persist CAS・initial ownership確認はいずれも成功するfixture）。
    persistCsvImportTransaction(oldGenerationPayload())
    const externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
    delete storage[CSV_IMPORT_GENERATION_KEY]

    // canonical commitとinitial ownership確認の後、最初のlegacy mirror書込
    // （v13_portfolio_policy）の最中に外部valid世代へ置換する。
    let replaced = false
    storageReentry = key => {
      if (key !== 'v13_portfolio_policy' || replaced) return
      replaced = true
      storage[CSV_IMPORT_GENERATION_KEY] = externalRaw
    }
    const raw = v3Snapshot(incomingProvenance('9'), {
      holdings: [{ code: 'R3FIXB-F002', name: 'F002銘柄', eval: 999_000, pnlPct: 0 }],
    })
    const before = useAppStore.getState()
    let notifications = 0
    const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

    const result = useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()
    storageReentry = null

    expect({
      replaced,
      resultOk: result.ok,
      resultCode: result.code,
      notifications,
      externalBytesPreserved: storage[CSV_IMPORT_GENERATION_KEY] === externalRaw,
      storeUntouched: useAppStore.getState() === before,
      storeHoldings: useAppStore.getState().holdings,
      csvLastImportedAt: useAppStore.getState().system.csvLastImportedAt,
    }).toEqual({
      replaced: true,
      resultOk: false,
      resultCode: 'SNAPSHOT_OWNERSHIP_LOST',
      notifications: 0,
      externalBytesPreserved: true,  // rollback/deleteは外部bytesへ一切行われない
      storeUntouched: true,          // incoming storeはpublishされない（部分set 0）
      storeHoldings: [],
      csvLastImportedAt: null,
    })

    // 外部世代を正しく除去（absent化）した上でのretryは完全実行できる
    // （transaction lock残留・lastAppliedSnapshotGenerationの誤更新が無い証明）。
    delete storage[CSV_IMPORT_GENERATION_KEY]
    const retry = useAppStore.getState().importPortfolioSnapshot(raw)
    expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings.map(h => h.code)).toEqual(['R3FIXB-F002'])
  })
})
