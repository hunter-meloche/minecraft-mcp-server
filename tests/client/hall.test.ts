import test from 'ava';
import { breakKinds, layoutSpec, type StructureSpec } from '../../src/client/schematic.js';
import { billLeft, billOf, hall, HALL_SIZE, type Blueprint, type Side } from '../../src/client/brain/blueprints.js';
import { FURNACE_TURN, smelt, stockShort } from '../../src/client/brain/chores.js';
import { decide } from '../../src/client/brain/brain.js';
import { RECIPES, rawShort, recipeFor, STRING_KEEP, type MilestoneState } from '../../src/client/brain/progress.js';
import { TREE } from '../../src/client/brain/tree.js';
import { prepare, projectGoal } from '../../src/client/brain/project.js';
import { occupancy, type Rect } from '../../src/client/brain/site.js';
import { structureSiteBoxes } from '../../src/client/structures/site.js';
import { findLandmarks, type Pos, type WorldMemory } from '../../src/client/brain/memory.js';
import {
  bedPlan, FROM_BUILDS, FROM_PENS, FROM_PORTAL, HALL_BEDS, HALL_GLASS, HALL_GROWS, WOOL_WAITS, hallAvoid, hallMilestone, hallSite, hallSiteStep, hallStanding,
  homeBed, makingsStep, panelToward, sideToward
} from '../../src/client/brain/villagers.js';
import type { GoalContext } from '../../src/client/brain/goals.js';
import type { InventoryItem } from '../../src/client/tools.js';
import { HOME, MINUTE, T0, liveWorld, lookAt } from '../helpers/homestead.js';

const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const SIDES: Side[] = ['north', 'east', 'south', 'west'];
const STEP: Record<Side, { x: number; z: number }> = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };
const OPPOSITE: Record<Side, Side> = { north: 'south', south: 'north', east: 'west', west: 'east' };

// ------------------------------------------------------------------------------------------------ the recipes

/** The four recipes as the 26.3 client jar has them (versions/26.3/26.3.jar, data/minecraft/recipe/*.json), as they are. */
const JAR = {
  white_wool: { type: 'minecraft:crafting_shaped', category: 'building', key: { '#': 'minecraft:string' }, pattern: ['##', '##'], result: { id: 'minecraft:white_wool' } },
  white_bed: { type: 'minecraft:crafting_shaped', group: 'bed', key: { '#': 'minecraft:white_wool', X: '#minecraft:planks' }, pattern: ['###', 'XXX'], result: { id: 'minecraft:white_bed' } },
  fletching_table: { type: 'minecraft:crafting_shaped', key: { '#': '#minecraft:planks', '@': 'minecraft:flint' }, pattern: ['@@', '##', '##'], result: { id: 'minecraft:fletching_table' } },
  lectern: { type: 'minecraft:crafting_shaped', category: 'redstone', key: { B: 'minecraft:bookshelf', S: '#minecraft:wooden_slabs' }, pattern: ['SSS', ' B ', ' S '], result: { id: 'minecraft:lectern' } }
};
/** A jar ingredient as RECIPES names it: planks of any wood are `planks`; the lectern's any wooden slab is named oak (the craft takes any). */
const AS: Record<string, string> = { '#minecraft:planks': 'planks', '#minecraft:wooden_slabs': 'oak_slab' };

test('the hall\'s recipes are the 26.3 jar\'s: wool of four string, a bed of three wool and three planks, a fletching table of two flint and four planks, a lectern of four slabs and a bookshelf', (t) => {
  for (const [item, r] of Object.entries(JAR)) {
    const from: Record<string, number> = {};
    for (const ch of r.pattern.join('')) {
      if (ch === ' ') continue;
      const id = (r.key as Record<string, string>)[ch];
      const name = AS[id] ?? id.replace(/^minecraft:/, '');
      from[name] = (from[name] ?? 0) + 1;
    }
    t.deepEqual(RECIPES[item], { makes: 1, from }, item);
    t.deepEqual(recipeFor(item), RECIPES[item], item);
  }
  // the file the wool comes from is white_wool_from_string.json: its result is white wool, one
  t.is(JAR.white_wool.result.id, 'minecraft:white_wool');
  // three beds from nothing but string and logs: 36 string, 3 logs; the leads keep their five
  t.deepEqual(rawShort({ white_bed: 3 }, {}), { string: 36, log: 3 });
  t.deepEqual(rawShort({ fletching_table: 1 }, {}), { flint: 2, log: 1 });
  t.is(STRING_KEEP, 5);
  t.deepEqual(RECIPES.lead, { makes: 2, from: { string: 5 } });
});

// ------------------------------------------------------------------------------------------------ the blueprint

const ch = (bp: Blueprint, p: Pos) => bp.spec.layers[p.y]?.[p.z]?.[p.x] ?? '.';
const stateAt = (bp: Blueprint, p: Pos) => bp.spec.palette[ch(bp, p)];
const at = (bp: Blueprint, kind: string) => bp.landmarks.filter(l => l.kind === kind).map(l => l.at);
const onRing = (bp: Blueprint, p: { x: number; z: number }) => p.x === 0 || p.z === 0 || p.x === bp.size.width - 1 || p.z === bp.size.length - 1;
const ringSide = (bp: Blueprint, p: { x: number; z: number }): Side | undefined =>
  p.z === 0 ? 'north' : p.z === bp.size.length - 1 ? 'south' : p.x === 0 ? 'west' : p.x === bp.size.width - 1 ? 'east' : undefined;
const corner = (bp: Blueprint, p: { x: number; z: number }) => (p.x === 0 || p.x === bp.size.width - 1) && (p.z === 0 || p.z === bp.size.length - 1);

/**
 * Block light inside the hall as the game spreads it: 14 at a torch, a level less each step to a neighbour that lets
 * light through (air, the torch, a bed, the gate, glass), never through a full block (planks, logs, the fletching
 * table, the ground). Kept to the hall's box.
 */
function lightOf(bp: Blueprint): (p: Pos) => number {
  const { width: W, height: H, length: L } = bp.size;
  const level = new Map<string, number>();
  const k = (p: Pos) => `${p.x},${p.y},${p.z}`;
  const clear = (p: Pos) => /^[.THFGW]$/.test(ch(bp, p));
  const queue: Pos[] = [];
  bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((c, x) => {
    if (bp.spec.palette[c] === 'torch') { level.set(k({ x, y, z }), 14); queue.push({ x, y, z }); }
  })));
  while (queue.length) {
    const p = queue.shift()!;
    const l = level.get(k(p))!;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const q = { x: p.x + dx, y: p.y + dy, z: p.z + dz };
      if (q.x < 0 || q.y < 0 || q.z < 0 || q.x >= W || q.y >= H || q.z >= L || !clear(q)) continue;
      if ((level.get(k(q)) ?? 0) >= l - 1) continue;
      level.set(k(q), l - 1);
      queue.push(q);
    }
  }
  return p => level.get(k(p)) ?? 0;
}

