# Capital Allocation OS v13.3 — 3層AI分業 作業計画書（最終確定版）

**Document**: 09_3layer_workflow_final.md
**For**: Ryo
**Hardware**: M4 Pro Mac mini / 48GB Unified Memory
**Status**: Claude Opus 4.7 / GPT-5.4Pro / GPT-5.5 Thinking の3者検証統合済

---

## 0. 改訂履歴・統合元

```
v1 (08_3layer_workflow.md):    Claude Opus 4.7 初版
v2 (GPT-5.4Pro検証):            役割細分化・14B追加推奨・RAG提案
v3 (GPT-5.5 Thinking検証):     DeepSeek V4却下・48GB制約確認
v4 (このファイル):              3者統合・最終確定
```

### 統合判断

| 採用 | 棄却 |
| :-- | :-- |
| Qwen3-Coder 30B 主力（全員一致） | DeepSeek-V4-Flash ローカル化 |
| Qwen3.6-27B = レビュー専任（5.4Pro） | 70B級の無理な投入 |
| Gemma = 文章特化（5.4Pro） | 並列実装（私の08初版） |
| 14B Coder 追加（5.4Pro 最優先） | - |
| Embedding model 導入（5.4Pro） | - |
| card_context 抜粋資料（5.4Pro） | - |
| 1 Card = 1 Session 厳守（5.4Pro） | - |

---

## 1. ローカルLLM 役割分担（最終版）

### 1.1 4モデル体制

```
┌────────────────────────────────────────────────┐
│ ① Qwen3-Coder 30B  [主力コーダー]               │
│    UI・骨格・JSON・types・写経系                 │
└────────────────────────────────────────────────┘
                  ↑ 実装したコードを
┌────────────────────────────────────────────────┐
│ ② Qwen3.6-27B      [レビュー・整理係]           │
│    関数分割・型整理案・テスト観点・spec要約       │
└────────────────────────────────────────────────┘

┌────────────────────────────────────────────────┐
│ ③ Gemma 27B/31B    [文章・UI文言・教育]         │
│    README・handover・教育画面・説明文            │
└────────────────────────────────────────────────┘

┌────────────────────────────────────────────────┐
│ ④ Qwen系 14B Coder [小回り担当] ★追加DL推奨    │
│    細かい修正・回転率重視・並列バックグラウンド   │
└────────────────────────────────────────────────┘
```

### 1.2 各モデルの担当タスク（細分化）

#### ① Qwen3-Coder 30B（主力）

```yaml
担当:
  - UIコンポーネント（Card/Badge/Tabs/Skeleton 等）
  - ページ骨格（Today/Markets/News/Stock/Fund 等）
  - Tailwind/CSS実装
  - スマホ最適化
  - JSON Schema / sample data 生成
  - shared/types 雛形
  - score class の仕様書写経
  - News系の定型コード（rss_fetcher等）
  - test 雛形

不適:
  - 金融ロジックの新規設計
  - Tier A 判定ロジック
  - Regime Orchestrator
  - Multi-Strategy Aggregator
```

#### ② Qwen3.6-27B（レビュー専任）★新役割

```yaml
担当:
  - Qwen3-Coder 出力のローカル一次レビュー
  - 関数分割提案
  - 型整理（dataclass / TS interface）
  - spec → 実装タスク分解
  - 単体テストケース観点出し
  - JSON契約の整合性確認
  - card_context の要約作成

不適:
  - UIの大量実装（Qwen3-Coderの方が向く）
  - 文章生成（Gemmaの方が向く）
```

#### ③ Gemma 27B/31B（文章特化）★新役割

```yaml
担当:
  - README / handover / release_notes
  - UIラベル・ボタン文言
  - エラーメッセージ
  - 「why this score」根拠説明文
  - 教育画面（Weinstein/O'Neil）
  - Today画面の解説文
  - 金融用語の平易な説明

不適:
  - コード実装全般
  - 技術仕様書
```

