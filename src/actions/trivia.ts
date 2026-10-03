/**
 * Footnote trivia — server actions.
 *
 * These are the only writers of game state (every trivia collection is
 * read-only to clients), so each action re-checks who the caller is and what
 * phase the game is in. Times come from the worker's clock, never the client's.
 */

import { enqueueJob } from 'deepspace/worker'
import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import type { GameStatus } from '../schemas/trivia-schema'
import { LIMITS, generateRoomCode, normalizeRoomCode, tallyPlayer, type ScoredSubmission } from '../lib/trivia'
import { GENERATE_QUIZ, type GenerateQuizPayload } from '../server/quiz-generator'
import { SUMMARIZE_GAME } from '../server/summarize-game'

const MAX_PLAYERS = 30
/** A reveal lock older than this, with the round still open, belongs to a failed attempt. */
const REVEAL_LOCK_STALE_MS = 15_000

interface Game {
  code: string
  topic: string
  hostId: string
  hostName?: string
  status: GameStatus
  currentIndex: number
  questionStartedAt: number
  revealedAt?: number
  secondsPerQuestion: number
  questionCount: number
  sources: { title: string; url: string; imageUrl?: string }[]
  jobId?: string
  generationError?: string
  coverFileKey?: string
  coverUrl?: string
  attachmentFileKey?: string
  attachmentName?: string
  attachmentMime?: string
  summaryJobId?: string
}

interface Player {
  gameId: string
  userId: string
  name?: string
  score: number
  streak: number
  correctCount: number
  lastAnsweredIndex: number
  lastPoints: number
}

interface Submission {
  gameId: string
  index: number
  userId: string
  choice: number
  elapsedMs: number
}

const fail = (error: string): ActionResult<never> => ({ success: false, error })
const ok = <T>(data: T): ActionResult<T> => ({ success: true, data })

const playerId = (gameId: string, userId: string) => `${gameId}__${userId}`

async function loadGame(tools: ActionTools, gameId: unknown) {
  if (typeof gameId !== 'string' || !gameId) return null
  const r = await tools.get<Record<string, unknown>>('games', gameId)
  if (!r.success) return null
  return { id: gameId, ...(r.data.record.data as unknown as Game) }
}

async function displayName(tools: ActionTools, userId: string): Promise<string> {
  // Server actions read full user rows (email included) — project to the name only.
  const r = await tools.get<{ name?: string }>('users', userId)
  const name = r.success ? r.data.record.data.name?.trim() : ''
  return name ? name.slice(0, 40) : 'Player'
}

// ── Actions ───────────────────────────────────────────────────────────────

/** Lets the client correct for clock skew when drawing the countdown. */
const serverTime: ActionHandler<Env> = async () => ok({ now: Date.now() })

const createGame: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const topic = String(params.topic ?? '').trim().slice(0, LIMITS.topicMaxLength)
  if (topic.length < 2) return fail('Pick a topic first.')
  const questionCount = clampInt(params.questionCount, LIMITS.minQuestions, LIMITS.maxQuestions, 8)
  const secondsPerQuestion = clampInt(params.secondsPerQuestion, LIMITS.minSeconds, LIMITS.maxSeconds, 20)

  // Generation bills the app owner, so cap it per user before spending anything.
  const recent = await tools.query<{ hostId: string }>('games', {
    where: { hostId: userId },
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: LIMITS.gamesPerDay,
  })
  if (recent.success) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000
    const today = recent.data.records.filter((r) => Date.parse(r.createdAt) > dayAgo).length
    if (today >= LIMITS.gamesPerDay) {
      return fail(`You've hosted ${LIMITS.gamesPerDay} games today — the daily limit. Try again tomorrow.`)
    }
  }

  // Seat the room immediately; questions are written by a background job
  // (src/jobs.ts) while players gather, and the lobby shows its live progress.
  const files = parseHostFiles(params)
  const code = await uniqueRoomCode(tools)
  const hostName = await displayName(tools, userId)
  const game: Game = {
    code,
    topic,
    hostId: userId,
    hostName,
    status: 'generating',
    currentIndex: 0,
    questionStartedAt: 0,
    secondsPerQuestion,
    questionCount,
    sources: [],
    ...files,
  }
  const created = await tools.create('games', game as unknown as Record<string, unknown>)
  if (!created.success) return created
  const gameId = created.data.recordId

  // The host plays too — answers are hidden from them like everyone else.
  await tools.create('players', newPlayer(gameId, userId, hostName), playerId(gameId, userId))

  const payload: GenerateQuizPayload = { gameId, topic, questionCount }
  let jobId: string
  try {
    jobId = await enqueueJob(env.JOB_ROOMS, `app:${env.DEEPSPACE_APP_ID}`, GENERATE_QUIZ, payload, {
      maxAttempts: 1,
      enqueuedBy: userId,
    })
  } catch (err) {
    console.error(`[createGame] enqueue failed: ${(err as Error).message}`)
    await tools.update('games', gameId, { status: 'failed', generationError: 'Could not start writing the quiz. Try again.' })
    return fail('Could not start writing the quiz. Try again.')
  }
  await tools.update('games', gameId, { jobId })

  return ok({ gameId, code, jobId })
}

