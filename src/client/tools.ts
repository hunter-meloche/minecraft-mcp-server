import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';
import { mineflayerToolDefinitions } from '../tools/register-all.js';
import { matchesTarget } from '../combat.js';
import type { BridgeClient } from './bridge-client.js';
import { layoutSpec, writeSchematic, type StructureSpec } from './schematic.js';

/**
 * The client backend's tools: the same names and parameters as the mineflayer backend (taken from its definitions),
 * answered through the bridge mod, plus tools only Baritone makes possible (mine-blocks, build-structure, stop).
 */

interface Pos { x: number; y: number; z: number }
interface Status {
  inWorld: boolean; username: string; screen: string | null;
  position?: Pos; block?: Pos; health?: number; food?: number; saturation?: number; air?: number;
  underWater?: boolean; inLava?: boolean; dimension?: string; gameMode?: string; difficulty?: string;
  timeOfDay?: number; process?: string | null; goal?: string | null;
}
interface InventoryItem { slot: number; name: string; count: number }
interface Inventory { items: InventoryItem[]; selectedSlot: number; held: { name: string; count: number } | null }
interface EntityInfo { id: number; name: string; category: string; position: Pos; distance: number; health?: number }
interface ProcessResult { reason: 'done' | 'timeout' | 'paused' | 'cancelled'; seconds: number; baritone: string[]; at?: Pos }

type Executor = (args: Record<string, unknown>) => Promise<ReturnType<ToolFactory['createResponse']>>;

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const floorPos = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Game-client inventory index -> the slot number the mineflayer backend reports (hotbar 36-44, armor 5-8, off-hand 45). */
export function mineflayerSlot(clientSlot: number): number {
  if (clientSlot <= 8) return 36 + clientSlot;
  if (clientSlot <= 35) return clientSlot;
  if (clientSlot <= 39) return 8 - (clientSlot - 36); // feet 36 -> 8 ... head 39 -> 5
  return 45;
}

const entityTypes = (() => {
  const data = minecraftData('26.3') as unknown as { entitiesByName?: Record<string, { type: string }> };
  return data.entitiesByName ?? {};
})();

/** Entity kind for the shared hostile/mob/player matching (minecraft-data's categories, as the mineflayer backend sees them). */
export function entityKind(name: string): { type: string; name: string } {
  return { type: name === 'player' ? 'player' : entityTypes[name]?.type ?? 'other', name };
}

function timeLine(t: number): string {
  // monsters spawn from about tick 13000 to 23000; a day is 24000 ticks = 20 minutes
  const night = t >= 13000 && t < 23000;
  const until = night ? 23000 - t : (13000 - t + 24000) % 24000;
  const minutes = (until / 20 / 60).toFixed(1);
  return `Time of day ${t} (${night ? `night; dawn in ${minutes} min` : `day; night in ${minutes} min`})`;
}

function baritoneSaid(lines: string[], max = 3): string {
  const said = lines.map(l => l.replace(/^\[Baritone\]\s*/, '')).filter(l => l.trim()).slice(-max);
  return said.length ? ` Baritone: ${said.join(' | ')}` : '';
}

export interface ClientToolOptions {
  /** the client's game folder (schematics are written to <gameDir>/schematics) */
  gameDir: string;
}

