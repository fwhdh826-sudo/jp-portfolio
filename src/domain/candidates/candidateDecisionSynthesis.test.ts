// @ts-expect-error - repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { INITIAL_TRUST } from '../../constants/trust'
import type { Holding } from '../../types'
import type {
  CandidateDecisionSynthesisCandidateInput,
  CandidateDecisionSynthesisInput,
  CandidateDecisionSynthesisProvenance,
  CandidateSynthesisClassNeed,
} from '../../types/candidateDecisionSynthesis'
import {
  JP_DOMESTIC_LOT_SIZE_SHARES,
  assertCandidateDecisionSynthesisInvariants,
  buildCandidateDecisionSynthesis,
  buildHoldingAllocationCandidates,
  candidateSynthesisActionRank,
  compareCandidateClassNeed,
  normalizeCandidateExecutionReferencePrice,
} from './candidateDecisionSynthesis'

const GENERATED_AT = '2026-08-14T01:00:00.000Z'
const ALLOCATION_ID = 'allocation:snapshot:1'
const CANDIDATE_GENERATION = '2026-08-13T22:14:38.374Z'
const shortTermTrust = INITIAL_TRUST.find(trust => trust.policy === 'JAPAN_SHORTTERM')!
const sourceText = readFileSync(new URL('./candidateDecisionSynthesis.ts', import.meta.url), 'utf8')
const typeText = readFileSync(new URL('../../types/candidateDecisionSynthesis.ts', import.meta.url), 'utf8')

function provenance(overrides: Partial<CandidateDecisionSynthesisProvenance> = {}): CandidateDecisionSynthesisProvenance {
  return {
    candidateGenerationId: CANDIDATE_GENERATION,
    candidatePublicationState: 'published_pass',
    candidateFreshness: 'fresh',
    allocationSnapshotId: ALLOCATION_ID,
    allocationSnapshotGeneratedAt: '2026-08-14T00:59:00.000Z',
    allocationSnapshotStatus: 'current',
    sourceHoldingsSnapshotId: 'holdings:generation:1',
    sourceSettingsVersion: 'settings:1',
    cashAuthorityUpdatedAt: '2026-08-14T00:58:00.000Z',
    marketDataAsOf: '2026-08-14T00:57:00.000Z',
    portfolioFitEvaluatedAt: '2026-08-14T00:59:30.000Z',
    candidatesStocksUpdatedAt: '2026-08-14T00:56:00.000Z',
    candidatesStocksSourceUpdatedAt: '2026-08-14T00:55:00.000Z',
    candidatesStocksRunToken: 'price-run-1',
    ...overrides,
  }
}

interface CandidateOptions {
  code?: string
  instrumentId?: string
  assetClass?: 'JP_STOCK' | 'JP_TRUST'
  relationship?: 'already_held' | 'new_to_portfolio' | 'unknown'
  executable?: boolean
  amount?: number
  hardGatePassed?: boolean
  fitRelationship?: 'already_held' | 'new_to_portfolio' | 'holding_match_unknown' | null
  targetGap?: number | null
  targetAmount?: number | null
  classBlocked?: readonly ('CLASS_TARGET_MISSING')[]
  classHeadroom?: number
  instrumentHeadroom?: number
  marketRank?: number | null
  marketScore?: number | null
  artifactIndex?: number
  blockedReasons?: CandidateDecisionSynthesisCandidateInput['canonicalAllocation']['blockedReasons']
  warnings?: CandidateDecisionSynthesisCandidateInput['canonicalAllocation']['warnings']
  namespace?: 'jp_stock_funnel' | 'jp_trust_registry'
  usesPrice?: boolean
  displayName?: string
}

