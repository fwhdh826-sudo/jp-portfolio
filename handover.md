# handover.md — JP株 Decision OS v8.1
# 更新: 2026-04-10

## 1. 現状サマリー

| 項目 | 内容 |
|------|------|
| バージョン | v8.1 |
| URL | https://fwhdh826-sudo.github.io/jp-portfolio/ |
| ホスティング | GitHub Pages (workflow build) |
| デプロイ | main push → GitHub Actions → 自動デプロイ |
| データ更新 | 毎平日 8:30 JST (GitHub Actions) |
| リポジトリ | github.com/fwhdh826-sudo/jp-portfolio (Public) |

## 2. アーキテクチャ（実装済み）

```
src/
├── types/index.ts              # 全型定義
├── constants/
│   ├── holdings.ts             # INITIAL_HOLDINGS (16銘柄)
│   ├── trust.ts                # INITIAL_TRUST (18本)
│   └── market.ts               # STATIC_MARKET / SECTOR_GROUPS / RF / INST_WEIGHTS
├── store/
│   ├── useAppStore.ts          # Zustand Single Store (initialize/refreshAllData/importCsv)
│   ├── selectors.ts            # 純粋セレクター関数
│   └── persist.ts              # localStorage TTL7日
├── services/
│   └── loadStaticData.ts       # 並列fetch (market/corr/news/trust)
├── domain/
│   ├── analysis/computeAnalysis.ts   # 全スコアリング + AI討論 + ポートフォリオ指標
│   └── csv/importPortfolioCsv.ts     # ShiftJIS SBI CSV パーサー
└── components/
    ├── StatusBar.tsx            # ヘッダー: PF評価額/日経/レジーム/更新ボタン
    ├── TabNav.tsx               # タブナビゲーション
    └── tabs/
        ├── T1_Decision.tsx     # BUY/HOLD/SELL カード + 理由 + 7軸 + CSV D&D
        ├── T2_Holdings.tsx     # 保有テーブル + PFメトリクス
        ├── T3_Regime.tsx       # レジーム + MA + BOJ + スコア分布
        ├── T4_Correlation.tsx  # ヒートマップ（yfinance実測）
        ├── T5_Backtest.tsx     # 分析サマリー + リスク指標
        ├── T6_History.tsx      # 折りたたみ履歴
        └── T7_Trust.tsx        # 投信18本 ポリシー別
```

## 3. データフロー（実装済み）

```
起動時:
  initialize()
    → restorePortfolio/Trust (localStorage TTL7日)
    → refreshAllData() 並列fetch
    → volatilities をholdingsに反映
    → runFullAnalysis() 全再計算
    → Store一括更新

更新ボタン:
  refreshAllData() → 同上

CSV D&D:
  importCsv(file)
    → importPortfolioCsv() (ShiftJIS対応)
    → holdings更新
    → runFullAnalysis()
    → persistPortfolio()
```

## 4. スコアリング仕様（handover.md v1から変更なし）

```
totalScore =
  fundamentalScore (GS準拠, 0-30) * 0.30 +
  marketScore (TwoSigma準拠, 0-20) * 0.20 +
  technicalScore (MS準拠, 0-20) * 0.20 +
  newsScore (0-15) * 0.15 +
  qualityScore (0-10) * 0.10 -
  riskPenalty (0-15) * 0.15

BUY: totalScore >= 75 AND ev > 0
HOLD: totalScore >= 50
SELL: それ以外
```

## 5. データファイル（public/data/）

| ファイル | 更新方法 | 用途 |
|---------|---------|------|
| `market.json` | GitHub Actions / `update_market.py` | 日経/VIX/テクニカル |
| `correlation.json` | GitHub Actions / `update_correlation.py` | 相関行列 (52週) |
| `news.json` | GitHub Actions / `update_news.py` | ニュース (RSS) |
| `trust_master.json` | 手動 / SBI CSV | 投信 eval/pnlPct/dayPct |
| `holdings.json` | SBI CSV D&D | 保有銘柄評価額 |

## 6. 重要制約

- **partial update禁止**: refreshAllData は全ファイル取得後に一括更新
- **UIから直接fetch禁止**: services/loadStaticData.ts 経由のみ
- **壊れたJSON書き込み禁止**: news_schema.py バリデーション通過のみ
- **静的fallback必須**: データなし → STATIC_MARKET / INITIAL_HOLDINGS で動作継続
- **同じ入力 → 同じ出力**: computeAnalysis は純粋関数

## 7. 次セッションでやること (next_tasks.md 参照)

優先順:
1. GitHub Actions が正常デプロイされているか確認
2. `npm run dev` でローカル動作確認
3. ニュース実動作確認 (`python3 data/update_news.py`)
4. trust_master.json を最新SBI値で手動更新

## 8. バックアップ対象

- `v5_legacy.html` — V5完全バックアップ（gitignore対象、ローカルのみ）
- `public/data/correlation_backup.json` — 前回相関データ

## 9. 動作確認コマンド

```bash
# ローカル確認
npm run dev

# データ手動更新
python3 data/update_correlation.py
python3 data/update_market.py
python3 data/update_news.py
cp data/correlation.json public/data/
cp data/market.json      public/data/

# push → 自動デプロイ
git add public/data/ && git commit -m "update: data" && git push
```
