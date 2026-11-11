import test from 'ava';
import {
  backoffMs, mostWood, nextMilestone, progressOf, rawShort, recipeFor, stillShort, type Milestone, type Step, type StepResult
} from '../../src/client/brain/progress.js';
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
  s, world: w, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
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

test('prepareBill keeps what the bill places out of the furnace: not smelted, not burnt', async (t) => {
  const acts: string[] = [];
  const smelts: Record<string, unknown>[] = [];
  const inv = new Map([['cobblestone', 20], ['oak_log', 8]]);
  const w = world();
  w.landmarks.furnace = { x: 1, y: 64, z: 1 };
  const ctx = ctxFor(w, snap(), acts, inv);
  const act = ctx.act;
  ctx.act = (async (tool: string, a: Record<string, unknown> = {}) => {
    if (tool === 'smelt-item') { smelts.push(a); inv.set('cobblestone', inv.get('cobblestone')! - Number(a.inputCount)); inv.set('stone', (inv.get('stone') ?? 0) + Number(a.inputCount)); return { ok: true, text: 'ok' }; }
    return act(tool, a);
  }) as GoalContext['act'];
  // 16 cobblestone and 6 logs go in the wall as they are: 4 cobblestone to smelt, 2 logs to burn
  const short = await prepareBill(ctx, { cobblestone: 16, oak_log: 6, stone: 8 });
  t.is(smelts.length, 1);
  t.is(smelts[0].inputCount, 4);
  t.is(smelts[0].fuelItem, 'oak_log');
  t.is(smelts[0].fuelCount, 2); // 8 logs carried, 6 for the wall
  t.deepEqual(short, { stone: 4 });
  t.true(inv.get('cobblestone')! >= 16);
});

// ---- a step short of materials: the back-off ----

const MIN = 60_000;
/** The tests' clock starts here (snap()'s `now`): 13:46:40 UTC. */
const T = 1e9;

/**
 * A home with one chest and a room that takes 113 cane and 40 leather: its step counts what is carried and in the
 * chest and comes back short of the rest, as a build step does. `tick(min)` is the brain's tick that many minutes on:
 * the goal is asked, and run if it wants to (null: it did not want to).
 */
function roomHome(chest: Record<string, number>, carried: [string, number][] = []) {
  const w = world();
  w.landmarks.chests.push({ x: 1, y: 64, z: 1 });
  w.chestItems = { '1,64,1': chest };
  const inv = new Map(carried);
  const bill: Record<string, number> = { sugar_cane: 113, leather: 40 };
  const build: Step = {
    name: 'build',
    run: async (ctx) => {
      const there = (ctx.world.chestItems ?? {})['1,64,1'] ?? {};
      const short = Object.fromEntries(Object.entries(bill).map(([k, n]): [string, number] => [k, n - (inv.get(k) ?? 0) - (there[k] ?? 0)]).filter(([, n]) => n > 0));
      if (!Object.keys(short).length) return { status: 'done', text: 'built' };
      return { status: 'blocked', text: `gathering for the room: short of ${Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ')}`, retryMs: 3 * MIN, need: short };
    }
  };
  const goal = projectGoal([{ id: 'room', title: 'the room', prereqs: [], steps: [build] }]);
  const at = (min: number) => snap([...inv], { now: T + min * MIN });
  const tick = async (min: number, world = w) => (goal.wants(at(min), world) === null ? null : goal.run(ctxFor(world, at(min), [], inv)));
  return { w, chest, inv, bill, goal, at, tick };
}

