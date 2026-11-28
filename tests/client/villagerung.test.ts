import test from 'ava';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// (the brain first: it loads the work queue's ladder before the rung's own module, the order the bot itself loads them in)
import { Brain, decide } from '../../src/client/brain/brain.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { registerBrainTools } from '../../src/client/brain/brain-tools.js';
import { pick, workGoals, type WorkTask } from '../../src/client/brain/work.js';
import { DAWN_URGENCY, LURE_BUDGET, dryNext, fitsMorning, lureNeed, lureSite, lureState, noteVerdict, prepStayIn, tooFarFor, villagersTask } from '../../src/client/brain/villagemove.js';
import {
  FETCH_WAIT, FETCH_WAIT_MAX, JUDGE_V, WAIT_AGAIN, WAIT_MAX, fetchWait, freshFree, lureOn, noteSeen, peekVillages, siteOpen, villagersLine, waitAgain, wholeLook,
  type Seen, type Verdict, type VillageLook, type VillageSite
} from '../../src/client/brain/village.js';
import { GAME_DAY, fetchLine, fetchOf, floorOk, need, peekFetch, startNeed, type FetchMemory, type Trip, type Ward } from '../../src/client/brain/fetch.js';
import { prep } from '../../src/client/brain/lure.js';
import { yard, type Pasture } from '../helpers/pasture.js';
import { lockAt } from '../../src/client/brain/villagerwalk.js';
import { kit } from '../../src/client/brain/chores.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import type { ClientRuntime, InventoryItem } from '../../src/client/tools.js';
import type { Goal, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';

/**
 * The villagers rung and the switches under the job-site lure (idle-plan V, S1 package B6): the rung's variants (a
 * prepared trip's `bring:` at its dawn, a whole `look:`, the searches), its gates (the halt, armed, a bad omen, the
 * clock), its urgency at dawn, the villages as the lure reads them (its own waits, the floor's count, the wards and the
 * lures' workers never a village), the work queue's stay-in for PREP, the villager-moves tool's switches, and the
 * brain's half (the wards brought up to its looks, a landmark the fetch holds kept, a live trip said first). With
 * `method` absent, as the bot runs, all of it is as before: the first rows pin that.
 *
 * The world is the live homestead of Nov 25 (the yard x -565..-533, z 2119..2215, the hall at (-561, 62, 2126) with
 * its gate H (-556, 63, 2134), the lock south of it as the shells goal built it), the west village's bell at
 * (-693, 69, 2262), 164 from home, judged free on a whole look.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.UTC(2026, 10, 25, 16, 0, 0);
const HOME: Pos = { x: -549, y: 63, z: 2183 };
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const HALL = { x: -561, y: 62, z: 2126, width: 11, length: 9 };
const H: Pos = { x: -556, y: 63, z: 2134 };
const WEST: Pos = { x: -693, y: 69, z: 2262 };
const SOUTH_V: Pos = { x: -549, y: 64, z: 2400 };
const FAR_V: Pos = { x: -549, y: 64, z: 1800 };
const WEST_GATE: Pos = { x: -565, y: 63, z: 2183 };
const SOUTH_GATE: Pos = { x: -549, y: 63, z: 2215 };
const NORTH_GATE: Pos = { x: -549, y: 63, z: 2119 };
const SMITHING: Pos = { x: -541, y: 63, z: 2153 };
const LOCK = lockAt(H, 'south');
const WARD_UUID = 'ffeeb80c-1234-4abc-9def-0123456789ab';

/** A village site judged free on a whole look `ago` ms before T0, counted whole for the floor (none: no count). */
function freeSite(at: Pos, o: { ago?: number; villagers?: number; takers?: number; whole?: { ago: number; villagers: number; takes?: number } | null } = {}): VillageSite {
  const t = T0 - (o.ago ?? HOUR), v = o.villagers ?? 7;
  return {
    x: at.x, y: at.y, z: at.z, bells: 1, villagers: v, seenAt: t,
    judged: { at: t, kind: 'free', why: `${v} villagers, ${o.takers ?? 3} unemployed adult(s) to take`, v: JUDGE_V },
    area: { x1: at.x - 40, z1: at.z - 40, x2: at.x + 40, z2: at.z + 40 },
    ...(o.whole === null ? {} : { whole: { at: T0 - (o.whole?.ago ?? HOUR), villagers: o.whole?.villagers ?? v, takes: o.whole?.takes ?? 0 } })
  };
}

/** The fetch's record as the lead arms it for a trip: the lure, one trip armed, the lock and the ring read ready. */
const lureRecord = (over: Partial<FetchMemory> = {}): FetchMemory => ({ v: 1, method: 'lure', armed: 1, journal: [], wards: [], nextId: 1, shells: { at: T0, lock: [], ring: [] }, ...over });

/** The homestead with the lock standing, the moves on; `fetch` the record (none: as the bot runs today), the villages given. */
function world(o: { fetch?: FetchMemory; sites?: VillageSite[]; hall?: number } = {}): WorldMemory {
  return {
    landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD }, chestItems: {}, lastDone: {},
    zones: {
      hall: [{ ...HALL }], 'hall:gate': [{ ...H }], 'fence:gate': [{ ...WEST_GATE }, { ...SOUTH_GATE }, { ...NORTH_GATE }],
      'lock:gate': [{ ...LOCK.p }], 'lock:socket': [{ ...LOCK.socket }], 'lock:sill': [{ ...LOCK.sill }], 'lock:post': [{ ...LOCK.post }], 'lock:sout': [{ ...LOCK.sOut }],
      'lock:inside': LOCK.inside.map(c => ({ ...c }))
    },
    villagerMoves: true,
    villages: { sites: o.sites ?? [freeSite(WEST)], players: [], hall: { count: o.hall ?? 1, at: T0 - MINUTE } },
    ...(o.fetch ? { fetch: o.fetch } : {})
  } as WorldMemory;
}

/** A look at home by day, awake and well, at time of day `tod`. */
function look(tod: number, over: Partial<Snapshot> = {}): Snapshot {
  const items: InventoryItem[] = over.items ?? [];
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: T0, timeOfDay: tod, activity: activityAt(tod), health: 20, food: 20, position: { ...HOME }, dimension: 'overworld', sleeping: false, raining: false,
    thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length, home: { ...HOME, dimension: 'overworld' }, distHome: 0, ...over
  };
}

