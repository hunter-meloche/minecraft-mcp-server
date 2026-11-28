import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import type { Zone } from './courtesy.js';
import { brainRun } from '../tools.js';
import { out as afield } from './pockets.js';
import { Ground, offSegment, readBand } from './boatroute.js';
import {
  APPROACH_FIRST_S, APPROACH_S, ARRIVE_S, BELL, FIRST_TRIES, GATE_OPEN_MAX, HOLD_MS, HOP_LEN, HOP_MAX, HOP_MIN, IN_BY, LAST_P, LURES, MISSES, MISSES_TRIP,
  NEUTRAL_MAX, NIGHT, RELEASE_R, RIVAL_R, SESSION, STILL_S, YARD_HOP, clock, dropEntry, endTrip, fetchOf, floorOk, journal, needLeft, needParts, newTrip,
  noteWhy, peekFetch, reconcile, restoreAll, settle, startLate, startNeed, tripTo, beat, cutTrip, undo, wardSeen,
  type Change, type ClockSays, type FetchMemory, type LureClock, type Looked, type Trip, type Ward, type WardSight, type YardGateWay
} from './fetch.js';
import {
  RETRACE_DROP, botStand, corridor, firstSpot, gateLane, hopSpot, inLock, lockOf, pathFor, reachCells, ringPlanOf, stand, withBlock, yardWay, isStand,
  type Area, type Circle, type HopSpot, type JobSite, type Lock, type YardGround
} from './villagerwalk.js';
import { SIDE_STEP, gateRead, gatesRead, outByGate, shutGate, yardGates, type YardGate } from './yardgates.js';
import { ILLAGER, JOB_SITE, peekVillages, pennedIn, siteNow, usedHow, variantOf, villagesOf, type Seen, type VillageSite } from './village.js';
import { dangerAt, dryNext, here, lureSite, playerNow, say, walkOut, PLAYER_SIGHT } from './villagemove.js';
import { readShells } from './hallshells.js';
import { gameDay, hallBeds, hallChoresOf, hallSites, headcount, inHallBox, noteHall } from './hallchores.js';
import { prepare } from './project.js';
import { CHEST_SPARE, FOOD_TARGET, gatherFood, readyFoodPoints } from './food.js';
import { makeRoom } from './pockets.js';
import { WORK_AT } from './schedule.js';

/**
 * The villager fetch by the job-site lure, its acts (idle-plan V, sections 4.1, 4.3, 4.5, 4.6, 4.8, 4.9): PREP the day
 * before (the reads, the kit, the bot's own job blocks lifted out of the way), the trip itself from the dawn's walk out
 * (`fetchRun`, the `villagers` rung's run), and the hop loop (`leadOn`) that care's resume and the armed rescue go on
 * from: a fletching table put down near an unemployed adult, the villager walks to it and takes the job, the table is
 * broken (jobless at once), carried about 22 on and put down again, through the yard's gate, across the yard, into the
 * lock in front of the hall and on into the hall to its free lectern.
 *
 * Why this way: on Nov 23-24 the lead drove it by hand and two villagers came ~175 blocks over a hillside in about four
 * minutes each, nothing ridden and nothing built; about 60 hops with a walkable way and no nearer free job block
 * arrived in 4-18 s (E-results E8). Everything that went wrong was round the hop: the workshop's smithing table took
 * the villager three times, the bell took it back at 9000 and the bed at 12000, the yard was no pen (the bot's own
 * scaffold over the fence), the Nether portal swallowed it, and the hall's gate let villagers out whenever it stood open
 * with one awake. Each has its answer here: the lifts (held until no villager is out), the clock (the lock's gate shut
 * by 8700), the lock (two gates never open together, the lure in a wall socket), and the journal (fetch.ts): every
 * block put down or taken away, every gate held, written and SAVED before the act, undone from it after any end.
 *
 * Every walk while a villager is led is a careful one (Baritone breaks and places nothing by it: a scaffold block or a
 * dug step beside it is how the bot's own walk would trap it), every click on a gate is the raw call after a careful
 * walk (yardgates.ts shutGate), and every wait runs on a LureClock handed down (a test's is game time).
 */

// ------------------------------------------------------------------------------------------------ the numbers

/** The watch polls this often (the bot stays on its standing cell, looking at the lure). */
const POLL_MS = 500;
/** A PREP part's stamp older than this (6000 ticks) is done again: what it read is no longer what stands. */
const STALE_MS = 6000 * 50;
/** PREP's hours: its reads and kit from 6000 on the day before, its lifts from 9000 (or at dawn), all by 12300 (the bot abed by 12542). */
const PREP_FROM = 6000;
const LIFTS_FROM = 9000;
const PREP_TO = 12_300;
/** The lifts finished at dawn only while `tod + need + LIFTS_SLACK_S` still fits (each lift is about 20 s). */
const LIFTS_SLACK_S = 30;
/** No lure before this time of day: a villager is abed until 10, and a look at 0-99 finds them rising. */
const UP_AT = 100;
/** The bot fed to this before a trip, and whole to this (PREP's kit); held and fed on the way below these. */
const FED = 18;
const WHOLE = 16;
const HUNGRY = 12;
const HURT = 10;
/** Free pocket slots a trip wants (the drops of the lifts, a lure's drop) and 3 more for each small holder lifted. */
const SLOTS_FREE = 4;
const HOLDER_SLOTS = 3;
const SLOTS = 36;
/** The band read either side of the way home, and how far round the bot a read reaches (the chunks it holds). */
const BAND = 24;
const READ_NEAR = 80;
/** The look's reach for the ward (by uuid), and for players (playerNow: within 32 of the bot or the ward, seen to 128). */
const SEE_R = 64;
const PLAYER_R = 32;
const PLAYER_HOLD_S = 60;
/** A job site of the bot's own within this of where the walk home ends (the way's last cells to the yard gate's outer cell) is lifted. */
const LAST_WAY = 48;
/** The flip: the ward within this of the lure with its profession (the game takes it within 2.0 of the block's middle). */
const FLIP_R = 2.5;
/** A break is made with the ward within this (the game notices a job site gone only within 16: jobless at once). */
const NOTICE_R = 16;
/** A ward gone from the look this long is looked for; for this long after that, then astray. */
const GONE_S = 3;
const SEARCH_S = 60;
/** The first lure: a spot nearer the nearest candidate after no approach (within this many cells), another 40 off after a claimant not acceptable. */
const NEARER_FIRST = 12;
const ELSEWHERE = 40;
/** A villager by the first lure this long with no flip (a nitwit, a baby, one employed) moves it one cell off, once; a nitwit or a baby, this far off. */
const BY_LURE_S = 10;
const BY_ELSEWHERE = 8;
/** A slow approach is waited out to this, a miss to this, then the lure moves. */
const SLOW_MAX_S = 60;
const MISS_MAX_S = 20;
/** Committed and late (the clock's 'run on'): the waits cut to these. */
const RUN_ON_APPROACH_S = 8;
const RUN_ON_ARRIVE_S = 30;
/** The ward's way through the yard gate: through 1.5 inside the fence line; the gate held 35 s at most with it standing in the gateway. */
const THROUGH = 1.5;
const GATE_IN_GATEWAY_MAX = 35_000;
/** A critical section round the yard gate's and the lock's steps (only flight cuts them). */
const CRITICAL_MS = 45_000;
/** Animals of the bot's near a gate: waited out this long. */
const ANIMAL_WAIT_S = 10;
/** The lock: the ward through P within GATE_OPEN_MAX; steps 3-5 tried this many times in all. */
const LOCK_TRIES = 3;
/** DOOR: two reads this far apart find no villager in the lock and the ward in the hall; the run waits for them this long, then care does. */
const DOOR_GAP_S = 10;
const DOOR_WAIT_S = 90;
/** Who stands about the socket as it opens: a baby within this is waited out. */
const BABY_R = 3;
/** Monsters the watch answers (4.3's guards). */
const ZOMBIE = /^(zombie|husk|drowned|zombie_villager)$/;
const ZOMBIE_R = 16;
const PANIC_R = 12;
const CREEPER_R = 12;
const AWAY_FROM_WARD = 10;
const HOSTILE_HOLD_S = 20;
/** D27: an iron golem within this of the ward's way to the next lure stands in its lane: waited for, then the hop aside of it, this far. */
const GOLEM_LANE = 1.5;
const GOLEM_WAIT_S = 10;
const GOLEM_ASIDE = 3;
/** D29: a ward that strolled more than 16 off its lure (before 2000 the lure is no pin) is waited for this long to come back by it before the break. */
const BACK_S = 30;
/** E34: a pen's gate held for the ward this long at most (as G is, 4.6), its animals by the gate inside waited out. */
const PEN_OUT_S = 25;
/** The lure, fixed in S1 (decision 16), and the profession it gives. */
const LURE = 'fletching_table';
const GIVES = 'fletcher';
/** The job-site kinds world.findBlocks is asked for one at a time (village.ts JOB_SITE; centred on the bot, 128 at most). */
const KINDS = ['lectern', 'composter', 'barrel', 'blast_furnace', 'smoker', 'cartography_table', 'brewing_stand', 'cauldron', 'water_cauldron', 'lava_cauldron',
  'powder_snow_cauldron', 'fletching_table', 'grindstone', 'loom', 'smithing_table', 'stonecutter'] as const;
const SCAN_R = 128;
/** What drops with a small holder: picked up (its slots counted in the kit's room). A barrel's 27 stacks are not lifted at all. */
const HOLDERS = /^(brewing_stand|smoker|blast_furnace)$/;
const NOT_LIFTED = /^barrel$/;
/** The walk out scans for job sites every this many blocks. */
const SCAN_EVERY = 96;
/**
 * The bot's own thin blocks UNWEDGE lifts from beside a still ward (never a gate, a ring's post, a pen's or the lock's).
 * Never a container or a bed: a chest dug with dig.here spills its stacks and goes back an empty single chest (4.5
 * lifts no barrel for that), and a bed's break moves the bot's spawn.
 */
const THIN = /(_fence|_stairs|_slab|_wall|_trapdoor|_pane|iron_bars|lantern)$/;

// ------------------------------------------------------------------------------------------------ small things

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const cell = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const mid = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
const same = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fmt = (p: Pos) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const idOf = (state: string | null | undefined) => (state ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const inArea = (a: Area | undefined, p: { x: number; z: number }) => !!a && p.x >= a.x1 && p.x <= a.x2 && p.z >= a.z1 && p.z <= a.z2;
const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));
const stopped = (ctx: Pick<GoalContext, 'signal'>) => { if (ctx.signal.aborted) throw new Error('aborted'); };
const short = (uuid: string) => uuid.slice(0, 8);
/** The time of day as the work day runs: from 23500 on (the bot's dawn) the minutes before 0, as a negative. */
const morning = (tod: number) => { const t = ((tod % 24_000) + 24_000) % 24_000; return t >= WORK_AT ? t - 24_000 : t; };

/** The clock of a run: what the rung hands on (villagemove.ts Clock: its time, budget and `enough`) with a sleep. */
export interface RunClock extends LureClock { began?: number; budgetMs?: number; enough?: () => boolean }
/** A LureClock on real time, for the rung's run and care (a test hands one of game time: the pasture's). */
export const lureClock = (now: () => number = Date.now): LureClock => ({ now, sleep: ms => new Promise<void>(res => setTimeout(res, Math.max(0, ms))) });

/** The snapshot's time and the real time since: PREP's clock where none is handed down. */
const realClock = (ctx: Pick<GoalContext, 's'>): LureClock => { const t0 = Date.now(); return lureClock(() => ctx.s.now + (Date.now() - t0)); };

/** A box of world.zones (width and length) as an Area. */
const areaOf = (z: { x: number; z: number; width?: number; length?: number } | undefined): Area | undefined =>
  z && fin(z.width) && fin(z.length) ? { x1: z.x, z1: z.z, x2: z.x + z.width - 1, z2: z.z + z.length - 1 } : undefined;
/** The yard's fence box: the bot's own ground. */
const yardArea = (world: WorldMemory): Area | undefined => (world.yard ? { x1: world.yard.x1, z1: world.yard.z1, x2: world.yard.x2, z2: world.yard.z2 } : undefined);
/** The yard as the villager's walk sees it: its box and ground's level; the bot's own blocks in it are not known here (no builtNear on a goal's context), so every stray kind above the ground is scaffold to the lead rules: the safe side. */
const yardGround = (world: WorldMemory): YardGround | undefined => (world.yard ? { ...yardArea(world)!, y: world.yard.y, built: [] } : undefined);
const inYard = (world: WorldMemory, p: { x: number; z: number }) => inArea(yardArea(world), { x: Math.floor(p.x), z: Math.floor(p.z) });

// ------------------------------------------------------------------------------------------------ what a run keeps in memory

/**
 * What a run has read and planned for its trip (not on disk: a resume reads it all again from the ground, which is the
 * point, since lanes, ways and rivals are read fresh every time): the ground, the corridor home, the yard's way, the
 * job sites seen, the builds kept off, the cells lures stood in (the game's retry backoff), the anchor's cell, the
 * ward's last healths.
 */
interface Plan {
  trip: number;
  ground: Ground;
  site?: VillageSite;
  home?: Area;
  zones: Zone[];
  sites: JobSite[];
  way?: Pos[];
  yard?: Pos[];
  used: { at: Pos; t: number }[];
  anchorAt?: Pos;
  health: number[];
  misses: number;
  screens: number;
  player?: { since: number; who: string };
  walked: number;
  hurtBy: number;
  /** circles the next lure's cell keeps out of (not the ward's way): 8 round a pin, 40 round a lure a villager not to take took */
  pinAvoid?: Circle[];
  /** a still ward's UNWEDGE: which step it is on, where */
  wedge?: { ward: string; at: Pos; stage: number };
  /** the village's marks (foreign.marks, any kind) the first lure keeps 3 off */
  marks?: Pos[];
  /** D27: an iron golem in the ward's lane that did not go: the next spot's way keeps this far off it */
  golem?: Circle;
  /** D29: the lure whose break waits for the ward to come back by it, and till when (once a lure) */
  waitBack?: { lure: string; until: number };
  /** E34: the pens whose gate the ward was led out by (once a pen) */
  pensOut?: string[];
  /** the corridor begins where no candidate stands (none has a way by the model): the first lure's home side is then the gate's */
  wayNotFromCandidate?: boolean;
  /** when the ward's health last fell, and the last hostile seen within 8 of it: a ward gone within 3 s of either is dead (2.1) */
  fellAt?: number;
  hostileBy?: { name: string; t: number };
}
const plans = new WeakMap<WorldMemory, Plan>();

/** The trip's ground: from under the lower of home and the village to 24 over the higher (boatroute.ts Ground). */
function groundFor(world: WorldMemory, site?: { y: number }): Ground {
  const home = world.yard ? world.yard.y + 1 : site?.y ?? 64, there = site?.y ?? home;
  const y0 = Math.min(home, there) - 8;
  return new Ground(y0, Math.min(64, Math.abs(home - there) + 24 + 8));
}
function planOf(world: WorldMemory, trip: Trip, site?: VillageSite): Plan {
  const p = plans.get(world);
  if (p && p.trip === trip.id) { if (site) p.site ??= site; return p; }
  const fresh: Plan = { trip: trip.id, ground: groundFor(world, site), site, zones: [], sites: [], used: [], health: [], misses: 0, screens: 0, walked: 0, hurtBy: 0 };
  if (site?.area) fresh.home = { ...site.area };
  plans.set(world, fresh);
  return fresh;
}

/** The site of a trip among the remembered ones (by the `x,z` its variant ends in), read only. */
export function siteOfTrip(world: WorldMemory, trip: Pick<Trip, 'site'>): VillageSite | undefined {
  const m = /(-?\d+),\s*(-?\d+)\s*$/.exec(trip.site);
  return m ? peekVillages(world).sites.find(s => s.x === Number(m[1]) && s.z === Number(m[2])) : undefined;
}
/** The same site, the live record of it (a write's: site.fetch, site.whole, site.moved). */
const liveSite = (world: WorldMemory, trip: Pick<Trip, 'site'>): VillageSite | undefined => {
  const m = /(-?\d+),\s*(-?\d+)\s*$/.exec(trip.site);
  return m ? villagesOf(world).sites.find(s => s.x === Number(m[1]) && s.z === Number(m[2])) : undefined;
};

/** A ward taken off the records between two looks of the lead (the brain's gate watch runs wardSeen beside it: someone has it now). */
const OFF_RECORDS = 'its ward is off the records (someone has it)';
/** The ward the trip leads. */
const wardOf = (f: FetchMemory): Ward | undefined => (f.trip?.ward ? f.wards.find(w => w.key === f.trip!.ward) : undefined);

// ------------------------------------------------------------------------------------------------ looks

/** One look of the watch: the bot's state (status) and who is about (world.entities; `ok` false: that call failed, its rows unknown). */
interface Look { me: Pos; tod: number; health: number; food: number; screen: string | null; rows: Looked[]; ok: boolean; now: number }
async function lookNow(ctx: GoalContext, clk: LureClock, r = SEE_R): Promise<Look> {
  const st = await ctx.status().catch(() => undefined);
  const e = await ctx.call<{ entities?: Looked[] }>('world.entities', { maxDistance: r }).catch(() => undefined);
  return {
    me: st?.position ?? ctx.s.position, tod: fin(st?.timeOfDay) ? st!.timeOfDay! : ctx.s.timeOfDay, health: st?.health ?? ctx.s.health, food: st?.food ?? ctx.s.food,
    screen: st?.screen ?? null, rows: Array.isArray(e?.entities) ? e.entities : [], ok: Array.isArray(e?.entities), now: clk.now()
  };
}
/** The time of day as read now (status), else the snapshot's. */
async function todNow(ctx: GoalContext): Promise<number> {
  const st = await ctx.status().catch(() => undefined);
  return fin(st?.timeOfDay) ? st!.timeOfDay! : ctx.s.timeOfDay;
}

/**
 * The free job sites within `r` of the bot (4.5): world.findBlocks once per kind (one name a call, centred on the bot).
 * A lure of the bot's own in the journal is no rival: it is the trip's.
 */
async function sitesNear(ctx: GoalContext, r = SCAN_R): Promise<JobSite[]> {
  const lures = fetchOf(ctx.world).journal.filter(e => e.k === 'lure').map(e => e.at);
  const out: JobSite[] = [];
  for (const name of KINDS) {
    stopped(ctx);
    const got = await ctx.call<{ positions?: Pos[] }>('world.findBlocks', { block: name, maxDistance: Math.min(r, SCAN_R), count: 64 }).catch(() => undefined);
    for (const p of got?.positions ?? []) if (!lures.some(l => same(l, p))) out.push({ at: cell(p), name });
  }
  return out;
}
/** Whose a job site is (4.5): the hall's (never touched), the bot's own (in its yard, or one of its zones or landmarks), the origin village's (in its area), else someone's or nobody's: all the same to a villager. */
type SiteWhose = 'hall' | 'own' | 'village' | 'foreign';
function whose(world: WorldMemory, s: JobSite, home?: Area): SiteWhose {
  if (inHallBox(world, s.at)) return 'hall';
  if (inYard(world, s.at)) return 'own';
  const zoned = Object.values(world.zones ?? {}).some(zs => zs.some(z => z.x === s.at.x && z.y === s.at.y && z.z === s.at.z));
  const marked = Object.values(world.landmarks ?? {}).some(v => !!v && !Array.isArray(v) && typeof v === 'object' && same(v as Pos, s.at));
  if (zoned || marked) return 'own';
  return home && inArea(home, s.at) ? 'village' : 'foreign';
}
/**
 * The hall's box as an Area, and whether its gate H reads shut (a job site inside it is no rival then). Out of sight
 * (the bot at the village) H is taken as the gate watch last read it (fetch.gates: a strict gate the bridge keeps shut).
 */
async function hallFor(ctx: GoalContext): Promise<{ box: Area; shut: boolean } | undefined> {
  const box = areaOf(ctx.world.zones?.hall?.[0]), h = ctx.world.zones?.['hall:gate']?.[0];
  if (!box) return undefined;
  if (!h) return { box, shut: true };
  const read = await gateRead(ctx, h);
  return { box, shut: read === undefined ? !peekFetch(ctx.world).gates?.open.some(g => same(g, h)) : !read };
}
/** The cells a lift of the journal holds (their job sites exempt from the rival test: lifted) and this trip's lures. */
const liftedCells = (f: FetchMemory) => f.journal.filter(e => e.k === 'lift').map(e => e.at);
/** The same for a plan: a dry trip's would-be lifts (the bot's own job sites it saw) count as made, so the plan is the real one's. */
const liftedFor = (world: WorldMemory, plan: Plan, t: Trip) => [...liftedCells(fetchOf(world)), ...(t.dry ? plan.sites.filter(s => whose(world, s) === 'own').map(s => s.at) : [])];
const tripLures = (f: FetchMemory, trip: number) => f.journal.filter(e => e.k === 'lure' && e.trip === trip).map(e => e.at);

// ------------------------------------------------------------------------------------------------ PREP (4.1, 4.5)

/**
 * The village tomorrow's trip is for (2.2's first row; pure; care row 10's gate): villagemove.ts lureSite, the one
 * choice of it (the rung's stay-in asks the same): the switches, nothing owed on the records, the hall, the lock and the
 * ring as last read, then the villages open to the lure (village.ts siteOpen: its own waits, by kind, doubling) and
 * ready for a trip (lureState: a free word of today's judge on a whole look still under 72 h old at 9000 tomorrow,
 * unemployed adults at its last look, a take left at the floor, the morning enough), the nearest by its need first.
 * Or why none.
 */
export function prepSite(s: { now: number; timeOfDay: number; home?: { x: number; z: number }; position: Pos }, world: WorldMemory): { site: VillageSite; needS: number } | { why: string } {
  const r = lureSite(s, world);
  return 'why' in r ? { why: r.why } : { site: r.site, needS: r.needS };
}

