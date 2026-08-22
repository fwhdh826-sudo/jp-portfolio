import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CandidateFunnelArtifact } from '../types'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import {
  buildPortfolioAnalysisFingerprint,
  createAppStoreInstanceForTest,
} from './useAppStore'
import {
  createPortfolioGenerationLockAdapter,
  PORTFOLIO_GENERATION_LOCK_NAME,
} from './portfolioGenerationLock'
import { FakeLockManager } from './testing/fakeLockManager'

type FunnelResponse = 'loaded' | 'unavailable' | 'invalid'

const NOW_MS = Date.parse('2026-07-26T08:00:00.000Z')
const storage: Record<string, string> = {}
let funnelResponse: FunnelResponse = 'loaded'
let currentArtifact: CandidateFunnelArtifact

const localStorageMock = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value },
  removeItem: (key: string) => { delete storage[key] },
}

function validArtifact(): CandidateFunnelArtifact {
  return structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
}

function installFetchRouter(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (!url.includes('candidate_funnel.json')) {
      return { ok: false, status: 404, json: () => Promise.resolve({}) }
    }
    if (funnelResponse === 'unavailable') {
      return { ok: false, status: 404, json: () => Promise.resolve({}) }
    }
    if (funnelResponse === 'invalid') {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ...currentArtifact, schemaVersion: 'invalid-version' }),
      }
    }
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(structuredClone(currentArtifact)),
    }
  }))
}

function createInstance(manager: FakeLockManager) {
  return createAppStoreInstanceForTest({
    portfolioGenerationLock: createPortfolioGenerationLockAdapter({
      lockManager: manager,
      timeoutMs: 60_000,
    }),
  })
}

async function grant<T>(manager: FakeLockManager, promise: Promise<T>): Promise<T> {
  expect(manager.grantNext(PORTFOLIO_GENERATION_LOCK_NAME)).toBe(true)
  return promise
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.stubGlobal('localStorage', localStorageMock)
  Object.keys(storage).forEach(key => delete storage[key])
  funnelResponse = 'loaded'
  currentArtifact = validArtifact()
  installFetchRouter()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('P5-B005-B3-B candidate funnel store wiring', () => {
  it('starts with candidateFunnel=null and no dummy candidates', () => {
    const state = createInstance(new FakeLockManager()).store.getState()
    expect(state.candidateFunnel).toBeNull()
    expect(state.system.dataSourceStatus.candidateFunnel).toBe('unavailable')
    expect(state.system.dataTimestamps?.candidateFunnel).toBeNull()
  })

  it('initialize atomically stores a valid artifact with loaded status and generatedAt timestamp', async () => {
    const manager = new FakeLockManager()
    const instance = createInstance(manager)
    const snapshots: ReturnType<typeof instance.store.getState>[] = []
    instance.store.subscribe(state => { snapshots.push(state) })

    const result = await grant(manager, instance.store.getState().initialize())

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].candidateFunnel).toEqual(currentArtifact)
    expect(snapshots[0].system.dataSourceStatus.candidateFunnel).toBe('loaded')
    expect(snapshots[0].system.dataTimestamps?.candidateFunnel)
      .toBe(currentArtifact._meta.generatedAt)
    // F-P0-2: candidate_funnel.json以外は全てfetch mockで404のため、他ソースはfallback。
    // candidateFunnelのみloadedなので集計上はpartial（全滅ではないのでsuccessでもない）。
    expect(snapshots[0].system.status).toBe('partial')
  })

  it('refresh atomically stores a valid artifact without increasing the one-publication contract', async () => {
    const manager = new FakeLockManager()
    const instance = createInstance(manager)
    funnelResponse = 'unavailable'
    await grant(manager, instance.store.getState().initialize())
    funnelResponse = 'loaded'
    let notifications = 0
    const unsubscribe = instance.store.subscribe(() => { notifications += 1 })

    const result = await grant(manager, instance.store.getState().refreshAllData())
    unsubscribe()

    expect(result).toMatchObject({ ok: true, code: 'SUCCESS' })
    expect(notifications).toBe(1)
    expect(instance.store.getState().candidateFunnel).toEqual(currentArtifact)
    expect(instance.store.getState().system.dataSourceStatus.candidateFunnel).toBe('loaded')
    expect(instance.store.getState().system.dataTimestamps?.candidateFunnel)
      .toBe(currentArtifact._meta.generatedAt)
  })

  it.each([
    ['unavailable', 'unavailable'],
    ['invalid', 'invalid'],
  ] as const)('initialize fail-closes %s to null/status/timestamp null', async (response, expectedStatus) => {
    const manager = new FakeLockManager()
    const instance = createInstance(manager)
    funnelResponse = response

    await grant(manager, instance.store.getState().initialize())

    const state = instance.store.getState()
    expect(state.candidateFunnel).toBeNull()
    expect(state.system.dataSourceStatus.candidateFunnel).toBe(expectedStatus)
    expect(state.system.dataTimestamps?.candidateFunnel).toBeNull()
  })

  it.each([
    ['unavailable', 'unavailable'],
    ['invalid', 'invalid'],
  ] as const)('refresh %s clears a previously loaded artifact', async (response, expectedStatus) => {
    const manager = new FakeLockManager()
    const instance = createInstance(manager)
    await grant(manager, instance.store.getState().initialize())
    expect(instance.store.getState().candidateFunnel).not.toBeNull()

    funnelResponse = response
    const snapshots: ReturnType<typeof instance.store.getState>[] = []
    const unsubscribe = instance.store.subscribe(state => { snapshots.push(state) })
    await grant(manager, instance.store.getState().refreshAllData())
    unsubscribe()

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0].candidateFunnel).toBeNull()
    expect(snapshots[0].system.dataSourceStatus.candidateFunnel).toBe(expectedStatus)
    expect(snapshots[0].system.dataTimestamps?.candidateFunnel).toBeNull()
  })

  it('candidateFunnel differences do not change the analysis fingerprint', () => {
    const state = createInstance(new FakeLockManager()).store.getState()
    const first = validArtifact()
    const second = validArtifact()
    second.candidates[0].name = 'fingerprintから隔離された変更'

    expect(buildPortfolioAnalysisFingerprint({ ...state, candidateFunnel: first }))
      .toBe(buildPortfolioAnalysisFingerprint({ ...state, candidateFunnel: second }))
  })

  it('candidate funnel storage does not persist the artifact to localStorage', async () => {
    const manager = new FakeLockManager()
    const instance = createInstance(manager)

    await grant(manager, instance.store.getState().initialize())

    const persisted = Object.values(storage).join('\n')
    expect(persisted).not.toContain('candidateFunnel')
    expect(persisted).not.toContain('"kind":"candidate_funnel"')
  })

  it('changing only candidate funnel content leaves officialDecision unchanged', async () => {
    const manager = new FakeLockManager()
    const instance = createInstance(manager)
    await grant(manager, instance.store.getState().initialize())
    const before = instance.store.getState().officialDecision

    currentArtifact = validArtifact()
    currentArtifact.candidates[0].name = 'officialDecisionから隔離された変更'
    await grant(manager, instance.store.getState().refreshAllData())

    expect(instance.store.getState().officialDecision).toEqual(before)
  })
})