/** A trip PREP has made ready for the west village: out at dawn by the west gate. */
const prepared = (over: Partial<Trip> = {}): Trip => ({
  id: 3, kind: 'bring', site: 'village -693,2262', state: 'prep', beat: T0 - 2 * HOUR, prep: { read: T0 - 3 * HOUR, kit: T0 - 3 * HOUR, lifts: T0 - 2 * HOUR },
  prepared: { at: T0 - 2 * HOUR, day: 4 }, gate: { at: { ...WEST_GATE }, side: 'west', inner: { x: -563, y: 63, z: 2183 }, outer: { x: -567, y: 63, z: 2183 }, yard: 48 },
  spare: [], lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 }, ...over
});

const ward = (over: Partial<Ward> = {}): Ward => ({
  key: WARD_UUID, uuid: WARD_UUID, from: { site: 'village -693,2262', at: { x: -675, y: 71, z: 2249 } }, since: T0 - HOUR, bell: true, where: 'led',
  last: { at: { x: -600, y: 66, z: 2210 }, t: T0 - MINUTE, tod: 4000, health: 17, profession: 'fletcher' }, health0: 17, ...over
});

const ids = (s: Snapshot, w: WorldMemory) => villagersTask.variants(s, w).map(v => v.id);
const SEARCHES = ['north', 'east', 'south', 'west', 'north-east', 'south-east', 'south-west', 'north-west'];

// ------------------------------------------------------------------------------------------------ inert by default

test('with `method` absent (as the bot runs) the rung is as it was: the boat\'s move offered, no urgency of its own, no stay-in, the Villagers line and the gates unchanged', (t) => {
  for (const fetch of [undefined, lureRecord({ method: undefined }), lureRecord({ method: 'boat' })]) {
    const w = world({ fetch, sites: [freeSite(WEST), { ...freeSite(SOUTH_V), noBoat: { at: T0 - HOUR, why: 'a step up' } }] });
    t.false(lureOn(w));
    // (the boat's move for the west village; the south one waits on its boat way: the rails switch is off)
    t.deepEqual(ids(look(1000), w), ['village -693,2262', ...SEARCHES]);
    t.is(villagersTask.urgent!(look(23_600), w), undefined);
    t.is(prepStayIn(look(7000), w), undefined);
    t.is(villagersTask.ready(look(1000), w, 'village -693,2262'), null);
    t.notRegex(villagersLine(w, T0), /method lure|no usable village/);
    t.regex(villagersLine(w, T0), /^Villagers: moves on; the hall at/);
    t.true(siteOpen(w.villages!.sites[0], HOME, T0));
    t.false(siteOpen(w.villages!.sites[1], HOME, T0), 'the boat\'s own word still holds it');
  }
  // the work queue's urgency for the rung: 19 - rank, as before
  const [goal] = workGoals(() => undefined, [villagersTask], () => T0);
  t.is(goal.urgency!(look(23_600), world()), 19 - villagersTask.rank);
});

test('a verdict noted with `method` absent writes nothing the lure reads: no count for the floor, no count of equal waits', (t) => {
  const w = world({ sites: [freeSite(WEST, { whole: null })] });
  const site = w.villages!.sites[0];
  noteVerdict(w, site, villageLook(12, 12), freeVerdict(7), T0);
  t.is(site.whole, undefined);
  noteVerdict(w, site, villageLook(12, 12), { kind: 'wait', why: '4 villager(s) seen, 5 or more wanted' }, T0);
  t.is(site.judged!.n, undefined);
});

// ------------------------------------------------------------------------------------------------ the villages as the lure reads them

/** A look round the west village that saw `chunks` of `of` (`of` alike: the whole of it). */
const villageLook = (chunks: number, of: number): VillageLook => ({ bells: [{ ...WEST }], beds: [], jobs: [], seen: [], penned: new Set(), kinds: {}, looked: { chunks, of }, zones: [], players: [] });
const freeVerdict = (villagers: number): Verdict => ({
  kind: 'free', why: `${villagers} villagers, 3 unemployed adult(s) to take`, area: { x1: WEST.x - 40, z1: WEST.z - 40, x2: WEST.x + 40, z2: WEST.z + 40, y1: 50, y2: 90 },
  own: [], candidates: [], villagers, outposts: [], notes: []
});

test('siteOpen under the lure reads its own last word on a village (site.fetch) by its kind, never the boat\'s or the rails\'', (t) => {
  const s = freeSite(WEST);
  // the boat found no way home from it an hour ago: nothing to the lure
  t.true(siteOpen({ ...s, noBoat: { at: T0 - HOUR, why: 'a step up' } }, HOME, T0, 'lure'));
  const after = (kind: NonNullable<VillageSite['fetch']>['kind'], n: number, ago: number) => siteOpen({ ...s, fetch: { at: T0 - ago, ok: false, kind, why: 'x', n } }, HOME, T0, 'lure');
  t.false(after('no claim', 1, 6 * HOUR - 1));
  t.true(after('no claim', 1, 6 * HOUR));
  t.false(after('no claim', 2, 12 * HOUR - 1), 'nobody came twice in a row: 12 h');
  t.false(after('no way', 1, 72 * HOUR - 1));
  t.false(after('rival', 1, 72 * HOUR - 1));
  t.true(after('rival', 1, 72 * HOUR));
  t.false(after('no unemployed', 3, 24 * HOUR - 1), 'no unemployed adult: 24 h, never doubling');
  t.true(after('no unemployed', 3, 24 * HOUR));
  t.true(after('late', 4, 0), 'too late is the clock\'s, not the village\'s');
  t.is(fetchWait({ at: T0, ok: false, kind: 'no way', why: 'x', n: 9 }), FETCH_WAIT_MAX, 'capped at a week');
  t.is(fetchWait({ at: T0, ok: true, kind: 'no claim', why: 'a dry run measured the way', n: 1, pathLen: 210 }), 0);
  t.is(fetchWait({ at: 'yesterday', kind: 'no claim' }), 0, 'a word written by hand with no time holds nothing');
  t.is(FETCH_WAIT['no claim'], 6 * HOUR);
});

