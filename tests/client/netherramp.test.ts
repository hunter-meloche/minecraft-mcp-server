import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChestContents, ChestStack, ClientRuntime, InventoryItem } from '../../src/client/tools.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import { Brain, decide } from '../../src/client/brain/brain.js';
import type { BrainMemory } from '../../src/client/brain/memory.js';
import {
  NETHER, NETHER_STAGES, OVERWORLD, netherEnd, stageNeeds, netherLine, netherOf, netherTick, peekNether, portalCells, tripsForStage, type DeathSeen, type PortalShape
} from '../../src/client/brain/nether.js';
import { SETUP_HOLD_MS, SETUP_WAITS, setupReady, type NetherZone } from '../../src/client/brain/nethersetup.js';
import { HUT_OUT, LOOK_LEAST_MS, LOOK_MAX_MS, lavaLakes, lookOpen, lookReady, lookRound, lookRun } from '../../src/client/brain/netherlook.js';
import {
  DIAMONDS_KEPT, REGEAR_WAITS, REGEAR_WITHIN_MS, netherSparesGoal, regearGoal, regearPieces, sparesShort, sparesWant
} from '../../src/client/brain/regear.js';
import { ANVIL_ORDER } from '../../src/client/brain/anvil.js';
import { SPARE_SET } from '../../src/client/brain/portal.js';
import { freeChestTotals, key, oneSpareSet, remember, spareHeld, sparePieces } from '../../src/client/brain/chests.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals, workTick, type WorkResult, type WorkTask } from '../../src/client/brain/work.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { HOME, MINUTE, T0, WORN, liveWorld, lookAt, realGoals } from '../helpers/homestead.js';
import { KIT, ROOM_ZONE, game, gridOf, k, setupWorld } from '../helpers/netherworld.js';

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
REGEAR_WAITS.pollMs = 0;

/** Its own Nether-side portal where the setup trip builds it in the test Nether (dug into the cliff, along z). */
const OWN: PortalShape = { x: -79, y: 70, z: 266, axis: 'z', width: 2, height: 3 };

/** The setup's world with the setup done: its own portal known and the two sides linked. */
function linkedWorld(): WorldMemory {
  const w = setupWorld();
  const n = netherOf(w);
  n.portal = { x: OWN.x, y: OWN.y, z: OWN.z };
  n.linked = true;
  return w;
}

/** A Nether trip ended well, as the wrapper books it: home through a portal, no death, its work done (P3b). */
const clean = (w: WorldMemory, at = T0, text = '[look] looked round its hut; back home') => netherEnd(w, at - MINUTE, undefined, true, { at, text, cameBack: true, worked: true });
/** The Nether's housekeeping on a look at home (the live kit), with a death told or none. */
const tick = (w: WorldMemory, d?: DeathSeen, items: InventoryItem[] = KIT) => netherTick(lookAt(items, 1000), w, d);
/** A death down there `min` minutes before T0 (or in the overworld). */
const death = (min: number, dimension = NETHER): DeathSeen => ({ at: { x: -70, y: 70, z: 270 }, time: T0 - min * MINUTE, dimension });

// ------------------------------------------------------------------------------------------------ the stage ramp

test('the stage ramp: 1 after 2 clean trips, 2 after 4, 3 after 6 with no potion in stock (P3c, the user\'s strict rules: the fortress needs none, the bastion 2: its own gate\'s); a line each, once', (t) => {
  t.deepEqual(NETHER_STAGES.map(s => `${s.stage}: ${s.trips}`), ['1: 2', '2: 4', '3: 6']);
  t.deepEqual(['barter', 'quartz', 'scout', 'debris', 'fortress', 'bastion', 'setup'].map(stageNeeds),
    [{ stage: 1, potions: 0 }, { stage: 1, potions: 0 }, { stage: 2, potions: 0 }, { stage: 2, potions: 0 }, { stage: 3, potions: 0 }, { stage: 3, potions: 2 }, undefined]);
  // every work of the rung opens at its stage in the ramp
  for (const v of NETHER_WORK) t.is(stageNeeds(v.id)?.stage ?? 0, v.stage, v.id);
  t.deepEqual([0, 1, 2, 3].map(tripsForStage), [0, 2, 4, 6]);
  const w = linkedWorld();
  // the setup that linked the two sides is the first clean trip, the look the second
  clean(w);
  t.deepEqual(tick(w), []);
  t.like(peekNether(w), { stage: 0, stageTrips: 1 });
  clean(w);
  t.deepEqual(tick(w), ['nether: stage 1 after 2 clean trips']);
  t.deepEqual(tick(w), [], 'said once');
  clean(w); clean(w);
  t.deepEqual(tick(w), ['nether: stage 2 after 4 clean trips']);
  clean(w);
  t.deepEqual(tick(w), [], 'five');
  t.regex(netherLine(w, T0), /; stage 2, 5\/6 clean trips to stage 3, 0 death/);
  clean(w);
  // six clean trips and no potion in stock (live, Nov 15 to 17: stage 2 at 6/6, waiting on 2 potions)
  t.deepEqual(tick(w), ['nether: stage 3 after 6 clean trips']);
  clean(w);
  t.deepEqual(tick(w), [], 'the top stage');
  t.regex(netherLine(w, T0), /; stage 3, the top stage, 0 death/);
});

test('the ramp waits for the link: trips while the two sides are not linked count for nothing, and nothing goes up', (t) => {
  const w = setupWorld();
  for (let i = 0; i < 3; i++) clean(w);
  t.deepEqual(tick(w), []);
  t.like(peekNether(w), { stage: 0, stageTrips: 0, cleanTrips: 3 });
  t.is(peekNether(w).lastTrip?.end, 'not linked');
  // a memory with stage 2 and no count (a hand's edit): the count is the stage's own, not 0
  const old = liveWorld();
  old.nether = { trips: true, stage: 2 };
  t.like(netherOf(old), { stage: 2, stageTrips: 4 });
});

test('a clean trip: home through a portal, linked, no death on it; stranded, a death, cut short or not linked count for nothing; one that never went is no last trip', (t) => {
  const w = linkedWorld();
  const ended = (ran: boolean, cameBack: boolean, d?: DeathSeen, text = 'x') => { netherEnd(w, T0 - 10 * MINUTE, d, ran, { at: T0, text, cameBack, worked: true }); return peekNether(w); };
  t.like(ended(true, false, undefined, '[look] looked round, but could not get home: no lit portal in sight'), {
    stageTrips: 0, cleanTrips: 1, lastTrip: { at: T0, end: 'stranded', text: '[look] looked round, but could not get home: no lit portal in sight' }
  });
  // a death since it set out, wherever: no clean trip (the probation starts again), however it came back
  t.like(ended(true, true, death(5, OVERWORLD)), { stageTrips: 0, cleanTrips: 0, lastTrip: { end: 'a death' } });
  t.like(ended(false, false), { stageTrips: 0, cleanTrips: 0, lastTrip: { end: 'cut short' } });
  // (a death before it set out is another trip's)
  t.like(ended(true, true, death(20, NETHER)), { stageTrips: 1, cleanTrips: 1, lastTrip: { end: 'clean' } });
  // one that never went through (untried) leaves the last trip as it was
  netherEnd(w, T0, undefined, false);
  t.like(peekNether(w), { stageTrips: 1, lastTrip: { end: 'clean' } });
  // the text kept short
  netherEnd(w, T0, undefined, true, { at: T0, text: 'y'.repeat(500), cameBack: true, worked: true });
  t.is(peekNether(w).lastTrip!.text, `${'y'.repeat(197)}...`);
});

test('a death in the Nether drops the stage by one, never below 1 once linked, and the clean trips go back to that stage\'s count; a death elsewhere drops nothing', (t) => {
  const w = linkedWorld();
  const n = netherOf(w);
  n.stage = 3;
  n.stageTrips = 7;
  t.deepEqual(tick(w, death(30)), [
    'nether: a death at nether (-70, 70, 270): no trips until 17:10',
    'nether: stage 3 -> 2 after the death: 4/6 clean trips to stage 3'
  ]);
  t.like(peekNether(w), { stage: 2, stageTrips: 4, cleanTrips: 0 });
  t.deepEqual(tick(w, death(30)), [], 'told again on the next tick: booked once');
  t.deepEqual(tick(w, death(20)), ['nether: a death at nether (-70, 70, 270): no trips until 17:20', 'nether: stage 2 -> 1 after the death: 2/4 clean trips to stage 2']);
  // at stage 1 with its portal linked: kept there; the third in 3 days switches the trips off as before
  netherOf(w).stageTrips = 3;
  t.deepEqual(tick(w, death(10)), [
    'nether: a death at nether (-70, 70, 270): no trips until 17:30', 'nether: stage 1 kept after the death: 2/4 clean trips to stage 2', 'nether trips off: 3 deaths in 3 days'
  ]);
  t.like(peekNether(w), { stage: 1, stageTrips: 2, trips: false });
  // in the overworld (on the way to the portal): the stage stands (the trip is no clean one: netherEnd)
  const o = linkedWorld();
  netherOf(o).stage = 2;
  netherOf(o).stageTrips = 5;
  t.deepEqual(tick(o, death(10, OVERWORLD)), []);
  t.like(peekNether(o), { stage: 2, stageTrips: 5 });
  // stage 0: the setup's clean trip counted, then a death on the look: the count starts again; none to lose, no line
  const z = linkedWorld();
  clean(z);
  t.deepEqual(tick(z, death(10)).slice(1), ['nether: stage 0 kept after the death: 0/2 clean trips to stage 1']);
  const y = linkedWorld();
  t.deepEqual(tick(y, death(10)).slice(1), []);
  // not linked, a stage from before: it drops to 0
  const u = setupWorld();
  netherOf(u).stage = 1;
  netherOf(u).stageTrips = 2;
  t.deepEqual(tick(u, death(10)).slice(1), ['nether: stage 1 -> 0 after the death: 0/2 clean trips to stage 1']);
});

