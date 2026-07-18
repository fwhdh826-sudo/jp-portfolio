import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Trust } from '../../types'
import {
  detectTrustExecutionFromCsvSync,
  stageTrustExecutionFromCsvSync,
  getTrustShortRecentEntries,
  getTrustShortFilterTuning,
  getTrustShortTodayExecutionCount,
  getTrustShortTrackingStats,
  captureTrustShortAnalysisInput,
  recordTrustShortDecision,
} from './trustShortTracker'
import type { TrustShortTrackerEntry } from './trustShortTracker'

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

describe('R4-A004b: trust-short baseline clock is normalized to a JST calendar day', () => {
  const baseline = { status: 'none' as const, snapshot: null }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([
    ['2026-07-18T14:59:59.999Z', '2026-07-18'],
    ['2026-07-18T15:00:00.000Z', '2026-07-19'],
    ['2026-12-31T14:59:59.999Z', '2026-12-31'],
    ['2026-12-31T15:00:00.000Z', '2027-01-01'],
    ['2028-02-28T15:00:00.000Z', '2028-02-29'],
    ['2028-02-29T15:00:00.000Z', '2028-03-01'],
  ])('%s becomes JST day %s', (instant, expectedDate) => {
    const staged = stageTrustExecutionFromCsvSync([makeTrust()], Date.parse(instant), baseline)
    expect(staged.snapshot.date).toBe(expectedDate)
  })

  it('same instant in Z and +09:00 representations yields the same complete snapshot', () => {
    const trust = [makeTrust({ id: 'same-instant', eval: 345_678 })]
    const utc = stageTrustExecutionFromCsvSync(trust, '2026-07-18T15:00:00.000Z', baseline)
    const jst = stageTrustExecutionFromCsvSync(trust, '2026-07-19T00:00:00.000+09:00', baseline)

    expect(utc.snapshot).toEqual({
      date: '2026-07-19',
      total: 345_678,
      evalById: { 'same-instant': 345_678 },
    })
    expect(jst.snapshot).toEqual(utc.snapshot)
  })

  it('preserves strict date-only string compatibility as an explicit JST day', () => {
    expect(stageTrustExecutionFromCsvSync([], '2026-07-19', baseline).snapshot.date)
      .toBe('2026-07-19')
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    8_640_000_000_000_001,
    '',
    'not-a-timestamp',
    '2026-02-30',
    '2026-07-19T00:00:00+24:00',
  ])('rejects invalid clock %j before any direct-helper storage access or write', clock => {
    const existing = JSON.stringify({ date: '2026-07-01', total: 1, evalById: { old: 1 } })
    const getItem = vi.fn(() => existing)
    const setItem = vi.fn()
    const removeItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { getItem, setItem, removeItem } })

    expect(() => detectTrustExecutionFromCsvSync([], clock)).toThrow(TypeError)
    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })

  it('captures the default Date.now once and writes the resulting JST date', () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value },
        removeItem: (key: string) => { delete store[key] },
      },
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-18T15:00:00.000Z'))

    detectTrustExecutionFromCsvSync([])

    expect(now).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.v95_trust_short_snapshot).date).toBe('2026-07-19')
    now.mockRestore()
  })
})

