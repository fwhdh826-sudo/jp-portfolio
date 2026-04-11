import { useState, useEffect, useMemo } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectBuyList, selectSellList, selectHoldList, selectTotalEval } from '../../store/selectors'
import { formatJPYAuto } from '../../utils/format'
import type { HoldingAnalysis } from '../../types'
import { checkNoTrade } from '../../domain/optimization/idealAllocation'
import { buildZeroBasePlan } from '../../domain/optimization/zeroBase'
import type { ConclusionBoard } from '../../domain/optimization/zeroBase'
import type { AssetCategorySummary } from '../../types/universe'

// ── Portfolio Health Score ───────────────────────────────────
function calcHealth(analysis: HoldingAnalysis[]) {
  if (analysis.length === 0) return { score: 0, ret: 0, risk: 0, exec: 0, div: 0 }
  const avgScore  = analysis.reduce((s, a) => s + a.totalScore, 0) / analysis.length
  const sellRatio = analysis.filter(a => a.decision === 'SELL').length / analysis.length
  const buyRatio  = analysis.filter(a => a.decision === 'BUY').length  / analysis.length
  const ret  = Math.round(avgScore * 0.4)
  const risk = Math.round((1 - sellRatio) * 30)
  const exec = Math.round(buyRatio * 20)
  const div  = Math.round(Math.min(analysis.length / 15, 1) * 10)
  return { score: Math.min(100, ret + risk + exec + div), ret, risk, exec, div }
}

function healthStatus(score: number): { label: string; color: string } {
  if (score >= 80) return { label: '◎ 優良 — 維持推奨',            color: 'var(--g)' }
  if (score >= 60) return { label: '○ 良好 — 微調整余地あり',       color: 'var(--a)' }
  if (score >= 40) return { label: '⚠ 問題あり — 即アクション必要', color: 'var(--a)' }
  return             { label: '✗ 要緊急対応',                       color: 'var(--r)' }
}

