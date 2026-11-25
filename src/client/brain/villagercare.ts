import { fromGate, nearHome, type Decline, type Gate, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { dropEntry, fetchOf, inHallOrLock, journal, openByDesign, peekFetch, type Change, type FetchMemory } from './fetch.js';
import { liveCritical } from './pockets.js';
import { gateRead, openGate, shutGate, strictGates } from './yardgates.js';
import { inLock, lockOf, lockPlanOf, type Lock, type LockPlan } from './villagerwalk.js';
import { inHallBox, noteHall, throughLock } from './hallchores.js';
import { plugOut } from './hallshells.js';
import { prepareBill } from './project.js';
import { clock as hhmm } from './idlelog.js';
import type { Seen as Looked } from './village.js';

/**
 * What the villager fetch has left in the world, brought back to the state it should stand in (idle-plan V, 6.1): the
 * care goal, and the goal that takes the bot out of the villager hall when it is found in there with no chores visit
 * under way. S0's half: care's rows 1, 2, 4 and 5 (a gate left open, the lock's socket and the build's plug, a villager
 * shut in the lock, the hall's gate open behind the lock's shut one); the trip's rows (3, 6-10) come with the lure.
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
 * is not asked again; `outMs`, how long `out of the hall` waits before it tries again a way out it found shut.
 */
export const CARE_WAITS: { gapMs: number; rowMs: number; outMs: number; sleep?: (ms: number) => Promise<void> } = { gapMs: 10_000, rowMs: 30_000, outMs: 20_000 };
/** Whom the lock is kept for (what the bridge's guard counts: a villager, a wandering trader). */
const VILLAGER = /^(villager|wandering_trader)$/;
/** The socket's fault as the lock's read words it (villagerwalk.ts lockFaults) when its cell is air: the wall block is owed. */
const SOCKET_OPEN = /^the socket is no wall block: (air|cave_air|void_air) at /;

/** What a look (world.entities) gives of one entity, as far as care asks (`uuid` on every row from the S0 jar on). */
type Seen = Looked & { health?: number };
type Rows = Pick<GoalContext, 's' | 'world'>;

const fmt = (p: Pos) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const same = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b && Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);
const idOf = (state: string | null | undefined) => (state ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');

/** When each run began (real ms): ctx.s.now is the run's start (as hallchores.ts and hallshells.ts keep it). */
const began = new WeakMap<object, number>();
const clock = (ctx: Pick<GoalContext, 's'>) => ctx.s.now + Math.max(0, Date.now() - (began.get(ctx) ?? Date.now()));
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

const walkTo = async (ctx: Pick<GoalContext, 'call'>, to: Pos, range = 0): Promise<boolean> =>
  (await ctx.call<{ arrived?: boolean }>('goto', { x: to.x, y: to.y, z: to.z, range, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => ({ arrived: false })))?.arrived !== false;

const stateAt = async (ctx: Pick<GoalContext, 'call'>, p: Pos): Promise<string | undefined> =>
  (await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: p.x, y: p.y, z: p.z, width: 1, height: 1, length: 1 }).catch(() => undefined))?.blocks?.[0] ?? undefined;

// ------------------------------------------------------------------------------------------------ the lock as last looked into

/** The last look into the lock, per world (in this process: after a restart the gate watch looks again within half a minute). */
const lockLooks = new WeakMap<WorldMemory, { at: number; villagers: number }>();

/**
 * A look (world.entities) noted for the care goal's gate: how many villagers stand in the lock's six cells, and when.
 * The brain's gate watch looks every half minute while a lock stands; the rows' own looks are noted too. A look from
 * where the lock is out of sight must not be given here: it would say the lock is empty. How many, undefined with no
 * lock or no look.
 */
export function noteLock(world: WorldMemory, seen: readonly Seen[] | undefined, now: number): number | undefined {
  const lock = lockOf(world);
  if (!lock || !Array.isArray(seen)) return undefined;
  const villagers = seen.filter(e => e && VILLAGER.test(e.name) && !!e.position && inLock(lock, e.position)).length;
  lockLooks.set(world, { at: now, villagers });
  return villagers;
}

/** The lock as last looked into (noteLock), or undefined. */
export const lockSeen = (world: WorldMemory): { at: number; villagers: number } | undefined => lockLooks.get(world);

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
 * The rows of S0: 1 a gate left open, 2 the lock's socket or the build's plug, 4 a villager shut in the lock, 5 the
 * hall's gate to shut behind it. `quiet`: row 1 for gates that will not stay shut only (stubborn): it stops no run.
 */
export type CareRow = 1 | 2 | 4 | 5;
export type CareOwed = { row: CareRow; want: string; quiet?: true } | { none: Decline };

/** The rows that answered "not now", per world: not asked again before then (real ms, in this process). */
const rowWaits = new WeakMap<WorldMemory, Partial<Record<CareRow, number>>>();
const waitRow = (ctx: Rows, row: CareRow) => { rowWaits.set(ctx.world, { ...rowWaits.get(ctx.world), [row]: clock(ctx) + CARE_WAITS.rowMs }); };

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

/** brain-status's word on the gates care leaves alone or lets wait (fetch.ts fetchLine's `notes`). */
export function careNotes(world: WorldMemory, now: number): string[] {
  return Object.entries(bounces.get(world) ?? {}).filter(([, b]) => stubborn(b, now)).map(([k, b]) =>
    `the gate at (${k.split(',').join(', ')}) will not stay shut (${b.n} rounds lost to it: under redstone power, or its click refused)${(b.until ?? 0) > now ? `: left alone till ${hhmm(b.until!)}` : ''}, and it stops no run`);
}

