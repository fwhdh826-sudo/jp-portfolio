#!/usr/bin/env python3
"""
P5-B004c: JPX eligible universe（約1552銘柄、data/jpx_universe_provider.py::
JPXUniverseResult）をbulk OHLCVでcheap pre-screenし、sector/newcomer
diversityを保ったbounded shortlist（target 200 / hard max 300）へ絞り込み、
last-good cache付きで返すmodule。

pipeline:
  JPXUniverseResult
    → ticker変換（code + ".T"）
    → batched bulk OHLCV fetch（batch<=400・pacing・rate-limit abort）
    → metrics（liquidity/risk-adjusted momentum/trend-drawdown/stability）
    → floors（main pool / newcomer pool）
    → diversity-preserving shortlist（sector top-1保証・sector cap・
      newcomer cap・target/hard max・deterministic tie-break）
    → cache（atomic write・last-good保護・TTL）

非範囲（このticketでは行わない):
  - production接続。build_candidates_stocks.pyのdefault_universe_provider
    差し替えは行わない。呼び出し側で明示的にJPXUniverseResultを渡す
    必要がある（本モジュールはget_jpx_universe()を自動では呼ばない）。
  - data/jpx_universe_provider.pyの実装変更（importして型/dataのみ使う）。
  - whole-market detail enrichment（build_candidates_stocks.pyの
    enrich_universe()はこのticketの範囲外。shortlist生成後の
    enrichment接続はB004c以降の別ticket）。

honesty:
  scoreは最終投資判断ではなくshortlist順序付けのみに用いる指標であり、
  BUY/SELL/WATCH等の投資判断・銘柄推奨ではない。保有・取引・口座・現金等の
  個人情報は一切参照・保存しない。cacheはinternal only
  （data/.jpx_cache/配下、public/data配下へは一切コピーしない）。

adjusted price契約（重要・明示）:
  yfinance bulk fetchはauto_adjust=Falseで取得し、raw Close（実際の
  取引価格、遡及調整なし）とAdj Close（配当・株式分割で遡及調整済み）を
  区別して扱う。
    - PRICE / LIQUIDITY系列（price floor・ADV20）は raw Close を使う。
      「現在・過去の実際の取引価格・出来高代金」をそのまま表すため。
    - RETURN / MOMENTUM系列（sigma252・risk-adjusted momentum・
      trend・drawdown・stability）は Adj Close を使う。
      株式分割・配当落ちによる非連続を除去した価格変化のみを反映するため。
  この2系列を混同すると、分割直後の銘柄でADVが桁違いになったり、
  配当落ちがdrawdownとして誤検出される等の誤りが生じる。
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, NamedTuple

import numpy as np
import pandas as pd

from data.jpx_universe_provider import JPXUniverseResult

# ---------------------------------------------------------------------------
# 定数
# ---------------------------------------------------------------------------

SHORTLIST_ID = "jpx_cheap_prescreen_v1"
SEED_BYPASS_ID = "seed_list_v1_bypass"

CACHE_PATH = Path(__file__).parent / ".jpx_cache" / "cheap_prescreen_cache.json"
CACHE_SCHEMA_KIND = "jpx_cheap_prescreen_cache_v1"

# --- fetch contract ---------------------------------------------------------

# 1552件一括fetch禁止のハード上限。default_batch_sizeもこれを超えられない。
MAX_BATCH_SIZE = 400
DEFAULT_BATCH_SIZE = 400

# バルクOHLCV取得のcalendar期間。main pool floor(history>=252営業日)を
# 安定して検出できるよう、yfinanceの定義済みperiod文字列のうち1yより
# 大きい"2y"を採用する（1yは日付境界次第で252営業日をわずかに割り込む
# ことがあるため）。newcomerはIPO日以降のデータしか返らないため、この
# 期間指定のままhistory_daysが自然に63〜251件に収まる。
OHLCV_FETCH_PERIOD = "2y"

# batch間のpacing（秒）。デフォルトはtime.sleepベースだが、testsではinjectable。
DEFAULT_PACING_SECONDS = 1.0

# fetch成功率がこの割合未満ならshortlist cacheを更新しない
# （success_ratio = 成功ticker数 / 要求ticker数）。
SUCCESS_RATIO_MIN = 0.70

# --- metrics / floors --------------------------------------------------------

MAIN_MIN_HISTORY_DAYS = 252
MAIN_MIN_ADV20_JPY = 50_000_000.0
MAIN_MIN_PRICE_JPY = 100.0
MAIN_MAX_SIGMA252 = 0.50

NEWCOMER_MIN_HISTORY_DAYS = 63
NEWCOMER_MAX_HISTORY_DAYS = 251  # 252以上はmain pool側
NEWCOMER_MAX_COUNT = 10

MOMENTUM_LOOKBACK_DAYS = 63  # newcomer最小historyに合わせた短期lookback
TREND_SMA_WINDOW = 20
STABILITY_VOL_WINDOW = 20  # rolling volatility window (stability計測用)
TRADING_DAYS_PER_YEAR = 252

# 外れ値対策: 各raw metricをpool内でwinsorizeしてから percentile rank化する。
WINSORIZE_LOWER_PCT = 0.01
WINSORIZE_UPPER_PCT = 0.99

# 推奨weight（named constants化。合計1.0）。
WEIGHT_LIQUIDITY = 0.30
WEIGHT_RISK_ADJ_MOMENTUM = 0.30
WEIGHT_TREND_DRAWDOWN_QUALITY = 0.25
WEIGHT_STABILITY = 0.15

# --- diversity ---------------------------------------------------------------

TARGET_SHORTLIST_SIZE = 200
HARD_MAX_SHORTLIST_SIZE = 300
SECTOR_CAP_RATIO = 0.12
# 12% of target(200) = 24。target固定値に基づく安定したcapとし、
# backfill passでのlist拡大に追随して緩む値にはしない。
SECTOR_CAP = int(TARGET_SHORTLIST_SIZE * SECTOR_CAP_RATIO)

# --- cache TTL -----------------------------------------------------------

SHORTLIST_CACHE_TARGET_TTL_HOURS = 7 * 24
SHORTLIST_CACHE_HARD_EXPIRY_HOURS = 14 * 24


# ---------------------------------------------------------------------------
# 例外
# ---------------------------------------------------------------------------


class PreScreenRateLimitError(RuntimeError):
    """yfinance側のrate limit検出。blind retryはせず、呼び出し側でrun全体を
    abortしlast-good cache（またはseed_list_v1 bypass）へ回す。"""


# ---------------------------------------------------------------------------
# Ticker変換
# ---------------------------------------------------------------------------


def jpx_items_to_tickers(items: list[tuple[str, str, str]]) -> list[str]:
    """(code, name, sector)のリストをyfinance ticker（code + ".T"）へ変換する。
    英字混在code（例: "285A"）はそのまま保持し、大小文字・桁数の変換は行わない。
    順序は入力順を維持する（provider順=決定的な後続処理の前提）。"""
    return [f"{code}.T" for code, _name, _sector in items]


# ---------------------------------------------------------------------------
# Fetch contract: batched bulk OHLCV
# ---------------------------------------------------------------------------


class TickerSeries(NamedTuple):
    """1銘柄分のOHLCV系列（oldest→newest順、同じ長さ・同じ取引日で整列済み）。

    raw_close: 実際の取引終値（分割・配当による遡及調整なし）。
      price floor・ADV20（流動性代金）に用いる。
    adj_close: 配当・株式分割で遡及調整済みの終値。
      sigma252・momentum・trend・drawdown・stabilityに用いる。
    volume: 出来高（株数）。raw_closeとの積でADV20（円建て売買代金）を計算する。
    """

    raw_close: list[float]
    adj_close: list[float]
    volume: list[float]


BatchFetchFn = Callable[[list[str]], dict[str, "TickerSeries | None"]]
PacingFn = Callable[[], None]


def default_pacing_sleep(seconds: float = DEFAULT_PACING_SECONDS) -> PacingFn:
    """batch間pacing用のdefault実装。time.sleep(seconds)を呼ぶ関数を返す
    （呼び出し時に評価するのではなく、関数を返すfactoryにすることでpacing_fn
    のシグネチャ Callable[[], None] を満たす）。"""

    def _sleep() -> None:
        import time

        time.sleep(seconds)

    return _sleep


def _extract_ticker_series(raw_close: Any, adj_close: Any, volume: Any) -> TickerSeries | None:
    """1銘柄分の生系列（等長のfloatシーケンス、NaN/Inf/欠損混在可）から、
    finite（NaN/Inf/欠損でない）な行のみを保持したTickerSeriesを組み立てる。
    3系列いずれかが欠損/非finiteな日は、その日全体を安全に除外する
    （停止銘柄・欠損日を安全処理する）。

    有効な行が1件も無ければNoneを返す（=fetch失敗ticker扱い、fail-soft）。"""

    def _is_finite(x: Any) -> bool:
        try:
            v = float(x)
        except (TypeError, ValueError):
            return False
        return math.isfinite(v)

    n = min(len(raw_close), len(adj_close), len(volume))
    rc: list[float] = []
    ac: list[float] = []
    vol: list[float] = []
    for i in range(n):
        r, a, v = raw_close[i], adj_close[i], volume[i]
        if not (_is_finite(r) and _is_finite(a) and _is_finite(v)):
            continue
        if float(v) < 0:
            continue
        rc.append(float(r))
        ac.append(float(a))
        vol.append(float(v))

    if not rc:
        return None
    return TickerSeries(raw_close=rc, adj_close=ac, volume=vol)


def default_yf_batch_fetch(
    tickers: list[str], period: str = OHLCV_FETCH_PERIOD
) -> dict[str, "TickerSeries | None"]:
    """yfinance.download()を用いた実際のbulk OHLCV fetch。テストでは使わず
    （network非依存DIのためfetch_fnを差し替える）、本番相当の呼び出しのみで
    使われる想定の実装。

    auto_adjust=Falseで明示的に取得し、raw Close（実取引価格）と
    Adj Close（分割/配当調整済み）を区別する（モジュールdocstring
    「adjusted price契約」参照）。

    yfinance側のrate limit（YFRateLimitError）はPreScreenRateLimitErrorへ
    正規化し、blind retryせず呼び出し元がrun全体をabortできるようにする。
    それ以外の例外は空dictを返す（=このbatch全ticker失敗、fail-soft、
    呼び出し元のbulk_fetch_ohlcv側でbatch単位のfail-softとして扱われる）。
    """
    import yfinance as yf

    try:
        from yfinance.exceptions import YFRateLimitError
    except ImportError:  # pragma: no cover - yfinance version差異への保険
        YFRateLimitError = ()  # type: ignore[assignment]

    try:
        raw = yf.download(
            tickers,
            period=period,
            auto_adjust=False,
            group_by="ticker",
            progress=False,
            threads=True,
        )
    except YFRateLimitError as e:
        raise PreScreenRateLimitError(f"yfinance rate limit: {e!r}") from e
    except Exception as e:  # noqa: BLE001 - batch単位のfail-soft
        print(f"[jpx_cheap_prescreen] batch fetch failed: {e!r}", file=sys.stderr)
        return {}

    result: dict[str, TickerSeries | None] = {}
    single = len(tickers) == 1
    for t in tickers:
        try:
            if single:
                frame = raw
            else:
                if t not in raw.columns.get_level_values(0):
                    result[t] = None
                    continue
                frame = raw[t]
            if frame is None or frame.empty:
                result[t] = None
                continue
            raw_close = frame["Close"].tolist() if "Close" in frame.columns else []
            adj_close = (
                frame["Adj Close"].tolist() if "Adj Close" in frame.columns else raw_close
            )
            volume = frame["Volume"].tolist() if "Volume" in frame.columns else []
            result[t] = _extract_ticker_series(raw_close, adj_close, volume)
        except Exception as e:  # noqa: BLE001 - per-ticker fail-soft
            print(f"[jpx_cheap_prescreen] ticker parse failed {t}: {e!r}", file=sys.stderr)
            result[t] = None
    return result


class BulkFetchOutcome(NamedTuple):
    """batched bulk fetchの結果。abortedがTrueの場合はrate limit検出による
    run全体のabortを意味し、seriesの内容に関わらず呼び出し元はshortlist
    cacheを更新してはならない（last-good fallbackへ回す）。"""

    series: dict[str, TickerSeries]
    failed: list[str]
    requested_count: int
    aborted: bool
    abort_reason: str | None
    batches_count: int

    @property
    def success_ratio(self) -> float:
        if self.requested_count == 0:
            return 0.0
        return len(self.series) / self.requested_count


def _chunk(items: list[str], size: int) -> list[list[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def bulk_fetch_ohlcv(
    tickers: list[str],
    batch_size: int = DEFAULT_BATCH_SIZE,
    fetch_fn: BatchFetchFn = default_yf_batch_fetch,
    pacing_fn: PacingFn | None = None,
) -> BulkFetchOutcome:
    """ticker一覧をbatch_size件ずつ（<=MAX_BATCH_SIZE）に分割し、batch間で
    pacing_fnを呼びながらfetch_fnで取得する。

    failure分類:
      - fetch_fnがPreScreenRateLimitErrorを送出 → 即座にrun全体をabortする
        （残りbatchは一切実行しない。blind retryはしない）。
      - fetch_fnがそれ以外の例外を送出、またはtickerに対しNoneを返す
        → そのticker（batch全体、または個別ticker）のみfail-softで
        failedへ記録し、後続batchは継続する。

    1552件一括fetchを防ぐため、batch_sizeはMAX_BATCH_SIZE(400)を超えられない
    （超過時はValueError、silent capはしない=呼び出し側の設定ミスを隠さない）。
    """
    if batch_size > MAX_BATCH_SIZE:
        raise ValueError(
            f"batch_size={batch_size} exceeds MAX_BATCH_SIZE={MAX_BATCH_SIZE}; "
            "bulk fetching the whole ~1552-ticker eligible universe in one "
            "request is forbidden by contract"
        )
    if batch_size <= 0:
        raise ValueError(f"batch_size must be positive, got {batch_size}")

    if pacing_fn is None:
        pacing_fn = default_pacing_sleep()

    batches = _chunk(tickers, batch_size)
    series: dict[str, TickerSeries] = {}
    failed: list[str] = []

    for i, batch in enumerate(batches):
        if i > 0:
            pacing_fn()
        try:
            batch_result = fetch_fn(batch)
        except PreScreenRateLimitError as e:
            remaining = [t for b in batches[i:] for t in b]
            failed.extend(remaining)
            return BulkFetchOutcome(
                series=series,
                failed=failed,
                requested_count=len(tickers),
                aborted=True,
                abort_reason=str(e),
                batches_count=len(batches),
            )
        except Exception as e:  # noqa: BLE001 - batch単位のfail-soft
            print(f"[jpx_cheap_prescreen] batch {i} failed (fail-soft): {e!r}", file=sys.stderr)
            failed.extend(batch)
            continue

        for t in batch:
            s = batch_result.get(t)
            if s is None:
                failed.append(t)
            else:
                series[t] = s

    return BulkFetchOutcome(
        series=series,
        failed=failed,
        requested_count=len(tickers),
        aborted=False,
        abort_reason=None,
        batches_count=len(batches),
    )


# ---------------------------------------------------------------------------
# Metrics（price/liquidity系列=raw、return/momentum系列=adjusted）
# ---------------------------------------------------------------------------


class RawMetrics(NamedTuple):
    """1銘柄分のraw metrics。値が計算不能（履歴不足・NaN/Inf除去後に不足）な
    フィールドはNoneとし、floors判定・rankingの両方で安全に扱われる
    （floors判定はNone不通過、percentile rankはNoneを最低順位として扱う）。"""

    history_days: int
    price: float | None
    adv20_jpy: float | None
    sigma252: float | None
    risk_adj_momentum: float | None
    trend_pct: float | None
    dd_quality: float | None
    stability_raw: float | None


def compute_raw_metrics(series: TickerSeries) -> RawMetrics:
    """TickerSeries（fail-soft後のfinite値のみ・oldest→newest）からraw metrics
    を計算する。history_daysは実際に有効な取引日数
    （NaN/Inf/停止銘柄の欠損日を除いた件数）。"""
    raw = np.asarray(series.raw_close, dtype=float)
    adj = np.asarray(series.adj_close, dtype=float)
    vol = np.asarray(series.volume, dtype=float)
    n = len(raw)

    price = float(raw[-1]) if n >= 1 else None

    adv20_jpy: float | None = None
    if n >= 20:
        turnover = raw[-20:] * vol[-20:]
        adv20_jpy = float(np.mean(turnover))

    adj_returns = np.diff(adj) / adj[:-1] if n >= 2 else np.array([], dtype=float)

    sigma252: float | None = None
    if len(adj_returns) >= 2:
        window = adj_returns[-TRADING_DAYS_PER_YEAR:]
        if len(window) >= 2:
            sigma252 = float(np.std(window, ddof=1) * math.sqrt(TRADING_DAYS_PER_YEAR))

    # risk-adjusted momentum: MOMENTUM_LOOKBACK_DAYS(63)件前の調整終値との
    # 変化率を、同じ63件の価格から得られる62本のadjusted日次returnの
    # annualized volatilityで正規化する（newcomer最小history=63でも
    # 計算可能な境界を保つ）。
    risk_adj_momentum: float | None = None
    if n >= MOMENTUM_LOOKBACK_DAYS and adj[-MOMENTUM_LOOKBACK_DAYS] > 0:
        ret_lb = float(adj[-1] / adj[-MOMENTUM_LOOKBACK_DAYS] - 1)
        window_returns = adj_returns[-(MOMENTUM_LOOKBACK_DAYS - 1):]
        if len(window_returns) >= 2:
            vol_lb = float(np.std(window_returns, ddof=1) * math.sqrt(TRADING_DAYS_PER_YEAR))
            if vol_lb > 0:
                risk_adj_momentum = ret_lb / vol_lb

    trend_pct: float | None = None
    if n >= TREND_SMA_WINDOW:
        sma = float(np.mean(adj[-TREND_SMA_WINDOW:]))
        if sma > 0:
            trend_pct = float(adj[-1] / sma - 1)

    # drawdown quality: 直近min(252,n)件のadjusted終値でのmax drawdown
    # （負値、0が最良）。quality=-abs(max_dd) とすることでascending percentile
    # rankでそのまま「小さいdrawdownほど高順位」になるよう符号を揃える。
    dd_quality: float | None = None
    if n >= 2:
        window = adj[-min(TRADING_DAYS_PER_YEAR, n):]
        running_peak = np.maximum.accumulate(window)
        drawdowns = (window - running_peak) / running_peak
        max_dd = float(np.min(drawdowns))
        dd_quality = -abs(max_dd)

    # stability: 直近min(252,len(adj_returns))件のadjusted日次returnについて
    # STABILITY_VOL_WINDOW(20)日のrolling annualized volatilityを求め、その
    # 標準偏差（volatility-of-volatility）の符号反転を安定性指標とする
    # （rolling volが安定している=stableなほど値が0に近く、rankが高くなる）。
    stability_raw: float | None = None
    if len(adj_returns) >= STABILITY_VOL_WINDOW * 2:
        window = adj_returns[-min(TRADING_DAYS_PER_YEAR, len(adj_returns)):]
        rolling_vol = (
            pd.Series(window).rolling(window=STABILITY_VOL_WINDOW).std(ddof=1)
            * math.sqrt(TRADING_DAYS_PER_YEAR)
        ).dropna()
        if len(rolling_vol) >= 2:
            stability_raw = -float(rolling_vol.std(ddof=1))

    return RawMetrics(
        history_days=n,
        price=price,
        adv20_jpy=adv20_jpy,
        sigma252=sigma252,
        risk_adj_momentum=risk_adj_momentum,
        trend_pct=trend_pct,
        dd_quality=dd_quality,
        stability_raw=stability_raw,
    )


def classify_pool(metrics: RawMetrics) -> str | None:
    """main pool / newcomer pool / 対象外(None) を判定する。

    main: history>=252日 かつ ADV20>=5000万円 かつ price>=100円 かつ
      sigma252<=0.50（いずれか欠損/floor未達ならNone、newcomerへの
      格下げはしない——252日以上の履歴があるのにfloor未達な銘柄は
      単純に対象外）。
    newcomer: history 63〜251日（historyのみが条件。ADV/price/sigma floorは
      課さない——上場間もない銘柄への過剰な足切りを避けるためで、
      newcomer選抜自体はADV優先ソート+cap10で絞る）。
    """
    if metrics.history_days >= MAIN_MIN_HISTORY_DAYS:
        if (
            metrics.adv20_jpy is not None
            and metrics.adv20_jpy >= MAIN_MIN_ADV20_JPY
            and metrics.price is not None
            and metrics.price >= MAIN_MIN_PRICE_JPY
            and metrics.sigma252 is not None
            and metrics.sigma252 <= MAIN_MAX_SIGMA252
        ):
            return "main"
        return None
    if NEWCOMER_MIN_HISTORY_DAYS <= metrics.history_days <= NEWCOMER_MAX_HISTORY_DAYS:
        return "newcomer"
    return None


def _winsorize(values: np.ndarray) -> np.ndarray:
    finite = np.isfinite(values)
    if finite.sum() < 2:
        return values
    lower = float(np.percentile(values[finite], WINSORIZE_LOWER_PCT * 100))
    upper = float(np.percentile(values[finite], WINSORIZE_UPPER_PCT * 100))
    return np.clip(values, lower, upper)


def percentile_rank(values: list[float | None]) -> list[float]:
    """pool内でのpercentile rank（0〜1、値が大きいほど1に近い）を計算する。

    外れ値対策としてwinsorize（1st/99th percentileでclip）してからrankを
    求める。None/NaN/Infは最も不利な順位0.0を割り当てる（安全側 — 計算不能な
    指標を持つ銘柄をshortlistで有利に扱わないため）。同値はmid-rank
    （(count_less + 0.5*(count_equal-1))/(N-1)）でtieを平均化するが、
    最終選抜時のtie-breakは常にcode昇順で行われるため、rank自体の同値は
    決定性を損なわない。"""
    arr = np.array([v if v is not None else np.nan for v in values], dtype=float)
    arr = _winsorize(arr)
    finite = np.isfinite(arr)
    ranks = np.zeros(len(arr), dtype=float)

    finite_count = int(finite.sum())
    if finite_count == 0:
        return ranks.tolist()
    if finite_count == 1:
        idx = int(np.where(finite)[0][0])
        ranks[idx] = 0.5
        return ranks.tolist()

    finite_vals = arr[finite]
    sorted_vals = np.sort(finite_vals)
    N = finite_count
    computed = np.empty(N, dtype=float)
    for i in range(N):
        v = finite_vals[i]
        count_less = int(np.searchsorted(sorted_vals, v, side="left"))
        count_leq = int(np.searchsorted(sorted_vals, v, side="right"))
        count_equal = count_leq - count_less
        computed[i] = (count_less + 0.5 * (count_equal - 1)) / (N - 1)
    ranks[finite] = computed
    return ranks.tolist()


class ScoredCandidate(NamedTuple):
    """floorsを通過しscore付与済みのcandidate。scoreはshortlist順序付け
    専用の指標であり、投資判断・銘柄推奨ではない。"""

    code: str
    name: str
    sector: str
    pool_type: str  # 'main' | 'newcomer'
    score: float
    adv20_jpy: float | None


def build_candidate_pool(
    items: list[tuple[str, str, str]],
    series_by_ticker: dict[str, TickerSeries],
) -> tuple[list[ScoredCandidate], int, int]:
    """items（universe順の(code,name,sector)）とfetch済みseries_by_ticker
    （ticker→TickerSeries、fetch失敗tickerはkeyなし=fail-soft skip）から、
    floorsを通過したmain/newcomer candidateにscoreを付与して返す。

    戻り値: (candidates, main_pool_count, newcomer_pool_count)。
    candidatesの順序はitems順（後段のdiversity選抜で明示的にsortされる
    前提であり、この時点での順序自体には意味を持たせない）。
    """
    raw_rows: list[tuple[str, str, str, str, RawMetrics]] = []
    for code, name, sector in items:
        series = series_by_ticker.get(f"{code}.T")
        if series is None:
            continue
        metrics = compute_raw_metrics(series)
        pool_type = classify_pool(metrics)
        if pool_type is None:
            continue
        raw_rows.append((code, name, sector, pool_type, metrics))

    if not raw_rows:
        return [], 0, 0

    liquidity_ranks = percentile_rank([row[4].adv20_jpy for row in raw_rows])
    momentum_ranks = percentile_rank([row[4].risk_adj_momentum for row in raw_rows])
    trend_ranks = percentile_rank([row[4].trend_pct for row in raw_rows])
    dd_ranks = percentile_rank([row[4].dd_quality for row in raw_rows])
    stability_ranks = percentile_rank([row[4].stability_raw for row in raw_rows])

    candidates: list[ScoredCandidate] = []
    main_count = 0
    newcomer_count = 0
    for i, (code, name, sector, pool_type, metrics) in enumerate(raw_rows):
        trend_dd_composite = 0.5 * trend_ranks[i] + 0.5 * dd_ranks[i]
        score = (
            WEIGHT_LIQUIDITY * liquidity_ranks[i]
            + WEIGHT_RISK_ADJ_MOMENTUM * momentum_ranks[i]
            + WEIGHT_TREND_DRAWDOWN_QUALITY * trend_dd_composite
            + WEIGHT_STABILITY * stability_ranks[i]
        )
        candidates.append(
            ScoredCandidate(
                code=code,
                name=name,
                sector=sector,
                pool_type=pool_type,
                score=float(score),
                adv20_jpy=metrics.adv20_jpy,
            )
        )
        if pool_type == "main":
            main_count += 1
        else:
            newcomer_count += 1

    return candidates, main_count, newcomer_count


# ---------------------------------------------------------------------------
# Diversity-preserving shortlist selection
# ---------------------------------------------------------------------------


class ShortlistSelection(NamedTuple):
    """diversity選抜の結果。entriesはscore降順・code昇順で決定的にsort済み。"""

    entries: list[ScoredCandidate]
    sector_counts: dict[str, int]
    newcomer_count: int
    guaranteed_sector_count: int
    reserved_newcomer_count: int


def select_diversity_shortlist(
    candidates: list[ScoredCandidate],
    target_size: int = TARGET_SHORTLIST_SIZE,
    hard_max_size: int = HARD_MAX_SHORTLIST_SIZE,
    sector_cap: int = SECTOR_CAP,
    newcomer_max: int = NEWCOMER_MAX_COUNT,
) -> ShortlistSelection:
    """diversity-preserving shortlist選抜。

    fill規則（quota/capでtarget_size未達の場合の挙動を明示する）:
      1. newcomer reservation: newcomer pool全体をADV20優先の
         (-adv20, -score, code) でsortし、上位newcomer_max件のみを
         以降の選抜対象に残す（それ以外のnewcomerはこの時点で除外——
         newcomer件数のhard capはsector保証よりも優先する。ADV優先
         ソートである点に注意——scoreそのものではない）。
      2. sector top-1保証: main pool ∪ reserved newcomerをscore降順
         （同点はcode昇順）でsortし、出現したsectorごとに最初の1件
         （=そのsector内最高score）を無条件で選抜する。
      3. primary fill: 残りのcandidateをscore降順で追加するが、
         各sectorの選抜数がsector_capに達したら以降そのsectorの
         candidateはskipする。target_sizeに達するか候補が尽きるまで続ける。
      4. backfill（quota/cap未達時の明示ルール）: primary fillの後
         target_sizeに届いていない場合（sector capで弾かれた候補が
         残っている、またはpool自体が小さい場合）、sector_capを一切
         適用せず、残っている未選抜candidateをscore降順でtarget_sizeに
         達するかpoolが尽きるまで追加する。pool自体が尽きてtarget_size
         未満のまま終わる場合は、実際の件数をそのまま返す（捏造しない）。
      5. どちらの段でもhard_max_sizeは絶対に超えない（target_sizeが
         hard_max_sizeを上回る誤設定に対しても安全な二重ガード）。
      6. すべての同点比較はcode昇順のtie-breakで決定的に解決する
         （同一入力→同一出力）。
    """
    effective_target = min(target_size, hard_max_size)

    newcomers_all = [c for c in candidates if c.pool_type == "newcomer"]
    newcomers_sorted = sorted(
        newcomers_all,
        key=lambda c: (
            -(c.adv20_jpy if c.adv20_jpy is not None else float("-inf")),
            -c.score,
            c.code,
        ),
    )
    reserved_newcomers = newcomers_sorted[:newcomer_max]

    mains = [c for c in candidates if c.pool_type == "main"]
    pool = mains + reserved_newcomers
    pool_sorted = sorted(pool, key=lambda c: (-c.score, c.code))

    selected: list[ScoredCandidate] = []
    selected_codes: set[str] = set()
    sector_counts: dict[str, int] = {}
    seen_sectors: set[str] = set()

    for c in pool_sorted:
        if len(selected) >= hard_max_size:
            break
        if c.sector in seen_sectors:
            continue
        seen_sectors.add(c.sector)
        selected.append(c)
        selected_codes.add(c.code)
        sector_counts[c.sector] = sector_counts.get(c.sector, 0) + 1
    guaranteed_sector_count = len(seen_sectors)

    for c in pool_sorted:
        if len(selected) >= effective_target or len(selected) >= hard_max_size:
            break
        if c.code in selected_codes:
            continue
        if sector_counts.get(c.sector, 0) >= sector_cap:
            continue
        selected.append(c)
        selected_codes.add(c.code)
        sector_counts[c.sector] = sector_counts.get(c.sector, 0) + 1

    if len(selected) < effective_target:
        for c in pool_sorted:
            if len(selected) >= effective_target or len(selected) >= hard_max_size:
                break
            if c.code in selected_codes:
                continue
            selected.append(c)
            selected_codes.add(c.code)
            sector_counts[c.sector] = sector_counts.get(c.sector, 0) + 1

    selected_sorted = sorted(selected, key=lambda c: (-c.score, c.code))
    newcomer_count = sum(1 for c in selected_sorted if c.pool_type == "newcomer")

    return ShortlistSelection(
        entries=selected_sorted,
        sector_counts=dict(sector_counts),
        newcomer_count=newcomer_count,
        guaranteed_sector_count=guaranteed_sector_count,
        reserved_newcomer_count=len(reserved_newcomers),
    )


# ---------------------------------------------------------------------------
# Cache（internal only。data/.jpx_cache/配下、public/dataへは一切コピーしない）
# ---------------------------------------------------------------------------


class ShortlistItem(NamedTuple):
    """公開向けshortlist 1件分。(code, name, sector)部分は既存
    UniverseResult.items契約と同形であり、pool_type/scoreは本モジュール
    固有の付加情報（shortlist順序付け専用、投資判断ではない）。"""

    code: str
    name: str
    sector: str
    pool_type: str
    score: float


def _parse_iso(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _cache_item_valid(item: Any) -> bool:
    """cache items内1要素が(code, name, sector, pool_type, score)契約を
    満たすか（深層検証）。"""
    if not isinstance(item, (list, tuple)) or len(item) != 5:
        return False
    code, name, sector, pool_type, score = item
    if not isinstance(code, str) or not code:
        return False
    if not isinstance(name, str) or not name:
        return False
    if not isinstance(sector, str):
        return False
    if pool_type not in ("main", "newcomer"):
        return False
    if not isinstance(score, (int, float)) or isinstance(score, bool):
        return False
    if not math.isfinite(float(score)):
        return False
    return True


def _cache_payload_valid(payload: Any) -> bool:
    """cacheファイルがschema上有効か（corruption検出。malformed itemsを持つ
    cacheはload_shortlist_cache()でNoneとなり、last-good候補として使われない）。"""
    if not isinstance(payload, dict):
        return False
    if payload.get("schemaKind") != CACHE_SCHEMA_KIND:
        return False
    items = payload.get("items")
    if not isinstance(items, list):
        return False
    if not all(_cache_item_valid(item) for item in items):
        return False
    if _parse_iso(payload.get("generated_at")) is None:
        return False
    if not isinstance(payload.get("success_ratio"), (int, float)):
        return False
    return True


def load_shortlist_cache(path: Path = CACHE_PATH, now: datetime | None = None) -> dict[str, Any] | None:
    """既存shortlist cacheを読み込む。以下いずれかに該当すればNone
    （=last-good fallback候補として使わない）:
      - ファイル不在 / JSON decode失敗 / schema不正・malformed items
      - generated_atがnowより未来（future timestampはinvalid/stale扱い）
      - hard expiry（SHORTLIST_CACHE_HARD_EXPIRY_HOURS=14日）を超過

    target TTL（7日）超過〜hard expiry未満の間はstaleだがlast-good候補として
    有効に扱う（呼び出し元がfallback_used=Trueとして使う）。"""
    if now is None:
        now = datetime.now(timezone.utc)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if not _cache_payload_valid(raw):
        return None

    generated_at = _parse_iso(raw["generated_at"])
    now_aware = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    if generated_at > now_aware:
        return None

    age_hours = (now_aware - generated_at).total_seconds() / 3600
    if age_hours > SHORTLIST_CACHE_HARD_EXPIRY_HOURS:
        return None

    return raw


def save_shortlist_cache(payload: dict[str, Any], path: Path = CACHE_PATH) -> None:
    """cacheを同一ディレクトリの一時ファイルへ書き切ってからatomic replaceする。
    書き込み中断時も既存last-good cacheは無傷のまま残る。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    try:
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def _cache_age_hours(generated_at_iso: str, now: datetime) -> float:
    generated_at = _parse_iso(generated_at_iso)
    if generated_at is None:
        return float("inf")
    now_aware = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    return (now_aware - generated_at).total_seconds() / 3600


