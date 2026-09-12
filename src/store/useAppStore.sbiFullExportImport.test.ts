import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding } from '../types'
import { CSV_IMPORT_GENERATION_KEY, restoreCsvImportGeneration } from './persist'
import type { PortfolioGenerationLockAdapter } from './portfolioGenerationLock'
import { createAppStoreInstanceForTest } from './useAppStore'

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
