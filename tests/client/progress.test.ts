import test from 'ava';
import { mostWood, nextMilestone, progressOf, rawShort, recipeFor, type Milestone } from '../../src/client/brain/progress.js';
import { inWood } from '../../src/client/brain/milestones.js';
import { projectGoal, prepare, prepareBill } from '../../src/client/brain/project.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const world = (): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96 });
const snap = (counts: [string, number][] = [], over: Partial<Snapshot> = {}): Snapshot => ({
  now: 1e9, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(counts), slotsUsed: 5,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
});

test('rawShort breaks a bill down to what the stock trips gather, using what is there', (t) => {
  // 8 fences: 3 crafts = 12 planks + 6 sticks (3 planks); 15 planks = 4 logs, less the 2 logs carried
  t.deepEqual(rawShort({ oak_fence: 8 }, { birch_log: 2 }), { log: 2 });
  t.deepEqual(rawShort({ chest: 2, torch: 8 }, { oak_planks: 20, stick: 10, coal: 1 }), { coal: 1 });
  t.deepEqual(rawShort({ bookshelf: 1 }, { oak_planks: 6, leather: 3 }), { sugar_cane: 9 });
  t.deepEqual(rawShort({ torch: 4 }, { charcoal: 1, stick: 1 }), {});
});

const ms = (id: string, prereqs: string[], done = false): Milestone => ({
  id, title: id, prereqs, done: () => done, steps: [{ name: 'only', run: async () => ({ status: 'done', text: 'ok' }) }]
});

test('nextMilestone: the first not done whose prereqs are; done-in-the-world counts; blocked ones wait', (t) => {
  const w = world();
  const tree = [ms('storage', []), ms('farm', [], true), ms('fence', ['storage'])];
  t.is(nextMilestone(tree, snap(), w)?.id, 'storage');
  progressOf(w).done.push('storage');
  t.is(nextMilestone(tree, snap(), w)?.id, 'fence');
  t.true(progressOf(w).done.includes('farm')); // checked against the world on the way
  progressOf(w).blockedUntil = { fence: 2e9 };
  t.is(nextMilestone(tree, snap(), w), undefined);
});

const ctxFor = (w: WorldMemory, s: Snapshot, acts: string[] = [], inv: Map<string, number> = new Map()) => ({
  s, world: w, signal: new AbortController().signal, progress: () => undefined,
  status: async () => ({ inWorld: true, username: 'b', screen: null }),
  call: (async (m: string) => (m === 'inventory' ? { items: [...inv].map(([name, count], slot) => ({ slot, name, count })) } : {})) as GoalContext['call'],
  act: async (tool: string, a: Record<string, unknown> = {}) => {
    acts.push(`${tool} ${a.outputItem} ${a.amount}`);
    if (tool === 'craft-item') {
      const out = String(a.outputItem), times = Number(a.amount);
      if (/_planks$/.test(out)) { inv.set(out, (inv.get(out) ?? 0) + 4 * times); inv.set('oak_log', (inv.get('oak_log') ?? 0) - times); }
      if (out === 'stick') { inv.set('stick', (inv.get('stick') ?? 0) + 4 * times); inv.set('oak_planks', (inv.get('oak_planks') ?? 0) - 2 * times); }
      if (out === 'chest') { inv.set('chest', (inv.get('chest') ?? 0) + times); inv.set('oak_planks', (inv.get('oak_planks') ?? 0) - 8 * times); }
    }
    return { ok: true, text: 'ok' };
  }
}) as unknown as GoalContext;

test('prepare crafts down the recipe chain from what is carried, or says what is short', async (t) => {
  const acts: string[] = [];
  const inv = new Map([['oak_log', 5]]);
  t.deepEqual(await prepare(ctxFor(world(), snap(), acts, inv), 'chest', 2), {});
  t.deepEqual(acts, ['craft-item oak_planks 4', 'craft-item chest 2']);
  t.deepEqual(await prepare(ctxFor(world(), snap(), [], new Map()), 'chest', 1), { log: 2 });
});

test('the project goal works a milestone step by step, by day, and records it', async (t) => {
  const w = world();
  let built = 0;
  const tree: Milestone[] = [{
    id: 'storage', title: 'storage house', prereqs: [],
    steps: [
      { name: 'site', run: async () => ({ status: 'done', text: 'site at (5, 64, 5)' }) },
      { name: 'walls', run: async () => (++built < 2 ? { status: 'progress', text: `piece ${built}/2` } : { status: 'done', text: 'walls up' }) }
    ]
  }];
  const goal = projectGoal(tree);
  t.is(goal.wants(snap(), w), 'storage house: site');
  t.is(goal.wants(snap([], { activity: 'rest' }), w), null);
  t.is(goal.wants(snap([], { timeOfDay: 9500 }), w), null); // too close to the evening
  t.is(await goal.run(ctxFor(w, snap())), 'storage house - site: site at (5, 64, 5)');
  t.is(goal.wants(snap(), w), 'storage house: walls');
  t.is(await goal.run(ctxFor(w, snap())), 'storage house - walls: piece 1/2');
  t.is(await goal.run(ctxFor(w, snap())), 'storage house complete');
  t.deepEqual(progressOf(w).done, ['storage']);
  t.is(goal.wants(snap(), w), null);
  t.deepEqual(progressOf(w).journal.map(j => j.text), ['started: storage house', 'storage house: site done (site at (5, 64, 5))', 'storage house: walls done (walls up)', 'done: storage house']);
});

test('wooden things of any wood: recipes, the wood there is most of, a blueprint in that wood', (t) => {
  t.deepEqual(recipeFor('birch_planks'), { makes: 4, from: { birch_log: 1 } });
  t.deepEqual(recipeFor('spruce_fence'), { makes: 3, from: { spruce_planks: 4, stick: 2 } });
  t.deepEqual(recipeFor('chest'), { makes: 1, from: { planks: 8 } });
  t.is(mostWood({ oak_log: 3, birch_log: 10, birch_planks: 8, oak_planks: 40 }), 'oak'); // 13 vs 12
  t.is(mostWood({ birch_log: 20, oak_planks: 8 }), 'birch');
  t.is(mostWood({}), 'oak');
  const bp = inWood({ name: 'x', spec: { palette: { P: 'oak_planks', D: 'oak_door[facing=south,half=lower]', L: 'oak_log[axis=y]', C: 'chest' }, layers: [] }, size: { width: 1, height: 1, length: 1 }, bill: { oak_planks: 10, oak_door: 1, chest: 2 }, landmarks: [], groundOffset: 1 }, 'birch');
  t.deepEqual(bp.spec.palette, { P: 'birch_planks', D: 'birch_door[facing=south,half=lower]', L: 'birch_log[axis=y]', C: 'chest' });
  t.deepEqual(bp.bill, { birch_planks: 10, birch_door: 1, chest: 2 });
});

test('prepareBill keeps the logs a bill needs as logs out of the planks', async (t) => {
  const acts: string[] = [];
  const inv = new Map([['birch_log', 5]]);
  const w = world();
  const short = await prepareBill(ctxFor(w, snap(), acts, inv), { birch_planks: 8, birch_log: 4 });
  t.deepEqual(short, { birch_log: 1 }); // 4 kept for the corners, 1 left: half the planks
  t.deepEqual(acts, []);
  t.deepEqual(progressOf(w).need, { birch_log: 1 });
});
