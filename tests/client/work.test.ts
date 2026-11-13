import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Brain, decide } from '../../src/client/brain/brain.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import type { Decline, Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import { explainIdle, idleOf } from '../../src/client/brain/idlelog.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import { out } from '../../src/client/brain/pockets.js';
import { kit as kitGoal, stashKeep, stashList } from '../../src/client/brain/chores.js';
import { setMineLookMs } from '../../src/client/brain/deep.js';
import { LADDER, SURFACE_STOCK, WORK_STOCK, deepShort, tierStep } from '../../src/client/brain/worktasks.js';
import {
  DRY_WAIT, EVENING_AT, MIN_WORK, PROBATION, TRIP_URGENCY, alongSide, deepHold, dryBlocked, dryUntil, markDry, needMs, outByGate, pick, releaseOldestDry, roundDue,
  shareHolds, skippedLine, workGoals, workLine, workOf, workTick, type Death, type WorkMemory, type WorkTask
} from '../../src/client/brain/work.js';

/**
 * The work queue with stub tasks: what the ladder does whatever its rungs are. The runs change two flags the whole
 * process shares (pockets.ts `out`), so every test that runs a task is serial; the ones that only ask are not.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const settle = () => new Promise(r => setTimeout(r, 20));

/** 14:00:00 UTC: the "until" times below read from here. */
const T0 = Date.UTC(2026, 10, 10, 14, 0, 0);
const HOME = { x: 0, y: 64, z: 0 };
type Pos = { x: number; y: number; z: number };

/** A look by day, at home, hale, with empty pockets. */
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: T0, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { ...HOME }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 0,
  home: { ...HOME, dimension: 'overworld' }, distHome: 0, ...over
});
const emptyWorld = (over: Partial<WorldMemory> = {}): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96, ...over });

/** What a look says of these pockets. */
const carrying = (items: InventoryItem[]): Pick<Snapshot, 'items' | 'counts' | 'slotsUsed'> => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return { items, counts, slotsUsed: items.filter(i => i.slot < 36).length };
};
/** The whole kit of a deep trip: iron on every armour slot, food, torches, blocks, and a pickaxe. */
const KIT: InventoryItem[] = [
  { slot: 0, name: 'iron_pickaxe', count: 1 }, { slot: 1, name: 'bread', count: 10 }, { slot: 2, name: 'torch', count: 16 }, { slot: 3, name: 'cobblestone', count: 32 },
  { slot: 36, name: 'iron_boots', count: 1 }, { slot: 37, name: 'iron_leggings', count: 1 }, { slot: 38, name: 'iron_chestplate', count: 1 }, { slot: 39, name: 'iron_helmet', count: 1 }
];
/** What the kit check says of empty pockets. */
const NO_KIT = 'ready food 0 < 20 points; armour below iron; 0 torches < 16; 0 blocks < 32';

/**
 * A task that does what the test tells it: `list` its variants (id, blocks from home), `off` the ones not ready and
 * why, `gains` what the next runs bring in (nothing once it is used up), `body` what a run does before it ends.
 */
interface Stub extends WorkTask {
  list: [string, number][];
  off: Record<string, Decline>;
  gains: number[];
  ran: { variant: string; budgetMs: number }[];
  body?: (ctx: GoalContext, variant: string) => Promise<void>;
}
const ROOMS = { yard: 'yard', near: 'trip', far: 'trip', deep: 'deep' } as const;
function stub(name: string, rank: number, reach: WorkTask['reach'], list?: [string, number][], over: Partial<WorkTask> = {}): Stub {
  const t: Stub = {
    name, rank, reach, room: ROOMS[reach], budgetMs: 2 * MINUTE,
    list: list ?? [['only', reach === 'yard' || reach === 'deep' ? 0 : 20]], off: {}, gains: [], ran: [],
    variants: () => t.list.map(([id, dist]) => ({ id, dist })),
    ready: (_s, _world, variant) => t.off[variant] ?? null,
    run: async (ctx, variant, budgetMs) => {
      t.ran.push({ variant, budgetMs });
      await t.body?.(ctx, variant);
      const gain = t.gains.shift() ?? 0;
      return gain > 0 ? { gain, text: `+${gain} things` } : { gain: 0, text: 'nothing found' };
    },
    ...over
  };
  return t;
}

/** A goal's context made by hand: the bot stands at `pos` when the task ends, and `go-home` takes it home (or fails as `walk` says). */
function direct(s: Snapshot, world: WorldMemory, pos: Pos = HOME) {
  const ac = new AbortController();
  const d = { pos: { ...pos }, acts: [] as string[], gain: 0, walk: { ok: true, text: 'Home' }, abort: () => ac.abort(), ctx: undefined as unknown as GoalContext };
  d.ctx = {
    s, world, signal: ac.signal,
    act: async (tool) => {
      d.acts.push(tool);
      if (tool !== 'go-home') return { ok: true, text: 'ok' };
      if (d.walk.ok) d.pos = { ...HOME };
      return d.walk;
    },
    call: (async () => ({})) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: d.pos, dimension: 'overworld' }),
    progress: () => undefined,
    gain: (n) => { d.gain += n; }
  };
  return d;
}

/** The ladder's goals over a clock the test moves, and one run of a rung as the brain would make it (a fresh look at `at.now`). */
function bench(tasks: WorkTask[], death: () => Death | undefined = () => undefined) {
  const at = { now: T0 };
  const goals = workGoals(death, tasks, () => at.now);
  const goal = (task: WorkTask) => goals.find(g => g.name === `work: ${task.name}`)!;
  const look = (over: Partial<Snapshot> = {}) => snap({ now: at.now, ...over });
  const run = async (task: WorkTask, world: WorldMemory, over: Partial<Snapshot> = {}, pos: Pos = HOME) => {
    const d = direct(look(over), world, pos);
    return { text: await goal(task).run(d.ctx), d };
  };
  return { at, goals, goal, look, run };
}

/** Frozen all the way down: a write anywhere in it throws (the test files are modules, so strict). */
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

// ---- asking: the gates, which only read ----

test('the day ends for each reach where the walk there and back and the least work no longer fit', (t) => {
  t.is(needMs(96, 'far'), 124_000);
  t.is(needMs(30, 'near'), 40_000);
  t.is(needMs(0, 'yard'), MIN_WORK.yard);
  const world = emptyWorld();
  const far = stub('far', 5, 'far', [['edge', 96]]);
  const near = stub('near', 6, 'near', [['copse', 30]]);
  const yard = stub('yard', 7, 'yard');
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const b = bench([far, near, yard, deep]);
  const at = (timeOfDay: number) => snap({ timeOfDay });

  // a far task at the leash: 64 s of walking and a minute's work
  t.is(b.goal(far).wants(at(8520), world), 'edge: 96 blocks out');
  t.deepEqual(b.goal(far).declines!(at(8521), world), { cause: 'late', text: '2.1 min of daylight left (far needs 2.1)' });
  // a near task 30 blocks out
  t.is(b.goal(near).wants(at(10_200), world), 'copse: 30 blocks out');
  t.deepEqual(b.goal(near).declines!(at(10_201), world), { cause: 'late', text: '0.7 min of daylight left (near needs 0.7)' });
  // a yard task: its least work alone
  t.is(b.goal(yard).wants(at(10_700), world), 'only: in the yard');
  t.deepEqual(b.goal(yard).declines!(at(10_701), world), { cause: 'late', text: '0.2 min of daylight left (yard needs 0.3)' });
  // a deep trip: three minutes of mining before the two-minute walk back up
  t.is(b.goal(deep).wants(at(5000), world), 'iron: under ground');
  t.deepEqual(b.goal(deep).declines!(at(5001), world), { cause: 'late', text: 'deep needs 3 min, 2.9 left' });
  t.deepEqual(b.goal(deep).declines!(at(6000), world), { cause: 'late', text: 'deep needs 3 min, 2.1 left' });
});

test('late is booked only by a rung that is otherwise ready', (t) => {
  const far = stub('far', 5, 'far', [['edge', 96]]);
  const b = bench([far]);
  const late = snap({ timeOfDay: 9000 });
  t.is(b.goal(far).declines!(late, emptyWorld())?.cause, 'late');

  // not ready: its own reason, not the hour
  far.off.edge = { cause: 'stocked', text: 'enough of it' };
  t.deepEqual(b.goal(far).declines!(snap({ timeOfDay: 9000 }), emptyWorld()), { cause: 'stocked', text: 'enough of it' });
  far.off = {};
  // dry: the mark, not the hour
  const dry = emptyWorld();
  markDry(dry, 'far:edge', T0);
  t.deepEqual(b.goal(far).declines!(snap({ timeOfDay: 9000 }), dry), { cause: 'dry', text: 'far [edge] until 14:20', until: T0 + 20 * MINUTE });
  // nothing to do at all
  far.list = [];
  t.deepEqual(b.goal(far).declines!(snap({ timeOfDay: 9000 }), emptyWorld()), { cause: 'unneeded', text: 'far: nothing to do' });
  far.list = [['edge', 96]];
  // hurt: the health, not the hour
  t.is(b.goal(far).declines!(snap({ timeOfDay: 9000, health: 8 }), emptyWorld())?.cause, 'health');

  // the hours of rest are late for every rung, whatever else is so
  t.deepEqual(b.goal(far).declines!(snap({ sleeping: true }), emptyWorld()), { cause: 'late', text: 'asleep' });
  t.deepEqual(b.goal(far).declines!(snap({ timeOfDay: 11_500, activity: 'return' }), emptyWorld()), { cause: 'late', text: 'not work time (return)' });

  // two places: too late for the far one is not too late for the near one, and with both too late the nearer one says so
  far.list = [['edge', 96], ['close', 20]];
  t.is(b.goal(far).wants(snap({ timeOfDay: 8521 }), emptyWorld()), 'close: 20 blocks out');
  t.deepEqual(b.goal(far).declines!(snap({ timeOfDay: 10_000 }), emptyWorld()), { cause: 'late', text: '0.8 min of daylight left (far needs 1.2)' });
});

test('a trip down sets out in the morning or not at all: after that the hour is the deep rung\'s reason rather than a hold or full pockets, not rather than the kit or the ore', (t) => {
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const b = bench([deep]);
  const goal = b.goal(deep);
  // on probation, two trips this hour: in the morning that is what holds it; from tod 5001 no trip could go down
  // anyway (the seven-day replay booked whole held afternoons to `hold`)
  const held = emptyWorld({ work: { dry: {}, next: {}, sites: {}, pen: {}, tier: 0, deep: { starts: [T0 - 2 * MINUTE, T0 - MINUTE], clean: 1, deaths: [] } } });
  t.is(goal.declines!(snap({ timeOfDay: 5000 }), held)?.cause, 'hold');
  t.deepEqual(goal.declines!(snap({ timeOfDay: 5001 }), held), { cause: 'late', text: 'deep needs 3 min, 2.9 left' });
  // full pockets and no chest to put anything in: the same (the grid's evenings with nothing loose said `pockets`)
  const full = snap({ ...carrying(Array.from({ length: 36 }, (_, slot) => ({ slot, name: 'cooked_beef', count: 8 }))) });
  t.is(goal.declines!({ ...full, timeOfDay: 3000 }, emptyWorld())?.cause, 'pockets');
  t.deepEqual(goal.declines!({ ...full, timeOfDay: 9000 }, emptyWorld()), { cause: 'late', text: 'deep needs 3 min, 0.0 left' });
  // but the hour is said only by a rung otherwise ready: the kit short, or every ore dry, is what kept the morning's
  // trip at home, and the afternoon is booked to it (a dry mark can be let go early then, an hour cannot)
  const kit: Decline = { cause: 'kit', text: '0/16 torches (deep needs the deep kit)' };
  deep.off.iron = kit;
  t.deepEqual(goal.declines!(snap({ timeOfDay: 6000 }), held), kit);
  t.is(goal.declines!(snap({ timeOfDay: 3000 }), held)?.cause, 'hold', 'in the morning the hold comes first, as for every trip');
  deep.off = {};
  const dry = emptyWorld();
  markDry(dry, 'deep:iron', T0 - MINUTE);
  t.deepEqual(goal.declines!(snap({ timeOfDay: 6000 }), dry), { cause: 'dry', text: 'deep [iron] until 14:19', until: T0 + 19 * MINUTE });
  // nothing to go for is said first at any hour, and away and health before the hour
  deep.list = [];
  t.deepEqual(goal.declines!(snap({ timeOfDay: 9000 }), emptyWorld()), { cause: 'unneeded', text: 'deep: nothing to do' });
  deep.list = [['iron', 0]];
  t.is(goal.declines!(snap({ timeOfDay: 9000, health: 8 }), emptyWorld())?.cause, 'health');
  t.is(goal.declines!(snap({ timeOfDay: 9000, distHome: 60, position: { x: 60, y: 64, z: 0 } }), emptyWorld())?.cause, 'away');
});

test('every rung sets out from home, hale: away and health are said before anything else', (t) => {
  const yard = stub('yard', 7, 'yard');
  const b = bench([yard]);
  t.deepEqual(b.goal(yard).declines!(snap({ distHome: 60, position: { x: 60, y: 64, z: 0 } }), emptyWorld()),
    { cause: 'away', text: '60 blocks from home (yard works within 40)' });
  t.deepEqual(b.goal(yard).declines!(snap({ home: undefined, distHome: Infinity }), emptyWorld()), { cause: 'away', text: 'no home set' });
  t.deepEqual(b.goal(yard).declines!(snap({ health: 11 }), emptyWorld()), { cause: 'health', text: 'health 11, food 20 (yard needs 12 and 10)' });
  t.deepEqual(b.goal(yard).declines!(snap({ food: 9 }), emptyWorld()), { cause: 'health', text: 'health 20, food 9 (yard needs 12 and 10)' });
  t.is(b.goal(yard).wants(snap({ distHome: 40 }), emptyWorld()), 'only: in the yard');
});

test('workOf on a brain.json with no work, or a malformed one: the memory is made whole and the queue goes on', (t) => {
  const empty: WorkMemory = { dry: {}, next: {}, sites: {}, pen: {}, tier: 0, deep: { starts: [], clean: 0, deaths: [] } };
  const none = emptyWorld();
  const made = workOf(none);
  t.deepEqual(made, empty);
  t.is(workOf(none), made, 'the same object from then on: what the wrapper writes is what is saved');
  t.is(none.work, made);

  for (const junk of ['x', [], null, 7, true, { dry: 'no', next: [1], sites: 3, pen: null, tier: 'two', deep: 'down' }]) {
    const world = emptyWorld({ work: junk as unknown as WorkMemory });
    t.deepEqual(workOf(world), empty, JSON.stringify(junk));
  }

  // what is sound in a half-sound memory is kept, the rest dropped
  const world = emptyWorld({
    work: {
      dry: { 'cane:south': { n: 2.7, at: T0, early: true, freed: 'yes' }, 'cane:north': { n: 0, at: T0 }, 'cows:east': { n: 1 }, 'deep:iron': 'dry', 'fish:pond': { n: 1, at: T0, freed: true } },
      next: { cane: 1.9, cows: -1, deep: 'x' },
      sites: { cane: [{ x: 1, y: 64, z: 2, dryAt: T0 }, { x: 'a', y: 1, z: 1 }, 'here', { x: 3, y: 64, z: 4 }, { x: 5, y: 64, z: 6 }, { x: 7, y: 64, z: 8 }, { x: 9, y: 64, z: 10 }], cows: 'none' },
      pen: { cow: { adults: 2, babies: 1, at: T0 }, pig: { adults: 'two' } },
      tier: 2.5,
      deep: { starts: [T0, 'then', T0 + 1, null], clean: -3, deaths: 'none', kitHold: 'x' },
      farDay: { day: 3, unblockers: 1 },
      last: { task: 'cane', variant: 'south', gain: 3, text: 7, at: T0 },
      land: 12
    } as unknown as WorkMemory
  });
  t.deepEqual(workOf(world), {
    dry: { 'cane:south': { n: 2, at: T0, early: true }, 'fish:pond': { n: 1, at: T0, freed: true } },
    next: { cane: 1 },
    sites: { cane: [{ x: 1, y: 64, z: 2, dryAt: T0 }, { x: 3, y: 64, z: 4 }, { x: 5, y: 64, z: 6 }, { x: 7, y: 64, z: 8 }] },
    pen: { cow: { adults: 2, babies: 1, at: T0 } },
    tier: 2,
    deep: { starts: [T0, T0 + 1], clean: 0, deaths: [] }
  });

  // and what the queue wrote comes back from the file as it was
  const kept: WorkMemory = {
    dry: { 'cane:south': { n: 3, at: T0 }, 'cows:east': { n: 1, at: T0, freed: true } }, next: { cane: 1 }, sites: { cane: [{ x: 1, y: 64, z: 2 }] },
    pen: { cow: { adults: 2, babies: 0, at: T0 } }, tier: 1, deep: { starts: [T0], clean: 2, deaths: [T0 - HOUR], kitHold: T0 },
    farDay: { day: 4, unblockers: 1, deep: 2 }, last: { task: 'cane', variant: 'south', gain: 0, text: 'nothing found', at: T0 }, land: '0,0,96'
  };
  const back = emptyWorld({ work: JSON.parse(JSON.stringify(kept)) as WorkMemory });
  t.deepEqual(workOf(back), kept);

  // a gate asked over a malformed memory answers as over an empty one, and leaves it as it found it
  const cane = stub('cane', 5, 'near', [['south', 20]]);
  const bad = emptyWorld({ work: 'garbage' as unknown as WorkMemory });
  t.is(bench([cane]).goal(cane).wants(snap(), bad), 'south: 20 blocks out');
  t.is(dryUntil(bad, 'cane:south', [cane]), 0);
  t.is(bad.work as unknown, 'garbage');
});

test('roundDue: a home round is due after its time, and then only when it costs no trip: in the evening, or after twice its time, or with no trip ready', (t) => {
  const far = stub('cows', 2, 'far', [['east', 50]]);
  const yard = stub('yard', 7, 'yard');
  const every = 30 * MINUTE;
  const ran = (ago: number) => emptyWorld({ lastDone: { lights: T0 - ago } });
  const at = (timeOfDay: number) => snap({ timeOfDay, activity: activityAt(timeOfDay, false) });

  // not yet its time: never, whatever the hour
  t.false(roundDue(at(6000), ran(every), 'lights', every, [far]));
  t.false(roundDue(at(9000), ran(29 * MINUTE), 'lights', every, [far]));
  t.false(roundDue(at(6000), ran(29 * MINUTE), 'lights', every, []));
  // its time, by day, with a trip ready: the trip first
  t.false(roundDue(at(6000), ran(31 * MINUTE), 'lights', every, [far]));
  t.false(roundDue(at(EVENING_AT - 1), ran(31 * MINUTE), 'lights', every, [far]));
  // the evening: due whatever else could run
  t.true(roundDue(at(EVENING_AT), ran(31 * MINUTE), 'lights', every, [far]));
  t.true(roundDue(at(11_500), ran(31 * MINUTE), 'lights', every, [far]));
  // the half hour before sunrise is the morning's: the trips come first again
  t.false(roundDue(at(23_600), ran(31 * MINUTE), 'lights', every, [far]));
  // waited twice its time: due at any hour
  t.false(roundDue(at(6000), ran(2 * every), 'lights', every, [far]));
  t.true(roundDue(at(6000), ran(2 * every + 1), 'lights', every, [far]));
  // never run: due
  t.true(roundDue(at(6000), emptyWorld(), 'lights', every, [far]));

  // no trip ready: due as soon as its time is up. Only a yard task on the ladder; none at all; the trip dry; not ready
  t.true(roundDue(at(6000), ran(31 * MINUTE), 'lights', every, [yard]));
  t.true(roundDue(at(6000), ran(31 * MINUTE), 'lights', every, []));
  // the ladder as it stands: coal from the surface could go (the home has none), so the morning is the trip's
  t.false(roundDue(at(6000), ran(31 * MINUTE), 'lights', every), 'the real ladder: a trip for coal is ready');
  const dry = ran(31 * MINUTE);
  markDry(dry, 'cows:east', T0 - MINUTE);
  t.true(roundDue(at(6000), dry, 'lights', every, [far]));
  far.off.east = { cause: 'stocked', text: 'cows enough' };
  t.true(roundDue(at(6000), ran(31 * MINUTE), 'lights', every, [far]));
  far.off = {};
  // a deep trip counts as a trip, while the day is long enough for one
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  t.false(roundDue(at(4000), ran(31 * MINUTE), 'lights', every, [deep]));
  t.true(roundDue(at(6000), ran(31 * MINUTE), 'lights', every, [deep]));
});

