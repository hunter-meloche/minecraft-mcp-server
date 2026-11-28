import test, { type ExecutionContext } from 'ava';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  ASTRAY_HOLD, ASTRAY_NEAR, BEAT_LIVE, FRESH_FREE, GAME_DAY, HOLD_MS, IN_BY, SESSION, beat, clock, cutTrip, dropEntry, endTrip, fetchLine, fetchOf, fetchSafe, floorOk, heldByFetch,
  inHallOrLock, journal, journalItems, liftedFor, need, needLeft, needMs, needParts, needTerms, newTrip, noteWhy, openByDesign, peekFetch, placeGuard, reconcile,
  restoreAll, restoreOrder, settle, startLate, startNeed, tripLive, tripTo, undo, wardOut, wardSeen, type Change, type FetchMemory, type Looked, type NeedParts, type Trip,
  type TripState, type Ward
} from '../../src/client/brain/fetch.js';
import { liveCritical, out } from '../../src/client/brain/pockets.js';
import { strictSet } from '../../src/client/brain/yardgates.js';
import { idOf, isOpen, key, yard, type Pasture } from '../helpers/pasture.js';

/**
 * The fetch's records (fetch.ts; idle-plan V sections 2-4) over the live homestead's numbers: the hall 11 x 9
 * at (-561, 62, 2126) with its gate H (-556, 63, 2134); the lock in front of it as the blueprint has it (six inside
 * cells x -557..-555, z 2135..2136, its gate P (-556, 63, 2137), the socket (-554, 63, 2135), the bot's post
 * (-553, 63, 2136), the last lure's spot outside (-554, 63, 2139)); the workshop's smithing table (-541, 63, 2153),
 * which took a villager three times; the first lure's place in the west village (-675, 71, 2249). S0's half first (the
 * shapes, the journal's write, what the brain asks, the status line); then S1's: the clock, the trip's moves, the wards
 * seen, and the undo of every kind, the last on the pasture (the "F" rows of section 7, named in the titles).
 */

const T0 = Date.UTC(2026, 10, 24, 15, 0, 0);
const H: Pos = { x: -556, y: 63, z: 2134 }, P: Pos = { x: -556, y: 63, z: 2137 };
const SOCKET: Pos = { x: -554, y: 63, z: 2135 }, POST: Pos = { x: -553, y: 63, z: 2136 }, SOUT: Pos = { x: -554, y: 63, z: 2139 };
const SMITHING: Pos = { x: -541, y: 63, z: 2153 }, L0: Pos = { x: -675, y: 71, z: 2249 }, SOUTH: Pos = { x: -549, y: 63, z: 2215 };
const INSIDE: Pos[] = [-557, -556, -555].flatMap(x => [2135, 2136].map(z => ({ x, y: 63, z })));
const UUID = '3f2a9c1e-0b7d-4e55-9a10-6c2f8d4471aa';

function world(fetch?: unknown, lock = true): WorldMemory {
  return {
    landmarks: { chests: [], farmland: [], bed: { x: -537, y: 63, z: 2193 } }, leash: 96, yard: { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 },
    zones: {
      hall: [{ x: -561, y: 62, z: 2126, width: 11, length: 9 }], 'hall:gate': [{ ...H }], 'workshop:smithing': [{ ...SMITHING }], 'workshop:stand': [{ x: -543, y: 63, z: 2151 }],
      // (the footprint's reservation is written before the build, the landmarks once it stands)
      lock: [{ x: -559, y: 62, z: 2134, width: 7, length: 5 }],
      ...(lock ? { 'lock:inside': INSIDE.map(c => ({ ...c })), 'lock:gate': [{ ...P }], 'lock:socket': [{ ...SOCKET }], 'lock:post': [{ ...POST }], 'lock:sout': [{ ...SOUT }] } : {})
    },
    ...(fetch === undefined ? {} : { fetch })
  } as WorldMemory;
}
const lift = (id: number, at = SMITHING, item = 'smithing_table'): Change => ({ k: 'lift', id, trip: 7, at, block: item, item, st: 'done', why: 'job site', t: T0 });
const lure = (id: number, at: Pos, over: Partial<Extract<Change, { k: 'lure' }>> = {}): Change => ({ k: 'lure', id, trip: 7, at, item: 'fletching_table', st: 'down', role: 'hop', t: T0, ...over });
const way = { at: SOUTH, side: 'south' as const, inner: { ...SOUTH, z: 2214 }, outer: { ...SOUTH, z: 2216 }, yard: 31 };
const trip = (state: TripState, over: Partial<Trip> = {}): Trip => ({
  id: 7, kind: 'bring', site: '-693,2262', state, beat: T0, prep: {}, gate: way, spare: [], lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 }, ...over
});
const ward = (where: Ward['where'], over: Partial<Ward> = {}): Ward => ({
  key: UUID, uuid: UUID, from: { site: '-693,2262', at: L0 }, since: T0, bell: true, where, last: { at: { x: -610, y: 68, z: 2231 }, t: T0, tod: 6120, health: 17, profession: 'fletcher' }, health0: 17, ...over
});
const mem = (over: Partial<FetchMemory> = {}): FetchMemory => ({ v: 1, journal: [], wards: [], nextId: 1, ...over });

test('the sanitizer: an absent record is made whole and empty; a sound one is kept as it is, the same object and the same entries every time', (t) => {
  const fresh = world();
  t.deepEqual(fetchOf(fresh), { v: 1, journal: [], wards: [], nextId: 1 });
  t.is(fetchOf(fresh), fresh.fetch!);
  const entry = lure(4, L0), w = world(mem({ method: 'lure', armed: 1, journal: [entry], wards: [ward('led')], trip: trip('hop'), nextId: 2 }));
  const f = fetchOf(w), list = f.journal;
  t.is(fetchOf(w), f);
  t.is(f.journal, list);
  t.is(f.journal[0], entry);
  t.is(f.trip?.state, 'hop');
  t.is(f.halt, undefined);
  // (ids are never given twice: over every entry's and the trip's, whatever the file says)
  t.is(f.nextId, 8);
});

test('the sanitizer: a malformed journal entry, ward or trip is dropped and said (halt, in the status line); the rest that is malformed is dropped silently', (t) => {
  const raw = {
    v: 3, method: 'cart', armed: 'yes', nextId: 'x', gates: { at: T0, open: [{ x: 1 }], leftOpen: [] }, shells: { at: T0, lock: 'ready' }, why: { prep: { n: 2 } }, last: { text: 5 },
    journal: [lift(1), { k: 'lure', id: 2, trip: 7, item: 'fletching_table', st: 'down', role: 'hop', t: T0 }, { k: 'rail', id: 3, trip: 7, at: L0, t: T0 }, 'x', lure(5, L0, { role: 'night' as never })],
    wards: [ward('lock'), { ...ward('led'), last: { at: 'gone' } }], trip: { ...trip('hop'), state: 'attend' }
  };
  const w = world(structuredClone(raw));
  const seen = peekFetch(w);
  // the peek is a copy: nothing written, and nothing of the world in it
  t.deepEqual(w.fetch as unknown, raw);
  seen.journal[0].at.x = 0;
  t.is(((w.fetch as unknown as typeof raw).journal[0] as Change).at.x, SMITHING.x);
  const f = fetchOf(w);
  // (a label this version does not know is still a block to take up: the entry stays)
  t.deepEqual(f.journal.map(e => e.id), [1, 5]);
  t.deepEqual(f.wards.map(x => x.where), ['lock']);
  t.is(f.trip, undefined);
  t.deepEqual([f.v, f.method, f.armed, f.gates, f.shells, f.why, f.last, f.nextId], [1, undefined, undefined, undefined, undefined, undefined, undefined, 6]);
  t.regex(f.halt?.why ?? '', /^brain\.json: 3 journal entries, 1 ward, the trip could not be read and dropped/);
  t.regex(fetchLine(w, T0), /^Fetch: HALT: brain\.json: 3 journal entries/);
  // said once: made whole, the next read finds nothing more, and the halt stands until the lead clears it
  const at = f.halt!.at;
  t.is(fetchOf(w).halt?.at, at);
  delete f.halt;
  t.is(fetchOf(w).halt, undefined);
  for (const junk of [null, 7, 'x', [1], { journal: 'none', wards: 3 }]) t.deepEqual(peekFetch(world(junk)), mem(), JSON.stringify(junk));
});

test('the sanitizer: the dry switch (villager-moves {dry}) is one field of the record, kept by the made-whole and the peek; anything but true is no switch', (t) => {
  const w = world(mem({ method: 'lure', armed: 1, dry: true }));
  t.true(fetchOf(w).dry);
  t.true(peekFetch(w).dry);
  t.true(fetchOf(w).dry, 'kept in place');
  for (const junk of ['yes', 1, false, null, {}]) t.is(peekFetch(world({ ...mem(), dry: junk })).dry, undefined, JSON.stringify(junk));
  // (a trip's own mark of a PREP whose lifts were only said is a trip's field: kept with it)
  const tr = trip('prep');
  tr.prep.dry = true;
  t.true(peekFetch(world(mem({ trip: tr }))).trip?.prep.dry);
});

