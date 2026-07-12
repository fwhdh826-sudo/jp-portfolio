import type { Trust } from '../../types'

export type TrustRole =
  | 'leveraged'
  | 'us_growth'
  | 'reit'
  | 'us_div'
  | 'us_broad'
  | 'global_broad'
  | 'jp_semiconductor'
  | 'jp_broad'
  | 'jp_div'
  | 'gold'
  | 'other'

// P4-A2: 同一roleの既存保有比率がこの閾値以上なら DUPLICATE_ROLE でブロック
export const ROLE_EXPOSURE_LIMIT_RATIO = 0.20

function normalizeText(t: Pick<Trust, 'id' | 'name' | 'policy'>): string {
  return `${t.id} ${t.name}`.toLowerCase()
}

export function inferTrustRole(t: Pick<Trust, 'id' | 'name' | 'policy'>): TrustRole {
  const text = normalizeText(t)

  // 優先順が重要（上位ルールが先に勝つ）
  if (
    text.includes('bull') ||
    text.includes('bear') ||
    text.includes('4.3') ||
    text.includes('ブル') ||
    text.includes('ベア') ||
    text.includes('レバ')
  ) return 'leveraged'

  if (
    text.includes('fang') ||
    text.includes('mega10') ||
    text.includes('nasdaq') ||
    text.includes('nq100')
  ) return 'us_growth'

  if (text.includes('reit')) return 'reit'

  // 日本株配当を us_div に誤分類しない
  if (text.includes('配当')) {
    if (text.includes('日本') || t.policy === 'JAPAN_SHORTTERM') return 'jp_div'
    return 'us_div'
  }

  if (text.includes('sp500') || text.includes('s&p500')) return 'us_broad'

  if (
    text.includes('acwi') ||
    text.includes('全世界') ||
    text.includes('オルカン')
  ) return 'global_broad'

  if (text.includes('半導体') || text.includes('semi')) return 'jp_semiconductor'

  if (
    text.includes('nk225') ||
    text.includes('日経225') ||
    text.includes('topix')
  ) return 'jp_broad'

  if (t.policy === 'GOLD') return 'gold'

  return 'other'
}

export function emptyRoleExposure(): Record<TrustRole, number> {
  return {
    leveraged: 0,
    us_growth: 0,
    reit: 0,
    us_div: 0,
    us_broad: 0,
    global_broad: 0,
    jp_semiconductor: 0,
    jp_broad: 0,
    jp_div: 0,
    gold: 0,
    other: 0,
  }
}

// eval > 0 の保有投信のみ role 別に合算する。候補自身は eval <= 0 なので自己カウントされない。
export function computeRoleExposureByRole(trusts: Trust[]): Record<TrustRole, number> {
  return trusts.reduce((acc, trust) => {
    if (trust.eval <= 0) return acc
    const role = inferTrustRole(trust)
    acc[role] += trust.eval
    return acc
  }, emptyRoleExposure())
}
