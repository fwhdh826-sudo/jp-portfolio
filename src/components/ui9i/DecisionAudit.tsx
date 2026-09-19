// UI-9I Phase 1: Decision Audit shell（判断の詳細）。既存 T1（個別株）とは別の detail surface。
// 純表示: DecisionAuditViewModel のみを描画する。第二のダッシュボードにしない。
import type { DecisionAuditViewModel } from '../../presentation/ui9i/decisionAudit'
import { formatYen } from '../../presentation/ui9i/formatters'
import { UNAVAILABLE_LABEL } from '../../presentation/ui9i/labels'
import { gapText } from './PortfolioParts'
import { Card, LinkRow } from './primitives'

export interface DecisionAuditActions {
  onBack: () => void
  onOpenCommittee: () => void
  onOpenStocks: () => void
  onOpenPortfolio: () => void
}

function Defs({ rows }: { rows: readonly { id: string; label: string; value: string }[] }) {
  return (
    <dl className="u9-defs">
      {rows.map(r => (
        <div key={r.id} className="u9-defs__row"><dt>{r.label}</dt><dd>{r.value}</dd></div>
      ))}
    </dl>
  )
}

export function DecisionAuditView({ vm, actions }: { vm: DecisionAuditViewModel; actions: DecisionAuditActions }) {
  const { recap, safeMode, rationale, constraints, candidateState, portfolioGaps, evidence } = vm
  const tone = recap.state === 'safe_mode' ? 'warm' : recap.state === 'data_wait' ? 'neutral' : recap.state === 'decision_unavailable' ? 'critical' : 'calm'
  return (
    <div className="u9-page u9-surface" data-tone={tone} data-testid="decision-audit" data-audit-state={recap.state}>
      <div className="u9-surface__head">
        <button type="button" className="u9-surface__back" onClick={actions.onBack} aria-label="今日に戻る">‹</button>
        <h1 className="u9-surface__title">判断の詳細</h1>
      </div>
      <div className="u9-surface__body">
        {/* 1. Decision Recap */}
        <Card first data-testid="audit-recap" aria-label="判断の要約">
          <div className="u9-audit-recap">
            <span className="u9-meta">{recap.eyebrow}</span>
            <h2 className="u9-audit-recap__headline">{recap.headline}</h2>
            <span className="u9-meta">
              {recap.generatedAtLabel !== null ? `判断生成 ${recap.generatedAtLabel}` : '判断生成 —'}
              {recap.regimeModeLabel !== null ? ` ｜ ${recap.regimeModeLabel}` : ''}
            </span>
          </div>
        </Card>

        {/* SAFE_MODE 詳細（実効判定と元データを分けて表示） */}
        {safeMode !== null && (
          <>
            <Card title="セーフモードの状態" data-testid="audit-safe-mode">
              <Defs rows={[
                { id: 'effective', label: '実効判定', value: safeMode.effective },
                { id: 'raw', label: '元データの状態', value: safeMode.raw },
                { id: 'freshness', label: '権限の鮮度', value: safeMode.freshness },
                { id: 'tier-a-v', label: 'Tier A 重大違反', value: safeMode.tierAViolations },
                { id: 'tier-a-a', label: 'Tier A アラート', value: safeMode.tierAAlerts },
              ]} />
              <p className="u9-note">SAFE_MODE の実効判定では、SAFE_MODE の権限そのものを確認できない場合に安全側（有効）へ倒します。他のデータセットの利用不可には適用しません。</p>
            </Card>
            <Card title="発動条件"><Defs rows={safeMode.conditions} /></Card>
            <Card title="制限と再開">
              <Defs rows={[...safeMode.restrictions, { id: 'resume', label: '再開見込', value: safeMode.estimatedResume }]} />
            </Card>
          </>
        )}

        {/* 2. Rationale — rationale[] をそのまま提示順で表示（重み・重要度は付与しない） */}
        <Card title="判断の根拠" meta="表示順のみ" data-testid="audit-rationale">
          {rationale.length === 0 ? (
            <p className="u9-note">{recap.state === 'decision_unavailable' ? '判断結果を取得できていないため、根拠を表示できません。' : '提示された根拠はありません。'}</p>
          ) : (
            <ol className="u9-order">
              {rationale.map((text, i) => (
                <li key={i}><span className="u9-order__no">{String(i + 1).padStart(2, '0')}</span><span>{text}</span></li>
              ))}
            </ol>
          )}
        </Card>

        {/* 3. Binding Constraints */}
        <Card title="効いている制約" data-testid="audit-constraints">
          {constraints.locks.length === 0 && constraints.blockedReasons.length === 0 && constraints.warnings.length === 0 ? (
            <p className="u9-note">現在、提示されている制約はありません。</p>
          ) : (
            <dl className="u9-defs">
              {constraints.locks.map(l => (
                <div key={l.code} className="u9-defs__row">
                  <dt>90日ロック中 · {l.code}</dt>
                  <dd>{l.sellableLabel === null ? '売却可能予定日は不明' : `売却可能予定日 ${l.sellableLabel}`}</dd>
                </div>
              ))}
              {constraints.blockedReasons.map((t, i) => (
                <div key={`b-${i}`} className="u9-defs__row"><dt>制約要因</dt><dd>{t}</dd></div>
              ))}
              {constraints.warnings.map((t, i) => (
                <div key={`w-${i}`} className="u9-defs__row"><dt>注意</dt><dd>{t}</dd></div>
              ))}
            </dl>
          )}
        </Card>

        {/* 4. Candidate Execution State */}
        <Card title="候補の実行状態" data-testid="audit-candidates">
          <dl className="u9-defs">
            <div className="u9-defs__row">
              <dt>件数</dt>
              <dd>{candidateState.available ? `${candidateState.executableCount} 実行可能 · ${candidateState.reviewCount} 要レビュー` : '候補評価を利用できません'}</dd>
            </div>
            <div className="u9-defs__row">
              <dt>実行可能現金</dt>
              <dd data-testid="audit-deployable-cash">
                {candidateState.deployableCash.kind === 'available' ? (formatYen(candidateState.deployableCash.amountJpy) ?? UNAVAILABLE_LABEL) : UNAVAILABLE_LABEL}
              </dd>
            </div>
            <div className="u9-defs__row"><dt>実行可能額の提示</dt><dd>{candidateState.amountPresented ? 'あり' : 'なし'}</dd></div>
          </dl>
          <p className="u9-note">金額は権限が提示した場合のみ表示します。UI では計算しません。</p>
        </Card>

        {/* 5. Portfolio Impact — 目標水準ではないクラスのみ（canonical 順・方向は adapter） */}
        <Card title="配分への影響" data-testid="audit-portfolio">
          {portfolioGaps.length === 0 ? (
            <p className="u9-note">目標との差として提示されているクラスはありません。</p>
          ) : (
            <dl className="u9-defs">
              {portfolioGaps.map(r => (
                <div key={r.assetClass} className="u9-defs__row"><dt>{r.label}</dt><dd>{gapText(r)}</dd></div>
              ))}
            </dl>
          )}
        </Card>

        {/* 6. Evidence / Freshness / Provenance — データセット別の絶対時刻。全体の「正常」にまとめない */}
        <Card title="エビデンスと出所" data-testid="audit-evidence">
          <Defs rows={evidence} />
          <p className="u9-note">鮮度はデータセットごとに扱います。ひとつの遅延から全体の無効は推定しません。</p>
        </Card>

        {/* 7. Deep Links */}
        <Card data-testid="audit-links">
          <LinkRow label="AI委員会の議論を見る" onClick={actions.onOpenCommittee} plain />
          <LinkRow label="個別株の判断を見る" onClick={actions.onOpenStocks} />
          <LinkRow label="ポートフォリオを見る" onClick={actions.onOpenPortfolio} />
        </Card>
      </div>
    </div>
  )
}
