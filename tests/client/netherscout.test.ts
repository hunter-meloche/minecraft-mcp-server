import test from 'ava';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  CORRIDOR, LEG_LEAST, SCOUT_AGAIN_MS, SCOUT_BEHIND, SCOUT_REACH, WAY_EVERY, aheadBox, bearingOf, frameOf, furthest, lakesBy, offLine, outAlong, scoutBearing,
  scoutGround, scoutOpen, scoutReady, scoutRun, waypoints
} from '../../src/client/brain/netherscout.js';
import { BARTER_WAITS, KNOCK_GAP, LAVA_GAP, overDrop } from '../../src/client/brain/netherbarter.js';
import { FROM_BUILDS, SETUP_WAITS, boxGap, boxOf, footing, walkFrom, zoneBox, type Box, type NetherZone } from '../../src/client/brain/nethersetup.js';
import {
  BEARINGS, NETHER, OVERWORLD, SITES, WAYPOINTS, netherLine, netherOf, noteSites, peekNether, portalCells, type Bearing, type PortalShape, type ScoutLeg
} from '../../src/client/brain/nether.js';
import { LADDER, NETHER_KIT_MS, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals } from '../../src/client/brain/work.js';
import { T0, liveWorld, lookAt } from '../helpers/homestead.js';
import { KIT, ROOM_ZONE, game, gridOf, k, netherGround, setupWorld, type Mob } from '../helpers/netherworld.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
BARTER_WAITS.pollMs = 0;

/** Its own Nether-side portal where the setup trip builds it in the test Nether (dug into the cliff west of x -77, along z, its door east at z 267). */
const OWN: PortalShape = { x: -79, y: 70, z: 266, axis: 'z', width: 2, height: 3 };
const OWN_BOX = boxOf(portalCells(OWN));
const ORES = '-547,63,2180';
const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });

/** The nether rung's goal on the real ladder, its clock at `now`. */
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;

type Game = ReturnType<typeof game>;
type Blocks = [Pos, string][];

/**
 * The setup trip run through (its hut built, its portal lit, linked), then stage 2 as four clean trips open it, on
 * game day 7, the quartz at its target and no gold over the barter's reserve (so the rung's turn is the scouting's);
 * and a game of the world as it left it, two hours on, with `blocks` put in the Nether and `opts`.
 */
async function afterSetup(blocks: Blocks = [], opts: Parameters<typeof game>[1] = {}) {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  Object.assign(netherOf(w), { stage: 2, stageTrips: 4, cleanTrips: 4 });
  w.idle = { today: { day: 7 } as never, days: [] };
  w.chestItems![ORES].quartz = 64;
  const later = T0 + 2 * HOUR;
  const changed = [...first.changed, ...blocks.map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))];
  const f = game(w, { items: first.inv, after: { changed, lit: first.lit }, now: later, ...opts });
  return { w, first, later, f };
}

/** Legs walked an hour ago along `bearings` (the next is then the first of the others). */
const walkedLegs = (w: WorldMemory, bearings: Bearing[], when: number) => {
  netherOf(w).legs = bearings.map((bearing, i) => ({ bearing, at: when - HOUR + i, reach: SCOUT_REACH, end: "the leg's 96 walked", way: [] }));
};

const netherWalks = (f: Game) => f.walks.filter(x => x.dim === NETHER);
/** The trip's own changes down there (the setup's hut excepted). */
const changedHere = (f: Game, first: Game) => f.changed.filter(c => c.dim === NETHER && !first.changed.some(o => k(o.at) === k(c.at)));

/**
 * Two lava lakes in the floor by the way north (12 and 9 cells), a natural fortress well off to the east of it (its 16
 * clear of the way), and a crimson forest from z 220 on north.
 */
const LAKES: Blocks = [];
for (let x = -72; x <= -70; x++) for (let z = 230; z <= 233; z++) LAKES.push([at(x, 69, z), 'lava']);
for (let x = -70; x <= -68; x++) for (let z = 190; z <= 192; z++) LAKES.push([at(x, 69, z), 'lava']);
const FORT: NetherZone = { x1: -50, y1: 66, z1: 200, x2: -36, y2: 80, z2: 215, markers: 60, surface: true, sample: 'nether_bricks', natural: 'fortress' };
const CRIMSON = (p: Pos) => (p.z < 220 ? 'minecraft:crimson_forest' : 'minecraft:nether_wastes');