/** Why PREP or a trip may not begin at all (the switches, inert by default): undefined when they let it. */
function switchesWhy(world: WorldMemory): string | undefined {
  const f = peekFetch(world);
  if (world.villagerMoves !== true) return 'villager moves are off';
  if (f.method !== 'lure') return `the method is ${f.method ?? 'boat'}, not the lure`;
  if (f.halt) return `halted: ${f.halt.why}`;
  if (f.armed === undefined || (f.armed !== 'free' && f.armed <= 0)) return 'not armed (villager-moves {arm: 1})';
  return undefined;
}

/** What the hall asks of an arrival (4.1 part 1b): a free bed, the fletcher's table not out, the only free job blocks lecterns (at least one more than its jobless adults), 4 at most. */
async function hallWhyNot(ctx: GoalContext, now: number, tod: number): Promise<string | undefined> {
  const h = ctx.world.zones?.hall?.[0];
  if (!h || !fin(h.width) || !fin(h.length)) return 'no villager hall';
  const seen = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128, type: 'villager' }).catch(() => undefined);
  const box = { x: h.x, y: h.y + 1, z: h.z, width: h.width, height: 3, length: h.length };
  const r = await ctx.call<{ blocks?: (string | null)[] }>('world.region', box).catch(() => undefined);
  if (!Array.isArray(seen?.entities) || !r?.blocks || r.blocks.some(b => b === null)) return 'the hall could not be read whole';
  noteHall(ctx.world, seen.entities, now, true, tod);
  const census = hallChoresOf(ctx.world).census?.villagers ?? [];
  const beds = hallBeds(ctx.world).length;
  if (beds < census.length + 1) return `no free bed in the hall (${beds} beds, ${census.length} villagers): the beds chore first`;
  if (fin(hallChoresOf(ctx.world).fletcher?.siteOut)) return 'the hall\'s fletching table is out (a reroll took it up): it goes back first';
  const blocks: { at: Pos; name: string }[] = [];
  r.blocks.forEach((b, i) => {
    if (!b || !JOB_SITE.test(idOf(b))) return;
    const x = i % box.width, z = Math.floor(i / box.width) % box.length, y = Math.floor(i / (box.width * box.length));
    blocks.push({ at: { x: box.x + x, y: box.y + y, z: box.z + z }, name: idOf(b) });
  });
  const { free, sites } = hallSites(ctx.world, blocks);
  const idle = headcount(census).unemployed.length;
  const other = Object.entries(free).filter(([k, n]) => k !== 'lectern' && n > 0);
  if (other.length) {
    const [kind] = other[0], at = sites.find(s => s.block === kind && !s.holder)?.at ?? blocks.find(b => b.name === kind)!.at;
    return `a free ${kind} stands in the hall at ${fmt(at)}: the arrival would be a ${sites.find(s => s.block === kind)?.profession ?? kind}; villager-plan shows whose is whose`;
  }
  if ((free.lectern ?? 0) < 1 + idle) return `no free lectern in the hall for the arrival (${free.lectern ?? 0} free, ${idle} jobless there)`;
  const all = Object.values(free).reduce((a, n) => a + n, 0);
  if (all > 4) return `${all} free job blocks in the hall: 4 at most (the game looks at the five nearest)`;
  return undefined;
}

/** What may stand in a gate's lane (yardgates.ts CLEAR, and the gate itself), and the bot's own strays there (tidy.ts STRAY above the yard's ground). */
const CLEAR_LANE = /^(air|cave_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|leaf_litter|dandelion|poppy|\w+_tulip|cornflower|oxeye_daisy|azure_bluet|allium|blue_orchid|lily_of_the_valley|snow)$/;
const STRAY = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack)$/;

/**
 * A gate's lane read 2 high from 3 outside to 6 inside (4.1 part 1c): the bot's own strays dug by the tidy rule
 * (unrecorded scaffold kinds above the yard's ground: the north gate's lane had its cobblestone at head height one out,
 * Nov 24), then anything else in it, or a rise or a drop over one along it, refuses the gate (the west gate's 3-drop).
 * Outside the fence the ground is not the bot's: as tidy.ts (FENCE_OUTSIDE) only the step against the gate is taken for
 * a stray, and only while nothing of a stray kind stands farther out in the lane (that is a bank of the land's, like
 * the west gate's natural rise 3 out, or someone's); farther out only a block the bot's own record names (own.take
 * with no `adopt`), else the gate is refused (INV-6). A dry trip's (`how` 'dry') digs nothing: a stray is said and
 * planned on as dug, so the dry plan is the real one's. Undefined: free.
 */
export async function laneWhy(ctx: GoalContext, g: Ground, gate: YardGate, how: 'dig' | 'dry'): Promise<string | undefined> {
  const yardY = ctx.world.yard?.y ?? gate.gate.y - 1;
  const [ox, oz] = SIDE_STEP[gate.side], outBy = (c: Pos) => (c.x - gate.gate.x) * ox + (c.z - gate.gate.z) * oz;
  const lane = gateLane(gate.gate, gate.side);
  const bank = lane.some(c => outBy(c) >= 2 && c.y > yardY && STRAY.test(idOf(g.state(c.x, c.y, c.z))));
  for (const c of lane) {
    if (same(c, gate.gate)) continue;
    const st = g.state(c.x, c.y, c.z);
    if (st === undefined || st === null) return `the lane not read at ${fmt(c)}`;
    const id = idOf(st);
    if (CLEAR_LANE.test(id) || /torch$/.test(id)) continue;
    if (STRAY.test(id) && c.y > yardY) {
      const out = outBy(c), adopt = out <= 0 || (out === 1 && !bank);
      if (how === 'dry') {
        if (!adopt) return `${id} in the ${gate.side} gate's lane at ${fmt(c)}, ${out} outside the fence: not the bot's to dig`;
        g.set(c.x, c.y, c.z, 'air');
        say(ctx, `prep (dry): would dig the ${id} in the ${gate.side} gate's lane at ${fmt(c)} (a stray of the bot's own)`);
        continue;
      }
      if (ctx.own) {
        const r = await ctx.own.take(c, id, adopt ? { adopt: true } : {});
        if (r.ok) { g.set(c.x, c.y, c.z, 'air'); say(ctx, `the ${id} in the ${gate.side} gate's lane at ${fmt(c)} dug (a stray of the bot's own)`); continue; }
      }
      if (!adopt) return `${id} in the ${gate.side} gate's lane at ${fmt(c)}, ${out} outside the fence: not the bot's to dig`;
    }
    return `${id} in the ${gate.side} gate's lane at ${fmt(c)}`;
  }
  // the floor along it: no rise or drop over one (a step a villager climbs back)
  let last: { f: number; at: Pos } | undefined;
  for (let n = 3; n >= -6; n--) {
    const x = gate.gate.x + n * ox, z = gate.gate.z + n * oz;
    let s: ReturnType<typeof stand> | undefined;
    for (const y of [gate.gate.y, gate.gate.y - 1, gate.gate.y + 1, gate.gate.y - 2, gate.gate.y - 3]) {
      const t = stand(g, x, y, z, 'lead', { open: [gate.gate] });
      if (isStand(t)) { s = t; break; }
    }
    if (!s || !isStand(s)) return `no floor a villager walks at (${x}, ${z}) in the ${gate.side} gate's lane`;
    if (last && Math.abs(s.f - last.f) > RETRACE_DROP + 1e-6) return `a ${s.f > last.f ? 'rise' : 'drop'} of ${Math.round(Math.abs(s.f - last.f) * 10) / 10} at (${x}, ${Math.floor(s.f)}, ${z}) in the ${gate.side} gate's lane`;
    last = { f: s.f, at: { x, y: s.y, z } };
  }
  return undefined;
}

/** The yard and its lanes read into a ground (one world.region a tile). */
async function readYard(ctx: GoalContext, g: Ground): Promise<void> {
  const y = ctx.world.yard;
  if (y) await g.read(ctx, y.x1 - 4, y.z1 - 4, y.x2 + 4, y.z2 + 4);
}

/**
 * The yard gates with a lane and a villager's way across the yard to S_out (4.1 part 1c), the shortest yard way first,
 * ties by the straight way from the site to the gate's outer cell: the trip's gate and its spares. Or why none.
 */
async function gateWays(ctx: GoalContext, g: Ground, lock: Lock, site: { x: number; z: number }, how: 'dig' | 'dry'): Promise<{ ways: YardGateWay[]; cells: Map<string, Pos[]> } | { why: string }> {
  const ring = ringPlanOf(ctx.world)?.zone;
  const ringArea = ring ? { x1: ring.x, z1: ring.z, x2: ring.x + ring.width - 1, z2: ring.z + ring.length - 1 } : undefined;
  const ways: (YardGateWay & { straight: number })[] = [], cells = new Map<string, Pos[]>(), why: string[] = [];
  for (const gate of yardGates(ctx.world)) {
    stopped(ctx);
    const lane = await laneWhy(ctx, g, gate, how);
    if (lane) { why.push(lane); continue; }
    const w = yardWay(g, gate, lock.sOut, { yard: yardGround(ctx.world), ...(ringArea ? { ring: ringArea } : {}) });
    if (!w.ok) { why.push(`the ${gate.side} gate: ${w.text}`); continue; }
    ways.push({ at: gate.gate, side: gate.side, inner: gate.inner, outer: gate.outer, yard: w.len, straight: horiz(site, gate.outer) });
    cells.set(gate.side, w.cells);
  }
  if (!ways.length) return { why: `no villager way from a gate to the lock: ${why.join('; ') || 'no yard gate'}` };
  ways.sort((a, b) => a.yard - b.yard || a.straight - b.straight);
  return { ways: ways.map(({ straight: _s, ...w }) => w), cells };
}

/**
 * The bot's own job sites by the way in (4.5): outside the hall, within RIVAL_R of the yard's way, of the gate's lane
 * or of the last 48 blocks of the way to its outer cell. A barrel is not lifted (27 stacks): the trip is declined with
 * its place; more than NEUTRAL_MAX: declined with the list.
 */
function ownByWay(world: WorldMemory, sites: readonly JobSite[], gate: YardGateWay, yardCells: readonly Pos[], site: { x: number; z: number }): { lift: JobSite[] } | { why: string } {
  const lane = gateLane(gate.at, gate.side), toward = { x: site.x - gate.outer.x, z: site.z - gate.outer.z }, len = Math.hypot(toward.x, toward.z) || 1;
  const far = { x: gate.outer.x + toward.x / len * LAST_WAY, z: gate.outer.z + toward.z / len * LAST_WAY };
  const by = (p: Pos) => [...yardCells, ...lane].some(c => horiz(mid(c), mid(p)) < RIVAL_R) || offSegment(gate.outer, far, mid(p)) < RIVAL_R;
  const lift = sites.filter(s => whose(world, s) === 'own' && by(s.at));
  const barrel = lift.find(s => NOT_LIFTED.test(s.name ?? ''));
  if (barrel) return { why: `a barrel of the bot's at ${fmt(barrel.at)} by the way in: not lifted (27 stacks): move it for good` };
  if (lift.length > NEUTRAL_MAX) return { why: `${lift.length} job blocks of the bot's by the way in, ${NEUTRAL_MAX} at most: ${lift.map(s => `${s.name} at ${fmt(s.at)}`).join(', ')}` };
  return { lift };
}

/** One of the bot's own job blocks lifted out of a villager's way (4.5, R-1): journal first, own.take (dig.here, picked up); `done` once the cell reads empty. Why not, or undefined. */
async function liftOne(ctx: GoalContext, trip: Trip, s: JobSite, why: 'job site' | 'wedge', now: number): Promise<string | undefined> {
  if (!ctx.own) return 'this runtime takes up no blocks of its own (own.take)';
  const r0 = await ctx.call<{ blocks?: (string | null)[] }>('world.region', { ...s.at, width: 1, height: 1, length: 1 }).catch(() => undefined);
  const state = r0?.blocks?.[0];
  if (!state) return `${fmt(s.at)} could not be read`;
  const name = idOf(state);
  if (CLEAR_LANE.test(name)) return undefined;
  const item = /cauldron$/.test(name) ? 'cauldron' : name;
  const e = journal(ctx, { k: 'lift', trip: trip.id, at: { ...s.at }, block: state, item, st: 'planned', why, t: now });
  let r = await ctx.own.take(s.at, name, { adopt: true });
  // (own.take's one walk into reach can stop where a wall hides the block: onto a cell beside it, carefully, and again)
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (r.ok || !/out of reach|out of sight/.test(r.reason ?? '')) break;
    const c = { x: s.at.x + dx, y: s.at.y, z: s.at.z + dz };
    if (dx || dz) { if (!CLEAR_LANE.test(idOf((await ctx.call<{ blocks?: (string | null)[] }>('world.region', { ...c, width: 1, height: 1, length: 1 }).catch(() => undefined))?.blocks?.[0]))) continue; }
    await walkTo(ctx, c, dx || dz ? 0 : 1);
    r = await ctx.own.take(s.at, name, { adopt: true, stay: true });
  }
  if (r.ok) {
    settle(e, 'done');
    if (r.dug && r.pickedUp === false && item === name) journal(ctx, { k: 'drop', trip: trip.id, at: { ...s.at }, item, t: now });
    ctx.save?.();
    return undefined;
  }
  dropEntry(ctx, e);
  return `the ${name} at ${fmt(s.at)} not lifted: ${r.reason ?? 'no answer'}`;
}

/** The kit (4.1 part 2): four lures, two planks of the lock's wood, the tools, the food, the bot fed and whole, the room. Why short, or undefined. */
async function kitWhy(ctx: GoalContext, lock: Lock, holders: number): Promise<string | undefined> {
  const inv = async () => ((await ctx.call<{ items?: { name: string; count: number; slot: number }[] }>('inventory').catch(() => undefined))?.items ?? []).filter(i => i.slot < SLOTS);
  const count = async (m: (n: string) => boolean) => (await inv()).filter(i => m(i.name)).reduce((a, i) => a + i.count, 0);
  if (await count(n => n === LURE) < LURES) {
    await prepare(ctx, LURE, LURES).catch(() => undefined);
    stopped(ctx);
    const have = await count(n => n === LURE);
    if (have < LURES) return `no lure block: ${LURES} ${LURE} wanted, ${have} carried (4 planks + 2 flint each)`;
  }
  const wall = idOf((await ctx.call<{ blocks?: (string | null)[] }>('world.region', { ...lock.socket, width: 1, height: 1, length: 1 }).catch(() => undefined))?.blocks?.[0]);
  const wood = /_planks$/.test(wall) ? wall : 'oak_planks';
  if (await count(n => n === wood) < 2) {
    await prepare(ctx, wood, 2).catch(() => undefined);
    if (await count(n => n === wood) < 2) return `short of 2 ${wood} for the lock's socket`;
  }
  for (const tool of ['pickaxe', 'shovel', 'axe'] as const) {
    if (await count(n => n.endsWith(`_${tool}`))) continue;
    await prepare(ctx, `stone_${tool}`, 1).catch(() => undefined);
    if (!(await count(n => n.endsWith(`_${tool}`)))) return `no ${tool} carried, and none made`;
  }
  const ride = FOOD_TARGET + CHEST_SPARE, food = async () => readyFoodPoints(new Map((await inv()).map(i => [i.name, i.count] as const)));
  if (await food() < ride) {
    await gatherFood(ctx, ride, true, true).catch(() => undefined);
    if (await food() < ride) await prepare(ctx, 'bread', Math.ceil((ride - (await food())) / 5) + (await count(n => n === 'bread'))).catch(() => undefined);
    if (await food() < ride) return `short of food: ${await food()} food points of ready food carried, ${ride} wanted`;
  }
  let st = await ctx.status().catch(() => undefined);
  if ((st?.food ?? ctx.s.food) < FED) { await ctx.act('eat', {}).catch(() => undefined); st = await ctx.status().catch(() => undefined); }
  if ((st?.health ?? ctx.s.health) < WHOLE) return `hurt (${st?.health ?? ctx.s.health}/20): whole to ${WHOLE} first`;
  const want = SLOTS_FREE + HOLDER_SLOTS * holders;
  if (SLOTS - (await inv()).length < want) {
    await makeRoom(ctx, 'trip').catch(() => undefined);
    stopped(ctx);
    const free = SLOTS - (await inv()).length;
    if (free < want) return `pockets full: ${free} slots free, ${want} wanted`;
  }
  return undefined;
}

/** What PREP did: `prepared` once its last part is stamped; `acted` when it changed the world (a lift, a stray, a craft). */
export interface PrepResult { ok: boolean; prepared?: true; acted?: true; text: string }

/**
 * A PREP declined (4.1): the reason counted in `fetch.why.prep` (at 3 the status line asks the lead), and the trip
 * dropped, or, where its lifts stand, on to RESTORE (care's row 8 puts them back).
 */
function declined(ctx: GoalContext, text: string, now: number, acted = false): PrepResult {
  const f = fetchOf(ctx.world), t = f.trip;
  noteWhy(ctx.world, 'prep', text, now);
  if (t && t.state === 'prep') {
    if (f.journal.some(e => e.trip === t.id)) tripTo(ctx, 'restore', now);
    else delete f.trip;
  }
  ctx.save?.();
  say(ctx, `not prepared: ${text}`);
  return { ok: false, text: `not prepared: ${text}`, ...(acted ? { acted: true as const } : {}) };
}

/**
 * PREP (4.1; care row 10 runs it from the yard): three parts, each stamped in `trip.prep` and saved when done, a cut
 * one going on from the stamps and a stamp over 6000 ticks old done again. (1) `read`, 6000-12300: the lock and the
 * ring ready, the hall ready for an arrival, a gate with a free lane and a villager's way to the lock, the bot's own
 * job sites by the way listed. (2) `kit`, the same hours. (3) `lifts`, 9000-12300 or at dawn while the trip still
 * fits: those job sites lifted, journal first. Then `prepared` is stamped: last, never before. `clk`: a test's clock
 * (else the snapshot's time and the real time since).
 */
export async function prep(ctx: GoalContext, clk: LureClock = realClock(ctx)): Promise<PrepResult> {
  const world = ctx.world, now = clk.now(), tod = await todNow(ctx);
  const off = switchesWhy(world);
  if (off) return { ok: false, text: `no PREP: ${off}` };
  const f0 = fetchOf(world);
  if (f0.trip && f0.trip.state !== 'prep') return { ok: false, text: `no PREP: trip ${f0.trip.id} is ${f0.trip.state}` };
  if (f0.trip?.prepared) return { ok: true, prepared: true, text: `prepared already for ${f0.trip.site}` };
  if (f0.wards.length) return { ok: false, text: `no PREP: ${f0.wards.length} ward(s) out` };
  const t = morning(tod), evening = tod >= PREP_FROM && tod <= PREP_TO;
  const stamped = (k: 'read' | 'kit' | 'lifts') => fin(f0.trip?.prep[k]);
  // (at dawn only the lifts are owed, on the reads and the kit of the evening before, however long the night was: the
  // run's re-read at the start reads the lock, the gates and the kit again; and the trip must still fit the morning)
  const dawn = t < IN_BY && t > -24_000 + PREP_TO && !evening;
  const fresh = (k: 'read' | 'kit' | 'lifts') => stamped(k) && (dawn || now - f0.trip!.prep[k]! <= STALE_MS);
  if (!evening && !(dawn && stamped('read') && stamped('kit'))) return { ok: false, text: `no PREP at time of day ${Math.round(tod)} (from ${PREP_FROM} the day before)` };
  const lock = lockOf(world);
  if (!lock) return declined(ctx, 'no lock stands in front of the hall', now);
  let acted = false;
  // part 1: the reads
  let trip = f0.trip;
  // (the dry switch turned after this PREP began: the rest of it, and its morning, are dry too)
  if (trip && dryNext(world) && !trip.dry) { trip.dry = true; ctx.save?.(); }
  const chosen = trip ? siteOfTrip(world, trip) : undefined;
  if (trip && !chosen) return declined(ctx, `the trip's village (${trip.site}) is no longer known`, now);
  if (!fresh('read')) {
    const shells = await readShells(ctx);
    if (shells.lock.faults.length) return declined(ctx, `the lock is not ready: ${shells.lock.faults[0].text}`, now);
    if (shells.ring.faults.length) return declined(ctx, `the portal's ring is not ready: ${shells.ring.faults[0]}`, now);
  }
  // (a new trip's village: the one choice of it, villagemove.ts lureSite, on the lock and the ring as just read)
  const pick = chosen ? { site: chosen } : prepSite({ ...ctx.s, now, timeOfDay: tod }, world);
  if ('why' in pick) return declined(ctx, pick.why, now);
  const site = pick.site;
  const ground = groundFor(world, site);
  if (!fresh('read')) {
    const hall = await hallWhyNot(ctx, now, tod);
    if (hall) return declined(ctx, hall, now);
    await readYard(ctx, ground);
    const gw = await gateWays(ctx, ground, lock, site, (trip ? trip.dry : dryNext(world)) ? 'dry' : 'dig');
    if ('why' in gw) return declined(ctx, gw.why, now);
    const sites = await sitesNear(ctx);
    const own = ownByWay(world, sites, gw.ways[0], gw.cells.get(gw.ways[0].side) ?? [], site);
    if ('why' in own) return declined(ctx, own.why, now);
    trip ??= newTrip(ctx, { site: variantOf(site), gate: gw.ways[0], spare: gw.ways.slice(1), dry: dryNext(world) }, now);
    trip.gate = gw.ways[0];
    trip.spare = gw.ways.slice(1);
    trip.prep.read = now;
    ctx.save?.();
    say(ctx, `prep read: lock ready; ring ready; gate ${trip.gate.side} (yard way ${trip.gate.yard})${own.lift.length ? `; lift: ${own.lift.map(s => `${s.name} at ${fmt(s.at)}`).join(', ')}` : ''}`);
  }
  if (!trip) return declined(ctx, 'no trip record', now);
  // part 2: the kit
  if (!fresh('kit')) {
    const sites = await sitesNear(ctx);
    const own = ownByWay(world, sites, trip.gate, [], site);
    const holders = 'lift' in own ? own.lift.filter(s => HOLDERS.test(s.name ?? '')).length : 0;
    const short = await kitWhy(ctx, lock, holders);
    if (short) return declined(ctx, short, now, acted);
    trip.prep.kit = clk.now();
    ctx.save?.();
    say(ctx, `prep kit: ${LURES} ${LURE}`);
  }
  // part 3: the lifts, last (from 9000, or at dawn while the trip still fits)
  const needS = startNeed(needParts(site, ctx.s.home ?? ctx.s.position, trip.gate.outer, trip.gate.yard));
  const liftsOk = (tod >= LIFTS_FROM && tod <= PREP_TO) || (dawn && !startLate(tod, needS + LIFTS_SLACK_S));
  if (!liftsOk) {
    noteWhy(world, 'prep', undefined, now);
    ctx.save?.();
    return { ok: true, text: `prep: read and kit done; the lifts from ${LIFTS_FROM}`, ...(acted ? { acted: true as const } : {}) };
  }
  await readYard(ctx, ground);
  const w = yardWay(ground, { gate: trip.gate.at, side: trip.gate.side, inner: trip.gate.inner }, lock.sOut, { yard: yardGround(world) });
  const own = ownByWay(world, await sitesNear(ctx), trip.gate, w.ok ? w.cells : [], site);
  if ('why' in own) return declined(ctx, own.why, now, acted);
  let lifted = 0;
  for (const s of own.lift) {
    stopped(ctx);
    // (a dry trip lifts nothing: it says what it would)
    if (trip.dry) { say(ctx, `prep (dry): would lift the ${s.name} at ${fmt(s.at)}`); continue; }
    const why = await liftOne(ctx, trip, s, 'job site', clk.now());
    if (why) return declined(ctx, why, clk.now(), true);
    lifted++;
    acted = true;
  }
  // (lifts only said: a trip made real after this owes them, fetchRun)
  if (trip.dry) trip.prep.dry = true;
  trip.prep.lifts = clk.now();
  trip.prepared = { at: clk.now(), day: gameDay(world) };
  noteWhy(world, 'prep', undefined, now);
  ctx.save?.();
  say(ctx, `prep lifts: ${lifted} lifted; prepared`);
  return { ok: true, prepared: true, text: `prepared for ${trip.site}: out at dawn by the ${trip.gate.side} gate${lifted ? `; ${lifted} lifted` : ''}`, ...(acted ? { acted: true as const } : {}) };
}

