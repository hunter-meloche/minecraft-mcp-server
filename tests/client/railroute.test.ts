import test from 'ava';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { Zone } from '../../src/client/brain/courtesy.js';
import { zoneDistance } from '../../src/client/brain/courtesy.js';
import { Ground, entryOf, type Entry } from '../../src/client/brain/boatroute.js';
import {
  BOOST_EVERY, BOOST_GAP, BRAKE, FIRST_BOOST, HEAD, RAIL_RECIPES, TORCH_REACH, billOf, planExtension, planRails, railBase, railRoom, railsLine, railsText, shapeOf,
  type RailCell, type RailPlan, type RailResult
} from '../../src/client/brain/railroute.js';

/**
 * The rails fallback of the villager move, planned only (P5c; railroute.ts): the rails' rules as the scratch RailsCheck
 * ran them on the 26.3 jar (what a rail stands on and goes into, a slope's support and air, the launch off a stop and the
 * slow pick-up, the coast, the climb, the brake, one torch's reach), and the plan over a stand-in of the live homestead:
 * the yard x -565..-533, z 2119..2215 (its fence at y 63 on the box's edge), the hall's panel (-556, 63-64, 2126) in its
 * north wall, a torch on the fence's post (-556, 64, 2119); flat grass at y 62 out to the north.
 */

const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const HALL = { x: -561, y: 62, z: 2126, width: 11, length: 9 };
const PANEL: Pos[] = [{ x: -556, y: 63, z: 2126 }, { x: -556, y: 64, z: 2126 }];
const FENCE = 'birch_fence[east=true,north=false,south=false,waterlogged=false,west=true]';
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

function hallWorld(): WorldMemory {
  return {
    landmarks: { chests: [], farmland: [] }, leash: 96, yard: { ...YARD }, chestItems: {}, lastDone: {},
    zones: {
      hall: [{ ...HALL }], 'hall:panel': PANEL.map(p => ({ ...p })), 'hall:gate': [{ x: -556, y: 63, z: 2134 }],
      'fence:gate': [{ x: -549, y: 63, z: 2119 }]
    }
  } as WorldMemory;
}
const ENTRY = entryOf(hallWorld()) as Entry;

/** The land read: grass to y 62, air over it, the yard's fence ring at 63 and the torch on the panel's post; `cells` over it. */
function land(cells: Record<string, string> = {}, box = { x1: -600, z1: 1960, x2: -510, z2: 2130 }): Ground {
  const g = new Ground(55, 29);
  for (let x = box.x1; x <= box.x2; x++) for (let z = box.z1; z <= box.z2; z++) for (let y = 55; y < 84; y++) {
    const ring = ((x === YARD.x1 || x === YARD.x2) && z >= YARD.z1 && z <= YARD.z2) || ((z === YARD.z1 || z === YARD.z2) && x >= YARD.x1 && x <= YARD.x2);
    const base = y <= 61 ? 'dirt' : y === 62 ? 'grass_block[snowy=false]' : y === 63 && ring ? FENCE : y === 64 && x === -556 && z === YARD.z1 ? 'torch' : 'air';
    g.set(x, y, z, cells[k(x, y, z)] ?? base);
  }
  return g;
}
/** A ridge across the whole width at these z: the ground's top raised by `up[i]` blocks (dirt under grass). */
function ridge(z0: number, up: number[], x1 = -600, x2 = -510): Record<string, string> {
  const cells: Record<string, string> = {};
  up.forEach((h, i) => { for (let x = x1; x <= x2; x++) for (let y = 63; y < 63 + h; y++) cells[k(x, y, z0 + i)] = y === 62 + h ? 'grass_block[snowy=false]' : 'dirt'; });
  return cells;
}

