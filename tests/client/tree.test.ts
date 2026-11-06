import test from 'ava';
import { gatesKept, sideCells } from '../../src/client/brain/tree.js';

// the live yard, grown 16 east (x2 -32 -> -16)
const old = { x1: -65, z1: -31, x2: -32, z2: -6 };
const grown = { ...old, x2: -16 };
const gates = [{ x: -48, z: -31 }, { x: -32, z: -18 }, { x: -48, z: -6 }, { x: -52, z: -6 }, { x: -65, z: -18 }];

test('gatesKept: gates on the sides that stay keep their place; the moved side\'s go straight out', (t) => {
  const kept = gatesKept(grown, gates, 'east');
  t.deepEqual(kept, [
    { side: 'north', offset: 17 }, { side: 'east', offset: 13 }, { side: 'south', offset: 17 }, { side: 'south', offset: 13 }, { side: 'west', offset: 13 }
  ]);
});

test('sideCells: the old east side, corners included', (t) => {
  const cells = sideCells(old, 'east');
  t.is(cells.length, 26);
  t.deepEqual(cells[0], { x: -32, z: -31 });
  t.deepEqual(cells[25], { x: -32, z: -6 });
});

test('outerBand: two blocks all round outside the yard, corners in the north and south strips', async (t) => {
  const { outerBand } = await import('../../src/client/brain/tree.js');
  const band = outerBand({ x1: 0, z1: 0, x2: 9, z2: 4 });
  t.deepEqual(band, [
    { x1: -2, z1: -2, x2: 11, z2: -1 }, { x1: -2, z1: 5, x2: 11, z2: 6 }, { x1: -2, z1: 0, x2: -1, z2: 4 }, { x1: 10, z1: 0, x2: 11, z2: 4 }
  ]);
  const cells = band.reduce((a, b) => a + (b.x2 - b.x1 + 1) * (b.z2 - b.z1 + 1), 0);
  t.is(cells, 14 * 9 - 10 * 5);
});
