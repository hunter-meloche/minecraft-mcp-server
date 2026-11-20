import test from 'ava';
import type { InventoryItem } from '../../src/client/tools.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  BLOCKS_KEPT, FROM_BUILDS, FROM_UNKNOWN, GONE, PLACED_GAP, SETUP_HOLD_MS, SETUP_LEAST_MS, SETUP_OBSIDIAN, SETUP_WAITS, SPOT_DY, SPOT_RADIUS, WAY_OUT, boxGap,
  FIRE_GAP, cellOf, chooseHut, fetchSetupKit, firesBy, footing, grow, hutOf, hutSteps, inBox, judgeHut, judgedBox, maybeServers, overworldSideKnown, planHut, setupObsidian,
  setupOpen, setupReady, setupRun, setupShort, shapeOf, standable, wayOut, zoneBox, type Box, type Grid, type HutStep, type NetherZone, type SetupView
} from '../../src/client/brain/nethersetup.js';
import {
  NETHER, OVERWORLD, linkedTo, netherLine, netherOf, netherPortalSpot, peekNether, portalCells, scaled, spotFault, type PortalShape
} from '../../src/client/brain/nether.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals } from '../../src/client/brain/work.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { kit } from '../../src/client/brain/chores.js';
import { MINUTE, T0, WORN, liveWorld, lookAt } from '../helpers/homestead.js';
import {
  COMMUNITY, COMMUNITY_NETHER, CZ, HOME_PORTAL, KIT, ROOM_ZONE, fmt, frameOf, game, gridOf, k, netherGround, setupWorld
} from '../helpers/netherworld.js';

const HOUR = 60 * MINUTE;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;

/** The nether rung's goal on the real ladder, its clock at T0 (or later). */
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;

// ------------------------------------------------------------------------------------------------ the hut

test('the hut: a 2 x 3 portal in 10 obsidian (no corners), a front room 2 x 2 x 3, a door one wide and two high, 30 cells of shell round it', (t) => {
  const hut = hutOf({ x: 0, y: 70, z: 0, axis: 'x', side: 1, door: 0 });
  t.is(hut.inside.length, 6);
  t.is(hut.frame.length, SETUP_OBSIDIAN);
  t.deepEqual(hut.frame.slice(0, 2), [{ x: 0, y: 69, z: 0 }, { x: 1, y: 69, z: 0 }], 'the bottom row under the inside');
  t.is(hut.room.length, 12);
  t.deepEqual(hut.door, [{ x: 0, y: 70, z: 3 }, { x: 0, y: 71, z: 3 }]);
  t.deepEqual(hut.outside, { x: 0, y: 70, z: 4 });
  t.is(hut.shell.length, 30);
  // the frame is the 26.3 jar's shape round the inside: the portal shape the server lights there
  t.deepEqual(hut.frame.map(k).sort(), frameOf(shapeOf(hut.spot)).map(k).sort());
  t.deepEqual(hut.stations, [{ x: 0, y: 70, z: 4 }, { x: 0, y: 70, z: 3 }, { x: 0, y: 70, z: 2 }, { x: 0, y: 70, z: 1 }]);
  // turned: along z, the front toward -x, the door in the second column
  const z = hutOf({ x: 10, y: 70, z: 20, axis: 'z', side: -1, door: 1 });
  t.deepEqual(z.door[0], { x: 7, y: 70, z: 21 });
  t.deepEqual(z.light, { x: 10, y: 69, z: 21 });
  t.true(z.shell.every(p => !z.inside.some(q => k(q) === k(p)) && !z.room.some(q => k(q) === k(p))));
});

/** A flat Nether floor at y 69 and open air above it, with whatever `extra` says at some cells. */
const flat = (extra: Record<string, string> = {}) => (p: Pos) => extra[k(p)] ?? (p.y <= 69 ? 'netherrack' : 'air');

/** Carry out a hut's steps on a ground, checking each as the bridge would: what it digs is there, what it places has a neighbour. */
function replay(get0: (p: Pos) => string, steps: HutStep[], start: Pos): { get: (p: Pos) => string; errors: string[] } {
  const over = new Map<string, string>();
  const get = (p: Pos) => over.get(k(p)) ?? get0(p);
  const errors: string[] = [];
  let feet = start;
  for (const s of steps) {
    if (s.do === 'walk') {
      if (Math.abs(s.to.x - feet.x) + Math.abs(s.to.z - feet.z) !== 1) errors.push(`a walk of more than a step to ${fmt(s.to)}`);
      if (get(s.to) !== 'air' || get({ ...s.to, y: s.to.y + 1 }) !== 'air' || cellOf(get({ ...s.to, y: s.to.y - 1 })) === 'open') errors.push(`no room to stand at ${fmt(s.to)}`);
      feet = s.to;
    } else if (s.do === 'dig') {
      if (cellOf(get(s.at)) === 'open') errors.push(`dug air at ${fmt(s.at)}`);
      over.set(k(s.at), 'air');
    } else {
      if (get(s.at) !== 'air') errors.push(`placed into ${get(s.at)} at ${fmt(s.at)}`);
      const d = { down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0] }[s.face]!;
      const ref = { x: s.at.x + d[0], y: s.at.y + d[1], z: s.at.z + d[2] };
      if (['air', 'lava'].includes(get(ref))) errors.push(`nothing to place against (${s.face}) at ${fmt(s.at)}`);
      over.set(k(s.at), s.item);
    }
  }
  return { get, errors };
}

test('the build on open ground: from the door inward, the frame of 10 obsidian on its corners, then a shell of 28 cobblestone; every step one the bridge can take, the frame whole', (t) => {
  const g = gridOf(flat(), { x1: -10, y1: 60, z1: -10, x2: 10, y2: 80, z2: 10 });
  const spot = { x: 0, y: 70, z: 0, axis: 'x' as const, side: 1 as const, door: 0 as const };
  const plan = planHut(g, spot, { cobblestone: 64, obsidian: 10 });
  if (!('steps' in plan)) return t.fail(plan.why);
  // the ground under the frame and the room's floor stand as they are: the frame's bottom row dug out and made obsidian
  t.deepEqual(plan.cost, { places: 28, obsidian: 10, digs: 2 });
  const r = replay(flat(), plan.steps, plan.hut.outside);
  t.deepEqual(r.errors, []);
  t.true(plan.hut.frame.every(p => r.get(p) === 'obsidian'));
  t.true(plan.hut.inside.every(p => r.get(p) === 'air'));
  t.true([...plan.hut.shell, ...plan.hut.corners].every(p => cellOf(r.get(p)) !== 'open'), 'the shell and the corners solid');
  t.true(plan.hut.door.every(p => r.get(p) === 'air'));
  // the frame before any of the shell, the bottom row before the sides, the sides before the top
  const placed = plan.steps.filter(s => s.do === 'place').map(s => (s as { at: Pos; item: string }));
  const firstShell = placed.findIndex(s => s.item === 'cobblestone' && !plan.hut.corners.some(c => k(c) === k(s.at)));
  t.true(placed.slice(0, firstShell).filter(s => s.item === 'obsidian').length === 10, 'the frame first');
  // nothing placed where the bot stands as it builds
  t.false(placed.some(s => plan.hut.stations.some(st => k(st) === k(s.at) || k({ ...st, y: st.y + 1 }) === k(s.at))));
});

test('the build walked through: a back wall over a void has nothing to be placed against, so no plan there (the ground alone passes)', (t) => {
  // the floor ends at the portal's plane: behind it nothing down to y 50
  const edge = (p: Pos) => (p.z < 0 && p.y >= 50 ? 'air' : p.y <= 69 ? 'netherrack' : 'air');
  const g = gridOf(edge, { x1: -10, y1: 45, z1: -10, x2: 10, y2: 80, z2: 10 });
  const hut = hutOf({ x: 0, y: 70, z: 0, axis: 'x', side: 1, door: 0 });
  t.false('why' in judgeHut(g, hut, { cobblestone: 64, obsidian: 10 }));
  const r = hutSteps(g, hut);
  t.regex('why' in r ? r.why : 'a plan', /^nothing to place cobblestone at \(-?\d+, \d+, -1\) against from \(0, 70, 1\)$/);
  t.true('why' in planHut(g, hut.spot, { cobblestone: 64, obsidian: 10 }));
});

test('the ground judged: lava by it, gravel over it, no ground under the frame, a drop under the floor, magma underfoot, or too little cobblestone: no hut there', (t) => {
  const box = { x1: -10, y1: 55, z1: -10, x2: 10, y2: 80, z2: 10 };
  const spot = { x: 0, y: 70, z: 0, axis: 'x' as const, side: 1 as const, door: 0 as const };
  const why = (extra: Record<string, string>, have = { cobblestone: 64, obsidian: 10 }) => {
    const r = judgeHut(gridOf(flat(extra), box), hutOf(spot), have);
    return 'why' in r ? r.why : 'fine';
  };
  t.is(why({}), 'fine');
  t.is(why({ [k({ x: 3, y: 69, z: 5 })]: 'lava' }), 'lava or fire by it');
  t.is(why({ [k({ x: 0, y: 66, z: 1 })]: 'lava' }), 'lava or fire by it', 'under the floor, within the drop');
  t.is(why({ [k({ x: 1, y: 74, z: 1 })]: 'gravel' }), 'gravel or sand in it or on it');
  t.is(why({ [k({ x: 0, y: 68, z: 0 })]: 'air' }), 'no ground under the frame');
  const hole: Record<string, string> = {};
  for (let y = 64; y <= 69; y++) hole[k({ x: 0, y, z: 2 })] = 'air';
  t.is(why(hole), 'over a drop of more than 3');
  t.is(why({ [k({ x: 0, y: 69, z: 1 })]: 'magma_block' }), 'magma underfoot');
  t.is(why({ [k({ x: 1, y: 71, z: 1 })]: 'bedrock' }), 'something in the way that is not the bot\'s to dig');
  t.is(why({}, { cobblestone: 40, obsidian: 10 }), `28 cobblestone to place (40 carried, ${BLOCKS_KEPT} kept for the way home)`);
  t.is(why({}, { cobblestone: 64, obsidian: 6 }), '10 obsidian for the frame (6 carried)');
  t.false(standable(gridOf(flat({ [k({ x: 0, y: 69, z: 0 })]: 'magma_block' }), box), { x: 0, y: 70, z: 0 }), 'no standing on magma');
});

