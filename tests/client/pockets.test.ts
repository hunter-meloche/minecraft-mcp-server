import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { putAway, stash, stashKeep, stashList, stock } from '../../src/client/brain/chores.js';
import { GLUT, ROOM, makeRoom, noRoom, out as afield, pockets, room, type RoomKind } from '../../src/client/brain/pockets.js';
import { workGoals, workOf, type WorkTask } from '../../src/client/brain/work.js';
import { food, gatherFood } from '../../src/client/brain/food.js';
import { deepTrip } from '../../src/client/brain/deep.js';
import { no, type Goal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';
import { Brain, decide } from '../../src/client/brain/brain.js';
import { brainRun, type ClientRuntime, type InventoryItem, type Status } from '../../src/client/tools.js';
import type { BuildJob, WorldMemory } from '../../src/client/brain/memory.js';
import { stackSize } from '../../src/client/brain/storage.js';
import { TREE } from '../../src/client/brain/tree.js';
import { structureGoal } from '../../src/client/structures/job.js';
import { StructureStore } from '../../src/client/structures/store.js';

type Pos = { x: number; y: number; z: number };
const CHEST = { x: 1, y: 64, z: 0 };
const KEY = '1,64,0';
const KINDS = Object.keys(ROOM) as RoomKind[];

const world = (over: Partial<WorldMemory> = {}): WorldMemory => ({
  landmarks: { chests: [CHEST], farmland: [], furnace: { x: -1, y: 64, z: 0 } }, leash: 96, chestItems: { [KEY]: {} }, ...over,
} as WorldMemory);

const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 },
    dimension: 'overworld', sleeping: false, raining: false, thundering: false, process: null, items, counts,
    slotsUsed: items.filter(i => i.slot < 36).length, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over,
  };
};
/** the bot stands here, this far from its home at (0, 64, 0) */
const out = (x: number, z: number): Partial<Snapshot> => ({ position: { x, y: 64, z }, distHome: Math.hypot(x, z) });

const tool = (slot: number, name: string, maxDamage = 131): InventoryItem => ({ slot, name, count: 1, damage: 0, maxDamage });
/** the kit's tools: a pickaxe and its spare, and one of each other kind: all of it stays carried */
const tools = (): InventoryItem[] => ['stone_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'stone_hoe'].map((n, i) => tool(i, n));
/** nine slots the stash leaves alone */
const kit = (): InventoryItem[] => [...tools(), { slot: 6, name: 'torch', count: 20 }, { slot: 7, name: 'cobblestone', count: 40 }, { slot: 8, name: 'bread', count: 5 }];
const stacks = (name: string, n: number, from: number, count = 64): InventoryItem[] => Array.from({ length: n }, (_, i) => ({ slot: from + i, name, count }));
/** one of each: food kinds under the carry cap, so the stash keeps every one */
const KEPT = ['apple', 'cooked_porkchop', 'cooked_cod', 'cooked_salmon', 'cookie', 'melon_slice', 'dried_kelp', 'cooked_beef', 'cooked_chicken',
  'carrot', 'baked_potato', 'pumpkin_pie', 'cooked_rabbit', 'cooked_mutton', 'beetroot', 'sweet_berries', 'glow_berries', 'porkchop', 'cod', 'salmon',
  'beef', 'chicken', 'potato', 'rabbit', 'mutton', 'tropical_fish', 'honey_bottle'];
/** pads the pockets to `used` slots with things the stash keeps */
const fill = (items: InventoryItem[], used: number): InventoryItem[] => {
  const all = [...items];
  const names = KEPT.filter(n => !all.some(i => i.name === n));
  for (let slot = 0; slot < 36 && all.length < used; slot++) {
    if (all.some(i => i.slot === slot)) continue;
    const name = names.shift();
    if (!name) throw new Error('the fixture ran out of kept kinds');
    all.push({ slot, name, count: 1 });
  }
  if (all.length !== used) throw new Error(`the fixture holds ${all.length} slots, not ${used}`);
  return all.sort((a, b) => a.slot - b.slot);
};
/** `used` slots, `loose` of them full stacks of logs (the only thing the stash would move) */
const pack = (used: number, loose: number): InventoryItem[] => fill([...kit(), ...stacks('oak_log', loose, 9)], used);

// A stand-in for the game with its own arithmetic: pockets of 36 slots and chests of 27, each a list of stacks. The
// moves go by slot as the game's do (ascending, a whole stack while it fits the count, then part of one), so what the
// stash's body really frees can be held against what `pockets` said it would.
interface Bot {
  inv: InventoryItem[]; chests: Record<string, { name: string; count: number }[]>;
  pos: Pos; time: number; sleeping: boolean; dimension: string;
  acts: string[]; walks: Record<string, unknown>[]; calls: string[];
  after?: (tool: string) => void;
  used: () => number; count: (name: string) => number; held: (key?: string) => Record<string, number>;
  act: (tool: string, a: Record<string, unknown>) => { ok: boolean; text: string };
  call: (method: string, params?: Record<string, unknown>) => unknown;
  status: () => Status;
}

function bot(items: InventoryItem[], chests: Record<string, Record<string, number>> = { [KEY]: {} }): Bot {
  const m: Bot = {
    inv: items.map(i => ({ ...i })), chests: {}, pos: { x: 0, y: 64, z: 0 }, time: 1000, sleeping: false, dimension: 'overworld',
    acts: [], walks: [], calls: [],
    used: () => m.inv.filter(i => i.slot < 36).length,
    count: name => m.inv.filter(i => i.name === name).reduce((n, i) => n + i.count, 0),
    held: (k = KEY) => {
      const t: Record<string, number> = {};
      for (const st of m.chests[k] ?? []) t[st.name] = (t[st.name] ?? 0) + st.count;
      return t;
    },
    act: (name, a) => {
      const k = `${a.x},${a.y},${a.z}`;
      const where = `(${a.x}, ${a.y}, ${a.z})`;
      const holds = () => Object.entries(m.held(k)).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
      const item = String(a.item);
      const mine = () => m.inv.filter(i => i.name === item && i.slot < 36).sort((x, y) => x.slot - y.slot);
      if (name === 'store-in-chest') {
        const have = m.count(item);
        if (!have) return { ok: false, text: `No ${item} in the inventory` };
        const want = Math.min((a.count as number | undefined) ?? have, have);
        let moved = 0;
        for (const i of mine()) {
          if (moved >= want) break;
          const went = intoChest(m.chests[k] ??= [], item, Math.min(i.count, want - moved));
          i.count -= went;
          moved += went;
          if (!went) break;
        }
        m.inv = m.inv.filter(i => i.count > 0);
        m.acts.push(`store-in-chest ${item} ${a.count ?? 'all'}`);
        return { ok: true, text: `Stored ${moved} ${item} in the chest at ${where}${moved < want ? ' (the chest is full)' : ''}. It holds: ${holds()}; ${27 - m.chests[k].length}/27 slots free.` };
      }
      if (name === 'take-from-chest') {
        m.acts.push(`take-from-chest ${item} ${a.count ?? 'all'}`);
        const inside = m.held(k)[item] ?? 0;
        if (!inside) return { ok: false, text: `The chest at ${where} has no ${item}. It holds: ${holds()}` };
        const want = Math.min((a.count as number | undefined) ?? inside, inside);
        const size = stackSize(item);
        let moved = 0;
        for (const i of mine()) {
          const n = Math.min(want - moved, size - i.count);
          i.count += n;
          moved += n;
        }
        for (let slot = 0; slot < 36 && moved < want; slot++) {
          if (m.inv.some(i => i.slot === slot)) continue;
          const n = Math.min(want - moved, size);
          m.inv.push({ slot, name: item, count: n });
          moved += n;
        }
        let left = moved;
        for (const st of m.chests[k]) {
          if (st.name !== item) continue;
          const n = Math.min(left, st.count);
          st.count -= n;
          left -= n;
        }
        m.chests[k] = m.chests[k].filter(st => st.count > 0);
        return { ok: true, text: `Took ${moved} ${item} from the chest at ${where}${moved < want ? ' (the inventory is full)' : ''}. It holds: ${holds()}.` };
      }
      if (name === 'drop-item') {
        if (!m.count(item)) return { ok: false, text: `No ${item} in the inventory` };
        let left = a.count as number;
        for (const i of mine()) {
          const n = Math.min(left, i.count);
          i.count -= n;
          left -= n;
        }
        m.inv = m.inv.filter(i => i.count > 0);
        m.acts.push(`drop-item ${item} ${a.count}`);
        return { ok: true, text: `Dropped ${(a.count as number) - left} ${item}` };
      }
      if (name === 'move-to-position') {
        m.pos = { x: a.x as number, y: a.y as number, z: a.z as number };
        m.acts.push(`move-to-position ${a.x},${a.y},${a.z}`);
        return { ok: true, text: 'Arrived' };
      }
      if (name === 'go-home') {
        m.pos = { x: 0, y: 64, z: 0 };
        m.acts.push('go-home');
        return { ok: true, text: 'Home' };
      }
      throw new Error(`no tool ${name}`);
    },
    call: (method, params) => {
      m.calls.push(method);
      if (method === 'inventory') return { items: m.inv.map(i => ({ ...i })) };
      if (method === 'goto') {
        m.walks.push(params ?? {});
        m.pos = { x: params?.x as number, y: params?.y as number, z: params?.z as number };
        return {};
      }
      if (method === 'chest.open') return { items: m.held(`${params?.x},${params?.y},${params?.z}`) };
      return {};
    },
    status: () => ({
      inWorld: true, username: 'Bot', screen: null, position: m.pos, block: m.pos, timeOfDay: m.time, hashedSeed: '1',
      dimension: m.dimension, sleeping: m.sleeping, health: 20, food: 20,
    }),
  };
  for (const [k, totals] of Object.entries(chests)) {
    m.chests[k] = [];
    for (const [name, n] of Object.entries(totals)) {
      if (intoChest(m.chests[k], name, n) !== n) throw new Error(`the fixture's chest ${k} cannot hold ${n} ${name}`);
    }
  }
  return m;
}

/** tops up the chest's stacks of the kind, then takes empty slots: how many went in */
function intoChest(slots: { name: string; count: number }[], name: string, n: number): number {
  const size = stackSize(name);
  let left = n;
  for (const st of slots) {
    if (st.name !== name || st.count >= size) continue;
    const went = Math.min(left, size - st.count);
    st.count += went;
    left -= went;
  }
  while (left > 0 && slots.length < 27) {
    const went = Math.min(left, size);
    slots.push({ name, count: went });
    left -= went;
  }
  return n - left;
}

type Ctx = GoalContext & { said: string[] };
function ctxOf(m: Bot, s: Snapshot, w: WorldMemory, signal: AbortSignal = new AbortController().signal): Ctx {
  const said: string[] = [];
  return {
    s, world: w, signal, said,
    act: async (name, args = {}) => {
      const r = m.act(name, args);
      m.after?.(name);
      if (signal.aborted) throw new Error('aborted');
      return r;
    },
    call: (async (method: string, params?: Record<string, unknown>) => m.call(method, params)) as GoalContext['call'],
    status: async () => m.status(),
    progress: text => { said.push(text); },
    gain: () => undefined,
  };
}
/** the game as the snapshot and the memory have it: what the memory says the chests hold is what they hold */
function live(s: Snapshot, w: WorldMemory, signal?: AbortSignal): { m: Bot; ctx: Ctx } {
  const m = bot(s.items, Object.fromEntries(w.landmarks.chests.map(c => [`${c.x},${c.y},${c.z}`, w.chestItems?.[`${c.x},${c.y},${c.z}`] ?? {}])));
  m.pos = { ...s.position };
  m.time = s.timeOfDay;
  m.sleeping = s.sleeping;
  m.dimension = s.dimension;
  return { m, ctx: ctxOf(m, s, w, signal) };
}

test('room is ok, stash, or no', t => {
  const w = world();
  // ten free is room for a deep dig; nine is not, and four stacks of logs can go into the chest
  t.is(room('deep', snap(pack(26, 4)), w), 'ok');
  t.deepEqual(pockets(snap(pack(27, 4)), w), { used: 27, free: 9, loose: 4 });
  t.is(room('deep', snap(pack(27, 4)), w), 'stash');
  t.is(pockets(snap(pack(27, 0)), w).loose, 0);
  t.is(room('deep', snap(pack(27, 0)), w), 'no');
  t.is(room('yard', snap(pack(27, 0)), w), 'ok');

  // one rule for every kind: the free slots first, then what the stash would free
  t.is(room('trip', snap(pack(35, 0)), w), 'no');
  t.is(room('yard', snap(pack(35, 0)), w), 'no');
  t.is(room('project', snap(pack(35, 0)), w), 'ok');
  t.is(room('yard', snap(pack(35, 1)), w), 'stash');
  t.is(room('trip', snap(pack(35, 1)), w), 'no');
  t.is(room('trip', snap(pack(35, 2)), w), 'stash');
  t.is(room('project', snap(pack(36, 0)), w), 'no');
  t.is(room('project', snap(pack(36, 1)), w), 'stash');

  // the chests are in reach anywhere in the yard, however long it is, and within 40 of home outside it
  const yard = { x1: -8, z1: -8, x2: 72, z2: 8, y: 64 };
  const full = pack(35, 4);
  t.is(room('trip', snap(full, out(64, 0)), world({ yard })), 'stash', 'the far end of the yard, 64 from home');
  t.is(room('trip', snap(full, out(0, 50)), world({ yard })), 'no', 'outside the yard, beyond 40');
  t.is(room('trip', snap(full, out(0, 30)), world({ yard })), 'stash', 'outside the yard, within 40');
  t.is(room('trip', snap(full, out(30, 0)), w), 'stash', 'no yard known: the range alone');
  t.is(room('trip', snap(full, out(40, 0)), w), 'stash');
  t.is(room('trip', snap(full, out(41, 0)), w), 'no');
  t.is(room('trip', snap(full, out(64, 0)), w), 'no');
  const elsewhere = { x1: 50, z1: -8, x2: 72, z2: 8, y: 64 };
  t.is(room('trip', snap(full, out(64, 0)), world({ yard: elsewhere })), 'no', 'a yard the home does not stand in is not the home\'s');
  t.is(room('trip', snap(full, out(30, 0)), world({ yard: elsewhere })), 'stash');

  // asleep, or in another dimension: never the stash
  t.is(room('trip', snap(full, { sleeping: true }), w), 'no');
  t.is(room('trip', snap(full, { dimension: 'the_nether', distHome: Infinity }), w), 'no');
  t.is(room('trip', snap(pack(20, 4), { sleeping: true }), w), 'ok', 'room to spare is room anywhere');
  t.is(room('trip', snap(pack(20, 4), { dimension: 'the_nether', distHome: Infinity }), w), 'ok');
  // no chests, or no home
  t.is(room('trip', snap(full), world({ landmarks: { chests: [], farmland: [] } })), 'no');
  t.is(room('trip', snap(full, { home: undefined, distHome: Infinity }), w), 'no');

  // it runs in the gates on every tick: nothing is written
  const three = world({
    landmarks: { chests: [CHEST, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }], farmland: [] },
    chestItems: { [KEY]: { oak_log: 64 }, '2,64,0': { raw_iron: 3 }, '3,64,0': {} },
  });
  for (const mem of [w, three, world({ yard })]) {
    const before = JSON.stringify(mem);
    for (const kind of KINDS) {
      room(kind, snap(full), mem);
      pockets(snap(full), mem, kind);
    }
    t.is(JSON.stringify(mem), before);
  }
});

