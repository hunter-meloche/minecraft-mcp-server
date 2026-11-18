import test from 'ava';
import type { InventoryItem } from '../../src/client/tools.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import {
  BRANCH_GAP, BRANCH_LONG, DEBRIS_WANT, MOUTH_RADIUS, SPIRAL_SIDE, TRUNKS, TRUNK_LEVEL, TUNNEL_BAND, TUNNEL_RADIUS, TUNNEL_TRIP, TUNNEL_WAITS,
  baredDebris, chooseMouth, debrisHome, lavaAhead, nextHeadings, stepFault, stepOf, tunnelCells, tunnelOpen, tunnelOpenAt, tunnelPlan, tunnelReady, tunnelRun, tunnelsFor, wayTo,
  type TunnelView
} from '../../src/client/brain/nethertunnel.js';
import { BARTER_WAITS, LAVA_GAP, barterGround } from '../../src/client/brain/netherbarter.js';
import { DEBRIS, DEBRIS_WAITS, EFFECT_LEAST_S } from '../../src/client/brain/netherdebris.js';
import { FROM_BUILDS, SETUP_WAITS, boxGap, boxOf, grow, zoneBox, type Box } from '../../src/client/brain/nethersetup.js';
import { BEARINGS, NETHER, OVERWORLD, TUNNELS_KEPT, netherLine, netherOf, peekNether, portalCells, stageNeeds, type Bearing, type Tunnel } from '../../src/client/brain/nether.js';
import { LADDER, NETHER_WORK } from '../../src/client/brain/worktasks.js';
import { workGoals, workOf } from '../../src/client/brain/work.js';
import { T0, lookAt } from '../helpers/homestead.js';
import { ROOM_ZONE, game, gridOf, k, setupWorld, type Mob } from '../helpers/netherworld.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
SETUP_WAITS.pollMs = 0;
SETUP_WAITS.loadMs = 0;
BARTER_WAITS.pollMs = 0;
DEBRIS_WAITS.pollMs = 0;
TUNNEL_WAITS.pollMs = 0;

const at = (x: number, y: number, z: number): Pos => ({ x, y, z });
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
const rung = (now = T0) => workGoals(() => undefined, LADDER, () => now).find(g => g.name === 'work: nether')!;
type Game = ReturnType<typeof game>;
type Blocks = [Pos, string][];

/** The gear chest (the golden helmet; the potions put here) and the ores. */
const GEAR = '-547,64,2182';
const ORES = '-547,63,2180';
/** Its own Nether-side portal where the setup trip builds it in the test Nether (dug into the cliff, its door east at z 267). */
const OWN_BOX: Box = { x1: -79, y1: 70, z1: 266, x2: -79, y2: 72, z2: 267 };

/** The fire gear worn (D1): the golden helmet with fire protection 4 over the main set's protection 4 (20 EPF against fire). */
const SET: InventoryItem[] = ['diamond_boots', 'diamond_leggings', 'diamond_chestplate', 'golden_helmet'].map((name, i) =>
  ({ slot: 36 + i, name, count: 1, enchantments: [{ name: name === 'golden_helmet' ? 'fire_protection' : 'protection', level: 4 }] }));
const dressed = (items: InventoryItem[]): InventoryItem[] => [...items.filter(i => i.slot < 36 || i.slot === 40), ...SET.map(i => ({ ...i }))];

/** Potions of fire resistance (by their contents) in the gear chest, by their stacks as the memory has them. */
function stock(w: WorldMemory, potions: string[]) {
  w.chestStacks = { ...(w.chestStacks ?? {}), [GEAR]: potions.map((potion, i) => ({ slot: 40 + i, name: 'potion', count: 1, potion })) };
  if (potions.length) w.chestItems![GEAR].potion = potions.length;
  else delete w.chestItems![GEAR].potion;
}
/** Every bearing scouted an hour before `when` (the scouting declines). */
function scouted(w: WorldMemory, when: number) {
  netherOf(w).legs = BEARINGS.map((b, i) => ({ bearing: b.name as Bearing, at: when - HOUR + i, reach: 96, end: "the leg's 96 walked", way: [] }));
}

/**
 * The setup trip run through (its hut built, its portal lit, linked), then stage 3 as six clean trips open it, on game
 * day 7, the quartz at its target, no gold over the barter's reserve, every bearing scouted an hour ago, the potions in
 * the gear chest (a long one and a plain one), the open-face debris dry (26.3 bares none: the rung's turn is the
 * tunnel's); and a game of the world as it left it, two hours on, the Nether set worn, with `blocks` in the Nether.
 */
async function atStage3(blocks: Blocks = [], opts: Parameters<typeof game>[1] = {}, potions = ['long_fire_resistance', 'fire_resistance']) {
  const w = setupWorld();
  const first = game(w);
  await rung().run(first.ctx);
  Object.assign(netherOf(w), { stage: 3, stageTrips: 6, cleanTrips: 6 });
  w.idle = { today: { day: 7 } as never, days: [] };
  w.chestItems![ORES].quartz = 64;
  const later = T0 + 2 * HOUR;
  scouted(w, later);
  stock(w, potions);
  workOf(w).dry['nether:debris'] = { n: 1, at: later };
  const changed = [...first.changed, ...blocks.map(([p, to]) => ({ dim: NETHER as typeof NETHER, at: p, to, how: 'test' }))];
  const f = game(w, { items: dressed(first.inv), after: { changed, lit: first.lit }, now: later, ...opts });
  return { w, first, later, f };
}
/** The same world a trip on: what the trip before dug and placed down there stands. */
function nextTrip(w: WorldMemory, f: Game, first: Game, later: number, opts: Parameters<typeof game>[1] = {}) {
  return game(w, { items: f.inv, after: { changed: [...first.changed, ...f.changed], lit: first.lit }, now: later, ...opts });
}

const netherWalks = (f: Game) => f.walks.filter(x => x.dim === NETHER);
const carried = (f: Game, n: string) => f.inv.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
/** What the trip dug or placed down there (the setup's and the test's own excepted). */
const dugHere = (f: Game) => f.changed.filter(c => c.dim === NETHER && c.how !== 'test' && /^dug/.test(c.how));
const once = (get: () => Game | undefined, after: RegExp, then: (f: Game) => void) => {
  let done = false;
  return () => { const f = get(); if (!done && f && f.did.some(d => after.test(d))) { done = true; then(f); } };
};