test('ghast fire by its portal: no footing by it until put out; firesBy names the fire a hit reaches from the eye, the nearest first', (t) => {
  // the live hut, Nov 20: the portal x -78..-77 at z 260 (frame -79 and -76), the wall behind it, the floor at y 90,
  // fire on it from a ghast's fireball in front of the east column and the west's; the bot out in the east column
  const fire = new Set([k({ x: -77, y: 91, z: 259 }), k({ x: -79, y: 91, z: 259 }), k({ x: -79, y: 91, z: 258 }), k({ x: -70, y: 91, z: 255 })]);
  const lit = new Set(fire);
  const get = (p: Pos) => {
    if (lit.has(k(p))) return 'fire[age=15,east=false,north=false,south=false,up=false,west=false]'; // as the live read had it
    if (p.y <= 90) return 'netherrack';
    if (p.z === 260 && (p.x === -78 || p.x === -77) && p.y <= 93) return 'nether_portal';
    if (p.z === 260 && (p.x === -79 || p.x === -76) && p.y <= 94) return 'obsidian';
    if (p.z === 261 && p.y <= 94) return 'cobblestone';
    return 'air';
  };
  const box = { x1: -90, y1: 85, z1: 250, x2: -65, y2: 100, z2: 270 };
  const portal = { x1: -78, y1: 91, z1: 260, x2: -77, y2: 93, z2: 260 };
  const me = { x: -76.5, y: 91, z: 260.5 };
  const eye = { x: me.x, y: me.y + 1.62, z: me.z };
  t.is(footing(gridOf(get, box), me), undefined, 'every cell by it is in fire or beside it: the trips\' "no ground to stand on"');
  const hits = firesBy(gridOf(get, box), portal, eye);
  t.deepEqual(hits, [{ x: -77, y: 91, z: 259 }, { x: -79, y: 91, z: 259 }, { x: -79, y: 91, z: 258 }], 'the one 7 off (past FIRE_GAP) is left');
  t.true(FIRE_GAP >= 2, 'out to the far cell of the step out');
  for (const h of hits) lit.delete(k(h));
  t.deepEqual(footing(gridOf(get, box), me), { x: -77, y: 91, z: 259 }, 'put out: the cell in front of the portal is ground again');
  // out of reach from the eye: not named (a hit would not get there)
  t.deepEqual(firesBy(gridOf(get, box), portal, { x: -81.5, y: 92.62, z: 266.5 }), []);
  lit.add(k({ x: -79, y: 91, z: 259 }));
  t.deepEqual(firesBy(gridOf(get, box), portal, eye), [{ x: -79, y: 91, z: 259 }]);
});

// ------------------------------------------------------------------------------------------------ the spot

/** What the choice reads in the test Nether: from where the bot stands once out of the community's room. */
function view(get: (p: Pos) => string, over: Partial<SetupView> = {}): SetupView {
  const grid = gridOf(get, { x1: -110, y1: 45, z1: 240, x2: -30, y2: 100, z2: 320 });
  const base = netherPortalSpot(HOME_PORTAL, [COMMUNITY_NETHER], [COMMUNITY], { ys: [70] }).spot!;
  const start = footing(grid, { x: -55.5, y: 70, z: CZ + 2.5 })!;
  const way = wayOut(grid, start, [ROOM_ZONE], [ROOM_ZONE])!;
  return {
    grid, home: HOME_PORTAL, netherPortals: [COMMUNITY_NETHER], overworldPortals: [COMMUNITY], zones: [ROOM_ZONE], base,
    arrival: { x: -56, y: 70, z: CZ }, from: [way[way.length - 1]], cobblestone: 64, obsidian: 10, ...over
  };
}

test('the spot: within 8 of netherPortalSpot\'s, dug into the netherrack cliff before any open ground, 16 from the community\'s room, passing spotFault; and the walk there on foot', (t) => {
  const v = view(netherGround());
  t.deepEqual(v.base, { x: -71, y: 70, z: 273, axis: 'x' });
  const c = chooseHut(v);
  if (!('plan' in c)) return t.fail(c.why);
  const { hut } = c.plan;
  t.deepEqual(hut.spot, { x: -79, y: 70, z: 266, axis: 'z', side: 1, door: 1 });
  t.regex(c.why, /^nether \(-79, 70, 266\) along z, 8 from nether \(-71, 70, 273\): 4 cobblestone to place, 28 to dig, 10 obsidian; a walk of \d+$/);
  t.true(Math.max(Math.abs(hut.spot.x - v.base.x), Math.abs(hut.spot.z - v.base.z)) <= SPOT_RADIUS && Math.abs(hut.spot.y - v.arrival.y) <= SPOT_DY);
  t.true(boxGap(hut.box, ROOM_ZONE) >= FROM_BUILDS, `${boxGap(hut.box, ROOM_ZONE)}`);
  t.is(spotFault(shapeOf(hut.spot), HOME_PORTAL, [COMMUNITY_NETHER], [COMMUNITY]), null);
  // the home portal comes out there now (its own nearer home's scaled point than the community's), and back it leads home
  const into = scaled({ x: HOME_PORTAL.x, y: HOME_PORTAL.y, z: HOME_PORTAL.z }, NETHER);
  t.is(linkedTo(into, [COMMUNITY_NETHER, shapeOf(hut.spot)], 16)?.portal.x, hut.spot.x);
  t.is(linkedTo(scaled({ x: hut.spot.x + 0.5, y: 70, z: hut.spot.z + 0.5 }, OVERWORLD), [COMMUNITY, HOME_PORTAL], 128)?.portal, HOME_PORTAL);
  // the walk ends at the door's outside cell, and keeps out of the room
  t.deepEqual(c.path[c.path.length - 1], hut.outside);
  t.false(c.path.some(p => p.x >= ROOM_ZONE.x1 && p.x <= ROOM_ZONE.x2 && p.z >= ROOM_ZONE.z1 && p.z <= ROOM_ZONE.z2 && p.y >= ROOM_ZONE.y1 && p.y <= ROOM_ZONE.y2));
  // the cliff: next to nothing to place (the walls are the netherrack dug into), every step one the bridge can take
  t.true(c.plan.cost.places <= 4);
  t.deepEqual(replay(netherGround(), c.plan.steps, hut.outside).errors, []);
  // the lava pool never under or by it
  t.true(hut.box.x2 < -66 - 2 || hut.box.z2 < 277 - 2);
});

test('the spot: with the cliff gone the hut stands on the open floor, and never over the lava pool', (t) => {
  const open = netherGround();
  const c = chooseHut(view(p => (p.y > 69 && p.y < 90 && p.x <= -77 && p.x > -110 ? 'air' : open(p))));
  if (!('plan' in c)) return t.fail(c.why);
  t.true(c.plan.cost.places >= 20, `${c.plan.cost.places}`);
  const b = c.plan.hut.box;
  t.false(b.x1 - 2 <= -63 && b.x2 + 2 >= -66 && b.z1 - 2 <= 281 && b.z2 + 2 >= 277, JSON.stringify(b));
});