const joinGame: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const code = normalizeRoomCode(String(params.code ?? ''))
  if (!code) return fail('Enter a room code.')
  const found = await tools.query<Game & Record<string, unknown>>('games', {
    where: { code },
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: 1,
  })
  const record = found.success ? found.data.records[0] : undefined
  if (!record) return fail(`No game with code ${code}.`)
  const gameId = record.recordId

  const existing = await tools.get('players', playerId(gameId, userId))
  if (existing.success) return ok({ gameId, code })
  if (record.data.status === 'finished') return fail('That game has already finished.')
  if (record.data.status === 'failed') return fail('That game could not be set up.')

  const roster = await tools.query('players', { where: { gameId }, limit: MAX_PLAYERS + 1 })
  if (roster.success && roster.data.records.length >= MAX_PLAYERS) return fail('That room is full.')

  const name = await displayName(tools, userId)
  const r = await tools.create('players', newPlayer(gameId, userId, name), playerId(gameId, userId))
  if (!r.success) return r
  return ok({ gameId, code })
}

const startGame: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const game = await loadGame(tools, params.gameId)
  if (!game) return fail('Game not found.')
  if (game.hostId !== userId) return fail('Only the host can start the game.')
  if (game.status !== 'lobby') return ok({ status: game.status })
  const now = Date.now()
  const r = await tools.update('games', game.id, {
    status: 'question',
    currentIndex: 0,
    questionStartedAt: now,
  })
  if (!r.success) return r
  return ok({ status: 'question', now })
}

const submitAnswer: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const game = await loadGame(tools, params.gameId)
  if (!game) return fail('Game not found.')
  const index = Number(params.index)
  const choice = Number(params.choice)
  if (!Number.isInteger(choice) || choice < 0 || choice > 3) return fail('Invalid choice.')
  if (game.status !== 'question' || game.currentIndex !== index) return fail('This question is closed.')

  const now = Date.now()
  const elapsedMs = now - game.questionStartedAt
  if (elapsedMs > game.secondsPerQuestion * 1000 + LIMITS.answerGraceMs) return fail("Time's up!")

  const player = await tools.get<Record<string, unknown>>('players', playerId(game.id, userId))
  if (!player.success) return fail('Join the game before answering.')

  // uniqueOn (gameId, index, userId) refuses a second answer — the lock-in is final.
  const sub = await tools.create('submissions', {
    gameId: game.id,
    index,
    userId,
    choice,
    elapsedMs: Math.max(0, elapsedMs),
  } satisfies Submission)
  if (!sub.success) {
    return /duplicate/i.test(sub.error) ? fail('You already locked in an answer.') : sub
  }
  await tools.update('players', playerId(game.id, userId), { lastAnsweredIndex: index })
  return ok({ elapsedMs, now })
}

