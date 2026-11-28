import { fromGate, nearHome, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import {
  ASTRAY_HOLD, GAME_DAY, LURES, RELEASE_R, clock as tripClock, dropEntry, endTrip, fetchOf, inHallOrLock, journal, needLeft, newTrip, openByDesign, peekFetch, reconcile,
  restoreAll, restoreOrder, tripTo, undo, wardSeen, type Change, type ClockSays, type FetchMemory, type LureClock, type Trip, type Ward, type YardGateWay
} from './fetch.js';
import { liveCritical, out as afield } from './pockets.js';
import { gateRead, gatesRead, inByGate, inFence, onYardFence, openGate, outByGate, shutGate, strictGates, yardGates, yardWhy } from './yardgates.js';
import { inLock, isStand, lockOf, lockPlanOf, step, type Lock, type LockPlan } from './villagerwalk.js';
import { gameDay, inHallBox, noteHall, throughLock } from './hallchores.js';
import { plugOut } from './hallshells.js';
import { prepare, prepareBill } from './project.js';
import { clock as hhmm } from './idlelog.js';
import { usedHow, villagesOf, type Seen as Looked } from './village.js';
import { lureSite } from './villagemove.js';
import { Ground } from './boatroute.js';
import { daylightLeft, WORK_AT } from './schedule.js';
import { leadOn, prep, type LeadEnd } from './lure.js';

/**
 * What the villager fetch has left in the world, brought back to the state it should stand in (idle-plan V, 6.1): the
 * care goal, and the goal that takes the bot out of the villager hall when it is found in there with no chores visit
 * under way. S0's half: care's rows 1, 2, 4 and 5 (a gate left open, the lock's socket and the build's plug, a villager
 * shut in the lock, the hall's gate open behind the lock's shut one). S1's, the trip's: row 3 a trip nobody drives any
 * more (a cut, a kill, a restart) resumed from its records (3.3), 6 the lead's armed rescue of a ward astray, 7 a lure
 * of the bot's left outside the fence (in a village, a pin, an anchor) fetched, 8 the journal undone (RESTORE), and a
 * prepared trip not out by 2000 put back, 9 what waits on the lead said once a game day, 10 PREP for tomorrow's trip.
 * The acts of a lead are lure.ts's (leadOn, prep). Imported, not loaded when first asked as the rung does: a module
 * loaded by import() under the tests' loader is a second copy of it and of what it imports (pockets.ts's `out` among
 * them), and care must see the lead's own hold on it (out.ledBy) as the brain does. Nothing lure.ts imports imports care.
 *
 * Why a goal of its own, and one the brain never silences: on Nov 24 the second villager led home got out by the
 * hall's gate, which stood open with it awake, and on the night before the yard's west gate stood open behind the
 * bot's own walk. Nothing owned either gate. Care owns every gate the bridge reports left open (the strict gates:
 * yardgates.ts strictGates), and what the lock needs of it. It obeys no switch: the moves off, the lock and the gates
 * still protect whoever lives in the hall. A row that cannot do its work now says so and is tried again soon (it
 * never throws for that: a throw's hold, three failures until the morning and the loop watch are how the brain
 * silences a goal, and a goal that shuts gates must not be silenced); a row that waits on something outside it (a
 * villager in the way, a gate that will not shut) is not asked again for half a minute, so the rest of care and the
 * rest of the brain go on meanwhile.
 *
 * The bot found inside the hall or its lock with no chores visit under way (a visit cut short, a restart, a person's
 * walk in) is taken out through the lock by `out of the hall`, a survival goal: only flight comes before it. A chores
 * visit's own stay inside is a critical section (pockets.ts out.critical, `hall`), and that goal leaves it be.
 */

const MINUTE = 60_000;
/** Care works within this of home (across the ground, on home's level): the yard, its gates, the lock. */
const CARE_NEAR = 96;
/** The gate watch's read (brain.ts: every 5 s while it watches) counts this long; older, nothing is known of the gates. */
const GATES_FRESH = 30_000;
/** A look into the lock (noteLock) counts this long. */
const LOOK_FRESH = 2 * MINUTE;
/**
 * The waits (ms; tests set them and hand a sleep on their own clock): `gapMs` between the two looks a row asks for (a
 * ward missed on two whole looks, the lock found empty on two); `rowMs`, how long a row that could not do its work now
 * is not asked again; `outMs`, how long `out of the hall` waits before it tries again a way out it found shut. A test's
 * `sleep` and `now` are its world's clock: a lead's waits (lure.ts) run on them too.
 */
export const CARE_WAITS: { gapMs: number; rowMs: number; outMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = { gapMs: 10_000, rowMs: 30_000, outMs: 20_000 };
/** Whom the lock is kept for (what the bridge's guard counts: a villager, a wandering trader). */
const VILLAGER = /^(villager|wandering_trader)$/;
/** The socket's fault as the lock's read words it (villagerwalk.ts lockFaults) when its cell is air: the wall block is owed. */
const SOCKET_OPEN = /^the socket is no wall block: (air|cave_air|void_air) at /;

/** Row 7: the walk out and back at 3.5 b/s and a minute there fit the daylight left; the walk goes in careful legs this long. */
const WALK_BS = 3.5;
const THERE_S = 60;
const LEG = 32;
/** A lure out there that did not come up is not walked out to again for this long. */
const FETCH_RETRY = 10 * MINUTE;
/** The way home from a ward outside the fence, as the straight way stretched by a quarter (fetch.ts `need`'s stretch). */
const STRETCH = 1.25;
/** PREP's hours (lure.ts prep): its reads and kit from 6000 the day before, the lifts from 9000, all by 12300; a stamp 6000 ticks old is done again. */
const PREP_FROM = 6000;
const LIFTS_FROM = 9000;
const PREP_TO = 12_300;
const PREP_STALE = 6000 * 50;
/** A prepared trip not out by this time of day is put back (2.2: its lifts are the bot's again for the day). */
const OUT_BY = 2000;
/** PREP that did not prepare (declined, or its next part not due) is not asked again for this long. */
const PREP_RETRY = 2 * MINUTE;
/** An entry whose undo failed three times (R-4) is tried again this often; meanwhile row 9 says it once a game day. */
const STUCK_RETRY = GAME_DAY;
/** The first lure's worker (3.3 `first`): an employed villager keeps within ~9 of its block. */
const WORKS_AT = 9;
/** A villager notices its job site gone within this (jobless at once): a lure is taken up with its worker this near. */
const NOTICE_R = 16;
/** The lure's profession (S1: the fletching table, fixed), and the lure. */
const GIVES = 'fletcher';
const LURE = 'fletching_table';
/** The animals the lock is kept clear of (a cow followed the ward in: E24); what row 9 asks the lead about. */
const ANIMAL = /^(cow|sheep|pig|chicken|horse|donkey|mule|goat|rabbit|llama|mooshroom|camel|cat|wolf|fox|armadillo|sniffer|turtle|frog|panda|parrot)$/;

/** What a look (world.entities) gives of one entity, as far as care asks (`uuid` on every row from the S0 jar on). */
type Seen = Looked & { health?: number };
type Rows = Pick<GoalContext, 's' | 'world'>;

const fmt = (p: Pos) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const same = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b && Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);
const idOf = (state: string | null | undefined) => (state ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');

/** When each run began (real ms): ctx.s.now is the run's start (as hallchores.ts and hallshells.ts keep it). */
const began = new WeakMap<object, number>();
const clock = (ctx: Pick<GoalContext, 's'>) => CARE_WAITS.now?.() ?? ctx.s.now + Math.max(0, Date.now() - (began.get(ctx) ?? Date.now()));
const todNow = (ctx: Pick<GoalContext, 's'>) => ctx.s.timeOfDay + Math.max(0, Date.now() - (began.get(ctx) ?? Date.now())) / 50;
const stopped = (ctx: Pick<GoalContext, 'signal'>) => { if (ctx.signal.aborted) throw new Error('aborted'); };

/** A wait that ends early when the run is given up (the brain gives a stopped run 5 s, then goes on beside it). */
const pause = (ctx: Pick<GoalContext, 'signal'>, ms: number): Promise<void> => {
  if (CARE_WAITS.sleep) return CARE_WAITS.sleep(ms);
  return new Promise<void>(res => {
    const done = () => { clearTimeout(t); ctx.signal.removeEventListener('abort', done); res(); };
    const t = setTimeout(done, ms);
    ctx.signal.addEventListener('abort', done, { once: true });
  });
};

/** The clock a lead's waits run on (lure.ts LureClock): the run's time and its abortable sleep. */
const careClock = (ctx: GoalContext): LureClock => ({ now: () => clock(ctx), sleep: ms => pause(ctx, ms) });
/** The time of day as read now (status), else the snapshot's and the real time since. */
const todRead = async (ctx: GoalContext): Promise<number> => {
  const t = (await ctx.status().catch(() => undefined))?.timeOfDay;
  return typeof t === 'number' && Number.isFinite(t) ? t : todNow(ctx);
};
/** The time of day as the work day runs: from the bot's dawn (23500) on, the minutes before 0 as a negative. */
const morning = (tod: number) => { const t = ((tod % 24_000) + 24_000) % 24_000; return t >= WORK_AT ? t - 24_000 : t; };
/** By day: the bot's work day, from its dawn to the walk home at 11000 (schedule.ts). */
const byDay = (tod: number) => daylightLeft(tod) > 0;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const cellOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const mid = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
const inYardBox = (world: WorldMemory, p: { x: number; z: number }) => { const y = world.yard; return !!y && p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2; };
const short = (key: string) => key.slice(0, 8);

const here = async (ctx: Pick<GoalContext, 'status' | 's'>): Promise<Pos> => (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;

const walkTo = async (ctx: Pick<GoalContext, 'call'>, to: Pos, range = 0, xz = false): Promise<boolean> =>
  (await ctx.call<{ arrived?: boolean }>('goto', { x: to.x, y: to.y, z: to.z, range, careful: true, ...(xz ? { xz: true } : {}), timeoutMs: 30_000 }, 45_000).catch(() => ({ arrived: false })))?.arrived !== false;

const stateAt = async (ctx: Pick<GoalContext, 'call'>, p: Pos): Promise<string | undefined> =>
  (await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: p.x, y: p.y, z: p.z, width: 1, height: 1, length: 1 }).catch(() => undefined))?.blocks?.[0] ?? undefined;

// ------------------------------------------------------------------------------------------------ the lock as last looked into

/** The last look into the lock, per world (in this process: after a restart the gate watch looks again within half a minute). */
const lockLooks = new WeakMap<WorldMemory, { at: number; villagers: number; animals?: string[] }>();

/**
 * A look (world.entities) noted for the care goal's gate: how many villagers stand in the lock's six cells, and when;
 * and the animals shut in there (a cow followed the ward in: the lead's, said by row 9). The brain's gate watch looks
 * every half minute while a lock stands; the rows' own looks are noted too. A look from where the lock is out of
 * sight must not be given here: it would say the lock is empty. How many villagers, undefined with no lock or no look.
 */
export function noteLock(world: WorldMemory, seen: readonly Seen[] | undefined, now: number): number | undefined {
  const lock = lockOf(world);
  if (!lock || !Array.isArray(seen)) return undefined;
  const there = seen.filter(e => e && !!e.position && inLock(lock, e.position));
  const villagers = there.filter(e => VILLAGER.test(e.name)).length;
  const animals = there.filter(e => ANIMAL.test(e.name)).map(e => `a ${e.name} at ${fmt(e.position!)}`);
  lockLooks.set(world, { at: now, villagers, ...(animals.length ? { animals } : {}) });
  return villagers;
}

/** The lock as last looked into (noteLock), or undefined. */
export const lockSeen = (world: WorldMemory): { at: number; villagers: number; animals?: string[] } | undefined => lockLooks.get(world);

/**
 * A look into the lock that can be trusted: its six cells read (in the seconds after a rejoin the client reads every
 * cell null and sees nobody), then who is in it. Undefined where either look failed or the cells were not read.
 */
async function lookInto(ctx: GoalContext, lock: Lock): Promise<{ villagers: number } | undefined> {
  const b = lock.box;
  const r = await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: b.x1, y: b.y1, z: b.z1, width: b.x2 - b.x1 + 1, height: b.y2 - b.y1 + 1, length: b.z2 - b.z1 + 1 }).catch(() => undefined);
  if (!Array.isArray(r?.blocks) || !r.blocks.length || r.blocks.some(x => x === null || x === undefined)) return undefined;
  const e = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128 }).catch(() => undefined);
  if (!Array.isArray(e?.entities)) return undefined;
  return { villagers: noteLock(ctx.world, e.entities, clock(ctx)) ?? 0 };
}

