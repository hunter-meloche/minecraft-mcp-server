import test, { type ExecutionContext } from 'ava';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Seen } from '../../src/client/brain/village.js';
import { CARE_WAITS, careOwed, noteLock, outOfHallGoal, outOfHallWants, villagerCareGoal } from '../../src/client/brain/villagercare.js';
import { fetchLine, fetchOf, peekFetch, wardOut, wardSeen, type FetchMemory, type Trip, type Ward } from '../../src/client/brain/fetch.js';
import { fetchRun, leadOn, prep } from '../../src/client/brain/lure.js';
import { HALL_WAITS } from '../../src/client/brain/hallchores.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { inByGate, inFence, strictGates, strictSet } from '../../src/client/brain/yardgates.js';
import { returnIdle } from '../../src/client/brain/goals.js';
import { P, SMITHING, YARD, YARD_GATES, Killed, idOf, isOpen, key, yard, type Pasture, type Villager } from '../helpers/pasture.js';

// The kill test (idle-plan V, INV-2 and section 7's K rows): a trip stopped dead (kill -9: no exit handler, nothing
// saved after) at every call index inside GATE, LOCK and DOOR and at every state boundary; the brain back over
// brain.json as last saved; care (villagercare.ts) and `out of the hall` over the next fake days with the gate watch.
// Then: nothing of the bot's stands outside its yard, every lift is back or held for a ward, every gate reads shut,
// every ward is in the hall, let go, or astray/dead with the status line saying so; a kill at or after "P shut"
// always ends in the hall.
//
// Serial: care's waits run on the pasture's clock (CARE_WAITS, HALL_WAITS are the module's), and pockets.ts `out` is
// one for the process.

/**
 * A killed brain's promises still settle in this process (a kill -9 leaves none): a run stopped dead may have left a
 * promise of its own un-awaited (lure.ts leadOn hands back DOOR's without an await inside its try, so a kill on DOOR's
 * first call rejects it after leadOn's finally has thrown), and it rejects with the kill. Those, and only those, are
 * handled here, so the test's own rejections are still the runner's.
 */
process.on('unhandledRejection', (e, promise) => { if (e instanceof Killed || (e instanceof Error && e.message === 'aborted')) promise.catch(() => undefined); });

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const cellAt = (q: Pos): Pos => ({ x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) });
const inBox = (b: { x1: number; z1: number; x2: number; z2: number }, c: { x: number; z: number }) => Math.floor(c.x) >= b.x1 && Math.floor(c.x) <= b.x2 && Math.floor(c.z) >= b.z1 && Math.floor(c.z) <= b.z2;
const HALL_BOX = { x1: -561, z1: 2126, x2: -551, z2: 2134 };
const V_BELL = at(-720, 63, 2128), V_AREA = { x1: -750, z1: 2098, x2: -690, z2: 2158 };
const NORTH = YARD_GATES.north;
const NORTH_WAY = { at: { ...NORTH }, side: 'north' as const, inner: at(-549, 63, 2121), outer: at(-549, 63, 2117), yard: 18 };
const LECTERN = at(-553, 63, 2127);

/** The waits on the pasture's clock, for the process that lives now. */
function onPasture(t: ExecutionContext, p: () => Pasture): void {
  HALL_WAITS.pollMs = 1000;
  HALL_WAITS.sleep = ms => p().clock.sleep(ms);
  CARE_WAITS.sleep = ms => p().clock.sleep(ms);
  CARE_WAITS.now = () => p().now();
  t.teardown(() => { HALL_WAITS.pollMs = 0; delete HALL_WAITS.sleep; delete CARE_WAITS.sleep; delete CARE_WAITS.now; delete afield.critical; delete afield.ledBy; });
}

/**
 * The homestead with a trip under way (lure.test.ts's `led`): moves on, the lure, armed spent; a free village to the
 * west; the hall's resident fletcher at its table and the lectern free; the workshop's smithing table lifted and
 * carried; the ward a game villager working at a lure of the bot's.
 */
