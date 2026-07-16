// P4.5-A012a: portfolio snapshot（保有株・投信・現金前提・portfolioPolicy）の
// export/import（PC/スマホ間の手動同期）ヘルパーのテスト
import { describe, expect, it } from 'vitest'
import {
  serializePortfolioSnapshotExport,
  parsePortfolioSnapshotImport,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2,
  PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3,
} from './portfolioSnapshotTransfer'

function makeExportArgs(overrides: Partial<Parameters<typeof serializePortfolioSnapshotExport>[0]> = {}) {
  return {
    holdings: [
      { code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, currentPrice: 8920, acquiredAt: '2024-01-10' },
      { code: '2202', name: 'テスト銀行', eval: 710_000, pnlPct: 5.19 },
    ],
    trust: [
      { id: 'nk225_sbi', eval: 1_605_730, pnlPct: 7.04, dayPct: 2.01, account: '特定' },
      { id: 'jpndiv', eval: 732_464, pnlPct: 1.73 },
    ],
    portfolioPolicy: { jpStockMaxRatio: 0.12 },
    cashAssumptions: {
      cashDeposits: 4_000_000,
      standbyFunds: 9_000_000,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-01T00:00:00.000Z',
    },
    csvImportedAt: '2026-07-06T09:00:00.000Z',
    csvImportProvenance: {
      importedAt: '2026-07-06T09:00:00.000Z',
      sourceAsOf: '2026-07-06T08:00:00.000Z',
      sourceAsOfKind: 'csv_explicit' as const,
      sourceAsOfConfidence: 'authoritative' as const,
      semanticIdentity: `sha256:${'a'.repeat(64)}`,
      contentFingerprint: 'fnv1a32:12345678',
      sourceFileName: 'portfolio.csv',
      fileLastModified: '2026-07-06T08:30:00.000Z',
    },
    ...overrides,
  }
}

