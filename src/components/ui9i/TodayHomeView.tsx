// UI-9I Phase 1: T0（今日）の純表示 view。
// 入力は TodayHomeViewModel のみ。canonical から意味を再導出しない。
// セクションの DOM 順は状態によらず固定（動的に並べ替えない）:
//   Hero → 状態チップ → 判断生成時刻 → 注目ポイント → データの状態 → 候補 → ポートフォリオ → マーケット
import type {
  AttentionItem,
  DeployableCashViewModel,
  GrossCashViewModel,
  MarketViewModel,
  TodayHomeViewModel,
} from '../../presentation/ui9i/todayHome'
import type { CandidateSectionProjection } from '../../presentation/ui9i/candidatePresentation'
import type { PortfolioProjection } from '../../presentation/ui9i/portfolioPresentation'
import {
  formatManYen,
  formatSignedPct1,
  formatYen,
} from '../../presentation/ui9i/formatters'
import { UNAVAILABLE_LABEL } from '../../presentation/ui9i/labels'
import { HeroCard } from './HeroCard'
import { Card, LinkRow, StatusDot } from './primitives'
import { AtTargetLine, Donut, GapList, Legend } from './PortfolioParts'

export interface TodayHomeActions {
  onOpenAudit: () => void
  onOpenPortfolio: () => void
  onOpenCandidates: () => void
}

const ATTN_GLYPH: Record<AttentionItem['glyph'], string> = { safe: '▲', lock: '◆', info: '◇' }

function StateChips({ chips }: { chips: NonNullable<TodayHomeViewModel['chips']> }) {
  const attn = chips.attentionCount
  return (
    <div className="u9-chips u9-area-chips" data-testid="state-chips">
      <div className="u9-chip">
        <span className="u9-chip__label"><span className="u9-chip__icon" data-kind="regime" aria-hidden="true">◎</span>市場レジーム</span>
        <span className="u9-chip__value" data-testid="chip-regime">{chips.regime.label}</span>
      </div>
      <div className="u9-chip">
        <span className="u9-chip__label">
          <span className="u9-chip__icon" data-kind={chips.mode.label === '通常' || !chips.mode.available ? 'mode' : 'mode-caution'} aria-hidden="true">◍</span>運用モード
        </span>
        <span className="u9-chip__value" data-testid="chip-mode">{chips.mode.label}</span>
      </div>
      <div className="u9-chip">
        <span className="u9-chip__label"><span className="u9-chip__icon" data-kind={attn > 0 ? 'attn-active' : 'attn-none'} aria-hidden="true">！</span>重要な注意</span>
        <span className="u9-chip__value" data-testid="chip-attention">{attn > 0 ? `${attn}件` : 'なし'}</span>
      </div>
    </div>
  )
}

function AttentionCard({ items: all }: { items: readonly AttentionItem[] }) {
  // data-wait は「データの状態」カードが表示を担う（R4.1 M2-C）。件数チップには数える。
  const items = all.filter(item => item.id !== 'data-wait')
  if (items.length === 0) return null // 通常時は注目ポイントの節を出さない
  return (
    <Card title="注目ポイント" first className="u9-area-attn" data-testid="attention-card">
      {items.map(item => (
        <div key={item.id} className="u9-attn">
          <span className="u9-attn__mark" data-glyph={item.glyph} aria-hidden="true">{ATTN_GLYPH[item.glyph]}</span>
          <div>
            <div className="u9-attn__title">{item.title}</div>
            <div className="u9-attn__detail">{item.detail}</div>
          </div>
        </div>
      ))}
    </Card>
  )
}

function DataStatusCard({ rows }: { rows: TodayHomeViewModel['dataStatus'] }) {
  if (rows.length === 0) return null
  return (
    <Card title="データの状態" first className="u9-area-data" data-testid="data-status-card">
      <div className="u9-status-list">
        {rows.map(r => (
          <div key={r.id} className="u9-status-row">
            <StatusDot mark={r.mark} />
            <span className="u9-status-row__label">{r.label}</span>
            <span className="u9-status-row__value" data-mark={r.mark}>{r.value}</span>
          </div>
        ))}
      </div>
      <p className="u9-note">鮮度はデータセットごとに扱います。ひとつの遅延から全体の無効は推定しません。</p>
    </Card>
  )
}

export function DeployableCashRow({ cash }: { cash: DeployableCashViewModel }) {
  // unavailable を ¥0 に変換しない
  const text = cash.kind === 'available' ? (formatYen(cash.amountJpy) ?? UNAVAILABLE_LABEL) : UNAVAILABLE_LABEL
  return (
    <div className="u9-kv">
      <span>実行可能現金</span>
      <span className="u9-kv__value" data-testid="deployable-cash" data-unavailable={cash.kind === 'unavailable'}>{text}</span>
    </div>
  )
}