export function registerClientTools(factory: ToolFactory, bridge: BridgeClient, messageStore: MessageStore, options: ClientToolOptions): void {
  const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) =>
    bridge.request<T>(method, params, timeoutMs ? { timeoutMs } : undefined);
  const status = async () => {
    const s = await call<Status>('status');
    if (!s.inWorld) throw new Error(`The bot is not in a world yet (screen: ${s.screen ?? 'none'}). Try again shortly.`);
    return s;
  };

  const impl: Record<string, Executor> = {
    'get-position': async () => {
      const s = await status();
      return factory.createResponse(`Current position: ${fmt(s.block!)}`);
    },

    'detect-gamemode': async () => factory.createResponse(`Bot gamemode: "${(await status()).gameMode}"`),

    'get-status': async () => {
      const s = await status();
      return factory.createResponse([
        `Health ${s.health}/20, food ${s.food}/20, saturation ${s.saturation}`,
        timeLine(s.timeOfDay ?? 0),
        `Dimension ${s.dimension}, game mode ${s.gameMode}, difficulty ${s.difficulty}`,
        `Backend: game client with Baritone (${s.process ? `busy: ${s.process}` : 'idle'})` +
          (s.underWater ? `; under water, air ${s.air}/20` : '') + (s.inLava ? '; IN LAVA' : '')
      ].join('\n'));
    },

    'list-inventory': async () => {
      const inv = await call<Inventory>('inventory');
      if (!inv.items.length) return factory.createResponse('Inventory is empty');
      let text = `Found ${inv.items.length} items in inventory:\n\n`;
      for (const i of inv.items) text += `- ${i.name} (x${i.count}) in slot ${mineflayerSlot(i.slot)}\n`;
      return factory.createResponse(text);
    },

    'find-item': async ({ nameOrType }) => {
      const inv = await call<Inventory>('inventory');
      const q = String(nameOrType).toLowerCase();
      const item = inv.items.find(i => i.name === q) ?? inv.items.find(i => i.name.includes(q));
      return factory.createResponse(item
        ? `Found ${item.count} ${item.name} in inventory (slot ${mineflayerSlot(item.slot)})`
        : `Couldn't find any item matching '${nameOrType}' in inventory`);
    },

    'get-block-info': async ({ x, y, z }) => {
      const p = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const b = await call<{ loaded: boolean; name?: string; properties?: Record<string, string> }>('world.block', { ...p });
      if (!b.loaded) return factory.createResponse(`No block information found at position ${fmt(p)} (not loaded)`);
      const props = Object.entries(b.properties ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
      return factory.createResponse(`Found ${b.name}${props ? `[${props}]` : ''} at position ${fmt(p)}`);
    },

    'find-blocks': async ({ blockType, maxDistance = 16, count = 1 }) => {
      const n = Math.min(Number(count), 256);
      const r = await call<{ positions: Pos[] }>('world.findBlocks', { block: blockType, maxDistance, count: n });
      if (!r.positions.length) return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      if (n === 1) return factory.createResponse(`Found ${blockType} at position ${fmt(r.positions[0])}`);
      return factory.createResponse(`Found ${r.positions.length} ${blockType} block(s) within ${maxDistance} blocks:\n` +
        r.positions.map((p, i) => `${i + 1}. ${fmt(p)}`).join('\n'));
    },

    'find-entity': async ({ type = '', maxDistance = 16 }) => {
      const r = await call<{ entities: EntityInfo[] }>('world.entities', { maxDistance });
      const t = String(type).toLowerCase();
      const match = (e: EntityInfo) => !t || (['player', 'mob', 'hostile'].includes(t) ? matchesTarget(entityKind(e.name), t) : e.name.includes(t));
      const e = r.entities.find(match);
      if (!e) return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      return factory.createResponse(`Found ${e.name} at position ${fmt(floorPos(e.position))}`);
    },

    'send-chat': async ({ message }) => {
      await call('chat.send', { text: String(message) });
      return factory.createResponse(`Sent message: "${message}"`);
    },

    'read-chat': async ({ count = 10 }) => {
      const messages = messageStore.getRecentMessages(Math.min(Number(count), messageStore.getMaxMessages()));
      if (!messages.length) return factory.createResponse('No chat messages found');
      return factory.createResponse(`Found ${messages.length} chat message(s):\n\n` +
        messages.map((m, i) => `${i + 1}. ${new Date(m.timestamp).toISOString()} - ${m.username}: ${m.content}`).join('\n') + '\n');
    },

    'move-to-position': async ({ x, y, z, range = 1, timeoutMs = 180_000 }) => {
      const target = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const r = await call<ProcessResult & { arrived: boolean; distance: number }>('goto',
        { ...target, range, timeoutMs }, Number(timeoutMs) + 15_000);
      if (r.arrived) return factory.createResponse(`Successfully moved to position near ${fmt(target)}`);
      const why = r.reason === 'timeout' ? `timed out after ${r.seconds}s` : 'no path found';
      throw new Error(`Could not reach ${fmt(target)}: ${why}. Stopped at ${fmt(r.at!)}, ${r.distance} blocks away.${baritoneSaid(r.baritone)}`);
    }
  };

  const notYet: Executor = async () => factory.createErrorResponse(
    'This tool is not available on the client backend yet. Run the server with --backend mineflayer to use it.');

  for (const def of mineflayerToolDefinitions()) {
    factory.registerTool(def.name, def.description, def.schema, impl[def.name] ?? notYet);
  }

  // ---- tools only the client backend has

  factory.registerTool(
    'mine-blocks',
    "Gather blocks with Baritone: it finds the nearest blocks of the type (from its memory of the world and nearby chunks), walks there, mines them with the right tool and picks up the drops, until the inventory has `count` of the item (counting what it already holds). E.g. block 'oak_log', count 16.",
    {
      block: z.string().describe("Block to mine, e.g. 'oak_log', 'stone', 'iron_ore'"),
      count: z.coerce.number().int().positive().optional().describe('How many of the item to have in the inventory when done (default: 1)'),
      timeoutMs: z.number().int().min(1000).optional().describe('Give up after this long (default: 300000)')
    },
    async ({ block, count = 1, timeoutMs = 300_000 }: { block: string; count?: number; timeoutMs?: number }) => {
      const r = await call<ProcessResult & { gained: Record<string, number> }>('mine', { block, count, timeoutMs }, timeoutMs + 15_000);
      const gained = Object.entries(r.gained).map(([n, c]) => `${n} x${c}`).join(', ');
      const head = r.reason === 'timeout' ? `Stopped after ${r.seconds}s (time limit)` : `Mined for ${r.seconds}s`;
      return factory.createResponse(`${head}: ${gained || 'nothing gained'}.${baritoneSaid(r.baritone)}`);
    }
  );

  factory.registerTool(
    'build-structure',
    "Build a structure block by block with Baritone (it places blocks from the inventory, clears what's in the way, and scaffolds as needed). Describe it as `spec`: a palette of single characters to blocks and `layers` from the bottom up, each a list of rows along +z whose characters run along +x; '.' is air (cleared). Example: {palette:{L:'oak_log[axis=y]',P:'oak_planks'}, layers:[['LPL','P.P','LPL']]}. Or give `file`, a .schem/.litematic path. The structure's minimum corner goes at x,y,z. Checks the inventory has the blocks first (survival).",
    {
      x: z.coerce.number().describe('X of the minimum corner'),
      y: z.coerce.number().describe('Y of the bottom layer'),
      z: z.coerce.number().describe('Z of the minimum corner'),
      spec: z.object({
        palette: z.record(z.string(), z.string()),
        layers: z.array(z.array(z.string()))
      }).optional().describe('Structure as palette + layers (see the tool description)'),
      file: z.string().optional().describe('Path to an existing .schem or .litematic file instead of spec'),
      name: z.string().regex(/^[\w-]+$/).optional().describe('Name for the schematic file (default: structure)'),
      timeoutMs: z.number().int().min(1000).optional().describe('Give up after this long (default: 600000)')
    },
    async ({ x, y, z: zz, spec, file, name = 'structure', timeoutMs = 600_000 }: {
      x: number; y: number; z: number; spec?: StructureSpec; file?: string; name?: string; timeoutMs?: number
    }) => {
      const origin = floorPos({ x, y, z: zz });
      let schematicFile: string;
      if (spec) {
        const layout = layoutSpec(spec);
        const s = await status();
        if (s.gameMode !== 'creative') {
          const inv = await call<Inventory>('inventory');
          const have: Record<string, number> = {};
          for (const i of inv.items) have[i.name] = (have[i.name] ?? 0) + i.count;
          const missing = Object.entries(layout.counts).filter(([item, n]) => (have[item] ?? 0) < n)
            .map(([item, n]) => `${item} ${have[item] ?? 0}/${n}`);
          if (missing.length) return factory.createErrorResponse(`Not enough blocks to build it. Missing: ${missing.join(', ')}`);
        }
        const dir = path.join(options.gameDir, 'schematics');
        fs.mkdirSync(dir, { recursive: true });
        schematicFile = path.join(dir, `${name}.schem`);
        fs.writeFileSync(schematicFile, writeSchematic(layout));
      } else if (file) {
        schematicFile = path.resolve(file);
      } else {
        return factory.createErrorResponse('Give either spec or file');
      }
      const r = await call<ProcessResult & { used: Record<string, number> }>('build', { file: schematicFile, ...origin, timeoutMs }, timeoutMs + 15_000);
      const used = Object.entries(r.used).map(([n, c]) => `${n} x${c}`).join(', ');
      if (r.reason === 'paused') {
        return factory.createErrorResponse(`Build paused after ${r.seconds}s (probably out of a block it needs).${baritoneSaid(r.baritone)}`);
      }
      const head = r.reason === 'timeout' ? `Build stopped after ${r.seconds}s (time limit)` : `Built ${name} at ${fmt(origin)} in ${r.seconds}s`;
      return factory.createResponse(`${head}. Used: ${used || 'nothing'}.${baritoneSaid(r.baritone)}`);
    }
  );

  factory.registerTool(
    'stop',
    'Stop whatever the bot is doing (walking, mining, building).',
    {},
    async () => {
      await call('cancel');
      return factory.createResponse('Stopped');
    }
  );
}
