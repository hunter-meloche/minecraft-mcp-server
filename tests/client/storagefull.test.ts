import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chestSlots, fullChests, peekChest, rememberReply, storeInChests, storeSlots } from '../../src/client/brain/chests.js';
import { putAway, stash, stashKeep, stashWork } from '../../src/client/brain/chores.js';
import { makeRoom, noRoom, pockets, room, stashReach } from '../../src/client/brain/pockets.js';
import { depositPlan, misplaced, stackSize } from '../../src/client/brain/storage.js';
import { Brain } from '../../src/client/brain/brain.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import { brainRun, type ChestContents, type ClientRuntime, type InventoryItem, type Status } from '../../src/client/tools.js';

// F2 (Nov 14): the storage house was full, and the stash's plan did not know it. It counted each chest's things
// packed into whole stacks, so the misc chest (27 stacks, 23 packed) always had four slots to fill: the stash failed
// "nothing could be put away" 44 times in four hours, and at 10:43Z the loop watch caught it going round four times in
// 246 s, the idle watchdog's let-go and the early release of a hold freeing it turn about. A full chest is remembered
// from the reply that says so; the stash says when the storage is full and stops asking; the let-go undoes neither.

type Pos = { x: number; y: number; z: number };
type Stack = { name: string; count: number };
const MIN = 60_000;
const NOW = 10 * 60 * 60_000;
const at = (k: string): Pos => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const FOOD = '1,64,0', ORES = '2,64,0', MISC = '3,64,0', STONE = '4,64,0';
const SORTED = { [FOOD]: 'food', [ORES]: 'ores', [MISC]: 'misc', [STONE]: 'stone' };

const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: NOW, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
  };
};
const tool = (slot: number, name: string, maxDamage = 1561): InventoryItem => ({ slot, name, count: 1, damage: 0, maxDamage });
/** the kit, all of it kept: tools, the spare pickaxe, torches, the climb's stone and a stack of bread */
const kit = (): InventoryItem[] => [tool(0, 'diamond_pickaxe'), tool(1, 'iron_pickaxe', 250), tool(2, 'diamond_sword'), tool(3, 'diamond_axe'),
  tool(4, 'diamond_shovel'), tool(5, 'diamond_hoe'), { slot: 6, name: 'torch', count: 32 }, { slot: 7, name: 'cobblestone', count: 64 }, { slot: 8, name: 'bread', count: 64 }];
/** food kinds under the carry cap, one of each: the stash keeps every one (pockets.test.ts KEPT) */
const KEPT = ['apple', 'cooked_porkchop', 'cooked_cod', 'cooked_salmon', 'cookie', 'melon_slice', 'dried_kelp', 'cooked_beef', 'cooked_chicken',
  'carrot', 'baked_potato', 'pumpkin_pie', 'cooked_rabbit', 'cooked_mutton', 'beetroot', 'sweet_berries', 'glow_berries', 'porkchop', 'cod', 'salmon',
  'beef', 'chicken', 'potato', 'rabbit', 'mutton', 'tropical_fish', 'honey_bottle'];
/** the kit, then `extra` a slot each, then one of a kind the stash keeps a slot each, up to `used` slots */
const pocketsOf = (used: number, extra: Omit<InventoryItem, 'slot'>[] = []): InventoryItem[] => {
  const items = [...kit()];
  let slot = 9;
  for (const e of extra) items.push({ ...e, slot: slot++ });
  const kept = KEPT.filter(n => !items.some(i => i.name === n));
  while (items.length < used) items.push({ slot: slot++, name: kept.shift()!, count: 1 });
  return items;
};
/** `n` stacks of a kind, whole */
const full = (name: string, n: number): Stack[] => Array.from({ length: n }, () => ({ name, count: stackSize(name) }));
/** a chest's totals, as its memory holds them */
const totals = (stacks: Stack[]): Record<string, number> => {
  const t: Record<string, number> = {};
  for (const st of stacks) t[st.name] = (t[st.name] ?? 0) + st.count;
  return t;
};
/**
 * The misc chest of Nov 14, in kind: 27 stacks, 23 of them packed. Five banners that do not stack together (other
 * patterns) take five slots where their count of five packs into one.
 */
const MISC_STACKS = (): Stack[] => [
  ...Array.from({ length: 5 }, () => ({ name: 'white_banner', count: 1 })),
  ...['oak_stairs', 'poppy', 'ominous_bottle', 'gray_wool', 'string', 'glass_bottle', 'flower_pot', 'painting', 'item_frame', 'ladder', 'lantern',
    'bowl', 'book', 'paper', 'feather', 'clay_ball', 'brick', 'glowstone_dust', 'slime_ball', 'bone_meal', 'ink_sac', 'name_tag'].map(name => ({ name, count: 1 }))
];

const world = (chests: Record<string, Stack[]>, over: Partial<WorldMemory> = {}): WorldMemory => ({
  landmarks: { chests: Object.keys(chests).map(at), farmland: [] }, leash: 96,
  chestItems: Object.fromEntries(Object.entries(chests).map(([k, st]) => [k, totals(st)])), ...over
} as WorldMemory);
/** the storage house of Nov 14, in kind: the food and ore chests full, the misc chest as above, a stone double chest with room */
const house = (): Record<string, Stack[]> => ({ [FOOD]: full('carrot', 27), [ORES]: full('raw_iron', 27), [MISC]: MISC_STACKS(), [STONE]: full('cobblestone', 30) });