test('the sanitizer: a halt that cannot be read is a halt all the same (the switch that stops new trips fails shut), and is written back whole', (t) => {
  // written by hand with no `at` (in S0 the file is the lead's only way to the switch): its own words kept, the time now
  const by = world({ ...mem(), halt: { why: 'the lead: no trips until I have looked' } });
  const before = Date.now();
  t.is(peekFetch(by).halt?.why, 'the lead: no trips until I have looked');
  t.true(peekFetch(by).halt!.at >= before);
  t.is((by.fetch as unknown as { halt: { at?: number } }).halt.at, undefined, 'a peek writes nothing');
  t.regex(fetchLine(by, T0), /^Fetch: HALT: the lead: no trips until I have looked/);
  // made whole it is what is saved, and the same from then on: never deleted from brain.json
  const f = fetchOf(by), at = f.halt!.at;
  t.deepEqual(by.fetch!.halt, { at, why: 'the lead: no trips until I have looked' });
  t.deepEqual(fetchOf(by).halt, { at, why: 'the lead: no trips until I have looked' });
  // a bare `true`, a sentence, a number, a list, an object with nothing in it or with a time and no words: a halt
  const cant = 'brain.json: a halt that could not be read';
  for (const [halt, why, when] of [[true, cant], ['wait for me', 'wait for me'], [1, cant], [0, cant], [[], cant], [{}, cant], [{ at: T0 }, cant, T0], [{ at: 'now', why: 'x' }, 'x'], [{ at: T0, why: 5 }, cant, T0],
    [{ why: ' ' }, cant], ['', cant]] as [unknown, string, number?][]) {
    const got = peekFetch(world({ ...mem(), halt })).halt;
    t.is(got?.why, why, JSON.stringify(halt));
    t.true(when === undefined ? got!.at >= before : got!.at === when, JSON.stringify(halt));
    t.regex(fetchLine(world({ ...mem(), halt }), T0), /^Fetch: HALT: /, JSON.stringify(halt));
  }
  // what says "none" in so many words is none, and a sound one is the object it was
  for (const halt of [undefined, null, false]) t.is(peekFetch(world({ ...mem(), halt })).halt, undefined, String(halt));
  const sound = { at: T0, why: 'stopped at the bell' }, kept = world(mem({ halt: sound }));
  t.is(fetchOf(kept).halt, sound);
  // and it is not overwritten by what else was dropped beside it
  const both = fetchOf(world({ ...mem(), halt: { why: 'mine' }, journal: ['x'] }));
  t.is(both.halt?.why, 'mine');
});

test('journal first: the entry is numbered, pushed and brain.json saved before the act; the reply settles it; dropped, it is off the journal and saved again', (t) => {
  const w = world(), saved: FetchMemory[] = [], log: string[] = [];
  const ctx = { world: w, save: () => { saved.push(structuredClone(w.fetch!)); log.push('save'); } };
  const a = journal(ctx, { k: 'lure', trip: 7, at: L0, item: 'fletching_table', st: 'planned', role: 'village', inVillage: true, t: T0 });
  log.push('place');
  t.deepEqual(log, ['save', 'place']);
  t.deepEqual(saved[0].journal, [{ k: 'lure', id: 1, trip: 7, at: L0, item: 'fletching_table', st: 'planned', role: 'village', inVillage: true, t: T0 }]);
  t.is(saved[0].nextId, 2);
  t.is(fetchOf(w).journal[0], a);
  t.is(settle(a, 'down').st, 'down');
  t.like(fetchOf(w).journal[0], { id: 1, st: 'down' });
  const b = journal(ctx, { k: 'gate', trip: 7, at: P, which: 'lock', until: T0 + 25_000, t: T0 });
  log.push('gates.hold');
  t.deepEqual([b.id, b.which, saved[1].journal.length], [2, 'lock', 2]);
  const list = fetchOf(w).journal;
  dropEntry(ctx, a);
  t.is(fetchOf(w).journal, list);
  t.deepEqual([list.map(e => e.id), saved[2].journal.map(e => e.id), log], [[2], [2], ['save', 'place', 'save', 'gates.hold', 'save']]);
  // a test's context has no save: the entry is written all the same
  t.is(journal({ world: w }, { k: 'drop', trip: 0, at: SOUT, item: 'fletching_table', t: T0 }).id, 3);
});

test('heldByFetch: the cell of every lift, cover and lure, never a gate\'s or a drop\'s; liftedFor a zone whose block is lifted; the lifted items stay carried', (t) => {
  const w = world(mem({
    journal: [lift(1), lure(2, L0), { k: 'cover', id: 3, trip: 0, at: { ...H, z: 2135 }, item: 'dirt', what: 'hall door', st: 'down', t: T0 },
      { k: 'gate', id: 4, trip: 7, at: P, which: 'lock', t: T0 }, { k: 'drop', id: 5, trip: 7, at: SOUT, item: 'fletching_table', t: T0 }, lift(6, SOCKET, 'oak_planks'), lift(7, { ...SMITHING, x: -540 })]
  }));
  t.deepEqual([SMITHING, L0, { ...H, z: 2135 }, SOCKET, P, SOUT, { ...SMITHING, y: 64 }].map(c => heldByFetch(w, c)), [true, true, true, true, false, false, false]);
  t.true(heldByFetch(w, { x: -674.5, y: 71, z: 2249.5 }));
  t.deepEqual(['workshop:smithing', 'workshop:stand', 'lock:socket', 'no:such'].map(z => liftedFor(w, z)), [true, false, true, false]);
  t.deepEqual(journalItems(w), ['smithing_table', 'oak_planks']);
  t.deepEqual([heldByFetch(world(), SMITHING), liftedFor(world(), 'workshop:smithing'), journalItems(world())], [false, false, []]);
});

test('inHallOrLock: the hall\'s box and the lock\'s footprint once it stands; the post, the sill and the lure\'s spot outside are the yard', (t) => {
  const w = world();
  const inside = [{ x: -556, y: 63, z: 2130 }, H, ...INSIDE, P, SOCKET, { x: -558, y: 63, z: 2136 }, { x: -556, y: 65, z: 2136 }, { x: -555.3, y: 63, z: 2135.7 }];
  const outside = [POST, { x: -553, y: 63, z: 2135 }, SOUT, { ...P, z: 2138 }, { x: -559, y: 63, z: 2136 }, SMITHING, { x: -556, y: 30, z: 2136 }];
  t.deepEqual(inside.map(c => inHallOrLock(w, c)), inside.map(() => true));
  t.deepEqual(outside.map(c => inHallOrLock(w, c)), outside.map(() => false));
  // the footprint reserved and nothing built yet: the builder stands there, and it is not the lock
  const before = world(undefined, false);
  t.deepEqual([INSIDE[0], P, H].map(c => inHallOrLock(before, c)), [false, false, true]);
  t.false(inHallOrLock({ landmarks: { chests: [], farmland: [] }, leash: 96 }, H));
});

test('wardOut: a trip from its lifts to its restore, a ward led or in the lock, a ward astray near home for 2 game days and no longer', (t) => {
  const out1 = (f: Partial<FetchMemory>, now = T0) => wardOut(world(mem(f)), now);
  t.false(wardOut(world(), T0));
  t.deepEqual([out1({ trip: trip('prep') }), out1({ trip: trip('prep', { prep: { read: T0, kit: T0 } }) }), out1({ trip: trip('prep', { prep: { lifts: T0 } }) })], [false, false, true]);
  const states: TripState[] = ['out', 'survey', 'first', 'hop', 'gate', 'yardhop', 'lock', 'door', 'restore'];
  t.deepEqual(states.map(s => out1({ trip: trip(s, { prep: { lifts: T0 } }) })), [true, true, true, true, true, true, true, true, false]);
  t.deepEqual((['led', 'lock', 'dead'] as const).map(where => out1({ wards: [ward(where)] }, T0 + 30 * GAME_DAY)), [true, true, false]);
  // astray: last seen 31 from the lock (the yard's), then its two days end, and the lifts may go back
  const near = ward('astray', { last: { at: { x: -590, y: 66, z: 2190 }, t: T0, tod: 8990, health: 17, profession: 'none' } });
  t.is(ASTRAY_HOLD, 2 * GAME_DAY);
  t.deepEqual([0, ASTRAY_HOLD - 1, ASTRAY_HOLD, 9 * GAME_DAY].map(d => out1({ wards: [near] }, T0 + d)), [true, true, false, false]);
  // seen again, the two days run from then (last.t)
  t.true(out1({ wards: [{ ...near, last: { ...near.last, t: T0 + ASTRAY_HOLD } }] }, T0 + ASTRAY_HOLD + 1));
  // in the Nether, or last seen farther than 160 from home (by its village), it holds nothing here
  t.false(out1({ wards: [{ ...near, dim: 'nether' }] }));
  t.deepEqual([ASTRAY_NEAR, ASTRAY_NEAR + 1].map(d => out1({ wards: [{ ...near, last: { ...near.last, at: { x: -537 - d, y: 70, z: 2193 } } }] })), [true, false]);
  // one ward in the hall's lock is enough, whatever the others
  t.true(out1({ wards: [ward('dead'), ward('lock', { key: 'b' })] }));
});

test('placeGuard: while a ward is out no job-site block is put up outside the hall; tripLive: a trip between its first lure and the lock with a beat under 90 s', (t) => {
  const w = world(mem({ wards: [ward('led')] }));
  t.is(placeGuard(w, 'brewing_stand', T0), 'waiting: a villager is on its way');
  t.is(placeGuard(w, 'minecraft:smithing_table', T0, SMITHING), 'waiting: a villager is on its way');
  t.deepEqual([placeGuard(w, 'oak_planks', T0), placeGuard(w, 'crafting_table', T0), placeGuard(w, 'lectern', T0, { x: -553, y: 63, z: 2127 }), placeGuard(world(), 'brewing_stand', T0)],
    [undefined, undefined, undefined, undefined]);
  const live = (s: TripState, age = 0) => tripLive(world(mem({ trip: trip(s) })), T0 + age);
  t.deepEqual((['prep', 'out', 'survey', 'first', 'hop', 'gate', 'yardhop', 'lock', 'door', 'restore'] as const).map(s => live(s)), [false, false, false, true, true, true, true, true, false, false]);
  t.deepEqual([live('hop', BEAT_LIVE - 1), live('hop', BEAT_LIVE), tripLive(world(), T0)], [true, false, false]);
});

test('openByDesign: the hall\'s gate with its journal entry and the lock\'s gate shut in the same read; open with the lock\'s gate, or with no entry, it is left open', (t) => {
  const door: Change = { k: 'gate', id: 1, trip: 7, at: H, which: 'hall', t: T0 };
  const w = (journal: Change[], open: Pos[] | null) => world(mem({ journal, ...(open ? { gates: { at: T0, open, leftOpen: open } } : {}) }));
  t.true(openByDesign(w([door], [H]), H));
  t.deepEqual([openByDesign(w([door], [H, P]), H), openByDesign(w([], [H]), H), openByDesign(w([door], null), H), openByDesign(w([door], [H, SOUTH]), SOUTH), openByDesign(w([door], [P]), P)],
    [false, false, false, false, false]);
  t.false(openByDesign(w([{ ...door, which: 'lock', at: P }], [H]), H));
  // before the lock stands nothing is open by design
  t.false(openByDesign(world(mem({ journal: [door], gates: { at: T0, open: [H], leftOpen: [H] } }), false), H));
});

