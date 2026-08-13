import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import type { CashAssumptions, Trust } from '../types'
import {
  resetPortfolioGenerationLockAdapterForTest,
  runFullAnalysis,
  setPortfolioGenerationLockAdapterForTest,
  useAppStore,
} from './useAppStore'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import {
  CASH_AUTHORITY_TTL_MS,
  CASH_AUTHORITY_APPROACHING_EXPIRY_MS,
  NO_CASH_AUTHORITY,
} from '../domain/cash/cashAuthority'
import { selectCashAssumptionsFreshness } from './selectors'
import { computeCandidateActionsForDisplay } from '../components/tabs/T0_Home'

// P4.5-A013-T5:
// public/data/trust_master.json はP4.5-A010-1aで恒久的に配信停止された（今後
// dataTimestamps.trustは常にnull）。従来のcandidate pipelineゲートは
// `dataTimestamps.trust != null` を条件にしていたため、CSV full-sync（T3）で
// 得た信頼できる保有eval値があっても、投信候補パイプラインが恒久的に停止する
// バグがあった。修正後は「csvLastImportedAtが設定されているか（＝eval値が
// CSV由来で信頼できるか）」でゲートし、trust_masterの取得成否には依存しない。
//
// ここではrunFullAnalysisを直接呼び出し、以下を確認する:
//  - trust timestamp null + 最新CSV + fresh market → 候補パイプラインが動く
//  - trust timestamp null + stale market（DQ抑制）→ BUY抑制は維持される
//  - CSV未取込（csvLastImportedAt=null）→ 候補パイプラインは動かない（安全側）
//  - trust registry不正（空配列等）→ fail-safeでクラッシュしない
//  - SAFE_MODE active → 候補抑制が維持される
//  - noTrade（緊急） → 候補抑制が維持される

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'held_overseas',
    name: '海外長期保有ファンド',
    abbr: '海外長期',
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

// score>=75, sigma<0.25, marketCaution=false, cost<=0.60(gold threshold), account!=='NISA積立'
// → 全gateを通過しBUY_NEWとなるゴールド候補（role='gold'はrole重複gate対象外）
function makeGoldCandidate(overrides: Partial<Trust> = {}): Trust {
  return makeTrust({
    id: 'gold_candidate',
    name: '金インデックスファンド',
    abbr: 'ゴールド',
    policy: 'GOLD',
    eval: 0,
    cost: 0.3,
    mu: 0.10,
    sigma: 0.10,
    ...overrides,
  })
}

// CASH-AUTH-1 R1: score>=75 だが sigma∈[VOL_SOFT_LIMIT(0.25), VOL_HARD_LIMIT(0.30)) のため
// BUY_NEWからWATCHへ降格される候補（policy=GOLDでrole重複gate対象外、hard volブロックも回避）。
// suggestedAmount/maxAmountはBUY_NEWと同じ計算式を通るため、WATCHでも金額が付き得ることの
// 固定用フィクスチャ。
function makeWatchGoldCandidate(overrides: Partial<Trust> = {}): Trust {
  return makeTrust({
    id: 'watch_gold_candidate',
    name: '金インデックスファンド（WATCH想定）',
    abbr: 'ゴールドW',
    policy: 'GOLD',
    eval: 0,
    cost: 0.3,
    mu: 0.10,
    sigma: 0.27,
    ...overrides,
  })
}

// P0-PRIVACY-DEPLOY-RECOVERY: 固定の過去日時だと、selectMarketDataQuality /
// computeSafeModeDataQuality が実行時のDate.now()と比較してMARKET_DATA_STALE_HOURS
// (24h) / SAFE_MODE_STALE_HOURS (96h) を超過した時点でfail-closedに倒れ、
// 「fresh」を意図したテストが実行日に依存して壊れる（テスト分離不足）。
// stockLock.test.tsのdaysAgo()と同様に、実行時刻基準の動的な値にして
// 常にfreshと評価されるようにする。
const NOW = new Date().toISOString()
const NOW_MS = Date.parse(NOW)
const HOUR_MS = 60 * 60 * 1000