def _cache_to_prescreen_result(
    cache_payload: dict[str, Any], now: datetime, fallback_reason: str
) -> "CheapPreScreenResult":
    entries = [ShortlistItem(*item) for item in cache_payload["items"]]
    items = [(e.code, e.name, e.sector) for e in entries]
    return CheapPreScreenResult(
        shortlist_id=cache_payload.get("shortlist_id", SHORTLIST_ID),
        items=items,
        entries=entries,
        generated_at=cache_payload["generated_at"],
        universe_count=cache_payload.get("universe_count", len(items)),
        main_pool_count=cache_payload.get("main_pool_count", 0),
        newcomer_pool_count=cache_payload.get("newcomer_pool_count", 0),
        shortlist_count=len(items),
        target_shortlist=cache_payload.get("target_shortlist", TARGET_SHORTLIST_SIZE),
        hard_max_shortlist=cache_payload.get("hard_max_shortlist", HARD_MAX_SHORTLIST_SIZE),
        success_ratio=float(cache_payload.get("success_ratio", 0.0)),
        fetch_aborted=False,
        abort_reason=None,
        fallback_used=True,
        fallback_reason=fallback_reason,
        cache_age_hours=_cache_age_hours(cache_payload["generated_at"], now),
        bypass_seed_list_v1=False,
    )


