import test, { type ExecutionContext } from 'ava';
import type { Pos } from '../../src/client/brain/memory.js';
import type { VillageSite } from '../../src/client/brain/village.js';
import { endTrip, fetchOf, peekFetch, restoreOrder, wardOut, type Change, type FetchMemory, type Trip, type Ward } from '../../src/client/brain/fetch.js';
import { fetchRun, laneWhy, leadOn, prep, prepSite } from '../../src/client/brain/lure.js';
import { Ground } from '../../src/client/brain/boatroute.js';
import { yardWay, type YardGround } from '../../src/client/brain/villagerwalk.js';
import fs from 'fs';
import path from 'path';
import { variantOf } from '../../src/client/brain/village.js';
import { out } from '../../src/client/brain/pockets.js';
import { H, P, SMITHING, YARD_GATES, idOf, isOpen, key, yard, type Entry, type Pasture, type Villager, type YardOpts } from '../helpers/pasture.js';

/**
 * The lure (lure.ts; idle-plan V sections 4.1, 4.3, 4.5, 4.6, 4.8, 4.9; the "L" rows of section 7, named in the
 * titles) on the pasture: the live homestead, a village on the lawn to the west of it with the game's own villagers
 * (tests/helpers/pasture.ts, mind 'game': their job-site claims, walks and schedule as the 26.3 jar has them), the
 * bridge's place, dig.here, useOn and gate rules as ported. Every scenario's call log is held to the invariants of 2.4
 * (INV-1, INV-3..INV-6: `invariants` below), not to the texts.
 */

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const cellOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const SOCKET = at(-554, 63, 2135), SOUT = at(-554, 63, 2139), NORTH = at(-549, 63, 2119);
/** The village on the lawn west of the yard: its bell, its area, its unemployed adults' places. */
const BELL = at(-720, 63, 2128);
const AREA = { x1: -750, z1: 2098, x2: -690, z2: 2158 };

/**
 * The pasture as a trip finds it: moves on, the method the lure, armed once; the village judged free, counted whole; a
 * fletcher at the hall's fletching table. `village`: its bell and area elsewhere (default the lawn's west village).
 */
