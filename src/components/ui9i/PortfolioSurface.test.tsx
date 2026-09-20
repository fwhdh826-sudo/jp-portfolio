// UI-9I Phase 2A: PF 面 / 投信ハブ / その他ハブの render 契約。
// canonical 順・スコープされた利用不可・現金の分離・ハブの到達性（実際の onClick 経由）。
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { assembleOtherHub, projectFundsHub } from '../../presentation/ui9i/hubPresentation'
import type { NavTarget } from '../../presentation/ui9i/navigation'
import type { PortfolioSurfaceViewModel } from '../../presentation/ui9i/portfolioSurface'
import { projectPortfolio } from '../../presentation/ui9i/portfolioPresentation'
import { UNAVAILABLE_ALLOCATION, fixtureAllocation, fixtureClasses } from '../../presentation/ui9i/ui9i.fixtures'
import { applyNavTarget } from './useGoTo'
import { donutGradient } from './PortfolioParts'
import { FundsHubView, OtherHubView, PortfolioSurfaceView } from './HubSurfaces'

const available: PortfolioSurfaceViewModel = {
  portfolio: projectPortfolio(fixtureAllocation()),
  snapshotLabel: '10/6 8:30',
  grossCash: { kind: 'known', amountJpy: 2_660_000 },
  deployableCash: { kind: 'available', amountJpy: 1_200_000 },
}

const unavailable: PortfolioSurfaceViewModel = {
  portfolio: projectPortfolio(UNAVAILABLE_ALLOCATION), snapshotLabel: null,
  grossCash: { kind: 'unknown' }, deployableCash: { kind: 'unavailable' },
}

const LABELS = ['国内個別株', '国内投信', '海外投信', '金', '現金', '現金リザーブ']
const noop = () => {}

/** 関数コンポーネントを展開しながら要素木を辿り、指定条件の host 要素を集める（クリック配線の検証用）。 */
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
const hubButtons = (view: ReactElement) => collect(view, el => el.type === 'button' && typeof el.props['data-hub-link'] === 'string')

function positionsIn(html: string, labels: string[], attr: string): number[] {
  return labels.map(l => html.indexOf(`${attr}${l}<`))
}

