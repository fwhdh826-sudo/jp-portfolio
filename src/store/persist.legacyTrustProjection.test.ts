// E2E-A1 canonical trust legacy sanitization (R1).
//
// Real-world defect: legacy `v81_trust` rows carry historical matching metadata keys
// (`csv_name`, `csv_account`) that the legacy runtime path accepted but the canonical writer's
// exact-key `isTrust` validator rejects. Every supported canonical writer (CSV import, snapshot
// import, manual replacement) converges on `persistCsvImportTransaction`, so no canonical
// generation could be created from such a device state.
//
// These tests pin the compatibility contract using privacy-safe synthetic fixtures only:
//   T1  clean canonical trust           → accepted, same reference, byte-identical
//   T2  legacy + csv_name               → canonicalized and accepted
//   T3  legacy + csv_account            → canonicalized and accepted
//   T4  legacy + both known keys        → canonicalized and accepted
//   T5  unknown extra key               → still rejected (fail-closed)
//   T6  missing required field          → rejected
//   T7  invalid required field type     → rejected
//   T8  legacy multi-row trust set      → whole canonical payload validates
//   T11 repeated projection             → idempotent
//   T12 legacy source object            → never mutated in place
//   + legacy v81_trust read boundary    → projected on read, stored bytes untouched
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding, Trust } from '../types'
import { computeCanonicalPortfolioGenerationIdentityV2 } from '../utils/snapshotGenerationIdentity'
import {
  CSV_IMPORT_GENERATION_KEY,
  CSV_IMPORT_GENERATION_SCHEMA_V5,
  CsvImportPersistenceError,
  LEGACY_TRUST_COMPATIBILITY_KEYS,
  persistCsvImportTransaction,
  persistTrust,
  projectLegacyTrustRow,
  projectLegacyTrustRows,
  restoreCsvImportGeneration,
  restoreTrust,
  type CsvImportPersistencePayload,
} from './persist'

const IMPORTED_AT = '2026-07-15T00:00:00.000Z'

function holding(code = '1001', evalValue = 100_000): Holding {
  return {
    code,
    name: `holding-${code}`,
    eval: evalValue,
    pnlPct: 1,
    currentPrice: 100,
    mu: 0.08,
    sigma: 0.2,
    sigmaSource: 'static',
    beta: 1,
    sector: 'test',
    target: 0,
    alert: 0,
    lock: false,
    mitsu: false,
    ma: true,
    rsi: 50,
    macd: true,
    vol: false,
    mom3m: 0,
    roe: 10,
    per: 15,
    pbr: 1,
    epsG: 5,
    cfOk: true,
    de: 0.5,
    divG: 1,
    score: 50,
    decision: 'HOLD',
    ev: 0,
  }
}

function cleanTrust(id = 'fund-a', evalValue = 300_000): Trust {
  return {
    id,
    name: `trust-${id}`,
    abbr: id,
    account: '特定',
    policy: 'OVERSEAS_LONGTERM',
    eval: evalValue,
    pnlPct: 1.5,
    dayPct: -0.2,
    cost: 0.2,
    mu: 0.08,
    sigma: 0.15,
    score: 50,
    signal: 'HOLD',
    ev: 0,
    decision: 'HOLD',
  }
}

/** Synthetic legacy row: canonical fields plus the historical matching metadata. */
function legacyTrust(id = 'fund-a', evalValue = 300_000, keys: Array<'csv_name' | 'csv_account'> = ['csv_name', 'csv_account']): Trust {
  const row: Record<string, unknown> = { ...cleanTrust(id, evalValue) }
  if (keys.includes('csv_name')) row.csv_name = `legacy-name-${id}`
  if (keys.includes('csv_account')) row.csv_account = '特定'
  return row as unknown as Trust
}

function payloadWith(trust: Trust[]): CsvImportPersistencePayload {
  const evalById = Object.fromEntries(trust.map(row => [row.id, row.eval]))
  return {
    holdings: [holding()],
    trust,
    learning: null,
    csvImportedAt: IMPORTED_AT,
    provenance: null,
    syncSummary: {
      importedAt: IMPORTED_AT,
      stock: { updated: 1, added: 0, removed: 0 },
      trust: { updated: trust.length, reheld: 0, zeroed: 0, unknownFunds: [], ambiguousFundIds: [] },
    },
    trustShortSnapshot: {
      date: IMPORTED_AT.slice(0, 10),
      total: trust.reduce((sum, row) => sum + row.eval, 0),
      evalById,
    },
    portfolioPolicy: { jpStockMaxRatio: 0.12 },
    cashAssumptions: {
      source: 'MANUAL',
      grossCash: 1_250_000,
      safetyReserve: 0,
      pendingOrderCash: null,
      updatedAt: '2026-07-15T01:00:00.000Z',
    },
    origin: 'csv',
    snapshotTransferIdentity: null,
  }
}

function persistV5(payload: CsvImportPersistencePayload) {
  return persistCsvImportTransaction(payload, Date.parse(IMPORTED_AT), undefined, {
    schemaVersion: CSV_IMPORT_GENERATION_SCHEMA_V5,
  })
}

