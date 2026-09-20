// UI-9I Phase 2B-1: 個別株（旧 T1）presentation の契約。
// 「機能は保つ・権限は増やさない」: 判断は deriveDisplayDecision、ロックは isSellLocked/getSellableDate（now 注入）、
// SAFE_MODE は selectEffectiveSafeModeActive、候補は synthesis の canonical 順と Home と共通の射影。
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- repository intentionally has no @types/node
import { readFileSync } from 'node:fs'
import type { AppState } from '../../types'
import { createAppStoreInstanceForTest } from '../../store/useAppStore'
import { deriveDisplayDecision } from '../../domain/analysis/displayDecision'
import { getSellableDate, isSellLocked } from '../../domain/constraints/stockLock'
import { projectCandidateSection } from './candidatePresentation'
import {
  STOCK_DECISION_LABEL,
  assembleStockDetail,
  assembleStocksList,
  buildStockAnalysis,
  orderStockHoldings,
  projectStockCandidates,
  relationshipLabelOf,
  selectStockDetailViewModel,
  selectStocksListViewModel,
  type DecisionContext,
  type StockDetailFound,
  type StocksListInputs,
} from './stocksPresentation'
import { candidateProjectionContextFor, type HeroState } from './todayHome'
import {
  FIXTURE_NOW_MS,
  fixtureAnalysis,
  fixtureDecision,
  fixtureEntry,
  fixtureExecutableDecision,
  fixtureHolding,
  fixtureReviewWatchList,
  fixtureStockHoldings,
  fixtureSynthesis,
} from './ui9i.fixtures'

const NOW = new Date(FIXTURE_NOW_MS) // 2026-10-06 08:40 JST

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return { officialDecision: fixtureDecision(), dqSuppressed: false, capExceeded: false, safeModeActive: false, now: NOW, ...overrides }
}

function listInputs(overrides: Partial<StocksListInputs> = {}): StocksListInputs {
  const { holdings, analysis } = fixtureStockHoldings()
  return {
    holdings, analysis,
    decisionContext: ctx(),
    analysisLastRunAt: '2026-10-06T08:30:00+09:00',
    dqReason: null,
    holdingsStale: false,
    portfolioStale: false,
    synthesis: fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList().slice(1)),
    rawCandidates: [],
    rawFunnelAvailable: true,
    heroState: 'normal',
    ...overrides,
  }
}

function detail(code: string, overrides: Partial<Parameters<typeof assembleStockDetail>[0]> = {}): StockDetailFound {
  const { holdings, analysis } = fixtureStockHoldings()
  const vm = assembleStockDetail({
    code, holdings, analysis, stockScores6Axis: null, decisionContext: ctx(),
    analysisLastRunAt: '2026-10-06T08:30:00+09:00', holdingsStale: false,
    synthesis: fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList().slice(1)),
    rawCandidates: [], heroState: 'normal', ...overrides,
  })
  if (!vm.found) throw new Error(`stock ${code} not found`)
  return vm
}

const row = (vm: ReturnType<typeof assembleStocksList>, code: string) => {
  const r = vm.rows.find(x => x.code === code)
  if (!r) throw new Error(`row ${code} missing`)
  return r
}