// ---- a stand-in for the game: chests as lists of stacks, replies in the tools' own words ----

interface Game {
  inv: InventoryItem[]; chests: Record<string, { size: number; stacks: Stack[] }>; acts: string[]; pos: Pos;
  count: (name: string) => number; used: () => number;
}

function game(items: InventoryItem[], chests: Record<string, Stack[]>, sizes: Record<string, number> = {}): { g: Game; ctx: (s: Snapshot, w: WorldMemory) => GoalContext & { said: string[] } } {
  const g: Game = {
    inv: items.map(i => ({ ...i })), acts: [], pos: { x: 0, y: 64, z: 0 },
    chests: Object.fromEntries(Object.entries(chests).map(([k, st]) => [k, { size: sizes[k] ?? 27, stacks: st.map(x => ({ ...x })) }])),
    count: name => g.inv.filter(i => i.name === name && i.slot < 36).reduce((n, i) => n + i.count, 0),
    used: () => g.inv.filter(i => i.slot < 36).length
  };
  const holds = (k: string) => Object.entries(totals(g.chests[k].stacks)).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
  const act = (name: string, a: Record<string, unknown>): { ok: boolean; text: string } => {
    const k = `${a.x},${a.y},${a.z}`;
    const where = `(${a.x}, ${a.y}, ${a.z})`;
    const item = String(a.item);
    if (name === 'store-in-chest') {
      const have = g.count(item);
      if (!have) return { ok: false, text: `No ${item} in the inventory` };
      const chest = g.chests[k];
      const want = Math.min((a.count as number | undefined) ?? have, have);
      const size = stackSize(item);
      let left = want;
      // as a chest's quick move does: its stacks of the kind topped up, then the empty slots
      for (const st of chest.stacks) {
        if (st.name !== item || st.count >= size || !left) continue;
        const n = Math.min(left, size - st.count);
        st.count += n;
        left -= n;
      }
      while (left > 0 && chest.stacks.length < chest.size) {
        const n = Math.min(left, size);
        chest.stacks.push({ name: item, count: n });
        left -= n;
      }
      const moved = want - left;
      let take = moved;
      for (const i of g.inv.filter(x => x.name === item && x.slot < 36).sort((x, y) => x.slot - y.slot)) {
        const n = Math.min(take, i.count);
        i.count -= n;
        take -= n;
      }
      g.inv = g.inv.filter(i => i.count > 0);
      g.acts.push(`store ${moved}/${want} ${item} at ${k}`);
      return { ok: true, text: `Stored ${moved} ${item} in the chest at ${where}${moved < want ? ' (the chest is full)' : ''}. It holds: ${holds(k)}; ${chest.size - chest.stacks.length}/${chest.size} slots free.` };
    }
    if (name === 'drop-item') {
      let left = a.count as number;
      for (const i of g.inv.filter(x => x.name === item)) { const n = Math.min(left, i.count); i.count -= n; left -= n; }
      g.inv = g.inv.filter(i => i.count > 0);
      g.acts.push(`drop ${a.count} ${item}`);
      return { ok: true, text: `Dropped ${(a.count as number) - left} ${item}` };
    }
    if (name === 'move-to-position') { g.pos = { x: a.x as number, y: a.y as number, z: a.z as number }; return { ok: true, text: 'Arrived' }; }
    if (name === 'go-home') { g.pos = { x: 0, y: 64, z: 0 }; return { ok: true, text: 'Home' }; }
    throw new Error(`no tool ${name}`);
  };
  let open: string | undefined;
  const call = (method: string, p: Record<string, unknown> = {}): unknown => {
    if (method === 'inventory') return { items: g.inv.map(i => ({ ...i })) };
    if (method === 'goto') { g.pos = { x: p.x as number, y: p.y as number, z: p.z as number }; return {}; }
    if (method === 'chest.open') {
      open = `${p.x},${p.y},${p.z}`;
      const c = g.chests[open];
      g.acts.push(`open ${open}`);
      return { slots: c.size, free: c.size - c.stacks.length, items: totals(c.stacks), stacks: c.stacks.map((st, slot) => ({ slot, ...st })) } satisfies ChestContents;
    }
    if (method === 'container.close') { open = undefined; return {}; }
    return {};
  };
  const status = (): Status => ({ inWorld: true, username: 'Bot', screen: null, position: g.pos, block: g.pos, timeOfDay: 1000, hashedSeed: '1', dimension: 'overworld', health: 20, food: 20 });
  return {
    g,
    ctx: (s, w) => {
      const said: string[] = [];
      return {
        s, world: w, signal: new AbortController().signal, said,
        act: async (name, a = {}) => act(name, a),
        call: (async (method: string, p?: Record<string, unknown>) => call(method, p)) as GoalContext['call'],
        status: async () => status(),
        progress: text => { said.push(text); },
        gain: () => undefined
      };
    }
  };
}

// ---- the memory of a full chest ----

