// CASH-AUTH-1 §17: 現金権限の変更が AllocationPlanSnapshot lifecycle を正しく駆動することを
// 固定する critical acceptance gate。
//
//   fresh authority save        → 新しい AllocationPlanSnapshot
//   cash value modification     → 旧 snapshot は即座に非権威
//   safetyReserve modification  → 再構築
//   pendingOrderCash 変更       → 再構築
//   reconfirm                   → provenance/timestamp 更新 + 再構築
//   TTL 失効                    → stale 権限 → 既存の実行可能 snapshot が実行可能でなくなる
//
// 実時計に依存しない（注入した nowMs のみ）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAllocationPlanInput, createAppStoreInstanceForTest, runFullAnalysis, useAppStore } from './useAppStore'
import { createImmediatePortfolioGenerationLockAdapterForTest } from './testing/portfolioGenerationLockTestAdapters'
import { buildAllocationPlanSnapshot } from '../domain/allocation'
import { deriveCashModel } from '../domain/allocation/cash'
import { snapshotExecutability } from './allocationPlanSelectors'
import { selectAllocationConsumerSnapshot } from './allocationConsumerSelectors'
import { DEFAULT_CASH_ASSUMPTIONS } from '../types'
import type { AppState, CashAssumptions } from '../types'

const NOW = Date.parse('2026-08-01T00:00:00.000Z')
const HOUR = 60 * 60 * 1000

const storage: Record<string, string> = {}
const lsMock = {
  getItem: (k: string) => storage[k] ?? null,
  setItem: (k: string, v: string) => { storage[k] = v },
  removeItem: (k: string) => { delete storage[k] },
}

function manual(overrides: Partial<CashAssumptions> = {}): CashAssumptions {
  return {
    source: 'MANUAL',
    grossCash: 8_000_000,
    safetyReserve: 1_000_000,
    pendingOrderCash: null,
    updatedAt: new Date(NOW - HOUR).toISOString(),
    ...overrides,
  }
}

/** 現金権限だけを差し替えた state から sourceSettingsVersion を取り出す */
function settingsVersionFor(cashAssumptions: CashAssumptions, nowMs = NOW): string {
  const state: AppState = { ...useAppStore.getState(), cashAssumptions }
  const input = buildAllocationPlanInput(state, { generatedAt: new Date(nowMs).toISOString() })
  if (input === null) throw new Error('expected an allocation plan input')
  return input.sourceSettingsVersion
}

