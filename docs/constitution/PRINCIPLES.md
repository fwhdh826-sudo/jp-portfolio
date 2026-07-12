# Capital Allocation OS v13.3 — PRINCIPLES

**Version**: v13.3
**Last Updated**: 2026-04-26

> このファイルは OS の憲法。実装者（Claude Code / 人間）は毎セッション参照すること。

---

## 1. 確定方針 12項目（v13.3 の憲法）

### v13.2 から継承（8項目）

| # | 方針 | 内容 |
| :-: | :-- | :-- |
| A | Tier A 結合方式 | ハイブリッド（ハード門番 + ソフトペナルティ） |
| B | 配分v3.0 × Frontier | v3.0 は初期値、Frontier が再計算 |
| C | 7代理委員会 | Frontier 結果を監査・承認 |
| D | UI 工程 | ハイブリッド（Design + Code） |
| E | repo 戦略 | 構造先行→選択移植、v9-archive 永久保存 |
| F | ブランド | Capital Allocation OS（CA） |
| G | スコア軸 | 6軸（バリュー/クオリティ/グロース/安全性/モメンタム/還元力） |
| H | Design Step A | Phase 1 最初に実施 |

### v13.3 新規確定（4項目）

| # | 方針 | 内容 |
| :-: | :-- | :-- |
| I | レジーム判定 | Hybrid 3層（Rule + HMM + LLM） |
| J | 短期/中長期分離 | 完全並行レイヤー（独立計算→統合） |
| K | 戦略並行運用 | Multi-Strategy Engine（4戦略合議制） |
| L | ニュースソース | 8ソース統合（Bloomberg/Reuters/Yahoo/MINKABU/四季報/TDnet/EDINET/JPX） |

---

## 2. 優先順位ヒエラルキー

```
Safety
  > Reproducibility
    > Execution Reality
      > Decision Quality
        > UX
```

---

## 3. Tier A — Hard Constraints（T1-T4）

違反時は**強制修正**。例外なし（T3のみ Capitulation Signal 例外あり）。

| ID | ルール | トリガー | アクション |
| :-- | :-- | :-- | :-- |
| T1 | ストップロス -40% | 個別ポジション含み損 ≤ -40% | 強制売却 |
| T2 | セクター上限 35% | セクター比率 > 35% | 35%に圧縮 |
| T3 | PF DD-30% → SAFE_MODE | PF 全体ドローダウン ≤ -30% | 全新規買い凍結（Capitulation Signal のみ例外） |
| T4 | L3 キャピチュレーション | VIX>40 AND 日経3日連続 -2%以上 | リスク資産 50% 縮小 |

---

## 4. Tier A — Soft Constraints（T5-T8 + v3.0乖離）

違反時はペナルティ項として Frontier 最適化に組み込む。

| ID | ルール | 警告閾値 | 深刻閾値 | ペナルティ係数（警告/深刻） |
| :-- | :-- | :-: | :-: | :-: |
| T5 | Core 55% 目標 | < 50% | < 45% | 5.0 / 50.0 |
| T6 | レバレッジ製品 上限 20% | > 20% | > 25% | 10.0 / 100.0 |
| T7 | 単一銘柄集中 上限 8% | > 8% | > 12% | 8.0 / 80.0 |
| T8 | 現金比率 下限 7.7% | < 7.7% | < 5% | 6.0 / 60.0 |
| T_v3 | v3.0 配分との乖離 | — | — | 2.0（乖離量に比例） |

---

## 5. Capitulation Signal（4条件 AND）

4条件**全て**が同時に成立した時に発動。SAFE_MODE 中の唯一の例外的投入シグナル。

```python
CAPITULATION_CONDITIONS = {
    "vix_spike":     "vix > 35",
    "panic_selling": "nikkei_5d_return < -0.08",
    "oversold":      "nikkei_rsi_14 < 30",
    "volume_spike":  "nikkei_volume > avg_60d * 2"
}
# 4条件全て → alert_level = "OPPORTUNITY"、戦略的現金400万投入
# 3条件   → alert_level = "WATCH"
```

---

## 6. アラートレベル

| レベル | 条件 | アクション |
| :-- | :-- | :-- |
| L1 | PF DD ≤ -10% または VIX > 30 | 新規ポジションサイズ 50% 縮小 |
| L2 | PF DD ≤ -20% | Tactical 50% 縮小、現金15%確保 |
| L3 | PF DD ≤ -30% | 全リスク資産 50% 縮小、新規買い48時間凍結 |
| OPPORTUNITY | Capitulation Signal 4条件 | 戦略的現金400万投入 |

---

## 7. 実装禁止事項

```
❌ ハードコード（数値・文字列）→ tokens.ts 経由必須
❌ 個別株と投信の混在（UI・型・ストア・スコア関数）
❌ レジーム別重みを scoring 内に直書き → Layer 6 経由
❌ 4戦略の相互参照 → 独立計算のみ
❌ 金融ロジックの新規創作（設計書に記載なき計算式）
❌ 並行 Card 実装
❌ スマホ横スクロール放置
❌ Opus 確認なしの Tier A / Regime / Rebalance ロジック変更
❌ テストなしの本番反映
❌ handover.md の上書き（追記のみ）
```

---

## 8. 設計書 SSOT 参照

| ドキュメント | 用途 |
| :-- | :-- |
| `docs/v13.3/05_v13.3_master_plan.md` | 全体設計の唯一の真実 |
| `docs/v13.3/06_v13.3_claude_code_instructions.md` | 120 Card 実装指示書 |
| `docs/v13.3/07_v13.3_spec.md` | 詳細仕様（計算式・JSON Schema・UI） |
| `docs/v13.3/09_3layer_workflow_final.md` | モデル役割分担最終版 |
| `docs/constitution/REGIME.md` | レジーム判定憲法 |
| `docs/constitution/ALLOCATION_v3.md` | 配分構造憲法 |
