import test from 'ava';
import { treeCells, cropPlotMilestone, treeFarmMilestone } from '../../src/client/brain/farming.js';

test('treeCells: a 4 x 3 grid, 4 apart, a block above the ground', (t) => {
  const cells = treeCells({ x: 10, y: 66, z: -20 });
  t.is(cells.length, 12);
  t.deepEqual(cells[0], { x: 10, y: 67, z: -20 });
  t.deepEqual(cells[11], { x: 22, y: 67, z: -12 });
});

test('the plot and the tree farm count as done once their zones are there', (t) => {
  const view = (zones: Record<string, unknown[]>) => ({ s: {} as never, world: { landmarks: { chests: [], farmland: [] }, leash: 96, zones } as never, have: () => 0 });
  t.false(cropPlotMilestone(1, []).done!(view({})));
  t.true(cropPlotMilestone(1, []).done!(view({ plot: [{}] })));
  t.false(cropPlotMilestone(2, []).done!(view({ plot: [{}] })));
  t.true(treeFarmMilestone([]).done!(view({ trees: [{}] })));
});

test('till: grass with its state is tilled, and a plot with no farmland is not done', async (t) => {
  const { tillStep } = await import('../../src/client/brain/farming.js');
  const used: string[] = [];
  const ctx = {
    s: { items: [{ slot: 0, name: 'stone_hoe', count: 1 }] }, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown>) => { used.push(`${tool} ${a.x},${a.z}`); return { ok: true, text: 'grass_block -> grass_block' }; },
    call: async () => ({ blocks: new Array(81).fill('minecraft:grass_block[snowy=false]') })
  };
  const r = await tillStep.run(ctx as never, { step: 3, data: { site: { x: 0, y: 64, z: 0 } } });
  t.is(used.length, 81);
  t.is(r.status, 'progress');
});
