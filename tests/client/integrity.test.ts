import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { missingBuilt } from '../../src/client/brain/integrity.js';
import { readCells, repairGoal } from '../../src/client/brain/repair.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import { ClientProtection } from '../../src/client/protection.js';
import { jsonFileStore, type ProtectionStore } from '../../src/build-protection.js';
import type { ClientRuntime } from '../../src/client/tools.js';

const at = (x: number, y: number, z: number) => ({ x, y, z });

test('missingBuilt: puts back what is gone, supports first, as the item that places it', (t) => {
  const plan = missingBuilt([
    { at: at(0, 66, 0), state: 'wall_torch[facing=east]' },
    { at: at(0, 64, 0), state: 'grass_block[snowy=false]' },
    { at: at(1, 65, 0), state: 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]' },
    { at: at(2, 65, 0), state: 'oak_planks' }, // still there
    { at: at(3, 65, 0), state: 'grass_block[snowy=false]' }, // dirt now: ground counts as in place
    { at: at(4, 65, 0), state: 'cobblestone' } // a player put stone there
  ], ['air', 'cave_air', 'short_grass', 'oak_planks', 'dirt', 'stone']);
  t.deepEqual(plan.restore, [
    { at: at(0, 64, 0), state: 'grass_block[snowy=false]', item: 'dirt' },
    { at: at(1, 65, 0), state: 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]', item: 'oak_stairs', facing: 'north' },
    { at: at(0, 66, 0), state: 'wall_torch[facing=east]', item: 'torch', facing: 'west' }
  ]);
  t.deepEqual(plan.lost, []);
  t.is(plan.occupied, 1);
});

test('missingBuilt: chests, doors and signs are reported, not placed; unknown, unloaded and crops are skipped', (t) => {
  const plan = missingBuilt([
    { at: at(0, 64, 0), state: 'chest[facing=north,type=single,waterlogged=false]' },
    { at: at(1, 64, 0), state: 'oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]' },
    { at: at(1, 65, 0), state: 'oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]' }, // with the lower half
    { at: at(2, 64, 0), state: 'red_bed[facing=east,occupied=false,part=foot]' },
    { at: at(3, 64, 0), state: 'red_bed[facing=east,occupied=false,part=head]' },
    { at: at(4, 65, 0), state: 'oak_wall_sign[facing=north,waterlogged=false]' },
    { at: at(5, 64, 0) }, // protected before states were kept
    { at: at(6, 64, 0), state: 'cobblestone' }, // unloaded
    { at: at(7, 65, 0), state: 'wheat[age=7]' }
  ], ['air', 'air', 'air', 'air', 'air', 'air', 'air', null, 'air']);
  t.deepEqual(plan.restore, []);
  t.deepEqual(plan.lost.map(l => [l.at.x, l.why]), [
    [0, 'a container (what it held is gone)'], [1, 'doors and beds go back by hand'], [2, 'doors and beds go back by hand'],
    [4, "its text or pattern can't be put back"]
  ]);
  t.is(plan.occupied, 0);
});

