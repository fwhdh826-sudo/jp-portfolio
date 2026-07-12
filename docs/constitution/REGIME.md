# Capital Allocation OS v13.3 — REGIME.md
# Regime Detection 憲法（★v13.3 新規）

**Version**: v13.3
**Last Updated**: 2026-04-26

> Hybrid 3層合議制でレジームを判定し、全 Layer の重みと動作を決定する。
> レジーム判定なしに 6軸重み・戦略重みを決定してはならない。

---

## 1. 5レジーム定義

| レジーム ID | 日本語名 | 概要 |
| :-- | :-- | :-- |
| `bull_calm` | 強気・低ボラ | VIX低・上昇トレンド。Sharpe 最大化フェーズ |
| `bull_volatile` | 強気・高ボラ | 上昇しているが VIX 高め。モメンタム重視 |
| `bear` | 弱気 | 下落トレンド・デスクロス。防御重視、グロース最小化 |
| `crisis` | 危機 | VIX 急騰・大幅下落。SAFE_MODE 自動発動 |
| `uncertain` | 不確実 | 上記いずれにも分類できない。待機・新規最小化 |

---

## 2. Hybrid 3層合議制

### Layer 3.1: Rule-Based（即応）

```python
# backend/engine/regime/rule_based.py

def detect_regime_rule_based(market_data: dict) -> str:
    vix            = market_data["vix"]
    nikkei_5d      = market_data["nikkei_5d_return"]
    nikkei_60ma    = market_data["nikkei_60ma"]
    nikkei_200ma   = market_data["nikkei_200ma"]
    sp500_dd       = market_data["sp500_dd_30d"]

    # Crisis（最優先）
    if vix > 40 or sp500_dd < -0.20:
        return "crisis"

    # Bear
    if nikkei_60ma < nikkei_200ma and sp500_dd < -0.10:
        return "bear"

    # Bull Volatile
    if vix > 25 and nikkei_5d > 0:
        return "bull_volatile"

    # Bull Calm
    if vix < 18 and nikkei_5d >= 0:
        return "bull_calm"

    # Uncertain（デフォルト）
    return "uncertain"
```

### Layer 3.2: HMM（統計）

```python
# backend/engine/regime/hmm_detector.py
# hmmlearn.GaussianHMM(n_components=5, covariance_type="full", n_iter=200)

HMM_FEATURE_SPEC = {
    "feature_count": 5,
    "features": [
        "returns_5d",       # 日経 5日対数リターン（252日 z-score）
        "vix_log",          # log(VIX)（252日 z-score）
        "volume_z",         # 出来高 z-score（60日）
        "spread_high_low",  # (high-low)/close（60日 z-score）
        "sentiment",        # ニュース sentiment 24h 平均
    ],
    "training_data": {
        "min_years": 5,
        "frequency": "daily",
        "source": "yfinance + news_archive"
    }
}

# 3日連続同 State → 確定
# モデルは backend/models/hmm_regime.pkl に永続化
```

### Layer 3.3: LLM Quality Detection（質的）

```python
# backend/engine/regime/llm_quality.py

# LLM へのプロンプト:
# - ニュースサマリー + VIX + 日経5日変動 + USD/JPY を入力
# - bull_calm / bull_volatile / bear / crisis / uncertain で判定
# - 構造変化シグナル（金融危機の兆候・地政学・重大政策変更）を検出
# - JSON: {"regime": "...", "confidence": 0.X, "structural_changes": [...]}
```

---

## 3. 合議制統合ルール

```python
CONSENSUS_RULES = {
    "vote_count_for_acceptance": 2,      # 3層中 2層以上一致 → 採用
    "fallback_when_no_consensus": "uncertain",  # 全不一致 → uncertain
    "weight_per_layer": {
        "rule_based": 0.4,   # 即応性重視
        "hmm":        0.3,   # 統計
        "llm":        0.3,   # 質的
    },
    "tie_break": "prefer_safer",
    # crisis > bear > uncertain > bull_volatile > bull_calm
    "structural_change_override": True,
    # LLM が構造変化を検出した場合は LLM 判定を最優先
}

# 出力 JSON: regime_state.json / regime_history.json / regime_consensus.json
```

---

## 4. レジーム別動作

