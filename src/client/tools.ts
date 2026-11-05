import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { MessageStore } from '../message-store.js';
import { mineflayerToolDefinitions } from '../tools/register-all.js';
import { matchesTarget } from '../combat.js';
import type { BridgeClient } from './bridge-client.js';
import { ClientProtection } from './protection.js';
import { worldIdFromSeed, type ProtectionStore } from '../build-protection.js';
import { checkBuild, keepExisting, LEAVE, layoutSpec, missingCells, placerFacing, secondHalf, splitDirectional, writeSchematic, type Schematic, type StructureSpec } from './schematic.js';
import type { Item } from 'prismarine-item';
import { ALWAYS_EDIBLE, chooseFood, type FoodInfo } from '../food.js';
import { smeltsPerFuel } from '../tools/furnace-tools.js';

const foodsFor26 = () => (minecraftData('26.3') as unknown as { foodsByName: Record<string, FoodInfo> }).foodsByName;

/**
 * The client backend's tools: the same names and parameters as the mineflayer backend (taken from its definitions),
 * answered through the bridge mod, plus tools only Baritone makes possible (mine-blocks, build-structure, stop).
 */

interface Pos { x: number; y: number; z: number }
interface Status {
  inWorld: boolean; username: string; screen: string | null;
  position?: Pos; block?: Pos; health?: number; food?: number; saturation?: number; air?: number;
  underWater?: boolean; inLava?: boolean; dimension?: string; gameMode?: string; difficulty?: string;
  timeOfDay?: number; process?: string | null; goal?: string | null; hashedSeed?: string | null; protectedCount?: number;
  windowMinimized?: boolean; mouseGrabbed?: boolean;
}
interface InventoryItem { slot: number; name: string; count: number }
interface Inventory { items: InventoryItem[]; selectedSlot: number; held: { name: string; count: number } | null }
interface EntityInfo { id: number; name: string; category: string; position: Pos; distance: number; health?: number }
interface FightResult {
  outcome: 'none' | 'done' | 'timeout' | 'low_health' | 'unreachable';
  kills: string[]; vanished: string[]; unreachable: string[]; hits: number; landed: number;
  swungWith: Record<string, number>; seconds: number; wore: string[]; target: string; dropsAt: Pos;
  retreat?: string; threats?: string; health?: number;
}
interface ProcessResult { reason: 'done' | 'timeout' | 'paused' | 'cancelled'; seconds: number; baritone: string[]; at?: Pos }

type Executor = (args: Record<string, unknown>) => Promise<ReturnType<ToolFactory['createResponse']>>;

/** build-structure: how often it looks at the build while Baritone works, and how long without change counts as stuck. */
let STALL_POLL_MS = 15_000;
let STALL_MS = 60_000;
/** For tests: shorter stall timing. */
export function setStallTiming(pollMs: number, stallMs: number): void { STALL_POLL_MS = pollMs; STALL_MS = stallMs; }

/** Items that break from use rather than being placed. */
const WEARABLE = /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|fishing_rod|flint_and_steel|shield|bow|crossbow|trident|mace)$/;

/** Baritone's process names, readable: "Mine BlockOptionalMetaLookup{[...block=Block{minecraft:glass}...]}" -> "Mine glass". */
export function processName(raw: string): string {
  const blocks = [...raw.matchAll(/Block\{minecraft:([a-z0-9_]+)\}/g)].map(m => m[1]);
  return blocks.length ? `${raw.split(' ')[0]} ${blocks.join(', ')}` : raw;
}

/** How far craft-item looks for a crafting table to walk to. */
const TABLE_SEARCH = 48;

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const floorPos = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** Game-client inventory index -> the slot number the mineflayer backend reports (hotbar 36-44, armor 5-8, off-hand 45). */
export function mineflayerSlot(clientSlot: number): number {
  if (clientSlot <= 8) return 36 + clientSlot;
  if (clientSlot <= 35) return clientSlot;
  if (clientSlot <= 39) return 8 - (clientSlot - 36); // feet 36 -> 8 ... head 39 -> 5
  return 45;
}

/** Item names a block drops (minecraft-data 26.3), or the block's own name when it lists none. */
export function blockDrops(block: string): string[] {
  const data = minecraftData('26.3') as unknown as { blocksByName: Record<string, { drops?: number[] }>; items: Record<number, { name: string }> };
  const names = (data.blocksByName[block]?.drops ?? []).map(id => data.items[id]?.name).filter((n): n is string => !!n);
  return names.length ? [...new Set(names)] : [block];
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
  /** where the list of blocks the bot built is kept (default: memory only) */
  protectionStore?: ProtectionStore;
}

