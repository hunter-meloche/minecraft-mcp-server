import test from 'ava';
import { decide } from '../../src/client/brain/brain.js';
import { workOf } from '../../src/client/brain/work.js';
import { FILLS, MINUTE, ROUNDS, SLOTS, TIMES, TRIES, depletedWorld, grid, idleCount, idleTable, lookAt, pocketsOf, realGoals, roundsAt, showCell, withProject, type Cell } from '../helpers/homestead.js';

/**
 * "By day something is always chosen", for the ladder as it stands (the cane patch, the cows and wild cane of step 5,
 * step 4's trip kit, deep and surface coal): the real goal list as the brain builds it, asked over pockets x hour x project
 * blocked or not x kit ready or not, on the live homestead and on a depleted one, with the home rounds done a minute
 * ago (the cell asks what the work queue offers, not whether a chore happens to be due) and with them overdue. The
 * design's claim is for the whole ladder (workgrid-whole.test.ts); here it is what holds with these rungs, as
 * strongly as it holds.
 */

const cells = grid(realGoals(), ['surface:coal']);
const idle = (c: Cell) => !c.chose;
const bad = (cs: Cell[]) => cs.slice(0, 12).map(c => `${showCell(c)}: ${c.chose ?? `${c.lead}: ${c.why}`}`);

test('by day something is always chosen, with the ladder as it stands: what is true of the grid', (t) => {
  t.is(cells.length, 2 * 2 * FILLS.length * SLOTS.length * TIMES.length * 2 * 2);
  t.log(idleTable(cells));
  // no cell where no goal says why
  t.deepEqual(bad(cells.filter(c => c.lead === 'nothing')), []);
  // with the home rounds overdue, or the kit short of torches (the kit goal at home), something runs in every cell
  t.deepEqual(bad(cells.filter(c => idle(c) && (c.rounds === 'overdue' || !c.kit))), []);
  // by morning, kit ready and room for the mine (free, or the stash can make it): the deep trip or something more
  // urgent than it, everywhere; never a rung below it (the surface coal waits for the afternoon). In the live home
  // that is the cane patch first where nothing else is due: its five cells are not known to be dry yet, and 34
  // cane are stored to plant with. With the project waiting on leather the cows rung goes before the deep trip on a
  // morning with no unblocker trip yet (the grid's mornings are all such); with the project free, the project runs
  const morning = cells.filter(c => c.tod <= 5000 && c.kit && c.deepRoom !== 'no');
  t.true(morning.length > 0);
  t.deepEqual(bad(morning.filter(c => !(c.chose === 'work: deep' || (c.urgency ?? 0) > c.deep))), []);
  t.true(morning.some(c => c.chose === 'work: cane patch' && c.home === 'live'));
  t.true(morning.some(c => c.chose === 'work: cows' && c.home === 'depleted'));
  t.deepEqual(bad(morning.filter(c => c.chose === 'work: cows' && !c.blocked)), []);
  // full pockets lead only with nothing in them to put away; in the live home from 34/36 (the cane patch needs 2
  // free, the far rungs 3), or before tod 5000 from 27/36 where only the mine's 10 are short
  t.deepEqual(bad(cells.filter(c => c.lead === 'pockets' && c.loose > 0)), []);
  t.deepEqual(bad(cells.filter(c => c.lead === 'pockets' && c.home === 'live' && c.slots < 34)), []);
  // the cells that still choose nothing, by home and lead cause (the report's table). The live home's afternoons that
  // idled on the deep trip's hour (64 cells with step 4's rungs) go to the cane patch now; what is left there is its
  // own last half hour (its furthest cell is 37 blocks out: near, it sets out by about tod 10100) and full pockets.
  // The depleted home has its 24 cells, so neither cane rung has anything to do. The cows rung goes out to its range,
  // 256, past the leash, and walks a cow home on the lead's pace: a side needs 5.3 min of the day, so it sets out
  // until tod 4680, and the depleted home's afternoons, which it took up to tod 8520 when it kept to the leash (2.1
  // min), are its `late` now (36 cells more idle). The herd is farmed whatever the project needs: with the project free
  // the cows rung, not the surface coal, is the first with something to do, and from 34/36 with nothing loose its 3
  // free slots are what keeps it home
  t.deepEqual(idleCount(cells), {
    'live: pockets: N/36 slots, nothing to put away (cane patch needs 2 free)': 37,
    'depleted: pockets: N/36 slots, nothing to put away (cows needs 3 free)': 52,
    'live: late: 0.5 min of daylight left (cane patch needs 0.7)': 16,
    'live: late: 0.3 min of daylight left (cane patch needs 0.7)': 16,
    'depleted: late: 1.7 min of daylight left (cows needs 5.3)': 16,
    'depleted: late: 1.0 min of daylight left (cows needs 5.3)': 16,
    'depleted: late: 0.5 min of daylight left (cows needs 5.3)': 16,
    'depleted: late: 0.3 min of daylight left (cows needs 5.3)': 16,
    'depleted: late: 4.2 min of daylight left (cows needs 5.3)': 8,
    'depleted: late: 3.5 min of daylight left (cows needs 5.3)': 8,
    'depleted: late: 2.5 min of daylight left (cows needs 5.3)': 8,
    'depleted: late: 2.1 min of daylight left (cows needs 5.3)': 8,
    'depleted: pockets: N/36 slots, nothing to put away (deep needs 10 free)': 4,
    'live: pockets: N/36 slots, nothing to put away (cows needs 3 free)': 4
  });
  t.is(cells.filter(c => c.chose).length, 2943);
});

test('the cows rung goes first on a fresh morning, once: after one unblocker trip today and no deep trip, the deep trip goes before it', (t) => {
  // the depleted home (its 24 cane cells: the cane patch has nothing to do), the project blocked on leather, 10 slots
  // used and the kit whole, at tod 1000, the rounds done a minute ago
  const world = () => roundsAt(roundsAt(withProject(depletedWorld(), true), MINUTE, TRIES), MINUTE, ROUNDS);
  const s = lookAt(pocketsOf(10, true, 'kept things only'), 1000, { xpLevel: 30 });
  const goals = realGoals();
  t.is(decide(s, world(), goals, new Map())?.goal.name, 'work: cows');
  const after = world();
  workOf(after).farDay = { day: 0, unblockers: 1, deep: 0 };
  t.is(decide(s, after, goals, new Map())?.goal.name, 'work: deep');
});
