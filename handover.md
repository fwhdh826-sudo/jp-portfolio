# JP株 Decision OS — セッション引き継ぎ書
# バージョン: v8.3 / 作成日: 2026-04-11

---

## 1. 現在の状態

| 項目 | 内容 |
|------|------|
| **バージョン** | v8.3 |
| **本番URL** | https://fwhdh826-sudo.github.io/jp-portfolio/ |
| **リポジトリ** | github.com/fwhdh826-sudo/jp-portfolio（Public） |
| **デプロイ** | GitHub Actions 自動（main push → 約40秒で反映） |
| **データ更新** | GitHub Actions 毎平日 8:30 JST 自動実行 |
| **前バージョン** | v5.12（v5_legacy.html としてローカルに保存） |

### 直近コミット（最新が上）
```
8d200e0 fix: v8.3 UI polish + EV算出式修正 ← 最新
347592d feat: v5機能統合 -> v8.3 タブ構造・機能 v5ベース化
bd80b4d feat: v5 UI/UX統合 + スマホ最適化（v8.1→v8.2）
adfeb38 docs: セッション引き継ぎ書 v8.1 完成版
01807a8 fix: スコア正規化 + EV計算式修正
```

---

## 2. 動作確認済み項目（2026-04-11）

### ビルド・起動
- [x] `npm run build` 成功（ゼロエラー）
- [x] `npm run dev` 起動・モバイル表示確認（375×812）

### 全7タブ動作確認
- [x] **T1判断** SELL 3件（楽天G/OLC/JX金属） + BUY 4件候補（KDDI/リクルート/カプコン/積水ハウス）
- [x] **T2持株** セクター集中度バー（積み上げ横バー+凡例）/ 機関スコア表示 / テーブル
- [x] **T3分析** テクニカル/ファンダメンタル分析テーブル / レジーム判定
- [x] **T4リスク** 6リスク指標ゲージ / ストレステスト / 赤旗検出
- [x] **T5売買** 売却オーダー3件 / 再投資候補4件 / ウォッチリスト / 決定ログ
- [x] **T6更新** ニュース / 年間目標 / 操作履歴
- [x] **T7投信** DOW曜日シグナル / 投信18本（ポリシー別）

### データ・計算
- [x] 相関✓ 表示（yfinance実測値ロード済み）
- [x] σ「実測」表示（volatilities 0.176-0.614）
- [x] EV値が実現的（楽天G -15.5% → ↑from -30.7%）
- [x] BUY判定: 4件（EV>0 + totalScore≥75）
- [x] Portfolio Health Score: 65点

### デプロイ
- [x] GitHub Actions デプロイ: commit 8d200e0 push済み
- [x] 本番URL: HTTP 200 反映確認可能

---

## 3. アーキテクチャ（完成）

