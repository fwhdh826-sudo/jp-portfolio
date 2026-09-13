// OPS-SBI-P2-PREBUILD-PHASE2-R1-AUTHORITY-INTEGRITY-REPAIR (P2-01): end-to-end store-level
// proof that a manual portfolio-snapshot transfer (exportPortfolioSnapshot →
// importPortfolioSnapshot, PC/スマホ間の手動コピー相当) preserves PortfolioImportAuthorityV1
// across two independent store instances (simulating two devices/tabs).
// Synthetic fixtures only — no real SBI export data (Phase 1/2 privacy discipline).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding } from '../types'
import { CSV_IMPORT_GENERATION_KEY, restoreCsvImportGeneration } from './persist'
import type { PortfolioGenerationLockAdapter } from './portfolioGenerationLock'
import { createAppStoreInstanceForTest } from './useAppStore'
import { computeSnapshotGenerationIdentityV2 } from '../utils/snapshotGenerationIdentity'

const MANUAL_HOLDING: Holding = {
  code: '9999', name: '手動保有', eval: 300_000, pnlPct: 1, mu: 0.08, sigma: 0.2,
  sigmaSource: 'static', beta: 1, sector: 'テスト', target: 0, alert: 0,
  lock: false, mitsu: false, ma: true, rsi: 50, macd: true, vol: false, mom3m: 0,
  roe: 10, per: 15, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 1,
  score: 50, decision: 'HOLD', ev: 0,
}

const NOW_MS = Date.parse('2026-09-12T03:00:00.000Z')

class TestFileReader {
  onload: ((event: { target: { result: ArrayBuffer } }) => void) | null = null
  onerror: (() => void) | null = null

  readAsArrayBuffer(file: File) {
    file.arrayBuffer()
      .then(result => this.onload?.({ target: { result } }))
      .catch(() => this.onerror?.())
  }
}

function immediateAdapter(): PortfolioGenerationLockAdapter {
  return {
    async runExclusive(_operation, callback) {
      return { ok: true, value: await callback() }
    },
  }
}

const STOCK_HEADER = '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日'
const TRUST_HEADER = 'ファンド名,基準価額,評価額,損益（％）,前日比（％）,取得日'
const STOCK_LABEL = '株式（現物/特定預り）'
const STOCK_TOTAL = '株式（現物/特定預り）合計'
const TRUST_TAXABLE_LABEL = '投資信託（金額/特定預り）'
const TRUST_TAXABLE_TOTAL = '投資信託（金額/特定預り）合計'
const TRUST_GROWTH_LABEL = '投資信託（金額/NISA預り（成長投資枠））'
const TRUST_GROWTH_TOTAL = '投資信託（金額/NISA預り（成長投資枠））合計'
const TRUST_TSUMITATE_LABEL = '投資信託（金額/NISA預り（つみたて投資枠））'
const TRUST_TSUMITATE_TOTAL = '投資信託（金額/NISA預り（つみたて投資枠））合計'

function emptyTrustSection(label: string, total: string): string[] {
  return [label, TRUST_HEADER, total]
}

function fullExportCsvLines(): string[] {
  return [
    // 明示的なデータ基準日時を含める — File.lastModifiedはjsdomの実時刻を使うため
    // （vi.setSystemTimeの影響を受けない）、これを含めない場合はfake clockより
    // 未来のweak sourceAsOfになり得る（このtestファイル固有の環境事情）。
    'データ基準日時,2026-09-11T00:00:00+09:00',
    STOCK_LABEL, STOCK_HEADER,
    '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    STOCK_TOTAL,
    TRUST_TAXABLE_LABEL, TRUST_HEADER,
    TRUST_TAXABLE_TOTAL,
    ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
    ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
  ]
}

function csvFile(lines: string[]): File {
  return new File([lines.join('\n')], 'portfolio.csv', { type: 'text/csv' })
}

// Two independent storage backends simulate two separate devices/tabs — a manual
// snapshot transfer never shares localStorage between them.
function makeStorage() {
  const store: Record<string, string> = {}
  return {
    store,
    mock: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
    },
  }
}

