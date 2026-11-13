import test from 'ava';
import { Brain, decide } from '../../src/client/brain/brain.js';
import type { ClientRuntime, InventoryItem } from '../../src/client/tools.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { ROUND_WALK, roundFrom, toRound } from '../../src/client/brain/work.js';
import { BED, HOME, KEPT, MINUTE, T0, WORN, liveWorld, lookAt, roundsAt, withProject } from '../helpers/homestead.js';

/**
 * The home rounds (lights, tidy, repair, signs, sort) on the live day of Nov 13 (brain.log 05:22Z to 06:25Z, five game
 * days): they wanted within 10 of home only (tidy 12, signs 24), and the day went up at the bed (16 out), the tree
 * round, a deep trip, home for the stash (which outranks them all), the farm round out to the plot (22 out), `late`
 * there, the bed. None of the five ran for an hour, 63 min since, three times their time. Now one that is due wants
 * anywhere in the yard on home's level, walks home first (on foot) from beyond its old reach, and from out there stops
 * no running goal for it. On the live homestead (tests/helpers/homestead.ts).
 */

const FIVE = ['repair', 'lights', 'tidy', 'signs', 'sort'];
/** Each round's old reach of home: within it the round starts where it is, as ever. */
const REACH: Record<string, number> = { repair: 10, lights: 10, tidy: 12, signs: 24, sort: 10 };
/** Where the farm round leaves the bot: the plot, 22 from home. */
const PLOT: Pos = { x: -545, y: 63, z: 2161 };
/** The yard's far end by the tree farm, 48 from home: beyond every round's old reach. */
const FAR: Pos = { x: -549, y: 63, z: 2135 };
const SIDE_POST = 'oak_fence[east=false,north=true,south=true,waterlogged=false,west=false]';
/** What the bot built, as the record has it: the cabin's planks by home, and a post of the yard's east fence. */
const BUILT = [{ at: { x: -549, y: 64, z: 2190 }, state: 'oak_planks' }, { at: { x: -533, y: 63, z: 2160 }, state: SIDE_POST }];
const RT = {
  actions: {}, call: async () => ({}), status: async () => ({ inWorld: true, username: 'Bot', screen: null }), home: () => ({ ...HOME, dimension: 'overworld' }),
  lastDeath: () => undefined, setManualHook: () => undefined, setHomeZone: () => undefined,
  builtNear: (c: Pos, r: number) => BUILT.filter(b => Math.hypot(b.at.x - c.x, b.at.z - c.z) <= r),
  restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
} as unknown as ClientRuntime;
/** The goal list as the brain builds it, over that record. */
const realGoals = (): Goal[] => (new Brain(RT, { tickMs: 1e9, now: () => T0 }) as unknown as { goals: Goal[] }).goals;
const round = (goals: Goal[], name: string) => goals.find(g => g.name === name)!;
const across = (p: { x: number; z: number }) => Math.hypot(p.x - HOME.x, p.z - HOME.z);
/** The live kept kit after the stash (torches in it), the diamond armour worn. */
const KIT: InventoryItem[] = [...KEPT.map(([name, count], slot) => ({ slot, name, count })), ...WORN.map(i => ({ ...i }))];
/** Awake by day at `p` at the time of day `tod`, `ms` after T0. */
const at = (p: Pos, tod = 9200, ms = 0, over: Partial<Snapshot> = {}): Snapshot =>
  lookAt(KIT, tod, { now: T0 + ms, position: { ...p }, distHome: across(p), ...over });

/**
 * The live day's homestead as the farm round ends at the plot: the stash, the trees, the cane, the pens, the furnace
 * and the rest done a minute ago, the farm just now, the five rounds 63 min ago; the project blocked on leather (try
 * 116), the cane patch grown to its 24 cells. Each round has something to do, as live: torches carried, things built,
 * a chest without its sign, things in the wrong chest.
 */
