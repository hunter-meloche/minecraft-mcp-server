/**
 * The work queue: what the bot does with a day that has no job in it. A ladder of tasks (worktasks.ts), each one goal
 * for the brain, each with variants (a side, an ore, a part of the kit). A variant that brought nothing in waits
 * before its next try and the next one has its turn, so a day never ends in one fruitless trip run over and over,
 * and never in standing about while a rung lower down could run.
 *
 * Who writes: the gates (`pick`, a task's `ready` and `variants`, the goals' wants / declines / urgency, `roundDue`)
 * only read: they are asked many times a tick. `world.work` is written in two places, the run wrapper and `workTick`,
 * and by `markDry` / `releaseOldestDry`, which the tasks and the brain call.
 */
import { fromGate, no, outsideBy, YARD_EDGE, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { NEAR_HOME, TRIP_STASH_RANGE, inYardOrNear, makeRoom, noRoom, out, room, type RoomKind } from './pockets.js';
import { WORK_AT, daylightLeft } from './schedule.js';
import { deepTripKit, tripBudgetMs } from './mine.js';
import { tripCheck } from './deep.js';
import { clock } from './idlelog.js';
import { LADDER, tierStep } from './worktasks.js';

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
 * wrapper ends such a run as a failure, which the brain holds back.
 */
export interface WorkResult { gain: number; text: string; untried?: true }

export interface WorkTask {
  name: string;
  /** 1 is the top rung */
  rank: number;
  reach: Reach;
  room: RoomKind;
  budgetMs: number;
  /** its dry marks tell of the land, not of the hour: they go on doubling past 160 min */
  terrain?: true;
  /** what it could do now, each with its distance from home in blocks; sync, reads only */
  variants(s: Snapshot, world: WorldMemory): { id: string; dist: number }[];
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
/** There and back at 3 blocks a second, and the least work: what a variant `dist` blocks out needs of the day, ms. */
export const needMs = (dist: number, reach: Exclude<Reach, 'deep'>): number => 2 * dist / 3 * 1000 + MIN_WORK[reach];
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

/** What `pick` answers for a task: the variant to run (its place in the task's list, its distance, why), or the one reason the task does not ask to run. */
export type Choice = { variant: string; index: number; dist: number; why: string; demoted: boolean } | { decline: Decline };

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
  if (task.reach !== 'deep') return no.late(s, task.name, msToTicks(needMs(dist, task.reach)));
  const left = tripBudgetMs(s.timeOfDay, DEEP_WALK_BACK);
  // (rounded down, as deep.ts does: a tick too late is "2.9 left", not "3.0")
  return left < DEEP_WORTH ? { cause: 'late', text: `${task.name} needs ${DEEP_WORTH / MINUTE} min, ${(Math.floor(left / (MINUTE / 10)) / 10).toFixed(1)} left` } : null;
}

/** What the run may spend at the place, ms: the task's own budget, or what the day leaves after the walk back and a margin. */
function budgetFor(task: WorkTask, dist: number, s: Snapshot): number {
  if (task.reach === 'deep') return tripBudgetMs(s.timeOfDay, DEEP_WALK_BACK);
  return Math.max(0, Math.min(task.budgetMs, ticksToMs(daylightLeft(s.timeOfDay)) - dist / 3 * 1000 - 15_000));
}

/** How long the brain lets a run of the task go on, from its start (the goal's timeout). */
const timeoutOf = (task: WorkTask): number => (task.reach === 'deep' ? 12 * MINUTE : task.budgetMs + 2 * MINUTE);
/** The run's own time left at the place when the brain will stop it, ms: what making room took and the walk there and back come off it. */
const timeLeftFor = (task: WorkTask, dist: number, spentMs: number): number => timeoutOf(task) - spentMs - 2 * dist / 3 * 1000 - 30_000;

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
  const from = (w.next[task.name] ?? 0) % all.length;
  let unready: Decline | undefined;
  let late: { dist: number; d: Decline } | undefined;
  const dry: { id: string; until: number }[] = [];
  for (let i = 0; i < all.length; i++) {
    const index = (from + i) % all.length;
    const v = all[index];
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
    return { variant: v.id, index, dist: v.dist, demoted: !!below, why: `${where}${tried}${below ? ` (${below})` : ''}` };
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
      if (left < MIN_WORK[task.reach]) return `[${variant}] not setting out: making room took ${Math.round(spent / 1000)} s, too little of the run's time is left`;
      budgetMs = Math.min(budgetMs, left);
    }
    const setOut = now();
    if (task.reach === 'deep') { deepStart(ctx.world, setOut); deepOut = true; }
    else if (task.reach === 'far' && isUnblocker(task)) { farDayOf(workOf(ctx.world), ctx.world).unblockers += 1; writes++; }

    let told = 0;
    const r = await task.run({ ...ctx, s, gain: n => { told += n; ctx.gain(n); } }, variant, budgetMs, now);
    // what the task counted at the end and had not told as it went still counts as brought in
    const gain = Math.max(told, fin(r.gain) && r.gain > 0 ? r.gain : 0);
    if (gain > told) ctx.gain(gain - told);
    if (ctx.signal.aborted) throw new Error('aborted');
    // (a trip that never got to the work did not run its course: it never went down)
    ranItsCourse = !r.untried;

    const w = workOf(ctx.world);
    const at = now();
    const mark = w.dry[key];
    // (a mark the task itself wrote on this run stands: it saw the place empty as it left)
    const own = !!mark && mark.at >= setOut;
    // (one that never got to the work learnt nothing of the place: no mark, and it is tried first again)
    if (gain > 0) {
      if (mark && !own) delete w.dry[key];
      w.next[task.name] = c.index;
    } else if (!r.untried) {
      if (!own) markDry(ctx.world, key, at);
      w.next[task.name] = c.index + 1;
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
    // the task stays where its work ended: the way home is the wrapper's, once, for every task
    let away = true;
    try {
      const st = await ctx.status();
      if (s.home && st.position && (st.dimension ?? s.home.dimension) === s.home.dimension) away = horiz(st.position, s.home) > NEAR_HOME;
    } catch { /* no look: the walk home is asked for, and says where the bot is */ }
    if (!away) return end(text);
    // a chore at home cuts in as the walk comes within its reach of home, and shelter at dusk: the run's own line
    // would never be logged then, only "stopped ...: aborted", as if the trip had come to nothing (the coal it
    // brought in, the mark it left). It is said here once, as the run was stopped
    const cut = () => { ctx.progress(`${text}; stopped on the walk home (its marks are written)`); return new Error('aborted'); };
    let h: { ok: boolean; text: string };
    try {
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
  if (w.deep.away !== undefined && (s.distHome <= NEAR_HOME || s.now - w.deep.away >= AWAY_MS)) { delete w.deep.away; wrote = true; }
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
