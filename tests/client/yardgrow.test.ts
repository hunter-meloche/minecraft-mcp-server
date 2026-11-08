import test from 'ava';
import { requestYardGrowth, yardGrowGoal } from '../../src/client/brain/yardgrow.js';
import { missionGoal } from '../../src/client/brain/community.js';
import { pens } from '../../src/client/brain/pens.js';
import type { Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 5,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
});

test('a yard growth request: by day near home, once the last fence move is done; ranked under the missions', (t) => {
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 } };
  t.is(yardGrowGoal.wants(snap(), world), null);
  requestYardGrowth(world, { width: 12, length: 9, why: 'a wheat farm' });
  t.regex(yardGrowGoal.wants(snap(), world) ?? '', /12x9 for a wheat farm/);
  t.is(yardGrowGoal.wants(snap({ activity: 'rest' }), world), null);
  t.is(yardGrowGoal.wants(snap({ distHome: 100 }), world), null);
  world.fenceMove = { side: 'east', old: { x1: -16, z1: -16, x2: 8, z2: 16, y: 63 } };
  t.is(yardGrowGoal.wants(snap(), world), null);
  t.true(yardGrowGoal.priority < missionGoal.priority && yardGrowGoal.priority < pens.priority);
});
