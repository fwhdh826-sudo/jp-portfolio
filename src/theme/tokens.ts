/**
 * Design Tokens — V10 Single Source of Truth
 * JP株OS V10 — 金融ダッシュボード風ライトテーマ
 *
 * 色の意味（全画面で固定・変更禁止）:
 *   青緑（teal）→ BUY / 強気 / 改善
 *   グレー       → 中立 / 様子見 / HOLD
 *   オレンジ     → 警戒 / 注意
 *   赤           → SELL / 危険 / 悪化
 *   ネイビー     → 主要見出し / 強調テキスト
 *
 * ベース: 白・薄グレー・ネイビー系（ライトテーマ）
 */

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export const colors = {
  // ── Background ──────────────────────────────────────────────
  bgBase:     '#eef1f6', // ページ背景（淡グレー — 白カードとのコントラスト強化）
  bgSurface:  '#ffffff', // カード・パネル背景（白）
  bgElevated: '#e8edf4', // 強調カード・ヘッダー背景
  bgNavy:     '#0b1829', // ナビ・ヘッダー背景（深みあるダークネイビー）
  bgNavyLight:'#152840', // ネイビー内カード

  // ── Border ──────────────────────────────────────────────────
  borderSubtle:  '#e8ecf2', // 薄い境界線
  borderDefault: '#d0d7e3', // 通常境界線
  borderStrong:  '#b0bccf', // 強調境界線
  borderNavy:    'rgba(255,255,255,0.12)', // ネイビー上の境界線

  // ── Text ────────────────────────────────────────────────────
  textPrimary:  '#0f2340', // 主要テキスト（ダークネイビー）
  textSecond:   '#2d4a6e', // 副テキスト
  // UI-9B: WCAG AA 4.5:1未達だったためbgBase(#eef1f6)基準で最小限darken（意味・階調順序は不変）
  // UI-9B-R1: bgElevated(#e8edf4)面で両者ともAA未達（4.37/4.35）かつsubtle/mutedの
  // 視覚差がほぼ消失していたためhue/saturationは維持したまま再調整。
  // muted（最弱＝階層最下位）はbgElevatedでAAをわずかに上回る最小限darkenに留め、
  // subtle（補助＝mutedより一段階上）はより明確なdarkenでhierarchyを回復。
  textSubtle:   '#4c5a6b', // 補助テキスト（bgElevated 5.99:1 / bgBase 6.22:1）
  textMuted:    '#556c86', // 最弱テキスト（bgElevated 4.61:1 / bgBase 4.79:1）
  textOnNavy:   '#e8f0f8', // ネイビー上の白系テキスト
  textOnNavySub:'#8eaac8', // ネイビー上の補助テキスト

  // ── Status（意味固定・変更禁止）────────────────────────────
  // BUY / 強気 / 改善 → 青緑（teal）
  // UI-9B: buy/bull/success（下記v13Colors）はテキストとして使われる箇所でAA未達だったため
  // 同一hueのまま最小限darken。buyBg/buyBorder/buyTextは変更なし。
  buy:       '#0c8569',
  buyBg:     '#e6f7f3',
  buyBorder: '#9de0ce',
  buyText:   '#0a6e56',

  // HOLD / 中立 / 様子見 → グレー（UI-9B: 同様にdarken。holdBg/holdBorder/holdTextは変更なし）
  hold:      '#65778f',
  holdBg:    '#f0f2f5',
  holdBorder:'#c8d0da',
  holdText:  '#4a5a70',

  // WAIT / 警戒 / 注意 → オレンジ（UI-9B: 同様にdarken。waitBg/waitBorder/waitTextは変更なし）
  wait:      '#b26105',
  waitBg:    '#fff7ed',
  waitBorder:'#fed7aa',
  waitText:  '#b45309',

  // SELL / 危険 / 悪化 → 赤
  sell:      '#dc2626',
  sellBg:    '#fef2f2',
  sellBorder:'#fca5a5',
  sellText:  '#b91c1c',

  // ── Asset type（必ず分けること）────────────────────────────
  // 個別株: ネイビー青系
  stockAccent:    '#1d4ed8',
  stockAccentBg:  '#eff6ff',
  stockAccentText:'#1e40af',

  // 国内株投信: 青緑系（短期回転）
  jpFundAccent:    '#0891b2',
  jpFundAccentBg:  '#ecfeff',
  jpFundAccentText:'#0e7490',

  // 海外投信: 紫系（中長期）
  globalFundAccent:    '#7c3aed',
  globalFundAccentBg:  '#f5f3ff',
  globalFundAccentText:'#6d28d9',

  // ── Primary / Accent ────────────────────────────────────────
  primary:      '#1d4ed8', // 主要アクション
  primaryHover: '#1e40af',
  primaryLight: '#eff6ff',

  // ── Neutral ─────────────────────────────────────────────────
  // UI-9B: hold/neutral2/v13Colors.neutralと同一hueで揃えてdarken（AA未達対応）
  neutral:    '#65778f',
  neutralBg:  '#f0f2f5',
  neutralLight:'#f8fafc',

  // ── Special ─────────────────────────────────────────────────
  gold:       '#b45309',
  goldBg:     '#fffbeb',
  goldBorder: '#fde68a',

  // 市場モード（UI-9B: bull/neutral2はbuy/holdと同一hueで揃えてdarken。bearは変更なし）
  bull:       '#0c8569', // 強気相場
  bullBg:     '#e6f7f3',
  bear:       '#dc2626', // 弱気相場
  bearBg:     '#fef2f2',
  neutral2:   '#65778f', // 中立相場
  neutral2Bg: '#f0f2f5',

  // ── 後方互換エイリアス（Phase 2-7 で legacy コンポーネントを置き換えるまで維持） ──
  // wait → watch（旧名）（UI-9B: waitと同一hueで揃えてdarken）
  watch:     '#b26105',
  watchBg:   '#fff7ed',
  watchText: '#b45309',
  // jpFundAccent → fundAccent（旧名）
  fundAccent:     '#0891b2',
  fundAccentBg:   '#ecfeff',
  fundAccentText: '#0e7490',

  // ── UI Context（UI-8-3-1 追加） ────────────────────────────
  bgDarkPanel: '#1E293B',                 // T5/Phase8 ダークパネルヘッダー（slate-800）
  primaryTint: 'rgba(29, 78, 216, 0.05)', // primary の微薄背景（active状態）
  overlayBg:   'rgba(0, 0, 0, 0.45)',    // モーダルバックドロップ

  // ── SUPPRESSED（UI-9H H-P0-2 追加）─────────────────────────
  // SAFE_MODE/DQ抑制でBUY表示を止めた状態専用。真のWATCH（監視・グレー系）
  // と条件未達WAIT（オレンジ系＝wait/watch token）のいずれとも視覚的に
  // 衝突しないよう、既存Status colorsとは別系統のニュートラルslateを使う。
  suppressed:      '#7c8595',
  suppressedBg:    '#f4f5f7',
  suppressedBorder:'#d3d7de',
  suppressedText:  '#5b6472',
} as const

