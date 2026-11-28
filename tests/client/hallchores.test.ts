import test, { type ExecutionContext } from 'ava';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Seen } from '../../src/client/brain/village.js';
import {
  BREAD_EACH, BREAD_PER_BABY, BREED_BACKOFF, BREED_WAIT, CHORE_FAIL_WAIT, EMERALD_TARGET, FLETCHER_ROLLS_A_DAY, HALL_ADULTS, HALL_BEDS_WANTED, HALL_WAITS, LECTERN_WAIT, LECTERN_WAITS, MENDING_SPARE,
  RESTOCK_WAIT, ROLLS_A_DAY, ROLLS_A_RUN, booksOffered, chorePlan, hallBeds, hallChoresGoal, hallChoresOf, hallChoresText, hallInSight, hallVillagers, headcount,
  hallSites, mendingOffer, mendingWanted, moreBedCells, noteHall, stickOffer, sticksThere, throughLock, type Chore, type TradeOffer
} from '../../src/client/brain/hallchores.js';
import { inHallOrLock, openByDesign, peekFetch, type FetchMemory, type Trip, type Ward } from '../../src/client/brain/fetch.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { lockOf } from '../../src/client/brain/villagerwalk.js';
import { strictSet } from '../../src/client/brain/yardgates.js';
import { brainRun } from '../../src/client/tools.js';
import { H as LIVE_H, P as LIVE_P, isOpen, yard, type Pasture, type Villager } from '../helpers/pasture.js';
import { anvilPlan } from '../../src/client/brain/anvil.js';
import { KEEP } from '../../src/client/brain/community.js';
import { RECIPES } from '../../src/client/brain/progress.js';
import { villagersLine } from '../../src/client/brain/village.js';
import type { InventoryItem, ItemEnchantment } from '../../src/client/tools.js';
import { liveWorld, lookAt, realGoals } from '../helpers/homestead.js';

/**
 * The villager chores (P5d of the progression plan, hallchores.ts) over a stand-in hall that answers as the bridge does:
 * world.entities lists the villagers with their job and level (Merchant.describe), trade.open/status/do/close as
 * Merchant.java (a trade.do names its result; a look never trades), item.toss throws to a point, dig.here digs a block,
 * place-block puts one down. The villagers take a free job site at the next look and lose theirs once it is gone while
 * they have never traded (26.3 ResetProfession: xp 0, level 1); a site put down again makes new offers, drawn from a
 * list as the game draws them from its random sequence. Shaped like the live hall (brain.json Nov 18): 11 x 9 at
 * (-561, 62, 2126), its gate south (-556, 63, 2134), the panel north (-556, 63-64, 2126), three white beds along the
 * north wall (heads (-560..-558, 63, 2127)), the lectern's cell (-553, 63, 2127) empty, the fletching table
 * (-552, 63, 2127), torches (-560, 63, 2133) and (-552, 63, 2133).
 */

HALL_WAITS.pollMs = 0;
HALL_WAITS.dropMs = 0;
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 18, 15, 0, 0);
const HOME = { x: -549, y: 63, z: 2183 };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const HALL = { x: -561, y: 62, z: 2126, width: 11, length: 9 };
const LECTERN: Pos = { x: -553, y: 63, z: 2127 };
const FLETCHING: Pos = { x: -552, y: 63, z: 2127 };
const GATE: Pos = { x: -556, y: 63, z: 2134 };
const INSIDE: Pos = { x: -556, y: 63, z: 2130 };
const k = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

function hallWorld(over: Partial<WorldMemory> = {}): WorldMemory {
  return {
    landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD }, chestItems: {}, lastDone: {},
    zones: {
      hall: [{ ...HALL }], 'hall:gate': [{ ...GATE }], 'hall:inside': [{ ...INSIDE }],
      'hall:panel': [{ x: -556, y: 63, z: 2126 }, { x: -556, y: 64, z: 2126 }],
      'hall:bed': [{ x: -560, y: 63, z: 2127 }, { x: -559, y: 63, z: 2127 }, { x: -558, y: 63, z: 2127 }],
      'hall:bed-foot': [{ x: -560, y: 63, z: 2128 }, { x: -559, y: 63, z: 2128 }, { x: -558, y: 63, z: 2128 }],
      'hall:lectern': [{ ...LECTERN }], 'hall:fletching': [{ ...FLETCHING }],
      'hall:torch': [{ x: -560, y: 63, z: 2133 }, { x: -552, y: 63, z: 2133 }]
    },
    progress: { done: ['hall'], journal: [] },
    idle: { today: { day: 7 }, days: [] },
    ...over
  } as WorldMemory;
}

const countsOf = (items: InventoryItem[]) => {
  const counts = new Map<string, number>();
  for (const i of items) if (i.slot < 36) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return counts;
};
const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => ({
  now: T0, timeOfDay: 2000, activity: 'work', health: 20, food: 20, position: { x: -555, y: 63, z: 2150 }, dimension: 'overworld', sleeping: false,
  raining: false, thundering: false, process: null, items, counts: countsOf(items), slotsUsed: items.filter(i => i.slot < 36).length,
  home: { ...HOME, dimension: 'overworld' }, distHome: 33, ...over
});

type V = { id: number; baby?: boolean; profession: string; level?: number; xp?: number; at: { x: number; y: number; z: number }; offers?: TradeOffer[]; bread?: number };
const villager = (id: number, profession = 'none', at = { x: -556.5, y: 63, z: 2131.5 }, over: Partial<V> = {}): V => ({ id, profession, at, level: 1, xp: 0, ...over });
const seenOf = (v: V): Seen => ({ id: v.id, name: 'villager', position: { ...v.at }, baby: !!v.baby, profession: v.profession, level: v.level ?? 1 });

const book = (index: number, enchantments: ItemEnchantment[], price: number): TradeOffer => ({
  index, costA: { name: 'emerald', count: price }, costB: { name: 'book', count: 1 }, result: { name: 'enchanted_book', count: 1, enchantments }, uses: 0, maxUses: 12, outOfStock: false
});
const paper = (index: number): TradeOffer => ({ index, costA: { name: 'paper', count: 24 }, costB: null, result: { name: 'emerald', count: 1 }, uses: 0, maxUses: 16, outOfStock: false });
const shelf = (index: number): TradeOffer => ({ index, costA: { name: 'emerald', count: 9 }, costB: null, result: { name: 'bookshelf', count: 1 }, uses: 0, maxUses: 12, outOfStock: false });
const sticks = (index: number, uses = 0): TradeOffer => ({ index, costA: { name: 'stick', count: 32 }, costB: null, result: { name: 'emerald', count: 1 }, uses, maxUses: 16, outOfStock: uses >= 16 });
const arrows = (index: number): TradeOffer => ({ index, costA: { name: 'emerald', count: 1 }, costB: null, result: { name: 'arrow', count: 16 }, uses: 0, maxUses: 12, outOfStock: false });
const flint = (index: number): TradeOffer => ({ index, costA: { name: 'gravel', count: 10 }, costB: { name: 'emerald', count: 1 }, result: { name: 'flint', count: 10 }, uses: 0, maxUses: 12, outOfStock: false });

/**
 * The stand-in hall: the villagers, the blocks of the job sites and the beds, the pockets. `librarians` and `fletchers`:
 * the offers a lectern or a fletching table makes each time a villager takes it, in turn. `strict`: as the real game
 * and Baritone do it: a dug block's drop lies in its cell until the bot stands there (dig.here answers before the
 * server's drop, which waits out its pickup delay), a goto already within its range stays put (GoalNear; range 0 is the
 * cell itself), and place-block refuses the bot's own cell and the one over its head (Interact.java, tools.ts).
 * `refuse`: that many place-blocks the server does not take (a villager in the cell), before the rest go down.
 * `stuck`: the bridge's own click (useOn) on the gate does nothing (something holds it open).
 */
function hallAt(world: WorldMemory, villagers: V[], items: InventoryItem[], opts: { librarians?: TradeOffer[][]; fletchers?: TradeOffer[][]; keepsJob?: boolean; strict?: boolean; refuse?: number; stuck?: boolean } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const blocks = new Map<string, string>([[k(FLETCHING), 'fletching_table'], [k(GATE), 'oak_fence_gate[facing=south,open=false]']]);
  for (const b of hallBeds(world)) { blocks.set(k(b.head), 'white_bed[part=head]'); blocks.set(k(b.foot), 'white_bed[part=foot]'); }
  // a librarian there already has its lectern
  if (villagers.some(v => v.profession === 'librarian')) blocks.set(k(LECTERN), 'lectern');
  const libs = [...(opts.librarians ?? [])], flets = [...(opts.fletchers ?? [])];
  let open: V | undefined;
  let here = { x: -555.5, y: 63, z: 2150.5 };
  const drops = new Map<string, string>();
  const cellOf = () => ({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) });
  const at = (slot: number) => items.find(i => i.slot === slot);
  const ORDER = [...[...Array(27).keys()].map(n => n + 9), ...Array(9).keys()];
  const give = (name: string, count: number, enchantments?: ItemEnchantment[]) => {
    const onto = !enchantments && items.find(i => i.slot < 36 && i.name === name && !i.enchantments && i.count + count <= 64);
    if (onto) { onto.count += count; return; }
    const slot = ORDER.find(n => !at(n));
    if (slot === undefined) throw new Error('inventory full');
    items.push({ slot, name, count, ...(enchantments ? { enchantments } : {}) });
  };
  const take = (name: string, count: number) => {
    let left = count;
    for (const i of items.filter(x => x.slot < 36 && x.name === name)) {
      const n = Math.min(left, i.count);
      i.count -= n;
      left -= n;
      if (!i.count) items.splice(items.indexOf(i), 1);
      if (!left) break;
    }
    if (left) throw new Error(`no ${name} left`);
  };
  // a job site taken or lost at a look, as the villagers' AI does between two looks
  const settleJobs = () => {
    for (const [cell, job, offers] of [[LECTERN, 'librarian', libs], [FLETCHING, 'fletcher', flets]] as const) {
      const site = blocks.get(k(cell)) === (job === 'librarian' ? 'lectern' : 'fletching_table');
      const holder = villagers.find(v => v.profession === job);
      if (!site && holder && !opts.keepsJob && !(holder.xp ?? 0) && (holder.level ?? 1) <= 1) { holder.profession = 'none'; delete holder.offers; }
      if (site && !villagers.some(v => v.profession === job)) {
        const free = villagers.find(v => !v.baby && v.profession === 'none');
        if (free) { free.profession = job; free.offers = offers.shift() ?? []; }
      }
    }
  };
  const ctx = {
    s: snap(items), world, signal: new AbortController().signal,
    progress: (x: string) => { lines.push(x); }, gain: () => undefined, save: () => undefined,
    status: async () => ({ inWorld: true, position: { ...here }, dimension: 'overworld' }),
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'world.entities') { settleJobs(); return { entities: villagers.map(seenOf) }; }
      if (m === 'inventory') return { items: items.map(i => ({ ...i })), held: { name: 'diamond_sword' } };
      if (m === 'goto') {
        calls.push(`goto ${p.x},${p.y},${p.z}`);
        const c = cellOf(), range = Number(p.range ?? 1);
        if (opts.strict && Math.hypot(c.x - Number(p.x), c.y - Number(p.y), c.z - Number(p.z)) <= range) return { arrived: true };
        here = { x: Number(p.x) + 0.5, y: Number(p.y), z: Number(p.z) + 0.5 };
        const drop = drops.get(k(cellOf()));
        if (drop) { drops.delete(k(cellOf())); give(drop, 1); }
        return { arrived: true };
      }
      if (m === 'world.region') return { blocks: [blocks.get(k(p as unknown as Pos)) ?? 'minecraft:air'] };
      if (m === 'useOn') {
        // the bridge's own click, from where the bot stands: a gate is toggled
        const b = blocks.get(k(p as unknown as Pos));
        calls.push(`useOn ${k(p as unknown as Pos)}`);
        if (b && !opts.stuck) blocks.set(k(p as unknown as Pos), /open=true/.test(b) ? b.replace('open=true', 'open=false') : b.replace('open=false', 'open=true'));
        return { used: true };
      }
      if (m === 'item.toss') {
        const to = p.toward as Pos;
        const v = villagers.find(q => q.at.x === to.x && q.at.z === to.z);
        calls.push(`item.toss ${String(p.name)} x${String(p.count)} to ${v?.id ?? '?'}`);
        take(String(p.name), Number(p.count));
        if (v) v.bread = (v.bread ?? 0) + Number(p.count);
        return { tossed: Number(p.count) };
      }
      if (m === 'dig.here') {
        calls.push(`dig.here ${k(p as unknown as Pos)}`);
        const b = blocks.get(k(p as unknown as Pos));
        if (!b) return { dug: false, reason: 'air' };
        blocks.delete(k(p as unknown as Pos));
        if (opts.strict) drops.set(k(p as unknown as Pos), b.replace(/\[.*$/, ''));
        else give(b.replace(/\[.*$/, ''), 1);
        return { dug: true, block: b };
      }
      if (m === 'trade.open') {
        const v = villagers.find(q => q.id === p.id);
        if (!v || v.baby || v.profession === 'none') throw new Error('the villager shook its head');
        open = v;
        calls.push(`trade.open ${v.id} (${v.profession})`);
        return { open: true, level: v.level ?? 1, xp: v.xp ?? 0, offers: (v.offers ?? []).map(o => ({ ...o })), id: v.id, profession: v.profession };
      }
      if (m === 'trade.do') {
        if (!open) throw new Error('no trade screen open');
        const o = open.offers![Number(p.index)];
        calls.push(`trade.do ${open.id} ${String(p.index)} x${String(p.times)} ${String(p.result)}${p.enchantment ? ` ${String(p.enchantment)}` : ''}`);
        if (p.result && o.result?.name !== p.result) throw new Error('not the result asked for: nothing traded');
        const times = Math.min(Number(p.times ?? 1), o.maxUses - o.uses);
        for (let i = 0; i < times; i++) {
          take(o.costA!.name, o.costA!.count);
          if (o.costB) take(o.costB.name, o.costB.count);
          give(o.result!.name, o.result!.count, o.result!.enchantments);
        }
        o.uses += times;
        open.xp = (open.xp ?? 0) + times;
        const spent: Record<string, number> = { [o.costA!.name]: o.costA!.count * times };
        // (Merchant.java Run.step: "done" once every trade asked for went, the last use among them; "out of stock" only
        // when asked past the uses left; the offer as it stands with the screen still open)
        const stopped = times >= Number(p.times ?? 1) ? 'done' : `out of stock (${o.uses}/${o.maxUses} uses)`;
        return { ok: times > 0, traded: times, count: times * o.result!.count, spent, stopped, open: true, offer: { ...o, outOfStock: o.uses >= o.maxUses }, level: open.level, xp: open.xp };
      }
      if (m === 'trade.close') { open = undefined; calls.push('trade.close'); return { ok: true }; }
      return {};
    }) as GoalContext['call'],
    act: (async (tool: string, p: Record<string, unknown> = {}) => {
      if (tool === 'place-block') {
        calls.push(`place-block ${String(p.item)} ${k(p as unknown as Pos)}`);
        const c = cellOf();
        if (opts.strict && c.x === Number(p.x) && c.z === Number(p.z) && (c.y === Number(p.y) || c.y + 1 === Number(p.y))) {
          calls.push('place-block refused: standing there');
          return { ok: true, text: 'You can\'t place a block where you\'re standing or one block above' };
        }
        if (opts.refuse && opts.refuse-- > 0) return { ok: true, text: `Failed to place block at (${p.x}, ${p.y}, ${p.z}): the server did not accept it` };
        take(String(p.item), 1);
        blocks.set(k(p as unknown as Pos), String(p.item));
        return { ok: true, text: `Placed minecraft:${String(p.item)} at (${p.x}, ${p.y}, ${p.z})` };
      }
      if (tool === 'build-structure') {
        const spec = p.spec as { palette: Record<string, string> };
        calls.push(`build-structure ${p.x},${p.y},${p.z} ${spec.palette.H}`);
        take(spec.palette.H.replace(/\[.*$/, ''), 1);
        return { ok: true, text: 'all 2 blocks in place' };
      }
      calls.push(`${tool} ${JSON.stringify(p)}`);
      return { ok: true, text: 'ok' };
    }) as GoalContext['act']
  } as unknown as GoalContext;
  return { ctx, calls, lines, blocks, villagers, items, drops };
}