// ------------------------------------------------------------------------------------------------ through the wrapper

/** An hour and a day on for the trips' pace (the probation's one an hour, two a game day, a run's dry mark): the next may set out. */
const later = (w: WorldMemory) => { const n = netherOf(w); n.starts = []; delete n.tripsToday; if (w.work) w.work.dry = {}; };

/** One Nether trip through the work wrapper with a stand-in for the work: the bot comes home by the home portal. */
function bench(world: WorldMemory, run: (go: { into: () => void; out: () => void }) => Promise<WorkResult>, lastDeath: () => DeathSeen | undefined = () => undefined) {
  const state = { dim: OVERWORLD as string, pos: { ...HOME } as Pos };
  const calls: string[] = [];
  const said: string[] = [];
  const go = { into: () => { state.dim = NETHER; state.pos = { x: -77, y: 70, z: 266 }; }, out: () => { state.dim = OVERWORLD; state.pos = { x: -560, y: 63, z: 2191 }; } };
  const task: WorkTask = {
    name: 'nether', rank: 4.5, reach: 'nether', room: 'nether', budgetMs: 0,
    variants: () => [{ id: 'look', dist: 0 }], ready: () => null, run: () => run(go)
  };
  const [goal] = workGoals(lastDeath, [task], () => T0);
  let portals = [{ ...OWN, own: true }];
  const ctx = {
    s: lookAt(KIT, 1000), world, signal: new AbortController().signal, progress: (x: string) => { said.push(x); }, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, dimension: state.dim, position: { ...state.pos }, timeOfDay: 1500 }),
    call: async <T>(method: string, p: Record<string, unknown> = {}): Promise<T> => {
      calls.push(method);
      if (method === 'inventory') return { items: KIT } as T;
      if (method === 'portal.list') return { portals } as T;
      if (method === 'goto') { state.pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) }; return { arrived: true } as T; }
      if (method === 'portal.enter') { go.out(); return { ok: true, from: NETHER, dimension: OVERWORLD, portal: { x: -562, y: 63, z: 2191 }, stepped: true } as T; }
      return {} as T;
    },
    act: async (tool: string) => { calls.push(tool); if (tool === 'go-home') state.pos = { ...HOME }; return { ok: true, text: 'Home' }; }
  } as unknown as GoalContext;
  return { goal, ctx, calls, said, state, noPortals: () => { portals = []; } };
}

test.serial('through the wrapper: home by netherHome or by its own run\'s way back is a clean trip and counts; one seen in the overworld with no way back of its own (a death\'s respawn) is none', async (t) => {
  const w = linkedWorld();
  // ends down there: the wrapper takes it home through its own portal
  let b = bench(w, async go => { go.into(); return { gain: 1, text: 'looked round its hut', worked: true }; });
  t.is(await b.goal.run(b.ctx), '[look] looked round its hut; back home');
  t.like(peekNether(w), { stageTrips: 1, cleanTrips: 1, lastTrip: { at: T0, end: 'clean', text: '[look] looked round its hut' } });
  t.false(afield.trip);
  // its own run came back through a portal (the setup's link check, the look's way back): no netherHome, and clean
  later(w);
  b = bench(w, async go => { go.into(); go.out(); return { gain: 1, text: 'back at overworld (-562, 65, 2191)', cameBack: true, worked: true }; });
  t.is(await b.goal.run(b.ctx), '[look] back at overworld (-562, 65, 2191); back home');
  t.false(b.calls.includes('portal.enter'), 'no second way through');
  t.like(peekNether(w), { stageTrips: 2, lastTrip: { end: 'clean' } });
  // in the overworld with no word of a way back (the bot died down there and woke at home, the death not told yet)
  later(w);
  b = bench(w, async go => { go.into(); go.out(); return { gain: 0, text: 'the hut at nether (-79, 70, 266): could not dig' }; });
  await b.goal.run(b.ctx);
  t.like(peekNether(w), { stageTrips: 2, lastTrip: { end: 'stranded' } });
});

test.serial('through the wrapper: not got home through a portal is stranded, a death on the trip is no clean trip, and an untried run is no trip at all', async (t) => {
  const w = linkedWorld();
  let b = bench(w, async go => { go.into(); return { gain: 0, text: 'looked round' }; });
  b.noPortals();
  await t.throwsAsync(b.goal.run(b.ctx), { message: '[look] looked round, but could not get home: no lit portal in sight' });
  t.like(peekNether(w), { stageTrips: 0, cleanTrips: 1, lastTrip: { end: 'stranded', text: '[look] looked round, but could not get home: no lit portal in sight' } });
  // a death since it set out (told by the runtime): whatever came after
  later(w);
  b = bench(w, async go => { go.into(); return { gain: 1, text: 'looked round' }; }, () => ({ at: { x: -70, y: 70, z: 270 }, time: T0, dimension: NETHER }));
  await b.goal.run(b.ctx);
  t.like(peekNether(w), { stageTrips: 0, cleanTrips: 0, lastTrip: { end: 'a death' } });
  // never went through: the last trip is the one before
  later(w);
  b = bench(w, async () => ({ gain: 0, text: 'not setting out: no golden helmet', untried: true }));
  await t.throwsAsync(b.goal.run(b.ctx));
  t.like(peekNether(w), { lastTrip: { end: 'a death' } });
});

test('P3b: a trip counts for the stages only when it did its work; one that would be clean but did none is turned back: neither clean nor a failure, for the stages or the probation', (t) => {
  const w = linkedWorld();
  const end = (worked: boolean, text: string) => netherEnd(w, T0 - 10 * MINUTE, undefined, true, { at: T0, text, cameBack: true, worked });
  t.is(end(false, '[barter] no barter; a ghast in sight (12 off); back at overworld (-562, 65, 2191)'), 'turned back');
  t.like(peekNether(w), { stageTrips: 0, cleanTrips: 0, lastTrip: { end: 'turned back', text: '[barter] no barter; a ghast in sight (12 off); back at overworld (-562, 65, 2191)' } });
  t.is(end(false, '[quartz] no quartz mined; no quartz ore it may mine within 24 of its portal'), 'turned back');
  t.like(peekNether(w), { stageTrips: 0, cleanTrips: 0 });
  t.is(end(true, '[barter] bartered 1 gold with 1 piglin: 4 soul_sand'), 'clean');
  t.like(peekNether(w), { stageTrips: 1, cleanTrips: 1, lastTrip: { end: 'clean' } });
  // a death, a cut, stranded or not linked come first: they are what they were whatever the work
  t.is(netherEnd(w, T0 - 10 * MINUTE, death(5), true, { at: T0, text: 'x', cameBack: true, worked: false }), 'a death');
  t.is(netherEnd(w, T0 - 10 * MINUTE, undefined, true, { at: T0, text: 'x', cameBack: false, worked: false }), 'stranded');
  t.is(netherEnd(w, T0, undefined, false), undefined, 'one that never went: no end');
  // (the death put the probation's run back to none, the stranded trip after it ran its course with none: 1)
  t.regex(netherLine(w, T0), /; stage 0, 1\/2 clean trips to stage 1, on probation 1\/3/);
  // brain.json keeps the new end
  const again = liveWorld();
  again.nether = JSON.parse(JSON.stringify({ ...peekNether(w), lastTrip: { at: T0, text: 'y', end: 'turned back' } }));
  t.is(netherOf(again).lastTrip?.end, 'turned back');
});

