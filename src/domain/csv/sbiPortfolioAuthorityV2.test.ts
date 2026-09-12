import { describe, expect, it } from 'vitest'
import type { Trust } from '../../types'
import { parseSbiPortfolioImportV2 } from './sbiPortfolioImportV2'
import {
  resolveTrustRows,
  evaluateFinalFullExportAuthority,
  buildCompleteFullExportAuthority,
  buildFullExportStagedDiff,
  type TrustRowResolutionResult,
} from './sbiPortfolioAuthorityV2'

// OPS-SBI-P2-PREBUILD-PHASE2-STORE-AUTHORITY
// Synthetic-fixture-only (no real SBI export data — same privacy discipline as Phase 1).

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

function fullExportCsv(trustTaxableRows: string[] = []): string {
  return [
    STOCK_LABEL, STOCK_HEADER,
    '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
    STOCK_TOTAL,
    TRUST_TAXABLE_LABEL, TRUST_HEADER,
    ...trustTaxableRows,
    TRUST_TAXABLE_TOTAL,
    ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
    ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
  ].join('\n')
}

function makeFund(overrides: Partial<Trust> & { id: string }): Trust {
  return {
    name: overrides.id, abbr: overrides.id, account: '特定', policy: 'JAPAN_SHORTTERM',
    eval: 0, pnlPct: 0, dayPct: 0, cost: 0.1, mu: 0.1, sigma: 0.15, score: 0, signal: 'HOLD', ev: 0, decision: 'HOLD',
    ...overrides,
  }
}

const ALIASES = { sp500_sbi: ['SBI・V・S&P500インデックス・ファンド'] } as const

describe('resolveTrustRows', () => {
  it('RESOLVED via exact id match', () => {
    // The registered SBI trust column schemas never carry a fund-code cell (code fieldIndex is
    // always -1 — see TRUST_SCHEMAS in sbiPortfolioImportV2.ts), so this path is forward
    // compatibility only; exercise it directly against a hand-built provisional row.
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const row = { sectionId: 'TRUST_TAXABLE' as const, accountHint: '特定', name: '無関係の表示名', code: 'sp500_sbi', eval: 4500000, price: 26000, pnlPct: 95.5, dayPct: -1.8, acquiredAt: null }
    const result = resolveTrustRows([row], registry, {})
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('RESOLVED')
    expect(result[0].matchedTrustId).toBe('sp500_sbi')
  })

  it('RESOLVED via exact alias match', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['SBI・V・S&P500インデックス・ファンド,26000,4500000,95.50,-1.80,']))
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const result = resolveTrustRows(parsed.provisionalTrustRows, registry, ALIASES)
    expect(result[0].status).toBe('RESOLVED')
    expect(result[0].matchedTrustId).toBe('sp500_sbi')
  })

  it('RESOLVED via exact canonical name match', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['SBI V S&P500,26000,4500000,95.50,-1.80,']))
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const result = resolveTrustRows(parsed.provisionalTrustRows, registry, {})
    expect(result[0].status).toBe('RESOLVED')
  })

  it('UNKNOWN_TRUST when no registry entry matches by id/alias/name', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['謎のファンド,26000,4500000,95.50,-1.80,']))
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const result = resolveTrustRows(parsed.provisionalTrustRows, registry, {})
    expect(result[0].status).toBe('UNKNOWN_TRUST')
    expect(result[0].matchedTrustId).toBeNull()
  })

  it('ACCOUNT_MISMATCH when identity matches but account differs', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['SBI V S&P500,26000,4500000,95.50,-1.80,']))
    const registry = [makeFund({ id: 'sp500_nisa', name: 'SBI V S&P500', account: 'NISA成長' })]
    const result = resolveTrustRows(parsed.provisionalTrustRows, registry, {})
    expect(result[0].status).toBe('ACCOUNT_MISMATCH')
  })

  it('AMBIGUOUS_TRUST when two CSV rows collide on the same registry id', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv([
      'SBI V S&P500,26000,2000000,10.0,0.0,',
      'SBI V S&P500,26000,2500000,10.0,0.0,',
    ]))
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const result = resolveTrustRows(parsed.provisionalTrustRows, registry, {})
    expect(result).toHaveLength(2)
    expect(result.every(r => r.status === 'AMBIGUOUS_TRUST')).toBe(true)
  })

  it('TRUST_REGISTRY_MISS when the registry is empty', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['SBI V S&P500,26000,4500000,95.50,-1.80,']))
    const result = resolveTrustRows(parsed.provisionalTrustRows, [], {})
    expect(result[0].status).toBe('TRUST_REGISTRY_MISS')
  })

  it('never fuzzy/substring-matches an unregistered similar name', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['SBI V S&P500 Plus,26000,4500000,95.50,-1.80,']))
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const result = resolveTrustRows(parsed.provisionalTrustRows, registry, {})
    expect(result[0].status).toBe('UNKNOWN_TRUST')
  })
})

