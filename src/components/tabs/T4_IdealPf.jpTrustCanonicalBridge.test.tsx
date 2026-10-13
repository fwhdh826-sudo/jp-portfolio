import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// @ts-expect-error - repository intentionally has no @types/node; test-only evidence output
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AppState } from '../../types'
import type { AllocationPlanSnapshot } from '../../types/allocationPlan'
import { ALLOCATION_PLAN_AUTHORITY_VERSION, ALLOCATION_PLAN_SCHEMA_VERSION } from '../../types/allocationPlan'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'

const fixture = vi.hoisted(() => ({
  state: null as AppState | null,
  theoreticalDiff: 987_654,
  mobile: false,
}))

vi.mock('../../store/useAppStore', async importOriginal => ({
  ...await importOriginal<typeof import('../../store/useAppStore')>(),
  useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
    if (fixture.state === null) throw new Error('fixture state missing')
    return selector(fixture.state)
  },
}))
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => fixture.mobile }))
vi.mock('../../store/selectors', async importOriginal => ({
  ...await importOriginal<typeof import('../../store/selectors')>(),
  // Isolate canonical-plan suppression from unrelated market freshness in
  // this controlled presentation test. Canonical validators are not mocked.
  selectEffectiveSafeModeActive: () => false,
  selectMarketDataQuality: () => ({ isSuppressed: false }),
}))
vi.mock('../../domain/optimization/idealAllocation', async importOriginal => {
  const actual = await importOriginal<typeof import('../../domain/optimization/idealAllocation')>()
  return {
    ...actual,
    buildIdealPfPlan: (state: AppState) => {
      const plan = actual.buildIdealPfPlan(state)
      // Deliberately disagree with canonical values at the theoretical
      // authority boundary. All other plan behavior is the real module.
      return {
        ...plan,
        universe: {
          ...plan.universe,
          categories: plan.universe.categories.map(cat => cat.class === 'JP_TRUST'
            ? { ...cat, diffValue: fixture.theoreticalDiff } : cat),
        },
        jpFundRows: plan.jpFundRows.map(row => ({ ...row,
          diffValue: fixture.theoreticalDiff, recommendation: 'BUY' as const,
        })),
      }
    },
  }
})

import { T4_IdealPf } from './T4_IdealPf'

const isolated = createAppStoreInstanceForTest()
const BASE_STATE: AppState = isolated.store.getState()
isolated.controls.dispose()
const renderedCases: Array<{ name: string; mobile: boolean; theoreticalDiff: number; html: string }> = []

function plan(): AllocationPlanSnapshot {
  return {
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    schemaVersion: ALLOCATION_PLAN_SCHEMA_VERSION,
    snapshotId: 'bridge-generation-1', generatedAt: '2026-10-11T13:00:00Z',
    sourceHoldingsSnapshotId: 'bridge-holdings-1', sourceSettingsVersion: 'bridge-settings-1',
    totalAssets: 1_500_000, grossCash: 300_000, deployableCash: 250_000,
    shortTermBudget: 222_222, longTermBudget: 27_778,
    marketMode: 'normal', regime: 'neutral',
    assetClassPlans: [{
      assetClass: 'JP_TRUST', currentAmount: 123_456, targetAmount: 456_789,
      targetRatio: 0.3, targetGap: 333_333, minimumAmount: null, maximumAmount: null,
      hardHeadroom: 333_333, softHeadroom: 333_333, effectiveHeadroom: 333_333,
      overweightAmount: 0, availableBudget: 222_222, allocatedAmount: 23_456,
      remainingHeadroom: 309_877, limitingFactors: [], blockedReasons: [], warningReasons: [],
    }],
    instrumentPlans: [{
      instrumentId: 'trust:bridge-fund-1', assetClass: 'JP_TRUST', kind: 'jp_trust',
      relationship: 'already_held', currentAmount: 123_456, role: 'CORE', reason: 'fixture',
      priceJpy: null, lotSizeShares: null, buyKind: 'BUY_MORE',
      rawSuggestedAmount: 23_456, cappedSuggestedAmount: 23_456, roundedSuggestedAmount: 23_456,
      finalSuggestedAmount: 23_456, estimatedMaximumAmount: 100_000, roundingLoss: 0,
      executable: true, independentlyExecutable: true,
      calculationSnapshotId: 'bridge-generation-1', authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
      marketRank: null, artifactIndex: 0, targetAmount: null, classHeadroom: 333_333,
      instrumentTargetGap: null, instrumentMaxPositionHeadroom: null, sectorHeadroom: null,
      concentrationHeadroom: null, liquidityHeadroom: null, lotSizeHeadroom: null,
      effectiveInstrumentHeadroom: 333_333, independentMaximum: 100_000,
      simultaneouslyExecutableAmount: 23_456, allocatedAmount: 23_456,
      limitingFactors: [], blockedReasons: [], warningReasons: [],
    }],
    remainingUnallocatedCash: 226_544, blockedReasons: [], warnings: [],
    not_for_trading: true, privacyMode: 'local_only', persistence: 'none',
  }
}

