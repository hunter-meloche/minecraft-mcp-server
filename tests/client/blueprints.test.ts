import test from 'ava';
import { checkBuild, layoutSpec, LEAVE, parseState, splitDirectional, type StructureSpec } from '../../src/client/schematic.js';
import {
  billOf, caneStrip, chestPartner, cropPlot, enchantRoom, fenceRing, itemOf, mineStairs, pen, rotate, rotatePos, rotateSpec,
  rotateState, storageHouse, treeGrid, turn, type Blueprint, type Side
} from '../../src/client/brain/blueprints.js';
import type { Pos } from '../../src/client/survey.js';

/** The spec character at a cell ('.' past a short row, as layoutSpec pads). */
const cell = (spec: StructureSpec, p: Pos) => spec.layers[p.y]?.[p.z]?.[p.x] ?? '.';
const stateAt = (spec: StructureSpec, p: Pos) => spec.palette[cell(spec, p)];
const cellsOf = (spec: StructureSpec, test: (state: string) => boolean): Pos[] => {
  const out: Pos[] = [];
  spec.layers.forEach((l, y) => l.forEach((r, z) => [...r].forEach((ch, x) => {
    if (ch !== '.' && ch !== ' ' && test(spec.palette[ch])) out.push({ x, y, z });
  })));
  return out;
};
const key = (p: Pos) => `${p.x},${p.y},${p.z}`;

/**
 * The world as the game would have it once built: fences connected, gates and doors in whatever hinge/open state,
 * chests and the rest with every property; leave-cells hold grass.
 */
function builtWorld(bp: Blueprint): string[] {
  const s = layoutSpec(bp.spec);
  const states = new Map(Object.entries(s.palette).map(([st, i]) => [i, st]));
  return s.blocks.map(i => {
    const st = states.get(i)!;
    if (st === LEAVE) return 'minecraft:grass_block[snowy=false]';
    if (st === 'minecraft:air') return 'minecraft:air';
    const { id, props } = parseState(st);
    if (id === 'oak_fence') return 'minecraft:oak_fence[east=true,north=false,south=false,waterlogged=false,west=true]';
    if (id === 'oak_fence_gate') return `minecraft:oak_fence_gate[facing=${props.facing},in_wall=false,open=true,powered=false]`;
    if (id === 'oak_door') return `minecraft:oak_door[facing=${props.facing},half=${props.half},hinge=right,open=true,powered=false]`;
    if (id === 'chest') return `minecraft:chest[facing=${props.facing},type=${props.type},waterlogged=false]`;
    return st;
  });
}

const all = (): [string, Blueprint][] => [
  ['storageHouse', storageHouse()], ['storageHouse east', storageHouse({ doorSide: 'east', chests: 6 })],
  ['fenceRing', fenceRing({ width: 10, length: 8 }, [{ side: 'south', offset: 4 }])], ['pen', pen()],
  ['cropPlot', cropPlot()], ['treeGrid', treeGrid(3, 2)], ['caneStrip', caneStrip(5)], ['enchantRoom', enchantRoom()]
];

test('every blueprint lays out, and its size is the layout\'s', (t) => {
  for (const [name, bp] of all()) {
    const s = layoutSpec(bp.spec);
    t.deepEqual(bp.size, { width: s.width, height: s.height, length: s.length }, name);
    for (const r of bp.spec.layers.flat()) t.is(r.length, s.width, `${name}: rows are full width`);
    for (const l of bp.spec.layers) t.is(l.length, s.length, `${name}: layers are full length`);
  }
});

test('every built blueprint verifies with checkBuild (doors, gates, fences, chests in any extra state)', (t) => {
  for (const [name, bp] of all()) {
    const check = checkBuild(layoutSpec(bp.spec), builtWorld(bp));
    t.is(check.placed, check.total, name);
  }
});

