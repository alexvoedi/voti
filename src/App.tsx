import { useEffect, useMemo, useRef, useState } from 'react'
import {
  castFinalVote,
  createLobby,
  eliminate,
  parseGames,
  skipCurrent,
  startRound,
} from './game/state'
import type { RoomState } from './game/types'
import type { ClientMessage, ServerMessage } from './p2p/protocol'
import { LOCAL_HOST_PEER_ID, P2PRoom } from './p2p/room'
import { loadIdentity, makeRoomCode, saveIdentity } from './utils/storage'

const defaults = `Pummel Party\nAmong Us\nPhasmophobia\nR.E.P.O.\nGolf with your Friends\nGeoguessr\nPico Park\nLeft 4 Dead\nOverwatch\nCounter-Strike\nMake it Meme\nWitch it`
const codeFromHash = () => window.location.hash.slice(1).toUpperCase()
const playTurnSound = async (context: AudioContext) => {
  if (context.state === 'suspended') await context.resume()
  const now = context.currentTime
  const gain = context.createGain()
  const oscillator = context.createOscillator()
  oscillator.type = 'sine'
  oscillator.frequency.setValueAtTime(660, now)
  oscillator.frequency.setValueAtTime(880, now + 0.12)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(now)
  oscillator.stop(now + 0.31)
}
const playOtherVoteSound = async (context: AudioContext) => {
  if (context.state === 'suspended') await context.resume()
  const now = context.currentTime
  const gain = context.createGain()
  const oscillator = context.createOscillator()
  oscillator.type = 'triangle'
  oscillator.frequency.setValueAtTime(420, now)
  oscillator.frequency.exponentialRampToValueAtTime(260, now + 0.22)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(now)
  oscillator.stop(now + 0.25)
}
export function App() {
  const identity = useMemo(() => loadIdentity(), [])
  const [name, setName] = useState(identity.name)
  const [code, setCode] = useState(codeFromHash() || identity.roomCode)
  const [state, setState] = useState<RoomState | null>(null)
  const stateRef = useRef<RoomState | null>(null)
  const joinCleanupRef = useRef<(() => void) | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const alertedActionRef = useRef<string | null>(null)
  const finalVotersRef = useRef(new Map<string, Set<string>>())
  const [room, setRoom] = useState<P2PRoom | null>(null)
  const [isHost, setIsHost] = useState(false)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState('')
  const [gamesText, setGamesText] = useState(defaults)
  const [pending, setPending] = useState<string | null>(null)
  const [votedFinalId, setVotedFinalId] = useState<string | null>(null)
  const commitState = (next: RoomState | null) => {
    stateRef.current = next
    setPending(null)
    setState(next)
  }
  const me = state?.participants.find((participant) => participant.id === identity.clientId)
  const current = state?.participants.find(
    (participant) => participant.id === state.currentParticipantId,
  )
  const join = (asHost: boolean) => {
    audioContextRef.current ??= new AudioContext()
    void audioContextRef.current.resume()
    const cleanName = name.trim()
    if (!cleanName) return setError('Bitte gib einen Anzeigenamen ein.')
    const roomCode = (asHost ? makeRoomCode() : code).replace(/[^A-Z0-9]/g, '').slice(0, 6)
    if (roomCode.length !== 6) return setError('Der Room-Code muss sechs Zeichen haben.')
    joinCleanupRef.current?.()
    setError('')
    commitState(null)
    saveIdentity(identity.clientId, cleanName, roomCode)
    window.history.replaceState(null, '', `#${roomCode}`)
    setCode(roomCode)
    setIsHost(asHost)
    setJoining(!asHost)
    let nextRoom: P2PRoom
    try {
      nextRoom = new P2PRoom(roomCode, asHost)
    } catch (cause) {
      setJoining(false)
      setError(
        `Raum konnte nicht geöffnet werden: ${cause instanceof Error ? cause.message : 'Unbekannter Fehler'}`,
      )
      return
    }
    setRoom(nextRoom)
    if (asHost) {
      commitState(
        createLobby(
          LOCAL_HOST_PEER_ID,
          { id: identity.clientId, name: cleanName },
          parseGames(defaults),
        ),
      )
    }
    let helloRetry: number | undefined
    let joinTimeout: number | undefined
    const stopJoinTimers = () => {
      if (helloRetry !== undefined) window.clearInterval(helloRetry)
      if (joinTimeout !== undefined) window.clearTimeout(joinTimeout)
      if (joinCleanupRef.current === stopJoinTimers) joinCleanupRef.current = null
    }
    joinCleanupRef.current = stopJoinTimers
    nextRoom.onMessage = (message: ServerMessage) => {
      if (message.type === 'VOTE_CAST' && audioContextRef.current) {
        void playOtherVoteSound(audioContextRef.current)
      }
      if (message.type === 'STATE') {
        if (stateRef.current && message.state.version < stateRef.current.version) return
        stopJoinTimers()
        setJoining(false)
        setPending(null)
        commitState(message.state)
      }
      if (message.type === 'HOST_GONE' || message.type === 'KICKED') {
        stopJoinTimers()
        commitState(null)
        setError(
          message.type === 'KICKED'
            ? 'Du wurdest vom Host aus dem Raum entfernt.'
            : 'Die Verbindung zum Host wurde beendet.',
        )
        setRoom(null)
      }
    }
    nextRoom.onError = (message) => {
      stopJoinTimers()
      setJoining(false)
      commitState(null)
      setError(`Raum konnte nicht verbunden werden: ${message}`)
      setRoom(null)
    }
    nextRoom.onClientMessage = (message: ClientMessage, peerId) => {
      if (!asHost) return
      handleHostMessage(nextRoom, message, peerId)
    }
    nextRoom.onPeerJoin = (peerId) => {
      if (asHost) {
        const currentState = stateRef.current
        if (currentState) nextRoom.sendTo(peerId, { type: 'STATE', state: currentState })
      } else {
        nextRoom.sendClientTo(peerId, {
          type: 'HELLO',
          clientId: identity.clientId,
          name: cleanName,
        })
      }
    }
    nextRoom.onPeerLeave = (peerId) => {
      const currentState = stateRef.current
      if (asHost && currentState) {
        const next = {
          ...currentState,
          participants: currentState.participants.map((p) =>
            p.peerId === peerId ? { ...p, connected: false } : p,
          ),
          version: currentState.version + 1,
        }
        commitState(next)
        nextRoom.broadcast({ type: 'STATE', state: next })
      }
      if (!asHost && nextRoom.isHostPeer(peerId)) {
        stopJoinTimers()
        commitState(null)
        setError('Die Verbindung zum Host wurde beendet.')
        setRoom(null)
      }
    }
    if (!asHost) {
      helloRetry = window.setInterval(() => {
        nextRoom.sendToHost({ type: 'HELLO', clientId: identity.clientId, name: cleanName })
      }, 500)
      joinTimeout = window.setTimeout(() => {
        stopJoinTimers()
        setJoining(false)
        commitState(null)
        setError('Kein Host gefunden. Prüfe den Room-Code und ob der Host noch verbunden ist.')
        setRoom(null)
      }, 12_000)
    }
  }
  const notifyOtherParticipants = (activeRoom: P2PRoom, roomState: RoomState, voterId: string) => {
    for (const participant of roomState.participants) {
      if (!participant.connected || participant.id === voterId) continue
      if (participant.id === identity.clientId) {
        if (audioContextRef.current) void playOtherVoteSound(audioContextRef.current)
      } else {
        activeRoom.sendTo(participant.peerId, { type: 'VOTE_CAST' })
      }
    }
  }
  const handleHostMessage = (activeRoom: P2PRoom, message: ClientMessage, peerId: string) => {
    const currentState = stateRef.current
    if (!currentState) return
    if (message.type === 'HELLO') {
      const existing = currentState.participants.find((p) => p.id === message.clientId)
      if (existing?.peerId === peerId && existing.name === message.name && existing.connected) {
        activeRoom.sendTo(peerId, { type: 'STATE', state: currentState })
        return
      }
      const participants = existing
        ? currentState.participants.map((p) =>
            p.id === message.clientId ? { ...p, peerId, name: message.name, connected: true } : p,
          )
        : [
            ...currentState.participants,
            { id: message.clientId, name: message.name, peerId, connected: true, isHost: false },
          ]
      const next = { ...currentState, participants, version: currentState.version + 1 }
      activeRoom.sendTo(peerId, { type: 'STATE', state: next })
      activeRoom.broadcast({ type: 'STATE', state: next })
      commitState(next)
      return
    }
    const participant = currentState.participants.find((p) => p.peerId === peerId)
    if (message.type === 'ELIMINATE_GAME' && participant) {
      const result = eliminate(currentState, message.gameId, message.turnId, participant.id)
      if (result.accepted) {
        notifyOtherParticipants(activeRoom, currentState, participant.id)
        activeRoom.broadcast({ type: 'STATE', state: result.state })
        activeRoom.broadcast({
          type: 'EVENT',
          text: `${result.state.games.find((g) => g.id === message.gameId)?.name ?? 'Ein Spiel'} wurde eliminiert.`,
        })
        commitState(result.state)
        return
      }
    }
    if (message.type === 'FINAL_VOTE' && participant?.connected) {
      const voters = finalVotersRef.current.get(message.voteId) ?? new Set<string>()
      const result = castFinalVote(
        currentState,
        message.gameId,
        message.voteId,
        voters.has(participant.id),
      )
      if (result.accepted) {
        voters.add(participant.id)
        finalVotersRef.current.set(message.voteId, voters)
        notifyOtherParticipants(activeRoom, currentState, participant.id)
        activeRoom.broadcast({ type: 'STATE', state: result.state })
        commitState(result.state)
        return
      }
    }
    if (message.type === 'SKIP' && participant?.id === currentState.currentParticipantId) {
      const next = skipCurrent(currentState)
      if (next !== currentState) {
        activeRoom.broadcast({ type: 'STATE', state: next })
        commitState(next)
      }
    }
  }
  useEffect(
    () => () => {
      joinCleanupRef.current?.()
      void room?.leave()
    },
    [room],
  )
  useEffect(() => {
    const actionId =
      state?.status === 'playing' && state.currentParticipantId === me?.id
        ? state.turnId
        : state?.status === 'voting' && state.finalVoteId !== votedFinalId
          ? state.finalVoteId
          : undefined
    if (!actionId || alertedActionRef.current === actionId || !audioContextRef.current) return
    alertedActionRef.current = actionId
    void playTurnSound(audioContextRef.current)
  }, [
    me?.id,
    state?.currentParticipantId,
    state?.finalVoteId,
    state?.status,
    state?.turnId,
    votedFinalId,
  ])
  const updateHost = (next: RoomState) => {
    commitState(next)
    room?.broadcast({ type: 'STATE', state: next })
  }
  const removeParticipant = (participantId: string) => {
    const currentState = stateRef.current
    const participant = currentState?.participants.find((item) => item.id === participantId)
    if (
      !room ||
      !currentState ||
      currentState.status !== 'lobby' ||
      !participant ||
      participant.isHost
    )
      return
    room.sendTo(participant.peerId, { type: 'KICKED' })
    updateHost({
      ...currentState,
      version: currentState.version + 1,
      participants: currentState.participants.filter((item) => item.id !== participantId),
    })
  }
  const eliminateGame = (gameId: string) => {
    if (!state || !room || !me || !state.turnId) return
    setPending(gameId)
    room.sendToHost({ type: 'ELIMINATE_GAME', gameId, turnId: state.turnId })
    window.setTimeout(() => setPending(null), 700)
  }
  const submitFinalVote = (gameId: string) => {
    if (!room || !state?.finalVoteId || votedFinalId === state.finalVoteId) return
    setPending(gameId)
    setVotedFinalId(state.finalVoteId)
    room.sendToHost({ type: 'FINAL_VOTE', gameId, voteId: state.finalVoteId })
  }
  if ((!state || !room) && joining)
    return (
      <main className="shell centered">
        <section className="panel connecting">
          <div className="spinner" />
          <p className="eyebrow">ROOM · {code}</p>
          <h2>Verbinde mit dem Host …</h2>
          <p className="muted">Der Raum wird gesucht. Das kann einige Sekunden dauern.</p>
          <button
            onClick={() => {
              joinCleanupRef.current?.()
              setJoining(false)
              setRoom(null)
            }}
          >
            Abbrechen
          </button>
        </section>
      </main>
    )
  if (!state || !room)
    return (
      <main className="shell landing">
        <section className="hero">
          <div className="brand-lockup">
            <span className="brand-mark">V</span>
            <p className="eyebrow">VOTI · SPIELEABEND</p>
          </div>
          <h1>
            Welches Spiel
            <br />
            <span>bleibt übrig?</span>
          </h1>
          <p className="hero-copy">
            Gemeinsam aussortieren. Anonym abstimmen. Am Ende wird genau ein Spiel gespielt.
          </p>
        </section>
        <section className="panel form">
          <label>
            Anzeigename
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z. B. Alex"
            />
          </label>
          <label>
            Room-Code <small>(leer lassen zum Erstellen)</small>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="K7FQ2P"
              maxLength={6}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="button-row">
            <button className="primary" onClick={() => join(true)}>
              Neuen Raum erstellen
            </button>
            <button disabled={!code} onClick={() => join(false)}>
              Raum betreten
            </button>
          </div>
          <p className="hint">Keine Accounts. Kein Backend. Einfach Link teilen.</p>
        </section>
      </main>
    )
  const isMyTurn = state.currentParticipantId === me?.id
  if (state.status === 'finished') {
    const winner = state.games.find((g) => g.id === state.winnerGameId)
    return (
      <main className="shell centered">
        <p className="eyebrow">GEWINNER</p>
        <div className="winner">
          <span className="trophy">🏆</span>
          <h1>{winner?.name}</h1>
          <p>wird gespielt!</p>
          {state.finalVoteTallies && winner && (
            <small>{state.finalVoteTallies[winner.id] ?? 0} Stimmen im Finale</small>
          )}
        </div>
        {isHost && (
          <div className="actions">
            <button className="primary" onClick={() => updateHost(startRound(state))}>
              Neue Runde
            </button>
            <button onClick={() => updateHost({ ...state, status: 'lobby' })}>
              Zurück zur Lobby
            </button>
          </div>
        )}
      </main>
    )
  }
  return (
    <main className="shell">
      <header className="topbar">
        <div className="room-heading">
          <p className="eyebrow">ROOM · {code}</p>
          <h2>
            {state.status === 'lobby'
              ? 'Lobby'
              : state.status === 'voting'
                ? 'Finale · Mehrheit entscheidet'
                : `${state.games.filter((g) => !g.eliminated).length} Spiele übrig`}
          </h2>
        </div>
        <button
          className="small"
          onClick={() => navigator.clipboard?.writeText(window.location.href)}
        >
          Link kopieren
        </button>
      </header>
      {state.status === 'lobby' ? (
        <Lobby
          state={state}
          isHost={isHost}
          gamesText={gamesText}
          setGamesText={setGamesText}
          onRemoveParticipant={removeParticipant}
          onStart={() => {
            const games = parseGames(gamesText)
            updateHost(startRound({ ...state, originalGames: games, games }))
          }}
        />
      ) : state.status === 'voting' ? (
        <section>
          <div className="turn final-vote">
            <div className="turn-icon">▥</div>
            <div className="turn-copy">
              <div className="vote-mode">MEHRHEITSENTSCHEID</div>
              <strong>Das Spiel mit den meisten Stimmen gewinnt</strong>
              <span>
                {votedFinalId === state.finalVoteId
                  ? 'Deine Stimme wurde gezählt. Warte auf die anderen.'
                  : 'Jede Person hat genau eine anonyme Stimme.'}
              </span>
              <small>
                {state.finalVotesCast ?? 0} von {state.finalVotesRequired ?? 0} Stimmen abgegeben
              </small>
              <div className="vote-progress" aria-hidden="true">
                <i
                  style={{
                    width: `${((state.finalVotesCast ?? 0) / Math.max(state.finalVotesRequired ?? 1, 1)) * 100}%`,
                  }}
                />
              </div>
              <span className="tie-hint">Bei Gleichstand entscheidet der Zufall.</span>
            </div>
          </div>
          <div className="games">
            {state.games
              .filter((game) => !game.eliminated)
              .map((game) => (
                <button
                  key={game.id}
                  disabled={votedFinalId === state.finalVoteId || pending !== null}
                  className="game-card"
                  onClick={() => submitFinalVote(game.id)}
                >
                  <span className="game-copy">
                    <span className="game-name">{game.name}</span>
                    <small>Für dieses Spiel stimmen</small>
                  </span>
                  <span className="game-action">✓</span>
                </button>
              ))}
          </div>
        </section>
      ) : (
        <section>
          <div className="turn">
            <div className="turn-icon">{isMyTurn ? '!' : '•••'}</div>
            <div className="turn-copy">
              <strong>{isMyTurn ? 'Du bist dran' : 'Anonyme Abstimmung läuft'}</strong>
              <span>
                {isMyTurn
                  ? 'Wähle ein Spiel, das rausfliegt.'
                  : 'Eine Stimme wird gerade anonym abgegeben.'}
              </span>
            </div>
            {isHost && current && !current.connected && (
              <button className="small" onClick={() => updateHost(skipCurrent(state))}>
                Spieler überspringen
              </button>
            )}
          </div>
          <div className="games">
            {state.games
              .filter((g) => !g.eliminated)
              .map((game) => (
                <button
                  key={game.id}
                  disabled={!isMyTurn || pending !== null}
                  className="game-card"
                  onClick={() => eliminateGame(game.id)}
                >
                  <span className="game-name">{game.name}</span>
                  <span className="game-action">→</span>
                </button>
              ))}
          </div>
        </section>
      )}
    </main>
  )
}
function Lobby({
  state,
  isHost,
  gamesText,
  setGamesText,
  onRemoveParticipant,
  onStart,
}: {
  state: RoomState
  isHost: boolean
  gamesText: string
  setGamesText: (value: string) => void
  onRemoveParticipant: (participantId: string) => void
  onStart: () => void
}) {
  return (
    <section className="lobby">
      <div className="room-code">
        {state.hostPeerId ? 'Bereit für den Spieleabend' : 'Dein Raum'}
        <strong>{location.hash.slice(1)}</strong>
      </div>
      <h3>Teilnehmer · {state.participants.length}</h3>
      <div className="people">
        {state.participants.map((p) => (
          <div className="person" key={p.id}>
            <span className={p.connected ? 'dot' : 'dot off'} />
            {p.name}
            {p.isHost && <em>HOST</em>}
            {isHost && !p.isHost && (
              <button className="remove-player" onClick={() => onRemoveParticipant(p.id)}>
                Entfernen
              </button>
            )}
          </div>
        ))}
      </div>
      {isHost && (
        <>
          <label>
            Spiele, je eins pro Zeile
            <textarea value={gamesText} onChange={(e) => setGamesText(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={parseGames(gamesText).length < 2 || state.participants.length < 1}
            onClick={onStart}
          >
            Runde starten · {parseGames(gamesText).length} Spiele
          </button>
        </>
      )}
      <p className="hint">Teile den Link, damit weitere Spieler beitreten können.</p>
    </section>
  )
}
