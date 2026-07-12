/**
 * P4-A24: loader tests for loadSafeMode / loadTierAViolations / loadTierAAlerts
 * Validates fail-closed design and schema validation logic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  loadSafeMode,
  loadTierAViolations,
  loadTierAAlerts,
  DEFAULT_SAFE_MODE_SNAPSHOT,
  DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT,
  DEFAULT_TIER_A_ALERTS_SNAPSHOT,
} from './loadStaticData'

function mockFetch(data: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(data),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const VALID_SAFE_MODE = {
  _meta: { version: 'v13.3', kind: 'operation_snapshot', not_for_trading: true },
  safe_mode: {
    active: false,
    triggered_at: null,
    trigger_reason: null,
    trigger_reason_detail: null,
    trigger_conditions: { tier1_data_stale: false, tier_a_t3_violated: false, crisis_regime: false, system_error: false },
    restrictions: { new_buys_frozen: false, rebalance_frozen: false, force_sell_active: false },
    estimated_resume_at: null,
    last_checked: '2026-06-17T01:00:00+00:00',
  },
}

const VALID_VIOLATIONS = {
  _meta: { version: 'v13.3', kind: 'live_tier_a_violations', not_for_trading: true },
  generated_at: '2026-06-17T01:00:00+00:00',
  status: 'ok',
  violations: [{ code: 'T1', triggered: false, severity: 'ok', target_type: 'holding', message: 'T1 clear', safe_mode_related: false }],
  summary: { total_violations: 0, t3_count: 0, safe_mode_related_count: 0 },
}

const VALID_ALERTS = {
  _meta: { version: 'v13.3', kind: 'live_tier_a_alerts', not_for_trading: true },
  generated_at: '2026-06-17T01:00:00+00:00',
  status: 'ok',
  alerts: [{ code: 'L1', triggered: false, severity: 'ok', message: 'L1 clear', recommended_action_type: 'MONITOR' }],
  summary: { total_triggered: 0, highest_level: 'NONE' },
}

describe('loadSafeMode', () => {
  it('fail-closed: returns active=true default on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await loadSafeMode()
    expect(result.source).toBe('default')
    expect(result.data.safe_mode.active).toBe(true)
    expect(result.data).toEqual(DEFAULT_SAFE_MODE_SNAPSHOT)
    expect(result.lastChecked).toBeNull()
  })

  it('fail-closed: returns active=true default on non-ok HTTP response', async () => {
    mockFetch({}, false)
    const result = await loadSafeMode()
    expect(result.source).toBe('default')
    expect(result.data.safe_mode.active).toBe(true)
  })

  it('fail-closed: returns default on wrong _meta.kind', async () => {
    mockFetch({ ...VALID_SAFE_MODE, _meta: { ...VALID_SAFE_MODE._meta, kind: 'wrong_kind' } })
    const result = await loadSafeMode()
    expect(result.source).toBe('default')
    expect(result.data.safe_mode.active).toBe(true)
  })

  it('fail-closed: returns default when safe_mode.active is not boolean', async () => {
    mockFetch({ ...VALID_SAFE_MODE, safe_mode: { ...VALID_SAFE_MODE.safe_mode, active: null } })
    const result = await loadSafeMode()
    expect(result.source).toBe('default')
    expect(result.data.safe_mode.active).toBe(true)
  })

  it('happy path: returns loaded data with correct source and lastChecked', async () => {
    mockFetch(VALID_SAFE_MODE)
    const result = await loadSafeMode()
    expect(result.source).toBe('loaded')
    expect(result.data.safe_mode.active).toBe(false)
    expect(result.lastChecked).toBe('2026-06-17T01:00:00+00:00')
    expect(result.data._meta.kind).toBe('operation_snapshot')
  })

  it('DEFAULT_SAFE_MODE_SNAPSHOT has active=true (fail-closed invariant)', () => {
    expect(DEFAULT_SAFE_MODE_SNAPSHOT.safe_mode.active).toBe(true)
    expect(DEFAULT_SAFE_MODE_SNAPSHOT.safe_mode.restrictions.new_buys_frozen).toBe(true)
  })
})

describe('loadTierAViolations', () => {
  it('returns unavailable default on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await loadTierAViolations()
    expect(result.source).toBe('default')
    expect(result.data.status).toBe('unavailable')
    expect(result.data).toEqual(DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT)
    expect(result.generatedAt).toBeNull()
  })

  it('returns default on non-ok HTTP response', async () => {
    mockFetch({}, false)
    const result = await loadTierAViolations()
    expect(result.source).toBe('default')
    expect(result.data.status).toBe('unavailable')
  })

  it('returns default on wrong _meta.kind', async () => {
    mockFetch({ ...VALID_VIOLATIONS, _meta: { kind: 'wrong' } })
    const result = await loadTierAViolations()
    expect(result.source).toBe('default')
    expect(result.data.status).toBe('unavailable')
  })

  it('returns default when violations is not an array', async () => {
    mockFetch({ ...VALID_VIOLATIONS, violations: null })
    const result = await loadTierAViolations()
    expect(result.source).toBe('default')
  })

  it('happy path: returns loaded data with violations and generatedAt', async () => {
    mockFetch(VALID_VIOLATIONS)
    const result = await loadTierAViolations()
    expect(result.source).toBe('loaded')
    expect(result.data.status).toBe('ok')
    expect(result.data.violations).toHaveLength(1)
    expect(result.data.violations[0].code).toBe('T1')
    expect(result.generatedAt).toBe('2026-06-17T01:00:00+00:00')
  })

  it('DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT has status=unavailable', () => {
    expect(DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT.status).toBe('unavailable')
    expect(DEFAULT_TIER_A_VIOLATIONS_SNAPSHOT.violations).toHaveLength(0)
  })
})

describe('loadTierAAlerts', () => {
  it('returns unavailable default on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await loadTierAAlerts()
    expect(result.source).toBe('default')
    expect(result.data.status).toBe('unavailable')
    expect(result.data).toEqual(DEFAULT_TIER_A_ALERTS_SNAPSHOT)
    expect(result.generatedAt).toBeNull()
  })

  it('returns default on non-ok HTTP response', async () => {
    mockFetch({}, false)
    const result = await loadTierAAlerts()
    expect(result.source).toBe('default')
    expect(result.data.status).toBe('unavailable')
  })

  it('returns default on wrong _meta.kind', async () => {
    mockFetch({ ...VALID_ALERTS, _meta: { kind: 'wrong' } })
    const result = await loadTierAAlerts()
    expect(result.source).toBe('default')
  })

  it('returns default when alerts is not an array', async () => {
    mockFetch({ ...VALID_ALERTS, alerts: null })
    const result = await loadTierAAlerts()
    expect(result.source).toBe('default')
  })

  it('happy path: returns loaded data with alerts and generatedAt', async () => {
    mockFetch(VALID_ALERTS)
    const result = await loadTierAAlerts()
    expect(result.source).toBe('loaded')
    expect(result.data.status).toBe('ok')
    expect(result.data.alerts).toHaveLength(1)
    expect(result.data.alerts[0].code).toBe('L1')
    expect(result.generatedAt).toBe('2026-06-17T01:00:00+00:00')
  })

  it('DEFAULT_TIER_A_ALERTS_SNAPSHOT has status=unavailable', () => {
    expect(DEFAULT_TIER_A_ALERTS_SNAPSHOT.status).toBe('unavailable')
    expect(DEFAULT_TIER_A_ALERTS_SNAPSHOT.alerts).toHaveLength(0)
    expect(DEFAULT_TIER_A_ALERTS_SNAPSHOT.summary.highest_level).toBe('NONE')
  })
})
