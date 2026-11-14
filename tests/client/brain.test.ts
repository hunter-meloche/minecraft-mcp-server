import test from 'ava';
import { activityAt, daylightLeft } from '../../src/client/brain/schedule.js';
import { findLandmarks } from '../../src/client/brain/memory.js';
import { Brain, decide, wedgedOut } from '../../src/client/brain/brain.js';
import { brainRun, type ClientRuntime } from '../../src/client/tools.js';
import { closeDoors, returnIdle, type Goal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';
import { out as afield } from '../../src/client/brain/pockets.js';
import { getOut, ownThin, stepsOut, type WedgeRuntime } from '../../src/client/brain/wedge.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const reply = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

test('the schedule: work by day, home in the evening, rest at night, and rest in a thunderstorm', (t) => {
  t.is(activityAt(0), 'work');
  t.is(activityAt(10_999), 'work');
  t.is(activityAt(11_000), 'return');
  t.is(activityAt(12_500), 'rest');
  t.is(activityAt(18_000), 'rest');
  t.is(activityAt(23_500), 'work');
  t.is(activityAt(24_000 + 5000), 'work');
  t.is(activityAt(5000, true), 'rest');
  t.is(daylightLeft(1000), 10_000);
  t.is(daylightLeft(23_600), 11_400);
  t.is(daylightLeft(12_000), 0);
});

test('findLandmarks: the bed by its head, the nearest chest first, furnace, table, farmland', (t) => {
  // 3 x 1 x 3 box at (0, 64, 0): x fastest, then z
  const blocks = [
    'minecraft:red_bed[facing=north,occupied=false,part=foot]', 'chest[facing=south,type=single,waterlogged=false]', 'farmland[moisture=7]',
    'minecraft:red_bed[facing=north,occupied=false,part=head]', 'air', 'furnace[facing=north,lit=false]',
    'crafting_table', null, 'barrel[facing=up,open=false]'
  ];
  const l = findLandmarks({ x: 0, y: 64, z: 0, width: 3, height: 1, length: 3 }, blocks, { x: 2, y: 64, z: 2 });
  t.deepEqual(l.bed, { x: 0, y: 64, z: 1 });
  t.deepEqual(l.chests, [{ x: 2, y: 64, z: 2 }, { x: 1, y: 64, z: 0 }]);
  t.deepEqual(l.furnace, { x: 2, y: 64, z: 1 });
  t.deepEqual(l.table, { x: 0, y: 64, z: 2 });
  t.deepEqual(l.farmland, [{ x: 2, y: 64, z: 0 }]);
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 1000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 0,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
});
const goal = (name: string, priority: number, wants: boolean): Goal => ({
  name, priority, wants: () => (wants ? `${name} wants` : null), run: async () => name, timeoutMs: 1000, retryMs: 1000
});

test('decide: the most urgent goal that wants to run, skipping one waiting out a failure', (t) => {
  const world = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  const goals = [goal('low', 1, true), goal('high', 50, true), goal('idle', 99, false)];
  t.is(decide(snap(), world, goals, new Map())?.goal.name, 'high');
  t.is(decide(snap(), world, goals, new Map([['high', 5000]]))?.goal.name, 'low');
  t.is(decide(snap({ now: 6000 }), world, goals, new Map([['high', 5000]]))?.goal.name, 'high');
  t.is(decide(snap(), world, [goal('none', 1, false)], new Map()), undefined);
});

/** A bot in a world with a home at (0, 64, 0) and a bed beside it. */
function fakeRuntime(state: { pos: { x: number; y: number; z: number }; time: number; sleeping?: boolean }) {
  const calls: string[] = [];
  const region = new Array(25 * 11 * 25).fill('air');
  // the bed's head at (1, 64, 0): box origin (-12, 60, -12)
  region[(1 + 12) + (0 + 12) * 25 + (64 - 60) * 25 * 25] = 'red_bed[facing=east,occupied=false,part=head]';
  let release: (() => void) | undefined;
  const rt: ClientRuntime = {
    actions: {
      'go-home': async () => { calls.push('go-home'); state.pos = { x: 0, y: 64, z: 0 }; return reply('Home'); },
      'move-to-position': async (a) => { calls.push(`move-to-position ${a.x},${a.y},${a.z}`); return reply('Successfully moved'); },
      'wall-in': async () => { calls.push('wall-in'); return reply('Walled in'); },
      'slow': async () => { calls.push('slow'); await new Promise<void>(r => { release = r; }); await rt.call('status'); return reply('slow done'); }
    },
    call: (async (method: string) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      calls.push(method);
      if (method === 'inventory') return { items: [] };
      if (method === 'world.region') return { blocks: region };
      if (method === 'bed.sleep') { state.sleeping = true; return { sleeping: true }; }
      if (method === 'bed.wake') { state.sleeping = false; return { wasSleeping: true }; }
      if (method === 'cancel') { release?.(); return {}; }
      return {};
    }) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: state.pos, block: state.pos, timeOfDay: state.time, hashedSeed: '1',
      dimension: 'overworld', sleeping: !!state.sleeping, health: 20, food: 20 }),
    home: () => ({ x: 0, y: 64, z: 0, dimension: 'overworld' }),
    lastDeath: () => undefined,
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  };
  return { rt, calls };
}

const settle = () => new Promise(r => setTimeout(r, 20));

test('the brain walks home in the evening, goes to bed at night and gets up in the morning', async (t) => {
  const state = { pos: { x: 60, y: 64, z: 0 }, time: 11_500 };
  const { rt, calls } = fakeRuntime(state);
  const brain = new Brain(rt, { tickMs: 1e9 });
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.true(calls.includes('go-home'));
  t.regex(brain.status(), /done shelter in \d+s: walked home/);
  t.regex(brain.status(), /Landmarks: bed none/); // too far from home to look when it set out

  state.time = 13_000;
  calls.length = 0;
  await brain.tick();
  await settle();
  t.deepEqual(calls.filter(c => !['inventory', 'world.region', 'hud.set', 'foreign.at'].includes(c)), ['move-to-position 0,64,0', 'bed.sleep']); // onto the home cell, then the bed is in reach
  t.regex(brain.status(), /asleep in the bed at \(1, 64, 0\)/);
  t.regex(brain.status(), /Landmarks: bed \(1, 64, 0\)/);

  state.time = 23_600;
  await brain.tick();
  await settle();
  t.false(!!(state as { sleeping?: boolean }).sleeping);
  t.regex(brain.status(), /done wake/);
  brain.setEnabled(false);
});

test('an LLM tool call stops the running goal and keeps the brain out until it has been quiet', async (t) => {
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 1000 };
  const { rt, calls } = fakeRuntime(state);
  const busy: Goal = { name: 'busy', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, goals: [busy], now: () => now });
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.regex(brain.status(), /Now: busy/);
  await brain.manual('dig-block');
  t.true(calls.includes('cancel'));
  t.regex(brain.status(), /stopped busy: aborted/); // its next bridge call failed at once
  t.regex(brain.status(), /Paused for the LLM for 1\.0 more min \(last tool: dig-block\)/);
  calls.length = 0;
  now = 30_000;
  await brain.tick();
  t.deepEqual(calls, []); // still the LLM's
  now = 61_000;
  await brain.tick();
  await settle();
  t.true(calls.includes('slow'));
  brain.setEnabled(false);
});

