import type {
  Market,
  CorrelationData,
  NewsData,
  Trust,
  MacroSnapshot,
  SQCalendar,
  MarginData,
  FlowData,
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
    return { data: null, source: 'none' }
  }
}

export async function loadTrustMaster(options: LoadOptions = {}): Promise<{ data: Trust[] | null; source: 'loaded' | 'static'; lastUpdated: string | null }> {
  try {
    const raw = await fetchJson<{ funds: Partial<Trust>[]; last_updated?: string }>('data/trust_master.json', options)
    if (!raw.funds) throw new Error('funds missing')
    return { data: raw.funds as Trust[], source: 'loaded', lastUpdated: raw.last_updated ?? null }
  } catch {
    return { data: null, source: 'static', lastUpdated: null }
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

export async function refreshAllData(options: { bustCache?: boolean } = {}) {
  const loadOptions: LoadOptions = options.bustCache ? { bustToken: `${Date.now()}` } : {}
  // 並列fetch（partial updateしない — 全部揃ってからStore更新）
  const [market, correlation, news, trust, macro, nikkeiVI, sq, margin, flows] = await Promise.all([
    loadMarket(loadOptions),
    loadCorrelation(loadOptions),
    loadNews(loadOptions),
    loadTrustMaster(loadOptions),
    loadMacro(loadOptions),
    loadNikkeiVI(loadOptions),
    loadSQCalendar(loadOptions),
    loadMargin(loadOptions),
    loadFlows(loadOptions),
  ])
  return { market, correlation, news, trust, macro, nikkeiVI, sq, margin, flows }
}