// ---------------------------------------------------------------------------
// v13.3 追加トークン（既存 V10 トークンは変更しない）
// 参照: docs/constitution/CLAUDE_DESIGN_BRIEF.md
// ---------------------------------------------------------------------------

export const v13Colors = {
  // ── Regime / Tier A ステータスカラー ─────────────────────
  // CLAUDE_DESIGN_BRIEF.md Section 1 に対応する CSS 変数の実体値
  // UI-9B: success/warning/neutralはcolors.buy/wait/holdと同一hueで揃えてdarken（AA未達対応）
  success:      '#0c8569', // bull_calm — var(--color-success)
  successBg:    '#e6f7f3',
  successText:  '#0a6e56',
  warning:      '#b26105', // bull_volatile — var(--color-warning)
  warningBg:    '#fff7ed',
  warningText:  '#b45309',
  danger:       '#dc2626', // bear — var(--color-danger)
  dangerBg:     '#fef2f2',
  dangerText:   '#b91c1c',
  critical:     '#991b1b', // crisis / SAFE_MODE — var(--color-critical)
  criticalBg:   '#fef2f2',
  criticalText: '#7f1d1d',
  neutral:      '#65778f', // uncertain — var(--color-neutral)
  neutralBg:    '#f0f2f5',
  neutralText:  '#4a5a70',

  // ── 6軸スコアカラー（CLAUDE_DESIGN_BRIEF.md Section 1） ──
  axisValue:             '#3B82F6', // blue-500
  axisQuality:           '#8B5CF6', // violet-500
  axisGrowth:            '#10B981', // emerald-500
  axisSafety:            '#06B6D4', // cyan-500
  axisMomentum:          '#F59E0B', // amber-500
  axisShareholderReturn: '#EC4899', // pink-500
} as const

// ---------------------------------------------------------------------------
// Spacing (4px grid)
// ---------------------------------------------------------------------------

