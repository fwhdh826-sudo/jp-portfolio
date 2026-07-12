import { describe, expect, it } from 'vitest'
import type { Trust } from '../../types'
import {
  MAX_AMOUNT_CAP,
  MIN_BUY_AMOUNT,
  VOL_HARD_LIMIT,
  applyCandidateConstraints,
  type ConstraintContext,
} from './applyCandidateConstraints'
import { emptyRoleExposure } from './roleExposure'

function makeTrust(overrides: Partial<Trust> = {}): Trust {
  return {
    id: 'test-fund',
    name: 'Test Fund',
    abbr: 'TF',
    account: 'NISA成長投資枠',
    policy: 'OVERSEAS_LONGTERM',
    eval: 0,
    pnlPct: 0,
    dayPct: 0,
    cost: 0.10,
    mu: 0.05,
    sigma: 0.10,
    score: 70,
    signal: '',
    ev: 0,
    decision: 'HOLD',
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ConstraintContext> = {}): ConstraintContext {
  return {
    dqSuppressed: false,
    noTrade: false,
    marketCaution: false,
    availableCash: 100_000,
    classCurrentValue: 0,
    classTargetValue: 500_000,
    roleExposureByRole: emptyRoleExposure(),
    totalTrustValue: 1_000_000,
    marketRegime: 'neutral',
    marketDataAgeDays: 0,
    trustDataAgeDays: 0,
    marketNikkeiChgPct: null,
    macroSp500ChgPct: null,
    macroNasdaqChgPct: null,
    macroGoldChgPct: null,
    ...overrides,
  }
}

describe('applyCandidateConstraints: normal path / maxAmount', () => {
  it('all gates pass: blocked=[], maxAmount>0, key constraints pass', () => {
    const result = applyCandidateConstraints(makeTrust(), 'global_trust', makeCtx())
    expect(result.blocked).toHaveLength(0)
    expect(result.maxAmount).toBeGreaterThan(0)
    expect(result.constraints.cashBudget).toBe('pass')
    expect(result.constraints.volatility).toBe('pass')
    expect(result.constraints.eligibility).toBe('pass')
    expect(result.constraints.classHeadroom).toBe('pass')
    expect(result.constraints.cost).toBe('pass')
  })

  it('headroom is the bottleneck: maxAmount = headroom', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ classTargetValue: 100_000, classCurrentValue: 70_000, availableCash: 100_000 }),
    )
    expect(result.blocked).toHaveLength(0)
    expect(result.maxAmount).toBe(30_000)
  })

  it('cash is the bottleneck: maxAmount = availableCash', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ classTargetValue: 500_000, classCurrentValue: 0, availableCash: 30_000 }),
    )
    expect(result.blocked).toHaveLength(0)
    expect(result.maxAmount).toBe(30_000)
  })

  it('MAX_AMOUNT_CAP is the bottleneck: maxAmount = MAX_AMOUNT_CAP', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ classTargetValue: 1_000_000, classCurrentValue: 0, availableCash: 500_000 }),
    )
    expect(result.blocked).toHaveLength(0)
    expect(result.maxAmount).toBe(MAX_AMOUNT_CAP)
  })
})

describe('applyCandidateConstraints: Gate1 DQ', () => {
  it('dqSuppressed=true: early return, blocked exactly [DQ_SUPPRESSED]', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ dqSuppressed: true }),
    )
    expect(result.blocked).toEqual(['DQ_SUPPRESSED'])
    expect(result.maxAmount).toBe(0)
  })

  it('dqSuppressed=true: subsequent gate constraints remain at initial pass (not evaluated)', () => {
    const result = applyCandidateConstraints(
      makeTrust({ sigma: VOL_HARD_LIMIT }),
      'global_trust',
      makeCtx({ dqSuppressed: true, availableCash: 0 }),
    )
    // early return: VOL_TOO_HIGH and INSUFFICIENT_CASH should NOT appear
    expect(result.blocked).toEqual(['DQ_SUPPRESSED'])
    // initial constraint states (before any gate runs) remain 'pass'
    expect(result.constraints.volatility).toBe('pass')
    expect(result.constraints.cashBudget).toBe('pass')
  })
})

describe('applyCandidateConstraints: Gate2 noTrade', () => {
  it('noTrade=true: blocked contains NO_TRADE_EMERGENCY, maxAmount=0', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ noTrade: true }),
    )
    expect(result.blocked).toContain('NO_TRADE_EMERGENCY')
    expect(result.maxAmount).toBe(0)
  })

  it('noTrade=true + sigma >= VOL_HARD_LIMIT: both reasons accumulated', () => {
    const result = applyCandidateConstraints(
      makeTrust({ sigma: VOL_HARD_LIMIT }),
      'global_trust',
      makeCtx({ noTrade: true }),
    )
    expect(result.blocked).toContain('NO_TRADE_EMERGENCY')
    expect(result.blocked).toContain('VOL_TOO_HIGH')
    expect(result.maxAmount).toBe(0)
  })
})

