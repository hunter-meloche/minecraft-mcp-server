import test from 'ava';
import { queueJob, specFor, activeJob, jobText } from '../../src/client/structures/job.js';
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

test('specFor: a package as a spec over its own box, letters per block, the rest left alone', (t) => {
  const cells = [
    { at: { x: 10, y: 64, z: 5 }, want: 'oak_planks' },
    { at: { x: 12, y: 64, z: 5 }, want: 'stone' },
    { at: { x: 10, y: 65, z: 6 }, want: 'oak_planks' }
  ];
  const { origin, spec } = specFor(cells);
  t.deepEqual(origin, { x: 10, y: 64, z: 5 });
  t.deepEqual(spec.palette, { A: 'oak_planks', B: 'stone' });
  t.deepEqual(spec.layers, [['A B', '   '], ['   ', 'A  ']]);
});