describe('trust-short 30日windowはJST（Asia/Tokyo）暦日基準で、host timezoneに非依存', () => {
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

  function seedEntries(dates: string[]) {
    const entries: TrustShortTrackerEntry[] = dates.map(date => ({
      date,
      decision: 'BULL',
      confidence: 90,
      executed: true,
      outcome: 'win',
      nikkeiChgPct: 1,
      futuresChgPct: 1,
      conditionsPassed: 5,
      vix: 15,
      nikkeiVI: 18,
      volatilitySpread: 0,
      updatedAt: `${date}T00:00:00.000Z`,
    }))
    store.v95_trust_short_tracker = JSON.stringify({ entries })
  }

  it('A: UTC上ではまだ当日でもJSTでは日付が繰り上がっている場合、30日windowはJST基準でcutoff当日を含み前日は除外する', () => {
    const nowMs = new Date('2026-07-15T16:00:00.000Z').getTime() // JST: 2026-07-16

    seedEntries(['2026-06-15'])
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(0)

    seedEntries(['2026-06-16'])
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(1)
  })

  it('B: 同じシナリオはTZ環境変数に関わらず一致する（host timezoneに非依存な実装のため、UTC/JST双方のprocess環境で手動実行して確認済み）', () => {
    const nowMs = new Date('2026-07-15T16:00:00.000Z').getTime()
    seedEntries(['2026-06-15', '2026-06-16'])
    const recent = getTrustShortRecentEntries(30, nowMs)
    expect(recent.map(entry => entry.date)).toEqual(['2026-06-16'])
  })

  it('C: JST日付境界はUTC 15:00で切り替わる（14:59:59は当日、15:00:00は翌日）', () => {
    seedEntries(['2026-06-16'])
    const before = new Date('2026-07-15T14:59:59.000Z').getTime() // JST: 2026-07-15 → cutoff 2026-06-15
    const after = new Date('2026-07-15T15:00:00.000Z').getTime() // JST: 2026-07-16 → cutoff 2026-06-16

    expect(getTrustShortRecentEntries(30, before)).toHaveLength(1)
    expect(getTrustShortRecentEntries(30, after)).toHaveLength(1) // cutoff当日は含む

    seedEntries(['2026-06-15'])
    expect(getTrustShortRecentEntries(30, after)).toHaveLength(0) // afterのcutoffは2026-06-16なので除外
  })

  it('D: 閏年・月境界をまたぐ30日window（2024-02-29はJSTで2024-03-01扱い）', () => {
    const nowMs = new Date('2024-02-29T15:00:00.000Z').getTime() // JST: 2024-03-01

    seedEntries(['2024-01-30'])
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(0)

    seedEntries(['2024-01-31'])
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(1)
  })

  it('存在しない暦日（例: 2026-02-30）のentry.dateは30日windowから厳密に除外される', () => {
    seedEntries(['2026-02-30'])
    const nowMs = new Date('2026-03-15T00:00:00.000Z').getTime()
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(0)
  })
})

function stubLocalStorage() {
  const store: Record<string, string> = {}
  const lsMock = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }
  vi.stubGlobal('window', { localStorage: lsMock })
  return store
}

function stubSpiedLocalStorage() {
  const store: Record<string, string> = {}
  const getItem = vi.fn((key: string) => store[key] ?? null)
  const setItem = vi.fn((key: string, value: string) => { store[key] = value })
  const removeItem = vi.fn((key: string) => { delete store[key] })
  vi.stubGlobal('window', { localStorage: { getItem, setItem, removeItem } })
  return { store, getItem, setItem, removeItem }
}

function seedTrackerEntries(store: Record<string, string>, dates: string[]) {
  const entries: TrustShortTrackerEntry[] = dates.map(date => ({
    date,
    decision: 'BULL',
    confidence: 90,
    executed: true,
    outcome: 'win',
    nikkeiChgPct: 1,
    futuresChgPct: 1,
    conditionsPassed: 5,
    vix: 15,
    nikkeiVI: 18,
    volatilitySpread: 0,
    updatedAt: `${date}T00:00:00.000Z`,
  }))
  store.v95_trust_short_tracker = JSON.stringify({ entries })
}

// ECMA-262 Dateの表現可能範囲の上限（±8.64e15ms）。src/domain/learning/trustShortTracker.ts の
// MAX_DATE_EPOCH_MS と同じ値をテスト側で独立に定義している。
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

// Date.UTC(year, ...)は年0〜99を1900〜1999年へ丸めるため、setUTCFullYearで構築する。
function utcMsForYear(year: number, month: number, day: number): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getTime()
}

const JST_YEAR_BELOW_0001_NOW_MS = utcMsForYear(0, 1, 1) - JST_OFFSET_MS

const INVALID_NOW_MS_CASES: Array<[string, number]> = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['Date表現範囲外（超過）', MAX_DATE_EPOCH_MS + 1],
  ['Date表現範囲外（下限未満）', -MAX_DATE_EPOCH_MS - 1],
  ['JST offset加算後にDate表現範囲外', MAX_DATE_EPOCH_MS - 100],
  ['JST calendar yearが0001未満', JST_YEAR_BELOW_0001_NOW_MS],
  ['JST calendar yearが9999超過', 253_402_268_400_000], // JST 10000-01-01T00:00:00
]

