import test from 'ava';
import { strayCells } from '../../src/client/brain/tidy.js';
import type { Cluster } from '../../src/client/survey.js';

const cluster = (cells: { x: number; y: number; z: number; block: string }[]): Cluster => ({
  min: cells[0], max: cells[cells.length - 1], blocks: cells.length, kinds: {}, cells
});

test('strayCells: a dirt wall-in above the ground is cleared top down', (t) => {
  const c = cluster([{ x: 0, y: 67, z: 0, block: 'dirt' }, { x: 0, y: 68, z: 0, block: 'dirt' }, { x: 0, y: 69, z: 1, block: 'dirt' }]);
  t.deepEqual(strayCells([c], 66, new Set()).map(p => p.y), [69, 68, 67]);
});

test('strayCells: a filled hole (at ground level) stays', (t) => {
  const c = cluster([{ x: 0, y: 66, z: 0, block: 'dirt' }, { x: 0, y: 65, z: 0, block: 'cobblestone' }]);
  t.deepEqual(strayCells([c], 66, new Set()), []);
});

test('strayCells: planks, big clusters and blocks by a build are left alone', (t) => {
  const planks = cluster([{ x: 0, y: 67, z: 0, block: 'oak_planks' }, { x: 1, y: 67, z: 0, block: 'dirt' }]);
  const big = cluster(Array.from({ length: 20 }, (_, i) => ({ x: i, y: 67, z: 5, block: 'cobblestone' })));
  const byBuild = cluster([{ x: 10, y: 67, z: 10, block: 'cobblestone' }]);
  t.deepEqual(strayCells([planks, big, byBuild], 66, new Set(['11,67,10'])), []);
});
