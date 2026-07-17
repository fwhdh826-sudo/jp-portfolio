// @ts-expect-error Test-only Node oracle; production tsconfig intentionally omits Node typings.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CsvImportProvenance } from '../types'
import {
  computeCanonicalPortfolioGenerationIdentity,
  computeSnapshotGenerationIdentity,
  serializeSnapshotGeneration,
  type SnapshotGenerationInput,
} from './snapshotGenerationIdentity'

const authoritative: CsvImportProvenance = {
  importedAt: '2026-07-15T10:00:00+09:00',
  sourceAsOf: '2026-07-15T09:00:00+09:00',
  sourceAsOfKind: 'csv_explicit',
  sourceAsOfConfidence: 'authoritative',
  semanticIdentity: `sha256:${'a'.repeat(64)}`,
  contentFingerprint: 'fnv1a32:12345678',
  sourceFileName: '資産📈.csv',
  fileLastModified: '2026-07-15T09:30:00+09:00',
}

function envelope(overrides: Partial<SnapshotGenerationInput> = {}): SnapshotGenerationInput {
  return {
    holdings: [],
    trust: [],
    portfolioPolicy: null,
    cashAssumptions: null,
    csvImportedAt: null,
    csvImportProvenance: null,
    ...overrides,
  }
}

function nodeOracle(input: SnapshotGenerationInput): string {
  return `sha256:${createHash('sha256').update(serializeSnapshotGeneration(input), 'utf8').digest('hex')}`
}

describe('T9-A004-R2-F1 snapshot generation identity', () => {
  it.each([
    ['empty', envelope()],
    ['stock-only Japanese/emoji', envelope({ holdings: [{ code: '7203', name: 'トヨタ 🚗', eval: 1, pnlPct: -0 }] })],
    ['trust-only', envelope({ trust: [{ id: 'fund-1', eval: 2, pnlPct: 3, account: 'NISA積立' }] })],
    ['mixed authoritative', envelope({
      holdings: [{ code: 'A', name: '株式', eval: 1, pnlPct: 2 }, { code: 'B', name: '📊', eval: 3, pnlPct: 4 }],
      trust: [{ id: 'T', eval: 5, pnlPct: 6, dayPct: 7, account: '特定' }],
      portfolioPolicy: { jpStockMaxRatio: 0.12 },
      cashAssumptions: { cashDeposits: 8, standbyFunds: 9, manualOverrideEnabled: true, manualUpdatedAt: authoritative.importedAt },
      csvImportedAt: authoritative.importedAt,
      csvImportProvenance: authoritative,
    })],
    ['long multi-block', envelope({
      holdings: Array.from({ length: 40 }, (_, index) => ({
        code: `CODE-${index.toString().padStart(2, '0')}`,
        name: `長い銘柄名-${index}-📈-${'あ'.repeat(20)}`,
        eval: index * 1000,
        pnlPct: index / 10,
      })),
    })],
  ])('%s matches independent Node SHA-256 oracle', (_label, input) => {
    expect(computeSnapshotGenerationIdentity(input)).toBe(nodeOracle(input))
  })

  it('stock and trust row reversal preserves identity and duplicate multiplicity', () => {
    const input = envelope({
      holdings: [
        { code: '2', name: '二', eval: 2, pnlPct: 2 },
        { code: '1', name: '一', eval: 1, pnlPct: 1 },
        { code: '1', name: '一', eval: 1, pnlPct: 1 },
      ],
      trust: [{ id: 'b', eval: 2, pnlPct: 2 }, { id: 'a', eval: 1, pnlPct: 1 }],
    })
    const reversed = envelope({ holdings: [...input.holdings].reverse(), trust: [...input.trust].reverse() })
    expect(computeSnapshotGenerationIdentity(reversed)).toBe(computeSnapshotGenerationIdentity(input))
    expect(computeSnapshotGenerationIdentity(envelope({ holdings: input.holdings.slice(1) })))
      .not.toBe(computeSnapshotGenerationIdentity(input))
  })

  it('null/authoritative provenance and every one-field generation change produce different identities', () => {
    const base = envelope({ csvImportedAt: authoritative.importedAt, csvImportProvenance: authoritative })
    expect(computeSnapshotGenerationIdentity(envelope())).not.toBe(computeSnapshotGenerationIdentity(base))
    expect(computeSnapshotGenerationIdentity({ ...base, holdings: [{ code: 'X', name: 'X', eval: 1, pnlPct: 0 }] }))
      .not.toBe(computeSnapshotGenerationIdentity(base))
    expect(computeSnapshotGenerationIdentity({
      ...base,
      csvImportProvenance: { ...authoritative, sourceFileName: 'other.csv' },
    })).not.toBe(computeSnapshotGenerationIdentity(base))
  })

  it('equivalent timestamp offsets normalize independently of host TZ', () => {
    const utc = envelope({
      csvImportedAt: '2026-07-15T01:00:00.000Z',
      csvImportProvenance: {
        ...authoritative,
        importedAt: '2026-07-15T01:00:00.000Z',
        sourceAsOf: '2026-07-15T00:00:00.000Z',
        fileLastModified: '2026-07-15T00:30:00.000Z',
      },
    })
    const jst = envelope({ csvImportedAt: authoritative.importedAt, csvImportProvenance: authoritative })
    expect(computeSnapshotGenerationIdentity(jst)).toBe(computeSnapshotGenerationIdentity(utc))
  })
})

describe('T9-A004-R3-FIX-A canonical generation identity', () => {
  const fullGeneration = {
    holdings: [
      { code: 'B', name: 'B', eval: 2, pnlPct: 2 },
      { code: 'A', name: 'A', eval: 1, pnlPct: 1 },
    ],
    trust: [],
    learning: null,
    portfolioPolicy: { jpStockMaxRatio: 0.1 },
    cashAssumptions: {
      cashDeposits: 0,
      standbyFunds: 0,
      manualOverrideEnabled: false,
      manualUpdatedAt: null,
    },
    csvImportedAt: null,
    csvImportProvenance: null,
    syncSummary: null,
    trustShortSnapshot: { date: '2026-07-17', total: 0, evalById: {} },
    origin: 'snapshot' as const,
    snapshotTransferIdentity: `sha256:${'a'.repeat(64)}`,
  } as any

  it('is locale-independent for row order and binds learning/trust-short/transfer metadata', () => {
    const baseline = computeCanonicalPortfolioGenerationIdentity(fullGeneration)
    expect(baseline).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(computeCanonicalPortfolioGenerationIdentity({
      ...fullGeneration,
      holdings: [...fullGeneration.holdings].reverse(),
    })).toBe(baseline)
    expect(computeCanonicalPortfolioGenerationIdentity({
      ...fullGeneration,
      learning: { marker: 'changed' },
    })).not.toBe(baseline)
    expect(computeCanonicalPortfolioGenerationIdentity({
      ...fullGeneration,
      trustShortSnapshot: { ...fullGeneration.trustShortSnapshot, total: 1 },
    })).not.toBe(baseline)
    expect(computeCanonicalPortfolioGenerationIdentity({
      ...fullGeneration,
      snapshotTransferIdentity: `sha256:${'b'.repeat(64)}`,
    })).not.toBe(baseline)
  })
})