describe('F1: invalid nowMsは統一してTypeErrorをrejectする（0件・0統計として隠蔽しない）', () => {
  let store: Record<string, string>

  beforeEach(() => { store = stubLocalStorage() })
  afterEach(() => { vi.unstubAllGlobals() })

  it.each(INVALID_NOW_MS_CASES)('getTrustShortTodayExecutionCount: %s はTypeError', (_label, nowMs) => {
    expect(() => getTrustShortTodayExecutionCount(nowMs)).toThrow(TypeError)
  })

  it.each(INVALID_NOW_MS_CASES)('getTrustShortTrackingStats: %s はTypeError（空統計を返さない）', (_label, nowMs) => {
    expect(() => getTrustShortTrackingStats(nowMs)).toThrow(TypeError)
  })

  it.each(INVALID_NOW_MS_CASES)('getTrustShortRecentEntries: %s はTypeError（空配列を返さない）', (_label, nowMs) => {
    expect(() => getTrustShortRecentEntries(30, nowMs)).toThrow(TypeError)
  })

  it.each(INVALID_NOW_MS_CASES)('captureTrustShortAnalysisInput: %s はTypeError', (_label, nowMs) => {
    expect(() => captureTrustShortAnalysisInput(nowMs)).toThrow(TypeError)
  })

  it.each(INVALID_NOW_MS_CASES)('getTrustShortFilterTuning: %s はTypeError', (_label, nowMs) => {
    expect(() => getTrustShortFilterTuning(90, nowMs)).toThrow(TypeError)
  })

  it('invalid nowMsでも既存entryを"0件"としてすり替えない: 有効entryがある状態でthrowする', () => {
    seedTrackerEntries(store, ['2026-07-15'])
    expect(() => getTrustShortTrackingStats(NaN)).toThrow(TypeError)
    // storageは一切変更されない
    expect(JSON.parse(store.v95_trust_short_tracker).entries).toHaveLength(1)
  })

  it('getTrustShortFilterTuningは有効entryが存在してもinvalid nowMsをdefault thresholdやsampleDays: 0へ隠蔽しない', () => {
    seedTrackerEntries(store, ['2026-07-15'])
    expect(() => getTrustShortFilterTuning(90, NaN)).toThrow(TypeError)
    expect(JSON.parse(store.v95_trust_short_tracker).entries).toHaveLength(1)
  })

  it('fractional millisecondのnowMsはhost timezoneに依存せずtracking結果を返す', () => {
    seedTrackerEntries(store, ['2026-07-15'])
    const nowMs = new Date('2026-07-15T12:00:00.000Z').getTime() + 0.5

    expect(() => captureTrustShortAnalysisInput(nowMs)).not.toThrow()
    expect(getTrustShortTodayExecutionCount(nowMs)).toBe(1)
    expect(getTrustShortTrackingStats(nowMs).trackedDays).toBe(1)
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(1)
  })
})