function homestead(o: YardOpts & { candidates?: number; resident?: boolean; village?: { bell: Pos; area: typeof AREA } } = {}): Pasture {
  const p = yard({ crossings: false, tod: 10_000, ...o });
  const now = p.now(), bell = o.village?.bell ?? BELL;
  p.world.villagerMoves = true;
  p.world.fetch = { v: 1, method: 'lure', armed: 1, journal: [], wards: [], nextId: 1 } as FetchMemory;
  const site: VillageSite = {
    x: bell.x, y: bell.y, z: bell.z, bells: 1, beds: 7, jobs: 3, villagers: 7, seenAt: now, area: { ...(o.village?.area ?? AREA) },
    judged: { at: now, kind: 'free', why: '7 villagers, 3 unemployed adult(s) to take', v: 4 }, whole: { at: now, villagers: 7, takes: 1 }
  };
  p.world.villages = { sites: [site], players: [] };
  p.set(bell, 'bell[attachment=floor,facing=north,powered=false]');
  // the hall's lectern (set by hand in rollout step 2): the free block the arrival takes
  p.set(at(-553, 63, 2127), 'lectern[facing=south,has_book=false,powered=false]');
  p.mine(at(-553, 63, 2127));
  if (o.resident !== false) {
    // the hall's resident fletcher at the hall's fletching table: the only free job block there is its lectern
    p.villager({ at: at(-552, 63, 2128), mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  }
  const n = o.candidates ?? 3;
  for (let i = 0; i < n; i++) p.villager({ at: at(bell.x + 4 + 3 * i, 63, bell.z + 2 * i), mind: 'game', id: 200 + i, bell: { ...bell } });
  watchLock(p);
  return p;
}

/**
 * INV-3's lock, watched tick by tick (the call log cannot show where the villagers stood): every tick P stands open, a
 * villager in the lock's box that is no ward on the records is a breach (`invariants` holds the scenario to none).
 */
const breaches = new WeakMap<Pasture, string[]>();
function watchLock(p: Pasture): void {
  const out: string[] = [];
  breaches.set(p, out);
  const look = () => {
    if (isOpen(p.get(P))) {
      const wards = new Set(((p.world.fetch as FetchMemory | undefined)?.wards ?? []).map(w => w.uuid));
      for (const v of p.villagers) if (!v.dim && inBox(LOCK_BOX, v.position) && !wards.has(v.uuid)) out.push(`tick ${p.tick}: ${v.uuid.slice(0, 8)} in the lock with P open`);
    }
    p.at(p.tick + 1, look);
  };
  p.at(p.tick + 1, look);
}

/** The trip prepared (PREP's three parts, at 10000 the day before) and the clock on to the bot's dawn. */
async function prepared(t: ExecutionContext, p: Pasture, dawn = 23_600): Promise<void> {
  const r = await prep(p.ctx, p.clock);
  t.true(r.prepared, r.text);
  p.advance(((dawn - p.tod) % 24_000 + 24_000) % 24_000);
}

/** The journal as SAVED (what a kill there leaves), by cell. */
const savedJournal = (saved: string): Change[] => ((JSON.parse(saved) as { fetch?: FetchMemory }).fetch?.journal ?? []);
const inBox = (b: { x1: number; z1: number; x2: number; z2: number }, c: { x: number; z: number }) => Math.floor(c.x) >= b.x1 && Math.floor(c.x) <= b.x2 && Math.floor(c.z) >= b.z1 && Math.floor(c.z) <= b.z2;
const LOCK_BOX = { x1: -557, z1: 2135, x2: -555, z2: 2136 };
const HALL_BOX = { x1: -561, z1: 2126, x2: -551, z2: 2134 };
const YARD_BOX = { x1: -565, z1: 2119, x2: -533, z2: 2215 };

/**
 * The invariants of 2.4 on a scenario's call log. INV-1: at every place, dig.here and gates.hold of the fetch's (not a
 * stray's of the lane) the saved brain.json holds the matching journal entry. INV-3: P and H never open together; P
 * never open with a villager in the lock but the ward under a hold; no gate held over 35 s (a hold never released:
 * to its last renewal); no job block of the hall dug; gates.auto never off. INV-4: no lure down outside the fence at
 * 8990 or after for a bell-alive ward; P never opened from 8990. INV-5: from the first lure to P shut the ward took no job site but the trip's lures. INV-6: no chat,
 * no entity.use, no attack on a villager, no `force`, no dig of a block that was not the bot's, no lure on a path block
 * or farmland, only careful walks while a ward is led, nothing of the trip left outside the fence at the end.
 */
function invariants(t: ExecutionContext, p: Pasture, o: { strays?: Pos[]; ward?: string; leftOut?: boolean; bell?: false } = {}): void {
  const strays = new Set((o.strays ?? []).map(key));
  for (const e of p.log) {
    if (e.kind !== 'call') continue;
    const c = { x: Number(e.params.x), y: Number(e.params.y), z: Number(e.params.z) };
    if (e.name === 'place' || e.name === 'dig.here' || e.name === 'gates.hold') {
      if (e.name === 'dig.here' && strays.has(key(c))) continue;
      const j = savedJournal(e.saved);
      const ok = j.some(x => x.at.x === c.x && x.at.y === c.y && x.at.z === c.z);
      // (the lock's sill, the plug and the put-back of a lift go through journal entries too: every fetch act has one)
      t.true(ok, `INV-1: ${e.name} at ${key(c)} (log ${e.i}) with no journal entry saved`);
    }
    if (e.name === 'gates.auto') t.not(e.params.enabled, false, 'INV-3: gates.auto off');
    if (e.name === 'dig.here') {
      t.false(inBox(HALL_BOX, c) && /lectern|fletching|composter/.test(String(e.reply && (e.reply as { block?: string }).block)), 'INV-3: a job block of the hall dug');
      t.falsy(e.params.force, 'INV-6: force');
    }
    if (o.bell !== false && e.name === 'useOn' && c.x === P.x && c.z === P.z && e.tod >= 8990 && e.tod < 12_000) t.fail(`INV-4: P opened at ${e.tod}`);
    t.not(e.name, 'chat', 'INV-6: chat');
    t.not(e.name, 'entity.use', 'INV-6: entity.use');
  }
  for (const e of p.log) if (e.kind === 'act') t.false(/chat|send-chat/.test(e.name), 'INV-6: chat');
  // INV-3: no gate held over 35 s (GATE_IN_GATEWAY_MAX), from its first hold to its release, as the log has them (a
  // second of slack for the release's own call and the read after)
  const holding = new Map<string, Entry>(), lastHold = new Map<string, Entry>();
  for (const e of p.log) {
    if (e.kind !== 'call' || (e.name !== 'gates.hold' && e.name !== 'gates.release')) continue;
    const k = key({ x: Number(e.params.x), y: Number(e.params.y), z: Number(e.params.z) });
    if (e.name === 'gates.hold') { if (!holding.has(k)) holding.set(k, e); lastHold.set(k, e); continue; }
    const from = holding.get(k);
    holding.delete(k);
    if (from) t.true(e.t - from.t <= 36 * 20, `INV-3: the gate at ${k} held ${((e.t - from.t) / 20).toFixed(1)} s (log ${from.i} to ${e.i})`);
  }
  // (a hold never released, the run's end or a kill: from its first hold to its last renewal, the bridge's lapse after)
  for (const [k, from] of holding) {
    const last = lastHold.get(k)!;
    t.true(last.t - from.t <= 36 * 20, `INV-3: the gate at ${k} held ${((last.t - from.t) / 20).toFixed(1)} s and never released (log ${from.i} to ${last.i})`);
  }
  // INV-3: P never open with a villager in the lock but the ward (the lock's watch, tick by tick)
  t.deepEqual(breaches.get(p) ?? [], [], 'INV-3: P open with a villager in the lock that is no ward');
  // INV-4: no lure put down outside the fence for a bell-alive ward from 8990 (to the night)
  if (o.bell !== false) {
    const lures = p.changed.filter(x => x.how === 'placed' && idOf(x.to) === 'fletching_table' && !inBox(YARD_BOX, x.at));
    for (const e of p.log.filter(x => x.kind === 'call' && x.name === 'place' && x.tod >= 8990 && x.tod < 12_000)) {
      const c = { x: Number(e.params.x), y: Number(e.params.y), z: Number(e.params.z) };
      if (lures.some(l => key(l.at) === key(c) && l.t >= e.t)) t.fail(`INV-4: a lure down outside the fence at ${key(c)} at ${e.tod}`);
    }
  }
  // INV-3: P and H never open together; P never open with a villager in the lock but under the ward's hold
  let pOpen = false, hOpen = false;
  for (const c of p.changed) {
    if (key(c.at) === key(P)) pOpen = isOpen(c.to);
    if (key(c.at) === key(H)) hOpen = isOpen(c.to);
    t.false(pOpen && hOpen, `INV-3: P and H open together at tick ${c.t} (${c.how})`);
  }
  // INV-6: every dug cell was the bot's (in the protection store or the journal before the dig); no lure on a path or farmland
  for (const c of p.changed.filter(x => x.how === 'placed' && idOf(x.to) === 'fletching_table')) {
    const under = p.get(at(c.at.x, c.at.y - 1, c.at.z));
    t.false(/dirt_path|farmland/.test(under), `INV-6: a lure on ${under} at ${key(c.at)}`);
  }
  // INV-6: only careful walks while a ward is led
  const firstFlip = p.flips.find(f => idOf(f.profession) === 'fletcher' && (!o.ward || f.uuid === o.ward));
  if (firstFlip) {
    const shut = p.changed.find(c => c.t > firstFlip.t && key(c.at) === key(P) && !isOpen(c.to) && c.how !== 'set');
    for (const w of p.walks.filter(x => x.t >= firstFlip.t && (!shut || x.t <= shut.t))) t.true(w.careful, `INV-6: a plain walk at tick ${w.t} to ${key(w.to)} while a ward was led`);
  }
  // INV-5: the ward took no job site but the trip's lures (and the hall's lectern, from the door)
  if (firstFlip) {
    const lures = new Set(p.changed.filter(c => c.how === 'placed' && idOf(c.to) === 'fletching_table').map(c => key(c.at)));
    for (const c of p.claims.filter(x => x.uuid === firstFlip.uuid && x.kind === 'job' && x.t >= firstFlip.t)) {
      t.true(lures.has(key(c.at)) || inBox(HALL_BOX, c.at), `INV-5: the ward claimed ${key(c.at)} at tick ${c.t}`);
    }
  }
  // INV-6: nothing of the trip left outside the fence at the end (but a pin or a tether, or a kill)
  if (!o.leftOut) {
    const left = (fetchOf(p.world).journal).filter(e => !inBox(YARD_BOX, e.at) && e.k === 'lure' && e.role !== 'pin' && e.role !== 'anchor');
    t.deepEqual(left.map(e => key(e.at)), [], 'INV-6: a lure left outside the fence');
  }
}

/** The bot's dawn on the lawn: the trip from PREP to the hall, the run as the rung runs it. */
async function trip(p: Pasture) {
  const site = p.world.villages!.sites[0];
  return fetchRun(p.ctx, site, p.clock);
}

test('the happy trip: PREP the evening before (the smithing table lifted), out at dawn by the north gate, the first lure, the hops home, the gate, the yard, LOCK, DOOR: a librarian in the hall, every lift back, the journal empty', async (t) => {
  const p = homestead({ candidates: 1 });
  await prepared(t, p);
  const f0 = peekFetch(p.world);
  t.is(f0.trip?.gate.side, 'north');
  t.true(f0.journal.some(e => e.k === 'lift' && key(e.at) === key(SMITHING)), 'the workshop\'s smithing table lifted');
  t.is(idOf(p.get(SMITHING)), 'air');
  const r = await trip(p);
  t.log(p.said.slice(-60).join('\n'));
  t.is(r.gain, 1, r.text);
  const f = peekFetch(p.world);
  t.is(f.trip, undefined);
  t.deepEqual(f.wards, []);
  t.deepEqual(f.journal.filter(e => e.k !== 'drop'), []);
  t.is(idOf(p.get(SMITHING)), 'smithing_table', 'the smithing table back');
  const v = p.villagers.find(x => x.mind === 'game' && x.profession === 'librarian');
  t.truthy(v, 'a librarian');
  t.true(!!v && inBox(HALL_BOX, v.position));
  t.false(isOpen(p.get(H)));
  t.false(isOpen(p.get(P)));
  // E3: the hold on the shut north gate before the bot's walk through it
  const hold = p.log.find(e => e.name === 'gates.hold' && e.params.z === NORTH.z && e.params.x === NORTH.x)!;
  const through = p.walks.find(w => w.t >= hold.t && w.to.z > NORTH.z && w.from.z < NORTH.z);
  t.truthy(hold && through, 'a hold, then the walk in');
  t.false(isOpen(p.changed.filter(c => key(c.at) === key(NORTH) && c.t <= hold.t).at(-1)?.to ?? p.get(NORTH)), 'the gate shut when held');
  // F7: every break of a claimed lure with its villager within 16
  for (const e of p.log.filter(x => x.name === 'dig.here' && x.via === 'own.take')) {
    const c = { x: Number(e.params.x), y: Number(e.params.y), z: Number(e.params.z) };
    const ward = (JSON.parse(e.saved) as { fetch?: FetchMemory }).fetch?.wards?.[0];
    if (!ward || !savedJournal(e.saved).some(j => j.k === 'lure' && key(j.at) === key(c))) continue;
    const by = p.said.some(x => x.includes('broken with the ward') && x.includes(`(${c.x}, ${c.y}, ${c.z})`));
    t.true(by || flat(ward.last.at, c) <= 16 || key(c) === key(SOCKET) || key(c) === key(SOUT), `the lure at ${key(c)} broken with the ward ${Math.round(flat(ward.last.at, c))} off`);
  }
  // E35: in LOCK's order the ward is in the lock in under 10 s
  const timing = p.said.find(x => /^villagers: timing:/.test(x)) ?? '';
  t.true(Number(/lock (\d+)/.exec(timing)?.[1] ?? 99) < 10, timing);
  invariants(t, p);
});

// ------------------------------------------------------------------------------------------------ a trip under way, as the records have it

const NORTH_WAY = { at: { ...NORTH }, side: 'north' as const, inner: at(-549, 63, 2121), outer: at(-549, 63, 2117), yard: 18 };
const WEST_BELL = at(-693, 69, 2262), WEST_BED = at(-699, 76, 2243);

/**
 * A trip already under way (its ward working at a lure of the bot's, the smithing table lifted), as a run or a resume
 * finds the records: `state` hop (outside) or yardhop (in the yard), the ward a game villager fresh from its village.
 */
function led(p: Pasture, o: { at: Pos; lure: Pos; state: 'hop' | 'yardhop'; committed?: 'far' | 'drop'; bell?: boolean; yard?: number; toGate?: number; id?: number; over?: Partial<Villager> }): { v: Villager; ward: Ward; trip: Trip } {
  const now = p.now(), f = fetchOf(p.world);
  p.set(o.lure, 'fletching_table', 'placed');
  p.mine(o.lure);
  p.set(SMITHING, 'air');
  const v = p.villager({ at: o.at, mind: 'game', id: o.id ?? 300, profession: 'fletcher', job: { ...o.lure }, bell: { ...WEST_BELL }, bed: { ...WEST_BED }, ...o.over });
  const site = p.world.villages!.sites[0];
  const ward: Ward = {
    key: v.uuid, uuid: v.uuid, id: v.id, from: { site: variantOf(site), at: { ...BELL } }, since: now, bell: o.bell ?? true, where: 'led',
    last: { at: { ...v.position }, t: now, tod: p.tod, health: 20, profession: 'fletcher' }, health0: 20
  };
  f.journal.push({ k: 'lift', id: 1, trip: 9, at: { ...SMITHING }, block: 'smithing_table', item: 'smithing_table', st: 'done', why: 'job site', t: now },
    { k: 'lure', id: 2, trip: 9, at: { ...o.lure }, item: 'fletching_table', st: 'down', role: o.state === 'hop' ? 'hop' : 'yard', t: now });
  f.wards.push(ward);
  const trip: Trip = {
    id: 9, kind: 'bring', site: variantOf(site), state: o.state, beat: now, entered: now, prep: { read: now, kit: now, lifts: now }, prepared: { at: now, day: 0 },
    gate: { ...NORTH_WAY }, spare: [], lure: 'fletching_table', hop: { n: 4, lure: { ...o.lure }, replaced: 0 }, ward: v.uuid, avoid: [], times: {},
    counts: { hops: 4, misses: 0, wedges: 0, pins: 0 }, path: { toGate: o.toGate ?? 0, yard: o.yard ?? 10 }, ...(o.committed ? { committed: o.committed } : {})
  };
  f.trip = trip;
  f.nextId = 10;
  p.saved = JSON.stringify(p.world);
  return { v, ward, trip };
}
const placedAfter = (p: Pasture, i: number) => p.log.filter(e => e.i >= i && e.name === 'place');

test('the second villager\'s last day replayed (E8): a ward by the hall at 11715, the portal open on Nov 25: under this design no lead is begun at that hour, the table stays lifted, the portal is ringed, and the ward ends stopped with halt, not in the Nether', async (t) => {
  for (const bell of [true, false]) {
    const p = homestead({ tod: 11_715, candidates: 0, at: at(-551, 63, 2146) });
    const { v } = led(p, { at: at(-551, 63, 2150), lure: at(-551, 63, 2149), state: 'yardhop', committed: 'far', bell });
    t.false(isOpen(p.get(p.world.zones!['ring:gate'][0])), 'the portal\'s ring and its gate shut');
    const from = p.log.length;
    const r = await leadOn(p.ctx, p.clock);
    t.is(r.end, 'stopped', r.text);
    t.deepEqual(placedAfter(p, from), [], 'no lure put down at that hour');
    const f = peekFetch(p.world);
    t.truthy(f.halt, 'halt: the lead decides');
    t.is(f.wards[0]?.where, 'astray');
    t.true(f.journal.some(e => e.k === 'lift' && key(e.at) === key(SMITHING)), 'the smithing table stays lifted');
    t.true(wardOut(p.world, p.now()));
    t.true(restoreOrder(p.world, p.now()).held.some(e => key(e.at) === key(SMITHING)), 'held while the ward is out');
    // the night as it came (Nov 25): the bell, then the bed; the ring's gate shut, the portal fenced off
    p.advance(5000);
    t.is(v.dim, undefined, bell ? 'not in the Nether (bell alive)' : 'not in the Nether (bell cleared)');
    t.not(v.profession, 'toolsmith');
    t.is(idOf(p.get(SMITHING)), 'air');
    invariants(t, p, { leftOut: true });
  }
});

test('D14 late and near: released (not committed, short of 1.3 x the time left): the lure up with the ward by it, the ward off the record, the site waits, nothing left out', async (t) => {
  const p = homestead({ tod: 6_000, candidates: 0, at: at(-694, 63, 2121) });
  led(p, { at: at(-700, 63, 2120), lure: at(-700, 63, 2121), state: 'hop', toGate: 160, yard: 18 });
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'released', r.text);
  t.regex(r.text, /^released at .*the clock/);
  const f = peekFetch(p.world);
  t.deepEqual(f.wards, []);
  t.is(f.trip?.state, 'restore');
  t.false(f.journal.some(e => e.k === 'lure'), 'the lure up');
  t.is(p.world.villages!.sites[0].fetch?.kind, 'late');
  t.is(idOf(p.get(at(-700, 63, 2121))), 'air');
  invariants(t, p);
});

test('D14 late and committed: runs on (the waits cut, no hold for a player) and is in the lock before the bell; not in by 8990: stopped, halt (the LAST_P shut on a ward in P\'s cell: the next test)', async (t) => {
  const p = homestead({ tod: 8_500, candidates: 0, at: at(-550, 63, 2134) });
  led(p, { at: at(-550, 63, 2131), lure: at(-550, 63, 2130), state: 'yardhop', committed: 'far' });
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.log(p.said.join('\n'));
  t.true(p.said.some(s => /IN THE LOCK at (8[5-9]\d\d)/.test(s)));
  // the bell first: at 8985 with the ward still by S_out, it is stopped
  const q = homestead({ tod: 8_985, candidates: 0, at: at(-552, 63, 2139) });
  led(q, { at: at(-551, 63, 2141), lure: at(-551, 63, 2140), state: 'yardhop', committed: 'far' });
  const s = await leadOn(q.ctx, q.clock);
  t.is(s.end, 'stopped', s.text);
  t.truthy(peekFetch(q.world).halt);
  invariants(t, q, { leftOut: true });
});

test('D14 (LAST_P): from 8900 P is shut on a ward standing in its cell (it counts as in, as the gate shuts on its feet: F-9), not held open to the cap past the bell', async (t) => {
  const p = homestead({ tod: 8_860, candidates: 0, at: at(-553, 63, 2138) });
  // (it stands in P's cell working at S_out and goes no farther)
  led(p, { at: at(-555.5, 63, 2137.5), lure: SOUT, state: 'yardhop', committed: 'far', over: { mind: 'still' } });
  const r = await leadOn(p.ctx, p.clock);
  t.log(r.text, saidOf(p).join('\n'));
  const todAt = (tick: number) => p.tod - (p.tick - tick);
  const ps = p.changed.filter(c => key(c.at) === key(P));
  const opened = ps.find(c => isOpen(c.to)), shut = ps.find(c => opened && c.t > opened.t && !isOpen(c.to));
  t.truthy(opened && shut, 'P opened, then shut');
  t.log(`P open ${Math.round(todAt(opened!.t))}, shut ${Math.round(todAt(shut!.t))}`);
  // (opened from LAST_P with the ward in its cell: shut at the first poll that sees it there, not held to the bell)
  t.true(todAt(opened!.t) >= 8900, 'P opened from LAST_P');
  t.true(shut!.t - opened!.t <= 60 && todAt(shut!.t) < 8985, `P shut at ${Math.round(todAt(shut!.t))}, ${shut!.t - opened!.t} ticks after it opened: on its feet, before the bell`);
  invariants(t, p, { leftOut: true });
});

// ------------------------------------------------------------------------------------------------ PREP (4.1, B rows)

/** PREP at time of day 10000, as care's row 10 runs it. */
const prepNow = (p: Pasture) => prep(p.ctx, p.clock);

test('B4 no free bed: not prepared (beds must be villagers + 1); B11 a free fletching table in the hall: not prepared, said; nothing lifted, no trip left', async (t) => {
  const p = homestead();
  for (const id of [101, 102]) p.villager({ at: at(-555, 63, 2130 + id - 101), mind: 'still', profession: 'librarian', level: 1, id });
  const r = await prepNow(p);
  t.false(r.ok);
  t.regex(r.text, /no free bed in the hall \(3 beds, 3 villagers\)/);
  t.is(peekFetch(p.world).trip, undefined);
  t.is(peekFetch(p.world).why?.prep?.n, 1);
  t.is(idOf(p.get(SMITHING)), 'smithing_table');
  const q = homestead({ resident: false });
  const s = await prepNow(q);
  t.regex(s.text, /a free fletching_table stands in the hall at \(-552, 63, 2127\): the arrival would be a fletcher/);
  invariants(t, q);
});

test('B5 nothing to make a lure of: not prepared, said; pockets full: not prepared, said; B6 a wall block gone, the ring\'s gate open: not prepared', async (t) => {
  const p = homestead();
  p.take('fletching_table', 4);
  const r = await prepNow(p);
  t.regex(r.text, /no lure block: 4 fletching_table wanted, 0 carried \(4 planks \+ 2 flint each\)/);
  t.is(peekFetch(p.world).trip, undefined, 'nothing lifted: no trip kept');
  t.regex(peekFetch(p.world).why?.prep?.text ?? '', /no lure block/);
  const q = homestead();
  for (let i = 0; i < 26; i++) q.give(`stone_${['button', 'slab', 'stairs', 'wall', 'pressure_plate', 'bricks'][i % 6]}${'x'.repeat(Math.floor(i / 6))}`, 1);
  const s = await prepNow(q);
  t.regex(s.text, /pockets full: \d slots free, 4 wanted/);
  const w = homestead();
  w.set(at(-558, 63, 2136), 'air');
  t.regex((await prepNow(w)).text, /the lock is not ready/);
  const g = homestead();
  g.swing(g.world.zones!['ring:gate'][0], true, 'a player\'s click');
  t.regex((await prepNow(g)).text, /the portal's ring is not ready/);
});

test('B9 a barrel by the way: declined with the place; B10 the yard way shut by a build: declined at home; E22 a new composter is found and lifted, a brewing stand too (E9: with what it holds)', async (t) => {
  const p = homestead();
  p.set(at(-545, 63, 2140), 'barrel[facing=up,open=false]');
  p.mine(at(-545, 63, 2140));
  t.regex((await prepNow(p)).text, /a barrel of the bot's at \(-545, 63, 2140\) by the way in: not lifted \(27 stacks\): move it for good/);
  const q = homestead();
  // two fence lines across the yard (a build's): from no gate a villager's way to the lock
  for (let x = -564; x <= -534; x++) for (const z of [2124, 2141]) q.set(at(x, 63, z), 'oak_fence[east=true,west=true,north=false,south=false,waterlogged=false]');
  t.regex((await prepNow(q)).text, /no villager way from a gate to the lock/);
  const r = homestead();
  for (const [c, b] of [[at(-546, 63, 2142), 'composter[level=0]'], [at(-547, 63, 2160), 'brewing_stand[has_bottle_0=false,has_bottle_1=false,has_bottle_2=false]']] as const) { r.set(c, b); r.mine(c); }
  const done = await prepNow(r);
  t.true(done.prepared, done.text);
  const lifted = peekFetch(r.world).journal.filter(e => e.k === 'lift').map(e => key(e.at)).sort();
  t.deepEqual(lifted, [key(at(-547, 63, 2160)), key(at(-546, 63, 2142)), key(SMITHING)].sort());
  t.is(idOf(r.get(at(-546, 63, 2142))), 'air');
  t.is(idOf(r.get(at(-547, 63, 2160))), 'air');
  t.true(r.count('brewing_stand') >= 1 && r.count('composter') >= 1, 'carried until they go back');
  invariants(t, r);
});

test('E1 cobblestone at head height in the lane: cleared first (the bot\'s own stray), then prepared; a stone block of no one\'s in the lane: not that gate', async (t) => {
  const p = homestead();
  const stray = at(-549, 64, 2118);
  p.set(stray, 'cobblestone');
  const r = await prepNow(p);
  t.true(r.prepared, r.text);
  t.is(idOf(p.get(stray)), 'air');
  t.is(peekFetch(p.world).trip?.gate.side, 'north');
  t.true(p.said.some(s => /the cobblestone in the north gate's lane at \(-549, 64, 2118\) dug/.test(s)));
  invariants(t, p, { strays: [stray] });
  const q = homestead();
  q.set(at(-549, 63, 2122), 'stone');
  const s = await prepNow(q);
  t.true(s.prepared, s.text);
  t.not(peekFetch(q.world).trip?.gate.side, 'north', 'another gate');
});

test('B15 PREP cut after the kit goes on from the lifts (the reads and the kit before 9000, the lifts at 9500, nothing read twice); cut inside the lifts: not prepared, finished at dawn', async (t) => {
  const p = homestead({ tod: 7_000 });
  const r = await prepNow(p);
  t.true(r.ok && !r.prepared, r.text);
  t.regex(r.text, /read and kit done; the lifts from 9000/);
  const trip = peekFetch(p.world).trip!;
  t.true(Number.isFinite(trip.prep.read) && Number.isFinite(trip.prep.kit) && trip.prep.lifts === undefined);
  t.is(idOf(p.get(SMITHING)), 'smithing_table', 'no lift before 9000');
  p.advance(2500);
  const from = p.log.length;
  const s = await prepNow(p);
  t.true(s.prepared, s.text);
  t.false(p.log.slice(from).some(e => e.name === 'world.entities' && e.params.type === 'villager'), 'the hall not read again');
  t.is(idOf(p.get(SMITHING)), 'air');
  // the lifts cut by a kill inside them: the read and kit stand, and at dawn the lifts are finished (the trip still fits)
  const q = homestead({ tod: 12_000 });
  await prep(q.ctx, q.clock).then(x => t.true(x.prepared, x.text));
  const f = fetchOf(q.world);
  delete f.trip!.prepared;
  delete f.trip!.prep.lifts;
  f.journal = [];
  q.set(SMITHING, 'smithing_table');
  q.mine(SMITHING);
  q.advance(11_600);
  const u = await prep(q.ctx, q.clock);
  t.true(u.prepared, u.text);
});

test('prepSite (the one choice: villagemove.ts lureSite): the free village whose word will still be fresh at 9000 tomorrow, a take left at the floor, the morning enough, its wait over; else why none', (t) => {
  const p = homestead();
  const s = { now: p.now(), timeOfDay: 10_000, home: { x: -549, z: 2183 }, position: at(-549, 63, 2183) };
  // (from the records: the lock and the ring as last read; PREP reads them first)
  t.regex(String((prepSite(s, p.world) as { why: string }).why), /the lock and the portal's ring not read yet/);
  fetchOf(p.world).shells = { at: p.now(), lock: [], ring: [] };
  const r = prepSite(s, p.world);
  t.true('site' in r && r.site.x === BELL.x, JSON.stringify(r));
  p.world.villages!.sites[0].whole = { at: p.now(), villagers: 7, takes: 3 };
  t.regex(String((prepSite(s, p.world) as { why: string }).why), /no take left at the floor of 5/);
  p.world.villages!.sites[0].whole = { at: p.now(), villagers: 7, takes: 1 };
  p.world.villages!.sites[0].judged!.at = p.now() - 71.9 * 3_600_000;
  t.regex(String((prepSite(s, p.world) as { why: string }).why), /will be over 72 h old by the trip: a whole look first/);
  p.world.villages!.sites[0].judged!.at = p.now();
  // (village.ts fetchWait, the one wait table: no claim 6 h doubling, so 12 h at the second)
  p.world.villages!.sites[0].fetch = { at: p.now(), ok: false, kind: 'no claim', why: 'nobody came', n: 2 };
  t.regex(String((prepSite(s, p.world) as { why: string }).why), /waits 12 h more \(no claim: nobody came\)/);
  p.world.villages!.sites[0].fetch = { at: p.now() - 12 * 3_600_000, ok: false, kind: 'no claim', why: 'nobody came', n: 2 };
  t.true('site' in prepSite(s, p.world), 'its wait over');
  // (no unemployed adult: 24 h, never doubling; a dry run's measure waits not at all)
  p.world.villages!.sites[0].fetch = { at: p.now() - 23 * 3_600_000, ok: false, kind: 'no unemployed', why: '3 employed', n: 5 };
  t.regex(String((prepSite(s, p.world) as { why: string }).why), /waits 1 h more \(no unemployed/);
  p.world.villages!.sites[0].fetch = { at: p.now(), ok: true, kind: 'late', why: 'measured by a dry run', n: 1, pathLen: 200, outS: 50 };
  t.true('site' in prepSite(s, p.world), 'a dry run\'s measure is no wait');
});

// ------------------------------------------------------------------------------------------------ the village (A, B, C rows)

test('A5 no unemployed adult: marked, said, nothing placed (2 employed, a nitwit, a baby); B2 a player at the village: looked only after 60 s, nothing placed', async (t) => {
  const p = homestead({ candidates: 0 });
  for (const [i, over] of ([[0, { profession: 'farmer' }], [1, { profession: 'farmer' }], [2, { profession: 'nitwit' }], [3, { baby: true }]] as [number, Partial<Villager>][])) {
    p.villager({ at: at(BELL.x + 3 + 2 * i, 63, BELL.z + 2), mind: 'still', id: 400 + i, ...over });
  }
  await prepared(t, p);
  const from = p.log.length;
  const r = await trip(p);
  t.true(r.untried, r.text);
  t.regex(r.text, /no usable villager in reach .*2 employed, 1 nitwits, 1 babies/);
  t.is(p.world.villages!.sites[0].fetch?.kind, 'no unemployed');
  t.deepEqual(placedAfter(p, from), []);
  t.is(peekFetch(p.world).trip?.state, 'restore', 'on to RESTORE: the lifts go back');
  invariants(t, p);
  const q = homestead();
  q.animal('player', at(BELL.x + 6, 63, BELL.z + 3));
  await prepared(t, q);
  const f2 = q.log.length;
  const s = await trip(q);
  t.true(s.untried, s.text);
  t.regex(s.text, /looked only at the village: a player at/);
  t.deepEqual(placedAfter(q, f2), []);
});

test('B3 too late at the village: nothing placed (the start fit by a dry run\'s short walk, the village\'s own reckoning does not); B14 dry: no place and no dig in the log, the walk out\'s seconds and the corridor kept', async (t) => {
  const p = homestead();
  p.world.villages!.sites[0].fetch = { at: p.now() - 90 * 3_600_000, ok: true, kind: 'late', why: 'measured', n: 0, outS: 5 };
  // (at 2200 the start fits on the measured 5 s walk out, with the first hop's 1.3 x: fetch.ts startNeed)
  await prepared(t, p, 2_200);
  const from = p.log.length;
  const r = await trip(p);
  t.true(r.untried, r.text);
  t.regex(r.text, /looked only at the village: needs \d+ s to have it in the lock by 8700/);
  t.deepEqual(placedAfter(p, from), []);
  const q = homestead({ tod: 7_000 });
  t.falsy((await prepNow(q)).prepared);
  fetchOf(q.world).trip!.dry = true;
  q.advance(2500);
  const pre = q.log.length;
  t.true((await prepNow(q)).prepared);
  q.advance(((23_600 - q.tod) % 24_000 + 24_000) % 24_000);
  const s = await trip(q);
  t.is(s.mark, 'same', s.text);
  t.regex(s.text, /^dry run at/);
  t.false(q.log.slice(pre).some(e => e.name === 'place' || e.name === 'dig.here'), 'nothing placed or dug');
  const site = q.world.villages!.sites[0];
  t.true(site.fetch?.ok === true && (site.fetch.pathLen ?? 0) > 100 && (site.fetch.outS ?? 0) > 20, JSON.stringify(site.fetch));
  t.true(q.dumps.some(d => d.name === 'fetch-dry'));
});

test('B14 the dry switch set before any trip (villager-moves {dry:true}): PREP\'s new trip is dry, it lifts nothing and digs no stray in a lane (it says what it would, and plans as if done); made real after, the trip owes its lifts and PREP makes them first', async (t) => {
  const p = homestead();
  fetchOf(p.world).dry = true;
  const stray = at(-549, 64, 2118);
  p.set(stray, 'cobblestone');
  const from = p.log.length;
  const r = await prepNow(p);
  t.true(r.prepared, r.text);
  const f = peekFetch(p.world);
  t.true(f.trip?.dry, 'the trip carries the switch');
  t.true(f.trip?.prep.dry, 'its lifts only said');
  t.is(f.trip?.gate.side, 'north', 'the lane planned as if its stray were dug: the real trip\'s gate');
  t.deepEqual(f.journal, [], 'nothing journaled: nothing done');
  t.is(idOf(p.get(SMITHING)), 'smithing_table', 'the smithing table not lifted');
  t.is(idOf(p.get(stray)), 'cobblestone', 'the stray not dug');
  t.false(p.log.slice(from).some(e => e.name === 'dig.here' || e.name === 'place' || e.name === 'dig'), 'no dig and no place in the log');
  t.true(p.said.some(x => /prep \(dry\): would lift the smithing_table at \(-541, 63, 2153\)/.test(x)));
  t.true(p.said.some(x => /prep \(dry\): would dig the cobblestone in the north gate's lane at \(-549, 64, 2118\)/.test(x)));
  // the lead turns dry off before dawn (the tool takes the trip's mark off): the trip is not set out past an un-lifted table
  delete fetchOf(p.world).dry;
  delete fetchOf(p.world).trip!.dry;
  p.advance(((23_600 - p.tod) % 24_000 + 24_000) % 24_000);
  const pre = p.log.length;
  const s = await trip(p);
  t.true(s.untried, s.text);
  t.regex(s.text, /prepared dry \(its lifts owed\)/);
  t.is(peekFetch(p.world).trip?.prepared, undefined);
  t.false(p.log.slice(pre).some(e => e.name === 'goto'), 'not set out');
  // PREP at dawn (the reads and the kit stand) makes the lifts, for real this time
  const u = await prepNow(p);
  t.true(u.prepared, u.text);
  t.is(idOf(p.get(SMITHING)), 'air', 'lifted now');
  t.true(peekFetch(p.world).journal.some(e => e.k === 'lift' && key(e.at) === key(SMITHING)));
  invariants(t, p);
});

test('C1 nobody comes: three spots, the lure up, the site marked `no claim`, a dump for the replay; nothing left in the village', async (t) => {
  const p = homestead({ candidates: 0 });
  // two unemployed adults that take no job (the game would not let them reach it: here they never look)
  for (const i of [0, 1]) p.villager({ at: at(BELL.x + 4 + 3 * i, 63, BELL.z + 2 * i), mind: 'still', id: 500 + i });
  await prepared(t, p);
  const r = await trip(p);
  t.is(r.mark, 'same', r.text);
  t.regex(r.text, /^no claim at the village/);
  t.is(p.world.villages!.sites[0].fetch?.kind, 'no claim');
  t.true(p.dumps.some(d => d.name === 'fetch-first'));
  t.is(p.log.filter(e => e.name === 'place').length, 3, 'three spots');
  t.log(saidOf(p).join('\n'));
  t.is(new Set(p.log.filter(e => e.name === 'place').map(e => `${e.params.x},${e.params.y},${e.params.z}`)).size, 3, `three cells (a spot nobody came to is not a nearer one): ${p.log.filter(e => e.name === 'place').map(e => `${e.params.x},${e.params.y},${e.params.z}@${e.tod}`).join(' ')}`);
  t.false(fetchOf(p.world).journal.some(e => e.k === 'lure'));
  // 4.1: after nobody came, a spot nearer the nearest candidate (within 12 path cells of it, on its level)
  const spots = p.changed.filter(c => c.how === 'placed' && idOf(c.to) === 'fletching_table').map(c => c.at);
  const stills = p.villagers.filter(v => v.mind === 'still' && v.id >= 500).map(v => v.position);
  t.log(spots.map(key).join(' '), stills.map(v => key(cellOfPos(v))).join(' '));
  for (const s of spots.slice(1)) {
    const near = Math.min(...stills.map(v => flat(v, { x: s.x + 0.5, z: s.z + 0.5 })));
    t.true(near <= 13, `the spot ${key(s)} ${near.toFixed(1)} from the nearest candidate`);
    t.true(stills.some(v => Math.floor(v.y) === s.y), `${key(s)} on a candidate's level`);
  }
  invariants(t, p);
});

test('C4 the farther candidate came: led all the same (whoever flips is the ward), into the hall; C5 a second villager is pinned, the first led home, the pin left for care', async (t) => {
  const p = homestead({ candidates: 1 });
  // the nearer candidate, on the way's side, takes no job; the farther one (game) comes
  const near = p.villager({ at: at(BELL.x + 12, 63, BELL.z - 4), mind: 'still', id: 510 });
  await prepared(t, p);
  const r = await trip(p);
  t.is(r.gain, 1, r.text);
  const ward = p.villagers.find(x => x.mind === 'game' && x.profession === 'librarian');
  t.truthy(ward);
  t.not(ward!.uuid, near.uuid);
  invariants(t, p);
  const q = homestead({ candidates: 3 });
  await prepared(t, q);
  const s = await trip(q);
  t.log(q.said.filter(x => /pin|hop|lock|hall|released|STOP/.test(x)).join('\n'));
  t.is(s.gain, 1, s.text);
  const f = peekFetch(q.world);
  const pins = f.journal.filter(e => e.k === 'lure' && e.role === 'pin');
  t.true(pins.length >= 1, 'a pin');
  t.true(pins.every(e => e.k === 'lure' && e.inVillage === true || flat(e.at, BELL) > 0));
  invariants(t, q, { leftOut: true });
});

test('C10 a traded villager took the lure: let be (still a fletcher 3 s after the break: someone\'s customer), the lure up, the site noted', async (t) => {
  const p = homestead({ candidates: 1 });
  for (const v of p.villagers.filter(x => x.mind === 'game')) v.traded = true;
  await prepared(t, p);
  const r = await trip(p);
  t.regex(r.text, /traded: someone's customer/);
  t.is(p.world.villages!.sites[0].fetch?.kind, 'rival');
  t.deepEqual(peekFetch(p.world).wards, []);
  t.false(fetchOf(p.world).journal.some(e => e.k === 'lure'));
  invariants(t, p);
});

// ------------------------------------------------------------------------------------------------ on the way (D rows)

test('D1 the bot\'s own smithing table un-lifted takes the ward (the live failure): lifted with it 2 off, it resets and is led on; the table back once it is in', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-543, 63, 2146) });
  const { v } = led(p, { at: at(-541, 63, 2150), lure: at(-545, 63, 2146), state: 'yardhop', committed: 'far', over: { profession: 'toolsmith', job: { ...SMITHING } } });
  fetchOf(p.world).journal = fetchOf(p.world).journal.filter(e => e.k !== 'lift');
  p.set(SMITHING, 'smithing_table[]');
  p.mine(SMITHING);
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.true(p.said.some(x => /rival: the ward took the bot's own smithing_table at \(-541, 63, 2153\): lifted/.test(x)));
  t.not(v.profession, 'toolsmith');
  if (r.end === 'hall') t.is(idOf(p.get(SMITHING)), 'smithing_table', 'put back once no villager is out');
  invariants(t, p);
});

test('D2 a foreign job block took it: nothing touched, said: astray, the way keeps 56 off it, halt', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-612, 63, 2116) });
  const stand = at(-618, 63, 2112);
  p.set(stand, 'brewing_stand[has_bottle_0=false,has_bottle_1=false,has_bottle_2=false]');
  led(p, { at: at(-618, 63, 2114), lure: at(-610, 63, 2117), state: 'hop', committed: 'far', toGate: 70, over: { profession: 'cleric', job: { ...stand } } });
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'astray', r.text);
  t.regex(r.text, /took someone's brewing_stand at \(-618, 63, 2112\): nothing touched/);
  const f = peekFetch(p.world);
  t.truthy(f.halt);
  t.is(idOf(p.get(stand)), 'brewing_stand');
  t.false(p.log.some(e => e.name === 'dig.here' && e.params.x === stand.x && e.params.z === stand.z));
  invariants(t, p, { leftOut: true });
});

test('D4 lost for a moment: found by its uuid (the ids renumbered by an unload), led on; D21 thunder at hop 4: led on; D33 a screen opens: closed', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  p.at(p.tick + 60, () => p.unload());
  p.at(p.tick + 80, () => { p.thundering = true; p.bot.screen = 'merchant'; });
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.true(p.log.some(e => e.name === 'container.close'));
  invariants(t, p);
});

test('D15 a zombie by the ward: held, the bot between them, fought with an axe (never a sword by a villager); then led on', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  const z = p.animal('zombie', at(-546, 63, 2124));
  p.give('diamond_sword', 1);
  p.on.act['attack-entity'] = () => { p.animals = p.animals.filter(a => a !== z); return { ok: true, text: 'killed zombie' }; };
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  const fight = p.log.findIndex(e => e.name === 'attack-entity');
  t.true(fight > 0);
  const sel = p.log.slice(0, fight).reverse().find(e => e.name === 'item.select');
  t.regex(String(sel?.params.name), /_axe$/);
  invariants(t, p);
});

test('D17 illagers ahead: the lure up, the ward free to flee (astray), the bot home; the site waits 24 h', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-612, 63, 2116) });
  led(p, { at: at(-610, 63, 2118), lure: at(-610, 63, 2117), state: 'hop', committed: 'far', toGate: 60 });
  p.animal('pillager', at(-590, 63, 2116));
  p.animal('vindicator', at(-588, 63, 2118));
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'astray', r.text);
  t.regex(r.text, /illagers ahead/);
  t.false(fetchOf(p.world).journal.some(e => e.k === 'lure'), 'the lure up');
  t.is(p.world.villages!.sites[0].fetch?.kind, 'no unemployed');
  invariants(t, p);
});

