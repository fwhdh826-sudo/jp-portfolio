import { describe, expect, it } from 'vitest'
import {
  parseSbiPortfolioImportV2,
  evaluateFullExportCompleteness,
  SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION,
  SBI_PORTFOLIO_PROFILE_ID,
  type RequiredSectionId,
} from './sbiPortfolioImportV2'

// OPS-SBI-P2-PREBUILD-PHASE1-PARSER-COMPLETENESS
//
// This is a synthetic-fixture-only test suite (no real SBI export data — see the
// ticket's privacy rule). Every fixture below is fabricated to exercise one specific
// structural rule of the frozen Phase 1 contract in sbiPortfolioImportV2.ts.
//
// No fixture uses a "合計" totals-header/value block unless the test is specifically
// about totals reconciliation (test 10): the closing boundary line alone is sufficient
// to close a section per this contract (see the module's own comments on why the
// 2-line totals block is treated as optional bonus evidence, not a required part of
// "recognized matching 合計/end boundary").

const STOCK_HEADER = '銘柄コード,銘柄名,現在値,評価額,損益（％）,前日比（％）,取得日'
const STOCK_HEADER_SANITIZED = '評価額,銘柄名,前日比（％）,銘柄コード,損益（％）,取得日,現在値'
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

describe('sbiPortfolioImportV2: contract identity', () => {
  it('exposes the frozen contract version and profile id', () => {
    expect(SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION).toBe('sbi-portfolio-import-2')
    const result = parseSbiPortfolioImportV2([STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL].join('\n'))
    expect(result.contractVersion).toBe('sbi-portfolio-import-2')
    expect(result.profileId).toBe(SBI_PORTFOLIO_PROFILE_ID)
  })
})

// Test 1
describe('sbiPortfolioImportV2: complete stock + all expected trust sections', () => {
  it('every required section reaches an explicit VALID_* status', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      TRUST_TAXABLE_LABEL, TRUST_HEADER,
      'SBI・V・S&P500,26000,4500000,95.50,-1.80,',
      TRUST_TAXABLE_TOTAL,
      TRUST_GROWTH_LABEL, TRUST_HEADER,
      '三菱UFJ純金ファンド,20000,110000,-0.50,0.30,',
      TRUST_GROWTH_TOTAL,
      TRUST_TSUMITATE_LABEL, TRUST_HEADER,
      'eMAXIS Slim全世界株式,15000,300000,3.20,-0.50,',
      TRUST_TSUMITATE_TOTAL,
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('VALID_NONEMPTY')
    expect(result.sections.TRUST_TAXABLE.status).toBe('VALID_NONEMPTY')
    expect(result.sections.TRUST_NISA_GROWTH.status).toBe('VALID_NONEMPTY')
    expect(result.sections.TRUST_NISA_ACCUMULATION.status).toBe('VALID_NONEMPTY')
    for (const id of Object.keys(result.sections) as RequiredSectionId[]) {
      expect(result.sections[id].rejectedPositionRowCount).toBe(0)
    }
  })
})

// Test 2
describe('sbiPortfolioImportV2: structurally empty trust section', () => {
  it('registered section + valid header + zero rows + boundary → VALID_EMPTY', () => {
    const csv = emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL).join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('VALID_EMPTY')
    expect(result.sections.TRUST_TAXABLE.positionRowCount).toBe(0)
    expect(result.sections.TRUST_TAXABLE.schemaId).toBe('trust-canonical-v1')
  })
})

