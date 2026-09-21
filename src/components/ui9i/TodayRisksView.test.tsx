// UI-9I Phase 2B-2R2 (P1-02): OfficialDecision.risks が R4.1 Today の「注目ポイント」に実際に描画されることの契約。
// renderToStaticMarkup で実 DOM 文字列を検証する（source regex は主張の根拠にしない）。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OfficialDecision, OfficialDecisionItem } from '../../types'
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

const withDecision = (over: Partial<OfficialDecision>, extra: Partial<Parameters<typeof baseInputs>[0]> = {}) =>
  baseInputs({ officialDecision: fixtureDecision(over), ...extra })

const section = (html: string, testid: string): string | null =>
  html.match(new RegExp(`<section[^>]*data-testid="${testid}"[\\s\\S]*?</section>`))?.[0] ?? null
const attentionCard = (html: string): string => {
  const c = section(html, 'attention-card')
  expect(c, '注目ポイントが描画されていない').not.toBeNull()
  return c!
}
const todoCard = (html: string): string => section(html, 'today-actions-card')!
const riskRows = (html: string) => (html.match(/data-testid="today-risk-row"/g) ?? []).length
const riskTexts = (html: string) => [...html.matchAll(/<li class="u9-risk-row"[^>]*>[\s\S]*?<span class="u9-risk-row__text">([^<]*)<\/span>/g)].map(m => m[1])

describe('canonical リスクは注目ポイントで到達できる（提示順）', () => {
  it('risks=[risk A, risk B]: 両方が注目ポイントにあり、順序が保たれる', () => {
    const html = render(withDecision({ risks: ['risk A', 'risk B'] }))
    const card = attentionCard(html)
    expect(card).toContain('risk A')
    expect(card).toContain('risk B')
    expect(card.indexOf('risk A')).toBeLessThan(card.indexOf('risk B'))
    expect(riskTexts(card)).toEqual(['risk A', 'risk B'])
    expect(card).toContain('<h2 class="u9-card__title">注目ポイント</h2>')
  })

  it('UNIQUE: SAFE_MODE / 売却ロック / 候補 / 配分 / actions のどれとも重複しないリスクが可視（P1-02 回帰）', () => {
    const unique = '固有の canonical リスク: 一部の運用条件が未確認です'
    const html = render(withDecision({ risks: [unique] }))
    const card = attentionCard(html)
    expect(card).toContain(unique)
    // 他の注意（SAFE_MODE / ロック / 候補データ不足 / データ待ち）由来ではないこと
    expect(html).not.toContain('セーフモード')
    expect(html).not.toContain('90日ロック')
    expect(html).not.toContain('候補データを取得できていません')
    expect(todoCard(html)).not.toContain(unique)
    // 画面全体でも、この文言はリスク行にしか存在しない
    expect(html.split(unique).length - 1).toBe(1)
  })

  it('初期は先頭 3 件、残りは native details（提示順のまま・全件が DOM に存在）', () => {
    const list = ['r1', 'r2', 'r3', 'r4', 'r5']
    const card = attentionCard(render(withDecision({ risks: list })))
    const detailsAt = card.indexOf('<details')
    expect(detailsAt).toBeGreaterThan(-1)
    expect(riskTexts(card)).toEqual(list)
    for (const t of ['r1', 'r2', 'r3']) expect(card.indexOf(`>${t}<`)).toBeLessThan(detailsAt)
    for (const t of ['r4', 'r5']) expect(card.indexOf(`>${t}<`)).toBeGreaterThan(detailsAt)
    expect(card).toContain('<summary class="u9-disclose__summary">他 2 件を見る</summary>')
  })

  it('3 件以下なら details を出さない', () => {
    expect(attentionCard(render(withDecision({ risks: ['a', 'b', 'c'] })))).not.toContain('<details')
  })

  it('文言は verbatim。重大度・確率・AI 警告などの語を付け足さない', () => {
    const text = '為替の変動が評価に影響しています'
    const card = attentionCard(render(withDecision({ risks: [text] })))
    expect(riskTexts(card)).toEqual([text])
    expect(card).not.toMatch(/高リスク|危険度|AI警告|AI 警告|重大度|確率|重大/)
  })

  it('HTML はエスケープされ、文言中のマークアップは実行されない', () => {
    const card = attentionCard(render(withDecision({ risks: ['<img src=x onerror=alert(1)>'] })))
    expect(card).not.toContain('<img')
    expect(card).toContain('&lt;img')
  })

  it('色だけに依存しない: 装飾記号は aria-hidden で、リスク本文は文字として存在', () => {
    const card = attentionCard(render(withDecision({ risks: ['文字で伝わるリスク'] })))
    expect(card).toMatch(/<span class="u9-attn__mark" data-glyph="risk" aria-hidden="true">△<\/span>/)
    expect(card).toContain('判断に含まれるリスク')
    expect(card).toContain('aria-label="判断に含まれるリスク（判断の提示順）"')
  })

  it('重要な注意チップは表示中のリスクを数える（見えているのに「なし」と出さない）', () => {
    const html = render(withDecision({ risks: ['a', 'b'] }))
    expect(html).toMatch(/data-testid="chip-attention">2件</)
  })
})