test('D18 it died: records clean (dead, no lure left), halt; its health falls twice with no cause seen: halt, and it is led on to the lock', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  const { v } = led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  p.at(p.tick + 30, () => p.hurt(v, 25));
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'dead' || r.end === 'astray', r.text);
  const f = peekFetch(p.world);
  t.truthy(f.halt);
  t.false(f.journal.some(e => e.k === 'lure'));
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  const w = led(q, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' }).v;
  q.at(q.tick + 300, () => q.hurt(w, 2));
  q.at(q.tick + 500, () => q.hurt(w, 2));
  const s = await leadOn(q.ctx, q.clock);
  t.true(s.end === 'hall' || s.end === 'lock', s.text);
  t.regex(peekFetch(q.world).halt?.why ?? '', /hurt twice/);
});

test('D19 a player comes by near the village: released (not committed); D20 no legal anchor cell: none placed, said, the trip cut', async (t) => {
  const p = homestead({ tod: 1_000, candidates: 0, at: at(-694, 63, 2121) });
  led(p, { at: at(-700, 63, 2120), lure: at(-700, 63, 2121), state: 'hop', toGate: 140 });
  // a player walking along with the bot, 6 off it
  const pl = p.animal('player', at(-690, 63, 2125));
  const follow = () => { pl.position = { x: p.bot.at.x + 0.5, y: 63, z: p.bot.at.z + 6.5 }; p.at(p.tick + 20, follow); };
  follow();
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'released', r.text);
  t.regex(r.text, /a player at .* stayed 60 s/);
  invariants(t, p);
  // a survival goal cuts the run on its walk to the stand, the lure in the pockets: no cell was kept for the anchor yet
  const q = homestead({ tod: 1_000, candidates: 0, at: at(-612, 63, 2116) });
  led(q, { at: at(-610, 63, 2118), lure: at(-610, 63, 2117), state: 'hop', committed: 'far', toGate: 60 });
  const ac = new AbortController();
  q.on.call.goto = (params) => { if (params.range === 0 && !ac.signal.aborted) ac.abort(); return undefined; };
  const ctx = { ...q.ctx, signal: ac.signal };
  await t.throwsAsync(leadOn(ctx, q.clock), { message: 'aborted' });
  const f = peekFetch(q.world);
  t.truthy(f.trip?.cut);
  t.true(q.said.some(x => /no legal anchor cell by the bot: none placed/.test(x)));
  t.is(f.wards[0].where, 'astray');
  t.false(out.ledBy === ac.signal);
});

test('D25 the drop is lost: journaled, the spare leads on', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2128) });
  led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  let lost = false;
  p.on.call['dig.here'] = (params, q) => {
    if (lost) return undefined;
    lost = true;
    const r = q.answer('dig.here', params);
    q.drops.pop();
    return r;
  };
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.true(p.log.some(e => e.name === 'dig.here') && lost);
  t.true(p.said.some(x => /not picked up: the spare leads on/.test(x)));
  invariants(t, p);
});

test('D28 wedged on the bot\'s bench: the lure to its other side, then the bench and the fence segment lifted (journal first), led on; the fence back once it is in', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-548, 63, 2132) });
  const { v } = led(p, { at: at(-544, 63, 2127), lure: at(-546, 63, 2124), state: 'yardhop', committed: 'far' });
  p.snag([at(-544, 64, 2127), at(-544, 63, 2127)], [at(-544, 63, 2128)]);
  const r = await leadOn(p.ctx, p.clock);
  t.log(p.said.filter(x => /wedged|lift|hop|lock|hall/.test(x)).join('\n'));
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.true(p.said.some(x => /wedged at .*: the bot's own oak_fence at \(-544, 63, 2128\) lifted/.test(x)));
  t.true(p.changed.some(c => key(c.at) === key(at(-544, 63, 2128)) && c.how === 'dug'));
  if (r.end === 'hall') t.is(idOf(p.get(at(-544, 63, 2128))), 'oak_fence', 'the fence back');
  t.not(v.position.z, 2127);
  invariants(t, p);
});

// ------------------------------------------------------------------------------------------------ arriving (E, F rows)

test('E14 two awake insiders that leave by any open way: no instant with a way out (P shut while H stands open at DOOR: they are in the lock, contained, and the door waits for them); E28 a baby by the socket: waited', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2138), resident: false });
  // the hall's fletching table held by a resident fletcher; two leak-seekers inside (any open way out, they take it)
  p.villager({ at: at(-552, 63, 2128), mind: 'still', profession: 'fletcher', level: 4, id: 100 });
  const leakers = [p.villager({ at: at(-556, 63, 2132), id: 110 }), p.villager({ at: at(-557, 63, 2131), id: 111 })];
  const baby = p.villager({ at: at(-554, 63, 2133), mind: 'still', baby: true, id: 120 });
  led(p, { at: at(-551, 63, 2140), lure: at(-551, 63, 2141), state: 'yardhop', committed: 'far' });
  // the baby moves off the socket 15 s into the lock's steps; a rejoin's blind look while the ward goes in
  let socketAt = -1;
  p.on.call['dig.here'] = (params) => { if (Number(params.x) === SOCKET.x && Number(params.z) === SOCKET.z && socketAt < 0) socketAt = p.tick; return undefined; };
  p.on.call.useOn = (params) => {
    if (Number(params.x) === P.x && Number(params.z) === P.z) p.at(p.tick + 300, () => { baby.position = { x: -559.5, y: 63, z: 2128.5 }; });
    if (Number(params.x) === H.x && Number(params.z) === H.z) p.at(p.tick + 40, () => { p.unload(); p.blind(60); });
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'lock' || r.end === 'hall', r.text);
  for (const v of [...leakers, baby]) t.true(inBox(HALL_BOX, v.position) || inBox(LOCK_BOX, v.position), `an insider at ${key(v.position)}`);
  t.false(p.leaks.some(l => key(l.gate) === key(P) && leakers.some(v => v.uuid === l.uuid)), 'no insider through P');
  const moved = p.changed.find(c => c.how === 'dug' && key(c.at) === key(SOCKET));
  t.true(socketAt > 0 && !!moved);
  t.true(baby.position.x < -558, 'the socket opened once the baby was off it');
  invariants(t, p);
});

test('F2 the ward is counted in the hall across a rejoin (a blind look changes nothing; its uuid holds over the new ids)', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2138) });
  led(p, { at: at(-551, 63, 2140), lure: at(-551, 63, 2141), state: 'yardhop', committed: 'far' });
  p.on.call.useOn = (params) => { if (Number(params.x) === H.x && Number(params.z) === H.z) p.at(p.tick + 40, () => { p.unload(); p.blind(60); }); return undefined; };
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'hall', r.text);
  t.deepEqual(peekFetch(p.world).wards, [], 'counted in the hall by its uuid');
  t.is(p.villagers.find(v => v.mind === 'game')?.profession, 'librarian');
  invariants(t, p);
});

test('E6 a cow at the gate inside: waited, then the gate (the hold before the walk); the animals counted before and after', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2112) });
  led(p, { at: at(-551, 63, 2114), lure: at(-551, 63, 2115), state: 'hop', committed: 'far', toGate: 3 });
  const cow = p.animal('cow', at(-549, 63, 2122));
  p.at(p.tick + 120, () => { cow.position = { x: -545.5, y: 63, z: 2140.5 }; });
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  const hold = p.log.findIndex(e => e.name === 'gates.hold' && Number(e.params.z) === NORTH.z);
  t.true(hold > 0 && p.log[hold].t >= p.tick - 100_000);
  t.true(inBox(YARD_BOX, cow.position), 'the cow still in the yard');
  invariants(t, p);
});

test('G5 the never-list over the happy trip\'s log: no gates.auto off, no entity.use, no force, no sword drawn by a villager, no chat, every walk of the lead careful; C3 a zombie by the candidates: fought first, then the lure', async (t) => {
  const p = homestead({ candidates: 1 });
  await prepared(t, p);
  // a zombie comes up by the candidate as the survey ends (its last look is at the village's marks)
  const cand = p.villagers.find(v => v.mind === 'game')!;
  let z: ReturnType<Pasture['animal']> | undefined;
  p.on.call['foreign.marks'] = (params) => { if (params.match === '.*') z ??= p.animal('zombie', at(Math.floor(cand.position.x) + 3, 63, Math.floor(cand.position.z))); return { at: [] }; };
  p.on.act['attack-entity'] = () => { p.animals = p.animals.filter(a => a !== z); return { ok: true, text: 'killed zombie' }; };
  const r = await trip(p);
  const fought = p.log.findIndex(e => e.name === 'attack-entity'), first = p.log.findIndex(e => e.name === 'place');
  t.true(fought > 0 && fought < first, `fought (${fought}) before the first lure (${first}): ${p.said.filter(x => /zombie|first lure/.test(x)).join('; ')}`);
  t.is(r.gain, 1, r.text);
  t.false(p.log.some(e => e.name === 'gates.auto' && e.params.enabled === false));
  t.false(p.log.some(e => /entity\.use|chat/.test(e.name)));
  t.false(p.log.some(e => e.name === 'dig.here' && e.params.force));
  t.false(p.log.some(e => e.name === 'dig'), 'never the plain dig');
  t.deepEqual(p.broke, [], 'no plain walk went where no way on foot is');
  invariants(t, p);
});

test('A7 a named villager took the lure: let be (broken at once, as found), another spot 40 off; nobody else comes: no claim', async (t) => {
  const p = homestead({ candidates: 0 });
  p.villager({ at: at(BELL.x + 6, 63, BELL.z + 2), mind: 'still', id: 520 });
  const named = p.villager({ at: at(BELL.x + 9, 63, BELL.z + 3), mind: 'game', id: 521, customName: 'Bob', bell: { ...BELL } });
  await prepared(t, p);
  const r = await trip(p);
  t.true(p.said.some(x => /a villager not to take \(is named \(Bob\)\) took the lure: let be/.test(x)), p.said.join('\n'));
  t.not(named.profession, 'fletcher', 'jobless again, as found');
  t.deepEqual(peekFetch(p.world).wards, []);
  t.regex(r.text, /no claim/);
  invariants(t, p);
});

