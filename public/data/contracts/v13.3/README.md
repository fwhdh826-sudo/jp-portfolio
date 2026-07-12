# v13.3 JSON Contract Samples

## 重要: このディレクトリについて

このディレクトリ (`public/data/contracts/v13.3/`) に含まれるすべての JSON ファイルは、
**Capital Allocation OS v13.3 の実装契約用サンプルデータ**です。

### 絶対禁止事項

- **実売買判断への使用禁止** — これらのデータは架空のサンプル値であり、実際の投資判断に使用してはなりません
- **本番データとの混同禁止** — `public/data/` 直下の本番 JSON（`market.json`, `holdings.json` 等）とは別物です
- **直接参照禁止** — React store / hooks / コンポーネントからこのディレクトリを直接 import しないでください

### 目的

各 JSON ファイルは以下の目的で作成されています：

1. **型契約の明示** — `src/types/*.ts` の TypeScript 型と JSON スキーマの対応関係を示す
2. **実装ガイド** — Phase 1〜15 の実装者が参照するデータ構造の見本
3. **テスト用フィクスチャ** — 統合テストのモックデータ基盤

### ファイル構成

| ディレクトリ | 内容 | 件数 |
|---|---|---|
| `operation/` | OS 稼働状態・データ鮮度・SAFE_MODE | 4 件 |
| `market/` | ニュース・市場インテリジェンス | 8 件 |
| `regime/` | レジーム検出（3 層合議） | 3 件 |
| `universe/` | 銘柄ユニバース・Sizeセグメント | 2 件 |
| `scoring/` | 6 軸スコア・クロス軸シグナル | 4 件 |
| `weight/` | 動的重みテーブル | 2 件 |
| `strategy/` | 4 戦略出力・統合結果 | 5 件 |
| `frontier/` | Frontier AI Index・効率的フロンティア | 4 件 |
| `tier_a/` | Tier A ゲート・Capitulation シグナル | 3 件 |
| `committee/` | AI 委員会レビュー・Adversarial Check | 2 件 |
| `portfolio/` | ポートフォリオ状態・ポジション | 5 件 |
| `rebalance/` | パス依存リバランス・シナリオ Pre-Commitment | 2 件 |
| `today/` | 当日最終判断サマリー | 1 件 |
| `log/` | 決定ログ・Intuition Log | 2 件 |

**合計: 47 件**

### 各ファイルの `_meta` フィールド

すべての JSON ファイルには以下の `_meta` ブロックが含まれています：

```json
"_meta": {
  "version": "v13.3",
  "kind": "sample_contract",
  "generated_for": "Card 0-5",
  "not_for_trading": true
}
```

### 参照ドキュメント

- `docs/v13.3/07_v13.3_spec.md` Section 11 — JSON スキーマ定義
- `docs/v13.3/05_v13.3_master_plan.md` Section 10 — JSON 契約一覧
- `src/types/` — 対応 TypeScript 型定義