test('stuck away from home at night: wall in and wait for morning', async (t) => {
  const state = { pos: { x: 80, y: 64, z: 0 }, time: 14_000 };
  const { rt, calls } = fakeRuntime(state);
  rt.actions['go-home'] = async () => { calls.push('go-home'); return reply('Stopped 80 blocks from home', true); };
  const brain = new Brain(rt, { tickMs: 1e9 });
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.deepEqual(calls.filter(c => /go-home|wall-in/.test(c)), ['go-home', 'wall-in']);
  calls.length = 0;
  await brain.tick();
  await settle();
  t.false(calls.includes('go-home')); // holed up till morning
  brain.setEnabled(false);
});

test('closeDoors: shuts open doors near home that no plate holds open, not one the bot stands in, toggling only (a held water bucket poured)', async (t) => {
  const box = { x: -8, y: 62, z: -8, width: 17, height: 6, length: 17 };
  const blocks = new Array(box.width * box.height * box.length).fill('air');
  const idx = (x: number, y: number, z: number) => (x - box.x) + (z - box.z) * box.width + (y - box.y) * box.width * box.length;
  blocks[idx(0, 64, 2)] = 'oak_door[facing=south,half=lower,hinge=left,open=true,powered=false]';  // left open: shut it
  blocks[idx(0, 65, 2)] = 'oak_door[facing=south,half=upper,hinge=left,open=true,powered=false]';
  blocks[idx(4, 64, 0)] = 'spruce_door[facing=west,half=lower,hinge=left,open=true,powered=true]'; // on a plate: shuts itself
  blocks[idx(-3, 64, 0)] = 'oak_door[facing=west,half=lower,hinge=left,open=false,powered=false]'; // shut already
  blocks[idx(1, 64, 1)] = 'oak_door[facing=west,half=lower,hinge=left,open=true,powered=false]';   // the bot is in it
  const used: string[] = [];
  const ctx = {
    call: (async () => ({ blocks })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null, block: { x: 1, y: 64, z: 1 } }),
    act: async (tool: string, a: Record<string, unknown> = {}) => { used.push(`${tool} ${a.x},${a.y},${a.z}${a.toggle ? ' toggle' : ''}`); return { ok: true, text: 'Used the held item on oak_door at (0, 64, 2): it is now oak_door[open=false]' }; }
  } as unknown as GoalContext;
  t.is(await closeDoors(ctx, { x: 0, y: 64, z: 0 }), 1);
  t.deepEqual(used, ['use-item-on-block 0,64,2 toggle']);
});

test('the status line for the bot\'s window: off, the goal and its step, paused for the LLM, idle, asleep', async (t) => {
  let now = 0;
  const state = { pos: { x: 60, y: 64, z: 0 }, time: 11_500 };
  const { rt } = fakeRuntime(state);
  const shown: string[] = [];
  const call = rt.call;
  rt.call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'hud.set') { shown.push(String(p?.text)); return {}; }
    return call(m, p);
  }) as ClientRuntime['call'];
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => now });
  t.is(brain.statusLine(), 'Autopilot off');
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.true(shown.includes('Autopilot: shelter - evening: head home before dark'));
  t.is(shown.at(-1), 'Autopilot: idle (evening)');
  await brain.manual('dig-block');
  t.is(shown.at(-1), 'Autopilot paused: LLM in control (dig-block), back in 1 min');
  now = 61_000;
  state.time = 13_000;
  await brain.tick();
  await settle();
  await brain.tick();
  t.is(shown.at(-1), 'Autopilot: asleep');
  brain.setEnabled(false);
  await settle();
  t.is(shown.at(-1), 'Autopilot off');
});

test('three failures in a row leave a goal until the next morning', async (t) => {
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  let runs = 0;
  const flaky: Goal = { name: 'flaky', priority: 10, wants: () => 'test', run: async () => { runs++; throw new Error('no'); }, timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [flaky], now: () => now });
  brain.setEnabled(true);
  for (let i = 0; i < 3; i++) { await brain.tick(); await settle(); now += 2000; }
  t.is(runs, 3);
  t.regex(brain.status(), /flaky failed 3 times in a row: left until the morning/);
  now += 60_000;
  await brain.tick(); await settle();
  t.is(runs, 3); // 18000 ticks to the morning = 15 minutes
  now += 15 * 60_000;
  await brain.tick(); await settle();
  t.is(runs, 4);
  brain.setEnabled(false);
});

test('the watchdog stops a Baritone job that has not moved the bot in 3 minutes', async (t) => {
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt, calls } = fakeRuntime(state);
  const status = rt.status;
  rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
  const stuck: Goal = { name: 'stuck', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [stuck], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  now += 60_000; await brain.tick();
  t.false(calls.includes('cancel'));
  now += 3.1 * 60_000; await brain.tick(); await settle(); // 3 minutes since it was first seen standing there
  t.true(calls.includes('cancel'));
  t.regex(brain.status(), /stuck looks stuck \(no movement for 3 min at 0,64,0\)/);
  brain.setEnabled(false);
});

test('a retry after a stuck stop gets its own 3 minutes, not the last job\'s clock', async (t) => {
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt, calls } = fakeRuntime(state);
  const status = rt.status;
  rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
  const stuck: Goal = { name: 'stuck', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [stuck], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  now += 5000; await brain.tick(); await settle(); // the watchdog's first look at it
  now += 3.1 * 60_000; await brain.tick(); await settle();
  t.is(calls.filter(c => c === 'cancel').length, 1);
  now += 3.1 * 60_000; await brain.tick(); await settle(); // the retry starts
  now += 5000; await brain.tick(); await settle();
  now += 5000; await brain.tick(); await settle();          // 10 s in: not stuck yet (it was, every time, at the south fence)
  t.is(calls.filter(c => c === 'cancel').length, 1);
  t.is((brain.status().match(/stuck looks stuck/g) ?? []).length, 1);
  brain.setEnabled(false);
});

/** A 3x2x3 region round (0, 64, 0) with `feet` in the middle and the given side cells (dx,dz) filled at both heights. */
const box3 = (feet: string, filled: [number, number][] = []) => {
  const b = new Array<string>(18).fill('air');
  b[1 + 1 * 3] = feet;
  for (const [dx, dz] of filled) for (const dy of [0, 1]) b[(dx + 1) + (dz + 1) * 3 + dy * 9] = 'oak_fence[east=true,west=true]';
  return b;
};

test('wedgedOut: standing in a fence cell, step to the open side nearest the bot; not when the cell is clear', (t) => {
  const fence = 'oak_fence[east=true,north=false,south=false,waterlogged=false,west=true]';
  // the fence line runs east-west; the bot hugs its south side (z .95 floors into the fence cell)
  t.deepEqual(wedgedOut({ x: 0.5, y: 64, z: 0.95 }, box3(fence, [[1, 0], [-1, 0]])), { block: 'oak_fence', to: { x: 0.5, y: 64, z: 1.5 } });
  t.deepEqual(wedgedOut({ x: 0.5, y: 64, z: 0.05 }, box3(fence, [[1, 0], [-1, 0]]))?.to, { x: 0.5, y: 64, z: -0.5 });
  t.is(wedgedOut({ x: 0.5, y: 64, z: 0.95 }, box3('air')), undefined);
  t.is(wedgedOut({ x: 0.5, y: 64, z: 0.95 }, box3('birch_fence_gate[facing=north,open=true]')), undefined);
  t.is(wedgedOut({ x: 0.5, y: 64, z: 0.95 }, box3(fence, [[1, 0], [-1, 0], [0, 1], [0, -1]])), undefined); // nowhere to go
  t.is(wedgedOut({ x: 0.5, y: 64, z: 0.95 }, box3('redstone_wall_torch[facing=north]')), undefined);
});

