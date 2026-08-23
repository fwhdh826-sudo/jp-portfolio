/**
 * T9_Settings — 設定 / データ更新 / CSV取込 V10 Phase 9
 * CSV取込 · データ更新 · データソース状態 · 永続化状態
 * 表示順: データ更新 → CSV取込 → データソース状態 → 永続化
 */
import { useRef, useState, useCallback, useEffect, type DragEvent, type CSSProperties } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectIsStale, selectCashAuthorityView, selectCashAssumptionsFreshness } from '../../store/selectors'
import { formatDateTime, formatRelativeTime, formatJPYAuto } from '../../utils/format'
import { serializeCashAssumptionsExport, parseCashAssumptionsImport, buildExportableCashAssumptions } from '../../utils/cashAssumptionsTransfer'
import { validateCashAuthorityDraft } from '../../domain/cash/cashAuthority'
import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import { PageHeader } from '../layout/PageHeader'
import type { CsvImportProvenance, CsvSyncSummary } from '../../types'
import type { CsvImportOptions, CsvImportResult, PortfolioSnapshotImportResult } from '../../store/useAppStore'
import type { ManualMutationResult } from '../../store/portfolioOperationResult'
import type { PortfolioLoadResult } from '../../store/portfolioOperationResult'
import {
  createPortfolioLoadSingleFlight,
  executePortfolioLoadUiFlow,
  portfolioLoadButtonState,
  type PortfolioLoadFeedback,
} from '../portfolioLoadUi'

export type PendingPortfolioOperation =
  | 'refreshAllData'
  | 'importPortfolioSnapshot'
  | 'setPortfolioPolicy'
  | 'setCashAssumptions'
  | 'clearCashAssumptionsOverride'
  | 'reconfirmCashAssumptions'
  | 'importCashAssumptions'
  | null

export interface PortfolioOperationFeedback {
  tone: 'success' | 'info' | 'error'
  message: string
}

export function createPortfolioOperationSingleFlight() {
  let active = false
  return {
    async run<T>(task: () => Promise<T>): Promise<T | null> {
      if (active) return null
      active = true
      try {
        return await task()
      } finally {
        active = false
      }
    },
  }
}

export async function executeSettingsRefreshFlow(
  refresh: () => Promise<PortfolioLoadResult>,
  singleFlight: ReturnType<typeof createPortfolioLoadSingleFlight>,
  setPending: (pending: boolean) => void,
  setFeedback: (feedback: PortfolioLoadFeedback | null) => void,
): Promise<void> {
  await singleFlight.run(() => executePortfolioLoadUiFlow(refresh, setPending, setFeedback))
}

function coordinationFailureMessage(code: string): string {
  switch (code) {
    case 'LOCAL_OPERATION_BUSY':
      return '別のポートフォリオ処理が実行中です。完了後に再試行してください。'
    case 'WEB_LOCK_UNAVAILABLE':
      return 'この環境では安全な複数タブ同期を利用できません。対応ブラウザのHTTPS環境で再読み込みしてください。'
    case 'WEB_LOCK_TIMEOUT':
      return '別タブの処理待機がタイムアウトしました。別タブを確認して再試行してください。'
    case 'WEB_LOCK_ABORTED':
      return '処理開始前に操作が中断されました。再試行してください。'
    case 'WEB_LOCK_REQUEST_FAILED':
      return '安全な排他制御を開始できませんでした。再読み込み後に再試行してください。'
    case 'CROSS_TAB_STATE_STALE':
      return '別タブで更新された状態を検出しました。画面を再読み込みしてください。'
    case 'PORTFOLIO_GENERATION_CONFLICT':
      return '保存世代の競合を検出しました。画面を再読み込みしてください。'
    default:
      return '処理を安全に完了できませんでした。再読み込み後に再試行してください。'
  }
}

export function manualMutationFeedback(result: ManualMutationResult): PortfolioOperationFeedback {
  if (result.ok) {
    return result.code === 'NO_CHANGE'
      ? { tone: 'info', message: '変更はありません。' }
      : { tone: 'success', message: '変更を保存しました。' }
  }
  switch (result.code) {
    case 'MANUAL_ANALYSIS_ERROR':
      return { tone: 'error', message: '再計算に失敗しました。状態は変更されていません。' }
    case 'MANUAL_PERSISTENCE_ERROR':
      return { tone: 'error', message: '変更を保存できませんでした。再読み込み後に再試行してください。' }
    case 'MANUAL_PUBLISH_ERROR':
      return { tone: 'error', message: '保存後の画面反映に失敗しました。画面を再読み込みしてください。' }
    default:
      return { tone: 'error', message: coordinationFailureMessage(result.code) }
  }
}

export function snapshotImportFeedback(result: PortfolioSnapshotImportResult): PortfolioOperationFeedback {
  if (result.ok) {
    return result.code === 'DUPLICATE_SNAPSHOT'
      ? { tone: 'info', message: '同じsnapshot generationは取込済みです。データは変更していません。' }
      : { tone: 'success', message: 'snapshotをインポートしました。' }
  }
  return {
    tone: 'error',
    message: 'error' in result ? result.error : coordinationFailureMessage(result.code),
  }
}

export async function executeManualMutationUiFlow(
  operation: Exclude<PendingPortfolioOperation, 'refreshAllData' | 'importPortfolioSnapshot' | null>,
  action: () => Promise<ManualMutationResult>,
  setPending: (operation: PendingPortfolioOperation) => void,
  setFeedback: (feedback: PortfolioOperationFeedback | null) => void,
): Promise<ManualMutationResult | null> {
  setPending(operation)
  setFeedback(null)
  try {
    const result = await action()
    setFeedback(manualMutationFeedback(result))
    return result
  } catch {
    setFeedback({ tone: 'error', message: '処理に失敗しました。再読み込み後に再試行してください。' })
    return null
  } finally {
    setPending(null)
  }
}

export async function executeSnapshotImportUiFlow(
  action: () => Promise<PortfolioSnapshotImportResult>,
  setPending: (operation: PendingPortfolioOperation) => void,
  setFeedback: (feedback: PortfolioOperationFeedback | null) => void,
): Promise<PortfolioSnapshotImportResult | null> {
  setPending('importPortfolioSnapshot')
  setFeedback(null)
  try {
    const result = await action()
    setFeedback(snapshotImportFeedback(result))
    return result
  } catch {
    setFeedback({ tone: 'error', message: 'snapshot取込に失敗しました。再読み込み後に再試行してください。' })
    return null
  } finally {
    setPending(null)
  }
}

// ── データソースラベル ────────────────────────────────────────
const SOURCE_LABELS: Record<string, string> = {
  market:      '市場データ',
  correlation: '相関行列',
  news:        'ニュース',
  trust:       '投資信託',
  holdings:    '個別株',
  macro:       'マクロ指標',
  nikkeiVI:    '日経 VI',
  sq:          'SQ カレンダー',
  margin:      '信用倍率',
  flows:       '外国人フロー',
  candidatesStocks: '株候補データ',
}

// ── ステータスバッジ ──────────────────────────────────────────
type SourceStatus = 'loaded' | 'static' | 'none' | 'error' | 'csv'

function SourceBadge({ status }: { status: SourceStatus | string }) {
  const map: Record<string, { cls: string; label: string }> = {
    loaded: { cls: 'source-badge--loaded', label: 'ライブ' },
    static: { cls: 'source-badge--static', label: 'スタティック' },
    csv:    { cls: 'source-badge--csv',    label: 'CSV更新' },
    none:   { cls: 'source-badge--none',   label: '未取得' },
    error:  { cls: 'source-badge--error',  label: 'エラー' },
  }
  const { cls, label } = map[status] ?? map.none
  return <span className={`source-badge ${cls}`}>{label}</span>
}