#### ④ Qwen系 14B Coder（小回り）★追加DL推奨

```yaml
担当:
  - カード単位の小修正
  - TSXの細かい調整
  - unit test 雛形
  - ページ量産時の高速回転
  - バックグラウンド作業（30Bが大規模実装中）

導入候補:
  - qwen2.5-coder:14b（最有力）
  - qwen3-coder:14b（リリース後）
```

### 1.3 ★ Embedding Model（新規追加）

```yaml
モデル候補:
  - nomic-embed-text:latest（Ollama）
  - bge-large-en
  - multilingual-e5-large

用途:
  - 4ドキュメント（05/06/07/08）を分割インデックス
  - Card実装時に必要箇所だけプロンプト注入
  - Qwen への投入トークン削減
  - Sonnet/Opus への送信トークン削減

期待効果:
  - 各Cardのコンテキスト送信量を 60-80% 削減
  - Local LLM の精度向上（無関係情報の混入回避）

導入優先度: ★★★★★（高）
```

---

## 2. クラウドLLM 役割分担

### 2.1 Sonnet 4.6（統合・整合）

```yaml
担当:
  - Qwen 生成コードの統合
  - 型エラー / build エラー修正
  - Zustand / store 整合性
  - API / データ構造整理
  - UI と金融ロジックの分離
  - dedupe / fallback / retry 設計
  - テスト追加
  - P1/P2 改善
  - 共有型変更が絡む改修
  - 複数レイヤー横断の修正

エスカレーション条件（Sonnetへ上げる）:
  - 5ファイル以上に影響
  - shared/types が変わる
  - build/type が壊れる
  - Zustand/store を触る
  - API 契約が変わる
```

### 2.2 Opus 4.7（金融判断・監査）

```yaml
担当（厳格に限定）:
  - Tier A Hard / Soft 妥当性
  - SAFE_MODE 設計確認
  - Regime Orchestrator レビュー
  - 6軸・Cross-Axis 重み妥当性
  - Dynamic Weight Engine
  - Multi-Strategy Aggregator
  - Frontier expected return / covariance / optimizer
  - Path-Dependent Rebalance
  - Scenario triggers
  - 個別株PF / 投信PF / 全体PF 分離確認
  - mock / fallback 混同検査
  - Go / No-Go 判定
  - P0 修正
  - Shadow Mode 前監査

エスカレーション条件（Opusへ上げる）:
  - 金融ロジック変更
  - 重み変更
  - リスク制御変更
  - 売買トリガー変更
  - SAFE_MODE / Tier A / Rebalance / PF分離変更
  - 本番反映可否判断
```

---

## 3. 「1 Card = 1 Session」原則の徹底

### 3.1 重要修正：並列実装は禁止

```
❌ 私の08初版での誤り:
  「Local LLM 並列実行で1日2-3 Card進める」
  → これは 06_v13.3_claude_code_instructions.md p.1 の
    「1 Card = 1 Session、並行禁止」原則に違反

✅ 正しい運用:
  並列で進めて良いのは「再利用資産」の事前作成のみ
  Card そのものの実装は逐次・直列
```

### 3.2 並行可能な「再利用資産」前倒し作業

これは Card実装ではないので、**Cardの並行禁止には抵触しない**：

```yaml
事前作成可能（前倒しOK）:
  
  1. UI共通基盤（Card実装前に揃える）:
    - Badge / Tabs / Card / SectionHeader
    - EmptyState / Skeleton
    - SourceFilter / CrossAxisCard
    - StrategyAdoption / RegimeIndicator
    
  2. モックJSON / サンプル契約:
    - regime_state.json
    - strategy_aggregated.json
    - holdings_news.json
    - capitulation_signal.json
    - 35+ JSON sample
    
  3. shared/types:
    - regime types
    - strategy output types
    - news item types
    - score axis types
    - cross-axis signal types
    - portfolio/rebalance types
    
  4. 画面骨格（hooks未接続版）:
    - Today / Markets / News
    - Stock Detail / Fund Detail
    - Portfolio / Frontier詳細
    - Journal / System / Alerts / Education
    
  5. テスト雛形:
    - scoring axis test skeleton
    - news test skeleton
    - rebalance test skeleton
    - integration test shell
    
  6. card_context 抜粋資料: ★最重要
    - docs/card_context/card_5_1_value_score.md
    - 巨大PDFを毎回読ませず、Card単位で抜粋
    - ローカル/クラウド両方のトークン削減に効く
```