test('the same step backs off 3, 6, 12, 24 min; trickling cane does not reset it; the whole bill met wakes it', async (t) => {
  t.deepEqual([1, 2, 3, 4, 5, 60].map(n => backoffMs(n) / MIN), [3, 6, 12, 24, 24, 24]);
  const h = roomHome({ sugar_cane: 10, leather: 2 }, [['sugar_cane', 7]]);
  const p = () => progressOf(h.w);
  // a tick a minute: the minutes at which the step ran (it ran every 3 min)
  const ran: number[] = [];
  for (let min = 0; min <= 75; min++) if (await h.tick(min) !== null) ran.push(min);
  t.deepEqual(ran, [0, 3, 9, 21, 45, 69]);
  // what it waits for: the totals that cover it (17 cane and 2 leather there, 96 and 38 short)
  const sixth = { id: 'room/0', n: 6, at: T + 69 * MIN, need: { sugar_cane: 113, leather: 40 } };
  t.deepEqual(p().blocked, sixth);
  t.deepEqual(p().blockedUntil, { room: T + 93 * MIN });
  // the journal has a line a run, no more
  const line = 'the room: build blocked (gathering for the room: short of 96 sugar_cane, 38 leather)';
  t.deepEqual(p().journal.map(j => j.text), ['started: the room', ...ran.map(() => line)]);
  t.deepEqual(h.goal.declines!(h.at(70), h.w), { cause: 'project', text: 'short of 96 sugar_cane, 38 leather (try 6, next 15:19)', until: T + 93 * MIN });

  // cane trickles in from the patch: the wait stays as it is, and says what is still short
  h.inv.set('sugar_cane', 27);
  t.is(await h.tick(71), null);
  t.is(h.goal.declines!(h.at(71), h.w)?.text, 'short of 76 sugar_cane, 38 leather (try 6, next 15:19)');
  // all the cane and all but one of the leather: a part of the bill is no reason to try again
  h.chest.sugar_cane = 200;
  h.chest.leather = 39;
  t.is(await h.tick(72), null);
  t.deepEqual(h.goal.declines!(h.at(72), h.w), { cause: 'project', text: 'short of 1 leather (try 6, next 15:19)', until: T + 93 * MIN });
  t.deepEqual(p().blocked, sixth, 'not reset');
  t.is(p().journal.length, 7);
  // the whole bill: the step runs at once, 20 min before its time
  h.chest.leather = 40;
  t.is(h.goal.declines!(h.at(73), h.w), null);
  t.is(h.goal.wants(h.at(73), h.w), 'the room: build');
  t.is(await h.tick(73), 'the room complete');
  t.deepEqual([p().blocked, p().blockedUntil, p().done], [undefined, {}, ['room']]);
});

test('woken by its bill and short again, the step waits the next, longer time: it does not come back at once', async (t) => {
  const h = roomHome({ sugar_cane: 10, leather: 2 }, [['sugar_cane', 7]]);
  t.deepEqual([await h.tick(0) !== null, await h.tick(3) !== null], [true, true]);
  t.is(progressOf(h.w).blockedUntil?.room, T + 9 * MIN);
  // all it was short of comes in, and the room turns out to take 10 leather more (the record was of the old count)
  h.chest.sugar_cane = 200;
  h.chest.leather = 40;
  h.bill.leather = 50;
  t.is(await h.tick(4), 'the room - build: gathering for the room: short of 10 leather');
  t.deepEqual(progressOf(h.w).blocked, { id: 'room/0', n: 3, at: T + 4 * MIN, need: { leather: 50 } });
  // the third time: 12 min, and nothing wakes it before
  const ran: number[] = [];
  for (let min = 4; min <= 16; min += 0.5) if (await h.tick(min) !== null) ran.push(min);
  t.deepEqual(ran, [16]);
  t.is(progressOf(h.w).blocked?.n, 4);
});

test('the bill counts as the step counts it: any log, either cobblestone, and only what is named', (t) => {
  t.deepEqual(stillShort({ log: 10, cobblestone: 20, leather: 3 }, { oak_log: 4, birch_log: 3, cobbled_deepslate: 12, cobblestone: 8, leather_boots: 1 }), { log: 3, leather: 3 });
  t.deepEqual(stillShort({ log: 7, coal: 2 }, { oak_log: 4, birch_log: 3, charcoal: 2, stripped_oak_wood: 9 }), {});
});