/** Everything the blueprint promises, for one way of drawing it: what each test below asks of every side. */
function checkHall(t: import('ava').ExecutionContext, bp: Blueprint, gateSide: Side, panelSide: Side, label: string) {
  const { width: W, height: H, length: L } = bp.size;
  t.is(H, 5, label);
  t.is(bp.groundOffset, 0, label);
  const [gate] = at(bp, 'gate');
  for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    const ring = onRing(bp, { x, z });
    // the ground layer left as it is, under the walls and inside (the yard's grass the floor); the roof whole
    t.is(ch(bp, { x, y: 0, z }), ' ', `${label}: ground ${x},${z}`);
    t.is(stateAt(bp, { x, y: 4, z }), 'oak_planks', `${label}: roof ${x},${z}`);
    for (let y = 1; y <= 3; y++) {
      const s = stateAt(bp, { x, y, z });
      if (!ring) continue;
      if (corner(bp, { x, z })) t.is(s, 'oak_log[axis=y]', `${label}: corner ${x},${y},${z}`);
      // the walls whole: the one opening in them the cell over the gate (a hole would let any mob in)
      else if (s === undefined) t.true(x === gate.x && z === gate.z && y === 2, `${label}: an opening in the wall at ${x},${y},${z}`);
      else t.true(['oak_planks', 'glass'].includes(s) || /^oak_fence_gate/.test(s), `${label}: wall ${x},${y},${z} ${s}`);
    }
  }
  // the gate: in the middle of its side, facing out that way, the cell over it open, the cell inside it clear
  t.is(at(bp, 'gate').length, 1, label);
  t.is(ringSide(bp, gate), gateSide, `${label}: the gate's side`);
  t.false(corner(bp, gate), label);
  t.is(gate.y, 1, label);
  t.is(stateAt(bp, gate), `oak_fence_gate[facing=${gateSide}]`, label);
  t.is(ch(bp, { ...gate, y: 2 }), '.', `${label}: head room over the gate`);
  t.is(stateAt(bp, { ...gate, y: 3 }), 'oak_planks', `${label}: the wall over that`);
  const inward = STEP[OPPOSITE[gateSide]];
  t.is(ch(bp, { x: gate.x + inward.x, y: 1, z: gate.z + inward.z }), '.', `${label}: the way in`);
  t.deepEqual(bp.entrances, [{ ...gate, facing: gateSide }], label);
  const along = gateSide === 'north' || gateSide === 'south' ? { n: W, at: gate.x } : { n: L, at: gate.z };
  t.is(along.at, (along.n - 1) / 2, `${label}: the gate in the middle of its wall`);
  // three beds, heads against a wall, feet into the room, the cell past each foot and over each bed clear
  const heads = at(bp, 'bed'), feet = at(bp, 'bed-foot');
  t.is(heads.length, HALL_BEDS, label);
  t.is(feet.length, HALL_BEDS, label);
  for (const head of heads) {
    const foot = feet.find(f => Math.abs(f.x - head.x) + Math.abs(f.z - head.z) === 1 && f.y === head.y)!;
    t.truthy(foot, `${label}: a foot beside the head at ${fmt(head)}`);
    const d = { x: head.x - foot.x, z: head.z - foot.z };
    const facing = SIDES.find(s => STEP[s].x === d.x && STEP[s].z === d.z)!;
    t.is(stateAt(bp, head), `white_bed[facing=${facing},part=head]`, label);
    t.is(stateAt(bp, foot), `white_bed[facing=${facing},part=foot]`, label);
    t.true(onRing(bp, { x: head.x + d.x, z: head.z + d.z }), `${label}: the head against the wall at ${fmt(head)}`);
    t.is(ch(bp, { x: foot.x - d.x, y: 1, z: foot.z - d.z }), '.', `${label}: the cell past the foot at ${fmt(foot)}`);
    for (const p of [head, foot]) t.is(ch(bp, { ...p, y: 2 }), '.', `${label}: over the bed at ${fmt(p)}`);
  }
  // the lectern's cell empty (P5d places it), with room over it and a clear cell beside it; the fletching table
  const [lectern] = at(bp, 'lectern');
  t.is(ch(bp, lectern), '.', `${label}: the lectern's cell left empty`);
  t.is(ch(bp, { ...lectern, y: 2 }), '.', label);
  t.true(SIDES.some(s => ch(bp, { x: lectern.x + STEP[s].x, y: 1, z: lectern.z + STEP[s].z }) === '.'), `${label}: a cell to stand by the lectern`);
  const [fletching] = at(bp, 'fletching');
  t.is(stateAt(bp, fletching), 'fletching_table', label);
  t.true(SIDES.some(s => ch(bp, { x: fletching.x + STEP[s].x, y: 1, z: fletching.z + STEP[s].z }) === '.'), `${label}: a cell to stand by the fletching table`);
  // the panel: 1 x 2 of the wall's planks on its side (not a corner, not the gate), the wall over it, clear inside it
  const panel = at(bp, 'panel');
  t.is(panel.length, 2, label);
  t.deepEqual(panel.map(p => p.y), [1, 2], label);
  t.true(panel.every(p => p.x === panel[0].x && p.z === panel[0].z), label);
  t.is(ringSide(bp, panel[0]), panelSide, `${label}: the panel's side`);
  t.false(corner(bp, panel[0]), label);
  for (const p of panel) t.is(stateAt(bp, p), 'oak_planks', `${label}: the panel is plain wall`);
  t.is(stateAt(bp, { ...panel[0], y: 3 }), 'oak_planks', `${label}: the wall over the panel`);
  t.false(panel[0].x === gate.x && panel[0].z === gate.z, label);
  const inP = STEP[OPPOSITE[panelSide]];
  for (const y of [1, 2]) t.is(ch(bp, { x: panel[0].x + inP.x, y, z: panel[0].z + inP.z }), '.', `${label}: clear inside the panel`);
  if (panelSide === gateSide) t.true(Math.abs(panel[0].x - gate.x) + Math.abs(panel[0].z - gate.z) >= 2, `${label}: beside the gate, not by it`);
  // the floor cell in the middle, and every landmark but the gate and the panel inside the walls
  const [middle] = at(bp, 'inside');
  t.deepEqual({ x: middle.x, z: middle.z }, { x: (W - 1) / 2, z: (L - 1) / 2 }, label);
  t.is(ch(bp, middle), '.', label);
  for (const l of bp.landmarks.filter(m => m.kind !== 'gate' && m.kind !== 'panel')) t.false(onRing(bp, l.at), `${label}: ${l.kind} inside the walls`);
  // torches on the floor; every cell of the room's air lit (block light 0 is where monsters spawn), on the fletching
  // table's top and in the empty lectern cell too
  for (const p of at(bp, 'torch')) { t.is(stateAt(bp, p), 'torch', label); t.is(ch(bp, { ...p, y: 0 }), ' ', `${label}: a torch on the ground`); }
  const light = lightOf(bp);
  let least = 15;
  for (let y = 1; y <= 3; y++) for (let z = 1; z < L - 1; z++) for (let x = 1; x < W - 1; x++) {
    if (ch(bp, { x, y, z }) !== '.') continue;
    t.true(light({ x, y, z }) >= 1, `${label}: dark at ${x},${y},${z}`);
    // where a mob could stand (on the ground, the floor; on the table's top): a margin over that
    if (/^[ PX]$/.test(ch(bp, { x, y: y - 1, z }))) least = Math.min(least, light({ x, y, z }));
  }
  t.true(least >= 3, `${label}: the darkest cell a mob could stand in has light ${least}`);
  // windows: four glass, in the walls at eye height
  const glass: Pos[] = [];
  bp.spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((c, x) => { if (bp.spec.palette[c] === 'glass') glass.push({ x, y, z }); })));
  t.is(glass.length, 4, label);
  t.true(glass.every(p => p.y === 2 && onRing(bp, p) && !corner(bp, p)), label);
  // nothing findLandmarks would take for home storage
  t.false(Object.values(bp.spec.palette).some(s => /chest|barrel|shulker/.test(s)), label);
  // built on the yard's ground (grass, air over it), it replaces no ground: the build lifts the no-break rule on no
  // ground kind, and Baritone digs no lawn round it (a plank floor here lifted grass_block, as the portal's plinth did)
  const yard = bp.spec.layers.flatMap((layer, y) => layer.flatMap(row => [...row].map(() => (y === 0 ? 'minecraft:grass_block' : 'minecraft:air'))));
  t.deepEqual(breakKinds(layoutSpec(bp.spec), yard), [], `${label}: kinds the build would lift`);
}