### 3.3 1 Card = 1 Session の流れ

```
[Session開始]
   │
   ├─ Step 1: card_context/card_X_Y.md を読み込む
   │          （事前作成済の抜粋資料）
   │
   ├─ Step 2: 該当モデルに投入（Local or Cloud）
   │          
   ├─ Step 3: 実装完了まで他Cardに触らない
   │
   ├─ Step 4: handover.md 更新
   │
   ├─ Step 5: git commit + push
   │
   └─ Step 6: 「Card X-Y 完了」報告
                    │
                    ↓
              [次のSession]
```

---

## 4. 統合運用ルーティング表（最終版）

### 4.1 そのまま使える運用ルール

| 作業内容 | 主担当 | レビュー | 備考 |
| :-- | :-- | :-- | :-- |
| TSX/React/UI骨格 | Qwen3-Coder 30B | Sonnet 4.6 | 最も相性が良い |
| CSS/レスポンシブ/スマホ | Qwen3-Coder 30B | Sonnet 4.6 | 横スクロール潰し |
| 細かいUI修正 | Qwen 14B Coder | - | 高速回転 |
| README/handover/UI文言 | Gemma | - | prose向き |
| 教育コンテンツ文章 | Gemma | - | Weinstein/O'Neil |
| JSON schema/sample/types | Qwen3-Coder 30B | Qwen3.6-27B → Sonnet | deterministic |
| score class 雛形 | Qwen3-Coder 30B | Sonnet → Opus | 数式は spec 写経のみ |
| RSS fetcher / source config | Qwen3-Coder 30B | Sonnet | fallback/retry は Sonnet |
| store/Zustand/API整合 | Sonnet 4.6 | - | ローカル非推奨 |
| Regime/HMM/Orchestrator | Sonnet 4.6 | Opus 4.7 | 金融コア |
| Frontier/Optimizer | Sonnet 4.6 | Opus 4.7 | P0領域 |
| Tier A/SAFE_MODE | Sonnet 4.6 | Opus 4.7 | P0領域 |
| Rebalance/Scenario | Sonnet 4.6 | Opus 4.7 | P0領域 |
| Go/No-Go判定 | Opus 4.7 | - | 最終判定 |

### 4.2 Phase別の最終割り振り（修正版）

#### Phase 0: 骨格（5 Cards）

```
Card 0-1: repo準備                    → Gemma + 人間
Card 0-2: ディレクトリ構造            → Qwen3-Coder 30B
Card 0-3: Constitutional 6ファイル    → Gemma → Sonnet
Card 0-4: shared/types                → Qwen3-Coder 30B → Qwen3.6-27B
Card 0-5: JSON契約 35個              → Qwen3-Coder 30B → Qwen3.6-27B
```

#### Phase 1: Design+Tier A（4 Cards）

```
Card 1-1: Claude Design Step A        → 人間 + Sonnet
Card 1-2: tier_a_hard_gate.py        → Sonnet → Opus ★
Card 1-3: tier_a_soft_penalty.py     → Sonnet → Opus ★
Card 1-4: alerts + capitulation       → Sonnet → Opus ★
```

#### Phase 2: Operation（7 Cards）