test('the watchdog steps a bot wedged in a fence out by hand after half a minute, and lets the job go again soon', async (t) => {
  let now = 0;
  const state = { pos: { x: 0.5, y: 64, z: 0.95 }, time: 6000 };
  const { rt, calls } = fakeRuntime(state);
  const status = rt.status;
  rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
  const call = rt.call;
  const steered: unknown[] = [];
  rt.call = (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'world.region' && params?.width === 3) return { blocks: box3('oak_fence[east=true,west=true]', [[1, 0], [-1, 0]]) };
    if (method === 'steer') { steered.push(params); return { reached: true }; }
    return call(method, params);
  }) as ClientRuntime['call'];
  const stuck: Goal = { name: 'stuck', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [stuck], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  now += 5000; await brain.tick(); await settle();
  now += 20_000; await brain.tick(); await settle();
  t.is(steered.length, 0);
  now += 15_000; await brain.tick(); await settle();
  t.true(calls.includes('cancel'));
  t.deepEqual(steered, [{ x: 0.5, y: 64, z: 1.5, within: 0.25, timeoutMs: 2000 }]);
  t.regex(brain.status(), /stuck is wedged in the oak_fence at 0,64,0: stepping out/);
  now += 6000; await brain.tick(); await settle();
  t.regex(brain.status(), /start stuck: test[\s\S]*start stuck: test/); // again in seconds, not 3 minutes
  brain.setEnabled(false);
});

test('a walk with an animal on its lead that is wedged in a shut gate is stepped out of all the same: its word keeps the chores off it, not the wedge watch', async (t) => {
  // pens.ts never waits for a led animal in or by a gateway any more (two walks home stood in the yard's north gate for
  // the cow and were stopped there, Nov 13), so a led walk standing half a minute in a gate with Baritone on is a real
  // wedge, and Baritone never steps out of one: the watch stops it, the run lets the cow off its lead
  let now = 0;
  const state = { pos: { x: 0.5, y: 64, z: 0.95 }, time: 6000 };
  const { rt, calls } = fakeRuntime(state);
  const status = rt.status;
  rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
  const call = rt.call;
  const steered: unknown[] = [];
  rt.call = (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'world.region' && params?.width === 3) return { blocks: box3('oak_fence_gate[facing=north,in_wall=false,open=false,powered=false]', [[1, 0], [-1, 0]]) };
    if (method === 'steer') { steered.push(params); return { reached: true }; }
    return call(method, params);
  }) as ClientRuntime['call'];
  let ledAs: AbortSignal | undefined;
  const leading: Goal = {
    name: 'leading', priority: 10, wants: () => 'test', timeoutMs: 60 * 60_000, retryMs: 1000,
    run: async ctx => { ledAs = ctx.signal; afield.ledBy = ctx.signal; try { return (await ctx.act('slow')).text; } finally { if (afield.ledBy === ctx.signal) afield.ledBy = undefined; } }
  };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [leading], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  t.is(afield.ledBy, ledAs);
  now += 5000; await brain.tick(); await settle();
  now += 20_000; await brain.tick(); await settle();
  t.is(steered.length, 0);
  now += 15_000; await brain.tick(); await settle();
  t.true(calls.includes('cancel'));
  t.deepEqual(steered, [{ x: 0.5, y: 64, z: 1.5, within: 0.25, timeoutMs: 2000 }]);
  t.regex(brain.status(), /leading is wedged in the oak_fence_gate at 0,64,0: stepping out/);
  t.is(afield.ledBy, undefined);
  brain.setEnabled(false);
});

/**
 * The live corner (Nov 13): the cow pen's south-west post at (-558, 63, 2171) with a torch on it, the pen's west fence
 * running north from it and its south fence east, the pen's inside corner cell (-557, 63, 2170) across the corner, an
 * oak log past the post to the south-west. The 3x2x3 round the post from (-559, 63, 2170).
 */
const POST = { x: -558, y: 63, z: 2171 };
const corner3 = () => {
  const b = new Array<string>(18).fill('air');
  const put = (dx: number, dy: number, dz: number, v: string) => { b[(dx + 1) + (dz + 1) * 3 + dy * 9] = v; };
  put(0, 0, -1, 'oak_fence[east=false,north=true,south=true,waterlogged=false,west=false]');
  put(0, 0, 0, 'oak_fence[east=true,north=true,south=false,waterlogged=false,west=false]');
  put(1, 0, 0, 'oak_fence[east=true,north=false,south=false,waterlogged=false,west=true]');
  put(1, 0, -1, 'short_grass');
  put(-1, 0, 1, 'oak_log[axis=y]');
  put(-1, 1, 1, 'oak_log[axis=y]');
  put(0, 1, 0, 'torch');
  return b;
};
/** pressed into that corner from inside the pen: the bot's middle 0.075 into the post's cell both ways */
const IN_CORNER = { x: -557.075, y: 63, z: 2171.075 };

test('wedgedOut: pressed into a pen\'s corner from inside, the step is across the corner into the pen, not through the post; against it from outside, the open side the bot is on', (t) => {
  t.deepEqual(wedgedOut(IN_CORNER, corner3()), { block: 'oak_fence', to: { x: -556.5, y: 63, z: 2170.5 } });
  // (then the other open sides, the nearest first: through the post from here)
  t.deepEqual(stepsOut(IN_CORNER, corner3()), [{ x: -556.5, y: 63, z: 2170.5 }, { x: -558.5, y: 63, z: 2171.5 }, { x: -557.5, y: 63, z: 2172.5 }]);
  t.deepEqual(wedgedOut({ x: -557.95, y: 63, z: 2171.6 }, corner3())?.to, { x: -558.5, y: 63, z: 2171.5 });
  t.deepEqual(wedgedOut({ x: -557.6, y: 63, z: 2171.95 }, corner3())?.to, { x: -557.5, y: 63, z: 2172.5 });
  // in the outside corner, the log on the diagonal: the side cell
  t.deepEqual(wedgedOut({ x: -557.95, y: 63, z: 2171.95 }, corner3())?.to, { x: -558.5, y: 63, z: 2171.5 });
});

test('live, Nov 13: wedged in its own pen\'s corner post where no step gets it out, the bot digs the post out, steps out and puts it back, the torch on it too', async (t) => {
  let now = 0;
  const state = { pos: { ...IN_CORNER }, time: 6000 };
  const { rt, calls } = fakeRuntime(state);
  const status = rt.status;
  rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
  const call = rt.call;
  const steered: unknown[] = [];
  let dug = false;
  rt.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'world.region' && params.width === 3) return { blocks: dug ? corner3().map((b, i) => (i === 4 || i === 13 ? 'air' : b)) : corner3() };
    if (method === 'steer') {
      steered.push({ x: params.x, z: params.z });
      // with the post standing, every straight walk out goes into it (live: 142 step-outs); dug out, the bot goes
      if (!dug) return { reached: false, distance: 1.49, at: { ...POST } };
      state.pos = { x: Number(params.x), y: 63, z: Number(params.z) };
      return { reached: true, distance: 0.1, at: { x: Math.floor(state.pos.x), y: 63, z: Math.floor(state.pos.z) } };
    }
    if (method === 'dig.here') { dug = true; return { dug: true, block: 'oak_fence', tool: 'diamond_axe' }; }
    return call(method, params);
  }) as ClientRuntime['call'];
  // the post and its torch in the bot's record of what it built
  rt.builtNear = () => [{ at: { ...POST }, state: 'oak_fence' }, { at: { ...POST, y: 64 }, state: 'torch' }];
  const restored: string[] = [];
  rt.restoreBlock = async (at, item) => { restored.push(`${item} ${at.x},${at.y},${at.z}`); return undefined; };
  const round: Goal = { name: 'pens', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [round], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  now += 5000; await brain.tick(); await settle();
  now += 20_000; await brain.tick(); await settle();
  now += 15_000; await brain.tick(); await settle();
  t.true(calls.includes('cancel'));
  // the plain step across the corner into the pen, then the next way out: neither gets past the post
  t.deepEqual(steered.slice(0, 2), [{ x: -556.5, z: 2170.5 }, { x: -558.5, z: 2171.5 }]);
  t.true(dug);
  // out the way it came, into the pen's corner cell, and the post and the torch back from there
  t.deepEqual(steered.slice(2), [{ x: -556.5, z: 2170.5 }]);
  t.deepEqual(restored, ['oak_fence -558,63,2171', 'torch -558,64,2171']);
  t.regex(brain.status(), /stopping pens: pens is wedged in the oak_fence at -558,63,2171: stepping out/);
  t.regex(brain.status(), /wedged in the oak_fence at \(-558, 63, 2171\): dug it out, stepped out, put it back/);
  t.regex(brain.status(), /Blocked: pens held until [\d:]+ \(wedged\)/);
  brain.setEnabled(false);
});