function liveDay(): WorldMemory {
  const w = withProject(liveWorld(), true);
  roundsAt(w, MINUTE);
  roundsAt(w, 63 * MINUTE, FIVE);
  w.lastDone!.farm = T0;
  w.zones!.cane = [...w.zones!.cane, ...Array.from({ length: 19 }, (_, i) => ({ x: -517 + i % 10, y: 63, z: 2206 + Math.floor(i / 10) }))];
  delete w.chestSigns!['-547,63,2182'];
  w.chestItems!['-551,63,2183'].cobblestone = 12;
  return w;
}

test('the live day: after a deep trip and the farm, at the plot 22 out with the rounds 63 min since, repair, lights, tidy, signs and sort each run that day', (t) => {
  const world = liveDay();
  const goals = realGoals();
  // as the farm ends at tod 9200 (06:16Z: `late: 1.2 min of daylight left` 18 s on), 22 out at the plot
  let p = { ...PLOT };
  let ms = 0;
  const ran: { name: string; from: string; walk: boolean; tod: number }[] = [];
  // each run as it went live (05:22Z): where it leaves the bot and how long it takes. The first round from out in the
  // yard walks home (to within 8, on foot: toRound); the lights end out on a route past the fence (a torch at
  // (-516, 2186)), and the walk back to the yard brings the bot home
  const end: Record<string, { to?: Pos; s: number }> = {
    repair: { s: 10 }, lights: { to: { x: -516, y: 63, z: 2186 }, s: 27 }, idle: { to: { x: -549, y: 63, z: 2181 }, s: 10 }, tidy: { s: 1 }, signs: { s: 1 }, sort: { s: 60 }
  };
  for (let i = 0; i < 8 && ran.filter(r => FIVE.includes(r.name)).length < FIVE.length; i++) {
    const tod = 9200 + ms / 50;
    const s = at(p, tod, ms);
    const d = decide(s, world, goals, new Map());
    if (!d) break;
    const reach = REACH[d.goal.name];
    const walk = reach !== undefined && across(p) > reach;
    ran.push({ name: d.goal.name, from: `${Math.round(across(p))} out`, walk, tod });
    if (!end[d.goal.name]) break;
    // the round's own mark, as its run writes it
    if (reach !== undefined) world.lastDone![d.goal.name] = s.now;
    if (d.goal.name === 'signs') world.chestSigns!['-547,63,2182'] = 'seeds1';
    if (d.goal.name === 'sort') world.chestItems!['-551,63,2183'].cobblestone = 0;
    if (walk) p = { x: -548, y: 63, z: 2176 };
    if (end[d.goal.name].to) p = { ...end[d.goal.name].to! };
    ms += end[d.goal.name].s * 1000;
  }
  // each by day, before the walk home before dark (tod 11000): the sort, last, at 10180 with 41 s of it left
  t.deepEqual(ran, [
    { name: 'repair', from: '22 out', walk: true, tod: 9200 },
    { name: 'lights', from: '7 out', walk: false, tod: 9400 },
    { name: 'idle', from: '33 out', walk: false, tod: 9940 },
    { name: 'tidy', from: '2 out', walk: false, tod: 10_140 },
    { name: 'signs', from: '2 out', walk: false, tod: 10_160 },
    { name: 'sort', from: '2 out', walk: false, tod: 10_180 }
  ]);
});

