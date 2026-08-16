import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// @ts-expect-error -- repositoryは@types/node非依存だがVitestのNode runtimeでのみ使用する
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import type { CandidateFunnelCandidate } from '../../types/candidateFunnel'
import type { CandidateFunnelArtifact } from '../../types/candidateFunnelArtifact'
import { buildValidCandidateFunnelArtifact } from '../../services/candidateFunnelArtifact.fixtures'
import { parseCandidateFunnelArtifact } from '../../services/candidateFunnelParser'
import * as persist from '../../store/persist'
import * as portfolioFitSelectors from '../../store/portfolioFitSelectors'
import { useAppStore } from '../../store/useAppStore'
import { selectCandidateFunnelFreshness } from '../../store/selectors'
import {
  CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
  CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT,
  CandidateFunnelPanel,
  CandidateFunnelPanelView,
  candidateFunnelFilterForKey,
  candidateFunnelViewReducer,
  formatCandidateFunnelJstTimestamp,
  indexCandidateFunnelCandidates,
  sortCandidateFunnelCandidates,
  type CandidateFunnelViewState,
} from './CandidateFunnelPanel'
import {
  CandidateFunnelCard,
  formatCandidateDataConfidence,
  formatCandidateMetric,
  formatCandidateRiskReason,
  formatCandidateTheme,
  formatCandidateTier,
} from './CandidateFunnelCard'
import type {
  CandidatePortfolioFitPresentationStatus,
  CandidatePortfolioFitPresentationViewModel,
  CandidatePortfolioFitRecordViewModel,
} from './candidatePortfolioFitPresentation'
// @ts-expect-error -- Viteの?raw importはtest/build時にsource文字列へ解決される
import panelSource from './CandidateFunnelPanel.tsx?raw'
// @ts-expect-error -- Viteの?raw importはtest/build時にsource文字列へ解決される
import cardSource from './CandidateFunnelCard.tsx?raw'
// @ts-expect-error -- Viteの?raw importはtest/build時にsource文字列へ解決される
import t1Source from '../tabs/T1_Decision.tsx?raw'
// @ts-expect-error -- Viteの?raw importはtest/build時にsource文字列へ解決される
import t0Source from '../tabs/T0_Home.tsx?raw'

const panelCssSource = readFileSync(
  'src/components/candidates/CandidateFunnelPanel.css',
  'utf8',
)

function artifact(): CandidateFunnelArtifact {
  return structuredClone(buildValidCandidateFunnelArtifact()) as CandidateFunnelArtifact
}

function candidate(
  source: CandidateFunnelArtifact,
  tier: CandidateFunnelCandidate['tier'],
): CandidateFunnelCandidate {
  const found = source.candidates.find(item => item.tier === tier)
  if (!found) throw new Error(`fixture candidate missing: ${tier}`)
  return structuredClone(found)
}

function renderPanel(
  data: CandidateFunnelArtifact | null,
  freshness: 'fresh' | 'stale' | 'degraded' | 'invalid' | 'unavailable',
  viewState: CandidateFunnelViewState = CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
  portfolioFit: CandidatePortfolioFitPresentationViewModel = fitPresentation('pending'),
): string {
  return renderToStaticMarkup(
    <CandidateFunnelPanelView
      artifact={data}
      freshness={freshness}
      portfolioFit={portfolioFit}
      viewState={viewState}
      onAction={() => {}}
    />,
  )
}

function fitRecord(
  artifactIndex: number,
  status: CandidatePortfolioFitRecordViewModel['status'] = 'evaluated',
): CandidatePortfolioFitRecordViewModel {
  return {
    artifactIndex,
    candidateRecordId: `artifact:${artifactIndex}`,
    status,
    statusText: status === 'partial'
      ? 'ポートフォリオ適合は一部のみ評価できました。'
      : 'ポートフォリオ適合を評価しました。',
    relationship: 'new_to_portfolio',
    relationshipText: '新規候補（未保有）',
    components: [
      {
        id: 'same_code_relationship',
        label: '同一コード保有関係',
        status: 'evaluated',
        statusText: '評価済み',
        valueText: null,
        valueAriaLabel: null,
      },
      {
        id: 'existing_concentration',
        label: '既存ポートフォリオ内の同一コード比率',
        status: status === 'partial' ? 'partial' : 'evaluated',
        statusText: status === 'partial' ? '一部評価' : '評価済み',
        valueText: status === 'partial' ? null : '25%',
        valueAriaLabel: status === 'partial'
          ? null
          : '既存ポートフォリオ内の同一コード比率 25パーセント',
      },
      {
        id: 'sector_diversification',
        label: '既存日本株内の同一セクター比率',
        status: 'evaluated',
        statusText: '評価済み',
        valueText: '66.7%',
        valueAriaLabel: '既存日本株内の同一セクター比率 66.7パーセント',
      },
    ],
    reasons: ['未保有として照合'],
    risks: ['セクター情報が不完全です'],
    hasUnknownLiteral: false,
  }
}

function fitPresentation(
  status: CandidatePortfolioFitPresentationStatus,
  records: CandidatePortfolioFitRecordViewModel[] = [
    fitRecord(1),
    fitRecord(2),
  ],
): CandidatePortfolioFitPresentationViewModel {
  const statusText = {
    pending: 'ポートフォリオ適合を評価しています。',
    evaluated: 'ポートフォリオ適合を評価しました。',
    partial: 'ポートフォリオ適合は一部のみ評価できました。',
    unavailable: 'ポートフォリオ適合を評価できません。',
    invalid: 'ポートフォリオ適合データを検証できませんでした。',
  }[status]
  return {
    dataset: {
      status,
      statusText,
      alertRole: status === 'invalid'
        ? 'alert'
        : status === 'evaluated'
          ? 'none'
          : 'status',
      evaluatedAtText: status === 'pending' ? null : '2026/07/26 17:00:00',
      portfolioFreshnessText: status === 'pending' ? null : '保有データ鮮度: 有効',
      capacityText: status === 'pending' ? null : '日本株枠: 余力あり',
      degradationText: status === 'partial' ? '1件' : null,
      canonicalMessage: null,
      hasHardFail: status === 'invalid',
      hasWarning: status === 'partial',
      notForTradingText:
        '売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。',
    },
    records: status === 'invalid' || status === 'unavailable' ? [] : records,
  }
}

