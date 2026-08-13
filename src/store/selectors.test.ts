import { describe, expect, it } from 'vitest'
import { selectMarketDataQuality, computeSafeModeDataQuality, selectEffectiveCashAssumptions, computeCashAssumptionsFreshness, selectEffectiveSafeModeActive } from './selectors'
import type { AppState, CashAssumptions } from '../types'
import { DEFAULT_CASH_ASSUMPTIONS } from '../types'

// selectMarketDataQuality が参照するフィールドのみを持つ最小state
function makeState(
  marketSource: 'loaded' | 'static' | 'error',
  marketTimestamp: string | null,
): AppState {
  return {
    system: {
      dataSourceStatus: { market: marketSource } as AppState['system']['dataSourceStatus'],
      dataTimestamps: { market: marketTimestamp } as AppState['system']['dataTimestamps'],
    } as AppState['system'],
    market: { last_updated: '' } as AppState['market'],
  } as AppState
}

// 現時刻から相対的なタイムスタンプ文字列を生成（"YYYY-MM-DD HH:mm" JST形式）
function relativeTimestamp(offsetHours: number): string {
  const d = new Date(Date.now() + offsetHours * 60 * 60 * 1000)
  return d.toISOString().replace('T', ' ').slice(0, 16)
}

// 内部用語がreasonに含まれないことを確認するguard
const INTERNAL_TERMS = ['marketデータ', 'staticフォールバック', 'fallback', 'dataQualitySuppressed', 'dqSuppressed']

function assertNoInternalTerms(reason: string | null) {
  if (reason === null) return
  for (const term of INTERNAL_TERMS) {
    expect(reason, `reason should not contain "${term}"`).not.toContain(term)
  }
}

// ── selectMarketDataQuality ───────────────────────────────────
describe('selectMarketDataQuality', () => {
  it('source=error: suppressed, level=error, reasonにデータ取得エラーを含む', () => {
    const dq = selectMarketDataQuality(makeState('error', null))
    expect(dq.isSuppressed).toBe(true)
    expect(dq.level).toBe('error')
    expect(dq.reason).toContain('データ取得エラー')
    assertNoInternalTerms(dq.reason)
  })

  it('source=static: suppressed, level=static, reasonにデータ更新失敗を含む', () => {
    const dq = selectMarketDataQuality(makeState('static', null))
    expect(dq.isSuppressed).toBe(true)
    expect(dq.level).toBe('static')
    expect(dq.reason).toContain('データ更新失敗')
    expect(dq.reason).not.toContain('staticフォールバック')
    assertNoInternalTerms(dq.reason)
  })

  it('timestamp missing: suppressed, level=stale, reasonに更新日時確認不可を含む', () => {
    const dq = selectMarketDataQuality(makeState('loaded', null))
    expect(dq.isSuppressed).toBe(true)
    expect(dq.level).toBe('stale')
    expect(dq.reason).toContain('データの更新日時を確認できません')
    assertNoInternalTerms(dq.reason)
  })

  it('stale timestamp: suppressed, level=stale, reasonに時間超過文言を含む', () => {
    const staleTs = relativeTimestamp(-25) // 25時間前（閾値24h超過）
    const dq = selectMarketDataQuality(makeState('loaded', staleTs))
    expect(dq.isSuppressed).toBe(true)
    expect(dq.level).toBe('stale')
    expect(dq.reason).toContain('データが')
    expect(dq.reason).toContain('時間以上更新されていません')
    assertNoInternalTerms(dq.reason)
  })

  it('fresh timestamp: not suppressed, level=ok, reason=null', () => {
    const freshTs = relativeTimestamp(-1) // 1時間前（閾値以内）
    const dq = selectMarketDataQuality(makeState('loaded', freshTs))
    expect(dq.isSuppressed).toBe(false)
    expect(dq.level).toBe('ok')
    expect(dq.reason).toBeNull()
  })

  it('regression guard: 全suppressed stateのreasonに内部用語が含まれない', () => {
    const staleTs = relativeTimestamp(-25)
    const cases = [
      selectMarketDataQuality(makeState('error', null)),
      selectMarketDataQuality(makeState('static', null)),
      selectMarketDataQuality(makeState('loaded', null)),
      selectMarketDataQuality(makeState('loaded', staleTs)),
    ]
    for (const dq of cases) {
      expect(dq.isSuppressed).toBe(true)
      assertNoInternalTerms(dq.reason)
    }
  })
})

