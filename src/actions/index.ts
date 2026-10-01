import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { triviaActions } from './trivia'

export const actions: Record<string, ActionHandler<Env>> = {
  ...triviaActions,
}
