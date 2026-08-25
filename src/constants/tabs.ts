import type { TabId } from '../types'

export interface TabMeta {
  id: TabId
  short: string
  label: string
  title: string
  description: string
  icon: string  // V10: アイコン文字（絵文字）
  phase: 'v10' | 'legacy'  // v10=新設 legacy=旧コンポーネント流用中
}

// V10 10タブ構成
// T0: ホーム（司令塔） — 今日の結論・ToDo・市場概況
// T1: 個別株         — 中期〜中長期・3ヶ月制約
// T2: 国内株投信      — 超短期回転
// T3: 海外投信        — 中長期配分
// T4: 理想PF/差分     — ゼロベース最適化
// T5: ニュース/材料   — 判断支援形式
// T6: AI委員会        — 8代理討論・統合判断
// T7: 実行プラン      — 売買設計・条件管理
// T8: 学習/検証       — 予測精度・戦略評価
// T9: 設定            — CSV取込・データ更新

export const TAB_META: TabMeta[] = [
  {
    id: 'T0',
    short: '00',
    label: 'ホーム',
    title: '今日の判断 — 司令塔',
    description: '今日の総合判断・ToDo・市場モード・リスク警告をまとめて確認します。',
    icon: '🏠',
    phase: 'v10',
  },
  {
    id: 'T1',
    short: '01',
    label: '個別株',
    title: '個別株ポートフォリオ',
    description: '個別株の判断・3ヶ月制約・売買候補を確認します。',
    icon: '📈',
    phase: 'legacy',
  },
  {
    id: 'T2',
    short: '02',
    label: '国内投信',
    title: '国内株投信（短期回転）',
    description: '日経連動投信の超短期売買シグナルと地合い診断を確認します。',
    icon: '🇯🇵',
    phase: 'legacy',
  },
  {
    id: 'T3',
    short: '03',
    label: '海外投信',
    title: '海外投信（中長期配分）',
    description: '米株・全世界・ゴールド系の中長期配分と為替影響を確認します。',
    icon: '🌍',
    phase: 'legacy',
  },
  {
    id: 'T4',
    short: '04',
    label: '理想PF',
    title: '理想ポートフォリオ / 差分',
    description: 'ゼロベースの理想PFと現在PFの差分から具体的売買候補を導きます。',
    icon: '⚖️',
    phase: 'legacy',
  },
  {
    id: 'T5',
    short: '05',
    label: 'ニュース',
    title: 'ニュース / 材料',
    description: '保有・候補銘柄に効くニュースを判断支援形式で確認します。',
    icon: '📰',
    phase: 'legacy',
  },
  {
    id: 'T6',
    short: '06',
    label: 'AI委員会',
    title: 'AI投資委員会',
    description: '8代理の討論結果・総合判断・利確/損切条件を確認します。',
    icon: '🤖',
    phase: 'legacy',
  },
  {
    id: 'T7',
    short: '07',
    label: '投信管理',
    title: '投信管理 / 当日実行判断',
    description: '投信ポートフォリオ状態・短期シグナル・当日実行キュー・資金配分提案を確認します。',
    icon: '🏦',
    phase: 'legacy',
  },
  {
    id: 'T8',
    short: '08',
    label: '学習',
    title: '学習 / 検証',
    description: '予測 vs 実績ログ・代理別精度・戦略劣化を検証します。',
    icon: '🎓',
    phase: 'legacy',
  },
  {
    id: 'T9',
    short: '09',
    label: '設定',
    title: '設定 / データ更新',
    description: 'CSV取込・データ更新・保有設定を管理します。',
    icon: '⚙️',
    phase: 'legacy',
  },
]

export const TAB_META_BY_ID = Object.fromEntries(
  TAB_META.map(tab => [tab.id, tab]),
) as Record<TabId, TabMeta>
