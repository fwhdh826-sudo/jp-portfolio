// CASH-AUTH-1 §12/§15/§16/§21: T9 が唯一のエディタであること、T0 が読み取り専用の
// サマリーであること、T1 に重複エディタが無いこと、そして現金がリポジトリ/ネットワークへ
// 出ないことを固定する。
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AppState, CashAssumptions, AllocationPlanSnapshotState } from '../../types'
import { DEFAULT_CASH_ASSUMPTIONS } from '../../types'
import { formatJPYAuto } from '../../utils/format'
import { buildAllocationPlanSnapshot } from '../../domain/allocation'
import {
  ALLOCATION_PLAN_AUTHORITY_VERSION,
  type AllocationPlanInput,
  type AllocationPlanSnapshot,
} from '../../types/allocationPlan'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t9Source from './T9_Settings.tsx?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t0Source from './T0_Home.tsx?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import t1Source from './T1_Decision.tsx?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import cashAuthoritySource from '../../domain/cash/cashAuthority.ts?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import cashTransferSource from '../../utils/cashAssumptionsTransfer.ts?raw'
// @ts-expect-error -- Vite resolves raw source imports during Vitest.
import lifecycleSource from '../../store/cashAuthorityLifecycle.ts?raw'

const mockedStore = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('../../store/useAppStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../../store/useAppStore')>()
  return {
    ...actual,
    useAppStore: <Selected,>(selector: (state: AppState) => Selected): Selected => {
      if (mockedStore.state === null) throw new Error('cash authority fixture is not initialized')
      return selector(mockedStore.state)
    },
  }
})

// 実時計基準の相対時刻で固定する（TTL判定は Date.now() を使うため）
const HOUR = 60 * 60 * 1000
const NOW = Date.now()

function manual(overrides: Partial<CashAssumptions> = {}): CashAssumptions {
  return {
    source: 'MANUAL',
    grossCash: 8_000_000,
    safetyReserve: 1_000_000,
    pendingOrderCash: 500_000,
    updatedAt: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  }
}

async function renderT0(
  cashAssumptions: CashAssumptions,
  allocationPlan: AllocationPlanSnapshot | null = null,
  allocationPlanStatus: AllocationPlanSnapshotState = 'absent',
): Promise<string> {
  // モック済みの useAppStore ではなく、実体の初期 state を土台にする
  const actual = await vi.importActual<typeof import('../../store/useAppStore')>(
    '../../store/useAppStore',
  )
  mockedStore.state = {
    ...actual.useAppStore.getState(),
    cashAssumptions,
    allocationPlan,
    allocationPlanStatus,
  }
  const { T0_Home } = await import('./T0_Home')
  return renderToStaticMarkup(<T0_Home />)
}

async function renderT9(cashAssumptions: CashAssumptions): Promise<string> {
  const actual = await vi.importActual<typeof import('../../store/useAppStore')>(
    '../../store/useAppStore',
  )
  mockedStore.state = { ...actual.useAppStore.getState(), cashAssumptions }
  const { T9_Settings } = await import('./T9_Settings')
  return renderToStaticMarkup(<T9_Settings />)
}

// CASH-AUTH-1 R2: canonical AllocationPlanSnapshot を実際の buildAllocationPlanSnapshot
// （本物の deriveCashModel を含む engine）で組み立てる。UI テスト側で holdings/crossTab/
// staleness を独自計算しない — engine の実測値をそのまま T0 に流し込んで検証する。
function baseAllocationInput(
  overrides: {
    cash?: Partial<AllocationPlanInput['cash']>
    safetyState?: Partial<AllocationPlanInput['safetyState']>
  } = {},
): AllocationPlanInput {
  return {
    generatedAt: '2026-08-13T00:00:00.000Z',
    snapshotId: 'snapshot-r2-t0-fixture',
    authorityVersion: ALLOCATION_PLAN_AUTHORITY_VERSION,
    sourceHoldingsSnapshotId: 'holdings-r2-t0-fixture',
    sourceSettingsVersion: 'settings-r2-t0-fixture',
    cash: {
      grossCash: 5_000_000,
      safetyReserve: 0,
      pendingOrderCash: 0,
      dataUncertaintyReserve: 0,
      ...overrides.cash,
    },
    budgets: { shortTermBudget: 5_000_000, longTermBudget: 0 },
    policy: {
      jpStockMaxRatio: 0.8,
      jpStockMaxAmountJpy: null,
      jpStockCapRegimeMode: 'policy_only',
      assetClassPolicies: [],
      instrumentPolicies: [],
      roundingPolicies: [],
      allocationMode: 'RANK_SEQUENTIAL_SINGLE_EXECUTION',
      buyNewBaseShare: 1,
      buyMoreBaseShare: 1,
      confidenceUnknownFactor: 0.5,
      executionPriceBufferRatio: 0.03,
    },
    assetClasses: [],
    instruments: [],
    candidates: [],
    safetyState: {
      safeMode: 'inactive',
      marketData: 'fresh',
      holdings: 'fresh',
      cash: 'known_fresh',
      target: 'known',
      pendingOrders: 'known',
      candidateArtifact: 'fresh',
      dqViolation: false,
      tierA: 'normal',
      crossTab: 'current',
      noTrade: 'normal',
      ...overrides.safetyState,
    },
    regime: 'neutral',
    marketMode: 'normal',
  }
}

