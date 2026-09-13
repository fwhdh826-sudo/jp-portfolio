import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding } from '../types'
import { CSV_IMPORT_GENERATION_KEY, restoreCsvImportGeneration } from './persist'
import type { PortfolioGenerationLockAdapter } from './portfolioGenerationLock'
import { createAppStoreInstanceForTest, runFullAnalysis } from './useAppStore'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import { computeCanonicalPortfolioGenerationIdentityV3 } from '../utils/snapshotGenerationIdentity'

// OPS-SBI-P2-PREBUILD-PHASE2-STORE-AUTHORITY: FULL_EXPORT store action tests (ticket section 26).
// Synthetic fixtures only — no real SBI export data (Phase 1/2 privacy discipline).

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

const storage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

// Test-local copy of persist.ts's own (unexported) checksum algorithm — needed only to re-derive
// manifest.payloadChecksum after deliberately forging a committed envelope's payload in tests
// below (see the P2-03 duplicate-identity test). Not a production dependency duplication.
function testChecksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
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

// sp500_sbi is a real INITIAL_TRUST entry (account '特定'); its registered alias is used so
// Stage B resolves it via the frozen alias-matching rule.
const SP500_ALIAS = 'SBI・V・S&P500インデックス・ファンド'

function fullExportCsvLines(params: {
  stockRows?: string[]
  trustTaxableRows?: string[]
} = {}): string[] {
  return [
    STOCK_LABEL, STOCK_HEADER,
    ...(params.stockRows ?? ['6501,日立製作所,8500,900000,15.20,1.10,2025-06-01']),
    STOCK_TOTAL,
    TRUST_TAXABLE_LABEL, TRUST_HEADER,
    ...(params.trustTaxableRows ?? []),
    TRUST_TAXABLE_TOTAL,
    ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
    ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
  ]
}

function csvFile(lines: string[]): File {
  return new File([lines.join('\n')], 'portfolio.csv', { type: 'text/csv' })
}

const EXISTING_HOLDING: Holding = {
  code: '9999', name: '既存銘柄', eval: 50_000, pnlPct: 1, mu: 0.08, sigma: 0.2,
  sigmaSource: 'static', beta: 1, sector: 'テスト', target: 0, alert: 0,
  lock: false, mitsu: false, ma: true, rsi: 50, macd: true, vol: false, mom3m: 0,
  roe: 10, per: 15, pbr: 1, epsG: 5, cfOk: true, de: 0.5, divG: 1,
  score: 50, decision: 'HOLD', ev: 0,
}

function instance() {
  const created = createAppStoreInstanceForTest({ portfolioGenerationLock: immediateAdapter() })
  created.store.setState(state => ({
    system: { ...state.system, status: 'idle', error: null, dataSourceOutcome: { loaded: 14, total: 14 } },
  }))
  return created
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('FileReader', TestFileReader)
  Object.keys(storage).forEach(key => delete storage[key])
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('importSbiPortfolioFullExport: FULL_EXPORT store commit path', () => {
  it('test 1: complete stock + trust unique registry resolution → COMPLETE commit', async () => {
    const created = instance()
    const result = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] })),
    )
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })
    const state = created.store.getState()
    expect(state.portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
    expect(state.portfolioImportAuthority.importMode).toBe('FULL_EXPORT')
    expect(state.holdings.find(h => h.code === '6501')?.eval).toBe(900000)
    expect(state.trust.find(t => t.id === 'sp500_sbi')?.eval).toBe(4500000)
    const generation = restoreCsvImportGeneration()
    expect(generation.status).toBe('committed')
    if (generation.status === 'committed') {
      expect(generation.schemaVersion).toBe('csv-import-generation-6')
      expect(generation.payload.importAuthority?.authorityStatus).toBe('COMPLETE')
    }
  })

  it('test 2: ABSENT required trust section → no mutation', async () => {
    const created = instance()
    const csv = [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL]
    const before = created.store.getState()
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('EXPECTED_SECTION_ABSENT')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02 ticket section 5): parser-level closure
  // (sbiPortfolioImportV2.test.ts) proves the classifier itself; these two prove the same
  // independent-audit-reproduced rows also block the production store commit path, not just
  // the standalone parser — an otherwise-fully-valid FULL_EXPORT with one malicious/unknown
  // preamble line must never reach SUCCESS.
  it('P1-02 independent audit repro: blank-first-cell comma-heavy preamble row blocks production FULL_EXPORT commit', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      ',900000,100,200',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('P1-02 independent audit repro: fake-prefix glued onto registered count label blocks production FULL_EXPORT commit', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      '総件数FAKE,900000,100',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  // OPS-SBI-P2-PREBUILD-PHASE2-R5-A (RA-P1-01 ticket section 10): the row-level (not
  // label-level) preamble repair closes a residual escape the above two P1-02 repros never
  // exercised — a registered count-label PREFIX WITH ITS SEPARATOR followed by extra trailing
  // columns. Parser-level closure is sbiPortfolioImportV2.test.ts's own RA-P1-01 repro block;
  // these prove the identical rows also block the production store commit path.
  it('RA-P1-01 independent audit repro: colon-separated count label with extra trailing columns blocks production FULL_EXPORT commit', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      '総件数：FAKE,900000,100',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('RA-P1-01 independent audit repro: the registered report title with extra trailing columns blocks production FULL_EXPORT commit', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      'ポートフォリオ一覧,900000,100',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('test 4: unknown trust → no mutation', async () => {
    const created = instance()
    const before = created.store.getState()
    const result = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: ['謎の投信,26000,4500000,95.50,-1.80,'] })),
    )
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNKNOWN_TRUST')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('test 7: malformed numeric position (blank eval) → no mutation', async () => {
    const created = instance()
    const before = created.store.getState()
    const result = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ stockRows: ['6501,日立製作所,8500,,15.20,1.10,2025-06-01'] })),
    )
    expect(result.ok).toBe(false)
    expect(created.store.getState().holdings).toBe(before.holdings)
  })

  it('test 8: valid-empty trust section zeros matching prior trust positions (registry-preserving)', async () => {
    const created = instance()
    created.store.setState(state => ({
      trust: state.trust.map(t => t.id === 'sp500_sbi' ? { ...t, eval: 1_000_000 } : t),
    }))
    const result = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines()), // no trust rows at all — all 3 trust sections VALID_EMPTY
    )
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const fund = created.store.getState().trust.find(t => t.id === 'sp500_sbi')
    expect(fund?.eval).toBe(0)
    expect(fund?.policy).toBe('OVERSEAS_LONGTERM') // registry metadata preserved, not deleted
  })

  it('test 9: absent-from-complete-stock-section stock is removed', async () => {
    const created = instance()
    // Two existing holdings so the single removal stays under the destructive threshold
    // (ratio 0.5 is not > 0.5) and this test exercises plain removal, not confirmation.
    created.store.setState({ holdings: [{ ...EXISTING_HOLDING }, { ...EXISTING_HOLDING, code: '6501', name: '日立製作所' }] })
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().holdings.find(h => h.code === '9999')).toBeUndefined()
    expect(created.store.getState().holdings.find(h => h.code === '6501')).toBeDefined()
  })

  it('test 10/11: legitimate large removal requires confirmation, then commits with the returned token', async () => {
    const created = instance()
    const manyHoldings: Holding[] = Array.from({ length: 8 }, (_, i) => ({
      ...EXISTING_HOLDING, code: `H${i}`, name: `銘柄${i}`,
    }))
    created.store.setState({ holdings: manyHoldings })
    const before = created.store.getState()

    const preview = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(preview).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' })
    expect(created.store.getState().holdings).toBe(before.holdings) // no mutation before confirmation
    if (preview.ok || preview.code !== 'CONFIRMATION_REQUIRED') throw new Error('expected CONFIRMATION_REQUIRED')

    const confirmed = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines()),
      { confirmationToken: preview.confirmationToken },
    )
    expect(confirmed).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().holdings.map(h => h.code)).toEqual(['6501'])
  })

  it('test 12: an incorrect/stale confirmationToken is rejected, not silently accepted', async () => {
    const created = instance()
    const manyHoldings: Holding[] = Array.from({ length: 8 }, (_, i) => ({
      ...EXISTING_HOLDING, code: `H${i}`, name: `銘柄${i}`,
    }))
    created.store.setState({ holdings: manyHoldings })
    const before = created.store.getState()

    const bogusToken = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
    const rejected = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines()),
      { confirmationToken: bogusToken },
    )
    expect(rejected).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' })
    if (!rejected.ok && rejected.code === 'CONFIRMATION_REQUIRED') {
      expect(rejected.confirmationToken).not.toBe(bogusToken)
    }
    expect(created.store.getState().holdings).toBe(before.holdings)

    // The correct token from this rejection now commits successfully — proving the earlier
    // bogus token specifically, not confirmation in general, was what was rejected.
    if (rejected.ok || rejected.code !== 'CONFIRMATION_REQUIRED') throw new Error('expected CONFIRMATION_REQUIRED')
    const confirmed = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines()),
      { confirmationToken: rejected.confirmationToken },
    )
    expect(confirmed).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

