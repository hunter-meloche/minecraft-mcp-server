import test from 'ava';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import minecraftData from 'minecraft-data';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { MessageStore } from '../../src/message-store.js';
import { registerClientTools, type InventoryItem } from '../../src/client/tools.js';
import type { BridgeClient } from '../../src/client/bridge-client.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { prepareBill } from '../../src/client/brain/project.js';
import { RECIPES, recipeFor } from '../../src/client/brain/progress.js';
import { BED, liveWorld, lookAt } from '../helpers/homestead.js';

/**
 * Leads crafted the way the kit and the shears are made: prepareBill, through the real client tools (craft-item,
 * take-from-chest) to a bridge that answers as the game client's does (Interact.java `craft`: the recipe book, the
 * 2x2 grid or a crafting table within reach, the ingredients the inventory holds; the chests opened within reach),
 * with the game's own recipes (minecraft-data 26.3, as the game's data/minecraft/recipe/*.json have them). Live
 * (brain.log 2026-11-13 16:35Z): `cow: no lead to be had (none carried or stored, and none would craft)` with 15
 * string and 9 slime balls stored: the brain's table had the old lead (4 string and a slime ball), the game's takes
 * five string, and the craft took the 4 out and failed for want of a fifth.
 */

type Recipe = { inShape?: (number | null)[][]; ingredients?: (number | null)[]; result: { count: number } };
const data = minecraftData('26.3') as unknown as { itemsByName: Record<string, { id: number }>; items: Record<number, { name: string }>; recipes: Record<number, Recipe[]> };

/** The game's recipes for an item: what each takes (by item name), what it makes, and whether it fits the 2x2 grid. */
function gameRecipes(item: string): { need: Map<string, number>; makes: number; grid: boolean }[] {
  return (data.recipes[data.itemsByName[item]?.id ?? -1] ?? []).map(r => {
    const need = new Map<string, number>();
    for (const id of [...(r.inShape?.flat() ?? []), ...(r.ingredients ?? [])]) {
      if (id === null || id === undefined) continue;
      const n = data.items[id].name;
      need.set(n, (need.get(n) ?? 0) + 1);
    }
    // a shaped one by the box its cells fill (Interact.fitsInventoryGrid: width and height up to 2); a shapeless one
    // by its count of ingredients (up to 4)
    const cells = (r.inShape ?? []).flatMap((row, y) => row.flatMap((id, x) => (id === null || id === undefined ? [] : [{ x, y }])));
    const span = (k: 'x' | 'y') => (cells.length ? Math.max(...cells.map(c => c[k])) - Math.min(...cells.map(c => c[k])) + 1 : 0);
    const grid = r.inShape ? span('x') <= 2 && span('y') <= 2 : (r.ingredients ?? []).length <= 4;
    return { need, makes: r.result.count, grid };
  });
}

/** item -> the items whose recipes take it: what holding it unlocks in the recipe book */
let unlocks: Map<string, Set<string>> | undefined;
function unlockedBy(name: string): Set<string> {
  if (!unlocks) {
    unlocks = new Map();
    for (const item of Object.keys(data.itemsByName)) {
      for (const r of gameRecipes(item)) for (const n of r.need.keys()) (unlocks.get(n) ?? unlocks.set(n, new Set()).get(n)!).add(item);
    }
  }
  return unlocks.get(name) ?? new Set();
}

const k = (p: Pos) => `${p.x},${p.y},${p.z}`;
const TABLE: Pos = { x: -543, y: 63, z: 2193 };
const DROPS: Pos = { x: -547, y: 65, z: 2179 };
const GEAR: Pos = { x: -547, y: 64, z: 2182 };

/**
 * The game client as the bridge answers for it, over the live homestead's chests and its table. `pos` is the bot's
 * feet; the reach for a chest or the table is 4.5 from its eyes (Interact.java), a goto ends within its range.
 */
class Client {
  pos: { x: number; y: number; z: number };
  inv = new Map<string, number>();
  chests: Record<string, Record<string, number>>;
  /** recipes the recipe book shows: the game unlocks each for holding one of its ingredients (lead: has_string) */
  book = new Set<string>();
  open?: string;
  log: string[] = [];

  constructor(world: WorldMemory, at: Pos, items: Record<string, number> = {}) {
    this.pos = { x: at.x + 0.5, y: at.y, z: at.z + 0.5 };
    this.chests = structuredClone(world.chestItems ?? {});
    for (const [n, c] of Object.entries(items)) this.add(n, c);
  }

  add(name: string, n: number) {
    this.inv.set(name, (this.inv.get(name) ?? 0) + n);
    for (const item of unlockedBy(name)) this.book.add(item);
  }
  take(name: string, n: number) {
    const left = (this.inv.get(name) ?? 0) - n;
    if (left > 0) this.inv.set(name, left); else this.inv.delete(name);
  }
  reach(p: Pos) {
    return Math.hypot(this.pos.x - p.x - 0.5, this.pos.y + 1.62 - p.y - 0.5, this.pos.z - p.z - 0.5) <= 4.5;
  }