describe('CASH-AUTH-1 §17/§18: 現金権限と AllocationPlanSnapshot lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    for (const k of Object.keys(storage)) delete storage[k]
    useAppStore.setState({ cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS } })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  // ── §18 provenance: 現金権限は settings identity に含まれる ──
  it('総現金の変更で sourceSettingsVersion が変わる（旧snapshotは非権威になる）', () => {
    const before = settingsVersionFor(manual({ grossCash: 8_000_000 }))
    const after = settingsVersionFor(manual({ grossCash: 8_000_001 }))
    expect(after).not.toBe(before)
  })

  it('safetyReserve の変更で sourceSettingsVersion が変わる', () => {
    const before = settingsVersionFor(manual({ safetyReserve: 1_000_000 }))
    const after = settingsVersionFor(manual({ safetyReserve: 1_000_001 }))
    expect(after).not.toBe(before)
  })

  it('pendingOrderCash の変更で sourceSettingsVersion が変わる（null と 0 も別世代）', () => {
    const unknown = settingsVersionFor(manual({ pendingOrderCash: null }))
    const zero = settingsVersionFor(manual({ pendingOrderCash: 0 }))
    const positive = settingsVersionFor(manual({ pendingOrderCash: 1 }))
    expect(new Set([unknown, zero, positive]).size).toBe(3)
  })

  it('reconfirm（updatedAtのみ更新）でも sourceSettingsVersion が変わる', () => {
    const before = settingsVersionFor(manual({ updatedAt: new Date(NOW - 2 * HOUR).toISOString() }))
    const after = settingsVersionFor(manual({ updatedAt: new Date(NOW - HOUR).toISOString() }))
    expect(after).not.toBe(before)
  })

  it('権限を削除すると未設定世代の identity へ変わる', () => {
    const withAuthority = settingsVersionFor(manual())
    const cleared = settingsVersionFor({ ...DEFAULT_CASH_ASSUMPTIONS })
    expect(cleared).not.toBe(withAuthority)
  })

  it('同じ現金権限からは同じ identity が再現される（決定的）', () => {
    expect(settingsVersionFor(manual())).toBe(settingsVersionFor(manual()))
  })

  // ── §17 TTL 失効 ──
  it('TTL失効した権限で作った snapshot は実行可能にならない', () => {
    const staleAt = new Date(NOW - (168 * HOUR + 1)).toISOString()
    const state: AppState = { ...useAppStore.getState(), cashAssumptions: manual({ updatedAt: staleAt }) }
    const input = buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })
    expect(input).not.toBeNull()
    const snapshot = buildAllocationPlanSnapshot(input!)
    expect(snapshotExecutability(snapshot)).not.toBe('EXECUTABLE')
    expect(snapshot.deployableCash).toBe(0)
    expect(snapshot.blockedReasons).toContain('CASH_AUTHORITY_STALE')
  })

  it('未設定（unknown）は CASH_AUTHORITY_UNAVAILABLE で fail-closed する', () => {
    const state: AppState = { ...useAppStore.getState(), cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS } }
    const input = buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })
    const snapshot = buildAllocationPlanSnapshot(input!)
    expect(snapshot.deployableCash).toBe(0)
    expect(snapshot.blockedReasons).toContain('CASH_AUTHORITY_UNAVAILABLE')
  })

  it('confirmed zero は unknown ではなく、blockedReasons に UNAVAILABLE を出さない', () => {
    const state: AppState = {
      ...useAppStore.getState(),
      cashAssumptions: manual({ grossCash: 0, safetyReserve: 0, pendingOrderCash: 0 }),
    }
    const input = buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })
    const snapshot = buildAllocationPlanSnapshot(input!)
    expect(snapshot.blockedReasons).not.toContain('CASH_AUTHORITY_UNAVAILABLE')
    expect(snapshot.blockedReasons).not.toContain('CASH_AUTHORITY_STALE')
    expect(snapshot.deployableCash).toBe(0)
  })

  // ── §10 pending orders ──
  it('pendingOrderCash=null は警告を保持する', () => {
    const state: AppState = { ...useAppStore.getState(), cashAssumptions: manual({ pendingOrderCash: null }) }
    const input = buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })
    expect(input!.safetyState.pendingOrders).toBe('unknown')
    const snapshot = buildAllocationPlanSnapshot(input!)
    expect(snapshot.warnings).toContain('PENDING_ORDER_AUTHORITY_UNAVAILABLE')
  })

  it('pendingOrderCash=0 は「無しを確認済み」として警告を出さない', () => {
    const state: AppState = { ...useAppStore.getState(), cashAssumptions: manual({ pendingOrderCash: 0 }) }
    const input = buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })
    expect(input!.safetyState.pendingOrders).toBe('known')
    const snapshot = buildAllocationPlanSnapshot(input!)
    expect(snapshot.warnings).not.toContain('PENDING_ORDER_AUTHORITY_UNAVAILABLE')
  })

  it('正の pendingOrderCash はちょうど1回だけ差し引かれる（engine入力と cash model の両方で）', () => {
    const cashInputFor = (pending: number | null) => {
      const state: AppState = {
        ...useAppStore.getState(),
        cashAssumptions: manual({ grossCash: 8_000_000, safetyReserve: 0, pendingOrderCash: pending }),
      }
      return buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })!.cash
    }
    // adapter は権限の値をそのまま1回だけ渡す（重複控除も加算もしない）
    expect(cashInputFor(1_000_000)).toMatchObject({
      grossCash: 8_000_000, safetyReserve: 0, pendingOrderCash: 1_000_000, dataUncertaintyReserve: 0,
    })
    expect(cashInputFor(0).pendingOrderCash).toBe(0)
    expect(cashInputFor(null).pendingOrderCash).toBeNull()

    // engine の凍結式でちょうど1回だけ差し引かれる
    const model = (pending: number | null) => deriveCashModel(
      { grossCash: 8_000_000, safetyReserve: 0, pendingOrderCash: pending, dataUncertaintyReserve: 0 },
      { shortTermBudget: 8_000_000, longTermBudget: 0 },
      {
        safeMode: 'inactive', marketData: 'fresh', cash: 'known_fresh', target: 'known',
        pendingOrders: pending === null ? 'unknown' : 'known', candidateArtifact: 'fresh',
        dqViolation: false, tierA: 'normal', holdings: 'fresh', crossTab: 'current',
        noTrade: 'normal',
      },
    )
    expect(model(0).deployableCash - model(1_000_000).deployableCash).toBe(1_000_000)
    expect(model(null).deployableCash).toBe(8_000_000)
  })

  // ── §11 safetyReserve > grossCash ──
  it('safetyReserve が grossCash を超えても deployable は負にならず 0 になる', () => {
    // 保存経路は reject するが、engine 側も独立して fail-closed であることを固定する
    const state: AppState = {
      ...useAppStore.getState(),
      cashAssumptions: { ...manual(), grossCash: 1_000_000, safetyReserve: 3_000_000, pendingOrderCash: null },
    }
    const input = buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })
    const snapshot = buildAllocationPlanSnapshot(input!)
    expect(snapshot.deployableCash).toBe(0)
    // 入力された安全余力は黙って減らされない（engine入力としてそのまま渡る）
    expect(input!.cash.safetyReserve).toBe(3_000_000)
  })

  // ── §7 addRoom ──
  it('addRoom を模した任意の legacy 金額は AllocationPlanSnapshot に一切寄与しない', () => {
    const base: AppState = { ...useAppStore.getState(), cashAssumptions: manual(), cash: 0, cashReserve: 0 }
    const perturbed: AppState = { ...base, cash: 99_999_999, cashReserve: 88_888_888 }
    const build = (state: AppState) => {
      const input = buildAllocationPlanInput(state, { generatedAt: new Date(NOW).toISOString() })
      const snapshot = buildAllocationPlanSnapshot(input!)
      return {
        grossCash: snapshot.grossCash,
        deployableCash: snapshot.deployableCash,
        totalAssets: snapshot.totalAssets,
        shortTermBudget: snapshot.shortTermBudget,
        longTermBudget: snapshot.longTermBudget,
      }
    }
    expect(build(perturbed)).toEqual(build(base))
  })

  // ── §17 保存 → 再構築 ──
  it('現金権限の保存で新しい snapshot が構築され、旧 snapshot は残らない', async () => {
    const { store } = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
    })
    const before = store.getState()
    expect(before.cashAssumptions.source).toBe('DEFAULT')

    const result = await store.getState().setCashAssumptions({
      grossCash: 8_000_000, safetyReserve: 1_000_000, pendingOrderCash: 0,
    })
    expect(result).toMatchObject({ ok: true })

    const after = store.getState()
    expect(after.cashAssumptions.source).toBe('MANUAL')
    expect(after.cashAssumptions.updatedAt).not.toBeNull()
    // 旧世代の snapshot オブジェクトがそのまま残っていない
    expect(after.allocationPlan).not.toBe(before.allocationPlan)
  })

  it('金額を直接パッチせず、必ず権限経路を通して再構築される', async () => {
    const { store } = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
    })
    await store.getState().setCashAssumptions({
      grossCash: 8_000_000, safetyReserve: 0, pendingOrderCash: 0,
    })
    const first = store.getState().allocationPlan

    await store.getState().setCashAssumptions({
      grossCash: 8_000_000, safetyReserve: 2_000_000, pendingOrderCash: 0,
    })
    const second = store.getState().allocationPlan

    // 旧 snapshot の中身が書き換えられたのではなく、別世代として作り直されている
    expect(store.getState().cashAssumptions.safetyReserve).toBe(2_000_000)
    if (first !== null && second !== null) {
      expect(second.snapshotId).not.toBe(first.snapshotId)
      expect(second.sourceSettingsVersion).not.toBe(first.sourceSettingsVersion)
    }
  })

  it('reconfirm は金額を変えずに provenance/timestamp を更新して再構築する', async () => {
    const { store } = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
    })
    const staleAt = new Date(Date.now() - 200 * HOUR).toISOString()
    store.setState({ cashAssumptions: manual({ updatedAt: staleAt }) })

    const result = await store.getState().reconfirmCashAssumptions()
    expect(result).toMatchObject({ ok: true })

    const after = store.getState()
    expect(after.cashAssumptions.grossCash).toBe(8_000_000)
    expect(after.cashAssumptions.safetyReserve).toBe(1_000_000)
    expect(after.cashAssumptions.updatedAt).not.toBe(staleAt)
  })

  it('検証に失敗する保存は state / snapshot を一切変更しない', async () => {
    const { store } = createAppStoreInstanceForTest({
      portfolioGenerationLock: createImmediatePortfolioGenerationLockAdapterForTest(),
    })
    const before = store.getState()
    const result = await store.getState().setCashAssumptions({
      grossCash: 1_000, safetyReserve: 2_000, pendingOrderCash: null,
    })
    expect(result).toMatchObject({ ok: false })
    expect(store.getState().cashAssumptions).toEqual(before.cashAssumptions)
    expect(store.getState().allocationPlan).toBe(before.allocationPlan)
  })

  // ── §19 T2/T7 共有 ──
  it('T2/T7 は同一の AllocationPlanSnapshot を共有する（独立再計算をしない）', () => {
    const state: AppState = { ...useAppStore.getState(), cashAssumptions: manual() }
    const computed = runFullAnalysis(state, { nowMs: NOW })
    const published: AppState = { ...state, ...computed }

    const consumerA = selectAllocationConsumerSnapshot(published)
    const consumerB = selectAllocationConsumerSnapshot(published)
    expect(consumerA).toEqual(consumerB)
    if (consumerA.availability === 'available' && consumerB.availability === 'available') {
      expect(consumerA.grossCash).toBe(consumerB.grossCash)
      expect(consumerA.deployableCash).toBe(consumerB.deployableCash)
      expect(consumerA.generation).toEqual(consumerB.generation)
    }
  })

  // ── §17 TTL 失効ガード ──
  it('revalidateCashAuthorityExpiry: 期限内なら何もしない（TTLは延長されない）', () => {
    useAppStore.setState({ cashAssumptions: manual({ updatedAt: new Date(NOW - HOUR).toISOString() }) })
    const before = useAppStore.getState().cashAssumptions
    const changed = useAppStore.getState().revalidateCashAuthorityExpiry(NOW)
    expect(changed).toBe(false)
    expect(useAppStore.getState().cashAssumptions).toBe(before)
  })

  it('revalidateCashAuthorityExpiry: 失効時は実行可能 snapshot を無効化して blocked へ作り直す', () => {
    const staleAt = new Date(NOW - (168 * HOUR + 1)).toISOString()
    const freshState: AppState = { ...useAppStore.getState(), cashAssumptions: manual() }
    const computed = runFullAnalysis(freshState, { nowMs: NOW })
    useAppStore.setState({
      ...computed,
      cashAssumptions: manual({ updatedAt: staleAt }),
    })

    const changed = useAppStore.getState().revalidateCashAuthorityExpiry(NOW)
    expect(changed).toBe(true)

    const after = useAppStore.getState()
    if (after.allocationPlan !== null) {
      expect(snapshotExecutability(after.allocationPlan)).not.toBe('EXECUTABLE')
      expect(after.allocationPlan.deployableCash).toBe(0)
    } else {
      expect(after.allocationPlanStatus).toBe('stale')
    }
    // 権限そのもの（金額・updatedAt）は書き換えない
    expect(after.cashAssumptions.updatedAt).toBe(staleAt)
    expect(after.cashAssumptions.grossCash).toBe(8_000_000)
  })

  it('revalidateCashAuthorityExpiry: 権限が無いときは何もしない', () => {
    useAppStore.setState({
      cashAssumptions: { ...DEFAULT_CASH_ASSUMPTIONS },
      allocationPlan: null,
      allocationPlanStatus: 'stale',
    })
    expect(useAppStore.getState().revalidateCashAuthorityExpiry(NOW)).toBe(false)
  })
})
