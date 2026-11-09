import test from 'ava';
import { fillOf, growStep } from '../../src/client/brain/milestones.js';
import { stockShort } from '../../src/client/brain/chores.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 5,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
});

test("level-area's dry run: the fill it takes", (t) => {
  t.deepEqual(fillOf('Level (-565, 2159)..(-533, 2166) to ground y 62: cut 0 block(s), fill 53 dirt + 22 cobblestone; left alone: 0 water column(s).'), { dirt: 53, cobblestone: 22 });
  t.is(fillOf('Already level'), undefined);
});

/** A yard on flat grass at y 63 (ground top), nothing round it: every side can grow. */
function fakeCtx(world: WorldMemory, inventory: { name: string; count: number; slot: number }[], fill: string) {
  const acts: { tool: string; args: Record<string, unknown> }[] = [];
  const ctx = {
    s: snap(), world, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({}) as never,
    call: async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (method === 'world.region') {
        const b = params as { y: number; width: number; height: number; length: number };
        const blocks: string[] = [];
        for (let y = 0; y < b.height; y++) for (let i = 0; i < b.width * b.length; i++) blocks.push(b.y + y <= 63 ? 'minecraft:grass_block' : 'minecraft:air');
        return { blocks } as T;
      }
      if (method === 'foreign.zones') return { zones: [] } as T;
      if (method === 'inventory') return { items: inventory } as T;
      throw new Error(`unexpected call ${method}`);
    },
    act: async (tool: string, args: Record<string, unknown> = {}) => {
      acts.push({ tool, args });
      if (tool === 'level-area' && args.dryRun) return { ok: true, text: fill };
      if (tool === 'level-area') return { ok: true, text: 'Now level.' };
      return { ok: false, text: 'no' };
    }
  } as unknown as GoalContext;
  return { ctx, acts };
}

test('growing the yard short of fill: blocked, the shortfall recorded for the stock trips, no levelling started', async (t) => {
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 } };
  const { ctx, acts } = fakeCtx(world, [{ name: 'dirt', count: 15, slot: 3 }, { name: 'cobblestone', count: 50, slot: 4 }], 'Level ...: cut 0 block(s), fill 53 dirt + 22 cobblestone; left alone: 0.');
  const r = await growStep(ctx, world.yard!, { width: 8, length: 8 }, 'plot');
  t.is(r.status, 'blocked');
  t.regex(r.text, /short of 38 dirt/);
  t.deepEqual(world.progress?.need, { dirt: 38 });
  t.false(acts.some(a => a.tool === 'level-area' && !a.args.dryRun));
  // the stock trips now go for dirt (grass dug gives it)
  t.like(stockShort(snap({ counts: new Map([['dirt', 15]]) }), world).find(x => x.name === 'dirt'), { short: 38, mine: 'dirt,grass_block' });
});

test('growing the yard with the fill carried: levels, grows, and the met need is dropped', async (t) => {
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96, yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 } };
  world.progress = { done: [], journal: [], need: { dirt: 38 } } as unknown as WorldMemory['progress'];
  const { ctx, acts } = fakeCtx(world, [{ name: 'dirt', count: 64, slot: 3 }, { name: 'cobblestone', count: 50, slot: 4 }], 'Level ...: cut 0 block(s), fill 53 dirt + 22 cobblestone; left alone: 0.');
  const r = await growStep(ctx, world.yard!, { width: 8, length: 8 }, 'plot');
  t.is(r.status, 'progress');
  t.regex(r.text, /^grew the yard/);
  t.is(world.progress?.need, undefined);
  t.true(acts.some(a => a.tool === 'level-area' && !a.args.dryRun));
});

test('a project short of sugar cane sends the stock trips for wild cane', (t) => {
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  world.progress = { done: [], journal: [], need: { sugar_cane: 116, leather: 38 } } as unknown as WorldMemory['progress'];
  t.like(stockShort(snap(), world).find(x => x.name === 'sugar_cane'), { short: 116, mine: 'sugar_cane' });
});