test.serial('P3b through the wrapper: a trip turned back before its work (a ghast in sight at the hut) is no failure, counts for nothing, and gives back its trip of the day; the next that does its work counts', async (t) => {
  const w = linkedWorld();
  netherOf(w).cleanTrips = 3;
  w.idle = { today: { day: 7 } as never, days: [] };
  let b = bench(w, async go => { go.into(); go.out(); return { gain: 0, text: 'no barter; a ghast in sight (12 off); back at overworld (-562, 65, 2191)', mark: 'same', cameBack: true }; });
  t.is(await b.goal.run(b.ctx), '[look] no barter; a ghast in sight (12 off); back at overworld (-562, 65, 2191); back home');
  const n = peekNether(w);
  t.like(n, { stageTrips: 0, cleanTrips: 3, lastTrip: { at: T0, end: 'turned back' } });
  // (its start given back: neither the probation's hour nor one of the day's two)
  t.deepEqual(n.starts, []);
  t.is(n.tripsToday, undefined);
  t.regex(netherLine(w, T0), /last trip 0 min ago \(turned back\): \[look\] no barter; a ghast in sight/);
  // one that did its work: a clean trip, the day's first
  if (w.work) w.work.dry = {};
  b = bench(w, async go => { go.into(); go.out(); return { gain: 4, text: 'bartered 1 gold with 1 piglin: 4 soul_sand; back at overworld (-562, 65, 2191)', cameBack: true, worked: true }; });
  await b.goal.run(b.ctx);
  t.like(peekNether(w), { stageTrips: 1, cleanTrips: 4, tripsToday: { day: 7, n: 1 }, lastTrip: { end: 'clean' } });
  t.is(peekNether(w).starts.length, 1);
});

// ------------------------------------------------------------------------------------------------ the look: what it sees

/** A flat Nether floor at y 69 under open air, with whatever `extra` says at some cells. */
const flat = (extra: Record<string, string> = {}) => (p: Pos) => extra[k(p)] ?? (p.y <= 69 ? 'netherrack' : 'air');
const AT: PortalShape = { x: 0, y: 70, z: 0, axis: 'x', width: 2, height: 3 };
const BOX = { x1: -30, y1: 50, z1: -30, x2: 30, y2: 85, z2: 30 };

test('what the look sees: builds of others, natural fortresses and bastions, lava lakes (8 cells and up, the nearest cell kept), and the way out of the hut on foot', (t) => {
  const extra: Record<string, string> = {};
  // a lava lake of 12 (4 x 3) 10 off, a fall of 5 (no lake), and the portal's own blocks
  for (let x = 10; x <= 13; x++) for (let z = 0; z <= 2; z++) extra[k({ x, y: 69, z })] = 'lava';
  for (let y = 70; y <= 74; y++) extra[k({ x: -12, y, z: 12 })] = 'lava';
  for (const c of portalCells(AT)) extra[k(c)] = 'nether_portal';
  const g = gridOf(flat(extra), BOX);
  t.deepEqual(lavaLakes(g, { x1: 0, y1: 70, z1: 0, x2: 1, y2: 72, z2: 0 }), [{ at: { x: 10, y: 69, z: 0 }, size: 12, off: 9 }]);
  const zones: NetherZone[] = [
    { x1: -60, y1: 60, z1: -10, x2: -40, y2: 80, z2: 10, markers: 400, surface: false, natural: 'fortress', sample: 'nether_bricks' },
    { ...ROOM_ZONE, x1: 20, x2: 26, z1: -5, z2: 5 }
  ];
  const r = lookRound(g, AT, zones, { x: 0.5, y: 70, z: 2.5 });
  t.is(r.text, '1 build of others (the nearest 19 off), 1 fortress (the nearest at nether (-50, 70, 0), 40 off), no bastion, 1 lava lake (the nearest 9 off), the way out of the hut open (4 steps to nether (0, 70, 6))');
  t.deepEqual(r.sites, [
    { kind: 'fortress', x: -50, y: 70, z: 0 }, { kind: 'build', x: 23, y: 72, z: 0 }, { kind: 'exit', x: 0, y: 70, z: 6 }, { kind: 'lava', x: 10, y: 69, z: 0 }
  ]);
  t.true(Math.max(Math.abs(r.exit!.at.x - 0.5), Math.abs(r.exit!.at.z)) >= HUT_OUT);
  // shut in: a ring of netherrack round where it stands, nothing open beyond
  const shut: Record<string, string> = {};
  for (let x = -2; x <= 2; x++) for (let z = 1; z <= 5; z++) for (const y of [70, 71]) if (Math.abs(x) === 2 || z === 1 || z === 5) shut[k({ x, y, z })] = 'netherrack';
  const s = lookRound(gridOf(flat(shut), BOX), AT, [], { x: 0.5, y: 70, z: 3.5 });
  t.is(s.exit, undefined);
  t.regex(s.text, /^no builds of others, no fortress, no bastion, no lava lake, no way out of the hut on foot$/);
  t.deepEqual(s.sites, []);
  // the way out keeps out of someone's build: the ring with a door, their box right outside it, is no way out; without
  // their box it is one
  const door = { ...shut, [k({ x: 0, y: 70, z: 5 })]: 'air', [k({ x: 0, y: 71, z: 5 })]: 'air' };
  const theirs: NetherZone = { x1: -3, y1: 68, z1: 6, x2: 3, y2: 74, z2: 9, markers: 6, surface: true, sample: 'stone_bricks' };
  t.is(lookRound(gridOf(flat(door), BOX), AT, [theirs], { x: 0.5, y: 70, z: 3.5 }).exit, undefined);
  t.deepEqual(lookRound(gridOf(flat(door), BOX), AT, [], { x: 0.5, y: 70, z: 3.5 }).exit, { at: { x: 0, y: 70, z: 6 }, steps: 3 });
});

// ------------------------------------------------------------------------------------------------ the look: the gate

test('the look\'s gate: open once linked with its own portal known, at stage 0 only; the kit short only of what the chests lack; it writes nothing', (t) => {
  const w = linkedWorld();
  t.true(lookOpen(w));
  t.false(lookOpen(setupWorld()), 'not linked: the setup\'s');
  const noPortal = linkedWorld();
  delete netherOf(noPortal).portal;
  t.false(lookOpen(noPortal));
  const past = linkedWorld();
  netherOf(past).stage = 1;
  t.false(lookOpen(past), 'past stage 0: the look is done with');
  // (P3a adds the barter and the quartz at stage 1, P3b the scouting and the debris at stage 2)
  t.deepEqual(NETHER_WORK.map(v => `${v.id} ${v.stage}`), ['setup 0', 'look 0', 'barter 1', 'quartz 1', 'scout 2', 'debris 2', 'fortress 3', 'tunnel 3']);
  const s = lookAt(KIT, 1000);
  t.is(lookReady(s, w), null, 'its own portal stands: no frame\'s obsidian asked for');
  const rung = workGoals(() => undefined, LADDER, () => T0).find(g => g.name === 'work: nether')!;
  t.is(rung.wants(s, w), 'look: in the nether');
  // (past stage 0 the barter and the quartz are the work, P3a: these chests hold no gold for the barter, so the quartz
  // goes, its target short)
  t.is(rung.wants(lookAt(KIT, 1000), past), 'quartz: in the nether');
  const bare = linkedWorld();
  delete bare.chestItems!['-547,64,2182'].golden_helmet;
  t.deepEqual(lookReady(s, bare), { cause: 'kit', text: 'look: short of a golden helmet (carried or in the chests)' });
  t.like(lookReady(lookAt(KIT, 1000, { health: 15 }), w), { cause: 'health', text: 'health 15, food 20 (the nether look needs 16 and 10)' });
  t.like(rung.declines!(lookAt(KIT, 3900), w), { cause: 'late' });
  const before = JSON.stringify(w);
  for (const tod of [0, 1000, 3900, 12_000]) { const look = lookAt(KIT, tod); lookOpen(w); lookReady(look, w); rung.wants(look, w); rung.declines!(look, w); }
  t.is(JSON.stringify(w), before);
});

// ------------------------------------------------------------------------------------------------ the look: the trip