describe('PF 面（Portfolio）', () => {
  const html = renderToStaticMarkup(<PortfolioSurfaceView vm={available} onNavigate={noop} />)

  it('6 クラスを canonical 順で全件表示（目標との差 / 凡例。UI 側で並べ替え・要約・間引きをしない）', () => {
    const gaps = html.slice(html.indexOf('data-testid="portfolio-gaps"'), html.indexOf('data-testid="portfolio-cash"'))
    const gapPos = positionsIn(gaps, LABELS, 'u9-gap__label">')
    expect(gapPos.every(p => p >= 0)).toBe(true)
    expect([...gapPos].sort((a, b) => a - b)).toEqual(gapPos)
    const legend = html.slice(html.indexOf('u9-legend'), html.indexOf('data-testid="portfolio-gaps"'))
    const legendPos = positionsIn(legend, LABELS, 'u9-legend__label">')
    expect(legendPos.every(p => p >= 0)).toBe(true)
    expect([...legendPos].sort((a, b) => a - b)).toEqual(legendPos)
    // 「目標水準は 1 行にまとめる」要約は PF 面では使わない（6 クラス全件）
    expect(html).not.toContain('u9-at-target')
    expect((html.match(/class="u9-gap"/g) ?? []).length).toBe(6)
  })

  it('入力の並びが canonical 順でなければ、その順のまま出す（gap の大小で並べ替えない）', () => {
    const shuffled = [...fixtureClasses()].sort((a, b) => (b.targetGap + b.overweightAmount) - (a.targetGap + a.overweightAmount))
    const vm: PortfolioSurfaceViewModel = { ...available, portfolio: projectPortfolio(fixtureAllocation({ classes: shuffled })) }
    const out = renderToStaticMarkup(<PortfolioSurfaceView vm={vm} onNavigate={noop} />)
    const order = [...out.matchAll(/class="u9-gap__label">([^<]+)</g)].map(m => m[1])
    expect(order).toEqual(shuffled.map(c => ({ JP_STOCK: '国内個別株', JP_TRUST: '国内投信', OVERSEAS_TRUST: '海外投信', GOLD: '金', CASH: '現金', CASH_RESERVE: '現金リザーブ' }[c.assetClass])))
  })

  it('総資産カード: 大きな数字 + 単位、配分スナップショット時刻', () => {
    expect(html).toMatch(/data-testid="portfolio-total-value">3,800</)
    expect(html).toContain('u9-pf-total__unit">万円<')
    expect(html).toContain('配分スナップショット 10/6 8:30')
    expect(html).toContain('配分 10/6 8:30') // デスクトップのヘッダー右端
  })

  it('ドーナツ=構成: 現在額のみを読む（凡例は canonical currentAmount、目標・gap は使わない）', () => {
    expect(html).toMatch(/aria-label="資産構成 国内個別株 1,330万円、国内投信 760万円、海外投信 950万円、金 380万円、現金 266万円、現金リザーブ 114万円"/)
    for (const amount of ['1,330万', '760万', '950万', '380万', '266万', '114万']) expect(html).toContain(`u9-legend__pct">${amount}<`)
    // 穴の表示: モバイル=総資産 / デスクトップ=構成（凍結 M4 / D4）
    expect(html).toContain('u9-donut__hole-m"><span>総資産</span><strong>3,800万</strong>')
    expect(html).toContain('u9-donut__hole-d"><span>構成</span><strong>6クラス</strong>')
  })

  it('donutGradient は currentAmount の比だけで決まる（target / gap を変えても不変）', () => {
    const a = projectPortfolio(fixtureAllocation())!.rows
    const changedTargets = fixtureClasses().map(c => ({ ...c, targetAmount: c.targetAmount * 3, targetGap: 5, overweightAmount: 0, targetRatio: 0.9 }))
    const b = projectPortfolio(fixtureAllocation({ classes: changedTargets }))!.rows
    expect(donutGradient(a)).toBe(donutGradient(b))
    // 6 クラスすべてにセグメント（識別可能）
    expect((donutGradient(a).match(/%\s\d+(\.\d+)?%/g) ?? []).length).toBe(6)
  })

  it('目標との差: 方向は 不足 / 超過 / 目標水準（canonical の targetGap / overweightAmount）。閾値語を作らない', () => {
    expect(html).toContain('現在 ▮ / 目標 ▏')
    expect(html).toContain('35 / 30 ・超過 190万円')
    expect(html).toContain('7 / 10 ・不足 114万円')
    expect(html).toContain('3 / 5 ・不足 76万円')
    expect(html).toContain('20 / 20 ・目標水準')
    expect(html).toContain('u9-bar__target')
    expect(html).not.toMatch(/大きな乖離|小さな乖離|ほぼ目標|軽微/)
  })

  it('表示用の現在比率（総資産割り）は business state に影響しない: 総資産を変えても方向・金額の表示は同一', () => {
    const other: PortfolioSurfaceViewModel = { ...available, portfolio: projectPortfolio(fixtureAllocation({ totalAssets: 9_999_999 })) }
    const out = renderToStaticMarkup(<PortfolioSurfaceView vm={other} onNavigate={noop} />)
    const dirs = (h: string) => [...h.matchAll(/data-direction="([^"]+)"/g)].map(m => m[1])
    expect(dirs(out)).toEqual(dirs(html))
    expect(out).toContain('・超過 190万円')
    expect(out).toContain('・不足 114万円')
  })

  it('総現金と実行可能現金を分離表示（総現金は canonical grossCash、実行可能は別権限）', () => {
    expect(html).toMatch(/data-testid="gross-cash">266万円</)
    expect(html).toMatch(/data-testid="deployable-cash"[^>]*>¥1,200,000</)
    expect(html).toContain('実行可能現金は現金残高とは別の権限です')
  })

  it('実行可能現金が利用不可でも、総現金を代入せず「利用不可」（¥0 にもしない）', () => {
    const vm: PortfolioSurfaceViewModel = { ...available, deployableCash: { kind: 'unavailable' } }
    const out = renderToStaticMarkup(<PortfolioSurfaceView vm={vm} onNavigate={noop} />)
    expect(out).toMatch(/data-testid="gross-cash">266万円</)
    expect(out).toMatch(/data-testid="deployable-cash" data-unavailable="true">利用不可</)
    expect(out).not.toContain('¥0')
    expect(out).not.toMatch(/data-testid="deployable-cash"[^>]*>[^<]*266万/)
    expect(out).not.toMatch(/data-testid="deployable-cash"[^>]*>¥2,660,000/)
  })

  it('総現金が gross として表示されても deployable の値には現れない（別ラベル・別値）', () => {
    const vm: PortfolioSurfaceViewModel = { ...available, deployableCash: { kind: 'available', amountJpy: 1_200_000 } }
    const out = renderToStaticMarkup(<PortfolioSurfaceView vm={vm} onNavigate={noop} />)
    expect(out).toContain('総現金')
    expect(out).toContain('実行可能現金')
    expect(out).not.toMatch(/data-testid="deployable-cash"[^>]*>266万円/)
  })

  it('旧 T4（理想ポートフォリオ / 差分）へ到達できる（実際の onClick）', () => {
    const onNavigate = vi.fn()
    const buttons = hubButtons(<PortfolioSurfaceView vm={available} onNavigate={onNavigate} />)
    expect(buttons.map(b => b.props['data-hub-link'])).toEqual(['ideal-pf'])
    ;(buttons[0].props.onClick as () => void)()
    expect(onNavigate).toHaveBeenCalledWith({ tab: 'T4', surface: null })
  })

  it('「‹」は 44px の操作対象（アクセシブル名あり）で、今日へ戻る', () => {
    expect(html).toContain('class="u9-surface__back"')
    expect(html).toContain('aria-label="今日に戻る"')
    const onNavigate = vi.fn()
    const back = collect(<PortfolioSurfaceView vm={available} onNavigate={onNavigate} />, el => el.type === 'button' && el.props['aria-label'] === '今日に戻る')
    expect(back).toHaveLength(1)
    ;(back[0].props.onClick as () => void)()
    expect(onNavigate).toHaveBeenCalledWith({ tab: 'T0', surface: null })
  })
})

