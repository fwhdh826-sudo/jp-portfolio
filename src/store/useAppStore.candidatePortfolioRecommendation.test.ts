// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CandidateFunnelArtifact,
  CashAssumptions,
  CsvImportProvenance,
  Holding,
  PortfolioPolicy,
} from '../types'
import {
  DEFAULT_CASH_ASSUMPTIONS,
  DEFAULT_PORTFOLIO_POLICY,
} from '../types'
import { INITIAL_TRUST } from '../constants/trust'
import { STATIC_MARKET } from '../constants/market'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  persistCsvImportTransaction,
  restoreCsvImportGenerationFromRaw,
} from './persist'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import {
  createAppStoreInstanceForTest,
  runFullAnalysis,
  useAppStore,
  type AppStoreState,
} from './useAppStore'

const selectorProbe = vi.hoisted(() => ({
  calls: [] as Array<{
    evaluatedAt: string
    officialDecisionGeneratedAt: string | null
  }>,
  onCall: null as null | ((evaluatedAt: string, officialDecisionGeneratedAt: string | null) => void),
}))

vi.mock('./portfolioFitSelectors', async importOriginal => {
  const actual = await importOriginal<typeof import('./portfolioFitSelectors')>()
  return {
    ...actual,
    selectCandidatePortfolioFit: (
      ...args: Parameters<typeof actual.selectCandidatePortfolioFit>
    ): ReturnType<typeof actual.selectCandidatePortfolioFit> => {
      const evaluatedAt = args[2]
      const officialDecisionGeneratedAt = args[0].officialDecision?.generatedAt ?? null
      selectorProbe.calls.push({ evaluatedAt, officialDecisionGeneratedAt })
      selectorProbe.onCall?.(evaluatedAt, officialDecisionGeneratedAt)
      return actual.selectCandidatePortfolioFit(...args)
    },
  }
})

const source = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8')
const parseJson = JSON.parse.bind(JSON) as typeof JSON.parse

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
const RACE_ACTION_MS = RACE_NOW_MS + 60 * 60 * 1000
const RACE_ACTION_SOURCE = new Date(RACE_NOW_MS + 30 * 60 * 1000).toISOString()
const storage: Record<string, string> = {}
let throwCanonicalRead = false
let authorityRace: {
  ambientRaw: string
  receiptRaw: string
} | null = null