function countCandidateCards(html: string): number {
  return html.match(/<article class="candidate-funnel-card"/g)?.length ?? 0
}

function largeScreenedArtifact(size: number): CandidateFunnelArtifact {
  const data = artifact()
  const base = candidate(data, 'screened')
  data.candidates = Array.from({ length: size }, (_, index) => ({
    ...structuredClone(base),
    code: String(2000 + index),
    name: `長い日本語銘柄名を含む一次選別テスト企業${index}`,
    marketRank: size - index,
    prescreenRank: index + 1,
  }))
  data.counts = {
    total: size,
    excluded: 0,
    screened: size,
    deepReview: 0,
    actionable: 0,
  }
  return data
}

function duplicateCodeArtifact(): CandidateFunnelArtifact {
  const data = artifact()
  const base = candidate(data, 'actionable')
  data.candidates = [
    {
      ...structuredClone(base),
      code: '7777',
      name: '同一コード候補A',
      sector: '機械',
      marketRank: 1,
    },
    {
      ...structuredClone(base),
      code: '7777',
      name: '同一コード候補B',
      sector: '情報・通信業',
      marketRank: 2,
    },
  ]
  data.counts = {
    total: 2,
    excluded: 0,
    screened: 0,
    deepReview: 0,
    actionable: 2,
  }
  return data
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

class CandidateFunnelTestNode {
  readonly attributes: Record<string, string> = {}
  readonly childNodes: CandidateFunnelTestNode[] = []
  readonly namespaceURI: string | null
  readonly style: Record<string, string> = {}
  readonly tagName: string | undefined
  ownerDocument: CandidateFunnelTestDocument
  parentNode: CandidateFunnelTestNode | null = null
  nodeValue: string | null = null

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    ownerDocument: CandidateFunnelTestDocument,
  ) {
    this.ownerDocument = ownerDocument
    this.tagName = nodeType === 1 ? nodeName : undefined
    this.namespaceURI = nodeType === 1 ? 'http://www.w3.org/1999/xhtml' : null
  }

  appendChild(child: CandidateFunnelTestNode) {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: CandidateFunnelTestNode, before: CandidateFunnelTestNode) {
    const index = this.childNodes.indexOf(before)
    if (index < 0) return this.appendChild(child)
    child.parentNode = this
    this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild(child: CandidateFunnelTestNode) {
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
    return this.childNodes
      .map(child => child.nodeValue ?? child.textContent)
      .join('')
  }

  get firstChild() {
    return this.childNodes[0] ?? null
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
}

class CandidateFunnelTestDocument extends CandidateFunnelTestNode {
  readonly activeElement: CandidateFunnelTestNode
  readonly body: CandidateFunnelTestNode
  readonly documentElement: CandidateFunnelTestNode
  defaultView: unknown = null

  constructor() {
    // The document temporarily owns itself after super returns.
    super(9, '#document', null as unknown as CandidateFunnelTestDocument)
    this.ownerDocument = this
    this.documentElement = new CandidateFunnelTestNode(1, 'HTML', this)
    this.body = new CandidateFunnelTestNode(1, 'BODY', this)
    this.activeElement = this.body
  }

  createElement(name: string) {
    return new CandidateFunnelTestNode(1, name.toUpperCase(), this)
  }

  createElementNS(namespaceURI: string, name: string) {
    const element = this.createElement(name)
    Object.defineProperty(element, 'namespaceURI', { value: namespaceURI })
    return element
  }

  createTextNode(value: string) {
    const node = new CandidateFunnelTestNode(3, '#text', this)
    node.nodeValue = value
    return node
  }

  createComment(value: string) {
    const node = new CandidateFunnelTestNode(8, '#comment', this)
    node.nodeValue = value
    return node
  }

  getElementById() {
    return null
  }
}

async function captureReactDomConsoleErrors(
  data: CandidateFunnelArtifact,
): Promise<unknown[][]> {
  const testDocument = new CandidateFunnelTestDocument()
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

  const globalDescriptors = new Map(
    ['window', 'document', 'navigator'].map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  )
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: testWindow },
    document: { configurable: true, value: testDocument },
    navigator: { configurable: true, value: { userAgent: 'vitest' } },
  })

  let root: { render(node: React.ReactNode): void; unmount(): void } | null = null
  let consoleErrors: unknown[][] = []
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const [{ createRoot }, { flushSync }] = await Promise.all([
      import('react-dom/client'),
      import('react-dom'),
    ])
    const container = testDocument.createElement('div')
    root = createRoot(container as unknown as Element)
    flushSync(() => {
      root?.render(
        <CandidateFunnelPanelView
          artifact={data}
          freshness="fresh"
          viewState={CANDIDATE_FUNNEL_INITIAL_VIEW_STATE}
          onAction={() => {}}
        />,
      )
    })
    consoleErrors = consoleErrorSpy.mock.calls.map(call => [...call])
    flushSync(() => root?.unmount())
    root = null
  } finally {
    root?.unmount()
    consoleErrorSpy.mockRestore()
    for (const [name, descriptor] of globalDescriptors) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name)
      } else {
        Object.defineProperty(globalThis, name, descriptor)
      }
    }
  }
  return consoleErrors
}

