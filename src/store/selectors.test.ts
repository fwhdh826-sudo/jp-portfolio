import { describe, expect, it } from 'vitest'
import { selectMarketDataQuality, computeSafeModeDataQuality, selectEffectiveCashAssumptions, computeCashAssumptionsFreshness, selectEffectiveSafeModeActive } from './selectors'
import type { AppState, CashAssumptions } from '../types'

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

// ── P4.5-A002: selectEffectiveCashAssumptions（資金前提の手動override） ──
describe('selectEffectiveCashAssumptions', () => {
  function makeCashState(cashAssumptions: CashAssumptions, cash = 4_000_000, cashReserve = 9_000_000): AppState {
    return { cashAssumptions, cash, cashReserve } as AppState
  }

  it('manualOverrideEnabled=false: 既定値（state.cash/state.cashReserve）を維持する', () => {
    const s = makeCashState({ cashDeposits: 999, standbyFunds: 999, manualOverrideEnabled: false, manualUpdatedAt: null })
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.cash).toBe(4_000_000)
    expect(eff.cashReserve).toBe(9_000_000)
    expect(eff.cashTotal).toBe(13_000_000)
    expect(eff.source).toBe('default')
    expect(eff.manualUpdatedAt).toBeNull()
  })

  it('manualOverrideEnabled=true: 手動値が実効値になる（既定値は無視される）', () => {
    const s = makeCashState({ cashDeposits: 1_000_000, standbyFunds: 2_000_000, manualOverrideEnabled: true, manualUpdatedAt: '2026-07-04T00:00:00.000Z' })
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.cash).toBe(1_000_000)
    expect(eff.cashReserve).toBe(2_000_000)
    expect(eff.source).toBe('manual')
    expect(eff.manualUpdatedAt).toBe('2026-07-04T00:00:00.000Z')
  })

  it('cashTotalはcashDeposits + standbyFundsで計算される（既定値の合算ではない）', () => {
    const s = makeCashState({ cashDeposits: 3_000_000, standbyFunds: 5_500_000, manualOverrideEnabled: true, manualUpdatedAt: null })
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.cashTotal).toBe(8_500_000)
  })

  it('手動値と既定値は加算されない（手動override中は既定値のstate.cash/cashReserveを一切参照しない）', () => {
    const s = makeCashState(
      { cashDeposits: 100, standbyFunds: 200, manualOverrideEnabled: true, manualUpdatedAt: null },
      4_000_000, 9_000_000,
    )
    const eff = selectEffectiveCashAssumptions(s)
    expect(eff.cash).toBe(100)
    expect(eff.cashReserve).toBe(200)
    expect(eff.cashTotal).toBe(300)
  })

  it('手動override解除（manualOverrideEnabled=false）で既定値に戻る', () => {
    const overridden = makeCashState({ cashDeposits: 1, standbyFunds: 2, manualOverrideEnabled: true, manualUpdatedAt: '2026-07-01T00:00:00.000Z' })
    const cleared = { ...overridden, cashAssumptions: { ...overridden.cashAssumptions, manualOverrideEnabled: false, manualUpdatedAt: null } }
    const eff = selectEffectiveCashAssumptions(cleared)
    expect(eff.cash).toBe(4_000_000)
    expect(eff.cashReserve).toBe(9_000_000)
    expect(eff.source).toBe('default')
  })
})

// ── P4.5-A008: computeCashAssumptionsFreshness（資金前提のstale警告・値は維持したまま） ──
describe('computeCashAssumptionsFreshness', () => {
  const NOW = Date.parse('2026-07-05T00:00:00+00:00')
  const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

  it('manualOverrideEnabled=true かつ manualUpdatedAtが8日前 → isStale=true', () => {
    const f = computeCashAssumptionsFreshness(true, daysAgo(8), NOW)
    expect(f.isStale).toBe(true)
  })

  it('manualOverrideEnabled=true かつ manualUpdatedAtが6日前 → isStale=false', () => {
    const f = computeCashAssumptionsFreshness(true, daysAgo(6), NOW)
    expect(f.isStale).toBe(false)
  })

  it('境界値: ちょうど7日前は閾値内（isStale=false）', () => {
    const f = computeCashAssumptionsFreshness(true, daysAgo(7), NOW)
    expect(f.isStale).toBe(false)
  })

  it('manualOverrideEnabled=true かつ manualUpdatedAt=null → isStale=true', () => {
    const f = computeCashAssumptionsFreshness(true, null, NOW)
    expect(f.isStale).toBe(true)
  })

  it('manualOverrideEnabled=true かつ manualUpdatedAtが不正文字列 → isStale=true', () => {
    const f = computeCashAssumptionsFreshness(true, 'not-a-date', NOW)
    expect(f.isStale).toBe(true)
  })

  it('manualOverrideEnabled=false ならmanualUpdatedAtが古くてもisStale=false（既定値使用中は警告対象外）', () => {
    const f = computeCashAssumptionsFreshness(false, daysAgo(365), NOW)
    expect(f.isStale).toBe(false)
  })

  it('manualOverrideEnabled=false かつ manualUpdatedAt=null でもisStale=false', () => {
    const f = computeCashAssumptionsFreshness(false, null, NOW)
    expect(f.isStale).toBe(false)
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