test('fetchSafe: not while a villager is led, not in a critical section, not with the bot in the hall or the lock; a critical section is live while its run is and its cap lasts', (t) => {
  const idle = world(mem());
  t.deepEqual(fetchSafe(idle, POST, T0), { safe: true });
  t.deepEqual(fetchSafe(idle, undefined, T0), { safe: true });
  t.deepEqual(fetchSafe(world(mem({ trip: trip('hop', { hop: { n: 5, replaced: 0 } }) })), POST, T0), { safe: false, why: 'a villager is being led (trip 7, hop 5)' });
  t.deepEqual(fetchSafe(world(mem({ trip: trip('first') })), POST, T0).why, 'a villager is being led (trip 7, first)');
  t.true(fetchSafe(world(mem({ trip: trip('hop') })), POST, T0 + BEAT_LIVE).safe);
  t.deepEqual([INSIDE[0], P, H].map(c => fetchSafe(idle, c, T0).why), Array(3).fill('the bot stands in the villager hall or its lock'));
  const run = new AbortController();
  try {
    t.is(liveCritical(T0), undefined);
    out.critical = { by: run.signal, until: T0 + 45_000, why: 'gate' };
    t.is(liveCritical(T0)?.why, 'gate');
    t.deepEqual(fetchSafe(idle, POST, T0, liveCritical(T0)), { safe: false, why: 'a villager is at the yard gate' });
    t.is(fetchSafe(idle, POST, T0, { ...out.critical, why: 'hall' }).why, 'the bot is inside the villager hall');
    t.is(liveCritical(T0 + 45_000), undefined);
    run.abort();
    t.is(liveCritical(T0), undefined);
    t.true(fetchSafe(idle, POST, T0, liveCritical(T0)).safe);
  } finally {
    delete out.critical;
  }
});

