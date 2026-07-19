// T9-A004-R3-RED: snapshot import transactionの失敗反例を、useAppStoreの実際の
// importPortfolioSnapshot / importCsv actionを通して恒久testとして固定する。
//
// このファイルのtestは、修正前の現行コード(4d3c74d)では意図的にREDになる。
//   - F-SNAPSHOT-NONATOMIC-PUBLISH-04: importPortfolioSnapshotがcommit境界を持たず、
//     部分世代のset()を複数回公開し、永続化失敗をSUCCESSとして返す
//   - F-SNAPSHOT-CANONICAL-DIVERGENCE-03: canonical世代(localStorage envelope)と
//     store世代がCAS無しに乖離・相互上書きされる
// 各testは修正後の期待contract（canonical envelope + 共有transaction）で書かれており、
// 修正実装が入った時点でGREENへ転じることを意図する。helper単体ではなく必ず
// store actionを経由し、fault injectionはlocalStorage mock / zustand subscriber /
// 状態Proxyのみで行う（production codeは一切変更しない）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, Holding } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { useAppStore } from './useAppStore'
import {
  CSV_IMPORT_GENERATION_KEY,
  persistCashAssumptions,
  persistCsvImportTransaction,
  persistPortfolioPolicy,
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

type SnapshotImportResult = Awaited<ReturnType<ReturnType<typeof useAppStore.getState>['importPortfolioSnapshot']>>

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
// lastAppliedSnapshotGenerationによるtest間のDUPLICATE誤判定を排除する。
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
    holdings: [{ code: 'R3-DEFAULT', name: 'R3既定銘柄', eval: 100_000, pnlPct: 0 }],
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

describe('T9-A004-R3-RED: snapshot import transaction failure counterexamples', () => {
  const storage: Record<string, string> = {}
  const writeLog: string[] = []
  const failKeys = new Set<string>()
  const crashAfterStoreKeys = new Set<string>()
  let failAllWrites = false
  let storageReentry: ((key: string) => void) | null = null
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      writeLog.push(key)
      if (failAllWrites) throw new Error('forced quota failure (all writes)')
      if (failKeys.has(key)) throw new Error(`forced quota failure (${key})`)
      storage[key] = value
      storageReentry?.(key)
      if (crashAfterStoreKeys.has(key)) {
        crashAfterStoreKeys.delete(key)
        // durable bytesは既に保存済み。ここでのthrowは「書込は成功したがtransactionが
        // その完了通知を受け取る前にprocessが死んだ」crash相当の境界を再現する。
        throw new Error('crash-equivalent failure after durable write')
      }
    },
    removeItem: (key: string) => { delete storage[key] },
  }

  // 旧世代canonical envelope（store hydration前 / 別tab相当のcommitted generation）
  const OLD_TRUST_SHORT_BASELINE: TrustShortPortfolioSnapshot = {
    date: '2026-07-01',
    total: 200_000,
    evalById: { 'fund-old': 200_000 },
  }

  function oldGenerationPayload(overrides: Partial<CsvImportPersistencePayload> = {}): CsvImportPersistencePayload {
    return {
      holdings: [holding('9999', 200_000)],
      trust: [],
      learning: null,
      importedAt: '2026-07-10T00:00:00.000Z',
      provenance: provenance({
        importedAt: '2026-07-10T00:00:00.000Z',
        sourceAsOf: '2026-07-10T00:00:00.000Z',
        semanticIdentity: `sha256:${'0'.repeat(64)}`,
        contentFingerprint: 'fnv1a32:00000000',
        sourceFileName: 'old-generation.csv',
        fileLastModified: '2026-07-10T00:00:00.000Z',
      }),
      syncSummary: {
        importedAt: '2026-07-10T00:00:00.000Z',
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: structuredClone(OLD_TRUST_SHORT_BASELINE),
      ...overrides,
    }
  }

  function seedCommittedCanonical(): string {
    persistCsvImportTransaction(oldGenerationPayload())
    return storage[CSV_IMPORT_GENERATION_KEY]
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    vi.stubGlobal('FileReader', TestFileReader)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    writeLog.length = 0
    failKeys.clear()
    crashAfterStoreKeys.clear()
    failAllWrites = false
    storageReentry = null
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

  describe('F-SNAPSHOT-NONATOMIC-PUBLISH-04: importPortfolioSnapshotのnon-atomic publish', () => {
    it('R3-1 RED: analysis失敗は構造化エラーを返しportfolio generation副作用0（現行: 例外がthrowされ新content+旧analysisが残留する）', async () => {
      const raw = v3Snapshot(incomingProvenance('1'), {
        holdings: [{ code: 'R3-CASE1', name: 'R3-1銘柄', eval: 111_000, pnlPct: 0 }],
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

      let result: SnapshotImportResult | null = null
      let thrown: unknown = null
      try {
        result = await useAppStore.getState().importPortfolioSnapshot(raw)
      } catch (error) {
        thrown = error
      }
      unsubscribe()

      const state = useAppStore.getState()
      expect({
        thrownError: thrown instanceof Error ? thrown.message : thrown,
        structuredFailure: result !== null && result.ok === false,
        holdingsAfter: state.holdings.map(h => ({ code: h.code, eval: h.eval })),
        csvLastImportedAt: state.system.csvLastImportedAt,
        oldAnalysisStillAttached: state.analysis === analysisBefore,
        notifications,
      }).toEqual({
        thrownError: null,               // 現行: 'forced analysis failure' が素通しでthrowされる
        structuredFailure: true,         // 現行: 構造化resultは返らない
        holdingsAfter: [],               // 現行: set#1で新contentが公開済みのまま残る
        csvLastImportedAt: null,         // 現行: snapshotのimportedAtが残留する
        oldAnalysisStillAttached: true,
        notifications: 0,                // 現行: 部分世代の通知が発生する
      })
    })

    it('R3-2 RED: 永続化(setItem)全滅時はok:falseでstore/storage/subscriber副作用0（現行: 何も保存できないままSUCCESS）', async () => {
      const raw = v3Snapshot(incomingProvenance('2'), {
        holdings: [{ code: 'R3-CASE2', name: 'R3-2銘柄', eval: 222_000, pnlPct: 0 }],
      })
      failAllWrites = true
      let notifications = 0
      const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

      const result = await useAppStore.getState().importPortfolioSnapshot(raw)
      unsubscribe()

      const state = useAppStore.getState()
      expect({
        resultOk: result.ok,
        resultCode: result.code,
        holdingsAfter: state.holdings.map(h => h.code),
        csvLastImportedAt: state.system.csvLastImportedAt,
        persistedKeys: Object.keys(storage),
        notifications,
      }).toEqual({
        resultOk: false,                 // 現行: 全書込失敗でも ok:true SUCCESS を返す
        resultCode: expect.any(String),
        holdingsAfter: [],               // 現行: durable失敗世代がstoreへ公開される
        csvLastImportedAt: null,
        persistedKeys: [],
        notifications: 0,
      })
    })

    it('R3-6 RED: subscriberはgeneration通知を1回だけ・完全な同一世代として観測する（現行: 3回の部分世代通知）', async () => {
      const raw = v3Snapshot(incomingProvenance('6'), {
        holdings: [{ code: 'R3-CASE6', name: 'R3-6銘柄', eval: 666_000, pnlPct: 0 }],
      })
      const records: Array<{ holdingsEval: number | null; analysisLength: number }> = []
      const unsubscribe = useAppStore.subscribe(state => {
        records.push({
          holdingsEval: state.holdings[0]?.eval ?? null,
          analysisLength: state.analysis.length,
        })
      })

      const result = await useAppStore.getState().importPortfolioSnapshot(raw)
      unsubscribe()

      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect({
        notifications: records.length,
        // 新content(eval 666,000)が公開されているのにanalysisが旧世代([])のままの
        // 「部分世代」観測は、修正後は1件も存在してはならない。
        partialGenerationObservations: records.filter(
          record => record.holdingsEval === 666_000 && record.analysisLength === 0,
        ),
      }).toEqual({
        notifications: 1,                    // 現行: content→analysis→freshnessの3回
        partialGenerationObservations: [],   // 現行: 第1通知が部分世代
      })
    })

    it('R3-8 RED: crash相当の部分的multi-key失敗後、reloadは旧世代か新世代の二値のみ（現行: SUCCESSなのにholdingsだけ旧世代へ戻る鋏状混合）', async () => {
      failKeys.add('v81_portfolio')
      const raw = v3Snapshot(incomingProvenance('8'), {
        holdings: [{ code: 'R3-CASE8', name: 'R3-8銘柄', eval: 888_000, pnlPct: 0 }],
        cashAssumptions: {
          cashDeposits: 640_000,
          standbyFunds: 160_000,
          manualOverrideEnabled: true,
          manualUpdatedAt: '2026-07-15T10:30:00.000Z',
        },
      })

      const result = await useAppStore.getState().importPortfolioSnapshot(raw)

      const state = useAppStore.getState()
      if (result.ok) {
        // SUCCESSを公開した以上、reload（storage復元）は公開されたstore世代と一致しなければ
        // ならない。durable commit境界のどちら側でcrashしても「旧世代 or 新世代」の二値以外は禁止。
        expect({
          reloadHoldings: restorePortfolio(),
          reloadCsvImportedAt: restoreCsvImportedAt(),
          reloadCashAssumptions: restoreCashAssumptions(),
        }).toEqual({
          reloadHoldings: state.holdings,                           // 現行: null（holdingsのみ旧世代へ逆戻り）
          reloadCsvImportedAt: state.system.csvLastImportedAt,      // 現行: 新世代（鋏の片刃）
          reloadCashAssumptions: state.cashAssumptions,             // 現行: 新世代（鋏の片刃）
        })
      } else {
        // 構造化失敗ならstore副作用0でなければならない
        expect(state.holdings).toEqual([])
      }
    })

    it('R3-11 RED: 永続化に失敗したimportの同一snapshot再試行は完全再実行される（現行: DUPLICATE_SNAPSHOT偽成功でdurable世代0のまま）', async () => {
      const raw = v3Snapshot(incomingProvenance('b'), {
        holdings: [{ code: 'R3-CASE11', name: 'R3-11銘柄', eval: 311_000, pnlPct: 0 }],
      })
      failAllWrites = true
      const first = await useAppStore.getState().importPortfolioSnapshot(raw)
      failAllWrites = false

      const retry = await useAppStore.getState().importPortfolioSnapshot(raw)

      const state = useAppStore.getState()
      expect({
        firstAttemptCode: first.code,
        retryCode: retry.code,
        durableHoldings: restorePortfolio()?.map(h => ({ code: h.code, eval: h.eval })) ?? null,
      }).toEqual({
        firstAttemptCode: expect.any(String),
        retryCode: 'SUCCESS',                 // 現行: DUPLICATE_SNAPSHOT（何も保存されないまま偽成功）
        durableHoldings: state.holdings.map(h => ({ code: h.code, eval: h.eval })),  // 現行: null
      })
    })

  })

  describe('F-SNAPSHOT-CANONICAL-DIVERGENCE-03: canonical世代とstore世代の乖離', () => {
    it('R3-3 RED: transaction開始後に成立した別generationのcanonicalはIMPORT_CONFLICTで保護される（現行: CAS無しの無条件上書き）', async () => {
      let externalRaw: string | null = null
      const unsubscribe = useAppStore.subscribe(state => {
        // 部分世代の通知（新contentが公開済みなのにanalysisが旧世代のまま）は
        // 「transaction内部」でしか観測できない。そこで外部canonical世代を成立させ、
        // このtransactionが外部世代を保護できるかを固定する。修正後にimportが
        // 単一の完全世代通知のみになれば、このinjection自体が発火しなくなる。
        if (externalRaw !== null) return
        if (state.holdings[0]?.code !== 'R3-CASE3' || state.analysis.length !== 0) return
        persistCsvImportTransaction(oldGenerationPayload({
          holdings: [holding('8888', 888_000)],
          importedAt: '2026-07-15T13:00:00.000Z',
          provenance: provenance({
            importedAt: '2026-07-15T13:00:00.000Z',
            sourceAsOf: '2026-07-15T13:00:00.000Z',
            semanticIdentity: `sha256:${'e'.repeat(64)}`,
            contentFingerprint: 'fnv1a32:eeeeeeee',
            sourceFileName: 'external-tab.csv',
            fileLastModified: '2026-07-15T13:00:00.000Z',
          }),
          syncSummary: {
            importedAt: '2026-07-15T13:00:00.000Z',
            stock: { updated: 1, added: 0, removed: 0 },
            trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
          },
        }))
        externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
      })

      const raw = v3Snapshot(incomingProvenance('3'), {
        holdings: [{ code: 'R3-CASE3', name: 'R3-3銘柄', eval: 303_000, pnlPct: 0 }],
      })
      const result = await useAppStore.getState().importPortfolioSnapshot(raw)
      unsubscribe()

      if (externalRaw !== null) {
        expect({
          resultOk: result.ok,
          resultCode: result.code,
          externalBytesPreserved: storage[CSV_IMPORT_GENERATION_KEY] === externalRaw,
        }).toEqual({
          resultOk: false,                 // 現行: SUCCESS
          resultCode: 'IMPORT_CONFLICT',   // 現行: SUCCESS（stale CASの欠如）
          externalBytesPreserved: true,    // 現行: 外部世代bytesが無条件上書きで消される
        })
      } else {
        // 部分世代通知が存在しない（=修正済みの単一世代通知）ならinjection自体が
        // 発火せず、通常のfirst importとして成功していなければならない。
        expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      }
    })

    it('R3-4 RED: store空(hydration前/別tab相当)でもcommitted canonicalはgeneration evidenceとして上書きを阻止する（現行: ALLOW_FIRST_IMPORTで上書きSUCCESS）', async () => {
      const seededRaw = seedCommittedCanonical()
      const raw = v3Snapshot(incomingProvenance('4'), {
        holdings: [{ code: 'R3-CASE4', name: 'R3-4銘柄', eval: 304_000, pnlPct: 0 }],
      })

      const result = await useAppStore.getState().importPortfolioSnapshot(raw)

      expect({
        resultOk: result.ok,
        canonicalUnchanged: storage[CSV_IMPORT_GENERATION_KEY] === seededRaw,
        storeHoldings: useAppStore.getState().holdings.map(h => h.code),
      }).toEqual({
        resultOk: false,          // 現行: storeだけを見てfirst import扱いでSUCCESS
        canonicalUnchanged: true, // 現行: committed canonical世代が置換される
        storeHoldings: [],        // 現行: R3-CASE4が公開される
      })
    })

    it('R3-5 RED: 新世代envelopeへ旧generationのtrustShortSnapshot baselineを再添付しない（現行: canonical.payloadの旧baselineをそのまま引き継ぐ）', async () => {
      const seededRaw = seedCommittedCanonical()
      const raw = v3Snapshot(incomingProvenance('5'), {
        holdings: [{ code: 'R3-CASE5', name: 'R3-5銘柄', eval: 305_000, pnlPct: 0 }],
      })

      const result = await useAppStore.getState().importPortfolioSnapshot(raw)

      const envelopeChanged = storage[CSV_IMPORT_GENERATION_KEY] !== seededRaw
      if (envelopeChanged) {
        const generation = restoreCsvImportGeneration()
        if (generation.status !== 'committed') throw new Error('expected committed generation after replacement')
        // importが新世代envelopeを書いたのであれば、そのtrust-short baselineは
        // incoming generationからstageされたものでなければならず、旧世代の
        // 実行判定baseline（2026-07-01のsnapshot）を再添付してはならない。
        expect(generation.payload.trustShortSnapshot).not.toEqual(OLD_TRUST_SHORT_BASELINE)
      } else {
        // canonical evidenceで上書き自体を阻止した場合はok:falseであること
        expect(result.ok).toBe(false)
      }
    })

    it('R3-9 RED: canonical成功後のmirror key(policy/cash)書込失敗でも、reload時の正は単一世代（現行: envelope新+policy/cash旧の鋏状混合）', async () => {
      const seededRaw = seedCommittedCanonical()
      persistPortfolioPolicy({ jpStockMaxRatio: 0.15 })
      persistCashAssumptions({
        cashDeposits: 111,
        standbyFunds: 222,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-10T00:00:00.000Z',
      })
      failKeys.add('v13_portfolio_policy')
      failKeys.add('v13_cash_assumptions')
      const snapshotCash = {
        cashDeposits: 900_000,
        standbyFunds: 90_000,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-15T10:30:00.000Z',
      }
      const raw = v3Snapshot(incomingProvenance('9'), {
        holdings: [{ code: 'R3-CASE9', name: 'R3-9銘柄', eval: 309_000, pnlPct: 0 }],
        portfolioPolicy: { jpStockMaxRatio: 0.12 },
        cashAssumptions: snapshotCash,
      })

      const result = await useAppStore.getState().importPortfolioSnapshot(raw)

      const canonicalChanged = storage[CSV_IMPORT_GENERATION_KEY] !== seededRaw
      if (result.ok && canonicalChanged) {
        // envelopeが新世代になった以上、reloadで復元されるpolicy/cashも同一世代で
        // なければならない（envelope内へ移す or 失敗時はimport全体を失敗させる）。
        expect({
          reloadPolicy: restorePortfolioPolicy(),
          reloadCash: restoreCashAssumptions(),
        }).toEqual({
          reloadPolicy: { jpStockMaxRatio: 0.12 },  // 現行: 旧mirror値 0.15 が残る
          reloadCash: snapshotCash,                 // 現行: 旧mirror値 111/222 が残る
        })
      } else {
        expect(result.ok).toBe(false)
      }
    })

    it('R3-10 RED: durable書込直後に所有権を失ったimportはSUCCESSを公開せず、外部transactionのbytesを消さない（現行: 所有権検証なしにSUCCESS）', async () => {
      const seededRaw = seedCommittedCanonical()
      // 外部transactionが書く別generationのbytesを先に構築しておく
      persistCsvImportTransaction(oldGenerationPayload({
        holdings: [holding('7777', 777_000)],
        importedAt: '2026-07-15T14:00:00.000Z',
        provenance: provenance({
          importedAt: '2026-07-15T14:00:00.000Z',
          sourceAsOf: '2026-07-15T14:00:00.000Z',
          semanticIdentity: `sha256:${'f'.repeat(64)}`,
          contentFingerprint: 'fnv1a32:ffffffff',
          sourceFileName: 'external-owner.csv',
          fileLastModified: '2026-07-15T14:00:00.000Z',
        }),
        syncSummary: {
          importedAt: '2026-07-15T14:00:00.000Z',
          stock: { updated: 1, added: 0, removed: 0 },
          trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
        },
      }))
      const externalRaw = storage[CSV_IMPORT_GENERATION_KEY]
      storage[CSV_IMPORT_GENERATION_KEY] = seededRaw

      let canonicalWriteHappened = false
      storageReentry = key => {
        if (key !== CSV_IMPORT_GENERATION_KEY || canonicalWriteHappened) return
        canonicalWriteHappened = true
        storage[CSV_IMPORT_GENERATION_KEY] = externalRaw
      }

      const raw = v3Snapshot(incomingProvenance('a'), {
        holdings: [{ code: 'R3-CASE10', name: 'R3-10銘柄', eval: 310_000, pnlPct: 0 }],
      })
      const result = await useAppStore.getState().importPortfolioSnapshot(raw)
      storageReentry = null

      if (canonicalWriteHappened) {
        expect({
          resultOk: result.ok,
          externalBytesPreserved: storage[CSV_IMPORT_GENERATION_KEY] === externalRaw,
        }).toEqual({
          resultOk: false,               // 現行: 所有権喪失を検知せずSUCCESSを返す
          externalBytesPreserved: true,  // rollbackは他transactionのbytesを消してはならない
        })
      } else {
        // canonical evidenceで書込前に阻止した場合（R3-4の修正形）はok:falseであること
        expect(result.ok).toBe(false)
      }
    })

    it('R3-13 RED: present-invalid canonicalはfail-closedし、deadなlegacy書込を発生させない（現行: SUCCESS + 復元されないlegacy write）', async () => {
      storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
      const raw = v3Snapshot(incomingProvenance('f'), {
        holdings: [{ code: 'R3-CASE13', name: 'R3-13銘柄', eval: 313_500, pnlPct: 0 }],
      })

      const result = await useAppStore.getState().importPortfolioSnapshot(raw)

      const state = useAppStore.getState()
      expect({
        resultOk: result.ok,
        legacyPortfolioWrites: writeLog.filter(key => key === 'v81_portfolio').length,
        legacyTrustWrites: writeLog.filter(key => key === 'v81_trust').length,
        storeHoldings: state.holdings.map(h => h.code),
        canonicalRaw: storage[CSV_IMPORT_GENERATION_KEY],
        reloadHoldings: restorePortfolio(),
      }).toEqual({
        resultOk: false,           // 現行: invalid canonicalを無視してSUCCESS
        legacyPortfolioWrites: 0,  // 現行: 1（invalid envelopeが優先されるため復元不能なdead write）
        legacyTrustWrites: 0,      // 現行: 1
        storeHoldings: [],         // 現行: R3-CASE13が公開される
        canonicalRaw: '{malformed',
        reloadHoldings: null,      // invalid envelopeがある限りreloadは常にnull（dead writeの証明）
      })
    })
  })

  describe('pinned: importCsv共有transaction境界（共有transaction化がimportCsvへ触れるための固定test）', () => {
    it('R3-14 RED: durable commit後publish前のcrash相当例外では、報告されるpersistence statusと物理bytesが一致する（現行: rolled_back報告なのにcanonicalは新世代のまま残る）', async () => {
      crashAfterStoreKeys.add(CSV_IMPORT_GENERATION_KEY)

      const result = await useAppStore.getState().importCsv(csvFile())

      const durable = restoreCsvImportGeneration()
      const durableIsNew = durable.status === 'committed' &&
        durable.payload.holdings.some(h => h.eval === 150_000)
      const storeIsNew = useAppStore.getState().holdings.some(h => h.eval === 150_000)

      if (result.ok) {
        // recovery方式: SUCCESSを返すならstoreはcommitted generationへ回復していること
        expect({ durableIsNew, storeIsNew }).toEqual({ durableIsNew: true, storeIsNew: true })
      } else if (result.persistence.status === 'rolled_back') {
        // 構造化失敗方式: rolled_backと報告する以上、物理bytesも旧世代へ戻っていること。
        // 現行はcanonicalに新世代bytesが残ったままrolled_backを返す（reloadすると
        // 失敗したはずのimport世代が出現する）。
        expect({
          reportedPersistence: 'rolled_back',
          durableHoldsNewGeneration: durableIsNew,
          storeIsNew,
        }).toEqual({
          reportedPersistence: 'rolled_back',
          durableHoldsNewGeneration: false,  // 現行: true
          storeIsNew: false,
        })
      } else {
        // それ以外は物理残留を正確に報告する構造化recovery resultであること
        expect(['rollback_failed', 'ownership_lost', 'not_attempted']).toContain(result.persistence.status)
      }
    })
  })
})
