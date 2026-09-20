// UI-9I Phase 1: T0 view-model projector の権限・状態契約。
import { describe, expect, it } from 'vitest'
import {
  assembleTodayHomeViewModel,
  heroCopy,
  isOfficialDecisionUsable,
  resolveHeroStateFromInputs,
} from './todayHome'
import {
  CANONICAL_CLASS_ORDER,
  UNAVAILABLE_ALLOCATION,
  baseInputs,
  fixtureAllocation,
  fixtureDecision,
  fixtureEntry,
  fixtureExecutableDecision,
  fixtureReviewWatchList,
  fixtureSynthesis,
  scenarioInputs,
} from './ui9i.fixtures'

describe('Hero authority = OfficialDecision', () => {
  it('normal: headline は OfficialDecision.headline を verbatim（合成・副文なし）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ headline: '攻守バランス' }) }))
    expect(vm.hero.state).toBe('normal')
    expect(vm.hero.headline).toBe('攻守バランス')
    expect(vm.hero.secondaryCopy).toBeNull()
    expect(vm.hero.eyebrow).toBe('今日の判断')
  })

  it('「今日は何もしない」「追加投資なし」を無関係な状態から合成しない（候補ゼロ・アクションなしでも）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({
      synthesis: fixtureSynthesis([], []),
      officialDecision: fixtureDecision({ headline: '慎重運用', actions: [] }),
    }))
    const json = JSON.stringify(vm.hero)
    expect(json).not.toContain('今日は何もしない')
    expect(json).not.toContain('追加投資なし')
    expect(vm.hero.headline).toBe('慎重運用')
  })

  it('候補・配分・現金がどう変わっても Hero の headline は変わらない', () => {
    const headline = '慎重運用'
    const variants = [
      baseInputs(),
      baseInputs({ synthesis: null }),
      baseInputs({ allocation: UNAVAILABLE_ALLOCATION }),
      baseInputs({ deployableCash: { available: false, amount: 0, unavailableStatus: 'absent' } }),
      baseInputs({ synthesis: fixtureSynthesis([fixtureExecutableDecision()], []) }),
    ]
    for (const inputs of variants) {
      const vm = assembleTodayHomeViewModel(inputs)
      expect(vm.hero.state).toBe('normal')
      expect(vm.hero.headline).toBe(headline)
    }
  })

  it('headline が空の OfficialDecision は Hero の権限として使えない（判断結果を利用できません）', () => {
    expect(isOfficialDecisionUsable(fixtureDecision({ headline: '  ' }))).toBe(false)
    expect(isOfficialDecisionUsable(null)).toBe(false)
    const vm = assembleTodayHomeViewModel(baseInputs({ officialDecision: fixtureDecision({ headline: '' }) }))
    expect(vm.hero.state).toBe('decision_unavailable')
  })
})