test('A4: under the lure a wait for the same reason doubles from the fourth in a row, up to a week (another reason starts again)', (t) => {
  const w = world({ fetch: lureRecord(), sites: [freeSite(WEST)] });
  const wait = (why: string, at: number) => {
    const site = w.villages!.sites[0];
    noteVerdict(w, site, villageLook(12, 12), { kind: 'wait', why }, at);
    return w.villages!.sites[0];
  };
  let site = wait('4 villager(s) seen, 5 or more wanted', T0);
  t.is(site.judged!.n, 1);
  site = wait('3 villager(s) seen, 5 or more wanted', T0 + 7 * HOUR);
  site = wait('4 villager(s) seen, 5 or more wanted', T0 + 14 * HOUR);
  t.is(site.judged!.n, 3, 'the same reason, its numbers aside');
  t.false(siteOpen(site, HOME, T0 + 14 * HOUR + WAIT_AGAIN - 1, 'lure'));
  t.true(siteOpen(site, HOME, T0 + 14 * HOUR + WAIT_AGAIN, 'lure'));
  site = wait('4 villager(s) seen, 5 or more wanted', T0 + 21 * HOUR);
  t.is(site.judged!.n, 4);
  t.false(siteOpen(site, HOME, T0 + 21 * HOUR + 2 * WAIT_AGAIN - 1, 'lure'), 'the fourth: 12 h');
  t.true(siteOpen(site, HOME, T0 + 21 * HOUR + 2 * WAIT_AGAIN, 'lure'));
  t.is(waitAgain({ n: 30 }), WAIT_MAX);
  t.is(waitAgain({}), WAIT_AGAIN);
  // the boat's rule is the old one: 6 h whatever the count
  t.true(siteOpen(site, HOME, T0 + 21 * HOUR + WAIT_AGAIN));
  site = wait('its bell not seen yet (every village has one at its meeting point)', T0 + 40 * HOUR);
  t.is(site.judged!.n, 1, 'another reason: from 1 again');
});

test('A13, F-15: a whole look counts the village for the floor; a quick look that sees part of it (3 of 5) does not lower the count', (t) => {
  const w = world({ fetch: lureRecord(), sites: [freeSite(WEST, { whole: null })] });
  let site = w.villages!.sites[0];
  t.like(floorOk(site, T0), { ok: false });
  site = noteVerdict(w, site, villageLook(132, 132), freeVerdict(7), T0)!;
  t.deepEqual(site.whole, { at: T0, villagers: 7, takes: 0 });
  site.whole!.takes = 2;
  t.like(floorOk(site, T0 + HOUR), { ok: true, left: 1, text: '1 take left at the floor of 5' });
  // the trip morning's look from one viewpoint: 42 of 121 chunks, 3 villagers in sight
  t.is(wholeLook(villageLook(42, 121), freeVerdict(3), T0 + HOUR), undefined);
  site = noteVerdict(w, site, villageLook(42, 121), { kind: 'wait', why: 'not all of it seen yet (42 of 121 chunks)', unseen: true }, T0 + HOUR)!;
  t.deepEqual(site.whole, { at: T0, villagers: 7, takes: 2 });
  t.like(floorOk(site, T0 + HOUR), { ok: true, left: 1 });
  t.truthy(freshFree(freeSite(WEST), T0));
  t.falsy(freshFree(freeSite(WEST, { ago: 72 * HOUR }), T0));
});

test('noteSeen: neither a ward nor a villager at work by a lure of the bot\'s founds a village by the yard', (t) => {
  const lure = { id: 4, trip: 3, k: 'lure' as const, at: { x: -620, y: 66, z: 2215 }, item: 'fletching_table', st: 'down' as const, role: 'hop' as const, t: T0 };
  const w = world({ fetch: lureRecord({ wards: [ward()], journal: [lure], nextId: 5 }), sites: [] });
  const villager = (id: number, at: Pos, uuid?: string): Seen => ({ id, name: 'villager', position: at, ...(uuid ? { uuid } : {}) });
  noteSeen(w, [villager(1, { x: -640.5, y: 64, z: 2230.5 }, WARD_UUID), villager(2, { x: -630.5, y: 66, z: 2240.5 }, 'b-uuid')], T0);
  t.deepEqual(peekVillages(w).sites, [], 'the ward 75 off the fence, and a villager 27 from the lure');
  noteSeen(w, [villager(3, { x: -720.5, y: 64, z: 2300.5 }, 'c-uuid')], T0);
  t.is(peekVillages(w).sites.length, 1, 'one 110 from the lure is a village\'s');
  // with no record (as the bot runs), the same look founds one as before
  const plain = world({ sites: [] });
  noteSeen(plain, [villager(1, { x: -640.5, y: 64, z: 2230.5 }, WARD_UUID)], T0);
  t.is(peekVillages(plain).sites.length, 1);
});

// ------------------------------------------------------------------------------------------------ the rung's variants