/**
 * A whole look (R-9): the floor of the hall and of the lock read with no cell null, then everyone about. Only such a
 * look finds a ward gone or counts the hall: a blind one (just after a rejoin) concludes nothing. Undefined where it
 * is not whole or a look failed.
 */
async function wholeLook(ctx: GoalContext, type?: string): Promise<Seen[] | undefined> {
  const h = ctx.world.zones?.hall?.[0], lock = lockOf(ctx.world);
  if (h && Number.isFinite(h.width) && Number.isFinite(h.length)) {
    const b = lock?.box;
    const x1 = Math.min(h.x, b?.x1 ?? h.x), z1 = Math.min(h.z, b?.z1 ?? h.z);
    const x2 = Math.max(h.x + h.width! - 1, b?.x2 ?? h.x), z2 = Math.max(h.z + h.length! - 1, b?.z2 ?? h.z);
    const r = await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: x1, y: h.y + 1, z: z1, width: x2 - x1 + 1, height: 1, length: z2 - z1 + 1 }).catch(() => undefined);
    if (!Array.isArray(r?.blocks) || !r.blocks.length || r.blocks.some(x => x === null || x === undefined)) return undefined;
  }
  const e = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128, ...(type ? { type } : {}) }).catch(() => undefined);
  if (!Array.isArray(e?.entities)) return undefined;
  if (!type) noteLock(ctx.world, e.entities, clock(ctx));
  return e.entities;
}

// ------------------------------------------------------------------------------------------------ what is owed

/**
 * The rows (6.1). S0's: 1 a gate left open, 2 the lock's socket or the build's plug, 4 a villager shut in the lock, 5
 * the hall's gate to shut behind it. S1's: 3 a trip nobody drives resumed, 6 the armed rescue, 7 a lure left outside
 * the fence fetched, 8 RESTORE, 9 what waits on the lead, 10 PREP. `quiet`: a row that stops no run (row 1 for gates
 * that will not stay shut; row 3 for a trip cut before anything of it was out).
 */
export type CareRow = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type CareOwed = { row: CareRow; want: string; quiet?: true } | { none: Decline };
type Owed = { row: CareRow; want: string; quiet?: true };
/** The rows done at home (within 96 of it, on its level): the gates, the lock, the restore, PREP (from the yard itself). The trip's rows go where it is. */
const HOME_ROWS: ReadonlySet<CareRow> = new Set<CareRow>([1, 2, 4, 5, 8, 10]);
/** How urgent each row is (6.1): 75 for what is owed now (under food's 76 and the shelter's 80, over the kit's 70 and every chore), 62 for the rescue, the fetch and the restore, 35 for the lead's word and PREP (a chore among chores). */
const urgencyOf = (row: CareRow) => (row <= 5 ? 75 : row <= 8 ? 62 : 35);

/** The rows that answered "not now", per world: not asked again before then (real ms, in this process). */
const rowWaits = new WeakMap<WorldMemory, Partial<Record<CareRow, number>>>();
const waitRow = (ctx: Rows, row: CareRow, ms = CARE_WAITS.rowMs) => { rowWaits.set(ctx.world, { ...rowWaits.get(ctx.world), [row]: clock(ctx) + ms }); };

/**
 * Gates that will not stay shut (row 1 cannot win them: one under redstone power, which the bridge never clicks and
 * reports left open; a click the server refuses, read shut for a round trip and then open again). A round is lost to
 * a gate that does not read shut, or whose shut has not held a minute when it is left open again. After LOST_ROUNDS
 * in a row the gate is left alone for STUBBORN_WAIT, and while it is stubborn (rounds lost to it within STUBBORN_MS)
 * its row stops no run: it waits for the running goal's end. Else row 1 came back every half minute at urgency 75,
 * cut whatever ran each time, and the day's work starved on one gate. Per world and gate (real ms, in this process).
 */
type Bounce = { n: number; shutAt?: number; lostAt?: number; until?: number };
const bounces = new WeakMap<WorldMemory, Record<string, Bounce>>();
const LOST_ROUNDS = 2;
const HELD_MS = MINUTE;
const STUBBORN_WAIT = 10 * MINUTE;
const STUBBORN_MS = 60 * MINUTE;
const gateKey = (p: Pos) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const bounceOf = (world: WorldMemory, p: Pos): Bounce | undefined => bounces.get(world)?.[gateKey(p)];
const stubborn = (b: Bounce | undefined, now: number) => !!b && b.n >= LOST_ROUNDS && now - (b.lostAt ?? -Infinity) < STUBBORN_MS;
const leftAlone = (world: WorldMemory, p: Pos, now: number) => (bounceOf(world, p)?.until ?? 0) > now;

/** The lock's lure in its socket, on the journal (a trip's LOCK put it there). */
const lockLureIn = (f: Pick<FetchMemory, 'journal'>, socket: Pos) => f.journal.some(e => e.k === 'lure' && e.role === 'lock' && same(e.at, socket));
type Hall = Extract<Change, { k: 'gate' }>;
const hallEntries = (f: Pick<FetchMemory, 'journal'>, h: Pos): Hall[] => f.journal.filter((e): e is Hall => e.k === 'gate' && e.which === 'hall' && same(e.at, h));
const covers = (f: Pick<FetchMemory, 'journal'>) => f.journal.filter(e => e.k === 'cover' && e.what === 'hall door');

/**
 * What waits on the lead at the lock (row 9; the Fetch line's word, beside what fetch.ts fetchLine says itself: the
 * halt, an astray ward and its two days, the stuck entries, PREP declined): an animal shut in the lock with the ward
 * (DOOR waits for no animal: E24), and the hall's gate open behind the lock's shut one a game day or more (the ward in
 * the lock does not go on: E26; the lock occupied for days starves the hall).
 */
function lockAsks(world: WorldMemory, f: Pick<FetchMemory, 'journal' | 'gates' | 'trip'>, now: number): string[] {
  const lock = lockOf(world), out: string[] = [];
  if (!lock) return out;
  const look = lockLooks.get(world);
  if (look?.animals?.length && now - look.at <= LOOK_FRESH) out.push(`${look.animals.join(', ')} shut in the lock: the lead leads it out (H and P shut)`);
  const h = hallEntries(f, lock.h)[0], t = f.trip;
  const since = t?.state === 'door' && typeof t.entered === 'number' ? Math.min(t.entered, h?.t ?? Infinity) : h?.t;
  if (h && since !== undefined && now - since >= GAME_DAY && f.gates?.open.some(p => same(p, lock.h))) {
    out.push(`the hall's gate open behind the lock's shut one since ${hhmm(since)} (over a game day): the villager in the lock does not go in (the lead)`);
  }
  return out;
}

/**
 * The trip's half of care has something to say: the fetch is the lure's (villager-moves {method: 'lure'}), or a trip or a
 * ward stands on its records. Before that (S0's records, the boat's) row 9 and its notes are silent: the bot says
 * nothing it did not say before the lure.
 */
const tripHalf = (f: Pick<FetchMemory, 'method' | 'trip' | 'wards'>) => f.method === 'lure' || !!f.trip || f.wards.length > 0;

/** brain-status's word on the gates care leaves alone or lets wait, and what waits on the lead at the lock (fetch.ts fetchLine's `notes`). */
export function careNotes(world: WorldMemory, now: number): string[] {
  const gates = Object.entries(bounces.get(world) ?? {}).filter(([, b]) => stubborn(b, now)).map(([k, b]) =>
    `the gate at (${k.split(',').join(', ')}) will not stay shut (${b.n} rounds lost to it: under redstone power, or its click refused)${(b.until ?? 0) > now ? `: left alone till ${hhmm(b.until!)}` : ''}, and it stops no run`);
  const f = world.fetch ? peekFetch(world) : undefined;
  return f && tripHalf(f) ? [...gates, ...lockAsks(world, f, now)] : gates;
}

