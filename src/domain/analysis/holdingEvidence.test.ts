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
  // 以前は it.each([32, 48, 52]) だったが、その数値パラメータは callback で
  // 未使用の飾りで、32/48/52 という score を実際に instantiate も assert も
  // していなかった（監査指摘 §7）。computeAnalysis の内部 total score は多数の
  // fallback フィールド由来で決め打ちできないため、契約そのもの —「evidence が
  // unknown なら fallback score が SELL/HOLD 域でも decision は
  // INSUFFICIENT_EVIDENCE」— を各 evidence 失敗シナリオで実際に検証する。
  it.each([
    { label: 'artifact absent', build: () => null },
    {
      label: 'stale pipeline',
      build: () => makeArtifact(
        [makeEntry({ fundamentals: weakFundamentals(), technicals: weakTechnicals() })],
        NOW_MS - 80 * HOUR,
      ),
    },
    { label: 'identity mismatch', build: () => makeArtifact([makeEntry({ ticker: '6098.OS' })]) },
    { label: 'ambiguous entry', build: () => makeArtifact([makeEntry(), makeEntry()]) },
  ])('persisted known/known + $label → INSUFFICIENT_EVIDENCE, never SELL', ({ build }) => {
    const persistedKnown = makeHolding({ metadataStatus: { fundamentals: 'known', technicals: 'known' } })
    const { analysis, enriched } = analyze(persistedKnown, build())
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(analysis.debate.sellReasons).toEqual([])
    // effective（ephemeral）metadata は unknown へ倒れる。persisted は不変。
    expect(enriched.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
    expect(persistedKnown.metadataStatus).toEqual({ fundamentals: 'known', technicals: 'known' })
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

// ═══════════════════════════════════════════════════════════
// R1 fail-closed blocker matrix（監査指摘 §8）
// persisted metadataStatus = known/known が現在の evidence 契約 unknown を
// 上書きして runtime authority として生存し、SELL を emit することが無いのを固定する。
// ═══════════════════════════════════════════════════════════
describe('R1: persisted known/known must never leak through an evidence failure', () => {
  const persistedKnown = () =>
    makeHolding({ metadataStatus: { fundamentals: 'known', technicals: 'known' } })

  function expectAbstain(
    holding: Holding,
    artifact: HoldingEvidenceArtifact | null,
    expected: { f: 'known' | 'unknown'; t: 'known' | 'unknown' },
  ) {
    const before = structuredClone(holding)
    const { analysis, enriched, state } = analyze(holding, artifact)
    expect(analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(analysis.debate.sellReasons).toEqual([])
    expect(enriched.metadataStatus).toEqual({ fundamentals: expected.f, technicals: expected.t })
    // persisted holding オブジェクトは一切 mutate されない
    expect(holding).toEqual(before)
    return { state, enriched }
  }

  it('R1-A: known/known + artifact absent → effective unknown/unknown, INSUFFICIENT_EVIDENCE', () => {
    const { state } = expectAbstain(persistedKnown(), null, { f: 'unknown', t: 'unknown' })
    expect(state.source).toBe('persisted')
    expect(state.fundamentals.reason).toBe('no_artifact')
  })

  it('R1-A2: known/known + parser-invalid artifact (store holds null) → INSUFFICIENT_EVIDENCE', () => {
    const bad = makeArtifact([makeEntry()])
    ;(bad._meta as { kind: string }).kind = 'not_holding_evidence'
    expect(parseHoldingEvidenceArtifact(bad).ok).toBe(false)
    // loader が invalid → store は holdingEvidence=null → join(null)
    expectAbstain(persistedKnown(), null, { f: 'unknown', t: 'unknown' })
  })

  it('R1-B: known/known + stale pipeline → INSUFFICIENT_EVIDENCE', () => {
    const stale = makeArtifact([makeEntry()], NOW_MS - 80 * HOUR)
    const { state } = expectAbstain(persistedKnown(), stale, { f: 'unknown', t: 'unknown' })
    expect(state.fundamentals.reason).toBe('stale_pipeline')
    expect(state.technicals.reason).toBe('stale_pipeline')
  })

  it('R1-C: known/known + future pipeline → INSUFFICIENT_EVIDENCE', () => {
    const future = makeArtifact([makeEntry()], NOW_MS + 5 * HOUR)
    const { state } = expectAbstain(persistedKnown(), future, { f: 'unknown', t: 'unknown' })
    expect(state.fundamentals.reason).toBe('future_pipeline')
  })

  it('R1-D: known/known + identity mismatch → INSUFFICIENT_EVIDENCE', () => {
    const mismatch = makeArtifact([makeEntry({ ticker: '6098.OS' })])
    const { state } = expectAbstain(persistedKnown(), mismatch, { f: 'unknown', t: 'unknown' })
    expect(state.fundamentals.reason).toBe('identity_mismatch')
  })

  it('R1-E: known/known + ambiguous duplicate entry → INSUFFICIENT_EVIDENCE', () => {
    const dup = makeArtifact([makeEntry(), makeEntry()])
    const { state } = expectAbstain(persistedKnown(), dup, { f: 'unknown', t: 'unknown' })
    expect(state.fundamentals.reason).toBe('ambiguous_entry')
  })

  it('R1-F: known/known + stale fundamentals group → effective fundamentals unknown, technicals known', () => {
    const entry = makeEntry({ fundamentals: strongFundamentals(NOW_MS - 50 * DAY) })
    const { state } = expectAbstain(persistedKnown(), makeArtifact([entry]), { f: 'unknown', t: 'known' })
    expect(state.fundamentals.reason).toBe('stale_group')
    expect(state.technicals.status).toBe('known')
  })

  it('R1-G: known/known + stale technicals group → effective technicals unknown, fundamentals known', () => {
    const entry = makeEntry({ technicals: strongTechnicals(NOW_MS - 10 * DAY) })
    const { state } = expectAbstain(persistedKnown(), makeArtifact([entry]), { f: 'known', t: 'unknown' })
    expect(state.technicals.reason).toBe('stale_group')
    expect(state.fundamentals.status).toBe('known')
  })

  it('R1-H (positive control): known/known + valid fresh weak evidence → SELL still works', () => {
    const persisted = persistedKnown()
    const before = structuredClone(persisted)
    const entry = makeEntry({ fundamentals: weakFundamentals(), technicals: weakTechnicals() })
    const { analysis, enriched, state } = analyze(persisted, makeArtifact([entry]))
    expect(state.authoritative).toBe(true)
    expect(analysis.totalScore).toBeLessThan(50)
    expect(analysis.decision).toBe('SELL')
    // evidence 由来の effective known は analysis 入力のみ。persisted は不変。
    expect(enriched.metadataStatus).toEqual({ fundamentals: 'known', technicals: 'known' })
    expect(persisted).toEqual(before)
  })
})

// ═══════════════════════════════════════════════════════════
// strict timestamp 検証（監査指摘 §P1-B / §9）
// ═══════════════════════════════════════════════════════════
describe('strict evidence timestamp validation', () => {
  const withGeneratedAt = (raw: string) => {
    const a = makeArtifact([makeEntry()])
    ;(a._meta as { generatedAt: string }).generatedAt = raw
    return a
  }
  const withFundamentalsAsOf = (raw: string) => {
    const entry = makeEntry()
    ;(entry.fundamentals as { asOf: string }).asOf = raw
    return makeArtifact([entry])
  }

  it.each([
    '2026-02-30T00:00:00.000Z',   // 不可能な暦日
    '2026-13-01T00:00:00.000Z',   // 不正な月
    '2026-03-02T00:00:00',         // timezone 無し
    '2026-03-02',                  // date-only
    '2026-03-02T12:00Z',           // 秒欠落
    'not-a-timestamp',
    '',
  ])('parser rejects generatedAt = %j', (raw) => {
    expect(parseHoldingEvidenceArtifact(withGeneratedAt(raw)).ok).toBe(false)
  })

  it.each([
    '2026-02-30T00:00:00.000Z',
    '2026-03-02T00:00:00',
    '2026-03-02',
  ])('parser rejects fundamentals.asOf = %j', (raw) => {
    expect(parseHoldingEvidenceArtifact(withFundamentalsAsOf(raw)).ok).toBe(false)
  })

  it.each([
    '2026-09-01T00:00:00.000Z',
    '2026-09-01T09:00:00+09:00',
    '2026-09-01T00:00:00Z',
  ])('parser accepts canonical timezone-qualified timestamp %j', (raw) => {
    expect(parseHoldingEvidenceArtifact(withGeneratedAt(raw)).ok).toBe(true)
  })

  it('a non-canonical asOf that slips past parsing still resolves to stale_group in the join', () => {
    // join を直接叩く（parser を経由しない hostile artifact）
    const entry = makeEntry()
    ;(entry.fundamentals as { asOf: string }).asOf = '2026-03-02T00:00:00'
    const { states } = joinHoldingEvidence([makeHolding()], makeArtifact([entry]), NOW_MS)
    expect(states.get('6098')!.fundamentals.reason).toBe('stale_group')
  })
})

// ═══════════════════════════════════════════════════════════
// TTL / bars 境界（監査指摘 §10）— 明示 nowMs、Date.now() 非依存
// ═══════════════════════════════════════════════════════════
describe('freshness / bars boundaries', () => {
  const PIPELINE_TTL = 72 * HOUR
  const FUNDAMENTALS_TTL = 45 * DAY
  const TECHNICALS_TTL = 7 * DAY

  it('pipeline: exactly 72h → fresh; 72h + 1ms → stale', () => {
    const atLimit = analyze(makeHolding(), makeArtifact([makeEntry()], NOW_MS - PIPELINE_TTL))
    expect(atLimit.state.authoritative).toBe(true)
    const overLimit = analyze(makeHolding(), makeArtifact([makeEntry()], NOW_MS - PIPELINE_TTL - 1))
    expect(overLimit.analysis.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(overLimit.state.fundamentals.reason).toBe('stale_pipeline')
  })

  it('fundamentals asOf: exactly 45d → known; 45d + 1ms → stale_group', () => {
    const atLimit = analyze(makeHolding(), makeArtifact([makeEntry({ fundamentals: strongFundamentals(NOW_MS - FUNDAMENTALS_TTL) })]))
    expect(atLimit.state.fundamentals.status).toBe('known')
    const overLimit = analyze(makeHolding(), makeArtifact([makeEntry({ fundamentals: strongFundamentals(NOW_MS - FUNDAMENTALS_TTL - 1) })]))
    expect(overLimit.state.fundamentals.status).toBe('unknown')
    expect(overLimit.state.fundamentals.reason).toBe('stale_group')
  })

  it('technicals asOf: exactly 7d → known; 7d + 1ms → stale_group', () => {
    const atLimit = analyze(makeHolding(), makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - TECHNICALS_TTL) })]))
    expect(atLimit.state.technicals.status).toBe('known')
    const overLimit = analyze(makeHolding(), makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - TECHNICALS_TTL - 1) })]))
    expect(overLimit.state.technicals.status).toBe('unknown')
    expect(overLimit.state.technicals.reason).toBe('stale_group')
  })

  it('technicals bars: 75 → sufficient; 74 → insufficient_bars', () => {
    const ok = analyze(makeHolding(), makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - HOUR, 75) })]))
    expect(ok.state.technicals.status).toBe('known')
    const short = analyze(makeHolding(), makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - HOUR, 74) })]))
    expect(short.state.technicals.status).toBe('unknown')
    expect(short.state.technicals.reason).toBe('insufficient_bars')
  })

  it('parser rejects fractional / negative bars but the join owns the >=75 rule', () => {
    expect(parseHoldingEvidenceArtifact(makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - HOUR, 74.5) })])).ok).toBe(false)
    expect(parseHoldingEvidenceArtifact(makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - HOUR, -1) })])).ok).toBe(false)
    // 74（整数）は構造的には valid、join が insufficient と判定する
    expect(parseHoldingEvidenceArtifact(makeArtifact([makeEntry({ technicals: strongTechnicals(NOW_MS - HOUR, 74) })])).ok).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// parser hardening（監査指摘 §P2）
