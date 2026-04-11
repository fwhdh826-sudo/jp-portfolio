# JP株 Decision OS — セッション引き継ぎ書
# バージョン: v9.1 / 作成日: 2026-04-11

---

## 1. 現在の状態

| 項目 | 内容 |
|------|------|
| **バージョン** | v9.1 |
| **作業ブランチ** | v9-dev |
| **本番URL** | https://fwhdh826-sudo.github.io/jp-portfolio/ |
| **リポジトリ** | github.com/fwhdh826-sudo/jp-portfolio（Public） |
| **デプロイ** | GitHub Actions 自動（main push → 約40秒で反映） |
| **データ更新** | GitHub Actions 毎平日 8:30 JST 自動実行 |

---

## 2. 今回実装したコア機能（v9.1）

### 2-1. ゼロベース最適化エンジン
- `src/domain/optimization/zeroBase.ts` を新規追加
- 機能:
  - 理想PF差分の算出
  - 市場モード判定（normal/caution/emergency）
  - 売買提案（BUY/SELL/WAIT）生成
  - 提案に「理由 / 利確 / 損切 / 前提崩れ / 分割執行 / 逆方向判定」を付与

### 2-2. T1 最終結論ダッシュボード
- `src/components/tabs/T1_Decision.tsx` を更新
- 追加:
  - Final Conclusion（結論 / ToDo / リスク警告 / 高確信候補）
  - 7AI討論表記に統一
  - 理想PF差分とノートレード判定を先頭に表示

### 2-3. T2 PF分析タブ再設計
- `src/components/tabs/T2_Holdings.tsx` を更新
- 変更:
  - ゼロベース理想PF比較ビューを追加
  - 制約影響（売却可否、ロック銘柄、上限制約、集中度）を可視化
  - 旧「含み損益ランキング」は削除

### 2-4. T5 売買提案タブ高度化
- `src/components/tabs/T5_Backtest.tsx` を更新
- 変更:
  - Half-Kelly中心から、ゼロベース売買提案中心へ
  - 各提案に売買設計ルールを表示
  - 実行ログ連携を維持

### 2-5. T6 ニュースタブ再編
- `src/components/tabs/T6_History.tsx` を更新
- 変更:
  - ニュース分類を4分割: 市場全体 / 保有銘柄 / 候補銘柄 / 投信関連
  - 各ニュースに以下を表示:
    - 影響方向
    - 重要度
    - 要約
    - なぜ重要か
    - 推奨アクション
- `src/components/TabNav.tsx` の T6 表示を「更新」→「ニュース」に変更

### 2-6. 自己強化アルゴリズム（Phase 8）
- `src/domain/learning/performanceTracker.ts` を新規追加
- `src/types/index.ts` に Learning 型を追加
- `src/store/useAppStore.ts` で再分析のたびに学習更新
- `src/store/persist.ts` で学習状態を localStorage 永続化（TTL 30日）
- `src/components/tabs/T3_Regime.tsx` に可視化カードを追加
  - 予測 vs 実績
  - 判定別精度（BUY/HOLD/SELL）
  - 平均報酬
  - 推奨重み
  - 劣化シグナル

---

## 3. データ層拡充（Phase 1補完）

### 新規スクリプト
- `data/update_flows.py`
  - `margin.json` / `flows.json` 生成・更新
- `data/update_earnings.py`
  - `earnings_calendar.json` 生成・更新

### 既存スクリプト拡張
- `data/update_news.py`
  - `impact`
  - `whyImportant`
  - `recommendation`
  を付与

### Workflow更新
- `.github/workflows/update-data.yml`
  - `update_flows.py`
  - `update_earnings.py`
  を追加
  - `margin / flows / earnings_calendar` を `public/data/` にコピー対象化

---

## 4. 主要アーキテクチャ（v9.1時点）

```
src/
├── domain/
│   ├── analysis/computeAnalysis.ts
│   ├── optimization/idealAllocation.ts
│   ├── optimization/zeroBase.ts        # v9.1 新規
│   ├── learning/performanceTracker.ts  # v9.1 新規
│   └── csv/importPortfolioCsv.ts
├── store/
│   ├── useAppStore.ts
│   ├── selectors.ts
│   └── persist.ts
├── components/
│   ├── StatusBar.tsx
│   ├── TabNav.tsx
│   └── tabs/
│       ├── T1_Decision.tsx
│       ├── T2_Holdings.tsx
│       ├── T3_Regime.tsx
│       ├── T4_Correlation.tsx
│       ├── T5_Backtest.tsx
│       ├── T6_History.tsx
│       └── T7_Trust.tsx
└── types/index.ts


data/
├── update_correlation.py
├── update_market.py
├── update_macro.py
├── update_sq.py
├── update_news.py
├── update_flows.py      # v9.1 新規
├── update_earnings.py   # v9.1 新規
└── *.json
```

---

## 5. 動作確認結果（2026-04-11）

- [x] `npm run build` 成功（TypeScript/Vite エラーなし）
- [x] ゼロベース売買提案ロジックの表示反映（T1/T5）
- [x] ニュース4分類表示反映（T6）
- [x] 学習カード表示反映（T3）
- [x] `python3 data/update_flows.py` 実行成功
- [x] `python3 data/update_earnings.py` 実行成功

---

## 6. 重要制約（継続）

- partial update禁止（タブ間不整合を防止）
- UIから直接fetch禁止（`services/loadStaticData.ts` 経由のみ）
- staticフォールバック必須（JSON欠損時でも動作）
- 壊れたJSON書き込み禁止
- `computeAnalysis()` は純粋関数維持

---

## 7. 未解決・残タスク

### HIGH
1. 本番URLで v9.1 UI 実機確認（iOS Safari 375x812 / Chrome）
2. `trust_master.json` 最新化（SBI実数値へ更新）
3. ニュース実収集テスト（feedparser導入済み前提で `update_news.py`）

### MEDIUM
4. 学習で算出した `suggestedWeights` を実際のスコア計算へ適用する機構（現在は提案表示まで）
5. `earnings_calendar.json` をT6またはT3に直接表示
6. 売買提案履歴のスナップショット永続化強化

### LOW
7. ニュースソース拡張（Reuters/Bloomberg等）
8. 目標株価の外部同期

---

## 8. 運用コマンド

```bash
# 開発
npm run dev

# ビルド確認
npm run build

# データ更新
python3 data/update_correlation.py
python3 data/update_market.py
python3 data/update_macro.py
python3 data/update_sq.py
python3 data/update_flows.py
python3 data/update_earnings.py
python3 data/update_news.py

# 本番確認
open https://fwhdh826-sudo.github.io/jp-portfolio/
```

---

## 9. 次セッション開始手順

```bash
# 1) handover確認
cat handover.md

# 2) タスク確認
cat next_tasks.md

# 3) ローカル起動
npm run dev

# 4) ビルド検証
npm run build
```
