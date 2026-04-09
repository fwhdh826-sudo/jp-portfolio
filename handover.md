# handover.md

## 1. プロジェクト概要
- 名称: 投資分析OS / Decision OS
- 現行ベース: V5
- 目標版: V8.1
- 目的:
  - 日本株ポートフォリオの意思決定OS化
  - BUY / SELL / HOLD を再現可能ロジックで出す
  - データ整合性最優先
  - GitHub Pages上で静的運用

---

## 2. 運用前提
- Hosting: GitHub Pages
- URL: https://fwhdh826-sudo.github.io/jp-portfolio/
- Netlify: 使用禁止
- 更新方式: GitHub Actions
- 定期更新: 毎平日 8:30 JST
- データ配置:
  - `/data/market.json`
  - `/data/correlation.json`
  - `/data/news.json`
  - `/data/trust_master.json`

---

## 3. 現状の重要制約
- フロントから外部ニュース/APIへ直接fetchしない
- UIから直接fetchしない（refresh actionのみ可）
- partial update禁止
- タブごとの独自state禁止
- mock依存禁止（fallback以外）
- 無限loading禁止
- 壊れたJSON出力禁止
- 同じ入力 → 同じ出力の再現性必須

---

## 4. 現在の主要問題
- データ更新不整合
- staticモード残存
- ニュース無限ローディング
- CSV連動不備
- σ / EV が不正
- UIが空表示
- タブ間不整合
- 更新日時未更新
- バージョン不整合

---

## 5. 目指す設計

### Single Source of Truth
- Zustand単一Storeへ統合
- 全タブはStore参照のみ
- 再描画はselector/subscriptionベース
- business logicはstore/domain/servicesへ集約

### グローバル状態
- market
- correlation
- portfolio
- trust
- news
- analysis
- ai
- indicators
  - sigma
  - EV
- system
  - version = V8.1
  - status = idle / loading / success / error
  - lastUpdated
  - csvLastImportedAt
  - analysisLastRunAt
  - error

---

## 6. データフロー

### 起動時
1. static JSON読込
2. normalize
3. computeAnalysis
4. runAIDebate
5. Store更新
6. renderAll

### 更新時
1. `refreshAllData()`
2. `/data/market.json` 読込
3. `/data/correlation.json` 読込
4. `/data/news.json` 読込
5. normalize
6. computeAnalysis
7. runAIDebate
8. Store一括更新
9. status更新
10. UI再描画

### CSV取込時
1. parse
2. validate
3. normalize
4. persist
5. runFullAnalysis
6. UI即時反映

---

## 7. 永続化

### portfolio
- localStorage
- TTL 7日

### trust
- `trust_master.json`
- 手動更新
- `eval` / `pnlPct` / `dayPct` を手動反映

---

## 8. Universe
- 25銘柄固定
- 保有有無に依存しないゼロベース評価
- 保有銘柄とは別管理
- ticker / 社名 / 略称 / 英語表記を持てる構造が望ましい

---

## 9. スコアリング仕様