// ── P4-A159: computeSafeModeDataQuality (safe_mode.json鮮度ゲート / Fable監査A4) ──
describe('computeSafeModeDataQuality', () => {
  const NOW = Date.parse('2026-07-04T00:00:00+00:00')
  const isoHoursAgo = (hours: number) => new Date(NOW - hours * 60 * 60 * 1000).toISOString()

  it('fresh: source=loaded かつ last_checked が閾値内 → isStale=false, level=ok', () => {
    const dq = computeSafeModeDataQuality(isoHoursAgo(1), 'loaded', NOW)
    expect(dq.isStale).toBe(false)
    expect(dq.level).toBe('ok')
    expect(dq.reason).toBeNull()
  })

  it('境界値: ちょうど96時間前は閾値内（fresh）', () => {
    const dq = computeSafeModeDataQuality(isoHoursAgo(96), 'loaded', NOW)
    expect(dq.isStale).toBe(false)
    expect(dq.level).toBe('ok')
  })

  it('stale: last_checkedが96時間超過 → isStale=true, level=stale', () => {
    const dq = computeSafeModeDataQuality(isoHoursAgo(97), 'loaded', NOW)
    expect(dq.isStale).toBe(true)
    expect(dq.level).toBe('stale')
    expect(dq.reason).toContain('時間以上更新されていません')
  })

  it('欠損: last_checkedがnull → isStale=true, level=stale（fail-closed）', () => {
    const dq = computeSafeModeDataQuality(null, 'loaded', NOW)
    expect(dq.isStale).toBe(true)
    expect(dq.level).toBe('stale')
    expect(dq.reason).toContain('last_checked')
  })

  it('欠損: last_checkedがundefined → isStale=true, level=stale（fail-closed）', () => {
    const dq = computeSafeModeDataQuality(undefined, 'loaded', NOW)
    expect(dq.isStale).toBe(true)
    expect(dq.level).toBe('stale')
  })

  it('欠損: last_checkedが空文字列 → isStale=true, level=stale（fail-closed）', () => {
    const dq = computeSafeModeDataQuality('', 'loaded', NOW)
    expect(dq.isStale).toBe(true)
    expect(dq.level).toBe('stale')
  })

  it('不正: last_checkedが不正な日時文字列 → isStale=true, level=stale（fail-closed）', () => {
    const dq = computeSafeModeDataQuality('not-a-valid-date', 'loaded', NOW)
    expect(dq.isStale).toBe(true)
    expect(dq.level).toBe('stale')
    expect(dq.reason).toContain('不正')
  })

  it('取得不可: source=default → isStale=true, level=unavailable（fail-closed）', () => {
    const dq = computeSafeModeDataQuality(isoHoursAgo(1), 'default', NOW)
    expect(dq.isStale).toBe(true)
    expect(dq.level).toBe('unavailable')
    expect(dq.reason).toContain('safe_mode.json')
  })

  it('取得不可: source=undefined → isStale=true, level=unavailable（fail-closed）', () => {
    const dq = computeSafeModeDataQuality(isoHoursAgo(1), undefined, NOW)
    expect(dq.isStale).toBe(true)
    expect(dq.level).toBe('unavailable')
  })
})