test('no spot keeps 16 from a room by home\'s scaled point (the community\'s portal 15 off, as P2a\'s numbers had it): none, and why', (t) => {
  // their room where nether.test.ts has their Nether side: by home's scaled point
  const near: PortalShape = { x: -56, y: 70, z: 267, axis: 'x', width: 2, height: 3 };
  const zone: NetherZone = { ...ROOM_ZONE, z1: 260, z2: 274 };
  const c = chooseHut(view(netherGround(), { netherPortals: [near], zones: [zone], base: netherPortalSpot(HOME_PORTAL, [near], [COMMUNITY], { ys: [70] }).spot! }));
  t.false('plan' in c);
  t.regex((c as { why: string }).why, /^no spot within 8 of nether \(-\d+, 70, \d+\) will do \(\d+ cells reached on foot\): within 16 of someone's build \(\d+\)/);
});

test('the spot keeps 24 from a portal of others whose overworld side is not known, and spotFault refuses one that would take a link', (t) => {
  // a portal of someone's in the Nether with no overworld portal known that leads into it
  const blind: PortalShape = { x: -90, y: 70, z: 262, axis: 'x', width: 2, height: 3 };
  t.false(overworldSideKnown(blind, [COMMUNITY], [COMMUNITY_NETHER, blind]));
  t.true(overworldSideKnown(COMMUNITY_NETHER, [COMMUNITY], [COMMUNITY_NETHER, blind]));
  // the hut dug into the cliff is 9 from it: none of the spots left will do then
  const cliff = hutOf({ x: -79, y: 70, z: 266, axis: 'z', side: 1, door: 1 });
  const sq = (p: Pos, b: Box) => Math.max(Math.max(0, b.x1 - p.x, p.x - b.x2), Math.max(0, b.z1 - p.z, p.z - b.z2));
  t.true(portalCells(blind).some(p => sq(p, cliff.box) < FROM_UNKNOWN));
  const c = chooseHut(view(netherGround(), { netherPortals: [COMMUNITY_NETHER, blind] }));
  t.false('plan' in c);
  t.regex((c as { why: string }).why, new RegExp(`within ${FROM_UNKNOWN} of a portal whose overworld side is not known \\(\\d+\\)`));
  // an overworld portal the hut would rob: its Nether side right by the hut's spot, its own Nether side further
  const robbed: PortalShape = { x: (-79) * 8, y: 70, z: 268 * 8, axis: 'x', width: 2, height: 3 };
  const theirs: PortalShape = { x: -76, y: 70, z: 276, axis: 'x', width: 2, height: 3 };
  t.regex(spotFault(shapeOf({ x: -79, y: 70, z: 266, axis: 'z', side: 1, door: 1 }), HOME_PORTAL, [COMMUNITY_NETHER, theirs], [COMMUNITY, robbed]) ?? '', /would come out at|would take the link|back through it/);
  const d = chooseHut(view(netherGround(), { netherPortals: [COMMUNITY_NETHER, theirs], overworldPortals: [COMMUNITY, robbed] }));
  if ('plan' in d) t.is(spotFault(shapeOf(d.plan.hut.spot), HOME_PORTAL, [COMMUNITY_NETHER, theirs], [COMMUNITY, robbed]), null);
  else t.regex(d.why, /^no spot/);
});

test('the way out of their room: on foot through its doorway, within their box and 8; a closed room has none', (t) => {
  const box = { x1: -110, y1: 45, z1: 240, x2: -30, y2: 100, z2: 320 };
  const g = gridOf(netherGround(), box);
  const start = footing(g, { x: -55.5, y: 70, z: CZ + 2.5 })!;
  t.deepEqual(start, { x: -56, y: 70, z: CZ + 2 });
  const way = wayOut(g, start, [ROOM_ZONE], [ROOM_ZONE]);
  if (!way) return t.fail('no way out');
  const end = way[way.length - 1];
  t.true(end.x < ROOM_ZONE.x1, fmt(end));
  t.true(way.some(p => p.x === -59 && p.z === CZ), 'by the doorway');
  t.true(way.every(p => p.x >= ROOM_ZONE.x1 - WAY_OUT && p.z >= ROOM_ZONE.z1 - WAY_OUT && p.z <= ROOM_ZONE.z2 + WAY_OUT));
  const shut = gridOf(netherGround(true), box);
  t.is(wayOut(shut, footing(shut, { x: -55.5, y: 70, z: CZ + 2.5 })!, [ROOM_ZONE], [ROOM_ZONE]), null);
});

// ------------------------------------------------------------------------------------------------ the gate

test('the setup\'s gate: open until linked; held a day after a trip that came back with nothing; the kit short only of what the chests lack; the hour', (t) => {
  const w = setupWorld();
  const s = lookAt(KIT, 1000);
  t.true(setupOpen(w));
  // (P3a adds the barter and the quartz at stage 1, P3b the scouting and the debris at stage 2)
  t.deepEqual(NETHER_WORK.map(v => `${v.id} ${v.stage}`), ['setup 0', 'look 0', 'barter 1', 'quartz 1', 'scout 2', 'debris 2', 'fortress 3', 'tunnel 3', 'bastion 3']);
  // the kit: the golden helmet, the flint and steel and the obsidian from the chests; the shield worn, three pickaxes
  t.deepEqual(setupShort(s, w), []);
  t.is(setupReady(s, w), null);
  t.is(rung().wants(s, w), 'setup: in the nether');
  const bare = liveWorld();
  t.deepEqual(setupShort(s, bare), ['a golden helmet', 'flint and steel', '10 obsidian']);
  t.deepEqual(setupReady(s, bare), { cause: 'kit', text: 'setup: short of a golden helmet, flint and steel, 10 obsidian (carried or in the chests)' });
  t.like(setupReady(lookAt(KIT, 1000, { health: 15 }), w), { cause: 'health' });
  t.like(setupReady(lookAt(KIT, 2900), w), { cause: 'late', text: 'setup needs 4 min down there and home by dusk, 3.7 left' });
  // (each look a fresh snapshot, as each tick's is: the queue keeps its answer for a snapshot)
  netherOf(w).setupHold = { until: T0 + 20 * HOUR, why: 'no spot for its own portal' };
  t.deepEqual(setupReady(lookAt(KIT, 1000), w), { cause: 'hold', text: 'setup held until 12:40: no spot for its own portal', until: T0 + 20 * HOUR });
  t.like(rung().declines!(lookAt(KIT, 1000), w), { cause: 'hold', text: 'setup held until 12:40: no spot for its own portal' });
  netherOf(w).linked = true;
  t.false(setupOpen(w));
  t.deepEqual(rung().declines!(lookAt(KIT, 1000), w), { cause: 'unneeded', text: 'no nether work yet' });
  // the switch off: no setup however ready
  const off = setupWorld();
  off.nether!.trips = false;
  t.deepEqual(rung().declines!(s, off), { cause: 'unneeded', text: 'nether trips are off' });
  // (the gates write nothing)
  const before = JSON.stringify(setupWorld());
  const w2 = setupWorld();
  setupReady(s, w2); setupShort(s, w2); rung().wants(s, w2); rung().declines!(s, w2);
  t.is(JSON.stringify(w2), before);
});

// ------------------------------------------------------------------------------------------------ the trip

test.serial('the setup trip end to end: the kit from the chests, through the home portal into the community\'s room, out on foot, its own portal dug into the cliff, lit, registered, back through it by the home portal: linked', async (t) => {
  const w = setupWorld();
  const f = game(w);
  const text = await rung().run(f.ctx);
  t.is(text, '[setup] its own portal at nether (-79, 70, 266), linked with the home portal; back home');
  // the kit: what the chests held of it taken, never the spare set (there is none here) or more than the kit
  t.deepEqual(f.did.filter(d => d.startsWith('take ')), ['take obsidian x10', 'take flint_and_steel x1', 'take cobblestone x32', 'take golden_helmet x1']);
  const lines = f.said.filter(l => l.startsWith('nether: '));
  t.is(lines[0], 'nether: through the portal at overworld (-562, 63, 2191) -> nether (-56, 70, 285)');
  t.is(lines[1], 'nether: came out of the portal at nether (-56, 70, 285): someone\'s, in their build (stone_bricks)');
  t.regex(lines[2], /^nether: out of their build on foot to nether \(-64, 70, 285\) \(\d+ steps, nothing dug or placed\)$/);
  t.regex(lines[3], /^nether: its own portal goes at nether \(-79, 70, 266\) along z, 8 from nether \(-71, 70, 273\)/);
  t.is(lines[4], 'nether: built own portal at nether (-79, 70, 266)');
  t.is(lines[5], 'nether: linked: home portal overworld (-562, 63, 2191) <-> nether (-79, 70, 266)');
  t.is(lines.length, 6, lines.join(' | '));
  // through the portals: in by the community's, back by its own to the home portal
  t.deepEqual(f.did.filter(d => d.startsWith('portal ')), ['portal overworld (-562, 63, 2191) -> the_nether (-56, 70, 285)', 'portal the_nether (-79, 70, 266) -> overworld (-562, 65, 2191)']);
  t.true(f.did.includes('portal.own the_nether (-79, 70, 266)'));
  t.true(f.did.includes('use flint_and_steel on (-79, 69, 267) face up from (-78, 70, 267)'), f.did.filter(d => d.startsWith('use')).join(' | '));
  // remembered: its own portal, linked, the spot let go (the portal is the memory now)
  const n = peekNether(w);
  t.deepEqual(n.portal, { x: -79, y: 70, z: 266 });
  t.true(n.linked);
  t.is(n.setupSpot, undefined);
  t.is(n.setupHold, undefined);
  t.true((n.seen?.[NETHER] ?? []).some(p => p.x === COMMUNITY_NETHER.x && p.z === COMMUNITY_NETHER.z), 'the community\'s Nether side kept for netherPortalSpot');
  t.deepEqual(n.tripsToday, { day: w.idle?.today?.day ?? 0, n: 1 });
  // courtesy: nothing dug or placed in or near their build, every step in it careful, and in the Nether no walk that may break or place
  const near = (p: Pos) => p.x >= ROOM_ZONE.x1 - WAY_OUT && p.x <= ROOM_ZONE.x2 + WAY_OUT && p.y >= ROOM_ZONE.y1 - WAY_OUT && p.y <= ROOM_ZONE.y2 + WAY_OUT && p.z >= ROOM_ZONE.z1 - WAY_OUT && p.z <= ROOM_ZONE.z2 + WAY_OUT;
  t.deepEqual(f.changed.filter(c => c.dim === NETHER && near(c.at)), []);
  t.deepEqual(f.walks.filter(x => x.dim === NETHER && !x.careful), []);
  // what it built: only the hut's cells changed, the frame whole and lit, the inside a portal, the door open
  const hut = hutOf({ x: -79, y: 70, z: 266, axis: 'z', side: 1, door: 1 });
  const cells = new Set([...hut.inside, ...hut.frame, ...hut.corners, ...hut.room, ...hut.door, ...hut.shell, hut.sill].map(k));
  t.deepEqual(f.changed.filter(c => c.dim === NETHER && !cells.has(k(c.at))), []);
  t.true(hut.frame.every(p => f.get(NETHER, p) === 'obsidian'));
  t.true(hut.inside.every(p => f.get(NETHER, p) === 'nether_portal'));
  t.true([...hut.shell, ...hut.corners].every(p => cellOf(f.get(NETHER, p).replace(/\[.*$/, '')) !== 'open'));
  // the blocks it carried down: 10 obsidian in the frame, 4 cobblestone in the front wall, the rest kept for the way home
  t.is(f.inv.filter(i => i.name === 'obsidian').reduce((a, i) => a + i.count, 0), 0);
  t.true(f.inv.filter(i => i.name === 'cobblestone').reduce((a, i) => a + i.count, 0) >= 60);
  // and home: the walk home from the home portal is the wrapper's
  t.is(f.state.dim, OVERWORLD);
  t.true(f.did.at(-1)!.startsWith('go-home from overworld'), f.did.at(-1));
  t.false(afield.trip);
});

test.serial('the setup trip at a closed room: no way out on foot, so nothing dug, placed or walked down there; back through their portal at once, the setup held a day and said so', async (t) => {
  const w = setupWorld();
  const f = game(w, { closed: true });
  const text = await rung().run(f.ctx);
  t.is(text, '[setup] in someone\'s build with no way out on foot; back at overworld (-444, 70, 2283); setup held a day; back home');
  t.true(f.said.includes('nether: arrived in someone\'s build at nether (-56, 70, 285) with no way out on foot: back, setup held a day'), f.said.join(' | '));
  t.deepEqual(f.changed.filter(c => c.dim === NETHER), []);
  t.deepEqual(f.walks.filter(x => x.dim === NETHER), []);
  t.deepEqual(f.did.filter(d => d.startsWith('portal ')), ['portal overworld (-562, 63, 2191) -> the_nether (-56, 70, 285)', 'portal the_nether (-56, 70, 285) -> overworld (-444, 70, 2283)']);
  const n = peekNether(w);
  t.deepEqual(n.setupHold, { until: T0 + SETUP_HOLD_MS, why: 'arrived in someone\'s build at nether (-56, 70, 285) with no way out on foot' });
  t.is(n.portal, undefined);
  t.not(n.linked, true);
  // held: past the probation's hour the rung says so until the day is out (the lead looks), then it tries again
  t.like(rung().declines!(lookAt(f.inv, 1000, { now: T0 + 2 * HOUR }), w), { cause: 'hold', text: 'setup held until 16:40: arrived in someone\'s build at nether (-56, 70, 285) with no way out on foot' });
  t.regex(rung().wants(lookAt(f.inv, 1000, { now: T0 + SETUP_HOLD_MS }), w) ?? '', /^setup: in the nether/, 'the day out, it tries again');
});

test.serial('the setup trip whose own portal leads back elsewhere (a portal of someone\'s it never saw is nearer): not linked, said, held a day; its own portal kept', async (t) => {
  const w = setupWorld();
  const stranger: PortalShape = { x: -622, y: 63, z: 2134, axis: 'x', width: 2, height: 3 };
  const f = game(w, { stranger });
  const text = await rung().run(f.ctx);
  t.is(text, '[setup] its own portal at nether (-79, 70, 266) led back to overworld (-622, 65, 2134): not linked; setup held a day; back home');
  t.true(f.said.includes('nether: built own portal at nether (-79, 70, 266)'));
  t.true(f.said.includes('nether: not linked: came out at overworld (-622, 65, 2134)'), f.said.join(' | '));
  const n = peekNether(w);
  t.is(n.linked, false);
  t.deepEqual(n.portal, { x: -79, y: 70, z: 266 });
  t.like(n.setupHold, { until: T0 + SETUP_HOLD_MS });
  t.true(f.did.at(-1)!.startsWith('go-home from overworld'));
});

test.serial('a setup trip after a held one, its own portal standing: the home portal comes out there now, and it goes straight back through to check the link', async (t) => {
  const w = setupWorld();
  const first = game(w, { stranger: { x: -622, y: 63, z: 2134, axis: 'x', width: 2, height: 3 } });
  await rung().run(first.ctx);
  t.is(peekNether(w).linked, false);
  // a day on, the stranger's portal gone (the lead saw to it): the hut as the first trip left it, carrying what it carried
  delete netherOf(w).setupHold;
  const f = game(w, { items: first.inv, after: first, now: T0 + 2 * HOUR });
  const text = await rung(T0 + 2 * HOUR).run(f.ctx);
  t.is(text, '[setup] its own portal at nether (-79, 70, 266), linked with the home portal; back home');
  t.deepEqual(f.did.filter(d => d.startsWith('portal ')), ['portal overworld (-562, 63, 2191) -> the_nether (-79, 70, 267)', 'portal the_nether (-79, 70, 266) -> overworld (-562, 65, 2191)']);
  t.true(f.said.includes('nether: came out of the portal at nether (-79, 70, 266): its own'), f.said.join(' | '));
  t.deepEqual(f.changed.filter(c => c.dim === NETHER), [], 'nothing dug or placed');
  t.true(peekNether(w).linked);
});

test.serial('its own portal standing, but the home portal came out at someone\'s nearer home\'s scaled point: not linked the one way, said, held a day; home by its own portal', async (t) => {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  t.true(peekNether(w).linked);
  // someone put a portal up by home's scaled point since (the bridge has not scanned it yet: counted someone's anyway)
  netherOf(w).linked = false;
  const f = game(w, { items: first.inv, after: first, now: T0 + 2 * HOUR });
  f.lit.push({ x: -71, y: 70, z: 273, axis: 'x', width: 2, height: 3, dim: NETHER });
  const text = await rung(T0 + 2 * HOUR).run(f.ctx);
  t.is(text, '[setup] the home portal came out at nether (-71, 70, 273), not at its own: not linked; setup held a day; back home');
  t.true(f.said.includes('nether: came out of the portal at nether (-71, 70, 273): someone\'s, in their build (nether_portal (not scanned yet))'), f.said.join(' | '));
  t.true(f.said.includes('nether: not linked: the home portal came out at nether (-71, 70, 273), not at its own at nether (-79, 70, 266): setup held a day'), f.said.join(' | '));
  const n = peekNether(w);
  t.is(n.linked, false);
  t.like(n.setupHold, { until: T0 + 2 * HOUR + SETUP_HOLD_MS });
  // out of their portal's ground on foot first, nothing touched; home through its own (the wrapper's netherHome)
  t.deepEqual(f.changed.filter(c => c.dim === NETHER), []);
  t.deepEqual(f.did.filter(d => d.startsWith('portal ')), ['portal overworld (-562, 63, 2191) -> the_nether (-71, 70, 273)', 'portal the_nether (-79, 70, 267) -> overworld (-562, 65, 2191)']);
});

test.serial('the kit at home: the obsidian, the flint and steel and the blocks out of the chests, room made again for the trip\'s 12 slots with the kit kept, the golden helmet last', async (t) => {
  const w = setupWorld();
  // a lean kit and 15 stacks of logs: 13 free, and the kit takes three
  const lean: [string, number][] = [['diamond_pickaxe', 1], ['iron_pickaxe', 1], ['diamond_sword', 1], ['torch', 32], ['cobblestone', 32], ['bread', 62], ['apple', 64], ['diamond_shovel', 1]];
  const items: InventoryItem[] = [...lean, ...Array.from({ length: 15 }, () => ['oak_log', 64] as [string, number])].map(([name, count], slot) => ({ slot, name, count }));
  const f = game(w, { items: [...items, ...WORN.map(i => ({ ...i }))] });
  t.is(await fetchSetupKit(f.ctx), undefined);
  const order = f.did.filter(d => /^(take|store) /.test(d));
  t.deepEqual(order.slice(0, 3), ['take obsidian x10', 'take flint_and_steel x1', 'take cobblestone x32']);
  t.true(order.some(d => d.startsWith('store oak_log')), order.join(' | '));
  t.is(order.at(-1), 'take golden_helmet x1', 'the helmet after the room was made: the stash would have put it away');
  t.false(order.some(d => /^store (obsidian|flint_and_steel|cobblestone|golden_helmet)/.test(d)), 'the kit kept');
  const used = new Set(f.inv.filter(i => i.slot < 36).map(i => i.slot)).size;
  t.true(36 - used >= 12, `${36 - used} free`);
});

test.serial('the setup does not set out without its kit: short of what the chests do not hold, an untried run that never went through', async (t) => {
  const w = setupWorld();
  delete w.chestItems!['-547,64,2182'].golden_helmet;
  // (the gate says so first; a run that got here anyway fetches what there is and stops at home)
  t.like(rung().declines!(lookAt(KIT, 1000), w), { cause: 'kit', text: 'setup: short of a golden helmet (carried or in the chests)' });
  const f = game(w);
  const task = LADDER.find(x => x.name === 'nether')!;
  const r = await task.run(f.ctx, 'setup', 300_000, () => T0);
  t.like(r, { gain: 0, untried: true });
  t.regex(r.text, /^not setting out: no golden helmet/);
  t.false(f.did.some(d => d.startsWith('portal ')));
  t.is(f.state.dim, OVERWORLD);
});

test('the setup\'s gates write nothing, at any hour, well or hurt (A16: the run and the wrapper write, never a gate)', (t) => {
  // (decide with the switch off is P2a's test in nether.test.ts, on the live world: the rung says the switch is off)
  for (const tod of [0, 1000, 2900, 6000, 11_000, 13_000]) for (const health of [20, 10]) {
    const w = setupWorld();
    const before = JSON.stringify(w);
    const s: Snapshot = lookAt(KIT, tod, { health });
    rung().wants(s, w); rung().declines!(s, w); setupReady(s, w);
    t.is(JSON.stringify(w), before);
  }
});

// ------------------------------------------------------------------------------------------------ what is not the bot's to dig

test('someone\'s cobblestone down there (plain cobblestone makes no zone to the bridge) is never dug, and the hut keeps 2 from it; its own at a spot chosen before is its own; gold ore is never dug (piglins guard it)', (t) => {
  t.is(cellOf('cobblestone'), 'solid');
  t.is(cellOf('cobbled_deepslate'), 'solid');
  t.is(cellOf('nether_gold_ore'), 'solid');
  t.is(cellOf('netherrack'), 'dig');
  // the cliff's face built over in cobblestone: someone's wall along it, x -80..-77
  const nr = netherGround();
  const wall = (p: Pos) => (p.x <= -77 && p.x >= -80 && p.y >= 69 && p.y <= 75 && p.z >= 255 && p.z <= 285 && nr(p) === 'netherrack' ? 'cobblestone' : nr(p));
  const noneBy = (get: (p: Pos) => string, b: Box) => {
    const out: string[] = [];
    for (let x = b.x1; x <= b.x2; x++) for (let y = b.y1; y <= b.y2; y++) for (let z = b.z1; z <= b.z2; z++) if (get({ x, y, z }) === 'cobblestone') out.push(fmt({ x, y, z }));
    return out;
  };
  const c = chooseHut(view(wall));
  if ('plan' in c) {
    const digs = c.plan.steps.filter(x => x.do === 'dig') as { at: Pos }[];
    t.deepEqual(digs.filter(d => wall(d.at) === 'cobblestone').map(d => fmt(d.at)), [], 'none of their cobblestone dug');
    t.deepEqual(noneBy(wall, grow(c.plan.hut.box, PLACED_GAP)), [], c.why);
  } else t.regex(c.why, /^no spot within 8 of nether/);
  // one block of someone's cobblestone 2 off the cliff's best spot: that spot is refused (and here, the cliff's only
  // ones being by it, every spot)
  const best = { x: -79, y: 70, z: 266, axis: 'z' as const, side: 1 as const, door: 1 as const };
  t.like(chooseHut(view(nr)), { plan: { hut: { spot: best } } });
  const post = (p: Pos) => (p.x === -74 && p.y === 70 && p.z === 264 ? 'cobblestone' : nr(p));
  const d = chooseHut(view(post));
  if ('plan' in d) {
    t.notDeepEqual(d.plan.hut.spot, best);
    t.deepEqual(noneBy(post, grow(d.plan.hut.box, PLACED_GAP)), []);
  } else t.regex(d.why, /within 2 of cobblestone someone placed \(\d+\)/);
  // the bot's own cobblestone in its front wall, at the spot a trip cut short chose: taken again all the same
  const front = hutOf(best).shell.find(p => p.x === -76 && p.y === 70 && p.z === 266)!;
  const mine = (p: Pos) => (k(p) === k(front) ? 'cobblestone' : nr(p));
  t.notDeepEqual((chooseHut(view(mine)) as { plan?: { hut: { spot: unknown } } }).plan?.hut.spot, best, 'anyone\'s, unless chosen before');
  const again = chooseHut(view(mine), best);
  if (!('plan' in again)) return t.fail(again.why);
  t.deepEqual(again.plan.hut.spot, best);
  t.regex(again.why, /\(chosen before\)/);
  // gold ore: kept as a wall where it stands, never dug out of the room
  const box = { x1: -10, y1: 55, z1: -10, x2: 10, y2: 80, z2: 10 };
  const hut = hutOf({ x: 0, y: 70, z: 0, axis: 'x', side: 1, door: 0 });
  const judge = (extra: Record<string, string>) => { const r = judgeHut(gridOf(flat(extra), box), hut, { cobblestone: 64, obsidian: 10 }); return 'why' in r ? r.why : 'fine'; };
  t.is(judge({ [k({ x: 1, y: 71, z: 1 })]: 'nether_gold_ore' }), 'something in the way that is not the bot\'s to dig');
  t.is(judge({ [k({ x: 0, y: 69, z: 0 })]: 'nether_gold_ore' }), 'something in the frame that is not the bot\'s to dig');
  t.is(judge({ [k({ x: 0, y: 69, z: 1 })]: 'nether_gold_ore' }), 'fine', 'in the room\'s floor: a wall kept as it is');
});

// ------------------------------------------------------------------------------------------------ cut short, and on again

test.serial('a setup cut short after 3 of the frame\'s obsidian (a place that failed twice): the spot kept with 7 to place; the next trip\'s gate and kit ask for those 7 only, and it goes on there: lit, linked', async (t) => {
  const w = setupWorld();
  const f = game(w);
  let tries = 0;
  const act = f.ctx.act;
  (f.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool === 'place-block' && a.item === 'obsidian' && tries++ >= 3) return { ok: true, text: `Failed to place block at (${a.x}, ${a.y}, ${a.z}): a magma cube in the way` };
    return act(tool, a);
  }) as GoalContext['act'];
  t.regex(await rung().run(f.ctx), /^\[setup\] the hut at nether \(-79, 70, 266\): could not place obsidian at/);
  t.is(f.changed.filter(c => c.dim === NETHER && c.to === 'obsidian').length, 3);
  const n = peekNether(w);
  t.like(n.setupSpot, { x: -79, y: 70, z: 266, axis: 'z', obsidian: 7 });
  t.is(n.portal, undefined);
  t.is(n.setupHold, undefined);
  t.is(f.inv.filter(i => i.name === 'obsidian').reduce((a, i) => a + i.count, 0), 7);
  // (kept in brain.json as it is: a whole number of the frame's 10, else none)
  const reread = (obsidian: unknown) => peekNether({ ...w, nether: JSON.parse(JSON.stringify({ ...w.nether, setupSpot: { ...n.setupSpot, obsidian } })) }).setupSpot;
  t.like(reread(7), { x: -79, obsidian: 7 });
  for (const bad of [11, 2.5, -1, '7']) t.is(reread(bad)?.obsidian, undefined, String(bad));
  // two hours on: the 7 it carries will do (the chests hold none now)
  const later = T0 + 2 * HOUR;
  const s = lookAt(f.inv, 1000, { now: later });
  t.is(setupObsidian(w), 7);
  t.deepEqual(setupShort(s, w), []);
  t.is(setupReady(s, w), null);
  t.regex(rung(later).wants(s, w) ?? '', /^setup: in the nether/);
  t.deepEqual(setupShort(lookAt(KIT, 1000, { now: later }), w).filter(x => /obsidian/.test(x)), ['7 obsidian'], 'none carried: the 7 left');
  const g = game(w, { items: f.inv, after: f, now: later });
  t.is(await rung(later).run(g.ctx), '[setup] its own portal at nether (-79, 70, 266), linked with the home portal; back home');
  t.true(g.said.some(l => /^nether: its own portal goes at nether \(-79, 70, 266\) along z \(chosen before\)/.test(l)), g.said.join(' | '));
  t.is(g.changed.filter(c => c.dim === NETHER && c.to === 'obsidian').length, 7);
  t.like(peekNether(w), { portal: { x: -79, y: 70, z: 266 }, linked: true, setupSpot: undefined });
});

