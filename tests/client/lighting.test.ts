import test from 'ava';
import { planTorches, spawnableCells, yardBox } from '../../src/client/brain/lighting.js';

// a w x 3 x l box from y 64: a dirt floor at y 64 (layer 0), air above, dark everywhere
function world(w = 20, l = 20, floor = 'dirt') {
  const h = 3;
  const b: (string | null)[] = new Array(w * l * h).fill('air');
  const light: number[] = new Array(w * l * h).fill(0);
  const idx = (x: number, y: number, z: number) => x + z * w + y * w * l;
  const set = (x: number, y: number, z: number, n: string | null) => { b[idx(x, y, z)] = n; };
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) set(x, 0, z, floor);
  return { box: { x: 100, y: 64, z: -50, width: w, height: h, length: l }, b, light, idx, set };
}

test('spawnableCells: every cell on a dark floor, standing in the air over it', (t) => {
  const { box, b, light } = world(4, 3);
  const cells = spawnableCells(box, b, light);
  t.is(cells.length, 12);
  t.true(cells.every(p => p.y === 65));
  t.deepEqual(cells[0], { x: 100, y: 65, z: -50 });
  t.deepEqual(cells[5], { x: 101, y: 65, z: -49 });
});

test('spawnableCells: lit cells, grass and flowers, block states', (t) => {
  const { box, b, light, idx, set } = world(4, 3, 'grass_block[snowy=false]');
  light[idx(0, 1, 0)] = 3;
  set(1, 1, 0, 'short_grass'); set(2, 1, 0, 'poppy');
  set(3, 1, 0, 'oak_planks'); // a block in the cell
  set(3, 2, 1, 'oak_planks'); // no headroom
  const cells = spawnableCells(box, b, light);
  t.is(cells.length, 12 - 3);
  t.true(cells.some(p => p.x === 101 && p.z === -50));
  t.true(cells.some(p => p.x === 102 && p.z === -50));
});

test('spawnableCells: water, leaves, farmland, glass, slabs and paths are not spawnable floors', (t) => {
  for (const floor of ['water[level=0]', 'oak_leaves[persistent=false]', 'farmland[moisture=7]', 'glass', 'oak_slab[type=top]', 'cobblestone_stairs', 'dirt_path', 'ice', 'white_carpet', 'oak_fence']) {
    const { box, b, light } = world(3, 3, floor);
    t.is(spawnableCells(box, b, light).length, 0, floor);
  }
  for (const floor of ['stone', 'minecraft:oak_planks', 'oak_log[axis=y]', 'cobbled_deepslate', 'white_terracotta', 'sand', 'stone_bricks']) {
    const { box, b, light } = world(3, 3, floor);
    t.is(spawnableCells(box, b, light).length, 9, floor);
  }
});

test('spawnableCells: unloaded cells and light are ignored, the mask is respected', (t) => {
  const { box, b, light, idx, set } = world(4, 3);
  set(0, 0, 0, null); // floor unloaded
  set(1, 1, 0, null); // cell unloaded
  set(2, 2, 0, null); // headroom unloaded
  light[idx(3, 1, 0)] = -1; // light unloaded
  t.is(spawnableCells(box, b, light).length, 8);
  const masked = spawnableCells(box, b, light, { mask: p => p.x >= 102 });
  t.deepEqual(masked.map(p => [p.x, p.z]), [[102, -49], [103, -49], [102, -48], [103, -48]]);
});

test('planTorches: a dark 20 x 20 floor gets lit everywhere, torches on ground cells', (t) => {
  const { box, b, light, idx } = world();
  const plan = planTorches(box, b, light);
  t.is(plan.dark, 400);
  t.is(plan.remaining, 0);
  t.true(plan.torches.length >= 2 && plan.torches.length <= 4, `${plan.torches.length} torches`);
  for (const p of plan.torches) {
    t.is(p.y, 65);
    t.is(b[idx(p.x - box.x, 0, p.z - box.z)], 'dirt');
  }
  // the model's promise: every floor cell within 13 of some torch
  for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) {
    t.true(plan.torches.some(p => Math.abs(p.x - box.x - x) + Math.abs(p.z - box.z - z) <= 13));
  }
});

test('planTorches: existing light leaves only a far strip dark, so fewer torches', (t) => {
  const { box, b, light, idx, set } = world();
  const full = planTorches(box, b, light).torches.length;
  // lamps (an existing torch at (4, 1, 10) and more) already light everything west of x 15
  set(4, 1, 10, 'torch');
  for (let y = 0; y < 3; y++) for (let z = 0; z < 20; z++) for (let x = 0; x < 15; x++) light[idx(x, y, z)] = 9;
  const plan = planTorches(box, b, light);
  t.is(plan.dark, 5 * 20);
  t.is(plan.remaining, 0);
  t.true(plan.torches.length < full);
  t.is(plan.torches.length, 1);
  t.true(plan.torches[0].x - box.x >= 6); // a torch near the strip, not by the lamps
});

test('planTorches: max, prefer, mask and dark cells out of reach', (t) => {
  const { box, b, light } = world(40, 40);
  const capped = planTorches(box, b, light, { max: 1 });
  t.is(capped.torches.length, 1);
  t.true(capped.remaining > 0);
  t.is(capped.dark, 1600);

  // a 1-wide strip: every spot covers the same number of cells in the middle; prefer picks among the tied
  const strip = world(40, 1);
  const near = planTorches(strip.box, strip.b, strip.light, { max: 1, prefer: { x: 139, y: 65, z: -50 } });
  const far = planTorches(strip.box, strip.b, strip.light, { max: 1 });
  t.true(near.torches[0].x > far.torches[0].x);

  // torches only inside the mask, and the mask's own cells are all that count
  const inYard = (p: { x: number; z: number }) => p.x < 110 && p.z < -40;
  const masked = planTorches(box, b, light, { mask: inYard });
  t.is(masked.dark, 100);
  t.is(masked.remaining, 0);
  t.true(masked.torches.every(inYard));
});

test('planTorches: nothing dark, nothing to do; a 40 x 12 x 40 yard plans quickly', (t) => {
  const { box, b, light } = world(5, 5);
  light.fill(7);
  t.deepEqual(planTorches(box, b, light), { torches: [], dark: 0, remaining: 0 });

  // bumpy ground across 12 layers
  const w = 40, l = 40, h = 12;
  const bb: string[] = new Array(w * l * h).fill('air');
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const top = 3 + ((x * 7 + z * 13) % 5);
    for (let y = 0; y <= top; y++) bb[x + z * w + y * w * l] = y === top ? 'grass_block' : 'stone';
  }
  const start = Date.now();
  const plan = planTorches({ x: 0, y: 60, z: 0, width: w, height: h, length: l }, bb, new Array(w * l * h).fill(0));
  t.true(Date.now() - start < 2000);
  t.is(plan.remaining, 0);
  t.true(plan.torches.length <= 16, `${plan.torches.length} torches`);
});

test('yardBox: centred on home, floored', (t) => {
  t.deepEqual(yardBox({ x: 10.7, y: 64, z: -3.2 }, 16), { x: -6, y: 60, z: -20, width: 33, height: 13, length: 33 });
  t.deepEqual(yardBox({ x: 0, y: 70, z: 0 }, 2, 1, 3), { x: -2, y: 69, z: -2, width: 5, height: 5, length: 5 });
});
