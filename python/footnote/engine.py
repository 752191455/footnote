"""In-memory, server-authoritative Footnote rooms."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .generate import GenerationError, generate_quiz
from .trivia import (
    LIMITS,
    ScoredSubmission,
    generate_room_code,
    normalize_room_code,
    tally_player,
)

MAX_PLAYERS = 30
HOST_AWAY_MS = 20_000
Broadcast = Callable[[str], Awaitable[None]]


def now_ms() -> int:
    return int(time.time() * 1000)


def clamp_int(value: Any, lo: int, hi: int, fallback: int) -> int:
    try:
        n = round(float(value))
    except (TypeError, ValueError):
        return fallback
    return min(hi, max(lo, int(n)))


@dataclass
class Player:
    user_id: str
    name: str
    score: int = 0
    streak: int = 0
    correct_count: int = 0
    last_answered_index: int = -1
    last_points: int = 0


@dataclass
class Question:
    index: int
    prompt: str
    choices: list[str]
    source_title: str
    source_url: str
    correct_index: int | None = None
    explanation: str | None = None
    distribution: list[int] | None = None


@dataclass
class AnswerKey:
    correct_index: int
    explanation: str


@dataclass
class Submission:
    index: int
    user_id: str
    choice: int
    elapsed_ms: int
    correct: bool | None = None
    points: int | None = None


@dataclass
class Game:
    id: str
    code: str
    topic: str
    host_id: str
    host_name: str
    status: str
    current_index: int
    question_started_at: int
    revealed_at: int
    seconds_per_question: int
    question_count: int
    sources: list[dict[str, str]]
    generation_error: str = ""
    generation_progress: float = 0
    generation_message: str = ""
    created_at: int = field(default_factory=now_ms)
    players: dict[str, Player] = field(default_factory=dict)
    questions: list[Question] = field(default_factory=list)
    keys: dict[int, AnswerKey] = field(default_factory=dict)
    submissions: dict[tuple[int, str], Submission] = field(default_factory=dict)
    viewers: set[str] = field(default_factory=set)


class ActionError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class Store:
    def __init__(self) -> None:
        self.games: dict[str, Game] = {}
        self.by_code: dict[str, str] = {}
        self._lock = asyncio.Lock()
        self.broadcast: Broadcast | None = None

    async def _notify(self, game: Game) -> None:
        if self.broadcast:
            await self.broadcast(game.id)

    def public_snapshot(self, game: Game, user_id: str) -> dict[str, Any]:
        me = game.players.get(user_id)
        my_subs = [s for (idx, uid), s in game.submissions.items() if uid == user_id]
        current = next((q for q in game.questions if q.index == game.current_index), None)
        show_answer = game.status in ("reveal", "finished")
        question = None
        if current and game.status in ("question", "reveal", "finished"):
            question = {
                "index": current.index,
                "prompt": current.prompt,
                "choices": current.choices,
                "sourceTitle": current.source_title,
                "sourceUrl": current.source_url,
                "correctIndex": current.correct_index if show_answer else None,
                "explanation": current.explanation if show_answer else None,
                "distribution": current.distribution if show_answer else None,
            }
        return {
            "now": now_ms(),
            "game": {
                "id": game.id,
                "code": game.code,
                "topic": game.topic,
                "hostId": game.host_id,
                "hostName": game.host_name,
                "status": game.status,
                "currentIndex": game.current_index,
                "questionStartedAt": game.question_started_at,
                "revealedAt": game.revealed_at,
                "secondsPerQuestion": game.seconds_per_question,
                "questionCount": game.question_count,
                "sources": game.sources if game.status != "generating" else [],
                "generationError": game.generation_error,
                "generationProgress": game.generation_progress,
                "generationMessage": game.generation_message,
            },
            "players": [
                {
                    "userId": p.user_id,
                    "name": p.name,
                    "score": p.score,
                    "streak": p.streak,
                    "correctCount": p.correct_count,
                    "lastAnsweredIndex": p.last_answered_index,
                    "lastPoints": p.last_points,
                    "online": p.user_id in game.viewers,
                    "isHost": p.user_id == game.host_id,
                }
                for p in game.players.values()
            ],
            "me": None
            if not me
            else {
                "userId": me.user_id,
                "name": me.name,
                "score": me.score,
                "streak": me.streak,
                "correctCount": me.correct_count,
                "lastAnsweredIndex": me.last_answered_index,
                "lastPoints": me.last_points,
            },
            "question": question,
            "mySub": next(
                (
                    {
                        "index": s.index,
                        "choice": s.choice,
                        "elapsedMs": s.elapsed_ms,
                        "correct": s.correct if show_answer else None,
                        "points": s.points if show_answer else None,
                    }
                    for s in my_subs
                    if s.index == game.current_index
                ),
                None,
            ),
        }

    def _unique_code(self) -> str:
        for _ in range(8):
            code = generate_room_code()
            gid = self.by_code.get(code)
            if not gid:
                return code
            existing = self.games.get(gid)
            if not existing or existing.status in ("finished", "failed"):
                return code
        return generate_room_code()

    def _hosted_today(self, user_id: str) -> int:
        cutoff = now_ms() - 24 * 60 * 60 * 1000
        return sum(1 for g in self.games.values() if g.host_id == user_id and g.created_at > cutoff)

    async def create_game(
        self,
        user_id: str,
        name: str,
        topic: str,
        question_count: Any,
        seconds: Any,
        client,
    ) -> Game:
        topic = topic.strip()[: LIMITS["topicMaxLength"]]
        if len(topic) < 2:
            raise ActionError("Pick a topic first.")
        count = clamp_int(question_count, LIMITS["minQuestions"], LIMITS["maxQuestions"], 8)
        seconds_n = clamp_int(seconds, LIMITS["minSeconds"], LIMITS["maxSeconds"], 20)
        async with self._lock:
            if self._hosted_today(user_id) >= LIMITS["gamesPerDay"]:
                raise ActionError(f"You've hosted {LIMITS['gamesPerDay']} games today — the daily limit. Try again tomorrow.")
            code = self._unique_code()
            game = Game(
                id=uuid.uuid4().hex,
                code=code,
                topic=topic,
                host_id=user_id,
                host_name=name[:40] or "Player",
                status="generating",
                current_index=0,
                question_started_at=0,
                revealed_at=0,
                seconds_per_question=seconds_n,
                question_count=count,
                sources=[],
                generation_message="Opening Wikipedia…",
            )
            game.players[user_id] = Player(user_id=user_id, name=game.host_name)
            self.games[game.id] = game
            self.by_code[code] = game.id

        async def run() -> None:
            def progress(value: float, message: str) -> None:
                game.generation_progress = value
                game.generation_message = message
                asyncio.create_task(self._notify(game))

            try:
                questions, sources = await generate_quiz(client, topic, count, progress)
                async with self._lock:
                    game.keys = {
                        i: AnswerKey(q.correct_index, q.explanation) for i, q in enumerate(questions)
                    }
                    game.questions = [
                        Question(
                            index=i,
                            prompt=q.prompt,
                            choices=q.choices,
                            source_title=sources[q.source_index].title,
                            source_url=sources[q.source_index].url,
                        )
                        for i, q in enumerate(questions)
                    ]
                    game.question_count = len(questions)
                    game.sources = [{"title": s.title, "url": s.url} for s in sources]
                    game.status = "lobby"
                    game.generation_progress = 1
                    game.generation_message = f"{len(questions)} questions ready"
            except GenerationError as err:
                game.status = "failed"
                game.generation_error = str(err)
            except Exception:
                game.status = "failed"
                game.generation_error = "Something went wrong while writing the quiz. Try again."
            await self._notify(game)

        asyncio.create_task(run())
        await self._notify(game)
        return game

    def game_by_code(self, code: str) -> Game | None:
        gid = self.by_code.get(normalize_room_code(code))
        return self.games.get(gid) if gid else None

    async def join(self, code: str, user_id: str, name: str) -> Game:
        code = normalize_room_code(code)
        if not code:
            raise ActionError("Enter a room code.")
        async with self._lock:
            game = self.game_by_code(code)
            if not game:
                raise ActionError(f"No game with code {code}.")
            if user_id in game.players:
                return game
            if game.status == "finished":
                raise ActionError("That game has already finished.")
            if game.status == "failed":
                raise ActionError("That game could not be set up.")
            if len(game.players) >= MAX_PLAYERS:
                raise ActionError("That room is full.")
            game.players[user_id] = Player(user_id=user_id, name=(name or "Player")[:40])
        await self._notify(game)
        return game

    async def start(self, game_id: str, user_id: str) -> Game:
        async with self._lock:
            game = self.games.get(game_id)
            if not game:
                raise ActionError("Game not found.")
            if game.host_id != user_id:
                raise ActionError("Only the host can start the game.")
            if game.status != "lobby":
                return game
            game.status = "question"
            game.current_index = 0
            game.question_started_at = now_ms()
        await self._notify(game)
        return game

    async def submit(self, game_id: str, user_id: str, index: int, choice: int) -> Game:
        async with self._lock:
            game = self.games.get(game_id)
            if not game:
                raise ActionError("Game not found.")
            if choice not in (0, 1, 2, 3):
                raise ActionError("Invalid choice.")
            if game.status != "question" or game.current_index != index:
                raise ActionError("This question is closed.")
            elapsed = now_ms() - game.question_started_at
            if elapsed > game.seconds_per_question * 1000 + LIMITS["answerGraceMs"]:
                raise ActionError("Time's up!")
            player = game.players.get(user_id)
            if not player:
                raise ActionError("Join the game before answering.")
            key = (index, user_id)
            if key in game.submissions:
                raise ActionError("You already locked in an answer.")
            game.submissions[key] = Submission(
                index=index, user_id=user_id, choice=choice, elapsed_ms=max(0, elapsed)
            )
            player.last_answered_index = index
        await self._notify(game)
        return game

    async def reveal(self, game_id: str, user_id: str, index: int) -> Game:
        async with self._lock:
            game = self.games.get(game_id)
            if not game:
                raise ActionError("Game not found.")
            if game.status != "question" or game.current_index != index:
                return game
            is_host = game.host_id == user_id
            is_player = user_id in game.players
            if not is_host and not is_player:
                raise ActionError("You are not in this game.")
            duration = game.seconds_per_question * 1000
            time_up = now_ms() - game.question_started_at >= duration
            everyone = bool(game.players) and all(p.last_answered_index >= index for p in game.players.values())
            if not is_host and not time_up and not everyone:
                raise ActionError("The round is still open.")
            key = game.keys.get(index)
            question = next((q for q in game.questions if q.index == index), None)
            if not key or not question:
                raise ActionError("Question data is missing.")
            distribution = [0, 0, 0, 0]
            for player in game.players.values():
                by_index = {
                    s.index: ScoredSubmission(s.choice, s.elapsed_ms, s.correct, s.points)
                    for (i, uid), s in game.submissions.items()
                    if uid == player.user_id
                }
                tally = tally_player(by_index, index, key.correct_index, duration)
                sub = game.submissions.get((index, player.user_id))
                if sub:
                    distribution[sub.choice] += 1
                    sub.correct = tally.current_correct
                    sub.points = tally.current_points
                player.score = tally.score
                player.streak = tally.streak
                player.correct_count = tally.correct_count
                player.last_points = tally.last_points
            question.correct_index = key.correct_index
            question.explanation = key.explanation
            question.distribution = distribution
            game.status = "reveal"
            game.revealed_at = now_ms()
        await self._notify(game)
        return game

    async def next_question(self, game_id: str, user_id: str, from_index: Any) -> Game:
        async with self._lock:
            game = self.games.get(game_id)
            if not game:
                raise ActionError("Game not found.")
            if game.status != "reveal":
                return game
            is_host = game.host_id == user_id
            if not is_host:
                if user_id not in game.players:
                    raise ActionError("You are not in this game.")
                if now_ms() - game.revealed_at < HOST_AWAY_MS:
                    raise ActionError("Waiting for the host.")
            if from_index is not None and int(from_index) != game.current_index:
                return game
            nxt = game.current_index + 1
            if nxt >= game.question_count:
                game.status = "finished"
            else:
                game.status = "question"
                game.current_index = nxt
                game.question_started_at = now_ms()
        await self._notify(game)
        return game

    def presence(self, game_id: str, user_id: str, online: bool) -> None:
        game = self.games.get(game_id)
        if not game:
            return
        if online:
            game.viewers.add(user_id)
        else:
            game.viewers.discard(user_id)
