/**
 * Post-game recap: Claude writes a short summary from the live standings.
 * Enqueued when a game flips to `finished` (see nextQuestion).
 */

import type { ActionTools } from 'deepspace/worker'
import { extractJsonObject } from '../lib/trivia'

export const SUMMARIZE_GAME = 'summarize-game'
const MODEL = 'claude-haiku-4-5'

export interface SummarizePayload {
  gameId: string
}

export async function summarizeGame(tools: ActionTools, { gameId }: SummarizePayload) {
  const gameRes = await tools.get<{
    topic: string
    code: string
    questionCount: number
    sources?: { title: string; url: string }[]
  }>('games', gameId)
  if (!gameRes.success) throw new Error('Game not found for summary.')

  const [playersRes, questionsRes] = await Promise.all([
    tools.query<{
      name?: string
      score?: number
      correctCount?: number
      userId: string
    }>('players', { where: { gameId }, limit: 40 }),
    tools.query<{
      prompt: string
      explanation?: string
      sourceTitle?: string
    }>('questions', { where: { gameId }, limit: 20 }),
  ])

  const players = (playersRes.success ? playersRes.data.records : [])
    .map((p) => p.data)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const questions = questionsRes.success ? questionsRes.data.records.map((q) => q.data) : []
  const game = gameRes.data.record.data

  const standings = players
    .map((p, i) => `${i + 1}. ${p.name ?? 'Player'} — ${p.score ?? 0} pts (${p.correctCount ?? 0} correct)`)
    .join('\n')
  const facts = questions
    .slice(0, 6)
    .map((q) => `- ${q.prompt}${q.explanation ? ` → ${q.explanation}` : ''}`)
    .join('\n')

  const reply = await tools.integration('anthropic/chat-completion', {
    model: MODEL,
    max_tokens: 700,
    temperature: 0.6,
    system: [
      'You write a short, lively post-game recap for a Wikipedia-grounded trivia night.',
      'Stay factual about scores; do not invent player names or scores.',
      'Reply with JSON only:',
      '{"headline":"…","body":"2-4 sentences","highlights":[{"label":"…","text":"…"}]}',
      'At most 3 highlights. Keep the body under 400 characters.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: `Topic: ${game.topic}\nRoom: ${game.code}\nQuestions: ${game.questionCount}\n\nStandings:\n${standings || '(no players)'}\n\nSample facts:\n${facts || '(none)'}`,
      },
    ],
  })
  if (!reply.success) throw new Error(`Summary writer failed: ${reply.error}`)

  const parsed = parseSummary(extractJsonObject(replyText(reply.data)), game.topic)
  const rowId = `summary__${gameId}`
  await tools.update('summaries', rowId, {
    topic: game.topic,
    headline: parsed.headline,
    body: parsed.body,
    highlights: parsed.highlights,
    status: 'ready',
  })
  return parsed
}

function parseSummary(raw: unknown, topic: string) {
  const d = (raw && typeof raw === 'object' ? raw : {}) as {
    headline?: unknown
    body?: unknown
    highlights?: unknown
  }
  const headline = typeof d.headline === 'string' && d.headline.trim() ? d.headline.trim().slice(0, 120) : `${topic} wrap-up`
  const body =
    typeof d.body === 'string' && d.body.trim()
      ? d.body.trim().slice(0, 500)
      : 'Thanks for playing Footnote.'
  const highlights: { label: string; text: string }[] = []
  if (Array.isArray(d.highlights)) {
    for (const h of d.highlights.slice(0, 3)) {
      if (!h || typeof h !== 'object') continue
      const label = String((h as { label?: string }).label ?? '').trim().slice(0, 40)
      const text = String((h as { text?: string }).text ?? '').trim().slice(0, 160)
      if (label && text) highlights.push({ label, text })
    }
  }
  return { headline, body, highlights }
}

function replyText(data: unknown): string {
  const d = data as { content?: { type?: string; text?: string }[]; text?: string }
  if (Array.isArray(d?.content)) {
    return d.content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('')
  }
  return typeof d?.text === 'string' ? d.text : ''
}
