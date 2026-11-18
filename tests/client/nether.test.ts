import test from 'ava';
import sinon from 'sinon';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { MessageStore } from '../../src/message-store.js';
import { registerClientTools, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import type { BridgeClient } from '../../src/client/bridge-client.js';
import { Brain, SURVIVAL, decide } from '../../src/client/brain/brain.js';
import { shelterGoal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  LEAVE_LEAD_TICKS, NETHER, NETHER_PER_DAY, NETHER_PROBATION, NETHER_WORTH_MS, allOwnPortals, deathHold, leaveNetherGoal, leaveWhy, linkedTo,
  netherBudgetMs, netherCheck, netherHome, netherLine, netherOf, netherPortalSpot, netherTick, notePortals, peekNether, portalCells, scaled, spotFault,
  tripHold, type PortalShape
} from '../../src/client/brain/nether.js';
import { NETHER_BLOCKS, NETHER_TRIP, netherTripKit } from '../../src/client/brain/mine.js';
import { ROOM, out as afield } from '../../src/client/brain/pockets.js';
import { stashKeep } from '../../src/client/brain/chores.js';
import { recoverGoal } from '../../src/client/brain/food.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals, workTick, type WorkTask } from '../../src/client/brain/work.js';
import { HOME, KEPT, MINUTE, T0, WORN, liveWorld, lookAt, realGoals, withProject } from '../helpers/homestead.js';

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The home portal as the portal milestone builds it on the live yard (portal.ts: the site west of the storage house,
 * its plane along z), and the community's portals: the overworld one by the community chest (-437, 68, 2134), and its
 * Nether side by that one's scaled point, about 15 from home's.
 */
const HOME_PORTAL: PortalShape = { x: -562, y: 63, z: 2191, axis: 'z', width: 2, height: 3 };
const COMMUNITY: PortalShape = { x: -440, y: 68, z: 2130, axis: 'x', width: 2, height: 3 };
const COMMUNITY_NETHER: PortalShape = { x: -56, y: 70, z: 267, axis: 'x', width: 2, height: 3 };
/** Where the bot stands in the Nether in these tests: by home's scaled point. */
const DOWN: Pos = { x: -70, y: 64, z: 274 };

/** The live world with the portal milestone done: the home portal lit (`portal:lit`) and the switch as given. */
function portalWorld(trips?: boolean): WorldMemory {
  const w = withProject(liveWorld(), false);
  w.progress!.done.push('enchanting', 'workshop', 'nether-portal');
  delete w.progress!.current;
  w.zones!.portal = [{ x: -563, y: 62, z: 2189, width: 3, length: 6 }];
  w.zones!['portal:frame'] = [{ x: HOME_PORTAL.x, y: HOME_PORTAL.y, z: HOME_PORTAL.z }];
  w.zones!['portal:lit'] = [{ x: HOME_PORTAL.x, y: HOME_PORTAL.y, z: HOME_PORTAL.z }];
  if (trips !== undefined) w.nether = { trips };
  return w;
}

const KIT: InventoryItem[] = [...KEPT.map(([name, count], slot) => ({ slot, name, count })), ...WORN.map(i => ({ ...i }))];
/** In the Nether by home's scaled point at the time of day given, the live kit carried. */
const down = (tod: number, over: Partial<Snapshot> = {}): Snapshot =>
  lookAt(KIT, tod, { dimension: NETHER, position: { ...DOWN }, distHome: Infinity, ...over });

// ------------------------------------------------------------------------------------------------ where a portal leads

test('scaled: an eighth into the Nether, eight times back, to the block, the height kept (floored as the server does, below zero too)', (t) => {
  // home's scaled point (the brief: about (-69, 273))
  t.deepEqual(scaled(HOME, NETHER), { x: -69, y: 63, z: 272 });
  t.deepEqual(scaled({ x: -69, y: 63, z: 272 }, 'overworld'), { x: -552, y: 63, z: 2176 });
  t.deepEqual(scaled({ x: 7, y: 70, z: 8 }, NETHER), { x: 0, y: 70, z: 1 });
  t.deepEqual(scaled({ x: -1, y: 70, z: -8 }, NETHER), { x: -1, y: 70, z: -1 });
  t.deepEqual(scaled({ x: -9, y: 70, z: -8.5 }, NETHER), { x: -2, y: 70, z: -2 });
  // an entity's own place (a fraction of a block) floors the same as its block's going in
  t.deepEqual(scaled({ x: -548.3, y: 63, z: 2183.9 }, NETHER), scaled({ x: -549, y: 63, z: 2183 }, NETHER));
  t.deepEqual(scaled({ x: -69.7, y: 63.2, z: 272.4 }, 'overworld'), { x: -558, y: 63, z: 2179 });
});

test('the server\'s rule for the far end: a square of 16 (any height), the nearest block by straight line, a tie to the lower', (t) => {
  const from = { x: 0, y: 64, z: 0 };
  const at = (x: number, y: number, z: number, axis = 'x'): PortalShape => ({ x, y, z, axis });
  // the corner of the square is in, a block past its side is not (a circle of 16 would have it the other way round)
  t.is(linkedTo(from, [at(16, 64, 15, 'z')], 16)?.portal.x, 16);
  t.is(linkedTo(from, [at(17, 64, 0, 'z')], 16), undefined);
  // the nearest in three dimensions: one 3 across and 10 up loses to one 8 across on the level
  const up = at(3, 74, 0, 'z'), level = at(8, 64, 0, 'z');
  t.is(linkedTo(from, [up, level], 16)?.portal, level);
  // a tie goes to the lower one
  const a = at(0, 66, 4, 'x'), b = at(0, 62, 4, 'x');
  t.is(linkedTo({ x: 0, y: 64, z: 0 }, [a, b], 16)?.portal, b);
  t.is(portalCells(at(1, 2, 3, 'z')).length, 6);
  t.deepEqual(portalCells({ x: 1, y: 2, z: 3, axis: 'z', width: 3, height: 4 }).at(-1), { x: 1, y: 5, z: 5 });
});

test('netherPortalSpot on the live home: as things stand the home portal comes out at the community\'s Nether side; the spot is at home\'s scaled point, wins that link, takes none, and leads back', (t) => {
  // home's scaled point, from the home portal's two bottom cells: x -71, z 273 and 274
  const p = scaled({ x: HOME_PORTAL.x, y: HOME_PORTAL.y, z: HOME_PORTAL.z }, NETHER);
  t.deepEqual(p, { x: -71, y: 63, z: 273 });
  t.is(linkedTo(p, [COMMUNITY_NETHER], 16)?.portal, COMMUNITY_NETHER, 'the community\'s Nether side is within 16: the home portal would come out there');
  const r = netherPortalSpot(HOME_PORTAL, [COMMUNITY_NETHER], [COMMUNITY]);
  t.deepEqual(r.spot, { x: -71, y: 63, z: 273, axis: 'x' });
  t.regex(r.why, /^nether \(-71, 63, 273\) along x, 0\.0 from home's scaled point nether \(-71, 63, 273\): the home portal leads to it, it takes no one's link and it leads back home \(1 nether and 1 overworld portal\(s\) known\)$/);
  const spot = { ...r.spot!, width: 2, height: 3 };
  t.is(spotFault(spot, HOME_PORTAL, [COMMUNITY_NETHER], [COMMUNITY]), null);
  // the community's own link stays its own: from its scaled point its Nether side is still the nearer
  t.is(linkedTo(scaled({ x: COMMUNITY.x, y: COMMUNITY.y, z: COMMUNITY.z }, NETHER), [spot, COMMUNITY_NETHER], 16)?.portal, COMMUNITY_NETHER);
  // and the spot asked at another height (the Nether's ground is where it is)
  t.is(netherPortalSpot(HOME_PORTAL, [COMMUNITY_NETHER], [COMMUNITY], { ys: [80] }).spot?.y, 80);
});

test('netherPortalSpot: a spot that would take someone\'s link is refused, whether that one\'s Nether side is known or not', (t) => {
  const p = { x: -71, y: 63, z: 273 };
  // someone's overworld portal leading 6 east of home's scaled point, its Nether side there too: a spot nearer that
  // point than their portal takes their link
  const theirs: PortalShape = { x: (p.x + 6) * 8, y: 63, z: p.z * 8, axis: 'x' };
  const theirsNether: PortalShape = { x: p.x + 7, y: 63, z: p.z + 2, axis: 'x' };
  const stealing = { x: p.x + 5, y: 63, z: p.z, axis: 'x', width: 2, height: 3 };
  t.regex(spotFault(stealing, HOME_PORTAL, [theirsNether], [theirs]) ?? '', /^it would take the link of the portal at overworld \(-520, 63, 2184\)/);
  const r = netherPortalSpot(HOME_PORTAL, [theirsNether], [theirs]);
  t.truthy(r.spot, r.why);
  const spot = { ...r.spot!, width: 2, height: 3 };
  t.is(spotFault(spot, HOME_PORTAL, [theirsNether], [theirs]), null);
  t.is(linkedTo(scaled({ x: theirs.x, y: theirs.y, z: theirs.z }, NETHER), [spot, theirsNether], 16)?.portal, theirsNether);

  // its Nether side not seen: the spot keeps 24 clear of where it leads, west of home's point here
  const blind: PortalShape = { x: (p.x + 10) * 8, y: 63, z: p.z * 8, axis: 'x' };
  t.regex(spotFault({ x: p.x, y: 63, z: p.z, axis: 'x', width: 2, height: 3 }, HOME_PORTAL, [], [blind]) ?? '', /^within 24 of nether \(-61, 63, 273\), where the portal at overworld \(-488, 63, 2184\) leads \(its nether side not seen\)$/);
  const away = netherPortalSpot(HOME_PORTAL, [], [blind]);
  t.truthy(away.spot, away.why);
  t.true(portalCells({ ...away.spot!, width: 2 }).every(c => Math.max(Math.abs(c.x - (p.x + 10)), Math.abs(c.z - p.z)) >= 24), JSON.stringify(away.spot));
  // one leading right to home's point, its side unknown: no spot within 16 of home's point is 24 clear of it
  const onTop: PortalShape = { x: p.x * 8, y: 63, z: p.z * 8, axis: 'x' };
  const none = netherPortalSpot(HOME_PORTAL, [], [onTop]);
  t.is(none.spot, undefined);
  t.regex(none.why, /^no spot within 16 of home's scaled point nether \(-71, 63, 273\) will do \(0 nether and 1 overworld portal\(s\) known\): it takes someone's link \(\d+ spots\)/);
});

test('netherPortalSpot: one that would lead back to someone else\'s overworld portal is refused (the way home must come out at home)', (t) => {
  // a portal by home's own, nearer where the spot leads back to than the home portal is
  const p = { x: -71, y: 63, z: 273 };
  const spot = { x: p.x, y: 63, z: p.z, axis: 'x', width: 2, height: 3 };
  const byHome: PortalShape = { x: 8 * p.x + 4, y: 63, z: 8 * p.z + 3, axis: 'x' };
  // (its Nether side is the community's: far, so the spot steals nothing of it)
  t.regex(spotFault(spot, HOME_PORTAL, [COMMUNITY_NETHER], [COMMUNITY, byHome]) ?? '', /^the home portal would come out|^back through it the bot would come out at the portal at overworld \(-564, 63, 2187\)$|^it would take/);
  t.regex(spotFault(spot, HOME_PORTAL, [], [byHome]) ?? '', /within 24 of|back through it/);
});

// ------------------------------------------------------------------------------------------------ the holds

test('the death-hold ladder: a death in the Nether holds the trips 1 h, two in 24 h a day, three in 3 days switch them off (as the third comes, once: turned on again, it stays on)', (t) => {
  const world = portalWorld(true);
  const s = (now: number) => lookAt(KIT, 1000, { now });
  const die = (time: number) => netherTick(s(time), world, { at: { x: -70, y: 40, z: 280 }, time, dimension: NETHER });
  t.deepEqual(die(T0), ['nether: a death at nether (-70, 40, 280): no trips until 17:40']);
  t.is(netherOf(world).cleanTrips, 0);
  t.like(deathHold(s(T0 + 30 * MINUTE), world), { cause: 'hold', text: 'a death in the nether: held until 17:40', until: T0 + HOUR });
  t.is(deathHold(s(T0 + HOUR), world), null);
  // the same death told again books nothing more
  t.deepEqual(die(T0), []);
  t.is(netherOf(world).deaths.length, 1);
  // a second within 24 h: until the older is a day old
  t.true(die(T0 + 5 * HOUR)[0].startsWith('nether: a death'));
  t.like(deathHold(s(T0 + 7 * HOUR), world), { text: 'two deaths in the nether in 24 h: held until 16:40', until: T0 + DAY });
  t.is(deathHold(s(T0 + DAY + 1), world), null);
  // a third in 3 days: the switch goes off, and the line says so once
  t.deepEqual(die(T0 + 2 * DAY), ['nether: a death at nether (-70, 40, 280): no trips until 17:40', 'nether trips off: 3 deaths in 3 days']);
  t.false(netherOf(world).trips);
  t.is(leaveWhy(down(1000, { now: T0 + 2 * DAY + 2 * HOUR }), world), 'nether trips are off: home');
  t.deepEqual(netherTick(s(T0 + 2 * DAY + MINUTE), world, undefined), []);
  // the lead turns them on again: the three deaths do not turn them off a second time
  netherOf(world).trips = true;
  t.deepEqual(netherTick(s(T0 + 2 * DAY + 2 * MINUTE), world, { at: { x: -70, y: 40, z: 280 }, time: T0 + 2 * DAY, dimension: NETHER }), []);
  t.true(netherOf(world).trips);
  t.like(deathHold(s(T0 + 2 * DAY + 30 * MINUTE), world), { text: 'a death in the nether: held until 17:40' });
  // three days on, the first death is let go
  netherTick(s(T0 + 3 * DAY + 1), world, undefined);
  t.is(netherOf(world).deaths.length, 2);
  // an overworld death is none of the Nether's
  const other = portalWorld(true);
  t.deepEqual(netherTick(s(T0), other, { at: { x: 1, y: 64, z: 1 }, time: T0, dimension: 'overworld' }), []);
  t.is(deathHold(s(T0 + MINUTE), other), null);
  // and a world that never went near the Nether keeps no memory of it
  const quiet = liveWorld();
  netherTick(s(T0), quiet, undefined);
  t.is(quiet.nether, undefined);
});

test('a Nether death past its 3 days, told again on every tick (the runtime keeps the last death while Node runs), is not booked again: no line, the clean trips kept', (t) => {
  const world = portalWorld(true);
  const death = { at: { ...DOWN }, time: T0, dimension: NETHER };
  t.is(netherTick(lookAt(KIT, 1000, { now: T0 }), world, death).length, 1);
  netherOf(world).cleanTrips = 2;
  for (const now of [T0 + 3 * DAY + MINUTE, T0 + 3 * DAY + MINUTE + 5000, T0 + 3 * DAY + MINUTE + 10000]) {
    t.deepEqual(netherTick(lookAt(KIT, 1000, { now }), world, death), []);
    t.is(netherOf(world).cleanTrips, 2);
    t.is(netherOf(world).deaths.length, 0);
  }
  // nor one first told only after its 3 days (a death the runtime heard of, the world memory lost since)
  const later = portalWorld(true);
  t.deepEqual(netherTick(lookAt(KIT, 1000, { now: T0 + 3 * DAY + MINUTE }), later, death), []);
  t.is(netherOf(later).deaths.length, 0);
});

test('the trips\' pace: one an hour until three in a row end well, and at most 2 a game day', (t) => {
  const world = portalWorld(true);
  world.idle = { today: { day: 7 } as never, days: [] };
  const n = netherOf(world);
  const s = (now: number) => ({ now });
  t.is(tripHold(s(T0), world), null);
  n.starts.push(T0);
  n.tripsToday = { day: 7, n: 1 };
  t.like(tripHold(s(T0 + 20 * MINUTE), world), { cause: 'hold', text: 'nether on probation (0/3 clean): 1 trip this hour, next at 17:40', until: T0 + HOUR });
  t.is(tripHold(s(T0 + HOUR), world), null);
  t.is(NETHER_PROBATION.clean, 3);
  // after three clean trips no hourly cap, but the day's two
  n.cleanTrips = 3;
  t.is(tripHold(s(T0 + MINUTE), world), null);
  n.tripsToday = { day: 7, n: NETHER_PER_DAY };
  t.like(tripHold(s(T0 + MINUTE), world), { cause: 'hold', text: '2 nether trips today (at most 2 a game day)' });
  // a new game day: the count starts again (and the tick drops the old day's)
  world.idle.today.day = 8;
  t.is(tripHold(s(T0 + MINUTE), world), null);
  netherTick(lookAt(KIT, 1000, { now: T0 + MINUTE }), world, undefined);
  t.is(netherOf(world).tripsToday, undefined);
});

test('home by dusk: a Nether trip sets out only while it can have 3 min down there and leave a minute before the work day ends (until tod 3800)', (t) => {
  t.is(LEAVE_LEAD_TICKS, 1200);
  t.is(netherBudgetMs(0), (11_000 - 1200) * 50 - 2 * MINUTE);
  t.is(netherBudgetMs(3800), NETHER_WORTH_MS);
  t.true(netherBudgetMs(3801) < NETHER_WORTH_MS);
  t.is(netherBudgetMs(11_500), 0);
  t.is(netherBudgetMs(23_600), ((11_000 + 24_000 - 23_600) - 1200) * 50 - 2 * MINUTE);
});

// ------------------------------------------------------------------------------------------------ the kit

test('the Nether kit: whole and fed, 40 food points, the golden helmet, a shield, two pickaxes, flint and steel, 64 blast-proof blocks; 12 free slots by the pockets rule', (t) => {
  const items: InventoryItem[] = [
    { slot: 0, name: 'diamond_pickaxe', count: 1 }, { slot: 1, name: 'iron_pickaxe', count: 1 }, { slot: 2, name: 'flint_and_steel', count: 1 },
    { slot: 3, name: 'cobblestone', count: 40 }, { slot: 4, name: 'cobbled_deepslate', count: 24 }, { slot: 5, name: 'bread', count: 8 },
    { slot: 6, name: 'golden_helmet', count: 1 }, { slot: 40, name: 'shield', count: 1 }
  ];
  const s = lookAt(items, 1000);
  t.deepEqual(netherTripKit(netherCheck(s)), { ok: true });
  const short = lookAt(items.filter(i => i.name !== 'golden_helmet' && i.name !== 'cobbled_deepslate' && i.name !== 'iron_pickaxe').concat({ slot: 7, name: 'netherrack', count: 64 }), 1000, { health: 19 });
  t.deepEqual(netherTripKit(netherCheck(short)), { ok: false, why: 'health 19 < 20; no golden helmet; 1 pickaxe(s) < 2 (one in use, a spare); 40 blast-proof blocks < 64' });
  t.is(ROOM.nether, NETHER_TRIP.slotsFree);
  // a point of food gone on the walks while the room was made (live, Nov 14: "food 19 < 20") still sets out; 17 does not
  t.deepEqual(netherTripKit(netherCheck(lookAt(items, 1000, { food: 19 }))), { ok: true });
  t.deepEqual(netherTripKit(netherCheck(lookAt(items, 1000, { food: 18 }))), { ok: true });
  t.deepEqual(netherTripKit(netherCheck(lookAt(items, 1000, { food: 17 }))), { ok: false, why: 'food 17 < 18' });
  // making room for one, the stash keeps no build's materials (as for a trip down the mine), and of the rest only the
  // Nether kit (F3: its own keep, not the home kit's)
  const w = liveWorld();
  w.progress!.carryCap = { oak_planks: 64 };
  // (and the potions: the one of fire resistance for the Guardian's hook, D1)
  t.deepEqual(stashKeep(w, 'nether').keep, new Set(['obsidian', 'flint_and_steel', 'golden_helmet', 'shield', 'potion', ...NETHER_BLOCKS]));
  t.is(stashKeep(w, 'nether').cap?.oak_planks, undefined);
  t.is(stashKeep(w).cap?.oak_planks, 64, 'at home for anything else, the project\'s cap as ever');
});

// ------------------------------------------------------------------------------------------------ the rung

test('the nether rung: 4.5 between the trip kit and the deep rung, its work the setup and the look (P2b); it says the switch is off, what the setup\'s kit is short of, or that there is no work once linked, and never wants', (t) => {
  // (the villagers rung, P5c, at 4.4 just above it, and the rails home, P5e, at 4.3 above that; the evening's fishing,
  // anti-idle step 6, at the foot)
  t.deepEqual(LADDER.map(r => `${r.name} ${r.rank}`), ['cane patch 1', 'cows 2', 'cane 3', 'trip kit 4', 'rails 4.3', 'villagers 4.4', 'nether 4.5', 'deep 5', 'surface 6', 'fish 7']);
  // (P3a adds the barter and the quartz at stage 1, P3b the scouting and the debris at stage 2)
  t.deepEqual(NETHER_WORK.map(v => `${v.id} ${v.stage}`), ['setup 0', 'look 0', 'barter 1', 'quartz 1', 'scout 2', 'debris 2', 'fortress 3', 'tunnel 3', 'bastion 3']);
  const goals = workGoals(() => undefined, LADDER, () => T0);
  const rung = goals.find(g => g.name === 'work: nether')!;
  // the others keep their places (the deep rung 14, the unblockers 17 and 16; the evening's fishing 12 at the foot; the
  // rails rung, P5e, 14.7 above the villagers)
  t.deepEqual(goals.map(g => g.priority), [18, 17, 16, 15, 14.7, 14.6, 14.5, 14, 13, 12]);
  const s = lookAt(KIT, 1000);
  t.deepEqual(rung.declines!(s, liveWorld()), { cause: 'unneeded', text: 'nether trips are off' });
  t.deepEqual(rung.declines!(s, portalWorld(false)), { cause: 'unneeded', text: 'nether trips are off' });
  const half = portalWorld(true);
  half.progress!.done = half.progress!.done.filter(d => d !== 'nether-portal');
  t.deepEqual(rung.declines!(s, half), { cause: 'unneeded', text: 'no nether work yet: the home portal is not lit' });
  // the setup's kit: none of the golden helmet, the flint and steel or the frame's obsidian in these chests
  t.deepEqual(rung.declines!(s, portalWorld(true)), { cause: 'kit', text: 'setup: short of a golden helmet, flint and steel, 10 obsidian (carried or in the chests)' });
  const linked = portalWorld(true);
  netherOf(linked).linked = true;
  t.deepEqual(rung.declines!(s, linked), { cause: 'unneeded', text: 'no nether work yet' });
  for (const w of [liveWorld(), portalWorld(false), half, portalWorld(true), linked]) t.is(rung.wants(s, w), null);
});

// ------------------------------------------------------------------------------------------------ the run wrapper

/** A world and a bot for one Nether trip through the wrapper: the trip's run goes through, and comes out by the home portal. */
function tripBench(task: (into: () => void) => WorkTask) {
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, idle: { today: { day: 3 } as never, days: [] }, nether: { trips: true } };
  const state = { dim: 'overworld', pos: { ...HOME } as Pos };
  const calls: string[] = [];
  const into = () => { state.dim = NETHER; state.pos = { ...DOWN }; };
  const t = task(into);
  const [goal] = workGoals(() => undefined, [t], () => T0);
  const s = lookAt(KIT, 1000);
  const said: string[] = [];
  const ctx = {
    s, world, signal: new AbortController().signal, progress: (x: string) => { said.push(x); }, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, dimension: state.dim, position: { ...state.pos }, timeOfDay: 1500 }),
    call: async <T>(method: string, p: Record<string, unknown> = {}): Promise<T> => {
      calls.push(method);
      if (method === 'inventory') return { items: KIT } as T;
      if (method === 'portal.list') return { portals: [{ x: -71, y: 63, z: 273, axis: 'x', width: 2, height: 3 }] } as T;
      if (method === 'goto') { state.pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) }; return { arrived: true } as T; }
      if (method === 'portal.enter') {
        state.dim = 'overworld';
        state.pos = { ...HOME };
        return { ok: true, from: NETHER, dimension: 'overworld', portal: { x: -562, y: 63, z: 2191 }, stepped: true } as T;
      }
      return {} as T;
    },
    act: async (tool: string) => { calls.push(tool); return { ok: true, text: 'Home' }; }
  } as unknown as GoalContext;
  return { world, goal, s, ctx, calls, said, state };
}