test.serial('the setup, then the look an hour on: through the home portal into its own hut, the Nether round it read and kept as sites, nothing touched, back by its own portal; the two clean trips open stage 1, and the look closes', async (t) => {
  const w = setupWorld();
  const first = game(w);
  t.is(await workGoals(() => undefined, LADDER, () => T0).find(g => g.name === 'work: nether')!.run(first.ctx), '[setup] its own portal at nether (-79, 70, 266), linked with the home portal; back home');
  t.like(peekNether(w), { stage: 0, stageTrips: 1, lastTrip: { end: 'clean', text: '[setup] its own portal at nether (-79, 70, 266), linked with the home portal' } });
  const later = T0 + 2 * HOUR;
  const rung = workGoals(() => undefined, LADDER, () => later).find(g => g.name === 'work: nether')!;
  t.is(rung.wants(lookAt(first.inv, 1000, { now: later }), w), 'look: in the nether');
  const f = game(w, { items: first.inv, after: first, now: later });
  const text = await rung.run(f.ctx);
  t.regex(text, /^\[look\] looked round its hut at nether \(-79, 70, 266\): 1 build of others \(the nearest \d+ off\), no fortress, no bastion, 1 lava lake \(the nearest 16 off\), the way out of the hut open \(\d+ steps to nether \(-?\d+, 70, \d+\)\); back at overworld \(-562, 65, 2191\); back home$/);
  const lines = f.said.filter(l => l.startsWith('nether: '));
  t.is(lines[0], 'nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)');
  t.regex(lines[1], /^nether: look from its hut at nether \(-79, 70, 266\): 1 build of others/);
  t.is(lines.length, 2, lines.join(' | '));
  // (back in by the bottom cell it stands in front of)
  t.deepEqual(f.did.filter(d => d.startsWith('portal ')), ['portal overworld (-562, 63, 2191) -> the_nether (-79, 70, 267)', 'portal the_nether (-79, 70, 267) -> overworld (-562, 65, 2191)']);
  // nothing dug, placed or walked down there (into the portal is the bridge's own step)
  t.deepEqual(f.changed, []);
  t.deepEqual(f.walks.filter(x => x.dim === NETHER), []);
  // what it saw: the community's room, the hut's way out, the lava pool by its cell nearest the portal
  const n = peekNether(w);
  t.deepEqual(n.sites.map(s => s.kind), ['build', 'exit', 'lava']);
  t.like(n.sites[2], { kind: 'lava', x: -66, y: 69, z: 277, at: later });
  t.like(n.sites[0], { x: Math.floor((ROOM_ZONE.x1 + ROOM_ZONE.x2) / 2), z: Math.floor((ROOM_ZONE.z1 + ROOM_ZONE.z2) / 2) });
  t.true(Math.max(Math.abs(n.sites[1].x - OWN.x), Math.abs(n.sites[1].z - OWN.z - 1)) >= HUT_OUT);
  // the second clean trip: stage 1 at the next look round home, and the look closes with it
  t.like(n, { stageTrips: 2, linked: true, lastTrip: { end: 'clean' } });
  const s = lookAt(f.inv, 1000, { now: later + MINUTE });
  t.true(workTick(s, w, () => undefined, LADDER).includes('nether: stage 1 after 2 clean trips'));
  t.false(lookOpen(w));
  // (stage 1 opens the barter and the quartz, P3a: the rung's work now, held by the day's two trips; there was none before)
  t.deepEqual(NETHER_WORK.filter(v => v.open?.(w) ?? true).map(v => v.id), ['barter', 'quartz']);
  t.deepEqual(rung.declines!(s, w), { cause: 'hold', text: '2 nether trips today (at most 2 a game day)' });
  t.regex(netherLine(w, later + MINUTE), /^Nether: trips on; stage 1, 2\/4 clean trips to stage 2, on probation 2\/3, 0 death\(s\) in 3 days; .*\(linked\); others' portals seen: 1 in overworld, 1 in the nether; 3 site\(s\) known; last trip 1 min ago \(clean\): \[look\] looked round its hut at nether \(-79, 70, 266\): 1 build of others .*\.\.\.\.$/);
});

test.serial('a look whose home portal comes out at someone else\'s: not linked, straight back through that portal (nothing touched, not a step down there), the setup held a day; no clean trip', async (t) => {
  const w = setupWorld();
  const first = game(w);
  await workGoals(() => undefined, LADDER, () => T0).find(g => g.name === 'work: nether')!.run(first.ctx);
  const later = T0 + 2 * HOUR;
  const f = game(w, { items: first.inv, after: first, now: later });
  // someone's portal by home's scaled point since: the home portal comes out there now
  f.lit.push({ x: -71, y: 70, z: 273, axis: 'x', width: 2, height: 3, dim: NETHER });
  const text = await workGoals(() => undefined, LADDER, () => later).find(g => g.name === 'work: nether')!.run(f.ctx);
  t.is(text, '[look] the home portal came out at nether (-71, 70, 273), not at its own: not linked; back at overworld (-562, 65, 2191); setup held a day; back home');
  t.true(f.said.includes('nether: not linked: the home portal came out at nether (-71, 70, 273), not at its own at nether (-79, 70, 266): setup held a day'), f.said.join(' | '));
  t.deepEqual(f.changed, []);
  t.deepEqual(f.walks.filter(x => x.dim === NETHER), []);
  t.deepEqual(f.did.filter(d => d.startsWith('portal ')), ['portal overworld (-562, 63, 2191) -> the_nether (-71, 70, 273)', 'portal the_nether (-71, 70, 273) -> overworld (-562, 65, 2191)']);
  const n = peekNether(w);
  t.like(n, { linked: false, stageTrips: 1, lastTrip: { end: 'not linked' }, setupHold: { until: later + SETUP_HOLD_MS } });
  t.true((n.seen?.[NETHER] ?? []).some(p => p.x === -71 && p.z === 273), 'their portal kept for the setup\'s spot');
  // the look is closed, the setup open again once its hold is out; brain-status says the hold
  t.false(lookOpen(w));
  t.regex(netherLine(w, later), /\(not linked\); setup held until 18:40: not linked: the home portal came out at nether \(-71, 70, 273\), not at its own at nether \(-79, 70, 266\); others' portals seen: .* last trip 0 min ago \(not linked\): \[look\] the home portal came out/);
  // (the rung says the day's two trips first: the setup's own gate says its hold)
  t.deepEqual(setupReady(lookAt(f.inv, 1000, { now: later + HOUR }), w), {
    cause: 'hold', until: later + SETUP_HOLD_MS,
    text: 'setup held until 18:40: not linked: the home portal came out at nether (-71, 70, 273), not at its own at nether (-79, 70, 266)'
  });
});

test.serial('the look takes at most 10 minutes: with too little of them left after the kit it does not set out (an untried run, never through)', async (t) => {
  const w = linkedWorld();
  const f = game(w);
  const r = await lookRun(f.ctx, LOOK_LEAST_MS - 1, () => T0);
  t.like(r, { gain: 0, untried: true });
  t.regex(r.text, /^not setting out: the kit took 0 s, too little of the look's 10 min is left$/);
  t.false(f.did.some(d => d.startsWith('portal ')));
  t.is(LOOK_MAX_MS, 10 * MINUTE);
});

/** The setup trip run through (its hut built, its portal lit, linked), and a game of the world as it left it, two hours on. */
async function afterSetup() {
  const w = setupWorld();
  const first = game(w);
  await workGoals(() => undefined, LADDER, () => T0).find(g => g.name === 'work: nether')!.run(first.ctx);
  return { w, f: game(w, { items: first.inv, after: first, now: T0 + 2 * HOUR }) };
}

test.serial('the look\'s 10 minutes run out on the way down: nothing looked at, the link left as it is (the wrapper takes it home by its own portal)', async (t) => {
  const { w, f } = await afterSetup();
  // (six minutes a look at the clock: the kit's, then the arrival's)
  let clock = T0 - 6 * MINUTE;
  const r = await lookRun(f.ctx, HOUR, () => (clock += 6 * MINUTE));
  t.deepEqual(r, { gain: 0, text: 'out of the look\'s 10 min on the way down: nothing looked at' });
  t.like(peekNether(w), { linked: true, sites: [] });
  t.is(f.state.dim, NETHER);
  t.false(f.said.some(l => l.startsWith('nether: look')));
});

test.serial('a look that comes out by no portal the bridge lists (chunks not in yet): asked again, then nothing looked at and nothing said of the link', async (t) => {
  const { w, f } = await afterSetup();
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'portal.list' && f.state.dim === NETHER) return { dimension: NETHER, portals: [] };
    const got = await call(m, p) as Record<string, unknown>;
    if (m === 'portal.enter') delete got.arrived;
    return got;
  }) as GoalContext['call'];
  const r = await lookRun(f.ctx, HOUR, () => T0);
  t.deepEqual(r, { gain: 0, text: 'came out at nether (-79, 70, 267) by no portal the bridge lists: nothing looked at' });
  t.like(peekNether(w), { linked: true });
  t.is(peekNether(w).setupHold, undefined);
});

// ------------------------------------------------------------------------------------------------ the regear

const GEAR2 = '-547,64,2182';
const GEAR_AT: Pos = { x: -547, y: 64, z: 2182 };
const MAXD: Record<string, number> = { diamond_helmet: 363, diamond_chestplate: 528, diamond_leggings: 495, diamond_boots: 429, diamond_pickaxe: 1561, diamond_sword: 1561, golden_helmet: 77, flint_and_steel: 64 };
const CRAFTS: Record<string, Record<string, number>> = {
  diamond_helmet: { diamond: 5 }, diamond_chestplate: { diamond: 8 }, diamond_leggings: { diamond: 7 }, diamond_boots: { diamond: 4 },
  diamond_pickaxe: { diamond: 3, stick: 2 }, diamond_sword: { diamond: 2, stick: 1 }, flint_and_steel: { iron_ingot: 1, flint: 1 }, golden_helmet: { gold_ingot: 5 }
};
const ONE = /_(pickaxe|sword|helmet|chestplate|leggings|boots|shovel|axe|hoe)$|^(flint_and_steel|shield|bucket)$/;
const sizeOf = (n: string) => (ONE.test(n) ? 1 : 64);

