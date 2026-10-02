/**
 * The game room — /play/:code. One page, four phases (lobby → question →
 * reveal → finished), all driven by the synced `games` row. Clients never
 * write game state; they call server actions and render what syncs back.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AuthOverlay, useAuth, usePresenceRoom, useQuery, type RecordData } from 'deepspace'
import { BookOpenText, Check, Copy, Crown, ExternalLink, Play, Users } from 'lucide-react'
import { Button, EmptyState, useToast } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ChoiceGrid } from '../../../components/game/ChoiceGrid'
import { Scoreboard } from '../../../components/game/Scoreboard'
import {
  callAction,
  serverNow,
  useServerNow,
  type GameData,
  type PlayerData,
  type QuestionData,
  type SubmissionData,
} from '../../../lib/game-client'
import { normalizeRoomCode, rankPlayers } from '../../../lib/trivia'

/** Mirrors HOST_AWAY_MS in src/actions/trivia.ts. */
const HOST_AWAY_MS = 20_000

export default function PlayPage() {
  const { code: rawCode = '' } = useParams()
  const code = normalizeRoomCode(rawCode)
  const { isSignedIn, isLoaded } = useAuth()
  const games = useQuery<GameData>('games', { where: { code }, orderBy: 'createdAt', orderDir: 'desc', limit: 1 })
  const game = games.records[0]

  if (isLoaded && !isSignedIn) {
    return (
      <Shell>
        <EmptyState
          icon={<Users />}
          title={`You're invited to game ${code}`}
          description="Sign in so your name shows on the scoreboard."
        />
        <AuthOverlay title={`Join game ${code}`} description="Sign in to take your seat." />
      </Shell>
    )
  }
  if (games.status === 'loading' || !isLoaded) return <RoomSkeleton />
  if (!game) {
    return (
      <Shell>
        <EmptyState
          icon={<BookOpenText />}
          title={`No game with code ${code}`}
          description="Check the code with your host. Codes are four letters."
        />
        <div className="text-center">
          <Link to="/home" className="text-sm text-primary underline-offset-4 hover:underline">
            Back to Footnote
          </Link>
        </div>
      </Shell>
    )
  }
  return <GameRoom game={game} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">{children}</div>
}

function RoomSkeleton() {
  return (
    <Shell>
      <div className="space-y-4">
        <div className="h-8 w-1/2 animate-pulse rounded-md bg-muted" />
        <div className="h-32 animate-pulse rounded-md bg-muted" />
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      </div>
    </Shell>
  )
}

// ── Room ──────────────────────────────────────────────────────────────────

function GameRoom({ game }: { game: RecordData<GameData> }) {
  const gameId = game.recordId
  const g = game.data
  const { userId } = useAuth()
  const { error } = useToast()

  const players = useQuery<PlayerData>('players', { where: { gameId }, limit: 50 })
  const questions = useQuery<QuestionData>('questions', { where: { gameId }, limit: 20 })
  // RBAC returns only the caller's own submissions, so this is "my answers".
  const mySubs = useQuery<SubmissionData>('submissions', { where: { gameId }, limit: 20 })

  // Who has this room open right now (ephemeral, sub-second), vs. who has joined (persistent).
  const { peers } = usePresenceRoom(`game:${gameId}`)
  const online = useMemo(() => {
    const s = new Set(peers.map((p) => p.userId))
    if (userId) s.add(userId)
    return s
  }, [peers, userId])

  const me = players.records.find((p) => p.data.userId === userId)
  const isHost = g.hostId === userId

  // Opening an invite link takes your seat automatically.
  const joinAttempted = useRef(false)
  useEffect(() => {
    if (players.status !== 'ready' || me || joinAttempted.current || g.status === 'finished') return
    joinAttempted.current = true
    callAction('joinGame', { code: g.code }).catch((err) => error('Could not join', (err as Error).message))
  }, [players.status, me, g.status, g.code, error])

  const current = questions.records.find((q) => q.data.index === g.currentIndex)
  const mySub = mySubs.records.find((s) => s.data.index === g.currentIndex)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8" data-testid="game-room" data-status={g.status}>
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="font-code text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Game <span className="font-bold text-foreground">{g.code}</span>
            {g.status !== 'lobby' && g.status !== 'finished' && (
              <>
                {' '}· Question {g.currentIndex + 1} of {g.questionCount}
              </>
            )}
          </p>
          <h1 className="font-display truncate text-2xl font-bold sm:text-3xl">{g.topic}</h1>
        </div>
        {me && (
          <p className="font-code text-sm tabular-nums">
            <span className="text-muted-foreground">Your score </span>
            <span className="font-bold" data-testid="my-score">{(me.data.score ?? 0).toLocaleString()}</span>
          </p>
        )}
      </header>

      {g.status === 'lobby' && (
        <Lobby gameId={gameId} game={g} players={players.records} online={online} isHost={isHost} />
      )}
      {(g.status === 'question' || g.status === 'reveal') && !current && <RoomSkeleton />}
      {g.status === 'question' && current && (
        <QuestionPhase
          gameId={gameId}
          game={g}
          question={current.data}
          mySub={mySub?.data}
          players={players.records}
          isHost={isHost}
          isPlayer={!!me}
        />
      )}
      {g.status === 'reveal' && current && (
        <RevealPhase
          gameId={gameId}
          game={g}
          question={current.data}
          mySub={mySub?.data}
          me={me?.data}
          players={players.records}
          online={online}
          meId={userId}
          isHost={isHost}
        />
      )}
      {g.status === 'finished' && (
        <FinishedPhase game={g} players={players.records} online={online} meId={userId} />
      )}
    </div>
  )
}