// ── CASH-AUTH-1: selectEffectiveCashAssumptions（現金権限の実効値） ──
describe('selectEffectiveCashAssumptions', () => {
  function makeCashState(cashAssumptions: CashAssumptions, cash = 4_000_000, cashReserve = 9_000_000): AppState {
    return { cashAssumptions, cash, cashReserve } as AppState
  }

  it('DEFAULT（権限なし）は既定値もCSVも参照せず0を返す（金額を捏造しない）', () => {
    const s = makeCashState({ source: 'DEFAULT', grossCash: 0, safetyReserve: 0, pendingOrderCash: null, updatedAt: null })
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.grossCash).toBe(0)
    expect(eff.safetyReserve).toBe(0)
    expect(eff.pendingOrderCash).toBeNull()
    expect(eff.cashTotal).toBe(0)
    expect(eff.source).toBe('default')
    expect(eff.updatedAt).toBeNull()
  })

  it('MANUAL: 権限の値がそのまま実効値になる（legacyのstate.cash/cashReserveは無視される）', () => {
    const s = makeCashState({
      source: 'MANUAL',
      grossCash: 3_000_000,
      safetyReserve: 500_000,
      pendingOrderCash: 200_000,
      updatedAt: '2026-07-04T00:00:00.000Z',
    })
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.grossCash).toBe(3_000_000)
    expect(eff.safetyReserve).toBe(500_000)
    expect(eff.pendingOrderCash).toBe(200_000)
    expect(eff.source).toBe('manual')
    expect(eff.updatedAt).toBe('2026-07-04T00:00:00.000Z')
  })

  it('cashTotalは常にgrossCashと等しい（安全余力・未約定は部分集合であり加算しない）', () => {
    const s = makeCashState({
      source: 'MANUAL',
      grossCash: 8_500_000,
      safetyReserve: 1_000_000,
      pendingOrderCash: 500_000,
      updatedAt: '2026-07-04T00:00:00.000Z',
    })
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.cashTotal).toBe(8_500_000)
  })

  it('権限と既定値は加算されない（MANUAL中はstate.cash/cashReserveを一切参照しない）', () => {
    const s = makeCashState(
      { source: 'MANUAL', grossCash: 300, safetyReserve: 0, pendingOrderCash: null, updatedAt: '2026-07-04T00:00:00.000Z' },
      4_000_000, 9_000_000,
    )
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.grossCash).toBe(300)
    expect(eff.cashTotal).toBe(300)
  })

  it('権限を削除するとDEFAULT（未設定）に戻り、既定値へは落ちない', () => {
    const overridden = makeCashState({ source: 'MANUAL', grossCash: 3, safetyReserve: 0, pendingOrderCash: null, updatedAt: '2026-07-01T00:00:00.000Z' })
    const cleared = { ...overridden, cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS } }
    const eff = selectEffectiveCashAssumptions(cleared)
    expect(eff.grossCash).toBe(0)
    expect(eff.cashTotal).toBe(0)
    expect(eff.source).toBe('default')
  })
})