def _seed_list_v1_bypass_result(now: datetime, fallback_reason: str) -> "CheapPreScreenResult":
    """hard-expired/no valid cacheの最終fallback。本モジュールはSEED_LISTの
    内容自体を読み込まない（production/build_candidates_stocks.pyへの
    依存を持ち込まないため）——呼び出し側に「このshortlistは使用不能、
    既存のseed_list_v1 default providerをそのまま使うこと」を伝える
    bypass情報（shortlist_id/bypass_seed_list_v1フラグ）のみを返す。"""
    return CheapPreScreenResult(
        shortlist_id=SEED_BYPASS_ID,
        items=[],
        entries=[],
        generated_at=now.isoformat(),
        universe_count=0,
        main_pool_count=0,
        newcomer_pool_count=0,
        shortlist_count=0,
        target_shortlist=TARGET_SHORTLIST_SIZE,
        hard_max_shortlist=HARD_MAX_SHORTLIST_SIZE,
        success_ratio=0.0,
        fetch_aborted=False,
        abort_reason=None,
        fallback_used=True,
        fallback_reason=fallback_reason,
        cache_age_hours=None,
        bypass_seed_list_v1=True,
    )


# ---------------------------------------------------------------------------
# Main entrypoint
# ---------------------------------------------------------------------------