test('A14 a cauldron 40 aside of the way: the corridor and every hop keep 56 off it (or the trip is refused); INV-5 holds; B5 hungry at dawn: eats, then goes', async (t) => {
  const p = homestead({ candidates: 1 });
  const cauldron = at(-640, 63, 2158);
  p.set(cauldron, 'cauldron');
  await prepared(t, p);
  // B5 hungry at dawn: eats in the yard, then goes
  p.bot.food = 10;
  p.on.act.eat = () => { p.bot.food = 20; return { ok: true, text: 'Ate bread' }; };
  const r = await trip(p);
  const ate = p.log.findIndex(e => e.name === 'eat'), out1 = p.log.findIndex((e, i) => i > ate && e.name === 'goto');
  t.true(ate > 0 && out1 > ate, 'ate before the walk out');
  const lures = p.changed.filter(c => c.how === 'placed' && idOf(c.to) === 'fletching_table' && !inBox(YARD_BOX, c.at));
  // (the trip went round it into the hall, every lure 56 or more off it; else it was refused for that cauldron by name)
  t.true(r.gain === 1 || /(rival|keep|56).*cauldron at \(-640, 63, 2158\)|cauldron at \(-640, 63, 2158\).*(rival|keep|56)/.test(r.text), r.text);
  for (const c of lures) t.true(flat(c.at, cauldron) >= 56, `a lure at ${key(c.at)}, ${Math.round(flat(c.at, cauldron))} from the cauldron`);
  t.true(lures.length > 0, 'the trip led a ward out there');
  // the way kept off it: the trip's avoid circles had it (a free job site that is not the bot's), 56 round, as saved
  const avoided = p.log.some(e => ((JSON.parse(e.saved) as { fetch?: FetchMemory }).fetch?.trip?.avoid ?? []).some(a => key(a.at as Pos) === key(cauldron) && a.r >= 56));
  t.true(avoided, 'the cauldron among the trip\'s keep-offs, 56 round');
  invariants(t, p);
});

test('D16 a creeper comes for the bot: led off 10 or more from the ward, the lure stays, the ward unhurt; D30 no way on foot to the stand: another spot', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2128) });
  const { v } = led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  const c = p.animal('creeper', at(-546, 63, 2130));
  p.at(p.tick + 400, () => { p.animals = p.animals.filter(a => a !== c); });
  let refused = 0;
  p.on.call.goto = (params) => (params.range === 0 && params.careful && refused++ === 1 ? { arrived: false, at: { ...p.bot.at }, distance: 9 } : undefined);
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.true(p.said.some(x => /a creeper at .* after the bot: led off/.test(x)));
  t.true(p.said.some(x => /no way on foot to .*: another spot/.test(x)));
  t.is(v.health, 20);
  invariants(t, p);
});

test('E20 at dusk a ward in the lock walks on to a bed in the hall (H open behind the shut P; no lectern free there)', async (t) => {
  const p = homestead({ tod: 10_900, candidates: 0, at: at(-552, 63, 2138) });
  p.set(at(-553, 63, 2127), 'air');
  const { v } = led(p, { at: at(-551, 63, 2140), lure: at(-551, 63, 2141), state: 'yardhop', committed: 'far', bell: false });
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'lock' || r.end === 'hall', r.text);
  t.false(isOpen(p.get(P)));
  p.advance(3200);
  t.true(inBox(HALL_BOX, v.position) || inBox(LOCK_BOX, v.position), `the ward at ${key(v.position)}`);
  invariants(t, p, { bell: false });
});

test('3.3 the exit handler: a run cut inside GATE (a survival goal, after the hold): the held gate released shut by the bridge, read shut; the ward astray, the trip cut for care', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2112) });
  led(p, { at: at(-551, 63, 2114), lure: at(-551, 63, 2115), state: 'hop', committed: 'far', toGate: 3 });
  const ac = new AbortController();
  p.on.call['gates.hold'] = () => { if (!ac.signal.aborted) p.at(p.tick + 2, () => ac.abort()); return undefined; };
  await t.throwsAsync(leadOn({ ...p.ctx, signal: ac.signal }, p.clock));
  const f = peekFetch(p.world);
  t.truthy(f.trip?.cut, 'cut');
  t.is(f.trip?.state, 'gate');
  const rel = p.log.filter(e => e.name === 'gates.release' && e.params.shut === true && Number(e.params.z) === NORTH.z);
  t.true(rel.length >= 1, 'released shut');
  p.advance(40);
  t.false(isOpen(p.get(NORTH)), 'the gate shut');
  t.is(f.wards[0].where, 'astray');
  // (out is the process's one record: other scenarios of this file run beside this one)
  t.not(out.critical?.by, ac.signal, 'no critical section of this run left behind');
  t.not(out.ledBy, ac.signal);
});

// ------------------------------------------------------------------------------------------------ the L rows, one each (S1 integration)

/** The lure's said lines (`villagers: ` off). */
const saidOf = (p: Pasture) => p.said.filter(x => x.startsWith('villagers: ')).map(x => x.slice('villagers: '.length));
/** The hops as said: from, to, blocks. */
const hopsSaid = (p: Pasture) => saidOf(p).flatMap(x => {
  const m = /^hop (\d+): \((-?\d+), (-?\d+), (-?\d+)\) -> \((-?\d+), (-?\d+), (-?\d+)\), (\d+) blocks/.exec(x);
  return m ? [{ n: Number(m[1]), from: at(Number(m[2]), Number(m[3]), Number(m[4])), to: at(Number(m[5]), Number(m[6]), Number(m[7])), blocks: Number(m[8]) }] : [];
});
/** The ground's grass at y 62 set to another block over a box of columns (the lawn's top). */
function lay(p: Pasture, x1: number, z1: number, x2: number, z2: number, top: string, o: { y?: number; under?: string } = {}): void {
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
    p.set(at(x, o.y ?? 62, z), top);
    if (o.under) p.set(at(x, (o.y ?? 62) - 1, z), o.under);
  }
}

test('F5 a release leaves a retraceable way: the ward let go within 96 of its village, on ground it walks back to its bell by its own way (the game\'s)', async (t) => {
  const p = homestead({ tod: 6_000, candidates: 0, at: at(-694, 63, 2121) });
  const { v } = led(p, { at: at(-700, 63, 2120), lure: at(-700, 63, 2121), state: 'hop', toGate: 160, yard: 18, over: { bell: { ...BELL } } });
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'released', r.text);
  t.true(flat(v.position, BELL) <= 96, `let go ${Math.round(flat(v.position, BELL))} from its village`);
  const back = p.gamePath(v.position, [BELL], 6);
  t.true(back.reached, 'a way back to its bell by the game\'s own walk');
  t.is(v.profession, 'none', 'jobless, as found');
  // and at the meeting it goes to its bell
  p.advance(((9_900 - p.tod) % 24_000 + 24_000) % 24_000);
  t.true(flat(v.position, BELL) <= 8, `by its bell at the meeting: ${key(cellOf(v.position))}`);
  invariants(t, p);
});

test('D5 no level spot a hop on (a village path across the way, where no lure may stand): HOP_LEN 11, a short hop, and on', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-638, 63, 2116) });
  // dirt paths 14 to 28 ahead, the whole band wide: no lure on a path block (it turns to dirt)
  lay(p, -626, 2090, -612, 2150, 'dirt_path');
  led(p, { at: at(-640, 63, 2118), lure: at(-640, 63, 2119), state: 'hop', committed: 'far', toGate: 92 });
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  const first = hopsSaid(p)[0];
  t.truthy(first, saidOf(p).join('\n'));
  t.true(first.blocks <= 14 && first.to.x < -626, `the first hop short, before the paths: ${JSON.stringify(first)}`);
  for (const c of p.changed.filter(x => x.how === 'placed' && idOf(x.to) === 'fletching_table')) t.not(idOf(p.get(at(c.at.x, c.at.y - 1, c.at.z))), 'dirt_path');
  invariants(t, p);
});

test('D7 below a 2-drop the trip is committed: no way round the step (it spans the band), the hop taken all the same, `committed (a drop of 2 ...)`, never a release from below it', async (t) => {
  const p = homestead({ tod: 1_000, candidates: 0, at: at(-688, 63, 2116) });
  // the land 2 lower from x -676 to -660 across the band, then up again a block at a time
  lay(p, -676, 2080, -660, 2170, 'air', { under: 'air' });
  lay(p, -676, 2080, -660, 2170, 'grass_block[snowy=false]', { y: 60 });
  lay(p, -659, 2080, -659, 2170, 'air');
  lay(p, -659, 2080, -659, 2170, 'grass_block[snowy=false]', { y: 61 });
  led(p, { at: at(-690, 63, 2120), lure: at(-690, 63, 2121), state: 'hop', toGate: 145, over: { bell: { ...BELL } } });
  const r = await leadOn(p.ctx, p.clock);
  t.log(saidOf(p).join('\n'));
  t.true(saidOf(p).some(x => /^committed \(a drop of 2/.test(x)), 'committed by the drop');
  t.false(saidOf(p).some(x => /^released/.test(x)), 'never released below it');
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  invariants(t, p);
});

test('D12 a miss (the ward does not come 3 nearer in 20 s: the game\'s search never got to the lure): the lure comes half way back, and it comes', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-638, 63, 2116) });
  const { v } = led(p, { at: at(-640, 63, 2118), lure: at(-640, 63, 2119), state: 'hop', committed: 'far', toGate: 92 });
  // the first lure of the run held in the ward's backoff (a search that failed: JitteredLinearRetry), for 35 s
  let first: Pos | undefined;
  p.on.call.place = (params) => {
    const c = cellOf({ x: Number(params.x), y: Number(params.y), z: Number(params.z) });
    if (!first && v.ai) { first = c; v.ai.retry.job.set(key(c), { last: p.tick + 300, next: p.tick + 700, delay: 400 }); }
    return undefined;
  };
  // (and it strolls about meanwhile, not toward the lure: never still)
  let side = 1;
  const wiggle = () => { if (!first || v.profession === 'fletcher') return; v.position = { ...v.position, z: v.position.z + 0.6 * (side = -side) }; p.at(p.tick + 6, wiggle); };
  p.at(p.tick + 6, wiggle);
  const r = await leadOn(p.ctx, p.clock);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  const said = saidOf(p);
  const miss = said.findIndex(x => /^miss 1: not 3 nearer the lure at .* in 20 s: a cell at half the distance/.test(x));
  t.true(miss >= 0, said.join('\n'));
  // (from where the ward stood at the miss: it had strolled off; the next lure half its distance to the missed one)
  const next = hopsSaid(p)[0];
  t.truthy(next);
  const was = flat(next.from, first!);
  t.true(Math.abs(next.blocks - was / 2) <= 2, `half way: ${next.blocks} of ${Math.round(was)}`);
  t.true(next.blocks < 22, 'shorter than a hop');
  invariants(t, p);
});

test('C2 before 100: the bot at the village before the villagers are up (abed until 10) waits, and the first lure goes down at 100 or after', async (t) => {
  // a village 75 off the north gate, so a dawn's walk out ends before 100
  const near = { bell: at(-630, 63, 2124), area: { x1: -650, z1: 2104, x2: -610, z2: 2144 } };
  const p = homestead({ candidates: 1, village: near });
  await prepared(t, p, 23_520);
  // (the night took it about: it stands by its bell at dawn)
  const v = p.villagers.find(x => x.id === 200)!;
  v.position = { x: near.bell.x + 4.5, y: 63, z: near.bell.z + 0.5 };
  const r = await trip(p);
  t.true(r.gain === 1 || r.mark === 'same', r.text);
  const surveyed = p.log.find(e => e.name === 'foreign.marks');
  t.truthy(surveyed);
  t.true(surveyed!.tod >= 23_500 || surveyed!.tod < 100, `at the village before 100 (${surveyed!.tod})`);
  const firstPlace = p.log.find(e => e.name === 'place' && e.i > surveyed!.i);
  t.truthy(firstPlace);
  t.true(firstPlace!.tod >= 100 && firstPlace!.tod < 23_500, `the first lure at ${firstPlace!.tod}`);
  invariants(t, p);
});

test('A10 the ford 30 aside is found: a stream across the band, its only ford 31 off the way (outside the band read on the walk out); the corridor fails on water there, one more band each side is read, and the way (a dry run\'s plan) goes by the ford', async (t) => {
  const p = homestead({ candidates: 1 });
  // a stream 3 wide and 2 deep at x -641..-639, from z 2060 to 2200, but for its ford at z 2153..2155
  for (let x = -641; x <= -639; x++) for (let z = 2060; z <= 2200; z++) {
    if (z >= 2153 && z <= 2155) continue;
    p.set(at(x, 62, z), 'water[level=0]');
    p.set(at(x, 61, z), 'water[level=0]');
  }
  fetchOf(p.world).dry = true;
  await prepared(t, p);
  const r = await trip(p);
  t.regex(r.text, /^dry run at/, r.text);
  const dry = p.dumps.find(d => d.name === 'fetch-dry')?.data as { way?: Pos[] } | undefined;
  const way = dry?.way ?? [];
  t.true(way.length > 0, saidOf(p).join('\n'));
  const crossing = way.filter(c => c.x >= -641 && c.x <= -639);
  t.true(crossing.length > 0 && crossing.every(c => c.z >= 2153 && c.z <= 2155), `crossed at ${crossing.map(key).join(' ')}`);
  t.false(p.log.some(e => e.name === 'place' || e.name === 'dig.here'), 'dry: nothing placed or dug');
  invariants(t, p);
});

/** The fletching tables put down by the run, in order (the cells). */
const luresDown = (p: Pasture, from = 0) => p.log.filter(e => e.i >= from && e.name === 'place' && idOf(String((e.reply as { block?: string } | undefined)?.block ?? 'fletching_table')) === 'fletching_table')
  .map(e => at(Number(e.params.x), Number(e.params.y), Number(e.params.z)));
const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

test('A6 an indoor candidate comes out by its door: no way by the model from inside (a stair in the doorway: the lead rules stand on no stair), an open spot 12-32 off on the home side all the same; the game is the judge, and it comes', async (t) => {
  const p = homestead({ candidates: 0 });
  // a plank house 5 x 5 (walls 63-65, roof 66) by the bell, its door east with a stair for a step
  for (let x = -716; x <= -712; x++) for (let z = 2126; z <= 2130; z++) {
    const wall = x === -716 || x === -712 || z === 2126 || z === 2130;
    for (let y = 63; y <= 65; y++) if (wall) p.set(at(x, y, z), 'oak_planks');
    p.set(at(x, 66, z), 'oak_planks');
  }
  p.set(at(-712, 63, 2128), 'oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
  for (const y of [64, 65]) p.set(at(-712, y, 2128), 'air');
  const v = p.villager({ at: at(-714, 63, 2128), mind: 'game', id: 210, bell: { ...BELL } });
  await prepared(t, p);
  // (at dawn it is in its house, and stays in till the first lure is down: then the game takes it out by its door)
  v.position = { x: -713.5, y: 63, z: 2128.5 };
  const holder = at(-700, 75, 2200);
  p.set(holder, 'stone');
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) p.snag(at(-714 + dx, 63, 2128 + dz), [holder]);
  p.on.call.place = () => { p.set(holder, 'air'); return undefined; };
  const r = await trip(p);
  const said = saidOf(p);
  t.true(said.some(x => /^first lure at .*an open spot: the game is the judge/.test(x)), said.join('\n'));
  const l0 = luresDown(p)[0];
  const d = flat(l0, at(-714, 63, 2128));
  t.true(d >= 11 && d <= 33, `the open spot ${Math.round(d)} off`);
  t.true(said.some(x => /^ward 00000000 took it in/.test(x)), 'it came out and took it');
  t.true(r.gain === 1 || r.mark === 'same', r.text);
  invariants(t, p);
});

test('A8 two bells, two villages side by side: the candidates are the trip\'s village\'s only (the unemployed adults of the other, in sight, are not); its free job sites are the way\'s keep-offs', async (t) => {
  const other = { bell: at(-720, 63, 2060), area: { x1: -750, z1: 2030, x2: -690, z2: 2090 } };
  // (the other, judged free too but not counted whole: a look's, not a trip's)
  const site2 = (p: Pasture): VillageSite => ({ ...p.world.villages!.sites[0], x: other.bell.x, z: other.bell.z, area: { ...other.area }, whole: undefined, judged: { at: p.now(), kind: 'free', why: '6 villagers, 2 unemployed adult(s) to take', v: 4 } });
  // (a) the trip's village has no unemployed adult; the other's two stand in sight, 46-50 off its bell
  const p = homestead({ candidates: 0 });
  p.world.villages!.sites.push(site2(p));
  p.set(other.bell, 'bell[attachment=floor,facing=north,powered=false]');
  for (const [i, prof] of ['farmer', 'farmer'].entries()) p.villager({ at: at(BELL.x + 3 + 2 * i, 63, BELL.z + 2), mind: 'still', id: 400 + i, profession: prof });
  for (const i of [0, 1]) p.villager({ at: at(BELL.x + 2 * i, 63, 2080 + 2 * i), mind: 'still', id: 450 + i, bell: { ...other.bell } });
  await prepared(t, p);
  const from = p.log.length;
  const r = await trip(p);
  t.true(r.untried, r.text);
  t.regex(r.text, /no usable villager in reach at \(-720, 63, 2128\): 2 employed/);
  t.deepEqual(placedAfter(p, from), []);
  // (b) a candidate of its own, and a free lectern in the other village: kept off as someone's (56)
  const q = homestead({ candidates: 1 });
  q.world.villages!.sites.push(site2(q));
  q.set(other.bell, 'bell[attachment=floor,facing=north,powered=false]');
  const lectern = at(-700, 63, 2055);
  q.set(lectern, 'lectern[facing=south,has_book=false,powered=false]');
  let avoid: { at: Pos; r: number }[] = [];
  q.on.call['foreign.marks'] = () => { avoid = structuredClone(fetchOf(q.world).trip?.avoid ?? []); return undefined; };
  await prepared(t, q);
  const s = await trip(q);
  t.true(avoid.some(a => key(a.at) === key(lectern) && a.r === 56), JSON.stringify(avoid));
  t.true(s.gain === 1 || s.mark === 'same', s.text);
  t.false(q.claims.some(c => key(c.at) === key(lectern) && q.villagers.find(v => v.uuid === c.uuid)?.id === 200), 'the ward never took the other village\'s lectern');
  invariants(t, q);
});

test('C6 a claim without arrival (it set off for the first lure and stopped on the way): at 45-60 s the lure broken, which frees the ticket, and re-placed half way to the claimant; it comes', async (t) => {
  const p = homestead({ candidates: 1 });
  await prepared(t, p);
  const v = p.villagers.find(x => x.id === 200)!;
  // a snag round the first lure, 5 off it (every way in crosses it), held by a block that goes when the lure is broken
  const holder = at(-700, 75, 2200);
  p.set(holder, 'stone');
  let l0: Pos | undefined;
  p.on.call.place = (params) => {
    if (l0) return undefined;
    l0 = cellOf({ x: Number(params.x), y: Number(params.y), z: Number(params.z) });
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 5) p.snag(at(l0.x + dx, l0.y, l0.z + dz), [holder]);
    return undefined;
  };
  p.on.call['dig.here'] = (params) => { if (l0 && Number(params.x) === l0.x && Number(params.z) === l0.z) p.set(holder, 'air'); return undefined; };
  const r = await trip(p);
  const said = saidOf(p);
  const claim = said.find(x => /^a claim without arrival at .*: re-placed half way to the claimant at/.test(x));
  t.truthy(claim, said.join('\n'));
  const [first, second] = luresDown(p);
  t.truthy(second);
  const was = /claimant at \((-?\d+), (-?\d+), (-?\d+)\)/.exec(claim ?? '');
  const by = was ? at(Number(was[1]), Number(was[2]), Number(was[3])) : v.position;
  t.true(flat(second, by) < flat(first, by), `the second lure nearer the claimant: ${Math.round(flat(second, by))} against ${Math.round(flat(first, by))}`);
  t.true(said.some(x => /^ward 00000000 took it in/.test(x)), 'it came');
  t.true(r.gain === 1 || r.mark === 'same', r.text);
  invariants(t, p);
});

