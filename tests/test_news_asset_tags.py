"""
P4-A9c-data-3: asset class tag付与の回帰テスト

テスト対象:
  data/update_news.py の classify_asset_tags()

確認項目:
  - us_growth / jp_semiconductor タグが正しく付く
  - us_broad / rates タグが正しく付く
  - jp_broad タグが正しく付く（日本語）
  - gold / macro_risk / geopolitical タグが正しく付く
  - reit / dividend タグが正しく付く
  - fx / rates タグが正しく付く
  - social_noise がsocial sourceに付く
  - unknown fallbackが動作する
  - 複数タグの同時付与が動作する
"""

from data.update_news import classify_asset_tags


class TestUsGrowthAndSemiconductor:
    def test_nvidia_ai_nasdaq_hit_us_growth_and_jp_semiconductor(self):
        tags = classify_asset_tags("NVIDIA leads AI chip rally on Nasdaq", "", "Bloomberg")
        assert "us_growth" in tags
        assert "jp_semiconductor" in tags

    def test_tsmc_hits_jp_semiconductor(self):
        tags = classify_asset_tags("TSMC reports record semiconductor orders", "", "Reuters")
        assert "jp_semiconductor" in tags

    def test_nasdaq_hits_us_growth(self):
        tags = classify_asset_tags("Nasdaq jumps on strong tech earnings", "", "Bloomberg")
        assert "us_growth" in tags


class TestUsBroadAndRates:
    def test_sp500_fed_cpi_hit_us_broad_and_rates(self):
        tags = classify_asset_tags("S&P 500 rises as Fed holds rates and CPI cools", "", "Reuters")
        assert "us_broad" in tags
        assert "rates" in tags

    def test_fomc_hits_us_broad(self):
        tags = classify_asset_tags("FOMC minutes show inflation concern", "", "Bloomberg")
        assert "us_broad" in tags

    def test_treasury_yields_hits_rates(self):
        tags = classify_asset_tags("Treasury yields climb after strong payrolls", "", "Reuters")
        assert "rates" in tags


class TestJpBroad:
    def test_nikkei_boj_hit_jp_broad(self):
        tags = classify_asset_tags("日経平均が反発、日銀の政策据え置きを好感", "", "NHK")
        assert "jp_broad" in tags

    def test_nikkei_english_hits_jp_broad(self):
        tags = classify_asset_tags("Nikkei rises as BOJ keeps rates steady", "", "Reuters")
        assert "jp_broad" in tags


class TestGoldAndMacroRisk:
    def test_gold_inflation_geopolitical(self):
        tags = classify_asset_tags("Gold climbs on inflation fears and geopolitical risk", "", "Bloomberg")
        assert "gold" in tags
        assert "macro_risk" in tags
        assert "geopolitical" in tags

    def test_safe_haven_hits_gold(self):
        tags = classify_asset_tags("Investors flee to safe-haven gold amid war tensions", "", "Reuters")
        assert "gold" in tags
        assert "macro_risk" in tags


class TestReitAndDividend:
    def test_jreit_high_dividend_buyback(self):
        tags = classify_asset_tags("J-REIT and high dividend stocks gain on buybacks", "", "Reuters")
        assert "reit" in tags
        assert "dividend" in tags

    def test_japanese_dividend_hits_dividend(self):
        tags = classify_asset_tags("高配当株が上昇、増配発表相次ぐ", "", "NHK")
        assert "dividend" in tags


class TestFxAndRates:
    def test_yen_treasury_yields_rate_hike(self):
        tags = classify_asset_tags("Yen weakens as Treasury yields rise after rate hike fears", "", "Bloomberg")
        assert "fx" in tags
        assert "rates" in tags

    def test_usdjpy_hits_fx(self):
        tags = classify_asset_tags("USD/JPY breaks 155 on dollar strength", "", "Bloomberg")
        assert "fx" in tags

    def test_interest_rates_hit_rates(self):
        tags = classify_asset_tags("Interest rates expected to stay higher for longer", "", "Reuters")
        assert "rates" in tags


class TestSocialNoise:
    def test_reddit_source_gets_social_noise(self):
        tags = classify_asset_tags("Should I buy tech stocks?", "", "reddit r/stocks")
        assert "social_noise" in tags

    def test_reddit_investing_gets_social_noise(self):
        tags = classify_asset_tags("Market thoughts for this week", "", "reddit r/investing")
        assert "social_noise" in tags


class TestUnknownFallback:
    def test_no_match_returns_unknown(self):
        tags = classify_asset_tags("Company announces new office design", "", "Generic")
        assert tags == ["unknown"]

    def test_known_match_does_not_return_unknown(self):
        tags = classify_asset_tags("Gold prices rise", "", "Bloomberg")
        assert "unknown" not in tags


class TestMultipleTags:
    def test_multiple_asset_classes_allowed(self):
        tags = classify_asset_tags("Nikkei and Nasdaq both rally on AI surge", "", "Bloomberg")
        assert "jp_broad" in tags
        assert "us_growth" in tags

    def test_tags_are_sorted_and_deduplicated(self):
        tags1 = classify_asset_tags("Gold and REIT rally", "", "Bloomberg")
        tags2 = classify_asset_tags("Gold and REIT rally", "", "Bloomberg")
        assert tags1 == tags2
        assert tags1 == sorted(set(tags1))


class TestFalsePositiveRegression:
    def test_short_ai_does_not_match_inside_common_words(self):
        # "said", "paid", "raised" contain "ai" as substring — must not fire us_growth
        tags = classify_asset_tags("The company said it paid suppliers and raised prices", "", "Reuters")
        assert "us_growth" not in tags

    def test_dow_does_not_match_downbeat(self):
        # "downbeat" starts with "dow" — must not fire us_broad
        tags = classify_asset_tags("Downbeat outlook weighs on stocks", "", "Reuters")
        assert "us_broad" not in tags

    def test_war_does_not_match_warning(self):
        # "warning" contains "war" as prefix — must not fire geopolitical
        tags = classify_asset_tags("Company issues warning on profit outlook", "", "Reuters")
        assert "geopolitical" not in tags

    def test_meta_does_not_match_metals(self):
        # "metals" contains "meta" as prefix — must not fire us_growth
        tags = classify_asset_tags("Precious metals gain as gold climbs", "", "Bloomberg")
        assert "us_growth" not in tags
        assert "gold" in tags

    def test_nvidia_ai_chip_nasdaq_still_hit_us_growth_and_jp_semiconductor(self):
        # Positive regression: NVIDIA / AI chip / Nasdaq must still fire correctly
        tags = classify_asset_tags("NVIDIA leads AI chip rally on Nasdaq", "", "Bloomberg")
        assert "us_growth" in tags
        assert "jp_semiconductor" in tags

    def test_war_standalone_still_hits_geopolitical(self):
        # "war" as a standalone word must still fire geopolitical
        tags = classify_asset_tags("War in Middle East drives oil prices higher", "", "Reuters")
        assert "geopolitical" in tags

    def test_meta_standalone_still_hits_us_growth(self):
        # "Meta" as a standalone company name must still fire us_growth
        tags = classify_asset_tags("Meta reports record ad revenue beat", "", "Bloomberg")
        assert "us_growth" in tags