function findCandidateFunnelNodes(
  root: CandidateFunnelTestNode,
  predicate: (node: CandidateFunnelTestNode) => boolean,
): CandidateFunnelTestNode[] {
  const matches = predicate(root) ? [root] : []
  for (const child of root.childNodes) {
    matches.push(...findCandidateFunnelNodes(child, predicate))
  }
  return matches
}

function reactNodeProps(node: CandidateFunnelTestNode): Record<string, unknown> {
  const record = node as unknown as Record<string, unknown>
  const propsKey = Object.keys(record).find(key => key.startsWith('__reactProps$'))
  if (propsKey === undefined) throw new Error('React props were not attached to the test node')
  return record[propsKey] as Record<string, unknown>
}

describe('P5-B005-B3-C CandidateFunnelPanel summary and hierarchy', () => {
  it('fresh loaded state displays the artifact-authoritative summary counts', () => {
    const data = artifact()
    data.counts = { total: 9, excluded: 0, screened: 5, deepReview: 3, actionable: 1 }
    const html = renderPanel(data, 'fresh')

    expect(html).toContain('市場候補</span><strong>9</strong>')
    expect(html).toContain('一次選別</span><strong>5</strong>')
    expect(html).toContain('詳細精査</span><strong>3</strong>')
    expect(html).toContain('重点候補</span><strong>1</strong>')
  })

  it('starts with actionable as the selected filter and renders only its candidate', () => {
    const data = artifact()
    const html = renderPanel(data, 'fresh')

    expect(CANDIDATE_FUNNEL_INITIAL_VIEW_STATE.filter).toBe('actionable')
    expect(html).toContain('テスト銘柄1003')
    expect(html).not.toContain('テスト銘柄1001')
    expect(html).not.toContain('テスト銘柄1002')
  })

  it('uses marketRank ascending with artifact order as the stable tie/null fallback', () => {
    const data = artifact()
    const base = candidate(data, 'actionable')
    const input = [
      { ...structuredClone(base), code: 'rank-null-a', marketRank: null },
      { ...structuredClone(base), code: 'rank-3', marketRank: 3 },
      { ...structuredClone(base), code: 'rank-1-a', marketRank: 1 },
      { ...structuredClone(base), code: 'rank-1-b', marketRank: 1 },
      { ...structuredClone(base), code: 'rank-null-b', marketRank: null },
    ]

    expect(sortCandidateFunnelCandidates(input).map(item => item.code)).toEqual([
      'rank-1-a',
      'rank-1-b',
      'rank-3',
      'rank-null-a',
      'rank-null-b',
    ])
    expect(input.map(item => item.code)).toEqual([
      'rank-null-a',
      'rank-3',
      'rank-1-a',
      'rank-1-b',
      'rank-null-b',
    ])
  })

  it('switches the view model to deep_review', () => {
    const html = renderPanel(artifact(), 'fresh', { filter: 'deep_review', visibleCount: 10 })
    expect(html).toContain('テスト銘柄1002')
    expect(html).not.toContain('テスト銘柄1003')
    expect(html).toContain('aria-labelledby="candidate-funnel-tab-deep_review"')
  })

  it('switches the view model to screened', () => {
    const html = renderPanel(artifact(), 'fresh', { filter: 'screened', visibleCount: 10 })
    expect(html).toContain('テスト銘柄1001')
    expect(html).not.toContain('テスト銘柄1003')
    expect(html).toContain('data-tier="screened"')
  })

  it('resets the visible count when the filter changes', () => {
    const expanded = candidateFunnelViewReducer(
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      { type: 'show_more' },
    )
    expect(expanded.visibleCount).toBeGreaterThan(CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT)

    expect(candidateFunnelViewReducer(expanded, {
      type: 'set_filter',
      filter: 'screened',
    })).toEqual({
      filter: 'screened',
      visibleCount: CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT,
    })
  })

  it('renders a bounded first page and adds a fixed-size page with さらに表示', () => {
    const data = largeScreenedArtifact(25)
    const firstPage = renderPanel(data, 'fresh', {
      filter: 'screened',
      visibleCount: CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT,
    })
    expect(countCandidateCards(firstPage)).toBe(CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT)
    expect(firstPage).toContain('さらに表示')
    expect(firstPage).toContain('（10/25件）')

    const expandedState = candidateFunnelViewReducer(
      { filter: 'screened', visibleCount: CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT },
      { type: 'show_more' },
    )
    const expanded = renderPanel(data, 'fresh', expandedState)
    expect(countCandidateCards(expanded)).toBe(20)
    expect(expanded).toContain('（20/25件）')
  })

  it('treats a zero-candidate tier as a normal empty state', () => {
    const data = artifact()
    data.candidates = data.candidates.filter(item => item.tier !== 'actionable')
    data.counts = { total: 2, excluded: 0, screened: 1, deepReview: 1, actionable: 0 }
    const html = renderPanel(data, 'fresh')

    expect(html).toContain('重点候補に該当する候補はありません')
    expect(html).not.toContain('テスト銘柄1003')
  })

  it('keeps the artifact position as record identity before filtering and sorting', () => {
    const data = artifact()
    const indexed = indexCandidateFunnelCandidates(data.candidates)

    expect(indexed.map(entry => entry.artifactIndex)).toEqual([0, 1, 2])
    expect(indexed.map(entry => entry.candidate)).toEqual(data.candidates)
    expect(panelSource).toContain('key={`candidate-funnel-record-${entry.artifactIndex}`}')
    expect(panelSource).not.toContain('key={candidate.code}')
    expect(panelSource.match(/visibleCandidates\.map/g)).toHaveLength(1)
  })

  it('renders same-code records with unique keys, headings, and self-owned ARIA labels', async () => {
    const parsed = parseCandidateFunnelArtifact(duplicateCodeArtifact())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(`duplicate-code fixture rejected: ${parsed.code}`)

    const consoleErrors = await captureReactDomConsoleErrors(parsed.data)
    const html = renderPanel(parsed.data, 'fresh')
    expect(consoleErrors).toEqual([])
    expect(countCandidateCards(html)).toBe(2)
    expect(html.match(/candidate-funnel-card__code">7777/g)).toHaveLength(2)
    expect(html).toContain('同一コード候補A')
    expect(html).toContain('機械')
    expect(html).toContain('同一コード候補B')
    expect(html).toContain('情報・通信業')

    const articles = [...html.matchAll(
      /<article class="candidate-funnel-card" aria-labelledby="([^"]+)">([\s\S]*?)<\/article>/g,
    )]
    expect(articles).toHaveLength(2)
    expect(html.match(/<h3 id="[^"]+" class="candidate-funnel-card__name">/g)).toHaveLength(2)

    const headingIds = articles.map(([, labelledBy, articleHtml]) => {
      const heading = articleHtml.match(
        /<h3 id="([^"]+)" class="candidate-funnel-card__name">[^<]+<\/h3>/,
      )
      expect(heading).not.toBeNull()
      const headingId = heading?.[1] ?? ''
      expect(headingId).not.toBe('')
      expect(labelledBy).toBe(headingId)
      expect(html.match(new RegExp(`id="${escapeRegExp(labelledBy)}"`, 'g'))).toHaveLength(1)
      return headingId
    })

    expect(headingIds).toHaveLength(2)
    expect(new Set(headingIds).size).toBe(2)
  })
})