```
Card 2-1: data_freshness.py          → Sonnet
Card 2-2: safe_mode + watchdog        → Sonnet → Opus ★
Card 2-3: GitHub Actions YAML         → Qwen3-Coder 30B → Sonnet
Card 2-4: Discord通知 + recovery      → Qwen3-Coder 30B → Sonnet
Card 2-5: R1-R3 Routines              → Qwen3-Coder 30B → Sonnet
Card 2-6: R4-R6 Routines              → Sonnet
Card 2-7: R7-R10 Routines             → Sonnet
```

#### Phase 3: Regime+Universe（8 Cards）

```
Card 3-1: rule_based.py               → Sonnet → Opus ★
Card 3-2: hmm_detector.py             → Sonnet → Opus ★
Card 3-3: llm_quality.py              → Sonnet → Opus ★
Card 3-4: orchestrator.py             → Sonnet → Opus ★
Card 3-5: size_segments.py            → Sonnet
Card 3-6: quality_filter.py           → Sonnet
Card 3-7: cross_axis_signal.py        → Sonnet → Opus ★
Card 3-8: 統合テスト                  → Sonnet
```

#### Phase 4: News+Markets（10 Cards）

```
Card 4-1: sources_config.py           → Qwen3-Coder 30B → Sonnet
Card 4-2: rss_fetcher.py              → Qwen3-Coder 30B → Sonnet
Card 4-3: edinet_api.py               → Sonnet
Card 4-4: shikiho_scraper.py          → Qwen3-Coder 30B → Sonnet
Card 4-5: aggregator.py               → Sonnet
Card 4-6: ticker_extractor.py         → Qwen3-Coder 30B
Card 4-7: sentiment_calculator.py     → Sonnet
Card 4-8: importance_scorer.py        → Qwen3-Coder 30B → Sonnet
Card 4-9: macro_fetcher + ai_narrator → Sonnet
Card 4-10: Markets + News React UI   → Qwen3-Coder 30B → Sonnet
```

#### Phase 5: スコア+Decision（10 Cards）

```
Card 5-1: value_score.py              → Qwen3-Coder 30B → Sonnet → Opus ★
Card 5-2: quality_score.py            → Qwen3-Coder 30B → Sonnet → Opus ★
Card 5-3: growth_score.py             → Qwen3-Coder 30B → Sonnet → Opus ★
Card 5-4: safety_score.py             → Qwen3-Coder 30B → Sonnet → Opus ★
Card 5-5: momentum_score.py           → Qwen3-Coder 30B → Sonnet → Opus ★
Card 5-6: shareholder_return_score    → Qwen3-Coder 30B → Sonnet → Opus ★
Card 5-7: ev_calculator.py            → Sonnet → Opus ★
Card 5-8: cvar + uncertainty          → Sonnet → Opus ★
Card 5-9: short_long_split.py         → Sonnet → Opus ★
Card 5-10: vol_targeting + dd10_kpi   → Sonnet
```

#### Phase 6-15: 同様のパターン

```
全カードのモデル割り当ては別表（Card単位の運用表）として
docs/implementation/card_routing_v13.3.md に
別途作成可能
```

---

## 5. 環境構築（最終版）

### 5.1 必須セットアップ

```bash
# Ollama 確認
ollama list

# 既存モデル（OK）:
# - qwen3-coder:30b
# - qwen3:32b (Qwen3.6-27B 相当)
# - gemma3:27b
# - gemma3:31b

# 追加DL（最優先）:
ollama pull qwen2.5-coder:14b      # 14B Coder（小回り用）
ollama pull nomic-embed-text       # Embedding（RAG用）

# 動作確認
ollama run qwen3-coder:30b "Hello"
ollama run qwen2.5-coder:14b "Hello"
```

### 5.2 Continue.dev 設定（複数モデル切替）