export const spacing = {
  px:  '1px',
  0:   '0px',
  0.5: '2px',
  1:   '4px',
  1.5: '6px',
  2:   '8px',
  2.5: '10px',
  3:   '12px',
  3.5: '14px',
  4:   '16px',
  5:   '20px',
  6:   '24px',
  7:   '28px',
  8:   '32px',
  9:   '36px',
  10:  '40px',
  12:  '48px',
  14:  '56px',
  16:  '64px',
  20:  '80px',
  24:  '96px',
} as const

// ---------------------------------------------------------------------------
// Border Radius
// ---------------------------------------------------------------------------

export const radius = {
  none: '0px',
  sm:   '4px',
  md:   '8px',
  lg:   '12px',
  xl:   '16px',
  '2xl':'20px',
  full: '9999px',
} as const

// ---------------------------------------------------------------------------
// Shadow（ライトテーマ用）
// ---------------------------------------------------------------------------

export const shadow = {
  none: 'none',
  sm:   '0 1px 3px rgba(15,35,64,0.08), 0 1px 2px rgba(15,35,64,0.06)',
  md:   '0 4px 12px rgba(15,35,64,0.10), 0 2px 4px rgba(15,35,64,0.08)',
  lg:   '0 8px 24px rgba(15,35,64,0.12), 0 4px 8px rgba(15,35,64,0.08)',
  xl:   '0 16px 40px rgba(15,35,64,0.14), 0 6px 12px rgba(15,35,64,0.10)',
  card: '0 2px 12px rgba(15,35,64,0.10), 0 1px 3px rgba(15,35,64,0.06)',
} as const

// ---------------------------------------------------------------------------
// Z-index
// ---------------------------------------------------------------------------

export const zIndex = {
  base:    0,
  card:    10,
  sticky:  20,
  overlay: 30,
  modal:   40,
  toast:   50,
} as const

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

export const breakpoints = {
  sm:  430,  // iPhone系
  md:  840,  // タブレット（UI-9G-G7: CSS mobile shell境界 max-width:839px と統一）
  lg: 1200,  // デスクトップ
} as const

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const font = {
  family: '"Inter", "Noto Sans JP", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono:   '"JetBrains Mono", "Fira Code", "Consolas", monospace',
  // サイズ
  xs:   '11px',
  sm:   '12px',
  base: '14px',
  md:   '15px',
  lg:   '16px',
  xl:   '18px',
  '2xl':'20px',
  '3xl':'24px',
  '4xl':'28px',
  '5xl':'32px',
  // 行間
  tight:  1.2,
  normal: 1.5,
  loose:  1.7,
} as const

// ---------------------------------------------------------------------------
// CSS Variable Map — :root へ注入
// ---------------------------------------------------------------------------

