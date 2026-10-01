/**
 * Footnote trivia — collections.
 *
 * The game is server-authoritative: every collection is read-only to clients
 * and all writes go through the server actions in src/actions/trivia.ts. That
 * is what lets the timer, scoring, and answer secrecy hold against a client
 * that sends its own WebSocket frames.
 *
 * Answer secrecy is structural, not cosmetic: correct answers live in
 * `answer_keys`, which no role can read. The reveal action copies the answer
 * onto the public `questions` row only after the round closes, so even the
 * host (or the app owner, who is pinned to admin) can play fairly.
 */

import type { CollectionSchema } from 'deepspace/schema'

const SERVER_ONLY = { read: false, create: false, update: false, delete: false } as const
const READ_ONLY = { read: true, create: false, update: false, delete: false } as const

export const GAME_STATUSES = ['lobby', 'question', 'reveal', 'finished'] as const
export type GameStatus = (typeof GAME_STATUSES)[number]

export const gamesSchema: CollectionSchema = {
  name: 'games',
  columns: [
    { name: 'code', storage: 'text', interpretation: 'plain', required: true },
    { name: 'topic', storage: 'text', interpretation: 'plain', required: true },
    { name: 'hostId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'hostName', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: [...GAME_STATUSES] } },
    { name: 'currentIndex', storage: 'number', interpretation: 'plain' },
    /** Server clock (ms) when the current question opened. */
    { name: 'questionStartedAt', storage: 'number', interpretation: 'plain' },
    /** Server clock (ms) when the current question was revealed. */
    { name: 'revealedAt', storage: 'number', interpretation: 'plain' },
    { name: 'secondsPerQuestion', storage: 'number', interpretation: 'plain' },
    { name: 'questionCount', storage: 'number', interpretation: 'plain' },
    /** Wikipedia articles the questions were grounded in: [{ title, url }]. */
    { name: 'sources', storage: 'text', interpretation: { kind: 'json' } },
  ],
  permissions: { '*': SERVER_ONLY, viewer: READ_ONLY, member: READ_ONLY, admin: READ_ONLY },
}

export const questionsSchema: CollectionSchema = {
  name: 'questions',
  columns: [
    { name: 'gameId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'index', storage: 'number', interpretation: 'plain', required: true },
    { name: 'prompt', storage: 'text', interpretation: 'plain', required: true },
    { name: 'choices', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'sourceTitle', storage: 'text', interpretation: 'plain' },
    { name: 'sourceUrl', storage: 'text', interpretation: 'plain' },
    // The next three stay null until the reveal action fills them in.
    { name: 'correctIndex', storage: 'number', interpretation: 'plain' },
    { name: 'explanation', storage: 'text', interpretation: 'plain' },
    /** Answer counts per choice, written at reveal. */
    { name: 'distribution', storage: 'text', interpretation: { kind: 'json' } },
  ],
  uniqueOn: ['gameId', 'index'],
  permissions: { '*': SERVER_ONLY, viewer: READ_ONLY, member: READ_ONLY, admin: READ_ONLY },
}

/** Never readable by any client role — only server actions see these rows. */
export const answerKeysSchema: CollectionSchema = {
  name: 'answer_keys',
  columns: [
    { name: 'gameId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'index', storage: 'number', interpretation: 'plain', required: true },
    { name: 'correctIndex', storage: 'number', interpretation: 'plain', required: true },
    { name: 'explanation', storage: 'text', interpretation: 'plain' },
  ],
  uniqueOn: ['gameId', 'index'],
  permissions: { '*': SERVER_ONLY, viewer: SERVER_ONLY, member: SERVER_ONLY, admin: SERVER_ONLY },
}

export const playersSchema: CollectionSchema = {
  name: 'players',
  columns: [
    { name: 'gameId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'name', storage: 'text', interpretation: 'plain' },
    { name: 'score', storage: 'number', interpretation: 'plain' },
    { name: 'streak', storage: 'number', interpretation: 'plain' },
    { name: 'correctCount', storage: 'number', interpretation: 'plain' },
    /** Highest question index this player has locked an answer in for (-1 = none). */
    { name: 'lastAnsweredIndex', storage: 'number', interpretation: 'plain' },
    /** Points earned on the most recently revealed question. */
    { name: 'lastPoints', storage: 'number', interpretation: 'plain' },
  ],
  uniqueOn: ['gameId', 'userId'],
  permissions: { '*': SERVER_ONLY, viewer: READ_ONLY, member: READ_ONLY, admin: READ_ONLY },
}

/**
 * One locked-in answer. Created by the submitAnswer action as the caller, so
 * `createdBy` is the player and `read: 'own'` keeps choices private — nobody
 * can peek at what the room is picking before the reveal.
 */
export const submissionsSchema: CollectionSchema = {
  name: 'submissions',
  columns: [
    { name: 'gameId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'index', storage: 'number', interpretation: 'plain', required: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'choice', storage: 'number', interpretation: 'plain', required: true },
    { name: 'elapsedMs', storage: 'number', interpretation: 'plain' },
    { name: 'correct', storage: 'number', interpretation: { kind: 'boolean' } },
    { name: 'points', storage: 'number', interpretation: 'plain' },
  ],
  // One answer per player per question, enforced by the room — not the UI.
  uniqueOn: ['gameId', 'index', 'userId'],
  permissions: {
    '*': SERVER_ONLY,
    viewer: SERVER_ONLY,
    member: { read: 'own', create: false, update: false, delete: false },
    admin: { read: 'own', create: false, update: false, delete: false },
  },
}

/**
 * Idempotency lock for scoring. Several clients race to close a round when the
 * timer hits zero; only the first `create` for a (gameId, index) succeeds, so a
 * round is scored exactly once.
 */
export const revealLocksSchema: CollectionSchema = {
  name: 'reveal_locks',
  columns: [
    { name: 'gameId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'index', storage: 'number', interpretation: 'plain', required: true },
  ],
  uniqueOn: ['gameId', 'index'],
  permissions: { '*': SERVER_ONLY, viewer: SERVER_ONLY, member: SERVER_ONLY, admin: SERVER_ONLY },
}

export const triviaSchemas = [
  gamesSchema,
  questionsSchema,
  answerKeysSchema,
  playersSchema,
  submissionsSchema,
  revealLocksSchema,
]