test('storageHouse: 7 x 5 x 9, the bill, the door both halves', (t) => {
  const h = storageHouse();
  t.deepEqual(h.size, { width: 7, height: 5, length: 9 });
  t.is(h.groundOffset, 1);
  // walls: 24 planks a layer x 4, less the doorway's 2; roof 63
  t.deepEqual(h.bill, { oak_log: 16, oak_planks: 94 + 63, oak_door: 1, chest: 8, torch: 2 });
  t.deepEqual(layoutSpec(h.spec).counts, { oak_log: 16, oak_planks: 157, oak_door: 1, chest: 8, torch: 2 });
  t.deepEqual(h.entrances, [{ x: 3, y: 0, z: 8, facing: 'south' }]);
  t.is(stateAt(h.spec, { x: 3, y: 0, z: 8 }), 'oak_door[facing=south,half=lower]');
  t.is(stateAt(h.spec, { x: 3, y: 1, z: 8 }), 'oak_door[facing=south,half=upper]');
  t.is(stateAt(h.spec, { x: 3, y: 2, z: 8 }), 'oak_planks');
  // both door halves go to the hand-placed cells (Baritone gets structure_void there)
  const doors = splitDirectional(layoutSpec(h.spec)).cells.filter(c => c.id === 'oak_door');
  t.deepEqual(doors.map(c => c.y), [0, 1]);
  t.deepEqual(h.landmarks.filter(l => l.kind === 'door').map(l => l.at), [{ x: 3, y: 0, z: 8 }]);
  // the inside is cleared; the roof covers all of it
  t.is(cell(h.spec, { x: 2, y: 3, z: 4 }), '.');
  t.true(h.spec.layers[4].every(r => /^P+$/.test(r)));
});

function checkChests(t: import('ava').ExecutionContext, bp: Blueprint, doubles: number) {
  const chests = bp.landmarks.filter(l => l.kind === 'chest').map(l => l.at);
  t.is(chests.length, doubles * 2);
  t.deepEqual(cellsOf(bp.spec, s => /^chest/.test(s)).map(key).sort(), chests.map(key).sort());
  const at = new Set(chests.map(key));
  for (const c of chests) {
    const { props } = parseState(stateAt(bp.spec, c));
    const facing = props.facing as Side, type = props.type as 'left' | 'right';
    t.true(type === 'left' || type === 'right');
    const partner = chestPartner(c, facing, type);
    t.true(at.has(key(partner)), `chest at ${key(c)} has its partner`);
    const p = parseState(stateAt(bp.spec, partner)).props;
    t.is(p.facing, facing);
    t.is(p.type, type === 'left' ? 'right' : 'left');
    // it faces into the open aisle
    const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[facing];
    t.is(cell(bp.spec, { x: c.x + d[0], y: 0, z: c.z + d[1] }), '.', `chest at ${key(c)} faces the aisle`);
  }
}

test('storageHouse: chests pair up (left/right join), face the aisle, one landmark each', (t) => {
  checkChests(t, storageHouse(), 4);
  checkChests(t, storageHouse({ chests: 6 }), 6);
  checkChests(t, storageHouse({ chests: 3, doorSide: 'west' }), 3);
  checkChests(t, storageHouse({ chests: 5, doorSide: 'north' }), 5);
  t.false('chest' in storageHouse({ chests: 0 }).bill);
  t.throws(() => storageHouse({ chests: 7 }), { instanceOf: RangeError });
  // the west row's lower-z half is the left one (facing east, its partner is to the south)
  t.is(stateAt(storageHouse().spec, { x: 1, y: 0, z: 1 }), 'chest[facing=east,type=left]');
  t.is(stateAt(storageHouse().spec, { x: 5, y: 0, z: 1 }), 'chest[facing=west,type=right]');
});

test('storageHouse turns with its door side', (t) => {
  for (const side of ['north', 'east', 'west'] as Side[]) {
    const h = storageHouse({ doorSide: side });
    const e = h.entrances[0];
    t.is(e.facing, side);
    t.deepEqual(h.size, side === 'north' ? { width: 7, height: 5, length: 9 } : { width: 9, height: 5, length: 7 });
    t.is(stateAt(h.spec, e), `oak_door[facing=${side},half=lower]`);
    t.is(stateAt(h.spec, { ...e, y: 1 }), `oak_door[facing=${side},half=upper]`);
    // the door is in the middle of that wall
    const onWall = { north: e.z === 0, south: e.z === h.size.length - 1, east: e.x === h.size.width - 1, west: e.x === 0 }[side];
    t.true(onWall, side);
    t.is(side === 'north' || side === 'south' ? e.x : e.z, 3);
    t.deepEqual(h.bill, storageHouse().bill);
  }
  t.is(storageHouse({ doorSide: 'east' }).entrances[0].x, 8);
});