export function generateCssVars(): Record<string, string> {
  return {
    // v13.3 Regime / Tier A status
    '--color-success':       v13Colors.success,
    '--color-success-bg':    v13Colors.successBg,
    '--color-success-text':  v13Colors.successText,
    '--color-warning':       v13Colors.warning,
    '--color-warning-bg':    v13Colors.warningBg,
    '--color-warning-text':  v13Colors.warningText,
    '--color-danger':        v13Colors.danger,
    '--color-danger-bg':     v13Colors.dangerBg,
    '--color-danger-text':   v13Colors.dangerText,
    '--color-critical':      v13Colors.critical,
    '--color-critical-bg':   v13Colors.criticalBg,
    '--color-critical-text': v13Colors.criticalText,
    '--color-neutral':       v13Colors.neutral,
    '--color-neutral-bg':    v13Colors.neutralBg,
    '--color-neutral-text':  v13Colors.neutralText,

    // v13.3 6軸スコアカラー
    '--color-axis-value':              v13Colors.axisValue,
    '--color-axis-quality':            v13Colors.axisQuality,
    '--color-axis-growth':             v13Colors.axisGrowth,
    '--color-axis-safety':             v13Colors.axisSafety,
    '--color-axis-momentum':           v13Colors.axisMomentum,
    '--color-axis-shareholder-return': v13Colors.axisShareholderReturn,
    // Background
    '--color-bg-base':      colors.bgBase,
    '--color-bg-surface':   colors.bgSurface,
    '--color-bg-elevated':  colors.bgElevated,
    '--color-bg-navy':      colors.bgNavy,
    '--color-bg-navy-light':colors.bgNavyLight,

    // Border
    '--color-border-subtle':  colors.borderSubtle,
    '--color-border-default': colors.borderDefault,
    '--color-border-strong':  colors.borderStrong,
    '--color-border-navy':    colors.borderNavy,

    // Text
    '--color-text-primary':    colors.textPrimary,
    '--color-text-second':     colors.textSecond,
    '--color-text-subtle':     colors.textSubtle,
    '--color-text-muted':      colors.textMuted,
    '--color-text-on-navy':    colors.textOnNavy,
    '--color-text-on-navy-sub':colors.textOnNavySub,

    // Status
    '--color-buy':        colors.buy,
    '--color-buy-bg':     colors.buyBg,
    '--color-buy-border': colors.buyBorder,
    '--color-buy-text':   colors.buyText,

    '--color-hold':        colors.hold,
    '--color-hold-bg':     colors.holdBg,
    '--color-hold-border': colors.holdBorder,
    '--color-hold-text':   colors.holdText,

    '--color-wait':        colors.wait,
    '--color-wait-bg':     colors.waitBg,
    '--color-wait-border': colors.waitBorder,
    '--color-wait-text':   colors.waitText,

    '--color-sell':        colors.sell,
    '--color-sell-bg':     colors.sellBg,
    '--color-sell-border': colors.sellBorder,
    '--color-sell-text':   colors.sellText,

    // Asset types
    '--color-stock':      colors.stockAccent,
    '--color-stock-bg':   colors.stockAccentBg,
    '--color-stock-text': colors.stockAccentText,

    '--color-jp-fund':      colors.jpFundAccent,
    '--color-jp-fund-bg':   colors.jpFundAccentBg,
    '--color-jp-fund-text': colors.jpFundAccentText,

    '--color-global-fund':      colors.globalFundAccent,
    '--color-global-fund-bg':   colors.globalFundAccentBg,
    '--color-global-fund-text': colors.globalFundAccentText,

    // Primary
    '--color-primary':       colors.primary,
    '--color-primary-hover': colors.primaryHover,
    '--color-primary-light': colors.primaryLight,

    // Market mode
    '--color-bull':    colors.bull,
    '--color-bull-bg': colors.bullBg,
    '--color-bear':    colors.bear,
    '--color-bear-bg': colors.bearBg,

    // UI Context
    '--color-bg-dark-panel': colors.bgDarkPanel,
    '--color-primary-tint':  colors.primaryTint,
    '--color-overlay-bg':    colors.overlayBg,

    // Spacing
    '--space-1':  spacing[1],
    '--space-2':  spacing[2],
    '--space-3':  spacing[3],
    '--space-4':  spacing[4],
    '--space-5':  spacing[5],
    '--space-6':  spacing[6],
    '--space-8':  spacing[8],
    '--space-10': spacing[10],
    '--space-12': spacing[12],
    '--space-16': spacing[16],

    // Radius
    '--radius-sm':  radius.sm,
    '--radius-md':  radius.md,
    '--radius-lg':  radius.lg,
    '--radius-xl':  radius.xl,
    '--radius-full':radius.full,

    // Shadow
    '--shadow-sm':   shadow.sm,
    '--shadow-md':   shadow.md,
    '--shadow-lg':   shadow.lg,
    '--shadow-card': shadow.card,

    // Typography
    '--font-family': font.family,
    '--font-mono':   font.mono,
    '--font-xs':     font.xs,
    '--font-sm':     font.sm,
    '--font-base':   font.base,
    '--font-md':     font.md,
    '--font-lg':     font.lg,
    '--font-xl':     font.xl,
    '--font-2xl':    font['2xl'],
    '--font-3xl':    font['3xl'],

    // ── UI-9A: unresolved var(--*) alias map ────────────────────
    // src/** が参照するがこれまで generateCssVars() 未出力だった13変数。
    // 新規色・数値は発明せず、既存 canonical token（上記 colors/v13Colors）を
    // そのまま指す alias として解決する。
    '--color-background':     colors.bgSurface,
    '--color-bg-card':        colors.bgSurface,
    '--color-bg-subtle':      colors.neutralBg,
    '--color-bg-wash':        colors.neutralBg,
    '--color-border':         colors.borderDefault,
    '--color-brand':          colors.primary,
    '--color-brand-bg-faint': colors.primaryLight,
    '--color-stale-text':     colors.gold,
    '--color-stock-accent':   colors.stockAccent,
    '--color-stock-bg-faint': colors.stockAccentBg,
    '--color-surface':        colors.bgSurface,
    '--color-text':           colors.textPrimary,
    '--color-text-secondary': colors.textSecond,
  }
}

export function applyTheme(root: HTMLElement = document.documentElement): void {
  const vars = generateCssVars()
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}