/** Every walk down there careful, within the leg's corridor along its bearing, 16 from every zone, no lava within 2. */
function walkedKindly(t: { true: (v: boolean, m?: string) => void }, f: Game, bearing: Bearing, zones: NetherZone[]) {
  const fr = frameOf(OWN_BOX, bearing);
  for (const x of netherWalks(f)) {
    t.true(x.careful, k(x.to));
    t.true(offLine(fr, x.to) <= CORRIDOR && outAlong(fr, x.to) <= SCOUT_REACH && outAlong(fr, x.to) >= -SCOUT_BEHIND, `${k(x.to)} off the leg`);
    for (const z of zones) t.true(boxGap(zoneBox(z), cellBox(x.to)) >= FROM_BUILDS, `${k(x.to)} by a zone`);
    for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) for (let dy = -1; dy <= 1; dy++) {
      t.true(!/^lava/.test(f.get(NETHER, { x: x.to.x + dx, y: x.to.y + dy, z: x.to.z + dz })), `${k(x.to)} by lava`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ a leg end to end

test.serial('a scouting leg: through to its own hut, out on foot along the bearing least known (the north, none walked yet) to 96, what it passed kept as sites with the leg, the way it took as waypoints, back the same way and through its own portal; said as `nether: scouted 96 to the north: ...`; a clean trip', async (t) => {
  const zones = [ROOM_ZONE, FORT];
  const { w, first, later, f } = await afterSetup(LAKES, { zones, biome: CRIMSON });
  t.is(rung(later).wants(lookAt(f.inv, 1000, { now: later }), w), 'scout: in the nether');
  const text = await rung(later).run(f.ctx);
  t.is(text, "[scout] scouted 96 to the north: a fortress at nether (-43, 73, 207) (natural), 2 lava lakes, a crimson forest from 49 out; the leg's 96 walked; back at overworld (-562, 65, 2191); back home");
  t.deepEqual(f.said.filter(l => /^(nether|scout): /.test(l)), [
    'nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)',
    'scout: a leg to the north from its portal at nether (-79, 70, 266): never scouted, no site known that way',
    'nether: scouted 96 to the north: a fortress at nether (-43, 73, 207) (natural), 2 lava lakes, a crimson forest from 49 out'
  ]);
  // nothing dug or placed down there; every walk careful, along the north's corridor, 16 from the zones, 2 from lava
  t.deepEqual(changedHere(f, first), []);
  walkedKindly(t, f, 'north', zones);
  // the leg kept: the way it took, from its hut's front room on, a waypoint every 8 cells walked, the last at 96 out
  const n = peekNether(w);
  t.is(n.legs?.length, 1);
  const leg = n.legs![0];
  t.like(leg, { bearing: 'north', at: later, reach: 96, end: "the leg's 96 walked" });
  t.deepEqual(leg.way[0], at(-77, 70, 267));
  t.deepEqual(leg.way[leg.way.length - 1], at(-76, 70, 171));
  t.true(leg.way.length <= WAYPOINTS);
  for (let i = 1; i < leg.way.length; i++) {
    const a = leg.way[i - 1], b = leg.way[i];
    t.true(Math.abs(a.x - b.x) + Math.abs(a.z - b.z) <= WAY_EVERY, `${k(a)} -> ${k(b)}`);
  }
  // the sites, each with the leg that found it (the pool behind its hut is the look's, inside its 24)
  t.deepEqual(n.sites.map(s => `${s.kind} ${k(s)} ${s.leg}`), [
    'fortress -43,73,207 north', 'lava -72,69,230 north', 'lava -70,69,190 north', 'crimson_forest -76,70,218 north'
  ]);
  // back the way it came: from the furthest, south along the cells it walked out (x -76, then its hut's door), to its
  // hut's front room
  const walks = netherWalks(f).map(x => x.to);
  const turn = walks.findIndex(p => k(p) === k(at(-76, 70, 171)));
  t.true(turn > 0);
  const back = walks.slice(turn + 1);
  t.deepEqual(back.at(-1), at(-77, 70, 267));
  for (let i = 1; i < back.length; i++) t.true(back[i].z > back[i - 1].z && back[i].x >= -77 && back[i].x <= -75, `${k(back[i - 1])} -> ${k(back[i])}`);
  // a clean trip: the leg was its work
  t.like(peekNether(w), { stageTrips: 5, lastTrip: { end: 'clean' } });
  t.is(f.state.dim, OVERWORLD);
  t.is(w.work?.last?.gain, 1);
  t.regex(netherLine(w, later), /; 4 site\(s\) known; 1\/8 bearings scouted; last trip/);
});

test.serial('the leg keeps 16 from anyone\'s build on the way: the east goes round the south of the community\'s room by its 16 and on to 96', async (t) => {
  const { w, later, f } = await afterSetup();
  walkedLegs(w, ['north', 'north-east'], later);
  const text = await rung(later).run(f.ctx);
  t.is(text, "[scout] scouted 96 to the east: nothing of note; the leg's 96 walked; back at overworld (-562, 65, 2191); back home");
  walkedKindly(t, f, 'east', [ROOM_ZONE]);
  // (some of the way 16 from the room's box: as near as the rule lets it)
  t.true(netherWalks(f).some(x => boxGap(zoneBox(ROOM_ZONE), cellBox(x.to)) === FROM_BUILDS));
  t.like(peekNether(w).legs?.[0], { bearing: 'east', reach: 96 });
});

test.serial('a zone come in on the way (the bridge\'s scan follows the bot) is kept from at once: the walk is planned again, the leg ends where its 16 closes the way, and the build is a site of the leg', async (t) => {
  // someone's build across the way north, which the scan shows once the bot is past z 245
  const theirs: NetherZone = { x1: -95, y1: 66, z1: 196, x2: -55, y2: 80, z2: 206, markers: 40, surface: true, sample: 'stone_bricks' };
  const { w, later, f } = await afterSetup();
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'foreign.zones' && f.state.dim === NETHER) return { dimension: NETHER, zones: f.state.pos.z < 245 ? [{ ...ROOM_ZONE }, { ...theirs }] : [{ ...ROOM_ZONE }] };
    return call(m, p);
  }) as GoalContext['call'];
  const r = await scoutRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'scouted 45 to the north: 1 build of others (the nearest at nether (-75, 73, 201)); the way on closed 45 out; back at overworld (-562, 65, 2191)');
  t.like(r, { gain: 1, worked: true, cameBack: true });
  walkedKindly(t, f, 'north', [ROOM_ZONE, theirs]);
  t.like(peekNether(w).sites[0], { kind: 'build', x: -75, y: 73, z: 201, leg: 'north' });
});

