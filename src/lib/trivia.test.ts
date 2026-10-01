import { describe, expect, it } from 'vitest'
import {
  CODE_LENGTH,
  articleHtmlToText,
  extractJsonObject,
  generateRoomCode,
  normalizeRoomCode,
  rankPlayers,
  scoreAnswer,
  validateGeneratedQuestions,
} from './trivia'

const identity = <T,>(items: T[]) => [...items]
const reverse = <T,>(items: T[]) => [...items].reverse()

describe('scoreAnswer', () => {
  const base = { durationMs: 20_000, streak: 1 }
  it('gives nothing for a wrong answer', () => {
    expect(scoreAnswer({ ...base, correct: false, elapsedMs: 0 })).toBe(0)
  })
  it('rewards speed linearly between 500 and 1000', () => {
    expect(scoreAnswer({ ...base, correct: true, elapsedMs: 0 })).toBe(1000)
    expect(scoreAnswer({ ...base, correct: true, elapsedMs: 10_000 })).toBe(750)
    expect(scoreAnswer({ ...base, correct: true, elapsedMs: 20_000 })).toBe(500)
  })
  it('clamps late and negative elapsed times', () => {
    expect(scoreAnswer({ ...base, correct: true, elapsedMs: 21_500 })).toBe(500)
    expect(scoreAnswer({ ...base, correct: true, elapsedMs: -50 })).toBe(1000)
  })
  it('adds a capped streak bonus', () => {
    expect(scoreAnswer({ ...base, correct: true, elapsedMs: 20_000, streak: 3 })).toBe(600)
    expect(scoreAnswer({ ...base, correct: true, elapsedMs: 20_000, streak: 50 })).toBe(750)
  })
})

describe('room codes', () => {
  it('generates codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode()
      expect(code).toHaveLength(CODE_LENGTH)
      expect(code).toMatch(/^[A-HJ-NP-Z]+$/)
    }
  })
  it('normalizes user input', () => {
    expect(normalizeRoomCode(' ab-cd ')).toBe('ABCD')
    expect(normalizeRoomCode('abcdefg')).toBe('ABCD')
  })
})

describe('articleHtmlToText', () => {
  it('keeps paragraph prose and drops references, styles and short fragments', () => {
    const html = `
      <style>.x{}</style>
      <table><tr><td>Infobox noise that should vanish entirely</td></tr></table>
      <p>Short.</p>
      <p>The <b>octopus</b> is a soft-bodied, eight-limbed mollusc&nbsp;of the order Octopoda.<sup class="reference">[1]</sup></p>
      <p>Octopuses have three hearts and blue blood, and can change colour in milliseconds.[2]</p>`
    const text = articleHtmlToText(html)
    expect(text).toContain('The octopus is a soft-bodied, eight-limbed mollusc of the order Octopoda.')
    expect(text).toContain('three hearts')
    expect(text).not.toMatch(/Infobox|Short\.|\[\d\]|<|\.x/)
  })
  it('caps the length', () => {
    const p = `<p>${'word '.repeat(400)}</p>`
    expect(articleHtmlToText(p.repeat(10), 1000).length).toBeLessThanOrEqual(1000)
  })
})

describe('extractJsonObject', () => {
  it('reads JSON wrapped in fences or prose', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJsonObject('no json')).toBeNull()
    expect(extractJsonObject('{broken')).toBeNull()
  })
})

describe('validateGeneratedQuestions', () => {
  const good = {
    prompt: 'How many hearts does an octopus have?',
    choices: ['One', 'Two', 'Three', 'Four'],
    correctIndex: 2,
    explanation: 'Octopuses have three hearts.',
    source: 0,
  }

  it('keeps valid questions', () => {
    const [q] = validateGeneratedQuestions({ questions: [good] }, 1, identity)
    expect(q).toMatchObject({ choices: good.choices, correctIndex: 2, sourceIndex: 0 })
  })

  it('tracks the correct answer through the shuffle', () => {
    const [q] = validateGeneratedQuestions({ questions: [good] }, 1, reverse)
    expect(q.choices).toEqual(['Four', 'Three', 'Two', 'One'])
    expect(q.choices[q.correctIndex]).toBe('Three')
  })

  it('drops malformed, duplicate and unsourced questions', () => {
    const out = validateGeneratedQuestions(
      {
        questions: [
          good,
          { ...good }, // duplicate prompt
          { ...good, prompt: 'Which is unsourced here?', source: 3 },
          { ...good, prompt: 'Which has repeated choices?', choices: ['A', 'a', 'B', 'C'] },
          { ...good, prompt: 'Which has three choices?', choices: ['A', 'B', 'C'] },
          { ...good, prompt: 'Which has a bad index?', correctIndex: 4 },
          'not an object',
        ],
      },
      1,
      identity,
    )
    expect(out).toHaveLength(1)
  })

  it('returns nothing for a non-list payload', () => {
    expect(validateGeneratedQuestions(null, 1)).toEqual([])
    expect(validateGeneratedQuestions({ questions: 'nope' }, 1)).toEqual([])
  })
})

describe('rankPlayers', () => {
  it('uses competition ranking for ties', () => {
    const ranked = rankPlayers([
      { userId: 'a', name: 'Ann', score: 900 },
      { userId: 'b', name: 'Bo', score: 1200 },
      { userId: 'c', name: 'Cy', score: 900 },
      { userId: 'd', name: 'Di', score: 0 },
    ])
    expect(ranked.map((p) => [p.userId, p.rank])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 2],
      ['d', 4],
    ])
  })
})
