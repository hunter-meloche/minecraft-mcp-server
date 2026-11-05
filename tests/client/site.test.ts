import test from 'ava';
import { findSite, growYard, occupancy, type CellState, type Grid } from '../../src/client/brain/site.js';

// a w x 5 x l box from y 65: stone at y 65, grass at y 66 (the level), air above
function world(w = 6, l = 4) {
  const h = 5;
  const b: (string | null)[] = new Array(w * l * h).fill('minecraft:air');
  const set = (x: number, y: number, z: number, n: string | null) => { b[x + z * w + (y - 65) * w * l] = n; };
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) { set(x, 65, z, 'stone'); set(x, 66, z, 'minecraft:grass_block[snowy=false]'); }
  return { box: { x: 10, y: 65, z: 20, width: w, height: h, length: l }, b, set };
}

test('occupancy: each kind of column', (t) => {
  const { box, b, set } = world(9, 1);
  set(1, 67, 0, 'oak_door[half=lower]');                       // furniture above ground
  set(2, 66, 0, 'farmland[moisture=7]'); set(2, 67, 0, 'wheat[age=3]');
  set(3, 66, 0, 'water[level=0]');
  set(4, 66, 0, 'air');                                        // a hole: ground at 65
  set(5, 66, 0, 'dirt_path');
  set(6, 67, 0, 'cobblestone');                                // protected below
  set(7, 66, 0, null);                                         // unloaded before the ground
  set(8, 67, 0, 'short_grass');                                // plants don't count
  const g = occupancy(box, b, 66, p => p.x === 16 && p.y === 67);
  t.deepEqual(g.cells, ['free', 'built', 'farm', 'water', 'uneven', 'path', 'built', 'unknown', 'free']);
  t.like(g, { x: 10, z: 20, width: 9, length: 1 });
});

test('occupancy: a protected block below the level is ground; a hill and a stray block are uneven', (t) => {
  const { box, b, set } = world(3, 1);
  set(0, 67, 0, 'dirt');               // a hill
  set(1, 66, 0, 'cobblestone');        // stray, unprotected, at the level
  set(2, 66, 0, 'air'); set(2, 65, 0, 'cobblestone'); // protected fill below the level, nothing at the level
  const g = occupancy(box, b, 66, p => p.x === 12 && p.y === 65);
  t.deepEqual(g.cells, ['uneven', 'uneven', 'uneven']);
});

// a grid from a picture: . free, B built, F farm, W water, u uneven, p path
function grid(rows: string[], x = 0, z = 0): Grid {
  const map: Record<string, CellState> = { '.': 'free', B: 'built', F: 'farm', W: 'water', u: 'uneven', p: 'path', '?': 'unknown' };
  return { x, z, width: rows[0].length, length: rows.length, cells: rows.join('').split('').map(c => map[c]) };
}

test('findSite: keeps clearance from built cells, absolute coordinates', (t) => {
  const g = grid([
    'B.......',
    '........',
    '........',
    '........',
    '........',
  ], 100, 200);
  // 3x3 with clearance 2 from (0,0): x or z >= 3
  const s = findSite(g, 3, 3, { near: { x: 100, z: 200 } });
  t.truthy(s);
  t.false(s!.rotated);
  t.true(s!.x - 100 >= 3 || s!.z - 200 >= 3);
  // (101,200) and (100,201) are equally near; ties keep the first in scan order (north first)
  t.like(findSite(g, 3, 3, { clearance: 0, near: { x: 100, z: 200 } }), { x: 101, z: 200 });
});

test('findSite: rotates when only the other orientation fits, null when none', (t) => {
  const g = grid([
    '..',
    '..',
    '..',
    '..',
  ]);
  t.deepEqual(findSite(g, 4, 2, { clearance: 0 }), { x: 0, z: 0, width: 2, length: 4, rotated: true });
  t.is(findSite(g, 3, 3, { clearance: 0 }), null);
  t.is(findSite(grid(['.p..']), 4, 1, { clearance: 0 }), null); // a path is not free
});

test('findSite: nearest to near by centre, tie goes to fewer uneven neighbours', (t) => {
  const g = grid([
    'u.....',
    'u.....',
    '......',
  ]);
  // the 2x3 site centred exactly on near wins
  const s = findSite(g, 2, 3, { clearance: 0, near: { x: 3, z: 1.5 } });
  t.like(s, { x: 2, z: 0, width: 2, length: 3 }); // exact centre
  const g2 = grid([
    'u...',
    'u...',
  ]);
  // sites 1x2 at x=1 (centre 1.5) and x=2 (centre 2.5) tie for near x=2; x=1 touches the uneven column
  t.like(findSite(g2, 1, 2, { clearance: 0, near: { x: 2, z: 1 } }), { x: 2, z: 0 });
});

test('findSite: water and farm block within clearance, avoidRect respected', (t) => {
  const g = grid([
    'W.........F',
    '...........',
    '...........',
    '...........',
  ]);
  const s = findSite(g, 2, 2, { clearance: 2, near: { x: 0, z: 0 } });
  t.like(s, { x: 3, z: 0 });
  const s2 = findSite(g, 2, 2, { clearance: 2, near: { x: 0, z: 0 }, avoidRect: [{ x: 5, z: 0, width: 1, length: 4 }] });
  t.is(s2, null); // x 3..4 plus clearance reaches 6 > 5; x 6.. hits the farm's clearance
});

test('growYard: grows on the dry, flattest side by whole tiles', (t) => {
  const yard = { x1: 0, z1: 0, x2: 15, z2: 15 };
  // lake to the north, a hill to the east, flat to the south and west except a lump in the west
  const isWater = (_x: number, z: number) => z < -3;
  const heightAt = (x: number, z: number) => (x > 15 ? 70 : x < 0 && z === 5 ? 67 : 66);
  const g = growYard(yard, { width: 5, length: 3 }, { isWater, heightAt, level: 66 });
  t.truthy(g);
  t.is(g!.side, 'south');
  // footprint 5 across x, 3 outward + 2*2 clearance = 7 -> one tile of 8
  t.deepEqual(g!.strip, { x1: 0, x2: 15, z1: 16, z2: 23 });
  t.deepEqual(g!.newYard, { x1: 0, z1: 0, x2: 15, z2: 23 });
  t.false(g!.rotated);
  t.is(g!.uneven, 0);
});

test('growYard: forbidden and wet sides are out; deep footprints take two tiles; null when nothing fits', (t) => {
  const yard = { x1: 0, z1: 0, x2: 15, z2: 15 };
  const onlyEast = (x: number, _z: number) => x <= 15;
  const g = growYard(yard, { width: 10, length: 6 }, { isWater: () => false, forbid: onlyEast });
  t.is(g!.side, 'east');
  // outward 6 + 4 = 10 -> 16 (rotated: outward 10 + 4 = 14 -> 16 too; first fit wins)
  t.deepEqual(g!.strip, { x1: 16, x2: 31, z1: 0, z2: 15 });
  t.is(growYard(yard, { width: 10, length: 6 }, { isWater: () => true }), null);
  t.is(growYard(yard, { width: 13, length: 13 }, { isWater: () => false }), null); // 13 + 4 > 16 across every side
});
