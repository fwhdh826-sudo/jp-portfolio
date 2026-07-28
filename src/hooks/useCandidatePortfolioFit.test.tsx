// @ts-expect-error -- repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AppState,
  CashAssumptions,
  CsvImportProvenance,
  Holding,
  PortfolioPolicy,
} from '../types'
import type {
  CsvImportGenerationRestoreResult,
  CsvImportPersistencePayload,
} from '../store/persist'
import { buildValidCandidateFunnelArtifact } from '../services/candidateFunnelArtifact.fixtures'
import { useAppStore } from '../store/useAppStore'
import {
  evaluateCandidatePortfolioFitRuntime,
  useCandidatePortfolioFit,
  type CandidatePortfolioFitRuntimeDependencies,
  type CandidatePortfolioFitRuntimeSnapshot,
} from './useCandidatePortfolioFit'

type CommittedGeneration = Extract<CsvImportGenerationRestoreResult, { status: 'committed' }>

const POLICY: PortfolioPolicy = { jpStockMaxRatio: 0.15 }
const CASH: CashAssumptions = {
  cashDeposits: 500_000,
  standbyFunds: 100_000,
  manualOverrideEnabled: true,
  manualUpdatedAt: '2026-07-26T07:00:00.000Z',
}
const PROVENANCE: CsvImportProvenance = {
  sourceAsOf: '2026-07-26T07:00:00.000Z',
  sourceAsOfKind: 'csv_explicit',
  sourceAsOfConfidence: 'authoritative',
  contentFingerprint: 'candidate-fit-runtime',
  sourceFileName: 'portfolio.csv',
  fileLastModified: '2026-07-26T07:00:00.000Z',
  importedAt: '2026-07-26T07:05:00.000Z',
}

function holding(code: string): Holding {
  return {
    code,
    name: `canonical-${code}`,
    eval: 100_000,
    sector: '銀行業',
    acquiredAt: '2026-01-15',
  } as Holding
}

function committed(holdings: Holding[] = []): CommittedGeneration {
  const payload = {
    holdings,
    trust: [],
    learning: null,
    csvImportedAt: PROVENANCE.importedAt,
    syncSummary: null,
    trustShortSnapshot: {},
    provenance: PROVENANCE,
    portfolioPolicy: POLICY,
    cashAssumptions: CASH,
    origin: 'csv',
    snapshotGenerationIdentity: 'sha256:runtime',
    snapshotTransferIdentity: null,
  } as unknown as CsvImportPersistencePayload
  return {
    status: 'committed',
    schemaVersion: 'csv-import-generation-5',
    generationId: 'candidate-fit-runtime-generation',
    savedAt: 1_785_049_500_000,
    payload,
  }
}

function runtimeState(): AppState {
  const current = useAppStore.getState()
  const candidateFunnel = structuredClone(buildValidCandidateFunnelArtifact())
  candidateFunnel._meta.generatedAt = '2026-07-26T07:00:00.000Z'
  candidateFunnel._meta.sourceUpdatedAt = '2026-07-26T07:00:00.000Z'
  return {
    ...current,
    candidateFunnel,
    holdings: [holding('9999')],
    trust: [],
    portfolioPolicy: POLICY,
    cashAssumptions: CASH,
    system: {
      ...current.system,
      csvLastImportedAt: PROVENANCE.importedAt,
      csvImportProvenance: PROVENANCE,
      csvSyncSummary: null,
      crossTabInvalidation: undefined,
      dataSourceStatus: {
        ...current.system.dataSourceStatus,
        candidateFunnel: 'loaded',
      },
      dataTimestamps: {
        ...current.system.dataTimestamps!,
        candidateFunnel: candidateFunnel._meta.generatedAt,
      },
    },
  }
}

