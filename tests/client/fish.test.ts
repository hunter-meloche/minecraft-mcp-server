import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { Brain } from '../../src/client/brain/brain.js';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import { returnIdle, type Goal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Zone } from '../../src/client/brain/courtesy.js';
import { idleOf } from '../../src/client/brain/idlelog.js';
import { putAway, stashKeep, stashList, stashWork } from '../../src/client/brain/chores.js';
import { stashPlan } from '../../src/client/brain/kit.js';
import { GLUT, pockets, room, stashReach } from '../../src/client/brain/pockets.js';
import { STRING_KEEP } from '../../src/client/brain/progress.js';
import { makeRod } from '../../src/client/brain/food.js';
import { LADDER } from '../../src/client/brain/worktasks.js';
import { TREE } from '../../src/client/brain/tree.js';
import { pick, sitesOf, taskOf, workGoals, workOf, type WorkTask } from '../../src/client/brain/work.js';
import {
  CAST_CLEAR, CATCH, FISH_FROM_BUILDS, FISH_LEAST_MS, castsIn, catchWords, eveningFrom, findCast, fishRules, gradeOf, isEvening, openWater, waterKind, type View
} from '../../src/client/brain/fish.js';
import { HOME, KEPT, ROUNDS, WORN, liveWorld, lookAt, pocketsOf } from '../helpers/homestead.js';

/**
 * The evening's fishing rung (worktasks.ts `fish`, fish.ts) over a stand-in world that answers as the client does:
 * world.region box by box (x fastest, then z, then y; null where not loaded), world.findBlocks the nearest first round
 * the bot (open to the sky when asked), goto that walks (and says whether it was careful), and the bridge's `fish`,
 * which answers as many bites as it is told to for each call, puts the catch in the pockets, and lets the clock go on
 * by the time it was given. The ground is the live homestead's (helpers/homestead.ts) and the lake east of the yard as
 * it stood on Nov 15: water at y 55-56 round (-508, 2199), 9 x 9, its bed at 54, its shore rising a block a block to
 * the yard's 62.
 */

const SECOND = 1000;
const T0 = Date.UTC(2026, 10, 15, 20, 0, 0);
const POND = { x1: -512, x2: -504, z1: 2195, z2: 2203, top: 56 };
type Box = { x: number; y: number; z: number; width: number; height: number; length: number };
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const k = (p: Pos) => `${p.x},${p.y},${p.z}`;
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/**
 * The ground round home: the yard's 62, the lake `deep` blocks deep with its shore rising a block a block from its top.
 */
class Land {
  private over = new Map<string, string>();
  constructor(private deep = 2) {}
  private inPond(x: number, z: number) { return x >= POND.x1 && x <= POND.x2 && z >= POND.z1 && z <= POND.z2; }
  ground(x: number, z: number): number {
    const d = Math.max(POND.x1 - x, 0, x - POND.x2, POND.z1 - z, 0, z - POND.z2);
    return d === 0 ? POND.top - this.deep : Math.min(62, POND.top - 1 + d);
  }
  at(x: number, y: number, z: number): string | null {
    if (horiz({ x, z }, HOME) > 160) return null;
    const o = this.over.get(`${x},${y},${z}`);
    if (o !== undefined) return o;
    if (this.inPond(x, z) && y > POND.top - this.deep && y <= POND.top) return 'water[level=0]';
    const g = this.ground(x, z);
    return y > g ? 'air' : y === g ? 'grass_block[snowy=false]' : 'dirt';
  }
  set(p: Pos, block: string): void { this.over.set(k(p), block); }
  region(b: Box): (string | null)[] {
    const out: (string | null)[] = [];
    for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) out.push(this.at(b.x + x, b.y + y, b.z + z));
    return out;
  }
  view(b: Box): View { return { box: b, blocks: this.region(b) }; }
  /**
   * findBlocks of water: the lake's and any set, the nearest to `from` first; with air right over it when asked (the
   * mod's isAir(): a cave's air too), and within a band of heights when asked
   */
  water(from: Pos, maxDistance: number, count: number, openAbove: boolean, band: { yMin?: number; yMax?: number } = {}): Pos[] {
    const all: Pos[] = [];
    for (let x = POND.x1; x <= POND.x2; x++) for (let z = POND.z1; z <= POND.z2; z++) for (let y = POND.top - this.deep + 1; y <= POND.top; y++) all.push({ x, y, z });
    for (const [p, b] of this.over) if (b.startsWith('water')) { const [x, y, z] = p.split(',').map(Number); all.push({ x, y, z }); }
    const d = (q: Pos) => Math.hypot(q.x + 0.5 - from.x, q.y + 0.5 - from.y, q.z + 0.5 - from.z);
    const airy = (b: string | null) => b === 'air' || b === 'cave_air' || b === 'void_air';
    return all.filter(q => this.at(q.x, q.y, q.z)?.startsWith('water') && d(q) <= maxDistance && (!openAbove || airy(this.at(q.x, q.y + 1, q.z))) &&
      q.y >= (band.yMin ?? -Infinity) && q.y <= (band.yMax ?? Infinity))
      .sort((a, b) => d(a) - d(b)).slice(0, count);
  }
}

/**
 * What the bridge's `fish` answers to one call (its bites are what the pockets gain, in this order of names). `ms`:
 * the call ends this long in (a hook let go of an animal ends it), else at its timeout.
 */
interface Reply { bites: number; got?: string[]; open?: number; letGo?: string[]; recalled?: string; ms?: number; full?: true; blocked?: string }

/** The live kept kit (A13) and the diamond armour: no rod in it. */
const kept = (): InventoryItem[] => KEPT.map(([name, count], slot): InventoryItem => ({ slot, name, count })).concat(WORN.map(i => ({ ...i })));

/**
 * The bot in that world, as the client answers: where it stands, its pockets, the chests of the world memory (the
 * chest tools' replies keep its memory up to date, as the real ones do). `pass(ms)` is time going by (the unit tests
 * move a clock at once; the evening's replay waits on the fake timers). `walks`: every goto, careful or not; `fished`:
 * every call of the bridge's `fish`; `entities`: who stands about.
 */