function buildPermissiveState(overrides: {
  trust?: Trust[]
  csvLastImportedAt?: string | null
  marketFresh?: boolean
  safeModeActive?: boolean
  safeModeFresh?: boolean
  cashAssumptions?: CashAssumptions
}) {
  const base = useAppStore.getState()
  const marketFresh = overrides.marketFresh ?? true
  const safeModeFresh = overrides.safeModeFresh ?? true
  const safeModeActive = overrides.safeModeActive ?? false

  return {
    ...base,
    holdings: [],
    trust: overrides.trust ?? [makeTrust(), makeGoldCandidate()],
    // P0-PRIVACY-HOTFIX / CASH-AUTH-1: BUY_NEW候補のavailableCash gate
    // （INSUFFICIENT_CASH）を通過させるには、このテスト用の"permissive"状態として
    // 有効な現金権限を明示的に与える必要がある。権限なし（DEFAULT）は unknown で
    // あり、legacy な state.cash から金額を推測することはもう無い。
    cash: 5_000_000,
    cashReserve: 0,
    cashAssumptions: overrides.cashAssumptions ?? {
      source: 'MANUAL' as const,
      grossCash: 5_000_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: NOW,
    },
    safeMode: {
      ...base.safeMode,
      safe_mode: { ...base.safeMode.safe_mode, active: safeModeActive },
    },
    system: {
      ...base.system,
      csvLastImportedAt: overrides.csvLastImportedAt === undefined ? NOW : overrides.csvLastImportedAt,
      dataSourceStatus: {
        ...base.system.dataSourceStatus,
        market: marketFresh ? ('loaded' as const) : ('static' as const),
        safeMode: 'loaded' as const,
      },
      dataTimestamps: {
        ...base.system.dataTimestamps!,
        market: marketFresh ? NOW : null,
        trust: null, // public trust_master.jsonは常に404（P4.5-A010-1a）
        safeMode: safeModeFresh ? NOW : null,
      },
    },
  }
}

function goldCandidateAction(officialDecision: ReturnType<typeof runFullAnalysis>['officialDecision']) {
  return officialDecision?.actions.find(a => a.isCandidate && a.assetType === 'gold')
}

function candidateActionById(
  officialDecision: ReturnType<typeof runFullAnalysis>['officialDecision'],
  trustId: string,
) {
  return officialDecision?.actions.find(a => a.id === `candidate-${trustId}`)
}

describe('runFullAnalysis: 投信候補パイプラインとtrust_master公開停止の分離（P4.5-A013-T5）', () => {
  it('trust timestamp null + 最新CSV + fresh market → 候補パイプラインが不必要に停止せずBUY_NEW候補が出る', () => {
    const state = buildPermissiveState({})
    const result = runFullAnalysis(state)

    expect(state.system.dataTimestamps.trust).toBeNull() // 前提: public trust_masterは404
    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeDefined()
    expect(candidate?.action).toBe('BUY_NEW')
  })

  it('trust timestamp null + stale market（DQ抑制） → BUY抑制が維持される（候補は出るがBLOCKED）', () => {
    const state = buildPermissiveState({ marketFresh: false })
    const result = runFullAnalysis(state)

    // csvLastImportedAtがあるため候補パイプライン自体は動くが、
    // market dqSuppressedによりGate1（DQ_SUPPRESSED）で即ブロックされる
    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeUndefined()
  })

  it('CSV未取込（csvLastImportedAt=null）+ registryのみ → 候補パイプラインは安全側で動かない', () => {
    const state = buildPermissiveState({ csvLastImportedAt: null })
    const result = runFullAnalysis(state)

    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeUndefined()
  })

  it('trust registryが空配列でもクラッシュせずfail-safeに動作する', () => {
    const state = buildPermissiveState({ trust: [] })
    expect(() => runFullAnalysis(state)).not.toThrow()
    const result = runFullAnalysis(state)
    expect(result.officialDecision).not.toBeNull()
    expect(goldCandidateAction(result.officialDecision)).toBeUndefined()
  })

  it('trust registryが不正な値（eval等がNaN）でもクラッシュせずfail-safeに動作する', () => {
    const state = buildPermissiveState({
      trust: [makeTrust(), makeGoldCandidate({ eval: NaN as unknown as number })],
    })
    expect(() => runFullAnalysis(state)).not.toThrow()
  })

  it('SAFE_MODE active → 候補抑制が維持される（最新CSV・fresh marketでもBUY_NEWにならない）', () => {
    const state = buildPermissiveState({ safeModeActive: true })
    const result = runFullAnalysis(state)

    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeUndefined()
  })

  it('緊急noTrade（VIXパニック水準）→ 候補抑制が維持される', () => {
    const state = buildPermissiveState({})
    state.market = { ...state.market, vix: 35 } // VIX_PANIC(30)超過
    const result = runFullAnalysis(state)

    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeUndefined()
  })

  it('zeroBase（zeroPlan）はtrust候補ゲートの変更後も引き続き生成される', () => {
    const state = buildPermissiveState({})
    const result = runFullAnalysis(state)
    expect(result.zeroPlan).not.toBeNull()
  })

  it('officialDecisionはtrust候補ゲートの変更後も引き続き生成される（committee基本判定は候補と独立）', () => {
    const state = buildPermissiveState({ csvLastImportedAt: null })
    const result = runFullAnalysis(state)
    // 候補パイプラインが止まっていてもcommitteeベースのofficialDecision自体は生成される
    expect(result.officialDecision).not.toBeNull()
    expect(result.officialDecision?.source).toBe('committee')
  })
})