// ------------------------------------------------------------------------------------------------ turning back

test.serial('it turns back at half the trip\'s time: half of what was left as it set foot out, at the first look past it, and walks back the way it came', async (t) => {
  // (ten seconds a look at the clock: 4 minutes for the trip, all of it left on arriving down there)
  let clock = T0 + 2 * HOUR;
  const { w, f } = await afterSetup([], { onLook: () => { clock += 10_000; } });
  const set = clock;
  const r = await scoutRun(f.ctx, 4 * MINUTE, () => clock);
  t.is(r.text, 'scouted 45 to the north: nothing of note; turned back at half its time, 45 out; back at overworld (-562, 65, 2191)');
  t.like(r, { gain: 1, worked: true, cameBack: true });
  // twelve looks of ten seconds: the second half of the 4 minutes is the way back's
  t.is(clock - set, 2 * MINUTE);
  t.like(peekNether(w).legs?.[0], { bearing: 'north', reach: 45, end: 'turned back at half its time, 45 out' });
  t.deepEqual(netherWalks(f).at(-1)?.to, at(-77, 70, 267));
});

test.serial('a walk on the way back that does not arrive (a mob in the way) is tried once more from the cell of the way nearest where it stands; home through its own portal', async (t) => {
  let clock = T0 + 2 * HOUR;
  const { f } = await afterSetup([], { onLook: () => { clock += 10_000; } });
  const call = f.ctx.call;
  let turned = false, failed = 0;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    // (the first walk south once it has turned back: not arrived, the bot where it was)
    if (m === 'goto' && f.state.dim === NETHER && turned && failed === 0 && Number(p?.z) > f.state.pos.z) { failed++; return { arrived: false }; }
    if (m === 'goto' && f.state.dim === NETHER && clock - (T0 + 2 * HOUR) >= 2 * MINUTE) turned = true;
    return call(m, p);
  }) as GoalContext['call'];
  const r = await scoutRun(f.ctx, 4 * MINUTE, () => clock);
  t.is(failed, 1);
  t.is(r.text, 'scouted 45 to the north: nothing of note; turned back at half its time, 45 out; back at overworld (-562, 65, 2191)');
  t.like(r, { worked: true, cameBack: true });
  t.deepEqual(netherWalks(f).at(-1)?.to, at(-77, 70, 267));
});

test.serial('a ghast in sight at its hut sends it back before the leg: no leg walked, the bearing left as it was (the next trip tries it again), the trip turned back (its trip of the day given back, the mark as for a danger)', async (t) => {
  const near: Mob = { id: 31, name: 'ghast', position: { x: -72.5, y: 74, z: 262.5 } };
  const { w, later, f } = await afterSetup([], { mobs: [near] });
  const text = await rung(later).run(f.ctx);
  t.is(text, '[scout] no leg walked to the north; a ghast in sight (5 off); back at overworld (-562, 65, 2191); back home');
  const n = peekNether(w);
  t.is(n.legs, undefined);
  t.deepEqual(n.sites, []);
  t.like(n, { stageTrips: 4, lastTrip: { end: 'turned back' } });
  t.is(n.tripsToday, undefined);
  t.like(w.work!.dry['nether:scout'], { n: 1, at: later });
  t.like(scoutBearing(w, later), { bearing: 'north' });
});

