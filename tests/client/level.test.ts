import test from 'ava';
import { planLevel } from '../../src/client/level.js';

// 4 x 8 x 3 box from y 60: ground at y 63 (layer 3) everywhere; level 63
function world() {
  const w = 4, l = 3, h = 8;
  const b: string[] = new Array(w * l * h).fill('air');
  const set = (x: number, y: number, z: number, n: string) => { b[x + z * w + y * w * l] = n; };
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) { for (let y = 0; y < 3; y++) set(x, y, z, 'stone'); set(x, 3, z, 'grass_block[snowy=false]'); }
  return { box: { x: 10, y: 60, z: 20, width: w, height: h, length: l }, b, set };
}

test('planLevel cuts a hill and a tree, fills a dip with cobblestone and dirt on top', (t) => {
  const { box, b, set } = world();
  set(0, 4, 0, 'dirt'); set(0, 5, 0, 'grass_block'); // a 2-high hill
  set(1, 4, 1, 'oak_log'); set(1, 5, 1, 'oak_log'); set(1, 6, 1, 'oak_leaves'); // a tree
  set(3, 3, 2, 'air'); set(3, 2, 2, 'air'); // a 2-deep dip
  const p = planLevel(box, b, 63);
  t.is(p.cut, 4); // the hill and the trunk; the natural leaves decay by themselves
  t.is(p.leaves, 1);
  t.deepEqual(p.cutKinds, { ground: 2, logs: 2 });
  t.is(p.dirt, 1);
  t.is(p.cobblestone, 1);
  t.deepEqual(p.origin, { x: 10, y: 62, z: 20 });
  t.deepEqual(p.spec!.layers[0], ['    ', '    ', '   C']); // y 62
  t.deepEqual(p.spec!.layers[1], ['    ', '    ', '   D']); // y 63
  t.deepEqual(p.spec!.layers[2], ['.   ', ' .  ', '    ']); // y 64
  t.is(p.spec!.layers.length, 4); // up to the top log at y 65
});

test('planLevel leaves water, farmland and the bot\'s builds alone, but not torches', (t) => {
  const { box, b, set } = world();
  set(0, 3, 0, 'water'); // a pond at the surface
  set(1, 3, 0, 'farmland'); set(1, 4, 0, 'wheat');
  set(2, 4, 0, 'oak_planks'); set(2, 5, 0, 'oak_planks'); // built: protected
  set(3, 4, 0, 'dirt'); set(3, 5, 0, 'torch'); // a torch on a bump (protected, but it goes with its block)
  const p = planLevel(box, b, 63, q => q.z === 20 && (q.x === 12 || (q.x === 13 && q.y === 65)));
  t.deepEqual(p.kept, { water: 1, built: 2 });
  t.is(p.cut, 1); // the bump; the torch drops with it
  t.deepEqual(p.spec!.layers[0][0], '   .');
});

test('planLevel reports nothing to do on flat ground', (t) => {
  const { box, b } = world();
  const p = planLevel(box, b, 63);
  t.is(p.spec, null);
  t.is(p.cut + p.dirt + p.cobblestone, 0);
});

test('planLevel cuts what stands on protected fill or buried water, and keeps surface builds', (t) => {
  const { box, b, set } = world();
  set(0, 4, 0, 'cobblestone'); set(0, 5, 0, 'cobblestone'); // scaffold pillar on top of a protected fill at y 63
  set(1, 1, 0, 'water'); set(1, 4, 0, 'dirt');                // a bump over buried water
  set(2, 4, 0, 'oak_planks');                                  // a protected build on the surface: kept
  const p = planLevel(box, b, 63, q => (q.x === 10 && q.y === 63 && q.z === 20) || (q.x === 12 && q.y === 64 && q.z === 20));
  t.is(p.cut, 3);
  t.deepEqual(p.kept, { water: 0, built: 1 });
  t.deepEqual(p.spec!.layers[0][0], '..  ');
});

test('planLevel keeps a pond whose surface is well below the level', (t) => {
  const { box, b, set } = world();
  for (const x of [1, 2]) { set(x, 3, 1, 'air'); set(x, 2, 1, 'air'); set(x, 1, 1, 'water'); } // open water 2 below the ground
  const p = planLevel(box, b, 63);
  t.is(p.kept.water, 2);
  t.is(p.dirt + p.cobblestone, 0);
});

test('planLevel cuts natural leaves when asked', (t) => {
  const { box, b, set } = world();
  set(1, 5, 1, 'oak_leaves[distance=2,persistent=false]');
  t.is(planLevel(box, b, 63).leaves, 1);
  const p = planLevel(box, b, 63, () => false, true);
  t.is(p.leaves, 0);
  t.deepEqual(p.cutKinds, { leaves: 1 });
});