test.serial('a setup stopped mid-build (leave nether, the timeout): the frame\'s count as it stood when it stopped; once the frame is whole, no obsidian asked for', async (t) => {
  for (const [stop, left] of [[5, 5], [10, 0]] as const) {
    const w = setupWorld();
    const f = game(w);
    const ac = new AbortController();
    (f.ctx as { signal: AbortSignal }).signal = ac.signal;
    let placed = 0;
    const act = f.ctx.act;
    (f.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
      const r = await act(tool, a);
      if (tool === 'place-block' && a.item === 'obsidian' && /^Placed /.test(r.text) && ++placed === stop) ac.abort();
      return r;
    }) as GoalContext['act'];
    await t.throwsAsync(setupRun(f.ctx, HOUR, () => T0), { message: 'aborted' });
    t.like(peekNether(w).setupSpot, { x: -79, y: 70, z: 266, obsidian: left });
    t.is(setupObsidian(w), left);
    // none carried (a death took it) and none in the chests: what is left to place, and only that
    t.deepEqual(setupShort(lookAt(KIT, 1000), w).filter(x => /obsidian/.test(x)), left ? [`${left} obsidian`] : []);
  }
});

// ------------------------------------------------------------------------------------------------ a death down there

/**
 * A setup whose bot dies down there at the `n`th call that `what` picks (it wakes at its bed in the overworld,
 * empty-handed), that call answering `answer` (the walk or the dig cut off, else as if done just before); what it
 * sent after.
 */
