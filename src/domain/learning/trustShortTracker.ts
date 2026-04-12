import type { Trust } from '../../types'

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

interface TrustShortTrackerEntry {
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

const KEY = 'v95_trust_short_tracker'
const SNAPSHOT_KEY = 'v95_trust_short_snapshot'
const RETENTION_DAYS = 120
const WINDOW_DAYS = 30
const DEFAULT_BULL_VIX_MAX = 17
const DEFAULT_BEAR_VIX_MIN = 26

interface TrustShortPortfolioSnapshot {
  date: string
  total: number
  evalById: Record<string, number>
}

function toDateKey(value: string) {
  if (!value) return new Date().toISOString().slice(0, 10)
  return value.slice(0, 10)
}

function safeNowIso() {
  return new Date().toISOString()
}

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function loadState(): TrustShortTrackerState {
  if (!isBrowser()) return { entries: [] }
  try {
    const raw = window.localStorage.getItem(KEY)
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
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : safeNowIso(),
        })),
    }
  } catch {
    return { entries: [] }
  }
}

function saveState(state: TrustShortTrackerState) {
  if (!isBrowser()) return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state))
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

function cutoffDate(days: number) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - days)
  return date
}

function filterRecent(entries: TrustShortTrackerEntry[], days: number) {
  const cutoff = cutoffDate(days)
  return entries.filter(entry => {
    const parsed = new Date(entry.date)
    return !Number.isNaN(parsed.getTime()) && parsed >= cutoff
  })
}

function buildStats(entries: TrustShortTrackerEntry[]): TrustShortTrackingStats {
  const recent = filterRecent(entries, WINDOW_DAYS)
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

function loadSnapshot(): TrustShortPortfolioSnapshot | null {
  if (!isBrowser()) return null
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY)
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
  } catch {
    return null
  }
}

function saveSnapshot(snapshot: TrustShortPortfolioSnapshot) {
  if (!isBrowser()) return
  try {
    window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // ignore quota errors
  }
}

function buildShortTrustSnapshot(trust: Trust[], date: string): TrustShortPortfolioSnapshot {
  const items = trust.filter(item => item.policy === 'JAPAN_SHORTTERM')
  const evalById = Object.fromEntries(items.map(item => [item.id, item.eval]))
  const total = items.reduce((sum, item) => sum + item.eval, 0)
  return { date: toDateKey(date), total, evalById }
}

export function getTrustShortTodayExecutionCount(date = safeNowIso()) {
  const key = toDateKey(date)
  const state = loadState()
  return state.entries.some(entry => entry.date === key && entry.executed) ? 1 : 0
}

export function getTrustShortTrackingStats() {
  return buildStats(loadState().entries)
}

export function getTrustShortRecentEntries(days = WINDOW_DAYS) {
  const state = loadState()
  return filterRecent(state.entries, days)
}

export function getTrustShortFilterTuning(days = 90): TrustShortFilterTuning {
  const entries = filterRecent(loadState().entries, days)
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
  date = safeNowIso(),
): TrustCsvExecutionDetection {
  const current = buildShortTrustSnapshot(trust, date)
  const previous = loadSnapshot()
  saveSnapshot(current)

  if (!previous) {
    return { executed: false, absDiffSum: 0, turnover: 0, changedFunds: 0 }
  }

  const ids = new Set([...Object.keys(previous.evalById), ...Object.keys(current.evalById)])
  let absDiffSum = 0
  let changedFunds = 0

  ids.forEach(id => {
    const prev = previous.evalById[id] ?? 0
    const curr = current.evalById[id] ?? 0
    const diff = Math.abs(curr - prev)
    absDiffSum += diff
    if (diff >= 50_000) changedFunds += 1
  })

  const turnover = absDiffSum / Math.max(previous.total, 1)
  const executed =
    (absDiffSum >= 200_000 && turnover >= 0.04) ||
    (absDiffSum >= 120_000 && changedFunds >= 2)

  return {
    executed,
    absDiffSum: Math.round(absDiffSum),
    turnover: Number(turnover.toFixed(4)),
    changedFunds,
  }
}

export function recordTrustShortDecision(snapshot: TrustShortDecisionSnapshot) {
  const state = loadState()
  const date = toDateKey(snapshot.date)
  const now = safeNowIso()
  const outcome = evaluateOutcome(snapshot.decision, snapshot.nikkeiChgPct)

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

  state.entries = filterRecent(state.entries, RETENTION_DAYS)
    .sort((left, right) => right.date.localeCompare(left.date))

  saveState(state)
  return buildStats(state.entries)
}