// ── CSV 取込エリア ────────────────────────────────────────────
export interface CsvImportFeedback {
  ok: boolean
  message: string
  tone?: 'info'
  details?: string[]
}

export function csvImportFeedback(result: CsvImportResult): CsvImportFeedback {
  if (!result.ok && 'operation' in result) {
    return { ok: false, message: coordinationFailureMessage(result.code) }
  }
  const diagnostics = result.diagnostics
  const details = diagnostics
    ? [
        `今回の取込試行: 株式${diagnostics.recognizedStockRows}件 / 投信${diagnostics.recognizedTrustRows}件を認識`,
        `投信: ${diagnostics.matchedTrustRows}一致 / ${diagnostics.unknownTrustRows}未照合 / ${diagnostics.ambiguousTrustRows}競合`,
        ...(diagnostics.unknownTrustNames.length > 0
          ? [`未照合商品: ${diagnostics.unknownTrustNames.slice(0, 5).join('、')}`]
          : []),
        ...(diagnostics.ambiguousFundIds.length > 0
          ? [`競合した登録ID: ${diagnostics.ambiguousFundIds.slice(0, 5).join('、')}`]
          : []),
        ...(diagnostics.failedGuard ? ['安全性ガードにより取込を中止'] : []),
        diagnostics.committed ? '反映: 完了' : '反映件数: 0',
      ]
    : undefined
  return {
    ok: result.ok,
    message: result.message,
    ...(result.ok && result.code === 'DUPLICATE_CSV' ? { tone: 'info' as const } : {}),
    ...(details ? { details } : {}),
  }
}

export async function executeCsvImportUiFlow(
  file: File,
  importCsv: (file: File, options?: CsvImportOptions) => Promise<CsvImportResult>,
  setFeedback: (feedback: CsvImportFeedback | null) => void,
  options?: CsvImportOptions,
): Promise<CsvImportResult | null> {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    setFeedback({ ok: false, message: `${file.name} — CSVファイルのみ対応しています。` })
    return null
  }

  // 前回成功を即座に消し、actionのstructured resultが返るまで成功を表示しない。
  setFeedback(null)
  try {
    const result = await importCsv(file, options)
    setFeedback(csvImportFeedback(result))
    return result
  } catch {
    setFeedback({ ok: false, message: 'CSV取込に失敗しました。再読み込み後に再試行してください。' })
    return null
  }
}

function CsvDropArea({
  onFile,
  isLoading,
}: {
  onFile: (file: File, options?: CsvImportOptions) => Promise<CsvImportResult>
  isLoading: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const importInFlightRef = useRef(false)
  const [isPending, setIsPending] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [lastResult, setLastResult] = useState<CsvImportFeedback | null>(null)
  const [confirmationFile, setConfirmationFile] = useState<File | null>(null)

  const handleFile = useCallback(async (file: File) => {
    if (importInFlightRef.current || isLoading) return
    importInFlightRef.current = true
    setIsPending(true)
    try {
      const result = await executeCsvImportUiFlow(file, onFile, setLastResult)
      setConfirmationFile(result?.ok === false && result.code === 'CSV_PROVENANCE_UNKNOWN' ? file : null)
    } finally {
      importInFlightRef.current = false
      setIsPending(false)
    }
  }, [isLoading, onFile])

  const handleConfirmedImport = useCallback(async () => {
    if (!confirmationFile || importInFlightRef.current || isLoading) return
    importInFlightRef.current = true
    setIsPending(true)
    try {
      setConfirmationFile(null)
      await executeCsvImportUiFlow(
        confirmationFile,
        onFile,
        setLastResult,
        { confirmUnknownProvenance: true },
      )
    } finally {
      importInFlightRef.current = false
      setIsPending(false)
    }
  }, [confirmationFile, isLoading, onFile])

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) void handleFile(file)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = () => setIsDragOver(false)

  const pending = isLoading || isPending

  const handleClick = () => {
    if (!pending && !importInFlightRef.current) inputRef.current?.click()
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleFile(file)
    // リセット（同じファイル再選択対応）
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <div
        className={`csv-drop-area${isDragOver ? ' drag-over' : ''}`}
        onClick={pending ? undefined : handleClick}
        onDrop={pending ? undefined : handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (!pending && (e.key === 'Enter' || e.key === ' ')) handleClick() }}
        aria-label="CSVファイルを選択またはドロップ"
        aria-busy={pending}
        aria-disabled={pending}
      >
        <div className="csv-drop-area__icon">
          {pending ? '⏳' : '📂'}
        </div>
        <div className="csv-drop-area__main">
          {pending ? '取込中...' : 'CSVをドロップ / タップして選択'}
        </div>
        <div className="csv-drop-area__sub">
          SBI証券「保有証券一覧」CSV（UTF-8・Shift-JIS 両対応）
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="csv-drop-area__input"
          onChange={handleChange}
          disabled={pending}
          aria-hidden="true"
        />
      </div>

      {/* 取込結果フィードバック */}
      {lastResult && (
        <div style={{
          marginTop: spacing[2],
          padding: `${spacing[2]} ${spacing[3]}`,
          borderRadius: radius.md,
          ...typography.caption,
          background: lastResult.tone === 'info'
            ? 'var(--color-wait-bg)'
            : lastResult.ok ? 'var(--color-buy-bg)' : 'var(--color-sell-bg)',
          color: lastResult.tone === 'info'
            ? 'var(--color-wait-text)'
            : lastResult.ok ? 'var(--color-buy-text)' : 'var(--color-sell-text)',
          border: `1px solid ${lastResult.tone === 'info'
            ? 'var(--color-wait-border)'
            : lastResult.ok ? 'var(--color-buy-border)' : 'var(--color-sell-border)'}`,
        }}>
          <div>
            {lastResult.tone === 'info' ? `ℹ ${lastResult.message}` : lastResult.ok ? `✓ ${lastResult.message}` : `✗ ${lastResult.message}`}
          </div>
          {lastResult.details?.map(detail => (
            <div key={detail} style={{ marginTop: spacing[1] }}>
              {detail}
            </div>
          ))}
        </div>
      )}

      {confirmationFile && (
        <button
          type="button"
          onClick={() => { void handleConfirmedImport() }}
          disabled={pending}
          style={{ marginTop: spacing[2] }}
        >
          基準時刻不明を確認して、このCSVを再取込
        </button>
      )}

      {/* 使い方ヒント */}
      <div style={{ marginTop: spacing[3] }}>
        <div style={{ ...typography.caption, color: colors.textMuted, fontWeight: 700, marginBottom: spacing[1] }}>
          CSV 取込の使い方
        </div>
        {[
          'SBI証券 > ポートフォリオ > 保有証券一覧 > CSV ダウンロード',
          '個別株・国内株投信・海外投信が一括で反映されます',
          '既存データとマッチングして評価額・損益率・取得日を更新します',
          '取込後は自動で分析が再実行されます',
        ].map((tip, i) => (
          <div key={i} style={{
            ...typography.caption,
            color: colors.textSubtle,
            marginBottom: spacing[1],
            paddingLeft: spacing[2],
          }}>
            {i + 1}. {tip}
          </div>
        ))}
      </div>
    </div>
  )
}

export interface CsvSyncSummaryDisplay {
  hasSummary: boolean
  hasWarning: boolean
  importedAtLabel: string | null
  stockLine: string | null
  trustLine: string | null
  unknownFundsWarning: string | null
  ambiguousWarning: string | null
}