/**
 * getOut over a client where no plain step gets the bot out, and the dig's reply is `dig`: what it called and put
 * back (`log`), and what it put in the record of the bot's builds (`recorded`).
 */
function wedgeRt(built: { at: { x: number; y: number; z: number }; state?: string }[], dig: Record<string, unknown>, restore: (item: string) => string | undefined = () => undefined) {
  const log: string[] = [];
  const recorded: string[] = [];
  let pos = { ...IN_CORNER };
  let dug = false;
  const rt = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      log.push(method);
      if (method === 'dig.here') { dug = !!dig.dug; return dig; }
      if (method === 'steer') {
        if (!dug) return { reached: false, at: { ...POST } };
        pos = { x: Number(params.x), y: 63, z: Number(params.z) };
        return { reached: true };
      }
      return {};
    },
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: { ...pos } }),
    builtNear: () => built,
    restoreBlock: async (_at: unknown, item: string) => { const why = restore(item); log.push(`restore ${item}${why ? `: ${why}` : ''}`); return why; },
    protectBuilt: (blocks: { at: { x: number; y: number; z: number }; state: string }[]) => { for (const b of blocks) recorded.push(`${b.state} ${b.at.x},${b.at.y},${b.at.z}`); }
  } as unknown as WedgeRuntime;
  return { rt, log, recorded };
}
const bare = (over: Partial<WorldMemory> = {}): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96, ...over });

test('getOut: a thin block not the bot\'s own is never dug; one on a pen\'s ring is its own without a record; the client\'s refusal and what did not go back are said', async (t) => {
  const own = [{ at: { ...POST }, state: 'oak_fence' }, { at: { ...POST, y: 64 }, state: 'torch' }];
  // nobody's record, no ring of the bot's there: left as it is
  const a = wedgeRt([], { dug: true });
  t.deepEqual(await getOut(a.rt, bare(), IN_CORNER, corner3()), { out: false, line: 'wedged in the oak_fence at (-558, 63, 2171): could not step out, and it is not the bot\'s own to dig out' });
  t.deepEqual(a.log, ['steer', 'steer']);
  // the post on the cow pen's ring (posts one over the zone's ground), no record: dug, and put back as it stood
  const b = wedgeRt([], { dug: true });
  const pen = bare({ zones: { 'pen:cow': [{ x: -558, y: 62, z: 2165, width: 7, length: 7 }] } });
  t.deepEqual(await getOut(b.rt, pen, IN_CORNER, corner3()), { out: true, line: 'wedged in the oak_fence at (-558, 63, 2171): dug it out, stepped out, put it back' });
  t.deepEqual(b.log.filter(l => l !== 'steer'), ['dig.here', 'restore oak_fence', 'restore torch']);
  // and into the record as it stood, the torch on it too, once dug: the repair round puts back only what that holds
  t.deepEqual(b.recorded, ['oak_fence[east=true,north=true,south=false,waterlogged=false,west=false] -558,63,2171', 'torch -558,64,2171']);
  // in a build the client knows for someone's: it refuses the dig, and nothing else is done
  const c = wedgeRt(own, { dug: false, reason: 'someone else\'s build (force: true to dig it anyway)', block: 'oak_fence' });
  t.deepEqual(await getOut(c.rt, bare(), IN_CORNER, corner3()), { out: false, line: 'wedged in the oak_fence at (-558, 63, 2171): could not step out or dig it out (someone else\'s build)' });
  t.false(c.log.some(l => l.startsWith('restore')));
  t.deepEqual(c.recorded, []);
  // the post back, the torch not (none picked up, after a second try): said, for the repair round; both were in the
  // record already, so nothing goes in it
  const d = wedgeRt(own, { dug: true }, item => (item === 'torch' ? 'no torch in the inventory' : undefined));
  t.deepEqual(await getOut(d.rt, bare(), IN_CORNER, corner3()), { out: true, line: 'wedged in the oak_fence at (-558, 63, 2171): dug it out, stepped out, put it back, but not the torch on it (no torch in the inventory)' });
  t.deepEqual(d.log.filter(l => l.startsWith('restore')), ['restore oak_fence', 'restore torch: no torch in the inventory', 'restore torch: no torch in the inventory']);
  t.deepEqual(d.recorded, []);
});

test('getOut: a put-back the pick-up came too late for (or a cow stood in the gap) is tried once more, and goes back', async (t) => {
  const own = [{ at: { ...POST }, state: 'oak_fence' }, { at: { ...POST, y: 64 }, state: 'torch' }];
  let tries = 0;
  const late = wedgeRt(own, { dug: true }, item => (item === 'oak_fence' && tries++ === 0 ? 'no oak_fence in the inventory' : undefined));
  t.deepEqual(await getOut(late.rt, bare(), IN_CORNER, corner3()), { out: true, line: 'wedged in the oak_fence at (-558, 63, 2171): dug it out, stepped out, put it back' });
  t.deepEqual(late.log.filter(l => l.startsWith('restore')), ['restore oak_fence: no oak_fence in the inventory', 'restore oak_fence', 'restore torch']);
});

test('getOut: one of the bot\'s own panes is never dug (it breaks to nothing, and a window would keep the hole)', async (t) => {
  const pane = corner3().map((b, i) => (i === 4 ? 'glass_pane[east=true,north=true,south=false,waterlogged=false,west=false]' : b));
  const w = wedgeRt([{ at: { ...POST }, state: 'glass_pane' }], { dug: true });
  t.deepEqual(await getOut(w.rt, bare(), IN_CORNER, pane), { out: false, line: 'wedged in the glass_pane at (-558, 63, 2171): could not step out, and a glass_pane dug out would not come back (not dug)' });
  t.deepEqual(w.log, ['steer', 'steer']);
});

test('getOut: once the autopilot no longer has the bot (the LLM took over, or autonomy off) it digs, steps and puts back nothing more', async (t) => {
  const own = [{ at: { ...POST }, state: 'oak_fence' }, { at: { ...POST, y: 64 }, state: 'torch' }];
  // stopped during the plain steps: no dig
  const a = wedgeRt(own, { dug: true });
  t.deepEqual(await getOut(a.rt, bare(), IN_CORNER, corner3(), () => false), { out: false, line: 'wedged in the oak_fence at (-558, 63, 2171): could not step out; left to the one who took over' });
  t.deepEqual(a.log, ['steer', 'steer']);
  // stopped during the dig: no step after it, nothing put back
  let asked = 0;
  const b = wedgeRt(own, { dug: true });
  t.deepEqual(await getOut(b.rt, bare(), IN_CORNER, corner3(), () => asked++ === 0), { out: false, line: 'wedged in the oak_fence at (-558, 63, 2171): dug it out; left for the repair round to put back (the autopilot was stopped)' });
  t.deepEqual(b.log, ['steer', 'steer', 'dig.here']);
  // stopped after the step out: the put-back left for the repair round
  asked = 0;
  const c = wedgeRt(own, { dug: true });
  t.deepEqual(await getOut(c.rt, bare(), IN_CORNER, corner3(), () => asked++ < 2), { out: true, line: 'wedged in the oak_fence at (-558, 63, 2171): dug it out, stepped out, could not put it back (the autopilot was stopped): left for the repair round' });
  t.false(c.log.some(l => l.startsWith('restore')));
});