describe('P5-B005-B3-C freshness and load states', () => {
  it('does not render a candidate list for unavailable', () => {
    const html = renderPanel(null, 'unavailable')
    expect(html).toContain('候補データを取得できませんでした')
    expect(html).not.toContain('role="tabpanel"')
    expect(html).not.toContain('candidate-funnel-card')
  })

  it('does not resurrect an old candidate list when unavailable is paired with stale artifact data', () => {
    const html = renderPanel(artifact(), 'unavailable')
    expect(html).toContain('候補データを取得できませんでした')
    expect(html).not.toContain('role="tabpanel"')
    expect(html).not.toContain('テスト銘柄1003')
  })

  it('does not render a candidate list for invalid', () => {
    const html = renderPanel(null, 'invalid')
    expect(html).toContain('候補データを検証できませんでした')
    expect(html).not.toContain('role="tabpanel"')
    expect(html).not.toContain('candidate-funnel-card')
  })

  it('does not render old candidate data when freshness is invalid', () => {
    const html = renderPanel(artifact(), 'invalid')
    expect(html).toContain('候補データを検証できませんでした')
    expect(html).not.toContain('role="tabpanel"')
    expect(html).not.toContain('テスト銘柄1003')
  })

  it('treats loaded plus null inconsistency as invalid display', () => {
    const html = renderPanel(null, 'invalid')
    expect(html).toContain('role="alert"')
    expect(html).toContain('候補データを検証できませんでした')
    expect(html).not.toContain('raw')
  })

  it('shows stale as text, icon and an ARIA status without hiding candidates', () => {
    const html = renderPanel(artifact(), 'stale')
    expect(html).toContain('データが古い可能性があります')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('テスト銘柄1003')
  })

  it('generalizes degraded provenance and says not to use it for current purchase decisions', () => {
    const data = artifact()
    data._meta.pipelinePath = 'cache_fallback'
    const html = renderPanel(data, 'degraded')
    expect(html).toContain('代替データ経路を使用しています')
    expect(html).toContain('現在の購入判断には使用しないでください')
    expect(html).not.toContain('cache_fallback')
    expect(html).not.toContain('seed_fallback')
    expect(html).toContain('テスト銘柄1003')
  })

  it('displays generatedAt and sourceUpdatedAt in Japan time', () => {
    const data = artifact()
    const html = renderPanel(data, 'fresh')
    expect(html).toContain('生成:')
    expect(html).toContain('ソース更新:')
    expect(html).toContain('JST')
    expect(formatCandidateFunnelJstTimestamp(data._meta.generatedAt)).toContain('2026')
    expect(formatCandidateFunnelJstTimestamp(data._meta.sourceUpdatedAt)).not.toBe('—')
  })

  it('shows generalized provenance and quality observability without raw JSON or technical gate IDs', () => {
    const html = renderPanel(artifact(), 'fresh')
    expect(html).toContain('通常データ経路')
    expect(html).toContain('データ検証通過')
    expect(html).toContain('重大な検証不一致')
    expect(html).not.toMatch(/P-0[1-9]|P-1[0-5]/)
    expect(html).not.toContain('{&quot;')
  })

  it('uses the store freshness selector instead of candidate existence checks', () => {
    expect(panelSource).toContain('selectCandidateFunnelFreshness(state, evaluatedAtMs)')
    expect(panelSource).not.toContain('selectCandidateFunnelFreshness(state, Date.now())')
    expect(panelSource).not.toContain("artifact ? 'fresh'")
    expect(panelSource).not.toContain("candidateFunnel ? 'fresh'")
  })
})