// ------------------------------------------------------------------------------------------------ the lure down and up

type LureEntry = Extract<Change, { k: 'lure' }>;
/** The trip's lure standing now (the one the ward works at or walks to), if any: the last `down` of this trip that is no pin. */
const standing = (f: FetchMemory, trip: Trip): LureEntry | undefined =>
  [...f.journal].reverse().find((e): e is LureEntry => e.k === 'lure' && e.trip === trip.id && e.st !== 'planned' && e.role !== 'pin' && e.role !== 'lock');
/** How many lures are in the pockets now. */
async function luresCarried(ctx: GoalContext): Promise<number> {
  const items = (await ctx.call<{ items?: { name: string; count: number; slot: number }[] }>('inventory').catch(() => undefined))?.items ?? [];
  return items.filter(i => i.slot < SLOTS && i.name === LURE).reduce((a, i) => a + i.count, 0);
}

/**
 * A lure down (R-1, R-5): the entry written and saved first, own.put (the protection before the place), the entry
 * settled by the reply; a place refused leaves no entry (own.put has taken its record off). The ground the trip plans
 * on is kept up to date with it. Undefined: not down, and why in `why`.
 */
async function putLure(ctx: GoalContext, plan: Plan, trip: Trip, at: Pos, role: LureEntry['role'], now: number, o: { stay?: boolean } = {}): Promise<{ entry?: LureEntry; why?: string }> {
  if (!ctx.own) return { why: 'this runtime puts down no blocks of its own (own.put)' };
  const inVillage = !!plan.home && inArea(plan.home, at) && !inYard(ctx.world, at);
  const e = journal(ctx, { k: 'lure', trip: trip.id, at: { ...at }, item: LURE, st: 'planned', role, ...(inVillage ? { inVillage: true as const } : {}), t: now });
  const r = await ctx.own.put(at, LURE, o.stay ? { stay: true } : {});
  if (r.placed) {
    settle(e, 'down');
    ctx.save?.();
    plan.ground.set(at.x, at.y, at.z, LURE);
    plan.used.push({ at: { ...at }, t: now });
    return { entry: e };
  }
  // (a lost reply that could not be read: the next read of the cell decides; else nothing of it stands)
  if (/lost|timed out|connection/.test(r.reason ?? '')) { settle(e, 'unsure'); ctx.save?.(); return { entry: e, why: r.reason }; }
  dropEntry(ctx, e);
  return { why: r.reason ?? 'not placed' };
}

/**
 * A lure taken up (own.take: dig.here, never `dig`, never `force`; the protection record off): the entry dropped, a
 * drop not picked up journaled. `pickup: false`: from the post, the drop picked up later.
 */
async function takeLure(ctx: GoalContext, plan: Plan, e: LureEntry, now: number, o: { stay?: boolean; pickup?: boolean } = {}): Promise<{ ok: boolean; why?: string; lost?: boolean }> {
  if (!ctx.own) return { ok: false, why: 'this runtime takes up no blocks of its own (own.take)' };
  const r = await ctx.own.take(e.at, e.item, { adopt: true, ...(o.stay ? { stay: true } : {}), ...(o.pickup === false ? { pickup: false } : {}) });
  if (r.ok || r.block) {
    dropEntry(ctx, e);
    plan.ground.set(e.at.x, e.at.y, e.at.z, 'air');
    const lost = r.dug && r.pickedUp !== true;
    if (lost) journal(ctx, { k: 'drop', trip: e.trip, at: { ...e.at }, item: e.item, t: now });
    return { ok: true, lost };
  }
  return { ok: false, why: r.reason ?? 'not dug' };
}

// ------------------------------------------------------------------------------------------------ the ward

/** A villager the first lure took, the bot's from now on (2.1): keyed by the game's uuid, its bell alive, led. */
function newWard(e: Looked, site: string, now: number, tod: number): Ward {
  const at = { ...e.position! }, key = e.uuid ?? `at:${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}@${now}`;
  const health = fin(e.health) ? e.health : 20;
  return {
    key, ...(e.uuid ? { uuid: e.uuid } : {}), id: e.id, session: SESSION, from: { site, at }, since: now, bell: true, where: 'led',
    last: { at, t: now, tod, health, profession: e.profession ?? GIVES }, health0: health
  };
}
/** Acceptable as a ward (4.1): an adult, not named, not on a lead, not riding, level 1 at most. */
const acceptable = (e: Looked): boolean => !e.baby && !usedHow(e);
/** A villager row by its uuid, else its id. */
const rowOf = (rows: readonly Looked[], w: Pick<Ward, 'uuid' | 'key' | 'id'>) =>
  rows.find(e => e.name === 'villager' && ((w.uuid && e.uuid === w.uuid) || (!w.uuid && e.id === w.id)));

/** The ward's place in the look, by wardSeen (its record brought up to it, a ward someone took off the wards). */
function sightOf(world: WorldMemory, look: Look, lure?: Pos, pShut?: boolean, whole = false): WardSight | undefined {
  const f = fetchOf(world);
  const sights = wardSeen(world, look.rows, whole, look.now, { tod: look.tod, ...(lure ? { lure } : {}), ...(pShut === undefined ? {} : { pShut }) });
  return sights.find(s => s.ward.key === f.trip?.ward) ?? (f.trip?.ward ? sights.find(s => s.ward.uuid === f.trip!.ward) : undefined);
}

/** The ends a lead can come to, for the rung's run and for care: in the hall, in the lock, let go, stopped, astray, dropped (someone's, home with a job, traded), dead. */
export interface LeadEnd { end: 'hall' | 'lock' | 'released' | 'stopped' | 'astray' | 'dropped' | 'dead' | 'none'; text: string; placed: boolean }

/** Note a site's word for the lure (`site.fetch`, siteOpen's wait under the lure): the same kind again doubles. */
function noteSite(world: WorldMemory, trip: Pick<Trip, 'site'>, kind: NonNullable<VillageSite['fetch']>['kind'], why: string, now: number, ok = false): void {
  const s = liveSite(world, trip);
  if (!s) return;
  const was = s.fetch;
  s.fetch = { at: now, ok, kind, why: why.slice(0, 160), n: was && !was.ok && was.kind === kind ? was.n + 1 : 1, ...(fin(was?.pathLen) ? { pathLen: was!.pathLen } : {}), ...(fin(was?.outS) ? { outS: was!.outS } : {}) };
}

/** The trip's standing lure up, the ward let be: a lure up with the ward by it (within 16, jobless at once), the entry off. */
async function lureUp(ctx: GoalContext, plan: Plan, now: number): Promise<string> {
  const f = fetchOf(ctx.world), t = f.trip;
  const e = t ? standing(f, t) : undefined;
  if (!e) return '';
  const r = await takeLure(ctx, plan, e, now);
  return r.ok ? '' : `; the lure at ${fmt(e.at)} not taken up: ${r.why} (care fetches it)`;
}

/**
 * RELEASE (4.9; only while the trip is not committed): the lure broken with the ward within 16 (jobless: as found) and
 * taken up; it stands within 96 of its village on ground it walked out, every step behind it one it climbs back. The
 * ward is off the record with a log line, the site takes the reason, a pin within reach is fetched, the bot goes home.
 */
async function release(ctx: GoalContext, clk: LureClock, plan: Plan, why: string, kind: NonNullable<VillageSite['fetch']>['kind']): Promise<LeadEnd> {
  const f = fetchOf(ctx.world), t = f.trip!, w = wardOf(f), now = clk.now();
  const left = await lureUp(ctx, plan, now);
  const at = w?.last.at ?? (await here(ctx));
  if (w) f.wards = f.wards.filter(x => x !== w);
  noteSite(ctx.world, t, kind, why, now);
  // (a pin of this trip within reach comes up on the way: its villager works at it, jobless again, as found)
  for (const p of f.journal.filter((e): e is LureEntry => e.k === 'lure' && e.trip === t.id && e.role === 'pin')) {
    if (horiz(p.at, await here(ctx)) <= 64) await undo(ctx, p, { now: () => clk.now() }).catch(() => undefined);
  }
  const text = `released at ${fmt(at)}: ${why}${left}`;
  say(ctx, text);
  endTrip(ctx, text, 0, clk.now());
  if (afield.ledBy === ctx.signal) afield.ledBy = undefined;
  return { end: 'released', text, placed: true };
}

/**
 * STOP (4.9): committed, and the bell came first, or it stalled, or a second villager with no spare. The lure up
 * (nothing of the bot's left in the open by plan), every strict gate read shut, the ward astray where it was last
 * seen, and `halt`: the lead decides (S1). The lifts stay for 2 game days (R-8).
 */
async function stop(ctx: GoalContext, clk: LureClock, plan: Plan, why: string): Promise<LeadEnd> {
  const f = fetchOf(ctx.world), t = f.trip!, w = wardOf(f), now = clk.now();
  const left = await lureUp(ctx, plan, now);
  for (const g of await gatesRead(ctx, ctx.world)) if (g.open) await shutGate(ctx, g.at);
  const at = w?.last.at ?? (await here(ctx));
  if (w) { w.where = 'astray'; w.note = `stopped: ${why}`.slice(0, 120); delete w.tether; }
  f.halt = { at: now, why: `STOPPED at ${fmt(at)}: ${why} (trip ${t.id}); villager-moves {halt:false, arm:1} leads it in by day`.slice(0, 300) };
  const text = `STOPPED at ${fmt(at)}: ${why}${left}`;
  say(ctx, text);
  endTrip(ctx, text, 0, clk.now());
  if (afield.ledBy === ctx.signal) afield.ledBy = undefined;
  return { end: 'stopped', text, placed: true };
}

/** A ward that ended out of reach of the lead: astray (with its note), the lure up, `halt` (S1: the lead's). */
async function astray(ctx: GoalContext, clk: LureClock, plan: Plan, note: string, dead = false): Promise<LeadEnd> {
  const f = fetchOf(ctx.world), w = wardOf(f), now = clk.now();
  const left = await lureUp(ctx, plan, now);
  if (w) { w.where = dead ? 'dead' : 'astray'; w.note = note.slice(0, 120); }
  f.halt ??= { at: now, why: `ward ${w ? short(w.key) : '?'} ${dead ? 'is dead' : 'is astray'}: ${note}`.slice(0, 300) };
  const text = `${dead ? 'dead' : 'astray'}: ${note}${left}`;
  say(ctx, text);
  endTrip(ctx, text, 0, clk.now());
  if (afield.ledBy === ctx.signal) afield.ledBy = undefined;
  return { end: dead ? 'dead' : 'astray', text, placed: true };
}

/** A ward off the record (someone's; home with a job; traded): the lure up, the site noted, the trip ends. */
async function dropped(ctx: GoalContext, clk: LureClock, plan: Plan, note: string, kind?: NonNullable<VillageSite['fetch']>['kind']): Promise<LeadEnd> {
  const f = fetchOf(ctx.world), t = f.trip!, w = wardOf(f), now = clk.now();
  const left = await lureUp(ctx, plan, now);
  if (w) f.wards = f.wards.filter(x => x !== w);
  if (kind) noteSite(ctx.world, t, kind, note, now);
  const text = `ward let be: ${note}${left}`;
  say(ctx, text);
  endTrip(ctx, text, 0, clk.now());
  if (afield.ledBy === ctx.signal) afield.ledBy = undefined;
  return { end: 'dropped', text, placed: true };
}

// ------------------------------------------------------------------------------------------------ the exit handler (3.3)

/**
 * Where the anchor goes if the run is cut while the lure is carried (3.3): the nearest cell within 3 of the bot a lure
 * may stand in by the courtesy rules (room for a block, a full natural floor, no path block or farmland, no one's
 * build, out of every avoid circle); none, none. Kept by the hop loop at every hop.
 */
function anchorCell(world: WorldMemory, plan: Plan, me: Pos, trip: Trip): Pos | undefined {
  const g = plan.ground, c0 = cell(me), out: { at: Pos; d: number }[] = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 1; dy++) {
    const at = { x: c0.x + dx, y: c0.y + dy, z: c0.z + dz };
    if ((dx === 0 && dz === 0) || !CLEAR_LANE.test(idOf(g.state(at.x, at.y, at.z) ?? 'stone'))) continue;
    const under = idOf(g.state(at.x, at.y - 1, at.z) ?? 'air');
    if (!/^(grass_block|dirt|coarse_dirt|podzol|stone|sand|gravel|moss_block|mycelium|rooted_dirt|andesite|diorite|granite|deepslate|tuff)$/.test(under)) continue;
    if (plan.zones.some(z => at.x >= z.x1 && at.x <= z.x2 && at.z >= z.z1 && at.z <= z.z2)) continue;
    if (trip.avoid.some(a => horiz(a.at, at) < a.r)) continue;
    if (inHallBox(world, at)) continue;
    out.push({ at, d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) });
  }
  return out.sort((a, b) => a.d - b.d)[0]?.at;
}

/**
 * The exit handler (3.3, as pens.ts tidyUp: outside the given-up run, a few calls and no walk): a held gate released
 * shut (the bridge keeps trying); with the lure in the pockets and a ward led, the anchor down where the hop loop
 * kept a cell for it (the bot's health 6 or more); the ward astray at its tether; the trip marked cut. Care's row 3
 * goes on from it by day.
 */
async function exitHandler(ctx: GoalContext, clk: LureClock, why: string): Promise<void> {
  const f = fetchOf(ctx.world), t = f.trip;
  if (!t) return;
  const plan = plans.get(ctx.world);
  const outside = (fn: () => Promise<unknown>) => brainRun.exit(() => fn()).catch(() => undefined);
  for (const e of f.journal.filter((x): x is Extract<Change, { k: 'gate' }> => x.k === 'gate' && x.which !== 'hall' && x.trip === t.id)) {
    await outside(() => ctx.call('gates.release', { x: e.at.x, y: e.at.y, z: e.at.z, shut: true }));
  }
  const w = wardOf(f), down = standing(f, t);
  if (w?.where === 'led') {
    if (down) w.tether = { ...down.at };
    else if (plan?.anchorAt && ctx.own) {
      const st = await brainRun.exit(() => ctx.status()).catch(() => undefined);
      if ((st?.health ?? 0) >= 6) {
        const e = journal(ctx, { k: 'lure', trip: t.id, at: { ...plan.anchorAt }, item: LURE, st: 'planned', role: 'anchor', t: clk.now() });
        const r = await brainRun.exit(() => ctx.own!.put(plan.anchorAt!, LURE, { stay: true })).catch(() => undefined);
        if (r?.placed) { settle(e, 'down'); w.tether = { ...plan.anchorAt }; } else if (r && !/lost|timed out/.test(r.reason ?? '')) dropEntry(ctx, e);
      } else ctx.progress(`villagers: no anchor: the bot is hurt (${st?.health ?? '?'}/20)`);
    } else ctx.progress('villagers: no legal anchor cell by the bot: none placed');
    w.where = 'astray';
    w.note = `cut: ${why}`.slice(0, 120);
  }
  cutTrip(ctx, why, clk.now());
  if (afield.ledBy === ctx.signal) afield.ledBy = undefined;
  if (afield.critical?.by === ctx.signal) delete afield.critical;
}

// ------------------------------------------------------------------------------------------------ the guards (4.3)

/** What the clock says now for the trip's ward and the cells still to go (`trip.path`). */
function clockNow(f: FetchMemory, tod: number, inside: boolean): ClockSays {
  const t = f.trip!, p = t.path ?? { toGate: 0, yard: t.gate.yard };
  return clock(tod, needLeft(p.toGate, p.yard), wardOf(f), t, { inside });
}

/**
 * The guards of 4.3, asked at every poll: a player staying, a zombie by the ward, a creeper or a skeleton after the
 * bot, illagers, the ward hurt, the bot hurt or hungry, a screen open. Undefined: on. 'hold': the poll waits (the lure
 * stands). A LeadEnd: the trip ended here.
 */