/** The trunk a fresh trip digs in the test Nether (see the first test): its mouth, the stair's foot, its level part's line. */
const MOUTH = at(-74, 70, 265);
const LEVEL_X = -70;
/** Debris by the trunk's level part: one in its west wall at the feet, one in its east wall at the head, one over the head; one in its floor, one with lava 2 off. */
const WALL = at(-71, 15, 270);
const HEAD = at(-69, 16, 272);
const ROOF = at(-70, 17, 274);
const FLOOR = at(-70, 14, 276);
const HOT = at(-71, 16, 280);
const DEBRIS_FIELD: Blocks = [[WALL, DEBRIS], [HEAD, DEBRIS], [ROOF, DEBRIS], [FLOOR, DEBRIS], [HOT, DEBRIS], [at(-73, 16, 280), 'lava']];

/** Every walk down there careful, 16 from the community's room, none within 2 of lava. */
function walkedKindly(t: { true: (v: boolean, m?: string) => void }, f: Game) {
  for (const x of netherWalks(f)) {
    t.true(x.careful, k(x.to));
    t.true(boxGap(zoneBox(ROOM_ZONE), cellBox(x.to)) >= FROM_BUILDS, `${k(x.to)} by the room`);
    for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) for (let dy = -1; dy <= 1; dy++) {
      t.true(!/^lava/.test(f.get(NETHER, { x: x.to.x + dx, y: x.to.y + dy, z: x.to.z + dz })), `${k(x.to)} by lava`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ a ground for the pure rules

/** Netherrack all round (y 1 to 126), with `blocks` set: a grid of it round a point. */
function rock(blocks: Blocks, centre: Pos = at(0, 15, 0), r = 10): ReturnType<typeof gridOf> {
  const m = new Map(blocks.map(([p, b]) => [k(p), b]));
  return gridOf(p => m.get(k(p)) ?? 'netherrack', { x1: centre.x - r, y1: Math.max(1, centre.y - r), z1: centre.z - r, x2: centre.x + r, y2: centre.y + r, z2: centre.z + r });
}
const PORTAL: Box = { x1: 0, y1: 60, z1: -30, x2: 0, y2: 62, z2: -29 };
const view = (over: Partial<TunnelView> = {}): TunnelView => ({ portal: PORTAL, zones: [], placed: [], own: new Set(), ...over });
/** A tunnel's open cells as air (a level one along +x at y 15 from x -3 to 0). */
const LEVEL: Tunnel = { start: at(-3, 15, 0), head: 'e', way: 'eee' };
const opened = (t: Tunnel): Blocks => [...tunnelOpen([t])].map(s => { const [x, y, z] = s.split(',').map(Number); return [at(x, y, z), 'air']; });

// ------------------------------------------------------------------------------------------------ the gate

test.serial('the stage gate: the tunnelling opens at stage 3 (its own ready asks a potion in stock, as the debris does); not before, not unlinked, not without its own portal', async (t) => {
  t.deepEqual(stageNeeds('tunnel'), { stage: 3, potions: 0 });
  t.true(NETHER_WORK.some(v => v.id === 'tunnel' && v.stage === 3));
  const { w, later, f } = await atStage3();
  t.true(tunnelOpenAt(w));
  const s = lookAt(f.inv, 1000, { now: later });
  t.is(tunnelReady(s, w), null);
  t.is(rung(later).wants(s, w), 'tunnel: in the nether');
  for (const [what, edit] of [['stage 2', (x: WorldMemory) => { netherOf(x).stage = 2; }], ['not linked', (x: WorldMemory) => { netherOf(x).linked = false; }],
    ['no portal of its own', (x: WorldMemory) => { delete netherOf(x).portal; }]] as const) {
    const c = structuredClone(w);
    edit(c);
    t.false(tunnelOpenAt(c), what);
  }
  // its gates write nothing
  const before = JSON.stringify(w);
  tunnelReady(s, w);
  tunnelOpenAt(w);
  rung(later).wants(s, w);
  t.is(JSON.stringify(w), before);
});

test.serial('ready: no potion in stock shuts it; the fire gear short of 20 EPF against fire; the debris enough at home (its scrap, ingots and netherite counted); a piglin\'s hold; every tunnel shut with no room for more', async (t) => {
  const { w, later, f } = await atStage3();
  const s = lookAt(f.inv, 1000, { now: later });
  const none = structuredClone(w);
  stock(none, []);
  t.deepEqual(tunnelReady(s, none), { cause: 'kit', text: 'tunnelling shut: no potion of fire resistance in stock (carried or in the chests)' });
  const plain = lookAt(f.inv.map(i => (i.slot >= 36 && i.slot <= 38 ? { ...i, enchantments: [] } : i)), 1000, { now: later });
  t.deepEqual(tunnelReady(plain, w), {
    cause: 'kit',
    text: 'tunnelling: the fire gear is short: fire EPF 8 < 20 (the diamond_chestplate has protection 0 (4 wanted); the diamond_leggings has protection 0 (4 wanted); the diamond_boots has protection 0 (4 wanted)) (it tunnels only in it)'
  });
  const fp3 = lookAt(f.inv.map(i => (i.slot === 39 ? { ...i, enchantments: [{ name: 'fire_protection', level: 3 }] } : i)), 1000, { now: later });
  t.like(tunnelReady(fp3, w), { cause: 'kit', text: 'tunnelling: the fire gear is short: fire EPF 18 < 20 (the golden_helmet has fire_protection 3 (4 wanted)) (it tunnels only in it)' });
  const unenchanted = lookAt(f.inv.map(i => (i.slot === 39 ? { ...i, enchantments: [] } : i)), 1000, { now: later });
  t.like(tunnelReady(unenchanted, w), { cause: 'kit', text: 'tunnelling: the fire gear is short: fire EPF 12 < 20 (the golden_helmet has fire_protection 0 (4 wanted)) (it tunnels only in it)' });
  const rich = structuredClone(w);
  Object.assign(rich.chestItems![ORES], { ancient_debris: 2, netherite_scrap: 2, netherite_ingot: 1 });
  rich.chestItems![GEAR].netherite_chestplate = 1;
  t.is(debrisHome(s, rich), 2 + 2 + 4 + 4);
  t.is(tunnelReady(s, rich), null, '12 of 16');
  rich.chestItems![ORES].netherite_ingot = 2;
  t.deepEqual(tunnelReady(s, rich), { cause: 'stocked', text: `tunnelling: ancient debris enough at home (16/${DEBRIS_WANT}, its scrap and netherite counted)` });
  const held = structuredClone(w);
  netherOf(held).barter = { held: { day: 7, at: later, why: 'a piglin turned aggressive at nether (-70, 70, 260)' } };
  t.like(tunnelReady(s, held), { cause: 'hold', text: 'tunnelling held for the day: a piglin turned aggressive at nether (-70, 70, 260)' });
  const full = structuredClone(w);
  netherOf(full).tunnels = { portal: { ...netherOf(full).portal! }, list: Array.from({ length: TRUNKS }, (_, i) => ({ start: at(-70 + 10 * i, 70, 250), head: 'n' as const, way: 'NNN', shut: 'lava within 2 ahead' })) };
  t.deepEqual(tunnelReady(s, full), { cause: 'unneeded', text: `tunnelling: every one of its ${TRUNKS} tunnels shut, and no room for more` });
});

// ------------------------------------------------------------------------------------------------ the shape

test('a step: level digs the two ahead (head, then feet); down digs the three ahead from the head down and lands a block lower; the tunnel\'s cells and its open ones follow its way', (t) => {
  t.deepEqual(stepOf(at(0, 15, 0), 'e', false), { dig: [at(1, 16, 0), at(1, 15, 0)], to: at(1, 15, 0) });
  t.deepEqual(stepOf(at(0, 40, 0), 'n', true), { dig: [at(0, 41, -1), at(0, 40, -1), at(0, 39, -1)], to: at(0, 39, -1) });
  const tt: Tunnel = { start: at(0, 40, 0), head: 'n', way: 'Nw' };
  t.deepEqual(tunnelCells(tt), [at(0, 40, 0), at(0, 39, -1), at(-1, 39, -1)]);
  t.deepEqual([...tunnelOpen([tt])].sort(), ['0,40,0', '0,41,0', '0,41,-1', '0,40,-1', '0,39,-1', '-1,40,-1', '-1,39,-1'].sort());
});

test('the stair winds down round a 4x4 column of rock: three steps down a side, then right; at the band it runs level; a branch only straight on', (t) => {
  // on plain rock: the headings it would take, step after step, from y 40 heading east
  const tt: Tunnel = { start: at(0, 40, 0), head: 'e', way: '' };
  for (let i = 0; i < 12; i++) {
    const cells = tunnelCells(tt);
    const f = cells[cells.length - 1];
    tt.way += nextHeadings(tt, f)[0].toUpperCase();
  }
  t.is(tt.way, 'EEESSSWWWNNN');
  const cells = tunnelCells(tt);
  t.deepEqual(cells[12], at(0, 28, 0), 'a loop comes round over its start, 12 lower');
  t.true(cells.every(c => c.x >= 0 && c.x <= 3 && c.z >= 0 && c.z <= 3), 'within 4x4');
  t.deepEqual(nextHeadings(tt, at(0, 28, 0)), ['e', 'n', 'w'], 'after three north: right (east), else straight, else left');
  t.deepEqual(nextHeadings({ head: 's', way: 'sss' }, at(0, 15, 3)), ['s', 'w', 'e'], 'level: straight on, then right, then left');
  t.deepEqual(nextHeadings({ head: 'e', way: 'eee', from: 0 }, at(3, 15, 0)), ['e'], 'a branch: straight only');
  t.is(SPIRAL_SIDE, 3);
});

test('stepFault: plain rock will do; lava or fire within 2 ahead (and 3 under where it lands), a cave ahead or beside, a drop under the next cell, gravel over it, magma, gold ore, someone\'s cobblestone by it, a zone within 16, its hut, past 48 from its portal, its own tunnel ahead', (t) => {
  const g0 = rock(opened(LEVEL));
  const f = at(0, 15, 0);
  const v = view({ own: tunnelOpen([LEVEL]) });
  t.is(stepFault(g0, f, 'e', false, v), null);
  const fault = (blocks: Blocks, over: Partial<TunnelView> = {}, h: 'e' | 'n' = 'e', down = false, from = f) => stepFault(rock([...opened(LEVEL), ...blocks]), from, h, down, { ...v, ...over });
  t.is(fault([[at(3, 16, 1), 'lava']]), `lava within ${LAVA_GAP} ahead at nether (3, 16, 1)`);
  t.is(fault([[at(4, 15, 0), 'lava']]), null, 'three ahead: not yet');
  t.is(fault([[at(1, 12, 0), 'lava']]), `lava within ${LAVA_GAP} ahead at nether (1, 12, 0)`, 'three under where it lands');
  t.is(fault([[at(1, 13, 2), 'fire']]), `lava within ${LAVA_GAP} ahead at nether (1, 13, 2)`);
  t.is(fault([[at(1, 15, 0), 'air']]), 'a cave ahead at nether (1, 15, 0)');
  t.is(fault([[at(1, 15, 1), 'air']]), 'a cave beside the way at nether (1, 15, 1)');
  t.is(fault([[at(1, 17, 0), 'air']]), 'a cave beside the way at nether (1, 17, 0)');
  t.is(fault([[at(1, 14, 0), 'air']]), 'a drop ahead at nether (1, 14, 0)');
  t.is(fault([[at(1, 17, 0), 'gravel']]), 'gravel over the way at nether (1, 17, 0) (it falls)');
  t.is(fault([[at(1, 14, 0), 'magma_block']]), 'magma under the way at nether (1, 14, 0)');
  t.is(fault([[at(1, 15, 0), 'nether_gold_ore']]), 'nether_gold_ore ahead at nether (1, 15, 0) (it tunnels through netherrack, basalt and blackstone only)');
  t.is(fault([[at(1, 15, 0), 'soul_sand']]), 'soul_sand ahead at nether (1, 15, 0) (it tunnels through netherrack, basalt and blackstone only)');
  for (const b of ['basalt', 'blackstone', 'nether_quartz_ore', DEBRIS]) t.is(fault([[at(1, 15, 0), b]]), null, b);
  t.is(fault([[at(3, 16, 0), 'cobblestone']], { placed: [at(3, 16, 0)] }), 'someone\'s cobblestone by the way at nether (3, 16, 0)');
  t.is(fault([], { zones: [{ x1: 10, y1: 10, z1: -5, x2: 20, y2: 20, z2: 5 }] }), `within ${FROM_BUILDS} of someone's build or a natural structure`);
  t.is(fault([], { zones: [{ x1: 17, y1: 10, z1: -5, x2: 20, y2: 20, z2: 5 }] }), null, '16 off');
  t.is(fault([], { portal: { x1: 4, y1: 14, z1: 0, x2: 4, y2: 16, z2: 1 } }), 'its own hut\'s, or the ground its portal stands on');
  t.is(fault([], { portal: { x1: -50, y1: 60, z1: 0, x2: -48, y2: 62, z2: 1 } }), `${TUNNEL_RADIUS} from its portal`);
  t.is(fault([], {}, 'e', false, at(-4, 15, 0)), 'its own tunnel ahead at nether (-3, 16, 0)');
  // its own tunnel beside is no cave (one along z 1 beside the next cells), and a branch off the level tunnel's middle digs on
  const beside: Tunnel = { start: at(-3, 15, 1), head: 'e', way: 'eeee' };
  t.is(fault(opened(beside), { own: tunnelOpen([LEVEL, beside]) }), null);
  t.is(fault(opened(beside)), 'a cave beside the way at nether (1, 16, 1)');
  t.is(fault([], {}, 'n', false, at(-1, 15, 0)), null);
  // the hole a debris it dug left is its own too
  t.is(fault([[at(1, 15, 1), 'air']], { holes: new Set(['1,15,1']) }), null);
  // down a stair: the third over the head, and lava three under where it lands
  const up = at(0, 40, 0);
  const standing: Blocks = [[up, 'air'], [at(0, 41, 0), 'air']];
  t.is(stepFault(rock(standing, up), up, 'n', true, view()), null, 'the cells it stands in are no cave');
  t.is(stepFault(rock([...standing, [at(1, 41, -1), 'air']], up), up, 'n', true, view()), 'a cave beside the way at nether (1, 41, -1)', 'by the third, over the head');
  t.is(stepFault(rock([...standing, [at(0, 38, -1), 'air']], up), up, 'n', true, view()), 'a drop ahead at nether (0, 38, -1)', 'no floor where it lands');
  t.is(lavaAhead(rock([[at(0, 36, -1), 'lava']], up), stepOf(up, 'n', true).dig, at(0, 39, -1)), `lava within ${LAVA_GAP} ahead at nether (0, 36, -1)`);
});

test('the debris a step bares: in its walls, over its head, ahead; never one in its floor, none with lava within 2, none under gravel, none 16 from a build', (t) => {
  const dig = stepOf(at(0, 15, 0), 'e', false).dig;
  const g = rock([...opened(LEVEL), [at(1, 15, 1), DEBRIS], [at(1, 16, -1), DEBRIS], [at(1, 17, 0), DEBRIS], [at(2, 16, 0), DEBRIS], [at(1, 14, 0), DEBRIS],
    [at(1, 15, -1), DEBRIS], [at(1, 13, -3), 'lava']]);
  for (const c of dig) g.blocks[(c.x - g.x) + (c.z - g.z) * g.width + (c.y - g.y) * g.width * g.length] = 'minecraft:air';
  const floors = new Set([...tunnelCells(LEVEL), at(1, 15, 0)].map(c => k(at(c.x, c.y - 1, c.z))));
  const r = baredDebris(g, dig, floors, { zones: [], placed: [] });
  t.deepEqual(r.ores.map(k).sort(), ['1,15,1', '1,16,-1', '1,17,0', '2,16,0'].sort());
  t.deepEqual([...r.faults].sort(), [['lava or fire within 2', 1], ['under its tunnel\'s floor', 1]].sort());
  const zoned = baredDebris(g, dig, floors, { zones: [{ x1: 1, y1: 32, z1: 0, x2: 2, y2: 33, z2: 1 }], placed: [] });
  t.deepEqual(zoned.ores.map(k).sort(), ['1,15,1', '1,16,-1', '2,16,0'].sort(), '16 from the zone over it');
  t.deepEqual([...zoned.faults].find(([why]) => /someone/.test(why)), [`within ${FROM_BUILDS} of someone's build`, 1]);
});

// ------------------------------------------------------------------------------------------------ the plan

test('the plan: a tunnel still going on first (the nearest); else a branch every 4 blocks of a trunk\'s level part, left and right (the nearest first); else a new trunk while it has fewer than 4; a way cut by lava is let be', (t) => {
  // a trunk: 3 steps down from y 18, then 9 level north
  const trunk: Tunnel = { start: at(0, 18, 0), head: 'n', way: 'NNNnnnnnnnnn' };
  t.deepEqual(tunnelCells(trunk).at(-1), at(0, 15, -12));
  t.like(tunnelPlan([trunk]), { do: 'on', i: 0 });
  const shut = { ...trunk, shut: 'its 32 blocks dug' };
  // level from index 4 (the first cell level with the one before); branches at 6 and 10, west then east
  const p = tunnelPlan([shut]);
  t.like(p, { do: 'branch', from: 0, at: 6, head: 'w' });
  t.deepEqual(p && 'way' in p ? p.way.at(-1)!.p : undefined, at(0, 15, -6));
  const west: Tunnel = { start: at(0, 15, -6), head: 'w', way: 'www', from: 0, shut: 'lava within 2 ahead' };
  t.like(tunnelPlan([shut, west]), { do: 'branch', at: 6, head: 'e' });
  const east: Tunnel = { start: at(0, 15, -6), head: 'e', way: 'e', from: 0 };
  t.like(tunnelPlan([shut, west, east]), { do: 'on', i: 2 });
  t.deepEqual(wayTo([shut, west, east], 2)!.map(c => k(c.p)), [...tunnelCells(trunk).slice(0, 7), at(1, 15, -6)].map(k));
  const both = [shut, west, { ...east, shut: 'a cave ahead' }];
  t.like(tunnelPlan(both), { do: 'branch', at: 10, head: 'w' });
  // a way that will not do (`fits`) is passed: the next
  t.like(tunnelPlan(both, w => w.length < 8), { do: 'trunk' });
  // the trunk cut at its 5th cell: no branch past it, nothing on it
  t.like(tunnelPlan([{ ...shut, cut: 5 }]), { do: 'trunk' });
  t.is(wayTo([{ ...shut, cut: 5 }], 0), undefined);
  // four trunks shut with no level part: nothing left
  const dead = Array.from({ length: TRUNKS }, (_, i): Tunnel => ({ start: at(10 * i, 40, 0), head: 'n', way: 'NN', shut: 'lava within 2 ahead' }));
  t.is(tunnelPlan(dead), undefined);
  t.is(BRANCH_GAP, 4);
  t.is(tunnelPlan(Array.from({ length: TUNNELS_KEPT }, (): Tunnel => ({ ...shut }))), undefined, 'no room for more');
});

test('the mouth: on the ground by its portal (12 at most, off its hut), 8 from another trunk\'s, the nearest walk first, a heading whose first four steps down read safe', (t) => {
  // flat netherrack at y 69, open over it; its portal at x 0
  const flat = gridOf(p => (p.y <= 69 ? 'netherrack' : 'air'), { x1: -30, y1: 55, z1: -30, x2: 30, y2: 90, z2: 30 });
  const portal: Box = { x1: 0, y1: 70, z1: 0, x2: 0, y2: 72, z2: 1 };
  const may = barterGround(flat, portal, [], MOUTH_RADIUS + 4);
  const v = { portal, zones: [], placed: [], own: new Set<string>() };
  const m = chooseMouth(flat, at(2, 70, 0), may, [], v);
  t.true('mouth' in m);
  if (!('mouth' in m)) return;
  t.true(boxGap(portal, cellBox(m.mouth)) > 5, 'off its hut');
  t.true(Math.max(Math.abs(m.mouth.x), Math.abs(m.mouth.z)) <= MOUTH_RADIUS + 1);
  t.deepEqual(m.walk[0], at(2, 70, 0));
  t.deepEqual(m.walk.at(-1), m.mouth);
  // another trunk's mouth there: 8 from it
  const m2 = chooseMouth(flat, at(2, 70, 0), may, [{ start: m.mouth, head: m.head, way: 'EEE', shut: 'x' }], v);
  t.true('mouth' in m2 && Math.max(Math.abs(m2.mouth.x - m.mouth.x), Math.abs(m2.mouth.z - m.mouth.z)) >= 8);
  // lava a block under the floor everywhere: none
  const hot = gridOf(p => (p.y === 66 ? 'lava' : p.y <= 69 ? 'netherrack' : 'air'), { x1: -30, y1: 55, z1: -30, x2: 30, y2: 90, z2: 30 });
  const none = chooseMouth(hot, at(2, 70, 0), barterGround(hot, portal, [], MOUTH_RADIUS + 4), [], v);
  t.true('why' in none && /^no (mouth for a tunnel|ground it may walk) within 12 of its portal/.test(none.why), JSON.stringify(none));
});

// ------------------------------------------------------------------------------------------------ the trip

test.serial('a tunnel trip from scratch: a trunk from the ground by its hut, wound down to y 15 and on level 32, then branches every 4 blocks; the potion drunk at the face; the debris it bares in the walls and over the head mined with the diamond pickaxe and picked up, the one in its floor and the one by lava left; the tunnels kept; home', async (t) => {
  const { w, later, f } = await atStage3(DEBRIS_FIELD);
  t.is(rung(later).wants(lookAt(f.inv, 1000, { now: later }), w), 'tunnel: in the nether');
  const text = await rung(later).run(f.ctx);
  t.is(text, '[tunnel] tunnelled 159 blocks: 3 ancient debris mined, 3 picked up; as much of its tunnels as one trip digs; back at overworld (-562, 65, 2191); back home');
  t.deepEqual(f.said.filter(l => /^(nether|tunnel): /.test(l)), [
    'nether: through the portal at overworld (-562, 63, 2191) -> nether (-79, 70, 267)',
    'tunnel: a new trunk from nether (-74, 70, 265), heading east and down',
    "tunnel: drank a potion of long_fire_resistance at the tunnel's face at nether (-74, 70, 265): 8:00 of fire resistance",
    'tunnel: tunnel 1 (a trunk) shut at nether (-70, 15, 294): its 32 blocks dug',
    'tunnel: a branch east off tunnel 1 at nether (-70, 15, 265)',
    'tunnel: tunnel 2 (a branch of tunnel 1) shut at nether (-46, 15, 265): its 24 blocks dug',
    'tunnel: a branch west off tunnel 1 at nether (-70, 15, 265)',
    'tunnel: tunnel 3 (a branch of tunnel 1) shut at nether (-94, 15, 265): its 24 blocks dug',
    'tunnel: a branch east off tunnel 1 at nether (-70, 15, 269)',
    'tunnel: tunnel 4 (a branch of tunnel 1) shut at nether (-46, 15, 269): its 24 blocks dug',
    'nether: tunnelled 159 blocks: 3 ancient debris mined, 3 picked up'
  ]);
  // the drink before any dig
  const drank = f.did.indexOf('drink potion of long_fire_resistance');
  t.true(drank >= 0 && drank < f.did.findIndex(d => d.startsWith('dig ')));
  // the debris: the three it may take, each with the diamond pickaxe in hand; the floor's and the one by lava left
  t.deepEqual(f.dugWith.filter(d => d.startsWith(DEBRIS)).sort(), [WALL, HEAD, ROOF].map(p => `${DEBRIS} ${k(p)} with diamond_pickaxe`).sort());
  t.is(f.get(NETHER, FLOOR), DEBRIS);
  t.is(f.get(NETHER, HOT), DEBRIS);
  t.is(carried(f, DEBRIS), 3);
  t.false(f.drops.some(d => d.item === DEBRIS), 'every drop picked up');
  // the tunnels kept: the trunk, three branches, all shut
  const n = peekNether(w);
  t.is(n.tunnels!.list.length, 4);
  t.deepEqual(n.tunnels!.list.map(x => [x.from, x.head, x.way.length, x.shut]), [
    [undefined, 'e', 55 + TRUNK_LEVEL, `its ${TRUNK_LEVEL} blocks dug`], [0, 'e', BRANCH_LONG, `its ${BRANCH_LONG} blocks dug`],
    [0, 'w', BRANCH_LONG, `its ${BRANCH_LONG} blocks dug`], [0, 'e', BRANCH_LONG, `its ${BRANCH_LONG} blocks dug`]
  ]);
  t.deepEqual(n.tunnels!.list[0].start, MOUTH);
  t.deepEqual(n.tunnels!.portal, n.portal);
  // home, a clean trip that did its work; the dry mark of a trip that found debris goes
  t.is(f.state.dim, OVERWORLD);
  t.like(n, { stageTrips: 7, lastTrip: { end: 'clean' } });
  t.is(w.work?.last?.gain, 3);
  t.is(w.work?.dry['nether:tunnel'], undefined);
});

test.serial('the depth band and the courtesy: the stair stays round its column in its portal\'s area, every level cell at y 15, nothing dug under 15 or but netherrack and debris, nothing placed, every walk careful, 16 from the community\'s room and 2 from lava', async (t) => {
  const { w, f } = await atStage3(DEBRIS_FIELD);
  await tunnelRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  const list = peekNether(w).tunnels!.list;
  const trunk = tunnelCells(list[0]);
  const foot = trunk.findIndex(c => c.y === TUNNEL_BAND.best);
  t.true(foot > 0);
  // the stair: within a 4x4 footprint after its first steps (the community's room kept it off its first side), and none of it further than 12 from its portal
  t.true(trunk.slice(4, foot).every(c => c.x >= -73 && c.x <= -70 && c.z >= 261 && c.z <= 264), 'round its column');
  t.true(trunk.slice(0, foot).every(c => Math.max(OWN_BOX.x1 - c.x, c.x - OWN_BOX.x2, OWN_BOX.z1 - c.z, c.z - OWN_BOX.z2) <= MOUTH_RADIUS));
  // level: the trunk's rest and every branch at y 15, its line straight south from the stair's foot
  t.true(trunk.slice(foot).every(c => c.y === TUNNEL_BAND.best && c.x === LEVEL_X));
  for (const b of list.slice(1)) t.true(tunnelCells(b).every(c => c.y === TUNNEL_BAND.best), `branch ${b.head}`);
  t.true(TUNNEL_BAND.best >= TUNNEL_BAND.low && TUNNEL_BAND.best + 2 <= TUNNEL_BAND.high, 'the head and the roof\'s debris in the band too');
  // what it dug: nothing under 15, netherrack (and the debris) only, each a cell of its tunnels or a debris
  const open = tunnelOpen(list);
  const dug = dugHere(f);
  t.true(dug.length > 300);
  t.true(dug.every(c => c.at.y >= TUNNEL_BAND.best), 'nothing under the band\'s 15');
  t.true(f.did.filter(d => d.startsWith('dig ')).every(d => /^dig (netherrack|ancient_debris) /.test(d)));
  t.true(dug.every(c => open.has(k(c.at)) || [WALL, HEAD, ROOF].some(p => k(p) === k(c.at))));
  t.true(dug.every(c => boxGap(zoneBox(ROOM_ZONE), cellBox(c.at)) >= FROM_BUILDS), '16 from the room');
  t.false(f.did.some(d => d.startsWith('place ')));
  walkedKindly(t, f);
});

test.serial('later trips go on from its tunnels: the next walks down the trunk to the next branch (no new trunk), the potion drunk at that face, not at its hut', async (t) => {
  const a = await atStage3();
  await tunnelRun(a.f.ctx, HOUR, () => a.later);
  const n = peekNether(a.w);
  const before = n.tunnels!.list.length;
  stock(a.w, ['fire_resistance']);
  const f2 = nextTrip(a.w, a.f, a.first, a.later);
  const r = await tunnelRun(f2.ctx, HOUR, () => a.later);
  t.regex(r.text, /^tunnelled \d+ blocks: no ancient debris; /);
  const said = f2.said.filter(l => /^tunnel: /.test(l));
  t.is(said[0], 'tunnel: a branch west off tunnel 1 at nether (-70, 15, 269)');
  t.is(said[1], "tunnel: drank a potion of fire_resistance at the tunnel's face at nether (-70, 15, 269): 3:00 of fire resistance");
  t.false(said.some(l => /new trunk/.test(l)));
  t.true(n.tunnels!.list.length > before);
  t.true(n.tunnels!.list.every(x => x.from === undefined ? same(x.start, MOUTH) : x.from === 0), 'one trunk still');
  // the walk down its own trunk dug nothing on the way (its first dig is the new branch's)
  const firstDig = f2.did.find(d => d.startsWith('dig '));
  t.is(firstDig, 'dig netherrack (-71, 16, 269)');
  t.like(r, { gain: 0, mark: 'same', worked: true });
});

test.serial('lava ahead stops that branch: no dig within 2 of it, the branch shut there for later trips, the next one planned', async (t) => {
  const lava = at(-60, 16, 265);
  const { w, f } = await atStage3([[lava, 'lava']]);
  await tunnelRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.true(f.said.includes('tunnel: tunnel 2 (a branch of tunnel 1) shut at nether (-63, 15, 265): lava within 2 ahead at nether (-60, 16, 265)'));
  const branch = peekNether(w).tunnels!.list[1];
  t.like(branch, { from: 0, head: 'e', shut: 'lava within 2 ahead at nether (-60, 16, 265)' });
  t.deepEqual(tunnelCells(branch).at(-1), at(-63, 15, 265));
  t.true(dugHere(f).every(c => Math.max(Math.abs(c.at.x - lava.x), Math.abs(c.at.y - lava.y), Math.abs(c.at.z - lava.z)) > LAVA_GAP), 'nothing dug within 2 of the lava');
  t.is(f.get(NETHER, lava), 'lava');
  // on to the next: the west branch
  t.true(f.said.includes('tunnel: a branch west off tunnel 1 at nether (-70, 15, 265)'));
  walkedKindly(t, f);
});

test.serial('lava that shows as the rock opens is plugged with cobblestone (its own, remembered: no one else\'s), the branch shut there and never stepped into', async (t) => {
  const dig = at(-60, 15, 265);
  const flow = at(-60, 15, 264);
  const { w, f } = await atStage3([], { onDig: (p, put) => { if (k(p) === k(dig)) put(flow, 'lava'); } });
  await tunnelRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.true(f.said.includes('tunnel: lava showed by the tunnel at nether (-60, 15, 264): plugged with cobblestone'), f.said.join('\n'));
  t.true(f.said.includes('tunnel: tunnel 2 (a branch of tunnel 1) shut at nether (-61, 15, 265): lava showed at nether (-60, 15, 264): plugged'));
  t.true(f.did.includes('place cobblestone (-60, 15, 264)'));
  t.is(f.get(NETHER, flow), 'cobblestone');
  t.deepEqual(peekNether(w).tunnels!.plugs, [flow]);
  t.false(netherWalks(f).some(x => k(x.to) === k(dig)), 'never stepped in');
});

test.serial('the effect\'s time: the digging ends while the effect still lasts out the way back to its portal (and 20 s for a dig at the least): back home', async (t) => {
  let g: Game | undefined;
  const low = once(() => g, /^dig netherrack \(-70, 16, 270\)/, f => { f.state.fire = 50; });
  const a = await atStage3([], { onLook: low });
  g = a.f;
  const r = await tunnelRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, 'tunnelled 63 blocks: no ancient debris; the fire resistance running low (50 s left, the way back 34 s); back at overworld (-562, 65, 2191)');
  t.true(50 < EFFECT_LEAST_S + 34);
  t.like(r, { gain: 0, mark: 'same', worked: true, cameBack: true });
  t.is(a.f.state.dim, OVERWORLD);
  // the effect looked at before every dig: down to 25 s mid-step, the next dig is not made
  let h: Game | undefined;
  const lower = once(() => h, /^dig netherrack \(-70, 16, 266\)/, f => { f.state.fire = 25; });
  const b = await atStage3([], { onLook: lower, onDig: p => { if (k(p) === k(at(-70, 16, 266)) && h) h.state.fire = 25; } });
  h = b.f;
  const r2 = await tunnelRun(b.f.ctx, HOUR, () => b.later);
  t.regex(r2.text, /the fire resistance running low \(25 s left, the way back \d+ s\)/);
  t.false(b.f.did.includes('dig netherrack (-70, 15, 266)'), 'the step\'s second dig not made');
  // the next trip goes on from the half-dug step: its open head is its own, no cave
  t.like(peekNether(b.w).tunnels!.list[0], { shut: undefined });
  t.deepEqual(peekNether(b.w).tunnels!.dug, [at(-70, 16, 266)]);
  stock(b.w, ['fire_resistance']);
  const f3 = nextTrip(b.w, b.f, b.first, b.later);
  await tunnelRun(f3.ctx, HOUR, () => b.later);
  t.true(f3.did.includes('dig netherrack (-70, 15, 266)'));
  t.false(f3.did.includes('dig netherrack (-70, 16, 266)'));
  t.false(f3.said.some(l => /cave/.test(l)), f3.said.join('\n'));
});

test.serial('at most 4 debris a trip: then the trip ends and goes home', async (t) => {
  const five: Blocks = [266, 268, 270, 272, 274].map((z): [Pos, string] => [at(-71, 15, z), DEBRIS]);
  const { f } = await atStage3(five);
  const r = await tunnelRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  t.is(r.text, `tunnelled 65 blocks: ${TUNNEL_TRIP} ancient debris mined, ${TUNNEL_TRIP} picked up; the trip's ${TUNNEL_TRIP} ancient debris mined; back at overworld (-562, 65, 2191)`);
  t.is(f.get(NETHER, at(-71, 15, 274)), DEBRIS);
  t.like(r, { gain: TUNNEL_TRIP, worked: true });
});

test.serial('a hit in the tunnel (the ghast rule b and the barter\'s other dangers): it stops at once and walks back up its tunnel and home', async (t) => {
  let g: Game | undefined;
  const hurt = once(() => g, /^dig netherrack \(-70, 16, 268\)/, f => { f.state.health = 14; });
  const a = await atStage3([], { onLook: hurt });
  g = a.f;
  const r = await tunnelRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, 'tunnelled 62 blocks: no ancient debris; a hit taken (health 20 -> 14); back at overworld (-562, 65, 2191)');
  t.like(r, { mark: 'same', cameBack: true });
  t.is(a.f.state.dim, OVERWORLD);
  // up its own tunnel: the last walks down there along its cells back to the mouth
  const walks = netherWalks(a.f);
  const mouthAt = walks.findIndex((x, i) => i > walks.length / 2 && k(x.to) === k(MOUTH));
  t.true(mouthAt > 0);
});

test.serial('at home: the fire gear not worn, or no cobblestone to plug lava with: it does not set out (untried)', async (t) => {
  const a = await atStage3();
  a.f.inv.splice(0, a.f.inv.length, ...a.f.inv.map(i => (i.slot === 38 ? { ...i, enchantments: [] } : i)));
  const r = await tunnelRun(a.f.ctx, HOUR, () => a.later);
  t.is(r.text, 'not setting out to tunnel: fire EPF 16 < 20 (the diamond_chestplate has protection 0 (4 wanted))');
  t.like(r, { untried: true, gain: 0 });
  t.false(a.f.did.some(d => d.startsWith('portal ')));
  const b = await atStage3();
  b.f.inv.splice(0, b.f.inv.length, ...b.f.inv.filter(i => !['cobblestone', 'cobbled_deepslate'].includes(i.name)));
  for (const c of b.f.chests.values()) c.splice(0, c.length, ...c.filter(s => !['cobblestone', 'cobbled_deepslate'].includes(s.name)));
  const r2 = await tunnelRun(b.f.ctx, HOUR, () => b.later);
  t.like(r2, { untried: true });
  t.regex(r2.text, /^not setting out/);
});

test('the tunnels\' memory as brain.json may hold it: made whole, an entry that is not cut the list there (a branch names its trunk by its place); a portal moved lets them go; brain-status counts them', (t) => {
  const w = setupWorld();
  w.nether = {
    stage: 3, portal: { x: -78, y: 91, z: 260 }, linked: true,
    tunnels: {
      portal: { x: -78, y: 91, z: 260 }, plugs: [{ x: 1, y: 2, z: 3 }, 'junk'], dug: [{ x: 4, y: 5, z: 6 }],
      list: [
        { start: { x: -70, y: 91, z: 255 }, head: 'e', way: 'EEESSSss', shut: 'its 32 blocks dug', extra: 1 },
        { start: { x: -67, y: 85, z: 258 }, head: 'n', way: 'nnn', from: 0 },
        { start: { x: 0, y: 0, z: 0 }, head: 'up', way: 'x' },
        { start: { x: 1, y: 1, z: 1 }, head: 'n', way: '' }
      ]
    }
  } as unknown as WorldMemory['nether'];
  const n = netherOf(w);
  t.deepEqual(n.tunnels, {
    portal: { x: -78, y: 91, z: 260 }, plugs: [{ x: 1, y: 2, z: 3 }], dug: [{ x: 4, y: 5, z: 6 }],
    list: [{ start: { x: -70, y: 91, z: 255 }, head: 'e', way: 'EEESSSss', shut: 'its 32 blocks dug' }, { start: { x: -67, y: 85, z: 258 }, head: 'n', way: 'nnn', from: 0 }]
  });
  t.is(tunnelsFor(w).length, 2);
  t.regex(netherLine(w, T0), /; 2 tunnel\(s\) for debris, 1 going on/);
  const moved = structuredClone(w);
  netherOf(moved).portal = { x: 0, y: 70, z: 0 };
  t.deepEqual(tunnelsFor(moved), []);
});

test.serial('the ghast rule b at the face: one in sight past 16 (23 off) is watched, not fled: the potion drunk and the stair dug; one within 16 in sight sends it back from its hut', async (t) => {
  const far: Mob = { id: 9, name: 'ghast', position: { x: -60, y: 85, z: 255 } };
  const a = await atStage3([], { mobs: [far] });
  const r = await tunnelRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /^tunnelled \d+ blocks: /);
  t.false(/a ghast in sight/.test(r.text), r.text);
  t.true(a.f.said.some(l => /^tunnel: drank a potion of long_fire_resistance at the tunnel's face/.test(l)), a.f.said.join('\n'));
  t.true(dugHere(a.f).length > 0, 'the stair dug');
  const near: Mob = { id: 9, name: 'ghast', position: { x: -66, y: 80, z: 262 } };
  const b = await atStage3([], { mobs: [near] });
  const r2 = await tunnelRun(b.f.ctx, HOUR, () => b.later);
  t.is(r2.text, 'nothing tunnelled; a ghast in sight (13 off); back at overworld (-562, 65, 2191)');
  t.false(b.f.did.some(d => d.startsWith('dig ')));
});

test.serial('a run cut short mid-step (the head of a branch\'s step dug, then the abort): the cell is kept as its own (mem.dug), and the next trip goes on through it, no "cave ahead"', async (t) => {
  const ac = new AbortController();
  const HEAD = at(-63, 16, 265);
  const a = await atStage3([], { onDig: p => { if (same(p, HEAD)) ac.abort(); } });
  (a.f.ctx as { signal: AbortSignal }).signal = ac.signal;
  await t.throwsAsync(() => tunnelRun(a.f.ctx, HOUR, () => a.later), { message: 'aborted' });
  const tm = peekNether(a.w).tunnels!;
  t.true((tm.dug ?? []).some(c => same(c, HEAD)), JSON.stringify(tm.dug));
  const branch = tm.list.findIndex(x => x.from !== undefined && x.shut === undefined);
  t.true(branch >= 0);
  stock(a.w, ['fire_resistance']);
  const f2 = nextTrip(a.w, a.f, a.first, a.later);
  await tunnelRun(f2.ctx, HOUR, () => a.later);
  t.false(f2.said.some(l => /a cave ahead/.test(l)), f2.said.join('\n'));
  t.is(peekNether(a.w).tunnels!.list[branch].shut, `its ${BRANCH_LONG} blocks dug`);
});

test.serial('others\' portals are builds too (a bare one the bridge makes no zone of): its tunnels keep 16 from each it has seen down there', async (t) => {
  const { w, f } = await atStage3([], { zones: [] });
  const theirs = { x: -60, y: 15, z: 285, axis: 'x' as const, width: 2, height: 3 };
  netherOf(w).seen![NETHER].push(theirs);
  await tunnelRun(f.ctx, HOUR, () => T0 + 2 * HOUR);
  const box = grow(boxOf(portalCells(theirs)), 1);
  t.true(dugHere(f).length > 100);
  t.true(dugHere(f).every(c => boxGap(box, cellBox(c.at)) >= FROM_BUILDS), 'none within 16 of their portal');
  t.true(f.said.some(l => /shut at .*: within 16 of someone's build or a natural structure$/.test(l)), f.said.join('\n'));
});

test.serial('a dig that does not go (a timeout: no verdict on the rock) ends the trip and leaves the tunnel open; the next trip goes on there; a second failure at that same end shuts it', async (t) => {
  const C = at(-70, 16, 268);
  /** dig.here at C answers a timeout (the first `times` asks) */
  const timeout = (f: Game, times: number) => {
    let n = 0;
    const call = f.ctx.call.bind(f.ctx);
    (f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
      if (m === 'dig.here' && p && Number(p.x) === C.x && Number(p.y) === C.y && Number(p.z) === C.z && n++ < times) return { dug: false, reason: 'timeout', block: 'minecraft:netherrack' };
      return call(m, p);
    }) as typeof call;
  };
  const a = await atStage3();
  timeout(a.f, 1);
  const r = await tunnelRun(a.f.ctx, HOUR, () => a.later);
  t.regex(r.text, /could not dig the netherrack at nether \(-70, 16, 268\): timeout; tunnel 1 is gone on with next trip; back at overworld/);
  t.like(r, { mark: 'same' });
  const t1 = peekNether(a.w).tunnels!.list[0];
  t.is(t1.shut, undefined, 'left open');
  t.false(a.f.said.some(l => / shut at /.test(l)));
  const kept = structuredClone(a.w);

  // the next trip: on from there, the cell dug
  stock(a.w, ['fire_resistance']);
  const f2 = nextTrip(a.w, a.f, a.first, a.later);
  await tunnelRun(f2.ctx, HOUR, () => a.later);
  t.true(f2.did.includes('dig netherrack (-70, 16, 268)'));
  t.is(peekNether(a.w).tunnels!.list[0].failed, undefined, 'gone past it');

  // or it fails there again: shut, for good
  stock(kept, ['fire_resistance']);
  const f3 = nextTrip(kept, a.f, a.first, a.later);
  timeout(f3, 1);
  await tunnelRun(f3.ctx, HOUR, () => a.later);
  t.regex(peekNether(kept).tunnels!.list[0].shut ?? '', /^could not dig the netherrack at nether \(-70, 16, 268\): timeout \(the second time there\)$/);
});

test.serial('the trip\'s time bound: the clock runs out mid-tunnel, the digging ends while the way back still fits, home', async (t) => {
  const a = await atStage3();
  let now = a.later;
  const call = a.f.ctx.call.bind(a.f.ctx);
  (a.f.ctx as { call: typeof call }).call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'dig.here' && p && Number(p.x) === -70 && Number(p.y) === 16 && Number(p.z) === 270) now += 9.5 * MINUTE;
    return call(m, p);
  }) as typeof call;
  const r = await tunnelRun(a.f.ctx, HOUR, () => now);
  t.regex(r.text, /^tunnelled \d+ blocks: no ancient debris; the tunnel trip's time is up; back at overworld \(-562, 65, 2191\)$/);
  t.false(a.f.did.includes('dig netherrack (-70, 16, 272)'));
  t.is(a.f.state.dim, OVERWORLD);
});

test('a tunnel\'s failed end as brain.json may hold it: kept where it is a cell, let go where it is not', (t) => {
  const w = setupWorld();
  w.nether = {
    stage: 3, portal: { x: -78, y: 91, z: 260 }, linked: true,
    tunnels: { portal: { x: -78, y: 91, z: 260 }, list: [{ start: { x: -70, y: 91, z: 255 }, head: 'e', way: 'EE', failed: { x: -68, y: 89, z: 255 } }, { start: { x: -70, y: 91, z: 250 }, head: 'e', way: '', failed: 'junk' }] }
  } as unknown as WorldMemory['nether'];
  t.deepEqual(netherOf(w).tunnels!.list, [
    { start: { x: -70, y: 91, z: 255 }, head: 'e', way: 'EE', failed: { x: -68, y: 89, z: 255 } }, { start: { x: -70, y: 91, z: 250 }, head: 'e', way: '' }
  ]);
});