test('a Nether trip through the run wrapper: a trip (out.trip), stamped for the probation and the day, home through the portal and then walked home; a clean end counts, and the next waits its hour', async (t) => {
  let tripFlag = false;
  let budget = 0;
  const b = tripBench(into => ({
    name: 'nether', rank: 4.5, reach: 'nether', room: 'nether', budgetMs: 0,
    variants: () => [{ id: 'setup', dist: 0 }], ready: () => null,
    run: async (_ctx, _variant, budgetMs) => { tripFlag = afield.trip; budget = budgetMs; into(); return { gain: 1, text: 'went through' }; }
  }));
  t.is(b.goal.wants(b.s, b.world), 'setup: in the nether');
  const text = await b.goal.run(b.ctx);
  t.true(tripFlag, 'a trip: only survival cuts it short out there');
  t.false(afield.trip);
  t.is(budget, netherBudgetMs(1000));
  t.is(text, '[setup] went through; back home');
  // (the portal a step away: no walk to it first)
  t.deepEqual(b.calls.filter(c => ['portal.list', 'goto', 'portal.enter', 'go-home'].includes(c)), ['portal.list', 'portal.enter', 'go-home']);
  t.true(b.said.includes('nether: home through the portal at nether (-70, 63, 273) -> overworld (-562, 63, 2191)'), b.said.join(' | '));
  const n = peekNether(b.world);
  t.deepEqual(n.starts, [T0]);
  t.deepEqual(n.tripsToday, { day: 3, n: 1 });
  t.is(n.cleanTrips, 1);
  // on probation: the next waits its hour
  t.like(b.goal.declines!(b.s, b.world), { cause: 'hold', text: 'nether on probation (1/3 clean): 1 trip this hour, next at 17:40' });
});