function candidate(options: CandidateOptions = {}): CandidateDecisionSynthesisCandidateInput {
  const assetClass = options.assetClass ?? 'JP_STOCK'
  const code = assetClass === 'JP_STOCK' ? (options.code ?? '1001') : null
  const instrumentId = options.instrumentId ?? (
    assetClass === 'JP_STOCK' ? `stock:${code}` : `trust:${shortTermTrust.id}`
  )
  const namespace = options.namespace ?? (
    assetClass === 'JP_STOCK' ? 'jp_stock_funnel' : 'jp_trust_registry'
  )
  const executable = options.executable ?? true
  const amount = options.amount ?? (executable ? 50_000 : 0)
  const relationship = options.relationship ?? 'new_to_portfolio'
  const targetGap = options.targetGap === undefined ? 500_000 : options.targetGap
  const targetAmount = options.targetAmount === undefined ? 1_000_000 : options.targetAmount
  return {
    instrumentId,
    assetClass,
    namespace,
    displayName: options.displayName ?? (assetClass === 'JP_STOCK' ? `Stock ${code}` : shortTermTrust.name),
    code,
    artifactIndex: options.artifactIndex ?? 0,
    candidateQuality: {
      source: assetClass === 'JP_STOCK' ? 'candidate_funnel' : 'trust_registry',
      marketRank: options.marketRank === undefined ? (assetClass === 'JP_STOCK' ? 1 : null) : options.marketRank,
      marketScore: options.marketScore === undefined ? (assetClass === 'JP_STOCK' ? 80 : null) : options.marketScore,
      tier: assetClass === 'JP_STOCK' ? 'actionable' : null,
      dataConfidence: assetClass === 'JP_STOCK' ? 1 : null,
      selectedReasons: ['SELECTED_B', 'SELECTED_A'],
      riskReasons: ['RISK_B', 'RISK_A'],
    },
    portfolioFit: {
      status: assetClass === 'JP_STOCK' ? 'evaluated' : 'not_evaluated',
      relationship: options.fitRelationship === undefined
        ? (assetClass === 'JP_STOCK' ? (relationship === 'unknown' ? 'holding_match_unknown' : relationship) : null)
        : options.fitRelationship,
      reasons: assetClass === 'JP_STOCK' ? ['NEW_TO_PORTFOLIO'] : [],
      risks: [],
      hardGatePassed: options.hardGatePassed ?? true,
    },
    canonicalAllocation: {
      relationship,
      executable,
      finalSuggestedAmount: amount,
      calculationSnapshotId: ALLOCATION_ID,
      classNeed: {
        targetGap,
        targetAmount,
        blockedReasons: options.classBlocked ?? [],
      },
      allocationRole: {
        assetClassTargetGap: typeof targetGap === 'number' && targetGap >= 0 ? targetGap : 0,
        assetClassTargetRatio: 0.2,
        classHeadroom: options.classHeadroom ?? 500_000,
        instrumentHeadroom: options.instrumentHeadroom ?? 250_000,
      },
      blockedReasons: options.blockedReasons ?? [],
      warnings: options.warnings ?? [],
      limitingFactors: [],
    },
    whyThis: [],
    whyNotExecutable: [],
    usesCandidatesStocksExecutionPrice: options.usesPrice ?? false,
  }
}

function input(
  candidates: readonly CandidateDecisionSynthesisCandidateInput[],
  overrides: Partial<CandidateDecisionSynthesisInput> = {},
): CandidateDecisionSynthesisInput {
  return {
    generatedAt: GENERATED_AT,
    provenance: provenance(),
    allocationPlanCandidateGenerationId: CANDIDATE_GENERATION,
    candidates,
    datasetReasons: [],
    ...overrides,
  }
}

function holding(code: string): Holding {
  return {
    code,
    name: `Holding ${code}`,
    eval: 100_000,
    pnlPct: 0,
    mu: 0,
    sigma: 0.1,
    sigmaSource: 'static',
    beta: 1,
    sector: '銀行業',
    target: 0,
    alert: 0,
    lock: false,
    mitsu: false,
    ma: false,
    rsi: 50,
    macd: false,
    vol: false,
    mom3m: 0,
    roe: 0,
    per: 0,
    pbr: 0,
    epsG: 0,
    cfOk: false,
    de: 0,
    divG: 0,
    score: 0,
    decision: 'HOLD',
    ev: 0,
  }
}

