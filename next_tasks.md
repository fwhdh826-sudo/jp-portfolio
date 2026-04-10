# next_tasks.md — V8.3 実装完了後の残タスク

## 優先度 HIGH（次セッション最初に確認）

1. **✅ GitHub Actions デプロイ確認** ← v8.3 commit 9c05a15 push済み
   - commit: 8d200e0 + 9c05a15 
   - 本番: https://fwhdh826-sudo.github.io/jp-portfolio/ 確認可能

2. **本番URL ビジュアル確認** ← 要Chrome/Safari確認（前セッション拡張未接続）
   - https://fwhdh826-sudo.github.io/jp-portfolio/ を開く
   - v8.3 ロゴ表示確認
   - T1タブ: BUY 4件 / SELL 3件表示確認
   - セクター集中度バー：新レイアウト確認

3. **ニュースパイプライン実動作** ← データなし状態で動作確認済み
   - `pip install feedparser` が必要
   - `python3 data/update_news.py` を実行
   - `public/data/news.json` が生成されるか確認
   - ※ 現在: T6タブで「ニュースデータなし」表示

---

## 優先度 MEDIUM

4. **trust_master.json 最新化** ← 手動作業
   - SBI証券から現在の eval/pnlPct/dayPct を確認
   - `public/data/trust_master.json` を手動更新してpush
   - 前回更新: 2026-04-10 確認ずみ

5. **✅ σ実測値確認** ← v8.3で確認済み
   - T2タブで σ が yfinance実測値に更新されている（sigmaSource: 'yfinance'）
   - 例: リクルートHD 0.18→0.462, カプコン 0.16→0.379

6. **CSV取込テスト** ← 仕様確認ずみ（未実施）
   - SBI証券からCSVをDL
   - T5 or T6タブのD&Dゾーンにドロップ
   - 保有額 eval/pnlPct が更新されるか確認
   - 再分析が自動実行されるか確認

---

## 優先度 LOW（将来実装）

7. **バックテスト履歴蓄積**
   - CSV取込ごとにスナップショットを localStorage に保存
   - T5タブで時系列表示

8. **ニュースソース追加**
   - 現状: Yahoo!ファイナンスRSSのみ
   - 追加候補: MINKABU RSS（URLを調査）

9. **信頼度改善**
   - AI討論の7軸スコアを実ファンダメンタルデータで補正
   - 決算発表日カレンダー連携

---

## 完了判定基準

### v8.1 実装済み
- [x] Zustand Single Store
- [x] refreshAllData 全再計算
- [x] CSV取込 → persist → 即時再分析
- [x] news.json スキーマ + バリデーション
- [x] GitHub Pages Actions デプロイ設定

### v8.3 実装済み
- [x] セクター集中度バー （積み上げ横バー）
- [x] EV算出式改善 （σ係数 0.7→0.3）
- [x] BUY候補4件確保 （スコア≥75 && EV>0）
- [x] 全7タブ動作確認（モバイル375×812）

### 保留中（次セッション）
- [ ] 本番URL Chrome/Safari ビジュアル確認
- [ ] ニュース実収集テスト（feedparser導入・update_news.py実行）
- [ ] trust_master.json 最新化（SBI手動確認）