test('another step, or progress, resets the back-off', async (t) => {
  /** A tree whose steps come back with what `next` holds for them; `run(min)`: the tick `min` minutes on. */
  const project = (tree: (step: (name: string) => Step) => Milestone[]) => {
    const w = world();
    const inv = new Map<string, number>();
    const next: Record<string, StepResult> = {};
    const goal = projectGoal(tree(name => ({ name, run: async () => next[name] })));
    let now = T;
    const s = () => snap([...inv], { now });
    const run = async (min: number) => { now += min * MIN; return goal.wants(s(), w) === null ? null : goal.run(ctxFor(w, s(), [], inv)); };
    const rec = () => { const b = progressOf(w).blocked; return b ? `${b.id} x${b.n}` : 'none'; };
    /** minutes until the milestone is tried again, as the status says it */
    const wait = (id: string) => ((progressOf(w).blockedUntil?.[id] ?? now) - now) / MIN;
    return { w, inv, next, goal, run, rec, wait, s };
  };
  const short = (need: Record<string, number>): StepResult => ({ status: 'blocked', text: 'short', retryMs: 3 * MIN, need });

  // one milestone, two steps
  {
    const h = project(step => [{ id: 'wall', title: 'wall', prereqs: [], steps: [step('dig'), step('lay')] }]);
    h.next.dig = short({ cobblestone: 8 });
    await h.run(0); await h.run(3); await h.run(6);
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/0 x3', 12]);
    // it gets somewhere: the record is gone, and so is the wait (the next tick goes on)
    h.next.dig = { status: 'progress', text: 'dug 4 of 8' };
    t.is(await h.run(12), 'wall - dig: dug 4 of 8');
    t.deepEqual([h.rec(), progressOf(h.w).blockedUntil], ['none', {}]);
    t.is(h.goal.wants(h.s(), h.w), 'wall: dig');
    // short again: from the start
    h.next.dig = short({ cobblestone: 4 });
    await h.run(0);
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/0 x1', 3]);
    await h.run(3);
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/0 x2', 6]);
    // the step done, the next one short: another step, counted from one
    h.next.dig = { status: 'done', text: 'dug' };
    h.next.lay = short({ cobblestone: 30 });
    t.is(await h.run(6), 'wall - dig: dug');
    t.is(h.rec(), 'none');
    await h.run(0);
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/1 x1', 3]);
    await h.run(3);
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/1 x2', 6]);

    // blocked by something else in between (no room in the yard: 5 min): that wait is its own, and the cobblestone
    // coming in does not end it; the step has not got anywhere, so its count stands
    h.next.lay = { status: 'blocked', text: 'no room in the yard', retryMs: 5 * MIN };
    t.is(await h.run(6), 'wall - lay: no room in the yard');
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/1 x2', 5]);
    h.inv.set('cobblestone', 64);
    t.is(await h.run(1), null);
    t.like(h.goal.declines!(h.s(), h.w), { cause: 'project', until: T + 44 * MIN });
    t.is(await h.run(3.9), null);
    h.inv.delete('cobblestone');
    h.next.lay = short({ cobblestone: 30 });
    t.is(await h.run(0.1), 'wall - lay: short');
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/1 x3', 12]);
    // a wait of its own that ends when the record's would have: still not one the materials end
    h.next.lay = { status: 'blocked', text: 'the ground would not level', retryMs: 12 * MIN };
    h.inv.set('cobblestone', 64);
    t.is(await h.run(0), 'wall - lay: the ground would not level', 'woken by the cobblestone: the step ran');
    t.is(h.rec(), 'wall/1 x3');
    t.is(await h.run(1), null);
    t.is(await h.run(1), null);
    t.is(await h.run(10), null);
    t.is(await h.run(1), 'wall - lay: the ground would not level');
  }

  // two milestones that can both be worked: the one record goes to whichever step came back short last
  {
    const h = project(step => [{ id: 'wall', title: 'wall', prereqs: [], steps: [step('lay')] }, { id: 'pen', title: 'pen', prereqs: [], steps: [step('fence')] }]);
    h.next.lay = short({ cobblestone: 30 });
    h.next.fence = short({ log: 4 });
    await h.run(0);
    t.deepEqual([h.rec(), h.wait('wall')], ['wall/0 x1', 3]);
    await h.run(0);
    t.deepEqual([h.rec(), h.wait('wall'), h.wait('pen')], ['pen/0 x1', 3, 3]);
    // the wall's wait stands (it runs its 3 min, cobblestone or not); its count starts again
    h.inv.set('cobblestone', 64);
    t.is(await h.run(1), null);
    h.inv.delete('cobblestone');
    await h.run(2);
    t.deepEqual([h.rec(), h.wait('wall'), h.wait('pen')], ['wall/0 x1', 3, 0]);
    // the pen in place meanwhile (a fence someone built): nothing of it waits
    await h.run(0);
    t.is(h.rec(), 'pen/0 x1');
    progressOf(h.w).done.push('pen');
    t.is(h.goal.wants(h.s(), h.w), null);
    t.is(h.rec(), 'pen/0 x1', 'done by hand: the record is left, and waits for nobody');
    await h.run(3);
    t.is(h.rec(), 'wall/0 x1');
  }
});