/**
 * Any pre-persist rejection is acceptable here: the exact-key validator or, for a malformed
 * numeric, the earlier fail-closed identity computation. Both leave nothing persisted.
 */
function expectSchemaValidationFailure(
  payload: CsvImportPersistencePayload,
  expectedDetail: RegExp = /canonical payload schema validation failed/,
): void {
  let thrown: unknown = null
  try {
    persistV5(payload)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CsvImportPersistenceError)
  expect((thrown as CsvImportPersistenceError).status).toBe('not_attempted')
  expect((thrown as Error).message).toMatch(expectedDetail)
  expect(storage[CSV_IMPORT_GENERATION_KEY]).toBeUndefined()
}

const storage: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

beforeEach(() => {
  vi.stubGlobal('localStorage', localStorageMock)
  Object.keys(storage).forEach(key => delete storage[key])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('projectLegacyTrustRow / projectLegacyTrustRows (pure conversion contract)', () => {
  it('declares exactly the two proven legacy-only keys', () => {
    expect([...LEGACY_TRUST_COMPATIBILITY_KEYS]).toEqual(['csv_name', 'csv_account'])
  })

  it('T1: a clean canonical row is returned as the same reference and stays byte-identical', () => {
    const row = cleanTrust()
    const before = JSON.stringify(row)
    const projected = projectLegacyTrustRow(row)
    expect(projected).toBe(row)
    expect(JSON.stringify(projected)).toBe(before)
    const rows = [cleanTrust('a'), cleanTrust('b')]
    expect(projectLegacyTrustRows(rows)).toBe(rows)
  })

  it.each([
    ['T2: csv_name only', ['csv_name'] as const],
    ['T3: csv_account only', ['csv_account'] as const],
    ['T4: both known keys', ['csv_name', 'csv_account'] as const],
  ])('%s → legacy keys removed, every canonical field preserved', (_label, keys) => {
    const row = legacyTrust('fund-a', 300_000, [...keys])
    const projected = projectLegacyTrustRow(row)
    expect(projected).not.toBe(row)
    expect(projected).not.toHaveProperty('csv_name')
    expect(projected).not.toHaveProperty('csv_account')
    expect(projected).toEqual(cleanTrust('fund-a', 300_000))
    // No key besides the legacy ones is dropped or invented.
    expect(Object.keys(projected).sort()).toEqual(Object.keys(cleanTrust()).sort())
  })

  it('preserves optional canonical fields such as notForTrading', () => {
    const row = { ...legacyTrust(), notForTrading: true } as Trust
    expect(projectLegacyTrustRow(row)).toEqual({ ...cleanTrust(), notForTrading: true })
  })

  it('T5: an unknown extra key is NOT stripped (fail-closed, left for the validator)', () => {
    const row = { ...cleanTrust(), mysteryKey: 1 } as unknown as Trust
    expect(projectLegacyTrustRow(row)).toBe(row)
    const mixed = { ...legacyTrust(), mysteryKey: 1 } as unknown as Trust
    const projected = projectLegacyTrustRow(mixed) as unknown as Record<string, unknown>
    expect(projected).not.toHaveProperty('csv_name')
    expect(projected).toHaveProperty('mysteryKey', 1)
  })

  it('T11: projection is idempotent', () => {
    const row = legacyTrust()
    const once = projectLegacyTrustRow(row)
    const twice = projectLegacyTrustRow(once)
    expect(twice).toBe(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
    const rows = [legacyTrust('a'), cleanTrust('b')]
    const onceRows = projectLegacyTrustRows(rows)
    expect(projectLegacyTrustRows(onceRows)).toBe(onceRows)
  })

  it('T12: the legacy source object and array are never mutated in place', () => {
    const row = legacyTrust()
    const rows = [row, cleanTrust('b')]
    const rowBefore = JSON.stringify(row)
    const rowsBefore = JSON.stringify(rows)
    const projectedRows = projectLegacyTrustRows(rows)
    expect(projectedRows).not.toBe(rows)
    expect(projectedRows[1]).toBe(rows[1])
    expect(JSON.stringify(row)).toBe(rowBefore)
    expect(JSON.stringify(rows)).toBe(rowsBefore)
    expect(row).toHaveProperty('csv_name')
    expect(row).toHaveProperty('csv_account')
  })
})

describe('canonical writer boundary (persistCsvImportTransaction, schema v5)', () => {
  it('T1: a clean canonical trust payload commits and persists the rows unchanged', () => {
    const trust = [cleanTrust('a'), cleanTrust('b', 100_000)]
    persistV5(payloadWith(trust))
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expect(restored.payload.trust).toEqual(trust)
  })

  it.each([
    ['T2', ['csv_name'] as const],
    ['T3', ['csv_account'] as const],
    ['T4', ['csv_name', 'csv_account'] as const],
  ])('%s: legacy trust rows are canonicalized, strictly validated, and committed', (_label, keys) => {
    const legacy = legacyTrust('fund-a', 300_000, [...keys])
    const source = JSON.stringify(legacy)
    persistV5(payloadWith([legacy]))
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expect(restored.schemaVersion).toBe(CSV_IMPORT_GENERATION_SCHEMA_V5)
    expect(restored.payload.trust).toEqual([cleanTrust('fund-a', 300_000)])
    // Canonical bytes never contain the legacy keys.
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain('csv_name')
    expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain('csv_account')
    // T12: the caller's legacy row is untouched.
    expect(JSON.stringify(legacy)).toBe(source)
  })

  it('T8: a legacy multi-row trust set produces one valid canonical payload whose identity binds the canonical rows', () => {
    const legacyRows = [legacyTrust('a', 100), legacyTrust('b', 200, ['csv_name']), cleanTrust('c', 300)]
    persistV5(payloadWith(legacyRows))
    const restored = restoreCsvImportGeneration()
    if (restored.status !== 'committed') throw new Error('expected committed generation')
    expect(restored.payload.trust).toEqual([cleanTrust('a', 100), cleanTrust('b', 200), cleanTrust('c', 300)])
    const { snapshotGenerationIdentity, ...identityPayload } = restored.payload
    expect(snapshotGenerationIdentity).toBe(computeCanonicalPortfolioGenerationIdentityV2({
      holdings: identityPayload.holdings,
      trust: identityPayload.trust,
      learning: identityPayload.learning,
      portfolioPolicy: identityPayload.portfolioPolicy!,
      cashAssumptions: identityPayload.cashAssumptions!,
      csvImportedAt: identityPayload.csvImportedAt ?? null,
      csvImportProvenance: identityPayload.provenance ?? null,
      syncSummary: identityPayload.syncSummary,
      trustShortSnapshot: identityPayload.trustShortSnapshot,
      origin: identityPayload.origin ?? null,
      snapshotTransferIdentity: identityPayload.snapshotTransferIdentity ?? null,
    }))
  })

  it('T11: re-committing the restored canonical rows is a no-op on row shape', () => {
    persistV5(payloadWith([legacyTrust()]))
    const first = restoreCsvImportGeneration()
    if (first.status !== 'committed') throw new Error('expected committed generation')
    persistV5(payloadWith(first.payload.trust))
    const second = restoreCsvImportGeneration()
    if (second.status !== 'committed') throw new Error('expected committed generation')
    expect(second.payload.trust).toEqual(first.payload.trust)
  })

  it('T5: an unknown unrecognized extra trust key still fails closed', () => {
    expectSchemaValidationFailure(payloadWith([{ ...cleanTrust(), mysteryKey: 1 } as unknown as Trust]))
    // Even when combined with the known legacy keys, the unknown key alone keeps the row invalid.
    expectSchemaValidationFailure(payloadWith([{ ...legacyTrust(), mysteryKey: 1 } as unknown as Trust]))
  })

  it('T6: a missing required canonical field still fails after legacy projection', () => {
    const { abbr: _abbr, ...withoutAbbr } = legacyTrust() as Trust & Record<string, unknown>
    expectSchemaValidationFailure(payloadWith([withoutAbbr as unknown as Trust]))
  })

  it('T7: an invalid required field type still fails after legacy projection', () => {
    // A string eval is caught by the fail-closed identity computation before the validator runs.
    expectSchemaValidationFailure(
      payloadWith([{ ...legacyTrust(), eval: '300000' } as unknown as Trust]),
      /non-finite number|canonical payload schema validation failed/,
    )
    expectSchemaValidationFailure(payloadWith([{ ...legacyTrust(), decision: 'MAYBE' } as unknown as Trust]))
    expectSchemaValidationFailure(payloadWith([{ ...legacyTrust(), policy: 'UNKNOWN_POLICY' } as unknown as Trust]))
  })

  it('malformed trust identity still fails after legacy projection', () => {
    expectSchemaValidationFailure(payloadWith([{ ...legacyTrust(), id: '' } as unknown as Trust]))
  })
})

describe('legacy v81_trust read boundary (restoreTrust)', () => {
  it('projects legacy rows on read without rewriting the stored legacy bytes', () => {
    const legacyRows = [legacyTrust('a', 100), legacyTrust('b', 200, ['csv_account'])]
    persistTrust(legacyRows)
    const rawBefore = storage.v81_trust
    expect(rawBefore).toContain('csv_name')

    const restored = restoreTrust()
    expect(restored).toEqual([cleanTrust('a', 100), cleanTrust('b', 200)])
    expect(storage.v81_trust).toBe(rawBefore)
    expect(Object.keys(storage)).toEqual(['v81_trust'])
  })

  it('T1 control: clean legacy rows restore exactly as before', () => {
    const rows = [cleanTrust('a'), cleanTrust('b', 100)]
    persistTrust(rows)
    expect(restoreTrust()).toEqual(rows)
  })

  it('does not strip unknown keys from legacy rows (fail-closed remains downstream)', () => {
    persistTrust([{ ...legacyTrust('a'), mysteryKey: 1 } as unknown as Trust])
    const restored = restoreTrust() as unknown as Array<Record<string, unknown>>
    expect(restored[0]).not.toHaveProperty('csv_name')
    expect(restored[0]).toHaveProperty('mysteryKey', 1)
  })
})