function underWay(o: { tod?: number; bot: Pos; ward: Pos; lure: Pos; state: Trip['state']; toGate?: number; yard?: number; committed?: 'far' }): { p: Pasture; v: Villager } {
  const p = yard({ crossings: false, tod: o.tod ?? 3_000, at: o.bot });
  const now = p.now();
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 0, journal: [], wards: [], nextId: 10 } as FetchMemory;
  p.world.villages = { sites: [{ x: V_BELL.x, y: V_BELL.y, z: V_BELL.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: now, area: { ...V_AREA } }], players: [] } as unknown as WorldMemory['villages'];
  p.set(V_BELL, 'bell[attachment=floor,facing=north,powered=false]');
  p.set(LECTERN, 'lectern[facing=south,has_book=false,powered=false]');
  p.mine(LECTERN);
  p.villager({ at: at(-552, 63, 2128), mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  p.set(o.lure, 'fletching_table', 'placed');
  p.mine(o.lure);
  p.set(SMITHING, 'air');
  p.give('smithing_table');
  const v = p.villager({ at: o.ward, mind: 'game', id: 300, profession: 'fletcher', job: { ...o.lure }, bell: { ...V_BELL } });
  const f = fetchOf(p.world), site = 'village -720,2128';
  const w: Ward = { key: v.uuid, uuid: v.uuid, id: v.id, from: { site, at: { ...V_BELL } }, since: now, bell: true, where: 'led', last: { at: { ...v.position }, t: now, tod: p.tod, health: 20, profession: 'fletcher' }, health0: 20 };
  f.journal.push({ k: 'lift', id: 1, trip: 9, at: { ...SMITHING }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: now },
    { k: 'lure', id: 2, trip: 9, at: { ...o.lure }, item: 'fletching_table', st: 'down', role: inBox(YARD, o.lure) ? 'yard' : 'hop', t: now });
  f.wards.push(w);
  f.trip = {
    id: 9, kind: 'bring', site, state: o.state, beat: now, entered: now, prep: { read: now, kit: now, lifts: now }, prepared: { at: now, day: 0 },
    gate: { ...NORTH_WAY }, spare: [], lure: 'fletching_table', hop: { n: 6, lure: { ...o.lure }, replaced: 0 }, ward: v.uuid, avoid: [], times: {},
    counts: { hops: 6, misses: 0, wedges: 0, pins: 0 }, path: { toGate: o.toGate ?? 3, yard: o.yard ?? 18 }, committed: o.committed ?? 'far'
  };
  p.saved = JSON.stringify(p.world);
  return { p, v };
}
/** The last lure before the north gate: the ward by it, the bot beside (the gate's spot), then GATE, the yard's hops, LOCK and DOOR. */
const atTheGate = () => underWay({ bot: at(-551, 63, 2112), ward: at(-551, 63, 2114), lure: at(-551, 63, 2115), state: 'hop' });

type Row = { x: number; y: number; z: number; open: boolean; loaded: boolean; leftOpen: boolean };
/** What the brain's gate watch does every 5 s: the bridge's strict gates into fetch.gates, a look into the lock, the wards brought up to the look (never lowered by it). */
async function watch(p: Pasture): Promise<void> {
  const st = await p.ctx.call<{ strict: Row[] }>('gates.status', {}).catch(() => undefined);
  if (!st) return;
  const rows = st.strict.filter(r => r.loaded !== false), cell = (r: Row) => at(r.x, r.y, r.z);
  fetchOf(p.world).gates = { at: p.now(), open: rows.filter(r => r.open).map(cell), leftOpen: rows.filter(r => r.leftOpen).map(cell) };
  const seen = (await p.ctx.call<{ entities: Seen[] }>('world.entities', { maxDistance: 128 })).entities;
  noteLock(p.world, seen, p.now());
  if (peekFetch(p.world).wards.length) { wardSeen(p.world, seen, false, p.now(), { tod: p.tod }); p.ctx.save?.(); }
}

/**
 * The brain back after a stop (INV-2's "run care over the next fake days"): its start (the strict set and the closer
 * sent, brain.ts attach), then turn by turn the gate watch, `out of the hall` (survival: the bot found in the hall or
 * the lock) and care, the clock on a few seconds between turns and on to the morning when nothing is owed by night
 * (the bot abed). `days`: how long. What ran, by row.
 */
async function recover(p: Pasture, days = 1.5): Promise<string[]> {
  await p.ctx.call('gates.strict', strictSet(p.world) as unknown as Record<string, unknown>);
  const end = p.tick + Math.round(days * 24_000), ran: string[] = [];
  while (p.tick < end) {
    await watch(p);
    if (outOfHallWants(p.look(), p.world)) { ran.push(`out: ${await outOfHallGoal.run(p.ctx)}`); continue; }
    const o = careOwed(p.look(), p.world);
    if ('row' in o) {
      const said = await villagerCareGoal.run(p.ctx);
      ran.push(`${o.row}: ${said}`);
      p.advance(100);
      continue;
    }
    // (nothing owed now: the bot off by day walks home as the brain's idle goal does, by a gate; else 20 s on, and at
    // night the bot is abed, so the night passes)
    if (!inFence(p.world, p.bot.at) && returnIdle.wants(p.look(), p.world)) { const r = await inByGate(p.ctx, 4 * 60_000); ran.push(`home: ${r.shut ?? 'in'}`); if (!r.shut) continue; }
    p.advance(p.tod >= 12_500 && p.tod < 23_500 ? ((23_500 - p.tod) % 24_000 + 24_000) % 24_000 : 400);
  }
  return ran;
}

/**
 * INV-2 after the days of recovery, what fails of it (asserted by the caller, with the recovery's log). `inHall`: the
 * kill came at or after "P shut": the ward must be in the hall.
 */
function inv2(p: Pasture, v: Villager, o: { inHall?: boolean } = {}): string[] {
  const f = peekFetch(p.world), now = p.now(), bad: string[] = [];
  // nothing of the bot's stands outside its yard: no lure in the journal out there, none standing where one was put down
  for (const e of f.journal.filter(x => x.k === 'lure' && !inBox(YARD, x.at))) bad.push(`a lure of the bot's left outside the fence at ${key(e.at)} (${JSON.stringify(e)})`);
  for (const c of p.changed.filter(x => x.how === 'placed' && idOf(x.to) === 'fletching_table' && !inBox(YARD, x.at))) {
    if (idOf(p.get(c.at)) === 'fletching_table') bad.push(`a fletching table of the bot's stands at ${key(c.at)}`);
  }
  // every lift is back, or held for a ward
  const lifted = f.journal.some(e => e.k === 'lift' && key(e.at) === key(SMITHING));
  if (!(idOf(p.get(SMITHING)) === 'smithing_table' || (lifted && wardOut(p.world, now)))) bad.push(`the smithing table neither back nor held for a ward (${idOf(p.get(SMITHING))}, lift ${lifted ? 'journaled' : 'off the journal'}, wardOut ${wardOut(p.world, now)})`);
  // every gate reads shut
  for (const g of strictGates(p.world)) if (isOpen(p.get(g.at))) bad.push(`${g.name} at ${key(g.at)} open`);
  // every ward in the hall, let go, or astray/dead with the status line saying so
  const line = fetchLine(p.world, now);
  for (const w of f.wards) {
    if (w.where !== 'astray' && w.where !== 'dead') bad.push(`ward ${w.key.slice(0, 8)} left ${w.where}`);
    else if (!line.includes(`ward ${w.key.slice(0, 4)}.. ${w.where}`)) bad.push(`the status line does not say it: ${line}`);
  }
  if (!f.wards.length && !inBox(HALL_BOX, v.position) && v.profession !== 'none') bad.push(`off the wards, neither in the hall nor let go (${key(cellAt(v.position))}, ${v.profession})`);
  if (o.inHall && !inBox(HALL_BOX, v.position)) bad.push(`killed after P shut, not in the hall (${key(cellAt(v.position))})`);
  // and nothing of a trip held: no trip but one a ward is out for, or tomorrow's in PREP
  if (f.trip && !f.wards.length && f.trip.state !== 'prep') bad.push(`trip ${f.trip.id} left ${f.trip.state} with no ward`);
  return bad;
}
/** INV-2 asserted, the recovery's log said with what failed. */
function holds(t: ExecutionContext, label: string, bad: string[], ran: string[]): void {
  if (bad.length) t.log(label, '\n', ran.join('\n'));
  t.deepEqual(bad, [], label);
}

/** Where each state of a clean run begins, by call index (the first call made with it saved), and where P was shut on the ward. */
function marks(p: Pasture): { at: Record<string, number>; pShut: number } {
  const at: Record<string, number> = {};
  let was = '';
  for (const e of p.log) {
    const st = (JSON.parse(e.saved) as { fetch?: FetchMemory }).fetch?.trip?.state ?? '-';
    if (st !== was && at[st] === undefined) at[st] = e.i;
    was = st;
  }
  // (P shut on the ward: the release that ends the hold after it stepped in, the last one before DOOR)
  const pShut = p.log.filter(e => e.name === 'gates.release' && Number(e.params.z) === P.z && e.params.shut === true && e.i < (at.door ?? Infinity)).at(-1)?.i ?? Infinity;
  return { at, pShut };
}

type Made = { p: Pasture; v: Villager; run?: (p: Pasture) => Promise<unknown> };
type Make = () => Made | Promise<Made>;
/** The run a scenario stops: its own (a whole trip's fetchRun, care's rescue), else the lead from the records. */
const runOf = (m: Made) => m.run ?? ((p: Pasture) => leadOn(p.ctx, p.clock));

/** A clean run of `make`'s to the hall: its marks, so a sweep knows the windows. */
async function cleanRun(t: ExecutionContext, make: Make): Promise<{ at: Record<string, number>; pShut: number; calls: number; ticks: Record<string, number> }> {
  const m = await make(), { p, v } = m;
  onPasture(t, () => p);
  await runOf(m)(p);
  t.true(inBox(HALL_BOX, v.position), `the clean run ends in the hall: ${key(cellAt(v.position))}`);
  const mk = marks(p), ticks: Record<string, number> = {};
  for (const [k, i] of Object.entries(mk.at)) ticks[k] = p.log[i]?.t ?? 0;
  return { ...mk, calls: p.log.length, ticks };
}

/**
 * The lead stopped dead before call `i` (kill -9: no exit handler, nothing saved after; `client`: the game client with
 * it, the bridge's holds gone), `before` what happens while it is down, the brain back `after` ticks on over brain.json
 * as saved, then the recovery's days. What INV-2 is asked of.
 */
async function killedAt(t: ExecutionContext, make: Make, i: number, o: { client?: boolean; after?: number; before?: (p: Pasture) => void } = {}): Promise<{ p: Pasture; v: Villager; ran: string[] }> {
  const m = await make(), { p, v } = m;
  onPasture(t, () => p);
  p.killAt(i, o.client ?? false);
  await runOf(m)(p).then(() => undefined, () => undefined);
  o.before?.(p);
  p.restart(o.after === undefined ? {} : { after: o.after });
  return { p, v, ran: await recover(p) };
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
/** Every call index given killed in turn, INV-2 asked after each. */
async function sweep(t: ExecutionContext, name: string, make: Make, at: readonly number[], pShut: number, o: { client?: boolean } = {}): Promise<void> {
  for (const i of at) {
    const { p, v, ran } = await killedAt(t, make, i, o);
    const bad = inv2(p, v, { inHall: i >= pShut });
    holds(t, `${name}: killed at call ${i}`, bad, ran);
    if (bad.length) return;
  }
}

test.serial('X3 killed at every call index of GATE (the client alive: the bridge\'s dead-man shuts a held gate): care resumes from the records, and every end is INV-2\'s', async (t) => {
  const m = await cleanRun(t, atTheGate);
  t.true(m.at.yardhop - m.at.gate > 40, `GATE is ${m.at.yardhop - m.at.gate} calls`);
  await sweep(t, 'GATE', atTheGate, range(m.at.gate, m.at.yardhop), m.pShut);
});

test.serial('X3 killed at every call index of LOCK: P never left open onto the ward, and a kill at or after "P shut" always ends in the hall', async (t) => {
  const m = await cleanRun(t, atTheGate);
  t.true(m.pShut > m.at.lock && m.pShut < m.at.door, `P shut at ${m.pShut}`);
  await sweep(t, 'LOCK', atTheGate, range(m.at.lock, m.at.door), m.pShut);
});

test.serial('X4 killed at every call index of DOOR (the socket open a second, H opened behind the shut P): its wall block back first, always in the hall', async (t) => {
  const m = await cleanRun(t, atTheGate);
  await sweep(t, 'DOOR', atTheGate, range(m.at.door, m.at.restore), m.pShut);
});

// ------------------------------------------------------------------------------------------------ a whole trip, a cut, the unit, the bot, the clock

/**
 * A whole trip: PREP at 10000 the evening before (the smithing table lifted), the bring at the bot's dawn by the rung's
 * run (lure.ts fetchRun): out by the north gate to the village on the lawn, its one unemployed adult, the hops home.
 */
async function wholeTrip(o: { prepOnly?: boolean } = {}): Promise<Made> {
  const p = yard({ crossings: false, tod: 10_000 });
  const now = p.now();
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 1, journal: [], wards: [], nextId: 1 } as FetchMemory;
  const site = {
    x: V_BELL.x, y: V_BELL.y, z: V_BELL.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: now, area: { ...V_AREA },
    judged: { at: now, kind: 'free', why: '7 villagers, 3 unemployed adult(s) to take', v: 4 }, whole: { at: now, villagers: 7, takes: 1 }
  };
  p.world.villages = { sites: [site], players: [] } as unknown as WorldMemory['villages'];
  p.set(V_BELL, 'bell[attachment=floor,facing=north,powered=false]');
  p.set(LECTERN, 'lectern[facing=south,has_book=false,powered=false]');
  p.mine(LECTERN);
  p.villager({ at: at(-552, 63, 2128), mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  const v = p.villager({ at: at(V_BELL.x + 4, 63, V_BELL.z), mind: 'game', id: 200, bell: { ...V_BELL } });
  p.saved = JSON.stringify(p.world);
  if (o.prepOnly) return { p, v, run: q => prep(q.ctx, q.clock) };
  const r = await prep(p.ctx, p.clock);
  if (!r.prepared) throw new Error(`not prepared: ${r.text}`);
  p.advance(((23_600 - p.tod) % 24_000 + 24_000) % 24_000);
  p.saved = JSON.stringify(p.world);
  return { p, v, run: q => fetchRun(q.ctx, q.world.villages!.sites[0], q.clock) };
}

test.serial('D22 restart at every state boundary of a whole trip (out, survey, first, hop, gate, the yard\'s hops, LOCK, DOOR, RESTORE), and killed inside PREP\'s lift: every end INV-2\'s', async (t) => {
  const m = await cleanRun(t, wholeTrip);
  const states = ['out', 'survey', 'first', 'hop', 'gate', 'yardhop', 'lock', 'door', 'restore'];
  t.deepEqual(states.filter(k => m.at[k] === undefined), [], `the clean trip passes every state: ${JSON.stringify(m.at)}`);
  await sweep(t, 'boundary', wholeTrip, states.map(k => m.at[k]), m.pShut);
  // killed inside PREP, between the smithing table's journal entry and its dig: PREP goes on from its stamps, the read decides
  const clean = await wholeTrip({ prepOnly: true });
  onPasture(t, () => clean.p);
  await clean.run!(clean.p);
  const dig = clean.p.log.find(e => e.name === 'dig.here' && key({ x: Number(e.params.x), y: Number(e.params.y), z: Number(e.params.z) }) === key(SMITHING));
  t.truthy(dig, 'PREP lifts the smithing table');
  for (const i of [dig!.i, dig!.i + 1]) {
    const { p, v, ran } = await killedAt(t, () => wholeTrip({ prepOnly: true }), i);
    t.true(ran.some(x => /^10: prepared for/.test(x)), `PREP killed at ${i} goes on: ${ran.join(' | ')}`);
    holds(t, `PREP killed at call ${i}`, inv2(p, v), ran);
  }
});

/**
 * A lead cut by a survival goal (an abort; the exit handler runs, the process lives) at the first call of each state
 * from GATE to DOOR: care's row 3 goes on from it in the same process.
 */
test.serial('3.3 a trip cut in each state (the exit handler run: held gates released shut, the ward astray at its tether, the trip cut): care goes on from it, every end INV-2\'s', async (t) => {
  const m = await cleanRun(t, atTheGate);
  for (const state of ['gate', 'yardhop', 'lock', 'door']) {
    const { p, v } = atTheGate();
    onPasture(t, () => p);
    const ac = new AbortController();
    p.at(m.ticks[state] + 1, () => ac.abort());
    await leadOn({ ...p.ctx, signal: ac.signal }, p.clock).then(() => undefined, () => undefined);
    const ran = await recover(p);
    holds(t, `cut in ${state}`, inv2(p, v, { inHall: state === 'door' }), ran);
  }
});

test.serial('D23 the unit killed in GATE with the gate held open (the client too: no dead-man, G stands open until the bot is back ~90 s) and a player keeping the yard ticking: row 1 first, then the ward found by its uuid; INV-2', async (t) => {
  const withPlayer = (): Made => { const made = atTheGate(); made.p.animal('player', at(-545, 63, 2125)); return made; };
  const m = await cleanRun(t, withPlayer);
  const { p: q } = withPlayer();
  onPasture(t, () => q);
  await leadOn(q.ctx, q.clock);
  const opened = q.changed.find(c => key(c.at) === key(NORTH) && isOpen(c.to))!;
  t.truthy(opened, 'the gate opened in the clean run');
  const open = q.log.find(e => e.t >= opened.t)!;
  for (const i of [open.i + 1, open.i + 6, m.at.yardhop - 2]) {
    const { p, v, ran } = await killedAt(t, withPlayer, i, { client: true });
    holds(t, `the unit killed in GATE at call ${i}`, inv2(p, v), ran);
  }
});

test.serial('D31 the bot dead at a boundary (the yard\'s hops: no anchor, its pockets lost, back at its bed): the ward astray, halt (no lure left to lead with), nothing of the bot\'s left out, the lifts held for it; INV-2', async (t) => {
  const m = await cleanRun(t, atTheGate);
  const { p, v } = atTheGate();
  onPasture(t, () => p);
  const ac = new AbortController();
  p.at(m.ticks.yardhop + 1, () => { p.bot.health = 0; ac.abort(); });
  await leadOn({ ...p.ctx, signal: ac.signal }, p.clock).then(() => undefined, () => undefined);
  t.true(p.said.some(x => /no anchor: the bot is hurt/.test(x)) || !peekFetch(p.world).journal.some(e => e.k === 'lure' && e.role === 'anchor'), 'no anchor by a dead bot');
  // respawned at its bed with nothing
  Object.assign(p.bot, { at: { ...p.world.landmarks.bed ?? { x: -549, y: 63, z: 2183 } }, health: 20, food: 20 });
  p.items.length = 0;
  const ran = await recover(p);
  holds(t, 'the bot dead', inv2(p, v), ran);
  const f = peekFetch(p.world);
  if (f.wards.length) t.truthy(f.halt, 'halt: the lead');
});

test.serial('X6 the clock moved 0, 2000 and 14000 ticks while the brain was away (killed at the yard\'s hops): every rule asked again with the time of day as read; INV-2', async (t) => {
  const m = await cleanRun(t, atTheGate);
  for (const after of [0, 2000, 14_000]) {
    const { p, v, ran } = await killedAt(t, atTheGate, m.at.yardhop + 3, { after });
    holds(t, `away ${after} ticks`, inv2(p, v), ran);
  }
});

test.serial('placed-blocks.json lagging: killed just after a yard lure went down, its protection record never written: the journal names the cell, the take adopts it; INV-2', async (t) => {
  const m = await cleanRun(t, atTheGate);
  const { p: q } = atTheGate();
  onPasture(t, () => q);
  await leadOn(q.ctx, q.clock);
  const put = q.log.find(e => e.name === 'place' && e.i > m.at.yardhop && e.i < m.at.lock)!;
  t.truthy(put, 'a yard lure in the clean run');
  const cell = { x: Number(put.params.x), y: Number(put.params.y), z: Number(put.params.z) };
  const { p, v } = await (async () => {
    const made = atTheGate();
    onPasture(t, () => made.p);
    made.p.killAt(put.i + 1);
    await leadOn(made.p.ctx, made.p.clock).then(() => undefined, () => undefined);
    made.p.protection.delete(key(cell));
    made.p.restart();
    return made;
  })();
  t.is(idOf(p.get(cell)), 'fletching_table', 'the lure stands, on no record of placed-blocks.json');
  const ran = await recover(p);
  holds(t, 'placed-blocks lagging', inv2(p, v), ran);
  t.not(idOf(p.get(cell)), 'fletching_table', 'taken up all the same');
});

/** A ward astray in the yard after a STOP, the lead's go given (halt off, armed 1): care's row 6, the armed rescue. */
function rescueOf(): Made {
  const p = yard({ crossings: false, tod: 3_000, at: at(-550, 63, 2145) });
  const now = p.now();
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 1, journal: [], wards: [], nextId: 10 } as FetchMemory;
  p.world.villages = { sites: [{ x: V_BELL.x, y: V_BELL.y, z: V_BELL.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: now, area: { ...V_AREA } }], players: [] } as unknown as WorldMemory['villages'];
  p.set(LECTERN, 'lectern[facing=south,has_book=false,powered=false]');
  p.mine(LECTERN);
  p.villager({ at: at(-552, 63, 2128), mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  p.set(SMITHING, 'air');
  p.give('smithing_table');
  const v = p.villager({ at: at(-546, 63, 2160), mind: 'game', id: 310, bell: { ...V_BELL } });
  const f = fetchOf(p.world);
  f.journal.push({ k: 'lift', id: 1, trip: 9, at: { ...SMITHING }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: now });
  f.wards.push({ key: v.uuid, uuid: v.uuid, id: v.id, from: { site: 'village -720,2128', at: { ...V_BELL } }, since: now, bell: true, where: 'astray', note: 'stopped: stalled', last: { at: { ...v.position }, t: now, tod: p.tod, health: 20, profession: 'none' }, health0: 20 });
  p.saved = JSON.stringify(p.world);
  return { p, v, run: async q => { await watch(q); return villagerCareGoal.run(q.ctx); } };
}

test.serial('an armed rescue killed at every state boundary (the yard\'s hops, LOCK, DOOR, RESTORE) and at P shut: every end INV-2\'s; at or after P shut, in the hall', async (t) => {
  const m = await cleanRun(t, rescueOf);
  t.deepEqual(['yardhop', 'lock', 'door', 'restore'].filter(k => m.at[k] === undefined), [], JSON.stringify(m.at));
  await sweep(t, 'rescue', rescueOf, [m.at.yardhop, m.at.yardhop + 1, m.at.lock, m.pShut, m.at.door, m.at.restore], m.pShut);
});
