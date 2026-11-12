import test from 'ava';
import { FILLS, SLOTS, TIMES, grid, idleCount, idleTable, realGoals, showCell, type Cell } from '../helpers/homestead.js';

/**
 * "By day something is always chosen", for the ladder as this step leaves it (trip kit, deep, surface coal): the
 * real goal list as the brain builds it, asked over pockets x hour x project blocked or not x kit ready or not, on the
 * live homestead and on a depleted one, with the home rounds done a minute ago (the cell asks what the work queue
 * offers, not whether a chore happens to be due) and with them overdue. The design's claim is for the whole ladder
 * (workgrid-whole.test.ts); here it is what holds with three rungs, as strongly as it holds.
 */

const cells = grid(realGoals(), ['surface:coal']);
const idle = (c: Cell) => !c.chose;
const bad = (cs: Cell[]) => cs.slice(0, 12).map(c => `${showCell(c)}: ${c.chose ?? `${c.lead}: ${c.why}`}`);

test('by day something is always chosen, with this step\'s three rungs: what is true of the grid', (t) => {
  t.is(cells.length, 2 * 2 * FILLS.length * SLOTS.length * TIMES.length * 2 * 2);
  t.log(idleTable(cells));
  // no cell where no goal says why
  t.deepEqual(bad(cells.filter(c => c.lead === 'nothing')), []);
  // with the home rounds overdue, or the kit short of torches (the kit goal at home), something runs in every cell
  t.deepEqual(bad(cells.filter(c => idle(c) && (c.rounds === 'overdue' || !c.kit))), []);
  // by morning, kit ready and room for the mine (free, or the stash can make it): the deep trip or something more
  // urgent than it, everywhere; never a rung below it (the surface coal waits for the afternoon)
  const morning = cells.filter(c => c.tod <= 5000 && c.kit && c.deepRoom !== 'no');
  t.true(morning.length > 0);
  t.deepEqual(bad(morning.filter(c => !(c.chose === 'work: deep' || (c.urgency ?? 0) > c.deep))), []);
  t.true(morning.some(c => c.chose === 'work: deep'));
  // full pockets lead only with nothing in them to put away; in the live home from 34/36 (no rung of the three
  // needs fewer than 3 free), or before tod 5000 from 27/36 where only the mine's 10 are short
  t.deepEqual(bad(cells.filter(c => c.lead === 'pockets' && c.loose > 0)), []);
  t.deepEqual(bad(cells.filter(c => c.lead === 'pockets' && c.home === 'live' && c.slots < 34)), []);
  // the cells that still choose nothing, by home and lead cause (the report's table)
  t.deepEqual(idleCount(cells), {
    'depleted: late: deep needs 3 min, 0.0 left': 72,
    'live: late: deep needs 3 min, 0.0 left': 64,
    'live: pockets: N/36 slots, nothing to put away (surface needs 3 free)': 40,
    'depleted: pockets: N/36 slots, nothing to put away (surface needs 3 free)': 40,
    'depleted: pockets: N/36 slots, nothing to put away (deep needs 10 free)': 24,
    'live: pockets: N/36 slots, nothing to put away (deep needs 10 free)': 12,
    'depleted: late: deep needs 3 min, 2.1 left': 8,
    'depleted: late: deep needs 3 min, 1.5 left': 8,
    'depleted: late: deep needs 3 min, 0.5 left': 8
  });
  t.is(cells.filter(c => c.chose).length, 2892);
});
