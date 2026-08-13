// CASH-AUTH-1: 凍結された現金権限契約の単体テスト。
// 実時計は一切使わず、注入した nowMs のみで判定する（sleep なし・決定的）。
import { describe, expect, it } from 'vitest'
import {
  CASH_AUTHORITY_MAX_JPY,
  NO_CASH_AUTHORITY,
  deriveCashAuthorityView,
  evaluateCashAuthorityFreshness,
  isIntegerJpy,
  isValidCashAuthorityRecord,
  migrateLegacyCashAssumptions,
  normalizeCashAuthorityRecord,
  validateCashAuthorityDraft,
} from './cashAuthority'
import type { CashAssumptions } from '../../types'

const NOW = Date.parse('2026-07-20T00:00:00.000Z')
const HOUR = 60 * 60 * 1000
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const manual = (overrides: Partial<CashAssumptions> = {}): CashAssumptions => ({
  source: 'MANUAL',
  grossCash: 5_000_000,
  safetyReserve: 1_000_000,
  pendingOrderCash: null,
  updatedAt: ago(HOUR),
  ...overrides,
})

describe('isIntegerJpy', () => {
  it('0以上1兆円以下の整数のみ受理する', () => {
    expect(isIntegerJpy(0)).toBe(true)
    expect(isIntegerJpy(CASH_AUTHORITY_MAX_JPY)).toBe(true)
  })

  it.each([
    ['負数', -1],
    ['非整数', 1234.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['1兆円超', CASH_AUTHORITY_MAX_JPY + 1],
  ])('%s は拒否する', (_label, value) => {
    expect(isIntegerJpy(value)).toBe(false)
  })

  it('文字列・null・undefinedは拒否する', () => {
    expect(isIntegerJpy('1000')).toBe(false)
    expect(isIntegerJpy(null)).toBe(false)
    expect(isIntegerJpy(undefined)).toBe(false)
  })
})

describe('isValidCashAuthorityRecord', () => {
  it('準備金の合計が総現金以下なら有効', () => {
    expect(isValidCashAuthorityRecord(manual({
      grossCash: 1_000_000, safetyReserve: 600_000, pendingOrderCash: 400_000,
    }))).toBe(true)
  })

  it('準備金の合計が総現金を超えると無効（1円の二重確保を許さない）', () => {
    expect(isValidCashAuthorityRecord(manual({
      grossCash: 1_000_000, safetyReserve: 600_000, pendingOrderCash: 400_001,
    }))).toBe(false)
  })

  it('DEFAULTは全項目が0/nullのときのみ有効', () => {
    expect(isValidCashAuthorityRecord(NO_CASH_AUTHORITY)).toBe(true)
    expect(isValidCashAuthorityRecord({ ...NO_CASH_AUTHORITY, grossCash: 1 })).toBe(false)
  })
})

describe('evaluateCashAuthorityFreshness — 凍結TTL 168h / 警告 144h', () => {
  it('ちょうど168hは fresh（`>` 境界を維持する）', () => {
    const f = evaluateCashAuthorityFreshness(manual({ updatedAt: ago(168 * HOUR) }), NOW)
    expect(f.state).toBe('known_fresh')
    expect(f.approachingExpiry).toBe(true)
  })

  it('168h + 1ms で stale になる', () => {
    const f = evaluateCashAuthorityFreshness(manual({ updatedAt: ago(168 * HOUR + 1) }), NOW)
    expect(f.state).toBe('stale')
    expect(f.reason).toBe('EXPIRED')
  })

  it('144h ちょうどで approachingExpiry になるが fresh のまま', () => {
    const f = evaluateCashAuthorityFreshness(manual({ updatedAt: ago(144 * HOUR) }), NOW)
    expect(f.state).toBe('known_fresh')
    expect(f.approachingExpiry).toBe(true)
  })

  it('144h - 1ms では approachingExpiry にならない', () => {
    const f = evaluateCashAuthorityFreshness(manual({ updatedAt: ago(144 * HOUR - 1) }), NOW)
    expect(f.state).toBe('known_fresh')
    expect(f.approachingExpiry).toBe(false)
  })

  it('丸めた日数ではなく正確なミリ秒で判定する（167h59m59.999s は fresh）', () => {
    const f = evaluateCashAuthorityFreshness(manual({ updatedAt: ago(168 * HOUR - 1) }), NOW)
    expect(f.state).toBe('known_fresh')
  })

  it('未来のupdatedAtは known_fresh にならない', () => {
    const f = evaluateCashAuthorityFreshness(
      manual({ updatedAt: new Date(NOW + 1).toISOString() }), NOW,
    )
    expect(f.state).toBe('stale')
    expect(f.reason).toBe('FUTURE_TIMESTAMP')
  })

  it('欠損・不正なupdatedAtは known_fresh にならない', () => {
    expect(evaluateCashAuthorityFreshness(manual({ updatedAt: null }), NOW).reason).toBe('MISSING_TIMESTAMP')
    expect(evaluateCashAuthorityFreshness(manual({ updatedAt: 'not-a-date' }), NOW).reason).toBe('INVALID_TIMESTAMP')
    expect(evaluateCashAuthorityFreshness(manual({ updatedAt: '' }), NOW).state).not.toBe('known_fresh')
  })

  it('数値契約が壊れたレコードは known_fresh にならない', () => {
    expect(evaluateCashAuthorityFreshness(
      manual({ grossCash: 100, safetyReserve: 200 }), NOW,
    ).state).toBe('stale')
  })

  it('DEFAULT は unknown（stale でも fresh でもない）', () => {
    const f = evaluateCashAuthorityFreshness(NO_CASH_AUTHORITY, NOW)
    expect(f.state).toBe('unknown')
    expect(f.reason).toBe('NO_AUTHORITY')
    expect(f.expiresAtMs).toBeNull()
  })

  it('expiresAtMs は updatedAt + 168h（ローカルTTLガードの予約時刻）', () => {
    const updatedAt = ago(HOUR)
    const f = evaluateCashAuthorityFreshness(manual({ updatedAt }), NOW)
    expect(f.expiresAtMs).toBe(Date.parse(updatedAt) + 168 * HOUR)
  })
})

describe('deriveCashAuthorityView — 凍結式（cashBaseLimit）', () => {
  it('cashBaseLimit = max(0, gross - safetyReserve - pendingOrderCash)', () => {
    const view = deriveCashAuthorityView(manual({
      grossCash: 5_000_000, safetyReserve: 1_000_000, pendingOrderCash: 500_000,
    }), NOW)
    expect(view.cashBaseLimit).toBe(3_500_000)
  })

  it('pendingOrderCash=null（不明）は差し引かないが警告対象として残る', () => {
    const view = deriveCashAuthorityView(manual({
      grossCash: 5_000_000, safetyReserve: 1_000_000, pendingOrderCash: null,
    }), NOW)
    expect(view.cashBaseLimit).toBe(4_000_000)
    expect(view.pendingOrderCash).toBeNull()
  })

  it('pendingOrderCash=0（無しを確認済み）は不明とは区別される', () => {
    const view = deriveCashAuthorityView(manual({ pendingOrderCash: 0 }), NOW)
    expect(view.pendingOrderCash).toBe(0)
  })

  it('正の pendingOrderCash はちょうど1回だけ差し引かれる', () => {
    const base = deriveCashAuthorityView(manual({
      grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 0,
    }), NOW).cashBaseLimit
    const withPending = deriveCashAuthorityView(manual({
      grossCash: 1_000_000, safetyReserve: 0, pendingOrderCash: 300_000,
    }), NOW).cashBaseLimit
    expect(base - withPending).toBe(300_000)
  })

  it('safetyReserve = grossCash なら deployable は 0（負にならない）', () => {
    const view = deriveCashAuthorityView(manual({
      grossCash: 1_000_000, safetyReserve: 1_000_000, pendingOrderCash: null,
    }), NOW)
    expect(view.cashBaseLimit).toBe(0)
  })

  it('stale では金額を参考値として保持したまま deployable が 0 になる', () => {
    const view = deriveCashAuthorityView(manual({ updatedAt: ago(200 * HOUR) }), NOW)
    expect(view.cashBaseLimit).toBe(0)
    expect(view.freshness.state).toBe('stale')
    // 権威値は 0 に落ちるが、表示用の参考値は消えない
    expect(view.grossCash).toBe(0)
    expect(view.referenceGrossCash).toBe(5_000_000)
    expect(view.referenceSafetyReserve).toBe(1_000_000)
  })

  it('未設定では参考値も 0 / null（表示すべき金額が存在しない）', () => {
    const view = deriveCashAuthorityView(NO_CASH_AUTHORITY, NOW)
    expect(view.referenceGrossCash).toBe(0)
    expect(view.referenceSafetyReserve).toBe(0)
    expect(view.referencePendingOrderCash).toBeNull()
  })

  it('unknown（未設定）でも deployable は 0', () => {
    const view = deriveCashAuthorityView(NO_CASH_AUTHORITY, NOW)
    expect(view.cashBaseLimit).toBe(0)
    expect(view.confirmedZero).toBe(false)
  })

  it('confirmed zero は unknown と区別される', () => {
    const view = deriveCashAuthorityView(manual({
      grossCash: 0, safetyReserve: 0, pendingOrderCash: 0,
    }), NOW)
    expect(view.freshness.state).toBe('known_fresh')
    expect(view.confirmedZero).toBe(true)
    expect(view.cashBaseLimit).toBe(0)
  })
})

describe('validateCashAuthorityDraft', () => {
  const draft = (over: Record<string, unknown> = {}) => validateCashAuthorityDraft({
    grossCash: '1000000',
    safetyReserve: '0',
    pendingOrderCash: '',
    updatedAt: ago(0),
    ...over,
  })

  it('空欄の pendingOrderCash は null（不明）として受理する', () => {
    const result = draft()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.pendingOrderCash).toBeNull()
  })

  it('"0" の pendingOrderCash は 0（無しを確認済み）として受理する', () => {
    const result = draft({ pendingOrderCash: '0' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.pendingOrderCash).toBe(0)
  })

  it('grossCash 空欄は reject（0へ丸めない）', () => {
    const result = draft({ grossCash: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.field === 'grossCash')).toBe(true)
  })

  it.each([['負数', '-1'], ['小数', '1234.5'], ['指数表記', '1e6'], ['記号混じり', '1,000']])(
    '%s は reject（丸めない）', (_label, value) => {
      expect(draft({ grossCash: value }).ok).toBe(false)
    },
  )

  it('NaN / Infinity は reject', () => {
    expect(draft({ grossCash: Number.NaN }).ok).toBe(false)
    expect(draft({ grossCash: Number.POSITIVE_INFINITY }).ok).toBe(false)
  })

  it('safetyReserve > grossCash は reject（安全余力を黙って減らさない）', () => {
    const result = draft({ grossCash: '1000', safetyReserve: '2000' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some(e => e.field === 'safetyReserve')).toBe(true)
  })

  it('安全余力 + 未約定 > 総現金 も reject', () => {
    expect(draft({ grossCash: '1000', safetyReserve: '600', pendingOrderCash: '500' }).ok).toBe(false)
  })

  it('不正な updatedAt は reject', () => {
    expect(draft({ updatedAt: 'not-a-date' }).ok).toBe(false)
  })

  it('0円は有効な入力（confirmed zero）', () => {
    const result = draft({ grossCash: '0', safetyReserve: '0', pendingOrderCash: '0' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.grossCash).toBe(0)
  })
})

describe('migrateLegacyCashAssumptions — 凍結された一度きりの移行', () => {
  it('manualOverrideEnabled=true は cashDeposits + standbyFunds を1回だけ合算する', () => {
    expect(migrateLegacyCashAssumptions({
      cashDeposits: 1_000_000,
      standbyFunds: 2_000_000,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-19T00:00:00.000Z',
    })).toEqual({
      source: 'MANUAL',
      grossCash: 3_000_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-07-19T00:00:00.000Z',
    })
  })

  it('manualOverrideEnabled=false は権限なしへ', () => {
    expect(migrateLegacyCashAssumptions({
      cashDeposits: 1_000_000,
      standbyFunds: 2_000_000,
      manualOverrideEnabled: false,
      manualUpdatedAt: null,
    })).toEqual(NO_CASH_AUTHORITY)
  })

  it('manualUpdatedAt 欠損時は現在時刻を捏造せず権限なしへ倒す', () => {
    expect(migrateLegacyCashAssumptions({
      cashDeposits: 1_000_000,
      standbyFunds: 0,
      manualOverrideEnabled: true,
      manualUpdatedAt: null,
    })).toEqual(NO_CASH_AUTHORITY)
  })

  it('壊れた金額は null（復元できなかったものとして fail closed）', () => {
    expect(migrateLegacyCashAssumptions({
      cashDeposits: -1, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: ago(0),
    })).toBeNull()
    expect(migrateLegacyCashAssumptions({
      cashDeposits: Number.NaN, standbyFunds: 0, manualOverrideEnabled: true, manualUpdatedAt: ago(0),
    })).toBeNull()
  })

  it('合計が1兆円を超える場合は null', () => {
    expect(migrateLegacyCashAssumptions({
      cashDeposits: CASH_AUTHORITY_MAX_JPY,
      standbyFunds: 1,
      manualOverrideEnabled: true,
      manualUpdatedAt: ago(0),
    })).toBeNull()
  })

  it('addRoom は移行されず grossCash にも加算されない', () => {
    const migrated = migrateLegacyCashAssumptions({
      cashDeposits: 1_000_000,
      standbyFunds: 2_000_000,
      manualOverrideEnabled: true,
      manualUpdatedAt: ago(0),
      // legacy レコードに addRoom が同居していても無視される
      addRoom: 9_999_999,
    } as never)
    expect(migrated?.grossCash).toBe(3_000_000)
  })
})

describe('normalizeCashAuthorityRecord — 決定的・冪等', () => {
  it('legacy を1回移行した結果を再度正規化しても変化しない（冪等）', () => {
    const legacy = {
      cashDeposits: 1_000_000,
      standbyFunds: 2_000_000,
      manualOverrideEnabled: true,
      manualUpdatedAt: '2026-07-19T00:00:00.000Z',
    }
    const once = normalizeCashAuthorityRecord(legacy)
    const twice = normalizeCashAuthorityRecord(once)
    const thrice = normalizeCashAuthorityRecord(twice)
    expect(once?.grossCash).toBe(3_000_000)
    expect(twice).toEqual(once)
    expect(thrice).toEqual(once)
  })

  it('同じ入力からは常に同じ結果になる（決定的）', () => {
    const legacy = {
      cashDeposits: 7, standbyFunds: 8, manualOverrideEnabled: true, manualUpdatedAt: ago(HOUR),
    }
    expect(normalizeCashAuthorityRecord(legacy)).toEqual(normalizeCashAuthorityRecord({ ...legacy }))
  })

  it('現行スキーマの不正レコードは null', () => {
    expect(normalizeCashAuthorityRecord({
      source: 'MANUAL', grossCash: 100, safetyReserve: 200, pendingOrderCash: null, updatedAt: ago(0),
    })).toBeNull()
  })

  it('判別できない値は null', () => {
    expect(normalizeCashAuthorityRecord(null)).toBeNull()
    expect(normalizeCashAuthorityRecord('x')).toBeNull()
    expect(normalizeCashAuthorityRecord([])).toBeNull()
    expect(normalizeCashAuthorityRecord({ foo: 1 })).toBeNull()
  })

  it('legacy の cashDeposits と standbyFunds が二重に計上されない', () => {
    const migrated = normalizeCashAuthorityRecord({
      cashDeposits: 400, standbyFunds: 600, manualOverrideEnabled: true, manualUpdatedAt: ago(0),
    })
    expect(migrated?.grossCash).toBe(1_000)
    expect(migrated?.safetyReserve).toBe(0)
  })
})
