// UI-9I Phase 2A: 投信ハブ / その他ハブ / PF 面（R4.1 凍結デザイン M4 / D4）。
// ハブ自体は投資ロジックを持たない（既存画面への到達だけを提供する）。
// AI委員会は Home の最終判断（OfficialDecision）と競合させない。
import type { ReactNode } from 'react'
import type { NavTarget } from '../../presentation/ui9i/navigation'
import { PF_SURFACE_LINKS } from '../../presentation/ui9i/navigation'
import type { FundsHubViewModel, HubRowViewModel, OtherHubViewModel } from '../../presentation/ui9i/hubPresentation'
import type { PortfolioSurfaceViewModel } from '../../presentation/ui9i/portfolioSurface'
import { formatManYenParts } from '../../presentation/ui9i/formatters'
import { compactAmountText } from '../../presentation/ui9i/portfolioPresentation'
import { Donut, GapList, Legend } from './PortfolioParts'
import { DeployableCashRow, GrossCashRow } from './TodayHomeView'
import { Card } from './primitives'

/** PF 面の「‹」の戻り先（今日）。 */
const TODAY_TARGET: NavTarget = { tab: 'T0', surface: null }

const noValue = (link: HubRowViewModel['link']): HubRowViewModel => ({ link, valueLabel: null, valueUnavailable: false })