test('protection keeps block states beside the keys; a file with keys only still loads', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-protect-'));
  const file = path.join(dir, 'placed-blocks.json');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': ['overworld:0,64,0'], 'seed:2': ['overworld:9,9,9'] })); // the old format
  const p = new ClientProtection(jsonFileStore(file));
  p.attach('seed:1');
  t.deepEqual(p.entries('overworld'), [{ at: at(0, 64, 0) }]);
  t.is(p.stateOf('overworld', at(0, 64, 0)), undefined);

  p.add('overworld', [at(1, 64, 0), at(0, 64, 0)], ['oak_log[axis=y]', 'cobblestone']);
  p.add('overworld', [at(1, 64, 0)]); // no state: keeps the one remembered
  t.is(p.stateOf('overworld', at(1, 64, 0)), 'oak_log[axis=y]');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  t.deepEqual(saved['seed:1'], ['overworld:0,64,0', 'overworld:1,64,0']); // the key list stays as the mineflayer backend reads it
  t.deepEqual(saved['seed:2'], ['overworld:9,9,9']);
  t.deepEqual(saved.$states, { 'seed:1': { 'overworld:1,64,0': 'oak_log[axis=y]', 'overworld:0,64,0': 'cobblestone' } });
  t.deepEqual(jsonFileStore(file).load('$states'), []); // not a world

  // the mineflayer backend saving keys alone leaves the states be
  jsonFileStore(file).save('seed:1', ['overworld:0,64,0']);
  const again = new ClientProtection(jsonFileStore(file));
  again.attach('seed:1');
  t.deepEqual(again.entries('overworld'), [{ at: at(0, 64, 0), state: 'cobblestone' }]); // the dropped key's state goes too

  again.remove('overworld', at(0, 64, 0));
  t.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).$states['seed:1'], {});
  // a store without states (the tests' in-memory ones) still works
  const keys: Record<string, string[]> = {};
  const plain: ProtectionStore = { load: w => keys[w] ?? [], save: (w, k) => { keys[w] = k; } };
  const q = new ClientProtection(plain);
  q.attach('seed:3');
  q.add('overworld', [at(1, 2, 3)], ['stone']);
  t.deepEqual(keys['seed:3'], ['overworld:1,2,3']);
});

test('readCells reads the bounding box in slabs and picks out the cells', async (t) => {
  const calls: Record<string, number>[] = [];
  const ctx = {
    call: (async (_m: string, p: Record<string, number>) => {
      calls.push(p);
      const out: string[] = [];
      for (let y = 0; y < p.height; y++) for (let z = 0; z < p.length; z++) for (let x = 0; x < p.width; x++) out.push(`b${p.x + x},${p.y + y},${p.z + z}`);
      return { blocks: out };
    }) as GoalContext['call']
  };
  const cells = await readCells(ctx, [at(0, 60, 0), at(200, 61, 300), at(5, 62, 7)]);
  t.deepEqual(cells, ['b0,60,0', 'b200,61,300', 'b5,62,7']);
  t.is(calls.length, 3); // 201 x 301 per layer: one layer a call
});