```json
// ~/.continue/config.json

{
  "models": [
    {
      "title": "Qwen3-Coder 30B (主力)",
      "provider": "ollama",
      "model": "qwen3-coder:30b",
      "apiBase": "http://localhost:11434"
    },
    {
      "title": "Qwen 14B (小回り)",
      "provider": "ollama",
      "model": "qwen2.5-coder:14b",
      "apiBase": "http://localhost:11434"
    },
    {
      "title": "Qwen3.6 27B (レビュー)",
      "provider": "ollama",
      "model": "qwen3:32b",
      "apiBase": "http://localhost:11434"
    },
    {
      "title": "Gemma 27B (文章)",
      "provider": "ollama",
      "model": "gemma3:27b",
      "apiBase": "http://localhost:11434"
    }
  ],
  "embeddingsProvider": {
    "provider": "ollama",
    "model": "nomic-embed-text"
  },
  "contextProviders": [
    {
      "name": "code"
    },
    {
      "name": "docs",
      "params": {
        "sites": [
          {
            "title": "v13.3 Master Plan",
            "rootUrl": "file:///path/to/05_v13.3_master_plan.md"
          },
          {
            "title": "v13.3 Spec",
            "rootUrl": "file:///path/to/07_v13.3_spec.md"
          }
        ]
      }
    }
  ]
}
```

### 5.3 RAG セットアップ（Embedding活用）

```bash
# ドキュメント分割スクリプト（Card単位）
mkdir -p docs/card_context

# 例: Card 5-1 用
cat > docs/card_context/card_5_1_value_score.md <<EOF
# Card 5-1: value_score.py 実装に必要な抜粋

## 仕様（07_spec.md より抜粋）
$(awk '/value/,/quality/' docs/v13.3/07_v13.3_spec.md)

## マスタープラン参照
$(awk '/Layer 5: Scoring/,/Layer 6/' docs/v13.3/05_v13.3_master_plan.md)

## 関連 JSON Schema
- stock_scores_6axis.json の value 部分のみ
- score_explanations.json
EOF
```

### 5.4 作業ディレクトリ構造

```
~/code/capital-allocation-os/
├── docs/
│   ├── v13.3/
│   │   ├── 05_master_plan.md
│   │   ├── 06_claude_code_instructions.md
│   │   ├── 07_spec.md
│   │   ├── 08_3layer_workflow.md（旧版）
│   │   └── 09_3layer_workflow_final.md ★最終版
│   ├── card_context/  ★Card単位抜粋
│   │   ├── card_0_2_directory.md
│   │   ├── card_0_5_json_contracts.md
│   │   ├── card_5_1_value_score.md
│   │   └── ...
│   └── handovers/
└── ...

~/work/v13.3-staging/
├── card-0-1/
│   ├── local_output.md
│   ├── reviewer_output.md  (Qwen3.6-27B)
│   ├── sonnet_review.md
│   └── final.md
└── ...
```

---

## 6. プロンプトテンプレート（最終版）

### 6.1 Qwen3-Coder 30B 用（実装）

```
[Card X-Y 実装依頼]

## コンテキスト（Embedding RAG経由）
- 参照: docs/card_context/card_X_Y.md（事前作成済抜粋）

## タスク
{Card内容}

## 必須ルール
1. Capital Allocation OS v13.3 規約遵守
2. ハードコード禁止 → tokens.ts 経由
3. 個別株=青系 / 投信=紫系
4. スマホ縦1カラム破綻なし
5. TypeScript 型を厳格に
6. 既存コード（src/）への影響範囲を明記
7. 不明点は推測せずコメント明示

## 成果物
- {対象ファイル} を ~/work/v13.3-staging/card-X-Y/ に出力
- 簡潔なコメント付き
- import 文は完全形

## 禁止事項
- 金融ロジックの新規創作
- Tier A 判定の独自解釈
- mock と本番の混同
```

### 6.2 Qwen3.6-27B 用（ローカルレビュー）★新規