test('C7 arrival without the flip (by the lure 10 s, no job taken): a nitwit there, another spot away from it; another villager that takes none, one cell off, once', async (t) => {
  for (const nitwit of [true, false]) {
    const p = homestead({ candidates: 0 });
    // two unemployed adults that never come (they never look), and one put by the first lure as it goes down
    for (const i of [0, 1]) p.villager({ at: at(BELL.x + 4 + 3 * i, 63, BELL.z + 2 * i), mind: 'still', id: 500 + i });
    await prepared(t, p);
    let l0: Pos | undefined;
    p.on.call.place = (params) => {
      if (l0) return undefined;
      l0 = cellOf({ x: Number(params.x), y: Number(params.y), z: Number(params.z) });
      p.villager({ at: at(l0.x + 1, l0.y, l0.z), mind: 'still', id: 520, ...(nitwit ? { profession: 'nitwit' } : {}) });
      return undefined;
    };
    const r = await trip(p);
    const said = saidOf(p);
    t.true(said.some(x => new RegExp(`^a villager stood by the lure at .* 10 s and took no job${nitwit ? ' \\(a nitwit\\): another spot' : ': one cell off'}$`).test(x)), said.join('\n'));
    const [first, second] = luresDown(p);
    t.truthy(second, 'a second spot');
    if (nitwit) t.true(flat(second, first) >= 8, `away from it: ${Math.round(flat(second, first))}`);
    else t.true(cheb(second, first) <= 2 && key(second) !== key(first), `one cell off: ${key(second)} by ${key(first)}`);
    t.deepEqual(peekFetch(p.world).wards, [], 'nobody by it became the ward');
    t.regex(r.text, /^no claim at the village/);
    invariants(t, p);
  }
});

test('C5 no spare inside 96: a second villager took the lure as the ward came to it, and the bot carries no other: the lure changes hands, the newcomer is the ward, the first home, jobless, as found', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-694, 63, 2121) });
  const { v } = led(p, { at: at(-700, 63, 2120), lure: at(-700, 63, 2121), state: 'hop', toGate: 140, over: { bell: { ...BELL } } });
  p.take('fletching_table', 4);
  // an unemployed adult by the next lure as it goes down: it takes it first
  let other: Villager | undefined;
  p.on.call.place = (params) => {
    if (other) return undefined;
    const c = cellOf({ x: Number(params.x), y: Number(params.y), z: Number(params.z) });
    other = p.villager({ at: at(c.x + 1, c.y, c.z + 1), mind: 'game', id: 530, bell: { ...BELL } });
    return undefined;
  };
  // (once it has changed hands, two lures found in a chest of the bot's: the LOCK takes two)
  const refill = () => { if (saidOf(p).some(x => /changes hands/.test(x))) p.give('fletching_table', 2); else p.at(p.tick + 20, refill); };
  p.at(p.tick + 20, refill);
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.true(said.some(x => /^no spare: the lure at .* changes hands to 00000000; 00000000 home, jobless, as found$/.test(x)), said.join('\n'));
  t.truthy(other);
  t.is(v.profession, 'none', 'the first ward jobless, as found');
  t.false(peekFetch(p.world).wards.some(w => w.uuid === v.uuid), 'off the records');
  t.true(r.end === 'hall' || r.end === 'lock' || r.end === 'released', r.text);
  if (r.end === 'hall') t.true(inBox(HALL_BOX, other!.position), 'the newcomer led home');
  invariants(t, p, { ward: other?.uuid });
});

test('D18 gone after a hit (a death nobody saw: out of the look within 3 s of a fall in its health): dead, not searched for; halt; its lifts no longer held for it', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  const { v } = led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  // hit as it comes to the next lure (the watch looks every half second), gone a second and a half after
  let hit = false;
  p.on.call.place = () => { if (!hit) { hit = true; p.at(p.tick + 40, () => p.hurt(v, 3)); p.at(p.tick + 70, () => { v.dead = true; }); } return undefined; };
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'dead', r.text);
  t.regex(r.text, /as its health fell .*: dead, not searched for/);
  const f = peekFetch(p.world);
  t.is(f.wards[0]?.where, 'dead');
  t.truthy(f.halt);
  const gone = p.log.find(e => e.tod >= 0 && e.name === 'world.entities' && e.t >= p.tick - 1)?.t ?? p.tick;
  t.false(p.walks.some(w => w.t >= gone - 200 && w.to.z < 2124 && w.careful && w.from.z > 2126), 'no search walk');
  t.false(wardOut(p.world, p.now()), 'the lifts no longer held for a dead ward');
  invariants(t, p, { leftOut: true });
});

test('D19 a player comes by beyond the release range (committed): held while the clock has slack (paused, the lure standing), then on to the hall; during LOCK a player comes: the step ends first', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-638, 63, 2116) });
  led(p, { at: at(-640, 63, 2118), lure: at(-640, 63, 2119), state: 'hop', committed: 'far', toGate: 92 });
  const pl = p.animal('player', at(-630, 63, 2125));
  let following = true;
  const follow = () => { if (!following) return; pl.position = { x: p.bot.at.x + 0.5, y: 63, z: p.bot.at.z + 6.5 }; p.at(p.tick + 20, follow); };
  follow();
  p.at(p.tick + 90 * 20, () => { following = false; pl.position = { x: -900.5, y: 63, z: 2400.5 }; });
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.true(said.some(x => /^paused: a player at /.test(x)), said.join('\n'));
  t.false(said.some(x => /^released/.test(x)));
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  invariants(t, p);
  // a player by the lock as P is held for the ward: the step is not cut, nor paused
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2139) });
  led(q, { at: at(-551, 63, 2141), lure: at(-551, 63, 2140), state: 'yardhop', committed: 'far' });
  q.on.call['gates.hold'] = (params) => {
    if (Number(params.z) === P.z && Number(params.x) === P.x && !q.animals.some(a => a.name === 'player')) q.animal('player', at(-548, 63, 2142));
    return undefined;
  };
  const s = await leadOn(q.ctx, q.clock);
  t.true(saidOf(q).some(x => /^IN THE LOCK at /.test(x)), saidOf(q).join('\n'));
  t.false(saidOf(q).some(x => /^(paused|released|STOPPED)/.test(x)));
  t.true(s.end === 'hall' || s.end === 'lock', s.text);
  invariants(t, q);
});

test('E9 a brewing stand by the way in (a small holder: what drops with it picked up): lifted at PREP, held while the ward is out, put back once it is in the hall', async (t) => {
  const p = homestead({ candidates: 1 });
  const stand = at(-547, 63, 2160);
  p.set(stand, 'brewing_stand[has_bottle_0=true,has_bottle_1=false,has_bottle_2=false]');
  p.mine(stand);
  await prepared(t, p);
  t.is(idOf(p.get(stand)), 'air', 'lifted');
  t.true(p.count('brewing_stand') >= 1, 'carried');
  t.true(peekFetch(p.world).journal.some(e => e.k === 'lift' && key(e.at) === key(stand) && /^brewing_stand\[/.test(e.block)), 'its whole state journaled');
  const r = await trip(p);
  t.is(r.gain, 1, r.text);
  t.is(idOf(p.get(stand)), 'brewing_stand', 'put back');
  t.is(p.count('brewing_stand'), 0);
  t.false(peekFetch(p.world).journal.some(e => e.k === 'lift'));
  invariants(t, p);
});

test('D27 an iron golem in the lane (never a target): waited 10 s, it stays: the hop aside of it (the way 3 off it), and on', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-638, 63, 2116) });
  led(p, { at: at(-640, 63, 2118), lure: at(-640, 63, 2119), state: 'hop', committed: 'far', toGate: 92 });
  const golem = p.animal('iron_golem', at(-629, 63, 2118), { health: 100 });
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.true(said.some(x => /^an iron golem in the lane at \(-629, 63, 2118\): waited$/.test(x)), said.join('\n'));
  t.true(said.some(x => /^the iron golem stays at .*: the hop aside of it$/.test(x)));
  const first = hopsSaid(p)[0];
  t.truthy(first);
  t.true(Math.abs(first.to.z - 2118) >= 2 || first.to.x > -629 + 3 || first.to.x < -629 - 3, `aside of it: ${key(first.to)}`);
  t.false(p.log.some(e => e.kind === 'act' && e.name === 'attack-entity' && String(e.params.target) === `#${golem.id}`), 'never a target');
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  invariants(t, p);
});

test('D29 a pause at 1700 (before 2000 the lure is no pin: an employed villager strolls from its block): the ward found again 20 off its lure, waited for to come back by it, the lure broken with it within 16 (it resets), and on', async (t) => {
  const p = homestead({ tod: 1_700, candidates: 0, at: at(-642, 63, 2116) });
  // it strolled 20 off its lure while the bot was held (by a player, a meal, a zombie)
  const lure = at(-640, 63, 2119);
  const { v } = led(p, { at: at(-640, 63, 2139), lure, state: 'hop', committed: 'far', toGate: 92 });
  const breaks: number[] = [];
  p.on.call['dig.here'] = (params) => {
    if (Number(params.x) === lure.x && Number(params.z) === lure.z) breaks.push(flat(v.position, { x: lure.x + 0.5, z: lure.z + 0.5 }));
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.true(said.some(x => /^the ward 2\d off its lure at \(-640, 63, 2119\) \(no pin before 2000\): waited for it to come back by it$/.test(x)), said.join('\n'));
  t.is(breaks.length, 1);
  t.true(breaks[0] <= 16, `broken with the ward ${breaks[0].toFixed(1)} off`);
  t.false(said.some(x => /broken with the ward \d+ off/.test(x)), 'no break with the ward beyond 16');
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  invariants(t, p);
});

test('E23 it stops in the gateway: never shut on it, the lure 2 farther in and the cap to 35 s, then through; it turned back at P: P shut, led back to S_out, again, and in', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2112) });
  const { v } = led(p, { at: at(-551, 63, 2114), lure: at(-551, 63, 2115), state: 'hop', committed: 'far', toGate: 3 });
  // it stands in the gateway 12 s
  const holder = at(-700, 75, 2200);
  p.set(holder, 'stone');
  p.snag(NORTH, [holder]);
  let snagged: number | undefined;
  const watchIt = () => { if (key(cellOf(v.position)) === key(NORTH)) { snagged = p.tick; p.at(p.tick + 240, () => p.set(holder, 'air')); } else p.at(p.tick + 2, watchIt); };
  p.at(p.tick + 2, watchIt);
  // (tick by tick: never a tick with it in the gate's cell and the gate shut)
  const shutOnIt: number[] = [];
  const onIt = () => { if (key(cellOf(v.position)) === key(NORTH) && !isOpen(p.get(NORTH))) shutOnIt.push(p.tick); p.at(p.tick + 1, onIt); };
  p.at(p.tick + 1, onIt);
  const r = await leadOn(p.ctx, p.clock);
  t.truthy(snagged, 'it stood in the gateway');
  t.deepEqual(shutOnIt, [], 'never shut on it while it stood in the gateway');
  const yardLures = luresDown(p).filter(c => c.z > NORTH.z && c.x === NORTH.x);
  t.true(yardLures.some(c => c.z === NORTH.z + 7), `the lure 2 farther in: ${yardLures.map(key).join(' ')}`);
  const held = /^gate \(-549, 63, 2119\) held (\d+) s; shut, read shut/.exec(saidOf(p).find(x => /^gate \(-549, 63, 2119\) held/.test(x)) ?? '');
  t.truthy(held, saidOf(p).join('\n'));
  t.true(Number(held![1]) > 12 && Number(held![1]) <= 36, `held ${held![1]} s`);
  // never shut on it: the gate read shut only once it was through
  const shut = p.changed.find(c => key(c.at) === key(NORTH) && !isOpen(c.to) && c.t > snagged!);
  t.truthy(shut);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  invariants(t, p);
  // turned back at P: held outside P's cell for 30 s, then free
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2139) });
  led(q, { at: at(-551, 63, 2141), lure: at(-551, 63, 2140), state: 'yardhop', committed: 'far' });
  const h2 = at(-700, 75, 2201);
  q.set(h2, 'stone');
  let snags = false;
  q.on.call['gates.hold'] = (params) => {
    if (snags || Number(params.x) !== P.x || Number(params.z) !== P.z) return undefined;
    // (as P opens for it, it stops in P's lane, outside the gate's cell, for 30 s)
    snags = true;
    for (let x = -557; x <= -555; x++) q.snag(at(x, 63, 2138), [h2]);
    q.at(q.tick + 600, () => q.set(h2, 'air'));
    return undefined;
  };
  const s = await leadOn(q.ctx, q.clock);
  const said = saidOf(q);
  t.true(said.some(x => /^not in the lock in 25 s \(try 1 of 3\): led back to S_out$/.test(x)), said.join('\n'));
  t.true(said.some(x => /^IN THE LOCK at /.test(x)));
  t.true(s.end === 'hall' || s.end === 'lock', s.text);
  invariants(t, q);
});

test('E24 a cow follows the ward into the lock: P shut on both (a cow is no villager), DOOR waits for no villager: the ward on into the hall, the cow said for the lead', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2139) });
  const { v } = led(p, { at: at(-551, 63, 2141), lure: at(-551, 63, 2140), state: 'yardhop', committed: 'far' });
  let cow: { position: Pos } | undefined;
  p.on.call['gates.hold'] = (params) => { if (!cow && Number(params.x) === P.x && Number(params.z) === P.z) p.at(p.tick + 30, () => { cow = p.animal('cow', at(-557, 63, 2136)); }); return undefined; };
  const r = await leadOn(p.ctx, p.clock);
  t.truthy(cow);
  t.is(r.end, 'hall', r.text);
  t.true(inBox(HALL_BOX, v.position));
  t.true(saidOf(p).some(x => /^a cow shut in the lock at \(-557, 63, 2136\): the lead leads it out/.test(x)), saidOf(p).join('\n'));
  t.false(isOpen(p.get(P)));
  t.false(isOpen(p.get(H)));
  invariants(t, p);
});

test('E30 without the sill it takes the lure from the yard (the fault): the socket\'s lure up, the ward back to S_out, the socket again; never in, stopped, halt; with the sill it enters', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2139) });
  p.set(p.world.zones!['lock:sill'][0], 'air');
  // (and P's lane shut by a block of the bot's: the socket's one reach cell is the sill's, outside)
  p.set(at(-556, 63, 2138), 'oak_planks');
  p.mine(at(-556, 63, 2138));
  led(p, { at: at(-551, 63, 2141), lure: at(-551, 63, 2140), state: 'yardhop', committed: 'far' });
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.true(said.some(x => /^the ward took the lock's lure from the yard side at .*: the socket's lure up, the ward led back to S_out$/.test(x)), said.join('\n'));
  t.false(said.some(x => /^IN THE LOCK/.test(x)));
  t.is(r.end, 'stopped', r.text);
  t.truthy(peekFetch(p.world).halt);
  invariants(t, p, { leftOut: true });
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2139) });
  led(q, { at: at(-551, 63, 2141), lure: at(-551, 63, 2140), state: 'yardhop', committed: 'far' });
  const s = await leadOn(q.ctx, q.clock);
  t.true(saidOf(q).some(x => /^IN THE LOCK at /.test(x)));
  t.false(saidOf(q).some(x => /from the yard side/.test(x)));
  t.true(s.end === 'hall' || s.end === 'lock', s.text);
  invariants(t, q);
});

test('E34 the ward in a pen (the cow pen\'s gate left open): a lure 3 outside the pen\'s gate, the gate held as G is (journal first, renewed, released shut), the ward out, and on to the hall; the cows stay in', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-555, 63, 2174) });
  const gate = p.world.zones!['pen:cow:gate'][0];
  const { v } = led(p, { at: at(-556, 63, 2170), lure: at(-555, 63, 2170), state: 'yardhop', committed: 'far' });
  const cows = () => p.animals.filter(a => a.name === 'cow' && a.position.x >= -558 && a.position.x <= -552 && a.position.z >= 2165 && a.position.z <= 2171).length;
  const before = cows();
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.true(said.some(x => /^the ward in the cow pen: out by its gate at /.test(x)), said.join('\n'));
  t.true(said.some(x => /^out of the cow pen; its gate shut, read shut$/.test(x)));
  const hold = p.log.find(e => e.name === 'gates.hold' && Number(e.params.x) === gate.x && Number(e.params.z) === gate.z);
  t.truthy(hold, 'the pen\'s gate held');
  t.false(isOpen(p.get(gate)), 'the pen\'s gate shut');
  t.is(cows(), before, 'the cows stay in');
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.true(inBox(HALL_BOX, v.position) || inBox(LOCK_BOX, v.position));
  invariants(t, p);
});

test('S1 review #11: the pen\'s gate is held 25 s at most from its hold (INV-3), whatever the walk to the lure and the far side cost: the bot far off when the ward is found in the pen, and it does not come out', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-545, 63, 2212) });
  led(p, { at: at(-556, 63, 2170), lure: at(-555, 63, 2170), state: 'yardhop', committed: 'far', over: { mind: 'still' } });
  const r = await leadOn(p.ctx, p.clock);
  t.true(saidOf(p).some(x => /^the ward in the cow pen: out by its gate at /.test(x)), saidOf(p).join('\n'));
  t.is(r.end, 'stopped', r.text);
  t.regex(r.text, /not out of the cow pen by its gate in 25 s/);
  t.false(isOpen(p.get(p.world.zones!['pen:cow:gate'][0])), 'the pen\'s gate shut');
  invariants(t, p, { leftOut: true });
});

test('E35 the socket\'s lure put in early (the evening before, its way shut: P shut) is late: the game\'s search fails, its retry backoff grows, and once P opens the ward waits it out (in LOCK\'s order, the happy trip: in under 10 s)', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-553, 63, 2136) });
  // the hall's own lectern taken up for this: the socket's lure the one free site about
  p.set(at(-553, 63, 2127), 'air');
  p.set(SOCKET, 'fletching_table');
  const v = p.villager({ at: SOUT, mind: 'game', id: 600, bell: { ...WEST_BELL } });
  t.false(isOpen(p.get(P)));
  p.advance(40 * 20);
  t.is(v.profession, 'none', 'no way to it with P shut');
  const opened = p.tick;
  p.swing(P, true, 'a click');
  let inAt: number | undefined;
  for (let i = 0; i < 1200 && inAt === undefined; i++) { p.advance(1); if (inBox(LOCK_BOX, v.position)) inAt = p.tick; }
  t.truthy(inAt, 'in the lock at last');
  t.true(inAt! - opened > 200, `in ${((inAt! - opened) / 20).toFixed(1)} s after P opened: late`);
  invariants(t, p, { leftOut: true });
});