async function guards(ctx: GoalContext, clk: LureClock, plan: Plan, look: Look, ward: Looked | undefined, inside: boolean, runOn: boolean): Promise<LeadEnd | 'hold' | undefined> {
  const f = fetchOf(ctx.world), t = f.trip!, me = look.me, wAt = ward?.position ?? wardOf(f)?.last.at ?? me;
  // the lead's stop (villager-moves {enabled:false}, 2.2 hop -> RELEASE): a trip not committed is let go by its
  // village at once; a committed one is finished, the safe end (set-autonomy {enabled:false} cuts it)
  if (ctx.world.villagerMoves !== true && !t.committed) return release(ctx, clk, plan, 'villager moves switched off', 'late');
  // a screen (a trade window: the use key on a villager): closed; twice, halt
  if (look.screen) {
    await ctx.call('container.close', {}).catch(() => undefined);
    if (++plan.screens >= 2) f.halt ??= { at: look.now, why: `a screen opened twice while leading (${look.screen})` };
  }
  // the ward hurt: a fall of 1 or more against the lowest of the last three polls (rounded, and they heal)
  if (ward && fin(ward.health)) {
    if (ward.health <= 0) return astray(ctx, clk, plan, `health read 0 at ${fmt(wAt)}`, true);
    const low = plan.health.length ? Math.min(...plan.health.slice(-3)) : ward.health;
    plan.health.push(ward.health);
    if (plan.health.length > 3) plan.health.shift();
    if (ward.health <= low - 1) {
      const by = look.rows.find(e => e.name !== 'villager' && e.name !== 'player' && e.position && dist(e.position, wAt) <= 8 && /zombie|husk|drowned|skeleton|creeper|spider|pillager|vindicator/.test(e.name));
      plan.hurtBy++;
      plan.fellAt = look.now;
      say(ctx, `the ward's health fell to ${ward.health} at ${fmt(wAt)}${by ? `: a ${by.name} by it` : ': cause not seen'}`);
      if (!by && plan.hurtBy >= 2) f.halt ??= { at: look.now, why: `the ward was hurt twice, cause not seen (health ${ward.health})` };
    }
  }
  // (a hostile within 8 of it: if it is gone now, it is dead, 2.1)
  const close = look.rows.find(e => e.position && dist(e.position, wAt) <= 8 && /zombie|husk|drowned|skeleton|creeper|spider|pillager|vindicator|evoker|ravager|vex/.test(e.name));
  if (close) plan.hostileBy = { name: close.name, t: look.now };
  // illagers: two or more, or any pillager, within 64; ahead or round: the lure up, the ward free to flee, home
  const ill = look.rows.filter(e => ILLAGER.test(e.name) && e.position && dist(e.position, wAt) <= 64);
  if (ill.length >= 2 || ill.some(e => e.name === 'pillager')) {
    const goal = inside ? lockOf(ctx.world)?.sOut ?? t.gate.inner : t.gate.outer;
    const ahead = ill.some(e => horiz(e.position!, goal) < horiz(wAt, goal) + 16);
    if (ahead) {
      noteSite(ctx.world, t, 'no unemployed', `illagers by the way (a ${ill[0].name} at ${fmt(ill[0].position!)})`, look.now);
      return astray(ctx, clk, plan, `illagers ahead (a ${ill[0].name} at ${fmt(ill[0].position!)}): let free to flee`);
    }
  }
  // a lone zombie-kind within 16 of the ward: the bot between them, fought with an axe (never a sword by a villager)
  const zombies = look.rows.filter(e => ZOMBIE.test(e.name) && e.position && horiz(e.position, wAt) <= ZOMBIE_R);
  if (zombies.length === 1) {
    const z = zombies[0];
    say(ctx, `a ${z.name} at ${fmt(z.position!)} by the ward: held, fought`);
    const axe = ((await ctx.call<{ items?: { name: string; slot: number }[] }>('inventory').catch(() => undefined))?.items ?? []).find(i => i.slot < SLOTS && /_axe$/.test(i.name));
    if (axe) await ctx.call('item.select', { name: axe.name }).catch(() => undefined);
    await ctx.act('attack-entity', { target: `#${z.id}`, maxDistance: 24, timeoutMs: HOSTILE_HOLD_S * 1000, collect: false }).catch(() => undefined);
    return 'hold';
  }
  // a creeper within 12 of the bot, or a skeleton: the bot walks 10 or more from the ward, to the side away from the way
  const after = look.rows.find(e => e.position && ((e.name === 'creeper' && horiz(e.position, me) <= CREEPER_R) || (e.name === 'skeleton' && horiz(e.position, me) <= 16)));
  if (after) {
    const dx = me.x - wAt.x, dz = me.z - wAt.z, d = Math.hypot(dx, dz) || 1;
    const to = { x: Math.floor(wAt.x + dx / d * (AWAY_FROM_WARD + 2)), y: Math.floor(me.y), z: Math.floor(wAt.z + dz / d * (AWAY_FROM_WARD + 2)) };
    say(ctx, `a ${after.name} at ${fmt(after.position!)} after the bot: led off to ${fmt(to)}, the lure stays`);
    await ctx.call('goto', { ...to, range: 2, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
    await clk.sleep(HOSTILE_HOLD_S * 1000);
    return 'hold';
  }
  // the bot hurt or hungry: held, and fed (the Guardian's eat looks off a villager: bridge B5)
  if (look.health <= HURT || look.food < HUNGRY) {
    await ctx.act('eat', {}).catch(() => undefined);
    return 'hold';
  }
  // a player within 32 of the bot or the ward for 60 s: not committed, let go; committed, held while the clock has slack
  const player = look.rows.find(e => e.name === 'player' && e.position && (horiz(e.position, me) <= PLAYER_R || horiz(e.position, wAt) <= PLAYER_R));
  if (!player) plan.player = undefined;
  else {
    plan.player ??= { since: look.now, who: `a player at ${fmt(player.position!)}` };
    if (look.now - plan.player.since >= PLAYER_HOLD_S * 1000) {
      if (!t.committed) return release(ctx, clk, plan, `${plan.player.who} stayed ${PLAYER_HOLD_S} s`, 'late');
      const c = clockNow(f, look.tod, inside);
      if (!runOn && c.go === 'on' && c.inHandS > 15) { say(ctx, `paused: ${plan.player.who}`); return 'hold'; }
    }
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ the watch (4.3)

type Verdict =
  | { v: 'flip'; s: number } | { v: 'miss'; d: number } | { v: 'slow'; d: number } | { v: 'still' } | { v: 'job'; profession: string; at: Pos }
  | { v: 'other'; e: Looked } | { v: 'gone' } | { v: 'clock'; c: ClockSays } | { v: 'end'; end: LeadEnd };

/**
 * The watch at a lure (4.3): 500 ms polls, the bot on its standing cell. A flip (the ward within 2.5 with the lure's
 * profession); a miss (not 3 nearer in 12 s: waited to 20); slow (coming, no flip by 45: waited to 60); still (moved
 * under half a block in 15 s, not by the lure); another profession; another villager flipped at it; gone 3 s; the
 * clock's release or stop; and every guard. Committed and late, the waits are cut to 8 and 30.
 */
async function watch(ctx: GoalContext, clk: LureClock, plan: Plan, lure: Pos, inside: boolean): Promise<Verdict> {
  const world = ctx.world;
  let t0 = clk.now(), d0: number | undefined, best = Infinity, gone: number | undefined;
  let still: { at: Pos; t: number } | undefined;
  const none = new Set<string>();
  for (;;) {
    stopped(ctx);
    const look = await lookNow(ctx, clk, PLAYER_SIGHT);
    const f = fetchOf(world);
    beat(world, look.now);
    // (taken off the records beside the watch: the brain's gate watch runs wardSeen too)
    if (!wardOf(f)) return { v: 'end', end: await dropped(ctx, clk, plan, OFF_RECORDS) };
    const s = sightOf(world, look, lure);
    if (s?.taken) return { v: 'end', end: await dropped(ctx, clk, plan, s.taken) };
    const c = clockNow(f, look.tod, inside);
    if (c.go === 'release' || c.go === 'stop') return { v: 'clock', c };
    const runOn = c.go === 'run on';
    for (const r of look.rows) if (r.name === 'villager' && r.profession === 'none' && r.uuid) none.add(r.uuid);
    const e = s?.seen;
    if (!e?.position) {
      gone ??= look.now;
      if (look.now - gone >= GONE_S * 1000) return { v: 'gone' };
      await clk.sleep(POLL_MS);
      continue;
    }
    gone = undefined;
    const g = await guards(ctx, clk, plan, look, e, inside, runOn);
    if (g && g !== 'hold') return { v: 'end', end: g };
    if (g === 'hold') { t0 += POLL_MS; still = undefined; await clk.sleep(POLL_MS); continue; }
    const d = dist(e.position, mid(lure));
    if (e.profession === GIVES && d <= FLIP_R) return { v: 'flip', s: (look.now - t0) / 1000 };
    if (e.profession && e.profession !== 'none' && e.profession !== GIVES) return { v: 'job', profession: e.profession, at: { ...e.position } };
    // another villager, 'none' at an earlier poll, now a fletcher at this lure while the ward reads none: a pin
    const other = look.rows.find(o => o.name === 'villager' && o.uuid !== e.uuid && o.uuid && none.has(o.uuid) && o.profession === GIVES && o.position && dist(o.position, mid(lure)) <= FLIP_R);
    if (other) return { v: 'other', e: other };
    d0 ??= d;
    best = Math.min(best, d);
    const el = (look.now - t0) / 1000;
    if (!still || horiz(still.at, e.position) >= 0.5) still = { at: { ...e.position }, t: look.now };
    const hostile = look.rows.some(o => o.position && /zombie|husk|drowned|pillager|vindicator/.test(o.name) && dist(o.position, e.position!) <= 8);
    if (d > FLIP_R && !e.sleeping && !hostile && look.now - still.t >= STILL_S * 1000) return { v: 'still' };
    const came = d0 - best;
    // (not 3 nearer in APPROACH_S: waited on to MISS_MAX_S, then a miss)
    if (came < 3 && el >= (runOn ? RUN_ON_APPROACH_S : Math.max(APPROACH_S, MISS_MAX_S))) return { v: 'miss', d };
    if (came >= 3 && el >= (runOn ? RUN_ON_ARRIVE_S : SLOW_MAX_S)) return { v: 'slow', d };
    await clk.sleep(POLL_MS);
  }
}

/** After a break with the ward by it: it reads `none` within 3 s, else it has traded (xp keeps a profession for good): its profession then. */
async function traded(ctx: GoalContext, clk: LureClock, w: Ward): Promise<string | undefined> {
  let prof: string | undefined;
  for (let i = 0; i < 6; i++) {
    const e = await ctx.call<{ entities?: Looked[] }>('world.entities', { maxDistance: SEE_R, type: 'villager' }).catch(() => undefined);
    const row = rowOf(e?.entities ?? [], w);
    if (!row) return undefined;
    prof = row.profession;
    if (!prof || prof === 'none') return undefined;
    await clk.sleep(POLL_MS);
  }
  return prof;
}

/** A careful walk onto a cell (Baritone breaks and places nothing by a villager); whether the bot stands there. */
async function walkTo(ctx: GoalContext, at: Pos, range = 0): Promise<boolean> {
  const r = await ctx.call<{ arrived?: boolean }>('goto', { x: at.x, y: at.y, z: at.z, range, careful: true, timeoutMs: 30_000 }, 40_000).catch(() => undefined);
  stopped(ctx);
  const me = cell(await here(ctx));
  return r?.arrived === true || Math.abs(me.x - at.x) + Math.abs(me.z - at.z) <= range && Math.abs(me.y - at.y) <= 1;
}

// ------------------------------------------------------------------------------------------------ the way and the spot

/** The cells 3-6 outside a yard gate and 1-2 aside of its lane (4.2, 4.6: S_gate): the hop before the gate ends there. */
function inGateSpot(g: Pick<YardGateWay, 'at' | 'side'>, p: Pos): boolean {
  const [dx, dz] = SIDE_STEP[g.side], out = (p.x - g.at.x) * dx + (p.z - g.at.z) * dz, aside = Math.abs((p.x - g.at.x) * dz - (p.z - g.at.z) * dx);
  return out >= 3 && out <= 6 && aside >= 1 && aside <= 2;
}
const gateSpotMid = (g: Pick<YardGateWay, 'at' | 'side'>) => { const [dx, dz] = SIDE_STEP[g.side]; return { x: g.at.x + 4.5 * dx + 1.5 * dz + 0.5, z: g.at.z + 4.5 * dz - 1.5 * dx + 0.5 }; };

/** The cells of the straight line from one cell to another, a cell a step (a way not read to its end yet). */
function straight(a: Pos, b: Pos): Pos[] {
  const n = Math.max(1, Math.ceil(horiz(a, b))), out: Pos[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: Math.round(a.x + (b.x - a.x) * i / n), y: a.y, z: Math.round(a.z + (b.z - a.z) * i / n) });
  return out;
}

/**
 * A lure's cell among `cells` (nearest first) for a ward that stands by them already, the hop's least progress not
 * asked: room for the block on a full floor, a way of the lead rules from the ward to a cell beside it, the bot's
 * standing cell (botStand: seen from, within reach, walked to). The gate's spot when the last hop left it within 8.
 */
function nearSpot(plan: Plan, world: WorldMemory, wc: Pos, cells: readonly Pos[], me: Pos, now: number): HopSpot | undefined {
  const g = plan.ground, yard = yardGround(world);
  for (const c of cells) {
    if (plan.used.some(u => same(u.at, c) && now - u.t < 20_000)) continue;
    if (!CLEAR_LANE.test(idOf(g.state(c.x, c.y, c.z) ?? 'stone'))) continue;
    const s = stand(g, c.x, c.y, c.z, 'lead', { yard });
    if (!isStand(s) || Math.abs(s.f - c.y) > 1e-6 || /dirt_path|farmland/.test(idOf(g.state(c.x, c.y - 1, c.z)))) continue;
    const lured = withBlock(g, c, LURE), reach = reachCells(lured, c, 'lead', { yard });
    if (!reach.length) continue;
    const way = pathFor(lured, wc, reach, 'lead', { yard });
    if (!way.ok) continue;
    const bot = botStand(lured, c, way.cells, cell(me), { yard });
    if (bot) return { block: { ...c }, reach: way.cells[way.cells.length - 1] ?? wc, botStand: bot, path: way.cells, drop: way.drop };
  }
  return undefined;
}

/**
 * UNWEDGE step 1's spot (4.3): a cell for the lure on the still ward's other side (`side`: the old lure mirrored through
 * it), the far side only, nearest that point first, by nearSpot (it stands by it: no hop's least progress asked). Never
 * in the hall, the lock or a pen, within 5 of the portal's ring, in someone's build or an avoid circle.
 */
function sideSpot(plan: Plan, world: WorldMemory, t: Trip, wc: Pos, side: Pos, me: Pos, now: number, lock: Lock | undefined, ring: Area | undefined): Spot | undefined {
  const ax = side.x - wc.x, az = side.z - wc.z, cells: Pos[] = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 1; dy++) {
    const c = { x: side.x + dx, y: wc.y + dy, z: side.z + dz };
    if ((c.x - wc.x) * ax + (c.z - wc.z) * az <= 0 || horiz(c, wc) < 1.5) continue;
    if (inHallBox(world, c) || (lock && inLock(lock, c)) || penAt(world, c)) continue;
    if (ring && c.x >= ring.x1 - 5 && c.x <= ring.x2 + 5 && c.z >= ring.z1 - 5 && c.z <= ring.z2 + 5) continue;
    if (plan.zones.some(z => c.x >= z.x1 && c.x <= z.x2 && c.z >= z.z1 && c.z <= z.z2) || t.avoid.some(a => horiz(a.at, c) < a.r)) continue;
    cells.push(c);
  }
  cells.sort((a, b) => horiz(a, side) - horiz(b, side) || Math.abs(a.y - wc.y) - Math.abs(b.y - wc.y));
  return nearSpot(plan, world, wc, cells, me, now);
}

/** The rest of the way from where the ward stands: outside, the corridor to the gate's outer cell (planned again when it has strayed off it); in the yard, the yard's way to S_out. */
function wayFrom(world: WorldMemory, plan: Plan, t: Trip, wc: Pos, inside: boolean, lock: Lock | undefined, keep: { ring?: Area; hall?: { box: Area; shut: boolean } }): Pos[] | { why: string } {
  const near = (cells: Pos[] | undefined) => (cells?.length ? cells.reduce((b, c, i) => (horiz(c, wc) < horiz(cells[b], wc) ? i : b), 0) : -1);
  if (!inside) {
    let i = near(plan.way);
    if (i < 0 || horiz(plan.way![i], wc) > 12) {
      const o = { zones: plan.zones, avoid: t.avoid, sites: plan.sites, home: plan.home, lifted: liftedFor(world, plan, t), lures: tripLures(fetchOf(world), t.id), yard: yardGround(world), ...(keep.hall ? { hall: keep.hall } : {}) };
      let c = corridor(plan.ground, wc, t.gate.outer, { ...o, retrace: !t.committed });
      if (!c.ok && !t.committed) c = corridor(plan.ground, wc, t.gate.outer, o);
      // (resumed far from the gate, the way not read to its end yet: straight on toward the gate, each hop planned on the
      // ground read round the ward as the bot goes, and the corridor asked again once it is read)
      if (!c.ok && c.why === 'unread') return straight(wc, t.gate.outer);
      if (!c.ok) return { why: c.text };
      plan.way = c.cells;
      i = 0;
    }
    return plan.way!.slice(i);
  }
  if (!lock) return { why: 'no lock stands' };
  const ring = keep.ring ? { ring: keep.ring } : {};
  // (the yard's way as PREP read it, from the gate's inner cell; from where the ward stands only when it is off that)
  if (!plan.yard) {
    const w = yardWay(plan.ground, { gate: t.gate.at, side: t.gate.side, inner: t.gate.inner }, lock.sOut, { yard: yardGround(world), ...ring });
    if (w.ok) plan.yard = w.cells;
  }
  let i = near(plan.yard);
  if (i < 0 || horiz(plan.yard![i], wc) > 8) {
    const w = yardWay(plan.ground, { gate: t.gate.at, side: t.gate.side, inner: wc }, lock.sOut, { yard: yardGround(world), ...ring });
    if (!w.ok) return i < 0 ? { why: w.text } : plan.yard!.slice(i);
    plan.yard = w.cells;
    i = 0;
  }
  return plan.yard!.slice(i);
}

type Spot = HopSpot & { final?: 'gate' | 'sout' };
/**
 * A spot asked again while it lies in one of the trip's own circles (8 round a pin, 40 round a lure a villager not to
 * take took): those keep the lure's cell off, not the ward's way, which may start in one. The whole circle is marked
 * used at the spot's level and one either side, so the next ask finds a cell outside it (a spot at a time, the search
 * gives the next cell of the same circle: every spot is nearest the same start).
 */
function spotOff<S extends { block: Pos } | { why: string }>(plan: Plan, ask: () => S, kept: { at: Pos; t: number }[], now: number): S {
  const filled = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const s = ask();
    if ('why' in s) return s;
    const by = (plan.pinAvoid ?? []).find(c => horiz(c.at, s.block) < c.r);
    if (!by) return s;
    const k = `${by.at.x},${by.at.z},${by.r},${s.block.y}`;
    if (filled.has(k)) { kept.push({ at: { ...s.block }, t: now }); continue; }
    filled.add(k);
    const r = Math.ceil(by.r);
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      const c = { x: Math.floor(by.at.x) + dx, z: Math.floor(by.at.z) + dz };
      if (horiz({ x: c.x + 0.5, z: c.z + 0.5 }, { x: by.at.x + 0.5, z: by.at.z + 0.5 }) >= by.r) continue;
      for (let dy = -1; dy <= 1; dy++) kept.push({ at: { x: c.x, y: s.block.y + dy, z: c.z }, t: now });
    }
  }
  return { why: 'every spot near a pin' } as S;
}
/** The next lure's spot from where the ward stands (hopSpot), toward the way's point `len` on; the gate's spot as the last hop outside, S_out from the post as the last inside. */
async function spotFor(ctx: GoalContext, plan: Plan, t: Trip, wc: Pos, rest: Pos[], inside: boolean, len: number, me: Pos, now: number, lock: Lock | undefined, ring?: Area): Promise<Spot | { why: string }> {
  const f = fetchOf(ctx.world), kept: { at: Pos; t: number }[] = [];
  const o = {
    bot: cell(me), retrace: !t.committed, ...(plan.home ? { home: plan.home } : {}), zones: plan.zones, avoid: plan.golem ? [...t.avoid, plan.golem] : t.avoid, sites: plan.sites,
    lifted: liftedFor(ctx.world, plan, t), hall: await hallFor(ctx), lures: tripLures(f, t.id), used: plan.used, now, yard: yardGround(ctx.world),
    ...(ring && inside ? { keep: [{ ...ring, d: 5, why: '5 off the portal\'s ring' }] } : {})
  };
  if (!inside) {
    const m = gateSpotMid(t.gate), dm = horiz(wc, m);
    if (dm <= HOP_MAX + 1) {
      if (dm >= HOP_MIN + 1) {
        const s = spotOff(plan, () => hopSpot(plan.ground, wc, m, { ...o, len: Math.round(dm), used: [...plan.used, ...kept] }), kept, now);
        if (!('why' in s) && inGateSpot(t.gate, s.block)) return { ...s, final: 'gate' };
      }
      // (it stands by the gate's spot already: a cell of it with a short way, no hop's least progress asked)
      const [dx, dz] = SIDE_STEP[t.gate.side], cells: Pos[] = [];
      for (let n = 3; n <= 6; n++) for (const a of [1, -1, 2, -2]) cells.push({ x: t.gate.at.x + n * dx - a * dz, y: t.gate.at.y, z: t.gate.at.z + n * dz + a * dx });
      const near = nearSpot(plan, ctx.world, wc, cells.sort((p, q) => horiz(p, wc) - horiz(q, wc)), me, now);
      if (near) return { ...near, final: 'gate' };
    }
  } else if (lock && horiz(wc, lock.sOut) <= YARD_HOP + 4) {
    const way = pathFor(plan.ground, wc, lock.sOut, 'lead', { yard: yardGround(ctx.world), limits: false });
    if (way.ok) return { block: lock.sOut, reach: way.cells[way.cells.length - 1] ?? wc, botStand: lock.post, path: way.cells, drop: way.drop, final: 'sout' };
  }
  const to = rest[Math.min(rest.length - 1, len)] ?? (inside ? lock?.sOut : t.gate.outer)!;
  for (const l of [len, 11]) {
    const s = spotOff(plan, () => hopSpot(plan.ground, wc, to, { ...o, len: l, used: [...plan.used, ...kept] }), kept, now);
    if (!('why' in s)) return s;
    if (l === 11) return { why: s.why };
  }
  return { why: 'no hop spot' };
}

// ------------------------------------------------------------------------------------------------ the remedies

/** A thin block of the bot's own in or beside a still ward's cell (in the yard: never a fence line's, a ring's, a pen's or the lock's). */
function wedgeBlock(world: WorldMemory, g: Ground, at: Pos): JobSite | undefined {
  const lock = lockOf(world), ring = ringPlanOf(world)?.zone, y = world.yard;
  const c0 = cell(at), cells: Pos[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) cells.push({ x: c0.x + dx, y: c0.y + dy, z: c0.z + dz });
  cells.sort((a, b) => dist(a, c0) - dist(b, c0));
  for (const c of cells) {
    const id = idOf(g.state(c.x, c.y, c.z));
    if (!THIN.test(id) || /_gate$/.test(id) || !inYard(world, c)) continue;
    if (y && (c.x === y.x1 || c.x === y.x2 || c.z === y.z1 || c.z === y.z2)) continue;
    if (ring && c.x >= ring.x && c.x < ring.x + ring.width && c.z >= ring.z && c.z < ring.z + ring.length) continue;
    if (lock && (inLock(lock, c) || Math.abs(c.x - lock.p.x) <= 3 && Math.abs(c.z - lock.p.z) <= 3)) continue;
    if (Object.entries(world.zones ?? {}).some(([k, zs]) => /^pen:/.test(k) && zs.some(z => fin(z.width) && fin(z.length) && c.x >= z.x && c.x < z.x + z.width! && c.z >= z.z && c.z < z.z + z.length!))) continue;
    return { at: c, name: id };
  }
  return undefined;
}

/** The job block of a profession (hallchores.ts SITE_PROFESSION the other way). */
const BLOCK_OF: Record<string, string> = {
  librarian: 'lectern', fletcher: 'fletching_table', farmer: 'composter', fisherman: 'barrel', armorer: 'blast_furnace', butcher: 'smoker', cartographer: 'cartography_table',
  cleric: 'brewing_stand', leatherworker: 'cauldron', weaponsmith: 'grindstone', shepherd: 'loom', toolsmith: 'smithing_table', mason: 'stonecutter'
};

/**
 * The ward took another job (4.3, D1, D2): the job site of that kind within 3 of it. The bot's own: lifted now, with
 * the ward by it (within 16 it is jobless at once; at 27 it never came, Nov 24), and on. In its own village's area:
 * home, with a job: let be. Someone's elsewhere: nothing touched; astray with the note, the way kept 56 off it, halt.
 */