const revealQuestion: ActionHandler<Env> = async ({ userId, params, tools }) => {
  const game = await loadGame(tools, params.gameId)
  if (!game) return fail('Game not found.')
  const index = Number(params.index)
  if (game.status !== 'question' || game.currentIndex !== index) return ok({ alreadyRevealed: true })

  const playersRes = await tools.query<Player & Record<string, unknown>>('players', {
    where: { gameId: game.id },
    limit: MAX_PLAYERS + 1,
  })
  if (!playersRes.success) return playersRes
  const players = playersRes.data.records
  const isHost = game.hostId === userId
  const isPlayer = players.some((p) => p.data.userId === userId)
  if (!isHost && !isPlayer) return fail('You are not in this game.')

  const durationMs = game.secondsPerQuestion * 1000
  const timeUp = Date.now() - game.questionStartedAt >= durationMs
  const everyoneAnswered = players.every((p) => (p.data.lastAnsweredIndex ?? -1) >= index)
  if (!isHost && !timeUp && !everyoneAnswered) return fail('The round is still open.')

  // Several clients race here when the timer hits zero. The lock keeps them
  // from all doing the work: a fresh lock means someone is scoring right now.
  // A stale lock with the round still open means that attempt died mid-write,
  // so we score again — safe, because tallyPlayer rebuilds totals from the
  // submissions instead of adding to the previous score.
  const lock = await tools.create('reveal_locks', { gameId: game.id, index })
  if (!lock.success) {
    const held = await tools.query('reveal_locks', { where: { gameId: game.id, index }, limit: 1 })
    const lockedAt = held.success ? Date.parse(held.data.records[0]?.createdAt ?? '') : NaN
    if (Number.isFinite(lockedAt) && Date.now() - lockedAt < REVEAL_LOCK_STALE_MS) {
      return ok({ alreadyRevealed: true })
    }
    const fresh = await loadGame(tools, game.id)
    if (!fresh || fresh.status !== 'question' || fresh.currentIndex !== index) {
      return ok({ alreadyRevealed: true })
    }
    console.warn(`[revealQuestion] resuming stale reveal game=${game.id} index=${index}`)
  }

  const [keyRes, subsRes, questionRes] = await Promise.all([
    tools.query<{ correctIndex: number; explanation?: string }>('answer_keys', {
      where: { gameId: game.id, index },
      limit: 1,
    }),
    // Every round's submissions: totals are rebuilt from them, not incremented.
    tools.query<Submission & Record<string, unknown>>('submissions', {
      where: { gameId: game.id },
      limit: 500,
    }),
    tools.query('questions', { where: { gameId: game.id, index }, limit: 1 }),
  ])
  const key = keyRes.success ? keyRes.data.records[0]?.data : undefined
  const question = questionRes.success ? questionRes.data.records[0] : undefined
  if (!key || !question || !subsRes.success) return fail('Question data is missing.')

  const byUser = new Map<string, Map<number, ScoredSubmission & { recordId: string }>>()
  for (const s of subsRes.data.records) {
    const mine = byUser.get(s.data.userId) ?? new Map()
    mine.set(s.data.index, { ...(s.data as ScoredSubmission), recordId: s.recordId })
    byUser.set(s.data.userId, mine)
  }

  const distribution = [0, 0, 0, 0]
  const writes: Promise<unknown>[] = []
  for (const p of players) {
    const subs = byUser.get(p.data.userId) ?? new Map()
    const tally = tallyPlayer(subs, index, key.correctIndex, durationMs)
    const sub = subs.get(index)
    if (sub) {
      distribution[sub.choice] = (distribution[sub.choice] ?? 0) + 1
      writes.push(tools.update('submissions', sub.recordId, tally.current))
    }
    writes.push(
      tools.update('players', p.recordId, {
        score: tally.score,
        streak: tally.streak,
        correctCount: tally.correctCount,
        lastPoints: tally.lastPoints,
      }),
    )
  }
  writes.push(
    tools.update('questions', question.recordId, {
      correctIndex: key.correctIndex,
      explanation: key.explanation ?? '',
      distribution,
    }),
  )
  await Promise.all(writes)

  // Flip the phase last, so clients see the reveal only once scores are in.
  const now = Date.now()
  await tools.update('games', game.id, { status: 'reveal', revealedAt: now })
  return ok({ revealed: true, now })
}

/** How long a reveal can sit before any player may advance (host walked away). */
const HOST_AWAY_MS = 20_000