function dies(what: (m: string) => boolean, n: number, answer?: Record<string, unknown>) {
  const w = setupWorld();
  const f = game(w);
  const after: string[] = [];
  let seen = 0, dead = false;
  const call = f.ctx.call, act = f.ctx.act;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (dead && !['inventory', 'item.select'].includes(m)) after.push(`${m} (${p.x}, ${p.y}, ${p.z})`);
    if (!dead && f.state.dim === NETHER && what(m) && ++seen === n) {
      dead = true;
      f.state.dim = OVERWORLD;
      f.state.pos = { x: -536.5, y: 63, z: 2193.5 };
      f.inv.splice(0, f.inv.length);
      return answer ?? (m === 'goto' ? { arrived: false } : { dug: false, reason: 'out of reach or out of sight' });
    }
    return call(m, p, ms);
  }) as GoalContext['call'];
  (f.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (dead) after.push(`act ${tool} (${a.x}, ${a.y}, ${a.z})`);
    return act(tool, a);
  }) as GoalContext['act'];
  return { w, f, after };
}

test.serial('a death down there (on the walk out of their room, on the walk to its spot, mid-build): nothing more sent to the Nether\'s numbers in the overworld, no hold, nothing written of the link', async (t) => {
  const cases: [(m: string) => boolean, number, string, Record<string, unknown>?][] = [
    [m => m === 'goto', 2, 'out of their room'], [m => m === 'goto', 8, 'to its spot'], [m => m === 'dig.here', 5, 'mid-build'],
    [m => m === 'dig.here', 5, 'mid-build, just after a dig', { dug: true }]
  ];
  for (const [what, n, where, answer] of cases) {
    const { w, f, after } = dies(what, n, answer);
    const r = await setupRun(f.ctx, HOUR, () => T0);
    t.deepEqual(r, GONE, where);
    t.deepEqual(after.filter(x => /^(goto|dig\.here|portal\.enter|act place-block|act use-item-on-block)/.test(x)), [], where);
    const m = peekNether(w);
    t.is(m.setupHold, undefined, where);
    t.is(m.portal, undefined, where);
    t.not(m.linked, true, where);
  }
});