test('the wedge watch: the LLM takes over while the bot steps out of its pen\'s corner post: the post is not dug', async (t) => {
  let now = 0;
  const state = { pos: { ...IN_CORNER }, time: 6000 };
  const { rt } = fakeRuntime(state);
  const status = rt.status;
  rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
  const call = rt.call;
  let steers = 0, dug = false;
  const the: { brain?: Brain } = {};
  rt.call = (async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'world.region' && params.width === 3) return { blocks: corner3() };
    // every step out goes into the post; at the second, the LLM runs a tool of its own
    if (method === 'steer') { if (++steers === 2) await the.brain!.manual('move-to-position'); return { reached: false, distance: 1.49, at: { ...POST } }; }
    if (method === 'dig.here') { dug = true; return { dug: true }; }
    return call(method, params);
  }) as ClientRuntime['call'];
  rt.builtNear = () => [{ at: { ...POST }, state: 'oak_fence' }, { at: { ...POST, y: 64 }, state: 'torch' }];
  rt.restoreBlock = async () => undefined;
  const round: Goal = { name: 'pens', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = the.brain = new Brain(rt, { tickMs: 1e9, goals: [round], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  now += 5000; await brain.tick(); await settle();
  now += 20_000; await brain.tick(); await settle();
  now += 15_000; await brain.tick(); await settle();
  t.is(steers, 2);
  t.false(dug);
  t.regex(brain.status(), /wedged in the oak_fence at \(-558, 63, 2171\): could not step out; left to the one who took over/);
  brain.setEnabled(false);
});

test('ownThin: in the record, or a fence, gate or wall on the yard\'s ring or a pen\'s, one over its ground; nothing else', (t) => {
  const w = bare({ zones: { fence: [{ x: -565, y: 62, z: 2119, width: 33, length: 97 }], 'pen:cow': [{ x: -558, y: 62, z: 2165, width: 7, length: 7 }] } });
  t.true(ownThin(w, [], { x: -565, y: 63, z: 2150 }, 'oak_fence[north=true,south=true]'));
  t.true(ownThin(w, [], { x: -549, y: 63, z: 2119 }, 'oak_fence_gate[facing=north,open=false]'));
  t.true(ownThin(w, [], { x: -555, y: 63, z: 2165 }, 'cobblestone_wall'));
  t.false(ownThin(w, [], { x: -555, y: 64, z: 2165 }, 'oak_fence'));
  t.false(ownThin(w, [], { x: -556, y: 63, z: 2167 }, 'oak_fence'));
  t.false(ownThin(w, [], { x: -565, y: 63, z: 2150 }, 'glass_pane'));
  t.true(ownThin(bare(), [{ at: { x: 3, y: 64, z: 4 }, state: 'iron_bars' }], { x: 3, y: 64, z: 4 }, 'iron_bars'));
  t.false(ownThin(bare(), [], { x: 3, y: 64, z: 4 }, 'oak_fence'));
});

test('decide uses a goal\'s urgency when it has one', (t) => {
  const world = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  const chores = goal('chores', 40, true);
  const late: Goal = { ...goal('project', 25, true), urgency: s => (s.now > 5000 ? 52 : 25) };
  t.is(decide(snap({ now: 1000 }), world, [chores, late], new Map())?.goal.name, 'chores');
  t.is(decide(snap({ now: 9000 }), world, [chores, late], new Map())?.goal.name, 'project');
});

test('decide asks each goal\'s urgency once, and orders by it as before', (t) => {
  // the sort asked it at every comparison: the stock trip's urgency makes a kit plan, and over the real goal list a
  // decision on the live homestead took 5.7 ms (3.4 ms asked once), every 5 s tick
  const world = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  const asked = new Map<string, number>();
  const counted = (name: string, priority: number, wants: boolean, urgency: number): Goal =>
    ({ ...goal(name, priority, wants), urgency: () => { asked.set(name, (asked.get(name) ?? 0) + 1); return urgency; } });
  const goals = [counted('a', 10, false, 30), counted('b', 20, true, 12), goal('c', 25, false), counted('d', 5, true, 15), counted('e', 1, false, 40), goal('f', 14, true)];
  t.is(decide(snap(), world, goals, new Map())?.goal.name, 'd');
  t.deepEqual(Object.fromEntries(asked), { a: 1, b: 1, d: 1, e: 1 });
});

test('idle watchdog: by day, standing still with nothing to do, it lets go of every hold at 3 min, starts nothing itself, and goes round again after 16', async (t) => {
  // (until step 5 it foraged at 6 min: a stock trip or a cow fetch without their own waits; the stock goal and the
  // work queue's cows rung do those now)
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 5000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [goal('never', 1, false)] });
  brain.setEnabled(true);
  const letGo = () => (brain.status().match(/idle \d+ min by day: let go/g) ?? []).length;
  await brain.tick();
  clock += 2 * 60_000;
  await brain.tick();
  t.notRegex(brain.status(), /idle \d+ min/);
  clock += 61_000;
  await brain.tick();
  t.regex(brain.status(), /idle 3 min by day: let go of/);
  // standing on to 18 min: nothing is started (no forage at 6), and the holds are not let go again in that round
  for (let i = 0; i < 15; i++) { clock += 60_000; await brain.tick(); await settle(); }
  t.notRegex(brain.status(), /start (forage|never)/);
  t.is(letGo(), 1);
  // the next round began at 16 min: 3 min into it, the holds go again
  clock += 61_000;
  await brain.tick();
  t.is(letGo(), 2);
  // walking off starts the count again
  state.pos = { x: 20, y: 64, z: 0 };
  clock += 4 * 60_000;
  await brain.tick();
  t.is(letGo(), 2);
  brain.setEnabled(false);
});

test('idle watchdog: at 3 min it lets go of the holds and keeps every fruitless mark, the stock trips\' like spare time\'s (it would only go straight back)', async (t) => {
  // live 2026-11-10: "idle 3 min by day: let go of fruitless:sugar_cane" every 10 to 20 min all day, and each time
  // the stock goal walked straight back out to the cane that was not there
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 5000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000;
  const flaky: Goal = { name: 'flaky', priority: 5, wants: () => 'wants', run: async () => { throw new Error('in the way'); }, timeoutMs: 60_000, retryMs: 10 * 60_000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [flaky] });
  brain.setEnabled(true);
  await brain.tick(); await settle(); // it fails: held for 10 minutes
  const world = brain.worldMemory()!;
  const marks = { 'fruitless:iron_ingot': clock, 'fruitless:sugar_cane': clock, 'fruitless:spare:iron': clock, 'spare:iron': clock };
  world.lastDone = { ...marks };
  clock += 3 * 60_000 + 1000;
  await brain.tick(); await settle();
  // the note names what was let go, and only that
  t.regex(brain.status(), /idle 3 min by day: let go of flaky 419s\n/);
  t.notRegex(brain.status(), /let go of.*fruitless/);
  t.deepEqual(world.lastDone, marks);
  t.regex(brain.status(), /start flaky: wants[\s\S]*start flaky: wants/); // the hold did go: it tries again
  brain.setEnabled(false);
});