describe('CAND-SYN-1A schema, privacy, and pure authority (A/M/Q)', () => {
  it('implements the frozen schema/version/privacy/persistence contract', () => {
    const result = buildCandidateDecisionSynthesis(input([candidate()]))
    expect(result).toMatchObject({
      schemaVersion: 'candidate-decision-synthesis-1',
      authorityVersion: 'cand-syn-v1',
      status: 'available',
      privacyMode: 'local_only',
      persistence: 'none',
      not_for_trading: true,
    })
    expect(typeText).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|telemetry/)
    expect(sourceText).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|telemetry/)
    expect(typeText).toContain("export type SynthesisAction = 'ADD' | 'BUY_NEW' | 'WATCH' | 'BLOCKED'")
    expect(typeText).not.toMatch(/\bSELL\b|NO_ACTION/)
  })

  it('A1 copies the canonical executable amount bit-for-bit', () => {
    const result = buildCandidateDecisionSynthesis(input([candidate({ amount: 123_457 })]))
    expect(result.decisions[0].money).toEqual({
      kind: 'EXECUTABLE',
      executableAmountJpy: 123_457,
      calculationSnapshotId: ALLOCATION_ID,
    })
  })

  it.each([
    ['executable zero', { executable: true, amount: 0 }],
    ['non-executable positive', { executable: false, amount: 1 }],
    ['amount above class headroom', { executable: true, amount: 50_001, classHeadroom: 50_000 }],
    ['amount above instrument headroom', { executable: true, amount: 50_001, instrumentHeadroom: 50_000 }],
    ['amount above canonical target gap', { executable: true, amount: 50_001, targetGap: 50_000 }],
  ] as const)('A2/E fails closed for malformed canonical projection: %s', (_label, options) => {
    const result = buildCandidateDecisionSynthesis(input([candidate(options)]))
    expect(result.status).toBe('invalid')
    expect(result.decisions).toEqual([])
  })

  it('A3 only demotes: a failed hard gate becomes WATCH with no executable money', () => {
    const result = buildCandidateDecisionSynthesis(input([candidate({ hardGatePassed: false })]))
    expect(result.decisions).toEqual([])
    expect(result.watchList[0]).toMatchObject({ action: 'WATCH', money: { kind: 'NOT_EXECUTABLE' } })
    expect(result.watchList[0].money.executableAmountJpy).toBe(0)
  })

  it('A4 does not let a candidate score authorize money', () => {
    const result = buildCandidateDecisionSynthesis(input([
      candidate({ executable: false, amount: 0, marketScore: 999_999_999 }),
    ]))
    expect(result.decisions[0].action).toBe('BUY_NEW')
    expect(result.decisions[0].money).toEqual({ kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 })
  })

  it('keeps stock/trust scores as evidence only and never mixes them cross-class', () => {
    const stock = candidate({ executable: false, amount: 0, marketScore: -999_999, targetGap: 100, targetAmount: 1_000 })
    const trust = candidate({ assetClass: 'JP_TRUST', executable: false, amount: 0, marketScore: 999_999, targetGap: 600, targetAmount: 1_000 })
    const result = buildCandidateDecisionSynthesis(input([stock, trust]))
    expect(result.decisions.map(entry => entry.assetClass)).toEqual(['JP_TRUST', 'JP_STOCK'])
    expect(result.decisions.map(entry => entry.candidateQuality.marketScore)).toEqual([999_999, -999_999])
  })

  it('keeps portfolioFit numeric soft contribution at zero', () => {
    const value = candidate({ executable: false, amount: 0 }) as CandidateDecisionSynthesisCandidateInput & {
      portfolioFit: CandidateDecisionSynthesisCandidateInput['portfolioFit'] & {
        portfolioFitScore: number
        portfolioFitRank: number
      }
    }
    value.portfolioFit.portfolioFitScore = -1_000_000
    value.portfolioFit.portfolioFitRank = 999_999
    const baseline = buildCandidateDecisionSynthesis(input([candidate({ executable: false, amount: 0 })]))
    const injected = buildCandidateDecisionSynthesis(input([value]))
    expect(injected.decisions.map(entry => entry.instrumentId)).toEqual(
      baseline.decisions.map(entry => entry.instrumentId),
    )
    expect(injected.decisions.map(entry => entry.money)).toEqual(baseline.decisions.map(entry => entry.money))
    expect(typeText).not.toMatch(/portfolioFitScore|portfolioFitRank/)
  })

  it('M1/M3/M4 has no legacy sizing source or reference-maximum field', () => {
    const combined = `${sourceText}\n${typeText}`
    expect(combined).not.toMatch(/applyCandidateConstraints|applyStockCandidateGates|SIZING_TIER_LIMIT|CandidateItem\.suggestedAmount/)
    expect(combined).not.toMatch(/estimatedMaximumAmount/)
    expect(combined).not.toMatch(/\bmaxAmount\b/)
  })

  it('M2 performs no arithmetic on finalSuggestedAmount', () => {
    expect(sourceText).not.toMatch(/finalSuggestedAmount\s*[*/+-]/)
    expect(sourceText).not.toMatch(/[*/+-]\s*allocation\.finalSuggestedAmount/)
    expect(sourceText).not.toMatch(/cash\s*[*\/]|confidence\s*[*\/]|score\s*[*\/]/i)
  })

  it.each([
    [331.5, 332],
    [677.7, 678],
    [2958.5, 2959],
    [100, 100],
  ])('Q7 conservatively normalizes execution-reference price %s -> %s', (raw, expected) => {
    expect(normalizeCandidateExecutionReferencePrice(raw)).toBe(expected)
  })

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, '100'])
    ('Q7 rejects invalid execution-reference price %s', raw => {
      expect(normalizeCandidateExecutionReferencePrice(raw)).toBeNull()
    })

  it('Q8 freezes the JP domestic lot metadata without activating a join', () => {
    expect(JP_DOMESTIC_LOT_SIZE_SHARES).toBe(100)
    expect(sourceText).not.toMatch(/from ['"].*candidatesStocks|CandidatesStocksData|isCandidatesStocksUsable/)
  })
})