const VILLAGER = { id: 101, name: 'villager', position: { x: -555.5, y: 63, z: 2000.5 } };
const STORES = { iron_ingot: 70, raw_iron: 2630, gold_ingot: 41, raw_gold: 987, redstone: 2051, stick: 40, cobblestone: 600 };
const opts = (over: Partial<Parameters<typeof planRails>[1]> = {}): Parameters<typeof planRails>[1] => ({
  candidates: [VILLAGER], entry: ENTRY, panel: PANEL[0], yard: YARD, zones: [], bounds: { x1: -600, z1: 1960, x2: -510, z2: 2130 }, stores: STORES, ...over
});
/** A plan made (its line never beside itself: rails side by side, or one over another within two, join up). */
const plan = (r: RailResult): RailPlan => {
  if (!r.ok) throw new Error(r.why);
  const line = [r.stop.at, ...r.cells];
  for (let i = 0; i < line.length; i++) for (let j = i + 2; j < line.length; j++) {
    const a = line[i], b = line[j], side = Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
    if ((side === 1 && Math.abs(a.y - b.y) <= 1) || (side === 0 && Math.abs(a.y - b.y) <= 2)) throw new Error(`the line beside itself: ${i} and ${j}`);
  }
  // a slope rail runs straight: the rails before and after it in line with it
  for (let i = 1; i < line.length - 1; i++) {
    const [a, c, e] = [line[i - 1], line[i], line[i + 1]];
    if (line[i] !== r.stop.at && (c as RailCell).shape?.startsWith('ascending') && !((a.x === c.x && e.x === c.x) || (a.z === c.z && e.z === c.z))) throw new Error(`a slope rail on a curve at ${at(c)}`);
  }
  return r;
};
const at = (c: { x: number; y: number; z: number }) => `${c.x},${c.y},${c.z}`;

test('what a rail stands on and goes into, as the 26.3 jar has it (the scratch RailsCheck): natural ground, never a path, farmland, a bottom slab, leaves or what anyone built; into air or what a block replaces, not a flower', (t) => {
  for (const b of ['grass_block[snowy=false]', 'dirt', 'coarse_dirt', 'podzol', 'mycelium', 'stone', 'deepslate', 'tuff', 'sand', 'red_sand', 'gravel', 'sandstone', 'clay', 'mud',
    'terracotta', 'orange_terracotta', 'snow_block', 'ice', 'coal_ore', 'deepslate_iron_ore']) t.true(railBase(b), b);
  // no rigid top (the jar: the rail comes off)
  for (const b of ['dirt_path', 'farmland[moisture=7]', 'oak_slab[type=bottom,waterlogged=false]', 'oak_leaves[distance=1,persistent=false,waterlogged=false]', 'oak_fence',
    'cobblestone_wall', 'oak_stairs[facing=north,half=bottom]', 'snow[layers=1]', 'white_carpet', 'chest[facing=north,type=single]', 'water[level=0]', 'air']) t.false(railBase(b), b);
  // a rigid top, but someone's: the line puts nothing on what anyone built (planks, cobblestone, bricks, glass)
  for (const b of ['oak_planks', 'cobblestone', 'stone_bricks', 'bricks', 'glass', 'oak_slab[type=top,waterlogged=false]', 'white_wool', 'oak_log[axis=y]']) t.false(railBase(b), b);
  for (const c of ['air', 'cave_air', 'short_grass', 'fern', 'tall_grass[half=lower]', 'large_fern[half=lower]', 'dead_bush', 'bush', 'short_dry_grass', 'tall_dry_grass', 'leaf_litter[facing=north,segment_amount=1]', 'snow[layers=1]', 'vine[east=false,north=true,south=false,up=false,west=false]'])
    t.true(railRoom(c), c);
  for (const c of ['poppy', 'dandelion', 'oak_sapling[stage=0]', 'sweet_berry_bush[age=1]', 'wheat[age=7]', 'sugar_cane[age=0]', 'torch', 'pink_petals[facing=north,flower_amount=1]', 'firefly_bush', 'snow[layers=2]', 'water[level=0]', 'stone'])
    t.false(railRoom(c), c);
  // the recipes, as data/minecraft/recipe/{rail,powered_rail,redstone_torch,minecart}.json have them
  t.deepEqual(RAIL_RECIPES, {
    rail: { makes: 16, from: { iron_ingot: 6, stick: 1 } }, powered_rail: { makes: 6, from: { gold_ingot: 6, stick: 1, redstone: 1 } },
    redstone_torch: { makes: 1, from: { redstone: 1, stick: 1 } }, minecart: { makes: 1, from: { iron_ingot: 5 } }
  });
});