### 総合スコア
```ts
totalScore =
  fundamentalScore * 0.30 +
  marketScore * 0.20 +
  technicalScore * 0.20 +
  newsScore * 0.15 +
  qualityScore * 0.10 -
  riskPenalty * 0.15
判断閾値
totalScore >= 75 かつ EV > 0 → BUY
totalScore >= 50 かつ EVが軽微マイナス以内 → HOLD
それ以外 → SELL
EV
EV = expectedUpside - expectedDownside
expectedUpside = targetPrice / currentPrice - 1
expectedDownside = downsideVolatility * regimeRiskMultiplier
指標ルール
σは実データから計算
EVはフィルタ後銘柄のみ
データ不足時は計算しない
10. 分析要素
fundamental
売上成長率
営業利益成長率
EPS成長率
ガイダンス修正
営業利益率
ROE / ROIC
自己資本比率
market
日経平均
TOPIX
金利
USD/JPY
セクター相対強度
レジーム
technical
25日移動平均乖離
75日移動平均乖離
RSI
モメンタム
出来高変化
ブレイク状況
news
sentiment
importance
recency
quality
財務安定性
シグナル再現性
決算一貫性
riskPenalty
ボラ急拡大
悪材料集中
イベントリスク
流動性不足
地合い悪化
11. AI討論仕様
5エージェント固定
Fundamental Bull
Fundamental Bear
Macro
Technical / Flow
Risk Manager
出力
bullPoints
bearPoints
debateScore
confidence
finalView
sevenAxis
growth
valuation
momentum
macro
quality
risk
news
confidence
agent score varianceが小さいほど高い
12. ニュース仕様
ソース
Bloomberg
Reuters
Yahoo!ファイナンス
MINKABU
会社四季報オンライン
取得方法
GitHub Actionsで収集
/data/news.json を生成
フロントは news.json を読むだけ
news.json要件
updatedAt
sourceStatus
marketNews
stockNews
meta
totalCount
marketCount
stockCount
duplicateRemoved
1記事の主要項目
id
source
title
summary
url
publishedAt
sentiment
sentimentScore
importance
tags
tickers
重複除去
URL一致
タイトル一致
正規化タイトル一致
ticker + 近接時刻 + 類似タイトル
ソース優先順位
Reuters
Bloomberg
会社四季報オンライン
Yahoo!ファイナンス
MINKABU
ニュース用途
スコア補正
リスク検知
AI討論コメント
判断理由生成
13. UI方針
削除対象
スコアバー
更新タブ
PC/モバイル切替
横スクロール
価格アラート
意思決定ログ
バイアス分析
個別AI分析ボタン
重要表示順
BUY / SELL / HOLD
理由3行
現在価格 / 目標価格 / EV
confidence
補助情報
詳細分析
ステータス
loading: 黄
success: 青
error: 赤
14. タブ構成
T3
レジーム
精度推移
重み推移
T5
バックテスト
BUY件数
BUY勝率
SELL件数
SELL精度
HOLD件数
平均リターン
最大DD
サンプル数
最終更新日
T6
折りたたみ履歴
T7
投信
updateTrustMaster → renderTrustOS → renderTrustSignals
15. 必須実装ファイル
store
src/store/useAppStore.ts
src/store/selectors.ts
src/store/persist.ts
domain
src/domain/analysis/computeAnalysis.ts
src/domain/ai/runAIDebate.ts
src/domain/csv/importPortfolioCsv.ts
service
src/services/loadStaticData.ts
news生成
data/update_news.py
scripts/news_sources.py
scripts/news_normalizer.py
scripts/news_deduper.py
scripts/news_ticker_mapper.py
scripts/news_sentiment.py
scripts/news_schema.py
その他
scoring constants
AI engine definitions
news型定義
GitHub Actions YAML
QA test cases
16. QA観点
データ整合性
更新処理
非同期処理
UI表示
分析結果
エッジケース
バグ時
原因特定
修正コード
再テスト
17. 完成条件
Store-only data flow
タブ不整合ゼロ
更新で全再計算
GitHub Pagesで完全動作
CSV復元OK
news.json生成/反映OK
AI討論最新化
バックテスト表示
モバイル崩れなし
同じ入力で同じ結果
18. 大幅アップデート後の運用
必須
Git tag作成
version更新
変更サマリ作成
バックアップ対象を明記
バックアップ対象
Zustand store
scoring constants
AI debate engine
JSON schema
GitHub Actions
universe definition
CSV parser
trust handling logic
19. 次セッション用に必ず残すもの
handover.md 更新版
next_tasks.md 更新版
未解決課題
変更されたファイル一覧
バージョン番号
動作確認結果
20. Claude Codeへの最重要メッセージ

これはダッシュボードではない。
再現可能な投資判断エンジンである。

要求
推測しない
UIだけ作らない
状態を分散させない
壊れた更新をしない
同じ入力なら同じ出力を返すこと