test('a Nether trip that could not get home through a portal fails, and says why (the leave nether goal takes over)', async (t) => {
  const b = tripBench(into => ({
    name: 'nether', rank: 4.5, reach: 'nether', room: 'nether', budgetMs: 0,
    variants: () => [{ id: 'setup', dist: 0 }], ready: () => null,
    run: async () => { into(); return { gain: 0, text: 'looked round' }; }
  }));
  const call = b.ctx.call;
  (b.ctx as { call: GoalContext['call'] }).call = (async (m: string, p?: Record<string, unknown>) => (m === 'portal.list' ? { portals: [] } : call(m, p))) as GoalContext['call'];
  await t.throwsAsync(b.goal.run(b.ctx), { message: '[setup] looked round, but could not get home: no lit portal in sight' });
  t.is(peekNether(b.world).cleanTrips, 1, 'it ran its course without a death');
});

test('the nether rung\'s gate: home by dusk, the death holds, the pace, all before it would want', (t) => {
  const b = tripBench(() => ({
    name: 'nether', rank: 4.5, reach: 'nether', room: 'nether', budgetMs: 0,
    variants: () => [{ id: 'setup', dist: 0 }], ready: () => null, run: async () => ({ gain: 0, text: '' })
  }));
  t.like(b.goal.declines!(lookAt(KIT, 3900), b.world), { cause: 'late', text: 'nether needs 3 min down there and home by dusk, 2.9 left' });
  t.truthy(b.goal.wants(lookAt(KIT, 3800), b.world));
  netherOf(b.world).deaths.push({ at: T0 - 10 * MINUTE, where: { ...DOWN } });
  t.like(b.goal.declines!(b.s, b.world), { cause: 'hold', text: 'a death in the nether: held until 17:30' });
});