test('the rounds start in the yard on home\'s level only: the bed, the plot and the yard\'s far end yes; under the yard, past the fence, another dimension, at night no', (t) => {
  const world = liveDay();
  const goals = realGoals();
  const wanting = (s: Snapshot) => FIVE.filter(n => round(goals, n).wants(s, world));
  // in the yard: the bed (16 out, where the day starts), the plot (22), the tree farm's end of the yard (58 out)
  for (const p of [HOME, BED, PLOT, { x: -549, y: 63, z: 2125 }, { x: -564, y: 63, z: 2214 }]) t.deepEqual(wanting(at(p)), FIVE, `in the yard at ${p.x}, ${p.z}`);
  // under the yard: 55 below the plot, and the live pocket (-534, 8, 2182) 15 out
  t.deepEqual(wanting(at({ ...PLOT, y: 8 })), []);
  t.deepEqual(wanting(at({ x: -534, y: 8, z: 2182 })), []);
  // past the fence: 5 past the east fence (21 out: the signs' old 24 took it), the cane on the shore (33 out), the
  // east gate's far side, the north gate's, the mine start 56 out
  for (const p of [{ x: -528, y: 63, z: 2183 }, { x: -527, y: 62, z: 2207 }, { x: -532, y: 63, z: 2183 }, { x: -549, y: 63, z: 2118 }, { x: -493, y: 67, z: 2183 }]) {
    t.deepEqual(wanting(at(p)), [], `past the fence at ${p.x}, ${p.z}`);
  }
  t.deepEqual(wanting(at(PLOT, 9200, 0, { dimension: 'the_nether', distHome: Infinity })), []);
  t.deepEqual(wanting(at(PLOT, 15_000)), [], 'at night');
  t.deepEqual(wanting(at(PLOT, 9200, 0, { sleeping: true })), []);
  // with no yard round home (none known, or home moved out of it): each round's own reach, as ever
  const noYard = liveDay();
  delete noYard.yard;
  const reach = (s: Snapshot) => FIVE.filter(n => round(goals, n).wants(s, noYard));
  t.deepEqual(reach(at({ x: -541, y: 63, z: 2183 })), FIVE, '8 out');
  t.deepEqual(reach(at({ x: -538, y: 63, z: 2183 })), ['tidy', 'signs'], '11 out');
  t.deepEqual(reach(at(PLOT)), ['signs'], '22 out');
  t.deepEqual(reach(at({ x: -528, y: 63, z: 2183 })), ['signs'], '21 out, where the fence would be');
  const moved = liveDay();
  moved.yard = { x1: -600, z1: 2000, x2: -580, z2: 2020, y: 62 };
  t.deepEqual(FIVE.filter(n => round(goals, n).wants(at(PLOT), moved)), ['signs']);
  t.false(roundFrom(at({ ...HOME, y: 54 }), world, 10), '9 under home, in the yard: not on its level');
});

test('a round not due does not want, in the yard or at home; due again only by its own cadence', (t) => {
  const goals = realGoals();
  for (const n of FIVE) {
    const every = n === 'sort' ? 30 : 20;
    const world = liveDay();
    world.lastDone![n] = T0 - (every - 1) * MINUTE;
    for (const p of [HOME, PLOT]) t.is(round(goals, n).wants(at(p, 9200), world), null, `${n} at ${p.z}, ${every - 1} min since`);
    // its time up, in the evening: it wants from the plot as from home
    world.lastDone![n] = T0 - (every + 1) * MINUTE;
    for (const p of [HOME, PLOT]) t.truthy(round(goals, n).wants(at(p, 9200), world), `${n} at ${p.z}, ${every + 1} min since`);
    // its time up, in the morning with a trip that could go and not yet twice its time: the trip's, from the plot too
    t.is(round(goals, n).wants(at(PLOT, 1000), world), null, `${n} in the morning`);
  }
});

test('from out in the yard a round stops no running goal: it takes over when that one ends; within its old reach it cuts in as ever', (t) => {
  const world = liveDay();
  const goals = realGoals();
  const p = (g: Goal, s: Snapshot) => g.urgency?.(s, world) ?? g.priority;
  for (const n of FIVE) {
    const g = round(goals, n);
    // (the plot is within the signs' old 24: from there they cut in as ever)
    t.is(g.cuts!(at(PLOT), world), n === 'signs', `${n} at the plot`);
    t.false(g.cuts!(at(FAR), world), `${n} at the yard's far end`);
    t.true(g.cuts!(at(HOME), world), `${n} at home`);
    t.is(g.cuts!(at({ x: -538, y: 63, z: 2183 }), world), REACH[n] >= 11, `${n} 11 out`);
  }
  // the tree round running at the far end of the yard (the brain's own filter: more urgent, and worth the stop): the
  // rounds due want there, and none of them stops it
  const trees = round(goals, 'trees');
  const there = at({ x: -541, y: 63, z: 2138 });
  t.true(FIVE.filter(n => round(goals, n).wants(there, world)).length > 0);
  const cutters = goals.filter(g => p(g, there) > p(trees, there) && (g.cuts?.(there, world) ?? true));
  t.false(cutters.some(g => FIVE.includes(g.name)));
  t.not(decide(there, world, cutters, new Map())?.goal.name, 'repair');
});

