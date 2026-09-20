// ═══════════════════════════════════════════════════════════
// UI-9I Phase 2A: 投信ハブ / その他ハブの表示 adapter。
//
// ハブは既存画面（T2 / T3 / T7、T5 / T6 / T8 / T9）への到達だけを提供する。
// ここでは「既に canonical な値」を文字にするだけで、判断・ランキング・目標計算・
// 実行可否の推定・鮮度しきい値・全体の正常/異常のまとめを作らない。
//
//   投信ハブ: 国内投信 / 海外投信の現在額 = AllocationConsumerSnapshot.classes[].currentAmount
//             目標との差の文字列 = Portfolio adapter（gapText）の再利用
//   その他ハブ「システム」: 各時刻をそのまま絶対時刻で表示（不明は「利用不可」）
// ═══════════════════════════════════════════════════════════
import type { AppState } from '../../types'
import type { AssetClass } from '../../types/allocationPlan'
import { selectAllocationConsumerSnapshot } from '../../store/allocationConsumerSelectors'
import { formatJstMonthDayTime } from './formatters'
import { APP_VERSION_LABEL, ASSET_CLASS_LABEL, UNAVAILABLE_LABEL, UNDETERMINABLE_LABEL } from './labels'
import { FUNDS_HUB_LINKS, OTHER_HUB_LINKS, type HubLink } from './navigation'
import { currentAmountText, gapText, projectPortfolio, type PortfolioProjection } from './portfolioPresentation'

export interface HubRowViewModel {
  readonly link: HubLink
  /** 行末の現在額。値を持たない行は null、権限が利用不可なら「利用不可」。 */
  readonly valueLabel: string | null
  readonly valueUnavailable: boolean
}

export interface FundsGapRow {
  readonly assetClass: AssetClass
  readonly label: string
  readonly text: string
}

export interface FundsHubViewModel {
  readonly rows: readonly HubRowViewModel[]
  /** 国内投信 / 海外投信の「現在% / 目標% ・方向」。配分スナップショット利用不可なら null。 */
  readonly gapRows: readonly FundsGapRow[] | null
}

/** 目標との差を出す投信クラス（表示順は投信ハブの行順と同じ）。 */
const FUNDS_GAP_CLASSES: readonly AssetClass[] = ['JP_TRUST', 'OVERSEAS_TRUST']

export function projectFundsHub(pf: PortfolioProjection | null): FundsHubViewModel {
  const rows = FUNDS_HUB_LINKS.map((link): HubRowViewModel => {
    if (link.valueAssetClass === undefined) return { link, valueLabel: null, valueUnavailable: false }
    const row = pf?.rows.find(r => r.assetClass === link.valueAssetClass)
    return row === undefined
      ? { link, valueLabel: UNAVAILABLE_LABEL, valueUnavailable: true }
      : { link, valueLabel: currentAmountText(row), valueUnavailable: false }
  })
  const gapRows = pf === null
    ? null
    : FUNDS_GAP_CLASSES.map((assetClass): FundsGapRow => {
      const row = pf.rows.find(r => r.assetClass === assetClass)
      return {
        assetClass,
        label: ASSET_CLASS_LABEL[assetClass],
        text: row === undefined ? UNDETERMINABLE_LABEL : gapText(row),
      }
    })
  return { rows, gapRows }
}

export function selectFundsHubViewModel(state: AppState): FundsHubViewModel {
  return projectFundsHub(projectPortfolio(selectAllocationConsumerSnapshot(state)))
}

// ── その他ハブ ────────────────────────────────────────────
export interface SystemRowViewModel {
  readonly id: 'decision' | 'market' | 'candidates' | 'version'
  readonly label: string
  readonly value: string
  readonly unavailable: boolean
}

export interface OtherHubViewModel {
  readonly links: readonly HubLink[]
  readonly system: readonly SystemRowViewModel[]
}

export interface OtherHubTimestamps {
  readonly decisionGeneratedAt: string | null
  readonly marketAt: string | null
  readonly candidatesAt: string | null
}

const timeRow = (id: SystemRowViewModel['id'], label: string, iso: string | null): SystemRowViewModel => {
  const formatted = formatJstMonthDayTime(iso)
  return { id, label, value: formatted ?? UNAVAILABLE_LABEL, unavailable: formatted === null }
}

/** 各データセットの時刻を個別に表示する。「全体正常」にはまとめない。 */
export function assembleOtherHub(t: OtherHubTimestamps): OtherHubViewModel {
  return {
    links: OTHER_HUB_LINKS,
    system: [
      timeRow('decision', '判断生成', t.decisionGeneratedAt),
      timeRow('market', '市場データ', t.marketAt),
      timeRow('candidates', '候補データ', t.candidatesAt),
      { id: 'version', label: 'バージョン', value: APP_VERSION_LABEL, unavailable: false },
    ],
  }
}

/**
 * Home の gatherTodayHomeInputs().timestamps と同じ導出（市場 / 候補）。
 * Home 側を変更しないため、同値であることは hubPresentation.test で照合する。
 */
export function selectOtherHubTimestamps(state: AppState): OtherHubTimestamps {
  const ts = state.system.dataTimestamps
  return {
    decisionGeneratedAt: state.officialDecision?.generatedAt ?? null,
    marketAt: ts?.market ?? state.market.last_updated ?? null,
    candidatesAt: ts?.candidateFunnel ?? ts?.candidatesStocks ?? null,
  }
}

export function selectOtherHubViewModel(state: AppState): OtherHubViewModel {
  return assembleOtherHub(selectOtherHubTimestamps(state))
}