// ------------------------------------------------------------------------------------------------ the time, the arrival, the scan

test.serial('the setup does not set out when the kit at home left too little of the day: an untried run, never through', async (t) => {
  const w = setupWorld();
  const f = game(w);
  t.deepEqual(await setupRun(f.ctx, SETUP_LEAST_MS - 1, () => T0), { gain: 0, text: 'not setting out: the kit took 0 s, too little of the day\'s time is left', untried: true });
  t.false(f.did.some(d => d.startsWith('portal ')));
  t.is(f.state.dim, OVERWORLD);
});

test.serial('a setup that never went through (the home portal not listed) is no trip: its start taken back, so neither the probation\'s hour nor one of the day\'s two is gone', async (t) => {
  const w = setupWorld();
  const f = game(w);
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) =>
    (m === 'portal.list' && f.state.dim === OVERWORLD ? { dimension: OVERWORLD, portals: [] } : call(m, p, ms))) as GoalContext['call'];
  await t.throwsAsync(rung().run(f.ctx), { message: /^\[setup\] the home portal at overworld \(-562, 63, 2191\) is not lit/ });
  const n = peekNether(w);
  t.deepEqual(n.starts, []);
  t.is(n.tripsToday, undefined);
  t.is(n.lastTrip, undefined);
  // ten minutes on the rung is not on probation for it (the brain's own retry hold keeps it from going again at once)
  t.is(rung(T0 + 10 * MINUTE).wants(lookAt(f.inv, 1000, { now: T0 + 10 * MINUTE }), w), 'setup: in the nether');
});

test.serial('its own portal left out of the lists down there (its chunk not in yet) but standing: never forgotten, and the home portal coming out elsewhere is the broken link; its chunks not in at all: nothing changed', async (t) => {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  t.true(peekNether(w).linked);
  const later = T0 + 2 * HOUR;
  const own = (p: { x: number; z: number }) => p.x === -79 && p.z === 266;
  const blind = (unloaded: boolean) => {
    netherOf(w).linked = false;
    delete netherOf(w).setupHold;
    const f = game(w, { items: first.inv, after: first, now: later });
    // someone's portal by home's scaled point since: the home portal comes out there
    f.lit.push({ x: -71, y: 70, z: 273, axis: 'x', width: 2, height: 3, dim: NETHER });
    const call = f.ctx.call;
    (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) => {
      const got = await call(m, p, ms) as { portals?: PortalShape[]; blocks?: (string | null)[] };
      if (m === 'portal.list' && f.state.dim === NETHER) got.portals = got.portals!.filter(x => !own(x));
      if (m === 'world.region' && f.state.dim === NETHER && unloaded) {
        const x0 = Number(p.x), y0 = Number(p.y), z0 = Number(p.z), wd = Number(p.width), ln = Number(p.length);
        got.blocks = got.blocks!.map((b, i) => {
          const x = x0 + (i % wd), z = z0 + (Math.floor(i / wd) % ln), y = y0 + Math.floor(i / (wd * ln));
          return Math.abs(x + 79) <= 3 && z >= 263 && z <= 270 && y >= 66 && y <= 76 ? null : b;
        });
      }
      return got;
    }) as GoalContext['call'];
    return f;
  };
  const f = blind(false);
  t.deepEqual(await setupRun(f.ctx, HOUR, () => later), { gain: 0, text: 'the home portal came out at nether (-71, 70, 273), not at its own: not linked; setup held a day' });
  t.false(f.said.some(l => /is not lit/.test(l)), f.said.join(' | '));
  t.deepEqual(peekNether(w).portal, { x: -79, y: 70, z: 266 });
  t.like(peekNether(w).setupHold, { until: later + SETUP_HOLD_MS });
  const g = blind(true);
  t.deepEqual(await setupRun(g.ctx, HOUR, () => later), { gain: 0, text: 'its own portal at nether (-79, 70, 266) not in sight (its chunks not in): nothing changed' });
  t.deepEqual(peekNether(w).portal, { x: -79, y: 70, z: 266 });
  t.is(peekNether(w).setupHold, undefined);
  t.deepEqual(g.changed.filter(c => c.dim === NETHER), []);
});

test.serial('a build in a chunk that came in while the ground was read (the bridge\'s scan had not seen it at the first ask): the hut keeps its 16 from it too', async (t) => {
  const other: NetherZone = { x1: -95, y1: 66, z1: 258, x2: -85, y2: 78, z2: 272, markers: 40, surface: true, sample: 'nether_bricks' };
  const w = setupWorld();
  const f = game(w);
  let loaded = false;
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (m === 'foreign.zones' && f.state.dim === NETHER) return { dimension: NETHER, zones: loaded ? [{ ...ROOM_ZONE }, { ...other }] : [{ ...ROOM_ZONE }] };
    const got = await call(m, p, ms) as { blocks?: (string | null)[] };
    if (m === 'world.region' && f.state.dim === NETHER && !loaded) {
      // that chunk not in yet at the first read; in by the next, and the scan has the build in it from then on
      const x0 = Number(p.x), wd = Number(p.width);
      got.blocks = got.blocks!.map((b, i) => (x0 + (i % wd) >= -96 && x0 + (i % wd) <= -81 ? null : b));
      loaded = true;
    }
    return got;
  }) as GoalContext['call'];
  const r = await setupRun(f.ctx, HOUR, () => T0);
  const near = f.changed.filter(c => c.dim === NETHER && boxGap({ x1: c.at.x, y1: c.at.y, z1: c.at.z, x2: c.at.x, y2: c.at.y, z2: c.at.z }, other) < FROM_BUILDS);
  t.deepEqual(near, [], r.text);
  t.false(f.said.includes('nether: built own portal at nether (-79, 70, 266)'), r.text);
});

// ------------------------------------------------------------------------------------------------ courtesy, pinned

test('courtesy: the walk to the hut never goes through anyone\'s build, though that is the only way', (t) => {
  // a pocket east of home's scaled point whose one way out is a doorway in someone's build
  const pocket = (p: Pos) => {
    if (p.y <= 69 || p.y >= 90) return 'netherrack';
    const wall = p.x >= -46 && p.x <= -40 && p.z >= 269 && p.z <= 277 && p.y <= 72;
    const inside = p.x >= -45 && p.x <= -41 && p.z >= 270 && p.z <= 276;
    const door = p.x === -46 && p.z === 273 && p.y <= 71;
    return wall && !inside && !door ? 'netherrack' : 'air';
  };
  const theirs: NetherZone = { x1: -50, y1: 67, z1: 270, x2: -45, y2: 75, z2: 276, markers: 20, surface: true, sample: 'stone_bricks' };
  const grid = gridOf(pocket, { x1: -110, y1: 45, z1: 240, x2: -30, y2: 100, z2: 320 });
  const base = netherPortalSpot(HOME_PORTAL, [], [], { ys: [70] }).spot!;
  const v: SetupView = { grid, home: HOME_PORTAL, netherPortals: [], overworldPortals: [], zones: [theirs], base, arrival: { x: -43, y: 70, z: 273 }, from: [{ x: -43, y: 70, z: 273 }], cobblestone: 64, obsidian: 10 };
  const c = chooseHut(v);
  if ('plan' in c) t.deepEqual(c.path.filter(p => inBox(zoneBox(theirs), p)).map(fmt), [], c.why);
  else t.regex(c.why, /^no spot within 8 of nether .* \(\d+ cells reached on foot\)/);
  // (without their build there the same pocket has a way out, and a spot)
  t.true('plan' in chooseHut({ ...v, zones: [] }));
});

test('courtesy: the way out of their build stays within their box and 8; a corridor through another build beyond that is no way out', (t) => {
  // their room, its doorway west into a corridor 2 high that runs on west through someone else's build
  const hall = (p: Pos) => {
    const room = p.x >= -58 && p.x <= -53 && p.z >= CZ - 2 && p.z <= CZ + 2 && p.y >= 70 && p.y <= 72;
    const door = p.x === -59 && p.z === CZ && p.y >= 70 && p.y <= 71;
    const corridor = p.x >= -90 && p.x <= -60 && p.z === CZ && p.y >= 70 && p.y <= 71;
    return room || door || corridor ? 'air' : 'netherrack';
  };
  const g = gridOf(hall, { x1: -100, y1: 60, z1: CZ - 10, x2: -40, y2: 80, z2: CZ + 10 });
  const start = { x: -56, y: 70, z: CZ };
  const room = zoneBox(ROOM_ZONE);
  const next: Box = { x1: -75, y1: 68, z1: CZ - 1, x2: -64, y2: 74, z2: CZ + 1 };
  t.is(wayOut(g, start, [room], [room, next]), null, 'out of their box and 8 before it is out of every build');
  const way = wayOut(g, start, [room], [room]);
  if (!way) return t.fail('no way out');
  t.deepEqual(way.at(-1), { x: -64, y: 70, z: CZ });
  t.true(way.every(p => inBox(grow(room, WAY_OUT), p)));
  // (and the community's doorway in the test Nether: every step within the bound)
  const ng = gridOf(netherGround(), { x1: -110, y1: 45, z1: 240, x2: -30, y2: 100, z2: 320 });
  const out = wayOut(ng, footing(ng, { x: -55.5, y: 70, z: CZ + 2.5 })!, [room], [room])!;
  t.true(out.every(p => inBox(grow(room, WAY_OUT), p)), out.map(fmt).join(' '));
});

