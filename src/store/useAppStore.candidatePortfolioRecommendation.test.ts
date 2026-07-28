// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CandidateFunnelArtifact,
  CashAssumptions,
  CsvImportProvenance,
  Holding,
  PortfolioPolicy,
} from '../types'
import { INITIAL_TRUST } from '../constants/trust'
import { STATIC_MARKET } from '../constants/market'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
} from './persist'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import {
  createAppStoreInstanceForTest,
  runFullAnalysis,
  useAppStore,
  type AppStoreState,
} from './useAppStore'

const source = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')

function segment(start: string, end?: string): string {
  const from = source.indexOf(start)
  const to = end === undefined ? source.length : source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function expectOrder(value: string, ordered: string[]) {
  let cursor = -1
  for (const token of ordered) {
    const next = value.indexOf(token, cursor + 1)
    expect(next, token).toBeGreaterThan(cursor)
    cursor = next
  }
}

const RACE_NOW_MS = Date.parse('2026-07-26T08:00:00.000Z')
const RACE_NOW = new Date(RACE_NOW_MS).toISOString()
const storage: Record<string, string> = {}
let throwCanonicalRead = false

const localStorageMock = {
  getItem(key: string): string | null {
    if (throwCanonicalRead && key === CSV_IMPORT_GENERATION_KEY) {
      throw new Error('injected ownership read failure')
    }
    return storage[key] ?? null
  },
  setItem(key: string, value: string): void {
    storage[key] = value
  },
  removeItem(key: string): void {
    delete storage[key]
  },
}

const RACE_PROVENANCE: CsvImportProvenance = {
  importedAt: RACE_NOW,
  sourceAsOf: RACE_NOW,
  sourceAsOfKind: 'csv_explicit',
  sourceAsOfConfidence: 'authoritative',
  semanticIdentity: `sha256:${'7'.repeat(64)}`,
  contentFingerprint: 'fnv1a32:c0d10001',
  sourceFileName: 'c-d-r1.csv',
  fileLastModified: RACE_NOW,
}

const RACE_CASH: CashAssumptions = {
  cashDeposits: 1_000_000,
  standbyFunds: 0,
  manualOverrideEnabled: true,
  manualUpdatedAt: RACE_NOW,
}

const RACE_HOLDING: Holding = {
  code: '1001',
  name: 'C-D-R1 authority holding',
  eval: 100_000,
  pnlPct: 0,
  mu: 0.1,
  sigma: 0.2,
  sigmaSource: 'static',
  beta: 1,
  sector: '銀行業',
  target: 0,
  alert: 0,
  lock: false,
  mitsu: false,
  ma: false,
  rsi: 50,
  macd: false,
  vol: false,
  mom3m: 0,
  roe: 0,
  per: 0,
  pbr: 0,
  epsG: 0,
  cfOk: false,
  de: 0,
  divG: 0,
  score: 0,
  decision: 'HOLD',
  ev: 0,
  acquiredAt: '2026-01-01',
}

type TestInstance = ReturnType<typeof createAppStoreInstanceForTest>

function raceArtifact(): CandidateFunnelArtifact {
  const value = structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
  value._meta.generatedAt = RACE_NOW
  value._meta.asOf = RACE_NOW
  value._meta.sourceUpdatedAt = RACE_NOW
  return value
}

function activeSafeModeFixture() {
  return {
    _meta: { version: 'v13.3', kind: 'operation_snapshot', not_for_trading: true },
    safe_mode: {
      active: false,
      triggered_at: null,
      trigger_reason: null,
      trigger_reason_detail: null,
      trigger_conditions: {
        tier1_data_stale: false,
        tier_a_t3_violated: false,
        crisis_regime: false,
        system_error: false,
      },
      restrictions: {
        new_buys_frozen: false,
        rebalance_frozen: false,
        force_sell_active: false,
      },
      estimated_resume_at: null,
      last_checked: RACE_NOW,
    },
  }
}

function installRaceFetchRouter(): void {
  const artifact = raceArtifact()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    const data = url.includes('candidate_funnel.json')
      ? artifact
      : url.includes('market.json')
        ? { ...STATIC_MARKET, last_updated: RACE_NOW }
        : url.includes('safe_mode.json')
          ? activeSafeModeFixture()
          : null
    return data === null
      ? { ok: false, status: 404, json: () => Promise.resolve({}) }
      : { ok: true, status: 200, json: () => Promise.resolve(structuredClone(data)) }
  }))
}

