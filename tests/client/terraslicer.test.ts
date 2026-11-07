import test from 'ava';
import { diff, type Change } from '../../src/client/structures/diff.js';
import type { Cell } from '../../src/client/structures/format.js';
import { Voxels, canLeave, walkFrom, type Box, type P } from '../../src/client/structures/terraslicer/world.js';
import { digFrom, placeHit, placeRule, sightTo, eyeOf } from '../../src/client/structures/terraslicer/rules.js';
import { tasksFor } from '../../src/client/structures/terraslicer/tasks.js';
import { islands, objectOrder, slice } from '../../src/client/structures/terraslicer/slicer.js';
import { replay, unmatched } from '../../src/client/structures/terraslicer/simulate.js';
import { sliceText } from '../../src/client/structures/terraslicer/preview.js';
import { dropOf, planLoads, stackSize } from '../../src/client/structures/terraslicer/loads.js';
import type { Station } from '../../src/client/structures/terraslicer/slicer.js';

// ------------------------------------------------------------------------------------------------ helpers

/** Flat ground: stone below `top`, grass on it, air over it. readBox order: x fastest, then z, then y. */
function flat(b: Box, top = 63): string[] {
  const out: string[] = [];
  for (let y = b.y; y < b.y + b.height; y++) for (let z = b.z; z < b.z + b.length; z++) for (let x = b.x; x < b.x + b.width; x++) {
    out.push(y < top ? 'stone' : y === top ? 'grass_block' : 'air');
  }
  return out;
}

const BOX: Box = { x: -10, y: 58, z: -10, width: 26, height: 20, length: 26 };

/** The changes for some wanted cells against a world, as the diff makes them. */
function changesFor(v: Voxels, cells: Cell[]): Change[] {
  return diff(cells, cells.map(c => v.get(c.at) ?? null));
}

function cuboid(from: P, to: P, want: string, out: Cell[] = []): Cell[] {
  for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) for (let x = from.x; x <= to.x; x++) out.push({ at: { x, y, z }, want });
  return out;
}

function walls(from: P, to: P, want: string, out: Cell[] = []): Cell[] {
  for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) for (let x = from.x; x <= to.x; x++) {
    if (x === from.x || x === to.x || z === from.z || z === to.z) out.push({ at: { x, y, z }, want });
  }
  return out;
}

/** A 5x5 hut on the grass: plank floor (y 64), cobblestone walls (y 65-67) with a doorway and a door, a roof (y 68). */
function hut(): Cell[] {
  const cells: Cell[] = [];
  cuboid({ x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 4 }, 'oak_planks', cells);
  walls({ x: 0, y: 65, z: 0 }, { x: 4, y: 67, z: 4 }, 'cobblestone', cells);
  cuboid({ x: 0, y: 68, z: 0 }, { x: 4, y: 68, z: 4 }, 'oak_planks', cells);
  // the doorway: the door's two halves in place of the wall
  const door = cells.findIndex(c => c.at.x === 2 && c.at.y === 65 && c.at.z === 0);
  cells[door] = { at: { x: 2, y: 65, z: 0 }, want: 'oak_door[facing=north,half=lower,hinge=left,open=false]' };
  const top = cells.findIndex(c => c.at.x === 2 && c.at.y === 66 && c.at.z === 0);
  cells[top] = { at: { x: 2, y: 66, z: 0 }, want: 'oak_door[facing=north,half=upper,hinge=left,open=false]', second: true };
  cells.push({ at: { x: 1, y: 66, z: 1 }, want: 'wall_torch[facing=east]' });
  return cells;
}

/** Slice, replay, and check the result matches: the invariants every slice must keep. */
function sliceAndCheck(t: { deepEqual: (a: unknown, b: unknown, m?: string) => void; true: (a: boolean, m?: string) => void }, v: Voxels, cells: Cell[], start: P) {
  const changes = changesFor(v, cells);
  const path = slice(v, changes, start);
  const r = replay(v, path);
  t.deepEqual(r.problems, [], 'every step of the plan is possible as the mod does it');
  const left = new Set(path.stuck.map(s => `${s.at.x},${s.at.y},${s.at.z}`));
  t.deepEqual(unmatched(r.world, changes).filter(c => !left.has(`${c.at.x},${c.at.y},${c.at.z}`)).map(c => c.want), [], 'the replayed world matches the design');
  return { path, r, changes };
}

// ------------------------------------------------------------------------------------------------ rules