test.serial('a hoglin come near once the leg is past 24 out: back at once, and the leg is kept as walked (its work done), the danger its end', async (t) => {
  const { w, later, f } = await afterSetup();
  const call = f.ctx.call;
  let came = false;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await call(m, p);
    if (m === 'goto' && f.state.dim === NETHER && !came && f.state.pos.z < 230) { came = true; f.mobs.push({ id: 30, name: 'hoglin', position: { x: f.state.pos.x + 6, y: 70, z: f.state.pos.z } }); }
    return r;
  }) as GoalContext['call'];
  const r = await scoutRun(f.ctx, HOUR, () => later);
  t.is(r.text, 'scouted 41 to the north: nothing of note; a hoglin near (6 off); back at overworld (-562, 65, 2191)');
  t.like(r, { gain: 1, worked: true, cameBack: true });
  t.false('mark' in r);
  const leg = peekNether(w).legs?.[0];
  t.like(leg, { bearing: 'north', reach: 41, end: 'a hoglin near (6 off)' });
  t.true(leg!.reach >= LEG_LEAST);
});

test.serial('a bearing whose ground goes no further (the south: the cliff west, the community\'s room\'s 16 across the way): the leg is kept, so the next trip takes the next bearing; no leg walked, the trip turned back, the bearing marked dry as an empty place is', async (t) => {
  const { w, later, f } = await afterSetup();
  walkedLegs(w, ['north', 'north-east', 'east', 'south-east'], later);
  const text = await rung(later).run(f.ctx);
  t.is(text, '[scout] no leg walked to the south; the way on closed 1 out; back at overworld (-562, 65, 2191); back home');
  const n = peekNether(w);
  t.like(n.legs?.[0], { bearing: 'south', reach: 1, end: 'the way on closed 1 out', way: [at(-77, 70, 267)] });
  t.like(n, { stageTrips: 4, lastTrip: { end: 'turned back' } });
  t.is(n.tripsToday, undefined);
  t.like(w.work!.dry['nether:scout'], { n: 1, at: later });
  t.like(scoutBearing(w, later), { bearing: 'south-west' });
});

test.serial('a leg turned back at half its time before 24 out: no leg walked, the bearing left as it was (the next trip tries it again), the mark as for a danger, the trip turned back', async (t) => {
  // (30 s a look at the clock: 4 minutes for the trip, half of it gone 13 out)
  let clock = T0 + 2 * HOUR;
  const { w, f } = await afterSetup([], { onLook: () => { clock += 30_000; } });
  const set = clock;
  const r = await scoutRun(f.ctx, 4 * MINUTE, () => clock);
  t.is(r.text, 'no leg walked to the north; turned back at half its time, 13 out; back at overworld (-562, 65, 2191)');
  t.like(r, { gain: 0, mark: 'same', cameBack: true });
  t.false('worked' in r);
  t.is(clock - set, 2 * MINUTE);
  t.is(peekNether(w).legs, undefined);
  t.like(scoutBearing(w, clock), { bearing: 'north', why: 'never scouted, no site known that way' });
});

// ------------------------------------------------------------------------------------------------ the ghast and drops' edges

/** Every walk down there that ends within KNOCK_GAP of a drop's edge, on the ground as the game has it. */
const knockEdges = (f: Game, from = 0) => {
  const g = gridOf(p => f.get(NETHER, p), { x1: -100, y1: 55, z1: 160, x2: -50, y2: 95, z2: 280 });
  return netherWalks(f).slice(from).map(x => x.to).filter(p => overDrop(g, p, KNOCK_GAP)).map(k);
};
/** A trench 6 deep at x -74 beside the way north (z 236..252): the way by the cliff (x -76) is 2 from its edge; east of it the floor goes on. */
const TRENCH: Blocks = [];
for (let z = 236; z <= 252; z++) for (let y = 64; y <= 69; y++) TRENCH.push([at(-74, y, z), 'air']);