// ═══════════════════════════════════════════════════════════
describe('parser hardening: entry code / source', () => {
  it('rejects a non-canonical entry.code', () => {
    expect(parseHoldingEvidenceArtifact(makeArtifact([makeEntry({ code: '609', ticker: '609.T' })])).ok).toBe(false)
    expect(parseHoldingEvidenceArtifact(makeArtifact([makeEntry({ code: 'ABCD', ticker: 'ABCD.T' })])).ok).toBe(false)
    expect(parseHoldingEvidenceArtifact(makeArtifact([makeEntry({ code: '60980', ticker: '60980.T' })])).ok).toBe(false)
  })

  it('accepts a canonical alphanumeric entry.code (130A)', () => {
    expect(parseHoldingEvidenceArtifact(makeArtifact([makeEntry({ code: '130A', ticker: '130A.T' })])).ok).toBe(true)
  })

  it('rejects an empty fundamentals/technicals source', () => {
    const emptyF = makeEntry()
    ;(emptyF.fundamentals as { source: string }).source = ''
    expect(parseHoldingEvidenceArtifact(makeArtifact([emptyF])).ok).toBe(false)
    const emptyT = makeEntry()
    ;(emptyT.technicals as { source: string }).source = ''
    expect(parseHoldingEvidenceArtifact(makeArtifact([emptyT])).ok).toBe(false)
  })
})