/** A bridge for a round's run: the walk home moves the bot (`arrives`: within 8 of home, else nowhere), anything else is the round's own work. */
function bridge(arrives: boolean, from: Pos = FAR) {
  const calls: { m: string; p: Record<string, unknown> }[] = [];
  let pos: Pos = { ...from };
  const ctx = (world: WorldMemory, s = at(from)): GoalContext => ({
    s, world, signal: new AbortController().signal,
    act: async (tool: string) => { calls.push({ m: `act ${tool}`, p: {} }); throw new Error('the round\'s own work'); },
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      calls.push({ m, p });
      if (m === 'goto' && p.range === ROUND_WALK) { if (arrives) pos = { x: -548, y: 63, z: 2176 }; return { arrived: arrives }; }
      if (m === 'inventory') return { items: KIT };
      throw new Error('the round\'s own work');
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...pos }, dimension: 'overworld', timeOfDay: 9300 }),
    progress: () => undefined, gain: () => undefined
  } as unknown as GoalContext);
  return { calls, ctx, where: () => pos };
}

test('a round run from out in the yard walks home first, on foot, and goes on from there; a walk that stops short does nothing and writes nothing', async (t) => {
  const goals = realGoals();
  for (const n of FIVE) {
    // from the yard's far end: the careful walk first, to within 8 of the home cell, then the round's own work from there
    const ok = bridge(true);
    const world = liveDay();
    await t.throwsAsync(round(goals, n).run(ok.ctx(world)), { message: /own work/ }, n);
    t.like(ok.calls[0], { m: 'goto', p: { x: HOME.x, y: HOME.y, z: HOME.z, range: ROUND_WALK, careful: true } }, n);
    t.true(ok.calls.slice(1).every(c => !(c.m === 'goto' && c.p.range === ROUND_WALK)), `${n}: one walk home`);
    // stopped short: no work, no mark (it is due as before, and tried again after its wait)
    const short = bridge(false);
    const left = liveDay();
    const before = left.lastDone![n];
    await t.throwsAsync(round(goals, n).run(short.ctx(left)), { message: `the walk home from 48 blocks out stopped 48 out (the round works within ${REACH[n]} of home)` }, n);
    t.deepEqual(short.calls.map(c => c.m), ['goto', 'inventory'], n);
    t.is(left.lastDone![n], before, n);
    // within its old reach: no walk, the round's work at once (as ever)
    const near = bridge(true, { x: -541, y: 63, z: 2183 });
    await t.throwsAsync(round(goals, n).run(near.ctx(liveDay(), at({ x: -541, y: 63, z: 2183 }))), { message: /own work/ }, n);
    t.false(near.calls.some(c => c.m === 'goto' && c.p.range === ROUND_WALK), n);
  }
});

test('toRound: the bot as it is after the walk (place, distance, pockets, hour), and the run\'s own look when no walk was needed', async (t) => {
  const b = bridge(true);
  const ctx = b.ctx(liveDay(), at(FAR, 9200, 0, { items: [], counts: new Map(), slotsUsed: 0 }));
  const s = await toRound(ctx, 10);
  t.deepEqual(s.position, { x: -548, y: 63, z: 2176 });
  t.true(s.distHome <= ROUND_WALK && s.distHome === Math.hypot(1, 7));
  t.is(s.slotsUsed, KEPT.length);
  t.is(s.timeOfDay, 9300);
  t.is(s.now, T0, 'the run\'s clock');
  const home = at(HOME);
  t.is(await toRound(b.ctx(liveDay(), home), 10), home);
  // stopped by the brain on the way: no look, no work
  const ab = new AbortController();
  ab.abort();
  await t.throwsAsync(toRound({ ...bridge(true).ctx(liveDay()), signal: ab.signal }, 10), { message: 'aborted' });
});
