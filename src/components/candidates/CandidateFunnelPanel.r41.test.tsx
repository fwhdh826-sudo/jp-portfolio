// UI-9I Phase 2B-1R: Candidate Funnel の R4.1 視覚移行後も業務セマンティクスが不変であることを、
// 実コンポーネント（CandidateFunnelPanelView）の描画結果で検証する。
// シナリオは dev ハーネスと同一（candidateFunnel.scenarios.ts）で、parser を通る canonical artifact。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// @ts-expect-error -- repositoryは@types/node非依存だがVitestのNode runtimeでのみ使用する
import { readFileSync } from 'node:fs'
import { parseCandidateFunnelArtifact } from '../../services/candidateFunnelParser'
import {
  CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
  CandidateFunnelPanelView,
  type CandidateFunnelViewState,
} from './CandidateFunnelPanel'
import {
  CANDIDATE_FUNNEL_SCENARIO_NAMES,
  candidateFunnelScenario,
  type CandidateFunnelScenarioName,
} from './candidateFunnel.scenarios'

const css: string = readFileSync('src/components/candidates/CandidateFunnelPanel.css', 'utf8')

function render(
  name: CandidateFunnelScenarioName,
  viewState: CandidateFunnelViewState = CANDIDATE_FUNNEL_INITIAL_VIEW_STATE,
  mutate?: (scenario: ReturnType<typeof candidateFunnelScenario>) => void,
): string {
  const scenario = candidateFunnelScenario(name)
  mutate?.(scenario)
  return renderToStaticMarkup(
    <CandidateFunnelPanelView
      artifact={scenario.artifact}
      freshness={scenario.freshness}
      portfolioFit={scenario.portfolioFit}
      viewState={viewState}
      onAction={() => {}}
      nowMs={scenario.nowMs}
    />,
  )
}

describe('Funnel scenario fixture は canonical（harness と同一入力）', () => {
  it('artifact を持つシナリオはすべて実 parser を通る', () => {
    for (const name of CANDIDATE_FUNNEL_SCENARIO_NAMES) {
      const { artifact } = candidateFunnelScenario(name)
      if (artifact === null) continue
      expect(parseCandidateFunnelArtifact(artifact).ok, name).toBe(true)
    }
  })
})

describe('必須セクションが移行後も残る', () => {
  it('normal: 見出し / 鮮度 / 注意 / 適合状態 / 更新日時 / 段階 / データ状態 / フィルタ / 一覧 / 注意事項', () => {
    const html = render('normal')
    for (const marker of [
      '<h2 class="candidate-funnel__title">市場候補ファネル</h2>',
      'candidate-funnel__freshness',
      'candidate-funnel__notice',
      'candidate-funnel__portfolio-fit-state',
      'aria-label="候補データ更新日時"',
      'aria-label="候補選別の段階"',
      'candidate-funnel__data-details',
      'role="tablist"',
      'role="tabpanel"',
      'candidate-funnel__notes',
    ]) {
      expect(html, marker).toContain(marker)
    }
  })
})

describe('パイプライン: 段階名・順序・件数は artifact 権威値', () => {
  it('段階は 市場候補 → 一次選別 → 詳細精査 → 重点候補 の順で、欠落・統合がない', () => {
    const html = render('normal')
    const order = ['市場候補', '一次選別', '詳細精査', '重点候補']
    const summary = html.slice(html.indexOf('candidate-funnel__summary'), html.indexOf('candidate-funnel__data-details'))
    const positions = order.map(label => summary.indexOf(`<span>${label}</span>`))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(summary.match(/<li>/g)).toHaveLength(4)
  })

  it('件数は artifact.counts をそのまま表示する（描画行から再計算しない）', () => {
    // candidates と矛盾する counts を注入しても、表示は権威値のまま。
    const html = render('normal', CANDIDATE_FUNNEL_INITIAL_VIEW_STATE, s => {
      if (s.artifact === null) throw new Error('fixture')
      s.artifact.counts = { total: 91, excluded: 0, screened: 47, deepReview: 23, actionable: 11 }
    })
    const summary = html.slice(html.indexOf('candidate-funnel__summary'), html.indexOf('candidate-funnel__data-details'))
    for (const count of ['91', '47', '23', '11']) expect(summary).toContain(`<strong>${count}</strong>`)
    // フィルタのバッジも同じ権威値
    expect(html).toContain('aria-label="47件"')
    expect(html).toContain('aria-label="23件"')
    expect(html).toContain('aria-label="11件"')
  })

  it('折りたたみ（details）の開閉は件数・段階に影響しない', () => {
    const html = render('warning')
    const summary = html.slice(html.indexOf('candidate-funnel__summary'), html.indexOf('candidate-funnel__data-details'))
    expect(summary).toContain('<strong>4</strong>')
  })
})