describe('状態の分離と優先順位', () => {
  it('boot(initializing) 中は SAFE_MODE（fail-closed 既定 active）も判断不能も表示しない', () => {
    const state = resolveHeroStateFromInputs(scenarioInputs('boot'))
    expect(state).toBe('boot')
    const vm = assembleTodayHomeViewModel(scenarioInputs('boot'))
    expect(vm.hero.state).toBe('boot')
    expect(vm.hero.safeModeBanner).toBe(false)
    expect(vm.chips).toBeNull()
    expect(vm.attention).toEqual([])
  })

  it('OfficialDecision が無い（boot 後）ときだけ「判断結果を利用できません」', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('decision_unavailable'))
    expect(vm.hero.state).toBe('decision_unavailable')
    expect(vm.hero.headline).toBe('判断結果を利用できません')
    expect(vm.hero.secondaryCopy).toContain('過去の判断は現在のものとして扱いません')
    expect(vm.chips).toBeNull()
    expect(vm.unavailableDetail).not.toBeNull()
  })

  it('候補評価の失敗 / 配分スナップショットの失敗 / データ遅延だけでは判断不能にしない', () => {
    for (const inputs of [
      baseInputs({ synthesis: null }),
      baseInputs({ synthesis: fixtureSynthesis([], [], 'invalid') }),
      baseInputs({ allocation: UNAVAILABLE_ALLOCATION }),
      baseInputs({ marketDataOk: false }),
    ]) {
      expect(assembleTodayHomeViewModel(inputs).hero.state).not.toBe('decision_unavailable')
    }
  })

  it('SAFE_MODE(effective): Hero は新規買付停止。運用は継続。エラー表現ではない', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('safe_mode'))
    expect(vm.hero.state).toBe('safe_mode')
    expect(vm.hero.safeModeBanner).toBe(true)
    expect(vm.hero.headline).toBe('新規買付を停止しています')
    expect(vm.hero.secondaryCopy).toBe('運用は継続しています。')
    expect(vm.hero.tone).toBe('warm')
    expect(vm.chips?.mode.label).toBe('警戒')
  })

  it('SAFE_MODE でも有効な要レビュー候補は残し、実行可能語・金額は出さない', () => {
    const inputs = scenarioInputs('safe_mode')
    const withExecutable = { ...inputs, synthesis: fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList().slice(1)) }
    const vm = assembleTodayHomeViewModel(withExecutable)
    expect(vm.candidates.status).toBe('available')
    expect(vm.candidates.rows.length).toBe(3)
    expect(vm.candidates.executableCount).toBe(0)
    expect(vm.candidates.rows.every(r => r.kind === 'review' && r.executableAmountJpy === null)).toBe(true)
  })

  it('DATA_WAIT: 全体データ品質の抑止。HOLD / 弱気 / 売却ではないと明示し、候補は参照のみ', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('data_wait'))
    expect(vm.hero.state).toBe('data_wait')
    expect(vm.hero.headline).toBe('データ更新待ち')
    expect(vm.hero.guardNote).toContain('様子見（HOLD）')
    expect(vm.hero.guardNote).toContain('弱気')
    expect(vm.hero.guardNote).toContain('売却')
    expect(vm.candidates.rows.every(r => r.kind === 'data_wait' && r.stateLabel === '更新待ち')).toBe(true)
    expect(vm.dataStatus.map(r => r.id)).toEqual(['market', 'cash', 'candidates', 'allocation'])
  })

  it('市場データの実時間の抑止（marketDataOk=false）も DATA_WAIT として扱う', () => {
    expect(assembleTodayHomeViewModel(baseInputs({ marketDataOk: false })).hero.state).toBe('data_wait')
  })

  it('優先順位: boot > decision_unavailable > safe_mode > data_wait > normal', () => {
    const both = baseInputs({ safeModeEffective: true, marketDataOk: false })
    expect(resolveHeroStateFromInputs(both)).toBe('safe_mode')
    expect(resolveHeroStateFromInputs({ ...both, officialDecision: null })).toBe('decision_unavailable')
    expect(resolveHeroStateFromInputs({ ...both, systemStatus: 'initializing' })).toBe('boot')
  })

  it('heroCopy: normal は文言を持たない（headline は OfficialDecision）', () => {
    expect(heroCopy('normal')).toBeNull()
    expect(heroCopy('boot')).toBeNull()
  })
})

describe('市場状態: レジームと運用モードは別軸（AllocationConsumerSnapshot）', () => {
  it('regime / marketMode を別々に表示する。5区分 regimeState は使わない', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ allocation: fixtureAllocation({ regime: 'bear', marketMode: 'emergency' }) }))
    expect(vm.chips?.regime.label).toBe('弱気')
    expect(vm.chips?.mode.label).toBe('緊急')
    const neutral = assembleTodayHomeViewModel(baseInputs({ allocation: fixtureAllocation({ regime: 'bull', marketMode: 'caution' }) }))
    expect(neutral.chips?.regime.label).toBe('強気')
    expect(neutral.chips?.mode.label).toBe('警戒')
  })

  it('配分スナップショット不可のときは「判定不能」（0 や中立にしない）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ allocation: UNAVAILABLE_ALLOCATION }))
    expect(vm.chips?.regime).toEqual({ label: '判定不能', available: false })
    expect(vm.chips?.mode).toEqual({ label: '判定不能', available: false })
    expect(vm.portfolio).toBeNull()
  })
})

