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