/**
 * The live chests by their stacks, the spare set in the gear chest's slots 12 to 17 (as the live one is), an enchanted
 * helmet of old in slot 20 beside it; its own Nether-side portal linked; a death in the Nether 2 minutes before T0.
 */
function afterDeath(): WorldMemory {
  const w = linkedWorld();
  w.chestStacks = {};
  for (const [key, items] of Object.entries(w.chestItems!)) {
    const stacks: ChestStack[] = [];
    for (const [name, n] of Object.entries(items)) for (let left = n; left > 0; left -= sizeOf(name)) stacks.push({ slot: stacks.length, name, count: Math.min(left, sizeOf(name)) });
    w.chestStacks[key] = stacks;
  }
  const gear = w.chestStacks[GEAR2];
  gear.push({ slot: 20, name: 'diamond_helmet', count: 1, damage: 100, maxDamage: 363, enchantments: [{ name: 'protection', level: 3 }] });
  SPARE_SET.forEach((p, i) => gear.push({ slot: 12 + i, name: p.name, count: 1, damage: 0, maxDamage: MAXD[p.name] }));
  for (const p of SPARE_SET) w.chestItems![GEAR2][p.name] = 1;
  w.chestItems![GEAR2].diamond_helmet = 2;
  w.spareSet = { pieces: SPARE_SET.map((p, i) => ({ name: p.name, chest: { ...GEAR_AT }, slot: 12 + i })), at: T0 - DAY };
  netherOf(w).deaths.push({ at: T0 - 2 * MINUTE, where: { x: -70, y: 70, z: 270 } });
  return w;
}

/** What it carries after the death: what the food goal took (bread) and nothing else. */
const BARE: InventoryItem[] = [{ slot: 0, name: 'bread', count: 32 }];

/**
 * The storage house as the bridge and the tools answer: the chests by their stacks (chest.open, withdraw and deposit
 * by slot, take-from-chest and store-in-chest by name), the pockets, craft-item by the game's recipes, and the
 * Guardian putting carried armour on where none is worn as a screen closes.
 */
function storehouse(world: WorldMemory, items: InventoryItem[]) {
  const did: string[] = [];
  const said: string[] = [];
  const inv = items.map(i => ({ ...i }));
  const chests = new Map<string, ChestStack[]>(Object.entries(world.chestStacks ?? {}).map(([c, st]) => [c, st.map(x => ({ ...x }))]));
  let open = '';
  const at = (p: Record<string, unknown>) => `${p.x},${p.y},${p.z}`;
  const reply = (c: string): ChestContents => {
    const stacks = chests.get(c) ?? [];
    const totals: Record<string, number> = {};
    for (const st of stacks) totals[st.name] = (totals[st.name] ?? 0) + st.count;
    return { slots: 54, free: 54 - stacks.length, items: totals, stacks: stacks.map(st => ({ ...st })) };
  };
  const holds = (c: string) => `It holds: ${Object.entries(reply(c).items).map(([n, x]) => `${n} x${x}`).join(', ') || 'nothing'}; ${reply(c).free}/54 slots free.`;
  const pocket = () => { for (let i = 0; i < 36; i++) if (!inv.some(x => x.slot === i)) return i; return -1; };
  const give = (name: string, n: number, extra: Partial<InventoryItem> = {}) => {
    if (ONE.test(name)) { for (let i = 0; i < n; i++) inv.push({ slot: pocket(), name, count: 1, ...(MAXD[name] ? { damage: 0, maxDamage: MAXD[name] } : {}), ...extra }); return; }
    const has = inv.find(x => x.slot < 36 && x.name === name);
    if (has) has.count += n; else inv.push({ slot: pocket(), name, count: n });
  };
  const carried = (name: string) => inv.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
  const take = (name: string, n: number) => {
    let left = n;
    for (const x of inv.filter(i => i.slot < 36 && i.name === name)) { const q = Math.min(left, x.count); x.count -= q; left -= q; }
    for (let i = inv.length - 1; i >= 0; i--) if (inv[i].count <= 0) inv.splice(i, 1);
  };
  const wear = () => {
    for (const [slot, kind] of [[39, 'helmet'], [38, 'chestplate'], [37, 'leggings'], [36, 'boots']] as const) {
      if (inv.some(i => i.slot === slot)) continue;
      const piece = inv.find(i => i.slot < 36 && i.name.endsWith(`_${kind}`) && i.name !== 'golden_helmet');
      if (piece) piece.slot = slot;
    }
  };
  const ctx = {
    s: lookAt(inv, 1000), world, signal: new AbortController().signal, gain: () => undefined,
    progress: (x: string) => { said.push(x); },
    status: async () => ({ inWorld: true, username: 'claudebot', screen: null, position: { ...HOME }, dimension: OVERWORLD, health: 20, food: 20 }),
    call: async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: inv.map(i => ({ ...i })), held: { name: 'bread', count: 1 } };
      if (m === 'chest.open') { open = at(p); did.push(`chest.open ${open}`); return reply(open); }
      if (m === 'chest.withdraw') {
        const stacks = chests.get(open)!;
        const st = stacks.find(x => x.slot === p.slot && x.name === p.name) ?? stacks.find(x => x.name === p.name);
        if (!st) return { ...reply(open), moved: 0 };
        const n = Math.min(Number(p.count ?? st.count), st.count);
        st.count -= n;
        chests.set(open, stacks.filter(x => x.count > 0));
        give(st.name, n, { damage: st.damage ?? 0, ...(st.enchantments ? { enchanted: true, enchantments: st.enchantments } : {}) });
        did.push(`chest.withdraw ${p.name} slot ${st.slot} from ${open}`);
        return { ...reply(open), moved: n };
      }
      if (m === 'chest.deposit') {
        const from = inv.find(i => i.slot === p.slot && i.name === p.name);
        const stacks = chests.get(open) ?? [];
        if (!from || stacks.length >= 54) return { ...reply(open), moved: 0 };
        let slot = 0;
        while (stacks.some(st => st.slot === slot)) slot++;
        stacks.push({ slot, name: from.name, count: 1, damage: from.damage ?? 0, ...(from.maxDamage ? { maxDamage: from.maxDamage } : {}) });
        chests.set(open, stacks);
        from.count -= 1;
        if (from.count <= 0) inv.splice(inv.indexOf(from), 1);
        did.push(`chest.deposit ${p.name} into ${open} slot ${slot}`);
        return { ...reply(open), moved: 1 };
      }
      if (m === 'container.close') { open = ''; wear(); return {}; }
      if (m === 'goto') return { arrived: true, at: { ...HOME } };
      return {};
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      if (tool === 'take-from-chest') {
        const c = at(a);
        const stacks = chests.get(c) ?? [];
        let left = Number(a.count), n = 0;
        for (const st of stacks.filter(x => x.name === a.item)) { const q = Math.min(left, st.count); st.count -= q; left -= q; n += q; }
        chests.set(c, stacks.filter(x => x.count > 0));
        if (n) give(String(a.item), n);
        did.push(`take ${a.item} x${n}`);
        return n ? { ok: true, text: `Took ${n} ${a.item} from the chest at (${c}). ${holds(c)}` } : { ok: false, text: `No ${a.item} in the chest at (${c}). ${holds(c)}` };
      }
      if (tool === 'craft-item') {
        const out = String(a.outputItem), times = Number(a.amount ?? 1);
        const need = CRAFTS[out];
        if (!need || Object.entries(need).some(([n, x]) => carried(n) < x * times)) { did.push(`craft ${out} failed`); return { ok: false, text: `missing ingredients for ${out}` }; }
        for (const [n, x] of Object.entries(need)) take(n, x * times);
        give(out, times);
        did.push(`craft ${out}`);
        return { ok: true, text: `Crafted ${times} ${out}` };
      }
      if (tool === 'go-home' || tool === 'move-to-position') return { ok: true, text: 'Arrived' };
      did.push(`act ${tool}`);
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, did, said, inv, chests };
}