const localStorageMock = {
  getItem(key: string): string | null {
    if (throwCanonicalRead && key === CSV_IMPORT_GENERATION_KEY) {
      throw new Error('injected ownership read failure')
    }
    if (authorityRace !== null && key === CSV_IMPORT_GENERATION_KEY) {
      const stack = new Error('canonical authority probe').stack ?? ''
      if (
        stack.includes('readCsvImportCanonicalRaw') ||
        stack.includes('restoreCsvImportGeneration (')
      ) {
        const ambientRaw = authorityRace.ambientRaw
        storage[key] = authorityRace.receiptRaw
        authorityRace = null
        return ambientRaw
      }
      if (stack.includes('ownsCsvImportCanonicalBytes')) {
        const receiptRaw = authorityRace.receiptRaw
        storage[key] = receiptRaw
        authorityRace = null
        return receiptRaw
      }
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

class TestFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File): void {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

const RACE_CSV = [
  `データ基準日時,${RACE_ACTION_SOURCE}`,
  '株式（現物/特定預り）',
  '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日',
  '1001,C-D-FU1 CSV銘柄,1200,150000,8.00,0.50,2025-01-01',
  '投資信託（金額/特定預り）',
  'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日',
  `${INITIAL_TRUST[0].name},10000,200000,5.00,0.10,`,
].join('\n')

function raceCsvFile(): File {
  return new File([RACE_CSV], 'c-d-fu1.csv', {
    type: 'text/csv',
    lastModified: Date.parse(RACE_ACTION_SOURCE),
  })
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
  source: 'MANUAL',
  grossCash: 1_000_000,
  safetyReserve: 0,
  pendingOrderCash: null,
  updatedAt: RACE_NOW,
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

// CAND-SYN-1C: officialDecision の候補 action は canonical
// CandidateDecisionSynthesis 由来になったため、AllocationPlan が blocked な
// fixture では必ず BLOCKED になる（そちらが canonical に正しい答え）。
// 「receipt 自身の世代が採用されたか」という P5-B005-C-D-R1 の識別は、1D まで
// 残す legacy compatibility 構造 candidatePortfolioRecommendations 側で固定する。
function recommendationAction(state: AppStoreState, code = '1003'): string | undefined {
  return state.candidatePortfolioRecommendations.find(item => item.code === code)?.action
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

function installActionAmbientAbaRace(
  instance: TestInstance,
  ambientRaw: string,
): void {
  instance.controls.setCandidateCompositionBeforeHook(() => {
    const receiptRaw = storage[CSV_IMPORT_GENERATION_KEY]
    storage[CSV_IMPORT_GENERATION_KEY] = ambientRaw
    authorityRace = { ambientRaw, receiptRaw }
  })
}

function installActionOwnershipLoss(
  instance: TestInstance,
  ambientRaw: string,
  shouldThrow: boolean,
): void {
  instance.controls.setCandidateCompositionBeforeHook(() => {
    if (shouldThrow) throwCanonicalRead = true
    else storage[CSV_IMPORT_GENERATION_KEY] = ambientRaw
  })
}

async function prepareActionTarget(
  ownRatio: number,
  ambientRatio: number,
): Promise<{
  instance: TestInstance
  ambientRaw: string
}> {
  const instance = createRaceInstance()
  const { ambientRaw } = prepareRaceGenerations(instance, ownRatio, ambientRatio)
  expect(await instance.store.getState().initialize()).toMatchObject({
    ok: true,
    code: 'SUCCESS',
  })
  vi.setSystemTime(RACE_ACTION_MS)
  selectorProbe.calls.length = 0
  selectorProbe.onCall = null
  return { instance, ambientRaw }
}

async function prepareSnapshotActionTarget(
  ambientRatio: number,
): Promise<{
  instance: TestInstance
  ambientRaw: string
}> {
  const instance = createRaceInstance()
  const ambientRaw = persistRaceGeneration(instance, {
    jpStockMaxRatio: ambientRatio,
  })
  expect(await instance.store.getState().initialize()).toMatchObject({
    ok: true,
    code: 'SUCCESS',
  })
  delete storage[CSV_IMPORT_GENERATION_KEY]
  instance.store.setState(state => ({
    ...state,
    holdings: [],
    trust: [],
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    candidateFunnel: raceArtifact(),
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
  vi.setSystemTime(RACE_ACTION_MS)
  selectorProbe.calls.length = 0
  selectorProbe.onCall = null
  return { instance, ambientRaw }
}

function raceSnapshotRaw(
  target: TestInstance,
  ownRatio: number,
  tag: string,
): string {
  const sourceInstance = createRaceInstance()
  const targetState = target.store.getState()
  const importedAt = new Date(RACE_NOW_MS + 40 * 60 * 1000).toISOString()
  const provenance: CsvImportProvenance = {
    ...RACE_PROVENANCE,
    importedAt,
    sourceAsOf: RACE_ACTION_SOURCE,
    semanticIdentity: `sha256:${tag.repeat(64)}`,
    contentFingerprint: `fnv1a32:${tag.repeat(8)}`,
    sourceFileName: `c-d-fu1-${tag}.csv`,
    fileLastModified: RACE_ACTION_SOURCE,
  }
  sourceInstance.store.setState(state => ({
    ...state,
    holdings: [{ ...RACE_HOLDING, eval: 125_000 }],
    trust: targetState.trust.map(item => ({ ...item })),
    portfolioPolicy: { jpStockMaxRatio: ownRatio },
    cashAssumptions: { ...RACE_CASH },
    system: {
      ...state.system,
      csvLastImportedAt: importedAt,
      csvImportProvenance: provenance,
      csvSyncSummary: null,
    },
  }))
  return sourceInstance.store.getState().exportPortfolioSnapshot()
}

function subscribeGenerationPublications(instance: TestInstance): {
  count: () => number
  unsubscribe: () => void
} {
  let publications = 0
  const unsubscribe = instance.store.subscribe((next, previous) => {
    if (
      next.holdings !== previous.holdings ||
      next.trust !== previous.trust ||
      next.portfolioPolicy !== previous.portfolioPolicy ||
      next.cashAssumptions !== previous.cashAssumptions ||
      next.officialDecision !== previous.officialDecision
    ) publications += 1
  })
  return { count: () => publications, unsubscribe }
}

function parsedFunction(name: string): {
  file: ts.SourceFile
  declaration: ts.FunctionDeclaration
} {
  const file = ts.createSourceFile(
    'useAppStore.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let declaration: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) declaration = node
    if (declaration === undefined) ts.forEachChild(node, visit)
  }
  visit(file)
  expect(declaration, name).toBeDefined()
  return { file, declaration: declaration! }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(RACE_NOW_MS)
  vi.stubGlobal('FileReader', TestFileReader)
  vi.stubGlobal('localStorage', localStorageMock)
  Object.keys(storage).forEach(key => delete storage[key])
  throwCanonicalRead = false
  authorityRace = null
  selectorProbe.calls.length = 0
  selectorProbe.onCall = null
  installRaceFetchRouter()
})

afterEach(() => {
  selectorProbe.onCall = null
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
    // CAND-SYN-1C / N1+N3: the funnel append is retired; the single candidate
    // writer is the synthesis compatibility projection.
    expect(helper).toContain('const officialDecision = projectSynthesisToOfficialDecision(')
    expect(helper).not.toContain('appendCandidatePortfolioRecommendations(')
    expect(helper).toContain('candidatePortfolioRecommendations: projectedRecommendations')
    expect(helper).not.toMatch(/OfficialDecisionItem|suggestedAmount|maxAmount|amountText/)
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
    const state = instance.store.getState()
    expect(state.portfolioPolicy.jpStockMaxRatio).toBe(ownRatio)
    expect(candidateAction(state)).toBe('BLOCKED')
    expect(recommendationAction(state)).toBe(expected)
    const recommendation = state.candidatePortfolioRecommendations.find(item => item.code === '1003')
    expect(recommendation).toMatchObject({ action: expected, marketRank: 1 })
    expect(recommendation?.allocation).toMatchObject({
      snapshotId: state.allocationPlan?.snapshotId,
      sourceCandidateGenerationId: state.candidateFunnel?._meta.generatedAt,
      instrumentId: 'stock:1003',
      finalSuggestedAmount: 0,
      executable: false,
      blockedReasons: expect.arrayContaining(['JP_STOCK_EXECUTION_DATA_UNAVAILABLE']),
    })
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
    expect(candidateAction(instance.store.getState())).toBe('BLOCKED')
    expect(recommendationAction(instance.store.getState())).toBe('WATCH')
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
      invoke: state => state.setCashAssumptions({ grossCash: 900_000, safetyReserve: 0, pendingOrderCash: null }),
      assertDraft: state => expect(state.cashAssumptions.grossCash).toBe(900_000),
    },
    {
      name: 'clearCashAssumptionsOverride',
      initialRatio: 0.05,
      invoke: state => state.clearCashAssumptionsOverride(),
      assertDraft: state => expect(state.cashAssumptions.source).toBe('DEFAULT'),
    },
    {
      name: 'importCashAssumptions',
      initialRatio: 0.05,
      invoke: state => state.importCashAssumptions({
        grossCash: 800_000,
        safetyReserve: 0,
        pendingOrderCash: null,
        updatedAt: RACE_NOW,
      }),
      assertDraft: state => expect(state.cashAssumptions.grossCash).toBe(800_000),
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
    expect(candidateAction(instance.store.getState())).toBe('BLOCKED')
    expect(recommendationAction(instance.store.getState())).toBe('WATCH')
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
    expect(candidateAction(instance.store.getState())).toBe('BLOCKED')
    expect(recommendationAction(instance.store.getState())).toBe('BUY_NEW')
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

describe('P5-B005-C-D-FU1 P2-04 importCsv dynamic receipt authority', () => {
  it.each([
    { ownRatio: 0.05, ambientRatio: 0.30, expectedAction: 'WATCH' },
    { ownRatio: 0.30, ambientRatio: 0.05, expectedAction: 'BUY_NEW' },
  ])(
    'publishes own receipt $ownRatio instead of ambient $ambientRatio',
    async ({ ownRatio, ambientRatio, expectedAction }) => {
      const { instance, ambientRaw } = await prepareActionTarget(ownRatio, ambientRatio)
      installActionAmbientAbaRace(instance, ambientRaw)
      const publications = subscribeGenerationPublications(instance)

      const result = await instance.store.getState().importCsv(raceCsvFile())

      publications.unsubscribe()
      expect(result).toMatchObject({
        ok: true,
        code: 'SUCCESS',
        officialDecisionCommitted: true,
        persistence: { status: 'committed' },
      })
      const state = instance.store.getState()
      expect(state.portfolioPolicy.jpStockMaxRatio).toBe(ownRatio)
      expect(candidateAction(state)).toBe('BLOCKED')
      expect(recommendationAction(state)).toBe(expectedAction)
      expect(state.officialDecision?.actions.filter(item =>
        item.candidateSource === 'candidate_funnel' && item.code === '1003',
      )).toHaveLength(1)
      expect(publications.count()).toBe(1)
      expect(authorityRace).toBeNull()
      expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toBe(ambientRaw)
    },
  )

  it('fails closed when ambient replacement still owns canonical bytes before publish', async () => {
    const { instance, ambientRaw } = await prepareActionTarget(0.05, 0.30)
    const before = instance.store.getState()
    const priorDecision = before.officialDecision
    installActionOwnershipLoss(instance, ambientRaw, false)
    const publications = subscribeGenerationPublications(instance)

    const result = await instance.store.getState().importCsv(raceCsvFile())

    publications.unsubscribe()
    expect(result).toMatchObject({
      ok: false,
      code: 'IMPORT_CONFLICT',
      analysisCommitted: false,
      officialDecisionCommitted: false,
      persistence: { status: 'ownership_lost' },
    })
    const after = instance.store.getState()
    expect(after.holdings).toBe(before.holdings)
    expect(after.trust).toBe(before.trust)
    expect(after.portfolioPolicy).toBe(before.portfolioPolicy)
    expect(after.cashAssumptions).toBe(before.cashAssumptions)
    expect(after.officialDecision).toBe(priorDecision)
    expect(publications.count()).toBe(0)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(ambientRaw)
  })
})

describe('P5-B005-C-D-FU1 P2-05 snapshot dynamic receipt authority', () => {
  it.each([
    { ownRatio: 0.05, ambientRatio: 0.30, expectedAction: 'WATCH', tag: 'a' },
    { ownRatio: 0.30, ambientRatio: 0.05, expectedAction: 'BUY_NEW', tag: 'b' },
  ])(
    'publishes own receipt $ownRatio instead of ambient $ambientRatio and preserves duplicate provenance',
    async ({ ownRatio, ambientRatio, expectedAction, tag }) => {
      const { instance, ambientRaw } = await prepareSnapshotActionTarget(ambientRatio)
      const raw = raceSnapshotRaw(instance, ownRatio, tag)
      const incoming = parseJson(raw) as {
        csvImportProvenance: CsvImportProvenance
        snapshotGenerationIdentity: string
      }
      installActionAmbientAbaRace(instance, ambientRaw)
      const publications = subscribeGenerationPublications(instance)

      const result = await instance.store.getState().importPortfolioSnapshot(raw)

      expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
      const state = instance.store.getState()
      expect(state.portfolioPolicy.jpStockMaxRatio).toBe(ownRatio)
      expect(candidateAction(state)).toBe('BLOCKED')
      expect(recommendationAction(state)).toBe(expectedAction)
      expect(state.system.csvImportProvenance).toEqual(incoming.csvImportProvenance)
      expect(state.officialDecision?.actions.filter(item =>
        item.candidateSource === 'candidate_funnel' && item.code === '1003',
      )).toHaveLength(1)
      expect(publications.count()).toBe(1)
      expect(authorityRace).toBeNull()
      expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toBe(ambientRaw)

      const duplicate = await instance.store.getState().importPortfolioSnapshot(raw)
      publications.unsubscribe()
      expect(duplicate).toEqual({ ok: true, code: 'DUPLICATE_SNAPSHOT' })
      expect(publications.count()).toBe(1)
    },
  )

  it.each([
    ['ownership replaced', false, 'c'],
    ['ownership checker throws', true, 'd'],
  ] as const)(
    '%s after composition returns structured failure with no generation publication',
    async (_label, shouldThrow, tag) => {
      const { instance, ambientRaw } = await prepareSnapshotActionTarget(0.30)
      const raw = raceSnapshotRaw(instance, 0.05, tag)
      const before = instance.store.getState()
      const priorDecision = before.officialDecision
      installActionOwnershipLoss(instance, ambientRaw, shouldThrow)
      const publications = subscribeGenerationPublications(instance)

      const result = await instance.store.getState().importPortfolioSnapshot(raw)

      publications.unsubscribe()
      expect(result).toMatchObject({
        ok: false,
        code: 'SNAPSHOT_OWNERSHIP_LOST',
      })
      expect(result).not.toHaveProperty('cause')
      expect(result).not.toHaveProperty('stack')
      expect(instance.store.getState()).toBe(before)
      expect(instance.store.getState().officialDecision).toBe(priorDecision)
      expect(publications.count()).toBe(0)
      if (shouldThrow) {
        expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toBe(ambientRaw)
      } else {
        expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(ambientRaw)
      }
    },
  )
})

describe('P5-B005-C-D-FU1 P2-06 invalid receipt generation fail-close', () => {
  const invalidCases: Array<{
    name: string
    tag: string
    invalidRaw: (validRaw: string) => string
  }> = [
    {
      name: 'malformed committedRaw',
      tag: '1',
      invalidRaw: () => '{',
    },
    {
      name: 'valid JSON with an invalid manifest',
      tag: '2',
      invalidRaw: () => JSON.stringify({ manifest: {}, payload: {} }),
    },
    {
      name: 'checksum mismatch',
      tag: '3',
      invalidRaw: validRaw => {
        const value = parseJson(validRaw)
        value.payload.holdings[0].eval += 1
        return JSON.stringify(value)
      },
    },
    {
      name: 'unsupported schema',
      tag: '4',
      invalidRaw: validRaw => {
        const value = parseJson(validRaw)
        value.manifest.schemaVersion = 'csv-import-generation-999'
        return JSON.stringify(value)
      },
    },
    {
      name: 'generation status invalid',
      tag: '5',
      invalidRaw: validRaw => {
        const value = parseJson(validRaw)
        value.manifest.committed = false
        return JSON.stringify(value)
      },
    },
  ]

  it.each(invalidCases)(
    '$name does not compose, reread ambient authority, or publish',
    async ({ tag, invalidRaw }) => {
      const { instance } = await prepareSnapshotActionTarget(0.30)
      const raw = raceSnapshotRaw(instance, 0.05, tag)
      const before = instance.store.getState()
      const priorDecision = before.officialDecision
      let restoreParse = (): void => {}
      let invalidGenerationRaw = ''
      instance.controls.setCandidateCompositionBeforeHook(() => {
        const receiptRaw = storage[CSV_IMPORT_GENERATION_KEY]
        invalidGenerationRaw = invalidRaw(receiptRaw)
        const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(text => {
          if (text === receiptRaw) return parseJson(invalidGenerationRaw)
          return parseJson(text)
        })
        restoreParse = () => parseSpy.mockRestore()
      })
      const publications = subscribeGenerationPublications(instance)

      const result = await instance.store.getState().importPortfolioSnapshot(raw)
      restoreParse()

      publications.unsubscribe()
      expect(restoreCsvImportGenerationFromRaw(invalidGenerationRaw).status).not.toBe('committed')
      expect(result).toMatchObject({
        ok: false,
        code: 'SNAPSHOT_PERSISTENCE_ERROR',
      })
      expect(result).not.toHaveProperty('cause')
      expect(result).not.toHaveProperty('stack')
      expect(instance.store.getState()).toBe(before)
      expect(instance.store.getState().officialDecision).toBe(priorDecision)
      expect(publications.count()).toBe(0)
      expect(selectorProbe.calls).toHaveLength(0)
    },
  )

  it('restore exception is absorbed as an invalid generation and returns structured failure', async () => {
    const { instance } = await prepareSnapshotActionTarget(0.30)
    const raw = raceSnapshotRaw(instance, 0.05, '6')
    const before = instance.store.getState()
    let restoreParse = (): void => {}
    instance.controls.setCandidateCompositionBeforeHook(() => {
      const receiptRaw = storage[CSV_IMPORT_GENERATION_KEY]
      const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(text => {
        if (text === receiptRaw) throw new Error('injected receipt restore exception')
        return parseJson(text)
      })
      restoreParse = () => parseSpy.mockRestore()
    })
    const publications = subscribeGenerationPublications(instance)

    const result = await instance.store.getState().importPortfolioSnapshot(raw)
    restoreParse()

    publications.unsubscribe()
    expect(result).toMatchObject({
      ok: false,
      code: 'SNAPSHOT_PERSISTENCE_ERROR',
    })
    expect(JSON.stringify(result)).not.toContain('injected receipt restore exception')
    expect(instance.store.getState()).toBe(before)
    expect(publications.count()).toBe(0)
    expect(selectorProbe.calls).toHaveLength(0)
  })

  it('private helper accepts only receipt committedRaw with committed status and has no fallback', () => {
    const helper = segment(
      'function restoreExactCommittedCanonicalAuthority',
      '/**\n * Durable C-D connection',
    )
    expect(helper).toMatch(
      /const raw = receipt\.committedRaw[\s\S]*const generation = restoreCsvImportGenerationFromRaw\(raw\)[\s\S]*generation\.status === 'committed'/,
    )
    expect(helper).toMatch(
      /\? \{ ok: true, raw, generation \}\s*: \{ ok: false, reason: 'invalid_committed_raw' \}/,
    )
    expect(helper).not.toMatch(
      /readCsvImportCanonicalRaw|restoreCsvImportGeneration\(\)|localStorage|prior|fallback/,
    )
  })
})

describe('P5-B005-C-D-FU1 P2-06 official decision clock authority', () => {
  it('passes OfficialDecision.generatedAt exactly and performs no second current-time read', async () => {
    const { instance } = await prepareSnapshotActionTarget(0.05)
    const raw = raceSnapshotRaw(instance, 0.30, '7')
    const fixedNow = Date.now()
    let clockArmed = false
    let dateNowCallsAtSelector: number | null = null
    let dateNowCalls = 0
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (clockArmed) dateNowCalls += 1
      return fixedNow
    })
    instance.controls.setCandidateCompositionBeforeHook(() => {
      clockArmed = true
    })
    selectorProbe.onCall = () => {
      dateNowCallsAtSelector = dateNowCalls
      clockArmed = false
    }

    const result = await instance.store.getState().importPortfolioSnapshot(raw)
    dateNowSpy.mockRestore()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(selectorProbe.calls).toHaveLength(1)
    expect(dateNowCallsAtSelector).toBe(0)
    expect(selectorProbe.calls[0].evaluatedAt).toBe(
      selectorProbe.calls[0].officialDecisionGeneratedAt,
    )
    expect(selectorProbe.calls[0].evaluatedAt).toBe(
      instance.store.getState().officialDecision?.generatedAt,
    )
  })

  it('AST contract rejects second clocks and alternate generated/saved timestamps without comment false positives', () => {
    const { file, declaration } = parsedFunction(
      'appendCommittedCandidatePortfolioRecommendations',
    )
    const secondClocks: string[] = []
    let selectorCall: ts.CallExpression | undefined
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Date' &&
        node.expression.name.text === 'now'
      ) secondClocks.push(node.getText(file))
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Date' &&
        (node.arguments?.length ?? 0) === 0
      ) secondClocks.push(node.getText(file))
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'selectCandidatePortfolioFit'
      ) selectorCall = node
      ts.forEachChild(node, visit)
    }
    visit(declaration)

    expect(secondClocks).toEqual([])
    expect(selectorCall).toBeDefined()
    expect(selectorCall?.arguments[2].getText(file)).toBe(
      'computed.officialDecision.generatedAt',
    )
    expect(selectorCall?.arguments[2].getText(file)).not.toMatch(
      /candidateFunnel|canonicalGeneration|savedAt/,
    )
  })
})