// ── CASH-AUTH-1 R1: legacy trust候補パイプラインの stale/unknown cash 金額 fail-closed 化 ──
// NEXT-2 acceptance audit（P3-1）で確認された欠落: state.effectiveCash.grossCash は生の
// MANUAL値であり、availableCash（→ suggestedAmount/maxAmount/amount）は cash 権限の
// 168h TTL / unknown 状態を一切見ていなかった。stale/unknown でも BUY_NEW/WATCH の
// 金額付き候補が officialDecision.actions に出得た。ここでは runFullAnalysis を直接
// 呼び出す実パイプラインで、その経路が閉じたことを固定する。
// AllocationPlanSnapshot（deriveCashModel/headroom/purchaseAmount/T2/T7共有projection）は
// このR1では一切変更していない — 元々正しく fail-closed だったため対象外。
describe('runFullAnalysis: CASH-AUTH-1 R1 現金権限のTTL/unknown/confirmed-zeroとtrust候補金額', () => {
  it('#2 stale（168h+1ms）はBUY_NEW候補金額を抑制する（候補自体が現れない）', () => {
    const state = buildPermissiveState({
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - CASH_AUTHORITY_TTL_MS - 1).toISOString(),
      },
    })
    expect(selectCashAssumptionsFreshness(state, NOW_MS).state).toBe('stale')
    const result = runFullAnalysis(state, { nowMs: NOW_MS })
    expect(goldCandidateAction(result.officialDecision)).toBeUndefined()
  })

  it('#3 staleはWATCH候補のmaxAmount（検討上限）も抑制する（fresh下でWATCH+正のmaxAmountになる候補が、staleでは0/undefinedになる）', () => {
    // 注: resolveSizingTierはaction!=='BUY_NEW'なら常にsuggestedAmount=0にするため
    // （scoreCandidates.ts既存仕様・本R1では変更していない）、WATCHでR1が実際に
    // 閉じるべき金額フィールドはmaxAmount（検討上限の参考値）である。
    const freshState = buildPermissiveState({
      trust: [makeWatchGoldCandidate()],
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - HOUR_MS).toISOString(),
      },
    })
    const freshResult = runFullAnalysis(freshState, { nowMs: NOW_MS })
    const freshCandidate = candidateActionById(freshResult.officialDecision, 'watch_gold_candidate')
    // 陽性対照: fresh cashのもとではWATCH+正のmaxAmountで現れることを先に確認する
    expect(freshCandidate).toBeDefined()
    expect(freshCandidate?.action).toBe('WATCH')
    expect(freshCandidate?.amount ?? 0).toBe(0) // WATCHはsuggestedAmount/amount自体は元々常に0（既存仕様）
    expect(freshCandidate?.maxAmount ?? 0).toBeGreaterThan(0)

    const staleState = buildPermissiveState({
      trust: [makeWatchGoldCandidate()],
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - CASH_AUTHORITY_TTL_MS - 1).toISOString(),
      },
    })
    const staleResult = runFullAnalysis(staleState, { nowMs: NOW_MS })
    const staleCandidate = candidateActionById(staleResult.officialDecision, 'watch_gold_candidate')
    // stale側: 候補自体が現れないか、現れても金額系フィールドは無い（どちらでも frozen invariant を満たす）
    if (staleCandidate !== undefined) {
      expect(staleCandidate.amount ?? 0).toBe(0)
      expect(staleCandidate.suggestedAmount ?? 0).toBe(0)
      expect(staleCandidate.maxAmount ?? 0).toBe(0)
    }
  })

  it('#4 unknown（権限未設定 DEFAULT）は新規BUY金額を一切生成しない', () => {
    const state = buildPermissiveState({ cashAssumptions: { ...NO_CASH_AUTHORITY } })
    expect(selectCashAssumptionsFreshness(state, NOW_MS).state).toBe('unknown')
    const result = runFullAnalysis(state, { nowMs: NOW_MS })
    expect(goldCandidateAction(result.officialDecision)).toBeUndefined()
  })

  it('#5 confirmed zero（grossCash=0・fresh）は known_fresh のまま金額だけ0になる（unknownとは区別される）', () => {
    const state = buildPermissiveState({
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 0,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - HOUR_MS).toISOString(),
      },
    })
    // confirmed zero は unknown と異なり known_fresh のまま
    expect(selectCashAssumptionsFreshness(state, NOW_MS).state).toBe('known_fresh')
    const result = runFullAnalysis(state, { nowMs: NOW_MS })
    expect(goldCandidateAction(result.officialDecision)).toBeUndefined()
  })

  it('#6 168hちょうどはまだ fresh — 新規BUY金額付き候補が生成される（正の境界）', () => {
    const state = buildPermissiveState({
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - CASH_AUTHORITY_TTL_MS).toISOString(),
      },
    })
    expect(selectCashAssumptionsFreshness(state, NOW_MS).state).toBe('known_fresh')
    const result = runFullAnalysis(state, { nowMs: NOW_MS })
    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeDefined()
    expect(candidate?.action).toBe('BUY_NEW')
    expect(candidate?.amount ?? 0).toBeGreaterThan(0)
  })

  it('#7 144hちょうど（まもなく失効の警告境界）でも fresh のまま新規BUY金額が生成される', () => {
    const state = buildPermissiveState({
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - CASH_AUTHORITY_APPROACHING_EXPIRY_MS).toISOString(),
      },
    })
    const freshness = selectCashAssumptionsFreshness(state, NOW_MS)
    expect(freshness.state).toBe('known_fresh')
    expect(freshness.approachingExpiry).toBe(true)
    const result = runFullAnalysis(state, { nowMs: NOW_MS })
    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeDefined()
    expect(candidate?.action).toBe('BUY_NEW')
    expect(candidate?.amount ?? 0).toBeGreaterThan(0)
  })

  it('#8 fresh positive control（1時間前更新）は既存のBUY_NEW金額生成挙動を維持する', () => {
    const state = buildPermissiveState({})
    const result = runFullAnalysis(state, { nowMs: NOW_MS })
    const candidate = goldCandidateAction(result.officialDecision)
    expect(candidate).toBeDefined()
    expect(candidate?.action).toBe('BUY_NEW')
    expect(candidate?.amount ?? 0).toBeGreaterThan(0)
  })

  it('#10 officialDecision全体の網羅invariant: staleでは isCandidate 項目のどれも正の金額を持たない', () => {
    const state = buildPermissiveState({
      trust: [makeGoldCandidate(), makeWatchGoldCandidate()],
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - CASH_AUTHORITY_TTL_MS - 1).toISOString(),
      },
    })
    const result = runFullAnalysis(state, { nowMs: NOW_MS })
    const candidateActions = result.officialDecision?.actions.filter(a => a.isCandidate) ?? []
    for (const action of candidateActions) {
      expect(action.action).not.toBe('BUY_NEW')
      expect(action.amount ?? 0).toBe(0)
      expect(action.suggestedAmount ?? 0).toBe(0)
      expect(action.maxAmount ?? 0).toBe(0)
    }
  })

  it('#11 T0表示選択（computeCandidateActionsForDisplay）はstale由来の項目にBUY_NEW金額を表示しない', () => {
    const staleState = buildPermissiveState({
      cashAssumptions: {
        source: 'MANUAL',
        grossCash: 5_000_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: new Date(NOW_MS - CASH_AUTHORITY_TTL_MS - 1).toISOString(),
      },
    })
    const staleResult = runFullAnalysis(staleState, { nowMs: NOW_MS })
    const staleDisplay = computeCandidateActionsForDisplay(staleResult.officialDecision, false, false)
    expect(staleDisplay.some(a => a.action === 'BUY_NEW')).toBe(false)

    // 陽性対照: freshでは同じ表示関数がBUY_NEW+正の金額を選択する（表示経路自体は生きている）
    const freshState = buildPermissiveState({})
    const freshResult = runFullAnalysis(freshState, { nowMs: NOW_MS })
    const freshDisplay = computeCandidateActionsForDisplay(freshResult.officialDecision, false, false)
    const freshBuyNew = freshDisplay.find(a => a.action === 'BUY_NEW')
    expect(freshBuyNew).toBeDefined()
    expect(freshBuyNew?.suggestedAmount ?? 0).toBeGreaterThan(0)
  })
})

