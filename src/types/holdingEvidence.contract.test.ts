// ═══════════════════════════════════════════════════════════
// HOLDING-EVIDENCE-2A: cross-language schema parity。
//
// tests/fixtures/holding_evidence_parity_v1.json は Python の pure builder
// （data/update_holding_evidence.py）が生成する canonical fixture であり、
// Python の contract validator（data/holding_evidence_contract.py）も受理する。
// このテストは同じ fixture を TS 側の parseHoldingEvidenceArtifact /
// joinHoldingEvidence が同じ意味で解釈することを証明する。
//
// 重複した独立 fixture semantics は作らない（§29）。
// ═══════════════════════════════════════════════════════════
import { describe, expect, it } from 'vitest'
// @ts-expect-error - no @types/node in this project
import { readFileSync } from 'node:fs'
// @ts-expect-error - no @types/node in this project
import { resolve, dirname } from 'node:path'
// @ts-expect-error - no @types/node in this project
import { fileURLToPath } from 'node:url'
import type { Holding } from './index'
import { buildNewHoldingFromCsvRow } from '../domain/csv/importPortfolioCsv'
import {
  joinHoldingEvidence,
  parseHoldingEvidenceArtifact,
} from '../domain/analysis/holdingEvidence'
import type { HoldingEvidenceArtifact } from './holdingEvidence'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests/fixtures/holding_evidence_parity_v1.json')

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// fixture の内部時刻は 2026-09-01T00:00:00Z を参照点に固定されている
// （generatedAt = -1h, fundamentals.asOf = -1d, technicals.asOf = -1d 06:30Z）。
const NOW_MS = Date.parse('2026-09-01T00:00:00.000Z')

function holding(code: string): Holding {
  return buildNewHoldingFromCsvRow({
    assetType: 'stock',
    code,
    name: code,
    eval: 500_000,
    pnlPct: 0,
    dayPct: 0,
    price: 1_000,
    acquiredAt: undefined,
    accountHint: '',
  })
}

describe('HOLDING-EVIDENCE-2A cross-language parity', () => {
  it('parseHoldingEvidenceArtifact accepts the Python-generated fixture', () => {
    const parsed = parseHoldingEvidenceArtifact(loadFixture())
    expect(parsed.ok).toBe(true)
  })

  it('fixture has exactly the three documented entry shapes', () => {
    const parsed = parseHoldingEvidenceArtifact(loadFixture())
    if (!parsed.ok) throw new Error('fixture must parse')
    expect(parsed.data.entries.map((e) => e.code)).toEqual(['6098', '9697', '8306'])
    expect(parsed.data._meta.schemaVersion).toBe('holding-evidence-1')
    expect(parsed.data.not_for_trading).toBe(true)
  })

  it('normal eligible entry (A / 6098) joins to known/known authoritative', () => {
    const parsed = parseHoldingEvidenceArtifact(loadFixture())
    if (!parsed.ok) throw new Error('fixture must parse')
    const { states } = joinHoldingEvidence([holding('6098')], parsed.data, NOW_MS)
    const state = states.get('6098')!
    expect(state.fundamentals.status).toBe('known')
    expect(state.technicals.status).toBe('known')
    expect(state.fundamentals.reason).toBe('ok')
    expect(state.technicals.reason).toBe('ok')
    expect(state.source).toBe('artifact')
    expect(state.authoritative).toBe(true)
  })

  it('partial entry (B / 9697) → fundamentals partial_fields, technicals insufficient_bars', () => {
    const parsed = parseHoldingEvidenceArtifact(loadFixture())
    if (!parsed.ok) throw new Error('fixture must parse')
    const { states } = joinHoldingEvidence([holding('9697')], parsed.data, NOW_MS)
    const state = states.get('9697')!
    expect(state.fundamentals.status).toBe('unknown')
    expect(state.fundamentals.reason).toBe('partial_fields')
    expect(state.technicals.status).toBe('unknown')
    expect(state.technicals.reason).toBe('insufficient_bars')
    expect(state.authoritative).toBe(false)
  })

  it('de not_applicable entry (C / 8306) → fundamentals known, runtime neutral de 1.5', () => {
    const parsed = parseHoldingEvidenceArtifact(loadFixture())
    if (!parsed.ok) throw new Error('fixture must parse')
    const { holdings, states } = joinHoldingEvidence([holding('8306')], parsed.data, NOW_MS)
    const state = states.get('8306')!
    expect(state.fundamentals.status).toBe('known')
    expect(state.technicals.status).toBe('known')
    expect(state.authoritative).toBe(true)
    expect(holdings[0].de).toBe(1.5)
  })

  // ── cross-language negative cases（§29）────────────────────────────────
  it('rejects a non-canonical (6-digit microsecond) group timestamp', () => {
    const bad = clone(loadFixture()) as HoldingEvidenceArtifact
    bad.entries[0].fundamentals.asOf = '2026-08-31T00:00:00.123456Z'
    const parsed = parseHoldingEvidenceArtifact(bad)
    expect(parsed.ok).toBe(false)
  })

  it('rejects an invalid stock code', () => {
    const bad = clone(loadFixture()) as HoldingEvidenceArtifact
    bad.entries[0].code = '60980'
    expect(parseHoldingEvidenceArtifact(bad).ok).toBe(false)
  })

  it('rejects fractional technical bars', () => {
    const bad = clone(loadFixture()) as HoldingEvidenceArtifact
    ;(bad.entries[0].technicals as { bars: number }).bars = 74.5
    expect(parseHoldingEvidenceArtifact(bad).ok).toBe(false)
  })

  it('rejects an invalid not_applicable on a non-de field at parse or join', () => {
    const bad = clone(loadFixture()) as HoldingEvidenceArtifact
    bad.entries[0].fundamentals.fields.roe = { v: null, status: 'not_applicable' }
    const parsed = parseHoldingEvidenceArtifact(bad)
    // 構造 parser は field 形状のみ検証する。not_applicable の適用範囲は join が
    // fail-closed で拒否する（Python validator は parse 相当層で拒否する）。
    if (parsed.ok) {
      const { states } = joinHoldingEvidence([holding('6098')], parsed.data, NOW_MS)
      expect(states.get('6098')!.fundamentals.reason).toBe('invalid_not_applicable')
    } else {
      expect(parsed.ok).toBe(false)
    }
  })

  it('a missing-status field with a non-null value never yields known evidence', () => {
    const bad = clone(loadFixture()) as HoldingEvidenceArtifact
    bad.entries[0].fundamentals.fields.roe = { v: 12, status: 'missing' }
    const parsed = parseHoldingEvidenceArtifact(bad)
    if (!parsed.ok) throw new Error('field shape is still structurally valid')
    const { states } = joinHoldingEvidence([holding('6098')], parsed.data, NOW_MS)
    expect(states.get('6098')!.fundamentals.status).toBe('unknown')
    expect(states.get('6098')!.fundamentals.reason).toBe('partial_fields')
  })
})