// P4.5-A013-T7: serializePortfolioSnapshotExportは常にschemaVersion v2を出力する
// （新規個別株full-syncに必要なnameを含む）。v1形式の受け入れはparsePortfolioSnapshotImport
// 側の後方互換テスト（下部の「v1後方互換」describe）で別途固定する。
describe('serializePortfolioSnapshotExport / parsePortfolioSnapshotImport 往復（v3）', () => {
  it('happy path: exportしたJSONをimportすると元の値が復元される', () => {
    const args = makeExportArgs()
    const json = serializePortfolioSnapshotExport(args)
    const result = parsePortfolioSnapshotImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.schemaVersion).toBe(PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3)
      expect(result.data.csvImportProvenance).toEqual(args.csvImportProvenance)
      expect(result.data.holdings).toEqual([
        { code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, currentPrice: 8920, acquiredAt: '2024-01-10' },
        { code: '2202', name: 'テスト銀行', eval: 710_000, pnlPct: 5.19 },
      ])
      expect(result.data.trust).toEqual([
        { id: 'nk225_sbi', eval: 1_605_730, pnlPct: 7.04, dayPct: 2.01, account: '特定' },
        { id: 'jpndiv', eval: 732_464, pnlPct: 1.73 },
      ])
      expect(result.data.portfolioPolicy).toEqual({ jpStockMaxRatio: 0.12 })
      expect(result.data.cashAssumptions).toEqual({
        cashDeposits: 4_000_000,
        standbyFunds: 9_000_000,
        manualOverrideEnabled: true,
        manualUpdatedAt: '2026-07-01T00:00:00.000Z',
      })
    }
  })

  it('v2: sector/mu/sigma/sigmaSource/betaが指定されればexport/importで往復する', () => {
    const args = makeExportArgs({
      holdings: [
        {
          code: '9999', name: '新規銘柄', eval: 100_000, pnlPct: 0,
          sector: 'テスト業種', mu: 0.12, sigma: 0.22, sigmaSource: 'yfinance', beta: 1.1,
        },
      ],
    })
    const json = serializePortfolioSnapshotExport(args)
    const result = parsePortfolioSnapshotImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.holdings[0]).toEqual({
        code: '9999', name: '新規銘柄', eval: 100_000, pnlPct: 0,
        sector: 'テスト業種', mu: 0.12, sigma: 0.22, sigmaSource: 'yfinance', beta: 1.1,
      })
    }
  })

  it('exportedAt/csvImportedAtが保持される', () => {
    const base = makeExportArgs()
    if (!base.csvImportProvenance) throw new Error('expected provenance')
    const args = makeExportArgs({
      csvImportedAt: '2026-07-05T23:00:00.000Z',
      csvImportProvenance: { ...base.csvImportProvenance, importedAt: '2026-07-05T23:00:00.000Z' },
    })
    const json = serializePortfolioSnapshotExport(args)
    const parsed = JSON.parse(json)
    expect(parsed.csvImportedAt).toBe('2026-07-05T23:00:00.000Z')
    expect(typeof parsed.exportedAt).toBe('string')
    expect(Number.isNaN(new Date(parsed.exportedAt).getTime())).toBe(false)

    const result = parsePortfolioSnapshotImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.csvImportedAt).toBe('2026-07-05T23:00:00.000Z')
      expect(result.data.exportedAt).toBe(parsed.exportedAt)
    }
  })

  it('exportのJSONにschemaVersion v3/sourceが含まれる', () => {
    const json = serializePortfolioSnapshotExport(makeExportArgs())
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe(PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V3)
    expect(parsed.source).toBe('manual')
  })

  it('R2-F1 RED: v3 without snapshot generation identity fails closed', () => {
    const payload = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs()))
    delete payload.snapshotGenerationIdentity
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT_GENERATION' })
  })

  it.each([
    ['stock eval', (payload: any) => { payload.holdings[0].eval += 1 }, 'INVALID_SNAPSHOT_GENERATION'],
    ['stock name', (payload: any) => { payload.holdings[0].name = '別名' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['stock code', (payload: any) => { payload.holdings[0].code = '9999' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['trust eval', (payload: any) => { payload.trust[0].eval += 1 }, 'INVALID_SNAPSHOT_GENERATION'],
    ['trust id', (payload: any) => { payload.trust[0].id = 'other-fund' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['trust account classification', (payload: any) => { payload.trust[0].account = 'NISA積立' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['csvImportedAt', (payload: any) => { payload.csvImportedAt = '2026-07-06T09:00:01.000Z' }, 'INVALID_SNAPSHOT_PROVENANCE'],
    ['provenance sourceAsOf', (payload: any) => { payload.csvImportProvenance.sourceAsOf = '2026-07-06T08:00:01.000Z' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['provenance semanticIdentity', (payload: any) => { payload.csvImportProvenance.semanticIdentity = `sha256:${'b'.repeat(64)}` }, 'INVALID_SNAPSHOT_GENERATION'],
    ['provenance contentFingerprint', (payload: any) => { payload.csvImportProvenance.contentFingerprint = 'fnv1a32:87654321' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['provenance sourceFileName', (payload: any) => { payload.csvImportProvenance.sourceFileName = 'other.csv' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['provenance fileLastModified', (payload: any) => { payload.csvImportProvenance.fileLastModified = '2026-07-06T08:30:01.000Z' }, 'INVALID_SNAPSHOT_GENERATION'],
    ['portfolio policy', (payload: any) => { payload.portfolioPolicy.jpStockMaxRatio = 0.15 }, 'INVALID_SNAPSHOT_GENERATION'],
    ['cash assumptions', (payload: any) => { payload.cashAssumptions.cashDeposits += 1 }, 'INVALID_SNAPSHOT_GENERATION'],
  ])('R2-F1: stale generation identity rejects changed %s', (_label, mutate, code) => {
    const payload = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs()))
    payload.snapshotGenerationIdentity = `sha256:${'f'.repeat(64)}`
    mutate(payload)
    expect(parsePortfolioSnapshotImport(JSON.stringify(payload)))
      .toMatchObject({ ok: false, code })
  })

  it('row order, object key order, JSON whitespace, and CRLF are representation-only', () => {
    const original = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs()))
    const identity = original.snapshotGenerationIdentity

    const reversedRows = { ...original, holdings: [...original.holdings].reverse(), trust: [...original.trust].reverse() }
    expect(parsePortfolioSnapshotImport(JSON.stringify(reversedRows))).toMatchObject({
      ok: true,
      data: { snapshotGenerationIdentity: identity },
    })

    const reversedKeys = Object.fromEntries(Object.entries(original).reverse())
    const compact = JSON.stringify(reversedKeys)
    const crlf = JSON.stringify(reversedKeys, null, 2).replace(/\n/g, '\r\n')
    expect(parsePortfolioSnapshotImport(compact)).toMatchObject({ ok: true })
    expect(parsePortfolioSnapshotImport(` \n${crlf}\n `)).toMatchObject({ ok: true })
  })

  it('exportedAt alone is excluded from generation identity', () => {
    const payload = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs()))
    const identity = payload.snapshotGenerationIdentity
    payload.exportedAt = '2099-12-31T23:59:59.000Z'
    expect(parsePortfolioSnapshotImport(JSON.stringify(payload))).toMatchObject({
      ok: true,
      data: { snapshotGenerationIdentity: identity },
    })
  })

  it('null and non-null provenance are different generations', () => {
    const known = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs()))
    const unknown = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs({
      csvImportedAt: null,
      csvImportProvenance: null,
    })))
    expect(known.snapshotGenerationIdentity).not.toBe(unknown.snapshotGenerationIdentity)
  })

  it('accountはsnapshotに含まれる（口座区分は個人情報だが手動同期対象として許容）', () => {
    const json = serializePortfolioSnapshotExport(makeExportArgs())
    const parsed = JSON.parse(json)
    expect(parsed.trust[0].account).toBe('特定')
  })

  it('score/decision/ev/officialDecision等の計算結果はexportに含まれない（sector/mu/sigma/betaはv2でintentionalに含む）', () => {
    // 呼び出し側が本物のHolding/Trust（score/decision/ev等を含む）を渡しても
    // 関数内部でpickされ、計算結果フィールドはJSONに漏れないことを確認する。
    // P4.5-A013-T7: sigma/beta/muはv2で新規銘柄再現のため意図的にexportへ含める
    // ようになったため、ここではscore/decision/ev（judgment結果）のみを検証する。
    const args = makeExportArgs({
      holdings: [
        {
          code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94,
          // 以下は本来のHolding型が持つ計算結果フィールド（漏れてはいけない）
          score: 88, decision: 'BUY', ev: 0.12,
        } as unknown as { code: string; name: string; eval: number; pnlPct: number },
      ],
      trust: [
        {
          id: 'nk225_sbi', eval: 1_605_730, pnlPct: 7.04,
          score: 70, decision: 'HOLD', ev: 0.05, signal: 'neutral',
        } as unknown as { id: string; eval: number; pnlPct: number },
      ],
    })
    const json = serializePortfolioSnapshotExport(args)
    const parsed = JSON.parse(json)
    expect(parsed.holdings[0]).not.toHaveProperty('score')
    expect(parsed.holdings[0]).not.toHaveProperty('decision')
    expect(parsed.holdings[0]).not.toHaveProperty('ev')
    expect(parsed.trust[0]).not.toHaveProperty('score')
    expect(parsed.trust[0]).not.toHaveProperty('decision')
    expect(parsed.trust[0]).not.toHaveProperty('ev')
    expect(parsed.trust[0]).not.toHaveProperty('signal')
    expect(json).not.toContain('officialDecision')
    expect(json).not.toContain('zeroPlan')
    expect(json).not.toContain('candidateActions')
  })

  it('v2でもsigma/beta/muを明示的に渡さなければexportに含まれない（自動で漏れない）', () => {
    const args = makeExportArgs({
      holdings: [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94 }],
    })
    const json = serializePortfolioSnapshotExport(args)
    const parsed = JSON.parse(json)
    expect(parsed.holdings[0]).not.toHaveProperty('sigma')
    expect(parsed.holdings[0]).not.toHaveProperty('beta')
    expect(parsed.holdings[0]).not.toHaveProperty('mu')
    expect(parsed.holdings[0]).not.toHaveProperty('sector')
    expect(parsed.holdings[0]).not.toHaveProperty('sigmaSource')
  })

  it('exportedAtだけが変わってもtransported provenanceは同一である', () => {
    const args = makeExportArgs()
    const first = JSON.parse(serializePortfolioSnapshotExport(args))
    const second = JSON.parse(serializePortfolioSnapshotExport(args))
    expect(first.csvImportProvenance).toEqual(second.csvImportProvenance)
    expect(first.csvImportedAt).toBe(second.csvImportedAt)
  })

  it.each([
    ['missing provenance', (payload: any) => { delete payload.csvImportProvenance }],
    ['invalid sourceAsOf', (payload: any) => { payload.csvImportProvenance.sourceAsOf = '2026-02-30T00:00:00Z' }],
    ['invalid semantic identity', (payload: any) => { payload.csvImportProvenance.semanticIdentity = 'fnv1a32:12345678' }],
    ['invalid fingerprint', (payload: any) => { payload.csvImportProvenance.contentFingerprint = '12345678' }],
    ['unknown provenance key', (payload: any) => { payload.csvImportProvenance.unexpected = true }],
    ['kind/confidence mismatch', (payload: any) => { payload.csvImportProvenance.sourceAsOfConfidence = 'weak' }],
    ['operation time mismatch', (payload: any) => { payload.csvImportProvenance.importedAt = '2026-07-06T10:00:00.000Z' }],
  ])('v3 malformed provenance fails closed: %s', (_label, mutate) => {
    const payload = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs()))
    mutate(payload)
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result).toMatchObject({ ok: false, code: 'INVALID_SNAPSHOT_PROVENANCE' })
  })

  it('v3 explicit null provenance remains unknown rather than being synthesized from operation times', () => {
    const payload = JSON.parse(serializePortfolioSnapshotExport(makeExportArgs({
      csvImportProvenance: null,
      csvImportedAt: '2099-12-31T23:59:58.000Z',
    })))
    payload.exportedAt = '2099-12-31T23:59:59.000Z'
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result).toMatchObject({ ok: true, data: { csvImportProvenance: null } })
  })
})

