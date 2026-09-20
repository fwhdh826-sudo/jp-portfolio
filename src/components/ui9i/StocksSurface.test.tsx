// UI-9I Phase 2B-1: 個別株面（一覧 / 詳細）の render 契約。
// 実際の onClick 経由の到達性・見出し構造・色に依存しない状態表示・機能保存（旧 T1 の各領域が表示される）を検証する。
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  assembleStockDetail,
  assembleStocksList,
  type DecisionContext,
  type StockDetailViewModel,
  type StocksListViewModel,
} from '../../presentation/ui9i/stocksPresentation'
import {
  FIXTURE_NOW_MS,
  fixtureDecision,
  fixtureExecutableDecision,
  fixtureReviewWatchList,
  fixtureStockHoldings,
  fixtureSynthesis,
} from '../../presentation/ui9i/ui9i.fixtures'
import { StockDetailView, StocksListView } from './StocksViews'

const ctx = (o: Partial<DecisionContext> = {}): DecisionContext =>
  ({ officialDecision: fixtureDecision(), dqSuppressed: false, capExceeded: false, safeModeActive: false, now: new Date(FIXTURE_NOW_MS), ...o })

function listVm(o: { context?: Partial<DecisionContext>; holdings?: ReturnType<typeof fixtureStockHoldings>['holdings']; synthesis?: null; holdingsStale?: boolean; heroState?: 'normal' | 'safe_mode' } = {}): StocksListViewModel {
  const { holdings, analysis } = fixtureStockHoldings()
  return assembleStocksList({
    holdings: o.holdings ?? holdings, analysis, decisionContext: ctx(o.context),
    analysisLastRunAt: '2026-10-06T08:30:00+09:00', dqReason: null, holdingsStale: o.holdingsStale ?? false, portfolioStale: false,
    synthesis: o.synthesis === null ? null : fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList().slice(1)),
    rawCandidates: [], rawFunnelAvailable: true, heroState: o.heroState ?? 'normal',
  })
}

function detailVm(code: string, o: { context?: Partial<DecisionContext>; heroState?: 'normal' | 'safe_mode' } = {}): StockDetailViewModel {
  const { holdings, analysis } = fixtureStockHoldings()
  return assembleStockDetail({
    code, holdings, analysis, stockScores6Axis: null, decisionContext: ctx(o.context),
    analysisLastRunAt: '2026-10-06T08:30:00+09:00', holdingsStale: false,
    synthesis: fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList().slice(1)),
    rawCandidates: [], heroState: o.heroState ?? 'normal',
  })
}

/** 関数コンポーネントを展開しながら要素木を辿り、条件に合う host 要素を集める（クリック配線の検証用。view は hook を持たない）。 */
function collect(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) { node.forEach(n => collect(n, pred, out)); return out }
  if (!isValidElement(node)) return out
  const el = node as ReactElement<Record<string, unknown>>
  if (pred(el)) out.push(el)
  if (typeof el.type === 'function') {
    collect((el.type as (p: unknown) => ReactNode)(el.props), pred, out)
  } else {
    collect(el.props.children as ReactNode, pred, out)
  }
  return out
}

const headings = (html: string) => [...html.matchAll(/<h([1-6])[ >][^]*?<\/h\1>/g)].map(m => ({ level: +m[1], text: m[0].replace(/<[^>]+>/g, '') }))

