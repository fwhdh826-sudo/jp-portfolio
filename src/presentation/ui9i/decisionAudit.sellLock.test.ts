// ═══════════════════════════════════════════════════════════
// F-05 (P2): Decision Audit の 90日ロック判定は、注入された監査基準時刻を使う。
//
// 以前は isSellLocked(h) を now なしで呼んでおり、他の値（Hero 状態・鮮度・
// Home の注目ポイント）が注入時刻で決まるのに対しロックだけが実行時の壁時計で
// 決まっていた。ここでは固定 now のみで結論が決まることを証明する。
// 売却可能日の表示は getSellableDate() のまま（残日数・カウントダウンは作らない）。
// ═══════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { STOCK_SELL_LOCK_DAYS } from '../../domain/constraints/stockLock'
import { selectDecisionAuditViewModel } from './decisionAudit'
import { selectTodayHomeViewModel } from './todayHome'
import { fixtureDecision } from './ui9i.fixtures'

const isolated = createAppStoreInstanceForTest()
const BASE: AppState = isolated.store.getState()
isolated.controls.dispose()

const ACQUIRED_AT = '2026-07-22'
/** 取得日 + 90日 = canonical な売却可能日。 */
const SELLABLE_AT_MS = Date.parse(`${ACQUIRED_AT}T00:00:00.000Z`) + STOCK_SELL_LOCK_DAYS * 86_400_000

function stateWithLockedHolding(): AppState {
  return {
    ...BASE,
    system: { ...BASE.system, status: 'success' },
    officialDecision: fixtureDecision(),
    holdings: [{ ...BASE.holdings[0], code: '9697', name: 'テスト', lock: true, acquiredAt: ACQUIRED_AT }],
  }
}

const auditLocks = (now: number) => selectDecisionAuditViewModel(stateWithLockedHolding(), now).constraints.locks
const homeLockIds = (now: number) =>
  selectTodayHomeViewModel(stateWithLockedHolding(), now).attention.filter(a => a.id.startsWith('lock-')).map(a => a.id)

describe('F-05 90日ロックは注入された now で判定する', () => {
  it('canonical 境界の前: ロック中（売却可能予定日は getSellableDate の再掲）', () => {
    const locks = auditLocks(SELLABLE_AT_MS - 86_400_000)
    expect(locks).toEqual([{ code: '9697', sellableLabel: '10/20' }])
  })

  it('canonical 境界の直前（1 分前）: まだロック中', () => {
    expect(auditLocks(SELLABLE_AT_MS - 60_000)).toHaveLength(1)
  })

  it('canonical 境界以後: 既存権限（isSellLocked）に従ってロック解除', () => {
    expect(auditLocks(SELLABLE_AT_MS)).toEqual([])
    expect(auditLocks(SELLABLE_AT_MS + 86_400_000)).toEqual([])
  })

  it('壁時計に依存しない: 同じ注入 now は常に同じ結論を返す', () => {
    const before = SELLABLE_AT_MS - 86_400_000
    const after = SELLABLE_AT_MS + 86_400_000
    for (let i = 0; i < 3; i += 1) {
      expect(auditLocks(before)).toHaveLength(1)
      expect(auditLocks(after)).toHaveLength(0)
    }
    // 取得日から遠い過去・遠い未来でも now だけで決まる
    expect(auditLocks(Date.parse('2020-01-01T00:00:00Z'))).toHaveLength(1)
    expect(auditLocks(Date.parse('2099-01-01T00:00:00Z'))).toHaveLength(0)
  })

  it('Home と Decision Audit は同じ注入 now で一致する', () => {
    for (const now of [SELLABLE_AT_MS - 86_400_000, SELLABLE_AT_MS - 60_000, SELLABLE_AT_MS, SELLABLE_AT_MS + 86_400_000]) {
      expect(auditLocks(now).map(l => `lock-${l.code}`), new Date(now).toISOString()).toEqual(homeLockIds(now))
    }
  })

  it('残日数・カウントダウンは作らない', () => {
    const json = JSON.stringify(auditLocks(SELLABLE_AT_MS - 86_400_000))
    expect(json).not.toMatch(/残り|あと\d+日|remainingDays/)
  })
})