describe('CAND-SYN-1A identity and action semantics (D)', () => {
  it('D1 maps already-held canonical relationship to ADD', () => {
    const result = buildCandidateDecisionSynthesis(input([
      candidate({ relationship: 'already_held', fitRelationship: 'already_held' }),
    ]))
    expect(result.decisions[0]).toMatchObject({ action: 'ADD', relationship: 'already_held' })
  })

  it('D2 maps new-to-portfolio canonical relationship to BUY_NEW', () => {
    const result = buildCandidateDecisionSynthesis(input([candidate()]))
    expect(result.decisions[0]).toMatchObject({ action: 'BUY_NEW', relationship: 'new_to_portfolio' })
  })

  it('D3 maps holding-match-unknown evidence to BLOCKED', () => {
    const result = buildCandidateDecisionSynthesis(input([
      candidate({ fitRelationship: 'holding_match_unknown' }),
    ]))
    expect(result.watchList[0]).toMatchObject({ action: 'BLOCKED', relationship: 'new_to_portfolio' })
  })

  it('D4 mixes held stock, new stock, held trust, and new trust in one deterministic authority', () => {
    const trustId2 = INITIAL_TRUST.filter(trust => trust.policy === 'JAPAN_SHORTTERM')[1].id
    const entries = [
      candidate({ code: '1002', instrumentId: 'stock:1002', relationship: 'already_held', fitRelationship: 'already_held', executable: false, amount: 0, artifactIndex: 2 }),
      candidate({ code: '1001', instrumentId: 'stock:1001', executable: false, amount: 0, artifactIndex: 1 }),
      candidate({ assetClass: 'JP_TRUST', relationship: 'already_held', executable: false, amount: 0, artifactIndex: 0 }),
      candidate({ assetClass: 'JP_TRUST', instrumentId: `trust:${trustId2}`, relationship: 'new_to_portfolio', executable: false, amount: 0, artifactIndex: 1 }),
    ]
    const result = buildCandidateDecisionSynthesis(input(entries))
    expect(result.status).toBe('available')
    expect(result.decisions).toHaveLength(3)
    expect(new Set(result.decisions.map(entry => entry.action))).toEqual(new Set(['ADD', 'BUY_NEW']))
  })

  it('D5 orders a more-underweight JP_TRUST before JP_STOCK within the same executability tier', () => {
    const stock = candidate({ executable: false, amount: 0, targetGap: 100, targetAmount: 1_000 })
    const trust = candidate({ assetClass: 'JP_TRUST', executable: false, amount: 0, targetGap: 600, targetAmount: 1_000 })
    const result = buildCandidateDecisionSynthesis(input([stock, trust]))
    expect(result.decisions.map(entry => entry.assetClass)).toEqual(['JP_TRUST', 'JP_STOCK'])
  })

  it('fails closed for duplicate canonical identity and never emits ADD plus BUY_NEW for one instrument', () => {
    const result = buildCandidateDecisionSynthesis(input([
      candidate({ relationship: 'already_held', fitRelationship: 'already_held' }),
      candidate({ relationship: 'new_to_portfolio' }),
    ]))
    expect(result.status).toBe('invalid')
    expect(result.datasetReasons).toContain('DUPLICATE_INSTRUMENT_ID')
    expect(result.decisions).toEqual([])
  })

  it.each([
    ['unknown namespace', { namespace: 'overseas_funnel' }],
    ['unsupported asset class', { assetClass: 'GOLD' }],
    ['fuzzy display-name identity', { instrumentId: 'stock:Toyota', code: '7203' }],
  ])('fails closed without a legacy fallback: %s', (_label, patchValue) => {
    const malformed = { ...candidate(), ...patchValue } as unknown as CandidateDecisionSynthesisCandidateInput
    const result = buildCandidateDecisionSynthesis(input([malformed]))
    expect(result.status).toBe('invalid')
    expect(result.decisions).toEqual([])
    expect(result.watchList).toEqual([])
  })

  it('fails closed for an unknown canonical allocation relationship', () => {
    const result = buildCandidateDecisionSynthesis(input([candidate({ relationship: 'unknown' })]))
    expect(result.status).toBe('invalid')
    expect(result.decisions).toEqual([])
  })
})