async function otherJob(ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, profession: string, wAt: Pos): Promise<LeadEnd | undefined> {
  const kind = BLOCK_OF[profession];
  const all = await sitesNear(ctx, 48);
  const site = all.filter(s => (kind === 'cauldron' ? /cauldron$/.test(s.name ?? '') : s.name === kind) && dist(mid(s.at), wAt) <= 3.5)
    .sort((a, b) => dist(mid(a.at), wAt) - dist(mid(b.at), wAt))[0];
  if (!site) return astray(ctx, clk, plan, `became a ${profession} at ${fmt(wAt)} (its block not found by it)`);
  const who = whose(ctx.world, site, plan.home);
  if (who === 'own') {
    say(ctx, `rival: the ward took the bot's own ${site.name} at ${fmt(site.at)}: lifted with it by it`);
    const why = await liftOne(ctx, t, site, 'job site', clk.now());
    if (why) return stopNot(ctx, clk, plan, t, `the bot's own ${site.name} took the ward and could not be lifted: ${why}`);
    plan.sites = plan.sites.filter(s => !same(s.at, site.at));
    return undefined;
  }
  if (who === 'village') return dropped(ctx, clk, plan, `home, with a job: a ${profession} at its village's ${site.name} ${fmt(site.at)}`, 'rival');
  t.avoid.push({ at: { ...site.at }, r: RIVAL_R, why: `someone's free ${site.name}` });
  ctx.save?.();
  return astray(ctx, clk, plan, `took someone's ${site.name} at ${fmt(site.at)}: nothing touched`);
}

/**
 * The clock asked again before an act (a lure down, a gate held open: INV-4), as the watch asks it: its release or stop,
 * or undefined (on). The time of day is the last look's and the time since (20 ticks a second), no call of its own.
 */
async function clockSays(ctx: GoalContext, clk: LureClock, plan: Plan, inside: boolean, look: Pick<Look, 'tod' | 'now'>): Promise<LeadEnd | undefined> {
  const tod = (look.tod + Math.max(0, clk.now() - look.now) / 50) % 24_000;
  const c = clockNow(fetchOf(ctx.world), tod, inside);
  if (c.go === 'release') return release(ctx, clk, plan, `the clock: ${c.text}`, 'late');
  if (c.go === 'stop') return stop(ctx, clk, plan, `the clock: ${c.text}`);
  return undefined;
}

/** Not committed: let go; committed: stopped. */
const stopNot = (ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, why: string, kind: NonNullable<VillageSite['fetch']>['kind'] = 'no way') =>
  (t.committed ? stop(ctx, clk, plan, why) : release(ctx, clk, plan, why, kind));

/**
 * UNWEDGE (4.3, D28): a ward that has not moved in 15 s with the lure free and near is wedged, not unwilling. (1) The
 * lure to a cell on its other side; (2) a thin block of the bot's own in or beside its cell lifted (journal first,
 * dig.here, 5 s: the pavilion's fence segment freed it in 3 s, Nov 24); (3) stalled. Someone's block: never.
 */
async function unwedge(ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, w: Ward, lure: LureEntry, wAt: Pos): Promise<'again' | 'side' | LeadEnd> {
  plan.wedge = plan.wedge && plan.wedge.ward === w.key && horiz(plan.wedge.at, wAt) < 2 ? plan.wedge : { ward: w.key, at: { ...wAt }, stage: 0 };
  t.counts.wedges++;
  const stage = plan.wedge.stage++;
  if (stage === 0) { say(ctx, `wedged at ${fmt(wAt)}: the lure to its other side`); return 'side'; }
  if (stage >= 1 && stage <= 3) {
    const b = wedgeBlock(ctx.world, plan.ground, wAt);
    if (b) {
      say(ctx, `wedged at ${fmt(wAt)}: the bot's own ${b.name} at ${fmt(b.at)} lifted`);
      const why = await liftOne(ctx, t, b, 'wedge', clk.now());
      if (!why) { plan.ground.set(b.at.x, b.at.y, b.at.z, 'air'); await clk.sleep(5000); return 'again'; }
      say(ctx, `wedged: ${why}`);
    }
  }
  void lure;
  return stopNot(ctx, clk, plan, t, `stalled: wedged at ${fmt(wAt)}${stage >= 1 ? ' (nothing of the bot\'s to lift there)' : ''}`);
}

/**
 * PIN (4.3, F-5; the lead's two tables, Nov 24): another acceptable villager took the lure while the ward read none.
 * The lure stays as its job (`pin`; care fetches it after the trip, the pin broken within 16 of it); the ward is led on
 * with a spare from its own cell, 8 or more from the pin. No spare: within 96 of the village the lure changes hands
 * (the newcomer is the ward, the other home, jobless, as found); beyond, STOP. A pin beyond 96 makes its villager a
 * second ward, astray at its tether: the trip goes on, and `halt` is set when it ends.
 */
async function pin(ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, w: Ward, e: LureEntry, other: Looked): Promise<'on' | LeadEnd> {
  const f = fetchOf(ctx.world), now = clk.now();
  const village = plan.site ? { x: plan.site.x, z: plan.site.z } : w.from.at, far = horiz(e.at, village) > RELEASE_R;
  if (!acceptable(other)) {
    say(ctx, `a villager that is no ward (${usedHow(other) || 'a baby'}) took the lure at ${fmt(e.at)}: broken at once, a spot ${ELSEWHERE} off`);
    await takeLure(ctx, plan, e, now);
    (plan.pinAvoid ??= []).push({ at: { ...e.at }, r: ELSEWHERE, why: 'a claimant not acceptable' });
    return 'on';
  }
  if (await luresCarried(ctx) >= 1) {
    e.role = 'pin';
    if (plan.home && inArea(plan.home, e.at)) e.inVillage = true;
    t.counts.pins++;
    (plan.pinAvoid ??= []).push({ at: { ...e.at }, r: 8, why: 'a pin' });
    if (far && other.uuid && !f.wards.some(x => x.uuid === other.uuid)) {
      f.wards.push({ ...newWard(other, t.site, now, w.last.tod), where: 'astray', tether: { ...e.at }, note: 'pinned' });
      t.haltAtEnd = `a second villager pinned beyond ${RELEASE_R} of its village at ${fmt(e.at)}: the lead leads it home or back`;
    }
    ctx.save?.();
    say(ctx, `pinned ${other.uuid ? short(other.uuid) : `#${other.id}`} at ${fmt(e.at)}: the ward led on with a spare`);
    return 'on';
  }
  if (far) return stop(ctx, clk, plan, `a second villager took the lure at ${fmt(e.at)} beyond ${RELEASE_R} of its village, and no spare`);
  // (the lure changes hands: the newcomer is the ward from here, the other home, jobless, as found)
  f.wards = f.wards.filter(x => x !== w);
  const nw = newWard(other, t.site, now, w.last.tod);
  f.wards.push(nw);
  t.ward = nw.key;
  ctx.save?.();
  say(ctx, `no spare: the lure at ${fmt(e.at)} changes hands to ${short(nw.key)}; ${short(w.key)} home, jobless, as found`);
  return 'on';
}

/**
 * Gone from the look 3 s (4.3, D4, D18): the lure stays; a careful walk to where it was last seen and a look round 64
 * for 60 s (its uuid binds a new id). Not found: astray (dead when it went within 3 s of a fall in its health, or with
 * a hostile by it), the lure up, halt; through a portal (within 3 of a portal cell): astray in the Nether.
 */
async function lost(ctx: GoalContext, clk: LureClock, plan: Plan, w: Ward): Promise<LeadEnd | undefined> {
  if (!wardOf(fetchOf(ctx.world))) return dropped(ctx, clk, plan, OFF_RECORDS);
  const at = w.last.at, falling = plan.health.length >= 2 && plan.health[plan.health.length - 1] < plan.health[0];
  const g = plan.ground, c = cell(at);
  for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) {
    if (idOf(g.state(c.x + dx, c.y + dy, c.z + dz)) === 'nether_portal') {
      w.dim = 'nether';
      return astray(ctx, clk, plan, `gone by the portal at ${fmt({ x: c.x + dx, y: c.y + dy, z: c.z + dz })}: in the Nether, no autopilot rescue there`);
    }
  }
  // (2.1: gone within 3 s of a fall in its health, or with a hostile within 8 of it, is dead: a death nobody saw, F-8)
  const fell = falling || (plan.fellAt !== undefined && w.last.t + 1000 >= plan.fellAt && w.last.t - plan.fellAt <= GONE_S * 1000);
  const hostile = plan.hostileBy && w.last.t - plan.hostileBy.t <= GONE_S * 1000 ? plan.hostileBy : undefined;
  if (fell) return astray(ctx, clk, plan, `gone at ${fmt(at)} as its health fell (${plan.health.join(' > ')}): dead, not searched for`, true);
  if (hostile) return astray(ctx, clk, plan, `gone at ${fmt(at)} with a ${hostile.name} within 8 of it: dead, not searched for`, true);
  say(ctx, `lost the ward from sight at ${fmt(at)}: the lure stays; looking round`);
  await walkTo(ctx, cell(at), 4);
  const until = clk.now() + SEARCH_S * 1000;
  while (clk.now() < until) {
    stopped(ctx);
    const look = await lookNow(ctx, clk);
    if (!wardOf(fetchOf(ctx.world))) return dropped(ctx, clk, plan, OFF_RECORDS);
    const s = sightOf(ctx.world, look, standing(fetchOf(ctx.world), fetchOf(ctx.world).trip!)?.at);
    if (s?.taken) return dropped(ctx, clk, plan, s.taken);
    if (s?.seen) { say(ctx, `found the ward again at ${fmt(s.seen.position!)} by its uuid`); return undefined; }
    await clk.sleep(POLL_MS * 4);
  }
  return astray(ctx, clk, plan, `not found within ${SEE_R} of ${fmt(at)} for ${SEARCH_S} s`);
}

/** A cell's key. */
const key3 = (c: Pos) => `${c.x},${c.y},${c.z}`;
/** An iron golem within GOLEM_LANE of a way's cells (D27: in the ward's lane). */
const golemIn = (rows: readonly Looked[], cells: readonly Pos[]): Looked | undefined =>
  rows.find(e => e.name === 'iron_golem' && e.position && cells.some(c => horiz(mid(c), e.position!) <= GOLEM_LANE));

/** A pen of the bot's (zones `pen:<kind>`, its fence the box's edge, `pen:<kind>:gate` on it) a cell is inside, with its gate and the way out (the step off the box at the gate). */
function penAt(world: WorldMemory, c: Pos): { name: string; box: Area; gate: Pos; out: [number, number] } | undefined {
  for (const [k, zs] of Object.entries(world.zones ?? {})) {
    if (!/^pen:[a-z_]+$/.test(k)) continue;
    const z = zs[0], gate = world.zones?.[`${k}:gate`]?.[0];
    if (!z || !fin(z.width) || !fin(z.length) || !gate) continue;
    const box = { x1: z.x, z1: z.z, x2: z.x + z.width - 1, z2: z.z + z.length - 1 };
    if (!(c.x > box.x1 && c.x < box.x2 && c.z > box.z1 && c.z < box.z2)) continue;
    const out: [number, number] = gate.z === box.z1 ? [0, -1] : gate.z === box.z2 ? [0, 1] : gate.x === box.x1 ? [-1, 0] : [1, 0];
    return { name: k, box, gate: { x: gate.x, y: gate.y, z: gate.z }, out };
  }
  return undefined;
}

/**
 * E34: the ward in a pen of the bot's in the yard (its gate left open behind a stroll): led out by the pen's gate as by
 * G (4.6), inside a critical section: the pen's animals by the gate inside waited out; the hold on the shut gate first
 * (journal first), the ward's lure up (jobless at once), the bot to 2 outside the gate and 1 aside, the gate read open,
 * a lure 3 outside on its axis; the hold renewed each second until the ward is 1.5 outside the gate's line, then
 * released shut and read shut. Not out in PEN_OUT_S: the lure up, stopped or let go (the clock's way).
 */
async function penOut(ctx: GoalContext, clk: LureClock, plan: Plan, pen: { name: string; box: Area; gate: Pos; out: [number, number] }): Promise<'on' | LeadEnd> {
  const world = ctx.world, f = fetchOf(world), t = f.trip!, w = wardOf(f)!, G = pen.gate, [dx, dz] = pen.out;
  say(ctx, `the ward in the ${pen.name.slice(4)} pen: out by its gate at ${fmt(G)}`);
  const done = critical(ctx, 'gate');
  try {
    const by = { x: G.x - dx, y: G.y, z: G.z - dz };
    const until = clk.now() + ANIMAL_WAIT_S * 1000;
    let look = await lookNow(ctx, clk);
    while (animalsBy(look.rows, by, 2).length && clk.now() < until) { await clk.sleep(1000); look = await lookNow(ctx, clk); }
    if (animalsBy(look.rows, by, 2).length) return stopNot(ctx, clk, plan, t, `the ward in the ${pen.name.slice(4)} pen, its animals by the gate`);
    critical(ctx, 'gate');
    const ge = journal(ctx, { k: 'gate', trip: t.id, at: { ...G }, which: 'yard', until: clk.now() + HOLD_MS, t: clk.now() });
    await ctx.call('gates.hold', { x: G.x, y: G.y, z: G.z, ms: HOLD_MS }).catch(() => undefined);
    // (the cap counts from the hold, as G's does: INV-3's 25 s, whatever the lure's take and the walk cost)
    const opened = clk.now();
    const L = standing(f, t);
    if (L) await takeLure(ctx, plan, L, clk.now());
    await walkTo(ctx, { x: G.x + 2 * dx + dz, y: G.y, z: G.z + 2 * dz + dx });
    if ((await gateRead(ctx, G)) !== true) await ctx.call('useOn', { x: G.x, y: G.y, z: G.z, face: 'up', toggle: true }).catch(() => undefined);
    if ((await gateRead(ctx, G)) !== true) { await shutDown(ctx, G, ge); return stopNot(ctx, clk, plan, t, `the ${pen.name.slice(4)} pen's gate at ${fmt(G)} would not open`); }
    const at = { x: G.x + 3 * dx, y: G.y, z: G.z + 3 * dz };
    const put = await putLure(ctx, plan, t, at, 'yard', clk.now());
    let held = clk.now(), through = false;
    while (put.entry && clk.now() - opened < PEN_OUT_S * 1000) {
      stopped(ctx);
      if (clk.now() - held >= 1000) { critical(ctx, 'gate'); await ctx.call('gates.hold', { x: G.x, y: G.y, z: G.z, ms: HOLD_MS }).catch(() => undefined); held = clk.now(); ge.until = clk.now() + HOLD_MS; }
      const l = await lookNow(ctx, clk), row = rowOf(l.rows, w);
      beat(world, l.now);
      if (row?.position && (row.position.x - (G.x + 0.5)) * dx + (row.position.z - (G.z + 0.5)) * dz >= THROUGH) { through = true; break; }
      await clk.sleep(POLL_MS);
    }
    const open = await shutHeld(ctx, clk, plan, G, ge, `the ${pen.name.slice(4)} pen's gate`);
    if (open) return open;
    if (!through) {
      if (put.entry) await takeLure(ctx, plan, put.entry, clk.now());
      return stopNot(ctx, clk, plan, t, `not out of the ${pen.name.slice(4)} pen by its gate in ${PEN_OUT_S} s${put.why ? ` (${put.why})` : ''}`);
    }
    say(ctx, `out of the ${pen.name.slice(4)} pen; its gate shut, read shut`);
    plan.yard = undefined;
    return 'on';
  } finally {
    done();
  }
}

// ------------------------------------------------------------------------------------------------ the hop loop (4.3)

/**
 * The hops of one stretch (outside: to the yard gate's spot; inside: to S_out), from where the ward stands, re-entrant
 * from the records: a look; the guards and the clock; the next spot (hopSpot, toward the way's point a hop on); the
 * hop written (trip.hop) and saved; the old lure up with the ward by it (jobless at once; it must read none within 3 s
 * or it has traded); the bot's careful walk to its standing cell; the new lure down, journal first; the watch.
 * 'next': the ward works at the stretch's last lure.
 */