/** The rows of S0 owed now (pure): the gate watch's last read, the journal, the lock's last read and look. */
function homeRows(s: Pick<Snapshot, 'now'>, world: WorldMemory, f: FetchMemory, lock: Lock | undefined): Owed[] {
  const rows: Owed[] = [];
  const g = f.gates && s.now - f.gates.at <= GATES_FRESH ? f.gates : undefined;
  // 1. (the bridge's leftOpen: open, nobody holding it, and the bot out of reach of it or it open 5 s: the second or
  // two of a passage is nobody's business; and not the hall's gate opened behind the lock's shut one by design)
  const left = g ? g.leftOpen.filter(p => !openByDesign(world, p) && !leftAlone(world, p, s.now)) : [];
  const quiet = left.every(p => stubborn(bounceOf(world, p), s.now));
  if (left.length) rows.push({ row: 1, want: `a gate left open at ${fmt(left[0])}${left.length > 1 ? ` (and ${left.length - 1} more)` : ''}: shut it${quiet ? ' (it will not stay shut: when the run ends)' : ''}`, ...(quiet ? { quiet: true as const } : {}) });
  if (!lock) return rows;
  // 2. (the socket's wall block, owed whenever no trip is at the lock: a trip's lure in it is the trip's, and once
  // the trip is over RESTORE's, which takes it out and puts the wall back in one act)
  const atLock = (!!f.trip && (f.trip.state === 'lock' || f.trip.state === 'door')) || lockLureIn(f, lock.socket);
  const socket = f.journal.some(e => e.k === 'lift' && e.why === 'socket' && same(e.at, lock.socket)) || !!f.shells?.lock.some(t => SOCKET_OPEN.test(t));
  if (socket && !atLock) rows.push({ row: 2, want: `the lock's socket at ${fmt(lock.socket)} stands open: its wall block back` });
  else if (covers(f).length && !f.shells?.building) rows.push({ row: 2, want: 'a plug left in the hall\'s doorway with the lock standing: taken up' });
  // 4. and 5. (by the gate watch's read of the two gates and the last look into the lock)
  const look = lockLooks.get(world), seen = look && s.now - look.at <= LOOK_FRESH ? look : undefined;
  const hOpen = g?.open.some(p => same(p, lock.h)), pOpen = g?.open.some(p => same(p, lock.p));
  if (g && seen && seen.villagers > 0 && !hOpen && !pOpen) rows.push({ row: 4, want: `${seen.villagers === 1 ? 'a villager' : `${seen.villagers} villagers`} shut in the lock: the hall's gate opened for it from the post` });
  if (g && hallEntries(f, lock.h).length && !pOpen && !(seen && seen.villagers > 0)) {
    if (hOpen && seen) rows.push({ row: 5, want: 'the hall\'s gate open behind the lock\'s shut one, and nobody left in the lock: shut from the post' });
    else if (!hOpen) rows.push({ row: 5, want: 'the hall\'s gate reads shut: its journal entry dropped' });
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------ the trip's rows (S1), owed

/** The states row 3 resumes a trip from (3.3); a run leads in those from `first` on. */
const RESUMED: readonly Trip['state'][] = ['out', 'survey', 'first', 'hop', 'gate', 'yardhop', 'lock', 'door'];
/**
 * A run of this process is at the trip now: a run of the work queue (the rung's: its walk out, its first lure, its walk
 * home), a lead's hold (out.ledBy), a gate step's or the lock's critical section. Its beat may be 20 s old between two
 * polls (a careful walk to a lure's stand); it is no trip of nobody's, and care cuts no lead. With none of them, the
 * trip is nobody's (3.3): cut (the exit handler ran), killed, or a brain started again over its records, whose beat on
 * disk is the old process's, fresh or stale (one brain runs at a time).
 */
const driven = (now: number) => afield.work || (!!afield.ledBy && !afield.ledBy.aborted) || (liveCritical(now)?.why ?? 'hall') !== 'hall';

type LureEntry = Extract<Change, { k: 'lure' }>;
/** The trip's lure standing now: the last of its lures that went down that is no pin and not the lock's. */
const standingOf = (f: Pick<FetchMemory, 'journal'>, t: Pick<Trip, 'id'>): LureEntry | undefined =>
  [...f.journal].reverse().find((e): e is LureEntry => e.k === 'lure' && e.trip === t.id && e.role !== 'pin' && e.role !== 'lock' && e.st !== 'planned');
/** DOOR's first acts not all done (the lock's lure or its socket's wall block still owed, or the hall's gate not yet opened by design): row 3's. What is left after them is row 5's. */
const doorOwed = (f: Pick<FetchMemory, 'journal'>, t: Pick<Trip, 'id'>, lock: Lock) =>
  f.journal.some(e => e.trip === t.id && ((e.k === 'lure' && e.role === 'lock') || (e.k === 'lift' && e.why === 'socket'))) || !hallEntries(f, lock.h).length;
const armedOk = (f: Pick<FetchMemory, 'armed'>) => f.armed === 'free' || (typeof f.armed === 'number' && f.armed > 0);

/** Where a ward stands as the records have it, and the yard gate a lead home takes (the nearest to it), with the cells still to go. */
function rescueWay(world: WorldMemory, w: Ward): { at: Pos; inside: boolean; gate: YardGateWay; spare: YardGateWay[]; toGate: number; yard: number } | undefined {
  const lock = lockOf(world), at = w.tether ?? w.last.at, inside = inFence(world, at);
  if (!lock) return undefined;
  const ways = yardGates(world).map(g => ({ at: g.gate, side: g.side, inner: g.inner, outer: g.outer, yard: Math.abs(g.inner.x - lock.sOut.x) + Math.abs(g.inner.z - lock.sOut.z) }))
    .sort((a, b) => horiz(a.outer, at) - horiz(b.outer, at));
  if (!ways.length) return undefined;
  const yard = inside ? Math.abs(Math.floor(at.x) - lock.sOut.x) + Math.abs(Math.floor(at.z) - lock.sOut.z) : ways[0].yard;
  return { at, inside, gate: ways[0], spare: ways.slice(1), toGate: inside ? 0 : STRETCH * horiz(at, ways[0].outer), yard };
}
/** The clock for leading a ward home from where it is (2.3's window, 4.4's rules: a lead not yet committed asks COMMIT x what is left), or undefined with no lock or no gate. */
const rescueClock = (world: WorldMemory, w: Ward, tod: number): ClockSays | undefined => {
  const r = rescueWay(world, w);
  return r && tripClock(tod, needLeft(r.toGate, r.yard), w, {}, { inside: r.inside });
};

/**
 * The lures of the bot's outside the fence that no trip under way owns and no ward still out works at (row 7, F-18): a
 * village's lure of a trip ended, a pin, an anchor left by a cut, oldest first. A trip cut short owns its lures until
 * row 3 has gone on with it; once it is over, nothing of the bot's stays out there (INV-2: RESTORE takes up the same)
 * but a tether: a pin beyond 96 made its villager a second ward, astray at it (4.3), and taken up it would be jobless
 * far from its village. That one is the lead's (row 9 says it; the armed rescue leads it from there).
 */
function looseLures(world: WorldMemory, f: Pick<FetchMemory, 'journal' | 'trip' | 'wards'>): LureEntry[] {
  const t = f.trip;
  return f.journal.filter((e): e is LureEntry => e.k === 'lure' && !inYardBox(world, e.at) && !(t && e.trip === t.id && t.state !== 'restore')
    && !f.wards.some(w => (w.where === 'led' || w.where === 'astray') && !!w.tether && same(w.tether, e.at)));
}

/** How many of an item are in the pockets (the main slots). */
async function carriedOf(ctx: GoalContext, name: string): Promise<number> {
  const inv = await ctx.call<{ items?: { name: string; count: number; slot: number }[] }>('inventory').catch(() => undefined);
  return (inv?.items ?? []).filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
}

/** Why a trip in PREP is put back (2.2 `prep -> restore`): prepared and not out by 2000 (the dawn missed), the moves switched off, the method changed, halt, the yard not whole or the trip's gate off its fence (yardgates.ts yardWhy). */
function prepBack(world: WorldMemory, f: Pick<FetchMemory, 'trip' | 'halt' | 'method'>, tod: number): string | undefined {
  const t = f.trip;
  if (t?.state !== 'prep') return undefined;
  if (world.villagerMoves !== true) return 'villager moves switched off';
  if (f.method !== 'lure') return `the method is ${f.method ?? 'boat'}, not the lure`;
  if (f.halt) return `halted: ${f.halt.why}`;
  // (the yard not whole, or the trip's gate gone off its fence: the trip would be prepared or set out on a stale gate
  // into a yard open on one side, S1 follow-up R2, path P1. With the yard held while a trip exists, only a growth begun
  // before it, or a hand from outside the brain, gets here; row 8 comes before PREP's row 10, so its next part never runs)
  const yw = yardWhy(world);
  if (yw) return `the yard is not whole: ${yw}`;
  if (!onYardFence(world, t.gate.at)) return `its ${t.gate.side} gate is no longer on the yard's fence`;
  const m = morning(tod), p = t.prepared;
  // (by the time of day: past 2000 and before the next PREP's hours; by the game day too, where the idle tally counts one)
  if (p && ((m >= OUT_BY && m < PREP_FROM) || (gameDay(world) > p.day && m >= OUT_BY))) return `prepared and not out by ${OUT_BY}`;
  return undefined;
}

/** When each stuck entry (3 failed undos) was last tried in this process, per world: tried again a game day later. */
const stuckTried = new WeakMap<WorldMemory, Map<number, number>>();
const stuckWaits = (world: WorldMemory, e: Pick<Change, 'id' | 'tries'>, now: number) => (e.tries ?? 0) >= 3 && now - (stuckTried.get(world)?.get(e.id) ?? -Infinity) < STUCK_RETRY;
/** What row 8 undoes from the yard: everything in RESTORE's order but the lures outside the fence (row 7's walk out). */
const restoredHere = (world: WorldMemory) => (e: Change) => e.k !== 'lure' || inYardBox(world, e.at);

/** What waits on the lead (row 9), in words: once a game day in the log, nothing done. */
function leadAsks(world: WorldMemory, f: FetchMemory, now: number): string[] {
  const out: string[] = [];
  if (f.halt) out.push(`HALT: ${f.halt.why}`);
  const yw = yardWhy(world);
  for (const w of f.wards.filter(x => x.where === 'astray' || x.where === 'dead')) {
    const days = now - w.last.t >= ASTRAY_HOLD;
    const held = !days && w.where === 'astray' && !w.dim && yw ? `: no rescue while the yard is not whole (${yw})` : '';
    out.push(`ward ${short(w.key)} ${w.where}${w.dim ? ' in the Nether' : ''} at ${fmt(w.last.at)}${w.note ? ` (${w.note})` : ''}${days ? ': 2 game days on, its lifts go back; villager-moves {forget} lets it go' : held}`);
  }
  out.push(...lockAsks(world, f, now));
  if ((f.why?.prep?.n ?? 0) >= 3) out.push(`PREP declined ${f.why!.prep!.n} days: ${f.why!.prep!.text}`);
  const stuck = f.journal.filter(e => (e.tries ?? 0) >= 3);
  if (stuck.length) out.push(`${stuck.map(e => `${e.k}${'item' in e ? ` ${e.item}` : ''} at ${fmt(e.at)}`).join(', ')} would not come undone in 3 tries`);
  return out;
}
/** When row 9 last spoke, per world (in this process): by the idle tally's game day, else a game day's real time since. */
const askedOn = new WeakMap<WorldMemory, { day: number; at: number }>();
const askedToday = (world: WorldMemory, now: number) => {
  const a = askedOn.get(world), day = gameDay(world);
  return !!a && (day > 0 ? a.day === day : now - a.at < GAME_DAY);
};

/**
 * PREP owed (row 10, 2.2's first row): no trip and a village tomorrow's trip is for (villagemove.ts lureSite, the one
 * choice) in PREP's hours, PREP not declined today; or a trip in PREP not prepared whose next part is due now.
 */
function prepWant(s: Pick<Snapshot, 'now' | 'timeOfDay' | 'position' | 'home'>, world: WorldMemory, f: FetchMemory): string | undefined {
  const t = f.trip, tod = s.timeOfDay, evening = tod >= PREP_FROM && tod <= PREP_TO;
  if (!t) {
    if (!evening) return undefined;
    // (declined today already: the afternoon is the chores', as work.ts's stay-in lets the far rungs go for it)
    const no = f.why?.prep, d = gameDay(world);
    if (no && (d > 0 && typeof no.day === 'number' ? no.day === d : s.now - no.at < GAME_DAY)) return undefined;
    const r = lureSite(s, world);
    return 'why' in r ? undefined : `PREP for tomorrow's trip to ${r.variant} (needs ${Math.round(r.needS)} s)`;
  }
  if (t.state !== 'prep' || t.prepared) return undefined;
  const fresh = (k: 'read' | 'kit') => typeof t.prep[k] === 'number' && s.now - t.prep[k]! <= PREP_STALE;
  const m = morning(tod), stamped = typeof t.prep.read === 'number' && typeof t.prep.kit === 'number';
  // (the evening: the reads and the kit, then the lifts from 9000; at dawn only the lifts, on the evening's reads, while the trip can still set out)
  if (evening && (tod >= LIFTS_FROM || !(fresh('read') && fresh('kit')))) return `PREP for ${t.site} goes on (done: ${(['read', 'kit', 'lifts'] as const).filter(k => typeof t.prep[k] === 'number').join(', ') || 'nothing yet'})`;
  if (!evening && m < OUT_BY && stamped) return `PREP's lifts for ${t.site} at dawn`;
  return undefined;
}

/**
 * The trip's rows owed now (pure, from the memory alone), each where the records put it: 3 a trip nobody drives (by
 * day; its DOOR at any hour), 6 a ward astray the lead armed a rescue for, 7 a lure outside the fence, 8 RESTORE, 9
 * the lead's word once a game day, 10 PREP.
 */
function tripRows(s: Pick<Snapshot, 'now' | 'timeOfDay' | 'position' | 'home'>, world: WorldMemory, f: FetchMemory, lock: Lock | undefined): Owed[] {
  const rows: Owed[] = [], t = f.trip, now = s.now, tod = s.timeOfDay, day = byDay(tod);
  // 3. resume (3.3): cut before any lure, the record only; DOOR any hour, while its first acts are owed; the rest by day
  if (t && RESUMED.includes(t.state) && !driven(now)) {
    const why = t.cut ? `cut in ${t.state}: ${t.cut.why}` : `in ${t.state} and nobody at it (its last beat ${Math.max(0, Math.round((now - t.beat) / 1000))} s ago)`;
    if (t.state === 'out' || t.state === 'survey') rows.push({ row: 3, want: `trip ${t.id} ${why}: nothing of it out, on to RESTORE`, quiet: true });
    else if (t.state === 'door') { if (lock && doorOwed(f, t, lock)) rows.push({ row: 3, want: `trip ${t.id} ${why}: its DOOR goes on (the ward in the lock)` }); }
    else if (day) rows.push({ row: 3, want: `trip ${t.id} ${why}: resumed from its records` });
  }
  // 6. the armed rescue (4.9): the lead's go (armed, no halt), no trip, by day, the clock open for it, within R-8's two days
  // (not on a yard that is not whole: its lead home would bring the ward into a yard open on one side, R2; row 9 says it)
  const lost = f.wards.find(w => w.where === 'astray' && !w.dim);
  if (!t && lost && armedOk(f) && !f.halt && day && now - lost.last.t < ASTRAY_HOLD && !yardWhy(world)) {
    const c = rescueClock(world, lost, tod);
    if (c?.go === 'on') rows.push({ row: 6, want: `ward ${short(lost.key)} astray at ${fmt(lost.tether ?? lost.last.at)}: the armed rescue (${c.text})` });
  }
  // 7. a lure left outside the fence: by day, with the daylight for the walk out and back and a minute there
  const loose = looseLures(world, f).sort((a, b) => horiz(a.at, s.position) - horiz(b.at, s.position))[0];
  if (loose && day && 2 * horiz(loose.at, s.position) / WALK_BS + THERE_S <= daylightLeft(tod) / 20) {
    rows.push({ row: 7, want: `the ${loose.role === 'pin' ? 'pin' : loose.role === 'anchor' ? 'anchor' : 'lure'} left at ${fmt(loose.at)}${loose.inVillage ? ' in the village' : ''}: fetched` });
  }
  // 8. RESTORE (R-3) from the yard; a trip in PREP put back first
  const back = prepBack(world, f, tod);
  const { todo, held } = restoreOrder(world, now);
  const here = todo.filter(e => restoredHere(world)(e) && !stuckWaits(world, e, now));
  const over = t?.state === 'restore' && !f.journal.some(e => e.trip === t.id && !held.some(h => h.id === e.id));
  if (back) rows.push({ row: 8, want: `trip ${t!.id} in PREP put back: ${back}` });
  else if (here.length) rows.push({ row: 8, want: `${here.length} journal entr${here.length === 1 ? 'y' : 'ies'} to undo (RESTORE)${held.length ? `; ${held.length} held while a villager is out` : ''}` });
  else if (over) rows.push({ row: 8, want: `trip ${t!.id} restored: its record off` });
  // 9. the lead's word, once a game day (the trip's half: S0's records say nothing new)
  if (tripHalf(f) && !askedToday(world, now)) {
    const asks = leadAsks(world, f, now);
    if (asks.length) rows.push({ row: 9, want: `waits on the lead: ${asks[0]}${asks.length > 1 ? ` (and ${asks.length - 1} more)` : ''}` });
  }
  // 10. PREP
  const p = prepWant(s, world, f);
  if (p) rows.push({ row: 10, want: p });
  return rows;
}

/** Every row owed now, in their order (pure). */
function rowsOwed(s: Pick<Snapshot, 'now' | 'timeOfDay' | 'position' | 'home'>, world: WorldMemory, f: FetchMemory, lock: Lock | undefined): Owed[] {
  return [...homeRows(s, world, f, lock), ...tripRows(s, world, f, lock)].sort((a, b) => a.row - b.row);
}

/**
 * What care owes now, and whether it can be done from here (pure: the gate's one answer). Nothing owed: `unneeded`.
 * Owed: only in the overworld and not from inside the hall or the lock (that is `out of the hall`'s first: a walk of
 * care's from in there would go out by the hall's gate). The rows of home (the gates, the lock, RESTORE, PREP) only
 * within 96 of home on its level (PREP from the yard itself); the trip's (a resume, the rescue, a lure outside) from
 * wherever the bot stands. A row that answered "not now" waits its while. The first row that can be done is the one.
 */
export function careOwed(s: Pick<Snapshot, 'now' | 'dimension' | 'position' | 'home' | 'distHome' | 'timeOfDay'>, world: WorldMemory): CareOwed {
  const lock = lockOf(world);
  if (!world.fetch && !lock) return { none: { cause: 'unneeded', text: 'nothing of the villager fetch stands or is owed' } };
  const owed = rowsOwed(s, world, peekFetch(world), lock);
  if (!owed.length) return { none: { cause: 'unneeded', text: 'no gate left open, nothing owed at the lock' } };
  const first = owed[0].want;
  if (s.dimension !== 'overworld') return { none: { cause: 'away', text: `in ${s.dimension} (owed: ${first})` } };
  if (inHallOrLock(world, s.position)) return { none: { cause: 'hold', text: `the bot is in the villager hall or its lock: out of it first (owed: ${first})` } };
  const near = nearHome(s, CARE_NEAR), yardNow = inFence(world, s.position);
  const from = (o: Owed) => !HOME_ROWS.has(o.row) || (near && (o.row !== 10 || yardNow));
  const waits = rowWaits.get(world) ?? {};
  const ready = owed.find(o => from(o) && !((waits[o.row] ?? 0) > s.now));
  if (ready) return ready;
  const here = owed.filter(from);
  if (!here.length) {
    const o = owed[0];
    return { none: { cause: 'away', text: `${!near ? (!s.home ? 'no home set' : `${Math.round(s.distHome)} blocks from home (care works within ${CARE_NEAR}, on home's level)`) : 'PREP is made from the yard'} (owed: ${o.want})` } };
  }
  const until = Math.min(...here.map(o => waits[o.row] ?? 0));
  return { none: { cause: 'hold', text: `${here[0].want}: not done just now, tried again at ${hhmm(until)}`, until } };
}

// ------------------------------------------------------------------------------------------------ row 1: a gate left open

/**
 * Every gate the bridge reports left open (less the hall's gate open by design, and one left alone as stubborn),
 * shut: a careful walk into the click's reach and the bridge's own click, read back (yardgates.ts shutGate: the
 * lock's two gates from the lock's post); the rounds lost to a gate counted (Bounce). Then every ward looked for by
 * its uuid: one not seen on two whole looks is astray, and `halt` stops new trips.
 */
async function shutLeftOpen(ctx: GoalContext): Promise<string> {
  const world = ctx.world, f = fetchOf(world), names = strictGates(world);
  const now = clock(ctx);
  const left = (f.gates?.leftOpen ?? []).filter(g => !openByDesign(world, g) && !leftAlone(world, g, now));
  const said: string[] = [], shut: Pos[] = [];
  const book = bounces.get(world) ?? {};
  bounces.set(world, book);
  let alone = 0;
  for (const g of left) {
    stopped(ctx);
    const name = names.find(n => same(n.at, g))?.name ?? 'a gate';
    const b = (book[gateKey(g)] ??= { n: 0 });
    const lost = () => {
      const t = clock(ctx);
      // (in a row: one lost long ago is no part of this count)
      if (t - (b.lostAt ?? -Infinity) >= STUBBORN_MS) b.n = 0;
      b.n++;
      b.lostAt = t;
      if (b.n >= LOST_ROUNDS) b.until = t + STUBBORN_WAIT;
    };
    // (left open again under a minute after its shut: that round was lost; held longer, a new case, counted afresh)
    if (b.shutAt !== undefined && now - b.shutAt < HELD_MS) lost();
    else if (b.shutAt !== undefined && !stubborn(b, now)) b.n = 0;
    delete b.shutAt;
    if ((b.until ?? 0) > now) { alone++; said.push(`${name} at ${fmt(g)} will not stay shut: left alone till ${hhmm(b.until!)}`); continue; }
    if (await shutGate(ctx, g)) { b.shutAt = clock(ctx); shut.push(g); said.push(`shut ${name} at ${fmt(g)}`); }
    else { lost(); said.push(`${name} at ${fmt(g)} does not read shut`); }
  }
  // (read shut: not owed again before the watch's next read)
  if (f.gates) {
    const off = (l: Pos[]) => l.filter(p => !shut.some(q => same(p, q)));
    f.gates.open = off(f.gates.open);
    f.gates.leftOpen = off(f.gates.leftOpen);
  }
  if (shut.length) ctx.gain(shut.length);
  if (shut.length + alone < left.length) waitRow(ctx, 1);
  said.push(...await wardsAfter(ctx, left));
  return said.join('; ') || 'no gate left open';
}

/**
 * After gates stood open: every ward that could have gone out by one looked for (fetch.ts wardSeen: by its uuid, its
 * record brought up to the look). Led, or in the lock when the lock's own gate was one of them (a ward in the lock is
 * never lowered by absence alone, R-9). One not seen on two whole looks 10 s apart is astray, and `halt` is set: no
 * new trip until the lead has looked. A look that is not whole (just after a rejoin) concludes nothing.
 */
async function wardsAfter(ctx: GoalContext, opened: Pos[]): Promise<string[]> {
  const f = fetchOf(ctx.world), p = lockOf(ctx.world)?.p;
  const pOpen = !!p && opened.some(g => same(g, p));
  const asked = f.wards.filter(w => !w.dim && (w.where === 'led' || (w.where === 'lock' && pOpen)));
  if (!asked.length) return [];
  let missing = asked;
  for (let i = 0; i < 2 && missing.length; i++) {
    if (i) await pause(ctx, CARE_WAITS.gapMs);
    stopped(ctx);
    const seen = await wholeLook(ctx);
    if (!seen) return ['the wards not looked for: no whole look (cells of the hall or the lock not read)'];
    const pShut = p ? (await gateRead(ctx, p)) === false : undefined;
    const sights = wardSeen(ctx.world, seen, true, clock(ctx), { tod: await todRead(ctx), ...(pShut === undefined ? {} : { pShut }) });
    missing = missing.filter(w => fetchOf(ctx.world).wards.includes(w) && !sights.some(x => x.ward === w && x.seen));
  }
  // (wardSeen wrote what the looks saw: where each is, a ward someone took off the wards)
  ctx.save?.();
  if (!missing.length) return [`${asked.length === 1 ? 'the ward' : `all ${asked.length} wards`} seen`];
  const at = opened.map(fmt).join(', ');
  for (const w of missing) {
    w.where = 'astray';
    w.note = `not seen after the gate at ${at} stood open`.slice(0, 120);
  }
  f.halt ??= { at: clock(ctx), why: `a gate stood open at ${at} and ${missing.length === 1 ? `ward ${missing[0].key.slice(0, 8)} was` : `${missing.length} wards were`} not seen on two whole looks after (the lead looks round)` };
  ctx.save?.();
  return [`${missing.length} ward(s) not seen on two whole looks: astray, HALT`];
}

// ------------------------------------------------------------------------------------------------ row 2: the socket, the plug

/**
 * The lock as it must stand between trips: its socket a wall block again (a kill in a trip's DOOR step leaves the cell
 * air: one high, the lock's gate shut, the sill outside, so nothing passes it, but the lock is not whole), put from the
 * post with the lock's gate read shut first; and the build's plug taken up from the hall's doorway once the lock stands
 * and nothing is building (hallshells.ts plugOut: in by the lock's gate, the hall's gate never opened).
 */
async function lockMended(ctx: GoalContext): Promise<string> {
  const world = ctx.world, plan = lockPlanOf(world);
  if (!plan) return 'no lock stands';
  const f = fetchOf(world), said: string[] = [];
  const atLock = (!!f.trip && (f.trip.state === 'lock' || f.trip.state === 'door')) || lockLureIn(f, plan.socket);
  const socket = f.journal.some(e => e.k === 'lift' && e.why === 'socket' && same(e.at, plan.socket)) || !!f.shells?.lock.some(t => SOCKET_OPEN.test(t));
  if (socket && !atLock) said.push(await socketBack(ctx, plan));
  else if (covers(f).length && !f.shells?.building) {
    try {
      const up = await plugOut(ctx, plan);
      if (up) ctx.gain(up);
      said.push(`took up the plug left in the hall's doorway (${up} dirt)`);
    } catch (e) {
      stopped(ctx);
      waitRow(ctx, 2);
      said.push(`the plug stays in for now: ${(e as Error).message}`);
    }
  }
  return said.join('; ') || 'nothing owed at the lock';
}

async function socketBack(ctx: GoalContext, plan: LockPlan): Promise<string> {
  const world = ctx.world, f = fetchOf(world);
  const done = () => {
    for (const e of f.journal.filter(x => x.k === 'lift' && x.why === 'socket' && same(x.at, plan.socket))) dropEntry(ctx, e);
    if (f.shells) f.shells.lock = f.shells.lock.filter(t => !SOCKET_OPEN.test(t));
    ctx.save?.();
  };
  const st = await stateAt(ctx, plan.socket);
  if (st === undefined) { waitRow(ctx, 2); return `the socket at ${fmt(plan.socket)} could not be read`; }
  const name = idOf(st);
  if (/_planks$/.test(name)) { done(); return `the socket's wall block stands at ${fmt(plan.socket)}`; }
  if (!/^(air|cave_air|void_air)$/.test(name)) {
    // (something else in the cell: a lure of a trip's, or a block of someone's; the last read's word was stale)
    if (f.shells) f.shells.lock = f.shells.lock.filter(t => !SOCKET_OPEN.test(t));
    waitRow(ctx, 2);
    return `the socket at ${fmt(plan.socket)} holds ${name}: left as it is`;
  }
  // the lock's gate read shut first (with it shut the hole is one high and the sill outside: nothing passes it)
  if (await gateRead(ctx, plan.p) !== false && !(await shutGate(ctx, plan.p))) { waitRow(ctx, 2); return `the lock's gate at ${fmt(plan.p)} does not read shut: the socket waits`; }
  if (!ctx.own) { waitRow(ctx, 2); return 'this runtime puts down no blocks of its own (own.put): the socket stays open'; }
  // in the wood of the wall over it (a birch lock is mended in birch)
  const over = idOf(await stateAt(ctx, { ...plan.socket, y: plan.socket.y + 1 }));
  const item = /_planks$/.test(over) ? over : 'oak_planks';
  const inv = await ctx.call<{ items?: { name: string; count: number; slot: number }[] }>('inventory').catch(() => undefined);
  if (!inv?.items?.some(i => i.name === item && i.slot < 36)) {
    const short = await prepareBill(ctx, { [item]: 1 }, { record: false });
    stopped(ctx);
    if (Object.keys(short).length) { waitRow(ctx, 2); return `no ${item} to put back in the lock's socket`; }
  }
  if (!(await walkTo(ctx, plan.post))) { waitRow(ctx, 2); return `no way on foot to the lock's post at ${fmt(plan.post)}`; }
  stopped(ctx);
  const r = await ctx.own.put(plan.socket, item, { stay: true });
  if (!r.placed) { waitRow(ctx, 2); return `the socket's wall block did not go back at ${fmt(plan.socket)}: ${r.reason ?? 'not placed'}`; }
  done();
  ctx.gain(1);
  return `put the lock's wall block back in the socket at ${fmt(plan.socket)} (${r.block ?? item})`;
}

// ------------------------------------------------------------------------------------------------ rows 4 and 5: the hall's gate

/**
 * A villager shut in the lock (a resident that followed the bot out and was shut in by the bridge's guard, a ward
 * after a kill): from the post, the lock's gate read shut, the hall's gate opened for it (the journal first, so the
 * gate watch and row 1 leave it open): it has its bed and its block in reach and goes back in when it will. Never
 * the lock's own gate: that one is never opened onto a villager.
 */
async function letBackIn(ctx: GoalContext): Promise<string> {
  const world = ctx.world, lock = lockOf(world);
  if (!lock) return 'no lock stands';
  if (!(await walkTo(ctx, lock.post))) { waitRow(ctx, 4); return `no way on foot to the lock's post at ${fmt(lock.post)}`; }
  stopped(ctx);
  const look = await lookInto(ctx, lock);
  if (!look) { waitRow(ctx, 4); return 'could not look into the lock'; }
  if (!look.villagers) return 'nobody in the lock now';
  if (await gateRead(ctx, lock.p) !== false && !(await shutGate(ctx, lock.p))) { waitRow(ctx, 4); return `the lock's gate at ${fmt(lock.p)} does not read shut: the hall's is not opened`; }
  const h = await gateRead(ctx, lock.h);
  if (h === undefined) { waitRow(ctx, 4); return `the hall's gate at ${fmt(lock.h)} could not be read`; }
  if (!hallEntries(fetchOf(world), lock.h).length) journal(ctx, { k: 'gate', trip: 0, at: { ...lock.h }, which: 'hall', t: clock(ctx) });
  if (!h) {
    if (!(await openGate(ctx, lock.h).catch(() => false))) { waitRow(ctx, 4); return `the hall's gate at ${fmt(lock.h)} would not open from the post`; }
    ctx.gain(1);
  }
  const g = fetchOf(world).gates;
  if (g && !g.open.some(p => same(p, lock.h))) g.open.push({ ...lock.h });
  return `${look.villagers === 1 ? 'a villager' : `${look.villagers} villagers`} shut in the lock: ${h ? 'the hall\'s gate stands open for it' : 'opened the hall\'s gate for it from the post'} (the lock's gate shut): it goes back in when it will`;
}

/**
 * The hall's gate open by design behind the lock's shut one (row 4's, a trip's DOOR), and nobody left in the lock on
 * two looks 10 s apart: shut from the post, its journal entry dropped; the hall counted, and a ward now in the hall is
 * home and leaves the wards. One found shut already: only the entry goes.
 */
async function shutBehind(ctx: GoalContext): Promise<string> {
  const world = ctx.world, lock = lockOf(world);
  if (!lock) return 'no lock stands';
  const f = fetchOf(world), entries = hallEntries(f, lock.h);
  const off = () => {
    for (const e of entries) dropEntry(ctx, e);
    if (f.gates) f.gates.open = f.gates.open.filter(p => !same(p, lock.h)), f.gates.leftOpen = f.gates.leftOpen.filter(p => !same(p, lock.h));
  };
  const h = await gateRead(ctx, lock.h);
  if (h === undefined) { waitRow(ctx, 5); return `the hall's gate at ${fmt(lock.h)} could not be read`; }
  if (!h) { off(); return 'the hall\'s gate reads shut: its journal entry dropped'; }
  if (!(await walkTo(ctx, lock.post))) { waitRow(ctx, 5); return `no way on foot to the lock's post at ${fmt(lock.post)}`; }
  for (let i = 0; i < 2; i++) {
    if (i) await pause(ctx, CARE_WAITS.gapMs);
    stopped(ctx);
    const look = await lookInto(ctx, lock);
    if (!look) { waitRow(ctx, 5); return 'could not look into the lock'; }
    if (look.villagers) return `waiting: ${look.villagers === 1 ? 'a villager' : `${look.villagers} villagers`} in the lock, the hall's gate open for it behind the lock's shut one`;
  }
  if (!(await shutGate(ctx, lock.h))) { waitRow(ctx, 5); return `the hall's gate at ${fmt(lock.h)} does not read shut`; }
  off();
  ctx.gain(1);
  const said = ['nobody left in the lock: shut the hall\'s gate from the post'];
  // the count (a whole look only), and a ward that went in is home
  const seen = await wholeLook(ctx);
  if (seen) {
    const n = noteHall(world, seen, clock(ctx), true, todNow(ctx));
    if (n !== undefined) said.push(`${n} in the hall`);
    const home = f.wards.filter(w => w.where === 'lock' && seen.some(e => !!e.uuid && (e.uuid === w.uuid || e.uuid === w.key) && !!e.position && inHallBox(world, e.position)));
    if (home.length) {
      f.wards = f.wards.filter(w => !home.includes(w));
      ctx.save?.();
      said.push(`${home.length} ward(s) in the hall: home`);
    }
  }
  // (a trip whose DOOR this was, its ward now the hall's: done, on to RESTORE, the village's count of moves up)
  const t = f.trip;
  if (t?.state === 'door' && !f.wards.some(w => w.key === t.ward)) {
    const site = siteOf(world, t.site);
    if (site) site.moved = (site.moved ?? 0) + 1;
    endTrip(ctx, `in the hall: ward ${short(t.ward ?? '?')} from ${t.site} (its DOOR shut by care)`, 1, clock(ctx));
    said.push(`trip ${t.id} in the hall: on to RESTORE`);
  }
  return said.join('; ');
}

/** A trip's village among the remembered ones, the live record (a write's: its count of moves), by the `x,z` its variant ends in. */
function siteOf(world: WorldMemory, name: string) {
  const m = /(-?\d+),\s*(-?\d+)\s*$/.exec(name);
  return m ? villagesOf(world).sites.find(x => x.x === Number(m[1]) && x.z === Number(m[2])) : undefined;
}

// ------------------------------------------------------------------------------------------------ row 3: a trip resumed

/** A look at who is about (world.entities, 128), the wards brought up to it (fetch.ts wardSeen: a write; saved). */
async function lookWards(ctx: GoalContext, lock?: Lock): Promise<{ rows: Seen[]; sight: (w: Ward) => Seen | undefined } | undefined> {
  const e = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 128 }).catch(() => undefined);
  if (!Array.isArray(e?.entities)) return undefined;
  const pShut = lock ? (await gateRead(ctx, lock.p)) === false : undefined;
  const sights = wardSeen(ctx.world, e.entities, false, clock(ctx), { tod: await todRead(ctx), ...(pShut === undefined ? {} : { pShut }) });
  ctx.save?.();
  return { rows: e.entities, sight: w => sights.find(x => x.ward === w)?.seen };
}

/**
 * What a lead came to, said for care's log: the world changed (a lure down or up, a gate held) counts as care's gain.
 * The bot home after it where it ended outside the fence (a release, a stop: the rung's wrapper walks home the same).
 */
async function ledTo(ctx: GoalContext, r: LeadEnd, what: string): Promise<string> {
  if (r.placed || r.end === 'hall' || r.end === 'lock') ctx.gain(1);
  const said: string[] = [];
  await homeAgain(ctx, said);
  return `${what}: ${r.end === 'none' ? r.text : `${r.end}: ${r.text}`}${said.length ? `; ${said.join('; ')}` : ''}`;
}

/**
 * Row 3, a trip resumed from its records (3.3), from wherever the bot stands. First the records made true: an entry
 * left `planned` or `unsure` by a kill read at its cell (fetch.ts reconcile), the trip's held gates read shut and let
 * go, every strict gate read shut (but the hall's, open by design). Then by state: cut before any lure (`out`,
 * `survey`), on to RESTORE (a new trip is tomorrow's); `first`, the first lure's worker made the ward or the lure taken
 * up with it by (as found); `gate`, the ward inside the fence on to the yard's hops, outside to the hops home; `lock`,
 * the ward in the lock's box with its gate shut on to DOOR, else LOCK from its step 3 (lockIn: the socket's lure as
 * it stands, P held and opened); `door`, the socket's wall block first. A ward a kill left `led` and not seen here is
 * looked for where it was (leadOn: by its uuid within 64 of its lure), and the lead goes on (lure.ts leadOn: the clock
 * first at every hop: on, RELEASE or STOP). With the moves switched off a trip not yet committed is let go (2.2), one
 * committed is led on: finishing is what protects it.
 */
async function resume(ctx: GoalContext): Promise<string> {
  const world = ctx.world, f = fetchOf(world), t = f.trip, clk = careClock(ctx);
  if (!t || !RESUMED.includes(t.state)) return 'no trip to resume';
  if (t.state === 'out' || t.state === 'survey') {
    tripTo(ctx, 'restore', clk.now());
    return `trip ${t.id} cut in ${t.state} before any lure (${t.cut?.why ?? 'nobody at it'}): on to RESTORE, a new trip is tomorrow's`;
  }
  const lock = lockOf(world), said: string[] = [];
  for (const e of f.journal.filter(x => x.trip === t.id && (x.k === 'lure' || x.k === 'lift') && (x.st === 'planned' || x.st === 'unsure'))) {
    stopped(ctx);
    const r = await reconcile(ctx, e);
    if (r) said.push(`${e.k} at ${fmt(e.at)} ${r === 'gone' ? 'not there: off the journal' : `read ${r}`}`);
  }
  for (const e of fetchOf(world).journal.filter(x => x.trip === t.id && x.k === 'gate' && x.which !== 'hall')) {
    const r = await undo(ctx, e, { now: clk.now });
    if (r.ok) said.push(r.text);
  }
  for (const g of await gatesRead(ctx, world)) {
    stopped(ctx);
    if (g.open && !openByDesign(world, g.at) && (await shutGate(ctx, g.at))) said.push(`shut ${g.name} at ${fmt(g.at)}`);
  }
  const before = said.length ? ` (${said.join('; ')})` : '';
  if (t.state === 'first') return `${await firstAgain(ctx, clk, t)}${before}`;
  const w = t.ward ? fetchOf(world).wards.find(x => x.key === t.ward) : undefined;
  if (!w) {
    endTrip(ctx, `trip ${t.id} resumed in ${t.state} with no ward on the records`, 0, clk.now());
    return `trip ${t.id} in ${t.state} has no ward: on to RESTORE${before}`;
  }
  if (t.state === 'door') {
    // (a kill in DOOR's first act left the socket's cell air: one high, the lock's gate shut, the sill outside; its wall block back first)
    for (const e of fetchOf(world).journal.filter(x => x.k === 'lift' && x.why === 'socket' && !fetchOf(world).journal.some(y => y.k === 'lure' && y.role === 'lock' && same(y.at, x.at)))) {
      const r = await undo(ctx, e, { now: clk.now });
      said.push(r.text);
    }
  } else {
    const look = await lookWards(ctx, lock);
    const seen = look?.sight(w);
    if (seen?.position) {
      if (t.state === 'gate') tripTo(ctx, inFence(world, seen.position) ? 'yardhop' : 'hop', clk.now());
      // (in the lock with P shut: contained, on to DOOR; outside, LOCK goes on from its step 3, the socket's lure as it stands)
      else if (t.state === 'lock' && lock && inLock(lock, cellOf(seen.position)) && (await gateRead(ctx, lock.p)) === false) { w.where = 'lock'; delete w.tether; tripTo(ctx, 'door', clk.now()); }
    } else if (w.where === 'led' && look) {
      // (not in sight from here: looked for where the lead left it, by its uuid)
      const L = standingOf(fetchOf(world), t);
      w.where = 'astray';
      if (L) w.tether = { ...L.at };
      w.note = `not in sight at the resume of trip ${t.id}: looked for by its uuid`.slice(0, 120);
      ctx.save?.();
    }
    if (fetchOf(world).trip?.state === 'hop' && world.villagerMoves !== true && !t.committed) return `${await letGo(ctx, clk, t, w, 'villager moves switched off')}${before}`;
  }
  const r = await leadOn(ctx, clk);
  return await ledTo(ctx, r, `resumed trip ${t.id}${before}`);
}

/**
 * RELEASE from care (2.2: not committed, and the moves switched off): the trip's standing lure taken up (a careful walk
 * into reach; its worker within 16 of it is jobless at once, as found), the ward off the record, the trip on to
 * RESTORE. Not committed, it stands within 96 of its village on ground it walks back.
 */
async function letGo(ctx: GoalContext, clk: LureClock, t: Trip, w: Ward, why: string): Promise<string> {
  const f = fetchOf(ctx.world), L = standingOf(f, t), said: string[] = [];
  if (L) {
    const look = await lookWards(ctx);
    const by = look?.sight(w)?.position;
    if (by && horiz(by, mid(L.at)) > NOTICE_R) said.push(`its ward ${Math.round(horiz(by, mid(L.at)))} off it`);
    const r = await undo(ctx, L, { now: clk.now });
    said.push(r.text);
    if (r.ok) ctx.gain(1);
  }
  const fm = fetchOf(ctx.world);
  fm.wards = fm.wards.filter(x => x.key !== w.key);
  const text = `released at ${fmt(w.last.at)}: ${why} (trip ${t.id} not committed)`;
  endTrip(ctx, text, 0, clk.now());
  // (the bot home: the restore of the rest is from the yard)
  await homeAgain(ctx, said);
  return `${text}${said.length ? `; ${said.join('; ')}` : ''}`;
}

/**
 * Out to a cell beyond the fence for care (a lure left out, a resume, the rescue): by the yard's gate that way from
 * inside it, then careful legs of 32 (no walk of care's breaks or places a block, a villager about or not: the shared
 * world's villages too). Whether it got there.
 */
async function walkOutTo(ctx: GoalContext, to: Pos, range = 6): Promise<boolean> {
  if (inFence(ctx.world, await here(ctx)) && !inFence(ctx.world, to)) await outByGate(ctx, to);
  const from = await here(ctx), legs = Math.max(1, Math.ceil(horiz(from, to) / LEG));
  for (let k = 1; k <= legs && horiz(await here(ctx), to) > range; k++) {
    stopped(ctx);
    const last = k === legs, p = { x: Math.round(from.x + (to.x - from.x) * k / legs), y: to.y, z: Math.round(from.z + (to.z - from.z) * k / legs) };
    await walkTo(ctx, last ? cellOf(to) : p, last ? range : 6, !last);
  }
  stopped(ctx);
  return horiz(await here(ctx), to) <= range + 2;
}

/** Back into the yard by a gate (yardgates.ts inByGate) after a walk out of care's: what stopped it is said. */
async function homeAgain(ctx: GoalContext, said: string[]): Promise<void> {
  if (inFence(ctx.world, await here(ctx))) return;
  const back = await inByGate(ctx, 4 * MINUTE).catch((e: Error) => { stopped(ctx); return { shut: e.message }; });
  if (back.shut) said.push(back.shut);
}

/**
 * The first lure resumed (3.3 `first`): out to it (a careful walk), a look. A fletcher working at it (within 9, the one
 * the lure took, an adult no one has: lure.ts's `acceptable`) with the clock open for the way home, and the moves on:
 * it is the ward, led on from the hops. Else the lure taken up with its worker by it (jobless again, as found) and the
 * trip on to RESTORE.
 */
async function firstAgain(ctx: GoalContext, clk: LureClock, t: Trip): Promise<string> {
  const world = ctx.world, f = fetchOf(world);
  const L0 = [...f.journal].reverse().find((e): e is LureEntry => e.k === 'lure' && e.trip === t.id && e.role === 'village' && e.st !== 'planned');
  if (!L0) {
    endTrip(ctx, `trip ${t.id} cut at its first lure, none standing`, 0, clk.now());
    return `trip ${t.id} cut at its first lure, none standing: on to RESTORE`;
  }
  if (horiz(await here(ctx), L0.at) > 24) await walkOutTo(ctx, L0.at);
  const look = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64 }).catch(() => undefined);
  const rows = look?.entities ?? [];
  const worker = rows.filter(e => e.name === 'villager' && e.profession === GIVES && !!e.position && horiz(e.position, mid(L0.at)) <= WORKS_AT && !e.baby && !usedHow(e)
    && !inHallBox(world, e.position) && !f.wards.some(w => w.uuid === e.uuid)).sort((a, b) => horiz(a.position!, mid(L0.at)) - horiz(b.position!, mid(L0.at)))[0];
  const tod = await todRead(ctx);
  const c = tripClock(tod, needLeft(STRETCH * horiz(L0.at, t.gate.outer), t.gate.yard), { bell: true }, t);
  if (worker && c.go === 'on' && world.villagerMoves === true && f.method === 'lure') {
    const at = { ...worker.position! }, now = clk.now(), health = typeof worker.health === 'number' ? worker.health : 20;
    const w: Ward = {
      key: worker.uuid ?? `at:${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}@${now}`, ...(worker.uuid ? { uuid: worker.uuid } : {}), id: worker.id,
      from: { site: t.site, at }, since: now, bell: true, where: 'led', last: { at, t: now, tod, health, profession: GIVES }, health0: health
    };
    f.wards.push(w);
    t.ward = w.key;
    t.hop = { n: 0, lure: { ...L0.at }, placedAt: now, replaced: 0 };
    afield.ledBy = ctx.signal;
    tripTo(ctx, 'hop', now);
    const r = await leadOn(ctx, clk);
    return await ledTo(ctx, r, `trip ${t.id} resumed at its first lure: ward ${short(w.key)} working at it at ${fmt(L0.at)}`);
  }
  const why = !worker ? 'nobody working at it' : c.go !== 'on' ? `the clock: ${c.text}` : 'villager moves switched off';
  const r = await undo(ctx, L0, { now: clk.now });
  if (r.ok) ctx.gain(1);
  endTrip(ctx, `trip ${t.id} cut at its first lure: ${why}`, 0, clk.now());
  const said = [r.text, 'on to RESTORE'];
  await homeAgain(ctx, said);
  return `trip ${t.id} resumed at its first lure (${why}): ${said.join('; ')}`;
}

// ------------------------------------------------------------------------------------------------ row 6: the armed rescue

/**
 * Row 6, the armed rescue (4.9; the lead's `villager-moves {halt:false, arm:1}`): out to where the ward was left (its
 * tether, else where it was last seen: a careful walk), a look for it by its uuid within 64. Not seen: astray still,
 * and halt again. Someone's now: off the wards (wardSeen). Inside its own village's area: home, off the wards. In a pit
 * or behind a rise on every side (no step out by the game's rules): said ("needs steps cut"), halt, nothing dug (the
 * lead in S1). Else a trip of kind `rescue` from it, at the hops home (the yard's hops inside the fence) by the yard gate
 * nearest it, armed one less, and the lead (lure.ts leadOn) as for any trip. Its lifts are as journaled: within R-8's
 * two days they were held for it. Its lures first: a STOP's RESTORE stashed the kit (the stash keeps it only while a
 * trip stands), so the four are carried or made, else the rescue waits and the arm is kept. A ward in the yard, or
 * beyond 96 of its village, is led in committed from the start: 4.9 lets one go only within 96 of its village, and a
 * rescue that found no spot, or a player by it, must never let it go by the bot's home. A ward that works at its
 * tether (the pin of the trip that made it a second ward) is led on from that lure, this trip's now.
 */
async function rescue(ctx: GoalContext): Promise<string> {
  const world = ctx.world, f = fetchOf(world), clk = careClock(ctx);
  const w = f.wards.find(x => x.where === 'astray' && !x.dim);
  if (!w || f.trip) return f.trip ? `trip ${f.trip.id} is ${f.trip.state}: no rescue now` : 'no ward astray';
  const way0 = rescueWay(world, w);
  if (!way0) return 'no lock or no yard gate: no rescue';
  if (await carriedOf(ctx, LURE) < LURES) {
    await prepare(ctx, LURE, LURES).catch(() => undefined);
    stopped(ctx);
    const n = await carriedOf(ctx, LURE);
    if (n < LURES) {
      waitRow(ctx, 6, PREP_RETRY);
      return `the rescue of ward ${short(w.key)} waits: ${n} of ${LURES} ${LURE} carried, and none made (4 planks + 2 flint each)`;
    }
  }
  const near = way0.at;
  if (horiz(await here(ctx), near) > 24) await walkOutTo(ctx, near);
  const look = await lookWards(ctx, lockOf(world));
  const seen = look?.sight(w);
  if (!fetchOf(world).wards.includes(w)) return `ward ${short(w.key)}: taken by someone (theirs, never contested)`;
  if (!seen?.position) {
    f.halt ??= { at: clk.now(), why: `the rescue: ward ${short(w.key)} not found within 64 of ${fmt(near)} (the lead looks round)` };
    ctx.save?.();
    return `the rescue: ward ${short(w.key)} not found within 64 of ${fmt(near)}: astray still, HALT`;
  }
  const at = seen.position, site = siteOf(world, w.from.site);
  if (site?.area && at.x >= site.area.x1 && at.x <= site.area.x2 && at.z >= site.area.z1 && at.z <= site.area.z2) {
    f.wards = f.wards.filter(x => x !== w);
    ctx.save?.();
    return `the rescue: ward ${short(w.key)} is in its village's area at ${fmt(at)}: home, off the wards`;
  }
  // (a pit, or a rise on every side: no step out of its cell by the game's own rules)
  const c = cellOf(at), g = new Ground(c.y - 4, 10);
  await g.read(ctx, c.x - 2, c.z - 2, c.x + 2, c.z + 2);
  const ways = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => step(g, c, dx, dz, 'game'));
  if (ways.every(x => !isStand(x) && x.why === 'rise')) {
    f.halt ??= { at: clk.now(), why: `the rescue: ward ${short(w.key)} in a pit at ${fmt(c)}: needs steps cut (the lead)` };
    w.note = `in a pit at ${fmt(c)}: needs steps cut`;
    ctx.save?.();
    return `the rescue: ward ${short(w.key)} at ${fmt(c)} needs steps cut at ${fmt(c)} (a rise on every side): said, nothing dug, HALT`;
  }
  const way = rescueWay(world, { ...w, tether: { ...at } })!;
  if (typeof f.armed === 'number') f.armed = Math.max(0, f.armed - 1);
  const t = newTrip(ctx, { site: w.from.site, gate: way.gate, spare: way.spare, state: way.inside ? 'yardhop' : 'hop', ward: w.key }, clk.now());
  t.path = { toGate: Math.round(way.toGate), yard: way.yard };
  const village = site ? { x: site.x, z: site.z } : w.from.at;
  if (way.inside || horiz(at, village) > RELEASE_R) t.committed = 'far';
  const tie = w.tether ? f.journal.find((e): e is LureEntry => e.k === 'lure' && same(e.at, w.tether!)) : undefined;
  if (tie && tie.trip !== t.id) { tie.trip = t.id; tie.role = way.inside ? 'yard' : 'hop'; }
  ctx.save?.();
  const r = await leadOn(ctx, clk);
  return await ledTo(ctx, r, `the rescue of ward ${short(w.key)} from ${fmt(at)} (trip ${t.id}, by the ${way.gate.side} gate)`);
}