describe('マーケット指標: VIX と日経VI は別項目', () => {
  it('market.vix → VIX（米）、macro.nikkeiVI → 日経VI。取り違えない', () => {
    const vm = assembleTodayHomeViewModel(baseInputs())
    const byId = Object.fromEntries(vm.market.indicators.map(i => [i.id, i]))
    expect(byId.vix.label).toBe('VIX（米）')
    expect(byId.vix.value).toBe(14.8)
    expect(byId.nikkeiVi.label).toBe('日経VI')
    expect(byId.nikkeiVi.value).toBe(22.4)
    expect(byId.vix.label).not.toContain('日経')
  })

  it('取得できていないフィードの値は表示しない（ビルド同梱値を現在値として出さない）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({
      marketFeed: { ...baseInputs().marketFeed, marketLoaded: false, nikkeiViLoaded: false },
    }))
    const byId = Object.fromEntries(vm.market.indicators.map(i => [i.id, i]))
    expect(byId.nikkei.value).toBeNull()
    expect(byId.vix.value).toBeNull()
    expect(byId.nikkeiVi.value).toBeNull()
    expect(vm.market.asOfLabel).toBeNull()
  })
})

describe('現金: 総現金と実行可能現金を分離し、利用不可を ¥0 にしない', () => {
  it('unavailable は kind=unavailable（amount を持たない）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ deployableCash: { available: false, amount: 0, unavailableStatus: 'absent' } }))
    expect(vm.deployableCash).toEqual({ kind: 'unavailable' })
    expect(JSON.stringify(vm.deployableCash)).not.toContain('amountJpy')
  })

  it('available の 0 円は「確認済みの 0」として残る（unavailable と区別される）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ deployableCash: { available: true, amount: 0, unavailableStatus: null } }))
    expect(vm.deployableCash).toEqual({ kind: 'available', amountJpy: 0 })
  })

  it('総現金は別権限: 配分不可でも手動権限があれば known、DEFAULT の 0 は unknown', () => {
    const manual = assembleTodayHomeViewModel(baseInputs({
      allocation: UNAVAILABLE_ALLOCATION, effectiveCash: { source: 'manual', grossCash: 2_660_000 },
    }))
    expect(manual.grossCash).toEqual({ kind: 'known', amountJpy: 2_660_000 })
    const unset = assembleTodayHomeViewModel(baseInputs({
      allocation: UNAVAILABLE_ALLOCATION, effectiveCash: { source: 'default', grossCash: 0 },
    }))
    expect(unset.grossCash).toEqual({ kind: 'unknown' })
  })
})

describe('注目ポイント / 90日ロック', () => {
  it('通常時は注目ポイントなし（チップは「なし」= 件数 0）', () => {
    const vm = assembleTodayHomeViewModel(baseInputs())
    expect(vm.attention).toEqual([])
    expect(vm.chips?.attentionCount).toBe(0)
  })

  it('ロック中の保有は isSellLocked / getSellableDate の結果をそのまま表示（残日数は計算しない）', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('actionable'))
    const lock = vm.attention.find(a => a.id === 'lock-9697')
    expect(lock?.title).toBe('9697 は 90日ロック中')
    expect(lock?.detail).toBe('売却可能予定日 10/20')
    expect(JSON.stringify(vm.attention)).not.toMatch(/残り|あと\d+日/)
  })

  it('ロックを過ぎた保有は注意に出さない', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ holdings: [{ code: '7203', lock: false, acquiredAt: '2026-01-05' }] }))
    expect(vm.attention).toEqual([])
  })

  it('候補評価が利用できないときは注目ポイントに局所的に出す（Hero は不変）', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('candidate_unavailable'))
    expect(vm.attention.map(a => a.id)).toEqual(['candidate-unavailable'])
    expect(vm.chips?.attentionCount).toBe(1)
    expect(vm.hero.state).toBe('normal')
  })
})