async function hops(ctx: GoalContext, clk: LureClock, plan: Plan, inside: boolean): Promise<'next' | LeadEnd> {
  const world = ctx.world, lock = lockOf(world), rz = ringPlanOf(world)?.zone;
  const ring = rz ? { x1: rz.x, z1: rz.z, x2: rz.x + rz.width - 1, z2: rz.z + rz.length - 1 } : undefined;
  let len: number | undefined, side: Pos | undefined, gone: number | undefined;
  for (;;) {
    stopped(ctx);
    const f = fetchOf(world), t = f.trip!, w = wardOf(f);
    // (taken off the records between two looks: the brain's gate watch runs wardSeen beside the lead, and someone has
    // it now; the trip ends as any ward let be ends, its lure up, not stranded in its state)
    if (!w) return dropped(ctx, clk, plan, OFF_RECORDS);
    // (in the yard it is ~180 from its village: never let go here, 4.4 rule 3; asked before the clock and every guard)
    if (inside && !t.committed) { t.committed = 'far'; ctx.save?.(); }
    const look = await lookNow(ctx, clk, PLAYER_SIGHT);
    beat(world, look.now);
    const L = standing(f, t);
    const s = sightOf(world, look, L?.at);
    if (s?.taken) return dropped(ctx, clk, plan, s.taken);
    if (!s?.seen?.position) {
      // (gone 3 s, as the watch has it: one look that failed, or missed it, is no loss)
      gone ??= look.now;
      if (look.now - gone < GONE_S * 1000) { await clk.sleep(POLL_MS); continue; }
      gone = undefined;
      const end = await lost(ctx, clk, plan, w);
      if (end) return end;
      continue;
    }
    gone = undefined;
    const e = s.seen, wAt = e.position!, wc = cell(wAt);
    // (another job already: a resume finds it so, or it took one between two looks)
    if (e.profession && e.profession !== 'none' && e.profession !== GIVES) {
      const end = await otherJob(ctx, clk, plan, t, e.profession, wAt);
      if (end) return end;
      continue;
    }
    const c = clockNow(f, look.tod, inside);
    if (c.go === 'release') return release(ctx, clk, plan, `the clock: ${c.text}`, 'late');
    if (c.go === 'stop') return stop(ctx, clk, plan, `the clock: ${c.text}`);
    const g = await guards(ctx, clk, plan, look, e, inside, c.go === 'run on');
    if (g === 'hold') { await clk.sleep(POLL_MS * 2); continue; }
    if (g) return g;
    // the stretch's last lure taken: on to the gate's step or the lock's
    const working = !!L && e.profession === GIVES && dist(wAt, mid(L.at)) <= FLIP_R + 0.5;
    if (working && ((!inside && inGateSpot(t.gate, L!.at)) || (inside && lock && same(L!.at, lock.sOut)))) return 'next';
    // D29: before 2000 the lure is no pin (an employed villager strolls from its block): a ward a pause took more than
    // 16 off it is waited for to come back by it, once: broken beyond 16 the game would not notice, and it would stay
    // employed at nothing and take no lure after
    // (a poll of the loop at a time, the clock and the guards asked at each)
    if (L && e.profession === GIVES && dist(wAt, mid(L.at)) > NOTICE_R) {
      if (plan.waitBack?.lure !== key3(L.at)) {
        plan.waitBack = { lure: key3(L.at), until: clk.now() + BACK_S * 1000 };
        say(ctx, `the ward ${Math.round(dist(wAt, mid(L.at)))} off its lure at ${fmt(L.at)} (no pin before 2000): waited for it to come back by it`);
      }
      if (clk.now() < plan.waitBack.until) { await clk.sleep(POLL_MS * 2); continue; }
    }
    // E34: in a pen of the bot's (its gate left open: a stroll, a resume): led out by the pen's gate, held as G is
    if (inside) {
      const pen = penAt(world, wc);
      if (pen && !(plan.pensOut ??= []).includes(pen.name)) {
        plan.pensOut.push(pen.name);
        const r = await penOut(ctx, clk, plan, pen);
        if (r !== 'on') return r;
        continue;
      }
    }
    // the way from where it stands, and the cells still to go (the clock's needLeft and the status line); the band
    // toward the gate read as the bot goes (the tiles read whole stay)
    if (!inside) await readBand(ctx, plan.ground, wc, t.gate.outer, BAND, look.me, READ_NEAR);
    const rest = wayFrom(world, plan, t, wc, inside, lock, { ...(ring ? { ring } : {}), ...(await hallFor(ctx).then(h => (h ? { hall: h } : {}))) });
    if ('why' in rest) return stopNot(ctx, clk, plan, t, `no way on from ${fmt(wc)}: ${rest.why}`);
    t.path = inside ? { toGate: 0, yard: rest.length } : { toGate: rest.length, yard: t.gate.yard };
    // the spot (the old lure's cell as it will be: air)
    if (L) plan.ground.set(L.at.x, L.at.y, L.at.z, 'air');
    const aim = len ?? (inside ? YARD_HOP : HOP_LEN), wedged = side;
    // (UNWEDGE step 1: a cell on the ward's other side, by it already: no hop's least progress asked of it)
    const S: Spot | { why: string } = wedged ? sideSpot(plan, world, t, wc, wedged, look.me, clk.now(), lock, ring) ?? { why: `no cell for a lure on the other side of the ward at ${fmt(wc)}` }
      : await spotFor(ctx, plan, t, wc, rest, inside, aim, look.me, clk.now(), lock, ring);
    if (L) plan.ground.set(L.at.x, L.at.y, L.at.z, LURE);
    len = undefined;
    side = undefined;
    if ('why' in S) {
      // (no cell on its other side: UNWEDGE goes on to its step 2, the lift)
      if (wedged && L) {
        say(ctx, `wedged: ${S.why}`);
        const r = await unwedge(ctx, clk, plan, t, w, L, wAt);
        if (r === 'side' || r === 'again') continue;
        return r;
      }
      return stopNot(ctx, clk, plan, t, `stalled: ${S.why}`);
    }
    // committed (4.4 rule 3): beyond 96 of its village (inside Manhattan 100 it walks straight back to its bell), or below a step it cannot climb back
    if (!t.committed && !inside) {
      const village = plan.site ?? w.from.at;
      const why = horiz(S.block, village) > RELEASE_R ? 'far' as const : S.drop > RETRACE_DROP + 1e-6 ? 'drop' as const : undefined;
      if (why) {
        t.committed = why;
        const site = liveSite(world, t);
        if (site?.whole) site.whole.takes++;
        say(ctx, `committed (${why === 'far' ? `beyond ${RELEASE_R} of the village` : `a drop of ${Math.round(S.drop * 10) / 10} by ${fmt(S.reach)}`})`);
      }
    }
    // D27: an iron golem in the lane (never a target): 10 s for it to go, then the hop aside of it
    let golem = golemIn(look.rows, S.path);
    if (golem && !plan.golem) {
      say(ctx, `an iron golem in the lane at ${fmt(golem.position!)}: waited`);
      const until = clk.now() + GOLEM_WAIT_S * 1000;
      while (golem && clk.now() < until) { await clk.sleep(POLL_MS * 2); golem = golemIn((await lookNow(ctx, clk)).rows, S.path); }
      if (golem) {
        plan.golem = { at: cell(golem.position!), r: GOLEM_ASIDE, why: 'an iron golem in the lane' };
        say(ctx, `the iron golem stays at ${fmt(golem.position!)}: the hop aside of it`);
        continue;
      }
    }
    plan.golem = undefined;
    t.hop = { n: (t.hop?.n ?? 0) + 1, ...(L ? { lure: { ...L.at } } : {}), next: { ...S.block }, replaced: t.hop?.replaced ?? 0 };
    beat(world, clk.now());
    ctx.save?.();
    // the old lure up, with the ward by it: jobless at once (beyond 16 the game would not notice: said)
    if (L) {
      const off = dist(wAt, mid(L.at));
      if (off > NOTICE_R) say(ctx, `the lure at ${fmt(L.at)} broken with the ward ${Math.round(off)} off (it is not working there)`);
      const r = await takeLure(ctx, plan, L, clk.now());
      if (!r.ok) say(ctx, `the lure at ${fmt(L.at)} not taken up: ${r.why} (care fetches it; a spare leads on)`);
      else if (r.lost) say(ctx, `the drop of the lure at ${fmt(L.at)} not picked up: the spare leads on`);
      if (r.ok && e.profession === GIVES && off <= NOTICE_R) {
        const kept = await traded(ctx, clk, w);
        if (kept) return dropped(ctx, clk, plan, `traded: someone's customer (still a ${kept} 3 s after the break at ${fmt(L.at)})`, 'rival');
      }
    }
    if (await luresCarried(ctx) < 1) return stopNot(ctx, clk, plan, t, 'no lure left in the pockets');
    // to where the bot stands, carefully: not arrived is a miss (the spot chosen again, nearer)
    if (!(await walkTo(ctx, S.botStand))) {
      t.counts.misses++;
      plan.misses++;
      plan.used.push({ at: { ...S.block }, t: clk.now() });
      say(ctx, `miss ${t.counts.misses}: no way on foot to ${fmt(S.botStand)} by the spot ${fmt(S.block)}: another spot`);
      if (plan.misses >= MISSES || t.counts.misses >= MISSES_TRIP) return stopNot(ctx, clk, plan, t, `stalled: ${plan.misses} misses in a row`);
      continue;
    }
    plan.anchorAt = anchorCell(world, plan, await here(ctx), t);
    // (the walk to the stand took up to 40 s: the clock asked again before the lure goes down, INV-4)
    const late = await clockSays(ctx, clk, plan, inside, look);
    if (late) return late;
    const put = await putLure(ctx, plan, t, S.block, inside ? 'yard' : 'hop', clk.now(), S.final === 'sout' ? { stay: true } : {});
    if (!put.entry) { plan.used.push({ at: { ...S.block }, t: clk.now() }); say(ctx, `the lure not put down at ${fmt(S.block)}: ${put.why}`); continue; }
    t.hop.placedAt = clk.now();
    ctx.save?.();
    const v = await watch(ctx, clk, plan, S.block, inside);
    const blocks = Math.round(horiz(wAt, S.block));
    switch (v.v) {
      case 'flip':
        t.counts.hops++;
        plan.misses = 0;
        say(ctx, `hop ${t.hop.n}: ${fmt(wAt)} -> ${fmt(S.block)}, ${blocks} blocks, came in ${Math.round(v.s)} s`);
        ctx.save?.();
        continue;
      case 'miss':
        t.counts.misses++;
        plan.misses++;
        say(ctx, `miss ${t.counts.misses}: not 3 nearer the lure at ${fmt(S.block)} in ${MISS_MAX_S} s: a cell at half the distance`);
        if (plan.misses >= MISSES || t.counts.misses >= MISSES_TRIP) return stopNot(ctx, clk, plan, t, `stalled: ${plan.misses} misses in a row, ${t.counts.misses} in the trip`);
        len = Math.max(HOP_MIN, Math.round(v.d / 2));
        continue;
      case 'slow':
        t.hop.replaced++;
        say(ctx, `slow: coming, no flip at the lure at ${fmt(S.block)} by ${SLOW_MAX_S} s: put one cell nearer`);
        len = Math.max(HOP_MIN, Math.round(v.d) - 1);
        continue;
      case 'still': {
        const r = await unwedge(ctx, clk, plan, t, w, put.entry, (await lookWard(ctx, clk, w)) ?? wAt);
        if (r === 'side') { const p = (await lookWard(ctx, clk, w)) ?? wAt; side = { x: Math.floor(2 * p.x - S.block.x), y: S.block.y, z: Math.floor(2 * p.z - S.block.z) }; continue; }
        if (r === 'again') continue;
        return r;
      }
      case 'job': {
        const end = await otherJob(ctx, clk, plan, t, v.profession, v.at);
        if (end) return end;
        continue;
      }
      case 'other': {
        const r = await pin(ctx, clk, plan, t, w, put.entry, v.e);
        if (r !== 'on') return r;
        continue;
      }
      case 'gone': {
        const end = await lost(ctx, clk, plan, w);
        if (end) return end;
        continue;
      }
      case 'clock':
        return v.c.go === 'release' ? release(ctx, clk, plan, `the clock: ${v.c.text}`, 'late') : stop(ctx, clk, plan, `the clock: ${v.c.text}`);
      case 'end':
        return v.end;
    }
  }
}

/** Where the ward stands now, by its uuid (one look), or undefined. */
async function lookWard(ctx: GoalContext, clk: LureClock, w: Ward): Promise<Pos | undefined> {
  const look = await lookNow(ctx, clk);
  return rowOf(look.rows, w)?.position;
}

/** A gate step's critical section (4.6, 6.2): only flight cuts it; the handler and the bridge's dead-man are the net. */
function critical(ctx: GoalContext, why: 'gate' | 'lock', ms = CRITICAL_MS): () => void {
  afield.critical = { by: ctx.signal, until: Date.now() + ms, why };
  return () => { if (afield.critical?.by === ctx.signal && afield.critical.why === why) delete afield.critical; };
}

/** Animals of the bot's (cows, sheep...) within `r` of a cell: what a gate step waits out. */
const animalsBy = (rows: readonly Looked[], at: Pos, r: number) => rows.filter(e => e.position && e.name !== 'villager' && e.name !== 'player' && e.name !== 'item'
  && !/zombie|skeleton|creeper|spider|pillager|vindicator|witch|enderman|slime|phantom|drowned|husk/.test(e.name) && dist(e.position, mid(at)) <= r);

/**
 * GATE (4.6, `gateIn`): a single hop through the yard gate, inside a critical section. Every strict gate read shut;
 * the lane read again (the bot's strays dug, anything else: the next gate); no animal of the bot's within 6 inside.
 * The hold on the SHUT gate before the walk (a hold never opens a gate; taken after the walk the closer has shut it
 * before the bot stops 2 beyond it); the gate's lure up; the bot through to 2 inside and 1 aside; the gate read open;
 * the hold renewed each second; a lure 4-6 inside on the lane's axis. The ward 1.5 inside the fence line: released
 * shut, read shut, the entry off. Never shut on it before the cap: the lure 2 farther in and the cap to 35 s. Three
 * tries, then the next gate of the spares, hop by hop.
 */
async function gateIn(ctx: GoalContext, clk: LureClock, plan: Plan): Promise<'yard' | 'hop' | LeadEnd> {
  const world = ctx.world, f = fetchOf(world), t = f.trip!, w = wardOf(f)!, G = t.gate;
  const [dx, dz] = SIDE_STEP[G.side], perp = { x: -dz, z: dx };
  const done = critical(ctx, 'gate');
  try {
    for (const s of await gatesRead(ctx, world)) if (s.open && !same(s.at, G.at)) await shutGate(ctx, s.at);
    const lane = new Ground(G.at.y - 4, 10);
    await lane.read(ctx, G.at.x - 7 * Math.abs(dx) - 2, G.at.z - 7 * Math.abs(dz) - 2, G.at.x + 7 * Math.abs(dx) + 2, G.at.z + 7 * Math.abs(dz) + 2);
    const blocked = await laneWhy(ctx, lane, { gate: G.at, side: G.side, inner: G.inner, outer: G.outer }, 'dig');
    if (blocked) return nextGate(ctx, clk, plan, blocked);
    const inside = { x: G.at.x - 2 * dx + perp.x, y: G.at.y, z: G.at.z - 2 * dz + perp.z };
    for (let tries = 0; tries < 3; tries++) {
      // the bot's animals by the gate inside: waited out, else the next gate
      let look = await lookNow(ctx, clk);
      const waitUntil = clk.now() + ANIMAL_WAIT_S * 1000;
      while (animalsBy(look.rows, { x: G.at.x - 3 * dx, y: G.at.y, z: G.at.z - 3 * dz }, 6).length && clk.now() < waitUntil) { await clk.sleep(1000); look = await lookNow(ctx, clk); }
      if (animalsBy(look.rows, { x: G.at.x - 3 * dx, y: G.at.y, z: G.at.z - 3 * dz }, 6).length) return nextGate(ctx, clk, plan, 'an animal of the bot\'s by the gate inside');
      // (no G opened for a ward past the bell, INV-4: the clock asked before the hold, as at every hop)
      const late = await clockSays(ctx, clk, plan, false, look);
      if (late) return late;
      const before = animalsBy(look.rows, { x: (world.yard!.x1 + world.yard!.x2) / 2, y: G.at.y, z: (world.yard!.z1 + world.yard!.z2) / 2 }, 200).filter(a => inYard(world, a.position!)).length;
      // the hold first, on the shut gate (journal first), in a critical section renewed with every hold of it
      critical(ctx, 'gate');
      const ge = journal(ctx, { k: 'gate', trip: t.id, at: { ...G.at }, which: 'yard', until: clk.now() + HOLD_MS, t: clk.now() });
      await ctx.call('gates.hold', { x: G.at.x, y: G.at.y, z: G.at.z, ms: HOLD_MS }).catch(() => undefined);
      const opened = clk.now();
      const L = standing(f, t);
      if (L) await takeLure(ctx, plan, L, clk.now());
      await walkTo(ctx, inside);
      if ((await gateRead(ctx, G.at)) !== true) await ctx.call('useOn', { x: G.at.x, y: G.at.y, z: G.at.z, face: 'up', toggle: true }).catch(() => undefined);
      if ((await gateRead(ctx, G.at)) !== true) { say(ctx, `the ${G.side} gate at ${fmt(G.at)} does not read open`); await shutDown(ctx, G.at, ge); return nextGate(ctx, clk, plan, 'the gate would not open'); }
      await ctx.call('gates.hold', { x: G.at.x, y: G.at.y, z: G.at.z, ms: HOLD_MS }).catch(() => undefined);
      let y = { x: G.at.x - 5 * dx, y: G.at.y, z: G.at.z - 5 * dz };
      let put = await putLure(ctx, plan, t, y, 'yard', clk.now());
      if (!put.entry) { y = { x: y.x + perp.x, y: y.y, z: y.z + perp.z }; put = await putLure(ctx, plan, t, y, 'yard', clk.now()); }
      let cap = GATE_OPEN_MAX, moved = false, held = clk.now(), through = false;
      while (clk.now() - opened < cap) {
        stopped(ctx);
        if (clk.now() - held >= 1000) { critical(ctx, 'gate'); await ctx.call('gates.hold', { x: G.at.x, y: G.at.y, z: G.at.z, ms: HOLD_MS }).catch(() => undefined); held = clk.now(); ge.until = clk.now() + HOLD_MS; }
        const l = await lookNow(ctx, clk), row = rowOf(l.rows, w);
        beat(world, l.now);
        if (row?.position) {
          const inBy = -((row.position.x - (G.at.x + 0.5)) * dx + (row.position.z - (G.at.z + 0.5)) * dz);
          if (inBy >= THROUGH) { through = true; break; }
          const inGate = same(cell(row.position), G.at);
          if (inGate && !moved && put.entry) {
            // it stands in the gateway: never shut on it; the lure 2 farther in, the cap to 35 s
            moved = true;
            cap = GATE_IN_GATEWAY_MAX;
            await takeLure(ctx, plan, put.entry, clk.now());
            y = { x: y.x - 2 * dx, y: y.y, z: y.z - 2 * dz };
            put = await putLure(ctx, plan, t, y, 'yard', clk.now());
          }
        }
        await clk.sleep(POLL_MS);
      }
      // released shut, read shut (the bridge shuts it on the release; shutGate reads it back)
      const row = rowOf((await lookNow(ctx, clk)).rows, w);
      if (!through && row?.position && same(cell(row.position), G.at)) await clk.sleep(1000);
      const open = await shutHeld(ctx, clk, plan, G.at, ge, `the ${G.side} gate`);
      if (open) return open;
      const after = animalsBy((await lookNow(ctx, clk)).rows, { x: (world.yard!.x1 + world.yard!.x2) / 2, y: G.at.y, z: (world.yard!.z1 + world.yard!.z2) / 2 }, 200).filter(a => inYard(world, a.position!)).length;
      if (after < before) say(ctx, `${before - after} animal(s) of the bot's out by the ${G.side} gate: the pens round's strays`);
      if (through) {
        say(ctx, `gate ${fmt(G.at)} held ${secs(clk.now() - opened)} s; shut, read shut; in the yard at ${Math.round((await todNow(ctx)))}`);
        tripTo(ctx, 'yardhop', clk.now());
        plan.yard = undefined;
        return 'yard';
      }
      // not through: the yard's lure up, the bot back out, the gate's lure again
      say(ctx, `not through the ${G.side} gate in ${secs(cap)} s (try ${tries + 1} of 3)`);
      if (put.entry) await takeLure(ctx, plan, put.entry, clk.now());
      await walkTo(ctx, { x: G.at.x + 3 * dx + perp.x, y: G.at.y, z: G.at.z + 3 * dz + perp.z });
      await shutGate(ctx, G.at);
      // (a lure outside the fence again: the clock first, INV-4)
      const tooLate = await clockSays(ctx, clk, plan, false, look);
      if (tooLate) return tooLate;
      const spot = { x: G.at.x + 4 * dx + 2 * perp.x, y: G.at.y, z: G.at.z + 4 * dz + 2 * perp.z };
      const again = await putLure(ctx, plan, t, spot, 'hop', clk.now());
      if (!again.entry) return nextGate(ctx, clk, plan, `no lure down outside the gate again: ${again.why}`);
      const v = await watch(ctx, clk, plan, spot, false);
      if (v.v === 'end') return v.end;
      if (v.v === 'clock') return v.c.go === 'release' ? release(ctx, clk, plan, `the clock: ${v.c.text}`, 'late') : stop(ctx, clk, plan, `the clock: ${v.c.text}`);
      if (v.v !== 'flip') return nextGate(ctx, clk, plan, `it did not come back to the gate (${v.v})`);
    }
    return nextGate(ctx, clk, plan, 'not through in three tries');
  } finally {
    done();
  }
}

/** A held gate's end: released shut by the bridge, read shut (shutGate), its entry off. */
async function shutDown(ctx: GoalContext, g: Pos, e: Change): Promise<boolean> {
  await ctx.call('gates.release', { x: g.x, y: g.y, z: g.z, shut: true }).catch(() => undefined);
  const shut = await shutGate(ctx, g);
  if (shut) dropEntry(ctx, e);
  return shut;
}
/**
 * A held gate's end that the next state needs read shut (2.2: `gate -> yardhop` and `lock -> door` with G or P read
 * shut): released shut and read; still open, clicked shut once more; open after that, STOP (its entry stays: RESTORE
 * and care's row 1 have it). Undefined: shut.
 */
async function shutHeld(ctx: GoalContext, clk: LureClock, plan: Plan, g: Pos, e: Change, name: string): Promise<LeadEnd | undefined> {
  if (await shutDown(ctx, g, e)) return undefined;
  if (await shutGate(ctx, g)) { dropEntry(ctx, e); return undefined; }
  return stop(ctx, clk, plan, `${name} at ${fmt(g)} does not read shut`);
}

/** The next gate of the spares, the ward led there hop by hop; none left: the clock's answer (committed: stopped). */
async function nextGate(ctx: GoalContext, clk: LureClock, plan: Plan, why: string): Promise<'hop' | LeadEnd> {
  const t = fetchOf(ctx.world).trip!;
  const next = t.spare.shift();
  if (!next) return stopNot(ctx, clk, plan, t, `no way in by the ${t.gate.side} gate: ${why}; no other gate`);
  say(ctx, `the ${t.gate.side} gate: ${why}: on to the ${next.side} gate`);
  t.gate = next;
  plan.way = undefined;
  tripTo(ctx, 'hop', clk.now());
  return 'hop';
}

/**
 * LOCK (4.8, `lockIn`; from the post, a critical section). The ward works at S_out; the bot on the post; H read shut,
 * nobody in the lock, no other villager within 16, no animal by P's lane. Then the order that is the point: the
 * socket's wall block out and the second lure in (a lure down only once it can be reached, or while the ward is
 * employed and does not look); P held and opened; the lure at S_out up (the drop left: picked up after). Its POSITION
 * in the box (clear of P's cell; from 8900 in P's cell will do): P released shut and read shut, the ward in the lock,
 * the lead's hold off. Not in within the cap: P shut, the ward led back to a lure one cell off S_out, again; then the clock.
 */