test('courtesy: the hut keeps its 16 from a natural fortress too (blazes), though the walks may pass through one', (t) => {
  const fortress: NetherZone = { x1: -100, y1: 60, z1: 250, x2: -90, y2: 80, z2: 280, markers: 300, surface: false, natural: 'fortress', sample: 'nether_bricks' };
  const cliff = hutOf({ x: -79, y: 70, z: 266, axis: 'z', side: 1, door: 1 });
  t.is(Math.round(boxGap(cliff.box, zoneBox(fortress))), 10);
  const c = chooseHut(view(netherGround(), { zones: [ROOM_ZONE, fortress] }));
  if ('plan' in c) t.true(boxGap(c.plan.hut.box, zoneBox(fortress)) >= FROM_BUILDS, c.why);
  else t.regex(c.why, /within 16 of someone's build/);
});

test.serial('a portal by home\'s scaled point that holds nothing but itself, on the first trip (perhaps the server\'s, made for it): counted someone\'s all the same, and said so in the line and the hold', async (t) => {
  const w = setupWorld();
  const f = game(w);
  // (the community's Nether side out of the server's 16 here, as P2a's live numbers may have it: gone from this world)
  f.lit.splice(f.lit.findIndex(l => l.dim === NETHER && l.x === COMMUNITY_NETHER.x), 1);
  f.lit.push({ x: -71, y: 70, z: 273, axis: 'x', width: 2, height: 3, dim: NETHER });
  const r = await setupRun(f.ctx, HOUR, () => T0);
  const LONE = 'a portal by home\'s scaled point that holds nothing but itself, perhaps the server\'s, made for this trip';
  t.true(f.said.includes(`nether: came out of the portal at nether (-71, 70, 273): ${LONE} (counted someone's; the lead looks)`), f.said.join(' | '));
  t.true((peekNether(w).setupHold?.why ?? '').endsWith(`(it came out at nether (-71, 70, 273): ${LONE})`), `${r.text} | ${peekNether(w).setupHold?.why}`);
  t.true(netherLine(w, T0).includes(LONE));
  // the rule: by the scaled point, no other portal known there, nothing in its zone but its own blocks
  const at: PortalShape = { x: -71, y: 70, z: 273, axis: 'x', width: 2, height: 3 };
  const zone = (kinds: string[], markers: number): NetherZone => ({ x1: -75, y1: 66, z1: 269, x2: -66, y2: 76, z2: 277, markers, surface: true, sample: 'nether_portal', kinds });
  t.true(maybeServers(at, HOME_PORTAL, [zone(['nether_portal x6'], 6)], portalCells(at)));
  t.false(maybeServers(at, HOME_PORTAL, [zone(['nether_portal x6', 'stone_bricks x40'], 46)], []), 'a build round it');
  t.false(maybeServers({ ...at, x: -40, z: 300 }, HOME_PORTAL, [zone(['nether_portal x6'], 6)], []), 'far from home\'s scaled point');
  t.false(maybeServers(at, HOME_PORTAL, [zone(['nether_portal x6'], 6)], [{ x: -79, y: 70, z: 266 }]), 'a portal known there already: the server makes none then');
  t.false(maybeServers(at, HOME_PORTAL, [], []), 'in no build at all: not counted someone\'s');
  // the community's room is someone's build, as ever (the end to end trip's line)
  t.false(maybeServers(COMMUNITY_NETHER, HOME_PORTAL, [ROOM_ZONE], []));
});

// ------------------------------------------------------------------------------------------------ F3

/**
 * What the setup trip carried at its room on Nov 14 (22:10Z: "not setting out: 9 free slots < 12", after "stored 0,
 * dropped 0"): the home kit, the Nether kit fetched, stacks split, a second diamond helmet, the armour worn.
 */
const AT_THE_SETUP: InventoryItem[] = [
  ...['diamond_pickaxe', 'iron_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_shovel'].map((name, slot) => ({ slot, name, count: 1, damage: 0, maxDamage: 1561 })),
  { slot: 5, name: 'torch', count: 40 }, { slot: 6, name: 'dirt', count: 47 }, { slot: 7, name: 'dirt', count: 16 }, { slot: 8, name: 'cobblestone', count: 40 },
  { slot: 9, name: 'cobblestone', count: 15 }, { slot: 10, name: 'cobbled_deepslate', count: 9 }, { slot: 11, name: 'potato', count: 56 }, { slot: 12, name: 'potato', count: 8 },
  { slot: 13, name: 'beef', count: 56 }, { slot: 14, name: 'beef', count: 8 }, { slot: 15, name: 'bread', count: 1 }, { slot: 16, name: 'bread', count: 4 },
  { slot: 17, name: 'apple', count: 4 }, { slot: 18, name: 'rotten_flesh', count: 8 }, { slot: 19, name: 'water_bucket', count: 1 }, { slot: 20, name: 'bucket', count: 1 },
  { slot: 21, name: 'diamond_hoe', count: 1, damage: 0, maxDamage: 1561 }, { slot: 22, name: 'wheat_seeds', count: 32 },
  { slot: 23, name: 'diamond_helmet', count: 1, damage: 0, maxDamage: 363, enchanted: true, enchantments: [{ name: 'fire_protection', level: 4 }, { name: 'unbreaking', level: 3 }, { name: 'mending', level: 1 }] },
  { slot: 24, name: 'shield', count: 1, damage: 0, maxDamage: 336 }, { slot: 25, name: 'obsidian', count: 10 }, { slot: 26, name: 'flint_and_steel', count: 1, damage: 0, maxDamage: 64 },
  ...WORN.filter(i => i.name !== 'shield')
];

test.serial('F3: the setup\'s room at home with the pockets of Nov 14: the Nether kit kept and nothing of the home kit, 12 free and the golden helmet taken; the kit whole', async (t) => {
  const w = setupWorld();
  const f = game(w, { items: AT_THE_SETUP });
  t.is(36 - new Set(f.inv.filter(i => i.slot < 36).map(i => i.slot)).size, 9);
  // (the fake has no throw: what the caps send to the dump goes out of the pockets as the tool would)
  const act = f.ctx.act;
  (f.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool !== 'drop-item') return act(tool, a);
    let left = Number(a.count);
    for (const i of f.inv.filter(x => x.slot < 36 && x.name === a.item)) { const n = Math.min(left, i.count); i.count -= n; left -= n; }
    for (let i = f.inv.length - 1; i >= 0; i--) if (f.inv[i].count <= 0) f.inv.splice(i, 1);
    f.did.push(`drop ${a.item} x${Number(a.count) - left}`);
    return { ok: true, text: `Dropped ${Number(a.count) - left} ${a.item}` };
  }) as GoalContext['act'];
  t.is(await fetchSetupKit(f.ctx), undefined);
  const free = 36 - new Set(f.inv.filter(i => i.slot < 36).map(i => i.slot)).size;
  t.true(free >= 12, `${free} free`);
  t.is(f.did.filter(d => d.startsWith('take ')).at(-1), 'take golden_helmet x1');
  const has = (n: string) => f.inv.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
  // (the home kit's tools stay: put away, the kit goal would take them back at once and stop the trip at the chests)
  for (const [name, n] of [['obsidian', 10], ['flint_and_steel', 1], ['cobblestone', 55], ['cobbled_deepslate', 9], ['shield', 1], ['golden_helmet', 1], ['diamond_sword', 1],
    ['diamond_axe', 1], ['diamond_shovel', 1], ['diamond_hoe', 1], ['bread', 5], ['apple', 4], ['torch', 16]] as const) {
    t.is(has(name), n, name);
  }
  t.is(f.inv.filter(i => i.slot < 36 && i.name.endsWith('_pickaxe')).length, 2);
  for (const name of ['wheat_seeds', 'dirt', 'water_bucket', 'bucket', 'potato', 'beef', 'rotten_flesh', 'diamond_helmet']) {
    t.is(has(name), 0, name);
  }
  t.is(kit.wants(lookAt(f.inv, 1000), w), null, 'nothing the kit goal would stop the trip for');
});

test.serial('F3: the setup\'s kit eaten to full before its food is counted: a meal after the room, which keeps the trip\'s 40 points and no more, left it short', async (t) => {
  // the pockets of Nov 14 with a stack of bread, hungry by a bread's worth since the gate looked
  const w = setupWorld();
  const items = AT_THE_SETUP.filter(i => i.name !== 'bread').concat({ slot: 15, name: 'bread', count: 64 });
  const f = game(w, { items });
  const state = { food: 15 };
  const status = f.ctx.status;
  const act = f.ctx.act;
  (f.ctx as { status: GoalContext['status'] }).status = (async () => ({ ...(await status()), food: state.food })) as GoalContext['status'];
  (f.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool === 'eat') {
      const bread = f.inv.find(i => i.slot < 36 && i.name === 'bread');
      if (!bread || state.food >= 20) return { ok: true, text: 'Not hungry' };
      bread.count -= 1;
      if (!bread.count) f.inv.splice(f.inv.indexOf(bread), 1);
      state.food = Math.min(20, state.food + 5);
      f.did.push('eat bread');
      return { ok: true, text: 'Ate bread' };
    }
    if (tool !== 'drop-item') return act(tool, a);
    let left = Number(a.count);
    for (const i of f.inv.filter(x => x.slot < 36 && x.name === a.item)) { const n = Math.min(left, i.count); i.count -= n; left -= n; }
    for (let i = f.inv.length - 1; i >= 0; i--) if (f.inv[i].count <= 0) f.inv.splice(i, 1);
    return { ok: true, text: `Dropped ${Number(a.count) - left} ${a.item}` };
  }) as GoalContext['act'];
  t.is(await fetchSetupKit(f.ctx), undefined);
  t.is(f.did.indexOf('eat bread'), 0, 'the meal first, before anything is taken or put away');
  t.is(state.food, 20);
  const bread = f.inv.filter(i => i.slot < 36 && i.name === 'bread').reduce((a, i) => a + i.count, 0);
  t.true(bread * 5 >= 40, `${bread} bread`);
});

