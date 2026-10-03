/**
 * The game room — /play/:code. One page driven by the synced `games` row:
 * generating → lobby → question → reveal → finished (or failed). Clients
 * never write game state; they call server actions and render what syncs back.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AuthOverlay,
  useAuth,
  useJobs,
  usePresenceRoom,
  useQuery,
  useR2Files,
  type RecordData,
} from 'deepspace'
import { AlertTriangle, BookOpenText, Check, Copy, Crown, ExternalLink, FileText, Play, Sparkles, Users } from 'lucide-react'
import { Button, EmptyState, useToast } from '@/components/ui'
import { cn } from '@/lib/utils'
import { SCOPE_ID } from '../../../constants'
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
  type SummaryData,
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
    if (
      players.status !== 'ready' ||
      me ||
      joinAttempted.current ||
      g.status === 'finished' ||
      g.status === 'failed'
    ) {
      return
    }
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
            {(g.status === 'question' || g.status === 'reveal') && (
              <>
                {' '}· Question {g.currentIndex + 1} of {g.questionCount}
              </>
            )}
          </p>
          <h1 className="font-display truncate text-2xl font-bold sm:text-3xl">{g.topic}</h1>
        </div>
        {me && g.status !== 'generating' && g.status !== 'failed' && (
          <p className="font-code text-sm tabular-nums">
            <span className="text-muted-foreground">Your score </span>
            <span className="font-bold" data-testid="my-score">{(me.data.score ?? 0).toLocaleString()}</span>
          </p>
        )}
      </header>

      {(g.status === 'lobby' || g.status === 'generating') && (
        <Lobby gameId={gameId} game={g} players={players.records} online={online} isHost={isHost} />
      )}
      {g.status === 'failed' && <SetupFailed game={g} />}
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
        <FinishedPhase
          gameId={gameId}
          game={g}
          players={players.records}
          online={online}
          meId={userId}
        />
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
      <div className="flex flex-col items-center gap-4 overflow-hidden rounded-lg border border-border bg-card text-center">
        {game.coverUrl || game.coverFileKey ? (
          <CoverBanner coverUrl={game.coverUrl} coverFileKey={game.coverFileKey} />
        ) : (
          <SourceMosaic sources={game.sources} />
        )}
        <div className="px-6 pb-8 pt-4">
          <p className="text-sm text-muted-foreground">Join at this page with code</p>
          <p className="font-code text-6xl font-bold tracking-[0.25em] sm:text-7xl" data-testid="room-code">
            {game.code}
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={copyLink}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            Copy invite link
          </Button>
        </div>
      </div>

      {game.status === 'generating' && <GenerationProgress game={game} />}

      <HostFiles game={game} />

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Users className="h-4 w-4" aria-hidden />
          {players.length} {players.length === 1 ? 'player' : 'players'} seated
          {online.size > 0 && (
            <span className="font-normal normal-case tracking-normal text-muted-foreground">
              · {online.size} viewing
            </span>
          )}
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

      {(game.status === 'lobby' || (game.status === 'generating' && !!game.sources?.length)) && (
        <Sources
          game={game}
          heading={game.status === 'generating' ? 'Articles we found' : `${game.questionCount} questions drawn from`}
        />
      )}

      {game.status === 'lobby' && !!game.enrichment?.length && <EnrichmentLinks enrichment={game.enrichment} />}

      <div className="sticky bottom-4 flex justify-center">
        {isHost ? (
          <Button
            size="lg"
            className="min-w-56 shadow-lg"
            loading={starting}
            disabled={game.status !== 'lobby'}
            onClick={start}
            data-testid="start-game"
          >
            <Play aria-hidden />
            {game.status === 'lobby' ? 'Start the game' : 'Writing questions…'}
          </Button>
        ) : (
          <p className="rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground shadow-sm">
            {game.status === 'generating'
              ? 'Questions are being written — hang tight…'
              : `Waiting for ${game.hostName ?? 'the host'} to start…`}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Live view of the AppJobRoom job writing this game's questions. Progress and
 * messages are pushed over the JobRoom WebSocket — no polling — so the host
 * and every early joiner watch the same bar.
 */
