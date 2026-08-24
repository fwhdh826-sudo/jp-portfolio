/**
 * DecisionCard — BUY / SELL / HOLD 判定カード
 * 総合判定・スコア・判定理由・リスクレベルをまとめて表示する。
 * 結論先出し原則（CLAUDE.md §4）に従い、判定を最上部に置く。
 *
 * Usage:
 *   <DecisionCard
 *     decision="BUY"
 *     title="トヨタ自動車 7203"
 *     score={72}
 *     reasons={["割安水準", "配当利回り4%超"]}
 *     riskLevel="MEDIUM"
 *     assetType="stock"
 *   />
 */

import { colors, radius, shadow, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import { SignalBadge } from '../badges/SignalBadge'
import { RiskBadge }   from '../badges/RiskBadge'
import { AssetTypeBadge } from '../badges/AssetTypeBadge'
import type { Signal }    from '../badges/SignalBadge'
import type { RiskLevel } from '../badges/RiskBadge'
import type { AssetType } from '../badges/AssetTypeBadge'
import type { CSSProperties } from 'react'

export interface DecisionCardProps {
  decision:   Signal
  title:      string
  score?:     number        // 0〜100
  reasons:    string[]
  riskLevel?: RiskLevel
  assetType?: AssetType
}

const decisionAccent: Record<Signal, string> = {
  BUY:        colors.buy,
  SELL:       colors.sell,
  HOLD:       colors.hold,
  WATCH:      colors.watch,
  SUPPRESSED: colors.suppressed,
}

export function DecisionCard({
  decision,
  title,
  score,
  reasons,
  riskLevel,
  assetType,
}: DecisionCardProps) {
  const accent = decisionAccent[decision]

  const cardStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    background:    colors.bgSurface,
    border:        `1px solid ${colors.borderSubtle}`,
    borderTop:     `3px solid ${accent}`,
    borderRadius:  radius.lg,
    boxShadow:     shadow.md,
    overflow:      'hidden',
  }

  const headerStyle: CSSProperties = {
    display:        'flex',
    alignItems:     'flex-start',
    justifyContent: 'space-between',
    gap:            spacing[3],
    padding:        `${spacing[4]} ${spacing[5]}`,
  }

  const titleGroupStyle: CSSProperties = {
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[2],
    minWidth:      0,
  }

  // L2 hero見出し（22/17/14/13/11スケール）。cardTitleはL4用途のため、
  // ここでは意味的に強いhero表示を弱体化させないよう独自にfontSize/fontWeightを指定する。
  const titleStyle: CSSProperties = {
    ...typography.cardTitle,
    fontSize:   '17px',
    fontWeight: 700,
    color:      colors.textPrimary,
    margin:     0,
  }

  const badgeRowStyle: CSSProperties = {
    display:    'flex',
    alignItems: 'center',
    gap:        spacing[1.5],
    flexWrap:   'wrap',
  }

  const scoreAreaStyle: CSSProperties = {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'flex-end',
    gap:            spacing[0.5],
    flexShrink:     0,
  }

  const scoreValueStyle: CSSProperties = {
    ...typography.metricLarge,
    color:  colors.textPrimary,
  }

  const scoreLabelStyle: CSSProperties = {
    ...typography.caption,
    color: colors.textMuted,
  }

  const scoreBarTrackStyle: CSSProperties = {
    width:        '80px',
    height:       '4px',
    background:   colors.borderSubtle,
    borderRadius: radius.full,
    overflow:     'hidden',
  }

  const scoreBarFillStyle: CSSProperties = {
    width:        `${Math.min(100, score ?? 0)}%`,
    height:       '100%',
    background:   accent,
    borderRadius: radius.full,
    transition:   'width 0.4s ease',
  }

  const reasonsStyle: CSSProperties = {
    padding:     `${spacing[3]} ${spacing[5]}`,
    borderTop:   `1px solid ${colors.borderSubtle}`,
    background:  colors.bgBase,
  }

  const reasonsLabelStyle: CSSProperties = {
    ...typography.label,
    color:        colors.textMuted,
    marginBottom: spacing[2],
  }

  const reasonListStyle: CSSProperties = {
    margin:        0,
    paddingLeft:   spacing[4],
    display:       'flex',
    flexDirection: 'column',
    gap:           spacing[1],
  }

  const reasonItemStyle: CSSProperties = {
    ...typography.bodySmall,
    color: colors.textSubtle,
  }

  return (
    <div style={cardStyle} role="region" aria-label={`判定: ${decision}`}>
      <div style={headerStyle}>
        <div style={titleGroupStyle}>
          {/* L2: 各タブのhero判定タイトル（T2/T3/T7） */}
          <h2 style={titleStyle}>{title}</h2>
          <div style={badgeRowStyle}>
            <SignalBadge signal={decision} size="lg" />
            {riskLevel && <RiskBadge level={riskLevel} />}
            {assetType && <AssetTypeBadge type={assetType} />}
          </div>
        </div>

        {score !== undefined && (
          <div style={scoreAreaStyle}>
            <p style={scoreValueStyle}>{score}</p>
            <p style={scoreLabelStyle}>スコア</p>
            <div style={scoreBarTrackStyle}>
              <div style={scoreBarFillStyle} />
            </div>
          </div>
        )}
      </div>

      {reasons.length > 0 && (
        <div style={reasonsStyle}>
          <p style={reasonsLabelStyle}>判定根拠</p>
          <ul style={reasonListStyle}>
            {reasons.map((r, i) => (
              <li key={i} style={reasonItemStyle}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