test('roundDue: a trip the brain holds back is no trip that could go', (t) => {
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const far = stub('surface', 6, 'far', [['coal', 96]]);
  const every = 20 * MINUTE;
  const world = emptyWorld({ lastDone: { lights: T0 - 21 * MINUTE } });
  const s = snap({ timeOfDay: 2000 });
  t.false(roundDue(s, world, 'lights', every, [deep]), 'the deep trip could go: the morning is its');
  // the brain holds it (it failed: someone's build by every side of the yard, say): the round is due
  const holds = new Map([['work: deep', T0 + 5 * MINUTE]]);
  shareHolds(world, holds);
  t.true(roundDue(s, world, 'lights', every, [deep]));
  t.false(roundDue({ ...s, now: T0 + 5 * MINUTE }, world, 'lights', every, [deep]), 'a hold run out holds nothing');
  // another trip that could go keeps the round for later; held as well, the round is due
  t.false(roundDue(s, world, 'lights', every, [deep, far]));
  holds.set('work: surface', T0 + 10 * MINUTE);
  t.true(roundDue(s, world, 'lights', every, [deep, far]));
  // the holds are this world's: another's are not
  t.false(roundDue(s, emptyWorld({ lastDone: { lights: T0 - 21 * MINUTE } }), 'lights', every, [deep]));
});

test('the skipped line: why each rung above the one that starts did not run instead', (t) => {
  const kit = stub('trip kit', 1, 'yard', [], { none: () => ({ cause: 'unneeded', text: 'kit ready' }) });
  const cows = stub('cows', 2, 'far', [['north', 50]]);
  const cane = stub('cane', 3, 'far', [['south', 40]]);
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const fish = stub('fish', 9, 'yard');
  const b = bench([kit, cows, cane, deep, fish]);
  const other: Goal = { name: 'smelt', priority: 66, wants: () => 'ore', run: async () => 'smelted', timeoutMs: 1000, retryMs: 1000 };
  const goals = [other, ...b.goals];
  const world = emptyWorld();
  workOf(world).dry['cows:north'] = { n: 3, at: T0 - 10 * MINUTE };
  const held = (name: string, words: string) => (g: Goal) => (g.name === name ? words : undefined);
  const none = () => undefined;

  t.is(skippedLine(b.goal(deep), snap(), world, goals, held('work: cane', 'held until 14:05 (failed: boom)')),
    'work: deep: skipped: trip kit (unneeded: kit ready) | cows (dry: north until 15:10) | cane (hold: held until 14:05 (failed: boom))');
  // a rung above that wanted and was not held: passed over (the brain chose by urgency, and says what the rung asked)
  t.is(skippedLine(b.goal(deep), snap(), world, goals, none),
    'work: deep: skipped: trip kit (unneeded: kit ready) | cows (dry: north until 15:10) | cane (passed over: south: 40 blocks out)');
  // demoted below the deep trip: said as that
  workOf(world).farDay = { day: 0, unblockers: 1, deep: 0 };
  t.is(skippedLine(b.goal(deep), snap(), world, goals, none),
    'work: deep: skipped: trip kit (unneeded: kit ready) | cows (dry: north until 15:10) | cane (demoted: south: 40 blocks out (one such trip today already: the deep trip first))');
  // a decline that names its own task is not said twice
  delete kit.none;
  t.is(skippedLine(b.goal(cows), snap(), world, goals, none), 'work: cows: skipped: trip kit (unneeded: nothing to do)');

  // the top rung has nobody above it; a goal off the ladder has no line
  t.is(skippedLine(b.goal(kit), snap(), world, goals, none), undefined);
  t.is(skippedLine(other, snap(), world, goals, none), undefined);

  // a long ladder's line is cut at 300 characters
  const many = Array.from({ length: 12 }, (_, i) => stub(`rung number ${i + 1}`, i + 1, 'yard', [], { none: () => ({ cause: 'unneeded', text: 'nothing to do here for now' }) }));
  const last = stub('last', 13, 'yard');
  const long = bench([...many, last]);
  const line = skippedLine(long.goal(last), snap(), emptyWorld(), long.goals, none)!;
  t.is(line.length, 300);
  t.true(line.startsWith('work: last: skipped: rung number 1 (unneeded: nothing to do here for now) | rung number 2 ('));
  t.true(line.endsWith('...'));
});

test('the Work queue line: the last run, the tier, the deep trips and the probation, the marks still waiting', (t) => {
  const cows = stub('cows', 2, 'far', [['east', 50]]);
  const cane = stub('cane', 3, 'far', [['north', 40]]);
  const scout = stub('scout', 6, 'far', [['a', 50]], { terrain: true });
  const tasks = [cows, cane, scout];
  const world = emptyWorld();
  t.is(workLine(world, T0, tasks), 'Work queue: no run yet; tier 0; deep trips 0 in 24 h, on probation 0/3.');
  t.is(world.work, undefined, 'a look only: nothing made');

  const w = workOf(world);
  w.last = { task: 'deep', variant: 'iron', gain: 23, text: '+23 raw_iron.', at: T0 - 6 * MINUTE };
  w.deep = { starts: [T0 - 25 * HOUR, ...Array.from({ length: 7 }, (_, i) => T0 - (i + 1) * HOUR)], clean: 1, deaths: [] };
  w.dry = { 'cane:north': { n: 2, at: T0 }, 'cows:east': { n: 1, at: T0 }, 'cane:gone': { n: 1, at: T0 - 21 * MINUTE }, 'cane:early': { n: 3, at: T0, early: true } };
  t.is(workLine(world, T0, tasks),
    'Work queue: last deep [iron] +23 raw_iron 6 min ago; tier 0; deep trips 7 in 24 h, on probation 1/3; dry: cows:east 20 min, cane:north 40 min.');

  // the probation over: not said; a tier reached: said; minutes left are rounded up, a terrain mark's wait is its own
  w.deep.clean = PROBATION.clean;
  w.tier = 2;
  w.dry = { 'scout:a': { n: 6, at: T0 }, 'cane:north': { n: 6, at: T0 } };
  t.is(workLine(world, T0 + 30_001, tasks),
    'Work queue: last deep [iron] +23 raw_iron 7 min ago; tier 2; deep trips 7 in 24 h; dry: cane:north 160 min, scout:a 640 min.');

  // more than six marks: the six that lift first, and how many more
  w.dry = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`cane:v${i}`, { n: 1, at: T0 - i * MINUTE }]));
  t.is(workLine(world, T0, tasks),
    'Work queue: last deep [iron] +23 raw_iron 6 min ago; tier 2; deep trips 7 in 24 h; dry: cane:v7 13 min, cane:v6 14 min, cane:v5 15 min, cane:v4 16 min, cane:v3 17 min, cane:v2 18 min, 2 more.');
});

test('explainIdle lists the ladder: its rungs first within a cause, the top rung first, each with its one reason', (t) => {
  const kit = stub('trip kit', 1, 'yard', [], { none: () => ({ cause: 'unneeded', text: 'kit ready' }) });
  const cows = stub('cows', 2, 'far', [['north', 50]]);
  const cane = stub('cane', 3, 'far', [['south', 40]]);
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const fish = stub('fish', 9, 'yard', []);
  const b = bench([kit, cows, cane, deep, fish]);
  const idler = (name: string, d: Decline): Goal => ({ name, priority: 30, wants: () => null, declines: () => d, run: async () => name, timeoutMs: 1000, retryMs: 1000 });
  // the brain's list has the homestead's goals before the ladder, and the ladder in no order that matters
  const goals = [idler('smelt', { cause: 'stocked', text: 'enough iron' }), idler('lights', { cause: 'unneeded', text: 'lights is not due' }), ...[...b.goals].reverse()];
  const world = emptyWorld();
  workOf(world).dry['cows:north'] = { n: 3, at: T0 - 10 * MINUTE };
  cane.off.south = { cause: 'stocked', text: '64 sugar cane' };

  t.deepEqual(explainIdle(snap({ timeOfDay: 6000 }), world, goals, new Map(), new Map()), [
    { cause: 'late', text: 'deep needs 3 min, 2.1 left' },
    { cause: 'dry', text: 'cows [north] until 15:10', until: T0 + 70 * MINUTE },
    { cause: 'stocked', text: '64 sugar cane' },
    { cause: 'stocked', text: 'enough iron' },
    { cause: 'unneeded', text: 'kit ready' },
    { cause: 'unneeded', text: 'fish: nothing to do' },
    { cause: 'unneeded', text: 'lights is not due' }
  ]);

  // a rung that wants but is kept back by the brain is listed as held, with why and until when
  cane.off = {};
  const held = explainIdle(snap({ timeOfDay: 6000 }), world, goals, new Map([['work: cane', T0 + 5 * MINUTE]]), new Map([['work: cane', 'failed: boom']]));
  t.deepEqual(held[0], { cause: 'hold', text: 'work: cane held until 14:05 (failed: boom)', until: T0 + 5 * MINUTE });
  // and one that is held but would not run anyway says its own reason
  const both = explainIdle(snap({ timeOfDay: 6000 }), world, goals, new Map([['work: cows', T0 + 5 * MINUTE]]), new Map([['work: cows', 'failed: boom']]));
  t.false(both.some(d => d.cause === 'hold'));
  t.true(both.some(d => d.text === 'cows [north] until 15:10'));
});

test('the Blocked lines: a rung that waits on dry marks alone says which and until when', (t) => {
  const cows = stub('cows', 2, 'far', [['north', 50], ['east', 60]]);
  const cane = stub('cane', 3, 'far', [['south', 40]]);
  const fish = stub('fish', 9, 'yard', []);
  const world = emptyWorld();
  markDry(world, 'cows:north', T0 - 5 * MINUTE);
  markDry(world, 'cows:east', T0);
  t.deepEqual(dryBlocked(snap(), world, [cows, cane, fish]), ['work: cows - dry north until 14:15 (2 dry)']);
  markDry(world, 'cane:south', T0);
  t.deepEqual(dryBlocked(snap(), world, [cows, cane, fish]), ['work: cows - dry north until 14:15 (2 dry)', 'work: cane - dry south until 14:20']);
  // a rung with one place still to try is not blocked
  cows.list.push(['west', 70]);
  t.deepEqual(dryBlocked(snap(), world, [cows, cane, fish]), ['work: cane - dry south until 14:20']);
});

test('pick writes nothing: asked over a grid of hours, pockets, places and health, the world is left as it was', (t) => {
  const kit = stub('trip kit', 1, 'yard', [], { none: () => ({ cause: 'unneeded', text: 'kit ready' }) });
  const cows = stub('cows', 2, 'far', [['north', 50], ['east', 60]]);
  const cane = stub('cane', 3, 'far', [['south', 40]]);
  const deep = stub('deep', 4, 'deep', [['iron', 0], ['coal', 0]]);
  const scout = stub('scout', 6, 'far', [['a', 90]], { terrain: true });
  const fish = stub('fish', 9, 'yard');
  const tasks = [kit, cows, cane, deep, scout, fish];
  const b = bench(tasks);
  const other: Goal = { name: 'smelt', priority: 66, wants: () => null, declines: () => ({ cause: 'stocked', text: 'enough iron' }), run: async () => 'smelted', timeoutMs: 1000, retryMs: 1000 };
  const goals = [other, ...b.goals];

  const sound = emptyWorld({ lastDone: { lights: T0 - HOUR }, landmarks: { chests: [{ x: 1, y: 64, z: 0 }], farmland: [] } });
  const w = workOf(sound);
  w.dry = { 'cows:north': { n: 2, at: T0 - 5 * MINUTE }, 'cane:south': { n: 1, at: T0 - HOUR }, 'scout:a': { n: 5, at: T0 }, 'deep:iron': { n: 1, at: T0, early: true } };
  w.next = { cows: 1, deep: 3 };
  w.deep = { starts: [T0 - 30 * MINUTE, T0 - 10 * MINUTE], clean: 1, deaths: [T0 - 2 * HOUR], kitHold: T0 - 20 * MINUTE };
  w.farDay = { day: 0, unblockers: 1, deep: 0 };
  const worlds: Record<string, WorldMemory> = {
    'no work': emptyWorld(),
    'malformed': emptyWorld({ work: { dry: 'x', deep: 7, next: { cows: 'first' } } as unknown as WorkMemory }),
    'in use': sound
  };

  let wanted = 0;
  let declined = 0;
  for (const [name, world] of Object.entries(worlds)) {
    freeze(world);
    const before = JSON.stringify(world);
    for (const timeOfDay of [0, 1000, 5000, 5001, 8000, 8521, 10_200, 10_701, 11_000, 12_600, 18_000, 23_600]) {
      for (const used of [0, 26, 33, 34, 35, 36]) {
        for (const distHome of [0, 10, 40, 41, 96, 200]) {
          for (const health of [20, 11]) {
            const items = Array.from({ length: used }, (_, slot) => ({ slot, name: slot % 2 ? 'oak_log' : 'bread', count: 64 }));
            const s = snap({
              now: T0 + timeOfDay, timeOfDay, activity: activityAt(timeOfDay, false), sleeping: timeOfDay === 18_000, health,
              distHome, position: { x: distHome, y: 64, z: 0 }, ...carrying(used === 26 ? [...items, ...KIT.filter(i => i.slot >= 36)] : items)
            });
            for (const g of b.goals) {
              const want = g.wants(s, world);
              const decline = g.declines!(s, world);
              // one answer: it wants exactly when it does not say why not
              t.is(want === null, decline !== null, `${name}: ${g.name} at ${timeOfDay}, ${used}/36, ${distHome} out, health ${health}`);
              if (want) wanted++; else declined++;
              g.urgency!(s, world);
            }
            for (const task of tasks) {
              pick(task, s, world);
              for (const v of task.variants(s, world)) dryUntil(world, `${task.name}:${v.id}`, tasks);
            }
            roundDue(s, world, 'lights', 30 * MINUTE, tasks);
            deepHold(s, world);
            dryBlocked(s, world, tasks);
            workLine(world, s.now, tasks);
            for (const g of goals) skippedLine(g, s, world, goals, () => undefined);
            explainIdle(s, world, goals, new Map(), new Map());
            decide(s, world, goals, new Map());
          }
        }
      }
    }
    t.is(JSON.stringify(world), before, name);
  }
  // (the grid asks both ways: it is no proof of silence where every answer is the same)
  t.true(wanted > 500 && declined > 500, `${wanted} wants, ${declined} declines`);
});

test('a death away from home holds the far rungs until the kit is whole, at most an hour', (t) => {
  const cows = stub('cows', 2, 'far', [['east', 50]]);
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const near = stub('near', 6, 'near');
  const yard = stub('yard', 7, 'yard');
  const tasks = [cows, deep, near, yard];
  const b = bench(tasks);
  let death: Death | undefined;
  const tickOf = (world: WorldMemory) => (now: number, over: Partial<Snapshot> = {}) => workTick(snap({ now, ...over }), world, () => death, tasks, () => undefined);

  // died 80 blocks out, a minute ago: the trips wait
  const world = emptyWorld();
  const tick = tickOf(world);
  t.deepEqual(tick(T0), []);
  death = { at: { x: 80, z: 0 }, time: T0 + MINUTE };
  t.deepEqual(tick(T0 + 2 * MINUTE), ['work: died away from home: the trips wait for the kit, until 15:01 at the latest']);
  const held: Decline = { cause: 'kit', text: `after a death: ${NO_KIT}`, until: T0 + 61 * MINUTE };
  const at3 = () => snap({ now: T0 + 3 * MINUTE });
  t.deepEqual(b.goal(cows).declines!(at3(), world), held);
  t.deepEqual(b.goal(deep).declines!(at3(), world), held);
  // the yard and a short way out need no armour
  t.is(b.goal(yard).wants(at3(), world), 'only: in the yard');
  t.is(b.goal(near).wants(at3(), world), 'only: 20 blocks out');
  // what is still missing is said as it is made up
  const half = carrying(KIT.filter(i => i.name !== 'torch'));
  t.deepEqual(b.goal(cows).declines!(snap({ now: T0 + 3 * MINUTE, ...half }), world), { cause: 'kit', text: 'after a death: 0 torches < 16', until: T0 + 61 * MINUTE });
  // the same death is told once
  t.deepEqual(tick(T0 + 3 * MINUTE), []);
  t.is(workOf(world).deep.kitHold, T0 + MINUTE);
  // the kit whole again: the trips go on, and the hold is gone from the memory
  t.is(b.goal(cows).wants(snap({ now: T0 + 4 * MINUTE, ...carrying(KIT) }), world), 'east: 50 blocks out');
  t.deepEqual(tick(T0 + 4 * MINUTE, carrying(KIT)), ['work: the kit is whole again after the death: the trips go on']);
  t.is(workOf(world).deep.kitHold, undefined);
  t.is(b.goal(deep).wants(snap({ now: T0 + 5 * MINUTE }), world), 'iron: under ground');
  t.deepEqual(tick(T0 + 5 * MINUTE), []);

  // a kit that cannot be made whole: an hour, no longer
  death = { at: { x: 0, z: 100 }, time: T0 + 10 * MINUTE };
  t.deepEqual(tick(T0 + 11 * MINUTE), ['work: died away from home: the trips wait for the kit, until 15:10 at the latest']);
  t.deepEqual(tick(T0 + 69 * MINUTE), []);
  t.is(b.goal(cows).declines!(snap({ now: T0 + 70 * MINUTE - 1 }), world)?.cause, 'kit');
  t.is(b.goal(cows).wants(snap({ now: T0 + 70 * MINUTE }), world), 'east: 50 blocks out');
  t.deepEqual(tick(T0 + 70 * MINUTE), ['work: an hour since the death: the trips go on, kit whole or not']);
  t.is(workOf(world).deep.kitHold, undefined);

  // the look that first shows the death may still show what the bot carried as it died: the hold stands for that tick
  const carried = emptyWorld();
  death = { at: { x: 80, z: 0 }, time: T0 + 80 * MINUTE };
  t.is(tickOf(carried)(T0 + 80 * MINUTE, carrying(KIT)).length, 1);
  t.is(workOf(carried).deep.kitHold, T0 + 80 * MINUTE);

  // a death at home holds nothing: within 32 blocks of it, or with a yard anywhere in the yard and 8 blocks round it
  for (const [at, yarded, away] of [[{ x: 20, z: 20 }, false, false], [{ x: 30, z: 20 }, false, true], [{ x: 66, z: 0 }, true, false], [{ x: 70, z: 0 }, true, true], [undefined, false, true]] as const) {
    const w = emptyWorld(yarded ? { yard: { x1: -20, z1: -20, x2: 58, z2: 20, y: 64 } } : {});
    death = { ...(at ? { at } : {}), time: T0 + 2 * HOUR };
    t.is(tickOf(w)(T0 + 2 * HOUR + MINUTE).length, away ? 1 : 0, JSON.stringify({ at, yarded }));
    t.is(workOf(w).deep.kitHold, away ? T0 + 2 * HOUR : undefined);
  }
  // and one an hour old when it is first heard of is past holding for
  const old = emptyWorld();
  death = { at: { x: 80, z: 0 }, time: T0 + 2 * HOUR };
  t.deepEqual(tickOf(old)(T0 + 3 * HOUR), []);
  t.is(workOf(old).deep.kitHold, undefined);
});

