# Capital Allocation OS v13.3 — CLAUDE.md
# Claude Code への指示書（毎セッション最初に読むこと）

**Version**: v13.3
**Last Updated**: 2026-04-26

---

## 0. あなたは誰か

あなたは **Capital Allocation OS v13.3** の実装担当 Claude Code です。
Ryo の個人投資判断OSを、institutional-grade の水準で実装することが使命です。

---

## 1. 毎セッション 必読ファイル（この順番で読む）

```
1. docs/constitution/CLAUDE.md      ← このファイル（セッション開始時）
2. docs/constitution/MISSION.md     ← ミッション・KPI
3. docs/constitution/PRINCIPLES.md  ← 確定方針・Tier A・禁止事項
4. docs/constitution/REGIME.md      ← レジーム判定憲法
5. handover.md                      ← 最新の進捗・次 Card ヒント
```

補足参照（必要に応じて）:
```
docs/constitution/ALLOCATION_v3.md
docs/constitution/CLAUDE_DESIGN_BRIEF.md
docs/v13.3/05_v13.3_master_plan.md   ← 全体設計 SSOT
docs/v13.3/06_v13.3_claude_code_instructions.md  ← Card 詳細
docs/v13.3/07_v13.3_spec.md          ← 計算式・JSON Schema・UI仕様
docs/v13.3/09_3layer_workflow_final.md ← モデル役割分担
```

---

## 2. 絶対原則（10項目）

```
1. Safety > Reproducibility > Execution Reality > Decision Quality > UX
2. CLAUDE.md / MISSION.md / PRINCIPLES.md / ALLOCATION_v3.md / REGIME.md を毎セッション読む
3. 1 Card = 1 Session、並行禁止
4. 80% で次へ、完璧主義禁止
5. ハードコード禁止、tokens.ts 経由
6. 個別株=青系、投信=紫系、UI で混在禁止
7. スマホ優先、縦1カラム破綻禁止
8. 結論先出し、4ブロック分析（結論→根拠→リスク→行動）
9. レジーム別重みは Layer 6 経由、scoring 内に直書き禁止
10. 4戦略並行は独立計算、相互参照禁止
```

---

## 3. Card 完了条件（毎 Card 必須）

```
□ 実装完了（DONE Checks 全て ✅）
□ pytest または npm test 通過
□ handover.md に追記（上書き禁止）
□ git commit（メッセージ: "feat: Card X-Y — ...")
□ git push origin v13.3-dev
□ 「Card X-Y 完了」を Ryo に報告
```

---

## 4. モデル分担表

| モデル | 担当タスク | エスカレーション条件 |
| :-- | :-- | :-- |
| Qwen3-Coder 30B | UI骨格・TSX・JSON・types・RSS写経 | — |
| Qwen3.6-27B | ローカルレビュー・型整理・テスト観点 | — |
| Gemma 27B/31B | README・handover・UI文言・教育コンテンツ | — |
| Qwen 14B Coder | 小修正・高速回転 | — |
| **Sonnet 4.6** | 統合・型エラー修正・Zustand整合 | 5ファイル超 / 型変更 / build 破壊 / API 契約変更 |
| **Opus 4.7** | 金融ロジック判定・P0 確認のみ | 金融ロジック変更 / 重み変更 / Tier A 変更 / Go-No-Go |

---

## 5. Opus 4.7 へのエスカレーション（必須）

以下の変更は**必ず** Opus 4.7 に確認を取ること:

```
- Tier A Hard / Soft ロジック変更
- SAFE_MODE 設計変更
- Regime Orchestrator のロジック変更
- 6軸・Cross-Axis 重みの変更
- Dynamic Weight Engine の変更
- Multi-Strategy Aggregator の変更
- Frontier 期待リターン / 共分散 / Optimizer の変更
- Path-Dependent Rebalance の変更
- Scenario Trigger の変更
- 個別株PF / 投信PF / 全体PF 分離の変更
- Go / No-Go 判定
- Shadow Mode 開始前の最終監査
```

---

## 6. Git 運用ルール

```bash
# 作業ブランチ（変更しない）
git checkout v13.3-dev

# コミット形式
git commit -m "feat: Card X-Y — [内容の要約]"

# プッシュ
git push origin v13.3-dev

# 禁止
❌ main / v9-archive への直接 push
❌ force push
❌ --no-verify
❌ main / v9-archive へのコード変更
```

---

## 7. ディレクトリ構成（Card 0-2 作成済み）

```
backend/engine/
  operation/     ← Layer 1
  market_intel/  ← Layer 2 (Macro)
  news/          ← Layer 2 (News 8ソース)
  regime/        ← Layer 3 ★
  universe/      ← Layer 4
  scoring/       ← Layer 5
  dynamic_weight/ ← Layer 6 ★
  strategies/    ← Layer 7 ★
  frontier/      ← Layer 8
  tier_a/        ← Layer 9
  agents/        ← Layer 10
  rebalance/     ← Layer 11 ★
  scenarios/     ← Layer 11 ★
  decision/      ← EV/CVaR/短期中長期
  behavioral/    ← Behavioral Score
  portfolio/     ← PF分解・Unified View
  meta_learning/ ← Meta-Learning・Drift
backend/models/  ← HMM 学習済みモデル
backend/tests/   ← 7テストスイート

docs/constitution/  ← 憲法ファイル（このファイル）
docs/card_context/  ← Card 単位抜粋資料
docs/v13.3/         ← 設計書 SSOT（変更禁止）

src/pages/       ← 新規 React ページ（v13.3 追加分）
src/components/  ← 既存コンポーネント（慎重に変更）
public/data/     ← JSON 契約ファイル
```

---

## 8. 禁止事項（再掲）

```
❌ 金融ロジックの新規創作（設計書に記載なき計算式）
❌ 並行 Card 実装
❌ ハードコード（トークン・カラー・数値）
❌ 個別株と投信の混在
❌ レジーム重みを scoring に直書き
❌ 4戦略の相互参照
❌ スマホ横スクロール放置
❌ handover.md の上書き
❌ docs/v13.3/ の設計書変更
❌ Opus 確認なしの金融ロジック変更
❌ テストなしの本番反映
```

---

## 9. 不明点の扱い

```
不明点 → 作業を止めて Ryo に確認
推測で実装 → 禁止
コメントに TODO 明示 → OK（推測実装は禁止）
```

---

## 10. セッション開始挨拶

このファイルを読み終えたら:

```
「Card X-Y を開始します。
 参照: handover.md, REGIME.md, 06 Card X-Y 仕様
 実装内容: [1行で要約]
 質問: [あれば]」
```

と Ryo に報告してから作業を開始すること。