test('a death in the Nether is a death away: the far trips wait for the kit, and the Nether\'s own ladder counts it', (t) => {
  const world = portalWorld(true);
  const s = lookAt(KIT, 1000);
  // (it died at numbers that are by home in the overworld: another place's)
  const lines = workTick(s, world, () => ({ at: { x: -549, y: 63, z: 2185 }, time: T0 - MINUTE, dimension: NETHER }));
  t.true(lines.some(l => l.startsWith('work: died away from home')), lines.join(' | '));
  t.true(lines.includes('nether: a death at nether (-549, 63, 2185): no trips until 17:39'), lines.join(' | '));
});

// ------------------------------------------------------------------------------------------------ leave nether

test('leave nether wants only in the Nether: hurt, hungry, the day near its end, the trips held or off, armour worn through, or no trip under way', (t) => {
  const world = portalWorld(true);
  afield.work = true;
  try {
    t.is(leaveWhy(down(1000), world), null, 'a trip under way, well and early');
    t.is(leaveWhy(lookAt(KIT, 1000), world), null, 'never in the overworld');
    t.is(leaveWhy(down(1000, { health: 11 }), world), 'health 11: home from the nether');
    t.is(leaveWhy(down(1000, { food: 9 }), world), 'food 9: home from the nether');
    t.is(leaveWhy(down(11_000 - LEAVE_LEAD_TICKS + 1), world), '1.0 min of daylight left: home by dusk');
    t.is(leaveWhy(down(11_000 - LEAVE_LEAD_TICKS), world), null);
    t.is(leaveWhy(down(11_500), world), 'evening: home from the nether');
    t.is(leaveWhy(down(13_000), world), 'night: home from the nether');
    t.is(leaveWhy(down(1000), portalWorld(false)), 'nether trips are off: home');
    t.is(leaveWhy(down(1000), portalWorld()), 'nether trips are off: home');
    const held = portalWorld(true);
    netherOf(held).deaths.push({ at: T0 - MINUTE, where: { ...DOWN } });
    t.is(leaveWhy(down(1000), held), 'a death in the nether: held until 17:39: home');
    const worn = KIT.map(i => (i.slot === 36 ? { ...i, damage: 400, maxDamage: 429 } : i));
    t.is(leaveWhy(lookAt(worn, 1000, { dimension: NETHER, position: { ...DOWN }, distHome: Infinity }), world), 'the diamond_boots at 7%: home from the nether');
    const bare = KIT.filter(i => i.slot !== 39);
    t.is(leaveWhy(lookAt(bare, 1000, { dimension: NETHER, position: { ...DOWN }, distHome: Infinity }), world), 'no helmet worn: home from the nether');
    afield.work = false;
    t.is(leaveWhy(down(1000), world), 'in the nether with no trip under way: home');
  } finally {
    afield.work = false;
  }
});

