# Capital Allocation OS v13.3 — MISSION

**Version**: v13.3 — Final Integration Edition
**For**: Ryo
**Last Updated**: 2026-04-26

---

## 一行ミッション

> **vs ACWI +1.5%/年、Survival-First、5年で3,900万→6,400万を達成する**

---

## 一行コンセプト

> **市場をマルチソースで読み（News+Macro）、レジームを判定し、6軸+触媒で銘柄を評価し、4戦略並行でリターン源泉を独立化し、Frontier で理想を描き、Tier A ハイブリッドで守り、7代理で監査し、人間が実行する、12層構造の institutional-grade 投資判断OS**

---

## 12層アーキテクチャ サマリー

| # | 層 | 役割 | v13.3 |
| :-: | :-- | :-- | :-- |
| ① | Operation | システム健全性・SAFE_MODE・Watchdog | v13.2継承 |
| ② | Market Intel | マルチソース市場情報（8ニュースソース+Macro） | 強化 |
| ③ | Regime Detect | Hybrid 3層レジーム判定（Rule+HMM+LLM） | **★新規** |
| ④ | Universe | 候補絞込・Sizeセグメント（Large/Mid/Small） | Sizeセグメント追加 |
| ⑤ | Scoring | 6軸スコア + Cross-Axis Signal（aidatalab強化） | 強化 |
| ⑥ | Dynamic Weight | レジーム別動的重み（6軸 × 4戦略 × 時間軸） | **★新規** |
| ⑦ | Multi-Strategy | 4戦略並行エンジン（Aggregator統合） | **★新規** |
| ⑧ | Frontier AI | 既存Frontier AI Index（レジーム別重み適用） | 強化 |
| ⑨ | Tier A Gate | ハイブリッド（Hard門番 + Softペナルティ） | v13.2継承 |
| ⑩ | 7 Agents | AI委員会監査 + Adversarial Self-Check | 強化 |
| ⑪ | Path Rebalance | パス依存リバランス + Scenario Pre-Commitment | **★新規** |
| ⑫ | UI + Human | 10画面 React + Ryo の手動実行（SBI証券） | 強化 |

---

## 投資 KPI

```
[Mission KPI]
vs ACWI 12M ローリング:     +1.5% 目標
Survival 違反率:            < 10%
DD-10%統一リターン:         > +15%（aidatalab検証）

[Risk KPI]
最大DD:                    < -25%
Tier A 違反検知率:          100%
集中度（単一セクター）:      < 35%
現金比率:                  > 7.7%（300万固定）

[Process KPI]
Decision Log 完備率:        100%
Calibration Brier:         < 0.20
Attention Hygiene:         通知/週 < 10件
Trading Frequency:         月 < 10回
```

---

## OS KPI

```
[実装]
Phase 0-15 完了:            100%
pytest 通過:                100%
Lighthouse Mobile:          90+
8ニュースソース稼働:         7+/8

[運用]
Today 画面30秒判断:          可能
Markets 画面30分更新:        維持
Discord 通知:               動作
Regime 判定一致率:           70%+
```

---

## 55機能 内訳

```
カテゴリA: 意思決定エンジン   9機能
カテゴリB: 分析項目の網羅性  10機能
カテゴリC: 機能・アルゴリズム 23機能
カテゴリD: 投信短期売買特化   7機能
カテゴリE: UI機能            11機能
カテゴリF: v13.3 新規        10機能（過去OS復活）
カテゴリG: aidatalab論文統合   5機能
カテゴリH: ニュースソース統合  8機能
────────────────────────────
合計                        55機能
```

---

## 実装期間

- **Phase**: 16
- **Card 数**: 約120
- **期間**: 24-30週間（平日夜1-2h / 週末3-4h）
- **コード規模**: 10万行+
- **JSON 契約数**: 35+ファイル
- **UI 画面数**: 10画面

---

## 最終実行者

> Ryo が SBI証券で手動実行。OSは意思決定支援を行い、最終判断と執行は人間が担う。