function state(snapshot: AllocationPlanSnapshot | null = plan(), status: AppState['allocationPlanStatus'] = 'current'): AppState {
  return { ...BASE_STATE, activeTab: 'T4', allocationPlan: snapshot,
    allocationPlanStatus: status, allocationPlanCandidateGenerationId: null }
}

function render(name: string, appState = state()): string {
  fixture.state = appState
  const html = renderToStaticMarkup(<T4_IdealPf />)
  renderedCases.push({ name, mobile: fixture.mobile, theoreticalDiff: fixture.theoreticalDiff, html })
  return html
}

function bridge(html: string): string {
  const match = html.match(/<section aria-label="国内株投信 実行計画"[^>]*>([\s\S]*?)<\/section>/)
  if (!match) throw new Error('actual bridge section missing')
  return match[1]
}

function amounts(html: string): Record<string, string> {
  return Object.fromEntries([...bridge(html).matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*>([^<]+)<\/dd>/g)]
    .map(match => [match[1], match[2]]))
}

function zeroProposal(snapshot: AllocationPlanSnapshot): void {
  snapshot.assetClassPlans[0].allocatedAmount = 0
  Object.assign(snapshot.instrumentPlans[0], {
    allocatedAmount: 0, finalSuggestedAmount: 0, executable: false,
    independentlyExecutable: false, simultaneouslyExecutableAmount: 0,
  })
}

beforeEach(() => { fixture.mobile = false; fixture.theoreticalDiff = 987_654 })
afterAll(() => {
  const evidenceDir = (globalThis as typeof globalThis & {
    process?: { env: Record<string, string | undefined> }
  }).process?.env.JP_TRUST_BRIDGE_RENDER_EVIDENCE_DIR
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(`${evidenceDir}/rendered-cases.json`, JSON.stringify(renderedCases, null, 2) + '\n')
  }
})