test('the housekeeping: stamps a day old go, and the marks of rungs no longer on the ladder; the trips of the day start anew with the day; the tiers step up when the tasks say so', (t) => {
  const cows = stub('cows', 2, 'far', [['east', 50]]);
  const world = emptyWorld();
  const w = workOf(world);
  w.deep = { starts: [T0 - DAY - 1, T0 - DAY + 1, T0], clean: 2, deaths: [T0 - 2 * DAY, T0 - HOUR] };
  w.dry = { 'cows:east': { n: 1, at: T0 }, 'cows:gone': { n: 2, at: T0 }, 'gone:x': { n: 1, at: T0 } };
  w.next = { cows: 1, gone: 2 };
  w.farDay = { day: 0, unblockers: 1, deep: 0 };
  t.deepEqual(workTick(snap(), world, () => undefined, [cows], () => undefined), []);
  t.deepEqual(w.deep, { starts: [T0 - DAY + 1, T0], clean: 2, deaths: [T0 - HOUR] });
  t.deepEqual(w.dry, { 'cows:east': { n: 1, at: T0 }, 'cows:gone': { n: 2, at: T0 } });
  t.deepEqual(w.next, { cows: 1 });
  t.deepEqual(w.farDay, { day: 0, unblockers: 1, deep: 0 }, 'the same day: the count stands');

  // the tally's day number moves on in the morning: yesterday's trips no longer count
  idleOf(world).today.day = 1;
  t.deepEqual(workTick(snap(), world, () => undefined, [cows], () => undefined), []);
  t.false('farDay' in w);

  // every target met: one tier up a call, with what the tasks say of it; the rule is theirs and is asked with the tier as it stands
  const asked: number[] = [];
  const step = (_s: Snapshot, _world: WorldMemory, tier: number) => { asked.push(tier); return tier < 2 ? 'iron 64, coal 64' : undefined; };
  t.deepEqual(workTick(snap(), world, () => undefined, [cows], step), ['work: every deep target met: tier 1 (iron 64, coal 64)']);
  t.deepEqual(workTick(snap(), world, () => undefined, [cows], step), ['work: every deep target met: tier 2 (iron 64, coal 64)']);
  t.deepEqual(workTick(snap(), world, () => undefined, [cows], step), []);
  t.deepEqual(asked, [0, 1, 2]);
  t.is(w.tier, 2);
  // the ladder as it stands, with nothing stored: no target is met, nothing steps
  t.deepEqual(workTick(snap(), world, () => undefined), []);
  t.is(w.tier, 2);
});

test('terrain marks tell of the land round this home, as far as this leash: a new home or leash lets them go, and no other mark', (t) => {
  const scout = stub('scout', 6, 'far', [['east', 50]], { terrain: true });
  const cane = stub('cane', 5, 'near', [['south', 20]]);
  const tasks = [scout, cane];
  const world = emptyWorld();
  markDry(world, 'scout:east', T0);
  markDry(world, 'scout:west', T0);
  markDry(world, 'cane:south', T0);
  const tick = (over: Partial<Snapshot> = {}) => workTick(snap(over), world, () => undefined, tasks, () => undefined);

  // a memory from before the land was kept: its marks stand, and the land is written down
  t.deepEqual(tick(), []);
  t.is(workOf(world).land, '0,0,96');
  t.deepEqual(Object.keys(workOf(world).dry), ['scout:east', 'scout:west', 'cane:south']);
  t.deepEqual(tick(), []);

  world.leash = 128;
  t.deepEqual(tick(), ['work: a new home or leash: 2 terrain mark(s) let go']);
  t.deepEqual(workOf(world).dry, { 'cane:south': { n: 1, at: T0 } });
  t.is(workOf(world).land, '0,0,128');

  markDry(world, 'scout:east', T0);
  const moved = { home: { x: 300, y: 70, z: -40, dimension: 'overworld' } };
  t.deepEqual(tick(moved), ['work: a new home or leash: 1 terrain mark(s) let go']);
  t.is(workOf(world).land, '300,-40,128');
  t.deepEqual(tick(moved), []);

  // no home in sight (a look without one): nothing is judged
  markDry(world, 'scout:east', T0);
  t.deepEqual(tick({ home: undefined, distHome: Infinity }), []);
  t.truthy(workOf(world).dry['scout:east']);
  t.is(workOf(world).land, '300,-40,128');
});

test('releaseOldestDry lets the oldest waiting mark go, once per wait, and only of a variant that could run otherwise', (t) => {
  const cows = stub('cows', 2, 'far', [['pen', 90]]);
  const cane = stub('cane', 5, 'near', [['south', 20], ['north', 30], ['west', 40], ['east', 25]]);
  const scout = stub('scout', 6, 'far', [['hill', 50]], { terrain: true });
  const tasks = [cows, cane, scout];
  const b = bench(tasks);
  const world = emptyWorld();
  markDry(world, 'scout:hill', T0 - 9 * MINUTE); // the oldest, but the land does not change in half an hour
  markDry(world, 'cane:west', T0 - 8 * MINUTE); // not ready
  markDry(world, 'cows:pen', T0 - 7 * MINUTE); // too late in the day for 90 blocks
  markDry(world, 'cane:north', T0 - 6 * MINUTE);
  markDry(world, 'cane:south', T0 - 5 * MINUTE);
  markDry(world, 'cane:east', T0 - 30 * MINUTE); // its wait is over: nothing to let go
  cane.off.west = { cause: 'stocked', text: 'enough' };
  const look = (over: Partial<Snapshot> = {}) => snap({ timeOfDay: 9000, ...over });

  // nothing while the bot could not go anyway
  t.is(releaseOldestDry(world, T0, look({ health: 8 }), tasks), undefined);
  t.is(releaseOldestDry(world, T0, look({ sleeping: true }), tasks), undefined);
  t.is(releaseOldestDry(world, T0, look({ distHome: 70, position: { x: 70, y: 64, z: 0 } }), tasks), undefined);

  cane.off.east = { cause: 'stocked', text: 'enough' }; // (so that what is let go is what runs next)
  t.is(b.goal(cane).declines!(look(), world)?.cause, 'dry');
  t.is(releaseOldestDry(world, T0, look(), tasks), 'cane:north');
  t.deepEqual(workOf(world).dry['cane:north'], { n: 1, at: T0 - 6 * MINUTE, early: true });
  t.is(dryUntil(world, 'cane:north', tasks), 0);
  t.is(b.goal(cane).wants(look(), world), 'north: 30 blocks out, let go early after 1 dry');
  // the next half minute: the next oldest
  t.is(releaseOldestDry(world, T0, look(), tasks), 'cane:south');
  // and then none: what is left is terrain, not ready, or too late
  t.is(releaseOldestDry(world, T0, look(), tasks), undefined);
  t.deepEqual(Object.entries(workOf(world).dry).filter(([, m]) => m.early).map(([k]) => k), ['cane:north', 'cane:south']);
  // by the morning light the cows' pen is in reach again: its mark is the one to go
  t.is(releaseOldestDry(world, T0, look({ timeOfDay: 1000 }), tasks), 'cows:pen');

  // the try after an early release comes back dry: the count goes on, and this wait is sat out in full
  markDry(world, 'cane:north', T0 + MINUTE);
  t.deepEqual(workOf(world).dry['cane:north'], { n: 2, at: T0 + MINUTE, freed: true });
  t.is(dryUntil(world, 'cane:north', tasks), T0 + 41 * MINUTE);
  markDry(world, 'cane:south', T0 + MINUTE);
  t.is(releaseOldestDry(world, T0 + 2 * MINUTE, look({ now: T0 + 2 * MINUTE }), tasks), undefined);
  // dry again after the full wait: a mark like any other, which may be let go early once
  markDry(world, 'cane:north', T0 + 41 * MINUTE);
  t.deepEqual(workOf(world).dry['cane:north'], { n: 3, at: T0 + 41 * MINUTE });
  t.is(releaseOldestDry(world, T0 + 42 * MINUTE, look({ now: T0 + 42 * MINUTE }), tasks), 'cane:north');
});

test('dry marks: 20, 40, 80, 160 min and no longer, but for a terrain task, whose marks go on doubling', (t) => {
  t.deepEqual(DRY_WAIT, [20 * MINUTE, 40 * MINUTE, 80 * MINUTE, 160 * MINUTE]);
  const cane = stub('cane', 5, 'near', [['south', 20]]);
  const scout = stub('scout', 6, 'far', [['east', 50]], { terrain: true });
  const tasks = [cane, scout];
  const world = emptyWorld();
  t.is(dryUntil(world, 'cane:south', tasks), 0);
  const waits = (key: string) => Array.from({ length: 8 }, () => { markDry(world, key, T0); return (dryUntil(world, key, tasks) - T0) / MINUTE; });
  t.deepEqual(waits('cane:south'), [20, 40, 80, 160, 160, 160, 160, 160]);
  t.deepEqual(waits('scout:east'), [20, 40, 80, 160, 320, 640, 1280, 2560]);
  t.deepEqual(workOf(world).dry['cane:south'], { n: 8, at: T0 });
});

// ---- running: one rung at a time, as the brain would run it ----

test.serial('a fruitless variant waits 20, 40, 80, 160 min; terrain goes on doubling; gain clears the mark', async (t) => {
  const cane = stub('cane', 5, 'near', [['south', 20]]);
  const scout = stub('scout', 6, 'far', [['east', 50]], { terrain: true });
  const tasks = [cane, scout];
  const b = bench(tasks);
  const world = emptyWorld();
  const g = b.goal(cane);

  t.is(g.wants(b.look(), world), 'south: 20 blocks out');
  // a fruitless run is a result, not a failure: it says what it found, and the mark is what holds the variant back
  const first = await b.run(cane, world);
  t.is(first.text, '[south] nothing found');
  t.deepEqual(first.d.acts, [], 'it ended at home: no walk');
  t.is(first.d.gain, 0);
  t.deepEqual(workOf(world).dry, { 'cane:south': { n: 1, at: T0 } });
  t.deepEqual(workOf(world).last, { task: 'cane', variant: 'south', gain: 0, text: 'nothing found', at: T0 });
  t.deepEqual(g.declines!(b.look(), world), { cause: 'dry', text: 'cane [south] until 14:20', until: T0 + 20 * MINUTE });
  t.is(g.wants(b.look(), world), null);
  b.at.now = T0 + 20 * MINUTE - 1;
  t.is(g.declines!(b.look(), world)?.cause, 'dry');
  // a run started on an older look does not go out to a place still marked
  t.is((await b.run(cane, world)).text, 'nothing to do after all (dry: cane [south] until 14:20)');
  t.is(cane.ran.length, 1);
  b.at.now = T0 + 20 * MINUTE;
  t.is(g.wants(b.look(), world), 'south: 20 blocks out, 1 dry before');

  // each run as soon as the mark lets it: the wait doubles up to 160 min and stays there
  const dryRuns = async (task: Stub, key: string, n: number) => {
    const waits: number[] = [];
    for (let i = 0; i < n; i++) {
      await b.run(task, world);
      const until = dryUntil(world, key, tasks);
      waits.push((until - b.at.now) / MINUTE);
      b.at.now = until;
    }
    return waits;
  };
  t.deepEqual(await dryRuns(cane, 'cane:south', 5), [40, 80, 160, 160, 160]);
  t.is(workOf(world).dry['cane:south'].n, 6);
  t.is(g.wants(b.look(), world), 'south: 20 blocks out, 6 dry before');

  // it brings something in: the mark is gone, and the next run is asked for as if there had never been one
  cane.gains = [3];
  const got = await b.run(cane, world);
  t.is(got.text, '[south] +3 things');
  t.is(got.d.gain, 3, 'what the task counted at its end is told to the brain as gain');
  t.deepEqual(workOf(world).dry, {});
  t.deepEqual(workOf(world).last, { task: 'cane', variant: 'south', gain: 3, text: '+3 things', at: b.at.now });
  t.is(g.wants(b.look(), world), 'south: 20 blocks out');

  // what a walk shows of the land does not change by the hour: a terrain mark goes on doubling
  t.deepEqual(await dryRuns(scout, 'scout:east', 6), [20, 40, 80, 160, 320, 640]);

  // a run that ends away from home is walked home by the wrapper, and says so
  const away = await b.run(scout, world, {}, { x: 50, y: 64, z: 0 });
  t.is(away.text, '[east] nothing found; back home');
  t.deepEqual(away.d.acts, ['go-home']);
  // ten blocks is home: no walk
  b.at.now = dryUntil(world, 'scout:east', tasks);
  const close = await b.run(scout, world, {}, { x: 6, y: 64, z: 8 });
  t.is(close.text, '[east] nothing found');
  t.deepEqual(close.d.acts, []);

  // marks are written before the walk home: a walk that fails throws, and what the run found stands
  b.at.now = dryUntil(world, 'scout:east', tasks);
  const before = workOf(world).dry['scout:east'].n;
  const lost = direct(b.look(), world, { x: 50, y: 64, z: 0 });
  lost.walk = { ok: false, text: 'No path home' };
  await t.throwsAsync(b.goal(scout).run(lost.ctx), { message: '[east] nothing found, but could not get home: No path home' });
  t.deepEqual(workOf(world).dry['scout:east'], { n: before + 1, at: b.at.now });
  t.is(workOf(world).last?.at, b.at.now);
  t.deepEqual(out, { trip: false, work: false });
});

test.serial('the variants take turns: a dry one hands on to the next, one that brought something in is gone back to', async (t) => {
  const cane = stub('cane', 5, 'near', [['south', 20], ['north', 30]]);
  const b = bench([cane]);
  const world = emptyWorld();
  const g = b.goal(cane);

  t.is(g.wants(b.look(), world), 'south: 20 blocks out');
  await b.run(cane, world);
  t.deepEqual(workOf(world).next, { cane: 1 });
  t.is(g.wants(b.look(), world), 'north: 30 blocks out');

  cane.gains = [4];
  b.at.now = T0 + MINUTE;
  t.is((await b.run(cane, world)).text, '[north] +4 things');
  t.deepEqual(workOf(world).next, { cane: 1 }, 'the place that gave is the place to go back to');
  t.is(g.wants(b.look(), world), 'north: 30 blocks out');

  b.at.now = T0 + 2 * MINUTE;
  await b.run(cane, world);
  t.deepEqual(workOf(world).next, { cane: 2 });
  t.deepEqual(cane.ran.map(r => r.variant), ['south', 'north', 'north']);
  // every place dry: one decline for the task, with the first to come free and how many wait
  t.deepEqual(g.declines!(b.look(), world), { cause: 'dry', text: 'cane [south] until 14:20 (2 dry)', until: T0 + 20 * MINUTE });

  b.at.now = T0 + 20 * MINUTE;
  t.is(g.wants(b.look(), world), 'south: 20 blocks out, 1 dry before');
  // a place that is not ready is passed over, whatever its turn
  cane.off.south = { cause: 'stocked', text: 'enough cane' };
  t.deepEqual(g.declines!(b.look(), world), { cause: 'dry', text: 'cane [north] until 14:22', until: T0 + 22 * MINUTE });
  b.at.now = T0 + 22 * MINUTE;
  t.is(g.wants(b.look(), world), 'north: 30 blocks out, 1 dry before');
  cane.off.north = { cause: 'unneeded', text: 'no cane to cut' };
  t.deepEqual(g.declines!(b.look(), world), { cause: 'stocked', text: 'enough cane' }, 'nothing ready: what the first in turn says');
});

test.serial('a run is given its budget: the task\'s own, or what the day leaves after the walk back', async (t) => {
  const near = stub('near', 5, 'near', [['copse', 30]]);
  const yard = stub('yard', 6, 'yard');
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  for (const task of [near, yard, deep]) task.gains = [1, 1, 1];
  const b = bench([near, yard, deep]);
  const world = emptyWorld();
  await b.run(near, world);
  await b.run(near, world, { timeOfDay: 9000 });
  await b.run(yard, world);
  await b.run(yard, world, { timeOfDay: 10_000 });
  await b.run(deep, world);
  b.at.now += HOUR;
  await b.run(deep, world, { timeOfDay: 5000 });
  // (100 s of daylight at 9000, less 10 s to walk the 30 blocks back and 15 s to spare)
  t.deepEqual(near.ran.map(r => r.budgetMs), [2 * MINUTE, 75_000]);
  t.deepEqual(yard.ran.map(r => r.budgetMs), [2 * MINUTE, 35_000]);
  // (a deep trip mines until the day's end, less the two minutes up and home)
  t.deepEqual(deep.ran.map(r => r.budgetMs), [380_000, 180_000]);
  // too late by the time the run begins: it does not set out, and that is no dry run
  t.is((await b.run(yard, world, { timeOfDay: 10_701 })).text, 'nothing to do after all (late: 0.2 min of daylight left (yard needs 0.3))');
  t.is(yard.ran.length, 2);
  t.deepEqual(workOf(world).dry, {});
});

test.serial('what making room took comes off a far run\'s time: the brain stops the run at its timeout, counted from its start', async (t) => {
  // coal at the leash: 6 min to mine, and the brain stops the run 8 min after it began
  const far = stub('surface', 6, 'far', [['coal', 96]], { budgetMs: 6 * MINUTE });
  far.gains = [5, 5];
  const b = bench([far]);
  const world = stored({});
  const g = b.goal(far);
  t.is(g.timeoutMs, 8 * MINUTE);
  // 34/36 slots of logs: the run walks home and puts them away first, and that takes `ms` of the clock
  const full = carrying(Array.from({ length: 34 }, (_, slot) => ({ slot, name: 'oak_log', count: 64 })));
  const run = async (ms: number) => {
    const d = direct(b.look(full), world);
    const call = d.ctx.call;
    d.ctx = { ...d.ctx, call: (async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'inventory') return call(method, params);
      b.at.now += ms;
      return { items: [] };
    }) as GoalContext['call'] };
    return g.run(d.ctx);
  };
  // nothing to put away first: the whole six minutes
  await b.run(far, world);
  // a minute and a half on the put-away: what is left before the timeout, less the walk there and back (64 s) and
  // half a minute to spare
  t.is(await run(90_000), '[coal] +5 things');
  t.deepEqual(far.ran.map(r => r.budgetMs), [6 * MINUTE, 8 * MINUTE - 90_000 - 64_000 - 30_000]);
  // five and a half: under the least work a far run is worth, so it does not set out, and that is no dry run
  b.at.now += HOUR;
  t.is(await run(330_000), '[coal] not setting out: making room took 330 s, too little of the run\'s time is left');
  t.is(far.ran.length, 2);
  t.deepEqual(workOf(world).dry, {});
});

test.serial('an unblocker dry twice, or one already tried today before any deep trip, ranks below deep', async (t) => {
  const cows = stub('cows', 2, 'far', [['east', 50]]);
  const cane = stub('cane', 3, 'far', [['north', 40]]);
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const scout = stub('scout', 5, 'far', [['hill', 60]]);
  deep.gains = [5, 5, 5];
  const b = bench([cows, cane, deep, scout]);
  const world = emptyWorld();
  const urgencies = () => { const s = b.look(); return b.goals.map(g => g.urgency!(s, world)); };
  const next = () => { const d = decide(b.look(), world, b.goals, new Map()); return d && `${d.goal.name}: ${d.reason}`; };

  t.deepEqual(urgencies(), [17, 16, 15, 14]);
  t.is(next(), 'work: cows: east: 50 blocks out');

  // one trip for the project came back empty: the next such trip waits for a deep one, that the day is not spent on them
  await b.run(cows, world);
  t.deepEqual(workOf(world).farDay, { day: 0, unblockers: 1, deep: 0 });
  t.is(b.goal(cane).wants(b.look(), world), 'north: 40 blocks out (one such trip today already: the deep trip first)');
  t.deepEqual(urgencies(), [17, 7.5, 15, 14]);
  t.is(next(), 'work: deep: iron: under ground');
  await b.run(deep, world);
  t.deepEqual(workOf(world).farDay, { day: 0, unblockers: 1, deep: 1 });
  t.is(b.goal(cane).wants(b.look(), world), 'north: 40 blocks out');
  t.deepEqual(urgencies(), [17, 16, 15, 14]);
  t.is(next(), 'work: cane: north: 40 blocks out');

  // dry twice: it still asks when its wait is over, but after everything else on the ladder
  b.at.now = T0 + 20 * MINUTE;
  t.is(b.goal(cows).wants(b.look(), world), 'east: 50 blocks out, 1 dry before');
  await b.run(cows, world);
  b.at.now = T0 + 60 * MINUTE;
  t.is(b.goal(cows).wants(b.look(), world), 'east: 50 blocks out, 2 dry before (dry 2 times: after the deep trip)');
  t.deepEqual(urgencies(), [8, 16, 15, 14]);
  const order = () => { const s = b.look(); return [...b.goals].sort((x, y) => y.urgency!(s, world) - x.urgency!(s, world)).map(g => g.name); };
  t.deepEqual(order(), ['work: cane', 'work: deep', 'work: scout', 'work: cows']);
  // (and it is still chosen when nothing else asks)
  for (const task of [cane, deep, scout]) task.off[task.list[0][0]] = { cause: 'stocked', text: 'enough' };
  t.is(next(), 'work: cows: east: 50 blocks out, 2 dry before (dry 2 times: after the deep trip)');
  for (const task of [cane, deep, scout]) task.off = {};
  // it brings something in at last: a rung like any other again
  cows.gains = [2];
  await b.run(cows, world);
  t.deepEqual(urgencies(), [17, 16, 15, 14]);

  // "today" is the tally's day: the morning ends it
  const morning = emptyWorld();
  await b.run(cane, morning);
  t.is(b.goal(cows).wants(b.look(), morning), 'east: 50 blocks out (one such trip today already: the deep trip first)');
  idleOf(morning).today.day = 1;
  t.is(b.goal(cows).wants(b.look(), morning), 'east: 50 blocks out');
  // the rule is for the rungs that unblock the project: any other rung keeps its place, dry or not
  markDry(morning, 'scout:hill', b.at.now - 2 * HOUR);
  markDry(morning, 'scout:hill', b.at.now - HOUR);
  const s = b.look();
  t.is(b.goal(scout).wants(s, morning), 'hill: 60 blocks out, 2 dry before');
  t.is(b.goal(scout).urgency!(s, morning), 14);
});