// ═══════════════════════════════════════════════════════════
// F-02 (P1): decision_unavailable は「今日の判断を作れない」だけ。
// 他の権限が生きている情報は消さない。
// ═══════════════════════════════════════════════════════════
describe('F-02 判断不能でも生きている情報を残す', () => {
  const noDecision = (overrides: Partial<ReturnType<typeof baseInputs>> = {}) =>
    assembleTodayHomeViewModel(baseInputs({ officialDecision: null, ...overrides }))

  it('有効なポートフォリオは残る（配分の権限は判断とは別）', () => {
    const vm = noDecision()
    expect(vm.hero.state).toBe('decision_unavailable')
    expect(vm.portfolio).not.toBeNull()
    expect(vm.portfolio?.totalAssets).toBe(38_000_000)
    expect(vm.portfolio?.rows.map(r => r.assetClass)).toEqual([...CANONICAL_CLASS_ORDER])
  })

  it('有効なマーケットは残る（VIX / 日経VI も）', () => {
    const vm = noDecision()
    const byId = Object.fromEntries(vm.market.indicators.map(i => [i.id, i]))
    expect(byId.vix.value).toBe(14.8)
    expect(byId.nikkeiVi.value).toBe(22.4)
    expect(vm.market.asOfLabel).toBe('10/6 8:30')
  })

  it('有効な保有制約（90日ロック）は残る', () => {
    const vm = noDecision({ holdings: [{ code: '9697', lock: true, acquiredAt: '2026-07-22' }] })
    expect(vm.attention.map(a => a.id)).toContain('lock-9697')
    expect(vm.attention.find(a => a.id === 'lock-9697')?.detail).toBe('売却可能予定日 10/20')
  })

  it('同時に成立している SAFE_MODE 制約も残る（Hero は判断不能のまま）', () => {
    const vm = noDecision({
      safeModeEffective: true,
      safeModeSource: { loaded: true, newBuysFrozen: true, rebalanceFrozen: true },
    })
    expect(vm.hero.state).toBe('decision_unavailable')
    expect(vm.attention.map(a => a.id)).toContain('safe-mode')
  })

  it('総現金・実行可能現金は自分の権限のまま（利用不可を ¥0 にしない）', () => {
    expect(noDecision().grossCash).toEqual({ kind: 'known', amountJpy: 2_660_000 })
    expect(noDecision().deployableCash).toEqual({ kind: 'available', amountJpy: 1_200_000 })
    expect(noDecision({ deployableCash: { available: false, amount: 0, unavailableStatus: 'absent' } }).deployableCash)
      .toEqual({ kind: 'unavailable' })
  })

  it('過去の判断を現在として残さない（rationale / headline / 生成時刻）', () => {
    const vm = noDecision()
    expect(vm.hero.headline).toBe('判断結果を利用できません')
    expect(vm.hero.generatedAtLabel).toBeNull()
    expect(JSON.stringify(vm.hero)).not.toContain('慎重運用')
  })

  it('候補は参照のみ: canonical に EXECUTABLE でも実行可能語・金額を出さない', () => {
    const vm = noDecision({ synthesis: fixtureSynthesis([fixtureExecutableDecision()], fixtureReviewWatchList().slice(1)) })
    expect(vm.candidates.status).toBe('available')
    expect(vm.candidates.rows.length).toBe(3)
    expect(vm.candidates.executableCount).toBe(0)
    expect(vm.candidates.rows.every(r => r.kind === 'review' && r.executableAmountJpy === null)).toBe(true)
  })

  it('節ごとの利用不可はその節に閉じる（配分不可でも市場・候補は残る）', () => {
    const vm = noDecision({ allocation: UNAVAILABLE_ALLOCATION })
    expect(vm.portfolio).toBeNull()
    expect(vm.market.indicators.some(i => i.value !== null)).toBe(true)
    expect(vm.candidates.status).toBe('available')
  })

  it('レジーム / 運用モードは「安全に確認できる情報」に残る（チップ列は M2-D どおり出さない）', () => {
    const vm = noDecision()
    expect(vm.chips).toBeNull()
    expect(vm.unavailableDetail?.available.find(r => r.id === 'regime')?.value).toBe('中立 / 通常')
    expect(vm.unavailableDetail?.unavailable.map(r => r.id)).toEqual(['decision', 'candidate-execution'])
  })

  it('候補だけ / 配分だけの利用不可は判断不能にしない（逆方向の独立性）', () => {
    expect(assembleTodayHomeViewModel(scenarioInputs('candidate_unavailable')).hero.state).toBe('normal')
    expect(assembleTodayHomeViewModel(baseInputs({ allocation: UNAVAILABLE_ALLOCATION })).hero.state).toBe('normal')
  })
})