test('the lure\'s variants: a whole look first where the floor has no count, none once it has one (PREP\'s then), a prepared trip\'s bring alone at its dawn; never the boat\'s move', (t) => {
  let w = world({ fetch: lureRecord(), sites: [freeSite(WEST, { whole: null })] });
  t.deepEqual(ids(look(1000), w), ['look:village -693,2262', ...SEARCHES]);
  t.like(villagersTask.variants(look(1000), w)[0], { first: true, dist: 164 });
  t.regex((lureSite(look(7000), w) as { why: string }).why, /not counted whole yet: a whole look first/);
  // counted whole an hour ago: no look; tomorrow's trip is PREP's (care's row 10)
  w = world({ fetch: lureRecord() });
  t.deepEqual(ids(look(1000), w), SEARCHES);
  const go = lureSite(look(7000), w);
  t.like(go, { variant: 'village -693,2262' });
  t.true(('needS' in go) && go.needS > 300 && go.needS <= 460, JSON.stringify(go));
  // a free word that will be 72 h old by the trip's 9000 tomorrow (22 min on, at 7000: a game day is 20 min): a look first
  w = world({ fetch: lureRecord(), sites: [freeSite(WEST, { ago: 72 * HOUR - 10 * MINUTE })] });
  t.deepEqual(ids(look(7000), w), ['look:village -693,2262', ...SEARCHES]);
  t.like(lureState(w, w.villages!.sites[0], look(7000), HOME), { kind: 'look' });
  // no unemployed adult at a look under a day old: nothing a look would change; a day on, looked at again
  w = world({ fetch: lureRecord(), sites: [freeSite(WEST, { takers: 0, ago: 2 * HOUR })] });
  t.like(lureState(w, w.villages!.sites[0], look(7000), HOME), { kind: 'wait' });
  t.deepEqual(ids(look(7000), w), SEARCHES);
  w = world({ fetch: lureRecord(), sites: [freeSite(WEST, { takers: 0, ago: 25 * HOUR })] });
  t.like(lureState(w, w.villages!.sites[0], look(7000), HOME), { kind: 'look' });
  // no take left at the floor: wait
  w = world({ fetch: lureRecord(), sites: [freeSite(WEST, { whole: { ago: HOUR, villagers: 7, takes: 3 } })] });
  t.like(lureState(w, w.villages!.sites[0], look(7000), HOME), { kind: 'wait', why: 'the village at (-693, 69, 2262): 7 seen, 3 taken: no take left at the floor of 5' });
  // prepared: the bring alone, its need the trip's own (its gate and yard way), 115 s more for the day's clock
  w = world({ fetch: lureRecord({ trip: prepared() }) });
  const v = villagersTask.variants(look(23_600), w);
  t.deepEqual(v.map(x => x.id), ['bring:village -693,2262']);
  const need = lureNeed(w, w.villages!.sites[0], HOME, prepared()).s;
  t.deepEqual(v[0], { id: 'bring:village -693,2262', dist: 164, first: true, needMs: (need + 115) * 1000 });
  // under way, or a villager out: nothing (the care's), and said so
  for (const trip of [prepared({ state: 'hop', prepared: undefined }), undefined]) {
    w = world({ fetch: lureRecord({ ...(trip ? { trip } : {}), wards: trip ? [] : [ward({ where: 'astray' })] }) });
    t.deepEqual(villagersTask.variants(look(3000), w), []);
    t.regex(villagersTask.none!(look(3000), w).text, trip ? /trip 3 is hop \(the villager care's\)/ : /a villager is on its way/);
  }
});

test('A9: a village past one morning\'s reach is neither brought from nor looked at; the line says it needs the relay, and that no usable village is known (A2)', (t) => {
  const w = world({ fetch: lureRecord(), sites: [freeSite(FAR_V, { whole: null })] });
  const st = lureState(w, w.villages!.sites[0], look(1000), HOME);
  t.like(st, { kind: 'far' });
  t.regex(st.why, /too far for one morning \(383 from home: needs \d+ s, a morning has 460 s\): needs the relay/);
  t.deepEqual(ids(look(1000), w), SEARCHES);
  t.regex((lureSite(look(7000), w) as { why: string }).why, /needs the relay/);
  const line = villagersLine(w, T0, tooFarFor(w, HOME));
  t.regex(line, /^Villagers: moves on, method lure; /);
  t.regex(line, /1 free but too far for one morning \(needs the relay\)/);
  t.regex(line, /no usable village known within 640 \(the searches go on; none at all: the cure route, which needs brewing\)/);
  // the boat's word is the boat's (its day reaches about 447 by land)
  t.regex(villagersLine(world({ sites: [freeSite({ x: -549, y: 64, z: 1680 })] }), T0, tooFarFor(world(), HOME)), /free but too far for a day's move/);
});

test('A8: two villages, the nearer by its need first; the one whose trip came to nothing waits by its kind, and the other is prepared for meanwhile', (t) => {
  const w = world({ fetch: lureRecord(), sites: [freeSite(SOUTH_V), freeSite(WEST)] });
  t.like(lureSite(look(7000), w), { variant: 'village -693,2262' });
  const west = w.villages!.sites[1];
  west.fetch = { at: T0, ok: false, kind: 'no claim', why: 'nobody came to three spots', n: 1 };
  t.like(lureSite(look(7000), w), { variant: 'village -549,2400' });
  t.like(lureSite(look(7000, { now: T0 + 6 * HOUR }), w), { variant: 'village -693,2262' });
  west.fetch.n = 2;
  t.like(lureSite(look(7000, { now: T0 + 6 * HOUR }), w), { variant: 'village -549,2400' });
  t.regex(villagersLine(w, T0 + 6 * HOUR), /free, waiting \(no claim\)/);
});

test('B4, B8: the wards on their way count toward the hall; a halt, not armed, a trip or a ward on the records, the lock not ready: no trip prepared, said', (t) => {
  // two in the hall and one led: stocked
  let w = world({ fetch: lureRecord({ wards: [ward()] }), hall: 2 });
  t.deepEqual(villagersTask.variants(look(1000), w), []);
  t.deepEqual(villagersTask.none!(look(1000), w), { cause: 'stocked', text: 'the hall has 2 villagers and 1 on its way (3 wanted)' });
  w = world({ fetch: lureRecord({ wards: [ward({ where: 'astray' })] }), hall: 2 });
  t.not(villagersTask.none!(look(1000), w).cause, 'stocked', 'one astray is not on its way');
  const why = (f: Partial<FetchMemory>, o: { hall?: number } = {}) => (lureSite(look(7000), world({ fetch: lureRecord(f), ...o })) as { why?: string }).why;
  t.is(why({ halt: { at: T0, why: 'ward ffee is astray' } }), 'HALT: ward ffee is astray');
  t.is(why({ armed: 0 }), 'not armed (villager-moves {arm: 1} lets one trip begin)');
  t.is(why({ armed: undefined }), 'not armed (villager-moves {arm: 1} lets one trip begin)');
  t.is(why({ trip: prepared({ prepared: undefined }) }), 'trip 3 is prep');
  t.is(why({ wards: [ward({ where: 'astray' })] }), '1 ward(s) on the records: the care\'s first');
  t.is(why({ shells: { at: T0, lock: ['the socket at (-554, 63, 2135) is air'], ring: [] } }), 'the lock is not ready: the socket at (-554, 63, 2135) is air');
  t.is(why({ shells: { at: T0, lock: [], ring: ['the ring\'s gate reads open'] } }), 'the portal\'s ring is not ready: the ring\'s gate reads open');
  t.is(why({ shells: undefined }), 'the lock and the portal\'s ring not read yet');
  t.is(why({}, { hall: 3 }), 'the hall has 3 villagers (3 wanted)');
  t.is(why({ method: 'boat' }), 'the method is not the lure (villager-moves {method: "lure"})');
});

test('B1, B3, B8: a prepared trip sets out only dry, armed, with no halt and no bad omen, and with the clock\'s time for it (the start rule\'s words)', (t) => {
  const w = (f: Partial<FetchMemory> = {}) => world({ fetch: lureRecord({ trip: prepared(), ...f }) });
  const bring = 'bring:village -693,2262';
  t.is(villagersTask.ready(look(23_600), w(), bring), null);
  t.like(villagersTask.ready(look(23_600, { raining: true }), w(), bring), { cause: 'late', text: 'raining: no villager is moved in the rain' });
  t.like(villagersTask.ready(look(23_600), w({ halt: { at: T0, why: 'stopped at the bell' } }), bring), { cause: 'hold', text: 'villagers: HALT (stopped at the bell): no trip sets out until the lead clears it (villager-moves {halt:false})' });
  t.like(villagersTask.ready(look(23_600), w({ armed: 0 }), bring), { cause: 'hold', text: 'villagers: not armed: no trip sets out (villager-moves {arm: 1} lets one)' });
  const omen = look(23_600, { effects: [{ name: 'bad_omen', amplifier: 0, seconds: 5000 }] });
  t.like(villagersTask.ready(omen, w(), bring), { cause: 'hold', text: 'villagers: bad omen on the bot: no trip sets out (the village it walks into would be raided)' });
  // the clock: the need in hand at 23600, not at 3000
  const need = lureNeed(w(), freeSite(WEST), HOME, prepared()).s;
  const late = villagersTask.ready(look(3000), w(), bring);
  t.like(late, { cause: 'late' });
  t.is(late!.text, `villagers: the trip needs ${need} s to have it in the lock by 8700, ${Math.floor((8700 - 3000) / 20)} s left: tomorrow`);
  // a search or a look is no trip: none of the trip's gates
  t.is(villagersTask.ready(look(3000), w({ armed: 0 }), 'north'), null);
});

test('the start rule as the bring\'s gate asks it (fetch.ts startNeed, B2\'s flag): a trip sets out only with what its first hop\'s rule 3 asks in hand too; at the limit it goes, a second on it is tomorrow\'s', (t) => {
  const w = world({ fetch: lureRecord({ trip: prepared() }) });
  const bring = 'bring:village -693,2262';
  const { s, parts } = lureNeed(w, freeSite(WEST), HOME, prepared());
  t.is(s, startNeed(parts));
  t.true(s >= need(parts), 'never less than the lock shut by 8700 with the margin');
  // the west village's first hop has 1.3 x its way home left: that binds, not the 45 s margin
  t.true(s > need(parts), `${s} against ${need(parts)}`);
  const limit = 8700 - s * 20, tod = (limit + 24_000) % 24_000;
  t.is(villagersTask.ready(look(tod), w, bring), null);
  t.like(villagersTask.ready(look(tod + 20), w, bring), { cause: 'late' });
  t.true(fitsMorning(s));
});

// ------------------------------------------------------------------------------------------------ the dawn and the afternoon

test('B16 (B "urgent at dawn"): the prepared trip\'s dawn is over the kit and the stash (71); with the start rule failing it is the rung\'s own again, and the kit goes first', (t) => {
  const w = world({ fetch: lureRecord({ trip: prepared() }) });
  // the kit wants (a home chest not looked into), the stash would too: a run's haul in the pockets
  w.landmarks.chests = [{ x: -545, y: 63, z: 2185 }];
  const stash: Goal = { name: 'stash', priority: 60, timeoutMs: 1000, retryMs: 1000, wants: () => '20/36 slots used', run: async () => 'put away' };
  const goals: Goal[] = [kit, stash, ...workGoals(() => undefined, [villagersTask], () => T0)];
  const dawn = look(23_600);
  t.truthy(kit.wants(dawn, w));
  t.is(villagersTask.urgent!(dawn, w), DAWN_URGENCY);
  const rung = goals.find(g => g.name === 'work: villagers')!;
  t.is(rung.urgency!(dawn, w), 71);
  t.like(decide(dawn, w, goals, new Map()), { goal: rung });
  t.regex(decide(dawn, w, goals, new Map())!.reason, /^bring:village -693,2262: 164 blocks out/);
  // too late for it (3000): no urgency of its own, and it does not want; the kit first
  const late = look(3000);
  t.is(villagersTask.urgent!(late, w), undefined);
  t.is(decide(late, w, goals, new Map())!.goal, kit);
  // no prepared trip: the rung's own urgency
  t.is(rung.urgency!(dawn, world({ fetch: lureRecord() })), 19 - villagersTask.rank);
  t.is(LURE_BUDGET, 9 * MINUTE);
});

/** A stand-in rung that goes `reach` out. */
const rung = (reach: WorkTask['reach']): WorkTask => ({
  name: `out ${reach}`, rank: 6, reach, room: 'yard', budgetMs: MINUTE, variants: () => [{ id: 'there', dist: reach === 'yard' ? 0 : 60 }], ready: () => null,
  run: async () => ({ gain: 0, text: 'ran' })
});

test('B15, 6.3: from 6000 the rungs that leave the yard stay in while tomorrow\'s trip is owed its reads and kit; bounded by the switches, once a day, and inert without the lure', (t) => {
  const far = rung('far'), yard = rung('yard');
  const held = (s: Snapshot, w: WorldMemory, task = far) => { const c = pick(task, s, w); return 'decline' in c ? c.decline : undefined; };
  let w = world({ fetch: lureRecord() });
  t.deepEqual(held(look(7000), w), { cause: 'hold', text: 'out far: staying in to prepare tomorrow\'s villager trip (the village at (-693, 69, 2262))' });
  t.is(held(look(7000), w, yard), undefined, 'the yard\'s rungs go on');
  t.is(held(look(5900), w), undefined, 'before 6000');
  // PREP under way, its kit not packed: held; packed: free to go
  w = world({ fetch: lureRecord({ trip: prepared({ prepared: undefined, prep: { read: T0 } }) }) });
  t.regex(held(look(7000), w)!.text, /trip 3: its kit not packed yet/);
  w = world({ fetch: lureRecord({ trip: prepared({ prepared: undefined, prep: { read: T0, kit: T0 } }) }) });
  t.is(held(look(7000), w), undefined);
  // PREP declined today: the afternoon is the chores'
  w = world({ fetch: lureRecord({ why: { prep: { at: T0 - 10 * MINUTE, n: 1, text: 'a free fletching_table stands in the hall' } } }) });
  t.is(held(look(7000), w), undefined);
  w = world({ fetch: lureRecord({ why: { prep: { at: T0 - GAME_DAY, n: 1, text: 'a free fletching_table stands in the hall' } } }) });
  t.truthy(held(look(7000), w));
  // not armed, halted, moves off, no village: nothing held
  for (const f of [{ armed: 0 }, { halt: { at: T0, why: 'x' } }] as Partial<FetchMemory>[]) t.is(held(look(7000), world({ fetch: lureRecord(f) })), undefined);
  w = world({ fetch: lureRecord() });
  w.villagerMoves = false;
  t.is(prepStayIn(look(7000), w), undefined);
  t.is(held(look(7000), world({ fetch: lureRecord(), sites: [] })), undefined);
  t.is(held(look(7000), world()), undefined, 'without the lure');
});

// ------------------------------------------------------------------------------------------------ the switches and the brain's half

/** A runtime that answers as the bridge does for the brain's looks: the blocks given (air elsewhere), the entities given. */
function fakeRuntime(o: { tod: number; blocks?: Map<string, string | null>; entities?: () => Seen[] }) {
  const calls: string[] = [];
  const rt = {
    actions: {},
    call: (async (method: string, p: Record<string, number> = {}) => {
      calls.push(method);
      if (method === 'inventory') return { items: [] };
      if (method === 'world.region') {
        const out: (string | null)[] = [];
        for (let y = 0; y < p.height; y++) for (let z = 0; z < p.length; z++) for (let x = 0; x < p.width; x++) {
          const k = `${p.x + x},${p.y + y},${p.z + z}`;
          out.push(o.blocks?.has(k) ? o.blocks.get(k)! : 'air');
        }
        return { blocks: out };
      }
      if (method === 'world.entities') return { entities: o.entities?.() ?? [] };
      return {};
    }) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, block: { ...HOME }, timeOfDay: o.tod, hashedSeed: '1', dimension: 'overworld', sleeping: false, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  return { rt, calls };
}

/** A brain in the homestead (its world filled in from `w` after the first look), autonomy on, no goals of its own. */
async function brainIn(w: WorldMemory, o: { tod?: number; blocks?: Map<string, string | null>; entities?: () => Seen[]; now?: () => number } = {}) {
  const { rt, calls } = fakeRuntime({ tod: o.tod ?? 3000, blocks: o.blocks, entities: o.entities });
  const brain = new Brain(rt, { tickMs: 1e9, goals: [], now: o.now ?? (() => T0) });
  brain.setEnabled(true);
  await brain.tick();
  const mem = brain.worldMemory()!;
  for (const k of Object.keys(mem)) delete (mem as unknown as Record<string, unknown>)[k];
  Object.assign(mem, structuredClone(w));
  return { brain, rt, calls, world: mem };
}

/** The brain's own tools on a stub server: a tool by name, its text (and whether it answered as an error). */
function brainTools(brain: Brain, rt: ClientRuntime) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  registerBrainTools(new ToolFactory(server, { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) }), brain, rt);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await calls.find(c => c.args[0] === name)!.args[3](args) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map(c => c.text).join('\n'), error: !!r.isError };
  };
}

