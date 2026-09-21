/**
 * T1_Decision — 個別株（UI-9I Phase 2B-1: R4.1 視覚言語へ移行済み）
 * 資産クラス: jp_stock のみ
 * 構成: 銘柄一覧 → 銘柄詳細（タップで遷移）。業務責務は移行前と同一。
 *
 * このファイルは store → view-model → 純表示 view をつなぐ container のみを持つ。
 * 判断・売却ロック・候補の権限読み取りは presentation/ui9i/stocksPresentation に集約し、
 * React 側で意味を再導出しない（旧 T1 の判断 / 順序 / 候補 authority は移設であり再実装ではない）。
 * 選択中の銘柄は表示専用ストア（useStockSelection）が持つ。この画面を離れると一覧へ戻る。
 */
import { useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { useStockSelection } from '../../store/stockSelection'
import { selectStockDetailViewModel, selectStocksListViewModel } from '../../presentation/ui9i/stocksPresentation'
import { StockDetailView, StocksListView } from '../ui9i/StocksViews'
import { CandidateFunnelPanel } from '../candidates/CandidateFunnelPanel'
import type { DisplayDecision } from '../../domain/analysis/displayDecision'

// 判断ラベルの正典（旧 T1）。R4.1 の画面では STOCK_DECISION_LABEL（判断材料不足 / 更新待ち）を使う。
export function displayDecisionLabel(d: DisplayDecision): string {
  if (d === 'INSUFFICIENT_EVIDENCE')     return '分析データ不足'
  if (d === 'BUY')                       return '買い'
  if (d === 'SELL')                      return '売却'
  if (d === 'WAIT' || d === 'DATA_WAIT') return '待機'
  return '保有継続'
}

export { stockRegimeDisplayLabel, formatStockMetric } from '../../presentation/ui9i/stocksPresentation'

function StocksList() {
  const vm = useAppStore(state => selectStocksListViewModel(state))
  const select = useStockSelection(s => s.select)
  return <StocksListView vm={vm} onSelect={select} funnelSlot={<CandidateFunnelPanel />} />
}

function StockDetail({ code }: { code: string }) {
  const vm = useAppStore(state => selectStockDetailViewModel(state, code))
  const clear = useStockSelection(s => s.clear)
  return <StockDetailView vm={vm} onBack={clear} />
}

export function T1_Decision() {
  const selectedCode = useStockSelection(s => s.selectedCode)
  const clear = useStockSelection(s => s.clear)
  // この画面を離れたら一覧へ戻す（旧 T1 の useState と同じ寿命）。
  useEffect(() => clear, [clear])
  return (
    <div className="u9">
      {selectedCode !== null ? <StockDetail code={selectedCode} /> : <StocksList />}
    </div>
  )
}
