import test from 'ava';
import { FAR_LATER, grid, idleCount, idleTable, showCell, wholeGoals, type Cell } from '../helpers/homestead.js';

/**
 * "By day something is always chosen", the design's claim (section 7): the real ladder (the cane patch, the cows and
 * wild cane of step 5, trip kit, deep and surface coal) with stand-ins for the rungs of step 6 (scout, yard, fish,
 * each ready as the design's table has its ready()) beside it, every cell of the grid chooses a goal, bar tod >= 10700
 * and 36/36 with nothing loose. It does not hold everywhere: the cells it misses are pinned here, and the report says
 * why (the design's, not the code's).
 */

const cells = grid(wholeGoals(), ['surface:coal', ...FAR_LATER]);
const bad = (cs: Cell[]) => cs.slice(0, 12).map(c => `${showCell(c)}: ${c.chose ?? `${c.lead}: ${c.why}`}`);
/** the design's own exceptions */
const excused = (c: Cell) => c.tod >= 10_700 || (c.slots === 36 && c.loose === 0);

test('by day something is always chosen, with the whole ladder: the design\'s claim, and where it falls short', (t) => {
  t.log(idleTable(cells));
  t.deepEqual(bad(cells.filter(c => c.lead === 'nothing')), []);
  // with the home rounds overdue, or the kit short (the kit goal at home), the claim holds without exception
  t.deepEqual(bad(cells.filter(c => !c.chose && (c.rounds === 'overdue' || !c.kit))), []);
  // with a round's haul in the pockets (all of it for the chests) it holds in the live home everywhere but the last
  // half hour, where the one rung that is ready is the cane patch, its furthest cell 37 blocks out (near: it sets
  // out by about tod 10100)
  t.deepEqual(bad(cells.filter(c => !c.chose && !excused(c) && c.home === 'live' && c.fill === 'a round\'s haul' && c.tod !== 10_400)), []);
  // where it falls short, outside its own exceptions: nothing loose at 35/36 (every rung needs 2 free, the blocked
  // project 1); the live home at tod 10400 (the cane patch too far for the time, no yard rung ready: 1046 wheat
  // stored, the larder full, no enchanting table); and the depleted home, whose far rungs are all dry and whose
  // near and yard rungs have nothing to do (24 cane cells, no string for a rod), from tod 5000 (late) and with
  // nothing loose from 27/36 (deep 10 free) and at 34 (the far rungs 3)
  const missed = cells.filter(c => !c.chose && !excused(c));
  const expected = (c: Cell) => (c.slots === 35 && c.loose === 0) || (c.home === 'live' && (c.tod === 10_400 || (c.slots === 34 && c.loose === 0 && c.tod >= 10_400))) ||
    (c.home === 'depleted' && (c.tod > 5000 || (c.loose === 0 && c.slots >= 27)));
  t.deepEqual(bad(missed.filter(c => !expected(c))), []);
  // (the real step-5 rungs say they have nothing to do before what would keep them home: the depleted home's cane
  // patch has its 24 cells, and with the project free wild cane is unneeded, so full pockets there are told by the
  // first rung with something to do: the cows, whatever the project needs (the herd is farmed for good: before, with
  // the project free, the surface coal told 18 of these and the deep trip 3 more), or the deep trip in the morning.
  // The stand-ins of step 5 said `pockets` for the cane patch in every such cell)
  t.deepEqual(idleCount(cells), {
    'depleted: late: deep needs 3 min, 0.0 left': 72,
    'depleted: pockets: N/36 slots, nothing to put away (cows needs 3 free)': 52,
    'live: pockets: N/36 slots, nothing to put away (cane patch needs 2 free)': 37,
    'live: late: 0.5 min of daylight left (cane patch needs 0.7)': 16,
    'live: late: 0.3 min of daylight left (cane patch needs 0.7)': 16,
    'depleted: pockets: N/36 slots, nothing to put away (deep needs 10 free)': 12,
    'depleted: late: deep needs 3 min, 2.1 left': 8,
    'depleted: late: deep needs 3 min, 1.5 left': 8,
    'depleted: late: deep needs 3 min, 0.5 left': 8,
    'live: pockets: N/36 slots, nothing to put away (cows needs 3 free)': 4
  });
  t.deepEqual([cells.filter(c => !c.chose).length, missed.length, cells.length], [233, 149, 3168]);
});
