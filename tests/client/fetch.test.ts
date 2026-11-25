import test from 'ava';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  ASTRAY_HOLD, ASTRAY_NEAR, BEAT_LIVE, GAME_DAY, dropEntry, fetchLine, fetchOf, fetchSafe, heldByFetch, inHallOrLock, journal, journalItems, liftedFor, openByDesign,
  peekFetch, placeGuard, settle, tripLive, wardOut, type Change, type FetchMemory, type Trip, type TripState, type Ward
} from '../../src/client/brain/fetch.js';
import { liveCritical, out } from '../../src/client/brain/pockets.js';

/**
 * The fetch's records (fetch.ts, its S0 half; idle-plan V section 3) over the live homestead's numbers: the hall 11 x 9
 * at (-561, 62, 2126) with its gate H (-556, 63, 2134); the lock in front of it as the blueprint has it (six inside
 * cells x -557..-555, z 2135..2136, its gate P (-556, 63, 2137), the socket (-554, 63, 2135), the bot's post
 * (-553, 63, 2136), the last lure's spot outside (-554, 63, 2139)); the workshop's smithing table (-541, 63, 2153),
 * which took a villager three times; the first lure's place in the west village (-675, 71, 2249).
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
