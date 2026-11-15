import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { queueJob, activeJob, jobText, structureGoal, BUILD_PRIORITY } from '../../src/client/structures/job.js';
import { StructureStore } from '../../src/client/structures/store.js';
import type { Design } from '../../src/client/structures/format.js';
import { FURNACE_TURN, smelt } from '../../src/client/brain/chores.js';
import { decide } from '../../src/client/brain/brain.js';
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

test('the one furnace shared: a build job securing its bill goes between two ore batches, the next batch after it (the cleanup\'s 4 stone waited an hour behind 46 raw gold and 124 raw iron, Nov 15)', (t) => {
  const w: WorldMemory = { landmarks: { chests: [], farmland: [], furnace: { x: -1, y: 64, z: 0 } }, leash: 96 };
  const j = queueJob(w, 'seed:1', 'homestead', 'repair', 1000);
  Object.assign(j, { status: 'working', phase: 'provisioning', note: 'made oak_fence_gate' });
  const build = structureGoal(new StructureStore(fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'))));
  const goals = [smelt, build];
  const at = (now: number, iron: number): Snapshot => ({
    now, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', sleeping: false,
    raining: false, thundering: false, process: null, items: [{ slot: 0, name: 'raw_iron', count: iron }, { slot: 1, name: 'coal', count: 8 }],
    counts: new Map([['raw_iron', iron], ['coal', 8]]), slotsUsed: 2, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0
  });
  const next = (s: Snapshot) => decide(s, w, goals, new Map())?.goal.name;
  // home with 124 raw iron: the smelt first, as ever
  t.is(next(at(2000, 124)), 'smelt');
  // its run (the furnace looked at as it starts) loaded a batch of 16: the job's turn, ahead of the next batch
  w.lastDone = { furnace: 2000, oreBatch: 2000 };
  t.is(build.urgency!(at(200_000, 108), w), FURNACE_TURN);
  t.is(next(at(200_000, 108)), 'build');
  // the job's run (stamped as it ends): the next batch
  j.updatedAt = 200_000;
  t.is(next(at(260_000, 108)), 'smelt');
  // while that batch is under way the job has no turn (it would stop the batch): once it is in, the job's again
  w.lastDone = { furnace: 260_000, oreBatch: 2000 };
  t.is(build.urgency!(at(300_000, 108), w), BUILD_PRIORITY);
  t.is(next(at(300_000, 108)), 'smelt');
  w.lastDone.oreBatch = 260_000;
  t.is(next(at(450_000, 92)), 'build');
  // no ore left to smelt: no turn, the job at its own priority
  t.is(build.urgency!(at(450_000, 0), w), BUILD_PRIORITY);
  // a job building its loads has its bill in the chests: it does not go before the ore
  j.phase = 'building';
  t.is(build.urgency!(at(450_000, 92), w), BUILD_PRIORITY);
  t.is(next(at(450_000, 92)), 'smelt');
});

test('a build job on its turn at the furnace keeps it to the end of its run, and has had it once the run is over (a new job\'s "levelling the site", stamped first, was back at 44 five seconds in and the smelt stopped it after every batch; a run that ends unstamped kept the turn run after run)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  const store = new StructureStore(root);
  const design: Design = { version: 1, name: 'post', parts: [{ fill: { from: [0, 0, 0], to: [0, 1, 0], block: 'oak_log[axis=y]' } }] };
  store.saveStructure('seed:1', { version: 1, name: 'post', design, anchor: { x: 5, y: 64, z: 5 }, prepare: { level: true } });
  const w: WorldMemory = { landmarks: { chests: [], farmland: [], furnace: { x: -1, y: 64, z: 0 } }, leash: 96 };
  const j = queueJob(w, 'seed:1', 'post', 'apply', 1000);
  const build = structureGoal(store);
  const at = (now: number, iron: number): Snapshot => ({
    now, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', sleeping: false,
    raining: false, thundering: false, process: null, items: [{ slot: 0, name: 'raw_iron', count: iron }, { slot: 1, name: 'coal', count: 8 }],
    counts: new Map([['raw_iron', iron], ['coal', 8]]), slotsUsed: 2, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0
  });
  const during: number[] = [];
  const ctxAt = (s: Snapshot) => ({
    s, world: w, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    act: async (tool: string) => {
      // 5 s into the levelling: the smelt for the next batch wants, and must not stop it
      during.push(build.urgency!(at(s.now + 5000, 108), w));
      return { ok: false, text: `${tool}: no path to the site` };
    },
    // nothing loaded round the site: every cell out of sight
    call: async (m: string, a: Record<string, number> = {}) => (m === 'world.region' ? { blocks: Array(a.width * a.height * a.length).fill(null) } : {})
  });
  // a batch of 16 loaded, 108 raw iron waiting: the new job's turn
  w.lastDone = { furnace: 2000, oreBatch: 2000 };
  t.is(build.urgency!(at(200_000, 108), w), FURNACE_TURN);
  t.regex(await build.run(ctxAt(at(200_000, 108)) as never), /levelling the site: level-area: no path/);
  t.is(j.note, 'levelling the site');
  t.deepEqual(during, [FURNACE_TURN]);
  t.is(build.urgency!(at(260_000, 108), w), BUILD_PRIORITY);
  // the next batch in: its turn again; this run ends with the cells out of sight, the job not stamped, and it has had
  // its turn all the same
  w.lastDone = { furnace: 300_000, oreBatch: 300_000 };
  j.prepared = true;
  const stamped = j.updatedAt;
  t.is(build.urgency!(at(400_000, 92), w), FURNACE_TURN);
  t.regex(await build.run(ctxAt(at(400_000, 92)) as never), /cell\(s\) still out of sight/);
  t.is(j.updatedAt, stamped);
  t.is(build.urgency!(at(410_000, 92), w), BUILD_PRIORITY);
  t.is(decide(at(410_000, 92), w, [smelt, build], new Map())?.goal.name, 'smelt');
  fs.rmSync(root, { recursive: true, force: true });
});
