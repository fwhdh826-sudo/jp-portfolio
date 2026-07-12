import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Trust } from '../../types'
import { detectTrustExecutionFromCsvSync } from './trustShortTracker'

// P4.5-A013-T3aの背景:
// detectTrustExecutionFromCsvSyncはwindow.localStorageに前回スナップショットを
// 保存し、次回呼び出し時との差分でexecution（提案実行/積立執行）を検出する。
// デフォルトのvitest環境（node）ではwindowが存在せずisBrowser()が常にfalseに
// なるため、window.localStorageをスタブしない限りこの関数は毎回「前回スナップ
// ショットなし」の分岐（executed:false固定）しか通らず、比較ロジック自体は
// 一度も実行されない。ここでは実際に比較ロジックへ到達させるため、
// window.localStorageを明示的にスタブする。
function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'test_fund',
    name: 'テストファンド',
    abbr: 'テスト',
    account: '特定',
    policy: 'JAPAN_SHORTTERM',
    eval: 1_000_000,
    pnlPct: 10,
    dayPct: 0,
    cost: 0.2,
    mu: 0.1,
    sigma: 0.15,
    score: 50,
    signal: 'HOLD',
    ev: 0,
    decision: 'HOLD',
    ...overrides,
  }
}

describe('detectTrustExecutionFromCsvSync', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    const lsMock = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    }
    vi.stubGlobal('window', { localStorage: lsMock })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('初回呼び出し（前回スナップショットなし）はexecuted=falseで全値が0固定', () => {
    const trust = [makeTrust({ id: 'nk225_sbi', eval: 500_000 })]
    const detection = detectTrustExecutionFromCsvSync(trust, '2026-07-10T00:00:00.000Z')
    expect(detection).toEqual({ executed: false, absDiffSum: 0, turnover: 0, changedFunds: 0 })
  })

  it('CSV欠落によりJAPAN_SHORTTERM投信がeval=0化されただけでは、executionと誤判定しない', () => {
    const day1 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 900_000 }),
    ]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    // 4x3bullがCSVから消え、full-syncにより物理削除ではなくeval=0化される
    const day2 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 0 }),
    ]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    expect(detection.executed).toBe(false)
    expect(detection.absDiffSum).toBe(0)
    expect(detection.changedFunds).toBe(0)
    expect(detection.turnover).toBe(0)
  })

  it('単純な解約/売却（eval減少）だけではexecution=trueにならない', () => {
    const day1 = [makeTrust({ id: 'nk225_sbi', eval: 900_000 })]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    // 解約により大幅減少（900,000 -> 100,000）だが、CSVには残っている
    const day2 = [makeTrust({ id: 'nk225_sbi', eval: 100_000 })]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    expect(detection.executed).toBe(false)
    expect(detection.absDiffSum).toBe(0)
    expect(detection.changedFunds).toBe(0)
    expect(detection.turnover).toBe(0)
  })

  it('複数投信の一部解約（複数ファンドがeval=0化）でも誤検出しない', () => {
    const day1 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 900_000 }),
      makeTrust({ id: 'nk225_bear', eval: 300_000 }),
    ]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    // 4x3bull・nk225_bearの2本がCSVから消え、eval=0化される
    const day2 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 0 }),
      makeTrust({ id: 'nk225_bear', eval: 0 }),
    ]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    expect(detection.executed).toBe(false)
    expect(detection.absDiffSum).toBe(0)
    expect(detection.changedFunds).toBe(0)
  })

  it('通常積立や軽微な評価額変動（各ファンド閾値未満の増減）ではexecution扱いにならない', () => {
    const day1 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 900_000 }),
    ]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    // 通常の相場変動による軽微な増減（各ファンド50,000円未満）
    const day2 = [
      makeTrust({ id: 'nk225_sbi', eval: 512_000 }), // +12,000
      makeTrust({ id: '4x3bull', eval: 885_000 }),   // -15,000（減少は集計対象外）
    ]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    expect(detection.executed).toBe(false)
    expect(detection.absDiffSum).toBe(12_000)
    expect(detection.changedFunds).toBe(0)
    expect(detection.turnover).toBeCloseTo(12_000 / 1_400_000, 4)
  })

  it('実際に提案実行と判断すべき増額ケース（単一ファンドの大幅増額）ではexecuted=trueを維持する', () => {
    const day1 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 900_000 }),
    ]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    // 4x3bullへ300,000円分買い増し（提案実行）
    const day2 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 1_200_000 }),
    ]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    expect(detection.executed).toBe(true)
    expect(detection.absDiffSum).toBe(300_000)
    expect(detection.changedFunds).toBe(1)
    expect(detection.turnover).toBeCloseTo(300_000 / 1_400_000, 4)
  })

  it('増額と解約が同時に起きても、解約分は無視し増額分のみでexecution判定する', () => {
    const day1 = [
      makeTrust({ id: 'nk225_sbi', eval: 500_000 }),
      makeTrust({ id: '4x3bull', eval: 900_000 }),
    ]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    // nk225_sbiへ250,000円買い増し、同時に4x3bullがCSV欠落でeval=0化
    const day2 = [
      makeTrust({ id: 'nk225_sbi', eval: 750_000 }),
      makeTrust({ id: '4x3bull', eval: 0 }),
    ]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    // 増額分（250,000）のみで判定: turnover = 250,000/1,400,000 ≒ 0.1786 >= 0.04
    expect(detection.absDiffSum).toBe(250_000)
    expect(detection.changedFunds).toBe(1)
    expect(detection.executed).toBe(true)
  })

  it('2ファンド同時増額の境界値（changedFunds>=2かつabsDiffSum>=120,000）でexecuted=true', () => {
    const day1 = [
      makeTrust({ id: 'a', eval: 500_000 }),
      makeTrust({ id: 'b', eval: 500_000 }),
    ]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    const day2 = [
      makeTrust({ id: 'a', eval: 560_000 }), // +60,000
      makeTrust({ id: 'b', eval: 560_000 }), // +60,000
    ]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    expect(detection.absDiffSum).toBe(120_000)
    expect(detection.changedFunds).toBe(2)
    expect(detection.executed).toBe(true)
  })

  it('2ファンド同時増額でも境界未満（absDiffSum<120,000）ならexecuted=falseのまま', () => {
    const day1 = [
      makeTrust({ id: 'a', eval: 500_000 }),
      makeTrust({ id: 'b', eval: 500_000 }),
    ]
    detectTrustExecutionFromCsvSync(day1, '2026-07-10T00:00:00.000Z')

    const day2 = [
      makeTrust({ id: 'a', eval: 559_000 }), // +59,000
      makeTrust({ id: 'b', eval: 559_000 }), // +59,000
    ]
    const detection = detectTrustExecutionFromCsvSync(day2, '2026-07-11T00:00:00.000Z')

    expect(detection.absDiffSum).toBe(118_000)
    expect(detection.changedFunds).toBe(2)
    expect(detection.executed).toBe(false)
  })
})
