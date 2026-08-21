/**
 * PageHeader — 各タブ共通のページ見出し（L1）
 *
 * TAB_META の title/description をそのまま h1 + サブタイトルとして表示する。
 * 各タブの semantic h1 はここ1箇所のみとする。
 *
 * Usage:
 *   <PageHeader tabId="T0" />
 */
import { TAB_META_BY_ID } from '../../constants/tabs'
import { colors, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { TabId } from '../../types'
import type { CSSProperties } from 'react'

export interface PageHeaderProps {
  tabId: TabId
}

export function PageHeader({ tabId }: PageHeaderProps) {
  const meta = TAB_META_BY_ID[tabId]

  const titleStyle: CSSProperties = {
    ...typography.pageTitle,
    color:  colors.textPrimary,
    margin: 0,
  }

  const subtitleStyle: CSSProperties = {
    ...typography.pageSubtitle,
    color:     colors.textSubtle,
    margin:    0,
    marginTop: spacing[1],
  }

  return (
    <div className="page-header">
      <h1 style={titleStyle}>{meta.title}</h1>
      <p style={subtitleStyle}>{meta.description}</p>
    </div>
  )
}