function HubList({ rows, onNavigate }: { rows: readonly HubRowViewModel[]; onNavigate: (t: NavTarget) => void }) {
  return (
    <div>
      {rows.map(({ link, valueLabel, valueUnavailable }) => (
        <button key={link.id} type="button" className="u9-hub-item" onClick={() => onNavigate(link.target)} data-hub-link={link.id}>
          <span className="u9-hub-item__glyph" data-tone={link.tone} aria-hidden="true">{link.glyph}</span>
          <span className="u9-hub-item__text">
            <span className="u9-hub-item__title">{link.title}</span>
            <span className="u9-hub-item__desc">{link.description}</span>
          </span>
          {valueLabel !== null && (
            <span className="u9-hub-item__value" data-unavailable={valueUnavailable ? 'true' : undefined}>{valueLabel}</span>
          )}
          <span className="u9-hub-item__chev" aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  )
}

/** 主ナビ直下の面（投信 / その他 / PF）。白いヘッダーバー + 淡い地 + 白い角丸カード。 */
function SurfaceFrame({ title, testId, back, meta, children }: {
  title: string
  testId: string
  /** 指定時のみ「‹」を出す（モバイルのみ表示）。 */
  back?: () => void
  /** デスクトップのヘッダー右端に出す時刻など。 */
  meta?: string
  children: ReactNode
}) {
  return (
    <div className="u9-page u9-surface u9-surface--top" data-testid={testId}>
      <div className="u9-surface__head">
        {back !== undefined && <button type="button" className="u9-surface__back" onClick={back} aria-label="今日に戻る">‹</button>}
        <h1 className="u9-surface__title">{title}</h1>
        {meta !== undefined && <span className="u9-meta u9-surface__meta">{meta}</span>}
      </div>
      <div className="u9-surface__body">{children}</div>
    </div>
  )
}

export function FundsHubView({ vm, onNavigate }: { vm: FundsHubViewModel; onNavigate: (t: NavTarget) => void }) {
  return (
    <SurfaceFrame title="投信" testId="funds-hub">
      <Card first data-testid="funds-hub-links" className="u9-card--list">
        <HubList rows={vm.rows} onNavigate={onNavigate} />
      </Card>
      <p className="u9-note u9-surface__note">ハブ自体は判断を持ちません。各画面の業務責務はそのままです。</p>
      <Card title="投信の目標との差" data-testid="funds-hub-gaps">
        {vm.gapRows === null ? (
          <p className="u9-note" data-testid="funds-hub-gaps-unavailable">配分情報を利用できません。目標との差は判定不能です。</p>
        ) : (
          <dl className="u9-defs">
            {vm.gapRows.map(r => (
              <div key={r.assetClass} className="u9-defs__row"><dt>{r.label}</dt><dd>{r.text}</dd></div>
            ))}
          </dl>
        )}
      </Card>
    </SurfaceFrame>
  )
}

export function OtherHubView({ vm, onNavigate }: { vm: OtherHubViewModel; onNavigate: (t: NavTarget) => void }) {
  return (
    <SurfaceFrame title="その他" testId="other-hub">
      <Card first data-testid="other-hub-links" className="u9-card--list">
        <HubList rows={vm.links.map(noValue)} onNavigate={onNavigate} />
      </Card>
      <p className="u9-note u9-surface__note">AI委員会は最終判断ではありません。最終判断は「今日」に表示します。</p>
      <Card title="システム" data-testid="other-hub-system">
        <dl className="u9-defs">
          {vm.system.map(r => (
            <div key={r.id} className="u9-defs__row">
              <dt>{r.label}</dt>
              <dd data-system-row={r.id} data-unavailable={r.unavailable ? 'true' : undefined}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </SurfaceFrame>
  )
}

function TotalAssets({ totalAssets }: { totalAssets: number }) {
  const parts = formatManYenParts(totalAssets)
  return (
    <div className="u9-pf-total__row">
      <span className="u9-pf-total__value" data-testid="portfolio-total-value">{parts === null ? '—' : parts.value}</span>
      {parts !== null && <span className="u9-pf-total__unit">{parts.unit}</span>}
    </div>
  )
}

export function PortfolioSurfaceView({ vm, onNavigate }: { vm: PortfolioSurfaceViewModel; onNavigate: (t: NavTarget) => void }) {
  const pf = vm.portfolio
  const snapshot = vm.snapshotLabel
  return (
    <SurfaceFrame
      title="ポートフォリオ"
      testId="portfolio-surface"
      back={() => onNavigate(TODAY_TARGET)}
      meta={snapshot === null ? undefined : `配分 ${snapshot}`}
    >
      {pf === null ? (
        // 配分スナップショットが無い場合、劣化するのは配分に依存する領域だけ（Home の判断は独立）。
        <Card first data-testid="portfolio-surface-unavailable">
          <div className="u9-unavail">
            <span className="u9-unavail__title">配分情報を利用できません</span>
            <span className="u9-note">構成・目標との差は判定不能です。現金の情報は下に別掲します。</span>
          </div>
          <div className="u9-gap-block">
            <GrossCashRow cash={vm.grossCash} />
            <DeployableCashRow cash={vm.deployableCash} />
          </div>
        </Card>
      ) : (
        <div className="u9-pf-layout">
          <Card first className="u9-pf-total" data-testid="portfolio-total">
            <span className="u9-pf-total__label">総資産</span>
            <TotalAssets totalAssets={pf.totalAssets} />
            {snapshot !== null && <span className="u9-meta u9-pf-total__snap">配分スナップショット {snapshot}</span>}
          </Card>
          <Card title="構成（保有している内訳）" className="u9-pf-comp" data-testid="portfolio-composition">
            <div className="u9-pf-top">
              <Donut
                rows={pf.rows}
                centerLabel="総資産"
                centerValue={compactAmountText({ currentAmount: pf.totalAssets })}
                desktopHole={{ label: '構成', value: `${pf.rows.length}クラス` }}
              />
              <Legend rows={pf.rows} value="amount" />
            </div>
          </Card>
          <Card title="目標との差" meta="現在 ▮ / 目標 ▏" className="u9-pf-gaps" data-testid="portfolio-gaps">
            {/* 6 クラスすべてを canonical 順で全件表示。UI 側で並べ替え・要約・間引きをしない。 */}
            <GapList rows={pf.rows} bars />
            <p className="u9-note">現在比率は表示用に総資産から算出しています。方向と金額は権限の targetGap / overweightAmount をそのまま表示します。</p>
          </Card>
          <Card title="現金" className="u9-pf-cash" data-testid="portfolio-cash">
            <GrossCashRow cash={vm.grossCash} />
            <DeployableCashRow cash={vm.deployableCash} />
            <p className="u9-note">実行可能現金は現金残高とは別の権限です。利用できない場合は「利用不可」と表示し、0円には置き換えません。</p>
          </Card>
        </div>
      )}
      <Card className="u9-card--list u9-pf-links">
        <HubList rows={PF_SURFACE_LINKS.map(noValue)} onNavigate={onNavigate} />
      </Card>
    </SurfaceFrame>
  )
}