describe('個別株一覧', () => {
  const vm = listVm()
  const html = renderToStaticMarkup(<StocksListView vm={vm} onSelect={() => {}} />)

  it('表示ラベルは「個別株」。内部 T 番号を露出しない', () => {
    expect(html).toContain('<h1 class="u9-surface__title">個別株</h1>')
    expect(html).not.toMatch(/\bT[0-9]\b/)
  })

  it('銘柄選択 → 詳細（実際の onClick）: 各行は button[type=button] で、その銘柄コードで onSelect を呼ぶ', () => {
    const onSelect = vi.fn()
    const rows = collect(<StocksListView vm={vm} onSelect={onSelect} />, el => el.type === 'button' && typeof el.props['data-code'] === 'string')
    expect(rows.map(r => r.props['data-code'])).toEqual(vm.rows.map(r => r.code))
    for (const r of rows) {
      expect(r.props.type).toBe('button')
      ;(r.props.onClick as () => void)()
    }
    expect(onSelect.mock.calls.map(c => c[0])).toEqual(vm.rows.map(r => r.code))
  })

  it('行: コード / 名称 / 保有 / 判断語 / 損益（符号は文字）。判断の enum は data-decision に保持', () => {
    expect(html).toContain('data-code="9697" data-decision="BUY"')
    expect(html).toContain('data-code="8306" data-decision="INSUFFICIENT_EVIDENCE"')
    expect(html).toContain('>カプコン<')
    expect(html.match(/data-rel="already_held">保有</g)?.length).toBeGreaterThanOrEqual(4)
    expect(html).toContain('>買い</span>')
    expect(html).toContain('>判断材料不足</span>')
    expect(html).toContain('+8.40%')
    expect(html).toContain('-12.40%') // 損失は色ではなく符号で示す
  })

  it('ロック / 含み損警戒は文字のタグで示す（色だけに依存しない）', () => {
    expect(html).toContain('data-kind="lock">ロック</span>')
    const withLoss = renderToStaticMarkup(
      <StocksListView vm={listVm({ holdings: fixtureStockHoldings().holdings.map(h => (h.code === '8035' ? { ...h, pnlPct: -41 } : h)) })} onSelect={() => {}} />,
    )
    expect(withLoss).toContain('data-kind="warn">含み損警戒</span>')
  })

  it('判断材料不足の銘柄は局所表示: 総合スコアを出さず、他の行・通知に波及しない', () => {
    const row = html.slice(html.indexOf('data-code="8306"'), html.indexOf('</li>', html.indexOf('data-code="8306"')))
    expect(row).not.toContain('総合スコア')
    expect(html).not.toContain('data-notice=')
    expect(html.match(/総合スコア \d+/g)).toHaveLength(3)
  })

  it('SAFE_MODE: 同じ銘柄が「待機」になり、SAFE_MODE の通知が出る。分析（総合スコア）は消えない', () => {
    const safe = renderToStaticMarkup(<StocksListView vm={listVm({ context: { safeModeActive: true }, heroState: 'safe_mode' })} onSelect={() => {}} />)
    expect(safe).toContain('data-code="9697" data-decision="WAIT"')
    expect(safe).toContain('data-notice="safe_mode"')
    expect(safe).toContain('総合スコア 78')
    expect(safe).not.toContain('data-kind="executable"') // 実行可能な候補行を出さない
    expect(safe).toContain('SAFE_MODE 中のため実行できません（分析・レビューは有効です）')
  })

  it('保有銘柄なし / 候補なし・利用不可の各状態が成立する（利用不可を 0 にしない）', () => {
    const empty = renderToStaticMarkup(<StocksListView vm={listVm({ holdings: [], synthesis: null })} onSelect={() => {}} />)
    expect(empty).toContain('保有銘柄なし')
    expect(empty).toContain('data-testid="stocks-candidates-unavailable"')
    expect(empty).not.toContain('data-testid="stocks-compare"')
    expect(empty).not.toContain('¥0')
  })

  it('保有データが古い場合は注記のみ。判断（data-decision）は変えない', () => {
    const stale = renderToStaticMarkup(<StocksListView vm={listVm({ holdingsStale: true })} onSelect={() => {}} />)
    expect(stale).toContain('data-notice="holdings_stale"')
    expect(stale.match(/data-decision="[A-Z_]+"/g)).toEqual(html.match(/data-decision="[A-Z_]+"/g))
  })

  it('見出し: h1 → h2（保有銘柄 / 銘柄の比較 / 候補）。レベルを飛ばさない', () => {
    const hs = headings(html)
    expect(hs.map(h => h.level)).toEqual([1, 2, 2, 2])
    expect(hs.map(h => h.text)).toEqual(['個別株', '保有銘柄', '銘柄の比較', '候補（AllocationPlan認可）'])
  })

  it('候補: 実行可能額は entry.money の値。関係（保有 / 新規）と状態語が分かれて表示される', () => {
    expect(html).toContain('data-testid="stock-candidate-amount">¥400,000<')
    expect(html).toContain('data-rel="new_to_portfolio">新規<')
    expect(html).toContain('市場スコア')
  })
})