export function registerClientTools(factory: ToolFactory, bridge: BridgeClient, messageStore: MessageStore, options: ClientToolOptions): void {
  const call = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) =>
    bridge.request<T>(method, params, timeoutMs ? { timeoutMs } : undefined);
  const protection = new ClientProtection(options.protectionStore);
  let syncedVersion = -1;
  /** Keep the game client's copy of the protected positions (it turns them into Baritone's no-break list) current. */
  const syncProtection = async (dim: string, force = false) => {
    if (!force && syncedVersion === protection.version) return;
    const positions = protection.positions(dim).map(p => [p.x, p.y, p.z]);
    await call('protect.set', { positions }).then(() => { syncedVersion = protection.version; }).catch(() => undefined);
  };
  const status = async () => {
    const s = await call<Status>('status');
    if (!s.inWorld) throw new Error(`The bot is not in a world yet (screen: ${s.screen ?? 'none'}). Try again shortly.`);
    protection.attach(worldIdFromSeed(s.hashedSeed ?? undefined));
    // a relaunched client starts with none: resend when its count differs
    await syncProtection(s.dimension ?? 'overworld', s.protectedCount !== undefined && s.protectedCount !== protection.positions(s.dimension ?? 'overworld').length);
    return s;
  };
  const dimension = async () => (await status()).dimension ?? 'overworld';

  const impl: Record<string, Executor> = {
    'get-position': async () => {
      const s = await status();
      return factory.createResponse(`Current position: ${fmt(s.block!)}`);
    },

    'detect-gamemode': async () => factory.createResponse(`Bot gamemode: "${(await status()).gameMode}"`),

    'get-status': async () => {
      const s = await status();
      const guard = await call<{ enabled: boolean; armor: string[] }>('guardian.status');
      return factory.createResponse([
        `Health ${s.health}/20, food ${s.food}/20, saturation ${s.saturation}`,
        timeLine(s.timeOfDay ?? 0),
        `Dimension ${s.dimension}, game mode ${s.gameMode}, difficulty ${s.difficulty}`,
        `Armor: ${guard.armor.length ? guard.armor.join(', ') : 'none'}; auto-defend ${guard.enabled ? 'on' : 'off'}`,
        `Backend: game client with Baritone (${s.process ? `busy: ${processName(s.process)}` : 'idle'})` +
          (s.windowMinimized !== undefined ? `; window ${s.windowMinimized ? 'minimized' : 'shown'}${s.mouseGrabbed ? ', mouse captured' : ''}` : '') +
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

  // ---- phase 2: interaction

  /**
   * mine-blocks when some blocks of the type nearby are the bot's own builds: dig the nearest others one at a time
   * (dig walks into reach) instead of Baritone's mine process, which would take the walls. Counts like Baritone does:
   * done when the inventory holds `count` of what the blocks drop (the first dig shows what that is).
   */
  const mineAround = async (block: string, count: number, timeoutMs: number, dim: string, guarded: number) => {
    const started = Date.now();
    const before = (await inventoryCounts()).counts;
    const skip = new Set<string>();
    let dug = 0;
    // what the block drops (minecraft-data), else the block's own item: count that (the first dig's pickup was sticks once)
    const drops = blockDrops(block);
    const have = async () => { const c = (await inventoryCounts()).counts; return Math.max(...drops.map(d => c.get(d) ?? 0)); };
    while (Date.now() - started < timeoutMs && (await have()) < count) {
      const found = await call<{ positions: Pos[] }>('world.findBlocks', { block, maxDistance: 64, count: 256 });
      const next = found.positions.find(p => !protection.has(dim, p) && !skip.has(fmt(p)));
      if (!next) break;
      skip.add(fmt(next));
      const r = await call<{ dug: boolean }>('dig', { ...next, timeoutMs: 30_000 }, 45_000).catch(() => ({ dug: false }));
      if (!r.dug) continue;
      dug++;
      await collectDropsNear(next);
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const gained = gainedText(before, (await inventoryCounts()).counts);
    const why = (await have()) >= count ? '' : Date.now() - started >= timeoutMs ? ' (time limit)' : ` (no more reachable ${block} that isn't part of a build)`;
    return factory.createResponse(`Mined ${dug} ${block} one by one in ${seconds}s${why}, leaving ${guarded} that belong to your builds: ` +
      `${gained || 'nothing gained'}.`);
  };

  /** The world position of a structure cell (schematic index order: x, then z, then y). */
  const cellPos = (origin: Pos, layout: Schematic, i: number): Pos => ({
    x: origin.x + i % layout.width,
    y: origin.y + Math.floor(i / (layout.width * layout.length)),
    z: origin.z + Math.floor(i / layout.width) % layout.length
  });

  /** World positions of the structure's block cells (not air, not leave-as-is) that hold a block now. */
  const standing = (origin: Pos, layout: Schematic, world: (string | null)[]): Pos[] => {
    const leave = layout.palette[LEAVE];
    const out: Pos[] = [];
    layout.blocks.forEach((b, i) => {
      if (b === 0 || b === leave || !world[i] || /^(minecraft:)?(air|cave_air|void_air)$/.test(world[i]!)) return;
      out.push(cellPos(origin, layout, i));
    });
    return out;
  };

  /** The world's blocks in a structure's box (for checkBuild). */
  const region = async (origin: Pos, layout: Schematic) => (await call<{ blocks: (string | null)[] }>('world.region',
    { ...origin, width: layout.width, height: layout.height, length: layout.length }, 30_000)).blocks;

  /** Place `item` at `at` while facing `look` (clearing a wrong block first); returns why not, or undefined when placed. */
  const placeFacing = async (at: Pos, item: string, look?: string): Promise<string | undefined> => {
    type Placed = { placed: boolean; block?: string; reason?: string };
    try { await call('item.select', { name: item }); } catch { return `no ${item} in the inventory`; }
    const attempt = () => call<Placed>('place', { ...at, face: 'down', ...(look ? { facing: look } : {}) });
    let r = await attempt();
    if (!r.placed && r.reason?.startsWith('occupied by')) {
      await call('dig', { ...at }, 75_000).catch(() => undefined);
      await call('item.select', { name: item });
      r = await attempt();
    }
    if (!r.placed && r.reason === 'the bot is standing there') {
      // step out of the cell (Baritone may end a build standing where a block still goes), then place from beside it
      await call('goto', { ...at, away: 2, timeoutMs: 15_000 }, 30_000).catch(() => undefined);
      await call('item.select', { name: item });
      r = await attempt();
    }
    if (!r.placed && r.reason === 'too far') {
      await goNear(at, 2).catch(() => undefined);
      await call('item.select', { name: item });
      r = await attempt();
    }
    return r.placed ? undefined : (r.reason ?? 'the server did not accept it');
  };

  const inventoryCounts = async () => {
    const inv = await call<Inventory>('inventory');
    const counts = new Map<string, number>();
    for (const i of inv.items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
    return { inv, counts };
  };
  const gainedText = (before: Map<string, number>, after: Map<string, number>) =>
    [...after].filter(([n, c]) => c > (before.get(n) ?? 0)).map(([n, c]) => `${n} x${c - (before.get(n) ?? 0)}`).join(', ');
  const goNear = (p: Pos, range: number, timeoutMs = 30_000) =>
    call<ProcessResult & { arrived: boolean }>('goto', { ...floorPos(p), range, timeoutMs }, timeoutMs + 15_000);

  /** Walk onto the drops near a broken block (they pop out and may fall a few blocks). */
  const collectDropsNear = async (p: Pos) => {
    const r = await call<{ entities: EntityInfo[] }>('world.entities', { maxDistance: 24, type: 'item' });
    const drops = r.entities.filter(e => Math.hypot(e.position.x - p.x - 0.5, e.position.z - p.z - 0.5) <= 3 &&
      e.position.y - p.y <= 1 && e.position.y - p.y >= -6);
    for (const d of drops.slice(0, 6)) {
      const r = await goNear(d.position, 0, 8000).catch(() => undefined);
      // Baritone has no path to a drop floating in water: swim straight at it when it's close
      if (!r?.arrived) await call('steer', { ...d.position, timeoutMs: 6000 }, 12_000).catch(() => undefined);
    }
  };

  Object.assign(impl, {
    'look-at': async ({ x, y, z }) => {
      await call('look', { x, y, z });
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    },

    'jump': async () => {
      await call('keys', { key: 'jump', ms: 100 });
      return factory.createResponse('Successfully jumped');
    },

    'move-in-direction': async ({ direction, duration = 1000 }) => {
      await call('keys', { key: direction, ms: duration }, Number(duration) + 10_000);
      return factory.createResponse(`Moved ${direction} for ${duration}ms`);
    },

    'equip-item': async ({ itemName, destination = 'hand' }) => {
      try {
        await call('item.equip', { name: itemName, destination });
      } catch (e) {
        if (/^no /.test((e as Error).message)) return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
        throw e;
      }
      return factory.createResponse(`Equipped ${itemName} to ${destination}`);
    },

    'dig-block': async ({ x, y, z, collect = true }) => {
      const p = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const before = (await inventoryCounts()).counts;
      const r = await call<{ dug: boolean; block?: string; tool?: string | null; reason: string; baritone?: string[] }>('dig', { ...p, timeoutMs: 60_000 }, 75_000);
      if (r.reason === 'air' || r.block === undefined) return factory.createResponse(`No block found at position ${fmt(p)}`);
      if (!r.dug) throw new Error(`Could not dig ${r.block} at ${fmt(p)} (${r.reason}).${baritoneSaid(r.baritone ?? [])}`);
      protection.remove(await dimension(), p);
      if (collect) await collectDropsNear(p);
      const gained = gainedText(before, (await inventoryCounts()).counts);
      return factory.createResponse(`Dug ${r.block} at ${fmt(p)}${r.tool ? ` with ${r.tool}` : ''}` +
        (gained ? `. Picked up ${gained}` : collect ? '. Nothing picked up' : ''));
    },

    'place-block': async ({ x, y, z, faceDirection = 'down', item }) => {
      const p = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      if (item) {
        try { await call('item.select', { name: item }); } catch { return factory.createResponse(`No ${item} in inventory to place`); }
      }
      type Placed = { placed: boolean; block?: string; face?: string; reason?: string };
      let r = await call<Placed>('place', { ...p, face: faceDirection });
      if (!r.placed && r.reason === 'too far') {
        await goNear(p, 3);
        r = await call<Placed>('place', { ...p, face: faceDirection });
      }
      if (!r.placed) {
        if (r.reason?.startsWith('occupied by ')) return factory.createResponse(`There's already a block (${r.reason.slice(12)}) at ${fmt(p)}`);
        if (r.reason === 'the bot is standing there') return factory.createResponse(`You can't place a block where you're standing or one block above`);
        return factory.createResponse(`Failed to place block at ${fmt(p)}: ${r.reason ?? 'the server did not accept it'}`);
      }
      protection.add(await dimension(), [p]);
      return factory.createResponse(`Placed ${r.block} at ${fmt(p)} using ${r.face} face`);
    },

    'eat': async ({ item }) => {
      const s = await status();
      if (s.gameMode === 'creative') return factory.createResponse('No need to eat in creative mode');
      const vitals = `Health ${s.health}/20, food ${s.food}/20`;
      const { inv } = await inventoryCounts();
      const foods = foodsFor26();
      let food: string | undefined;
      if (item) {
        food = String(item).replace(/^minecraft:/, '');
        if (!inv.items.some(i => i.name === food)) return factory.createResponse(`No ${food} in inventory`);
        if (!foods[food] && !ALWAYS_EDIBLE.has(food)) return factory.createResponse(`${food} isn't edible`);
      } else {
        food = chooseFood(inv.items as unknown as Item[], foods, s.food ?? 20)?.name;
        if (!food) return factory.createResponse(`Nothing safe to eat in inventory. ${vitals}`);
      }
      if ((s.food ?? 0) >= 20 && !ALWAYS_EDIBLE.has(food)) return factory.createResponse(`Not hungry. ${vitals}`);
      await call('item.select', { name: food });
      const r = await call<{ finished: boolean; food: number; foodBefore: number; health: number; healthBefore: number }>('use', {}, 15_000);
      if (!r.finished) throw new Error(`Could not eat ${food}`);
      return factory.createResponse(`Ate ${food}: food ${r.foodBefore} -> ${r.food}, health ${r.healthBefore} -> ${r.health}`);
    },

    'craft-item': async ({ outputItem, amount = 1 }) => {
      const item = String(outputItem).replace(/^minecraft:/, '');
      type Crafted = { crafted: number; gained: Record<string, number> };
      let r: Crafted;
      try {
        r = await call<Crafted>('craft', { item, count: amount }, 60_000);
      } catch (e) {
        const msg = (e as Error).message;
        if (!msg.startsWith('needs_table')) return factory.createErrorResponse(msg);
        // Baritone walks well, so look further than arm's reach plus a few steps (the mineflayer backend's 16)
        const tables = await call<{ positions: Pos[] }>('world.findBlocks', { block: 'crafting_table', maxDistance: TABLE_SEARCH, count: 1 });
        if (!tables.positions.length) {
          const hasTable = (await call<Inventory>('inventory')).items.some(i => i.name === 'crafting_table');
          return factory.createErrorResponse(`${item} needs a crafting table and there is none within ${TABLE_SEARCH} blocks. ` +
            (hasTable ? 'Place the crafting_table from the inventory nearby, then craft again.' : 'Craft a crafting_table (4 planks), place it nearby, then craft again.'));
        }
        const table = tables.positions[0];
        await goNear(table, 3);
        r = await call<Crafted>('craft', { item, count: amount, ...table }, 60_000);
      }
      if (!r.crafted) return factory.createErrorResponse(`Failed to craft ${item}: nothing was crafted`);
      return factory.createResponse(`Successfully crafted ${item} ${r.crafted} time(s)`);
    },

    'smelt-item': async ({ x, y, z, inputItem, inputCount = 1, fuelItem, fuelCount, takeOutput = true, timeoutMs = 60_000 }) => {
      const at = floorPos({ x: Number(x), y: Number(y), z: Number(z) });
      const block = await call<{ name?: string }>('world.block', { ...at });
      if (!['furnace', 'blast_furnace', 'smoker'].includes(block.name ?? '')) return factory.createResponse(`No furnace at ${fmt(at)}`);
      type Slot = { name: string; count: number } | null;
      type Furnace = { open: boolean; input: Slot; fuel: Slot; output: Slot; lit: boolean };
      let f: Furnace;
      try {
        f = await call<Furnace>('furnace.open', { ...at });
      } catch {
        await goNear(at, 3);
        f = await call<Furnace>('furnace.open', { ...at });
      }
      try {
        const { counts } = await inventoryCounts();
        const input = String(inputItem).replace(/^minecraft:/, '');
        const fuel = String(fuelItem).replace(/^minecraft:/, '');
        if (f.input && f.input.name !== input) return factory.createResponse(`Furnace input slot is occupied by ${f.input.name}`);
        const queued = Math.min(Number(inputCount), counts.get(input) ?? 0) + (f.input?.count ?? 0);
        if (!queued && !f.output) return factory.createResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
        // a lit furnace's leftover burn is not counted: it may be nearly spent (it was, and a log sat unsmelted)
        const stocked = f.fuel ? f.fuel.count * smeltsPerFuel(f.fuel.name) : 0;
        const needed = Math.ceil(Math.max(0, queued - stocked) / smeltsPerFuel(fuel));
        const addFuel = Math.min(needed, fuelCount === undefined ? needed : Number(fuelCount), counts.get(fuel) ?? 0);
        if (needed > 0 && !addFuel && !f.fuel && !f.lit) return factory.createResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
        if (addFuel > 0 && (!f.fuel || f.fuel.name === fuel)) await call('furnace.put', { slot: 'fuel', name: fuel, count: addFuel });
        const putCount = Math.min(Number(inputCount), counts.get(input) ?? 0);
        if (putCount > 0) await call('furnace.put', { slot: 'input', name: input, count: putCount });
        if (!takeOutput) return factory.createResponse(`Started smelting ${putCount} ${input}${addFuel ? ` with ${addFuel} ${fuel}` : ''}`);
        const deadline = Date.now() + Math.max(Number(timeoutMs), queued * 10_500 + 5000);
        let taken = 0;
        let outName = '';
        let unfuelled = 0;
        let left: Slot = null;
        while (Date.now() < deadline) {
          const st = await call<Furnace>('furnace.status');
          if (st.output) {
            const t = await call<{ took: Slot }>('furnace.take');
            if (t.took) { taken += t.took.count; outName = t.took.name; }
          }
          left = st.input;
          if (!st.input && !st.output) break;
          // input waiting with no fuel and no fire: it will never finish (two looks, so a re-light between items isn't mistaken for it)
          unfuelled = st.input && !st.fuel && !st.lit ? unfuelled + 1 : 0;
          if (unfuelled >= 2) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        const smelted = taken ? `Smelted ${taken} ${outName}` : 'Nothing smelted';
        if (unfuelled >= 2 && left) return factory.createResponse(`${smelted}; the furnace ran out of fuel with ${left.count} ${left.name} still in it. Add fuel (smelt-item again with fuelItem).`);
        return taken ? factory.createResponse(smelted) : factory.createResponse(`No output after ${timeoutMs}ms`);
      } finally {
        await call('container.close').catch(() => undefined);
      }
    },

    'fly-to': async () => factory.createErrorResponse('fly-to is not supported on the client backend (Baritone walks; use move-to-position).'),

    // ---- phase 3: combat (the fight loop and reflexes run in the game client, on the tick)

    'attack-entity': async ({ target, maxDistance = 16, timeoutMs = 30_000, minHealth = 6, retreat = true }) => {
      const r = await call<FightResult>('fight', { target: String(target), maxDistance, timeoutMs, minHealth, retreat }, Number(timeoutMs) + 60_000);
      if (r.outcome === 'none') return factory.createResponse(`No ${target} within ${maxDistance} blocks`);
      const swings = r.hits
        ? `${r.hits} swing(s), ${r.landed} landed (${Object.entries(r.swungWith).map(([n, c]) => `${n} x${c}`).join(', ')})`
        : 'no swings';
      const killed = [r.kills.length ? `Killed ${r.kills.join(', ')}` : '', r.vanished.length ? `Gone without dying: ${r.vanished.join(', ')}` : '']
        .filter(Boolean).join('. ');
      const lines: string[] = [];
      if (r.wore.length) lines.push(`Put on ${r.wore.join(', ')}.`);
      switch (r.outcome) {
        case 'done': lines.push(`${killed} with ${swings} in ${r.seconds}s.` + (r.unreachable.length ? ` Couldn't get to ${r.unreachable.join(', ')}.` : '')); break;
        case 'low_health': lines.push(`${killed ? killed + '. ' : ''}Stopped fighting ${r.target} after ${swings}: health is low.` + (r.retreat ? ` Then ${r.retreat}.` : '')); break;
        case 'unreachable': lines.push(`Couldn't get to ${r.unreachable.join(', ')} (no way through, or not getting closer).`); break;
        default: lines.push(`${killed ? killed + '. ' : ''}${r.target} still alive after ${r.seconds}s and ${swings}.`);
      }
      const s = await status();
      lines.push(`Health ${s.health}/20, food ${s.food}/20.`);
      if (r.threats) lines.push(`Hostiles nearby: ${r.threats}.` + (r.outcome === 'low_health' ? ' Wall yourself in or keep away until health recovers.' : ''));
      if (r.kills.length && r.outcome !== 'low_health' && !r.threats) await collectDropsNear(r.dropsAt).catch(() => undefined);
      return factory.createResponse(lines.join(' '));
    },

    'wall-in': async () => {
      const r = await call<{ error?: string; at: Pos; placed: number; alreadySolid: number; gaps: Pos[] }>('wallin', {}, 30_000);
      if (r.error) return factory.createResponse('No blocks to wall in with (dirt, cobblestone, stone, planks, ...)');
      if (!r.gaps.length) return factory.createResponse(`Walled in at ${fmt(r.at)} (${r.placed} block(s) placed). Dig out with dig-block when it's safe.`);
      return factory.createResponse(`Walled in at ${fmt(r.at)} with ${r.gaps.length} gap(s) left at ${r.gaps.map(fmt).join(', ')} (${r.placed} placed).`);
    },

    'set-auto-defend': async ({ enabled }) => {
      await call('guardian.set', { enabled: Boolean(enabled) });
      return factory.createResponse(`Auto-defend ${enabled ? 'on' : 'off'}`);
    }
  } satisfies Record<string, Executor>);

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
      block: z.string().describe("Block to mine, e.g. 'oak_log', 'stone', or several comma-separated: 'iron_ore,deepslate_iron_ore'"),
      count: z.coerce.number().int().positive().optional().describe('How many of the item to have in the inventory when done (default: 1)'),
      timeoutMs: z.number().int().min(1000).optional().describe('Give up after this long (default: 300000)')
    },
    async ({ block, count = 1, timeoutMs = 300_000 }: { block: string; count?: number; timeoutMs?: number }) => {
      const names = block.split(',').map(n => n.trim().replace(/^minecraft:/, '')).filter(Boolean);
      const dim = await dimension();
      let guarded = 0;
      for (const name of names) {
        const near = await call<{ positions: Pos[] }>('world.findBlocks', { block: name, maxDistance: 64, count: 256 });
        guarded += near.positions.filter(p => protection.has(dim, p)).length;
      }
      if (guarded && names.length === 1) return mineAround(names[0], count, timeoutMs, dim, guarded);
      let r: ProcessResult & { gained: Record<string, number> };
      try {
        r = await call<ProcessResult & { gained: Record<string, number> }>('mine', { block, count, timeoutMs }, timeoutMs + 15_000);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.startsWith('needs_tool: ')) return factory.createErrorResponse(msg.slice(12) + '. Craft one first.');
        throw e;
      }
      const gained = Object.entries(r.gained).map(([n, c]) => `${n} x${c}`).join(', ');
      const head = r.reason === 'timeout' ? `Stopped after ${r.seconds}s (time limit)` : `Mined for ${r.seconds}s`;
      return factory.createResponse(`${head}: ${gained || 'nothing gained'}.${baritoneSaid(r.baritone)}`);
    }
  );

  factory.registerTool(
    'build-structure',
    "Build a structure block by block with Baritone (it places blocks from the inventory, clears what's in the way, and scaffolds as needed). Describe it as `spec`: a palette of single characters to blocks and `layers` from the bottom up, each a list of rows along +z whose characters run along +x; '.' is air (cleared, except blocks the bot placed there itself, like a door or furniture), ' ' leaves the cell as it is. Example: {palette:{L:'oak_log[axis=y]',P:'oak_planks'}, layers:[['LPL','P.P','LPL']]}. Or give `file`, a .schem/.litematic path. The structure's minimum corner goes at x,y,z. Checks the inventory has the blocks first (survival).",
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
      let layout: Schematic | undefined;
      if (spec) {
        layout = layoutSpec(spec);
        const s = await status();
        const dim = s.dimension ?? 'overworld';
        const now = await region(origin, layout);
        const box = layout;
        if (s.gameMode !== 'creative') {
          // only what is not standing yet: a second run continues a build
          const before = checkBuild(layout, now);
          protection.add(dim, standing(origin, layout, now)); // what stands of it is the bot's, even if it stops here
          if (!before.total || before.placed === before.total) {
            return factory.createResponse(`${name} is already built at ${fmt(origin)}: all ${before.total} blocks in place.`);
          }
          const { counts: have } = await inventoryCounts();
          const own = (item: string) => (have.get(item) ?? 0) + (before.misplaced[item] ?? 0);
          const missing = Object.entries(before.missing).filter(([item, n]) => own(item) < n)
            .map(([item, n]) => `${item} ${own(item)}/${n}`);
          if (missing.length) return factory.createErrorResponse(`Not enough blocks to build it. Missing: ${missing.join(', ')}`);
        }
        const dir = path.join(options.gameDir, 'schematics');
        fs.mkdirSync(dir, { recursive: true });
        schematicFile = path.join(dir, `${name}.schem`);
        // '.' clears a cell, but not of what the bot placed there itself: a rebuild of the cabin cleared its door and furniture
        const kept = keepExisting(layout, i => !!now[i] && !/^(minecraft:)?(air|cave_air|void_air)$/.test(now[i]!) &&
          protection.has(dim, cellPos(origin, box, i)));
        fs.writeFileSync(schematicFile, writeSchematic(splitDirectional(kept).baritone));
      } else if (file) {
        schematicFile = path.resolve(file);
      } else {
        return factory.createErrorResponse('Give either spec or file');
      }
      const building = call<ProcessResult & { used: Record<string, number> }>('build', { file: schematicFile, ...origin, timeoutMs }, timeoutMs + 15_000);
      // Baritone can stand still for minutes when nothing left is placeable from where it can stand (a log over a
      // doorway, a ridge with no stairs under it yet): when the box hasn't changed for STALL_MS, stop it and finish by hand
      let stalled = false;
      if (layout) {
        const box = layout;
        let done = false;
        void building.finally(() => { done = true; }).catch(() => undefined);
        let last = JSON.stringify(await region(origin, box).catch(() => []));
        let lastChange = Date.now();
        while (!done) {
          await Promise.race([building.catch(() => undefined), new Promise(res => setTimeout(res, STALL_POLL_MS))]);
          if (done) break;
          const now = JSON.stringify(await region(origin, box).catch(() => []));
          if (now !== last) { last = now; lastChange = Date.now(); continue; }
          if (Date.now() - lastChange >= STALL_MS) { stalled = true; await call('cancel').catch(() => undefined); break; }
        }
      }
      const r = await building;
      // tools that went missing broke from wear (digging, fighting): say so instead of listing them as material
      const worn = Object.entries(r.used).filter(([n]) => WEARABLE.test(n));
      const placedItems = Object.entries(r.used).filter(([n]) => !WEARABLE.test(n)).map(([n, c]) => `${n} x${c}`).join(', ');
      const used = [placedItems, worn.length ? `wore out: ${worn.map(([n, c]) => c > 1 ? `${n} x${c}` : n).join(', ')}` : '']
        .filter(Boolean).join('; ');
      if (r.reason === 'paused') {
        return factory.createErrorResponse(`Build paused after ${r.seconds}s (probably out of a block it needs).${baritoneSaid(r.baritone)}`);
      }
      let placedByHand = 0;
      const handFailures: string[] = [];
      if (layout && (r.reason === 'done' || stalled)) {
        // what Baritone skipped (directional blocks) or couldn't get to, placed by hand; passes repeat while they make
        // progress, since a block may only have something to rest against once its neighbour is in
        const failures = new Map<string, string>();
        for (let pass = 0; pass < 4; pass++) {
          const todo = missingCells(layout, await region(origin, layout));
          if (!todo.length) break;
          let progress = 0;
          for (const cell of todo) {
            if (secondHalf(cell.state)) continue; // comes with the lower half / foot
            const at = { x: origin.x + cell.x, y: origin.y + cell.y, z: origin.z + cell.z };
            const why = await placeFacing(at, cell.id, cell.facing ? placerFacing(cell.id, cell.facing) : undefined);
            if (why) failures.set(fmt(at), `${cell.id} at ${fmt(at)}: ${why}`);
            else { failures.delete(fmt(at)); progress++; placedByHand++; }
          }
          if (!progress) break;
        }
        handFailures.push(...failures.values());
      }
      if (layout) {
        // Baritone can call a build done with most of it missing (it did: 19 of 117 blocks), so look at the world
        const finalWorld = await region(origin, layout);
        const check = checkBuild(layout, finalWorld);
        // what stands now is the bot's: mine-blocks leaves it alone
        protection.add(await dimension(), standing(origin, layout, finalWorld));
        if (check.placed < check.total) {
          const inv = await inventoryCounts();
          const missing = Object.entries(check.missing).map(([n, c]) => `${n} x${c} (have ${inv.counts.get(n) ?? 0})`).join(', ');
          const why = r.reason === 'timeout' ? `stopped after ${r.seconds}s (time limit)` : stalled ? `stalled after ${r.seconds}s`
            : r.reason === 'cancelled' ? `was stopped after ${r.seconds}s` : `ended after ${r.seconds}s`;
          const hand = handFailures.length ? ` Couldn't place: ${handFailures.slice(0, 5).join('; ')}.` : '';
          return factory.createErrorResponse(`Build of ${name} ${why} with ${check.placed}/${check.total} blocks in place. ` +
            `Missing: ${missing}. Used: ${used || 'nothing'}.${hand}${baritoneSaid(r.baritone)} Run build-structure again to continue.`);
        }
        const hand = placedByHand ? ` (${placedByHand} placed by hand${stalled ? ' after Baritone stalled' : ''})` : '';
        return factory.createResponse(`Built ${name} at ${fmt(origin)} in ${r.seconds}s: all ${check.total} blocks in place${hand}. Used: ${used || 'nothing'}.${baritoneSaid(r.baritone)}`);
      }
      const head = r.reason === 'timeout' ? `Build stopped after ${r.seconds}s (time limit)` : `Built ${name} at ${fmt(origin)} in ${r.seconds}s`;
      return factory.createResponse(`${head}. Used: ${used || 'nothing'}.${baritoneSaid(r.baritone)}`);
    }
  );

  factory.registerTool(
    'use-item-on-block',
    "Right-click a block, holding `item` if given (else what's in hand): till grass or dirt with a hoe, open or close a door or trapdoor, flip a lever, press a button, use bone meal, fill or empty a bucket. Walks closer if needed. Reports the block before and after.",
    {
      x: z.coerce.number().describe('X of the block'),
      y: z.coerce.number().describe('Y of the block'),
      z: z.coerce.number().describe('Z of the block'),
      item: z.string().optional().describe("Item to hold, e.g. 'wooden_hoe' (default: whatever is in hand)"),
      face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Which face to click (default: 'up')")
    },
    async ({ x, y, z: zz, item, face = 'up' }: { x: number; y: number; z: number; item?: string; face?: string }) => {
      const at = floorPos({ x, y, z: zz });
      if (item) {
        try { await call('item.select', { name: item }); } catch { return factory.createErrorResponse(`No ${item} in inventory`); }
      }
      type Used = { used: boolean; reason?: string; before?: string; after?: string; properties?: Record<string, string>; held?: string; result?: string };
      let r = await call<Used>('useOn', { ...at, face });
      if (!r.used && r.reason === 'too far') {
        await goNear(at, 3);
        if (item) await call('item.select', { name: item });
        r = await call<Used>('useOn', { ...at, face });
      }
      if (!r.used) return factory.createErrorResponse(`Could not use ${item ?? 'the held item'} on ${fmt(at)}: ${r.reason}`);
      const props = Object.entries(r.properties ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
      const after = `${r.after}${props ? `[${props}]` : ''}`;
      return factory.createResponse(r.before === r.after
        ? `Used ${r.held ?? item ?? 'the held item'} on ${r.before} at ${fmt(at)}; it is now ${after} (no change${r.result ? `: ${r.result}` : ''})`
        : `Used ${item ?? 'the held item'} on ${r.before} at ${fmt(at)}: it became ${after}`);
    }
  );

  factory.registerTool(
    'farm',
    'Harvest ripe crops around the bot (wheat, carrots, potatoes, beetroot, sweet berry bushes, melons, pumpkins, cocoa, nether wart) without destroying the plants, and replant with seeds from the inventory. Runs until nothing is left to do or the time limit. Reports what was gathered.',
    {
      range: z.coerce.number().int().min(4).max(128).optional().describe('How far around the bot to farm (default: 32)'),
      timeoutMs: z.number().int().min(5000).optional().describe('Stop after this long (default: 120000)')
    },
    async ({ range = 32, timeoutMs = 120_000 }: { range?: number; timeoutMs?: number }) => {
      const r = await call<ProcessResult & { gained: Record<string, number> }>('farm', { range, timeoutMs }, timeoutMs + 15_000);
      const gained = Object.entries(r.gained).map(([n, c]) => `${n} x${c}`).join(', ');
      const head = r.reason === 'timeout' ? `Farmed for ${r.seconds}s (time limit)` : `Farmed for ${r.seconds}s`;
      return factory.createResponse(`${head}: ${gained || 'nothing ripe to harvest'}.${baritoneSaid(r.baritone)}`);
    }
  );

  factory.registerTool(
    'store-in-chest',
    'Put items from the inventory into a chest (or barrel) at x,y,z, walking to it first. Reports what the chest holds afterwards.',
    {
      x: z.coerce.number().describe('X of the chest'),
      y: z.coerce.number().describe('Y of the chest'),
      z: z.coerce.number().describe('Z of the chest'),
      item: z.string().describe("Item to store, e.g. 'iron_ingot'"),
      count: z.coerce.number().int().positive().optional().describe('How many (default: all of them)')
    },
    async ({ x, y, z: zz, item, count }: { x: number; y: number; z: number; item: string; count?: number }) => {
      const at = floorPos({ x, y, z: zz });
      const name = item.replace(/^minecraft:/, '');
      const have = (await inventoryCounts()).counts.get(name) ?? 0;
      if (!have) return factory.createErrorResponse(`No ${name} in the inventory`);
      const block = await call<{ name?: string }>('world.block', { ...at });
      if (!/chest|barrel/.test(block.name ?? '')) return factory.createErrorResponse(`No chest at ${fmt(at)} (found ${block.name ?? 'nothing'})`);
      type Chest = { slots: number; free: number; items: Record<string, number>; moved?: number };
      try {
        try { await call<Chest>('chest.open', { ...at }); } catch { await goNear(at, 2); await call<Chest>('chest.open', { ...at }); }
        const r = await call<Chest>('chest.deposit', { name, ...(count ? { count } : {}) });
        const holds = Object.entries(r.items).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
        const short = (r.moved ?? 0) < Math.min(count ?? have, have) ? ' (the chest is full)' : '';
        return factory.createResponse(`Stored ${r.moved} ${name} in the chest at ${fmt(at)}${short}. It holds: ${holds}; ${r.free}/${r.slots} slots free.`);
      } finally {
        await call('container.close').catch(() => undefined);
      }
    }
  );

  factory.registerTool(
    'take-from-chest',
    'Take items out of a chest (or barrel) at x,y,z into the inventory, walking to it first. Reports what the chest holds afterwards.',
    {
      x: z.coerce.number().describe('X of the chest'),
      y: z.coerce.number().describe('Y of the chest'),
      z: z.coerce.number().describe('Z of the chest'),
      item: z.string().describe("Item to take, e.g. 'iron_ingot'"),
      count: z.coerce.number().int().positive().optional().describe('How many (default: all of them)')
    },
    async ({ x, y, z: zz, item, count }: { x: number; y: number; z: number; item: string; count?: number }) => {
      const at = floorPos({ x, y, z: zz });
      const name = item.replace(/^minecraft:/, '');
      const block = await call<{ name?: string }>('world.block', { ...at });
      if (!/chest|barrel/.test(block.name ?? '')) return factory.createErrorResponse(`No chest at ${fmt(at)} (found ${block.name ?? 'nothing'})`);
      type Chest = { slots: number; free: number; items: Record<string, number>; moved?: number };
      try {
        let opened: Chest;
        try { opened = await call<Chest>('chest.open', { ...at }); } catch { await goNear(at, 2); opened = await call<Chest>('chest.open', { ...at }); }
        const inside = opened.items[name] ?? 0;
        if (!inside) return factory.createErrorResponse(`The chest at ${fmt(at)} has no ${name}. It holds: ${Object.entries(opened.items).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing'}`);
        const r = await call<Chest>('chest.withdraw', { name, ...(count ? { count } : {}) });
        const holds = Object.entries(r.items).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
        const short = (r.moved ?? 0) < Math.min(count ?? inside, inside) ? ' (the inventory is full)' : '';
        return factory.createResponse(`Took ${r.moved} ${name} from the chest at ${fmt(at)}${short}. It holds: ${holds}.`);
      } finally {
        await call('container.close').catch(() => undefined);
      }
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