// OPS-SBI-P2-PREBUILD-PHASE2-R6-A (RA-P1-01 CLOSURE — VALUE GRAMMAR): parser-level closure is
// sbiPortfolioImportV2.test.ts's own R6-A regression matrix; these prove the identical
// malformed-value preamble rows also block the production store commit path — with zero
// authority mutation, and (ticket section 7) as AUTHORITY_NOT_PASS at the parser admission
// boundary rather than surfacing later as a generic UNKNOWN_ERROR.
describe('importSbiPortfolioFullExport: R6-A preamble value grammar (RA-P1-01 closure)', () => {
  it('a malformed 総件数 value blocks production FULL_EXPORT commit, zero mutation', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      '総件数：FAKE',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNKNOWN_PREAMBLE_LINE')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('a malformed 選択範囲 value (path-traversal-shaped payload) blocks production FULL_EXPORT commit, zero mutation', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      '選択範囲：../../etc/passwd',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNKNOWN_PREAMBLE_LINE')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('a malformed データ基準日時 timestamp value blocks production FULL_EXPORT commit as AUTHORITY_NOT_PASS (not UNKNOWN_ERROR), zero mutation', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      'データ基準日時,not-a-timestamp',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    // The proven parser/production semantic split: this must fail closed at the authority gate,
    // never reach buildCsvSourceProvenance and throw InvalidCsvSourceTimestampError → UNKNOWN_ERROR.
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('UNKNOWN_PREAMBLE_LINE')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('a script-tag payload behind a weak export-timestamp label (出力日時) blocks production FULL_EXPORT commit, zero mutation', async () => {
    const created = instance()
    const before = created.store.getState()
    const csv = [
      '出力日時,<script>alert(1)</script>',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })

  it('a fully valid preamble (count/page/range/timestamp) still commits to SUCCESS (positive control)', async () => {
    const created = instance()
    const csv = [
      'データ基準日時,2026-09-10T00:00:00+09:00',
      '総件数：150件',
      'ページ：1',
      '選択範囲：1-100',
      ...fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] }),
    ]
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })
  })
})

// OPS-SBI-P2-PREBUILD-PHASE2-R1-AUTHORITY-INTEGRITY-REPAIR (P2-03): the FULL_EXPORT path must
// pass the same sourceAsOf monotonicity / semantic duplicate protections as the legacy CSV
// importer before mutation (ticket sections 7-11/14).
describe('importSbiPortfolioFullExport: P2-03 provenance/freshness/duplicate gate', () => {
  function fullExportCsvLinesWithSourceAsOf(sourceAsOf: string, stockEval = 900_000): string[] {
    return [
      `データ基準日時,${sourceAsOf}`,
      ...fullExportCsvLines({ stockRows: [`6501,日立製作所,8500,${stockEval},15.20,1.10,2025-06-01`] }),
    ]
  }

  // Regression guard: a successful FULL_EXPORT commit must leave the live published projection
  // aligned with what was just durably committed (own-write alignment), so a subsequent write
  // from the very same tab is not spuriously rejected as CROSS_TAB_STATE_STALE.
  it('a subsequent manual mutation after a successful FULL_EXPORT commit is not spuriously stale', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-10T00:00:00+09:00', 900_000)),
    )
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const followUp = await created.store.getState().updateHolding('6501', { eval: 1 })
    expect(followUp).toMatchObject({ ok: true })
  })

  it('newer explicit source succeeds and advances the generation', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-10T00:00:00+09:00', 900_000)),
    )
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })

    const second = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-11T00:00:00+09:00', 950_000)),
    )
    expect(second).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().holdings.find(h => h.code === '6501')?.eval).toBe(950_000)
  })

  it('older explicit source is rejected (STALE_SOURCE), zero mutation', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-11T00:00:00+09:00', 900_000)),
    )
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = created.store.getState()
    const canonicalRawBefore = storage[CSV_IMPORT_GENERATION_KEY]

    const stale = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-10T00:00:00+09:00', 111_111)),
    )
    expect(stale).toMatchObject({ ok: false, code: 'STALE_SOURCE' })
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalRawBefore)
  })

  it('same semantic export duplicate is a no-op (DUPLICATE_FULL_EXPORT), no needless new generation', async () => {
    const created = instance()
    const lines = fullExportCsvLinesWithSourceAsOf('2026-09-11T00:00:00+09:00', 900_000)
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(lines))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const canonicalRawBefore = storage[CSV_IMPORT_GENERATION_KEY]

    const duplicate = await created.store.getState().importSbiPortfolioFullExport(csvFile([...lines]))
    expect(duplicate).toMatchObject({ ok: true, code: 'DUPLICATE_FULL_EXPORT' })
    // No needless new generation: canonical bytes are byte-identical (importedAt did not
    // silently bump the generation merely because operation time changed).
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalRawBefore)
  })

  it('a new operation time with an old sourceAsOf does not bypass stale protection', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-11T00:00:00+09:00', 900_000)),
    )
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = created.store.getState()

    // Advance wall-clock operation time — importedAt (not sourceAsOf) moves forward — while the
    // CSV's own explicit sourceAsOf is still older than the current generation's.
    vi.setSystemTime(NOW_MS + 24 * 60 * 60 * 1000)
    const stale = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-10T00:00:00+09:00', 222_222)),
    )
    expect(stale).toMatchObject({ ok: false, code: 'STALE_SOURCE' })
    expect(created.store.getState().holdings).toBe(before.holdings)
  })

  it('weak/unknown conflicting source requires explicit confirmUnknownProvenance', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-11T00:00:00+09:00', 900_000)),
    )
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = created.store.getState()
    const canonicalRawBefore = storage[CSV_IMPORT_GENERATION_KEY]

    // No data-basis-date header at all → weak/unknown provenance, replacing an authoritative
    // current generation with different content.
    const weakLines = fullExportCsvLines({ stockRows: ['6501,日立製作所,8500,333333,15.20,1.10,2025-06-01'] })
    const rejected = await created.store.getState().importSbiPortfolioFullExport(csvFile(weakLines))
    expect(rejected).toMatchObject({ ok: false, code: 'SOURCE_PROVENANCE_UNKNOWN' })
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalRawBefore)

    const confirmed = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(weakLines),
      { confirmUnknownProvenance: true },
    )
    expect(confirmed).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().holdings.find(h => h.code === '6501')?.eval).toBe(333_333)
  })

  it('a failed provenance gate causes zero mutation: canonical bytes, holdings, trust, authority all unchanged', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-11T00:00:00+09:00', 900_000)),
    )
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = created.store.getState()
    const canonicalRawBefore = storage[CSV_IMPORT_GENERATION_KEY]

    const conflicting = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLinesWithSourceAsOf('2026-09-11T00:00:00+09:00', 444_444)),
    )
    expect(conflicting).toMatchObject({ ok: false, code: 'SOURCE_PROVENANCE_CONFLICT' })
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().trust).toBe(before.trust)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(created.store.getState().officialDecision).toBe(before.officialDecision)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalRawBefore)
  })
})

