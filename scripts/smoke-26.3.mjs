// Mock 26.3 server that enforces the new rule: movement packets must be
// followed by tick_end, or the client is kicked (~1.5 s like a real 26.3 server).
// Connects the MCP server's real BotConnection, which auto-detects the version via ping.
import { createRequire } from 'module'
const PROJECT = new URL('..', import.meta.url).pathname
const require = createRequire(PROJECT + 'package.json')
const mc = require('minecraft-protocol')
const registry = require('prismarine-registry')('26.3')
const Chunk = require('prismarine-chunk')(registry)
const { BotConnection } = await import(PROJECT + 'dist/bot-connection.js')

const dropTickEnd = process.argv.includes('--drop-tick-end')
const PORT = 25599
const MOVES = new Set(['position', 'position_look', 'look', 'flying'])

const server = mc.createServer({ 'online-mode': false, version: '26.3', port: PORT })
await new Promise(r => server.once('listening', r))

let kicked = null
let stats = { tickEnd: 0, moves: 0, maxMovesWithoutTickEnd: 0 }

server.on('playerJoin', (client) => {
  let pending = 0
  client.on('packet', (_d, meta) => {
    if (meta.name === 'tick_end') { stats.tickEnd++; pending = 0; return }
    if (MOVES.has(meta.name)) {
      stats.moves++; pending++
      stats.maxMovesWithoutTickEnd = Math.max(stats.maxMovesWithoutTickEnd, pending)
      if (pending > 30 && !kicked) { // ~1.5 s of ticks with no tick_end
        kicked = 'Too many movement packets without tick_end'
        client.end(kicked)
      }
    }
  })
  const login = { ...registry.loginPacket, entityId: 0 }
  client.write('login', login)
  const chunk = new Chunk({ minY: -64, worldHeight: 384 })
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockType({ x, y: 63, z }, registry.blocksByName.stone.id)
  client.write('map_chunk', {
    x: 0, z: 0, groundUp: true, biomes: chunk.dumpBiomes?.(),
    heightmaps: { type: 'compound', name: '', value: { MOTION_BLOCKING: { type: 'longArray', value: new Array(36).fill([0, 0]) } } },
    bitMap: chunk.getMask(), chunkData: chunk.dump(), blockEntities: [], trustEdges: false,
    ...chunk.dumpLight()
  })
  client.write('position', { x: 2.5, y: 70, z: 2.5, dx: 0, dy: 0, dz: 0, pitch: 0, yaw: 0, teleportId: 1, flags: {} })
  client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })
})

const logs = []
const conn = new BotConnection({ host: 'localhost', port: PORT, username: 'ClaudeBot', auth: 'offline' }, {
  onLog: (lvl, msg) => logs.push(`${lvl}: ${msg}`),
  onChatMessage: () => {}
}, 60_000)
conn.connect()
if (dropTickEnd) {
  const bot = conn.getBot()
  const write = bot._client.write.bind(bot._client)
  bot._client.write = (name, data) => name === 'tick_end' ? undefined : write(name, data)
}

const pf = require('mineflayer-pathfinder')
let walk = 'not attempted'
await new Promise(r => setTimeout(r, 2500))
{
  const b = conn.getBot()
  if (b && conn.getState() === 'connected') {
    walk = await Promise.race([
      b.pathfinder.goto(new pf.goals.GoalNear(13, 64, 13, 1)).then(() => 'reached goal', e => 'failed: ' + e.message),
      new Promise(r => setTimeout(() => r('timeout'), 6000))
    ])
  }
}
await new Promise(r => setTimeout(r, 500))
const bot = conn.getBot()
console.log(JSON.stringify({
  mode: dropTickEnd ? 'tick_end suppressed (simulates mineflayer 4.39.0)' : 'patched stack',
  detectedVersion: bot?.version ?? null,
  state: conn.getState(),
  kicked,
  walk,
  landedOnGround: bot?.entity?.onGround ?? null,
  y: bot?.entity?.position?.y ?? null,
  ...stats
}, null, 2))
console.log(logs.join('\n'))
bot?.quit(); server.close(); setTimeout(() => process.exit(0), 300)
