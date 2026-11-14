// (goals.ts takes walkHome from here, for the walk back and the shelter: each uses the other's exports inside functions only)
import { BELOW_HOME, type GoalContext } from './goals.js';
import type { Pos } from './memory.js';
import { activityAt } from './schedule.js';
import { boxMeetsZone, type Zone } from './courtesy.js';
import { UNDER_BY, columnAbove, fillShaft, homeColumn, inColumn, underYard, type Column } from './underyard.js';
import { inByGate, type WalkContext } from './yardgates.js';

/**
 * Home from wherever the bot is. go-home is Baritone's walk in legs toward home "at any height": from down a mine it
 * plans its way under the ground, straight for home, and into the home zone's column, where the bridge lets Baritone
 * break nothing (underyard.ts). Live on Nov 13 a deep trip was cut short by break out at (-517, -45, 2089), 96 out,
 * the walk back to the yard set out from there, and 70 s on the bot stood 53 under the yard at (-536, 9, 2179): out
 * from under again. So from more than 8 under the ground (or more than 8 below home's level), outside the column, the
 * bot first gets up to the surface where it is, and walks home over the surface from there:
 * - back the way it went down when that is near: the block it stood on where the trip went down (`upAt`), or the mine
 *   start, within 64 across the ground and with the yard's column not on the straight way there (Baritone's own walk:
 *   out here it may dig);
 * - else straight up, to the block over the ground above it (read with world.region), Baritone free to dig its way up
 *   out here. Not with lava or water over its head (it would run down onto the bot), nor by someone else's build.
 *   By the yard the top of the shaft it came up by is filled after it, as out from under fills its own.
 * Under the yard it walks nowhere: there out from under digs out to the side. Nor does it climb at night, or when
 * the climb would come up after dark (the surface is the mobs' then: the shelter walls in where the bot stands, and
 * the morning's walk home climbs out). In water or lava, at any hour, getting out of it is go-home's walk, as it was
 * (walled in there, the bot would stay in it). No climb made (or one that does not get it up) leaves the rest to
 * go-home as before, which says where it stopped; after a trip, toward where it went down first however far, as
 * every walk home after one did. On the surface, or on the yard's level in its column, it is go-home as it always was,
 * and from outside the yard's fence in by one of its gates first (goHome below: never over the fence).
 */

const MINUTE = 60_000;
/** Back the way it went down when that is this near across the ground; further off, straight up where it is. */
const BACK_WITHIN = 64;
/** How long the walk back there may take: the time a deep trip's budget keeps back for the walk back (deep.ts WALK_BACK). */
const WALK_BACK_MS = 2 * MINUTE;
/** Someone else's build on the surface this near the climb's column, across the ground: no climb there. */
const BUILD_ROOM = 8;
/** One under ground (a cellar, an old mineshaft): only where the climb's column itself, or 1 round it, goes through it. */
const CELLAR_ROOM = 1;
/** The climb's time: so long for each block of the way up (Baritone digs a stair or pillars up), within these bounds. */
const CLIMB_MS_PER_BLOCK = 2000;
const CLIMB_MIN_MS = MINUTE;
const CLIMB_MAX_MS = 5 * MINUTE;
/**
 * What a climb is reckoned to take for each block of the way up, to tell whether it comes up before dark: live, out
 * from under's climbs of some 60 blocks took 33 to 77 s with their tunnels. (Its time-out above allows it twice that.)
 */
const CLIMB_PACE_MS = 1000;
/** A game tick, in the time of day. */
const TICK_MS = 50;
/**
 * A climb this near the home zone's column across the ground (14 from the fence) has the top of its shaft filled:
 * there an open shaft is a way down into the caves beside the walks to the gates, and the yard's own dirt and
 * cobblestone (the fence's fill) already keep Baritone from breaking those kinds round it. Further out a fill would
 * be what the bot built there (Protection.java: within 24 of it Baritone breaks nothing of its kind), and the next
 * climb near it would stop under the hill's dirt.
 */
