const keys = { client: 'voti-client-id', name: 'voti-name', room: 'voti-room' } as const
const makeId = () => crypto.randomUUID()
export const loadIdentity = () => ({
  clientId: sessionStorage.getItem(keys.client) ?? makeId(),
  name: localStorage.getItem(keys.name) ?? '',
  roomCode: localStorage.getItem(keys.room) ?? '',
})
export const saveIdentity = (clientId: string, name: string, roomCode: string) => {
  sessionStorage.setItem(keys.client, clientId)
  localStorage.setItem(keys.name, name)
  localStorage.setItem(keys.room, roomCode)
}
export const clearRoom = () => localStorage.removeItem(keys.room)
export const makeRoomCode = () =>
  Array.from(
    { length: 6 },
    () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)],
  ).join('')
