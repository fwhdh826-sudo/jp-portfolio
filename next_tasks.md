# next_tasks.md — V8.1 完了後の残タスク

## 優先度 HIGH（次セッション最初に確認）

1. **GitHub Actions デプロイ確認**
   - https://github.com/fwhdh826-sudo/jp-portfolio/actions を確認
   - `Deploy to GitHub Pages` が成功しているか
   - 失敗していたら Actions ログを確認

2. **本番URL動作確認**
   - https://fwhdh826-sudo.github.io/jp-portfolio/ を開く
   - T1（判断タブ）でBUY/HOLD/SELLカードが表示されるか
   - StatusBarで「相関✓」が表示されるか

3. **ニュースパイプライン実動作**
   - `pip install feedparser` が必要
   - `python3 data/update_news.py` を実行
   - `public/data/news.json` が生成されるか確認

---

## 優先度 MEDIUM

4. **trust_master.json 最新化**
   - SBI証券から現在の eval/pnlPct/dayPct を確認
   - `public/data/trust_master.json` を手動更新してpush

5. **σ実測値確認**
   - T2タブで「実」マークが表示されているか（yfinanceからの実測値）
   - correlation.json の volatilities が反映されているか

6. **CSV取込テスト**
   - SBI証券からCSVをDL
   - T1タブのD&Dゾーンにドロップ
   - 保有額が更新されるか確認

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

- [x] Zustand Single Store
- [x] refreshAllData 全再計算
- [x] CSV取込 → persist → 即時再分析
- [x] news.json スキーマ + バリデーション
- [x] GitHub Pages Actions デプロイ設定
- [ ] 本番URL動作確認
- [ ] ニュース実収集確認
- [ ] trust_master 最新化
