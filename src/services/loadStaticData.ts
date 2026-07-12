import type {
  Market,
  CorrelationData,
  NewsData,
  Trust,
  Holding,
  MacroSnapshot,
  SQCalendar,
  MarginData,
  FlowData,
  CandidatesNewsData,
  CandidatesNewsRoleEntry,
  RegimeState,
  SafeModeSnapshot,
  TierAViolationsSnapshot,
  TierAAlertsSnapshot,
  CandidatesStocksData,
} from '../types'
import { STATIC_MARKET } from '../constants/market'

const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'
interface LoadOptions {
  bustToken?: string
}

function buildJsonUrl(path: string, options: LoadOptions = {}) {
  const normalizedBase = BASE.endsWith('/') ? BASE : `${BASE}/`
  const separator = path.includes('?') ? '&' : '?'
  return options.bustToken
    ? `${normalizedBase}${path}${separator}ts=${options.bustToken}`
    : `${normalizedBase}${path}`
}

async function fetchJson<T>(path: string, options: LoadOptions = {}): Promise<T> {
  const r = await fetch(buildJsonUrl(path, options), {
    cache: 'no-store',
    headers: {
      pragma: 'no-cache',
      'cache-control': 'no-cache',
    },
  })
  if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`)
  return r.json() as Promise<T>
}

export async function loadMarket(options: LoadOptions = {}): Promise<{ data: Market; source: 'loaded' | 'static' }> {
  try {
    const data = await fetchJson<Market>('data/market.json', options)
    return { data, source: 'loaded' }
  } catch {
    return { data: STATIC_MARKET, source: 'static' }
  }
}

export async function loadCorrelation(options: LoadOptions = {}): Promise<{ data: CorrelationData | null; source: 'loaded' | 'static' | 'error' }> {
  try {
    const data = await fetchJson<CorrelationData>('data/correlation.json', options)
    if (!data.matrix) throw new Error('matrix missing')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'static' }
  }
}

export async function loadNews(options: LoadOptions = {}): Promise<{ data: NewsData | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<NewsData>('data/news.json', options)
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'error' }
  }
}

export async function loadTrustMaster(options: LoadOptions = {}): Promise<{ data: Trust[] | null; source: 'loaded' | 'static' | 'csv'; lastUpdated: string | null }> {
  try {
    const raw = await fetchJson<{ funds: Partial<Trust>[]; last_updated?: string; source?: string }>('data/trust_master.json', options)
    if (!raw.funds) throw new Error('funds missing')
    const source = raw.source === 'sbi_csv' ? 'csv' : 'static'
    return { data: raw.funds as Trust[], source, lastUpdated: raw.last_updated ?? null }
  } catch {
    return { data: null, source: 'static', lastUpdated: null }
  }
}

interface HoldingsSnapshot {
  last_updated?: string
  source?: string
  holdings: Array<Pick<Holding, 'code'> & Partial<Pick<Holding, 'eval' | 'pnlPct' | 'currentPrice'>> & { price?: number }>
}

export async function loadHoldingsSnapshot(
  options: LoadOptions = {},
): Promise<{ data: HoldingsSnapshot | null; source: 'loaded' | 'static' | 'csv' | 'none' | 'error'; lastUpdated: string | null }> {
  try {
    const data = await fetchJson<HoldingsSnapshot>('data/holdings.json', options)
    const source = data.source === 'sbi_csv' ? 'csv' : 'static'
    return { data, source, lastUpdated: data.last_updated ?? null }
  } catch {
    return { data: null, source: 'none', lastUpdated: null }
  }
}

// ═══════════════════════════════════════════════════════════
// v9.0 追加: Macro / Nikkei VI / SQ / Margin / Flows
// ═══════════════════════════════════════════════════════════

export async function loadMacro(options: LoadOptions = {}): Promise<{ data: MacroSnapshot | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<MacroSnapshot>('data/macro.json', options)
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadNikkeiVI(options: LoadOptions = {}): Promise<{ data: { vi: number; viChg: number; last_updated: string } | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<{ vi: number; viChg: number; last_updated: string }>('data/nikkei_vi.json', options)
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadSQCalendar(options: LoadOptions = {}): Promise<{ data: SQCalendar | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<SQCalendar>('data/sq_calendar.json', options)
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadMargin(options: LoadOptions = {}): Promise<{ data: MarginData | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<MarginData>('data/margin.json', options)
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadFlows(options: LoadOptions = {}): Promise<{ data: FlowData | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<FlowData>('data/flows.json', options)
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

// ═══════════════════════════════════════════════════════════
// P4-A9c-data-4c: candidates_news.json loader
// ═══════════════════════════════════════════════════════════

const createEmptyCandidatesNewsRoleEntry = (): CandidatesNewsRoleEntry => ({
  avgSentiment: 0, negativeCount: 0, positiveCount: 0, neutralCount: 0,
  sourceCount: 0, itemCount: 0, isStale: true,
  topNegativeTitle: null, topPositiveTitle: null, items: [],
})

export const DEFAULT_CANDIDATES_NEWS_DATA: CandidatesNewsData = {
  schemaVersion: 'candidates-news-1',
  updatedAt: '',
  sourceUpdatedAt: null,
  staleThresholdHours: 24,
  assetClassNews: {
    jp_broad:        createEmptyCandidatesNewsRoleEntry(),
    jp_semiconductor:createEmptyCandidatesNewsRoleEntry(),
    us_broad:        createEmptyCandidatesNewsRoleEntry(),
    us_growth:       createEmptyCandidatesNewsRoleEntry(),
    global_broad:    createEmptyCandidatesNewsRoleEntry(),
    gold:            createEmptyCandidatesNewsRoleEntry(),
    reit:            createEmptyCandidatesNewsRoleEntry(),
    dividend:        createEmptyCandidatesNewsRoleEntry(),
    macro_risk:      createEmptyCandidatesNewsRoleEntry(),
    fx:              createEmptyCandidatesNewsRoleEntry(),
    rates:           createEmptyCandidatesNewsRoleEntry(),
    commodity:       createEmptyCandidatesNewsRoleEntry(),
    geopolitical:    createEmptyCandidatesNewsRoleEntry(),
  },
  meta: {
    excludedTags: [],
    excludedCategories: [],
    excludedCount: 0,
    minItemsForSignal: 3,
    generator: 'data/build_candidates_news.py',
  },
}

const _CANDIDATES_NEWS_REQUIRED_ROLES: string[] = [
  'jp_broad', 'jp_semiconductor', 'us_broad', 'us_growth', 'global_broad',
  'gold', 'reit', 'dividend', 'macro_risk', 'fx', 'rates', 'commodity', 'geopolitical',
]

export async function loadCandidatesNews(
  options: LoadOptions = {},
): Promise<{ data: CandidatesNewsData; source: 'loaded' | 'default' }> {
  try {
    const data = await fetchJson<CandidatesNewsData>('data/candidates_news.json', options)
    if (
      data.schemaVersion !== 'candidates-news-1' ||
      typeof data.assetClassNews !== 'object' || data.assetClassNews === null ||
      typeof data.staleThresholdHours !== 'number' ||
      _CANDIDATES_NEWS_REQUIRED_ROLES.filter(k => k in data.assetClassNews).length < 10
    ) {
      console.warn('[loadCandidatesNews] invalid schema, using default')
      return { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'default' }
    }
    return { data, source: 'loaded' }
  } catch {
    return { data: DEFAULT_CANDIDATES_NEWS_DATA, source: 'default' }
  }
}

// Guard helper for future signals.news connection.
// Returns true only when at least one non-stale role has actual items.
// Not connected to any decision path yet (P4-A9c-data-4d observability only).
export function isCandidatesNewsUsable(data: CandidatesNewsData): boolean {
  if (data.schemaVersion !== 'candidates-news-1') return false
  if (!data.assetClassNews || typeof data.assetClassNews !== 'object') return false
  return Object.values(data.assetClassNews).some(entry => entry.itemCount > 0 && !entry.isStale)
}

// ═══════════════════════════════════════════════════════════
// P5-B002a: candidates_stocks.json loader（observability-only）
// 市場公開情報のみ。schemaVersion不一致・404・破損時はDEFAULTへfail-soft。
// officialDecisionへの接続・スコアリングはB002b以降の責務。
// ═══════════════════════════════════════════════════════════

export const DEFAULT_CANDIDATES_STOCKS_DATA: CandidatesStocksData = {
  schemaVersion: 'candidates-stocks-1',
  updatedAt: '',
  sourceUpdatedAt: null,
  staleThresholdHours: 48,
  _meta: {
    kind: 'candidates_stocks',
    source: 'default',
    not_for_trading: true,
    universe: 'none',
    note: '市場公開情報のみ。個人資産・保有実額・現金・口座情報は含まない',
  },
  candidates: [],
  missing: [],
  status: 'empty',
}

export async function loadCandidatesStocks(
  options: LoadOptions = {},
): Promise<{ data: CandidatesStocksData; source: 'loaded' | 'default' }> {
  try {
    const data = await fetchJson<CandidatesStocksData>('data/candidates_stocks.json', options)
    if (
      data.schemaVersion !== 'candidates-stocks-1' ||
      !Array.isArray(data.candidates) ||
      !Array.isArray(data.missing) ||
      typeof data.staleThresholdHours !== 'number' ||
      typeof data._meta?.not_for_trading !== 'boolean' ||
      data._meta.not_for_trading !== true ||
      !['ok', 'partial', 'empty'].includes(data.status)
    ) {
      console.warn('[loadCandidatesStocks] invalid schema, using default')
      return { data: DEFAULT_CANDIDATES_STOCKS_DATA, source: 'default' }
    }
    return { data, source: 'loaded' }
  } catch {
    return { data: DEFAULT_CANDIDATES_STOCKS_DATA, source: 'default' }
  }
}

// ═══════════════════════════════════════════════════════════
// P4-A9d: regime_state.json loader
// ═══════════════════════════════════════════════════════════

const VALID_REGIME_IDS = new Set(['bull_calm', 'bull_volatile', 'bear', 'crisis', 'uncertain'])

export const DEFAULT_REGIME_STATE: RegimeState = {
  timestamp: '',
  current_regime: 'uncertain',
  consensus: 0.33,
  votes: {
    rule_based: 'uncertain',
    hmm: ['uncertain', 0.0],
    llm: { regime: 'uncertain', confidence: 0.0, structural_changes: [] },
  },
  market_data_snapshot: { vix: 0, nikkei_5d_return: 0, nikkei_60ma: 0, nikkei_200ma: 0, sp500_dd_30d: 0 },
  regime_changed_at: '',
  previous_regime: null,
  duration_hours: 0,
}

export async function loadRegimeState(
  options: LoadOptions = {},
): Promise<{ data: RegimeState; source: 'loaded' | 'default'; generatedAt: string | null }> {
  try {
    const raw = await fetchJson<{
      _meta: { schemaVersion: string; kind: string; not_for_trading: boolean; generatedAt?: string }
      regime_state: RegimeState
    }>('data/regime_state.json', options)
    if (
      raw._meta?.schemaVersion !== 'regime-state-1' ||
      raw._meta?.kind !== 'live_regime_state' ||
      raw._meta?.not_for_trading === true ||
      typeof raw._meta?.generatedAt !== 'string' ||
      !raw._meta.generatedAt ||
      !VALID_REGIME_IDS.has(raw.regime_state?.current_regime)
    ) {
      return { data: DEFAULT_REGIME_STATE, source: 'default', generatedAt: null }
    }
    return { data: raw.regime_state, source: 'loaded', generatedAt: raw._meta.generatedAt ?? null }
  } catch {
    return { data: DEFAULT_REGIME_STATE, source: 'default', generatedAt: null }
  }
}

export function isRegimeStateUsable(data: RegimeState): boolean {
  return VALID_REGIME_IDS.has(data.current_regime)
}

// ═══════════════════════════════════════════════════════════
// P4-A24: safe_mode.json / tier_a_violations.json / tier_a_alerts.json
// fail-closed: on any load/validation error → safeMode.active = true
// ═══════════════════════════════════════════════════════════

export const DEFAULT_SAFE_MODE_SNAPSHOT: SafeModeSnapshot = {
  _meta: { version: 'v13.3', kind: 'operation_snapshot', not_for_trading: true },
  safe_mode: {
    active: true,
    triggered_at: null,
    trigger_reason: 'system_error',
    trigger_reason_detail: 'safe_mode.json not loaded',
    trigger_conditions: { tier1_data_stale: false, tier_a_t3_violated: false, crisis_regime: false, system_error: true },
    restrictions: { new_buys_frozen: true, rebalance_frozen: false, force_sell_active: false },
    estimated_resume_at: null,
    last_checked: '',
  },
}

export const DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT: TierAViolationsSnapshot = {
  _meta: { version: 'v13.3', kind: 'live_tier_a_violations', not_for_trading: true },
  status: 'unavailable',
  violations: [],
  summary: { total_violations: 0, t3_count: 0, safe_mode_related_count: 0 },
}

export const DEFAULT_TIER_A_ALERTS_SNAPSHOT: TierAAlertsSnapshot = {
  _meta: { version: 'v13.3', kind: 'live_tier_a_alerts', not_for_trading: true },
  status: 'unavailable',
  alerts: [],
  summary: { total_triggered: 0, highest_level: 'NONE' },
}

export async function loadSafeMode(
  options: LoadOptions = {},
): Promise<{ data: SafeModeSnapshot; source: 'loaded' | 'default'; lastChecked: string | null }> {
  try {
    const raw = await fetchJson<SafeModeSnapshot>('data/safe_mode.json', options)
    if (
      raw._meta?.kind !== 'operation_snapshot' ||
      typeof raw.safe_mode?.active !== 'boolean'
    ) {
      return { data: DEFAULT_SAFE_MODE_SNAPSHOT, source: 'default', lastChecked: null }
    }
    return { data: raw, source: 'loaded', lastChecked: raw.safe_mode.last_checked || null }
  } catch {
    return { data: DEFAULT_SAFE_MODE_SNAPSHOT, source: 'default', lastChecked: null }
  }
}

export async function loadTierAViolations(
  options: LoadOptions = {},
): Promise<{ data: TierAViolationsSnapshot; source: 'loaded' | 'default'; generatedAt: string | null }> {
  try {
    const raw = await fetchJson<TierAViolationsSnapshot>('data/tier_a_violations.json', options)
    if (
      raw._meta?.kind !== 'live_tier_a_violations' ||
      !Array.isArray(raw.violations)
    ) {
      return { data: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'default', generatedAt: null }
    }
    return { data: raw, source: 'loaded', generatedAt: raw.generated_at ?? null }
  } catch {
    return { data: DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT, source: 'default', generatedAt: null }
  }
}

export async function loadTierAAlerts(
  options: LoadOptions = {},
): Promise<{ data: TierAAlertsSnapshot; source: 'loaded' | 'default'; generatedAt: string | null }> {
  try {
    const raw = await fetchJson<TierAAlertsSnapshot>('data/tier_a_alerts.json', options)
    if (
      raw._meta?.kind !== 'live_tier_a_alerts' ||
      !Array.isArray(raw.alerts)
    ) {
      return { data: DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'default', generatedAt: null }
    }
    return { data: raw, source: 'loaded', generatedAt: raw.generated_at ?? null }
  } catch {
    return { data: DEFAULT_TIER_A_ALERTS_SNAPSHOT, source: 'default', generatedAt: null }
  }
}

export async function refreshAllData(options: { bustCache?: boolean } = {}) {
  const loadOptions: LoadOptions = options.bustCache ? { bustToken: `${Date.now()}` } : {}
  // 並列fetch（partial updateしない — 全部揃ってからStore更新）
  const [market, correlation, news, trust, holdingsSnapshot, macro, nikkeiVI, sq, margin, flows, candidatesNews, candidatesStocks, regimeState, safeMode, tierAViolations, tierAAlerts] = await Promise.all([
    loadMarket(loadOptions),
    loadCorrelation(loadOptions),
    loadNews(loadOptions),
    loadTrustMaster(loadOptions),
    loadHoldingsSnapshot(loadOptions),
    loadMacro(loadOptions),
    loadNikkeiVI(loadOptions),
    loadSQCalendar(loadOptions),
    loadMargin(loadOptions),
    loadFlows(loadOptions),
    loadCandidatesNews(loadOptions),
    loadCandidatesStocks(loadOptions),
    loadRegimeState(loadOptions),
    loadSafeMode(loadOptions),
    loadTierAViolations(loadOptions),
    loadTierAAlerts(loadOptions),
  ])
  return { market, correlation, news, trust, holdingsSnapshot, macro, nikkeiVI, sq, margin, flows, candidatesNews, candidatesStocks, regimeState, safeMode, tierAViolations, tierAAlerts }
}