test('the hall: 11 x 5 x 9 on the ground layer, the yard\'s grass its floor, walls 3 high, a flat roof; the gate south, three beds on the back wall, the lectern cell, the fletching table, the panel north, lit everywhere', (t) => {
  const bp = hall();
  t.is(bp.name, 'villager-hall');
  t.deepEqual(bp.size, { width: 11, height: 5, length: 9 });
  t.deepEqual(HALL_SIZE, { width: 11, length: 9 });
  checkHall(t, bp, 'south', 'north', 'south/north');
  t.deepEqual(at(bp, 'gate'), [{ x: 5, y: 1, z: 8 }]);
  t.deepEqual(at(bp, 'bed'), [{ x: 1, y: 1, z: 1 }, { x: 2, y: 1, z: 1 }, { x: 3, y: 1, z: 1 }]);
  t.deepEqual(at(bp, 'lectern'), [{ x: 8, y: 1, z: 1 }]);
  t.deepEqual(at(bp, 'fletching'), [{ x: 9, y: 1, z: 1 }]);
  t.deepEqual(at(bp, 'panel'), [{ x: 5, y: 1, z: 0 }, { x: 5, y: 2, z: 0 }]);
  t.deepEqual(at(bp, 'inside'), [{ x: 5, y: 1, z: 4 }]);
  t.deepEqual(at(bp, 'torch'), [{ x: 1, y: 1, z: 7 }, { x: 9, y: 1, z: 7 }]);
  t.is(bp.landmarks.length, 14);
});

test('the hall turns: every gate side, every panel side, either way round the site was found, and each holds all of it', (t) => {
  for (const turned of [false, true]) for (const gateSide of SIDES) for (const panelSide of SIDES) {
    const bp = hall({ gateSide, panelSide, turned });
    const label = `${turned ? 'turned' : 'upright'} gate ${gateSide} panel ${panelSide}`;
    t.deepEqual(bp.size, turned ? { width: 9, height: 5, length: 11 } : { width: 11, height: 5, length: 9 }, label);
    checkHall(t, bp, gateSide, panelSide, label);
  }
  // a bed of another colour, the same cells
  const red = hall({ bed: 'red_bed' });
  t.is(stateAt(red, at(red, 'bed')[0]), 'red_bed[facing=north,part=head]');
  t.throws(() => hall({ bed: 'red_wool' }));
  t.throws(() => hall({ gateSide: 'up' as Side }));
});

test('the hall\'s bill: 189 planks, 12 logs, 4 glass, a fence gate, 2 torches, 3 beds and a fletching table; the live stores make all but the glass, which is smelted from their sand first', (t) => {
  const bp = hall();
  t.deepEqual(bp.bill, { oak_planks: 189, oak_log: 12, white_bed: 3, fletching_table: 1, torch: 2, oak_fence_gate: 1, glass: 4 });
  t.deepEqual(billOf(bp.spec), bp.bill);
  t.is(HALL_GLASS, 4);
  // the live stores (Nov 15: 3177 oak logs, 170 flint, 61 string, 2 white wool, 241 sticks, 108 coal, 9 sand, no glass)
  const live = { oak_log: 3177, flint: 170, string: 61, white_wool: 2, stick: 241, coal: 108, sand: 9 };
  t.deepEqual(rawShort(bp.bill, live), { glass: 4 }, 'glass is no recipe: the bill alone would wait for it for good');
  t.deepEqual(rawShort(bp.bill, { ...live, glass: 4 }), {});
  // the string the beds' wool takes leaves the leads theirs: 28 of 61
  t.deepEqual(bedPlan(live, false), { bed: 'white_bed', string: 28 });
});

// ------------------------------------------------------------------------------------------------ the beds

test('the beds: three already, else a colour whose beds and wool make three, else the sheep pen\'s wool while it has sheep, else white wool of string, the leads\' five kept', (t) => {
  t.deepEqual(bedPlan({ white_bed: 3 }, true), { bed: 'white_bed', string: 0 });
  t.deepEqual(bedPlan({ red_bed: 4, white_bed: 3 }, false), { bed: 'red_bed', string: 0 });
  t.deepEqual(bedPlan({ red_bed: 1, red_wool: 6, string: 0 }, false), { bed: 'red_bed', string: 0 });
  t.deepEqual(bedPlan({ black_wool: 9, white_wool: 3, string: 100 }, false), { bed: 'black_bed', string: 0 }, 'the pen\'s black flock\'s wool, no string');
  t.deepEqual(bedPlan({ white_wool: 2, string: 61 }, false), { bed: 'white_bed', string: 28 });
  t.deepEqual(bedPlan({ white_bed: 1, white_wool: 2, string: 21 }, false), { bed: 'white_bed', string: 16 });
  t.like(bedPlan({ white_bed: 1, white_wool: 2, string: 20 }, false), { short: { string: 1 } });
  // the pen has sheep: its wool is waited for, not the string's
  t.like(bedPlan({ white_wool: 2, string: 61 }, true), { wait: 'the sheep pen\'s wool (2 white wool carried and stored, 7 more for 3 beds)' });
  // 36 string for nine wool and five kept: 41 will do, 40 is one short
  t.deepEqual(bedPlan({ string: 41 }, false), { bed: 'white_bed', string: 36 });
  t.like(bedPlan({ string: 40 }, false), { short: { string: 1 } });
  t.like(bedPlan({}, false), { short: { string: 36 } });
  t.like(bedPlan({ string: 3 }, false), { short: { string: 36 } }, 'what is under the leads\' share is none of the beds\'');
});

// ------------------------------------------------------------------------------------------------ a fake home

const GROUND = 62;
const MOBDROPS = '-547,65,2179', MISC = '-551,65,2179', STONE = '-547,63,2184';
/** What the fake's craft-item takes for one craft and gives (the game's recipes, in the wood the bot carries). */
const CRAFTS: Record<string, { from: Record<string, number>; makes: number }> = {
  white_wool: { from: { string: 4 }, makes: 1 }, white_bed: { from: { white_wool: 3, oak_planks: 3 }, makes: 1 }, red_bed: { from: { red_wool: 3, oak_planks: 3 }, makes: 1 },
  oak_planks: { from: { oak_log: 1 }, makes: 4 }, stick: { from: { oak_planks: 2 }, makes: 4 }, oak_fence_gate: { from: { oak_planks: 2, stick: 4 }, makes: 1 },
  torch: { from: { coal: 1, stick: 1 }, makes: 4 }, fletching_table: { from: { flint: 2, oak_planks: 4 }, makes: 1 }, lead: { from: { string: 5 }, makes: 2 }
};

/** The improvement runs' builds in the live yard, as their compiled boxes (the structure store, Nov 15: unchanged since Nov 14). */
const LIVE_BUILDS: Rect[] = [
  { x: -547, z: 2185, width: 13, length: 11 }, // cottage
  { x: -560, z: 2163, width: 11, length: 11 }, // cow-barn
  { x: -564, z: 2182, width: 31, length: 17 }, // lamp-walk (posts and a path: its box whole)
  { x: -558, z: 2200, width: 7, length: 7 }, // lookout
  { x: -544, z: 2171, width: 9, length: 8 } // windmill
];

/**
 * The live homestead as brain.json has it on Nov 15: liveWorld (Nov 12) with what came since in the yard's zones (the
 * enchanting room, the workshop, the portal lit, the mine start moved east), its milestones all done up to the
 * portal, the sheep pen empty ("0 sheep in the pen and none within 32 to lure"), and the stores the hall draws on:
 * 61 string, 2 white wool, 170 flint, 9 sand (the live chests held 3 by Nov 15's evening, job #10's panes made of the rest:
 * the windows' glass tests run that).
 */