test('a decline for pockets names the rule; "chests full" only when storage is maxed and nothing is loose', t => {
  t.deepEqual(noRoom('trip', 'stock', snap(pack(35, 0)), world()), { cause: 'pockets', text: '35/36 slots, nothing to put away (stock needs 3 free)' });
  t.is(noRoom('deep', 'deep', snap(pack(30, 0)), world()).text, '30/36 slots, nothing to put away (deep needs 10 free)');
  t.is(noRoom('project', 'project', snap(pack(36, 0)), world({ storageMaxedAt: 1 })).text, 'chests full (36/36 slots)');
  t.is(noRoom('project', 'project', snap(pack(36, 0)), world()).text, '36/36 slots, nothing to put away (project needs 1 free)');
  t.notRegex(noRoom('trip', 'stock', snap(pack(36, 1)), world({ storageMaxedAt: 1 })).text, /chests full/, 'a stack can still go: the chests are not what stops it');
  t.is(noRoom('trip', 'stock', snap(pack(35, 4), out(60, 0)), world()).text, '35/36 slots, the chests out of reach (stock needs 3 free)');
  // slots the stash would empty, and too few of them: not "nothing to put away" (the stash runs on these pockets, and
  // the line sent whoever read it looking for pockets full of kept things)
  t.deepEqual(pockets(snap(pack(33, 6)), world(), 'deep'), { used: 33, free: 3, loose: 6 });
  t.is(room('deep', snap(pack(33, 6)), world()), 'no');
  t.is(noRoom('deep', 'deep', snap(pack(33, 6)), world()).text, '33/36 slots, only 6 more to put away (deep needs 10 free)');
  t.is(noRoom('trip', 'stock', snap(pack(36, 1)), world({ storageMaxedAt: 1 })).text, '36/36 slots, only 1 more to put away (stock needs 3 free)');
  t.is(noRoom('trip', 'stock', snap(pack(36, 2)), world()).text, '36/36 slots, only 2 more to put away (stock needs 3 free)');
  // too few and out of reach as well: the count is what would not change by walking home
  t.is(noRoom('deep', 'deep', snap(pack(33, 6), out(60, 0)), world()).text, '33/36 slots, only 6 more to put away (deep needs 10 free)');
  // the goals that still carry their own number keep their wording
  t.is(no.pockets(snap(pack(35, 0)), 'cane', 34).text, '35/36 slots (cane runs under 34)');
});

const job = (over: Partial<BuildJob> = {}): BuildJob => ({
  id: 8, world: 'w', structure: 'barn', mode: 'apply', status: 'working', phase: 'building', createdAt: 0, updatedAt: 0, ...over,
});
const carrying = (...carry: string[]): WorldMemory['progress'] => ({ done: [], journal: [], carry });
/** back from a build's gathering: 35 slots, 24 of them the project's logs and planks, and 168 bread */
const tripLoad = (): InventoryItem[] => [...tools(), ...stacks('bread', 2, 6), { slot: 8, name: 'bread', count: 40 }, { slot: 9, name: 'torch', count: 20 },
  { slot: 10, name: 'cobblestone', count: 40 }, ...stacks('oak_log', 15, 11), ...stacks('oak_planks', 9, 26)];

test('makeRoom for a trip puts the project carry and food over 64 away; not while a job is building', async t => {
  const s = snap(tripLoad());
  t.is(s.slotsUsed, 35);
  const w = world({ progress: carrying('oak_log', 'oak_planks') });
  // the stash's own keep leaves the project its load: only the bread over 64 goes, one slot of it
  t.is(pockets(s, w).loose, 1);
  t.is(pockets(s, w, 'yard').loose, 1);
  t.is(pockets(s, w, 'project').loose, 1);
  t.is(pockets(s, w, 'trip').loose, 25);
  t.is(pockets(s, w, 'deep').loose, 25);
  t.is(room('trip', s, w), 'stash');

  const home = live(s, w);
  await makeRoom(home.ctx, 'trip');
  t.is(home.m.used(), 10);
  t.is(home.m.count('oak_log') + home.m.count('oak_planks'), 0);
  t.is(home.m.count('bread'), 64);
  t.deepEqual(home.m.held(), { bread: 104, oak_log: 960, oak_planks: 576 });
  t.deepEqual(w.chestItems?.[KEY], { bread: 104, oak_log: 960, oak_planks: 576 }, 'the memory has what the chest took');
  t.deepEqual(home.m.walks, [], 'at the chests already');
  t.false(home.m.acts.some(a => a.startsWith('take-from-chest')), 'nothing takes the carry back');

  // 30 out: the walk home is the careful one (no block placed or broken inside the homestead), then the same body
  const w2 = world({ progress: carrying('oak_log', 'oak_planks') });
  const away = live(snap(tripLoad(), out(30, 0)), w2);
  await makeRoom(away.ctx, 'trip');
  t.deepEqual(away.m.walks, [{ x: 0, y: 64, z: 0, range: 3, careful: true, timeoutMs: 60_000 }]);
  t.is(away.m.acts[0], 'store-in-chest bread 104');
  t.false(away.m.acts.some(a => a === 'go-home' || a.startsWith('move-to-position')), 'no walk that may dig or bridge');
  t.is(away.m.used(), 10);

  // a job in phase building keeps its load, whatever asks for room
  const building = world({ buildJobs: [job({ carry: ['oak_log', 'oak_planks'] })] });
  t.true(stashKeep(building, 'trip').keep?.has('oak_log'));
  t.true(stashKeep(building, 'deep').keep?.has('oak_planks'));
  t.is(pockets(s, building, 'trip').loose, 1);
  t.is(room('trip', s, building), 'no');
  const held = live(s, building);
  await t.throwsAsync(makeRoom(held.ctx, 'trip'), { message: 'pockets: 35/36 slots, only 1 more to put away (a trip needs 3 free)' });
  t.deepEqual(held.m.acts, []);
  t.is(held.m.used(), 35);
  // and the project's own carry stays with it while any job builds
  t.true(stashKeep(world({ progress: carrying('oak_log'), buildJobs: [job()] }), 'trip').keep?.has('oak_log'));

  // a job still provisioning is not building: its carry goes for a trip, and stays for the stash's own round
  const provisioning = world({ buildJobs: [job({ phase: 'provisioning', carry: ['oak_log', 'oak_planks'] })] });
  t.false(stashKeep(provisioning, 'trip').keep?.has('oak_log'));
  t.true(stashKeep(provisioning).keep?.has('oak_log'));
  t.true(stashKeep(provisioning, 'yard').keep?.has('oak_log'));
  t.is(pockets(s, provisioning, 'trip').loose, 25);

  // the casting's buckets are project carry too: five empties stay for the stash, one for a trip
  const casting = world({ lavaCasting: true });
  const buckets = snap([...tools(), { slot: 6, name: 'bucket', count: 9 }, { slot: 7, name: 'water_bucket', count: 1 }, { slot: 8, name: 'lava_bucket', count: 1 }]);
  t.deepEqual(stashList(buckets, casting).deposit, [{ name: 'bucket', count: 4 }]);
  t.deepEqual(stashList(buckets, casting, stashKeep(casting, 'trip')).deposit, [{ name: 'bucket', count: 8 }, { name: 'lava_bucket', count: 1 }]);
});