function GenerationProgress({ game }: { game: GameData }) {
  const { getJob, connected } = useJobs(SCOPE_ID)
  const job = game.jobId ? getJob(game.jobId) : undefined
  const progress = job?.status === 'succeeded' ? 1 : job?.progress ?? 0
  const message =
    job?.progressMessage ??
    (job?.status === 'queued' ? 'Waiting for the question writer…' : connected ? 'Starting…' : 'Connecting…')
  const jobFailed = job?.status === 'failed' || job?.status === 'canceled'

  return (
    <section
      className="rounded-lg border border-border bg-card px-5 py-4"
      data-testid="generation-progress"
      data-job-status={job?.status ?? 'unknown'}
      aria-live="polite"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        {jobFailed ? 'The question writer stopped' : `Writing ${game.questionCount} questions about ${game.topic}`}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${Math.max(4, progress * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-muted-foreground" data-testid="generation-message">
        {jobFailed ? job?.error ?? 'Generation failed.' : message}
      </p>
    </section>
  )
}

function SetupFailed({ game }: { game: GameData }) {
  return (
    <div className="rounded-lg border border-border bg-card px-6 py-10 text-center" data-testid="setup-failed">
      <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-primary" aria-hidden />
      <h2 className="font-display text-xl font-bold">This quiz couldn&apos;t be written</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {game.generationError || 'Something went wrong while writing the questions.'}
      </p>
      <Link
        to="/home"
        className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Try another topic
      </Link>
    </div>
  )
}

function CoverBanner({ coverUrl, coverFileKey }: { coverUrl?: string; coverFileKey?: string }) {
  const { getUrl } = useR2Files({ scope: 'app' })
  const src = coverUrl || (coverFileKey ? getUrl(coverFileKey) : '')
  if (!src) return null
  return (
    <div className="h-36 w-full overflow-hidden bg-muted sm:h-44" data-testid="cover-banner">
      <WikiPhoto src={src} alt="" className="h-full w-full object-cover" />
    </div>
  )
}

function HostFiles({ game }: { game: GameData }) {
  const { getUrl } = useR2Files({ scope: 'app' })
  if (!game.attachmentFileKey && !game.coverFileKey) return null
  const href = game.attachmentFileKey ? getUrl(game.attachmentFileKey) : null
  return (
    <section className="rounded-lg border border-border bg-card px-4 py-3" data-testid="host-files">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Host files</h2>
      <ul className="space-y-1.5 text-sm">
        {href && (
          <li>
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-primary underline-offset-4 hover:underline"
            >
              <FileText className="h-4 w-4 shrink-0" aria-hidden />
              {game.attachmentName || 'Attachment'}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </li>
        )}
        {game.coverFileKey && !game.attachmentFileKey && (
          <li className="text-muted-foreground">Cover image attached to this room.</li>
        )}
      </ul>
    </section>
  )
}

function EnrichmentLinks({ enrichment }: { enrichment: { title: string; url: string }[] }) {
  return (
    <section data-testid="enrichment-links">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Web colour (Exa)
      </h2>
      <ul className="flex flex-wrap gap-2">
        {enrichment.map((e) => (
          <li key={e.url}>
            <a
              href={e.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-xs items-center gap-1 truncate rounded-sm border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:border-foreground hover:text-foreground"
            >
              {e.title}
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SourceMosaic({ sources }: { sources?: GameData['sources'] }) {
  const photos = (sources ?? []).map((s) => s.imageUrl).filter(Boolean) as string[]
  if (photos.length === 0) return null
  return (
    <div className="grid h-36 w-full grid-cols-3 overflow-hidden bg-muted sm:h-44" data-testid="source-mosaic">
      {photos.slice(0, 3).map((src, i) => (
        <WikiPhoto key={src + i} src={src} alt="" className="h-full w-full object-cover" />
      ))}
    </div>
  )
}

function WikiPhoto({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <div className={cn('bg-muted', className)} aria-hidden />
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      referrerPolicy="origin"
      onError={() => setFailed(true)}
    />
  )
}

function Sources({ game, heading }: { game: GameData; heading: string }) {
  if (!game.sources?.length) return null
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{heading}</h2>
      <ol className="grid gap-3 sm:grid-cols-3">
        {game.sources.map((s, i) => (
          <li key={s.url}>
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="group block overflow-hidden rounded-md border border-border bg-card text-left transition-colors hover:border-foreground"
            >
              {s.imageUrl ? (
                <WikiPhoto src={s.imageUrl} alt="" className="h-28 w-full object-cover" />
              ) : (
                <div className="flex h-28 items-center justify-center bg-muted font-code text-muted-foreground">[{i + 1}]</div>
              )}
              <span className="flex items-start gap-1 px-2 py-2 text-sm font-medium">
                <span className="font-code text-muted-foreground">[{i + 1}]</span>
                <span className="min-w-0 flex-1 leading-snug group-hover:underline">{s.title}</span>
                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              </span>
            </a>
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
        <aside className="overflow-hidden rounded-md border border-border bg-card" data-testid="footnote">
          {question.sourceImageUrl && (
            <WikiPhoto
              src={question.sourceImageUrl}
              alt={question.sourceTitle ? `From ${question.sourceTitle}` : 'Source'}
              className="max-h-56 w-full object-cover"
            />
          )}
          <div className="border-l-2 border-primary px-4 py-3 text-sm">
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
          </div>
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
  gameId,
  game,
  players,
  online,
  meId,
}: {
  gameId: string
  game: GameData
  players: RecordData<PlayerData>[]
  online: Set<string>
  meId: string | null
}) {
  const ranked = rankPlayers(players.map((p) => ({ ...p.data, name: p.data.name ?? 'Player', score: p.data.score ?? 0 })))
  const podium = ranked.slice(0, 3)
  const heights = ['h-28', 'h-20', 'h-14']
  const order = [1, 0, 2] // silver, gold, bronze, left to right
  const summaries = useQuery<SummaryData>('summaries', { where: { gameId }, limit: 1 })
  const summary = summaries.records[0]?.data

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

      <GameSummary summary={summary} summaryJobId={game.summaryJobId} />

      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Full standings</h3>
        <Scoreboard players={players} meId={meId} online={online} />
      </section>

      <HostFiles game={game} />
      <Sources game={game} heading="Footnotes" />
      {!!game.enrichment?.length && <EnrichmentLinks enrichment={game.enrichment} />}

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

function GameSummary({
  summary,
  summaryJobId,
}: {
  summary?: SummaryData
  summaryJobId?: string
}) {
  const { getJob } = useJobs(SCOPE_ID)
  const job = summaryJobId ? getJob(summaryJobId) : undefined
  const pending = !summary || summary.status === 'pending'
  const failed = summary?.status === 'failed' || job?.status === 'failed'

  return (
    <section
      className="rounded-lg border border-border bg-card px-5 py-4"
      data-testid="game-summary"
      data-status={summary?.status ?? 'pending'}
      aria-live="polite"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        {failed ? 'Recap unavailable' : pending ? 'Writing the recap…' : 'Night recap'}
      </div>
      {pending && !failed && (
        <p className="text-sm text-muted-foreground">
          {job?.progressMessage ?? 'Claude is drafting a short wrap-up from the standings.'}
        </p>
      )}
      {failed && (
        <p className="text-sm text-muted-foreground">
          {summary?.body || job?.error || 'Could not write a recap.'}
        </p>
      )}
      {summary?.status === 'ready' && (
        <>
          {summary.headline && (
            <h3 className="font-display text-xl font-bold" data-testid="summary-headline">
              {summary.headline}
            </h3>
          )}
          {summary.body && <p className="mt-2 text-sm text-muted-foreground">{summary.body}</p>}
          {!!summary.highlights?.length && (
            <ul className="mt-3 space-y-1.5">
              {summary.highlights.map((h) => (
                <li key={h.label + h.text} className="text-sm">
                  <span className="font-semibold">{h.label}</span>
                  <span className="text-muted-foreground"> — {h.text}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
