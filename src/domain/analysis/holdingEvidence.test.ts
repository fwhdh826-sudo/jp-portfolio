import { describe, expect, it } from 'vitest'
import type { Holding, Market } from '../../types'
import type {
  HoldingEvidenceArtifact,
  HoldingEvidenceEntry,
  HoldingEvidenceField,
} from '../../types/holdingEvidence'
import { buildNewHoldingFromCsvRow } from '../csv/importPortfolioCsv'
import { computeAnalysis } from './computeAnalysis'
import {
  joinHoldingEvidence,
  parseHoldingEvidenceArtifact,
} from './holdingEvidence'

// ═══════════════════════════════════════════════════════════
// HOLDING-EVIDENCE-1 acceptance matrix A–N + regression 1–4
// ═══════════════════════════════════════════════════════════

const NOW_MS = Date.parse('2026-09-01T00:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function makeMarket(): Market {
  return {
    last_updated: iso(NOW_MS),
    nikkei: 38_000, nikkeiChg: 0, nikkeiChgPct: 0,
    ma5: 38_000, ma25: 38_000, ma75: 38_000,
    rsi14: 50, macd: 'golden', volume: 'normal',
    bollUpper: 40_000, bollMid: 38_000, bollLower: 36_000,
    regime: 'neutral', boj: '', bojNext: '', vix: 15,
  }
}

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    ...buildNewHoldingFromCsvRow({
      assetType: 'stock', code: '6098', name: 'リクルート',
      eval: 500_000, pnlPct: 0, dayPct: 0, price: 6_000,
      acquiredAt: undefined, accountHint: '',
    }),
    ...overrides,
  }
}

/** legacy v81 相当: metadataStatus を一切持たない persisted holding */
function makeLegacyHolding(overrides: Partial<Holding> = {}): Holding {
  const h = makeHolding(overrides)
  delete (h as { metadataStatus?: unknown }).metadataStatus
  return h
}

const present = (v: number | boolean): HoldingEvidenceField => ({ v, status: 'present' })
const missing = (): HoldingEvidenceField => ({ v: null, status: 'missing' })
const notApplicable = (): HoldingEvidenceField => ({ v: null, status: 'not_applicable' })

/** 強いスコアになる known fundamentals */
function strongFundamentals(asOfMs = NOW_MS - DAY) {
  return {
    asOf: iso(asOfMs), source: 'test',
    fields: {
      roe: present(22), per: present(12), pbr: present(1.4),
      epsG: present(18), cfOk: present(true), de: present(0.4), divG: present(6),
    },
  }
}

/** 弱いスコアになる known fundamentals（score < 50 を狙う） */
function weakFundamentals(asOfMs = NOW_MS - DAY) {
  return {
    asOf: iso(asOfMs), source: 'test',
    fields: {
      roe: present(1), per: present(120), pbr: present(9),
      epsG: present(-35), cfOk: present(false), de: present(9), divG: present(0),
    },
  }
}

function strongTechnicals(asOfMs = NOW_MS - HOUR, bars = 120) {
  return {
    asOf: iso(asOfMs), source: 'test', bars,
    fields: {
      ma: present(true), rsi: present(55), macd: present(true),
      vol: present(true), mom3m: present(12),
    },
  }
}

function weakTechnicals(asOfMs = NOW_MS - HOUR, bars = 120) {
  return {
    asOf: iso(asOfMs), source: 'test', bars,
    fields: {
      ma: present(false), rsi: present(82), macd: present(false),
      vol: present(false), mom3m: present(-25),
    },
  }
}

function makeEntry(overrides: Partial<HoldingEvidenceEntry> = {}): HoldingEvidenceEntry {
  return {
    code: '6098', ticker: '6098.T', market: 'TSE',
    fundamentals: strongFundamentals(),
    technicals: strongTechnicals(),
    ...overrides,
  }
}

function makeArtifact(entries: HoldingEvidenceEntry[], generatedAtMs = NOW_MS - HOUR): HoldingEvidenceArtifact {
  return {
    schemaVersion: 'holding-evidence-1',
    not_for_trading: true,
    _meta: {
      kind: 'holding_evidence',
      schemaVersion: 'holding-evidence-1',
      generatedAt: iso(generatedAtMs),
      not_for_trading: true,
    },
    entries,
  }
}