test('leave nether is a survival goal (87) on the brain\'s own list, above the retreat', (t) => {
  t.true(SURVIVAL.has('leave nether'));
  const goals = realGoals();
  const g = goals.find(x => x.name === 'leave nether')!;
  t.is(g.priority, 87);
  t.true(g.priority > goals.find(x => x.name === 'retreat')!.priority);
  t.is(g.failHoldMs, 2 * MINUTE, 'three failures in a row hold it 2 min, never the night');
  t.is(g.retryMs, 2 * MINUTE);
});

/** A bot in the Nether by home's scaled point, with the portals given in sight. */
function downThere(world: WorldMemory, portals: (PortalShape & { own?: boolean })[], over: { walk?: boolean; enter?: Record<string, unknown> } = {}) {
  const calls: { method: string; p: Record<string, unknown> }[] = [];
  const said: string[] = [];
  const ctx = {
    s: down(1000), world, signal: new AbortController().signal, progress: (x: string) => { said.push(x); }, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, dimension: NETHER, position: { ...DOWN } }),
    call: async <T>(method: string, p: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ method, p });
      if (method === 'portal.list') return { dimension: NETHER, portals } as T;
      if (method === 'goto') return { arrived: over.walk ?? true } as T;
      if (method === 'portal.enter') return (over.enter ?? { ok: true, dimension: 'overworld', portal: { x: -562, y: 63, z: 2191 }, stepped: true }) as T;
      throw new Error(`unexpected ${method}`);
    },
    act: async () => ({ ok: true, text: '' })
  } as unknown as GoalContext;
  return { ctx, calls, said };
}