  /** Interact.craft: the recipe book's recipes for the item, the first the inventory can fill (and the grid holds) */
  craft(item: string, count: number, table?: Pos): { crafted: number; gained: Record<string, number> } {
    const known = this.book.has(item) ? gameRecipes(item) : [];
    if (!known.length) throw new Error(`no recipe for ${item} in the recipe book (unlocked by holding one of its ingredients)`);
    const can = (r: { need: Map<string, number> }) => [...r.need].every(([n, c]) => (this.inv.get(n) ?? 0) >= c);
    const chosen = known.find(r => can(r) && (table || r.grid));
    if (!chosen) {
      if (known.some(can) && !table) throw new Error(`needs_table: ${item} needs a crafting table`);
      throw new Error(`missing ingredients for ${item}`);
    }
    if (table && !this.reach(table)) throw new Error('crafting table too far');
    if (table && k(table) !== k(TABLE)) throw new Error('the crafting table did not open');
    let done = 0;
    while (done < count && can(chosen)) {
      for (const [n, c] of chosen.need) this.take(n, c);
      this.add(item, chosen.makes);
      done++;
    }
    this.log.push(`craft ${item} x${done}${table ? ` at ${k(table)}` : ''}`);
    return { crafted: done, gained: { [item]: done * chosen.makes } };
  }

  answer(method: string, p: Record<string, unknown>): unknown {
    const at = (): Pos => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) });
    switch (method) {
      case 'inventory':
        return { items: [...this.inv].map(([name, count], slot): InventoryItem => ({ slot, name, count })), selectedSlot: 0, held: null };
      case 'world.block':
        return { loaded: true, name: this.chests[k(at())] ? 'chest' : k(at()) === k(TABLE) ? 'crafting_table' : 'air' };
      case 'world.findBlocks': {
        const near = p.block === 'crafting_table' && Math.hypot(this.pos.x - TABLE.x, this.pos.z - TABLE.z) <= Number(p.maxDistance);
        return { positions: near ? [{ ...TABLE }] : [] };
      }
      case 'goto': {
        // Baritone's walk: to within its range of the target, on the yard's ground (feet at 63)
        const dx = this.pos.x - Number(p.x) - 0.5, dz = this.pos.z - Number(p.z) - 0.5;
        const d = Math.hypot(dx, dz) || 1;
        const r = Math.min(d, Number(p.range ?? 0));
        this.pos = { x: Number(p.x) + 0.5 + (dx / d) * r, y: 63, z: Number(p.z) + 0.5 + (dz / d) * r };
        this.log.push(`goto ${k(at())}`);
        return { arrived: true, reason: 'done', seconds: 2, baritone: [], at: { x: Math.floor(this.pos.x), y: 63, z: Math.floor(this.pos.z) }, distance: r };
      }
      case 'chest.open': {
        if (!this.reach(at()) || !this.chests[k(at())]) throw new Error('chest too far to open');
        this.open = k(at());
        return { slots: 27, free: 20, items: { ...this.chests[this.open] } };
      }
      case 'chest.withdraw': {
        const c = this.chests[this.open!];
        const name = String(p.name);
        const moved = Math.min(Number(p.count ?? c[name] ?? 0), c[name] ?? 0);
        c[name] -= moved;
        if (!c[name]) delete c[name];
        this.add(name, moved);
        this.log.push(`withdraw ${moved} ${name} from ${this.open}`);
        return { slots: 27, free: 20, items: { ...c }, moved };
      }
      case 'container.close':
        this.open = undefined;
        return {};
      case 'craft':
        return this.craft(String(p.item), Number(p.count ?? 1), p.x === undefined ? undefined : at());
      default:
        throw new Error(`unexpected bridge call ${method}`);
    }
  }
}

/** The real client tools over the fake client, and a brain context whose act and call go through them as brain.ts's do. */
function rig(world: WorldMemory, client: Client): GoalContext {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const connection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) };
  const request = async (method: string, params: Record<string, unknown> = {}) => client.answer(method, params);
  const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-leads-'));
  const rt = registerClientTools(new ToolFactory(server, connection), { request } as unknown as BridgeClient, new MessageStore(), { gameDir });
  return {
    s: lookAt([], 0, { position: { ...BED } }), world, signal: new AbortController().signal,
    act: async (tool, args = {}) => {
      const r = await rt.actions[tool](args);
      return { ok: !r.isError, text: r.content.map(c => (c as { text?: string }).text ?? '').join(' ') };
    },
    call: rt.call, status: rt.status, progress: () => undefined, gain: () => undefined
  };
}

/** The live homestead as it stood at 16:35Z: no lead stored (both were out on cows), 14 string and 9 slime balls in drops1. */
function noLeads(): WorldMemory {
  const world = liveWorld();
  delete world.chestItems![k(GEAR)].lead;
  return world;
}