// Test 3
describe('sbiPortfolioImportV2: trust section entirely absent', () => {
  it('ABSENT (never confused with VALID_EMPTY) and FULL_EXPORT completeness FAILs', () => {
    const csv = [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('ABSENT')
    expect(result.sections.TRUST_NISA_GROWTH.status).toBe('ABSENT')
    expect(result.sections.TRUST_NISA_ACCUMULATION.status).toBe('ABSENT')
    expect(result.completeness).toEqual({ status: 'FAIL', reasons: ['EXPECTED_SECTION_ABSENT'] })
  })
})

// Test 4
describe('sbiPortfolioImportV2: renamed/unregistered trust header', () => {
  it('is a section/profile failure, never VALID_EMPTY', () => {
    const csv = [
      TRUST_TAXABLE_LABEL,
      'ファンド名称,基準価額,評価額,損益（％）,前日比（％）,取得日', // renamed column, not a registered schema
      TRUST_TAXABLE_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('PARSE_FAILED')
    expect(result.sections.TRUST_TAXABLE.status).not.toBe('VALID_EMPTY')
    expect(result.sections.TRUST_TAXABLE.schemaId).toBeNull()
    expect(result.sections.TRUST_TAXABLE.failureReasons).toContain('SCHEMA_UNRECOGNIZED')
  })
})

// Test 5
describe('sbiPortfolioImportV2: recognized trust section + malformed position row', () => {
  it('PARSE_FAILED, not a silently dropped row', () => {
    const csv = [
      TRUST_TAXABLE_LABEL, TRUST_HEADER,
      'SBI・V・S&P500,26000,N/A,95.50,-1.80,',
      TRUST_TAXABLE_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('PARSE_FAILED')
    expect(result.sections.TRUST_TAXABLE.rejectedPositionRowCount).toBe(1)
    expect(result.sections.TRUST_TAXABLE.acceptedRowCount).toBe(0)
    const rejected = result.rowDiagnostics.find(row => row.kind === 'rejectedPosition' && row.sectionId === 'TRUST_TAXABLE')
    expect(rejected?.rejectionReason).toBe('INVALID_EVAL_MALFORMED')
  })
})

// Test 6
describe('sbiPortfolioImportV2: recognized stock section + malformed position row', () => {
  it('PARSE_FAILED, not a silently dropped row', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,N/A,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.rejectedPositionRowCount).toBe(1)
    const rejected = result.rowDiagnostics.find(row => row.kind === 'rejectedPosition' && row.sectionId === 'JP_STOCK_CUSTODY')
    expect(rejected?.rejectionReason).toBe('INVALID_EVAL_MALFORMED')
  })
})

// Test 7
describe('sbiPortfolioImportV2: empty file', () => {
  it('completeness FAILs with EMPTY_FILE', () => {
    const result = parseSbiPortfolioImportV2('')
    expect(result.parsed).toBe(false)
    expect(result.profileId).toBeNull()
    expect(result.completeness).toEqual({ status: 'FAIL', reasons: ['EMPTY_FILE'] })
    for (const id of Object.keys(result.sections) as RequiredSectionId[]) {
      expect(result.sections[id].status).toBe('ABSENT')
    }
  })

  it('whitespace-only content is also EMPTY_FILE, not ZERO_STRUCTURAL_SECTIONS', () => {
    const result = parseSbiPortfolioImportV2('   \n\t\n  ')
    expect(result.completeness).toEqual({ status: 'FAIL', reasons: ['EMPTY_FILE'] })
  })
})

// Test 8
describe('sbiPortfolioImportV2: no structural sections', () => {
  it('completeness FAILs with ZERO_STRUCTURAL_SECTIONS', () => {
    const csv = ['これはCSVではありません', '何もセクションがありません'].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.parsed).toBe(false)
    expect(result.profileId).toBeNull()
    expect(result.completeness).toEqual({ status: 'FAIL', reasons: ['ZERO_STRUCTURAL_SECTIONS'] })
  })
})

// Test 9
describe('sbiPortfolioImportV2: recognized header reaches EOF without its boundary', () => {
  it('is SECTION_TRUNCATED / PARSE_FAILED, never VALID_EMPTY or VALID_NONEMPTY', () => {
    const csv = [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01'].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('TRUNCATED')
    // the row seen before truncation is still counted as evidence, never discarded
    expect(result.sections.JP_STOCK_CUSTODY.acceptedRowCount).toBe(1)
    expect(result.completeness).toMatchObject({ status: 'FAIL' })
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('SECTION_TRUNCATED')
      expect(result.completeness.reasons).toContain('SECTION_PARSE_FAILED')
    }
  })
})

// Test 10
describe('sbiPortfolioImportV2: known totals/footer lines', () => {
  it('a reconciling totals block and the grand total footer are classified, never rejected', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
      '7203,トヨタ自動車,3000,300000,5.00,0.50,2025-07-01',
      STOCK_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,',
      '600000,6000,1.00,600,0.10,',
      '総合計',
      '600000,6000,1.00,600,0.10,',
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('VALID_NONEMPTY')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).not.toContain('TOTAL_MISMATCH')

    const kinds = result.rowDiagnostics.map(row => row.kind)
    expect(kinds.filter(kind => kind === 'sectionTotal').length).toBeGreaterThanOrEqual(2)
    expect(kinds.filter(kind => kind === 'grandTotalFooter').length).toBe(2)
    expect(kinds).not.toContain('rejectedPosition')
  })

  it('a totals block that does not reconcile with accepted rows flips the section to PARSE_FAILED', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,',
      '999999,6000,1.00,600,0.10,', // does not match accepted sum (300000)
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('TOTAL_MISMATCH')
  })
})