// ------------------------------------------------------------------------------------------------ row 7: a lure left outside

/**
 * Row 7, a lure of the bot's left outside the fence that no trip under way owns (F-18): a village's lure, a pin, an
 * anchor of a cut. By day, moves on or off, dry or not (a lure standing in a village for a day is what the journal is
 * for): out of the yard by the gate that way, careful legs out to it, the undo (fetch.ts: a careful walk into reach and
 * own.take, which digs only the bot's own; its worker within 16 is jobless at once, as found), the next nearest, home.
 * An entry in a village failing three times sets halt and is never dropped for it (R-4).
 */
async function fetchOut(ctx: GoalContext): Promise<string> {
  const world = ctx.world, clk = careClock(ctx), said: string[] = [];
  let n = 0;
  for (let i = 0; i < 4; i++) {
    stopped(ctx);
    const me = await here(ctx), tod = await todRead(ctx);
    const e = looseLures(world, fetchOf(world)).sort((a, b) => horiz(a.at, me) - horiz(b.at, me))[0];
    if (!e) break;
    if (2 * horiz(e.at, me) / WALK_BS + THERE_S > daylightLeft(tod) / 20) { said.push(`the lure at ${fmt(e.at)}: not enough daylight to fetch it`); break; }
    await walkOutTo(ctx, e.at, 4);
    // (its worker: a pin's villager works at it; taken up with it by, it is jobless again within reach of its village)
    const look = await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 32 }).catch(() => undefined);
    const by = (look?.entities ?? []).filter(x => x.name === 'villager' && x.profession === GIVES && x.position).sort((a, b) => horiz(a.position!, mid(e.at)) - horiz(b.position!, mid(e.at)))[0];
    const r = await undo(ctx, e, { now: clk.now });
    if (r.ok) { n++; ctx.gain(1); }
    said.push(`${r.text}${by?.position && horiz(by.position, mid(e.at)) > NOTICE_R ? ` (its worker ${Math.round(horiz(by.position, mid(e.at)))} off)` : ''}`);
    // (not taken up: out of reach, a read that did not come; a walk out every half minute would be the day's)
    if (!r.ok) { waitRow(ctx, 7, FETCH_RETRY); break; }
  }
  await homeAgain(ctx, said);
  return `fetched ${n} lure(s) left outside the fence${said.length ? `: ${said.join('; ')}` : ''}`;
}

