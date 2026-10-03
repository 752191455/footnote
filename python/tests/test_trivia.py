from footnote.trivia import (
    CODE_LENGTH,
    ScoredSubmission,
    article_html_to_text,
    extract_json_object,
    generate_room_code,
    normalize_room_code,
    rank_players,
    score_answer,
    tally_player,
    validate_generated_questions,
)


def identity(items):
    return list(items)


def reverse(items):
    return list(items)[::-1]


def test_score_wrong_is_zero():
    assert score_answer(correct=False, elapsed_ms=0, duration_ms=20_000, streak=1) == 0


def test_score_speed_linear():
    base = dict(correct=True, duration_ms=20_000, streak=1)
    assert score_answer(**base, elapsed_ms=0) == 1000
    assert score_answer(**base, elapsed_ms=10_000) == 750
    assert score_answer(**base, elapsed_ms=20_000) == 500


def test_score_clamps_elapsed():
    base = dict(correct=True, duration_ms=20_000, streak=1)
    assert score_answer(**base, elapsed_ms=21_500) == 500
    assert score_answer(**base, elapsed_ms=-50) == 1000


def test_score_streak_cap():
    base = dict(correct=True, elapsed_ms=20_000, duration_ms=20_000)
    assert score_answer(**base, streak=3) == 600
    assert score_answer(**base, streak=50) == 750


def test_room_codes():
    for _ in range(200):
        code = generate_room_code()
        assert len(code) == CODE_LENGTH
        assert all(c in "ABCDEFGHJKLMNPQRSTUVWXYZ" for c in code)
    assert normalize_room_code(" ab-cd ") == "ABCD"
    assert normalize_room_code("abcdefg") == "ABCD"


def test_article_html_to_text():
    html = """
      <style>.x{}</style>
      <table><tr><td>Infobox noise that should vanish entirely</td></tr></table>
      <p>Short.</p>
      <p>The <b>octopus</b> is a soft-bodied, eight-limbed mollusc&nbsp;of the order Octopoda.<sup class="reference">[1]</sup></p>
      <p>Octopuses have three hearts and blue blood, and can change colour in milliseconds.[2]</p>"""
    text = article_html_to_text(html)
    assert "The octopus is a soft-bodied, eight-limbed mollusc of the order Octopoda." in text
    assert "three hearts" in text
    assert "Infobox" not in text
    assert "Short." not in text
    assert ".x" not in text
    p = f"<p>{'word ' * 400}</p>"
    assert len(article_html_to_text(p * 10, 1000)) <= 1000


def test_extract_json_object():
    assert extract_json_object('Sure!\n```json\n{"a":1}\n```') == {"a": 1}
    assert extract_json_object("no json") is None
    assert extract_json_object("{broken") is None


GOOD = {
    "prompt": "How many hearts does an octopus have?",
    "choices": ["One", "Two", "Three", "Four"],
    "correctIndex": 2,
    "explanation": "Octopuses have three hearts.",
    "source": 0,
}


def test_validate_keeps_valid():
    [q] = validate_generated_questions({"questions": [GOOD]}, 1, identity)
    assert q.choices == GOOD["choices"]
    assert q.correct_index == 2
    assert q.source_index == 0


def test_validate_tracks_shuffle():
    [q] = validate_generated_questions({"questions": [GOOD]}, 1, reverse)
    assert q.choices == ["Four", "Three", "Two", "One"]
    assert q.choices[q.correct_index] == "Three"


def test_validate_drops_bad():
    out = validate_generated_questions(
        {
            "questions": [
                GOOD,
                {**GOOD},
                {**GOOD, "prompt": "Which is unsourced here?", "source": 3},
                {**GOOD, "prompt": "Which has repeated choices?", "choices": ["A", "a", "B", "C"]},
                {**GOOD, "prompt": "Which has three choices?", "choices": ["A", "B", "C"]},
                {**GOOD, "prompt": "Which has a bad index?", "correctIndex": 4},
                "not an object",
            ]
        },
        1,
        identity,
    )
    assert len(out) == 1


def test_validate_non_list():
    assert validate_generated_questions(None, 1) == []
    assert validate_generated_questions({"questions": "nope"}, 1) == []


def test_rank_players():
    ranked = rank_players(
        [
            {"userId": "a", "name": "Ann", "score": 900},
            {"userId": "b", "name": "Bo", "score": 1200},
            {"userId": "c", "name": "Cy", "score": 900},
            {"userId": "d", "name": "Di", "score": 0},
        ]
    )
    assert [(p["userId"], p["rank"]) for p in ranked] == [
        ("b", 1),
        ("a", 2),
        ("c", 2),
        ("d", 4),
    ]


def test_tally_rebuilds():
    d = 20_000
    subs = {
        0: ScoredSubmission(choice=1, correct=True, points=800),
        1: ScoredSubmission(choice=2, correct=True, points=650),
        2: ScoredSubmission(choice=3, elapsed_ms=0),
    }
    t = tally_player(subs, 2, 3, d)
    assert t.current_correct is True
    assert t.current_points == 1100
    assert (t.score, t.streak, t.correct_count, t.last_points) == (2550, 3, 3, 1100)


def test_tally_skip_resets_streak():
    d = 20_000
    subs = {
        0: ScoredSubmission(choice=0, correct=True, points=900),
        2: ScoredSubmission(choice=1, elapsed_ms=d),
    }
    t = tally_player(subs, 2, 1, d)
    assert (t.score, t.streak, t.correct_count, t.last_points) == (1400, 1, 2, 500)


def test_tally_idempotent():
    d = 20_000
    subs = {0: ScoredSubmission(choice=2, elapsed_ms=5_000)}
    first = tally_player(subs, 0, 2, d)
    subs[0] = ScoredSubmission(
        choice=2,
        elapsed_ms=5_000,
        correct=first.current_correct,
        points=first.current_points,
    )
    second = tally_player(subs, 0, 2, d)
    assert first == second


def test_tally_empty():
    t = tally_player({}, 1, 0, 20_000)
    assert (t.score, t.streak, t.correct_count, t.last_points) == (0, 0, 0, 0)
