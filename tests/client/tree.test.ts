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

test('sideOf: the storage house door on its south wall', async (t) => {
  const { sideOf } = await import('../../src/client/brain/tree.js');
  const site = { x: -63, z: -24, width: 7, length: 9 };
  t.is(sideOf(site, { x: -60, z: -16 }), 'south');
  t.is(sideOf(site, { x: -60, z: -24 }), 'north');
  t.is(sideOf(site, { x: -57, z: -20 }), 'east');
});

test('quarters: the yard in four pieces, every column in exactly one', async (t) => {
  const { quarters } = await import('../../src/client/brain/tree.js');
  const yard = { x1: -565, z1: 2167, x2: -533, z2: 2199 };
  const q = quarters(yard);
  t.is(q.length, 4);
  let cols = 0;
  for (let x = yard.x1; x <= yard.x2; x++) for (let z = yard.z1; z <= yard.z2; z++) {
    const n = q.filter(b => x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2).length;
    t.is(n, 1, `(${x}, ${z})`);
    cols++;
  }
  t.is(cols, 33 * 33);
});

test('yard-level: comes after the ground outside the fence, levels each quarter to the yard, done for this yard', async (t) => {
  const { TREE } = await import('../../src/client/brain/tree.js');
  const m = TREE.find(x => x.id === 'yard-level')!;
  t.deepEqual(m.prereqs, ['fence-clear']);
  const yard = { x1: 0, z1: 0, x2: 9, z2: 9, y: 64 };
  const world = { yard, landmarks: { chests: [], farmland: [] }, leash: 96 } as never as import('../../src/client/brain/memory.js').WorldMemory;
  const levelled: string[] = [];
  const ctx = {
    world, signal: new AbortController().signal, progress: () => undefined,
    call: (async () => ({})) as never,
    act: async (tool: string, a: Record<string, unknown>) => { levelled.push(`${tool} ${a.x1},${a.z1}..${a.x2},${a.z2} at ${a.level}`); return { ok: true, text: 'Now level' }; }
  } as never;
  const st = { data: {} } as never as import('../../src/client/brain/progress.js').MilestoneState;
  t.false(m.done!({ world } as never));
  const r = await m.steps[0].run(ctx, st);
  t.is(r.status, 'done');
  t.deepEqual(levelled, ['level-area 0,0..4,4 at 64', 'level-area 5,0..9,4 at 64', 'level-area 0,5..4,9 at 64', 'level-area 5,5..9,9 at 64']);
  t.true(m.done!({ world } as never));
});
