# JP株OS — プロジェクト規約

## バージョン管理
- 現行バージョン: v5.12 Final（HTML単体）
- Claude Code連携後: v6.0（Python連携版）
- HTMLは変更禁止。変更が必要な場合は必ず事前確認。

## データフロー
```
SBI証券CSV → parse_sbi.py → data/holdings.json → index.html (loadHoldingsJSON)
yfinance   → update_correlation.py → data/correlation.json → index.html (getCorr)
cron毎朝8:30 → 自動実行 → 常に最新データ
```

## 並列エージェント構成
| Agent | 担当 | 優先度 | 依存 |
|-------|------|--------|------|
| Agent A | 相関計算 (update_correlation.py) | P0 | なし |
| Agent B | CSVパース (parse_sbi.py) | P0 | なし |
| Agent C | HTML連携確認 (index.html) | P1 | A,B完了後 |

## モード運用
1. Plan Mode → 設計確認（実装なし）
2. 人間が承認
3. Auto Mode → 実装実行
4. 検証・テスト
5. 次タスクへ

## Definition of Done（全タスク完了条件）
- [ ] T6更新タブ → 「外部データ: 1ファイル ロード済（Claude Code連携中）」
- [ ] T3分析タブ → Sharpe比率が静的値（~0.8）から変化
- [ ] ブラウザコンソール（F12）にエラーなし
- [ ] data/correlation.json の last_updated が本日の日付
- [ ] T2 PFタブ → 保有銘柄の評価額が最新値（CSVパース後）
- [ ] 再起動後もデータが維持される（localStorage永続化）
- [ ] cron設定後、翌朝8:30に自動更新確認
- [ ] SBI CSVを変更して再実行 → 保有データが即時反映

## スコア目標
| 項目 | HTML単体 | Claude Code連携後 |
|------|----------|------------------|
| 専門家スコア | 110点 | 113点 |
| 相関行列 | セクター別静的値 | yfinance実測値（52週）|
| Sharpe計算 | 近似値 | 実測σ使用 |
| 保有データ | 手動CSV D&D | 自動パース→JSON |
| 更新頻度 | 手動 | 毎朝8:30 自動 |

## 対象銘柄（16銘柄）
6098.T リクルートHD / 8306.T 三菱UFJ / 9697.T カプコン / 4661.T OLC
8593.T 三菱HC / 4755.T 楽天G / 5711.T 三菱マテリアル / 1605.T INPEX
5016.T JX金属 / 8058.T 三菱商事 / 9418.T U-NEXT / 1928.T 積水ハウス
7011.T 三菱重工 / 7974.T 任天堂 / 9433.T KDDI / 7012.T 川崎重工
