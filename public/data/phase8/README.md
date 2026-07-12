# Phase 8 public data — README

## 重要: このディレクトリについて

このディレクトリ (`public/data/phase8/`) は、Capital Allocation OS v13.3
Phase 8 の presentation 出力 JSON を将来配置するための namespace です。

### 1. LIVE（4 JSON 配置済・partial-real / hybrid）

- **本ディレクトリには `_meta.generated_at` 時点の 4 JSON が
  配置されています**（snapshot 公開）。
- `frontier_index.json` / `strategy_aggregate.json` /
  `opportunity_loss.json` / `future_branching.json` が live です。
- これら 4 JSON は **partial-real / hybrid** であり、**not full real
  / not full generated** です。各 `_meta.source` に
  `phase8_hybrid: returns=yfinance-real, scores=public_scoring,
  others=missing-safe-default` を含み、hybrid 性質を明示します。
- 公開タイミング：現時点では **手動 write**（heredoc 経由で
  `main(output_dir=public/data/phase8)` を明示呼出 + 明示 commit）。
  CI 接続（schedule・bot commit）は後続 Card。

### 2. 将来配置する予定のファイル

| ファイル | 内容 |
|---|---|
| `frontier_index.json`     | Frontier AI Index presentation |
| `strategy_aggregate.json` | 4 戦略統合 presentation |
| `opportunity_loss.json`   | 機会損失観察値 presentation |
| `future_branching.json`   | 将来分岐シナリオ presentation |

### 3. partial-real / hybrid（not full real / not full generated）

これら 4 JSON は **partial-real / hybrid** であり、**not full real /
not full generated** です。入力の出所（provenance）は以下の混在で、
`_meta.source` の文字列がこれを宣言します。

| 入力 | 出所 | 区分 |
|---|---|---|
| `returns_data` / `dd10_returns` | `public/data/returns.json`（yfinance） | **real** |
| `scores` | `public/data/scoring/stock_scores_6axis.json`（update_scores.py / scoring_orchestrator・migration により public_scoring 優先） | **partial-real**（fundamentals 19 + volatility_252d + 9 passthrough は MISSING 中立） |
| `cash_weight` / `regime_probabilities` / `expected_return_by_ticker` | 本番ソースなし | **missing-safe default** |
| `current_pf` / `holdings` | `public/data/holdings.json` 等 | **real-partial** |

fallback として `public/data/contracts/v13.3/scoring/stock_scores_6axis.json`
（sample_contract）への退避経路を維持。各 `_meta.source` の値で
どちらの経路を通ったか識別可能。**partial-real / hybrid** の性質は、
fundamentals snapshot の単発性、金融セクター bounded distortion、
momentum / 9 passthrough が technical-deferred で中立化されること等
（handover.md 参照）から継続。

### 4. not_for_trading（観察・計算値であり指示ではない）

- 各出力 JSON の `_meta.not_for_trading` は常に **true** です。
- 本データは **計算上の観察値**であり、いかなる売買・発注・投資判断の
  指示としても使用しないでください。
- 注文の生成、銘柄の推奨、リバランス指示、特定の株数や金額の提示は
  **一切含まれません／行いません**。

### 5. `_meta.kind` の扱い

- `_meta.kind` は `frontier_index` 等の **出力種別**を表します。
- `_meta.kind` は generated / hybrid を表す場所では **ありません**。
- hybrid である事実（provenance）は `_meta.source` と本 README で表現します
  （現状は migration 後で例: `phase8_hybrid: returns=yfinance-real,
  scores=public_scoring, others=missing-safe-default`。
  sample_contract fallback 時は `scores=sample_contract`、両方不在時は
  `scores=missing`）。

### 6. `_meta.generated_at`

- timezone 付き ISO8601 を推奨します（例: `...+09:00` / `...+00:00`）。
- 理由: UI 側の鮮度（stale）判定の一貫性のため。

### 7. Consumer / pipeline status

- `public/data/phase8` への JSON 実 write は **解禁済**（manual
  first-write）。
- React UI 側の本配線（P2-D4）は **未配線**（loader
  `src/services/loadPhase8Data.ts` は missing-safe で既設・本 4 JSON
  公開後は real data を取得可能）。
- Phase 8 の GitHub Actions 生成（phase8 GHA）は **未実装**
  （CI 接続 Card は本 write 後に別途）。
- 再生成は現時点では手動 heredoc 経由（`main(output_dir=
  public/data/phase8)` を明示呼出）。

### 8. Reference

設計の根拠・確定事項は `handover.md` の
**「public/data/phase8 実write Card Readiness 結果 / hybrid write 設計」**
節を参照してください。`_meta` envelope の構造、hybrid honesty の方針、
実 write（E）の No-Go 解除条件もそこに記載されています。
