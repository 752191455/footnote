/**
 * Landing page — a STATIC page (no providers, prerendered at build).
 * Shows a sample revealed question so visitors see the product, not a poster.
 */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

const SAMPLE = {
  prompt: 'How many hearts does an octopus have?',
  choices: ['One', 'Two', 'Three', 'Nine'],
  correct: 2,
  counts: [0, 2, 5, 1],
}

export default function Landing() {
  const total = SAMPLE.counts.reduce((a, b) => a + b, 0)
  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="min-h-screen bg-background text-foreground">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
          <span className="font-display text-xl font-black">
            Footnote<span className="text-primary">.</span>
          </span>
          <Link to="/home" className="text-sm font-medium underline-offset-4 hover:underline">
            Sign in
          </Link>
        </header>

        <main className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-8 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-16">
          <section>
            <p className="font-code mb-4 text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Live trivia · cited to Wikipedia
            </p>
            <h1 className="font-display text-5xl font-black leading-[1.02] sm:text-7xl">
              Any topic becomes a quiz night<span className="text-primary">.</span>
            </h1>
            <p className="mt-6 max-w-lg text-lg text-muted-foreground">
              Name a subject and Footnote reads Wikipedia, writes the questions, and runs the game live for
              your group. When the answer is revealed, so is the article it came from.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                to="/home"
                className="inline-flex h-12 items-center rounded-md bg-primary px-7 font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                Host a game
              </Link>
              <Link to="/home" className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground">
                I have a code
              </Link>
            </div>
          </section>

          <figure aria-label="A revealed question from a sample game" className="rounded-lg border border-border bg-card p-5 shadow-[0_2px_0_0_rgba(27,26,23,0.08)]">
            <p className="font-code text-xs uppercase tracking-[0.2em] text-muted-foreground">
              Octopuses · Question 3 of 8
            </p>
            <p className="font-display mt-2 text-2xl font-bold leading-snug">{SAMPLE.prompt}</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {SAMPLE.choices.map((c, i) => {
                const right = i === SAMPLE.correct
                return (
                  <li
                    key={c}
                    className="relative flex items-center gap-3 overflow-hidden rounded-md border-2 px-3 py-2.5 font-semibold"
                    style={{
                      borderColor: right ? `var(--color-choice-${i})` : 'var(--color-border)',
                      background: right ? `var(--color-choice-${i})` : undefined,
                      color: right ? '#fff' : 'var(--color-muted-foreground)',
                    }}
                  >
                    <span aria-hidden className="absolute inset-y-0 left-0 bg-black/10" style={{ width: `${(SAMPLE.counts[i] / total) * 100}%` }} />
                    <span className="font-code relative text-sm">{'ABCD'[i]}</span>
                    <span className="relative flex-1">{c}</span>
                    <span className="font-code relative text-sm">{SAMPLE.counts[i]}</span>
                  </li>
                )
              })}
            </ul>
            <figcaption className="mt-4 border-l-2 border-primary pl-3 text-sm">
              An octopus has three hearts: two pump blood through the gills, one through the body.
              <span className="mt-1 block text-muted-foreground">
                <sup className="font-code">[1]</sup> Octopus, Wikipedia
              </span>
            </figcaption>
          </figure>
        </main>
      </div>
    </>
  )
}
