// @ts-expect-error -- repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { StrictMode, act } from 'react'
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
import * as portfolioFitSelectors from '../store/portfolioFitSelectors'
import {
  evaluateCandidatePortfolioFitRuntime,
  useCandidatePortfolioFit,
  type CandidatePortfolioFitRuntimeDependencies,
  type CandidatePortfolioFitRuntimeSnapshot,
} from './useCandidatePortfolioFit'

type CommittedGeneration = Extract<CsvImportGenerationRestoreResult, { status: 'committed' }>

const C_B3_ORIGINAL_FILES = [
  'src/hooks/useCandidatePortfolioFit.ts',
  'src/hooks/useCandidatePortfolioFit.test.tsx',
  'src/components/candidates/candidatePortfolioFitPresentation.ts',
  'src/components/candidates/candidatePortfolioFitPresentation.test.ts',
  'src/components/candidates/CandidateFunnelPanel.tsx',
  'src/components/candidates/CandidateFunnelPanel.test.tsx',
  'src/components/candidates/CandidateFunnelPanel.css',
  'src/components/candidates/CandidateFunnelCard.tsx',
  'src/components/tabs/T1_Decision.stockCandidate.test.ts',
] as const

const C_B3_PRODUCTION_TS_FILES = C_B3_ORIGINAL_FILES.filter(
  path => !path.includes('.test.') && !path.endsWith('.css'),
)

const C_B3_RESTORE_BOUNDARY_FILES = [
  ...C_B3_PRODUCTION_TS_FILES,
  'src/components/tabs/T1_Decision.tsx',
  'src/store/portfolioFitSelectors.ts',
] as const

function parseProductionSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function visitTree(node: ts.Node, visit: (current: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, child => visitTree(child, visit))
}

function propertyNameText(node: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
    ? node.argumentExpression.text
    : null
}

function rootIdentifier(node: ts.Expression): string | null {
  let current = node
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression
  }
  return ts.isIdentifier(current) ? current.text : null
}

function hookEffectDependencyNames(): string[] {
  const sourceFile = parseProductionSource('src/hooks/useCandidatePortfolioFit.ts')
  const dependencyLists: string[][] = []
  visitTree(sourceFile, node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments[1] &&
      ts.isArrayLiteralExpression(node.arguments[1])
    ) {
      dependencyLists.push(
        node.arguments[1].elements.map(element => element.getText(sourceFile)),
      )
    }
  })
  expect(dependencyLists).toHaveLength(1)
  return dependencyLists[0]
}

const POLICY: PortfolioPolicy = { jpStockMaxRatio: 0.15 }
const CASH: CashAssumptions = {
  source: 'MANUAL',
  grossCash: 600_000,
  safetyReserve: 0,
  pendingOrderCash: null,
  updatedAt: '2026-07-26T07:00:00.000Z',
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
  rerender: (
    revision: number,
    dependencies?: CandidatePortfolioFitRuntimeDependencies,
    beforeRender?: () => void,
  ) => Promise<void>
  unmount: () => Promise<void>
}