test('a full chest is remembered from the reply that says so, and forgotten when one shows a slot free', async t => {
  const w = world({ [FOOD]: full('carrot', 27) });
  const STORE = 'Stored 0 raw_gold in the chest at (1, 64, 0) (the chest is full). It holds: carrot x1728; 0/27 slots free.';
  // the deposit's reply: it took less than it was given, and every slot is used
  rememberReply(w, at(FOOD), STORE);
  t.deepEqual([...fullChests(w)], [FOOD]);
  t.deepEqual(w.chestItems?.[FOOD], { carrot: 1728 });
  // a take's reply from an older build says nothing of the slots: the chest stays full, and the room the take left in
  // its own stack is counted
  rememberReply(w, at(FOOD), 'Took 16 carrot from the chest at (1, 64, 0). It holds: carrot x1712.');
  t.deepEqual([...fullChests(w)], [FOOD]);
  t.is(chestSlots(w)(FOOD), 0);
  const plan = (mem: WorldMemory) => depositPlan([{ slot: 0, name: 'carrot', count: 64 }, { slot: 1, name: 'raw_gold', count: 50 }], new Set(), { [FOOD]: 'food' },
    mem.chestItems, chestSlots(mem));
  t.deepEqual(plan(w).moves, [{ chest: FOOD, name: 'carrot', count: 16 }], 'the 16 carrots fit its stack; no slot for the gold');
  t.deepEqual(plan(w).unplaced, [{ name: 'carrot', count: 48 }, { name: 'raw_gold', count: 50 }]);
  // a reply with a slot free: room again, counted as ever
  rememberReply(w, at(FOOD), 'Stored 16 carrot in the chest at (1, 64, 0). It holds: carrot x1664; 1/27 slots free.');
  t.deepEqual([...fullChests(w)], []);
  t.is(w.fullChests, undefined, 'nothing left in the list: it goes');
  t.is(chestSlots(w)(FOOD), 27);
  // an older reply without the slots: "the chest is full" is enough
  rememberReply(w, at(FOOD), 'Stored 0 raw_gold in the chest at (1, 64, 0) (the chest is full). It holds: carrot x1728.');
  t.deepEqual([...fullChests(w)], [FOOD]);

  // a look in (chest.open, as the kit and the sort round do before they plan) says the same, both ways; one that does
  // not say (an older fake, a reply with no count) leaves it as it was
  const { ctx } = game([], { [FOOD]: full('carrot', 26) });
  const looked = world({ [FOOD]: full('carrot', 27) }, { fullChests: [FOOD, MISC] });
  await peekChest(ctx(snap([]), looked), at(FOOD));
  t.deepEqual([...fullChests(looked)], [MISC]);
  t.deepEqual(looked.chestItems?.[FOOD], { carrot: 1664 });
  const stuffed = game([], { [FOOD]: full('carrot', 27) });
  await peekChest(stuffed.ctx(snap([]), looked), at(FOOD));
  t.deepEqual([...fullChests(looked)].sort(), [FOOD, MISC]);
  const quiet = world({ [FOOD]: [] }, { fullChests: [FOOD] });
  await peekChest({ ...ctx(snap([]), quiet), call: (async (m: string) => (m === 'chest.open' ? { items: {} } : {})) as GoalContext['call'] }, at(FOOD));
  t.deepEqual([...fullChests(quiet)], [FOOD]);

  // a brain.json with something else under the list: none is full, and the next reply writes it whole
  const odd = world({ [FOOD]: [] }, { fullChests: 'all of them' as unknown as string[] });
  t.deepEqual([...fullChests(odd)], []);
  t.is(chestSlots(odd)(FOOD), 27);
  rememberReply(odd, at(FOOD), STORE);
  t.deepEqual(odd.fullChests, [FOOD]);
});

test('a chest seen full: the plans count no free slot in it, only the room in its own stacks, the sort round\'s too', t => {
  // the misc chest: its memory packs into 23 slots, the game has all 27 used
  const w = world(house(), { chestAssign: SORTED });
  const s = snap(pocketsOf(27, [{ name: 'raw_gold', count: 50 }]));
  // not seen full yet: the plan sends the gold to the misc chest (the ores chest is full by its own memory)
  t.deepEqual(stashWork(s, w).moves, [{ chest: MISC, name: 'raw_gold', count: 50 }]);
  // seen full: what fits nowhere else goes to the first chest with room, the stone double chest's second half (its
  // memory packs 30 slots: past 27, it is a double chest of 54)
  w.fullChests = [MISC];
  const work = stashWork(s, w);
  t.deepEqual(work.moves, []);
  t.deepEqual(work.rest, [{ name: 'raw_gold', count: 50 }]);
  t.deepEqual(work.full, ['ores']);
  t.is(storeSlots(w)(STONE), 54);
  t.is(storeSlots(w)(MISC), 0);
  t.is(storeSlots(w)(FOOD), 27);
  const r = stashReach(s, w);
  t.deepEqual([...r.goes], [['raw_gold', 50]]);
  t.deepEqual(r.stuck, []);
  t.is(r.loose, 1);

  // the sort round moves nothing into a full chest either, but what its own stacks still take (10 of the 40)
  const assign = { [FOOD]: 'food', [STONE]: 'stone' };
  const contents = { [FOOD]: { carrot: 1590 }, [STONE]: { carrot: 40, cobblestone: 64 } };
  const seen = (k: string) => (k === FOOD ? 0 : 27);
  t.deepEqual(misplaced(assign, contents), [{ from: STONE, to: FOOD, name: 'carrot', count: 40 }]);
  t.deepEqual(misplaced(assign, contents, 8, seen), [{ from: STONE, to: FOOD, name: 'carrot', count: 10 }]);
  t.deepEqual(misplaced(assign, { ...contents, [FOOD]: { carrot: 1600 } }, 8, seen), []);
});

