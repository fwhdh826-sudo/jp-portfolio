// UI-9I Phase 1: T0（今日）view の render 契約（renderToStaticMarkup で実 DOM 文字列を検証）。
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { assembleTodayHomeViewModel } from '../../presentation/ui9i/todayHome'
import {
  UNAVAILABLE_ALLOCATION,
  baseInputs,
  fixtureDecision,
  fixtureEntry,
  fixtureSynthesis,
  scenarioInputs,
  type HomeScenario,
} from '../../presentation/ui9i/ui9i.fixtures'
import { TodayHomeView } from './TodayHomeView'

const actions = { onOpenAudit: () => {}, onOpenPortfolio: () => {}, onOpenCandidates: () => {} }

function render(scenario: HomeScenario | ReturnType<typeof baseInputs>): string {
  const inputs = typeof scenario === 'string' ? scenarioInputs(scenario) : scenario
  return renderToStaticMarkup(
    <TodayHomeView vm={assembleTodayHomeViewModel(inputs)} dateLabel="10月6日（月）" actions={actions} />,
  )
}

/** 表示テキストの出現位置（セクション順の検証用）。 */
const pos = (html: string, needle: string) => html.indexOf(needle)

describe('NORMAL', () => {
  const html = render('normal')

  it('Hero: OfficialDecision.headline を h1 に表示。副文は出さない', () => {
    expect(html).toMatch(/<h1[^>]*data-testid="hero-headline"[^>]*>慎重運用<\/h1>/)
    expect(html).not.toContain('data-testid="hero-secondary"')
  })

  it('静かな状態: 注目ポイント節を出さず、チップは「重要な注意 なし」', () => {
    expect(html).not.toContain('注目ポイント')
    expect(html).toMatch(/data-testid="chip-attention">なし</)
    expect(html).toMatch(/data-testid="chip-regime">中立</)
    expect(html).toMatch(/data-testid="chip-mode">通常</)
  })

  it('候補: 提示順で 保有/新規 + 市場スコア + 要レビュー。BUY_NEW を Home 前面に出さない', () => {
    expect(html).toContain('0 実行可能 · 3 要レビュー')
    expect(pos(html, '8725 MS&amp;AD')).toBeLessThan(pos(html, '6098 リクルートHD'))
    expect(pos(html, '6098 リクルートHD')).toBeLessThan(pos(html, '5021 コスモエネルギー'))
    expect(html).toContain('市場スコア 81')
    expect(html).not.toContain('BUY_NEW')
    expect(html).toContain('実行可能な候補はありません。評価は正常です。')
  })

  it('マーケット: VIX（米）と 日経VI が別項目。値を取り違えない', () => {
    expect(html).toMatch(/data-indicator="vix"[\s\S]*?<dt>VIX（米）<\/dt><dd data-testid="market-vix">14\.8<\/dd>/)
    expect(html).toMatch(/data-indicator="nikkeiVi"[\s\S]*?<dt>日経VI<\/dt><dd data-testid="market-nikkeiVi">22\.4<\/dd>/)
  })

  it('ポートフォリオ: ドーナツ=構成、バー=目標との差。モバイル要約 + 6クラス全件（desktop）', () => {
    expect(html).toContain('総資産 3,800万円')
    expect(html).toContain('35 / 30 ・超過 190万円')
    expect(html).toContain('現金リザーブ')
    expect(html).toContain('国内投信・海外投信・金は目標水準です')
    expect(html).toContain('u9-pf-full')
  })

  it('判断生成時刻は絶対時刻（JST）', () => {
    expect(html).toContain('判断生成 10/6 8:30')
  })
})

describe('実行可能な候補あり（節の位置を変えない）', () => {
  const html = render('actionable')

  it('実行可能額（権限提示）と実行可能現金を canonical 値で表示', () => {
    expect(html).toContain('1 実行可能 · 2 要レビュー')
    expect(html).toContain('実行可能額（権限提示）')
    expect(html).toMatch(/data-testid="candidate-amount">¥400,000</)
    expect(html).toMatch(/data-testid="deployable-cash"[^>]*>¥1,200,000</)
  })

  it('90日ロックを注目ポイントに表示（売却可能予定日）', () => {
    expect(html).toContain('9697 は 90日ロック中')
    expect(html).toContain('売却可能予定日 10/20')
  })
})