test('netherHome: to its own Nether-side portal, else the one it came in by, else the nearest; on foot, stepping out toward home', async (t) => {
  const own: PortalShape = { x: -60, y: 64, z: 280, axis: 'z' };
  const near: PortalShape = { x: -71, y: 64, z: 274, axis: 'x' };
  const cameBy: PortalShape = { x: -80, y: 64, z: 270, axis: 'x' };
  const world = portalWorld(true);
  netherOf(world).portal = { x: -60, y: 64, z: 281 };
  netherOf(world).arrival = { x: -80, y: 64, z: 268 };
  let b = downThere(world, [near, cameBy, own]);
  let r = await netherHome(b.ctx);
  t.true(r.ok, r.text);
  t.is(r.text, 'nether: home through the portal at nether (-60, 64, 280) -> overworld (-562, 63, 2191)');
  t.like(b.calls.find(c => c.method === 'goto')?.p, { x: -60, y: 64, z: 280, careful: true });
  t.like(b.calls.find(c => c.method === 'portal.enter')?.p, { x: -60, y: 64, z: 280, toward: { x: HOME.x, z: HOME.z } });
  // its own not in sight: the one it came in by (and it says so)
  b = downThere(world, [near, cameBy]);
  r = await netherHome(b.ctx);
  t.is(r.text, 'nether: home through the portal at nether (-79, 64, 270) -> overworld (-562, 63, 2191)');
  t.true(b.said[0].startsWith('its own portal at nether (-60, 64, 281) is not in sight: the portal it came in by'), b.said[0]);
  // neither known: the nearest, a step away (no walk first)
  const plain = portalWorld(true);
  b = downThere(plain, [cameBy, near]);
  r = await netherHome(b.ctx);
  t.is(r.text, 'nether: home through the portal at nether (-70, 64, 274) -> overworld (-562, 63, 2191)');
  t.false(b.calls.some(c => c.method === 'goto'));
  // and what goes wrong says why
  t.like(await netherHome(downThere(plain, []).ctx), { ok: false, text: 'no lit portal in sight' });
  t.like(await netherHome(downThere(plain, [cameBy], { walk: false }).ctx), { ok: false, text: 'no way on foot to the nearest portal at nether (-79, 64, 270)' });
  t.like(await netherHome(downThere(plain, [near], { enter: { ok: false, reason: 'timed out in the portal (30 s in it)' } }).ctx), { ok: false, text: 'through the nearest portal at nether (-70, 64, 274): timed out in the portal (30 s in it)' });
});

test('leave nether: home through a portal; stranded, it says so once this time in and goes on trying (every 2 min)', async (t) => {
  const world = portalWorld(true);
  const goal = leaveNetherGoal();
  const home = downThere(world, [{ x: -71, y: 64, z: 274, axis: 'x' }]);
  t.is(await goal.run(home.ctx), 'nether: home through the portal at nether (-70, 64, 274) -> overworld (-562, 63, 2191)');
  netherOf(world).enteredAt = T0;
  const stuck = downThere(world, []);
  await t.throwsAsync(goal.run(stuck.ctx), { message: 'stranded: no lit portal in sight' });
  t.deepEqual(stuck.said, ['nether: stranded at nether (-70, 64, 274): no lit portal in sight']);
  const again = downThere(world, []);
  await t.throwsAsync(goal.run(again.ctx), { message: 'stranded: no lit portal in sight' });
  t.deepEqual(again.said, [], 'said once this time in');
  // another time in: said again
  netherOf(world).enteredAt = T0 + HOUR;
  const later = downThere(world, []);
  await t.throwsAsync(goal.run(later.ctx));
  t.is(later.said.length, 1);
});

// ------------------------------------------------------------------------------------------------ the rest of the brain down there

test('a Nether snapshot through every goal: nothing throws, and nothing but leave nether and the survival goals wants (switch on or off, portal or not, at any hour, well or hurt, pockets empty or full)', (t) => {
  const goals = realGoals();
  const wanted = new Map<string, number>();
  const bad: string[] = [];
  let cells = 0;
  const full = [...Array.from({ length: 36 }, (_, slot) => ({ slot, name: 'netherrack', count: 64 })), ...WORN.map(i => ({ ...i }))];
  for (const world of [() => withProject(liveWorld(), true), () => portalWorld(false), () => portalWorld(true)]) {
    for (const tod of [0, 1000, 6000, 9900, 10_900, 11_500, 13_000, 23_600]) for (const [health, food] of [[20, 20], [8, 20], [20, 5]]) {
      for (const items of [WORN.map(i => ({ ...i })), KIT, full]) for (const work of [false, true]) {
        cells++;
        const w = world();
        const s = lookAt(items, tod, { dimension: NETHER, position: { ...DOWN }, distHome: Infinity, health, food, now: T0 + 7 * MINUTE });
        afield.work = work;
        try {
          for (const g of goals) {
            const why = g.wants(s, w);
            g.declines?.(s, w); g.urgency?.(s, w); g.cuts?.(s, w); g.daily?.(s, w);
            if (why) wanted.set(g.name, (wanted.get(g.name) ?? 0) + 1);
            if (why && !SURVIVAL.has(g.name)) bad.push(`tod ${tod}, health ${health}, food ${food}, ${items.length} items: ${g.name} wants: ${why}`);
          }
          const d = decide(s, w, goals, new Map());
          if (d && !SURVIVAL.has(d.goal.name)) bad.push(`decide picked ${d.goal.name}`);
        } catch (e) {
          bad.push(`threw: ${(e as Error).stack}`);
        } finally {
          afield.work = false;
        }
      }
    }
  }
  t.deepEqual(bad.slice(0, 10), []);
  t.true(cells > 400);
  // (with no trip under way it always wants: the switch, a restart, the LLM's hand-back all bring it home)
  t.true(wanted.get('leave nether')! >= cells / 2, `${wanted.get('leave nether')} of ${cells}`);
  t.deepEqual([...wanted.keys()].filter(k => k !== 'leave nether'), []);
});

test('the switch off: decide never picks anything of the Nether in the overworld, before the portal is lit or after', (t) => {
  const goals = realGoals();
  const nether = ['leave nether', 'work: nether'];
  const picked = new Map<string, number>();
  const before = (): WorldMemory => {
    // the frame stands and the light step is the one in hand
    const w = withProject(liveWorld(), false);
    w.progress!.done.push('enchanting', 'workshop');
    w.progress!.current = { id: 'nether-portal', step: 6, data: { site: { x: -563, z: 2189, width: 3, length: 6, rotated: true, y: 62 }, axis: 'z' } };
    w.zones!.portal = [{ x: -563, y: 62, z: 2189, width: 3, length: 6 }];
    w.zones!['portal:frame'] = [{ x: HOME_PORTAL.x, y: HOME_PORTAL.y, z: HOME_PORTAL.z }];
    return w;
  };
  for (const world of [before, () => portalWorld(), () => portalWorld(false)]) {
    for (const tod of [0, 1000, 3000, 6000, 9000, 10_700]) for (const items of [KIT, WORN.map(i => ({ ...i }))]) for (const x of [HOME.x, HOME.x - 14, HOME.x + 10]) {
      const s = lookAt(items, tod, { position: { x, y: 63, z: HOME.z }, distHome: Math.abs(x - HOME.x) });
      const w = world();
      const d = decide(s, w, goals, new Map());
      if (d) picked.set(d.goal.name, (picked.get(d.goal.name) ?? 0) + 1);
      t.is(goals.find(g => g.name === 'work: nether')!.declines!(s, w)?.text, 'nether trips are off');
    }
  }
  t.deepEqual([...picked.keys()].filter(k => nether.includes(k)), []);
  t.true(picked.size > 0);
});