describe('CAND-SYN-1A deterministic ordering and limits (C)', () => {
  it('uses the exact frozen actionRank mapping', () => {
    expect(candidateSynthesisActionRank('ADD')).toBe(0)
    expect(candidateSynthesisActionRank('BUY_NEW')).toBe(0)
    expect(candidateSynthesisActionRank('WATCH')).toBe(1)
    expect(candidateSynthesisActionRank('BLOCKED')).toBe(2)
  })

  it('uses BigInt cross multiplication, with zero need before invalid tier 1', () => {
    const sixtyPercent: CandidateSynthesisClassNeed = { targetGap: 3, targetAmount: 5, blockedReasons: [] }
    const tenPercent: CandidateSynthesisClassNeed = { targetGap: 1, targetAmount: 10, blockedReasons: [] }
    const zero: CandidateSynthesisClassNeed = { targetGap: 0, targetAmount: 10, blockedReasons: [] }
    const invalid: CandidateSynthesisClassNeed = { targetGap: null, targetAmount: null, blockedReasons: ['CLASS_TARGET_MISSING'] }
    expect(compareCandidateClassNeed(sixtyPercent, tenPercent)).toBeLessThan(0)
    expect(compareCandidateClassNeed(tenPercent, zero)).toBeLessThan(0)
    expect(compareCandidateClassNeed(zero, invalid)).toBeLessThan(0)
    expect(sourceText).toContain('BigInt(left.targetGap as number) * BigInt(right.targetAmount as number)')
    expect(sourceText).not.toMatch(/epsilon|Number\.EPSILON/)
  })

  it('orders EXECUTABLE before non-executable regardless of class need', () => {
    const executable = candidate({ code: '1101', instrumentId: 'stock:1101', targetGap: 100_000, targetAmount: 1_000_000 })
    const nonExecutable = candidate({ code: '1102', instrumentId: 'stock:1102', executable: false, amount: 0, targetGap: 999_000, targetAmount: 1_000_000, marketRank: 1 })
    const result = buildCandidateDecisionSynthesis(input([nonExecutable, executable]))
    expect(result.decisions[0].instrumentId).toBe('stock:1101')
  })

  it('orders WATCH before BLOCKED after money/action classification', () => {
    const watched = candidate({ code: '1201', instrumentId: 'stock:1201', hardGatePassed: false, executable: false, amount: 0 })
    const blocked = candidate({ code: '1202', instrumentId: 'stock:1202', executable: false, amount: 0, blockedReasons: ['CLASS_FULL'] })
    const result = buildCandidateDecisionSynthesis(input([blocked, watched]))
    expect(result.watchList.map(entry => entry.action)).toEqual(['WATCH', 'BLOCKED'])
  })

  it('uses namespace only after equal class need and never lets it override class need', () => {
    const stock = candidate({ code: '1301', instrumentId: 'stock:1301', executable: false, amount: 0, targetGap: 1, targetAmount: 2 })
    const trust = candidate({ assetClass: 'JP_TRUST', executable: false, amount: 0, targetGap: 1, targetAmount: 2 })
    const tied = buildCandidateDecisionSynthesis(input([trust, stock]))
    expect(tied.decisions.map(entry => entry.assetClass)).toEqual(['JP_STOCK', 'JP_TRUST'])

    const greaterTrustNeed = buildCandidateDecisionSynthesis(input([
      stock,
      candidate({ assetClass: 'JP_TRUST', executable: false, amount: 0, targetGap: 3, targetAmount: 4 }),
    ]))
    expect(greaterTrustNeed.decisions[0].assetClass).toBe('JP_TRUST')
  })

  it('uses marketRank and artifactIndex only within one namespace, then instrumentId', () => {
    const entries = [
      candidate({ code: '1403', instrumentId: 'stock:1403', executable: false, amount: 0, marketRank: null, artifactIndex: 0 }),
      candidate({ code: '1402', instrumentId: 'stock:1402', executable: false, amount: 0, marketRank: 2, artifactIndex: 0 }),
      candidate({ code: '1401', instrumentId: 'stock:1401', executable: false, amount: 0, marketRank: 1, artifactIndex: 9 }),
    ]
    const result = buildCandidateDecisionSynthesis(input(entries))
    expect(result.decisions.map(entry => entry.instrumentId)).toEqual(['stock:1401', 'stock:1402', 'stock:1403'])

    const idTie = buildCandidateDecisionSynthesis(input([
      candidate({ code: '1502', instrumentId: 'stock:1502', executable: false, amount: 0, marketRank: 1, artifactIndex: 1 }),
      candidate({ code: '1501', instrumentId: 'stock:1501', executable: false, amount: 0, marketRank: 1, artifactIndex: 1 }),
    ]))
    expect(idTie.decisions.map(entry => entry.instrumentId)).toEqual(['stock:1501', 'stock:1502'])
  })

  it('C1 repeats the same semantic input 100 times with the same structure and order', () => {
    const value = input([
      candidate({ code: '1603', instrumentId: 'stock:1603', executable: false, amount: 0, marketRank: 3 }),
      candidate({ code: '1601', instrumentId: 'stock:1601', executable: false, amount: 0, marketRank: 1 }),
      candidate({ code: '1602', instrumentId: 'stock:1602', executable: false, amount: 0, marketRank: 2 }),
    ])
    const expected = buildCandidateDecisionSynthesis(value)
    for (let run = 0; run < 100; run += 1) {
      expect(buildCandidateDecisionSynthesis(structuredClone(value))).toEqual(expected)
    }
  })

  it('C4 ignores Date.now for ranking and identity', () => {
    const value = input([candidate()])
    const first = buildCandidateDecisionSynthesis(value)
    const now = vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999_999)
    const second = buildCandidateDecisionSynthesis(value)
    now.mockRestore()
    expect(second).toEqual(first)
    expect(sourceText).not.toContain('Date.now')
  })

  it('C5 is invariant to non-authoritative input array order', () => {
    const entries = [
      candidate({ code: '1701', instrumentId: 'stock:1701', executable: false, amount: 0, marketRank: 3 }),
      candidate({ code: '1702', instrumentId: 'stock:1702', executable: false, amount: 0, marketRank: 1 }),
      candidate({ code: '1703', instrumentId: 'stock:1703', executable: false, amount: 0, marketRank: 2 }),
    ]
    expect(buildCandidateDecisionSynthesis(input(entries)))
      .toEqual(buildCandidateDecisionSynthesis(input([entries[2], entries[0], entries[1]])))
  })

  it('freezes decisions at 3 and watchList at 10 with list-local ranks', () => {
    const decisions = Array.from({ length: 5 }, (_, index) => candidate({
      code: String(2001 + index),
      instrumentId: `stock:${2001 + index}`,
      executable: false,
      amount: 0,
      marketRank: index + 1,
      artifactIndex: index,
    }))
    const watches = Array.from({ length: 12 }, (_, index) => candidate({
      code: String(2101 + index),
      instrumentId: `stock:${2101 + index}`,
      executable: false,
      amount: 0,
      hardGatePassed: false,
      marketRank: index + 1,
      artifactIndex: index,
    }))
    const result = buildCandidateDecisionSynthesis(input([...watches.reverse(), ...decisions.reverse()]))
    expect(result.decisions).toHaveLength(3)
    expect(result.watchList).toHaveLength(10)
    expect(result.decisions.map(entry => entry.rank)).toEqual([1, 2, 3])
    expect(result.watchList.map(entry => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('CAND-SYN-1A provenance, invariants, failure, and immutability', () => {
  it('carries all 14 frozen provenance fields', () => {
    const expected = provenance()
    const result = buildCandidateDecisionSynthesis(input([candidate()], { provenance: expected }))
    expect(result.provenance).toEqual(expected)
    expect(Object.keys(result.provenance)).toHaveLength(14)
  })

  it.each([
    ['candidate generation', { candidateGenerationId: '2026-08-13T22:15:00.000Z' }],
    ['allocation id', { allocationSnapshotId: 'allocation:snapshot:2' }],
    ['allocation generation', { allocationSnapshotGeneratedAt: '2026-08-14T00:59:01.000Z' }],
    ['holdings generation', { sourceHoldingsSnapshotId: 'holdings:generation:2' }],
    ['settings generation', { sourceSettingsVersion: 'settings:2' }],
    ['cash generation', { cashAuthorityUpdatedAt: '2026-08-14T00:58:01.000Z' }],
    ['market generation', { marketDataAsOf: '2026-08-14T00:57:01.000Z' }],
    ['fit generation', { portfolioFitEvaluatedAt: '2026-08-14T00:59:31.000Z' }],
    ['price updated generation', { candidatesStocksUpdatedAt: '2026-08-14T00:56:01.000Z' }],
    ['price source generation', { candidatesStocksSourceUpdatedAt: '2026-08-14T00:55:01.000Z' }],
    ['price run token', { candidatesStocksRunToken: 'price-run-2' }],
  ])('changes synthesisId when %s changes', (_label, changed) => {
    const base = buildCandidateDecisionSynthesis(input([candidate()]))
    const changedProvenance = provenance(changed as Partial<CandidateDecisionSynthesisProvenance>)
    const baseCandidate = candidate()
    const changedCandidate: CandidateDecisionSynthesisCandidateInput = {
      ...baseCandidate,
      canonicalAllocation: {
        ...baseCandidate.canonicalAllocation,
        calculationSnapshotId: changedProvenance.allocationSnapshotId,
      },
    }
    const next = buildCandidateDecisionSynthesis(input([changedCandidate], {
      provenance: changedProvenance,
      allocationPlanCandidateGenerationId: changedProvenance.candidateGenerationId,
    }))
    expect(next.synthesisId).not.toBe(base.synthesisId)
  })

  it('does not include generatedAt metadata in semantic identity', () => {
    const first = buildCandidateDecisionSynthesis(input([candidate()]))
    const second = buildCandidateDecisionSynthesis(input([candidate()], {
      generatedAt: '2026-08-14T01:00:01.000Z',
    }))
    expect(second.synthesisId).toBe(first.synthesisId)
  })

  it.each([
    ['missing holdings generation', { sourceHoldingsSnapshotId: '' }],
    ['missing settings generation', { sourceSettingsVersion: '' }],
    ['malformed fit time', { portfolioFitEvaluatedAt: '2026/08/14' }],
  ])('fails closed for required provenance: %s', (_label, changed) => {
    const result = buildCandidateDecisionSynthesis(input([candidate()], {
      provenance: provenance(changed as Partial<CandidateDecisionSynthesisProvenance>),
    }))
    expect(result.status).toBe('invalid')
    expect(result.datasetReasons).toContain('MISSING_REQUIRED_PROVENANCE')
  })

  it('returns an invalid frozen result instead of throwing for an absent provenance object', () => {
    const malformed = { ...input([candidate()]), provenance: undefined } as unknown as CandidateDecisionSynthesisInput
    expect(() => buildCandidateDecisionSynthesis(malformed)).not.toThrow()
    expect(buildCandidateDecisionSynthesis(malformed)).toMatchObject({
      status: 'invalid',
      decisions: [],
      watchList: [],
    })
  })

  it('enforces I-SYN-1 and I-SYN-3 generation/snapshot state', () => {
    const mismatch = buildCandidateDecisionSynthesis(input([candidate()], {
      allocationPlanCandidateGenerationId: 'different-generation',
    }))
    expect(mismatch.status).toBe('invalid')
    expect(mismatch.datasetReasons).toContain('ALLOCATION_CANDIDATE_GENERATION_MISMATCH')

    const stale = buildCandidateDecisionSynthesis(input([candidate()], {
      provenance: provenance({ allocationSnapshotStatus: 'stale' }),
    }))
    expect(stale.status).toBe('invalid')
    expect(stale.datasetReasons).toContain('ALLOCATION_SNAPSHOT_UNAVAILABLE')
  })

  it('enforces I-SYN-2 calculation snapshot identity', () => {
    const baseCandidate = candidate()
    const value: CandidateDecisionSynthesisCandidateInput = {
      ...baseCandidate,
      canonicalAllocation: { ...baseCandidate.canonicalAllocation, calculationSnapshotId: 'allocation:other' },
    }
    const result = buildCandidateDecisionSynthesis(input([value]))
    expect(result.status).toBe('invalid')
    expect(result.datasetReasons).toContain('ALLOCATION_SNAPSHOT_ID_MISMATCH')
  })

  it('enforces I-SYN-7 price-generation provenance without implementing a price join', () => {
    const result = buildCandidateDecisionSynthesis(input([candidate({ usesPrice: true })], {
      provenance: provenance({ candidatesStocksUpdatedAt: null }),
    }))
    expect(result.status).toBe('invalid')
    expect(result.datasetReasons).toContain('EXECUTION_PRICE_PROVENANCE_MISSING')
  })

  it('reports the exact pure I-SYN invariant ids and leaves lifecycle enforcement to 1B', () => {
    const result = buildCandidateDecisionSynthesis(input([candidate()]))
    const invariants = assertCandidateDecisionSynthesisInvariants(result, {
      allocationPlanCandidateGenerationId: 'wrong',
      usesCandidatesStocksExecutionPrice: true,
      expectedSynthesisId: 'wrong',
    })
    expect(invariants.ok).toBe(false)
    expect(invariants.violated).toEqual(['I-SYN-1', 'I-SYN-6', 'I-SYN-8'])
  })

  it('does not mutate caller arrays or nested objects and deeply freezes output', () => {
    const value = input([candidate({ warnings: ['ESTIMATE_ONLY', 'MARKET_CAUTION'] })])
    const before = structuredClone(value)
    const result = buildCandidateDecisionSynthesis(value)
    expect(value).toEqual(before)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.decisions)).toBe(true)
    expect(Object.isFrozen(result.decisions[0])).toBe(true)
    expect(Object.isFrozen(result.decisions[0].candidateQuality.selectedReasons)).toBe(true)
  })

  it('normalizes diagnostic arrays independently of caller order', () => {
    const baseCandidate = candidate({ warnings: ['ESTIMATE_ONLY', 'MARKET_CAUTION'] })
    const first: CandidateDecisionSynthesisCandidateInput = {
      ...baseCandidate,
      canonicalAllocation: {
        ...baseCandidate.canonicalAllocation,
        blockedReasons: ['JP_STOCK_CAP', 'CLASS_FULL', 'JP_STOCK_CAP'],
        limitingFactors: ['LOT_SIZE', 'CLASS_HEADROOM', 'LOT_SIZE'],
      },
    }
    const result = buildCandidateDecisionSynthesis(input([first]))
    expect(result.watchList[0].blockingReasons).toEqual(['CLASS_FULL', 'JP_STOCK_CAP'])
    expect(result.watchList[0].warnings).toEqual(['MARKET_CAUTION', 'ESTIMATE_ONLY'])
    expect(result.watchList[0].limitingFactors).toEqual(['CLASS_HEADROOM', 'LOT_SIZE'])
  })

  it('WATCH/BLOCKED never exposes legacy or reference monetary fields', () => {
    const result = buildCandidateDecisionSynthesis(input([
      candidate({ hardGatePassed: false }),
      candidate({ code: '2202', instrumentId: 'stock:2202', executable: false, amount: 0, blockedReasons: ['CLASS_FULL'] }),
    ]))
    for (const entry of result.watchList) {
      expect(entry).not.toHaveProperty('amount')
      expect(entry).not.toHaveProperty('suggestedAmount')
      expect(entry).not.toHaveProperty('maxAmount')
      expect(entry).not.toHaveProperty('estimatedMaximumAmount')
      expect(entry.money).toEqual({ kind: 'NOT_EXECUTABLE', executableAmountJpy: 0 })
    }
  })
})

describe('CAND-SYN-1A population-A holding adapter', () => {
  it('uses canonical normalized stock identity and BUY_MORE semantics', () => {
    const result = buildHoldingAllocationCandidates({ holdings: [holding(' １００３.t ')] })
    expect(result).toEqual({
      status: 'available',
      candidates: [{
        instrumentId: 'stock:1003',
        buyKind: 'BUY_MORE',
        marketRank: null,
        artifactIndex: 0,
        confidence: null,
      }],
    })
  })

  it('is deterministic across holding input order', () => {
    const left = buildHoldingAllocationCandidates({ holdings: [holding('1002'), holding('1001')] })
    const right = buildHoldingAllocationCandidates({ holdings: [holding('1001'), holding('1002')] })
    expect(left).toEqual(right)
    expect(left.candidates.map(item => item.instrumentId)).toEqual(['stock:1001', 'stock:1002'])
  })

  it.each([
    ['malformed', [holding('bad code')]],
    ['duplicate', [holding('1001'), holding('１００１.T')]],
  ] as const)('fails closed for %s holding identity', (_label, holdings) => {
    expect(buildHoldingAllocationCandidates({ holdings })).toEqual({ status: 'invalid', candidates: [] })
  })

  it('does not supply price, lot, cash, headroom, or amount fields in 1A', () => {
    const result = buildHoldingAllocationCandidates({ holdings: [holding('1001')] })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/priceJpy|lotSizeShares|cash|headroom|amount/i)
  })

  it('returns a deeply immutable result', () => {
    const result = buildHoldingAllocationCandidates({ holdings: [holding('1001')] })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.candidates)).toBe(true)
    expect(Object.isFrozen(result.candidates[0])).toBe(true)
  })
})