/** Every call that could hit a villager: none is ever made (no attack, no use with a weapon on one). */
const NO_HIT = (calls: string[]) => calls.filter(c => /(^|[^a-z])(attack|hit|swing|combat|kill)/i.test(c));

// ------------------------------------------------------------------------------------------------ the rules, held to the jar

test('the jar\'s numbers: 3 bread a willing villager (4 points each of 12), a baby needs a bed of its own, 5 beds for 4 adults and a free one, the lectern of 4 slabs and a bookshelf, the emeralds the donations keep', (t) => {
  t.is(BREAD_EACH * 4, 12, 'Villager.BREEDING_FOOD_THRESHOLD 12; bread\'s villager_food 4');
  t.is(BREAD_PER_BABY, 6);
  t.is(HALL_ADULTS, 4);
  t.is(HALL_BEDS_WANTED, 5);
  t.is(ROLLS_A_DAY, 30);
  t.is(MENDING_SPARE, 2);
  // data/minecraft/recipe/lectern.json: SSS / B / S of #wooden_slabs and a bookshelf
  t.deepEqual(RECIPES.lectern, { makes: 1, from: { oak_slab: 4, bookshelf: 1 } });
  // data/minecraft/recipe/fletching_table.json: @@ / ## / ## of flint and #planks
  t.deepEqual(RECIPES.fletching_table, { makes: 1, from: { flint: 2, planks: 4 } });
  t.is(EMERALD_TARGET, KEEP.emerald.keep);
});

// ------------------------------------------------------------------------------------------------ inert with an empty hall

test('inert with an empty hall: no census, or none in it, and the goal never wants; a run that finds it empty does nothing but look', async (t) => {
  const items: InventoryItem[] = [{ slot: 0, name: 'bread', count: 64 }, { slot: 1, name: 'lectern', count: 1 }, { slot: 2, name: 'white_bed', count: 2 }, { slot: 3, name: 'stick', count: 256 }];
  const world = hallWorld();
  t.is(hallChoresGoal.wants(snap(items), world), null);
  t.like(hallChoresGoal.declines!(snap(items), world), { cause: 'unneeded', text: 'the villager hall not looked into yet' });
  t.is(hallChoresGoal.wants(snap(items), hallWorld({ zones: {} })), null);
  t.is(noteHall(world, [], T0), 0);
  t.like(hallChoresGoal.declines!(snap(items), world), { text: 'the villager hall is empty' });
  // a villager seen outside the hall is not in it
  noteHall(world, [{ id: 1, name: 'villager', position: { x: -540, y: 63, z: 2160 }, profession: 'none' }], T0);
  t.is(hallChoresGoal.wants(snap(items), world), null);
  t.is(hallChoresText(world, T0), '; in the hall 0 adults, 0 babies, 3 beds (seen just now); librarian: none yet; fletcher: none; emeralds 0');
  const h = hallAt(world, [], items);
  t.is(await hallChoresGoal.run(h.ctx), 'the villager hall is empty');
  t.deepEqual(h.calls, []);
  // the gate is pure: nothing written by asking
  const before = JSON.stringify(world);
  hallChoresGoal.wants(snap(items), world);
  hallChoresGoal.declines!(snap(items), world);
  t.is(JSON.stringify(world), before);
});

test('the census: the villagers inside the hall\'s box at its floor, babies apart, their jobs; a baby more than at the last feed ends its wait', (t) => {
  const world = hallWorld();
  const seen: Seen[] = [
    { id: 1, name: 'villager', position: { x: -556.5, y: 63, z: 2131.5 }, profession: 'fletcher', level: 1 },
    { id: 2, name: 'villager', position: { x: -559.5, y: 63, z: 2129.5 }, profession: 'none' },
    { id: 3, name: 'villager', position: { x: -554.5, y: 63, z: 2130.5 }, baby: true, profession: 'none' },
    { id: 4, name: 'villager', position: { x: -556.5, y: 40, z: 2131.5 }, profession: 'none' },
    { id: 5, name: 'cow', position: { x: -556.5, y: 63, z: 2131.5 } }
  ];
  t.deepEqual(hallVillagers(world, seen).map(v => v.id), [1, 2, 3]);
  const n = headcount(hallVillagers(world, seen));
  t.like(n, { total: 3, adults: 2, babies: 1 });
  t.is(n.fletcher?.id, 1);
  t.deepEqual(n.unemployed.map(v => v.id), [2]);
  hallChoresOf(world).breed = { thrown: 6, at: T0 - 5 * MINUTE, total: 2, fails: 1, born: 0 };
  noteHall(world, seen, T0);
  t.like(world.hallChores!.breed, { born: 1, fails: 0, total: 3 });
  t.is(world.hallChores!.breed!.at, undefined);
});

// ------------------------------------------------------------------------------------------------ the beds

test('the beds: two more in the live hall, heads against the west wall beside the three, never on a job site, its front, a torch, the gate\'s row, the panel\'s way or the row past a bed\'s foot', (t) => {
  const world = hallWorld();
  const cells = moreBedCells(world, HALL_BEDS_WANTED - 3);
  t.deepEqual(cells, [
    { head: { x: -560, y: 63, z: 2130 }, foot: { x: -559, y: 63, z: 2130 } },
    { head: { x: -560, y: 63, z: 2131 }, foot: { x: -559, y: 63, z: 2131 } }
  ]);
  // as many as the room holds, none on a kept cell
  const all = moreBedCells(world, 40);
  const kept = new Set([
    k(LECTERN), k(FLETCHING), '-553,63,2128', '-552,63,2128', '-560,63,2133', '-552,63,2133', k(INSIDE),
    '-560,63,2129', '-559,63,2129', '-558,63,2129', '-557,63,2127', '-556,63,2127', '-555,63,2127',
    ...[-560, -559, -558, -557, -556, -555, -554, -553, -552].map(x => `${x},63,2133`)
  ]);
  t.true(all.length >= 4);
  for (const b of all) {
    t.false(kept.has(k(b.head)), k(b.head));
    t.false(kept.has(k(b.foot)), k(b.foot));
    t.is(Math.abs(b.head.x - b.foot.x) + Math.abs(b.head.z - b.foot.z), 1);
  }
  const heads = new Set(all.flatMap(b => [k(b.head), k(b.foot)]));
  t.is(heads.size, all.length * 2, 'no two share a cell');
  t.deepEqual(moreBedCells(hallWorld({ zones: {} }), 2), []);
});

test('the beds chore: wanted once a villager is in the hall, made of what there is, put down as the cabin\'s is (facing from the foot to the head), and the hall\'s zones know them', async (t) => {
  const world = hallWorld();
  const items: InventoryItem[] = [{ slot: 0, name: 'white_bed', count: 2 }];
  noteHall(world, [seenOf(villager(1))], T0);
  t.like(chorePlan(snap(items), world), { chore: 'beds' });
  t.regex(hallChoresGoal.wants(snap(items), world) ?? '', /^2 more beds in the villager hall \(3 there, 5 wanted\)$/);
  // short of the makings: the plan says so and goes on to the next chore
  t.regex(JSON.stringify(chorePlan(snap([]), world)), /more beds: the beds' wool: 6 white wool to make of 24 string/);
  const h = hallAt(world, [villager(1)], items);
  const text = await hallChoresGoal.run(h.ctx);
  t.is(text, 'put 2 white_bed in the villager hall (5 beds)');
  t.deepEqual(h.calls.filter(c => c.startsWith('build-structure')), ['build-structure -560,63,2130 white_bed[facing=west,part=head]', 'build-structure -560,63,2131 white_bed[facing=west,part=head]']);
  t.is(hallBeds(world).length, 5);
  t.true(h.lines.includes('hall: a white_bed at (-560, 63, 2131) for the villagers (5 beds now)'));
  t.deepEqual(NO_HIT(h.calls), []);
});

test('a chore that fails is passed over for CHORE_FAIL_WAIT: the beds that would not go down hold up neither the breeding nor the rest', async (t) => {
  const world = hallWorld();
  const items: InventoryItem[] = [{ slot: 0, name: 'white_bed', count: 2 }, { slot: 1, name: 'bread', count: 12 }];
  const vs = [villager(1, 'none', { x: -556.5, y: 63, z: 2131.5 }), villager(2, 'none', { x: -554.5, y: 63, z: 2130.5 })];
  noteHall(world, vs.map(seenOf), T0);
  const h = hallAt(world, vs, items);
  h.ctx.act = (async () => ({ ok: false, text: 'could not reach the cell' })) as GoalContext['act'];
  await t.throwsAsync(hallChoresGoal.run(h.ctx), { message: 'no bed went down in the hall' });
  t.is(world.hallChores!.failed?.beds, T0);
  const next = chorePlan(snap(items, { now: T0 + MINUTE }), world);
  t.like(next, { chore: 'breed' });
  t.like(chorePlan(snap(items, { now: T0 + CHORE_FAIL_WAIT }), world), { chore: 'beds' });
});

// ------------------------------------------------------------------------------------------------ the breeding

/** The hall with its five beds. */
const fiveBeds = () => {
  const world = hallWorld();
  for (const b of moreBedCells(world, 2)) { world.zones!['hall:bed'].push(b.head); world.zones!['hall:bed-foot'].push(b.foot); }
  return world;
};

test('breeding: two adults and a free bed, and 3 bread thrown to each (counted); then the baby is waited for; a baby seen ends the wait; never past four', async (t) => {
  const world = fiveBeds();
  const items: InventoryItem[] = [{ slot: 0, name: 'bread', count: 20 }];
  const vs = [villager(1, 'fletcher', { x: -556.5, y: 63, z: 2131.5 }), villager(2, 'none', { x: -554.5, y: 63, z: 2130.5 })];
  noteHall(world, vs.map(seenOf), T0);
  t.like(chorePlan(snap(items), world), { chore: 'breed', want: 'breed the hall\'s villagers: 2 adults, 0 babies, 3 beds free' });
  const h = hallAt(world, vs, items);
  t.is(await hallChoresGoal.run(h.ctx), 'threw 6 bread to two villagers to breed (2 adults, 0 babies, 3 beds free)');
  t.deepEqual(h.calls.filter(c => c.startsWith('item.toss')), ['item.toss bread x3 to 1', 'item.toss bread x3 to 2']);
  t.deepEqual(vs.map(v => v.bread), [3, 3]);
  t.like(world.hallChores!.breed, { thrown: 6, at: T0, total: 2, fails: 0 });
  t.true(h.lines.includes('hall: threw 3 bread to the villager (2) for breeding (6 thrown in all)'));
  t.deepEqual(NO_HIT(h.calls), []);
  // waiting for the baby: nothing more thrown
  t.regex(JSON.stringify(chorePlan(snap(items, { now: T0 + 10 * MINUTE }), world)), /bread given 10 min ago: waiting for the baby/);
  // the baby: its wait over, and the next feed as soon as the plan allows
  noteHall(world, [...vs, villager(3, 'none', undefined, { baby: true })].map(seenOf), T0 + 12 * MINUTE);
  t.like(world.hallChores!.breed, { born: 1, total: 3 });
  t.like(chorePlan(snap(items, { now: T0 + 13 * MINUTE }), world), { chore: 'breed' });
  // three adults and a baby: four, none more
  noteHall(world, [...vs, villager(4), villager(3, 'none', undefined, { baby: true })].map(seenOf), T0 + 30 * MINUTE);
  t.regex(JSON.stringify(chorePlan(snap(items, { now: T0 + 31 * MINUTE }), world)), /3 adults and 1 baby in the hall \(4 wanted\)/);
  // four adults: none more either
  noteHall(world, [...vs, villager(4), villager(5)].map(seenOf), T0 + 60 * MINUTE);
  t.regex(JSON.stringify(chorePlan(snap(items, { now: T0 + 61 * MINUTE }), world)), /4 adults in the hall \(4 wanted\)/);
});

test('breeding waits: no free bed (three beds, three villagers), too little bread, one adult; two feeds with no baby back off', async (t) => {
  const items: InventoryItem[] = [{ slot: 0, name: 'bread', count: 20 }];
  // three beds, three villagers: the beds come first, and with no room for them no baby
  const full = hallWorld({ zones: { ...hallWorld().zones, 'hall:torch': [] } });
  noteHall(full, [villager(1), villager(2), villager(3)].map(seenOf), T0);
  const plan = (w: WorldMemory, it = items, now = T0) => JSON.stringify(chorePlan(snap(it, { now }), w));
  t.like(chorePlan(snap([]), full), { none: { cause: 'unneeded' } });
  t.regex(plan(full, []), /no free bed for a baby \(3 beds, 3 villagers\)/);
  const world = fiveBeds();
  noteHall(world, [villager(1), villager(2)].map(seenOf), T0);
  t.regex(plan(world, [{ slot: 0, name: 'bread', count: 5 }]), /5 bread \(a baby takes 6\)/);
  noteHall(world, [villager(1)].map(seenOf), T0);
  t.regex(plan(world), /1 adult in the hall: none to breed/);
  // two feeds in a row with no baby: the next after BREED_BACKOFF
  const vs = [villager(1, 'none', { x: -556.5, y: 63, z: 2131.5 }), villager(2, 'none', { x: -554.5, y: 63, z: 2130.5 })];
  noteHall(world, vs.map(seenOf), T0);
  hallChoresOf(world).breed = { thrown: 6, at: T0 - BREED_WAIT - MINUTE, total: 2, fails: 0, born: 0 };
  const h = hallAt(world, vs, items);
  await hallChoresGoal.run(h.ctx);
  t.like(world.hallChores!.breed, { thrown: 12, fails: 1, at: T0 });
  t.regex(plan(world, items, T0 + BREED_WAIT + MINUTE), /2 feeds brought no baby: the next in \d+ min/);
  t.like(chorePlan(snap(items, { now: T0 + BREED_BACKOFF + MINUTE }), world), { chore: 'breed' });
});

test('a baby born and grown up unseen (the bot away past its 20 min) is a birth by the head count, no failed feed; a head more after a villager move is none', async (t) => {
  const items: InventoryItem[] = [{ slot: 0, name: 'bread', count: 20 }];
  const vs = [villager(1, 'none', { x: -556.5, y: 63, z: 2131.5 }), villager(2, 'none', { x: -554.5, y: 63, z: 2130.5 })];
  const fed = () => {
    const w = fiveBeds();
    noteHall(w, vs.map(seenOf), T0 - 45 * MINUTE);
    hallChoresOf(w).breed = { thrown: 6, at: T0 - 45 * MINUTE, total: 2, babies: 0, fails: 1, born: 0 };
    return w;
  };
  // 45 min after the feed: three adults, no baby (it grew up while the bot was down a deep trip)
  const world = fed();
  const grown = [...vs, villager(3, 'none', { x: -557.5, y: 63, z: 2131.5 })];
  noteHall(world, grown.map(seenOf), T0);
  t.like(world.hallChores!.breed, { born: 1, fails: 0, total: 3, babies: 0 });
  t.is(world.hallChores!.breed!.at, undefined);
  t.like(chorePlan(snap(items), world), { chore: 'breed' });
  const h = hallAt(world, grown, items);
  await hallChoresGoal.run(h.ctx);
  t.like(world.hallChores!.breed, { thrown: 12, fails: 0, at: T0 });
  t.regex(hallChoresText(world, T0), /12 bread thrown, 1 born/);
  // a villager moved into the hall since the feed: the head more is that one, no birth, and the feed still waits
  const moved = fed();
  moved.villages = { sites: [], players: [], last: { at: T0 - 30 * MINUTE, text: 'moved a villager home', moved: true } };
  noteHall(moved, grown.map(seenOf), T0);
  t.like(moved.hallChores!.breed, { born: 0, fails: 1, total: 3, at: T0 - 45 * MINUTE });
});

// ------------------------------------------------------------------------------------------------ the librarian

test('the librarian: the lectern put down for the unemployed adult, the new librarian\'s books read and logged as rolls, rerolled (lectern broken, picked up, put back) until Mending, never a trade before it', async (t) => {
  const world = fiveBeds();
  const items: InventoryItem[] = [{ slot: 0, name: 'lectern', count: 1 }];
  const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }), villager(2, 'none', { x: -554.5, y: 63, z: 2129.5 }), villager(3, 'none', { x: -557.5, y: 63, z: 2131.5 }), villager(4, 'none', { x: -558.5, y: 63, z: 2131.5 })];
  noteHall(world, vs.map(seenOf), T0);
  t.like(chorePlan(snap(items), world), { chore: 'lectern', want: 'a lectern for the hall\'s unemployed villager (3 unemployed)' });
  const librarians = [
    [paper(0), shelf(1)],
    [paper(0), book(1, [{ name: 'efficiency', level: 2 }], 17)],
    [book(0, [{ name: 'bane_of_arthropods', level: 5 }], 33), shelf(1)],
    [shelf(0), book(1, [{ name: 'mending', level: 1 }], 24)]
  ];
  const h = hallAt(world, vs, items, { librarians });
  const text = await hallChoresGoal.run(h.ctx);
  t.is(text, 'the librarian offers Mending for 24 emeralds and a book (roll 4): the rolls stop');
  t.deepEqual(h.lines.filter(l => l.startsWith('librarian:')), [
    'librarian: roll 1: no book (emerald, bookshelf)',
    'librarian: roll 2: efficiency 2 (17 emeralds and a book)',
    'librarian: roll 3: bane_of_arthropods 5 (33 emeralds and a book)',
    'librarian: roll 4: mending 1 (24 emeralds and a book)'
  ]);
  t.true(h.lines.includes('hall: a lectern at (-553, 63, 2127) for the unemployed villager'));
  // three rerolls: each the lectern dug, picked up and put back
  t.is(h.calls.filter(c => c === `dig.here ${k(LECTERN)}`).length, 3);
  t.is(h.calls.filter(c => c === `place-block lectern ${k(LECTERN)}`).length, 4);
  t.is(h.blocks.get(k(LECTERN)), 'lectern');
  // a look at its offers only: never a trade with the librarian before Mending showed
  t.deepEqual(h.calls.filter(c => c.startsWith('trade.do')), []);
  t.is(h.calls.filter(c => c.startsWith('trade.open')).length, 4);
  t.is(h.calls.filter(c => c === 'trade.close').length, 4);
  t.like(world.hallChores!.librarian, { state: 'mending', price: 24, rolls: 4, today: 3, day: 7 });
  t.deepEqual(NO_HIT(h.calls), []);
  // out by the gate
  t.is(h.calls[h.calls.length - 1], 'goto -556,63,2136');
  t.regex(hallChoresText(world, T0, 3), /librarian: Mending offered \(24 emeralds and a book\), 0 bought; fletcher: not read yet; emeralds 3$/);
});