test('villager-moves (5.5): the method, arm, dry, a halt cleared, the bell, a ward let go; said in the log with who; "free" refused and nothing changed; the rails retired under the lure', async (t) => {
  const w = world({ fetch: { v: 1, journal: [], wards: [ward({ where: 'astray' }), ward({ key: 'aaaa1111-2222', uuid: 'aaaa1111-2222', where: 'lock' })], nextId: 1, halt: { at: T0, why: 'ward ffee is astray' } } });
  const { brain, rt, world: mem } = await brainIn(w);
  const tool = brainTools(brain, rt);
  let r = await tool('villager-moves', { method: 'lure', arm: 1, dry: true, by: 'the lead' });
  t.false(r.error, r.text);
  t.regex(r.text, /^method lure \(the job-site lure; the rails home retired\)\. armed 1: 1 trip\(s\) may begin\. dry: trips plan, log and dump, and place nothing\.\n/);
  t.regex(r.text, /\nVillagers: moves on, method lure; /);
  t.regex(r.text, /\nFetch: HALT: ward ffee is astray; lure, armed 1; idle; /);
  t.like(peekFetch(mem), { method: 'lure', armed: 1 });
  t.true(dryNext(mem));
  t.regex(brain.status(), /villagers: method lure \(the job-site lure; the rails home retired\) \(by the lead\)/);
  t.regex(brain.status(), /dry: the next trip plans and places nothing/);
  // refusals change nothing
  r = await tool('villager-moves', { arm: 'free', halt: false });
  t.true(r.error);
  t.regex(r.text, /arm "free" waits for S1\.5/);
  t.truthy(peekFetch(mem).halt, 'not cleared by a refused call');
  r = await tool('villager-moves', { forget: 'nobody00' });
  t.true(r.error);
  t.regex(r.text, /no ward nobody00 on the records/);
  // the halt, the bell, a ward let go by 8 of its first characters
  r = await tool('villager-moves', { halt: false, bell: false, forget: 'ffeeb80c', by: 'the lead' });
  t.false(r.error, r.text);
  t.regex(r.text, /the halt cleared \(it was: ward ffee is astray\)\. the bell cleared for ward ffeeb80c, ward aaaa1111/);
  t.regex(r.text, /ward ffeeb80c let go of \(it was astray, last at \(-600, 66, 2210\)\)/);
  const f = peekFetch(mem);
  t.is(f.halt, undefined);
  t.deepEqual(f.wards.map(x => [x.key, x.bell]), [['aaaa1111-2222', false]]);
  // the rails switch is not the lure's
  mem.railsHome = false;
  r = await tool('villager-moves', { rails: true });
  t.regex(r.text, /^rails: retired under the lure \(the switch is left as it was\)\./);
  t.false(mem.railsHome);
  // dry off: the switch and a prepared trip's mark both go; arm 0: not armed
  fetchRecord(mem).trip = prepared({ dry: true });
  r = await tool('villager-moves', { dry: false, arm: 0 });
  t.false(dryNext(mem));
  t.is(peekFetch(mem).trip!.dry, undefined);
  t.is(peekFetch(mem).armed, undefined);
  t.regex(r.text, /not armed: no trip begins\. not dry: the next trip is a real one\./);
});

