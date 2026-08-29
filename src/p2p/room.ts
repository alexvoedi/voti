import mqtt, { type MqttClient } from 'mqtt'
import type { ClientMessage, ServerMessage } from './protocol'

type PeerHandler = (peerId: string) => void
type PresencePacket = { kind: 'presence'; sender: string; role: 'host' | 'client' }
type LeavePacket = { kind: 'leave'; sender: string }
type ClientPacket = { kind: 'client'; sender: string; target?: string; message: ClientMessage }
type ServerPacket = { kind: 'server'; sender: string; target?: string; message: ServerMessage }
type TransportPacket = PresencePacket | LeavePacket | ClientPacket | ServerPacket
type PeerPresence = { lastSeen: number; role: 'host' | 'client' }

const BROKER_URL = 'wss://test.mosquitto.org:8081/mqtt'
const PRESENCE_INTERVAL_MS = 2_000
const PEER_TIMEOUT_MS = 8_000
export const LOCAL_HOST_PEER_ID = '__host__'

const isTransportPacket = (value: unknown): value is TransportPacket => {
  if (!value || typeof value !== 'object') return false
  const packet = value as Record<string, unknown>
  return (
    typeof packet.kind === 'string' &&
    typeof packet.sender === 'string' &&
    ['presence', 'leave', 'client', 'server'].includes(packet.kind)
  )
}

export class P2PRoom {
  private readonly client: MqttClient
  private readonly peerId = crypto.randomUUID()
  private readonly topic: string
  private readonly peers = new Map<string, PeerPresence>()
  private readonly presenceTimer: number
  private readonly sweepTimer: number
  private hostPeerId: string | undefined
  private hasConnected = false

  onMessage: ((message: ServerMessage) => void) | undefined
  onClientMessage: ((message: ClientMessage, peerId: string) => void) | undefined
  onPeerJoin: PeerHandler | undefined
  onPeerLeave: PeerHandler | undefined
  onError: ((message: string) => void) | undefined

  constructor(
    code: string,
    private readonly host: boolean,
  ) {
    this.topic = `voti/v3/${code}/events`
    const leavePacket: LeavePacket = { kind: 'leave', sender: this.peerId }
    this.client = mqtt.connect(BROKER_URL, {
      clientId: `voti_${this.peerId.replaceAll('-', '').slice(0, 16)}`,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 1_000,
      keepalive: 15,
      will: { topic: this.topic, payload: JSON.stringify(leavePacket), qos: 1, retain: false },
    })
    this.client.on('connect', () => {
      this.hasConnected = true
      void this.client
        .subscribeAsync(this.topic, { qos: 1 })
        .then(() => this.announce())
        .catch((cause: unknown) => this.reportError(cause))
    })
    this.client.on('message', (topic, payload) => {
      if (topic !== this.topic) return
      try {
        const packet: unknown = JSON.parse(payload.toString())
        if (isTransportPacket(packet)) this.receive(packet)
      } catch {
        // Ignore malformed traffic on the public broker topic.
      }
    })
    this.client.on('error', (cause) => {
      if (!this.hasConnected) this.reportError(cause)
    })
    this.presenceTimer = window.setInterval(() => this.announce(), PRESENCE_INTERVAL_MS)
    this.sweepTimer = window.setInterval(() => this.sweepPeers(), PRESENCE_INTERVAL_MS)
  }

  private reportError(cause: unknown) {
    this.onError?.(cause instanceof Error ? cause.message : 'MQTT-Verbindung fehlgeschlagen.')
  }

  private publish(packet: TransportPacket) {
    void this.client.publishAsync(this.topic, JSON.stringify(packet), { qos: 1 }).catch(() => {
      // MQTT.js reconnects and retries queued QoS messages automatically.
    })
  }

  private announce() {
    if (!this.client.connected) return
    this.publish({ kind: 'presence', sender: this.peerId, role: this.host ? 'host' : 'client' })
  }

  private receive(packet: TransportPacket) {
    if (packet.sender === this.peerId) return
    if (packet.kind === 'presence') {
      const known = this.peers.has(packet.sender)
      this.peers.set(packet.sender, { lastSeen: Date.now(), role: packet.role })
      if (packet.role === 'host' && !this.host) this.hostPeerId = packet.sender
      if (!known) this.onPeerJoin?.(packet.sender)
      if (this.host && packet.role === 'client') this.announce()
      return
    }
    if (packet.kind === 'leave') {
      this.notifyPeerLeave(packet.sender)
      return
    }
    if (packet.target && packet.target !== this.peerId) return
    if (packet.kind === 'client' && this.host) {
      this.touchPeer(packet.sender, 'client')
      this.onClientMessage?.(packet.message, packet.sender)
    }
    if (packet.kind === 'server' && !this.host) {
      this.hostPeerId = packet.sender
      this.touchPeer(packet.sender, 'host')
      this.onMessage?.(packet.message)
    }
  }

  private touchPeer(peerId: string, role: 'host' | 'client') {
    const known = this.peers.has(peerId)
    this.peers.set(peerId, { lastSeen: Date.now(), role })
    if (!known) this.onPeerJoin?.(peerId)
  }

  private sweepPeers() {
    const cutoff = Date.now() - PEER_TIMEOUT_MS
    for (const [peerId, presence] of this.peers) {
      if (presence.lastSeen < cutoff) this.notifyPeerLeave(peerId)
    }
  }

  private notifyPeerLeave(peerId: string) {
    if (!this.peers.delete(peerId)) return
    this.onPeerLeave?.(peerId)
  }

  sendToHost(message: ClientMessage) {
    if (this.host) {
      this.onClientMessage?.(message, LOCAL_HOST_PEER_ID)
      return
    }
    this.publish({ kind: 'client', sender: this.peerId, target: this.hostPeerId, message })
  }

  sendClientTo(peerId: string, message: ClientMessage) {
    this.publish({ kind: 'client', sender: this.peerId, target: peerId, message })
  }

  isHostPeer(peerId: string) {
    return peerId === this.hostPeerId
  }

  broadcast(message: ServerMessage) {
    this.publish({ kind: 'server', sender: this.peerId, message })
  }

  sendTo(peerId: string, message: ServerMessage) {
    this.publish({ kind: 'server', sender: this.peerId, target: peerId, message })
  }

  async leave() {
    window.clearInterval(this.presenceTimer)
    window.clearInterval(this.sweepTimer)
    if (this.client.connected) this.publish({ kind: 'leave', sender: this.peerId })
    await this.client.endAsync(false)
  }
}
