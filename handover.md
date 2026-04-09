# JP株 Decision OS — セッション引き継ぎ書
# バージョン: v8.1 / 作成日: 2026-04-10

---

## 1. 現在の状態

| 項目 | 内容 |
|------|------|
| **バージョン** | v8.1 |
| **本番URL** | https://fwhdh826-sudo.github.io/jp-portfolio/ |
| **リポジトリ** | github.com/fwhdh826-sudo/jp-portfolio（Public） |
| **デプロイ** | GitHub Actions 自動（main push → 約40秒で反映） |
| **データ更新** | GitHub Actions 毎平日 8:30 JST 自動実行 |
| **前バージョン** | v5.12（v5_legacy.html としてローカルに保存） |

### 直近コミット（最新が上）
```
01807a8 fix: スコア正規化 + EV計算式修正     ← 最新
e9ae732 docs: handover.md + next_tasks.md 更新
72f849e feat: V8.1 全面再構築（React+Zustand+TS）
0ba23ca init: JP株OS v5.12 GitHub Pages移行
```

---

## 2. 動作確認済み項目（2026-04-10）

- [x] `npm run build` 成功（ゼロエラー）
- [x] `npm run dev` 起動・表示確認
- [x] T1判断タブ: HOLD 13銘柄 / SELL 3銘柄（楽天G・OLC・JX金属）
- [x] 相関✓ 表示（yfinance実測値ロード済み）
- [x] σ「実測」表示（volatilities反映）
- [x] GitHub Actions デプロイ: 全3回 `success`
- [x] 本番URL: HTTP 200

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
        ├── T1_Decision.tsx          # BUY/HOLD/SELL判断カード + CSV D&Dゾーン
        ├── T2_Holdings.tsx          # 保有テーブル + PFメトリクス
        ├── T3_Regime.tsx            # レジーム/MA/BOJ/スコア分布
        ├── T4_Correlation.tsx       # 相関ヒートマップ
        ├── T5_Backtest.tsx          # 分析サマリー + リスク指標
        ├── T6_History.tsx           # 折りたたみ履歴
        └── T7_Trust.tsx             # 投信18本（ポリシー別）

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
├── correlation.json                 # 最終更新: 2026-04-10 01:38
├── market.json                      # 最終更新: 2026-04-10 01:38（日経56,308円）
├── trust_master.json                # 手動更新（最終: 2026-04-10）
└── holdings.json                    # SBI CSV 最終取込値

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

EV = mu - sigma × 0.7 × regimeMult
  regimeMult: bull=1.0, neutral=1.1, bear=1.3
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

## 7. 未解決・残タスク（next_tasks.md 参照）

### HIGH（次セッション最初に確認）
1. **ニュース実収集テスト** — `pip install feedparser && python3 data/update_news.py`
2. **trust_master.json 最新化** — SBIの現在eval/pnlPct/dayPctを手動更新してpush

### MEDIUM
3. **BUYゼロ問題** — 現在EVがマイナスのためBUYなし。`mu` の値を現実的な期待値に更新すれば改善
4. **σの直接入力** — T2タブでσをUI上から変更できる機能（updateHolding経由で実装可能）

### LOW（将来）
5. **バックテスト履歴** — CSV取込ごとにスナップショット蓄積
6. **ニュースソース追加** — 現状はYahoo!ファイナンスRSSのみ
7. **目標株価自動取得** — target値を外部データで更新

---

## 8. 運用コマンド

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

## 9. 環境情報

| 項目 | 値 |
|------|-----|
| Node | 20（GitHub Actions）/ ローカルは任意 |
| Python | 3.9（ローカル macOS） / 3.11（GitHub Actions） |
| pip追加パッケージ | yfinance, pandas, numpy, feedparser |
| GitHub アカウント | fwhdh826-sudo |
| リポジトリ公開設定 | Public（GitHub Pages無料枠のため） |

---

## 10. 次セッション開始時の確認手順

```bash
# 1. このファイルを読む（handover.md）
# 2. 本番の最新状態を確認
open https://fwhdh826-sudo.github.io/jp-portfolio/

# 3. next_tasks.md を確認
cat next_tasks.md

# 4. ローカルで動作確認
npm run dev
```