test('the reroll cap: 30 a game day, the rest the next day; at most a few a run; one traded with already is kept as it is, never rerolled', async (t) => {
  const world = fiveBeds();
  const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] })];
  noteHall(world, vs.map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'rolling', id: 2, read: true, rolls: 40, day: 7, today: ROLLS_A_DAY, bought: 0, books: 'no book (emerald, bookshelf)' };
  const items: InventoryItem[] = [{ slot: 0, name: 'stick', count: 64 }, { slot: 1, name: 'emerald', count: 70 }];
  t.regex(JSON.stringify(chorePlan(snap(items), world)), /the librarian rerolled 30 times today: the rest tomorrow/);
  // the next game day: rolls again
  world.idle!.today.day = 8;
  t.like(chorePlan(snap(items), world), { chore: 'roll' });
  // a run: ROLLS_A_RUN rerolls, no Mending among them
  const blocks = Array.from({ length: 10 }, () => [paper(0), shelf(1)]);
  const h = hallAt(world, vs, items, { librarians: blocks });
  const text = await hallChoresGoal.run(h.ctx);
  t.is(text, `rerolled the librarian ${ROLLS_A_RUN} times (44 rolls in all, ${ROLLS_A_RUN} today), no Mending yet`);
  t.is(h.calls.filter(c => c.startsWith('dig.here')).length, ROLLS_A_RUN);
  t.deepEqual(h.calls.filter(c => c.startsWith('trade.do')), []);
  t.like(world.hallChores!.librarian, { day: 8, today: ROLLS_A_RUN });
  // traded with already (xp over 0): locked, nothing broken
  const w2 = fiveBeds();
  const traded = [villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)], xp: 2 })];
  noteHall(w2, traded.map(seenOf), T0);
  const h2 = hallAt(w2, traded, []);
  t.is(await hallChoresGoal.run(h2.ctx), 'the librarian has traded already (level 1, 2 xp) and offers no Mending: kept as it is, no reroll');
  t.deepEqual(h2.calls.filter(c => c.startsWith('dig.here') || c.startsWith('trade.do')), []);
  t.like(w2.hallChores!.librarian, { state: 'locked' });
  t.regex(JSON.stringify(chorePlan(snap([]), w2)), /the librarian was traded with before Mending showed: kept as it is/);
});

test.serial('a stay ends itself before its critical section does: slow rerolls stop with the lectern back in its cell and the section live; no fletcher reroll and no wait by a lectern begun near its end', async (t) => {
  t.teardown(() => { delete afield.critical; });
  /** each lectern or table dug takes this much of what is left of the stay (a reroll as slow as the jobs' waits make it) */
  const slow = (h: ReturnType<typeof hallAt>, ms: number, on = 'dig.here') => {
    const call = h.ctx.call, act = h.ctx.act, live: boolean[] = [];
    const note = () => { live.push(!!afield.critical && afield.critical.by === h.ctx.signal && afield.critical.until > T0); };
    h.ctx.call = (async (m: string, p?: Record<string, unknown>) => {
      const r = await call(m, p);
      if (m === on && afield.critical) afield.critical.until -= ms;
      if (m === 'dig.here') note();
      return r;
    }) as GoalContext['call'];
    h.ctx.act = (async (tool: string, p?: Record<string, unknown>) => { const r = await act(tool, p); if (tool === on && afield.critical) afield.critical.until -= ms; if (tool === 'place-block') note(); return r; }) as GoalContext['act'];
    return live;
  };
  // the librarian, never Mending: up to ROLLS_A_RUN rerolls a run, each taking 100 s of the stay's 6 min (the
  // fletcher keeps its table: a jobless librarian would take it)
  const world = fiveBeds();
  const fletcherAt = (): V => villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] });
  const vs = [fletcherAt(), villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] })];
  noteHall(world, vs.map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'rolling', id: 2, read: true, rolls: 1, day: 7, today: 1, bought: 0, books: 'no book (emerald, bookshelf)' };
  const h = hallAt(world, vs, [], { librarians: Array.from({ length: 10 }, () => [paper(0), shelf(1)]) });
  const live = slow(h, 100_000);
  t.is(await hallChoresGoal.run(h.ctx), 'rerolled the librarian 3 times (4 rolls in all), no Mending yet: the stay inside is at its end');
  t.true(ROLLS_A_RUN > 3);
  t.is(h.calls.filter(c => c === `dig.here ${k(LECTERN)}`).length, 3);
  t.is(h.calls.filter(c => c === `place-block lectern ${k(LECTERN)}`).length, 3);
  t.is(h.blocks.get(k(LECTERN)), 'lectern', 'the site back in its cell');
  t.deepEqual(live, [true, true, true, true, true, true], 'every dig and put-back inside the live section');
  t.is(afield.critical, undefined, 'over once out');
  // the fletcher with no stick trade, the stay near its end as it comes in: no table dug
  const w2 = fiveBeds();
  const fl = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [arrows(0), flint(1)] });
  noteHall(w2, [seenOf(fl)], T0);
  hallChoresOf(w2).fletcher = { id: 1, sticks: false, xp: 0, level: 1, sold: 0, rolls: 0, day: 0, today: 0 };
  const h2 = hallAt(w2, [fl], [], { fletchers: [[flint(0), sticks(1)]] });
  slow(h2, 6 * MINUTE - 30_000, 'goto');
  t.is(await hallChoresGoal.run(h2.ctx), 'fletcher: no stick trade; no reroll begun: the stay inside is at its end');
  t.deepEqual(h2.calls.filter(c => c.startsWith('dig.here')), []);
  t.is(h2.blocks.get(k(FLETCHING)), 'fletching_table');
  // the lectern for an unemployed adult: put down, and no wait by it (the next visit finds who took it)
  const w3 = fiveBeds();
  const un = [fletcherAt(), villager(3, 'none', { x: -554.5, y: 63, z: 2129.5 })];
  noteHall(w3, un.map(seenOf), T0);
  const h3 = hallAt(w3, un, [{ slot: 0, name: 'lectern', count: 1 }]);
  slow(h3, 6 * MINUTE - 30_000, 'goto');
  t.is(await hallChoresGoal.run(h3.ctx), 'a lectern at (-553, 63, 2127); not waited by: the stay inside is at its end');
  t.is(h3.blocks.get(k(LECTERN)), 'lectern');
  // (stamped by the run's clock: the snapshot's time and the real ms the run has taken so far, so T0 and a few ms)
  const placedAt = hallChoresOf(w3).librarian?.placedAt;
  t.true(Number.isFinite(placedAt) && placedAt! >= T0 && placedAt! < T0 + MINUTE, `placedAt ${placedAt}`);
  t.is(hallChoresOf(w3).librarian?.waits, undefined, 'no wait counted');
});

// ------------------------------------------------------------------------------------------------ Mending bought, and the anvil after

const PICK: InventoryItem = { slot: 0, name: 'diamond_pickaxe', count: 1, enchantments: [{ name: 'efficiency', level: 5 }, { name: 'unbreaking', level: 3 }, { name: 'fortune', level: 3 }], damage: 10, maxDamage: 1561 };

test('Mending bought: the emeralds and a book carried, the Mending offer alone traded once (result and enchantment named), one a restock; the anvil then puts it on the next piece without it', async (t) => {
  const world = fiveBeds();
  const lib = villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [shelf(0), book(1, [{ name: 'mending', level: 1 }], 24)] });
  const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), lib];
  noteHall(world, vs.map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'mending', id: 2, read: true, rolls: 9, day: 7, today: 8, bought: 0, price: 24 };
  const items: InventoryItem[] = [{ ...PICK }, { slot: 1, name: 'emerald', count: 30 }, { slot: 2, name: 'book', count: 2 }];
  t.is(mendingWanted(items, world), 1 + MENDING_SPARE, 'the pickaxe, and two spare');
  t.like(chorePlan(snap(items), world), { chore: 'buy', want: 'buy Mending (24 emeralds and a book): 3 more wanted' });
  // short of emeralds: waits (and the fletcher's sticks are next)
  t.regex(JSON.stringify(chorePlan(snap([{ ...PICK }, { slot: 1, name: 'emerald', count: 20 }, { slot: 2, name: 'book', count: 1 }]), world)), /Mending offered for 24 emeralds: 20 there/);
  const h = hallAt(world, vs, items);
  t.is(await hallChoresGoal.run(h.ctx), 'librarian: bought mending for 24 emeralds and a book (1 bought, 2 more wanted)');
  t.deepEqual(h.calls.filter(c => c.startsWith('trade.do')), ['trade.do 2 1 x1 enchanted_book mending']);
  t.like(world.hallChores!.librarian, { bought: 1, boughtAt: T0 });
  const bought = h.items.find(i => i.name === 'enchanted_book');
  t.deepEqual(bought?.enchantments, [{ name: 'mending', level: 1 }]);
  t.is(h.items.find(i => i.name === 'emerald')?.count, 6);
  // one a restock
  t.regex(JSON.stringify(chorePlan(snap([...h.items, { slot: 5, name: 'emerald', count: 30 }], { now: T0 + MINUTE }), world)), /a Mending book bought lately: the next after a restock/);
  t.like(chorePlan(snap([...h.items, { slot: 5, name: 'emerald', count: 30 }], { now: T0 + RESTOCK_WAIT }), world), { chore: 'buy' });
  // the anvil after: the bought book onto the pickaxe, the piece without mending
  const job = anvilPlan(h.items, [], 30);
  t.like(job, { job: 'mending', piece: { name: 'diamond_pickaxe' }, add: { name: 'enchanted_book' } });
  // every piece mended and two spare: no more
  const done: InventoryItem[] = [{ ...PICK, enchantments: [...PICK.enchantments!, { name: 'mending', level: 1 }] },
    { slot: 3, name: 'enchanted_book', count: 1, enchantments: [{ name: 'mending', level: 1 }] }, { slot: 4, name: 'enchanted_book', count: 1, enchantments: [{ name: 'mending', level: 1 }] },
    { slot: 1, name: 'emerald', count: 64 }, { slot: 2, name: 'book', count: 1 }];
  t.is(mendingWanted(done, world), 0);
  t.regex(JSON.stringify(chorePlan(snap(done, { now: T0 + RESTOCK_WAIT }), world)), /every piece has it and 2 spare/);
  t.deepEqual(NO_HIT(h.calls), []);
});

