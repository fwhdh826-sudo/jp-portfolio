import { beforeEach, describe, expect, it } from 'vitest'
import type { Holding } from '../types'
import type { HoldingEvidenceArtifact, HoldingEvidenceEntry } from '../types/holdingEvidence'
import { buildNewHoldingFromCsvRow } from '../domain/csv/importPortfolioCsv'
import { buildPortfolioAnalysisFingerprint, runFullAnalysis, useAppStore } from './useAppStore'
import { serializePortfolioSnapshotExport } from '../utils/portfolioSnapshotTransfer'

// ═══════════════════════════════════════════════════════════
// HOLDING-EVIDENCE-1: runFullAnalysis 統合 — ephemeral join / fail-closed /
// 非永続 / snapshot 不変 / SELL 陽性対照
// ═══════════════════════════════════════════════════════════

const NOW = new Date().toISOString()
const NOW_MS = Date.parse(NOW)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

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

const present = (v: number | boolean) => ({ v, status: 'present' as const })

function entry(kind: 'strong' | 'weak'): HoldingEvidenceEntry {
  const weak = kind === 'weak'
  return {
    code: '6098', ticker: '6098.T', market: 'TSE',
    fundamentals: {
      asOf: iso(NOW_MS - DAY), source: 'test',
      fields: {
        roe: present(weak ? 1 : 22), per: present(weak ? 120 : 12), pbr: present(weak ? 9 : 1.4),
        epsG: present(weak ? -35 : 18), cfOk: present(!weak), de: present(weak ? 9 : 0.4), divG: present(weak ? 0 : 6),
      },
    },
    technicals: {
      asOf: iso(NOW_MS - HOUR), source: 'test', bars: 120,
      fields: {
        ma: present(!weak), rsi: present(weak ? 82 : 55), macd: present(!weak),
        vol: present(!weak), mom3m: present(weak ? -25 : 12),
      },
    },
  }
}

function artifact(entries: HoldingEvidenceEntry[], generatedAtMs = NOW_MS - HOUR): HoldingEvidenceArtifact {
  return {
    schemaVersion: 'holding-evidence-1',
    not_for_trading: true,
    _meta: { kind: 'holding_evidence', schemaVersion: 'holding-evidence-1', generatedAt: iso(generatedAtMs), not_for_trading: true },
    entries,
  }
}

function stateWith(holdings: Holding[], holdingEvidence: HoldingEvidenceArtifact | null) {
  const base = useAppStore.getState()
  return {
    ...base,
    holdings,
    holdingEvidence,
    system: {
      ...base.system,
      csvLastImportedAt: NOW,
      dataSourceStatus: { ...base.system.dataSourceStatus, market: 'loaded' as const },
      dataTimestamps: { ...base.system.dataTimestamps!, market: NOW },
    },
  }
}

describe('runFullAnalysis + holding_evidence', () => {
  beforeEach(() => {
    useAppStore.setState({ holdingEvidence: null })
  })

  it('artifact 不在 → INSUFFICIENT_EVIDENCE（fail-closed analytically）', () => {
    const result = runFullAnalysis(stateWith([makeHolding()], null), { nowMs: NOW_MS })
    const a = result.analysis.find(x => x.code === '6098')!
    expect(a.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(a.evidence).toMatchObject({ source: 'persisted', authoritative: false })
  })

  it('valid known/known artifact → decision は evidence 由来、evidence view が付く', () => {
    const result = runFullAnalysis(stateWith([makeHolding()], artifact([entry('strong')])), { nowMs: NOW_MS })
    const a = result.analysis.find(x => x.code === '6098')!
    expect(['BUY', 'HOLD']).toContain(a.decision)
    expect(a.evidence).toMatchObject({
      fundamentals: 'known', technicals: 'known', source: 'artifact', authoritative: true,
    })
  })

  it('SELL 陽性対照: valid known/known + legitimate weak score + unlocked → SELL', () => {
    const result = runFullAnalysis(stateWith([makeHolding()], artifact([entry('weak')])), { nowMs: NOW_MS })
    const a = result.analysis.find(x => x.code === '6098')!
    expect(a.totalScore).toBeLessThan(50)
    expect(a.decision).toBe('SELL')
  })

  it('J: persisted Holding は evidence-derived known / raw evidence を取得しない', () => {
    const persisted = makeHolding({ roe: 0, per: 0 })
    const result = runFullAnalysis(stateWith([persisted], artifact([entry('strong')])), { nowMs: NOW_MS })
    const writtenBack = result.holdings.find(h => h.code === '6098')!
    // 書き戻しは score/decision/ev のみ
    expect(writtenBack.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
    expect(writtenBack.roe).toBe(0)
    expect(writtenBack.per).toBe(0)
    // 入力 holding オブジェクトも不変
    expect(persisted.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
    expect(persisted.roe).toBe(0)
  })

  it('K: snapshot export は evidence フィールドを含まず metadataStatus は persisted 値のまま', () => {
    const result = runFullAnalysis(stateWith([makeHolding()], artifact([entry('strong')])), { nowMs: NOW_MS })
    const json = serializePortfolioSnapshotExport({
      holdings: result.holdings,
      trust: [],
      portfolioPolicy: null,
      cashAssumptions: null,
      csvImportedAt: NOW,
      csvImportProvenance: null,
    })
    const parsed = JSON.parse(json) as { holdings: Array<Record<string, unknown>> }
    const h = parsed.holdings[0]
    expect(h.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
    expect(h).not.toHaveProperty('roe')
    expect(h).not.toHaveProperty('evidence')
    expect(h).not.toHaveProperty('decision')
  })

  it('I: 決定論的 — 同一 artifact で 2 回実行しても同じ decision、persisted は不変', () => {
    const restored = makeHolding({ metadataStatus: { fundamentals: 'unknown', technicals: 'unknown' } })
    const s = stateWith([restored], artifact([entry('weak')]))
    const r1 = runFullAnalysis(s, { nowMs: NOW_MS })
    const r2 = runFullAnalysis(s, { nowMs: NOW_MS })
    expect(r1.analysis[0].decision).toBe(r2.analysis[0].decision)
    expect(restored.metadataStatus).toEqual({ fundamentals: 'unknown', technicals: 'unknown' })
  })

  it('fingerprint は holdingEvidence の変化で変わる', () => {
    const base = stateWith([makeHolding()], null)
    const withArtifact = { ...base, holdingEvidence: artifact([entry('strong')]) }
    expect(buildPortfolioAnalysisFingerprint(base))
      .not.toBe(buildPortfolioAnalysisFingerprint(withArtifact))
  })

  it('does not throw on a stale-pipeline artifact and abstains', () => {
    const stale = artifact([entry('weak')], NOW_MS - 100 * HOUR)
    const result = runFullAnalysis(stateWith([makeHolding()], stale), { nowMs: NOW_MS })
    const a = result.analysis.find(x => x.code === '6098')!
    expect(a.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(a.evidence?.fundamentalsReason).toBe('stale_pipeline')
  })
})
