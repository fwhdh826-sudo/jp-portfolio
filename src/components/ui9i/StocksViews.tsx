// UI-9I Phase 2B-1: 個別株（旧 T1）の一覧 / 詳細（R4.1 凍結デザインの視覚言語）。
// 純表示: view-model（stocksPresentation）だけを受け取り、判断・並べ替え・金額計算・鮮度判定をしない。
import type { ReactNode } from 'react'
import { SixAxisRadar, CANONICAL_AXES_ORDER, AXIS_LABEL } from '../charts/SixAxisRadar'
import { EightAxisRadar } from '../charts/EightAxisRadar'
import type { ScoreAxisId } from '../../types'
import {
  projectCompareRows,
  stockRegimeDisplayLabel,
  type LabeledValue,
  type StockCandidateRowViewModel,
  type StockCandidateSectionViewModel,
  type StockDetailFound,
  type StockDetailViewModel,
  type StockRowViewModel,
  type StocksListViewModel,
  type RowTone,
} from '../../presentation/ui9i/stocksPresentation'
import { Card } from './primitives'

/** 一覧 / 詳細で共通の面フレーム（白いヘッダーバー + 淡い地 + 白い角丸カード）。 */
function StocksFrame({ title, testId, meta, back, children }: {
  title: string
  testId: string
  meta?: string
  back?: { label: string; ariaLabel: string; onClick: () => void }
  children: ReactNode
}) {
  return (
    <div className="u9-page u9-surface u9-surface--top u9-stk" data-testid={testId}>
      <div className="u9-surface__head">
        {back !== undefined && (
          <button type="button" className="u9-stk-back" onClick={back.onClick} aria-label={back.ariaLabel} data-testid="stocks-back">
            <span aria-hidden="true">‹</span>
            <span>{back.label}</span>
          </button>
        )}
        <h1 className="u9-surface__title">{title}</h1>
        {meta !== undefined && <span className="u9-meta u9-surface__meta">{meta}</span>}
      </div>
      <div className="u9-surface__body">{children}</div>
    </div>
  )
}

function Notice({ id, tone, children }: { id: string; tone?: 'warm'; children: ReactNode }) {
  return <div className="u9-inline-note u9-stk-notice" data-tone={tone} data-notice={id} role="note">{children}</div>
}

function Empty({ mark, title, detail }: { mark: string; title: string; detail?: string }) {
  return (
    <div className="u9-empty">
      <span className="u9-empty__mark" aria-hidden="true">{mark}</span>
      <span className="u9-empty__title">{title}</span>
      {detail !== undefined && <span className="u9-note">{detail}</span>}
    </div>
  )
}

// ── 一覧 ──────────────────────────────────────────────────────

function StockRow({ row, onSelect }: { row: StockRowViewModel; onSelect: (code: string) => void }) {
  return (
    <li>
      <button
        type="button"
        className="u9-stk-row"
        data-code={row.code}
        data-decision={row.decision}
        onClick={() => onSelect(row.code)}
      >
        <span className="u9-stk-row__main">
          <span className="u9-stk-row__id">
            <span className="u9-stk-code">{row.code}</span>
            <span className="u9-pill" data-rel="already_held">{row.relationshipLabel}</span>
            {row.locked && <span className="u9-stk-tag" data-kind="lock">ロック</span>}
            {row.stopLossWarning && <span className="u9-stk-tag" data-kind="warn">含み損警戒</span>}
          </span>
          <span className="u9-stk-row__name">{row.name}</span>
          <span className="u9-stk-row__meta">
            <span>{row.sector}</span>
            {row.score !== null && <span className="u9-stk-row__score">総合スコア {row.score}</span>}
          </span>
        </span>
        <span className="u9-stk-row__side">
          <span className="u9-stk-row__pnl" data-sign={row.pnlSign}><span className="u9-stk-row__pnl-label">損益</span> {row.pnlLabel}</span>
          <span className="u9-stk-state" data-tone={row.tone}>{row.decisionLabel}</span>
        </span>
        <span className="u9-hub-item__chev" aria-hidden="true">›</span>
      </button>
    </li>
  )
}