test('the Mending offer gone at the buy (another librarian, or new ids after a restart): nothing traded, its offers read again', async (t) => {
  const world = fiveBeds();
  const lib = villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] });
  noteHall(world, [lib].map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'mending', id: 9, read: true, rolls: 9, day: 7, today: 8, bought: 0, price: 24 };
  const h = hallAt(world, [lib], [{ ...PICK }, { slot: 1, name: 'emerald', count: 30 }, { slot: 2, name: 'book', count: 2 }]);
  t.is(await hallChoresGoal.run(h.ctx), 'the librarian (2) offers no Mending (no book (emerald, bookshelf)): its offers read again next');
  t.deepEqual(h.calls.filter(c => c.startsWith('trade.do')), []);
  t.like(world.hallChores!.librarian, { state: 'rolling', read: false });
});

// ------------------------------------------------------------------------------------------------ the fletcher's sticks

test('the fletcher\'s sticks: 32 a trade for an emerald, up to the emeralds kept, the stick trade alone traded; no stick trade remembered and rerolled while it has never traded', async (t) => {
  const world = fiveBeds();
  const fl = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [arrows(0), sticks(1)] });
  const lib = villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [shelf(0), book(1, [{ name: 'mending', level: 1 }], 24)] });
  noteHall(world, [fl, lib].map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'mending', id: 2, read: true, rolls: 9, day: 7, today: 8, bought: 0, price: 24 };
  const items: InventoryItem[] = [{ ...PICK }, { slot: 1, name: 'stick', count: 64 }, { slot: 2, name: 'stick', count: 64 }, { slot: 3, name: 'stick', count: 64 }, { slot: 4, name: 'stick', count: 64 }, { slot: 5, name: 'emerald', count: 2 }];
  t.is(sticksThere({ stick: 10, oak_planks: 3, oak_log: 2, stripped_oak_log: 5 }), 10 + 6 + 16);
  t.like(chorePlan(snap(items), world), { chore: 'sticks', want: 'sell sticks to the fletcher (2 emeralds, 64 wanted)' });
  const h = hallAt(world, [fl, lib], items);
  t.is(await hallChoresGoal.run(h.ctx), 'fletcher: sold 256 sticks for 8 emeralds (10 now)');
  t.deepEqual(h.calls.filter(c => c.startsWith('trade.do')), ['trade.do 1 1 x8 emerald']);
  t.like(world.hallChores!.fletcher, { sticks: true, sold: 8, xp: 8 });
  t.is(world.hallChores!.fletcher!.outAt, undefined);
  // the next run sells the last 8 of the trade's 16 uses: Run.step says "done", and the trade is noted sold out all the
  // same, so the next tick does not fetch 256 sticks and walk in to find it so
  const stacks = (n: number): InventoryItem[] => Array.from({ length: n }, (_, i) => ({ slot: 1 + i, name: 'stick', count: 64 }));
  const hb = hallAt(world, [fl, lib], [{ ...PICK }, ...stacks(4), { slot: 5, name: 'emerald', count: 10 }]);
  t.is(await hallChoresGoal.run(hb.ctx), 'fletcher: sold 256 sticks for 8 emeralds (18 now)');
  t.deepEqual(hb.calls.filter(c => c.startsWith('trade.do')), ['trade.do 1 1 x8 emerald']);
  t.like(world.hallChores!.fletcher, { sold: 16, outAt: T0 });
  const restock = JSON.stringify(chorePlan(snap([...stacks(4), { slot: 5, name: 'emerald', count: 18 }]), world));
  t.regex(restock, /the stick trade sold out: waiting for a restock/);
  t.notRegex(restock, /"chore":"sticks"/);
  // emeralds at the target: no more sold
  t.regex(JSON.stringify(chorePlan(snap([{ slot: 1, name: 'stick', count: 64 }, { slot: 5, name: 'emerald', count: 64 }]), world)), /64 emeralds \(64 kept\)/);
  // a fletcher with no stick trade (2 of 3 at level 1): remembered, then rerolled with its table
  const w2 = fiveBeds();
  const f2 = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [arrows(0), flint(1)] });
  noteHall(w2, [f2].map(seenOf), T0);
  const h2 = hallAt(w2, [f2], [{ slot: 1, name: 'stick', count: 64 }], { fletchers: [[flint(0), sticks(1)]] });
  t.is(await hallChoresGoal.run(h2.ctx), 'fletcher: no stick trade (emerald -> arrow, gravel -> flint)');
  t.deepEqual(h2.calls.filter(c => c.startsWith('trade.do')), []);
  t.like(w2.hallChores!.fletcher, { sticks: false, xp: 0 });
  t.like(chorePlan(snap([{ slot: 1, name: 'stick', count: 64 }]), w2), { chore: 'fletcher' });
  const h3 = hallAt(w2, [f2], [{ slot: 1, name: 'stick', count: 64 }], { fletchers: [[flint(0), sticks(1)]] });
  t.is(await hallChoresGoal.run(h3.ctx), 'fletcher: roll 1: gravel -> flint, stick -> emerald: the stick trade');
  t.deepEqual(h3.calls.filter(c => c.startsWith('dig.here') || c.startsWith('place-block')), [`dig.here ${k(FLETCHING)}`, `place-block fletching_table ${k(FLETCHING)}`]);
  t.deepEqual(h3.calls.filter(c => c.startsWith('trade.do')), []);
  t.like(w2.hallChores!.fletcher, { sticks: true, rolls: 1, today: 1 });
  // the reroll cap
  hallChoresOf(w2).fletcher = { sticks: false, xp: 0, level: 1, sold: 0, rolls: 12, day: 7, today: FLETCHER_ROLLS_A_DAY };
  t.regex(JSON.stringify(chorePlan(snap([{ slot: 1, name: 'stick', count: 64 }]), w2)), /the fletcher rerolled 10 times today/);
  t.deepEqual([...NO_HIT(h.calls), ...NO_HIT(h2.calls), ...NO_HIT(h3.calls)], []);
});

test('a fletching table a reroll took up and could not put down is put back first, by the next run, though the fletcher lost its job with it gone (Nov 24)', async (t) => {
  const world = fiveBeds();
  const f = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [arrows(0), flint(1)] });
  noteHall(world, [f].map(seenOf), T0);
  hallChoresOf(world).fletcher = { id: 1, sticks: false, xp: 0, level: 1, sold: 0, rolls: 0, day: 0, today: 0 };
  const items: InventoryItem[] = [{ slot: 1, name: 'stick', count: 64 }];
  // the reroll: the table taken up, and the server takes none of the four places
  const h = hallAt(world, [f], items, { fletchers: [[flint(0), sticks(1)]], refuse: 4 });
  t.like(chorePlan(snap(items), world), { chore: 'fletcher' });
  const e = await t.throwsAsync(hallChoresGoal.run(h.ctx));
  t.regex(e!.message, /^the fletching_table did not go down at \(-552, 63, 2127\) \(Failed to place block at .*: the server did not accept it\)$/);
  t.is(h.blocks.get(k(FLETCHING)), undefined);
  t.is(items.find(i => i.name === 'fletching_table')?.count, 1);
  t.truthy(hallChoresOf(world).fletcher!.siteOut);
  t.regex(hallChoresText(world, T0), /fletcher: its table taken up by a reroll: to put back/);
  // the villager let its job go with the table gone: no fletcher now, yet the table is the next chore (once the fail
  // wait is over), before the beds, the breeding or a lectern for the unemployed villager
  const h2 = hallAt(world, [f], items, { fletchers: [[flint(0), sticks(1)]] });
  h2.ctx.s = snap(items, { now: T0 + CHORE_FAIL_WAIT });
  t.is(f.profession, 'none');
  t.regex(JSON.stringify(chorePlan(snap(items, { now: T0 + 60_000 }), world)), /put it back: failed 1 min ago, tried again later; .*no fletcher/);
  t.like(chorePlan(snap(items, { now: T0 + CHORE_FAIL_WAIT }), world), { chore: 'fletcher', want: 'the fletching table taken up by a reroll: put it back' });
  t.is(await hallChoresGoal.run(h2.ctx), 'put the fletching table back at (-552, 63, 2127)');
  t.is(h2.blocks.get(k(FLETCHING)), 'fletching_table');
  t.is(hallChoresOf(world).fletcher!.siteOut, undefined);
  t.is(hallChoresOf(world).fletcher!.sticks, undefined);
  t.deepEqual(h2.calls.filter(c => c.startsWith('dig.here')), []);
  // and nothing more of it: the plan goes on as before (a fletcher again takes the table)
  t.notRegex(JSON.stringify(chorePlan(snap(items, { now: T0 + CHORE_FAIL_WAIT }), world)), /put it back/);
  t.deepEqual([...NO_HIT(h.calls), ...NO_HIT(h2.calls)], []);
});

// ------------------------------------------------------------------------------------------------ the offers read, and the status

test('the offers in words: the books with their price, the Mending and the stick trades picked by what they give and take', (t) => {
  t.is(booksOffered([paper(0), book(1, [{ name: 'unbreaking', level: 3 }], 15)]), 'unbreaking 3 (15 emeralds and a book)');
  t.is(booksOffered([]), 'no book (no offers)');
  t.is(mendingOffer([paper(0), book(1, [{ name: 'unbreaking', level: 3 }], 15)]), undefined);
  t.is(mendingOffer([book(0, [{ name: 'mending', level: 1 }], 30)])?.index, 0);
  t.is(stickOffer([arrows(0), sticks(1)])?.index, 1);
  t.is(stickOffer([arrows(0), flint(1)]), undefined);
});

test('brain-status: the Villagers line gets the hall\'s adults, babies and beds, the librarian\'s rolls and Mending, the fletcher, the emeralds; nothing of it before the hall is looked into', (t) => {
  const world = fiveBeds();
  t.is(hallChoresText(world, T0), '');
  t.notRegex(villagersLine(world, T0, undefined, hallChoresText(world, T0)), /in the hall/);
  noteHall(world, [villager(1, 'fletcher'), villager(2, 'librarian'), villager(3, 'none', undefined, { baby: true })].map(seenOf), T0 - 5 * MINUTE);
  hallChoresOf(world).librarian = { state: 'rolling', id: 2, read: true, rolls: 12, day: 7, today: 3, bought: 0, books: 'efficiency 2 (17 emeralds and a book)' };
  hallChoresOf(world).fletcher = { sticks: true, sold: 8, rolls: 0, day: 7, today: 0 };
  hallChoresOf(world).breed = { thrown: 6, fails: 0, born: 1 };
  const line = villagersLine(world, T0, undefined, hallChoresText(world, T0, 4));
  t.is(line, 'Villagers: moves off; the hall at (-561, 62, 2126): not counted yet (3 wanted); in the hall 2 adults, 1 baby, 5 beds (seen 5 min ago); 6 bread thrown, 1 born; ' +
    'librarian: 3 rerolls today (12 offers read in all), no Mending yet (last: efficiency 2 (17 emeralds and a book)); fletcher: sticks for emeralds (8 sold); emeralds 4; no village known');
});

test('wired: the brain\'s goals hold the hall chores after the brewing, a chore that never cuts a running goal; the live homestead (no hall villagers seen) leaves it unwanted', (t) => {
  const goals = realGoals();
  const names = goals.map(g => g.name);
  t.true(names.indexOf('hall chores') > names.indexOf('brewing'));
  const g = goals.find(x => x.name === 'hall chores')!;
  t.is(g.cuts?.(lookAt([], 2000), liveWorld()), false);
  for (const tod of [0, 2000, 6000, 10_000]) t.is(g.wants(lookAt([{ slot: 0, name: 'bread', count: 64 }], tod), liveWorld()), null);
  // the live hall's zone (brain.json Nov 18), no look yet and then an empty one: unwanted for the census, not the hall
  const live = liveWorld();
  live.zones = { ...(live.zones ?? {}), hall: [{ ...HALL }] };
  const s = lookAt([{ slot: 0, name: 'bread', count: 64 }], 2000);
  t.like(g.declines!(s, live), { text: 'the villager hall not looked into yet' });
  noteHall(live, [], T0);
  t.like(g.declines!(s, live), { text: 'the villager hall is empty' });
  t.is(g.wants(s, live), null);
});

// ------------------------------------------------------------------------------------------------ the fixer's cases

const choreOf = (p: ReturnType<typeof chorePlan>) => ('chore' in p ? p.chore : undefined);

test('a reroll as the game does it: the drop lies in the cell till the bot steps in, it steps straight back out, and the lectern goes back from the front each time (not refused four times from inside its own cell)', async (t) => {
  const world = fiveBeds();
  // (a fletcher at the fletching table: the unemployed librarian takes the lectern back, not the table)
  const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] })];
  noteHall(world, vs.map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'rolling', id: 2, read: true, rolls: 1, day: 7, today: 0, bought: 0 };
  const h = hallAt(world, vs, [], { strict: true, librarians: Array.from({ length: 6 }, () => [paper(0), shelf(1)]) });
  t.is(await hallChoresGoal.run(h.ctx), `rerolled the librarian ${ROLLS_A_RUN} times (${1 + ROLLS_A_RUN} rolls in all, ${ROLLS_A_RUN} today), no Mending yet`);
  t.deepEqual(h.calls.filter(c => c.startsWith('place-block refused')), []);
  t.is(h.calls.filter(c => c === `place-block lectern ${k(LECTERN)}`).length, ROLLS_A_RUN);
  t.is(h.blocks.get(k(LECTERN)), 'lectern');
  t.is(h.drops.size, 0, 'every drop picked up');
  t.is(world.hallChores!.failed?.roll, undefined);
  // each pick-up walk into the cell is followed by the step back onto the front
  const front = '-553,63,2128';
  for (let i = 0; i < h.calls.length; i++) if (h.calls[i] === `goto ${k(LECTERN)}`) t.is(h.calls[i + 1], `goto ${front}`);
  // the fletching table the same: put back, never lost from the hall
  const w2 = fiveBeds();
  const f = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [arrows(0), flint(1)] });
  noteHall(w2, [f].map(seenOf), T0);
  hallChoresOf(w2).fletcher = { id: 1, sticks: false, xp: 0, level: 1, sold: 0, rolls: 0, day: 7, today: 0 };
  const h2 = hallAt(w2, [f], [], { strict: true, fletchers: [[flint(0), sticks(1)]] });
  t.is(await hallChoresGoal.run(h2.ctx), 'fletcher: roll 1: gravel -> flint, stick -> emerald: the stick trade');
  t.deepEqual(h2.calls.filter(c => c.startsWith('place-block refused')), []);
  t.is(h2.blocks.get(k(FLETCHING)), 'fletching_table');
  t.deepEqual([...NO_HIT(h.calls), ...NO_HIT(h2.calls)], []);
});