describe('鮮度: 既存 authority の enum を文字で示す（View で再判定しない）', () => {
  it.each([
    ['normal', 'fresh', '鮮度 正常'],
    ['warning', 'stale', '更新遅れの可能性'],
    ['quality', 'degraded', '代替データ経路'],
    ['unavailable', 'unavailable', '取得不可'],
    ['invalid', 'invalid', '検証不可'],
  ] as const)('%s → data-freshness=%s の表示は「%s」', (name, freshness, label) => {
    const html = render(name)
    expect(html).toContain(`data-freshness="${freshness}"`)
    expect(html).toContain(label)
  })

  it('生成時刻・ソース更新時刻は JST の文字で残る', () => {
    const html = render('normal')
    expect(html).toContain('生成: 2026/07/26 16:11 JST')
    expect(html).toContain('ソース更新: 2026/07/26 16:09 JST')
  })
})

describe('データ品質の区別を 1 つの「警告」に潰さない', () => {
  it('quality: 代替経路（danger）と品質注記（別ブロック）と検証結果が別々に読める', () => {
    const html = render('quality')
    expect(html).toContain('candidate-funnel__state--danger')
    expect(html).toContain('代替データ経路を使用しています。現在の購入判断には使用しないでください。')
    expect(html).toContain('candidate-funnel__degradation-reasons')
    expect(html).toContain('キャッシュした代替データで生成しています')
    expect(html).toContain('一次選別メタデータの一部が取得できていません')
    expect(html).toContain('データ検証通過')
    expect(html).toContain('92.3%')
  })

  it('warning: 古い可能性（warning）は代替経路（danger）と別の状態として出る', () => {
    const html = render('warning')
    expect(html).toContain('candidate-funnel__state--warning')
    expect(html).toContain('データが古い可能性があります')
    expect(html).not.toContain('candidate-funnel__state--danger')
  })

  it('unavailable と invalid は別文言・別 role（neutral status / danger alert）', () => {
    const unavailable = render('unavailable')
    const invalid = render('invalid')
    expect(unavailable).toContain('候補データを取得できませんでした')
    expect(unavailable).not.toContain('候補データを検証できませんでした')
    expect(invalid).toContain('候補データを検証できませんでした')
    expect(invalid).toContain('candidate-funnel__state--danger" role="alert"')
    expect(unavailable).toContain('candidate-funnel__state--neutral" role="status"')
  })

  it('unavailable / invalid では旧データの候補一覧を出さない', () => {
    for (const name of ['unavailable', 'invalid'] as const) {
      const html = render(name)
      expect(html).not.toContain('role="tablist"')
      expect(html).not.toContain('candidate-funnel-card')
      expect(html).not.toContain('candidate-funnel__summary')
    }
  })
})

describe('除外診断: 理由・範囲・件数が到達可能', () => {
  it('warning: 除外銘柄数・理由別件数・重複の説明が details の中に残る', () => {
    const html = render('warning')
    expect(html).toContain('除外候補の診断（1銘柄）')
    expect(html).toContain('プライム市場の国内株ではありません')
    expect(html).toContain('価格履歴が不足しています')
    expect(html).toContain('1件')
    expect(html).toContain('理由別の件数の合計は除外銘柄数（1銘柄）を上回る場合があります')
    expect(html).toContain('除外はデータ品質・適格性による対象外です')
  })

  it('除外がない normal では除外診断を出さない', () => {
    expect(render('normal')).not.toContain('candidate-funnel__excluded-details')
  })
})

