import type { Trust } from '../../types'
import { restoreCsvTrustShortSnapshotState } from '../../store/persist'
import { parseStrictTimestamp } from '../../utils/strictTimestamp'

export type TrustShortDecision = 'WAIT' | 'BULL' | 'BEAR'
export type TrustShortOutcome = 'win' | 'loss' | 'flat'

export interface TrustShortDecisionSnapshot {
  date: string
  decision: TrustShortDecision
  confidence: number
  executed: boolean
  nikkeiChgPct: number
  futuresChgPct: number
  conditionsPassed: number
  vix?: number
  nikkeiVI?: number
  volatilitySpread?: number
}

export interface TrustShortTrackerEntry {
  date: string
  decision: TrustShortDecision
  confidence: number
  executed: boolean
  outcome: TrustShortOutcome
  nikkeiChgPct: number
  futuresChgPct: number
  conditionsPassed: number
  vix: number
  nikkeiVI: number
  volatilitySpread: number
  updatedAt: string
}

interface TrustShortTrackerState {
  entries: TrustShortTrackerEntry[]
}

export interface TrustShortAnalysisInput {
  /** Exact storage bytes captured at transaction start. */
  raw: string | null
  fingerprint: string
  todayEntryCount: number
  performance30d: TrustShortTrackingStats
}

export interface TrustShortPortfolioBaseline {
  status: 'committed' | 'none' | 'invalid'
  snapshot: TrustShortPortfolioSnapshot | null
}

export interface TrustShortTrackingStats {
  trackedDays: number
  executions: number
  waitDays: number
  wins: number
  losses: number
  winRate: number
  postWaitWins: number
  postWaitWinRate: number
}

export interface TrustShortFilterTuning {
  windowDays: number
  sampleDays: number
  bullSample: number
  bearSample: number
  recommendedBullVixMax: number
  recommendedBearVixMin: number
  bullWinRate: number
  bearWinRate: number
}

export interface TrustCsvExecutionDetection {
  executed: boolean
  absDiffSum: number
  turnover: number
  changedFunds: number
}

export interface StagedTrustCsvExecution {
  detection: TrustCsvExecutionDetection
  snapshot: TrustShortPortfolioSnapshot
}

const KEY = 'v95_trust_short_tracker'
const SNAPSHOT_KEY = 'v95_trust_short_snapshot'
const RETENTION_DAYS = 120
const WINDOW_DAYS = 30
const DEFAULT_BULL_VIX_MAX = 17
const DEFAULT_BEAR_VIX_MIN = 26

export interface TrustShortPortfolioSnapshot {
  date: string
  total: number
  evalById: Record<string, number>
}

export type TrustShortBaselineClock = number | string

function toDateKey(value: string) {
  if (!value) return new Date().toISOString().slice(0, 10)
  return value.slice(0, 10)
}

function safeNowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString()
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const MS_PER_DAY = 24 * 60 * 60 * 1000
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
// ECMA-262 Date値の表現可能範囲（±100,000,000日 = ±8.64e15ms）。
const MIN_DATE_EPOCH_MS = -8_640_000_000_000_000
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000

/**
 * JST calendar day算出の唯一の入り口となるepoch millisecond validator。
 * NaN/Infinity/Date表現範囲外/JST offset加算後に範囲外/JST暦年が0001-9999外を
 * すべてTypeErrorとして統一し、「0件」等へ隠蔽させない（jstDateKeyFromMs/jstEpochDayの両方が必ず経由する）。
 */
function assertValidEpochMs(nowMs: number): void {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`trustShortTracker: nowMs must be a finite number, got ${String(nowMs)}`)
  }
  if (nowMs < MIN_DATE_EPOCH_MS || nowMs > MAX_DATE_EPOCH_MS) {
    throw new TypeError(`trustShortTracker: nowMs is outside the representable Date range: ${nowMs}`)
  }
  const jstMs = nowMs + JST_OFFSET_MS
  if (jstMs < MIN_DATE_EPOCH_MS || jstMs > MAX_DATE_EPOCH_MS) {
    throw new TypeError(
      `trustShortTracker: nowMs is outside the representable Date range after JST offset: ${nowMs}`,
    )
  }
  // jstMsがDate範囲内である以上getUTCFullYear()はNaNにならず、この比較は安全に機能する。
  const jstYear = new Date(jstMs).getUTCFullYear()
  if (jstYear < 1 || jstYear > 9999) {
    throw new TypeError(`trustShortTracker: JST calendar year is outside [0001,9999]: ${jstYear}`)
  }
}

