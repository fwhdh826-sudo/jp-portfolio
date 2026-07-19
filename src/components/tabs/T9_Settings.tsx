/**
 * T9_Settings — 設定 / データ更新 / CSV取込 V10 Phase 9
 * CSV取込 · データ更新 · データソース状態 · 永続化状態
 * 表示順: データ更新 → CSV取込 → データソース状態 → 永続化
 */
import { useRef, useState, useCallback, useEffect, type DragEvent, type CSSProperties } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { selectIsStale, selectEffectiveCashAssumptions, selectCashAssumptionsFreshness } from '../../store/selectors'
import { formatDateTime, formatRelativeTime, formatJPYAuto } from '../../utils/format'
import { serializeCashAssumptionsExport, parseCashAssumptionsImport, buildExportableCashAssumptions } from '../../utils/cashAssumptionsTransfer'
import { colors, radius, spacing } from '../../theme/tokens'
import { typography } from '../../theme/typography'
import type { CsvImportProvenance, CsvSyncSummary } from '../../types'
import type { CsvImportOptions, CsvImportResult } from '../../store/useAppStore'

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
    setFeedback({
      ok: result.ok,
      message: result.message,
      ...(result.ok && result.code === 'DUPLICATE_CSV' ? { tone: 'info' as const } : {}),
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setFeedback({ ok: false, message: `CSV取込に失敗しました: ${message}` })
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
  const [isDragOver, setIsDragOver] = useState(false)
  const [lastResult, setLastResult] = useState<CsvImportFeedback | null>(null)
  const [confirmationFile, setConfirmationFile] = useState<File | null>(null)

  const handleFile = useCallback(async (file: File) => {
    if (importInFlightRef.current || isLoading) {
      setLastResult({ ok: false, message: '別の取込または更新が進行中です。完了後に再試行してください。' })
      return
    }
    importInFlightRef.current = true
    try {
      const result = await executeCsvImportUiFlow(file, onFile, setLastResult)
      setConfirmationFile(result?.ok === false && result.code === 'CSV_PROVENANCE_UNKNOWN' ? file : null)
    } finally {
      importInFlightRef.current = false
    }
  }, [isLoading, onFile])

  const handleConfirmedImport = useCallback(async () => {
    if (!confirmationFile || importInFlightRef.current || isLoading) return
    importInFlightRef.current = true
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

  const handleClick = () => {
    if (!isLoading && !importInFlightRef.current) inputRef.current?.click()
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
        onClick={isLoading ? undefined : handleClick}
        onDrop={isLoading ? undefined : handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (!isLoading && (e.key === 'Enter' || e.key === ' ')) handleClick() }}
        aria-label="CSVファイルを選択またはドロップ"
        aria-busy={isLoading}
        aria-disabled={isLoading}
      >
        <div className="csv-drop-area__icon">
          {isLoading ? '⏳' : '📂'}
        </div>
        <div className="csv-drop-area__main">
          {isLoading ? '取込中...' : 'CSVをドロップ / タップして選択'}
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
          disabled={isLoading}
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
          {lastResult.tone === 'info' ? `ℹ ${lastResult.message}` : lastResult.ok ? `✓ ${lastResult.message}` : `✗ ${lastResult.message}`}
        </div>
      )}

      {confirmationFile && (
        <button
          type="button"
          onClick={() => { void handleConfirmedImport() }}
          disabled={isLoading}
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
        最終CSV取込結果: {display.importedAtLabel}
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

// ── P4.5-A002: 資金前提（現金・預貯金 / 待機・追加資金）手動入力エリア ──────
// 手動入力値は「CSV外追加分」ではなく「資金前提の総額」として扱う（CSV/既定値とは加算しない）。
function CashAssumptionsSection({ sectionTitleStyle }: { sectionTitleStyle: CSSProperties }) {
  const cashAssumptions = useAppStore(s => s.cashAssumptions)
  const effective        = useAppStore(selectEffectiveCashAssumptions)
  const freshness         = useAppStore(selectCashAssumptionsFreshness)
  const setCashAssumptions = useAppStore(s => s.setCashAssumptions)
  const clearOverride      = useAppStore(s => s.clearCashAssumptionsOverride)
  const importCashAssumptionsAction = useAppStore(s => s.importCashAssumptions)

  const [cashDepositsInput, setCashDepositsInput] = useState(String(effective.cash))
  const [standbyFundsInput, setStandbyFundsInput] = useState(String(effective.cashReserve))

  // P4.5-A009: 他端末との手動同期（export/import）
  const [exportText, setExportText] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [importInput, setImportInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState(false)

  // ストア側の実効値が変わったとき（初期化復元・他タブでの解除操作等）に入力欄も追従させる
  useEffect(() => {
    setCashDepositsInput(String(effective.cash))
    setStandbyFundsInput(String(effective.cashReserve))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashAssumptions.manualOverrideEnabled, cashAssumptions.manualUpdatedAt])

  const parsedDeposits = Math.max(0, Math.round(Number(cashDepositsInput) || 0))
  const parsedStandby  = Math.max(0, Math.round(Number(standbyFundsInput) || 0))
  const cashTotalPreview = parsedDeposits + parsedStandby

  const handleSave = () => {
    setCashAssumptions({ cashDeposits: parsedDeposits, standbyFunds: parsedStandby })
  }

  const handleClear = () => {
    clearOverride()
  }

  // P4.5-A009: エクスポート（保存はしない。表示用の文字列を生成するのみ）
  // P4.5-A009 ミニ監査: rawのcashAssumptionsではなく実効値（effective）をexportする。
  // manualOverrideEnabled=falseの場合、rawのcashDeposits/standbyFundsは初回起動時0/0の
  // ままだったり、解除前の古い値が残っていたりして「実際に使われている値」と一致しない
  // ため、buildExportableCashAssumptionsでeffective（既定値含む）ベースに変換してから
  // exportする（import時にmanualOverrideEnabled=trueへ強制する仕様と整合させる）。
  const handleExport = () => {
    setExportText(serializeCashAssumptionsExport(buildExportableCashAssumptions(effective)))
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
  const handleImport = () => {
    const result = parseCashAssumptionsImport(importInput)
    if (!result.ok) {
      setImportError(result.error)
      setImportSuccess(false)
      return
    }
    importCashAssumptionsAction(result.data)
    setImportError(null)
    setImportSuccess(true)
    setImportInput('')
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
      <div style={sectionTitleStyle}>資金前提（現金・待機資金）</div>
      <div style={{
        background: 'var(--color-surface)',
        border: `1px solid var(--color-border-default)`,
        borderRadius: radius.lg,
        padding: `${spacing[3]} ${spacing[4]}`,
        display: 'flex',
        flexDirection: 'column',
        gap: spacing[3],
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' }}>
          <span style={{
            ...typography.badge,
            padding: `${spacing[0.5]} ${spacing[1.5]}`,
            borderRadius: radius.full,
            background: cashAssumptions.manualOverrideEnabled ? 'var(--color-buy-bg)' : 'var(--color-bg-wash)',
            color: cashAssumptions.manualOverrideEnabled ? 'var(--color-buy-text)' : colors.textMuted,
            border: `1px solid ${cashAssumptions.manualOverrideEnabled ? 'var(--color-buy-border)' : 'var(--color-border-default)'}`,
          }}>
            {cashAssumptions.manualOverrideEnabled ? '手動入力値を使用中' : '既定値を使用中'}
          </span>
          {cashAssumptions.manualOverrideEnabled && cashAssumptions.manualUpdatedAt && (
            <span style={{ ...typography.caption, color: colors.textMuted }}>
              最終更新: {formatRelativeTime(cashAssumptions.manualUpdatedAt)}
            </span>
          )}
        </div>

        {/* P4.5-A010: 既定値がpublic repo内のサンプル値であることを明示し、
            実際の運用にはT9での入力を促す（値は変更せず表示のみ） */}
        {!cashAssumptions.manualOverrideEnabled && (
          <div style={{
            ...typography.caption,
            color: colors.textMuted,
            background: 'var(--color-bg-wash)',
            border: `1px solid var(--color-border-default)`,
            borderRadius: radius.md,
            padding: `${spacing[1.5]} ${spacing[2.5]}`,
          }}>
            ℹ️ 既定値はコード内蔵のサンプル値です。実際の判断には下記フォームにご自身の現金・待機資金額を入力してください。
          </div>
        )}

        {/* P4.5-A008: 資金前提のstale警告（値は維持したまま確認を促すのみ。BUY/SELL判断ではない） */}
        {freshness.isStale && (
          <div style={{
            ...typography.caption,
            color: 'var(--color-wait-text)',
            background: 'var(--color-wait-bg)',
            border: `1px solid var(--color-wait-border)`,
            borderRadius: radius.md,
            padding: `${spacing[1.5]} ${spacing[2.5]}`,
          }}>
            ⚠ 資金前提が7日以上更新されていません。最新の現金・待機資金を確認してください。
          </div>
        )}

        <div>
          <label style={{ ...typography.bodySmall, fontWeight: 700, display: 'block', marginBottom: spacing[1] }}>
            現金・預貯金
          </label>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={cashDepositsInput}
            onChange={e => setCashDepositsInput(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={{ ...typography.bodySmall, fontWeight: 700, display: 'block', marginBottom: spacing[1] }}>
            待機・追加資金
          </label>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={standbyFundsInput}
            onChange={e => setStandbyFundsInput(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ ...typography.bodySmall, fontWeight: 700 }}>現金等合計</span>
          <span style={{ ...typography.body, fontWeight: 700, color: colors.textPrimary }}>
            {formatJPYAuto(cashTotalPreview)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: spacing[2], flexWrap: 'wrap' }}>
          <button
            className="refresh-btn"
            onClick={handleSave}
            style={{ flex: '1 1 auto', justifyContent: 'center' }}
          >
            保存
          </button>
          <button
            onClick={handleClear}
            disabled={!cashAssumptions.manualOverrideEnabled}
            style={{
              ...typography.bodySmall,
              padding: `${spacing[1.5]} ${spacing[3]}`,
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: cashAssumptions.manualOverrideEnabled ? colors.textPrimary : colors.textMuted,
              cursor: cashAssumptions.manualOverrideEnabled ? 'pointer' : 'default',
              flex: '1 1 auto',
            }}
          >
            手動入力を解除（既定値に戻す）
          </button>
        </div>

        <div style={{ ...typography.caption, color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: spacing[1] }}>
          <span>CSVに含まれない他金融機関の資産を反映できます。</span>
          <span>この端末に保存されます。PC/スマホ間の自動共有は未実装です。</span>
          <span>次回自動データ更新前、目安08:25までに手動更新してください。</span>
        </div>

        {/* P4.5-A009: 他端末との手動同期（export/import）— 自動共有ではなく、
            ユーザーがJSON文字列を自分でコピー/貼り付けする方式に限定する */}
        <div style={{ borderTop: `1px solid var(--color-border-default)`, paddingTop: spacing[3], display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
          <div style={{ ...typography.bodySmall, fontWeight: 700 }}>他端末との同期（手動）</div>

          <div style={{ ...typography.caption, color: colors.textMuted, display: 'flex', flexDirection: 'column', gap: spacing[0.5] }}>
            <span>⚠ 資金前提は金額を含むセンシティブな情報です。</span>
            <span>SNS・掲示板・公開リポジトリ等、公開の場所には貼り付けないでください。</span>
            <span>コピー内容がクリップボード同期やクラウド履歴に残る場合があります。ご利用の環境にご注意ください。</span>
            <span>この機能はPC/スマホ間の自動共有ではなく、コピー/貼り付けによる手動同期です。</span>
          </div>

          <button
            onClick={handleExport}
            style={{
              ...typography.bodySmall,
              padding: `${spacing[1.5]} ${spacing[3]}`,
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: colors.textPrimary,
              cursor: 'pointer',
            }}
          >
            この端末の資金前提をエクスポート
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
              disabled={!importInput.trim()}
              style={{
                ...typography.bodySmall,
                padding: `${spacing[1.5]} ${spacing[3]}`,
                borderRadius: radius.md,
                border: `1px solid var(--color-border-default)`,
                background: 'var(--color-surface)',
                color: importInput.trim() ? colors.textPrimary : colors.textMuted,
                cursor: importInput.trim() ? 'pointer' : 'default',
              }}
            >
              インポート
            </button>
            {importError && (
              <div style={{ ...typography.caption, color: 'var(--color-sell-text)' }}>
                ✗ {importError}
              </div>
            )}
            {importSuccess && (
              <div style={{ ...typography.caption, color: 'var(--color-buy-text)' }}>
                ✓ インポートしました。資金前提を手動入力値に反映しました。
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
function PortfolioSnapshotSyncSection({ sectionTitleStyle }: { sectionTitleStyle: CSSProperties }) {
  const exportPortfolioSnapshot = useAppStore(s => s.exportPortfolioSnapshot)
  const importPortfolioSnapshot = useAppStore(s => s.importPortfolioSnapshot)
  const csvLastImportedAt = useAppStore(s => s.system.csvLastImportedAt)

  const [exportText, setExportText] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [importInput, setImportInput] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [importSuccess, setImportSuccess] = useState(false)
  const [importDuplicate, setImportDuplicate] = useState(false)
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
  const handleImport = () => {
    const result = importPortfolioSnapshot(importInput)
    if (!result.ok) {
      setImportError(result.error)
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
      <div style={sectionTitleStyle}>保有株・投信の同期（手動）</div>
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
            disabled={!importInput.trim()}
            style={{
              ...typography.bodySmall,
              padding: `${spacing[1.5]} ${spacing[3]}`,
              borderRadius: radius.md,
              border: `1px solid var(--color-border-default)`,
              background: 'var(--color-surface)',
              color: importInput.trim() ? colors.textPrimary : colors.textMuted,
              cursor: importInput.trim() ? 'pointer' : 'default',
            }}
          >
            インポート
          </button>
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

  const isLoading = system.status === 'loading'

  const handleImportCsv = useCallback(
    async (file: File, options?: CsvImportOptions) => importCsv(file, options),
    [importCsv],
  )

  const handleRefresh = useCallback(() => {
    void refreshAllData()
  }, [refreshAllData])

  const panelStyle = {
    padding: spacing[4],
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: spacing[5],
    maxWidth: '100%',
  }

  const sectionTitleStyle = {
    ...typography.bodySmall,
    fontWeight: 700 as const,
    color: colors.textPrimary,
    marginBottom: spacing[3],
    paddingBottom: spacing[2],
    borderBottom: `1px solid var(--color-border-default)`,
  }

  return (
    <div style={panelStyle}>

      {/* ── ヘッダー ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' }}>
        <div style={{
          padding: `${spacing[1]} ${spacing[3]}`,
          background: 'var(--color-bg-navy-light, #1a3558)',
          color: '#e8f0f8',
          borderRadius: radius.full,
          ...typography.label,
          fontWeight: 700,
        }}>
          設定 / データ更新
        </div>
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
        <div style={sectionTitleStyle}>ポートフォリオ方針</div>
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
                onClick={() => setPortfolioPolicy({ ...portfolioPolicy, jpStockMaxRatio: opt.value })}
                style={{
                  ...typography.bodySmall,
                  padding:       `${spacing[1.5]} ${spacing[3]}`,
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
          <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
            国内個別株の最大保有比率（標準: 10%）。上限超過時は新規BUYを抑制し、超過分は長期資産優先で再配分します。
          </div>
        </div>
      </div>

      {/* ── Section 0.5: 資金前提（現金・待機資金） P4.5-A002 ── */}
      <CashAssumptionsSection sectionTitleStyle={sectionTitleStyle} />

      {/* ── Section 0.6: 保有株・投信の同期（手動） P4.5-A012c ── */}
      <PortfolioSnapshotSyncSection sectionTitleStyle={sectionTitleStyle} />

      {/* ── Section 1: データ更新 ── */}
      <div className="settings-section">
        <div style={sectionTitleStyle}>データ更新</div>

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
          disabled={isLoading}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {isLoading ? '⏳ 更新中...' : '今すぐ更新'}
        </button>
        <div style={{ ...typography.caption, color: colors.textMuted, marginTop: spacing[2] }}>
          市場データ・ニュース・マクロ指標・SQカレンダー等を一括取得して分析を再実行します。
        </div>
      </div>

      {/* ── Section 2: CSV取込 ── */}
      <div className="settings-section">
        <div style={sectionTitleStyle}>
          SBI証券 CSV 取込
          {system.csvLastImportedAt && (
            <span style={{ ...typography.caption, color: colors.textMuted, fontWeight: 400, marginLeft: spacing[2] }}>
              最終: {formatRelativeTime(system.csvLastImportedAt)}
            </span>
          )}
        </div>
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
        <div style={sectionTitleStyle}>データソース状態</div>
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
        <div style={sectionTitleStyle}>ローカルデータ保存状態</div>
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