describe('F2: recordTrustShortDecisionのsnapshot.date検証', () => {
  let store: Record<string, string>
  let storageSpies: ReturnType<typeof stubSpiedLocalStorage>

  beforeEach(() => {
    storageSpies = stubSpiedLocalStorage()
    store = storageSpies.store
  })
  afterEach(() => { vi.unstubAllGlobals() })

  function makeSnapshot(date: string) {
    return {
      date,
      decision: 'BULL' as const,
      confidence: 80,
      executed: true,
      nikkeiChgPct: 1.2,
      futuresChgPct: 0.8,
      conditionsPassed: 4,
      vix: 16,
      nikkeiVI: 19,
      volatilitySpread: 0.5,
    }
  }

  it('YYYY-MM-DDはJST market-day keyとしてそのまま使用される', () => {
    recordTrustShortDecision(makeSnapshot('2026-07-15'))
    const entries = JSON.parse(store.v95_trust_short_tracker).entries as TrustShortTrackerEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0].date).toBe('2026-07-15')
  })

  it('Z付きISO timestampはinstantをJST calendar dayへ変換する（15:00:00Zで日付繰り上がり）', () => {
    recordTrustShortDecision(makeSnapshot('2026-07-15T14:59:59.000Z'))
    let entries = JSON.parse(store.v95_trust_short_tracker).entries as TrustShortTrackerEntry[]
    expect(entries[0].date).toBe('2026-07-15')

    store.v95_trust_short_tracker = JSON.stringify({ entries: [] })
    recordTrustShortDecision(makeSnapshot('2026-07-15T15:00:00.000Z'))
    entries = JSON.parse(store.v95_trust_short_tracker).entries as TrustShortTrackerEntry[]
    expect(entries[0].date).toBe('2026-07-16')
  })

  it('+09:00オフセット付きISO timestampはinstantをJST calendar dayへ変換する', () => {
    // 2026-07-15T23:59:59+09:00 は JST calendar dayとして2026-07-15
    recordTrustShortDecision(makeSnapshot('2026-07-15T23:59:59+09:00'))
    const entries = JSON.parse(store.v95_trust_short_tracker).entries as TrustShortTrackerEntry[]
    expect(entries[0].date).toBe('2026-07-15')
  })

  it.each([
    ['不正文字列', 'not-a-date'],
    ['存在しない暦日', '2026-02-30'],
    ['不正offset', '2026-07-15T10:00:00+25:00'],
    ['不正time', '2026-07-15T25:00:00Z'],
    ['空文字', ''],
  ])('invalid snapshot.date（%s）はstorage access前にTypeErrorでrejectする', (_label, date) => {
    seedTrackerEntries(store, ['2026-07-15'])
    const before = store.v95_trust_short_tracker

    expect(() => recordTrustShortDecision(makeSnapshot(date))).toThrow(TypeError)
    expect(storageSpies.getItem).toHaveBeenCalledTimes(0)
    expect(storageSpies.setItem).toHaveBeenCalledTimes(0)
    expect(storageSpies.removeItem).toHaveBeenCalledTimes(0)
    expect(store.v95_trust_short_tracker).toBe(before)
    expect(JSON.parse(store.v95_trust_short_tracker).entries).toEqual(
      JSON.parse(before).entries,
    )
  })

  it('invalid snapshot.dateは既存entryの書き換えも発生させない', () => {
    recordTrustShortDecision(makeSnapshot('2026-07-15'))
    const before = store.v95_trust_short_tracker
    expect(() => recordTrustShortDecision(makeSnapshot('not-a-date'))).toThrow(TypeError)
    expect(store.v95_trust_short_tracker).toBe(before)
  })
})