/**
 * 日本市場日（Asia/Tokyo, UTC+9, DSTなし）のcalendar day keyをnowMsから導出する。
 * host timezoneに一切依存しない（Date.setHours/setDateなどlocal time APIを使わない）。
 */
function jstDateKeyFromMs(nowMs: number): string {
  assertValidEpochMs(nowMs)
  return new Date(nowMs + JST_OFFSET_MS).toISOString().slice(0, 10)
}

function normalizeTrustShortBaselineClock(clock: TrustShortBaselineClock): number {
  if (typeof clock === 'number') {
    assertValidEpochMs(clock)
    return clock
  }
  const parsed = parseStrictTimestamp(clock, { allowDateOnly: true })
  if (!parsed) {
    throw new TypeError(`trustShortTracker: invalid baseline clock: ${JSON.stringify(clock)}`)
  }
  assertValidEpochMs(parsed.epochMs)
  return parsed.epochMs
}

/** nowMsが属するJST calendar dayのepoch day数（1970-01-01 UTC起点）。 */
function jstEpochDay(nowMs: number): number {
  assertValidEpochMs(nowMs)
  return Math.floor((nowMs + JST_OFFSET_MS) / MS_PER_DAY)
}

/**
 * "YYYY-MM-DD"を厳密に検証してepoch day数へ変換する。
 * 形式不正・存在しない暦日（例: 2026-02-30）・0001-9999範囲外の年はnullを返し、
 * 呼び出し側で除外させる。calendar検証はstrictTimestamp.tsのparseStrictTimestampを再利用し、
 * Date.UTC(0-99年を1900年代へ丸める既知の罠)を避ける。
 */
function dayKeyToEpochDay(key: string): number | null {
  if (!DATE_KEY_RE.test(key)) return null
  const parsed = parseStrictTimestamp(key, { allowDateOnly: true })
  return parsed ? jstEpochDay(parsed.epochMs) : null
}

function trackerStorage(): Storage | null {
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    return window.localStorage
  }
  if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage
  return null
}

function restoreCanonicalSnapshotFor(storage: Storage) {
  // In browsers globalThis === window. Tests may intentionally provide only window.localStorage;
  // in that case there is no canonical store to consult and legacy fallback remains valid.
  if (typeof globalThis.localStorage === 'undefined' || globalThis.localStorage !== storage) {
    return { status: 'none' as const, snapshot: null }
  }
  return restoreCsvTrustShortSnapshotState()
}

function parseState(raw: string | null, nowMs = Date.now()): TrustShortTrackerState {
  try {
    if (!raw) return { entries: [] }
    const parsed = JSON.parse(raw) as Partial<TrustShortTrackerState>
    if (!Array.isArray(parsed.entries)) return { entries: [] }
    return {
      entries: parsed.entries
        .filter(entry => entry && typeof entry.date === 'string')
        .map(entry => ({
          date: toDateKey(entry.date),
          decision: entry.decision === 'BULL' || entry.decision === 'BEAR' ? entry.decision : 'WAIT',
          confidence: Number.isFinite(entry.confidence) ? Number(entry.confidence) : 0,
          executed: Boolean(entry.executed),
          outcome:
            entry.outcome === 'win' || entry.outcome === 'loss' || entry.outcome === 'flat'
              ? entry.outcome
              : 'flat',
          nikkeiChgPct: Number.isFinite(entry.nikkeiChgPct) ? Number(entry.nikkeiChgPct) : 0,
          futuresChgPct: Number.isFinite(entry.futuresChgPct) ? Number(entry.futuresChgPct) : 0,
          conditionsPassed: Number.isFinite(entry.conditionsPassed) ? Number(entry.conditionsPassed) : 0,
          vix: Number.isFinite(entry.vix) ? Number(entry.vix) : 0,
          nikkeiVI: Number.isFinite(entry.nikkeiVI) ? Number(entry.nikkeiVI) : 0,
          volatilitySpread: Number.isFinite(entry.volatilitySpread)
            ? Number(entry.volatilitySpread)
            : 0,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : safeNowIso(nowMs),
        })),
    }
  } catch {
    return { entries: [] }
  }
}

function loadState(nowMs = Date.now()): TrustShortTrackerState {
  const storage = trackerStorage()
  if (!storage) return { entries: [] }
  try { return parseState(storage.getItem(KEY), nowMs) }
  catch { return { entries: [] } }
}