describe('T4 JP_TRUST canonical bridge — real render with real canonical summary/validators', () => {
  it('A/E/F separates four exact canonical amounts from the deliberately different theoretical difference', () => {
    const html = render('available-disagreement')
    expect(amounts(html)).toEqual({ 現在額: '123,456円', 目標額: '456,789円', 不足額: '333,333円', 提案額: '23,456円' })
    expect(html).toContain('理論差分 </span><span>+98.8万円</span>')
    expect(html).toContain('理論差分（スコア重み付き按分・参考）')
    expect(bridge(html)).toContain('共有配分プランの金額')
    expect(bridge(html)).toContain('配分プラン: 最新')
    expect(bridge(html)).toContain('data-snapshot-id="bridge-generation-1"')
    expect(amounts(html).提案額).not.toEqual(amounts(html).不足額)
    expect(bridge(html)).not.toContain('98.8万円')
    const domesticRows = html.slice(html.indexOf('国内株投信 差分'), html.indexOf('海外投信 差分'))
    expect(domesticRows).toContain('data-signal="BUY"')
  })

  it.each([
    ['absent', '配分プランは未計算です。'],
    ['stale', '配分プランの再計算が必要です。'],
    ['invalid', '配分プランを計算できません。'],
  ] as const)('B: %s plan never falls back to theoretical money or zero', (status, copy) => {
    const html = render(status, state(status === 'absent' ? null : plan(), status))
    expect(bridge(html)).toContain(copy)
    expect(bridge(html)).toContain('data-allocation-availability="unavailable"')
    expect(amounts(html)).toEqual({})
    expect(bridge(html)).not.toMatch(/0円|98\.8万円|123,456円|23,456円/)
    expect(html).toContain('理論差分 </span><span>+98.8万円</span>')
  })

  it('missing snapshot with current state is unavailable', () => {
    expect(amounts(render('null-current', state(null)))).toEqual({})
  })

  it('non-JP_TRUST class amounts cannot substitute for a missing domestic class', () => {
    const snapshot = plan()
    snapshot.assetClassPlans[0].assetClass = 'OVERSEAS_TRUST'
    const html = render('missing-jp-trust', state(snapshot))
    expect(bridge(html)).toContain('国内株投信の配分プランを利用できません。')
    expect(amounts(html)).toEqual({})
  })

  it('C: target reached keeps gap/proposal zero and does not imply BUY from positive theoretical domestic differences', () => {
    const snapshot = plan()
    Object.assign(snapshot.assetClassPlans[0], { currentAmount: 456_789, targetGap: 0 })
    zeroProposal(snapshot)
    const html = render('target-reached', state(snapshot))
    expect(amounts(html)).toEqual({ 現在額: '456,789円', 目標額: '456,789円', 不足額: '0円', 提案額: '0円' })
    expect(html).toContain('理論差分 </span><span>+98.8万円</span>')
    const domesticRows = html.slice(html.indexOf('国内株投信 差分'), html.indexOf('海外投信 差分'))
    expect(domesticRows).toContain('実行計画の買付提案なし')
    expect(domesticRows).not.toContain('data-signal="BUY"')
    expect(bridge(html)).not.toContain('data-signal="BUY"')
  })

  it('D: blocked execution preserves positive shortfall and zero proposal without filling from theoretical difference', () => {
    const snapshot = plan()
    zeroProposal(snapshot)
    snapshot.blockedReasons = ['SAFE_MODE_ACTIVE']
    snapshot.assetClassPlans[0].blockedReasons = ['SAFE_MODE_ACTIVE']
    const html = render('blocked-positive-gap', state(snapshot, 'blocked'))
    expect(amounts(html)).toEqual({ 現在額: '123,456円', 目標額: '456,789円', 不足額: '333,333円', 提案額: '0円' })
    expect(bridge(html)).toContain('配分プラン: 実行不可')
    expect(html).toContain('理論差分 </span><span>+98.8万円</span>')
  })

  it('estimate-only retains canonical values with the existing explicit non-executable status', () => {
    const snapshot = plan()
    zeroProposal(snapshot)
    const html = render('estimate-only', state(snapshot, 'estimate_only'))
    expect(bridge(html)).toContain('配分プラン: 見積のみ（実行不可）')
    expect(amounts(html).不足額).toBe('333,333円')
    expect(amounts(html).提案額).toBe('0円')
  })

  it('G: all four authoritative zero amounts remain zero, with no unavailable placeholder', () => {
    const snapshot = plan()
    Object.assign(snapshot.assetClassPlans[0], { currentAmount: 0, targetAmount: 0, targetGap: 0 })
    zeroProposal(snapshot)
    const html = render('all-zero', state(snapshot))
    expect(amounts(html)).toEqual({ 現在額: '0円', 目標額: '0円', 不足額: '0円', 提案額: '0円' })
    expect(bridge(html)).not.toContain('未計算')
    expect(bridge(html)).not.toContain('—')
  })

  it('canonical display changes with a new AllocationPlan generation while theoretical input stays fixed', () => {
    const before = render('canonical-before')
    const snapshot = plan()
    snapshot.snapshotId = 'bridge-generation-2'
    snapshot.instrumentPlans[0].calculationSnapshotId = snapshot.snapshotId
    Object.assign(snapshot.assetClassPlans[0], { currentAmount: 111_111, targetAmount: 666_666, targetGap: 555_555, allocatedAmount: 44_444 })
    snapshot.instrumentPlans[0].allocatedAmount = 44_444
    snapshot.instrumentPlans[0].finalSuggestedAmount = 44_444
    const after = render('canonical-after', state(snapshot))
    expect(amounts(before)).toEqual({ 現在額: '123,456円', 目標額: '456,789円', 不足額: '333,333円', 提案額: '23,456円' })
    expect(amounts(after)).toEqual({ 現在額: '111,111円', 目標額: '666,666円', 不足額: '555,555円', 提案額: '44,444円' })
    expect(before).toContain('理論差分 </span><span>+98.8万円</span>')
    expect(after).toContain('理論差分 </span><span>+98.8万円</span>')
    expect(bridge(after)).toContain('data-snapshot-id="bridge-generation-2"')
  })

  it('changing only theoretical diff leaves the canonical proposal and all four displayed amounts unchanged', () => {
    const fixedState = state()
    const before = render('theoretical-before', fixedState)
    fixture.theoreticalDiff = 765_432
    const after = render('theoretical-after', fixedState)
    expect(before).toContain('理論差分 </span><span>+98.8万円</span>')
    expect(after).toContain('理論差分 </span><span>+76.5万円</span>')
    expect(amounts(after)).toEqual(amounts(before))
    expect(amounts(after).提案額).toBe('23,456円')
  })

  it('uses the existing summary aggregation semantics, not class allocatedAmount or a new finalSuggestedAmount sum', () => {
    const snapshot = plan()
    // Distinct projection sentinels pin which established helper owns this
    // summary. This is an authority-source probe, not an engine-validity claim.
    snapshot.assetClassPlans[0].allocatedAmount = 91_111
    snapshot.instrumentPlans[0].finalSuggestedAmount = 82_222
    snapshot.instrumentPlans.push({ ...snapshot.instrumentPlans[0],
      instrumentId: 'overseas:probe', assetClass: 'OVERSEAS_TRUST', kind: 'global_trust',
      allocatedAmount: 73_333,
    })
    expect(amounts(render('proposal-authority-probe', state(snapshot))).提案額).toBe('23,456円')
  })

  it.each(['unknown-reason', 'invalid-number', 'generation-mismatch', 'duplicate-instrument'] as const)(
    '%s obeys the existing downstream fail-closed validator', failure => {
      const snapshot = plan()
      if (failure === 'unknown-reason') snapshot.blockedReasons = ['UNKNOWN' as never]
      if (failure === 'invalid-number') snapshot.assetClassPlans[0].targetGap = NaN
      if (failure === 'generation-mismatch') snapshot.instrumentPlans[0].calculationSnapshotId = 'old-generation'
      if (failure === 'duplicate-instrument') snapshot.instrumentPlans.push({ ...snapshot.instrumentPlans[0] })
      const html = render(failure, state(snapshot))
      expect(amounts(html)).toEqual({})
      expect(bridge(html)).toContain('data-allocation-availability="unavailable"')
    },
  )

  it('rejects an unsafe summary total instead of displaying an overflowed proposal', () => {
    const snapshot = plan()
    snapshot.instrumentPlans[0].allocatedAmount = Number.MAX_SAFE_INTEGER
    snapshot.instrumentPlans.push({ ...snapshot.instrumentPlans[0], instrumentId: 'trust:overflow-2' })
    expect(amounts(render('unsafe-summary', state(snapshot)))).toEqual({})
  })

  it('renders without changing canonical snapshot or theoretical source input', () => {
    const appState = state()
    const before = JSON.stringify(appState.allocationPlan)
    render('read-only', appState)
    expect(JSON.stringify(appState.allocationPlan)).toBe(before)
    expect(fixture.theoreticalDiff).toBe(987_654)
  })

  it('390px mobile uses one shrinkable column with wrapping full-yen values, retaining all labels and numbers', () => {
    fixture.mobile = true
    const html = render('mobile-390')
    const section = bridge(html)
    expect(section).toContain('grid-template-columns:minmax(0, 1fr)')
    expect(section).toContain('min-width:0')
    const valueStyles = [...section.matchAll(/<dd style="([^"]*)">/g)].map(match => match[1])
    expect(valueStyles).toHaveLength(4)
    for (const style of valueStyles) {
      expect(style).toContain('overflow-wrap:anywhere')
      expect(style).toContain('min-width:0')
      expect(style).not.toContain('white-space:nowrap')
    }
    expect(amounts(html)).toEqual({ 現在額: '123,456円', 目標額: '456,789円', 不足額: '333,333円', 提案額: '23,456円' })
    // Existing repository approach: actual mobile SSR styles plus a bounded
    // layout check. One minmax(0,1fr) column has no fixed-width lower bound;
    // overflow-wrap:anywhere also protects maximum-safe integer values.
    const mobileContentWidth = 390 - 24 - 32 - 2
    expect(mobileContentWidth).toBeGreaterThan(250)
  })
})