test.serial('P3b: the leg walks 2 from every drop\'s edge wherever the ground lets it (its way back is the same cells, walked blind): a trench beside the way north, a ghast come in sight past it sends the bot back, and no walk out or back ends at the edge', async (t) => {
  const ghast: Mob = { id: 31, name: 'ghast', position: { x: -70.5, y: 78, z: 222.5 } };
  let g: Game | undefined;
  let came = false;
  const { w, later, f } = await afterSetup(TRENCH, { onLook: () => { if (g && !came && g.state.dim === NETHER && g.state.pos.z <= 234) { g.mobs.push({ ...ghast }); came = true; } } });
  g = f;
  const r = await scoutRun(f.ctx, HOUR, () => later);
  t.true(came);
  t.is(r.text, 'scouted 34 to the north: nothing of note; a ghast in sight (14 off); back at overworld (-562, 65, 2191)');
  t.like(r, { gain: 1, worked: true, cameBack: true });
  t.deepEqual(knockEdges(f), []);
  // (round the trench by the east, and back the same way to its hut's front room)
  t.true(netherWalks(f).some(x => x.to.x > -74 && x.to.z >= 236 && x.to.z <= 252));
  t.deepEqual(netherWalks(f).at(-1)?.to, at(-77, 70, 267));
  t.like(peekNether(w).legs?.[0], { bearing: 'north', reach: 34, end: 'a ghast in sight (14 off)' });
  // with no ghast it keeps off the edge all the same: the way it walks is the one a later trip follows
  const calm = await afterSetup(TRENCH);
  const r2 = await scoutRun(calm.f.ctx, HOUR, () => calm.later);
  t.is(r2.text, "scouted 96 to the north: nothing of note; the leg's 96 walked; back at overworld (-562, 65, 2191)");
  t.deepEqual(knockEdges(calm.f), []);
});

/** A chasm 6 deep across the floor east of x -75 for z 250..255: the only way north a ledge at x -76 by the cliff, 2 from its edge. */
const LEDGE: Blocks = [];
for (let x = -74; x <= -40; x++) for (let z = 250; z <= 255; z++) for (let y = 64; y <= 69; y++) LEDGE.push([at(x, y, z), 'air']);

test.serial('P3b: a ghast watched (24 off) with the way on only by a drop\'s edge: back as from a danger, the bearing not written (the ghast closed it, not the ground), the mark as for a danger, the trip turned back; with none about the leg goes on along the ledge', async (t) => {
  const ghast: Mob = { id: 31, name: 'ghast', position: { x: -55.5, y: 82, z: 252.5 } };
  const { w, later, f } = await afterSetup(LEDGE, { mobs: [ghast] });
  // (an old dry mark long run out: the run's own leaves it at its count)
  w.work!.dry['nether:scout'] = { n: 2, at: later - 3 * HOUR };
  const text = await rung(later).run(f.ctx);
  t.is(text, "[scout] no leg walked to the north; a ghast about (24 off): the way on only by a drop's edge, 9 out; back at overworld (-562, 65, 2191); back home");
  const n = peekNether(w);
  t.is(n.legs, undefined);
  t.like(n, { stageTrips: 4, lastTrip: { end: 'turned back' } });
  t.is(n.tripsToday, undefined);
  t.deepEqual(w.work!.dry['nether:scout'], { n: 2, at: later });
  t.like(scoutBearing(w, later), { bearing: 'north' });
  t.deepEqual(knockEdges(f), []);
  const calm = await afterSetup(LEDGE);
  const r = await scoutRun(calm.f.ctx, HOUR, () => calm.later);
  t.is(r.text, "scouted 96 to the north: nothing of note; the leg's 96 walked; back at overworld (-562, 65, 2191)");
  t.true(knockEdges(calm.f).length > 0, 'the ledge walked: no other way on');
});

test.serial('P3b: a ghast come about (watched, 23 off) once it has set foot on the ledge: not a leg more along it; back as from a danger, the bearing not written', async (t) => {
  const { w, later, f } = await afterSetup(LEDGE);
  const call = f.ctx.call;
  let came = -1;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await call(m, p);
    // (the walk's first leg onto the ledge, planned with none about)
    if (m === 'goto' && f.state.dim === NETHER && came < 0 && k(p as unknown as Pos) === k(at(-76, 70, 254))) { came = netherWalks(f).length; f.mobs.push({ id: 31, name: 'ghast', position: { x: -55.5, y: 82, z: 252.5 } }); }
    return r;
  }) as GoalContext['call'];
  const r = await scoutRun(f.ctx, HOUR, () => later);
  t.true(came > 0);
  t.is(r.text, "no leg walked to the north; a ghast about (23 off): the way on only by a drop's edge, 13 out; back at overworld (-562, 65, 2191)");
  t.like(r, { gain: 0, mark: 'same', cameBack: true });
  t.deepEqual(knockEdges(f, came), [], 'back off the ledge at once');
  t.is(peekNether(w).legs, undefined);
});

// ------------------------------------------------------------------------------------------------ the bearing, pure