describe('ポートフォリオ適合: 既存 authority の値をそのまま投影', () => {
  it('normal(evaluated): 状態文言は出るが alert role は付かず、内訳は details に残る', () => {
    const html = render('normal')
    expect(html).toContain('ポートフォリオ適合を評価しました。')
    expect(html).toContain('candidate-funnel__portfolio-fit-state--evaluated')
    expect(html).not.toMatch(/candidate-funnel__portfolio-fit-state--evaluated" role=/)
    expect(html).toContain('評価日時:')
    expect(html).toContain('日本株枠: 余力あり')
  })

  it('warning(partial): 確認事項の文言と status role が出る', () => {
    const html = render('warning')
    expect(html).toContain('ポートフォリオ適合は一部のみ評価できました。')
    expect(html).toContain('ポートフォリオ適合に確認事項があります。')
    expect(html).toContain('candidate-funnel__portfolio-fit-state--partial" role="status" aria-live="polite"')
  })

  it('invalid: 検証不可は alert role で、内訳は既定で開いている', () => {
    const html = render('invalid')
    expect(html).toContain('candidate-funnel__portfolio-fit-state--invalid" role="alert"')
    expect(html).toMatch(/<details open=""><summary>評価の内訳<\/summary>/)
  })

  it('候補ごとの適合は funnel 側で再計算せず、view model の record をそのまま出す', () => {
    const html = render('normal')
    expect(html).toContain('新規候補（未保有）')
    expect(html).toContain('既存日本株内の同一セクター比率')
    expect(html).toContain('66.7%')
  })
})

describe('市場順位・スコアは観測情報のみ', () => {
  it('市場スコア / 市場順位の表記は保つ。おすすめ・買い・AI・期待収益の順位に読み替えない', () => {
    const html = render('normal')
    expect(html).toContain('市場スコア')
    expect(html).toContain('市場順位')
    for (const forbidden of ['総合おすすめ順位', '買い順位', 'AI順位', '期待収益順位', 'おすすめ']) {
      expect(html, forbidden).not.toContain(forbidden)
    }
  })

  it('未取得のスコア / 順位を 0 に置き換えない（null は —）', () => {
    const html = render('warning', { filter: 'screened', visibleCount: 10 }, s => {
      if (s.artifact === null) throw new Error('fixture')
      const target = s.artifact.candidates.find(c => c.tier === 'screened')
      if (target) { target.marketScore = null; target.marketRank = null }
    })
    expect(html).toMatch(/<dt>市場スコア<\/dt><dd>—<\/dd>/)
    expect(html).toMatch(/<dt>市場順位<\/dt><dd>—<\/dd>/)
  })
})

describe('取引不可の意味は常に読める（薄めない・消さない）', () => {
  it.each(CANDIDATE_FUNNEL_SCENARIO_NAMES)('%s: 常時可視の「取引判断には使用しません」', name => {
    const html = render(name)
    const notice = html.slice(html.indexOf('candidate-funnel__notice'), html.indexOf('</div>', html.indexOf('candidate-funnel__notice')))
    expect(notice).toContain('取引判断には使用しません')
    expect(notice).toContain('重点候補は購入を推奨するものではなく、次段階の検討候補です。')
  })

  it.each(CANDIDATE_FUNNEL_SCENARIO_NAMES)('%s: raw token を含む原文は注意事項（provenance）に保持される', name => {
    const html = render(name)
    const notes = html.slice(html.indexOf('candidate-funnel__notes'))
    expect(notes).toContain('売買利用不可（not_for_trading）— ポートフォリオ適合は売買判断や注文に使用しないでください。')
    // raw token は常時可視の notice には出さない
    const notice = html.slice(html.indexOf('candidate-funnel__notice'), html.indexOf('candidate-funnel__notes'))
    expect(notice.slice(0, notice.indexOf('</div>'))).not.toContain('not_for_trading')
  })
})

describe('実行・推奨の状態を合成しない', () => {
  it.each(CANDIDATE_FUNNEL_SCENARIO_NAMES)('%s: 売買・金額・実行可否の語彙が現れない', name => {
    const html = render(name)
    expect(html).not.toMatch(/BUY_NEW|SELL|実行可能|AllocationPlan|購入金額|maxAmount|officialDecision/)
    expect(html).not.toMatch(/<button[^>]*>[^<]*(買う|購入|注文|売却)/)
  })

  it('操作要素はフィルタ（tab）と「さらに表示」のみ（候補カードは非対話）', () => {
    const html = render('normal')
    expect(html.match(/<button/g)?.length).toBe(3)
    expect(html.match(/role="tab"/g)).toHaveLength(3)
  })
})

describe('空の段階は正常な空状態', () => {
  it('empty: 件数 0 の段階と空メッセージ。段階名は省略されない', () => {
    const html = render('empty')
    expect(html).toContain('重点候補に該当する候補はありません')
    const summary = html.slice(html.indexOf('candidate-funnel__summary'), html.indexOf('candidate-funnel__data-details'))
    expect(summary.match(/<strong>0<\/strong>/g)).toHaveLength(4)
    for (const label of ['市場候補', '一次選別', '詳細精査', '重点候補']) expect(summary).toContain(label)
  })
})

describe('R4.1 視覚言語への準拠（CSS 契約）', () => {
  it('legacy v10 トークン（--color-* / --space-* / --radius-* / --font-*）を使わない', () => {
    expect(css).not.toMatch(/var\(--(color|space|radius|font|shadow)-/)
  })

  it('R4.1 トークン（--u9-*）とカード（.u9-card）を土台にする', () => {
    expect(css).toContain('var(--u9-ink)')
    expect(css).toContain('var(--u9-accent-ink)')
    expect(css).toContain('var(--u9-mono)')
    expect(render('normal')).toContain('candidate-funnel u9-card')
  })

  it('セレクタはすべて .candidate-funnel 系にスコープされ、他面の見た目へ漏れない', () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\})\s*([^{}@]+)\{/g)]
      .flatMap(m => m[2].split(','))
      .map(s => s.trim())
      .filter(s => s !== '' && !/^\d+%$/.test(s))
    expect(selectors.length).toBeGreaterThan(20)
    expect(selectors.filter(s => !s.startsWith('.candidate-funnel'))).toEqual([])
  })

  it('大きな橙のスラブ・旧四角ブロックに戻らない（濃い枠線 / 太い左罫線を使わない）', () => {
    expect(css).not.toMatch(/border-left:\s*[3-9]px/)
    expect(css).not.toMatch(/border:\s*[2-9]px/)
    expect(css).not.toMatch(/var\(--color-(wait|sell|buy)-/)
  })

  it('コンパクトな日本語ラベルは nowrap + keep-all、操作要素は 44px 以上、focus-visible あり', () => {
    expect(css).toMatch(/candidate-funnel__summary li \{[^}]*white-space: nowrap;[^}]*word-break: keep-all/)
    expect(css).toMatch(/candidate-funnel__filters button \{[^}]*min-height: 44px/)
    expect(css).toMatch(/candidate-funnel__more \{[^}]*min-height: 44px/)
    // summary（開閉）は、そのセレクタ単独を含む規則の本体で 44px を満たす
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
      .map(m => ({ selectors: m[1].split(',').map(x => x.trim()), body: m[2] }))
    for (const selector of [
      '.candidate-funnel__data-details summary',
      '.candidate-funnel__excluded-details summary',
      '.candidate-funnel__notes summary',
      '.candidate-funnel__portfolio-fit-state summary',
      '.candidate-funnel-card__portfolio-fit summary',
    ]) {
      const rule = rules.find(r => r.selectors.includes(selector))
      expect(rule, selector).toBeDefined()
      expect(rule?.body, selector).toContain('min-height: 44px')
    }
    expect(css).toContain('.candidate-funnel button:focus-visible')
    expect(css).toContain('.candidate-funnel summary:focus-visible')
  })

  it('Space Mono は数値・順位・コード・日時にのみ使う（本文・日本語ラベルには使わない）', () => {
    const monoRules = [...css.matchAll(/([^{}]+)\{[^}]*var\(--u9-mono\)[^}]*\}/g)].map(m => m[1].trim())
    for (const selector of monoRules) {
      expect(selector).toMatch(/summary strong|filters button span:last-child|card__code|metrics > div:nth-child\(-n\+4\) dd|timestamps/)
    }
  })
})