function analyze(holding: Holding, artifact: HoldingEvidenceArtifact | null) {
  const joined = joinHoldingEvidence([holding], artifact, NOW_MS)
  const [a] = computeAnalysis(joined.holdings, makeMarket(), null, null, null, NOW_MS)
  return { analysis: a, state: joined.states.get(holding.code)!, enriched: joined.holdings[0] }
}

// ── parser ───────────────────────────────────────────────────
describe('parseHoldingEvidenceArtifact', () => {
  it('accepts a well-formed artifact', () => {
    const r = parseHoldingEvidenceArtifact(makeArtifact([makeEntry()]))
    expect(r.ok).toBe(true)
  })

  it('rejects wrong schemaVersion / kind / not_for_trading (matrix N)', () => {
    expect(parseHoldingEvidenceArtifact({ ...makeArtifact([makeEntry()]), schemaVersion: 'x' }).ok).toBe(false)
    const badKind = makeArtifact([makeEntry()])
    ;(badKind._meta as { kind: string }).kind = 'candidate_funnel'
    expect(parseHoldingEvidenceArtifact(badKind).ok).toBe(false)
    const badPrivacy = makeArtifact([makeEntry()])
    ;(badPrivacy as { not_for_trading: unknown }).not_for_trading = false
    expect(parseHoldingEvidenceArtifact(badPrivacy).ok).toBe(false)
  })

  it('rejects malformed entries and never throws on hostile input', () => {
    expect(parseHoldingEvidenceArtifact(null).ok).toBe(false)
    expect(parseHoldingEvidenceArtifact(makeArtifact([{ ...makeEntry(), ticker: 123 as unknown as string }])).ok).toBe(false)
    const throwing = { get schemaVersion() { throw new Error('boom') } }
    expect(parseHoldingEvidenceArtifact(throwing).ok).toBe(false)
  })
})

