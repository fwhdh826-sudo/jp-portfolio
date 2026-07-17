// T9-A004-R3d: canonical storage evidence / present-invalid writer policyの恒久契約test。
//
//   - F-SNAPSHOT-CANONICAL-DIVERGENCE-03: valid committed canonicalは、Zustand storeが
//     empty/partial/staleでもcurrent generation evidenceとして取込判定のauthorityになる
//   - F-SNAPSHOT-NONATOMIC-PUBLISH-04: present-invalid canonical（keyは存在するが
//     JSON/manifest/checksum/deep validationを通らない）はfail-closedし、mutation・
//     analysis・canonical write・legacy writeのいずれの副作用も発生させない
//
// absent（key自体が無い）とpresent-invalidは厳密に区別される: legacy互換のfirst-import
// policyが許されるのはabsentのみで、present-invalidからのlegacy fallbackは存在しない。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CsvImportProvenance, Holding } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import { useAppStore } from './useAppStore'
import {
  CSV_IMPORT_GENERATION_KEY,
  persistCsvImportTransaction,
  restorePortfolio,
  type CsvImportPersistencePayload,
} from './persist'
import { computeSnapshotGenerationIdentity } from '../utils/snapshotGenerationIdentity'

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

// 各generationはsourceAsOf（authoritative）とsemanticIdentity 1文字tagで識別する。
function generationProvenance(tag: string, sourceAsOf: string): CsvImportProvenance {
  return {
    importedAt: sourceAsOf,
    sourceAsOf,
    sourceAsOfKind: 'csv_explicit',
    sourceAsOfConfidence: 'authoritative',
    semanticIdentity: `sha256:${tag.repeat(64)}`,
    contentFingerprint: `fnv1a32:${tag.repeat(8)}`,
    sourceFileName: `generation-${tag}.csv`,
    fileLastModified: sourceAsOf,
  }
}