// ── CASH-AUTH-1: computeCashAssumptionsFreshness（168h TTL / 144h 事前警告） ──
describe('computeCashAssumptionsFreshness', () => {
  const NOW = Date.parse('2026-07-05T00:00:00+00:00')
  const HOUR = 60 * 60 * 1000
  const hoursAgo = (hours: number) => new Date(NOW - hours * HOUR).toISOString()
  const manual = (updatedAt: string | null): CashAssumptions => ({
    source: 'MANUAL',
    grossCash: 1_000_000,
    safetyReserve: 0,
    pendingOrderCash: null,
    updatedAt,
  })

  it('168hを1msでも超えると stale', () => {
    const f = computeCashAssumptionsFreshness(manual(new Date(NOW - (168 * HOUR + 1)).toISOString()), NOW)
    expect(f.state).toBe('stale')
    expect(f.isStale).toBe(true)
    expect(f.reason).toBe('EXPIRED')
  })

  it('ちょうど168hはまだ fresh（`>` 境界を維持する）', () => {
    const f = computeCashAssumptionsFreshness(manual(hoursAgo(168)), NOW)
    expect(f.state).toBe('known_fresh')
    expect(f.isStale).toBe(false)
    expect(f.approachingExpiry).toBe(true)
  })

  it('144h経過で approachingExpiry になるが、まだ fresh のまま', () => {
    const f = computeCashAssumptionsFreshness(manual(hoursAgo(144)), NOW)
    expect(f.state).toBe('known_fresh')
    expect(f.approachingExpiry).toBe(true)
  })

  it('143h59mではまだ approachingExpiry にならない', () => {
    const f = computeCashAssumptionsFreshness(manual(new Date(NOW - (144 * HOUR - 60_000)).toISOString()), NOW)
    expect(f.state).toBe('known_fresh')
    expect(f.approachingExpiry).toBe(false)
  })

  it('updatedAt が未来なら known_fresh にはならない', () => {
    const f = computeCashAssumptionsFreshness(manual(new Date(NOW + HOUR).toISOString()), NOW)
    expect(f.state).toBe('stale')
    expect(f.reason).toBe('FUTURE_TIMESTAMP')
  })

  it('updatedAt が欠損なら stale', () => {
    const f = computeCashAssumptionsFreshness(manual(null), NOW)
    expect(f.state).toBe('stale')
    expect(f.reason).toBe('MISSING_TIMESTAMP')
  })

  it('updatedAt が不正文字列なら stale', () => {
    const f = computeCashAssumptionsFreshness(manual('not-a-date'), NOW)
    expect(f.state).toBe('stale')
    expect(f.reason).toBe('INVALID_TIMESTAMP')
  })

  it('DEFAULT（権限なし）は unknown であり、stale でも fresh でもない', () => {
    const f = computeCashAssumptionsFreshness({ ...DEFAULT_CASH_ASSUMPTIONS }, NOW)
    expect(f.state).toBe('unknown')
    expect(f.isStale).toBe(false)
    expect(f.reason).toBe('NO_AUTHORITY')
  })

  it('confirmed zero（0円・有効な時刻）は known_fresh であり unknown ではない', () => {
    const f = computeCashAssumptionsFreshness({
      source: 'MANUAL',
      grossCash: 0,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: hoursAgo(1),
    }, NOW)
    expect(f.state).toBe('known_fresh')
  })
})

// ── P4.5-A011: selectEffectiveSafeModeActive（raw active OR データ鮮度によるfail-closed） ──
describe('selectEffectiveSafeModeActive', () => {
  function makeSafeModeState(
    active: boolean,
    safeModeSource: 'loaded' | 'default' | undefined,
    safeModeLastChecked: string | null | undefined,
  ): AppState {
    return {
      safeMode: { safe_mode: { active } } as AppState['safeMode'],
      system: {
        dataSourceStatus: { safeMode: safeModeSource } as AppState['system']['dataSourceStatus'],
        dataTimestamps: { safeMode: safeModeLastChecked } as AppState['system']['dataTimestamps'],
      } as AppState['system'],
    } as AppState
  }

  const freshTimestamp = new Date().toISOString()

  it('safe_mode.active=true のとき、データが新鮮でもtrue', () => {
    const s = makeSafeModeState(true, 'loaded', freshTimestamp)
    expect(selectEffectiveSafeModeActive(s)).toBe(true)
  })

  it('safe_mode.active=false かつ safe_mode dataがstale（取得不可）のときtrue（fail-closed）', () => {
    const s = makeSafeModeState(false, 'default', null)
    expect(selectEffectiveSafeModeActive(s)).toBe(true)
  })

  it('safe_mode.active=false かつ safe_mode dataがstale（鮮度超過）のときtrue（fail-closed）', () => {
    const staleTs = new Date(Date.now() - 97 * 60 * 60 * 1000).toISOString() // 97時間前（閾値96h超過）
    const s = makeSafeModeState(false, 'loaded', staleTs)
    expect(selectEffectiveSafeModeActive(s)).toBe(true)
  })

  it('safe_mode.active=false かつ dataが新鮮なときfalse', () => {
    const s = makeSafeModeState(false, 'loaded', freshTimestamp)
    expect(selectEffectiveSafeModeActive(s)).toBe(false)
  })
})