test('placeRule: lying logs on their axis, top halves high, wall torches on the block behind, doors and beds with their other half', t => {
  t.deepEqual(placeRule('oak_log[axis=x]').refs, ['east', 'west']);
  t.is(placeRule('oak_log[axis=y]').axis, 'y');
  const top = placeRule('oak_stairs[facing=west,half=top,shape=straight]');
  t.true(top.top);
  t.is(top.refs[0], 'up');
  t.is(top.look, 'west');
  t.deepEqual(placeRule('wall_torch[facing=north]').refs, ['south']);
  t.deepEqual(placeRule('torch').refs, ['down']);
  t.deepEqual(placeRule('lantern[hanging=true]').refs, ['up']);
  t.deepEqual(placeRule('oak_door[facing=south,half=lower]').extra, [{ x: 0, y: 1, z: 0 }]);
  t.deepEqual(placeRule('white_bed[facing=east,part=foot]').extra, [{ x: 1, y: 0, z: 0 }]);
  t.deepEqual(placeRule('sand').refs, ['down']);
  t.true(placeRule('sand').gravity);
  t.truthy(placeRule('stone_slab[type=double]').unsupported);
  t.is(placeRule('chest[facing=north]').look, 'south'); // a chest faces back at the player
  t.is(placeRule('oak_wall_sign[facing=west]').item, 'oak_sign');
});

test('placeHit: the face middle the mod clicks, a quarter low on a side, a quarter high for a top half', t => {
  t.deepEqual(placeHit({ x: 0, y: 64, z: 0 }, 'down'), { x: 0.5, y: 64, z: 0.5 });
  t.deepEqual(placeHit({ x: 0, y: 64, z: 0 }, 'east'), { x: 1, y: 64.25, z: 0.5 });
  t.deepEqual(placeHit({ x: 0, y: 64, z: 0 }, 'east', true), { x: 1, y: 64.75, z: 0.5 });
  t.deepEqual(placeHit({ x: 0, y: 64, z: 0 }, 'up'), { x: 0.5, y: 65, z: 0.5 });
});

test('digFrom: a block in the open is in sight; one behind a wall is not; never the floor underfoot', t => {
  const v = new Voxels(BOX, flat(BOX));
  v.set({ x: 3, y: 64, z: 0 }, 'cobblestone');
  t.true(digFrom(v, { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }));
  v.set({ x: 2, y: 64, z: 0 }, 'stone'); v.set({ x: 2, y: 65, z: 0 }, 'stone');
  v.set({ x: 3, y: 65, z: 0 }, 'stone'); v.set({ x: 3, y: 64, z: 1 }, 'stone'); v.set({ x: 3, y: 64, z: -1 }, 'stone');
  t.false(digFrom(v, { x: 0, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }), 'its only open face (east) faces away');
  t.false(digFrom(v, { x: 0, y: 64, z: 0 }, { x: 0, y: 63, z: 0 }));
  t.true(sightTo(v, eyeOf({ x: 0, y: 64, z: 0 }), { x: 0.5, y: 63.99, z: 1.5 }, { x: 0, y: 63, z: 1 }));
});

test('walking: up a block, down off a ledge, not through a wall; canLeave sees a closed room', t => {
  const v = new Voxels(BOX, flat(BOX));
  v.set({ x: 1, y: 64, z: 0 }, 'stone');
  const w = walkFrom(v, { x: 0, y: 64, z: 0 });
  t.true(Number.isFinite(w.cost[v.index({ x: 1, y: 65, z: 0 })]), 'onto the block');
  t.true(Number.isFinite(w.cost[v.index({ x: 2, y: 64, z: 0 })]), 'and off it');
  for (const c of walls({ x: 4, y: 64, z: 4 }, { x: 6, y: 65, z: 6 }, 'stone')) v.set(c.at, c.want);
  const room = { x: 4, y: 64, z: 4, width: 3, height: 2, length: 3 };
  t.false(canLeave(v, { x: 5, y: 64, z: 5 }, room));
  v.set({ x: 5, y: 64, z: 4 }, 'oak_door[facing=north,half=lower]'); v.set({ x: 5, y: 65, z: 4 }, 'oak_door[facing=north,half=upper]');
  t.true(canLeave(v, { x: 5, y: 64, z: 5 }, room), 'out through the door');
});

// ------------------------------------------------------------------------------------------------ tasks

