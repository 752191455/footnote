/**
 * Client side of the trivia actions: a typed caller and a server-clock hook.
 */

import { useEffect, useState } from 'react'
import { getAuthToken } from 'deepspace'
import type { GameStatus } from '../schemas/trivia-schema'

export interface GameData {
  code: string
  topic: string
  hostId: string
  hostName?: string
  status: GameStatus
  currentIndex: number
  questionStartedAt: number
  revealedAt?: number
  secondsPerQuestion: number
  questionCount: number
  sources?: { title: string; url: string }[]
}

export interface QuestionData {
  gameId: string
  index: number
  prompt: string
  choices: string[]
  sourceTitle?: string
  sourceUrl?: string
  correctIndex?: number | null
  explanation?: string | null
  distribution?: number[] | null
}

export interface PlayerData {
  gameId: string
  userId: string
  name?: string
  score?: number
  streak?: number
  correctCount?: number
  lastAnsweredIndex?: number
  lastPoints?: number
}

export interface SubmissionData {
  gameId: string
  index: number
  userId: string
  choice: number
  elapsedMs?: number
  correct?: boolean | null
  points?: number | null
}

export type ActionResponse<T> = { success: true; data: T } | { success: false; error: string }

export class ActionError extends Error {}

/** POST /api/actions/:name and unwrap the ActionResult envelope (throws ActionError). */
export async function callAction<T = unknown>(name: string, params: Record<string, unknown>): Promise<T> {
  const token = await getAuthToken()
  if (!token) throw new ActionError('Sign in to play.')
  let res: Response
  try {
    res = await fetch(`/api/actions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(params),
    })
  } catch {
    throw new ActionError('Network error — check your connection.')
  }
  const body = (await res.json().catch(() => null)) as ActionResponse<T> | null
  if (!body) throw new ActionError(`Server error (${res.status}).`)
  if (!body.success) throw new ActionError(body.error || 'Something went wrong.')
  const stamped = (body.data as { now?: unknown } | null)?.now
  if (typeof stamped === 'number') noteServerTime(stamped)
  return body.data
}

// ── Server clock ──────────────────────────────────────────────────────────
//
// Question deadlines are stamped with the worker's clock. A laptop whose clock
// is a few seconds off would otherwise draw a countdown that disagrees with
// the server's judgement of "time's up", so we keep a running offset.

let offsetMs = 0
let synced = false
const listeners = new Set<() => void>()

function noteServerTime(serverNow: number, rttMs = 0) {
  offsetMs = serverNow + rttMs / 2 - Date.now()
  synced = true
  listeners.forEach((l) => l())
}

export function serverNow(): number {
  return Date.now() + offsetMs
}

async function syncClock() {
  const t0 = Date.now()
  try {
    const { now } = await callAction<{ now: number }>('serverTime', {})
    noteServerTime(now, Date.now() - t0)
  } catch {
    // Unsynced is fine — we fall back to the local clock.
  }
}

/** Re-renders every `tickMs` with server-corrected time. Syncs once per page load. */
export function useServerNow(tickMs = 200): number {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    if (!synced) void syncClock()
    const update = () => setNow(serverNow())
    listeners.add(update)
    const id = setInterval(update, tickMs)
    return () => {
      clearInterval(id)
      listeners.delete(update)
    }
  }, [tickMs])
  return now
}