// P4.5-A013-HARDENING-F1:
// importCsv内では従来 holdings/trust を先にset → runFullAnalysis(get()) → その後に
// csvLastImportedAt=now をsetする順序だった。上のT5ゲートはstate.system.csvLastImportedAtの
// 有無を見るため、csvLastImportedAtがnullのまま初回CSV取込のrunFullAnalysisが走る
// 初回取込ターンだけ候補パイプラインが（誤って）止まっていた。
// ここではrunFullAnalysisを直接叩くのではなく、実際のuseAppStore.importCsv()を
// 呼び出し、初回取込と同一ターンでBUY_NEW候補がofficialDecisionへ反映されることを
// 確認する（refresh/reload相当の2回目呼び出しは行わない）。
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

describe('useAppStore.importCsv: 初回CSV取込でも同一ターンでtrust candidate pipelineが動く（P4.5-A013-HARDENING-F1）', () => {
  const storage: Record<string, string> = {}
  const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value },
    removeItem: (key: string) => { delete storage[key] },
  }

  beforeEach(() => {
    setPortfolioGenerationLockAdapterForTest(
      createImmediatePortfolioGenerationLockAdapterForTest(),
    )
    Object.keys(storage).forEach(key => delete storage[key])
    vi.stubGlobal('localStorage', localStorageMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetPortfolioGenerationLockAdapterForTest()
  })

  const STOCK_ONLY_CSV = [
    '株式（現物/特定預り）',
    '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
    '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
  ].join('\n')

  function resetToPermissiveFirstImportState(overrides: Parameters<typeof buildPermissiveState>[0] = {}) {
    const permissive = buildPermissiveState({ csvLastImportedAt: null, ...overrides })
    useAppStore.setState({
      ...permissive,
      // 前のテストがVIXパニック水準等でstate.marketを書き換えたまま残る可能性があるため、
      // ここで明示的に平常値へ戻す（テスト間のstate leak防止）。
      market: { ...permissive.market, vix: 19.9 },
      holdings: [],
      system: { ...permissive.system, status: 'idle', error: null, csvSyncSummary: null },
    })
  }

  it('csvLastImportedAt=nullの初期状態から正常な初回CSV取込を行うと、同一ターンでBUY_NEW候補がofficialDecisionへ反映される（refresh不要）', async () => {
    resetToPermissiveFirstImportState()
    expect(useAppStore.getState().system.csvLastImportedAt).toBeNull()

    await useAppStore.getState().importCsv(makeCsvFile(STOCK_ONLY_CSV))

    const state = useAppStore.getState()
    expect(state.system.status).toBe('success')
    expect(state.system.csvLastImportedAt).not.toBeNull()
    const candidate = goldCandidateAction(state.officialDecision)
    expect(candidate).toBeDefined()
    expect(candidate?.action).toBe('BUY_NEW')
  })

  it('stale market（DQ抑制）: 初回CSV取込後もF1修正後の候補抑制は維持される', async () => {
    resetToPermissiveFirstImportState({ marketFresh: false })
    await useAppStore.getState().importCsv(makeCsvFile(STOCK_ONLY_CSV))
    const candidate = goldCandidateAction(useAppStore.getState().officialDecision)
    expect(candidate).toBeUndefined()
  })

  it('SAFE_MODE active: 初回CSV取込後もF1修正後の候補抑制は維持される', async () => {
    resetToPermissiveFirstImportState({ safeModeActive: true })
    await useAppStore.getState().importCsv(makeCsvFile(STOCK_ONLY_CSV))
    const candidate = goldCandidateAction(useAppStore.getState().officialDecision)
    expect(candidate).toBeUndefined()
  })

  it('緊急noTrade（VIXパニック水準）: 初回CSV取込後もF1修正後の候補抑制は維持される', async () => {
    resetToPermissiveFirstImportState()
    useAppStore.setState(s => ({ market: { ...s.market, vix: 35 } })) // VIX_PANIC(30)超過
    await useAppStore.getState().importCsv(makeCsvFile(STOCK_ONLY_CSV))
    const candidate = goldCandidateAction(useAppStore.getState().officialDecision)
    expect(candidate).toBeUndefined()
  })

  it('DQ/SAFE_MODE/noTradeいずれも該当しない通常時は、CSV取込のたびに候補が壊れず継続して出る（2回目以降の回帰なし）', async () => {
    resetToPermissiveFirstImportState()
    await useAppStore.getState().importCsv(makeCsvFile(STOCK_ONLY_CSV))
    await useAppStore.getState().importCsv(makeCsvFile(STOCK_ONLY_CSV))
    const candidate = goldCandidateAction(useAppStore.getState().officialDecision)
    expect(candidate).toBeDefined()
    expect(candidate?.action).toBe('BUY_NEW')
  })
})
