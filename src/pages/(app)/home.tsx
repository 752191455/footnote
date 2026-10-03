/* home pattern: split-hero — one-line pitch on the left, the live host/join panel on the right, your games below */

import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthOverlay, useAuth, useQuery, useR2Files } from 'deepspace'
import { ArrowRight, BookOpenText, History, Paperclip, ImageIcon } from 'lucide-react'
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@/components/ui'
import { callAction, type GameData, type PlayerData } from '../../lib/game-client'
import { CODE_LENGTH, LIMITS, normalizeRoomCode } from '../../lib/trivia'

const TOPIC_IDEAS = ['Octopuses', 'The Apollo program', 'Bebop', 'Byzantine Empire', 'Volcanoes', 'Studio Ghibli']

export default function HomePage() {
  const { isSignedIn } = useAuth()
  const [showAuth, setShowAuth] = useState(false)

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-16">
      <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <section className="pt-2">
          <p className="font-code mb-4 text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Live trivia · cited to Wikipedia
          </p>
          <h1 className="font-display text-4xl font-black leading-[1.05] text-foreground sm:text-6xl">
            Any topic becomes a quiz night<span className="text-primary">.</span>
          </h1>
          <p className="mt-5 max-w-lg text-lg text-muted-foreground">
            Name a subject. Footnote reads the Wikipedia articles, writes the questions, and runs the
            game live for everyone in the room. Every answer comes with its source.
          </p>
          <ol className="mt-8 space-y-3 text-sm text-foreground">
            <Step n={1}>Pick a topic. Questions are drawn only from the articles it finds.</Step>
            <Step n={2}>Share the four-letter code. Friends join from any device.</Step>
            <Step n={3}>Answer fast for more points. The reveal links to the line it came from.</Step>
          </ol>
        </section>

        <section className="rounded-lg border border-border bg-card p-5 shadow-[0_2px_0_0_rgba(27,26,23,0.08)] sm:p-6">
          <Tabs defaultValue="host">
            <TabsList className="mb-5 w-full">
              <TabsTrigger value="host" className="flex-1">
                Host a game
              </TabsTrigger>
              <TabsTrigger value="join" className="flex-1">
                Join with code
              </TabsTrigger>
            </TabsList>
            <TabsContent value="host">
              <HostForm onNeedAuth={() => setShowAuth(true)} />
            </TabsContent>
            <TabsContent value="join">
              <JoinForm onNeedAuth={() => setShowAuth(true)} />
            </TabsContent>
          </Tabs>
        </section>
      </div>

      {isSignedIn && <RecentGames />}
      {showAuth && !isSignedIn && (
        <AuthOverlay
          onClose={() => setShowAuth(false)}
          title="Sign in to play Footnote"
          description="Your name shows on the scoreboard."
        />
      )}
    </div>
  )
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="font-code mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-foreground text-[11px] font-bold text-background">
        {n}
      </span>
      <span>{children}</span>
    </li>
  )
}

// ── Host ──────────────────────────────────────────────────────────────────