const fetchRecord = (w: WorldMemory) => w.fetch as FetchMemory;

test('villager-moves: the method stays and the led ward is kept while a villager is being led; nothing given, it only says how things stand', async (t) => {
  const led = ward();
  // (the tool reads the real clock, as the bot does: the trip's beat 5 s ago by it)
  const w = world({ fetch: lureRecord({ trip: prepared({ state: 'hop', prepared: undefined, ward: led.key, hop: { n: 4, replaced: 0 }, beat: Date.now() - 5000 }), wards: [led] }) });
  const { brain, rt, world: mem } = await brainIn(w, { now: () => Date.now() });
  const tool = brainTools(brain, rt);
  let r = await tool('villager-moves', { method: 'boat' });
  t.true(r.error);
  t.regex(r.text, /a villager is being led \(trip 3\): the method stays/);
  r = await tool('villager-moves', { forget: WARD_UUID });
  t.true(r.error);
  t.regex(r.text, /is being led \(trip 3\): it is not let go of mid-way/);
  t.is(peekFetch(mem).method, 'lure');
  r = await tool('villager-moves', {});
  t.false(r.error);
  t.regex(r.text, /^Villagers: moves on, method lure; [^\n]*\nFetch: LEADING \(trip 3, hop 4\)/);
  t.regex(r.text, /\. Do not restart$/);
  // brain-status says it first
  t.regex(brain.status().split('\n')[1], /^A villager is being led \(trip 3, hop 4\): do not restart \(scripts\/safe-restart\.sh waits for it\)\.$/);
});