test('room for a trip: dirt, seeds and saplings a job or the project carries go in the chests, never on the dump', async t => {
  // 256 dirt, 128 seeds and 64 saplings: 192, 96 and 48 over what the junk rule leaves carried (64, 32, 16). A trip's
  // room-making keeps no carry, and the junk rule spares only what is kept: the trip sent for a job's logs threw the
  // job's own dirt away
  const load = (used: number): InventoryItem[] => fill([...kit(), ...stacks('dirt', 4, 9), ...stacks('wheat_seeds', 2, 13), ...stacks('oak_sapling', 1, 15)], used);
  const mine = ['dirt', 'oak_sapling', 'wheat_seeds'];
  const byName = (list: { name: string; count: number }[]): Record<string, number> => Object.fromEntries(list.map(e => [e.name, e.count]));
  const over = { dirt: 192, wheat_seeds: 96, oak_sapling: 48 };
  const carriers: { name: string; w: () => WorldMemory }[] = [
    // a job that has built keeps its carry when its bill runs short again, and while it finishes
    { name: 'a job provisioning', w: () => world({ buildJobs: [job({ status: 'gathering', phase: 'provisioning', carry: mine })] }) },
    { name: 'a job finishing', w: () => world({ buildJobs: [job({ phase: 'finishing', carry: mine })] }) },
    { name: 'the project', w: () => world({ progress: carrying(...mine) }) },
  ];
  for (const { name, w } of carriers) {
    for (const kind of ['trip', 'deep'] as const) {
      // two free where a trip needs three, six where the mine needs ten
      const s = snap(load(kind === 'trip' ? 34 : 30));
      const list = stashList(s, w(), stashKeep(w(), kind));
      t.deepEqual(byName(list.deposit), over, `${name}, ${kind}`);
      t.deepEqual(list.drop, [], `${name}, ${kind}: nothing of it is junk`);
      // three stacks of dirt and one of seeds leave the pockets; the saplings only take a stack down
      t.is(pockets(s, w(), kind).loose, 4, `${name}, ${kind}`);
      t.is(room(kind, s, w()), 'stash', `${name}, ${kind}`);
      const { m, ctx } = live(s, w());
      await makeRoom(ctx, kind);
      t.deepEqual(m.acts, ['store-in-chest dirt 192', 'store-in-chest wheat_seeds 96', 'store-in-chest oak_sapling 48'], `${name}, ${kind}: no walk to the dump, nothing dropped`);
      t.deepEqual(m.held(), over, `${name}, ${kind}: the chest holds them, where the bills count them`);
      t.deepEqual([m.count('dirt'), m.count('wheat_seeds'), m.count('oak_sapling')], [64, 32, 16], `${name}, ${kind}`);
      t.is(m.used(), s.slotsUsed - 4, `${name}, ${kind}`);
    }
    // the stash's own round keeps the carry in the pockets, as it did
    t.deepEqual(stashList(snap(load(34)), w()), { deposit: [], drop: [] }, name);
  }

  // what nothing carries is junk as before: with only the saplings in a carry the dirt and the seeds go out
  const some = world({ progress: carrying('oak_sapling') });
  const s = snap(load(34));
  const list = stashList(s, some, stashKeep(some, 'trip'));
  t.deepEqual(byName(list.deposit), { oak_sapling: 48 });
  t.deepEqual(byName(list.drop), { dirt: 192, wheat_seeds: 96 });
  const { m, ctx } = live(s, some);
  await makeRoom(ctx, 'trip');
  t.deepEqual(m.acts.filter(a => a.startsWith('drop-item')), ['drop-item dirt 192', 'drop-item wheat_seeds 96']);
  t.deepEqual(m.held(), { oak_sapling: 48 });
  // and with no carry at all, all three
  t.deepEqual(byName(stashList(s, world(), stashKeep(world(), 'trip')).drop), over);
});

test('a building job with its load runs at 35/36 and the stash leaves it alone until 36/36', t => {
  const load = (): InventoryItem[] => [...kit(), ...stacks('cobblestone', 23, 9), { slot: 32, name: 'bone', count: 1 }, { slot: 33, name: 'string', count: 3 }, { slot: 34, name: 'gunpowder', count: 2 }];
  const s = snap(load());
  t.is(s.slotsUsed, 35);
  const w = (ago: number, phase: BuildJob['phase'] = 'building') => world({ buildJobs: [job({ phase, carry: ['cobblestone'] })], lastDone: { stash: s.now - ago } });
  const MIN = 60_000;
  // 35/36: the job has the one free slot it needs and the stash, with three things it could put away, keeps off
  t.is(room('project', s, w(11 * MIN)), 'ok');
  t.is(pockets(s, w(11 * MIN)).loose, 3);
  t.is(stash.wants(s, w(11 * MIN)), null);
  t.false(stash.cuts!(s, w(11 * MIN)));
  // the round at home after half an hour still asks, as it always did, but it does not stop the job for it
  t.is(stash.wants(s, w(60 * MIN)), '3 kinds of things to put away');
  t.false(stash.cuts!(s, w(60 * MIN)));

  // 36/36: the job would start losing what it picks up, so the stash stops it, and then not again for 10 min
  const all = snap([...load(), { slot: 35, name: 'flint', count: 1 }]);
  t.is(room('project', all, w(11 * MIN)), 'stash');
  t.is(stash.wants(all, w(11 * MIN)), '36/36 slots used');
  t.true(stash.cuts!(all, w(11 * MIN)));
  t.is(stash.wants(all, w(9 * MIN)), null);

  // the same pockets with the job still provisioning: the stash as for any other goal
  t.is(stash.wants(s, w(11 * MIN, 'provisioning')), '35/36 slots used');
  t.true(stash.cuts!(s, w(11 * MIN, 'provisioning')));
});

/** stored stone at its caps, and pockets with more of it: 19 slots */
const glutLoad = (): InventoryItem[] => [...kit(), ...stacks('cobblestone', 3, 9), { slot: 12, name: 'gravel', count: 64 }, { slot: 13, name: 'gravel', count: 30 },
  { slot: 14, name: 'andesite', count: 50 }, { slot: 15, name: 'raw_iron', count: 64 }, { slot: 16, name: 'dirt', count: 64 }, { slot: 17, name: 'dirt', count: 20 },
  { slot: 18, name: 'bread', count: 64 }];
const GLUTTED = { cobblestone: 640, gravel: 128, raw_iron: 320, bread: 320 };

