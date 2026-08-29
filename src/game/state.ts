import type { ActionResult, Game, RoomState } from './types'
const uid = () => crypto.randomUUID()
export const slug = (name: string) =>
  name
    .toLocaleLowerCase('de')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
export const parseGames = (text: string): Game[] => {
  const names: string[] = []
  const seenNames = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim()
    const key = name.toLocaleLowerCase('de')
    if (!name || seenNames.has(key)) continue
    seenNames.add(key)
    names.push(name)
  }
  const usedIds = new Map<string, number>()
  return names.map((name, index) => {
    const base = slug(name) || `spiel-${index + 1}`
    const occurrence = (usedIds.get(base) ?? 0) + 1
    usedIds.set(base, occurrence)
    return { id: occurrence === 1 ? base : `${base}-${occurrence}`, name, eliminated: false }
  })
}
export const createLobby = (
  hostPeerId: string,
  host: { id: string; name: string },
  games: Game[],
): RoomState => ({
  version: 0,
  status: 'lobby',
  hostPeerId,
  participants: [{ ...host, peerId: hostPeerId, connected: true, isHost: true }],
  games: games.map((game) => ({ ...game })),
  originalGames: games.map((game) => ({ ...game })),
  turnOrder: [],
})
export const shuffle = <T>(items: readonly T[], random = Math.random): T[] => {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}
export function startRound(state: RoomState, random = Math.random): RoomState {
  const order = shuffle(
    state.participants.filter((p) => p.connected).map((p) => p.id),
    random,
  )
  if (order.length === 0 || state.originalGames.length < 2) return state
  const games = state.originalGames.map((g) => ({ ...g, eliminated: false }))
  const next: RoomState = {
    ...state,
    status: games.length === 2 ? 'voting' : 'playing',
    version: state.version + 1,
    games,
    turnOrder: order,
    currentParticipantId: games.length === 2 ? undefined : order[0],
    turnId: games.length === 2 ? undefined : uid(),
    winnerGameId: undefined,
    finalVoteId: games.length === 2 ? uid() : undefined,
    finalVoteTallies:
      games.length === 2 ? Object.fromEntries(games.map((game) => [game.id, 0])) : undefined,
    finalVotesCast: games.length === 2 ? 0 : undefined,
    finalVotesRequired: games.length === 2 ? order.length : undefined,
  }
  return next
}
export function eliminate(
  state: RoomState,
  gameId: string,
  turnId: string,
  participantId: string,
): ActionResult {
  if (state.status !== 'playing') return { state, accepted: false, reason: 'not-playing' }
  if (state.currentParticipantId !== participantId)
    return { state, accepted: false, reason: 'not-your-turn' }
  if (state.turnId !== turnId) return { state, accepted: false, reason: 'stale-turn' }
  const target = state.games.find((game) => game.id === gameId)
  if (!target) return { state, accepted: false, reason: 'unknown-game' }
  if (target.eliminated) return { state, accepted: false, reason: 'already-eliminated' }
  const games = state.games.map((game) =>
    game.id === gameId ? { ...game, eliminated: true } : game,
  )
  const remaining = games.filter((game) => !game.eliminated)
  if (remaining.length === 2)
    return {
      accepted: true,
      state: {
        ...state,
        games,
        status: 'voting',
        version: state.version + 1,
        turnId: undefined,
        currentParticipantId: undefined,
        finalVoteId: uid(),
        finalVoteTallies: Object.fromEntries(remaining.map((game) => [game.id, 0])),
        finalVotesCast: 0,
        finalVotesRequired: state.participants.filter((participant) => participant.connected)
          .length,
      },
    }
  if (remaining.length === 1)
    return {
      accepted: true,
      state: {
        ...state,
        games,
        status: 'finished',
        winnerGameId: remaining[0].id,
        version: state.version + 1,
        turnId: undefined,
        currentParticipantId: undefined,
      },
    }
  const index = state.turnOrder.indexOf(participantId)
  const next = [...state.turnOrder.slice(index + 1), ...state.turnOrder.slice(0, index + 1)].find(
    (id) => state.participants.find((p) => p.id === id)?.connected,
  )
  return {
    accepted: true,
    state: {
      ...state,
      games,
      version: state.version + 1,
      currentParticipantId: next,
      turnId: uid(),
    },
  }
}

export function castFinalVote(
  state: RoomState,
  gameId: string,
  voteId: string,
  alreadyVoted: boolean,
  random = Math.random,
): ActionResult {
  if (state.status !== 'voting') return { state, accepted: false, reason: 'not-voting' }
  if (state.finalVoteId !== voteId) return { state, accepted: false, reason: 'stale-vote' }
  if (alreadyVoted) return { state, accepted: false, reason: 'already-voted' }
  const game = state.games.find((item) => item.id === gameId && !item.eliminated)
  if (!game || !(gameId in (state.finalVoteTallies ?? {})))
    return { state, accepted: false, reason: 'unknown-game' }

  const finalVoteTallies = {
    ...state.finalVoteTallies,
    [gameId]: (state.finalVoteTallies?.[gameId] ?? 0) + 1,
  }
  const finalVotesCast = (state.finalVotesCast ?? 0) + 1
  const finalVotesRequired = state.finalVotesRequired ?? 0
  if (finalVotesCast >= finalVotesRequired) {
    const highest = Math.max(...Object.values(finalVoteTallies))
    const leaders = Object.entries(finalVoteTallies)
      .filter(([, votes]) => votes === highest)
      .map(([id]) => id)
    const winnerGameId = leaders[Math.floor(random() * leaders.length)]
    return {
      accepted: true,
      state: {
        ...state,
        status: 'finished',
        version: state.version + 1,
        finalVoteTallies,
        finalVotesCast,
        winnerGameId,
      },
    }
  }
  return {
    accepted: true,
    state: { ...state, version: state.version + 1, finalVoteTallies, finalVotesCast },
  }
}
export function skipCurrent(state: RoomState): RoomState {
  if (state.status !== 'playing' || !state.currentParticipantId) return state
  const index = state.turnOrder.indexOf(state.currentParticipantId)
  const next = [...state.turnOrder.slice(index + 1), ...state.turnOrder.slice(0, index)].find(
    (id) => state.participants.find((p) => p.id === id)?.connected,
  )
  if (!next) return state
  return { ...state, version: state.version + 1, currentParticipantId: next, turnId: uid() }
}
