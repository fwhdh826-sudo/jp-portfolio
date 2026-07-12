# Capital Allocation OS v13.3 — ALLOCATION v3.0

**Version**: v3.0（v13.3 統合版）
**Last Updated**: 2026-04-26

> v3.0 配分は Frontier の初期値。Frontier が再計算し、Tier A ハイブリッドで制約する。

---

## 1. 配分構造（3層 + Cash）

```
[Core層]     目標 55%    長期安定・分散コア
[Satellite層] 動的       機会捕捉・テーマ
[Tactical層]  動的       短期売買（投信中心）
[Cash]        固定 300万円（≒ 7.7%）  待機資金・Capitulation 投入源
```

### Core / Satellite / Tactical の性質

| 区分 | 対象 | 時間軸 | リバランス閾値 |
| :-- | :-- | :-- | :-- |
| Core | 海外インデックス投信・安定個別株 | 中長期（数年） | ±5% で動作 |
| Satellite | 個別株・テーマ投信 | 中期（数ヶ月） | ±15% で動作 |
| Tactical | ブルベア型投信・短期 | 短期（数日〜数週間） | ±25% で動作 |
| Cash | SBI 円預かり・MMF | — | 300万固定 |

---

## 2. 6口座構成

| 口座 | 種別 | 主な用途 |
| :-- | :-- | :-- |
| SBI 特定口座 | 課税 | 個別株・短期投信 |
| SBI NISA 成長投資枠 | 非課税 | 個別株・ETF |
| SBI NISA つみたて枠 | 非課税 | 長期積立投信 |
| SBI iDeCo | 非課税（税控除） | 老後資産・インデックス |
| SBI 外貨建て | 課税 | 外国株・外国投信 |
| 待機資金口座 | 普通/MMF | Capitulation 投入源、Cash 300万 |

---

## 3. 個別株 3ヶ月 Lock ルール

```
- 個別株は取得後 3ヶ月間、売却原則禁止
- UI で以下を表示:
    ロック中 / 売却可否 / 売却可能予定日 / 継続保有理由
- Tier A T1（ストップロス -40%）は Lock 中でも強制発動
- 3ヶ月経過後はレビュー画面で売却可否を判断
```

---

## 4. NISA 枠管理（C23）

```
NISA成長投資枠:  年間 240万円 / 生涯 1,200万円
NISAつみたて枠:  年間  120万円 / 生涯  600万円

UI 表示（Phase 7 で実装）:
- 消化進捗バー（今年 xx万 / 240万）
- 残枠（xxx万円）
- 翌年1月 reset タイマー
```

---

## 5. 800万円 段階投入計画（C3）

Phase 7 で詳細実装。基本方針のみ記載。

```
想定シナリオ:
  Capitulation Signal 発動 → 戦略的現金 400万円 即時投入
  L2 アラート（DD -20%）  → 待機現金から 200万円 段階投入
  通常相場（DD -5%以内）  → 毎月積立のみ

投入先:
  Core層（海外インデックス中心）に優先配分
  残りを Satellite（個別株候補）へ
```

---

## 6. Frontier との関係

```
[初期値]: v3.0 配分が Frontier の出発点（w_init）
[再計算]: Frontier が期待リターン・共分散・制約を元に最適化
[ペナルティ]: v3.0 からの乖離が大きいほど Soft 制約でペナルティ加算
[Hard 制約]: Tier A T1-T4 を最後に強制適用（v3.0より優先）
[表示]: Portfolio 画面で v3.0 との差分（v3_diff.json）を可視化
```

---

## 7. DD-10% 統一リターン KPI（G1・aidatalab）

```python
# 07_spec.md Section 6.3 より
def calc_dd10_uniform_return(returns):
    """
    最大DDを -10% に正規化したときの年率リターン
    aidatalab 4論文の共通ベンチマーク指標
    """
    actual_dd = calc_max_drawdown(returns)
    if actual_dd >= 0:
        return (1 + returns.mean()) ** 12 - 1
    scale = abs(0.10 / actual_dd)
    scaled_returns = returns * scale
    return (1 + scaled_returns.mean()) ** 12 - 1

# 目標: DD-10%統一リターン > +15%
```