test('the brain\'s looks bring the wards up (R-9): a ward in the lock seen out of it on a whole look is astray (halt, said); a blind look of the lock lowers nothing; a landmark the fetch holds stays known', async (t) => {
  const inLock = ward({ where: 'lock', last: { at: { x: LOCK.inside[0].x + 0.5, y: 63, z: LOCK.inside[0].z + 0.5 }, t: T0 - HOUR, tod: 8600, health: 17, profession: 'none' } });
  const lift = { id: 2, trip: 3, k: 'lift' as const, at: { ...SMITHING }, block: 'minecraft:smithing_table', item: 'smithing_table', st: 'done' as const, why: 'job site' as const, t: T0 - HOUR };
  const lure = { id: 3, trip: 3, k: 'lure' as const, at: { x: -550, y: 63, z: 2160 }, item: 'fletching_table', st: 'down' as const, role: 'yard' as const, t: T0 };
  const w = world({ fetch: lureRecord({ wards: [inLock], journal: [lift, lure], nextId: 4 }) });
  w.landmarks = { chests: [], farmland: [], smithing: { ...SMITHING } };
  const seen: Seen[] = [{ id: 40, uuid: WARD_UUID, name: 'villager', position: { x: -545.5, y: 63, z: 2150.5 }, profession: 'none', health: 17 } as Seen];
  // the lock's cells read null: a blind look
  const blind = new Map<string, string | null>(LOCK.inside.flatMap(c => [[`${c.x},${c.y},${c.z}`, null], [`${c.x},${c.y + 1},${c.z}`, null]] as [string, null][]));
  blind.set(`${lure.at.x},${lure.at.y},${lure.at.z}`, 'minecraft:fletching_table');
  let b = await brainIn(w, { blocks: blind, entities: () => seen });
  b.world.landmarks.foundAt = 0;
  await b.brain.tick();
  t.like(peekFetch(b.world).wards[0], { where: 'lock', last: { at: { x: -545.5, z: 2150.5 } } }, 'seen and noted, not lowered');
  t.is(peekFetch(b.world).halt, undefined);
  t.deepEqual(b.world.landmarks.smithing, SMITHING, 'the lifted table stays known where it goes back');
  t.is(b.world.landmarks.fletching, undefined, 'the lure in the yard is no landmark');
  // a whole look: astray, halt, said
  b = await brainIn(w, { entities: () => seen });
  b.world.landmarks.foundAt = 0;
  await b.brain.tick();
  t.like(peekFetch(b.world).wards[0], { where: 'astray', note: 'out of the lock: seen at (-546, 63, 2150)' });
  t.regex(peekFetch(b.world).halt!.why, /^ward ffeeb80c is astray/);
  t.regex(b.brain.status(), /villagers: ward ffeeb80c now astray: out of the lock: seen at \(-546, 63, 2150\)/);
  // without the lift on the journal the scan drops it as before
  const bare = world({ fetch: lureRecord() });
  bare.landmarks = { chests: [], farmland: [], smithing: { ...SMITHING } };
  b = await brainIn(bare);
  b.world.landmarks.foundAt = 0;
  await b.brain.tick();
  t.is(b.world.landmarks.smithing, undefined);
  // a ward someone took is off the wards, and said
  const named = { ...seen[0], named: true, customName: 'Bob' } as Seen;
  b = await brainIn(world({ fetch: lureRecord({ wards: [ward()] }) }), { entities: () => [named] });
  b.world.landmarks.foundAt = 0;
  await b.brain.tick();
  t.deepEqual(peekFetch(b.world).wards, []);
  t.regex(b.brain.status(), /villagers: ward ffeeb80c taken by someone \(named "Bob"\)/);
});

test('the brain\'s looks make no fetch record for a world without one, and the Fetch: line names a player seen lately (F9)', async (t) => {
  const b = await brainIn(world(), { entities: () => [{ id: 9, uuid: WARD_UUID, name: 'villager', position: { x: -545.5, y: 63, z: 2150.5 } } as Seen] });
  b.world.landmarks.foundAt = 0;
  await b.brain.tick();
  t.is(b.world.fetch, undefined);
  t.notRegex(b.brain.status(), /Fetch:/);
  const w = world({ fetch: lureRecord({ wards: [ward({ where: 'astray' })] }) });
  w.villages!.players = [{ x: -500, y: 64, z: 2100, at: T0 - 2 * MINUTE }];
  t.regex(fetchLine(w, T0, [], ['a player seen at (-500, 2100) 2 min ago']), /\(a player seen at \(-500, 2100\) 2 min ago is online: a real night\)/);
  const c = await brainIn(w);
  t.regex(c.brain.status(), /\(a player seen at \(-500, 2100\) 2 min ago is online: a real night\)/);
});

