// P4.5-A009 / CASH-AUTH-1: 現金権限のexport/import（PC/スマホ間の手動同期）のテスト
import { describe, expect, it } from 'vitest'
import { serializeCashAssumptionsExport, parseCashAssumptionsImport, buildExportableCashAssumptions } from './cashAssumptionsTransfer'
import {
  CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION,
  CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION_V1,
  DEFAULT_CASH_ASSUMPTIONS,
} from '../types'
import type { CashAssumptions } from '../types'

function makeCashAssumptions(overrides: Partial<CashAssumptions> = {}): CashAssumptions {
  return {
    source: 'MANUAL',
    grossCash: 13_000_000,
    safetyReserve: 1_000_000,
    pendingOrderCash: null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('serializeCashAssumptionsExport / parseCashAssumptionsImport 往復', () => {
  it('exportしたJSONをimportすると同じ金額が復元される', () => {
    const src = makeCashAssumptions({ grossCash: 6_912_000, safetyReserve: 12_000, pendingOrderCash: 3_000 })
    const json = serializeCashAssumptionsExport(src)
    const result = parseCashAssumptionsImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.grossCash).toBe(6_912_000)
      expect(result.data.safetyReserve).toBe(12_000)
      expect(result.data.pendingOrderCash).toBe(3_000)
    }
  })

  it('exportしたJSONのupdatedAtがimportでそのまま引き継がれる', () => {
    const src = makeCashAssumptions({ updatedAt: '2026-06-15T03:00:00.000Z' })
    const json = serializeCashAssumptionsExport(src)
    const result = parseCashAssumptionsImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.updatedAt).toBe('2026-06-15T03:00:00.000Z')
    }
  })

  it('pendingOrderCash=null（不明）は往復してもnullのまま — 0（無しを確認済み）に変わらない', () => {
    const json = serializeCashAssumptionsExport(makeCashAssumptions({ pendingOrderCash: null }))
    const result = parseCashAssumptionsImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.pendingOrderCash).toBeNull()
  })

  it('pendingOrderCash=0（無しを確認済み）は往復しても0のまま — nullに変わらない', () => {
    const json = serializeCashAssumptionsExport(makeCashAssumptions({ pendingOrderCash: 0 }))
    const result = parseCashAssumptionsImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.pendingOrderCash).toBe(0)
  })

  it('exportのJSONにschemaVersion/exportedAtが含まれる', () => {
    const json = serializeCashAssumptionsExport(makeCashAssumptions())
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe(CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION)
    expect(typeof parsed.exportedAt).toBe('string')
    expect(Number.isNaN(new Date(parsed.exportedAt).getTime())).toBe(false)
  })

  it('exportペイロードにlegacyフィールドは含まれない', () => {
    const parsed = JSON.parse(serializeCashAssumptionsExport(makeCashAssumptions()))
    expect(parsed).not.toHaveProperty('cashDeposits')
    expect(parsed).not.toHaveProperty('standbyFunds')
    expect(parsed).not.toHaveProperty('manualOverrideEnabled')
    expect(parsed).not.toHaveProperty('addRoom')
  })
})

