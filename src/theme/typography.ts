/**
 * Typography Scale — Single Source of Truth
 * jp-portfolio Institutional Decision OS
 *
 * 必須ルール:
 *   - 数値表示は fontVariantNumeric: 'tabular-nums' を使用
 *   - 1画面内でフォントサイズは最大4段階
 *   - text-sm / text-lg 等の場当たり指定を禁止。必ずこのスケールを参照
 *
 * Usage: import { type TypographyStyle, typography } from '@/theme/typography'
 *
 * Example (inline style):
 *   <h1 style={typography.pageTitle}>...</h1>
 *   <span style={typography.metricLarge}>1,234,567円</span>
 */

import type { CSSProperties } from 'react'

export type TypographyStyle = Pick<
  CSSProperties,
  | 'fontSize'
  | 'fontWeight'
  | 'lineHeight'
  | 'letterSpacing'
  | 'fontFamily'
  | 'fontVariantNumeric'
  | 'textTransform'
>

// ---------------------------------------------------------------------------
// Font families (mirrors CSS --head / --body / --mono)
// ---------------------------------------------------------------------------

const FONT_HEAD = "'Space Grotesk', 'IBM Plex Sans JP', sans-serif"
const FONT_BODY = "'IBM Plex Sans JP', 'Hiragino Sans', sans-serif"
const FONT_MONO = "'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace"

// ---------------------------------------------------------------------------
// Typography Scale
// ---------------------------------------------------------------------------

export const typography = {
  /**
   * ページタイトル — 画面最上部の1行タイトル
   * 例: "本日の執行判断", "投信ポートフォリオ"
   */
  pageTitle: {
    fontFamily:   FONT_HEAD,
    fontSize:     '22px',
    fontWeight:   700,
    lineHeight:   '1.25',
    letterSpacing:'-0.01em',
  } satisfies TypographyStyle,

  /**
   * ページサブタイトル — pageTitle 直下の1行説明
   * 例: TAB_META.description
   */
  pageSubtitle: {
    fontFamily:  FONT_BODY,
    fontSize:    '13px',
    fontWeight:  400,
    lineHeight:  '1.5',
  } satisfies TypographyStyle,

  /**
   * セクション見出し — カード内・セクション冒頭の見出し
   * 例: "ポジション一覧", "リスク評価"
   */
  sectionTitle: {
    fontFamily:  FONT_HEAD,
    fontSize:    '14px',
    fontWeight:  600,
    lineHeight:  '1.3',
    letterSpacing:'0.02em',
    textTransform:'uppercase' as const,
  } satisfies TypographyStyle,

  /**
   * カードタイトル — 個別カードの銘柄名・ファンド名など
   * 例: "トヨタ自動車", "eMAXIS Slim"
   */
  cardTitle: {
    fontFamily:  FONT_BODY,
    fontSize:    '13px',
    fontWeight:  600,
    lineHeight:  '1.35',
    letterSpacing:'0em',
  } satisfies TypographyStyle,

  /**
   * 本文 — 通常のテキスト・説明文
   */
  body: {
    fontFamily: FONT_BODY,
    fontSize:   '14px',
    fontWeight: 400,
    lineHeight: '1.6',
  } satisfies TypographyStyle,

  /**
   * 補助本文 — サブテキスト・AI分析の箇条書き
   */
  bodySmall: {
    fontFamily: FONT_BODY,
    fontSize:   '13px',
    fontWeight: 400,
    lineHeight: '1.55',
  } satisfies TypographyStyle,

  /**
   * キャプション — タイムスタンプ・補足注記・凡例
   */
  caption: {
    fontFamily:  FONT_BODY,
    fontSize:    '11px',
    fontWeight:  400,
    lineHeight:  '1.4',
    letterSpacing:'0.01em',
  } satisfies TypographyStyle,

  /**
   * 主要数値（大）— ヒーローKPI・ポートフォリオ総額
   * tabular-nums 必須
   */
  metricLarge: {
    fontFamily:         FONT_MONO,
    fontSize:           '28px',
    fontWeight:         600,
    lineHeight:         '1.1',
    letterSpacing:      '-0.02em',
    fontVariantNumeric: 'tabular-nums',
  } satisfies TypographyStyle,

  /**
   * 主要数値（中）— カード内KPI・評価額・損益
   * tabular-nums 必須
   */
  metricMedium: {
    fontFamily:         FONT_MONO,
    fontSize:           '18px',
    fontWeight:         600,
    lineHeight:         '1.2',
    letterSpacing:      '-0.01em',
    fontVariantNumeric: 'tabular-nums',
  } satisfies TypographyStyle,

  /**
   * 数値（小）— 表内数値・変化量・パーセンテージ
   * tabular-nums 必須
   */
  metricSmall: {
    fontFamily:         FONT_MONO,
    fontSize:           '13px',
    fontWeight:         500,
    lineHeight:         '1.3',
    fontVariantNumeric: 'tabular-nums',
  } satisfies TypographyStyle,

  /**
   * ラベル — フォームラベル・メタデータキー
   * 例: "評価額", "損益率", "直近更新"
   */
  label: {
    fontFamily:  FONT_BODY,
    fontSize:    '11px',
    fontWeight:  500,
    lineHeight:  '1.4',
    letterSpacing:'0.04em',
    textTransform:'uppercase' as const,
  } satisfies TypographyStyle,

  /**
   * バッジ — BUY/SELL/HOLD/WATCH・アセットタイプ
   */
  badge: {
    fontFamily:  FONT_HEAD,
    fontSize:    '10px',
    fontWeight:  700,
    lineHeight:  '1',
    letterSpacing:'0.06em',
    textTransform:'uppercase' as const,
  } satisfies TypographyStyle,
} as const

export type TypographyKey = keyof typeof typography