test('the reroll digs only the bot\'s own job site: another block in the lectern\'s cell is left and the chore fails (passed over); the lectern chore fails on it too, not wanted again at the next tick', async (t) => {
  const world = fiveBeds();
  const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] })];
  noteHall(world, vs.map(seenOf), T0);
  // (its own lectern stands elsewhere: it keeps its job)
  const h = hallAt(world, vs, [], { keepsJob: true });
  h.blocks.set(k(LECTERN), 'minecraft:bookshelf');
  await t.throwsAsync(hallChoresGoal.run(h.ctx), { message: 'bookshelf stands in the lectern\'s cell at (-553, 63, 2127): not dug' });
  t.deepEqual(h.calls.filter(c => c.startsWith('dig.here')), []);
  t.is(world.hallChores!.failed?.roll, T0);
  // no librarian, an unemployed adult and something else in the cell: a failure, passed over
  const w2 = fiveBeds();
  const v2 = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), villager(3, 'none', { x: -554.5, y: 63, z: 2129.5 })];
  noteHall(w2, v2.map(seenOf), T0);
  const items: InventoryItem[] = [{ slot: 0, name: 'lectern', count: 1 }];
  t.like(chorePlan(snap(items), w2), { chore: 'lectern' });
  const h2 = hallAt(w2, v2, items);
  h2.blocks.set(k(LECTERN), 'minecraft:cobblestone');
  await t.throwsAsync(hallChoresGoal.run(h2.ctx), { message: /cobblestone stands in the lectern's cell/ });
  t.is(w2.hallChores!.failed?.lectern, T0);
  t.not(choreOf(chorePlan(snap(items, { now: T0 + MINUTE }), w2)), 'lectern');
});

test('the stick trade dearer than 32 (demand after it sold out): its price kept, as many sticks gathered, and a run that cannot pay it fails (passed over) instead of being wanted again at once', async (t) => {
  const world = fiveBeds();
  const dear = (index: number): TradeOffer => ({ ...sticks(index), costA: { name: 'stick', count: 57, baseCount: 32 } });
  const fl = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [arrows(0), dear(1)] });
  noteHall(world, [fl].map(seenOf), T0);
  const items: InventoryItem[] = [{ slot: 1, name: 'stick', count: 40 }, { slot: 5, name: 'emerald', count: 63 }];
  t.like(chorePlan(snap(items), world), { chore: 'sticks' });
  const h = hallAt(world, [fl], items);
  await t.throwsAsync(hallChoresGoal.run(h.ctx), { message: 'fletcher: 40 sticks, the trade takes 57' });
  t.deepEqual(h.calls.filter(c => c.startsWith('trade.do')), []);
  t.like(world.hallChores!.fletcher, { sticks: true, price: 57 });
  t.is(world.hallChores!.failed?.sticks, T0);
  t.not(choreOf(chorePlan(snap(items, { now: T0 + MINUTE }), world)), 'sticks');
  // after the wait, 40 sticks are still too few for the price
  t.regex(JSON.stringify(chorePlan(snap(items, { now: T0 + CHORE_FAIL_WAIT }), world)), /40 sticks: the trade takes 57/);
  // with enough sticks: sold at the price
  const more: InventoryItem[] = [{ slot: 1, name: 'stick', count: 64 }, { slot: 2, name: 'stick', count: 64 }, { slot: 5, name: 'emerald', count: 62 }];
  t.like(chorePlan(snap(more, { now: T0 + CHORE_FAIL_WAIT }), world), { chore: 'sticks' });
  const h2 = hallAt(world, [fl], more);
  h2.ctx.s = snap(more, { now: T0 + CHORE_FAIL_WAIT });
  t.is(await hallChoresGoal.run(h2.ctx), 'fletcher: sold 114 sticks for 2 emeralds (64 now)');
});

test('a librarian locked as traded with, and another (never traded) at the lectern now: read and rerolled, not kept as it is; one traded with is locked again', async (t) => {
  const world = fiveBeds();
  const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] })];
  noteHall(world, vs.map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'locked', id: 1, read: true, rolls: 3, day: 7, today: 0, bought: 0, xp: 5, level: 2 };
  t.like(chorePlan(snap([]), world), { chore: 'roll' });
  const h = hallAt(world, vs, [], { librarians: Array.from({ length: 6 }, () => [paper(0), shelf(1)]) });
  await hallChoresGoal.run(h.ctx);
  t.like(world.hallChores!.librarian, { state: 'rolling' });
  t.true(h.calls.some(c => c.startsWith('dig.here')));
  t.deepEqual(h.calls.filter(c => c.startsWith('trade.do')), []);
  // the same one, traded with: locked, and left so
  const w2 = fiveBeds();
  const traded = [villager(4, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)], xp: 3 })];
  noteHall(w2, traded.map(seenOf), T0);
  hallChoresOf(w2).librarian = { state: 'locked', id: 1, read: true, rolls: 3, day: 7, today: 0, bought: 0 };
  const h2 = hallAt(w2, traded, []);
  await hallChoresGoal.run(h2.ctx);
  t.like(w2.hallChores!.librarian, { state: 'locked', id: 4 });
  t.deepEqual(h2.calls.filter(c => c.startsWith('dig.here')), []);
  t.regex(JSON.stringify(chorePlan(snap([]), w2)), /kept as it is/);
});

test('the roll lines count new offers read: a new entity id over offers read already is a re-read, not a roll; at the day\'s cap no walk in for it', async (t) => {
  const world = fiveBeds();
  const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), villager(7, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] })];
  noteHall(world, vs.map(seenOf), T0);
  hallChoresOf(world).librarian = { state: 'rolling', id: 2, read: true, rolls: 5, day: 7, today: 3, bought: 0 };
  const h = hallAt(world, vs, [], { librarians: Array.from({ length: 6 }, () => [paper(0), shelf(1)]) });
  t.is(await hallChoresGoal.run(h.ctx), `rerolled the librarian ${ROLLS_A_RUN} times (${5 + ROLLS_A_RUN} rolls in all, ${3 + ROLLS_A_RUN} today), no Mending yet`);
  const rolls = h.lines.filter(l => l.startsWith('librarian:'));
  t.is(rolls[0], 'librarian: re-read (id changed): no book (emerald, bookshelf)');
  t.deepEqual(rolls.slice(1), [6, 7, 8, 9].map(n => `librarian: roll ${n}: no book (emerald, bookshelf)`));
  // at the cap, another id: declined, no walk in
  hallChoresOf(world).librarian = { state: 'rolling', id: 2, read: true, rolls: 40, day: 7, today: ROLLS_A_DAY, bought: 0 };
  t.regex(JSON.stringify(chorePlan(snap([]), world)), /the librarian rerolled 30 times today: the rest tomorrow/);
});

test('a lectern no villager takes: its wait counted from when it went down, the decline names it (not its makings), and after a few runs with no taker the chore is passed over', async (t) => {
  const world = fiveBeds();
  const vs = [villager(3, 'none', { x: -554.5, y: 63, z: 2129.5 })];
  noteHall(world, vs.map(seenOf), T0);
  const items: InventoryItem[] = [{ slot: 0, name: 'lectern', count: 1 }];
  // the villager never takes it: the fake settles jobs at a look, so its looks are answered here
  const h = hallAt(world, vs, items);
  const call = h.ctx.call;
  h.ctx.call = (async (m: string, p?: Record<string, unknown>, ms?: number) => {
    if (m === 'world.entities') return { entities: vs.map(seenOf) };
    // (the walk to the hall's middle takes a moment of real time)
    if (m === 'goto' && p?.x === INSIDE.x && p?.z === INSIDE.z) await new Promise(r => setTimeout(r, 30));
    return call(m, p, ms);
  }) as GoalContext['call'];
  const run = (now: number) => { h.ctx.s = snap(items, { now }); return { out: hallChoresGoal.run(h.ctx) }; };
  const first = run(T0);
  t.is(await first.out, 'a lectern at (-553, 63, 2127); no villager has taken it yet');
  t.true(world.hallChores!.librarian!.placedAt! > T0, 'stamped when it went down, not at the run\'s start');
  // no makings left (the lectern stands in its cell): the decline names the lectern, the chore waits by it again
  t.regex(JSON.stringify(chorePlan(snap([], { now: T0 + MINUTE }), world)), /the lectern is down: waiting for a villager to take it/);
  t.like(chorePlan(snap([], { now: T0 + LECTERN_WAIT + MINUTE }), world), { chore: 'lectern', want: 'the lectern is down: no villager has taken it, waited by again' });
  for (let i = 2; i < LECTERN_WAITS; i++) t.regex(await run(T0 + i * LECTERN_WAIT * 2).out, /no villager has taken it yet/);
  const last = run(T0 + LECTERN_WAITS * LECTERN_WAIT * 2);
  await t.throwsAsync(last.out, { message: /no villager has taken it yet \(3 waits in a row\)/ });
  t.is(world.hallChores!.failed?.lectern, T0 + LECTERN_WAITS * LECTERN_WAIT * 2);
});

test('a birth is a baby more than at the feed: an adult moved in is none, and a baby after one was lost is one', (t) => {
  const world = fiveBeds();
  const a = villager(1), b = villager(2), c = villager(3);
  noteHall(world, [a, b].map(seenOf), T0);
  hallChoresOf(world).breed = { thrown: 6, at: T0, total: 2, babies: 0, fails: 1, born: 0 };
  noteHall(world, [a, b, c].map(seenOf), T0 + MINUTE);
  t.like(world.hallChores!.breed, { born: 0, fails: 1, at: T0 });
  // one of three lost after the feed, then a baby: three again, and a birth
  hallChoresOf(world).breed = { thrown: 6, at: T0, total: 3, babies: 0, fails: 1, born: 0 };
  noteHall(world, [a, b, villager(4, 'none', undefined, { baby: true })].map(seenOf), T0 + 2 * MINUTE);
  t.like(world.hallChores!.breed, { born: 1, fails: 0 });
  t.is(world.hallChores!.breed!.at, undefined);
});

test('the brain\'s look at the hall only from within 64 of it on home\'s level: from down the mine under the yard world.entities\' 128 misses villagers', (t) => {
  const world = hallWorld();
  t.true(hallInSight(world, { x: -550, y: 63, z: 2160 }, HOME));
  t.false(hallInSight(world, { x: -550, y: -58, z: 2160 }, HOME));
  t.false(hallInSight(world, { x: -550, y: 63, z: 2260 }, HOME));
  t.false(hallInSight(world, { x: -550, y: 63, z: 2160 }, undefined));
  t.false(hallInSight(hallWorld({ zones: {} }), { x: -550, y: 63, z: 2160 }, HOME));
});

test('the gate is pure with villagers in the hall: wants, declines, the plan and the status line write nothing, at every chore\'s state', (t) => {
  // (no bread but for the feed waiting on its baby: else the breeding comes first in each)
  const items: InventoryItem[] = [{ slot: 1, name: 'lectern', count: 1 }, { slot: 2, name: 'stick', count: 128 }, { slot: 3, name: 'emerald', count: 30 }, { slot: 4, name: 'book', count: 2 }, { ...PICK, slot: 5 }];
  const fl = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 });
  const lb = villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 });
  const un = villager(3, 'none', { x: -557.5, y: 63, z: 2131.5 });
  const cases: [string, V[], Partial<NonNullable<WorldMemory['hallChores']>>, InventoryItem[], Chore][] = [
    ['breed pending', [fl, un], { breed: { thrown: 6, at: T0 - MINUTE, total: 2, babies: 0, fails: 0, born: 0 } }, [...items, { slot: 0, name: 'bread', count: 20 }], 'lectern'],
    ['lectern', [fl, un], {}, items, 'lectern'],
    ['roll', [fl, lb], { librarian: { state: 'rolling', id: 2, read: true, rolls: 3, day: 7, today: 2, bought: 0 } }, items, 'roll'],
    ['buy', [fl, lb], { librarian: { state: 'mending', id: 2, read: true, rolls: 3, day: 7, today: 2, bought: 0, price: 24 } }, items, 'buy'],
    ['sticks', [fl, lb], { librarian: { state: 'locked', id: 2, read: true, rolls: 3, day: 7, today: 2, bought: 0 }, fletcher: { id: 1, sticks: true, price: 40, sold: 0, rolls: 0, day: 7, today: 0 } }, items, 'sticks'],
    ['fletcher', [fl, lb], { librarian: { state: 'locked', id: 2, read: true, rolls: 3, day: 7, today: 2, bought: 0 }, fletcher: { id: 1, sticks: false, sold: 0, rolls: 0, day: 6, today: 3 } }, items, 'fletcher']
  ];
  for (const [name, vs, mem, it, chore] of cases) {
    const world = fiveBeds();
    noteHall(world, vs.map(seenOf), T0);
    Object.assign(world.hallChores!, mem);
    const before = JSON.stringify(world);
    const s = snap(it, { position: { x: -550, y: 63, z: 2160 } });
    hallChoresGoal.wants(s, world);
    hallChoresGoal.declines!(s, world);
    chorePlan(s, world);
    hallChoresText(world, T0, 5);
    t.is(JSON.stringify(world), before, name);
    t.is(choreOf(chorePlan(s, world)), chore, name);
  }
});

// ------------------------------------------------------------------------------------------------ the villager fetch: what keeps the chores out

const OPEN_GATE = 'oak_fence_gate[facing=south,open=true]';
const fetchOf = (over: Partial<FetchMemory> = {}): FetchMemory => ({ v: 1, journal: [], wards: [], nextId: 1, ...over });
const tripIn = (state: Trip['state']): Trip => {
  const way = { at: { x: -549, y: 63, z: 2215 }, side: 'south' as const, inner: { x: -549, y: 63, z: 2213 }, outer: { x: -549, y: 63, z: 2217 }, yard: 80 };
  return { id: 7, kind: 'bring', site: '-693,2262', state, beat: T0, prep: {}, gate: way, spare: [], lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 } };
};
const wardAt = (where: Ward['where'], at: Pos, over: Partial<Ward> = {}): Ward => ({
  key: '3f2a0000-0000-4000-8000-000000000001', from: { site: '-693,2262', at: { x: -675, y: 71, z: 2249 } }, since: T0, bell: true, where,
  last: { at, t: T0, tod: 6000, health: 17, profession: 'fletcher' }, health0: 17, ...over
});