function saveState(state: TrustShortTrackerState) {
  const storage = trackerStorage()
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(state))
  } catch {
    // ignore quota errors
  }
}

function evaluateOutcome(decision: TrustShortDecision, nikkeiChgPct: number): TrustShortOutcome {
  if (decision === 'BULL') {
    if (nikkeiChgPct >= 0.4) return 'win'
    if (nikkeiChgPct <= -0.4) return 'loss'
    return 'flat'
  }

  if (decision === 'BEAR') {
    if (nikkeiChgPct <= -0.4) return 'win'
    if (nikkeiChgPct >= 0.4) return 'loss'
    return 'flat'
  }

  if (Math.abs(nikkeiChgPct) <= 1.0) return 'win'
  if (Math.abs(nikkeiChgPct) >= 1.8) return 'loss'
  return 'flat'
}

function filterRecent(entries: TrustShortTrackerEntry[], days: number, nowMs = Date.now()) {
  const cutoffEpochDay = jstEpochDay(nowMs) - days
  return entries.filter(entry => {
    const epochDay = dayKeyToEpochDay(entry.date)
    return epochDay !== null && epochDay >= cutoffEpochDay
  })
}

function buildStats(entries: TrustShortTrackerEntry[], nowMs = Date.now()): TrustShortTrackingStats {
  const recent = filterRecent(entries, WINDOW_DAYS, nowMs)
  const executions = recent.filter(entry => entry.executed)
  const waitDays = recent.filter(entry => entry.decision === 'WAIT')
  const wins = executions.filter(entry => entry.outcome === 'win').length
  const losses = executions.filter(entry => entry.outcome === 'loss').length
  const postWaitWins = waitDays.filter(entry => entry.outcome === 'win').length

  return {
    trackedDays: recent.length,
    executions: executions.length,
    waitDays: waitDays.length,
    wins,
    losses,
    winRate: executions.length > 0 ? Number(((wins / executions.length) * 100).toFixed(1)) : 0,
    postWaitWins,
    postWaitWinRate:
      waitDays.length > 0 ? Number(((postWaitWins / waitDays.length) * 100).toFixed(1)) : 0,
  }
}

function readLegacySnapshot(storage: Storage): TrustShortPortfolioSnapshot | null {
  const raw = storage.getItem(SNAPSHOT_KEY)
  if (!raw) return null
  const parsed = JSON.parse(raw) as Partial<TrustShortPortfolioSnapshot>
  if (!parsed || typeof parsed.date !== 'string' || typeof parsed.total !== 'number') return null
  if (!parsed.evalById || typeof parsed.evalById !== 'object') return null
  return {
    date: parsed.date,
    total: Number(parsed.total) || 0,
    evalById: Object.fromEntries(
      Object.entries(parsed.evalById).map(([key, value]) => [key, Number(value) || 0]),
    ),
  }
}

function loadSnapshot(): TrustShortPortfolioSnapshot | null {
  const storage = trackerStorage()
  if (!storage) return null
  try {
    const canonical = restoreCanonicalSnapshotFor(storage)
    if (canonical.status === 'committed') return canonical.snapshot
    if (canonical.status === 'invalid') return null
    return readLegacySnapshot(storage)
  } catch {
    return null
  }
}

function saveSnapshot(snapshot: TrustShortPortfolioSnapshot) {
  const storage = trackerStorage()
  if (!storage) return
  try {
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // ignore quota errors
  }
}

function buildShortTrustSnapshot(
  trust: Trust[],
  clock: TrustShortBaselineClock,
): TrustShortPortfolioSnapshot {
  const epochMs = normalizeTrustShortBaselineClock(clock)
  const items = trust.filter(item => item.policy === 'JAPAN_SHORTTERM')
  const evalById = Object.fromEntries(items.map(item => [item.id, item.eval]))
  const total = items.reduce((sum, item) => sum + item.eval, 0)
  return { date: jstDateKeyFromMs(epochMs), total, evalById }
}

export function getTrustShortTodayExecutionCount(nowMs = Date.now()) {
  const key = jstDateKeyFromMs(nowMs)
  const state = loadState()
  return state.entries.some(entry => entry.date === key && entry.executed) ? 1 : 0
}

export function getTrustShortTrackingStats(nowMs = Date.now()) {
  return buildStats(loadState(nowMs).entries, nowMs)
}

