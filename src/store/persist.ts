import type { Holding, Trust } from '../types'

const PORTFOLIO_KEY = 'v81_portfolio'
const TRUST_KEY = 'v81_trust'
const TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7日

interface Snapshot<T> {
  data: T
  savedAt: number
}

export function persistPortfolio(holdings: Holding[]): void {
  const snap: Snapshot<Holding[]> = { data: holdings, savedAt: Date.now() }
  try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

export function restorePortfolio(): Holding[] | null {
  try {
    const raw = localStorage.getItem(PORTFOLIO_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<Holding[]>
    if (Date.now() - snap.savedAt > TTL_MS) {
      localStorage.removeItem(PORTFOLIO_KEY)
      return null
    }
    return snap.data
  } catch { return null }
}

export function persistTrust(trust: Trust[]): void {
  const snap: Snapshot<Trust[]> = { data: trust, savedAt: Date.now() }
  try { localStorage.setItem(TRUST_KEY, JSON.stringify(snap)) } catch { /* quota */ }
}

export function restoreTrust(): Trust[] | null {
  try {
    const raw = localStorage.getItem(TRUST_KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as Snapshot<Trust[]>
    if (Date.now() - snap.savedAt > TTL_MS) {
      localStorage.removeItem(TRUST_KEY)
      return null
    }
    return snap.data
  } catch { return null }
}