function CompareTable({ rows }: { rows: readonly StockRowViewModel[] }) {
  const cmp = projectCompareRows(rows)
  return (
    <details className="u9-disclose" data-testid="stocks-compare-details">
      <summary className="u9-disclose__summary">スコア・損益・RSI・ランクを表で見る</summary>
      <div className="u9-table-scroll" role="region" aria-label="銘柄の比較表" tabIndex={0}>
        <table className="u9-table">
          <thead>
            <tr>
              <th scope="col">銘柄</th><th scope="col">判断</th><th scope="col">総合スコア</th>
              <th scope="col">損益</th><th scope="col">RSI</th><th scope="col">総合ランク</th>
            </tr>
          </thead>
          <tbody>
            {cmp.map(r => (
              <tr key={r.code} data-code={r.code}>
                <th scope="row">
                  <span className="u9-stk-code">{r.code}</span>
                  <span className="u9-table__sub">{r.name}</span>
                  {r.locked && <span className="u9-table__sub">ロック</span>}
                </th>
                <td data-decision={r.decision}>{r.decisionLabel}</td>
                <td>{r.scoreLabel}</td>
                <td>{r.pnlLabel}</td>
                <td>{r.rsiLabel}</td>
                <td>{r.rankLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="u9-note">RSI: 30 以下は売られすぎ / 70 以上は買われすぎ（表示専用）。総合スコアは分析データが揃った銘柄のみ表示します。</p>
    </details>
  )
}

export function CandidateRow({ row }: { row: StockCandidateRowViewModel }) {
  return (
    <li className="u9-cand-row u9-stk-cand" data-kind={row.kind} data-entry={row.entryId}>
      <div className="u9-cand-row__main">
        <span className="u9-cand-row__name">
          {row.code !== null && <span className="u9-stk-code">{row.code}</span>} {row.displayName}
        </span>
        <span className="u9-stk-row__id">
          <span className="u9-pill" data-rel={row.relationship}>{row.relationshipLabel}</span>
          <span className="u9-stk-tag" data-kind="action">{row.actionLabel}</span>
          {row.marketScore !== null && <span className="u9-cand-row__score">市場スコア {row.marketScore.toFixed(1)}</span>}
        </span>
        {row.metrics !== null && (
          <dl className="u9-stk-metrics">
            {row.metrics.map(m => (
              <div key={m.label}><dt>{m.label}</dt><dd>{m.value}</dd></div>
            ))}
          </dl>
        )}
        {row.blockingLabels.length > 0 && <span className="u9-stk-reason" data-kind="block">除外理由: {row.blockingLabels.join('・')}</span>}
        {row.warningLabels.length > 0 && <span className="u9-stk-reason" data-kind="warn">注意: {row.warningLabels.join('・')}</span>}
        {row.limitingLabels.length > 0 && (
          <span className="u9-stk-chips">{row.limitingLabels.map(f => <span key={f} className="u9-stk-tag">{f}</span>)}</span>
        )}
        {row.executableAmountLabel === null && row.nonExecutableReason !== null && !row.blockingLabels.includes(row.nonExecutableReason) && (
          <span className="u9-stk-reason">{row.nonExecutableReason}</span>
        )}
        {row.suppressedNote !== null && <span className="u9-stk-reason" data-kind="warn">{row.suppressedNote}</span>}
      </div>
      {row.stateLabel !== null && <span className="u9-cand-row__state" data-kind={row.kind}>{row.stateLabel}</span>}
      {row.executableAmountLabel !== null && (
        <div className="u9-amount">
          <span>実行可能額（AllocationPlan認可）</span>
          <span className="u9-amount__value" data-testid="stock-candidate-amount">{row.executableAmountLabel}</span>
        </div>
      )}
    </li>
  )
}

function CandidatesCard({ section, notice }: { section: StockCandidateSectionViewModel; notice: string | null }) {
  return (
    <Card title="候補（AllocationPlan認可）" meta={section.status === 'available' ? section.countLabel : undefined} data-testid="stocks-candidates">
      <p className="u9-note">調査候補であり、投資判断ではありません。実行可能額はAllocationPlanが唯一の権限です。売買はご自身の判断で行ってください。</p>
      {notice !== null && <Notice id="candidate_holdings_stale" tone="warm">{notice}</Notice>}
      {section.status === 'unavailable' && (
        <div className="u9-unavail" data-testid="stocks-candidates-unavailable">
          <span className="u9-unavail__title">{section.message}</span>
          <span className="u9-note">{section.detail}</span>
        </div>
      )}
      {section.status === 'available' && section.empty && <Empty mark="✓" title="現在は候補がありません" />}
      {section.status === 'available' && !section.empty && (
        <ul className="u9-cand-list">
          {section.rows.map(r => <CandidateRow key={r.entryId} row={r} />)}
        </ul>
      )}
    </Card>
  )
}

export function StocksListView({ vm, onSelect, funnelSlot }: {
  vm: StocksListViewModel
  onSelect: (code: string) => void
  /** 市場全体 candidate funnel（observability only）。自前で store を読む既存パネルを差し込む。 */
  funnelSlot?: ReactNode
}) {
  return (
    <StocksFrame title="個別株" testId="stocks-surface" meta={vm.analysisTimeLabel === null ? undefined : `分析 ${vm.analysisTimeLabel}`}>
      {vm.notices.map(n => (
        <Notice key={n.id} id={n.id} tone="warm">{n.text}</Notice>
      ))}
      <Card first title="保有銘柄" meta={vm.countLabel} className="u9-card--list" data-testid="stocks-list">
        {vm.rows.length === 0 ? (
          <Empty mark="—" title="保有銘柄なし" detail="CSVをインポートするか、データを更新してください。" />
        ) : (
          <ul className="u9-stk-list">
            {vm.rows.map(r => <StockRow key={r.code} row={r} onSelect={onSelect} />)}
          </ul>
        )}
      </Card>
      {vm.rows.length >= 2 && (
        <Card title="銘柄の比較" meta="表示専用" data-testid="stocks-compare">
          <CompareTable rows={vm.rows} />
        </Card>
      )}
      <CandidatesCard section={vm.candidates} notice={vm.candidateNotice} />
      {funnelSlot}
    </StocksFrame>
  )
}

// ── 詳細 ──────────────────────────────────────────────────────

const TONE_MARK: Record<RowTone, string> = { positive: '＋', neutral: '・', negative: '－' }

function Defs({ rows, testId }: { rows: readonly LabeledValue[]; testId?: string }) {
  return (
    <dl className="u9-defs" data-testid={testId}>
      {rows.map(r => <div key={r.label} className="u9-defs__row"><dt>{r.label}</dt><dd>{r.value}</dd></div>)}
    </dl>
  )
}

function ReasonList({ items }: { items: readonly string[] }) {
  return <ul className="u9-stk-reasons">{items.map((r, i) => <li key={i}>{r}</li>)}</ul>
}

function Disclose({ title, testId, open, children }: { title: string; testId?: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="u9-disclose" open={open} data-testid={testId}>
      <summary className="u9-disclose__summary"><h3 className="u9-disclose__title">{title}</h3></summary>
      <div className="u9-disclose__body">{children}</div>
    </details>
  )
}

function AnalysisRows({ rows }: { rows: ReadonlyArray<{ label: string; value: string; evalLabel: string; reason: string; tone: RowTone }> }) {
  return (
    <ul className="u9-stk-arows">
      {rows.map(r => (
        <li key={r.label} className="u9-stk-arow" data-tone={r.tone}>
          <div className="u9-stk-arow__head">
            <span className="u9-stk-arow__label">{r.label}</span>
            <span className="u9-stk-arow__value">{r.value}</span>
            <span className="u9-stk-tag" data-tone={r.tone}><span aria-hidden="true">{TONE_MARK[r.tone]}</span> {r.evalLabel}</span>
          </div>
          <div className="u9-stk-arow__reason">{r.reason}</div>
        </li>
      ))}
    </ul>
  )
}

function Phase7({ record }: { record: NonNullable<StockDetailFound['phase7']> }) {
  const { six_axis, dynamic_total } = record
  return (
    <Disclose title="軸別スコア（Phase 7 / calculation-only）" testId="stock-phase7">
      <p className="u9-note">バックエンド計算の観察値です。注文指示ではありません。</p>
      <div className="u9-stk-p7head">
        {dynamic_total ? (
          <>
            <span className="u9-stk-tag">総合スコア {dynamic_total.total}（{dynamic_total.rating}）</span>
            <span className="u9-note" data-regime={dynamic_total.regime_used}>レジーム: {stockRegimeDisplayLabel(dynamic_total.regime_used)}</span>
          </>
        ) : <span className="u9-stk-tag">6軸スコア観察値</span>}
      </div>
      <div className="u9-radar"><SixAxisRadar scores={six_axis} accentColor="#2F6FBF" /></div>
      <ul className="u9-stk-arows">
        {CANONICAL_AXES_ORDER.map((axId: ScoreAxisId) => {
          const ax = six_axis[axId]
          if (!ax) return null
          return (
            <li key={axId} className="u9-stk-arow">
              <div className="u9-stk-arow__head">
                <span className="u9-stk-arow__label">{AXIS_LABEL[axId]}</span>
                <span className="u9-stk-arow__value">{ax.total}<span className="u9-stk-arow__unit"> {ax.rating}</span></span>
              </div>
              <div className="u9-stk-bar" aria-hidden="true"><span style={{ width: `${ax.total}%` }} /></div>
            </li>
          )
        })}
      </ul>
    </Disclose>
  )
}

function SupportingAnalysis({ d }: { d: StockDetailFound }) {
  const an = d.analysis
  return (
    <Card title="補助分析" meta="観察値" data-testid="stock-analysis">
      <p className="u9-note">
        以下は判断を支える観察値です。最終の判断は上の「現在の判断」で、注文指示ではありません（calculation-only / not an order）。
      </p>
      {d.evidenceNote !== null && <Notice id="analysis_reference" tone="warm">{d.evidenceNote}</Notice>}
      {an === null ? (
        <div className="u9-unavail" data-testid="stock-analysis-unavailable">
          <span className="u9-unavail__title">分析結果がまだありません</span>
          <span className="u9-note">データ更新後に表示されます。価格・損益などの保有情報は上に表示しています。</span>
        </div>
      ) : (
        <>
          <Disclose title="8軸レーダー" testId="stock-radar" open>
            <EightAxisRadar axes={an.axes} />
            <ul className="u9-stk-axes" aria-label="8軸スコア一覧">
              {an.axes.map(ax => (
                <li key={ax.label} className="u9-stk-axis">
                  <span className="u9-stk-axis__label">{ax.label}</span>
                  <span className="u9-stk-axis__value">{Math.round(ax.value)}</span>
                  <span className="u9-stk-bar" aria-hidden="true"><span style={{ width: `${ax.value}%` }} /></span>
                </li>
              ))}
            </ul>
          </Disclose>
          <Disclose title="各軸の根拠" testId="stock-axis-reasons">
            <ul className="u9-stk-arows">
              {an.axes.map(ax => (
                <li key={ax.label} className="u9-stk-arow">
                  <div className="u9-stk-arow__head">
                    <span className="u9-stk-arow__label">{ax.label}</span>
                    <span className="u9-stk-arow__value">{Math.round(ax.value)}</span>
                  </div>
                  <div className="u9-stk-arow__reason">{ax.reason}</div>
                </li>
              ))}
            </ul>
          </Disclose>
          <Disclose title="主要指標" testId="stock-key-metrics">
            <dl className="u9-stk-kpis">
              {an.keyMetrics.map(m => (
                <div key={m.label} className="u9-stk-kpi" data-tone={m.tone}>
                  <dt>{m.label}</dt><dd>{m.value}</dd>
                  <dd className="u9-stk-kpi__eval"><span aria-hidden="true">{TONE_MARK[m.tone]}</span> {m.evalLabel}</dd>
                </div>
              ))}
            </dl>
          </Disclose>
          <Disclose title="ファンダメンタル分析" testId="stock-fundamentals"><AnalysisRows rows={an.fundamentals} /></Disclose>
          <Disclose title="テクニカル分析" testId="stock-technicals"><AnalysisRows rows={an.technicals} /></Disclose>
        </>
      )}
      {d.phase7 !== null && <Phase7 record={d.phase7} />}
    </Card>
  )
}

function DetailNotFound({ code, onBack }: { code: string; onBack: () => void }) {
  return (
    <StocksFrame title="個別株" testId="stock-detail" back={{ label: '個別株', ariaLabel: '個別株一覧に戻る', onClick: onBack }}>
      <Card first data-testid="stock-detail-not-found">
        <Empty mark="—" title="銘柄データなし" detail={`銘柄コード ${code} は現在の保有データにありません。`} />
      </Card>
    </StocksFrame>
  )
}

export function StockDetailView({ vm, onBack }: { vm: StockDetailViewModel; onBack: () => void }) {
  if (!vm.found) return <DetailNotFound code={vm.code} onBack={onBack} />
  const d = vm
  const hasConstraints = d.constraints.length > 0 || d.lockNote !== null || d.lockReleasedNote !== null || d.stopLossNote !== null
  const hasReasons = d.reasons.bull.length > 0 || d.reasons.bear.length > 0
  const hasExecList = d.reasons.entry.length > 0 || d.reasons.takeProfit.length > 0 || d.reasons.stopLoss.length > 0 || d.reasons.wait.length > 0

  return (
    <StocksFrame
      title={d.name}
      testId="stock-detail"
      meta={d.analysisAtLabel === null ? undefined : `分析 ${d.analysisAtLabel}`}
      back={{ label: '個別株', ariaLabel: '個別株一覧に戻る', onClick: onBack }}
    >
      <Card first className="u9-stk-hero" data-testid="stock-hero" aria-label="銘柄の概要">
        <div className="u9-stk-row__id">
          <span className="u9-stk-code">{d.code}</span>
          <span className="u9-pill" data-rel="already_held">{d.relationshipLabel}</span>
          {d.locked && <span className="u9-stk-tag" data-kind="lock">売却ロック中</span>}
          {d.stopLossNote !== null && <span className="u9-stk-tag" data-kind="warn">含み損警戒</span>}
        </div>
        <div className="u9-stk-hero__sector">{d.sectorLine}</div>
        <div className="u9-stk-hero__state">
          <span className="u9-stk-state u9-stk-state--lg" data-tone={d.tone} data-decision={d.decision} data-testid="stock-decision">{d.decisionLabel}</span>
          {d.currentPriceLabel !== null && (
            <span className="u9-stk-hero__price"><span className="u9-stk-hero__price-label">現在値</span> {d.currentPriceLabel}</span>
          )}
        </div>
      </Card>

      <Card title="現在の判断" data-testid="stock-decision-card">
        <p className="u9-stk-comment" data-testid="stock-comment">{d.comment}</p>
        <Defs testId="stock-decision-defs" rows={[
          { label: '現在スタンス', value: d.stance },
          { label: '推奨アクション', value: d.recommendedAction },
          { label: 'リスクゲート', value: d.riskGate === null ? '利用不可' : d.riskGate.label },
          ...(d.confidenceLabel !== null ? [{ label: '信頼度', value: d.confidenceLabel }] : []),
          ...(d.score !== null ? [{ label: '総合スコア', value: String(d.score) }] : []),
          ...(d.rank !== null ? [{ label: '総合ランク', value: d.rank }] : []),
        ]} />
        <div className="u9-stk-conclusion">
          <div className="u9-subhead">結論</div>
          <div className="u9-stk-conclusion__title">{d.conclusionTitle}</div>
          <div className="u9-note">{d.conclusionText}</div>
        </div>
        {(d.highlight !== null || d.caution !== null) && (
          <ul className="u9-stk-reasons" aria-label="注目点と注意点">
            {d.highlight !== null && <li><span className="u9-stk-reasons__k">注目ポイント</span> {d.highlight}</li>}
            {d.caution !== null && <li><span className="u9-stk-reasons__k">注意点</span> {d.caution}</li>}
          </ul>
        )}
        {d.premiseBreak.length > 0 && (
          <div className="u9-inline-note" data-tone="warm" data-testid="stock-premise-break">
            <div>
              <div className="u9-subhead">前提崩れ条件（発生時は即座に再評価）</div>
              <ReasonList items={d.premiseBreak} />
            </div>
          </div>
        )}
      </Card>

      {hasReasons && (
        <Card title="判断の理由" data-testid="stock-reasons">
          <div className="u9-stk-cols">
            {d.reasons.bull.length > 0 && <div><h3 className="u9-subhead">Bull 要因</h3><ReasonList items={d.reasons.bull} /></div>}
            {d.reasons.bear.length > 0 && <div><h3 className="u9-subhead">Bear 要因</h3><ReasonList items={d.reasons.bear} /></div>}
          </div>
        </Card>
      )}

      {hasConstraints && (
        <Card title="制約・注意" data-testid="stock-constraints">
          {d.constraints.map(c => (
            <div key={c.id} className="u9-inline-note" data-tone="warm" data-constraint={c.id}>
              <div><strong>{c.title}</strong> — {c.text}</div>
            </div>
          ))}
          {d.lockNote !== null && (
            <div className="u9-inline-note" data-tone="warm" data-testid="stock-sell-lock">
              <div><strong>{d.lockNote.title}</strong><br />{d.lockNote.text}</div>
            </div>
          )}
          {d.lockReleasedNote !== null && <div className="u9-inline-note" data-testid="stock-lock-released">{d.lockReleasedNote}</div>}
          {d.stopLossNote !== null && (
            <div className="u9-inline-note" data-tone="warm" data-testid="stock-stop-loss-warning">
              <div><strong>{d.stopLossNote.title}</strong><br />{d.stopLossNote.text}</div>
            </div>
          )}
        </Card>
      )}

      <Card title="保有状況" data-testid="stock-position">
        <Defs rows={d.position} />
      </Card>

      <Card title="実行条件" data-testid="stock-execution">
        <div className="u9-stk-plan">
          <div><div className="u9-stk-plan__k">目標株価</div><div className="u9-stk-plan__v">{d.executionPlan.targetPriceLabel}</div>{d.executionPlan.targetSub !== null && <div className="u9-note">{d.executionPlan.targetSub}</div>}</div>
          <div><div className="u9-stk-plan__k">損切ライン（アラート）</div><div className="u9-stk-plan__v">{d.executionPlan.alertPriceLabel}</div>{d.executionPlan.alertSub !== null && <div className="u9-note">{d.executionPlan.alertSub}</div>}</div>
          <div>
            <div className="u9-stk-plan__k">リスクゲート</div>
            <div className="u9-stk-plan__v">{d.riskGate === null ? '利用不可' : d.riskGate.pass ? '✓ 通過' : '✗ 非通過'}</div>
            <div className="u9-note">{d.riskGate === null ? '分析結果がないため判定できません' : d.riskGate.sub}</div>
          </div>
        </div>
        {hasExecList && (
          <div className="u9-stk-execlists">
            {d.reasons.entry.length > 0 && <div><h3 className="u9-subhead">エントリー条件（今買う理由）</h3><ReasonList items={d.reasons.entry} /></div>}
            {d.reasons.takeProfit.length > 0 && <div><h3 className="u9-subhead">利確条件</h3><ReasonList items={d.reasons.takeProfit} /></div>}
            {d.reasons.stopLoss.length > 0 && <div><h3 className="u9-subhead">損切条件</h3><ReasonList items={d.reasons.stopLoss} /></div>}
            {d.reasons.wait.length > 0 && <div><h3 className="u9-subhead">継続保有理由 / 待機理由</h3><ReasonList items={d.reasons.wait} /></div>}
          </div>
        )}
        <p className="u9-note">参照用表示です。注文・実行機能はありません（UI only / not an order）。売買・登録はご自身の証券口座で手動で行ってください。</p>
      </Card>

      <Card title="ポートフォリオ上の位置づけ" data-testid="stock-portfolio-standing">
        <div className="u9-subhead">理想PFでの役割</div>
        <p className="u9-stk-comment">{d.portfolioRole.headline}</p>
        <p className="u9-note">{d.portfolioRole.sectorLine}</p>
        {d.portfolioRole.concentration !== null && <p className="u9-note">{d.portfolioRole.concentration}</p>}
        <div className="u9-subhead">現在PFでの位置づけ</div>
        <p className="u9-stk-comment">{d.portfolioStanding.summary}</p>
        <p className="u9-note">{d.portfolioStanding.text}</p>
      </Card>

      {d.candidate !== null && (
        <Card title="候補との関係" data-testid="stock-candidate-link">
          <ul className="u9-cand-list"><CandidateRow row={d.candidate} /></ul>
        </Card>
      )}

      <Card title="根拠と鮮度" data-testid="stock-evidence">
        <Defs rows={d.evidence} />
        {d.holdingsStale && (
          <Notice id="holdings_stale" tone="warm">保有データが古い可能性があります。CSV再取込または保有株・投信の同期（手動）を確認してください。</Notice>
        )}
      </Card>

      <SupportingAnalysis d={d} />
    </StocksFrame>
  )
}