export function getTrustShortRecentEntries(days = WINDOW_DAYS, nowMs = Date.now()) {
  const state = loadState()
  return filterRecent(state.entries, days, nowMs)
}

export function getTrustShortFilterTuning(days = 90, nowMs = Date.now()): TrustShortFilterTuning {
  const entries = filterRecent(loadState(nowMs).entries, days, nowMs)
  const bullEntries = entries.filter(entry => entry.executed && entry.decision === 'BULL' && entry.vix > 0)
  const bearEntries = entries.filter(entry => entry.executed && entry.decision === 'BEAR' && entry.vix > 0)

  const calcWinRate = (sample: TrustShortTrackerEntry[]) => {
    if (sample.length === 0) return 0
    const wins = sample.filter(entry => entry.outcome === 'win').length
    return Number(((wins / sample.length) * 100).toFixed(1))
  }

  let bestBull = { threshold: DEFAULT_BULL_VIX_MAX, score: -999, winRate: 0, sample: 0 }
  for (let vix = 15; vix <= 20; vix += 1) {
    const sample = bullEntries.filter(entry => entry.vix <= vix)
    const winRate = calcWinRate(sample)
    const score = winRate - Math.max(0, 5 - sample.length) * 4
    if (score > bestBull.score) {
      bestBull = { threshold: vix, score, winRate, sample: sample.length }
    }
  }

  let bestBear = { threshold: DEFAULT_BEAR_VIX_MIN, score: -999, winRate: 0, sample: 0 }
  for (let vix = 23; vix <= 30; vix += 1) {
    const sample = bearEntries.filter(entry => entry.vix >= vix)
    const winRate = calcWinRate(sample)
    const score = winRate - Math.max(0, 5 - sample.length) * 4
    if (score > bestBear.score) {
      bestBear = { threshold: vix, score, winRate, sample: sample.length }
    }
  }

  return {
    windowDays: days,
    sampleDays: entries.length,
    bullSample: bestBull.sample,
    bearSample: bestBear.sample,
    recommendedBullVixMax: bestBull.threshold,
    recommendedBearVixMin: bestBear.threshold,
    bullWinRate: bestBull.winRate,
    bearWinRate: bestBear.winRate,
  }
}

export function detectTrustExecutionFromCsvSync(
  trust: Trust[],
  clock: TrustShortBaselineClock = Date.now(),
): TrustCsvExecutionDetection {
  const staged = stageTrustExecutionFromCsvSync(trust, clock)
  saveSnapshot(staged.snapshot)
  return staged.detection
}

/** CSV strict transaction向けの副作用なし検出。 */
export function stageTrustExecutionFromCsvSync(
  trust: Trust[],
  clock: TrustShortBaselineClock = Date.now(),
  baseline?: TrustShortPortfolioBaseline,
): StagedTrustCsvExecution {
  const current = buildShortTrustSnapshot(trust, clock)
  const previous = baseline ? baseline.snapshot : loadSnapshot()

  if (!previous) {
    return {
      detection: { executed: false, absDiffSum: 0, turnover: 0, changedFunds: 0 },
      snapshot: current,
    }
  }

  const ids = new Set([...Object.keys(previous.evalById), ...Object.keys(current.evalById)])
  let absDiffSum = 0
  let changedFunds = 0

  // 解約・売却やCSV欠落によるeval=0化（P4.5-A013-T3）はいずれもeval減少として
  // 現れるため、減少は一切集計しない。増額（提案実行/積立執行）のみを対象にする。
  ids.forEach(id => {
    const prev = previous.evalById[id] ?? 0
    const curr = current.evalById[id] ?? 0
    const increase = curr - prev
    if (increase <= 0) return
    absDiffSum += increase
    if (increase >= 50_000) changedFunds += 1
  })

  const turnover = absDiffSum / Math.max(previous.total, 1)
  const executed =
    (absDiffSum >= 200_000 && turnover >= 0.04) ||
    (absDiffSum >= 120_000 && changedFunds >= 2)

  return {
    detection: {
      executed,
      absDiffSum: Math.round(absDiffSum),
      turnover: Number(turnover.toFixed(4)),
      changedFunds,
    },
    snapshot: current,
  }
}

/** runFullAnalysisがbrowser trackerから読む値をCAS対象へ含める。 */
export function getTrustShortReadDependencyFingerprint(): string {
  const storage = trackerStorage()
  if (!storage) return 'unavailable'
  try {
    return storage.getItem(KEY) ?? 'missing'
  } catch {
    return 'read-error'
  }
}

