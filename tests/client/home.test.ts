import test from 'ava';
import { bedFrom, bedGoal, bedStep, homeMilestone } from '../../src/client/brain/home.js';
import { TREE } from '../../src/client/brain/tree.js';
import { RECIPES, type MilestoneState } from '../../src/client/brain/progress.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 5,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
});
const fresh = (): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96 });

test('the plan starts with a home: first in the tree, and the storage house waits for it', (t) => {
  t.is(TREE[0].id, 'home');
  t.deepEqual(TREE.find(m => m.id === 'storage')!.prereqs, ['home']);
  const view = (world: WorldMemory) => ({ s: snap(), world, have: () => 0 });
  t.false(homeMilestone.done!(view(fresh())));
  // a bed it sleeps in already (the friend's-server cottage, furnished by hand): nothing to build
  t.true(homeMilestone.done!(view({ ...fresh(), landmarks: { chests: [], farmland: [], bed: { x: 1, y: 64, z: 1 } } })));
  t.true(homeMilestone.done!(view({ ...fresh(), zones: { home: [{ x: 0, y: 63, z: 0, width: 5, length: 7 }] } })));
});

test('a bed: one owned, else from three wool of the colour there is most of; beds craft from wool and planks', (t) => {
  t.deepEqual(bedFrom({ red_bed: 1, white_wool: 9 }), { bed: 'red_bed', craft: false });
  t.deepEqual(bedFrom({ white_wool: 3, black_wool: 4 }), { bed: 'black_bed', craft: true });
  t.is(bedFrom({ white_wool: 2, black_wool: 2 }), undefined);
  t.deepEqual(RECIPES.white_bed, { makes: 1, from: { white_wool: 3, planks: 3 } });
});

/** A bed step's world: wild sheep that each drop a white wool, and a crafting that turns 3 wool into a bed. */
function fakeCtx(world: WorldMemory, sheep: number) {
  const inv = new Map<string, number>([['oak_planks', 8]]);
  let left = sheep;
  const ctx = {
    s: snap(), world, signal: new AbortController().signal, progress: () => undefined, status: async () => ({}) as never,
    call: async <T>(method: string): Promise<T> => {
      if (method === 'inventory') return { items: [...inv].filter(([, n]) => n > 0).map(([name, count], slot) => ({ name, count, slot })) } as T;
      if (method === 'world.entities') return { entities: Array.from({ length: left }, (_, i) => ({ id: i + 1, name: 'sheep', distance: 10 + i, position: { x: 10, y: 64, z: 0 } })) } as T;
      throw new Error(`unexpected call ${method}`);
    },
    act: async (tool: string, args: Record<string, unknown> = {}) => {
      if (tool === 'attack-entity') { left--; inv.set('white_wool', (inv.get('white_wool') ?? 0) + 1); return { ok: true, text: 'killed' }; }
      if (tool === 'collect-items') return { ok: true, text: 'collected' };
      if (tool === 'craft-item' && args.outputItem === 'white_bed') { inv.set('white_wool', inv.get('white_wool')! - 3); inv.set('oak_planks', inv.get('oak_planks')! - 3); inv.set('white_bed', 1); return { ok: true, text: 'crafted' }; }
      return { ok: false, text: `no ${tool}` };
    }
  } as unknown as GoalContext;
  return { ctx, inv };
}

test('the bed step hunts wild sheep for wool and crafts a bed', async (t) => {
  const world = fresh();
  const { ctx, inv } = fakeCtx(world, 5);
  const st: MilestoneState = { step: 0, data: {} };
  const r = await bedStep.run(ctx, st);
  t.is(r.status, 'done');
  t.is(st.data.bed, 'white_bed');
  t.is(inv.get('white_bed'), 1);
});

test('no sheep: the bed step waits, and after three tries the cabin goes up without its bed', async (t) => {
  const world = fresh();
  const { ctx } = fakeCtx(world, 0);
  const st: MilestoneState = { step: 0, data: {} };
  t.is((await bedStep.run(ctx, st)).status, 'blocked');
  t.is((await bedStep.run(ctx, st)).status, 'blocked');
  const r = await bedStep.run(ctx, st);
  t.is(r.status, 'done');
  t.is(st.data.bed, null);
});

test('the bed goal: a cabin without its bed gets one once there is wool, by day at home', (t) => {
  const world: WorldMemory = { ...fresh(), zones: { 'home:bed': [{ x: 1, y: 63, z: 1 }], 'home:bed-foot': [{ x: 1, y: 63, z: 2 }] } };
  t.is(bedGoal.wants(snap(), world), null);
  t.regex(bedGoal.wants(snap({ counts: new Map([['white_wool', 3]]) }), world) ?? '', /no bed/);
  t.is(bedGoal.wants(snap({ counts: new Map([['white_wool', 3]]), activity: 'rest' }), world), null);
  world.landmarks.bed = { x: 1, y: 63, z: 1 };
  t.is(bedGoal.wants(snap({ counts: new Map([['white_wool', 3]]) }), world), null);
});