describe('P5-B005-B3-C candidate card presentation', () => {
  it('renders every required card field', () => {
    const data = artifact()
    const html = renderToStaticMarkup(
      <CandidateFunnelCard candidate={candidate(data, 'actionable')} />,
    )
    for (const label of [
      '市場スコア',
      '市場順位',
      'データ確度',
      '一次選別順位',
      '選別段階',
      'テーマ',
      'データ状態',
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toContain('1003')
    expect(html).toContain('テスト銘柄1003')
    expect(html).toContain('銀行業')
  })

  it('never substitutes zero for null score or rank', () => {
    const data = artifact()
    const item = candidate(data, 'actionable')
    item.marketScore = null
    item.marketRank = null
    item.prescreenRank = null
    const html = renderToStaticMarkup(<CandidateFunnelCard candidate={item} />)

    expect(formatCandidateMetric(null)).toBe('—')
    expect(html).toContain('<dt>市場スコア</dt><dd>—</dd>')
    expect(html).toContain('<dt>市場順位</dt><dd>—</dd>')
    expect(html).toContain('<dt>一次選別順位</dt><dd>—</dd>')
    expect(html).not.toContain('<dt>市場スコア</dt><dd>0</dd>')
  })

  it('formats data confidence as a percentage without mutating the source value', () => {
    const source = 2 / 3
    expect(formatCandidateDataConfidence(source)).toBe('66.7%')
    expect(source).toBe(2 / 3)
    expect(formatCandidateDataConfidence(null)).toBe('—')
  })

  it('does not describe unavailable theme evaluation as テーマなし', () => {
    expect(formatCandidateTheme('unavailable', [])).toBe('テーマ評価未接続')
    const html = renderToStaticMarkup(
      <CandidateFunnelCard candidate={candidate(artifact(), 'actionable')} />,
    )
    expect(html).toContain('<dd>テーマ評価未接続</dd>')
    expect(html).not.toContain('テーマなし')
  })

  it('maps known risk reason codes to display-only Japanese', () => {
    expect(formatCandidateRiskReason('SOFT_ELEVATED_VOLATILITY')).toBe('値動きが大きい可能性')
    expect(formatCandidateRiskReason('SOFT_PRESCREEN_METADATA_MISSING')).toBe('一次選別情報の一部が未取得')
  })

  it('falls back safely for an unknown risk reason without throwing or exposing the enum', () => {
    expect(() => formatCandidateRiskReason('SOFT_FUTURE_REASON')).not.toThrow()
    expect(formatCandidateRiskReason('SOFT_FUTURE_REASON')).toBe('その他のリスク要因')
    const item = candidate(artifact(), 'actionable')
    item.riskReasons = ['SOFT_FUTURE_REASON' as CandidateFunnelCandidate['riskReasons'][number]]
    const html = renderToStaticMarkup(<CandidateFunnelCard candidate={item} />)
    expect(html).toContain('その他のリスク要因')
    expect(html).not.toContain('SOFT_FUTURE_REASON')
  })

  it('labels actionable as 重点候補, never as a purchase recommendation', () => {
    expect(formatCandidateTier('actionable')).toBe('重点候補')
    const html = renderPanel(artifact(), 'fresh')
    expect(html).not.toContain('>購入推奨<')
    expect(html).toContain('次段階の検討候補')
  })
})

describe('P5-B005-B3-C disclaimer and analysis isolation', () => {
  it('always displays the market-information disclaimer and not-for-trading contract', () => {
    for (const [data, freshness] of [
      [artifact(), 'fresh'],
      [null, 'unavailable'],
      [null, 'invalid'],
    ] as const) {
      const html = renderPanel(data, freshness)
      expect(html).toContain('市場スコア・市場順位・選別段階は市場評価です。ポートフォリオ適合は保有状況との関係を別枠で表示し、両者を合算しません。')
      expect(html).toContain('売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。')
    }
  })

  it('states that the focus tier is not a purchase recommendation', () => {
    const html = renderPanel(artifact(), 'fresh')
    expect(html).toContain('重点候補は購入を推奨するものではなく')
  })

  it('contains no BUY_NEW, purchase amount, order button, or trading action', () => {
    const combinedSource = `${panelSource}\n${cardSource}`
    expect(combinedSource).not.toContain('BUY_NEW')
    expect(combinedSource).not.toContain('購入金額')
    expect(combinedSource).not.toContain('maxAmount')
    expect(combinedSource).not.toContain('officialDecision')
    expect(combinedSource).not.toContain('recommendedTrade')
  })

  it('candidate cards are non-interactive and rendering leaves officialDecision unchanged', () => {
    const before = useAppStore.getState().officialDecision
    renderToStaticMarkup(<CandidateFunnelCard candidate={candidate(artifact(), 'actionable')} />)
    expect(useAppStore.getState().officialDecision).toBe(before)
    expect(cardSource).not.toContain('onClick')
    expect(cardSource).not.toContain('useAppStore')
    expect(panelSource).not.toContain('useAppStore.setState')
  })

  it('does not fetch, call a loader, persist, refresh, poll, or change the URL', () => {
    const combinedSource = `${panelSource}\n${cardSource}`
    expect(combinedSource).not.toContain('fetch(')
    expect(combinedSource).not.toContain('loadCandidateFunnel')
    expect(combinedSource).not.toContain('localStorage')
    expect(combinedSource).not.toContain('refreshAllData')
    expect(combinedSource).not.toContain('setInterval')
    expect(combinedSource).not.toContain('URLSearchParams')
  })
})

describe('P5-B005-B3-C accessibility, keyboard, mobile, and T1 integration', () => {
  it('uses native tab buttons with aria-selected, aria-controls and one tab stop', () => {
    const html = renderPanel(artifact(), 'fresh')
    expect(html).toContain('role="tablist"')
    expect(html.match(/role="tab"/g)).toHaveLength(3)
    expect(html.match(/aria-controls="candidate-funnel-list"/g)).toHaveLength(3)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2)
  })

  it('supports Arrow, Home and End keyboard filter navigation', () => {
    expect(candidateFunnelFilterForKey('actionable', 'ArrowRight')).toBe('deep_review')
    expect(candidateFunnelFilterForKey('actionable', 'ArrowLeft')).toBe('screened')
    expect(candidateFunnelFilterForKey('screened', 'Home')).toBe('actionable')
    expect(candidateFunnelFilterForKey('actionable', 'End')).toBe('screened')
    expect(candidateFunnelFilterForKey('actionable', 'Enter')).toBeNull()
    expect(panelSource).toContain('onKeyDown={event => handleFilterKeyDown(event, option.id)}')
  })

  it('keeps 44px tap targets and focus-visible treatment', () => {
    expect(panelCssSource).toMatch(/candidate-funnel__filters button[\s\S]*?min-height:\s*44px/)
    expect(panelCssSource).toMatch(/candidate-funnel__more[\s\S]*?min-height:\s*44px/)
    expect(panelCssSource).toContain(':focus-visible')
  })

  it('is mobile-first with one-column minmax grids and no 320px/375px/430px fixed width or horizontal scroller', () => {
    expect(panelCssSource).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(panelCssSource).toContain('min-width: 0')
    expect(panelCssSource).not.toMatch(/(?:^|\n)\s*(?:min-|max-)?width:\s*(?:320|375|430)px/)
    expect(panelCssSource).not.toContain('overflow-x:')
    expect(panelCssSource).toContain('overflow-wrap: anywhere')
  })

  it('keeps long Japanese names inside the card layout', () => {
    const data = largeScreenedArtifact(1)
    const html = renderPanel(data, 'fresh', { filter: 'screened', visibleCount: 10 })
    expect(html).toContain('長い日本語銘柄名を含む一次選別テスト企業0')
    expect(panelCssSource).toMatch(/candidate-funnel-card__name[\s\S]*?overflow-wrap:\s*anywhere/)
  })

  it('adds the independent panel after the existing CandidateDecisionSection only in T1', () => {
    // CAND-SYN-1D: StockCandidateSection (legacy applyStockCandidateGates display)
    // was cut over to CandidateDecisionSection (candidateDecisionSynthesis authority).
    expect(t1Source).toContain('<CandidateDecisionSection />')
    expect(t1Source).toContain('<CandidateFunnelPanel />')
    expect(t1Source.indexOf('<CandidateFunnelPanel />'))
      .toBeGreaterThan(t1Source.indexOf('<CandidateDecisionSection />'))
    expect(t0Source).not.toContain('CandidateFunnelPanel')
  })

  it('preserves the existing T1 holding list, detail path, and candidate synthesis UI', () => {
    expect(t1Source).toContain('function StockList')
    expect(t1Source).toContain('function StockDetail')
    expect(t1Source).toContain('<CandidateDecisionSection />')
    expect(t1Source).toContain('return <StockDetail code={selectedCode}')
  })
})

describe('P5-B005-C-B3 frozen panel, card, accessibility, and mobile contract', () => {
  it('C-B3-T43 places the fit dataset after candidate state and before timestamps', () => {
    const html = renderPanel(
      artifact(),
      'stale',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated'),
    )
    expect(html.indexOf('データが古い可能性があります'))
      .toBeLessThan(html.indexOf('candidate-funnel__portfolio-fit-state'))
    expect(html.indexOf('candidate-funnel__portfolio-fit-state'))
      .toBeLessThan(html.indexOf('candidate-funnel__timestamps'))
  })

  it('C-B3-T44 keeps every exact disclaimer visible for fresh, invalid, and unavailable', () => {
    const exact = [
      '市場スコア・市場順位・選別段階は市場評価です。ポートフォリオ適合は保有状況との関係を別枠で表示し、両者を合算しません。',
      'ポートフォリオ適合はこの端末内で評価し、結果を保存・送信しません。',
      '売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。',
      'ポートフォリオ適合スコア・順位は未実装です。独自の総合点や順位は表示しません。',
      '重点候補は購入を推奨するものではなく、次段階の検討候補です。',
    ]
    for (const [freshness, fit] of [
      ['fresh', 'evaluated'],
      ['invalid', 'invalid'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const html = renderPanel(
        freshness === 'fresh' ? artifact() : null,
        freshness,
        CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
        fitPresentation(fit),
      )
      exact.forEach(copy => expect(html).toContain(copy))
    }
  })

  it('C-B3-T45 renders actionable fit after observations and before market reasons', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated'),
    )
    const article = html.match(/<article[\s\S]*?<\/article>/)?.[0] ?? ''
    expect(article.indexOf('candidate-funnel-card__observations'))
      .toBeLessThan(article.indexOf('candidate-funnel-card__portfolio-fit'))
    expect(article.indexOf('candidate-funnel-card__portfolio-fit'))
      .toBeLessThan(article.indexOf('candidate-funnel-card__reason-group'))
    expect(article).toContain('新規候補（未保有）')
  })

  it('C-B3-T46 renders deep-review partial status and gates partial numeric values', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      { filter: 'deep_review', visibleCount: 10 },
      fitPresentation('partial', [fitRecord(1, 'partial'), fitRecord(2)]),
    )
    expect(html).toContain('ポートフォリオ適合は一部のみ評価できました。')
    expect(html).toContain('一部評価')
    expect(html).not.toContain('既存ポートフォリオ内の同一コード比率 0パーセント')
  })

  it('C-B3-T47 renders no fit section for screened candidates', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      { filter: 'screened', visibleCount: 10 },
      fitPresentation('evaluated'),
    )
    expect(html).toContain('data-tier="screened"')
    expect(html).not.toContain('candidate-funnel-card__portfolio-fit')
  })

  it('C-B3-T48 renders only generic card state for invalid and unavailable fit', () => {
    for (const status of ['invalid', 'unavailable'] as const) {
      const html = renderPanel(
        artifact(),
        'fresh',
        CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
        fitPresentation(status),
      )
      expect(html).toContain(
        status === 'invalid'
          ? 'ポートフォリオ適合データを検証できませんでした。'
          : 'ポートフォリオ適合を評価できません。',
      )
      expect(html).not.toContain('新規候補（未保有）')
      expect(html).not.toContain('ポートフォリオ適合の詳細')
    }
  })

  it('C-B3-T49 renders exact missing state without substituting another F2 record', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated', [fitRecord(1)]),
    )
    expect(html).toContain('ポートフォリオ適合レコードが見つかりません。')
    expect(html).not.toContain('新規候補（未保有）')
  })

  it('C-B3-T50 keeps duplicate-code fit headings unique and self-owned', () => {
    const data = duplicateCodeArtifact()
    const second = {
      ...fitRecord(1),
      relationship: 'already_held' as const,
      relationshipText: '保有あり',
    }
    const html = renderPanel(
      data,
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated', [fitRecord(0), second]),
    )
    const articles = [...html.matchAll(
      /<article class="candidate-funnel-card" aria-labelledby="[^"]+">([\s\S]*?)<\/article>/g,
    )]
    expect(articles).toHaveLength(2)
    expect(html).toContain('新規候補（未保有）')
    expect(html).toContain('保有あり')
    const fitIds = articles.map(([, article]) => {
      const section = article.match(
        /<section class="candidate-funnel-card__portfolio-fit[^"]*" aria-labelledby="([^"]+)">[\s\S]*?<h4 id="([^"]+)">ポートフォリオ適合<\/h4>/,
      )
      expect(section).not.toBeNull()
      expect(section?.[1]).toBe(section?.[2])
      return section?.[1]
    })
    expect(new Set(fitIds).size).toBe(2)
    fitIds.forEach(id => {
      expect(html.match(new RegExp(`id="${escapeRegExp(id ?? '')}"`, 'g')))
        .toHaveLength(1)
    })
  })

  it('C-B3-T51 leaves fit evaluation ownership outside filter and show-more rendering', () => {
    const presentation = fitPresentation('evaluated')
    const before = structuredClone(presentation)
    renderPanel(artifact(), 'fresh', { filter: 'actionable', visibleCount: 10 }, presentation)
    renderPanel(artifact(), 'fresh', { filter: 'deep_review', visibleCount: 20 }, presentation)
    expect(presentation).toEqual(before)
    expect(cardSource).not.toContain('useCandidatePortfolioFit')
    expect(panelSource.match(/useCandidatePortfolioFit\(\)/g)).toHaveLength(1)
  })

  it('C-B3-T52 renders no fit total, grade, band, badge rank, or placeholder value', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated'),
    )
    expect(html).not.toMatch(/ポートフォリオ適合(?:総合点|ランク|等級|グレード)/)
    expect(html).not.toContain('portfolioFitScore')
    expect(html).not.toContain('portfolioFitRank')
  })

  it('C-B3-T53 contains no trade, amount, quantity, order payload, or sizing field', () => {
    const combinedSource = `${panelSource}\n${cardSource}`
    expect(combinedSource).not.toMatch(
      /BUY_NEW|BUY_MORE|officialDecision|maxAmount|\bamount\b|quantity|shares|recommendedTrade|sizing/,
    )
    const html = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated'),
    )
    expect(html).not.toMatch(/購入金額|注文数量|発注ボタン/)
  })

  it('C-B3-T54 assigns exact roles and visible text to invalid, partial, and warning states', () => {
    const invalid = renderPanel(
      null,
      'invalid',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('invalid'),
    )
    expect(invalid).toContain('candidate-funnel__portfolio-fit-state--invalid" role="alert"')
    const partial = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('partial'),
    )
    expect(partial).toContain('role="status" aria-live="polite"')
    expect(partial).toContain('ポートフォリオ適合に確認事項があります。')
  })

  it('C-B3-T55 renders ratio visual text and exact percentage aria-label', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated'),
    )
    expect(html).toContain(
      'aria-label="既存ポートフォリオ内の同一コード比率 25パーセント">25%',
    )
    expect(html).toContain(
      'aria-label="既存日本株内の同一セクター比率 66.7パーセント">66.7%',
    )
  })

  it('C-B3-T56 uses native details and summary without a custom keyboard handler', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('evaluated'),
    )
    expect(html).toContain('<details><summary>ポートフォリオ適合の詳細</summary>')
    expect(cardSource).not.toContain('onKeyDown')
  })

  it('C-B3-T57 preserves Arrow/Home/End behavior and a single filter tab stop', () => {
    expect(candidateFunnelFilterForKey('actionable', 'ArrowRight')).toBe('deep_review')
    expect(candidateFunnelFilterForKey('actionable', 'ArrowLeft')).toBe('screened')
    expect(candidateFunnelFilterForKey('screened', 'Home')).toBe('actionable')
    expect(candidateFunnelFilterForKey('actionable', 'End')).toBe('screened')
    const html = renderPanel(artifact(), 'fresh')
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2)
  })

  it('C-B3-T58 preserves one-column 320/375 layout, wrapping, DOM order, and no x-scroll', () => {
    expect(panelCssSource).toMatch(
      /\.candidate-funnel-card__portfolio-fit-components > div[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    )
    expect(panelCssSource).toContain('overflow-wrap: anywhere')
    expect(panelCssSource).not.toContain('overflow-x:')
    expect(panelCssSource).not.toMatch(/(?:min-|max-)?width:\s*(?:320|375)px/)
    expect(panelCssSource).not.toMatch(/^\s*order\s*:/m)
  })
})