test('idle watchdog: with nothing held, the 3-minute note says so and no mark goes', async (t) => {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 5000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [goal('never', 1, false)] });
  brain.setEnabled(true);
  await brain.tick();
  const world = brain.worldMemory()!;
  world.lastDone = { 'fruitless:iron_ingot': clock, 'fruitless:spare:iron': clock, 'spare:iron': clock };
  clock += 3 * 60_000 + 1000;
  await brain.tick();
  t.regex(brain.status(), /idle 3 min by day: let go of nothing \(nothing was held\)\n/);
  t.deepEqual(world.lastDone, { 'fruitless:iron_ingot': 1_000_000, 'fruitless:spare:iron': 1_000_000, 'spare:iron': 1_000_000 });
  brain.setEnabled(false);
});

test('a goal left "until the morning" may go again when the game morning comes, slept through or not', async (t) => {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 5000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000;
  const flaky: Goal = { name: 'flaky', priority: 5, wants: () => 'wants', run: async () => { throw new Error('in the way'); }, timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [flaky] });
  brain.setEnabled(true);
  for (let i = 0; i < 3; i++) { await brain.tick(); await settle(); clock += 2000; }
  t.regex(brain.status(), /flaky failed 3 times in a row: left until the morning/);
  t.regex(brain.status(), /Retrying later: flaky \d+s/);
  state.time = 12_900; await brain.tick(); await settle();
  state.time = 100; // the night skipped in a bed: morning at once, long before the real-time hold runs out
  clock += 2000;
  await brain.tick(); await settle();
  t.regex(brain.status(), /morning: flaky may try again/);
});

test('a LOOP back-off holds through the morning and the idle watchdog, and a loop back again is backed off again', async (t) => {
  // live 2026-11-09: the enchanting room and the stash took turns 51 times in an hour: "morning: project may try
  // again" 3.5 min after the LOOP undid its back-off, and the loop wasn't reported (nor backed off) for half an hour
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 5000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000;
  let runs = 0;
  const spin: Goal = { name: 'spin', priority: 5, wants: () => 'wants', run: async () => { runs++; return 'nothing to show'; }, timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [spin] });
  brain.setEnabled(true);
  const go = async (n: number, step = 2000) => { for (let i = 0; i < n; i++) { await brain.tick(); await settle(); clock += step; } };
  await go(6);
  t.is(runs, 4);
  t.regex(brain.status(), /LOOP \(spinning\).*spin backed off for 10 min/);
  // the night skipped in a bed: the morning lets holds go, not this one
  state.time = 12_900; await go(1);
  state.time = 100; await go(1);
  t.notRegex(brain.status(), /morning: spin may try again/);
  // standing idle by day 3 min and more: the watchdog's let-go leaves it too
  await go(4, 60_000);
  t.is(runs, 4);
  t.notRegex(brain.status(), /let go of spin/);
  // its 10 minutes up, it goes again; going round again within the half hour backs it off again, unreported. Its
  // old four turns are still within the watch's 15 minutes, so the first new one is the loop again (until step 5 the
  // watchdog's forage ran in between at 6 min, and then it took four new turns)
  clock += 6 * 60_000;
  await go(6);
  t.is(runs, 5);
  t.regex(brain.status(), /LOOP again \(spinning: spin\); spin backed off for 10 min/);
  await go(5);
  t.is(runs, 5);
  brain.setEnabled(false);
});

// ---- the hand-over: the next look follows a run's end at once ----

/** What the hand-over's tests look at inside the brain: the tick waiting to follow, one asked for mid-tick, the run in hand. */
const inside = (brain: Brain) => brain as unknown as { chained?: unknown; again: boolean; running?: { done: Promise<void> } };

/**
 * A brain by day with two goals, each wanted once: `first` runs until the test ends it (`end`, with an error to fail
 * it; the brain stopping it ends it too), `second` is over at once. `looks` counts the brain's looks at the world
 * (one per tick that got that far), `began` the runs in the order they started.
 */
function relay() {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  const at = { clock: 1_000_000, looks: 0, inWorld: true };
  const status = rt.status;
  rt.status = async () => { at.looks++; return { ...(await status()), inWorld: at.inWorld }; };
  const began: string[] = [];
  let end: (e?: Error) => void = () => undefined;
  const first: Goal = {
    name: 'first', priority: 10, wants: () => (began.includes('first') ? null : 'to do'), timeoutMs: 600_000, retryMs: 1000,
    run: ctx => new Promise<string>((res, rej) => {
      began.push('first');
      end = e => (e ? rej(e) : res('through'));
      ctx.signal.addEventListener('abort', () => rej(new Error('aborted')));
    })
  };
  const second: Goal = { name: 'second', priority: 5, wants: () => (began.includes('second') ? null : 'next'), run: async () => { began.push('second'); return 'ok'; }, timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => at.clock, goals: [first, second] });
  brain.setEnabled(true);
  return { brain, at, began, end: (e?: Error) => end(e) };
}

test('the tick after a run ends follows at once: after 2 s of work the next goal starts with no further tick; a run over sooner waits for the tick', async (t) => {
  // 2.1 s of work (and 2 s on the dot): the next goal has started, and one look did it
  for (const ms of [2100, 2000]) {
    const r = relay();
    await r.brain.tick(); await settle();
    t.deepEqual(r.began, ['first']);
    r.at.clock += ms;
    r.end(); await settle(); // no tick() from here
    t.deepEqual(r.began, ['first', 'second'], `${ms} ms`);
    t.regex(r.brain.status(), /- 00:16:42 done first in 2s: through\n- 00:16:42 start second: next\n/, `${ms} ms`);
    t.is(r.at.looks, 2, `${ms} ms`); // the first tick's and the one that followed the run; the second run was over at once: nothing follows it
    r.brain.setEnabled(false);
  }

  // a run that failed after 2.1 s of trying is followed the same way: it is held, the next goal is not kept waiting
  const failed = relay();
  await failed.brain.tick(); await settle();
  failed.at.clock += 2100;
  failed.end(new Error('no way through')); await settle();
  t.deepEqual(failed.began, ['first', 'second']);
  t.regex(failed.brain.status(), /- 00:16:42 failed first: no way through\n- 00:16:42 start second: next\n/);
  failed.brain.setEnabled(false);

  // over sooner (failed after 100 ms; done just short of 2 s; done at once): it did nothing or failed at once, and the
  // next look is the tick's, so nothing goes round faster than the tick does
  for (const [ms, err] of [[100, 'no way through'], [1999, ''], [0, '']] as const) {
    const r = relay();
    await r.brain.tick(); await settle();
    r.at.clock += ms;
    r.end(err ? new Error(err) : undefined); await settle();
    t.deepEqual(r.began, ['first'], `${ms} ms`);
    t.is(r.at.looks, 1, `${ms} ms`);
    t.is(inside(r.brain).chained, undefined, `${ms} ms`);
    r.at.clock += 5000;
    await r.brain.tick(); await settle(); // the 5 s tick
    t.deepEqual(r.began, ['first', 'second'], `${ms} ms`);
    r.brain.setEnabled(false);
  }
});

