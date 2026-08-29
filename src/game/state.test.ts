import { describe, expect, it } from 'vitest'
import { castFinalVote, createLobby, eliminate, parseGames, skipCurrent, startRound } from './state'
const setup = () =>
  startRound(createLobby('host', { id: 'a', name: 'Alex' }, parseGames('One\nTwo\nThree')), () => 0)
describe('game state', () => {
  it('eliminates and advances', () => {
    const s = setup()
    const r = eliminate(s, s.games[0].id, s.turnId!, 'a')
    expect(r.accepted).toBe(true)
    expect(r.state.games[0].eliminated).toBe(true)
    expect(r.state.version).toBe(2)
  })
  it('rejects wrong player and stale turn', () => {
    const s = setup()
    expect(eliminate(s, s.games[0].id, s.turnId!, 'no').accepted).toBe(false)
    expect(eliminate(s, s.games[0].id, 'old', 'a').accepted).toBe(false)
  })
  it('rejects eliminated games and duplicate requests', () => {
    const s = setup()
    const first = eliminate(s, s.games[0].id, s.turnId!, 'a')
    expect(eliminate(first.state, s.games[0].id, s.turnId!, 'a').accepted).toBe(false)
  })
  it('starts an anonymous final vote when two games remain', () => {
    const s = setup()
    const a = eliminate(s, s.games[0].id, s.turnId!, 'a')
    expect(a.state.status).toBe('voting')
    expect(a.state.currentParticipantId).toBeUndefined()
    expect(a.state.finalVotesCast).toBe(0)
    expect(a.state.finalVoteTallies).toEqual({ [s.games[1].id]: 0, [s.games[2].id]: 0 })
  })
  it('chooses the game with the most final votes', () => {
    const lobby = createLobby('host', { id: 'a', name: 'Alex' }, parseGames('One\nTwo'))
    lobby.participants.push(
      { id: 'b', name: 'B', peerId: 'b', connected: true, isHost: false },
      { id: 'c', name: 'C', peerId: 'c', connected: true, isHost: false },
    )
    const voting = startRound(lobby, () => 0)
    const first = castFinalVote(voting, voting.games[0].id, voting.finalVoteId!, false)
    const second = castFinalVote(first.state, voting.games[1].id, voting.finalVoteId!, false)
    const third = castFinalVote(second.state, voting.games[0].id, voting.finalVoteId!, false)
    expect(third.state.status).toBe('finished')
    expect(third.state.winnerGameId).toBe(voting.games[0].id)
    expect(third.state.finalVotesCast).toBe(3)
  })
  it('chooses a random winner when the final vote is tied', () => {
    const lobby = createLobby('host', { id: 'a', name: 'Alex' }, parseGames('One\nTwo'))
    lobby.participants.push({
      id: 'b',
      name: 'B',
      peerId: 'b',
      connected: true,
      isHost: false,
    })
    const voting = startRound(lobby, () => 0)
    const first = castFinalVote(voting, voting.games[0].id, voting.finalVoteId!, false)
    const tied = castFinalVote(
      first.state,
      voting.games[1].id,
      voting.finalVoteId!,
      false,
      () => 0.999,
    )
    expect(tied.state.status).toBe('finished')
    expect(tied.state.winnerGameId).toBe(voting.games[1].id)
  })
  it('rejects stale, duplicate, and unknown final votes', () => {
    const voting = startRound(
      createLobby('host', { id: 'a', name: 'Alex' }, parseGames('One\nTwo')),
      () => 0,
    )
    expect(castFinalVote(voting, voting.games[0].id, 'old', false).reason).toBe('stale-vote')
    expect(castFinalVote(voting, voting.games[0].id, voting.finalVoteId!, true).reason).toBe(
      'already-voted',
    )
    expect(castFinalVote(voting, 'missing', voting.finalVoteId!, false).reason).toBe('unknown-game')
  })
  it('deduplicates input and restores games for a new round', () => {
    expect(parseGames(' One \n\none\nOne\nTwo')).toHaveLength(2)
    const s = setup()
    const next = startRound(
      { ...s, games: s.games.slice(0, 2).map((g) => ({ ...g, eliminated: true })) },
      () => 0,
    )
    expect(next.games.every((g) => !g.eliminated)).toBe(true)
    expect(next.finalVotesCast).toBeUndefined()
  })
  it('creates unique IDs for different names with the same slug', () => {
    const games = parseGames('R.E.P.O.\nR E P O')
    expect(new Set(games.map((game) => game.id)).size).toBe(2)
  })
  it('advances to the next connected participant', () => {
    const lobby = createLobby(
      'host',
      { id: 'a', name: 'Alex' },
      parseGames('One\nTwo\nThree\nFour'),
    )
    lobby.participants.push({
      id: 'b',
      name: 'Max',
      peerId: 'peer-b',
      connected: true,
      isHost: false,
    })
    const state = startRound(lobby, () => 0.999)
    expect(state.currentParticipantId).toBe('a')
    expect(eliminate(state, state.games[0].id, state.turnId!, 'a').state.currentParticipantId).toBe(
      'b',
    )
  })
  it('does not skip when no other connected participant exists', () => {
    const state = setup()
    expect(skipCurrent(state)).toBe(state)
  })
})