function createRaceInstance(): TestInstance {
  return createAppStoreInstanceForTest({
    portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
  })
}

function persistRaceGeneration(
  instance: TestInstance,
  policy: PortfolioPolicy,
  cashAssumptions: CashAssumptions = RACE_CASH,
): string {
  const state = instance.store.getState()
  return persistCsvImportTransaction({
    holdings: [{ ...RACE_HOLDING }],
    trust: [{ ...INITIAL_TRUST[0], eval: 200_000 }],
    learning: state.learning,
    csvImportedAt: RACE_NOW,
    provenance: RACE_PROVENANCE,
    syncSummary: null,
    trustShortSnapshot: { date: RACE_NOW.slice(0, 10), total: 200_000, evalById: { [INITIAL_TRUST[0].id]: 200_000 } },
    portfolioPolicy: policy,
    cashAssumptions,
    origin: 'snapshot',
  }, RACE_NOW_MS, storage[CSV_IMPORT_GENERATION_KEY] ?? null, {
    schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
  }).committedRaw
}

function prepareRaceGenerations(
  instance: TestInstance,
  ownRatio: number,
  ambientRatio: number,
): { ownRaw: string; ambientRaw: string } {
  const ownRaw = persistRaceGeneration(instance, { jpStockMaxRatio: ownRatio })
  const ambientRaw = persistRaceGeneration(instance, { jpStockMaxRatio: ambientRatio })
  storage[CSV_IMPORT_GENERATION_KEY] = ownRaw
  return { ownRaw, ambientRaw }
}

function candidateAction(state: AppStoreState, code = '1003'): string | undefined {
  return state.officialDecision?.actions.find(item =>
    item.candidateSource === 'candidate_funnel' && item.code === code)?.action
}