const FILL_WITHIN = 8;
/** The walk home after a climb has at least this long, whatever the climb took of the caller's time. */
const HOME_MIN_MS = MINUTE;

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const floored = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
/** A look that failed (or a fake that has none) is no look: undefined. */
async function attempt<T>(f: () => Promise<T>): Promise<T | undefined> {
  try { return await f(); } catch { return undefined; }
}

type Above = Awaited<ReturnType<typeof columnAbove>>;
const seeAbove = async (ctx: GoalContext, at: Pos): Promise<Above> => (await attempt(() => columnAbove(ctx, at))) ?? { unseen: true };

/** How far down it is, in words: under the ground over its head, or (none seen) below home's level. */
const depthOf = (feet: Pos, above: Above, home: Pos) =>
  (above.ground !== undefined && above.ground > feet.y ? `${above.ground - feet.y} under the ground at ${fmt(feet)}` : `${home.y - feet.y} below home's level at ${fmt(feet)}`);

/** Whether the straight way across the ground from `a` to `b` passes through the column (a step at a time). */
function crosses(col: Column, a: { x: number; z: number }, b: { x: number; z: number }): boolean {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    if (inColumn(col, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return true;
  }
  return false;
}

/**
 * The way it went down, when it is near and the yard's column is not between: `upAt` as the caller knows it (the
 * block it stood on at the mine start), or else the mine start, which is kept at home's level (pickMineStart): the
 * block over the ground there.
 */
async function wayBack(ctx: GoalContext, feet: Pos, col: Column, upAt?: Pos): Promise<{ to: Pos; words: string } | undefined> {
  const near = (q: { x: number; z: number }) => Math.hypot(q.x - feet.x, q.z - feet.z) <= BACK_WITHIN && !crosses(col, feet, q);
  if (upAt) return near(upAt) ? { to: upAt, words: `up where it went down, ${fmt(upAt)}, before the walk home` } : undefined;
  const start = ctx.world.zones?.mine?.[0];
  if (!start || !near(start)) return undefined;
  const there = await seeAbove(ctx, { x: start.x, y: feet.y, z: start.z });
  // its surface reads far below the start's own level: a shaft open to the sky there (Baritone digs straight down
  // where the bot stands), whose floor is no surface to walk home from. Up where it stands instead
  if (there.ground === undefined || there.ground + 1 < start.y - BELOW_HOME) return undefined;
  const to = { x: start.x, y: there.ground + 1, z: start.z };
  return { to, words: `back to the mine start ${fmt(to)} before the walk home` };
}

/** Across the ground from the column's rectangle to a place (0 in it). */
const offColumn = (col: Column, p: { x: number; z: number }) => Math.max(col.x1 - p.x, p.x - col.x2, col.z1 - p.z, p.z - col.z2, 0);

/**
 * Straight up where it stands, to the block over the ground above it, unless what is over its head says not to, or
 * the climb would come up after dark (`hour`: the time of day as the bot sees it where the climb starts). Says what it
 * did, or why not, as the run's progress: `up`, `not` (the walk home follows either way) or `late` (no walk now).
 * By the yard the top of the shaft it came up by is filled (underyard.ts fillShaft).
 */
async function climbOut(ctx: GoalContext, feet: Pos, above: Above, home: Pos, col: Column, hour: { timeOfDay: number; thundering: boolean }): Promise<'up' | 'not' | 'late'> {
  const stopped = () => { if (ctx.signal.aborted) throw new Error('aborted'); };
  const no = (why: string) => { ctx.progress(`no climb from ${fmt(feet)}: ${why}; the walk home as it goes`); return 'not' as const; };
  if (above.unseen) return no('could not look over its head');
  // (open to the sky, deep below home's level: the bottom of a pit, with no ground to climb to)
  if (above.ground === undefined) return no('nothing over its head to climb through');
  if (above.lava) return no(`lava over its head at ${fmt(above.lava)}`);
  if (above.water) return no(`water over its head at ${fmt(above.water)}`);
  const top = { x: feet.x, y: above.ground + 1, z: feet.z };
  let zones: Zone[] | undefined;
  try { zones = (await ctx.call<{ zones?: Zone[] }>('foreign.zones'))?.zones ?? []; } catch { zones = undefined; }
  stopped();
  if (!zones) return no("could not look for anyone's build over it");
  // the way up and a little round it (Baritone's stair goes a step aside now and then), to the top; the bridge would
  // not let it break their blocks, and the climb is not made under them in the first place
  const round = (r: number) => ({ x: feet.x - r, y: feet.y, z: feet.z - r, width: 2 * r + 1, height: top.y + 2 - feet.y, length: 2 * r + 1 });
  const theirs = zones.find(z => boxMeetsZone(round((z.surface ?? true) ? BUILD_ROOM : CELLAR_ROOM), z));
  if (theirs) return no(`someone else's build over it${theirs.sample ? ` (${theirs.sample})` : ''}`);
  // up before dark, or not now: a climb that starts in the evening comes up at night, out where the walk home is
  // over the surface (from 113 under, some 2 minutes)
  const ticks = (top.y - feet.y) * CLIMB_PACE_MS / TICK_MS;
  if ([0, ticks].some(dt => activityAt(hour.timeOfDay + dt, hour.thundering) === 'rest')) return 'late';
  ctx.progress(`${depthOf(feet, above, home)}: up to the surface at ${fmt(top)} before the walk home`);
  const timeoutMs = Math.min(CLIMB_MAX_MS, Math.max(CLIMB_MIN_MS, (top.y - feet.y) * CLIMB_MS_PER_BLOCK));
  const r = await ctx.act('move-to-position', { ...top, range: 1, timeoutMs }).catch((e: Error) => ({ ok: false, text: e.message }));
  stopped();
  if (!r.ok) return no(`the climb to ${fmt(top)} failed (${r.text.slice(0, 120)})`);
  const now = (await attempt(() => ctx.status()))?.position;
  stopped();
  const at = now ? floored(now) : top;
  ctx.progress(`climbed to ${fmt(at)}`);
  if (offColumn(col, feet) <= FILL_WITHIN) {
    const filled = await fillShaft(ctx, col, top, at);
    if (filled) ctx.progress(filled);
  }
  return 'up';
}

/**
 * go-home, and from outside the yard's fence in by one of its gates first (yardgates.ts inByGate): to the cell 2
 * outside the gate on the way home, through it carefully, then go-home from inside the yard as it always went.
 * go-home's own way from out there went straight for home at "any height", and over the fence where that was
 * cheapest (the stair Baritone left over the north gate, the scaffold along the east fence). `timeoutMs` is the whole
 * walk's: the gate takes what it needs of it, go-home the rest (HOME_MIN_MS at least). With no gate known, or none
 * that lets it in (said in the run's progress), go-home as it was. Every walk home goes by this: walkHome below, and
 * the trips' own go-home between their legs.
 */
export async function goHome(ctx: WalkContext & Pick<GoalContext, 'act'>, timeoutMs: number): Promise<{ ok: boolean; text: string }> {
  const began = Date.now();
  const gate = await inByGate(ctx, timeoutMs - HOME_MIN_MS);
  if (gate.shut) ctx.progress(`${gate.shut}: home by go-home's own way`);
  const walked = !!(gate.gate || gate.shut);
  return ctx.act('go-home', { name: 'home', timeoutMs: walked ? Math.max(HOME_MIN_MS, timeoutMs - (Date.now() - began)) : timeoutMs });
}

/**
 * Walk home from where the bot is (see above): what go-home answered, or why it did not walk (`ok` false: under the
 * yard, or deep down at night or too late in the evening to climb out before dark: `night`, for the shelter to wall
 * in). `upAt`: where the run went down, when it knows. `timeoutMs`: the walk's whole time, go-home's as before when
 * there is nothing to climb.
 */
export async function walkHome(ctx: GoalContext, opts: { timeoutMs: number; upAt?: Pos }): Promise<{ ok: boolean; text: string; night?: true }> {
  const began = Date.now();
  const stopped = () => { if (ctx.signal.aborted) throw new Error('aborted'); };
  const look = async () => { const st = await attempt(() => ctx.status()); stopped(); return st; };
  /** go-home, as every walk home was (in by a gate from outside the fence); after the way up (`spent`), with what is left of the walk's time */
  const toHome = (spent = false) => goHome(ctx, spent ? Math.max(HOME_MIN_MS, opts.timeoutMs - (Date.now() - began)) : opts.timeoutMs);
  const home = ctx.s.home;
  const yard = ctx.world.yard;
  const st = await look();
  // no home, another dimension, or no look at where it stands: nothing to climb from, the walk as it was
  if (!home || !st?.position || (st.dimension ?? home.dimension) !== home.dimension) return toHome();
  let feet = floored(st.position);
  const under = (p: Pos) => ({ ok: false, text: `under the yard at ${fmt(p)}: out from under digs out to the side first` });
  if (underYard(feet, home, yard)) return under(feet);
  const col = homeColumn(home, yard);
  // in the column on the yard's level or over it (the lawn, the paths, a tower): the walk as it was
  if (inColumn(col, feet)) return toHome();
  let above = await seeAbove(ctx, feet);
  stopped();
  // (no look over its head: below home's level is all that can be told)
  const deep = (p: Pos, a: Above) => p.y < home.y - BELOW_HOME || (a.ground !== undefined && a.ground - p.y > UNDER_BY);
  if (!deep(feet, above)) return toHome();
  // in water or lava, by day or night: getting out of it is go-home's walk (the wall-in leaves the bot's own cells as
  // they are: walled in there, it would stay in the lava, or under the water with a roof over its head)
  if (st.inLava || st.underWater) {
    ctx.progress(`${depthOf(feet, above, home)}, in ${st.inLava ? 'lava' : 'water'}: no climb from there, the walk home as it goes`);
    return toHome();
  }
  // the hour as the bot sees it now (the run's snapshot may be from the morning it set out in)
  let hour = { timeOfDay: st.timeOfDay ?? ctx.s.timeOfDay, thundering: st.thundering ?? ctx.s.thundering };
  const activity = st.timeOfDay === undefined ? ctx.s.activity : activityAt(st.timeOfDay, hour.thundering);
  if (activity === 'rest') return { ok: false, night: true, text: `${depthOf(feet, above, home)}: no climb to the surface at night (the walk home climbs out by day)` };
  const back = await wayBack(ctx, feet, col, opts.upAt);
  stopped();
  if (back) {
    ctx.progress(back.words);
    const walk = await attempt(() => ctx.call<{ arrived?: boolean }>('goto', { ...back.to, range: 1, timeoutMs: WALK_BACK_MS }, WALK_BACK_MS + 15_000));
    stopped();
    if (walk?.arrived === true) return toHome(true);
    // not got there (the start gone, a build in the way): up from wherever it stands now, at the hour it is now
    const again = await look();
    if (!again?.position) return toHome(true);
    if (again.timeOfDay !== undefined) hour = { timeOfDay: again.timeOfDay, thundering: again.thundering ?? hour.thundering };
    feet = floored(again.position);
    if (underYard(feet, home, yard)) return under(feet);
    if (inColumn(col, feet)) return toHome(true);
    above = await seeAbove(ctx, feet);
    stopped();
    if (!deep(feet, above)) return toHome(true);
  }
  const climb = await climbOut(ctx, feet, above, home, col, hour);
  if (climb === 'late') return { ok: false, night: true, text: `${depthOf(feet, above, home)}: no climb to the surface this late (it would come up after dark: the walk home climbs out by day)` };
  // no climb made out here, after a trip that went down further off than the way back goes: toward where it went
  // down all the same, a while, as every walk home after a trip did; never across the yard's column
  const upAt = opts.upAt;
  if (climb === 'not' && upAt && !back && !crosses(col, feet, upAt)) {
    ctx.progress(`up where it went down, ${fmt(upAt)}, before the walk home`);
    await attempt(() => ctx.call('goto', { ...upAt, range: 1, timeoutMs: WALK_BACK_MS }, WALK_BACK_MS + 15_000));
    stopped();
  }
  return toHome(true);
}