test('the bearing: the eight in turn, the least known first: none walked before one walked, the fewest sites known that way, the compass order; then the longest ago, a day after its leg; every one walked within the day: none until the next is due; it writes nothing', (t) => {
  const w = setupWorld();
  const n = netherOf(w);
  Object.assign(n, { portal: { x: OWN.x, y: OWN.y, z: OWN.z }, linked: true, stage: 2 });
  t.deepEqual(scoutBearing(w, T0), { bearing: 'north', why: 'never scouted, no site known that way' });
  // a build and a lava lake known north of its portal, the hut's exit too (no knowledge of what is out there): the north-east first
  n.sites = [{ kind: 'build', x: -79, y: 70, z: 230 }, { kind: 'lava', x: -82, y: 69, z: 240 }, { kind: 'exit', x: -73, y: 70, z: 260 }];
  t.deepEqual(scoutBearing(w, T0), { bearing: 'north-east', why: 'never scouted, no site known that way' });
  walkedLegs(w, ['north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'], T0);
  t.deepEqual(scoutBearing(w, T0), { bearing: 'north', why: 'never scouted, 2 sites known that way' });
  walkedLegs(w, BEARINGS.map(b => b.name), T0);
  const before = JSON.stringify(w);
  t.deepEqual(scoutBearing(w, T0), { decline: { cause: 'unneeded', text: 'every bearing scouted in the last 24 h (the next, the north, at 15:40)', until: T0 - HOUR + SCOUT_AGAIN_MS } });
  t.like(scoutBearing(w, T0 - HOUR + DAY), { bearing: 'north', why: 'last scouted 24 h ago, 96 out' });
  // (in turn: the oldest first)
  t.like(scoutBearing(w, T0 + DAY), { bearing: 'north' });
  t.is(JSON.stringify(w), before, 'a look only');
  netherOf(w).legs![0].at = T0;
  t.like(scoutBearing(w, T0 + DAY), { bearing: 'north-east' });
  // which way a place lies
  t.is(bearingOf({ x: 0, z: 0 }, { x: 10, z: -9 }), 'north-east');
  t.is(bearingOf({ x: 0, z: 0 }, { x: -3, z: 20 }), 'south');
  t.is(bearingOf({ x: 0, z: 0 }, { x: 0.4, z: 0.3 }), undefined);
});

test('the scouting\'s gate: nothing before stage 2 or with the switch off; at stage 2 the rung\'s work beside the barter and the quartz, ready while a bearing is due and the kit is whole, held with the barter for the day; its gates write nothing', (t) => {
  t.deepEqual(NETHER_WORK.map(v => `${v.id} ${v.stage}`), ['setup 0', 'look 0', 'barter 1', 'quartz 1', 'scout 2', 'debris 2', 'fortress 3', 'tunnel 3']);
  const w = setupWorld();
  const n = netherOf(w);
  Object.assign(n, { portal: { x: OWN.x, y: OWN.y, z: OWN.z }, linked: true, stage: 1, stageTrips: 2, cleanTrips: 3 });
  w.chestItems![ORES].quartz = 64;
  const s = lookAt(KIT, 1000);
  t.false(scoutOpen(w), 'stage 1');
  t.false(String(rung().wants(s, w)).startsWith('scout'));
  n.stage = 2;
  t.true(scoutOpen(w));
  // (a fresh look: the rung's answer is the look's own)
  t.is(rung().wants(lookAt(KIT, 1000), w), 'scout: in the nether');
  for (const off of [{ linked: false }, { portal: undefined }]) {
    const x = structuredClone(w);
    Object.assign(netherOf(x), off);
    t.false(scoutOpen(x));
  }
  const switchedOff = structuredClone(w);
  netherOf(switchedOff).trips = false;
  t.is(rung().wants(s, switchedOff), null);
  t.is(scoutReady(s, w), null);
  t.like(scoutReady(lookAt(KIT, 1000, { health: 14 }), w), { cause: 'health', text: 'health 14, food 20 (the scouting needs 16 and 10)' });
  const bare = structuredClone(w);
  delete bare.chestItems!['-547,64,2182'].golden_helmet;
  t.deepEqual(scoutReady(s, bare), { cause: 'kit', text: 'scout: short of a golden helmet (carried or in the chests)' });
  const held = structuredClone(w);
  held.idle = { today: { day: 7 } as never, days: [] };
  netherOf(held).barter = { held: { day: 7, at: T0 - MINUTE, why: 'a piglin turned aggressive at nether (-70, 70, 255)' } };
  t.deepEqual(scoutReady(s, held), { cause: 'hold', text: 'scouting held for the day: a piglin turned aggressive at nether (-70, 70, 255)' });
  const done = structuredClone(w);
  walkedLegs(done, BEARINGS.map(b => b.name), T0);
  t.like(scoutReady(s, done), { cause: 'unneeded' });
  t.like(rung().declines!(lookAt(KIT, 3900), w), { cause: 'late' });
  // the gates write nothing, at any hour
  for (const x of [w, bare, held, done, switchedOff, setupWorld(), liveWorld()]) {
    const before = JSON.stringify(x);
    for (const tod of [0, 1000, 3900, 6000, 12_000]) { const look = lookAt(KIT, tod); scoutOpen(x); scoutReady(look, x); scoutBearing(x, look.now); rung().wants(look, x); rung().declines!(look, x); }
    t.is(JSON.stringify(x), before);
  }
});