test.serial('on probation: 2 deep trips an hour until 3 end well; a death puts it back', async (t) => {
  let death: Death | undefined;
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  deep.gains = new Array<number>(20).fill(5);
  const tasks = [deep];
  const b = bench(tasks, () => death);
  const world = emptyWorld();
  const g = b.goal(deep);
  const at = (min: number) => { b.at.now = T0 + min * MINUTE; };
  t.deepEqual(PROBATION, { clean: 3, perHour: 2 });

  t.is(g.wants(b.look(), world), 'iron: under ground');
  t.is((await b.run(deep, world)).text, '[iron] +5 things');
  at(10);
  await b.run(deep, world);
  t.deepEqual(workOf(world).deep, { starts: [T0, T0 + 10 * MINUTE], clean: 2, deaths: [] });
  at(20);
  const held: Decline = { cause: 'hold', text: 'deep on probation: 2 trips this hour, next at 15:00', until: T0 + HOUR };
  t.deepEqual(g.declines!(b.look(), world), held);
  t.deepEqual(deepHold(b.look(), world), held, 'the old deep trip goal is to read the same hold');
  t.is(workLine(world, b.at.now, tasks), 'Work queue: last deep [iron] +5 things 10 min ago; tier 0; deep trips 2 in 24 h, on probation 2/3.');
  // a run the brain started on an older look does not go down all the same
  t.is((await b.run(deep, world)).text, 'nothing to do after all (hold: deep on probation: 2 trips this hour, next at 15:00)');
  t.is(workOf(world).deep.starts.length, 2);
  b.at.now = T0 + HOUR - 1;
  t.is(g.declines!(b.look(), world)?.cause, 'hold');

  // the third that ends well ends the probation: as many trips as the day has room for
  at(60);
  t.is(g.wants(b.look(), world), 'iron: under ground');
  await b.run(deep, world);
  t.is(workOf(world).deep.clean, 3);
  at(61);
  await b.run(deep, world);
  at(62);
  await b.run(deep, world);
  at(63);
  t.is(g.wants(b.look(), world), 'iron: under ground');
  t.is(workLine(world, b.at.now, tasks), 'Work queue: last deep [iron] +5 things 1 min ago; tier 0; deep trips 5 in 24 h.');

  // a death on a trip: on probation again, from none
  deep.body = async () => { death = { at: { x: 5, z: 5 }, time: b.at.now }; };
  await b.run(deep, world);
  deep.body = undefined;
  t.is(workOf(world).deep.clean, 0);
  t.deepEqual(workOf(world).deep.deaths, [T0 + 63 * MINUTE]);
  at(64);
  t.deepEqual(g.declines!(b.look(), world), { cause: 'hold', text: 'deep on probation: 2 trips this hour, next at 16:02', until: T0 + 122 * MINUTE });
  t.is(workLine(world, b.at.now, tasks), 'Work queue: last deep [iron] +5 things 1 min ago; tier 0; deep trips 6 in 24 h, on probation 0/3.');
  // the same death is still the runtime's last one on the trips after: it is booked once, and they count as ended well
  at(122);
  await b.run(deep, world);
  t.is(workOf(world).deep.clean, 1);
  t.deepEqual(workOf(world).deep.deaths, [T0 + 63 * MINUTE]);

  // a trip cut short has set out (it counts in the hour) but did not end well, nor badly; and it learnt nothing of the place
  at(130);
  const last = { ...workOf(world).last };
  const cut = direct(b.look(), world);
  deep.body = async () => { cut.abort(); };
  await t.throwsAsync(g.run(cut.ctx), { message: 'aborted' });
  // (open until the bot is seen home: a death on the way back would still be the trip's)
  t.deepEqual(workOf(world).deep, { starts: [0, 10, 60, 61, 62, 63, 122, 130].map(m => T0 + m * MINUTE), clean: 1, deaths: [T0 + 63 * MINUTE], away: T0 + 130 * MINUTE });
  t.deepEqual(workOf(world).dry, {});
  t.deepEqual(workOf(world).last, last);
  t.deepEqual(out, { trip: false, work: false });
  // but a death on it is booked, however the trip ended
  at(190);
  const died = direct(b.look(), world);
  deep.body = async () => { death = { time: b.at.now }; died.abort(); };
  await t.throwsAsync(g.run(died.ctx), { message: 'aborted' });
  t.is(workOf(world).deep.clean, 0);
  t.deepEqual(workOf(world).deep.deaths, [T0 + 63 * MINUTE, T0 + 190 * MINUTE]);
});

test.serial('two deaths on deep trips in 24 h hold the deep rung until the older one is a day old', async (t) => {
  let death: Death | undefined;
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const scout = stub('scout', 5, 'far', [['east', 50]]);
  deep.gains = [5, 5, 5];
  const b = bench([deep, scout], () => death);
  const world = emptyWorld();
  const g = b.goal(deep);
  // each of these trips ends in a death a minute after it set out
  deep.body = async () => { b.at.now += MINUTE; death = { at: { x: 0, z: 0 }, time: b.at.now }; };

  await b.run(deep, world);
  t.deepEqual(workOf(world).deep, { starts: [T0], clean: 0, deaths: [T0 + MINUTE] });
  b.at.now = T0 + 30 * MINUTE;
  t.is(g.wants(b.look(), world), 'iron: under ground', 'one death holds nothing here (the kit is another matter)');
  b.at.now = T0 + 2 * HOUR;
  await b.run(deep, world);
  t.deepEqual(workOf(world).deep.deaths, [T0 + MINUTE, T0 + 2 * HOUR + MINUTE]);

  b.at.now = T0 + 3 * HOUR;
  const held: Decline = { cause: 'hold', text: 'two deaths on deep trips in 24 h: held until 14:01', until: T0 + MINUTE + DAY };
  t.deepEqual(g.declines!(b.look(), world), held);
  t.deepEqual(deepHold(b.look(), world), held);
  // it is the deep rung that is held: the others go on
  t.is(b.goal(scout).wants(b.look(), world), 'east: 50 blocks out');
  b.at.now = T0 + DAY + MINUTE - 1;
  t.is(g.declines!(b.look(), world)?.cause, 'hold');
  // the older death a day old: one is left in the 24 h, which holds nothing
  b.at.now = T0 + DAY + MINUTE;
  t.is(g.wants(b.look(), world), 'iron: under ground');
  t.is(deepHold(b.look(), world), null);
});

test.serial('a death on the walk home from a deep trip is one on the trip: the probation starts again, and two in 24 h hold the rung', async (t) => {
  let death: Death | undefined;
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  deep.gains = [5, 5, 5];
  const b = bench([deep], () => death);
  const g = b.goal(deep);
  /** a trip that mined its fill and ends 80 blocks out; on the climb out a minute later the bot dies (or not, at dusk) */
  const trip = (world: WorldMemory, how: 'cut' | 'respawned' | 'dusk') => {
    const d = direct(b.look(), world, { x: 80, y: 20, z: 0 });
    d.ctx = { ...d.ctx, act: async (tool) => {
      if (tool !== 'go-home') return { ok: true, text: 'ok' };
      b.at.now += MINUTE;
      if (how !== 'dusk') death = { at: { x: 70, z: 0 }, time: b.at.now };
      // back home after the respawn, the walk "done"; or recover (or shelter) stops the walk
      if (how === 'respawned') return { ok: true, text: 'Home' };
      d.abort();
      throw new Error('aborted');
    } };
    return g.run(d.ctx);
  };

  // two trips that ended well, then one whose walk home the death cut short: on probation again, from none
  const world = emptyWorld({ work: { dry: {}, next: {}, sites: {}, pen: {}, tier: 0, deep: { starts: [], clean: 2, deaths: [] } } });
  await t.throwsAsync(trip(world, 'cut'), { message: 'aborted' });
  t.deepEqual(workOf(world).deep, { starts: [T0], clean: 0, deaths: [T0 + MINUTE] });
  // what it brought in and found of the place was written before the walk
  t.deepEqual([workOf(world).last?.gain, workOf(world).dry], [5, {}]);
  // two hours on, a death on the way home again; this time the walk home ends after the respawn
  b.at.now = T0 + 2 * HOUR;
  t.is(await trip(world, 'respawned'), '[iron] +5 things; back home');
  t.deepEqual(workOf(world).deep, { starts: [T0, T0 + 2 * HOUR], clean: 0, deaths: [T0 + MINUTE, T0 + 2 * HOUR + MINUTE] });
  t.deepEqual(g.declines!(b.look(), world), { cause: 'hold', text: 'two deaths on deep trips in 24 h: held until 14:01', until: T0 + MINUTE + DAY });

  // a walk home cut short with no death (dusk: shelter walks it home itself) is a trip that ran its course
  const calm = emptyWorld();
  b.at.now = T0 + 3 * HOUR;
  await t.throwsAsync(trip(calm, 'dusk'), { message: 'aborted' });
  t.deepEqual(workOf(calm).deep, { starts: [T0 + 3 * HOUR], clean: 1, deaths: [], away: T0 + 3 * HOUR + MINUTE });
  t.deepEqual(out, { trip: false, work: false });
  // seen home alive: the trip is over, and a death after that is none of its
  death = undefined;
  t.deepEqual(workTick(b.look({ position: { x: 4, y: 64, z: 0 }, distHome: 4 }), calm, () => death), []);
  t.deepEqual(workOf(calm).deep, { starts: [T0 + 3 * HOUR], clean: 1, deaths: [] });
  b.at.now += MINUTE;
  death = { at: { x: 2, z: 0 }, time: b.at.now };
  workTick(b.look(), calm, () => death);
  t.deepEqual(workOf(calm).deep, { starts: [T0 + 3 * HOUR], clean: 1, deaths: [] });
});

test.serial('a death that follows a deep trip cut short out there, before the bot is home, is one on the trip', async (t) => {
  let death: Death | undefined;
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  deep.gains = [5, 5, 5, 5];
  const b = bench([deep], () => death);
  const g = b.goal(deep);
  const deepOf = (world: WorldMemory) => workOf(world).deep;
  /** the bot 80 out and 40 down; survival (retreat at health 8) cuts the mining, or the walk home after it */
  const trip = (world: WorldMemory, cut: 'mining' | 'walk') => {
    const d = direct(b.look(), world, { x: 80, y: 20, z: 0 });
    if (cut === 'mining') deep.body = async () => { d.abort(); };
    else {
      deep.body = undefined;
      d.ctx = { ...d.ctx, act: async (tool) => { if (tool === 'go-home') { d.abort(); throw new Error('aborted'); } return { ok: true, text: 'ok' }; } };
    }
    return t.throwsAsync(g.run(d.ctx), { message: 'aborted' });
  };
  /** a tick of the queue's housekeeping, the bot `x` blocks out */
  const tick = (world: WorldMemory, x: number) => workTick(b.look({ position: { x, y: 20, z: 0 }, distHome: x }), world, () => death);
  const was = (clean: number) => emptyWorld({ work: { dry: {}, next: {}, sites: {}, pen: {}, tier: 0, deep: { starts: [], clean, deaths: [] } } });

  // the mining cut short with no death yet: nothing booked; the bot dies on the way up 3 s later
  const one = was(2);
  await trip(one, 'mining');
  t.deepEqual(deepOf(one), { starts: [T0], clean: 2, deaths: [], away: T0 });
  t.deepEqual(tick(one, 75), []);
  b.at.now += 3000;
  death = { at: { x: 70, z: 0 }, time: b.at.now };
  t.true(tick(one, 16).includes('work: a death on the way back from a deep trip: on probation again'));
  // (and as any death away from home, the trips wait for the kit)
  t.deepEqual(deepOf(one), { starts: [T0], clean: 0, deaths: [T0 + 3000], kitHold: T0 + 3000 });
  t.deepEqual(tick(one, 16).filter(l => l.includes('deep trip')), [], 'booked once');

  // the trip ran its course and the walk home was cut: it counted as ended well, until the death on the way
  b.at.now = T0 + HOUR;
  death = undefined;
  const two = was(2);
  await trip(two, 'walk');
  t.deepEqual(deepOf(two), { starts: [T0 + HOUR], clean: 3, deaths: [], away: T0 + HOUR });
  b.at.now += 20_000;
  death = { at: { x: 60, z: 0 }, time: b.at.now };
  tick(two, 16);
  t.deepEqual(deepOf(two), { starts: [T0 + HOUR], clean: 0, deaths: [T0 + HOUR + 20_000], kitHold: T0 + HOUR + 20_000 });
  // two hours on, the same again: two deaths on deep trips in 24 h hold the rung
  b.at.now = T0 + 3 * HOUR;
  death = undefined;
  await trip(two, 'walk');
  b.at.now += 20_000;
  death = { at: { x: 60, z: 0 }, time: b.at.now };
  tick(two, 16);
  t.deepEqual(deepOf(two).deaths, [T0 + HOUR + 20_000, T0 + 3 * HOUR + 20_000]);
  t.like(deepHold(b.look(), two), { cause: 'hold', text: 'two deaths on deep trips in 24 h: held until 15:00' });

  // a cut trip, and the bot stranded out there for good: a quarter of an hour on, the trip is over
  b.at.now = T0 + 5 * HOUR;
  death = undefined;
  const three = was(0);
  await trip(three, 'mining');
  b.at.now += 15 * MINUTE;
  tick(three, 70);
  t.deepEqual(deepOf(three), { starts: [T0 + 5 * HOUR], clean: 0, deaths: [] });
  death = { at: { x: 70, z: 0 }, time: b.at.now };
  tick(three, 70);
  t.deepEqual(deepOf(three).deaths, []);

  // a death the trip's own booking had not heard of as it wound down (the word of it came after): booked all the same
  b.at.now = T0 + 7 * HOUR;
  death = undefined;
  const four = was(1);
  const late = direct(b.look(), four, { x: 80, y: 20, z: 0 });
  deep.body = async () => { b.at.now += 2 * MINUTE; late.abort(); };
  await t.throwsAsync(g.run(late.ctx), { message: 'aborted' });
  t.like(deepOf(four), { clean: 1, away: T0 + 7 * HOUR + 2 * MINUTE });
  death = { at: { x: 60, z: 0 }, time: T0 + 7 * HOUR + MINUTE };
  tick(four, 60);
  t.like(deepOf(four), { clean: 0, deaths: [T0 + 7 * HOUR + MINUTE] });
  t.deepEqual(out, { trip: false, work: false });
});

test.serial('a trip that never got to the work marks nothing, is tried first again, and is no deep trip that ended well', async (t) => {
  let death: Death | undefined;
  const untried = async () => ({ gain: 0, text: 'could not reach the mine start (0, -56)', untried: true as const });
  const deep = stub('deep', 4, 'deep', [['iron', 0], ['gold', 0]], { run: untried });
  const b = bench([deep], () => death);
  const world = emptyWorld();
  // (a failure for the brain, once it is home: it holds the rung back, or it would set out again at once for the same start)
  await t.throwsAsync(b.run(deep, world), { message: '[iron] could not reach the mine start (0, -56)' });
  t.deepEqual(workOf(world).dry, {}, 'no dry mark: the place was never reached');
  t.deepEqual(workOf(world).next, {}, 'and iron is tried first again');
  t.deepEqual(workOf(world).deep, { starts: [T0], clean: 0, deaths: [] }, 'it set out, but never went down');
  t.like(workOf(world).last, { task: 'deep', variant: 'iron', gain: 0, text: 'could not reach the mine start (0, -56)' });
  t.is(b.goal(deep).wants(b.look(), world), 'iron: under ground');
  // a death on such a trip is booked all the same
  deep.run = async () => { death = { time: b.at.now }; return untried(); };
  b.at.now += 10 * MINUTE;
  await t.throwsAsync(b.run(deep, world), { message: '[iron] could not reach the mine start (0, -56)' });
  t.deepEqual(workOf(world).deep, { starts: [T0, T0 + 10 * MINUTE], clean: 0, deaths: [T0 + 10 * MINUTE] });
});

test.serial('a trip has urgency 58; a yard task does not', async (t) => {
  t.is(TRIP_URGENCY, 58);
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  const scout = stub('scout', 5, 'far');
  const cane = stub('cane', 6, 'near');
  const chop = stub('chop', 7, 'yard');
  const tasks = [deep, scout, cane, chop];
  const b = bench(tasks);
  const world = emptyWorld();
  const seen: Record<string, { all: number[]; out: typeof out }> = {};
  for (const task of tasks) {
    task.gains = [1];
    task.body = async (ctx) => { seen[task.name] = { all: b.goals.map(g => g.urgency!(ctx.s, world)), out: { ...out } }; };
    await b.run(task, world);
    t.deepEqual(out, { trip: false, work: false }, `${task.name}: the flags are down when the run is over`);
  }
  // under way: the trip is as urgent as the old deep trip was (the smelter and the stock do not call it home); only
  // the one under way, and never a run that stays in sight of home
  t.deepEqual(seen, {
    deep: { all: [58, 14, 13, 12], out: { trip: true, work: true } },
    scout: { all: [15, 58, 13, 12], out: { trip: true, work: true } },
    cane: { all: [15, 14, 13, 12], out: { trip: false, work: true } },
    chop: { all: [15, 14, 13, 12], out: { trip: false, work: true } }
  });
  const s = b.look();
  t.deepEqual(b.goals.map(g => g.urgency!(s, world)), [15, 14, 13, 12]);
  t.deepEqual(b.goals.map(g => g.priority), [15, 14, 13, 12]);

  // a task that throws: the failure is the brain's to hold, the flags are down, and nothing was learnt of the place
  scout.body = async () => { t.true(out.trip); throw new Error('boom'); };
  b.at.now += MINUTE;
  await t.throwsAsync(b.run(scout, world), { message: 'boom' });
  t.deepEqual(out, { trip: false, work: false });
  t.deepEqual(workOf(world).dry, {});
  t.is(workOf(world).last?.task, 'chop');
});

// ---- through the brain: real ticks, with the stub rungs among its goals ----

interface State { pos: Pos; time: number; items: InventoryItem[]; death?: { at: Pos; time: number }; noDeaths?: string; walk?: 'held' | 'fails' }
const atHome = (over: Partial<State> = {}): State => ({ pos: { ...HOME }, time: 1000, items: [], ...over });

/**
 * More for the stand-in game: tools, and bridge calls answered before its own (undefined: not this one). `strict`: the
 * status look goes through the bridge as tools.ts's does, refused to a run the brain has given up.
 */
interface Extra { actions?: ClientRuntime['actions']; call?: (method: string, params?: Record<string, unknown>) => unknown; strict?: true }

/**
 * A bot in the world `seed:1` with its home at (0, 64, 0), and a brain over it whose clock the test moves (`tick`
 * moves it on, looks once, and lets what follows settle). The `slow` tool returns when the brain cancels it; the walk
 * home arrives at once, or when the test says `arrive`, or fails, as `state.walk` has it. `said` is the brain's log
 * from the start, without the times.
 */