function afterPortal(): WorldMemory {
  const w = liveWorld();
  const p = w.progress!;
  p.done.push('enchanting', 'workshop', 'nether-portal');
  p.current = undefined;
  p.blocked = undefined;
  p.need = undefined;
  p.blockedUntil = {};
  p.journal = [];
  Object.assign(w.zones!, {
    mine: [{ x: -493, y: 63, z: 2183 }],
    enchanting: [{ x: -547, y: 62, z: 2206, width: 7, length: 7 }], 'enchanting:table': [{ x: -544, y: 63, z: 2209 }], 'enchanting:door': [{ x: -544, y: 63, z: 2206 }],
    workshop: [{ x: -546, y: 62, z: 2152, width: 7, length: 7 }], 'workshop:anvil': [{ x: -543, y: 63, z: 2153 }], 'workshop:door': [{ x: -543, y: 63, z: 2158 }],
    portal: [{ x: -562, y: 62, z: 2146, width: 6, length: 3 }], 'portal:frame': [{ x: -560, y: 64, z: 2147 }], 'portal:lit': [{ x: -560, y: 64, z: 2147 }]
  });
  w.chestItems![MOBDROPS].string = 61;
  w.chestItems![STONE].flint = 170;
  w.chestItems![STONE].sand = 9;
  w.work = { dry: {}, next: {}, sites: {}, pen: { cow: { adults: 6, babies: 0, at: T0 - MINUTE }, sheep: { adults: 0, babies: 0, at: T0 - MINUTE } }, tier: 0, deep: { starts: [], clean: 0, deaths: [] } } as unknown as WorldMemory['work'];
  return w;
}

/** The yard's fence ring (posts a block over the ground), as the bridge reads it: built, for the site search's clearance. */
const fenced = (w: WorldMemory) => (p: Pos) => {
  const y = w.yard!;
  return p.y === y.y + 1 && p.x >= y.x1 && p.x <= y.x2 && p.z >= y.z1 && p.z <= y.z2 && (p.x === y.x1 || p.x === y.x2 || p.z === y.z1 || p.z === y.z2);
};

/**
 * The homestead as the tools answer: the chests (world.chestItems, as take-from-chest replies say what is left), the
 * pockets, the ground (grass at 62, dirt under, air over, the yard's fence on its ring; what is built over that), the
 * crafts and the furnace (sand to glass). What it did, in order, in `did`.
 */