test('fenceRing 10 x 8 with one gate: 31 fences, 1 gate, torches every 6th post and at the corners', (t) => {
  const r = fenceRing({ width: 10, length: 8 }, [{ side: 'south', offset: 4 }]);
  t.deepEqual(r.size, { width: 10, height: 2, length: 8 });
  // clockwise from (0,0): torch indices 0 6 12 18 24 30, corners 0 9 16 25; the gate (4,7) is index 21
  t.deepEqual(r.bill, { oak_fence: 31, oak_fence_gate: 1, torch: 9 });
  t.is(stateAt(r.spec, { x: 4, y: 0, z: 7 }), 'oak_fence_gate[facing=south]');
  t.deepEqual(r.entrances, [{ x: 4, y: 0, z: 7, facing: 'south' }]);
  for (const c of [[0, 0], [9, 0], [9, 7], [0, 7]]) t.is(stateAt(r.spec, { x: c[0], y: 1, z: c[1] }), 'torch');
  // every torch stands on a fence post
  for (const p of cellsOf(r.spec, s => s === 'torch')) t.is(stateAt(r.spec, { ...p, y: 0 }), 'oak_fence');
  // inside and the rest of layer 1 are left as they are
  t.is(cell(r.spec, { x: 4, y: 0, z: 4 }), ' ');
  t.is(cell(r.spec, { x: 1, y: 1, z: 0 }), ' ');
  t.false(r.spec.layers.flat().join('').includes('.'));
  // fences are plain: connections are whatever the game makes
  t.is(r.spec.palette.F, 'oak_fence');
});

test('fenceRing: gates on every side face out; corners and offsets off the side are refused', (t) => {
  const r = fenceRing({ width: 6, length: 5 }, [
    { side: 'north', offset: 2 }, { side: 'east', offset: 1 }, { side: 'west', offset: 3 }
  ], 0);
  t.is(stateAt(r.spec, { x: 2, y: 0, z: 0 }), 'oak_fence_gate[facing=north]');
  t.is(stateAt(r.spec, { x: 5, y: 0, z: 1 }), 'oak_fence_gate[facing=east]');
  t.is(stateAt(r.spec, { x: 0, y: 0, z: 3 }), 'oak_fence_gate[facing=west]');
  t.deepEqual(r.bill, { oak_fence: 18 - 3, oak_fence_gate: 3, torch: 4 }); // torchEvery 0: corners only
  t.throws(() => fenceRing({ width: 6, length: 5 }, [{ side: 'north', offset: 0 }]), { instanceOf: RangeError });
  t.throws(() => fenceRing({ width: 6, length: 5 }, [{ side: 'east', offset: 4 }]), { instanceOf: RangeError });
  t.throws(() => fenceRing({ width: 6, length: 5 }, [{ side: 'north', offset: 2 }, { side: 'north', offset: 2 }]));
});

test('pen: a gate in the middle of its side, torches on the four corners only', (t) => {
  const p = pen(7, 'west');
  t.deepEqual(p.bill, { oak_fence: 23, oak_fence_gate: 1, torch: 4 });
  t.deepEqual(p.entrances, [{ x: 0, y: 0, z: 3, facing: 'west' }]);
  t.deepEqual(pen().entrances, [{ x: 3, y: 0, z: 6, facing: 'south' }]);
});

test('cropPlot: ground layer, the water hole dug, the rest landmarks to till', (t) => {
  const c = cropPlot();
  t.is(c.groundOffset, 0);
  t.deepEqual(c.size, { width: 9, height: 2, length: 9 });
  t.deepEqual(c.bill, { water_bucket: 1 });
  t.deepEqual(c.landmarks.filter(l => l.kind === 'water').map(l => l.at), [{ x: 4, y: 0, z: 4 }]);
  t.is(c.landmarks.filter(l => l.kind === 'till').length, 80);
  t.is(cell(c.spec, { x: 4, y: 0, z: 4 }), '.');
  t.is(cell(c.spec, { x: 3, y: 0, z: 4 }), ' ');
  t.true(c.spec.layers[1].every(r => /^\.+$/.test(r)));
  // nothing to place
  t.deepEqual(layoutSpec(c.spec).counts, {});
  const w = cropPlot(9, { watered: true });
  t.false(w.spec.layers.flat().join('').includes('.'));
  t.deepEqual(w.bill, {});
  t.throws(() => cropPlot(8), { instanceOf: RangeError });
});