test('the villager fetch keeps the chores out: the lock being built, a villager on its way in through the gates, a ward in the lock or loose by it, the hall\'s gate open; and thunder', (t) => {
  const items: InventoryItem[] = [{ slot: 1, name: 'stick', count: 64 }];
  const s = snap(items);
  const world = fiveBeds();
  noteHall(world, [seenOf(villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }))], T0);
  t.regex(hallChoresGoal.wants(s, world) ?? '', /^sell sticks to the fletcher/);
  const held = (fetch: FetchMemory, text: RegExp | undefined, name: string) => {
    const w: WorldMemory = { ...world, fetch };
    const before = JSON.stringify(w);
    if (!text) t.regex(hallChoresGoal.wants(s, w) ?? '', /^sell sticks/, name);
    else {
      t.is(hallChoresGoal.wants(s, w), null, name);
      t.like(hallChoresGoal.declines!(s, w), { cause: 'hold' }, name);
      t.regex(hallChoresGoal.declines!(s, w)!.text, text, name);
    }
    t.is(JSON.stringify(w), before, `${name}: the gate only reads`);
  };
  // a record with nothing in it: as before
  held(fetchOf(), undefined, 'an empty record');
  held(fetchOf({ shells: { at: T0, lock: [], ring: [] }, method: 'lure', armed: 1 }), undefined, 'the shells read, a trip armed');
  // the lock (or the ring) going up: the builder's walk, the plug in the hall's doorway
  held(fetchOf({ shells: { at: T0, lock: ['no lock stands'], ring: [], building: 'lock' } }), /^the hall's lock is being built: no visit to the villager hall$/, 'the lock being built');
  held(fetchOf({ shells: { at: T0, lock: [], ring: [], building: 'ring' } }), /^the portal's ring is being built/, 'the ring being built');
  // a trip from the yard's gate to the hall's: the gates are its own
  for (const state of ['gate', 'yardhop', 'lock', 'door'] as const) held(fetchOf({ trip: tripIn(state) }), new RegExp(`^a villager is being brought in \\(trip 7: ${state}\\)`), state);
  for (const state of ['prep', 'out', 'survey', 'first', 'hop', 'restore'] as const) held(fetchOf({ trip: tripIn(state) }), undefined, state);
  // a ward in the lock; one led or astray within 32 of the lock's gate (it would follow the bot in); one further off is none
  held(fetchOf({ wards: [wardAt('lock', { x: -556, y: 63, z: 2136 })] }), /^a villager is in the lock/, 'a ward in the lock');
  held(fetchOf({ wards: [wardAt('astray', { x: -550, y: 63, z: 2160 })] }), /^a villager of the bot's is loose 27 from the lock \(it would follow the bot in\)/, 'a ward astray by the lock');
  held(fetchOf({ wards: [wardAt('led', { x: -556, y: 63, z: 2166 })] }), /^a villager of the bot's is loose 32 from the lock/, 'a ward led by the lock');
  held(fetchOf({ wards: [wardAt('astray', { x: -556, y: 63, z: 2168 })] }), undefined, 'a ward 34 off');
  held(fetchOf({ wards: [wardAt('astray', { x: -556, y: 63, z: 2140 }, { dim: 'nether' })] }), undefined, 'a ward lost in the Nether');
  held(fetchOf({ wards: [wardAt('dead', { x: -556, y: 63, z: 2140 })] }), undefined, 'a dead ward');
  // the hall's gate as the gate watch last read it: open (behind the lock's shut gate, for one that goes in when it will)
  held(fetchOf({ gates: { at: T0, open: [{ ...GATE }], leftOpen: [] } }), /^the hall's gate stands open/, 'the hall\'s gate open');
  held(fetchOf({ gates: { at: T0, open: [{ x: -549, y: 63, z: 2215 }], leftOpen: [] } }), undefined, 'another gate open');
  // a read gone stale (an older jar, the watch idle): no hold on it
  held(fetchOf({ gates: { at: T0 - 31_000, open: [{ ...GATE }], leftOpen: [] } }), undefined, 'the hall\'s gate open in a stale read');
  // nothing to do comes first (a hall with no chore is not "held")
  const idle: WorldMemory = { ...world, fetch: fetchOf({ wards: [wardAt('lock', { x: -556, y: 63, z: 2136 })] }) };
  t.like(hallChoresGoal.declines!(snap([]), idle), { cause: 'unneeded' });
  // thunder: no visit (the villagers run for their beds)
  t.like(hallChoresGoal.declines!(snap(items, { thundering: true }), world), { cause: 'late', text: 'thunder: no visit to the villager hall' });
  t.is(hallChoresGoal.wants(snap(items, { thundering: true }), world), null);
});

// ------------------------------------------------------------------------------------------------ the census on a look that is not whole

test('a missing villager lowers the count on whole looks only: one a look does not show is kept by its uuid (else its id) while the hall is not all in sight, and gone on a whole look', (t) => {
  const world = fiveBeds();
  const U = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const a: Seen = { id: 11, uuid: U(1), name: 'villager', position: { x: -552.5, y: 63, z: 2129.5 }, profession: 'fletcher', level: 4 };
  const b: Seen = { id: 12, uuid: U(2), name: 'villager', position: { x: -554.5, y: 63, z: 2129.5 }, profession: 'none' };
  // the uuid is passed through where the bridge gives one (nothing is keyed on it but this)
  t.deepEqual(hallVillagers(world, [a, b]).map(v => v.uuid), [U(1), U(2)]);
  t.false('uuid' in hallVillagers(world, [seenOf(villager(1))])[0]);
  t.is(noteHall(world, [a, b], T0), 2);
  // a blind look (the seconds after a rejoin: nobody listed): nothing lowered, and the census keeps its own time
  t.is(noteHall(world, [], T0 + MINUTE, false), 2);
  t.like(hallChoresOf(world).census, { at: T0 });
  t.deepEqual(hallChoresOf(world).census!.villagers.map(v => v.uuid), [U(1), U(2)]);
  // half a look, the client's ids new since the rejoin: the one seen is as seen now, the other kept; never a third
  t.is(noteHall(world, [{ ...a, id: 501, profession: 'none' }], T0 + 2 * MINUTE, false), 2);
  t.deepEqual(hallChoresOf(world).census!.villagers.map(v => [v.id, v.profession]), [[501, 'none'], [12, 'none']]);
  // a look that shows as many, whole or not, is the census
  t.is(noteHall(world, [{ ...a, id: 501 }, { ...b, id: 502 }], T0 + 3 * MINUTE, false), 2);
  t.like(hallChoresOf(world).census, { at: T0 + 3 * MINUTE });
  // a whole look that does not show one: gone, and the hall wants again whatever it wanted for two
  t.is(noteHall(world, [{ ...a, id: 501 }], T0 + 4 * MINUTE, true), 1);
  t.regex(hallChoresText(world, T0 + 4 * MINUTE), /^; in the hall 1 adult, 0 babies, 5 beds \(seen just now\)/);
  t.is(noteHall(world, [], T0 + 5 * MINUTE), 0, 'whole by default: the callers that do not say are as they were');
  // with no uuid from the bridge (a jar from before it): by the client's id
  const old = fiveBeds();
  noteHall(old, [seenOf(villager(1)), seenOf(villager(2))], T0);
  t.is(noteHall(old, [seenOf(villager(2))], T0 + MINUTE, false), 2);
  t.deepEqual(hallChoresOf(old).census!.villagers.map(v => v.id), [2, 1]);
});

// ------------------------------------------------------------------------------------------------ whose job block is whose

test('the plan names each block\'s holder: the villager of its profession seen within 2 of it at work on the most looks, one block each; the free count by kind; looks out of work hours or of no hour note nothing', (t) => {
  const world = fiveBeds();
  const U = (n: number) => `00000000-0000-4000-8000-0000000000${20 + n}`;
  // the lead's own table, put down by a raw call (Nov 24): in no zone, in the hall all the same
  const LEAD: Pos = { x: -558, y: 63, z: 2131 };
  const fletcher = (x: number, z: number): Seen => ({ id: 21, uuid: U(1), name: 'villager', position: { x, y: 63, z }, profession: 'fletcher', level: 4 });
  const librarian: Seen = { id: 22, uuid: U(2), name: 'villager', position: { x: -553.5, y: 63, z: 2128.5 }, profession: 'librarian', level: 1 };
  const baby: Seen = { id: 23, uuid: U(3), name: 'villager', position: { x: -551.5, y: 63, z: 2128.5 }, baby: true, profession: 'none' };
  const blocks = [
    { at: { ...FLETCHING }, name: 'minecraft:fletching_table' }, { at: { ...LEAD }, name: 'fletching_table' }, { at: { ...LECTERN }, name: 'lectern' },
    // a bed is no job site, and the workshop's smithing table is out of the hall
    { at: { x: -560, y: 63, z: 2127 }, name: 'white_bed[part=head]' }, { at: { x: -541, y: 63, z: 2153 }, name: 'smithing_table' }
  ];
  const holders = () => hallSites(world, blocks).sites.map(s => [k(s.at), s.block, s.profession, s.holder?.key ?? 'free']);
  // nothing seen at work yet: no holder named, but the count by kind says one fletching table stands free
  noteHall(world, [fletcher(-557.5, 2132.5), librarian, baby], T0);
  t.deepEqual(holders(), [[k(FLETCHING), 'fletching_table', 'fletcher', 'free'], [k(LEAD), 'fletching_table', 'fletcher', 'free'], [k(LECTERN), 'lectern', 'librarian', 'free']]);
  t.deepEqual(hallSites(world, blocks).free, { fletching_table: 1, lectern: 0 });
  // three looks in work hours: the fletcher by the lead's table twice (2 off at most), once strolling past the chores' own
  noteHall(world, [fletcher(-557.5, 2132.5), librarian, baby], T0 + MINUTE, true, 3000);
  noteHall(world, [fletcher(-559.5, 2131.5), librarian, baby], T0 + 2 * MINUTE, true, 4000);
  noteHall(world, [fletcher(-552.5, 2128.5), librarian, baby], T0 + 3 * MINUTE, true, 5000);
  // by night, or at an hour not given, where it stands says nothing of its work
  for (const tod of [13_000, 1000, undefined]) noteHall(world, [fletcher(-551.5, 2128.5), librarian, baby], T0 + 4 * MINUTE, true, tod);
  t.deepEqual(holders(), [[k(FLETCHING), 'fletching_table', 'fletcher', 'free'], [k(LEAD), 'fletching_table', 'fletcher', U(1)], [k(LECTERN), 'lectern', 'librarian', U(2)]]);
  t.like(hallSites(world, blocks).sites[1].holder, { id: 21, looks: 2, last: T0 + 2 * MINUTE });
  t.deepEqual(hallSites(world, blocks).free, { fletching_table: 1, lectern: 0 });
  t.false(U(3) in hallChoresOf(world).work!, 'a baby has no job site');
  // the plan only reads
  const before = JSON.stringify(world);
  hallSites(world, blocks);
  t.is(JSON.stringify(world), before);
  // by its last looks: one that works at the other table from some day on is placed there once those are the most
  for (let i = 0; i < 6; i++) noteHall(world, [fletcher(-552.5, 2128.5), librarian, baby], T0 + (5 + i) * MINUTE, true, 6000);
  t.is(hallChoresOf(world).work![U(1)].seen.length, 8);
  t.deepEqual(holders().slice(0, 2), [[k(FLETCHING), 'fletching_table', 'fletcher', U(1)], [k(LEAD), 'fletching_table', 'fletcher', 'free']]);
  // a look not whole that misses it keeps its evidence; a whole one that does not show it drops it with it
  noteHall(world, [librarian], T0 + 12 * MINUTE, false, 6000);
  t.is(holders()[0][3], U(1));
  noteHall(world, [librarian, baby], T0 + 13 * MINUTE, true, 6000);
  t.false(U(1) in hallChoresOf(world).work!);
  t.deepEqual(holders().slice(0, 2).map(h => h[3]), ['free', 'free']);
  t.deepEqual(hallSites(world, blocks).free, { fletching_table: 2, lectern: 0 });
  // a broken record of it is none (brain.json edited by hand)
  (world.hallChores as { work: unknown }).work = 'x';
  t.is(hallChoresOf(world).work, undefined);
  t.deepEqual(hallSites(world, blocks).sites.map(s => s.holder), [undefined, undefined, undefined]);
});

// ------------------------------------------------------------------------------------------------ with no lock: the hall's own gate

test('with no lock, the hall\'s own gate: found open as the bot leaves it is shut by the bridge\'s own click and read again, never by the tool; a job site is not broken with it open', async (t) => {
  // sticks sold, and the gate stands open behind the bot (the closer missed it)
  const world = fiveBeds();
  const f = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] });
  noteHall(world, [seenOf(f)], T0);
  const h = hallAt(world, [f], [{ slot: 1, name: 'stick', count: 64 }]);
  h.blocks.set(k(GATE), OPEN_GATE);
  t.regex(await hallChoresGoal.run(h.ctx), /^fletcher: sold 64 sticks for 2 emeralds \(2 now\); shut the hall's gate$/);
  t.deepEqual(h.calls.slice(-2), ['goto -556,63,2136', `useOn ${k(GATE)}`]);
  t.false(/open=true/.test(h.blocks.get(k(GATE))!));
  // one that will not shut: three clicks, each read back, and it is said
  const w1 = fiveBeds();
  noteHall(w1, [seenOf(f)], T0);
  const stuck = hallAt(w1, [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] })], [{ slot: 1, name: 'stick', count: 64 }], { stuck: true });
  stuck.blocks.set(k(GATE), OPEN_GATE);
  t.regex(await hallChoresGoal.run(stuck.ctx), /; the hall's gate may be open$/);
  t.is(stuck.calls.filter(c => c === `useOn ${k(GATE)}`).length, 3);
  // a reroll with the gate open (a player's click): shut first, and only then the lectern is dug
  const roll = () => {
    const w = fiveBeds();
    const vs = [villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [sticks(0)] }), villager(2, 'librarian', { x: -554.5, y: 63, z: 2129.5 }, { offers: [paper(0), shelf(1)] })];
    noteHall(w, vs.map(seenOf), T0);
    return { w, vs };
  };
  const r1 = roll();
  const h1 = hallAt(r1.w, r1.vs, [], { librarians: [[paper(0), book(1, [{ name: 'mending', level: 1 }], 24)]] });
  h1.blocks.set(k(GATE), OPEN_GATE);
  t.regex(await hallChoresGoal.run(h1.ctx), /^the librarian offers Mending/);
  const shut = h1.calls.indexOf(`useOn ${k(GATE)}`), dig = h1.calls.indexOf(`dig.here ${k(LECTERN)}`);
  t.true(shut >= 0 && dig > shut, h1.calls.join('\n'));
  t.is(h1.calls.filter(c => c === `useOn ${k(GATE)}`).length, 1);
  // a gate that will not shut: no reroll (a failure: the chore is passed over, the others go on), the lectern stands
  const r2 = roll();
  const h2 = hallAt(r2.w, r2.vs, [], { librarians: [[paper(0), shelf(1)]], stuck: true });
  h2.blocks.set(k(GATE), OPEN_GATE);
  await t.throwsAsync(hallChoresGoal.run(h2.ctx), { message: 'the lectern at (-553, 63, 2127) is not dug with a gate open: the hall\'s gate at (-556, 63, 2134) stands open and will not shut' });
  t.deepEqual(h2.calls.filter(c => c.startsWith('dig.here')), []);
  t.is(h2.blocks.get(k(LECTERN)), 'lectern');
  t.is(hallChoresOf(r2.w).failed?.roll, T0);
  // the fletcher's reroll the same
  const w3 = fiveBeds();
  const fl = villager(1, 'fletcher', { x: -552.5, y: 63, z: 2129.5 }, { offers: [arrows(0), flint(1)] });
  noteHall(w3, [seenOf(fl)], T0);
  hallChoresOf(w3).fletcher = { id: 1, sticks: false, xp: 0, level: 1, sold: 0, rolls: 0, day: 0, today: 0 };
  const h3 = hallAt(w3, [fl], [], { fletchers: [[flint(0), sticks(1)]], stuck: true });
  h3.blocks.set(k(GATE), OPEN_GATE);
  await t.throwsAsync(hallChoresGoal.run(h3.ctx), { message: /^the fletching_table at \(-552, 63, 2127\) is not dug with a gate open: the hall's gate .* stands open and will not shut$/ });
  t.is(h3.blocks.get(k(FLETCHING)), 'fletching_table');
  // never the tool on a gate: its own walk into reach is a plain one
  for (const x of [h, stuck, h1, h2, h3]) t.false(x.calls.some(c => c.startsWith('use-item-on-block')), x.calls.join('\n'));
});

