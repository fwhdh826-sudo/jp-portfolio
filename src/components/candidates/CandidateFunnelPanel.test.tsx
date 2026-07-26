import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// @ts-expect-error -- repositoryは@types/node非依存だがVitestのNode runtimeでのみ使用する
import { readFileSync } from 'node:fs'
import type { CandidateFunnelCandidate } from '../../types/candidateFunnel'
import type { CandidateFunnelArtifact } from '../../types/candidateFunnelArtifact'
import { buildValidCandidateFunnelArtifact } from '../../services/candidateFunnelArtifact.fixtures'
import { useAppStore } from '../../store/useAppStore'
import {
  CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
  CANDIDATE_FUNNEL_INITIAL_VISIBLE_COUNT,
  CandidateFunnelPanelView,
  candidateFunnelFilterForKey,
  candidateFunnelViewReducer,
  formatCandidateFunnelJstTimestamp,
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
): string {
  return renderToStaticMarkup(
    <CandidateFunnelPanelView
      artifact={data}
      freshness={freshness}
      viewState={viewState}
      onAction={() => {}}
    />,
  )
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
    expect(html).toContain('candidate-funnel-card-1003')
    expect(html).not.toContain('candidate-funnel-card-1001')
    expect(html).not.toContain('candidate-funnel-card-1002')
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
    expect(html).toContain('candidate-funnel-card-1002')
    expect(html).not.toContain('candidate-funnel-card-1003')
    expect(html).toContain('aria-labelledby="candidate-funnel-tab-deep_review"')
  })

  it('switches the view model to screened', () => {
    const html = renderPanel(artifact(), 'fresh', { filter: 'screened', visibleCount: 10 })
    expect(html).toContain('candidate-funnel-card-1001')
    expect(html).not.toContain('candidate-funnel-card-1003')
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
    expect(html).not.toContain('candidate-funnel-card-1003')
  })

  it('uses candidate.code as the React key and does not create an alternate duplicate list', () => {
    expect(panelSource).toContain('<CandidateFunnelCard key={candidate.code} candidate={candidate} />')
    expect(panelSource.match(/visibleCandidates\.map/g)).toHaveLength(1)
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
    expect(html).not.toContain('candidate-funnel-card-1003')
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
    expect(html).not.toContain('candidate-funnel-card-1003')
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
    expect(html).toContain('candidate-funnel-card-1003')
  })

  it('generalizes degraded provenance and says not to use it for current purchase decisions', () => {
    const data = artifact()
    data._meta.pipelinePath = 'cache_fallback'
    const html = renderPanel(data, 'degraded')
    expect(html).toContain('代替データ経路を使用しています')
    expect(html).toContain('現在の購入判断には使用しないでください')
    expect(html).not.toContain('cache_fallback')
    expect(html).not.toContain('seed_fallback')
    expect(html).toContain('candidate-funnel-card-1003')
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
    expect(panelSource).toContain('selectCandidateFunnelFreshness(state, Date.now())')
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
      expect(html).toContain('市場公開情報による一次評価です。保有状況・資金余力・購入判断は未反映です。')
      expect(html).toContain('売買利用不可（not_for_trading）')
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
    expect(combinedSource).not.toContain('portfolioFit')
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

  it('adds the independent panel after the existing StockCandidateSection only in T1', () => {
    expect(t1Source).toContain('<StockCandidateSection />')
    expect(t1Source).toContain('<CandidateFunnelPanel />')
    expect(t1Source.indexOf('<CandidateFunnelPanel />'))
      .toBeGreaterThan(t1Source.indexOf('<StockCandidateSection />'))
    expect(t0Source).not.toContain('CandidateFunnelPanel')
  })

  it('preserves the existing T1 holding list, detail path, and existing candidate UI', () => {
    expect(t1Source).toContain('function StockList')
    expect(t1Source).toContain('function StockDetail')
    expect(t1Source).toContain('<StockCandidateSection />')
    expect(t1Source).toContain('return <StockDetail code={selectedCode}')
  })
})
