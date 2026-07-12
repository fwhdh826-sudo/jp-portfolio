// P4.5-A009: 資金前提のexport/import（PC/スマホ間の手動同期）ヘルパーのテスト
import { describe, expect, it } from 'vitest'
import { serializeCashAssumptionsExport, parseCashAssumptionsImport, buildExportableCashAssumptions } from './cashAssumptionsTransfer'
import { CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION } from '../types'
import type { CashAssumptions } from '../types'

function makeCashAssumptions(overrides: Partial<CashAssumptions> = {}): CashAssumptions {
  return {
    cashDeposits: 4_000_000,
    standbyFunds: 9_000_000,
    manualOverrideEnabled: true,
    manualUpdatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('serializeCashAssumptionsExport / parseCashAssumptionsImport 往復', () => {
  it('exportしたJSONをimportすると同じcashDeposits/standbyFundsが復元される', () => {
    const src = makeCashAssumptions({ cashDeposits: 1_234_000, standbyFunds: 5_678_000 })
    const json = serializeCashAssumptionsExport(src)
    const result = parseCashAssumptionsImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.cashDeposits).toBe(1_234_000)
      expect(result.data.standbyFunds).toBe(5_678_000)
    }
  })

  it('exportしたJSONのmanualUpdatedAtがimportでそのまま引き継がれる', () => {
    const src = makeCashAssumptions({ manualUpdatedAt: '2026-06-15T03:00:00.000Z' })
    const json = serializeCashAssumptionsExport(src)
    const result = parseCashAssumptionsImport(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.manualUpdatedAt).toBe('2026-06-15T03:00:00.000Z')
    }
  })

  it('exportのJSONにschemaVersion/exportedAtが含まれる', () => {
    const json = serializeCashAssumptionsExport(makeCashAssumptions())
    const parsed = JSON.parse(json)
    expect(parsed.schemaVersion).toBe(CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION)
    expect(typeof parsed.exportedAt).toBe('string')
    expect(Number.isNaN(new Date(parsed.exportedAt).getTime())).toBe(false)
  })
})