export const CSV_METADATA_STORAGE_DETAIL =
  '最大90日保持（CSV基準時刻を優先。保存し直しても鮮度は更新されません）'

export function computeCsvSourceAsOfDisplay(provenance: CsvImportProvenance): string {
  if (provenance.sourceAsOf) {
    const confidenceLabel = provenance.sourceAsOfConfidence === 'authoritative'
      ? 'CSV明示'
      : '参考情報'
    return `${formatDateTime(provenance.sourceAsOf)}（${confidenceLabel}）`
  }
  return '不明（取込操作時刻を鮮度の代用には使用しません）'
}

// P4.5-A013-T6a: CsvSyncSummaryPanelの「何を表示するか」を純関数として抽出。
// componentレンダリングなしで直接テストできるようにするだけで、表示内容・条件は変更しない。
export function computeCsvSyncSummaryDisplay(summary: CsvSyncSummary | null | undefined): CsvSyncSummaryDisplay {
  if (!summary) {
    return {
      hasSummary: false,
      hasWarning: false,
      importedAtLabel: null,
      stockLine: null,
      trustLine: null,
      unknownFundsWarning: null,
      ambiguousWarning: null,
    }
  }

  const hasWarning = summary.trust.unknownFunds.length > 0 || summary.trust.ambiguousFundIds.length > 0

  return {
    hasSummary: true,
    hasWarning,
    importedAtLabel: formatDateTime(summary.importedAt),
    stockLine: `個別株: 更新${summary.stock.updated} / 新規${summary.stock.added} / 売却反映${summary.stock.removed}`,
    trustLine: `投信: 更新${summary.trust.updated} / 再保有反映${summary.trust.reheld} / 解約反映${summary.trust.zeroed} / ` +
      `未登録${summary.trust.unknownFunds.length} / 曖昧照合${summary.trust.ambiguousFundIds.length}`,
    unknownFundsWarning: summary.trust.unknownFunds.length > 0
      ? `⚠ trust masterに未登録の投信が${summary.trust.unknownFunds.length}件見つかりました: ${summary.trust.unknownFunds.map(f => f.name).join('、')}`
      : null,
    ambiguousWarning: summary.trust.ambiguousFundIds.length > 0
      ? `⚠ 口座を一意に確定できず更新を停止した投信が${summary.trust.ambiguousFundIds.length}件あります: ${summary.trust.ambiguousFundIds.join('、')}`
      : null,
  }
}