describe('applyCandidateConstraints: Gate3 classHeadroom', () => {
  it('classTargetValue=0: CLASS_TARGET_MISSING, maxAmount=0', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ classTargetValue: 0 }),
    )
    expect(result.blocked).toContain('CLASS_TARGET_MISSING')
    expect(result.constraints.classHeadroom).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('classCurrentValue >= classTargetValue: CLASS_FULL, maxAmount=0', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ classTargetValue: 100_000, classCurrentValue: 100_000 }),
    )
    expect(result.blocked).toContain('CLASS_FULL')
    expect(result.constraints.classHeadroom).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('classCurrentValue > classTargetValue: CLASS_FULL', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ classTargetValue: 100_000, classCurrentValue: 120_000 }),
    )
    expect(result.blocked).toContain('CLASS_FULL')
    expect(result.maxAmount).toBe(0)
  })

  it('positive headroom: pass, headroom caps maxAmount', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ classTargetValue: 100_000, classCurrentValue: 70_000, availableCash: 500_000 }),
    )
    expect(result.constraints.classHeadroom).toBe('pass')
    expect(result.blocked).not.toContain('CLASS_FULL')
    expect(result.maxAmount).toBe(30_000)
  })
})

describe('applyCandidateConstraints: Gate5 volatility', () => {
  it('sigma = VOL_HARD_LIMIT: VOL_TOO_HIGH', () => {
    const result = applyCandidateConstraints(
      makeTrust({ sigma: VOL_HARD_LIMIT }),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).toContain('VOL_TOO_HIGH')
    expect(result.constraints.volatility).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('sigma = VOL_HARD_LIMIT - 0.001: pass', () => {
    const result = applyCandidateConstraints(
      makeTrust({ sigma: VOL_HARD_LIMIT - 0.001 }),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).not.toContain('VOL_TOO_HIGH')
    expect(result.constraints.volatility).toBe('pass')
  })
})

describe('applyCandidateConstraints: Gate6 cashBudget', () => {
  it('availableCash = MIN_BUY_AMOUNT - 1: INSUFFICIENT_CASH, maxAmount=0', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ availableCash: MIN_BUY_AMOUNT - 1 }),
    )
    expect(result.blocked).toContain('INSUFFICIENT_CASH')
    expect(result.constraints.cashBudget).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('availableCash = MIN_BUY_AMOUNT: pass', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ availableCash: MIN_BUY_AMOUNT }),
    )
    expect(result.blocked).not.toContain('INSUFFICIENT_CASH')
    expect(result.constraints.cashBudget).toBe('pass')
  })

  it('availableCash = 0: INSUFFICIENT_CASH', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ availableCash: 0 }),
    )
    expect(result.blocked).toContain('INSUFFICIENT_CASH')
    expect(result.maxAmount).toBe(0)
  })
})