// Test 11 + 12
describe('sbiPortfolioImportV2: numeric authority — malformed vs. genuine zero', () => {
  it('blank and malformed authoritative eval cells become rejected rows, never a silent zero', () => {
    const csv = [
      TRUST_TAXABLE_LABEL, TRUST_HEADER,
      'ファンドA,10000,,1.00,0.10,', // blank eval
      'ファンドB,10000,abc,1.00,0.10,', // malformed eval
      TRUST_TAXABLE_TOTAL,
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.rejectedPositionRowCount).toBe(2)
    expect(result.sections.TRUST_TAXABLE.acceptedRowCount).toBe(0)
    const reasons = result.rowDiagnostics
      .filter(row => row.kind === 'rejectedPosition' && row.sectionId === 'TRUST_TAXABLE')
      .map(row => row.rejectionReason)
    expect(reasons).toEqual(['INVALID_EVAL_BLANK', 'INVALID_EVAL_MALFORMED'])
  })

  it('a genuine numeric zero is accepted and distinguishable from a malformed value', () => {
    const csv = [
      TRUST_TAXABLE_LABEL, TRUST_HEADER,
      'ファンドC,10000,0,0.00,0.00,',
      TRUST_TAXABLE_TOTAL,
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('VALID_NONEMPTY')
    expect(result.sections.TRUST_TAXABLE.acceptedRowCount).toBe(1)
    expect(result.sections.TRUST_TAXABLE.rejectedPositionRowCount).toBe(0)
    const accepted = result.rowDiagnostics.find(row => row.kind === 'acceptedPosition' && row.sectionId === 'TRUST_TAXABLE')
    expect(accepted).toBeDefined()
    expect(result.provisionalTrustRows[0]).toMatchObject({ name: 'ファンドC', eval: 0 })
  })
})

// Test 13
describe('sbiPortfolioImportV2: unsupported non-empty position-bearing section', () => {
  it('blocks FULL_EXPORT completeness even when all four required sections are otherwise valid', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
      '株式（信用/一般売り）',
      STOCK_HEADER,
      '9999,信用銘柄,1000,50000,0,0,',
      '株式（信用/一般売り）合計',
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.unsupportedSections).toEqual([
      { label: '株式(信用/一般売り)', assetType: 'stock', recognizedButOutOfScope: true, nonEmpty: true, rowCount: 1 },
    ])
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNSUPPORTED_POSITION_SECTION')
    }
  })

  it('an empty unsupported section does not block completeness by itself', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
      '株式（信用/一般売り）',
      STOCK_HEADER,
      '株式（信用/一般売り）合計',
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.unsupportedSections[0]).toMatchObject({ nonEmpty: false })
    expect(result.completeness).toEqual({ status: 'PASS' })
  })

  it('a wholly unrecognized (non-credit) position-bearing section is UNKNOWN_POSITION_SECTION, not UNSUPPORTED', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '投資信託（外貨/特定預り）',
      TRUST_HEADER,
      '謎のファンド,10000,50000,0,0,',
      '投資信託（外貨/特定預り）合計',
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.unsupportedSections[0]).toMatchObject({ recognizedButOutOfScope: false, nonEmpty: true })
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNKNOWN_POSITION_SECTION')
      expect(result.completeness.reasons).not.toContain('UNSUPPORTED_POSITION_SECTION')
    }
  })
})

// Test 14
describe('sbiPortfolioImportV2: column reorder supported by an explicitly registered schema', () => {
  it('reaches FULL_EXPORT completeness PASS', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER_SANITIZED,
      '900000,日立製作所,1.10,6501,15.20,2025-06-01,8500',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.schemaId).toBe('stock-sanitized-current-v1')
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('VALID_NONEMPTY')
    expect(result.completeness).toEqual({ status: 'PASS' })
  })
})

// Test 15
describe('sbiPortfolioImportV2: unregistered arbitrary column reorder', () => {
  it('fails rather than being fuzzily accepted', () => {
    const csv = [
      STOCK_LABEL,
      '銘柄名,銘柄コード,評価額,現在値,取得日,損益（％）,前日比（％）', // not a registered schema
      '日立製作所,6501,900000,8500,2025-06-01,15.20,1.10',
      STOCK_TOTAL,
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.schemaId).toBeNull()
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('SCHEMA_UNRECOGNIZED')
  })
})

// Test 16
describe('sbiPortfolioImportV2: FULL_EXPORT never auto-downgrades to PARTIAL_IMPORT', () => {
  it('a failing FULL_EXPORT stays FULL_EXPORT with a FAIL completeness, never NOT_APPLICABLE', () => {
    const csv = [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.mode).toBe('FULL_EXPORT')
    expect(result.completeness.status).toBe('FAIL')
  })
})