describe('PF 面: 配分スナップショット利用不可（スコープされた劣化）', () => {
  const out = renderToStaticMarkup(<PortfolioSurfaceView vm={unavailable} onNavigate={noop} />)

  it('配分に依存する領域だけが「配分情報を利用できません」。全体の判断不能は出さない', () => {
    expect(out).toContain('data-testid="portfolio-surface-unavailable"')
    expect(out).toContain('配分情報を利用できません')
    expect(out).not.toContain('data-testid="portfolio-composition"')
    expect(out).not.toContain('data-testid="portfolio-gaps"')
    expect(out).not.toContain('判断結果を利用できません')
    expect(out).not.toContain('decision-unavailable')
  })

  it('現金は別権限のため個別に扱う: 実行可能現金は「利用不可」（¥0 にしない）、総現金は未設定', () => {
    expect(out).toMatch(/data-testid="deployable-cash" data-unavailable="true">利用不可</)
    expect(out).toContain('未設定')
    expect(out).not.toContain('¥0')
  })

  it('ナビゲーション（理想ポートフォリオ / 差分）は失われない', () => {
    expect(out).toContain('理想ポートフォリオ / 差分')
    expect(out).toContain('aria-label="今日に戻る"')
  })
})

describe('投信ハブ', () => {
  const vm = projectFundsHub(projectPortfolio(fixtureAllocation()))

  function clickAll(v: typeof vm) {
    const onNavigate = vi.fn<(t: NavTarget) => void>()
    const buttons = hubButtons(<FundsHubView vm={v} onNavigate={onNavigate} />)
    const targets = buttons.map(b => {
      onNavigate.mockClear()
      ;(b.props.onClick as () => void)()
      return onNavigate.mock.calls[0][0]
    })
    return { ids: buttons.map(b => b.props['data-hub-link']), targets }
  }

  it('T2 国内投信 / T3 海外投信 / T7 投信管理 に onClick で到達できる', () => {
    const { ids, targets } = clickAll(vm)
    expect(ids).toEqual(['jp-fund', 'global-fund', 'fund-management'])
    expect(targets).toEqual([
      { tab: 'T2', surface: null }, { tab: 'T3', surface: null }, { tab: 'T7', surface: null },
    ])
  })

  it('到達先を実ナビ（applyNavTarget）に通すと setTab(T2/T3/T7)。UI 面は解除される', () => {
    for (const [target, tab] of [[{ tab: 'T2', surface: null }, 'T2'], [{ tab: 'T3', surface: null }, 'T3'], [{ tab: 'T7', surface: null }, 'T7']] as const) {
      const actions = { setTab: vi.fn(), openSurface: vi.fn(), clearSurface: vi.fn() }
      applyNavTarget(target, actions)
      expect(actions.clearSurface).toHaveBeenCalledTimes(1)
      expect(actions.setTab).toHaveBeenCalledWith(tab)
    }
  })

  it('国内投信 / 海外投信は canonical の現在額（760万 / 950万）。投信管理は値なし', () => {
    const html = renderToStaticMarkup(<FundsHubView vm={vm} onNavigate={noop} />)
    expect(html).toContain('u9-hub-item__value">760万<')
    expect(html).toContain('u9-hub-item__value">950万<')
    expect((html.match(/u9-hub-item__value/g) ?? []).length).toBe(2)
    expect(html).toContain('国内投信')
    expect(html).toContain('20 / 20 ・目標水準')
    expect(html).toContain('25 / 25 ・目標水準')
  })

  it('内部の T 番号を主要ラベルにしない。ハブ自体は判断を持たない', () => {
    const html = renderToStaticMarkup(<FundsHubView vm={vm} onNavigate={noop} />)
    const visible = html.replace(/<[^>]+>/g, ' ')
    expect(visible).not.toMatch(/\bT[0-9]\b/)
    expect(html).toContain('ハブ自体は判断を持ちません')
  })

  it('判断権限なし: スコア / 順位 / 推奨 / 実行 / 買い / 売りの語彙を持たない', () => {
    const visible = renderToStaticMarkup(<FundsHubView vm={vm} onNavigate={noop} />).replace(/<[^>]+>/g, ' ')
    expect(visible).not.toMatch(/スコア|順位|おすすめ|推奨|実行可能|買い|売り|注文/)
  })

  it('配分スナップショット利用不可でも 3 行すべて到達でき、値は「利用不可」（0 にしない）', () => {
    const v = projectFundsHub(projectPortfolio(UNAVAILABLE_ALLOCATION))
    const { ids } = clickAll(v)
    expect(ids).toHaveLength(3)
    const html = renderToStaticMarkup(<FundsHubView vm={v} onNavigate={noop} />)
    expect(html).toContain('u9-hub-item__value" data-unavailable="true">利用不可<')
    expect(html).toContain('data-testid="funds-hub-gaps-unavailable"')
    expect(html).not.toMatch(/>0万/)
  })
})