test('glut is dropped, not stored; a kind a bill needs is never glut', async t => {
  // what digging turns up; and since Nov 14 (the produce filled the storage house) the farm's, the trees', the pens'
  // and the mobs' (caps.test.ts)
  const wool = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
  t.deepEqual(GLUT, {
    cobblestone: 640, cobbled_deepslate: 320, dirt: 320, gravel: 128, granite: 128, diorite: 128, andesite: 128, tuff: 128,
    carrot: 640, potato: 320, poisonous_potato: 0, beetroot: 320, beetroot_seeds: 64, wheat: 256, wheat_seeds: 128, bread: 640,
    melon_slice: 320, pumpkin: 64, sugar_cane: 512, kelp: 64, cactus: 64, bamboo: 64, sweet_berries: 64,
    apple: 128, beef: 256, porkchop: 128, chicken: 64, mutton: 128, egg: 32, feather: 128, rotten_flesh: 64, spider_eye: 32, bone: 192,
    ...Object.fromEntries(wool.map(c => [`${c}_wool`, 128]))
  });
  const s = snap(glutLoad());
  const w = (over: Partial<WorldMemory> = {}) => world({ chestItems: { [KEY]: { ...GLUTTED } }, ...over });
  const byName = (list: { name: string; count: number }[]): Record<string, number | undefined> => Object.fromEntries(list.map(e => [e.name, e.count]));

  // 232 cobblestone carried, 64 of it kept: the rest is over what the chests need, as is the gravel. The ore and the
  // food are stored however much there is, and andesite is under its cap
  const day = stashList(s, w());
  t.deepEqual(byName(day.deposit), { bread: 5, andesite: 50, raw_iron: 64 });
  t.deepEqual(byName(day.drop), { dirt: 20, cobblestone: 168, gravel: 94 });

  // what a bill needs is never glut: the project's, a job's, what a waiting job is still missing
  t.is(byName(stashList(s, w({ progress: { done: [], journal: [], need: { cobblestone: 100 } } })).deposit).cobblestone, 168);
  t.is(byName(stashList(s, w({ buildJobs: [job({ phase: 'provisioning', bill: { gravel: 200 } })] })).deposit).gravel, 94);
  t.is(byName(stashList(s, w({ buildJobs: [job({ status: 'waiting', missing: { gravel: 200 } })] })).drop).gravel, undefined);
  // what the project carries, when a trip makes room and keeps none of it (through the stash's own round the carry is
  // kept and says nothing of the glut)
  const trip = (mem: WorldMemory) => stashList(s, mem, stashKeep(mem, 'trip'));
  t.is(byName(trip(w()).drop).cobblestone, 168, 'with no carry it is glut for a trip too');
  const carried = trip(w({ progress: carrying('cobblestone') }));
  t.is(byName(carried.deposit).cobblestone, 168);
  t.is(byName(carried.drop).cobblestone, undefined);
  // what the blocked project came back short of
  const blocked = stashList(s, w({ progress: { done: [], journal: [], blocked: { id: 'house/walls', n: 1, at: 0, need: { gravel: 1 } } } }));
  t.is(byName(blocked.deposit).gravel, 94);
  t.is(byName(blocked.drop).gravel, undefined);
  // what is owed to a community chest: gathered and not delivered yet (nothing reserved for it here: the debt alone)
  const mission = (delivered: number): WorldMemory['community'] => ({
    chests: { community1: { x: 300, y: 64, z: 300 } }, nextId: 2,
    missions: [{ id: 1, item: 'cobblestone', count: 64, chest: 'community1', gathered: 10, delivered, status: 'active', createdAt: 0, updatedAt: 0 }],
  });
  const owing = stashList(s, w({ community: mission(0) }));
  t.is(byName(owing.deposit).cobblestone, 168);
  t.is(byName(owing.drop).cobblestone, undefined);
  t.is(byName(stashList(s, w({ community: mission(10) })).drop).cobblestone, 168, 'all of it delivered: nothing owed, glut again');
  // what is held back in the chests for a job; a reserve of none holds nothing back
  const reserved = stashList(s, w({ reserved: { job1: { gravel: 10 } } }));
  t.is(byName(reserved.deposit).gravel, 94);
  t.is(byName(reserved.drop).gravel, undefined);
  t.is(byName(stashList(s, w({ reserved: { job1: { gravel: 0 } } })).drop).gravel, 94);
  // what a levelling's fill took out of the chests for the yard and has not placed yet: only the dirt it is short of
  // is in the bill, and the cobblestone beside it was thrown away, taken out again, thrown away. Its dirt over a
  // stack goes in the chests with it, not out with the junk
  const short: WorldMemory['progress'] = { done: [], journal: [], need: { dirt: 53 } };
  const FILL = ['dirt', 'cobblestone', 'cobbled_deepslate'];
  const HOUR = 60 * 60_000;
  const filling = w({ progress: { ...short, fill: FILL, fillAt: s.now - 3 * HOUR } });
  for (const list of [stashList(s, filling), trip(filling)]) {
    t.is(byName(list.deposit).cobblestone, 168);
    t.is(byName(list.deposit).dirt, 20);
    t.is(byName(list.drop).cobblestone, undefined);
    t.is(byName(list.drop).dirt, undefined);
  }
  // a growth that was dropped, cancelled or no longer needed never clears its mark: not renewed for 4 h it lapses, and
  // stone and dirt are glut and junk again (else the storage house fills with them for good). A mark without a time
  // (an older memory) and one from the future (the clock set back) count as lapsed too
  for (const fillAt of [s.now - 4 * HOUR, undefined, s.now + HOUR]) {
    const left = w({ progress: { done: [], journal: [], fill: FILL, fillAt } });
    for (const list of [stashList(s, left), trip(left)]) t.deepEqual(byName(list.drop), { dirt: 20, cobblestone: 168, gravel: 94 }, `fillAt ${fillAt}`);
  }
  t.deepEqual(byName(stashList(s, w({ progress: short })).drop), { dirt: 20, cobblestone: 168, gravel: 94 }, 'the need for dirt alone spares neither');
  // a cap not reached: stored as ever
  const under = stashList(s, world({ chestItems: { [KEY]: { ...GLUTTED, cobblestone: 639 } } }));
  t.is(byName(under.deposit).cobblestone, 168);
  t.is(byName(under.drop).cobblestone, undefined);

  // in the evening nothing is carried out to the dump: the glut stays in the pockets, neither stored nor dropped
  const evening = stashList(snap(glutLoad(), { activity: 'return', timeOfDay: 12_500 }), w());
  t.deepEqual(byName(evening.deposit), { bread: 5, andesite: 50, raw_iron: 64 });
  t.deepEqual(evening.drop, []);

  // through the body: the chest takes none of the glut, and it goes at the dump spot, 14 out
  const mem = w();
  const { m, ctx } = live(s, mem);
  // bread 5, andesite and ore into the chest (3 slots); 168 cobblestone (3) and 94 gravel (2) out; the 20 dirt only tops a stack down
  t.is(pockets(s, mem).loose, 8);
  const r = await putAway(ctx, s, stashKeep(mem));
  t.deepEqual(r, { stored: 119, dropped: 282 });
  t.is(m.held().cobblestone, 640);
  t.is(m.held().gravel, 128);
  t.is(m.held().raw_iron, 384);
  t.is(m.count('cobblestone'), 64);
  t.is(m.count('dirt'), 64);
  t.is(m.count('gravel'), 0);
  t.is(m.used(), 19 - 8);
  const walk = m.acts.findIndex(a => a.startsWith('move-to-position'));
  const drops = m.acts.filter(a => a.startsWith('drop-item'));
  t.deepEqual(drops.sort(), ['drop-item cobblestone 168', 'drop-item dirt 20', 'drop-item gravel 94']);
  t.true(walk > m.acts.findIndex(a => a.startsWith('store-in-chest')), 'the chests first, then out to the dump');
  t.is(m.acts.at(-1), 'go-home');
  t.true(Math.hypot(m.pos.x, m.pos.z) === 0);
});

/** what the bot carried on the evening its pockets stood at 28/36 with nothing "loose": nine slots of it bread */
const liveKit = (): InventoryItem[] => [
  tool(0, 'diamond_pickaxe', 1561), tool(1, 'diamond_shovel', 1561), tool(2, 'iron_pickaxe', 250), tool(3, 'diamond_sword', 1561), tool(4, 'iron_axe', 250),
  tool(5, 'iron_pickaxe', 250), tool(6, 'diamond_hoe', 1561), { slot: 7, name: 'oak_sapling', count: 7 }, { slot: 8, name: 'torch', count: 16 },
  { slot: 9, name: 'wheat_seeds', count: 18 }, { slot: 10, name: 'wheat_seeds', count: 14 }, { slot: 11, name: 'cobblestone', count: 36 },
  { slot: 12, name: 'cobblestone', count: 10 }, { slot: 13, name: 'dirt', count: 39 }, { slot: 14, name: 'dirt', count: 25 }, { slot: 15, name: 'oak_log', count: 2 },
  { slot: 16, name: 'rotten_flesh', count: 8 }, { slot: 17, name: 'apple', count: 52 }, { slot: 18, name: 'bucket', count: 1 },
  ...stacks('bread', 7, 19), { slot: 26, name: 'bread', count: 60 }, { slot: 27, name: 'bread', count: 33 },
];

test('the food cap brings the kept kit to 20 slots: the live inventory of 28', async t => {
  const s = snap(liveKit());
  t.is(s.slotsUsed, 28);
  const w = world();
  // 541 bread, 64 of it carried on: seven full stacks go and the rest of the 477 comes off the next; and the two logs
  t.deepEqual(stashList(s, w), { deposit: [{ name: 'oak_log', count: 2 }, { name: 'bread', count: 477 }], drop: [] });
  t.is(pockets(s, w).loose, 8);
  t.true(s.slotsUsed - pockets(s, w).loose <= 20);
  const { m, ctx } = live(s, w);
  t.deepEqual(await putAway(ctx, s, stashKeep(w)), { stored: 479, dropped: 0 });
  t.true(m.used() <= 20, `${m.used()} slots after the stash`);
  t.is(m.count('bread'), 64);
  t.is(m.count('apple'), 52, 'a kind under the cap stays whole');
  t.is(m.inv.filter(i => i.name === 'iron_pickaxe').length, 2, 'the spare pickaxe and its twin, which cannot be told apart');
});

test('the stash walks to the chests with a harmless item in hand, never the casting\'s lava bucket it keeps (a water bucket held so poured itself in front of the storage house\'s door, Nov 14)', async t => {
  const s = snap([...kit(), { slot: 9, name: 'lava_bucket', count: 1 }, ...stacks('oak_log', 2, 10)]);
  const w = world({ lavaCasting: true });
  const { m, ctx } = live(s, w);
  // the lava bucket in hand, as a cast cut short left it; the bridge reports the hand
  let held = 'lava_bucket';
  const call = ctx.call;
  ctx.call = (async (method: string, p?: Record<string, unknown>) => {
    if (method === 'inventory') return { items: m.inv.map(i => ({ ...i })), held: { name: held, count: 1 } };
    if (method === 'item.select') { held = String(p?.name); return {}; }
    return call(method, p);
  }) as GoalContext['call'];
  const hands: string[] = [];
  m.after = tool => { if (tool === 'store-in-chest') hands.push(held); };
  t.deepEqual(await putAway(ctx, s, stashKeep(w)), { stored: 128, dropped: 0 });
  t.deepEqual(hands, ['stone_sword']);
  t.is(m.count('lava_bucket'), 1, 'the casting\'s bucket stays carried');
});