// ------------------------------------------------------------------------------------------------ through the lock

/**
 * The chores through the lock, over the pasture (tests/helpers/pasture.ts): the live yard, the hall with its gate H,
 * the lock in front of it with its gate P, and the bridge as the Java has it (its reach, the gate closer, the holds,
 * the pair and the guard). The villagers there are LEAK-SEEKING: awake and within 6 of an open gate with a way through
 * it, one walks out with probability 1, and it follows the bot through the very cell the bot stands in. The lock's
 * rule (never both gates open, never the outer gate open onto a villager) is held against that, not against luck.
 * Serial: the chores' waits are the module's (HALL_WAITS), and here they run on the pasture's own clock.
 */
const START: Pos = { x: -550, y: 63, z: 2145 };
/** The last of a list that `ok` takes. */
const lastIndex = <T>(list: readonly T[], ok: (e: T) => boolean): number => { for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return i; return -1; };
const lastOf = <T>(list: readonly T[], ok: (e: T) => boolean): T | undefined => list[lastIndex(list, ok)];
const cellAt = (q: Pos): Pos => ({ x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) });
/** The chores' waits on the pasture's time (the one that `at()` names: a test may build several). */
function onPasture(t: ExecutionContext, at: () => Pasture, pollMs = 1000): void {
  HALL_WAITS.pollMs = pollMs;
  HALL_WAITS.sleep = ms => at().clock.sleep(ms);
  t.teardown(() => { HALL_WAITS.pollMs = 0; delete HALL_WAITS.sleep; delete afield.critical; });
}
/** what happened to a gate, in order: opened or shut, and by what */
const swings = (p: Pasture, g: Pos) => p.changed.filter(c => k(c.at) === k(g)).map(c => `${isOpen(c.to) ? 'open' : 'shut'}: ${c.how}`);
/** In the lock, or in the doorway of one of its two gates. */
const inLockOrDoor = (p: Pasture, q: Pos) => {
  const lock = lockOf(p.world)!, c = cellAt(q);
  return (c.x >= lock.box.x1 && c.x <= lock.box.x2 && c.z >= lock.box.z1 && c.z <= lock.box.z2) || [lock.p, lock.h].some(g => g.x === c.x && g.z === c.z);
};
/**
 * The lock's rule watched tick by tick through a scenario: every instant both gates stood open, and every instant the
 * lock's gate stood open with a villager in the lock or in a doorway (`yard`: but one that came in from the yard with
 * the bot, which no gate of the hall let out).
 */
function watch(p: Pasture, opts: { yard?: Villager } = {}) {
  const bad: string[] = [];
  const advance = p.advance.bind(p);
  const note = (what: string) => { if (bad.at(-1)?.split(': ')[1] !== what) bad.push(`tick ${p.tick}: ${what}`); };
  p.advance = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      advance(1);
      const open = isOpen(p.get(LIVE_P));
      if (open && isOpen(p.get(LIVE_H))) note('both gates open');
      if (open && p.villagers.some(v => v !== opts.yard && !v.dim && inLockOrDoor(p, v.position))) note('the lock\'s gate open onto a villager');
    }
  };
  return { bad, leaks: () => p.leaks.filter(l => k(l.gate) === k(LIVE_P)).map(l => `tick ${l.t}: ${l.uuid} out by the lock's gate`) };
}

test.serial('through the lock: in by its gate, that gate shut and read shut before the hall\'s opens; out the other way round; every walk careful, every click the bridge\'s own, the stay one critical section', async (t) => {
  const p = yard({ at: START });
  onPasture(t, () => p);
  const lock = lockOf(p.world)!;
  const w = watch(p);
  const ctx = p.ctx;
  t.deepEqual(await throughLock(ctx, 'in'), { ok: true });
  // in the hall, both gates shut behind; the lock's gate was shut (and read shut) before the hall's opened
  t.true(inHallOrLock(p.world, p.bot.at) && p.bot.at.z < LIVE_H.z);
  t.deepEqual(swings(p, LIVE_P), ['open: the bot\'s walk', 'shut: shut (released)']);
  t.deepEqual(swings(p, LIVE_H), ['open: the bot\'s walk', 'shut: shut (closer)']);
  const opened = (g: Pos, n = 0) => p.changed.filter(c => k(c.at) === k(g) && isOpen(c.to))[n].t;
  const shutAt = (g: Pos, n = 0) => p.changed.filter(c => k(c.at) === k(g) && !isOpen(c.to))[n].t;
  t.true(shutAt(LIVE_P) < opened(LIVE_H));
  const read = (g: Pos, before: number) => lastOf(p.log, e => e.t <= before && e.name === 'world.region' && e.params.width === 1 && k(e.params as unknown as Pos) === k(g));
  t.false(isOpen((read(LIVE_P, opened(LIVE_H))!.reply as { blocks: string[] }).blocks[0]), 'the lock\'s gate was read shut before the hall\'s opened');
  // the stay is the run's own critical section, `hall`, for 6 minutes at most
  t.like(afield.critical, { by: ctx.signal, why: 'hall' });
  t.true(afield.critical!.until > ctx.s.now && afield.critical!.until <= ctx.s.now + 6 * MINUTE);
  // a second chore of the run finds the bot inside: a walk to the middle, no gate touched
  const n = p.changed.length;
  t.deepEqual(await throughLock(ctx, 'in'), { ok: true });
  t.is(p.changed.length, n);
  // out: the hall's gate shut and read shut before the lock's opens, the bot 2 beyond the lock's gate, both read shut
  t.deepEqual(await throughLock(ctx, 'out'), { ok: true });
  t.deepEqual(p.bot.at, { x: lock.p.x, y: 63, z: lock.p.z + 2 });
  t.true(shutAt(LIVE_H, 1) < opened(LIVE_P, 1));
  t.false(isOpen((read(LIVE_H, opened(LIVE_P, 1))!.reply as { blocks: string[] }).blocks[0]));
  t.false(isOpen(p.get(LIVE_P)) || isOpen(p.get(LIVE_H)));
  t.is(afield.critical, undefined, 'cleared once out');
  // outside already: nothing to do, nothing asked but where the bot stands
  const m = p.log.length;
  t.deepEqual(await throughLock(ctx, 'out'), { ok: true });
  t.deepEqual(p.log.slice(m).map(e => e.name), ['world.region', 'status'].slice(1));
  // never both open, every walk a careful one that arrived, no tool on a gate, nothing written for a clean passage
  t.deepEqual(w.bad, []);
  t.true(p.walks.every(x => x.careful && x.arrived));
  t.is(p.broke.length, 0);
  t.false(p.log.some(e => e.kind === 'act'));
  t.is(p.world.fetch, undefined);
});

test.serial('a resident stepping into the lock at every step of a visit: never both gates open, never the lock\'s gate open onto a villager, nobody out by it; with the bridge\'s pair and guard set or not', async (t) => {
  let p = yard({ at: START });
  onPasture(t, () => p);
  // (beside the hall's gate inside, 2 in on its line, and aside of it; five phases of its step; the bridge's net off and on)
  const cells: Pos[] = [{ x: -556, y: 63, z: 2133 }, { x: -556, y: 63, z: 2132 }, { x: -555, y: 63, z: 2131 }];
  let out = 0, stepped = 0;
  for (const net of [false, true]) for (const cell of cells) for (let phase = 0; phase < 5; phase++) for (const homing of [false, true]) {
    p = yard({ at: START });
    const name = `${net ? 'net' : 'no net'}, from ${k(cell)}, phase ${phase}, ${homing ? 'goes back to its block' : 'follows the bot'}`;
    if (net) await p.ctx.call('gates.strict', strictSet(p.world));
    const v = p.villager({ at: cell, id: 9100 + phase, profession: 'fletcher' });
    const w = watch(p);
    const a = await throughLock(p.ctx, 'in');
    t.true(a.ok, name);
    if (inLockOrDoor(p, v.position)) stepped++;
    // (an employed villager walks back to its block in work hours, once the way is open; a leak-seeker only follows)
    if (homing) Object.assign(v, { mind: 'home', home: cell });
    const b = await throughLock(p.ctx, 'out');
    t.deepEqual(w.bad, [], name);
    t.deepEqual(w.leaks(), [], name);
    t.true(inHallOrLock(p.world, v.position), `${name}: the resident ended at ${k(cellAt(v.position))}`);
    t.false(isOpen(p.get(LIVE_P)), name);
    t.true(p.walks.every(x => x.careful), name);
    if (b.ok) {
      out++;
      t.false(inHallOrLock(p.world, p.bot.at), name);
      t.false(isOpen(p.get(LIVE_H)), name);
      t.true(p.bot.at.z >= LIVE_P.z + 2, name);
    } else {
      // not out: inside the hall or between the gates, behind the lock's shut gate, and said why
      t.true(inHallOrLock(p.world, p.bot.at), name);
      t.regex(b.why, /villager/, name);
    }
    if (homing) t.true(b.ok, `${name}: ${b.ok ? '' : b.why}`);
    t.is(afield.critical, undefined, name);
    // the bridge's pair and guard are the net under every OTHER walk: this one never needs their click
    if (net) t.like((await p.ctx.call<{ clicks: { pair: number; guard: number } }>('gates.status', {})).clicks, { pair: 0, guard: 0 }, name);
  }
  // (the scenarios did what they are for: the resident did step into the lock, and the bot did get out past one that went back)
  t.true(stepped >= 20, `${stepped} stepped into the lock`);
  t.true(out >= 30, `${out} out`);
});

test.serial('a villager in the lock as the bot wants out: the hall\'s gate opened for it from 3 inside and left open behind the lock\'s shut gate, written down first; back in, the bot shuts it and goes', async (t) => {
  const p = yard({ at: START });
  onPasture(t, () => p);
  const lock = lockOf(p.world)!;
  t.true((await throughLock(p.ctx, 'in')).ok);
  // a resident shut out in the lock (it stepped out behind the bot; here it is put there), standing still
  const v = p.villager({ at: { x: -557, y: 63, z: 2136 }, mind: 'still', profession: 'fletcher' });
  const w = watch(p);
  const n = p.log.length;
  const r = await throughLock(p.ctx, 'out');
  t.like(r, { ok: false });
  t.regex((r as { why: string }).why, /^a villager is in the lock and has not come back in: waiting, the hall's gate open for it behind the lock's shut one$/);
  // from 3 inside the hall's gate: out of the closer's reach of adoption, so the gate stays open when the bot stands off
  t.deepEqual(p.bot.at, { x: lock.h.x, y: 63, z: lock.h.z - 3 });
  t.deepEqual(swings(p, LIVE_H).slice(-1), ['open: useOn']);
  t.deepEqual(p.adopted(), []);
  t.true(isOpen(p.get(LIVE_H)) && !isOpen(p.get(LIVE_P)));
  // written down before the click (brain.json as saved when the click was asked): the gate watch leaves such a gate
  const click = p.log.slice(n).find(e => e.name === 'useOn')!;
  t.like((JSON.parse(click.saved) as WorldMemory).fetch!.journal[0], { k: 'gate', which: 'hall', trip: 0, at: { ...lock.h } });
  p.world.fetch!.gates = { at: p.now(), open: [{ ...lock.h }], leftOpen: [{ ...lock.h }] };
  t.true(openByDesign(p.world, lock.h));
  // the 60 s of looks (20 at 3 s; here 1 s apart)
  t.is(p.log.slice(n).filter(e => e.name === 'world.entities').length, 2 + HALL_WAITS.backLooks);
  t.is(afield.critical, undefined, 'the run ended inside: whoever comes next starts from where the bot stands');
  // asked again with the gate open for it and it still there: straight back, nothing touched, no minute of looks
  const m = p.log.length;
  t.like(await throughLock(p.ctx, 'out'), { ok: false, why: 'a villager is in the lock: waiting (the hall\'s gate stands open for it)' });
  t.true(p.log.length - m < 12);
  t.deepEqual(p.changed.slice(-1).map(c => c.how), ['useOn']);
  // it goes back to its block; asked again, the bot shuts the hall's gate behind it, the entry goes, and out it is
  Object.assign(v, { mind: 'home', home: { x: -553, y: 63, z: 2129 } });
  p.advance(200);
  t.true(v.position.z < lock.h.z);
  t.deepEqual(await throughLock(p.ctx, 'out'), { ok: true });
  t.deepEqual(peekFetch(p.world).journal, []);
  t.false(isOpen(p.get(LIVE_H)) || isOpen(p.get(LIVE_P)));
  t.false(inHallOrLock(p.world, p.bot.at));
  t.deepEqual(w.bad, []);
  t.deepEqual(w.leaks(), []);
  t.true(p.walks.every(x => x.careful));
});

test.serial('a villager that comes into the lock with the bot from the yard is not shut out again: on into the hall, the lock\'s gate shut behind both, the hall\'s opened only behind it', async (t) => {
  let p = yard({ at: START });
  onPasture(t, () => p);
  for (const net of [false, true]) for (let phase = 0; phase < 5; phase++) {
    p = yard({ at: START });
    const name = `${net ? 'net' : 'no net'}, phase ${phase}`;
    if (net) await p.ctx.call('gates.strict', strictSet(p.world));
    // one loose in the yard 3 from the lock's gate (the goal's gate keeps the chores out for a ward this near; a
    // passage that meets one all the same must still be safe): it follows the bot through the gate
    const v = p.villager({ at: { x: -557, y: 63, z: 2140 }, id: 9200 + phase });
    const w = watch(p, { yard: v });
    t.deepEqual(await throughLock(p.ctx, 'in'), { ok: true }, name);
    t.deepEqual(w.bad, [], name);
    // it came along into the hall (a ward brought in, as it happens), and no gate stands open behind the two
    t.true(p.bot.at.z < LIVE_H.z && v.position.z < LIVE_H.z, name);
    t.false(isOpen(p.get(LIVE_P)) || isOpen(p.get(LIVE_H)), name);
    t.true(p.said.includes('hall: a villager came into the lock with the bot: on into the hall, the lock\'s gate shut behind both'), name);
    // and it does not get out again behind the bot
    await throughLock(p.ctx, 'out');
    t.deepEqual(w.bad, [], name);
    t.deepEqual(w.leaks().slice(1), [], name);
    t.true(inHallOrLock(p.world, v.position), name);
    t.false(isOpen(p.get(LIVE_P)), name);
    t.true(p.walks.every(x => x.careful), name);
  }
});