describe('個別株詳細', () => {
  const vm = detailVm('6098')
  const html = renderToStaticMarkup(<StockDetailView vm={vm} onBack={() => {}} />)

  it('戻る（実際の onClick）: 44px 操作対象・アクセシブル名あり・一覧へ戻る', () => {
    const onBack = vi.fn()
    const back = collect(<StockDetailView vm={vm} onBack={onBack} />, el => el.type === 'button' && el.props['aria-label'] === '個別株一覧に戻る')
    expect(back).toHaveLength(1)
    ;(back[0].props.onClick as () => void)()
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(html).toContain('class="u9-stk-back"')
  })

  it('見出し: h1（銘柄名）→ h2（各カード）→ h3（サブ見出し）。レベルを飛ばさず、h1 は 1 件', () => {
    const hs = headings(html)
    expect(hs.filter(h => h.level === 1)).toHaveLength(1)
    expect(hs[0]).toEqual({ level: 1, text: 'リクルートホールディングス' })
    for (let i = 1; i < hs.length; i++) expect(hs[i].level - hs[i - 1].level, `${hs[i - 1].text} → ${hs[i].text}`).toBeLessThanOrEqual(1)
    expect(hs.filter(h => h.level === 2).map(h => h.text)).toEqual(expect.arrayContaining([
      '現在の判断', '判断の理由', '保有状況', '実行条件', 'ポートフォリオ上の位置づけ', '候補との関係', '根拠と鮮度', '補助分析',
    ]))
  })

  it('判断と補助分析が分離される: 「現在の判断」が先、補助分析は後ろ。補助分析は最終判断ではない旨を明示', () => {
    expect(html.indexOf('data-testid="stock-decision-card"')).toBeLessThan(html.indexOf('data-testid="stock-analysis"'))
    expect(html).toContain('最終の判断は上の「現在の判断」で、注文指示ではありません')
    expect(html).toContain('data-testid="stock-decision">保有継続</span>')
  })

  it('旧 T1 の機能領域がすべて残る（レーダー / 8軸 / 根拠 / 主要指標 / ファンダ / テクニカル / 実行条件 / PF 位置づけ）', () => {
    for (const id of ['stock-radar', 'stock-axis-reasons', 'stock-key-metrics', 'stock-fundamentals', 'stock-technicals', 'stock-execution', 'stock-portfolio-standing', 'stock-position', 'stock-evidence']) {
      expect(html, id).toContain(`data-testid="${id}"`)
    }
    expect(html).toContain('割安度')
    expect(html).toContain('リスクゲート')
    expect(html).toContain('通過 — 実行可')
    expect(html).toContain('目標株価')
    expect(html).toContain('損切ライン（アラート）')
    expect(html).toContain('前提崩れ条件')
    expect(html).toContain('calculation-only / not an order')
    expect(html).toContain('UI only / not an order')
  })

  it('補助分析の各群は開閉（details/summary）。summary は 44px の操作対象、見出しを内包する', () => {
    expect(html.match(/<details/g)!.length).toBeGreaterThanOrEqual(5)
    expect(html).toContain('<summary class="u9-disclose__summary"><h3 class="u9-disclose__title">8軸レーダー</h3></summary>')
  })

  it('候補との関係: 既保有の候補は「保有」で表示（Home と同じ射影）', () => {
    const cand = html.slice(html.indexOf('data-testid="stock-candidate-link"'))
    expect(cand).toContain('data-rel="already_held">保有<')
  })

  it('判断材料不足（8306）: 局所の制約として説明し、不足項目・参考表示の注記を示す。全体状態にならない', () => {
    const insufficient = renderToStaticMarkup(<StockDetailView vm={detailVm('8306')} onBack={() => {}} />)
    expect(insufficient).toContain('data-decision="INSUFFICIENT_EVIDENCE"')
    expect(insufficient).toContain('>判断材料不足</span>')
    expect(insufficient).toContain('data-constraint="insufficient"')
    expect(insufficient).toContain('取得できていない項目があるため、以下の分析値は参考表示です')
    expect(insufficient).not.toContain('SAFE_MODE')
    expect(insufficient).not.toContain('data-constraint="data_quality"')
    expect(insufficient).not.toContain('総合スコア')
  })

  it('SAFE_MODE の影響を受ける銘柄（9697 BUY）: 待機 + SAFE_MODE の制約。売却ロックは別枠で残る。分析は消えない', () => {
    const safe = renderToStaticMarkup(<StockDetailView vm={detailVm('9697', { context: { safeModeActive: true }, heroState: 'safe_mode' })} onBack={() => {}} />)
    expect(safe).toContain('data-decision="WAIT"')
    expect(safe).toContain('data-constraint="safe_mode"')
    expect(safe).toContain('data-testid="stock-sell-lock"')
    expect(safe).toContain('売却可能予定日: 2026-10-20')
    expect(safe).toContain('data-testid="stock-radar"')
    expect(safe).toContain('分析・レビューは有効')
  })

  it('DATA_WAIT: 「更新待ち」（局所の銘柄判断としてのみ）', () => {
    const wait = renderToStaticMarkup(<StockDetailView vm={detailVm('9697', { context: { dqSuppressed: true } })} onBack={() => {}} />)
    expect(wait).toContain('data-decision="DATA_WAIT"')
    expect(wait).toContain('>更新待ち</span>')
  })

  it('分析結果が無い銘柄: 補助分析は「分析結果がまだありません」（既定値 50 の軸を作らない）。リスクゲートは利用不可', () => {
    const { holdings } = fixtureStockHoldings()
    const vm2 = assembleStockDetail({
      code: '6098', holdings, analysis: [], stockScores6Axis: null, decisionContext: ctx(),
      analysisLastRunAt: null, holdingsStale: false, synthesis: null, rawCandidates: [], heroState: 'normal',
    })
    const out = renderToStaticMarkup(<StockDetailView vm={vm2} onBack={() => {}} />)
    expect(out).toContain('data-testid="stock-analysis-unavailable"')
    expect(out).not.toContain('data-testid="stock-radar"')
    expect(out).toContain('利用不可')
    expect(out).not.toContain('非通過')
  })

  it('銘柄が見つからない: 「銘柄データなし」+ 戻る導線', () => {
    const onBack = vi.fn()
    const nf = <StockDetailView vm={{ found: false, code: '0000' }} onBack={onBack} />
    expect(renderToStaticMarkup(nf)).toContain('銘柄データなし')
    const back = collect(nf, el => el.type === 'button' && el.props['aria-label'] === '個別株一覧に戻る')
    ;(back[0].props.onClick as () => void)()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('装飾（記号・レーダー SVG）は aria-hidden。状態は文字で読める', () => {
    expect(html).toContain('<svg viewBox="0 0 260 268" class="u9-radar__svg" aria-hidden="true">')
    // すべての button はアクセシブル名（aria-label か可視テキスト）を持つ。
    for (const m of html.matchAll(/<button([^>]*)>([^]*?)<\/button>/g)) {
      const visible = m[2].replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').trim()
      expect(/aria-label="[^"]+"/.test(m[1]) || visible.length > 0, m[0]).toBe(true)
    }
  })
})

describe('Phase 7 軸別スコア（calculation-only）', () => {
  it('stockScores6Axis があれば補助分析に軸別スコアを出す（決定・順序へ影響しない）', () => {
    const { holdings, analysis } = fixtureStockHoldings()
    const axis = (total: number) => ({ total, rating: 'B', components: {} }) as never
    const record = {
      ticker: '6098',
      six_axis: { value: axis(60), quality: axis(70), growth: axis(55), safety: axis(65), momentum: axis(50), shareholder_return: axis(72) },
      dynamic_total: { total: 64, rating: 'B', regime_used: 'bull_calm' },
    } as never
    const vm = assembleStockDetail({
      code: '6098', holdings, analysis, stockScores6Axis: [record], decisionContext: ctx(), analysisLastRunAt: null,
      holdingsStale: false, synthesis: null, rawCandidates: [], heroState: 'normal',
    })
    const out = renderToStaticMarkup(<StockDetailView vm={vm} onBack={() => {}} />)
    expect(out).toContain('data-testid="stock-phase7"')
    expect(out).toContain('総合スコア 64（B）')
    expect(out).toContain('レジーム: 強気・低ボラ')
  })
})