function instance(storageMock: ReturnType<typeof makeStorage>['mock']) {
  vi.stubGlobal('localStorage', storageMock)
  const created = createAppStoreInstanceForTest({ portfolioGenerationLock: immediateAdapter() })
  created.store.setState(state => ({
    system: { ...state.system, status: 'idle', error: null, dataSourceOutcome: { loaded: 14, total: 14 } },
  }))
  return created
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('FileReader', TestFileReader)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('P2-01: manual snapshot transfer preserves PortfolioImportAuthorityV1 end-to-end', () => {
  it('v6 COMPLETE round-trip: source proves COMPLETE via FULL_EXPORT, destination adopts COMPLETE from the transfer', async () => {
    const sourceStorage = makeStorage()
    const source = instance(sourceStorage.mock)
    const fullExportResult = await source.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(fullExportResult).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })
    expect(source.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')

    vi.stubGlobal('localStorage', sourceStorage.mock)
    const raw = source.store.getState().exportPortfolioSnapshot()
    const parsedRaw = JSON.parse(raw)
    expect(parsedRaw.schemaVersion).toBe('portfolio-snapshot-4')
    expect(parsedRaw.importAuthority.authorityStatus).toBe('COMPLETE')

    const destinationStorage = makeStorage()
    const destination = instance(destinationStorage.mock)
    const importResult = await destination.store.getState().importPortfolioSnapshot(raw)
    expect(importResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(destination.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
    expect(destination.store.getState().portfolioImportAuthority).toEqual(source.store.getState().portfolioImportAuthority)

    vi.stubGlobal('localStorage', destinationStorage.mock)
    const generation = restoreCsvImportGeneration()
    expect(generation.status).toBe('committed')
    if (generation.status === 'committed') {
      expect(generation.schemaVersion).toBe('csv-import-generation-6')
      expect(generation.payload.importAuthority?.authorityStatus).toBe('COMPLETE')
    }
  })

  // OPS-SBI-P2-PREBUILD-PHASE2-R4-B (P2-02 SNAPSHOT GENERATION COHERENCE ticket section 20):
  // a LEGACY destination importing a COMPLETE snapshot must analyze/publish under THAT incoming
  // COMPLETE authority — never the destination's stale LEGACY_UNPROVEN authority — so this same
  // transaction's own officialDecision already matches what an immediate reload of the identical
  // just-committed generation recomputes. (This fixture's committee actions all resolve to
  // DATA_WAIT/HOLD regardless of authority in this synthetic no-live-data harness, so the
  // blockedReason/noTrade checks below cannot by themselves discriminate the historical bug on
  // this fixture — see the dedicated source-ordering regression test in
  // useAppStore.candidatePortfolioRecommendation.test.ts for the deterministic check. This test
  // still guards the genuinely observable invariant: authority and its downstream shape stay
  // identical immediately and after reload.)
  it('a LEGACY destination importing a COMPLETE snapshot computes officialDecision under the NEW authority immediately, matching a fresh reload', async () => {
    const PORTFOLIO_AUTHORITY_BLOCKED_REASON =
      'ポートフォリオの完全性が未証明のため実行権限がありません（COMPLETE FULL_EXPORTが必要）'
    // sp500_sbi is a real INITIAL_TRUST entry (account '特定'); its registered alias resolves via
    // the frozen alias-matching rule and reliably produces a BUY/SELL-titled committee action
    // (unlike the bare single-stock fixture above, which never emits one to gate).
    const SP500_ALIAS = 'SBI・V・S&P500インデックス・ファンド'
    const sourceStorage = makeStorage()
    const source = instance(sourceStorage.mock)
    const fullExportResult = await source.store.getState().importSbiPortfolioFullExport(csvFile([
      'データ基準日時,2026-09-11T00:00:00+09:00',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      TRUST_TAXABLE_LABEL, TRUST_HEADER,
      `${SP500_ALIAS},26000,4500000,95.50,-1.80,`,
      TRUST_TAXABLE_TOTAL,
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ]))
    expect(fullExportResult).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })

    vi.stubGlobal('localStorage', sourceStorage.mock)
    const raw = source.store.getState().exportPortfolioSnapshot()

    const destinationStorage = makeStorage()
    const destination = instance(destinationStorage.mock)
    // Fresh, non-suppressed market data — otherwise the DQ-suppression gate (dataSourceStatus
    // 'static'/stale in this synthetic no-live-data test environment) masks every action as
    // DATA_WAIT before the portfolio-authority gate this test targets ever gets a chance to show
    // through (isPortfolioAuthorityBlocked is only ever applied when !isDqBlocked).
    destination.store.setState(s => ({
      market: { ...s.market, last_updated: new Date(NOW_MS).toISOString() },
      system: {
        ...s.system,
        dataSourceStatus: { ...s.system.dataSourceStatus, market: 'loaded' },
        dataTimestamps: { ...s.system.dataTimestamps!, market: new Date(NOW_MS).toISOString() },
      },
    }))
    expect(destination.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    const importResult = await destination.store.getState().importPortfolioSnapshot(raw)
    expect(importResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    const committed = destination.store.getState()
    expect(committed.portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
    const committedBlocked = committed.officialDecision?.actions.some(
      a => a.blockedReason === PORTFOLIO_AUTHORITY_BLOCKED_REASON) ?? false
    // The bug this closes: analyzing under the stale LEGACY_UNPROVEN destination authority would
    // spuriously mark every stock BUY/SELL authority-blocked even though this same transaction
    // just proved and published COMPLETE.
    expect(committedBlocked).toBe(false)

    // Reload uses a fresh store instance whose own market/data bootstrap is independent of the
    // fresh values forced onto `destination` above (initialize() re-derives system.dataSourceStatus
    // itself) — so only the authority-derived invariant is comparable across the two instances;
    // dqSuppressed/noTrade legitimately differ here for reasons unrelated to this fix.
    vi.stubGlobal('localStorage', destinationStorage.mock)
    const reloaded = instance(destinationStorage.mock)
    await reloaded.store.getState().initialize()
    const afterReload = reloaded.store.getState()
    expect(afterReload.portfolioImportAuthority).toEqual(committed.portfolioImportAuthority)
  })

  it('v6 LEGACY_UNPROVEN round-trip: a never-proven source transfers as LEGACY_UNPROVEN (unchanged v5 behavior)', async () => {
    const sourceStorage = makeStorage()
    const source = instance(sourceStorage.mock)
    source.store.setState({ holdings: [MANUAL_HOLDING] })
    expect(source.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')

    vi.stubGlobal('localStorage', sourceStorage.mock)
    const raw = source.store.getState().exportPortfolioSnapshot()
    expect(JSON.parse(raw).importAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')

    const destinationStorage = makeStorage()
    const destination = instance(destinationStorage.mock)
    const importResult = await destination.store.getState().importPortfolioSnapshot(raw)
    expect(importResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(destination.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')

    vi.stubGlobal('localStorage', destinationStorage.mock)
    const generation = restoreCsvImportGeneration()
    expect(generation.status).toBe('committed')
    if (generation.status === 'committed') {
      // Unchanged historical behavior: a LEGACY_UNPROVEN transfer keeps writing v5 (no
      // importAuthority key at all — see ticket section 3's own frozen precedent).
      expect(generation.schemaVersion).toBe('csv-import-generation-5')
    }
  })

  it('no old snapshot may upgrade itself to COMPLETE: a tampered wire authority fails closed and mutates nothing', async () => {
    const sourceStorage = makeStorage()
    const source = instance(sourceStorage.mock)
    vi.stubGlobal('localStorage', sourceStorage.mock)
    const raw = source.store.getState().exportPortfolioSnapshot()
    const tampered = JSON.parse(raw)
    tampered.importAuthority.authorityStatus = 'COMPLETE' // forged, without recomputing identity
    const tamperedRaw = JSON.stringify(tampered)

    const destinationStorage = makeStorage()
    const destination = instance(destinationStorage.mock)
    const before = destination.store.getState()
    const importResult = await destination.store.getState().importPortfolioSnapshot(tamperedRaw)
    // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (RA-P3-01: snapshot re-sign attack): a contradictory
    // authority object (COMPLETE with importMode still null) is now rejected by the semantic
    // admission gate BEFORE the generation-identity recomputation ever runs — caught earlier and
    // more precisely than the old identity-mismatch failure this test originally hit. The
    // store-level API collapses the parser's internal 'INVALID_SNAPSHOT_AUTHORITY' code into the
    // generic 'INVALID_SNAPSHOT' (not part of PortfolioSnapshotImportResult's public code union);
    // either way, ok:false and zero mutation is what matters here.
    expect(importResult).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' })
    expect(destination.store.getState().holdings).toBe(before.holdings)
    expect(destination.store.getState().portfolioImportAuthority).toEqual(before.portfolioImportAuthority)
    vi.stubGlobal('localStorage', destinationStorage.mock)
    expect(destinationStorage.store[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R2-A — ticket section 28 test matrix (P1-04 repair)
// ═══════════════════════════════════════════════════════════════════════════

/** Re-signs a tampered wire payload's snapshotGenerationIdentity so it passes the
 *  identity/tamper check and reaches the application-level trust-integrity gate under test. */
function resignSnapshotIdentity(payload: Record<string, unknown>): void {
  payload.snapshotGenerationIdentity = computeSnapshotGenerationIdentityV2({
    holdings: payload.holdings as never,
    trust: payload.trust as never,
    portfolioPolicy: payload.portfolioPolicy as never,
    cashAssumptions: payload.cashAssumptions as never,
    csvImportedAt: payload.csvImportedAt as string | null,
    csvImportProvenance: payload.csvImportProvenance as never,
    importAuthority: payload.importAuthority as never,
  })
}

describe('P1-04: snapshot import never silently drops an unknown trust ID under COMPLETE/PARTIAL authority', () => {
  it('COMPLETE + a positive-eval unknown destination trust ID is rejected before any mutation', async () => {
    const sourceStorage = makeStorage()
    const source = instance(sourceStorage.mock)
    const fullExportResult = await source.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(fullExportResult).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })

    vi.stubGlobal('localStorage', sourceStorage.mock)
    const raw = source.store.getState().exportPortfolioSnapshot()
    const tampered = JSON.parse(raw)
    expect(tampered.importAuthority.authorityStatus).toBe('COMPLETE')
    tampered.trust.push({ id: 'ghost-fund-nonexistent', eval: 500_000, pnlPct: 0 })
    resignSnapshotIdentity(tampered)
    const raisedRaw = JSON.stringify(tampered)

    const destinationStorage = makeStorage()
    const destination = instance(destinationStorage.mock)
    const before = destination.store.getState()
    const importResult = await destination.store.getState().importPortfolioSnapshot(raisedRaw)
    expect(importResult).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT' })
    expect(destination.store.getState().holdings).toBe(before.holdings)
    expect(destination.store.getState().trust).toBe(before.trust)
    expect(destination.store.getState().portfolioImportAuthority).toEqual(before.portfolioImportAuthority)
    vi.stubGlobal('localStorage', destinationStorage.mock)
    expect(destinationStorage.store[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('COMPLETE + a zero-eval unknown destination trust ID is still skipped+reported (economically inert, never rejected)', async () => {
    const sourceStorage = makeStorage()
    const source = instance(sourceStorage.mock)
    const fullExportResult = await source.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(fullExportResult).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })

    vi.stubGlobal('localStorage', sourceStorage.mock)
    const raw = source.store.getState().exportPortfolioSnapshot()
    const withZeroGhost = JSON.parse(raw)
    withZeroGhost.trust.push({ id: 'ghost-fund-nonexistent', eval: 0, pnlPct: 0 })
    resignSnapshotIdentity(withZeroGhost)

    const destinationStorage = makeStorage()
    const destination = instance(destinationStorage.mock)
    const importResult = await destination.store.getState().importPortfolioSnapshot(JSON.stringify(withZeroGhost))
    expect(importResult).toMatchObject({ ok: true, code: 'SUCCESS', skippedTrustIds: ['ghost-fund-nonexistent'] })
    expect(destination.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
  })

  it('a legacy (v1-v3, LEGACY_UNPROVEN) snapshot with an unknown trust ID keeps its existing safe skip+report behavior, unchanged', async () => {
    const sourceStorage = makeStorage()
    const source = instance(sourceStorage.mock)
    source.store.setState({ holdings: [MANUAL_HOLDING] })
    expect(source.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')

    vi.stubGlobal('localStorage', sourceStorage.mock)
    const raw = source.store.getState().exportPortfolioSnapshot()
    const legacyWithGhost = JSON.parse(raw)
    expect(legacyWithGhost.importAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    legacyWithGhost.trust.push({ id: 'ghost-fund-nonexistent', eval: 500_000, pnlPct: 0 })
    resignSnapshotIdentity(legacyWithGhost)

    const destinationStorage = makeStorage()
    const destination = instance(destinationStorage.mock)
    const importResult = await destination.store.getState().importPortfolioSnapshot(JSON.stringify(legacyWithGhost))
    expect(importResult).toMatchObject({ ok: true, code: 'SUCCESS', skippedTrustIds: ['ghost-fund-nonexistent'] })
    expect(destination.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
  })
})
