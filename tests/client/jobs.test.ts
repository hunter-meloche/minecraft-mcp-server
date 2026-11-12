import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { queueJob, activeJob, jobText, structureGoal } from '../../src/client/structures/job.js';
import { StructureStore } from '../../src/client/structures/store.js';
import type { Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const world = (): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96 });

test('queueJob: one going job per structure; asking again replaces it', (t) => {
  const w = world();
  const a = queueJob(w, 'seed:1', 'hut', 'apply', 1000);
  const b = queueJob(w, 'seed:1', 'hut', 'apply', 2000);
  const c = queueJob(w, 'seed:1', 'tower', 'apply', 3000);
  t.deepEqual(w.buildJobs!.map(j => [j.id, j.status]), [[1, 'cancelled'], [2, 'queued'], [3, 'queued']]);
  t.is(activeJob(w, 4000)?.id, b.id);
  b.retryAt = 9000;
  t.is(activeJob(w, 4000)?.id, c.id);
  t.regex(jobText(a), /#1 apply hut: cancelled/);
});

test('queueJob: a replaced job lets go of the materials it held in the chests', (t) => {
  const w = world();
  const a = queueJob(w, 'seed:1', 'hut', 'apply', 1000);
  w.reserved = { [a.id]: { oak_log: 20 } };
  queueJob(w, 'seed:1', 'hut', 'apply', 2000);
  t.deepEqual(w.reserved, {});
});

test('jobText: Terraslicer\'s phase, loads done, scaffold up, cells given up on', (t) => {
  const w = world();
  const j = queueJob(w, 'seed:1', 'tower', 'apply', 1000);
  Object.assign(j, { status: 'working', phase: 'building', loadsDone: 2, scaffold: ['1,2,3'], misses: { '0,0,0': 2, '1,0,0': 1 }, note: 'load done' });
  t.regex(jobText(j), /#1 apply tower: working \[Terraslicer: building, 2 load\(s\) done, 1 scaffold block\(s\) up\] \(load done\); 1 cell\(s\) given up on/);
});

test('build goal: one free slot will do; full pockets wait only with nothing to put away, and never when they hold the job\'s own load', (t) => {
  // live 2026-11-10: the lookout's load filled 35/36 slots, the stash stopped it and could put none of it away, and
  // the job never ran again
  const w = world();
  const j = queueJob(w, 'seed:1', 'lookout', 'apply', 1000);
  const goal = structureGoal(new StructureStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'))));
  const s = (slotsUsed: number, x = 0): Snapshot => {
    const items = Array.from({ length: slotsUsed }, (_, slot) => ({ slot, name: 'cobblestone', count: 64 }));
    return {
      now: 2000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x, y: 64, z: 0 }, dimension: 'overworld', sleeping: false,
      raining: false, thundering: false, process: null, items, counts: new Map([['cobblestone', 64 * slotsUsed]]), slotsUsed,
      home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: Math.abs(x)
    };
  };
  t.truthy(goal.wants(s(20), w));
  // it waited from 34 used for a stash that started at 33: the job picks up next to nothing, one slot will do
  t.regex(String(goal.wants(s(34), w)), /apply lookout/);
  t.regex(String(goal.wants(s(35), w)), /apply lookout/);
  // not a slot free and no chest to make one in
  t.is(goal.wants(s(36), w), null, 'queued, nothing carried for it, no chest');
  t.deepEqual(goal.declines!(s(36), w), { cause: 'pockets', text: '36/36 slots, nothing to put away (build needs 1 free)' });
  // a chest at home: the run makes the room itself, from the yard too (40 from home at most with no yard drawn)
  const chest = { ...w, landmarks: { chests: [{ x: 1, y: 64, z: 0 }], farmland: [] }, chestItems: { '1,64,0': {} } };
  t.regex(String(goal.wants(s(36), chest)), /apply lookout/);
  t.regex(String(goal.wants(s(36, 40), chest)), /apply lookout/);
  t.deepEqual(goal.declines!(s(36, 50), chest), { cause: 'pockets', text: '36/36 slots, the chests out of reach (build needs 1 free)' });
  // the job's own load: never asked, with or without a chest
  Object.assign(j, { status: 'working', phase: 'building', carry: ['cobblestone', 'oak_log'] });
  t.regex(String(goal.wants(s(35), w)), /apply lookout/);
  t.regex(String(goal.wants(s(36), w)), /apply lookout/);
  t.regex(String(goal.wants(s(36, 50), chest)), /apply lookout/);
  t.is(goal.declines!(s(36), w), null);
});
