/**
 * The work queue: what the bot does with a day that has no job in it. A ladder of tasks (worktasks.ts), each one goal
 * for the brain, each with variants (a side, an ore, a part of the kit). A variant that brought nothing in waits
 * before its next try and the next one has its turn, so a day never ends in one fruitless trip run over and over,
 * and never in standing about while a rung lower down could run.
 *
 * Who writes: the gates (`pick`, a task's `ready` and `variants`, the goals' wants / declines / urgency, `roundDue`)
 * only read: they are asked many times a tick. `world.work` is written in two places, the run wrapper and `workTick`,
 * and by `markDry` / `releaseOldestDry` / `addSite` / `dropSite` / `notePen`, which the tasks, the pens round and the
 * brain call.
 */
import { fromGate, nearHome, nearHomeAt, no, onHomeLevel, outsideBy, YARD_EDGE, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { NEAR_HOME, TRIP_STASH_RANGE, inYardOrNear, look, makeRoom, noRoom, out, room, type RoomKind } from './pockets.js';
import { WORK_AT, daylightLeft } from './schedule.js';
import { deepTripKit, tripBudgetMs } from './mine.js';
import { tripCheck } from './deep.js';
import { clock } from './idlelog.js';
import { LADDER, tierStep } from './worktasks.js';
import { ZONE_MARGIN, underYard } from './underyard.js';
import { brainRun } from '../tools.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** one game tick in real ms: budgets are in ms, times of day in ticks, and every sum that mixes them goes through here */
const MS_PER_TICK = 50;
const ticksToMs = (ticks: number) => ticks * MS_PER_TICK;
const msToTicks = (ms: number) => ms / MS_PER_TICK;

/** How far a task goes: about the yard, a short way out, to the leash, or down the mine. */
export type Reach = 'yard' | 'near' | 'far' | 'deep';
/**
 * What a run brought in (items, cells, animals: whatever the task counts) and what it has to say. `untried`: it never
 * got to the work (the place was not reached, or someone's build stood by it), so it says nothing of the place: no dry
 * mark, the same variant first next time, and a deep trip that never went down is no trip that ended well. Home, the
 * wrapper ends such a run as a failure, which the brain holds back. `mark`: what a run that brought nothing learnt of
 * its place, where that is not "nothing there": `first`, it holds what the task is after (a cow found there that did
 * not come in), so a first mark whatever the count before, or the sides where cows graze would wait ever longer;
 * `same`, it was not looked at to its end (the run's time ran out, the pen had its pair after all), so the count
 * stays as it was; `forget`, the place is forgotten (a stand gone, or someone's), so its mark goes and none is written.
 * `upAt`: a run down the mine that ends down there: the block it stood on at the surface where it went down, which
 * the walk home comes up by first (walkUp).
 */
export interface WorkResult { gain: number; text: string; untried?: true; mark?: 'first' | 'same' | 'forget'; upAt?: Pos }

export interface WorkTask {
  name: string;
  /** 1 is the top rung */
  rank: number;
  reach: Reach;
  room: RoomKind;
  budgetMs: number;
  /** its dry marks tell of the land, not of the hour: they go on doubling past 160 min */
  terrain?: true;
  /**
   * how far from home its variants go, across the ground, when that is not the leash (the cows: the user let them go
   * past it, Nov 13). Its terrain marks are kept to that range, and let go when it changes (workTick)
   */
  range?(world: WorldMemory): number;
  /**
   * blocks a second of the way back when the run brings its find home itself, slower than a walk (a cow on the
   * lead): the day it needs, its budget and its goal's timeout count the way back inside the run, at this pace
   */
  backPace?: number;
  /**
   * what it could do now, each with its distance from home in blocks; sync, reads only. `first`: a place known to hold
   * what the task is after (a stand of cane found before): tried ahead of the others whatever their turn, and its runs
   * do not move the turn on
   */
  variants(s: Snapshot, world: WorldMemory): { id: string; dist: number; first?: true }[];
  /** null = ready; sync, reads only, no calls */
  ready(s: Snapshot, world: WorldMemory, variant: string): Decline | null;
  /** what it says with no variant at all (default: `unneeded`, nothing to do) */
  none?(s: Snapshot, world: WorldMemory): Decline;
  /**
   * does one unit of work and stays where it ends: the wrapper books the marks and walks home. `now` is the clock the
   * wrapper books by, for a mark the task writes itself on the way (markDry): the run's look is from before it set out
   */
  run(ctx: GoalContext, variant: string, budgetMs: number, now: () => number): Promise<WorkResult>;
}

/**
 * A fruitless variant's mark: `n` dry runs in a row, the last at `at`. `early`: let go before its time (it may run
 * now). `freed`: the mark that followed such a run, which waits its whole time (one early try per wait, no more).
 */
export interface DryMark { n: number; at: number; early?: true; freed?: true }

/** Kept in brain.json per world. */
export interface WorkMemory {
  /** key `${task}:${variant}` */
  dry: Record<string, DryMark>;
  /** per task: the variant index to try first */
  next: Record<string, number>;
  /** per kind, the places found (4 each) */
  sites: Record<string, { x: number; y: number; z: number; dryAt?: number }[]>;
  /** per pen kind: what it held when the pens round or a fetch last looked into it (`at`: the brain's clock) */
  pen: Record<string, { adults: number; babies: number; at: number }>;
  /** how often every target was met: the targets double with each */
  tier: number;
  /**
   * `starts`: real times of the deep trips of the last 24 h; `clean`: trips ended with no death since the last one
   * that had one; `deaths`: real times of deaths during a deep trip (24 h); `kitHold`: the time of a death away from
   * home, while the trips wait for the kit to be whole again; `away`: when the last trip ended with the bot not seen
   * home (cut short down there, or on the walk back): a death until it is, is one on that trip
   */
  deep: { starts: number[]; clean: number; deaths: number[]; kitHold?: number; away?: number };
  /** today's trips (the day number of the idle tally): unblockers tried, deep trips made */
  farDay?: { day: number; unblockers: number; deep: number };
  last?: { task: string; variant: string; gain: number; text: string; at: number };
  /** the home and the leash the terrain marks were made under (`x,z,leash`): they tell of that land and no other */
  land?: string;
  /** per task with a range of its own (the cows), the range its terrain marks were made under, blocks */
  ranges?: Record<string, number>;
}

/** The wait after the 1st, 2nd, 3rd and every later dry run in a row. */
export const DRY_WAIT = [20, 40, 80, 160].map(m => m * MINUTE);
/** From this time of day the home rounds are due whatever else could run. */
export const EVENING_AT = 8000;
/** A trip under way is as urgent as the old deep trip: only survival and the day's end cut it short. */
export const TRIP_URGENCY = 58;
/** Deep trips are few until three in a row ended well. */
export const PROBATION = { clean: 3, perHour: 2 } as const;
/** The least time at the place that makes a run worth the walk, ms. */
export const MIN_WORK = { yard: 15_000, near: 20_000, far: 60_000 } as const;
/**
 * There and back at 3 blocks a second, and the least work: what a variant `dist` blocks out needs of the day, ms. A
 * run that brings its find home at a slower pace (`backPace`, blocks a second: a cow on the lead) is counted back at
 * that pace (to the whole ms).
 */
export const needMs = (dist: number, reach: Exclude<Reach, 'deep'>, backPace?: number): number =>
  (backPace ? Math.round(dist * 1000 / 3 + dist * 1000 / backPace) : 2 * dist / 3 * 1000) + MIN_WORK[reach];
/** the deep trip's walk back up, and the least mining worth going down for (as deep.ts has them) */
const DEEP_WALK_BACK = 2 * MINUTE;
const DEEP_WORTH = 3 * MINUTE;
/** a death this far from home (or outside the yard by more than its edge) is a death away */
const DEATH_AWAY = 32;
const KIT_HOLD_MS = HOUR;
/** A deep trip cut short out there is still the trip's until the bot is seen home, or this long (retreat's walk home is given 10 min). */
const AWAY_MS = 15 * MINUTE;
const STAMPS = 400;
const SITES = 4;

/** Counts every write to a work memory: `pick` remembers its answers per snapshot, and a write makes them stale. */
let writes = 0;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const stamps = (v: unknown): number[] => (Array.isArray(v) ? v.filter(fin).slice(-STAMPS) : []);

/** A work memory as it must be, from whatever brain.json held (nothing, or something an older build wrote). */
function clean(raw: unknown): WorkMemory {
  const r = isObj(raw) ? raw : {};
  const dry: WorkMemory['dry'] = {};
  for (const [k, v] of Object.entries(isObj(r.dry) ? r.dry : {})) {
    if (!isObj(v) || !fin(v.n) || v.n < 1 || !fin(v.at)) continue;
    dry[k] = { n: Math.floor(v.n), at: v.at, ...(v.early === true ? { early: true as const } : {}), ...(v.freed === true ? { freed: true as const } : {}) };
  }
  const next: WorkMemory['next'] = {};
  for (const [k, v] of Object.entries(isObj(r.next) ? r.next : {})) if (fin(v) && v >= 0) next[k] = Math.floor(v);
  const sites: WorkMemory['sites'] = {};
  for (const [k, v] of Object.entries(isObj(r.sites) ? r.sites : {})) {
    if (!Array.isArray(v)) continue;
    sites[k] = v.filter(isObj).filter(p => fin(p.x) && fin(p.y) && fin(p.z)).slice(0, SITES)
      .map(p => ({ x: p.x as number, y: p.y as number, z: p.z as number, ...(fin(p.dryAt) ? { dryAt: p.dryAt } : {}) }));
  }
  const pen: WorkMemory['pen'] = {};
  for (const [k, v] of Object.entries(isObj(r.pen) ? r.pen : {})) {
    if (isObj(v) && fin(v.adults) && fin(v.babies) && fin(v.at)) pen[k] = { adults: v.adults, babies: v.babies, at: v.at };
  }
  const ranges: Record<string, number> = {};
  for (const [k, v] of Object.entries(isObj(r.ranges) ? r.ranges : {})) if (fin(v) && v > 0) ranges[k] = v;
  const d = isObj(r.deep) ? r.deep : {};
  const deep: WorkMemory['deep'] = { starts: stamps(d.starts), clean: fin(d.clean) && d.clean > 0 ? Math.floor(d.clean) : 0, deaths: stamps(d.deaths) };
  if (fin(d.kitHold)) deep.kitHold = d.kitHold;
  if (fin(d.away)) deep.away = d.away;
  const m: WorkMemory = { dry, next, sites, pen, tier: fin(r.tier) && r.tier > 0 ? Math.floor(r.tier) : 0, deep };
  const f = r.farDay;
  if (isObj(f) && fin(f.day) && fin(f.unblockers) && fin(f.deep)) m.farDay = { day: f.day, unblockers: f.unblockers, deep: f.deep };
  const l = r.last;
  if (isObj(l) && typeof l.task === 'string' && typeof l.variant === 'string' && fin(l.gain) && typeof l.text === 'string' && fin(l.at)) {
    m.last = { task: l.task, variant: l.variant, gain: l.gain, text: l.text, at: l.at };
  }
  if (typeof r.land === 'string') m.land = r.land;
  if (Object.keys(ranges).length) m.ranges = ranges;
  return m;
}

/** the memories this process has made or checked: only this module writes them from then on */
const sound = new WeakSet<object>();

/**
 * The world's work memory, made on first use and put right where brain.json holds something else (a file from before
 * the queue has none; nobody edits it by hand, but a half-written one must not stop the queue). For the writers: the
 * gates read through `peek`.
 */
export function workOf(world: WorldMemory): WorkMemory {
  const w: unknown = world.work;
  if (isObj(w) && sound.has(w)) return w as unknown as WorkMemory;
  const m = clean(w);
  sound.add(m);
  world.work = m;
  writes++;
  return m;
}

/** The same for a gate: it reads what is there and writes nothing (a memory not yet checked is read as a checked copy). */
function peek(world: WorldMemory): WorkMemory {
  const w: unknown = world.work;
  return isObj(w) && sound.has(w) ? w as unknown as WorkMemory : clean(w);
}

/** How long a mark of `n` dry runs waits: 20, 40, 80, 160 min, and for a terrain task twice as long with each run after. */
const dryWait = (n: number, terrain?: boolean): number =>
  (terrain && n > DRY_WAIT.length ? DRY_WAIT[0] * 2 ** Math.min(n - 1, 20) : DRY_WAIT[Math.min(Math.max(n, 1), DRY_WAIT.length) - 1]);

const taskOfKey = (key: string) => key.split(':')[0];
const isTerrain = (key: string, tasks: WorkTask[]) => tasks.some(t => t.terrain && t.name === taskOfKey(key));

/**
 * When a variant's dry mark lifts (real ms); 0 with no mark, and for one let go early. `tasks` tells which marks are
 * terrain marks (they wait longer from the fifth dry run on).
 */
export function dryUntil(world: WorldMemory, key: string, tasks: WorkTask[] = LADDER): number {
  const m = peek(world).dry[key];
  if (!m || m.early) return 0;
  return m.at + dryWait(m.n, isTerrain(key, tasks));
}

/**
 * Mark a variant dry: one more fruitless run, and its next try waits the longer for it. The run wrapper does this for
 * the variant that ran; a task calls it for what else it found empty on the way (a trip sent for iron that saw the
 * vein gone marks `deep:iron` itself).
 */
export function markDry(world: WorldMemory, key: string, now: number): void {
  const w = workOf(world);
  const was = w.dry[key];
  // the try after an early release has been had: this mark waits its whole time
  w.dry[key] = { n: (was?.n ?? 0) + 1, at: now, ...(was?.early ? { freed: true as const } : {}) };
  writes++;
}

/** The brain's holds per world (goal name -> until, real ms), the map decide() reads: shared, and only read here. */
const holdsOf = new WeakMap<WorldMemory, ReadonlyMap<string, number>>();
/** The brain hands over its holds, each tick before it decides (the map itself: read as it stands when asked). */
export function shareHolds(world: WorldMemory, holds: ReadonlyMap<string, number>): void { holdsOf.set(world, holds); }
const heldNow = (world: WorldMemory, task: WorkTask, now: number) => (holdsOf.get(world)?.get(`work: ${task.name}`) ?? 0) > now;

/**
 * Whether a home round (lights, tidy, repair, signs, sort) is due: more than `everyMs` since its last run, and then
 * only when it costs no trip: in the evening, or when it has waited twice its time, or when no trip is ready to go.
 * A trip the brain holds back (it failed, timed out, went round in circles) is no trip that could go: the rounds
 * waited all morning on one that could not start.
 */
export function roundDue(s: Snapshot, world: WorldMemory, key: string, everyMs: number, tasks: WorkTask[] = LADDER): boolean {
  const since = s.now - (world.lastDone?.[key] ?? 0);
  if (!(since > everyMs)) return false;
  const tod = ((s.timeOfDay % 24_000) + 24_000) % 24_000;
  // (the half hour before sunrise is the morning's, not the evening's: the trips come first then)
  if ((tod >= EVENING_AT && tod < WORK_AT) || since > 2 * everyMs) return true;
  return !tasks.some(t => isTrip(t) && !heldNow(world, t, s.now) && 'variant' in pick(t, s, world));
}

/**
 * Where a home round (lights, tidy, repair, signs, sort) may start from: anywhere in the yard on home's level, while
 * home stands in it; with no such yard, within the round's own reach of home (`reach`, on its level), as ever. Live on
 * Nov 13 the five wanted within 10 of home only (tidy 12, signs 24), and a day went: up at the bed (16 out), the tree
 * round, a deep trip, home for the stash (which outranks them all), the farm (22 out, at the plot), `late` there, the
 * bed. None of them ran for an hour, three times their time, the lights with them (mobs spawn in a dark yard), and the
 * fence's mending in the repair round never once. Never under the yard (off home's level) nor out past the fence: the
 * yard is where they start. From beyond its reach a round walks home first (toRound), and from out there it stops no
 * running goal (its `cuts` says yes within its reach only): it waits for that one to end and takes over at the
 * hand-over. Else every round due would cut the tree round at the far end of the yard, or the project at its site 23
 * out, for a walk home.
 */
export function roundFrom(s: Snapshot, world: WorldMemory, reach: number): boolean {
  if (!s.home || !Number.isFinite(s.distHome) || !onHomeLevel(s.position, s.home)) return false;
  const yard = world.yard;
  if (yard && s.position && outsideBy(yard, s.home) === 0) return outsideBy(yard, s.position) === 0;
  return nearHome(s, reach);
}

/**
 * How near home a round walks before its work: inside every round's reach (10 to 24), within 8 up or down (on home's
 * level), and short of the storage house, so the walk goes through none of its doors (the one at (-549, 63, 2186) has
 * held the bot before). The chests' own walks take it the rest of the way, as they always did.
 */
export const ROUND_WALK = 8;

/**
 * A home round started from out in the yard, beyond its own reach of home: the walk home comes first, on foot only (a
 * careful goto: nothing placed or dug on the way, as the stash's walk home), and the round goes on with the bot as it
 * is after it (pockets, place, hour) from where it would always have started. Within its reach nothing is walked, and
 * the run's own look is the answer. Throws when the walk leaves the bot out there still: the round's work was never
 * meant to start from there, nothing of it is written down, and the brain tries it again after the round's wait.
 */
export async function toRound(ctx: GoalContext, reach: number): Promise<Snapshot> {
  const home = ctx.s.home;
  if (!home || nearHome(ctx.s, reach)) return ctx.s;
  const from = Math.round(ctx.s.distHome);
  ctx.progress(`${from} blocks from home in the yard: home first, on foot`);
  await ctx.call('goto', { x: home.x, y: home.y, z: home.z, range: ROUND_WALK, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => undefined);
  if (ctx.signal.aborted) throw new Error('aborted');
  const s = await look(ctx);
  if (!nearHome(s, reach)) throw new Error(`the walk home from ${from} blocks out stopped ${Math.round(s.distHome)} out (the round works within ${reach} of home)`);
  return s;
}

/** A death as the runtime tells it: where, and when (real ms; known only while this process lives). */
export interface Death { at?: { x: number; z: number }; time: number }

/** The runtime's word on deaths, as the brain handed it to the ladder (workGoals). */
let deathSource: () => Death | undefined = () => undefined;
/**
 * The newest death the runtime knows of, for the old `deep trip` goal (deep.ts), which books its trips with the deep
 * rung's (deepStart, deepEnd) and has no runtime of its own to ask. Undefined before the brain made its ladder.
 */
export function deathNow(): Death | undefined {
  try { return deathSource(); } catch { return undefined; }
}

/** The tier the deep targets stand at (they double with each): a look only, for the tasks' gates. */
export const tierOf = (world: WorldMemory): number => peek(world).tier;

/** The places of a kind the runs have found (wild cane, ...), the newest first: a look only, for the tasks' gates. */
export const sitesOf = (world: WorldMemory, kind: string): readonly { x: number; y: number; z: number; dryAt?: number }[] => peek(world).sites[kind] ?? [];

/** the same place, for a site: a find within this many blocks of one kept is that one again */
const SAME_SITE = 8;

/**
 * A place found by a run (a stand of wild cane): kept first, in place of one kept within a few blocks of it, and the
 * oldest let go beyond four a kind. A task calls it from its run, as it calls markDry.
 */
export function addSite(world: WorldMemory, kind: string, p: { x: number; y: number; z: number }): void {
  const w = workOf(world);
  const kept = (w.sites[kind] ?? []).filter(q => horiz(q, p) > SAME_SITE);
  w.sites[kind] = [{ x: p.x, y: p.y, z: p.z }, ...kept].slice(0, SITES);
  writes++;
}

/** A place that holds nothing any more (or is someone's after all): forgotten. */
export function dropSite(world: WorldMemory, kind: string, p: { x: number; z: number }): void {
  const w = workOf(world);
  const list = w.sites[kind];
  if (!list) return;
  const kept = list.filter(q => q.x !== p.x || q.z !== p.z);
  if (kept.length === list.length) return;
  if (kept.length) w.sites[kind] = kept; else delete w.sites[kind];
  writes++;
}

/** What a pen held when it was last looked into (adults, babies, when): a look only, for the cows rung's gate. */
export const penCount = (world: WorldMemory, kind: string): Readonly<WorkMemory['pen'][string]> | undefined => peek(world).pen[kind];

/** What a pen holds, as the pens round or a fetch saw it just now: written each time one looks into it. */
export function notePen(world: WorldMemory, kind: string, count: { adults: number; babies: number; at: number }): void {
  workOf(world).pen[kind] = { adults: count.adults, babies: count.babies, at: count.at };
  writes++;
}

/** A side of home, and its step on the map. */
export type HomeSide = 'north' | 'east' | 'south' | 'west';
const SIDE_STEP: Record<HomeSide, [number, number]> = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
/** the stops out along a side, blocks apart */
const SIDE_LEG = 32;
/** the last stop this far inside the leash: what is seen round it is within reach, and the walk back with it too */
const SIDE_MARGIN = 16;

/**
 * In the yard or within its edge, one of these: a walk between them is careful (walk only), as pens.ts walks to an
 * animal. Baritone's own walk climbs the fence and leaves its scaffold there (the stray cobblestone at the east fence),
 * and the walk out of the yard to a side's first stop goes through a gate (outByGate).
 */
export const byYard = (world: WorldMemory, ...ps: { x: number; z: number }[]): boolean =>
  !!world.yard && ps.some(p => outsideBy(world.yard!, p) <= YARD_EDGE);

/**
 * Strictly inside the yard's fence (the fence line itself is not inside: the gates stand on it). The walks into the
 * yard (a fetch with its animal, pens.ts) and out of it (the side walks, the fetch's walk to an animal) go by this.
 */
export function inFence(world: WorldMemory, q: { x: number; z: number }): boolean {
  const y = world.yard;
  return !!y && Math.floor(q.x) > y.x1 && Math.floor(q.x) < y.x2 && Math.floor(q.z) > y.z1 && Math.floor(q.z) < y.z2;
}

/** A gate in the yard's fence as a walk through it goes: the side it is on, and the cells 2 inside and 2 outside it. */
export interface YardGate { gate: Pos; side: HomeSide; inner: Pos; outer: Pos }

const mid = (c: { x: number; z: number }) => ({ x: c.x + 0.5, z: c.z + 0.5 });

/**
 * The yard's gates (world memory's `fence:gate`), by the way each makes between a place inside the fence and one
 * outside it, the shortest first: to its cell on the near side, through it, and on from its cell on the far side (the
 * same either way round: a fetch walks in by it, a side walk out).
 */
export function gatesBetween(world: WorldMemory, inside: { x: number; z: number }, outside: { x: number; z: number }): YardGate[] {
  const yard = world.yard;
  if (!yard) return [];
  const ways: { len: number; g: YardGate }[] = [];
  for (const g of world.zones?.['fence:gate'] ?? []) {
    const side: HomeSide | undefined = g.z === yard.z1 ? 'north' : g.z === yard.z2 ? 'south' : g.x === yard.x1 ? 'west' : g.x === yard.x2 ? 'east' : undefined;
    if (!side) continue;
    const [dx, dz] = SIDE_STEP[side];
    const outer = { x: g.x + 2 * dx, y: g.y, z: g.z + 2 * dz }, inner = { x: g.x - 2 * dx, y: g.y, z: g.z - 2 * dz };
    ways.push({ len: horiz(outside, mid(outer)) + 4 + horiz(mid(inner), inside), g: { gate: { x: g.x, y: g.y, z: g.z }, side, inner, outer } });
  }
  return ways.sort((a, b) => a.len - b.len).map(w => w.g);
}

/** What a body stands in and walks through: the air, and what grows on the ground or hangs on a wall. */
export const CLEAR = /^(minecraft:)?(air|cave_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|leaf_litter|dandelion|poppy|\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|lily_of_the_valley|snow|torch|wall_torch)(\[|$)/;
const WET = /^(minecraft:)?(flowing_)?(water|lava)(\[|$)/;

/**
 * Where to stand at a cell by a gate: on its own floor within 3 of the gate's level, the nearest to that level first
 * (the ground outside a gate is not always the yard's: outside the live yard's west gate it is 3 higher, outside its
 * north gate a hill); the gate's level where the look fails or finds none.
 */
async function floorAt(ctx: GoalContext, cell: Pos): Promise<Pos> {
  const box = { x: cell.x, y: cell.y - 4, z: cell.z, width: 1, height: 9, length: 1 };
  const col = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', box).catch(() => undefined))?.blocks;
  if (!col || col.length < box.height) return cell;
  const clear = (b: string | null | undefined) => !!b && CLEAR.test(b);
  const floor = (b: string | null | undefined) => !!b && !CLEAR.test(b) && !WET.test(b);
  for (const dy of [0, 1, -1, 2, -2, 3, -3]) {
    const i = 4 + dy;
    if (floor(col[i - 1]) && clear(col[i]) && clear(col[i + 1])) return { ...cell, y: cell.y + dy };
  }
  return cell;
}

/**
 * Out of the yard by one of its gates, from strictly inside the fence toward `to` outside it: a careful walk (walk
 * only) to the cell 2 inside the gate that makes the shortest way, then through it to the cell 2 outside, each on
 * its own floor. Never "any height at this x and z" from in here: a cave under the yard answers that as
 * well as the gate does. Live on Nov 13 the cows' walk from 32 out north (inside the yard) to 64 out (the north gate
 * itself) went down three times in 20 min, 30 to 41 under the lawn: in front of the gate the way on foot was shut
 * (cells Baritone keeps out of), and the gate's column was there to be had in the cave 30 under it, by the pit at the
 * gap in the east fence. Out from under dug it out each time. `sides`: only the gates on these sides of the fence
 * (a side walk's own: from another side's gate its walk on to "any height" at the stop goes round the fence, or back
 * across the yard, by the same caves). Each walk is to within 1 of its cell: still a block on the ground, which no
 * cave far below answers, and one a bot on a dirt path (its block is the path's own, under the cell) or in a plant
 * floorAt took for a floor (pink petals, a sapling, a carpet) gets to; to the block itself it "did not arrive".
 * `{}`: nothing to do (the bot not inside the fence, `to` not outside it, or no gate known); `shut`: no gate let it
 * out (one gone or blocked: the next is tried), or none on those sides; `gate` and `at` once out.
 */
export async function outByGate(ctx: GoalContext, to: { x: number; z: number }, sides?: HomeSide[]): Promise<{ gate?: Pos; at?: Pos; shut?: string }> {
  const me = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
  if (!inFence(ctx.world, me) || inFence(ctx.world, to)) return {};
  const all = gatesBetween(ctx.world, me, to);
  if (!all.length) return {};
  const gates = sides ? all.filter(g => sides.includes(g.side)) : all;
  if (!gates.length) return { shut: `no gate in the yard's ${sides!.join(' or ')} fence` };
  const tried: string[] = [];
  for (const g of gates) {
    if (ctx.signal.aborted) throw new Error('aborted');
    ctx.progress(`out of the yard by its ${g.side} gate (${g.gate.x}, ${g.gate.y}, ${g.gate.z})`);
    let arrived = true;
    for (const c of [g.inner, g.outer]) {
      const at = await floorAt(ctx, c);
      const r = await ctx.call<{ arrived?: boolean }>('goto', { ...at, range: 1, careful: true, timeoutMs: 90_000 }, 105_000).catch(() => ({ arrived: false }));
      if (ctx.signal.aborted) throw new Error('aborted');
      if (r?.arrived === false) { arrived = false; break; }
    }
    const now = (await ctx.status().catch(() => undefined))?.position;
    // out: within the walk's 1 of the cell outside, or at it or past it however the walk ended; never in the gateway
    // itself (the fence line is not inside, but a walk to "any height" from there is the one this way keeps from)
    const [dx, dz] = SIDE_STEP[g.side];
    const past = (p: { x: number; z: number }) => (Math.floor(p.x) - g.gate.x) * dx + (Math.floor(p.z) - g.gate.z) * dz;
    if (now ? past(now) >= (arrived ? 1 : 2) : arrived) return { gate: g.gate, at: now ?? g.outer };
    tried.push(`the ${g.side} gate (${g.gate.x}, ${g.gate.y}, ${g.gate.z})`);
  }
  return { shut: `no way out of the yard by ${tried.join(' or ')}` };
}

/** How far from home across the ground a walk may go, and what the words call that bound (`the leash`). */
export interface Bound { blocks: number; name: string }

/**
 * Look along one side of home for something (wild cane, a wild cow), no further out than the leash (or the `bound`
 * given: the cows go out to their range): from where the bot stands, then from stops 32 blocks apart along that side,
 * the last 16 inside the leash, `look` at each. The explore tool would not do: it looks 96 round the bot from the first
 * step and stops at the first it sees (the bot's own cane patch, a cow in its own pen, or one past the leash), and it
 * goes as far out as told from wherever the bot is. A stop in the yard or within the bridge's margin round it is left
 * out: there is nothing wild to look for there (north 32 out is inside the yard, north 64 the gate itself); when that
 * leaves none (a yard grown out that way, a shorter leash), the first place past the margin is the stop, if it is
 * within the leash. From inside the fence the walk out goes by the gate on that side (outByGate). A stop not got to
 * (water, a cliff) is looked round from where the walk ended, and the side goes no further. Returns the first find, or
 * why there was none (`what` names it: `no wild cane east within the leash ...`, `no wild cane looked for north: no way
 * out of the yard by the north gate ...`); `short` when the run's time ran out before the side's end, so the side was
 * not looked along to the leash.
 */
export async function alongSide<T>(ctx: GoalContext, side: HomeSide, what: string, look: () => Promise<T | undefined>,
  enough: () => boolean = () => false, bound: Bound = { blocks: ctx.world.leash, name: 'the leash' }): Promise<{ found?: T; text: string; short?: true }> {
  const home = ctx.s.home!;
  const last = bound.blocks - SIDE_MARGIN;
  const [dx, dz] = SIDE_STEP[side];
  const stopAt = (d: number) => ({ x: Math.round(home.x + dx * d), y: home.y, z: Math.round(home.z + dz * d) });
  const yard = ctx.world.yard;
  const wild = (d: number) => !yard || outsideBy(yard, stopAt(d)) > ZONE_MARGIN;
  const stops = [0, ...Array.from({ length: Math.floor(last / SIDE_LEG) }, (_, i) => (i + 1) * SIDE_LEG), last].filter((d, i, a) => d >= 0 && d <= last && a.indexOf(d) === i);
  const legs = stops.filter(d => d === 0 || wild(d));
  // (every stop out in the yard or its margin: a look from home alone would say "none within the leash" and write the
  // side off for hours, never looked along. With the margin out past the leash that way, nothing wild is within it)
  if (legs.length === 1 && stops.length > 1) {
    const edge = Array.from({ length: bound.blocks }, (_, i) => i + 1).find(wild);
    if (edge !== undefined) legs.push(edge);
  }
  let out = 0;
  let me: { x: number; z: number } = ctx.s.position;
  for (const d of legs) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (d > 0) {
      // (not "none within the leash": the rest of the side was never seen, and its mark must not say it was)
      if (enough()) return { text: `no ${what} seen ${side} ${out ? `as far as ${out} blocks out` : 'from home'}: the run's time ran out`, short: true };
      ctx.progress(`looking ${side} for ${what}, ${d} blocks out`);
      const stop = stopAt(d);
      // out by this side's own gate, or not at all. Shut, the side gets the dry mark a side with none gets (the turn
      // goes on to the next side, and a gate that stays shut waits the longer each time): as untried the same side
      // came first again, and three of those held the whole rung to the morning
      const gate = await outByGate(ctx, stop, [side]);
      if (gate.shut) return { text: `no ${what} looked for ${side}: ${gate.shut}` };
      if (gate.at) me = gate.at;
      const careful = byYard(ctx.world, me, stop);
      const r = await ctx.call<{ arrived?: boolean }>('goto', { ...stop, xz: true, range: 8, ...(careful ? { careful: true } : {}), timeoutMs: 90_000 }, 105_000)
        .catch(() => ({ arrived: false }));
      if (ctx.signal.aborted) throw new Error('aborted');
      const at = (await ctx.status().catch(() => undefined))?.position;
      me = at ?? stop;
      // stopped short (water, a cliff): it looks from there, and goes no further
      if (r.arrived === false) {
        const got = at ? Math.round(horiz(at, home)) : out;
        const found = await look();
        if (found !== undefined) return { found, text: '' };
        return { text: `no ${what} ${side} within ${bound.name}: got no further than ${got} blocks out` };
      }
    }
    out = d;
    const found = await look();
    if (found !== undefined) return { found, text: '' };
  }
  return { text: `no ${what} ${side} within ${bound.name} (${bound.blocks} from home)` };
}

/**
 * What `pick` answers for a task: the variant to run (its place in the task's turn, its distance, why; `first`: one
 * tried ahead of the turn, whose run leaves the turn where it is), or the one reason the task does not ask to run.
 */
export type Choice = { variant: string; index: number; dist: number; why: string; demoted: boolean; first?: true } | { decline: Decline };

const isTrip = (task: WorkTask) => task.reach === 'far' || task.reach === 'deep';
/** the rungs that unblock the project (cows, cane): they may not starve the deep rung */
const isUnblocker = (task: WorkTask) => task.rank === 2 || task.rank === 3;
/** the day number of the idle tally (read only: the tally is the brain's) */
const dayOf = (world: WorldMemory): number => { const d: unknown = world.idle?.today?.day; return fin(d) ? d : 0; };

/**
 * What keeps the bot from going deep after trips that went wrong, for the deep rung and the old `deep trip` goal
 * alike: two deaths on deep trips within 24 h hold it until the older is a day old; and until three trips in a row
 * ended well it makes two an hour at most. Both are read off the stamps: nothing is stored that someone would have to
 * clear by hand.
 */
export function deepHold(s: Pick<Snapshot, 'now'>, world: WorldMemory): Decline | null {
  const { deep } = peek(world);
  const deaths = deep.deaths.filter(t => s.now - t < DAY).sort((a, b) => a - b);
  if (deaths.length >= 2) {
    const until = deaths[deaths.length - 2] + DAY;
    return { cause: 'hold', text: `two deaths on deep trips in 24 h: held until ${clock(until)}`, until };
  }
  if (deep.clean >= PROBATION.clean) return null;
  const recent = deep.starts.filter(t => s.now - t < HOUR).sort((a, b) => a - b);
  if (recent.length < PROBATION.perHour) return null;
  const until = recent[recent.length - PROBATION.perHour] + HOUR;
  return { cause: 'hold', text: `deep on probation: ${PROBATION.perHour} trips this hour, next at ${clock(until)}`, until };
}

/** After a death away from home the trips wait for the kit to be whole again (workTick lifts it, after an hour at the latest). */
function kitHold(s: Snapshot, world: WorldMemory): Decline | null {
  const at = peek(world).deep.kitHold;
  if (at === undefined || s.now - at >= KIT_HOLD_MS) return null;
  const kit = deepTripKit(tripCheck(s));
  return kit.ok ? null : { cause: 'kit', text: `after a death: ${kit.why}`, until: at + KIT_HOLD_MS };
}

/**
 * The gates every task shares, in the order the idle time is to be explained: the hour of rest, where the bot is,
 * its health, what a death left behind (trips only), and its pockets.
 */
function common(task: WorkTask, s: Snapshot, world: WorldMemory): Decline | null {
  const who = task.name;
  if (s.sleeping || s.activity !== 'work') return no.late(s, who);
  // every rung sets out from the yard or near it, the yard ones too: the bot wakes at a bed 16 blocks from home
  if (!s.home || s.dimension !== 'overworld' || !inYardOrNear(s, world)) return no.away(s, who, TRIP_STASH_RANGE);
  if (s.health < 12 || s.food < 10) return no.health(s, who, 12, 10);
  // a trip down sets out in the morning or not at all: once the day is too far gone for one, neither a hold nor full
  // pockets is what keeps the rung at home (the seven-day replay booked whole held afternoons to `hold`, and evenings
  // with full pockets to `pockets`). The hour itself is said only by a rung that is otherwise ready (choose): with
  // the kit short, or every ore dry, that is the afternoon's reason, and the 30 s release can see the dry marks
  if (task.reach === 'deep' && lateFor(task, 0, s)) return null;
  if (isTrip(task)) {
    const held = kitHold(s, world) ?? (task.reach === 'deep' ? deepHold(s, world) : null);
    if (held) return held;
  }
  return room(task.room, s, world) === 'no' ? noRoom(task.room, who, s, world) : null;
}

/** Too little of the day left for this variant: the walk there and back and the least work do not fit before the return home. */
function lateFor(task: WorkTask, dist: number, s: Snapshot): Decline | null {
  if (task.reach !== 'deep') return no.late(s, task.name, msToTicks(needMs(dist, task.reach, task.backPace)));
  const left = tripBudgetMs(s.timeOfDay, DEEP_WALK_BACK);
  // (rounded down, as deep.ts does: a tick too late is "2.9 left", not "3.0")
  return left < DEEP_WORTH ? { cause: 'late', text: `${task.name} needs ${DEEP_WORTH / MINUTE} min, ${(Math.floor(left / (MINUTE / 10)) / 10).toFixed(1)} left` } : null;
}

/**
 * What the run may spend at the place, ms: the task's own budget, or what the day leaves after the walk back and a
 * margin. A run that walks its find home itself (`backPace`: a cow on the lead) has the way back in its budget: the
 * way there and back at its pace and the least work (needMs) at the least, and what the day leaves bounds it (the
 * walk home after is from the pen; one that lets its find go out there walks back faster than it would have led it).
 * Counted as a walk, a fetch from 200 out could set out at tod 7140 with 111 s to bring home a cow 133 s off on the
 * lead: let go on the way.
 */
function budgetFor(task: WorkTask, dist: number, s: Snapshot): number {
  if (task.reach === 'deep') return tripBudgetMs(s.timeOfDay, DEEP_WALK_BACK);
  const day = ticksToMs(daylightLeft(s.timeOfDay));
  if (task.backPace) return Math.max(0, Math.min(Math.max(task.budgetMs, needMs(dist, task.reach, task.backPace)), day - 15_000));
  return Math.max(0, Math.min(task.budgetMs, day - dist / 3 * 1000 - 15_000));
}

/**
 * How long the brain lets a run of the task go on, from its start (the goal's timeout). A run that walks its find
 * home itself is given two minutes more: making room before it and the walk home from as far out as it lets its find
 * go (85 s from 256 out) come on top of a budget that holds the whole way back.
 */
const timeoutOf = (task: WorkTask): number => (task.reach === 'deep' ? 12 * MINUTE : task.budgetMs + (task.backPace ? 4 : 2) * MINUTE);
/**
 * The run's own time left at the place when the brain will stop it, ms: what making room took and the walk there and
 * back come off it (for a run that brings its find home itself, the walk home from out there only: the way back with
 * it is the run's own).
 */
const timeLeftFor = (task: WorkTask, dist: number, spentMs: number): number =>
  timeoutOf(task) - spentMs - (task.backPace ? dist / 3 : 2 * dist / 3) * 1000 - 30_000;

function demotedBy(task: WorkTask, mark: DryMark | undefined, w: WorkMemory, world: WorldMemory): string | undefined {
  if (!isUnblocker(task)) return undefined;
  if ((mark?.n ?? 0) >= 2) return `dry ${mark?.n} times: after the deep trip`;
  const f = w.farDay;
  return f && f.day === dayOf(world) && f.unblockers >= 1 && f.deep === 0 ? 'one such trip today already: the deep trip first' : undefined;
}

function choose(task: WorkTask, s: Snapshot, world: WorldMemory): Choice {
  if (s.sleeping || s.activity !== 'work') return { decline: no.late(s, task.name)! };
  // nothing to do is said before what would keep the rung from doing it, as the other goals say it: a rung with
  // nothing to do is not held back by full pockets or a hold, and its idle time is not theirs (with the deep kit
  // ready, `trip kit` said "36/36 slots ... (trip kit needs 2 free)")
  const all = task.variants(s, world);
  if (!all.length) return { decline: task.none?.(s, world) ?? { cause: 'unneeded', text: `${task.name}: nothing to do` } };
  const gate = common(task, s, world);
  if (gate) return { decline: gate };
  const w = peek(world);
  // the places known to hold it first, then the rest in turn from where the last run left the turn
  const turn = all.filter(v => !v.first);
  const from = turn.length ? (w.next[task.name] ?? 0) % turn.length : 0;
  const order = [...all.filter(v => v.first), ...turn.slice(from), ...turn.slice(0, from)];
  let unready: Decline | undefined;
  let late: { dist: number; d: Decline } | undefined;
  const dry: { id: string; until: number }[] = [];
  for (const v of order) {
    const index = v.first ? from : turn.indexOf(v);
    const r = task.ready(s, world, v.id);
    if (r) { unready ??= r; continue; }
    const mark = w.dry[`${task.name}:${v.id}`];
    const until = mark && !mark.early ? mark.at + dryWait(mark.n, task.terrain) : 0;
    if (until > s.now) { dry.push({ id: v.id, until }); continue; }
    // the hour is asked last: it is the reason only for a variant nothing else stands in the way of
    const l = lateFor(task, v.dist, s);
    if (l) { if (!late || v.dist < late.dist) late = { dist: v.dist, d: l }; continue; }
    const where = task.reach === 'yard' ? 'in the yard' : task.reach === 'deep' ? 'under ground' : `${Math.round(v.dist)} blocks out`;
    const tried = mark?.early ? `, let go early after ${mark.n} dry` : mark ? `, ${mark.n} dry before` : '';
    const below = demotedBy(task, mark, w, world);
    return { variant: v.id, index, dist: v.dist, demoted: !!below, why: `${where}${tried}${below ? ` (${below})` : ''}`, ...(v.first ? { first: true as const } : {}) };
  }
  // one answer for the task: that of the variant that got furthest
  if (late) return { decline: late.d };
  if (dry.length) {
    const first = dry.reduce((a, b) => (b.until < a.until ? b : a));
    return { decline: { cause: 'dry', text: `${task.name} [${first.id}] until ${clock(first.until)}${dry.length > 1 ? ` (${dry.length} dry)` : ''}`, until: first.until } };
  }
  return { decline: unready ?? { cause: 'unneeded', text: `${task.name}: nothing to do` } };
}

const memo = new WeakMap<Snapshot, Map<WorkTask, { world: WorldMemory; writes: number; got: Choice }>>();

/**
 * Which variant of a task would run now, or the one reason the task does not ask to. It looks and never writes, and
 * it is asked for every task many times a tick (wants, declines, the urgency inside the sort, the idle log): the
 * answer is kept per snapshot, which lives one tick, and dropped at any write to the work memory in between.
 */
export function pick(task: WorkTask, s: Snapshot, world: WorldMemory): Choice {
  let per = memo.get(s);
  if (!per) memo.set(s, per = new Map());
  const hit = per.get(task);
  if (hit && hit.world === world && hit.writes === writes) return hit.got;
  const got = choose(task, s, world);
  per.set(task, { world, writes, got });
  return got;
}

/** The run under way: whose trip it is (its goal is the urgent one), and a token so that a run winding down late cannot lower the flags of the one after it. */
let current: { task: WorkTask; token: object } | undefined;

/** No work run is under way: the brain says so on every tick that none is its running goal (a run that never unwound leaves no flag behind). */
export function clearOut(): void {
  current = undefined;
  out.work = false;
  out.trip = false;
}

/**
 * A deep trip sets out (the deep rung, or the old `deep trip` goal): stamped for the probation and for the status,
 * and counted in the day's trips, which is what lets the unblockers go again after it.
 */
export function deepStart(world: WorldMemory, now: number): void {
  const w = workOf(world);
  w.deep.starts.push(now);
  // (the last trip's end out there is this one's from here on)
  delete w.deep.away;
  farDayOf(w, world).deep += 1;
  writes++;
}

/**
 * A deep trip is over. A death since it set out puts the probation back to the start and is stamped (two in 24 h hold
 * the rung); a trip that ran its course without one counts towards the three that end the probation; one cut short
 * without a death changes nothing. `awayAt`: it ended with the bot not seen home (survival cut it short down there,
 * or cut the walk back): until the bot is home, a death is still one on this trip (workTick books it). Hurt by mobs,
 * the retreat home, and a death on the way up is the commonest way to die down there.
 */
export function deepEnd(world: WorldMemory, startedAt: number, death: Death | undefined, ranItsCourse: boolean, awayAt?: number): void {
  const w = workOf(world);
  if (death && fin(death.time) && death.time >= startedAt) {
    w.deep.clean = 0;
    if (!w.deep.deaths.includes(death.time)) w.deep.deaths.push(death.time);
  } else {
    if (ranItsCourse) w.deep.clean += 1;
    if (fin(awayAt)) w.deep.away = awayAt;
    else if (!ranItsCourse) return;
  }
  writes++;
}

function farDayOf(w: WorkMemory, world: WorldMemory): NonNullable<WorkMemory['farDay']> {
  const day = dayOf(world);
  if (w.farDay?.day !== day) w.farDay = { day, unblockers: 0, deep: 0 };
  return w.farDay;
}

const tasksOf = new WeakMap<Goal, WorkTask>();
/** The ladder task behind a `work: <task>` goal (undefined for every other goal). */
export const taskOf = (g: Goal): WorkTask | undefined => tasksOf.get(g);
/** The ladder tasks among a goal list, the top rung first. */
export const ladderOf = (goals: Goal[]): WorkTask[] => goals.map(taskOf).filter((t): t is WorkTask => !!t).sort((a, b) => a.rank - b.rank);

const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/** What the line of a run cut short under the yard says of its mark. */
const UNDER_MARK = 'went under the yard on the way: a mark, another way next';

/** Under the yard now, by a look made outside the run (its own calls are refused once it has been given up, as its tidy-ups are). */
async function underAfterCut(ctx: GoalContext, s: Snapshot): Promise<boolean> {
  const st = await brainRun.exit(() => ctx.status()).catch(() => undefined);
  return !!s.home && !!st?.position && (st.dimension ?? s.home.dimension) === s.home.dimension && underYard(st.position, s.home, ctx.world.yard);
}

/**
 * A run that went under the yard (cut short there by out from under, or ended there): its variant waits its mark
 * again from now whatever it brought in (20 min the first time), and the turn moves on, so the next run goes another
 * way. Going under says nothing of the place, so the count stays as it was, neither more nor less (as the `same` mark
 * keeps it): a side dry six times, tried once its half day was up, does not go back to 20 min. A mark the run itself
 * wrote on the way (it saw the place empty) stands. One early try per wait, as markDry keeps it: a mark let go early
 * whose try went under waits its whole time (else the idle release lets it go again after every half minute idle).
 */
function underMark(task: WorkTask, c: { index: number; first?: true }, world: WorldMemory, key: string, at: number, setOut: number): void {
  const w = workOf(world);
  const mark = w.dry[key];
  if (!mark || mark.at < setOut) w.dry[key] = { n: Math.max(1, mark?.n ?? 0), at, ...(mark?.early ? { freed: true as const } : {}) };
  if (!c.first) w.next[task.name] = c.index + 1;
  writes++;
}

/** How long the walk up to where a trip went down may take: the time the trip's budget keeps back for the walk back (deep.ts WALK_BACK). */
const WALK_UP_MS = 2 * MINUTE;
/** Within this of where it went down, the bot is up there already. */
const UP_NEAR = 3;

/**
 * A trip down the mine comes up where it went down (its WorkResult's `upAt`, the block it stood on at the mine start)
 * before the walk home. From down there Baritone's way home runs straight under the ground toward home and into the
 * home zone's column, where the bridge lets it break nothing: live on Nov 13 the walk home from (-505, -21, 2213)
 * stopped 55 under the yard at (-530, 7, 2189), and a trip's walk home after its iron at (-529, 10, 2179). So back
 * the way it came first (Baritone's own walk: out there, outside the column, it may dig), and home over the surface
 * from the mine start, 56 out on the far side of the yard. A walk that does not get there leaves the rest to go-home,
 * as before. Nothing when it stands there already. Adds the walk back to the start, less what it saves of the walk
 * home: some 20 to 60 s on the live trips (the mine start is 22 s from home on foot), 2 min at most.
 */
export async function walkUp(ctx: GoalContext, upAt: Pos, from?: Pos): Promise<void> {
  if (from && Math.hypot(from.x - upAt.x, from.y - upAt.y, from.z - upAt.z) <= UP_NEAR) return;
  ctx.progress(`up where it went down, (${upAt.x}, ${upAt.y}, ${upAt.z}), before the walk home`);
  await ctx.call('goto', { ...upAt, range: 1, timeoutMs: WALK_UP_MS }, WALK_UP_MS + 15_000).catch(() => undefined);
  if (ctx.signal.aborted) throw new Error('aborted');
}

/**
 * One run of a task: room, the hour, the stamps, the task's own run, the marks, the walk home. The marks are written
 * before the walk (the storage house door sometimes holds the bot: what the run found must not be lost with it), and
 * only by a run that ran its course: one cut short or timed out has learnt nothing about the place.
 */
async function runTask(task: WorkTask, ctx: GoalContext, lastDeath: () => Death | undefined, now: () => number): Promise<string> {
  const token = {};
  const startedAt = now();
  let deepOut = false;
  let ranItsCourse = false;
  /** the bot was seen home (or walked there) at the run's end */
  let home = false;
  current = { task, token };
  out.work = true;
  out.trip = isTrip(task);
  try {
    const c = pick(task, ctx.s, ctx.world);
    if ('decline' in c) return `nothing to do after all (${c.decline.cause}: ${c.decline.text})`;
    const { variant, dist } = c;
    const key = `${task.name}:${variant}`;
    // the put-away may have taken minutes and changed what is carried: from here on it is the fresh look that counts
    const s = await makeRoom(ctx, task.room);
    const off = (s !== ctx.s ? task.ready(s, ctx.world, variant) : null) ?? lateFor(task, dist, s);
    if (off) return `[${variant}] not setting out: ${off.text}`;
    let budgetMs = budgetFor(task, dist, s);
    if (task.reach !== 'deep') {
      // the brain stops the run at its timeout, counted from its start: a put-away of a minute or two and the full
      // budget after it ran past that while still mining, and what it had mined was never told (a deep trip's
      // budget is the day's clock, which the put-away has already moved on)
      const spent = now() - startedAt;
      const left = timeLeftFor(task, dist, spent);
      // (a run that brings its find home needs the whole way there and back: cut short, it lets it go out there)
      const least = task.backPace ? needMs(dist, task.reach, task.backPace) : MIN_WORK[task.reach];
      if (left < least) return `[${variant}] not setting out: making room took ${Math.round(spent / 1000)} s, too little of the run's time is left`;
      budgetMs = Math.min(budgetMs, left);
    }
    const setOut = now();
    if (task.reach === 'deep') { deepStart(ctx.world, setOut); deepOut = true; }
    else if (task.reach === 'far' && isUnblocker(task)) { farDayOf(workOf(ctx.world), ctx.world).unblockers += 1; writes++; }

    let told = 0;
    let r: WorkResult;
    try {
      r = await task.run({ ...ctx, s, gain: n => { told += n; ctx.gain(n); } }, variant, budgetMs, now);
    } catch (e) {
      // stopped at the work (a home round cuts into a run in the yard or near it): the run's own line is never
      // logged, only "stopped ...: aborted", as if it had come to nothing. What it had brought in is said here once.
      // Stopped under the yard (out from under cuts anything there), the way this variant went took the bot under the
      // yard, and chosen again at once it went the same way: live on Nov 13 the cows' north side three times in 20
      // min, each "no mark written". It is marked, and the next run goes another way
      if (ctx.signal.aborted) {
        const down = await underAfterCut(ctx, s);
        if (down) underMark(task, c, ctx.world, key, now(), setOut);
        ctx.progress(`[${variant}] stopped before its end, ${told ? `${told} brought in` : 'nothing brought in yet'} ${down ? `(under the yard: ${UNDER_MARK})` : '(no mark written)'}`);
      }
      throw e;
    }
    // what the task counted at the end and had not told as it went still counts as brought in
    const gain = Math.max(told, fin(r.gain) && r.gain > 0 ? r.gain : 0);
    if (gain > told) ctx.gain(gain - told);
    if (ctx.signal.aborted) throw new Error('aborted');
    // (a trip that never got to the work did not run its course: it never went down)
    ranItsCourse = !r.untried;

    // the task stays where its work ended: the way home is the wrapper's, once, for every task. Home is on its level:
    // down the mine under the yard's edge, 10 from home across the ground, is no end of the walk home. Looked at
    // before the marks: a run that ended under the yard is marked as one cut short there is
    let away = true;
    let under = false;
    let where: Pos | undefined;
    try {
      const st = await ctx.status();
      if (s.home && st.position && (st.dimension ?? s.home.dimension) === s.home.dimension) {
        where = st.position;
        away = !nearHomeAt(st.position, s.home, NEAR_HOME);
        under = underYard(st.position, s.home, ctx.world.yard);
      }
    } catch { /* no look: the walk home is asked for, and says where the bot is */ }

    const w = workOf(ctx.world);
    const at = now();
    const mark = w.dry[key];
    // (a mark the task itself wrote on this run stands: it saw the place empty as it left)
    const own = !!mark && mark.at >= setOut;
    // (one that never got to the work learnt nothing of the place: no mark, and it is tried first again)
    // (a place tried ahead of the turn leaves the turn where it was: its own mark keeps it waiting)
    if (under) underMark(task, c, ctx.world, key, at, setOut);
    else if (gain > 0) {
      if (mark && !own) delete w.dry[key];
      if (!c.first) w.next[task.name] = c.index;
    } else if (!r.untried) {
      // (a stand forgotten left its mark behind for good: the key named a place no longer kept)
      if (r.mark === 'forget') delete w.dry[key];
      else if (!own) {
        if (r.mark === 'first') w.dry[key] = { n: 1, at };
        else if (r.mark === 'same') w.dry[key] = { n: Math.max(1, mark?.n ?? 0), at };
        else markDry(ctx.world, key, at);
      }
      if (!c.first) w.next[task.name] = c.index + 1;
    }
    w.last = { task: task.name, variant, gain, text: r.text.slice(0, 160), at };
    writes++;

    const text = `[${variant}] ${r.text}`;
    // home, the run is over. One that never got to the work ends as a failure, once its marks are booked and the bot
    // is home: the brain holds it back then (5 min, and to the next morning after three in a row). As a plain end
    // nothing held it, and the deep rung set out again at once for the same mine start, as often as the morning let it
    const end = (said: string): string => {
      home = true;
      if (r.untried) throw new Error(said);
      return said;
    };
    if (!away) return end(text);
    // under the yard Baritone may break nothing, and the walk home stops in a second (live: `Stopped 57 blocks from
    // home`): the survival goal digs out to the side first, and the trip stays open until the bot is seen home
    if (under) return `${text}; under the yard: out from under first`;
    // a chore at home cuts in as the walk comes within its reach of home, and shelter at dusk: the run's own line
    // would never be logged then, only "stopped ...: aborted", as if the trip had come to nothing (the coal it
    // brought in, the mark it left). It is said here once, as the run was stopped
    const cut = () => { ctx.progress(`${text}; stopped on the walk home (its marks are written)`); return new Error('aborted'); };
    let h: { ok: boolean; text: string };
    try {
      // a trip down comes up where it went down before it walks home (walkUp)
      if (r.upAt) await walkUp(ctx, r.upAt, where);
      h = await ctx.act('go-home', { name: 'home', timeoutMs: 600_000 });
    } catch (e) {
      throw ctx.signal.aborted ? cut() : e;
    }
    if (ctx.signal.aborted) throw cut();
    if (!h.ok) throw new Error(`${text}, but could not get home: ${h.text}`);
    return end(`${text}; back home`);
  } finally {
    // a deep trip is booked as it ends, after the walk home: a death on the climb out of the mine or on the way back is
    // a death on the trip, however the walk ended (the probation starts again, two in 24 h hold the rung). One that
    // ran its course without a death counts towards the probation's three; one cut short before then changes nothing.
    // Cut short out there (retreat, shelter), the trip stays open until the bot is seen home: the death that follows
    // a few seconds on the walk up is the trip's too (workTick)
    if (deepOut) { try { deepEnd(ctx.world, startedAt, lastDeath(), ranItsCourse, home ? undefined : now()); } catch { /* the flags below matter more */ } }
    if (current?.token === token) clearOut();
  }
}

/**
 * The ladder as goals for the brain, one per task, the top rung first: `work: <task>`, each asking through `pick`.
 * They sit below every job of the homestead and above standing about (18 down to 10; a demoted unblocker 8.5 to 4.5),
 * and a trip under way is as urgent as the old deep trip. `now` is the brain's clock: the marks are written at the
 * end of runs that last minutes, long after the snapshot the run was started with.
 */
export function workGoals(lastDeath: () => Death | undefined, tasks: WorkTask[] = LADDER, now: () => number = Date.now): Goal[] {
  deathSource = lastDeath;
  return [...tasks].sort((a, b) => a.rank - b.rank).map(task => {
    const gate = (s: Snapshot, world: WorldMemory): Gate => {
      const c = pick(task, s, world);
      return 'decline' in c ? c.decline : { want: `${c.variant}: ${c.why}` };
    };
    const goal: Goal = {
      name: `work: ${task.name}`,
      priority: 19 - task.rank,
      urgency: (s, world) => {
        if (out.trip && current?.task === task) return TRIP_URGENCY;
        const c = pick(task, s, world);
        return 'variant' in c && c.demoted ? 9 - task.rank / 2 : 19 - task.rank;
      },
      gate,
      ...fromGate(gate),
      gains: true,
      // (a deep trip mines until the day's end, whatever the hour it set out at: 12 min covers the longest morning)
      timeoutMs: timeoutOf(task),
      retryMs: 5 * MINUTE,
      run: ctx => runTask(task, ctx, lastDeath, now)
    };
    tasksOf.set(goal, task);
    return goal;
  });
}

function diedAway(at: Death['at'], s: Snapshot, world: WorldMemory): boolean {
  if (!at || !s.home) return true;
  const yard = world.yard;
  if (yard && outsideBy(yard, s.home) === 0) return outsideBy(yard, at) > YARD_EDGE;
  return horiz(at, s.home) > DEATH_AWAY;
}

/** the newest death each world's queue has been told of (the runtime knows deaths only while the process lives) */
const seenDeath = new WeakMap<WorldMemory, number>();

/**
 * The queue's housekeeping, once a tick before the brain decides, and beside the run wrapper the only place the work
 * memory is written: a death away from home makes the trips wait for the kit (lifted when the kit is whole, or after
 * an hour: surface work by day needs no armour, and a kit that cannot be made whole must not stop the queue for
 * good); old stamps and the marks of tasks no longer on the ladder go, and the terrain marks with a new home or
 * leash; the day's trip count starts anew with the tally's day; and the targets step up a tier when the tasks module
 * says every one is met (one step a call). Returns what happened as lines for the log.
 */
export function workTick(
  s: Snapshot, world: WorldMemory, lastDeath: () => Death | undefined, tasks: WorkTask[] = LADDER,
  step: (s: Snapshot, world: WorldMemory, tier: number) => string | undefined = tierStep
): string[] {
  const lines: string[] = [];
  const w = workOf(world);
  let wrote = false;
  let fresh = false;
  const d = lastDeath();
  if (d && fin(d.time) && d.time > (seenDeath.get(world) ?? -Infinity)) {
    seenDeath.set(world, d.time);
    // a deep trip cut short out there, and the bot not seen home since: a death now is one on that trip (since it
    // set out: one its own booking may not have seen yet as well). Asked before the bot's whereabouts below, which
    // after a respawn are home
    const away = w.deep.away;
    if (away !== undefined) {
      const last = w.deep.starts.length ? w.deep.starts[w.deep.starts.length - 1] : away;
      if (d.time >= Math.min(away, last)) {
        w.deep.clean = 0;
        if (!w.deep.deaths.includes(d.time)) w.deep.deaths.push(d.time);
        delete w.deep.away;
        wrote = true;
        lines.push('work: a death on the way back from a deep trip: on probation again');
      }
    }
    if (s.now - d.time < KIT_HOLD_MS && w.deep.kitHold !== d.time && diedAway(d.at, s, world)) {
      w.deep.kitHold = d.time;
      wrote = fresh = true;
      lines.push(`work: died away from home: the trips wait for the kit, until ${clock(d.time + KIT_HOLD_MS)} at the latest`);
    }
  }
  // (not on the tick the death was seen: that look may still show what the bot carried as it died)
  if (w.deep.kitHold !== undefined && !fresh) {
    const over = s.now - w.deep.kitHold >= KIT_HOLD_MS;
    if (over || deepTripKit(tripCheck(s)).ok) {
      delete w.deep.kitHold;
      wrote = true;
      lines.push(over ? 'work: an hour since the death: the trips go on, kit whole or not' : 'work: the kit is whole again after the death: the trips go on');
    }
  }
  // home again alive (or long enough after it for whatever comes next to be no part of the trip): the trip is over
  if (w.deep.away !== undefined && (nearHome(s, NEAR_HOME) || s.now - w.deep.away >= AWAY_MS)) { delete w.deep.away; wrote = true; }
  for (const list of ['starts', 'deaths'] as const) {
    const kept = w.deep[list].filter(t => s.now - t < DAY);
    if (kept.length !== w.deep[list].length) { w.deep[list] = kept; wrote = true; }
  }
  const known = new Set(tasks.map(t => t.name));
  for (const key of Object.keys(w.dry)) if (!known.has(taskOfKey(key))) { delete w.dry[key]; wrote = true; }
  for (const name of Object.keys(w.next)) if (!known.has(name)) { delete w.next[name]; wrote = true; }
  // the terrain marks say what the land round this home holds, as far as this leash goes: a new home or another
  // leash is land they say nothing about (a memory from before this was kept has none: its marks stand)
  const land = s.home ? `${Math.round(s.home.x)},${Math.round(s.home.z)},${world.leash}` : undefined;
  if (land && w.land !== land) {
    let gone = 0;
    if (w.land !== undefined) for (const key of Object.keys(w.dry)) if (isTerrain(key, tasks)) { delete w.dry[key]; gone++; }
    w.land = land;
    wrote = true;
    if (gone) lines.push(`work: a new home or leash: ${gone} terrain mark(s) let go`);
  }
  // a rung with a range of its own (the cows, past the leash) keeps the range its terrain marks were made under: at
  // another range they say nothing of what lies out there (live, every side's mark had doubled four times within the
  // leash, and the sides would have waited hours before a look past it). A memory with none kept made them under the
  // leash
  for (const t of tasks) {
    if (!t.terrain || !t.range) continue;
    const range = t.range(world);
    const kept = w.ranges?.[t.name];
    if (kept === range) continue;
    let gone = 0;
    if ((kept ?? world.leash) !== range) for (const key of Object.keys(w.dry)) if (taskOfKey(key) === t.name) { delete w.dry[key]; gone++; }
    (w.ranges ??= {})[t.name] = range;
    wrote = true;
    if (gone) lines.push(`work: ${t.name} reach ${range} from home now (was ${kept ?? world.leash}): ${gone} terrain mark(s) let go`);
  }
  for (const name of Object.keys(w.ranges ?? {})) if (!known.has(name)) { delete w.ranges![name]; wrote = true; }
  if (w.farDay && w.farDay.day !== dayOf(world)) { delete w.farDay; wrote = true; }
  if (wrote) writes++;
  const next = step(s, world, w.tier);
  if (next) {
    w.tier += 1;
    writes++;
    lines.push(`work: every deep target met: tier ${w.tier} (${next})`);
  }
  return lines;
}

/**
 * Let one dry mark go before its time: the oldest still waiting, of a variant that could run otherwise (its task's
 * gates pass, it is ready, the day is long enough). The brain calls this after 30 s of standing idle while a rung
 * waits on its dry marks, whatever else leads the idle time. The count stays, so a try that comes back dry waits the longer for it, and that wait is then
 * sat out in full: one early try per wait. Terrain marks are not let go: the land does not change in half an hour.
 * `s` is the look it judges "could run otherwise" by. Returns the key let go, if any.
 */
export function releaseOldestDry(world: WorldMemory, now: number, s: Snapshot, tasks: WorkTask[] = LADDER): string | undefined {
  const marks = peek(world).dry;
  let oldest: { key: string; at: number } | undefined;
  for (const task of tasks) {
    if (task.terrain || common(task, s, world)) continue;
    for (const v of task.variants(s, world)) {
      const key = `${task.name}:${v.id}`;
      const m = marks[key];
      if (!m || m.early || m.freed || m.at + dryWait(m.n) <= now) continue;
      if (task.ready(s, world, v.id) || lateFor(task, v.dist, s)) continue;
      if (!oldest || m.at < oldest.at) oldest = { key, at: m.at };
    }
  }
  if (!oldest) return undefined;
  workOf(world).dry[oldest.key].early = true;
  writes++;
  return oldest.key;
}

/** a decline's words without the task's own name in front (the line names the task already) */
function short(task: WorkTask, d: Decline): string {
  if (d.cause === 'dry') return d.text.replace(`${task.name} [`, '').replace(']', '');
  return d.text.startsWith(`${task.name}: `) ? d.text.slice(task.name.length + 2) : d.text.startsWith(`${task.name} `) ? d.text.slice(task.name.length + 1) : d.text;
}

/**
 * The log line under `start work: X`: why each rung above X did not run instead, from the same answers the brain
 * chose by (`work: deep: skipped: cows (dry: north until 15:10) | trip kit (unneeded: kit ready)`). `held` gives the
 * brain's words for a goal it keeps back. Nothing when X is the top rung, or no ladder goal.
 */
export function skippedLine(goal: Goal, s: Snapshot, world: WorldMemory, goals: Goal[], held: (g: Goal) => string | undefined): string | undefined {
  const task = taskOf(goal);
  if (!task) return undefined;
  const above = goals.flatMap(g => { const t = taskOf(g); return t && t.rank < task.rank ? [{ g, t }] : []; }).sort((a, b) => a.t.rank - b.t.rank);
  if (!above.length) return undefined;
  const parts = above.map(({ g, t }) => {
    const c = pick(t, s, world);
    if ('decline' in c) return `${t.name} (${c.decline.cause}: ${short(t, c.decline)})`;
    const h = held(g);
    return h ? `${t.name} (hold: ${h})` : `${t.name} (${c.demoted ? 'demoted' : 'passed over'}: ${c.variant}: ${c.why})`;
  });
  const line = `work: ${task.name}: skipped: ${parts.join(' | ')}`;
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/** brain-status, `Blocked:`: the ladder tasks that wait on dry marks alone (`work: cane - dry south until 14:32`). */
export function dryBlocked(s: Snapshot, world: WorldMemory, tasks: WorkTask[]): string[] {
  return tasks.flatMap(t => {
    const c = pick(t, s, world);
    return 'decline' in c && c.decline.cause === 'dry' ? [`work: ${t.name} - dry ${short(t, c.decline)}`] : [];
  });
}

/**
 * brain-status: `Work queue: last deep [iron] +23 raw_iron 6 min ago; tier 0; deep trips 7 in 24 h, on probation 1/3;
 * dry: cane:north 40 min, cows:east 20 min.` The last run and its age, the tier of the targets, the deep trips of
 * the last 24 h (and the probation while it lasts), and the marks still waiting with the minutes left. A look only.
 */
export function workLine(world: WorldMemory, now: number, tasks: WorkTask[]): string {
  const w = peek(world);
  const l = w.last;
  const mins = (ms: number) => Math.max(0, Math.round(ms / MINUTE));
  const parts = [l ? `last ${l.task} [${l.variant}] ${l.text.replace(/\.$/, '')} ${mins(now - l.at)} min ago` : 'no run yet', `tier ${w.tier}`];
  const trips = w.deep.starts.filter(t => now - t < DAY).length;
  parts.push(`deep trips ${trips} in 24 h${w.deep.clean < PROBATION.clean ? `, on probation ${w.deep.clean}/${PROBATION.clean}` : ''}`);
  const waiting = Object.entries(w.dry)
    .map(([key, m]) => ({ key, left: m.early ? 0 : m.at + dryWait(m.n, isTerrain(key, tasks)) - now }))
    .filter(m => m.left > 0).sort((a, b) => a.left - b.left);
  if (waiting.length) {
    const shown = waiting.slice(0, 6).map(m => `${m.key} ${Math.max(1, Math.ceil(m.left / MINUTE))} min`);
    parts.push(`dry: ${shown.join(', ')}${waiting.length > 6 ? `, ${waiting.length - 6} more` : ''}`);
  }
  return `Work queue: ${parts.join('; ')}.`;
}