describe('parseCashAssumptionsImport のvalidation', () => {
  const validPayload = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION,
    exportedAt: '2026-07-04T00:00:00.000Z',
    source: 'MANUAL',
    grossCash: 3_000_000,
    safetyReserve: 500_000,
    pendingOrderCash: null,
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  })

  it('有効なJSONはokになる', () => {
    expect(parseCashAssumptionsImport(validPayload()).ok).toBe(true)
  })

  it('空文字列はreject', () => {
    expect(parseCashAssumptionsImport('').ok).toBe(false)
  })

  it('空白のみはreject', () => {
    expect(parseCashAssumptionsImport('   \n  ').ok).toBe(false)
  })

  it('JSONとしてparseできない文字列はreject', () => {
    expect(parseCashAssumptionsImport('{ not json').ok).toBe(false)
  })

  it('JSON配列はreject（オブジェクトではない）', () => {
    expect(parseCashAssumptionsImport('[1,2,3]').ok).toBe(false)
  })

  it('schemaVersion不一致はreject', () => {
    expect(parseCashAssumptionsImport(validPayload({ schemaVersion: 'other-1' })).ok).toBe(false)
  })

  it('schemaVersion欠損はreject', () => {
    const p = JSON.parse(validPayload()) as Record<string, unknown>
    delete p.schemaVersion
    expect(parseCashAssumptionsImport(JSON.stringify(p)).ok).toBe(false)
  })

  it('source=DEFAULT（相手側が未設定）はreject — 0円確認済みへ昇格させない', () => {
    expect(parseCashAssumptionsImport(validPayload({
      source: 'DEFAULT', grossCash: 0, safetyReserve: 0, updatedAt: null,
    })).ok).toBe(false)
  })

  it('grossCashが文字列型の場合はreject', () => {
    expect(parseCashAssumptionsImport(validPayload({ grossCash: '3000000' })).ok).toBe(false)
  })

  it('grossCashが負数の場合はreject', () => {
    expect(parseCashAssumptionsImport(validPayload({ grossCash: -1, safetyReserve: 0 })).ok).toBe(false)
  })

  it('safetyReserveが負数の場合はreject', () => {
    expect(parseCashAssumptionsImport(validPayload({ safetyReserve: -1 })).ok).toBe(false)
  })

  it('非整数の円はreject（丸めない）', () => {
    expect(parseCashAssumptionsImport(validPayload({ grossCash: 1234.5 })).ok).toBe(false)
  })

  it('NaN相当（JSON経由でnull）はreject', () => {
    expect(parseCashAssumptionsImport(validPayload({ grossCash: Number.NaN })).ok).toBe(false)
  })

  it('Infinityを直接代入したケースもreject', () => {
    const parsed = JSON.parse(validPayload()) as Record<string, unknown>
    parsed.grossCash = Number.POSITIVE_INFINITY
    // JSON.stringify は Infinity を null にするため、オブジェクト経由の値を文字列化して確認する
    expect(parseCashAssumptionsImport(JSON.stringify(parsed)).ok).toBe(false)
  })

  it('異常に大きすぎる値（1兆円超）はreject', () => {
    expect(parseCashAssumptionsImport(validPayload({ grossCash: 1_000_000_000_001 })).ok).toBe(false)
  })

  it('grossCash欠損はreject', () => {
    const p = JSON.parse(validPayload()) as Record<string, unknown>
    delete p.grossCash
    expect(parseCashAssumptionsImport(JSON.stringify(p)).ok).toBe(false)
  })

  it('安全余力と未約定の合計が総現金を超えるペイロードはreject', () => {
    expect(parseCashAssumptionsImport(validPayload({
      grossCash: 1_000_000, safetyReserve: 800_000, pendingOrderCash: 300_000,
    })).ok).toBe(false)
  })

  it('updatedAtが不正な文字列の場合はnullにfallbackする（stale扱いになる設計）', () => {
    const result = parseCashAssumptionsImport(validPayload({ updatedAt: 'not-a-date' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.updatedAt).toBeNull()
  })

  it('updatedAtが欠損している場合はnullにfallbackする（現在時刻で捏造しない）', () => {
    const p = JSON.parse(validPayload()) as Record<string, unknown>
    delete p.updatedAt
    const result = parseCashAssumptionsImport(JSON.stringify(p))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.updatedAt).toBeNull()
  })
})

describe('CASH-AUTH-1: legacy export ペイロード（v1）の移行', () => {
  const legacyPayload = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION_V1,
    exportedAt: '2026-07-04T00:00:00.000Z',
    cashDeposits: 1_000_000,
    standbyFunds: 2_000_000,
    manualOverrideEnabled: true,
    manualUpdatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  })

  it('cashDeposits + standbyFunds を一度だけ合算して grossCash にする', () => {
    const result = parseCashAssumptionsImport(legacyPayload())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.grossCash).toBe(3_000_000)
      expect(result.data.safetyReserve).toBe(0)
      expect(result.data.pendingOrderCash).toBeNull()
      expect(result.data.updatedAt).toBe('2026-07-04T00:00:00.000Z')
    }
  })

  it('addRoom が含まれていても grossCash には加算されない', () => {
    const result = parseCashAssumptionsImport(legacyPayload({ addRoom: 999_999 }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.grossCash).toBe(3_000_000)
  })

  it('manualUpdatedAt が欠損した legacy ペイロードは reject（時刻を捏造しない）', () => {
    expect(parseCashAssumptionsImport(legacyPayload({ manualUpdatedAt: null })).ok).toBe(false)
  })

  it('負数の legacy 金額は reject', () => {
    expect(parseCashAssumptionsImport(legacyPayload({ cashDeposits: -1 })).ok).toBe(false)
  })

  it('移行は冪等 — 移行後の値を再度 export/import しても金額が変わらない', () => {
    const first = parseCashAssumptionsImport(legacyPayload())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const record: CashAssumptions = { source: 'MANUAL', ...first.data }
    const second = parseCashAssumptionsImport(serializeCashAssumptionsExport(record))
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.data).toEqual(first.data)
  })
})

describe('buildExportableCashAssumptions', () => {
  it('MANUAL: 権限の値がそのままexportableになる', () => {
    const record = makeCashAssumptions({ grossCash: 7_777, safetyReserve: 777, pendingOrderCash: 77 })
    expect(buildExportableCashAssumptions(record)).toEqual(record)
  })

  it('DEFAULT（未設定）は未設定のまま — 0円確認済みへ昇格しない', () => {
    const exportable = buildExportableCashAssumptions({ ...DEFAULT_CASH_ASSUMPTIONS })
    expect(exportable).toEqual(DEFAULT_CASH_ASSUMPTIONS)
    expect(exportable.updatedAt).toBeNull()
  })

  it('DEFAULTをexportした文字列はimportでrejectされる（不明を金額として渡さない）', () => {
    const json = serializeCashAssumptionsExport(buildExportableCashAssumptions({ ...DEFAULT_CASH_ASSUMPTIONS }))
    expect(parseCashAssumptionsImport(json).ok).toBe(false)
  })
})