describe('その他ハブ', () => {
  const vm = assembleOtherHub({
    decisionGeneratedAt: '2026-10-06T08:30:00+09:00', marketAt: '2026-10-06 08:30', candidatesAt: '2026-10-06T07:55:00+09:00',
  })

  it('T5 ニュース / T6 AI委員会 / T8 学習・検証 / T9 設定 に onClick で到達できる', () => {
    const onNavigate = vi.fn<(t: NavTarget) => void>()
    const buttons = hubButtons(<OtherHubView vm={vm} onNavigate={onNavigate} />)
    const byId: Record<string, NavTarget> = {}
    for (const b of buttons) {
      onNavigate.mockClear()
      ;(b.props.onClick as () => void)()
      byId[String(b.props['data-hub-link'])] = onNavigate.mock.calls[0][0]
    }
    expect(byId.news).toEqual({ tab: 'T5', surface: null })
    expect(byId.committee).toEqual({ tab: 'T6', surface: null })
    expect(byId.learning).toEqual({ tab: 'T8', surface: null })
    expect(byId.settings).toEqual({ tab: 'T9', surface: null })
    expect(byId['legacy-home']).toEqual({ tab: null, surface: 'legacy_home' })
  })

  it('AI委員会は最終判断ではない（OfficialDecision は今日に残す）。新しい最終推奨を作らない', () => {
    const html = renderToStaticMarkup(<OtherHubView vm={vm} onNavigate={noop} />)
    expect(html).toContain('AI委員会は最終判断ではありません。最終判断は「今日」に表示します。')
    const visible = html.replace(/<[^>]+>/g, ' ')
    expect(visible).not.toMatch(/\bT[0-9]\b/)
    expect(visible).not.toMatch(/推奨|買い|売り|結論/)
  })

  it('システム欄: データセットごとの絶対時刻とバージョン。「正常」にまとめない', () => {
    const html = renderToStaticMarkup(<OtherHubView vm={vm} onNavigate={noop} />)
    expect(html).toMatch(/data-system-row="decision">10\/6 8:30</)
    expect(html).toMatch(/data-system-row="market">10\/6 8:30</)
    expect(html).toMatch(/data-system-row="candidates">10\/6 7:55</)
    expect(html).toMatch(/data-system-row="version">13\.3</)
    expect(html).not.toMatch(/正常/)
  })

  it('時刻が不明な行だけ「利用不可」で、他の行とリンクは影響を受けない', () => {
    const v = assembleOtherHub({ decisionGeneratedAt: null, marketAt: '2026-10-06 08:30', candidatesAt: null })
    const html = renderToStaticMarkup(<OtherHubView vm={v} onNavigate={noop} />)
    expect(html).toMatch(/data-system-row="decision" data-unavailable="true">利用不可</)
    expect(html).toMatch(/data-system-row="market">10\/6 8:30</)
    expect(html.match(/data-hub-link=/g)?.length).toBe(5)
  })
})

describe('タップ領域（CSS 契約は ui9i.css.test で検証）', () => {
  it('ハブ行は u9-hub-item（min-height 44px 以上）', () => {
    const vm = projectFundsHub(projectPortfolio(fixtureAllocation()))
    expect(renderToStaticMarkup(<FundsHubView vm={vm} onNavigate={noop} />)).toContain('u9-hub-item')
  })
})