describe('アクセシビリティ（描画構造）', () => {
  it('見出しは h2（ファネル）→ h3（候補名）→ h4（適合）の順で飛ばない', () => {
    const html = render('normal')
    const levels = [...html.matchAll(/<h([1-6])[ >]/g)].map(m => Number(m[1]))
    expect(levels[0]).toBe(2)
    for (let i = 1; i < levels.length; i += 1) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1)
  })

  it('装飾（鮮度の丸 / 矢印）は aria-hidden で、状態は必ず文字でも表示される', () => {
    const html = render('warning')
    expect(html).toContain('candidate-funnel__freshness-mark" aria-hidden="true"')
    expect(html).toMatch(/data-mark="wait"[^>]*><span class="candidate-funnel__freshness-mark" aria-hidden="true"><\/span>更新遅れの可能性/)
  })

  it('開閉は native details/summary（開閉状態は UA が公開）で、独自 keyboard handler を持たない', () => {
    const html = render('normal')
    expect(html).toContain('<summary>データ状態</summary>')
    expect(html).toContain('<summary>この情報の見方・注意事項</summary>')
    expect(html).toContain('<summary>評価の内訳</summary>')
  })

  it('reduced motion: 全体規則（ui9i.css の .u9 *）で transition を無効化する', () => {
    const ui9i: string = readFileSync('src/styles/ui9i.css', 'utf8')
    expect(ui9i).toMatch(/prefers-reduced-motion: reduce[\s\S]*?\.u9 \*[\s\S]*?transition: none !important/)
  })
})