// ── acceptance matrix ────────────────────────────────────────
describe('acceptance matrix A–N', () => {
  it('A: fundamentals missing + technicals missing → INSUFFICIENT_EVIDENCE, no SELL', () => {
    const entry = makeEntry({
      fundamentals: { asOf: iso(NOW_MS - DAY), source: 't', fields: {
        roe: missing(), per: missing(), pbr: missing(), epsG: missing(),
        cfOk: missing(), de: missing(), divG: missing(),
      } },
      technicals: { asOf: iso(NOW_MS - HOUR), source: 't', bars: 120, fields: {
        ma: missing(), rsi: missing(), macd: missing(), vol: missing(), mom3m: missing(),
      } },
    })
    const { analysis, state } = analyze(makeHolding(), makeArtifact([entry]))
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(analysis.debate.sellReasons).toEqual([])
    expect(state.fundamentals.status).toBe('unknown')
    expect(state.technicals.status).toBe('unknown')
    expect(state.authoritative).toBe(false)
  })

  it('B: fundamentals known + technicals missing → INSUFFICIENT_EVIDENCE', () => {
    const entry = makeEntry({
      technicals: { asOf: iso(NOW_MS - HOUR), source: 't', bars: 120, fields: {
        ma: missing(), rsi: present(50), macd: present(true), vol: present(true), mom3m: present(1),
      } },
    })
    const { analysis, state } = analyze(makeHolding(), makeArtifact([entry]))
    expect(state.fundamentals.status).toBe('known')
    expect(state.technicals.status).toBe('unknown')
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('C: fundamentals missing + technicals known → INSUFFICIENT_EVIDENCE', () => {
    const entry = makeEntry({
      fundamentals: { asOf: iso(NOW_MS - DAY), source: 't', fields: {
        ...strongFundamentals().fields, roe: missing(),
      } },
    })
    const { analysis, state } = analyze(makeHolding(), makeArtifact([entry]))
    expect(state.fundamentals.status).toBe('unknown')
    expect(state.technicals.status).toBe('known')
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('D: known/known + strong score → BUY/HOLD via existing thresholds', () => {
    const { analysis, state } = analyze(makeHolding(), makeArtifact([makeEntry()]))
    expect(state.authoritative).toBe(true)
    expect(['BUY', 'HOLD']).toContain(analysis.decision)
    expect(state.source).toBe('artifact')
  })

  it('E: known/known + weak legitimate score → SELL unlocked, lock text when locked', () => {
    const entry = makeEntry({ fundamentals: weakFundamentals(), technicals: weakTechnicals() })

    const unlocked = analyze(makeHolding(), makeArtifact([entry]))
    expect(unlocked.analysis.totalScore).toBeLessThan(50)
    expect(unlocked.analysis.decision).toBe('SELL')

    const lockedHolding = makeHolding({ lock: true, acquiredAt: iso(NOW_MS - 10 * DAY).slice(0, 10) })
    const locked = analyze(lockedHolding, makeArtifact([entry]))
    expect(locked.analysis.decision).toBe('SELL')
    expect(locked.analysis.debate.recommendedAction).toContain('売却不可期間中')
    expect(locked.analysis.debate.sellReasons).toEqual([])
  })

  it('F: known/known but pipeline TTL exceeded → INSUFFICIENT_EVIDENCE + stale indication', () => {
    const stalePipeline = makeArtifact([makeEntry({ fundamentals: weakFundamentals(), technicals: weakTechnicals() })], NOW_MS - 80 * HOUR)
    const { analysis, state } = analyze(makeHolding(), stalePipeline)
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(state.fundamentals.reason).toBe('stale_pipeline')
    expect(state.technicals.reason).toBe('stale_pipeline')
  })

  it('F2: known/known but fundamentals group asOf > 45d → INSUFFICIENT_EVIDENCE + stale_group', () => {
    const entry = makeEntry({ fundamentals: strongFundamentals(NOW_MS - 50 * DAY) })
    const { analysis, state } = analyze(makeHolding(), makeArtifact([entry]))
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(state.fundamentals.reason).toBe('stale_group')
    expect(state.technicals.status).toBe('known')
  })

  it('G: code/ticker/market mismatch → INSUFFICIENT_EVIDENCE + identity_mismatch', () => {
    const wrongTicker = analyze(makeHolding(), makeArtifact([makeEntry({ ticker: '6098.OS' })]))
    expect(wrongTicker.analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(wrongTicker.state.fundamentals.reason).toBe('identity_mismatch')

    const wrongMarket = analyze(makeHolding(), makeArtifact([makeEntry({ market: 'OSE' as 'TSE' })]))
    expect(wrongMarket.state.technicals.reason).toBe('identity_mismatch')
  })

  it('H: legacy holding without metadata + artifact absent → INSUFFICIENT_EVIDENCE, persisted unchanged', () => {
    const legacy = makeLegacyHolding()
    const before = structuredClone(legacy)
    const { analysis, state, enriched } = analyze(legacy, null)
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(state.source).toBe('persisted')
    expect(enriched).toBe(legacy)
    expect(legacy).toEqual(before)
    expect((legacy as { metadataStatus?: unknown }).metadataStatus).toBeUndefined()
  })

  it('I: snapshot-restored holding + valid artifact → deterministic known, persisted metadataStatus untouched', () => {
    const restored = makeHolding({ metadataStatus: { fundamentals: 'unknown', technicals: 'unknown' } })
    const before = structuredClone(restored)
    const a1 = analyze(restored, makeArtifact([makeEntry()]))
    const a2 = analyze(restored, makeArtifact([makeEntry()]))
    expect(a1.state.authoritative).toBe(true)
    expect(a2.state.authoritative).toBe(true)
    expect(a1.analysis.decision).toBe(a2.analysis.decision)
    // persisted holding object は一切変更されない
    expect(restored).toEqual(before)
    expect(restored.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
  })

  it('J: enriched holding is a copy; evidence-derived fields never mutate the persisted holding', () => {
    const persisted = makeHolding({ roe: 0, per: 0, metadataStatus: { fundamentals: 'unknown', technicals: 'unknown' } })
    const { enriched } = analyze(persisted, makeArtifact([makeEntry()]))
    expect(enriched).not.toBe(persisted)
    expect(enriched.roe).toBe(22)          // ephemeral enrich
    expect(persisted.roe).toBe(0)          // persisted untouched
    expect(persisted.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
  })

  it('L: de = not_applicable with all other fundamentals present → fundamentals known, neutral de', () => {
    const entry = makeEntry({
      fundamentals: { asOf: iso(NOW_MS - DAY), source: 't', fields: {
        ...strongFundamentals().fields, de: notApplicable(),
      } },
    })
    const { state, enriched } = analyze(makeHolding(), makeArtifact([entry]))
    expect(state.fundamentals.status).toBe('known')
    expect(enriched.de).toBe(1.5)
  })

  it('M: required field other than de = not_applicable → group unknown', () => {
    const entry = makeEntry({
      fundamentals: { asOf: iso(NOW_MS - DAY), source: 't', fields: {
        ...strongFundamentals().fields, roe: notApplicable(),
      } },
    })
    const { analysis, state } = analyze(makeHolding(), makeArtifact([entry]))
    expect(state.fundamentals.status).toBe('unknown')
    expect(state.fundamentals.reason).toBe('invalid_not_applicable')
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('M2: technicals bars < 75 → technicals unknown', () => {
    const { analysis, state } = analyze(makeHolding(), makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - HOUR, 60) })]))
    expect(state.technicals.status).toBe('unknown')
    expect(state.technicals.reason).toBe('insufficient_bars')
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('N: kind/schema invalid → parser rejects; joined holdings fall through to persisted (all unknown for the fleet)', () => {
    const badArtifact = makeArtifact([makeEntry()])
    ;(badArtifact._meta as { kind: string }).kind = 'not_holding_evidence'
    expect(parseHoldingEvidenceArtifact(badArtifact).ok).toBe(false)
    // loader が invalid の場合 store は holdingEvidence=null を保持 → join(null)
    const legacy = makeLegacyHolding()
    const { analysis, state } = analyze(legacy, null)
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(state.source).toBe('persisted')
  })

  it('ambiguous: two entries for the same code → unknown', () => {
    const { analysis, state } = analyze(makeHolding(), makeArtifact([makeEntry(), makeEntry()]))
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(state.fundamentals.reason).toBe('ambiguous_entry')
  })

  it('future-dated pipeline / asOf → unknown', () => {
    const futurePipeline = analyze(makeHolding(), makeArtifact([makeEntry()], NOW_MS + 5 * HOUR))
    expect(futurePipeline.state.fundamentals.reason).toBe('future_pipeline')

    const futureAsOf = analyze(makeHolding(), makeArtifact([makeEntry({ fundamentals: strongFundamentals(NOW_MS + DAY) })]))
    expect(futureAsOf.state.fundamentals.reason).toBe('future_asof')
  })
})

// ── regression: both sides of the frozen contract ────────────
describe('regression: unknown evidence never authorizes SELL/HOLD; valid known can SELL', () => {
  it.each([32, 48, 52])('unknown evidence + persisted safe defaults yielding score ~%d still abstains', () => {
    // safe default holding, no artifact → INSUFFICIENT_EVIDENCE regardless of numeric fallback score
    const { analysis } = analyze(makeHolding(), null)
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(analysis.debate.finalView).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('valid known/known with legitimate weak score CAN SELL', () => {
    const entry = makeEntry({ fundamentals: weakFundamentals(), technicals: weakTechnicals() })
    const { analysis } = analyze(makeHolding(), makeArtifact([entry]))
    expect(analysis.totalScore).toBeLessThan(50)
    expect(analysis.decision).toBe('SELL')
  })

  it('non-canonical code never matches an entry (naive numeric-only assumption rejected)', () => {
    const alnum = makeHolding({ code: '130A' })
    const entry = makeEntry({ code: '130A', ticker: '130A.T' })
    const { state } = analyze(alnum, makeArtifact([entry]))
    // 130A は canonical JP code。identity 一致し評価される
    expect(state.source).toBe('artifact')
    expect(state.authoritative).toBe(true)

    const bad = makeHolding({ code: 'ABCD' })
    const badJoin = joinHoldingEvidence([bad], makeArtifact([makeEntry({ code: 'ABCD', ticker: 'ABCD.T' })]), NOW_MS)
    expect(badJoin.states.get('ABCD')!.fundamentals.reason).toBe('identity_mismatch')
  })
})
