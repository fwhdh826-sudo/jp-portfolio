import type { TabId } from '../types'

export interface TabMeta {
  id: TabId
  short: string
  label: string
  title: string
  description: string
}

export const TAB_META: TabMeta[] = [
  {
    id: 'T1',
    short: '01',
    label: '執行',
    title: '本日の執行判断',
    description: '今日やるべき売買と優先順位を整理します。',
  },
  {
    id: 'T2',
    short: '02',
    label: '保有',
    title: '保有ポジション',
    description: '保有状況、配分差分、制約を確認します。',
  },
  {
    id: 'T3',
    short: '03',
    label: '分析',
    title: '市場・銘柄分析',
    description: 'テクニカル、ファンダ、学習状況を確認します。',
  },
  {
    id: 'T4',
    short: '04',
    label: 'リスク',
    title: 'リスク管理',
    description: '集中、ストレス、相関リスクを監視します。',
  },
  {
    id: 'T5',
    short: '05',
    label: '計画',
    title: '売買計画',
    description: 'ゼロベース提案と執行ログを扱います。',
  },
  {
    id: 'T6',
    short: '06',
    label: 'ニュース',
    title: 'ニュース監視',
    description: '市場、保有、候補に効く材料をまとめます。',
  },
  {
    id: 'T7',
    short: '07',
    label: '投信',
    title: '投信ポートフォリオ',
    description: '投信の役割、配分、曜日シグナルを確認します。',
  },
]

export const TAB_META_BY_ID = Object.fromEntries(
  TAB_META.map(tab => [tab.id, tab]),
) as Record<TabId, TabMeta>