test.serial('no visit while the lock is not free or not whole: somebody in it, a gate open, a wall block gone; the lock\'s gate is not opened and the bot does not set out; a cow that comes in with the bot goes out with it', async (t) => {
  let p = yard({ at: START });
  onPasture(t, () => p);
  const refused = async (set: (w: Pasture) => void, why: RegExp, waited = true) => {
    p = yard({ at: START });
    set(p);
    const before = p.changed.length, began = p.tick;
    const r = await throughLock(p.ctx, 'in');
    t.like(r, { ok: false });
    t.regex((r as { why: string }).why, why);
    t.is(p.changed.length, before, `${why}: no gate moved`);
    t.deepEqual(p.walks, [], `${why}: no walk`);
    t.is(afield.critical, undefined);
    // (looked at for 20 s before it is given up: 7 looks, here 1 s apart)
    if (waited) t.true(p.tick - began >= (HALL_WAITS.lockLooks - 1) * 20, `${why}: waited ${p.tick - began} ticks`);
  };
  await refused(w => { w.villager({ at: { x: -556, y: 63, z: 2136 }, mind: 'still' }); }, /^no visit to the villager hall: a villager is in the lock$/);
  await refused(w => { w.villager({ at: { ...LIVE_H }, mind: 'still' }); }, /a villager is in the lock$/);
  await refused(w => { w.animal('cow', { x: -555, y: 63, z: 2135 }); }, /a cow is in the lock$/);
  await refused(w => { w.swing(LIVE_H, true, 'set'); }, /the hall's gate stands open$/);
  await refused(w => { w.swing(LIVE_P, true, 'set'); }, /the lock's gate stands open$/);
  await refused(w => { w.set({ x: -558, y: 64, z: 2135 }, 'air'); }, /^no visit to the villager hall: a wall block gone at \(-558, 64, 2135\) \(air\)$/, false);
  await refused(w => { w.set({ x: LIVE_H.x, y: 64, z: LIVE_H.z }, 'cobblestone'); }, /the hall's doorway is one high: cobblestone/, false);
  await refused(w => { w.blind(400); }, /the lock is not read|could not be read/, false);
  // free again within the 20 s: the visit goes
  p = yard({ at: START });
  p.swing(LIVE_P, true, 'set');
  p.at(p.tick + 60, () => p.swing(LIVE_P, false, 'a player'));
  t.deepEqual(await throughLock(p.ctx, 'in'), { ok: true });
  t.true((await throughLock(p.ctx, 'out')).ok);
  // a cow that walks in behind the bot: the hall's gate is not opened for it; out again with the bot, the gate shut
  p = yard({ at: START });
  const lock = lockOf(p.world)!;
  let cow = false;
  p.on.call.goto = (a, w) => {
    const r = w.answer('goto', a);
    if (!cow && a.z === lock.p.z - 1 && a.range === 0) { cow = true; w.animal('cow', { x: lock.p.x, y: 63, z: lock.p.z - 1 }); }
    return r;
  };
  const r = await throughLock(p.ctx, 'in');
  t.deepEqual(r, { ok: false, why: 'a cow came into the lock with the bot' });
  t.deepEqual(swings(p, LIVE_H), []);
  t.deepEqual(swings(p, LIVE_P), ['open: the bot\'s walk', 'shut: shut (released)', 'open: the bot\'s walk', 'shut: shut (released)']);
  t.false(inHallOrLock(p.world, p.bot.at));
  t.is(afield.critical, undefined);
});

/** A librarian at its lectern in the pasture's hall, never traded with, its offers no Mending: the reroll's job is scripted (the pasture's villagers know no job sites yet). */
function librarianHall(over: Parameters<typeof yard>[0] = {}) {
  const p = yard({ at: START, ...over });
  const lectern = p.world.zones!['hall:lectern'][0];
  p.set(lectern, 'lectern[facing=south,has_book=false,powered=false]');
  p.mine(lectern);
  const v = p.villager({ at: { x: -553, y: 63, z: 2129 }, profession: 'librarian', mind: 'still' });
  const digs: string[] = [];
  p.on.call['trade.open'] = () => ({ open: true, level: 1, xp: 0, offers: [paper(0), shelf(1)], id: v.id, profession: 'librarian' });
  p.on.call['trade.close'] = () => ({ ok: true });
  p.on.call['dig.here'] = (a, w) => {
    digs.push(`${isOpen(w.get(LIVE_P)) ? 'P open' : 'P shut'}, ${isOpen(w.get(LIVE_H)) ? 'H open' : 'H shut'}`);
    const r = w.answer('dig.here', a);
    v.profession = 'none';
    return r;
  };
  p.on.act['place-block'] = (a) => { if (a.item === 'lectern') v.profession = 'librarian'; return undefined; };
  return { p, v, lectern, digs };
}

test.serial('a roll never breaks a site with the lock\'s gate or the hall\'s open: each read just before; one a player opened is shut first, from inside; one that will not shut, and no roll', async (t) => {
  let h = librarianHall();
  onPasture(t, () => h.p);
  // four rerolls of a run, each lectern dug with both gates read shut
  let w = watch(h.p);
  t.regex(await hallChoresGoal.run(h.p.ctx), /^rerolled the librarian 4 times \(5 rolls in all, 4 today\), no Mending yet$/);
  t.deepEqual(h.digs, Array.from({ length: 4 }, () => 'P shut, H shut'));
  // immediately before: the two calls ahead of each dig are the looks at the lock's gate and the hall's, both shut
  for (const dig of h.p.log.filter(e => e.name === 'dig.here')) {
    const [lockGate, hallGate] = h.p.log.slice(dig.i - 2, dig.i);
    for (const [e, g] of [[lockGate, LIVE_P], [hallGate, LIVE_H]] as const) {
      t.like(e, { name: 'world.region', params: { ...g, width: 1, height: 1, length: 1 } });
      t.false(isOpen((e.reply as { blocks: string[] }).blocks[0]));
    }
  }
  t.deepEqual(w.bad, []);
  t.false(inHallOrLock(h.p.world, h.p.bot.at));
  t.true(h.p.walks.every(x => x.careful));
  t.is(afield.critical, undefined);
  // a player opens the hall's gate, and then the lock's, while the bot reads the offers: each shut before the lectern
  // is touched (the lock's from the cell before the hall's gate: in reach, and no walk into the lock)
  for (const gate of [LIVE_H, LIVE_P]) {
    h = librarianHall();
    const { p, digs } = h;
    let clicked = false;
    p.on.call['trade.close'] = (_a, x) => { if (!clicked) x.swing(gate, true, 'a player'); clicked = true; return { ok: true }; };
    w = watch(p);
    t.regex(await hallChoresGoal.run(p.ctx), /^rerolled the librarian 4 times/);
    t.deepEqual(digs, Array.from({ length: 4 }, () => 'P shut, H shut'));
    const opened = p.changed.findIndex(c => c.how === 'a player');
    t.like(p.changed[opened + 1], { at: gate, how: 'shut (released)' });
    t.true(p.changed[opened + 1].t < p.log.find(e => e.name === 'dig.here')!.t);
    t.deepEqual(w.bad, []);
    t.true(p.walks.every(x => x.careful));
  }
  // the hall's gate will not shut (the bridge cannot click it, the raw click does nothing): no reroll, a failure
  h = librarianHall();
  const { p } = h;
  let held = false;
  p.on.call['trade.close'] = (_a, x) => { if (!held) x.swing(LIVE_H, true, 'a player'); held = true; return { ok: true }; };
  p.on.call['gates.release'] = a => (held && a.z === LIVE_H.z ? { released: false, open: true } : undefined);
  p.on.call.useOn = a => (held && a.z === LIVE_H.z ? { used: true, changed: false } : undefined);
  await t.throwsAsync(hallChoresGoal.run(p.ctx), { message: 'the lectern at (-553, 63, 2127) is not dug with a gate open: the hall\'s gate at (-556, 63, 2134) stands open and will not shut' });
  t.deepEqual(h.digs, []);
  t.is(p.get(h.lectern).replace(/\[.*$/, ''), 'lectern');
  t.truthy(hallChoresOf(p.world).failed?.roll);
  t.false(isOpen(p.get(LIVE_P)), 'and the lock\'s gate was not opened with the hall\'s open: the bot is still inside');
  t.true(inHallOrLock(p.world, p.bot.at));
});

test.serial('a job site to make from inside the hall: out through the lock first, both gates shut behind, and only then the walk to the chests; back in through the lock with it', async (t) => {
  const h = librarianHall();
  const { p, digs } = h;
  onPasture(t, () => p);
  // the lectern's drop is lost (it fell where the bot cannot stand): another is made, of the one in the chests
  const chest = { x: -547, y: 63, z: 2182 };
  p.world.landmarks.chests = [chest];
  p.world.chestItems = { [k(chest)]: { lectern: 1 } };
  let lost = false;
  const dig = p.on.call['dig.here']!;
  p.on.call['dig.here'] = async (a, w) => {
    const r = await dig(a, w);
    if (!lost) w.drops.length = 0;
    lost = true;
    return r;
  };
  const taken: string[] = [];
  p.on.act['take-from-chest'] = (a, w) => {
    taken.push(`${inHallOrLock(w.world, w.bot.at) ? 'inside' : 'outside'}, ${isOpen(w.get(LIVE_P)) ? 'P open' : 'P shut'}, ${isOpen(w.get(LIVE_H)) ? 'H open' : 'H shut'}, critical ${afield.critical?.why ?? 'no'}`);
    w.give(String(a.item), 1);
    return { ok: true, text: `Took 1 ${String(a.item)} from the chest at (${chest.x}, ${chest.y}, ${chest.z}). It holds: nothing.` };
  };
  const w = watch(p);
  t.regex(await hallChoresGoal.run(p.ctx), /^rerolled the librarian 4 times/);
  t.true(p.said.includes('hall: the lectern\'s drop not picked up: another is made'), p.said.join('\n'));
  // the take from the chest: the bot outside the hall and the lock, both gates shut, the stay's critical section over
  t.deepEqual(taken, ['outside, P shut, H shut, critical no']);
  // out through the lock before it and in through it after: the lock's gate opened and shut four times in all (in,
  // out for the lectern, in with it, out at the end), each time behind the hall's shut gate
  t.is(swings(p, LIVE_P).filter(x => x.startsWith('open')).length, 4);
  t.deepEqual(w.bad, []);
  t.deepEqual(digs, Array.from({ length: 4 }, () => 'P shut, H shut'));
  t.true(p.walks.every(x => x.careful), 'no plain walk out of the hall');
  t.is(p.broke.length, 0);
  t.false(inHallOrLock(p.world, p.bot.at));
  t.is(afield.critical, undefined);
});

test.serial('a stay behind the lock ends itself: no reroll begun once the day is ending, the critical section never past dusk; a look that sees nothing of the hall (just rejoined) empties no census', async (t) => {
  // at time of day 11000 with the bot inside: the offers read, no lectern broken
  const h = librarianHall({ tod: 11_000 });
  onPasture(t, () => h.p);
  const ctx = h.p.ctx;
  const text = hallChoresGoal.run(ctx);
  t.regex(await text, /^rerolled the librarian 0 times \(1 rolls in all\), no Mending yet: the day is ending$/);
  t.deepEqual(h.digs, []);
  t.false(inHallOrLock(h.p.world, h.p.bot.at));
  // the section's end: 6 minutes, or time of day 11800 if that comes first (800 ticks from 11000: 40 s)
  const p = yard({ at: START, tod: 11_000 });
  const c2 = p.ctx;
  t.true((await throughLock(c2, 'in')).ok);
  t.true(afield.critical!.until - c2.s.now <= 800 * 50 && afield.critical!.until > c2.s.now);
  t.true((await throughLock(c2, 'out')).ok);
  // the census on a blind look: two in the hall as last seen; just rejoined, the client lists nobody and reads every
  // cell null: the run does nothing, and the two are still counted
  const q = yard({ at: START });
  const a = q.villager({ at: { x: -553, y: 63, z: 2129 }, profession: 'fletcher', mind: 'still' });
  q.villager({ at: { x: -557, y: 63, z: 2131 }, mind: 'still' });
  noteHall(q.world, (await q.ctx.call<{ entities: Seen[] }>('world.entities', { maxDistance: 128, type: 'villager' })).entities, q.now());
  t.is(hallChoresOf(q.world).census!.villagers.length, 2);
  t.true(hallChoresOf(q.world).census!.villagers.some(v => v.uuid === a.uuid), 'by the game\'s own uuid');
  q.blind(200);
  t.is(await hallChoresGoal.run(q.ctx), 'the villager hall is not in sight (nothing of it is loaded): nothing done');
  t.is(hallChoresOf(q.world).census!.villagers.length, 2);
  t.deepEqual(q.walks, []);
  // in sight again and one of them gone (a whole look): the count goes down
  q.advance(200);
  q.villagers.pop();
  q.give('stick', 64);
  await hallChoresGoal.run(q.ctx).catch(() => undefined);
  t.is(hallChoresOf(q.world).census!.villagers.length, 1);
});

test.serial('a visit given up between the gates (the brain\'s stop: flight): both gates are asked shut outside the run, from where the bot stands, and the critical section is over', async (t) => {
  const p = yard({ at: START });
  onPasture(t, () => p);
  const lock = lockOf(p.world)!;
  const ac = new AbortController();
  const base = p.ctx;
  const ctx: GoalContext = {
    ...base, signal: ac.signal,
    call: (async (method: string, a?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      const r = await base.call(method, a);
      // (stopped as the bot stands between the gates, the lock's gate open behind it)
      if (method === 'goto' && a?.z === lock.p.z - 1 && a.range === 0) ac.abort();
      return r;
    }) as GoalContext['call']
  };
  await t.throwsAsync(brainRun.run({ signal: ac.signal }, () => throughLock(ctx, 'in')), { message: 'aborted' });
  t.deepEqual(swings(p, LIVE_P), ['open: the bot\'s walk', 'shut: shut (released)']);
  t.deepEqual(swings(p, LIVE_H), []);
  t.deepEqual(p.log.slice(-2).map(e => [e.name, e.params]), [['gates.release', { ...lock.p, shut: true }], ['gates.release', { ...lock.h, shut: true }]]);
  t.is(afield.critical, undefined);
  // the goal that takes a bot found in the hall or the lock out of it starts from where it stands: out by the lock's gate
  t.deepEqual(await throughLock(p.ctx, 'out'), { ok: true });
  t.false(inHallOrLock(p.world, p.bot.at));
  t.false(isOpen(p.get(LIVE_P)) || isOpen(p.get(LIVE_H)));
});