test('the misc chest of Nov 14: one look in or one reply, and the plan never sends the gold there again; it goes where there is room', async t => {
  const items = pocketsOf(27, [{ name: 'raw_gold', count: 50 }]);
  const s = snap(items);
  const sizes = { [STONE]: 54 };

  // the deposit's own reply: the first put-away finds the misc chest full, and moves nothing
  const w = world(house(), { chestAssign: SORTED });
  const first = game(items, house(), sizes);
  t.deepEqual(await putAway(first.ctx(s, w), s, stashKeep(w)), { stored: 0, dropped: 0 });
  t.deepEqual(first.g.acts, [`store 0/50 raw_gold at ${MISC}`]);
  t.deepEqual([...fullChests(w)], [MISC]);
  // the plan knows now: nothing is stuck, the gold goes to the stone chest's second half, and the next put-away
  // passes the misc chest by (the food and ore chests, not seen full yet, are tried and say so)
  t.deepEqual(stashReach(s, w).stuck, []);
  const again = game(items, house(), sizes);
  t.deepEqual(await putAway(again.ctx(s, w), s, stashKeep(w)), { stored: 50, dropped: 0 });
  t.deepEqual(again.g.acts, [`store 0/50 raw_gold at ${FOOD}`, `store 0/50 raw_gold at ${ORES}`, `store 50/50 raw_gold at ${STONE}`]);
  t.deepEqual([...fullChests(w)].sort(), [FOOD, ORES, MISC], 'and each chest that said it was full is remembered so');
  t.is(again.g.used(), 26);

  // the kit's and the sort round's look in first (every chest opened): the very first put-away goes straight there
  const peeked = world(house(), { chestAssign: SORTED });
  const looked = game(items, house(), sizes);
  for (const k of [FOOD, ORES, MISC, STONE]) await peekChest(looked.ctx(s, peeked), at(k));
  t.deepEqual([...fullChests(peeked)].sort(), [FOOD, ORES, MISC]);
  looked.g.acts = [];
  t.deepEqual(await putAway(looked.ctx(s, peeked), s, stashKeep(peeked)), { stored: 50, dropped: 0 });
  t.deepEqual(looked.g.acts, [`store 50/50 raw_gold at ${STONE}`]);

  // storeInChests passes a full chest by, unless its own stacks of the kind have room
  const part = world({ [FOOD]: full('carrot', 26).concat({ name: 'carrot', count: 40 }), [STONE]: [] }, { fullChests: [FOOD] });
  const tops = game([{ slot: 0, name: 'carrot', count: 64 }], { [FOOD]: full('carrot', 26).concat({ name: 'carrot', count: 40 }), [STONE]: [] });
  t.is(await storeInChests(tops.ctx(snap([]), part), 'carrot', 64), 64);
  t.deepEqual(tops.g.acts, [`store 24/64 carrot at ${FOOD}`, `store 40/40 carrot at ${STONE}`]);
  const by = game([{ slot: 0, name: 'raw_gold', count: 10 }], { [FOOD]: full('carrot', 27), [STONE]: [] });
  t.is(await storeInChests(by.ctx(snap([]), world({ [FOOD]: full('carrot', 27), [STONE]: [] }, { fullChests: [FOOD] })), 'raw_gold'), 10);
  t.deepEqual(by.g.acts, [`store 10/10 raw_gold at ${STONE}`]);
});

test('a take of whole stacks frees slots, and its reply says so: the chest is full no longer, and the stash goes for what fits there', t => {
  // the food chest of bread, the ore and misc chests, all seen full: the gold has nowhere to go
  const w = world({ [FOOD]: full('bread', 27), [ORES]: full('raw_iron', 27), [MISC]: MISC_STACKS() }, { chestAssign: SORTED, fullChests: [FOOD, ORES, MISC] });
  const s = snap(pocketsOf(27, [{ name: 'raw_gold', count: 50 }]));
  t.deepEqual(stashReach(s, w).stuck, ['raw_gold']);
  t.is(stash.wants(s, w), null);
  // the food goal takes a stack of bread: one slot free, and the reply counts it (an older build's said nothing, and
  // the mark stood till the next look in: the stash said "storage full" with a slot to spare)
  rememberReply(w, at(FOOD), 'Took 64 bread from the chest at (1, 64, 0). It holds: bread x1664; 1/27 slots free.');
  t.deepEqual([...fullChests(w)].sort(), [ORES, MISC]);
  t.deepEqual(w.chestItems?.[FOOD], { bread: 1664 });
  t.deepEqual([...stashReach(s, w).goes], [['raw_gold', 50]]);
  t.deepEqual(stashReach(s, w).stuck, []);
  t.is(stash.wants(s, w), '27/36 slots used');
  // one that leaves every slot used (part of a stack) keeps the mark
  rememberReply(w, at(ORES), 'Took 10 raw_iron from the chest at (2, 64, 0). It holds: raw_iron x1718; 0/27 slots free.');
  t.true(fullChests(w).has(ORES));
});