function dependencies(
  canonical: CsvImportGenerationRestoreResult = committed(),
  now = Date.parse('2026-07-26T08:00:00.000Z'),
): CandidatePortfolioFitRuntimeDependencies {
  return {
    now: () => now,
    restoreCanonicalGeneration: () => canonical,
  }
}

class TestNode {
  readonly attributes: Record<string, string> = {}
  readonly childNodes: TestNode[] = []
  readonly namespaceURI: string | null
  readonly style: Record<string, string> = {}
  readonly tagName: string | undefined
  ownerDocument: TestDocument
  parentNode: TestNode | null = null
  nodeValue: string | null = null

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    ownerDocument: TestDocument,
  ) {
    this.ownerDocument = ownerDocument
    this.tagName = nodeType === 1 ? nodeName : undefined
    this.namespaceURI = nodeType === 1 ? 'http://www.w3.org/1999/xhtml' : null
  }

  appendChild(child: TestNode) {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: TestNode, before: TestNode) {
    const index = this.childNodes.indexOf(before)
    if (index < 0) return this.appendChild(child)
    child.parentNode = this
    this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild(child: TestNode) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  addEventListener() {}
  removeEventListener() {}
  setAttribute(name: string, value: unknown) {
    this.attributes[name] = String(value)
  }
  removeAttribute(name: string) {
    delete this.attributes[name]
  }
  set textContent(value: string) {
    this.childNodes.length = 0
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value))
  }
  get textContent(): string {
    return this.childNodes.map(child => child.nodeValue ?? child.textContent).join('')
  }
  get firstChild() {
    return this.childNodes[0] ?? null
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
}

class TestDocument extends TestNode {
  readonly activeElement: TestNode
  readonly body: TestNode
  readonly documentElement: TestNode
  defaultView: unknown = null

  constructor() {
    super(9, '#document', null as unknown as TestDocument)
    this.ownerDocument = this
    this.documentElement = new TestNode(1, 'HTML', this)
    this.body = new TestNode(1, 'BODY', this)
    this.activeElement = this.body
  }

  createElement(name: string) {
    return new TestNode(1, name.toUpperCase(), this)
  }
  createElementNS(_namespaceURI: string, name: string) {
    return this.createElement(name)
  }
  createTextNode(value: string) {
    const node = new TestNode(3, '#text', this)
    node.nodeValue = value
    return node
  }
  createComment(value: string) {
    const node = new TestNode(8, '#comment', this)
    node.nodeValue = value
    return node
  }
  getElementById() {
    return null
  }
}

interface HookMount {
  root: Root
  snapshots: CandidatePortfolioFitRuntimeSnapshot[]
  rerender: (revision: number) => Promise<void>
  unmount: () => Promise<void>
}