// ── DecisionCard（スコアバー廃止・理由強化）───────────────────
function DecisionCard({ code, totalScore, ev, decision, confidence, debate, fundamentalScore, technicalScore, marketScore, newsScore }: HoldingAnalysis) {
  const [open, setOpen] = useState(false)
  const holding = useAppStore(s => s.holdings.find(h => h.code === code))
  if (!holding) return null

  const borderColor = decision === 'BUY'  ? 'var(--g)'
                    : decision === 'SELL' ? 'var(--r)' : 'var(--c)'
  const bgColor     = decision === 'BUY'  ? 'rgba(45,212,160,.06)'
                    : decision === 'SELL' ? 'rgba(232,64,90,.06)' : 'rgba(104,150,200,.06)'
  const verdictClass = decision === 'BUY' ? 'buy' : decision === 'SELL' ? 'sell' : 'hold'

  // 全AIの強気・弱気ポイントを統合
  const allBull = debate.agents.flatMap(a => a.bullPoints)
  const allBear = debate.agents.flatMap(a => a.bearPoints)
  const topBull = allBull.slice(0, 3)
  const topBear = allBear.slice(0, 2)

  // スコア内訳（数値で表示、バーなし）
  const scoreBreakdown = [
    { label: 'ファンダ', val: fundamentalScore, max: 30 },
    { label: 'テクニカル', val: technicalScore,  max: 20 },
    { label: 'マクロ',   val: marketScore,      max: 20 },
    { label: 'ニュース', val: newsScore,         max: 15 },
  ]

  return (
    <div style={{
      background: bgColor,
      border: `1px solid ${borderColor}44`,
      borderLeft: `3px solid ${borderColor}`,
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 8,
    }}>
      {/* ── ヘッダー行 ── */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', cursor: 'pointer' }}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', flexShrink: 0 }}>{code}</span>
        <span style={{ color: 'var(--w)', fontWeight: 700, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {holding.name}
        </span>
        <span className={`vd ${verdictClass}`}>{decision}</span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: borderColor,
          background: `${borderColor}22`, border: `1px solid ${borderColor}55`,
          borderRadius: 12, padding: '2px 8px', flexShrink: 0,
        }}>
          {totalScore}/100
        </span>
        <span style={{ color: 'var(--d)', fontSize: 12, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </div>

      {/* ── KPI 4列（数値のみ、バーなし）── */}
      <div className="kpi-row" style={{ marginBottom: 10 }}>
        <div className="kpi">
          <div className="l">EV</div>
          <div className="v" style={{ color: ev >= 0 ? 'var(--g)' : 'var(--r)', fontSize: 14 }}>
            {ev >= 0 ? '+' : ''}{(ev * 100).toFixed(1)}%
          </div>
        </div>
        <div className="kpi">
          <div className="l">確信度</div>
          <div className="v wh" style={{ fontSize: 14 }}>{(confidence * 100).toFixed(0)}%</div>
        </div>
        <div className="kpi">
          <div className="l">σ (年率)</div>
          <div className="v wh" style={{ fontSize: 14 }}>
            {(holding.sigma * 100).toFixed(1)}%
            <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)', marginLeft: 3 }}>
              {holding.sigmaSource === 'yfinance' ? '実測' : '推定'}
            </span>
          </div>
        </div>
        <div className="kpi">
          <div className="l">現在評価額</div>
          <div className="v wh" style={{ fontSize: 12 }}>{formatJPYAuto(holding.eval)}</div>
        </div>
      </div>

      {/* ── 判断理由（AI討論から抽出）── */}
      <div style={{ fontSize: 12, lineHeight: 1.7, marginBottom: topBull.length + topBear.length > 0 ? 10 : 0 }}>
        {topBull.length > 0 && (
          <div style={{ marginBottom: 4 }}>
            {topBull.map((p, i) => (
              <div key={`b${i}`} style={{ color: 'var(--g)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span style={{ flexShrink: 0, marginTop: 1 }}>▲</span>
                <span>{p}</span>
              </div>
            ))}
          </div>
        )}
        {topBear.length > 0 && (
          <div>
            {topBear.map((p, i) => (
              <div key={`r${i}`} style={{ color: 'var(--r)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span style={{ flexShrink: 0, marginTop: 1 }}>▼</span>
                <span>{p}</span>
              </div>
            ))}
          </div>
        )}
        {topBull.length === 0 && topBear.length === 0 && (
          <div style={{ color: 'var(--d)', fontSize: 11 }}>AIスコア: {debate.debateScore}/100 — 分析データ蓄積中</div>
        )}
      </div>

      {/* ── 展開時: スコア内訳 + 全AIコメント ── */}
      {open && (
        <div style={{ borderTop: '1px solid var(--b1)', paddingTop: 10, marginTop: 6 }}>
          {/* スコア内訳（数値グリッド） */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {scoreBreakdown.map(s => (
              <div key={s.label} style={{
                flex: '1 1 80px', background: 'rgba(0,0,0,.25)', borderRadius: 6,
                padding: '6px 10px', textAlign: 'center',
                border: '1px solid var(--b1)',
              }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)', marginBottom: 3 }}>{s.label}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 16, color: s.val / s.max >= 0.65 ? 'var(--g)' : s.val / s.max >= 0.4 ? 'var(--a)' : 'var(--r)' }}>
                  {s.val}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)' }}>/{s.max}</div>
              </div>
            ))}
          </div>

          {/* 7AI討論：全エージェント */}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 6 }}>
            7AI討論（debate score: {debate.debateScore}/100）
          </div>
          {debate.agents.map((agent, i) => (
            <div key={i} style={{
              background: 'rgba(0,0,0,.2)', borderRadius: 6,
              padding: '7px 10px', marginBottom: 5,
              border: '1px solid var(--b2)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--c)', fontWeight: 700 }}>
                  {agent.agent}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>
                  {agent.style}
                </span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 11,
                  color: agent.score >= 70 ? 'var(--g)' : agent.score >= 50 ? 'var(--a)' : 'var(--r)',
                }}>
                  {agent.score}/100
                </span>
              </div>
              {agent.bullPoints.slice(0, 2).map((p, j) => (
                <div key={`ab${j}`} style={{ fontSize: 10, color: 'var(--g)', marginBottom: 2 }}>▲ {p}</div>
              ))}
              {agent.bearPoints.slice(0, 1).map((p, j) => (
                <div key={`ar${j}`} style={{ fontSize: 10, color: 'var(--r)', marginBottom: 2 }}>▼ {p}</div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── ActionItem ────────────────────────────────────────────────
interface ActionItem {
  id:     string
  code?:  string
  name?:  string
  text:   string
  why:    string        // なぜやるか（高校生向け）
  how:    string        // どうやるか（具体的手順）
  tag:    'urgent' | 'normal' | 'buy'
}

function loadActions(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem('v90_actions') || '{}') as Record<string, boolean> }
  catch { return {} }
}
function saveActions(s: Record<string, boolean>) {
  localStorage.setItem('v90_actions', JSON.stringify(s))
}

// ── Final Conclusion（v9.1 最上部）────────────────────────────
function FinalConclusionPanel({ board }: { board: ConclusionBoard }) {
  const modeColor =
    board.marketMode === 'emergency'
      ? 'var(--r)'
      : board.marketMode === 'caution'
      ? 'var(--a)'
      : 'var(--g)'

  return (
    <div
      style={{
        background:
          board.marketMode === 'emergency'
            ? 'rgba(232,64,90,.08)'
            : board.marketMode === 'caution'
            ? 'rgba(212,160,23,.07)'
            : 'rgba(45,212,160,.07)',
        border: `1px solid ${modeColor}55`,
        borderLeft: `4px solid ${modeColor}`,
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--head)', fontSize: 9, color: 'var(--d)', letterSpacing: '.12em' }}>
          FINAL CONCLUSION
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: modeColor,
            background: `${modeColor}22`,
            border: `1px solid ${modeColor}55`,
            borderRadius: 8,
            padding: '2px 8px',
          }}
        >
          {board.modeLabel}
        </span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--w)', lineHeight: 1.7, marginBottom: 8 }}>{board.conclusion}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>
            今日のToDo
          </div>
          {board.todo.slice(0, 4).map((item, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--w)', marginBottom: 3, lineHeight: 1.45 }}>
              • {item}
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>
            リスク警告
          </div>
          {board.riskAlerts.slice(0, 4).map((item, i) => (
            <div key={i} style={{ fontSize: 11, color: modeColor, marginBottom: 3, lineHeight: 1.45 }}>
              {board.marketMode === 'emergency' ? '🚨' : '⚠'} {item}
            </div>
          ))}
        </div>
      </div>

      {board.highConviction.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--b1)', paddingTop: 8 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginBottom: 4 }}>
            高確信候補
          </div>
          {board.highConviction.map(p => (
            <div key={p.id} style={{ fontSize: 11, color: 'var(--g)', marginBottom: 2, lineHeight: 1.45 }}>
              • {p.name} ({p.code}) {formatJPYAuto(p.amount)} / 確信度 {(p.confidence * 100).toFixed(0)}%
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── MarketModePanel（市場モード + ノートレード判定）────────────
function MarketModePanel() {
  const market = useAppStore(s => s.market)
  const macro  = useAppStore(s => s.macro)
  const sqCal  = useAppStore(s => s.sqCalendar)
  const state  = useAppStore(s => s)
  const noTrade = checkNoTrade(state)

  const regimeColor = market.regime === 'bull' ? 'var(--g)'
                    : market.regime === 'bear' ? 'var(--r)' : 'var(--a)'
  const regimeLabel = market.regime === 'bull' ? '強気（ブル）' : market.regime === 'bear' ? '弱気（ベア）' : '中立'
  const modeColor   = noTrade.mode === 'emergency' ? 'var(--r)'
                    : noTrade.mode === 'caution'   ? 'var(--a)' : 'var(--g)'
  const modeLabel   = noTrade.mode === 'emergency' ? '🚨 緊急停止' : noTrade.mode === 'caution' ? '⚠ 注意モード' : '✓ 通常モード'

  return (
    <div style={{
      background: noTrade.mode === 'emergency' ? 'rgba(232,64,90,.06)' : noTrade.mode === 'caution' ? 'rgba(212,160,23,.04)' : 'rgba(45,212,160,.04)',
      border: `1px solid ${modeColor}44`,
      borderLeft: `4px solid ${modeColor}`,
      borderRadius: 10, padding: '12px 14px', marginBottom: 10,
    }}>
      {/* ── 市場レジーム行 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontFamily: 'var(--head)', fontSize: 8, color: 'var(--d)', letterSpacing: '.15em' }}>
          市場モード
        </div>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: regimeColor,
          background: `${regimeColor}18`, border: `1px solid ${regimeColor}44`,
          borderRadius: 8, padding: '2px 10px',
        }}>
          {regimeLabel}
        </span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 11, color: modeColor,
          background: `${modeColor}18`, border: `1px solid ${modeColor}44`,
          borderRadius: 8, padding: '2px 10px',
        }}>
          {modeLabel}
        </span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)' }}>
          VIX {market.vix.toFixed(1)}{macro ? `　日経VI ${macro.nikkeiVI.toFixed(1)}` : ''}
        </span>
      </div>

      {/* ── SQ情報 ── */}
      {sqCal?.nextSQ && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--d)', marginBottom: noTrade.reasons.length > 0 ? 8 : 0 }}>
          次回SQ: {sqCal.nextSQ.date}
          <span style={{
            marginLeft: 8,
            color: sqCal.nextSQ.dayUntil <= 3 ? 'var(--r)' : sqCal.nextSQ.dayUntil <= 7 ? 'var(--a)' : 'var(--d)',
          }}>
            {sqCal.nextSQ.dayUntil <= 3 ? `⚠ 残${sqCal.nextSQ.dayUntil}営業日` : `あと${sqCal.nextSQ.dayUntil}営業日`}
          </span>
          {sqCal.nextSQ.type === 'quarterly' && <span style={{ marginLeft: 6, color: 'var(--a)' }}>⚡ 先物SQ</span>}
        </div>
      )}

      {/* ── 警告理由リスト ── */}
      {noTrade.reasons.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {noTrade.reasons.map((r, i) => (
            <div key={i} style={{
              fontSize: 11, color: noTrade.mode === 'emergency' ? 'var(--r)' : 'var(--a)',
              display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 2,
            }}>
              <span style={{ flexShrink: 0 }}>{noTrade.mode === 'emergency' ? '🚨' : '⚠'}</span>
              <span>{r}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── IdealPfPanel（理想PF差分テーブル）────────────────────────
function IdealPfPanel() {
  const universe = useAppStore(s => s.universe)
  const market   = useAppStore(s => s.market)
  if (!universe) return null

  const regimeLabel = market.regime === 'bull' ? '強気' : market.regime === 'bear' ? '弱気' : '中立'

  const diffColor = (diff: number) =>
    Math.abs(diff) < 0.02 ? 'var(--g)'
    : Math.abs(diff) < 0.05 ? 'var(--a)' : 'var(--r)'

  const actionLabel = (diff: number): string => {
    if (Math.abs(diff) < 500_000) return '—'
    return diff > 0 ? `▲ 買い増し ${formatJPYAuto(diff)}` : `▼ 削減 ${formatJPYAuto(-diff)}`
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="card-title" style={{ marginBottom: 8 }}>
        📊 理想PF差分
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginLeft: 8 }}>
          {regimeLabel}レジーム基準 / 総資産 {formatJPYAuto(universe.totalValue)}
        </span>
      </div>

      {/* テーブルヘッダー */}
      <div style={{
        display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 2fr',
        gap: 4, marginBottom: 6,
        fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)',
        borderBottom: '1px solid var(--b1)', paddingBottom: 4,
      }}>
        <div>資産クラス</div>
        <div style={{ textAlign: 'right' }}>現在</div>
        <div style={{ textAlign: 'right' }}>目標</div>
        <div style={{ textAlign: 'right' }}>アクション</div>
      </div>

      {/* テーブル行 */}
      {universe.categories.map((cat: AssetCategorySummary) => {
        const diffR = cat.diffRatio
        const col = diffColor(diffR)
        return (
          <div key={cat.class} style={{
            display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 2fr',
            gap: 4, padding: '5px 0',
            borderBottom: '1px solid var(--b2)',
            alignItems: 'center',
          }}>
            <div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--w)' }}>{cat.label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)' }}>{cat.role}</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10 }}>
              <div style={{ color: 'var(--w)' }}>{(cat.currentRatio * 100).toFixed(1)}%</div>
              <div style={{ color: 'var(--d)', fontSize: 8 }}>{formatJPYAuto(cat.currentValue)}</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 10 }}>
              <div style={{ color: col }}>{(cat.targetRatio * 100).toFixed(1)}%</div>
              <div style={{ color: 'var(--d)', fontSize: 8 }}>{formatJPYAuto(cat.targetValue)}</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 9, color: col }}>
              {actionLabel(cat.diffValue)}
            </div>
          </div>
        )
      })}

      {/* 追加投資枠 表示 */}
      {universe.addRoom > 0 && (
        <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--c)' }}>
          追加投資枠: {formatJPYAuto(universe.addRoom)} 利用可能
        </div>
      )}
    </div>
  )
}

// ── T1_Decision ───────────────────────────────────────────────
export function T1_Decision() {
  const buyList   = useAppStore(selectBuyList)
  const sellList  = useAppStore(selectSellList)
  const holdList  = useAppStore(selectHoldList)
  const analysis  = useAppStore(s => s.analysis)
  const metrics   = useAppStore(s => s.metrics)
  const holdings  = useAppStore(s => s.holdings)
  const trust     = useAppStore(s => s.trust)
  const macro     = useAppStore(s => s.macro)
  const sqCalendar = useAppStore(s => s.sqCalendar)
  const universe  = useAppStore(s => s.universe)
  const cash      = useAppStore(s => s.cash)
  const cashReserve = useAppStore(s => s.cashReserve)
  const addRoom   = useAppStore(s => s.addRoom)
  const importCsv = useAppStore(s => s.importCsv)
  const system    = useAppStore(s => s.system)
  const market    = useAppStore(s => s.market)
  const totalEval = useAppStore(selectTotalEval)

  const zeroPlan = useMemo(
    () =>
      buildZeroBasePlan({
        holdings,
        trust,
        analysis,
        market,
        macro,
        sqCalendar,
        metrics,
        universe,
        cash,
        cashReserve,
        addRoom,
      }),
    [
      holdings,
      trust,
      analysis,
      market,
      macro,
      sqCalendar,
      metrics,
      universe,
      cash,
      cashReserve,
      addRoom,
    ],
  )

  const health = calcHealth(analysis)
  const hs     = healthStatus(health.score)

  const [actionDone, setActionDone] = useState<Record<string, boolean>>(loadActions)
  useEffect(() => { saveActions(actionDone) }, [actionDone])
  const toggleAction = (id: string) => setActionDone(prev => ({ ...prev, [id]: !prev[id] }))

  const mitsuW = holdings.filter(h => h.mitsu).reduce((s, h) => s + h.eval, 0) / Math.max(totalEval, 1) * 100

  // TODAY'S ACTIONS — 名前・理由・手順を完全明示
  const actions: ActionItem[] = [
    ...sellList.slice(0, 3).map(a => {
      const h = holdings.find(x => x.code === a.code)
      return {
        id:   `sell_${a.code}`,
        code: a.code,
        name: h?.name ?? a.code,
        text: `【SELL】${h?.name ?? a.code} を売却する`,
        why:  `スコア ${a.totalScore}/100（基準75未満）・期待値 ${(a.ev * 100).toFixed(1)}%がマイナス。保有し続けると損失が拡大するリスクが高い。`,
        how:  `SBI証券アプリ → 保有株一覧 → ${h?.name ?? a.code}(${a.code}) → 売却注文 → 指値 or 成行`,
        tag:  'urgent' as const,
      }
    }),
    ...buyList.slice(0, 2).map(a => {
      const h = holdings.find(x => x.code === a.code)
      return {
        id:   `buy_${a.code}`,
        code: a.code,
        name: h?.name ?? a.code,
        text: `【BUY】${h?.name ?? a.code} を買い増し検討`,
        why:  `スコア ${a.totalScore}/100・期待値 ${(a.ev * 100).toFixed(1)}%がプラス。追加投資枠を活用できる優良候補。`,
        how:  `現在の評価額・株数を確認し、追加投資枠4,000,000円内で判断。分割（30/30/40）での買い増しを推奨。`,
        tag:  'buy' as const,
      }
    }),
    {
      id:   'csv_update',
      text: '最新CSVを取込んで評価額を更新',
      why:  'データが古いと判断精度が下がる。SBI証券から最新の保有状況CSVをDLして反映させることでスコアが正確になる。',
      how:  'SBI証券 → 口座管理 → 保有証券 → CSV出力 → このページにD&D（またはタップして選択）',
      tag:  'normal',
    },
  ]

  // デプロイ条件
  const cond = [
    { label: 'SELL銘柄ゼロ',   met: sellList.length === 0,
      note: `現在 ${sellList.length}件のSELL銘柄あり` },
    { label: 'Sharpe ≥1.0',    met: (metrics?.sharpe ?? 0) >= 1.0,
      note: `現在 ${metrics?.sharpe.toFixed(2) ?? '─'}` },
    { label: '三菱集中 ≤35%',  met: mitsuW <= 35,
      note: `現在 ${mitsuW.toFixed(1)}%` },
    { label: 'σ ≤25%',         met: (metrics?.sigma ?? 1) <= 0.25,
      note: `現在 ${metrics ? (metrics.sigma * 100).toFixed(1) : '─'}%` },
    { label: 'VIX ≤20',        met: market.vix <= 20,
      note: `現在 ${market.vix}` },
  ]
  const allMet  = cond.every(c => c.met)
  const metCount = cond.filter(c => c.met).length

  const handleDrop       = (e: React.DragEvent)        => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void importCsv(f) }
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) void importCsv(f) }

  return (
    <div className="tab-panel">

      {/* ── 結論 / ToDo / リスク ── */}
      <FinalConclusionPanel board={zeroPlan.board} />

      {/* ── 市場モード + ノートレード判定 ── */}
      <MarketModePanel />

      {/* ── 理想PF差分 ── */}
      <IdealPfPanel />

      {/* ── Portfolio Health Score ── */}
      <div style={{
        background: 'linear-gradient(135deg,#0a1a10,#060e08)',
        border: '2px solid var(--g3)', borderRadius: 12,
        padding: '14px 16px 12px', marginBottom: 10,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
          <div>
            <div style={{ fontFamily: 'var(--head)', fontSize: 8, color: 'var(--g)', letterSpacing: '.18em', marginBottom: 3 }}>
              PORTFOLIO HEALTH SCORE
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 50, color: 'var(--g)', textShadow: '0 0 20px rgba(45,212,160,.3)', lineHeight: 1, fontWeight: 700 }}>
              {health.score}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: hs.color, marginTop: 3 }}>{hs.label}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>総評価額</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--w)', marginTop: 2 }}>
              {formatJPYAuto(totalEval)}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginTop: 8 }}>保有銘柄数</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 18, color: 'var(--d)' }}>{analysis.length}</div>
          </div>
        </div>
        {/* Health 内訳（数値のみ、スコアバーなし） */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {[
            { label: 'リターン質', val: health.ret,  max: 40, col: 'var(--g)' },
            { label: 'リスク管理', val: health.risk, max: 30, col: 'var(--a)' },
            { label: '執行精度',  val: health.exec, max: 20, col: 'var(--c)' },
            { label: '分散度',    val: health.div,  max: 10, col: 'var(--g2)' },
          ].map(b => (
            <div key={b.label} style={{
              flex: '1 1 70px', background: 'rgba(0,0,0,.3)', borderRadius: 6,
              padding: '5px 8px', textAlign: 'center', border: '1px solid var(--b1)',
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)', marginBottom: 2 }}>{b.label}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 18, color: b.col }}>{b.val}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--d)' }}>/{b.max}pt</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── EV Engine ── */}
      {metrics && (
        <div className="ev-box" style={{ marginBottom: 10 }}>
          <div>
            <div className="ev-label">PORTFOLIO EV ENGINE <span className="badge live">LIVE</span></div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', marginTop: 3, lineHeight: 1.7 }}>
              σ={`${(metrics.sigma * 100).toFixed(1)}%`}　Sharpe={metrics.sharpe.toFixed(2)}　Sortino={metrics.sortino.toFixed(2)}　Calmar={metrics.calmar.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="ev-label">CVaR 95%</div>
            <div className={`ev-val${metrics.cvar < 0 ? ' neg' : ''}`}>
              {metrics.cvar < 0 ? '' : '+'}{(metrics.cvar * 100).toFixed(1)}%
            </div>
          </div>
        </div>
      )}

      {/* ── TODAY'S ACTIONS（理由・手順付き）── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title" style={{ marginBottom: 10 }}>
          ⚡ TODAY'S ACTIONS
          <span className="badge ai" style={{ marginLeft: 8 }}>AI自動生成</span>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9, marginLeft: 8,
            color: 'var(--d)',
          }}>
            {actions.filter(a => !!actionDone[a.id]).length}/{actions.length} 完了
          </span>
        </div>
        {actions.map(action => {
          const done = !!actionDone[action.id]
          const tagBg    = action.tag === 'urgent' ? 'rgba(232,64,90,.18)'
                         : action.tag === 'buy'    ? 'rgba(45,212,160,.18)' : 'rgba(104,150,200,.15)'
          const tagColor = action.tag === 'urgent' ? 'var(--r)'
                         : action.tag === 'buy'    ? 'var(--g)'             : 'var(--c)'
          const tagLabel = action.tag === 'urgent' ? '🔴 即実行' : action.tag === 'buy' ? '🟢 検討' : '⚪ 通常'
          return (
            <div
              key={action.id}
              style={{
                borderBottom: '1px solid var(--b1)',
                paddingBottom: 10, marginBottom: 10,
                opacity: done ? 0.45 : 1,
              }}
            >
              {/* 行ヘッダー（タップでチェック）*/}
              <div
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}
                onClick={() => toggleAction(action.id)}
              >
                {/* チェックボタン */}
                <div style={{
                  width: 24, height: 24, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                  border: `2px solid ${done ? 'var(--g)' : 'var(--b1)'}`,
                  background: done ? 'var(--g3)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--g)',
                }}>
                  {done ? '✓' : ''}
                </div>
                {/* タイトル + タグ */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 12,
                    color: done ? 'var(--d)' : 'var(--w)',
                    textDecoration: done ? 'line-through' : 'none',
                    marginBottom: 2, lineHeight: 1.5,
                  }}>
                    {action.text}
                  </div>
                </div>
                <span style={{
                  flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 9,
                  padding: '3px 8px', borderRadius: 10,
                  background: tagBg, color: tagColor,
                }}>
                  {tagLabel}
                </span>
              </div>
              {/* なぜ・どうやる（常時表示）*/}
              {!done && (
                <div style={{ marginLeft: 34, marginTop: 6 }}>
                  <div style={{
                    fontSize: 11, color: 'var(--c)', lineHeight: 1.6,
                    background: 'rgba(104,150,200,.06)', borderRadius: 6,
                    padding: '6px 10px', marginBottom: 5,
                    border: '1px solid rgba(104,150,200,.15)',
                  }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', display: 'block', marginBottom: 2 }}>📌 なぜ？</span>
                    {action.why}
                  </div>
                  <div style={{
                    fontSize: 11, color: 'var(--a)', lineHeight: 1.6,
                    background: 'rgba(212,160,23,.06)', borderRadius: 6,
                    padding: '6px 10px',
                    border: '1px solid rgba(212,160,23,.15)',
                  }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)', display: 'block', marginBottom: 2 }}>🔧 どうやる？</span>
                    {action.how}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── デプロイ条件チェッカー ── */}
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>
          🚀 追加投資デプロイ条件
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10,
            color: allMet ? 'var(--g)' : 'var(--r)',
            background: allMet ? 'rgba(45,212,160,.15)' : 'rgba(232,64,90,.15)',
            border: `1px solid ${allMet ? 'var(--g2)' : 'var(--r2)'}`,
            borderRadius: 10, padding: '2px 8px', marginLeft: 8,
          }}>
            {allMet ? '✓ 全条件クリア — 投資実行可' : `${metCount}/${cond.length} 達成`}
          </span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--d)', fontFamily: 'var(--mono)', marginBottom: 8 }}>
          追加枠 4,000,000円 のデプロイ判断基準。全条件を満たしたら買い増し実行可。
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {cond.map(c => (
            <div key={c.label} style={{
              flex: '1 1 44%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', borderRadius: 8,
              background: c.met ? 'rgba(45,212,160,.06)' : 'rgba(232,64,90,.06)',
              border: `1px solid ${c.met ? 'var(--g3)' : 'rgba(232,64,90,.3)'}`,
            }}>
              <span style={{ fontSize: 13, flexShrink: 0 }}>{c.met ? '✅' : '❌'}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: c.met ? 'var(--w)' : 'var(--d)' }}>
                  {c.label}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--d)' }}>{c.note}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── CSV D&D ── */}
      <div
        className="csv-drop"
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        style={{ marginBottom: 14 }}
      >
        <input type="file" accept=".csv" onChange={handleFileChange} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--d)' }}>
          📁 SBI証券CSVをドロップ or タップして選択
        </div>
        {system.csvLastImportedAt && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--g)', marginTop: 5 }}>
            最終取込: {system.csvLastImportedAt.slice(0, 16).replace('T', ' ')}
          </div>
        )}
      </div>

      {/* ── BUY ── */}
      {buyList.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ color: 'var(--g)', marginBottom: 8 }}>
            ▲ BUY（買い推奨）— {buyList.length}銘柄
          </div>
          {buyList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {/* ── HOLD ── */}
      {holdList.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ color: 'var(--c)', marginBottom: 8 }}>
            ● HOLD（現状維持）— {holdList.length}銘柄
          </div>
          {holdList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {/* ── SELL ── */}
      {sellList.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ color: 'var(--r)', marginBottom: 8 }}>
            ▼ SELL（売却推奨）— {sellList.length}銘柄
          </div>
          {sellList.map(a => <DecisionCard key={a.code} {...a} />)}
        </section>
      )}

      {buyList.length === 0 && sellList.length === 0 && holdList.length === 0 && (
        <div style={{ color: 'var(--d)', textAlign: 'center', padding: 48, fontFamily: 'var(--mono)' }}>
          分析データを読み込み中...
        </div>
      )}

      {system.error && (
        <div className="card r-glow" style={{ marginBottom: 10 }}>
          <span style={{ color: 'var(--r)', fontFamily: 'var(--mono)', fontSize: 12 }}>✗ {system.error}</span>
        </div>
      )}
    </div>
  )
}