describe('P5-B005-C-B3-R1 pending and evaluatedAt integration acceptance', () => {
  it('R1 renders the pending dataset without evaluated state or fit record details', () => {
    const html = renderPanel(
      artifact(),
      'fresh',
      CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
      fitPresentation('pending'),
    )

    expect(html).toContain(
      'candidate-funnel__portfolio-fit-state--pending" role="status" aria-live="polite"',
    )
    expect(html).toContain('ポートフォリオ適合を評価しています。')
    expect(html).not.toContain('candidate-funnel__portfolio-fit-state--evaluated')
    expect(html).not.toContain('ポートフォリオ適合を評価しました。')
    expect(html).not.toContain('新規候補（未保有）')
    expect(html).not.toContain('ポートフォリオ適合の詳細')
    expect(html).not.toContain('candidate-funnel-card__portfolio-fit-components')
  })

  it('R1 market freshness classification uses the runtime evaluatedAt boundary', () => {
    const data = artifact()
    data._meta.generatedAt = '2026-07-26T07:00:00.000Z'
    const current = useAppStore.getState()
    if (!current.system.dataTimestamps) {
      throw new Error('data timestamp fixture missing')
    }
    const state: typeof current = {
      ...current,
      candidateFunnel: data,
      system: {
        ...current.system,
        dataSourceStatus: {
          ...current.system.dataSourceStatus,
          candidateFunnel: 'loaded',
        },
        dataTimestamps: {
          ...current.system.dataTimestamps,
          candidateFunnel: data._meta.generatedAt,
        },
      },
    }
    const generatedAtMs = Date.parse(data._meta.generatedAt)
    const runtimeResult = {
      evaluatedAt: new Date(
        generatedAtMs + 48 * 60 * 60 * 1000 + 1,
      ).toISOString(),
    }

    expect(selectCandidateFunnelFreshness(
      state,
      Date.parse(runtimeResult.evaluatedAt),
    )).toBe('stale')
    expect(selectCandidateFunnelFreshness(state, generatedAtMs + 1)).toBe('fresh')
  })

  it('R1 panel passes portfolio-fit evaluatedAt to freshness and owns no clock', () => {
    const sourceFile = ts.createSourceFile(
      'CandidateFunnelPanel.tsx',
      panelSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const selectorArguments: string[] = []
    const evaluatedAtInitializers: string[] = []
    const forbiddenClocks: string[] = []

    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'evaluatedAtMs' &&
        node.initializer
      ) {
        evaluatedAtInitializers.push(node.initializer.getText(sourceFile))
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'selectCandidateFunnelFreshness'
      ) {
        selectorArguments.push(node.arguments[1]?.getText(sourceFile) ?? '')
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.name.text === 'now' &&
        ['Date', 'performance'].includes(node.expression.expression.text)
      ) {
        forbiddenClocks.push(node.getText(sourceFile))
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Date' &&
        (node.arguments?.length ?? 0) === 0
      ) {
        forbiddenClocks.push(node.getText(sourceFile))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    expect(evaluatedAtInitializers).toHaveLength(1)
    expect(evaluatedAtInitializers[0]).toContain(
      'portfolioFitRuntime.result.evaluatedAt',
    )
    expect(selectorArguments).toEqual(['evaluatedAtMs'])
    expect(forbiddenClocks).toEqual([])
  })

  it('R2 actual panel filter, show-more, and unrelated rerender add no fit lifecycle cycle', async () => {
    const originalStoreState = useAppStore.getState()
    const data = largeScreenedArtifact(21)
    const testDocument = new CandidateFunnelTestDocument()
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
    const globalDescriptors = new Map(
      ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map(name => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    )
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: testWindow },
      document: { configurable: true, value: testDocument },
      navigator: { configurable: true, value: { userAgent: 'vitest' } },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    })
    useAppStore.setState({
      ...originalStoreState,
      candidateFunnel: data,
      system: {
        ...originalStoreState.system,
        dataSourceStatus: {
          ...originalStoreState.system.dataSourceStatus,
          candidateFunnel: 'loaded',
        },
        dataTimestamps: {
          ...originalStoreState.system.dataTimestamps!,
          candidateFunnel: data._meta.generatedAt,
        },
      },
    }, true)

    const clock = vi.spyOn(Date, 'now').mockReturnValue(
      Date.parse(data._meta.generatedAt) + 60 * 60 * 1000,
    )
    const restore = vi.spyOn(persist, 'restoreCsvImportGeneration')
      .mockReturnValue({ status: 'none' })
    const selector = vi.spyOn(
      portfolioFitSelectors,
      'selectCandidatePortfolioFit',
    )
    const container = testDocument.createElement('div')
    const { createRoot } = await import('react-dom/client')
    const root = createRoot(container as unknown as Element)

    try {
      await act(async () => root.render(<CandidateFunnelPanel />))
      const fitState = () => findCandidateFunnelNodes(
        container,
        node => node.attributes.class?.includes(
          'candidate-funnel__portfolio-fit-state',
        ) ?? false,
      )[0]?.textContent ?? ''
      const cardCount = () => findCandidateFunnelNodes(
        container,
        node => node.attributes.class === 'candidate-funnel-card',
      ).length
      const initialFitResult = fitState()

      expect(initialFitResult).toContain('ポートフォリオ適合を評価しました。')
      expect(cardCount()).toBe(0)
      expect(clock).toHaveBeenCalledTimes(1)
      expect(restore).toHaveBeenCalledTimes(1)
      expect(selector).toHaveBeenCalledTimes(1)

      const screenedButton = findCandidateFunnelNodes(
        container,
        node => node.nodeName === 'BUTTON' && node.textContent.includes('一次選別'),
      )[0]
      await act(async () => {
        const onClick = reactNodeProps(screenedButton).onClick as () => void
        onClick()
      })
      expect(cardCount()).toBe(10)

      const showMoreButton = findCandidateFunnelNodes(
        container,
        node => node.nodeName === 'BUTTON' && node.textContent.includes('さらに表示'),
      )[0]
      await act(async () => {
        const onClick = reactNodeProps(showMoreButton).onClick as () => void
        onClick()
      })
      expect(cardCount()).toBe(20)

      await act(async () => root.render(<CandidateFunnelPanel />))
      expect(cardCount()).toBe(20)
      expect(fitState()).toBe(initialFitResult)
      expect(clock).toHaveBeenCalledTimes(1)
      expect(restore).toHaveBeenCalledTimes(1)
      expect(selector).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => root.unmount())
      useAppStore.setState(originalStoreState, true)
      clock.mockRestore()
      restore.mockRestore()
      selector.mockRestore()
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(globalThis, name)
        } else {
          Object.defineProperty(globalThis, name, descriptor)
        }
      }
    }
  })
})