// P4.5-A013-T6: 直近CSV取込1回分の変更点サマリ（表示専用）。
// unknown/ambiguousがある場合のみ警告色で表示し、それ以外は淡色の内訳表示にとどめる。
function CsvSyncSummaryPanel({ summary }: { summary: CsvSyncSummary | null | undefined }) {
  const display = computeCsvSyncSummaryDisplay(summary)

  if (!display.hasSummary) {
    return (
      <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[3] }}>
        まだこの端末でCSV取込結果はありません。
      </div>
    )
  }

  return (
    <div style={{
      marginTop: spacing[3],
      background: 'var(--color-bg-wash)',
      border: `1px solid var(--color-border-default)`,
      borderRadius: radius.md,
      padding: `${spacing[2.5]} ${spacing[3]}`,
      display: 'flex',
      flexDirection: 'column',
      gap: spacing[1.5],
    }}>
      <div style={{ ...typography.caption, fontWeight: 700, color: colors.textPrimary }}>
        前回成功したCSV取込結果: {display.importedAtLabel}
      </div>
      <div style={{ ...typography.caption, color: colors.textMuted }}>
        {display.stockLine}
      </div>
      <div style={{ ...typography.caption, color: colors.textMuted }}>
        {display.trustLine}
      </div>

      {display.hasWarning && (
        <div style={{
          marginTop: spacing[1],
          padding: `${spacing[1.5]} ${spacing[2.5]}`,
          background: 'var(--color-wait-bg)',
          border: `1px solid var(--color-wait-border)`,
          borderRadius: radius.md,
          display: 'flex',
          flexDirection: 'column',
          gap: spacing[1],
        }}>
          {display.unknownFundsWarning && (
            <div style={{ ...typography.caption, color: 'var(--color-wait-text)' }}>
              {display.unknownFundsWarning}
            </div>
          )}
          {display.ambiguousWarning && (
            <div style={{ ...typography.caption, color: 'var(--color-wait-text)' }}>
              {display.ambiguousWarning}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// CASH-AUTH-1: 下書き検証用の固定プレースホルダ時刻。数値契約だけを確かめるための
// 定数であり、権限の updatedAt には決してならない（実際の時刻は保存操作時に確定する）。
const DRAFT_PREVIEW_TIMESTAMP = '2000-01-01T00:00:00.000Z'

// ── CASH-AUTH-1: 現金権限（T9 = 唯一の primary editor） ──────────
// 「総現金・生活安全余力・未約定買付をどう入力したか」「その元データはいつ更新したか」
// 「保存後の現金側の上限（cashBaseLimit）はいくらか」を1画面で確定できるようにする。
// CASH-AUTH-1 R2: 実際に「今いくら投資可能か」（canonical AllocationPlanSnapshot の
// deployableCash）は T0 のサマリーカードでのみ表示する — T9 は現金のみの上限を扱う。
// T0 は読み取り専用サマリー、T1 にはエディタを置かない。
function CashAssumptionsSection() {
  const cashAssumptions = useAppStore(s => s.cashAssumptions)
  const authority = useAppStore(selectCashAuthorityView)
  const freshness = useAppStore(selectCashAssumptionsFreshness)
  const setCashAssumptions = useAppStore(s => s.setCashAssumptions)
  const clearOverride      = useAppStore(s => s.clearCashAssumptionsOverride)
  const reconfirmAuthority = useAppStore(s => s.reconfirmCashAssumptions)
  const importCashAssumptionsAction = useAppStore(s => s.importCashAssumptions)

  const hasAuthority = cashAssumptions.source === 'MANUAL'
  const [grossCashInput, setGrossCashInput] = useState(
    hasAuthority ? String(cashAssumptions.grossCash) : '',
  )
  const [safetyReserveInput, setSafetyReserveInput] = useState(
    hasAuthority ? String(cashAssumptions.safetyReserve) : '0',
  )
  const [pendingOrderCashInput, setPendingOrderCashInput] = useState(
    hasAuthority && cashAssumptions.pendingOrderCash !== null
      ? String(cashAssumptions.pendingOrderCash)
      : '',
  )

  // P4.5-A009: 他端末との手動同期（export/import）
  const [exportText, setExportText] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [importInput, setImportInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState(false)
  const [operationFeedback, setOperationFeedback] = useState<PortfolioOperationFeedback | null>(null)
  const [pendingOperation, setPendingOperation] = useState<PendingPortfolioOperation>(null)
  const singleFlightRef = useRef(createPortfolioOperationSingleFlight())

  // ストア側の権限が変わったとき（初期化復元・他タブでの解除操作等）に入力欄も追従させる。
  // これは描画時に権限へ書き戻す動作ではない — TTLは決して延長されない。
  useEffect(() => {
    const manual = cashAssumptions.source === 'MANUAL'
    setGrossCashInput(manual ? String(cashAssumptions.grossCash) : '')
    setSafetyReserveInput(manual ? String(cashAssumptions.safetyReserve) : '0')
    setPendingOrderCashInput(
      manual && cashAssumptions.pendingOrderCash !== null
        ? String(cashAssumptions.pendingOrderCash)
        : '',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashAssumptions.source, cashAssumptions.updatedAt])

  // 下書きの検証はレコード全体で行う。1項目でも不正なら保存ボタンを無効化し、
  // state / 永続化 / AllocationPlanSnapshot を一切変更しない。
  const draftValidation = validateCashAuthorityDraft({
    grossCash: grossCashInput,
    safetyReserve: safetyReserveInput,
    pendingOrderCash: pendingOrderCashInput,
    // 検証時点のプレビュー用。実際の保存時刻は store 側の操作時刻で確定する。
    updatedAt: DRAFT_PREVIEW_TIMESTAMP,
  })
  const draftErrors = draftValidation.ok ? [] : draftValidation.errors
  const draftErrorFor = (field: 'grossCash' | 'safetyReserve' | 'pendingOrderCash') =>
    draftErrors.find(e => e.field === field)?.message ?? null
  // CASH-AUTH-1 R2: 下書きは grossCash/safetyReserve/pendingOrderCash だけを反映した
  // 現金側の上限（cashBaseLimit）であり、保存後の実際の投資可能額（canonical
  // AllocationPlanSnapshot の deployableCash）を先取りして約束するものではない
  // （データ鮮度・dataUncertaintyReserve・allocation制約は下書きの時点では未確定）。
  const cashBaseLimitPreview = draftValidation.ok
    ? Math.max(
        0,
        draftValidation.record.grossCash
          - draftValidation.record.safetyReserve
          - (draftValidation.record.pendingOrderCash ?? 0),
      )
    : null

  const runManualAction = async (
    operation: Exclude<PendingPortfolioOperation, 'refreshAllData' | 'importPortfolioSnapshot' | null>,
    action: () => Promise<ManualMutationResult>,
  ) => {
    return singleFlightRef.current.run(() =>
      executeManualMutationUiFlow(
        operation,
        action,
        setPendingOperation,
        setOperationFeedback,
      ),
    )
  }

  const handleSave = async () => {
    if (!draftValidation.ok) return
    await runManualAction(
      'setCashAssumptions',
      () => setCashAssumptions({
        grossCash: grossCashInput,
        safetyReserve: safetyReserveInput,
        pendingOrderCash: pendingOrderCashInput,
      }),
    )
  }

  const handleClear = async () => {
    await runManualAction('clearCashAssumptionsOverride', clearOverride)
  }

  // CASH-AUTH-1: 「同じ金額で再確認」— 明示的なユーザー操作のときのみ TTL を更新する。
  const handleReconfirm = async () => {
    await runManualAction('reconfirmCashAssumptions', reconfirmAuthority)
  }

  // P4.5-A009: エクスポート（保存はしない。表示用の文字列を生成するのみ）。
  // CASH-AUTH-1: 権限は state.cashAssumptions ただ一つなので、実効値と保存値が
  // 乖離することはない。未設定はそのまま未設定として書き出す。
  const handleExport = () => {
    setExportText(serializeCashAssumptionsExport(buildExportableCashAssumptions(cashAssumptions)))
    setCopyFeedback(null)
  }

  const handleCopy = async () => {
    if (!exportText) return
    try {
      await navigator.clipboard.writeText(exportText)
      setCopyFeedback('コピーしました')
    } catch {
      setCopyFeedback('コピーに失敗しました。テキストを選択して手動でコピーしてください。')
    }
  }

  // P4.5-A009: 貼り付けられたJSONを検証し、有効な場合のみimportする。
  // 不正な入力ではcashAssumptionsを一切変更しない（既存値を維持したままエラー表示のみ）。
  const handleImport = async () => {
    const result = parseCashAssumptionsImport(importInput)
    if (!result.ok) {
      setImportError(result.error)
      setImportSuccess(false)
      return
    }
    const mutationResult = await runManualAction(
      'importCashAssumptions',
      () => importCashAssumptionsAction(result.data),
    )
    const imported = mutationResult?.ok === true && mutationResult.code === 'SUCCESS'
    setImportError(null)
    setImportSuccess(imported)
    if (mutationResult?.ok) setImportInput('')
  }

  const inputStyle: CSSProperties = {
    ...typography.body,
    width: '100%',
    padding: `${spacing[2]} ${spacing[3]}`,
    borderRadius: radius.md,
    border: `1px solid var(--color-border-default)`,
    background: 'var(--color-surface)',
    color: colors.textPrimary,
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">現金権限</h2>
      <div
        data-testid="cash-authority-editor"
        style={{
          background: 'var(--color-surface)',
          border: `1px solid var(--color-border-default)`,
          borderRadius: radius.lg,
          padding: `${spacing[3]} ${spacing[4]}`,
          display: 'flex',
          flexDirection: 'column',
          gap: spacing[3],
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
          <span
            data-testid="cash-authority-state-badge"
            style={{
              ...typography.badge,
              padding: `${spacing[0.5]} ${spacing[1.5]}`,
              borderRadius: radius.full,
              background: !hasAuthority
                ? 'var(--color-bg-wash)'
                : freshness.state === 'known_fresh' ? 'var(--color-buy-bg)' : 'var(--color-wait-bg)',
              color: !hasAuthority
                ? colors.textMuted
                : freshness.state === 'known_fresh' ? 'var(--color-buy-text)' : 'var(--color-wait-text)',
              border: `1px solid ${!hasAuthority
                ? 'var(--color-border-default)'
                : freshness.state === 'known_fresh' ? 'var(--color-buy-border)' : 'var(--color-wait-border)'}`,
            }}
          >
            {!hasAuthority
              ? '現金未設定'
              : freshness.state === 'known_fresh'
                ? (authority.confirmedZero ? '0円を確認済み' : '手動入力を使用中')
                : '期限切れ（参考値）'}
          </span>
          {hasAuthority && cashAssumptions.updatedAt && (
            <span style={{ ...typography.caption, color: colors.textMuted }}>
              最終更新: {formatRelativeTime(cashAssumptions.updatedAt)}
            </span>
          )}
        </div>

        {/* NO_AUTHORITY: 0円を確認済み（confirmed zero）とは別状態であることを明示する */}
        {!hasAuthority && (
          <div
            data-testid="cash-authority-unavailable-notice"
            style={{
              ...typography.caption,
              color: colors.textMuted,
              background: 'var(--color-bg-wash)',
              border: `1px solid var(--color-border-default)`,
              borderRadius: radius.md,
              padding: `${spacing[1.5]} ${spacing[2.5]}`,
            }}
          >
            ℹ️ 現金がまだ設定されていません（0円と確認済みの状態とは異なります）。
            設定されるまで投資可能現金は0円として扱われ、買付の提案は行われません。
          </div>
        )}

        {/* 失効: 金額は参考値として保持し、実行可能額のみ0に落とす */}
        {hasAuthority && freshness.state === 'stale' && (
          <div
            data-testid="cash-authority-stale-notice"
            style={{
              ...typography.caption,
              color: 'var(--color-wait-text)',
              background: 'var(--color-wait-bg)',
              border: `1px solid var(--color-wait-border)`,
              borderRadius: radius.md,
              padding: `${spacing[1.5]} ${spacing[2.5]}`,
            }}
          >
            ⚠ 現金情報の有効期限（168時間）が切れています。表示中の金額は参考値で、
            投資可能現金は0円として扱われます。金額を更新するか「同じ金額で再確認」を押してください。
          </div>
        )}

        {/* まもなく失効（144h〜168h）: まだ実行可能 */}
        {hasAuthority && freshness.state === 'known_fresh' && freshness.approachingExpiry && (
          <div
            data-testid="cash-authority-approaching-expiry-notice"
            style={{
              ...typography.caption,
              color: 'var(--color-wait-text)',
              background: 'var(--color-wait-bg)',
              border: `1px solid var(--color-wait-border)`,
              borderRadius: radius.md,
              padding: `${spacing[1.5]} ${spacing[2.5]}`,
            }}
          >
            ⚠ 現金情報はまもなく有効期限（168時間）を迎えます。今のうちに確認しておくと安全です。
          </div>
        )}

        <div>
          <label style={{ ...typography.bodySmall, fontWeight: 700, display: 'block', marginBottom: spacing[1] }}>
            総現金
          </label>
          <div style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[1] }}>
            今この時点で決済が済んでいる円建て現金の合計です。株式・投資信託の評価額、
            未受渡の売却代金、これから入金予定のお金、クレジット枠は含めません。
          </div>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            aria-label="総現金"
            data-testid="cash-authority-gross-input"
            value={grossCashInput}
            onChange={e => setGrossCashInput(e.target.value)}
            style={inputStyle}
          />
          {draftErrorFor('grossCash') && (
            <div style={{ ...typography.caption, color: 'var(--color-sell-text)', marginTop: spacing[1] }}>
              ✗ {draftErrorFor('grossCash')}
            </div>
          )}
        </div>

        <div>
          <label style={{ ...typography.bodySmall, fontWeight: 700, display: 'block', marginBottom: spacing[1] }}>
            生活・安全余力
          </label>
          <div style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[1] }}>
            総現金のうち、生活費・緊急時・納税など投資に回さない分です。総現金の内訳であり、
            別枠の追加現金ではありません。
          </div>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            aria-label="生活・安全余力"
            data-testid="cash-authority-safety-reserve-input"
            value={safetyReserveInput}
            onChange={e => setSafetyReserveInput(e.target.value)}
            style={inputStyle}
          />
          {draftErrorFor('safetyReserve') && (
            <div style={{ ...typography.caption, color: 'var(--color-sell-text)', marginTop: spacing[1] }}>
              ✗ {draftErrorFor('safetyReserve')}
            </div>
          )}
        </div>

        <div>
          <label style={{ ...typography.bodySmall, fontWeight: 700, display: 'block', marginBottom: spacing[1] }}>
            未約定の買付注文に確保済み
          </label>
          <div style={{ ...typography.caption, color: colors.textMuted, marginBottom: spacing[1] }}>
            総現金のうち、すでに出した買付注文で押さえられている分です。
            空欄のままなら「不明」として扱い、警告を表示し続けます。無い場合は 0 と入力してください。
          </div>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            aria-label="未約定の買付注文に確保済み"
            data-testid="cash-authority-pending-order-input"
            placeholder="不明な場合は空欄"
            value={pendingOrderCashInput}
            onChange={e => setPendingOrderCashInput(e.target.value)}
            style={inputStyle}
          />
          {draftErrorFor('pendingOrderCash') && (
            <div style={{ ...typography.caption, color: 'var(--color-sell-text)', marginTop: spacing[1] }}>
              ✗ {draftErrorFor('pendingOrderCash')}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ ...typography.bodySmall, fontWeight: 700 }}>保存後の現金ベース上限</span>
          <span
            data-testid="cash-authority-deployable-preview"
            style={{ ...typography.body, fontWeight: 700, color: colors.textPrimary }}
          >
            {cashBaseLimitPreview === null ? '—' : formatJPYAuto(cashBaseLimitPreview)}
          </span>
        </div>
        <div style={{ ...typography.caption, color: colors.textMuted }}>
          総現金から生活・安全余力と未約定の買付注文だけを差し引いた、現金側の上限です。
          保存後の実際の投資可能額は、データ鮮度や各資産クラス・銘柄の上限によって
          これよりさらに小さく、あるいは0円になることがあります。
        </div>

        <div style={{ display: 'flex', gap: spacing[2], flexWrap: 'wrap' }}>
          <button
            className="refresh-btn"
            onClick={handleSave}
            data-testid="cash-authority-save"
            disabled={!draftValidation.ok || pendingOperation !== null}
            style={{ flex: '1 1 auto', justifyContent: 'center' }}
          >
            {pendingOperation === 'setCashAssumptions' ? '保存中…' : '保存'}
          </button>
          <button
            onClick={handleReconfirm}
            data-testid="cash-authority-reconfirm"
            disabled={!hasAuthority || pendingOperation !== null}
            style={{
              ...typography.bodySmall,
              padding: `${spacing[1.5]} ${spacing[3]}`,
              minHeight: '44px',
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: hasAuthority ? colors.textPrimary : colors.textMuted,
              cursor: hasAuthority && pendingOperation === null ? 'pointer' : 'default',
              flex: '1 1 auto',
            }}
          >
            {pendingOperation === 'reconfirmCashAssumptions' ? '再確認中…' : '同じ金額で再確認'}
          </button>
          <button
            onClick={handleClear}
            data-testid="cash-authority-clear"
            disabled={!hasAuthority || pendingOperation !== null}
            style={{
              ...typography.bodySmall,
              padding: `${spacing[1.5]} ${spacing[3]}`,
              minHeight: '44px',
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: hasAuthority ? colors.textPrimary : colors.textMuted,
              cursor: hasAuthority && pendingOperation === null ? 'pointer' : 'default',
              flex: '1 1 auto',
            }}
          >
            {pendingOperation === 'clearCashAssumptionsOverride' ? '削除中…' : '現金情報を削除'}
          </button>
        </div>

        {operationFeedback && (
          <div style={{
            ...typography.caption,
            color: operationFeedback.tone === 'error'
              ? 'var(--color-sell-text)'
              : operationFeedback.tone === 'success'
                ? 'var(--color-buy-text)'
                : 'var(--color-wait-text)',
          }}>
            {operationFeedback.message}
          </div>
        )}

        <div style={{ ...typography.caption, color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
          <span>CSVに含まれない他金融機関の現金もここに合算して入力してください。</span>
          <span>この端末にのみ保存されます。公開データ・GitHub・外部サーバーへは一切送信しません。</span>
          <span>有効期限は最終更新から168時間です。期限が切れると投資可能現金は0円になります。</span>
        </div>

        {/* P4.5-A009: 他端末との手動同期（export/import）— 自動共有ではなく、
            ユーザーがJSON文字列を自分でコピー/貼り付けする方式に限定する */}
        <div style={{ borderTop: `1px solid var(--color-border-default)`, paddingTop: spacing[3], display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
          <div style={{ ...typography.bodySmall, fontWeight: 700 }}>他端末との同期（手動）</div>

          <div style={{ ...typography.caption, color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: spacing[0.5] }}>
            <span>⚠ 現金権限は金額を含むセンシティブな情報です。</span>
            <span>SNS・掲示板・公開リポジトリ等、公開の場所には貼り付けないでください。</span>
            <span>コピー内容がクリップボード同期やクラウド履歴に残る場合があります。ご利用の環境にご注意ください。</span>
            <span>この機能はPC/スマホ間の自動共有ではなく、コピー/貼り付けによる手動同期です。</span>
          </div>

          <button
            onClick={handleExport}
            style={{
              ...typography.bodySmall,
              padding: `${spacing[1.5]} ${spacing[3]}`,
              minHeight: '44px',
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: colors.textPrimary,
              cursor: 'pointer',
            }}
          >
            この端末の現金権限をエクスポート
          </button>

          {exportText && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
              <textarea
                readOnly
                value={exportText}
                rows={6}
                onClick={e => (e.target as HTMLTextAreaElement).select()}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  ...typography.caption,
                  fontFamily: 'monospace',
                  padding: spacing[2],
                  borderRadius: radius.md,
                  border: `1px solid var(--color-border-default)`,
                  background: 'var(--color-bg-wash)',
                  color: colors.textPrimary,
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
                <button
                  onClick={handleCopy}
                  style={{
                    ...typography.bodySmall,
                    padding: `${spacing[1]} ${spacing[2.5]}`,
                    borderRadius: radius.md,
                    border: `1px solid var(--color-border-default)`,
                    background: 'var(--color-surface)',
                    color: colors.textPrimary,
                    cursor: 'pointer',
                  }}
                >
                  コピー
                </button>
                {copyFeedback && (
                  <span style={{ ...typography.caption, color: colors.textMuted }}>{copyFeedback}</span>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
            <label style={{ ...typography.bodySmall, fontWeight: 700 }}>
              他端末からエクスポートしたJSONを貼り付け
            </label>
            <textarea
              value={importInput}
              onChange={e => { setImportInput(e.target.value); setImportError(null); setImportSuccess(false) }}
              rows={6}
              placeholder="ここにエクスポートしたJSON文字列を貼り付けてください"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                ...typography.caption,
                fontFamily: 'monospace',
                padding: spacing[2],
                borderRadius: radius.md,
                border: `1px solid var(--color-border-default)`,
                background: 'var(--color-surface)',
                color: colors.textPrimary,
                resize: 'vertical',
              }}
            />
            <button
              onClick={handleImport}
              disabled={!importInput.trim() || pendingOperation !== null}
              style={{
                ...typography.bodySmall,
                padding: `${spacing[1.5]} ${spacing[3]}`,
                minHeight: '44px',
                borderRadius: radius.md,
                border: `1px solid var(--color-border-default)`,
                background: 'var(--color-surface)',
                color: importInput.trim() && pendingOperation === null ? colors.textPrimary : colors.textMuted,
                cursor: importInput.trim() && pendingOperation === null ? 'pointer' : 'default',
              }}
            >
              {pendingOperation === 'importCashAssumptions' ? 'インポート中…' : 'インポート'}
            </button>
            {importError && (
              <div style={{ ...typography.caption, color: 'var(--color-sell-text)' }}>
                ✗ {importError}
              </div>
            )}
            {importSuccess && (
              <div style={{ ...typography.caption, color: 'var(--color-buy-text)' }}>
                ✓ インポートしました。現金権限を反映しました。
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// P4.5-A012c: 保有株・投信・現金前提・portfolioPolicyのportfolio snapshot同期（手動）。
// CashAssumptionsSectionのexport/import/copy UIパターンをそのまま踏襲する。
// P4.5-A012a/A012bで実装済みのexportPortfolioSnapshot/importPortfolioSnapshotを
// 呼び出すだけで、validation方針・store action仕様には一切触れない。
function PortfolioSnapshotSyncSection() {
  const exportPortfolioSnapshot = useAppStore(s => s.exportPortfolioSnapshot)
  const importPortfolioSnapshot = useAppStore(s => s.importPortfolioSnapshot)
  const csvLastImportedAt = useAppStore(s => s.system.csvLastImportedAt)

  const [exportText, setExportText] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [importInput, setImportInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState(false)
  const [importDuplicate, setImportDuplicate] = useState(false)
  const [operationFeedback, setOperationFeedback] = useState<PortfolioOperationFeedback | null>(null)
  const [pendingOperation, setPendingOperation] = useState<PendingPortfolioOperation>(null)
  const singleFlightRef = useRef(createPortfolioOperationSingleFlight())
  // P4.5-A013-T7: v2でtrust masterに未登録のためskipされた投信IDを非サイレントに警告表示する
  const [importSkippedTrustIds, setImportSkippedTrustIds] = useState<string[]>([])

  const handleExport = () => {
    setExportText(exportPortfolioSnapshot())
    setCopyFeedback(null)
  }

  const handleCopy = async () => {
    if (!exportText) return
    try {
      await navigator.clipboard.writeText(exportText)
      setCopyFeedback('コピーしました')
    } catch {
      setCopyFeedback('コピーに失敗しました。テキストを選択して手動でコピーしてください。')
    }
  }

  // 不正な入力ではstore/localStorageを一切変更しない（importPortfolioSnapshot側の
  // 全体reject方式に委譲。ここでは成否のみを受け取って表示を切り替える）。
  const handleImport = async () => {
    const result = await singleFlightRef.current.run(() =>
      executeSnapshotImportUiFlow(
        () => importPortfolioSnapshot(importInput),
        setPendingOperation,
        setOperationFeedback,
      ),
    )
    if (result === null) {
      setImportSuccess(false)
      setImportDuplicate(false)
      setImportSkippedTrustIds([])
      return
    }
    if (!result.ok) {
      setImportError('error' in result ? result.error : null)
      setImportSuccess(false)
      setImportDuplicate(false)
      setImportSkippedTrustIds([])
      return
    }
    if (result.code === 'DUPLICATE_SNAPSHOT') {
      setImportError(null)
      setImportSuccess(false)
      setImportDuplicate(true)
      setImportSkippedTrustIds([])
      setImportInput('')
      return
    }
    setImportError(null)
    setImportSuccess(true)
    setImportDuplicate(false)
    setImportSkippedTrustIds(result.skippedTrustIds ?? [])
    setImportInput('')
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">保有株・投信の同期（手動）</h2>
      <div style={{
        background: 'var(--color-surface)',
        border: `1px solid var(--color-border-default)`,
        borderRadius: radius.lg,
        padding: `${spacing[3]} ${spacing[4]}`,
        display: 'flex',
        flexDirection: 'column',
        gap: spacing[3],
      }}>
        <div style={{ ...typography.caption, color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: spacing[0.5] }}>
          <span>⚠ このsnapshotには保有株・投信・評価額・損益率・口座種別・現金前提が含まれます。</span>
          <span>SNS、公開チャット、GitHub、公開リポジトリには貼り付けないでください。</span>
          <span>PC/スマホ間の自動同期ではありません。コピー/貼り付けによる手動同期です。</span>
          <span>public/dataやGitHub Pagesには保存されません。</span>
          <span>インポートすると、この端末の保有株・投信・現金前提・portfolioPolicyがsnapshot内容で上書きされます。</span>
          <span>既存の保有generationがある端末では、別generationのsnapshotは安全のため自動上書きされません。</span>
          <span>個別株はsnapshotの構成に一致させます（新規銘柄は追加、この端末だけの銘柄は削除されます）。投信は登録済みIDのみ値を更新します。</span>
        </div>

        <button
          onClick={handleExport}
          style={{
            ...typography.bodySmall,
            padding: `${spacing[1.5]} ${spacing[3]}`,
            minHeight: '44px',
            borderRadius: radius.md,
            border: `1px solid var(--color-border-default)`,
            background: 'var(--color-surface)',
            color: colors.textPrimary,
            cursor: 'pointer',
          }}
        >
          この端末の保有株・投信・現金前提をエクスポート
        </button>

        {exportText && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
            <textarea
              readOnly
              value={exportText}
              rows={8}
              onClick={e => (e.target as HTMLTextAreaElement).select()}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                ...typography.caption,
                fontFamily: 'monospace',
                padding: spacing[2],
                borderRadius: radius.md,
                border: `1px solid var(--color-border-default)`,
                background: 'var(--color-bg-wash)',
                color: colors.textPrimary,
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
              <button
                onClick={handleCopy}
                style={{
                  ...typography.bodySmall,
                  padding: `${spacing[1]} ${spacing[2.5]}`,
                  borderRadius: radius.md,
                  border: `1px solid var(--color-border-default)`,
                  background: 'var(--color-surface)',
                  color: colors.textPrimary,
                  cursor: 'pointer',
                }}
              >
                コピー
              </button>
              {copyFeedback && (
                <span style={{ ...typography.caption, color: colors.textMuted }}>{copyFeedback}</span>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
          <label style={{ ...typography.bodySmall, fontWeight: 700 }}>
            他端末からエクスポートしたJSONを貼り付け
          </label>
          <textarea
            value={importInput}
            onChange={e => { setImportInput(e.target.value); setImportError(null); setImportSuccess(false); setImportDuplicate(false) }}
            rows={8}
            placeholder="ここにエクスポートしたJSON文字列を貼り付けてください"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              ...typography.caption,
              fontFamily: 'monospace',
              padding: spacing[2],
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: colors.textPrimary,
              resize: 'vertical',
            }}
          />
          <button
            onClick={handleImport}
            disabled={!importInput.trim() || pendingOperation !== null}
            style={{
              ...typography.bodySmall,
              padding: `${spacing[1.5]} ${spacing[3]}`,
              minHeight: '44px',
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: importInput.trim() && pendingOperation === null ? colors.textPrimary : colors.textMuted,
              cursor: importInput.trim() && pendingOperation === null ? 'pointer' : 'default',
            }}
          >
            {pendingOperation === 'importPortfolioSnapshot' ? 'インポート中…' : 'インポート'}
          </button>
          {operationFeedback && operationFeedback.tone === 'error' && !importError && (
            <div style={{ ...typography.caption, color: 'var(--color-sell-text)' }}>
              ✗ {operationFeedback.message}
            </div>
          )}
          {importError && (
            <div style={{ ...typography.caption, color: 'var(--color-sell-text)', display: 'flex', flexDirection: 'column', gap: spacing[0.5] }}>
              <span>✗ {importError}</span>
              <span>この端末のデータは変更されていません。</span>
            </div>
          )}
          {importSuccess && (
            <div style={{ ...typography.caption, color: 'var(--color-buy-text)', display: 'flex', flexDirection: 'column', gap: spacing[0.5] }}>
              <span>✓ インポートしました。保有株・投信・現金前提・方針を反映しました。</span>
              <span>
                {csvLastImportedAt
                  ? `取込元端末のCSV取込操作時刻: ${formatDateTime(csvLastImportedAt)}`
                  : 'CSV取込時刻なし'}
              </span>
              <span>T0/T1/T2/T7の判断は再計算済みで反映されています。</span>
            </div>
          )}
          {importDuplicate && (
            <div style={{ ...typography.caption, color: 'var(--color-wait-text)' }}>
              同じsnapshot generationは取込済みです。データは変更していません。
            </div>
          )}
          {importSkippedTrustIds.length > 0 && (
            <div style={{
              ...typography.caption, color: 'var(--color-wait-text)',
              background: 'var(--color-wait-bg)', border: `1px solid var(--color-wait-border)`,
              borderRadius: radius.md, padding: `${spacing[1.5]} ${spacing[2.5]}`,
            }}>
              ⚠ この端末のtrust masterに未登録のため反映されなかった投信IDが{importSkippedTrustIds.length}件あります:{' '}
              {importSkippedTrustIds.join('、')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── メインコンポーネント ──────────────────────────────────────
const JP_STOCK_RATIO_OPTIONS: { label: string; value: number }[] = [
  { label: '8%',  value: 0.08 },
  { label: '10%', value: 0.10 },
  { label: '12%', value: 0.12 },
  { label: '15%', value: 0.15 },
]

export function T9_Settings() {
  const system            = useAppStore(s => s.system)
  const refreshAllData    = useAppStore(s => s.refreshAllData)
  const importCsv         = useAppStore(s => s.importCsv)
  const isStale           = useAppStore(selectIsStale)
  const portfolioPolicy   = useAppStore(s => s.portfolioPolicy)
  const setPortfolioPolicy = useAppStore(s => s.setPortfolioPolicy)
  const [pendingOperation, setPendingOperation] = useState<PendingPortfolioOperation>(null)
  const [policyFeedback, setPolicyFeedback] = useState<PortfolioOperationFeedback | null>(null)
  const [refreshFeedback, setRefreshFeedback] = useState<PortfolioLoadFeedback | null>(null)
  const singleFlightRef = useRef(createPortfolioOperationSingleFlight())

  const isLoading = system.status === 'loading'
  const refreshButton = portfolioLoadButtonState(isLoading, pendingOperation !== null, {
    idle: '今すぐ更新',
    globallyLoading: '⏳ 読込中...',
    locallyPending: pendingOperation === 'refreshAllData' ? '⏳ 更新中...' : '別の処理を実行中...',
  })

  const handleImportCsv = useCallback(
    async (file: File, options?: CsvImportOptions) => importCsv(file, options),
    [importCsv],
  )

  const handleRefresh = useCallback(async () => {
    await executeSettingsRefreshFlow(
      refreshAllData,
      singleFlightRef.current,
      pending => setPendingOperation(pending ? 'refreshAllData' : null),
      setRefreshFeedback,
    )
  }, [refreshAllData])

  const handlePortfolioPolicy = useCallback(async (jpStockMaxRatio: number) => {
    await singleFlightRef.current.run(() =>
      executeManualMutationUiFlow(
        'setPortfolioPolicy',
        () => setPortfolioPolicy({ ...portfolioPolicy, jpStockMaxRatio }),
        setPendingOperation,
        setPolicyFeedback,
      ),
    )
  }, [portfolioPolicy, setPortfolioPolicy])

  const panelStyle = {
    padding: spacing[4],
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: spacing[5],
    maxWidth: '100%',
  }

  return (
    <div style={panelStyle}>
      <PageHeader tabId="T9" />

      {/* ── ヘッダー（P1-5: page titleはPageHeaderへ集約したためpillは削除） ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' }}>
        <div style={{ ...typography.caption, color: colors.textSubtle }}>
          CSV取込 · データ更新 · ソース状態
        </div>
      </div>

      {/* ── エラー表示 ── */}
      {system.status === 'error' && system.error && (
        <div style={{
          background: 'var(--color-sell-bg)',
          border: `1px solid var(--color-sell-border)`,
          borderRadius: radius.lg,
          padding: `${spacing[3]} ${spacing[4]}`,
          ...typography.bodySmall,
          color: 'var(--color-sell-text)',
        }}>
          <strong>エラー:</strong> {system.error}
        </div>
      )}

      {/* ── Section 0: ポートフォリオ方針 ── */}
      <div className="settings-section">
        <h2 className="settings-section__title">ポートフォリオ方針</h2>
        <div style={{
          background: 'var(--color-surface)',
          border: `1px solid var(--color-border-default)`,
          borderRadius: radius.lg,
          padding: `${spacing[3]} ${spacing[4]}`,
        }}>
          <div style={{ ...typography.bodySmall, fontWeight: 700, marginBottom: spacing[2] }}>
            国内個別株 上限比率
          </div>
          <div style={{ display: 'flex', gap: spacing[2], flexWrap: 'wrap' }}>
            {JP_STOCK_RATIO_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handlePortfolioPolicy(opt.value)}
                disabled={pendingOperation !== null}
                style={{
                  ...typography.bodySmall,
                  padding:       `${spacing[1.5]} ${spacing[3]}`,
                  minHeight:     '44px',
                  borderRadius:  radius.md,
                  border:        `1px solid ${portfolioPolicy.jpStockMaxRatio === opt.value ? 'var(--color-buy-border)' : 'var(--color-border-default)'}`,
                  background:    portfolioPolicy.jpStockMaxRatio === opt.value ? 'var(--color-buy-bg)' : 'var(--color-surface)',
                  color:         portfolioPolicy.jpStockMaxRatio === opt.value ? 'var(--color-buy-text)' : colors.textPrimary,
                  fontWeight:    portfolioPolicy.jpStockMaxRatio === opt.value ? 700 : 400,
                  cursor:        'pointer',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {pendingOperation === 'setPortfolioPolicy' && (
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
              方針を保存中…
            </div>
          )}
          {policyFeedback && (
            <div style={{
              ...typography.caption,
              marginTop: spacing[2],
              color: policyFeedback.tone === 'error'
                ? 'var(--color-sell-text)'
                : policyFeedback.tone === 'success'
                  ? 'var(--color-buy-text)'
                  : 'var(--color-wait-text)',
            }}>
              {policyFeedback.message}
            </div>
          )}
          <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
            国内個別株の最大保有比率（標準: 10%）。上限超過時は新規BUYを抑制し、超過分は長期資産優先で再配分します。
          </div>
        </div>
      </div>

      {/* ── Section 0.5: 資金前提（現金・待機資金） P4.5-A002 ── */}
      <CashAssumptionsSection />

      {/* ── Section 0.6: 保有株・投信の同期（手動） P4.5-A012c ── */}
      <PortfolioSnapshotSyncSection />

      {/* ── Section 1: データ更新 ── */}
      <div className="settings-section">
        <h2 className="settings-section__title">データ更新</h2>

        {/* 最終更新情報 */}
        <div style={{
          background: 'var(--color-surface)',
          border: `1px solid var(--color-border-default)`,
          borderRadius: radius.lg,
          padding: `${spacing[3]} ${spacing[4]}`,
          marginBottom: spacing[3],
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap', marginBottom: spacing[2] }}>
            <span style={{ ...typography.bodySmall, fontWeight: 700 }}>最終更新</span>
            {isStale && system.lastUpdated && (
              <span className="stale-badge">⏰ データが古い</span>
            )}
            {!system.lastUpdated && (
              <span className="stale-badge">⏰ 未取得</span>
            )}
          </div>
          <div style={{ ...typography.body, fontWeight: 700, color: colors.textPrimary }}>
            {system.lastUpdated
              ? `${formatDateTime(system.lastUpdated)}（${formatRelativeTime(system.lastUpdated)}）`
              : '—'
            }
          </div>
          {system.analysisLastRunAt && (
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              分析: {formatRelativeTime(system.analysisLastRunAt)}
            </div>
          )}
          {system.csvLastImportedAt && (
            <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[1] }}>
              CSV取込操作: {formatRelativeTime(system.csvLastImportedAt)}
            </div>
          )}
        </div>

        <button
          className="refresh-btn"
          onClick={handleRefresh}
          disabled={refreshButton.disabled}
          aria-busy={pendingOperation === 'refreshAllData'}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {refreshButton.label}
        </button>
        {refreshFeedback && (
          <div role="alert" style={{ ...typography.caption, color: 'var(--color-sell-text)', marginTop: spacing[2] }}>
            {refreshFeedback.message}
          </div>
        )}
        <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
          市場データ・ニュース・マクロ指標・SQカレンダー等を一括取得して分析を再実行します。
        </div>
      </div>

      {/* ── Section 2: CSV取込 ── */}
      <div className="settings-section">
        <h2 className="settings-section__title">
          SBI証券 CSV 取込
          {system.csvLastImportedAt && (
            <span style={{ ...typography.caption, color: colors.textMuted, fontWeight: 400, marginLeft: spacing[2] }}>
              最終: {formatRelativeTime(system.csvLastImportedAt)}
            </span>
          )}
        </h2>
        <CsvDropArea onFile={handleImportCsv} isLoading={isLoading} />
        {system.csvImportProvenance && (
          <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
            CSVデータ基準時刻: {computeCsvSourceAsOfDisplay(system.csvImportProvenance)}
          </div>
        )}
        <CsvSyncSummaryPanel summary={system.csvSyncSummary} />
      </div>

      {/* ── Section 3: データソース状態 ── */}
      <div className="settings-section">
        <h2 className="settings-section__title">データソース状態</h2>
        <div style={{
          border: `1px solid var(--color-border-default)`,
          borderRadius: radius.lg,
          overflow: 'hidden',
        }}>
          <table className="data-source-table">
            <thead>
              <tr>
                <th>データソース</th>
                <th>状態</th>
                <th>最終更新</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(system.dataSourceStatus).map(([key, status]) => (
                <tr key={key}>
                  <td style={{ ...typography.caption, fontWeight: 600 }}>
                    {SOURCE_LABELS[key] ?? key}
                  </td>
                  <td>
                    <SourceBadge status={status} />
                  </td>
                  <td style={{ ...typography.caption, color: colors.textMuted }}>
                    {(system.dataTimestamps as Record<string, string | null> | undefined)?.[key]
                      ? formatRelativeTime((system.dataTimestamps as Record<string, string | null>)[key])
                      : '—'
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
          「ライブ」= 外部ソースから最新取得 / 「CSV更新」= SBI CSVから手動取込済み / 「スタティック」= ビルド同梱データ / 「未取得」= 今回の起動では未取得
        </div>
      </div>

      {/* ── Section 4: 永続化状態 ── */}
      <div className="settings-section">
        <h2 className="settings-section__title">ローカルデータ保存状態</h2>
        <div style={{
          background: 'var(--color-bg-wash)',
          border: `1px solid var(--color-border-default)`,
          borderRadius: radius.lg,
          padding: `${spacing[3]} ${spacing[4]}`,
        }}>
          {[
            { label: 'ポートフォリオ', detail: 'localStorageに保存（7日超過で古い可能性あり警告）' },
            { label: '投資信託',       detail: 'localStorageに保存（7日超過で古い可能性あり警告）' },
            { label: '学習データ',     detail: 'localStorageに30日間保存（最大500件）' },
            { label: 'CSV取込メタデータ', detail: CSV_METADATA_STORAGE_DETAIL },
          ].map(({ label, detail }) => (
            <div key={label} style={{
              display: 'flex',
              alignItems: 'center',
              gap: spacing[3],
              padding: `${spacing[1]} 0`,
              borderBottom: `1px solid var(--color-border-default)`,
            }}>
              <span style={{ ...typography.caption, fontWeight: 700, minWidth: 100 }}>{label}</span>
              <span style={{ ...typography.caption, color: colors.textMuted }}>{detail}</span>
            </div>
          ))}
        </div>
        <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
          アプリを閉じてもデータは保持されます。ブラウザのキャッシュをクリアすると初期データに戻ります。
        </div>

        {/* P4.5-A012d: TTL超過による無警告revertを廃止したため、値は保持したまま
            stale状態のみ警告する（cashAssumptionsのP4.5-A008と同じ思想）。 */}
        {(system.localStorageFreshness?.portfolio.isStale || system.localStorageFreshness?.trust.isStale) && (
          <div style={{
            ...typography.caption,
            color: 'var(--color-wait-text)',
            background: 'var(--color-wait-bg)',
            border: `1px solid var(--color-wait-border)`,
            borderRadius: radius.md,
            padding: `${spacing[1.5]} ${spacing[2.5]}`,
            marginTop: spacing[2],
          }}>
            ⚠ 保有株/投信の端末内保存データが古い可能性があります。CSV再取込または保有株・投信の同期（手動）を確認してください。
          </div>
        )}
      </div>

      {/* ── フッター: バージョン情報 ── */}
      <div style={{
        ...typography.caption,
        color: colors.textMuted,
        textAlign: 'center',
        paddingTop: spacing[2],
        borderTop: `1px solid var(--color-border-default)`,
      }}>
        JP株OS V10 · Phase 9 完了 · {system.version}
      </div>

    </div>
  )
}