class CheapPreScreenResult(NamedTuple):
    """本モジュールの戻り値。既存UniverseResult(universe_id, items)契約と
    互換なitemsフィールドに加え、pool内訳・fetch/cache provenanceを含む。

    このticketではCheapPreScreenResultをdata/build_candidates_stocks.pyの
    UniverseProviderとして直接接続しない（production接続は別ticket）。"""

    shortlist_id: str
    items: list[tuple[str, str, str]]
    entries: list[ShortlistItem]
    generated_at: str
    universe_count: int
    main_pool_count: int
    newcomer_pool_count: int
    shortlist_count: int
    target_shortlist: int
    hard_max_shortlist: int
    success_ratio: float
    fetch_aborted: bool
    abort_reason: str | None
    fallback_used: bool
    fallback_reason: str | None
    cache_age_hours: float | None
    bypass_seed_list_v1: bool


def build_cheap_prescreen_shortlist(
    universe: JPXUniverseResult,
    now: datetime | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    fetch_fn: BatchFetchFn = default_yf_batch_fetch,
    pacing_fn: PacingFn | None = None,
    cache_path: Path = CACHE_PATH,
    target_size: int = TARGET_SHORTLIST_SIZE,
    hard_max_size: int = HARD_MAX_SHORTLIST_SIZE,
) -> CheapPreScreenResult:
    """cheap pre-screen pipelineの主エントリポイント。

    universe（呼び出し側が明示的に渡すJPXUniverseResult。本関数は
    get_jpx_universe()を自身では呼ばない=production非接続）を起点に、
    ticker変換→batched bulk fetch→metrics→floors→diversity shortlist→
    cache保存までを実行する。

    failure chain（last-good保護）:
      1. rate limit検出でrun abort → valid last-good cache（あれば）、
         なければseed_list_v1 bypass情報。cacheは更新しない。
      2. fetch成功率(success_ratio) < SUCCESS_RATIO_MIN(0.70)
         → 同上（新結果を計算しても採用/cache更新しない——
         全滅（success_ratio=0）の場合も同じ経路でvalid last-goodへ回る）。
      3. 成功率>=0.70 → 新shortlistを計算しcacheをatomic更新、
         fallback_used=Falseで返す。
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if pacing_fn is None:
        pacing_fn = default_pacing_sleep()

    cache_payload = load_shortlist_cache(cache_path, now)

    tickers = jpx_items_to_tickers(universe.items)
    bulk = bulk_fetch_ohlcv(tickers, batch_size=batch_size, fetch_fn=fetch_fn, pacing_fn=pacing_fn)

    if bulk.aborted:
        reason = f"rate_limit_abort: {bulk.abort_reason}"
        print(f"[jpx_cheap_prescreen] {reason}; aborting without cache update", file=sys.stderr)
        if cache_payload is not None:
            return _cache_to_prescreen_result(cache_payload, now, reason)
        return _seed_list_v1_bypass_result(now, reason)

    success_ratio = bulk.success_ratio
    if success_ratio < SUCCESS_RATIO_MIN:
        reason = (
            f"success_ratio {success_ratio:.4f} below floor {SUCCESS_RATIO_MIN} "
            f"({len(bulk.series)}/{bulk.requested_count} tickers succeeded)"
        )
        print(f"[jpx_cheap_prescreen] {reason}; shortlist cache not updated", file=sys.stderr)
        if cache_payload is not None:
            return _cache_to_prescreen_result(cache_payload, now, reason)
        return _seed_list_v1_bypass_result(now, reason)

    candidates, main_count, newcomer_count = build_candidate_pool(universe.items, bulk.series)
    selection = select_diversity_shortlist(candidates, target_size=target_size, hard_max_size=hard_max_size)

    entries = [
        ShortlistItem(code=c.code, name=c.name, sector=c.sector, pool_type=c.pool_type, score=c.score)
        for c in selection.entries
    ]
    out_items = [(e.code, e.name, e.sector) for e in entries]
    generated_at_iso = now.isoformat()

    save_shortlist_cache(
        {
            "schemaKind": CACHE_SCHEMA_KIND,
            "shortlist_id": SHORTLIST_ID,
            "generated_at": generated_at_iso,
            "items": [[e.code, e.name, e.sector, e.pool_type, e.score] for e in entries],
            "universe_count": len(universe.items),
            "main_pool_count": main_count,
            "newcomer_pool_count": newcomer_count,
            "success_ratio": success_ratio,
            "target_shortlist": target_size,
            "hard_max_shortlist": hard_max_size,
            "sector_counts": selection.sector_counts,
        },
        cache_path,
    )

    return CheapPreScreenResult(
        shortlist_id=SHORTLIST_ID,
        items=out_items,
        entries=entries,
        generated_at=generated_at_iso,
        universe_count=len(universe.items),
        main_pool_count=main_count,
        newcomer_pool_count=newcomer_count,
        shortlist_count=len(entries),
        target_shortlist=target_size,
        hard_max_shortlist=hard_max_size,
        success_ratio=success_ratio,
        fetch_aborted=False,
        abort_reason=None,
        fallback_used=False,
        fallback_reason=None,
        cache_age_hours=0.0,
        bypass_seed_list_v1=False,
    )