// Test 17
describe('sbiPortfolioImportV2: PARTIAL_IMPORT with explicitly selected classes', () => {
  it('validates the selected section structurally while whole-portfolio completeness stays non-authoritative', () => {
    const csv = [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL].join('\n')
    const result = parseSbiPortfolioImportV2(csv, { mode: 'PARTIAL_IMPORT', selectedAssetClasses: ['JP_STOCK'] })
    expect(result.mode).toBe('PARTIAL_IMPORT')
    expect(result.selectedAssetClasses).toEqual(['JP_STOCK'])
    expect(result.completeness).toEqual({ status: 'NOT_APPLICABLE' })
    // still strictly validated structurally, even though it's not a FULL_EXPORT
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('VALID_NONEMPTY')
    // unselected classes' absence is not treated as proving anything (no completeness FAIL is even computed)
    expect(result.sections.TRUST_TAXABLE.status).toBe('ABSENT')
  })

  it('throws when PARTIAL_IMPORT is requested without explicit selectedAssetClasses', () => {
    expect(() => parseSbiPortfolioImportV2('irrelevant', { mode: 'PARTIAL_IMPORT' })).toThrow()
    expect(() => parseSbiPortfolioImportV2('irrelevant', { mode: 'PARTIAL_IMPORT', selectedAssetClasses: [] })).toThrow()
  })
})

// Test 18
describe('sbiPortfolioImportV2: section diagnostic counts reconcile', () => {
  it('positionRowCount === acceptedRowCount + rejectedPositionRowCount for every section, in every fixture', () => {
    const fixtures = [
      [STOCK_LABEL, STOCK_HEADER, '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', STOCK_TOTAL].join('\n'),
      [TRUST_TAXABLE_LABEL, TRUST_HEADER, 'ファンドA,10000,,1.00,0.10,', 'ファンドB,10000,20000,1.00,0.10,', TRUST_TAXABLE_TOTAL].join('\n'),
      emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL).join('\n'),
      '',
    ]
    for (const csv of fixtures) {
      const result = parseSbiPortfolioImportV2(csv)
      for (const id of Object.keys(result.sections) as RequiredSectionId[]) {
        const section = result.sections[id]
        expect(section.positionRowCount).toBe(section.acceptedRowCount + section.rejectedPositionRowCount)
      }
    }
  })
})