// ------------------------------------------------------------------------------------------------ the S1 review's findings

test('S1 review S6: villager-moves {enabled:false} during a live lead lets a trip not committed go by its village (the lure up with it by it, off the records); a committed one is finished', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-694, 63, 2121) });
  led(p, { at: at(-700, 63, 2120), lure: at(-700, 63, 2121), state: 'hop', toGate: 160, yard: 18 });
  p.world.villagerMoves = false;
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'released', r.text);
  t.regex(r.text, /villager moves switched off/);
  const f = peekFetch(p.world);
  t.deepEqual(f.wards, []);
  t.false(f.journal.some(e => e.k === 'lure'), 'the lure up');
  t.is(idOf(p.get(at(-700, 63, 2121))), 'air');
  invariants(t, p);
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(q, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  q.world.villagerMoves = false;
  const s = await leadOn(q.ctx, q.clock);
  t.true(s.end === 'hall' || s.end === 'lock', s.text);
});

test('S1 review S5: a lead that ends by a throw that is no cut (a bug\'s path) runs the exit handler all the same: the ward astray at its tether, the trip cut for care\'s row 3, the lead\'s hold gone', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  const own = p.ctx.own!;
  const ctx = { ...p.ctx, own: { ...own, take: async () => { throw new TypeError('the reply is not as expected'); } } };
  await t.throwsAsync(leadOn(ctx, p.clock), { message: /not as expected/ });
  const f = peekFetch(p.world);
  t.regex(f.trip?.cut?.why ?? '', /^the lead failed: the reply is not as expected/);
  t.is(f.trip?.state, 'yardhop', 'where it was');
  t.is(f.wards[0]?.where, 'astray');
  t.deepEqual(f.wards[0]?.tether, at(-550, 63, 2124), 'at its tether');
  t.not(out.ledBy, ctx.signal, 'the lead\'s hold gone: care\'s row 3 is owed');
});

test('S1 review S5: a ward taken off the records beside the lead (the brain\'s gate watch: someone has it) ends the trip as a ward let be ends: its lure up, the trip on to RESTORE, never left in its state', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  let n = 0;
  p.on.call.place = () => { if (++n === 1) p.at(p.tick + 40, () => { fetchOf(p.world).wards = []; }); return undefined; };
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'dropped', r.text);
  const f = peekFetch(p.world);
  t.is(f.trip?.state, 'restore');
  t.false(f.journal.some(e => e.k === 'lure'), 'its lure up');
  t.is(f.halt, undefined, 'no halt: someone has it');
  t.not(out.ledBy, p.ctx.signal);
});

test('S1 review #6: one look that failed in the hop loop is no loss (gone is 3 s, as the watch has it): no search, led on', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  let failed = false;
  p.on.call['world.entities'] = () => {
    if (!failed && p.said.some(x => /^villagers: hop \d+:/.test(x))) { failed = true; throw new Error('timed out'); }
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  t.true(failed, 'a look failed after a hop');
  t.false(saidOf(p).some(x => /^lost the ward from sight/.test(x)), saidOf(p).join('\n'));
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
});

test('S1 review #3: LOCK decides which side the ward ended on by the read after P shut: one that stepped in after the last poll is in the lock, on to DOOR (not led back to S_out, not stopped)', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-553, 63, 2138) });
  const { v } = led(p, { at: at(-553.5, 63, 2139.5), lure: SOUT, state: 'yardhop', committed: 'far', over: { mind: 'still' } });
  p.on.call['gates.release'] = (q: Record<string, unknown>) => {
    if (Number(q.x) === P.x && Number(q.z) === P.z) v.position = { x: -555.5, y: 63, z: 2135.5 };
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  t.log(saidOf(p).join('\n'));
  t.is(r.end, 'lock', r.text);
  const f = peekFetch(p.world);
  t.is(f.wards[0]?.where, 'lock');
  t.is(f.trip?.state, 'door');
  t.is(f.halt, undefined);
  t.false(isOpen(p.get(P)));
});

test('S1 review #2: UNWEDGE step 1 puts the lure down on the still ward\'s other side (a cell by it, no hop\'s least progress asked of it), then the lift; nothing of the bot\'s to lift outside the yard: stopped', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-549, 63, 2110) });
  const w = at(-549, 63, 2108);
  led(p, { at: { x: w.x + 0.5, y: 63, z: w.z + 0.5 }, lure: at(-549, 63, 2106), state: 'hop', committed: 'far', toGate: 10 });
  p.snag([w, { ...w, y: 64 }]);
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.log(said.join('\n'));
  t.true(said.some(x => /: the lure to its other side$/.test(x)), 'step 1');
  const places = p.changed.filter(c => c.how === 'placed' && idOf(c.to) === 'fletching_table');
  t.true(places.length >= 2, `${places.length} lures down`);
  const [first, second] = places.slice(-2);
  const dot = (first.at.x - w.x) * (second.at.x - w.x) + (first.at.z - w.z) * (second.at.z - w.z);
  t.true(dot < 0, `the second (${key(second.at)}) on the other side of the ward from the first (${key(first.at)}), not the gate's spot again`);
  t.true(flat(second.at, w) <= 8, 'by it');
  t.is(r.end, 'stopped', r.text);
  t.regex(r.text, /stalled: wedged/);
});

test('S1 review #5: UNWEDGE never lifts a chest or a bed of the bot\'s (a chest dug spills its stacks; a bed\'s break moves the spawn): stalled, the chest stands', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-548, 63, 2132) });
  const chest = at(-544, 63, 2128);
  p.set(chest, 'chest[facing=north,type=single,waterlogged=false]');
  p.mine(chest);
  const { v } = led(p, { at: at(-544, 63, 2127), lure: at(-546, 63, 2124), state: 'yardhop', committed: 'far' });
  p.snag([at(-544, 64, 2127), at(-544, 63, 2127)], [chest]);
  // (the bench and the pavilion's fence by it, D28's, out of the way: only the chest holds it)
  for (const c of [at(-543, 63, 2127), at(-545, 63, 2127), at(-544, 63, 2126), at(-543, 63, 2128), at(-545, 63, 2128), at(-543, 63, 2126), at(-545, 63, 2126)]) if (!/^(air|short_grass)$/.test(idOf(p.get(c)))) p.set(c, 'air');
  const r = await leadOn(p.ctx, p.clock);
  t.log(saidOf(p).filter(x => /wedged|lift/.test(x)).join('\n'));
  t.is(idOf(p.get(chest)), 'chest', 'the chest stands');
  t.false(p.log.some(e => e.name === 'dig.here' && key({ x: Number(e.params.x), y: Number(e.params.y), z: Number(e.params.z) }) === key(chest)), 'never dug');
  t.is(r.end, 'stopped', r.text);
  t.is(cellOfPos(v.position).z, 2127);
});
const cellOfPos = (q: Pos): Pos => ({ x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) });

test('S1 review #4: a lane\'s strays outside the fence: the step against the gate alone is the bot\'s to dig (E1), a bank of a stray kind 2 or 3 out is the land\'s (the west gate\'s natural rise): not dug, the gate refused, another taken', async (t) => {
  const p = homestead();
  const bank = [at(-549, 63, 2117), at(-549, 64, 2117), at(-549, 63, 2116)], step = at(-549, 64, 2118);
  for (const c of bank) p.set(c, 'dirt');
  p.set(step, 'cobblestone');
  const r = await prepNow(p);
  t.true(r.prepared, r.text);
  t.not(peekFetch(p.world).trip?.gate.side, 'north', 'not the north gate');
  for (const c of bank) t.is(idOf(p.get(c)), 'dirt', `the bank at ${key(c)} stands`);
  t.is(idOf(p.get(step)), 'cobblestone', 'nothing of it dug while the bank stands beyond it');
  t.false(p.log.some(e => e.name === 'dig.here' && bank.some(c => key(c) === key({ x: Number(e.params.x), y: Number(e.params.y), z: Number(e.params.z) }))));
  invariants(t, p);
});

test('S1 review S1: RESTORE holds a lure that tethers a ward still out (a pin beyond 96 made its villager a second ward): not taken up while it is astray at it; once it is off the wards, undone; the halt the pin asked for is said as the trip ends', (t) => {
  const p = homestead({ candidates: 0 });
  const f = fetchOf(p.world), now = p.now(), pin = at(-600, 63, 2125);
  f.journal.push({ k: 'lure', id: 1, trip: 9, at: { ...pin }, item: 'fletching_table', st: 'down', role: 'pin', t: now });
  const w: Ward = { key: 'u2', uuid: 'u2', from: { site: 'village -720,2128', at: { ...BELL } }, since: now, bell: true, where: 'astray', tether: { ...pin }, note: 'pinned', last: { at: { ...pin }, t: now, tod: 3000, health: 20, profession: 'fletcher' }, health0: 20 };
  f.wards.push(w);
  let r = restoreOrder(p.world, now);
  t.deepEqual(r.todo.map(e => key(e.at)), [], 'not taken up');
  t.deepEqual(r.held.map(e => key(e.at)), [key(pin)], 'held for the lead');
  f.wards = [];
  r = restoreOrder(p.world, now);
  t.deepEqual(r.todo.map(e => key(e.at)), [key(pin)]);
  // the trip's own record of it (lure.ts pin): the halt when the trip ends, however it ends
  f.trip = { id: 9, kind: 'bring', site: 'village -720,2128', state: 'hop', beat: now, prep: {}, gate: { at: at(-549, 63, 2119), side: 'north', inner: at(-549, 63, 2121), outer: at(-549, 63, 2117), yard: 18 }, spare: [], lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 1 }, haltAtEnd: 'a second villager pinned beyond 96' } as Trip;
  endTrip(p.ctx, 'released at somewhere', 0, now);
  t.regex(peekFetch(p.world).halt?.why ?? '', /a second villager pinned beyond 96/);
});

test('S1 review S2: a hop begun just before the bell (committed, run on) whose walk to the stand ends past 8990 puts no lure down outside the fence: STOPPED there (INV-4)', async (t) => {
  const p = homestead({ tod: 8_930, candidates: 0, at: at(-640, 63, 2118) });
  led(p, { at: at(-640, 63, 2117), lure: at(-640, 63, 2116), state: 'hop', committed: 'far', toGate: 90 });
  const r = await leadOn(p.ctx, p.clock);
  t.log(saidOf(p).join('\n'));
  t.is(r.end, 'stopped', r.text);
  t.regex(r.text, /the clock/);
  invariants(t, p, { leftOut: true });
});

test.serial('S1 review S3: the critical section is renewed with every hold of P (and of G): the walk to the post, the wait for a clear lock and the open spell never let it lapse while a gate is held', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-549, 63, 2172) });
  const real = Date.now;
  Date.now = () => p.now();
  t.teardown(() => { Date.now = real; });
  // (it stands in P's cell, working at S_out, and goes no farther: the open spell runs to its 35 s)
  led(p, { at: at(-555.5, 63, 2137.5), lure: SOUT, state: 'yardhop', committed: 'far', over: { mind: 'still' } });
  // a cow by P's lane, gone 9 s into LOCK's wait (its looks a second apart from the walk to the post on)
  const cow = p.animal('cow', at(-556, 63, 2139));
  let posted = false, looks = 0;
  p.on.call.goto = (q: Record<string, unknown>) => { if (Number(q.x) === -553 && Number(q.z) === 2136) posted = true; return undefined; };
  p.on.call['world.entities'] = () => { if (posted && ++looks === 9) cow.position = { x: -540.5, y: 63, z: 2180.5 }; return undefined; };
  const seen: { held: boolean; why?: string; left: number }[] = [];
  p.on.call['gates.hold'] = (q: Record<string, unknown>) => {
    if (Number(q.x) === P.x && Number(q.z) === P.z) seen.push({ held: true, why: out.critical?.why, left: (out.critical?.until ?? 0) - Date.now() });
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  t.log(r.text, saidOf(p).join('\n'));
  t.true(seen.length > 5, `${seen.length} holds of P`);
  for (const s of seen) t.true(s.why === 'lock' && s.left > 40_000, `a hold of P under a section with ${Math.round(s.left / 1000)} s left (${s.why})`);
});

test('S1 follow-up V-1 (#7 at G): G that does not read shut after the ward is through (the hold released, a click refused) is said with halt, and the ward is led on into the yard to the lock (it holds by itself), never freed beside the open G: it never walks back out by it, and ends in the hall', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-549, 63, 2112) });
  const G = YARD_GATES.north;
  const { v } = led(p, { at: at(-550, 63, 2112), lure: at(-550, 63, 2114), state: 'hop', committed: 'far', toGate: 4 });
  // (from the release on, G will not shut: under redstone power, which the closer never clicks, its click refused)
  let through = false;
  p.on.call['gates.release'] = (q: Record<string, unknown>) => {
    if (Number(q.x) !== G.x || Number(q.z) !== G.z) return undefined;
    if (!through) p.set(G, 'oak_fence_gate[facing=north,in_wall=false,open=true,powered=true]', 'powered');
    through = true;
    return { released: true, open: true };
  };
  p.on.call.useOn = (q: Record<string, unknown>) => (through && Number(q.x) === G.x && Number(q.z) === G.z ? { used: false, reason: 'refused' } : undefined);
  // where the ward stands, tick by tick, once it is through
  let outAgain = false;
  const track = () => { if (through && v.position.z < G.z) outAgain = true; p.at(p.tick + 1, track); };
  p.at(p.tick + 1, track);
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.log(said.join('\n'));
  t.true(through, 'the ward through G, its release refused');
  t.true(said.some(x => /^the north gate at \(-549, 63, 2119\) does not read shut behind the ward \(trip 9\): care's row 1 keeps on at it; the ward led on to the lock$/.test(x)), 'said');
  t.regex(peekFetch(p.world).halt?.why ?? '', /the north gate at \(-549, 63, 2119\) does not read shut behind the ward/, 'halt: the lead looks at G');
  t.false(said.some(x => /^STOPPED/.test(x)), 'no STOP by the open gate');
  t.false(outAgain, 'the ward never back outside the fence by the open G');
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  t.true(inBox(HALL_BOX, v.position) || inBox(LOCK_BOX, v.position), `the ward in the hall or the lock (${key(cellOf(v.position))})`);
});

test('S1 follow-up V-1 (#7 at G, not through): G that will not shut with the ward still outside is a STOP that leaves the yard\'s lure standing inside as the ward\'s tether (drawn in, not freed by the open G); halt names where the ward is, not the last hop\'s cell', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-549, 63, 2112) });
  const G = YARD_GATES.north;
  // (it works at the gate's spot and goes no farther: never through in the cap)
  const { v } = led(p, { at: at(-547.5, 63, 2114.5), lure: at(-548, 63, 2114), state: 'hop', committed: 'far', toGate: 2, over: { mind: 'still' } });
  fetchOf(p.world).trip!.state = 'gate';
  fetchOf(p.world).wards[0].last.at = at(-600, 63, 2120);
  p.saved = JSON.stringify(p.world);
  let released = false;
  p.on.call['gates.release'] = (q: Record<string, unknown>) => {
    if (Number(q.x) !== G.x || Number(q.z) !== G.z) return undefined;
    if (!released) p.set(G, 'oak_fence_gate[facing=north,in_wall=false,open=true,powered=true]', 'powered');
    released = true;
    return { released: true, open: true };
  };
  p.on.call.useOn = (q: Record<string, unknown>) => (released && Number(q.x) === G.x && Number(q.z) === G.z ? { used: false, reason: 'refused' } : undefined);
  const r = await leadOn(p.ctx, p.clock);
  t.log(saidOf(p).join('\n'));
  t.is(r.end, 'stopped', r.text);
  t.regex(r.text, /the north gate at \(-549, 63, 2119\) does not read shut/);
  const f = peekFetch(p.world);
  const yardLure = f.journal.find(e => e.k === 'lure' && e.role === 'yard');
  t.truthy(yardLure, 'the yard\'s lure left standing');
  t.true(inBox(YARD_BOX, yardLure!.at) && yardLure!.at.z > G.z, 'inside the fence');
  t.is(idOf(p.get(yardLure!.at)), 'fletching_table');
  t.deepEqual(f.wards[0]?.tether, yardLure!.at, 'the ward astray at it: RESTORE holds it while the ward is out');
  t.true(restoreOrder(p.world, p.now()).held.some(e => key(e.at) === key(yardLure!.at)));
  t.regex(f.halt?.why ?? '', /^STOPPED at \(-54[789], 63, 211[3-6]\)/, `the halt names where the ward was seen (${f.halt?.why})`);
  t.true(flat(v.position, G) < 8);
});

test('S1 review #12 (E13\'s real-yard pin): the yard as the bot read it on Nov 25 (tests/fixtures/yard-2026-11-25.json): each gate\'s lane as PREP reads it, and the villager\'s way across the yard to S_out from each gate that has one', async (t) => {
  const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'yard-2026-11-25.json'), 'utf8')) as { yard: { x1: number; z1: number; x2: number; z2: number; y: number }; ground: Parameters<typeof Ground.fromDump>[0] };
  const g = Ground.fromDump(d.ground);
  const yardG: YardGround = { ...d.yard, built: [] };
  const ctx = { world: { yard: d.yard }, progress: () => undefined } as unknown as Parameters<typeof laneWhy>[0];
  const sides = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as const;
  const got: Record<string, string> = {};
  for (const [side, [dx, dz]] of Object.entries(sides) as [keyof typeof sides, readonly [number, number]][]) {
    const gate = YARD_GATES[side];
    const inner = { x: gate.x - 2 * dx, y: gate.y, z: gate.z - 2 * dz }, outer = { x: gate.x + 2 * dx, y: gate.y, z: gate.z + 2 * dz };
    const lane = await laneWhy(ctx, g, { gate, side, inner, outer } as Parameters<typeof laneWhy>[2], 'dry');
    const w = yardWay(g, { gate, side, inner }, SOUT, { yard: yardG, ring: RING });
    got[side] = `lane ${lane ?? 'free'}; way ${w.ok ? `${w.len} cells` : w.text}`;
  }
  t.log(Object.entries(got).map(([k, v]) => `${k}: ${v}`).join('\n'));
  // (the north, east and west lanes run into the land's own rise 3 out: not the bot's to dig, so not those gates; the
  // south lane is free, and its way waits on the cobblestone at (-553, 63, 2192), a stray of the bot's inside the fence:
  // the tidy round's, or the lead's. On THIS yard the first live PREP would decline with these words. The live yard is
  // no longer it: on Nov 27 it grew 16 north (z1 2103, the north gate at (-549, 63, 2103), the chapel in the new strip),
  // so this pins the code on the Nov 25 ground only; rollout step 3 wants a fresh dump and these checks run on it first)
  t.regex(got.north, /^lane dirt in the north gate's lane at \(-549, 63, 2116\), 3 outside the fence: not the bot's to dig; way \d+ cells$/);
  t.regex(got.east, /^lane dirt in the east gate's lane at \(-530, 63, 2183\), 3 outside the fence: not the bot's to dig; /);
  t.regex(got.west, /^lane dirt in the west gate's lane at \(-568, 63, 2183\), 3 outside the fence: not the bot's to dig; /);
  t.regex(got.south, /^lane free; way .*\(cobblestone of the bot's scaffold\) at \(-553, 63, 2192\)$/);
});
/** The portal's ring as built (4.7): x -564..-555, z 2145..2149. */
const RING = { x1: -564, z1: 2145, x2: -555, z2: 2149 };