test('tasksFor: farmland is dirt and the hoe; a replacement digs first; a flower is dug; water and double slabs are skipped', t => {
  const ch = (want: string, have: string, kind: Change['kind']): Change => ({ at: { x: 0, y: 64, z: 0 }, want, have, kind });
  t.deepEqual(tasksFor([ch('farmland', 'dirt', 'replace')]).tasks.map(x => [x.kind, x.item]), [['work', 'hoe']]);
  t.deepEqual(tasksFor([ch('farmland', 'air', 'place')]).tasks.map(x => [x.kind, x.state]), [['place', 'dirt'], ['work', 'farmland']]);
  const rep = tasksFor([ch('oak_log[axis=y]', 'cobblestone', 'replace')]).tasks;
  t.deepEqual(rep.map(x => x.kind), ['dig', 'place']);
  t.deepEqual(rep[1].needs, [rep[0].id]);
  t.deepEqual(tasksFor([ch('oak_planks', 'poppy', 'place')]).tasks.map(x => x.kind), ['dig', 'place']);
  t.deepEqual(tasksFor([ch('oak_planks', 'short_grass', 'place')]).tasks.map(x => x.kind), ['place'], 'grass is just replaced');
  t.is(tasksFor([ch('air', 'water', 'clear')]).skipped.length, 1);
  t.is(tasksFor([ch('stone_slab[type=double]', 'air', 'place')]).skipped.length, 1);
  t.deepEqual(tasksFor([ch('grass_block', 'air', 'place')]).tasks.map(x => x.state), ['dirt']);
});

// ------------------------------------------------------------------------------------------------ slicing

test('slice: a hut on flat ground needs no scaffold, every step checks out, and it ends outside', t => {
  const v = new Voxels(BOX, flat(BOX));
  const { path, r } = sliceAndCheck(t, v, hut(), { x: -4, y: 64, z: -4 });
  t.deepEqual(path.stuck, []);
  t.is(path.stats.scaffold, 0);
  t.true(path.stats.stations > 0 && path.stats.stations < 30, `${path.stats.stations} stations`);
  t.true(canLeave(r.world, r.end, { x: 0, y: 64, z: 0, width: 5, height: 5, length: 5 }), 'not shut in');
  t.regex(sliceText(path), /Terraslicer: 1 object\(s\), \d+ station\(s\): \d+ to place/);
});

test('slice: a closed box (no doorway) is built from outside: the bot never seals itself in', t => {
  const v = new Voxels(BOX, flat(BOX));
  const cells: Cell[] = [];
  cuboid({ x: 0, y: 64, z: 0 }, { x: 4, y: 64, z: 4 }, 'stone_bricks', cells);
  walls({ x: 0, y: 65, z: 0 }, { x: 4, y: 66, z: 4 }, 'stone_bricks', cells);
  cuboid({ x: 0, y: 67, z: 0 }, { x: 4, y: 67, z: 4 }, 'stone_bricks', cells);
  const { path, r } = sliceAndCheck(t, v, cells, { x: -4, y: 64, z: -4 });
  t.deepEqual(path.stuck, []);
  t.true(canLeave(r.world, r.end, { x: 0, y: 64, z: 0, width: 5, height: 4, length: 5 }));
});

test('slice: a pillar too tall to reach from the ground: it climbs on scaffold for the top and takes it down', t => {
  const v = new Voxels(BOX, flat(BOX));
  const cells = cuboid({ x: 0, y: 64, z: 0 }, { x: 0, y: 71, z: 0 }, 'stone_bricks');
  const { path, r } = sliceAndCheck(t, v, cells, { x: -3, y: 64, z: 0 });
  t.deepEqual(path.stuck, []);
  t.true(path.stats.scaffold > 0, 'scaffold went up');
  t.is(path.stats.scaffoldLeft, 0, 'and all of it came down');
  t.true(path.stations.some(s => s.actions.some(a => a.op === 'pillar')));
  // nothing of the scaffold left standing in the replayed world
  t.false([...Array(r.world.size).keys()].some(i => /scaffold=true/.test(r.world.stateAt(i))));
});