function home(world: WorldMemory, items: InventoryItem[]) {
  const did: string[] = [];
  const inv = items.map(i => ({ ...i }));
  const placed = new Map<string, string>();
  const fence = fenced(world);
  const get = (p: Pos) => placed.get(fmt(p)) ?? (p.y < GROUND ? 'minecraft:dirt' : p.y === GROUND ? 'minecraft:grass_block' : fence(p) ? 'minecraft:oak_fence' : 'minecraft:air');
  const pocket = () => { for (let i = 0; i < 36; i++) if (!inv.some(x => x.slot === i)) return i; return -1; };
  const give = (name: string, n: number) => {
    if (n <= 0) return;
    if (/_bed$/.test(name)) { for (let i = 0; i < n; i++) inv.push({ slot: pocket(), name, count: 1 }); return; }
    const has = inv.find(x => x.slot < 36 && x.name === name);
    if (has) has.count += n; else inv.push({ slot: pocket(), name, count: n });
  };
  const take = (name: string, n: number) => {
    let left = n;
    for (const x of inv.filter(i => i.slot < 36 && i.name === name)) { const k = Math.min(left, x.count); x.count -= k; left -= k; }
    for (let i = inv.length - 1; i >= 0; i--) if (inv[i].count <= 0) inv.splice(i, 1);
  };
  const carried = (name: string) => inv.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
  const holds = (k: string) => `It holds: ${Object.entries(world.chestItems![k]).filter(([, c]) => c > 0).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing'}; 20/54 slots free.`;
  const ctx = {
    s: lookAt(inv, 1000), world, signal: new AbortController().signal, progress: (text: string) => { did.push(`progress ${text}`); }, gain: () => undefined,
    builds: () => LIVE_BUILDS,
    status: async () => ({ inWorld: true, username: 'claudebot', screen: null, position: HOME, dimension: 'overworld' }),
    call: async (m: string, p: Record<string, unknown> = {}) => {
      const pos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
      if (m === 'inventory') return { items: inv.map(i => ({ ...i })) };
      if (m === 'status') return { position: HOME, dimension: 'overworld' };
      if (m === 'world.region') {
        const blocks: string[] = [];
        for (let y = 0; y < Number(p.height ?? 1); y++) for (let z = 0; z < Number(p.length ?? 1); z++) for (let x = 0; x < Number(p.width ?? 1); x++) blocks.push(get({ x: pos.x + x, y: pos.y + y, z: pos.z + z }));
        return { blocks };
      }
      if (m === 'foreign.zones') return { zones: [] };
      did.push(`call ${m}`);
      return {};
    },
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const pos = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      if (tool === 'take-from-chest') {
        const k = `${pos.x},${pos.y},${pos.z}`;
        const there = world.chestItems![k] ?? {};
        const n = Math.min(Number(a.count), there[String(a.item)] ?? 0);
        there[String(a.item)] = (there[String(a.item)] ?? 0) - n;
        if (!there[String(a.item)]) delete there[String(a.item)];
        give(String(a.item), n);
        did.push(`take-from-chest ${a.item} x${n}`);
        return n ? { ok: true, text: `Took ${n} ${a.item} from the chest at ${fmt(pos)}. ${holds(k)}` } : { ok: false, text: `No ${a.item} in the chest at ${fmt(pos)}. ${holds(k)}` };
      }
      if (tool === 'craft-item') {
        const out = String(a.outputItem), times = Number(a.amount ?? 1);
        const r = CRAFTS[out];
        if (!r || Object.entries(r.from).some(([n, k]) => carried(n) < k * times)) { did.push(`craft-item ${out} failed`); return { ok: false, text: `missing ingredients for ${out}` }; }
        for (const [n, k] of Object.entries(r.from)) take(n, k * times);
        give(out, r.makes * times);
        did.push(`craft-item ${out} x${times}`);
        return { ok: true, text: `Crafted ${times} ${out}` };
      }
      if (tool === 'smelt-item') {
        const n = Number(a.inputCount);
        if (a.inputItem !== 'sand' || carried('sand') < n || !carried(String(a.fuelItem))) return { ok: false, text: 'nothing to smelt' };
        take('sand', n);
        take(String(a.fuelItem), 1);
        give('glass', n);
        did.push(`smelt-item sand x${n}`);
        return { ok: true, text: `Smelted ${n} glass` };
      }
      if (tool === 'build-structure') {
        const spec = a.spec as StructureSpec;
        // only what is not in place yet, as the real one places (a half-built hall's windows are not wanted twice)
        const there: string[] = [];
        spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((_, x) => there.push(get({ x: pos.x + x, y: pos.y + y, z: pos.z + z })))));
        const left = billLeft(spec, there, { width: spec.layers[0][0].length, length: spec.layers[0].length });
        for (const [n, k] of Object.entries(left)) if (carried(n) < k) return { ok: false, text: `Failed: Not enough blocks to build it. Missing: ${n} ${carried(n)}/${k}` };
        for (const [n, k] of Object.entries(left)) take(n, k);
        spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((c, x) => {
          if (c !== ' ') placed.set(fmt({ x: pos.x + x, y: pos.y + y, z: pos.z + z }), c === '.' ? 'minecraft:air' : `minecraft:${spec.palette[c]}`);
        })));
        did.push(`build-structure ${a.name} at ${fmt(pos)}`);
        return { ok: true, text: `Built ${a.name} at ${fmt(pos)} in 300s: all 317 blocks in place. Used: oak_planks x189, oak_log x12.` };
      }
      if (tool === 'level-area') { did.push(`level-area ${a.dryRun ? 'dry run ' : ''}${a.x1}..${a.x2}, ${a.z1}..${a.z2}`); return { ok: true, text: a.dryRun ? 'Plan: fill 0 dirt + 0 cobblestone' : 'Now level' }; }
      did.push(`act ${tool}`);
      return { ok: false, text: `unexpected ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, did, inv, get, set: (p: Pos, block: string) => placed.set(fmt(p), block), carried, look: () => lookAt(inv, 1000) };
}

/** The kit the bot carries, and the hall's planks and logs out of the chests already (the build's own making is buildStep's). */
const kit = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_pickaxe', count: 1 }, { slot: 1, name: 'diamond_sword', count: 1 }, { slot: 2, name: 'torch', count: 19 }, { slot: 3, name: 'bread', count: 32 },
  ...[4, 5, 6, 7, 8].map(slot => ({ slot, name: 'oak_planks', count: 64 })), { slot: 9, name: 'oak_log', count: 16 }
];

/** Cells strictly between two footprints, along the axis they are apart on (the more of the two). */
const gap = (a: { x: number; z: number; width: number; length: number }, b: { x: number; z: number; width?: number; length?: number }) => Math.max(
  b.x - (a.x + a.width), a.x - (b.x + (b.width ?? 1)), b.z - (a.z + a.length), a.z - (b.z + (b.length ?? 1)));

/** The site rules, as the brief has them: the pens 8 off, the portal 6, every other zone and build 4, 2 clear inside the fence. */
function siteKeeps(t: import('ava').ExecutionContext, w: WorldMemory, site: { x: number; z: number; width: number; length: number }, builds: Rect[] = LIVE_BUILDS) {
  const y = w.yard!;
  t.is(site.width * site.length, 99);
  t.true(site.x - y.x1 - 1 >= 2 && y.x2 - (site.x + site.width - 1) - 1 >= 2 && site.z - y.z1 - 1 >= 2 && y.z2 - (site.z + site.length - 1) - 1 >= 2, `2 clear inside the fence: ${JSON.stringify(site)}`);
  for (const [kind, zs] of Object.entries(w.zones!)) {
    if (kind === 'fence' || kind.startsWith('fence:')) continue;
    const want = /^pen:/.test(kind) ? FROM_PENS : /^portal/.test(kind) ? FROM_PORTAL : FROM_BUILDS;
    for (const z of zs) t.true(gap(site, z) >= want, `${kind} at ${fmt(z)}: ${gap(site, z)} < ${want}`);
  }
  for (const b of builds) t.true(gap(site, b) >= FROM_BUILDS, `the build at ${fmt({ ...b, y: 0 })}: ${gap(site, b)}`);
}

// ------------------------------------------------------------------------------------------------ the site

test('the live yard: the hall\'s site 8 from both pens, 6 from the portal, 4 from every other zone and the improvement runs\' builds, 2 clear inside the fence; nearest home, no growth needed', (t) => {
  t.deepEqual([FROM_PENS, FROM_PORTAL, FROM_BUILDS], [8, 6, 4]);
  const w = afterPortal();
  const y = w.yard!;
  const box = { x: y.x1, y: y.y - 1, z: y.z1, width: y.x2 - y.x1 + 1, height: 7, length: y.z2 - y.z1 + 1 };
  const fence = fenced(w);
  const blocks: string[] = [];
  for (let dy = 0; dy < box.height; dy++) for (let dz = 0; dz < box.length; dz++) for (let dx = 0; dx < box.width; dx++) {
    const p = { x: box.x + dx, y: box.y + dy, z: box.z + dz };
    blocks.push(p.y < y.y ? 'minecraft:dirt' : p.y === y.y ? 'minecraft:grass_block' : fence(p) ? 'minecraft:oak_fence' : 'minecraft:air');
  }
  const grid = occupancy(box, blocks, y.y);
  const site = hallSite(grid, hallAvoid(w.zones, [], LIVE_BUILDS), HOME)!;
  t.truthy(site);
  siteKeeps(t, w, site);
  // the north end, by the tree farm and short of the portal: 48 from home
  t.like(site, { x: -561, z: 2131, width: 11, length: 9, rotated: false });
  // its gate toward home (south), its panel toward the yard's nearest gate (the north gate at (-549, 63, 2119))
  t.is(sideToward(site, HOME), 'south');
  t.is(panelToward(site, w, HOME), 'north');
  // the yard as it stands has the lights round's ground torches at the north end (placed-blocks.json, Nov 15), and a
  // torch counts as built: two stand on that spot. The site the bot will choose live is 5 north and 1 west of it, its
  // west wall 2 in from the fence (the least findSite allows), the same rules kept, the same sides
  const torches = [[-539, 2126], [-546, 2134], [-546, 2138], [-547, 2123], [-547, 2140], [-548, 2134], [-548, 2138], [-548, 2142], [-549, 2136], [-549, 2144],
    [-551, 2143], [-552, 2137], [-554, 2121], [-554, 2145], [-555, 2138]];
  const lit = [...blocks];
  for (const [x, z] of torches) lit[(x - box.x) + (z - box.z) * box.width + (y.y + 1 - box.y) * box.width * box.length] = 'minecraft:torch';
  const live = hallSite(occupancy(box, lit, y.y), hallAvoid(w.zones, [], LIVE_BUILDS), HOME)!;
  t.like(live, { x: -562, z: 2126, width: 11, length: 9, rotated: false });
  siteKeeps(t, w, live);
  t.is(live.x - y.x1 - 1, 2, 'the west wall 2 in from the fence');
  t.is(sideToward(live, HOME), 'south');
  t.is(panelToward(live, w, HOME), 'north');
  // the builds the brain gives (structureSiteBoxes, 66bf702): the five, not the homestead cleanup's whole-yard box,
  // which kept off would leave no room in the yard at all
  const store = [{ homeStorage: true, b: { x: -567, z: 2117, width: 37, length: 101 } }, ...LIVE_BUILDS.map(b => ({ homeStorage: false, b }))];
  t.deepEqual(structureSiteBoxes(store, s => s.b), LIVE_BUILDS);
  t.is(hallSite(grid, hallAvoid(w.zones, [], store.map(s => s.b)), HOME), null);
  // on the zones alone, kept from the zones as well
  const zonesOnly = hallSite(grid, hallAvoid(w.zones, []), HOME)!;
  siteKeeps(t, w, zonesOnly, []);
  // the paddings: the pens' 8, the portal's 6, the rest 4, findSite's own 2 taken off; the fence and the hall's own left out
  const zones = { 'pen:cow': [{ x: 0, y: 62, z: 0, width: 7, length: 7 }], portal: [{ x: 20, y: 62, z: 0, width: 6, length: 3 }], plot: [{ x: 40, y: 62, z: 0, width: 9, length: 9 }],
    'storage:door': [{ x: 60, y: 63, z: 0 }], fence: [{ x: -10, y: 62, z: -10, width: 100, length: 100 }], 'fence:gate': [{ x: 5, y: 63, z: -10 }], hall: [{ x: 70, y: 62, z: 0, width: 11, length: 9 }] };
  t.deepEqual(hallAvoid(zones, [{ x: 80, z: 0, width: 7, length: 7 }], [{ x: 90, z: 0, width: 5, length: 5 }]), [
    { x: -6, z: -6, width: 19, length: 19 }, { x: 16, z: -4, width: 14, length: 11 }, { x: 38, z: -2, width: 13, length: 13 }, { x: 58, z: -2, width: 5, length: 5 },
    { x: 78, z: -2, width: 11, length: 11 }, { x: 88, z: -2, width: 9, length: 9 }
  ]);
});

test('the site step: kept in the milestone\'s data, off the builds its context gives; another milestone\'s kept site kept 4 off', async (t) => {
  const w = afterPortal();
  const h = home(w, kit());
  const st: MilestoneState = { step: 0, data: {} };
  t.deepEqual(await hallSiteStep.run(h.ctx, st), { status: 'done', text: 'the hall goes at (-561, 62, 2131), 11 x 9' });
  t.deepEqual(st.data.site, { x: -561, z: 2131, width: 11, length: 9, rotated: false, y: 62 });
  siteKeeps(t, w, st.data.site as Rect);
  t.deepEqual(await hallSiteStep.run(h.ctx, st), { status: 'done', text: 'site chosen' });
  // a milestone set aside midway keeps its site where the hall's south end would be: the hall moves north, 4 off it
  const kept = afterPortal();
  const other = { x: -557, z: 2137, width: 3, length: 3 };
  kept.progress!.aside = { other: { step: 1, data: { site: other } } };
  const st2: MilestoneState = { step: 0, data: {} };
  t.like(await hallSiteStep.run(home(kept, kit()).ctx, st2), { status: 'done' });
  t.like(st2.data.site, { x: -561, z: 2124 });
  t.is(gap(st2.data.site as Rect, other), FROM_BUILDS, JSON.stringify(st2.data.site));
});

test('no room in the yard: it grows the yard as a site step does, at most twice, then waits and says why', async (t) => {
  // a yard with every zone as it is and a build over all of it: nowhere for the hall
  const full = (w: WorldMemory) => ({ ...home(w, kit()).ctx, builds: () => [{ x: -565, z: 2119, width: 33, length: 97 }] }) as GoalContext;
  const w = afterPortal();
  const st: MilestoneState = { step: 0, data: {} };
  const r = await hallSiteStep.run(full(w), st);
  // the growth: a strip beside the yard levelled (nothing to fill in the fake), the yard bigger, the fence to move
  t.like(r, { status: 'progress' });
  t.regex(r.text, /^grew the yard to the (north|south|east|west)/);
  t.is(st.data.grown, 1);
  t.truthy(w.fenceMove);
  t.is(st.data.site, undefined);
  // grown twice already: no more, whatever room a growth would make
  const w2 = afterPortal();
  const st2: MilestoneState = { step: 0, data: { grown: HALL_GROWS } };
  t.deepEqual(await hallSiteStep.run(full(w2), st2), {
    status: 'blocked', retryMs: 60 * MINUTE,
    text: 'no room in the yard for the hall (11 x 9 on plain ground, 8 from the pens, 6 from the portal, 4 from every other build), and it has grown 2 times for it already'
  });
  t.is(w2.fenceMove, undefined);
  t.is(st2.data.site, undefined);
});

// ------------------------------------------------------------------------------------------------ the milestone

test('the hall milestone comes after the nether portal, the last of the tree but the brewing and the wart farm (P4) and the netherite (P6), after the workshop; its steps in order; with the portal done it is next', (t) => {
  const m = TREE.find(x => x.id === 'hall')!;
  t.is(m.id, 'hall');
  t.is(m.title, 'a villager hall');
  t.deepEqual(m.prereqs, ['workshop']);
  t.is(TREE.findIndex(x => x.id === 'nether-portal'), TREE.indexOf(m) - 1);
  t.deepEqual(TREE.slice(TREE.indexOf(m) + 1).map(x => x.id), ['brewing', 'wart-farm', 'netherite']);
  t.deepEqual(m.steps.map(s => s.name), ['find room for the hall', 'the beds and the windows\' glass', 'build the villager hall']);
  t.deepEqual(hallMilestone(['workshop']).steps.map(s => s.name), m.steps.map(s => s.name));
  t.is(TREE.filter(x => x.id === 'hall').length, 1);
  t.is(projectGoal(TREE).wants(lookAt(kit(), 1000), afterPortal()), 'a villager hall: find room for the hall');
  // with the workshop done and the portal not yet, the portal goes first (it is earlier in the tree)
  const before = afterPortal();
  before.progress!.done = before.progress!.done.filter(d => d !== 'nether-portal');
  delete before.zones!['portal:lit'];
  t.regex(projectGoal(TREE).wants(lookAt(kit(), 1000), before) ?? '', /^a nether portal: /);
});

test('the live homestead: a site, the beds made of string-made wool (the sheep pen empty, the leads\' string kept) and the glass of sand, the build; "a villager hall complete", every landmark\'s zone on its block', async (t) => {
  const world = afterPortal();
  const h = home(world, kit());
  const goal = projectGoal(TREE);
  const run = async () => goal.run({ ...h.ctx, s: h.look() });
  const m = TREE.find(x => x.id === 'hall')!;

  t.is(await run(), 'a villager hall - find room for the hall: the hall goes at (-561, 62, 2131), 11 x 9');
  t.is(await run(), 'a villager hall - the beds and the windows\' glass: 3 white_bed and 4 glass for the hall');
  // the chests' two white wool and seven more of 28 string, the beds at the table; four of the nine sand smelted
  t.true(h.did.includes('craft-item white_wool x7'), h.did.join(' | '));
  t.true(h.did.includes('craft-item white_bed x3'));
  t.true(h.did.includes('smelt-item sand x4'));
  t.is(world.chestItems![MOBDROPS].string, 33, 'the leads\' five and more left');
  t.false('white_wool' in world.chestItems![MISC], 'its two wool taken');
  t.is(h.carried('white_bed'), 3);
  t.is(h.carried('glass'), 4);
  t.true(h.did.includes('progress the hall\'s beds: 7 white wool made of 28 string'));
  // kept carried for the build: the stash leaves them
  t.deepEqual(world.progress!.carry, ['white_bed', 'glass']);
  t.false(m.done!({ s: h.look(), world, have: () => 0 }));

  t.is(await run(), 'a villager hall complete');
  const st = world.progress!;
  t.true(st.done.includes('hall'));
  t.is(st.current, undefined);
  t.true(st.journal.some(j => j.text === 'done: a villager hall'));
  t.true(h.did.includes('build-structure villager-hall at (-561, 62, 2131)'), 'from the ground layer (groundOffset 0), nothing placed in it');
  t.true(h.did.includes('craft-item fletching_table x1'));
  t.true(m.done!({ s: h.look(), world, have: () => 0 }));
  const z = world.zones!;
  const block = (p: Pos) => h.get(p).replace(/^minecraft:/, '');
  t.deepEqual(z.hall, [{ x: -561, y: 62, z: 2131, width: 11, length: 9 }]);
  // the gate in the south wall toward home, the panel in the north wall toward the north gate
  t.deepEqual(z['hall:gate'], [{ x: -556, y: 63, z: 2139 }]);
  t.is(block(z['hall:gate'][0]), 'oak_fence_gate[facing=south]');
  t.is(block({ x: -556, y: 64, z: 2139 }), 'air');
  t.deepEqual(z['hall:panel'], [{ x: -556, y: 63, z: 2131 }, { x: -556, y: 64, z: 2131 }]);
  for (const p of z['hall:panel']) t.is(block(p), 'oak_planks');
  t.is(z['hall:bed'].length, 3);
  for (const p of z['hall:bed']) t.is(block(p), 'white_bed[facing=north,part=head]');
  for (const p of z['hall:bed-foot']) t.is(block(p), 'white_bed[facing=north,part=foot]');
  t.is(block(z['hall:lectern'][0]), 'air');
  t.is(block(z['hall:fletching'][0]), 'fletching_table');
  t.is(block(z['hall:inside'][0]), 'air');
  t.is(block({ ...z['hall:inside'][0], y: 62 }), 'grass_block', 'the floor: the yard\'s grass, left as it was');
  for (const p of z['hall:torch']) t.is(block(p), 'torch');
  // a gate the shelter shuts and the pens' walks keep clear of, as every `:gate` zone is
  t.true(Object.keys(z).filter(k => /:(gate|door)$/.test(k)).includes('hall:gate'));
  t.is(world.progress!.carry, undefined);
  // the hall's part of the tree done with it: the brewing (P4) is next, and it waits on a blaze rod from the fortress
  t.is(goal.wants(h.look(), world), 'a brewing stand: a blaze rod from the fortress');
});

test('the beds wait for the sheep pen\'s wool while it has sheep (no string spent), three times, then the string; the glass is made meanwhile', async (t) => {
  const world = afterPortal();
  (world.work as unknown as { pen: Record<string, unknown> }).pen.sheep = { adults: 3, babies: 1, at: T0 - MINUTE };
  const h = home(world, kit());
  const st: MilestoneState = { step: 1, data: { site: { x: -561, z: 2131, width: 11, length: 9, rotated: false, y: 62 } } };
  for (let i = 1; i <= WOOL_WAITS; i++) {
    t.deepEqual(await makingsStep.run(h.ctx, st), {
      status: 'blocked', retryMs: 20 * MINUTE,
      text: `waiting for the sheep pen's wool (2 white wool carried and stored, 7 more for 3 beds): wait ${i} of ${WOOL_WAITS}, then string`
    });
    t.is(st.data.woolWaits, i);
  }
  t.false(h.did.some(d => /white_wool|string/.test(d)), h.did.join(' | '));
  t.true(h.did.includes('smelt-item sand x4'), 'the glass all the same');
  t.like(await makingsStep.run(h.ctx, st), { status: 'done', text: '3 white_bed and 4 glass for the hall' });
  t.true(h.did.includes('craft-item white_wool x7'));
  // the sheared wool in the chests meanwhile: beds of that, no string
  const w2 = afterPortal();
  (w2.work as unknown as { pen: Record<string, unknown> }).pen.sheep = { adults: 3, babies: 0, at: T0 - MINUTE };
  w2.chestItems![MISC].white_wool = 9;
  const h2 = home(w2, kit());
  const st2: MilestoneState = { step: 1, data: {} };
  t.like(await makingsStep.run(h2.ctx, st2), { status: 'done' });
  t.false(h2.did.some(d => /craft-item white_wool|take-from-chest string/.test(d)), h2.did.join(' | '));
  t.is(st2.data.bed, 'white_bed');
});