// ------------------------------------------------------------------------------------------------ the S1 follow-up (fixes of the fixer's fixes)

test('S1 follow-up V-2 (#2, the far case): a ward wedged a hop\'s length from the lure it could not reach (D28\'s: wedged mid-hop) gets UNWEDGE step 1 all the same: the lure on its other side, by it (the direction mirrored, not the distance), never "no cell for a lure on the other side"', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-641, 63, 2118) });
  const w = at(-640, 63, 2117);
  led(p, { at: { x: w.x + 0.5, y: 63, z: w.z + 0.5 }, lure: at(-638, 63, 2117), state: 'hop', committed: 'far', toGate: 90 });
  p.snag([w, { ...w, y: 64 }]);
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.log(said.filter(x => /wedged|stalled|STOP|other side|hop/.test(x)).join('\n'));
  t.true(said.some(x => /: the lure to its other side$/.test(x)), 'step 1');
  t.false(said.some(x => /no cell for a lure on the other side/.test(x)), 'a cell found on the other side');
  const places = p.changed.filter(c => c.how === 'placed' && idOf(c.to) === 'fletching_table').map(c => c.at);
  const step = said.findIndex(x => /: the lure to its other side$/.test(x));
  t.true(places.length >= 2, `${places.length} lures down`);
  // the lure it could not reach (a hop on, toward the gate) and the one after it, on the ward's other side
  const [hop, other] = places.slice(-2);
  t.true(flat(hop, w) >= 8, `the hop's lure ${key(hop)} a hop's length off (${flat(hop, w).toFixed(1)})`);
  const dot = (hop.x - w.x) * (other.x - w.x) + (hop.z - w.z) * (other.z - w.z);
  t.true(dot < 0, `the next (${key(other)}) on the other side of the ward from ${key(hop)}`);
  t.true(flat(other, w) <= 13, `by it (${flat(other, w).toFixed(1)})`);
  t.true(step >= 0);
  t.is(r.end, 'stopped', r.text);
  invariants(t, p, { leftOut: true });
});

test('S1 follow-up V-5 (S2 at G): a bell-alive ward\'s gate step stands G open past no bell: begun at 8940-8975, nothing opened (the take and the walk through would end past it); begun at 8700 with a ward that does not come, the open spell ends at the bell, shut; tried again near it, no lure down outside the fence from 8990 (INV-4)', async (t) => {
  const cases: { tod: number; still?: true }[] = [{ tod: 8_940 }, { tod: 8_960 }, { tod: 8_975 }, { tod: 8_700, still: true }, ...[8_380, 8_400, 8_420, 8_440, 8_460, 8_480].map(tod => ({ tod, still: true as const }))];
  for (const { tod, still } of cases) {
    const p = homestead({ tod, candidates: 0, at: at(-551, 63, 2113) });
    const G = YARD_GATES.north;
    led(p, { at: at(-547.5, 63, 2114.5), lure: at(-548, 63, 2114), state: 'hop', committed: 'far', toGate: 2, ...(still ? { over: { mind: 'still' as const } } : {}) });
    fetchOf(p.world).trip!.state = 'gate';
    p.saved = JSON.stringify(p.world);
    const r = await leadOn(p.ctx, p.clock);
    t.log(tod, still ? 'still' : 'game', r.end, r.text);
    const clicks = p.log.filter(e => e.name === 'useOn' && Number(e.params.x) === G.x && Number(e.params.z) === G.z && e.tod >= 8990 && e.tod < 12_000 && !isOpen(p.changed.filter(c => key(c.at) === key(G) && c.t <= e.t).at(-1)?.to ?? 'open=false'));
    t.deepEqual(clicks.map(e => e.tod), [], `${tod}: no click opening G from the bell`);
    // (G's state at 9000 and after, from its changes: the time of day runs a tick a tick with the pasture's clock)
    const todAt = (tick: number) => p.tod - (p.tick - tick);
    const gs = p.changed.filter(c => key(c.at) === key(G));
    const at9000 = gs.filter(c => todAt(c.t) < 9000).at(-1);
    t.false(!!at9000 && isOpen(at9000.to), `${tod}: G open at 9000 (since tod ${at9000 && Math.round(todAt(at9000.t))})`);
    t.deepEqual(gs.filter(c => todAt(c.t) >= 9000 && isOpen(c.to)).map(c => Math.round(todAt(c.t))), [], `${tod}: G opened from 9000`);
    t.false(isOpen(p.get(G)), `${tod}: G shut at the end`);
    t.true(r.end === 'stopped' || r.end === 'hall' || r.end === 'lock', r.text);
    invariants(t, p, { leftOut: true });
  }
});

// ------------------------------------------------------------------------------------------------ the yard whole (the yard follow-up: R1, R2, R4, R5)

/** The yard's records broken the ways Nov 27's growth broke them (yardgates.ts yardWhy), one at a time. */
const yardBreaks: [string, (p: Pasture) => void, RegExp][] = [
  ['the fence moving out', p => { p.world.fenceMove = { side: 'north', old: { ...p.world.yard! } }; }, /the yard is not whole: the fence is moving out to the north/],
  ['the box grown, the ring not', p => { p.world.yard = { ...p.world.yard!, z1: p.world.yard!.z1 - 16 }; }, /the yard is not whole: the fence is not up round the yard as it stands/],
  ['the zones taken down with the old side', p => { delete p.world.zones!.fence; delete p.world.zones!['fence:gate']; }, /the yard is not whole: the fence is not up round the yard/],
  ['a gate off the line', p => { p.world.zones!['fence:gate'].push({ x: -550, y: 63, z: 2150 }); }, /the yard is not whole: 1 of the yard's 5 gate\(s\) off its fence line/]
];

test('S1 follow-up R2: PREP declines on a yard that is not whole on the records (each of Nov 27\'s ways), with a growth asked for, and on a fence that is not whole as blocks (a post dug; a step against it inside); nothing lifted, no trip left', async (t) => {
  for (const [name, broke, why] of yardBreaks) {
    const p = homestead();
    broke(p);
    const r = await prepNow(p);
    t.false(r.ok, name);
    t.regex(r.text, why, name);
    t.is(peekFetch(p.world).trip, undefined, name);
    t.is(idOf(p.get(SMITHING)), 'smithing_table', `${name}: nothing lifted`);
  }
  const g = homestead();
  g.world.yardGrow = { width: 9, length: 9, why: 'a chapel', at: g.now() } as NonNullable<typeof g.world.yardGrow>;
  t.regex((await prepNow(g)).text, /not prepared: a yard growth is asked for \(9x9 for a chapel\): the yard grows first/);
  const d = homestead();
  d.set(at(-540, 63, 2119), 'air');
  t.regex((await prepNow(d)).text, /not prepared: the yard's fence: a gap in the yard's fence at \(-540, 63, 2119\)/);
  const s = homestead();
  s.set(at(-536, 63, 2120), 'crafting_table');
  t.regex((await prepNow(s)).text, /not prepared: the yard's fence: a step against the yard's fence at \(-536, 63, 2120\) \(crafting_table\)/);
  t.is(peekFetch(s.world).trip, undefined);
});

test('S1 follow-up R2 (the dawn path P1): PREP\'s read and kit in the evening, the yard grown and its side taken down in the night: the dawn\'s lifts on the old stamps decline, nothing lifted; a prepared trip whose gate went, or whose yard is not whole, is not set out at dawn', async (t) => {
  const p = homestead({ tod: 7_000 });
  const r = await prepNow(p);
  t.regex(r.text, /read and kit done; the lifts from 9000/);
  p.advance(23_600 - 7_000);
  delete p.world.zones!.fence;
  delete p.world.zones!['fence:gate'];
  const u = await prepNow(p);
  t.false(u.ok, u.text);
  t.regex(u.text, /the yard is not whole/);
  t.is(idOf(p.get(SMITHING)), 'smithing_table', 'nothing lifted on the old stamps');
  t.is(peekFetch(p.world).trip, undefined, 'the trip dropped (no entry of it)');
  // prepared, then the yard broken before dawn: not set out (reread)
  for (const [name, broke, why] of yardBreaks) {
    const q = homestead();
    await prepared(t, q);
    broke(q);
    const from = q.log.length;
    const s = await trip(q);
    t.regex(s.text, new RegExp(`^not set out: ${why.source.replace(/^the yard/, 'the yard')}`), name);
    t.is(peekFetch(q.world).trip?.state, 'restore', name);
    t.false(q.log.slice(from).some(e => e.name === 'place'), `${name}: nothing placed`);
  }
  // the trip's own gate gone from the records (the others whole): not set out by it
  const g = homestead();
  await prepared(t, g);
  g.world.zones!['fence:gate'] = g.world.zones!['fence:gate'].filter(z => !(z.x === NORTH.x && z.z === NORTH.z));
  t.regex((await trip(g)).text, /^not set out: the trip's north gate at \(-549, 63, 2119\) is no longer on the yard's fence/);
  // a dug post: the fence read at dawn
  const d = homestead();
  await prepared(t, d);
  d.set(at(-540, 63, 2119), 'air');
  t.regex((await trip(d)).text, /^not set out: the yard's fence: a gap in the yard's fence at \(-540, 63, 2119\)/);
});

test('S1 follow-up R2: the dawn\'s re-read asks the bridge for the whole strict set: a count that is not the records\' is sent again once, and still another number is no setting out', async (t) => {
  const p = homestead();
  await prepared(t, p);
  await p.ctx.call('gates.strict', { gates: [{ ...NORTH }], pairs: [], guard: [] });
  const from = p.log.length;
  const r = await trip(p);
  t.true(p.log.slice(from).some(e => e.name === 'gates.strict'), 'sent again');
  t.is(r.gain, 1, r.text);
  const q = homestead();
  await prepared(t, q);
  q.on.call['gates.status'] = () => ({ count: 3, strict: [], enabled: true });
  t.regex((await trip(q)).text, /^not set out: the bridge keeps 3 strict gate\(s\), the records 7/);
});

test('S1 follow-up: outByGate\'s {} (no yard gate known) with the bot inside the fence is no setting out by a gap', async (t) => {
  const p = homestead();
  await prepared(t, p);
  // (the gate zones gone between the re-read and the walk out: the sprint's switch is the call between them)
  p.on.call['sprint.set'] = (q: Record<string, unknown>) => { if (q.allowed === false) delete p.world.zones!['fence:gate']; return undefined; };
  const from = p.log.length;
  const r = await trip(p);
  t.regex(r.text, /^not out by the north gate: no gate of the yard's to go out by/);
  t.false(p.log.slice(from).some(e => e.name === 'goto' && !inBox(YARD_BOX, { x: Number(e.params.x), z: Number(e.params.z) })), 'no walk out of the fence');
  t.is(peekFetch(p.world).trip?.state, 'restore');
});

test('S1 follow-up R4: a lead outside the fence that finds the yard not whole goes no farther toward it (committed: stopped, the lure up, halt); inside the fence it goes on to the lock, said once', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-612, 63, 2116) });
  led(p, { at: at(-610, 63, 2118), lure: at(-610, 63, 2117), state: 'hop', committed: 'far', toGate: 60 });
  p.at(p.tick + 40, () => { p.world.fenceMove = { side: 'north', old: { ...p.world.yard! } }; });
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'stopped', r.text);
  t.regex(r.text, /the yard is not whole: the fence is moving out/);
  t.truthy(peekFetch(p.world).halt);
  t.false(p.log.some(e => e.name === 'gates.hold'), 'G never held');
  invariants(t, p, { leftOut: true });
  // not committed, by its village: let go there
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-694, 63, 2121) });
  led(q, { at: at(-700, 63, 2120), lure: at(-700, 63, 2121), state: 'hop', toGate: 160, yard: 18 });
  delete q.world.zones!['fence:gate'];
  const s = await leadOn(q.ctx, q.clock);
  t.is(s.end, 'released', s.text);
  t.regex(s.text, /the yard is not whole/);
  // in the yard: on to the lock
  const y = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(y, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  y.world.fenceMove = { side: 'north', old: { ...y.world.yard! } };
  const u = await leadOn(y.ctx, y.clock);
  t.true(u.end === 'hall' || u.end === 'lock', u.text);
  t.is(saidOf(y).filter(x => /^the yard is not whole \(.*\): on to the lock, which holds by its own gates$/.test(x)).length, 1, 'said once');
});

test('S1 follow-up R4 at G: a gate gone (air, or a fence where the records have a gate) is found before anything is held or taken up (no hold, no walk in): the next gate, or (none) stopped; a dug post anywhere on the fence stops the gate step (no gate leads into a yard open elsewhere)', async (t) => {
  for (const [name, state] of [['air', 'air'], ['a fence', 'oak_fence']] as const) {
    const p = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2113) });
    led(p, { at: at(-547.5, 63, 2114.5), lure: at(-548, 63, 2114), state: 'hop', committed: 'far', toGate: 2 });
    fetchOf(p.world).trip!.state = 'gate';
    p.set(NORTH, state);
    p.saved = JSON.stringify(p.world);
    const r = await leadOn(p.ctx, p.clock);
    t.log(name, r.text);
    t.is(r.end, 'stopped', `${name}: ${r.text}`);
    // (air at G passes the lane's read, which skips the gate's cell: the block read refuses it; a fence there the lane's floor already does)
    t.regex(r.text, state === 'air' ? /no way in by the north gate: no gate stands at \(-549, 63, 2119\) \(air\)/ : /no way in by the north gate: (no gate stands at \(-549, 63, 2119\)|no floor a villager walks at \(-549, 2119\))/);
    t.false(p.log.some(e => e.name === 'gates.hold' && Number(e.params.z) === NORTH.z), `${name}: nothing held at it`);
    t.false(p.walks.some(w => w.to.z > NORTH.z && w.to.z < 2200), `${name}: the bot never walked in`);
  }
  const d = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2113) });
  led(d, { at: at(-547.5, 63, 2114.5), lure: at(-548, 63, 2114), state: 'hop', committed: 'far', toGate: 2 });
  fetchOf(d.world).trip!.state = 'gate';
  d.set(at(-540, 63, 2119), 'air');
  d.saved = JSON.stringify(d.world);
  const r = await leadOn(d.ctx, d.clock);
  t.is(r.end, 'stopped', r.text);
  t.regex(r.text, /the yard's fence: a gap in the yard's fence at \(-540, 63, 2119\)/);
  t.false(d.log.some(e => e.name === 'gates.hold'), 'G never held');
});

// ------------------------------------------------------------------------------------------------ the S1 follow-up: the reviews' notes in the lure's files

test('S1 follow-up N1 (#21): lost() renews the trip\'s beat through its walk and its 60 s search: tripLive never lapses mid-search (fetch-safe, the acting-call guard and the thunder\'s exemption hold), then astray', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  const { v } = led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  // (after the first hop it is seen no more: the looks answer every row but it)
  const stale: number[] = [];
  let hidden = false;
  p.on.call['world.entities'] = (q, pa) => {
    if (!hidden && p.said.some(x => /^villagers: hop \d+:/.test(x))) hidden = true;
    if (!hidden) return undefined;
    if (p.said.some(x => /^villagers: lost the ward from sight/.test(x))) stale.push(pa.now() - (fetchOf(p.world).trip?.beat ?? 0));
    const rows = (pa as unknown as { answer: (m: string, q: Record<string, unknown>) => { entities?: { uuid?: string }[] } }).answer('world.entities', q);
    return { entities: (rows.entities ?? []).filter(e => e.uuid !== v.uuid) };
  };
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'astray', r.text);
  t.true(stale.length >= 10, `${stale.length} looks in the search`);
  t.true(Math.max(...stale) < 10_000, `the beat at most ${Math.round(Math.max(...stale) / 1000)} s old in the search`);
});

test('S1 follow-up #15 (4.6 G step 4): a hostile within 8 outside G while it stands open for the ward, the ward not in the lane: G clicked shut, 3 s, open again; the ward comes through all the same', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2113) });
  const G = YARD_GATES.north;
  led(p, { at: at(-547.5, 63, 2114.5), lure: at(-548, 63, 2114), state: 'hop', committed: 'far', toGate: 2 });
  fetchOf(p.world).trip!.state = 'gate';
  p.saved = JSON.stringify(p.world);
  // a spider 6 out of G as it opens (static: it stays), gone 4 s later
  let spider: ReturnType<typeof p.animal> | undefined;
  p.on.call.place = (q: Record<string, unknown>) => {
    if (!spider && Number(q.z) > G.z) { spider = p.animal('spider', at(-551, 63, 2113)); p.at(p.tick + 80, () => { p.animals = p.animals.filter(a => a !== spider); }); }
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.log(said.filter(x => /spider|gate/.test(x)).join('\n'));
  t.true(said.some(x => /^a spider at \(-551, 63, 2113\) by the north gate: shut 3 s \(1 of 5\)$/.test(x)), 'shut for it');
  const gs = p.changed.filter(c => key(c.at) === key(G));
  const shutAt = gs.findIndex((c, i) => i > 0 && isOpen(gs[i - 1].to) && !isOpen(c.to));
  t.true(shutAt > 0 && gs.slice(shutAt + 1).some(c => isOpen(c.to)), 'shut, then open again');
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  invariants(t, p);
});