test('treeGrid: sapling landmarks gap apart, nothing to build', (t) => {
  const g = treeGrid(3, 2, 3);
  t.deepEqual(g.size, { width: 9, height: 1, length: 5 });
  t.deepEqual(g.bill, { oak_sapling: 6 });
  t.deepEqual(g.landmarks.map(l => l.at.x + ',' + l.at.z), ['0,0', '4,0', '8,0', '0,4', '4,4', '8,4']);
  t.true(g.landmarks.every(l => l.kind === 'sapling' && l.at.y === 0));
  t.deepEqual(layoutSpec(g.spec).counts, {});
  t.deepEqual(treeGrid(2, 2, 2, 'birch_sapling').bill, { birch_sapling: 4 });
});

test('caneStrip: cane on z 0 beside water at z 1 in the ground layer', (t) => {
  const c = caneStrip(5);
  t.deepEqual(c.bill, { sugar_cane: 5 });
  t.deepEqual(c.size, { width: 5, height: 1, length: 2 });
  const cane = c.landmarks.filter(l => l.kind === 'cane').map(l => l.at);
  const water = c.landmarks.filter(l => l.kind === 'water').map(l => l.at);
  t.is(cane.length, 5);
  cane.forEach((p, i) => { t.deepEqual(p, { x: i, y: 0, z: 0 }); t.deepEqual(water[i], { x: i, y: -1, z: 1 }); });
});

test('enchantRoom: exactly 15 bookshelves at distance 2 with an air ring, the gap in front of the door', (t) => {
  const r = enchantRoom();
  t.deepEqual(r.size, { width: 7, height: 5, length: 7 });
  t.is(r.bill.bookshelf, 15);
  t.is(r.bill.enchanting_table, 1);
  t.is(r.bill.oak_door, 1);
  t.is(r.bill.torch, 4);
  t.is(stateAt(r.spec, { x: 3, y: 0, z: 3 }), 'enchanting_table');
  const shelves = cellsOf(r.spec, s => s === 'bookshelf');
  t.is(shelves.length, 15);
  t.is(r.landmarks.filter(l => l.kind === 'bookshelf').length, 15);
  for (const s of shelves) {
    const dx = s.x - 3, dz = s.z - 3;
    t.is(Math.max(Math.abs(dx), Math.abs(dz)), 2);
    t.is(s.y, 0);
    // vanilla checks the cell half way (rounded toward the table) is open
    t.is(cell(r.spec, { x: 3 + Math.trunc(dx / 2), y: 0, z: 3 + Math.trunc(dz / 2) }), '.');
  }
  t.is(cell(r.spec, { x: 3, y: 0, z: 5 }), '.'); // the way in
  t.deepEqual(r.entrances, [{ x: 3, y: 0, z: 6, facing: 'south' }]);
  const east = enchantRoom({ doorSide: 'east' });
  t.is(east.bill.bookshelf, 15);
  t.is(cell(east.spec, { x: 5, y: 0, z: 3 }), '.');
  t.is(stateAt(east.spec, { x: 6, y: 0, z: 3 }), 'oak_door[facing=east,half=lower]');
});

test('mineStairs: 2 wide, 3 high, down one a step, a 5 x 5 x 3 landing', (t) => {
  const m = mineStairs(10, 'north');
  t.is(m.steps, 10);
  t.is(m.dig.length, 10 * 2 * 3 + 75);
  t.is(new Set(m.dig.map(key)).size, m.dig.length);
  // step 1: one north, lanes x 0 (left) and x 1 (east, the right hand), y -1..1, top first
  t.deepEqual(m.dig.slice(0, 6), [
    { x: 0, y: 1, z: -1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: -1 },
    { x: 1, y: 1, z: -1 }, { x: 1, y: 0, z: -1 }, { x: 1, y: -1, z: -1 }
  ]);
  for (let i = 1; i <= 10; i++) {
    const step = m.dig.slice((i - 1) * 6, i * 6);
    t.true(step.every(p => p.z === -i && (p.x === 0 || p.x === 1) && p.y >= -i && p.y <= -i + 2));
  }
  const landing = m.dig.slice(60);
  t.true(landing.every(p => p.z <= -11 && p.z >= -15 && p.x >= -2 && p.x <= 2 && p.y >= -10 && p.y <= -8));
  t.deepEqual(m.landing, { x: 0, y: -10, z: -13 });
  // a torch at step 8 and one in the landing, each in a dug cell on a floor
  t.deepEqual(m.torches, [{ x: 1, y: -8, z: -8 }, { x: 0, y: -10, z: -15 }]);
  const dug = new Set(m.dig.map(key));
  for (const p of m.torches) t.true(dug.has(key(p)) && !dug.has(key({ ...p, y: p.y - 1 })));
  t.is(mineStairs(16, 'east').torches.length, 3);
  // east: forward is +x, the second lane south (+z)
  t.deepEqual(mineStairs(1, 'east').dig.slice(0, 6).map(key), ['1,1,0', '1,0,0', '1,-1,0', '1,1,1', '1,0,1', '1,-1,1']);
  t.deepEqual(mineStairs(1, 'west').dig[3], { x: -1, y: 1, z: -1 });
  t.throws(() => mineStairs(0, 'north'), { instanceOf: RangeError });
});