type Hall = Extract<Change, { k: 'gate' }>;
const hallEntries = (f: Pick<FetchMemory, 'journal'>, h: Pos): Hall[] => f.journal.filter((e): e is Hall => e.k === 'gate' && e.which === 'hall' && same(e.at, h));
const covers = (f: Pick<FetchMemory, 'journal'>) => f.journal.filter(e => e.k === 'cover' && e.what === 'hall door');

/** Every row owed now, in their order, from the memory alone (pure): the gate watch's last read, the journal, the lock's last read and look. */
function rowsOwed(s: Pick<Snapshot, 'now'>, world: WorldMemory, f: FetchMemory, lock: Lock | undefined): { row: CareRow; want: string; quiet?: true }[] {
  const rows: { row: CareRow; want: string; quiet?: true }[] = [];
  const g = f.gates && s.now - f.gates.at <= GATES_FRESH ? f.gates : undefined;
  // 1. (the bridge's leftOpen: open, nobody holding it, and the bot out of reach of it or it open 5 s: the second or
  // two of a passage is nobody's business; and not the hall's gate opened behind the lock's shut one by design)
  const left = g ? g.leftOpen.filter(p => !openByDesign(world, p) && !leftAlone(world, p, s.now)) : [];
  const quiet = left.every(p => stubborn(bounceOf(world, p), s.now));
  if (left.length) rows.push({ row: 1, want: `a gate left open at ${fmt(left[0])}${left.length > 1 ? ` (and ${left.length - 1} more)` : ''}: shut it${quiet ? ' (it will not stay shut: when the run ends)' : ''}`, ...(quiet ? { quiet: true as const } : {}) });
  if (!lock) return rows;
  // 2. (the socket's wall block, owed whenever no trip is at the lock: a trip's lure in it is the trip's)
  const atLock = !!f.trip && (f.trip.state === 'lock' || f.trip.state === 'door');
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

/**
 * What care owes now, and whether it can be done from here (pure: the gate's one answer). Nothing owed: `unneeded`.
 * Owed: only in the overworld, within 96 of home on its level, and not from inside the hall or the lock (that is
 * `out of the hall`'s first: a walk of care's from in there would go out by the hall's gate); a row that answered
 * "not now" waits its half minute.
 */
export function careOwed(s: Pick<Snapshot, 'now' | 'dimension' | 'position' | 'home' | 'distHome'>, world: WorldMemory): CareOwed {
  const lock = lockOf(world);
  if (!world.fetch && !lock) return { none: { cause: 'unneeded', text: 'nothing of the villager fetch stands or is owed' } };
  const owed = rowsOwed(s, world, peekFetch(world), lock);
  if (!owed.length) return { none: { cause: 'unneeded', text: 'no gate left open, nothing owed at the lock' } };
  const first = owed[0].want;
  if (s.dimension !== 'overworld') return { none: { cause: 'away', text: `in ${s.dimension} (owed: ${first})` } };
  if (!nearHome(s, CARE_NEAR)) return { none: { cause: 'away', text: `${!s.home ? 'no home set' : `${Math.round(s.distHome)} blocks from home (care works within ${CARE_NEAR}, on home's level)`} (owed: ${first})` } };
  if (inHallOrLock(world, s.position)) return { none: { cause: 'hold', text: `the bot is in the villager hall or its lock: out of it first (owed: ${first})` } };
  const waits = rowWaits.get(world) ?? {};
  const ready = owed.find(o => !((waits[o.row] ?? 0) > s.now));
  if (ready) return ready;
  const until = Math.min(...owed.map(o => waits[o.row] ?? 0));
  return { none: { cause: 'hold', text: `${first}: not done just now, tried again at ${hhmm(until)}`, until } };
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
 * After gates stood open: every ward that could have gone out by one looked for by its uuid. Led, or in the lock when
 * the lock's own gate was one of them (a ward in the lock is never lowered by absence alone, R-9). One not seen on two
 * whole looks 10 s apart is astray, and `halt` is set: no new trip until the lead has looked. A look that is not whole
 * (just after a rejoin) concludes nothing.
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
    missing = missing.filter(w => !seen.some(e => !!e.uuid && (e.uuid === w.uuid || e.uuid === w.key)));
  }
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
  const atLock = !!f.trip && (f.trip.state === 'lock' || f.trip.state === 'door');
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
  return said.join('; ');
}

// ------------------------------------------------------------------------------------------------ the goals

const gate = (s: Snapshot, world: WorldMemory): Gate => {
  const o = careOwed(s, world);
  return 'none' in o ? o.none : { want: o.want };
};

/**
 * Care: priority 62 (over `close up` 61 and the stash 60), and 75 while a row of these is owed (under the food goal's
 * 76 and the shelter's 80, over the kit's 70 and every chore). Rows 1 and 4 stop what runs (an open gate and a
 * villager shut out are now); 2 and 5 wait for it to end. It starts from wherever the bot stands, needs no room and no
 * switch, and is tried again 5 s after a run, a minute after three failures (never left until the morning).
 */
export const villagerCareGoal: Goal = {
  name: 'villager care',
  priority: 62,
  urgency: (s, world) => ('row' in careOwed(s, world) ? 75 : 62),
  timeoutMs: 10 * MINUTE,
  retryMs: 5_000,
  failHoldMs: MINUTE,
  gate,
  ...fromGate(gate),
  cuts: (s, world) => { const o = careOwed(s, world); return 'row' in o && ((o.row === 1 && !o.quiet) || o.row === 4); },
  run: async ctx => {
    began.set(ctx, Date.now());
    const o = careOwed(ctx.s, ctx.world);
    if ('none' in o) return o.none.text;
    switch (o.row) {
      case 1: return shutLeftOpen(ctx);
      case 2: return lockMended(ctx);
      case 4: return letBackIn(ctx);
      case 5: return shutBehind(ctx);
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
