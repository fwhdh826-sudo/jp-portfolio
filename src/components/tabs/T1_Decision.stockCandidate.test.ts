// CAND-SYN-1D: T1の候補判断セクションが使う表示専用の純関数（formatStockMetric）の回帰guard、
// および T1 が candidateDecisionSynthesis の canonical order（再ソート禁止・D13）のまま
// 描画することの構成guard。
// Phase 2B-1: 候補は presentation（projectStockCandidates）→ view（CandidatesCard）へ移設された。
// 構成の source pin は移設先へ張り替え、順序・再ソート禁止は実際の投影結果で検証する。
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatStockMetric } from './T1_Decision'
import { projectStockCandidates } from '../../presentation/ui9i/stocksPresentation'
import { fixtureEntry, fixtureSynthesis } from '../../presentation/ui9i/ui9i.fixtures'
import { StocksListView } from '../ui9i/StocksViews'
// @ts-expect-error -- repository intentionally has no @types/node
import { readFileSync } from 'node:fs'

const t1Container = readFileSync(new URL('./T1_Decision.tsx', import.meta.url), 'utf8')
const viewsSource = readFileSync(new URL('../ui9i/StocksViews.tsx', import.meta.url), 'utf8')
const presentationSource = readFileSync(new URL('../../presentation/ui9i/stocksPresentation.ts', import.meta.url), 'utf8')
const panelSource = readFileSync(
  new URL('../candidates/CandidateFunnelPanel.tsx', import.meta.url),
  'utf8',
)

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  expect(start, from).toBeGreaterThanOrEqual(0)
  return source.slice(start, source.indexOf(to, start))
}
/** 候補の投影コード（projectCandidateEntry〜assembleStocksList の直前）。 */
const candidateProjection = sliceBetween(presentationSource, 'function projectCandidateEntry', 'export function assembleStocksList')

describe('formatStockMetric', () => {
  it('nullのとき「—」を返す', () => {
    expect(formatStockMetric(null)).toBe('—')
  })

  it('undefinedのとき「—」を返す', () => {
    expect(formatStockMetric(undefined)).toBe('—')
  })

  it('数値をそのまま文字列化する', () => {
    expect(formatStockMetric(9.9)).toBe('9.9')
  })

  it('suffixを付与できる', () => {
    expect(formatStockMetric(10.23, '%')).toBe('10.23%')
  })

  it('0はnullとして扱わず「0」を表示する', () => {
    expect(formatStockMetric(0)).toBe('0')
  })
})