test('a chained tick and the interval tick never start two goals: asked for while a tick is under way, one tick follows it, and one run is in hand', async (t) => {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000, looks = 0, alarm = false;
  // the look at the world waits for the test: a tick is under way for as long
  let gate: Promise<void> | undefined, open = () => { /* nothing waits */ };
  const shut = () => { gate = new Promise<void>(r => { open = r; }); };
  const status = rt.status;
  rt.status = async () => { looks++; await gate; return status(); };
  // runs that last until the test (or the brain) ends them; `most`: how many were ever under way at once
  let live = 0, most = 0;
  const began: string[] = [];
  const ends = new Map<string, () => void>();
  const work = (name: string, priority: number, wants: () => string | null): Goal => ({
    name, priority, wants, timeoutMs: 600_000, retryMs: 1000,
    run: ctx => new Promise<string>((res, rej) => {
      began.push(name);
      most = Math.max(most, ++live);
      let over = false;
      const close = (how: () => void) => { if (over) return; over = true; live--; how(); };
      ends.set(name, () => close(() => res('through')));
      ctx.signal.addEventListener('abort', () => close(() => rej(new Error('aborted'))));
    })
  });
  const goals = [work('a', 10, () => (began.includes('a') ? null : 'once')), work('b', 5, () => 'always'), work('urgent', 50, () => (alarm ? 'alarm' : null))];
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals });
  brain.setEnabled(true);

  // three ask at once (the interval's tick, and two more while it looks): however many asked, one tick follows
  shut();
  const under = brain.tick();
  await brain.tick(); await brain.tick(); // both come back at once: a tick is under way
  t.is(looks, 1);
  t.true(inside(brain).again);
  open(); await under; await settle();
  t.is(looks, 2);            // the one that follows: one, not two
  t.deepEqual(began, ['a']); // and it found the run in hand: nothing started beside it
  t.false(inside(brain).again);

  // a run ends (3 s in) while the interval's tick is looking: the tick its end asks for lands on that one, which goes
  // on to start the next goal; the tick that follows finds it running
  clock += 3000;
  shut();
  const looking = brain.tick();
  ends.get('a')!(); await settle();
  t.is(looks, 3);
  t.true(inside(brain).again); // asked for, not lost, and not a second tick beside the one under way
  t.deepEqual(began, ['a']);
  open(); await looking; await settle();
  t.is(looks, 4);
  t.deepEqual(began, ['a', 'b']);

  // a run stopped for something more urgent: the tick that follows starts that, and only that (the stopped goal
  // wants to go on, and is not started beside it)
  clock += 3000;
  alarm = true;
  await brain.tick(); await settle();
  t.is(looks, 6);
  t.deepEqual(began, ['a', 'b', 'urgent']);
  t.regex(brain.status(), /stopping b: urgent is more urgent \(alarm\)\n- 00:16:46 stopped b: aborted\n- 00:16:46 start urgent: alarm$/);
  t.is(live, 1);
  await settle();
  t.is(looks, 6); // nothing goes on looking
  t.is(most, 1);  // never two runs at once

  brain.setEnabled(false); await settle();
  t.is(live, 0);
  t.is(looks, 6);
  t.is(inside(brain).chained, undefined);
});

test('no tick follows a run\'s end with the brain switched off or the LLM at the bot; one that waits is dropped at switch-off; with the game gone it looks once', async (t) => {
  // switched off mid-run, 3 s in: the run is stopped, and nothing looks again
  const off = relay();
  await off.brain.tick(); await settle();
  off.at.clock += 3000;
  off.brain.setEnabled(false); await settle();
  t.regex(off.brain.status(), /stopped first: aborted/);
  t.is(off.at.looks, 1);
  t.deepEqual(off.began, ['first']);
  t.is(inside(off.brain).chained, undefined);

  // the LLM takes the bot 3 s in: the same (the next goal would start under its hands)
  const llm = relay();
  await llm.brain.tick(); await settle();
  llm.at.clock += 3000;
  await llm.brain.manual('dig-block');
  t.is(inside(llm.brain).chained, undefined); // none is even set to follow (it would find the LLM's time and go, but it is not the autopilot's to ask for)
  await settle();
  t.regex(llm.brain.status(), /stopped first: aborted/);
  t.is(llm.at.looks, 1);
  t.deepEqual(llm.began, ['first']);
  t.is(inside(llm.brain).chained, undefined);
  llm.brain.setEnabled(false);

  // switched off between a run's end and the tick it asked for: that tick is dropped, not left to fire later
  const late = relay();
  await late.brain.tick(); await settle();
  late.at.clock += 3000;
  const done = inside(late.brain).running!.done;
  late.end(); await done; // the run is over; the tick that follows has not begun
  t.truthy(inside(late.brain).chained);
  late.brain.setEnabled(false);
  t.is(inside(late.brain).chained, undefined);
  await settle();
  t.is(late.at.looks, 1);
  t.deepEqual(late.began, ['first']);

  // the game client gone when the run ends: the look that follows sees no world and starts nothing, and that is all
  const gone = relay();
  await gone.brain.tick(); await settle();
  gone.at.clock += 3000;
  gone.at.inWorld = false;
  gone.end(); await settle(); await settle();
  t.is(gone.at.looks, 2);
  t.deepEqual(gone.began, ['first']);
  gone.brain.setEnabled(false);
});

test('a tick still looking at the world when the brain is switched off, or when the LLM takes the bot, starts nothing', async (t) => {
  // the tick that follows a run's end can be under way at any moment, not only on the 5 s beat: what it decides
  // after the bot was taken from it would run with nobody to stop it
  for (const how of ['switched off', 'the LLM'] as const) {
    const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 6000 });
    let started = 0, open = () => { /* nothing waits */ };
    const gate = new Promise<void>(r => { open = r; });
    const status = rt.status;
    rt.status = async () => { await gate; return status(); };
    const work: Goal = { name: 'work', priority: 5, wants: () => 'wants', run: async () => { started++; return 'ok'; }, timeoutMs: 60_000, retryMs: 1000 };
    const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => 1_000_000, goals: [work] });
    brain.setEnabled(true);
    const under = brain.tick(); // it waits for its look at the world
    if (how === 'switched off') brain.setEnabled(false);
    else await brain.manual('dig-block');
    open(); await under; await settle();
    t.is(started, 0, how);
    t.notRegex(brain.status(), /start work/, how);
    t.is(inside(brain).chained, undefined, how);
    brain.setEnabled(false);
  }
});

test('a goal that goes round with nothing to show hands over to itself, and the loop watch holds it at the fourth run as before', async (t) => {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000, looks = 0, runs = 0;
  const status = rt.status;
  rt.status = async () => { looks++; return status(); };
  let end = () => { /* nothing runs yet */ };
  const spin: Goal = {
    name: 'spin', priority: 5, wants: () => 'wants', timeoutMs: 60_000, retryMs: 1000,
    run: () => new Promise<string>((res) => { runs++; end = () => res('nothing to show'); })
  };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [spin] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  // each run 2 s of nothing, the next one following at once: four of them, then its 10 minutes off
  for (let i = 0; i < 6; i++) { clock += 2000; end(); await settle(); }
  t.is(runs, 4);
  t.regex(brain.status(), /LOOP \(spinning\).*spin backed off for 10 min/);
  t.is(looks, 5); // the test's one tick, and one after each run: the last found it held, and nothing looked after that
  brain.setEnabled(false);
});

