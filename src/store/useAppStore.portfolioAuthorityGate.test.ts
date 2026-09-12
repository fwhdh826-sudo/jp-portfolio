import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommitteeDecision } from '../domain/analysis/committeeDecision'
import type { Holding, PortfolioImportAuthorityV1, Trust } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS, DEFAULT_PORTFOLIO_POLICY } from '../types'
import {
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  CSV_IMPORT_GENERATION_SCHEMA_V6,
  persistCsvImportTransaction,
  restoreCsvImportGeneration,
} from './persist'
import { committeeToOfficialDecision, createAppStoreInstanceForTest } from './useAppStore'
import { selectHasCompletePortfolioAuthority } from './selectors'
import type { PortfolioGenerationLockAdapter } from './portfolioGenerationLock'

function immediateAdapter(): PortfolioGenerationLockAdapter {
  return {
    async runExclusive(_operation, callback) {
      return { ok: true, value: await callback() }
    },
  }
}

function freshInstance() {
  return createAppStoreInstanceForTest({ portfolioGenerationLock: immediateAdapter() })
}

// OPS-SBI-P2-PREBUILD-PHASE2-STORE-AUTHORITY: authority gate + v1-v5 migration/reload tests
// (ticket sections 25/27/28).

const NOW_MS = Date.parse('2026-09-12T03:00:00.000Z')

const storage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
  Object.keys(storage).forEach(key => delete storage[key])
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const HOLDING: Holding = {
  code: '1001', name: '銘柄1001', eval: 100_000, pnlPct: 1, mu: 0.08, sigma: 0.2,
  sigmaSource: 'static', beta: 1, sector: 'テスト', target: 0, alert: 0,
  lock: false, mitsu: false, ma: true, rsi: 50, macd: true, vol: false, mom3m: 0,
  roe: 10, per: 15, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 1,
  score: 50, decision: 'HOLD', ev: 0,
}
const TRUST_FIXTURE: Trust = {
  id: 'fund-1', name: 'テスト投信', abbr: 'テスト', account: '特定',
  policy: 'OVERSEAS_LONGTERM', eval: 200_000, pnlPct: 2, dayPct: 0, cost: 0.2,
  mu: 0.08, sigma: 0.15, score: 50, signal: 'HOLD', ev: 0, decision: 'HOLD',
}

// OPS-SBI-P2-PREBUILD-PHASE2-R2-A (P1-03): a semantically valid COMPLETE requires exactly one
// sectionCompleteness entry per required section (see
// isSemanticallyCompletePortfolioImportAuthority) — an empty array is a semantically
// contradictory COMPLETE (missing all four required sections) and must never satisfy
// selectHasCompletePortfolioAuthority, which is exactly what this fixture's own tests below verify.
const COMPLETE_AUTHORITY: PortfolioImportAuthorityV1 = {
  authorityVersion: 'portfolio-import-authority-1',
  importMode: 'FULL_EXPORT',
  contractVersion: 'sbi-portfolio-import-2',
  profileId: 'sbi-portfolio-v1',
  authorityStatus: 'COMPLETE',
  selectedAssetClasses: null,
  preservedAssetClasses: null,
  provenanceScope: 'FULL_EXPORT',
  sectionCompleteness: [
    { sectionId: 'JP_STOCK_CUSTODY', status: 'VALID_NONEMPTY' },
    { sectionId: 'TRUST_TAXABLE', status: 'VALID_NONEMPTY' },
    { sectionId: 'TRUST_NISA_GROWTH', status: 'VALID_EMPTY' },
    { sectionId: 'TRUST_NISA_ACCUMULATION', status: 'VALID_EMPTY' },
  ],
}

function seedV6Complete(): void {
  persistCsvImportTransaction({
    holdings: [HOLDING],
    trust: [TRUST_FIXTURE],
    learning: null,
    csvImportedAt: null,
    provenance: null,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-09-12', total: 0, evalById: {} },
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    origin: null,
    snapshotGenerationIdentity: null,
    snapshotTransferIdentity: null,
    importAuthority: COMPLETE_AUTHORITY,
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V6 })
}

function seedV5Legacy(): void {
  persistCsvImportTransaction({
    holdings: [HOLDING],
    trust: [TRUST_FIXTURE],
    learning: null,
    csvImportedAt: null,
    provenance: null,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-09-12', total: 0, evalById: {} },
    portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
    cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
    origin: null,
    snapshotGenerationIdentity: null,
    snapshotTransferIdentity: null,
  }, NOW_MS, null, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })
}