async function mountHook(
  runtimeDependencies: CandidatePortfolioFitRuntimeDependencies,
): Promise<HookMount> {
  const testDocument = new TestDocument()
  class TestHtmlIFrameElement {}
  const testWindow = {
    document: testDocument,
    HTMLIFrameElement: TestHtmlIFrameElement,
    addEventListener() {},
    removeEventListener() {},
    getSelection() {
      return null
    },
  }
  testDocument.defaultView = testWindow
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: testWindow },
    document: { configurable: true, value: testDocument },
    navigator: { configurable: true, value: { userAgent: 'vitest' } },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  })

  const snapshots: CandidatePortfolioFitRuntimeSnapshot[] = []
  function Harness({ revision: _revision }: { revision: number }) {
    snapshots.push(useCandidatePortfolioFit(runtimeDependencies))
    return null
  }
  const root = createRoot(testDocument.createElement('div') as unknown as Element)
  const rerender = async (revision: number) => {
    await act(async () => {
      root.render(<Harness revision={revision} />)
    })
  }
  await rerender(0)
  return {
    root,
    snapshots,
    rerender,
    unmount: async () => {
      await act(async () => root.unmount())
      for (const name of [
        'window',
        'document',
        'navigator',
        'IS_REACT_ACT_ENVIRONMENT',
      ]) {
        Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

const originalState = useAppStore.getState()
let activeMount: HookMount | null = null

afterEach(async () => {
  if (activeMount !== null) {
    await activeMount.unmount()
    activeMount = null
  }
  useAppStore.setState(originalState, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('P5-B005-C-B3 frozen runtime bridge', () => {
  it('C-B3-T01 reads a committed generation once and returns ready/evaluated', () => {
    const restore = vi.fn(() => committed())
    const output = evaluateCandidatePortfolioFitRuntime(runtimeState(), {
      now: () => Date.parse('2026-07-26T08:00:00.000Z'),
      restoreCanonicalGeneration: restore,
    })
    expect(restore).toHaveBeenCalledTimes(1)
    expect(output.status).toBe('evaluated')
  })

  it('C-B3-T02 maps canonical none to unavailable without fabricating empty holdings', () => {
    const output = evaluateCandidatePortfolioFitRuntime(
      runtimeState(),
      dependencies({ status: 'none' }),
    )
    expect(output.status).toBe('unavailable')
    expect(output.degradationReasons).toContain('PORTFOLIO_SNAPSHOT_UNAVAILABLE')
  })

  it('C-B3-T03 maps canonical invalid to invalid without ambient fallback', () => {
    const output = evaluateCandidatePortfolioFitRuntime(
      runtimeState(),
      dependencies({ status: 'invalid' }),
    )
    expect(output.status).toBe('invalid')
    expect(output.records.every(item =>
      item.holdingRelationship === 'holding_match_unknown' &&
      item.portfolioFitStatus === 'invalid'
    )).toBe(true)
  })

  it('C-B3-T04 preserves a committed empty generation as present-empty evaluation', () => {
    const output = evaluateCandidatePortfolioFitRuntime(
      runtimeState(),
      dependencies(committed([])),
    )
    expect(output.status).toBe('evaluated')
    expect(output.records.every(item => item.holdingRelationship === 'new_to_portfolio'))
      .toBe(true)
  })

  it('C-B3-T05 invokes the injected clock once and uses its exact ISO evaluatedAt', () => {
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.123Z'))
    const output = evaluateCandidatePortfolioFitRuntime(runtimeState(), {
      now,
      restoreCanonicalGeneration: () => committed(),
    })
    expect(now).toHaveBeenCalledTimes(1)
    expect(output.evaluatedAt).toBe('2026-07-26T08:00:00.123Z')
  })

  it('C-B3-T06 does not rerun clock or restore on an unrelated rerender', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    const deps = { now, restoreCanonicalGeneration: restore }
    activeMount = await mountHook(deps)
    await activeMount.rerender(1)
    expect(now).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('C-B3-T07 performs exactly one new cycle for a relevant revision', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook({ now, restoreCanonicalGeneration: restore })
    await act(async () => {
      useAppStore.setState(state => ({
        candidateFunnel: structuredClone(state.candidateFunnel),
      }))
    })
    expect(now).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('C-B3-T08 uses the same evaluatedAt at the candidate freshness boundary and result', () => {
    const state = runtimeState()
    const generatedAt = state.candidateFunnel!._meta.generatedAt
    const boundary = Date.parse(generatedAt) + 49 * 60 * 60 * 1000
    const output = evaluateCandidatePortfolioFitRuntime(
      state,
      dependencies(committed(), boundary),
    )
    expect(output.evaluatedAt).toBe(new Date(boundary).toISOString())
    expect(output.degradationReasons).toContain('CANDIDATE_INPUT_STALE')
  })

  it('C-B3-T09 gives canonical holdings authority over conflicting ambient holdings', () => {
    const state = runtimeState()
    const actionable = state.candidateFunnel!.candidates.find(item => item.tier === 'actionable')!
    state.holdings = []
    const output = evaluateCandidatePortfolioFitRuntime(
      state,
      dependencies(committed([holding(actionable.code)])),
    )
    const projected = output.records.find(item => item.code === actionable.code)
    expect(projected?.holdingRelationship).toBe('already_held')
  })

  it('C-B3-T10 reevaluates cross-tab stale once and never promotes the prior result', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook({ now, restoreCanonicalGeneration: restore })
    await act(async () => {
      useAppStore.setState(state => ({
        system: {
          ...state.system,
          crossTabInvalidation: { status: 'stale' },
        },
      }))
    })
    expect(now).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledTimes(2)
    const latest = activeMount.snapshots[activeMount.snapshots.length - 1]
    expect(latest?.phase === 'ready' ? latest.result.status : null).toBe('unavailable')
  })

  it('C-B3-T11 reads a newly published same-tab generation exactly once', async () => {
    useAppStore.setState(runtimeState(), true)
    let current = committed()
    const restore = vi.fn(() => current)
    activeMount = await mountHook({
      now: () => Date.parse('2026-07-26T08:00:00.000Z'),
      restoreCanonicalGeneration: restore,
    })
    current = {
      ...committed(),
      generationId: 'candidate-fit-runtime-generation-2',
    }
    await act(async () => {
      useAppStore.setState(state => ({
        system: {
          ...state.system,
          csvLastImportedAt: '2026-07-26T07:06:00.000Z',
        },
      }))
    })
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('C-B3-T12 converts restore throws to invalid without exposing the raw error', () => {
    const output = evaluateCandidatePortfolioFitRuntime(runtimeState(), {
      now: () => Date.parse('2026-07-26T08:00:00.000Z'),
      restoreCanonicalGeneration: () => {
        throw new Error('raw-secret-error')
      },
    })
    expect(output.status).toBe('invalid')
    expect(JSON.stringify(output)).not.toContain('raw-secret-error')
  })

  it('C-B3-T13 fails closed for throwing and nonfinite clocks', () => {
    for (const now of [
      () => { throw new Error('clock') },
      () => Number.POSITIVE_INFINITY,
    ]) {
      const output = evaluateCandidatePortfolioFitRuntime(runtimeState(), {
        now,
        restoreCanonicalGeneration: () => committed(),
      })
      expect(output.status).toBe('invalid')
    }
  })

  it('C-B3-T14 adds no listener or timer and performs no cleanup write', async () => {
    useAppStore.setState(runtimeState(), true)
    const add = vi.fn()
    const interval = vi.fn()
    vi.stubGlobal('addEventListener', add)
    vi.stubGlobal('setInterval', interval)
    activeMount = await mountHook(dependencies())
    await activeMount.unmount()
    activeMount = null
    expect(add).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
  })

  it('C-B3-T15 mutates no state, network, persistence, or decision field', () => {
    const state = runtimeState()
    const stateKeys = Object.keys(state)
    const before = structuredClone({
      holdings: state.holdings,
      trust: state.trust,
      candidateFunnel: state.candidateFunnel,
      system: state.system,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      officialDecision: state.officialDecision,
    })
    const fetchSpy = vi.fn()
    const storageWrite = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: storageWrite,
    })
    evaluateCandidatePortfolioFitRuntime(state, dependencies())
    expect({
      holdings: state.holdings,
      trust: state.trust,
      candidateFunnel: state.candidateFunnel,
      system: state.system,
      portfolioPolicy: state.portfolioPolicy,
      cashAssumptions: state.cashAssumptions,
      officialDecision: state.officialDecision,
    }).toEqual(before)
    expect(Object.keys(state)).toEqual(stateKeys)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(storageWrite).not.toHaveBeenCalled()
    expect(state.officialDecision).toBe(before.officialDecision)

    const source = readFileSync(
      new URL('./useCandidatePortfolioFit.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toMatch(
      /fetch|setItem|officialDecision|BUY_NEW|BUY_MORE|portfolioFitResult|new Map|lastResult/,
    )
  })
})