test('a survival goal that goes round with nothing to show keeps the tick\'s beat: nothing follows its end at once, and nothing holds it', async (t) => {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000, looks = 0, runs = 0;
  const status = rt.status;
  rt.status = async () => { looks++; return status(); };
  let end = () => { /* nothing runs yet */ };
  // one of the six the loop watch never backs off, by its name; and the run the live log had 51 times in a row
  // (2026-11-08: "done food in 3s: found cow to the north; now carrying 0 food points")
  const food: Goal = {
    name: 'food', priority: 80, wants: () => 'nothing to eat', timeoutMs: 60_000, retryMs: 1000,
    run: () => new Promise<string>((res) => { runs++; end = () => res('found cow to the north; now carrying 0 food points'); })
  };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [food] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  for (let i = 1; i <= 6; i++) {
    // 2.7 s of work, which any other goal hands on at once (the test above): no look follows this one, and no run
    clock += 2700; end(); await settle();
    t.is(runs, i, `round ${i}`);
    t.is(looks, i, `round ${i}`);
    t.is(inside(brain).chained, undefined, `round ${i}`);
    // the 5 s tick starts the next: one run per tick, as before the hand-over, with nothing to hold it back
    clock += 2300;
    await brain.tick(); await settle();
    t.is(runs, i + 1, `round ${i}`);
  }
  // the loop watch saw it go round, and held nothing: the tick is all there is between its turns
  t.regex(brain.status(), /LOOP \(spinning\)/);
  t.notRegex(brain.status(), /backed off/);
  t.regex(brain.status(), /- 00:16:42 done food in 3s: found cow to the north; now carrying 0 food points\n- 00:16:45 start food: nothing to eat\n/);
  brain.setEnabled(false);
});

test('returnIdle: "out here" is more than 32 blocks from home, inside the yard too, or more than 8 outside the yard\'s rectangle', (t) => {
  const out = 'nothing to do out here: back to the yard';
  const base = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  const at = (x: number, z: number, over: Partial<Snapshot> = {}) => snap({ position: { x, y: 64, z }, distHome: Math.hypot(x, z), ...over });
  // no yard yet: 32 blocks from home
  t.is(returnIdle.wants(at(32, 0), base), null);
  t.is(returnIdle.wants(at(32.5, 0), base), out);
  // the yard as it is by now: 32 by 96, home 64 blocks from its north end. The 32 from home hold inside the fence
  // too: the home's chores start within 10 to 24 blocks of home, and the tree round ends in the tree farm, 46 from
  // home. With the fence alone as the measure the bot stood there, every chore "away", until the evening
  const world = { ...base, yard: { x1: -16, z1: -64, x2: 16, z2: 32, y: 63 } };
  t.is(returnIdle.wants(at(10, -45), world), out);  // the tree farm
  t.is(returnIdle.wants(at(10, -60), world), out);  // by the north fence, 61 blocks from home
  t.is(returnIdle.wants(at(10, -30), world), null); // inside the fence, 31.6 from home
  t.is(returnIdle.wants(at(0, -32), world), null);
  t.is(returnIdle.wants(at(0, -32.5), world), out);
  // out past the fence it is sooner: more than 8 blocks outside, however near home
  t.is(returnIdle.wants(at(24, 0), world), null);   // 8 outside the fence, 24 from home
  t.is(returnIdle.wants(at(24.5, 0), world), out);
  t.is(returnIdle.wants(at(24, 20), world), null);  // 8 outside, 31.2 from home
  t.is(returnIdle.wants(at(24.5, 20), world), out); // 8.5 outside, 31.6 from home
  // and where the fence is far from home, the 32 come first: within 8 of the fence is still "out here"
  t.is(returnIdle.wants(at(0, -72), world), out);   // 8 outside the north fence, 72 from home
  t.is(returnIdle.wants(at(0, -72.5), world), out);
  t.is(returnIdle.wants(at(0, 39), world), out);    // 7 outside the south fence, 39 from home
  t.is(returnIdle.wants(at(22, 40), world), out);   // off the corner (6 and 8 outside), 45.7 from home
  t.is(returnIdle.wants(at(22, 41), world), out);
  // off a corner it is the larger of the two directions, not the straight line (a small yard, so that home is near)
  const small = { ...base, yard: { x1: -14, z1: -14, x2: 14, z2: 14, y: 63 } };
  t.is(returnIdle.wants(at(21, 21), small), null);  // 7 and 7 outside (9.9 in a straight line), 29.7 from home
  t.is(returnIdle.wants(at(22.5, 21), small), out); // 8.5 and 7
  // not in the evening or at night (the shelter's business), with no home, or from another dimension
  for (const w of [base, world]) {
    t.is(returnIdle.wants(at(60, 0, { activity: 'return' }), w), null);
    t.is(returnIdle.wants(at(60, 0, { activity: 'rest' }), w), null);
    t.is(returnIdle.wants(at(60, 0, { home: undefined }), w), null);
    t.is(returnIdle.wants(at(60, 0, { dimension: 'the_nether', distHome: Infinity }), w), null);
    t.is(returnIdle.wants(at(60, 0), w), out);
  }
  // home no longer in the yard on record (it was moved): the walk ends at home, so home is what counts, or the bot
  // would be "out here" again on arriving
  const moved = { ...base, yard: { x1: 100, z1: 100, x2: 120, z2: 120, y: 63 } };
  t.is(returnIdle.wants(at(0, 0), moved), null);
  t.is(returnIdle.wants(at(32, 0), moved), null);
  t.is(returnIdle.wants(at(40, 0), moved), out);
  t.is(returnIdle.wants(at(110, 110), moved), out); // in the old yard, 156 blocks from home
});

test('left at the far end of the yard with nothing to do, the bot walks home, and the chore that waited for it there starts as the walk ends', async (t) => {
  // the live yard on 2026-11-10: 96 blocks long, home 64 from its north end; the tree round ends in the tree farm, 46
  // blocks from home and inside the fence, and no chore of the home starts from further than 24
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  let arrive = () => { /* not walking yet */ };
  rt.actions['go-home'] = async () => { await new Promise<void>(r => { arrive = r; }); state.pos = { x: 0, y: 64, z: 0 }; return reply('Home'); };
  let clock = 1_000_000, due = false, swept = 0;
  const chore: Goal = { name: 'chore', priority: 20, wants: s => (due && s.distHome <= 24 ? 'due' : null), run: async () => { due = false; swept++; return 'swept'; }, timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [chore, returnIdle] });
  brain.setEnabled(true);
  await brain.tick(); // the first look: the world is known from here
  brain.worldMemory()!.yard = { x1: -16, z1: -64, x2: 16, z2: 32, y: 63 };
  state.pos = { x: 10, y: 64, z: -45 };
  due = true;
  clock += 5000; await brain.tick(); await settle();
  t.regex(brain.status(), /- 00:16:45 start idle: nothing to do out here: back to the yard$/);
  t.is(swept, 0);
  // home after 9 s: the chore is in reach, and starts in that second with no tick of the test's
  clock += 9000; arrive(); await settle();
  t.regex(brain.status(), /- 00:16:54 done idle in 9s: back home\n- 00:16:54 start chore: due\n/);
  t.is(swept, 1);
  brain.setEnabled(false);
});

test('idle watchdog: the time a goal was at work is not idle time, however still the bot stood: a stuck stop\'s hold is not let go at the next look', async (t) => {
  // live 2026-11-10 09:00: "stopping stash: stash looks stuck (no movement for 3 min ...)", and 5 s on "idle 3 min by
  // day: let go of stash 175s": the 3 minutes it stood stuck had been counted as standing idle
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 6000 };
  const { rt, calls } = fakeRuntime(state);
  const status = rt.status;
  rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
  const stuck: Goal = { name: 'stuck', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [stuck], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  now += 60_000; await brain.tick();
  now += 3.1 * 60_000; await brain.tick(); await settle();
  t.regex(brain.status(), /stuck looks stuck \(no movement for 3 min at 0,64,0\)/);
  for (let i = 0; i < 6; i++) { now += 5000; await brain.tick(); await settle(); } // half a minute on
  t.notRegex(brain.status(), /idle \d+ min by day/);
  t.regex(brain.status(), /Retrying later: stuck 150s\./);
  t.is(calls.filter(c => c === 'slow').length, 1);
  brain.setEnabled(false);
});
