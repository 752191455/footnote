# Footnote

**Live trivia where every answer cites its source.** A host types any topic. Footnote searches Wikipedia, reads the top articles, and has Claude write multiple-choice questions using only that text. It then runs the game live for everyone in the room. Each reveal shows the correct answer, how the room voted, and a footnote linking to the Wikipedia article it came from.

- Live: https://testproject.app.space
- Built on [DeepSpace](https://docs.deep.space) (Cloudflare Workers + Durable Objects)

## What it does

1. **Host.** Pick a topic, a question count (5–12), and a time per question (10–30s). In about 10 seconds you get a four-letter room code.
2. **Join.** Players open the invite link or type the code. They take a seat automatically, and the lobby shows who has the room open right now.
3. **Play.** There is a shared countdown. Answers are final once locked in, and faster correct answers score more (500–1000 points plus a streak bonus). A round closes when time runs out or when everyone has answered.
4. **Reveal.** The page shows the correct answer, a per-choice distribution, a one-line explanation, and the Wikipedia source. Standings show rank movement.
5. **Finish.** A podium, full standings, and the list of sources ("Footnotes").

The host plays too, because nobody can see an answer before the reveal, the host and app owner included.

## DeepSpace primitives used

| Primitive | Where | Why |
|---|---|---|
| **RecordRoom** (collections + RBAC) | [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts) | Six collections synced live to every client: `games`, `questions`, `players`, `submissions`, `answer_keys`, `reveal_locks`. Every client role is read-only. |
| **Server actions** | [`src/actions/trivia.ts`](src/actions/trivia.ts) | The only writers of game state: `createGame`, `joinGame`, `startGame`, `submitAnswer`, `revealQuestion`, `nextQuestion`, `serverTime`. Each re-checks the caller, the game phase, and the **server** clock. |
| **Row-level RBAC** | `answer_keys` (no role can read), `submissions` (`read: 'own'`) | Answers stay secret until the reveal, and nobody can see what others picked. This is enforced in the Durable Object, not hidden in the UI. |
| **`uniqueOn` constraints** | `submissions (gameId, index, userId)`, `players (gameId, userId)`, `reveal_locks (gameId, index)` | One answer per player per question. `reveal_locks` doubles as an idempotency lock so a round is scored exactly once when several clients race to close it at 0s. |
| **PresenceRoom** (`usePresenceRoom`) | [`play/[code].tsx`](src/pages/(app)/play/[code].tsx) | Ephemeral "who has this room open", separate from the persistent "who has joined" roster. |
| **Integration proxy** | `tools.integration(...)` inside `createGame` | `wikipedia/search-pages` + `wikipedia/get-page-content` for grounding text, `anthropic/chat-completion` (Claude Haiku 4.5) to write questions. Billed to the app owner (`developer`), so creation needs sign-in and is capped at 10 games per user per day. |
| **Auth** (`AuthOverlay`, JWT-verified actions) | nav, home, play page | Names on the scoreboard, and identity for every action. |

### Left out on purpose

- **JobRoom.** Generation runs synchronously inside `createGame` (about 10s), and the UI narrates the stages. That is acceptable at this scale. JobRoom would make generation durable and observable with real progress, and it is the first thing I would add (see *Next steps*).
- **R2 / file storage.** Nothing in a trivia game is user-uploaded. Sources are links to Wikipedia, not stored copies.
- **Yjs / messaging / canvas.** No shared editing or chat is needed. Adding chat to a timed quiz mostly adds a way to leak answers.
- **Cron.** Abandoned games cost nothing besides a few rows. A cleanup job would be housekeeping, not product value.
- **Payments.** Out of scope; the daily cap is the spend control instead.

## Main tradeoff

**The server owns all game state, at the cost of one HTTP round trip per answer.** The simple version lets clients write their own answers and scores with `useMutations`. That would feel slightly snappier, but anyone reading WebSocket frames could see the correct answer, answer after time is up, or set their own score. In Footnote every write goes through a server action that checks the phase and the worker's clock. The answer key sits in a collection no role can read and is copied onto the public question only at reveal. Timing is judged by the server, not the browser. A clock-offset sync (`serverTime`) keeps the countdown each player sees aligned with the server's notion of "time's up".

Smaller tradeoffs:
- **Claude Haiku over a larger model.** Latency and cost matter more in a lobby than prose quality. Grounding in the Wikipedia text does the heavy lifting, and the server validates the output: 4 distinct choices, a valid source index, no duplicate prompts. It also shuffles the choices because models favor certain answer positions.
- **Answer time is measured on arrival at the server**, so a slow connection loses a little speed bonus. That is simpler and harder to cheat than trusting a client timestamp.

## Known limitations

- **A failed reveal can stall a round.** `revealQuestion` takes the `reveal_locks` row *before* writing scores. If a write fails after the lock is taken, retries see the lock and return `alreadyRevealed`, and the game never flips to `reveal`. The fix is to write the lock last, or to make scoring resumable from a lock status.
- **`createGame` is not atomic.** A failure while saving questions leaves an orphaned game row.
- **`games` and `questions` are readable by any signed-in user.** Answers and other players' picks are not. Scoping games to their players would need a `collaboratorsField` on each collection.
- The daily cap is read-then-write, so two simultaneous requests could slip one game past the limit.
- Rooms are capped at 30 players to bound the per-reveal write fan-out.

## Next steps

1. Move generation into a **JobRoom** job with stage-by-stage progress, so the host can close the tab without losing the quiz.
2. Fix the reveal ordering above and add a regression test for a failure in the middle of scoring.
3. A "spectator / big screen" mode for the host's TV, with phones as answer pads.
4. Let the host review and drop generated questions before starting.

## Built with a coding agent

The coding agent (Claude Code) read the DeepSpace docs and SDK types. It proposed the design (server-authoritative actions, a hidden answer-key collection, `uniqueOn` as a lock) and wrote the schemas, actions, pure game logic, UI, theme, and tests.

The agent verified:
- `tsc --noEmit` and ESLint are clean.
- **Unit tests 15/15** ([`src/lib/trivia.test.ts`](src/lib/trivia.test.ts)): scoring, room codes, Wikipedia HTML extraction, question validation including correct-answer tracking through the shuffle, and tie-aware ranking.
- **Smoke + API Playwright tests 11/11**, including "trivia actions return 401 without sign-in".
- After deploy: live routes return 200, `createGame` without auth returns 401, and the release is recorded with rollback available.
- **Not yet run:** the two-player end-to-end spec (`tests/collab.spec.ts` › *two players play a full game*). It was skipped because no test accounts existed on the machine.

**What I verified myself:** _(fill in before submitting)_
- [ ] Played a full game on the live URL with two accounts (host + guest)
- [ ] Guest joined via invite link; both lobbies showed 2 players
- [ ] Early reveal when both answered; timer reveal when one player sat a round out
- [ ] Reveal showed the correct answer, distribution, and Wikipedia footnote; scores matched expectations
- [ ] Checked `npx deepspace app usage` for the cost per generated game
- [ ] _(anything I changed or overrode from the agent's work)_

## Running locally

```bash
npm install
npx deepspace dev start          # http://localhost:5173
npx deepspace test run all --port 5180   # needs 2 test accounts for the multiplayer spec
npx deepspace deploy
```

## Code map

- [`src/schemas/trivia-schema.ts`](src/schemas/trivia-schema.ts): collections and permissions; read this first.
- [`src/actions/trivia.ts`](src/actions/trivia.ts): the game state machine and the question pipeline.
- [`src/lib/trivia.ts`](src/lib/trivia.ts): pure logic (scoring, validation, text extraction), unit-tested.
- [`src/lib/game-client.ts`](src/lib/game-client.ts): action caller and server-clock sync.
- [`src/pages/(app)/play/[code].tsx`](src/pages/(app)/play/[code].tsx): the game room (lobby → question → reveal → finished).
- [`src/pages/(app)/home.tsx`](src/pages/(app)/home.tsx): host and join.
