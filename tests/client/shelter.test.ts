import test from 'ava';
import { shelterGoal } from '../../src/client/brain/goals.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const night = (over: Partial<Snapshot> = {}) => ({ activity: 'rest', sleeping: false, dimension: 'overworld', home: { x: 0, y: 64, z: 0 }, distHome: 0, ...over }) as unknown as Snapshot;
const world = (bed?: { x: number; y: number; z: number }) => ({ landmarks: { bed, chests: [], farmland: [] } }) as unknown as WorldMemory;

test('shelter: a new bot home at night with no bed walls itself in; with a bed it goes to bed; boxed in already, nothing', t => {
  const g = shelterGoal();
  t.is(g.wants(night(), world()), 'night: no bed yet: wall in');
  t.is(g.wants(night(), world({ x: 1, y: 64, z: 0 })), 'night: go to bed');
  t.is(g.wants(night({ boxedIn: [] } as unknown as Partial<Snapshot>), world()), null);
  t.is(g.wants(night({ activity: 'work' } as Partial<Snapshot>), world()), null, 'by day it works');
});

test('shelter: a home cell that cannot be reached does not cost the night: the doors are shut and the bot goes to bed', async t => {
  const bed = { x: 12, y: 64, z: 10 };
  const calls: string[] = [];
  const ctx = {
    s: night(),
    world: world(bed),
    signal: new AbortController().signal,
    progress: () => undefined,
    status: async () => ({ block: { x: 1, y: 64, z: -1 } }),
    act: async (tool: string, args: Record<string, unknown> = {}) => {
      // scaffold left on the home cell: the walk onto it throws, as move-to-position does when it does not arrive
      if (tool === 'move-to-position' && args.range === 0) throw new Error('Could not reach (0, 64, 0): no path found. Stopped at (1, 64, -1), 1.41 blocks away.');
      if (tool === 'use-item-on-block') return { ok: true, text: 'oak_door is now open=false' };
      return { ok: false, text: `no ${tool}` };
    },
    call: async (method: string) => {
      calls.push(method);
      // one door standing open, in the corner of the box read round home
      if (method === 'world.region') return { blocks: ['minecraft:oak_door[facing=north,half=lower,open=true,powered=false]'] };
      if (method === 'bed.sleep') return { sleeping: true };
      throw new Error(`unexpected call ${method}`);
    }
  } as unknown as GoalContext;
  t.is(await shelterGoal().run(ctx), 'home cell not reached, shut 1 door(s), asleep in the bed at (12, 64, 10)');
  t.deepEqual(calls, ['world.region', 'bed.sleep']);
});