function HostForm({ onNeedAuth }: { onNeedAuth: () => void }) {
  const { isSignedIn } = useAuth()
  const navigate = useNavigate()
  const { error } = useToast()
  const { upload, isUploading } = useR2Files({ scope: 'app' })
  const [topic, setTopic] = useState('')
  const [count, setCount] = useState('8')
  const [seconds, setSeconds] = useState('20')
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [cover, setCover] = useState<{ key: string; url: string; name: string } | null>(null)
  const [attachment, setAttachment] = useState<{
    key: string
    name: string
    mime: string
  } | null>(null)

  async function onCoverChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!isSignedIn) return onNeedAuth()
    if (!file.type.startsWith('image/')) {
      error('Cover must be an image', 'Try a JPG or PNG.')
      return
    }
    const result = await upload(file, `covers/${Date.now()}-${file.name}`)
    if (!result.success || !result.key) {
      error('Could not upload cover', result.error ?? 'Try again after deploy (R2 needs APP_IDENTITY_TOKEN).')
      return
    }
    setCover({ key: result.key, url: result.url ?? '', name: file.name })
  }

  async function onAttachmentChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!isSignedIn) return onNeedAuth()
    const okType = file.type.startsWith('image/') || file.type === 'application/pdf'
    if (!okType) {
      error('Attachment must be a PDF or image', file.type || 'Unknown type')
      return
    }
    const result = await upload(file, `attachments/${Date.now()}-${file.name}`)
    if (!result.success || !result.key) {
      error('Could not upload file', result.error ?? 'Try again after deploy (R2 needs APP_IDENTITY_TOKEN).')
      return
    }
    setAttachment({ key: result.key, name: file.name, mime: file.type })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!isSignedIn) return onNeedAuth()
    const t = topic.trim()
    if (t.length < 2) return setFieldError('Enter a topic, like "Octopuses".')
    setFieldError(null)
    setBusy(true)
    try {
      const { code } = await callAction<{ code: string }>('createGame', {
        topic: t,
        questionCount: Number(count),
        secondsPerQuestion: Number(seconds),
        ...(cover
          ? {
              coverFileKey: cover.key,
              ...(cover.url ? { coverUrl: cover.url } : {}),
            }
          : {}),
        ...(attachment
          ? {
              attachmentFileKey: attachment.key,
              attachmentName: attachment.name,
              attachmentMime: attachment.mime,
            }
          : {}),
      })
      navigate(`/play/${code}`)
    } catch (err) {
      error('Could not create the game', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const locked = busy || isUploading

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="host-form">
      <div className="space-y-1.5">
        <Label htmlFor="topic">Topic</Label>
        <Input
          id="topic"
          value={topic}
          maxLength={LIMITS.topicMaxLength}
          placeholder="e.g. The Apollo program"
          onChange={(e) => setTopic(e.target.value)}
          aria-invalid={!!fieldError || undefined}
          disabled={locked}
          className="h-11 bg-background text-base"
        />
        {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
        <div className="flex flex-wrap gap-1.5 pt-1">
          {TOPIC_IDEAS.map((idea) => (
            <button
              key={idea}
              type="button"
              disabled={locked}
              onClick={() => setTopic(idea)}
              className="rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
            >
              {idea}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Questions</Label>
          <Select value={count} onValueChange={setCount} disabled={locked}>
            <SelectTrigger className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5 questions</SelectItem>
              <SelectItem value="8">8 questions</SelectItem>
              <SelectItem value="10">10 questions</SelectItem>
              <SelectItem value="12">12 questions</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Time per question</Label>
          <Select value={seconds} onValueChange={setSeconds} disabled={locked}>
            <SelectTrigger className="bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="10">10 seconds</SelectItem>
              <SelectItem value="20">20 seconds</SelectItem>
              <SelectItem value="30">30 seconds</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cover-upload" className="flex items-center gap-1.5">
            <ImageIcon className="h-3.5 w-3.5" aria-hidden />
            Cover image <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="cover-upload"
            type="file"
            accept="image/*"
            disabled={locked}
            onChange={onCoverChange}
            className="h-10 cursor-pointer bg-background text-sm file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium"
            data-testid="cover-upload"
          />
          {cover && (
            <p className="truncate text-xs text-muted-foreground" data-testid="cover-name">
              {cover.name}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="attachment-upload" className="flex items-center gap-1.5">
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            PDF / image <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="attachment-upload"
            type="file"
            accept="image/*,application/pdf"
            disabled={locked}
            onChange={onAttachmentChange}
            className="h-10 cursor-pointer bg-background text-sm file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium"
            data-testid="attachment-upload"
          />
          {attachment && (
            <p className="truncate text-xs text-muted-foreground" data-testid="attachment-name">
              {attachment.name}
            </p>
          )}
        </div>
      </div>
      <Button type="submit" size="lg" className="w-full" loading={busy || isUploading} data-testid="create-game">
        {isUploading ? 'Uploading…' : busy ? 'Opening your room…' : isSignedIn ? 'Write my quiz' : 'Sign in to host'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Your room opens right away. Share the code while the questions are written (about 10 seconds).
        You play too: nobody, host included, sees an answer before the reveal. Optional files go to R2 via
        /api/files/*.
      </p>
    </form>
  )
}

// ── Join ──────────────────────────────────────────────────────────────────

function JoinForm({ onNeedAuth }: { onNeedAuth: () => void }) {
  const { isSignedIn } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const ready = code.length === CODE_LENGTH

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!isSignedIn) return onNeedAuth()
    if (ready) navigate(`/play/${code}`)
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="join-form">
      <div className="space-y-1.5">
        <Label htmlFor="code">Room code</Label>
        <Input
          id="code"
          value={code}
          onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
          placeholder="ABCD"
          autoComplete="off"
          autoCapitalize="characters"
          className="font-code h-16 bg-background text-center text-3xl tracking-[0.4em] uppercase"
        />
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={isSignedIn && !ready}>
        {isSignedIn ? 'Join game' : 'Sign in to join'}
        <ArrowRight aria-hidden />
      </Button>
    </form>
  )
}

// ── Recent games ──────────────────────────────────────────────────────────

const STATUS_LABEL: Record<GameData['status'], string> = {
  generating: 'Writing quiz',
  failed: 'Setup failed',
  lobby: 'In lobby',
  question: 'Live',
  reveal: 'Live',
  finished: 'Finished',
}

function RecentGames() {
  const { userId } = useAuth()
  const navigate = useNavigate()
  const mine = useQuery<PlayerData>('players', { where: { userId }, limit: 50 })
  const games = useQuery<GameData>('games', { orderBy: 'createdAt', orderDir: 'desc', limit: 200 })

  const rows = useMemo(() => {
    const score = new Map(mine.records.map((p) => [p.data.gameId, p.data.score ?? 0]))
    return games.records.filter((g) => score.has(g.recordId)).slice(0, 8).map((g) => ({ g, score: score.get(g.recordId) ?? 0 }))
  }, [mine.records, games.records])

  const loading = mine.status === 'loading' || games.status === 'loading'

  return (
    <section className="mt-16" data-testid="recent-games">
      <h2 className="font-display mb-4 flex items-center gap-2 text-xl font-bold">
        <History className="h-5 w-5 text-muted-foreground" aria-hidden />
        Your games
      </h2>
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          <BookOpenText className="h-5 w-5 shrink-0" aria-hidden />
          Games you host or join show up here, so you can jump back in or see the final scores.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {rows.map(({ g, score }) => (
            <li key={g.recordId}>
              <button
                onClick={() => navigate(`/play/${g.data.code}`)}
                className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/50"
              >
                {(() => {
                  const cover = g.data.sources?.find((s) => s.imageUrl)?.imageUrl
                  return cover ? (
                    <img src={cover} alt="" className="h-10 w-10 shrink-0 rounded-sm object-cover" referrerPolicy="origin" />
                  ) : (
                    <span className="bg-muted font-code flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold tracking-widest">
                      {g.data.code}
                    </span>
                  )
                })()}
                <span className="font-code w-14 text-sm font-bold tracking-widest">{g.data.code}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{g.data.topic}</span>
                <Badge variant={g.data.status === 'finished' || g.data.status === 'failed' ? 'secondary' : 'default'}>
                  {STATUS_LABEL[g.data.status]}
                </Badge>
                <span className="font-code w-20 text-right text-sm tabular-nums text-muted-foreground">
                  {score.toLocaleString()} pts
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