test('the scouting does not fetch the kit with too little of the day for its own least after it: late before the kit, and the rung\'s turn goes to a shorter work', (t) => {
  // live Nov 18 14:07: let go with the day's 3 min, it fetched the kit and the Nether set (34 s), found 3 min no
  // longer left and came straight back ("not setting out: the kit took 34 s, too little of the scouting's 8 min is left")
  const w = setupWorld();
  Object.assign(netherOf(w), { portal: { x: OWN.x, y: OWN.y, z: OWN.z }, linked: true, stage: 2, stageTrips: 2, cleanTrips: 3 });
  w.chestItems![ORES].quartz = 64;
  const scout = NETHER_WORK.find(v => v.id === 'scout')!;
  const barter = NETHER_WORK.find(v => v.id === 'barter')!;
  t.is(scout.leastMs() + NETHER_KIT_MS, 4 * MINUTE);
  t.is(barter.leastMs() + NETHER_KIT_MS, 3 * MINUTE);
  t.is(rung().wants(lookAt(KIT, 1000), w), 'scout: in the nether');
  // past the scouting's hour (but inside the day's 3 min) the scouting is not chosen
  // (netherBudgetMs: 3 min at tod 3800, a minute more each 1200 ticks earlier: the scouting's 4 min till tod 2600)
  t.is(rung().wants(lookAt(KIT, 2600), w), 'scout: in the nether');
  for (const tod of [2601, 3000, 3700]) t.false(String(rung().wants(lookAt(KIT, tod), w)).startsWith('scout'), `tod ${tod}`);
  t.like(rung().declines!(lookAt(KIT, 3000), w), { cause: 'late', text: 'nether needs 4 min down there and home by dusk, 3.6 left' });
});

test('with the switch off (the live world) the scouting never wants, at any hour', (t) => {
  for (const tod of [0, 1000, 6000, 12_500]) t.is(rung().wants(lookAt(KIT, tod), liveWorld()), null);
  t.false(scoutOpen(liveWorld()));
});

// ------------------------------------------------------------------------------------------------ the leg's rules, pure

test('the leg\'s ground: within 12 of the bearing\'s line through its portal, 8 behind it to 96 out, 16 from every zone, no lava within 2, at no drop\'s edge; the walk goes to the cell a walk reaches furthest out, then nearest the line', (t) => {
  const f = frameOf(OWN_BOX, 'north');
  t.like(f, { ox: -78.5, oz: 267, ux: 0, uz: -1 });
  t.is(outAlong(f, at(-79, 70, 170)), 96.5);
  t.is(offLine(f, at(-67, 70, 200)), 12);
  const ne = frameOf(OWN_BOX, 'north-east');
  t.true(Math.abs(outAlong(ne, at(-79 + 10, 70, 266 - 10)) - Math.SQRT2 * 10) < 1);
  // the box read ahead: the corridor and the lava rule's cells round it, down 12 and up 12 from the feet
  const box = aheadBox(f, -SCOUT_BEHIND, 32, 70);
  t.deepEqual(box, { x1: -94, y1: 55, z1: 232, x2: -63, y2: 82, z2: 278 });
  const base = netherGround();
  const extra = new Map<string, string>([[k(at(-70, 69, 240)), 'lava'], [k(at(-73, 69, 250)), 'air'], [k(at(-73, 68, 250)), 'air'], [k(at(-73, 67, 250)), 'air'], [k(at(-73, 66, 250)), 'air']]);
  const g = gridOf(p => extra.get(k(p)) ?? base(p), box);
  const may = scoutGround(g, f, [zoneBox(ROOM_ZONE)]);
  t.true(may(at(-75, 70, 245)));
  const open = scoutGround(g, f, []);
  t.true(open(at(-76, 70, 274)));
  t.false(open(at(-76, 70, 275)), 'behind its portal by more than 8');
  t.false(may(at(-66, 70, 240)), 'off the line by more than 12');
  t.false(may(at(-71, 70, 240)), 'by the lava');
  t.false(may(at(-72, 70, 250)), 'at the edge of a drop');
  t.false(may(at(-70, 70, 266)), 'within 16 of the community\'s room');
  // the furthest out a walk reaches over that ground, from its hut's front room
  const reach = walkFrom(g, [footing(g, at(-75.5, 70, 266.5))!], may);
  const next = furthest(f, reach)!;
  t.is(next.at.z, 234);
  t.is(next.at.x, -76);
});