test('a double chest with its first half full is not full: the size a look in or a reply said counts, and the stash puts the gold in its second half', async t => {
  // live: the storage house is all double chests, each one landmark. The wood chest's first half is full (26 stacks
  // of logs and one of planks, 27 slots packed), its second half empty; every other chest is full and seen so
  const WOOD = '5,64,0';
  const wood = (): Stack[] => [...full('oak_log', 26), { name: 'oak_planks', count: 64 }];
  const chests = (): Record<string, Stack[]> => ({ [FOOD]: full('carrot', 27), [ORES]: full('raw_iron', 27), [MISC]: MISC_STACKS(), [WOOD]: wood() });
  const assign = { ...SORTED, [WOOD]: 'wood' };
  const items = pocketsOf(27, [{ name: 'raw_gold', count: 50 }]);
  const s = snap(items);
  const w = world(chests(), { chestAssign: assign, fullChests: [FOOD, ORES, MISC] });
  // its size never seen, and nothing in its memory past the first half: counted as one chest of 27, full by its things
  t.is(storeSlots(w)(WOOD), 27);
  t.deepEqual(stashReach(s, w).stuck, ['raw_gold']);
  // one look in (the kit's, the sort round's): 54 slots, 27 free
  const { g, ctx } = game(items, chests(), { [WOOD]: 54 });
  await peekChest(ctx(s, w), at(WOOD));
  t.deepEqual(w.chestSize, { [WOOD]: 54 });
  t.false(fullChests(w).has(WOOD));
  t.is(storeSlots(w)(WOOD), 54);
  t.is(chestSlots(w)(WOOD), 27, 'the wood category\'s own plan still counts its first half only');
  t.deepEqual([...stashReach(s, w).goes], [['raw_gold', 50]]);
  t.deepEqual(stashReach(s, w).stuck, []);
  t.is(stash.wants(s, w), '27/36 slots used');
  t.is(room('deep', s, w), 'stash');
  t.notRegex(noRoom('deep', 'deep', s, w).text, /storage full/);
  // and the stash's body puts it there: the full chests passed by, the double chest's second half takes it
  g.acts = [];
  t.deepEqual(await putAway(ctx(s, w), s, stashKeep(w)), { stored: 50, dropped: 0 });
  t.deepEqual(g.acts, [`store 50/50 raw_gold at ${WOOD}`]);
  t.is(g.chests[WOOD].stacks.length, 28);

  // a deposit's reply says the size too
  const told = world(chests(), { chestAssign: assign, fullChests: [FOOD, ORES, MISC] });
  rememberReply(told, at(WOOD), 'Stored 0 raw_gold in the chest at (5, 64, 0). It holds: oak_log x1664, oak_planks x64; 27/54 slots free.');
  t.is(storeSlots(told)(WOOD), 54);
  // a stack seen past the first half is a double chest too, before any size is said
  const seen = world(chests(), { chestStacks: { [WOOD]: [{ slot: 38, name: 'oak_log', count: 64 }] } });
  t.is(storeSlots(seen)(WOOD), 54);
  // a brain.json with something else under the sizes: the memory's guess, and the next reply writes them whole
  const odd = world(chests(), { chestSize: [54] as unknown as Record<string, number> });
  t.is(storeSlots(odd)(WOOD), 27);
  rememberReply(odd, at(WOOD), 'Stored 0 raw_gold in the chest at (5, 64, 0). It holds: oak_log x1664, oak_planks x64; 27/54 slots free.');
  t.deepEqual(odd.chestSize, { [WOOD]: 54 });
  // a size seen stands over the memory's guess (a double chest broken down to a single one, its things from before)
  t.is(storeSlots(world({ [STONE]: full('cobblestone', 30) }, { chestSize: { [STONE]: 27 } }))(STONE), 27);
});

// ---- the stash with the storage full ----

