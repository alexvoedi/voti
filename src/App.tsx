import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import {
  castFinalVote,
  createLobby,
  eliminate,
  gamesForPlayers,
  parseGames,
  skipCurrent,
  startRound,
} from './game/state'
import type { Game, RoomState } from './game/types'
import { Button } from './components/ui/button'
import { Checkbox } from './components/ui/checkbox'
import { Input } from './components/ui/input'
import type { ClientMessage, ServerMessage } from './p2p/protocol'
import { LOCAL_HOST_PEER_ID, P2PRoom } from './p2p/room'
import { loadGames, loadIdentity, makeRoomCode, saveGames, saveIdentity } from './utils/storage'

const codeFromHash = () => window.location.hash.slice(1).toUpperCase()
const loadSavedGames = () => {
  const saved = loadGames('')
  try {
    const value: unknown = JSON.parse(saved)
    if (
      Array.isArray(value) &&
      value.every(
        (game) =>
          typeof game === 'object' &&
          game !== null &&
          typeof game.name === 'string' &&
          (typeof game.minPlayers === 'number' || game.minPlayers === null) &&
          (typeof game.maxPlayers === 'number' || game.maxPlayers === null),
      )
    ) {
      return value as Game[]
    }
  } catch {
    // Ältere gespeicherte Textlisten werden weiter unterstützt.
  }
  return parseGames(saved)
}
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
  const [games, setGames] = useState(loadSavedGames)
  const [filterGamesByPlayers, setFilterGamesByPlayers] = useState(true)
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
          games.filter((game) => game.name.trim()),
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
  const updateGames = (nextGames: Game[]) => {
    setGames(nextGames)
    saveGames(JSON.stringify(nextGames))
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
          games={games}
          onGamesChange={updateGames}
          onRemoveParticipant={removeParticipant}
          onStart={() => {
            const enteredGames = games.filter((game) => game.name.trim())
            const selectedGames = filterGamesByPlayers
              ? gamesForPlayers(
                  enteredGames,
                  state.participants.filter((participant) => participant.connected).length,
                )
              : enteredGames
            updateHost(startRound({ ...state, originalGames: selectedGames, games: selectedGames }))
          }}
          filterGamesByPlayers={filterGamesByPlayers}
          onFilterGamesByPlayersChange={setFilterGamesByPlayers}
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
          <ParticipantStrip participants={state.participants} />
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
                  <span className="game-action">
                    <Check size={17} strokeWidth={2.2} />
                  </span>
                </button>
              ))}
          </div>
          <EliminatedGames games={state.games} />
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
          <ParticipantStrip participants={state.participants} />
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
                  <span className="game-action">
                    <ArrowRight size={17} strokeWidth={2} />
                  </span>
                </button>
              ))}
          </div>
          <EliminatedGames games={state.games} />
        </section>
      )}
    </main>
  )
}
function ParticipantStrip({ participants }: { participants: RoomState['participants'] }) {
  return (
    <div className="participant-strip" aria-label="Teilnehmer">
      <span className="participant-label">DABEI</span>
      <div className="participant-list">
        {participants.map((participant) => (
          <span className="participant-chip" key={participant.id}>
            <span className={participant.connected ? 'dot' : 'dot off'} />
            {participant.name}
          </span>
        ))}
      </div>
    </div>
  )
}
function EliminatedGames({ games }: { games: Game[] }) {
  const eliminated = games.filter((game) => game.eliminated)
  if (eliminated.length === 0) return null
  return (
    <section className="eliminated-games" aria-label="Bereits ausgeschiedene Spiele">
      <p className="eyebrow">BEREITS AUSGESCHIEDEN · {eliminated.length}</p>
      <div className="eliminated-list">
        {eliminated.map((game) => (
          <span className="eliminated-game" key={game.id}>
            <span aria-hidden="true">×</span>
            {game.name}
          </span>
        ))}
      </div>
    </section>
  )
}
function Lobby({
  state,
  isHost,
  games,
  onGamesChange,
  filterGamesByPlayers,
  onFilterGamesByPlayersChange,
  onRemoveParticipant,
  onStart,
}: {
  state: RoomState
  isHost: boolean
  games: Game[]
  onGamesChange: (games: Game[]) => void
  filterGamesByPlayers: boolean
  onFilterGamesByPlayersChange: (value: boolean) => void
  onRemoveParticipant: (participantId: string) => void
  onStart: () => void
}) {
  const connectedPlayers = state.participants.filter((participant) => participant.connected).length
  const enteredGames = games.filter((game) => game.name.trim())
  const matchingGames = filterGamesByPlayers
    ? gamesForPlayers(enteredGames, connectedPlayers)
    : enteredGames
  const updateGame = (id: string, changes: Partial<Game>) => {
    onGamesChange(games.map((game) => (game.id === id ? { ...game, ...changes } : game)))
  }
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
          <label>Spiele</label>
          <div className="game-editor">
            <div className="game-editor-header">
              <span>Spielname</span>
              <span>Min.</span>
              <span>Max.</span>
              <span />
            </div>
            {games.map((game) => (
              <div className="game-editor-row" key={game.id}>
                <Input
                  aria-label="Spielname"
                  placeholder="Spielname"
                  value={game.name}
                  onChange={(e) => updateGame(game.id, { name: e.target.value })}
                />
                <Input
                  aria-label={`Mindestanzahl für ${game.name}`}
                  type="number"
                  min="1"
                  value={game.minPlayers ?? ''}
                  placeholder="min"
                  onChange={(e) =>
                    updateGame(game.id, {
                      minPlayers: e.target.value ? Math.max(1, Number(e.target.value)) : null,
                    })
                  }
                />
                <Input
                  aria-label={`Höchstanzahl für ${game.name}`}
                  type="number"
                  min={game.minPlayers ?? 1}
                  placeholder="max"
                  value={game.maxPlayers ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    updateGame(game.id, {
                      maxPlayers: value ? Number(value) : null,
                    })
                  }}
                />
                <Button
                  variant="ghost"
                  type="button"
                  className="remove-player"
                  aria-label={`${game.name} entfernen`}
                  title={`${game.name} entfernen`}
                  onClick={() => onGamesChange(games.filter((item) => item.id !== game.id))}
                >
                  ×
                </Button>
              </div>
            ))}
            <Button
              type="button"
              onClick={() =>
                onGamesChange([
                  ...games,
                  {
                    id: crypto.randomUUID(),
                    name: '',
                    minPlayers: null,
                    maxPlayers: null,
                    eliminated: false,
                  },
                ])
              }
            >
              + Spiel hinzufügen
            </Button>
          </div>
          <p className="hint">
            Spiele ohne Min. oder Max. gelten als für jede Gruppengröße geeignet.
          </p>
          <label className="toggle-row">
            <Checkbox
              checked={filterGamesByPlayers}
              onCheckedChange={(checked) => onFilterGamesByPlayersChange(checked === true)}
            />
            Spieleranzahl berücksichtigen
          </label>
          <button
            className="primary"
            disabled={matchingGames.length < 2 || connectedPlayers < 1}
            onClick={onStart}
          >
            Runde starten · {matchingGames.length} passende Spiele
          </button>
          {games.length >= 2 && matchingGames.length < 2 && (
            <p className="error">
              Für {connectedPlayers} Spieler passen aktuell weniger als zwei Spiele.
            </p>
          )}
        </>
      )}
      <p className="hint">Teile den Link, damit weitere Spieler beitreten können.</p>
    </section>
  )
}
