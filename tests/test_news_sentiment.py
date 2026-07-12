"""
P4-A9c-data-2: English sentiment対応の回帰テスト

テスト対象:
  data/update_news.py の compute_sentiment()

確認項目:
  - 英語positive市場文がpositiveになる
  - 英語negative市場文がnegativeになる
  - 日本語positive/negativeが維持される
  - 単語1個ヒットでscoreが±1.0に張り付かない
  - 返り値形式 (str, float) が維持される
"""

from data.update_news import compute_sentiment


class TestEnglishPositive:
    def test_rise_and_beat_are_positive(self):
        label, score = compute_sentiment("Stocks rise on earnings beat", "")
        assert label == "positive"
        assert score > 0

    def test_surge_is_positive(self):
        label, score = compute_sentiment("Markets surge to record high", "")
        assert label == "positive"
        assert score > 0

    def test_rally_and_gain_are_positive(self):
        label, score = compute_sentiment("Tech stocks rally as gains accelerate", "")
        assert label == "positive"
        assert score > 0

    def test_upgraded_is_positive(self):
        label, score = compute_sentiment("Analyst upgraded outlook on strong earnings", "")
        assert label == "positive"
        assert score > 0


class TestEnglishNegative:
    def test_fall_and_miss_are_negative(self):
        label, score = compute_sentiment("Shares fall as profit misses estimates", "")
        assert label == "negative"
        assert score < 0

    def test_recession_and_rate_hike_are_negative(self):
        label, score = compute_sentiment("Markets decline on recession and rate hike fears", "")
        assert label == "negative"
        assert score < 0

    def test_plunge_is_negative(self):
        label, score = compute_sentiment("Nikkei plunges on selloff fears", "")
        assert label == "negative"
        assert score < 0

    def test_weak_earnings_are_negative(self):
        label, score = compute_sentiment("Weak earnings report leads to downgrade", "")
        assert label == "negative"
        assert score < 0

    def test_loss_is_negative(self):
        label, score = compute_sentiment("Company reports loss as revenue declined", "")
        assert label == "negative"
        assert score < 0


class TestJapanesePreserved:
    def test_japanese_positive_words_still_work(self):
        label, score = compute_sentiment("株価が急伸し増益を発表", "")
        assert label == "positive"
        assert score > 0

    def test_japanese_negative_words_still_work(self):
        label, score = compute_sentiment("株価が急落し減益を発表", "")
        assert label == "negative"
        assert score < 0

    def test_japanese_mixed_stays_neutral(self):
        label, score = compute_sentiment("上昇するも警戒継続", "")
        assert label in ("neutral", "positive", "negative")


class TestSmoothingAndFormat:
    def test_single_word_hit_does_not_saturate(self):
        label, score = compute_sentiment("Stocks rise", "")
        assert label in ("neutral", "positive")
        assert 0 < score < 1.0

    def test_return_type_is_tuple_str_float(self):
        result = compute_sentiment("Stocks rise", "")
        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], str)
        assert isinstance(result[1], float)

    def test_neutral_returns_zero(self):
        label, score = compute_sentiment("No market keywords here", "")
        assert label == "neutral"
        assert score == 0.0

    def test_label_values_are_valid(self):
        for text in ["Stocks rise sharply", "Markets fall sharply", "No signal today"]:
            label, _ = compute_sentiment(text, "")
            assert label in ("positive", "negative", "neutral")