// OPS-SBI-P2-PREBUILD-PHASE2-R2-A — ticket section 29 test matrix (P2-02 repair): the staged
// state runFullAnalysis computes against must already carry the incoming COMPLETE authority.
const PORTFOLIO_AUTHORITY_BLOCKED_REASON =
  'ポートフォリオの完全性が未証明のため実行権限がありません（COMPLETE FULL_EXPORTが必要）'

describe('importSbiPortfolioFullExport: P2-02 staged authority ordering', () => {
  it('a first COMPLETE FULL_EXPORT from LEGACY computes officialDecision under the NEW authority, not the stale LEGACY_UNPROVEN one', async () => {
    const created = instance()
    const before = created.store.getState()
    expect(before.portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')

    const result = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] })),
    )
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const state = created.store.getState()
    expect(state.portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
    // The staged-authority-ordering bug (P2-02) would compute THIS SAME transaction's
    // officialDecision under the old, stale LEGACY_UNPROVEN authority — every stock BUY/SELL
    // spuriously BLOCKED with this exact Policy-B reason, even though this same import just
    // proved COMPLETE and published it.
    expect(state.officialDecision?.actions.some(a => a.blockedReason === PORTFOLIO_AUTHORITY_BLOCKED_REASON))
      .toBe(false)
  })

  it('officialDecision authority gating after a first COMPLETE commit matches a fresh reload of the same durable generation', async () => {
    const created = instance()
    const commitResult = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] })),
    )
    expect(commitResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    const beforeReload = created.store.getState()
    expect(beforeReload.officialDecision?.actions.some(a => a.blockedReason === PORTFOLIO_AUTHORITY_BLOCKED_REASON))
      .toBe(false)

    const reloaded = instance()
    await reloaded.store.getState().initialize()
    const afterReload = reloaded.store.getState()
    expect(afterReload.portfolioImportAuthority).toEqual(beforeReload.portfolioImportAuthority)
    // Same authority-gating outcome as the original commit — reload never re-introduces a spurious
    // authority-blocked BUY/SELL that the commit itself already correctly avoided.
    expect(afterReload.officialDecision?.actions.some(a => a.blockedReason === PORTFOLIO_AUTHORITY_BLOCKED_REASON))
      .toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R4-B — ticket section 18 test matrix (P2-02 repair)
// ═══════════════════════════════════════════════════════════════════════════

describe('importSbiPortfolioFullExport: P2-02 FULL_EXPORT pre/post-reload equivalence', () => {
  // Independent audit reproduction: with a real candidateFunnel artifact available, the FIRST
  // COMPLETE FULL_EXPORT commit's own candidateDecisionSynthesis previously stayed at
  // runFullAnalysis's fail-closed `null` default (appendCommittedCandidatePortfolioRecommendations
  // was never called on this path at all — see the R4-B fix), while reloading that SAME
  // just-committed durable generation via initialize() ran the composition and produced a real
  // ('available') synthesis. That divergence — not any particular candidate outcome — is exactly
  // the "initial candidate synthesis = null vs. reconciled/reloaded generation = executable" gap.
  it('a first COMPLETE FULL_EXPORT with a candidateFunnel available composes a real candidateDecisionSynthesis immediately, not a fail-closed null', async () => {
    const created = instance()
    const artifact = structuredClone(buildValidCandidateFunnelArtifact())
    created.store.setState(s => ({
      candidateFunnel: artifact,
      system: {
        ...s.system,
        dataSourceStatus: { ...s.system.dataSourceStatus, candidateFunnel: 'loaded' },
        dataTimestamps: { ...s.system.dataTimestamps!, candidateFunnel: artifact._meta.generatedAt },
      },
    }))

    const result = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] })),
    )
    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    const committed = created.store.getState()

    // The bug this closes: composition was skipped entirely on this action's own commit path.
    expect(committed.candidateDecisionSynthesis).not.toBeNull()
    expect(committed.candidateDecisionSynthesis?.status).toBe('available')
    // provenance.candidateGenerationId binds the synthesis to the SAME candidateFunnel generation
    // that was staged into analysis — proof this is a real composition, not a stale carry-over.
    expect(committed.candidateDecisionSynthesis?.provenance.candidateGenerationId).toBe(artifact._meta.generatedAt)
    // The durable generation this synthesis was composed against is the one that actually landed.
    expect(restoreCsvImportGeneration().status).toBe('committed')
  })
})