test('a rail\'s shape from its neighbours: straight, a curve, up toward the higher one', (t) => {
  const p = (x: number, y: number, z: number) => ({ x, y, z });
  t.is(shapeOf(p(0, 63, -1), p(0, 63, 0), p(0, 63, 1)), 'north_south');
  t.is(shapeOf(p(-1, 63, 0), p(0, 63, 0), p(1, 63, 0)), 'east_west');
  t.is(shapeOf(p(0, 63, -1), p(0, 63, 0), p(1, 63, 0)), 'north_east');
  t.is(shapeOf(p(-1, 63, 0), p(0, 63, 0), p(0, 63, 1)), 'south_west');
  t.is(shapeOf(p(0, 63, -1), p(0, 63, 0), p(0, 64, 1)), 'ascending_south');
  t.is(shapeOf(p(0, 64, -1), p(0, 63, 0), p(0, 63, 1)), 'ascending_north');
  // the last rail runs on as it came
  t.is(shapeOf(p(0, 63, -1), p(0, 63, 0)), 'north_south');
});

test('the rails on the flat: the head (a cobblestone stop, the launch, four plain, the pickup by the villager), a boost 8 after the pickup and every 32, the yard\'s stretch in the panel\'s column with its brake two short of the hall; the bill and the time', (t) => {
  const p = plan(planRails(land(), opts()));
  t.is(p.villager, 101);
  t.deepEqual(p.pickup, { x: -556, y: 63, z: 2000 });
  t.is(p.hop, 0);
  t.deepEqual(p.stop, { at: { x: -556, y: 63, z: 1994 }, placed: true });
  // one straight line south: the launch at 1995 to the brake's last rail two short of the hall's wall (2126)
  t.is(p.length, 130);
  t.true(p.cells.every(c => c.x === -556 && c.y === 63 && c.shape === 'north_south'));
  t.deepEqual([p.cells[0].z, p.cells[p.cells.length - 1].z], [1995, 2124]);
  t.is(p.route, 'south 130');
  const lit = (c: RailCell) => `${c.z} ${c.kind}${c.role ? ` ${c.role}` : ''}`;
  t.deepEqual(p.cells.filter(c => c.kind !== 'rail').map(lit), ['1995 powered launch', '2008 powered boost', '2040 powered boost', '2072 powered boost', '2104 powered boost', '2123 brake', '2124 brake']);
  t.is(p.cells[HEAD.pickup - HEAD.launch].z, 2000);
  t.is(p.cells.findIndex(c => c.role === 'boost') - (HEAD.pickup - HEAD.launch), FIRST_BOOST);
  // the yard's stretch: from the fence's post (dug, with the torch on it) in, 6 rails
  t.is(p.yard, 6);
  t.deepEqual(p.opens, [{ at: { x: -556, y: 63, z: 2119 }, block: FENCE }, { at: { x: -556, y: 64, z: 2119 }, block: 'torch' }]);
  t.is(p.wall.length, 6, 'the hall\'s wall is the boat\'s to open, 3 wide');
  // a torch beside each lit rail, at its level, on the ground; the launch's the trigger
  t.deepEqual(p.torches.map(x => `${at(x.at)} ${x.lights.z}${x.trigger ? ' trigger' : ''}`), ['-555,63,1995 1995 trigger', '-555,63,2008 2008', '-555,63,2040 2040', '-555,63,2072 2072', '-555,63,2104 2104']);
  t.like(p.bill, { rail: 123, powered_rail: 7, redstone_torch: 5, minecart: 1, cobblestone: 1, iron_ingot: 53, gold_ingot: 12, redstone: 7, stick: 15, short: [] });
  t.deepEqual(p.seconds, { lay: 136, back: 43, pickup: 60, takeUp: 109, yard: 120, total: 468 });
  t.true(p.fitsDay);
  t.is(railsLine(p), '130 rails from the pickup by the villager (101) at (-556, 63, 2000) to the brake in the yard: 123 rails, 7 powered (0 up slopes, 4 boosts, the launch, 2 the brake), 5 redstone torches, a cobblestone stop, a minecart; up 0, down 0; the bill 53 iron, 12 gold, 7 redstone, 15 sticks; about 8 min of work');
  // the listing: every block, the order back up
  const text = railsText(p);
  t.regex(text, /^Rails home \(a dry run: P5c plans them, nothing is laid\): 130 rails/);
  t.regex(text, /\nWhat it would put down, walking home from the village \(each torch as its rail is laid\):\n/);
  t.regex(text, /\n {2}cobblestone \(the stop\) \(-556, 63, 1994\)\n {2}powered rail \(launch\) \[north_south\] \(-556, 63, 1995\)\n {2}12 x rail \[north_south\] \(-556, 63, 1996\) \.\. \(-556, 63, 2007\)\n/);
  t.regex(text, /\n {2}2 x powered rail, unlit \(the brake\) \[north_south\] \(-556, 63, 2123\) \.\. \(-556, 63, 2124\)\n/);
  t.regex(text, /\n {2}redstone torch \(-555, 63, 1995\) \(lights \(-556, 63, 1995\)\): the trigger, put down last\n/);
  t.regex(text, /Opened for it at the yard \(and put back\): birch_fence \(-556, 63, 2119\), torch \(-556, 64, 2119\)/);
  t.regex(text, /Taken back up walking home after the cart: the trigger torch, the stop, every rail from the launch to the yard's fence and each torch as it is passed \(124 rails, 4 torches\)/);
});

test('a hill the boat cannot cross: the rails climb it a block a block, every rail going up lit with a torch within 8, and come down it plain', (t) => {
  // up 3 over three rails, flat for 4, down 3: z 2050..2059
  const p = plan(planRails(land(ridge(2050, [1, 2, 3, 3, 3, 3, 3, 2, 1])), opts()));
  t.is(p.climb, 3);
  t.is(p.drop, 3);
  t.is(p.route, 'south 130 (up 3, down 3)');
  const z = (n: number) => p.cells.find(c => c.z === n)!;
  t.deepEqual([2049, 2050, 2051].map(n => `${z(n).y} ${z(n).kind} ${z(n).role} ${z(n).shape}`), ['63 powered climb ascending_south', '64 powered climb ascending_south', '65 powered climb ascending_south']);
  t.deepEqual([2052, 2055].map(n => `${z(n).y} ${z(n).kind} ${z(n).shape}`), ['66 rail north_south', '66 rail north_south']);
  t.deepEqual([2056, 2057, 2058, 2059].map(n => `${z(n).y} ${z(n).kind} ${z(n).shape}`), ['66 rail north_south', '65 rail ascending_north', '64 rail ascending_north', '63 rail ascending_north']);
  // the climb's run of three lit by one torch beside it, at its rail's level, on the ground there
  const climbs = p.cells.filter(c => c.role === 'climb');
  const lights = p.torches.filter(x => climbs.some(c => at(c) === at(x.lights)));
  t.is(lights.length, 1);
  t.true(climbs.every(c => Math.abs(c.z - lights[0].lights.z) <= TORCH_REACH));
  t.is(lights[0].at.y, lights[0].lights.y);
  // a slope rail has two blocks of air over it, a level one one: a roof at 3 over the climb's foot stops it, over the flat it does not
  const roofed = { ...ridge(2050, [1, 2, 3, 3, 3, 3, 3, 2, 1]) };
  for (let x = -600; x <= -510; x++) roofed[k(x, 65, 2049)] = 'stone';
  const r = planRails(land(roofed), opts());
  t.true(!r.ok || !r.cells.some(c => c.z === 2049 && c.x === -556), 'no slope rail under the roof');
  const flatRoof: Record<string, string> = {};
  for (let x = -600; x <= -510; x++) flatRoof[k(x, 65, 2030)] = 'stone';
  t.like(planRails(land(flatRoof), opts()), { ok: true, length: 130 });
});

test('what rails cannot do: climb two at once, dip one rail and climb straight out, curve on a slope; a ditch two wide they cross, lit climbing out', (t) => {
  // a step up of 2 across everything: no rails way
  const wall = planRails(land(ridge(2050, [2, 2, 2, 2])), opts());
  t.false(wall.ok);
  if (!wall.ok) t.regex(wall.why, /^no rails way to the yard's fence at \(-556, 63, 2118\); it got no nearer than \d+/);
  // a ditch one wide and one deep across the way: down then straight up again is no rail shape
  const ditch = (wide: number) => {
    const c: Record<string, string> = {};
    for (let x = -600; x <= -510; x++) for (let i = 0; i < wide; i++) c[k(x, 62, 2050 + i)] = 'air';
    for (let x = -600; x <= -510; x++) for (let i = 0; i < wide; i++) c[k(x, 61, 2050 + i)] = 'grass_block[snowy=false]';
    return c;
  };
  t.false(planRails(land(ditch(1)), opts()).ok);
  const two = plan(planRails(land(ditch(2)), opts()));
  t.is(p2(two, 2050), '62 rail ascending_north');
  t.is(p2(two, 2051), '62 powered ascending_south');
  t.is(two.drop, 1);
  t.is(two.climb, 1);
  // every rail between a slope and a curve runs straight (no curve on a slope): no curve beside a slope rail
  for (const [i, c] of two.cells.entries()) if (c.shape.startsWith('ascending')) for (const n of [two.cells[i - 1], two.cells[i + 1]]) if (n) t.false(/^(north|south)_(east|west)$/.test(n.shape), at(n));
});
const p2 = (p: RailPlan, z: number) => { const c = p.cells.find(x => x.z === z && x.x === -556)!; return `${c.y} ${c.kind} ${c.shape}`; };

/**
 * A small world of its own for the rails' shape rules: poppies everywhere on grass (no rail or torch goes into one) but
 * the lanes given (`x,z` -> the rail's level, the ground raised under it) and the torch spots given (air under a stone:
 * room for a torch, none for a rail with its rider); a fence's post at (2, 63, 20), a hall's wall at z 27.
 */
function lanes(lane: Map<string, number>, spots: [number, number][]): { g: Ground; o: Parameters<typeof planRails>[1] } {
  const g = new Ground(55, 29);
  const spot = new Set(spots.map(([x, z]) => `${x},${z}`));
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 40; z++) for (let y = 55; y < 84; y++) {
    const level = lane.get(`${x},${z}`);
    const st = y <= 61 ? 'dirt' : y === 62 ? 'grass_block' : level !== undefined ? (y < level ? 'grass_block' : 'air')
      : spot.has(`${x},${z}`) ? (y === 64 ? 'stone' : 'air') : y === 63 ? 'poppy' : 'air';
    g.set(x, y, z, x === 2 && z === 20 && y === 63 ? FENCE : st);
  }
  const entry: Entry = {
    side: 'north', hall: { x: -3, y: 62, z: 27, width: 11, length: 9 }, wall: [{ x: 2, y: 63, z: 27 }, { x: 2, y: 64, z: 27 }], fence: [{ x: 2, y: 63, z: 20 }],
    out: { x: 2.5, z: 17.5 }, front: { x: 2.5, z: 25 }, inside: { x: 2.5, z: 31.5 }, level: 63, dir: [0, -1]
  };
  return { g, o: { candidates: [{ id: 7, position: { x: -7.5, y: 63, z: 0.5 } }], entry, panel: { x: 2, y: 63, z: 27 }, yard: { x1: -3, z1: 20, x2: 7, z2: 30 }, bounds: { x1: -20, z1: -20, x2: 20, z2: 40 } } };
}

test('a step at a corner: no rail both curves and climbs (no shape is both), so a way that rises just as it turns is none', (t) => {
  // east from the villager along z 0 to x 2, then south along x 2 to the fence; south of the corner a block up (z 1..8)
  // and down again (z 9) straight; torches have room beside the lane along z -1
  const lane = new Map<string, number>();
  for (let x = -14; x <= 2; x++) lane.set(`${x},0`, 63);
  for (let z = 1; z <= 25; z++) lane.set(`2,${z}`, z <= 8 ? 64 : 63);
  const spots: [number, number][] = Array.from({ length: 17 }, (_, i) => [i - 14, -1]);
  const { g, o } = lanes(lane, spots);
  const r = planRails(g, o);
  t.false(r.ok);
  if (!r.ok) t.regex(r.why, /^no rails way to the yard's fence at \(2, 63, 19\)/);
  // the rise a block on from the corner (level to (2, 1), up from there), with room for its torch: a way
  lane.set('2,1', 63);
  const shifted = lanes(lane, [...spots, [3, 1]]);
  const ok = plan(planRails(shifted.g, shifted.o));
  t.is(ok.cells.find(c => c.x === 2 && c.z === 0)!.shape, 'south_west');
  t.like(ok.cells.find(c => c.x === 2 && c.z === 1), { kind: 'powered', role: 'climb', shape: 'ascending_south' });
});

test('no torch but the trigger lights the launch: a climb that passes two from the launch takes its torch on its far side, or there is no way', (t) => {
  // the head north from the pickup (0, 0): the launch (0, 5), the stop (0, 6); the line north one, east two, then south
  // along x 2, past the head two off it, up a block from (2, 5) to (2, 6), down at (2, 10), on to the fence
  const lane = new Map<string, number>();
  for (let z = 0; z <= 6; z++) lane.set(`0,${z}`, 63);
  for (const x of [0, 1, 2]) lane.set(`${x},-1`, 63);
  for (let z = 0; z <= 25; z++) lane.set(`2,${z}`, z >= 6 && z <= 9 ? 64 : 63);
  // the trigger's spot beside the launch (west of it), and one between the climb and the launch (east of it)
  const { g, o } = lanes(lane, [[-1, 5], [1, 5]]);
  const r = planRails(g, { ...o, candidates: [{ id: 7, position: { x: 0.5, y: 63, z: 0.5 } }] });
  t.like(r, { ok: false, why: 'no room for a redstone torch by the powered rails at (2, 63, 5)' });
  // room on the climb's far side: its torch there, the trigger the launch's only one
  const far = lanes(lane, [[-1, 5], [1, 5], [3, 5]]);
  const p = plan(planRails(far.g, { ...far.o, candidates: [{ id: 7, position: { x: 0.5, y: 63, z: 0.5 } }] }));
  t.deepEqual(p.torches.map(x => `${at(x.at)}${x.trigger ? ' trigger' : ''}`), ['-1,63,5 trigger', '3,63,5']);
});

test('16 off every build of others (3D box distance), rails and torches; the village\'s own left out by the caller; never into the yard but by the panel\'s column', (t) => {
  // a build 10 east of the straight line, z 2030..2040: the line bends round it, 16 off
  const zone: Zone = { x1: -546, y1: 60, z1: 2030, x2: -540, y2: 70, z2: 2040, surface: true, sample: 'oak_planks' };
  const p = plan(planRails(land(), opts({ zones: [zone] })));
  t.true(p.cells.every(c => zoneDistance({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, zone) >= 16), JSON.stringify(p.cells.filter(c => zoneDistance(c, zone) < 16)));
  t.true(p.torches.every(x => zoneDistance({ x: x.at.x + 0.5, y: x.at.y, z: x.at.z + 0.5 }, zone) >= 16));
  t.not(p.route, 'south 130');
  // the yard: only its last stretch, in the panel's column
  const inYard = p.cells.filter(c => c.x >= YARD.x1 && c.x <= YARD.x2 && c.z >= YARD.z1 && c.z <= YARD.z2);
  t.deepEqual(inYard.map(c => `${c.x},${c.z}`), [2119, 2120, 2121, 2122, 2123, 2124].map(z => `-556,${z}`));
  // a build that covers the way across the whole width: none
  const across: Zone = { x1: -620, y1: 50, z1: 2060, x2: -490, y2: 80, z2: 2062, surface: true };
  t.false(planRails(land(), opts({ zones: [across] })).ok);
});

test('the head: no lit rail within 7 of the pickup (missed, the empty cart stops short of the first boost), no torch lights the launch but the trigger or the brake at all, two plain rails or more before the brake; never a U one rail wide', (t) => {
  // a hill right by the village: the climb waits until 8 on from the pickup (the line goes level first; the cheapest
  // way to wait would be a hairpin back beside the head, two curves the same way round: refused, rails there join up)
  const p = plan(planRails(land(ridge(2003, [1, 2, 3, ...new Array<number>(25).fill(3), 2, 1])), opts()));
  const pick = HEAD.pickup - HEAD.launch;
  t.true(p.cells.slice(pick, pick + FIRST_BOOST).every(c => c.kind === 'rail'), p.cells.slice(pick, pick + FIRST_BOOST).map(c => `${c.z}:${c.kind}`).join(' '));
  for (const pl of [p, plan0()]) {
    const launch = pl.cells[0];
    const brake = pl.cells.filter(c => c.kind === 'brake');
    t.is(brake.length, BRAKE);
    const near = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) <= 1 && (a.y === b.y || (a.x === b.x && a.z === b.z && b.y === a.y + 1));
    for (const x of pl.torches) {
      t.false(brake.some(b => near(x.at, b)), `${at(x.at)} by the brake`);
      if (!x.trigger) t.false(near(x.at, launch), `${at(x.at)} by the launch`);
    }
    t.is(pl.torches.filter(x => x.trigger).length, 1);
    t.true(near(pl.torches.find(x => x.trigger)!.at, launch));
    const first = pl.cells.findIndex(c => c.kind === 'brake');
    t.true(pl.cells.slice(first - 2, first).every(c => c.kind === 'rail'));
    // and no gap between lit rails over BOOST_EVERY on the flat (a full cart stays fast)
    const lit = pl.cells.map((c, i) => (c.kind === 'powered' ? i : -1)).filter(i => i >= 0);
    for (let i = 2; i < lit.length; i++) t.true(lit[i] - lit[i - 1] <= BOOST_EVERY + 8, `${lit[i - 1]}..${lit[i]}`);
  }
});
const plan0 = () => plan(planRails(land(), opts()));

test('no rails way, and why: the yard\'s stretch blocked, no pickup by a villager (on paths and farmland); a meadow\'s flowers left standing; the bill short of what the stores lack', (t) => {
  // a cart in the panel's column between the fence and the hall (a chest the bot keeps there)
  t.like(planRails(land({ [k(-556, 63, 2122)]: 'chest[facing=north,type=single]' }), opts()), { ok: false, why: 'the rails\' way in the yard is blocked at (-556, 63, 2122): chest' });
  // the villager among paths and farmland, 7 every way
  const paths: Record<string, string> = {};
  for (let x = -575; x <= -535; x++) for (let z = 1980; z <= 2020; z++) paths[k(x, 62, z)] = (x + z) % 3 ? 'dirt_path' : 'farmland[moisture=7]';
  t.like(planRails(land(paths), opts()), { ok: false, why: 'no pickup by a villager to take: no straight, level run of 7 rails on open ground (and a stop and a torch) within 6 of one' });
  // a meadow of poppies round it but two clear rows: the pickup in one, its torch's in the other (a flower is not
  // replaced: no rail and no torch goes into one), the boat hopping the villager over the flowers to it
  const meadow: Record<string, string> = {};
  for (let x = -575; x <= -535; x++) for (let z = 1980; z <= 2020; z++) if (x !== -553 && x !== -552) meadow[k(x, 63, z)] = 'poppy';
  const m = plan(planRails(land(meadow), opts()));
  t.true(m.pickup.x === -553 || m.pickup.x === -552, String(m.pickup.x));
  t.true(m.hop > 2);
  t.true(m.cells.filter(c => c.z <= 2020).every(c => c.x === -553 || c.x === -552));
  // a long line is more than a day's light, and the bill short of what the chests do not hold
  const short = plan(planRails(land(), opts({ stores: { iron_ingot: 10, gold_ingot: 0, redstone: 3 } })));
  t.deepEqual(short.bill.short, ['iron (43 more)', 'gold (12 more)', 'redstone (4 more)', 'cobblestone (1)']);
  t.like(billOf({ rail: 600, powered_rail: 40, redstone_torch: 25, minecart: 1, cobblestone: 0 }, STORES), { iron_ingot: 233, gold_ingot: 42, redstone: 32, stick: 70, short: [] });
});

test('the boat\'s way in across the yard (boatroute.ts yardEntry: its panel of the fence elsewhere): the line comes in by that panel\'s column, its brake just inside the fence, the post and what stands on it all it opens; never into the yard but by that stretch', (t) => {
  // in by the west fence at (-565, 63, 2124..2126), a torch on its middle post; the boat across the yard from 2.5 inside it
  const entry: Entry = {
    ...ENTRY, fence: [2124, 2125, 2126].map(z => ({ x: -565, y: 63, z })), out: { x: -567.5, z: 2125.5 },
    yard: { side: 'west', dir: [-1, 0], through: { x: -561.5, z: 2125.5 }, legs: [{ ...ENTRY.front }], post: { x: -565, y: 63, z: 2125 } }
  };
  const p = plan(planRails(land({ [k(-565, 64, 2125)]: 'torch' }), opts({ entry, panel: entry.yard!.post })));
  // the yard's stretch: the post's cell and the four in from it, east, the brake the last two
  t.is(p.yard, 5);
  t.deepEqual(p.cells.slice(-p.yard).map(c => `${c.x},${c.y},${c.z} ${c.kind} ${c.shape}`), [-565, -564, -563, -562, -561].map(x => `${x},63,2125 ${x >= -562 ? 'brake' : 'rail'} east_west`));
  t.deepEqual(p.opens, [{ at: { x: -565, y: 63, z: 2125 }, block: FENCE }, { at: { x: -565, y: 64, z: 2125 }, block: 'torch' }]);
  // (the north fence straight out from the hall's panel untouched: in at the west fence only)
  const inYard = (c: Pos) => c.x >= YARD.x1 && c.x <= YARD.x2 && c.z >= YARD.z1 && c.z <= YARD.z2;
  t.deepEqual(p.cells.filter(inYard).map(c => `${c.x},${c.z}`), [-565, -564, -563, -562, -561].map(x => `${x},2125`));
  t.is(p.cells[p.cells.length - p.yard - 1].x, -566, 'the cell outside the fence, last before it');
});

test('an extension of a line into the village (Nov 21): a new head by a villager the boat could not reach, the way to the old launch\'s cell, joined straight through the old cobblestone stop or by a curve beside a stop of the ground; never beside the line, lit on into its first boost', (t) => {
  const base = plan(planRails(land(), opts()));
  const joinAt = base.cells[0];
  const far = { id: 102, name: 'villager', position: { x: -590.5, y: 63, z: 1975.5 } };
  const check = (r: ReturnType<typeof planExtension>, stop: { at: Pos; placed: boolean }) => {
    if (!r.ok) throw new Error(r.why);
    t.is(r.villager, 102);
    t.true(Math.hypot(r.pickup.x + 0.5 - far.position.x, r.pickup.z + 0.5 - far.position.z) <= 6);
    const last = r.cells[r.cells.length - 1];
    t.deepEqual({ x: last.x, y: last.y, z: last.z }, { x: joinAt.x, y: joinAt.y, z: joinAt.z }, 'it ends on the old launch\'s cell');
    t.not(last.role, 'launch');
    t.is(r.cells[0].role, 'launch');
    t.is(r.torches.filter(x => x.trigger).length, 1);
    // one line: each rail beside the last, never beside the old one (but at the join), the old stop's cell taken only when it was the bot's cobblestone
    const whole = [r.stop.at, ...r.cells, ...base.cells.slice(1)];
    for (let i = 1; i < whole.length; i++) t.is(Math.abs(whole[i].x - whole[i - 1].x) + Math.abs(whole[i].z - whole[i - 1].z), 1, `${i}`);
    for (let i = 0; i < whole.length; i++) for (let j = i + 2; j < whole.length; j++) {
      const a = whole[i], b = whole[j], side = Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
      t.false((side === 1 && Math.abs(a.y - b.y) <= 1) || (side === 0 && Math.abs(a.y - b.y) <= 2), `beside itself: ${at(a)} and ${at(b)}`);
    }
    const through = r.cells.some(c => c.x === stop.at.x && c.y === stop.at.y && c.z === stop.at.z);
    t.is(through, stop.placed && through, 'through the old stop only when it is a cobblestone');
    // lit on: no gap of more than BOOST_GAP from the new pickup into the old line's first boost
    const lit = [...r.cells, ...base.cells.slice(1)].map((c, i) => (c.kind === 'powered' && c.role !== 'launch' ? i : -1)).filter(i => i >= 0);
    t.true(lit[0] >= HEAD.pickup - HEAD.launch + FIRST_BOOST);
    for (let j = 1; j < lit.length; j++) t.true(lit[j] - lit[j - 1] <= BOOST_GAP);
    return r;
  };
  // the old stop the bot's cobblestone: read as taken up
  check(planExtension(land(), { candidates: [far], yard: YARD, bounds: { x1: -600, z1: 1960, x2: -510, z2: 2130 }, line: { cells: base.cells, stop: base.stop } }), base.stop);
  // a stop of the ground (stone standing there): the way comes in beside it, by a curve on the old launch's cell
  const stone = { [k(base.stop.at.x, base.stop.at.y, base.stop.at.z)]: 'stone' };
  const side = check(planExtension(land(stone), { candidates: [far], yard: YARD, bounds: { x1: -600, z1: 1960, x2: -510, z2: 2130 }, line: { cells: base.cells, stop: { at: base.stop.at, placed: false } } }), { at: base.stop.at, placed: false });
  t.false(/north_south|east_west/.test(side.cells[side.cells.length - 1].shape), 'a curve at the join');
  // walled off from the line (a wall of two across the way): no extension, and why
  const wall: Record<string, string> = {};
  for (let x = -600; x <= -510; x++) for (const y of [63, 64]) wall[k(x, y, 1985)] = 'stone';
  const no = planExtension(land(wall), { candidates: [far], yard: YARD, bounds: { x1: -600, z1: 1960, x2: -510, z2: 2130 }, line: { cells: base.cells, stop: base.stop } });
  t.false(no.ok);
  if (!no.ok) t.regex(no.why, /^no rails way to the line's end at \(-556, 63, 1995\)/);
});