describe('sbiPortfolioImportV2: evaluateFullExportCompleteness is independently callable as a pure function', () => {
  it('PASSes a hand-built fully-valid draft with no registry-dependent trust rows', () => {
    const draft = {
      contractVersion: SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION,
      profileId: SBI_PORTFOLIO_PROFILE_ID,
      mode: 'FULL_EXPORT' as const,
      selectedAssetClasses: null,
      parsed: true,
      sections: {
        JP_STOCK_CUSTODY: { id: 'JP_STOCK_CUSTODY' as const, status: 'VALID_NONEMPTY' as const, schemaId: 'stock-canonical-v1', positionRowCount: 1, acceptedRowCount: 1, rejectedPositionRowCount: 0, failureReasons: [] },
        TRUST_TAXABLE: { id: 'TRUST_TAXABLE' as const, status: 'VALID_EMPTY' as const, schemaId: 'trust-canonical-v1', positionRowCount: 0, acceptedRowCount: 0, rejectedPositionRowCount: 0, failureReasons: [] },
        TRUST_NISA_GROWTH: { id: 'TRUST_NISA_GROWTH' as const, status: 'VALID_EMPTY' as const, schemaId: 'trust-canonical-v1', positionRowCount: 0, acceptedRowCount: 0, rejectedPositionRowCount: 0, failureReasons: [] },
        TRUST_NISA_ACCUMULATION: { id: 'TRUST_NISA_ACCUMULATION' as const, status: 'VALID_EMPTY' as const, schemaId: 'trust-canonical-v1', positionRowCount: 0, acceptedRowCount: 0, rejectedPositionRowCount: 0, failureReasons: [] },
      },
      unsupportedSections: [],
      rowDiagnostics: [],
      orphanPositionRowCount: 0,
      unknownPreambleLineCount: 0,
      grandTotalTruncated: false,
      grandTotalInvalid: false,
      trustResolution: 'NOT_APPLICABLE' as const,
      provisionalTrustRows: [],
      provisionalStockRows: [],
      provenance: { explicitSourceTimestamp: { status: 'absent' as const } },
    }
    expect(evaluateFullExportCompleteness(draft)).toEqual({ status: 'PASS' })
  })

  it('never invents a PASS when trust resolution is required but unavailable to this layer', () => {
    const draft = {
      contractVersion: SBI_PORTFOLIO_IMPORT_CONTRACT_VERSION,
      profileId: SBI_PORTFOLIO_PROFILE_ID,
      mode: 'FULL_EXPORT' as const,
      selectedAssetClasses: null,
      parsed: true,
      sections: {
        JP_STOCK_CUSTODY: { id: 'JP_STOCK_CUSTODY' as const, status: 'VALID_NONEMPTY' as const, schemaId: 'stock-canonical-v1', positionRowCount: 1, acceptedRowCount: 1, rejectedPositionRowCount: 0, failureReasons: [] },
        TRUST_TAXABLE: { id: 'TRUST_TAXABLE' as const, status: 'VALID_NONEMPTY' as const, schemaId: 'trust-canonical-v1', positionRowCount: 1, acceptedRowCount: 1, rejectedPositionRowCount: 0, failureReasons: [] },
        TRUST_NISA_GROWTH: { id: 'TRUST_NISA_GROWTH' as const, status: 'VALID_EMPTY' as const, schemaId: 'trust-canonical-v1', positionRowCount: 0, acceptedRowCount: 0, rejectedPositionRowCount: 0, failureReasons: [] },
        TRUST_NISA_ACCUMULATION: { id: 'TRUST_NISA_ACCUMULATION' as const, status: 'VALID_EMPTY' as const, schemaId: 'trust-canonical-v1', positionRowCount: 0, acceptedRowCount: 0, rejectedPositionRowCount: 0, failureReasons: [] },
      },
      unsupportedSections: [],
      rowDiagnostics: [],
      orphanPositionRowCount: 0,
      unknownPreambleLineCount: 0,
      grandTotalTruncated: false,
      grandTotalInvalid: false,
      trustResolution: 'STRUCTURALLY_VALID_BUT_TRUST_RESOLUTION_REQUIRED' as const,
      provisionalTrustRows: [{ sectionId: 'TRUST_TAXABLE' as const, accountHint: '特定', name: 'テスト', code: '', eval: 100, price: 0, pnlPct: 0, dayPct: 0, acquiredAt: null }],
      provisionalStockRows: [],
      provenance: { explicitSourceTimestamp: { status: 'absent' as const } },
    }
    expect(evaluateFullExportCompleteness(draft)).toEqual({ status: 'FAIL', reasons: ['TRUST_REGISTRY_MISS'] })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R2-A — ticket section 26 test matrix (P1-02/P2-01 repair)
// ═══════════════════════════════════════════════════════════════════════════

describe('sbiPortfolioImportV2: duplicate required section (P1-02)', () => {
  it('a required section label appearing twice fails, never overwritten by the second occurrence', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      STOCK_LABEL, STOCK_HEADER, // duplicate occurrence of the same required section
      '7203,トヨタ自動車,3000,300000,5.00,0.50,2025-07-01',
      STOCK_TOTAL,
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('DUPLICATE_REQUIRED_SECTION')
    expect(result.completeness).toMatchObject({ status: 'FAIL' })
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('SECTION_DUPLICATE_REQUIRED')
    }
    // the FIRST occurrence's evidence is preserved, never overwritten by the duplicate's rows
    expect(result.sections.JP_STOCK_CUSTODY.acceptedRowCount).toBe(1)
    expect(result.provisionalStockRows).toHaveLength(1)
    expect(result.provisionalStockRows[0].code).toBe('6501')
  })

  it('an early malformed occurrence followed by a well-formed duplicate never upgrades to VALID_NONEMPTY', () => {
    const csv = [
      STOCK_LABEL,
      '銘柄名,銘柄コード,評価額,現在値,取得日,損益（％）,前日比（％）', // unregistered schema — first occurrence fails
      '日立製作所,6501,900000,8500,2025-06-01,15.20,1.10',
      STOCK_TOTAL,
      STOCK_LABEL, STOCK_HEADER, // second, well-formed occurrence
      '7203,トヨタ自動車,3000,300000,5.00,0.50,2025-07-01',
      STOCK_TOTAL,
    ].join('\n')

    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('SCHEMA_UNRECOGNIZED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('DUPLICATE_REQUIRED_SECTION')
    expect(result.completeness.status).toBe('FAIL')
  })

  it('duplicate rows are consumed as duplicateSectionRow diagnostics, never as orphan/unexplained positions', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      STOCK_LABEL, STOCK_HEADER,
      '7203,トヨタ自動車,3000,300000,5.00,0.50,2025-07-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.rowDiagnostics.some(row => row.kind === 'duplicateSectionRow')).toBe(true)
  })
})

describe('sbiPortfolioImportV2: position-looking preamble row (P1-02)', () => {
  it('a position-shaped row before the first structural section fails FULL_EXPORT', () => {
    const csv = [
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01', // position-looking, but no section is open yet
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  it('an exact registered report title is tolerated as harmless informational content', () => {
    const csv = [
      'ポートフォリオ一覧',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.completeness).toEqual({ status: 'PASS' })
  })

  // OPS-SBI-P2-PREBUILD-PHASE2-R4-A (P1-02 STRICT PREAMBLE CLASSIFICATION): the frozen root
  // cause this closes — an arbitrary line was previously inferred "safe" merely because it
  // failed a loose position-looking heuristic. An arbitrary free-form note is not a registered
  // signature and must now fail FULL_EXPORT, distinct from (and never silently merged into)
  // UNEXPLAINED_POSITION_ROW.
  it('an arbitrary free-form note line (not a registered signature) fails FULL_EXPORT', () => {
    const csv = [
      'これはメモです', // arbitrary non-position informational text, no digit anywhere
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.unknownPreambleLineCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNKNOWN_PREAMBLE_LINE')
      expect(result.completeness.reasons).not.toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  // Independent audit reproduction: a blank FIRST cell with real numeric data in a later cell
  // must never be classified as a harmless blank/comma-noise line — it is exactly as
  // position-shaped as any ordinary row and must fail the same way.
  it('a blank-first-cell comma-heavy row fails FULL_EXPORT (independent audit repro)', () => {
    const csv = [
      ',900000,100,200',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  // Independent audit reproduction: arbitrary text glued directly onto a registered
  // count/page-range label (no separator) must never be accepted via a loose `startsWith`
  // match — only the exact label or "label：value"/"label:value" is a registered signature.
  it('a fake-prefix line glued onto a registered count label fails FULL_EXPORT (independent audit repro)', () => {
    const csv = [
      '総件数FAKE,900000,100',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  it('a registered count label followed by an exact colon-separated value is tolerated', () => {
    const csv = [
      '総件数：150件',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.unknownPreambleLineCount).toBe(0)
    expect(result.completeness).toEqual({ status: 'PASS' })
  })

  it('a known metadata-timestamp preamble line (データ基準日時) is never misclassified as a position row', () => {
    const csv = [
      'データ基準日時,2026-09-10T00:00:00+09:00',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.completeness).toEqual({ status: 'PASS' })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // OPS-SBI-P2-PREBUILD-PHASE2-R5-A — ticket section 10 P1 production test matrix
  // (RA-P1-01 CLOSURE: row-level, not label-level, preamble contract)
  // ═══════════════════════════════════════════════════════════════════════════

  // Independent re-audit reproduction (RA-P1-01): a colon-separated registered count label with
  // arbitrary glued-on text AND extra trailing columns must never pass merely because the label
  // prefix (with its separator) matches — the whole row's column count is part of the contract.
  it('a registered count label with a half-width colon and extra trailing columns fails FULL_EXPORT (RA-P1-01 repro)', () => {
    const csv = [
      '総件数:FAKE,900000,100',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  it('a registered count label with a full-width colon and extra trailing columns fails FULL_EXPORT (RA-P1-01 repro)', () => {
    const csv = [
      '総件数：FAKE,900000,100',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  // Independent re-audit reproduction (RA-P1-01, ticket section 7): the registered report-title
  // row's frozen fixture proves only the exact ONE-CELL shape — extra columns glued onto it must
  // fail exactly like every other registered-label-plus-extra-columns escape.
  it('the registered report title with extra trailing columns fails FULL_EXPORT (RA-P1-01 repro)', () => {
    const csv = [
      'ポートフォリオ一覧,900000,100',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  // RA-P1-01: the same row-level gap also applied to the csvProvenance.ts metadata-timestamp
  // class — only the exact two-cell "label,value" shape is proven; a third trailing column must
  // fail rather than disappear silently.
  it('a known metadata-timestamp label with an extra trailing column fails FULL_EXPORT (RA-P1-01 repro)', () => {
    const csv = [
      'データ基準日時,2026-09-10T00:00:00+09:00,FAKE,900000',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  // Unregistered lookalike prefix (never proven by any fixture): must never be tolerated merely
  // because it superficially resembles a registered label.
  it('an unregistered registered-prefix lookalike with extra numeric columns fails FULL_EXPORT', () => {
    const csv = [
      '総件数計,900000,100',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(1)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('UNEXPLAINED_POSITION_ROW')
    }
  })

  // Positive controls (ticket section 11): ページ/選択範囲 share 総件数's exact proven bare-
  // label-with-colon-value contract shape — never previously exercised by any fixture.
  it('a registered page-range label followed by an exact colon-separated value is tolerated', () => {
    const csv = [
      'ページ：3',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.unknownPreambleLineCount).toBe(0)
    expect(result.completeness).toEqual({ status: 'PASS' })
  })

  it('a registered selection-range label followed by an exact colon-separated value is tolerated', () => {
    const csv = [
      '選択範囲：1-100',
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.unknownPreambleLineCount).toBe(0)
    expect(result.completeness).toEqual({ status: 'PASS' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// OPS-SBI-P2-PREBUILD-PHASE2-R6-A — ticket section 9 regression matrix
// (RA-P1-01 CLOSURE: value grammar, not mere row-shape/non-emptiness)
// ═══════════════════════════════════════════════════════════════════════════
describe('sbiPortfolioImportV2: R6-A preamble value grammar (RA-P1-01 closure)', () => {
  function fullExportAround(preambleLine: string): string {
    return [
      preambleLine,
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      ...emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL),
      ...emptyTrustSection(TRUST_GROWTH_LABEL, TRUST_GROWTH_TOTAL),
      ...emptyTrustSection(TRUST_TSUMITATE_LABEL, TRUST_TSUMITATE_TOTAL),
    ].join('\n')
  }

  function expectFail(preambleLine: string) {
    const result = parseSbiPortfolioImportV2(fullExportAround(preambleLine))
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(
        result.completeness.reasons.includes('UNKNOWN_PREAMBLE_LINE') ||
        result.completeness.reasons.includes('UNEXPLAINED_POSITION_ROW'),
      ).toBe(true)
    }
  }

  function expectPass(preambleLine: string) {
    const result = parseSbiPortfolioImportV2(fullExportAround(preambleLine))
    expect(result.orphanPositionRowCount).toBe(0)
    expect(result.unknownPreambleLineCount).toBe(0)
    expect(result.completeness).toEqual({ status: 'PASS' })
  }

  // A. Count grammar (総件数): known label + valid one-cell colon shape + malformed value.
  describe('A. 総件数 value grammar', () => {
    it('rejects an empty value after the separator', () => expectFail('総件数：'))
    it('rejects an arbitrary text payload', () => expectFail('総件数：FAKE'))
    it('rejects a script-tag payload', () => expectFail('総件数：<script>alert(1)</script>'))
    it('rejects a SQL-injection-shaped payload', () => expectFail('総件数：DROP TABLE portfolios'))
    it('rejects a path-traversal-shaped payload', () => expectFail('総件数：../../etc/passwd'))
    it('rejects the same malformed payload behind a half-width colon', () => expectFail('総件数:FAKE'))
    it('accepts the boundary-valid fixture value behind a half-width colon', () => expectPass('総件数:150件'))
    it('accepts a full-width-digit NFKC variant of the boundary-valid value', () => expectPass('総件数：１５０件'))
  })

  // B. Page grammar (ページ): bare decimal page number only.
  describe('B. ページ value grammar', () => {
    it('rejects an arbitrary text payload', () => expectFail('ページ：abc'))
    it('rejects a digit-bearing but non-numeric-shaped payload', () => expectFail('ページ：3ページ目'))
    it('rejects an unregistered near-match label (ページ数) even with a well-formed value', () => expectFail('ページ数：3'))
    it('accepts another boundary-valid decimal page number', () => expectPass('ページ：1'))
  })

  // C. Range grammar (選択範囲): decimal start-end range only.
  describe('C. 選択範囲 value grammar', () => {
    it('rejects an arbitrary text payload', () => expectFail('選択範囲：abc'))
    it('rejects a path-traversal-shaped payload', () => expectFail('選択範囲：../../etc/passwd'))
    it('rejects a single number with no range separator', () => expectFail('選択範囲：100'))
  })

  // D. Timestamp grammar: every registered metadata-timestamp label requires an actual
  // timestamp value, not merely a non-empty second cell.
  describe('D. registered timestamp label value grammar', () => {
    it('rejects a non-timestamp text value for the authoritative label (データ基準日時)', () =>
      expectFail('データ基準日時,not-a-timestamp'))
    it('rejects a script-tag payload for a weak export-timestamp label (出力日時)', () =>
      expectFail('出力日時,<script>alert(1)</script>'))
    it('rejects a digit-bearing but calendar-invalid timestamp (データ基準日時)', () =>
      expectFail('データ基準日時,2026-13-40'))
    it('accepts an already-proven full ISO offset timestamp (データ基準日時)', () =>
      expectPass('データ基準日時,2026-09-10T00:00:00+09:00'))
    it('accepts an already-proven date-only timestamp (データ基準日)', () =>
      expectPass('データ基準日,2024-02-29'))
    it('accepts a valid timestamp for a weak export-timestamp label (出力日時)', () =>
      expectPass('出力日時,2026-07-15T09:00:00+09:00'))
  })

  // E. Normalization: half/full-width colon and NFKC digit variants remain supported for
  // legitimate values; near-match labels remain rejected regardless of value validity.
  describe('E. normalization', () => {
    it('half-width colon with a boundary-valid value is tolerated (総件数)', () => expectPass('総件数:150件'))
    it('full-width colon with a boundary-valid value is tolerated (ページ)', () => expectPass('ページ：3'))
    it('full-width-digit NFKC variant of a boundary-valid value is tolerated (総件数)', () =>
      expectPass('総件数：１５０件'))
    it('a near-match label is never treated as registered regardless of value validity', () =>
      expectFail('ページ数：3'))
  })
})

describe('sbiPortfolioImportV2: totals fail-closed gaps (P2-01)', () => {
  it('a blank section-total value fails the section, never silently passes', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,',
      ',,,,,', // blank totals value
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('TOTAL_MISMATCH')
  })

  it('a malformed (non-numeric) section-total value fails the section', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,',
      'N/A,,,,,',
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('TOTAL_MISMATCH')
  })

  it('EOF while awaiting the totals value (header already matched) truncates the section', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,', // totals header matched, then EOF — value never arrives
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('PARSE_FAILED')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toContain('TRUNCATED')
  })

  it('VALID_EMPTY with an incomplete (header-only, no value) totals block fails, not VALID_EMPTY', () => {
    const csv = [
      TRUST_TAXABLE_LABEL, TRUST_HEADER, TRUST_TAXABLE_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,', // totals header matched for an otherwise-empty section, then EOF
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('PARSE_FAILED')
    expect(result.sections.TRUST_TAXABLE.failureReasons).toContain('TRUNCATED')
  })

  it('no totals block offered at all still reaches VALID_EMPTY (frozen: totals block is optional bonus evidence)', () => {
    const csv = emptyTrustSection(TRUST_TAXABLE_LABEL, TRUST_TAXABLE_TOTAL).join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('VALID_EMPTY')
  })
})

// OPS-SBI-P2-PREBUILD-PHASE2-R2-R1 (P2-01 residual closure): the required-closing-boundary vs.
// optional-summary-evidence distinction, enumerated per the ticket's required test list. Most of
// these scenarios were already covered by name above (cross-referenced in each case); this block
// closes the one genuinely missing gap — VALID_EMPTY safety when the REQUIRED boundary itself was
// never proven — and states the distinction explicitly as its own regression surface.
describe('sbiPortfolioImportV2: P2-01 residual — required closure vs. optional summary (R1)', () => {
  it('VALID_EMPTY SAFETY: zero position rows + EOF with no required closing boundary is PARSE_FAILED, never VALID_EMPTY', () => {
    // No "投資信託（金額/特定預り）合計" boundary line at all — EOF arrives straight after the
    // header with zero rows. This must not be confused with the (legal) "boundary present, no
    // optional summary offered" case tested just above.
    const csv = [TRUST_TAXABLE_LABEL, TRUST_HEADER].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.TRUST_TAXABLE.status).toBe('PARSE_FAILED')
    expect(result.sections.TRUST_TAXABLE.status).not.toBe('VALID_EMPTY')
    expect(result.sections.TRUST_TAXABLE.failureReasons).toContain('TRUNCATED')
  })

  it('required section closes correctly with no optional summary at all → VALID_NONEMPTY (item 1)', () => {
    // Cross-reference: also exercised end-to-end by the "no optional summary at all" PASS
    // fixtures above (lines around emptyTrustSection usage) and by test 1's full-CSV fixture.
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('VALID_NONEMPTY')
  })

  it('required section closes correctly with a complete optional summary → VALID_NONEMPTY, unflagged (item 2)', () => {
    // Cross-reference: sbiPortfolioImportV2: known totals/footer lines > "a reconciling totals
    // block ... classified, never rejected" exercises the identical scenario end-to-end.
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,',
      '300000,0,0,0,0,',
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.sections.JP_STOCK_CUSTODY.status).toBe('VALID_NONEMPTY')
    expect(result.sections.JP_STOCK_CUSTODY.failureReasons).toEqual([])
  })
})

describe('sbiPortfolioImportV2: grand total structural presence (P2-01)', () => {
  it('EOF while awaiting the grand-total value truncates FULL_EXPORT', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '総合計', // grand-total footer label seen, then EOF — value never arrives
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.grandTotalTruncated).toBe(true)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('GRAND_TOTAL_TRUNCATED')
    }
  })

  it('an invalid (non-numeric) grand-total value is surfaced, never silently accepted', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,900000,15.20,1.10,2025-06-01',
      STOCK_TOTAL,
      '総合計',
      'N/A,,,,,',
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.grandTotalInvalid).toBe(true)
    expect(result.completeness.status).toBe('FAIL')
    if (result.completeness.status === 'FAIL') {
      expect(result.completeness.reasons).toContain('GRAND_TOTAL_INVALID')
    }
  })

  it('a valid grand-total value is never flagged truncated or invalid', () => {
    const csv = [
      STOCK_LABEL, STOCK_HEADER,
      '6501,日立製作所,8500,300000,15.20,1.10,2025-06-01',
      '7203,トヨタ自動車,3000,300000,5.00,0.50,2025-07-01',
      STOCK_TOTAL,
      '評価額,含み損益,含み損益（％）,前日比,前日比（％）,',
      '600000,6000,1.00,600,0.10,',
      '総合計',
      '600000,6000,1.00,600,0.10,',
    ].join('\n')
    const result = parseSbiPortfolioImportV2(csv)
    expect(result.grandTotalTruncated).toBe(false)
    expect(result.grandTotalInvalid).toBe(false)
  })
})