```
[Card X-Y ローカルレビュー]

## レビュー対象
Qwen3-Coder 30B が以下を実装しました:
{コードペースト}

## レビュー観点
1. 関数分割は適切か（責務分離）
2. 型定義は厳密か
3. spec（card_context/card_X_Y.md）と整合しているか
4. テスト観点の漏れ
5. JSON契約との整合性

## 成果物
- 修正案を箇条書き
- 重大な問題は ⚠️ 印
- 推奨される関数分割案
- 不足しているテストケース

## 出力先
~/work/v13.3-staging/card-X-Y/reviewer_output.md
```

### 6.3 Gemma 用（文章生成）★新規

```
[Card X-Y 文章生成依頼]

## タスク
{以下のいずれか}
- README 作成
- handover.md 作成
- UI ラベル / 説明文
- エラーメッセージ
- Today画面の解説文
- 教育画面コンテンツ

## トーン
- プロフェッショナル × 平易
- 個人投資家向け（初級〜中級）
- 機関投資家っぽい威厳

## 制約
- 1段落 3-5行
- 専門用語には簡潔な解説
- 数値は具体的に
- 推奨は明確に
```

### 6.4 Sonnet 4.6 用（統合）

```
[Card X-Y 統合・修正依頼]

## 入力
1. Qwen3-Coder 30B 実装: {コードペースト}
2. Qwen3.6-27B レビュー: {レビュー結果}

## タスク
1. レビュー指摘事項を反映
2. 型エラー / build エラー修正
3. 責務分離（UI と金融ロジック混在チェック）
4. Zustand store 整合性
5. tokens.ts / typography.ts 経由になっているか
6. テスト追加（Jest / pytest）

## 参照
- docs/card_context/card_X_Y.md
- 既存 src/ コード（必要時）

## 成果物
- git commit 可能な最終コード
- テスト追加分
- 変更点サマリー
```

### 6.5 Opus 4.7 用（金融判定・最小限）

```
[Card X-Y 金融ロジック妥当性判定]

## 実装ロジック
{コアロジックのみ、UI省略}

## 判定依頼
1. 金融的に妥当か
2. Survival-First原則違反なし
3. Tier A 制約と矛盾なし
4. mock/fallback 混同なし
5. P0（本番反映可否）判定

## 出力形式
PASS / MODIFY / REJECT
理由 3行以内
```

---

## 7. 前倒し可能タスク（最終版）

### 7.1 即実行可能（依存なし）

```
□ docs/card_context/ 抜粋資料 全 Card 分作成
  → Gemma + Qwen3.6-27B で並列処理OK（Cardではないため）
  → 推奨: 1日10件ペースで作成
  → 24-30週間の運用効率を大幅改善

□ Phase 0 系（依存最小）:
  - Card 0-2: ディレクトリ構造（Qwen3-Coder 30B）
  - Card 0-5: JSON契約 35個 サンプル（Qwen3-Coder 30B）

□ UI共通基盤（Phase 1完了後ならいつでも）:
  - Badge / Card / Tabs / Skeleton / SectionHeader 等
  - tokens.ts 確定後、これらは並列で作れる
```

### 7.2 Phase 1 完了後に並列着手可能

```
□ UI共通部品の量産（Card実装前に揃える）
  - 仕様: 07_spec.md p.27-30 参照
  - 担当: Qwen3-Coder 30B
  
□ モックJSON 35個全部
  - 担当: Qwen3-Coder 30B
  
□ shared/types 全部
  - 担当: Qwen3-Coder 30B → Qwen3.6-27B レビュー
  
□ テスト雛形
  - 担当: Qwen3-Coder 30B
```

### 7.3 並列禁止：個別Card実装

```
❌ Card 4-1 と Card 4-2 を同時並列実装
❌ 1日に複数のCard実装を走らせる
❌ Phase 完了前に次Phase着手

✅ 1 Card = 1 Session を厳守
```

---

## 8. リスク評価（DeepSeek却下含む）

### 8.1 GPT-5.5 Thinking の警告：DeepSeek-V4-Flash