test('urgency is 28 while a step has been blocked twice', async (t) => {
  const h = roomHome({ sugar_cane: 10, leather: 2 }, [['sugar_cane', 7]]);
  const u = (min: number, w = h.w) => h.goal.urgency!(h.at(min), w);
  // never run: ahead of the chores, as before
  t.is(u(0), 39);
  // short once (to wait 3 min): as before, ahead of the chores from 4 min after its run
  await h.tick(0);
  t.deepEqual([u(1), u(3), u(4), u(4.1)], [28, 28, 28, 39]);
  // short twice (6 min, to minute 11): it wants to run again, behind the chores where it was ahead of them
  await h.tick(5);
  t.is(progressOf(h.w).blocked?.n, 2);
  t.deepEqual([h.goal.wants(h.at(10.9), h.w), h.goal.wants(h.at(11), h.w)], [null, 'the room: build']);
  // (9.5: while it waits it does not want to run and is not asked; the answer is the same)
  t.deepEqual([u(9.5), u(11), u(14), u(16.9)], [28, 28, 28, 28]);
  // ... but not for good: behind them for as long again as it waited (chores that want all the time), it goes ahead
  t.deepEqual([u(17), u(40)], [39, 39]);
  // with all it waited for at home there is nothing to stay behind for: as any step, 4 min after its run
  const met = JSON.parse(JSON.stringify(h.w)) as WorldMemory;
  met.chestItems!['1,64,1'] = { sugar_cane: 200, leather: 40 };
  t.is(h.goal.wants(h.at(6), met), 'the room: build');
  t.deepEqual([u(6, met), u(9, met), u(9.1, met), u(11, met), u(14, met)], [28, 28, 39, 39, 39]);
  // short a third time (12 min, to minute 23): behind the chores to minute 35
  await h.tick(11);
  t.is(progressOf(h.w).blocked?.n, 3);
  t.deepEqual([u(23), u(34.9), u(35)], [28, 28, 39]);

  // while a step runs it keeps the raised urgency, short twice or not
  const w = world();
  const during: number[] = [];
  const goal = projectGoal([{ id: 'm', title: 'm', prereqs: [], steps: [{ name: 's', run: async (ctx) => { during.push(goal.urgency!(ctx.s, ctx.world)); return { status: 'blocked', text: 'short', need: { leather: 1 } }; } }] }]);
  for (const min of [0, 3, 9]) {
    const s = snap([], { now: T + min * MIN });
    t.truthy(goal.wants(s, w));
    await goal.run(ctxFor(w, s));
  }
  t.deepEqual(during, [39, 39, 39]);
  t.is(goal.urgency!(snap([], { now: T + 21 * MIN }), w), 28);

  // the step short twice is another milestone's than the one it would work on: as before
  const two = projectGoal([{ id: 'a', title: 'a', prereqs: [], steps: [{ name: 's', run: async () => ({ status: 'done', text: '' }) }] },
    { id: 'b', title: 'b', prereqs: [], steps: [{ name: 's', run: async () => ({ status: 'done', text: '' }) }] }]);
  const waits: WorldMemory = { ...world(), lastDone: { project: T },
    progress: { done: [], journal: [], blocked: { id: 'a/0', n: 2, at: T, need: { leather: 5 } }, blockedUntil: { a: T + 6 * MIN } } };
  t.is(two.wants(snap([], { now: T + 5 * MIN }), waits), 'b: s');
  t.is(two.urgency!(snap([], { now: T + 5 * MIN }), waits), 39);
  t.is(two.wants(snap([], { now: T + 6 * MIN }), waits), 'a: s');
  t.is(two.urgency!(snap([], { now: T + 6 * MIN }), waits), 28);
});