describe('importSbiPortfolioFullExport: P2-03 authority-aware duplicate identity', () => {
  it('same rows + same COMPLETE authority already committed is a true duplicate/no-op', async () => {
    const created = instance()
    const lines = fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] })
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(lines))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const canonicalRawBefore = storage[CSV_IMPORT_GENERATION_KEY]

    const duplicate = await created.store.getState().importSbiPortfolioFullExport(csvFile([...lines]))
    expect(duplicate).toMatchObject({ ok: true, code: 'DUPLICATE_FULL_EXPORT' })
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBe(canonicalRawBefore)
  })

  // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P2-03 ticket section 14 DUPLICATE REGISTRY CHANGE TEST):
  // 1. import complete export using the canonical fund name/alias
  // 2. mutate the registry entry's ID through the legal production updateTrust path, retaining
  //    name/account
  // 3+4. resolve and re-import the byte-identical CSV
  // Expected: NOT a duplicate/no-op — the resolved destination changed even though the CSV text
  // did not, so normal diff/authority logic must execute (and correctly migrate the balance to
  // the renamed id, never leaving it stranded under the old one).
  it('re-importing byte-identical rows after a registry ID rename is NOT a duplicate — normal diff/authority logic executes', async () => {
    const created = instance()
    // Resolved by canonical registry NAME ('SBI V S&P500'), not the id-keyed alias table — an id
    // rename would otherwise also orphan the alias lookup (TRUST_SBI_CSV_ALIASES is keyed by id),
    // which is a separate, out-of-scope registry-maintenance concern from what this test targets.
    const lines = fullExportCsvLines({ trustTaxableRows: ['SBI V S&P500,26000,4500000,95.50,-1.80,'] })
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(lines))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().trust.find(t => t.id === 'sp500_sbi')?.eval).toBe(4_500_000)

    // Legal production rename — same name/account, only the canonical registry id changes.
    const renameResult = await created.store.getState().updateTrust('sp500_sbi', { id: 'sp500_sbi_renamed' })
    expect(renameResult.ok).toBe(true)
    expect(created.store.getState().trust.some(t => t.id === 'sp500_sbi_renamed')).toBe(true)
    expect(created.store.getState().trust.some(t => t.id === 'sp500_sbi')).toBe(false)

    // Byte-identical CSV content re-imported — only the destination registry changed, not the file.
    const reImport = await created.store.getState().importSbiPortfolioFullExport(
      csvFile([...lines]),
      { confirmUnknownProvenance: true },
    )
    expect(reImport).toMatchObject({ ok: true, code: 'SUCCESS' })
    // The bug this closes: a pure row-content-hash duplicate check would have short-circuited
    // above as DUPLICATE_FULL_EXPORT, leaving the balance stranded under the old id.
    const finalTrust = created.store.getState().trust
    expect(finalTrust.find(t => t.id === 'sp500_sbi_renamed')?.eval).toBe(4_500_000)
    expect(finalTrust.some(t => t.id === 'sp500_sbi')).toBe(false)
  })

  it('same rows while the current authority is only PARTIAL/LEGACY must not be short-circuited as duplicate merely on row content', async () => {
    const created = instance()
    const lines = fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] })
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(lines))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })

    // Forge the committed generation's authority down to LEGACY_UNPROVEN without touching the
    // holdings/trust content or the CSV rows — a purely authority-side divergence. Both
    // snapshotGenerationIdentity (bound to importAuthority via the v6/V3 identity contract) and
    // the manifest's payloadChecksum are re-derived so the forged envelope still reads back as a
    // structurally valid committed generation.
    const committedRaw = storage[CSV_IMPORT_GENERATION_KEY]
    const envelope = JSON.parse(committedRaw)
    envelope.payload.importAuthority = {
      authorityVersion: 'portfolio-import-authority-1', importMode: null, contractVersion: null,
      profileId: null, authorityStatus: 'LEGACY_UNPROVEN', selectedAssetClasses: null,
      preservedAssetClasses: null, provenanceScope: 'UNKNOWN', sectionCompleteness: [],
    }
    envelope.payload.snapshotGenerationIdentity = computeCanonicalPortfolioGenerationIdentityV3({
      holdings: envelope.payload.holdings,
      trust: envelope.payload.trust,
      learning: envelope.payload.learning,
      portfolioPolicy: envelope.payload.portfolioPolicy,
      cashAssumptions: envelope.payload.cashAssumptions,
      csvImportedAt: envelope.payload.csvImportedAt,
      csvImportProvenance: envelope.payload.provenance,
      syncSummary: envelope.payload.syncSummary,
      trustShortSnapshot: envelope.payload.trustShortSnapshot,
      origin: envelope.payload.origin,
      snapshotTransferIdentity: envelope.payload.snapshotTransferIdentity,
      importAuthority: envelope.payload.importAuthority,
    })
    envelope.manifest.payloadChecksum = testChecksum(JSON.stringify(envelope.payload))
    storage[CSV_IMPORT_GENERATION_KEY] = JSON.stringify(envelope)
    created.store.setState({ portfolioImportAuthority: envelope.payload.importAuthority })

    // Re-importing the exact same rows must re-prove COMPLETE — never be treated as a duplicate
    // no-op merely because the CSV content fingerprint matches (would leave the forged
    // LEGACY_UNPROVEN authority in place, undetected).
    const reImport = await created.store.getState().importSbiPortfolioFullExport(csvFile([...lines]))
    expect(reImport).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R2-A — ticket section 31 test matrix (P2-04 repair)
// ═══════════════════════════════════════════════════════════════════════════