async function lockIn(ctx: GoalContext, clk: LureClock, plan: Plan): Promise<'door' | LeadEnd> {
  const world = ctx.world, lock = lockOf(world);
  if (!lock) return stop(ctx, clk, plan, 'no lock stands');
  const done = critical(ctx, 'lock');
  try {
    let f = fetchOf(world), t = f.trip!;
    const w = wardOf(f)!;
    // (the deadline: a bell-alive ward turns for its bell at 9000, so P shuts on its feet from 8900 and nothing opens from
    // 8990; one whose bell the lead cleared has until the lock's gate is shut by 11800)
    const deadline = w.bell ? BELL : NIGHT, lastP = w.bell ? LAST_P : NIGHT - 90;
    if (!(await walkTo(ctx, lock.post))) return stop(ctx, clk, plan, `no way on foot to the lock's post at ${fmt(lock.post)}`);
    if (!(await shutGate(ctx, lock.h))) return stop(ctx, clk, plan, `the hall's gate at ${fmt(lock.h)} does not read shut`);
    // nobody in the lock, no other villager by it, no animal by P's lane (waited out 10 s)
    const until = clk.now() + ANIMAL_WAIT_S * 1000;
    for (;;) {
      const l = await lookNow(ctx, clk);
      const inIt = l.rows.filter(e => e.position && inLock(lock, cell(e.position)) && e.name !== 'item');
      const others = l.rows.filter(e => e.name === 'villager' && e.position && e.uuid !== w.uuid && !inHallBox(world, e.position) && dist(e.position, mid(lock.p)) <= 16);
      const byLane = animalsBy(l.rows, { x: lock.p.x, y: lock.p.y, z: lock.p.z + Math.sign(lock.p.z - lock.h.z) }, 4);
      if (!inIt.length && !others.length && !byLane.length) break;
      if (clk.now() >= until) return stop(ctx, clk, plan, `the lock is not clear: ${[...inIt, ...others, ...byLane].map(e => `a ${e.name} at ${fmt(e.position!)}`)[0]}`);
      await clk.sleep(1000);
    }
    if (t.state !== 'lock') t = tripTo(ctx, 'lock', clk.now());
    f = fetchOf(world);
    // the socket: its wall block out, the second lure in its place (from the post: no walk)
    if (!f.journal.some(e => e.k === 'lure' && e.role === 'lock' && e.trip === t.id)) {
      const st = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', { ...lock.socket, width: 1, height: 1, length: 1 }).catch(() => undefined))?.blocks?.[0];
      if (!st) return stop(ctx, clk, plan, `the socket at ${fmt(lock.socket)} could not be read`);
      const wood = idOf(st);
      if (!/_air$|^air$/.test(wood)) {
        const lift = journal(ctx, { k: 'lift', trip: t.id, at: { ...lock.socket }, block: st, item: wood, st: 'planned', why: 'socket', t: clk.now() });
        const r = await ctx.own!.take(lock.socket, wood, { stay: true, pickup: false, adopt: true });
        if (!r.ok) { dropEntry(ctx, lift); return stop(ctx, clk, plan, `the socket's wall block did not come out: ${r.reason}`); }
        settle(lift, 'done');
        ctx.save?.();
      }
      const p = await putLure(ctx, plan, t, lock.socket, 'lock', clk.now(), { stay: true });
      if (!p.entry) return stop(ctx, clk, plan, `no lure into the socket: ${p.why}`);
    }
    for (let tries = 0; tries < LOCK_TRIES; tries++) {
      // P held and opened from the post (the hold registers it with the closer and exempts it from the guard), in a
      // critical section renewed with every hold of it (the walk to the post and the wait for a clear lock spent the first)
      critical(ctx, 'lock');
      const ge = journal(ctx, { k: 'gate', trip: t.id, at: { ...lock.p }, which: 'lock', until: clk.now() + HOLD_MS, t: clk.now() });
      await ctx.call('gates.hold', { x: lock.p.x, y: lock.p.y, z: lock.p.z, ms: HOLD_MS }).catch(() => undefined);
      if (morning(await todNow(ctx)) >= deadline) { await shutDown(ctx, lock.p, ge); return stop(ctx, clk, plan, w.bell ? `the bell (${BELL}) before the lock's gate opened` : `too late (${NIGHT}) for the lock's gate`); }
      if ((await gateRead(ctx, lock.p)) !== true) await ctx.call('useOn', { x: lock.p.x, y: lock.p.y, z: lock.p.z, face: 'up', toggle: true }).catch(() => undefined);
      if ((await gateRead(ctx, lock.p)) !== true) { await shutDown(ctx, lock.p, ge); return stop(ctx, clk, plan, `the lock's gate at ${fmt(lock.p)} does not read open`); }
      // the lure at S_out up: jobless at once, the socket's lure its one free site with a way
      const out = standing(fetchOf(world), t);
      if (out) await takeLure(ctx, plan, out, clk.now(), { stay: true, pickup: false });
      const opened = clk.now();
      let cap = GATE_OPEN_MAX, held = clk.now();
      while (clk.now() - opened < cap) {
        stopped(ctx);
        if (clk.now() - held >= 1000) { critical(ctx, 'lock'); await ctx.call('gates.hold', { x: lock.p.x, y: lock.p.y, z: lock.p.z, ms: HOLD_MS }).catch(() => undefined); held = clk.now(); ge.until = clk.now() + HOLD_MS; }
        const l = await lookNow(ctx, clk), row = rowOf(l.rows, w);
        beat(world, l.now);
        if (row?.position) {
          const c = cell(row.position);
          if (inLock(lock, c) || (morning(l.tod) >= lastP && same(c, lock.p))) break;
          if (same(c, lock.p)) cap = GATE_IN_GATEWAY_MAX;
        }
        if (morning(l.tod) >= deadline) break;
        await clk.sleep(POLL_MS);
      }
      const open = await shutHeld(ctx, clk, plan, lock.p, ge, 'the lock\'s gate');
      if (open) return open;
      // which side it ended on (F-9: a gate shut on a villager in its cell; one that stepped in after the last poll is in)
      const row = rowOf((await lookNow(ctx, clk)).rows, w);
      if (row?.position && inLock(lock, cell(row.position))) {
        const tod = await todNow(ctx);
        w.where = 'lock';
        w.last = { ...w.last, at: { ...row.position }, t: clk.now(), tod };
        delete w.tether;
        if (afield.ledBy === ctx.signal) afield.ledBy = undefined;
        t.path = { toGate: 0, yard: 0 };
        tripTo(ctx, 'door', clk.now());
        say(ctx, `IN THE LOCK at ${Math.round(tod)} (${Math.max(0, Math.floor((IN_BY - morning(tod)) / 20))} s in hand)`);
        return 'door';
      }
      if (morning(await todNow(ctx)) >= deadline) return stop(ctx, clk, plan, w.bell ? `not in the lock by the bell (${BELL}): the lock's gate shut` : `not in the lock by ${NIGHT}: the lock's gate shut`);
      // E30: it took the socket's lure from the yard side (a cell by the socket outside it it stands in: the sill gone):
      // the socket's lure up (it resets, within 16), and in again only once it works at S_out: the lure down once the way
      // to it is the lock's (E35's order)
      const sock = fetchOf(world).journal.find((e): e is LureEntry => e.k === 'lure' && e.role === 'lock' && e.trip === t.id);
      const fromYard = !!row?.position && row.profession === GIVES && !inLock(lock, cell(row.position)) && !!sock && dist(row.position, mid(lock.socket)) <= FLIP_R + 0.5;
      if (fromYard) {
        say(ctx, `the ward took the lock's lure from the yard side at ${fmt(row!.position!)} (no sill by the socket?): the socket's lure up, the ward led back to S_out`);
        await takeLure(ctx, plan, sock!, clk.now(), { stay: true, pickup: false });
      }
      // led back to a lure one cell off S_out (employed there a while: a missed site is forgotten 400 ticks after its last try)
      say(ctx, `not in the lock in ${secs(cap)} s (try ${tries + 1} of ${LOCK_TRIES}): led back to S_out`);
      const back = { x: lock.sOut.x + Math.sign(lock.post.x - lock.p.x), y: lock.sOut.y, z: lock.sOut.z };
      const p = await putLure(ctx, plan, t, back, 'yard', clk.now(), { stay: true });
      if (!p.entry) return stop(ctx, clk, plan, `no lure by S_out again: ${p.why}`);
      const v = await watch(ctx, clk, plan, back, true);
      if (v.v === 'end') return v.end;
      if (v.v === 'clock') return stop(ctx, clk, plan, `the clock: ${v.c.text}`);
      if (v.v !== 'flip') return stop(ctx, clk, plan, `it did not come back to S_out (${v.v})`);
      if (fromYard) {
        const again = await putLure(ctx, plan, t, lock.socket, 'lock', clk.now(), { stay: true });
        if (!again.entry) return stop(ctx, clk, plan, `no lure into the socket again: ${again.why}`);
      }
      await clk.sleep(20_000);
    }
    return stop(ctx, clk, plan, `not into the lock in ${LOCK_TRIES} tries`);
  } finally {
    done();
  }
}

/**
 * DOOR (4.8; no clock; the run does steps 1-2 at once and waits a little for 3; care repeats it from any step, P read
 * shut before each act): the socket's lure out and the wall block back in one act (a baby by it waited out); H
 * opened from the post with no hold behind the shut P (journal `gate {which: 'hall'}`: open by design). At two whole
 * looks 10 s apart with nobody in the lock and the ward in the hall: H shut from the post, the ward off the record
 * (the hall's now), the site's count, RESTORE. A ward that does not go in (the meeting, the night) stays contained
 * with H open behind a shut P: care's row 5 shuts H when the lock is empty.
 */
async function door(ctx: GoalContext, clk: LureClock): Promise<LeadEnd> {
  const world = ctx.world, lock = lockOf(world);
  const f = fetchOf(world), t = f.trip!, w = wardOf(f);
  if (!lock) return { end: 'lock', text: 'no lock stands: the door is care\'s', placed: true };
  if (!(await walkTo(ctx, lock.post))) return { end: 'lock', text: `no way on foot to the post at ${fmt(lock.post)}: the door is care's`, placed: true };
  if (!(await shutGate(ctx, lock.p))) return { end: 'lock', text: 'the lock\'s gate does not read shut: the door is care\'s', placed: true };
  const sock = f.journal.find((e): e is LureEntry => e.k === 'lure' && e.role === 'lock' && e.trip === t.id);
  if (sock) {
    const until = clk.now() + 30_000;
    while (clk.now() < until && (await lookNow(ctx, clk)).rows.some(e => e.name === 'villager' && e.baby && e.position && dist(e.position, mid(lock.socket)) <= BABY_R)) await clk.sleep(1000);
    const r = await undo(ctx, sock, { now: () => clk.now() });
    if (!r.ok) return { end: 'lock', text: `door: ${r.text} (care puts it right)`, placed: true };
    say(ctx, 'door: socket lure out, wall back');
  }
  if (!fetchOf(world).journal.some(e => e.k === 'gate' && e.which === 'hall')) journal(ctx, { k: 'gate', trip: t.id, at: { ...lock.h }, which: 'hall', t: clk.now() });
  if ((await gateRead(ctx, lock.h)) !== true) await ctx.call('useOn', { x: lock.h.x, y: lock.h.y, z: lock.h.z, face: 'up', toggle: true }).catch(() => undefined);
  say(ctx, `door: H ${(await gateRead(ctx, lock.h)) ? 'open' : 'not read open'}`);
  // the ward walks in to the free lectern when it will: two whole looks 10 s apart
  const until = clk.now() + DOOR_WAIT_S * 1000;
  let seen = 0;
  while (clk.now() < until && w) {
    stopped(ctx);
    await clk.sleep(DOOR_GAP_S * 1000);
    const l = await lookNow(ctx, clk, 128);
    const read = await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: lock.box.x1, y: lock.box.y1, z: lock.box.z1, width: lock.box.x2 - lock.box.x1 + 1, height: 1, length: lock.box.z2 - lock.box.z1 + 1 }).catch(() => undefined);
    const whole = !!read?.blocks?.length && read.blocks.every(b => b !== null);
    sightOf(world, l, undefined, true, whole);
    noteHall(world, l.rows, l.now, whole, l.tod);
    const row = rowOf(l.rows, w), inHall = !!row?.position && inHallBox(world, row.position);
    const nobody = !l.rows.some(e => e.name === 'villager' && e.position && inLock(lock, cell(e.position)));
    seen = whole && inHall && nobody ? seen + 1 : 0;
    if (seen >= 2) {
      await shutGate(ctx, lock.h);
      const g = fetchOf(world).journal.find(e => e.k === 'gate' && e.which === 'hall');
      if (g && (await gateRead(ctx, lock.h)) === false) dropEntry(ctx, g);
      const fm = fetchOf(world);
      fm.wards = fm.wards.filter(x => x.key !== w.key);
      const site = liveSite(world, t);
      if (site) site.moved = (site.moved ?? 0) + 1;
      // E24: an animal shut in the lock with the ward is no villager (DOOR waits for none): said, for the lead (S1.5 leads it out)
      for (const a of animalsBy(l.rows, lock.p, 8).filter(x => x.position && inLock(lock, cell(x.position)))) say(ctx, `a ${a.name} shut in the lock at ${fmt(a.position!)}: the lead leads it out (H shut, P shut)`);
      const times = Object.entries(t.times).map(([k, s]) => `${k} ${s}`).join(', ');
      say(ctx, `in the hall: ${(hallChoresOf(world).census?.villagers.length ?? 0)} of 3; H shut`);
      if (times) say(ctx, `timing: ${times}`);
      const text = `in the hall: ward ${short(w.key)} from ${t.site}`;
      endTrip(ctx, text, 1, clk.now());
      // (from the post, what stands in the yard: a lure left outside the fence is row 7's walk out by day, never a walk
      // of DOOR's from the lock; a pin that tethers a second ward stays its own, restoreOrder)
      const restored = await restoreAll(ctx, { now: () => clk.now(), which: e => inYard(world, e.at) });
      say(ctx, restored.text);
      return { end: 'hall', text, placed: true };
    }
  }
  return { end: 'lock', text: `ward ${w ? short(w.key) : '?'} in the lock, H open (it goes in when it will)`, placed: true };
}

// ------------------------------------------------------------------------------------------------ SURVEY and the first lure (4.1)

/** Others' builds the way keeps 16 off (foreign.zones): not the village's own houses (in its area), not the yard. */
async function zonesFor(ctx: GoalContext, home?: Area): Promise<Zone[]> {
  const r = await ctx.call<{ zones?: Zone[] }>('foreign.zones', {}).catch(() => undefined);
  const meets = (z: Zone, a: Area) => z.x1 <= a.x2 && z.x2 >= a.x1 && z.z1 <= a.z2 && z.z2 >= a.z1;
  const yard = yardArea(ctx.world);
  return (Array.isArray(r?.zones) ? r.zones : []).filter(z => (z.surface ?? true) && !(home && meets(z, home)) && !(yard && meets(z, yard)));
}
/** The job sites about, sorted into the way's keep-offs: someone's (and nobody's) a circle of 56 the way keeps out of. */
function noteSites(plan: Plan, t: Trip, world: WorldMemory, found: readonly JobSite[]): void {
  for (const s of found) {
    if (plan.sites.some(o => same(o.at, s.at))) continue;
    plan.sites.push(s);
    if (whose(world, s, plan.home) === 'foreign' && !t.avoid.some(a => same(a.at as Pos, s.at))) t.avoid.push({ at: { ...s.at }, r: RIVAL_R, why: `a free ${s.name} that is not the bot's` });
  }
}
/** The seconds a trip needs in hand from the village (4.4's start rule, the walk out done: fetch.ts startNeed with `out` 0). */
const needHere = (plan: Plan, t: Trip) => startNeed({ out: 0, toGate: plan.way?.length ?? 1.25 * horiz(plan.site ?? t.gate.outer, t.gate.outer), yard: t.gate.yard });

/** What a run that ended hands the work wrapper (6.1): in the hall or the lock 1; nothing placed `untried`; placed and given up 0, 'same'. */
const resultOf = (r: { text: string; placed: boolean; got?: boolean }): WorkResult =>
  (r.got ? { gain: 1, text: r.text } : r.placed ? { gain: 0, text: r.text, mark: 'same' } : { gain: 0, text: r.text, untried: true });
/** The trip over before any lure: restored (nothing of it is out but its lifts, held for the next) and said. */
function endBefore(ctx: GoalContext, clk: LureClock, text: string): WorkResult {
  say(ctx, text);
  endTrip(ctx, text, 0, clk.now());
  return resultOf({ text, placed: false });
}

/**
 * SURVEY (4.1): the quick look of the trip's morning asks only for a candidate and no danger (one viewpoint cannot
 * count a village 126 x 121: the floor is the last whole look's). Illagers or an outpost: home. A player by the bot or
 * the village: waited 60 s, then looked only. The candidates: unemployed adults, not named, on a lead, riding, past
 * level 1, penned in, nor a ward, of this village (two bells in one look: its own only). The clock from where the bot
 * stands. The village's ground read, its job sites sorted, others' builds kept off, and the corridor from the
 * candidates' side to the gate (on water, a rise or a drop: one more band to each side of the place, asked again).
 */
async function survey(ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, site: VillageSite): Promise<{ candidates: Looked[] } | { end: WorkResult }> {
  const world = ctx.world, me = await here(ctx);
  const danger = await dangerAt(ctx, me, 32, [{ x: site.x, z: site.z, ...(site.area ? { area: site.area } : {}) }]);
  if (danger) return { end: endBefore(ctx, clk, `turned back at the village: ${danger}`) };
  let look = await lookNow(ctx, clk, PLAYER_SIGHT);
  const until = clk.now() + PLAYER_HOLD_S * 1000;
  for (let by = playerNow(look.rows as Seen[], me, site.area); by; by = playerNow(look.rows as Seen[], me, site.area)) {
    if (clk.now() >= until) return { end: endBefore(ctx, clk, `looked only at the village: ${by}`) };
    await clk.sleep(5000);
    look = await lookNow(ctx, clk, PLAYER_SIGHT);
  }
  // the village's ground (its area, as far as the chunks round the bot reach) for its candidates' pens and the first lure
  const a = site.area ?? { x1: site.x - 48, z1: site.z - 48, x2: site.x + 48, z2: site.z + 48 };
  plan.home ??= { ...a };
  await plan.ground.read(ctx, Math.max(a.x1, Math.floor(me.x) - READ_NEAR), Math.max(a.z1, Math.floor(me.z) - READ_NEAR), Math.min(a.x2, Math.floor(me.x) + READ_NEAR), Math.min(a.z2, Math.floor(me.z) + READ_NEAR));
  const wards = new Set(fetchOf(world).wards.flatMap(w => [w.key, w.uuid ?? '']));
  const block = (x: number, y: number, z: number) => plan.ground.state(x, y, z) ?? null;
  const tally = { employed: 0, nitwits: 0, babies: 0, used: 0, penned: 0 };
  const mine = look.rows.filter(e => e.name === 'villager' && e.position && (site.area ? inArea(site.area, e.position) : horiz(e.position, site) <= 80));
  const candidates = mine.filter(e => {
    if (e.baby) { tally.babies++; return false; }
    if (e.profession === 'nitwit') { tally.nitwits++; return false; }
    if (e.profession && e.profession !== 'none') { tally.employed++; return false; }
    if (usedHow(e) || wards.has(e.uuid ?? '')) { tally.used++; return false; }
    if (pennedIn(block, cell(e.position!))) { tally.penned++; return false; }
    return true;
  });
  if (!candidates.length) {
    const why = Object.entries(tally).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'no villager seen';
    noteSite(world, t, 'no unemployed', why, clk.now());
    return { end: endBefore(ctx, clk, `no usable villager in reach at ${fmt(site)}: ${why}`) };
  }
  const floor = floorOk(site, clk.now());
  if (!floor.ok) return { end: endBefore(ctx, clk, `the village at ${fmt(site)}: ${floor.text}`) };
  // the job sites about, and others' builds
  noteSites(plan, t, world, await sitesNear(ctx));
  plan.zones = await zonesFor(ctx, plan.home);
  // the corridor from the candidates' side to the yard gate's outer cell
  const starts = [...candidates].sort((p, q) => horiz(p.position!, t.gate.outer) - horiz(q.position!, t.gate.outer)).map(e => cell(e.position!));
  const from = starts[0];
  const hall = await hallFor(ctx);
  const opts = { zones: plan.zones, avoid: t.avoid, sites: plan.sites, home: plan.home, lifted: liftedFor(world, plan, t), lures: tripLures(fetchOf(world), t.id), yard: yardGround(world), ...(hall ? { hall } : {}) };
  const wayFrom0 = (at: Pos) => { const w = corridor(plan.ground, at, t.gate.outer, { ...opts, retrace: true }); return w.ok ? w : corridor(plan.ground, at, t.gate.outer, opts); };
  let c = wayFrom0(from);
  if (!c.ok && (c.why === 'water' || c.why === 'rise' || c.why === 'drop')) {
    // (the bot swims and climbs where a villager needs the ford 30 aside: one more band of 24 each side of the place)
    await plan.ground.read(ctx, c.at.x - BAND, c.at.z - BAND, c.at.x + BAND, c.at.z + BAND);
    c = wayFrom0(from);
  }
  // (no way by the model from where the nearest candidate stands, indoors or upstairs (it knows no house): from the
  // others, then from where the bot stands in the village; the first lure's open spot leaves the rest to the game, 4.1)
  plan.wayNotFromCandidate = false;
  for (const at of [...starts.slice(1), cell(me)]) {
    if (c.ok) break;
    const w = wayFrom0(at);
    if (w.ok) { c = w; plan.wayNotFromCandidate = same(at, cell(me)); }
  }
  if (!c.ok) {
    noteSite(world, t, c.why === 'rival' ? 'rival' : 'no way', c.text, clk.now());
    ctx.dump?.('fetch-way', { site: { x: site.x, y: site.y, z: site.z, area: site.area }, from, gate: t.gate, why: c.text, ground: plan.ground.dump() });
    return { end: endBefore(ctx, clk, `no villager's way home from ${fmt(site)}: ${c.text}`) };
  }
  plan.way = c.cells;
  t.path = { toGate: c.len, yard: t.gate.yard };
  // the clock from where the bot stands: no first lure that cannot be in the lock by 8700 ("looked only")
  const late = startLate(look.tod, needHere(plan, t));
  if (late) { noteSite(world, t, 'late', late, clk.now()); return { end: endBefore(ctx, clk, `looked only at the village: ${late}`) }; }
  // the village's marks (any kind) the first lure keeps 3 off
  const m = await ctx.call<{ at?: Pos[] }>('foreign.marks', { x1: a.x1, z1: a.z1, x2: a.x2, z2: a.z2, match: '.*', max: 512 }).catch(() => undefined);
  plan.marks = Array.isArray(m?.at) ? m.at.map(cell) : [];
  ctx.save?.();
  return { candidates };
}

type FirstSays = { v: 'flip'; e: Looked; s: number } | { v: 'not acceptable'; e: Looked } | { v: 'nobody' } | { v: 'claim'; e?: Looked } | { v: 'by'; e?: Looked } | { v: 'clock'; text: string };
/**
 * The watch at the first lure (4.1): a villager that read `none` in this look before it went down, a fletcher within
 * 2.5 of it now, is the ward whoever was expected (acceptable) or broken off at once (not); nobody 3 nearer in 15 s;
 * someone coming and no flip by 45 s (waited to 60: a claim holds the ticket up to 60 s); someone by it 10 s and no
 * flip (a nitwit, a baby, an employed one, one that has traded: let be).
 */
async function watchFirst(ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, lure: Pos, none: Set<string>): Promise<FirstSays> {
  const t0 = clk.now(), key = (e: Looked) => e.uuid ?? `#${e.id}`;
  let d0: number | undefined, best = Infinity, byLure: number | undefined;
  for (;;) {
    stopped(ctx);
    const look = await lookNow(ctx, clk);
    beat(ctx.world, look.now);
    const vs = look.rows.filter(e => e.name === 'villager' && e.position);
    const flip = vs.find(e => none.has(key(e)) && e.profession === GIVES && dist(e.position!, mid(lure)) <= FLIP_R);
    if (flip) return acceptable(flip) ? { v: 'flip', e: flip, s: (look.now - t0) / 1000 } : { v: 'not acceptable', e: flip };
    const late = startLate(look.tod, needHere(plan, t));
    if (late) return { v: 'clock', text: late };
    const near = vs.filter(e => none.has(key(e))).sort((a, b) => dist(a.position!, mid(lure)) - dist(b.position!, mid(lure)))[0];
    const d = near ? dist(near.position!, mid(lure)) : Infinity;
    d0 ??= d;
    best = Math.min(best, d);
    const el = (look.now - t0) / 1000;
    const by = vs.find(e => dist(e.position!, mid(lure)) <= FLIP_R);
    byLure = by ? byLure ?? look.now : undefined;
    if (by && byLure !== undefined && look.now - byLure >= BY_LURE_S * 1000) return { v: 'by', e: by };
    if (d0 - best < 3 && el >= APPROACH_FIRST_S) return { v: 'nobody' };
    if (el >= SLOW_MAX_S || (el >= ARRIVE_S && d0 - best >= 3 && best > FLIP_R + 2)) return { v: 'claim', ...(near ? { e: near } : {}) };
    await clk.sleep(POLL_MS);
  }
}