// ------------------------------------------------------------------------------------------------ row 8: RESTORE

/**
 * Row 8, RESTORE from the yard (R-3; fetch.ts restoreAll): a trip in PREP that is no longer to set out (prepared and
 * not out by 2000; the moves off, the method changed, halt) on to RESTORE first; then every entry in the order, the
 * lifts last and only while no villager is out; the lures outside the fence are row 7's. A trip in RESTORE with
 * nothing of it left is deleted. An entry whose undo fails is said and kept; after three it is tried once a game day.
 */
async function restoreHome(ctx: GoalContext): Promise<string> {
  const world = ctx.world, f = fetchOf(world), clk = careClock(ctx), said: string[] = [];
  const back = prepBack(world, f, await todRead(ctx));
  if (back && f.trip) { said.push(`trip ${f.trip.id} in PREP put back: ${back}`); tripTo(ctx, 'restore', clk.now()); }
  const tried = stuckTried.get(world) ?? new Map<number, number>();
  stuckTried.set(world, tried);
  const r = await restoreAll(ctx, { now: clk.now, which: e => restoredHere(world)(e) && !stuckWaits(world, e, clk.now()) });
  for (const e of fetchOf(world).journal.filter(x => (x.tries ?? 0) >= 3)) if (!tried.has(e.id) || !stuckWaits(world, e, clk.now())) tried.set(e.id, clk.now());
  if (r.undone) ctx.gain(r.undone);
  if (r.failed.length) waitRow(ctx, 8);
  return [...said, r.text].join('; ');
}