describe('F3: 0001〜0099年のJST market-day keyを正しく扱う', () => {
  let store: Record<string, string>

  beforeEach(() => { store = stubLocalStorage() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('0001-01-01・0099-12-31は有効な暦日として扱われる（filterRecent経由）', () => {
    seedTrackerEntries(store, ['0001-01-01'])
    // nowMsをJST 0001-01-02として、30日window内に0001-01-01を含める
    const nowMs = utcMsForYear(1, 1, 2) - JST_OFFSET_MS
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(1)

    seedTrackerEntries(store, ['0099-12-31'])
    const nowMs2 = utcMsForYear(100, 1, 1) - JST_OFFSET_MS
    expect(getTrustShortRecentEntries(30, nowMs2)).toHaveLength(1)
  })

  it('0000年・10000年・存在しない日付は無効な暦日としてfilterRecentから除外される', () => {
    // windowを800,000日（約2191年）まで広げても、0000年は有効範囲[0001,9999]外として除外され続ける
    // （window不足による除外ではなく、暦年自体が無効なことによる除外であることを保証する）。
    const WIDE_WINDOW_DAYS = 800_000
    const nowMs = new Date('2026-07-15T16:00:00.000Z').getTime()

    seedTrackerEntries(store, ['0000-12-31'])
    expect(getTrustShortRecentEntries(WIDE_WINDOW_DAYS, nowMs)).toHaveLength(0)

    seedTrackerEntries(store, ['2026-02-30'])
    expect(getTrustShortRecentEntries(WIDE_WINDOW_DAYS, nowMs)).toHaveLength(0)
  })

  it('5桁年（10000年）はDATE_KEY_REにマッチせず無効な暦日として除外される', () => {
    seedTrackerEntries(store, ['10000-01-01'])
    const nowMs = new Date('2026-07-15T16:00:00.000Z').getTime()
    expect(getTrustShortRecentEntries(800_000, nowMs)).toHaveLength(0)
  })

  it.each(['0001-01-01', '0099-12-31'])(
    'recordTrustShortDecisionは%sを直接受理しcase間でstorage stateを共有しない',
    date => {
      expect(() => recordTrustShortDecision({
        date,
        decision: 'WAIT',
        confidence: 50,
        executed: false,
        nikkeiChgPct: 0,
        futuresChgPct: 0,
        conditionsPassed: 0,
      })).not.toThrow()
      const entries = JSON.parse(store.v95_trust_short_tracker).entries as TrustShortTrackerEntry[]
      expect(entries).toHaveLength(1)
      expect(entries[0].date).toBe(date)
      expect(entries.map(entry => entry.date)).toEqual([date])
    },
  )

  it('現代の日付処理（2020年代）は変更されない', () => {
    seedTrackerEntries(store, ['2026-06-16'])
    const nowMs = new Date('2026-07-15T16:00:00.000Z').getTime() // JST: 2026-07-16
    expect(getTrustShortRecentEntries(30, nowMs)).toHaveLength(1)
  })
})

describe('F4: 直接テスト（JST midnight境界・120日retention境界）', () => {
  let store: Record<string, string>

  beforeEach(() => { store = stubLocalStorage() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('getTrustShortTodayExecutionCount: JST midnight境界（14:59:59Zは当日、15:00:00Zは翌日扱い）', () => {
    seedTrackerEntries(store, ['2026-07-15'])
    const before = new Date('2026-07-15T14:59:59.000Z').getTime()
    const after = new Date('2026-07-15T15:00:00.000Z').getTime()

    expect(getTrustShortTodayExecutionCount(before)).toBe(1)
    expect(getTrustShortTodayExecutionCount(after)).toBe(0)

    seedTrackerEntries(store, ['2026-07-16'])
    expect(getTrustShortTodayExecutionCount(after)).toBe(1)
  })

  it('Dec/Jan年境界は14:59:59Zの2026-12-31から15:00:00Zの2027-01-01へ切り替わる', () => {
    const before = new Date('2026-12-31T14:59:59.000Z').getTime()
    const after = new Date('2026-12-31T15:00:00.000Z').getTime()

    seedTrackerEntries(store, ['2026-12-31'])
    expect(getTrustShortTodayExecutionCount(before)).toBe(1)
    expect(getTrustShortTodayExecutionCount(after)).toBe(0)

    seedTrackerEntries(store, ['2027-01-01'])
    expect(getTrustShortTodayExecutionCount(before)).toBe(0)
    expect(getTrustShortTodayExecutionCount(after)).toBe(1)
  })

  it('captureTrustShortAnalysisInput: todayEntryCountと30日windowの両方がJST基準で一致する', () => {
    seedTrackerEntries(store, ['2026-06-15', '2026-06-16', '2026-07-16'])
    const nowMs = new Date('2026-07-15T16:00:00.000Z').getTime() // JST: 2026-07-16

    const input = captureTrustShortAnalysisInput(nowMs)
    expect(input.todayEntryCount).toBe(1)
    expect(input.performance30d.trackedDays).toBe(2) // 06-15除外、06-16・07-16は含む
  })

  it('120日retention: cutoff当日（120日前）は含み、cutoff前日（121日前）は除外する', () => {
    seedTrackerEntries(store, ['2026-03-17', '2026-03-18'])
    recordTrustShortDecision({
      date: '2026-07-16',
      decision: 'WAIT',
      confidence: 50,
      executed: false,
      nikkeiChgPct: 0,
      futuresChgPct: 0,
      conditionsPassed: 0,
    })
    const dates = (JSON.parse(store.v95_trust_short_tracker).entries as TrustShortTrackerEntry[])
      .map(entry => entry.date)
    expect(dates).toContain('2026-03-18')
    expect(dates).not.toContain('2026-03-17')
  })

  it('getTrustShortTrackingStats: 30日windowの境界（06-15は除外、06-16は含む、nowはJST 2026-07-16）', () => {
    seedTrackerEntries(store, ['2026-06-15'])
    const nowMs = new Date('2026-07-15T16:00:00.000Z').getTime()
    expect(getTrustShortTrackingStats(nowMs).trackedDays).toBe(0)

    seedTrackerEntries(store, ['2026-06-16'])
    expect(getTrustShortTrackingStats(nowMs).trackedDays).toBe(1)
  })
})