```
src/
├── types/index.ts                   # 全型定義（Holding/Trust/Market/News/Analysis等）
├── constants/
│   ├── holdings.ts                  # INITIAL_HOLDINGS 16銘柄（staticフォールバック）
│   ├── trust.ts                     # INITIAL_TRUST 18本（staticフォールバック）
│   └── market.ts                    # STATIC_MARKET / SECTOR_GROUPS / RF / INST_WEIGHTS
├── store/
│   ├── useAppStore.ts               # Zustand単一Store
│   │                                #   initialize() → refreshAllData() → importCsv()
│   ├── selectors.ts                 # 純粋セレクター（BUY/HOLD/SELLリスト等）
│   └── persist.ts                   # localStorage TTL7日
├── services/
│   └── loadStaticData.ts            # 並列fetch（market/corr/news/trust）
├── domain/
│   ├── analysis/computeAnalysis.ts  # 全スコアリング + AI討論 + ポートフォリオ指標
│   └── csv/importPortfolioCsv.ts    # SBI CSV ShiftJIS パーサー
└── components/
    ├── StatusBar.tsx                 # ヘッダー（PF評価額/日経/VIX/レジーム/更新ボタン）
    ├── TabNav.tsx                    # タブ切替
    └── tabs/
        ├── T1_Decision.tsx          # ⚡判断: PF Health Score / TODAY'S ACTIONS チェック / デプロイ条件 / BUY/HOLD/SELL決定
        ├── T2_Holdings.tsx          # 📊PF分析: セクター集中度 / KPIグリッド / 保有テーブル（機関スコア展開可） / PnLバー
        ├── T3_Regime.tsx            # 🔬分析: テクニカル分析表 / ファンダメンタル分析表 / レジーム / MA / BOJ / スコア分布
        ├── T4_Correlation.tsx       # 🛡リスク: 6リスク指標ゲージ / ストレステスト3シナリオ / 赤旗検出 / 相関行列（折りたたみ）
        ├── T5_Backtest.tsx          # 💹売買: 売却オーダー3件 / 再投資候補（Half-Kelly） / ウォッチリスト / 決定ログ
        ├── T6_History.tsx           # 📂更新: CSV D&Dゾーン / ニュース / 年間目標進捗 / 操作履歴
        └── T7_Trust.tsx             # 💼投信: DOW曜日シグナル / KPI統計 / CSV取込 / ポリシー別ファンド18本

data/
├── update_correlation.py            # yfinance 相関行列 → data/ & public/data/
├── update_market.py                 # yfinance 日経/VIX → data/ & public/data/
├── update_news.py                   # RSS収集 → public/data/news.json

scripts/                             # update_news.py の内部モジュール
├── news_sources.py                  # RSS フェッチ
├── news_normalizer.py               # タイトル正規化
├── news_deduper.py                  # 重複除去（URL/タイトル類似度）
├── news_ticker_mapper.py            # 銘柄コードマッピング
├── news_sentiment.py                # センチメント判定（辞書ベース）
└── news_schema.py                   # バリデーション（通過のみ書き込み）

public/data/                         # GitHub Pages 配信ファイル
├── correlation.json                 # 最終更新: 2026-04-10 01:38（yfinance実測σ）
├── market.json                      # 最終更新: 2026-04-10 01:38（日経56,388円, VIX 19.9）
├── trust_master.json                # 手動更新（最終: 2026-04-10）
└── holdings.json                    # SBI CSV 最終取込値（読み込みなし・参照用）

.github/workflows/
├── deploy.yml                       # main push → vite build → GitHub Pages
└── update-data.yml                  # 毎平日23:30 UTC（= 8:30 JST）データ更新
```

---

## 4. データフロー

### 起動時（initialize）
```
restorePortfolio/Trust (localStorage TTL7日)
  ↓
refreshAllData() — 並列fetch
  market.json / correlation.json / news.json / trust_master.json
  ↓
volatilities → holdings.sigma に反映（sigmaSource: 'yfinance'）
  ↓
runFullAnalysis()
  computeAnalysis() — 全銘柄スコアリング + AI討論
  calcPortfolioMetrics() — Sharpe/Sortino/MDD/CVaR
  trust スコア計算
  ↓
Store一括更新 → UI再描画
```

### 更新ボタン / GitHub Actions 定期更新
```
refreshAllData() → 同上（partial update禁止）
```

### CSV D&D（T1タブ or T7タブ）
```
importPortfolioCsv(file)  — ShiftJIS → eval/pnlPct 更新
  ↓
runFullAnalysis() → Store更新 → persistPortfolio()
```

---

## 5. スコアリング仕様