test('room says stash only when the stash then frees the slots', async t => {
  const three = [CHEST, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }];
  const fixtures: { name: string; items: InventoryItem[]; w: () => WorldMemory; over?: Partial<Snapshot>; frees: number }[] = [
    // more than the 64 kept, but what goes only takes a stack down
    { name: 'cobblestone 64 + 6', items: fill([...tools(), { slot: 6, name: 'cobblestone', count: 64 }, { slot: 7, name: 'cobblestone', count: 6 }], 35), w: world, frees: 0 },
    { name: 'cobblestone 6 + 64', items: fill([...tools(), { slot: 6, name: 'cobblestone', count: 6 }, { slot: 7, name: 'cobblestone', count: 64 }], 35), w: world, frees: 1 },
    // a chest with room in one stack only: 32 of the 84 logs fit, and they free a slot only when the small stack goes first
    { name: 'logs 64 + 20 into a stack of 32', items: fill([...tools(), { slot: 6, name: 'oak_log', count: 64 }, { slot: 7, name: 'oak_log', count: 20 }], 35),
      w: () => world({ chestItems: { [KEY]: { stone: 26 * 64, oak_log: 32 } } }), frees: 0 },
    { name: 'logs 20 + 64 into a stack of 32', items: fill([...tools(), { slot: 6, name: 'oak_log', count: 20 }, { slot: 7, name: 'oak_log', count: 64 }], 35),
      w: () => world({ chestItems: { [KEY]: { stone: 26 * 64, oak_log: 32 } } }), frees: 1 },
    // a third pickaxe of the kept kind cannot be told from the kept two by name: it stays. One of another name goes
    { name: 'a third stone pickaxe', items: fill([...tools(), tool(6, 'stone_pickaxe')], 34), w: world, frees: 0 },
    { name: 'a wooden pickaxe', items: fill([...tools(), tool(6, 'wooden_pickaxe', 59)], 34), w: world, frees: 1 },
    // junk goes out only by day
    { name: 'junk by day', items: fill([...tools(), ...stacks('dirt', 2, 6), { slot: 8, name: 'dirt', count: 10 }, { slot: 9, name: 'leaf_litter', count: 5 }], 35), w: world, frees: 2 },
    { name: 'junk in the evening', items: fill([...tools(), ...stacks('dirt', 2, 6), { slot: 8, name: 'dirt', count: 10 }, { slot: 9, name: 'leaf_litter', count: 5 }], 35),
      w: world, over: { activity: 'return', timeOfDay: 12_500 }, frees: 0 },
    { name: 'bread 64 + 64 + 40', items: fill([...tools(), ...stacks('bread', 2, 6), { slot: 8, name: 'bread', count: 40 }], 34), w: world, frees: 1 },
    { name: 'the project\'s load', items: tripLoad(), w: () => world({ progress: carrying('oak_log', 'oak_planks') }), frees: 1 },
    { name: 'glut', items: glutLoad(), w: () => world({ chestItems: { [KEY]: { ...GLUTTED } } }), frees: 8 },
    { name: 'the live kit', items: liveKit(), w: world, frees: 8 },
    // the chests full: nothing is loose, whatever is carried
    { name: 'a full chest', items: pack(35, 4), w: () => world({ chestItems: { [KEY]: { stone: 27 * 64 } } }), frees: 0 },
    { name: 'the first chest full', items: pack(35, 4),
      w: () => world({ landmarks: { chests: three.slice(0, 2), farmland: [] }, chestItems: { [KEY]: { stone: 27 * 64 }, '2,64,0': {} } }), frees: 4 },
    // sorted storage (three chests and up): each kind to its own chest
    { name: 'sorted storage', items: fill([...kit(), ...stacks('oak_log', 3, 9), { slot: 12, name: 'raw_iron', count: 40 }, { slot: 13, name: 'bone', count: 5 }, { slot: 14, name: 'string', count: 2 }], 34),
      w: () => world({ landmarks: { chests: three, farmland: [] }, chestItems: { [KEY]: { oak_log: 64 }, '2,64,0': { raw_iron: 3 }, '3,64,0': {} } }), frees: 6 },
    { name: 'sorted storage, full', items: pack(35, 4),
      w: () => world({ landmarks: { chests: three, farmland: [] }, chestItems: { [KEY]: { stone: 27 * 64 }, '2,64,0': { stone: 27 * 64 }, '3,64,0': { stone: 27 * 64 } } }), frees: 0 },
  ];
  const said = { ok: 0, stash: 0, no: 0 };
  for (const f of fixtures) {
    const s = snap(f.items, f.over);
    t.is(pockets(s, f.w()).loose, f.frees, f.name);
    for (const kind of KINDS) {
      const told = pockets(s, f.w(), kind);
      const answer = room(kind, s, f.w());
      // the stash's own body, on a game that holds what the memory says
      const w = f.w();
      const { m, ctx } = live(s, w);
      await putAway(ctx, s, stashKeep(w, kind));
      const freed = s.slotsUsed - m.used();
      t.is(freed, told.loose, `${f.name}, ${kind}: the stash frees what pockets() counted`);
      if (answer === 'stash') t.true(told.free + freed >= ROOM[kind], `${f.name}, ${kind}: stash, and the slots are there after`);
      t.is(answer, told.free >= ROOM[kind] ? 'ok' : told.free + freed >= ROOM[kind] ? 'stash' : 'no', `${f.name}, ${kind}`);
      said[answer]++;
    }
  }
  t.true(said.ok > 0 && said.stash > 0 && said.no > 0, JSON.stringify(said));
});

test('makeRoom throws when the room cannot be made, and says which way', async t => {
  // nothing loose: no walk, no chest opened, and the reason in the rule's own words
  const tight = live(snap(pack(35, 0)), world());
  await t.throwsAsync(makeRoom(tight.ctx, 'trip'), { message: 'pockets: 35/36 slots, nothing to put away (a trip needs 3 free)' });
  t.deepEqual(tight.m.acts, []);
  t.deepEqual(tight.m.walks, []);
  t.is(tight.ctx.world.lastDone, undefined, 'nothing was tried: no mark');

  // loose things, but the chests are 60 off and no yard reaches there: it does not set out
  const far = live(snap(pack(35, 4), out(60, 0)), world());
  await t.throwsAsync(makeRoom(far.ctx, 'trip'), { message: 'pockets: 35/36 slots, the chests out of reach (a trip needs 3 free)' });
  t.deepEqual(far.m.acts, []);
  t.deepEqual(far.m.walks, []);
  t.is(far.ctx.world.lastDone, undefined);

  // one loose slot where the mine needs ten, the yard two and a build one: each kind is named for what it is
  const few = live(snap(pack(36, 1)), world());
  await t.throwsAsync(makeRoom(few.ctx, 'deep'), { message: 'pockets: 36/36 slots, only 1 more to put away (the mine needs 10 free)' });
  await t.throwsAsync(makeRoom(few.ctx, 'yard'), { message: 'pockets: 36/36 slots, only 1 more to put away (a round in the yard needs 2 free)' });
  const none = live(snap(pack(36, 0)), world());
  await t.throwsAsync(makeRoom(none.ctx, 'project'), { message: 'pockets: 36/36 slots, nothing to put away (a build needs 1 free)' });
  t.deepEqual([few.m.acts, none.m.acts], [[], []]);

  // room already: nothing happens
  const roomy = live(snap(pack(20, 4)), world());
  await makeRoom(roomy.ctx, 'trip');
  t.deepEqual(roomy.m.acts, []);
  t.deepEqual(roomy.m.walks, []);

  // the memory says the chest is empty and it is full: the stash moves nothing, makeRoom says so and the memory learns
  const w = world();
  const s = snap(pack(35, 4));
  t.is(room('trip', s, w), 'stash');
  const stale = bot(s.items, { [KEY]: { stone: 27 * 64 } });
  // the body ran this time: said as that, and not as pockets with nothing in them to put away
  await t.throwsAsync(makeRoom(ctxOf(stale, s, w), 'trip'), { message: 'pockets still 35/36 after putting away' });
  t.is(stale.used(), 35);
  t.deepEqual(w.chestItems?.[KEY], { stone: 27 * 64 });
  t.is(w.lastDone?.['no room: trip'], s.now, 'the body ran and fell short: the mark is left');
  t.is(room('trip', s, w), 'no');

  // it honours the signal: before it starts, and between the stash's moves
  const gone = new AbortController();
  gone.abort();
  const before = live(snap(pack(35, 4)), world(), gone.signal);
  await t.throwsAsync(makeRoom(before.ctx, 'trip'), { message: 'aborted' });
  t.deepEqual(before.m.acts, []);
  t.is(before.ctx.world.lastDone, undefined);
  const cut = new AbortController();
  const during = live(snap(tripLoad()), world(), cut.signal);
  during.m.after = () => cut.abort();
  await t.throwsAsync(makeRoom(during.ctx, 'trip'), { message: 'aborted' });
  t.deepEqual(during.m.acts, ['store-in-chest bread 104']);
  t.is(during.ctx.world.lastDone?.['no room: trip'], undefined, 'stopped by the brain: that is no failed put-away');
  t.is(room('trip', snap(tripLoad()), during.ctx.world), 'stash');
});

test('a put-away that made no room is remembered by kind for 10 min: the goal declines for its pockets, then asks again', async t => {
  const MIN = 60_000;
  // junk is all that is loose, and no dump spot can be got to: every walk out fails with the bot still at home,
  // inside the fence (the stand-in's own walk always arrives). The plan promised the same room on the next tick:
  // three failed runs in a row, and the goal was left until morning
  const yard = { x1: -8, z1: -8, x2: 8, z2: 8, y: 64 };
  const w = world({ yard });
  const s = snap(fill([...kit(), { slot: 9, name: 'leaf_litter', count: 32 }, { slot: 10, name: 'poisonous_potato', count: 32 }], 35));
  t.deepEqual(pockets(s, w, 'trip'), { used: 35, free: 1, loose: 2 });
  t.is(room('trip', s, w), 'stash');
  t.regex(stock.wants(s, w) ?? '', /^short of 32 log/);
  const home = live(s, w);
  const tried: string[] = [];
  const stuck: GoalContext = {
    ...home.ctx,
    act: async (name, args = {}) => {
      if (name !== 'move-to-position') return home.ctx.act(name, args);
      tried.push(`${args.x},${args.z}`);
      throw new Error('Could not get there');
    },
  };
  await t.throwsAsync(stock.run(stuck), { message: 'pockets still 35/36 after putting away: no dump spot outside the fence it could get to' });
  t.is(tried.length, 4, 'each side of the yard tried');
  t.deepEqual(home.m.acts, ['go-home'], 'nothing stored, nothing dropped');
  t.is(home.m.used(), 35);

  // the mark, for this kind: its room is `no`, the goal does not want and says why in words of its own
  t.is(w.lastDone?.['no room: trip'], s.now);
  t.is(room('trip', s, w), 'no');
  t.is(stock.wants(s, w), null);
  t.deepEqual(stock.declines!(s, w), { cause: 'pockets', text: '35/36 slots, the stash made no room just now (stock needs 3 free)' });
  t.is(noRoom('trip', 'stock', s, w).text, '35/36 slots, the stash made no room just now (stock needs 3 free)');
  const later = (min: number) => snap(s.items, { now: s.now + min * MIN });
  t.is(stock.declines!(later(4), w)?.text, '35/36 slots, the stash made no room 4 min ago (stock needs 3 free)');
  t.is(room('trip', later(9), w), 'no');
  // a round in the yard was not tried, and keeps other things carried: its room is its own
  t.is(w.lastDone?.['no room: yard'], undefined);
  t.is(room('yard', s, w), 'stash');
  // with the slots free it is room again at once, mark or no mark
  t.is(room('trip', snap(pack(33, 0)), w), 'ok');
  t.regex(stock.wants(snap(pack(33, 0)), w) ?? '', /^short of 32 log/);
  // and after 10 min the plan is believed again
  t.is(room('trip', later(10), w), 'stash');
  t.regex(stock.wants(later(10), w) ?? '', /^short of 32 log/);
  t.is(stock.declines!(later(10), w), null);

  // a chest that will not open: the same, with the game's own words for what stood in the way
  const shut = world();
  const full = snap(pack(30, 4));
  t.deepEqual(pockets(full, shut, 'deep'), { used: 30, free: 6, loose: 4 });
  t.is(room('deep', full, shut), 'stash');
  const lid = live(full, shut);
  const blocked: Ctx = {
    ...lid.ctx,
    act: async (name, args = {}) => {
      if (name === 'store-in-chest') throw new Error('The chest at (1, 64, 0) did not open');
      return lid.ctx.act(name, args);
    },
  };
  await t.throwsAsync(makeRoom(blocked, 'deep'), { message: 'pockets still 30/36 after putting away: The chest at (1, 64, 0) did not open' });
  t.true(blocked.said.includes('making room: The chest at (1, 64, 0) did not open'));
  t.deepEqual(lid.m.acts, []);
  t.is(shut.lastDone?.['no room: deep'], full.now);
  t.is(room('deep', full, shut), 'no');
  t.is(noRoom('deep', 'deep trip', full, shut).text, '30/36 slots, the stash made no room just now (deep trip needs 10 free)');
  // the trip for materials has its three slots: nothing was tried for it and nothing is held against it
  t.is(room('trip', full, shut), 'ok');
  t.is(room('deep', snap(full.items, { now: full.now + 10 * MIN }), shut), 'stash');
});