// ── Lobby ─────────────────────────────────────────────────────────────────

function Lobby({
  gameId,
  game,
  players,
  online,
  isHost,
}: {
  gameId: string
  game: GameData
  players: RecordData<PlayerData>[]
  online: Set<string>
  isHost: boolean
}) {
  const { success, error } = useToast()
  const [starting, setStarting] = useState(false)
  const [copied, setCopied] = useState(false)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/play/${game.code}`)
      setCopied(true)
      success('Invite link copied')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      error('Could not copy', 'Share the code instead.')
    }
  }

  async function start() {
    setStarting(true)
    try {
      await callAction('startGame', { gameId })
    } catch (err) {
      error('Could not start', (err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col items-center gap-4 rounded-lg border border-border bg-card px-6 py-8 text-center">
        <p className="text-sm text-muted-foreground">Join at this page with code</p>
        <p className="font-code text-6xl font-bold tracking-[0.25em] sm:text-7xl" data-testid="room-code">
          {game.code}
        </p>
        <Button variant="outline" size="sm" onClick={copyLink}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          Copy invite link
        </Button>
      </div>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Users className="h-4 w-4" aria-hidden />
          {players.length} {players.length === 1 ? 'player' : 'players'} seated
        </h2>
        <ul className="flex flex-wrap gap-2" data-testid="lobby-players">
          {players.map((p) => (
            <li
              key={p.recordId}
              className="animate-pop-in flex items-center gap-2 rounded-sm border border-border bg-card px-3 py-1.5 text-sm font-medium"
            >
              <span className={cn('h-2 w-2 rounded-full', online.has(p.data.userId) ? 'bg-[var(--color-choice-3)]' : 'bg-border')} />
              {p.data.name ?? 'Player'}
              {p.data.userId === game.hostId && <Crown className="h-3.5 w-3.5 text-[var(--color-choice-2)]" aria-label="host" />}
            </li>
          ))}
        </ul>
      </section>

      <Sources game={game} heading={`${game.questionCount} questions drawn from`} />

      <div className="sticky bottom-4 flex justify-center">
        {isHost ? (
          <Button size="lg" className="min-w-56 shadow-lg" loading={starting} onClick={start} data-testid="start-game">
            <Play aria-hidden />
            Start the game
          </Button>
        ) : (
          <p className="rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground shadow-sm">
            Waiting for {game.hostName ?? 'the host'} to start…
          </p>
        )}
      </div>
    </div>
  )
}

function Sources({ game, heading }: { game: GameData; heading: string }) {
  if (!game.sources?.length) return null
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{heading}</h2>
      <ol className="space-y-1 text-sm">
        {game.sources.map((s, i) => (
          <li key={s.url} className="flex gap-2">
            <span className="font-code text-muted-foreground">[{i + 1}]</span>
            <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline decoration-border underline-offset-4 hover:decoration-foreground">
              {s.title}
              <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden />
            </a>
            <span className="text-muted-foreground">· Wikipedia</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ── Question ──────────────────────────────────────────────────────────────

function QuestionPhase({
  gameId,
  game,
  question,
  mySub,
  players,
  isHost,
  isPlayer,
}: {
  gameId: string
  game: GameData
  question: QuestionData
  mySub?: SubmissionData
  players: RecordData<PlayerData>[]
  isHost: boolean
  isPlayer: boolean
}) {
  const { error } = useToast()
  const now = useServerNow()
  const [pending, setPending] = useState<number | null>(null)
  const index = question.index

  // Reset the optimistic pick when the question changes.
  useEffect(() => setPending(null), [index])

  const totalMs = game.secondsPerQuestion * 1000
  const remainingMs = Math.max(0, game.questionStartedAt + totalMs - now)
  const answered = players.filter((p) => (p.data.lastAnsweredIndex ?? -1) >= index).length
  const everyoneIn = players.length > 0 && answered === players.length
  const picked = mySub?.choice ?? pending

  // When time runs out (or everyone has answered), ask the server to close the
  // round. Every client may ask; the server's reveal lock scores it once. Non-
  // hosts wait a beat so the host's request usually wins and we avoid a stampede.
  const lastAsk = useRef(0)
  useEffect(() => {
    if (remainingMs > 0 && !everyoneIn) return
    const since = serverNow() - lastAsk.current
    if (since < 3000) return
    lastAsk.current = serverNow()
    const delay = isHost ? 0 : 400 + Math.random() * 1200
    const t = setTimeout(() => {
      callAction('revealQuestion', { gameId, index }).catch(() => {
        // "still open" races are expected; we retry on the next tick window.
      })
    }, delay)
    return () => clearTimeout(t)
  }, [remainingMs, everyoneIn, isHost, gameId, index])

  async function pick(choice: number) {
    if (picked !== null && picked !== undefined) return
    setPending(choice)
    try {
      await callAction('submitAnswer', { gameId, index, choice })
    } catch (err) {
      setPending(null)
      error('Answer not counted', (err as Error).message)
    }
  }

  const seconds = Math.ceil(remainingMs / 1000)
  const urgent = remainingMs <= 5000

  return (
    <div className="space-y-6" data-testid="question-phase">
      <div className="flex items-center gap-4">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={game.secondsPerQuestion} aria-valuenow={seconds} aria-label="Time left">
          <div
            className={cn('h-full origin-left rounded-full transition-[width] duration-200 ease-linear', urgent ? 'bg-primary' : 'bg-foreground')}
            style={{ width: `${(remainingMs / totalMs) * 100}%` }}
          />
        </div>
        <span className={cn('font-code w-10 text-right text-2xl font-bold tabular-nums', urgent && 'text-primary')} data-testid="seconds-left">
          {seconds}
        </span>
      </div>

      <h2 className="font-display animate-pop-in text-2xl font-bold leading-snug sm:text-3xl" key={index}>
        {question.prompt}
      </h2>

      <ChoiceGrid
        choices={question.choices}
        picked={picked}
        disabled={!isPlayer || remainingMs === 0}
        onPick={pick}
      />

      <p className="text-center text-sm text-muted-foreground" data-testid="answered-count">
        {picked !== null && picked !== undefined ? 'Locked in. ' : ''}
        <span className="font-semibold text-foreground">
          {answered} of {players.length}
        </span>{' '}
        answered
        {remainingMs === 0 && ' · revealing…'}
      </p>
    </div>
  )
}

// ── Reveal ────────────────────────────────────────────────────────────────

function RevealPhase({
  gameId,
  game,
  question,
  mySub,
  me,
  players,
  online,
  meId,
  isHost,
}: {
  gameId: string
  game: GameData
  question: QuestionData
  mySub?: SubmissionData
  me?: PlayerData
  players: RecordData<PlayerData>[]
  online: Set<string>
  meId: string | null
  isHost: boolean
}) {
  const { error } = useToast()
  const now = useServerNow(1000)
  const [advancing, setAdvancing] = useState(false)
  const isLast = game.currentIndex + 1 >= game.questionCount
  const hostAway = now - (game.revealedAt ?? now) >= HOST_AWAY_MS

  async function next() {
    setAdvancing(true)
    try {
      await callAction('nextQuestion', { gameId, fromIndex: game.currentIndex })
    } catch (err) {
      error('Could not continue', (err as Error).message)
    } finally {
      setAdvancing(false)
    }
  }

  const correct = mySub && mySub.choice === question.correctIndex
  const points = me?.lastPoints ?? 0
  const sourceNumber = (game.sources?.findIndex((s) => s.url === question.sourceUrl) ?? -1) + 1

  return (
    <div className="space-y-6" data-testid="reveal-phase">
      <div
        className={cn(
          'animate-pop-in flex items-center justify-between rounded-md px-4 py-3 font-semibold',
          !me ? 'bg-muted text-muted-foreground' : correct ? 'bg-[var(--color-choice-3)] text-white' : 'bg-foreground text-background',
        )}
        data-testid="round-result"
      >
        <span>{!me ? 'Spectating' : !mySub ? 'No answer in time' : correct ? 'Correct!' : 'Not quite'}</span>
        {me && (
          <span className="font-code tabular-nums">
            {points > 0 ? `+${points}` : '+0'}
            {(me.streak ?? 0) >= 2 && ` · streak ${me.streak}`}
          </span>
        )}
      </div>

      <h2 className="font-display text-2xl font-bold leading-snug sm:text-3xl">{question.prompt}</h2>

      <ChoiceGrid
        choices={question.choices}
        picked={mySub?.choice}
        correctIndex={question.correctIndex}
        distribution={question.distribution}
      />

      {(question.explanation || question.sourceUrl) && (
        <aside className="border-l-2 border-primary pl-4 text-sm" data-testid="footnote">
          {question.explanation && <p className="text-foreground">{question.explanation}</p>}
          {question.sourceUrl && (
            <p className="mt-1 text-muted-foreground">
              {sourceNumber > 0 && <sup className="font-code mr-1">[{sourceNumber}]</sup>}
              <a href={question.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground">
                {question.sourceTitle ?? 'Source'}, Wikipedia
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </p>
          )}
        </aside>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Standings</h3>
        <Scoreboard players={players} meId={meId} online={online} showMovement limit={5} />
      </section>

      <div className="flex justify-center">
        {isHost ? (
          <Button size="lg" className="min-w-56" loading={advancing} onClick={next} data-testid="next-question">
            {isLast ? 'See final results' : 'Next question'}
          </Button>
        ) : hostAway ? (
          <Button size="lg" variant="outline" loading={advancing} onClick={next}>
            Host away? Continue
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Waiting for {game.hostName ?? 'the host'}…</p>
        )}
      </div>
    </div>
  )
}

// ── Finished ──────────────────────────────────────────────────────────────

function FinishedPhase({
  game,
  players,
  online,
  meId,
}: {
  game: GameData
  players: RecordData<PlayerData>[]
  online: Set<string>
  meId: string | null
}) {
  const ranked = rankPlayers(players.map((p) => ({ ...p.data, name: p.data.name ?? 'Player', score: p.data.score ?? 0 })))
  const podium = ranked.slice(0, 3)
  const heights = ['h-28', 'h-20', 'h-14']
  const order = [1, 0, 2] // silver, gold, bronze, left to right

  return (
    <div className="space-y-10" data-testid="finished-phase">
      <section className="text-center">
        <p className="font-code text-xs uppercase tracking-[0.2em] text-muted-foreground">Final results</p>
        {podium[0] && (
          <p className="font-display mt-2 text-3xl font-black sm:text-4xl" data-testid="winner">
            {podium[0].name} wins<span className="text-primary">.</span>
          </p>
        )}
        <div className="mx-auto mt-8 flex max-w-md items-end justify-center gap-3">
          {order
            .filter((i) => podium[i])
            .map((i) => (
              <div key={podium[i].userId} className="flex flex-1 flex-col items-center gap-2">
                <span className="max-w-full truncate text-sm font-semibold">{podium[i].name}</span>
                <span className="font-code text-xs tabular-nums text-muted-foreground">
                  {podium[i].score.toLocaleString()}
                </span>
                <div
                  className={cn('flex w-full items-start justify-center rounded-t-md pt-2 text-white', heights[i])}
                  style={{ background: `var(--color-choice-${i === 0 ? 2 : i === 1 ? 1 : 0})` }}
                >
                  <span className="font-display text-2xl font-black">{podium[i].rank}</span>
                </div>
              </div>
            ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Full standings</h3>
        <Scoreboard players={players} meId={meId} online={online} />
      </section>

      <Sources game={game} heading="Footnotes" />

      <div className="flex justify-center">
        <Link
          to="/home"
          className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Host another topic
        </Link>
      </div>
    </div>
  )
}