// ------------------------------------------------------------------------------------------------ rows 9 and 10

/** Row 9, what waits on the lead (an animal in the lock, H open a game day, a ward astray, PREP declined 3 days, stuck entries): one log line, once a game day; nothing done. */
async function askLead(ctx: GoalContext): Promise<string> {
  const asks = leadAsks(ctx.world, peekFetch(ctx.world), clock(ctx));
  askedOn.set(ctx.world, { day: gameDay(ctx.world), at: clock(ctx) });
  const text = asks.length ? `waits on the lead: ${asks.join('; ')}` : 'nothing waits on the lead';
  ctx.progress(`villagers: ${text}`);
  return text;
}

/**
 * Row 10, PREP for tomorrow's trip (4.1; lure.ts prep): from the yard, its parts in their hours, going on from the stamps
 * of a cut one (its dawn lifts too). What it changed (a lift, a stray, a craft) is care's gain. One that did not
 * prepare (declined: counted in fetch.why.prep, which lets the far rungs go for the day; or the dawn's lifts too late
 * for the start) is not asked again for two minutes.
 */
async function prepNow(ctx: GoalContext): Promise<string> {
  const r = await prep(ctx, careClock(ctx));
  if (r.acted) ctx.gain(1);
  // (the evening's reads and kit done before 9000: the gate itself waits for the lifts' hour)
  const tod = await todRead(ctx);
  if (!r.ok || (!r.prepared && !(tod >= PREP_FROM && tod < LIFTS_FROM))) waitRow(ctx, 10, PREP_RETRY);
  return r.text;
}