test('repair: once a day at home by day, puts back what it carries or finds in the chests, reports the rest', async (t) => {
  const built = [
    { at: at(2, 64, 0), state: 'oak_planks' },
    { at: at(2, 65, 0), state: 'oak_planks' },
    { at: at(3, 64, 0), state: 'cobblestone' },
    { at: at(4, 64, 0), state: 'glass' },
    { at: at(5, 64, 0), state: 'chest[facing=north,type=single,waterlogged=false]' },
    { at: at(6, 64, 0) } // no state
  ];
  const world: (string | null)[][] = []; // per y: x 2..5 (the cell without a state isn't read)
  const placed: string[] = [];
  const rt = {
    builtNear: (c: { x: number }, r: number) => (c.x === 0 && r === 24 ? built : []),
    restoreBlock: async (p: { x: number; y: number; z: number }, item: string, facing?: string) => {
      if (item === 'cobblestone') return 'nothing solid next to it to place against';
      placed.push(`${item} ${p.x},${p.y},${p.z}${facing ? ` ${facing}` : ''}`);
      return undefined;
    },
    adoptStates: (b: unknown[]) => { adopted.push(...b); }
  } as unknown as ClientRuntime;
  const adopted: unknown[] = [];
  world[0] = ['air', 'air', 'air', 'air']; // y 64
  world[1] = ['air', 'air', 'air', 'air']; // y 65
  const acts: string[] = [];
  const taken: { slot: number; name: string; count: number }[] = [];
  const mem: WorldMemory = { landmarks: { chests: [at(-1, 64, 0)], farmland: [] }, leash: 96, chestItems: { '-1,64,0': { oak_planks: 10 } } };
  const s = {
    now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: at(0, 64, 0), dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 0,
    home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0
  } as Snapshot;
  const progress: string[] = [];
  const ctx = {
    s, world: mem, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool} ${a.item} ${a.count}`);
      if (tool === 'take-from-chest') taken.push({ slot: 1, name: String(a.item), count: Number(a.count) });
      return { ok: true, text: `Took ${a.count} ${a.item} from the chest at (-1, 64, 0). It holds: oak_planks x${10 - Number(a.count)}.` };
    },
    call: (async (m: string, p: Record<string, number>) => {
      if (m === 'inventory') return { items: [{ slot: 0, name: 'cobblestone', count: 5 }, ...taken] };
      if (m === 'world.region' && p.x === 6) return { blocks: ['air'] }; // the cell without a state: nothing there to adopt
      if (m === 'world.region') {
        t.like(p, { x: 2, y: 64, z: 0, width: 4, height: 2, length: 1 });
        return { blocks: [...world[0], ...world[1]] };
      }
      throw new Error(`unexpected ${m}`);
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: (x: string) => { progress.push(x); }, gain: () => undefined
  } as GoalContext;
  const goal = repairGoal(rt);
  t.is(goal.priority, 38);
  t.regex(goal.wants(s, mem) ?? '', /daily round/);
  t.is(goal.wants({ ...s, activity: 'rest' }, mem), null);
  t.is(goal.wants({ ...s, distHome: 30 }, mem), null);
  t.is(goal.wants({ ...s, dimension: 'the_nether' }, mem), null);

  const r = await goal.run(ctx);
  t.deepEqual(acts, ['take-from-chest oak_planks 2']);
  t.deepEqual(placed, ['oak_planks 2,64,0', 'oak_planks 2,65,0']);
  t.is(r, "put back 2/4 missing block(s); no glass (x1) to put back; couldn't place cobblestone at 3,64,0: nothing solid next to it to place against" +
    '; not put back: chest at 5,64,0 (a container (what it held is gone))');
  t.true(progress.includes('put back oak_planks at 2,64,0'));
  t.deepEqual(adopted, []);
  // done for today. Its time is up 20 min on, and then it is due in the evening, or when no trip could go instead, or
  // when it has waited 40 min: here a trip for coal could (the chests hold none), so the morning is the trip's
  t.is(goal.wants(s, mem), null);
  t.is(goal.wants({ ...s, now: s.now + 21 * 60_000 }, mem), null);
  t.regex(goal.wants({ ...s, now: s.now + 21 * 60_000, timeOfDay: 8000 }, mem) ?? '', /daily round/);
  t.regex(goal.wants({ ...s, now: s.now + 41 * 60_000 }, mem) ?? '', /daily round/);
});

test('repair: nothing built near home, nothing to want; blocks built before states were kept get one', async (t) => {
  const s = { activity: 'work', sleeping: false, dimension: 'overworld', home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, now: 1e9 } as Snapshot;
  const mem = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  t.is(repairGoal({ builtNear: () => [] } as unknown as ClientRuntime).wants(s, mem), null);
  let built: { at: { x: number; y: number; z: number }; state?: string }[] = [{ at: at(0, 64, 0) }];
  const rt = {
    builtNear: () => built,
    adoptStates: (b: { at: { x: number; y: number; z: number }; state: string }[]) => { built = b; }
  } as unknown as ClientRuntime;
  const goal = repairGoal(rt);
  t.regex(goal.wants(s, mem) ?? '', /daily round/);
  const ctx = {
    s, world: mem, signal: new AbortController().signal, act: async () => ({ ok: true, text: '' }),
    call: (async () => ({ blocks: ['oak_log[axis=y]'] })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }), progress: () => undefined, gain: () => undefined
  } as GoalContext;
  t.is(await goal.run(ctx), 'all 1 built blocks checked, none missing');
  t.deepEqual(built, [{ at: at(0, 64, 0), state: 'oak_log[axis=y]' }]);
});