test('billOf maps blocks to items: wall torches, door and bed halves, double slabs, wall signs', (t) => {
  const spec: StructureSpec = {
    palette: {
      W: 'wall_torch[facing=north]', D: 'oak_door[facing=south,half=lower]', U: 'oak_door[facing=south,half=upper]',
      F: 'red_bed[facing=north,part=foot]', H: 'red_bed[facing=north,part=head]', S: 'oak_slab[type=double]',
      s: 'oak_slab[type=bottom]', G: 'oak_wall_sign[facing=east]', C: 'chest[facing=north,type=single]'
    },
    layers: [['WDFSsGCC'], ['WU.H    ']]
  };
  t.deepEqual(billOf(spec), { torch: 2, oak_door: 1, red_bed: 1, oak_slab: 3, oak_sign: 1, chest: 2 });
  t.is(itemOf('minecraft:water[level=0]'), 'water_bucket');
  t.is(itemOf('oak_log[axis=y]'), 'oak_log');
  t.throws(() => billOf({ palette: {}, layers: [['X']] }));
});

test('rotation: states, positions and specs turn clockwise; four turns change nothing', (t) => {
  t.is(turn('north', 1), 'east');
  t.is(turn('west', -1), 'south');
  t.is(rotateState('oak_stairs[facing=north,half=bottom]', 1), 'oak_stairs[facing=east,half=bottom]');
  t.is(rotateState('oak_log[axis=x]', 1), 'oak_log[axis=z]');
  t.is(rotateState('oak_log[axis=y]', 3), 'oak_log[axis=y]');
  t.is(rotateState('oak_fence[north=true,east=false]', 1), 'oak_fence[east=true,south=false]');
  t.is(rotateState('oak_planks', 1), 'oak_planks');
  // a 3 (x) x 2 (z) spec: row 0 'ABC', row 1 'DEF'; one turn clockwise puts the old west column on the north row
  const spec = { palette: { A: 'stone', B: 'dirt', C: 'sand', D: 'gravel', E: 'clay', F: 'glass' }, layers: [['ABC', 'DEF']] };
  t.deepEqual(rotateSpec(spec, 1).layers, [['DA', 'EB', 'FC']]);
  t.deepEqual(rotateSpec(spec, 2).layers, [['FED', 'CBA']]);
  t.deepEqual(rotateSpec(spec, 4), spec);
  t.deepEqual(rotatePos({ x: 0, y: 5, z: 0 }, { width: 3, length: 2 }, 1), { x: 1, y: 5, z: 0 });
  t.deepEqual(rotateSpec({ palette: {}, layers: [['', '  ']] }, 1).layers, [[' .', ' .']]); // short rows padded with air (old row 1 becomes the west column)
  const h = storageHouse();
  t.deepEqual(rotate(rotate(h, 1), 3), h);
  // a rotated landmark still points at the same spec cell
  const r = rotate(h, 1);
  for (const [i, l] of h.landmarks.entries()) t.is(rotateState(stateAt(h.spec, l.at), 1), stateAt(r.spec, r.landmarks[i].at));
});

test('billLeft: cells already holding their block cost nothing, whatever their state', async (t) => {
  const { billLeft } = await import('../../src/client/brain/blueprints.js');
  const spec = { palette: { F: 'minecraft:oak_fence', T: 'minecraft:torch' }, layers: [['FFF'], ['T  ']] };
  const blocks = ['minecraft:oak_fence[east=true,north=false]', 'air', 'air', 'air', 'air', 'air'];
  t.deepEqual(billLeft(spec, blocks, { width: 3, length: 1 }), { oak_fence: 2, torch: 1 });
});