test('storage full: the stash does not want, the trips waiting on it say what has no room, and makeRoom tries nothing', async t => {
  // every chest full and seen so: the gold has nowhere to go, and nothing is to be thrown
  const chests = { [FOOD]: full('carrot', 27), [ORES]: full('raw_iron', 27), [MISC]: MISC_STACKS() };
  const w = world(chests, { chestAssign: SORTED, fullChests: [FOOD, ORES, MISC] });
  const gold = pocketsOf(27, [{ name: 'raw_gold', count: 50 }]);
  const s = snap(gold);
  t.deepEqual(stashReach(s, w).stuck, ['raw_gold']);
  t.is(stash.wants(s, w), null);
  t.is(stash.wants(snap(pocketsOf(36, [{ name: 'raw_gold', count: 50 }])), w), null, 'not at 36/36 either');
  t.deepEqual(pockets(s, w, 'deep'), { used: 27, free: 9, loose: 0 });
  t.is(room('deep', s, w), 'no');
  t.deepEqual(noRoom('deep', 'deep', s, w), { cause: 'pockets', text: '27/36 slots, storage full: raw_gold (deep needs 10 free)' });
  // the gates only look
  const before = JSON.stringify(w);
  stash.wants(s, w); room('deep', s, w); noRoom('trip', 'stock', s, w); stashReach(s, w, 'trip');
  t.is(JSON.stringify(w), before);
  // a trip's own put-away says the same, and walks nowhere
  const { g, ctx } = game(gold, chests);
  await t.throwsAsync(makeRoom(ctx(s, w), 'deep'), { message: 'pockets: 27/36 slots, storage full: raw_gold (the mine needs 10 free)' });
  t.deepEqual(g.acts, []);
  t.is(w.lastDone?.['no room: deep'], undefined, 'nothing was tried: no mark');

  // the carrots over what it keeps are thrown by day (the chests hold more than their cap): it wants for that
  const carrots = snap(pocketsOf(27, [{ name: 'raw_gold', count: 50 }, { name: 'carrot', count: 64 }, { name: 'carrot', count: 30 }]));
  t.deepEqual(stashReach(carrots, w).stuck, ['raw_gold']);
  t.deepEqual([...stashReach(carrots, w).goes], [['carrot', 30]]);
  t.is(stash.wants(carrots, w), '27/36 slots used');
  // by evening the junk and the glut wait for the morning: nothing can go, so no want
  t.is(stash.wants({ ...carrots, activity: 'return', timeOfDay: 12_500 }, w), null);
  // a kind its chest still has room for in its own stacks: it wants (the 14 of the 50 that fit)
  const room14 = world({ ...chests, [ORES]: full('raw_iron', 26).concat({ name: 'raw_gold', count: 50 }) }, { chestAssign: SORTED, fullChests: [FOOD, ORES, MISC] });
  t.deepEqual([...stashReach(s, room14).goes], [['raw_gold', 14]]);
  t.is(stash.wants(s, room14), '27/36 slots used');
  // no chest at home yet, and the planks for one: it wants (its run puts the chest down first)
  const bare = { landmarks: { chests: [], farmland: [] }, leash: 96 } as WorldMemory;
  t.is(stash.wants(snap(pocketsOf(27, [{ name: 'oak_planks', count: 64 }])), bare), '27/36 slots used');
});

test('a stash that moved nothing with the storage full: it says so once, and does not go again for the same things for 30 min', async t => {
  // the memory says the ores and misc chests have room (looked in before the farm round filled them); the game says no
  const game3 = () => game([], { [FOOD]: full('carrot', 27), [ORES]: full('raw_iron', 27), [MISC]: MISC_STACKS() });
  const items = pocketsOf(27, [{ name: 'raw_gold', count: 50 }, { name: 'leather', count: 20 }]);
  const s = snap(items);
  const w = world({ [FOOD]: full('carrot', 27), [ORES]: full('raw_iron', 20), [MISC]: [] }, { chestAssign: SORTED });
  t.is(stash.wants(s, w), '27/36 slots used');
  const { g, ctx } = game3();
  g.inv = items.map(i => ({ ...i }));
  await t.throwsAsync(stash.run(ctx(s, w)), { message: 'storage full: raw_gold, leather (the chests for ores, mobdrops have no room)' });
  t.deepEqual(g.acts, [`store 0/50 raw_gold at ${ORES}`, `store 0/20 leather at ${MISC}`]);
  t.deepEqual(w.stashStuck, { at: NOW, kinds: ['raw_gold', 'leather'] });
  // and it does not want: the replies told the memory, nothing can go
  t.is(stash.wants(s, w), null);

  // the ores chest is seen with a slot free again (something was taken out): the gold could go, but that is what the
  // last run could not put away 3 min ago: it waits the 30 min out
  rememberReply(w, at(ORES), 'Stored 0 coal in the chest at (2, 64, 0). It holds: raw_iron x1664; 1/27 slots free.');
  const later = (min: number, over: InventoryItem[] = items) => snap(over, { now: NOW + min * MIN });
  t.deepEqual([...stashReach(later(3), w).goes], [['raw_gold', 50]]);
  t.is(stash.wants(later(3), w), null);
  t.is(stash.wants(later(29), w), null);
  // something new it can move (junk for the dump, by day): it goes at once
  const junk = pocketsOf(27, [{ name: 'raw_gold', count: 50 }, { name: 'leather', count: 20 }, { name: 'poisonous_potato', count: 5 }]);
  t.is(stash.wants(later(3, junk), w), '27/36 slots used');
  // and after the 30 min, the gold again
  t.is(stash.wants(later(30), w), '27/36 slots used');
  // a run that puts something away ends the wait
  const ok = game([], { [FOOD]: full('carrot', 27), [ORES]: full('raw_iron', 26), [MISC]: MISC_STACKS() });
  ok.g.inv = items.map(i => ({ ...i }));
  t.regex(await stash.run(ok.ctx(later(30), w)), /^put 50 item\(s\) in the chests/);
  t.is(w.stashStuck, undefined);

  // with fewer than three chests there are no categories to name
  const one = world({ [FOOD]: [] });
  const solo = game([], { [FOOD]: full('cobblestone', 27) });
  solo.g.inv = items.map(i => ({ ...i }));
  await t.throwsAsync(stash.run(solo.ctx(s, one)), { message: 'storage full: raw_gold, leather (the chests have no room)' });
  // where the plan still has room after the replies (a chest not looked in yet that would not open), the old words
  const two = world({ [FOOD]: [], [MISC]: [] });
  const shut = game([], { [FOOD]: full('cobblestone', 27), [MISC]: [] });
  shut.g.inv = items.map(i => ({ ...i }));
  const c = shut.ctx(s, two);
  const blocked: GoalContext = { ...c, act: async (name, a = {}) => (name === 'store-in-chest' && a.x === 3 ? { ok: false, text: 'The chest at (3, 64, 0) did not open' } : c.act(name, a)) };
  await t.throwsAsync(stash.run(blocked), { message: 'nothing could be put away' });
  t.is(two.stashStuck, undefined);
});

