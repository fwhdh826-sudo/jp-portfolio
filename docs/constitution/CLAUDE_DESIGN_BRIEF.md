# Capital Allocation OS v13.3 — CLAUDE_DESIGN_BRIEF

**Version**: v13.3
**Last Updated**: 2026-04-26

> UI 実装者（Claude Code / Local LLM）が参照するデザイン憲法。
> tokens.ts からトークンを取得し、ハードコードは禁止。

---

## 1. カラー方針（最重要）

### 資産クラス別カラー（混在禁止）

| 資産クラス | カラー系統 | 代表値 | 用途 |
| :-- | :-- | :-- | :-- |
| **個別株** | 青系 | `blue-500 / #3B82F6` | カード・バッジ・レーダー |
| **国内株投信** | 紫系 | `violet-500 / #8B5CF6` | カード・バッジ・レーダー |
| **海外投信** | インディゴ系 | `indigo-500 / #6366F1` | カード・バッジ |

```
❌ 個別株カードに紫を使う → 禁止
❌ 投信カードに青を使う → 禁止
❌ 同一コンポーネントで混在 → 禁止
```

### ステータスカラー

| 状態 | カラー | CSS変数 |
| :-- | :-- | :-- |
| 強気・成功・GO | Green | `var(--color-success)` |
| 警告・注意 | Amber | `var(--color-warning)` |
| 危険・SELL | Red | `var(--color-danger)` |
| 危機・SAFE_MODE | Critical（深赤） | `var(--color-critical)` |
| 中立・WAIT | Gray | `var(--color-neutral)` |

### 6軸スコア カラー（07_spec.md Section 1.1 より）

| 軸 | カラー | 値 |
| :-- | :-- | :-- |
| バリュー | Blue | `#3B82F6` |
| クオリティ | Violet | `#8B5CF6` |
| グロース | Emerald | `#10B981` |
| 安全性 | Cyan | `#06B6D4` |
| モメンタム | Amber | `#F59E0B` |
| 還元力 | Pink | `#EC4899` |

---

## 2. レジーム Indicator カラー（全画面ヘッダー必須）

| レジーム | ラベル | アイコン | カラー |
| :-- | :-- | :-: | :-- |
| bull_calm | 強気・低ボラ | 🟢 | `var(--color-success)` |
| bull_volatile | 強気・高ボラ | 🟡 | `var(--color-warning)` |
| bear | 弱気 | 🔴 | `var(--color-danger)` |
| crisis | 危機 | 🚨 | `var(--color-critical)` |
| uncertain | 不確実 | ⚪ | `var(--color-neutral)` |

```tsx
// 07_spec.md Section 12.1 より
<div className="regime-indicator"
  style={{ borderLeft: `4px solid ${display.color}` }}>
  {display.icon} 市況: {display.label}
  <Badge>合意度 {(consensus*100).toFixed(0)}%</Badge>
</div>
```

---

## 3. レイアウト原則（スマホ最優先）

```
✅ スマホ縦1カラム必須
✅ 44×44px 最小タップターゲット
✅ Bottom Navigation（モバイル）
✅ 横スクロール完全禁止
✅ flex-wrap で長い要素を折り返す
✅ overflow-x: hidden をコンテナに設定

❌ 横長テーブルをそのまま表示 → カード化必須
❌ 固定幅 > 100vw → 禁止
❌ min-width > 100% → 禁止
```

### ブレークポイント

```
sm:  640px  （スマホ横向き）
md:  768px  （タブレット）
lg:  1024px （デスクトップ）
```

---

## 4. 情報設計原則

### 結論先出し（4ブロック必須）

```
Block 1: 結論（BUY / WAIT / SELL + スコア）
Block 2: 根拠（6軸スコア + Cross-Axis + キーシグナル）
Block 3: リスク（CVaR / DD / Tier A 警告）
Block 4: 行動（推奨アクション + 利確/損切条件）
```

### 1カード1メッセージ

```
✅ カード1枚につき伝えることは1つ
✅ 長い表は Accordion or 別画面へ
❌ 1カードに複数の判断を詰め込む → 禁止
```

---

## 5. トークン運用ルール

```tsx
// ✅ 正しい
import { colors } from '@/theme/tokens'
style={{ color: colors.blue[500] }}

// ❌ 禁止（ハードコード）
style={{ color: '#3B82F6' }}
```

- 数値（spacing / font-size / radius）も tokens.ts 経由
- tokens.ts は Phase 1 Card 1-1（Claude Design Step A）で確定
- Phase 0-1 の段階では CSS 変数またはプレースホルダーで対応

---

## 6. 10画面 構成

| # | 画面 | 性質 | 主担当モデル |
| :-: | :-- | :-- | :-- |
| 1 | Today | ヒーロー（最重要） | Sonnet |
| 2 | Markets | ヒーロー | Sonnet |
| 3 | News | ヒーロー（v13.3 新規） | Qwen3-Coder + Sonnet |
| 4 | Stock Detail | ヒーロー | Qwen3-Coder + Sonnet |
| 5 | Fund Detail | ヒーロー | Qwen3-Coder + Sonnet |
| 6 | Portfolio | 補助 | Sonnet |
| 7 | Frontier詳細 | 補助 | Sonnet |
| 8 | Watch / Holdings | 補助 | Qwen3-Coder |
| 9 | Journal | 補助 | Qwen3-Coder |
| 10 | System / Alerts | 補助 | Qwen3-Coder |

---

## 7. コンポーネント命名規則

```
共通コンポーネント: src/components/common/
  Badge / Card / Tabs / Skeleton / SectionHeader / EmptyState

v13.3 新規コンポーネント: src/components/v13/
  RegimeIndicator / CrossAxisCard / StrategyAdoption
  NewsCard / SourceFilter / CapitulationAlert

新規ページ: src/pages/
  Today.tsx / Markets.tsx / News.tsx
  StockDetail.tsx / FundDetail.tsx / Portfolio.tsx

既存タブ（変更慎重）: src/components/tabs/
  T0_Home / T1_Decision / ... （v10 既存、v13.3 移行まで維持）
```

---

## 8. Stock Detail / Fund Detail 差別化

```
Stock Detail（青系）:
  - 6軸レーダーチャート
  - Cross-Axis Signal 表示
  - 4戦略での採用ウェイト
  - 3ヶ月 Lock 表示
  - Tier A 警告バッジ

Fund Detail（紫系）:
  - 短期売買 4条件チェック
  - OS 確信度スコア
  - ブルベア即時売却ルール
  - 待機後続勝率
```

---

## 9. スマホ確認チェックリスト（各 UI Card 完了時）

```
□ 縦1カラム表示が崩れない
□ 横スクロールが発生しない
□ タップターゲット 44×44px 以上
□ Bottom Nav が操作しやすい
□ Regime Indicator がヘッダーに表示される
□ Lighthouse Mobile スコア確認（Phase 14 で 90+ 目標）
```
