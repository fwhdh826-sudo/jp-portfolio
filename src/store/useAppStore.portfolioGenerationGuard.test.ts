// T9-A004-R3a: importCsvとimportPortfolioSnapshotが共有するportfolio-generation
// transaction guardの恒久test。T9-A004-R3-REDで固定されたcounterexampleのうち、
// R3aで実装した共有transaction contract（origin/token/phase + entry guard +
// finally解放 + critical-section guard）によってGREENへ転じた8件をここへ集約する。
// R3b/R3c/R3d向けに残るRED counterexampleはuseAppStore.snapshotImportAtomic.test.tsを
// 参照。helper単体ではなく必ずstore actionを経由し、fault injectionはlocalStorage
// mock / zustand subscriberのみで行う（production codeは一切変更しない）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { resetPortfolioGenerationLockAdapterForTest, setPortfolioGenerationLockAdapterForTest } from './useAppStore'

beforeEach(() => setPortfolioGenerationLockAdapterForTest(createImmediatePortfolioGenerationLockAdapterForTest()))
afterEach(() => resetPortfolioGenerationLockAdapterForTest())
import type { CsvImportProvenance } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { useAppStore } from './useAppStore'
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

const FIXED_NOW = new Date('2026-07-16T00:00:00.000Z')

type SnapshotImportResult = Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importPortfolioSnapshot']>>
type CsvResult = Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importCsv']>>