// ---- the let-go: the LOOP of 10:40-10:43Z ----

const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const settle = () => new Promise(r => setTimeout(r, 20));
const HOME = { x: 0, y: 64, z: 0 };

/** A bot at home in the world `seed:1`, by day. The `slow` tool returns when the test says `finish`. */
function fakeRuntime() {
  let release: (() => void) | undefined;
  const rt: ClientRuntime = {
    actions: { slow: async () => { await new Promise<void>(r => { release = r; }); return reply('slow done'); } },
    call: (async (method: string) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      if (method === 'inventory') return { items: [] };
      if (method === 'world.region') return { blocks: new Array(25 * 11 * 25).fill('air') };
      if (method === 'cancel') { release?.(); return {}; }
      return {};
    }) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: HOME, block: HOME, timeOfDay: 6000, hashedSeed: '1',
      dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined,
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  };
  return { rt, finish: () => release?.() };
}

/**
 * The stash of 10:39:16Z on Nov 14, as the brain saw it: let go by the idle watchdog, it put 33 things away in 4 s,
 * and from then on every run failed at once with `fail(n)` (n the failure), held 10 min each time.
 */
async function replay(fail: (n: number) => string) {
  const { rt, finish } = fakeRuntime();
  const T0 = Date.UTC(2026, 10, 14, 10, 39, 16);
  let clock = T0, runs = 0;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'storagefull-')), 'brain.log');
  const stashLike: Goal = {
    name: 'stash', priority: 60, timeoutMs: 6 * MIN, retryMs: 10 * MIN, wants: () => '27/36 slots used',
    run: async ctx => {
      runs++;
      if (runs === 1) { await ctx.act('slow'); return 'put 33 item(s) in the chests'; }
      throw new Error(fail(runs - 1));
    }
  };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [stashLike], logFile: log });
  brain.setEnabled(true);
  await brain.tick(); await settle();     // 10:39:16 the run that stored 33
  clock += 4000; await brain.tick();      // 10:39:20 a look while it runs
  finish(); await settle();               // done; the hand-over starts it again, and it fails
  const said = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => `${l.slice(11, 19)} ${l.slice(25)}`);
  const until = async (hhmmss: string) => {
    const [h, m, sec] = hhmmss.split(':').map(Number);
    const end = Date.UTC(2026, 10, 14, h, m, sec);
    while (clock + 5000 <= end) { clock += 5000; await brain.tick(); await settle(); }
  };
  return { brain, said, until, starts: () => said().filter(l => / start stash/.test(l)).length, off: () => brain.setEnabled(false) };
}

test('the LOOP of 10:40-10:43Z replayed: an early release, the watchdog\'s let-go, and then no early release of a goal failing the same way: no fourth run', async t => {
  for (const [what, fail] of [['the live words', () => 'nothing could be put away'], ['numbers aside', (n: number) => `pockets still ${26 + n}/36 after putting away`]] as const) {
    const r = await replay(fail);
    await r.until('10:44:30');
    const lines = r.said().filter(l => /start stash|failed stash|done stash|let go|LOOP/.test(l));
    t.deepEqual(lines, [
      '10:39:16 start stash: 27/36 slots used',
      '10:39:20 done stash in 4s: put 33 item(s) in the chests',
      '10:39:20 start stash: 27/36 slots used',
      `10:39:20 failed stash: ${fail(1)}`,
      // a minute of standing about on its hold: let go early, once (it had failed once)
      `10:40:20 idle 60s on a hold: let go of stash (failed: ${fail(1)})`,
      '10:40:20 start stash: 27/36 slots used',
      `10:40:20 failed stash: ${fail(2)}`,
      // 3 min by day with nothing done: every hold goes, this one too
      '10:42:20 idle 3 min by day: let go of stash 480s',
      '10:42:20 start stash: 27/36 slots used',
      `10:42:20 failed stash: ${fail(3)}`
      // and at 10:43:20, a minute on its hold again: live, the early release freed it a fourth time (the watchdog had
      // undone its mark) and the loop watch caught it. It failed the same way twice in a row and more: it is not
      // let go early, and waits its hold out
    ], what);
    t.is(r.starts(), 4, what);
    // standing on: nothing frees it before its hold has run its 10 minutes
    await r.until('10:52:15');
    t.is(r.starts(), 4, what);
    t.deepEqual(r.said().filter(l => /LOOP/.test(l)), [], what);
    t.regex(r.brain.status(), /Retrying later: stash \d+s/, what);
    r.off();
  }
});