function brainOf(state: State, tasks: WorkTask[], more: Goal[] = [], memoryFile?: string, extra: Extra = {}) {
  const at = { clock: T0 };
  const region = new Array<string>(25 * 11 * 25).fill('air');
  let release: (() => void) | undefined;
  let home: (() => void) | undefined;
  const rt: ClientRuntime = {
    actions: {
      'go-home': async () => {
        if (state.walk === 'fails') return reply('No path home', true);
        if (state.walk === 'held') await new Promise<void>(r => { home = r; });
        state.pos = { ...HOME };
        return reply('Home');
      },
      'slow': async () => { await new Promise<void>(r => { release = r; }); await rt.call('status'); return reply('slow done'); },
      ...extra.actions
    },
    call: (async (method: string, params?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      const answer: unknown = await extra.call?.(method, params);
      if (answer !== undefined) return answer;
      if (method === 'inventory') return { items: state.items };
      if (method === 'world.region') return { blocks: region };
      if (method === 'cancel') { release?.(); home?.(); return {}; }
      return {};
    }) as ClientRuntime['call'],
    status: async () => {
      if (extra.strict && brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      return { inWorld: true, username: 'Bot', screen: null, position: state.pos, block: state.pos, timeOfDay: state.time, hashedSeed: '1',
        dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 };
    },
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => { if (state.noDeaths) throw new Error(state.noDeaths); return state.death; },
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  };
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), 'brain.log');
  const goals = [...more, ...workGoals(() => rt.lastDeath(), tasks, () => at.clock)];
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => at.clock, goals, logFile, ...(memoryFile ? { memoryFile } : {}) });
  brain.setEnabled(true);
  return {
    brain, at,
    tick: async (ms = 0) => { at.clock += ms; await brain.tick(); await settle(); },
    said: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => l.slice(25)),
    arrive: () => home?.(),
    off: async () => { brain.setEnabled(false); await settle(); }
  };
}

/** Today's tally as the brain keeps it. */
const today = (brain: Brain) => idleOf(brain.worldMemory()!).today;
/** The line of brain-status that starts so. */
const statusLine = (brain: Brain, start: string) => brain.status().split('\n').find(l => l.startsWith(start));
/** The work memory as the brain has it. */
const queue = (brain: Brain) => workOf(brain.worldMemory()!);

test.serial('a trip out beyond 10 blocks is cut short only by a survival goal, or by the kit when no pickaxe is carried', async (t) => {
  // the chores as the brain knows them by name and urgency: each asks when the test says so, and is done at once.
  // (The real kit wants only within ten of home, so out here it never asks: a trip down with no pickaxe left ends
  // itself, deep.test.ts. The rule is the brain's, for whatever a goal of that name wants)
  const want: Record<string, string> = {};
  const chore = (name: string, priority: number): Goal => ({ name, priority, wants: () => want[name] ?? null, run: async () => `${name} seen to`, timeoutMs: 60_000, retryMs: 1000 });
  const chores = [chore('shelter', 80), chore('food', 76), chore('kit', 70), chore('smelt', 66), chore('stock', 64), chore('stash', 60)];
  const pickaxe: InventoryItem = { slot: 0, name: 'iron_pickaxe', count: 1 };
  const state = atHome({ items: [pickaxe] });
  const far = stub('far', 5, 'far');
  let reach = 30;
  far.body = async (ctx) => { state.pos = { x: reach, y: 64, z: 0 }; await ctx.act('slow'); };
  const b = brainOf(state, [far], chores);
  /** nothing asks, the bot is home, and the trip sets out (again) */
  const setOut = async () => {
    for (const name of Object.keys(want)) delete want[name];
    state.pos = { ...HOME };
    await b.tick(5000);
    t.is(statusLine(b.brain, 'Now:'), 'Now: work: far (only: 20 blocks out) for 0s.');
    t.deepEqual(out, { trip: true, work: true });
  };
  const stops = () => b.said().filter(l => l.startsWith('stopping '));

  // 30 blocks out. The smelter, the stock, the stash, and what the kit wants while a pickaxe is carried: all of them
  // more urgent than the trip (58) by their numbers, and each would cost it the walk out. They wait for it to be home
  await setOut();
  Object.assign(want, { kit: 'a better sword in the chest', smelt: 'ore to smelt', stock: 'short of 32 log', stash: '35/36 slots used' });
  await b.tick(5000);
  await b.tick(5000);
  t.deepEqual(stops(), []);
  t.is(statusLine(b.brain, 'Now:'), 'Now: work: far (only: 20 blocks out) for 10s.');
  // hunger does not wait
  want.food = 'hungry';
  await b.tick(5000);
  t.deepEqual(stops(), ['stopping work: far: food is more urgent (hungry)']);
  t.deepEqual(out, { trip: false, work: false }, 'the flags go down with the run');

  // nor does the night
  await setOut();
  want.shelter = 'night is near';
  await b.tick(5000);
  t.deepEqual(stops().slice(1), ['stopping work: far: shelter is more urgent (night is near)']);

  // the kit: only when there is no pickaxe left to work with
  await setOut();
  want.kit = 'no pickaxe';
  await b.tick(5000);
  t.is(stops().length, 2, 'a pickaxe is carried: whatever the kit says can wait');
  state.items = [];
  await b.tick(5000);
  t.deepEqual(stops().slice(2), ['stopping work: far: kit is more urgent (no pickaxe)']);

  // within ten blocks of home the trip is in the chores' reach: there each says itself what is worth a stop
  reach = 8;
  state.items = [pickaxe];
  await setOut();
  want.smelt = 'ore to smelt';
  await b.tick(5000);
  t.deepEqual(stops().slice(3), ['stopping work: far: smelt is more urgent (ore to smelt)']);

  // a pre-empted run books no dry mark: it has learnt nothing of the place
  t.is(far.ran.length, 4);
  t.deepEqual(queue(b.brain).dry, {});
  t.is(queue(b.brain).last, undefined);
  t.is(statusLine(b.brain, 'Retrying later:'), undefined, 'and nothing holds it: it goes again when it is wanted');
  t.is(statusLine(b.brain, 'Loops in the last hour'), undefined);
  t.deepEqual(out, { trip: false, work: false });
  await b.off();
});

test.serial('down the mine under the yard\'s edge, 8 from home across the ground and 55 below it, a trip is beyond the chores\' reach: smelt waits, out from under cuts it', async (t) => {
  // live on Nov 12 smelt (66) cut three deep trips "within 10 of home" from under the yard's edge: distHome is across
  // the ground. The chores by name and urgency, as above; `out from under` is the survival goal's name
  const want: Record<string, string> = {};
  const chore = (name: string, priority: number): Goal => ({ name, priority, wants: () => want[name] ?? null, run: async () => `${name} seen to`, timeoutMs: 60_000, retryMs: 1000 });
  const chores = [chore('out from under', 93), chore('kit', 70), chore('smelt', 66), chore('stash', 60)];
  const state = atHome({ items: [{ slot: 0, name: 'iron_pickaxe', count: 1 }] });
  const deep = stub('deep', 5, 'deep');
  // (home (0, 64, 0): the round follows the ore to 8 from home, 55 under it)
  deep.body = async (ctx) => { state.pos = { x: 8, y: 9, z: 0 }; await ctx.act('slow'); };
  const b = brainOf(state, [deep], chores);
  const stops = () => b.said().filter(l => l.startsWith('stopping '));
  await b.tick(5000);
  t.is(statusLine(b.brain, 'Now:'), 'Now: work: deep (only: under ground) for 0s.');
  Object.assign(want, { kit: 'a better sword in the chest', smelt: '5 raw_gold to smelt', stash: '35/36 slots used' });
  await b.tick(5000);
  await b.tick(5000);
  t.deepEqual(stops(), []);
  t.is(statusLine(b.brain, 'Home'), 'Home (0, 64, 0), 8 blocks away, 55 below it.');
  // on home's level, 8 out, the chores are in reach again, and the most urgent of them stops it (as above)
  state.pos = { x: 8, y: 64, z: 0 };
  await b.tick(5000);
  t.deepEqual(stops(), ['stopping work: deep: kit is more urgent (a better sword in the chest)']);
  // the survival goal cuts it wherever it is
  for (const name of Object.keys(want)) delete want[name];
  state.pos = { ...HOME };
  await b.tick(5000);
  t.is(statusLine(b.brain, 'Now:'), 'Now: work: deep (only: under ground) for 0s.');
  want['out from under'] = '55 under the yard\'s ground';
  await b.tick(5000);
  t.deepEqual(stops().slice(1), ['stopping work: deep: out from under is more urgent (55 under the yard\'s ground)']);
  await b.off();
});

test.serial('the run wrapper does not walk home from under the yard, where the walk stops in a second: the trip stays open until the bot is home', async (t) => {
  const deep = stub('deep', 5, 'deep', [['iron', 0]]);
  deep.gains = [5, 5];
  const b = bench([deep]);
  const world = emptyWorld();
  // home (0, 64, 0) with no yard known: the bridge's zone is the circle of 24 round home and 6 past it, at any depth
  const { text, d } = await b.run(deep, world, {}, { x: 8, y: 9, z: 0 });
  t.is(text, '[iron] +5 things; under the yard: out from under first');
  t.deepEqual(d.acts, [], 'no go-home');
  t.like(workOf(world).deep, { starts: [T0], clean: 1, away: T0 });
  // 8 from home across the ground and 55 under it is not home: the trip stays open, and closes once the bot is home
  workTick(b.look({ position: { x: 8, y: 9, z: 0 }, distHome: 8 }), world, () => undefined);
  t.is(workOf(world).deep.away, T0);
  workTick(b.look({ position: { x: 2, y: 64, z: 0 }, distHome: 2 }), world, () => undefined);
  t.is(workOf(world).deep.away, undefined);
  // down the mine past the margin (31 out): the walk home as ever
  const mine = await b.run(deep, emptyWorld(), {}, { x: 31, y: 9, z: 0 });
  t.is(mine.text, '[iron] +5 things; back home');
  t.deepEqual(mine.d.acts, ['go-home']);
  // 8 out across the ground and 30 above home (on a tower, a hill) is no end of the walk home either
  deep.gains = [5];
  const high = await b.run(deep, emptyWorld(), {}, { x: 8, y: 94, z: 0 });
  t.is(high.text, '[iron] +5 things; back home');
  t.deepEqual(high.d.acts, ['go-home']);
});

test.serial('a trip down comes up where it went down before it walks home: Baritone\'s way home from down there runs under the yard', async (t) => {
  // live on Nov 13 the walk home from (-505, -21, 2213) stopped 55 under the yard at (-530, 7, 2189), and a trip's walk
  // home after its iron at (-529, 10, 2179). Home (0, 64, 0) with no yard known: the bridge's zone is the circle of 24
  // round home and 6 past it, at any depth. The trip went down at the mine start (40, 64, 0) and ends 40 out, 54 down
  const deep = stub('deep', 5, 'deep', [['iron', 0]], { run: async () => ({ gain: 5, text: '+5 raw_iron', upAt: { x: 40, y: 64, z: 0 } }) });
  const b = bench([deep]);
  /** the bot down there: Baritone's walk to a block gets there the way it came (`stuck`: it does not), and go-home from down there plans straight under the ground into the column */
  const down = (at: Pos = { x: 40, y: 10, z: 0 }, stuck = false) => {
    const world = emptyWorld();
    const d = direct(b.look(), world, at);
    const walks: string[] = [];
    const said: string[] = [];
    d.ctx.progress = l => { said.push(l); };
    d.ctx.call = (async (method: string, p: Record<string, unknown> = {}) => {
      if (method !== 'goto') return {};
      walks.push(`goto ${p.x},${p.y},${p.z}${p.careful ? ' careful' : ''}${p.xz ? ' xz' : ''}`);
      if (stuck) return { arrived: false };
      d.pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      return { arrived: true };
    }) as GoalContext['call'];
    d.ctx.act = async tool => {
      d.acts.push(tool);
      if (tool !== 'go-home') return { ok: true, text: 'ok' };
      if (d.pos.y < HOME.y - 8) { d.pos = { x: 20, y: 10, z: 0 }; return { ok: false, text: 'Stopped 22 blocks from home after 1s' }; }
      d.pos = { ...HOME };
      return { ok: true, text: 'Home' };
    };
    return { d, walks, said, world };
  };
  const a = down();
  t.is(await b.goal(deep).run(a.d.ctx), '[iron] +5 raw_iron; back home');
  // up the way it came first, Baritone's own walk to the block it stood on (not walk-only, not "any height here"),
  // then home over the surface: never under the yard
  t.deepEqual(a.walks, ['goto 40,64,0']);
  t.deepEqual(a.d.acts, ['go-home']);
  t.deepEqual(a.d.pos, HOME);
  t.deepEqual(a.said, ['up where it went down, (40, 64, 0), before the walk home']);
  t.like(workOf(a.world).deep, { clean: 1 });
  t.is(workOf(a.world).deep.away, undefined);
  // up there already (the trip never got far from its shaft's top): straight home
  const top = down({ x: 41, y: 64, z: 1 });
  t.is(await b.goal(deep).run(top.d.ctx), '[iron] +5 raw_iron; back home');
  t.deepEqual(top.walks, []);
  // the way back not found (the start gone, a build in the way): go-home as before, which says where it stopped
  const lost = down(undefined, true);
  await t.throwsAsync(b.goal(deep).run(lost.d.ctx), { message: '[iron] +5 raw_iron, but could not get home: Stopped 22 blocks from home after 1s' });
  t.deepEqual(lost.walks, ['goto 40,64,0']);
  // the walk up cut short (the shelter at dusk): its marks are written, and the trip stays open until the bot is home
  const cut = down();
  cut.d.ctx.call = (async () => { cut.d.abort(); throw new Error('aborted'); }) as GoalContext['call'];
  await t.throwsAsync(b.goal(deep).run(cut.d.ctx), { message: 'aborted' });
  t.is(cut.said.at(-1), '[iron] +5 raw_iron; stopped on the walk home (its marks are written)');
  t.deepEqual(cut.d.acts, []);
  t.not(workOf(cut.world).deep.away, undefined);
});

test('out of the yard by a gate: careful to the block 2 inside it and the one 2 outside, each on its own floor; nothing to do from outside, or with no gate known', async (t) => {
  // a yard 33 across round home (0, 64, 0), its ground at 63, the west gate at (-16, 64, 0); outside it the ground
  // rises 3 (as outside the live yard's west gate)
  const world = emptyWorld({ yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 }, zones: { 'fence:gate': [{ x: -16, y: 64, z: 0 }] } });
  const ground = (x: number) => (x < -16 ? 66 : 63);
  const walk = (from: Pos) => {
    const d = direct(snap(), world, from);
    const gotos: Record<string, unknown>[] = [];
    d.ctx.call = (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'world.region') return { blocks: Array.from({ length: Number(p.height) }, (_, i) => (Number(p.y) + i <= ground(Number(p.x)) ? 'stone' : 'air')) };
      if (method === 'goto') { gotos.push(p); d.pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) }; return { arrived: true }; }
      return {};
    }) as GoalContext['call'];
    return { d, gotos };
  };
  const a = walk(HOME);
  t.deepEqual(await outByGate(a.d.ctx, { x: -60, z: 0 }), { gate: { x: -16, y: 64, z: 0 }, at: { x: -18, y: 67, z: 0 } });
  // (to within 1 of each: a block on the ground still, and a bot on a path or in a plant there is there)
  t.deepEqual(a.gotos.map(p => [p.x, p.y, p.z, p.range, p.careful, p.xz]), [[-14, 64, 0, 1, true, undefined], [-18, 67, 0, 1, true, undefined]]);
  // already outside the fence, or on its way to somewhere inside it: no walk
  const b = walk({ x: -30, y: 67, z: 0 });
  t.deepEqual(await outByGate(b.d.ctx, { x: -60, z: 0 }), {});
  const c = walk(HOME);
  t.deepEqual(await outByGate(c.d.ctx, { x: 10, z: 10 }), {});
  t.deepEqual([...b.gotos, ...c.gotos], []);
  // no gate known: nothing it can do (the walk goes as it did)
  const none = direct(snap(), emptyWorld({ yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 } }));
  t.deepEqual(await outByGate(none.ctx, { x: -60, z: 0 }), {});
});

test('out of the yard by a gate: left in the gateway is not out (the next gate); only the sides asked for; a path or a plant at a gate\'s cell is no shut gate', async (t) => {
  // the yard round home (0, 64, 0), its ground at 63, gates west (-16, 64, 0) and north (0, 64, -16), flat ground
  const gates = [{ x: -16, y: 64, z: 0 }, { x: 0, y: 64, z: -16 }];
  const world = emptyWorld({ yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 }, zones: { 'fence:gate': gates.map(g => ({ ...g })) } });
  /**
   * The bridge's goto over that ground (`floor` at 63, `plant` over it): Baritone walks there, and the bot's block is
   * the one its feet are in, 64, or the path's own on a dirt path (its top is under a full block); arrived as
   * Handlers.java says it (within `range` of the block, the block itself for range 0). `gateway`: the walk to the
   * cell outside the west gate stops in the gateway.
   */
  const walk = (opts: { gateway?: boolean; floor?: string; plant?: string } = {}) => {
    const d = direct(snap(), world, HOME);
    const gotos: string[] = [];
    const said: string[] = [];
    d.ctx.progress = l => { said.push(l); };
    const block = (y: number) => (y < 63 ? 'stone' : y === 63 ? opts.floor ?? 'grass_block' : y === 64 ? opts.plant ?? 'air' : 'air');
    d.ctx.call = (async (method: string, p: Record<string, unknown> = {}) => {
      if (method === 'world.region') return { blocks: Array.from({ length: Number(p.height) }, (_, i) => block(Number(p.y) + i)) };
      if (method !== 'goto') return {};
      const to = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      gotos.push(`${to.x},${to.y},${to.z}`);
      if (opts.gateway && to.x === -18) { d.pos = { x: -15.5, y: 64, z: 0.5 }; return { arrived: false }; }
      d.pos = { ...to, y: opts.floor === 'dirt_path' ? 63 : 64 };
      const away = Math.hypot(d.pos.x - to.x, d.pos.y - to.y, d.pos.z - to.z);
      return { arrived: Number(p.range) <= 0 ? away === 0 : away <= Number(p.range) + 0.01 };
    }) as GoalContext['call'];
    return { d, gotos, said };
  };
  // the walk through the west gate got to the cell inside it and not on: the bot stands in the gateway, on the fence
  // line. Not out: a walk to "any height" from there is the one the gate keeps it from. The next gate, the north
  const a = walk({ gateway: true });
  t.deepEqual(await outByGate(a.d.ctx, { x: -60, z: 0 }), { gate: { x: 0, y: 64, z: -16 }, at: { x: 0, y: 64, z: -18 } });
  t.deepEqual(a.gotos, ['-14,64,0', '-18,64,0', '0,64,-14', '0,64,-18']);
  t.deepEqual(a.said, ['out of the yard by its west gate (-16, 64, 0)', 'out of the yard by its north gate (0, 64, -16)']);
  // only the west side's gate asked for (a side walk west): no other gate, and shut
  const b = walk({ gateway: true });
  t.deepEqual(await outByGate(b.d.ctx, { x: -60, z: 0 }, ['west']), { shut: 'no way out of the yard by the west gate (-16, 64, 0)' });
  t.deepEqual(b.gotos, ['-14,64,0', '-18,64,0']);
  // a side with no gate in its fence: shut, and no walk
  const c = walk();
  t.deepEqual(await outByGate(c.d.ctx, { x: 0, z: 60 }, ['south']), { shut: 'no gate in the yard\'s south fence' });
  t.deepEqual(c.gotos, []);
  // a dirt path laid up to the gates: the bot on it is a block under the cell over it, and there all the same
  const path = walk({ floor: 'dirt_path' });
  t.deepEqual(await outByGate(path.d.ctx, { x: -60, z: 0 }), { gate: { x: -16, y: 64, z: 0 }, at: { x: -18, y: 63, z: 0 } });
  t.deepEqual(path.gotos, ['-14,64,0', '-18,64,0']);
  // pink petals over the grass (floorAt does not know them for a plant): it takes them for the floor, and the cell
  // over them is 1 above where the bot stands in them
  const petals = walk({ plant: 'pink_petals[facing=north,flower_amount=4]' });
  t.deepEqual(await outByGate(petals.d.ctx, { x: -60, z: 0 }), { gate: { x: -16, y: 64, z: 0 }, at: { x: -18, y: 64, z: 0 } });
  t.deepEqual(petals.gotos, ['-14,65,0', '-18,65,0']);
});