describe('一覧の順序（旧 StockList の移設。新しいランキングではない）', () => {
  it('h.decision の BUY→HOLD→SELL、次に totalScore 降順（INSUFFICIENT_EVIDENCE は HOLD と同順位）', () => {
    const vm = assembleStocksList(listInputs())
    expect(vm.rows.map(r => r.code)).toEqual(['9697', '6098', '8306', '8035'])
  })

  it('入力順に依存しない（同じ集合は同じ順序）。分析が無い銘柄は totalScore 0 として扱う', () => {
    const { holdings, analysis } = fixtureStockHoldings()
    const forward = orderStockHoldings(holdings, analysis).map(h => h.code)
    const backward = orderStockHoldings([...holdings].reverse(), analysis).map(h => h.code)
    expect(backward).toEqual(forward)
    const noAnalysis = orderStockHoldings([fixtureHolding('1111'), fixtureHolding('2222')], [fixtureAnalysis('2222', { totalScore: 90 })])
    expect(noAnalysis.map(h => h.code)).toEqual(['2222', '1111'])
  })

  it('比較表・行のいずれも新しい並べ替え軸（損益 / スコア / 判断）を持たない: 順序は 1 箇所（orderStockHoldings）だけ', () => {
    const src: string = readFileSync(new URL('./stocksPresentation.ts', import.meta.url), 'utf8')
    expect(src.match(/\.sort\(/g)).toHaveLength(1)
    expect(src.indexOf('.sort(')).toBeGreaterThan(src.indexOf('export function orderStockHoldings'))
    expect(src.indexOf('.sort(')).toBeLessThan(src.indexOf('// ── 一覧 ──'))
  })
})

describe('保有 / 新規（canonical 関係。推測しない）', () => {
  it('保有一覧の行は「保有」。候補は entry.relationship をそのまま「保有」「新規」に写像する', () => {
    const vm = assembleStocksList(listInputs())
    expect(new Set(vm.rows.map(r => r.relationshipLabel))).toEqual(new Set(['保有']))
    expect(vm.candidates.status).toBe('available')
    if (vm.candidates.status !== 'available') return
    const byCode = Object.fromEntries(vm.candidates.rows.map(r => [r.code, r.relationshipLabel]))
    expect(byCode['8725']).toBe('新規') // BUY_NEW / new_to_portfolio
    expect(byCode['6098']).toBe('保有') // already_held
    expect(byCode['5021']).toBe('新規')
  })

  it('未知の関係値は推測せずラベルなし（null）', () => {
    expect(relationshipLabelOf('already_held')).toBe('保有')
    expect(relationshipLabelOf('new_to_portfolio')).toBe('新規')
    expect(relationshipLabelOf('unknown')).toBeNull()
    expect(relationshipLabelOf('')).toBeNull()
  })
})

describe('判断の権限: deriveDisplayDecision（再計算しない）', () => {
  it('全行・全条件で、行の decision は同じ入力での deriveDisplayDecision と一致する', () => {
    for (const c of [ctx(), ctx({ safeModeActive: true }), ctx({ dqSuppressed: true }), ctx({ capExceeded: true })]) {
      const inputs = listInputs({ decisionContext: c })
      const vm = assembleStocksList(inputs)
      for (const h of inputs.holdings) {
        const expected = deriveDisplayDecision({
          hDecision: h.decision, officialAction: undefined, dqSuppressed: c.dqSuppressed,
          locked: isSellLocked(h, NOW), capExceeded: c.capExceeded, safeModeActive: c.safeModeActive,
        })
        expect(row(vm, h.code).decision, `${h.code}/${JSON.stringify({ ...c, now: undefined })}`).toBe(expected)
        expect(row(vm, h.code).decisionLabel).toBe(STOCK_DECISION_LABEL[expected])
      }
    }
  })

  it('SAFE_MODE 中: BUY は待機になり、SELL / HOLD は消えない。SAFE_MODE は分析情報を消さない', () => {
    const vm = assembleStocksList(listInputs({ decisionContext: ctx({ safeModeActive: true }), heroState: 'safe_mode' }))
    expect(row(vm, '9697').decision).toBe('WAIT')
    expect(row(vm, '8035').decision).toBe('SELL')
    expect(row(vm, '6098').decision).toBe('HOLD')
    // スコア / ランクなどの分析は SAFE_MODE でも表示される（実行可否だけが変わる）。
    expect(row(vm, '9697').score).toBe(78)
    expect(row(vm, '6098').strategyRank).toBe('B')
    expect(vm.notices.map(n => n.id)).toContain('safe_mode')
  })

  it('全体データ品質低下: BUY だけ「更新待ち」（DATA_WAIT）。他の判断・状態は局所のまま', () => {
    const vm = assembleStocksList(listInputs({ decisionContext: ctx({ dqSuppressed: true }), dqReason: 'データ取得エラー — 新規買いを停止しています' }))
    expect(row(vm, '9697').decision).toBe('DATA_WAIT')
    expect(row(vm, '9697').decisionLabel).toBe('更新待ち')
    expect(row(vm, '8035').decision).toBe('SELL')
    expect(vm.notices.find(n => n.id === 'data_quality')?.text).toContain('データ取得エラー')
  })

  it('officialDecision の SELL はロック中は待機（売却不可）へ抑止される（既存 authority のまま）', () => {
    const { holdings, analysis } = fixtureStockHoldings()
    const withOfficialSell = ctx({
      officialDecision: fixtureDecision({ actions: [{ id: 'a', assetType: 'stock', code: '9697', name: 'カプコン', action: 'SELL', reason: 't', source: 'committee' }] }),
    })
    const vm = assembleStocksList(listInputs({ holdings: holdings.map(h => (h.code === '9697' ? { ...h, decision: 'HOLD' as const } : h)), analysis, decisionContext: withOfficialSell }))
    expect(row(vm, '9697').locked).toBe(true)
    expect(row(vm, '9697').decision).toBe('WAIT')
  })
})

describe('INSUFFICIENT_EVIDENCE は銘柄の局所状態（全体状態へ昇格しない）', () => {
  it('8306: 判断材料不足。スコア / ランクは判断の根拠として出さず、他の銘柄・全体の通知に波及しない', () => {
    const vm = assembleStocksList(listInputs())
    const r = row(vm, '8306')
    expect(r.decision).toBe('INSUFFICIENT_EVIDENCE')
    expect(r.decisionLabel).toBe('判断材料不足')
    expect(r.score).toBeNull()
    expect(r.strategyRank).toBeNull()
    expect(vm.rows.filter(x => x.decision === 'INSUFFICIENT_EVIDENCE')).toHaveLength(1)
    expect(vm.notices).toEqual([])
    expect(JSON.stringify(vm.notices)).not.toMatch(/SAFE_MODE|更新待ち|判断結果を利用できません/)
    expect(row(vm, '6098').score).toBe(66)
  })

  it('SAFE_MODE / DATA_WAIT の全体条件でも 8306 は判断材料不足のまま（売却・待機へ上書きされない）', () => {
    const vm = assembleStocksList(listInputs({ decisionContext: ctx({ safeModeActive: true, dqSuppressed: true }) }))
    expect(row(vm, '8306').decision).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('詳細: 局所の制約として説明し、不足している項目（未取得）を示す。分析値は参考表示に留める', () => {
    const d = detail('8306')
    expect(d.insufficient).toBe(true)
    expect(d.decisionLabel).toBe('判断材料不足')
    expect(d.constraints.map(c => c.id)).toEqual(['insufficient'])
    expect(d.evidence).toEqual(expect.arrayContaining([
      { label: 'ファンダメンタル', value: '未取得' },
      { label: 'テクニカル', value: '未取得' },
    ]))
    expect(d.evidenceNote).toContain('参考表示')
    expect(d.score).toBeNull()
    expect(d.rank).toBeNull()
    expect(d.comment).toContain('判断材料不足')
    expect(d.stance).toBe('判断材料不足 / 再評価待ち')
    expect(d.conclusionTitle).toBe('判断材料不足')
    expect(d.analysis).not.toBeNull() // 参考表示として残す（機能は削除しない）
  })
})

describe('売却ロック: isSellLocked / getSellableDate（now は注入。壁時計に依存しない）', () => {
  it('取得日 2026-07-22 + 90 日 = 2026-10-20。注入した now が境界を跨ぐと結果が変わる', () => {
    const h = fixtureStockHoldings().holdings.find(x => x.code === '9697')!
    expect(getSellableDate(h)).toBe('2026-10-20')
    const before = detail('9697')
    expect(before.locked).toBe(true)
    expect(before.lockNote?.text).toContain('売却可能予定日: 2026-10-20')
    expect(before.lockNote?.text).toContain('取得日: 2026-07-22')

    const after = detail('9697', { decisionContext: ctx({ now: new Date('2026-10-21T00:00:00+09:00') }) })
    expect(after.locked).toBe(false)
    expect(after.lockNote).toBeNull()
    expect(after.lockReleasedNote).toContain('ロック期間終了')
  })

  it('一覧の「ロック」件数 / バッジは isSellLocked の結果と一致する', () => {
    const inputs = listInputs()
    const vm = assembleStocksList(inputs)
    expect(vm.rows.filter(r => r.locked).map(r => r.code)).toEqual(inputs.holdings.filter(h => isSellLocked(h, NOW)).map(h => h.code).sort((a, b) => vm.rows.findIndex(r => r.code === a) - vm.rows.findIndex(r => r.code === b)))
    expect(vm.countLabel).toBe('4 銘柄 — 買い 1 / ロック 1')
  })

  it('presentation は壁時計・日付算術を持たない（Date.now / new Date() / 90 日計算の自前実装なし）', () => {
    const src: string = readFileSync(new URL('./stocksPresentation.ts', import.meta.url), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code.match(/Date\.now\(\)/g)).toHaveLength(2) // selectStocksListViewModel / selectStockDetailViewModel の既定 now（Home と同じ注入点）のみ
    expect(code).not.toMatch(/new Date\(\)/)
    expect(code).not.toMatch(/setDate|getDate\(|86400000|90\s*\*/)
  })
})

describe('候補: Home と共通の射影（実行可否・金額・関係）で矛盾しない', () => {
  const synthesis = fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList())
  const heroStates: HeroState[] = ['normal', 'safe_mode', 'data_wait', 'decision_unavailable']

  it('先頭 3 件の 状態語 / kind / 金額 / 関係 は Home の候補プレビューと同一（全 hero 状態）', () => {
    for (const heroState of heroStates) {
      const t1 = projectStockCandidates({ synthesis, rawCandidates: [], rawFunnelAvailable: true, heroState })
      const home = projectCandidateSection(synthesis, candidateProjectionContextFor(heroState))
      expect(t1.status).toBe('available')
      if (t1.status !== 'available') return
      const pick = (r: { entryId: string; kind: string; stateLabel: string | null; executableAmountJpy: number | null; relationshipLabel: string }) =>
        ({ entryId: r.entryId, kind: r.kind, stateLabel: r.stateLabel, amount: r.executableAmountJpy, rel: r.relationshipLabel })
      expect(t1.rows.slice(0, 3).map(pick), heroState).toEqual(home.rows.map(pick))
    }
  })

  it('SAFE_MODE: money=EXECUTABLE でも金額を出さず「実行できません（分析・レビューは有効）」を示す。実行可能語は出さない', () => {
    const t1 = projectStockCandidates({ synthesis, rawCandidates: [], rawFunnelAvailable: true, heroState: 'safe_mode' })
    if (t1.status !== 'available') throw new Error('unavailable')
    const exec = t1.rows.find(r => r.code === '8725')!
    expect(exec.executableAmountLabel).toBeNull()
    expect(exec.suppressedNote).toContain('SAFE_MODE')
    expect(t1.rows.every(r => r.stateLabel !== '実行可能')).toBe(true)
  })

  it('通常時: 実行可能額は entry.money の値をそのまま（¥400,000）。計算しない', () => {
    const t1 = projectStockCandidates({ synthesis, rawCandidates: [], rawFunnelAvailable: true, heroState: 'normal' })
    if (t1.status !== 'available') throw new Error('unavailable')
    expect(t1.rows.find(r => r.code === '8725')?.executableAmountLabel).toBe('¥400,000')
  })

  it('利用不可を ¥0 にしない: NOT_EXECUTABLE は金額なし + 理由（または利用不可）で、¥0 が現れない', () => {
    const blocked = fixtureEntry('9999', { action: 'BLOCKED', blockingReasons: ['INSUFFICIENT_CASH'] })
    const t1 = projectStockCandidates({ synthesis: fixtureSynthesis([], [blocked]), rawCandidates: [], rawFunnelAvailable: true, heroState: 'normal' })
    if (t1.status !== 'available') throw new Error('unavailable')
    expect(t1.rows[0].executableAmountLabel).toBeNull()
    expect(t1.rows[0].nonExecutableReason).not.toBeNull()
    expect(JSON.stringify(t1)).not.toContain('¥0')
  })

  it('詳細の「候補との関係」: 同じコードの synthesis entry（既保有）を Home と同じ行で示す。無ければ出さない', () => {
    const d = detail('6098')
    expect(d.candidate?.relationshipLabel).toBe('保有')
    expect(d.candidate?.code).toBe('6098')
    expect(detail('8035').candidate).toBeNull()
  })
})

describe('スコアは実際の権限名でのみ表示する', () => {
  it('総合スコア / 総合ランク / 信頼度 / 市場スコア。AIスコア・買いスコア・総合おすすめ度・期待収益は使わない', () => {
    const d = detail('6098')
    expect(d.score).toBe(66)
    expect(d.rank).toBe('B')
    expect(d.confidenceLabel).toBe('70%')
    for (const file of ['./stocksPresentation.ts', '../../components/ui9i/StocksViews.tsx']) {
      const src: string = readFileSync(new URL(file, import.meta.url), 'utf8')
      for (const bad of ['AIスコア', '買いスコア', '総合おすすめ度', '期待収益', 'おすすめ']) {
        expect(src, `${file}:${bad}`).not.toContain(bad)
      }
    }
  })

  it('分析結果が無い銘柄は、未算出を 50 などの既定値で埋めず「分析結果なし」とする（軸・レーダー・リスクゲートとも）', () => {
    const { holdings } = fixtureStockHoldings()
    const d = detail('6098', { holdings, analysis: [] })
    expect(d.analysis).toBeNull()
    expect(d.riskGate).toBeNull()
    expect(d.confidenceLabel).toBeNull()
    expect(d.score).toBeNull()
    expect(d.rank).toBeNull()
  })

  it('8 軸の値の作り方は旧 T1 と同一（debate.sevenAxis / サブスコアの 0–100 正規化 / 配当成長）', () => {
    const h = fixtureHolding('1111', { divG: 4 })
    const a = fixtureAnalysis('1111', { fundamentalScore: 15, qualityScore: 5, technicalScore: 10 })
    const an = buildStockAnalysis(h, a)
    expect(an.axes.map(x => x.label)).toEqual(['割安度', '稼ぐ力', '成長性', '安全性', 'トレンド', '需給', '還元力', '事業独自性'])
    expect(an.axes.map(x => Math.round(x.value))).toEqual([55, 50, 58, 50, 60, 50, 98, 65])
    expect(an.fundamentals).toHaveLength(8)
    expect(an.technicals).toHaveLength(7)
  })
})

describe('詳細の構成（機能保存: 旧 T1 の全セクションに対応する値が VM にある）', () => {
  const d = detail('6098')

  it('判断 / 理由 / 制約 / 保有 / 実行条件 / PF 位置づけ / 根拠 / 補助分析 の各値を持つ', () => {
    expect(d.decisionLabel).toBe('保有継続')
    expect(d.comment).toBe('継続保有を基本に、決算を確認します。')
    expect(d.recommendedAction).toBe('継続保有を基本に、決算を確認します。')
    expect(d.reasons.bull).toEqual(['資本効率が高い'])
    expect(d.reasons.bear).toEqual(['金利上昇が逆風'])
    expect(d.reasons.takeProfit).toEqual(['目標株価に到達'])
    expect(d.reasons.stopLoss).toEqual(['アラートラインを割り込む'])
    expect(d.reasons.wait).toEqual(['条件未達のため様子見'])
    expect(d.premiseBreak).toEqual(['決算下方修正'])
    expect(d.riskGate).toEqual({ pass: true, label: '通過 — 実行可', sub: '実行条件を充足' })
    expect(d.position.map(p => p.label)).toEqual(['評価額', '損益率', '3Mモメンタム', 'EV', 'RSI', 'β（ベータ）'])
    expect(d.executionPlan.targetPriceLabel).toBe('2,400円')
    expect(d.executionPlan.targetSub).toBe('20.0% 上昇余地')
    expect(d.executionPlan.alertPriceLabel).toBe('1,700円')
    expect(d.executionPlan.alertSub).toBe('-15.0% 下落で発動')
    expect(d.portfolioRole.headline).toContain('標準ベータ株')
    expect(d.portfolioStanding.text).toBe('現状維持。次のシグナルを待つ。')
    expect(d.analysis?.keyMetrics.map(m => m.label)).toEqual(['PER', 'PBR', 'ROE', 'EPS成長', 'D/Eレシオ', '配当成長'])
  })

  it('TierA T1 警告（含み損 -40% 以下）はロック中でも残る（自動売却しない旨を含む）', () => {
    const { holdings, analysis } = fixtureStockHoldings()
    const d2 = detail('9697', { holdings: holdings.map(h => (h.code === '9697' ? { ...h, pnlPct: -45 } : h)), analysis })
    expect(d2.locked).toBe(true)
    expect(d2.stopLossNote?.text).toContain('自動売却は行いません')
    expect(d2.stopLossNote?.text).toContain('3ヶ月ロック中でもこの警告は表示され続けます')
  })

  it('SAFE_MODE / 上限超過 / DQ の BUY は制約として個別に説明される（推測せず、入力フラグをそのまま反映）', () => {
    const buy = (c: Partial<DecisionContext>) => detail('9697', { decisionContext: ctx(c) }).constraints.map(x => x.id)
    expect(buy({ safeModeActive: true })).toContain('safe_mode')
    expect(buy({ capExceeded: true })).toContain('cap_exceeded')
    expect(buy({ dqSuppressed: true })).toContain('data_quality')
    expect(buy({})).toEqual([]) // 売却ロックは constraints ではなく lockNote（別枠）
  })

  it('存在しない銘柄コードは found=false（旧 T1 の「銘柄データなし」）', () => {
    const vm = assembleStockDetail({
      code: '0000', holdings: [], analysis: [], stockScores6Axis: null, decisionContext: ctx(), analysisLastRunAt: null,
      holdingsStale: false, synthesis: null, rawCandidates: [], heroState: 'normal',
    })
    expect(vm).toEqual({ found: false, code: '0000' })
  })
})

describe('鮮度は情報源ごと（T1 全体の stale 閾値を作らない）', () => {
  it('保有データの鮮度 / 全体データ品質 / 分析時刻 / 候補の保有データ鮮度は、それぞれの入力だけを反映する', () => {
    const base = assembleStocksList(listInputs())
    expect(base.notices).toEqual([])
    expect(base.candidateNotice).toBeNull()
    expect(base.analysisTimeLabel).toBe('10/6 8:30')

    const holdingsStale = assembleStocksList(listInputs({ holdingsStale: true }))
    expect(holdingsStale.notices.map(n => n.id)).toEqual(['holdings_stale'])
    expect(holdingsStale.rows.map(r => r.decision)).toEqual(base.rows.map(r => r.decision)) // 判断は変えない

    const portfolioStale = assembleStocksList(listInputs({ portfolioStale: true }))
    expect(portfolioStale.notices).toEqual([])
    expect(portfolioStale.candidateNotice).toContain('保有データが古い可能性')

    expect(assembleStocksList(listInputs({ analysisLastRunAt: null })).analysisTimeLabel).toBeNull()
  })

  it('presentation は T1 独自の鮮度閾値（TTL / 経過時間の比較）を持たない', () => {
    const src: string = readFileSync(new URL('./stocksPresentation.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/TTL|STALE_|staleAfter|MAX_AGE|maxAgeMs|3600|60 \* 60/)
  })
})

describe('実 store（canonical selector）経由', () => {
  const isolated = createAppStoreInstanceForTest()
  const BASE: AppState = isolated.store.getState()
  isolated.controls.dispose()

  const FRESH = '2026-10-06T08:30:00+09:00'
  const { holdings, analysis } = fixtureStockHoldings()

  function ready(safeModeActive: boolean): AppState {
    return {
      ...BASE,
      holdings, analysis,
      system: {
        ...BASE.system,
        status: 'success',
        analysisLastRunAt: FRESH,
        dataSourceStatus: { ...BASE.system.dataSourceStatus, market: 'loaded', macro: 'loaded', nikkeiVI: 'loaded', safeMode: 'loaded' },
        dataTimestamps: { ...(BASE.system.dataTimestamps as NonNullable<AppState['system']['dataTimestamps']>), market: '2026-10-06 08:30', safeMode: FRESH },
      },
      safeMode: { ...BASE.safeMode, safe_mode: { ...BASE.safeMode.safe_mode, active: safeModeActive, last_checked: FRESH } },
      market: { ...BASE.market, last_updated: '2026-10-06 08:30', vix: 14.8 },
      officialDecision: fixtureDecision(),
    }
  }

  it('SAFE_MODE は selectEffectiveSafeModeActive に従う（ローカル推定なし）: active=false → BUY のまま / true → 待機', () => {
    const normal = selectStocksListViewModel(ready(false), FIXTURE_NOW_MS)
    expect(row(normal, '9697').decision).toBe('BUY')
    expect(normal.notices.map(n => n.id)).not.toContain('safe_mode')
    const safe = selectStocksListViewModel(ready(true), FIXTURE_NOW_MS)
    expect(row(safe, '9697').decision).toBe('WAIT')
    expect(safe.notices.map(n => n.id)).toContain('safe_mode')
  })

  it('注入した now でロック判定が変わる（壁時計に依存しない）', () => {
    const during = selectStockDetailViewModel(ready(false), '9697', FIXTURE_NOW_MS)
    const after = selectStockDetailViewModel(ready(false), '9697', Date.parse('2026-10-25T09:00:00+09:00'))
    expect(during.found && during.locked).toBe(true)
    expect(after.found && after.locked).toBe(false)
  })

  it('fresh store（boot・候補未計算）でも一覧は成立し、候補は「更新待ち」の局所状態（銘柄行を無効化しない）', () => {
    const vm = selectStocksListViewModel({ ...BASE, holdings, analysis }, FIXTURE_NOW_MS)
    expect(vm.rows).toHaveLength(4)
    expect(vm.candidates.status).toBe('unavailable')
  })
})

describe('SECOND_ENGINE（presentation / view のソース走査）', () => {
  const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
  const strip = (s: string) => s.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')

  it('新しい BUY/SELL 推論・現金 / 金額の算術・SAFE_MODE / 全体有効性の推論・目標配分計算・履歴フォールバックがない', () => {
    for (const file of ['./stocksPresentation.ts', '../../components/ui9i/StocksViews.tsx']) {
      const code = strip(read(file))
      expect(code, file).not.toMatch(/\.reduce\(/)
      expect(code, file).not.toMatch(/executableAmountJpy\s*[*/+-]/)
      expect(code, file).not.toMatch(/deployableCash|grossCash|availableCash|cashAssumptions|targetRatio\s*[*/]|targetAmount/)
      expect(code, file).not.toMatch(/safe_mode\.active|newBuysFrozen/) // SAFE_MODE は selectEffectiveSafeModeActive 経由のみ
      // 鮮度: 読んでよい既存 authority は localStorageFreshness の isStale 1 箇所（候補の保有データ警告）だけ。
      expect((code.match(/isStale/g) ?? []).length, file).toBeLessThanOrEqual(1)
      expect(code, file).not.toMatch(/finalSuggestedAmount|suggestedAmount|maxAmount|candidatePortfolioRecommendations/)
      expect(code, file).not.toMatch(/localStorage\.|sessionStorage|fetch\(|previousDecision|lastKnown|historical/)
    }
  })

  it('view は判断語を作らない: 判断ラベルは presentation の STOCK_DECISION_LABEL 経由だけ', () => {
    const code = strip(read('../../components/ui9i/StocksViews.tsx'))
    expect(code).not.toMatch(/'(BUY|SELL|HOLD|WAIT|DATA_WAIT)'/)
    expect(code).not.toContain('deriveDisplayDecision')
    expect(code).not.toContain('isSellLocked')
  })
})