function botIn(land: Land, worldIn: WorldMemory | (() => WorldMemory), items: InventoryItem[], opts: {
  zones?: Zone[]; entities?: () => Record<string, unknown>[]; replies?: Reply[]; tod?: () => number; pass?: (ms: number) => Promise<void>; walkMs?: (blocks: number) => number;
  after?: (n: number, me: { items: InventoryItem[] }) => void;
  /** with no reply scripted: a bite every this many ms of a call (none at all: no bite) */
  biteMs?: number;
  /** the walks to the cells `to` picks take `ms` of their timeout, and get there or not */
  slowWalk?: { to: (p: Pos) => boolean; ms: (timeoutMs: number) => number; arrived: boolean };
} = {}) {
  const worldOf = typeof worldIn === 'function' ? worldIn : () => worldIn;
  const clock = { now: T0 };
  const me = {
    pos: { ...HOME }, items: items.map(i => ({ ...i })), said: [] as string[], gain: 0, acts: [] as string[],
    walks: [] as { to: string; careful: boolean; timeoutMs?: number }[], fished: [] as { at: string; times: number; timeoutMs: number }[]
  };
  const ac = new AbortController();
  const pass = opts.pass ?? (async (ms: number) => { clock.now += ms; });
  const tod = opts.tod ?? (() => 8600 + (clock.now - T0) / 50);
  const replies = [...(opts.replies ?? [])];
  const count = (name: string) => me.items.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
  const add = (name: string, n: number, extra: Partial<InventoryItem> = {}) => {
    const one = /^(fishing_rod|bow|saddle|enchanted_book|leather_boots|potion)$/.test(name);
    const has = one ? undefined : me.items.find(i => i.slot < 36 && i.name === name && !i.enchanted);
    if (has) { has.count += n; return; }
    for (let left = n; left > 0; left -= one ? 1 : left) {
      let slot = 0;
      while (me.items.some(i => i.slot === slot)) slot++;
      if (slot >= 36) return;
      me.items.push({ slot, name, count: one ? 1 : left, ...extra });
    }
  };
  const take = (name: string, n: number) => {
    let left = n;
    for (const i of me.items.filter(x => x.slot < 36 && x.name === name)) {
      const t = Math.min(left, i.count);
      i.count -= t;
      left -= t;
    }
    me.items = me.items.filter(i => i.count > 0);
  };
  const at = (a: Record<string, unknown>): Pos => ({ x: Number(a.x), y: Number(a.y), z: Number(a.z) });
  const holds = (c: Record<string, number>) => Object.entries(c).filter(([, n]) => n > 0).map(([n, c2]) => `${n} x${c2}`).join(', ') || 'nothing';
  const gone = () => { if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up'); };
  const status = async () => ({
    inWorld: true, username: 'claudebot', screen: null, position: { ...me.pos }, block: { ...me.pos }, timeOfDay: Math.floor(tod()) % 24_000, hashedSeed: '1',
    dimension: 'overworld', sleeping: false, raining: false, thundering: false, process: null, health: 20, food: 20, xpLevel: 40
  });
  let calls = 0;
  let open = '';
  const call = (async (method: string, p: Record<string, unknown> = {}) => {
    gone();
    if (method === 'inventory') return { items: me.items.map(i => ({ ...i })) };
    if (method === 'status') return status();
    if (method === 'cancel') return {};
    if (method === 'world.region') return { blocks: land.region(p as unknown as Box) };
    if (method === 'world.findBlocks') {
      const band = { yMin: p.yMin === undefined ? undefined : Number(p.yMin), yMax: p.yMax === undefined ? undefined : Number(p.yMax) };
      return { positions: String(p.block) === 'water' ? land.water(me.pos, Number(p.maxDistance ?? 32), Number(p.count ?? 1), !!p.openAbove, band) : [] };
    }
    if (method === 'foreign.zones') return { zones: opts.zones ?? [] };
    if (method === 'world.entities') return { entities: opts.entities?.() ?? [] };
    if (method === 'goto') {
      const to = { x: Number(p.x), y: p.y === undefined || p.xz ? land.ground(Number(p.x), Number(p.z)) + 1 : Number(p.y), z: Number(p.z) };
      me.walks.push({ to: k(to), careful: !!p.careful, ...(p.timeoutMs !== undefined ? { timeoutMs: Number(p.timeoutMs) } : {}) });
      const slow = opts.slowWalk?.to(to) ? opts.slowWalk : undefined;
      await pass(slow ? slow.ms(Number(p.timeoutMs ?? 60_000)) : opts.walkMs ? opts.walkMs(horiz(me.pos, to)) : 0);
      gone();
      if (slow && !slow.arrived) return { arrived: false, at: { ...me.pos } };
      me.pos = to;
      return { arrived: true, at: { ...to } };
    }
    // a chest by its stacks (the world memory's, as the chests' own reply keeps it): open, take a slot, close
    if (method === 'chest.open') {
      open = k(at(p));
      const stacks = worldOf().chestStacks?.[open] ?? [];
      return { slots: 27, free: 27 - stacks.length, items: { ...(worldOf().chestItems?.[open] ?? {}) }, stacks: stacks.map(st => ({ ...st })) };
    }
    if (method === 'chest.withdraw') {
      const w = worldOf();
      const stacks = w.chestStacks?.[open] ?? [];
      const st = stacks.find(x => x.slot === Number(p.slot) && x.name === p.name);
      if (!st) return { slots: 27, free: 27, items: { ...(w.chestItems?.[open] ?? {}) }, stacks, moved: 0 };
      w.chestStacks![open] = stacks.filter(x => x !== st);
      const c = w.chestItems![open];
      c[st.name] -= st.count;
      if (!c[st.name]) delete c[st.name];
      add(st.name, st.count, { ...(st.enchanted ? { enchanted: true } : {}), ...(st.enchantments ? { enchantments: st.enchantments } : {}), damage: st.damage, maxDamage: st.maxDamage });
      me.acts.push(`chest.withdraw ${st.name} slot ${st.slot}`);
      return { slots: 27, free: 27 - w.chestStacks![open].length, items: { ...c }, stacks: w.chestStacks![open].map(x => ({ ...x })), moved: st.count };
    }
    // that pocket slot's stack into the open chest's first free slot, its reply as the jar's (the chest's stacks)
    if (method === 'chest.deposit') {
      const w = worldOf();
      const stacks = (w.chestStacks?.[open] ?? []).map(x => ({ ...x }));
      const held = { ...(w.chestItems?.[open] ?? {}) };
      const i = me.items.findIndex(x => x.slot === Number(p.slot) && x.name === p.name);
      if (!open || i < 0) return { slots: 27, free: 27 - stacks.length, items: held, stacks, moved: 0 };
      const [st] = me.items.splice(i, 1);
      let into = 0;
      while (stacks.some(x => x.slot === into)) into++;
      stacks.push({ ...st, slot: into });
      held[st.name] = (held[st.name] ?? 0) + st.count;
      me.acts.push(`chest.deposit ${st.name} slot ${st.slot}`);
      return { slots: 27, free: 27 - stacks.length, items: held, stacks, moved: st.count };
    }
    if (method === 'container.close') { open = ''; return {}; }
    if (method === 'fish') {
      if (!count('fishing_rod')) throw new Error('no fishing_rod in inventory');
      const scripted = replies.shift() ?? { bites: opts.biteMs ? Math.floor(Number(p.timeoutMs) / opts.biteMs) : 0 };
      // (the bridge reels in no more than `times` bites a call)
      const r = { ...scripted, bites: Math.min(scripted.bites, Number(p.times)) };
      me.fished.push({ at: k(at(p)), times: Number(p.times), timeoutMs: Number(p.timeoutMs) });
      const took = Math.min(Number(p.timeoutMs), r.ms ?? Infinity);
      await pass(took);
      gone();
      const got = (r.got ?? []).slice(0, r.bites);
      while (got.length < r.bites) got.push('cod');
      const gained: Record<string, number> = {};
      for (const n of got) {
        add(n.replace(/^enchanted /, ''), 1, n.startsWith('enchanted ') ? { enchanted: true } : n === 'enchanted_book' ? { enchantments: [{ name: 'mending', level: 1 }] } : {});
        gained[n] = (gained[n] ?? 0) + 1;
      }
      opts.after?.(++calls, me);
      return {
        bites: r.bites, casts: r.bites + 1, gained, seconds: took / 1000, recalled: r.recalled ?? '', ...(r.open !== undefined ? { open: r.open } : {}), ...(r.letGo ? { letGo: r.letGo } : {}),
        ...(r.full ? { full: true } : {}), ...(r.blocked ? { blocked: r.blocked } : {})
      };
    }
    return {};
  }) as GoalContext['call'];
  const reply = (text: string, ok = true) => ({ ok, text });
  const act = async (tool: string, a: Record<string, unknown> = {}) => {
    gone();
    me.acts.push(tool === 'take-from-chest' ? `${tool} ${a.item} ${a.count}` : tool === 'craft-item' ? `${tool} ${a.outputItem}` : tool);
    if (tool === 'go-home') {
      await pass(opts.walkMs ? opts.walkMs(horiz(me.pos, HOME)) : 0);
      gone();
      me.pos = { ...HOME };
      return reply('Arrived home');
    }
    if (tool === 'take-from-chest') {
      const c = (worldOf().chestItems ??= {})[k(at(a))] ??= {};
      const item = String(a.item);
      const n = Math.min(Number(a.count), c[item] ?? 0);
      c[item] = (c[item] ?? 0) - n;
      if (!c[item]) delete c[item];
      if (item === 'fishing_rod') for (let i = 0; i < n; i++) add(item, 1, { damage: 10, maxDamage: 64 }); else add(item, n);
      return n ? reply(`Took ${n} ${item} from the chest at ${fmt(at(a))}. It holds: ${holds(c)}.`) : reply(`The chest at ${fmt(at(a))} has no ${item}. It holds: ${holds(c)}`, false);
    }
    if (tool === 'craft-item' && a.outputItem === 'fishing_rod') {
      if (count('stick') < 3 || count('string') < 2) return reply('Failed: missing ingredients for fishing_rod', false);
      take('stick', 3);
      take('string', 2);
      add('fishing_rod', 1, { damage: 0, maxDamage: 64 });
      return reply('Crafted 1 fishing_rod');
    }
    return reply(`no ${tool} here`, false);
  };
  const ctx: GoalContext = {
    // (a brain's own runs have their own: the getter's world is the brain's, made after this)
    s: lookAt(me.items, 8600, { now: T0 }), world: typeof worldIn === 'function' ? undefined as unknown as WorldMemory : worldIn, signal: ac.signal,
    progress: text => { me.said.push(text); },
    gain: n => { me.gain += n; },
    status, call, act
  };
  return { me, ctx, clock, call, act, status, abort: () => ac.abort(), count };
}

const rung = (name: string): WorkTask => LADDER.find(t => t.name === name)!;
/** The ladder goal for one rung over a clock the test moves. */
const goalOf = (task: WorkTask, clock: { now: number }) => workGoals(() => undefined, [task], () => clock.now)[0];

/** The live homestead of the helpers (Nov 12), with the store of Nov 15 that the rung reads: 52 string, 226 sticks. */
function homestead(over: (w: WorldMemory) => void = () => undefined): WorldMemory {
  const w = liveWorld();
  w.chestItems!['-547,65,2179'].string = 52;
  w.chestItems!['-551,63,2179'].stick = 226;
  w.landmarks.foundAt = T0;
  over(w);
  return w;
}

/** Frozen all the way down: a write anywhere in it throws (the test files are modules, so strict). */
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

// ---- open water: 26.3's rule ----

/**
 * A view round the pond's middle, as findCast reads one: 9 each way, from a block under the water's top to 4 over it.
 */
const viewOf = (land: Land, w: Pos = { x: -508, y: POND.top, z: 2199 }): View => land.view({ x: w.x - 9, y: w.y - 1, z: w.z - 9, width: 19, height: 6, length: 19 });

test('the kinds of block round the hook, as 26.3\'s FishingHook.getOpenWaterTypeForBlock has them', (t) => {
  for (const b of ['air', 'cave_air', 'lily_pad[]', 'minecraft:air']) t.is(waterKind(b), 'above', b);
  for (const b of ['water[level=0]', 'water', 'seagrass', 'tall_seagrass[half=lower]', 'kelp[age=3]', 'kelp_plant', 'bubble_column[drag=true]']) t.is(waterKind(b), 'inside', b);
  // flowing water is no source; a waterlogged slab has a collision box; nothing loaded says nothing
  for (const b of ['water[level=1]', 'water[level=8]', 'oak_slab[type=bottom,waterlogged=true]', 'grass_block[snowy=false]', 'oak_leaves[distance=1]', null]) t.is(waterKind(b), 'invalid', String(b));
});

test('open water: the 5 x 5 round the hook and under it all still water, the two layers over it all air, by 26.3\'s rule', (t) => {
  const land = new Land(2);
  const mid = { x: -508, y: POND.top, z: 2199 };
  // the 9 x 9 lake, two deep: open with a block to spare in its middle 3 x 3, the game's 5 x 5 a block further out
  t.true(openWater(viewOf(land), mid, 2));
  t.true(openWater(viewOf(land), mid, 3));
  t.is(gradeOf(viewOf(land), mid), 'open');
  t.is(gradeOf(viewOf(land), { x: -510, y: POND.top, z: 2199 }), 'edge');
  t.is(gradeOf(viewOf(land), { x: -511, y: POND.top, z: 2199 }), undefined, 'the bank is in its square');
  // the hook's own block is what is judged: a block under the top is water over water, and the layer two under it
  // the lake's bed
  t.false(openWater(viewOf(land), { ...mid, y: POND.top - 1 }, 2));
  // one deep: the layer under the hook is the bed, still water but no open water (no treasure)
  const shallow = new Land(1);
  t.false(openWater(viewOf(shallow), mid, 2));
  t.is(gradeOf(viewOf(shallow), mid), 'still');
  // a lily pad over the water is air to the rule; a leaf two over it, a flowing block in the square, or a waterlogged
  // slab in it are not
  const pads = new Land(2);
  pads.set({ x: -507, y: POND.top + 1, z: 2200 }, 'lily_pad');
  t.true(openWater(viewOf(pads), mid, 2));
  const leaf = new Land(2);
  leaf.set({ x: -507, y: POND.top + 2, z: 2200 }, 'oak_leaves[distance=1,persistent=false]');
  t.false(openWater(viewOf(leaf), mid, 2));
  t.true(openWater(viewOf(leaf), { x: -509, y: POND.top, z: 2199 }, 1), 'away from the leaf the smaller square is open');
  const flowing = new Land(2);
  flowing.set({ x: -506, y: POND.top, z: 2201 }, 'water[level=2]');
  t.false(openWater(viewOf(flowing), mid, 2));
  const slab = new Land(2);
  slab.set({ x: -509, y: POND.top - 1, z: 2198 }, 'oak_slab[type=bottom,waterlogged=true]');
  t.false(openWater(viewOf(slab), mid, 2));
  // seagrass and kelp in the water are water to it
  const weed = new Land(2);
  weed.set({ x: -507, y: POND.top - 1, z: 2200 }, 'seagrass');
  weed.set({ x: -509, y: POND.top, z: 2198 }, 'kelp_plant');
  t.true(openWater(viewOf(weed), mid, 2));
});

test('the cast: the open water nearest home with a block to spare, from dry ground on the shore, the cast\'s way clear', (t) => {
  const land = new Land(2);
  const world = homestead();
  const rules = fishRules(world, HOME, []);
  const casts = castsIn(viewOf(land), { x: -508, y: POND.top, z: 2199 }, rules.water, rules.keep, HOME);
  t.true(casts.length > 0);
  const best = casts[0];
  t.is(best.grade, 'open');
  t.true(openWater(viewOf(land), best.target, 3));
  // from the west shore (the nearest home), on its grass a block over the water's top, out of the 7 x 7, within 5.5
  for (const st of best.stands) {
    t.is(land.at(st.x, st.y - 1, st.z), 'grass_block[snowy=false]', fmt(st));
    t.is(land.at(st.x, st.y, st.z), 'air');
    t.true(Math.max(Math.abs(st.x - best.target.x), Math.abs(st.z - best.target.z)) >= 4, fmt(st));
    t.true(horiz(st, best.target) <= 5.5, fmt(st));
  }
  // (the nearest home of them: up the bank a block, 5.4 from the mark; a cast from there falls about a block short,
  // which the block to spare round the mark is for)
  t.deepEqual(best.stands[0], { x: -514, y: 58, z: 2196 });
  t.true(openWater(viewOf(land), { x: best.target.x - 1, y: best.target.y, z: best.target.z }, 2), 'a block short is still open water');
  // a shallow lake: still water only, said so
  const shallow = castsIn(viewOf(new Land(1)), { x: -508, y: POND.top, z: 2199 }, rules.water, rules.keep, HOME);
  t.true(shallow.length > 0 && shallow.every(c => c.grade === 'still'));
});

test('never a stand on or beside a cell of the cane patch, nor in the yard, nor within 16 of anyone\'s build', (t) => {
  const land = new Land(2);
  // the patch's cells along the west shore at the stands' level (where the patch would plant them)
  const cane = Array.from({ length: 9 }, (_, i) => ({ x: -513, y: 57, z: 2195 + i }));
  const world = homestead(w => { w.zones!.cane = cane; });
  const rules = fishRules(world, HOME, []);
  const casts = castsIn(viewOf(land), { x: -508, y: POND.top, z: 2199 }, rules.water, rules.keep, HOME);
  t.true(casts.length > 0);
  for (const c of casts) for (const st of c.stands) t.false(cane.some(q => Math.abs(q.x - st.x) <= 1 && Math.abs(q.z - st.z) <= 1 && Math.abs(q.y - st.y) <= 1), fmt(st));
  // the first is off the west shore now (the patch's cells and the cells beside them are out)
  t.true(casts[0].stands[0].x > -512 || casts[0].stands[0].z < 2194 || casts[0].stands[0].z > 2204, fmt(casts[0].stands[0]));
  // someone's build between the yard and the lake: no stand or water within 16 of it, so the cast goes round to the
  // far shores
  const zone: Zone = { x1: -530, y1: 50, z1: 2190, x2: -525, y2: 70, z2: 2210, markers: 12, surface: true };
  const near = fishRules(homestead(), HOME, [zone]);
  const off = castsIn(viewOf(land), { x: -508, y: POND.top, z: 2199 }, near.water, near.keep, HOME);
  t.true(off.length > 0);
  for (const c of off) {
    t.true(c.target.x >= -525 + FISH_FROM_BUILDS, fmt(c.target));
    for (const st of c.stands) t.true(st.x >= -525 + FISH_FROM_BUILDS, fmt(st));
  }
  t.true(off[0].stands[0].x > -512, `${fmt(off[0].stands[0])}: off the west shore`);
  // a build over the whole lake's ground: nothing
  const over: Zone = { x1: -515, y1: 50, z1: 2190, x2: -500, y2: 70, z2: 2208, markers: 30, surface: true };
  const none = fishRules(homestead(), HOME, [over]);
  t.deepEqual(castsIn(viewOf(land), { x: -508, y: POND.top, z: 2199 }, none.water, none.keep, HOME), []);
  // the yard's own water (the farm's, inside the fence) is no water to fish
  t.false(rules.water({ x: -541, y: 62, z: 2165 }));
  t.false(rules.keep({ x: -534, y: 63, z: 2190 }), 'the fence\'s inside');
});

test.serial('the water under the sky only: a cave\'s pool nearer home than the lake is no cast, nor are the hundreds of a deep cave\'s that crowd the lake out of the look', async (t) => {
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  // a cave 24 east of home, 8 out of the fence under the hill: a room 4 high (its air cave air) over a pool 7 x 7 and
  // two deep at y 49-50, a stone floor round it, the hill's ground over it. Open water by the game's rule, a stand
  // on its floor, the air right over it: all findBlocks' openAbove asks
  const land = new Land(2);
  for (let x = -533; x <= -517; x++) for (let z = 2180; z <= 2196; z++) {
    for (let y = 51; y <= 54; y++) land.set({ x, y, z }, 'cave_air');
    const pool = x >= -528 && x <= -522 && z >= 2185 && z <= 2191;
    land.set({ x, y: 50, z }, pool ? 'water[level=0]' : 'stone');
    if (pool) land.set({ x, y: 49, z }, 'water[level=0]');
  }
  t.true(openWater(land.view({ x: -535, y: 49, z: 2179, width: 19, height: 6, length: 19 }), { x: -525, y: 50, z: 2188 }, 3), 'the cave\'s pool is open water by the rule');
  const b = botIn(land, homestead(), [...kept(), { ...rod }]);
  const found = await findCast(b.ctx);
  t.is(found.cast?.grade, 'open');
  t.deepEqual(found.cast?.target, { x: -509, y: 56, z: 2198 }, 'the lake');
  t.deepEqual(found.cast?.stands[0], { x: -514, y: 58, z: 2196 });
  // a deep cave's lake right under the yard, 17 x 17 at y 30: its 289 waters are all nearer the bot than the lake's,
  // and a look for the nearest 256 of every height had none of the lake's. Asked for round home's level only
  const deep = new Land(2);
  for (let x = -560; x <= -544; x++) for (let z = 2175; z <= 2191; z++) {
    for (let y = 31; y <= 34; y++) deep.set({ x, y, z }, 'cave_air');
    deep.set({ x, y: 30, z }, 'water[level=0]');
    deep.set({ x, y: 29, z }, 'water[level=0]');
  }
  const d = botIn(deep, homestead(), [...kept(), { ...rod }]);
  t.deepEqual((await findCast(d.ctx)).cast?.target, { x: -509, y: 56, z: 2198 });
  // under a roof everywhere (the lake's sky built over): said so
  const roofed = new Land(2);
  for (let x = -514; x <= -502; x++) for (let z = 2193; z <= 2205; z++) roofed.set({ x, y: 64, z }, 'oak_planks');
  const r = botIn(roofed, homestead(), [...kept(), { ...rod }]);
  t.regex((await findCast(r.ctx)).text, /^no water under the sky within 64 blocks of home \(under a roof: \(-512, 56, 2195\)/);
});

// ---- the gate ----

const ask = (s: Snapshot, world: WorldMemory) => {
  const c = pick(rung('fish'), s, world);
  return 'decline' in c ? `${c.decline.cause}: ${c.decline.text}` : `${c.variant}: ${c.why} (${c.dist})`;
};

test('the gate: the evening only, from the far rungs\' late bound, and while the walk there and back still fits the daylight', (t) => {
  const world = homestead();
  const s = (tod: number, over: Partial<Snapshot> = {}) => lookAt(kept(), tod, { now: T0, ...over });
  t.is(eveningFrom(96), 8520);
  t.is(eveningFrom(64), 11_000 - (2 * 64 / 3 * 1000 + 60_000) / 50);
  // by day it has nothing to do: the far rungs and the deep window have the day
  for (const tod of [0, 3000, 6000, 8000, 8520]) t.is(ask(s(tod), world), 'unneeded: fish: the evening\'s, from tod 8520 (no far rung fits the day then)', `tod ${tod}`);
  // the morning's half hour before sunrise is no evening
  t.is(ask(s(23_600), world), 'unneeded: fish: the evening\'s, from tod 8520 (no far rung fits the day then)');
  t.false(isEvening(s(23_600), world));
  // from the far rungs' late bound: the water, as far out as it looks (64) before any is known
  t.true(isEvening(s(8521), world));
  t.is(ask(s(8521), world), 'water: 64 blocks out (64)');
  t.is(ask(s(9200), world), 'water: 64 blocks out (64)');
  // and while the walk there and back, the run's margin before dusk and half a minute at the water fit the daylight:
  // 64 out, 88 s, until tod 9247. The ladder's own bound for a near rung (there and back and 20 s) is later, and a run
  // sent out at it had 5 s at the water: dry, and its mark kept the rung home two evenings
  t.is(FISH_LEAST_MS, 30_000);
  t.is(ask(s(9300), world), 'late: 1.4 min of daylight left (fish needs 1.5: the walk to the water and back, 30 s there, and a margin)');
  t.is(ask(s(10_000), world), 'late: 0.8 min of daylight left (fish needs 1.5: the walk to the water and back, 30 s there, and a margin)');
  // once a water is known, its distance (the lake, 43 out): until tod 9527
  const known = homestead(w => { workOf(w).sites.fish = [{ x: -509, y: 56, z: 2198 }]; });
  t.is(ask(s(9500), known), 'water: 43 blocks out (43)');
  t.is(ask(s(9550), known), 'late: 1.2 min of daylight left (fish needs 1.2: the walk to the water and back, 30 s there, and a margin)');
  // with no rod to fish with, that is the reason, not the hour
  t.is(ask(s(10_000), homestead(w => { delete w.chestItems!['-547,65,2179'].string; })), 'kit: no fishing rod, and 0 string (a rod takes 2 beyond the 5 kept for the leads)');
  // no fishing at night, nor in bed, nor in a thunderstorm
  t.is(ask(s(11_500, { activity: 'return' }), world), 'late: not work time (return)');
  t.is(ask(s(14_000, { activity: 'rest' }), world), 'late: not work time (rest)');
  t.is(ask(s(9000, { sleeping: true }), world), 'late: asleep');
  t.is(ask(s(9000, { activity: 'rest', thundering: true }), world), 'late: not work time (rest)');
});

test('the gate: a rod carried, one in the chests, or the makings beyond the leads\' string; not with the pockets full; it reads only', (t) => {
  const s = (items: InventoryItem[] = kept(), over: Partial<Snapshot> = {}) => lookAt(items, 9000, { now: T0, ...over });
  const strings = (n: number) => homestead(w => { if (n) w.chestItems!['-547,65,2179'].string = n; else delete w.chestItems!['-547,65,2179'].string; });
  t.is(STRING_KEEP, 5);
  // the makings: 52 string (5 of them the leads') and 226 sticks
  t.is(ask(s(), homestead()), 'water: 64 blocks out (64)');
  // 7 string: two beyond the leads' five; 6: one, too few
  t.is(ask(s(), strings(7)), 'water: 64 blocks out (64)');
  t.is(ask(s(), strings(6)), 'kit: no fishing rod, and 6 string (a rod takes 2 beyond the 5 kept for the leads)');
  t.is(ask(s(), strings(0)), 'kit: no fishing rod, and 0 string (a rod takes 2 beyond the 5 kept for the leads)');
  // string carried counts with the stored
  t.is(ask(s([...kept(), { slot: 25, name: 'string', count: 3 }]), strings(4)), 'water: 64 blocks out (64)');
  // no sticks
  t.is(ask(s(), homestead(w => { delete w.chestItems!['-551,63,2179'].stick; })), 'kit: no fishing rod, and 0 sticks (a rod takes 3)');
  // a rod carried or one stored wants no makings at all
  t.is(ask(s([...kept(), { slot: 25, name: 'fishing_rod', count: 1, damage: 3, maxDamage: 64 }]), strings(0)), 'water: 64 blocks out (64)');
  t.is(ask(s(), strings(0)), 'kit: no fishing rod, and 0 string (a rod takes 2 beyond the 5 kept for the leads)');
  t.is(ask(s(), homestead(w => { delete w.chestItems!['-547,65,2179'].string; w.chestItems!['-551,63,2181'].fishing_rod = 1; })), 'water: 64 blocks out (64)');
  // a chest not looked into: a half-read store shows no rod
  t.is(ask(s(), homestead(w => { delete w.chestItems!['-547,65,2179']; })), 'unneeded: the chests are not all looked into yet');
  // the pockets: the yard's room, 2 free. Full with nothing to put away, it says so; 34 used is room enough
  t.is(ask(lookAt(pocketsOf(36, true, 'kept things only'), 9000, { now: T0 }), homestead()), 'pockets: 36/36 slots, nothing to put away (fish needs 2 free)');
  t.is(ask(lookAt(pocketsOf(35, true, 'kept things only'), 9000, { now: T0 }), homestead()), 'pockets: 35/36 slots, nothing to put away (fish needs 2 free)');
  t.is(ask(lookAt(pocketsOf(34, true, 'kept things only'), 9000, { now: T0 }), homestead()), 'water: 64 blocks out (64)');
  // out of the yard and more than 40 from home it does not set out (as every rung)
  t.is(ask(s(kept(), { position: { x: -480, y: 63, z: 2183 }, distHome: 69 }), homestead()), 'away: 69 blocks from home (fish works within 40)');
  // the gate writes nothing, however often it is asked
  const w = freeze(homestead());
  for (const tod of [6000, 9000, 10_500]) t.notThrows(() => pick(rung('fish'), lookAt(kept(), tod, { now: T0 }), w));
});

// ---- the run ----

/** What the brain logs for a run's end: the wrapper's line (its variant, its text and the walk home). */
const runLine = async (b: ReturnType<typeof botIn>) => goalOf(rung('fish'), b.clock).run(b.ctx);

test.serial('the run: a rod made of the chests\' sticks and string (the leads\' kept), out by the east gate on foot to the lake\'s west shore, the open water fished; done work: fish', async (t) => {
  const land = new Land(2);
  const world = homestead();
  const b = botIn(land, world, kept(), {
    replies: [{ bites: 2, got: ['cod', 'salmon'], open: 2 }, { bites: 1, got: ['enchanted_book'], open: 1 }]
  });
  const text = await runLine(b);
  // the rod: 2 string out of the 52 (50 left: the leads' 5 among them), 3 sticks, made at the home table
  t.deepEqual(b.me.acts.slice(0, 3), ['take-from-chest string 2', 'take-from-chest stick 3', 'craft-item fishing_rod']);
  t.is(world.chestItems!['-547,65,2179'].string, 50);
  t.is(b.count('fishing_rod'), 1);
  // the run's walks on foot only: to the table, out through the east gate (2 inside it, 2 outside), to the stand.
  // Then the wrapper's walk home: to the gate's outer cell (from out by the lake, Baritone's own: yardgates.ts
  // inByGate) and in through it on foot. Every walk within the yard's edge is on foot
  const walks = b.me.walks.map(w => `${w.to}${w.careful ? '' : ' (its own)'}`);
  t.deepEqual(walks, ['-543,63,2193', '-535,63,2183', '-531,63,2183', '-514,58,2196', '-531,63,2183 (its own)', '-535,63,2183'], JSON.stringify(walks));
  const yard = world.yard!;
  const byYard = (to: string) => { const [x, , z] = to.split(',').map(Number); return Math.max(yard.x1 - x, x - yard.x2, yard.z1 - z, z - yard.z2) <= 8; };
  t.deepEqual(b.me.walks.filter(w => byYard(w.to) && !w.careful && w.to !== '-531,63,2183'), []);
  t.is(b.me.acts.at(-1), 'go-home');
  // the casts: at the open water, from the shore, a minute and then what the budget left (84 s at tod 8600: the day
  // to tod 11000 less the walk back from 64 out and a margin)
  t.deepEqual(b.me.fished.map(f => f.at), ['-509,56,2198', '-509,56,2198']);
  t.deepEqual(b.me.fished.map(f => f.timeoutMs), [60_000, 23_666]);
  t.true(openWater(viewOf(land), { x: -509, y: 56, z: 2198 }, 3));
  t.true(b.me.walks.some(w => w.to === '-514,58,2196'), 'its stand');
  t.is(b.me.gain, 3);
  t.is(text, '[water] made a fishing rod; 3 catch(es) in 84 s at (-509, 56, 2198) from (-514, 58, 2196) (open water), 3 in open water: ' +
    'cod 1, salmon 1 (food: kept raw, carried or stored, cod and salmon cooked by the food goal only once the chests\' ready food runs out); enchanted_book 1 (treasure: kept); back home');
  // the water is the rung's from now on: the next gate counts it 41 out
  t.deepEqual(sitesOf(world, 'fish'), [{ x: -509, y: 56, z: 2198 }]);
  t.is(ask(lookAt(kept(), 9000, { now: T0 }), world), 'water: 43 blocks out (43)');
  t.deepEqual(b.me.said.slice(0, 2), ['out of the yard by its east gate (-533, 63, 2183)', 'fishing at (-509, 56, 2198) from (-514, 58, 2196): open water']);
});

test.serial('the run: a rod in the chests is taken before any string; an enchanted one first; the leads\' string is never made into a rod', async (t) => {
  const land = new Land(2);
  // a worn rod in the gear chest: taken, the string left alone
  const world = homestead(w => { w.chestItems!['-551,63,2181'].fishing_rod = 1; });
  const b = botIn(land, world, kept(), { replies: [{ bites: 1 }] });
  const text = await runLine(b);
  t.deepEqual(b.me.acts.slice(0, 1), ['take-from-chest fishing_rod 1']);
  t.is(world.chestItems!['-547,65,2179'].string, 52);
  t.regex(text, /^\[water\] took a fishing rod from the chests; 1 catch\(es\)/);
  // an enchanted one in the chests (its stack known by its slot) before the plain one: lure and luck of the sea
  const gear = '-551,63,2181';
  const lure = homestead(w => {
    w.chestItems![gear].fishing_rod = 2;
    w.chestStacks = { [gear]: [{ slot: 4, name: 'fishing_rod', count: 1, damage: 2, maxDamage: 64 }, { slot: 9, name: 'fishing_rod', count: 1, damage: 9, maxDamage: 64, enchanted: true, enchantments: [{ name: 'lure', level: 3 }] }] };
  });
  const e = botIn(land, lure, kept(), { replies: [{ bites: 2 }] });
  t.regex(await runLine(e), /^\[water\] took an enchanted fishing rod from the chests; 2 catch\(es\)/);
  t.deepEqual(e.me.acts.slice(0, 1), ['chest.withdraw fishing_rod slot 9']);
  t.like(e.me.items.find(i => i.name === 'fishing_rod'), { enchanted: true });
  t.is(lure.chestItems![gear].fishing_rod, 1);
  // 7 string stored: the rod takes 2, the leads' 5 stay
  const seven = homestead(w => { w.chestItems!['-547,65,2179'].string = 7; });
  const c = botIn(land, seven, kept(), { replies: [{ bites: 1 }] });
  t.regex(await runLine(c), /^\[water\] made a fishing rod; 1 catch\(es\)/);
  t.is(seven.chestItems!['-547,65,2179'].string, 5);
  // 6 (the run sent on the memory of more, a lead made since): none is made of the leads' share; the run never got
  // to the water, and is a failure the brain holds back
  const six = homestead(w => { w.chestItems!['-547,65,2179'].string = 7; });
  const d = botIn(land, six, kept());
  const s = d.ctx.s;
  const goal = goalOf(rung('fish'), d.clock);
  six.chestItems!['-547,65,2179'].string = 6;
  t.false(await makeRod(d.ctx, { keepString: STRING_KEEP, careful: true }));
  t.deepEqual(d.me.acts, [], 'nothing taken');
  six.chestItems!['-547,65,2179'].string = 7;
  const run = goal.run({ ...d.ctx, s });
  six.chestItems!['-547,65,2179'].string = 6;
  await t.throwsAsync(run, { message: /^\[water\] no fishing rod: none in the chests, and none could be made \(3 sticks, 2 string beyond the 5 kept for the leads\)$/ });
  t.is(six.chestItems!['-547,65,2179'].string, 6);
  t.deepEqual(d.me.fished, []);
});

test.serial('the run: a player or someone\'s dog within 8 of the cast, no cast; the pockets full, the rod worn out, or two quiet minutes end it', async (t) => {
  const land = new Land(2);
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  // a player on the shore by the mark: not a cast. Its mark keeps its count (the water said nothing)
  const player = { id: 7, name: 'player', distance: 6, position: { x: -510.5, y: 57, z: 2196.5 } };
  const p = botIn(land, homestead(), [...kept(), { ...rod }], { entities: () => [player] });
  t.is(await runLine(p), '[water] no catch in 0 s at (-509, 56, 2198) from (-514, 58, 2196) (open water); a player 2 blocks from the cast: no more casts; back home');
  t.deepEqual(p.me.fished, []);
  t.like(workOf(p.ctx.world).dry['fish:water'], { n: 1 });
  // someone's tamed wolf 6 off the line: the same; a wild one, or a cow, is no one's (the hook lets go of what it
  // catches: the bridge's), nor a player well away
  const dog = { id: 8, name: 'wolf', distance: 9, tamed: true, position: { x: -511, y: 57, z: 2203 } };
  const d = botIn(land, homestead(), [...kept(), { ...rod }], { entities: () => [dog] });
  t.regex(await runLine(d), /; someone's wolf \d blocks from the cast: no more casts; back home$/);
  const wild = [{ ...dog, tamed: false }, { id: 9, name: 'cow', distance: 9, position: { x: -511, y: 57, z: 2193 } }, { ...player, position: { x: -530, y: 63, z: 2196 } }];
  t.true(Math.hypot(-530 - -514, 63 - 59.6, 2196 - 2196) > CAST_CLEAR);
  const w = botIn(land, homestead(), [...kept(), { ...rod }], { entities: () => wild, replies: [{ bites: 2 }, { bites: 1 }] });
  t.regex(await runLine(w), /^\[water\] 3 catch\(es\) in 84 s /);
  // the pockets full after the first minute: no other cast
  const fill = botIn(land, homestead(), [...kept(), { ...rod }], {
    replies: [{ bites: 2 }, { bites: 2 }],
    after: (_n, me) => { for (let slot = 0; slot < 36; slot++) if (!me.items.some(i => i.slot === slot)) me.items.push({ slot, name: 'dirt', count: 1 }); }
  });
  t.regex(await runLine(fill), /^\[water\] 2 catch\(es\) in 60 s .*; the pockets are full; back home$/);
  t.is(fill.me.fished.length, 1);
  // the rod worn out in the first minute
  const worn = botIn(land, homestead(), [...kept(), { ...rod }], { replies: [{ bites: 3 }, { bites: 1 }], after: (_n, me) => { me.items = me.items.filter(i => i.name !== 'fishing_rod'); } });
  t.regex(await runLine(worn), /^\[water\] 3 catch\(es\) in 60 s .*; the rod wore out; back home$/);
  // two minutes with no bite: the spot is no good
  const quiet = botIn(land, homestead(), [...kept(), { ...rod }], { replies: [{ bites: 0, recalled: 'hook at (-510.0, 57.0, 2197.0) on ground, 61 ticks' }, { bites: 0 }] });
  t.is(await runLine(quiet), '[water] no catch in 84 s at (-509, 56, 2198) from (-514, 58, 2196) (open water); no bite in 84 s; back home');
  t.like(workOf(quiet.ctx.world).dry['fish:water'], { n: 1 });
  // and the hook that caught something on its way out was let go (the bridge's): said
  const hooked = botIn(land, homestead(), [...kept(), { ...rod }], { replies: [{ bites: 1, letGo: ['sheep'] }, { bites: 1 }] });
  t.regex(await runLine(hooked), /: cod 2 \(food: kept raw, carried or stored, cod and salmon cooked by the food goal only once the chests' ready food runs out\); let go of the sheep the hook caught; back home$/);
});

test.serial('the run: still water only, said so; no water, or none with a stand by it, is a dry run; a remembered water gone is forgotten', async (t) => {
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  const shallow = botIn(new Land(1), homestead(), [...kept(), { ...rod }], { replies: [{ bites: 1, open: 0 }, { bites: 1, open: 0 }] });
  t.regex(await runLine(shallow), /^\[water\] 2 catch\(es\) in 84 s at \(-\d+, 56, \d+\) from \(.*\) \(still water, not open \(no treasure\)\), 0 in open water: cod 2/);
  // someone's build all over the lake's ground: no stand, no cast, and a dry mark
  const over: Zone = { x1: -515, y1: 50, z1: 2190, x2: -500, y2: 70, z2: 2208, markers: 30, surface: true };
  const built = botIn(new Land(2), homestead(), [...kept(), { ...rod }], { zones: [over] });
  t.is(await runLine(built), '[water] no water to fish within 64 blocks of home outside the yard and 16 from anyone\'s build');
  t.like(workOf(built.ctx.world).dry['fish:water'], { n: 1 });
  // a water remembered that has none now (the lake drained, built over): forgotten, and the look goes on
  const gone = homestead(w => { workOf(w).sites.fish = [{ x: -470, y: 60, z: 2150 }]; });
  const g = botIn(new Land(2), gone, [...kept(), { ...rod }], { replies: [{ bites: 1 }] });
  // (sent out for the water 86 out it remembered: the budget is the shorter for it)
  t.regex(await runLine(g), /^\[water\] 1 catch\(es\) in 76 s at \(-509, 56, 2198\)/);
  t.true(g.me.said.includes('no cast by (-470, 60, 2150) any more: forgotten'));
  t.deepEqual(sitesOf(gone, 'fish'), [{ x: -509, y: 56, z: 2198 }]);
});

test.serial('the run: a hook let go of a player ends the jar\'s call, and no cast goes out while they stand in the line; an animal let go is no quiet slice, three in a row end the run', async (t) => {
  const land = new Land(2);
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  // a player walks onto the shore 3 s into the first call: the hook catches them in its flight, the jar lets go and
  // ends its call there (Interact.java), and the look before the next cast sees them by the line: no other cast
  let walkedIn = false;
  const player = { id: 7, name: 'player', distance: 4, position: { x: -511.5, y: 57.5, z: 2197 } };
  const p = botIn(land, homestead(), [...kept(), { ...rod }], {
    entities: () => (walkedIn ? [player] : []), replies: [{ bites: 0, letGo: ['player'], ms: 3000 }], after: () => { walkedIn = true; }
  });
  t.regex(await runLine(p), /^\[water\] no catch in 3 s at \(-509, 56, 2198\) .*; let go of the player the hook caught; a player \d blocks from the cast: no more casts; back home$/);
  t.is(p.me.fished.length, 1);
  // a wild sheep grazing in the line, hooked at every cast: each call ends on its let-go, none of them a quiet one,
  // and the third in a row ends the run
  const sheep = (n: number) => Array.from({ length: n }, (): Reply => ({ bites: 0, letGo: ['sheep'], ms: 2000 }));
  const s = botIn(land, homestead(), [...kept(), { ...rod }], { replies: sheep(5) });
  t.regex(await runLine(s), /^\[water\] no catch in 6 s .*; let go of the sheep the hook caught; the hook keeps catching the sheep: no more casts; back home$/);
  t.is(s.me.fished.length, 3);
  // twice, and then it grazes off: the next call's bites come (two let-go calls were "no bite in 4 s" before)
  const off = botIn(land, homestead(), [...kept(), { ...rod }], { replies: [...sheep(2), { bites: 2 }] });
  t.regex(await runLine(off), /^\[water\] 2 catch\(es\) in 84 s .*: cod 2 .*; let go of the sheep the hook caught; back home$/);
  // a dropped item the hook caught (its own catch flying in) is no one's: the jar casts on, and a call with no bite is
  // a quiet one as ever
  const item = botIn(land, homestead(), [...kept(), { ...rod }], { replies: [{ bites: 0, letGo: ['item'] }, { bites: 0 }] });
  t.regex(await runLine(item), /; let go of the item the hook caught; no bite in 84 s; back home$/);
});

test.serial('the run keeps to its budget: walks to stands that stop short get what is left, and with too little left for a walk or a cast it fishes nothing and writes no dry mark', async (t) => {
  const land = new Land(2);
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  const stand = (p: Pos) => p.y < 62;
  // the walks to the shore stop short after 30 s each (a bank the careful walk cannot climb): 84 s of budget at tod
  // 8600, the second walk gets what is left less a last slice, and no third is sent. It never fished: no dry mark,
  // a failure the brain holds back for a few minutes
  const world = homestead();
  const stuck = botIn(land, world, [...kept(), { ...rod }], { slowWalk: { to: stand, ms: ms => Math.min(ms, 30_000), arrived: false } });
  await t.throwsAsync(runLine(stuck), { message: /^\[water\] too little of the run left to reach a stand by the water at \(-509, 56, 2198\); back home$/ });
  t.deepEqual(stuck.me.walks.filter(w => Number(w.to.split(',')[1]) < 62).map(w => w.timeoutMs), [60_000, 38_666]);
  t.deepEqual(stuck.me.fished, []);
  t.false('fish:water' in workOf(world).dry);
  // a walk that got to the stand only after its time (the call's own timeout is 15 s longer): less than a last slice
  // left, no cast, and no dry mark either
  const late = homestead();
  const slow = botIn(land, late, [...kept(), { ...rod }], { slowWalk: { to: stand, ms: ms => ms + 10_000, arrived: true } });
  await t.throwsAsync(runLine(slow), { message: /^\[water\] too little of the run left to cast at \(-509, 56, 2198\) from \(-514, 58, 2196\); back home$/ });
  t.deepEqual(slow.me.fished, []);
  t.false('fish:water' in workOf(late).dry);
});

test.serial('the run: no bite asked for beyond the pockets\' free slots (a treasure stacks with nothing), and a call the bridge ended for full pockets ends the run', async (t) => {
  const land = new Land(2);
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  // 34 slots in use (the yard's room: 2 free), and a rod taken from the chests: one free. Three treasures bite in the
  // first minute; only one can come in, so only one is asked for, and the next look finds the pockets full
  const items = kept();
  for (let slot = 0; items.filter(i => i.slot < 36).length < 34; slot++) if (!items.some(i => i.slot === slot)) items.push({ slot, name: 'dirt', count: 1 });
  const b = botIn(land, homestead(w => { w.chestItems!['-551,63,2181'].fishing_rod = 1; }), items, { replies: [{ bites: 3, got: ['enchanted_book', 'saddle', 'name_tag'] }, { bites: 1 }] });
  t.regex(await runLine(b), /^\[water\] took a fishing rod from the chests; 1 catch\(es\) in 60 s .*: enchanted_book 1 \(treasure: kept\); the pockets are full; back home$/);
  t.deepEqual(b.me.fished.map(f => f.times), [1]);
  t.is(b.me.gain, 1, 'every bite counted came to the pockets');
  t.is(b.count('enchanted_book'), 1);
  // the bridge ended its call before a cast with no free slot (a fish stacked, then something else took the slot):
  // no other call
  const f = botIn(land, homestead(), [...kept(), { ...rod }], { replies: [{ bites: 2, full: true, ms: 20_000 }, { bites: 2 }] });
  t.regex(await runLine(f), /^\[water\] 2 catch\(es\) in 20 s .*; the pockets are full; back home$/);
  t.is(f.me.fished.length, 1);
});

test.serial('the run: no cast on a look round that failed, and a call the bridge ended for someone by the line is the last', async (t) => {
  const land = new Land(2);
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  // world.entities timed out: who stands about is not known, no cast
  const blind = botIn(land, homestead(), [...kept(), { ...rod }], { entities: () => { throw new Error('timed out'); } });
  t.regex(await runLine(blind), /; could not look round for anyone by the cast: no more casts; back home$/);
  t.deepEqual(blind.me.fished, []);
  // a player walked into the line 15 s into the call: the bridge looked before its next recast and ended the call;
  // the brain casts no more (its own look comes before a call only)
  const p = botIn(land, homestead(), [...kept(), { ...rod }], { replies: [{ bites: 1, blocked: 'a player 3 blocks from the cast', ms: 15_000 }, { bites: 2 }] });
  t.regex(await runLine(p), /^\[water\] 1 catch\(es\) in 15 s .*; a player 3 blocks from the cast: no more casts; back home$/);
  t.is(p.me.fished.length, 1);
});

test.serial('the run: a walk slower than the gate reckoned that leaves 15 to 29 s at the water, no bite in them: no dry mark', async (t) => {
  const land = new Land(2);
  const rod: InventoryItem = { slot: 25, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 };
  // 84 s of budget at tod 8600; the walk to the stand takes 62 s and gets there: one slice of 22 s, a bite every 25 s
  const world = homestead();
  const b = botIn(land, world, [...kept(), { ...rod }], { slowWalk: { to: (p: Pos) => p.y < 62, ms: () => 62_000, arrived: true }, biteMs: 25 * SECOND });
  t.is(await runLine(b), '[water] no catch in 22 s at (-509, 56, 2198) from (-514, 58, 2196) (open water); too short a try to judge the water (under 30 s); back home');
  t.deepEqual(b.me.fished.map(f => f.timeoutMs), [21_666]);
  t.false('fish:water' in workOf(world).dry);
});

test.serial('the run: a rod made late in the window that leaves too little for the walk and half a minute at the water: it does not set out, no dry mark, and the gate says late after it', async (t) => {
  const land = new Land(2);
  const world = homestead();
  // tod 9240, 88 s of daylight: the gate lets it go (the walk there and back, 15 s and 30 s at the water, 87.7 s);
  // the rod takes two chests and the walk to the table on foot, 5 s, and 47 s of the 52 s of budget are left, for a
  // walk of 21 s out and 30 s at the water
  const b = botIn(land, world, kept(), { tod: () => 9240 + (b.clock.now - T0) / 50, walkMs: blocks => blocks / 3 * SECOND + SECOND, biteMs: 25 * SECOND });
  const s = lookAt(kept(), 9240, { now: T0 });
  t.is(ask(s, world), 'water: 64 blocks out (64)');
  const text = await goalOf(rung('fish'), b.clock).run({ ...b.ctx, s });
  t.is(text, '[water] made a fishing rod; not setting out: that took 5 s, too little of the run is left for the walk and 30 s at the water; back home');
  t.deepEqual(b.me.fished, []);
  t.false('fish:water' in workOf(world).dry);
  t.is(b.count('fishing_rod'), 1, 'the rod kept for the next evening');
  // the next tick's gate: late (and it would set out at once with the rod carried, the evening after)
  t.regex(ask(lookAt(b.me.items, 9240 + (b.clock.now - T0) / 50, { now: b.clock.now }), world), /^late: /);
});

// ---- the catch ----

test('what the stash does with each catch: fish carried, treasure and stock kept, junk thrown at the dump; never anything enchanted', (t) => {
  // 26.3's loot tables (gameplay/fishing/fish, junk, treasure): every item in them has its kind
  const loot = ['cod', 'salmon', 'tropical_fish', 'pufferfish', 'lily_pad', 'leather_boots', 'leather', 'bone', 'potion', 'string', 'fishing_rod', 'bowl', 'stick',
    'ink_sac', 'tripwire_hook', 'rotten_flesh', 'bamboo', 'name_tag', 'saddle', 'bow', 'enchanted_book', 'nautilus_shell'];
  t.deepEqual(loot.filter(n => !CATCH[n]), []);
  t.deepEqual(loot.filter(n => CATCH[n] === 'junk').sort(), ['bowl', 'leather_boots', 'lily_pad', 'rotten_flesh', 'tripwire_hook']);
  t.deepEqual(loot.filter(n => CATCH[n] === 'treasure').sort(), ['bow', 'enchanted_book', 'name_tag', 'nautilus_shell', 'saddle']);
  t.is(catchWords({ cod: 5, salmon: 2, enchanted_book: 1, bowl: 1, string: 1 }), 'cod 5, salmon 2 (food: kept raw, carried or stored, cod and salmon cooked by the food goal only once the chests\' ready food runs out); enchanted_book 1 (treasure: kept); string 1 (kept); bowl 1 (junk: to the dump)');
  t.is(catchWords({ fishing_rod: 2 }, 1), 'enchanted fishing_rod 1 (treasure: kept); fishing_rod 1 (kept)');
  // the stash, after an evening's catch, by day (the dump is a day's walk)
  const w = homestead();
  const ench = { enchanted: true, enchantments: [{ name: 'lure', level: 3 }] };
  const items: InventoryItem[] = [
    ...kept().filter(i => i.slot < 36).slice(0, 12),
    { slot: 12, name: 'fishing_rod', count: 1, damage: 30, maxDamage: 64 }, { slot: 13, name: 'fishing_rod', count: 1, damage: 40, maxDamage: 64, ...ench },
    { slot: 14, name: 'cod', count: 20 }, { slot: 15, name: 'salmon', count: 7 }, { slot: 16, name: 'tropical_fish', count: 1 }, { slot: 17, name: 'pufferfish', count: 3 },
    { slot: 18, name: 'lily_pad', count: 2 }, { slot: 19, name: 'bowl', count: 1 }, { slot: 20, name: 'tripwire_hook', count: 1 }, { slot: 21, name: 'leather_boots', count: 1, damage: 30, maxDamage: 65 },
    { slot: 22, name: 'enchanted_book', count: 1, enchantments: [{ name: 'mending', level: 1 }] }, { slot: 23, name: 'name_tag', count: 1 }, { slot: 24, name: 'saddle', count: 1 },
    { slot: 25, name: 'nautilus_shell', count: 1 }, { slot: 26, name: 'bow', count: 1, damage: 20, maxDamage: 384, ...ench }, { slot: 27, name: 'leather', count: 1 },
    { slot: 28, name: 'potion', count: 1, potion: 'water' }, { slot: 29, name: 'ink_sac', count: 10 }
  ].concat(WORN.map(i => ({ ...i })));
  const plan = stashList(lookAt(items, 6000, { now: T0 }), w);
  const names = (es: { name: string; count: number }[]) => Object.fromEntries(es.map(e => [e.name, e.count]));
  t.deepEqual(names(plan.drop.filter(e => ['lily_pad', 'bowl', 'tripwire_hook', 'leather_boots'].includes(e.name))), { lily_pad: 2, bowl: 1, tripwire_hook: 1, leather_boots: 1 });
  const stored = names(plan.deposit);
  for (const n of ['enchanted_book', 'name_tag', 'saddle', 'nautilus_shell', 'bow', 'leather', 'potion', 'ink_sac', 'pufferfish']) t.true(stored[n] >= 1, n);
  // the fish kept raw, carried (the food goal cooks the cod and salmon only once the chests' ready food runs out); of
  // two rods the enchanted one is the keeper, and the other goes by its slot (the test below)
  for (const n of ['cod', 'salmon', 'tropical_fish']) t.false(n in stored || plan.drop.some(e => e.name === n), n);
  t.deepEqual(stashPlan(items).deposit.filter(e => e.name === 'fishing_rod'), [{ name: 'fishing_rod', count: 1, slot: 12 }]);
  t.false(plan.drop.some(e => e.name === 'fishing_rod'));
  // nothing enchanted is ever thrown: an enchanted pair of leather boots keeps every pair carried out of the dump (the
  // throw is by name)
  t.false(plan.drop.some(e => ['enchanted_book', 'bow', 'fishing_rod', 'name_tag', 'saddle', 'nautilus_shell'].includes(e.name)));
  const two = stashPlan([{ slot: 0, name: 'leather_boots', count: 1, damage: 3, maxDamage: 65 }, { slot: 1, name: 'leather_boots', count: 1, enchanted: true, enchantments: [{ name: 'unbreaking', level: 1 }] },
    { slot: 2, name: 'diamond_boots', count: 1 }]);
  t.deepEqual(two.drop, []);
  t.deepEqual(two.deposit.map(e => e.slot).sort(), [0, 1]);
  // the fish over their caps in the chests go to the dump as the farm's produce does
  t.deepEqual([GLUT.cod, GLUT.salmon, GLUT.pufferfish, GLUT.tropical_fish], [256, 128, 32, 32]);
  const full = homestead(x => { x.chestItems!['-551,63,2183'].pufferfish = 40; });
  t.deepEqual(stashList(lookAt(items, 6000, { now: T0 }), full).drop.filter(e => e.name === 'pufferfish'), [{ name: 'pufferfish', count: 3 }]);
});

test.serial('the rods the rung brings up go in the chests one by one by their slots, the gear\'s chest first; the enchanted one stays carried; the mine\'s room is not lost to them', async (t) => {
  // a rod is about one catch in a hundred, and one enchanted with mending never wears out: the extra ones were kept
  // carried for good (a deposit by name could take the keeper, so none went), and nine of them left the mine 'no' room
  const world = homestead();
  const ench = { enchanted: true, enchantments: [{ name: 'mending', level: 1 }, { name: 'lure', level: 2 }] };
  const rods: InventoryItem[] = [
    { slot: 25, name: 'fishing_rod', count: 1, damage: 3, maxDamage: 64 },
    { slot: 26, name: 'fishing_rod', count: 1, damage: 40, maxDamage: 64, ...ench },
    { slot: 27, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 }
  ];
  const items = [...kept(), ...rods];
  const s = lookAt(items, 6000, { now: T0 });
  // the two plain ones, by their slots; the enchanted one is the keeper
  const byRod = (es: { name: string }[]) => es.filter(e => e.name === 'fishing_rod');
  t.deepEqual(byRod(stashList(s, world).deposit), [{ name: 'fishing_rod', count: 1, slot: 25 }, { name: 'fishing_rod', count: 1, slot: 27 }]);
  const work = stashWork(s, world);
  t.deepEqual(work.bySlot, [{ name: 'fishing_rod', count: 1, slot: 25 }, { name: 'fishing_rod', count: 1, slot: 27 }]);
  t.deepEqual(byRod([...work.moves, ...work.rest]), [], 'never by name');
  // what the room rule counts: the two rods' slots and the kit's two oak logs
  t.is(stashReach(s, world).goes.get('fishing_rod'), 2);
  t.is(pockets(s, world).loose, 3);
  // put away: each by its slot, into the gear's emptier chest, its stack remembered there (the rung takes an
  // enchanted one back out by it)
  const b = botIn(new Land(2), world, items);
  await putAway(b.ctx, s, stashKeep(world));
  t.deepEqual(b.me.acts.filter(a => a.startsWith('chest.deposit')), ['chest.deposit fishing_rod slot 25', 'chest.deposit fishing_rod slot 27']);
  t.deepEqual(b.me.items.filter(i => i.name === 'fishing_rod'), [rods[1]]);
  t.deepEqual(world.chestStacks!['-547,64,2182'].map(st => [st.name, st.damage]), [['fishing_rod', 3], ['fishing_rod', 0]]);
  t.is(world.chestItems!['-547,64,2182'].fishing_rod, 2);
  // nine rods carried with the kept kit: 7 free of the mine's 10 was 'no' (the logs alone to put away), and is the
  // stash's now; fourteen, and the same of a Nether trip's 12
  const carrying = (n: number) => lookAt([...kept(), ...Array.from({ length: n }, (_, i): InventoryItem => ({ slot: 20 + i, name: 'fishing_rod', count: 1, damage: i, maxDamage: 64 }))], 2000, { now: T0 });
  t.is(carrying(9).slotsUsed, 29);
  t.is(room('deep', carrying(9), homestead()), 'stash');
  t.is(room('nether', carrying(14), homestead()), 'stash');
});

// ---- the evening, as brain.log has it ----

/** Real time going by on the fake clock, ended early (and thrown) when the brain gives the run up. */
function wait(ms: number): Promise<void> {
  const signal = brainRun.getStore()?.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const tm = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(tm); reject(new Error('aborted')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * The homestead as it stood on the evening of Nov 15, as far as the ladder's gates read it: the cane patch whole (24
 * cells), the cow pen counted just now with its six, the coal stocked, nothing of the deep stock at its target (the
 * deep rung is the evening's `late`), the trips and the villager moves off; 52 string and the sticks in the chests,
 * no rod carried.
 */
function nov15(w: WorldMemory): void {
  w.zones!.cane = [...w.zones!.cane!, ...Array.from({ length: 19 }, (_, i) => ({ x: -517 + i % 10, y: 63, z: 2206 + Math.floor(i / 10) }))];
  w.chestItems!['-547,63,2180'].coal = 140;
  workOf(w).pen.cow = { adults: 6, babies: 0, at: T0 };
}

/**
 * The rest of the brain's list as it stood that evening: the home rounds done 5 min before tod 8500 (each comes round
 * every 20 to 30 min: none again before dusk), the pens round just now (it counted the six, nov15: it comes round every
 * 6 min), and the project with nothing left to do (brain.json's `done` held all 15 milestones of the tree on Nov 15).
 */
function quietHome(w: WorldMemory): void {
  for (const k of ROUNDS) w.lastDone![k] = T0 - 5 * 60_000;
  w.lastDone!.pens = T0;
  const p = w.progress!;
  p.done = TREE.map(m => m.id);
  delete p.current;
  delete p.blocked;
  delete p.need;
  p.blockedUntil = {};
}

/**
 * A live evening, tod 8500 to 11500, on the brain over the stand-in game and the fake clock: the ladder of `tasks`
 * (their gates and runs real) and the walk back to the yard, the walks at 3 blocks a second, a bite every 25 s. The
 * day's idle by cause from the tally, the log, and the game. `whole`: the brain's own goal list as brain.ts builds it,
 * its ladder made of `tasks` where its own stands, the idle goal real, and every other goal's run one that only says
 * it ran (`others`), over the quiet home (quietHome). `names`: the goal list the brain built.
 */
async function evening(tasks: WorkTask[], whole = false) {
  const clock = sinon.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-'));
  try {
    const file = path.join(dir, 'brain.json');
    const logFile = path.join(dir, 'brain.log');
    fs.writeFileSync(file, JSON.stringify({ 'seed:1': homestead(w => { nov15(w); if (whole) quietHome(w); }) }));
    let brain: Brain | undefined;
    const tod = () => 8500 + (Date.now() - T0) / 50;
    const b = botIn(new Land(2), () => brain!.worldMemory()!, kept(), { tod, pass: wait, walkMs: blocks => blocks / 3 * SECOND + SECOND, biteMs: 25 * SECOND });
    const reply = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) });
    const rt = {
      actions: new Proxy({}, { get: (_k, tool: string) => async (a: Record<string, unknown>) => reply(await b.act(tool, a)) }),
      call: b.call as ClientRuntime['call'],
      status: b.status,
      home: () => ({ ...HOME, dimension: 'overworld' }),
      lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
      restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
    } as unknown as ClientRuntime;
    const ladder = workGoals(() => undefined, tasks, () => Date.now());
    brain = new Brain(rt, { memoryFile: file, logFile, ...(whole ? {} : { goals: [...ladder, returnIdle] }) });
    const own = (brain as unknown as { goals: Goal[] }).goals;
    const names = own.map(g => g.name);
    const others: string[] = [];
    if (whole) {
      const first = own.find(g => taskOf(g));
      (brain as unknown as { goals: Goal[] }).goals = own.flatMap(g => (taskOf(g) ? (g === first ? ladder : []) : g.name === 'idle' ? [g]
        : [{ ...g, run: async () => { others.push(g.name); return 'not modelled'; } }]));
    }
    brain.setEnabled(true);
    for (let i = 0; i < 100 && tod() < 11_500; i++) await clock.tickAsync(5 * SECOND);
    brain.setEnabled(false);
    await clock.tickAsync(10 * SECOND);
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => ({ tod: Math.round(8500 + (Date.parse(l.slice(0, 24)) - T0) / 50), text: l.slice(25) }));
    return { today: idleOf(brain.worldMemory()!).today, lines, me: b.me, world: brain.worldMemory()!, names, others };
  } finally {
    clock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.serial('a live evening, tod 8500 to 11500: the `late` idle the far rungs leave is the fishing rung\'s now, and brain.log says so', async (t) => {
  // as it was: the ladder without the rung. From tod 8520 on nothing fits the day (the far rungs at the leash, the
  // deep window shut since 5000): the evening idles to dusk, all of it `late` (live: 111 s of 551 at 20:59Z on Nov 15)
  const before = await evening(LADDER.filter(r => r.name !== 'fish'));
  const was = `idle ${Math.round(before.today.idleMs / SECOND)} s of ${Math.round(before.today.workMs / SECOND)} s: ${JSON.stringify(before.today.by)}`;
  t.log(`without the rung: ${was}`);
  t.true(before.today.workMs >= 110 * SECOND, was);
  t.is(before.today.by.late, before.today.workMs, was);
  t.deepEqual(before.lines.filter(l => /^start /.test(l.text)), [], was);
  // with it: the rung sets out the moment the far rungs are late, makes its rod, fishes the lake till the budget is
  // spent and walks home by the gate before dusk; what idles is the evening's last seconds
  const after = await evening(LADDER);
  const now = `idle ${Math.round(after.today.idleMs / SECOND)} s of ${Math.round(after.today.workMs / SECOND)} s: ${JSON.stringify(after.today.by)}`;
  const log = after.lines.map(l => `${l.tod} ${l.text}`).join('\n');
  t.log(`with it: ${now}\n${log}`);
  t.true((after.today.by.late ?? 0) <= 25 * SECOND, `${now}\n${log}`);
  t.true(after.today.idleMs <= 25 * SECOND, `${now}\n${log}`);
  t.is(after.today.emptyMs, 0, now);
  const said = after.lines.filter(l => /^(start|done|failed|stopped) work: fish/.test(l.text));
  t.is(said.length, 2, log);
  // (the brain's first tick of the evening: 5 s in)
  t.true(said[0].tod >= 8520 && said[0].tod <= 8620, log);
  t.is(said[0].text, 'start work: fish: water: 64 blocks out');
  // the rod and the walk out (20 s) come off the run's budget (84 s from tod 8600: the day less the walk back from 64
  // out and a margin), a minute is left at the water: two bites
  t.regex(said[1].text, /^done work: fish in \d+s: \[water\] made a fishing rod; 2 catch\(es\) in 60 s at \(-509, 56, 2198\) from \(-514, 58, 2196\) \(open water\): cod 2 \(food: kept raw, carried or stored, cod and salmon cooked by the food goal only once the chests' ready food runs out\); back home$/);
  t.true(said[1].tod <= 11_000, `home by dusk: ${log}`);
  // the line under its start says why no rung above it ran instead
  t.is(after.lines.find(l => l.text.startsWith('work: fish: skipped: '))!.text, 'work: fish: skipped: cane patch (unneeded: 24 cells) | cows (unneeded: the pen has 6 cows (they breed the rest)) | ' +
    'cane (unneeded: the patch grows it (24 cells)) | trip kit (unneeded: kit ready) | rails (unneeded: no line to lay) | villagers (unneeded: villager moves are off) | nether (unneeded: trips are off) | ' +
    'deep (late: needs 3 min, 0.0 left) | surface (stocked: coal 146 (keep 128))');
  // and what idles is the evening's last seconds, home: too little of the day left for another walk to the lake
  t.regex(after.lines.at(-3)!.text, /^idle \d+s: late: deep needs 3 min, 0\.0 left/);
  t.is(after.me.walks.filter(w => !w.careful).length, 1, 'the one leg of the walk home from out by the lake to the gate (inByGate)');
  t.deepEqual(sitesOf(after.world, 'fish'), [{ x: -509, y: 56, z: 2198 }]);
});

test.serial('spare time retired: the brain\'s own list has it no more, and on the live evening (tod 8500 to 11500) its whole list leaves the `late` idle to the fishing rung; nothing else runs', async (t) => {
  // spare time (spare.ts) went with anti-idle step 6. It stockpiled iron, coal and logs to 96, 64 and 64 at home, by
  // day until tod 8000 (it set out only with 3000 ticks of daylight left): the deep rung keeps iron now (96 at tier
  // 0), the surface rung coal (128), and the stock trips (32) and the tree farm logs. Live every one was over its cap
  // (iron 8224, coal 109, logs 3112 on Nov 15) and it had not run since Nov 12; it never had the evening. Below the
  // work rungs now is only the idle goal
  const before = await evening(LADDER.filter(r => r.name !== 'fish'), true);
  t.false(before.names.includes('spare time'), before.names.join(', '));
  t.deepEqual(before.names.slice(-2), ['work: fish', 'idle'], before.names.join(', '));
  // without the rung the whole list idles the evening to dusk, all of it `late` (live: 111 s of 551 at 20:59Z on Nov
  // 15), and nothing else of it starts
  const was = `idle ${Math.round(before.today.idleMs / SECOND)} s of ${Math.round(before.today.workMs / SECOND)} s: ${JSON.stringify(before.today.by)}`;
  t.log(`the whole list without the rung: ${was}\n${before.lines.map(l => `${l.tod} ${l.text}`).join('\n')}`);
  t.true(before.today.workMs >= 110 * SECOND, was);
  t.is(before.today.by.late, before.today.workMs, was);
  t.deepEqual(before.lines.filter(l => /^start /.test(l.text)), [], was);
  t.deepEqual(before.others, [], was);
  // with it: the rung's evening as on the ladder alone (the test above), the rest of the list round it never wanting
  const after = await evening(LADDER, true);
  const now = `idle ${Math.round(after.today.idleMs / SECOND)} s of ${Math.round(after.today.workMs / SECOND)} s: ${JSON.stringify(after.today.by)}`;
  const log = after.lines.map(l => `${l.tod} ${l.text}`).join('\n');
  t.log(`the whole list with it: ${now}\n${log}`);
  t.deepEqual(after.others, [], log);
  t.deepEqual(after.lines.filter(l => /^start /.test(l.text)).map(l => l.text), ['start work: fish: water: 64 blocks out'], log);
  t.true((after.today.by.late ?? 0) <= 25 * SECOND, `${now}\n${log}`);
  t.true(after.today.idleMs <= 25 * SECOND, `${now}\n${log}`);
  t.is(after.today.emptyMs, 0, now);
  const done = after.lines.find(l => l.text.startsWith('done work: fish'));
  t.regex(done?.text ?? '', /^done work: fish in \d+s: \[water\] made a fishing rod; 2 catch\(es\) in 60 s at \(-509, 56, 2198\) from \(-514, 58, 2196\) \(open water\): cod 2 \(food: kept raw, carried or stored, cod and salmon cooked by the food goal only once the chests' ready food runs out\); back home$/, log);
  t.true(done!.tod <= 11_000, `home by dusk: ${log}`);
});