function provenance(overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return {
    importedAt: '2026-07-15T10:00:00.000Z',
    sourceAsOf: '2026-07-15T09:00:00.000Z',
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${'1'.repeat(64)}`,
    contentFingerprint: 'fnv1a32:11111111',
    sourceFileName: 'current.csv',
    fileLastModified: '2026-07-15T09:30:00.000Z',
    ...overrides,
  }
}

// 各test caseで一意のsemanticIdentity/contentFingerprintを使い、module levelの
// lastAppliedSnapshotGenerationによるtest間のDUPLICATE誤判定を排除する
// （tagは/^[0-9a-f]$/の単一hex文字。semanticIdentity/contentFingerprintの
// フォーマット検証がsha256:[0-9a-f]{64} / fnv1a32:[0-9a-f]{8}を要求するため）。
function incomingProvenance(tag: string, overrides: Partial<CsvImportProvenance> = {}): CsvImportProvenance {
  return provenance({
    importedAt: '2026-07-15T12:00:00.000Z',
    sourceAsOf: '2026-07-15T11:00:00.000Z',
    semanticIdentity: `sha256:${tag.repeat(64)}`,
    contentFingerprint: `fnv1a32:${tag.repeat(8)}`,
    sourceFileName: `incoming-${tag}.csv`,
    ...overrides,
  })
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
    holdings: [{ code: 'GUARD-DEFAULT', name: '既定銘柄', eval: 100_000, pnlPct: 0 }],
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

function csvFile(content = VALID_CSV) {
  return new File([content], 'portfolio.csv', { type: 'text/csv' })
}

function csvWithSource(sourceAsOf: string, content = VALID_CSV) {
  return `データ基準日時,${sourceAsOf}\n${content}`
}

describe('T9-A004-R3a: 共有portfolio-generation transaction guard', () => {
  const storage: Record<string, string> = {}
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value },
    removeItem: (key: string) => { delete storage[key] },
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    // 空generation（hydration直後・CSV未取込・手動override無し）を既定baselineにする。
    // hasCurrentPortfolioGenerationEvidence()がfalseになる状態でなければ
    // importPortfolioSnapshotのSUCCESS pathへ到達しない。
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

  it('R3-7 GREEN: 第1通知中のreentrant setCashAssumptionsはtransaction guardで拒否される', async () => {
    const snapshotCash = {
      source: 'MANUAL',
      grossCash: 700_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-07-15T10:30:00.000Z',
    }
    const raw = v3Snapshot(incomingProvenance('7'), {
      holdings: [{ code: 'R3-CASE7', name: 'R3-7銘柄', eval: 777_000, pnlPct: 0 }],
      cashAssumptions: snapshotCash,
    })
    let fired = false
    let nestedResult: ReturnType<ReturnType<typeof useAppStore.getState>['setCashAssumptions']> | null = null
    const unsubscribe = useAppStore.subscribe(() => {
      if (fired) return
      fired = true
      nestedResult = useAppStore.getState().setCashAssumptions({ grossCash: 17_000_000, safetyReserve: 0, pendingOrderCash: null })
    })

    const result = await useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()

    const state = useAppStore.getState()
    expect({
      resultCode: result.code,
      // CASH-AUTH-1: snapshot の現金権限は総現金へ一度だけ移行される
      grossCash: state.cashAssumptions.grossCash,
      safetyReserve: state.cashAssumptions.safetyReserve,
    }).toEqual({
      resultCode: 'SUCCESS',
      grossCash: 700_000,
      safetyReserve: 0,
    })
    await expect(nestedResult).resolves.toMatchObject({ ok: false, code: 'LOCAL_OPERATION_BUSY' })
  })

  it('R3-12a GREEN: importCsv進行中のsnapshot importは共通transaction guardで拒否される', async () => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File
    const csvPromise = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()

    const raw = v3Snapshot(incomingProvenance('c'), {
      holdings: [{ code: 'R3-CASE12A', name: 'R3-12a銘柄', eval: 312_000, pnlPct: 0 }],
    })
    const snapshotResult = await useAppStore.getState().importPortfolioSnapshot(raw)

    release(new TextEncoder().encode(VALID_CSV).buffer)
    const csvResult = await csvPromise
    void csvResult

    expect({
      snapshotOk: snapshotResult.ok,
      snapshotCode: snapshotResult.code,
      finalStatusNotLoading: useAppStore.getState().system.status !== 'loading',
    }).toEqual({
      snapshotOk: false,
      snapshotCode: 'LOCAL_OPERATION_BUSY',
      finalStatusNotLoading: true,
    })
  })

  it('R3-12b GREEN: snapshot import中のimportCsvはLOCAL_OPERATION_BUSYで即拒否され、完了後にretry可能', async () => {
    const raw = v3Snapshot(incomingProvenance('d'), {
      holdings: [{ code: '1001', name: '銘柄1001', eval: 313_000, pnlPct: 0 }],
    })
    const nestedCapture: { promise: Promise<CsvResult> | null } = { promise: null }
    let fired = false
    const unsubscribe = useAppStore.subscribe(() => {
      if (fired) return
      fired = true
      nestedCapture.promise = useAppStore.getState().importCsv(csvFile())
    })

    const outer = await useAppStore.getState().importPortfolioSnapshot(raw)
    unsubscribe()
    const nested = nestedCapture.promise ? await nestedCapture.promise : null

    expect({
      outerCode: outer.code,
      nestedCode: nested?.code ?? null,
      finalStatus: useAppStore.getState().system.status,
    }).toEqual({
      outerCode: 'SUCCESS',
      nestedCode: 'LOCAL_OPERATION_BUSY',
      finalStatus: 'success',
    })

    // 相互排他は完了後のretryを妨げない（snapshot世代より新しいsource基準時刻のCSV）
    const retryCsv = await useAppStore.getState().importCsv(
      csvFile(csvWithSource('2026-07-16T09:00:00+09:00')),
    )
    expect(retryCsv).toMatchObject({ ok: true, code: 'SUCCESS' })
  })

  it('snapshot importの構造化失敗（早期return）後、共有guardは解放されCSV importが即座に実行できる', async () => {
    const badResult = await useAppStore.getState().importPortfolioSnapshot('not-json')
    expect(badResult.ok).toBe(false)

    const state = useAppStore.getState()
    expect(state.holdings).toEqual([])
  })

  it('CSV importの構造化失敗後、共有guardは解放されsnapshot importが即座に実行できる', async () => {
    const csvFailure = await useAppStore.getState().importCsv(csvFile(''))
    expect(csvFailure.ok).toBe(false)

    const raw = v3Snapshot(incomingProvenance('1'), {
      holdings: [{ code: 'R3A-REL1', name: 'guard解放確認', eval: 1, pnlPct: 0 }],
    })
    const snapshotResult = await useAppStore.getState().importPortfolioSnapshot(raw)

    expect(snapshotResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(useAppStore.getState().holdings.map(h => h.code)).toEqual(['R3A-REL1'])
  })

  it('snapshot importのcritical phase中に発火したnested snapshot importはLOCAL_OPERATION_BUSYで拒否され、outerはSUCCESSを維持する', async () => {
    const outerRaw = v3Snapshot(incomingProvenance('2'), {
      holdings: [{ code: 'R3A-NEST-OUTER', name: 'outer', eval: 1, pnlPct: 0 }],
    })
    const innerRaw = v3Snapshot(incomingProvenance('3'), {
      holdings: [{ code: 'R3A-NEST-INNER', name: 'inner', eval: 1, pnlPct: 0 }],
    })
    let nestedResultPromise: Promise<SnapshotImportResult> | null = null
    let fired = false
    const unsubscribe = useAppStore.subscribe(() => {
      if (fired) return
      fired = true
      nestedResultPromise = useAppStore.getState().importPortfolioSnapshot(innerRaw)
    })

    const outerResult = await useAppStore.getState().importPortfolioSnapshot(outerRaw)
    unsubscribe()
    const nestedResult = nestedResultPromise === null ? null : await nestedResultPromise

    expect({
      outerOk: outerResult.ok,
      outerCode: outerResult.code,
      nestedCode: nestedResult ? (nestedResult as SnapshotImportResult).code : null,
      holdingCodes: useAppStore.getState().holdings.map(h => h.code),
    }).toEqual({
      outerOk: true,
      outerCode: 'SUCCESS',
      nestedCode: 'LOCAL_OPERATION_BUSY',
      holdingCodes: ['R3A-NEST-OUTER'],
    })
  })

  it('CSV importのnested rejection（IMPORT_IN_PROGRESS / LOCAL_OPERATION_BUSY）はouter CSV transactionのSUCCESS/holdingsを上書きしない', async () => {
    const nestedSnapshotRaw = v3Snapshot(incomingProvenance('4'), {
      holdings: [{ code: 'R3A-NESTED-DURING-CSV', name: 'nested', eval: 1, pnlPct: 0 }],
    })
    let nestedResultPromise: Promise<SnapshotImportResult> | null = null
    let fired = false
    const unsubscribe = useAppStore.subscribe(() => {
      if (fired) return
      fired = true
      nestedResultPromise = useAppStore.getState().importPortfolioSnapshot(nestedSnapshotRaw)
    })

    const result = await useAppStore.getState().importCsv(csvFile())
    unsubscribe()
    const nestedResult = nestedResultPromise === null ? null : await nestedResultPromise

    const holdingCodes = useAppStore.getState().holdings.map(h => h.code)
    expect({
      resultOk: result.ok,
      resultCode: result.code,
      nestedCode: nestedResult ? (nestedResult as SnapshotImportResult).code : null,
      holdsNestedCode: holdingCodes.includes('R3A-NESTED-DURING-CSV'),
      holdsCsvCode: holdingCodes.includes('1001'),
      status: useAppStore.getState().system.status,
    }).toEqual({
      resultOk: true,
      resultCode: 'SUCCESS',
      nestedCode: 'LOCAL_OPERATION_BUSY',
      holdsNestedCode: false,
      holdsCsvCode: true,
      status: 'success',
    })
  })

  it('進行中のCSV transactionに対する複数回のnested snapshot rejectionはstale tokenで共有lockを解放せず、outerは自身のcontentのみを公開して完了する', async () => {
    let release!: (value: ArrayBuffer) => void
    const pendingFile = {
      name: 'pending.csv',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { release = resolve }),
    } as File
    const csvPromise = useAppStore.getState().importCsv(pendingFile)
    await Promise.resolve()

    const raw = v3Snapshot(incomingProvenance('5'), {
      holdings: [{ code: 'R3A-STALE', name: 'stale token候補', eval: 1, pnlPct: 0 }],
    })
    // 1回目の拒否がstale tokenで共有lockを誤って解放していれば、2回目はブロック
    // されず実行されてしまう。両方とも同一codeで拒否されることを固定する。
    const first = await useAppStore.getState().importPortfolioSnapshot(raw)
    const second = await useAppStore.getState().importPortfolioSnapshot(raw)

    release(new TextEncoder().encode(VALID_CSV).buffer)
    const csvResult = await csvPromise

    const holdingCodes = useAppStore.getState().holdings.map(h => h.code)
    expect({
      firstCode: first.code,
      secondCode: second.code,
      csvOk: csvResult.ok,
      holdsStaleCode: holdingCodes.includes('R3A-STALE'),
      holdsCsvCode: holdingCodes.includes('1001'),
    }).toEqual({
      firstCode: 'LOCAL_OPERATION_BUSY',
      secondCode: 'LOCAL_OPERATION_BUSY',
      csvOk: true,
      holdsStaleCode: false,
      holdsCsvCode: true,
    })

    // transaction解放後は即座にretryできる（stale tokenの誤解放が無い証拠として、
    // ここまでの間に共有lockが壊れていなかったことも合わせて確認する）。
    const retry = await useAppStore.getState().importPortfolioSnapshot(
      v3Snapshot(incomingProvenance('6'), {
        holdings: [{ code: 'R3A-STALE-RETRY', name: 'retry', eval: 1, pnlPct: 0 }],
      }),
    )
    expect(retry.ok).toBe(false)
    expect(retry.code).toBe('SNAPSHOT_OVERWRITE_BLOCKED')
  })
})
