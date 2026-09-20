// ═══════════════════════════════════════════════════════════
// UI-9I Phase 1: ユーザー向けナビゲーションの情報設計（純データ + 純関数）。
//
// 内部の T 番号（T0–T9）はユーザーに露出しない。既存 10 画面の機能は
// すべてこの IA のどこかから到達できる（削除しない）:
//
//   今日     → T0（R4.1 Home）／ 判断の詳細（Decision Audit）
//   個別株   → T1
//   投信     → ハブ → T2 国内投信 / T3 海外投信 / T7 投信管理
//   PF       → ポートフォリオ面 → T4 理想PF
//   その他   → ハブ → T5 ニュース / T6 AI委員会 / T8 学習・検証 / T9 設定
//              ／ 従来のホーム（旧 T0 の詳細ダッシュボード）
//
// デスクトップの左サイドバーだけは「ニュース」を独立項目として持つ（T5 へ直接）。
// モバイルの主ナビは 5 項目のまま、ニュースは「その他」ハブ経由で到達する。
//
// ハブ自体は投資ロジックを持たない。
// ═══════════════════════════════════════════════════════════
import type { TabId } from '../../types'
import type { AssetClass } from '../../types/allocationPlan'

export type PrimaryNavId = 'today' | 'stocks' | 'funds' | 'pf' | 'other'

/** ホーム・ハブ・詳細など、TabId に 1:1 で対応しない UI 面。null = activeTab の葉画面。 */
export type UiSurface = 'audit' | 'funds_hub' | 'pf' | 'other_hub' | 'legacy_home'

export interface PrimaryNavItem {
  readonly id: PrimaryNavId
  /** モバイル下部ナビ / デスクトップ左サイドバーの語。 */
  readonly label: string
  readonly desktopLabel: string
  readonly glyph: string
}

export const PRIMARY_NAV: readonly PrimaryNavItem[] = [
  { id: 'today', label: '今日', desktopLabel: '今日', glyph: '◐' },
  { id: 'stocks', label: '個別株', desktopLabel: '個別株', glyph: '▤' },
  { id: 'funds', label: '投信', desktopLabel: '投信', glyph: '◫' },
  { id: 'pf', label: 'PF', desktopLabel: 'ポートフォリオ', glyph: '◔' },
  { id: 'other', label: 'その他', desktopLabel: 'その他', glyph: '≡' },
]

export interface NavTarget {
  readonly tab: TabId | null
  readonly surface: UiSurface | null
}

export const PRIMARY_NAV_TARGET: Record<PrimaryNavId, NavTarget> = {
  today: { tab: 'T0', surface: null },
  stocks: { tab: 'T1', surface: null },
  funds: { tab: null, surface: 'funds_hub' },
  pf: { tab: null, surface: 'pf' },
  other: { tab: null, surface: 'other_hub' },
}

export type DesktopNavId = PrimaryNavId | 'news'

export interface DesktopNavItem {
  readonly id: DesktopNavId
  readonly label: string
}

/** デスクトップ左サイドバー: 今日 / 個別株 / 投信 / ポートフォリオ / ニュース / その他。 */
export const DESKTOP_NAV: readonly DesktopNavItem[] = [
  { id: 'today', label: '今日' },
  { id: 'stocks', label: '個別株' },
  { id: 'funds', label: '投信' },
  { id: 'pf', label: 'ポートフォリオ' },
  { id: 'news', label: 'ニュース' },
  { id: 'other', label: 'その他' },
]

export const DESKTOP_NAV_TARGET: Record<DesktopNavId, NavTarget> = {
  ...PRIMARY_NAV_TARGET,
  news: { tab: 'T5', surface: null },
}

const SURFACE_PRIMARY: Record<UiSurface, PrimaryNavId> = {
  audit: 'today',
  funds_hub: 'funds',
  pf: 'pf',
  other_hub: 'other',
  legacy_home: 'other',
}

const TAB_PRIMARY: Record<TabId, PrimaryNavId> = {
  T0: 'today',
  T1: 'stocks',
  T2: 'funds',
  T3: 'funds',
  T4: 'pf',
  T5: 'other',
  T6: 'other',
  T7: 'funds',
  T8: 'other',
  T9: 'other',
}

/** 現在の画面がどの主ナビ項目に属するか。 */
export function resolvePrimaryNav(activeTab: TabId, surface: UiSurface | null): PrimaryNavId {
  return surface !== null ? SURFACE_PRIMARY[surface] : TAB_PRIMARY[activeTab]
}

/** デスクトップでは T5（ニュース）を独立項目として活性化する。UI 面は従来どおり面の所属が優先。 */
export function resolveDesktopNav(activeTab: TabId, surface: UiSurface | null): DesktopNavId {
  if (surface === null && activeTab === 'T5') return 'news'
  return resolvePrimaryNav(activeTab, surface)
}

/** アイコンチップの配色（意味は持たない。視覚の識別のみ）。 */
export type HubTone = 'blue' | 'green' | 'violet' | 'slate'

export interface HubLink {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly glyph: string
  readonly tone: HubTone
  readonly target: NavTarget
  /** 設定時のみ、その資産クラスの canonical currentAmount を行末に表示する（表示専用）。 */
  readonly valueAssetClass?: AssetClass
}

export const FUNDS_HUB_LINKS: readonly HubLink[] = [
  { id: 'jp-fund', title: '国内投信', description: '短期回転の判断と地合い', glyph: '国', tone: 'blue', target: { tab: 'T2', surface: null }, valueAssetClass: 'JP_TRUST' },
  { id: 'global-fund', title: '海外投信', description: '中長期配分と為替の影響', glyph: '海', tone: 'green', target: { tab: 'T3', surface: null }, valueAssetClass: 'OVERSEAS_TRUST' },
  { id: 'fund-management', title: '投信管理', description: '当日の実行キューと資金配分', glyph: '管', tone: 'violet', target: { tab: 'T7', surface: null } },
]

export const OTHER_HUB_LINKS: readonly HubLink[] = [
  { id: 'news', title: 'ニュース', description: '市場と保有銘柄に関する記事', glyph: 'ニ', tone: 'blue', target: { tab: 'T5', surface: null } },
  { id: 'committee', title: 'AI委員会', description: '代理の議論と論点（判断の背景）', glyph: 'AI', tone: 'violet', target: { tab: 'T6', surface: null } },
  { id: 'learning', title: '学習・検証', description: '予測と実績、戦略の検証', glyph: '学', tone: 'green', target: { tab: 'T8', surface: null } },
  { id: 'settings', title: '設定', description: 'データ更新・CSV取込・保有設定', glyph: '設', tone: 'slate', target: { tab: 'T9', surface: null } },
  { id: 'legacy-home', title: '従来のホーム', description: '旧ダッシュボードの詳細カード一覧', glyph: '旧', tone: 'slate', target: { tab: null, surface: 'legacy_home' } },
]

/** PF 面から到達できる既存画面（旧 T4 理想PF）。 */
export const PF_SURFACE_LINKS: readonly HubLink[] = [
  { id: 'ideal-pf', title: '理想ポートフォリオ / 差分', description: 'ゼロベースの理想PFと現在PFの差分', glyph: '理', tone: 'blue', target: { tab: 'T4', surface: null } },
]
