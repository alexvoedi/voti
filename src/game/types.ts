export type RoomStatus = 'lobby' | 'playing' | 'voting' | 'finished'
export interface Participant {
  id: string
  name: string
  peerId: string
  connected: boolean
  isHost: boolean
}
export interface Game {
  id: string
  name: string
  minPlayers: number | null
  maxPlayers: number | null
  eliminated: boolean
}
export interface RoomState {
  version: number
  status: RoomStatus
  hostPeerId: string
  participants: Participant[]
  games: Game[]
  originalGames: Game[]
  turnOrder: string[]
  currentParticipantId?: string
  turnId?: string
  winnerGameId?: string
  finalVoteId?: string
  finalVoteTallies?: Record<string, number>
  finalVotesCast?: number
  finalVotesRequired?: number
}
export type ActionResult = { state: RoomState; accepted: boolean; reason?: string }
