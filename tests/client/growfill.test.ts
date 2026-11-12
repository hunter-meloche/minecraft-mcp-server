import test from 'ava';
import { fillOf, growStep } from '../../src/client/brain/milestones.js';
import { stashList, stockShort } from '../../src/client/brain/chores.js';
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
  // the fill it has so far is marked as the yard's: the stash stores it, and throws none of it away as junk or glut
  t.deepEqual(world.progress?.fill, ['dirt', 'cobblestone', 'cobbled_deepslate']);
  t.is(world.progress?.fillAt, ctx.s.now);
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
  // level: the fill is placed, and what is left of it is plain dirt and stone again
  t.is(world.progress?.fill, undefined);
  t.is(world.progress?.fillAt, undefined);
});

test('a growth stopped while it takes its fill out of the chests: what it took is marked already, and the stash throws none of it away', async (t) => {
  const chest = { x: 1, y: 64, z: 0 };
  const world: WorldMemory = {
    landmarks: { chests: [chest], farmland: [] }, leash: 96, yard: { x1: -16, z1: -16, x2: 16, z2: 16, y: 63 },
    chestItems: { '1,64,0': { dirt: 400, cobblestone: 700 } }
  };
  const inventory: { name: string; count: number; slot: number }[] = [];
  const { ctx } = fakeCtx(world, inventory, 'Level ...: cut 0 block(s), fill 200 dirt + 150 cobblestone; left alone: 0.');
  const act = ctx.act;
  let takes = 0;
  ctx.act = (async (tool: string, args: Record<string, unknown> = {}) => {
    if (tool !== 'take-from-chest') return act(tool, args);
    // the dirt comes out; the run is stopped (a mob, nightfall) as it reaches for the cobblestone
    if (++takes > 1) throw new Error('aborted');
    [64, 64, 64, 8].forEach((count, i) => inventory.push({ name: 'dirt', count, slot: 3 + i }));
    return { ok: true, text: 'Took 200 dirt' };
  }) as GoalContext['act'];
  await t.throwsAsync(() => growStep(ctx, world.yard!, { width: 8, length: 8 }, 'plot'), { message: 'aborted' });
  t.is(takes, 2);
  t.deepEqual(world.progress?.fill, ['dirt', 'cobblestone', 'cobbled_deepslate']);
  t.is(world.progress?.fillAt, ctx.s.now);
  const list = stashList(snap({ items: inventory, counts: new Map([['dirt', 200]]), slotsUsed: 4 }), world);
  t.deepEqual(list.drop, []);
  t.is(list.deposit.filter(e => e.name === 'dirt').reduce((a, e) => a + e.count, 0), 136);
});

test('a project short of sugar cane sends the stock trips for wild cane', (t) => {
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  world.progress = { done: [], journal: [], need: { sugar_cane: 116, leather: 38 } } as unknown as WorldMemory['progress'];
  t.like(stockShort(snap(), world).find(x => x.name === 'sugar_cane'), { short: 116, mine: 'sugar_cane' });
});

test('a materials trip sets out with a few slots free, not only under 30 used', async (t) => {
  const { stock } = await import('../../src/client/brain/chores.js');
  const world: WorldMemory = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  world.progress = { done: [], journal: [], need: { sugar_cane: 98 } } as unknown as WorldMemory['progress'];
  t.regex(stock.wants(snap({ slotsUsed: 31 }), world) ?? '', /sugar_cane/);
  // three free slots carry three stacks of what it went for: 33 used sets out (under 33 it was), 34 does not, with no
  // chest at home to make the room in
  t.regex(stock.wants(snap({ slotsUsed: 33 }), world) ?? '', /sugar_cane/);
  t.is(stock.wants(snap({ slotsUsed: 34 }), world), null);
  t.deepEqual(stock.declines!(snap({ slotsUsed: 34 }), world), { cause: 'pockets', text: '34/36 slots, nothing to put away (stock needs 3 free)' });
});

test('a build short of something slow takes nothing out of the chests and keeps nothing carried: the trips get the need', async (t) => {
  const { buildStep } = await import('../../src/client/brain/milestones.js');
  const { enchantRoom } = await import('../../src/client/brain/blueprints.js');
  const world: WorldMemory = {
    landmarks: { chests: [{ x: 9, y: 64, z: 9 }], farmland: [] }, leash: 96,
    chestItems: { '9,64,9': { oak_log: 200, obsidian: 4, diamond: 2 } }
  };
  world.progress = { done: [], journal: [], carry: ['oak_log', 'oak_planks'] } as unknown as WorldMemory['progress'];
  const { ctx, acts } = fakeCtx(world, [{ name: 'sugar_cane', count: 37, slot: 3 }, { name: 'leather', count: 7, slot: 4 }], '');
  const step = buildStep('enchanting', () => enchantRoom(), 'enchanting room');
  const r = await step.run(ctx, { step: 0, data: { site: { x: 0, y: 63, z: 0 }, wood: 'oak' } });
  t.is(r.status, 'blocked');
  t.regex(r.text, /sugar_cane|leather/);
  t.false(acts.some(a => a.tool === 'take-from-chest' || a.tool === 'craft-item'), acts.map(a => a.tool).join(','));
  t.is(world.progress!.carry, undefined);
  t.truthy(world.progress!.need?.leather);
});
