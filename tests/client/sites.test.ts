import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { columns, keptSites, rankSites, siteMap } from '../../src/client/structures/site.js';
import { StructureStore } from '../../src/client/structures/store.js';
import { driftGoal } from '../../src/client/structures/job.js';
import type { Design } from '../../src/client/structures/format.js';

// a 12 x 3 x 8 area from y 63: grass at y 64 everywhere, a hill (stone at 65) in the west, water in the east corner, a
// tree at x 6
function land() {
  const area = { x: 0, y: 63, z: 0, width: 12, height: 3, length: 8 };
  const b: string[] = new Array(12 * 3 * 8).fill('air');
  const set = (x: number, y: number, z: number, s: string) => { b[x + z * 12 + (y - 63) * 96] = s; };
  for (let z = 0; z < 8; z++) for (let x = 0; x < 12; x++) { set(x, 63, z, 'dirt'); set(x, 64, z, 'grass_block[snowy=false]'); }
  for (let z = 0; z < 8; z++) for (let x = 0; x < 3; x++) set(x, 65, z, 'stone');
  for (let z = 6; z < 8; z++) for (let x = 10; x < 12; x++) set(x, 64, z, 'water[level=0]');
  set(6, 65, 3, 'oak_log[axis=y]');
  return { area, b };
}

test('columns: ground height, water, trees', (t) => {
  const { area, b } = land();
  const cols = columns(area, b);
  t.like(cols[0], { kind: 'ground', height: 65 });
  t.like(cols[5], { kind: 'ground', height: 64 });
  t.like(cols[11 + 7 * 12], { kind: 'water' });
  t.like(cols[6 + 3 * 12], { kind: 'ground', height: 64, trees: 1 });
});

test('rankSites: flat ground near the point first, no water, the hill costs cutting', (t) => {
  const { area, b } = land();
  const picks = rankSites(area, b, 3, 3, { near: { x: 5, z: 1 }, count: 3 });
  t.true(picks.length > 0);
  t.like(picks[0], { cut: 0, fill: 0, trees: 0 });
  t.is(picks[0].anchor.y, 65); // stands on the grass at 64
  t.false(picks.some(p => p.anchor.x + p.width > 10 && p.anchor.z + p.length > 6)); // never over the water
  // 4 wide from x 0 straddles the hill's edge (x 0-2 at 65, x 3 at 64): a row to fill; turned, 3 wide fits on top
  const ranked = rankSites(area, b, 4, 3, { near: { x: 1, z: 1 }, count: 40 });
  const straddle = ranked.find(p => p.anchor.x === 0 && p.width === 4);
  if (straddle) t.true(straddle.cut + straddle.fill > 0);
  t.true(ranked.some(p => p.anchor.x === 0 && p.width === 3 && p.cut + p.fill === 0));
  t.regex(siteMap(area, b, picks).join('\n'), /X/);
});

test('rankSites: inside or outside the yard', (t) => {
  const { area, b } = land();
  const yard = { x1: 3, z1: 0, x2: 9, z2: 5 };
  t.true(rankSites(area, b, 3, 3, { yard, where: 'inside' }).every(p => p.anchor.x >= 3 && p.anchor.x + 2 <= 9 && p.anchor.z + 2 <= 5));
  t.true(rankSites(area, b, 3, 3, { yard, where: 'outside' }).every(p => p.anchor.x + 2 < 3 || p.anchor.x > 9 || p.anchor.z > 5));
});

test('keptSites: a milestone set aside midway keeps its site reserved', (t) => {
  // live 2026-11-13: the ground outside the grown fence came back ahead of the enchanting room at its step 2, site chosen
  const mem = {
    progress: {
      current: { data: { strips: [0] } },
      aside: { enchanting: { data: { site: { x: -547, z: 2206, width: 7, length: 7, rotated: false, y: 62 } } } }
    }
  };
  t.deepEqual(keptSites(mem), [{ x: -547, z: 2206, width: 7, length: 7 }]);
});

test('keptSites: the milestone\'s reserved site is kept off, with the zones but not the fence', (t) => {
  // the enchanting room's 7x7 site, chosen by the brain but not yet built (the lookout's search ranked spots on it)
  const mem = {
    zones: { fence: [{ x: 0, z: 0, width: 12, length: 8 }], pen: [{ x: 9, z: 0, width: 3, length: 3 }], cane: [{ x: 4, z: 4 }] },
    progress: { current: { data: { site: { x: 3, z: 0, width: 4, length: 4, rotated: false, y: 64 } } } }
  };
  const kept = keptSites(mem);
  t.deepEqual(kept, [{ x: 9, z: 0, width: 3, length: 3 }, { x: 3, z: 0, width: 4, length: 4 }]);
  const { area, b } = land();
  const picks = rankSites(area, b, 2, 2, { avoid: kept, clearance: 0, count: 40 });
  t.true(picks.length > 0);
  t.false(picks.some(p => p.anchor.x < 7 && p.anchor.x + p.width > 3 && p.anchor.z < 4 && p.anchor.z + p.length > 0));
  t.deepEqual(keptSites({ progress: { current: { data: {} } } }), []);
  t.deepEqual(keptSites(undefined), []);
});

test('drift round: a structure that differs is noted, and with autoRepair gets a repair job', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structs-'));
  const store = new StructureStore(root);
  const d: Design = { version: 1, name: 'post', parts: [{ fill: { from: [0, 0, 0], to: [0, 1, 0], block: 'oak_log[axis=y]' } }] };
  store.saveStructure('seed:1', { version: 1, name: 'post', design: d, anchor: { x: 5, y: 64, z: 5 }, autoRepair: true });
  const world = { id: 'seed:1', landmarks: { chests: [], farmland: [] }, leash: 96 } as never as import('../../src/client/brain/memory.js').WorldMemory;
  const goal = driftGoal(store);
  const s = { now: 10 * 60 * 60_000, activity: 'work', sleeping: false, dimension: 'overworld' } as never;
  t.regex(goal.wants(s, world) ?? '', /daily check/);
  const ctx = {
    s, world, signal: new AbortController().signal,
    call: async (m: string) => (m === 'world.region' ? { blocks: ['oak_log[axis=y]', 'air'] } : { sign: false }),
    act: async () => ({ ok: true, text: '' }), progress: () => undefined
  };
  const r = await goal.run(ctx as never);
  t.regex(r, /post: 1 cell\(s\) differ, repair job #1 queued/);
  t.is(store.loadState('seed:1', 'post').drift?.changes, 1);
  t.is(world.buildJobs?.[0].mode, 'repair');
  fs.rmSync(root, { recursive: true, force: true });
});