// ------------------------------------------------------------------------------------------------ the goals

const gate = (s: Snapshot, world: WorldMemory): Gate => {
  const o = careOwed(s, world);
  return 'none' in o ? o.none : { want: o.want };
};

/**
 * Care: priority 62 (over `close up` 61 and the stash 60); while a row is owed, 75 for rows 1-5 (under the food goal's
 * 76 and the shelter's 80, over the kit's 70 and every chore), 62 for 6-8, 35 for 9 and 10 (PREP is a chore among
 * chores: work.ts's stay-in keeps its turn). Rows 1, 3 and 4 stop what runs (an open gate, a villager left on a lure
 * with nobody at it, one shut out are now); the rest wait for it to end. It starts from wherever the bot stands,
 * needs no room and no switch, and is tried again 5 s after a run, a minute after three failures (never left until
 * the morning); a row's ordinary failure is its returned text, never a throw.
 */
export const villagerCareGoal: Goal = {
  name: 'villager care',
  priority: 62,
  urgency: (s, world) => { const o = careOwed(s, world); return 'row' in o ? urgencyOf(o.row) : 62; },
  timeoutMs: 10 * MINUTE,
  retryMs: 5_000,
  failHoldMs: MINUTE,
  gate,
  ...fromGate(gate),
  cuts: (s, world) => { const o = careOwed(s, world); return 'row' in o && !o.quiet && (o.row === 1 || o.row === 3 || o.row === 4); },
  run: async ctx => {
    began.set(ctx, Date.now());
    const o = careOwed(ctx.s, ctx.world);
    if ('none' in o) return o.none.text;
    switch (o.row) {
      case 1: return shutLeftOpen(ctx);
      case 2: return lockMended(ctx);
      case 3: return resume(ctx);
      case 4: return letBackIn(ctx);
      case 5: return shutBehind(ctx);
      case 6: return rescue(ctx);
      case 7: return fetchOut(ctx);
      case 8: return restoreHome(ctx);
      case 9: return askLead(ctx);
      case 10: return prepNow(ctx);
    }
  }
};