test('fetchLine in each state: idle, the shells, prepared, leading, in the lock, halted, a lure owed in a village, why no trip ran', (t) => {
  const line = (f: Partial<FetchMemory>, now = T0) => fetchLine(world(mem(f)), now);
  t.is(fetchLine(world(), T0), 'Fetch: boat, not armed; idle; no ward; the lock not read yet; the portal\'s ring not read yet; journal empty');
  t.is(line({ method: 'lure', armed: 1, shells: { at: T0, lock: [], ring: [] }, last: { at: T0, text: 'in the hall: 2 of 3', got: 1 } }),
    'Fetch: lure, armed 1; idle; no ward; lock ready; portal ringed; journal empty; last: in the hall: 2 of 3');
  t.regex(line({ shells: { at: T0, lock: ['a block over the gate at (-556, 64, 2137)', 'the sill is gone'], ring: [], building: 'ring' } }),
    /; the lock: a block over the gate at \(-556, 64, 2137\) \(and 1 more\); the portal's ring being built; /);
  t.is(line({ method: 'lure', armed: 1, trip: trip('prep', { prep: { read: T0, kit: T0, lifts: T0 }, prepared: { at: T0, day: 7 } }), journal: [lift(1)], shells: { at: T0, lock: [], ring: [] } }),
    'Fetch: prepared for village -693,2262: out at dawn by the south gate; no ward; lock ready; portal ringed; out: 1 lift; lifted: smithing_table at (-541, 63, 2153) (back once no villager is out)');
  t.regex(line({ trip: trip('prep', { prep: { read: T0, kit: T0 } }) }), /^Fetch: preparing for village -693,2262 \(done: read, kit\); /);
  const leading = line({ trip: trip('hop', { ward: UUID, hop: { n: 5, replaced: 0 } }), wards: [ward('led')], journal: [lift(1), lure(2, { x: -612, y: 68, z: 2233 }), lure(3, L0, { role: 'pin', inVillage: true })] });
  t.regex(leading, /^Fetch: LEADING \(trip 7, hop 5\) ward 3f2a\.\. fletcher 17\/20 at \(-610, 68, 2231\); /);
  t.regex(leading, /; out: 2 lure, 1 lift; lifted: smithing_table at \(-541, 63, 2153\) \(back once no villager is out\)\. Do not restart$/);
  t.notRegex(leading, /owed|no ward/);
  // the run gone (its beat stale, the handler's cut written): the ward and the pin are said as they stand
  const cut = line({ trip: trip('hop', { ward: UUID, cut: { at: T0, why: 'retreat' } }), wards: [ward('led')], journal: [lure(3, L0, { role: 'pin', inVillage: true, trip: 6 })] }, T0 + BEAT_LIVE);
  t.regex(cut, /^Fetch: trip 7 cut in hop: retreat; ward 3f2a\.\. led, last at \(-610, 68, 2231\); /);
  t.regex(cut, /; owed: a pin in the village at \(-675, 71, 2249\): taken up first thing by day$/);
  const door: Change = { k: 'gate', id: 9, trip: 7, at: H, which: 'hall', t: T0 };
  const inLock = ward('lock', { last: { at: INSIDE[0], t: T0, tod: 8612, health: 17, profession: 'none' } });
  t.regex(line({ trip: trip('door', { ward: UUID }), wards: [inLock], journal: [door, lift(1)], gates: { at: T0, open: [H], leftOpen: [H] } }),
    /^Fetch: trip 7: door; ward 3f2a\.\. in the lock since 8612; H open \(it goes in when it will\); .*; out: 1 lift, 1 gate; lifted: /);
  t.regex(line({ gates: { at: T0, open: [H, SOUTH], leftOpen: [H, SOUTH] } }), /; gate\(s\) left open at \(-556, 63, 2134\), \(-549, 63, 2215\); /);
  // stopped at the bell: the halt first, with what the stop wrote (the player online is the stop's to name); after two days the line asks
  const astray = ward('astray', { last: { at: { x: -590, y: 66, z: 2190 }, t: T0, tod: 8990, health: 17, profession: 'none' }, note: 'stopped at the bell' });
  const halt = { at: T0, why: 'stopped at the bell with the ward at (-590, 66, 2190), 31 from the lock (Hunter3035 is online: a real night)' };
  t.regex(line({ halt, wards: [astray], journal: [lift(1)] }), /^Fetch: HALT: stopped at the bell .*\(Hunter3035 is online: a real night\); boat, not armed; idle; ward 3f2a\.\. astray, last at \(-590, 66, 2190\): stopped at the bell; .*\(back once no villager is out\)$/);
  const asked = line({ halt, wards: [astray], journal: [lift(1)] }, T0 + ASTRAY_HOLD);
  t.true(asked.includes(`: stopped at the bell (2 game days on: its lifts go back and the guards lift; villager-moves {halt:false, arm:1} leads it in by day, {forget:"${UUID}"} lets it go); `), asked);
  t.regex(asked, /; lifted: smithing_table at \(-541, 63, 2153\)$/);
  t.regex(line({ wards: [ward('astray', { dim: 'nether' }), ward('dead', { key: 'b0b0', note: 'a zombie within 8' })] }), /; ward 3f2a\.\. astray in the Nether, last at .*; ward b0b0\.\. dead, last at .*: a zombie within 8; /);
  // why no trip ran: counted by whoever writes it, said here, and at three the line asks the lead
  const why = line({ method: 'lure', armed: 1, why: { prep: { at: T0, n: 3, text: 'a free fletching_table stands in the hall at (-552, 63, 2127)' }, dawn: { at: T0, n: 2, text: '310 s in hand, 346 needed' }, look: { at: T0, n: 1, text: 'no unemployed adult: 3 employed, 1 nitwit' } } });
  t.regex(why, /; not prepared 3 day\(s\): a free fletching_table stands in the hall at \(-552, 63, 2127\) \(the lead\); dawn missed 2 time\(s\): 310 s in hand, 346 needed; no trip after 1 look\(s\): no unemployed adult: 3 employed, 1 nitwit$/);
});

// ------------------------------------------------------------------------------------------------ S1: the clock (4.4)

test('need on the live numbers: the west village (out ~180, the way home ~210, the yard\'s way ~30) is 346 s, term by term; a dry run\'s times are used once known', (t) => {
  const west: NeedParts = { out: 180, toGate: 210, yard: 30 };
  t.is(need(west), 346);
  t.deepEqual(needTerms(west).map(x => x.s), [51, 15, 20, 150, 15, 30, 20, 45]);
  // (the variant's need is the start's: startNeed, below)
  t.is(needMs(west), (366 + 115) * 1000);
  // (6920 ticks: a start by time of day 1780 has the lock's gate shut by 8700)
  t.is(IN_BY - need(west) * 20, 1780);
  t.is(need({ ...west, outS: 47 }), 342);
  // the parts from the records: the walk out from home, the way home stretched by a quarter until a corridor measured it
  const site = { x: -693, z: 2262 }, home = { x: -537, z: 2193 }, outer = { x: -549, z: 2216 };
  const guess = needParts(site, home, outer, 31);
  t.is(Math.round(guess.out), 171);
  t.is(Math.round(guess.toGate), Math.round(1.25 * Math.hypot(144, 46)));
  t.is(guess.outS, undefined);
  const measured = needParts({ ...site, fetch: { at: T0, ok: true, kind: 'late', why: 'dry run', n: 1, pathLen: 207, outS: 52 } }, home, outer, 31);
  t.deepEqual([measured.toGate, measured.outS, measured.yard], [207, 52, 31]);
  // (a hand-written record that is no number is not known)
  t.is(needParts({ ...site, fetch: { pathLen: 'far', outS: -3 } as never }, home, outer, 31).toGate, guess.toGate);
  // what is still to go from a hop: hops to the gate and the gate, hops across the yard, the lock
  t.deepEqual([needLeft(210, 30), needLeft(23, 30), needLeft(0, 30), needLeft(0, 0)], [10 * 15 + 15 + 30 + 20, 30 + 15 + 30 + 20, 30 + 20, 20]);
});

test('the start rule at every 500 ticks of the morning: 346 s fit from the bot\'s dawn to 1780 and not after, and the decline says the seconds', (t) => {
  const s = 346;
  for (let tod = 0; tod <= 12_000; tod += 500) t.is(startLate(tod, s) === undefined, tod <= 1780, String(tod));
  t.is(startLate(1780, s), undefined);
  t.is(startLate(2500, s), 'needs 346 s to have it in the lock by 8700, 310 s left: tomorrow');
  // (the bot's day begins at 23500: the dawn before 0 is the morning's, not the night's)
  t.deepEqual([23_500, 23_999].map(tod => startLate(tod, s)), [undefined, undefined]);
  t.is(startLate(20_000, s), 'needs 346 s to have it in the lock by 8700, 0 s left: tomorrow');
});

test('the start rule and the first hop agree (B2, Nov 25): a trip sets out only with what the first hop\'s rule 3 asks in hand too, so one set out at the limit is not let go at its first hop; and the lock shut by 8700 with the margin still binds a short trip', (t) => {
  const west: NeedParts = { out: 180, toGate: 210, yard: 30 };
  // the walk out, the look and the first lure (86 s), then 1.3 x the 215 s still to go from the first hop
  t.is(needLeft(west.toGate, west.yard), 215);
  t.is(startNeed(west), Math.ceil(86 + 1.3 * 215));
  t.is(startNeed(west), 366);
  const limit = IN_BY - startNeed(west) * 20;
  t.is(limit, 1380);
  t.is(startLate(limit, startNeed(west)), undefined);
  t.regex(startLate(limit + 20, startNeed(west)) ?? '', /^needs 366 s to have it in the lock by 8700, 365 s left: tomorrow$/);
  // set out at the limit and on time to the first hop (86 s later): rule 3 lets it go on; a second later it would not
  const firstHop = (start: number) => clock(start + 86 * 20, needLeft(west.toGate, west.yard), { bell: true }, {});
  t.like(firstHop(limit), { go: 'on', rule: 2 });
  t.like(firstHop(limit + 20), { go: 'release', rule: 3 });
  // (on `need` alone the start was allowed to 1780, whose first hop rule 3 let go: the disagreement B2 found)
  t.is(IN_BY - need(west) * 20, 1780);
  t.like(firstHop(1780), { go: 'release', rule: 3 });
  // a short trip: the 45 s margin of `need` binds, not 1.3 x (P still read shut by 8700 with the margin)
  const near: NeedParts = { out: 40, toGate: 30, yard: 16 };
  t.is(need(near), 171);
  t.true(Math.ceil(11 + 35 + 1.3 * needLeft(near.toGate, near.yard)) < need(near));
  t.is(startNeed(near), need(near));
  // from the village (out 0): the first lure's own rule, on the same terms
  t.is(startNeed({ out: 0, toGate: 210, yard: 30 }), Math.max(need({ out: 0, toGate: 210, yard: 30 }), Math.ceil(35 + 1.3 * 215)));
});

test('the clock\'s five answers: on; release (not committed, short of 1.3 x); run on (committed, late, before the bell); stop at the bell; and a ward whose bell the lead cleared', (t) => {
  const bell = { bell: true }, free = {}, far = { committed: 'far' as const };
  // (2) in time, with 1.3 x in hand when not committed
  t.like(clock(6000, 100, bell, free), { go: 'on', rule: 2, inHandS: 35 });
  t.like(clock(6000, 100, bell, far), { go: 'on', rule: 2, inHandS: 35 });
  // (3) 100 s left fits at 6600 (5 s in hand) but not 1.3 x of it: let go near its village
  t.like(clock(6600, 100, bell, free), { go: 'release', rule: 3, inHandS: 5 });
  t.like(clock(8995, 20, bell, free), { go: 'release', rule: 3 });
  // (4) committed and late: on to the lock while the bell has not come
  t.like(clock(7000, 100, bell, far), { go: 'run on', rule: 4, inHandS: -15 });
  t.like(clock(8989, 30, bell, { committed: 'drop' }), { go: 'run on', rule: 4 });
  // (5) at the bell with the lock's gate not shut
  t.like(clock(8990, 30, bell, far), { go: 'stop', rule: 5 });
  t.regex(clock(9500, 10, bell, far).text, /^the bell \(8990\) came first, committed \(far\)/);
  // (1) no bell: the lock's gate by 11800 with it inside the fence, the bot home by 11000 outside it
  t.like(clock(10_000, 60, { bell: false }, far, { inside: true }), { go: 'on', rule: 1, inHandS: 30 });
  t.like(clock(10_000, 60, { bell: false }, far), { go: 'stop', rule: 1, inHandS: -10 });
  t.like(clock(9000, 60, { bell: false }, free), { go: 'on', rule: 1 });
  // before the first flip there is no ward: the bell's rules
  t.like(clock(1780, 346, undefined, free), { go: 'release', rule: 3 });
  t.like(clock(1000, 250, undefined, free), { go: 'on', rule: 2, inHandS: 135 });
  t.regex(clock(6600, 100, bell, free).text, /100 s left and 5 s in hand: short of 1\.3 x the time left before 8700/);
});

test('a slow server: the time of day decides, not the real time gone (the same seconds left read against the tick at the poll)', (t) => {
  // set out at 1780 and 400 real seconds on: on a server at half speed the time of day is only 5780
  const atPoll = (tod: number) => clock(tod, 120, { bell: true }, { committed: 'far' });
  t.like(atPoll(5780), { go: 'on', inHandS: 26 });
  // at full speed the same 400 s would be 9780: the bell, stopped
  t.like(atPoll(9780), { go: 'stop' });
  // and the seconds left count 20 ticks each: a server that gives fewer errs to the safe side
  t.true(atPoll(8700 - 120 * 20).inHandS === 0);
});

test('the floor from the whole look: the west village 7 seen, 2 taken: 1 take left at the floor of 5; then none; a look over 72 h old or none at all: a whole look first', (t) => {
  t.deepEqual(floorOk({ whole: { at: T0, villagers: 7, takes: 2 } }, T0 + 3_600_000), { ok: true, left: 1, text: '1 take left at the floor of 5' });
  t.deepEqual(floorOk({ whole: { at: T0, villagers: 7, takes: 3 } }, T0), { ok: false, left: 0, text: '7 seen, 3 taken: no take left at the floor of 5' });
  t.deepEqual(floorOk({ whole: { at: T0, villagers: 9, takes: 1 } }, T0), { ok: true, left: 4, text: '4 takes left at the floor of 5' });
  t.like(floorOk({ whole: { at: T0, villagers: 7, takes: 2 } }, T0 + FRESH_FREE + 3_600_000), { ok: false, left: 1, text: 'counted whole 73 h ago: a whole look first' });
  for (const whole of [undefined, { at: T0, villagers: '7', takes: 2 }, { villagers: 7, takes: 2 }, 'seven']) {
    t.like(floorOk({ whole } as never, T0), { ok: false, text: 'not counted whole yet: a whole look first' }, JSON.stringify(whole));
  }
});

test('why is counted while it stays the same: once a game day for PREP and the dawn (the numbers in it aside), once a look for the looks; another reason starts again; none clears', (t) => {
  const w = world(mem()), day = (d: number) => { (w as { idle?: unknown }).idle = { today: { day: d }, days: [] }; };
  day(4);
  t.is(noteWhy(w, 'dawn', '310 s in hand, 346 needed', T0), 1);
  // asked again the same day (the rung asks every tick): not counted again
  t.is(noteWhy(w, 'dawn', '305 s in hand, 346 needed', T0 + 60_000), 1);
  day(5);
  t.is(noteWhy(w, 'dawn', '295 s in hand, 346 needed', T0 + GAME_DAY), 2);
  day(6);
  t.is(noteWhy(w, 'dawn', '290 s in hand, 346 needed', T0 + 2 * GAME_DAY), 3);
  t.regex(fetchLine(w, T0), /; dawn missed 3 time\(s\): 290 s in hand, 346 needed \(the lead\)/);
  // another reason: from 1
  t.is(noteWhy(w, 'dawn', 'it rained', T0 + 2 * GAME_DAY), 1);
  // the looks count each look
  t.deepEqual([1, 2, 3].map(() => noteWhy(w, 'look', 'no unemployed adult: 3 employed, 1 nitwit', T0)), [1, 2, 3]);
  t.is(noteWhy(w, 'look', undefined, T0), 0);
  t.deepEqual(Object.keys(fetchOf(w).why ?? {}), ['dawn']);
  noteWhy(w, 'dawn', undefined, T0);
  t.is(fetchOf(w).why, undefined);
  // with no game day known, a day is a game day's time
  const v = world(mem());
  noteWhy(v, 'prep', 'the lock is not ready: the sill is gone', T0);
  t.deepEqual([noteWhy(v, 'prep', 'the lock is not ready: the sill is gone', T0 + 1000), noteWhy(v, 'prep', 'the lock is not ready: the sill is gone', T0 + GAME_DAY)], [1, 2]);
});

// ------------------------------------------------------------------------------------------------ S1: the trip (2.2)

test('the trip from state to state as 2.2 has it: each move saved before its first act; a move with no row throws; times measured; out stamps began; a move ends a cut', (t) => {
  const w = world(mem({ nextId: 12 })), saved: TripState[] = [];
  const ctx = { world: w, save: () => { saved.push(fetchOf(w).trip?.state ?? 'restore'); } };
  const tr = newTrip(ctx, { site: 'village -693,2262', gate: way }, T0);
  t.like(tr, { id: 12, kind: 'bring', state: 'prep', beat: T0, spare: [], lure: 'fletching_table', counts: { hops: 0, misses: 0, wedges: 0, pins: 0 } });
  t.is(fetchOf(w).nextId, 13);
  t.throws(() => newTrip(ctx, { site: 'x', gate: way }, T0), { message: /^trip 12 is prep: one trip at a time/ });
  const path: TripState[] = ['out', 'survey', 'first', 'hop', 'hop', 'gate', 'hop', 'gate', 'yardhop', 'lock', 'yardhop', 'lock', 'door', 'restore'];
  path.forEach((s, i) => tripTo(ctx, s, T0 + (i + 1) * 10_000, { tod: 1700 }));
  t.deepEqual(saved, ['prep', ...path]);
  t.deepEqual(tr.began, { at: T0 + 10_000, tod: 1700, day: 0 });
  t.deepEqual(tr.times, { out: 10, survey: 10, first: 10, hops: 30, gate: 20, yard: 20, lock: 20, door: 10 });
  // no row in 2.2: refused, and nothing written
  for (const [from, to] of [['prep', 'hop'], ['out', 'lock'], ['hop', 'door'], ['yardhop', 'hop'], ['door', 'lock'], ['restore', 'prep']] as const) {
    const v = world(mem({ trip: trip(from) }));
    t.throws(() => tripTo({ world: v }, to, T0), { message: `trip 7: no way from ${from} to ${to}` }, `${from} -> ${to}`);
    t.is(fetchOf(v).trip?.state, from);
  }
  t.throws(() => tripTo({ world: world(mem()) }, 'out', T0), { message: 'no trip to move on to out' });
  // a cut (the exit handler) and the run going on from it, in the same state
  const v = world(mem({ trip: trip('hop', { hop: { n: 4, replaced: 0 } }) }));
  t.is(cutTrip({ world: v }, 'retreat: a skeleton', T0)?.cut?.why, 'retreat: a skeleton');
  t.like(tripTo({ world: v }, 'hop', T0 + 5000), { state: 'hop', beat: T0 + 5000 });
  t.is(fetchOf(v).trip?.cut, undefined);
  beat(v, T0 + 9000);
  t.is(fetchOf(v).trip?.beat, T0 + 9000);
  // a rescue the lead armed joins at a hop; the end of a trip writes `last` and goes to restore
  const r = world(mem());
  t.like(newTrip({ world: r }, { site: 'village -693,2262', gate: way, state: 'yardhop', ward: UUID }, T0), { kind: 'rescue', state: 'yardhop', ward: UUID });
  endTrip({ world: r }, 'in the hall: 2 of 3', 1, T0 + 60_000);
  t.deepEqual([fetchOf(r).trip?.state, fetchOf(r).last], ['restore', { at: T0 + 60_000, text: 'in the hall: 2 of 3', got: 1 }]);
});

// ------------------------------------------------------------------------------------------------ S1: the wards seen

const row = (over: Partial<Looked> & { position: Pos }): Looked => ({ id: 9001, name: 'villager', uuid: UUID, profession: 'fletcher', level: 1, health: 17, ...over });

test('ids renumbered, the uuid holds: a ward is known by its uuid whatever id the look gives it, its last brought up; another villager with its old id is not it', (t) => {
  const w = world(mem({ wards: [ward('led', { id: 9001, session: SESSION })] }));
  let [s] = wardSeen(w, [row({ position: { x: -612.5, y: 69, z: 2232.5 } })], true, T0 + 1000, { tod: 6200 });
  t.like(s, { by: 'uuid', inLock: false, inHall: false });
  t.deepEqual(fetchOf(w).wards[0].last, { at: { x: -612.5, y: 69, z: 2232.5 }, t: T0 + 1000, tod: 6200, health: 17, profession: 'fletcher' });
  // unloaded and loaded again: a new id, the same uuid; the old id now on someone else
  [s] = wardSeen(w, [row({ id: 9001, uuid: 'another', position: { x: -600, y: 68, z: 2230 } }), row({ id: 9442, position: { x: -615, y: 69, z: 2233 } })], true, T0 + 2000);
  t.like(s, { by: 'uuid' });
  t.like(fetchOf(w).wards[0], { id: 9442, session: SESSION, last: { at: { x: -615, y: 69, z: 2233 } } });
  // a look that does not show it: nothing concluded, nothing changed
  [s] = wardSeen(w, [row({ id: 1, uuid: 'another', position: { x: -600, y: 68, z: 2230 } })], true, T0 + 3000);
  t.deepEqual([s.seen, fetchOf(w).wards[0].where, fetchOf(w).wards[0].last.t], [undefined, 'led', T0 + 2000]);
  // a jar with no uuid: the id, only within the process that read it
  const old = world(mem({ wards: [ward('led', { key: 'at:-612,68,2233@1', uuid: undefined, id: 77, session: SESSION })] }));
  t.like(wardSeen(old, [row({ id: 77, uuid: undefined, position: { x: -620, y: 69, z: 2235 } })], true, T0)[0], { by: 'id' });
  const other = world(mem({ wards: [ward('led', { key: 'at:-612,68,2233@1', uuid: undefined, id: 77, session: 'a brain before' })] }));
  t.is(wardSeen(other, [row({ id: 77, uuid: undefined, position: { x: -620, y: 69, z: 2235 } })], true, T0)[0].seen, undefined);
});

test('a ward taken by someone is dropped: named, on a lead, in a vehicle not the bot\'s (theirs, never contested); in the bot\'s own boat it is still the bot\'s', (t) => {
  const p0 = { x: -600, y: 68, z: 2230 };
  for (const [over, why] of [[{ named: true, customName: 'Bob' }, 'named "Bob"'], [{ leashed: true }, 'on a lead'], [{ vehicleId: 51, vehicle: 'boat' }, 'in a oak_boat not the bot\'s']] as [Partial<Looked>, string][]) {
    const w = world(mem({ wards: [ward('led')] }));
    const [s] = wardSeen(w, [row({ position: p0, ...over }), { id: 51, name: 'oak_boat', position: p0 }], true, T0);
    t.is(s.taken, `taken by someone (${why}) at (-600, 68, 2230): theirs, never contested`, why);
    t.deepEqual(fetchOf(w).wards, []);
  }
  const mine = world(mem({ wards: [ward('led')] }));
  const [s] = wardSeen(mine, [row({ position: p0, vehicleId: 52 }), { id: 52, name: 'oak_boat', own: true, position: p0 }], true, T0);
  t.is(s.taken, undefined);
  t.is(fetchOf(mine).wards.length, 1);
});

test('the fallback skips the hall\'s census: with no uuid, the lure\'s worker nearest it, never a villager in the hall\'s box or its census', (t) => {
  // a ward of a jar with no uuid, led to the last lure outside the lock; the resident (a fletcher) works in the hall
  const key0 = 'at:-554,63,2139@1', resident = { id: 31, profession: 'fletcher', at: { x: -552, y: 63, z: 2133 } };
  const fallback = (rows: Looked[], census = [{ id: 31, baby: false, profession: 'fletcher', level: 4, at: resident.at }]) => {
    const w = world(mem({ trip: trip('yardhop', { ward: key0, beat: T0 }), wards: [ward('led', { key: key0, uuid: undefined })] }));
    (w as { hallChores?: unknown }).hallChores = { census: { at: T0, villagers: census } };
    return { w, s: wardSeen(w, rows, true, T0, { lure: SOUT })[0] };
  };
  const inHall = row({ id: 31, uuid: undefined, position: { x: -551.5, y: 63, z: 2133.5 } });
  const outside = row({ id: 40, uuid: undefined, position: { x: -550.5, y: 63, z: 2141.5 } });
  t.is(fallback([inHall]).s.seen, undefined);
  // (in the census but stepped out of the box: still not taken for the ward)
  t.is(fallback([{ ...inHall, position: { x: -553.5, y: 63, z: 2138.5 } }]).s.seen, undefined);
  const both = fallback([inHall, outside]);
  t.like(both.s, { by: 'near' });
  t.is(both.s.seen?.id, 40);
  t.like(fetchOf(both.w).wards[0], { id: 40, session: SESSION });
  // not the lure's profession, or 9 or more off it: not it
  t.is(fallback([{ ...outside, profession: 'none' }]).s.seen, undefined);
  t.is(fallback([{ ...outside, position: { x: -540.5, y: 63, z: 2141.5 } }]).s.seen, undefined);
  // and once a uuid is given, it is keyed by it, the trip with it
  const rekeyed = fallback([{ ...outside, uuid: UUID }]);
  t.deepEqual([fetchOf(rekeyed.w).wards[0].key, fetchOf(rekeyed.w).wards[0].uuid, fetchOf(rekeyed.w).trip?.ward], [UUID, UUID, UUID]);
});

test('where from the boxes, on whole looks only: in the lock seen in the yard is astray; astray seen in the lock with its gate shut, or in the hall, is in the lock; health 0 is dead; astray\'s two days are not renewed', (t) => {
  const yardCell = { x: -550.5, y: 63, z: 2150.5 }, lockCell = { x: -555.5, y: 63, z: 2135.5 }, hallCell = { x: -553.5, y: 63, z: 2129.5 };
  const seenAt = (where: Ward['where'], position: Pos, whole: boolean, o: { pShut?: boolean; health?: number; trip?: Trip } = {}) => {
    const w = world(mem({ wards: [ward(where)], ...(o.trip ? { trip: o.trip } : {}) }));
    const [s] = wardSeen(w, [row({ position, health: o.health ?? 17 })], whole, T0 + 60_000, { pShut: o.pShut });
    return { s, w: fetchOf(w).wards[0], halt: fetchOf(w).halt?.why };
  };
  const out = seenAt('lock', yardCell, true);
  t.like(out.w, { where: 'astray', note: 'out of the lock: seen at (-551, 63, 2150)', last: { t: T0 + 60_000 } });
  t.is(out.halt, 'ward 3f2a9c1e is astray: out of the lock: seen at (-551, 63, 2150)');
  // a blind look (just after a rejoin) lowers nothing
  t.is(seenAt('lock', yardCell, false).w.where, 'lock');
  t.like(seenAt('lock', lockCell, true), { s: { inLock: true }, w: { where: 'lock' } });
  t.like(seenAt('lock', hallCell, true), { s: { inHall: true }, w: { where: 'lock' } });
  t.like(seenAt('astray', lockCell, true, { pShut: true }).w, { where: 'lock', note: 'seen in the lock, its gate shut' });
  t.is(seenAt('astray', lockCell, true).w.where, 'astray');
  t.like(seenAt('astray', hallCell, true).w, { where: 'lock', note: 'seen in the hall' });
  t.is(seenAt('astray', hallCell, false).w.where, 'astray');
  // led by a live run: the run says when it is in the lock; cut (no live run), the look does
  t.is(seenAt('led', lockCell, true, { pShut: true, trip: trip('lock', { beat: T0 + 59_000 }) }).w.where, 'led');
  t.is(seenAt('led', lockCell, true, { pShut: true, trip: trip('lock', { beat: T0 - BEAT_LIVE }) }).w.where, 'lock');
  t.like(seenAt('led', yardCell, false, { health: 0 }), { w: { where: 'dead', note: 'health read 0 at (-551, 63, 2150)' }, halt: 'ward 3f2a9c1e is dead: health read 0 at (-551, 63, 2150)' });
  t.is(seenAt('astray', lockCell, true, { pShut: true }).halt, undefined);
  t.like(seenAt('dead', yardCell, true).w, { where: 'astray', note: 'seen alive at (-551, 63, 2150)' });
  // astray and seen again daily from home: its two days run on from when it went astray (R-8's end holds)
  const w = world(mem({ wards: [ward('astray', { dim: 'nether', last: { at: { x: -590, y: 66, z: 2190 }, t: T0, tod: 8990, health: 17, profession: 'none' } })] }));
  for (let d = 1; d <= 2; d++) wardSeen(w, [row({ position: { x: -580.5, y: 64, z: 2180.5 }, profession: 'none' })], true, T0 + d * GAME_DAY, { tod: 1000 });
  t.like(fetchOf(w).wards[0], { where: 'astray', last: { at: { x: -580.5, y: 64, z: 2180.5 }, t: T0, tod: 1000 } });
  t.is(fetchOf(w).wards[0].dim, undefined);
  t.false(wardOut(w, T0 + ASTRAY_HOLD));
  t.deepEqual(wardSeen(world(mem()), [row({ position: yardCell })], true, T0), []);
});

// ------------------------------------------------------------------------------------------------ S1: undo, on the pasture

// On the pasture (tests/helpers/pasture.ts: the live yard, its lock and workshop, the bridge's place, dig.here, useOn
// and gate rules ported from the Java, own.put and own.take as tools.ts has them, a kill between any two calls).
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
/** In the yard south of the lock; inside the workshop, by its smithing table; on the lawn, its lure's cell two south. */
const YARD_AT = at(-550, 63, 2145), SHOP_AT = at(-542, 63, 2155), LAWN_AT = at(-550, 63, 2160), LAWN = at(-550, 63, 2162);
const EAST = at(-533, 63, 2183), BY_EAST = at(-536, 63, 2183);
const clockOf = (p: Pasture) => () => p.now();

/** The yard with the strict set, the pair and the guard in the bridge, as the brain sends them at its start. */
async function home(o: Parameters<typeof yard>[0] = {}): Promise<Pasture> {
  const p = yard(o);
  await p.ctx.call('gates.strict', strictSet(p.world) as unknown as Record<string, unknown>);
  return p;
}
/** A lure of the bot's down on the lawn as a hop puts it: the journal first and saved, own.put, the reply settled. */
async function lureDown(p: Pasture, cell = LAWN, over: Partial<Extract<Change, { k: 'lure' }>> = {}): Promise<Change> {
  const e = journal(p.ctx, { k: 'lure', trip: 7, at: cell, item: 'fletching_table', st: 'planned', role: 'hop', t: p.now(), ...over });
  t0((await p.ctx.own!.put(cell, 'fletching_table')).ok);
  settle(e as Extract<Change, { k: 'lure' }>, 'down');
  p.ctx.save!();
  return e;
}
const t0 = (ok: boolean) => { if (!ok) throw new Error('the scenario could not be set up'); };
/** The workshop's smithing table lifted for a trip (dug, its item carried), as PREP's part 3 leaves it. */
function lifted(p: Pasture, carried = true): Change {
  p.set(SMITHING, 'air', 'dug');
  if (carried) p.give('smithing_table');
  const e = journal(p.ctx, { k: 'lift', trip: 7, at: SMITHING, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: p.now() });
  p.ctx.save!();
  return e;
}
/** The yard's east gate held open for a ward, as GATE step 2 leaves it. */
async function heldOpen(p: Pasture): Promise<Change> {
  const e = journal(p.ctx, { k: 'gate', trip: 7, at: EAST, which: 'yard', until: p.now() + HOLD_MS, t: p.now() });
  await p.ctx.call('gates.hold', { ...EAST, ms: HOLD_MS });
  p.swing(EAST, true, 'the bot\'s walk');
  return e;
}
/** LOCK step 2 done: the socket's wall block lifted from the post, the lock's lure in its place. */
async function socketLure(p: Pasture): Promise<Change> {
  const ctx = p.ctx;
  await ctx.call('goto', { ...POST, range: 0, careful: true });
  const wall = journal(ctx, { k: 'lift', trip: 7, at: SOCKET, block: 'oak_planks', item: 'oak_planks', st: 'planned', why: 'socket', t: p.now() });
  t0((await ctx.own!.take(SOCKET, 'oak_planks', { stay: true, pickup: false })).dug);
  settle(wall as Extract<Change, { k: 'lift' }>, 'done');
  const e = journal(ctx, { k: 'lure', trip: 7, at: SOCKET, item: 'fletching_table', st: 'planned', role: 'lock', t: p.now() });
  t0((await ctx.own!.put(SOCKET, 'fletching_table', { stay: true })).ok);
  settle(e as Extract<Change, { k: 'lure' }>, 'down');
  ctx.save!();
  return e;
}

test('the UNDO table, a lure: own.take digs the bot\'s own with dig.here and takes its protection record off; nothing there or a tuft of grass: off the journal; someone\'s block: off the journal, never dug', async (t) => {
  const p = await home({ at: LAWN_AT });
  const e = await lureDown(p);
  t.true(p.protection.has(key(LAWN)));
  const had = p.count('fletching_table');
  t.like(await undo(p.ctx, e, { now: clockOf(p) }), { ok: true, text: 'took up the fletching_table at (-550, 63, 2162)' });
  t.deepEqual([p.get(LAWN), p.protection.has(key(LAWN)), fetchOf(p.world).journal, p.count('fletching_table')], ['air', false, [], had + 1]);
  t.true(p.log.some(x => x.name === 'dig.here' && key(x.params as unknown as Pos) === key(LAWN)));
  t.false(p.log.some(x => x.name === 'dig' || x.params.force !== undefined));
  t.true(p.walks.every(w => w.careful));
  // asked again: gone already, nothing done
  const calls = p.log.length;
  t.deepEqual(await undo(p.ctx, e), { ok: true, text: 'off the journal already' });
  t.is(p.log.length, calls);
  // killed between the record and the place: a tuft of grass in the cell, the record with no block: both go
  const tuft = at(-548, 63, 2162);
  p.set(tuft, 'short_grass');
  p.mine(tuft, '');
  const g = journal(p.ctx, { k: 'lure', trip: 7, at: tuft, item: 'fletching_table', st: 'planned', role: 'hop', t: p.now() });
  t.like(await undo(p.ctx, g, { now: clockOf(p) }), { ok: true, text: 'nothing at (-548, 63, 2162) any more (short_grass): off the journal' });
  t.deepEqual([p.get(tuft), p.protection.has(key(tuft)), fetchOf(p.world).journal.length], ['short_grass', false, 0]);
  // someone broke the lure and set their own block there: theirs now, never dug
  const theirs = at(-552, 63, 2162);
  p.set(theirs, 'cobblestone');
  const c = journal(p.ctx, { k: 'lure', trip: 7, at: theirs, item: 'fletching_table', st: 'down', role: 'anchor', t: p.now() });
  t.like(await undo(p.ctx, c, { now: clockOf(p) }), { ok: true, text: 'cobblestone stands at (-552, 63, 2162) where its fletching_table was: someone\'s now, never dug' });
  t.is(p.get(theirs), 'cobblestone');
  t.false(p.log.some(x => x.name === 'dig.here' && key(x.params as unknown as Pos) === key(theirs)));
});

test('planned, nothing there: dropped (and the record with no block goes); planned, the block there: down; a lift planned with its block standing: nothing was lifted, and with its cell empty: done', async (t) => {
  const p = await home({ at: LAWN_AT });
  const ctx = p.ctx, cell = (x: number) => at(x, 63, 2162);
  // killed between the journal's write and the place: own.put's record before the place, no block
  p.mine(cell(-548), '');
  const none = journal(ctx, { k: 'lure', trip: 7, at: cell(-548), item: 'fletching_table', st: 'planned', role: 'hop', t: p.now() });
  t.is(await reconcile(ctx, none), 'gone');
  t.deepEqual([fetchOf(p.world).journal.length, p.protection.has(key(cell(-548)))], [0, false]);
  // killed between the place and its reply: the block there, the bot's
  p.set(cell(-552), 'fletching_table');
  p.mine(cell(-552));
  const there = journal(ctx, { k: 'lure', trip: 7, at: cell(-552), item: 'fletching_table', st: 'unsure', role: 'village', inVillage: true, t: p.now() });
  t.is(await reconcile(ctx, there), 'down');
  t.like(fetchOf(p.world).journal[0], { id: there.id, st: 'down' });
  t.is(p.get(cell(-552)), 'fletching_table');
  t.false(p.log.some(x => x.name === 'dig.here'));
  // the lifts: killed before the dig, and between the dig and its reply
  const before = journal(ctx, { k: 'lift', trip: 7, at: SMITHING, block: 'smithing_table', item: 'smithing_table', st: 'planned', why: 'job site', t: p.now() });
  t.is(await reconcile(ctx, before), 'gone');
  p.set(SMITHING, 'air', 'dug');
  const after = journal(ctx, { k: 'lift', trip: 7, at: SMITHING, block: 'smithing_table', item: 'smithing_table', st: 'planned', why: 'job site', t: p.now() });
  t.is(await reconcile(ctx, after), 'done');
  t.like(fetchOf(p.world).journal.find(x => x.id === after.id), { st: 'done' });
  t.deepEqual([await reconcile(ctx, after), await reconcile(ctx, { id: 999 })], ['done', 'gone']);
});

/**
 * An undo cut by a kill before each of its calls in turn (kill -9: nothing saved after; `client`: the game client
 * killed with it, back 90 s later), the brain back, and RESTORE run again from brain.json as saved: every one ends
 * with `check` true and the journal empty. Answers how many calls the undo made when nothing cut it.
 */
async function everyKill(t: ExecutionContext, make: () => Promise<{ p: Pasture; e: Change }>, check: (p: Pasture) => boolean, client = false): Promise<number> {
  for (let i = 0; i < 120; i++) {
    const { p, e } = await make();
    const ctx = p.ctx, before = p.world;
    p.restartAt(p.log.length + i, client);
    await undo(ctx, e, { now: clockOf(p) }).catch(() => undefined);
    if (p.world === before) {
      t.true(check(p) && !fetchOf(p.world).journal.length, 'not cut');
      return i;
    }
    if (client) p.advance(120);
    const r = await restoreAll(p.ctx, { now: clockOf(p) });
    t.deepEqual(r.failed, [], `cut before call ${i}`);
    t.true(check(p), `cut before call ${i}`);
    t.deepEqual(fetchOf(p.world).journal, [], `cut before call ${i}`);
  }
  t.fail('the undo never came to an end');
  return -1;
}

test('each kind idempotent, killed at every call of its undo: a lure, a lifted job block, a held gate (with the client killed too) and the lock\'s lure with its wall block all end as they should', async (t) => {
  const lure = await everyKill(t, async () => { const p = await home({ at: LAWN_AT }); return { p, e: await lureDown(p) }; },
    p => p.get(LAWN) === 'air' && !p.protection.has(key(LAWN)));
  const lift = await everyKill(t, async () => { const p = await home({ at: SHOP_AT }); return { p, e: lifted(p) }; },
    p => p.get(SMITHING) === 'smithing_table' && p.protection.get(key(SMITHING)) === 'smithing_table');
  const shut = (p: Pasture) => !isOpen(p.get(EAST));
  const gate = await everyKill(t, async () => { const p = await home({ at: BY_EAST }); const e = await heldOpen(p); p.ctx.save!(); return { p, e }; }, shut);
  await everyKill(t, async () => { const p = await home({ at: BY_EAST }); const e = await heldOpen(p); p.ctx.save!(); return { p, e }; }, shut, true);
  const socket = await everyKill(t, async () => { const p = await home({ at: YARD_AT }); return { p, e: await socketLure(p) }; },
    // (the bot's own again: a kill between the place and own.put's read of it leaves the record with no state, as tools.ts does)
    p => p.get(SOCKET) === 'oak_planks' && p.protection.has(key(SOCKET)) && !isOpen(p.get(P)));
  t.true([lure, lift, gate, socket].every(n => n >= 3), JSON.stringify({ lure, lift, gate, socket }));
});

test('a lifted block is put back with place-block after a careful walk, facing as it stood; one standing again is dropped; a lifted block lost is made again; none to be had: kept, a try counted', async (t) => {
  // a lectern facing north: the placer looks south, so the bot stands two north of the cell and the place turns it to it
  const LEC = at(-550, 63, 2178), p = await home({ at: at(-546, 63, 2181) });
  const lec = journal(p.ctx, { k: 'lift', trip: 7, at: LEC, block: 'lectern[facing=north,has_book=false,powered=false]', item: 'lectern', st: 'done', why: 'job site', t: p.now() });
  p.give('lectern');
  t.like(await undo(p.ctx, lec, { now: clockOf(p) }), { ok: true, text: 'put the lectern at (-550, 63, 2178) back' });
  t.is(idOf(p.get(LEC)), 'lectern');
  t.deepEqual(p.log.find(x => x.name === 'place')?.at, at(-550, 63, 2176));
  t.true(p.log.some(x => x.kind === 'act' && x.name === 'place-block'));
  t.true(p.walks.length > 0 && p.walks.every(w => w.careful) && !p.broke.length);
  t.true(p.protection.has(key(LEC)));
  // standing again (put back by the lead): dropped with no act
  const again = journal(p.ctx, { k: 'lift', trip: 7, at: LEC, block: 'lectern[facing=north]', item: 'lectern', st: 'done', why: 'job site', t: p.now() });
  const acts = p.log.filter(x => x.kind === 'act').length;
  t.like(await undo(p.ctx, again, { now: clockOf(p) }), { ok: true, text: 'the lectern at (-550, 63, 2178) stands again' });
  t.is(p.log.filter(x => x.kind === 'act').length, acts);
  // the bot died overnight with the smithing table in its pockets: made again (2 iron ingots, 4 planks) and put back
  const q = await home({ at: SHOP_AT });
  const e = lifted(q, false);
  q.give('iron_ingot', 2);
  q.on.act['craft-item'] = (a, w) => {
    if (a.outputItem !== 'smithing_table' || !w.take('iron_ingot', 2) || !w.take('oak_planks', 4)) return { ok: false, text: 'missing ingredients' };
    w.give('smithing_table');
    return { ok: true, text: 'Crafted 1 smithing_table' };
  };
  t.like(await undo(q.ctx, e, { now: clockOf(q) }), { ok: true, text: 'put the smithing_table at (-541, 63, 2153) back' });
  t.deepEqual([q.get(SMITHING), q.count('iron_ingot')], ['smithing_table', 0]);
  // nothing to make it of: kept, said, a try counted
  const r = await home({ at: SHOP_AT });
  const none = lifted(r, false);
  const u = await undo(r.ctx, none, { now: clockOf(r) });
  t.like(u, { ok: false, tried: true });
  t.regex(u.text, /^the smithing_table at \(-541, 63, 2153\) not put back: no smithing_table, and none made \(short of /);
  t.like(fetchOf(r.world).journal[0], { id: none.id, tries: 1 });
  t.is(r.get(SMITHING), 'air');
});

test('the lock\'s lure: its gate read shut first, from the post, the lure out and the wall block back in the same act; a held gate: read, shut, its hold let go; one shut already: let go and dropped', async (t) => {
  const p = await home({ at: YARD_AT });
  const e = await socketLure(p);
  await p.ctx.call('goto', { ...YARD_AT, range: 0, careful: true });
  // P left open (someone's click): shut and read shut before the socket is touched
  p.swing(P, true, 'a player');
  const from = p.changed.length, calls = p.log.length;
  t.like(await undo(p.ctx, e, { now: clockOf(p) }), { ok: true, text: 'took the lock\'s lure out of its socket at (-554, 63, 2135) and put the wall block back' });
  const order = p.changed.slice(from).map(c => `${key(c.at)} ${idOf(c.to)}${isOpen(c.to) ? ' open' : ''}`);
  t.true(order.indexOf(`${key(P)} oak_fence_gate`) >= 0 && order.indexOf(`${key(P)} oak_fence_gate`) < order.indexOf(`${key(SOCKET)} air`), order.join('; '));
  t.deepEqual([p.get(SOCKET), fetchOf(p.world).journal], ['oak_planks', []]);
  t.deepEqual(p.log.slice(calls).filter(x => x.name === 'dig.here' || x.name === 'place').map(x => key(x.at)), [key(POST), key(POST)]);
  // the yard's gate held open for a ward
  const q = await home({ at: BY_EAST });
  const g = await heldOpen(q);
  t.like(await undo(q.ctx, g, { now: clockOf(q) }), { ok: true, text: 'shut the yard\'s gate at (-533, 63, 2183)' });
  t.false(isOpen(q.get(EAST)));
  t.true(q.log.some(x => x.name === 'gates.release' && key(x.params as unknown as Pos) === key(EAST)));
  const shutNow = journal(q.ctx, { k: 'gate', trip: 7, at: EAST, which: 'yard', until: q.now(), t: q.now() });
  t.like(await undo(q.ctx, shutNow, { now: clockOf(q) }), { ok: true, text: 'the yard\'s gate at (-533, 63, 2183) reads shut: its hold let go' });
  t.deepEqual(fetchOf(q.world).journal, []);
  // a drop: walked onto within 5 minutes, else forgotten
  const d = journal(q.ctx, { k: 'drop', trip: 7, at: at(-540, 63, 2183), item: 'fletching_table', t: q.now() - 6 * 60_000 });
  t.like(await undo(q.ctx, d, { now: clockOf(q) }), { ok: true, text: 'the fletching_table dropped at (-540, 63, 2183) over 5 minutes ago: forgotten' });
});

test('the UNDO table, a cover: the build\'s plug taken up from where the bot stands, never with a walk of its own (a walk to it from the yard goes through the lock\'s gate)', async (t) => {
  const plug = { ...H, z: H.z + 1 }, p = await home({ at: YARD_AT });
  p.set(plug, 'dirt');
  p.mine(plug);
  const e = journal(p.ctx, { k: 'cover', trip: 0, at: plug, item: 'dirt', what: 'hall door', st: 'down', t: p.now() });
  const walks = p.walks.length;
  const r = await undo(p.ctx, e, { now: clockOf(p) });
  t.like(r, { ok: false, tried: true });
  t.deepEqual([p.walks.length, p.get(plug), fetchOf(p.world).journal.length], [walks, 'dirt', 1]);
  // from inside the lock (as plugOut stands, in by its gate): taken, the record off
  const q = await home({ at: at(-556, 63, 2136) });
  q.set(plug, 'dirt');
  q.mine(plug);
  const c = journal(q.ctx, { k: 'cover', trip: 0, at: plug, item: 'dirt', what: 'hall door', st: 'down', t: q.now() });
  t.like(await undo(q.ctx, c, { now: clockOf(q) }), { ok: true, text: 'took up the dirt at (-556, 63, 2135)' });
  t.deepEqual([q.get(plug), q.protection.has(key(plug)), fetchOf(q.world).journal.length, q.walks.filter(w => !w.careful).length], ['air', false, 0, 0]);
});

test('the restore order (R-3): gates; lures outside the fence, a village\'s first; the other lures (the lock\'s with its socket) and a socket alone; drops; wedge lifts; job-site lifts last and only with no ward out', (t) => {
  const OUT = { x: -600, y: 66, z: 2190 };
  const journalOf: Change[] = [
    { ...lift(1), trip: 6 },
    { k: 'lift', id: 2, trip: 6, at: { x: -544, y: 63, z: 2128 }, block: 'oak_fence', item: 'oak_fence', st: 'done', why: 'wedge', t: T0 },
    { k: 'drop', id: 3, trip: 6, at: SOUT, item: 'fletching_table', t: T0 },
    lure(4, SOUT, { trip: 6, role: 'yard' }),
    lure(5, OUT, { trip: 6, role: 'anchor' }),
    lure(6, L0, { trip: 6, role: 'village', inVillage: true }),
    { k: 'lift', id: 7, trip: 6, at: SOCKET, block: 'oak_planks', item: 'oak_planks', st: 'done', why: 'socket', t: T0 },
    lure(8, SOCKET, { trip: 6, role: 'lock' }),
    { k: 'gate', id: 9, trip: 6, at: SOUTH, which: 'yard', t: T0 },
    { k: 'cover', id: 10, trip: 0, at: { ...H, z: 2135 }, item: 'dirt', what: 'hall door', st: 'down', t: T0 },
    { k: 'gate', id: 11, trip: 0, at: H, which: 'hall', t: T0 },
    lure(12, { x: -620, y: 68, z: 2230 }, { trip: 7, role: 'hop' }),
    { k: 'lift', id: 13, trip: 6, at: { x: -560, y: 63, z: 2190 }, block: 'oak_planks', item: 'oak_planks', st: 'done', why: 'socket', t: T0 }
  ];
  const ids = (f: Partial<FetchMemory>) => { const r = restoreOrder(world(mem({ journal: structuredClone(journalOf), ...f })), T0); return [r.todo.map(e => e.id), r.held.map(e => e.id)]; };
  // nothing under way and no ward out: all of it, the job block last
  t.deepEqual(ids({}), [[9, 6, 5, 12, 4, 8, 13, 3, 2, 1], []]);
  // trip 7 under way: its run holds its hop's lure, and while it leads the job block waits
  t.deepEqual(ids({ trip: trip('hop') }), [[9, 6, 5, 4, 8, 13, 3, 2], [1]]);
  // trip 7 restoring: its own lure too, by where it stands (outside the fence); a ward still led holds the job block
  t.deepEqual(ids({ trip: trip('restore') }), [[9, 6, 5, 12, 4, 8, 13, 3, 2, 1], []]);
  t.deepEqual(ids({ trip: trip('restore'), wards: [ward('led')] })[1], [1]);
  // (8 goes with its socket's wall block 7 in one act; the plug and the hall's gate are care's)
  t.false(ids({})[0].some(i => i === 7 || i === 10 || i === 11));
});

test('lifts wait while a ward is led or in the lock, and go back once it is in the hall; after 2 days astray the lifts go back and the line asks; a trip restoring ends once only held lifts are left', async (t) => {
  const p = await home({ at: SHOP_AT });
  lifted(p);
  const f = fetchOf(p.world), now = clockOf(p);
  for (const where of ['led', 'lock'] as const) {
    f.wards = [ward(where)];
    t.like(await restoreAll(p.ctx, { now }), { undone: 0, held: 1, failed: [], text: 'restored 0; held 1 (a ward is out)' }, where);
    t.is(p.get(SMITHING), 'air');
  }
  t.regex(fetchLine(p.world, p.now()), /; lifted: smithing_table at \(-541, 63, 2153\) \(back once no villager is out\)/);
  // in the hall (off the wards): back
  f.wards = [];
  t.like(await restoreAll(p.ctx, { now }), { undone: 1, held: 0, text: 'restored 1' });
  t.is(p.get(SMITHING), 'smithing_table');
  // astray 31 from the lock: held for 2 game days from when it went astray, then back, and the line asks the lead
  const q = await home({ at: SHOP_AT });
  lifted(q);
  const g = fetchOf(q.world), astray = ward('astray', { last: { at: { x: -590, y: 66, z: 2190 }, t: q.now(), tod: 8990, health: 17, profession: 'none' } });
  g.wards = [astray];
  g.trip = trip('restore', { id: 7 });
  t.like(await restoreAll(q.ctx, { now: clockOf(q) }), { undone: 0, held: 1 });
  // (the trip is over: deleted, its job block held for the ward)
  t.is(fetchOf(q.world).trip, undefined);
  const later = () => q.now() + ASTRAY_HOLD;
  t.regex(fetchLine(q.world, later()), /ward 3f2a\.\. astray, last at \(-590, 66, 2190\) \(2 game days on: its lifts go back and the guards lift; /);
  t.like(await restoreAll(q.ctx, { now: later }), { undone: 1, held: 0 });
  t.is(q.get(SMITHING), 'smithing_table');
  // a trip whose gate does not come undone stays restoring
  const r = await home({ at: SHOP_AT });
  const rf = fetchOf(r.world);
  rf.trip = trip('restore');
  journal(r.ctx, { k: 'gate', trip: 7, at: EAST, which: 'yard', t: r.now() });
  r.on.call['world.region'] = a => (key(a as unknown as Pos) === key(EAST) ? { blocks: [null] } : undefined);
  t.like(await restoreAll(r.ctx, { now: clockOf(r) }), { undone: 0, failed: ['gate at (-533, 63, 2183): the yard\'s gate at (-533, 63, 2183) could not be read'] });
  t.is(fetchOf(r.world).trip?.state, 'restore');
});

test('an entry failing three times is said, never dropped: a lure in a village sets halt; another is kept and said in the line', async (t) => {
  const p = await home({ at: LAWN_AT });
  const e = await lureDown(p, LAWN, { role: 'village', inVillage: true });
  p.on.call['dig.here'] = () => ({ dug: false, reason: 'out of reach or out of sight' });
  for (let n = 1; n <= 3; n++) {
    const r = await undo(p.ctx, e, { now: clockOf(p) });
    t.like(r, { ok: false, tried: true });
    t.like(fetchOf(p.world).journal[0], { id: e.id, tries: n });
    t.is(fetchOf(p.world).halt === undefined, n < 3);
  }
  t.is(p.get(LAWN), 'fletching_table');
  const line = fetchLine(p.world, p.now());
  t.regex(line, /^Fetch: HALT: the lure in the village at \(-550, 63, 2162\) would not come up 3 times \(/);
  t.regex(line, /; owed: a lure in the village at \(-550, 63, 2162\): taken up first thing by day; stuck after 3 tries: lure fletching_table at \(-550, 63, 2162\) \(the lead\)/);
  // a fourth: still kept (R-4)
  await undo(p.ctx, e, { now: clockOf(p) });
  t.like(fetchOf(p.world).journal[0], { id: e.id, tries: 4 });
  // a lift that cannot go back (nothing to make it of): kept, said, no halt
  const q = await home({ at: SHOP_AT });
  const l = lifted(q, false);
  for (let n = 0; n < 3; n++) await restoreAll(q.ctx, { now: clockOf(q) });
  t.is(fetchOf(q.world).halt, undefined);
  t.deepEqual(fetchOf(q.world).journal.map(e => [e.id, e.tries]), [[l.id, 3]]);
  t.regex(fetchLine(q.world, q.now()), /; stuck after 3 tries: lift smithing_table at \(-541, 63, 2153\) \(the lead\)$/);
  // reads that find nothing are no try: a cell not loaded
  const r = await home({ at: LAWN_AT });
  const far = journal(r.ctx, { k: 'lure', trip: 7, at: L0, item: 'fletching_table', st: 'down', role: 'village', inVillage: true, t: r.now() });
  r.on.call.goto = () => ({ arrived: false, at: { ...r.bot.at }, distance: 140 });
  t.like(await undo(r.ctx, far, { now: clockOf(r) }), { ok: false, tried: false, text: 'the fletching_table at (-675, 71, 2249) not taken up: not loaded' });
  t.is(fetchOf(r.world).journal[0].tries, undefined);
});

// ------------------------------------------------------------------------------------------------ S1: the status line

test('the halt line names a player online; a trip prepared says its seconds; a lead says its hops and the clock', (t) => {
  const astray = ward('astray', { last: { at: { x: -590, y: 66, z: 2190 }, t: T0, tod: 8990, health: 17, profession: 'none' }, note: 'stopped at the bell' });
  const halt = { at: T0, why: 'stopped at the bell with the ward at (-590, 66, 2190), 31 from the lock' };
  t.regex(fetchLine(world(mem({ halt, wards: [astray] })), T0, [], ['Hunter3035']),
    /^Fetch: HALT: stopped at the bell with the ward at \(-590, 66, 2190\), 31 from the lock; .*; ward 3f2a\.\. astray, last at \(-590, 66, 2190\): stopped at the bell \(Hunter3035 is online: a real night\); /);
  t.notRegex(fetchLine(world(mem({ halt, wards: [astray] })), T0), /online/);
  t.notRegex(fetchLine(world(mem({ wards: [ward('lock')] })), T0, [], ['Hunter3035']), /online/);
  // prepared, with the village known: the seconds it needs (the walk out from home, the way home stretched)
  const w = world(mem({ trip: trip('prep', { site: 'village -693,2262', prep: { read: T0, kit: T0, lifts: T0 }, prepared: { at: T0, day: 7 } }) }));
  (w as { villages?: unknown }).villages = { sites: [{ x: -693, y: 70, z: 2262, seenAt: T0 }], players: [] };
  const n = need(needParts({ x: -693, z: 2262 }, { x: -537, z: 2193 }, way.outer, way.yard));
  t.regex(fetchLine(w, T0), new RegExp(`^Fetch: prepared for village -693,2262: out at dawn by the south gate \\(needs ${n} s\\); `));
  // leading, the path still to go known: hop n of ~N and the seconds in hand at the ward's last time of day
  const leading = fetchLine(world(mem({ trip: trip('hop', { ward: UUID, hop: { n: 5, replaced: 0 }, path: { toGate: 66, yard: 16 } }), wards: [ward('led')] })), T0);
  t.regex(leading, /^Fetch: LEADING \(trip 7, hop 5 of ~9\) ward 3f2a\.\. fletcher 17\/20 at \(-610, 68, 2231\); in the lock by 8700 \(now 6120: 34 s in hand\); /);
  const late = fetchLine(world(mem({ trip: trip('hop', { ward: UUID, hop: { n: 5, replaced: 0 }, path: { toGate: 66, yard: 16 }, committed: 'far' }), wards: [ward('led', { last: { at: L0, t: T0, tod: 8000, health: 17, profession: 'fletcher' } })] })), T0);
  t.regex(late, /; the clock: run on, committed \(far\) and 60 s late for 8700: on to the lock before the bell \(8990\); /);
});