describe('applyCandidateConstraints: Gate7 eligibility', () => {
  it('account=NISA積立: NOT_ELIGIBLE', () => {
    const result = applyCandidateConstraints(
      makeTrust({ account: 'NISA積立' }),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).toContain('NOT_ELIGIBLE')
    expect(result.constraints.eligibility).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('account=NISA成長投資枠: pass', () => {
    const result = applyCandidateConstraints(
      makeTrust({ account: 'NISA成長投資枠' }),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).not.toContain('NOT_ELIGIBLE')
    expect(result.constraints.eligibility).toBe('pass')
  })
})

describe('applyCandidateConstraints: Gate8 cost', () => {
  it('jp_trust: constraints.cost=na, no COST_TOO_HIGH regardless of cost', () => {
    const result = applyCandidateConstraints(
      makeTrust({ cost: 5.0 }),
      'jp_trust',
      makeCtx(),
    )
    expect(result.constraints.cost).toBe('na')
    expect(result.blocked).not.toContain('COST_TOO_HIGH')
  })

  it('global_trust cost=0.50: pass', () => {
    const result = applyCandidateConstraints(
      makeTrust({ cost: 0.50 }),
      'global_trust',
      makeCtx(),
    )
    expect(result.constraints.cost).toBe('pass')
    expect(result.blocked).not.toContain('COST_TOO_HIGH')
  })

  it('global_trust cost=0.501: COST_TOO_HIGH', () => {
    const result = applyCandidateConstraints(
      makeTrust({ cost: 0.501 }),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).toContain('COST_TOO_HIGH')
    expect(result.constraints.cost).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('gold cost=0.60: pass', () => {
    const result = applyCandidateConstraints(
      makeTrust({ cost: 0.60, policy: 'GOLD' }),
      'gold',
      makeCtx(),
    )
    expect(result.constraints.cost).toBe('pass')
    expect(result.blocked).not.toContain('COST_TOO_HIGH')
  })

  it('gold cost=0.601: COST_TOO_HIGH', () => {
    const result = applyCandidateConstraints(
      makeTrust({ cost: 0.601, policy: 'GOLD' }),
      'gold',
      makeCtx(),
    )
    expect(result.blocked).toContain('COST_TOO_HIGH')
    expect(result.constraints.cost).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })
})

describe('applyCandidateConstraints: Gate4 duplicateRole', () => {
  // us_growth role: id/name に 'nasdaq' を含む → inferTrustRole returns 'us_growth'
  const usgrowthTrust = makeTrust({ id: 'nasdaq-fund', name: 'Nasdaq Test Fund' })

  it('us_growth roleExposureRatio = 0.20: DUPLICATE_ROLE', () => {
    const roleExposureByRole = { ...emptyRoleExposure(), us_growth: 200_000 }
    const result = applyCandidateConstraints(
      usgrowthTrust,
      'global_trust',
      makeCtx({ roleExposureByRole, totalTrustValue: 1_000_000 }),
    )
    expect(result.blocked).toContain('DUPLICATE_ROLE')
    expect(result.constraints.duplicateRole).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('us_growth roleExposureRatio = 0.199: pass', () => {
    const roleExposureByRole = { ...emptyRoleExposure(), us_growth: 199_000 }
    const result = applyCandidateConstraints(
      usgrowthTrust,
      'global_trust',
      makeCtx({ roleExposureByRole, totalTrustValue: 1_000_000 }),
    )
    expect(result.blocked).not.toContain('DUPLICATE_ROLE')
    expect(result.constraints.duplicateRole).toBe('pass')
  })

  it('totalTrustValue=0: ratio=0, pass (no zero division)', () => {
    const result = applyCandidateConstraints(
      usgrowthTrust,
      'global_trust',
      makeCtx({ roleExposureByRole: emptyRoleExposure(), totalTrustValue: 0 }),
    )
    expect(result.blocked).not.toContain('DUPLICATE_ROLE')
    expect(result.constraints.duplicateRole).toBe('pass')
  })

  it('gold role (policy=GOLD): duplicateRole=na', () => {
    const result = applyCandidateConstraints(
      makeTrust({ policy: 'GOLD', cost: 0.20 }),
      'gold',
      makeCtx(),
    )
    expect(result.constraints.duplicateRole).toBe('na')
    expect(result.blocked).not.toContain('DUPLICATE_ROLE')
  })

  it('leveraged role (name contains "ブル"): duplicateRole=na', () => {
    const result = applyCandidateConstraints(
      makeTrust({ id: 'lever-fund', name: 'ブルファンド' }),
      'jp_trust',
      makeCtx(),
    )
    expect(result.constraints.duplicateRole).toBe('na')
  })
})

describe('applyCandidateConstraints: Gate9 notForTrading', () => {
  it('notForTrading=true: NOT_FOR_TRADING blocked, maxAmount=0', () => {
    const result = applyCandidateConstraints(
      makeTrust({ notForTrading: true }),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).toContain('NOT_FOR_TRADING')
    expect(result.constraints.notForTrading).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('notForTrading=false: pass, maxAmount>0', () => {
    const result = applyCandidateConstraints(
      makeTrust({ notForTrading: false }),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).not.toContain('NOT_FOR_TRADING')
    expect(result.constraints.notForTrading).toBe('pass')
    expect(result.maxAmount).toBeGreaterThan(0)
  })

  it('notForTrading absent (undefined): pass, no NOT_FOR_TRADING blocked', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).not.toContain('NOT_FOR_TRADING')
    expect(result.constraints.notForTrading).toBe('pass')
  })
})

describe('applyCandidateConstraints: Gate10 safeModeActive (P4-A18)', () => {
  it('safeModeActive=true: SAFE_MODE_ACTIVE blocked, maxAmount=0', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ safeModeActive: true }),
    )
    expect(result.blocked).toContain('SAFE_MODE_ACTIVE')
    expect(result.constraints.safeMode).toBe('fail')
    expect(result.maxAmount).toBe(0)
  })

  it('safeModeActive=false: pass, maxAmount>0', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ safeModeActive: false }),
    )
    expect(result.blocked).not.toContain('SAFE_MODE_ACTIVE')
    expect(result.constraints.safeMode).toBe('pass')
    expect(result.maxAmount).toBeGreaterThan(0)
  })

  it('safeModeActive absent (undefined): pass — constraint function treats undefined as inactive', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx(),
    )
    expect(result.blocked).not.toContain('SAFE_MODE_ACTIVE')
    expect(result.constraints.safeMode).toBe('pass')
  })

  it('safeModeActive=true + notForTrading=true: both reasons accumulated, neither suppresses the other', () => {
    const result = applyCandidateConstraints(
      makeTrust({ notForTrading: true }),
      'global_trust',
      makeCtx({ safeModeActive: true }),
    )
    expect(result.blocked).toContain('SAFE_MODE_ACTIVE')
    expect(result.blocked).toContain('NOT_FOR_TRADING')
    expect(result.maxAmount).toBe(0)
  })

  it('dqSuppressed=true takes priority: early return before SAFE_MODE gate is even evaluated', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ dqSuppressed: true, safeModeActive: true }),
    )
    expect(result.blocked).toEqual(['DQ_SUPPRESSED'])
    expect(result.constraints.safeMode).toBe('pass')
  })
})

