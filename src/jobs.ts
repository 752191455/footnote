/**
 * Background-job handler — invoked by AppJobRoom (worker.ts) for every job
 * picked up from the queue.
 *
 * Job types (both enqueued only from server actions — socket writes are refused):
 *   - generate-quiz: Wikipedia + Exa + Claude → questions
 *   - summarize-game: Claude → post-game recap into `summaries`
 */

import type { Job, JobContext } from 'deepspace/worker'
import type { Env } from '../worker'
import { createActionTools } from './server/action-routes'
import { GENERATE_QUIZ, GenerationError, generateQuiz, type GenerateQuizPayload } from './server/quiz-generator'
import { SUMMARIZE_GAME, summarizeGame, type SummarizePayload } from './server/summarize-game'

/** Upstreams normally answer in ~10s; past this something is stuck. */
const GENERATION_DEADLINE_MS = 2 * 60 * 1000
const SUMMARY_DEADLINE_MS = 60_000

export async function runJob(job: Job, ctx: JobContext, env: Env): Promise<unknown> {
  const hostId = job.enqueuedBy ?? env.OWNER_USER_ID
  const tools = createActionTools(env, hostId, '')

  if (job.type === GENERATE_QUIZ) {
    const payload = job.payload as GenerateQuizPayload
    try {
      const result = await withDeadline(
        generateQuiz(tools, payload, (value, message) => ctx.progress(value, message)),
        GENERATION_DEADLINE_MS,
        ctx.signal,
      )
      await tools.update('games', payload.gameId, {
        status: 'lobby',
        questionCount: result.questionCount,
        sources: result.sources,
        enrichment: result.enrichment,
        generationError: '',
      })
      ctx.progress(1, `${result.questionCount} questions ready`)
      return result
    } catch (err) {
      const message =
        err instanceof GenerationError ? err.message : 'Something went wrong while writing the quiz. Try again.'
      await tools.update('games', payload.gameId, { status: 'failed', generationError: message })
      throw err
    }
  }

  if (job.type === SUMMARIZE_GAME) {
    const payload = job.payload as SummarizePayload
    try {
      ctx.progress(0.2, 'Writing the recap…')
      const result = await withDeadline(summarizeGame(tools, payload), SUMMARY_DEADLINE_MS, ctx.signal)
      ctx.progress(1, 'Recap ready')
      return result
    } catch (err) {
      await tools
        .update('summaries', `summary__${payload.gameId}`, {
          status: 'failed',
          body: err instanceof Error ? err.message : 'Could not write a recap.',
        })
        .catch(() => {})
      throw err
    }
  }

  throw new Error(`Unknown job type: ${job.type}`)
}

function withDeadline<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GenerationError('That job took too long. Try again.')), ms)
    signal.addEventListener('abort', () => reject(new GenerationError('Job was canceled.')), { once: true })
    work.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
