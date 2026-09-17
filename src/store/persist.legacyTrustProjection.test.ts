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
//
// R2 (safe property copy): an own enumerable `__proto__` key (and the adjacent `constructor` /
// `prototype` names) must survive projection as ordinary own data keys so the exact-key
// validator can reject them. R1 copied keys with `target[key] = value`, which routed
// `__proto__` through the inherited Object.prototype setter and silently dropped it (fail-open).
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

/**
 * Adds an OWN enumerable data property without going through an object literal or dynamic
 * assignment (both of which give `__proto__` prototype-setting semantics). The result is a
 * legacy row (csv_name present) so projection is forced to build a copy.
 */
function legacyTrustWithOwnKey(key: string, value: unknown, id = 'fund-a'): Trust {
  const row: Record<string, unknown> = { ...legacyTrust(id, 300_000, ['csv_name']) }
  Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true })
  expect(Object.prototype.hasOwnProperty.call(row, key)).toBe(true)
  return row as unknown as Trust
}

const hasOwn = (value: unknown, key: string) => Object.prototype.hasOwnProperty.call(value, key)

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

describe('R2: safe property copy (own __proto__ / constructor / prototype keys survive projection)', () => {
  const POLLUTION = { polluted: true }

  it('own enumerable __proto__ is retained as an OWN DATA key (not routed through the setter)', () => {
    const row = legacyTrustWithOwnKey('__proto__', POLLUTION)
    const sourceKeys = Object.keys(row)
    const projected = projectLegacyTrustRow(row) as unknown as Record<string, unknown>

    expect(projected).not.toBe(row)
    expect(hasOwn(projected, 'csv_name')).toBe(false)
    expect(hasOwn(projected, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(projected, '__proto__')).toMatchObject({
      value: POLLUTION,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    // Value is preserved by reference and not coerced.
    expect(Object.getOwnPropertyDescriptor(projected, '__proto__')!.value).toBe(POLLUTION)
    // Every other key is retained exactly, in source order.
    expect(Object.keys(projected)).toEqual(sourceKeys.filter(key => key !== 'csv_name'))
    // Serialized bytes carry the unknown key so the exact-key validator (and any later reader) sees it.
    const expected: Record<string, unknown> = { ...cleanTrust() }
    Object.defineProperty(expected, '__proto__', { value: POLLUTION, enumerable: true, writable: true, configurable: true })
    expect(JSON.stringify(projected)).toBe(JSON.stringify(expected))
    expect(JSON.stringify(projected)).toContain('"__proto__":{"polluted":true}')
  })

  it('does not pollute the projected prototype nor the global Object.prototype', () => {
    const row = legacyTrustWithOwnKey('__proto__', POLLUTION)
    const projected = projectLegacyTrustRow(row) as unknown as Record<string, unknown>

    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    // Nothing reachable through inheritance.
    expect((projected as { polluted?: unknown }).polluted).toBeUndefined()
    expect('polluted' in ({} as Record<string, unknown>)).toBe(false)
    expect(hasOwn(Object.prototype, 'polluted')).toBe(false)
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    // A normal usable object: canonical values still read as own data.
    expect(projected.id).toBe('fund-a')
    expect(projected.eval).toBe(300_000)
  })

  it.each([
    ['constructor', 'evil-constructor'],
    ['prototype', { evil: true }],
  ])('adjacent magic name %s is retained as an ordinary own data key', (key, value) => {
    const row = legacyTrustWithOwnKey(key, value)
    const projected = projectLegacyTrustRow(row) as unknown as Record<string, unknown>
    expect(hasOwn(projected, 'csv_name')).toBe(false)
    expect(hasOwn(projected, key)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(projected, key)!.value).toBe(value)
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype)
    // `constructor` as a data key must shadow, not replace, the inherited one for other objects.
    expect(({}).constructor).toBe(Object)
  })

  it('source object is never mutated and projection stays idempotent for magic keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const row = legacyTrustWithOwnKey(key, POLLUTION)
      const before = Object.getOwnPropertyDescriptors(row)
      const once = projectLegacyTrustRow(row)
      const twice = projectLegacyTrustRow(once)
      expect(Object.getOwnPropertyDescriptors(row)).toEqual(before)
      expect(hasOwn(row, 'csv_name')).toBe(true)
      expect(hasOwn(row, key)).toBe(true)
      // No legacy key remains after the first pass, so the second pass is reference-preserving.
      expect(twice).toBe(once)
      expect(Object.getOwnPropertyDescriptors(twice)).toEqual(Object.getOwnPropertyDescriptors(once))
    }
  })

  it('a legacy row whose __proto__ value is null still copies it as an own data key', () => {
    const row = legacyTrustWithOwnKey('__proto__', null)
    const projected = projectLegacyTrustRow(row) as unknown as Record<string, unknown>
    expect(hasOwn(projected, '__proto__')).toBe(true)
    expect(Object.getOwnPropertyDescriptor(projected, '__proto__')!.value).toBeNull()
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype)
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

  describe('R2 unknown-key contract matrix', () => {
    it.each([
      ['A: legacy + unexpected_unknown_field', 'unexpected_unknown_field', 1],
      ['B: legacy + own enumerable __proto__', '__proto__', { polluted: true }],
      ['C: legacy + constructor', 'constructor', 'evil'],
      ['D: legacy + prototype', 'prototype', { evil: true }],
    ])('%s → retained by projection, rejected by the canonical validator, nothing committed', (_label, key, value) => {
      const row = legacyTrustWithOwnKey(key, value)
      const projected = projectLegacyTrustRow(row)
      expect(hasOwn(projected, key)).toBe(true)
      expect(hasOwn(projected, 'csv_name')).toBe(false)
      expectSchemaValidationFailure(payloadWith([row]))
      expect(restoreCsvImportGeneration().status).not.toBe('committed')
      // The source row handed to the writer is untouched.
      expect(hasOwn(row, key)).toBe(true)
      expect(hasOwn(row, 'csv_name')).toBe(true)
    })

    it('B (writer): __proto__ rejection leaves Object.prototype untouched', () => {
      expectSchemaValidationFailure(payloadWith([legacyTrustWithOwnKey('__proto__', { polluted: true })]))
      expect(hasOwn(Object.prototype, 'polluted')).toBe(false)
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    })

    it.each([
      ['E: legacy + csv_name only', ['csv_name'] as const],
      ['F: legacy + csv_account only', ['csv_account'] as const],
      ['G: legacy + csv_name + csv_account', ['csv_name', 'csv_account'] as const],
    ])('%s → known keys removed, canonical generation commits', (_label, keys) => {
      persistV5(payloadWith([legacyTrust('fund-a', 300_000, [...keys])]))
      const restored = restoreCsvImportGeneration()
      if (restored.status !== 'committed') throw new Error('expected committed generation')
      expect(restored.payload.trust).toEqual([cleanTrust('fund-a', 300_000)])
      for (const key of keys) expect(storage[CSV_IMPORT_GENERATION_KEY]).not.toContain(key)
    })
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

  it.each([
    ['__proto__', { polluted: true }],
    ['constructor', 'evil'],
    ['prototype', { evil: true }],
  ])('R2: the read boundary cannot hide an own %s key either', (key, value) => {
    persistTrust([legacyTrustWithOwnKey(key, value, 'a')])
    expect(storage.v81_trust).toContain(`"${key}":`)
    const restored = restoreTrust() as unknown as Array<Record<string, unknown>>
    expect(hasOwn(restored[0], 'csv_name')).toBe(false)
    expect(hasOwn(restored[0], key)).toBe(true)
    expect(Object.getOwnPropertyDescriptor(restored[0], key)!.value).toEqual(value)
    expect(Object.getPrototypeOf(restored[0])).toBe(Object.prototype)
    expect((restored[0] as { polluted?: unknown }).polluted).toBeUndefined()
    expect(hasOwn(Object.prototype, 'polluted')).toBe(false)
    // The projected read row still fails the canonical writer exactly like a direct write.
    expectSchemaValidationFailure(payloadWith(restored as unknown as Trust[]))
  })
})