test('a side whose stops all fall in the yard or its margin is looked along from the first place past the margin; with the yard and its margin out to the leash, from home alone', async (t) => {
  // home (0, 64, 0); the yard's north fence `z1`, the bridge's margin 6 past it; no gate known (the walk goes straight)
  const along = async (z1: number, leash = 96) => {
    const world = emptyWorld({ leash, yard: { x1: -16, z1, x2: 16, z2: 16, y: 63 } });
    const d = direct(snap(), world);
    const gotos: string[] = [];
    let looks = 0;
    d.ctx.call = (async (method: string, p: Record<string, unknown> = {}) => {
      if (method !== 'goto') return {};
      gotos.push(`${p.x},${p.z}`);
      d.pos = { x: Number(p.x), y: 64, z: Number(p.z) };
      return { arrived: true };
    }) as GoalContext['call'];
    const r = await alongSide(d.ctx, 'north', 'wild cows', async () => { looks++; return undefined; });
    return { r, gotos, looks };
  };
  // the yard's fence 64 out, as the live one: 32 and 64 out left out, 80 out (16 past) the stop, as ever
  t.deepEqual((await along(-64)).gotos, ['0,-80']);
  // the yard grown out to 76: 80 out is 4 past its fence, in the margin. Not written off from a look at home: the
  // first place past the margin, 83 out, within the leash
  const grown = await along(-76);
  t.deepEqual(grown.r, { text: 'no wild cows north within the leash (96 from home)' });
  t.deepEqual(grown.gotos, ['0,-83']);
  t.is(grown.looks, 2);
  // a shorter leash, 80: the last stop is 64 out, the fence itself; 71 out instead
  t.deepEqual((await along(-64, 80)).gotos, ['0,-71']);
  // the yard and its margin out past the leash that way: nothing wild that way within it, and no walk
  const all = await along(-92);
  t.deepEqual(all.r, { text: 'no wild cows north within the leash (96 from home)' });
  t.deepEqual([all.gotos, all.looks], [[], 1]);
});

test.serial('a run cut short under the yard marks its variant and the queue goes another way next; one that ends there too; cut short anywhere else, none', async (t) => {
  // live on Nov 13 the cows' north side went under the yard three times in 20 min: each run cut short there by out
  // from under wrote "no mark", and the same side was chosen again at once. Home (0, 64, 0), no yard: the column of
  // 24 and 6 round it, at any depth
  const cows = stub('cows', 2, 'far', [['north', 96], ['east', 96]]);
  const b = bench([cows]);
  const run = async (world: WorldMemory, to: Pos, abort = true) => {
    const d = direct(b.look(), world);
    const said: string[] = [];
    d.ctx.progress = l => { said.push(l); };
    // the walk takes the bot there, and (abort) the brain gives the run up: its next call fails
    cows.body = async () => { d.pos = { ...to }; if (abort) { d.abort(); throw new Error('aborted'); } };
    const text = await b.goal(cows).run(d.ctx).catch((e: Error) => e.message);
    return { text, said };
  };
  const world = emptyWorld();
  const north = await run(world, { x: 13, y: 21, z: -28 });
  t.is(north.text, 'aborted');
  t.deepEqual(north.said, ['[north] stopped before its end, nothing brought in yet (under the yard: went under the yard on the way: a mark, another way next)']);
  t.deepEqual(workOf(world).dry['cows:north'], { n: 1, at: T0 });
  t.is(dryUntil(world, 'cows:north'), T0 + DRY_WAIT[0]);
  t.is(workOf(world).next.cows, 1);
  t.like(pick(cows, b.look(), world), { variant: 'east' });
  // north again once its mark is up, and under the yard again: still a first mark's wait, not a longer one
  b.at.now += DRY_WAIT[0] + MINUTE;
  workOf(world).next.cows = 0;
  await run(world, { x: 13, y: 21, z: -28 });
  t.deepEqual(workOf(world).dry['cows:north'], { n: 1, at: b.at.now });
  // a run that ends under the yard (it brought one in on the way) is marked as well: under there no walk home goes
  const ended = emptyWorld();
  cows.gains = [1];
  const r = await run(ended, { x: 13, y: 21, z: -28 }, false);
  t.is(r.text, '[north] +1 things; under the yard: out from under first');
  t.deepEqual(workOf(ended).dry['cows:north'], { n: 1, at: b.at.now });
  t.is(workOf(ended).next.cows, 1);
  // cut short on the surface 30 out (a home round, the LLM, the shelter): nothing learnt, no mark, as ever
  const surface = emptyWorld();
  const s = await run(surface, { x: 30, y: 64, z: 0 });
  t.deepEqual(s.said, ['[north] stopped before its end, nothing brought in yet (no mark written)']);
  t.deepEqual(workOf(surface).dry, {});
  t.false('cows' in workOf(surface).next);
});

test.serial('a run that goes under the yard leaves its mark\'s count as it was, and a try let go early that went under is not let go again', async (t) => {
  // a run under the yard, cut short there by out from under (home (0, 64, 0), no yard: the column of 24 and 6 round it)
  const under = async (b: ReturnType<typeof bench>, task: Stub, world: WorldMemory) => {
    const d = direct(b.look(), world);
    task.body = async () => { d.pos = { x: 13, y: 21, z: -28 }; d.abort(); throw new Error('aborted'); };
    await t.throwsAsync(b.goal(task).run(d.ctx), { message: 'aborted' });
  };
  // a terrain side dry five times (it waited 320 min), tried once that was up, goes under: it waits its 320 min
  // again, not a first mark's 20 (and its next dry run is the sixth)
  const cows = stub('cows', 2, 'far', [['north', 96], ['east', 96]], { terrain: true });
  const b = bench([cows]);
  const world = emptyWorld();
  workOf(world).dry['cows:north'] = { n: 5, at: T0 - 330 * MINUTE };
  await under(b, cows, world);
  t.deepEqual(workOf(world).dry['cows:north'], { n: 5, at: T0 });
  t.is(dryUntil(world, 'cows:north', [cows]) - T0, 320 * MINUTE);
  // a surface rung's mark let go early by the idle release; its try goes under: that wait is sat out in full, as
  // after a try that came back dry (one early try per wait), not let go again after the next half minute
  const coal = stub('surface', 4, 'near', [['coal', 20]]);
  const c = bench([coal]);
  const w2 = emptyWorld();
  markDry(w2, 'surface:coal', T0 - 5 * MINUTE);
  t.is(releaseOldestDry(w2, T0, c.look(), [coal]), 'surface:coal');
  await under(c, coal, w2);
  t.deepEqual(workOf(w2).dry['surface:coal'], { n: 1, at: T0, freed: true });
  t.is(releaseOldestDry(w2, T0 + MINUTE, c.look({ now: T0 + MINUTE }), [coal]), undefined);
  t.is(dryUntil(w2, 'surface:coal', [coal]), T0 + DRY_WAIT[0]);
  // once that wait is up and it goes under again: a mark like any other, which may be let go early once
  c.at.now = T0 + DRY_WAIT[0] + MINUTE;
  await under(c, coal, w2);
  t.deepEqual(workOf(w2).dry['surface:coal'], { n: 1, at: c.at.now });
  t.is(releaseOldestDry(w2, c.at.now + MINUTE, c.look({ now: c.at.now + MINUTE }), [coal]), 'surface:coal');
});

test.serial('through the brain: out from under cuts the cows run under the yard, the cut is marked, and the next run goes east', async (t) => {
  const want: Record<string, string> = {};
  const state = atHome();
  // out from under by its name and urgency: it wants under the yard (the column of 24 and 6 round home, 8 down), and
  // its run brings the bot up past the margin
  const under = (p: Pos) => Math.abs(p.x) <= 30 && Math.abs(p.z) <= 30 && p.y < HOME.y - 8;
  const outFromUnder: Goal = {
    name: 'out from under', priority: 93, wants: () => (under(state.pos) ? '43 under the yard\'s ground' : want['out from under'] ?? null),
    run: async () => { state.pos = { x: 33, y: 64, z: 0 }; return 'climbed to (33, 64, 0)'; }, timeoutMs: 60_000, retryMs: 20_000
  };
  const cows = stub('cows', 2, 'far', [['north', 96], ['east', 96]]);
  cows.body = async (ctx, variant) => {
    // north: down a cave under the lawn on the walk out (live: (-536, 21, 2155)), and on walking down there
    if (variant === 'north') { state.pos = { x: 13, y: 21, z: -28 }; await ctx.act('slow'); }
  };
  // (the look after the cut goes through the bridge, which refuses the given-up run's own calls)
  const b = brainOf(state, [cows], [outFromUnder], undefined, { strict: true });
  await b.tick(5000);
  await b.tick(5000);
  t.deepEqual(b.said().filter(l => /^(start|stopping|work: cows: \[)/.test(l)).slice(0, 4), [
    'start work: cows: north: 96 blocks out',
    'stopping work: cows: out from under is more urgent (43 under the yard\'s ground)',
    'work: cows: [north] stopped before its end, nothing brought in yet (under the yard: went under the yard on the way: a mark, another way next)',
    'start out from under: 43 under the yard\'s ground'
  ]);
  t.like(queue(b.brain).dry['cows:north'], { n: 1 });
  // up and home again: the cows rung goes east, not north at once
  state.pos = { ...HOME };
  await b.tick(5000);
  await b.tick(5000);
  t.true(b.said().some(l => l.startsWith('start work: cows: east')), b.said().join('\n'));
  t.deepEqual(cows.ran.map(r => r.variant), ['north', 'east']);
  await b.off();
});

test.serial('out.work and out.trip are false again after a run that throws, is pre-empted or times out; none of them books a dry mark', async (t) => {
  const left = (b: ReturnType<typeof brainOf>) => ({ out: { ...out }, dry: queue(b.brain).dry, last: queue(b.brain).last });
  const nothing = { out: { trip: false, work: false }, dry: {}, last: undefined };
  /** a trip that walks 30 blocks out and stays there until the brain stops it */
  const waiting = () => {
    const state = atHome();
    const far = stub('far', 5, 'far');
    far.body = async (ctx) => { state.pos = { x: 30, y: 64, z: 0 }; await ctx.act('slow'); };
    return brainOf(state, [far]);
  };

  // it throws: a failure for the brain to hold, as any goal's
  const broken = stub('far', 5, 'far');
  broken.body = async () => { t.deepEqual(out, { trip: true, work: true }); throw new Error('boom'); };
  const one = brainOf(atHome(), [broken]);
  await one.tick();
  t.deepEqual(one.said().slice(-2), ['start work: far: only: 20 blocks out', 'failed work: far: boom']);
  t.is(statusLine(one.brain, 'Retrying later:'), 'Retrying later: work: far 300s.');
  t.deepEqual(left(one), nothing);
  await one.off();

  // the LLM takes the bot
  const two = waiting();
  await two.tick();
  t.deepEqual(out, { trip: true, work: true });
  await two.brain.manual('dig-block');
  await settle();
  // (a run stopped at its work says what it had brought in: its own line is never logged)
  t.deepEqual(two.said().slice(-3), ['stopping work: far: the LLM took over (dig-block)', 'work: far: [only] stopped before its end, nothing brought in yet (no mark written)',
    'stopped work: far: aborted: the brain gave this job up']);
  t.deepEqual(left(two), nothing);
  await two.off();

  // it runs out of time: the task's budget of 2 min and 2 more
  const three = waiting();
  await three.tick();
  await three.tick(4 * MINUTE);
  t.deepEqual(out, { trip: true, work: true });
  t.is(statusLine(three.brain, 'Now:'), 'Now: work: far (only: 20 blocks out) for 240s.');
  await three.tick(1000);
  t.deepEqual(three.said().slice(-3), ['stopping work: far: work: far ran out of time', 'work: far: [only] stopped before its end, nothing brought in yet (no mark written)',
    'stopped work: far: aborted: the brain gave this job up']);
  t.is(statusLine(three.brain, 'Retrying later:'), 'Retrying later: work: far 300s.');
  t.deepEqual(left(three), nothing);
  await three.off();
});

test.serial('marks are written before the walk home, and the walk is the run\'s own time; a gains work task with no gain is booked empty', async (t) => {
  const trip = (gains: number[], walk: State['walk']) => {
    const state = atHome({ walk });
    const far = stub('far', 5, 'far');
    far.gains = gains;
    far.body = async () => { state.pos = { x: 30, y: 64, z: 0 }; };
    return brainOf(state, [far]);
  };
  const booked = (b: ReturnType<typeof brainOf>) => { const d = today(b.brain); return { workMs: d.workMs, idleMs: d.idleMs, emptyMs: d.emptyMs, by: d.by }; };

  // nothing found 30 blocks out, and the way home takes its time (the door of the storage house, say)
  const dry = trip([], 'held');
  await dry.tick();
  t.is(statusLine(dry.brain, 'Now:'), 'Now: work: far (only: 20 blocks out) for 0s.');
  t.deepEqual(queue(dry.brain).dry, { 'far:only': { n: 1, at: T0 } }, 'the bot is not home yet, and what the run found is written');
  t.deepEqual(queue(dry.brain).last, { task: 'far', variant: 'only', gain: 0, text: 'nothing found', at: T0 });
  t.deepEqual(out, { trip: true, work: true }, 'a trip until it is home');
  await dry.tick(10_000);
  await dry.tick(10_000);
  t.is(statusLine(dry.brain, 'Now:'), 'Now: work: far (only: 20 blocks out) for 20s.');
  dry.arrive();
  await settle();
  t.is(dry.said().at(-1), 'done work: far in 20s: [only] nothing found; back home');
  // the 20 s of the walk are the run's: busy to no gain, and no idle time away from home
  t.deepEqual(booked(dry), { workMs: 20_000, idleMs: 0, emptyMs: 20_000, by: {} });
  t.deepEqual(out, { trip: false, work: false });
  await dry.off();

  // it brought something in: the same walk is time well spent
  const fed = trip([3], 'held');
  await fed.tick();
  t.deepEqual(queue(fed.brain).dry, {});
  t.is(queue(fed.brain).last?.gain, 3);
  await fed.tick(10_000);
  await fed.tick(10_000);
  fed.arrive();
  await settle();
  // (a place that gave is gone back to at once: the last line is the next run's start)
  t.deepEqual(fed.said().slice(-2), ['done work: far in 20s: [only] +3 things; back home', 'start work: far: only: 20 blocks out']);
  t.deepEqual(booked(fed), { workMs: 20_000, idleMs: 0, emptyMs: 0, by: {} });
  await fed.off();

  // stopped on the way home (dusk: shelter walks it home itself): what the run brought in is said all the same. In the
  // seven-day replay a coal trip was cut so by the furnace check as it came near home, and the log had only
  // "stopped work: surface: aborted" of a trip that brought 14 coal
  const dusk = { on: false };
  const shelter: Goal = { name: 'shelter', priority: 80, wants: () => (dusk.on ? 'evening: head home before dark' : null), run: async () => 'walked home', timeoutMs: 60_000, retryMs: 1000 };
  const state = atHome({ walk: 'held' });
  const far = stub('far', 5, 'far');
  far.gains = [3];
  far.body = async () => { state.pos = { x: 30, y: 64, z: 0 }; };
  const cut = brainOf(state, [far], [shelter]);
  await cut.tick();
  dusk.on = true;
  await cut.tick(5000);
  t.deepEqual(cut.said().slice(1, 6), ['start work: far: only: 20 blocks out', 'stopping work: far: shelter is more urgent (evening: head home before dark)',
    'work: far: [only] +3 things; stopped on the walk home (its marks are written)', 'stopped work: far: aborted', 'start shelter: evening: head home before dark']);
  t.deepEqual([queue(cut.brain).last?.gain, queue(cut.brain).dry], [3, {}]);
  t.is(today(cut.brain).emptyMs, 0, 'the 5 s were well spent');
  await cut.off();

  // no way home: the run fails, and what it found of the place stands all the same
  const lost = trip([], 'fails');
  await lost.tick();
  t.is(lost.said().at(-1), 'failed work: far: [only] nothing found, but could not get home: No path home');
  t.deepEqual(queue(lost.brain).dry, { 'far:only': { n: 1, at: T0 } });
  t.deepEqual(out, { trip: false, work: false });
  await lost.off();
});

test.serial('stash and work do not ping-pong: a work run the stash keeps cutting into, with something in the pockets each time, is no loop', async (t) => {
  /** a full-pockets stash that asks when the test says so, and a yard rung that works until it is stopped */
  const yard = (gain: number) => {
    const p = { full: false };
    const stash: Goal = { name: 'stash', priority: 60, wants: () => (p.full ? '36/36 slots used' : null), run: async () => { p.full = false; return 'put 64 away'; }, timeoutMs: 60_000, retryMs: 1000 };
    const chop = stub('chop', 7, 'yard');
    chop.body = async (ctx) => { if (gain) ctx.gain(gain); await ctx.act('slow'); };
    const b = brainOf(atHome(), [chop], [stash]);
    /** the rung starts, fills the pockets, and the stash cuts in and empties them; what the brain said after that */
    const round = async () => {
      await b.tick(5000);
      t.is(statusLine(b.brain, 'Now:'), 'Now: work: chop (only: in the yard) for 0s.');
      p.full = true;
      const before = b.said().length;
      await b.tick(5000);
      const lines = b.said().slice(before);
      // (what the run had brought in is said as it is stopped: the logs, kept on abort)
      t.deepEqual(lines.slice(0, 5), ['stopping work: chop: stash is more urgent (36/36 slots used)',
        `work: chop: [only] stopped before its end, ${gain ? `${gain} brought in` : 'nothing brought in yet'} (no mark written)`,
        'stopped work: chop: aborted: the brain gave this job up', 'start stash: 36/36 slots used', 'done stash in 0s: put 64 away']);
      return lines.slice(5);
    };
    return { ...b, round };
  };

  // four rounds, 4 logs into the pockets each time: the day's work, with the stash in between as it should be
  const b = yard(4);
  for (let i = 0; i < 4; i++) t.deepEqual(await b.round(), []);
  t.deepEqual(b.said().filter(l => l.startsWith('LOOP')), []);
  t.is(statusLine(b.brain, 'Loops in the last hour'), undefined);
  t.is(statusLine(b.brain, 'Retrying later:'), undefined);
  await b.tick(5000);
  t.is(b.said().at(-1), 'start work: chop: only: in the yard', 'and it goes on');
  t.is(today(b.brain).emptyMs, 0, 'cut short with gain is time well spent');
  await b.off();

  // the same turns with nothing brought in: the rung never gets anywhere, and that is a loop still
  const c = yard(0);
  t.deepEqual(await c.round(), []);
  t.deepEqual(await c.round(), []);
  const turn = 'work: chop stopped after 5s (stash is more urgent (36/36 slots used)); stash done after 0s (put 64 away)';
  t.deepEqual(await c.round(), [`LOOP (ping-pong): work: chop and stash took turns 3 times in 25s (work: chop never got anywhere): ${turn}; ${turn}; work: chop backed off for 10 min`]);
  t.is(statusLine(c.brain, 'Retrying later:'), 'Retrying later: work: chop 600s.');
  // every second of it busy to no gain (a run is booked from the look before the one it starts on: 5 s, 10 s, 10 s)
  t.deepEqual([today(c.brain).emptyMs, today(c.brain).workMs, today(c.brain).idleMs], [25_000, 25_000, 0]);
  await c.off();
});

test.serial('a work goal that keeps gaining is not held as a loop; one that keeps coming back with the same nothing still is', async (t) => {
  // five places 20 blocks out, all bare: four quick runs with the same nothing are a loop, whatever the place is called
  const bare = stub('scout', 5, 'near', [['1', 20], ['2', 20], ['3', 20], ['4', 20], ['5', 20]]);
  const b = brainOf(atHome(), [bare]);
  await b.tick();
  for (let i = 0; i < 3; i++) await b.tick(1000);
  t.deepEqual(bare.ran.map(r => r.variant), ['1', '2', '3', '4']);
  t.deepEqual(b.said().slice(-2), ['done work: scout in 0s: [4] nothing found',
    'LOOP (spinning): work: scout ran 4 times in 3s with the same result: done ([4] nothing found); work: scout backed off for 10 min']);
  t.is(statusLine(b.brain, 'Retrying later:'), 'Retrying later: work: scout 600s.');
  await b.off();

  // the same quick runs, each with something in hand: that is the bot working
  const rich = stub('scout', 5, 'near', [['1', 20], ['2', 20]]);
  rich.gains = [1, 1, 1, 1, 1, 1];
  const c = brainOf(atHome(), [rich]);
  await c.tick();
  for (let i = 0; i < 5; i++) await c.tick(1000);
  t.deepEqual(rich.ran.map(r => r.variant), ['1', '1', '1', '1', '1', '1'], 'the place that gives is gone back to');
  t.is(c.said().at(-1), 'done work: scout in 0s: [1] +1 things');
  t.deepEqual(c.said().filter(l => l.startsWith('LOOP')), []);
  t.is(statusLine(c.brain, 'Retrying later:'), undefined);
  await c.off();
});

test.serial('30 s of dry idle frees the oldest mark once; stage 1 and morning free none', async (t) => {
  // two cane banks and a look at the land to the east: all three come back with nothing in the first seconds
  const cane = stub('cane', 5, 'near', [['south', 20], ['north', 30]]);
  const scout = stub('scout', 6, 'near', [['east', 20]], { terrain: true });
  const state = atHome();
  const b = brainOf(state, [cane, scout]);
  await b.tick();
  await b.tick(1000);
  await b.tick(1000);
  t.deepEqual(queue(b.brain).dry, { 'cane:south': { n: 1, at: T0 }, 'cane:north': { n: 1, at: T0 + 1000 }, 'scout:east': { n: 1, at: T0 + 2000 } });

  // the bot stands with nothing but dry marks between it and work
  await b.tick(5000);
  t.is(statusLine(b.brain, 'Now:'), 'Now: idle (dry): cane [south] until 14:20 (2 dry).');
  t.is(statusLine(b.brain, 'Blocked:'), 'Blocked: work: cane - dry south until 14:20 (2 dry) | work: scout - dry east until 14:20');
  t.is(statusLine(b.brain, 'Work queue:'),
    'Work queue: last scout [east] nothing found 0 min ago; tier 0; deep trips 0 in 24 h, on probation 0/3; dry: cane:south 20 min, cane:north 20 min, scout:east 20 min.');

  // three minutes and more of it (the idle watchdog lets go of the brain's holds at 3)
  for (let i = 0; i < 39; i++) await b.tick(5000);
  const said = b.said();
  // half a minute in, the oldest mark is let go and the bank looked at again; half a minute on, the next one. Each
  // once: back dry, they wait their whole, longer time. The land to the east is never asked again so soon
  t.deepEqual(said.filter(l => l.startsWith('idle 30s on dry marks')), ['idle 30s on dry marks: let go of cane:south', 'idle 30s on dry marks: let go of cane:north']);
  t.deepEqual(said.filter(l => l.startsWith('start work: ')), [
    'start work: cane: south: 20 blocks out', 'start work: cane: north: 30 blocks out', 'start work: scout: east: 20 blocks out',
    'start work: cane: south: 20 blocks out, let go early after 1 dry', 'start work: cane: north: 30 blocks out, let go early after 1 dry'
  ]);
  const marks = { 'cane:south': { n: 2, at: T0 + 32_000, freed: true }, 'cane:north': { n: 2, at: T0 + 62_000, freed: true }, 'scout:east': { n: 1, at: T0 + 2000 } };
  t.deepEqual(queue(b.brain).dry, marks);
  t.is(statusLine(b.brain, 'Now:'), 'Now: idle (dry): cane [south] until 14:40 (2 dry).');

  // the watchdog's first stage lets go of what the brain holds, not of what the places said
  t.true(said.includes('idle 3 min by day: let go of nothing (nothing was held)'));
  t.deepEqual(said.filter(l => l.startsWith('start ') && !l.startsWith('start work: ')), []);
  // and so does the morning: a bare bank is as bare the next day
  state.time = 23_700;
  await b.tick(5000);
  state.time = 400;
  await b.tick(5000);
  t.true(b.said().some(l => l.startsWith('day: idle ')), 'a new day began');
  t.deepEqual(queue(b.brain).dry, marks);
  t.is(b.said().filter(l => l.startsWith('start work: ')).length, 5);
  await b.off();
});

test.serial('30 s of idle with a rung waiting on its dry marks frees the oldest, whatever leads the idle time', async (t) => {
  // the afternoon: too late for the deep trip, the project blocked, and the coal trip came back with nothing. Each of
  // those outranks `dry` as the idle time's cause; the coal trip waits on its mark alone
  const deep = stub('deep', 5, 'deep', [['iron', 0]]);
  const surface = stub('surface', 6, 'far', [['coal', 96]]);
  const project: Goal = {
    name: 'project', priority: 39, wants: () => null, declines: () => ({ cause: 'project', text: 'short of 101 sugar_cane' }),
    run: async () => 'built', timeoutMs: 60_000, retryMs: 1000
  };
  const b = brainOf(atHome({ time: 6000 }), [deep, surface], [project]);
  await b.tick();
  t.deepEqual(queue(b.brain).dry, { 'surface:coal': { n: 1, at: T0 } });
  await b.tick(5000);
  t.is(statusLine(b.brain, 'Now:'), 'Now: idle (late): deep needs 3 min, 2.1 left.');
  for (let i = 0; i < 6; i++) await b.tick(5000);
  const said = b.said();
  t.deepEqual(said.filter(l => l.startsWith('idle 30s on dry marks')), ['idle 30s on dry marks: let go of surface:coal']);
  t.deepEqual(said.filter(l => l.startsWith('start work: ')), ['start work: surface: coal: 96 blocks out', 'start work: surface: coal: 96 blocks out, let go early after 1 dry']);
  await b.off();
});

test.serial('the home rounds do not wait on a trip the brain holds back', async (t) => {
  // the deep trip could go this morning, and the lights round waits for it; but it fails, and is held for 5 min
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), 'brain.json');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': emptyWorld({ lastDone: { lights: T0 - 21 * MINUTE } }) }));
  const deep = stub('deep', 5, 'deep', [['iron', 0]]);
  deep.body = async () => { throw new Error("every side of the yard has someone else's build by it"); };
  const lights: Goal = {
    name: 'lights', priority: 30, wants: (s, world) => (roundDue(s, world, 'lights', 20 * MINUTE, [deep]) ? 'daily round: dark spots in the yard' : null),
    run: async () => 'lit 3 spots', timeoutMs: 60_000, retryMs: 1000
  };
  const b = brainOf(atHome({ time: 2000 }), [deep], [lights], file);
  await b.tick();
  await b.tick(5000);
  t.deepEqual(b.said().slice(1), [
    'start work: deep: iron: under ground', "failed work: deep: every side of the yard has someone else's build by it",
    'start lights: daily round: dark spots in the yard', 'done lights in 0s: lit 3 spots'
  ]);
  await b.off();
});

