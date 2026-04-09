
---

## next_tasks.md

```md
# next_tasks.md

## 1. 最優先タスク
1. Zustand単一Storeへ全面統合
2. refreshAllData の全再計算化
3. CSV取込 → persist → 即時再分析の接続
4. staticモード残存コード削除
5. ニュース無限ローディング解消

---

## 2. データ層タスク
- `/data/market.json` 読込処理の統一
- `/data/correlation.json` 読込処理の統一
- `/data/news.json` 読込処理の追加
- JSON schema検証導入
- 古いJSONと新しいJSONの混在防止

---

## 3. Zustand実装タスク
- `src/store/useAppStore.ts` 作成
- `src/store/selectors.ts` 作成
- `src/store/persist.ts` 作成
- `refreshAllData()` 実装
- `importPortfolioCsv()` 実装
- `restorePersistedPortfolio()` 実装
- `runFullAnalysis()` 実装

---

## 4. 分析ロジック実装タスク
- `computeAnalysis.ts` 作成
- fundamentalScore 実装
- marketScore 実装
- technicalScore 実装
- newsScore 実装
- qualityScore 実装
- riskPenalty 実装
- totalScore 判定実装
- EV算出実装
- σ算出実装

---

## 5. AI討論実装タスク
- `runAIDebate.ts` 作成
- 5エージェント固定化
- debateScore 実装
- confidence 実装
- sevenAxis 出力実装
- finalView 連動確認

---

## 6. ニュース収集実装タスク
- `data/update_news.py` 作成
- `scripts/news_sources.py`
- `scripts/news_normalizer.py`
- `scripts/news_deduper.py`
- `scripts/news_ticker_mapper.py`
- `scripts/news_sentiment.py`
- `scripts/news_schema.py`

### ニュース要件
- ソース:
  - Bloomberg
  - Reuters
  - Yahoo!ファイナンス
  - MINKABU
  - 会社四季報オンライン
- marketNews / stockNews 分離
- 重複除去
- sentiment付与
- sourceStatus管理
- schema validation
- 壊れたJSONは保存禁止

---

## 7. UIタスク
- Decision UIを最上位に再配置
- BUY / SELL / HOLD カード化
- 理由3行表示
- 現在価格 / 目標価格 / EV 表示
- confidence 表示
- ステータス色分け実装
- 横スクロール除去
- 不要機能削除

---

## 8. タブ別タスク
### T3
- レジーム表示
- 精度推移
- 重み推移

### T5
- バックテスト表示
- BUY件数 / 勝率
- SELL件数 / 精度
- HOLD件数
- 平均リターン
- 最大DD
- サンプル数
- 最終更新日

### T6
- 折りたたみ履歴

### T7
- trust_master.json連動確認
- `updateTrustMaster → renderTrustOS → renderTrustSignals`

---

## 9. GitHub Actionsタスク
- market更新ワークフロー確認
- correlation更新ワークフロー確認
- news生成ワークフロー追加
- 失敗時の旧JSON維持
- ログ出力強化

---

## 10. QAタスク
- データ整合性テスト
- 更新処理テスト
- 非同期処理テスト
- UI表示テスト
- 分析結果テスト
- エッジケーステスト
- 無限ローディング再発防止確認

---

## 11. 完了後に必ずやること
1. 動作確認
2. Git tag作成
3. version更新
4. 変更ファイル一覧作成
5. handover.md更新
6. next_tasks.md更新
7. 残課題整理

---

## 12. 現時点の完了判定基準
- Store統合完了
- 更新で全再計算
- CSV復元成功
- news.json反映成功
- AI討論反映成功
- UIが空でない
- タブ不整合なし
- GitHub Pagesで正常表示