test('slice: a column 12 high: it pillars too high to step off, and digs its way down its pillar', t => {
  const v = new Voxels(BOX, flat(BOX));
  const cells = cuboid({ x: 0, y: 64, z: 0 }, { x: 0, y: 75, z: 0 }, 'stone_bricks');
  const { path, r } = sliceAndCheck(t, v, cells, { x: -3, y: 64, z: 0 });
  t.deepEqual(path.stuck, []);
  t.is(path.stats.scaffoldLeft, 0);
  t.true(path.stations.some(s => s.actions.some(a => a.op === 'descend')), 'it came down by digging');
  t.false([...Array(r.world.size).keys()].some(i => /scaffold=true/.test(r.world.stateAt(i))));
  t.is(r.end.y, 64, 'it ends on the ground');
});

test('slice: an eave over thin air gets a temporary block to start the row against, taken down after', t => {
  const v = new Voxels(BOX, flat(BOX));
  // a wall 3 high (y 64-66) along x, and a row of stairs sticking out north of its top (z -1, y 67): nothing under it
  const cells = cuboid({ x: 0, y: 64, z: 0 }, { x: 4, y: 66, z: 0 }, 'stone_bricks');
  for (let x = 0; x <= 4; x++) cells.push({ at: { x, y: 67, z: -1 }, want: 'oak_stairs[facing=south,half=bottom,shape=straight]' });
  const { path } = sliceAndCheck(t, v, cells, { x: -3, y: 64, z: -3 });
  t.deepEqual(path.stuck, []);
  t.true(path.stats.scaffold >= 1);
  t.is(path.stats.scaffoldLeft, 0);
});

test('slice: a replacement digs then places; farmland is dirt then tilled', t => {
  const v = new Voxels(BOX, flat(BOX));
  v.set({ x: 0, y: 64, z: 0 }, 'cobblestone');
  const cells: Cell[] = [{ at: { x: 0, y: 64, z: 0 }, want: 'oak_log[axis=y]' }, { at: { x: 2, y: 63, z: 0 }, want: 'farmland[moisture=0]' }];
  const { path } = sliceAndCheck(t, v, cells, { x: -3, y: 64, z: 0 });
  const ops = path.stations.flatMap(s => s.actions.map(a => a.op));
  t.deepEqual(ops.filter(o => o !== 'work').slice(0, 2), ['dig', 'place']);
  t.true(ops.includes('work'));
  t.deepEqual(path.stuck, []);
});

test('islands and their order: two sheds far apart are two objects, the nearer one first', t => {
  const v = new Voxels(BOX, flat(BOX));
  const cells = [...cuboid({ x: -8, y: 64, z: -8 }, { x: -7, y: 64, z: -7 }, 'oak_planks'), ...cuboid({ x: 10, y: 64, z: 10 }, { x: 11, y: 64, z: 11 }, 'oak_planks')];
  const changes = changesFor(v, cells);
  t.is(islands(tasksFor(changes).tasks).length, 2);
  const path = slice(v, changes, { x: 12, y: 64, z: 12 });
  t.true(path.stations[0].actions[0].at.x >= 10, 'starts with the shed it is next to');
  t.deepEqual(replay(v, path).problems, []);
});

test('objectOrder: along a line in order; 2-opt undoes a crossing', t => {
  const b = (x: number, z: number): Box => ({ x, y: 64, z, width: 1, height: 1, length: 1 });
  t.deepEqual(objectOrder([b(30, 0), b(10, 0), b(20, 0)], { x: 0, y: 64, z: 0 }), [1, 2, 0]);
  const order = objectOrder([b(0, 10), b(10, 10), b(10, 0), b(0, 20)], { x: 0, y: 64, z: 0 });
  t.is(order.length, 4);
});