test('the regear wants after a death in the Nether, at home and within the hour, the spare pieces of what the death took; never for a death elsewhere, an old one, one seen to, or kinds it has again', (t) => {
  const w = afterDeath();
  const s = lookAt(BARE, 1000);
  t.is(regearGoal.wants(s, w), 'after the death in the nether at 16:38: the spare diamond_helmet, diamond_chestplate, diamond_leggings, diamond_boots, diamond_pickaxe, diamond_sword');
  // what the kit made again first keeps its spare in the chest
  const picked = [...BARE, { slot: 1, name: 'iron_pickaxe', count: 1 }];
  t.deepEqual(regearPieces(picked, w).map(p => p.name), ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_sword']);
  t.is(regearGoal.wants(lookAt(KIT, 1000), w), null, 'its gear whole: nothing to take');
  t.is(regearGoal.wants(lookAt(BARE, 1000, { now: T0 + REGEAR_WITHIN_MS }), w), null, 'an hour on: the kit\'s');
  t.is(regearGoal.wants(lookAt(BARE, 1000, { dimension: NETHER, distHome: Infinity }), w), null, 'not down there');
  t.truthy(regearGoal.wants(lookAt(BARE, 1000, { position: { x: -537, y: 63, z: 2193 }, distHome: 15.6 }), w), 'woken at the bed, 16 from home');
  t.is(regearGoal.wants(lookAt(BARE, 1000, { position: { x: HOME.x + 50, y: 63, z: HOME.z }, distHome: 50 }), w), null, 'from the yard only');
  const seen = afterDeath();
  netherOf(seen).regearedFor = T0 - 2 * MINUTE;
  t.is(regearGoal.wants(s, seen), null, 'seen to');
  const overworld = afterDeath();
  netherOf(overworld).deaths = [];
  t.is(regearGoal.wants(s, overworld), null, 'a death in the overworld is the kit\'s');
  const none = afterDeath();
  delete none.spareSet;
  t.is(regearGoal.wants(s, none), null, 'no spare set');
  // ahead of the kit (it would craft a new set from the diamonds), behind food and survival
  const goals = realGoals();
  const prio = (n: string) => goals.find(g => g.name === n)!.priority;
  t.true(prio('regear') > prio('kit') && prio('regear') < prio('food'));
  t.is(decide(s, w, goals, new Map())?.goal.name, 'regear');
  // (it reads and never writes)
  const before = JSON.stringify(w);
  regearGoal.wants(s, w);
  t.is(JSON.stringify(w), before);
});

test.serial('the regear: the spare set out of its chest by its slots (never the enchanted helmet by it), the armour worn, the pieces the set\'s no more, the death seen to; said in the log', async (t) => {
  const w = afterDeath();
  const h = storehouse(w, BARE);
  const text = await regearGoal.run(h.ctx);
  t.is(text, 'wore the spare diamond set after a death in the nether');
  t.true(h.said.includes('regear: wore the spare diamond set after a death in the nether'), h.said.join(' | '));
  t.deepEqual(h.did.filter(d => d.startsWith('chest.withdraw')), SPARE_SET.map((p, i) => `chest.withdraw ${p.name} slot ${12 + i} from ${GEAR2}`));
  t.deepEqual(h.inv.filter(i => i.slot >= 36).map(i => `${i.slot} ${i.name}`).sort(), ['36 diamond_boots', '37 diamond_leggings', '38 diamond_chestplate', '39 diamond_helmet']);
  t.true(h.inv.some(i => i.name === 'diamond_pickaxe' && i.slot < 36) && h.inv.some(i => i.name === 'diamond_sword' && i.slot < 36));
  t.like(h.chests.get(GEAR2)!.find(st => st.slot === 20), { name: 'diamond_helmet', enchantments: [{ name: 'protection', level: 3 }] });
  t.deepEqual(w.spareSet!.pieces, []);
  t.is(spareHeld(w).length, 0);
  t.is(peekNether(w).regearedFor, T0 - 2 * MINUTE);
  t.is(regearGoal.wants(lookAt(h.inv, 1000), w), null);
});

test.serial('the regear with half a set: what there is, worn, and what the kit makes said; nothing in the chests after all is a failure, the death not marked', async (t) => {
  const w = afterDeath();
  // the chestplate and the sword gone from the set (taken by hand), the chests' memory not told
  const h = storehouse(w, BARE);
  h.chests.set(GEAR2, h.chests.get(GEAR2)!.filter(st => !(st.slot === 13 || st.slot === 17)));
  await regearGoal.run(h.ctx);
  t.true(h.said.includes('regear: after a death in the nether, wore the spare diamond_helmet, diamond_leggings, diamond_boots, took the spare diamond_pickaxe; still short of diamond_chestplate, diamond_sword (the kit makes them)'), h.said.join(' | '));
  t.is(peekNether(w).regearedFor, T0 - 2 * MINUTE);
  const empty = afterDeath();
  const e = storehouse(empty, BARE);
  e.chests.set(GEAR2, []);
  await t.throwsAsync(regearGoal.run(e.ctx), { message: /^no spare piece came out of the chests: diamond_helmet: not in slot 12 of its chest/ });
  t.is(peekNether(empty).regearedFor, undefined);
});

// ------------------------------------------------------------------------------------------------ the chore

test('the Nether\'s things made whole again: a new spare set once the diamonds over the anvil\'s repairs and the netherite\'s 28 pay for all of it, a golden helmet, a flint and steel; only with the switch on and the portal built', (t) => {
  t.is(DIAMONDS_KEPT.repairs, 4 * ANVIL_ORDER.length, 'four for each kind the anvil repairs');
  t.is(DIAMONDS_KEPT.netherite, 28);
  const w = afterDeath();
  // the spare set taken by the regear, the helmet and the flint and steel lost down there with the rest
  delete w.spareSet;
  delete w.chestItems![GEAR2].golden_helmet;
  delete w.chestItems![GEAR2].flint_and_steel;
  const s = lookAt(BARE, 1000);
  t.like(sparesShort(s, w), { pieces: SPARE_SET.map(p => ({ name: p.name, diamonds: p.diamonds })), helmet: false, flint: true });
  t.is(sparesWant(s, w), 'for the nether trips: a flint and steel', 'two diamonds and no gold in the live chests');
  const ores = '-547,63,2180';
  w.chestItems![ores].diamond = 52 + 28;
  w.chestItems![ores].gold_ingot = 41;
  t.is(sparesWant(s, w), 'for the nether trips: a golden helmet, a flint and steel', '28 over: one short of the set\'s 29');
  w.chestItems![ores].diamond = 52 + 29;
  t.is(sparesWant(s, w), 'for the nether trips: the spare diamond_helmet, diamond_chestplate, diamond_leggings, diamond_boots, diamond_pickaxe, diamond_sword (29 of the 29 diamonds over the 52 kept), a golden helmet, a flint and steel');
  const off = structuredClone(w);
  netherOf(off).trips = false;
  t.is(sparesWant(s, off), null, 'the switch off');
  const before = structuredClone(w);
  before.progress!.done = before.progress!.done.filter(d => d !== 'nether-portal');
  t.is(sparesWant(s, before), null, 'the portal milestone not done: its own steps make them');
  t.is(sparesWant(lookAt(BARE, 1000, { position: { x: HOME.x + 30, y: 63, z: HOME.z }, distHome: 30 }), w), null);
  const unseen = structuredClone(w);
  delete unseen.chestItems!['-547,65,2181'];
  t.is(sparesWant(s, unseen), null, 'a chest not looked into: the memory says nothing yet');
  t.is(netherSparesGoal.cuts!(s, w), false, 'it stops nothing');
  const looked = JSON.stringify(w);
  sparesWant(s, w); sparesShort(s, w);
  t.is(JSON.stringify(w), looked, 'a look only');
  t.is(sparesWant(lookAt(KIT, 1000), linkedWorld()), null, 'the live chests as they are, the set whole: nothing');
});

test.serial('the chore\'s run: the spare set crafted anew and stored by its slots, a golden helmet and a flint and steel crafted, the fire starter out of the hand; then nothing more to do', async (t) => {
  const w = afterDeath();
  delete w.spareSet;
  for (const p of SPARE_SET) delete w.chestItems![GEAR2][p.name];
  w.chestItems![GEAR2].diamond_helmet = 1;
  w.chestStacks![GEAR2] = w.chestStacks![GEAR2].filter(st => st.slot < 12);
  delete w.chestItems![GEAR2].golden_helmet;
  delete w.chestItems![GEAR2].flint_and_steel;
  w.chestStacks![GEAR2] = w.chestStacks![GEAR2].filter(st => !['golden_helmet', 'flint_and_steel'].includes(st.name));
  const ores = '-547,63,2180';
  w.chestItems![ores].diamond = 200;
  w.chestItems![ores].gold_ingot = 41;
  w.chestStacks![ores].push({ slot: 40, name: 'diamond', count: 64 }, { slot: 41, name: 'diamond', count: 64 }, { slot: 42, name: 'diamond', count: 64 }, { slot: 43, name: 'diamond', count: 6 }, { slot: 44, name: 'gold_ingot', count: 41 });
  const h = storehouse(w, [...BARE, ...WORN.map(i => ({ ...i })), { slot: 2, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: [{ name: 'efficiency', level: 3 }] }, { slot: 3, name: 'diamond_sword', count: 1, enchanted: true, enchantments: [{ name: 'sharpness', level: 3 }] }]);
  const s = lookAt(h.inv, 1000);
  t.regex(sparesWant(s, w) ?? '', /^for the nether trips: the spare diamond_helmet, .*, a golden helmet, a flint and steel$/);
  const text = await netherSparesGoal.run(h.ctx);
  t.regex(text, /^stored diamond_helmet \(slot \d+\), .* as the spare set: all 6 pieces in the chests; crafted a golden helmet for the nether; crafted a flint and steel for the nether$/);
  t.deepEqual(spareHeld(w).map(p => p.name), SPARE_SET.map(p => p.name));
  t.true(h.did.includes('craft golden_helmet') && h.did.includes('craft flint_and_steel'));
  t.true(h.inv.some(i => i.name === 'diamond_pickaxe' && i.enchanted), 'its own enchanted pickaxe is no spare');
  t.is(sparesWant(lookAt(h.inv, 1000), w), null);
});

test.serial('after a death on the setup trip (the frame\'s obsidian lost with it, none in the chests): the chore wants what the frame still needs and makes a batch a run by the portal milestone\'s own step; none once its portal stands', async (t) => {
  const w = setupWorld();
  // the kit took the chests' 10 down there, 3 went into the frame, the death took the rest
  delete w.chestItems!['-547,64,2180'].obsidian;
  netherOf(w).setupSpot = { x: -79, y: 70, z: 266, axis: 'z', side: 1, door: 1, obsidian: 7 };
  const s = lookAt(KIT, 1000);
  t.like(sparesShort(s, w), { obsidian: 7 });
  t.is(sparesWant(s, w), 'for the nether trips: 7 obsidian for its own portal\'s frame');
  t.like(setupReady(s, w), { cause: 'kit', text: 'setup: short of 7 obsidian (carried or in the chests)' });
  // the run: obsidian in sight that no portal owns (a ruined portal's, say), dug a batch at a time
  const h = storehouse(w, KIT);
  const loose: Pos[] = Array.from({ length: 10 }, (_, i) => ({ x: -500 + i, y: 60, z: 2250 }));
  const call = h.ctx.call, act = h.ctx.act;
  (h.ctx as { call: GoalContext['call'] }).call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (m === 'world.findBlocks') return { positions: p.block === 'obsidian' ? loose.map(x => ({ ...x })) : [] };
    return call(m, p, ms);
  }) as GoalContext['call'];
  (h.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool !== 'dig-block') return act(tool, a);
    const at = loose.findIndex(x => x.x === a.x && x.y === a.y && x.z === a.z);
    if (at >= 0) loose.splice(at, 1);
    const st = h.inv.find(i => i.slot < 36 && i.name === 'obsidian');
    if (st) st.count += 1;
    else { let slot = 0; while (h.inv.some(i => i.slot === slot)) slot++; h.inv.push({ slot, name: 'obsidian', count: 1 }); }
    return { ok: true, text: `Dug obsidian at (${a.x}, ${a.y}, ${a.z})` };
  }) as GoalContext['act'];
  const carry = structuredClone(w.progress?.carry);
  t.is(await netherSparesGoal.run(h.ctx), 'obsidian for its own portal\'s frame: 4/7 obsidian (near home)');
  t.is(h.inv.filter(i => i.name === 'obsidian').reduce((a, i) => a + i.count, 0), 4);
  t.deepEqual(w.progress?.carry, carry, 'the project\'s carry as it was: nothing of a milestone\'s');
  t.is(sparesWant(lookAt(h.inv, 1000), w), 'for the nether trips: 3 obsidian for its own portal\'s frame');
  // its portal lit (or linked): the frame needs nothing
  netherOf(w).portal = { x: -79, y: 70, z: 266 };
  t.like(sparesShort(lookAt(BARE, 1000), w), { obsidian: 0 });
  t.is(sparesWant(lookAt(BARE, 1000), w), null);
});