async function mountHook(
  runtimeDependencies: CandidatePortfolioFitRuntimeDependencies,
  options: { strictMode?: boolean } = {},
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
  function Harness({
    revision: _revision,
    dependencies: currentDependencies,
  }: {
    revision: number
    dependencies: CandidatePortfolioFitRuntimeDependencies
  }) {
    snapshots.push(useCandidatePortfolioFit(currentDependencies))
    return null
  }
  const root = createRoot(testDocument.createElement('div') as unknown as Element)
  let currentDependencies = runtimeDependencies
  const rerender = async (
    revision: number,
    nextDependencies = currentDependencies,
    beforeRender?: () => void,
  ) => {
    currentDependencies = nextDependencies
    await act(async () => {
      beforeRender?.()
      const harness = (
        <Harness
          revision={revision}
          dependencies={currentDependencies}
        />
      )
      root.render(options.strictMode ? <StrictMode>{harness}</StrictMode> : harness)
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

  it('R1 wrapper-only identity churn with the same callbacks adds no logical cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook({ now, restoreCanonicalGeneration: restore })

    await activeMount.rerender(1, {
      now,
      restoreCanonicalGeneration: restore,
    })
    await activeMount.rerender(2, {
      now,
      restoreCanonicalGeneration: restore,
    })

    expect(now).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(hookEffectDependencyNames()).toEqual([
      'now',
      'restoreCanonicalGeneration',
      'candidateFunnel',
      'candidateFunnelStatus',
      'holdings',
      'trust',
      'portfolioPolicy',
      'cashAssumptions',
      'csvLastImportedAt',
      'csvImportProvenance',
      'csvSyncSummary',
      'crossTabInvalidation',
    ])
  })

  it('R1 a new now callback identity performs exactly one additional cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const firstNow = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const secondNow = vi.fn(() => Date.parse('2026-07-26T08:01:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook({
      now: firstNow,
      restoreCanonicalGeneration: restore,
    })

    await activeMount.rerender(1, {
      now: secondNow,
      restoreCanonicalGeneration: restore,
    })

    expect(firstNow).toHaveBeenCalledTimes(1)
    expect(secondNow).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('R1 a new restore callback identity performs exactly one additional cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const firstRestore = vi.fn(() => committed())
    const secondRestore = vi.fn(() => committed())
    activeMount = await mountHook({
      now,
      restoreCanonicalGeneration: firstRestore,
    })

    await activeMount.rerender(1, {
      now,
      restoreCanonicalGeneration: secondRestore,
    })

    expect(now).toHaveBeenCalledTimes(2)
    expect(firstRestore).toHaveBeenCalledTimes(1)
    expect(secondRestore).toHaveBeenCalledTimes(1)
  })

  it('R2 coalesces a new now callback and candidate revision into one additional cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const firstNow = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const secondNow = vi.fn(() => Date.parse('2026-07-26T08:01:00.000Z'))
    const restore = vi.fn(() => committed())
    const selector = vi.spyOn(portfolioFitSelectors, 'selectCandidatePortfolioFit')
    activeMount = await mountHook({
      now: firstNow,
      restoreCanonicalGeneration: restore,
    })

    await activeMount.rerender(
      1,
      { now: secondNow, restoreCanonicalGeneration: restore },
      () => {
        useAppStore.setState(state => ({
          candidateFunnel: structuredClone(state.candidateFunnel),
        }))
      },
    )

    expect(firstNow).toHaveBeenCalledTimes(1)
    expect(secondNow).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(2)
    expect(selector).toHaveBeenCalledTimes(2)
  })

  it('R2 coalesces a new restore callback and candidate revision into one additional cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const firstRestore = vi.fn(() => committed())
    const secondRestore = vi.fn(() => committed())
    const selector = vi.spyOn(portfolioFitSelectors, 'selectCandidatePortfolioFit')
    activeMount = await mountHook({
      now,
      restoreCanonicalGeneration: firstRestore,
    })

    await activeMount.rerender(
      1,
      { now, restoreCanonicalGeneration: secondRestore },
      () => {
        useAppStore.setState(state => ({
          candidateFunnel: structuredClone(state.candidateFunnel),
        }))
      },
    )

    expect(now).toHaveBeenCalledTimes(2)
    expect(firstRestore).toHaveBeenCalledTimes(1)
    expect(secondRestore).toHaveBeenCalledTimes(1)
    expect(selector).toHaveBeenCalledTimes(2)
  })

  it('R2 coalesces a callback identity and cross-tab revision into one additional cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const firstNow = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const secondNow = vi.fn(() => Date.parse('2026-07-26T08:01:00.000Z'))
    const restore = vi.fn(() => committed())
    const selector = vi.spyOn(portfolioFitSelectors, 'selectCandidatePortfolioFit')
    activeMount = await mountHook({
      now: firstNow,
      restoreCanonicalGeneration: restore,
    })

    await activeMount.rerender(
      1,
      { now: secondNow, restoreCanonicalGeneration: restore },
      () => {
        useAppStore.setState(state => ({
          system: {
            ...state.system,
            crossTabInvalidation: { status: 'stale' },
          },
        }))
      },
    )

    expect(firstNow).toHaveBeenCalledTimes(1)
    expect(secondNow).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(2)
    expect(selector).toHaveBeenCalledTimes(2)
  })

  it('R2 coalesces both callbacks and a canonical-related revision into one additional cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const firstNow = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const secondNow = vi.fn(() => Date.parse('2026-07-26T08:01:00.000Z'))
    const firstRestore = vi.fn(() => committed())
    const secondRestore = vi.fn(() => committed())
    const selector = vi.spyOn(portfolioFitSelectors, 'selectCandidatePortfolioFit')
    activeMount = await mountHook({
      now: firstNow,
      restoreCanonicalGeneration: firstRestore,
    })

    await activeMount.rerender(
      1,
      { now: secondNow, restoreCanonicalGeneration: secondRestore },
      () => {
        useAppStore.setState(state => ({
          system: {
            ...state.system,
            csvLastImportedAt: '2026-07-26T08:01:00.000Z',
          },
        }))
      },
    )

    expect(firstNow).toHaveBeenCalledTimes(1)
    expect(secondNow).toHaveBeenCalledTimes(1)
    expect(firstRestore).toHaveBeenCalledTimes(1)
    expect(secondRestore).toHaveBeenCalledTimes(1)
    expect(selector).toHaveBeenCalledTimes(2)
  })

  it('R2 coalesces multiple same-act store revisions into one additional cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    const selector = vi.spyOn(portfolioFitSelectors, 'selectCandidatePortfolioFit')
    activeMount = await mountHook({ now, restoreCanonicalGeneration: restore })

    await act(async () => {
      useAppStore.setState(state => ({
        candidateFunnel: structuredClone(state.candidateFunnel),
      }))
      useAppStore.setState(state => ({
        system: {
          ...state.system,
          crossTabInvalidation: { status: 'stale' },
          csvLastImportedAt: '2026-07-26T08:02:00.000Z',
        },
      }))
    })

    expect(now).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledTimes(2)
    expect(selector).toHaveBeenCalledTimes(2)
  })

  it('R1 batches wrapper replacement and a relevant store revision into one cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook({ now, restoreCanonicalGeneration: restore })

    await activeMount.rerender(
      1,
      { now, restoreCanonicalGeneration: restore },
      () => {
        useAppStore.setState(state => ({
          candidateFunnel: structuredClone(state.candidateFunnel),
        }))
      },
    )

    expect(now).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('R1 StrictMode initial mount executes one logical result cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook(
      { now, restoreCanonicalGeneration: restore },
      { strictMode: true },
    )

    const readyResults = activeMount.snapshots.flatMap(snapshot =>
      snapshot.phase === 'ready' ? [snapshot.result] : [],
    )
    expect(now).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(readyResults.length).toBeGreaterThan(0)
    expect(new Set(readyResults).size).toBe(1)
  })

  it('R1 StrictMode relevant revision adds one logical cycle, not two', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook(
      { now, restoreCanonicalGeneration: restore },
      { strictMode: true },
    )

    await act(async () => {
      useAppStore.setState(state => ({
        candidateFunnel: structuredClone(state.candidateFunnel),
      }))
    })

    expect(now).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('R1 StrictMode wrapper-only rerender adds no logical cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    activeMount = await mountHook(
      { now, restoreCanonicalGeneration: restore },
      { strictMode: true },
    )

    await activeMount.rerender(1, {
      now,
      restoreCanonicalGeneration: restore,
    })

    expect(now).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('R1 real unmount/remount creates a new component-local logical cycle', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    const deps = { now, restoreCanonicalGeneration: restore }
    activeMount = await mountHook(deps, { strictMode: true })
    await activeMount.unmount()
    activeMount = null

    activeMount = await mountHook(deps, { strictMode: true })

    expect(now).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('R1 hook mount performs no production Zustand write', async () => {
    useAppStore.setState(runtimeState(), true)
    const setStateSpy = vi.spyOn(useAppStore, 'setState')
    activeMount = await mountHook(dependencies())

    expect(setStateSpy).not.toHaveBeenCalled()
  })

  it('R2 observes zero production Zustand writes through a combined scheduled revision', async () => {
    useAppStore.setState(runtimeState(), true)
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const nextNow = vi.fn(() => Date.parse('2026-07-26T08:01:00.000Z'))
    const restore = vi.fn(() => committed())
    const setStateSpy = vi.spyOn(useAppStore, 'setState')
    const emittedStates: AppState[] = []
    const unsubscribe = useAppStore.subscribe(state => emittedStates.push(state))
    activeMount = await mountHook({ now, restoreCanonicalGeneration: restore })
    expect(setStateSpy).not.toHaveBeenCalled()
    expect(emittedStates).toEqual([])

    await activeMount.rerender(
      1,
      { now: nextNow, restoreCanonicalGeneration: restore },
      () => {
        useAppStore.setState(state => ({
          candidateFunnel: structuredClone(state.candidateFunnel),
        }))
      },
    )
    unsubscribe()

    // The sole call/emission is the intentional fixture revision above. A hook-originated
    // direct or module-captured alias write would add another store emission.
    expect(setStateSpy).toHaveBeenCalledTimes(1)
    expect(emittedStates).toHaveLength(1)
    expect(now).toHaveBeenCalledTimes(1)
    expect(nextNow).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('R2 ignores a stale scheduled token and evaluates only the newest input', async () => {
    useAppStore.setState(runtimeState(), true)
    const scheduledTasks: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (task: () => void) => scheduledTasks.push(task))
    const firstNow = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const secondNow = vi.fn(() => Date.parse('2026-07-26T08:01:00.000Z'))
    const restore = vi.fn(() => committed())
    const selector = vi.spyOn(portfolioFitSelectors, 'selectCandidatePortfolioFit')
    activeMount = await mountHook({
      now: firstNow,
      restoreCanonicalGeneration: restore,
    })
    expect(scheduledTasks).toHaveLength(1)

    await activeMount.rerender(1, {
      now: secondNow,
      restoreCanonicalGeneration: restore,
    })
    expect(scheduledTasks).toHaveLength(2)

    await act(async () => scheduledTasks[0]())
    expect(firstNow).not.toHaveBeenCalled()
    expect(secondNow).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(selector).not.toHaveBeenCalled()

    await act(async () => scheduledTasks[1]())
    expect(firstNow).not.toHaveBeenCalled()
    expect(secondNow).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(selector).toHaveBeenCalledTimes(1)
  })

  it('R2 cancels pending evaluation and publication after real unmount', async () => {
    useAppStore.setState(runtimeState(), true)
    const scheduledTasks: Array<() => void> = []
    vi.stubGlobal('queueMicrotask', (task: () => void) => scheduledTasks.push(task))
    const now = vi.fn(() => Date.parse('2026-07-26T08:00:00.000Z'))
    const restore = vi.fn(() => committed())
    const selector = vi.spyOn(portfolioFitSelectors, 'selectCandidatePortfolioFit')
    activeMount = await mountHook({ now, restoreCanonicalGeneration: restore })
    const pendingSnapshots = activeMount.snapshots.filter(
      snapshot => snapshot.phase === 'pending',
    )
    expect(scheduledTasks).toHaveLength(1)

    await activeMount.unmount()
    activeMount = null
    await act(async () => scheduledTasks[0]())

    expect(now).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(selector).not.toHaveBeenCalled()
    expect(pendingSnapshots.length).toBeGreaterThan(0)
  })
})

describe('P5-B005-C-B3-R1 production source-contract guards', () => {
  it('R2 retains completed-input equality and latest-token guards around one microtask', () => {
    const sourceFile = parseProductionSource('src/hooks/useCandidatePortfolioFit.ts')
    const completedInputChecks: string[] = []
    const scheduledMicrotasks: string[] = []
    const latestTokenChecks: string[] = []

    visitTree(sourceFile, node => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'isSameLogicalCycleInput' &&
        node.arguments[0]?.getText(sourceFile) ===
          'completedLogicalCycleInputRef.current'
      ) {
        completedInputChecks.push(node.getText(sourceFile))
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'queueMicrotask'
      ) {
        scheduledMicrotasks.push(node.getText(sourceFile))
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        node.left.getText(sourceFile) === 'scheduleGenerationRef.current' &&
        node.right.getText(sourceFile) === 'scheduledGeneration'
      ) {
        latestTokenChecks.push(node.getText(sourceFile))
      }
    })

    expect(completedInputChecks).toHaveLength(2)
    expect(scheduledMicrotasks).toHaveLength(1)
    expect(latestTokenChecks).toEqual([
      'scheduleGenerationRef.current !== scheduledGeneration',
    ])
  })

  it('R1 allows exactly one canonical restore import and call, both in the hook', () => {
    const importSites: string[] = []
    const callSites: string[] = []
    const dynamicLoadSites: string[] = []

    for (const path of C_B3_RESTORE_BOUNDARY_FILES) {
      const sourceFile = parseProductionSource(path)
      const restoreBindings = new Set<string>()

      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.endsWith('/persist')
        ) {
          continue
        }
        const bindings = statement.importClause?.namedBindings
        if (!bindings || !ts.isNamedImports(bindings)) continue
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text
          if (
            importedName === 'restoreCsvImportGeneration' &&
            !statement.importClause?.isTypeOnly &&
            !element.isTypeOnly
          ) {
            restoreBindings.add(element.name.text)
            importSites.push(path)
          }
        }
      }

      let discoveredAlias = true
      while (discoveredAlias) {
        discoveredAlias = false
        visitTree(sourceFile, node => {
          if (
            !ts.isVariableDeclaration(node) ||
            !ts.isIdentifier(node.name) ||
            node.initializer === undefined
          ) {
            return
          }
          const initializer = node.initializer
          const aliasesRestore =
            (ts.isIdentifier(initializer) && restoreBindings.has(initializer.text)) ||
            ((ts.isPropertyAccessExpression(initializer) ||
              ts.isElementAccessExpression(initializer)) &&
              propertyNameText(initializer) === 'restoreCsvImportGeneration')
          if (aliasesRestore && !restoreBindings.has(node.name.text)) {
            restoreBindings.add(node.name.text)
            discoveredAlias = true
          }
        })
      }

      visitTree(sourceFile, node => {
        if (!ts.isCallExpression(node)) return
        const expression = node.expression
        if (
          expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(expression) && expression.text === 'require')
        ) {
          dynamicLoadSites.push(path)
        }
        const callsRestore =
          (ts.isIdentifier(expression) && restoreBindings.has(expression.text)) ||
          ((ts.isPropertyAccessExpression(expression) ||
            ts.isElementAccessExpression(expression)) &&
            propertyNameText(expression) === 'restoreCsvImportGeneration')
        if (callsRestore) callSites.push(path)
      })
    }

    expect(importSites).toEqual(['src/hooks/useCandidatePortfolioFit.ts'])
    expect(callSites).toEqual(['src/hooks/useCandidatePortfolioFit.ts'])
    expect(dynamicLoadSites).toEqual([])
  })

  it('R1 rejects module-global mutable runtime retention while allowing immutable labels', () => {
    const violations: string[] = []
    const mutatingMethods = new Set([
      'add',
      'clear',
      'delete',
      'pop',
      'push',
      'set',
      'shift',
      'sort',
      'splice',
      'unshift',
    ])

    for (const path of C_B3_PRODUCTION_TS_FILES) {
      const sourceFile = parseProductionSource(path)
      const topLevelBindings = new Set<string>()

      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue
        const declarationKind =
          statement.declarationList.flags & ts.NodeFlags.Let
            ? 'let'
            : statement.declarationList.flags & ts.NodeFlags.Const
              ? 'const'
              : 'var'
        if (declarationKind !== 'const') {
          violations.push(`${path}:top-level-${declarationKind}`)
        }
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue
          topLevelBindings.add(declaration.name.text)
          const initializer = declaration.initializer
          if (
            initializer &&
            ts.isNewExpression(initializer) &&
            ts.isIdentifier(initializer.expression) &&
            ['Array', 'Map', 'Set', 'WeakMap', 'WeakSet'].includes(
              initializer.expression.text,
            )
          ) {
            violations.push(`${path}:mutable-${initializer.expression.text}`)
          }
        }
      }

      visitTree(sourceFile, node => {
        if (
          ts.isCallExpression(node) &&
          (ts.isPropertyAccessExpression(node.expression) ||
            ts.isElementAccessExpression(node.expression))
        ) {
          const method = propertyNameText(node.expression)
          const root = rootIdentifier(node.expression.expression)
          if (
            method !== null &&
            mutatingMethods.has(method) &&
            root !== null &&
            topLevelBindings.has(root)
          ) {
            violations.push(`${path}:mutates-${root}`)
          }
          if (
            method === 'assign' &&
            node.arguments.some(argument =>
              ts.isIdentifier(argument) &&
              ['globalThis', 'window', 'self', 'exports'].includes(argument.text),
            )
          ) {
            violations.push(`${path}:global-assign`)
          }
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          const root = ts.isIdentifier(node.left)
            ? node.left.text
            : ts.isPropertyAccessExpression(node.left) ||
                ts.isElementAccessExpression(node.left)
              ? rootIdentifier(node.left)
              : null
          if (
            root !== null &&
            (topLevelBindings.has(root) ||
              ['globalThis', 'window', 'self', 'exports', 'module'].includes(root))
          ) {
            violations.push(`${path}:assignment-${root}`)
          }
        }
      })
    }

    expect(violations).toEqual([])
  })

  it('R2 permits one read-only Zustand snapshot and rejects every setState AST form', () => {
    const getStateSites: string[] = []
    const writeSites: string[] = []

    for (const path of C_B3_PRODUCTION_TS_FILES) {
      const sourceFile = parseProductionSource(path)
      visitTree(sourceFile, node => {
        if (
          (ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) &&
          propertyNameText(node) === 'getState'
        ) {
          getStateSites.push(path)
        }
        if (
          (ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)) &&
          propertyNameText(node) === 'setState'
        ) {
          writeSites.push(path)
        }
        if (
          ts.isBindingElement(node) &&
          ts.isObjectBindingPattern(node.parent) &&
          (
            (node.propertyName !== undefined &&
              ((ts.isIdentifier(node.propertyName) ||
                ts.isStringLiteral(node.propertyName)) &&
                node.propertyName.text === 'setState')) ||
            (node.propertyName === undefined &&
              ts.isIdentifier(node.name) &&
              node.name.text === 'setState')
          )
        ) {
          writeSites.push(path)
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          (node.expression.text === 'setState' || node.expression.text === 'set')
        ) {
          writeSites.push(path)
        }
      })
    }

    expect(getStateSites).toEqual(['src/hooks/useCandidatePortfolioFit.ts'])
    expect(writeSites).toEqual([])
  })

  it('R1 keeps the only current-time clock in the hook default dependency', () => {
    const dateNowSites: string[] = []
    const otherClockSites: string[] = []

    for (const path of C_B3_RESTORE_BOUNDARY_FILES) {
      const sourceFile = parseProductionSource(path)
      visitTree(sourceFile, node => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.name.text === 'now'
        ) {
          if (node.expression.expression.text === 'Date') {
            dateNowSites.push(path)
          }
          if (node.expression.expression.text === 'performance') {
            otherClockSites.push(path)
          }
        }
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'Date' &&
          (node.arguments?.length ?? 0) === 0
        ) {
          otherClockSites.push(path)
        }
      })
    }

    expect(dateNowSites).toEqual(['src/hooks/useCandidatePortfolioFit.ts'])
    expect(otherClockSites).toEqual([])
  })
})