function installAmbientAbaRace(
  instance: TestInstance,
  ambientRaw: string,
  publishHook: 'manual' | 'load',
): void {
  let receiptRaw = ''
  instance.controls.setCandidateCompositionBeforeHook(() => {
    receiptRaw = storage[CSV_IMPORT_GENERATION_KEY]
    storage[CSV_IMPORT_GENERATION_KEY] = ambientRaw
  })
  const restoreReceipt = () => {
    storage[CSV_IMPORT_GENERATION_KEY] = receiptRaw
  }
  if (publishHook === 'manual') instance.controls.setManualPublishBeforeApplyHook(restoreReceipt)
  else instance.controls.setLoadPublishBeforeApplyHook(restoreReceipt)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(RACE_NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  Object.keys(storage).forEach(key => delete storage[key])
  throwCanonicalRead = false
  installRaceFetchRouter()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('P5-B005-C-D postcommit atomic integration', () => {
  it('C-C-T41 CSV composes once after durable commit and before publish', () => {
    const value = segment('importCsv: async', 'setTab: (tab)')
    expectOrder(value, ['persistCsvImportTransaction({', 'ownsCsvImportCanonicalBytes(persistenceReceipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'set({'])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T42 initialize composes committed generation once', () => {
    const value = segment('initialize: async', '// ── 全データ再取得')
    expectOrder(value, ['persistCurrentPortfolioGeneration(', "persistenceResult.target === 'canonical'", 'appendCommittedCandidatePortfolioRecommendations(', 'publishLoadFinalState('])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T43 refresh composes postpersist once', () => {
    const value = segment('refreshAllData: async', '// ── CSV取込')
    expectOrder(value, ['persistCurrentPortfolioGeneration(', "persistenceResult.target === 'canonical'", 'appendCommittedCandidatePortfolioRecommendations(', 'publishLoadFinalState('])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T44 manual mutation composes postpersist once', () => {
    const value = segment('const runManualPortfolioMutation', '/**\n   * RA-007-D2')
    expectOrder(value, ['persistCurrentPortfolioGeneration(', "persistenceResult.status !== 'persisted'", 'appendCommittedCandidatePortfolioRecommendations(', 'set(finalState)'])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T45 snapshot incoming commit composes once', () => {
    const value = segment('importPortfolioSnapshot: async')
    expectOrder(value, ['persistCsvImportTransaction(payload', 'ownsCsvImportCanonicalBytes(receipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'set(s => ({'])
    expect(value.match(/appendCommittedCandidatePortfolioRecommendations\(/g)).toHaveLength(1)
  })
  it('C-C-T46 persistence failure cannot append', () => {
    for (const value of [
      segment('initialize: async', '// ── 全データ再取得'),
      segment('refreshAllData: async', '// ── CSV取込'),
      segment('const runManualPortfolioMutation', '/**\n   * RA-007-D2'),
    ]) {
      expectOrder(value, ["persistenceResult.status !== 'persisted'", 'appendCommittedCandidatePortfolioRecommendations('])
    }
  })
  it('C-C-T47 ownership loss or rollback cannot publish stale append', () => {
    const csv = segment('importCsv: async', 'setTab: (tab)')
    const snapshot = segment('importPortfolioSnapshot: async')
    expectOrder(csv, ['ownsCsvImportCanonicalBytes(persistenceReceipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'ownsCsvImportCanonicalBytes(persistenceReceipt)', 'set({'])
    expectOrder(snapshot, ['ownsCsvImportCanonicalBytes(receipt)', 'appendCommittedCandidatePortfolioRecommendations(', 'ownsCsvImportCanonicalBytes(receipt)', 'set(s => ({'])
  })
  it('C-C-T48 cross-tab stale and canonical invalid have no fallback', () => {
    const authority = segment('function restoreExactCommittedCanonicalAuthority', '/**\n * Durable C-D connection')
    const helper = segment('function appendCommittedCandidatePortfolioRecommendations', 'function reportSubscriberException')
    expect(authority).toContain('const raw = receipt.committedRaw')
    expect(authority).toContain('restoreCsvImportGenerationFromRaw(raw)')
    expect(authority).not.toMatch(/readCsvImportCanonicalRaw|restoreCsvImportGeneration\(\)|localStorage|Date\.now/)
    expect(helper).toContain('const canonicalGeneration = authority.generation')
    expect(helper).not.toContain('stockCandidates')
    expect(helper).not.toContain('holdings:')
    expect(helper).not.toContain('readCsvImportCanonicalRaw')
  })
  it('C-C-T49 recommendation failure preserves base decision', () => {
    const helper = segment('function appendCommittedCandidatePortfolioRecommendations', 'function reportSubscriberException')
    expect(helper).toMatch(/catch \{\s+return computed\s+\}/)
    expect(helper).toContain('officialDecision === computed.officialDecision')
  })
  it('C-C-T50 adds no extra publish, emission, storage, or precommit candidate item', () => {
    const helper = segment('function appendCommittedCandidatePortfolioRecommendations', 'function reportSubscriberException')
    expect(helper).not.toMatch(/\bset\(|setState|localStorage|sessionStorage|indexedDB|emitPortfolio/)
    const computed = runFullAnalysis(useAppStore.getState(), { nowMs: Date.now() })
    expect(computed.officialDecision?.actions.some(item => item.candidateSource === 'candidate_funnel')).toBe(false)
  })
})

describe('P5-B005-C-D-R1 receipt-derived exact generation behavior', () => {
  it.each([
    { ownRatio: 0.05, ambientRatio: 0.30, expected: 'WATCH' },
    { ownRatio: 0.30, ambientRatio: 0.05, expected: 'BUY_NEW' },
  ])('initialize keeps receipt generation $ownRatio when ambient becomes $ambientRatio', async ({
    ownRatio,
    ambientRatio,
    expected,
  }) => {
    const instance = createRaceInstance()
    const { ambientRaw } = prepareRaceGenerations(instance, ownRatio, ambientRatio)
    installAmbientAbaRace(instance, ambientRaw, 'load')
    let notifications = 0
    instance.store.subscribe(() => { notifications += 1 })

    const result = await instance.store.getState().initialize()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(instance.store.getState().portfolioPolicy.jpStockMaxRatio).toBe(ownRatio)
    expect(candidateAction(instance.store.getState())).toBe(expected)
    expect(notifications).toBe(1)
  })

  it('refreshAllData keeps its receipt generation while ambient bytes carry the opposite policy', async () => {
    const instance = createRaceInstance()
    const { ambientRaw } = prepareRaceGenerations(instance, 0.05, 0.30)
    expect(await instance.store.getState().initialize()).toMatchObject({ ok: true })
    installAmbientAbaRace(instance, ambientRaw, 'load')
    let notifications = 0
    instance.store.subscribe(() => { notifications += 1 })

    const result = await instance.store.getState().refreshAllData()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(instance.store.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.05)
    expect(candidateAction(instance.store.getState())).toBe('WATCH')
    expect(notifications).toBe(1)
  })

  const manualCases: Array<{
    name: string
    initialRatio: number
    invoke: (state: AppStoreState) => Promise<unknown>
    assertDraft: (state: AppStoreState) => void
  }> = [
    {
      name: 'updateHolding',
      initialRatio: 0.05,
      invoke: state => state.updateHolding('1001', { eval: 110_000 }),
      assertDraft: state => expect(state.holdings.find(item => item.code === '1001')?.eval).toBe(110_000),
    },
    {
      name: 'updateTrust',
      initialRatio: 0.05,
      invoke: state => state.updateTrust(INITIAL_TRUST[0].id, { eval: 210_000 }),
      assertDraft: state => expect(state.trust.find(item => item.id === INITIAL_TRUST[0].id)?.eval).toBe(210_000),
    },
    {
      name: 'setPortfolioPolicy',
      initialRatio: 0.30,
      invoke: state => state.setPortfolioPolicy({ jpStockMaxRatio: 0.05 }),
      assertDraft: state => expect(state.portfolioPolicy.jpStockMaxRatio).toBe(0.05),
    },
    {
      name: 'setCashAssumptions',
      initialRatio: 0.05,
      invoke: state => state.setCashAssumptions({ cashDeposits: 900_000, standbyFunds: 0 }),
      assertDraft: state => expect(state.cashAssumptions.cashDeposits).toBe(900_000),
    },
    {
      name: 'clearCashAssumptionsOverride',
      initialRatio: 0.05,
      invoke: state => state.clearCashAssumptionsOverride(),
      assertDraft: state => expect(state.cashAssumptions.manualOverrideEnabled).toBe(false),
    },
    {
      name: 'importCashAssumptions',
      initialRatio: 0.05,
      invoke: state => state.importCashAssumptions({
        cashDeposits: 800_000,
        standbyFunds: 0,
        manualUpdatedAt: RACE_NOW,
      }),
      assertDraft: state => expect(state.cashAssumptions.cashDeposits).toBe(800_000),
    },
  ]

  it.each(manualCases)('$name composes from its own receipt, not ambient 30% bytes', async ({
    initialRatio,
    invoke,
    assertDraft,
  }) => {
    const instance = createRaceInstance()
    const { ambientRaw } = prepareRaceGenerations(instance, initialRatio, 0.30)
    expect(await instance.store.getState().initialize()).toMatchObject({ ok: true })
    installAmbientAbaRace(instance, ambientRaw, 'manual')
    let notifications = 0
    instance.store.subscribe(() => { notifications += 1 })

    const result = await invoke(instance.store.getState())

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    assertDraft(instance.store.getState())
    expect(instance.store.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.05)
    expect(candidateAction(instance.store.getState())).toBe('WATCH')
    expect(notifications).toBe(1)
  })

  it('manual reverse race keeps receipt 30% BUY_NEW instead of ambient 5% WATCH', async () => {
    const instance = createRaceInstance()
    const { ambientRaw } = prepareRaceGenerations(instance, 0.30, 0.05)
    expect(await instance.store.getState().initialize()).toMatchObject({ ok: true })
    installAmbientAbaRace(instance, ambientRaw, 'manual')

    const result = await instance.store.getState().updateHolding('1001', { eval: 101_000 })

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(instance.store.getState().portfolioPolicy.jpStockMaxRatio).toBe(0.30)
    expect(candidateAction(instance.store.getState())).toBe('BUY_NEW')
  })
})

describe('P5-B005-C-D-R1 publish-preownership fail-closed behavior', () => {
  it.each(['initialize', 'refreshAllData'] as const)(
    '%s loses ownership after composition and performs no final publication',
    async operation => {
      const instance = createRaceInstance()
      const { ambientRaw } = prepareRaceGenerations(instance, 0.05, 0.30)
      if (operation === 'refreshAllData') {
        expect(await instance.store.getState().initialize()).toMatchObject({ ok: true })
      }
      const before = instance.store.getState()
      instance.controls.setLoadPublishBeforeApplyHook(() => {
        storage[CSV_IMPORT_GENERATION_KEY] = ambientRaw
      })
      let notifications = 0
      instance.store.subscribe(() => { notifications += 1 })

      const result = await instance.store.getState()[operation]()

      expect(result).toMatchObject({
        ok: false,
        code: 'PORTFOLIO_GENERATION_CONFLICT',
        retryable: false,
      })
      expect(instance.store.getState()).toBe(before)
      expect(notifications).toBe(0)
    },
  )

  it.each([
    ['ownership replaced', false],
    ['ownership checker throws', true],
  ] as const)('manual %s after policy/adapter succeeds publishes nothing', async (_label, shouldThrow) => {
    const instance = createRaceInstance()
    const { ambientRaw } = prepareRaceGenerations(instance, 0.30, 0.05)
    expect(await instance.store.getState().initialize()).toMatchObject({ ok: true })
    const before = instance.store.getState()
    const priorDecision = before.officialDecision
    instance.controls.setManualPublishBeforeApplyHook(() => {
      if (shouldThrow) throwCanonicalRead = true
      else storage[CSV_IMPORT_GENERATION_KEY] = ambientRaw
    })
    let notifications = 0
    instance.store.subscribe(() => { notifications += 1 })

    const result = await instance.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.05 })

    expect(result).toMatchObject({
      ok: false,
      code: 'PORTFOLIO_GENERATION_CONFLICT',
      retryable: false,
    })
    expect(instance.store.getState()).toBe(before)
    expect(instance.store.getState().officialDecision).toBe(priorDecision)
    expect(notifications).toBe(0)
  })
})

describe('P5-B005-C-D-R1 source authority and ordering', () => {
  it('all C-D call sites derive from receipts and forbid postcommit ambient generation authority', () => {
    const exact = segment('function restoreExactCommittedCanonicalAuthority', '/**\n * Durable C-D connection')
    expect(exact).toMatch(/receipt\.committedRaw[\s\S]*restoreCsvImportGenerationFromRaw\(raw\)/)
    expect(exact).not.toMatch(/readCsvImportCanonicalRaw|restoreCsvImportGeneration\(\)|localStorage|Date\.now/)
    for (const value of [
      segment('initialize: async', '// ── 全データ再取得'),
      segment('refreshAllData: async', '// ── CSV取込'),
      segment('const runManualPortfolioMutation', '/**\n   * RA-007-D2'),
    ]) {
      const afterPersist = value.slice(value.indexOf('persistCurrentPortfolioGeneration('))
      expect(afterPersist).not.toContain('readCsvImportCanonicalRaw()')
      expect(afterPersist).toContain('restoreExactCommittedCanonicalAuthority(')
    }
    expect(segment('const runManualPortfolioMutation', '/**\n   * RA-007-D2'))
      .toMatch(/appendCommittedCandidatePortfolioRecommendations\(\s+candidateState,\s+computed,\s+authority,/)
    expect(segment('initialize: async', '// ── 全データ再取得'))
      .toMatch(/appendCommittedCandidatePortfolioRecommendations\(\s+stagedState,\s+computed,\s+authority,/)
    expect(segment('refreshAllData: async', '// ── CSV取込'))
      .toMatch(/appendCommittedCandidatePortfolioRecommendations\(\s+stagedState,\s+computed,\s+authority,/)
  })

  it('ownership is checked after adapter completion and immediately before each final publish', () => {
    const manual = segment('const runManualPortfolioMutation', '/**\n   * RA-007-D2')
    const loadPublish = segment('const publishLoadFinalState', 'return ({')
    const csv = segment('importCsv: async', 'setTab: (tab)')
    const snapshot = segment('importPortfolioSnapshot: async')
    expectOrder(manual, [
      'appendCommittedCandidatePortfolioRecommendations(',
      'manualPublishBeforeApplyHook',
      'ownsCsvImportCanonicalBytes(committedReceipt)',
      'set(finalState)',
    ])
    expectOrder(loadPublish, [
      'runLoadPublishBeforeApplyHookForTest(runtime)',
      'ownsCsvImportCanonicalBytes(committedReceipt)',
      'set(stateToPublish)',
    ])
    expectOrder(csv, [
      'appendCommittedCandidatePortfolioRecommendations(',
      'ownsCsvImportCanonicalBytes(persistenceReceipt)',
      'set({',
    ])
    expectOrder(snapshot, [
      'appendCommittedCandidatePortfolioRecommendations(',
      'ownsCsvImportCanonicalBytes(receipt)',
      'set(s => ({',
    ])
  })
})
