import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const LETTERS = ['A', 'B', 'C', 'D']

interface ChoiceGridProps {
  choices: string[]
  /** The player's locked-in choice, if any. */
  picked?: number | null
  /** Set once revealed. */
  correctIndex?: number | null
  distribution?: number[] | null
  disabled?: boolean
  onPick?: (index: number) => void
}

/**
 * The four answer tiles. Three looks from one component: open (pickable),
 * locked (your pick ringed, the rest dimmed), and revealed (correct answer
 * solid, a wrong pick struck, and how many people chose each).
 */
export function ChoiceGrid({ choices, picked, correctIndex, distribution, disabled, onPick }: ChoiceGridProps) {
  const revealed = correctIndex !== null && correctIndex !== undefined
  const locked = picked !== null && picked !== undefined
  const total = distribution?.reduce((a, b) => a + b, 0) ?? 0

  return (
    <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Answer choices">
      {choices.map((choice, i) => {
        const color = `var(--color-choice-${i})`
        const isPicked = picked === i
        const isCorrect = revealed && correctIndex === i
        const isWrongPick = revealed && isPicked && !isCorrect
        const dim = revealed ? !isCorrect && !isPicked : locked && !isPicked
        const count = distribution?.[i] ?? 0
        const share = total > 0 ? count / total : 0

        return (
          <button
            key={i}
            type="button"
            data-testid={`choice-${i}`}
            data-correct={isCorrect || undefined}
            aria-pressed={isPicked}
            disabled={disabled || locked || revealed}
            onClick={() => onPick?.(i)}
            style={{ '--choice': color } as React.CSSProperties}
            className={cn(
              'group relative flex min-h-[4.5rem] items-center gap-3 overflow-hidden rounded-md border-2 px-4 py-3 text-left text-base font-semibold transition-all',
              'disabled:cursor-default',
              !revealed && !locked && 'border-[var(--choice)] bg-card hover:-translate-y-0.5 hover:bg-[var(--choice)] hover:text-white active:translate-y-0',
              locked && !revealed && isPicked && 'border-[var(--choice)] bg-[var(--choice)] text-white ring-4 ring-[var(--choice)]/25',
              isCorrect && 'border-[var(--choice)] bg-[var(--choice)] text-white',
              isWrongPick && 'border-foreground/40 bg-card text-foreground line-through decoration-2',
              dim && 'border-border bg-card text-muted-foreground opacity-60',
            )}
          >
            {/* Distribution bar fills behind the label after the reveal. */}
            {revealed && (
              <span
                aria-hidden
                className={cn('absolute inset-y-0 left-0 transition-[width] duration-700 ease-out', isCorrect ? 'bg-black/15' : 'bg-foreground/[0.06]')}
                style={{ width: `${Math.round(share * 100)}%` }}
              />
            )}
            <span
              className={cn(
                'font-code relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-sm font-bold',
                (isCorrect || (locked && isPicked && !revealed)) ? 'bg-white/20 text-white' : 'bg-[var(--choice)] text-white group-hover:bg-white/20',
                dim && 'bg-muted text-muted-foreground',
              )}
            >
              {LETTERS[i]}
            </span>
            <span className="relative flex-1">{choice}</span>
            {revealed && (
              <span className="font-code relative flex items-center gap-1.5 text-sm tabular-nums">
                {count}
                {isCorrect && <Check className="h-5 w-5" aria-label="Correct answer" />}
                {isWrongPick && <X className="h-5 w-5" aria-label="Your pick" />}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
