import test from 'ava';
import { spareGoal, spareTask } from '../../src/client/brain/spare.js';
import { returnIdle, type Snapshot } from '../../src/client/brain/goals.js';
import { projectGoal } from '../../src/client/brain/project.js';
import { stock } from '../../src/client/brain/chores.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 10,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 2, ...over
});
const world = (chest: Record<string, number> = {}): WorldMemory => ({
  landmarks: { chests: [{ x: 1, y: 64, z: 1 }], farmland: [] }, leash: 96, chestItems: { '1,64,1': chest }
});

test('spare time: the task done longest ago, under its cap, not fruitless lately', (t) => {
  const w = world();
  t.is(spareTask(snap(), w)?.name, 'iron');
  w.lastDone = { 'spare:iron': snap().now - 60_000 };
  t.is(spareTask(snap(), w)?.name, 'coal');
  // at the cap (carried and in the chests): not stockpiled further
  const full = world({ coal: 40 });
  full.lastDone = { 'spare:iron': snap().now - 60_000 };
  t.is(spareTask(snap({ counts: new Map([['coal', 30]]) }), full)?.name, 'log');
  // a run that brought nothing back: that task waits
  w.lastDone = { 'fruitless:spare:iron': snap().now - 60_000, 'fruitless:spare:coal': snap().now - 60_000 };
  t.is(spareTask(snap(), w)?.name, 'log');
  t.is(spareTask(snap(), world({ iron_ingot: 96, coal: 64, oak_log: 64 })), undefined);
});

test('spare time: by day near home, fed and with room, with daylight to spare; the lowest of the real goals', (t) => {
  const w = world();
  t.regex(spareGoal.wants(snap(), w) ?? '', /stockpile iron/);
  t.is(spareGoal.wants(snap({ activity: 'rest' }), w), null);
  t.is(spareGoal.wants(snap({ distHome: 40 }), w), null);
  t.is(spareGoal.wants(snap({ slotsUsed: 32 }), w), null);
  t.regex(spareGoal.wants(snap({ slotsUsed: 30 }), w) ?? "", /stockpile/);
  t.regex(spareGoal.wants(snap({ slotsUsed: 26 }), w) ?? "", /stockpile/);
  t.is(spareGoal.wants(snap({ food: 8 }), w), null);
  t.is(spareGoal.wants(snap({ timeOfDay: 10_500 }), w), null);
  // the chests not looked in yet: the kit first
  t.is(spareGoal.wants(snap(), { ...w, chestItems: {} }), null);
  t.true(spareGoal.priority > returnIdle.priority);
  t.true(spareGoal.priority < projectGoal([]).priority && spareGoal.priority < stock.priority);
});