test('recover never walks back for a death in the Nether: said once, nothing collected', async (t) => {
  let death: { at: Pos; time: number; dimension?: string } | undefined = { at: { x: -70, y: 40, z: 280 }, time: T0 - 30_000, dimension: NETHER };
  const goal = recoverGoal(() => death);
  const s = lookAt(KIT, 1000);
  t.is(goal.wants(s, liveWorld()), 'died in the nether at (-70, 40, 280): nothing is recovered there');
  // at night too (nothing is walked)
  t.truthy(goal.wants(lookAt(KIT, 14_000), liveWorld()));
  const acts: string[] = [];
  const ctx = { s, world: liveWorld(), signal: new AbortController().signal, act: async (tool: string) => { acts.push(tool); return { ok: true, text: '' }; } } as unknown as GoalContext;
  t.is(await goal.run(ctx), 'death in the nether: not recovered');
  t.deepEqual(acts, []);
  t.is(goal.wants(s, liveWorld()), null, 'said once');
  // an overworld death is walked back to, as ever
  death = { at: { x: -540, y: 63, z: 2150 }, time: T0 - 20_000, dimension: 'overworld' };
  t.regex(goal.wants(s, liveWorld()) ?? '', /^died at \(-540, 63, 2150\) 20s ago: get the drops back$/);
});

test('the shelter never lies down in a bed outside the overworld (it does not want there, and a run from there walls in)', async (t) => {
  const goal = shelterGoal();
  const world = liveWorld();
  t.is(goal.wants(lookAt(KIT, 13_000, { dimension: NETHER, position: { ...DOWN }, distHome: Infinity }), world), null);
  t.is(goal.wants(lookAt(KIT, 11_500, { dimension: NETHER, position: { ...DOWN }, distHome: Infinity }), world), null);
  const calls: string[] = [];
  const ctx = {
    s: lookAt(KIT, 13_000, { dimension: NETHER }), world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ inWorld: true, dimension: NETHER, position: { ...HOME }, block: { ...HOME } }),
    call: async (m: string) => { calls.push(m); return m === 'world.region' ? { blocks: [] } : {}; },
    act: async (tool: string) => { calls.push(tool); return { ok: true, text: tool === 'wall-in' ? 'Walled in' : 'Successfully moved' }; }
  } as unknown as GoalContext;
  const r = await goal.run(ctx);
  t.false(calls.includes('bed.sleep'), calls.join(' | '));
  t.true(calls.includes('wall-in'));
  t.regex(r, /no bed yet: Walled in/);
});

// ------------------------------------------------------------------------------------------------ its own portals, the status

test('its own portals: the home portal and its Nether side, for portal.own; others\' portals kept by dimension, never its own', (t) => {
  const world = portalWorld(true);
  t.deepEqual(allOwnPortals(world), [{ dimension: 'overworld', x: -562, y: 63, z: 2191 }]);
  netherOf(world).portal = { x: -71, y: 63, z: 273 };
  t.deepEqual(allOwnPortals(world), [{ dimension: 'overworld', x: -562, y: 63, z: 2191 }, { dimension: NETHER, x: -71, y: 63, z: 273 }]);
  notePortals(world, NETHER, [COMMUNITY_NETHER, { x: -71, y: 63, z: 273, axis: 'x' }]);
  notePortals(world, 'overworld', [COMMUNITY]);
  t.deepEqual(peekNether(world).seen, { [NETHER]: [{ x: -56, y: 70, z: 267, axis: 'x', width: 2, height: 3 }], overworld: [{ x: -440, y: 68, z: 2130, axis: 'x', width: 2, height: 3 }] });
  // seen again, and a new one: the newest first, nothing twice
  const other = { x: -90, y: 50, z: 300, axis: 'z' };
  notePortals(world, NETHER, [other]);
  notePortals(world, NETHER, [COMMUNITY_NETHER]);
  t.deepEqual(peekNether(world).seen![NETHER].map(p => p.x), [-56, -90]);
  // a memory from an older brain.json (the switch alone) is made whole
  const old = liveWorld();
  old.nether = { trips: true };
  t.like(netherOf(old), { trips: true, stage: 0, cleanTrips: 0, deaths: [], starts: [], sites: [] });
});

test('brain-status\'s Nether line: the switch, the stage and the clean trips to the next (the probation while it lasts), deaths in 3 days, the portals and whether they are linked', (t) => {
  const world = portalWorld();
  t.is(netherLine(world, T0), 'Nether: trips off; stage 0, 0/2 clean trips to stage 1, on probation 0/3, 0 death(s) in 3 days; home portal overworld (-562, 63, 2191), nether side none.');
  const n = netherOf(world);
  n.trips = true;
  n.cleanTrips = 2;
  n.deaths.push({ at: T0 - DAY, where: { ...DOWN } }, { at: T0 - 4 * DAY, where: { ...DOWN } });
  n.portal = { x: -71, y: 63, z: 273 };
  n.seen = { [NETHER]: [COMMUNITY_NETHER] };
  t.is(netherLine(world, T0), 'Nether: trips on; stage 0, 0/2 clean trips to stage 1, on probation 2/3, 1 death(s) in 3 days; home portal overworld (-562, 63, 2191), nether side nether (-71, 63, 273) (not linked); others\' portals seen: 1 in the nether.');
  n.linked = true;
  t.regex(netherLine(world, T0), /nether side nether \(-71, 63, 273\) \(linked\)/);
  t.is(netherLine(liveWorld(), T0), 'Nether: trips off; stage 0, 0/2 clean trips to stage 1, on probation 0/3, 0 death(s) in 3 days; home portal none, nether side none.');
});

test('the nether-trips switch on the brain: said in the log with who turned it, kept in the world\'s memory, shown in brain-status', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nether-brain-')), 'brain.json');
  const rt = {
    actions: {}, call: async (m: string) => (m === 'inventory' ? { items: [] } : {}),
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...HOME }, block: { ...HOME }, timeOfDay: 1000, hashedSeed: '5', dimension: 'overworld', health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }), lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => T0, goals: [], memoryFile: file });
  t.throws(() => brain.setNetherTrips(true, 'the lead'), { message: 'not in a world yet' });
  brain.setEnabled(true);
  await brain.tick();
  brain.setNetherTrips(true, 'the lead');
  t.true(brain.worldMemory()!.nether!.trips === true);
  t.regex(brain.status(), /nether trips on \(by the lead\)/);
  t.regex(brain.status(), /\nNether: trips on; stage 0/);
  brain.setNetherTrips(false, 'maintenance');
  t.regex(brain.status(), /nether trips off \(by maintenance\)/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>;
  t.false(Object.values(saved)[0].nether!.trips);
  brain.setEnabled(false);
});

