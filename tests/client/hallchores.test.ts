import test from 'ava';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Seen } from '../../src/client/brain/village.js';
import {
  BREAD_EACH, BREAD_PER_BABY, BREED_BACKOFF, BREED_WAIT, CHORE_FAIL_WAIT, EMERALD_TARGET, FLETCHER_ROLLS_A_DAY, HALL_ADULTS, HALL_BEDS_WANTED, HALL_WAITS, LECTERN_WAIT, LECTERN_WAITS, MENDING_SPARE,
  RESTOCK_WAIT, ROLLS_A_DAY, ROLLS_A_RUN, booksOffered, chorePlan, hallBeds, hallChoresGoal, hallChoresOf, hallChoresText, hallInSight, hallVillagers, headcount,
  mendingOffer, mendingWanted, moreBedCells, noteHall, stickOffer, sticksThere, type Chore, type TradeOffer
} from '../../src/client/brain/hallchores.js';
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
 */
function hallAt(world: WorldMemory, villagers: V[], items: InventoryItem[], opts: { librarians?: TradeOffer[][]; fletchers?: TradeOffer[][]; keepsJob?: boolean; strict?: boolean } = {}) {
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
