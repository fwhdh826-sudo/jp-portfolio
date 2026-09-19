// UI-9I Phase 1: 投信ハブ / その他ハブ / PF 面。
// ハブ自体は投資ロジックを持たない（既存画面への到達だけを提供する）。
// AI委員会は Home の最終判断（OfficialDecision）と競合させない。
import type { HubLink, NavTarget } from '../../presentation/ui9i/navigation'
import { FUNDS_HUB_LINKS, OTHER_HUB_LINKS, PF_SURFACE_LINKS } from '../../presentation/ui9i/navigation'
import type { PortfolioSurfaceViewModel } from '../../presentation/ui9i/portfolioSurface'
import { formatManYen } from '../../presentation/ui9i/formatters'
import { AtTargetLine, Donut, GapList, Legend } from './PortfolioParts'
import { DeployableCashRow, GrossCashRow } from './TodayHomeView'
import { Card } from './primitives'

function HubList({ links, onNavigate }: { links: readonly HubLink[]; onNavigate: (t: NavTarget) => void }) {
  return (
    <div>
      {links.map(link => (
        <button key={link.id} type="button" className="u9-hub-item" onClick={() => onNavigate(link.target)} data-hub-link={link.id}>
          <span className="u9-hub-item__glyph" aria-hidden="true">{link.glyph}</span>
          <span className="u9-hub-item__text">
            <span className="u9-hub-item__title">{link.title}</span>
            <span className="u9-hub-item__desc">{link.description}</span>
          </span>
          <span className="u9-hub-item__chev" aria-hidden="true">›</span>
        </button>
      ))}
    </div>
  )
}

function SurfaceFrame({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="u9-page u9-surface" data-testid={testId}>
      <div className="u9-surface__head"><h1 className="u9-surface__title">{title}</h1></div>
      <div className="u9-surface__body">{children}</div>
    </div>
  )
}

export function FundsHubView({ onNavigate }: { onNavigate: (t: NavTarget) => void }) {
  return (
    <SurfaceFrame title="投信" testId="funds-hub">
      <Card first>
        <HubList links={FUNDS_HUB_LINKS} onNavigate={onNavigate} />
        <p className="u9-note">ハブ自体は判断を持ちません。各画面の業務責務はそのままです。</p>
      </Card>
    </SurfaceFrame>
  )
}

export function OtherHubView({ onNavigate }: { onNavigate: (t: NavTarget) => void }) {
  return (
    <SurfaceFrame title="その他" testId="other-hub">
      <Card first>
        <HubList links={OTHER_HUB_LINKS} onNavigate={onNavigate} />
        <p className="u9-note">AI委員会は最終判断ではありません。最終判断は「今日」に表示します。</p>
      </Card>
    </SurfaceFrame>
  )
}

export function PortfolioSurfaceView({ vm, onNavigate }: { vm: PortfolioSurfaceViewModel; onNavigate: (t: NavTarget) => void }) {
  const pf = vm.portfolio
  return (
    <SurfaceFrame title="ポートフォリオ" testId="portfolio-surface">
      {pf === null ? (
        <Card first data-testid="portfolio-surface-unavailable">
          <div className="u9-unavail">
            <span className="u9-unavail__title">配分の判定不能</span>
            <span className="u9-note">配分スナップショットを利用できません。</span>
          </div>
          <div className="u9-gap-block">
            <GrossCashRow cash={vm.grossCash} />
            <DeployableCashRow cash={vm.deployableCash} />
          </div>
        </Card>
      ) : (
        <>
          <Card title="構成（保有している内訳）" meta={vm.snapshotLabel === null ? undefined : `配分スナップショット ${vm.snapshotLabel}`} first data-testid="portfolio-composition">
            <div className="u9-pf-top">
              <Donut rows={pf.rows} centerLabel="総資産" centerValue={formatManYen(pf.totalAssets) ?? '—'} />
              <Legend rows={pf.rows} />
            </div>
          </Card>
          <Card title="目標との差" meta="現在 ▮ / 目標 ▏" data-testid="portfolio-gaps">
            {/* 6 クラスすべてを canonical 順で表示。UI 側で並べ替えない。 */}
            <GapList rows={pf.rows} bars />
            <AtTargetLine rows={pf.rows.filter(r => r.direction === 'on_target')} allRowsCount={pf.rows.length} />
            <p className="u9-note">現在比率は表示用に総資産から算出しています。方向と金額は権限の targetGap / overweightAmount をそのまま表示します。</p>
          </Card>
          <Card title="現金" data-testid="portfolio-cash">
            <GrossCashRow cash={vm.grossCash} />
            <DeployableCashRow cash={vm.deployableCash} />
            <p className="u9-note">実行可能現金は現金残高とは別の権限です。利用できない場合は「利用不可」と表示し、0円には置き換えません。</p>
          </Card>
        </>
      )}
      <Card>
        <HubList links={PF_SURFACE_LINKS} onNavigate={onNavigate} />
      </Card>
    </SurfaceFrame>
  )
}