function allocationSnapshotWith(
  overrides: Parameters<typeof baseAllocationInput>[0] = {},
): AllocationPlanSnapshot {
  return buildAllocationPlanSnapshot(baseAllocationInput(overrides))
}

function extract(html: string, testId: string): string {
  const pattern = new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)<`, 'u')
  return pattern.exec(html)?.[1]?.trim() ?? ''
}

describe('CASH-AUTH-1 §12: T9 が唯一の primary editor', () => {
  it('現金権限セクションに凍結された3項目のエディタがある', () => {
    expect(t9Source).toContain('data-testid="cash-authority-editor"')
    expect(t9Source).toContain('data-testid="cash-authority-gross-input"')
    expect(t9Source).toContain('data-testid="cash-authority-safety-reserve-input"')
    expect(t9Source).toContain('data-testid="cash-authority-pending-order-input"')
  })

  it('出所・更新時刻・鮮度・現金ベース上限を表示する', () => {
    expect(t9Source).toContain('data-testid="cash-authority-state-badge"')
    expect(t9Source).toContain('最終更新')
    expect(t9Source).toContain('data-testid="cash-authority-deployable-preview"')
  })

  it('日本語ラベルは凍結語彙に従う', () => {
    expect(t9Source).toContain('総現金')
    expect(t9Source).toContain('生活・安全余力')
    expect(t9Source).toContain('未約定の買付注文に確保済み')
    expect(t9Source).toContain('保存後の現金ベース上限')
  })

  // CASH-AUTH-1 R2 §9: 下書きプレビューは canonical executable な投資可能現金を
  // 先取りして約束しない。現金のみの上限（cashBaseLimit）であることを明示する。
  it('保存後プレビューは実行可能額を約束せず、現金のみの上限であることを明示する', () => {
    expect(t9Source).not.toContain('保存後の投資可能現金')
    expect(t9Source).toContain('現金側の上限')
    expect(t9Source).toContain('データ鮮度')
  })

  it('保存後プレビューの計算はローカルの入力欄のみに依存し、権限・スナップショット・時刻を変更しない', () => {
    const previewCalcSection = t9Source.slice(
      t9Source.indexOf('const cashBaseLimitPreview'),
      t9Source.indexOf('const runManualAction'),
    )
    expect(previewCalcSection.length).toBeGreaterThan(0)
    expect(previewCalcSection).not.toContain('setCashAssumptions')
    expect(previewCalcSection).not.toContain('reconfirmCashAssumptions')
    expect(previewCalcSection).not.toContain('importCashAssumptions')
    expect(previewCalcSection).not.toContain('new Date(')
  })

  it('下書き 5,000,000/1,000,000/500,000 は現金ベース上限として3,500,000を表示する', async () => {
    const html = await renderT9(manual({
      grossCash: 5_000_000, safetyReserve: 1_000_000, pendingOrderCash: 500_000,
    }))
    expect(extract(html, 'cash-authority-deployable-preview')).toContain(formatJPYAuto(3_500_000))
  })

  it('意図的な再確認アクションと削除アクションを持つ', () => {
    expect(t9Source).toContain('data-testid="cash-authority-reconfirm"')
    expect(t9Source).toContain('同じ金額で再確認')
    expect(t9Source).toContain('data-testid="cash-authority-clear"')
    expect(t9Source).toContain('現金情報を削除')
  })

  it('検証に通らない下書きでは保存ボタンを無効化する', () => {
    expect(t9Source).toContain('disabled={!draftValidation.ok || pendingOperation !== null}')
  })

  it('描画やマウントで updatedAt を更新しない（TTLを延長しない）', () => {
    // 権限の updatedAt を作るのは保存/再確認アクションのみ。
    // T9 が持つ ISO 文字列生成は下書き検証用の固定プレースホルダだけ。
    expect(t9Source).not.toContain('new Date().toISOString()')
    expect(t9Source).toContain('DRAFT_PREVIEW_TIMESTAMP')
  })

  it('待機・追加資金という曖昧な旧語彙のエディタは残っていない', () => {
    expect(t9Source).not.toContain('setCashDepositsInput')
    expect(t9Source).not.toContain('setStandbyFundsInput')
  })
})

describe('CASH-AUTH-1 §15: T0 は読み取り専用サマリー', () => {
  it('総現金を表示する。投資可能現金は canonical snapshot 未計算のため0（cashのみの上限へフォールバックしない）', async () => {
    const html = await renderT0(manual())
    expect(html).toContain('data-testid="t0-cash-authority-summary"')
    expect(extract(html, 't0-cash-authority-gross')).toContain(formatJPYAuto(8_000_000))
    // canonical AllocationPlanSnapshot が無い（absent）ため、cashのみの上限
    // （8,000,000 - 1,000,000 - 500,000 = 6,500,000）を実行可能額として表示しない。
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
    expect(extract(html, 't0-cash-authority-state')).toContain('配分計算')
  })

  it('未設定は「現金未設定」として、0円確認済みと区別して表示する', async () => {
    const html = await renderT0({ ...DEFAULT_CASH_ASSUMPTIONS })
    expect(extract(html, 't0-cash-authority-gross')).toContain('未設定')
    expect(extract(html, 't0-cash-authority-state')).toContain('現金未設定')
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
  })

  it('0円を確認済みは unknown とは別の文言で表示される', async () => {
    const html = await renderT0(manual({ grossCash: 0, safetyReserve: 0, pendingOrderCash: 0 }))
    const state = extract(html, 't0-cash-authority-state')
    expect(state).toContain('0円を確認済み')
    expect(state).not.toContain('現金未設定')
  })

  it('失効時は参考値であることと配分が制限されることを伝える', async () => {
    const html = await renderT0(manual({ updatedAt: new Date(Date.now() - 200 * HOUR).toISOString() }))
    const state = extract(html, 't0-cash-authority-state')
    expect(state).toContain('期限切れ')
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
  })

  it('T0 に入力欄が無い（編集はT9のみ）', async () => {
    const html = await renderT0(manual())
    const card = html.slice(html.indexOf('t0-cash-authority-summary'))
    const cardEnd = card.indexOf('t0-cash-authority-edit-link')
    expect(card.slice(0, cardEnd)).not.toContain('<input')
    expect(t0Source).not.toContain('setCashAssumptions')
    expect(t0Source).not.toContain('reconfirmCashAssumptions')
  })

  it('T9 のフォーム全体を複製していない', () => {
    expect(t0Source).not.toContain('cash-authority-gross-input')
    expect(t0Source).not.toContain('cash-authority-save')
  })
})

// CASH-AUTH-1 R2: DISPLAY_DEPLOYABLE_CASH_DIVERGES_FROM_ENGINE_UNCERTAINTY の
// deterministic contradiction tests。T0 が canonical AllocationPlanSnapshot
// （本物の buildAllocationPlanSnapshot/deriveCashModel）と一致した金額を表示し、
// cashのみの上限（cashBaseLimit）へ楽観的フォールバックしないことを固定する。
describe('CASH-AUTH-1 R2: T0 の投資可能現金は canonical AllocationPlanSnapshot と一致する', () => {
  it('#1 fresh cash + holdings stale → 参照現金は正でも投資可能現金は0円', async () => {
    const snap = allocationSnapshotWith({
      cash: { grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0 },
      safetyState: { holdings: 'stale' },
    })
    expect(snap.deployableCash).toBe(0)
    const html = await renderT0(
      manual({ grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0 }),
      snap,
      'current',
    )
    expect(extract(html, 't0-cash-authority-gross')).toContain(formatJPYAuto(5_000_000))
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
  })

  it('#2 fresh cash + crossTab stale → 投資可能現金は0円', async () => {
    const snap = allocationSnapshotWith({
      cash: { grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0 },
      safetyState: { crossTab: 'stale' },
    })
    expect(snap.deployableCash).toBe(0)
    const html = await renderT0(
      manual({ grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0 }),
      snap,
      'current',
    )
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
  })

  it('#3 全て fresh → 投資可能現金は canonical CashModel.deployableCash（正の値）と完全一致する', async () => {
    const snap = allocationSnapshotWith({
      cash: { grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0 },
    })
    expect(snap.deployableCash).toBeGreaterThan(0)
    const html = await renderT0(
      manual({ grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0 }),
      snap,
      'current',
    )
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(snap.deployableCash))
  })

  it('#4 cash stale → 参考現金は表示するが投資可能現金は0円', async () => {
    const html = await renderT0(
      manual({ grossCash: 5_000_000, updatedAt: new Date(Date.now() - 200 * HOUR).toISOString() }),
    )
    expect(extract(html, 't0-cash-authority-gross')).toContain(formatJPYAuto(5_000_000))
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
  })

  it('#5 confirmed zero（grossCash=0・fresh）→ 投資可能現金0円だが confirmed-zero の文言は保たれる', async () => {
    const html = await renderT0(manual({ grossCash: 0, safetyReserve: 0, pendingOrderCash: 0 }))
    const state = extract(html, 't0-cash-authority-state')
    expect(state).toContain('0円を確認済み')
    expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
  })

  it('§13 snapshot unavailable（absent/stale/invalid）→ cashのみの正の値へ楽観的フォールバックしない', async () => {
    const freshCash = manual({ grossCash: 5_000_000, safetyReserve: 0, pendingOrderCash: 0 })
    for (const status of ['absent', 'stale', 'invalid'] as const) {
      const html = await renderT0(freshCash, null, status)
      expect(extract(html, 't0-cash-authority-deployable')).toContain(formatJPYAuto(0))
      expect(extract(html, 't0-cash-authority-deployable')).not.toContain(formatJPYAuto(5_000_000))
    }
  })

  it('T0 は holdings/crossTab の safety state を独自に再計算しない（T0 ソースに判定ロジックが無い）', () => {
    expect(t0Source).not.toContain("safetyState.holdings")
    expect(t0Source).not.toContain("safetyState.crossTab")
    expect(t0Source).not.toContain('dataUncertaintyReserve')
  })
})

describe('CASH-AUTH-1 §16: T1 に重複エディタを作らない', () => {
  it('T1 は現金権限の編集アクションを一切呼ばない', () => {
    expect(t1Source).not.toContain('setCashAssumptions')
    expect(t1Source).not.toContain('clearCashAssumptionsOverride')
    expect(t1Source).not.toContain('importCashAssumptions')
    expect(t1Source).not.toContain('reconfirmCashAssumptions')
  })
})

describe('CASH-AUTH-1 §21: プライバシー境界', () => {
  const cashSources: Array<[string, string]> = [
    ['cashAuthority.ts', cashAuthoritySource],
    ['cashAssumptionsTransfer.ts', cashTransferSource],
    ['cashAuthorityLifecycle.ts', lifecycleSource],
    ['T9_Settings.tsx', t9Source],
  ]

  it.each(cashSources)('%s は fetch/XHR/beacon/WebSocket を使わない', (_name, source) => {
    expect(source).not.toMatch(/\bfetch\s*\(/u)
    expect(source).not.toMatch(/XMLHttpRequest/u)
    expect(source).not.toMatch(/sendBeacon/u)
    expect(source).not.toMatch(/new WebSocket/u)
  })

  it.each(cashSources)('%s は repository データパスへ書き出さない', (_name, source) => {
    expect(source).not.toContain('public/data/')
    expect(source).not.toContain('data/candidate')
    expect(source).not.toMatch(/writeFile|node:fs/u)
  })

  it('現金権限の保存先は same-origin localStorage の既知キーのみ', () => {
    expect(lifecycleSource).not.toContain('localStorage')
    expect(cashAuthoritySource).not.toContain('localStorage')
    // 書き込みは persist.ts の単一キー経由に限る
    expect(t9Source).not.toContain('localStorage.setItem')
  })

  it('現金権限の型に telemetry/analytics 用フィールドが無い', () => {
    expect(cashAuthoritySource).not.toMatch(/analytics|telemetry|gtag|dataLayer/iu)
  })
})