test('failures that say different things are not a repeat: the early release and the watchdog\'s let-go go on as before', async t => {
  const words = ['the chest at (1, 64, 0) did not open', 'no dump spot outside the fence it could get to', 'could not reach the chest at (3, 65, 0)', 'the walk home was cut short'];
  const r = await replay(n => words[n - 1]);
  await r.until('10:43:30');
  // each failure its own: freed early again a minute after the watchdog let everything go, as before F2
  t.deepEqual(r.said().filter(l => /let go/.test(l)), [
    `10:40:20 idle 60s on a hold: let go of stash (failed: ${words[0]})`,
    '10:42:20 idle 3 min by day: let go of stash 480s',
    `10:43:20 idle 60s on a hold: let go of stash (failed: ${words[2]})`
  ]);
  t.is(r.starts(), 5);
  r.off();
});

test('a goal that failed the same way twice in a row is not let go early, freed early before or not; the watchdog\'s let-go still frees it', async t => {
  const { rt } = fakeRuntime();
  const T0 = Date.UTC(2026, 10, 14, 14, 0, 0);
  let clock = T0, runs = 0, resting = true;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'storagefull-')), 'brain.log');
  // it fails at once, the same way each time, and waits 100 s after each failure
  const flaky: Goal = { name: 'flaky', priority: 5, wants: () => 'wants', timeoutMs: MIN, retryMs: 100_000, run: async () => { runs++; throw new Error(`pockets still ${26 + runs}/36 after putting away`); } };
  // while it rests, the idle time is booked to its health, not to the hold: no early release
  const rest: Goal = { name: 'rest', priority: 1, wants: () => null, declines: () => (resting ? { cause: 'health', text: 'resting' } : { cause: 'unneeded', text: 'rested' }), run: async () => 'rest', timeoutMs: MIN, retryMs: MIN };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [flaky, rest], logFile: log });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); await settle(); } };
  await brain.tick(); await settle(); // 14:00:00 the first failure
  await ticks(20);                    // 14:01:40 its hold ran its full time: the second, the same but for a number
  t.is(runs, 2);
  resting = false;                    // from here the hold is what the bot stands about for
  await ticks(15);                    // 14:02:55: a minute and a quarter of it
  // never let go early: it was never freed early, but it has failed the same way twice in a row
  t.is(runs, 2);
  t.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(l => /on a hold/.test(l)), []);
  await ticks(1);                     // 14:03:00: the idle watchdog's 3 minutes let every hold go, this one too
  t.is(runs, 3);
  t.regex(fs.readFileSync(log, 'utf8'), /idle 3 min by day: let go of flaky \d+s/);
  brain.setEnabled(false);
});

test('the watchdog\'s let-go keeps the early release\'s mark on a goal failing the same way: after it runs well once, the next hold still runs its full time', async t => {
  const { rt } = fakeRuntime();
  const T0 = Date.UTC(2026, 10, 14, 14, 0, 0);
  let clock = T0;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'storagefull-')), 'brain.log');
  // fails, fails the same way, runs well (let go by the watchdog), then fails again
  const script = ['fail', 'fail', 'ok', 'fail', 'fail'];
  let runs = 0;
  const flaky: Goal = {
    name: 'flaky', priority: 5, wants: () => 'wants', timeoutMs: MIN, retryMs: 10 * MIN,
    run: async () => { if (script[runs++] === 'ok') return 'fine'; throw new Error('the chest at (2, 64, 0) is full'); }
  };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [flaky], logFile: log });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); await settle(); } };
  const lines = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => `${l.slice(11, 19)} ${l.slice(25)}`).filter(l => / (start|done|failed) flaky|let go/.test(l));
  await brain.tick(); await settle(); // 14:00:00 fails
  await ticks(48);                    // to 14:04:00
  t.deepEqual(lines(), [
    '14:00:00 start flaky: wants',
    '14:00:00 failed flaky: the chest at (2, 64, 0) is full',
    '14:01:00 idle 60s on a hold: let go of flaky (failed: the chest at (2, 64, 0) is full)',
    '14:01:00 start flaky: wants',
    '14:01:00 failed flaky: the chest at (2, 64, 0) is full',
    '14:03:00 idle 3 min by day: let go of flaky 480s',
    '14:03:00 start flaky: wants',
    '14:03:00 done flaky in 0s: fine',
    '14:03:05 start flaky: wants',
    '14:03:05 failed flaky: the chest at (2, 64, 0) is full'
  ]);
  // a minute and more on that hold: once let go early and never since a hold ran its full time, it is not let go
  // early now (the watchdog kept the mark: it was failing the same way when it let everything go)
  await ticks(12);                    // 14:05:00
  t.is(runs, 4);
  await ticks(97);                    // 14:13:05: the hold has run its full time
  t.is(runs, 5);
  brain.setEnabled(false);
});