test('the leads\' string: beds that would leave under five are not made; nothing taken out, the shortfall said, and prepare keeps the share for any craft of string but a lead', async (t) => {
  const world = afterPortal();
  world.chestItems![MOBDROPS].string = 30;
  const h = home(world, kit());
  const st: MilestoneState = { step: 1, data: {} };
  const r = await makingsStep.run(h.ctx, st);
  t.like(r, { status: 'blocked', need: { string: 3 } });
  t.regex(r.text, /^the beds' wool: 7 white wool to make of 28 string, 30 there and 5 kept for the leads: short of 3 string/);
  t.false(h.did.some(d => /string|white_wool|white_bed/.test(d)), h.did.join(' | '));
  t.is(world.chestItems![MOBDROPS].string, 30);
  // prepare on its own: wool of string leaves five (32 for 7 wool: 28 and 5 is 33)
  world.chestItems![MOBDROPS].string = 32;
  delete world.chestItems![MISC].white_wool;
  t.deepEqual(await prepare(h.ctx, 'white_wool', 7), { string: 1 });
  t.false(h.did.some(d => /take-from-chest string/.test(d)));
  world.chestItems![MOBDROPS].string = 33;
  t.deepEqual(await prepare(h.ctx, 'white_wool', 7), {});
  t.is(world.chestItems![MOBDROPS].string, 5);
  // the leads themselves are what the five are for (the two stored taken out first: none left to take)
  delete world.chestItems!['-547,64,2182'].lead;
  t.deepEqual(await prepare(h.ctx, 'lead', 2), {});
  t.true(h.did.includes('craft-item lead x1'));
  t.is(h.carried('lead'), 2);
  t.false('string' in world.chestItems![MOBDROPS], 'the five went into them');
});

// ------------------------------------------------------------------------------------------------ the windows' glass

test('the windows\' glass with the live stores\' 3 sand (Nov 15): the 3 smelted, the 1 sand short written where the stock trips read it, and a trip wants it; once it is home, the glass is made', async (t) => {
  const world = afterPortal();
  world.chestItems![STONE].sand = 3;
  const h = home(world, kit());
  const goal = projectGoal(TREE);
  const run = async () => goal.run({ ...h.ctx, s: h.look() });
  t.is(await run(), 'a villager hall - find room for the hall: the hall goes at (-561, 62, 2131), 11 x 9');
  // the sand there smelted, and the one more it takes named as sand (a glass a sand), not glass: no stock row fetches glass
  t.is(await run(), 'a villager hall - the beds and the windows\' glass: the windows\' glass: short of 1 sand');
  t.true(h.did.includes('smelt-item sand x3'), h.did.join(' | '));
  t.is(h.carried('glass'), 3);
  // and the glass still to smelt (no stock row fetches it): the hall's turn at the furnace between two ore batches
  t.deepEqual(world.progress!.need, { sand: 1, glass: 1 });
  t.like(stockShort(h.look(), world).find(r => r.name === 'sand'), { short: 1 });
  // the trip brings sand home and serves the shortfall (chores.ts stock): the wait ends with it there, the last glass made
  world.chestItems![STONE].sand = 5;
  delete world.progress!.need!.sand;
  t.is(await run(), 'a villager hall - the beds and the windows\' glass: 3 white_bed and 4 glass for the hall');
  t.true(h.did.includes('smelt-item sand x1'));
  t.is(h.carried('glass'), 4);
  t.is(world.progress!.need, undefined);
  t.false(stockShort(h.look(), world).some(r => r.name === 'sand'));
});

test('the windows\' glass with its sand there and the furnace smelting none of it (busy with someone\'s ore): no trip, it says why and waits', async (t) => {
  const world = afterPortal();
  const h = home(world, kit());
  const act = h.ctx.act;
  const ctx = { ...h.ctx, act: async (tool: string, a: Record<string, unknown>) => (tool === 'smelt-item' ? { ok: false, text: 'Furnace input slot is occupied by raw_iron' } : act(tool, a)) } as GoalContext;
  const st: MilestoneState = { step: 1, data: { site: { x: -561, z: 2131, width: 11, length: 9, rotated: false, y: 62 } } };
  t.deepEqual(await makingsStep.run(ctx, st), {
    status: 'blocked', retryMs: 10 * MINUTE, text: 'the windows\' glass: the furnace smelted none of the sand there (busy with something else?)'
  });
  // the glass still to smelt, for the hall's turn at the furnace: no stock row fetches it
  t.deepEqual(world.progress!.need, { glass: 4 });
  t.false(stockShort(h.look(), world).some(r => r.name === 'sand'));
});

test('the build with the windows\' glass gone since the makings step (a trip\'s stash, a build job\'s panes): smelted again, as much as is short, or the sand named for the trips; with two placed and two carried, none', async (t) => {
  const beds = [10, 11, 12].map(slot => ({ slot, name: 'white_bed', count: 1 }));
  const site = { x: -561, z: 2131, width: 11, length: 9, rotated: false, y: 62 };
  const atBuild = (glass: number) => {
    const world = afterPortal();
    const data = { site: { ...site }, bed: 'white_bed' };
    world.progress!.current = { id: 'hall', step: 2, data };
    const h = home(world, [...kit(), ...beds, ...(glass ? [{ slot: 13, name: 'glass', count: glass }] : [])]);
    const run = () => TREE.find(m => m.id === 'hall')!.steps[2].run({ ...h.ctx, s: h.look() }, world.progress!.current!);
    return { world, h, run };
  };
  // all four gone, the chests' sand there: the four smelted again, then the build
  const a = atBuild(0);
  t.deepEqual(await a.run(), { status: 'progress', text: 'smelted 4 glass again for the hall\'s windows' });
  t.true(a.h.did.includes('smelt-item sand x4'), a.h.did.join(' | '));
  t.false(a.h.did.some(d => /^build-structure/.test(d)));
  t.deepEqual(await a.run(), { status: 'done', text: 'villager hall built at (-561, 62, 2131)' });
  // gone, and no sand: the sand for the trips to fetch (progress.need), not glass that no trip fetches
  const b = atBuild(0);
  delete b.world.chestItems![STONE].sand;
  t.deepEqual(await b.run(), { status: 'blocked', retryMs: 3 * MINUTE, text: 'the windows\' glass: short of 4 sand', need: { sand: 4 } });
  t.deepEqual(b.world.progress!.need, { sand: 4, glass: 4 });
  t.like(stockShort(b.h.look(), b.world).find(r => r.name === 'sand'), { short: 4 });
  // the west wall's two windows in already and the other two carried: what it has placed is no reason to smelt more
  const c = atBuild(2);
  for (const z of [2133, 2137]) c.h.set({ x: -561, y: 64, z }, 'minecraft:glass');
  t.deepEqual(await c.run(), { status: 'done', text: 'villager hall built at (-561, 62, 2131)' });
  t.false(c.h.did.some(d => /smelt-item/.test(d)), c.h.did.join(' | '));
  t.is(c.h.carried('glass'), 0);
});

test('the windows\' glass takes the furnace\'s turn between two ore batches once its sand is home: the glass still to smelt written with the sand (its need named only the sand, or nothing, and the hall\'s 4 glass waited behind every batch)', async (t) => {
  const world = afterPortal();
  delete world.chestItems![STONE].sand;
  const h = home(world, kit());
  const goal = projectGoal(TREE);
  const at = (min: number) => lookAt(h.inv, 1000, { now: T0 + min * MINUTE });
  const run = async (min = 0) => goal.run({ ...h.ctx, s: at(min) });
  t.is(await run(), 'a villager hall - find room for the hall: the hall goes at (-561, 62, 2131), 11 x 9');
  t.is(await run(), 'a villager hall - the beds and the windows\' glass: the windows\' glass: short of 4 sand');
  t.deepEqual(world.progress!.need, { sand: 4, glass: 4 });
  // a deep trip's raw iron home, and the smelt's first batch of it loaded (chores.ts smelt): the sand still to come,
  // so no turn, nothing it could smelt
  h.inv.push({ slot: 20, name: 'raw_iron', count: 108 });
  world.lastDone = { ...world.lastDone, furnace: T0 + 2 * MINUTE, oreBatch: T0 + 2 * MINUTE };
  t.true(goal.urgency!(at(5), world) < smelt.priority);
  // the trip brings it home and serves its row (chores.ts stock): the glass is left, and the hall goes before the next batch
  world.chestItems![STONE].sand = 4;
  delete world.progress!.need!.sand;
  t.is(goal.urgency!(at(5), world), FURNACE_TURN);
  t.is(decide(at(5), world, [smelt, goal], new Map())?.goal.name, 'project');
  t.is(await run(5), 'a villager hall - the beds and the windows\' glass: 3 white_bed and 4 glass for the hall');
  t.true(h.did.includes('smelt-item sand x4'), h.did.join(' | '));
  // its turn had: the next batch
  t.is(decide(at(6), world, [smelt, goal], new Map())?.goal.name, 'smelt');
});

// ------------------------------------------------------------------------------------------------ done, and the bot's own bed

const yardWorld = (over: Partial<WorldMemory> = {}): WorldMemory =>
  ({ landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: 0, z1: 0, x2: 40, z2: 40, y: GROUND }, zones: {}, progress: { done: [], journal: [] }, ...over }) as WorldMemory;