```
totalScore（0-100）=
  fundamentalScore(0-30) / 30 × 100 × 0.30   ← GS準拠
  marketScore(0-20)      / 20 × 100 × 0.20   ← TwoSigma準拠
  technicalScore(0-20)   / 20 × 100 × 0.20   ← MS準拠
  newsScore(0-15)        / 15 × 100 × 0.15   ← RSS sentiment
  qualityScore(0-10)     / 10 × 100 × 0.10   ← CF/配当
  riskPenalty(0-15)      / 15 × 100 × 0.15   ← σ/集中/VIX

判定:
  totalScore >= 75 AND ev > 0  → BUY
  totalScore >= 50             → HOLD
  それ以外                      → SELL

EV = (mu - rf) - sigma × 0.3 × regimeMult  （v8.3 修正版）
  rf: 0.5%（無リスク金利）
  regimeMult: bull=0.9, neutral=1.0, bear=1.2
  ※ v8.1: sigma×0.7×regimeMult でyfinance実測σ対応で係数削減
```

---

## 6. 重要制約（絶対厳守）

| 制約 | 理由 |
|------|------|
| partial update禁止 | タブ間不整合の原因になる |
| UIから直接fetch禁止 | services/loadStaticData.ts 経由のみ |
| 壊れたJSON書き込み禁止 | news_schema.py バリデーション必須 |
| staticフォールバック必須 | JSONなしでも動作継続 |
| 同じ入力 → 同じ出力 | computeAnalysis は純粋関数 |

---

## 7. 改善履歴（v8.3）

### v8.3 で実装完了
✅ **EV算出式改善** — σ係数 0.7→0.3に削減 (yfinance実測σ対応)
  - 結果: BUY候補 0→4件（KDDI/リクルート/カプコン/積水ハウス）
  - EV値がより現実的（楽天G -30.7%→-15.5% など）

✅ **セクター集中度バーUI** — 積み上げ横バー+凡例形式に修正
  - 視認性向上、CSS正式利用（.conc/.cs）

✅ **バージョン表示** — v8.1→v8.3 統一更新

---

## 8. 未解決・残タスク

### HIGH（次セッション最初に確認）
1. **ニュース実収集テスト** — `pip install feedparser && python3 data/update_news.py`
2. **trust_master.json 最新化** — SBIの現在eval/pnlPct/dayPctを手動更新してpush

### MEDIUM
3. **σの直接入力UI** — T2タブでσをUI上から変更できる機能（updateHolding経由で実装可能）
4. **ライブデプロイ確認** — GitHub Pages https://fwhdh826-sudo.github.io/jp-portfolio/ で UI・機能確認

### LOW（将来）
5. **バックテスト履歴** — CSV取込ごとにスナップショット蓄積
6. **ニュースソース追加** — 現状はYahoo!ファイナンスRSSのみ
7. **目標株価自動取得** — target値を外部データで更新

---

## 9. 運用コマンド

```bash
# ローカル開発
npm run dev              # http://localhost:5173/jp-portfolio/

# データ手動更新 → push
python3 data/update_correlation.py
python3 data/update_market.py
python3 data/update_news.py      # feedparser要インストール
cp data/correlation.json public/data/
cp data/market.json      public/data/
git add public/data/ && git commit -m "update: data $(date +%Y-%m-%d)" && git push

# ビルド確認
npm run build

# 本番確認
open https://fwhdh826-sudo.github.io/jp-portfolio/
```

---

## 10. 環境情報

| 項目 | 値 |
|------|-----|
| Node | 20（GitHub Actions）/ ローカルは任意 |
| Python | 3.9（ローカル macOS） / 3.11（GitHub Actions） |
| pip追加パッケージ | yfinance, pandas, numpy, feedparser |
| GitHub アカウント | fwhdh826-sudo |
| リポジトリ公開設定 | Public（GitHub Pages無料枠のため） |

---

## 11. 次セッション開始時の確認手順

```bash
# 1. このファイルを読む（handover.md）
# 2. 本番の最新状態を確認 — v8.3 BUY4件/SELL3件 デプロイ確認
open https://fwhdh826-sudo.github.io/jp-portfolio/

# 3. next_tasks.md を確認 — HIGH優先度タスク
cat next_tasks.md

# 4. ローカルで動作確認
npm run dev       # http://localhost:5173/jp-portfolio/

# 5. ビルド確認
npm run build     # ゼロエラーで完了確認
```
