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

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { cache: 'no-cache' })
  if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`)
  return r.json() as Promise<T>
}

export async function loadMarket(): Promise<{ data: Market; source: 'loaded' | 'static' }> {
  try {
    const data = await fetchJson<Market>('data/market.json')
    return { data, source: 'loaded' }
  } catch {
    return { data: STATIC_MARKET, source: 'static' }
  }
}

export async function loadCorrelation(): Promise<{ data: CorrelationData | null; source: 'loaded' | 'static' | 'error' }> {
  try {
    const data = await fetchJson<CorrelationData>('data/correlation.json')
    if (!data.matrix) throw new Error('matrix missing')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'static' }
  }
}

export async function loadNews(): Promise<{ data: NewsData | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<NewsData>('data/news.json')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadTrustMaster(): Promise<{ data: Trust[] | null; source: 'loaded' | 'static' }> {
  try {
    const raw = await fetchJson<{ funds: Partial<Trust>[] }>('data/trust_master.json')
    if (!raw.funds) throw new Error('funds missing')
    return { data: raw.funds as Trust[], source: 'loaded' }
  } catch {
    return { data: null, source: 'static' }
  }
}

// ═══════════════════════════════════════════════════════════
// v9.0 追加: Macro / Nikkei VI / SQ / Margin / Flows
// ═══════════════════════════════════════════════════════════

export async function loadMacro(): Promise<{ data: MacroSnapshot | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<MacroSnapshot>('data/macro.json')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadNikkeiVI(): Promise<{ data: { vi: number; viChg: number; last_updated: string } | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<{ vi: number; viChg: number; last_updated: string }>('data/nikkei_vi.json')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadSQCalendar(): Promise<{ data: SQCalendar | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<SQCalendar>('data/sq_calendar.json')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadMargin(): Promise<{ data: MarginData | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<MarginData>('data/margin.json')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function loadFlows(): Promise<{ data: FlowData | null; source: 'loaded' | 'none' | 'error' }> {
  try {
    const data = await fetchJson<FlowData>('data/flows.json')
    return { data, source: 'loaded' }
  } catch {
    return { data: null, source: 'none' }
  }
}

export async function refreshAllData() {
  // 並列fetch（partial updateしない — 全部揃ってからStore更新）
  const [market, correlation, news, trust, macro, nikkeiVI, sq, margin, flows] = await Promise.all([
    loadMarket(),
    loadCorrelation(),
    loadNews(),
    loadTrustMaster(),
    loadMacro(),
    loadNikkeiVI(),
    loadSQCalendar(),
    loadMargin(),
    loadFlows(),
  ])
  return { market, correlation, news, trust, macro, nikkeiVI, sq, margin, flows }
}