// P4.5-A013-T7: v1後方互換。旧端末/旧バージョンでexportされたv1 payload
// （nameを含まない）が引き続き正しくparseできることを固定する。
describe('parsePortfolioSnapshotImport のvalidation（v1 payload・後方互換）', () => {
  const validPayload = () => JSON.stringify({
    schemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
    exportedAt: '2026-07-06T00:00:00.000Z',
    csvImportedAt: '2026-07-05T23:00:00.000Z',
    source: 'manual',
    holdings: [{ code: '1101', eval: 892_000, pnlPct: 4.94 }],
    trust: [{ id: 'nk225_sbi', eval: 1_605_730, pnlPct: 7.04 }],
    portfolioPolicy: { jpStockMaxRatio: 0.10 },
    cashAssumptions: {
      cashDeposits: 4_000_000, standbyFunds: 9_000_000,
      manualOverrideEnabled: true, manualUpdatedAt: '2026-07-01T00:00:00.000Z',
    },
  })

  it('v1 happy path: nameを含まないpayloadでも正しくparseされる', () => {
    const result = parsePortfolioSnapshotImport(validPayload())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.schemaVersion).toBe(PORTFOLIO_SNAPSHOT_SCHEMA_VERSION)
      expect(result.data.holdings).toEqual([{ code: '1101', eval: 892_000, pnlPct: 4.94 }])
    }
  })

  it('空文字列はreject', () => {
    const result = parsePortfolioSnapshotImport('')
    expect(result.ok).toBe(false)
  })

  it('不正JSONはreject', () => {
    const result = parsePortfolioSnapshotImport('{invalid json')
    expect(result.ok).toBe(false)
  })

  it('JSON配列（オブジェクトでない）はreject', () => {
    const result = parsePortfolioSnapshotImport('[1,2,3]')
    expect(result.ok).toBe(false)
  })

  it('schemaVersion不一致はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.schemaVersion = 'portfolio-snapshot-0'
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('schemaVersion')
  })

  it('holdingsが配列でない場合はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.holdings = { code: '1101' }
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('trustが配列でない場合はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.trust = 'not-an-array'
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('holdingsのcode欠損はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.holdings = [{ eval: 892_000, pnlPct: 4.94 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('trustのid欠損はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.trust = [{ eval: 1_605_730, pnlPct: 7.04 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('holdingsのeval負数はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.holdings = [{ code: '1101', eval: -100, pnlPct: 4.94 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('holdingsのeval上限超過はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.holdings = [{ code: '1101', eval: 2_000_000_000_000, pnlPct: 4.94 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('trustのeval負数はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.trust = [{ id: 'nk225_sbi', eval: -1, pnlPct: 1.0 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('evalがNaN相当（文字列"NaN"のような不正型）はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.holdings = [{ code: '1101', eval: 'NaN', pnlPct: 4.94 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('pnlPctがInfinity相当（JSON.parseできない値のため文字列経由で検証）はreject', () => {
    // JSON標準はInfinity/NaNリテラルを許容しないため、文字列で表現された不正値として検証する
    const raw = validPayload().replace('"pnlPct":4.94', '"pnlPct":"Infinity"')
    const result = parsePortfolioSnapshotImport(raw)
    expect(result.ok).toBe(false)
  })

  it('cashAssumptions.cashDepositsが負数はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.cashAssumptions.cashDeposits = -1
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('cashAssumptions.manualOverrideEnabledが非booleanはreject', () => {
    const payload = JSON.parse(validPayload())
    payload.cashAssumptions.manualOverrideEnabled = 'true'
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('cashAssumptions.standbyFundsが上限超過はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.cashAssumptions.standbyFunds = 2_000_000_000_000
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('portfolioPolicy.jpStockMaxRatioが範囲外はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.portfolioPolicy.jpStockMaxRatio = 0.99
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('portfolioPolicy/cashAssumptionsがnullでも有効（optional）', () => {
    const payload = JSON.parse(validPayload())
    payload.portfolioPolicy = null
    payload.cashAssumptions = null
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.portfolioPolicy).toBeNull()
      expect(result.data.cashAssumptions).toBeNull()
      expect(result.data.csvImportProvenance).toBeNull()
    }
  })

  it('1件でも不正なら全体reject（部分importしない）', () => {
    const payload = JSON.parse(validPayload())
    payload.holdings = [
      { code: '1101', eval: 892_000, pnlPct: 4.94 },
      { code: '2202', eval: -999, pnlPct: 1.0 }, // 2件目が不正
    ]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it.each([
    ['exportedAt', '2026-02-30'],
    ['exportedAt', '2026-07-15T25:00:00Z'],
    ['csvImportedAt', '2025-02-29'],
    ['csvImportedAt', '2026-07-15T09:00:00'],
  ])('%sの不正またはtimezone-less timestampはreject', (field, invalid) => {
    const payload = JSON.parse(validPayload())
    payload[field] = invalid
    expect(parsePortfolioSnapshotImport(JSON.stringify(payload)).ok).toBe(false)
  })

  it('不明なschemaVersion（v1でもv2でもない）はreject', () => {
    const payload = JSON.parse(validPayload())
    payload.schemaVersion = 'portfolio-snapshot-999'
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('schemaVersion')
  })
})

// P4.5-A013-T7: v2専用のvalidation。nameの必須化、sector/mu/sigma/sigmaSource/beta
// の妥当性チェックを固定する。
describe('parsePortfolioSnapshotImport のvalidation（v2 payload）', () => {
  const validV2Payload = () => JSON.stringify({
    schemaVersion: PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2,
    exportedAt: '2026-07-06T00:00:00.000Z',
    csvImportedAt: '2026-07-05T23:00:00.000Z',
    source: 'manual',
    holdings: [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94 }],
    trust: [{ id: 'nk225_sbi', eval: 1_605_730, pnlPct: 7.04 }],
    portfolioPolicy: null,
    cashAssumptions: null,
  })

  it('v2 happy path: nameを含むpayloadは正しくparseされる', () => {
    const result = parsePortfolioSnapshotImport(validV2Payload())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.schemaVersion).toBe(PORTFOLIO_SNAPSHOT_SCHEMA_VERSION_V2)
      expect(result.data.holdings).toEqual([{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94 }])
    }
  })

  it('v2: nameが欠損しているholdingsはreject（新規銘柄構築に必須のため）', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', eval: 892_000, pnlPct: 4.94 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('name')
  })

  it('v2: nameが空文字のholdingsはreject', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', name: '   ', eval: 892_000, pnlPct: 4.94 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('v2: sectorが空文字はreject', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, sector: '' }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('v2: muが範囲外（-1〜1超）はreject', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, mu: 5 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('v2: sigmaが0以下はreject', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, sigma: 0 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('v2: sigmaが上限超過はreject', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, sigma: 10 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('v2: sigmaSourceが不正な値はreject', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, sigmaSource: 'made-up' }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('v2: betaが範囲外はreject', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{ code: '1101', name: 'テスト商事', eval: 892_000, pnlPct: 4.94, beta: 999 }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(false)
  })

  it('v2: sector/mu/sigma/sigmaSource/betaが全て有効な値なら正しくparseされる', () => {
    const payload = JSON.parse(validV2Payload())
    payload.holdings = [{
      code: '9999', name: '新規銘柄', eval: 100_000, pnlPct: 0,
      sector: 'テスト業種', mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1.0,
    }]
    const result = parsePortfolioSnapshotImport(JSON.stringify(payload))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.holdings[0]).toEqual({
        code: '9999', name: '新規銘柄', eval: 100_000, pnlPct: 0,
        sector: 'テスト業種', mu: 0.1, sigma: 0.2, sigmaSource: 'static', beta: 1.0,
      })
    }
  })
})
