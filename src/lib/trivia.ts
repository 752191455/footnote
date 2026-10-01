/**
 * Pure game logic shared by the worker (actions) and the client (display).
 * No I/O here — everything is unit-tested in trivia.test.ts.
 */

import { z } from 'zod'

export const LIMITS = {
  minQuestions: 3,
  maxQuestions: 12,
  minSeconds: 10,
  maxSeconds: 45,
  topicMaxLength: 80,
  /** Games a single user may create per rolling 24h — owner pays for generation. */
  gamesPerDay: 10,
  /** Network grace after the visible deadline before an answer is refused. */
  answerGraceMs: 1500,
} as const

// ── Room codes ────────────────────────────────────────────────────────────

/** No I, O, 0, 1 — codes get read aloud across a room. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const CODE_LENGTH = 4

export function generateRoomCode(random: (n: number) => number = cryptoRandomInt): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[random(CODE_ALPHABET.length)]
  return code
}

export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LENGTH)
}

function cryptoRandomInt(n: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % n
}

// ── Scoring ───────────────────────────────────────────────────────────────

export const SCORING = {
  base: 500,
  speedBonus: 500,
  streakStep: 50,
  streakCap: 5,
} as const

/**
 * Points for one answer. A correct answer earns 500 plus up to 500 for speed
 * (linear over the question window), plus 50 per consecutive correct answer
 * beyond the first (capped). `streak` is the streak *including* this answer.
 */
export function scoreAnswer(opts: {
  correct: boolean
  elapsedMs: number
  durationMs: number
  streak: number
}): number {
  if (!opts.correct) return 0
  const t = Math.min(1, Math.max(0, opts.elapsedMs / opts.durationMs))
  const speed = Math.round(SCORING.speedBonus * (1 - t))
  const streakBonus = SCORING.streakStep * Math.min(SCORING.streakCap, Math.max(0, opts.streak - 1))
  return SCORING.base + speed + streakBonus
}

// ── Wikipedia text extraction ─────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&#160;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
}

/**
 * Turn Wikipedia's rendered article HTML into plain prose: keep paragraph
 * text only (infoboxes, navboxes, and tables are noise for question writing),
 * drop citation markers, and cap the length so the prompt stays small.
 */
export function articleHtmlToText(html: string, maxChars = 6000): string {
  const cleaned = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<sup[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/gi, '')
  const paragraphs: string[] = []
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi
  let total = 0
  for (let m = re.exec(cleaned); m && total < maxChars; m = re.exec(cleaned)) {
    const text = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&[#a-z0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ')
      .replace(/\[\d+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 40) continue
    paragraphs.push(text)
    total += text.length
  }
  return paragraphs.join('\n\n').slice(0, maxChars)
}

export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

// ── Generated question validation ─────────────────────────────────────────

const generatedQuestionSchema = z.object({
  prompt: z.string().min(8).max(300),
  choices: z.array(z.string().min(1).max(120)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanation: z.string().max(400).optional().default(''),
  source: z.number().int().min(0),
})

export interface ValidQuestion {
  prompt: string
  choices: string[]
  correctIndex: number
  explanation: string
  sourceIndex: number
}

/** Pull the first JSON object out of a model reply (tolerates code fences / preamble). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Validate the model's questions and keep only well-formed ones: four distinct
 * choices, a source that exists, and no duplicate prompts. Choices are then
 * shuffled so the correct answer's position carries no signal (models favour
 * some positions).
 */
export function validateGeneratedQuestions(
  raw: unknown,
  sourceCount: number,
  shuffle: <T>(items: T[]) => T[] = shuffleArray,
): ValidQuestion[] {
  const list = (raw as { questions?: unknown })?.questions
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: ValidQuestion[] = []
  for (const item of list) {
    const parsed = generatedQuestionSchema.safeParse(item)
    if (!parsed.success) continue
    const q = parsed.data
    if (q.source >= sourceCount) continue
    const choices = q.choices.map((c) => c.trim())
    if (new Set(choices.map((c) => c.toLowerCase())).size !== 4) continue
    const key = q.prompt.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const order = shuffle([0, 1, 2, 3])
    out.push({
      prompt: q.prompt.trim(),
      choices: order.map((i) => choices[i]),
      correctIndex: order.indexOf(q.correctIndex),
      explanation: q.explanation.trim(),
      sourceIndex: q.source,
    })
  }
  return out
}

export function shuffleArray<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ── Leaderboard ───────────────────────────────────────────────────────────

export interface RankedPlayer {
  userId: string
  name: string
  score: number
  rank: number
}

/** Standard competition ranking (1, 2, 2, 4): ties share a rank. */
export function rankPlayers<T extends { userId: string; name?: string; score?: number }>(
  players: T[],
): (T & { rank: number })[] {
  const sorted = [...players].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.name ?? '').localeCompare(b.name ?? ''),
  )
  let rank = 0
  let prev: number | null = null
  return sorted.map((p, i) => {
    const s = p.score ?? 0
    if (s !== prev) rank = i + 1
    prev = s
    return { ...p, rank }
  })
}
