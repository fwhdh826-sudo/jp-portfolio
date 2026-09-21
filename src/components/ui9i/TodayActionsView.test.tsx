// UI-9I Phase 2B-2R (P1-01): 「今日のToDo」が R4.1 Today に実際に描画されることの契約。
// renderToStaticMarkup で実 DOM 文字列を検証する（source regex は主張の根拠にしない）。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OfficialDecisionItem } from '../../types'
import { assembleTodayHomeViewModel } from '../../presentation/ui9i/todayHome'
import { baseInputs, fixtureDecision } from '../../presentation/ui9i/ui9i.fixtures'
import { TodayHomeView } from './TodayHomeView'

const actions = { onOpenAudit: () => {}, onOpenPortfolio: () => {}, onOpenCandidates: () => {} }

function item(id: string, action: OfficialDecisionItem['action'], overrides: Partial<OfficialDecisionItem> = {}): OfficialDecisionItem {
  return { id, assetType: 'stock', code: id, name: `銘柄${id}`, action, reason: `${id} の理由`, source: 'committee', ...overrides }
}

function render(inputs: ReturnType<typeof baseInputs>): string {
  return renderToStaticMarkup(
    <TodayHomeView vm={assembleTodayHomeViewModel(inputs)} dateLabel="10月6日（月）" actions={actions} />,
  )
}

const withActions = (list: OfficialDecisionItem[], extra: Partial<Parameters<typeof baseInputs>[0]> = {}) =>
  baseInputs({ officialDecision: fixtureDecision({ actions: list }), ...extra })

/** 「今日のToDo」カードだけを切り出す（section は入れ子にならない）。 */
function todoCard(html: string): string {
  const m = html.match(/<section[^>]*data-testid="today-actions-card"[\s\S]*?<\/section>/)
  expect(m, '今日のToDo カードが描画されていない').not.toBeNull()
  return m![0]
}
const rowCount = (html: string) => (html.match(/data-testid="today-action-row"/g) ?? []).length
const pos = (html: string, needle: string) => html.indexOf(needle)