// The same rules through the brain itself: a real tick, the real stash goal, the stand-in game underneath.
const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const settle = () => new Promise(r => setTimeout(r, 20));

/** A brain over the stand-in game: a home at (0, 64, 0) with the one chest beside it, at noon. */
function brainOf(m: Bot, goals: Goal[], clock = 1_000_000) {
  const at = { clock };
  const region = new Array<string>(25 * 11 * 25).fill('air');
  // the box the brain reads round the home starts at (-12, 60, -12)
  region[(CHEST.x + 12) + (CHEST.z + 12) * 25 + (CHEST.y - 60) * 25 * 25] = 'chest[facing=south,type=single,waterlogged=false]';
  m.time = 6000;
  const rt: ClientRuntime = {
    actions: Object.fromEntries(['store-in-chest', 'take-from-chest', 'drop-item', 'move-to-position', 'go-home'].map(name => [name, async (a: Record<string, unknown>) => {
      const r = m.act(name, a);
      return reply(r.text, !r.ok);
    }])),
    call: (async (method: string, params?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      if (method === 'world.region') return { blocks: region };
      return m.call(method, params);
    }) as ClientRuntime['call'],
    status: async () => m.status(),
    home: () => ({ x: 0, y: 64, z: 0, dimension: 'overworld' }),
    lastDeath: () => undefined,
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined,
  };
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => at.clock, goals });
  return { brain, at };
}

/** a goal that runs until the test ends it (or the brain stops it) */
function long(name = 'job', priority = 10) {
  const st = { began: 0, stopped: 0, end: (() => undefined) as (e?: Error) => void };
  const goal: Goal = {
    name, priority, wants: () => (st.began ? null : 'to do'), timeoutMs: 3_600_000, retryMs: 1000,
    run: ctx => new Promise<string>((res, rej) => {
      st.began++;
      st.end = e => (e ? rej(e) : res('through'));
      ctx.signal.addEventListener('abort', () => { st.stopped++; rej(new Error('aborted')); });
    }),
  };
  return { goal, st };
}

test('the stash waits for a running job at 28/36 and takes over when it ends', async t => {
  const m = bot(kit());
  const { goal, st } = long();
  const { brain, at } = brainOf(m, [stash, goal]);
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.is(st.began, 1, brain.status());

  // 28/36 at home: the stash asks (27 and up), but eight slots are free and the job loses nothing by going on
  m.inv = pack(28, 4);
  await brain.tick();
  await settle();
  t.is(st.stopped, 0);
  t.notRegex(brain.status(), /stash is more urgent/);
  t.notRegex(brain.status(), /start stash/);
  t.is(m.used(), 28);

  // the job ends by itself: the stash has the next tick, at the hand-over
  at.clock += 2100;
  st.end();
  await settle();
  await settle();
  t.regex(brain.status(), /done job in 2s: through\n- \S+ start stash: 28\/36 slots used\n/);
  t.regex(brain.status(), /done stash in \d+s: put 256 item\(s\) in the chests/);
  t.is(st.stopped, 0);
  t.is(m.used(), 24);
  brain.setEnabled(false);
});

test('the stash cuts in at 35/36', async t => {
  const m = bot(kit());
  const { goal, st } = long();
  const { brain } = brainOf(m, [stash, goal]);
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.is(st.began, 1, brain.status());

  // two free: what the job picks up still has a slot to land in
  m.inv = pack(34, 4);
  await brain.tick();
  await settle();
  t.is(st.stopped, 0);
  t.notRegex(brain.status(), /stash is more urgent/);

  // one free: the running goal would start losing what it picks up
  m.inv = pack(35, 4);
  await brain.tick();
  await settle();
  t.is(st.stopped, 1);
  t.regex(brain.status(), /stopping job: stash is more urgent \(35\/36 slots used\)/);
  await brain.tick();
  await settle();
  t.regex(brain.status(), /start stash: 35\/36 slots used/);
  t.regex(brain.status(), /done stash in \d+s: put 256 item\(s\) in the chests/);
  t.is(m.used(), 31);
  brain.setEnabled(false);
});

test('with nothing running the stash starts at 27 as before', async t => {
  const m = bot(pack(26, 4));
  const { brain } = brainOf(m, [stash]);
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.notRegex(brain.status(), /start stash/);
  t.is(m.used(), 26);

  m.inv = pack(27, 4);
  await brain.tick();
  await settle();
  t.regex(brain.status(), /start stash: 27\/36 slots used/);
  t.is(m.used(), 23);
  brain.setEnabled(false);
});

test('a building job with its load: the stash cuts in only at 36/36', async t => {
  const m = bot(kit());
  const { goal, st } = long();
  // 50 min since the last round: the stash's round at home asks too
  const { brain, at } = brainOf(m, [stash, goal], 3_000_000);
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.is(st.began, 1, brain.status());
  const mem = brain.worldMemory()!;
  t.deepEqual(mem.landmarks.chests, [CHEST]);
  mem.buildJobs = [job({ carry: ['cobblestone'] })];

  // 35/36 with the job's cobblestone: by the pockets rule alone the stash would cut in here (one slot free)
  const load = (): InventoryItem[] => [...kit(), ...stacks('cobblestone', 23, 9), { slot: 32, name: 'bone', count: 1 }, { slot: 33, name: 'string', count: 3 }, { slot: 34, name: 'gunpowder', count: 2 }];
  m.inv = load();
  t.is(stash.wants(snap(m.inv, { now: at.clock }), mem), '3 kinds of things to put away');
  await brain.tick();
  await settle();
  t.is(st.stopped, 0, brain.status());
  t.notRegex(brain.status(), /stash is more urgent/);
  t.is(m.used(), 35);

  // 36/36: not a slot left for the job to work with
  m.inv = [...load(), { slot: 35, name: 'flint', count: 1 }];
  await brain.tick();
  await settle();
  t.is(st.stopped, 1);
  t.regex(brain.status(), /stopping job: stash is more urgent \(36\/36 slots used\)/);
  await brain.tick();
  await settle();
  t.regex(brain.status(), /start stash: 36\/36 slots used/);
  // the load stays with the bot: only what the job does not build with went
  t.is(m.count('cobblestone'), 40 + 23 * 64);
  t.is(m.used(), 32);
  brain.setEnabled(false);
});

test('a goal\'s cuts decides whether its want stops a running goal; a survival goal always does', async t => {
  const asks = (name: string, priority: number, cuts: Goal['cuts']): { goal: Goal; ask: { on: boolean } } => {
    const ask = { on: false };
    return { ask, goal: { name, priority, wants: () => (ask.on ? `${name} wants` : null), run: async () => { ask.on = false; return 'ran'; }, timeoutMs: 1000, retryMs: 1000, cuts } };
  };
  const scene = async (other: { goal: Goal; ask: { on: boolean } }) => {
    const { goal, st } = long();
    const { brain, at } = brainOf(bot(kit()), [other.goal, goal]);
    brain.setEnabled(true);
    await brain.tick();
    await settle();
    t.is(st.began, 1, brain.status());
    other.ask.on = true;
    await brain.tick();
    await settle();
    return { brain, at, st };
  };

  // it wants, and says its want can wait: the running goal goes on, and it starts when that ends
  const polite = await scene(asks('polite', 50, () => false));
  t.is(polite.st.stopped, 0);
  t.notRegex(polite.brain.status(), /polite/);
  polite.at.clock += 2100;
  polite.st.end();
  await settle();
  t.regex(polite.brain.status(), /done job in 2s: through\n- \S+ start polite: polite wants\n/);
  polite.brain.setEnabled(false);

  // no cuts at all: as ever
  const plain = await scene(asks('plain', 50, undefined));
  t.is(plain.st.stopped, 1);
  t.regex(plain.brain.status(), /stopping job: plain is more urgent \(plain wants\)/);
  plain.brain.setEnabled(false);

  // a survival goal is never asked
  const hungry = await scene(asks('food', 90, () => false));
  t.is(hungry.st.stopped, 1);
  t.regex(hungry.brain.status(), /stopping job: food is more urgent/);
  hungry.brain.setEnabled(false);

  // a cuts that throws must not keep an urgent goal out (nor throw into the tick)
  const broken = await scene(asks('broken', 50, () => { throw new Error('boom'); }));
  t.is(broken.st.stopped, 1);
  t.regex(broken.brain.status(), /stopping job: broken is more urgent/);
  broken.brain.setEnabled(false);
});

