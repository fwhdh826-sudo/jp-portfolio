// P4-A150: SafeModeStatusCard — TierA監視データunavailable判定・カード表示条件のテスト
// Fable監査S4対応: 「監視不能」と「違反なし」がUIで同じ見た目にならないことを確認する。
import { describe, expect, it } from 'vitest'
import { isTierADataUnavailable, shouldShowSafeModeStatusCard, isSafeModeDataStale } from './SafeModeStatusCard'

describe('isTierADataUnavailable', () => {
  it('tierAViolations.status="unavailable"のときtrue', () => {
    expect(isTierADataUnavailable({ status: 'unavailable' }, { status: 'ok' })).toBe(true)
  })

  it('tierAAlerts.status="unavailable"のときtrue', () => {
    expect(isTierADataUnavailable({ status: 'ok' }, { status: 'unavailable' })).toBe(true)
  })

  it('両方"ok"のときfalse', () => {
    expect(isTierADataUnavailable({ status: 'ok' }, { status: 'ok' })).toBe(false)
  })

  it('"degraded"はunavailable扱いにしない（部分的に取得できている状態）', () => {
    expect(isTierADataUnavailable({ status: 'degraded' }, { status: 'ok' })).toBe(false)
  })
})

describe('shouldShowSafeModeStatusCard', () => {
  const allFalseInput = {
    active: false,
    isDefault: false,
    triggeredViolationsCount: 0,
    triggeredAlertsCount: 0,
    isTierAUnavailable: false,
    t1ViolationsCount: 0,
  }

  it('全条件falseなら非表示（false）— 平常時にカードがsilentに消える', () => {
    expect(shouldShowSafeModeStatusCard(allFalseInput)).toBe(false)
  })

  it('isTierAUnavailable=trueのみでも表示される（P4-A150の核心）', () => {
    expect(shouldShowSafeModeStatusCard({ ...allFalseInput, isTierAUnavailable: true })).toBe(true)
  })

  it('t1ViolationsCount>0のみでも表示される（P4-A150の核心）', () => {
    expect(shouldShowSafeModeStatusCard({ ...allFalseInput, t1ViolationsCount: 1 })).toBe(true)
  })

  it('active=trueのみで表示される（既存挙動維持）', () => {
    expect(shouldShowSafeModeStatusCard({ ...allFalseInput, active: true })).toBe(true)
  })

  it('isDefault=trueのみで表示される（既存挙動維持）', () => {
    expect(shouldShowSafeModeStatusCard({ ...allFalseInput, isDefault: true })).toBe(true)
  })

  it('triggeredViolationsCount>0のみで表示される（既存挙動維持）', () => {
    expect(shouldShowSafeModeStatusCard({ ...allFalseInput, triggeredViolationsCount: 1 })).toBe(true)
  })

  it('triggeredAlertsCount>0のみで表示される（既存挙動維持）', () => {
    expect(shouldShowSafeModeStatusCard({ ...allFalseInput, triggeredAlertsCount: 1 })).toBe(true)
  })

  // P4-A159: SAFE_MODEデータ鮮度問題（Fable監査A4対応）
  it('isStaleData=trueのみでも表示される（鮮度問題をsilentに消さない）', () => {
    expect(shouldShowSafeModeStatusCard({ ...allFalseInput, isStaleData: true })).toBe(true)
  })

  it('isStaleData未指定（undefined）なら他条件がfalseのとき非表示のまま（既存呼び出し元との後方互換）', () => {
    expect(shouldShowSafeModeStatusCard(allFalseInput)).toBe(false)
  })
})

// P4-A159: isDefault（safe_mode.json取得不可）とisStaleData（loadedしたが鮮度NG）の重複回避
describe('isSafeModeDataStale', () => {
  it('dataQuality.isStale=true かつ isDefault=false → true（loadedしたが鮮度NGの新規表示）', () => {
    expect(isSafeModeDataStale({ isStale: true }, false)).toBe(true)
  })

  it('dataQuality.isStale=true でも isDefault=true → false（既存のisDefault表示と重複させない）', () => {
    expect(isSafeModeDataStale({ isStale: true }, true)).toBe(false)
  })

  it('dataQuality.isStale=false → false（freshなら常にfalse）', () => {
    expect(isSafeModeDataStale({ isStale: false }, false)).toBe(false)
    expect(isSafeModeDataStale({ isStale: false }, true)).toBe(false)
  })
})