describe('parseCashAssumptionsImport のvalidation', () => {
  const validPayload = () => JSON.stringify({
    schemaVersion: CASH_ASSUMPTIONS_EXPORT_SCHEMA_VERSION,
    exportedAt: '2026-07-04T00:00:00.000Z',
    cashDeposits: 1_000_000,
    standbyFunds: 2_000_000,
    manualOverrideEnabled: true,
    manualUpdatedAt: '2026-07-04T00:00:00.000Z',
  })

  it('有効なJSONはokになる', () => {
    const result = parseCashAssumptionsImport(validPayload())
    expect(result.ok).toBe(true)
  })

  it('空文字列はreject', () => {
    const result = parseCashAssumptionsImport('')
    expect(result.ok).toBe(false)
  })

  it('空白のみはreject', () => {
    const result = parseCashAssumptionsImport('   ')
    expect(result.ok).toBe(false)
  })

  it('JSONとしてparseできない文字列はreject', () => {
    const result = parseCashAssumptionsImport('not-json-at-all{{{')
    expect(result.ok).toBe(false)
  })

  it('JSON配列はreject（オブジェクトではない）', () => {
    const result = parseCashAssumptionsImport('[1,2,3]')
    expect(result.ok).toBe(false)
  })

  it('schemaVersion不一致はreject', () => {
    const data = JSON.parse(validPayload())
    data.schemaVersion = 'wrong-schema-v0'
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('schemaVersion欠損はreject', () => {
    const data = JSON.parse(validPayload())
    delete data.schemaVersion
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('cashDepositsが文字列型の場合はreject', () => {
    const data = JSON.parse(validPayload())
    data.cashDeposits = '1000000'
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('cashDepositsが負数の場合はreject', () => {
    const data = JSON.parse(validPayload())
    data.cashDeposits = -100
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('standbyFundsが負数の場合はreject', () => {
    const data = JSON.parse(validPayload())
    data.standbyFunds = -1
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('cashDepositsがNaN相当（JSON経由）の場合はreject', () => {
    // JSON.parseはNaN/Infinityリテラルを许さないため、文字列 "NaN" として混入するケースを想定
    const data = JSON.parse(validPayload())
    data.cashDeposits = 'NaN'
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('standbyFundsがInfinityの場合はreject（JSON.parse後にInfinityを直接代入したケース）', () => {
    const data = JSON.parse(validPayload())
    data.standbyFunds = Infinity
    // JSON.stringifyはInfinityをnullにするため、手動で不正なJSON文字列を組み立てる
    const raw = JSON.stringify(data).replace('"standbyFunds":null', '"standbyFunds":Infinity')
    const result = parseCashAssumptionsImport(raw)
    expect(result.ok).toBe(false)
  })

  it('異常に大きすぎる値はreject', () => {
    const data = JSON.parse(validPayload())
    data.cashDeposits = 1_000_000_000_000_000
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('cashDeposits欠損はreject', () => {
    const data = JSON.parse(validPayload())
    delete data.cashDeposits
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('standbyFunds欠損はreject', () => {
    const data = JSON.parse(validPayload())
    delete data.standbyFunds
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(false)
  })

  it('manualUpdatedAtが不正な文字列の場合はnullにfallbackする（stale扱いになる設計）', () => {
    const data = JSON.parse(validPayload())
    data.manualUpdatedAt = 'not-a-date'
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.manualUpdatedAt).toBeNull()
    }
  })

  it('manualUpdatedAtが欠損している場合はnullにfallbackする', () => {
    const data = JSON.parse(validPayload())
    delete data.manualUpdatedAt
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.manualUpdatedAt).toBeNull()
    }
  })

  it('cashDeposits/standbyFundsは整数に丸められる', () => {
    const data = JSON.parse(validPayload())
    data.cashDeposits = 1_000_000.6
    data.standbyFunds = 2_000_000.4
    const result = parseCashAssumptionsImport(JSON.stringify(data))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.cashDeposits).toBe(1_000_001)
      expect(result.data.standbyFunds).toBe(2_000_000)
    }
  })
})

// P4.5-A009 ミニ監査: manualOverrideEnabled=false（既定値使用中）でも
// 「実際に使われている値」を正しくexportできることの回帰テスト
describe('buildExportableCashAssumptions', () => {
  it('override有効時: effectiveの値（=手動入力値）がそのままexportableになる', () => {
    const exportable = buildExportableCashAssumptions({
      cash: 1_234_000, cashReserve: 5_678_000, manualUpdatedAt: '2026-07-01T00:00:00.000Z',
    })
    expect(exportable.cashDeposits).toBe(1_234_000)
    expect(exportable.standbyFunds).toBe(5_678_000)
    expect(exportable.manualOverrideEnabled).toBe(true)
    expect(exportable.manualUpdatedAt).toBe('2026-07-01T00:00:00.000Z')
  })

  it('override無効時（既定値使用中）: 0/0ではなく既定値（effective.cash/cashReserve）がexportされる', () => {
    // 既定値使用中はselectEffectiveCashAssumptionsがstate.cash/cashReserve（例: 400万/900万）を
    // 返す。ここではその出力を模した値を渡し、0/0にならないことを確認する。
    const exportable = buildExportableCashAssumptions({
      cash: 4_000_000, cashReserve: 9_000_000, manualUpdatedAt: null,
    })
    expect(exportable.cashDeposits).toBe(4_000_000)
    expect(exportable.standbyFunds).toBe(9_000_000)
    expect(exportable.cashDeposits).not.toBe(0)
    expect(exportable.standbyFunds).not.toBe(0)
  })

  it('override無効時（manualUpdatedAt=null）: manualOverrideEnabledは常にtrueになる（import強制仕様との整合）', () => {
    const exportable = buildExportableCashAssumptions({ cash: 4_000_000, cashReserve: 9_000_000, manualUpdatedAt: null })
    expect(exportable.manualOverrideEnabled).toBe(true)
  })

  it('manualUpdatedAt=nullの場合は現在時刻にfallbackする（既定値に「最終更新」概念がないため）', () => {
    const before = Date.now()
    const exportable = buildExportableCashAssumptions({ cash: 0, cashReserve: 0, manualUpdatedAt: null })
    const ts = new Date(exportable.manualUpdatedAt as string).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(Date.now())
  })

  it('serializeCashAssumptionsExportと組み合わせて0/0がexportされないことをJSON文字列レベルで確認する', () => {
    const exportable = buildExportableCashAssumptions({ cash: 4_000_000, cashReserve: 9_000_000, manualUpdatedAt: null })
    const json = serializeCashAssumptionsExport(exportable)
    const parsed = JSON.parse(json)
    expect(parsed.cashDeposits).toBe(4_000_000)
    expect(parsed.standbyFunds).toBe(9_000_000)
  })
})