function v3Snapshot(
  csvImportProvenance: CsvImportProvenance | null,
  overrides: Record<string, unknown> = {},
): string {
  const payload: Record<string, unknown> = {
    schemaVersion: 'portfolio-snapshot-3',
    exportedAt: '2026-07-15T23:00:00.000Z',
    csvImportedAt: csvImportProvenance?.importedAt ?? null,
    csvImportProvenance,
    source: 'manual',
    holdings: [{ code: 'R3D-DEFAULT', name: 'R3D既定銘柄', eval: 100_000, pnlPct: 0 }],
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

describe('T9-A004-R3d: canonical storage evidence / present-invalid writer policy', () => {
  const storage: Record<string, string> = {}
  const writeLog: string[] = []
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
      writeLog.push(key)
      storage[key] = value
    },
    removeItem: (key: string) => { delete storage[key] },
  }

  function canonicalPayload(
    tag: string,
    sourceAsOf: string,
    overrides: Partial<CsvImportPersistencePayload> = {},
  ): CsvImportPersistencePayload {
    const provenance = generationProvenance(tag, sourceAsOf)
    return {
      holdings: [holding('9999', 200_000)],
      trust: [],
      learning: null,
      importedAt: provenance.importedAt,
      provenance,
      syncSummary: {
        importedAt: provenance.importedAt,
        stock: { updated: 1, added: 0, removed: 0 },
        trust: { updated: 0, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
      },
      trustShortSnapshot: { date: '2026-07-01', total: 200_000, evalById: { 'fund-old': 200_000 } },
      ...overrides,
    }
  }

  // committed canonical世代をseedし、seed書込自体をwriteLogから除外して返す。
  function seedCommittedCanonical(tag: string, sourceAsOf: string): string {
    persistCsvImportTransaction(canonicalPayload(tag, sourceAsOf))
    writeLog.length = 0
    return storage[CSV_IMPORT_GENERATION_KEY]
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    vi.stubGlobal('localStorage', localStorageMock)
    Object.keys(storage).forEach(key => delete storage[key])
    writeLog.length = 0
    // 空generation（hydration直後・CSV未取込・手動override無し）を既定baselineにする。
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
  })

  describe('valid committed canonicalはstore emptyでもcurrent generation evidence', () => {
    it('R3d-1: store empty + canonical valid + 同一generationのincomingはDUPLICATE_SNAPSHOTのno-op（上書き・再analysis・side effect 0）', () => {
      const seededRaw = seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      // canonicalと同一のsource provenanceを持つsnapshot（同一generationの再取込相当）
      const raw = v3Snapshot(generationProvenance('0', '2026-07-10T00:00:00.000Z'), {
        holdings: [{ code: 'R3D-CASE1', name: 'R3d-1銘柄', eval: 111_000, pnlPct: 0 }],
      })
      const before = useAppStore.getState()
      let notifications = 0
      const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

      const result = useAppStore.getState().importPortfolioSnapshot(raw)
      unsubscribe()

      expect({
        result,
        canonicalUnchanged: storage[CSV_IMPORT_GENERATION_KEY] === seededRaw,
        storeUntouched: useAppStore.getState() === before,
        storageWrites: writeLog.length,
        notifications,
      }).toEqual({
        result: { ok: true, code: 'DUPLICATE_SNAPSHOT' },
        canonicalUnchanged: true,
        storeUntouched: true,
        storageWrites: 0,
        notifications: 0,
      })
    })

    it('R3d-2: store empty + canonical valid + 別generationのincomingはSNAPSHOT_OVERWRITE_BLOCKED（canonical世代のsilent overwrite禁止・side effect 0）', () => {
      const seededRaw = seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      const raw = v3Snapshot(generationProvenance('2', '2026-07-15T11:00:00.000Z'), {
        holdings: [{ code: 'R3D-CASE2', name: 'R3d-2銘柄', eval: 222_000, pnlPct: 0 }],
      })
      const before = useAppStore.getState()
      let notifications = 0
      const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

      const result = useAppStore.getState().importPortfolioSnapshot(raw)
      unsubscribe()

      expect({
        resultOk: result.ok,
        resultCode: result.code,
        canonicalUnchanged: storage[CSV_IMPORT_GENERATION_KEY] === seededRaw,
        storeUntouched: useAppStore.getState() === before,
        storageWrites: writeLog.length,
        notifications,
      }).toEqual({
        resultOk: false,
        resultCode: 'SNAPSHOT_OVERWRITE_BLOCKED',
        canonicalUnchanged: true,
        storeUntouched: true,
        storageWrites: 0,
        notifications: 0,
      })
    })

    it('R3d-3: store empty + canonical valid + provenance無しincomingはlegacy互換扱いにならない（absentとpresentの混同禁止）。canonical除去後のretryはfirst importとして成功する', () => {
      seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      const raw = v3Snapshot(null, {
        holdings: [{ code: 'R3D-CASE3', name: 'R3d-3銘柄', eval: 333_000, pnlPct: 0 }],
      })

      const blocked = useAppStore.getState().importPortfolioSnapshot(raw)
      expect(blocked).toMatchObject({ ok: false, code: 'SNAPSHOT_PROVENANCE_UNKNOWN' })
      expect(useAppStore.getState().holdings).toEqual([])

      // canonicalを正しく除去（absent化）した状態でのretryは既存first-import policyへ戻る
      delete storage[CSV_IMPORT_GENERATION_KEY]
      const retry = useAppStore.getState().importPortfolioSnapshot(raw)
      expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(useAppStore.getState().holdings.map(h => h.code)).toEqual(['R3D-CASE3'])
    })

    it('R3d-4: store stale + canonical newerでは判定はcanonical基準（storeより新しくcanonicalより古いincomingはSNAPSHOT_STALE）', () => {
      // store: 旧generation a（2026-07-09）を保持したままのstale状態
      const staleStoreProvenance = generationProvenance('a', '2026-07-09T00:00:00.000Z')
      useAppStore.setState(state => ({
        holdings: [holding('1001', 150_000)],
        system: {
          ...state.system,
          csvLastImportedAt: staleStoreProvenance.importedAt,
          csvImportProvenance: staleStoreProvenance,
        },
      }))
      // canonical: より新しいgeneration c（2026-07-15T13:00）がdurableに成立済み
      const seededRaw = seedCommittedCanonical('c', '2026-07-15T13:00:00.000Z')
      // incoming d: store基準ならALLOW_NEWERだがcanonical基準ではstale
      const raw = v3Snapshot(generationProvenance('d', '2026-07-12T00:00:00.000Z'), {
        holdings: [{ code: 'R3D-CASE4', name: 'R3d-4銘柄', eval: 444_000, pnlPct: 0 }],
      })
      const before = useAppStore.getState()

      const result = useAppStore.getState().importPortfolioSnapshot(raw)

      expect({
        resultOk: result.ok,
        resultCode: result.code,
        canonicalUnchanged: storage[CSV_IMPORT_GENERATION_KEY] === seededRaw,
        storeUntouched: useAppStore.getState() === before,
        storageWrites: writeLog.length,
      }).toEqual({
        resultOk: false,
        resultCode: 'SNAPSHOT_STALE',
        canonicalUnchanged: true,
        storeUntouched: true,
        storageWrites: 0,
      })
    })

    it('R3d-5: store generation A + canonical generation Bの乖離ではcanonicalが勝つ（canonicalと同時刻・別identityはSNAPSHOT_PROVENANCE_CONFLICT）', () => {
      const staleStoreProvenance = generationProvenance('a', '2026-07-09T00:00:00.000Z')
      useAppStore.setState(state => ({
        holdings: [holding('1001', 150_000)],
        system: {
          ...state.system,
          csvLastImportedAt: staleStoreProvenance.importedAt,
          csvImportProvenance: staleStoreProvenance,
        },
      }))
      const seededRaw = seedCommittedCanonical('c', '2026-07-15T13:00:00.000Z')
      // canonicalと同一sourceAsOf・別semanticIdentity（store基準ならALLOW_NEWER）
      const raw = v3Snapshot(generationProvenance('e', '2026-07-15T13:00:00.000Z'), {
        holdings: [{ code: 'R3D-CASE5', name: 'R3d-5銘柄', eval: 555_000, pnlPct: 0 }],
      })
      const before = useAppStore.getState()

      const result = useAppStore.getState().importPortfolioSnapshot(raw)

      expect({
        resultOk: result.ok,
        resultCode: result.code,
        canonicalUnchanged: storage[CSV_IMPORT_GENERATION_KEY] === seededRaw,
        storeUntouched: useAppStore.getState() === before,
        storageWrites: writeLog.length,
      }).toEqual({
        resultOk: false,
        resultCode: 'SNAPSHOT_PROVENANCE_CONFLICT',
        canonicalUnchanged: true,
        storeUntouched: true,
        storageWrites: 0,
      })
    })

    it('R3d-6: store provenance null + canonical authoritativeでもcanonicalがevidence（別generationはblock、同一generationはduplicate）', () => {
      // store: 内容はあるがprovenance評価不能（provenance null + importedAtのみ）
      useAppStore.setState(state => ({
        holdings: [holding('9999', 200_000)],
        system: {
          ...state.system,
          csvLastImportedAt: '2026-07-10T00:00:00.000Z',
          csvImportProvenance: null,
        },
      }))
      seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')

      const blocked = useAppStore.getState().importPortfolioSnapshot(
        v3Snapshot(generationProvenance('2', '2026-07-15T11:00:00.000Z'), {
          holdings: [{ code: 'R3D-CASE6', name: 'R3d-6銘柄', eval: 666_000, pnlPct: 0 }],
        }),
      )
      // store側provenance nullならALLOW_FIRST_KNOWNだが、いずれもcurrent generationが
      // 存在する以上silent overwriteはできない
      expect(blocked).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })

      const duplicate = useAppStore.getState().importPortfolioSnapshot(
        v3Snapshot(generationProvenance('0', '2026-07-10T00:00:00.000Z'), {
          holdings: [{ code: 'R3D-CASE6B', name: 'R3d-6b銘柄', eval: 666_500, pnlPct: 0 }],
        }),
      )
      expect(duplicate).toEqual({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
      expect(writeLog.length).toBe(0)
    })
  })

  describe('present-invalid canonicalのfail-closed writer policy', () => {
    function expectFailClosed(rawCanonical: string, incomingTag: string) {
      storage[CSV_IMPORT_GENERATION_KEY] = rawCanonical
      writeLog.length = 0
      const raw = v3Snapshot(generationProvenance(incomingTag, '2026-07-15T11:00:00.000Z'), {
        holdings: [{ code: `R3D-INVALID-${incomingTag}`, name: 'R3d-invalid銘柄', eval: 700_000, pnlPct: 0 }],
      })
      const before = useAppStore.getState()
      let notifications = 0
      const unsubscribe = useAppStore.subscribe(() => { notifications += 1 })

      const result = useAppStore.getState().importPortfolioSnapshot(raw)
      unsubscribe()

      expect({
        resultOk: result.ok,
        resultCode: result.code,
        canonicalBytes: storage[CSV_IMPORT_GENERATION_KEY],
        storeUntouched: useAppStore.getState() === before,
        storageWrites: writeLog.length,
        notifications,
      }).toEqual({
        resultOk: false,
        resultCode: 'SNAPSHOT_CANONICAL_INVALID',
        canonicalBytes: rawCanonical,
        storeUntouched: true,
        storageWrites: 0,
        notifications: 0,
      })
      // raw parser/storage errorをUI（result.error）へ素通ししない
      if (result.ok === false) {
        expect(result.error).not.toMatch(/Unexpected|JSON|token|checksum|parse/i)
      }
    }

    it('R3d-7: malformed JSON canonicalは構造化fail-closed（mutation/analysis/storage write/通知 0）', () => {
      expectFailClosed('{malformed', '3')
    })

    it('R3d-8: checksum不正canonicalは構造化fail-closed', () => {
      seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      const envelope = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
      envelope.payload.holdings[0].eval += 1  // checksumと不一致になる改変
      expectFailClosed(JSON.stringify(envelope), '4')
    })

    it('R3d-9: manifest不正（committed marker欠落）canonicalは構造化fail-closed', () => {
      seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      const envelope = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
      envelope.manifest.committed = false
      expectFailClosed(JSON.stringify(envelope), '5')
    })

    it('R3d-10: deep validation不正（holdingsの負のeval）canonicalは構造化fail-closed', () => {
      seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      const envelope = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
      envelope.payload.holdings[0].eval = -1
      expectFailClosed(JSON.stringify(envelope), '6')
    })

    it('R3d-11: 未知schema versionのpresent-invalid v3 canonicalは構造化fail-closed', () => {
      seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      const envelope = JSON.parse(storage[CSV_IMPORT_GENERATION_KEY])
      envelope.manifest.schemaVersion = 'csv-import-generation-99'
      expectFailClosed(JSON.stringify(envelope), '7')
    })

    it('R3d-12: present-invalid canonical + 有効なlegacy keysでもlegacy fallback/legacy write 0（dead write禁止・reloadはnullのまま）', () => {
      storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
      const legacyPortfolioRaw = JSON.stringify({ data: [holding('8888', 800_000)], savedAt: FIXED_NOW.getTime() })
      const legacyTrustRaw = JSON.stringify({ data: [], savedAt: FIXED_NOW.getTime() })
      storage.v81_portfolio = legacyPortfolioRaw
      storage.v81_trust = legacyTrustRaw
      writeLog.length = 0
      const raw = v3Snapshot(generationProvenance('8', '2026-07-15T11:00:00.000Z'), {
        holdings: [{ code: 'R3D-CASE12', name: 'R3d-12銘柄', eval: 812_000, pnlPct: 0 }],
      })

      const result = useAppStore.getState().importPortfolioSnapshot(raw)

      expect({
        resultOk: result.ok,
        resultCode: result.code,
        legacyPortfolioWrites: writeLog.filter(key => key === 'v81_portfolio').length,
        legacyTrustWrites: writeLog.filter(key => key === 'v81_trust').length,
        legacyPortfolioBytes: storage.v81_portfolio,
        legacyTrustBytes: storage.v81_trust,
        storeHoldings: useAppStore.getState().holdings,
        reloadHoldings: restorePortfolio(),
      }).toEqual({
        resultOk: false,
        resultCode: 'SNAPSHOT_CANONICAL_INVALID',
        legacyPortfolioWrites: 0,
        legacyTrustWrites: 0,
        legacyPortfolioBytes: legacyPortfolioRaw,
        legacyTrustBytes: legacyTrustRaw,
        storeHoldings: [],
        reloadHoldings: null,  // invalid canonicalがある限りlegacyへはfallbackしない
      })
    })

    it('R3d-13: reject中はanalysisが一切実行されない（analysis失敗を強制してもcodeはSNAPSHOT_CANONICAL_INVALIDのまま）', () => {
      const throwingMarket = new Proxy(baseMarket, {
        get(target, property) {
          if (property === 'regime') throw new Error('forced analysis failure')
          return Reflect.get(target, property)
        },
      })
      useAppStore.setState({ market: throwingMarket })
      storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
      writeLog.length = 0
      const raw = v3Snapshot(generationProvenance('9', '2026-07-15T11:00:00.000Z'), {
        holdings: [{ code: 'R3D-CASE13', name: 'R3d-13銘柄', eval: 913_000, pnlPct: 0 }],
      })

      let result: ReturnType<ReturnType<typeof useAppStore.getState>['importPortfolioSnapshot']> | null = null
      let thrown: unknown = null
      try {
        result = useAppStore.getState().importPortfolioSnapshot(raw)
      } catch (error) {
        thrown = error
      }

      expect({ thrown, resultCode: result?.code, storageWrites: writeLog.length }).toEqual({
        thrown: null,
        resultCode: 'SNAPSHOT_CANONICAL_INVALID',
        storageWrites: 0,
      })
    })

    it('R3d-14: present-invalid reject後、canonicalを修復（valid世代へ復元）した状態のretryは正常judgmentへ戻る。除去（absent化）ならfirst importとして成功する', () => {
      storage[CSV_IMPORT_GENERATION_KEY] = '{malformed'
      const raw = v3Snapshot(generationProvenance('b', '2026-07-15T11:00:00.000Z'), {
        holdings: [{ code: 'R3D-CASE14', name: 'R3d-14銘柄', eval: 914_000, pnlPct: 0 }],
      })

      const rejected = useAppStore.getState().importPortfolioSnapshot(raw)
      expect(rejected).toMatchObject({ ok: false, code: 'SNAPSHOT_CANONICAL_INVALID' })

      // 修復1: valid committed世代へ復元 → canonical evidence基準の正常judgment（block）
      delete storage[CSV_IMPORT_GENERATION_KEY]
      seedCommittedCanonical('0', '2026-07-10T00:00:00.000Z')
      const judged = useAppStore.getState().importPortfolioSnapshot(raw)
      expect(judged).toMatchObject({ ok: false, code: 'SNAPSHOT_OVERWRITE_BLOCKED' })

      // 修復2: 除去（absent化） → first importとして完全実行される
      // （rejectがtransaction lockやlastAppliedSnapshotGenerationを残していない証明）
      delete storage[CSV_IMPORT_GENERATION_KEY]
      const retry = useAppStore.getState().importPortfolioSnapshot(raw)
      expect(retry).toMatchObject({ ok: true, code: 'SUCCESS' })
      expect(useAppStore.getState().holdings.map(h => h.code)).toEqual(['R3D-CASE14'])
      expect(JSON.parse(storage[CSV_IMPORT_GENERATION_KEY]).manifest.committed).toBe(true)
    })
  })
})