test('the brain hands its own portals to the runtime each tick, and keeps the portals of others the bridge has seen', async (t) => {
  const handed: unknown[] = [];
  const asked: string[] = [];
  const rt = {
    actions: {},
    call: async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: [] };
      if (m === 'foreign.portals') { asked.push(String(p.dimension)); return { dimension: 'overworld', portals: [COMMUNITY] }; }
      return {};
    },
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { x: 0, y: 64, z: 0 }, block: { x: 0, y: 64, z: 0 }, timeOfDay: 1000, hashedSeed: '6', dimension: 'overworld', health: 20, food: 20 }),
    home: () => undefined, lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    setOwnPortals: (list: unknown) => { handed.push(list); },
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  let now = T0;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => now, goals: [] });
  brain.setEnabled(true);
  await brain.tick();
  t.deepEqual(handed, [[]]);
  t.deepEqual(asked, ['overworld']);
  t.deepEqual(peekNether(brain.worldMemory()!).seen?.overworld, [{ ...COMMUNITY }]);
  now += MINUTE;
  await brain.tick();
  t.is(asked.length, 1, 'every 5 minutes, not every tick');
  t.is(handed.length, 2);
  brain.setEnabled(false);
});

// ------------------------------------------------------------------------------------------------ the protection sync

function bridged(status: () => Record<string, unknown>) {
  const sent: { method: string; p: Record<string, unknown> }[] = [];
  let handler: ((e: { type: string; at?: Pos; dimension?: string }) => void) | undefined;
  const request = async (method: string, p: Record<string, unknown> = {}) => {
    if (method === 'status') return status();
    sent.push({ method, p });
    if (method === 'foreign.zones') return { zones: [] };
    if (method === 'world.entities') return { entities: [] };
    if (method === 'inventory') return { items: [], selectedSlot: 0, held: null };
    return {};
  };
  const bridge = { request, on: (_e: string, fn: typeof handler) => { handler = fn; } } as unknown as BridgeClient;
  const server = { tool: sinon.stub() } as unknown as McpServer;
  const factory = new ToolFactory(server, { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) });
  const homesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nether-homes-')), 'homes.json');
  const rt = registerClientTools(factory, bridge, new MessageStore(), { gameDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nether-game-')), homesFile });
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await (server.tool as sinon.SinonStub).getCalls().find(c => c.args[0] === name)!.args[3](args);
    return r.content.map((c: { text: string }) => c.text).join('\n');
  };
  return { rt, sent, run, emit: (e: { type: string; at?: Pos; dimension?: string }) => handler?.(e) };
}

test('the protection sync through a portal: the Nether\'s positions and no home zone there, the overworld\'s again on the way back, each said with its dimension; its own portals resent when the bridge has none', async (t) => {
  let dim = 'overworld';
  let synced: Record<string, boolean> = {};
  const { rt, sent, run } = bridged(() => ({ inWorld: true, username: 'Bot', screen: null, position: { x: 0.5, y: 64, z: 0.5 }, block: { x: 0, y: 64, z: 0 }, hashedSeed: '8', dimension: dim, ...synced }));
  await run('set-home', { force: true });
  rt.setHomeZone({ x1: -16, z1: -16, x2: 16, z2: 16 });
  sent.length = 0;
  await run('get-position');
  t.deepEqual(sent.filter(c => c.method === 'protect.zone').map(c => c.p), [{ x1: -16, z1: -16, x2: 16, z2: 16, dimension: 'overworld' }]);
  // through the portal: the status says neither is synced for the Nether
  dim = NETHER;
  synced = { protectSynced: false, zoneSynced: false, ownPortalsSynced: false };
  sent.length = 0;
  await run('get-position');
  t.deepEqual(sent.map(c => [c.method, c.p]), [['protect.set', { positions: [], dimension: NETHER }], ['protect.zone', { x: 0, z: 0, radius: 0, dimension: NETHER }]],
    'no portal.own before the brain has said which are its own');
  synced = { protectSynced: true, zoneSynced: true, ownPortalsSynced: false };
  rt.setOwnPortals!([{ dimension: 'overworld', x: -562, y: 63, z: 2191 }]);
  sent.length = 0;
  await run('get-position');
  t.deepEqual(sent.map(c => [c.method, c.p]), [['portal.own', { portals: [{ dimension: 'overworld', x: -562, y: 63, z: 2191 }] }]]);
  // the bridge has them now: nothing resent until the list changes
  synced = { protectSynced: true, zoneSynced: true, ownPortalsSynced: true };
  sent.length = 0;
  await run('get-position');
  t.deepEqual(sent, []);
  rt.setOwnPortals!([{ dimension: 'overworld', x: -562, y: 63, z: 2191 }, { dimension: NETHER, x: -71, y: 63, z: 273 }]);
  await run('get-position');
  t.is(sent.filter(c => c.method === 'portal.own').length, 1);
  // back in the overworld: its positions and the yard's zone again
  dim = 'overworld';
  synced = { protectSynced: false, zoneSynced: false, ownPortalsSynced: true };
  sent.length = 0;
  await run('get-position');
  t.deepEqual(sent.map(c => [c.method, c.p]), [['protect.set', { positions: [], dimension: 'overworld' }], ['protect.zone', { x1: -16, z1: -16, x2: 16, z2: 16, dimension: 'overworld' }]]);
});

test('the death event\'s dimension reaches the brain\'s lastDeath, and collect-items does not walk to a death in another dimension', async (t) => {
  const { rt, emit, run, sent } = bridged(() => ({ inWorld: true, username: 'Bot', screen: null, position: { x: 0.5, y: 64, z: 0.5 }, block: { x: 0, y: 64, z: 0 }, hashedSeed: '9', dimension: 'overworld' }));
  emit({ type: 'death', at: { x: -70, y: 40, z: 280 }, dimension: NETHER });
  t.like(rt.lastDeath(), { at: { x: -70, y: 40, z: 280 }, dimension: NETHER });
  const text = await run('collect-items');
  t.false(sent.some(c => c.method === 'goto'), 'no walk to the Nether death\'s numbers');
  t.regex(text, /^Collected around \(0, 64, 0\) \(around the bot\): nothing\.$/);
  emit({ type: 'death', at: { x: 3, y: 64, z: 3 } });
  t.is(rt.lastDeath()?.dimension, undefined, 'an older jar says none');
});
