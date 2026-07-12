import { describe, expect, it } from 'vitest'
import {
  SIZING_TIER_LIMIT,
  computeScore,
  resolveAction,
  resolveSizingTier,
} from './scoreCandidates'

describe('computeScore', () => {
  // base=50, costRate=0 → +20, mu=0 → +0, sigma=0 ≤ 0.16 → -0
  it('returns 70 for cost=0, mu=0, sigma=0', () => {
    expect(computeScore(0, 0, 0)).toBeCloseTo(70)
  })

  // base=50, +20, mu=0.10×150=15, sigma=0.10 ≤ 0.16 → -0
  it('returns 85 for cost=0, mu=0.10, sigma=0.10', () => {
    expect(computeScore(0, 0.10, 0.10)).toBeCloseTo(85)
  })

  // base=50, +20, mu=0, sigma=0.20: -(0.20-0.16)×80 = -3.2 → 66.8
  it('returns 66.8 for cost=0, mu=0, sigma=0.20', () => {
    expect(computeScore(0, 0, 0.20)).toBeCloseTo(66.8)
  })

  // mu=1.0 → raw = 50+20+150 = 220 → clamp 100
  it('clamps to 100 when raw exceeds 100', () => {
    expect(computeScore(0, 1.0, 0)).toBe(100)
  })

  // mu=-1.0, sigma=0.50 → raw = 50+20+(-150)-(0.34×80) = 50+20-150-27.2 = -107.2 → clamp 0
  it('clamps to 0 when raw is negative', () => {
    expect(computeScore(0, -1.0, 0.50)).toBe(0)
  })

  // cost=100 → costRate=1.0 → (1-1.0)×20=0
  it('applies zero cost contribution when cost=100', () => {
    // base=50, cost=0, mu=0, sigma=0 → 70
    // base=50, cost=100, mu=0, sigma=0 → 50+0+0-0=50
    expect(computeScore(100, 0, 0)).toBeCloseTo(50)
  })

  // negative cost is treated as 0 via Math.max(0, cost)
  it('treats negative cost as 0', () => {
    expect(computeScore(-5, 0, 0)).toBeCloseTo(70)
  })
})

describe('resolveAction', () => {
  it('returns BLOCKED when blocked array is non-empty', () => {
    expect(resolveAction(['INSUFFICIENT_CASH'], 90, 0.10, false)).toBe('BLOCKED')
  })

  it('returns BLOCKED when score < 50', () => {
    expect(resolveAction([], 49, 0.10, false)).toBe('BLOCKED')
  })

  it('returns WATCH when score = 50', () => {
    expect(resolveAction([], 50, 0.10, false)).toBe('WATCH')
  })

  it('returns WATCH when score = 74', () => {
    expect(resolveAction([], 74, 0.10, false)).toBe('WATCH')
  })

  it('returns BUY_NEW when score >= 75, sigma < 0.25, marketCaution=false', () => {
    expect(resolveAction([], 75, 0.10, false)).toBe('BUY_NEW')
  })

  it('returns WATCH when score >= 75 and sigma >= 0.25 (VOL_SOFT_LIMIT)', () => {
    expect(resolveAction([], 75, 0.25, false)).toBe('WATCH')
  })

  it('returns WATCH when score >= 75 and marketCaution=true', () => {
    expect(resolveAction([], 75, 0.10, true)).toBe('WATCH')
  })

  it('returns WATCH when both sigma >= 0.25 and marketCaution=true', () => {
    expect(resolveAction([], 80, 0.30, true)).toBe('WATCH')
  })

  it('returns BLOCKED regardless of score when blocked is non-empty', () => {
    expect(resolveAction(['SCORE_TOO_LOW'], 80, 0.10, false)).toBe('BLOCKED')
  })
})

describe('resolveSizingTier', () => {
  it('returns none when action is WATCH', () => {
    expect(resolveSizingTier('WATCH', 80, 0.10, 50_000)).toBe('none')
  })

  it('returns none when action is BLOCKED', () => {
    expect(resolveSizingTier('BLOCKED', 80, 0.10, 50_000)).toBe('none')
  })

  it('returns none when action is DATA_WAIT', () => {
    expect(resolveSizingTier('DATA_WAIT', 80, 0.10, 50_000)).toBe('none')
  })

  it('returns none when BUY_NEW but maxAmount < 10,000', () => {
    expect(resolveSizingTier('BUY_NEW', 90, 0.10, 9_999)).toBe('none')
  })

  it('returns none when BUY_NEW but maxAmount = 0', () => {
    expect(resolveSizingTier('BUY_NEW', 90, 0.10, 0)).toBe('none')
  })

  it('returns full when score >= 85 and sigma < 0.18', () => {
    expect(resolveSizingTier('BUY_NEW', 85, 0.17, 50_000)).toBe('full')
  })

  it('returns full when score = 90 and sigma = 0.00', () => {
    expect(resolveSizingTier('BUY_NEW', 90, 0.00, 50_000)).toBe('full')
  })

  // sigma = 0.18 is NOT < 0.18, so full condition fails → half (sigma < 0.20)
  it('returns half when score >= 85 but sigma = 0.18 (boundary)', () => {
    expect(resolveSizingTier('BUY_NEW', 85, 0.18, 50_000)).toBe('half')
  })

  it('returns min when sigma >= 0.20', () => {
    expect(resolveSizingTier('BUY_NEW', 80, 0.20, 50_000)).toBe('min')
  })

  it('returns min when sigma = 0.24 (below VOL_SOFT_LIMIT)', () => {
    expect(resolveSizingTier('BUY_NEW', 80, 0.24, 50_000)).toBe('min')
  })

  // sigma = 0.19 < 0.20, score < 85 → half
  it('returns half when score = 80 and sigma = 0.19', () => {
    expect(resolveSizingTier('BUY_NEW', 80, 0.19, 50_000)).toBe('half')
  })

  it('returns half when score < 85 and sigma < 0.20', () => {
    expect(resolveSizingTier('BUY_NEW', 75, 0.10, 50_000)).toBe('half')
  })
})

describe('SIZING_TIER_LIMIT', () => {
  it('none = 0', () => {
    expect(SIZING_TIER_LIMIT.none).toBe(0)
  })

  it('min = 10,000', () => {
    expect(SIZING_TIER_LIMIT.min).toBe(10_000)
  })

  it('half = 25,000', () => {
    expect(SIZING_TIER_LIMIT.half).toBe(25_000)
  })

  it('full = 50,000', () => {
    expect(SIZING_TIER_LIMIT.full).toBe(50_000)
  })

  it('suggestedAmount invariant: min(TIER_LIMIT[tier], maxAmount) <= maxAmount for all tiers', () => {
    const maxAmount = 30_000
    for (const tier of ['none', 'min', 'half', 'full'] as const) {
      const suggested = Math.min(SIZING_TIER_LIMIT[tier], maxAmount)
      expect(suggested).toBeLessThanOrEqual(maxAmount)
    }
  })

  it('suggestedAmount invariant holds when maxAmount < min tier limit', () => {
    const maxAmount = 5_000
    for (const tier of ['none', 'min', 'half', 'full'] as const) {
      const suggested = Math.min(SIZING_TIER_LIMIT[tier], maxAmount)
      expect(suggested).toBeLessThanOrEqual(maxAmount)
    }
  })
})