// ------------------------------------------------------------------------------------------------ F4: the kit's things

const ORES2 = '-547,63,2180';
const STONE5 = '-549,65,2185';
/** Diamonds in the ores chest, by their stacks: enough for a whole new set over those kept (as live: 1441). */
function diamonds(w: WorldMemory): void {
  w.chestItems![ORES2].diamond = 200;
  w.chestStacks![ORES2].push({ slot: 40, name: 'diamond', count: 64 }, { slot: 41, name: 'diamond', count: 64 }, { slot: 42, name: 'diamond', count: 64 }, { slot: 43, name: 'diamond', count: 8 });
}
/** The gear chest's memory as a reply that held none of the set left it (live, Nov 15 02:39Z): the chest itself still holds it. */
function setForgotten(w: WorldMemory): void {
  const items = { ...w.chestItems![GEAR2] };
  for (const p of SPARE_SET) delete items[p.name];
  remember(w, GEAR_AT, items);
}
const SLOTS_12_17 = SPARE_SET.map((p, i) => `${p.name} ${GEAR2} ${12 + i}`);
const where = (w: WorldMemory) => sparePieces(w).map(p => `${p.name} ${key(p.chest)} ${p.slot}`);

test.serial('F4: the nether spares chore never crafts the set again while the record holds it: the gear chest\'s memory without the six pieces, the chest is looked into first, they are there, nothing crafted', async (t) => {
  const w = afterDeath();
  netherOf(w).deaths = [];
  diamonds(w);
  const h = storehouse(w, [...BARE, ...WORN.map(i => ({ ...i }))]);
  setForgotten(w);
  t.regex(sparesWant(lookAt(h.inv, 1000), w) ?? '', /^for the nether trips: the spare diamond_helmet, diamond_chestplate, diamond_leggings, diamond_boots, diamond_pickaxe, diamond_sword \(29 of /);
  const text = await netherSparesGoal.run(h.ctx);
  t.is(text, 'the spare diamond set is in the chests (6 pieces; the chest at (-547, 64, 2182) looked into again)');
  t.true(h.did.includes(`chest.open ${GEAR2}`));
  t.false(h.did.some(d => /^craft /.test(d)), h.did.join(' | '));
  t.deepEqual(where(w), SLOTS_12_17);
  t.is(spareHeld(w).length, 6);
  t.is(w.chestItems![ORES2].diamond, 200, 'not a diamond spent');
  t.is(sparesWant(lookAt(h.inv, 1000), w), null);
});

test.serial('F4: a piece that is truly gone (the look into its chest shows its slot empty): only that piece crafted, the rest kept where they are', async (t) => {
  const w = afterDeath();
  netherOf(w).deaths = [];
  diamonds(w);
  const h = storehouse(w, [...BARE, ...WORN.map(i => ({ ...i }))]);
  // the chestplate taken by hand, then a reply without the set
  h.chests.set(GEAR2, h.chests.get(GEAR2)!.filter(st => st.slot !== 13));
  setForgotten(w);
  const text = await netherSparesGoal.run(h.ctx);
  t.regex(text, /^stored diamond_chestplate \(slot \d+\) as the spare set; the chest at \(-547, 64, 2182\) looked into again: all 6 pieces in the chests$/);
  t.deepEqual(h.did.filter(d => /^craft /.test(d)), ['craft diamond_chestplate']);
  t.deepEqual(where(w).filter(x => !x.startsWith('diamond_chestplate')), SLOTS_12_17.filter(x => !x.startsWith('diamond_chestplate')));
  t.is(spareHeld(w).length, 6);
});

test.serial('F4: a look into the set\'s chest that fails (not reached, not opened) shows nothing gone: nothing crafted, not a diamond spent, the record as it was, and the run fails to its retry time', async (t) => {
  const w = afterDeath();
  netherOf(w).deaths = [];
  diamonds(w);
  const h = storehouse(w, [...BARE, ...WORN.map(i => ({ ...i }))]);
  setForgotten(w);
  const inner = h.ctx.call;
  h.ctx.call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (m === 'chest.open' && `${p.x},${p.y},${p.z}` === GEAR2) throw new Error('bridge call chest.open timed out');
    return inner(m, p, ms);
  }) as GoalContext['call'];
  await t.throwsAsync(netherSparesGoal.run(h.ctx), { message: 'the spare set\'s chest at (-547, 64, 2182) could not be looked into: nothing made' });
  t.false(h.did.some(d => /^craft /.test(d)), h.did.join(' | '));
  t.is(w.chestItems![ORES2].diamond, 200, 'not a diamond spent');
  t.deepEqual(where(w), SLOTS_12_17);
  t.true(h.said.some(l => l.startsWith('the spare set\'s chest at (-547, 64, 2182): ')), h.said.join(' | '));
});