test('food put away does not come straight back: with 64 of a kind carried nothing takes more from the chests', async t => {
  // a home with no furnace, at night: the cook cannot run and nothing is farmed, fished or hunted, so the chests are
  // the only place food could come from
  const larderless = (chest: Record<string, number>) => world({ landmarks: { chests: [CHEST], farmland: [] }, chestItems: { [KEY]: { ...chest } } });
  const night: Partial<Snapshot> = { timeOfDay: 14_000, activity: 'rest' };
  const takes = (m: Bot) => m.acts.filter(a => a.startsWith('take-from-chest'));

  // raw meat used to come out whole whenever ready food was short: now only up to the stack the stash leaves carried
  const few = live(snap([...tools(), { slot: 6, name: 'beef', count: 10 }], night), larderless({ beef: 200 }));
  t.is(await gatherFood(few.ctx, 20, true), 'took 54 beef; now carrying 0 food points');
  t.deepEqual(takes(few.m), ['take-from-chest beef 54']);
  t.is(few.m.count('beef'), 64);

  // 64 carried: nothing more, however short the ready food
  const stack = live(snap([...tools(), { slot: 6, name: 'beef', count: 64 }], night), larderless({ beef: 200 }));
  await t.throwsAsync(gatherFood(stack.ctx, 20, true), { message: /no food to be had/ });
  t.deepEqual(takes(stack.m), []);
  t.is(stack.m.held().beef, 200);

  // turn about: the stash puts 136 of 200 away, the food goal then leaves them there, and the stash has no more to do
  const w = larderless({});
  const s = snap([...tools(), ...stacks('beef', 3, 6), { slot: 9, name: 'beef', count: 8 }], night);
  const round = live(s, w);
  t.deepEqual(await putAway(round.ctx, s, stashKeep(w)), { stored: 136, dropped: 0 });
  t.is(round.m.count('beef'), 64);
  for (let i = 0; i < 2; i++) {
    const after = snap(round.m.inv, night);
    await t.throwsAsync(gatherFood(ctxOf(round.m, after, w), 20, true), { message: /no food to be had/ });
    t.deepEqual(takes(round.m), []);
    t.is(round.m.count('beef'), 64);
    t.deepEqual(stashList(after, w), { deposit: [], drop: [] });
  }
  t.is(round.m.held().beef, 136);

  // ready food: the same cap, whatever the target asked for
  const bread = live(snap([...tools(), { slot: 6, name: 'bread', count: 64 }], night), larderless({ bread: 300 }));
  await t.throwsAsync(gatherFood(bread.ctx, 400, true), { message: /no food to be had/ });
  t.deepEqual(takes(bread.m), []);
  const some = live(snap([...tools(), { slot: 6, name: 'bread', count: 60 }], night), larderless({ bread: 300 }));
  await gatherFood(some.ctx, 400, true);
  t.deepEqual(takes(some.m), ['take-from-chest bread 4']);
  t.is(some.m.count('bread'), 64);
  // and with a stack of it carried the food goal does not ask at all
  t.is(food.wants(snap([...tools(), { slot: 6, name: 'bread', count: 64 }]), larderless({ bread: 300 })), null);

  // the larder's stocking never opens a chest (it would be taking out what it is there to fill)
  const stocking = live(snap([...tools(), { slot: 6, name: 'bread', count: 3 }], night), larderless({ bread: 300 }));
  await gatherFood(stocking.ctx, 60, false).catch(() => undefined);
  t.deepEqual(takes(stocking.m), []);
  t.false(stocking.m.calls.includes('chest.open'));
  t.is(stocking.m.count('bread'), 3);
});

// ---- the goals' own runs: room first, then the work ----

test('stock at 34/36 with 4 loose slots wants and stashes first', async t => {
  // the trip set out under 33 slots only, and from there waited for a stash that had a limit of its own (294.7 min of
  // the idle in brain.log 2026-11-08..10 were pockets at 34-36 slots)
  /** a tree in sight of home, and a miner that brings what it is sent for: its line says with what pockets it set out */
  const trip = (s: Snapshot, w: WorldMemory) => {
    const { m, ctx } = live(s, w);
    const run: GoalContext = {
      ...ctx,
      call: (async (method: string, params?: Record<string, unknown>) => (
        method === 'world.findBlocks' ? { positions: [{ x: 30, y: 64, z: 0 }] } : m.call(method, params))) as GoalContext['call'],
      act: async (name, args = {}) => {
        if (name !== 'mine-blocks') return ctx.act(name, args);
        const block = String(args.block).split(',')[0];
        m.acts.push(`mine-blocks ${block} up to ${args.count}, ${m.used()}/36 slots used`);
        return { ok: true, text: `Mined ${args.count} ${block}` };
      },
    };
    return { m, run };
  };

  // a home with not a log in it: the trip is for its 32
  const w = world();
  const s = snap(fill([...kit(), ...stacks('bone', 4, 9)], 34));
  t.deepEqual(pockets(s, w, 'trip'), { used: 34, free: 2, loose: 4 });
  t.regex(stock.wants(s, w) ?? '', /^short of 32 log/);
  t.is(stock.declines!(s, w), null);
  const out = trip(s, w);
  t.is(await stock.run(out.run), 'Mined 32 oak_log; back home');
  t.deepEqual(out.m.acts, ['store-in-chest bone 256', 'mine-blocks oak_log up to 32, 30/36 slots used', 'go-home']);
  t.deepEqual(out.m.held(), { bone: 256 });

  // three free: it goes as it stands, nothing asked of the chests
  const roomy = trip(snap(fill([...kit(), ...stacks('bone', 4, 9)], 33)), world());
  await stock.run(roomy.run);
  t.deepEqual(roomy.m.acts, ['mine-blocks oak_log up to 32, 33/36 slots used', 'go-home']);
  t.deepEqual(roomy.m.calls, [], 'not even a look at the pockets');
});

test('stock at 35/36 with nothing loose declines pockets', async t => {
  const w = world();
  const full = snap(fill(kit(), 35));
  t.deepEqual(pockets(full, w, 'trip'), { used: 35, free: 1, loose: 0 });
  t.is(stock.wants(full, w), null);
  t.deepEqual(stock.declines!(full, w), { cause: 'pockets', text: '35/36 slots, nothing to put away (stock needs 3 free)' });
  // a run started all the same (the pockets filled between the gate and the run) ends before it has asked for anything
  const { m, ctx } = live(full, w);
  await t.throwsAsync(stock.run(ctx), { message: 'pockets: 35/36 slots, nothing to put away (a trip needs 3 free)' });
  t.deepEqual(m.acts, []);
  t.is(m.used(), 35);
});

test('a job building with its load runs at 35/36, and at 36/36: its run asks nothing of the chests', async t => {
  // live 2026-11-10: the lookout's 292-item load took the pockets to 35/36, and from 34 used the job never ran again
  const goal = structureGoal(new StructureStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pockets-'))));
  const load = (used: number): InventoryItem[] => [...kit(), ...stacks('cobblestone', used - 9, 9)];
  // no such structure on disk: the run ends at the first thing it does once the pockets are settled
  const GONE = 'its structure file is gone';
  for (const used of [35, 36]) {
    const w = world({ buildJobs: [job({ carry: ['cobblestone'] })] });
    const s = snap(load(used));
    t.regex(goal.wants(s, w) ?? '', /apply barn/, `${used}/36`);
    const { m, ctx } = live(s, w);
    t.is(await goal.run(ctx), GONE);
    t.deepEqual([m.acts, m.walks, m.calls], [[], [], []], `${used}/36: no look at the pockets, no walk, nothing stored`);
    t.is(m.used(), used);
  }

  // 36 slots before the job builds (its bill still being got together): the run makes its slot first, of what the
  // stash would take, and that is not the job's own materials
  const w = world({ buildJobs: [job({ phase: 'provisioning', carry: ['cobblestone'] })] });
  const s = snap([...kit(), ...stacks('cobblestone', 24, 9), ...stacks('bone', 3, 33)]);
  t.is(s.slotsUsed, 36);
  t.regex(goal.wants(s, w) ?? '', /apply barn/);
  const { m, ctx } = live(s, w);
  t.is(await goal.run(ctx), GONE);
  t.deepEqual(m.acts, ['store-in-chest bone 192']);
  t.is(m.used(), 33);
  t.is(m.count('cobblestone'), 24 * 64 + 40, 'the load stays: the job carries it');
});

/**
 * The whole brain with its own goal list over the stand-in game; the memory comes from its file, as it does live.
 * `at.hold` keeps every tool waiting: live a goal is at work for minutes, and the stand-in answers at once.
 */
function wholeBrain(m: Bot, mem: WorldMemory, clock: number) {
  const at: { clock: number; hold?: Promise<void> } = { clock };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pockets-')), 'brain.json');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': mem }));
  const region = new Array<string>(25 * 11 * 25).fill('air');
  region[(CHEST.x + 12) + (CHEST.z + 12) * 25 + (CHEST.y - 60) * 25 * 25] = 'chest[facing=south,type=single,waterlogged=false]';
  const chestTools = new Set(['store-in-chest', 'take-from-chest', 'drop-item', 'move-to-position', 'go-home']);
  const rt: ClientRuntime = {
    // the chest tools and the walks are the stand-in's; any other tool is noted and finds nothing
    actions: new Proxy({} as ClientRuntime['actions'], {
      get: (_, name: string) => async (a: Record<string, unknown>) => {
        await at.hold;
        if (!chestTools.has(name)) { m.acts.push(name); return reply(`${name}: nothing`); }
        const r = m.act(name, a);
        return reply(r.text, !r.ok);
      },
    }),
    call: (async (method: string, params?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      if (method === 'world.region') return { blocks: region };
      if (method === 'world.findBlocks') return { positions: [] };
      return m.call(method, params);
    }) as ClientRuntime['call'],
    status: async () => m.status(),
    home: () => ({ x: 0, y: 64, z: 0, dimension: 'overworld' }),
    lastDeath: () => undefined,
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined,
  };
  return { brain: new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => at.clock, memoryFile: file }), at, file };
}