test('loads: cut where the next station would overflow the pockets; scaffold counted at its peak; what digs bring back takes room', t => {
  const st = (items: Record<string, number>, extra: Station['actions'] = []): Station => ({
    at: { x: 0, y: 64, z: 0 }, walk: 1, object: 0,
    actions: [...Object.entries(items).flatMap(([item, n]) => Array.from({ length: n }, () => ({ op: 'place' as const, at: { x: 0, y: 64, z: 0 }, item }))), ...extra]
  });
  // 3 slots free: 64 planks + 64 logs fit (2 stacks); a third kind of 64 does too; a fourth doesn't
  const loads = planLoads([st({ oak_planks: 64 }), st({ oak_log: 64 }), st({ stone: 64 }), st({ glass: 10 })], 3);
  t.deepEqual(loads.map(l => [l.from, l.to]), [[0, 3], [3, 4]]);
  t.deepEqual(loads[0].items, { oak_planks: 64, oak_log: 64, stone: 64 });
  // a pillar of 5 and its descent: 5 scaffold blocks carried, not 10
  const climb = planLoads([st({}, [{ op: 'pillar', at: { x: 0, y: 64, z: 0 }, count: 5, scaffold: true }]), st({}, [{ op: 'descend', at: { x: 0, y: 68, z: 0 }, count: 5, scaffold: true }])], 20, 'dirt');
  t.deepEqual(climb[0].items, { dirt: 5 });
  // a dig's drop takes a slot: 2 free slots, planks and a dug log won't leave room for stone
  const dug = planLoads([st({ oak_planks: 10 }, [{ op: 'dig', at: { x: 1, y: 64, z: 0 }, state: 'oak_log[axis=y]' }]), st({ stone: 1 })], 2);
  t.is(dug.length, 2);
  t.is(stackSize('oak_sign'), 16);
  t.is(stackSize('white_bed'), 1);
  t.is(stackSize('oak_planks'), 64);
  t.is(dropOf('grass_block'), 'dirt');
  t.is(dropOf('stone'), 'cobblestone');
  t.is(dropOf('glass_pane'), undefined);
  t.is(dropOf('wall_torch[facing=north]'), 'torch');
});

test('slice: from far outside the box (home), it walks in at the nearest edge on the ground: no hop up a tower', t => {
  const v = new Voxels(BOX, flat(BOX));
  const cells = cuboid({ x: 0, y: 64, z: 0 }, { x: 0, y: 75, z: 0 }, 'stone_bricks');
  const { path } = sliceAndCheck(t, v, cells, { x: -60, y: 64, z: 0 });
  t.is(path.stats.hops, 0, 'every station walked or climbed to');
  t.is(path.start.y, 64, 'it comes in on the ground');
  t.true(path.start.x === BOX.x, `at the near edge (${path.start.x})`);
  t.deepEqual(path.stuck, []);
});

test('slice: a stray scaffold block floating 8 up is climbed to and dug, never hopped onto', t => {
  const v = new Voxels(BOX, flat(BOX));
  v.set({ x: 3, y: 72, z: 3 }, 'cobblestone');
  const path = slice(v, [], { x: -60, y: 64, z: 3 }, { scaffold: [{ x: 3, y: 72, z: 3 }] });
  const r = replay(v, path);
  t.deepEqual(r.problems, []);
  t.is(path.stats.hops, 0);
  t.false(path.stations.some(s => s.at.y > 64 && s.actions.length && !s.actions.some(a => a.scaffold)), 'nothing done up there but scaffold work');
  t.is(r.world.get({ x: 3, y: 72, z: 3 }), 'air', 'the stray is gone');
  t.false([...Array(r.world.size).keys()].some(i => /scaffold=true/.test(r.world.stateAt(i))), 'and so is the climb');
});

test('slice: a spot Baritone could not walk to is never a station again', t => {
  const v = new Voxels(BOX, flat(BOX));
  const cells = cuboid({ x: 0, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, 'oak_planks');
  const first = slice(v, changesFor(v, cells), { x: -3, y: 64, z: 0 });
  const spot = first.stations[0].at;
  const again = slice(v, changesFor(v, cells), { x: -3, y: 64, z: 0 }, { avoid: [`${spot.x},${spot.y},${spot.z}`] });
  t.false(again.stations.some(s => s.at.x === spot.x && s.at.y === spot.y && s.at.z === spot.z));
  t.deepEqual(again.stuck, []);
});

test('slice: a fence missing from a railed lookout ten up: it climbs (the railed platform is no "ground" to hop to)', t => {
  const v = new Voxels(BOX, flat(BOX));
  for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) for (let y = 64; y <= 73; y++) v.set({ x, y, z }, 'stone_bricks');
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) v.set({ x, y: 74, z }, 'oak_planks');
  for (const c of walls({ x: 0, y: 75, z: 0 }, { x: 4, y: 75, z: 4 }, 'oak_fence')) v.set(c.at, c.want);
  v.set({ x: 2, y: 75, z: 0 }, 'air');
  const { path } = sliceAndCheck(t, v, [{ at: { x: 2, y: 75, z: 0 }, want: 'oak_fence' }], { x: -60, y: 64, z: 0 });
  t.is(path.stats.hops, 0, 'no hop onto the lookout');
  t.deepEqual(path.stuck, []);
  t.true(path.stations.some(s => s.actions.some(a => a.op === 'pillar')), 'it climbs');
  t.is(path.stats.scaffoldLeft, 0);
});