describe('CAND-SYN-1D frozen T1 composition protection', () => {
  const noopSelect = () => {}
  const baseVm = {
    rows: [], countLabel: '0 銘柄 — 買い 0 / ロック 0', analysisTimeLabel: null, notices: [], candidateNotice: null,
  } as const

  it('D13/T61 keeps the candidate card immediately before the funnel panel slot', () => {
    // 部品としての順序（candidates card → funnelSlot）は view の構成、
    // funnel パネルの差し込みは container の責務。
    const compositionRegion = sliceBetween(viewsSource, '<CandidatesCard', '</StocksFrame>')
    expect(compositionRegion.replace(/\s+/g, ' ')).toMatch(/<CandidatesCard [^>]*\/> \{funnelSlot\}/)
    expect(t1Container).toContain('funnelSlot={<CandidateFunnelPanel />}')

    const html = renderToStaticMarkup(
      createElement(StocksListView, {
        vm: { ...baseVm, candidates: projectStockCandidates({ synthesis: null, rawCandidates: [], rawFunnelAvailable: false, heroState: 'normal' }) },
        onSelect: noopSelect,
        funnelSlot: createElement('div', { 'data-testid': 'funnel-slot' }),
      }),
    )
    expect(html.indexOf('data-testid="stocks-candidates"')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('data-testid="funnel-slot"')).toBeGreaterThan(html.indexOf('data-testid="stocks-candidates"'))
  })

  it('D13/T62 preserves the holding list / detail views and their container wiring (unrelated to candidate synthesis)', () => {
    expect(t1Container).toContain('function StocksList')
    expect(t1Container).toContain('function StockDetail')
    expect(t1Container).toContain('<StocksListView')
    expect(t1Container).toContain('<StockDetailView')
    expect(panelSource).not.toContain('.reverse()')
    expect(panelSource).toContain('return leftRank - rightRank || left.artifactIndex - right.artifactIndex')
  })

  it('D13/T63 no second ranking: legacy stockCandidates score-sort helper is retired', () => {
    for (const src of [t1Container, viewsSource, presentationSource]) {
      expect(src).not.toContain('sortStockCandidatesForDisplay')
      expect(src).not.toContain('STOCK_ACTION_ORDER')
    }
  })

  it('D13/T64 candidates render synthesis.decisions before synthesis.watchList, concatenated only (no re-sort by score)', () => {
    // 市場スコアが昇順 / 降順どちらにも並ばない canonical 順で、投影が順序を変えないことを確認する。
    const decisions = [fixtureEntry('1001', { candidateQuality: { marketScore: 40 } })]
    const watch = [
      fixtureEntry('2002', { candidateQuality: { marketScore: 95 } }),
      fixtureEntry('3003', { candidateQuality: { marketScore: 10 } }),
      fixtureEntry('4004', { candidateQuality: { marketScore: 60 } }),
    ]
    const section = projectStockCandidates({ synthesis: fixtureSynthesis(decisions, watch), rawCandidates: [], rawFunnelAvailable: true, heroState: 'normal' })
    expect(section.status).toBe('available')
    if (section.status !== 'available') return
    expect(section.rows.map(r => r.code)).toEqual(['1001', '2002', '3003', '4004'])
    expect(candidateProjection).not.toMatch(/\.sort\(/)
    expect(viewsSource).not.toMatch(/\.sort\(/)
  })

  it('D13/T65 no legacy money field (maxAmount/検討上限) appears in the candidate section', () => {
    for (const src of [candidateProjection, viewsSource]) {
      expect(src).not.toContain('maxAmount')
      expect(src).not.toContain('検討上限')
    }
  })

  // P5-B005-B3-C-V2-R1 P3: synthesis entry card の候補スコア label を raw funnel と
  // 揃える（「スコア」→「市場スコア」）。
  it('R1-P3 synthesis entry card labels the candidate score as 市場スコア (matches raw funnel card)', () => {
    expect(viewsSource).toContain('市場スコア {row.marketScore.toFixed(1)}')
    expect(viewsSource).not.toMatch(/\bスコア \{row\.marketScore/)
    const html = renderToStaticMarkup(
      createElement(StocksListView, {
        vm: { ...baseVm, candidates: projectStockCandidates({ synthesis: fixtureSynthesis([], [fixtureEntry('5005', { candidateQuality: { marketScore: 81 } })]), rawCandidates: [], rawFunnelAvailable: true, heroState: 'normal' }) },
        onSelect: noopSelect,
      }),
    )
    expect(html).toContain('市場スコア 81.0')
  })

  // P5-B005-B3-C-V2-R1 FIX F: raw funnel available + synthesis pending の文言分離。
  it('R1-F candidate section distinguishes raw funnel availability from synthesis linkage wait', () => {
    const unavailable = (rawFunnelAvailable: boolean, synthesis = null as ReturnType<typeof fixtureSynthesis> | null) =>
      projectStockCandidates({ synthesis, rawCandidates: [], rawFunnelAvailable, heroState: 'normal' })
    expect(unavailable(true)).toMatchObject({ status: 'unavailable', message: 'ポートフォリオ連携結果を更新中です', detail: '市場候補ファネルは下に表示しています' })
    expect(unavailable(false)).toMatchObject({ status: 'unavailable', message: '候補データ更新待ちです', detail: '次回のデータ更新後に表示されます' })
    expect(unavailable(true, fixtureSynthesis([], [], 'invalid'))).toMatchObject({ message: '候補データの再計算が必要です' })
    expect(presentationSource).toContain('isCandidateFunnelRawAvailable')
  })
})
