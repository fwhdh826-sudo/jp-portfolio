// @ts-expect-error - this repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  CashAssumptions,
  CsvImportProvenance,
  Holding,
  PortfolioPolicy,
  Trust,
} from '../types'
import type {
  CsvImportGenerationRestoreResult,
  CsvImportPersistencePayload,
} from '../store/persist'
import { buildPortfolioFitSnapshotInput } from './portfolioFitSnapshotAuthority'

type CommittedGeneration = Extract<CsvImportGenerationRestoreResult, { status: 'committed' }>

const HOLDING = {
  code: '1002',
  name: 'canonical holding',
  eval: 125_000,
  sector: '銀行業',
  acquiredAt: '2026-01-15',
} as Holding

const TRUST = {
  id: 'trust-1',
  name: 'canonical trust',
  eval: 80_000,
} as Trust

const POLICY: PortfolioPolicy = { jpStockMaxRatio: 0.15 }
const CASH: CashAssumptions = {
  cashDeposits: 400_000,
  standbyFunds: 100_000,
  manualOverrideEnabled: true,
  manualUpdatedAt: '2026-07-26T07:00:00.000Z',
}
const PROVENANCE: CsvImportProvenance = {
  sourceAsOf: '2026-07-26T07:00:00.000Z',
  sourceAsOfKind: 'csv_explicit',
  sourceAsOfConfidence: 'authoritative',
  contentFingerprint: 'canonical-fingerprint',
  sourceFileName: 'portfolio.csv',
  fileLastModified: '2026-07-26T07:00:00.000Z',
  importedAt: '2026-07-26T07:05:00.000Z',
}

function payload(
  overrides: Partial<CsvImportPersistencePayload> = {},
): CsvImportPersistencePayload {
  return {
    holdings: [HOLDING],
    trust: [TRUST],
    learning: null,
    csvImportedAt: '2026-07-26T07:05:00.000Z',
    syncSummary: null,
    trustShortSnapshot: {} as CsvImportPersistencePayload['trustShortSnapshot'],
    provenance: PROVENANCE,
    portfolioPolicy: POLICY,
    cashAssumptions: CASH,
    origin: 'csv',
    snapshotGenerationIdentity: 'sha256:canonical',
    snapshotTransferIdentity: null,
    ...overrides,
  }
}

function committed(
  payloadOverrides: Partial<CsvImportPersistencePayload> = {},
  generationOverrides: Partial<Omit<CommittedGeneration, 'status' | 'payload'>> = {},
): CommittedGeneration {
  return {
    status: 'committed',
    schemaVersion: 'csv-import-generation-5',
    generationId: 'generation-authority-123',
    savedAt: 1_785_049_500_000,
    payload: payload(payloadOverrides),
    ...generationOverrides,
  }
}

describe('P5-B005-C-B2 canonical snapshot authority adapter', () => {
  it('maps committed nonempty canonical holdings to present_nonempty', () => {
    expect(buildPortfolioFitSnapshotInput(committed(), 'current')).toMatchObject({
      existence: 'present_nonempty',
    })
  })

  it('maps committed empty canonical holdings to present_empty', () => {
    expect(buildPortfolioFitSnapshotInput(
      committed({ holdings: [] }),
      'current',
    )).toMatchObject({ existence: 'present_empty', holdings: [] })
  })

  it('maps none to null and never manufactures an empty generation', () => {
    expect(buildPortfolioFitSnapshotInput({ status: 'none' }, 'current')).toBeNull()
  })

  it('maps invalid to the exact invalid snapshot contract', () => {
    expect(buildPortfolioFitSnapshotInput({ status: 'invalid' }, 'current')).toEqual({
      existence: 'invalid',
      error: 'CANONICAL_ENVELOPE_INVALID',
    })
  })

  it.each([
    'csv-import-generation-1',
    'csv-import-generation-2',
    'csv-import-generation-3',
    'csv-import-generation-4',
    'csv-import-generation-5',
  ] as const)('preserves schemaVersion %s exactly', schemaVersion => {
    expect(buildPortfolioFitSnapshotInput(
      committed({}, { schemaVersion }),
      'current',
    )).toMatchObject({ schemaVersion })
  })

  it('preserves generationId and savedAt exactly', () => {
    const generation = committed({}, {
      generationId: 'generation-exact-id',
      savedAt: 42,
    })
    expect(buildPortfolioFitSnapshotInput(generation, 'current')).toMatchObject({
      generationId: 'generation-exact-id',
      savedAt: 42,
    })
  })

  it('uses the canonical payload holdings and trust arrays by identity', () => {
    const generation = committed()
    const result = buildPortfolioFitSnapshotInput(generation, 'current')
    expect(result?.existence).toBe('present_nonempty')
    if (result?.existence !== 'present_nonempty') throw new Error('expected committed snapshot')
    expect(result.holdings).toBe(generation.payload.holdings)
    expect(result.trusts).toBe(generation.payload.trust)
  })

  it('uses canonical policy, cash, and provenance by identity', () => {
    const generation = committed()
    const result = buildPortfolioFitSnapshotInput(generation, 'current')
    if (result?.existence !== 'present_nonempty') throw new Error('expected committed snapshot')
    expect(result.portfolioPolicy).toBe(generation.payload.portfolioPolicy)
    expect(result.cashAssumptions).toBe(generation.payload.cashAssumptions)
    expect(result.provenance).toBe(generation.payload.provenance)
  })

  it('preserves the canonical payload csvImportedAt exactly', () => {
    expect(buildPortfolioFitSnapshotInput(
      committed({ csvImportedAt: '2026-06-01T02:03:04.000Z' }),
      'current',
    )).toMatchObject({ csvImportedAt: '2026-06-01T02:03:04.000Z' })
  })

  it('does not alias legacy importedAt to canonical csvImportedAt', () => {
    const generation = committed({
      csvImportedAt: undefined,
      importedAt: '2020-01-01T00:00:00.000Z',
    })
    expect(buildPortfolioFitSnapshotInput(generation, 'current')).toMatchObject({
      csvImportedAt: null,
    })
  })

  it('maps optional legacy authority fields to null instead of ambient defaults', () => {
    expect(buildPortfolioFitSnapshotInput(committed({
      portfolioPolicy: undefined,
      cashAssumptions: undefined,
      provenance: undefined,
      csvImportedAt: undefined,
    }), 'current')).toMatchObject({
      portfolioPolicy: null,
      cashAssumptions: null,
      provenance: null,
      csvImportedAt: null,
    })
  })

  it.each(['current', 'stale'] as const)('propagates cross-tab state %s without changing payload', crossTabState => {
    const generation = committed()
    const before = structuredClone(generation)
    expect(buildPortfolioFitSnapshotInput(generation, crossTabState)).toMatchObject({
      crossTabState,
    })
    expect(generation).toEqual(before)
  })

  it('is deterministic for the same restore result and injected cross-tab state', () => {
    const generation = committed()
    const first = buildPortfolioFitSnapshotInput(generation, 'current')
    const second = buildPortfolioFitSnapshotInput(generation, 'current')
    expect(second).toEqual(first)
  })

  it('contains no clock, storage read, network, or fallback authority seam', () => {
    const source = readFileSync(
      new URL('./portfolioFitSnapshotAuthority.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(/Date\.now|new Date|Math\.random/)
    expect(source).not.toMatch(/restoreCsvImportGeneration\s*\(/)
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/)
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/)
    expect(source).not.toMatch(/state\s*\.\s*holdings|v81_portfolio|v81_trust/)
  })
})