/** When `out of the hall` last found its way out shut (real ms), per world. */
const outWaits = new WeakMap<WorldMemory, number>();

/**
 * Whether the bot is in the villager hall or its lock with no chores visit under way: a live critical section of the
 * hall's kind (the chores' whole stay, the shells' plug coming up) is somebody's visit, left be. Only in the overworld.
 */
export function outOfHallWants(s: Pick<Snapshot, 'now' | 'dimension' | 'position'>, world: WorldMemory): string | null {
  if (s.dimension !== 'overworld' || !inHallOrLock(world, s.position)) return null;
  if (liveCritical(s.now)?.why === 'hall') return null;
  return lockOf(world) ? 'the bot is in the villager hall or its lock with no chores visit under way: out through the lock'
    : 'the bot is in the villager hall with no chores visit under way: out by its gate, shut behind';
}

/**
 * Out of the hall: the bot found inside the villager hall or its lock with no chores visit under way (a visit cut
 * short by flight, a restart with the bot inside, a person's walk in) is taken out the way the chores go, through the
 * lock (hallchores.ts throughLock: the two gates never open together, the lock's never onto a villager); with no lock
 * yet, by the hall's own gate, shut behind and read shut. A survival goal (brain.ts SURVIVAL: nothing but flight comes
 * before it, no loop hold): the next goal's plain walk out through the gate is how a villager leaves with the bot.
 * A way out it finds shut (a villager in the lock, the hall's gate opened for it to go back) is a plain answer, and the
 * next run waits 20 s before it asks again: the bot stays in there meanwhile, and nothing else walks it out.
 */
export const outOfHallGoal: Goal = {
  name: 'out of the hall',
  priority: 84,
  timeoutMs: 5 * MINUTE,
  retryMs: 20_000,
  failHoldMs: 2 * MINUTE,
  wants: outOfHallWants,
  run: async ctx => {
    began.set(ctx, Date.now());
    const left = (outWaits.get(ctx.world) ?? -Infinity) + CARE_WAITS.outMs - clock(ctx);
    if (left > 0) { await pause(ctx, left); stopped(ctx); }
    const r = await throughLock(ctx, 'out');
    if (!r.ok) {
      outWaits.set(ctx.world, clock(ctx));
      return `waiting: ${r.why}`;
    }
    outWaits.delete(ctx.world);
    const here = (await ctx.status().catch(() => undefined))?.position;
    if (here && inHallOrLock(ctx.world, here)) throw new Error(`still in the villager hall at ${fmt(here)}: no way out on foot`);
    return `out of the villager hall ${lockOf(ctx.world) ? 'through the lock' : 'by its gate'}${r.said ?? ''}`;
  }
};