export function GrossCashRow({ cash }: { cash: GrossCashViewModel }) {
  return (
    <div className="u9-kv">
      <span>総現金</span>
      <span className="u9-kv__value" data-testid="gross-cash">
        {cash.kind === 'known' ? (formatManYen(cash.amountJpy) ?? '—') : '未設定'}
      </span>
    </div>
  )
}

function CandidateCard({ section, hero, cash, onOpenAll, onOpenAudit }: {
  section: CandidateSectionProjection
  hero: TodayHomeViewModel['hero']
  cash: DeployableCashViewModel
  onOpenAll: () => void
  onOpenAudit: () => void
}) {
  const counts = section.status === 'available' && section.totalCount > 0
    ? `${section.executableCount} 実行可能 · ${section.reviewCount} 要レビュー`
    : null
  const dim = hero.state === 'data_wait'
  return (
    <Card title="候補" meta={counts ?? undefined} className="u9-area-cand" data-testid="candidate-card">
      {section.status === 'unavailable' ? (
        <>
          <div className="u9-unavail" data-testid="candidate-unavailable">
            <span className="u9-unavail__title">候補評価を利用できません</span>
            <span className="u9-note">候補の有無を判断できません。「候補なし」とは異なります。</span>
          </div>
          <LinkRow label="原因を見る" onClick={onOpenAudit} />
        </>
      ) : section.totalCount === 0 ? (
        <div className="u9-empty" data-testid="candidate-empty">
          <span className="u9-empty__mark" aria-hidden="true">◔</span>
          <span className="u9-empty__title">現在、実行可能な候補はありません</span>
          <span className="u9-note">評価は正常です。条件を満たす候補がある場合、この画面に表示します。</span>
        </div>
      ) : (
        <>
          {hero.state === 'safe_mode' && (
            <div className="u9-inline-note" data-tone="warm"><span aria-hidden="true">▲</span>SAFE MODE により新規実行を停止中</div>
          )}
          {hero.state === 'data_wait' && (
            <div className="u9-inline-note"><span aria-hidden="true">◷</span>データ更新待ちのため実行できません（参照のみ）</div>
          )}
          <ul className="u9-cand-list" data-dim={dim} aria-label="候補の先頭3件（提示順）">
            {section.rows.map(row => (
              <li key={row.entryId} className="u9-cand-row" data-kind={row.kind}>
                <span className="u9-pill" data-rel={row.relationship}>{row.relationshipLabel}</span>
                <div className="u9-cand-row__main">
                  <span className="u9-cand-row__name">{row.code === null ? row.displayName : `${row.code} ${row.displayName}`}</span>
                  {row.marketScore !== null && <span className="u9-cand-row__score">市場スコア {row.marketScore}</span>}
                </div>
                {row.stateLabel !== null && <span className="u9-cand-row__state" data-kind={row.kind}>{row.stateLabel}</span>}
                {row.executableAmountJpy !== null && (
                  <span className="u9-amount">
                    <span>実行可能額（権限提示）</span>
                    <span className="u9-amount__value" data-testid="candidate-amount">{formatYen(row.executableAmountJpy)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {section.executableCount > 0 && <DeployableCashRow cash={cash} />}
          {hero.state === 'normal' && section.executableCount === 0 && (
            <p className="u9-note">実行可能な候補はありません。評価は正常です。</p>
          )}
          {hero.state === 'safe_mode' && <p className="u9-note">候補の評価は正常です。実行のみを停止しています。</p>}
          <LinkRow label={`候補をすべて見る（${section.totalCount}件）`} onClick={onOpenAll} />
        </>
      )}
    </Card>
  )
}

function PortfolioCard({ vm, onOpenPortfolio }: { vm: TodayHomeViewModel; onOpenPortfolio: () => void }) {
  const pf: PortfolioProjection | null = vm.portfolio
  const total = pf === null ? null : formatManYen(pf.totalAssets)
  const offTarget = pf === null ? [] : pf.rows.filter(r => r.direction !== 'on_target')
  const onTarget = pf === null ? [] : pf.rows.filter(r => r.direction === 'on_target')
  return (
    <Card
      title="ポートフォリオ"
      meta={total === null ? undefined : `総資産 ${total}`}
      className="u9-area-pf"
      data-testid="portfolio-card"
    >
      {pf === null ? (
        <div className="u9-unavail" data-testid="portfolio-unavailable">
          <span className="u9-unavail__title">配分の判定不能</span>
          <span className="u9-note">配分スナップショットを利用できません。</span>
        </div>
      ) : (
        <>
          <div className="u9-pf-top">
            <Donut rows={pf.rows} centerLabel="構成" centerValue={`${pf.rows.length}クラス`} />
            <Legend rows={pf.rows} />
          </div>
          <div className="u9-gap-block">
            <span className="u9-subhead">目標との差</span>
            {/* モバイル: 目標水準ではないクラスのみ + 目標水準は 1 行に要約 / デスクトップ: 6 クラス全件（canonical 順） */}
            <div className="u9-pf-summary">
              <GapList rows={offTarget} bars />
              <AtTargetLine rows={onTarget} allRowsCount={pf.rows.length} />
            </div>
            <div className="u9-pf-full"><GapList rows={pf.rows} bars={false} /></div>
          </div>
        </>
      )}
      {vm.hero.state === 'data_wait' && (
        <div className="u9-gap-block" data-testid="cash-pair">
          <GrossCashRow cash={vm.grossCash} />
          <DeployableCashRow cash={vm.deployableCash} />
        </div>
      )}
      {vm.hero.state === 'safe_mode' && (
        <p className="u9-note">参照と確認は通常どおり行えます。リバランスの実行のみ停止中です。</p>
      )}
      <LinkRow label="ポートフォリオを見る" onClick={onOpenPortfolio} />
    </Card>
  )
}

function MarketCard({ market }: { market: MarketViewModel }) {
  return (
    <Card title="マーケット" meta={market.asOfLabel === null ? '市場データ 取得できていません' : `市場データ ${market.asOfLabel}`} className="u9-area-market" data-testid="market-card">
      <dl className="u9-market-grid">
        {market.indicators.map(ind => {
          const chg = formatSignedPct1(ind.changePct)
          return (
            <div key={ind.id} className="u9-market-item" data-indicator={ind.id}>
              <dt>{ind.label}</dt>
              <dd data-testid={`market-${ind.id}`}>
                {ind.value === null ? '—' : ind.value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}
              </dd>
              {chg !== null && <dd className="u9-market-item__chg" data-sign={(ind.changePct ?? 0) < 0 ? 'neg' : 'pos'}>{chg}</dd>}
            </div>
          )
        })}
      </dl>
    </Card>
  )
}

function UnavailableDetail({ detail }: { detail: NonNullable<TodayHomeViewModel['unavailableDetail']> }) {
  return (
    <>
      <Card title="利用できない情報" first data-testid="unavailable-list">
        <div className="u9-status-list">
          {detail.unavailable.map(r => (
            <div key={r.id} className="u9-status-row">
              <StatusDot mark="fail" />
              <span className="u9-status-row__label">{r.label}</span>
              <span className="u9-status-row__value">{r.value}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="安全に確認できる情報" data-testid="safe-available-list">
        <div className="u9-status-list">
          {detail.available.map(r => (
            <div key={r.id} className="u9-status-row">
              <StatusDot mark={r.value === null || r.value === UNAVAILABLE_LABEL ? 'wait' : 'ok'} />
              <span className="u9-status-row__label">{r.label}</span>
              <span className="u9-status-row__value">{r.value ?? UNAVAILABLE_LABEL}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

export function TodayHomeView({ vm, dateLabel, yearLabel, actions, heroImageSrc }: {
  vm: TodayHomeViewModel
  dateLabel: string
  /** デスクトップのみ表示（D1: 2026年10月6日（月））。 */
  yearLabel?: string
  actions: TodayHomeActions
  heroImageSrc?: string
}) {
  const { hero } = vm
  return (
    <div className="u9-page" data-tone={hero.tone} data-hero-state={hero.state} data-testid="today-home">
      <div className="u9-appbar">
        <span className="u9-appbar__brand">Investment OS</span>
        <span className="u9-appbar__avatar" aria-hidden="true" />
      </div>
      <header className="u9-greeting">
        <div>
          <span className="u9-greeting__date">{yearLabel !== undefined && <span className="u9-greeting__year">{yearLabel}</span>}{dateLabel}</span>
          <div className="u9-greeting__hello">おはようございます</div>
          <div className="u9-greeting__line">市場を冷静に見つめ、長期の資産形成を続けましょう。</div>
        </div>
        <div className="u9-greeting__aside">一歩ずつ、<br />理想の未来に近づく。</div>
      </header>

      <div className="u9-home">
        <HeroCard hero={hero} onCta={actions.onOpenAudit} imageSrc={heroImageSrc} />

        {vm.chips !== null && <StateChips chips={vm.chips} />}
        {hero.generatedAtLabel !== null && hero.state !== 'decision_unavailable' && (
          <div className="u9-generated u9-area-gen" data-testid="generated-at">判断生成 {hero.generatedAtLabel}</div>
        )}

        {vm.unavailableDetail !== null ? (
          <UnavailableDetail detail={vm.unavailableDetail} />
        ) : hero.state === 'boot' ? null : (
          <>
            <AttentionCard items={vm.attention} />
            <DataStatusCard rows={vm.dataStatus} />
            <CandidateCard section={vm.candidates} hero={hero} cash={vm.deployableCash} onOpenAll={actions.onOpenCandidates} onOpenAudit={actions.onOpenAudit} />
            <PortfolioCard vm={vm} onOpenPortfolio={actions.onOpenPortfolio} />
            <MarketCard market={vm.market} />
          </>
        )}
      </div>
    </div>
  )
}
