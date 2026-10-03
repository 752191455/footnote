# Footnote

**Live trivia where every answer cites its source.** A host types any topic. Footnote searches Wikipedia, reads the top articles, and has Claude write multiple-choice questions using only that text. It then runs the game live for everyone in the room. Each reveal shows the correct answer, how the room voted, and a footnote linking to the Wikipedia article it came from.

- Live: https://testproject.app.space
- Built on [DeepSpace](https://docs.deep.space) (Cloudflare Workers + Durable Objects)

## What it does

1. **Host.** Pick a topic, a question count (5–12), and a time per question (10–30s). The room opens immediately with a four-letter code so friends can join while questions are written in the background (~10s).
2. **Join.** Players open the invite link or type the code. They take a seat automatically, and the lobby shows who has the room open right now — plus live generation progress from the JobRoom.
3. **Play.** There is a shared countdown. Answers are final once locked in, and faster correct answers score more (500–1000 points plus a streak bonus). A round closes when time runs out or when everyone has answered.
4. **Reveal.** The page shows the correct answer, a per-choice distribution, a one-line explanation, and the Wikipedia source. Standings show rank movement.
5. **Finish.** A podium, full standings, an async Claude recap (`summaries`), host R2 files, and the list of sources ("Footnotes").

The host plays too, because nobody can see an answer before the reveal, the host and app owner included.

## DeepSpace primitives used

| Primitive | Where | Why |
|---|---|---|
| **RecordRoom** (collections + RBAC) | [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts) | Board-style collections synced live: `games` (boards), `questions` / `players` / `submissions` (items), `summaries` (post-game recaps), plus `answer_keys` and `reveal_locks`. Every client role is read-only. |
| **Server actions** | [`src/actions/trivia.ts`](src/actions/trivia.ts) | The only writers of game state: `createGame`, `joinGame`, `startGame`, `submitAnswer`, `revealQuestion`, `nextQuestion`, `serverTime`. Each re-checks the caller, the game phase, and the **server** clock. |
| **JobRoom** (`enqueueJob` + `useJobs`) | [`src/jobs.ts`](src/jobs.ts), [`src/server/quiz-generator.ts`](src/server/quiz-generator.ts), [`src/server/summarize-game.ts`](src/server/summarize-game.ts) | `createGame` seats the room immediately and enqueues `generate-quiz`. Finishing a game enqueues `summarize-game` so the podium stays responsive while Claude writes the recap. Socket writes are refused (`authorizeWrite: () => false`); only actions enqueue after the daily cap check. |
| **Row-level RBAC** | `answer_keys` (no role can read), `submissions` (`read: 'own'`) | Answers stay secret until the reveal, and nobody can see what others picked. This is enforced in the Durable Object, not hidden in the UI. |
| **`uniqueOn` constraints** | `submissions (gameId, index, userId)`, `players (gameId, userId)`, `reveal_locks (gameId, index)`, `summaries (gameId)` | One answer per player per question. `reveal_locks` stops racing clients from all scoring at once; a lock older than 15s with the round still open marks a failed attempt, and the reveal runs again. That is safe because scoring rebuilds each player's totals from their submissions (`tallyPlayer`) instead of incrementing. |
| **PresenceRoom** (`usePresenceRoom`) | [`play/[code].tsx`](src/pages/(app)/play/[code].tsx) | Ephemeral "who is viewing the board", separate from the persistent "who has joined" roster. Lobby shows seated count + viewing count. |
| **Integration proxy** | `tools.integration(...)` inside JobRoom jobs | `wikipedia/*` for grounding text and lead photos, `exa/search` for optional web colour while writing questions, `anthropic/chat-completion` for questions and the post-game summary. Billed to the app owner (`developer`), capped at 10 games per user per day. |
| **R2 file storage** (`useR2Files` → `/api/files/*`) | [`home.tsx`](src/pages/(app)/home.tsx), game `cover*` / `attachment*` fields | Host can attach a cover image and a PDF/image before `createGame`. Keys are app-scoped (`scope: 'app'`) so the lobby can embed them without per-viewer auth. |
| **Auth** (`AuthOverlay`, JWT-verified actions) | nav, home, play page | Names on the scoreboard, and identity for every action. |

### Left out on purpose

- **Gemini / OpenAI image generation.** A generated picture of the topic would look like a source and is not. Footnote only shows Wikimedia photos that belong to the articles it cited. Generation is also much more expensive than a Wikipedia thumbnail.
- **Yjs / messaging / canvas.** No shared editing or chat is needed. Adding chat to a timed quiz mostly adds a way to leak answers.
- **Cron.** Abandoned games cost nothing besides a few rows. A cleanup job would be housekeeping, not product value.
- **Payments.** Out of scope; the daily cap is the spend control instead.

## Main tradeoff

**The server owns all game state, at the cost of one HTTP round trip per answer.** The simple version lets clients write their own answers and scores with `useMutations`. That would feel slightly snappier, but anyone reading WebSocket frames could see the correct answer, answer after time is up, or set their own score. In Footnote every write goes through a server action that checks the phase and the worker's clock. The answer key sits in a collection no role can read and is copied onto the public question only at reveal. Timing is judged by the server, not the browser. A clock-offset sync (`serverTime`) keeps the countdown each player sees aligned with the server's notion of "time's up".

A second, related tradeoff: **generation runs in JobRoom, not inside the `createGame` HTTP request.** Holding the request open for ~10s works at this scale, but the host cannot share a code until it finishes, and a closed tab loses the work. Seating the room first (`generating` → `lobby` / `failed`) lets friends join during generation and gives every client the same live progress bar. The cost is an extra Durable Object hop and a schema that admits half-built games.

Smaller tradeoffs:
- **Claude Haiku over a larger model.** Latency and cost matter more in a lobby than prose quality. Grounding in the Wikipedia text does the heavy lifting, and the server validates the output: 4 distinct choices, a valid source index, no duplicate prompts. It also shuffles the choices because models favor certain answer positions.
- **Measured cost: about $0.013 per generated game.** That is 1 Claude Haiku call (~$0.01) plus 4 Wikipedia calls (~$0.0026). Answering and scoring call no paid APIs, so spend scales with games hosted, not with players. The 10-games/day cap bounds any one user to about $0.13/day.
- **Answer time is measured on arrival at the server**, so a slow connection loses a little speed bonus. That is simpler and harder to cheat than trusting a client timestamp.
- **JobRoom socket writes are closed entirely.** Docs default to member/admin enqueue; here every job spends owner credits, so enqueue is action-only after validation and the daily cap.

## Known limitations

- **`createGame` is not fully atomic with the job.** If enqueue fails after the game row is created, the room is marked `failed`. A Worker crash mid-job leaves a `generating` room until the host starts over (maxAttempts is 1 so a failed generation stays failed with a clear error).
- **`games` and `questions` are readable by any signed-in user.** Answers and other players' picks are not. Scoping games to their players would need a `collaboratorsField` on each collection.
- The daily cap is read-then-write, so two simultaneous requests could slip one game past the limit.
- Rooms are capped at 30 players to bound the per-reveal write fan-out.
- Each reveal re-reads every submission in the game (≤ 30 players × 12 questions) to rebuild totals. Cheap at this size; a bigger game would store per-round totals instead.

## Next steps

1. A "spectator / big screen" mode for the host's TV, with phones as answer pads.
2. Let the host review and drop generated questions before starting.
3. An integration test that kills a reveal mid-write and asserts the resumed reveal matches a clean one (the pure `tallyPlayer` idempotency is unit-tested; the end-to-end path is not).
4. Optional: `maxAttempts: 2` with idempotent question writes for flaky upstreams (the generator already clears prior keys/questions on start).

## Built with a coding agent

The coding agent read the DeepSpace docs and SDK types. It proposed the design (server-authoritative actions, a hidden answer-key collection, `uniqueOn` as a lock, JobRoom for generation) and wrote the schemas, actions, job handler, pure game logic, UI, theme, and tests.

The agent verified:
- `tsc --noEmit` and ESLint are clean.
- **Unit tests 19/19** (18 in [`src/lib/trivia.test.ts`](src/lib/trivia.test.ts)): scoring, room codes, Wikipedia HTML extraction, question validation including correct-answer tracking through the shuffle, tie-aware ranking, and `tallyPlayer` (including that re-running a reveal changes nothing).
- **Smoke + API Playwright tests 11/11**, including "trivia actions return 401 without sign-in". The smoke suite was flaky on a network that blocks Google Fonts; fonts are now bundled with the app (Fontsource), which fixed it.
- After deploy: live routes return 200, `createGame` without auth returns 401, and the release is recorded with rollback available.
- **Not yet run:** the two-player end-to-end spec (`tests/collab.spec.ts` › *two players play a full game*). It was skipped because no test accounts existed on the machine.

**What I verified myself:** _(fill in before submitting)_
- [ ] Played a full game on the live URL with two accounts (host + guest)
- [ ] Guest joined via invite link while status was still `generating`; both lobbies showed 2 players and the same progress message
- [ ] Early reveal when both answered; timer reveal when one player sat a round out
- [ ] Reveal showed the correct answer, distribution, and Wikipedia footnote; scores matched expectations
- [x] Played a full 5-question game on the live URL with one account (prior sync path; every submit / reveal / next returned 200)
- [x] Checked `npx deepspace app usage`: about $0.013 per generated game
- [ ] Re-verified after JobRoom migrate: room code appears immediately; progress bar advances; status flips to lobby; Start enables
- [ ] _(anything I changed or overrode from the agent's work)_

## Running locally

```bash
npm install
npx deepspace dev start          # http://localhost:5173
npx deepspace test run all --port 5180   # needs 2 test accounts for the multiplayer spec
npx deepspace deploy
```

## Python port

DeepSpace itself is TypeScript on Cloudflare Workers; it cannot be rewritten in-place in Python. A standalone FastAPI port of the same game lives in [`python/`](python/README.md) (`python main.py` → http://localhost:8000).

## Code map

- [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts): collections and permissions; read this first.
- [`src/actions/trivia.ts`](src/actions/trivia.ts): the game state machine (create enqueues; play/reveal/score).
- [`src/server/quiz-generator.ts`](src/server/quiz-generator.ts): Wikipedia → Exa → Claude → validate → save pipeline.
- [`src/server/summarize-game.ts`](src/server/summarize-game.ts): post-game Claude recap into `summaries`.
- [`src/jobs.ts`](src/jobs.ts): `generate-quiz` + `summarize-game` JobRoom handlers with progress + deadline.
- [`src/lib/trivia.ts`](src/lib/trivia.ts): pure logic (scoring, validation, text extraction), unit-tested.
- [`src/lib/game-client.ts`](src/lib/game-client.ts): action caller and server-clock sync.
- [`src/pages/(app)/play/[code].tsx`](src/pages/(app)/play/[code].tsx): the game room (generating → lobby → question → reveal → finished).
- [`src/pages/(app)/home.tsx`](src/pages/(app)/home.tsx): host and join.