describe('canonical v1-v5 migration on reload (ticket section 25/10)', () => {
  it('test 2/3: a v5 generation loads as LEGACY_UNPROVEN but holdings remain readable', async () => {
    seedV5Legacy()
    const created = freshInstance()
    await created.store.getState().initialize()
    const state = created.store.getState()
    expect(state.portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    expect(state.holdings.find(h => h.code === '1001')?.eval).toBe(100_000)
    expect(state.trust.find(t => t.id === 'fund-1')?.eval).toBe(200_000)
  })

  it('test 4: reload does not upgrade LEGACY_UNPROVEN to COMPLETE', async () => {
    seedV5Legacy()
    const first = freshInstance()
    await first.store.getState().initialize()
    expect(first.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')

    const second = freshInstance()
    await second.store.getState().initialize()
    expect(second.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
  })

  it('test 5: a v6 COMPLETE generation reloads and remains COMPLETE', async () => {
    seedV6Complete()
    const created = freshInstance()
    await created.store.getState().initialize()
    expect(created.store.getState().portfolioImportAuthority).toEqual(COMPLETE_AUTHORITY)

    const reloaded = freshInstance()
    await reloaded.store.getState().initialize()
    expect(reloaded.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
  })

  it('regression: initialize() never downgrades a v6 canonical generation to v4 on its post-analysis re-persist', async () => {
    seedV6Complete()
    const created = freshInstance()
    await created.store.getState().initialize()
    const generation = restoreCsvImportGeneration()
    expect(generation.status).toBe('committed')
    if (generation.status === 'committed') {
      expect(generation.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V6)
      expect(generation.payload.importAuthority).toEqual(COMPLETE_AUTHORITY)
    }
  })

  it('a fresh store with no committed generation defaults to LEGACY_UNPROVEN (fail-closed, never silently COMPLETE)', async () => {
    const created = freshInstance()
    await created.store.getState().initialize()
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
  })

  it('selectHasCompletePortfolioAuthority reflects the restored authorityStatus', async () => {
    seedV6Complete()
    const created = freshInstance()
    await created.store.getState().initialize()
    expect(selectHasCompletePortfolioAuthority(created.store.getState())).toBe(true)
  })
})

describe('officialDecision authority gate (Policy B, ticket section 16/27)', () => {
  function committeeFixture(): CommitteeDecision {
    return {
      generatedAt: '2026-09-12T00:00:00.000Z',
      verdict: { label: 'テスト', tone: 'positive', noTrade: false, summary: '' },
      stance: 'risk_on',
      rationale: [],
      focusPoints: [],
      risks: [],
      actions: [
        { id: 'stock-BUY_1001', title: 'BUY 銘柄1001', detail: '', reason: 'テスト', priority: 'high', domain: 'stock', holdingStatus: '共通' },
        { id: 'stock-SELL_1002', title: 'SELL 銘柄1002', detail: '', reason: 'テスト', priority: 'high', domain: 'stock', holdingStatus: '保有' },
        { id: 'stock-WAIT_1003', title: 'WAIT 銘柄1003', detail: '', reason: 'テスト', priority: 'low', domain: 'stock', holdingStatus: '非保有' },
      ],
    }
  }

  it('COMPLETE authority: BUY/SELL pass through unchanged', () => {
    const decision = committeeToOfficialDecision(committeeFixture(), false, false, [], false)
    expect(decision.actions.find(a => a.id === 'stock-BUY_1001')?.action).toBe('BUY')
    expect(decision.actions.find(a => a.id === 'stock-SELL_1002')?.action).toBe('SELL')
    expect(decision.noTrade).toBe(false)
  })

  it('LEGACY_UNPROVEN/PARTIAL (portfolioAuthorityBlocked=true): BUY/SELL become BLOCKED, HOLD/WAIT unaffected, noTrade forced', () => {
    const decision = committeeToOfficialDecision(committeeFixture(), false, false, [], true)
    expect(decision.actions.find(a => a.id === 'stock-BUY_1001')?.action).toBe('BLOCKED')
    expect(decision.actions.find(a => a.id === 'stock-SELL_1002')?.action).toBe('BLOCKED')
    expect(decision.actions.find(a => a.id === 'stock-WAIT_1003')?.action).toBe('HOLD')
    expect(decision.noTrade).toBe(true)
    expect(decision.actions.find(a => a.id === 'stock-BUY_1001')?.blockedReason).toMatch(/COMPLETE/)
  })

  it('portfolioAuthorityBlocked defaults to false (every pre-existing caller keeps current behavior)', () => {
    const decision = committeeToOfficialDecision(committeeFixture(), false, false, [])
    expect(decision.actions.find(a => a.id === 'stock-BUY_1001')?.action).toBe('BUY')
  })

  it('risk-notrade and DQ-suppressed actions are unaffected by the portfolio authority gate (their own gates take precedence)', () => {
    const fixtureWithRisk: CommitteeDecision = {
      ...committeeFixture(),
      actions: [
        { id: 'risk-notrade', title: 'ノートレード判定', detail: 'risk detail', reason: 'risk', priority: 'high', domain: 'risk', holdingStatus: '共通' },
      ],
    }
    const decision = committeeToOfficialDecision(fixtureWithRisk, false, false, [], true)
    expect(decision.actions[0].action).toBe('BLOCKED')
    expect(decision.actions[0].blockedReason).toBe('risk detail') // not overwritten by the authority-gate reason
  })
})

describe('cross-tab authority protection (ticket section 20/28)', () => {
  it('a stale tab publishing COMPLETE v6 refuses to proceed once an external writer commits a different generation', async () => {
    seedV6Complete()
    const tabA = freshInstance()
    await tabA.store.getState().initialize()
    expect(tabA.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')

    // An external writer (another tab / the legacy importCsv path) commits a v5 generation with
    // different content directly to storage, without tabA's published state knowing about it.
    persistCsvImportTransaction({
      holdings: [{ ...HOLDING, code: '9999', eval: 999 }],
      trust: [TRUST_FIXTURE],
      learning: null,
      csvImportedAt: null,
      provenance: null,
      syncSummary: null,
      trustShortSnapshot: { date: '2026-09-12', total: 0, evalById: {} },
      portfolioPolicy: { ...DEFAULT_PORTFOLIO_POLICY },
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      origin: null,
      snapshotGenerationIdentity: null,
      snapshotTransferIdentity: null,
    }, NOW_MS + 1000, undefined, { schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5 })

    const result = await tabA.store.getState().importSbiPortfolioFullExport(
      new File(['dummy'], 'x.csv'),
    )
    expect(result).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE' })
    // tabA's own published authority/holdings are untouched by the refused attempt.
    expect(tabA.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
  })
})
