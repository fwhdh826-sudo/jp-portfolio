# next_tasks.md — v9.1 実装後の残タスク

## 優先度 HIGH（次セッション最初に確認）

1. **本番URL v9.1 反映確認（必須）**
   - https://fwhdh826-sudo.github.io/jp-portfolio/
   - 確認ポイント:
     - T1: Final Conclusion / ToDo / リスク警告
     - T2: ゼロベース理想PF比較
     - T5: 売買提案の利確/損切/前提崩れ表示
     - T6: 4分類ニュース（市場/保有/候補/投信）
     - T3: 自己強化アルゴリズムカード

2. **trust_master.json 最新化（手動）**
   - SBI証券の最新 eval / pnlPct / dayPct を反映
   - `public/data/trust_master.json` を更新してpush

3. **ニュース実収集テスト**
   - `python3 data/update_news.py`
   - `data/news.json` と `public/data/news.json` の生成確認
   - T6で `impact/importance/recommendation` 表示確認

---

## 優先度 MEDIUM

4. **学習重みの本適用**
   - 現状: `performanceTracker.ts` で提案重みを算出して表示
   - 次: `computeAnalysis.ts` で実際に重みを可変適用

5. **決算カレンダーUI接続**
   - `data/earnings_calendar.json` を T3/T6 に表示
   - 決算前警戒表示（前日/当日）を追加

6. **売買提案履歴の強化**
   - 日次スナップショット保存
   - 提案と実績の比較表示

---

## 優先度 LOW

7. **ニュースソース拡張**
   - Yahoo!/NHK/みんかぶ 以外のソース追加

8. **目標株価自動更新**
   - 外部データ連携で `target` 更新

9. **戦術モジュール精緻化**
   - Nikkei VI / SQ / 短期指標の統合判定を微調整

---

## 完了判定基準（v9.1）

- [x] ゼロベース売買提案エンジン
- [x] T1 最終結論カード
- [x] T2 理想PF比較ビュー
- [x] T5 売買提案詳細（利確/損切/前提崩れ）
- [x] T6 ニュース4分類 + 意思決定支援表示
- [x] 学習モジュール（prediction vs actual）
- [x] `update_flows.py` / `update_earnings.py` 追加
- [x] `npm run build` 成功

### 保留中
- [ ] 本番URLでの最終UI確認
- [ ] trust_master.json 手動最新化
- [ ] 学習重みの実スコア適用