test('every recipe the brain makes things by is one the game has (minecraft-data 26.3): the lead is five string, no slime ball', (t) => {
  // the brain's any-wood planks and logs, coal or charcoal, and the cobblestone kinds stand for the game's variants
  const norm = (n: string) => (/_planks$/.test(n) ? 'planks' : /_log$/.test(n) ? 'log' : n === 'charcoal' ? 'coal' : n === 'cobbled_deepslate' || n === 'blackstone' ? 'cobblestone' : n);
  const sameAs = (from: Record<string, number>, makes: number) => (r: { need: Map<string, number>; makes: number }) => {
    const need: Record<string, number> = {};
    for (const [n, c] of r.need) need[norm(n)] = (need[norm(n)] ?? 0) + c;
    return r.makes === makes && JSON.stringify(Object.entries(need).sort()) === JSON.stringify(Object.entries(from).map(([n, c]) => [norm(n), c]).sort());
  };
  for (const [item, r] of Object.entries(RECIPES)) {
    const name = item === 'planks' ? 'oak_planks' : item;
    const own = recipeFor(name)!;
    t.true(gameRecipes(name).some(sameAs(own.from, own.makes)), `${item}: the brain has ${JSON.stringify(r)}, the game ${JSON.stringify(gameRecipes(name).map(g => [Object.fromEntries(g.need), g.makes]))}`);
  }
  t.deepEqual(recipeFor('lead'), { makes: 2, from: { string: 5 } });
  // and it is the table's: 3x3, not the inventory's 2x2
  t.false(gameRecipes('lead')[0].grid);
});

test('the live case: no lead stored, two crafted at the home table from five of the string in drops1, the slime balls left be', async (t) => {
  const world = noLeads();
  // just up from the bed, nothing carried that a lead is made of
  const client = new Client(world, BED);
  const short = await prepareBill(rig(world, client), { lead: 2 }, { record: false });
  t.deepEqual(short, {});
  t.is(client.inv.get('lead'), 2);
  t.is(client.inv.get('string'), undefined);
  t.is(client.inv.get('slime_ball'), undefined);
  // to drops1 for the string, the grid says the table, to the table, crafted there
  t.deepEqual(client.log, [`goto ${k(DROPS)}`, `withdraw 5 string from ${k(DROPS)}`, `goto ${k(TABLE)}`, `craft lead x1 at ${k(TABLE)}`]);
  t.like(client.chests[k(DROPS)], { string: 9, slime_ball: 9 });
  // the memory of the chest is the chest's reply
  t.like(world.chestItems![k(DROPS)], { string: 9, slime_ball: 9 });
  t.is(world.progress?.need?.lead, undefined, 'a pens run keeps its shortfall off the project\'s (record: false)');
});

test('what failed live: 4 string and a slime ball carried make no lead in the game, and the tool says it is a string short', async (t) => {
  const world = noLeads();
  const client = new Client(world, TABLE, { string: 4, slime_ball: 1 });
  const r = await rig(world, client).act('craft-item', { outputItem: 'lead', amount: 1 });
  t.deepEqual(r, { ok: false, text: 'Failed: missing ingredients for lead: needs string x1 (have 4)' });
  t.is(client.inv.get('lead'), undefined);
  // with the fix the same pockets need one more string, and it comes from drops1
  const short = await prepareBill(rig(world, client), { lead: 2 }, { record: false });
  t.deepEqual(short, {});
  t.is(client.inv.get('lead'), 2);
  t.is(client.inv.get('slime_ball'), 1);
  t.true(client.log.includes(`withdraw 1 string from ${k(DROPS)}`));
});

test('string a build job holds is not taken for leads: with only four free none is made, and the job\'s stays in the chest', async (t) => {
  const world = noLeads();
  world.reserved = { 7: { string: 10 } };
  const client = new Client(world, BED);
  const short = await prepareBill(rig(world, client), { lead: 2 }, { record: false });
  t.deepEqual(short, { string: 1 });
  t.is(client.inv.get('lead'), undefined);
  t.false(client.log.some(l => l.startsWith('craft')), client.log.join('\n'));
  t.is(client.chests[k(DROPS)].string, 10);
  t.is(client.chests[k(DROPS)].slime_ball, 9);
});

test('one lead carried: one more craft makes three, and leads carried or stored are used before any string', async (t) => {
  const world = noLeads();
  const one = new Client(world, BED, { lead: 1 });
  t.deepEqual(await prepareBill(rig(world, one), { lead: 2 }, { record: false }), {});
  t.is(one.inv.get('lead'), 3);
  t.is(one.chests[k(DROPS)].string, 9);
  // a lead in the chests: taken, nothing crafted
  const stored = liveWorld();
  const two = new Client(stored, BED);
  t.deepEqual(await prepareBill(rig(stored, two), { lead: 2 }, { record: false }), {});
  t.is(two.inv.get('lead'), 2);
  t.false(two.log.some(l => l.startsWith('craft')));
  t.is(two.chests[k(DROPS)].string, 14);
});