// ── P4-A25: safeModeActive wiring invariants ─────────────────────────────────
// Verifies that state.safeMode.safe_mode.active (wired in useAppStore baseCtx)
// produces correct constraint outcomes for all candidate asset types.

describe('applyCandidateConstraints: Gate10 P4-A25 wiring invariants', () => {
  it('fail-closed default (active=true): jp_trust candidate blocked', () => {
    // DEFAULT_SAFE_MODE_SNAPSHOT.safe_mode.active = true
    // When safe_mode.json is absent/malformed, fail-closed default active=true
    // must block jp_trust candidates — not just global_trust.
    const result = applyCandidateConstraints(
      makeTrust(),
      'jp_trust',
      makeCtx({ safeModeActive: true }),
    )
    expect(result.constraints.safeMode).toBe('fail')
    expect(result.blocked).toContain('SAFE_MODE_ACTIVE')
    expect(result.maxAmount).toBe(0)
  })

  it('fail-closed default (active=true): gold candidate blocked', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'gold',
      makeCtx({ safeModeActive: true }),
    )
    expect(result.constraints.safeMode).toBe('fail')
    expect(result.blocked).toContain('SAFE_MODE_ACTIVE')
    expect(result.maxAmount).toBe(0)
  })

  it('live safe_mode.json active=false: safeMode constraint passes for all asset types', () => {
    // When backend writes safe_mode.json with active=false (normal operation),
    // no candidate is blocked by SAFE_MODE gate regardless of asset type.
    for (const assetType of ['jp_trust', 'global_trust', 'gold'] as const) {
      const result = applyCandidateConstraints(
        makeTrust(),
        assetType,
        makeCtx({ safeModeActive: false }),
      )
      expect(result.constraints.safeMode).toBe('pass')
      expect(result.blocked).not.toContain('SAFE_MODE_ACTIVE')
    }
  })

  it('safeMode block does not suppress other gates: all blocks accumulated', () => {
    // SAFE_MODE + cash budget exhausted → both constraints report fail, maxAmount=0
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ safeModeActive: true, availableCash: 0 }),
    )
    expect(result.constraints.safeMode).toBe('fail')
    expect(result.constraints.cashBudget).toBe('fail')
    expect(result.blocked).toContain('SAFE_MODE_ACTIVE')
    expect(result.blocked).toContain('INSUFFICIENT_CASH')
    expect(result.maxAmount).toBe(0)
  })
})

describe('applyCandidateConstraints: blocked invariant', () => {
  it('any single blocked reason → maxAmount=0', () => {
    const result = applyCandidateConstraints(
      makeTrust(),
      'global_trust',
      makeCtx({ availableCash: MIN_BUY_AMOUNT - 1 }),
    )
    expect(result.blocked.length).toBeGreaterThanOrEqual(1)
    expect(result.maxAmount).toBe(0)
  })

  it('multiple blocked reasons accumulated → maxAmount=0', () => {
    // noTrade + insufficient cash + vol too high
    const result = applyCandidateConstraints(
      makeTrust({ sigma: VOL_HARD_LIMIT }),
      'global_trust',
      makeCtx({ noTrade: true, availableCash: 0 }),
    )
    expect(result.blocked).toContain('NO_TRADE_EMERGENCY')
    expect(result.blocked).toContain('INSUFFICIENT_CASH')
    expect(result.blocked).toContain('VOL_TOO_HIGH')
    expect(result.blocked.length).toBeGreaterThanOrEqual(3)
    expect(result.maxAmount).toBe(0)
  })
})