test('an old brain.json with blockedUntil and no blocked: its wait runs as written, and the next short step starts the back-off; a restart keeps it', async (t) => {
  const h = roomHome({ sugar_cane: 10, leather: 2 }, [['sugar_cane', 7]]);
  // as the code before left it: the step came back short at T, to be tried again 3 min on
  h.w.lastDone = { project: T };
  h.w.progress = { done: [], journal: [{ at: T, text: 'started: the room' }], current: { id: 'room', step: 0, data: {} },
    need: { sugar_cane: 96, leather: 38 }, blockedUntil: { room: T + 3 * MIN } };
  t.deepEqual(h.goal.declines!(h.at(1), h.w), { cause: 'project', text: 'short of 96 sugar_cane, 38 leather', until: T + 3 * MIN });
  t.deepEqual([h.goal.wants(h.at(1), h.w), h.goal.urgency!(h.at(1), h.w), h.goal.urgency!(h.at(5), h.w)], [null, 28, 39]);
  t.is(await h.tick(2), null);
  t.is(await h.tick(3), 'the room - build: gathering for the room: short of 96 sugar_cane, 38 leather');
  t.deepEqual(progressOf(h.w).blocked, { id: 'room/0', n: 1, at: T + 3 * MIN, need: { sugar_cane: 113, leather: 40 } });
  await h.tick(6);
  t.is(progressOf(h.w).blockedUntil?.room, T + 12 * MIN);

  // written to brain.json and read back (a restart): the wait, the try and what it waits for are all there
  const back = JSON.parse(JSON.stringify(h.w)) as WorldMemory;
  t.deepEqual(h.goal.declines!(h.at(7), back), { cause: 'project', text: 'short of 96 sugar_cane, 38 leather (try 2, next 13:58)', until: T + 12 * MIN });
  t.is(h.goal.urgency!(h.at(12), back), 28);
  back.chestItems!['1,64,1'] = { sugar_cane: 200, leather: 40 };
  t.is(h.goal.wants(h.at(7), back), 'the room: build');
  t.is(await h.tick(7, back), 'the room complete');

  // a record that is not one (a file edited by hand, a later format): nothing throws, and the wait runs its time
  for (const odd of [{}, null, 'x', 7, { id: 7, n: 'x' }, { id: 'room/0', n: 2, at: T + 6 * MIN }, { id: 'room/0', n: 1e9, at: T, need: null }, { id: 'room/0', n: -1, at: 'then', need: [] }]) {
    const w = JSON.parse(JSON.stringify(h.w)) as WorldMemory;
    (w.progress as unknown as Record<string, unknown>).blocked = odd;
    const said = `${JSON.stringify(odd)}`;
    t.notThrows(() => h.goal.urgency!(h.at(7), w), said);
    t.is(h.goal.wants(h.at(7), w), null, said);
    t.like(h.goal.declines!(h.at(7), w), { cause: 'project', until: T + 12 * MIN }, said);
    t.is(h.goal.wants(h.at(12), w), 'the room: build', said);
    t.truthy(await h.tick(12, w), said);
    t.like(w.progress?.blocked, { id: 'room/0', at: T + 12 * MIN, need: { sugar_cane: 113, leather: 40 } }, said);
    t.true((w.progress?.blockedUntil?.room ?? 0) > T + 12 * MIN, said);
  }
});