test('the real goal list at 34/36 with six loose slots: the brain starts a goal, and its status names the goal, not the pockets', async t => {
  // 294.7 min of the idle in brain.log 2026-11-08..10 were pockets at 34-36 slots. Here: the project short of the 98
  // sugar_cane and 38 leather it was short of live, by day in the yard 30 from home, three stacks of bread over the 64
  // carried, and three of a project's planks with no job building
  const T = Date.UTC(2026, 10, 10, 14, 0, 0);
  const MIN = 60_000;
  const iron = ['iron_pickaxe', 'iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_sword', 'iron_hoe'].map((n, i) => tool(i, n, 250));
  const inv = fill([...iron, { slot: 6, name: 'shield', count: 1 }, { slot: 7, name: 'torch', count: 64 }, { slot: 8, name: 'cobblestone', count: 64 },
    ...stacks('bread', 4, 9), ...stacks('oak_planks', 3, 13)], 34);
  const armour = ['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'].map((name, i): InventoryItem => ({ slot: 36 + i, name, count: 1 }));
  // every round done two minutes ago and the project waiting on what it is short of: what is left is the pockets
  const mem = (): WorldMemory => world({
    landmarks: { chests: [CHEST], farmland: [], foundAt: T }, yard: { x1: -48, z1: -16, x2: 16, z2: 16, y: 64 },
    lastDone: Object.fromEntries(['stash', 'tidy', 'sort', 'repair', 'lights', 'furnace', 'farm', 'structures', 'storage', 'signs', 'project'].map(k => [k, T - 2 * MIN])),
    progress: { done: [], journal: [], carry: ['oak_planks'], blockedUntil: Object.fromEntries(TREE.map(x => [x.id, T + 10 * MIN])), need: { sugar_cane: 98, leather: 38 } },
  });

  // the rule, on these pockets: a trip's three slots can be made, the deep trip's ten cannot, and the deep trip's kit
  // is ready (the pockets are all it says)
  const s = snap([...inv, ...armour], { now: T, timeOfDay: 3000, ...out(-30, 0) });
  t.deepEqual(pockets(s, mem(), 'trip'), { used: 34, free: 2, loose: 6 });
  t.deepEqual([room('trip', s, mem()), room('deep', s, mem())], ['stash', 'no']);
  t.deepEqual(deepTrip.declines!(s, mem()), { cause: 'pockets', text: '34/36 slots, only 6 more to put away (deep trip needs 10 free)' });

  const m = bot([...inv, ...armour]);
  m.pos = { x: -30, y: 64, z: 0 };
  m.time = 3000;
  const { brain, at, file } = wholeBrain(m, mem(), T);
  brain.setEnabled(true);
  // each tick is looked at with its goal at work (its first tool held), then let through: the stand-in answers at
  // once, and with nothing running brain-status says what declines, whatever the next tick starts
  const seen: string[] = [];
  const slots: number[] = [];
  for (let i = 0; i < 6; i++) {
    let release = (): void => undefined;
    at.hold = new Promise<void>((r) => { release = r; });
    await brain.tick();
    await settle();
    const status = brain.status();
    t.notRegex(status, /idle \(pockets\)/, `tick ${i}`);
    seen.push(status.split('\n').find(l => l.startsWith('Now:')) ?? '');
    at.hold = undefined;
    release();
    await settle();
    slots.push(m.used());
    at.clock += 5000;
  }
  brain.setEnabled(false);
  // the stash first (a materials trip waits for its room: two minutes after the last stash is no reason of its own),
  // then the trip, for the logs first (the project's cane is the work queue's, not a materials trip's); nothing in
  // the stand-in world is found, so it tries the next thing each time
  t.deepEqual(seen, [
    'Now: stash (34/36 slots used) for 0s.',
    'Now: stock (short of 32 log, 16 coal, 16 iron_ingot) for 0s.',
    'Now: stock (short of 16 coal, 16 iron_ingot) for 0s.',
    'Now: stock (short of 16 coal, 16 iron_ingot) for 0s.',
    'Now: stock (short of 16 coal, 16 iron_ingot) for 0s.',
    'Now: stock (short of 16 coal, 16 iron_ingot) for 0s.',
  ]);
  t.deepEqual(slots, [31, 31, 31, 31, 31, 31]);
  t.is(m.acts[0], 'store-in-chest bread 192');
  t.deepEqual(m.held(), { bread: 192 });
  t.is(m.count('oak_planks'), 192, 'the stash on its own account leaves the project its planks');
  // and not a second of it is booked as idle, under the pockets or anything else
  const idle = JSON.parse(fs.readFileSync(file, 'utf8'))['seed:1'].idle.today;
  t.true(idle.workMs > 0);
  t.is(idle.idleMs, 0);
  t.deepEqual(idle.by, {});
});

// ---- the rungs of the work queue and the pockets (work.ts). Serial: a work run raises flags the whole process shares ----

/** a rung for the stand-in game, with one place to go to, `dist` blocks from home */
const rung = (name: string, rank: number, reach: WorkTask['reach'], kind: RoomKind, dist: number, run: WorkTask['run']): WorkTask => ({
  name, rank, reach, room: kind, budgetMs: 120_000, variants: () => [{ id: 'only', dist }], ready: () => null, run,
});
/** a brain whose goals are these rungs (and `more` before them), the rungs on the brain's own clock */
function ladder(m: Bot, tasks: WorkTask[], more: Goal[] = []) {
  let now = () => 1_000_000;
  const goals = workGoals(() => undefined, tasks, () => now());
  const b = brainOf(m, [...more, ...goals]);
  now = () => b.at.clock;
  const recent = () => b.brain.status().split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(11));
  return { ...b, goals, recent };
}

test.serial('the stash cuts into a yard work run only at 36/36', async t => {
  const m = bot(kit());
  const st = { began: 0, stopped: 0 };
  const chop = rung('chop', 7, 'yard', 'yard', 0, ctx => new Promise((_res, rej) => {
    st.began++;
    ctx.signal.addEventListener('abort', () => { st.stopped++; rej(new Error('aborted')); });
  }));
  const { brain } = ladder(m, [chop], [stash]);
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.is(st.began, 1, brain.status());
  t.deepEqual(afield, { trip: false, work: true });

  // one slot free: a plain job is stopped here (above). A rung made its room before it set to work and sees to its
  // pockets itself between its rounds: the stash leaves it to that while anything still fits
  m.inv = pack(35, 4);
  await brain.tick();
  await settle();
  t.is(st.stopped, 0);
  t.notRegex(brain.status(), /stash is more urgent/);

  // full: what it picks up next would lie on the ground
  m.inv = pack(36, 4);
  await brain.tick();
  await settle();
  t.is(st.stopped, 1);
  t.regex(brain.status(), /stopping work: chop: stash is more urgent \(36\/36 slots used\)/);
  t.deepEqual(afield, { trip: false, work: false }, 'the run is over: so is what it asked of the stash');
  await brain.tick();
  await settle();
  t.regex(brain.status(), /start stash: 36\/36 slots used/);
  t.regex(brain.status(), /done stash in \d+s: put 256 item\(s\) in the chests/);
  t.is(m.used(), 32);
  brain.setEnabled(false);
});

test.serial('a rung whose room could not be made steps aside for 10 min, and the next rung runs', async t => {
  const MIN = 60_000;
  // 34/36 with four stacks of logs to put away, and the chest's lid will not lift
  const m = bot(pack(34, 4));
  const real = m.act;
  m.act = (name, a) => {
    if (name === 'store-in-chest') throw new Error('The chest at (1, 64, 0) did not open');
    return real(name, a);
  };
  const ran: string[] = [];
  const instant = (name: string): WorkTask['run'] => async () => { ran.push(name); return { gain: 1, text: 'done' }; };
  // the cane walk needs three slots free, the tidying round in the yard two
  const cane = rung('cane', 5, 'near', 'trip', 20, instant('cane'));
  const tidy = rung('tidy', 6, 'yard', 'yard', 0, instant('tidy'));
  const { brain, at, goals, recent } = ladder(m, [cane, tidy]);
  brain.setEnabled(true);

  // the plan says the stash makes the room, so the upper rung starts, and fails at the chest: said as it happened
  await brain.tick();
  await settle();
  t.deepEqual(recent().slice(2), [
    'start work: cane: only: 20 blocks out',
    'work: cane: making room: The chest at (1, 64, 0) did not open',
    'failed work: cane: pockets still 34/36 after putting away: The chest at (1, 64, 0) did not open',
  ]);
  const w = brain.worldMemory()!;
  t.is(w.lastDone?.['no room: trip'], at.clock);
  t.deepEqual(workOf(w).dry, {}, 'it never set out: the place has no mark');
  t.deepEqual(afield, { trip: false, work: false });

  // the next tick: the rung below has its two slots and runs; the one above says its pockets are why it does not
  at.clock += 1000;
  await brain.tick();
  await settle();
  t.deepEqual(recent().slice(5), [
    'start work: tidy: only: in the yard',
    'work: tidy: skipped: cane (pockets: 34/36 slots, the stash made no room just now (cane needs 3 free))',
    'done work: tidy in 0s: [only] done',
  ]);
  t.deepEqual(ran, ['tidy']);
  t.regex(brain.status(), /\nRetrying later: work: cane 299s\.\n/, 'a failed run, held as any goal\'s is');
  brain.setEnabled(false);
  await settle();

  // for ten minutes, whatever the brain holds or lets go of meanwhile; then the plan is believed again
  const caneGoal = goals.find(g => g.name === 'work: cane')!;
  const look = (min: number) => snap(m.inv, { now: at.clock - 1000 + min * MIN, timeOfDay: 6000 });
  t.deepEqual(caneGoal.declines!(look(9), w), { cause: 'pockets', text: '34/36 slots, the stash made no room 9 min ago (cane needs 3 free)' });
  t.is(decide(look(9), w, goals, new Map())?.goal.name, 'work: tidy');
  t.is(caneGoal.declines!(look(10), w), null);
  t.deepEqual(decide(look(10), w, goals, new Map()), { goal: caneGoal, reason: 'only: 20 blocks out' });
});

test.serial('a put-away that took the last of the day: the rung does not set out, and says so without a mark against the place', async t => {
  // 35/36: the round in the yard needs the stash first, and by the time the logs are in the chest it is evening
  const m = bot(pack(35, 4));
  const real = m.act;
  m.act = (name, a) => {
    const r = real(name, a);
    if (name === 'store-in-chest') m.time = 10_800;
    return r;
  };
  let began = 0;
  const chop = rung('chop', 7, 'yard', 'yard', 0, async () => { began++; return { gain: 1, text: 'done' }; });
  const { brain, recent } = ladder(m, [chop]);
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.deepEqual(recent().slice(2), [
    'start work: chop: only: in the yard',
    'work: chop: stored 256, dropped 0',
    'done work: chop in 0s: [only] not setting out: 0.2 min of daylight left (chop needs 0.3)',
  ]);
  t.is(began, 0);
  t.is(m.used(), 31, 'the room was made');
  t.deepEqual(workOf(brain.worldMemory()!).dry, {});
  t.is(workOf(brain.worldMemory()!).last, undefined);
  t.deepEqual(afield, { trip: false, work: false });
  brain.setEnabled(false);
});