describe('evaluateFinalFullExportAuthority', () => {
  it('PASS when structural completeness passes and every trust row resolves', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['SBI V S&P500,26000,4500000,95.50,-1.80,']))
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const resolutions = resolveTrustRows(parsed.provisionalTrustRows, registry, {})
    expect(evaluateFinalFullExportAuthority(parsed, resolutions)).toEqual({ status: 'PASS' })
  })

  it('PASS with zero trust rows and an empty registry (no trust to resolve)', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv())
    const resolutions = resolveTrustRows(parsed.provisionalTrustRows, [], {})
    expect(resolutions).toHaveLength(0)
    expect(evaluateFinalFullExportAuthority(parsed, resolutions)).toEqual({ status: 'PASS' })
  })

  it('FAIL preserves Stage A structural reasons (missing section) independent of trust', () => {
    const csv = [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL].join('\n')
    const parsed = parseSbiPortfolioImportV2(csv)
    const resolutions = resolveTrustRows(parsed.provisionalTrustRows, [], {})
    const result = evaluateFinalFullExportAuthority(parsed, resolutions)
    expect(result.status).toBe('FAIL')
    if (result.status === 'FAIL') {
      expect(result.reasons).toContain('EXPECTED_SECTION_ABSENT')
      expect(result.reasons).not.toContain('TRUST_REGISTRY_MISS')
    }
  })

  it('FAIL adds UNKNOWN_TRUST when a trust row does not resolve, even if structurally complete', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(['謎のファンド,26000,4500000,95.50,-1.80,']))
    const registry = [makeFund({ id: 'sp500_sbi', name: 'SBI V S&P500' })]
    const resolutions = resolveTrustRows(parsed.provisionalTrustRows, registry, {})
    const result = evaluateFinalFullExportAuthority(parsed, resolutions)
    expect(result).toEqual({ status: 'FAIL', reasons: ['UNKNOWN_TRUST'] })
  })

  it('NOT_APPLICABLE for PARTIAL_IMPORT mode', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv(), { mode: 'PARTIAL_IMPORT', selectedAssetClasses: ['JP_STOCK'] })
    expect(evaluateFinalFullExportAuthority(parsed, [])).toEqual({ status: 'NOT_APPLICABLE' })
  })
})

describe('buildCompleteFullExportAuthority', () => {
  it('builds a COMPLETE authority object carrying section completeness', () => {
    const parsed = parseSbiPortfolioImportV2(fullExportCsv())
    const authority = buildCompleteFullExportAuthority(parsed)
    expect(authority.authorityStatus).toBe('COMPLETE')
    expect(authority.importMode).toBe('FULL_EXPORT')
    expect(authority.provenanceScope).toBe('FULL_EXPORT')
    expect(authority.sectionCompleteness).toHaveLength(4)
    expect(authority.sectionCompleteness.every(entry => entry.status === 'VALID_NONEMPTY' || entry.status === 'VALID_EMPTY')).toBe(true)
  })
})