| レジーム | SAFE_MODE | 新規ポジション | 重み方針 |
| :-- | :-- | :-- | :-- |
| `crisis` | **自動発動** | Capitulation Signal のみ | Frontier 70%、安全性 40% |
| `bear` | OFF | 最小化 | Frontier 50%、安全性 25% |
| `bull_volatile` | OFF | 通常 | モメンタム 25%、Fundamental 30% |
| `bull_calm` | OFF | 通常 | バランス配分 |
| `uncertain` | OFF | 新規抑制 | 等加重（全軸 17%） |

---

## 5. レジーム別 6軸重み（Dynamic Weight Engine / Layer 6）

```python
# backend/engine/dynamic_weight/regime_axis_weights.py

REGIME_AXIS_WEIGHTS = {
    "bull_calm": {
        "value": 0.20, "quality": 0.15, "growth": 0.20,
        "safety": 0.10, "momentum": 0.20, "shareholder_return": 0.15
    },
    "bull_volatile": {
        "value": 0.15, "quality": 0.20, "growth": 0.15,
        "safety": 0.15, "momentum": 0.25, "shareholder_return": 0.10
    },
    "bear": {
        "value": 0.20, "quality": 0.25, "growth": 0.10,
        "safety": 0.25, "momentum": 0.05, "shareholder_return": 0.15
    },
    "crisis": {
        "value": 0.15, "quality": 0.25, "growth": 0.05,
        "safety": 0.40, "momentum": 0.05, "shareholder_return": 0.10
    },
    "uncertain": {
        "value": 0.17, "quality": 0.17, "growth": 0.17,
        "safety": 0.17, "momentum": 0.17, "shareholder_return": 0.15
    }
}
```

---

## 6. レジーム別 戦略重み（Multi-Strategy Engine / Layer 7）

```python
# backend/engine/dynamic_weight/regime_strategy_weights.py

REGIME_STRATEGY_WEIGHTS = {
    "bull_calm": {
        "frontier": 0.40, "quality_size": 0.25,
        "fundamental": 0.20, "cross_factor": 0.15
    },
    "bull_volatile": {
        "frontier": 0.30, "quality_size": 0.20,
        "fundamental": 0.30, "cross_factor": 0.20
    },
    "bear": {
        "frontier": 0.50, "quality_size": 0.10,
        "fundamental": 0.15, "cross_factor": 0.25
    },
    "crisis": {
        "frontier": 0.70, "quality_size": 0.05,
        "fundamental": 0.05, "cross_factor": 0.20
    },
    "uncertain": {
        "frontier": 0.40, "quality_size": 0.20,
        "fundamental": 0.20, "cross_factor": 0.20
    }
}
```

---

## 7. レジーム別 時間軸重み

```python
# backend/engine/dynamic_weight/time_horizon_weights.py

TIME_HORIZON_WEIGHTS = {
    "short_term": {
        "technical_momentum":  0.40,
        "flow_microstructure": 0.20,
        "sentiment":           0.15,
        "fundamental":         0.10,
        "factor_cross":        0.10,
        "regime":              0.05
    },
    "long_term": {
        "fundamental":         0.30,
        "factor_cross":        0.20,
        "quality_value":       0.20,
        "growth":              0.15,
        "shareholder_return":  0.10,
        "regime":              0.05
    }
}
```

---

## 8. 実装ルール

```
✅ レジーム判定は必ず Layer 3 Orchestrator 経由
✅ 重みテーブルは regime_axis_weights.py / regime_strategy_weights.py に集中管理
✅ crisis 検出時は SAFE_MODE を自動発動（Layer 1 Operation に通知）
✅ uncertain の場合は Today 画面に「レジーム判定不安定」警告を表示
✅ 3層全不一致 → uncertain を採用、新規ポジション抑制

❌ scoring 関数内にレジーム重みを直書き → 禁止
❌ Orchestrator を経由しないレジーム変更 → 禁止
❌ HMM モデルを毎回再学習 → 禁止（backend/models/hmm_regime.pkl を再利用）
```

---

## 9. 出力 JSON ファイル

```
public/data/regime_state.json      ← 現在のレジーム + 合議結果
public/data/regime_history.json    ← 過去30日のレジーム推移
public/data/regime_consensus.json  ← 3層各々の投票結果
```

JSON スキーマは `docs/v13.3/07_v13.3_spec.md` Section 11.1 参照。
