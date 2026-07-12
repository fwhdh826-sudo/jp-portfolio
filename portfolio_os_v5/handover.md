# JP株 Decision OS — セッション引き継ぎ書
# Version: v9.1.0 | 最終更新: 2026-04-15

---

## 1. プロジェクト概要

**アプリ名:** JP株 Decision OS  
**バージョン:** v9.1.0 (package.json)  
**スタック:** React + TypeScript + Vite + Zustand  
**リポジトリ:** /Users/ryo/Downloads/Claude  
**現在ブランチ:** main  

日本株 16 銘柄 + 投資信託 18 銘柄を対象としたポートフォリオ分析 OS。  
7 タブ構成。AI 委員会（7 エージェント）による銘柄評価・執行判断を中核に持つ。

---

## 2. ファイル構成（Phase 1〜7 完了後の現状）

```
src/
├── theme/
│   ├── tokens.ts          # デザイントークン（色・スペーシング・角丸・シャドウ）
│   └── typography.ts      # タイポグラフィスケール（10 段階）
├── components/
│   ├── StatusBar.tsx       # 上部ステータスバー（278 行）
│   ├── TabNav.tsx          # タブナビゲーション
│   ├── badges/
│   │   ├── SignalBadge.tsx     # BUY/SELL/HOLD/WATCH バッジ
│   │   ├── AssetTypeBadge.tsx  # 個別株/投信 区別バッジ
│   │   └── RiskBadge.tsx       # リスクレベルバッジ（HIGH/MEDIUM/LOW）
│   ├── cards/
│   │   ├── MetricCard.tsx      # 数値表示カード
│   │   ├── InsightCard.tsx     # AI 分析 4 ブロックカード（必須フィールド）
│   │   ├── DecisionCard.tsx    # 総合判定カード（BUY/SELL/HOLD）
│   │   └── ActionPanel.tsx     # 推奨アクションエリア
│   ├── layout/
│   │   ├── AppShell.tsx        # 全体レイアウト（サイドバー + メイン + モバイルドック）
│   │   ├── PageHeader.tsx      # ページタイトルエリア
│   │   └── SectionHeader.tsx   # セクション見出し
│   ├── shared/
│   │   ├── EmptyState.tsx      # データなし状態
│   │   └── InfoTooltip.tsx     # 補足説明ツールチップ
│   ├── mobile/
│   │   └── MobileBottomActionBar.tsx  # スマホ用下部固定 CTA
│   └── tabs/
│       ├── T1_Decision.tsx    # 執行判断タブ（621 行）
│       ├── T2_Holdings.tsx    # 保有銘柄タブ（652 行）
│       ├── T3_Regime.tsx      # レジーム分析タブ（453 行）
│       ├── T4_Correlation.tsx # 相関行列タブ
│       ├── T5_Backtest.tsx    # バックテストタブ
│       ├── T6_History.tsx     # ニュースハブタブ
│       └── T7_Trust.tsx       # 投信タブ（852 行）
├── hooks/
│   └── useIsMobile.ts     # モバイル判定フック
└── styles/
    └── v5.css             # グローバル CSS（ライトテーマ）
```

---

## 3. Phase 別実装内容

### Phase 1: デザイン基盤 ✅

**完了日:** 2026-04-14  

**実装ファイル:**
- `src/theme/tokens.ts` — 新規作成
- `src/theme/typography.ts` — 新規作成

**tokens.ts の主要値:**

| カテゴリ | キー | 値 | 意味 |
|---|---|---|---|
| 背景 | bgBase | `#0b1120` | ダークネイビー（ページ背景） |
| 背景 | bgSurface | `#111827` | カード・パネル背景 |
| 背景 | bgElevated | `#1c2537` | ホバー・ポップオーバー |
| テキスト | textPrimary | `#e8edf5` | 主要テキスト |
| テキスト | textSubtle | `#8da0bc` | 補助テキスト（青灰色） |
| テキスト | textMuted | `#4f6070` | 最弱テキスト |
| ステータス | buy | `#1a9174` | 落ち着いたグリーン |
| ステータス | sell | `#be3b41` | 落ち着いた赤 |
| ステータス | hold | `#b08030` | 黄土色 |
| アセット | stockAccent | `#3b7dd8` | 個別株: 冷たい青系 |
| アセット | fundAccent | `#7b5ea7` | 投信: 紫〜青紫 |

