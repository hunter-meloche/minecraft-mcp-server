import test from 'ava';
import { activityAt, daylightLeft } from '../../src/client/brain/schedule.js';
import { findLandmarks } from '../../src/client/brain/memory.js';
import { Brain, decide, wedgedOut } from '../../src/client/brain/brain.js';
import { brainRun, type ClientRuntime } from '../../src/client/tools.js';
import { closeDoors, type Goal, type GoalContext, type Snapshot } from '../../src/client/brain/goals.js';

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

test('closeDoors: shuts open doors near home that no plate holds open, not one the bot stands in', async (t) => {
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
    act: async (tool: string, a: Record<string, unknown> = {}) => { used.push(`${tool} ${a.x},${a.y},${a.z}`); return { ok: true, text: 'Used the held item on oak_door at (0, 64, 2): it is now oak_door[open=false]' }; }
  } as unknown as GoalContext;
  t.is(await closeDoors(ctx, { x: 0, y: 64, z: 0 }), 1);
  t.deepEqual(used, ['use-item-on-block 0,64,2']);
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

test('decide uses a goal\'s urgency when it has one', (t) => {
  const world = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  const chores = goal('chores', 40, true);
  const late: Goal = { ...goal('project', 25, true), urgency: s => (s.now > 5000 ? 52 : 25) };
  t.is(decide(snap({ now: 1000 }), world, [chores, late], new Map())?.goal.name, 'chores');
  t.is(decide(snap({ now: 9000 }), world, [chores, late], new Map())?.goal.name, 'project');
});

test('idle watchdog: by day, standing still with nothing to do, it lets go of every hold at 3 min and forages at 6', async (t) => {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 5000 };
  const { rt } = fakeRuntime(state);
  let clock = 1_000_000;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [goal('never', 1, false)] });
  brain.setEnabled(true);
  await brain.tick();
  clock += 2 * 60_000;
  await brain.tick();
  t.notRegex(brain.status(), /idle \d+ min/);
  clock += 61_000;
  await brain.tick();
  t.regex(brain.status(), /idle 3 min by day: let go of/);
  clock += 3 * 60_000;
  await brain.tick();
  await settle();
  t.regex(brain.status(), /start forage: idle 6 min by day/);
  // walking off starts the count again
  state.pos = { x: 20, y: 64, z: 0 };
  clock += 4 * 60_000;
  await brain.tick();
  t.is((brain.status().match(/idle \d+ min by day: let go/g) ?? []).length, 1);
});

test('idle watchdog: it lets go of fruitless stock marks but keeps spare time\'s (it would only go straight back)', async (t) => {
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
  t.regex(brain.status(), /idle 3 min by day: let go of fruitless:iron_ingot\b/);
  t.notRegex(brain.status(), /let go of.*fruitless:spare/);
  t.deepEqual(world.lastDone, { 'fruitless:spare:iron': 1_000_000, 'spare:iron': 1_000_000 });
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