const nextQuestion: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const game = await loadGame(tools, params.gameId)
  if (!game) return fail('Game not found.')
  if (game.status !== 'reveal') return ok({ status: game.status })
  const isHost = game.hostId === userId
  if (!isHost) {
    const member = await tools.get('players', playerId(game.id, userId))
    if (!member.success) return fail('You are not in this game.')
    if (Date.now() - (game.revealedAt ?? 0) < HOST_AWAY_MS) return fail('Waiting for the host.')
  }
  // Guard against a double-click advancing twice: only move on from the index we saw.
  if (params.fromIndex !== undefined && Number(params.fromIndex) !== game.currentIndex) {
    return ok({ status: game.status })
  }

  const now = Date.now()
  const next = game.currentIndex + 1
  if (next >= game.questionCount) {
    await tools.update('games', game.id, { status: 'finished' })
    // Post-game recap is a second JobRoom job so the finish screen stays snappy.
    await enqueueSummary(env, tools, game.id, game.topic, userId)
    return ok({ status: 'finished', now })
  }
  await tools.update('games', game.id, { status: 'question', currentIndex: next, questionStartedAt: now })
  return ok({ status: 'question', now })
}

async function enqueueSummary(
  env: Env,
  tools: ActionTools,
  gameId: string,
  topic: string,
  userId: string,
) {
  if (env.JOB_ROOMS == null) return
  const pending = await tools.create(
    'summaries',
    { gameId, topic, headline: '', body: '', highlights: [], status: 'pending' },
    `summary__${gameId}`,
  )
  // uniqueOn gameId — a second finish click is fine.
  if (!pending.success && !/duplicate/i.test(pending.error ?? '')) {
    console.warn(`[summarize] create row failed: ${pending.error}`)
  }
  try {
    const jobId = await enqueueJob(env.JOB_ROOMS, `app:${env.DEEPSPACE_APP_ID}`, SUMMARIZE_GAME, { gameId }, {
      maxAttempts: 1,
      enqueuedBy: userId,
    })
    await tools.update('games', gameId, { summaryJobId: jobId })
    if (pending.success) await tools.update('summaries', pending.data.recordId, { jobId })
  } catch (err) {
    console.error(`[summarize] enqueue failed: ${(err as Error).message}`)
    await tools.update('summaries', `summary__${gameId}`, { status: 'failed', body: 'Could not write a recap.' }).catch(() => {})
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function newPlayer(gameId: string, userId: string, name: string): Player & Record<string, unknown> {
  return { gameId, userId, name, score: 0, streak: 0, correctCount: 0, lastAnsweredIndex: -1, lastPoints: 0 }
}

async function uniqueRoomCode(tools: ActionTools): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = generateRoomCode()
    const clash = await tools.query<{ status: string }>('games', { where: { code }, limit: 5 })
    // Finished and failed rooms free their code for reuse.
    if (
      !clash.success ||
      clash.data.records.every((r) => r.data.status === 'finished' || r.data.status === 'failed')
    ) {
      return code
    }
  }
  return generateRoomCode()
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Host may attach R2 keys from useR2Files({ scope: 'app' }) before createGame. */
function parseHostFiles(params: Record<string, unknown>) {
  const coverFileKey = cleanKey(params.coverFileKey)
  const coverUrl = cleanUrl(params.coverUrl)
  const attachmentFileKey = cleanKey(params.attachmentFileKey)
  const attachmentName = String(params.attachmentName ?? '').trim().slice(0, 120)
  const attachmentMime = String(params.attachmentMime ?? '').trim().slice(0, 80)
  const out: Partial<Game> = {}
  if (coverFileKey) out.coverFileKey = coverFileKey
  if (coverUrl) out.coverUrl = coverUrl
  if (attachmentFileKey) {
    out.attachmentFileKey = attachmentFileKey
    if (attachmentName) out.attachmentName = attachmentName
    if (attachmentMime) out.attachmentMime = attachmentMime
  }
  return out
}

function cleanKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim().slice(0, 240)
  // Reject path escape / absolute URLs posing as keys.
  if (!key || key.includes('..') || key.includes('\\') || /^https?:/i.test(key)) return undefined
  return key
}

function cleanUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const url = value.trim()
  if (!/^https?:\/\//i.test(url) || url.length > 500) return undefined
  return url
}

export const triviaActions: Record<string, ActionHandler<Env>> = {
  serverTime,
  createGame,
  joinGame,
  startGame,
  submitAnswer,
  revealQuestion,
  nextQuestion,
}