describe('buildFullExportStagedDiff', () => {
  const baseTrustResolutions: TrustRowResolutionResult[] = []

  it('classifies add/update/remove for stock and update/zero for trust', () => {
    const diff = buildFullExportStagedDiff({
      provisionalStockRows: [
        { sectionId: 'JP_STOCK_CUSTODY', code: '6501', name: '日立製作所', eval: 900000, price: 8500, pnlPct: 15.2, dayPct: 1.1, acquiredAt: '2025-06-01' },
        { sectionId: 'JP_STOCK_CUSTODY', code: '7203', name: 'トヨタ自動車', eval: 500000, price: 3000, pnlPct: 5, dayPct: 0.5, acquiredAt: null },
      ],
      trustRowResolutions: [
        { row: { sectionId: 'TRUST_TAXABLE', accountHint: '特定', name: 'SBI V S&P500', code: '', eval: 4500000, price: 26000, pnlPct: 95.5, dayPct: -1.8, acquiredAt: null }, status: 'RESOLVED', matchedTrustId: 'sp500_sbi' },
      ],
      currentHoldingCodes: ['6501', '9999'],
      currentTrust: [{ id: 'sp500_sbi', eval: 0 }, { id: 'gold_mufg', eval: 100000 }],
      removalRatioThreshold: 0.5,
      removalAbsoluteCap: 5,
    })
    expect(diff.stock.add.map(r => r.code)).toEqual(['7203'])
    expect(diff.stock.update.map(r => r.code)).toEqual(['6501'])
    expect(diff.stock.remove).toEqual(['9999'])
    expect(diff.trust.update).toEqual([{ id: 'sp500_sbi', eval: 4500000, pnlPct: 95.5, dayPct: -1.8 }])
    expect(diff.trust.zero).toEqual(['gold_mufg'])
  })

  it('flags destructive when removal ratio exceeds threshold', () => {
    const diff = buildFullExportStagedDiff({
      provisionalStockRows: [{ sectionId: 'JP_STOCK_CUSTODY', code: '6501', name: 'A', eval: 100, price: 0, pnlPct: 0, dayPct: 0, acquiredAt: null }],
      trustRowResolutions: baseTrustResolutions,
      currentHoldingCodes: ['1', '2', '3'],
      currentTrust: [],
      removalRatioThreshold: 0.5,
      removalAbsoluteCap: 5,
    })
    expect(diff.removedStockCount).toBe(3)
    expect(diff.removedStockRatio).toBe(1)
    expect(diff.destructive).toBe(true)
  })

  it('flags destructive when absolute removal count exceeds the cap even under the ratio threshold', () => {
    const currentHoldingCodes = Array.from({ length: 20 }, (_, i) => `code${i}`)
    const diff = buildFullExportStagedDiff({
      provisionalStockRows: currentHoldingCodes.slice(0, 14).map(code => ({ sectionId: 'JP_STOCK_CUSTODY' as const, code, name: code, eval: 100, price: 0, pnlPct: 0, dayPct: 0, acquiredAt: null })),
      trustRowResolutions: baseTrustResolutions,
      currentHoldingCodes,
      currentTrust: [],
      removalRatioThreshold: 0.5,
      removalAbsoluteCap: 5,
    })
    expect(diff.removedStockCount).toBe(6)
    expect(diff.removedStockRatio).toBeCloseTo(0.3)
    expect(diff.destructive).toBe(true)
  })

  it('is not destructive for an ordinary small change', () => {
    const diff = buildFullExportStagedDiff({
      provisionalStockRows: [{ sectionId: 'JP_STOCK_CUSTODY', code: '6501', name: 'A', eval: 100, price: 0, pnlPct: 0, dayPct: 0, acquiredAt: null }],
      trustRowResolutions: baseTrustResolutions,
      currentHoldingCodes: ['6501'],
      currentTrust: [],
      removalRatioThreshold: 0.5,
      removalAbsoluteCap: 5,
    })
    expect(diff.destructive).toBe(false)
  })
})