test.serial('the brain says it as it goes: the skipped line under each start, the Work queue and Blocked lines in brain-status', async (t) => {
  const kit = stub('trip kit', 1, 'yard');
  kit.off.only = { cause: 'unneeded', text: 'kit ready' };
  const cows = stub('cows', 2, 'far', [['east', 50]]);
  const deep = stub('deep', 4, 'deep', [['iron', 0]]);
  deep.gains = [23];
  const b = brainOf(atHome({ items: KIT }), [kit, cows, deep]);
  t.is(statusLine(b.brain, 'Work queue:'), undefined, 'no world seen yet');

  await b.tick();
  t.deepEqual(b.said().slice(1), ['start work: cows: east: 50 blocks out', 'work: cows: skipped: trip kit (unneeded: kit ready)', 'done work: cows in 0s: [east] nothing found']);
  t.is(statusLine(b.brain, 'Work queue:'), 'Work queue: last cows [east] nothing found 0 min ago; tier 0; deep trips 0 in 24 h, on probation 0/3; dry: cows:east 20 min.');

  await b.tick(1000);
  t.deepEqual(b.said().slice(4), ['start work: deep: iron: under ground', 'work: deep: skipped: trip kit (unneeded: kit ready) | cows (dry: east until 14:20)', 'done work: deep in 0s: [iron] +23 things']);
  t.is(statusLine(b.brain, 'Work queue:'), 'Work queue: last deep [iron] +23 things 0 min ago; tier 0; deep trips 1 in 24 h, on probation 1/3; dry: cows:east 20 min.');

  // the vein gave, so the bot goes down again; this time for nothing, and that was the second trip of the hour
  await b.tick(1000);
  t.is(b.said().at(-1), 'done work: deep in 0s: [iron] nothing found');
  await b.tick(1000);
  t.is(deep.ran.length, 2);
  t.is(statusLine(b.brain, 'Now:'), 'Now: idle (hold): deep on probation: 2 trips this hour, next at 15:00.');
  t.is(statusLine(b.brain, 'Blocked:'), 'Blocked: deep on probation: 2 trips this hour, next at 15:00 | work: cows - dry east until 14:20');
  t.is(statusLine(b.brain, 'Work queue:'),
    'Work queue: last deep [iron] nothing found 0 min ago; tier 0; deep trips 2 in 24 h, on probation 2/3; dry: cows:east 20 min, deep:iron 20 min.');
  await b.off();
});

test.serial('the queue\'s housekeeping runs before the brain decides: a death holds the trips from that very tick, and a failure in it is noted once and stops nothing', async (t) => {
  // died 50 blocks out a minute ago, and back at home with nothing: the trip waits, the yard work does not
  const far = stub('far', 5, 'far');
  const tidy = stub('tidy', 7, 'yard');
  tidy.gains = [5];
  const state = atHome({ death: { at: { x: 50, y: 64, z: 0 }, time: T0 - MINUTE } });
  const b = brainOf(state, [far, tidy]);
  await b.tick();
  t.deepEqual(b.said().slice(1), [
    'work: died away from home: the trips wait for the kit, until 14:59 at the latest',
    'start work: tidy: only: in the yard',
    `work: tidy: skipped: far (kit: after a death: ${NO_KIT})`,
    'done work: tidy in 0s: [only] +5 things'
  ]);
  t.is(far.ran.length, 0);
  // the kit is on again
  state.items = KIT;
  await b.tick(1000);
  t.deepEqual(b.said().slice(5, 7), ['work: the kit is whole again after the death: the trips go on', 'start work: far: only: 20 blocks out']);
  await b.off();

  // the runtime cannot say of deaths: said once, and the rungs run all the same
  const yard = stub('tidy', 7, 'yard');
  yard.gains = [1, 1, 1];
  const c = brainOf(atHome({ noDeaths: 'the death log is gone' }), [yard]);
  await c.tick();
  await c.tick(1000);
  await c.tick(1000);
  t.deepEqual(c.said().filter(l => l.startsWith('idle log: ')), ['idle log: work failed (noted once): the death log is gone']);
  t.false(c.said().some(l => l.startsWith('tick failed')));
  t.is(yard.ran.length, 3);
  await c.off();
});

test.serial('a brain.json whose work memory is malformed: the brain makes it whole and the queue runs', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), 'brain.json');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': { landmarks: { chests: [], farmland: [] }, leash: 96, work: 'garbage' } }));
  const tidy = stub('tidy', 7, 'yard');
  const b = brainOf(atHome(), [tidy], [], file);
  await b.tick();
  t.deepEqual(b.said().slice(-2), ['start work: tidy: only: in the yard', 'done work: tidy in 0s: [only] nothing found']);
  t.false(b.said().some(l => l.startsWith('tick failed') || l.startsWith('idle log: ')));
  const whole: WorkMemory = {
    dry: { 'tidy:only': { n: 1, at: T0 } }, next: { tidy: 1 }, deep: { starts: [], deaths: [], clean: 0 }, tier: 0, sites: {}, pen: {}, land: '0,0,96',
    last: { task: 'tidy', variant: 'only', gain: 0, text: 'nothing found', at: T0 }
  };
  t.deepEqual(queue(b.brain), whole);
  // and so it is written
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>;
  t.deepEqual(saved['seed:1'].work, whole);
  await b.off();
});

// ---- the real rungs (worktasks.ts) ----

const rung = (name: string) => LADDER.find(task => task.name === name)!;
const CHEST1 = { x: 1, y: 64, z: 1 };
/** A home with one chest, looked into, holding `stored`. */
const stored = (items: Record<string, number>, over: Partial<WorldMemory> = {}): WorldMemory =>
  emptyWorld({ landmarks: { chests: [CHEST1], farmland: [] }, chestItems: { '1,64,1': { ...items } }, ...over });
/** Every deep family and the coal at their targets of tier 0. */
const FULL = { diamond: 16, raw_iron: 50, iron_ingot: 46, raw_gold: 32, redstone: 64, lapis_lazuli: 32, coal: 128 };
const kitted = (over: Partial<Snapshot> = {}) => snap({ ...carrying(KIT), ...over });

test('deep picks the family furthest below its target; a family at target is left out; all at target is stocked', (t) => {
  const deep = rung('deep');
  // 14 of 16 diamonds, 40 of 96 iron (raw and smelted, carried and stored), gold at its target, 10 redstone, 30 lapis
  const w = stored({ diamond: 14, raw_iron: 20, iron_ingot: 12, raw_gold: 20, gold_ingot: 12, redstone: 10, lapis_lazuli: 30 });
  const s = snap(carrying([...KIT, { slot: 4, name: 'raw_iron', count: 8 }]));
  t.deepEqual(deepShort(s, w), [{ family: 'redstone', want: 54 }, { family: 'iron', want: 56 }, { family: 'diamond', want: 2 }, { family: 'lapis', want: 2 }]);
  t.deepEqual(deep.variants(s, w).map(v => v.id), ['redstone', 'iron', 'diamond', 'lapis']);
  t.deepEqual(pick(deep, s, w), { variant: 'redstone', index: 0, dist: 0, why: 'under ground', demoted: false });
  t.is(WORK_STOCK.iron, 96);

  // every one at its target: nothing to go for until the targets step up
  t.deepEqual(pick(deep, s, stored(FULL)), { decline: { cause: 'stocked', text: 'every ore at its target (diamond 16, iron 96, gold 32, redstone 64, lapis 32)' } });
  // a chest not looked into yet: its totals are not trusted, whatever the others hold
  const unseen = stored(FULL, { landmarks: { chests: [CHEST1, { x: 2, y: 64, z: 1 }], farmland: [] } });
  t.deepEqual(pick(deep, s, unseen), { decline: { cause: 'unneeded', text: 'the chests are not all looked into yet' } });
  // the kit is the deep trip's own question, in its own words: hurt as health, the rest as kit
  t.deepEqual(pick(deep, snap(), w), { decline: { cause: 'kit', text: '0/20 ready food points, armour below iron, 0/16 torches, 0/32 blocks (deep needs the deep kit)' } });
  t.deepEqual(pick(deep, kitted({ health: 15 }), w), { decline: { cause: 'health', text: 'health 15, food 20 (deep needs 18 and 14)' } });
  // nothing to go for is said before full pockets: they keep nothing from running then. (Full, and the stash just
  // failed to make room: the room rule says no for ten minutes)
  const full = snap(carrying([...KIT, ...Array.from({ length: 32 }, (_, i) => ({ slot: 4 + i, name: 'dirt', count: 64 }))]));
  const failed = { lastDone: { 'no room: deep': T0 } };
  t.is(full.slotsUsed, 36);
  t.deepEqual(pick(deep, full, stored(FULL, failed)), { decline: { cause: 'stocked', text: 'every ore at its target (diamond 16, iron 96, gold 32, redstone 64, lapis 32)' } });
  t.deepEqual(pick(deep, full, stored({ diamond: 14 }, failed)),
    { decline: { cause: 'pockets', text: '36/36 slots, the stash made no room just now (deep needs 10 free)' } });
});

test('targets step up when all are met and reopen when stock is used', (t) => {
  const deep = rung('deep');
  const w = stored(FULL);
  const s = kitted();
  t.is(tierStep(s, w, 0), 'diamond 32, iron 192, gold 64, redstone 128, lapis 64');
  // the queue's housekeeping steps one tier a call, and says so
  t.deepEqual(workTick(s, w, () => undefined), ['work: every deep target met: tier 1 (diamond 32, iron 192, gold 64, redstone 128, lapis 64)']);
  t.is(workOf(w).tier, 1);
  t.deepEqual(workTick(s, w, () => undefined), [], 'tier 1 is not met: no second step');
  // every target doubled: each half way, in the order above
  t.deepEqual(deep.variants(s, w).map(v => v.id), ['diamond', 'iron', 'gold', 'redstone', 'lapis']);
  t.deepEqual(deepShort(s, w)[1], { family: 'iron', want: 96 });
  t.is(workLine(w, T0, LADDER), 'Work queue: no run yet; tier 1; deep trips 0 in 24 h, on probation 0/3.');

  // what is used reopens a target at once (a smith took 8 ingots for an anvil): no step, the rung goes for iron
  const used = stored({ ...FULL, iron_ingot: 38 });
  t.is(tierStep(s, used, 0), undefined);
  t.deepEqual(pick(deep, s, used), { variant: 'iron', index: 0, dist: 0, why: 'under ground', demoted: false });
  // and carried counts as much as stored: 8 ingots back in the pockets, every target met again
  t.like(pick(deep, kitted({ ...carrying([...KIT, { slot: 4, name: 'iron_ingot', count: 8 }]) }), used), { decline: { cause: 'stocked' } });
});

test('no tier step while a chest is not looked into', (t) => {
  const w = stored(FULL, { landmarks: { chests: [CHEST1, { x: 2, y: 64, z: 1 }], farmland: [] } });
  t.is(tierStep(kitted(), w, 0), undefined);
  t.deepEqual(workTick(kitted(), w, () => undefined), []);
  t.is(workOf(w).tier, 0);
  // looked into, and empty: now the totals are trusted, and they meet every target
  w.chestItems!['2,64,1'] = {};
  t.deepEqual(workTick(kitted(), w, () => undefined), ['work: every deep target met: tier 1 (diamond 32, iron 192, gold 64, redstone 128, lapis 64)']);
  // no chest at all: what is carried is all there is, and it meets nothing
  t.is(tierStep(kitted(), emptyWorld(), 0), undefined);
});

test.serial('surface coal: under 128 wants, at 128 is stocked, no coal found is a dry mark of 20 min', async (t) => {
  const surface = rung('surface');
  t.is(SURFACE_STOCK.coal, 128);
  const b = bench([surface]);
  const goal = b.goal(surface);
  // 100 coal in the chest and 20 carried; where it is is not known, so the day must leave a walk to the leash and back
  const w = stored({ ...FULL, coal: 100 });
  t.is(goal.wants(snap(carrying([...KIT, { slot: 4, name: 'coal', count: 20 }])), w), 'coal: 96 blocks out');
  // charcoal counts as coal: 128
  t.deepEqual(goal.declines!(snap(carrying([...KIT, { slot: 4, name: 'charcoal', count: 28 }])), w), { cause: 'stocked', text: 'coal 128 (keep 128)' });
  t.is(goal.wants(kitted({ timeOfDay: 8520 }), w), 'coal: 96 blocks out');
  t.deepEqual(goal.declines!(kitted({ timeOfDay: 8521 }), w), { cause: 'late', text: '2.1 min of daylight left (surface needs 2.1)' });
  // the chests not all looked into: their coal is not known
  t.deepEqual(goal.declines!(kitted(), stored(FULL, { landmarks: { chests: [CHEST1, { x: 2, y: 64, z: 1 }], farmland: [] } })),
    { cause: 'unneeded', text: 'the chests are not all looked into yet' });

  // a run that finds none: dry for 20 min, and back home it comes
  const { text, d } = await b.run(surface, w, carrying(KIT), { x: 60, y: 64, z: 0 });
  t.is(text, '[coal] nothing gained (ok); back home');
  t.deepEqual(d.acts, ['mine-blocks', 'go-home']);
  t.deepEqual(workOf(w).dry, { 'surface:coal': { n: 1, at: T0 } });
  t.deepEqual(goal.declines!(b.look(carrying(KIT)), w), { cause: 'dry', text: 'surface [coal] until 14:20', until: T0 + 20 * MINUTE });
  b.at.now += 20 * MINUTE + 1;
  t.is(goal.wants(b.look(carrying(KIT)), w), 'coal: 96 blocks out, 1 dry before');
});