```
判定: ローカル化却下

理由:
  - 284B total params
  - Q4 でも 142GB必要
  - Q1 で 35-40GB（品質劣化深刻）
  - 1M context は KV cache が更に重い
  - M4 Pro 48GB では実用困難

代替案:
  - DeepSeek-V4-Flash は API 経由でのみ利用
  - セカンドオピニオン用途
  - Qwenの代替ではなく補助
  - ただし優先度は低い（Sonnet/Opusで十分）

最終判断:
  ローカル: 棄却
  API: オプション（追加投資なし）
```

### 8.2 70B級モデルの注意

```
判定: 棄却

理由:
  - Llama 3.3 70B は 48GB ギリギリ
  - 推論速度が極端に低下
  - 開発サイクルが落ちる
  - Qwen3-Coder 30B が品質9.9/10で十分

代替: なし（追加不要）
```

### 8.3 採用すべきモデル追加（最終）

```
優先度1: Qwen系 14B Coder
  - 小回り担当
  - 並列バックグラウンド作業
  - DLサイズ ~5GB

優先度2: nomic-embed-text（Embedding）
  - RAG構築用
  - DLサイズ ~250MB
  - トークン削減効果大
```

---

## 9. 最初の2週間（最終版・実行ロードマップ）

### Week 1: 基盤と前倒し資産

```
Day 1（月）: 環境構築
  □ Qwen2.5-Coder 14B 追加DL
  □ nomic-embed-text 追加DL
  □ Continue.dev マルチモデル設定
  □ ~/work/v13.3-staging/ 作成
  □ docs/card_context/ 作成

Day 2（火）: card_context 抜粋資料量産（Gemma + Qwen3.6）
  □ Phase 0 全Card分（5枚）
  □ Phase 1 全Card分（4枚）

Day 3（水）: Phase 0 着手
  □ Card 0-1 (Gemma + 人間)
  □ Card 0-2 (Qwen3-Coder 30B)
  □ Card 0-3 (Gemma → Sonnet)

Day 4（木）: Phase 0 完了
  □ Card 0-4 (Qwen3-Coder 30B → Qwen3.6-27B)
  □ Card 0-5 (Qwen3-Coder 30B → Qwen3.6-27B)
  □ handover Phase 0

Day 5（金）: Phase 1 着手 + 前倒し資産
  □ Card 1-1 Claude Design セッション
  □ tokens.ts 統合（Sonnet）
  □ UI共通部品 Badge/Card/Tabs（Qwen3-Coder 30B）★前倒し

Day 6-7（土日）: 前倒し資産量産
  □ Phase 2-5 用 card_context 抜粋
  □ モックJSON 35個全部（Qwen3-Coder 30B）
  □ shared/types 全部（Qwen3-Coder 30B → Qwen3.6-27B）
```

### Week 2: 金融コアの開始

```
Day 8（月）: Tier A 実装（Sonnet主導）
  □ Card 1-2 (Sonnet → Opus 確認★)
  □ Card 1-3 (Sonnet → Opus 確認★)

Day 9（火）: Tier A 完了
  □ Card 1-4 (Sonnet → Opus 確認★)

Day 10-12（水〜金）: Phase 2 Operation
  □ Card 2-1〜2-5（Sonnet主導 + Local LLM補助）

Day 13-14（土日）: バッファ + Phase 3 準備
  □ Phase 3 用 card_context 抜粋
  □ HMM 学習用データ準備
```

---

## 10. トークン消費試算（最終版）

### 10.1 修正後の試算

```
1 Card あたり（最終版）:
  Local LLM:   80,000-120,000 tok（無料、複数モデル合算）
  Sonnet 4.6:  3,000-12,000 tok（Embedding RAG で削減）
  Opus 4.7:    300-1,500 tok（判定のみ）

100 Card 完走時:
  Local:       100M tok（無料）
  Sonnet 4.6:  約 800K tok
  Opus 4.7:    約 90K tok
  
  vs 全部 Sonnet/Opus:
  → 約 85% トークン削減（Embedding効果で改善）
```