/** The landmarks round home as the look finds them in a box at the floor's height. */
const looked = (blocks: [Pos, string][], home = { x: 20, y: GROUND + 1, z: 20 }) => {
  const box = { x: -10, y: GROUND + 1, z: -10, width: 70, height: 1, length: 70 };
  const cells: (string | null)[] = new Array(box.width * box.length).fill('minecraft:air');
  for (const [p, b] of blocks) cells[(p.x - box.x) + (p.z - box.z) * box.width] = b;
  return findLandmarks(box, cells, home);
};
const doneIn = (world: WorldMemory) => hallMilestone(['workshop']).done!({ s: lookAt([], 1000), world, have: () => 0 });
const bedAt = (x: number, z: number): [Pos, string] => [{ x, y: GROUND + 1, z }, 'minecraft:white_bed[facing=north,occupied=false,part=head]'];
const F = { x: 10, y: GROUND + 1, z: 4 };

test('findLandmarks: every bed\'s head, the nearest home first, and the nearest fletching table; none, and the keys are as they were', (t) => {
  const l = looked([bedAt(30, 30), bedAt(21, 21), [F, 'minecraft:fletching_table'], [{ x: 2, y: GROUND + 1, z: 2 }, 'minecraft:fletching_table'], [{ x: 21, y: GROUND + 1, z: 22 }, 'minecraft:white_bed[facing=north,part=foot]']]);
  t.deepEqual(l.beds, [{ x: 21, y: GROUND + 1, z: 21 }, { x: 30, y: GROUND + 1, z: 30 }]);
  t.deepEqual(l.bed, { x: 21, y: GROUND + 1, z: 21 });
  t.deepEqual(l.fletching, F);
  t.deepEqual(looked([[{ x: 1, y: GROUND + 1, z: 1 }, 'minecraft:crafting_table']]), { chests: [], farmland: [], bed: undefined, furnace: undefined, table: { x: 1, y: GROUND + 1, z: 1 } });
});

