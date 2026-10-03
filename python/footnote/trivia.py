"""Pure Footnote game logic. No I/O. Port of src/lib/trivia.ts."""

from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence, TypeVar

LIMITS = {
    "minQuestions": 3,
    "maxQuestions": 12,
    "minSeconds": 10,
    "maxSeconds": 45,
    "topicMaxLength": 80,
    "gamesPerDay": 10,
    "answerGraceMs": 1500,
}

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_LENGTH = 4

SCORING = {"base": 500, "speedBonus": 500, "streakStep": 50, "streakCap": 5}

T = TypeVar("T")
Shuffle = Callable[[list[T]], list[T]]


def generate_room_code(rng: random.Random | None = None) -> str:
    pick = rng.randrange if rng else random.randrange
    return "".join(CODE_ALPHABET[pick(len(CODE_ALPHABET))] for _ in range(CODE_LENGTH))


def normalize_room_code(value: str) -> str:
    return re.sub(r"[^A-Z]", "", value.upper())[:CODE_LENGTH]


def score_answer(*, correct: bool, elapsed_ms: int, duration_ms: int, streak: int) -> int:
    if not correct:
        return 0
    if duration_ms <= 0:
        t = 1.0
    else:
        t = min(1.0, max(0.0, elapsed_ms / duration_ms))
    speed = round(SCORING["speedBonus"] * (1 - t))
    streak_bonus = SCORING["streakStep"] * min(SCORING["streakCap"], max(0, streak - 1))
    return SCORING["base"] + speed + streak_bonus


@dataclass(frozen=True)
class ScoredSubmission:
    choice: int
    elapsed_ms: int | None = None
    correct: bool | None = None
    points: int | None = None


@dataclass(frozen=True)
class PlayerTally:
    score: int
    streak: int
    correct_count: int
    last_points: int
    current_correct: bool
    current_points: int


def tally_player(
    subs_by_index: Mapping[int, ScoredSubmission],
    up_to_index: int,
    correct_index: int,
    duration_ms: int,
) -> PlayerTally:
    score = 0
    streak = 0
    correct_count = 0
    current_correct = False
    current_points = 0
    for i in range(up_to_index + 1):
        sub = subs_by_index.get(i)
        is_current = i == up_to_index
        if is_current:
            correct = bool(sub) and sub.choice == correct_index
        else:
            correct = bool(sub and sub.correct is True)
        streak = streak + 1 if correct else 0
        if is_current:
            points = score_answer(
                correct=correct,
                elapsed_ms=sub.elapsed_ms if sub and sub.elapsed_ms is not None else duration_ms,
                duration_ms=duration_ms,
                streak=streak,
            )
            current_correct = correct
            current_points = points
        else:
            points = sub.points if sub and sub.points is not None else 0
        score += points
        if correct:
            correct_count += 1
    return PlayerTally(score, streak, correct_count, current_points, current_correct, current_points)


ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
    "&#160;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
}


def _decode_entity(match: re.Match[str]) -> str:
    return ENTITIES.get(match.group(0).lower(), " ")


def article_html_to_text(html: str, max_chars: int = 6000) -> str:
    cleaned = re.sub(r"<(script|style)[\s\S]*?</\1>", "", html, flags=re.I)
    cleaned = re.sub(
        r'<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?</sup>',
        "",
        cleaned,
        flags=re.I,
    )
    paragraphs: list[str] = []
    total = 0
    for match in re.finditer(r"<p[^>]*>([\s\S]*?)</p>", cleaned, flags=re.I):
        if total >= max_chars:
            break
        text = re.sub(r"<[^>]+>", "", match.group(1))
        text = re.sub(r"&[#a-z0-9]+;", _decode_entity, text, flags=re.I)
        text = re.sub(r"\[\d+\]", "", text)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < 40:
            continue
        paragraphs.append(text)
        total += len(text)
    return "\n\n".join(paragraphs)[:max_chars]


def wikipedia_url(title: str) -> str:
    from urllib.parse import quote

    return f"https://en.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"


def extract_json_object(text: str) -> Any:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None


@dataclass(frozen=True)
class ValidQuestion:
    prompt: str
    choices: list[str]
    correct_index: int
    explanation: str
    source_index: int


def shuffle_array(items: Sequence[T], rng: random.Random | None = None) -> list[T]:
    out = list(items)
    (rng or random).shuffle(out)
    return out


def validate_generated_questions(
    raw: Any,
    source_count: int,
    shuffle: Shuffle[int] | None = None,
) -> list[ValidQuestion]:
    shuffle_fn = shuffle or (lambda items: shuffle_array(items))
    questions = raw.get("questions") if isinstance(raw, dict) else None
    if not isinstance(questions, list):
        return []
    seen: set[str] = set()
    out: list[ValidQuestion] = []
    for item in questions:
        parsed = _parse_generated(item)
        if parsed is None:
            continue
        prompt, choices, correct_index, explanation, source = parsed
        if source >= source_count:
            continue
        if len({c.lower() for c in choices}) != 4:
            continue
        key = prompt.lower()
        if key in seen:
            continue
        seen.add(key)
        order = shuffle_fn([0, 1, 2, 3])
        out.append(
            ValidQuestion(
                prompt=prompt,
                choices=[choices[i] for i in order],
                correct_index=order.index(correct_index),
                explanation=explanation,
                source_index=source,
            )
        )
    return out


def _parse_generated(item: Any) -> tuple[str, list[str], int, str, int] | None:
    if not isinstance(item, dict):
        return None
    prompt = item.get("prompt")
    choices = item.get("choices")
    correct = item.get("correctIndex")
    source = item.get("source")
    explanation = item.get("explanation") or ""
    if not isinstance(prompt, str) or not (8 <= len(prompt) <= 300):
        return None
    if not isinstance(choices, list) or len(choices) != 4:
        return None
    if not all(isinstance(c, str) and 1 <= len(c) <= 120 for c in choices):
        return None
    if not isinstance(correct, int) or not 0 <= correct <= 3:
        return None
    if not isinstance(source, int) or source < 0:
        return None
    if not isinstance(explanation, str) or len(explanation) > 400:
        return None
    return prompt.strip(), [c.strip() for c in choices], correct, explanation.strip(), source


def rank_players(players: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    sorted_rows = sorted(
        players,
        key=lambda p: (-(p.get("score") or 0), str(p.get("name") or "")),
    )
    ranked: list[dict[str, Any]] = []
    prev: int | None = None
    rank = 0
    for i, player in enumerate(sorted_rows):
        score = player.get("score") or 0
        if score != prev:
            rank = i + 1
        prev = score
        ranked.append({**dict(player), "rank": rank})
    return ranked