test('S1 follow-up #17: DOOR is not begun with a baby within 3 of the socket: waited 30 s, then the door is care\'s (nothing of the socket touched); and P is read shut before each act: one found open is no door', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2138) });
  p.villager({ at: at(-554, 63, 2133), mind: 'still', baby: true, id: 120 });
  led(p, { at: at(-553.5, 63, 2139.5), lure: SOUT, state: 'yardhop', committed: 'far' });
  const r = await leadOn(p.ctx, p.clock);
  t.log(saidOf(p).filter(x => /door|LOCK/.test(x)).join('\n'));
  t.is(r.end, 'lock', r.text);
  t.regex(r.text, /^door: a baby by the socket 30 s: the door is care's/);
  t.true(peekFetch(p.world).journal.some(e => e.k === 'lure' && e.role === 'lock'), 'the socket\'s lure stands (the baby by it)');
  t.false(isOpen(p.get(H)), 'H not opened');
  t.is(peekFetch(p.world).trip?.state, 'door');
  // P opened (someone's click, powered: it will not shut) while DOOR waits for a baby to go off the socket: no socket work and no H
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2138) });
  const baby = q.villager({ at: at(-554, 63, 2133), mind: 'still', baby: true, id: 120 });
  led(q, { at: at(-553.5, 63, 2139.5), lure: SOUT, state: 'yardhop', committed: 'far' });
  let socketOut = false, powered = false;
  q.on.call['dig.here'] = (x: Record<string, unknown>) => { if (Number(x.x) === SOCKET.x && Number(x.z) === SOCKET.z && saidOf(q).some(y => /^IN THE LOCK/.test(y))) socketOut = true; return undefined; };
  q.on.call.useOn = (x: Record<string, unknown>) => (powered && Number(x.x) === P.x && Number(x.z) === P.z ? { used: false, reason: 'refused' } : undefined);
  const waitDoor = () => {
    if (saidOf(q).some(y => /^IN THE LOCK/.test(y))) {
      q.at(q.tick + 100, () => { baby.position = { x: -559.5, y: 63, z: 2128.5 }; powered = true; q.set(P, `${String(q.get(P)).split('[')[0]}[facing=south,in_wall=false,open=true,powered=true]`, 'powered'); });
    } else q.at(q.tick + 5, waitDoor);
  };
  q.at(q.tick + 5, waitDoor);
  const s = await leadOn(q.ctx, q.clock);
  t.log(saidOf(q).filter(x => /door|LOCK/.test(x)).join('\n'));
  t.is(s.end, 'lock', s.text);
  t.regex(s.text, /the lock's gate does not read shut: the door is care's/);
  t.false(socketOut, 'the socket not touched with P open');
  t.false(isOpen(q.get(H)), 'H not opened with P open');
});

test('S1 follow-up #18: a claim holds its ticket up to 60 s: a claimant held 5 off the first lure until 50 s, then free, is waited for and takes it (never broken at 45 with it still on its way)', async (t) => {
  const p = homestead({ candidates: 1 });
  await prepared(t, p);
  const holder = at(-700, 75, 2200);
  p.set(holder, 'stone');
  let l0: Pos | undefined;
  p.on.call.place = (params) => {
    if (l0) return undefined;
    l0 = cellOf({ x: Number(params.x), y: Number(params.y), z: Number(params.z) });
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === 5) p.snag(at(l0.x + dx, l0.y, l0.z + dz), [holder]);
    p.at(p.tick + 50 * 20, () => p.set(holder, 'air'));
    return undefined;
  };
  const r = await trip(p);
  const said = saidOf(p);
  t.log(said.filter(x => /first lure|claim|took it/.test(x)).join('\n'));
  t.false(said.some(x => /^a claim without arrival/.test(x)), 'not broken while the claimant was held');
  const took = said.find(x => /^ward 00000000 took it in (\d+) s/.test(x));
  t.truthy(took, 'it came');
  t.true(Number(/took it in (\d+) s/.exec(took ?? '')?.[1] ?? 0) >= 45, took);
  t.is(luresDown(p).length >= 1 && key(luresDown(p)[0]) === key(l0!), true, 'at the first lure');
  t.true(r.gain === 1 || r.mark === 'same', r.text);
});

test('S1 follow-up #19: SURVEY asks the judge\'s rule its look can see again: a village whose villagers a player has taken up since its whole look (two named) is not lured from: turned back, nothing placed, the site waits', async (t) => {
  const p = homestead({ candidates: 2 });
  await prepared(t, p);
  for (const [i, name] of [[0, 'Bob'], [1, 'Ann']] as const) p.villager({ at: at(BELL.x - 4 - 3 * i, 63, BELL.z - 2 * i), mind: 'still', profession: 'farmer', level: 1, id: 600 + i, customName: name });
  const from = p.log.length;
  const r = await trip(p);
  t.regex(r.text, /^turned back at the village: 2 of its villagers used by a player .*: not free/);
  t.false(p.log.slice(from).some(e => e.name === 'place'), 'nothing placed');
  t.is(p.world.villages!.sites[0].fetch?.kind, 'rival');
  t.is(peekFetch(p.world).trip?.state, 'restore');
});

test('S1 follow-up #3: LOCK reads which side the ward ended on twice when the first look after P shuts fails: a ward in the lock is in, on to DOOR (not led back from it)', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-553, 63, 2138) });
  const { v } = led(p, { at: at(-553.5, 63, 2139.5), lure: SOUT, state: 'yardhop', committed: 'far', over: { mind: 'still' } });
  let released = false, failed = false;
  p.on.call['gates.release'] = (q: Record<string, unknown>) => {
    if (Number(q.x) === P.x && Number(q.z) === P.z) { v.position = { x: -555.5, y: 63, z: 2135.5 }; released = true; }
    return undefined;
  };
  p.on.call['world.entities'] = () => {
    if (released && !failed) { failed = true; throw new Error('timed out'); }
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  t.true(failed, 'the first look after P shut failed');
  t.is(r.end, 'lock', r.text);
  t.is(peekFetch(p.world).trip?.state, 'door');
  t.false(saidOf(p).some(x => /led back to S_out/.test(x)), saidOf(p).join('\n'));
});

test('S1 follow-up #11: the pen\'s gate is held once the bot stands by it (the take and the walk spent before the hold): a ward found in the pen with the bot far off still has the whole 25 s to come out, and comes', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-545, 63, 2212) });
  const gate = p.world.zones!['pen:cow:gate'][0];
  led(p, { at: at(-556, 63, 2170), lure: at(-555, 63, 2170), state: 'yardhop', committed: 'far' });
  const r = await leadOn(p.ctx, p.clock);
  const said = saidOf(p);
  t.log(said.filter(x => /pen|STOP/.test(x)).join('\n'));
  t.true(said.some(x => /^out of the cow pen; its gate shut, read shut$/.test(x)), 'out of the pen');
  // the hold to its release under 25 s and a little, and the bot by the gate at the hold
  const hold = p.log.find(e => e.name === 'gates.hold' && Number(e.params.x) === gate.x && Number(e.params.z) === gate.z)!;
  t.true(flat(hold.at, gate) <= 4, `the bot ${flat(hold.at, gate).toFixed(1)} from the pen's gate at its hold`);
  t.true(r.end === 'hall' || r.end === 'lock', r.text);
  invariants(t, p);
});

// ------------------------------------------------------------------------------------------------ the S1 follow-up V-7: pins for the fixer's fixes that had none

test('S1 follow-up V-7 (S1): DOOR puts back only what stands in the yard: a pin of the trip in the village (no ward tethered to it) is row 7\'s walk out by day, never a walk of DOOR\'s from the lock', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2138) });
  led(p, { at: at(-553.5, 63, 2139.5), lure: SOUT, state: 'yardhop', committed: 'far' });
  const pin = at(-700, 63, 2121);
  p.set(pin, 'fletching_table', 'placed');
  p.mine(pin);
  fetchOf(p.world).journal.push({ k: 'lure', id: 3, trip: 9, at: { ...pin }, item: 'fletching_table', st: 'down', role: 'pin', inVillage: true, t: p.now() });
  p.saved = JSON.stringify(p.world);
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'hall', r.text);
  t.true(peekFetch(p.world).journal.some(e => e.k === 'lure' && key(e.at) === key(pin)), 'the pin left for row 7');
  t.is(idOf(p.get(pin)), 'fletching_table');
  const inLock = p.log.findIndex(e => e.name === 'useOn' && Number(e.params.x) === H.x && Number(e.params.z) === H.z);
  t.false(p.log.slice(Math.max(0, inLock)).some(e => e.name === 'goto' && !inBox(YARD_BOX, { x: Number(e.params.x), z: Number(e.params.z) })), 'no walk out of the yard from the lock');
});

test.serial('S1 follow-up V-7 (S3): every hold of G and of a pen\'s gate is made under a live critical section with most of its 45 s left (renewed with every hold)', async (t) => {
  const real = Date.now;
  t.teardown(() => { Date.now = real; });
  // G: the ward at the gate's spot, going no farther (the open spell runs to its cap, renewed each second)
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2113) });
  Date.now = () => p.now();
  led(p, { at: at(-547.5, 63, 2114.5), lure: at(-548, 63, 2114), state: 'hop', committed: 'far', toGate: 2, over: { mind: 'still' } });
  fetchOf(p.world).trip!.state = 'gate';
  p.saved = JSON.stringify(p.world);
  const seen: { why?: string; left: number; tod: number }[] = [];
  p.on.call['gates.hold'] = (q: Record<string, unknown>) => {
    if (Number(q.z) === NORTH.z && Number(q.x) === NORTH.x) seen.push({ why: out.critical?.why, left: (out.critical?.until ?? 0) - Date.now(), tod: p.tod });
    return undefined;
  };
  await leadOn(p.ctx, p.clock);
  t.true(seen.length > 10, `${seen.length} holds of G`);
  for (const s of seen) t.true(s.why === 'gate' && s.left > 40_000, `a hold of G at ${s.tod} with ${Math.round(s.left / 1000)} s (${s.why})`);
  // the pen's gate: the bot far off, the ward going no farther
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-545, 63, 2212) });
  Date.now = () => q.now();
  const gate = q.world.zones!['pen:cow:gate'][0];
  led(q, { at: at(-556, 63, 2170), lure: at(-555, 63, 2170), state: 'yardhop', committed: 'far', over: { mind: 'still' } });
  const pen: { why?: string; left: number }[] = [];
  q.on.call['gates.hold'] = (x: Record<string, unknown>) => {
    if (Number(x.x) === gate.x && Number(x.z) === gate.z) pen.push({ why: out.critical?.why, left: (out.critical?.until ?? 0) - Date.now() });
    return undefined;
  };
  await leadOn(q.ctx, q.clock);
  t.true(pen.length > 10, `${pen.length} holds of the pen's gate`);
  for (const s of pen) t.true(s.why === 'gate' && s.left > 40_000, `a hold of the pen's gate with ${Math.round(s.left / 1000)} s (${s.why})`);
});

test('S1 follow-up V-7 (S5): a ward taken off the records between two looks of the hop loop ends the trip at the loop\'s next look (dropped), not after a 3 s search for it', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-550, 63, 2134) });
  led(p, { at: at(-550, 63, 2125), lure: at(-550, 63, 2124), state: 'yardhop', committed: 'far' });
  let cleared: number | undefined;
  p.on.call['world.entities'] = () => {
    if (cleared === undefined && p.said.some(x => /^villagers: hop \d+:/.test(x))) { cleared = p.log.length; fetchOf(p.world).wards = []; }
    return undefined;
  };
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'dropped', r.text);
  t.true(cleared !== undefined);
  const looks = p.log.slice(cleared!).filter(e => e.name === 'world.entities').length;
  t.true(looks <= 3, `${looks} looks after it went off the records`);
});

test('S1 follow-up V-7 (#7 for P): P that will not read shut with the ward in the lock is no `lock -> door`: STOPPED, halt; the socket\'s lure stays (the ward works at it inside)', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-553, 63, 2138) });
  led(p, { at: at(-553.5, 63, 2139.5), lure: SOUT, state: 'yardhop', committed: 'far' });
  let rel = false;
  p.on.call['gates.release'] = (q: Record<string, unknown>) => {
    if (Number(q.x) !== P.x || Number(q.z) !== P.z) return undefined;
    if (!rel) p.set(P, `${String(p.get(P)).split('[')[0]}[facing=south,in_wall=false,open=true,powered=true]`, 'powered');
    rel = true;
    return { released: true, open: true };
  };
  p.on.call.useOn = (q: Record<string, unknown>) => (rel && Number(q.x) === P.x && Number(q.z) === P.z ? { used: false, reason: 'refused' } : undefined);
  const r = await leadOn(p.ctx, p.clock);
  t.is(r.end, 'stopped', r.text);
  t.regex(r.text, /the lock's gate at \(-556, 63, 2137\) does not read shut/);
  t.truthy(peekFetch(p.world).halt);
  t.not(peekFetch(p.world).trip?.state, 'door');
  t.true(peekFetch(p.world).journal.some(e => e.k === 'lure' && e.role === 'lock'), 'the socket\'s lure stays');
});

test('S1 follow-up V-7 (#14): a cut inside DOOR (the run awaited to its end in the lead\'s try) runs the exit handler: the trip marked cut, where it was', async (t) => {
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-552, 63, 2138) });
  led(p, { at: at(-553.5, 63, 2139.5), lure: SOUT, state: 'yardhop', committed: 'far' });
  const ac = new AbortController();
  p.on.call.useOn = (q: Record<string, unknown>) => { if (Number(q.x) === H.x && Number(q.z) === H.z && !ac.signal.aborted) p.at(p.tick + 2, () => ac.abort()); return undefined; };
  await t.throwsAsync(leadOn({ ...p.ctx, signal: ac.signal }, p.clock));
  const f = peekFetch(p.world);
  t.is(f.trip?.state, 'door');
  t.truthy(f.trip?.cut, 'cut: care\'s row 3 goes on from it');
});

test('S1 follow-up N7: the dry switch turned on over a trip prepared real (brain.ts writes trip.dry) counts only its real lifts as made: a job block of the bot\'s own off the way (not lifted by PREP) stays a rival its plan keeps 56 off, as the real trip\'s', async (t) => {
  const p = homestead({ candidates: 1 });
  const composter = at(-640, 63, 2158);
  p.set(composter, 'composter[level=0]');
  p.mine(composter);
  p.world.zones!['farm:composter'] = [{ ...composter }];
  await prepared(t, p);
  t.false(peekFetch(p.world).journal.some(e => e.k === 'lift' && key(e.at) === key(composter)), 'not lifted: off the way in');
  // (the switch as brain.ts setFetch turns it on a prepared trip: trip.dry, its lifts made for real)
  fetchOf(p.world).trip!.dry = true;
  const r = await trip(p);
  t.regex(r.text, /^dry run at/);
  const planned = saidOf(p).flatMap(x => { const m = /^dry: (?:hop \d+: .* -> |first lure at )\((-?\d+), (-?\d+), (-?\d+)\)/.exec(x); return m ? [at(Number(m[1]), Number(m[2]), Number(m[3]))] : []; });
  t.log(saidOf(p).filter(x => /^dry:/.test(x)).join('\n'));
  t.true(planned.length > 2, `${planned.length} spots planned`);
  for (const c of planned) t.true(flat(c, composter) >= 56, `a spot at ${key(c)}, ${Math.round(flat(c, composter))} from the bot's own composter`);
});

test.serial('S1 follow-up Y-1: the trip\'s beat is renewed through the gate step\'s and the lock\'s walks and waits, not in their poll loops alone: the trip resumed on a beat 10 min old, every walk inside them with no gate held 38 s (the bridge\'s cap is 40); inside either section it is never 55 s old (a walk and 15 s: tripLive\'s 90, and with it the lead\'s 20 minutes, hold there with a margin)', async (t) => {
  const real = Date.now;
  t.teardown(() => { Date.now = real; });
  // every bridge call of the lead's inside a 'gate' or 'lock' section, the beat's age before and after it; and every
  // walk there (a careful goto: walkTo's, own.take's and own.put's) made 38 s long while the bridge holds no gate (with
  // one held, the walk in by G, it is the pasture's own: 20 s of hold would not cover 38 s). Under 55 s, not 90: what
  // the pasture answers at once (the reads, a put's walk into reach) takes the game seconds more
  const watched = (p: Pasture, why: 'gate' | 'lock') => {
    const ages: { age: number; call: string; tod: number }[] = [];
    let heldTill = 0;
    const note = (call: string) => { if (out.critical?.why === why) ages.push({ age: p.now() - (fetchOf(p.world).trip?.beat ?? 0), call, tod: p.tod }); };
    p.on.call.goto = () => { if (out.critical?.why === why && p.now() >= heldTill) { p.advance(38_000 / 50); note('goto (38 s)'); } return undefined; };
    const ctx = p.ctx, call = ctx.call;
    const call2 = async <T>(m: string, q?: Record<string, unknown>) => {
      note(m);
      if (m === 'gates.hold') heldTill = p.now() + Number(q?.ms ?? 0);
      if (m === 'gates.release') heldTill = 0;
      const r = await call<T>(m, q);
      note(m);
      return r;
    };
    return { ages, ctx: { ...ctx, call: call2 } };
  };
  const worst = (ages: { age: number; call: string; tod: number }[]) => ages.reduce((a, b) => (b.age > a.age ? b : a));
  // G: the ward at the gate's spot going no farther (V-7 S3's): three tries, each a walk in and a walk back out
  const p = homestead({ tod: 3_000, candidates: 0, at: at(-551, 63, 2113) });
  Date.now = () => p.now();
  led(p, { at: at(-547.5, 63, 2114.5), lure: at(-548, 63, 2114), state: 'hop', committed: 'far', toGate: 2, over: { mind: 'still' } });
  Object.assign(fetchOf(p.world).trip!, { state: 'gate', beat: p.now() - 10 * 60_000 });
  p.saved = JSON.stringify(p.world);
  const g = watched(p, 'gate');
  await leadOn(g.ctx, p.clock);
  t.log(saidOf(p).join('\n'));
  const slowG = g.ages.filter(a => a.call === 'goto (38 s)').length;
  t.true(slowG >= 3, `${slowG} walks of 38 s in the gate step`);
  t.true(g.ages.filter(a => a.call === 'gates.hold').length > 10, 'G held');
  const gw = worst(g.ages);
  t.log(`the gate step: the beat at most ${Math.round(gw.age / 1000)} s old (${gw.call})`);
  t.true(gw.age < 55_000, `in the gate step the beat ${Math.round(gw.age / 1000)} s old at ${gw.call} (time of day ${gw.tod})`);
  // P: a resume in `lock` (care's: its beat stale), the bot far from the post, a cow by P's lane gone 9 s into the wait
  const q = homestead({ tod: 3_000, candidates: 0, at: at(-549, 63, 2172) });
  Date.now = () => q.now();
  led(q, { at: at(-555.5, 63, 2137.5), lure: SOUT, state: 'yardhop', committed: 'far', over: { mind: 'still' } });
  Object.assign(fetchOf(q.world).trip!, { state: 'lock', beat: q.now() - 10 * 60_000 });
  q.saved = JSON.stringify(q.world);
  const cow = q.animal('cow', at(-556, 63, 2139));
  let posted = false, looks = 0;
  const l = watched(q, 'lock');
  const slow = q.on.call.goto!;
  q.on.call.goto = (x: Record<string, unknown>, pa) => { const r = slow(x, pa); if (Number(x.x) === -553 && Number(x.z) === 2136) posted = true; return r; };
  q.on.call['world.entities'] = () => { if (posted && ++looks === 9) cow.position = { x: -540.5, y: 63, z: 2180.5 }; return undefined; };
  await leadOn(l.ctx, q.clock);
  t.log(saidOf(q).join('\n'));
  t.true(l.ages.some(a => a.call === 'goto (38 s)'), 'the walk to the post, 38 s');
  t.true(l.ages.filter(a => a.call === 'gates.hold').length > 5, 'P held');
  const lw = worst(l.ages);
  t.log(`LOCK: the beat at most ${Math.round(lw.age / 1000)} s old (${lw.call})`);
  t.true(lw.age < 55_000, `in LOCK the beat ${Math.round(lw.age / 1000)} s old at ${lw.call} (time of day ${lw.tod})`);
});
