import test from 'ava';
import { HeatMap, pathTorchSpots, routeCells } from '../../src/client/brain/paths.js';

// walk a line back and forth n times
function walk(m: HeatMap, from: { x: number; z: number }, to: { x: number; z: number }, n: number) {
  for (let i = 0; i < n; i++) {
    const [a, b] = i % 2 ? [to, from] : [from, to];
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z));
    for (let s = 0; s <= steps; s++) m.visit({ x: a.x + ((b.x - a.x) * s) / steps + 0.5, z: a.z + ((b.z - a.z) * s) / steps + 0.5 });
  }
}

test('HeatMap: visits count per block column, standing still counts once, capped', (t) => {
  const m = new HeatMap({ cap: 3 });
  m.visit({ x: 1.2, z: -0.5 });
  m.visit({ x: 1.9, z: -0.1 }); // same cell: ignored
  t.is(m.get(1, -1), 1);
  for (let i = 0; i < 10; i++) { m.visit({ x: 1, z: -1 }); m.visit({ x: 2, z: -1 }); }
  t.is(m.get(1, -1), 3);
  t.is(m.size, 2);
});

test('HeatMap: decay fades and drops cold cells', (t) => {
  const m = new HeatMap();
  m.visit({ x: 0, z: 0 }, 10);
  m.visit({ x: 1, z: 0 }, 1);
  m.decay(0.4);
  t.is(m.get(0, 0), 4);
  t.is(m.get(1, 0), 0);
  t.is(m.size, 1);
});

test('HeatMap: JSON round trip keeps the hottest cells, ignores garbage', (t) => {
  const m = new HeatMap({ maxCells: 3 });
  m.visit({ x: 0, z: 0 }, 5); m.visit({ x: 1, z: 0 }, 2); m.visit({ x: 2, z: 0 }, 9); m.visit({ x: 3, z: 0 }, 1);
  const j = m.toJSON();
  t.deepEqual(j, { v: 1, c: [2, 0, 9, 0, 0, 5, 1, 0, 2] });
  const back = HeatMap.fromJSON(JSON.parse(JSON.stringify(j)));
  t.is(back.get(2, 0), 9);
  t.is(back.get(3, 0), 0);
  t.is(HeatMap.fromJSON(null).size, 0);
  t.is(HeatMap.fromJSON({ c: [1, 2, 'x', 4, 5, 6] }).size, 1);
});

test('HeatMap: prunes to the hottest cells as it grows', (t) => {
  const m = new HeatMap({ maxCells: 4 });
  m.visit({ x: 100, z: 100 }, 50);
  for (let x = 0; x < 20; x++) m.visit({ x, z: 0 });
  t.true(m.size <= 5);
  t.is(m.get(100, 100), 50);
});

test('routeCells: only cells walked often, hottest first', (t) => {
  const m = new HeatMap();
  walk(m, { x: 0, z: 0 }, { x: 5, z: 0 }, 4);
  m.visit({ x: 0, z: 9 });
  const r = routeCells(m, 3);
  // the far end is turned around on, so the visit there that starts the walk back is the same cell: it stays at 2
  t.deepEqual(r.map(c => c.x).sort(), [0, 1, 2, 3, 4]);
  t.true(r.every(c => c.z === 0 && c.heat >= 3));
});

test('pathTorchSpots: spaced along a dark route outside the yard, covering it', (t) => {
  const m = new HeatMap();
  walk(m, { x: 0, z: 0 }, { x: 40, z: 0 }, 6);
  walk(m, { x: 20, z: 1 }, { x: 20, z: 1 }, 1); // a one-off detour: too cold
  const yard = (x: number) => x < 8;
  const spots = pathTorchSpots(m, () => true, 10, yard);
  t.true(spots.length >= 3);
  t.true(spots.every(s => s.x >= 8 && s.z === 0));
  for (const a of spots) for (const b of spots) if (a !== b) t.true(Math.hypot(a.x - b.x, a.z - b.z) >= 10);
  // every cell of the route outside the yard is within 5 of a torch, except where the spacing rule can't allow it
  const uncovered = routeCells(m, 3).filter(c => c.x >= 8 && !spots.some(s => Math.hypot(s.x - c.x, s.z - c.z) <= 5));
  t.true(uncovered.length <= 2, JSON.stringify(uncovered));
});

test('pathTorchSpots: lit cells get nothing; hottest first', (t) => {
  const m = new HeatMap();
  walk(m, { x: 0, z: 0 }, { x: 30, z: 0 }, 4);
  walk(m, { x: 0, z: 50 }, { x: 0, z: 60 }, 10); // a busier route
  const all = pathTorchSpots(m, () => true, 10);
  t.true(all[0].x === 0 && all[0].z >= 50);
  for (let i = 1; i < all.length; i++) t.true(all[i - 1].heat >= all[i].heat);
  const darkOnlyNorth = pathTorchSpots(m, (_x, z) => z >= 50, 10);
  t.true(darkOnlyNorth.length > 0 && darkOnlyNorth.every(s => s.z >= 50));
  t.deepEqual(pathTorchSpots(m, () => false, 10), []);
});