test('F4: two spare sets in the record (live, Nov 15: twelve pieces in three chests): one set, the one in its slots, the other six plain stock the kit and the regear may take', (t) => {
  const w = afterDeath();
  netherOf(w).deaths = [];
  const STONE2 = '-547,64,2180';
  const second = SPARE_SET.map((p, i) => ({ name: p.name, chest: { x: -547, y: 64, z: 2180 }, slot: 30 + i }));
  for (const p of second) { w.chestStacks![STONE2].push({ slot: p.slot, name: p.name, count: 1, damage: 0, maxDamage: MAXD[p.name] }); w.chestItems![STONE2][p.name] = 1; }
  w.spareSet!.pieces.push(...second);
  t.is(sparePieces(w).length, 12);
  // one of each, read as one set at once: the second set is reserved no more
  t.deepEqual(spareHeld(w).map(p => `${p.name} ${key(p.chest)} ${p.slot}`), SLOTS_12_17);
  t.is(freeChestTotals(w).diamond_chestplate, 1, 'the second chestplate is stock');
  t.is(freeChestTotals(w).diamond_helmet, 2, 'the second helmet and the enchanted one of old');
  // the record made one set: the second let go
  const lost = structuredClone(w);
  t.deepEqual(oneSpareSet(w).map(p => `${p.name} ${key(p.chest)} ${p.slot}`), second.map(p => `${p.name} ${STONE2} ${p.slot}`));
  t.deepEqual(where(w), SLOTS_12_17);
  t.deepEqual(oneSpareSet(w), [], 'once: one set is left as it is');
  // a first-set piece seen gone (its slot empty at a look), the second's of that name is the set's
  remember(lost, GEAR_AT, { ...lost.chestItems![GEAR2], diamond_chestplate: 0 }, lost.chestStacks![GEAR2].filter(st => st.slot !== 13));
  oneSpareSet(lost);
  t.deepEqual(where(lost).find(x => x.startsWith('diamond_chestplate')), `diamond_chestplate ${STONE2} 31`);
  t.is(sparePieces(lost).length, 6);
});

test.serial('F4: on the brain\'s tick the two-set record is made one set and said once in the log', async (t) => {
  const w = afterDeath();
  netherOf(w).deaths = [];
  w.spareSet!.pieces.push(...SPARE_SET.map((p, i) => ({ name: p.name, chest: { x: -547, y: 64, z: 2180 }, slot: 30 + i })));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spares-'));
  const file = path.join(dir, 'brain.json');
  const logFile = path.join(dir, 'brain.log');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': w }));
  const rt = {
    actions: {},
    call: (async (method: string) => (method === 'inventory' ? { items: KIT.map(i => ({ ...i })) } : method === 'world.region' ? { blocks: [] } : {})) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, block: { ...HOME }, timeOfDay: 1000, hashedSeed: '1', dimension: OVERWORLD,
      sleeping: false, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: OVERWORLD }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals: [], logFile, memoryFile: file });
  brain.setEnabled(true);
  await brain.tick();
  await brain.tick();
  brain.setEnabled(false);
  const mem = (brain as unknown as { memory: BrainMemory }).memory.world('seed:1');
  t.deepEqual(where(mem), SLOTS_12_17);
  const said = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('spare set:'));
  t.is(said.length, 1);
  t.true(said[0].endsWith('spare set: one set kept, 6 pieces of a second let go as plain stock (diamond_helmet in slot 30 of (-547, 64, 2180), diamond_chestplate in slot 31 of (-547, 64, 2180), diamond_leggings in slot 32 of (-547, 64, 2180), diamond_boots in slot 33 of (-547, 64, 2180), diamond_pickaxe in slot 34 of (-547, 64, 2180), diamond_sword in slot 35 of (-547, 64, 2180))'), said[0]);
});

test.serial('F4: a golden helmet and a flint and steel the chests\' memory has none of are looked for in the chests before the chore crafts them: found, nothing crafted, nothing spent', async (t) => {
  const w = afterDeath();
  netherOf(w).deaths = [];
  w.chestItems![ORES2].gold_ingot = 41;
  // the stash put them in a stone chest (the gear chests full); the memory of it lost them
  const gear = w.chestStacks![GEAR2];
  const moved = gear.filter(st => st.name === 'golden_helmet' || st.name === 'flint_and_steel');
  w.chestStacks![GEAR2] = gear.filter(st => !moved.includes(st));
  w.chestStacks![STONE5].push(...moved.map((st, i) => ({ ...st, slot: 20 + i })));
  const h = storehouse(w, [...BARE, ...WORN.map(i => ({ ...i }))]);
  delete w.chestItems![GEAR2].golden_helmet;
  delete w.chestItems![GEAR2].flint_and_steel;
  const s = lookAt(h.inv, 1000);
  t.is(sparesWant(s, w), 'for the nether trips: a golden helmet, a flint and steel');
  const text = await netherSparesGoal.run(h.ctx);
  t.is(text, 'a golden helmet in the chest at (-549, 65, 2185) after all; a flint and steel in the chest at (-549, 65, 2185) after all');
  t.false(h.did.some(d => /^craft /.test(d)), h.did.join(' | '));
  // the gear chests looked into first
  t.deepEqual(h.did.filter(d => d.startsWith('chest.open')).slice(0, 2), [`chest.open ${GEAR2}`, 'chest.open -551,63,2181']);
  t.is(w.chestItems![ORES2].gold_ingot, 41);
  t.is(sparesWant(lookAt(h.inv, 1000), w), null);
});

test('F4: the golden helmet down there is watched a look at a time: gone at a later look with no death since, it broke, said once; home with it, or a death, says nothing', (t) => {
  const w = linkedWorld();
  const worn = (damage: number): InventoryItem[] => [...KIT.filter(i => i.slot !== 39), { slot: 39, name: 'golden_helmet', count: 1, damage, maxDamage: 77 }];
  const bare = KIT.filter(i => i.slot !== 39);
  const down = (items: InventoryItem[], now: number, d?: DeathSeen) => netherTick(lookAt(items, 1000, { now, dimension: NETHER, distHome: Infinity }), w, d);
  t.deepEqual(down(worn(60), T0), []);
  t.deepEqual(down(worn(70), T0 + 5000), []);
  t.like(peekNether(w).helmet, { left: 7, max: 77 });
  t.deepEqual(down(bare, T0 + 10_000), ['nether: the golden helmet broke down there (7/77 left at the last look, 16:40): the nether spares chore makes another']);
  t.deepEqual(down(bare, T0 + 15_000), [], 'said once');
  t.is(peekNether(w).helmet, undefined);
  // home with it: nothing said, the watch let go of
  down(worn(10), T0 + 20_000);
  t.deepEqual(netherTick(lookAt(worn(10), 1000, { now: T0 + 25_000 }), w, undefined), []);
  t.is(peekNether(w).helmet, undefined);
  // a death down there takes it with the rest: no break
  down(worn(10), T0 + 30_000);
  t.deepEqual(netherTick(lookAt(bare, 1000, { now: T0 + 40_000 }), w, { at: { x: -70, y: 70, z: 270 }, time: T0 + 35_000, dimension: NETHER }).filter(l => /helmet/.test(l)), []);
  t.is(peekNether(w).helmet, undefined);
  // the look that first tells of a death still down there and still showing the helmet (the slots not cleared yet,
  // the death a second before the look): the first look home says nothing either
  down(worn(10), T0 + 50_000);
  const death: DeathSeen = { at: { x: -70, y: 70, z: 270 }, time: T0 + 54_000, dimension: NETHER };
  t.deepEqual(down(worn(10), T0 + 55_000, death).filter(l => /helmet/.test(l)), []);
  t.deepEqual(netherTick(lookAt(bare, 1000, { now: T0 + 60_000 }), w, death).filter(l => /helmet/.test(l)), []);
  t.is(peekNether(w).helmet, undefined);
  // the next trip, that death still told on every tick (as the runtime does while Node runs): watched again, and a
  // break said
  down(worn(70), T0 + 100_000, death);
  t.like(peekNether(w).helmet, { left: 7, at: T0 + 100_000 });
  t.deepEqual(down(bare, T0 + 105_000, death), ['nether: the golden helmet broke down there (7/77 left at the last look, 16:41): the nether spares chore makes another']);
});

// ------------------------------------------------------------------------------------------------ the switch off

test('the switch off (the live world): none of the ramp\'s goals wants, and the rung says so, at any hour, kitted or bare', (t) => {
  const goals = realGoals();
  const ours = ['regear', 'nether spares', 'work: nether'];
  for (const tod of [0, 1000, 3000, 6000, 11_000, 13_000]) for (const items of [KIT, BARE, WORN.map(i => ({ ...i }))]) {
    const w = liveWorld();
    const s = lookAt(items, tod);
    for (const g of goals.filter(x => ours.includes(x.name))) t.is(g.wants(s, w), null, `${g.name} at ${tod}`);
    const d = decide(s, w, goals, new Map());
    t.false(!!d && ours.includes(d.goal.name), d?.goal.name);
    if (tod < 11_000) t.deepEqual(goals.find(g => g.name === 'work: nether')!.declines!(s, w), { cause: 'unneeded', text: 'nether trips are off' });
  }
});
