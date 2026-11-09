import test from 'ava';
import { chestSpec, storageChestCells, storageGoal, storagePlan } from '../../src/client/brain/storehouse.js';
import { stash } from '../../src/client/brain/chores.js';
import { larder } from '../../src/client/brain/food.js';
import type { Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 35,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 2, ...over
});

// the friend's-server storage house: 7 x 9 at (-552, 62, 2178), door south
const house = (): WorldMemory => ({
  landmarks: { chests: [], farmland: [] }, leash: 96,
  zones: {
    storage: [{ x: -552, y: 62, z: 2178, width: 7, length: 9 }],
    'storage:door': [{ x: -549, y: 63, z: 2186 }],
    'storage:chest': [-2179, -2180, -2181, -2182].flatMap(z => [{ x: -551, y: 63, z: -z }, { x: -547, y: 63, z: -z }])
  }
});
const k = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

test("the storage house's chest cells: six double chests, the back first, each half as the house has it", (t) => {
  const cells = storageChestCells(house());
  t.is(cells.length, 36);
  // two more layers stacked on the ground row, the same cells a block and two up, the top one under open air
  t.deepEqual(cells[12].at, { x: -551, y: 64, z: 2179 });
  t.deepEqual(cells[24].at, { x: -551, y: 65, z: 2179 });
  t.is(cells[24].state, cells[0].state);
  t.deepEqual(cells.slice(0, 4).map(c => [k(c.at), c.state]), [
    ['-551,63,2179', 'chest[facing=east,type=left]'], ['-551,63,2180', 'chest[facing=east,type=right]'],
    ['-547,63,2179', 'chest[facing=west,type=right]'], ['-547,63,2180', 'chest[facing=west,type=left]']]);
  t.deepEqual(cells.slice(8, 12).map(c => k(c.at)), ['-551,63,2183', '-551,63,2184', '-547,63,2183', '-547,63,2184']);
  t.deepEqual(storageChestCells({ landmarks: { chests: [], farmland: [] }, leash: 96 }), []);
});

test('the storage plan: a broken chest goes back, a full kind gets the next pair, and every container standing is counted', (t) => {
  const w = house();
  const cells = storageChestCells(w);
  const built = new Set(w.zones!['storage:chest'].map(k));
  const stand = (gone: string[] = []) => cells.map(c => (gone.includes(k(c.at)) || !built.has(k(c.at)) ? 'minecraft:air' : `minecraft:${c.state}`));
  // all four doubles stand: counted once each (left halves), and a full kind adds the next pair
  const ok = storagePlan(cells, stand(), built, ['stone']);
  t.deepEqual(ok.standing.map(k), ['-551,63,2179', '-547,63,2180', '-551,63,2181', '-547,63,2182']);
  t.deepEqual(ok.add.map(c => k(c.at)), ['-551,63,2183', '-551,63,2184']);
  t.deepEqual(ok.replace, []);
  // nothing full: nothing added
  t.deepEqual(storagePlan(cells, stand(), built, []).add, []);
  // a player broke one: it goes back first, and nothing is added in the same round
  const broken = storagePlan(cells, stand(['-547,63,2181', '-547,63,2182']), built, ['stone']);
  t.deepEqual(broken.replace.map(c => k(c.at)), ['-547,63,2181', '-547,63,2182']);
  t.deepEqual(broken.add, []);
  // all six standing and still full: maxed
  const all = new Set(cells.map(c => k(c.at)));
  t.true(storagePlan(cells, cells.map(c => `minecraft:${c.state}`), all, ['stone']).maxed);
  // unloaded cells are no news
  t.deepEqual(storagePlan(cells, cells.map(() => null), built, ['stone']), { replace: [], add: [], maxed: false, standing: [] });
});

test('chestSpec: a pair of cells as a build spec, by facing only (single or joined, either is storage)', (t) => {
  const cells = storageChestCells(house()).slice(8, 10);
  const { origin, spec } = chestSpec(cells);
  t.deepEqual(origin, { x: -551, y: 63, z: 2183 });
  t.deepEqual(spec.layers, [['A', 'A']]);
  t.deepEqual(spec.palette, { A: 'chest[facing=east]' });
});

test('the storage goal: a kind without room by day at home (under the stash, over the food stockpile); a look now and then', (t) => {
  const w = house();
  w.lastDone = { storage: snap().now };
  t.is(storageGoal.wants(snap(), w), null);
  w.storageFull = ['stone', 'farming'];
  t.regex(storageGoal.wants(snap(), w) ?? '', /no room for stone, farming/);
  t.is(storageGoal.wants(snap({ sleeping: true }), w), null);
  w.storageMaxedAt = snap().now - 60_000;
  t.is(storageGoal.wants(snap(), w), null);
  delete w.storageFull;
  w.lastDone = { storage: 0 };
  t.regex(storageGoal.wants(snap(), w) ?? '', /look over the storage chests/);
  t.true(storageGoal.priority < stash.priority && storageGoal.priority > larder.priority);
});

test('the ground row full and a kind without room: the next double chest goes on top of the first', (t) => {
  const w = house();
  const cells = storageChestCells(w);
  const ground = new Set(cells.slice(0, 12).map(c => k(c.at)));
  const blocks = cells.map(c => (ground.has(k(c.at)) ? `minecraft:${c.state}` : 'minecraft:air'));
  const plan = storagePlan(cells, blocks, ground, ['stone']);
  t.deepEqual(plan.add.map(c => k(c.at)), ['-551,64,2179', '-551,64,2180']);
  t.false(plan.maxed);
});

test('no whole pair free (a label sign, a single chest beside it): the next free cell alone', (t) => {
  const w = house();
  const cells = storageChestCells(w);
  const ground = new Set(cells.slice(0, 12).map(c => k(c.at)));
  // every pair on the second layer has a sign or a chest in one of its cells
  const blocks = cells.map((c, i) => (ground.has(k(c.at)) ? `minecraft:${c.state}` : i >= 12 && i < 24 && i % 2 === 0 ? 'minecraft:oak_wall_sign[facing=east]' : 'minecraft:air'));
  const plan = storagePlan(cells, blocks, ground, ['stone']);
  t.is(plan.add.length, 2, 'a whole pair on the top layer comes first');
  t.is(plan.add[0].at.y, 65);
  const topFull = blocks.map((b, i) => (i >= 24 && i % 2 === 0 ? 'minecraft:chest[facing=east,type=single]' : b));
  const single = storagePlan(cells, topFull, ground, ['stone']);
  t.is(single.add.length, 1);
});