describe('Todo と Attention の分離（action ≠ risk）', () => {
  const decision = {
    actions: [
      item('7203', 'SELL', { reason: '損切ラインに到達' }),
      item('9432', 'BLOCKED', { reason: 'リスクゲート非通過', blockedReason: '解除後に再判定' }),
    ],
    risks: ['別枠の canonical リスク'],
  }
  const html = render(withDecision(decision))

  it('action は 今日のToDo、risk は 注目ポイントに出る', () => {
    expect(todoCard(html)).toContain('7203 銘柄7203')
    expect(todoCard(html)).toContain('損切ラインに到達')
    expect(attentionCard(html)).toContain('別枠の canonical リスク')
  })

  it('risk は Todo に変換されず、action は risk として重複しない', () => {
    expect(todoCard(html)).not.toContain('別枠の canonical リスク')
    expect((html.match(/data-testid="today-action-row"/g) ?? []).length).toBe(2)
    const attn = attentionCard(html)
    for (const t of ['7203', '9432', '損切ラインに到達', 'リスクゲート非通過', '解除後に再判定']) expect(attn).not.toContain(t)
    expect(riskRows(attn)).toBe(1)
  })

  it('risks だけがあり actions=[] でも、Todo は空状態のまま（risk を action にしない）', () => {
    const h = render(withDecision({ actions: [], risks: ['risk only'] }))
    expect(todoCard(h)).toContain('data-testid="today-actions-empty"')
    expect((h.match(/data-testid="today-action-row"/g) ?? []).length).toBe(0)
    expect(attentionCard(h)).toContain('risk only')
  })

  it('DOM 順は 今日のToDo → 注目ポイント', () => {
    expect(html.indexOf('data-testid="today-actions-card"')).toBeLessThan(html.indexOf('data-testid="attention-card"'))
  })
})

describe('ゼロ件 / 判断利用不可（区別される・安全を推論しない）', () => {
  const safetyClaims = /リスクなし|リスクはありません|問題なし|安全です|安心|買ってよい|重大なリスク要因は検出されていません|No major risk/

  it('A. 有効な判断で risks=[]: リスク行なし・注目ポイントなし・安全の断定なし', () => {
    const html = render(withDecision({ risks: [] }))
    expect(section(html, 'attention-card')).toBeNull()
    expect(html).not.toContain('data-testid="today-risks"')
    expect(riskRows(html)).toBe(0)
    expect(html).not.toMatch(safetyClaims)
    expect(html).toMatch(/data-testid="chip-attention">なし</)
  })

  it('A. risks=[] でも、独立した注意（SAFE_MODE）は従来どおり表示され、リスクは作らない', () => {
    const html = render(withDecision({ risks: [] }, { safeModeEffective: true }))
    const card = attentionCard(html)
    expect(card).toContain('セーフモードが有効です')
    expect(riskRows(card)).toBe(0)
    expect(card).not.toContain('判断に含まれるリスク')
  })

  it('B. 判断利用不可: リスク行を合成せず、risks=[] と同じ「リスクなし」表現にもならない', () => {
    const html = render(baseInputs({ officialDecision: null }))
    expect(riskRows(html)).toBe(0)
    expect(html).not.toContain('data-testid="today-risks"')
    expect(html).not.toMatch(safetyClaims)
    expect(todoCard(html)).toContain('判断結果を利用できないため、実行の提案は行いません。')
  })

  it('B. 判断利用不可でも独立した注意（SAFE_MODE）は残る。リスクだけが出ない', () => {
    const html = render(baseInputs({ officialDecision: null, safeModeEffective: true }))
    const card = attentionCard(html)
    expect(card).toContain('セーフモードが有効です')
    expect(riskRows(card)).toBe(0)
  })

  it('B. headline が空の判断は利用不可: 非空の risks でも行を出さない', () => {
    const html = render(withDecision({ headline: '', risks: ['出してはいけない'] }))
    expect(html).not.toContain('出してはいけない')
  })
})

describe('SAFE_MODE + 独立 canonical リスク（併存・所有の分離）', () => {
  it('SAFE_MODE の注意と canonical リスクが同じ注目ポイントに併存する', () => {
    const html = render(withDecision({ risks: ['固有のリスク X'] }, { safeModeEffective: true }))
    const card = attentionCard(html)
    expect(card).toContain('セーフモードが有効です')
    expect(card).toContain('固有のリスク X')
    expect(html).toMatch(/data-testid="chip-attention">2件</)
  })

  it('exact 文字列が SAFE_MODE 注意と重なっても canonical 側を隠さない（意味的な重複排除をしない）', () => {
    const html = render(withDecision({ risks: ['セーフモードが有効です'] }, { safeModeEffective: true }))
    expect(attentionCard(html).split('セーフモードが有効です').length - 1).toBe(2)
  })
})

describe('LEGACY_RISK_HEURISTICS = NOT_RESTORED（旧 RiskWarningCard は復元しない）', () => {
  it('VIX 35 / 日経VI 30 / 現金なしでも、risks=[] なら旧警告文を一切出さない', () => {
    const html = render(withDecision({ risks: [] }, {
      marketFeed: {
        marketLoaded: true, macroLoaded: true, nikkeiViLoaded: true,
        nikkei: 38_521, nikkeiChgPct: 0.6, sp500: 5_762, sp500ChgPct: 0.4, vix: 35, nikkeiVi: 30,
      },
      deployableCash: { available: false, amount: 0, unavailableStatus: 'absent' },
    }))
    for (const legacy of ['極端なボラティリティ警戒', 'やや高め。急変動に備える', '国内高ボラ警戒', 'SQ接近', 'ポジション注意', '三菱グループ集中', '相関リスクに注意', '重大なリスク要因は検出されていません', 'データ更新エラー']) {
      expect(html, legacy).not.toContain(legacy)
    }
    expect(riskRows(html)).toBe(0)
    expect(section(html, 'attention-card')).toBeNull()
  })
})
