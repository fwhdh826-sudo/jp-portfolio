"""
P4-A9c-data-1: ticker mapper 誤爆修正の回帰テスト

テスト対象:
  data/update_news.py の map_tickers()

確認項目:
  - "au" (2文字Latin) が部分一致で 9433 にしない
  - "KDDI" / "ＫＤＤＩ" は 9433 にする
  - CJK alias は従来どおり部分一致で動作する
"""

from data.update_news import map_tickers


class TestAuMisfireFixed:
    def test_cautious_does_not_match_9433(self):
        assert "9433" not in map_tickers("Stocks See Cautious Rise", "")

    def test_australia_does_not_match_9433(self):
        assert "9433" not in map_tickers("Australia raises rates", "")

    def test_pause_does_not_match_9433(self):
        assert "9433" not in map_tickers("Turkey signals prolonged rates pause", "")

    def test_because_authority_does_not_match_9433(self):
        assert "9433" not in map_tickers("because of authority concerns", "")

    def test_au_in_summary_does_not_match_9433(self):
        assert "9433" not in map_tickers("ECB holds", "The bureau cautiously raised rates")


class TestKddiStillMatches:
    def test_kddi_ascii_matches_9433(self):
        assert "9433" in map_tickers("KDDI lifts dividend", "")

    def test_kddi_fullwidth_matches_9433(self):
        assert "9433" in map_tickers("ＫＤＤＩが増配を発表", "")

    def test_kddi_in_summary_matches_9433(self):
        assert "9433" in map_tickers("Japanese telecom news", "KDDI reports record earnings")


class TestCjkAliasSubstringMatching:
    def test_mitsubishi_ufj_cjk_matches_8306(self):
        assert "8306" in map_tickers("三菱UFJが増配", "")

    def test_mitsubishi_shoji_matches_8058(self):
        assert "8058" in map_tickers("三菱商事が好決算", "")

    def test_nintendo_ascii_matches_7974(self):
        assert "7974" in map_tickers("Nintendo announces new Switch", "")

    def test_rakuten_cjk_matches_4755(self):
        assert "4755" in map_tickers("楽天グループが増益", "")