describe('候補評価が利用できない（判断は有効）', () => {
  const html = render('candidate_unavailable')

  it('「候補なし」ではなく「候補評価を利用できません」。Hero・配分は影響を受けない', () => {
    expect(html).toContain('候補評価を利用できません')
    expect(html).toContain('「候補なし」とは異なります')
    expect(html).not.toContain('現在、実行可能な候補はありません')
    expect(html).toMatch(/<h1[^>]*>慎重運用<\/h1>/)
    expect(html).toContain('data-testid="portfolio-card"')
    expect(html).toContain('候補の評価のみに影響しています')
  })
})

describe('SAFE_MODE', () => {
  const html = render('safe_mode')

  it('SAFE MODE 帯 + 新規買付を停止しています + 運用は継続しています。赤いエラー表現ではない', () => {
    expect(html).toContain('data-testid="safe-mode-banner"')
    expect(html).toContain('新規買付を停止しています')
    expect(html).toContain('運用は継続しています。')
    expect(html).not.toContain('data-tone="critical"')
    expect(html).toContain('data-tone="warm"')
  })

  it('要レビュー候補は残り、実行のみ停止と明示。実行可能額は出さない', () => {
    expect(html).toContain('SAFE MODE により新規実行を停止中')
    expect(html).toContain('8725 MS&amp;AD')
    expect(html).toContain('0 実行可能 · 3 要レビュー')
    expect(html).not.toContain('data-testid="candidate-amount"')
    expect(html).toContain('候補の評価は正常です。実行のみを停止しています。')
  })

  it('チップ: 運用モード 警戒、注意 2件（セーフモード + 90日ロック）', () => {
    expect(html).toMatch(/data-testid="chip-mode">警戒</)
    expect(html).toMatch(/data-testid="chip-attention">2件</)
    expect(html).toContain('セーフモードが有効です')
    expect(html).toContain('新規買付・リバランスを停止中')
  })
})

describe('DATA_WAIT', () => {
  const html = render('data_wait')

  it('データ更新待ち。HOLD / 弱気 / 売却ではないと明示', () => {
    expect(html).toMatch(/<h1[^>]*>データ更新待ち<\/h1>/)
    expect(html).toContain('これは「様子見（HOLD）」でも弱気でも売却でもありません。')
    expect(html).toContain('data-tone="neutral"')
  })

  it('総現金と実行可能現金を分離。利用不可を ¥0 にしない', () => {
    expect(html).toMatch(/data-testid="gross-cash">266万円</)
    expect(html).toMatch(/data-testid="deployable-cash" data-unavailable="true">利用不可</)
    expect(html).not.toMatch(/data-testid="deployable-cash"[^>]*>¥0</)
    expect(html).not.toContain('¥0')
  })

  it('データの状態はデータセット別の絶対時刻。全体の「正常」にまとめない', () => {
    expect(html).toContain('データの状態')
    expect(html).toContain('市場データ')
    expect(html).toContain('10/6 8:30')
    expect(html).toContain('ひとつの遅延から全体の無効は推定しません')
    expect(html).toContain('更新待ち')
  })
})

describe('判断結果を利用できません', () => {
  const html = render('decision_unavailable')

  it('過去の判断を現在として扱わない。利用できない情報 / 安全に確認できる情報を分離', () => {
    expect(html).toMatch(/<h1[^>]*>判断結果を利用できません<\/h1>/)
    expect(html).toContain('過去の判断は現在のものとして扱いません')
    expect(html).toContain('利用できない情報')
    expect(html).toContain('安全に確認できる情報')
    expect(html).not.toContain('判断生成 ')
  })

  it('候補セクションやチップは出さない（Hero の権限が無いため）', () => {
    expect(html).not.toContain('data-testid="state-chips"')
    expect(html).not.toContain('data-testid="candidate-card"')
  })
})