test('done: the hall\'s zone; or a fletching table with three beds round it standing in the yard (the improvement runs\' hall); not two beds, not out of the yard, not this milestone\'s own mid-build', (t) => {
  t.false(doneIn(yardWorld()));
  t.true(doneIn(yardWorld({ zones: { hall: [{ x: 2, y: GROUND, z: 2, width: 11, length: 9 }] } })));
  const room = [[F, 'minecraft:fletching_table'], bedAt(4, 4), bedAt(5, 4), bedAt(6, 4)] as [Pos, string][];
  t.true(doneIn(yardWorld({ landmarks: looked(room) })));
  t.false(doneIn(yardWorld({ landmarks: looked(room.slice(0, 3)) })), 'two beds');
  t.false(doneIn(yardWorld({ landmarks: looked([[F, 'minecraft:fletching_table'], bedAt(4, 4), bedAt(5, 4), bedAt(30, 30)]) })), 'the third bed in another room');
  t.false(doneIn(yardWorld({ landmarks: looked(room.slice(1)) })), 'beds alone');
  t.false(doneIn(yardWorld({ landmarks: looked(room), yard: { x1: 0, z1: 0, x2: 8, z2: 40, y: GROUND } })), 'the table outside the yard');
  // its own, the beds and the table placed before the roof: the look every 10 minutes must not end it half built
  const own = { x: 0, y: GROUND, z: 0, width: 11, length: 9, rotated: false };
  t.false(doneIn(yardWorld({ landmarks: looked(room), progress: { done: [], journal: [], current: { id: 'hall', step: 2, data: { site: own } } } })), 'its own, in hand');
  t.false(doneIn(yardWorld({ landmarks: looked(room), progress: { done: [], journal: [], aside: { hall: { step: 2, data: { site: own } } } } })), 'its own, set aside');
  t.true(doneIn(yardWorld({ landmarks: looked(room), progress: { done: [], journal: [], current: { id: 'nether-portal', step: 1, data: { site: own } } } })), 'another milestone\'s site is no reason');
  // a look only
  const w = yardWorld({ landmarks: looked(room), progress: { done: [], journal: [], current: { id: 'hall', step: 2, data: { site: own } } } });
  const before = JSON.stringify(w);
  t.false(hallStanding(w));
  doneIn(w);
  t.is(JSON.stringify(w), before);
});

test('the bot\'s own bed: the nearest home, unless it is one of the hall\'s, then the nearest that is not; none of its own, none', (t) => {
  const hallZone = { hall: [{ x: 18, y: GROUND, z: 18, width: 11, length: 9 }] };
  const l = looked([bedAt(20, 19), bedAt(21, 19), bedAt(35, 35)]);
  t.deepEqual(homeBed(l, yardWorld()), { x: 20, y: GROUND + 1, z: 19 });
  t.deepEqual(homeBed(l, yardWorld({ zones: hallZone })), { x: 35, y: GROUND + 1, z: 35 });
  t.is(homeBed(looked([bedAt(20, 19), bedAt(21, 19)]), yardWorld({ zones: hallZone })), undefined);
  // the hall's site while it is built counts as the hall's
  t.deepEqual(homeBed(l, yardWorld({ progress: { done: [], journal: [], current: { id: 'hall', step: 2, data: { site: { x: 18, z: 18, width: 11, length: 9 } } } } })), { x: 35, y: GROUND + 1, z: 35 });
  t.is(homeBed(looked([]), yardWorld({ zones: hallZone })), undefined);
});