test('the rung\'s run under the lure: a boat\'s move chosen before the switch is not made, and a bring whose trip is no longer prepared is untried; neither walks', async (t) => {
  const w = world({ fetch: lureRecord() });
  const calls: string[] = [];
  const ctx = {
    s: look(23_600), world: w, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined, save: () => undefined,
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, timeOfDay: 23_600, dimension: 'overworld' }),
    call: async (m: string) => { calls.push(m); return {}; }, act: async (tool: string) => { calls.push(tool); return { ok: true, text: '' }; }
  } as unknown as Parameters<WorkTask['run']>[0];
  let r = await villagersTask.run(ctx, 'village -693,2262', 10 * MINUTE, () => T0);
  t.like(r, { gain: 0, mark: 'forget', text: '[village -693,2262] the boat\'s move is not made under the lure (method lure)' });
  r = await villagersTask.run(ctx, 'bring:village -693,2262', 10 * MINUTE, () => T0);
  t.like(r, { gain: 0, untried: true, text: 'no trip prepared for village -693,2262 any more' });
  t.deepEqual(calls, ['world.entities', 'world.entities'], 'the hall counted, nothing else');
});

// ------------------------------------------------------------------------------------------------ the rung's runs on the pasture (S1 integration)

/** The live homestead on the pasture (tests/helpers/pasture.ts) with the lure armed, the west lawn's village judged free and counted, three unemployed adults by its bell. */
function pastureHome(o: { dry?: boolean } = {}): { p: Pasture; site: VillageSite } {
  const p = yard({ crossings: false, tod: 10_000 });
  const now = p.now(), bell = { x: -720, y: 63, z: 2128 };
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 1, journal: [], wards: [], nextId: 1, ...(o.dry ? { dry: true } : {}) } as FetchMemory;
  const site: VillageSite = {
    x: bell.x, y: bell.y, z: bell.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: now, area: { x1: -750, z1: 2098, x2: -690, z2: 2158 },
    judged: { at: now, kind: 'free', why: '7 villagers, 3 unemployed adult(s) to take', v: JUDGE_V }, whole: { at: now, villagers: 7, takes: 1 }
  };
  p.world.villages = { sites: [site], players: [] };
  p.set(bell, 'bell[attachment=floor,facing=north,powered=false]');
  p.set({ x: -553, y: 63, z: 2127 }, 'lectern[facing=south,has_book=false,powered=false]');
  p.mine({ x: -553, y: 63, z: 2127 });
  p.villager({ at: { x: -552, y: 63, z: 2128 }, mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  for (let i = 0; i < 3; i++) p.villager({ at: { x: bell.x + 4 + 3 * i, y: 63, z: bell.z + 2 * i }, mind: 'game', id: 200 + i, bell: { ...bell } });
  return { p, site };
}

test('the rung\'s bring with the dry switch on (rollout step 3): a trip prepared before the switch is made dry first, and fetchRun\'s dry run plans and dumps and places and digs nothing; the record keeps the switch', async (t) => {
  const { p } = pastureHome();
  const r0 = await prep(p.ctx, p.clock);
  t.true(r0.prepared, r0.text);
  t.falsy(peekFetch(p.world).trip?.dry, 'prepared for real');
  // the lead turns dry on by hand (no tool: the record's field), before the dawn
  fetchOf(p.world).dry = true;
  p.advance(((23_600 - p.tod) % 24_000 + 24_000) % 24_000);
  const s = p.look();
  const variant = villagersTask.variants(s, p.world).map(v => v.id)[0];
  t.is(variant, 'bring:village -720,2128');
  t.is(villagersTask.ready(s, p.world, variant), null);
  const from = p.log.length;
  const r = await villagersTask.run(p.ctx, variant, 10 * MINUTE, () => p.now());
  t.regex(r.text, /^dry run at \(-720, 63, 2128\): \d+ hop\(s\) planned, the corridor \d+ cells$/);
  t.is(r.mark, 'same');
  t.false(p.log.slice(from).some(e => e.name === 'place' || e.name === 'dig.here' || e.name === 'gates.hold'), 'nothing placed, dug or held');
  t.true(p.dumps.some(d => d.name === 'fetch-dry'));
  const f = peekFetch(p.world);
  t.true(f.dry, 'the switch stays on');
  t.true(dryNext(p.world));
  t.true(f.trip === undefined || f.trip.state === 'restore', 'the dry trip ended');
  const site = p.world.villages!.sites[0];
  t.true(site.fetch?.ok === true && (site.fetch.pathLen ?? 0) > 0, JSON.stringify(site.fetch));
});

test('the rung\'s look (a `look:` variant, as far as the pasture allows): out by the gate toward the village, a look round it, nothing placed or dug and no trip made; what came of it is counted (fetch.why.look) and the village\'s word kept', async (t) => {
  const { p, site } = pastureHome();
  // no count for the floor yet: the rung offers a whole look, not a trip
  delete site.whole;
  fetchOf(p.world).shells = { at: p.now(), lock: [], ring: [] };
  p.advance(((1_000 - p.tod) % 24_000 + 24_000) % 24_000);
  const s = p.look();
  const ids0 = villagersTask.variants(s, p.world).map(v => v.id);
  t.is(ids0[0], 'look:village -720,2128', ids0.join(', '));
  const r = await villagersTask.run(p.ctx, 'look:village -720,2128', 10 * MINUTE, () => p.now());
  t.regex(r.text, /village at \(-720, 63, 2128\)/);
  // (the pasture's look reads no chunk whole: the judge waits, and under the lure the wait word is counted, A4)
  const kept = p.world.villages!.sites[0].judged;
  t.like(kept, { kind: 'wait', n: 1 });
  t.true(kept!.at >= p.now() - 10 * MINUTE, 'the word of this look');
  t.true(p.walks.some(w => w.to.x < -650), 'walked out toward the village');
  t.false(p.log.some(e => e.name === 'place' || e.name === 'dig.here' || e.name === 'gates.hold'), 'nothing placed, dug or held');
  const f = peekFetch(p.world);
  t.is(f.trip, undefined, 'no trip made');
  t.deepEqual(f.journal, []);
  t.true(f.why?.look !== undefined || /ready to prepare/.test(r.text), JSON.stringify(f.why));
});