**typography.ts のスケール:**
`pageTitle(22px)` / `sectionTitle(14px)` / `cardTitle(15px)` / `body(14px)` / `bodySmall(13px)` / `caption(11px)` / `metricLarge(28px)` / `metricMedium(18px)` / `metricSmall(13px)` / `label(11px)` / `badge(10px)`  
→ `metricLarge/Medium/Small` には `fontVariantNumeric: 'tabular-nums'` 必須適用済み

**設計判断:**
- stockAccent = primary と同値 (#3b7dd8)。「株 = 主要導線 = 青」の統一。
- 色の意味を固定（青=株/主要, 緑=BUY, 赤=SELL, 黄=WATCH, 紫=投信, 灰=補助）。変更禁止。
- スペーシングは 4px グリッド厳守。
- `generateCssVars()` / `applyTheme()` で CSS 変数として :root に注入可能（未使用だが将来の統合用）。

---

### Phase 2: 共通コンポーネント整備 ✅

**完了日:** 2026-04-14  

**実装した 15 コンポーネント:**

| コンポーネント | 場所 | 役割 |
|---|---|---|
| SignalBadge | badges/ | BUY/SELL/HOLD/WATCH — size="sm/md/lg" |
| AssetTypeBadge | badges/ | 個別株(stockAccent) / 投信(fundAccent) の色分け |
| RiskBadge | badges/ | HIGH/MEDIUM/LOW リスクレベル |
| MetricCard | cards/ | タイトル・数値・変化量・補助テキスト |
| InsightCard | cards/ | AI 分析 4 ブロック（結論/根拠/リスク/アクション は全必須） |
| DecisionCard | cards/ | 総合判定 + スコアバー + 判定根拠 |
| ActionPanel | cards/ | 推奨アクションエリア |
| AppShell | layout/ | サイドバー(264px固定) + メイン + モバイルドック |
| PageHeader | layout/ | ページタイトルエリア |
| SectionHeader | layout/ | セクション見出し（UPPERCASE） |
| EmptyState | shared/ | データなし状態 |
| InfoTooltip | shared/ | ホバーで補足説明 |
| MobileBottomActionBar | mobile/ | スマホ用下部固定 CTA |

**実装ルール:**
- 全コンポーネントがトークン参照（ハードコード色なし）
- inline style を使用（Tailwind / CSS Modules 不使用）
- Props は全て TypeScript 型定義あり
- InsightCard の 4 ブロックは任意フィールドなし（必須強制）

---

### Phase 3: ダッシュボード再構成 ✅

**対象タブ:** T1_Decision.tsx  

**実装内容:**
- AI 委員会判定 (DecisionCard) を最上部に固定
- Portfolio Health Cards (MetricCard) — 主要 KPI 表示
- Risk Alert Strip — 重要アラートを埋没させない配置
- Recommended Actions (ActionPanel) — 次のアクション明示
- Market Pulse — 市場環境サマリー
- Deep Analysis Entry — 詳細タブへの導線

**完了基準確認:**
- ✅ 結論（総合判定）が最初に表示される
- ✅ 重要アラートが埋もれていない
- ✅ 次のアクションが分かる
- ✅ スマホで上部から順に意味をなす

---

### Phase 4: 個別株タブ再構成 ✅

**対象タブ:** T2_Holdings.tsx  

**実装内容:**
- 総合スコアの上部固定 (DecisionCard 使用)
- スコア内訳の色分け視覚化
- 妥当株価 / 割安割高感の表示
- 決算・成長・収益性評価ブロック
- 市場センチメント要約
- アクション提案（保有継続/追加/利確/監視）
- AssetTypeBadge で「個別株」表示 (stockAccent 青)
- InsightCard で AI 分析表示

**完了基準確認:**
- ✅ 総合判定が最上部にある
- ✅ 個別株と投信の見た目が明確に違う（青 vs 紫）
- ✅ AI 分析が InsightCard（4 ブロック）で表示

---

### Phase 5: 投信タブ再構成 ✅

**対象タブ:** T7_Trust.tsx（852 行・最大コンポーネント）  

**実装内容:**
- 投信タイプ分類（日本株系 / 海外資産系）
- 短期シグナル + 地合い評価ブロック
- Nikkei 225 VI × SQ 補助判断
- 資金配分提案パネル
- 保有投信 / 非保有候補の比較表示
- AssetTypeBadge で「投信」表示 (fundAccent 紫)
- InsightCard で AI 分析表示

**完了基準確認:**
- ✅ 個別株タブと投信タブで見た目が明確に違う
- ✅ 投信専用シグナル（VI/SQ）が表示されている
- ✅ AI 分析が InsightCard（4 ブロック）で表示

---

### Phase 6: モバイル最適化 ✅

**実装内容:**
- `useIsMobile.ts` フック実装（ブレークポイント: 420px）
- MobileBottomActionBar を主要タブに配置
- 横スクロール依存箇所の排除
- タップ領域 44px 以上確保
- テーブルのカード化 / アコーディオン化
- 重要結論の上部固定確認

**完了基準確認:**
- ✅ iPhone SE 相当（375px 幅）で全画面が破綻しない
- ✅ 横スクロールが発生しない
- ✅ 結論がスクロールなしで見える

---

### Phase 7: 統一・微調整 ✅

**完了日:** 2026-04-14  

**実装内容:**
- `v5.css` — ハードコード HEX 16 箇所を CSS 変数化 (`--chart-main` / `--chart-accent` 追加)
- `v5.css` — スペーシング 2 箇所修正（13px→12px, 9px→8px で 4px グリッドに合わせる）
- `T3_Regime.tsx` — InsightCard サマリーを詳細レポートの前に追加
- 全 TSX の className にハードコード色なし確認 ✅
- tokens.ts の textPrimary/textSubtle/textMuted でコントラスト確保確認 ✅
- T7: fundAccentBg/Text/Border を全箇所で使用確認 ✅
- T1/T2: stockAccent を全箇所で使用確認 ✅
- AI 分析 InsightCard 使用箇所確認: T1 ✅ T2 ✅ T3 ✅ T7 ✅（T4/T5/T6 は AI 分析表示なし）

---

## 4. 重要な設計判断

### テーマ二重構造（要注意）

**現状の構造:**

```
v5.css（グローバル CSS）  → ライトテーマ（--bg: #f3f6fb, --panel: #ffffff）
tokens.ts（React inline） → ダークテーマ（bgBase: #0b1120, bgSurface: #111827）
```

- `v5.css` は StatusBar・TabNav・既存レイアウトが参照するライトテーマ
- `tokens.ts` は新規コンポーネント（cards/, badges/, layout/）が参照するダークテーマ
- **タブ本文はダーク、ナビ/ヘッダーはライト** という混在状態
- これは意図的な段階移行の産物。将来的には v5.css をトークンに完全移行することを推奨

### InsightCard の 4 ブロック必須化

- `conclusion / reasons / risks / action` は任意フィールドなし
- 「AI 分析は必ず結論・根拠・リスク・アクションの 4 点セットで提示する」という UX 原則を型で強制
- optional フィールド: `confidence / horizon / watchMetric / changeFromLast`

### 色の意味ロック

`tokens.ts` コメントに明記済み。変更禁止:
- 青 → 個別株 / 主要導線
- 緑 → BUY / 好転
- 赤 → SELL / 悪化
- 黄 → WATCH / 様子見
- 紫 → 投信 / ファンド
- 灰 → 補助情報

### stockAccent = primary

`colors.stockAccent` と `colors.primary` は同値 (`#3b7dd8`)。  
「株への導線 = 主要導線」という設計意図。分けたい場合は primary を変更すること。

---

## 5. 既知の問題・注意事項

### 1. CLAUDE.md の内容が現実と乖離

CLAUDE.md は旧 HTML 単体版 (v5.12) の記述のまま。現実は React/Vite アプリ。  
- `index.html` → エントリポイント（変更不要）は合っているが、`data/*.json` 更新手順は古い
- **次セッションで CLAUDE.md を React アプリの実態に合わせて書き直すことを推奨**

### 2. v5.css のテーマがライトのまま

テーマ二重構造（上記参照）。ライト/ダーク混在が視覚的な不統一感を生む。  
解消するには v5.css の CSS 変数を全て tokens.ts 値に寄せる必要がある。

### 3. T4_Correlation / T5_Backtest / T6_History は Phase 対象外

これら 3 タブは今回の Phase 1〜7 の主要対象外。  
InsightCard / DecisionCard / tokens.ts 未適用の箇所が残存している可能性あり。

### 4. AppShell は参照コンポーネント（未使用）

`AppShell.tsx` は実装済みだが、実際のエントリポイントからは未呼び出し。  
既存の layout CSS（v5.css の `.app-shell` 相当）がそのまま使われている。  
将来的な完全移行時に activating する想定。

### 5. generateCssVars() / applyTheme() は未呼び出し

tokens.ts にある CSS 変数注入関数は実装済みだが、main.tsx では呼ばれていない。  
v5.css との完全統合タイミングで呼び出す。

---

## 6. 未実装・今後の拡張候補

| 項目 | 優先度 | 概要 |
|---|---|---|
| v5.css → tokens.ts 完全移行 | HIGH | ライト/ダーク混在の解消 |
| CLAUDE.md の実態合わせ | HIGH | React アプリとしての正しい記述に更新 |
| AppShell 本番適用 | MEDIUM | 既存 layout を AppShell で置き換え |
| T4/T5/T6 への InsightCard 適用 | MEDIUM | 3 タブへのコンポーネント統一 |
| generateCssVars() の main.tsx 呼び出し | MEDIUM | CSS 変数注入の有効化 |
| ダークモードトグル | LOW | v5.css と tokens.ts の統合後に実装 |
| Storybook 導入 | LOW | コンポーネントカタログ化 |

---

## 7. 開発コマンド

```bash
# 開発サーバー起動
npm run dev

# 本番ビルド
npm run build

# 型チェック
npx tsc --noEmit
```

---

## 8. 次セッションの開始手順

```
CLAUDE.md / PHASES.md / handover.md を読んでください。
Phase 8 は完了しました。
次にやること候補:
  A. CLAUDE.md を React アプリの実態に合わせて書き直す
  B. v5.css のライトテーマを tokens.ts に統合（ダークテーマ一本化）
  C. T4/T5/T6 への共通コンポーネント適用
  D. AppShell を main.tsx に組み込む
```

---

## 9. Phase 完了記録

| Phase | 状態 | 完了日 | 備考 |
|---|---|---|---|
| Phase 1 | ✅ 完了 | 2026-04-14 | tokens.ts / typography.ts 新規作成 |
| Phase 2 | ✅ 完了 | 2026-04-14 | 13 コンポーネント作成（badges/cards/layout/shared/mobile）|
| Phase 3 | ✅ 完了 | 2026-04-14 | T1_Decision ダッシュボード再構成 |
| Phase 4 | ✅ 完了 | 2026-04-14 | T2_Holdings 個別株タブ再構成 |
| Phase 5 | ✅ 完了 | 2026-04-14 | T7_Trust 投信タブ再構成（最大852行）|
| Phase 6 | ✅ 完了 | 2026-04-14 | モバイル最適化・useIsMobile フック |
| Phase 7 | ✅ 完了 | 2026-04-14 | v5.css 色変数化・T3 InsightCard 追加 |
| Phase 8 | ✅ 完了 | 2026-04-15 | handover.md 完成 |
