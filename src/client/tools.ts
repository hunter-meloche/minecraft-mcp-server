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
  timeOfDay?: number; process?: string | null; goal?: string | null;
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
      const guard = await call<{ enabled: boolean; armor: string[] }>('guardian.status');
      return factory.createResponse([
        `Health ${s.health}/20, food ${s.food}/20, saturation ${s.saturation}`,
        timeLine(s.timeOfDay ?? 0),
        `Dimension ${s.dimension}, game mode ${s.gameMode}, difficulty ${s.difficulty}`,
        `Armor: ${guard.armor.length ? guard.armor.join(', ') : 'none'}; auto-defend ${guard.enabled ? 'on' : 'off'}`,
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

  // ---- phase 2: interaction

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
    for (const d of drops.slice(0, 6)) await goNear(d.position, 0, 8000).catch(() => undefined);
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
        const tables = await call<{ positions: Pos[] }>('world.findBlocks', { block: 'crafting_table', maxDistance: 16, count: 1 });
        if (!tables.positions.length) {
          const hasTable = (await call<Inventory>('inventory')).items.some(i => i.name === 'crafting_table');
          return factory.createErrorResponse(`${item} needs a crafting table and there is none within 16 blocks. ` +
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
        const stocked = (f.fuel ? f.fuel.count * smeltsPerFuel(f.fuel.name) : 0) + (f.lit ? 1 : 0);
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
        while (Date.now() < deadline) {
          const st = await call<Furnace>('furnace.status');
          if (st.output) {
            const t = await call<{ took: Slot }>('furnace.take');
            if (t.took) { taken += t.took.count; outName = t.took.name; }
          }
          if (!st.input && !st.output) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        return taken ? factory.createResponse(`Smelted ${taken} ${outName}`) : factory.createResponse(`No output after ${timeoutMs}ms`);
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