describe('importSbiPortfolioFullExport: P2-04 legacy generation confirmation identity', () => {
  it('a legacy content change invalidates an old confirmation token even when the add/remove code sets stay identical', async () => {
    const created = instance()
    // 8 identical-looking existing holdings so the CSV's single-stock FULL_EXPORT crosses the
    // destructive removal threshold while NO v6 canonical generation exists yet (pure legacy/fresh
    // store) — exactly the generationId=null scenario P2-04 closes.
    const manyHoldings: Holding[] = Array.from({ length: 8 }, (_, i) => ({
      ...EXISTING_HOLDING, code: `H${i}`, name: `銘柄${i}`,
    }))
    created.store.setState({ holdings: manyHoldings })

    const lines = fullExportCsvLines()
    const preview = await created.store.getState().importSbiPortfolioFullExport(csvFile(lines))
    expect(preview).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' })
    if (preview.ok || preview.code !== 'CONFIRMATION_REQUIRED') throw new Error('expected CONFIRMATION_REQUIRED')
    const staleToken = preview.confirmationToken

    // Change legacy holding CONTENT (eval) without changing the add/remove CODE SET at all.
    created.store.setState(state => ({
      holdings: state.holdings.map(h => h.code === 'H0' ? { ...h, eval: h.eval + 1 } : h),
    }))

    const replay = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(lines), { confirmationToken: staleToken },
    )
    expect(replay).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' })
    if (replay.ok || replay.code !== 'CONFIRMATION_REQUIRED') throw new Error('expected CONFIRMATION_REQUIRED')
    expect(replay.confirmationToken).not.toBe(staleToken)
    expect(created.store.getState().holdings.some(h => h.code === 'H0')).toBe(true)

    // The freshly re-derived token (matching the now-current legacy content) still commits.
    const confirmed = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(lines), { confirmationToken: replay.confirmationToken },
    )
    expect(confirmed).toMatchObject({ ok: true, code: 'SUCCESS' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R2-A — ticket section 32 test matrix (P2-05 repair)
// ═══════════════════════════════════════════════════════════════════════════

// nk225_sbi is a real INITIAL_TRUST entry with policy JAPAN_SHORTTERM (the only policy the
// trust-short tracker's detection filters on — see buildShortTrustSnapshot); its registered
// alias is used so Stage B resolves it via the frozen alias-matching rule.
const NK225_ALIAS = 'SBI・iシェアーズ・日経225インデックス・ファンド'

describe('importSbiPortfolioFullExport: P2-05 trust-short execution history', () => {
  it('a FULL_EXPORT trust increase updates the tracker so a second same-day plan respects the daily limit', async () => {
    const created = instance()
    // First establishes the tracker's pre-import baseline (no prior snapshot exists yet, so this
    // commit alone can never itself register as "executed" — same first-import edge case as
    // importCsv's own detection contract).
    const baseline = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(baseline).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(await import('../domain/learning/trustShortTracker')
      .then(m => m.getTrustShortTodayExecutionCount(NOW_MS))).toBe(0)

    // A large trust-eval increase (single JAPAN_SHORTTERM fund, from the 0 baseline) crosses
    // stageTrustExecutionFromCsvSync's own detection threshold (absDiffSum >= 200_000 &&
    // turnover >= 0.04) exactly like importCsv's own detection tests rely on.
    // Different content with no explicit source timestamp is weak/unknown provenance replacing an
    // existing (also weak-provenance) generation — the same explicit confirmation contract as any
    // other content-changing weak-provenance re-import (unrelated to trust-short itself).
    const increase = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: [`${NK225_ALIAS},26000,300000,0,0,`] })),
      { confirmUnknownProvenance: true },
    )
    expect(increase).toMatchObject({ ok: true, code: 'SUCCESS' })

    const { getTrustShortTodayExecutionCount } = await import('../domain/learning/trustShortTracker')
    expect(getTrustShortTodayExecutionCount(NOW_MS)).toBe(1)

    // OPS-SBI-P2-PREBUILD-PHASE2-R4-B (P2-05 TRUST-SHORT COHERENCE ticket section 21/22): the
    // PUBLISHED plan from THIS SAME commit must already reflect today's just-detected execution —
    // blockedByDailyLimit derives purely from todayEntryCount (see buildTrustPortfolioPlan), so
    // this is unaffected by the DQ-suppression/staleness noise that makes officialDecision.noTrade
    // an unreliable signal in this synthetic environment. The old sequence (analyze with the
    // pre-execution tracker, persist, THEN record execution) would leave this still `false`
    // immediately after a successful commit.
    const committedShortTermMode = created.store.getState().trustPlan?.shortTermMode
    expect(committedShortTermMode?.blockedByDailyLimit).toBe(true)
    expect(committedShortTermMode?.canEnter).toBe(false)

    // Immediate reanalysis (any store action re-running runFullAnalysis) must read the SAME
    // durable tracker state and agree — no flip merely from recomputing.
    const reanalyzed = runFullAnalysis(created.store.getState(), { nowMs: NOW_MS })
    expect(reanalyzed.trustPlan?.shortTermMode.blockedByDailyLimit).toBe(true)

    // Exact same content again (no new increase) must not double-record — still exactly 1.
    const duplicate = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: [`${NK225_ALIAS},26000,300000,0,0,`] })),
    )
    expect(duplicate).toMatchObject({ ok: true, code: 'DUPLICATE_FULL_EXPORT' })
    expect(getTrustShortTodayExecutionCount(NOW_MS)).toBe(1)

    // Reload from the durable generation (a fresh store restoring canonical bytes + re-reading
    // the tracker) must show the identical blocked state — never re-open today's entry slot.
    const reloaded = instance()
    await reloaded.store.getState().initialize()
    expect(reloaded.store.getState().trustPlan?.shortTermMode.blockedByDailyLimit).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R2-A — ticket section 4 T9 production-path authority test (P1-01)
// ═══════════════════════════════════════════════════════════════════════════

