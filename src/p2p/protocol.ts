import type { RoomState } from '../game/types'
export type ClientMessage =
  | { type: 'HELLO'; clientId: string; name: string }
  | { type: 'ELIMINATE_GAME'; gameId: string; turnId: string }
  | { type: 'FINAL_VOTE'; gameId: string; voteId: string }
  | { type: 'SKIP' }
export type ServerMessage =
  | { type: 'STATE'; state: RoomState }
  | { type: 'EVENT'; text: string }
  | { type: 'VOTE_CAST' }
  | { type: 'HOST_GONE' }
  | { type: 'KICKED' }
