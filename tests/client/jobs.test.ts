import test from 'ava';
import { queueJob, activeJob, jobText } from '../../src/client/structures/job.js';
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
