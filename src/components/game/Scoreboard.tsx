import { ArrowDown, ArrowUp, Flame } from 'lucide-react'
import type { RecordData } from 'deepspace'
import { cn } from '@/lib/utils'
import type { PlayerData } from '../../lib/game-client'
import { rankPlayers } from '../../lib/trivia'

interface ScoreboardProps {
  players: RecordData<PlayerData>[]
  meId: string | null
  online: Set<string>
  /** Show rank movement from the last round (score minus lastPoints). */
  showMovement?: boolean
  limit?: number
}

export function Scoreboard({ players, meId, online, showMovement, limit }: ScoreboardProps) {
  const rows = players.map((p) => ({ ...p.data, name: p.data.name ?? 'Player', score: p.data.score ?? 0 }))
  const ranked = rankPlayers(rows)
  const before = showMovement
    ? new Map(rankPlayers(rows.map((p) => ({ ...p, score: p.score - (p.lastPoints ?? 0) }))).map((p) => [p.userId, p.rank]))
    : null

  let shown = limit ? ranked.slice(0, limit) : ranked
  // Always show the viewer's own row, even outside the top N.
  const mine = ranked.find((p) => p.userId === meId)
  if (limit && mine && !shown.includes(mine)) shown = [...shown, mine]

  return (
    <ol className="divide-y divide-border rounded-md border border-border bg-card" data-testid="scoreboard">
      {shown.map((p) => {
        const prev = before?.get(p.userId)
        const moved = prev ? prev - p.rank : 0
        const isMe = p.userId === meId
        return (
          <li
            key={p.userId}
            className={cn('flex items-center gap-3 px-4 py-2.5', isMe && 'bg-primary/[0.07]')}
          >
            <span className="font-code w-6 text-right text-sm font-bold tabular-nums text-muted-foreground">{p.rank}</span>
            <span
              aria-label={online.has(p.userId) ? 'online' : 'offline'}
              className={cn('h-2 w-2 shrink-0 rounded-full', online.has(p.userId) ? 'bg-[var(--color-choice-3)]' : 'bg-border')}
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {p.name}
              {isMe && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
            </span>
            {(p.streak ?? 0) >= 2 && (
              <span className="flex items-center gap-0.5 text-xs font-semibold text-[var(--color-choice-2)]" title="Correct-answer streak">
                <Flame className="h-3.5 w-3.5" aria-hidden />
                {p.streak}
              </span>
            )}
            {showMovement && moved !== 0 && (
              <span className={cn('flex items-center text-xs', moved > 0 ? 'text-[var(--color-choice-3)]' : 'text-muted-foreground')}>
                {moved > 0 ? <ArrowUp className="h-3.5 w-3.5" aria-label="moved up" /> : <ArrowDown className="h-3.5 w-3.5" aria-label="moved down" />}
                {Math.abs(moved)}
              </span>
            )}
            {showMovement && (p.lastPoints ?? 0) > 0 && (
              <span className="font-code text-xs text-[var(--color-choice-3)]">+{p.lastPoints}</span>
            )}
            <span className="font-code w-16 text-right font-bold tabular-nums">{p.score.toLocaleString()}</span>
          </li>
        )
      })}
    </ol>
  )
}