// ═══════════════════════════════════════════════════════════
// F-03 (P1): 凍結デスクトップ状態ブロックの 4 セル目（候補）。
// ═══════════════════════════════════════════════════════════
describe('F-03 状態チップの 4 セル目は候補の projection 済みの値', () => {
  it('NORMAL: 0 実行可能 / 3 要レビュー', () => {
    const vm = assembleTodayHomeViewModel(baseInputs())
    expect(vm.chips?.candidates).toEqual({ label: '0 実行可能', sub: '3 要レビュー', available: true })
  })

  it('actionable: canonical な EXECUTABLE 件数を再掲する', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('actionable'))
    expect(vm.chips?.candidates).toEqual({ label: '1 実行可能', sub: '2 要レビュー', available: true })
    expect(vm.chips?.candidates.label).toBe(`${vm.candidates.executableCount} 実行可能`)
  })

  it('候補の権限が無い → 判定不能（0 件にしない）', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('candidate_unavailable'))
    expect(vm.chips?.candidates).toEqual({ label: '判定不能', sub: null, available: false })
  })

  it('DATA_WAIT → 更新待ち（実行可能 0 件と偽らない）', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('data_wait'))
    expect(vm.chips?.candidates).toEqual({ label: '更新待ち', sub: null, available: false })
  })

  it('候補 0 件（評価は正常）→ 候補なし', () => {
    const vm = assembleTodayHomeViewModel(baseInputs({ synthesis: fixtureSynthesis([], []) }))
    expect(vm.chips?.candidates).toEqual({ label: '候補なし', sub: null, available: true })
  })

  it('注意件数とは別の値（Attention の重複ではない）', () => {
    const vm = assembleTodayHomeViewModel(scenarioInputs('safe_mode'))
    expect(vm.chips?.attentionCount).toBe(2)
    expect(vm.chips?.candidates.label).toBe('0 実行可能')
  })
})

describe('候補セクションは synthesis の提示順を保つ（projector 経由）', () => {
  it('decisions → watchList の先頭3件。並べ替えない', () => {
    const watch = [
      fixtureEntry('A', { candidateQuality: { marketScore: 10, tier: 'deep_review' } }),
      fixtureEntry('B', { candidateQuality: { marketScore: 99, tier: 'deep_review' } }),
    ]
    const decisions = [
      fixtureEntry('C', { action: 'ADD', relationship: 'already_held', candidateQuality: { marketScore: 5, tier: 'actionable' } }),
      fixtureEntry('D', { action: 'BUY_NEW', candidateQuality: { marketScore: 50, tier: 'actionable' } }),
    ]
    const vm = assembleTodayHomeViewModel(baseInputs({ synthesis: fixtureSynthesis(decisions, watch) }))
    expect(vm.candidates.rows.map(r => r.code)).toEqual(['C', 'D', 'A'])
    expect(vm.candidates.totalCount).toBe(4)
  })
})