describe('boot', () => {
  it('起動中は SAFE MODE / 判断結果を利用できません を出さない', () => {
    const html = render('boot')
    expect(html).not.toContain('SAFE MODE')
    expect(html).not.toContain('判断結果を利用できません')
    expect(html).toContain('起動中')
  })
})

describe('レイアウトの安定性: セクションの DOM 順は状態によらず固定', () => {
  const order = ['data-testid="hero-headline"', 'data-testid="state-chips"', 'data-testid="candidate-card"', 'data-testid="portfolio-card"', 'data-testid="market-card"']
  const states: HomeScenario[] = ['normal', 'actionable', 'candidate_unavailable', 'safe_mode', 'data_wait']

  for (const scenario of states) {
    it(`${scenario}: Hero → チップ → 候補 → ポートフォリオ → マーケット`, () => {
      const html = render(scenario)
      const positions = order.map(o => pos(html, o))
      expect(positions.every(p => p >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    })
  }

  it('注目ポイント / データの状態は Hero・チップの後、候補の前（挿入されても順序を保つ）', () => {
    const attention = render('safe_mode')
    expect(pos(attention, 'data-testid="attention-card"')).toBeGreaterThan(pos(attention, 'data-testid="state-chips"'))
    expect(pos(attention, 'data-testid="attention-card"')).toBeLessThan(pos(attention, 'data-testid="candidate-card"'))
    const dataWait = render('data_wait')
    expect(pos(dataWait, 'data-testid="data-status-card"')).toBeLessThan(pos(dataWait, 'data-testid="candidate-card"'))
  })
})

describe('配分スナップショット不可 / 候補の canonical 順', () => {
  it('配分不可は「配分の判定不能」。Hero は変わらない', () => {
    const html = render(baseInputs({ allocation: UNAVAILABLE_ALLOCATION }))
    expect(html).toContain('配分の判定不能')
    expect(html).toContain('判定不能')
    expect(html).toMatch(/<h1[^>]*>慎重運用<\/h1>/)
  })

  it('UI は候補を再ランクしない（DOM 上も提示順）', () => {
    const html = render(baseInputs({
      synthesis: fixtureSynthesis([], [
        fixtureEntry('1111', { displayName: '低スコア先頭', candidateQuality: { marketScore: 5 } }),
        fixtureEntry('2222', { displayName: '高スコア後続', candidateQuality: { marketScore: 95 } }),
      ]),
    }))
    expect(pos(html, '1111 低スコア先頭')).toBeLessThan(pos(html, '2222 高スコア後続'))
  })

  it('判断が normal なら Hero headline は OfficialDecision のまま（別 headline に差し替わらない）', () => {
    const html = render(baseInputs({ officialDecision: fixtureDecision({ headline: '攻守バランス' }) }))
    expect(html).toMatch(/<h1[^>]*>攻守バランス<\/h1>/)
    expect(html).not.toContain('慎重運用')
  })
})

describe('アクセシビリティ / 文言', () => {
  it('Hero 画像は装飾（aria-hidden）で、画像上に文字を重ねない', () => {
    const html = render('normal')
    expect(html).toMatch(/data-testid="hero-image-slot" aria-hidden="true"/)
    expect(html).not.toContain('PHOTO')
  })

  it('色だけに依存しない: 状態は文字（要レビュー / 更新待ち / 利用不可）で示す', () => {
    expect(render('normal')).toContain('要レビュー')
    expect(render('data_wait')).toContain('更新待ち')
    expect(render('data_wait')).toContain('利用不可')
  })

  it('h1 はページに 1 つ（Hero headline）', () => {
    for (const s of ['normal', 'safe_mode', 'data_wait', 'decision_unavailable'] as HomeScenario[]) {
      expect((render(s).match(/<h1[ >]/g) ?? []).length).toBe(1)
    }
  })
})