/** Capture every tracker value used by strict CSV analysis with one storage read. */
export function captureTrustShortAnalysisInput(nowMs: number): TrustShortAnalysisInput {
  const storage = trackerStorage()
  let raw: string | null = null
  try { raw = storage?.getItem(KEY) ?? null } catch { raw = null }
  const state = parseState(raw, nowMs)
  const todayKey = jstDateKeyFromMs(nowMs)
  return {
    raw,
    fingerprint: raw ?? 'missing',
    todayEntryCount: state.entries.some(entry => entry.date === todayKey && entry.executed) ? 1 : 0,
    performance30d: buildStats(state.entries, nowMs),
  }
}

export function captureTrustShortPortfolioBaseline(): TrustShortPortfolioBaseline {
  const storage = trackerStorage()
  if (!storage) return { status: 'invalid', snapshot: null }
  const canonical = restoreCanonicalSnapshotFor(storage)
  if (canonical.status === 'committed') return canonical
  if (canonical.status === 'invalid') return { status: 'invalid', snapshot: null }
  try { return { status: 'none', snapshot: readLegacySnapshot(storage) } }
  catch { return { status: 'none', snapshot: null } }
}

/** CAS rollback for a tracker write that raced the tentative canonical commit. */
export function restoreTrustShortAnalysisInput(
  snapshot: TrustShortAnalysisInput,
  expectedCurrentFingerprint: string,
): boolean {
  const storage = trackerStorage()
  if (!storage) return snapshot.fingerprint === 'unavailable'
  try {
    if (getTrustShortReadDependencyFingerprint() !== expectedCurrentFingerprint) return false
    if (snapshot.raw === null) storage.removeItem(KEY)
    else storage.setItem(KEY, snapshot.raw)
    return getTrustShortReadDependencyFingerprint() === snapshot.fingerprint
  } catch {
    return false
  }
}

/**
 * snapshot.dateを厳密検証する。有効形式は次の2種のみ:
 *  - "YYYY-MM-DD": 明示的なJST market-day keyとしてそのまま同じ日付を使用する。
 *  - "Z"またはtimezone offset付きISO timestamp: instantをJST calendar dayへ変換する。
 * 不正文字列・存在しない暦日・不正offset・空文字はすべてTypeErrorでrejectし、
 * 呼び出し側にstorage write/mutationをさせない（副作用ゼロを呼び出し元で保証するための事前関門）。
 */
function requireValidSnapshotDate(date: unknown): { epochMs: number; normalized: string } {
  const parsed = parseStrictTimestamp(date, { allowDateOnly: true })
  if (!parsed) {
    throw new TypeError(`trustShortTracker: invalid snapshot.date: ${JSON.stringify(date)}`)
  }
  return parsed
}

export function recordTrustShortDecision(snapshot: TrustShortDecisionSnapshot) {
  const parsedDate = requireValidSnapshotDate(snapshot.date)
  const retentionNowMs = parsedDate.epochMs
  const date = jstDateKeyFromMs(retentionNowMs)
  const now = parsedDate.normalized
  const outcome = evaluateOutcome(snapshot.decision, snapshot.nikkeiChgPct)

  const state = loadState()

  const nextEntry: TrustShortTrackerEntry = {
    date,
    decision: snapshot.decision,
    confidence: Math.round(snapshot.confidence),
    executed: snapshot.executed,
    outcome,
    nikkeiChgPct: snapshot.nikkeiChgPct,
    futuresChgPct: snapshot.futuresChgPct,
    conditionsPassed: snapshot.conditionsPassed,
    vix: Number(snapshot.vix) || 0,
    nikkeiVI: Number(snapshot.nikkeiVI) || 0,
    volatilitySpread: Number(snapshot.volatilitySpread) || 0,
    updatedAt: now,
  }

  const index = state.entries.findIndex(entry => entry.date === date)
  if (index >= 0) {
    const existing = state.entries[index]
    state.entries[index] = {
      ...nextEntry,
      executed: existing.executed || nextEntry.executed,
      confidence: Math.max(existing.confidence, nextEntry.confidence),
    }
  } else {
    state.entries.push(nextEntry)
  }

  state.entries = filterRecent(state.entries, RETENTION_DAYS, retentionNowMs)
    .sort((left, right) => right.date.localeCompare(left.date))

  saveState(state)
  return buildStats(state.entries, retentionNowMs)
}