test.serial('the setup fed again just before it goes: the room\'s walks cost the points the first meal gave (live, Nov 15: "not setting out: food 17 < 18", twice), so it eats again and makes up the 40 points', async (t) => {
  const w = setupWorld();
  const items = AT_THE_SETUP.filter(i => i.name !== 'bread').concat({ slot: 15, name: 'bread', count: 64 });
  const f = game(w, { items });
  // full at the start; every walk of the room (a store, a throw at the dump spot) costs a point of food
  const state = { food: 20 };
  const status = f.ctx.status;
  const act = f.ctx.act;
  (f.ctx as { status: GoalContext['status'] }).status = (async () => ({ ...(await status()), food: state.food })) as GoalContext['status'];
  (f.ctx as { act: GoalContext['act'] }).act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool === 'eat') {
      const bread = f.inv.find(i => i.slot < 36 && i.name === 'bread');
      if (!bread || state.food >= 20) return { ok: true, text: 'Not hungry' };
      bread.count -= 1;
      if (!bread.count) f.inv.splice(f.inv.indexOf(bread), 1);
      state.food = Math.min(20, state.food + 5);
      f.did.push('eat bread');
      return { ok: true, text: 'Ate bread' };
    }
    if (tool === 'store-in-chest' || tool === 'drop-item') { state.food = Math.max(17, state.food - 1); f.did.push(`room walk: ${tool}`); }
    if (tool !== 'drop-item') return act(tool, a);
    let left = Number(a.count);
    for (const i of f.inv.filter(x => x.slot < 36 && x.name === a.item)) { const n = Math.min(left, i.count); i.count -= n; left -= n; }
    for (let i = f.inv.length - 1; i >= 0; i--) if (f.inv[i].count <= 0) f.inv.splice(i, 1);
    return { ok: true, text: `Dropped ${Number(a.count) - left} ${a.item}` };
  }) as GoalContext['act'];
  // nothing short (the kit's check counts the 40 food points too), and the meal came after the room's walks
  t.is(await fetchSetupKit(f.ctx), undefined);
  const meal = f.did.indexOf('eat bread');
  t.true(meal >= 0, f.did.join(' | '));
  t.true(f.did.slice(0, meal).some(d => /^room walk:/.test(d)), 'the meal after the room');
  t.true(state.food >= 18, `food ${state.food}`);
});

test('F3: the ground judged whole: lava in the ring round a hut that the read did not cover (the old re-plan read 2 round it, the ring goes 4 under) is never taken for clear; read as wide as the judgement, the lava itself', (t) => {
  const hut = hutOf({ x: 0, y: 70, z: 0, axis: 'x', side: 1, door: 0 });
  const have = { cobblestone: 64, obsidian: 10 };
  const why = (g: Grid) => { const r = judgeHut(g, hut, have); return 'why' in r ? r.why : 'fine'; };
  // 3 under the frame's ground: within the drop the bot could fall and one more, outside grow(box, 2)
  const lava = { x: 1, y: hut.box.y1 - 3, z: 1 };
  const get = flat({ [k(lava)]: 'lava' });
  t.false(inBox(grow(hut.box, 2), lava));
  t.true(inBox(judgedBox(hut), lava));
  t.is(why(gridOf(get, grow(hut.box, 2))), 'not all loaded round it');
  t.is(why(gridOf(get, judgedBox(hut))), 'lava or fire by it');
  // a cell of the ring not loaded (null) is never clear either; all of it read and no lava: fine
  const g = gridOf(flat(), judgedBox(hut));
  t.is(why(g), 'fine');
  t.is(why({ ...g, blocks: g.blocks.map((b, i) => (i === 0 ? null : b)) }), 'not all loaded round it');
});

test('F3: a spot whose ring a chunk not in yet hides (lava under it, unread): refused at the first judgement, another chosen with its ring read whole', (t) => {
  // the open floor (the cliff gone), the community's room out of the way: spots enough; the one chosen there first
  const nr = netherGround();
  const floor = (p: Pos) => (p.y > 69 && p.y < 90 && p.x <= -77 && p.x > -110 ? 'air' : nr(p));
  const first = chooseHut(view(floor, { zones: [] }));
  if (!('plan' in first)) return t.fail(first.why);
  const best = first.plan.hut.spot;
  // lava 3 under its frame's ground, in a pocket of cells not loaded at the first read
  const lava = { x: best.x, y: first.plan.hut.box.y1 - 3, z: best.z };
  t.true(inBox(judgedBox(first.plan.hut), lava));
  const v = view(p => (k(p) === k(lava) ? 'lava' : floor(p)), { zones: [] });
  const hidden = (p: Pos) => Math.abs(p.x - lava.x) <= 1 && Math.abs(p.y - lava.y) <= 1 && Math.abs(p.z - lava.z) <= 1;
  const g = v.grid;
  const at = (i: number): Pos => ({ x: g.x + (i % g.width), y: g.y + Math.floor(i / (g.width * g.length)), z: g.z + (Math.floor(i / g.width) % g.length) });
  const blind = { ...g, blocks: g.blocks.map((b, i) => (hidden(at(i)) ? null : b)) };
  t.like(judgeHut(blind, hutOf(best), { cobblestone: 64, obsidian: 10 }), { why: 'not all loaded round it' });
  const c = chooseHut({ ...v, grid: blind });
  if (!('plan' in c)) return t.fail(c.why);
  t.notDeepEqual(c.plan.hut.spot, best);
  t.false(inBox(judgedBox(c.plan.hut), lava), c.why);
});

test('F3: chooseHut never takes a spot refused before, not even as the spot chosen before', (t) => {
  const best = { x: -79, y: 70, z: 266, axis: 'z' as const, side: 1 as const, door: 1 as const };
  const c = chooseHut(view(netherGround(), { refused: [best] }), best);
  if (!('plan' in c)) return t.fail(c.why);
  t.notDeepEqual(c.plan.hut.spot, best);
  t.notRegex(c.why, /chosen before/);
  // the same portal turned another way round is another spot
  t.notDeepEqual(c.plan.hut.spot, best);
  t.like(chooseHut(view(netherGround(), { refused: [{ ...best, door: 0 }] })), { plan: { hut: { spot: best } } });
});

test.serial('F3: a look again on the spot that finds lava by it (come since the first judgement) refuses that spot for good: let go, remembered, and the next trip builds elsewhere though the lava is gone', async (t) => {
  const w = setupWorld();
  const f = game(w);
  const lava = { x: -74, y: 71, z: 264 };
  let failed = false;
  const call = f.ctx.call;
  (f.ctx as { call: GoalContext['call'] }).call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) => {
    // the first dig fails as live ("out of reach or out of sight"), and lava by the hut from then on
    if (m === 'dig.here' && f.state.dim === NETHER && !failed) { failed = true; return { dug: false, reason: 'out of reach or out of sight' }; }
    const got = await call(m, p, ms) as { blocks?: (string | null)[] };
    if (m === 'world.region' && f.state.dim === NETHER && failed) {
      const x0 = Number(p.x), y0 = Number(p.y), z0 = Number(p.z), wd = Number(p.width), ln = Number(p.length);
      got.blocks = got.blocks!.map((b, i) => (x0 + (i % wd) === lava.x && y0 + Math.floor(i / (wd * ln)) === lava.y && z0 + (Math.floor(i / wd) % ln) === lava.z ? 'minecraft:lava' : b));
    }
    return got;
  }) as GoalContext['call'];
  const r = await setupRun(f.ctx, HOUR, () => T0);
  t.deepEqual(r, { gain: 0, text: 'the hut at nether (-79, 70, 266) could not be built: lava or fire by it; that spot refused for good' });
  t.true(f.said.some(l => /^nether: the hut at nether \(-79, 70, 266\): could not dig at .*: out of reach or out of sight: looking again$/.test(l)), f.said.join(' | '));
  t.true(f.said.includes('nether: its own portal\'s spot at nether (-79, 70, 266) refused: lava or fire by it'));
  const n = peekNether(w);
  t.is(n.setupSpot, undefined, 'let go: not the spot chosen before');
  t.deepEqual(n.refusedSpots, [{ x: -79, y: 70, z: 266, axis: 'z', side: 1, door: 1, why: 'lava or fire by it', at: T0 }]);
  // kept in brain.json as it is; what is not a spot is dropped
  t.deepEqual(peekNether({ ...w, nether: JSON.parse(JSON.stringify(w.nether)) }).refusedSpots, n.refusedSpots);
  const bad: unknown[] = [{ x: 1, y: 2, z: 3, axis: 'y', side: 1, door: 0, at: 1 }, 'x', { ...n.refusedSpots![0], at: 'now' }];
  t.is(peekNether({ ...w, nether: { refusedSpots: bad } as unknown as WorldMemory['nether'] }).refusedSpots, undefined);
  // the next trip, the lava gone (a fire burnt out): not that spot again, not as the spot chosen before
  const g = game(w, { items: f.inv, after: f, now: T0 + 2 * HOUR });
  const r2 = await setupRun(g.ctx, HOUR, () => T0 + 2 * HOUR);
  const chose = g.said.find(l => l.startsWith('nether: its own portal goes at '));
  t.truthy(chose, `${r2.text} | ${g.said.join(' | ')}`);
  t.false(chose!.includes('(-79, 70, 266)'), chose);
  t.false(chose!.includes('(chosen before)'), chose);
  t.regex(r2.text, /^its own portal at nether \(-?\d+, \d+, \d+\), linked with the home portal$/, g.said.join(' | '));
  t.notDeepEqual(peekNether(w).portal, { x: -79, y: 70, z: 266 });
  t.truthy(peekNether(w).portal);
});