describe('P1-01 回帰: OfficialDecision.actions が非空なら Today で到達できる', () => {
  const cases: Array<[string, OfficialDecisionItem, string]> = [
    ['SELL', item('7203', 'SELL', { name: 'トヨタ', reason: '損切ラインに到達' }), '売却'],
    ['BLOCKED', item('9432', 'BLOCKED', { name: 'NTT', reason: 'リスクゲート非通過', blockedReason: '解除条件: ノートレード解除後に再判定' }), '実行不可'],
    ['DATA_WAIT', item('6758', 'DATA_WAIT', { name: 'ソニー', reason: 'データ品質低下', blockedReason: '最新データ取得後に判断する' }), '更新待ち'],
  ]
  for (const [name, it_, label] of cases) {
    it(`${name}: 行が描画され、状態語・識別・理由が見える`, () => {
      const card = todoCard(render(withActions([it_])))
      expect(rowCount(card)).toBe(1)
      expect(card).toContain(`data-action="${name}"`)
      expect(card).toContain(`>${label}</span>`)
      expect(card).toContain(`${it_.code} ${it_.name}`)
      expect(card).toContain(it_.reason)
      expect(card).not.toContain(`>${name}<`) // 生の enum を出さない
    })
  }

  it('BLOCKED / DATA_WAIT の blockedReason（実行条件 / 次の確認）が読める', () => {
    const html = render(withActions([cases[1][1], cases[2][1]]))
    expect(html).toContain('実行条件 / 次の確認')
    expect(html).toContain('解除条件: ノートレード解除後に再判定')
    expect(html).toContain('最新データ取得後に判断する')
    expect((html.match(/data-testid="today-action-condition"/g) ?? []).length).toBe(2)
  })

  it('actions が非空（候補以外）なのに 0 行になる状態を作らない（全 action 種別・全 Hero 状態）', () => {
    const kinds: OfficialDecisionItem['action'][] = ['SELL', 'HOLD', 'WAIT', 'MONITOR', 'BLOCKED', 'DATA_WAIT', 'WATCH']
    const states = [
      baseInputs(),
      baseInputs({ safeModeEffective: true }),
      baseInputs({ marketDataOk: false }),
    ]
    for (const kind of kinds) {
      for (const st of states) {
        const html = render({ ...st, officialDecision: fixtureDecision({ actions: [item('X1', kind)], dataQualitySuppressed: st.marketDataOk === false }) })
        expect(rowCount(html), `${kind}`).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe('複数 action・提示順・初期 3 件・「他 N 件」', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((id, i) => item(id, i === 3 ? 'SELL' : 'HOLD'))
  const html = render(withActions(list))
  const card = todoCard(html)

  it('先頭 3 件は常時表示、残りは native details/summary 内（提示順のまま）', () => {
    expect(rowCount(card)).toBe(5) // DOM 上は全件に到達可能（黙って捨てない）
    const detailsStart = card.indexOf('<details')
    for (const id of ['a', 'b', 'c']) expect(card.indexOf(`>${id} 銘柄${id}<`)).toBeLessThan(detailsStart)
    for (const id of ['d', 'e']) expect(card.indexOf(`>${id} 銘柄${id}<`)).toBeGreaterThan(detailsStart)
    expect(card).toContain('<summary class="u9-disclose__summary">他 2 件を見る</summary>')
    expect(card).toContain('data-testid="today-actions-more"')
  })

  it('SELL でも並べ替えない（4 番目のまま）', () => {
    const seq = [...card.matchAll(/data-action="([A-Z_]+)"/g)].map(m => m[1])
    expect(seq).toEqual(['HOLD', 'HOLD', 'HOLD', 'SELL', 'HOLD'])
    expect(pos(card, '>a 銘柄a<')).toBeLessThan(pos(card, '>b 銘柄b<'))
    expect(pos(card, '>b 銘柄b<')).toBeLessThan(pos(card, '>c 銘柄c<'))
    expect(pos(card, '>c 銘柄c<')).toBeLessThan(pos(card, '>d 銘柄d<'))
    expect(pos(card, '>d 銘柄d<')).toBeLessThan(pos(card, '>e 銘柄e<'))
  })

  it('3 件以下なら「他 N 件」を出さない', () => {
    expect(todoCard(render(withActions([item('a', 'SELL')])))).not.toContain('<details')
  })

  it('候補（isCandidate）は ToDo に出さない。候補節が別に担う', () => {
    const h = render(withActions([item('a', 'SELL'), item('C9', 'BUY_NEW', { isCandidate: true, source: 'candidate' })]))
    expect(rowCount(todoCard(h))).toBe(1)
    expect(todoCard(h)).not.toContain('C9')
  })
})

describe('OfficialDecision 状態', () => {
  it('zero-action: 中立の空状態。判断不能 / 待機 / ¥0 / 候補なし に化けない', () => {
    const card = todoCard(render(withActions([])))
    expect(card).toContain('現在、追加のToDoはありません')
    expect(card).toContain('data-testid="today-actions-empty"')
    expect(rowCount(card)).toBe(0)
    expect(card).not.toMatch(/判断結果を利用できません|更新待ち|保有継続|待機|¥0|候補なし/)
  })

  it('OfficialDecision unavailable: 提案を出さず明示。Market / PF / 注目 / 候補は独立に到達可能', () => {
    const html = render(baseInputs({
      officialDecision: null,
      holdings: [{ code: '9697', lock: true, acquiredAt: '2026-07-22' }],
      marketFeed: { ...baseInputs().marketFeed, vix: 32.5 },
    }))
    const card = todoCard(html)
    expect(card).toContain('判断結果を利用できないため、実行の提案は行いません。')
    expect(card).toContain('data-testid="today-actions-unavailable"')
    expect(rowCount(html)).toBe(0)
    expect(card).not.toMatch(/売却|保有継続|待機|更新待ち|追加のToDoはありません|SQ|高ボラ|朝の相場確認/)
    expect(html).toContain('data-testid="market-card"')
    expect(html).toContain('data-testid="portfolio-card"')
    expect(html).toContain('data-testid="attention-card"') // 90 日ロックは自分の権限で残る
    expect(html).toContain('data-testid="candidate-card"')
    // 過去の headline / action を現在として残さない
    expect(html).not.toContain('慎重運用')
  })

  it('SAFE_MODE: BUY 行は出さず、SELL / BLOCKED は残り、非表示の件数を注記する', () => {
    const html = render(withActions(
      [item('B1', 'BUY'), item('S1', 'SELL'), item('K1', 'BLOCKED', { blockedReason: '再判定待ち' })],
      { safeModeEffective: true },
    ))
    const card = todoCard(html)
    expect(card).not.toContain('data-action="BUY"')
    expect(card).not.toContain('B1 銘柄B1')
    expect(card).toContain('data-action="SELL"')
    expect(card).toContain('data-action="BLOCKED"')
    expect(card).toContain('買いの提案 1 件は表示していません')
  })

  it('DATA_WAIT（全体）: BUY のみ非表示。Hero は data_wait のまま', () => {
    const html = render(withActions([item('B1', 'BUY'), item('S1', 'SELL')], { marketDataOk: false }))
    expect(html).toContain('data-hero-state="data_wait"')
    expect(todoCard(html)).not.toContain('data-action="BUY"')
    expect(todoCard(html)).toContain('data-action="SELL"')
  })

  it('boot: ToDo 節を出さない（起動中）', () => {
    const html = render(baseInputs({ systemStatus: 'initializing', officialDecision: null }))
    expect(html).not.toContain('data-testid="today-actions-card"')
    expect(html).not.toContain('今日のToDo')
  })
})

describe('Today 北極星: 知る + 動く / 構成', () => {
  const html = render(withActions([item('S1', 'SELL')], { holdings: [{ code: '9697', lock: true, acquiredAt: '2026-07-22' }] }))

  it('ToDo は Hero の直後・注目 / 候補 / PF / マーケットより前（早いスキャン位置）', () => {
    const at = pos(html, 'data-testid="today-actions-card"')
    expect(pos(html, 'data-testid="hero-headline"')).toBeLessThan(at)
    expect(at).toBeLessThan(pos(html, 'data-testid="attention-card"'))
    expect(at).toBeLessThan(pos(html, 'data-testid="candidate-card"'))
    expect(at).toBeLessThan(pos(html, 'data-testid="portfolio-card"'))
    expect(at).toBeLessThan(pos(html, 'data-testid="market-card"'))
  })

  it('意味的に別: ToDo(actions) / 注目(制約) / 候補(synthesis) は別々の節', () => {
    expect(html).toContain('data-testid="attention-card"')
    expect(html).toContain('data-testid="candidate-card"')
    expect(todoCard(html)).not.toContain('90日ロック中')
    expect(todoCard(html)).not.toContain('市場スコア')
  })

  it('意味のある見出し（h2）。等級語・確信度語・生 enum を出さない', () => {
    expect(html).toContain('<h2 class="u9-card__title">今日のToDo</h2>')
    const card = todoCard(html)
    expect(card).not.toMatch(/おすすめ|強く買い|AI推奨|確信度|優先度/)
  })

  it('レガシー Home / 旧ナビ / 旧 ToDo 文言を出さない', () => {
    expect(html).not.toMatch(/従来のホーム|legacy_home|DesktopSidebarNav|BottomDockNav|TabNav|朝の相場確認|現状維持で監視/)
  })
})