describe('importSbiPortfolioFullExport: T9 production-path authority (P1-01)', () => {
  it('an existing v6 COMPLETE generation stays canonical v6 through an ordinary current T9 SBI import, authority reflecting the new proven FULL_EXPORT', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({ trustTaxableRows: [`${SP500_ALIAS},26000,4500000,95.50,-1.80,`] })),
    )
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })
    const firstGeneration = restoreCsvImportGeneration()
    expect(firstGeneration.status).toBe('committed')
    if (firstGeneration.status === 'committed') expect(firstGeneration.schemaVersion).toBe('csv-import-generation-6')

    // Ordinary current T9 SBI import — the exact action T9_Settings.tsx's production CSV drop
    // area wiring calls (see T9_Settings.productionWiring.test.ts) — proving a fresh FULL_EXPORT.
    const second = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({
        stockRows: ['6501,日立製作所,8500,950000,15.20,1.10,2025-06-01'],
        trustTaxableRows: [`${SP500_ALIAS},26000,4600000,95.50,-1.80,`],
      })),
      { confirmUnknownProvenance: true },
    )
    expect(second).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })
    const secondGeneration = restoreCsvImportGeneration()
    expect(secondGeneration.status).toBe('committed')
    if (secondGeneration.status === 'committed') {
      // Never downgraded to v5, no matter how many ordinary FULL_EXPORT imports follow.
      expect(secondGeneration.schemaVersion).toBe('csv-import-generation-6')
      expect(secondGeneration.payload.importAuthority?.authorityStatus).toBe('COMPLETE')
    }
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
    expect(created.store.getState().holdings.find(h => h.code === '6501')?.eval).toBe(950_000)
  })

  it('stock-valid + trust-ABSENT through the actual T9 action is rejected with zero mutation', async () => {
    const created = instance()
    const csv = [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL]
    const before = created.store.getState()
    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(csv))
    expect(result).toMatchObject({ ok: false, code: 'AUTHORITY_NOT_PASS' })
    if (!result.ok && result.code === 'AUTHORITY_NOT_PASS') {
      expect(result.reasons).toContain('EXPECTED_SECTION_ABSENT')
    }
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R2-A — ticket section 33 test matrix (P2-06 verification)
// ═══════════════════════════════════════════════════════════════════════════
//
// PERSISTENCE_INDETERMINATE was already fail-closed for the legacy importCsv path (see
// useAppStore.csvImportAtomic.test.ts's R3-FIX-C RA-001); this proves the exact same contract
// holds for importSbiPortfolioFullExport, AND — the part neither file tested before — that a
// naive retry after an indeterminate write is itself blocked (never builds a further mutation on
// top of an unverified live/durable divergence) rather than merely "not lying about success."

describe('importSbiPortfolioFullExport: P2-06 persistence-indeterminate safety', () => {
  it('write-may-have-happened + unreadable commit check surfaces PERSISTENCE_INDETERMINATE with zero optimistic publish', async () => {
    const created = instance()
    const before = created.store.getState()
    let failCommitCheck = false
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY && failCommitCheck) {
          failCommitCheck = false
          throw new Error('raw commit-check read failure')
        }
        return storage[key] ?? null
      },
      setItem: (key: string, value: string) => {
        storage[key] = value
        if (key === CSV_IMPORT_GENERATION_KEY) {
          failCommitCheck = true
          throw new Error('raw completion notification failure')
        }
      },
      removeItem: (key: string) => { delete storage[key] },
    })

    const result = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_INDETERMINATE' })
    // No optimistic new live COMPLETE — live state is untouched, exactly as before the attempt.
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    // The write DID physically land (this is the genuinely ambiguous case — commit succeeded but
    // the completion signal could not be read back), proven directly against raw storage.
    expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeTypeOf('string')

    // A naive retry, without any external reconciliation, must not execute against the now-
    // physically-divergent canonical generation this tab's in-memory state has never seen.
    vi.stubGlobal('localStorage', localStorageMock)
    const retry = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(retry).toMatchObject({ ok: false, code: 'CROSS_TAB_STATE_STALE' })
    expect(created.store.getState().holdings).toBe(before.holdings)
    expect(created.store.getState().portfolioImportAuthority).toBe(before.portfolioImportAuthority)

    // Only after a genuine reload (fresh instance restoring the actually-committed generation)
    // does execution authority resume.
    const reloaded = instance()
    await reloaded.store.getState().initialize()
    expect(reloaded.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
  })

  // OPS-SBI-P2-PREBUILD-PHASE2-R4-B (P2-06 EXECUTION QUARANTINE ticket section 26): the
  // scenario the previous test above never exercised — an ALREADY-executable live authority
  // (allocationPlanStatus=current, ≥1 executable instrument, an executable BUY action) must be
  // quarantined the instant a LATER durable write becomes indeterminate. The forced
  // allocationPlan/officialDecision below are real, fully-shaped objects from a genuine COMPLETE
  // commit — only `allocationPlanStatus`/one instrumentPlan's `executable`/one action's `action`
  // are overridden, so every other required field stays a real, valid value.
  it('an existing executable allocation/officialDecision is quarantined immediately on PERSISTENCE_INDETERMINATE', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const settled = created.store.getState()
    if (!settled.allocationPlan || !settled.officialDecision) throw new Error('fixture missing allocationPlan/officialDecision')

    const forcedAllocationPlan = {
      ...settled.allocationPlan,
      instrumentPlans: settled.allocationPlan.instrumentPlans.map((plan, i) =>
        i === 0 ? { ...plan, executable: true } : plan),
    }
    const forcedOfficialDecision = {
      ...settled.officialDecision,
      actions: settled.officialDecision.actions.map((action, i) =>
        i === 0 ? { ...action, action: 'BUY' as const, blockedReason: undefined } : action),
    }
    created.store.setState({
      allocationPlanStatus: 'current',
      allocationPlan: forcedAllocationPlan,
      officialDecision: forcedOfficialDecision,
    })
    const before = created.store.getState()
    expect(before.allocationPlanStatus).toBe('current')
    expect(before.allocationPlan?.instrumentPlans.some(p => p.executable)).toBe(true)
    expect(before.officialDecision?.actions.some(a => a.action === 'BUY')).toBe(true)

    let failCommitCheck = false
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => {
        if (key === CSV_IMPORT_GENERATION_KEY && failCommitCheck) {
          failCommitCheck = false
          throw new Error('raw commit-check read failure')
        }
        return storage[key] ?? null
      },
      setItem: (key: string, value: string) => {
        storage[key] = value
        if (key === CSV_IMPORT_GENERATION_KEY) {
          failCommitCheck = true
          throw new Error('raw completion notification failure')
        }
      },
      removeItem: (key: string) => { delete storage[key] },
    })

    const result = await created.store.getState().importSbiPortfolioFullExport(
      csvFile(fullExportCsvLines({
        stockRows: [
          '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
          '7203,トヨタ自動車,3000,300000,5.00,0.50,2025-07-01',
        ],
      })),
      { confirmUnknownProvenance: true },
    )
    expect(result).toMatchObject({ ok: false, code: 'PERSISTENCE_INDETERMINATE' })

    const quarantined = created.store.getState()
    expect(quarantined.system.portfolioDurabilityStatus).toBe('INDETERMINATE')
    expect(quarantined.allocationPlanStatus).toBe('blocked')
    expect(quarantined.allocationPlan?.instrumentPlans.every(p => !p.executable)).toBe(true)
    expect(quarantined.officialDecision?.actions.every(a =>
      a.action !== 'BUY' && a.action !== 'SELL' && a.action !== 'BUY_NEW' && a.action !== 'ADD_EXISTING')).toBe(true)
    expect(quarantined.candidateDecisionSynthesis).toBeNull()
    // holdings/trust/portfolioImportAuthority — the exploratory/authority-proof fields this
    // quarantine never touches — stay exactly as they were.
    expect(quarantined.holdings).toBe(before.holdings)
    expect(quarantined.trust).toBe(before.trust)
    expect(quarantined.portfolioImportAuthority).toBe(before.portfolioImportAuthority)

    // Any subsequent recompute (any store action) must stay quarantined — never restored merely
    // because inputs happen to be fresh.
    const reanalyzed = runFullAnalysis(created.store.getState(), { nowMs: NOW_MS })
    expect(reanalyzed.allocationPlanStatus).not.toBe('current')

    // A duplicate quarantine call (e.g. a second indeterminate hit) is a true no-op.
    const beforeSecond = created.store.getState()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage[key] ?? null,
      setItem: () => { throw new Error('still indeterminate') },
      removeItem: (key: string) => { delete storage[key] },
    })
    const second = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(second.ok).toBe(false)
    expect(created.store.getState()).toBe(beforeSecond)

    // Only a true reload — re-deriving authority from the actually-persisted canonical bytes —
    // clears the quarantine.
    vi.stubGlobal('localStorage', localStorageMock)
    const reloaded = instance()
    await reloaded.store.getState().initialize()
    expect(reloaded.store.getState().system.portfolioDurabilityStatus).toBeUndefined()
    expect(reloaded.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R5-B — RA-P2-01 / RA-P2-02 CLOSURE
//
// RA-P2-01: the P2-06 block above only ever proved quarantine for the three CSV/snapshot import
// actions (which share persistCsvImportTransaction's own thrown CsvImportPersistenceIndeterminateError
// catch). The independent re-audit reproduced the identical durable/live divergence risk through
// the SHARED runManualPortfolioMutation writers (updateHolding/updateTrust/setPortfolioPolicy/
// every cash-assumption action) and through refreshAllData/initialize's own best-effort
// replacement write — none of which ever called quarantinePortfolioDurabilityInStore at all.
//
// RA-P2-02: even where quarantine WAS reachable, it silently skipped setting
// system.portfolioDurabilityStatus whenever nothing in the CURRENT live state happened to be
// executable at that instant (allocationPlanStatus already blocked/stale, or no BUY/SELL/
// BUY_NEW/ADD_EXISTING officialDecision action) — so a LATER action publishing a fresh executable
// surface, without ever performing a true durable reload, found no quarantine standing in its way.
// ═══════════════════════════════════════════════════════════════════════════

// Generic fault-injection localStorage: every setItem call physically writes the intended bytes
// AND arms that exact key for exactly one immediate subsequent throw-on-read — reproducing
// section 22's "setItem physically stores new bytes → then throws AND completion/read-back
// throws" for whichever key a given writer's own transaction happens to touch first, without this
// test needing to know persist.ts's internal (unexported) storage key names.
function localStorageIndeterminateOnNextWrite() {
  let armedKey: string | null = null
  return {
    getItem: (key: string) => {
      if (key === armedKey) {
        armedKey = null
        throw new Error('raw readback failure')
      }
      return storage[key] ?? null
    },
    setItem: (key: string, value: string) => {
      storage[key] = value
      armedKey = key
    },
    removeItem: (key: string) => { delete storage[key] },
  }
}

// Once a committed canonical (v6) generation exists, every writer below replaces it through
// persistCsvImportTransaction instead of the legacy per-field transaction — its own indeterminate
// trigger is different (see that function's own comment): setItem on CSV_IMPORT_GENERATION_KEY
// itself must throw (a write-then-crash-before-completion-notification), and the SUBSEQUENT
// commit-check read of that same key must also throw. Same pattern the P2-06 block above already
// uses for persistCsvImportTransaction's other two callers (importCsv/importSbiPortfolioFullExport).
function localStorageIndeterminateOnCanonicalWrite() {
  let armed = false
  return {
    getItem: (key: string) => {
      if (key === CSV_IMPORT_GENERATION_KEY && armed) {
        armed = false
        throw new Error('raw commit-check read failure')
      }
      return storage[key] ?? null
    },
    setItem: (key: string, value: string) => {
      storage[key] = value
      if (key === CSV_IMPORT_GENERATION_KEY) {
        armed = true
        throw new Error('raw completion notification failure')
      }
    },
    removeItem: (key: string) => { delete storage[key] },
  }
}

describe('RA-P2-01/RA-P2-02: shared-writer & load-operation durability quarantine (R5-B)', () => {
  // Ticket section 22: setPortfolioPolicy / updateHolding / one trust mutation path / one
  // cash-assumption path, each starting from a genuinely BLOCKED-state live portfolio (nothing
  // executable) — the exact regression RA-P2-02 reproduced, since the old early-return made this
  // specific starting condition the one where the marker was silently never set.
  it.each([
    ['setPortfolioPolicy', (created: ReturnType<typeof instance>) =>
      created.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.25 })],
    ['updateHolding', (created: ReturnType<typeof instance>) => {
      created.store.setState({ holdings: [{ ...EXISTING_HOLDING }] })
      return created.store.getState().updateHolding('9999', { eval: 60_000 })
    }],
    ['updateTrust', (created: ReturnType<typeof instance>) => {
      const fundId = created.store.getState().trust[0]?.id
      return created.store.getState().updateTrust(fundId, { eval: 210_000 })
    }],
    ['setCashAssumptions', (created: ReturnType<typeof instance>) =>
      created.store.getState().setCashAssumptions({ grossCash: 500_000, safetyReserve: 0, pendingOrderCash: null })],
  ] as const)('%s: an indeterminate durable write quarantines execution authority even though nothing was currently executable (RA-P2-02)', async (_label, runAction) => {
    const created = instance()
    // Baseline live state: default INITIAL_HOLDINGS/INITIAL_TRUST, no analysis ever run — nothing
    // executable, portfolioDurabilityStatus unset. This is exactly the RA-P2-02 blocked-state.
    expect(created.store.getState().system.portfolioDurabilityStatus).toBeUndefined()
    expect(created.store.getState().allocationPlanStatus).not.toBe('current')

    vi.stubGlobal('localStorage', localStorageIndeterminateOnNextWrite())
    const result = await runAction(created)
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })
    expect(created.store.getState().system.portfolioDurabilityStatus).toBe('INDETERMINATE')
  })

  // Ticket section 24 (positive control): an ALREADY-executable live allocation/officialDecision
  // must still be neutralized immediately — this was never broken by RA-P2-01 for the CSV/snapshot
  // actions (P2-06 above), but was completely unreachable for the shared manual writers before
  // this repair (quarantinePortfolioDurabilityInStore was never called on this path at all).
  it('updateHolding: an existing executable allocation/officialDecision is quarantined immediately on an indeterminate durable write', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const settled = created.store.getState()
    if (!settled.allocationPlan || !settled.officialDecision) throw new Error('fixture missing allocationPlan/officialDecision')

    const forcedAllocationPlan = {
      ...settled.allocationPlan,
      instrumentPlans: settled.allocationPlan.instrumentPlans.map((plan, i) =>
        i === 0 ? { ...plan, executable: true } : plan),
    }
    const forcedOfficialDecision = {
      ...settled.officialDecision,
      actions: settled.officialDecision.actions.map((action, i) =>
        i === 0 ? { ...action, action: 'BUY' as const, blockedReason: undefined } : action),
    }
    created.store.setState({
      allocationPlanStatus: 'current',
      allocationPlan: forcedAllocationPlan,
      officialDecision: forcedOfficialDecision,
    })
    const before = created.store.getState()

    // A committed canonical generation exists after the FULL_EXPORT above, so updateHolding takes
    // the persistCurrentPortfolioGeneration replacement-write branch — fault-inject that branch's
    // own persistCsvImportTransaction write.
    vi.stubGlobal('localStorage', localStorageIndeterminateOnCanonicalWrite())
    const result = await created.store.getState().updateHolding('6501', { eval: 950_000 })
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })

    const quarantined = created.store.getState()
    expect(quarantined.system.portfolioDurabilityStatus).toBe('INDETERMINATE')
    expect(quarantined.allocationPlanStatus).toBe('blocked')
    expect(quarantined.allocationPlan?.instrumentPlans.every(p => !p.executable)).toBe(true)
    expect(quarantined.officialDecision?.actions.every(a =>
      a.action !== 'BUY' && a.action !== 'SELL' && a.action !== 'BUY_NEW' && a.action !== 'ADD_EXISTING')).toBe(true)
    expect(quarantined.candidateDecisionSynthesis).toBeNull()
    expect(quarantined.holdings).toBe(before.holdings)
    expect(quarantined.trust).toBe(before.trust)
    expect(quarantined.portfolioImportAuthority).toBe(before.portfolioImportAuthority)
  })

  // Ticket section 23: the exact blocked-state regression, run end-to-end through a shared
  // writer. Establish genuine COMPLETE authority, force the live allocation into a currently
  // BLOCKED/non-executable state (imitating stale/suppressed market inputs — no positive
  // allocation surface to protect right now), then cause an indeterminate persistence outcome via
  // setPortfolioPolicy. durabilityStatus must still become INDETERMINATE, and neither a plain
  // reanalysis nor fresh market data may restore executable authority — only a true durable
  // reload may.
  it('setPortfolioPolicy: durability is quarantined even from an already-blocked allocation, and a fresh reanalysis cannot lift it (RA-P2-02 blocked-state probe)', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    // Force the live allocation to a currently-blocked/non-executable state — imitating stale or
    // suppressed market/safety inputs — before the indeterminate write ever happens.
    created.store.setState({ allocationPlanStatus: 'blocked' })
    expect(created.store.getState().allocationPlanStatus).toBe('blocked')
    expect(created.store.getState().system.portfolioDurabilityStatus).toBeUndefined()

    vi.stubGlobal('localStorage', localStorageIndeterminateOnCanonicalWrite())
    const result = await created.store.getState().setPortfolioPolicy({ jpStockMaxRatio: 0.3 })
    expect(result).toMatchObject({ ok: false, code: 'MANUAL_PERSISTENCE_ERROR' })
    expect(created.store.getState().system.portfolioDurabilityStatus).toBe('INDETERMINATE')

    // Supply fresh/permissive inputs and run ordinary reanalysis WITHOUT a durable reload — still
    // blocked, no executable instrument, no executable BUY_NEW/ADD, no executable official trade.
    const reanalyzed = runFullAnalysis(created.store.getState(), { nowMs: NOW_MS })
    expect(reanalyzed.allocationPlanStatus).not.toBe('current')
    expect(reanalyzed.allocationPlan?.instrumentPlans.every(p => !p.executable) ?? true).toBe(true)
    expect(reanalyzed.officialDecision?.actions.every(a =>
      a.action !== 'BUY' && a.action !== 'SELL' && a.action !== 'BUY_NEW' && a.action !== 'ADD_EXISTING') ?? true).toBe(true)

    // Only a true verified reload/reconciliation may clear the quarantine.
    vi.stubGlobal('localStorage', localStorageMock)
    const reloaded = instance()
    await reloaded.store.getState().initialize()
    expect(reloaded.store.getState().system.portfolioDurabilityStatus).toBeUndefined()
    expect(reloaded.store.getState().portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
  })

  // refreshAllData: the audit's own explicitly-named reproduction path. An indeterminate
  // best-effort replacement write must quarantine whatever was live BEFORE the refresh started —
  // no publish happens on this failure path, so the pre-refresh state is what gets quarantined.
  it('refreshAllData: an indeterminate durable write quarantines the pre-refresh live state, with zero optimistic publish', async () => {
    const created = instance()
    const first = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(first).toMatchObject({ ok: true, code: 'SUCCESS' })
    const before = created.store.getState()
    expect(before.system.portfolioDurabilityStatus).toBeUndefined()

    vi.stubGlobal('localStorage', localStorageIndeterminateOnCanonicalWrite())
    const result = await created.store.getState().refreshAllData()
    expect(result.ok).toBe(false)
    const after = created.store.getState()
    expect(after.holdings).toBe(before.holdings)
    expect(after.trust).toBe(before.trust)
    expect(after.system.portfolioDurabilityStatus).toBe('INDETERMINATE')
  })

  // initialize: ticket section 20. A bootstrap whose own best-effort replacement write goes
  // indeterminate must never publish an optimistic generation — and since no publish happens at
  // all on this failure path, a quarantine already standing on a DIFFERENT already-running store
  // instance's live state is a separate concern (proven by the P2-06 duplicate-quarantine test
  // above); this proves initialize's own write failure is itself classified indeterminate and
  // quarantines whatever this fresh instance's (pre-publish) live state currently is.
  it('initialize: an indeterminate best-effort replacement write is quarantined, with zero optimistic publish', async () => {
    const created = instance()
    // Seed a legacy (non-canonical) durable generation so buildInitializeRestoredState's own
    // restore phase succeeds normally and initialize proceeds all the way to its own persistence
    // step (persistCurrentPortfolioGeneration's legacy-fallback branch).
    const seeded = await created.store.getState().updateHolding('9999', { eval: 75_000 })
    expect(seeded).toMatchObject({ ok: true })

    vi.stubGlobal('localStorage', localStorageIndeterminateOnNextWrite())
    const result = await created.store.getState().initialize()
    expect(result.ok).toBe(false)
    expect(created.store.getState().system.portfolioDurabilityStatus).toBe('INDETERMINATE')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R4-A — ticket section 8 test matrix (RA-P1-06 LEGACY WRITER repair)
// ═══════════════════════════════════════════════════════════════════════════

describe('importCsv: RA-P1-06 legacy writer blocked once a proven v6 COMPLETE generation exists', () => {
  it('a changed stock-only CSV via the legacy importCsv action is rejected, never downgrading a proven COMPLETE generation to legacy v5', async () => {
    const created = instance()
    const fullExport = await created.store.getState().importSbiPortfolioFullExport(csvFile(fullExportCsvLines()))
    expect(fullExport).toMatchObject({ ok: true, code: 'SUCCESS', authorityStatus: 'COMPLETE' })
    const before = created.store.getState()
    const generationBefore = restoreCsvImportGeneration()
    expect(generationBefore.status).toBe('committed')

    // Reproduce the audit case exactly: establish v6 COMPLETE, then directly invoke the
    // production importCsv action with a changed stock-only CSV and confirmUnknownProvenance=true.
    const legacyResult = await created.store.getState().importCsv(
      csvFile([STOCK_LABEL, STOCK_HEADER, '9999,テスト銘柄,1000,100000,1.00,0.10,2025-01-01', STOCK_TOTAL]),
      { confirmUnknownProvenance: true },
    )
    expect(legacyResult).toMatchObject({ ok: false, code: 'LEGACY_WRITER_BLOCKED' })

    // Durable schema remains v6, live authority remains COMPLETE, canonical generation and
    // holdings are byte/reference-unchanged — no downgrade, no mutation.
    const generationAfter = restoreCsvImportGeneration()
    expect(generationAfter.status).toBe('committed')
    if (generationAfter.status === 'committed') {
      expect(generationAfter.schemaVersion).toBe('csv-import-generation-6')
      expect(generationAfter.generationId).toBe(generationBefore.status === 'committed' ? generationBefore.generationId : null)
    }
    const after = created.store.getState()
    expect(after.portfolioImportAuthority.authorityStatus).toBe('COMPLETE')
    expect(after.portfolioImportAuthority).toBe(before.portfolioImportAuthority)
    expect(after.holdings).toBe(before.holdings)
    expect(after.holdings.some(h => h.code === '9999')).toBe(false)
  })

  it('legacy importCsv still functions normally when no COMPLETE v6 generation exists (LEGACY_UNPROVEN destination)', async () => {
    const created = instance()
    expect(created.store.getState().portfolioImportAuthority.authorityStatus).toBe('LEGACY_UNPROVEN')
    const legacyResult = await created.store.getState().importCsv(
      csvFile([STOCK_LABEL, STOCK_HEADER, '9999,テスト銘柄,1000,100000,1.00,0.10,2025-01-01', STOCK_TOTAL]),
    )
    expect(legacyResult).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(created.store.getState().holdings.some(h => h.code === '9999')).toBe(true)
  })
})