### 10.2 推定コスト

```
Sonnet 4.6: 約 $7-9
Opus 4.7:   約 $4-5
─────────────────
合計:       約 $11-14（24-30週間）

全部Opusなら数百ドル → 95%以上削減
```

---

## 11. 進捗管理ダッシュボード（推奨）

```markdown
# v13.3 進捗ボード

## トークン消費
- Sonnet 4.6: 234K / 1M (23%)
- Opus 4.7:   18K / 100K (18%)
- Local:      無制限

## モデル稼働状況
- Qwen3-Coder 30B: ★★★★★ メイン
- Qwen2.5-Coder 14B: ★★★ サブ
- Qwen3.6-27B: ★★ レビュー
- Gemma 27B: ★★ 文章

## 前倒し資産進捗
- card_context: 50/100 (50%)
- UI共通部品: 8/12 (67%)
- モックJSON: 20/35 (57%)
- shared/types: 完了

## Phase進捗
- Phase 0: ✅ 5/5
- Phase 1: 🔄 2/4 進行中
- Phase 2-15: 未着手

## エスカレーション履歴
- Card 1-2 → Opus: PASS
- Card 1-3 → Opus: MODIFY（penalty係数調整）
- Card 1-4 → Opus: PASS
```

---

## 12. 最終結論

### 4モデル + 2クラウドの最適配置

```
┌────────────────────────────────────┐
│ ローカル4モデル（M4 Pro 48GB）        │
│ ① Qwen3-Coder 30B   主力コーダー    │
│ ② Qwen3.6-27B       レビュー専任    │
│ ③ Gemma 27B/31B     文章特化       │
│ ④ Qwen 14B Coder   小回り（追加DL） │
│ + nomic-embed-text  RAG用（追加DL） │
└────────────────────────────────────┘

┌────────────────────────────────────┐
│ クラウド2モデル                       │
│ ⑤ Sonnet 4.6        統合・整合      │
│ ⑥ Opus 4.7          金融判断・P0    │
└────────────────────────────────────┘
```

### 実装期間の現実的な見積もり

```
当初: 24-30週間（全部Sonnet/Opus）
↓
4モデルローカル + RAG 構成:
20-25週間（並列禁止厳守時）
17-22週間（前倒し資産活用時）

→ 最大 23% 短縮可能
```

### Day 1 アクション（最終確定）

```
今すぐ:
  □ qwen2.5-coder:14b 追加DL
  □ nomic-embed-text 追加DL
  □ Continue.dev マルチモデル設定
  □ ~/work/v13.3-staging/ 作成
  □ docs/card_context/ ディレクトリ作成

並列で走らせて良いもの（Card実装ではない）:
  □ card_context 抜粋資料量産（Gemma）
  □ UI共通部品の事前設計（Qwen3-Coder）
  
明日以降の Card 実装:
  □ Phase 0 Card 0-1 から開始
  □ 1 Card = 1 Session 厳守
```

### 哲学的結論（修正版）

> **「Opus は判定の頭脳、Sonnet は整理の手、ローカル4モデルは量産の手足、Embedding は記憶補助。」**
> 
> Ryo の役割は **指揮者**：
>   - 指示書（v13.3 docs）に基づき指揮
>   - 各Cardは1 Session で完結
>   - 並列禁止、ただし再利用資産は事前作成OK
>   - 重要判断は Opus にエスカレーション
>   - SBI 証券で実行
>
> 5者検証済の最適解。実装開始可能。

---

**最終確定版 完了**

```
✅ 05_v13.3_master_plan.md
✅ 06_v13.3_claude_code_instructions.md
✅ 07_v13.3_spec.md
⚠️ 08_3layer_workflow.md（旧版、参照用に保存）
✅ 09_3layer_workflow_final.md（このファイル、最終版）
```

実装開始時はこのファイル（09）を参照すること。
08は古い情報（並列実装推奨）が含まれるため非推奨。