/**
 * The first lure, L0 (4.1): not before 100, and never where the clock says the ward could not be in the lock by 8700
 * from here; the spot (firstSpot: nearest the corridor's start, within 24 path cells of a candidate, 3 clear of a
 * village's marks, nothing over it; else an open spot 12-32 off: the game is the judge); the bot on its standing cell;
 * who reads `none` now; the lure down (`village`, inVillage); the watch. Three spots, then the lure up, the site
 * `no claim` and a dump for an offline replay. The ward is created `led` at the flip, and the trip goes on to `hop`.
 */
async function firstLure(ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, candidates: Looked[]): Promise<'hop' | WorkResult> {
  const world = ctx.world;
  let tries = 0, last = '', placed = false, cands = candidates, off = false, nearer = false;
  // (where the next spot is sought nearest: the corridor's start; half way to a claimant that did not arrive; the last
  // spot itself, for one cell off it)
  let toward: { x: number; z: number } | undefined;
  while (tries < FIRST_TRIES) {
    stopped(ctx);
    let tod = await todNow(ctx);
    while (morning(tod) < UP_AT) { await clk.sleep(5000); tod = await todNow(ctx); }
    const late = startLate(tod, needHere(plan, t));
    if (late) { noteSite(world, t, 'late', late, clk.now()); return { ...endBefore(ctx, clk, `looked only at the village: ${late}`), ...(placed ? { mark: 'same' as const } : {}) }; }
    const me = await here(ctx), f = fetchOf(world);
    // a zombie by the candidates: fought first (the guard), then the lure (a panicking villager takes no job, and by a
    // zombie that stands it hovers about 8 off: within 12 counts)
    const pre0 = await lookNow(ctx, clk);
    const z = pre0.rows.find(e => ZOMBIE.test(e.name) && e.position && pre0.rows.some(c => c.name === 'villager' && c.position && cands.some(k => k.uuid === c.uuid) && dist(c.position, e.position!) <= PANIC_R));
    if (z) {
      say(ctx, `a ${z.name} at ${fmt(z.position!)} by the candidates: fought first`);
      const axe = ((await ctx.call<{ items?: { name: string; slot: number }[] }>('inventory').catch(() => undefined))?.items ?? []).find(i => i.slot < SLOTS && /_axe$/.test(i.name));
      if (axe) await ctx.call('item.select', { name: axe.name }).catch(() => undefined);
      await ctx.act('attack-entity', { target: `#${z.id}`, maxDistance: 24, timeoutMs: HOSTILE_HOLD_S * 1000, collect: false }).catch(() => undefined);
    }
    const kept: { at: Pos; t: number }[] = [];
    const start = toward ?? (plan.wayNotFromCandidate ? undefined : plan.way?.[0]) ?? t.gate.outer;
    toward = undefined;
    const spot = spotOff(plan, () => firstSpot(plan.ground, cands.map(c => cell(c.position!)), start, {
      bot: cell(me), marks: plan.marks ?? [], ...(plan.home ? { home: plan.home } : {}), zones: plan.zones, sites: plan.sites, avoid: t.avoid,
      lifted: liftedFor(world, plan, t), lures: tripLures(f, t.id), used: [...plan.used, ...kept], now: clk.now(), retrace: true, yard: yardGround(world),
      ...(nearer ? { path: NEARER_FIRST, level: true } : {})
    }), kept, clk.now());
    nearer = false;
    if ('why' in spot) { last = spot.why; break; }
    if (!(await walkTo(ctx, spot.botStand))) { plan.used.push({ at: { ...spot.block }, t: clk.now() }); tries++; last = `no way on foot to ${fmt(spot.botStand)}`; continue; }
    const pre = await lookNow(ctx, clk);
    const none = new Set(pre.rows.filter(e => e.name === 'villager' && e.profession === 'none').map(e => e.uuid ?? `#${e.id}`));
    const put = await putLure(ctx, plan, t, spot.block, 'village', clk.now());
    if (!put.entry) { plan.used.push({ at: { ...spot.block }, t: clk.now() }); last = `not put down at ${fmt(spot.block)}: ${put.why}`; tries++; continue; }
    placed = true;
    const placedAt = clk.now();
    say(ctx, `first lure at ${fmt(spot.block)} (spot ${tries + 1} of ${FIRST_TRIES}${spot.open ? ', an open spot: the game is the judge' : ''})`);
    const r = await watchFirst(ctx, clk, plan, t, spot.block, none);
    if (r.v === 'flip') {
      const fm = fetchOf(world), tod2 = await todNow(ctx), ward = newWard(r.e, t.site, clk.now(), tod2);
      fm.wards.push(ward);
      t.ward = ward.key;
      t.hop = { n: 0, lure: { ...spot.block }, placedAt, replaced: 0 };
      afield.ledBy = ctx.signal;
      tripTo(ctx, 'hop', clk.now());
      say(ctx, `ward ${short(ward.key)} took it in ${Math.round(r.s)} s (${GIVES}, ${ward.last.health}/20)`);
      return 'hop';
    }
    await takeLure(ctx, plan, put.entry, clk.now());
    tries++;
    if (r.v === 'clock') { noteSite(world, t, 'late', r.text, clk.now()); return { ...endBefore(ctx, clk, `the first lure up: ${r.text}`), mark: 'same' }; }
    if (r.v === 'not acceptable') {
      last = `a villager not to take (${usedHow(r.e) || 'a baby'}) took the lure: let be`;
      say(ctx, last);
      (plan.pinAvoid ??= []).push({ at: { ...spot.block }, r: ELSEWHERE, why: 'a claimant not acceptable' });
      continue;
    }
    if (r.v === 'nobody') {
      last = `nobody came 3 nearer the lure at ${fmt(spot.block)} in ${APPROACH_FIRST_S} s`;
      // (4.1: a spot nearer the nearest candidate, within 12 path cells of it on its own level; the 40-circles of a
      // claimant not to take stay)
      const nearest = [...cands].sort((p, q) => dist(p.position!, mid(spot.block)) - dist(q.position!, mid(spot.block)))[0];
      cands = [nearest];
      nearer = true;
      say(ctx, `${last}: a spot within ${NEARER_FIRST} path cells of the nearest, on its level`);
      continue;
    }
    if (r.v === 'by') {
      // (C7: a nitwit or a baby takes no job: another spot, away from it; another that took none: one cell off, once)
      const none = !!r.e && (r.e.baby || r.e.profession === 'nitwit');
      last = `a villager stood by the lure at ${fmt(spot.block)} ${BY_LURE_S} s and took no job${none ? ` (${r.e!.baby ? 'a baby' : 'a nitwit'})` : ''}`;
      if (none) { (plan.pinAvoid ??= []).push({ at: { ...spot.block }, r: BY_ELSEWHERE, why: 'a villager by it that takes no job' }); say(ctx, `${last}: another spot`); continue; }
      if (!off) { off = true; toward = { ...spot.block }; say(ctx, `${last}: one cell off`); continue; }
    }
    if (r.v === 'claim') {
      // (C6: the claim held its ticket and it did not come: broken, which frees the ticket, and re-placed half way to it)
      last = `a claim without arrival at ${fmt(spot.block)} (${SLOW_MAX_S} s)`;
      if (r.e?.position) {
        cands = [r.e];
        toward = { x: (r.e.position.x + spot.block.x + 0.5) / 2, z: (r.e.position.z + spot.block.z + 0.5) / 2 };
        say(ctx, `${last}: re-placed half way to the claimant at ${fmt(r.e.position)}`);
        continue;
      }
    } else last = `no flip at ${fmt(spot.block)}`;
    say(ctx, last);
  }
  const text = `no claim at the village: ${last}`;
  noteSite(world, t, 'no claim', last || 'no first lure taken', clk.now());
  ctx.dump?.('fetch-first', { site: t.site, candidates: candidates.map(c => ({ id: c.id, uuid: c.uuid, at: c.position })), used: plan.used, why: last, ground: plan.ground.dump() });
  say(ctx, text);
  endTrip(ctx, text, 0, clk.now());
  return resultOf({ text, placed });
}

/**
 * A dry run (rollout step 3, B14): everything planned, logged and dumped, nothing placed or dug: the candidates, the
 * corridor, the first lure's spot, each hop's spot along the corridor (the ward put where the last spot's reach is),
 * the gate, the yard's way; the walk out's seconds and the corridor's cells kept on the site for the first real dawn.
 */
async function dryRun(ctx: GoalContext, clk: LureClock, plan: Plan, t: Trip, site: VillageSite, candidates: Looked[]): Promise<WorkResult> {
  const world = ctx.world, me = await here(ctx), lines: string[] = [];
  const o = { bot: cell(me), ...(plan.home ? { home: plan.home } : {}), zones: plan.zones, sites: plan.sites, avoid: t.avoid, lifted: liftedFor(world, plan, t), retrace: true, yard: yardGround(world), hall: await hallFor(ctx) };
  const first = firstSpot(plan.ground, candidates.map(c => cell(c.position!)), plan.way?.[0] ?? t.gate.outer, { ...o, marks: plan.marks ?? [] });
  lines.push('why' in first ? `first lure: ${first.why}` : `first lure at ${fmt(first.block)}`);
  let at = 'why' in first ? undefined : first.reach, n = 0;
  while (at && n < 20 && horiz(at, t.gate.outer) > HOP_MAX) {
    const rest = plan.way!.slice(plan.way!.reduce((b, c, i) => (horiz(c, at!) < horiz(plan.way![b], at!) ? i : b), 0));
    const s = hopSpot(plan.ground, at, rest[Math.min(rest.length - 1, HOP_LEN)], { ...o, bot: at });
    if ('why' in s) { lines.push(`hop ${n + 1}: ${s.why}`); break; }
    lines.push(`hop ${++n}: ${fmt(at)} -> ${fmt(s.block)}`);
    at = s.reach;
  }
  const lock = lockOf(world);
  if (lock) {
    const g = groundFor(world, site);
    await readYard(ctx, g);
    const w = yardWay(g, { gate: t.gate.at, side: t.gate.side, inner: t.gate.inner }, lock.sOut, { yard: yardGround(world) });
    lines.push(w.ok ? `the ${t.gate.side} gate, the yard's way ${w.len}` : `the yard's way: ${w.text}`);
  }
  const s = liveSite(world, t);
  if (s) {
    noteSite(world, t, s.fetch?.kind ?? 'late', 'measured by a dry run', clk.now(), true);
    s.fetch!.pathLen = plan.way?.length ?? 0;
    if (fin(t.times.out)) s.fetch!.outS = t.times.out;
  }
  ctx.dump?.('fetch-dry', { site: t.site, lines, way: plan.way, ground: plan.ground.dump() });
  for (const l of lines) say(ctx, `dry: ${l}`);
  const text = `dry run at ${fmt(site)}: ${n} hop(s) planned, the corridor ${plan.way?.length ?? 0} cells`;
  endTrip(ctx, text, 0, clk.now());
  return { gain: 0, text, mark: 'same' };
}

// ------------------------------------------------------------------------------------------------ the runs

const handled = new WeakSet<AbortSignal>();
/**
 * The exit handler once per run, where the run was cut (a survival goal, a kill, set-autonomy off), or where a lead
 * ended by a throw that is no cut (`failed`: a bug's path, bridge data not as expected): the trip is then left as a cut
 * leaves it (its gates released shut, the ward astray at its tether, `trip.cut`), for care's row 3 to resume, never
 * stranded in a leading state with its lure, its lifts and the lead's hold kept.
 */
async function onCut(ctx: GoalContext, clk: LureClock, why: string, failed = false): Promise<void> {
  if ((!ctx.signal.aborted && !failed) || handled.has(ctx.signal)) return;
  handled.add(ctx.signal);
  await exitHandler(ctx, clk, why);
}
/** The states a lead is under way in (its hold `out.ledBy` kept): a throw out of one of them runs the exit handler. */
const LEADING: readonly string[] = ['hop', 'gate', 'yardhop', 'lock'];
const sprint = (ctx: GoalContext, allowed: boolean) => brainRun.exit(() => ctx.call('sprint.set', { allowed })).catch(() => undefined);

/**
 * The dawn's re-read before a prepared trip sets out (2.2 `prep -> out`): the lock and the ring ready, every strict gate
 * read shut (shut where open), the kit whole, every lift as journaled (a planned one made true by a read). Why not.
 */
async function reread(ctx: GoalContext, t: Trip): Promise<string | undefined> {
  const shells = await readShells(ctx);
  if (shells.lock.faults.length) return `the lock is not ready: ${shells.lock.faults[0].text}`;
  if (shells.ring.faults.length) return `the portal's ring is not ready: ${shells.ring.faults[0]}`;
  for (const g of await gatesRead(ctx, ctx.world)) if (g.open && !(await shutGate(ctx, g.at))) return `${g.name} at ${fmt(g.at)} does not read shut`;
  const lures = await luresCarried(ctx);
  if (lures < LURES) return `the kit is not whole: ${lures} of ${LURES} lures carried`;
  for (const e of fetchOf(ctx.world).journal.filter(x => x.trip === t.id && x.k === 'lift')) {
    const r = await reconcile(ctx, e);
    if (r === 'gone') return `a lift of the trip is not as journaled at ${fmt(e.at)} (its block stands): lifted again by the next PREP`;
  }
  return undefined;
}

/**
 * The `villagers` rung's run for a prepared trip (`bring:<site>`, at dawn): the re-read, a meal if hungry, the start
 * rule (the ward in the lock by 8700, or not set out: the seconds go to `fetch.why.dawn`), OUT by the trip's gate
 * reading the band home as it walks (and the job sites every 96 blocks), SURVEY, the first lure, and on with `leadOn`.
 * What it hands the work wrapper (6.1): 1 in the hall or the lock; `untried` when nothing was placed (a player at the
 * village, looked only, no candidate); 0 and 'same' when it placed and gave up (the wait is in `site.fetch`).
 */
export async function fetchRun(ctx: GoalContext, site: VillageSite, clk: RunClock): Promise<WorkResult> {
  const world = ctx.world;
  const off = switchesWhy(world);
  if (off) return { gain: 0, text: `no villager fetched: ${off}`, untried: true };
  const f = fetchOf(world), t = f.trip;
  if (t && t.state !== 'prep' && t.state !== 'restore') return { gain: 0, text: `trip ${t.id} is ${t.state}: care goes on with it`, untried: true };
  if (!t || t.state !== 'prep' || !t.prepared) return { gain: 0, text: 'no trip prepared for this morning', untried: true };
  const s = siteNow(villagesOf(world).sites, site) ?? site;
  if (t.site !== variantOf(s)) return { gain: 0, text: `the trip is prepared for ${t.site}, not ${variantOf(s)}`, untried: true };
  // (prepared dry and made real since, villager-moves {dry:false}: its lifts were only said, so the next PREP makes them
  // first; a real trip never sets out past the bot's own job blocks)
  if (t.prep.dry && !t.dry) {
    delete t.prepared;
    delete t.prep.lifts;
    delete t.prep.dry;
    ctx.save?.();
    say(ctx, 'not set out: the trip was prepared dry, its lifts only said: PREP lifts them first');
    return { gain: 0, text: 'not set out: the trip was prepared dry (its lifts owed)', untried: true };
  }
  const plan = planOf(world, t, s);
  try {
    const why = await reread(ctx, t);
    if (why) {
      noteWhy(world, 'dawn', why, clk.now());
      return endBefore(ctx, clk, `not set out: ${why}`);
    }
    // hungry at dawn: eats in the yard, never beside a villager
    if (((await ctx.status().catch(() => undefined))?.food ?? ctx.s.food) < FED) await ctx.act('eat', {}).catch(() => undefined);
    const tod = await todNow(ctx), home = ctx.s.home ?? ctx.s.position;
    const needS = startNeed(needParts(s, home, t.gate.outer, t.gate.yard)), late = startLate(tod, needS);
    if (late) {
      noteWhy(world, 'dawn', late, clk.now());
      ctx.save?.();
      say(ctx, `not set out: ${late}`);
      return { gain: 0, text: `not set out: ${late}`, untried: true };
    }
    noteWhy(world, 'dawn', undefined, clk.now());
    if (fin(f.armed)) f.armed = Math.max(0, f.armed - 1);
    tripTo(ctx, 'out', clk.now(), { tod });
    say(ctx, `set out for (${s.x}, ${s.z}): need ${Math.round(needS)} s, ${Math.max(0, Math.floor((IN_BY - morning(tod)) / 20) - Math.round(needS))} s in hand`);
    await sprint(ctx, false);
    await readYard(ctx, plan.ground);
    const gate = await outByGate(ctx, { x: s.x, z: s.z }, [t.gate.side]);
    if (gate.shut) return endBefore(ctx, clk, `not out by the ${t.gate.side} gate: ${gate.shut}`);
    let scanned: Pos = await here(ctx);
    noteSites(plan, t, world, await sitesNear(ctx));
    const enough = clk.enough ?? (() => false);
    const stoppedWhy = await walkOut(ctx, t.gate.outer, s, enough, async () => {
      const me = await here(ctx);
      beat(world, clk.now());
      await readBand(ctx, plan.ground, t.gate.outer, s, BAND, me, READ_NEAR);
      if (horiz(me, scanned) >= SCAN_EVERY) { noteSites(plan, t, world, await sitesNear(ctx)); scanned = me; }
    });
    if (stoppedWhy) return endBefore(ctx, clk, stoppedWhy);
    await readBand(ctx, plan.ground, t.gate.outer, s, BAND, await here(ctx), READ_NEAR);
    tripTo(ctx, 'survey', clk.now());
    const sv = await survey(ctx, clk, plan, t, s);
    if ('end' in sv) return sv.end;
    if (t.dry) return await dryRun(ctx, clk, plan, t, s, sv.candidates);
    tripTo(ctx, 'first', clk.now());
    const first = await firstLure(ctx, clk, plan, t, sv.candidates);
    if (first !== 'hop') return first;
    const lead = await leadOn(ctx, clk);
    return resultOf({ text: lead.text, placed: true, got: lead.end === 'hall' || lead.end === 'lock' });
  } finally {
    await onCut(ctx, clk, 'the run was cut');
    await sprint(ctx, true);
  }
}

/**
 * The hop loop from the records (4.3): the rung's run after the first flip, and care's resume and the armed rescue
 * (a trip in `hop`, `gate`, `yardhop`, `lock` or `door` with its ward). A ward the records have astray (a cut, a
 * restart) is looked for by its uuid within 64 of its tether or where it was last seen first; then the stretches in
 * turn: the hops to the yard gate's spot, the gate, the yard's hops to S_out, LOCK, DOOR. What it came to.
 */
export async function leadOn(ctx: GoalContext, clk: LureClock): Promise<LeadEnd> {
  const world = ctx.world, f = fetchOf(world), t = f.trip;
  if (!t || !['hop', 'gate', 'yardhop', 'lock', 'door'].includes(t.state)) return { end: 'none', text: 'no trip to lead', placed: false };
  const w = wardOf(f);
  if (!w) return { end: 'none', text: `trip ${t.id} has no ward to lead`, placed: false };
  const plan = planOf(world, t, siteOfTrip(world, t));
  try {
    if (t.state !== 'door') afield.ledBy = ctx.signal;
    await sprint(ctx, false);
    if (w.where === 'astray') {
      const near = w.tether ?? t.hop?.lure ?? w.last.at;
      if (horiz(await here(ctx), near) > 24) await walkTo(ctx, cell(near), 6);
      const look = await lookNow(ctx, clk);
      const s = sightOf(world, look, standing(f, t)?.at);
      if (!s?.seen) return astray(ctx, clk, plan, `not found within ${SEE_R} of ${fmt(near)}`);
      w.where = 'led';
      delete w.tether;
      delete w.note;
      ctx.save?.();
    }
    // the ground round it: the yard, the band to the gate, the job sites and the builds about
    await readYard(ctx, plan.ground);
    if (t.state === 'hop') {
      await readBand(ctx, plan.ground, w.last.at, t.gate.outer, BAND, await here(ctx), READ_NEAR);
      if (!plan.zones.length) plan.zones = await zonesFor(ctx, plan.home);
    }
    if (!plan.sites.length) noteSites(plan, t, world, await sitesNear(ctx));
    for (;;) {
      stopped(ctx);
      const state = fetchOf(world).trip?.state;
      if (state === 'hop') {
        const r = await hops(ctx, clk, plan, false);
        if (r !== 'next') return r;
        tripTo(ctx, 'gate', clk.now());
      } else if (state === 'gate') {
        const r = await gateIn(ctx, clk, plan);
        if (r !== 'yard' && r !== 'hop') return r;
        if (r === 'hop') await readBand(ctx, plan.ground, w.last.at, fetchOf(world).trip!.gate.outer, BAND, await here(ctx), READ_NEAR);
      } else if (state === 'yardhop') {
        const r = await hops(ctx, clk, plan, true);
        if (r !== 'next') return r;
        const l = await lockIn(ctx, clk, plan);
        if (l !== 'door') return l;
      } else if (state === 'lock') {
        const l = await lockIn(ctx, clk, plan);
        if (l !== 'door') return l;
      } else if (state === 'door') return await door(ctx, clk);
      else return { end: 'none', text: `the trip is ${state ?? 'gone'}`, placed: true };
    }
  } catch (e) {
    if (!ctx.signal.aborted && LEADING.includes(fetchOf(world).trip?.state ?? '')) {
      await onCut(ctx, clk, `the lead failed: ${String((e as Error)?.message ?? e)}`, true).catch(() => undefined);
    }
    throw e;
  } finally {
    await onCut(ctx, clk, 'the lead was cut');
    if (afield.ledBy === ctx.signal && !LEADING.includes(fetchOf(world).trip?.state ?? '')) afield.ledBy = undefined;
    await sprint(ctx, true);
  }
}