/** The live kit (Nov 11): sixteen kinds carried, diamond armour and a shield worn. */
const LIVE = (): InventoryItem[] => ([
  ['diamond_pickaxe', 1], ['diamond_shovel', 1], ['diamond_sword', 1], ['diamond_hoe', 1], ['iron_pickaxe', 1], ['iron_pickaxe', 1], ['iron_axe', 1],
  ['torch', 19], ['bread', 62], ['apple', 64], ['cobblestone', 32], ['dirt', 64], ['rotten_flesh', 8], ['oak_sapling', 7], ['wheat_seeds', 32], ['bucket', 1]
] as const).map(([name, count], slot): InventoryItem => ({ slot, name, count }))
  .concat(['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'diamond_helmet', 'shield'].map((name, i) => ({ slot: 36 + i, name, count: 1 })));

/**
 * The trip kit's run on a stand-in game: one chest that `take-from-chest` takes from (the reply says what it holds,
 * as the tool's does), pockets that keep count, the bot `pos` out in the yard.
 */
function chestBot(items: InventoryItem[], chest: Record<string, number>, pos: Pos) {
  let inv = items.map(i => ({ ...i }));
  const world = stored(chest);
  const took: string[] = [];
  const free = () => { for (let slot = 0; slot < 36; slot++) if (!inv.some(i => i.slot === slot)) return slot; return -1; };
  const holds = () => `It holds: ${Object.entries(chest).filter(([, n]) => n > 0).map(([k, n]) => `${k} x${n}`).join(', ') || 'nothing'}.`;
  const ac = new AbortController();
  const ctx: GoalContext = {
    s: snap({ ...carrying(inv), position: { ...pos }, distHome: Math.hypot(pos.x, pos.z) }), world, signal: ac.signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: pos, dimension: 'overworld' }),
    call: (async (method: string) => (method === 'inventory' ? { items: inv.map(i => ({ ...i })) } : {})) as GoalContext['call'],
    act: async (tool, a = {}) => {
      if (tool === 'go-home') { pos = { ...HOME }; return { ok: true, text: 'Home' }; }
      if (tool !== 'take-from-chest') return { ok: false, text: `no ${tool} here` };
      const item = String(a.item);
      const n = Math.min(Number(a.count), chest[item] ?? 0);
      chest[item] = (chest[item] ?? 0) - n;
      took.push(`${n} ${item}`);
      for (let left = n; left > 0; left -= 64) inv.push({ slot: free(), name: item, count: Math.min(left, 64) });
      return { ok: true, text: `Took ${n} ${item} from the chest at (1, 64, 1). ${holds()}` };
    }
  };
  return { ctx, world, took, inv: () => inv };
}

test.serial('what trip kit takes, the stash keeps: the live kit short of torches, of blocks, of its armour', async (t) => {
  const kit = rung('trip kit');
  const [goal] = workGoals(() => undefined, [kit], () => T0);
  const yard = { x: 20, y: 64, z: 0 };
  const parts: [string, (items: InventoryItem[]) => InventoryItem[], Record<string, number>, string, string[]][] = [
    // the lights round took 15 torches, and the chests have some
    ['torches', items => items.map(i => (i.name === 'torch' ? { ...i, count: 4 } : i)), { torch: 40, cobblestone: 640 }, '[torches] took 12 torch; back home', ['torch']],
    // the climb out of the mine took the blocks: 10 cobblestone and no dirt left
    ['blocks', items => items.filter(i => i.name !== 'dirt').map(i => (i.name === 'cobblestone' ? { ...i, count: 10 } : i)), { torch: 40, cobblestone: 640 }, '[blocks] took 22 cobblestone; back home', ['cobblestone']],
    // a death took the armour; the chests hold the spare set
    ['armour', items => items.filter(i => !/_(boots|leggings|chestplate|helmet)$/.test(i.name)),
      { diamond_boots: 1, diamond_leggings: 1, diamond_chestplate: 1, diamond_helmet: 1 },
      '[armour] took 1 diamond_helmet; took 1 diamond_chestplate; took 1 diamond_leggings; took 1 diamond_boots; back home',
      ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']]
  ];
  for (const [part, wear, chest, said, kinds] of parts) {
    const b = chestBot(wear(LIVE()), chest, yard);
    t.is(goal.wants(b.ctx.s, b.world), `${part}: in the yard`, part);
    t.is(await goal.run(b.ctx), said, part);
    // the stash, at home after it: none of what was taken goes back in the chests or on the dump
    const after = snap({ ...carrying(b.inv()) });
    const plan = stashList(after, b.world, stashKeep(b.world));
    t.deepEqual([...plan.deposit, ...plan.drop].filter(e => kinds.includes(e.name)), [], `${part}: ${JSON.stringify(plan)}`);
    t.is(workOf(b.world).last?.gain, part === 'armour' ? 4 : part === 'torches' ? 12 : 22);
    t.deepEqual(workOf(b.world).dry, {});
  }
});

test.serial('trip kit sees its chest step through at home: the kit goal, which wants the same there, waits for it', async (t) => {
  // the live kit short of torches, 16 out by the bed; the chests hold no torches, only the coal and the sticks
  const chest: Record<string, number> = { coal: 74, stick: 378 };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), 'brain.json');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': stored(chest) }));
  const state = atHome({ pos: { x: 16, y: 64, z: 0 }, items: LIVE().map(i => (i.name === 'torch' ? { ...i, count: 4 } : i)) });
  const region = new Array<string>(25 * 11 * 25).fill('air');
  region[(CHEST1.x + 12) + (CHEST1.z + 12) * 25 + (CHEST1.y - 60) * 25 * 25] = 'chest[facing=south,type=single,waterlogged=false]';
  const free = () => { for (let slot = 0; slot < 36; slot++) if (!state.items.some(i => i.slot === slot)) return slot; return -1; };
  let open: (() => void) | undefined;
  let first = true;
  const b = brainOf(state, [rung('trip kit')], [kitGoal], file, {
    call: (method: string) => {
      if (method === 'world.region') return { blocks: region };
      if (method === 'cancel') open?.();
      return undefined;
    },
    actions: {
      // the chest tool walks to the chest first: home, in the kit goal's reach; the first take waits for the test
      'take-from-chest': async (a: Record<string, unknown>) => {
        state.pos = { x: 1, y: 64, z: 2 };
        if (first) { first = false; await new Promise<void>(r => { open = r; }); }
        const item = String(a.item);
        const n = Math.min(Number(a.count), chest[item] ?? 0);
        chest[item] -= n;
        state.items = [...state.items, { slot: free(), name: item, count: n }];
        return reply(`Took ${n} ${item} from the chest at (1, 64, 1). It holds: ${Object.entries(chest).map(([k, v]) => `${k} x${v}`).join(', ')}.`);
      },
      // a coal and a stick: four torches
      'craft-item': async (a: Record<string, unknown>) => {
        const times = Number(a.amount);
        state.items = state.items.map(i => (i.name === 'coal' || i.name === 'stick' ? { ...i, count: i.count - times } : i.name === 'torch' ? { ...i, count: i.count + 4 * times } : i))
          .filter(i => i.count > 0);
        return reply(`Crafted ${4 * times} torch`);
      }
    }
  });
  await b.tick();
  t.is(statusLine(b.brain, 'Now:')?.startsWith('Now: work: trip kit (torches: in the yard)'), true);
  // at the chests, within ten of home: the kit goal wants the torches too, and lets the run see to them
  await b.tick(5000);
  const there = snap({ ...carrying(state.items), now: b.at.clock, position: { ...state.pos }, distHome: Math.hypot(state.pos.x, state.pos.z) });
  t.is(kitGoal.wants(there, b.brain.worldMemory()!), 'needs torch (short)');
  open!();
  await settle();
  const said = b.said().filter(l => !l.startsWith('landmarks: '));
  t.deepEqual(said.filter(l => l.startsWith('stopping ') || l.startsWith('stopped ')), []);
  t.true(said.includes('done work: trip kit in 5s: [torches] crafted torch x3'), said.join('\n'));
  t.is(state.items.find(i => i.name === 'torch')?.count, 16);
  t.is(queue(b.brain).last?.gain, 12);
  await b.off();
});

test('trip kit: the parts of the deep kit the kit goal makes whole, from out in the yard where the kit goal does not go', (t) => {
  const kit = rung('trip kit');
  const yard = { position: { x: 20, y: 64, z: 0 }, distHome: 20 };
  const w = stored({ torch: 40 });
  // the kit whole: nothing to do
  t.deepEqual(pick(kit, snap({ ...carrying(LIVE()), ...yard }), w), { decline: { cause: 'unneeded', text: 'kit ready' } });
  const short = carrying(LIVE().map(i => (i.name === 'torch' ? { ...i, count: 4 } : i)));
  t.like(pick(kit, snap({ ...short, ...yard }), w), { variant: 'torches' });
  // at home the kit goal sees to it (it does the same, and outranks the rung)
  t.deepEqual(pick(kit, snap(short), w), { decline: { cause: 'unneeded', text: 'torches: the kit goal sees to them at home' } });
  // nothing in the chests to make them from: what is short is said
  t.deepEqual(pick(kit, snap({ ...short, ...yard }), stored({})), { decline: { cause: 'kit', text: 'torches: short of 1 log, 3 coal' } });
  // the ready food is the food goal's (by day it goes wherever the bot is), health and the food bar the Guardian's
  const hungry = carrying(LIVE().filter(i => i.name !== 'bread' && i.name !== 'apple'));
  t.deepEqual(pick(kit, snap({ ...hungry, ...yard }), w),
    { decline: { cause: 'unneeded', text: 'kit ready but for ready food 0 < 20 points (the food goal and the Guardian see to that)' } });
});

test.serial('surface coal keeps to the leash: 24 at most a run, the surface ore only, in rounds of 90 s that end beyond the leash or with the budget', async (t) => {
  const surface = rung('surface');
  const b = bench([surface]);
  const w = stored({ ...FULL, coal: 100 });
  /** each round brings `n` coal, takes its whole time on the clock and leaves the bot `to` blocks east of home; `fail` is the tool's error */
  const coalBot = (rounds: { n: number; to: number; fail?: string }[]) => {
    const d = direct(b.look(carrying(KIT)), w);
    let items = KIT.map(i => ({ ...i }));
    const asked: string[] = [];
    d.ctx = {
      ...d.ctx,
      act: async (tool, a = {}) => {
        if (tool === 'go-home') { d.pos = { ...HOME }; return { ok: true, text: 'Home' }; }
        asked.push(`${a.block} to ${a.count} in ${Number(a.timeoutMs) / 1000}s within ${a.maxFromHome}`);
        const r = rounds.shift() ?? { n: 0, to: d.pos.x };
        if (r.fail) return { ok: false, text: r.fail };
        b.at.now += Number(a.timeoutMs);
        if (r.n) items = [...items, { slot: 10 + asked.length, name: 'coal', count: r.n }];
        d.pos = { x: r.to, y: 64, z: 0 };
        return { ok: true, text: `Mined for ${Number(a.timeoutMs) / 1000}s: ${r.n ? `coal x${r.n}` : 'nothing gained'}.` };
      },
      call: (async (method: string) => (method === 'inventory' ? { items: items.map(i => ({ ...i })) } : {})) as GoalContext['call']
    };
    return { d, asked, run: () => b.goal(surface).run(d.ctx) };
  };

  // 28 short, 24 asked for; rounds of 90 s while the six minutes last, each told as it comes in
  const long = coalBot([{ n: 5, to: 40 }, { n: 5, to: 50 }, { n: 5, to: 60 }, { n: 5, to: 70 }]);
  t.is(await long.run(), '[coal] +20 coal; back home');
  t.deepEqual(long.asked, new Array<string>(4).fill('coal_ore to 24 in 90s within 96'));
  t.is(long.d.gain, 20);
  // a round that ends beyond the leash brings the run back (Baritone followed the vein out there)
  b.at.now += HOUR;
  const out = coalBot([{ n: 8, to: 100 }, { n: 8, to: 110 }]);
  t.is(await out.run(), '[coal] +8 coal; past the leash: back; back home');
  t.is(out.asked.length, 1);
  // the want met: no more rounds
  b.at.now += HOUR;
  const met = coalBot([{ n: 24, to: 40 }, { n: 8, to: 50 }]);
  t.is(await met.run(), '[coal] +24 coal; back home');
  t.is(met.asked.length, 1);
  t.deepEqual(workOf(w).dry, {});
  // no coal within the leash to walk out to: the tool says so, and that is a dry mark
  b.at.now += HOUR;
  const none = coalBot([{ n: 0, to: 0, fail: 'No coal_ore in sight outside the home area (12+ blocks past the yard, within 96 of home)' }]);
  t.is(await none.run(), '[coal] nothing gained (No coal_ore in sight outside the home area (12+ blocks past the yard, within 96 of home))');
  t.deepEqual(Object.keys(workOf(w).dry), ['surface:coal']);
});

test.serial('done work: deep and done work: surface say what came in, and the walk home', async (t) => {
  setMineLookMs(0);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), 'brain.json');
  // iron the one ore short of its target (73 of 96), the coal stocked
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': stored({ ...FULL, raw_iron: 27 }) }));
  const state = atHome({ items: [...KIT] });
  const asked: string[] = [];
  const mine = (add: string, n: number, to?: Pos) => async (a: Record<string, unknown>) => {
    asked.push(`${a.block} to ${a.count} in ${Number(a.timeoutMs) / 1000}s`);
    state.items = [...state.items, { slot: state.items.filter(i => i.slot < 36).length, name: add, count: n }];
    if (to) state.pos = { ...to };
    return reply(`Mined for 100s: ${add} x${n}.`);
  };
  // the brain looks round home for its landmarks first: the chest stands where the memory has it
  const region = new Array<string>(25 * 11 * 25).fill('air');
  region[(CHEST1.x + 12) + (CHEST1.z + 12) * 25 + (CHEST1.y - 60) * 25 * 25] = 'chest[facing=south,type=single,waterlogged=false]';
  const look = (method: string) => (method === 'world.region' ? { blocks: region } : method === 'foreign.zones' ? { zones: [] } : undefined);
  const extra = {
    actions: { 'mine-blocks': mine('raw_iron', 23) },
    call: (method: string, p?: Record<string, unknown>) => {
      if (method === 'goto') { state.pos = { x: Number(p?.x), y: 64, z: Number(p?.z) }; return { arrived: true }; }
      return look(method);
    }
  };
  const b = brainOf(state, LADDER, [], file, extra);
  await b.tick();
  t.deepEqual(b.said().filter(l => !l.startsWith('landmarks: ')).slice(1), [
    'start work: deep: iron: under ground',
    // (no cane to plant a patch with, no cow pen, and no project waiting on cane: the rungs above have nothing to do)
    'work: deep: skipped: cane patch (unneeded: no cane to plant) | cows (unneeded: no cow pen with a gate) | cane (unneeded: the project is not waiting on sugar_cane) | trip kit (unneeded: kit ready)',
    'work: deep: out to the mine at (0, -56)',
    'work: deep: mining iron for 23 more (180 s)',
    'work: deep: Mined for 100s: raw_iron x23.',
    'done work: deep in 0s: [iron] +23 raw_iron; back home'
  ]);
  t.deepEqual(asked, ['iron_ore,deepslate_iron_ore to 23 in 180s']);
  t.is(statusLine(b.brain, 'Work queue:'), 'Work queue: last deep [iron] +23 raw_iron 0 min ago; tier 0; deep trips 1 in 24 h, on probation 1/3.');
  await b.off();

  // the coal: the chests hold 100 of it, the kit has no armour (no trip down), and the mine tool walks it out of the
  // yard, to coal within the leash; the second round finds no more
  const file2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), 'brain.json');
  fs.writeFileSync(file2, JSON.stringify({ 'seed:1': stored({ ...FULL, coal: 100 }) }));
  const bare = atHome({ items: KIT.filter(i => i.slot < 36) });
  const c = brainOf(bare, LADDER, [], file2, {
    call: look,
    actions: {
      'mine-blocks': async (a: Record<string, unknown>) => {
        asked.push(`${a.block} to ${a.count} in ${Number(a.timeoutMs) / 1000}s within ${a.maxFromHome}`);
        if (bare.items.some(i => i.name === 'coal')) return reply('Mined for 5s: nothing gained.');
        bare.items = [...bare.items, { slot: 4, name: 'coal', count: 23 }];
        bare.pos = { x: 70, y: 64, z: 0 };
        return reply('Mined for 90s: coal x23.');
      }
    }
  });
  await c.tick();
  // (every ore at its target here: the housekeeping steps the tier before anything is decided)
  t.deepEqual(c.said().filter(l => !l.startsWith('landmarks: ')).slice(1), [
    'work: every deep target met: tier 1 (diamond 32, iron 192, gold 64, redstone 128, lapis 64)',
    'start work: surface: coal: 96 blocks out',
    // the stored ingots make the armour: at home that is the kit goal's to do
    'work: surface: skipped: cane patch (unneeded: no cane to plant) | cows (unneeded: no cow pen with a gate) | cane (unneeded: the project is not waiting on sugar_cane) | trip kit (unneeded: armour: the kit goal sees to them at home) | deep (kit: armour below iron (deep needs the deep kit))',
    'work: surface: mining coal_ore for up to 24 (90 s)',
    'work: surface: mining coal_ore for up to 1 (90 s)',
    'done work: surface in 0s: [coal] +23 coal; back home'
  ]);
  // up to what it carries of coal and the 24 a run asks for at most (28 are short), the surface ore only, in rounds
  // of 90 s of the six minutes the day leaves, from the yard to coal no further out than the leash
  t.deepEqual(asked.slice(-2), ['coal_ore to 24 in 90s within 96', 'coal_ore to 24 in 90s within 96']);
  await c.off();
});

test.serial('a deep trip that cannot reach its mine start is a failure the brain holds back: no setting out again at once, no loop', async (t) => {
  setMineLookMs(0);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-')), 'brain.json');
  // iron short, the probation over: nothing but the brain's own hold keeps the rung from going again
  const work: WorkMemory = { dry: {}, next: {}, sites: {}, pen: {}, tier: 0, deep: { starts: [], clean: 3, deaths: [] } };
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': stored({ ...FULL, raw_iron: 27 }, { work }) }));
  const state = atHome({ items: [...KIT] });
  const region = new Array<string>(25 * 11 * 25).fill('air');
  region[(CHEST1.x + 12) + (CHEST1.z + 12) * 25 + (CHEST1.y - 60) * 25 * 25] = 'chest[facing=south,type=single,waterlogged=false]';
  // the walk out stops short every time (the storage house door, or a start nothing finds a path to)
  const b = brainOf(state, LADDER, [], file, {
    call: (method: string) => (method === 'world.region' ? { blocks: region } : method === 'foreign.zones' ? { zones: [] } : method === 'goto' ? { arrived: false } : undefined)
  });
  await b.tick();
  // 5 s ticks through the rest of the morning's window (a deep trip sets out by 5000)
  for (let i = 0; i < 48; i++) { state.time += 100; await b.tick(5000); }
  t.is(state.time, 5800);
  const said = b.said();
  t.true(said.includes('failed work: deep: [iron] could not reach the mine start (0, -56)'));
  // once; once more when the hold is let go early after a minute of standing about; once more when 3 min idle by
  // day lets every hold go; then the morning's window is over. (As a plain end nothing held it: four starts in 15 s,
  // and a loop hold, which the maintenance runs read as a bug)
  t.is(said.filter(l => l.startsWith('start work: deep')).length, 3);
  t.is(said.filter(l => l.startsWith('failed work: deep')).length, 3);
  t.deepEqual(said.filter(l => l.startsWith('LOOP')), []);
  t.regex(statusLine(b.brain, 'Retrying later:') ?? '', /^Retrying later: work: deep \d+s\.$/);
  t.deepEqual(queue(b.brain).dry, {}, 'it learnt nothing of the place');
  t.is(queue(b.brain).deep.clean, 3, 'nor was it a trip that ended well');
  await b.off();
});

test('the real rungs only look: asked over hours, pockets, places and stock, the world is left as it was', (t) => {
  const worlds = () => [emptyWorld(), stored(FULL), stored({ diamond: 3, coal: 10, torch: 40 }), stored(FULL, { landmarks: { chests: [CHEST1, { x: 2, y: 64, z: 1 }], farmland: [] } }),
    stored({ coal: 5 }, { work: { dry: { 'deep:iron': { n: 2, at: T0 } }, next: { deep: 3 }, sites: {}, pen: {}, tier: 1, deep: { starts: [T0 - MINUTE, T0], clean: 1, deaths: [] } } })];
  const pockets = [[], KIT, LIVE(), LIVE().map(i => (i.name === 'torch' ? { ...i, count: 4 } : i)), [...KIT, ...Array.from({ length: 32 }, (_, i) => ({ slot: 4 + i, name: 'dirt', count: 64 }))]];
  let asked = 0;
  for (const w of worlds()) {
    const before = JSON.stringify(w);
    freeze(w);
    for (const timeOfDay of [0, 3000, 5000, 8000, 10_800, 12_000, 23_600]) for (const items of pockets) for (const x of [0, 20, 60]) {
      const s = snap({ ...carrying(items), timeOfDay, activity: activityAt(timeOfDay), position: { x, y: 64, z: 0 }, distHome: x });
      for (const task of LADDER) { pick(task, s, w); asked++; }
      roundDue(s, w, 'lights', 20 * MINUTE);
      tierStep(s, w, 0);
    }
    t.is(JSON.stringify(w), before);
  }
  t.is(asked, 5 * 7 * 5 * 3 * LADDER.length);
});