test('the way kept: its hut\'s cell first, a waypoint every 8 cells walked, the last; never more than 16 (further apart on a long way); the lakes of a leg\'s reads, one where two reads saw it, those past the look\'s 24 only when asked', (t) => {
  const cells = Array.from({ length: 30 }, (_, i) => at(0, 70, 100 - i));
  t.deepEqual(waypoints(cells).map(p => p.z), [100, 92, 84, 76, 71]);
  t.deepEqual(waypoints([at(1, 2, 3)]), [at(1, 2, 3)]);
  const long = Array.from({ length: 300 }, (_, i) => at(0, 70, 400 - i));
  const w = waypoints(long);
  t.is(w.length, WAYPOINTS);
  t.deepEqual(w[0], at(0, 70, 400));
  t.deepEqual(w.at(-1), at(0, 70, 101));
  const lava = new Set<string>();
  // one lake of 12 (read in two halves), one of 4 (too small for a lake)
  for (let x = 0; x < 3; x++) for (let z = 10; z < 14; z++) lava.add(k(at(x, 69, z)));
  for (let z = 40; z < 44; z++) lava.add(k(at(5, 69, z)));
  const lakes = lakesBy(lava, [at(0, 70, 0), at(0, 70, 20)]);
  t.is(lakes.length, 1);
  t.like(lakes[0], { size: 12, at: at(0, 69, 13) });
  t.is(lakesBy(lava, [at(0, 70, 0)], { portal: cellBox(at(0, 70, 0)), radius: 24 }).length, 0);
  t.is(lakesBy(lava, [at(0, 70, 0)], { portal: cellBox(at(0, 70, -20)), radius: 24 }).length, 1);
});

// ------------------------------------------------------------------------------------------------ the memory

test('brain.json keeps the legs (one a bearing, the newest; their way 16 at most) and the sites\' legs; anything else is let go', (t) => {
  const w = liveWorld();
  const way = Array.from({ length: 20 }, (_, i) => ({ x: -76, y: 70, z: 260 - 4 * i }));
  w.nether = JSON.parse(JSON.stringify({
    trips: true, stage: 2,
    legs: [
      { bearing: 'north', at: T0 - HOUR, reach: 95.6, end: "the leg's 96 walked", way: [...way, { x: 'no' }] },
      { bearing: 'north', at: T0 - 2 * HOUR, reach: 40, end: 'older', way: [] },
      { bearing: 'up', at: T0, reach: 10, end: 'x', way: [] },
      { bearing: 'east', reach: 10 }
    ],
    sites: [{ kind: 'fortress', x: 1, y: 2, z: 3, at: T0, leg: 'north' }, { kind: 'lava', x: 4, y: 5, z: 6, leg: 'sideways' }]
  }));
  const n = netherOf(w);
  t.is(n.legs?.length, 1);
  t.like(n.legs![0], { bearing: 'north', reach: 96, end: "the leg's 96 walked" });
  t.is(n.legs![0].way.length, WAYPOINTS);
  t.deepEqual(n.sites, [{ kind: 'fortress', x: 1, y: 2, z: 3, at: T0, leg: 'north' }, { kind: 'lava', x: 4, y: 5, z: 6 }]);
  const none = liveWorld();
  none.nether = JSON.parse(JSON.stringify({ stage: 2, legs: 'lots' }));
  t.is(netherOf(none).legs, undefined);
});

test(`the sites kept: ${SITES} at most, the newest first; past that the oldest lava lake or biome goes first, a natural fortress or bastion last; a place seen again keeps the leg that found it`, (t) => {
  const w = liveWorld();
  noteSites(w, [{ kind: 'fortress', x: 100, y: 70, z: 100, leg: 'east' }], T0);
  noteSites(w, [{ kind: 'build', x: -100, y: 70, z: 0 }], T0 + 1);
  for (let i = 0; i < SITES; i++) noteSites(w, [{ kind: 'lava', x: 20 * i, y: 69, z: 300 }], T0 + 2 + i);
  const n = peekNether(w);
  t.is(n.sites.length, SITES);
  t.like(n.sites.find(s => s.kind === 'fortress'), { x: 100, leg: 'east' });
  t.truthy(n.sites.find(s => s.kind === 'build'));
  // the first lava lake went, the newest is first
  t.false(n.sites.some(s => s.kind === 'lava' && s.x === 0));
  t.like(n.sites[0], { kind: 'lava', x: 20 * (SITES - 1) });
  // the fortress seen again by the look (no leg of its own): the leg that found it kept
  noteSites(w, [{ kind: 'fortress', x: 102, y: 71, z: 99 }], T0 + 100);
  t.like(peekNether(w).sites[0], { kind: 'fortress', x: 102, leg: 'east', at: T0 + 100 });
  t.is(peekNether(w).sites.filter(s => s.kind === 'fortress').length, 1);
  // the leg kept on a leg's line as a ScoutLeg's
  const leg: ScoutLeg = { bearing: 'east', at: T0, reach: 96, end: 'x', way: [] };
  netherOf(w).legs = [leg];
  t.regex(netherLine(w, T0), /; 1\/8 bearings scouted/);
});
