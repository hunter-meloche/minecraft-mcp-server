import test, { type ExecutionContext } from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolFactory } from '../../src/tool-factory.js';
import { registerBrainTools } from '../../src/client/brain/brain-tools.js';
import { activityAt, daylightLeft } from '../../src/client/brain/schedule.js';
import { findLandmarks } from '../../src/client/brain/memory.js';
import { Brain, CRITICAL_CUTS, LEAD_TIMEOUT_MS, NO_LOOP_HOLD, SURVIVAL, decide, wedgedOut } from '../../src/client/brain/brain.js';
import { lockSeen, outOfHallGoal, outOfHallWants, villagerCareGoal } from '../../src/client/brain/villagercare.js';
import { hallChoresGoal, inHallBox } from '../../src/client/brain/hallchores.js';
import { fetchOf, peekFetch, type FetchMemory, type Trip } from '../../src/client/brain/fetch.js';
import { strictGates, strictSet } from '../../src/client/brain/yardgates.js';
import { H, HOME as YARD_HOME, T0, YARD_GATES, isOpen, yard, type Pasture } from '../helpers/pasture.js';
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

test('findLandmarks: what an unloaded look (just after a rejoin) cannot see stays as known; what it sees gone goes', (t) => {
  const box = { x: 0, y: 64, z: 0, width: 3, height: 1, length: 3 };
  const home = { x: 2, y: 64, z: 2 };
  const before = findLandmarks(box, [
    'minecraft:red_bed[facing=north,occupied=false,part=foot]', 'chest[facing=south,type=single,waterlogged=false]', 'farmland[moisture=7]',
    'minecraft:red_bed[facing=north,occupied=false,part=head]', 'anvil[facing=north]', 'furnace[facing=north,lit=false]',
    'crafting_table', null, 'barrel[facing=up,open=false]'
  ], home);
  // 11-21: the chunks round home not in yet, every cell null: the bed and the chests went, and the bot walled in at home
  const blind = findLandmarks(box, Array(9).fill(null), home, before);
  t.deepEqual(blind.bed, { x: 0, y: 64, z: 1 });
  t.deepEqual(blind.chests, before.chests);
  t.deepEqual(blind.furnace, before.furnace);
  t.deepEqual(blind.table, before.table);
  t.deepEqual(blind.anvil, before.anvil);
  t.deepEqual(blind.farmland, before.farmland);
  // half seen: the loaded cells say what is there (the barrel and the furnace gone), the unloaded ones keep theirs
  const half = findLandmarks(box, [null, null, null, null, null, 'air', 'crafting_table', null, 'air'], home, before);
  t.deepEqual(half.chests, [{ x: 1, y: 64, z: 0 }]);
  t.is(half.furnace, undefined);
  t.deepEqual(half.bed, { x: 0, y: 64, z: 1 });
  t.deepEqual(half.table, { x: 0, y: 64, z: 2 });
  // a full look is the truth: no bed seen, no bed
  const gone = findLandmarks(box, Array(9).fill('air'), home, before);
  t.is(gone.bed, undefined);
  t.deepEqual(gone.chests, []);
  t.is(gone.anvil, undefined);
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

/**
 * The brain's work after a tick or a run's end, done: 20 ms, then the event loop turned over until its chain of ticks
 * (each a setTimeout 0, brain.ts soon) has run. A bare 20 ms timer under a loaded machine (the whole suite's workers at
 * once) fired before the chained tick, and the tick-chaining tests failed now and then; every other wait is a promise.
 */
/** The event loop turned over until `ok` holds, at most 10 s of real time (the caller's checks then say what did not come). */
const turnsUntil = async (ok: () => boolean) => {
  const by = Date.now() + 10_000;
  while (!ok() && Date.now() < by) await new Promise(r => setImmediate(r));
};
const settle = async (brain?: Brain, until?: () => boolean) => {
  await new Promise(r => setTimeout(r, 20));
  for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r));
  if (!brain) return;
  // then by the brain's own state, not by a time (the S1 follow-up: still red under the whole suite's load): the event
  // loop turned over until no tick is under way and none waits to follow, three turns running, and what the test waits
  // for (`until`) has come; at most 10 s of real time, after which the test's own checks say what did not happen
  const by = Date.now() + 10_000;
  for (let calm = 0; calm < 3 && Date.now() < by;) {
    await new Promise(r => setImmediate(r));
    const b = inside(brain);
    calm = b.ticking || b.chained || (until && !until()) ? 0 : calm + 1;
  }
};

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

/** A villager trip of the fetch's in `state` whose beat is `beat` (a lead's poll renews it): tripLive while it is under 90 s old. */
const liveTrip = (beat: number, over: Partial<Trip> = {}): Trip => ({
  id: 3, kind: 'bring', site: 'village -693,2262', state: 'hop', beat, prep: {},
  gate: { at: { x: 0, y: 64, z: -20 }, side: 'north', inner: { x: 0, y: 64, z: -18 }, outer: { x: 0, y: 64, z: -22 }, yard: 20 },
  spare: [], lure: 'fletching_table', avoid: [], times: {}, counts: { hops: 0, misses: 0, wedges: 0, pins: 0 }, ...over
});

// (serial: out.ledBy is the module's one hold, and another test's lead would take it over)
test.serial('a run that leads a villager (out.ledBy its own, its trip live) is not stopped at its goal\'s timeout, only at LEAD_TIMEOUT_MS; one that does not lead is; a lead that ended by a throw leaves no hold behind (S1 review S4, S5)', async (t) => {
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 1000 };
  const { rt } = fakeRuntime(state);
  t.teardown(() => { afield.ledBy = undefined; });
  // care's 10 minutes, a resume that leads: on at 11 min, stopped past the lead's cap
  const lead: Goal = {
    name: 'lead', priority: 10, wants: () => 'test', timeoutMs: 10 * 60_000, retryMs: 1000,
    run: async ctx => { afield.ledBy = ctx.signal; return (await ctx.act('slow')).text; }
  };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [lead], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  // the trip it leads, its beat renewed at every poll as a lead's is
  const w = brain.worldMemory()!;
  w.fetch = { v: 1, journal: [], wards: [], nextId: 4, trip: liveTrip(now) };
  const beat = () => { (w.fetch as FetchMemory).trip!.beat = now; };
  now += 11 * 60_000; beat(); await brain.tick(); await settle();
  t.notRegex(brain.status(), /lead ran out of time/, 'a lead is not cut at the goal\'s 10 minutes');
  now += LEAD_TIMEOUT_MS; beat(); await brain.tick(); await settle();
  t.regex(brain.status(), /lead ran out of time/, 'the cap');
  brain.setEnabled(false);
  await settle();
  // the same goal without the hold: cut at its own timeout
  const plain: Goal = { name: 'plain', priority: 10, wants: () => 'test', timeoutMs: 10 * 60_000, retryMs: 1000, run: async ctx => (await ctx.act('slow')).text };
  const other = new Brain(fakeRuntime(state).rt, { tickMs: 1e9, goals: [plain], now: () => now });
  other.setEnabled(true);
  await other.tick(); await settle();
  now += 11 * 60_000; await other.tick(); await settle();
  t.regex(other.status(), /plain ran out of time/);
  other.setEnabled(false);
  await settle();
  // a lead that throws (no cut): its hold goes with the run
  let mine: AbortSignal | undefined;
  const throws: Goal = { name: 'throws', priority: 10, wants: () => 'test', timeoutMs: 60_000, retryMs: 1000, run: async ctx => { mine = ctx.signal; afield.ledBy = ctx.signal; throw new TypeError('bridge data not as expected'); } };
  const third = new Brain(fakeRuntime(state).rt, { tickMs: 1e9, goals: [throws], now: () => now });
  third.setEnabled(true);
  await third.tick(); await settle();
  t.truthy(mine);
  t.regex(third.status(), /failed throws: bridge data not as expected/);
  t.is(afield.ledBy, undefined, 'no hold of a dead run left for care to take as a run at the trip');
  third.setEnabled(false);
});

test.serial('S1 follow-up V-3: the pens round\'s lead of an animal (out.ledBy, no villager trip) is stopped at its own timeout as before, and so is one whose trip\'s beat has lapsed', async (t) => {
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 1000 };
  t.teardown(() => { afield.ledBy = undefined; });
  // pens.ts: 8 minutes, a cow on the lead the whole way (afield.ledBy its own signal)
  const pens: Goal = {
    name: 'pens', priority: 10, wants: () => 'test', timeoutMs: 8 * 60_000, retryMs: 1000,
    run: async ctx => { afield.ledBy = ctx.signal; try { return (await ctx.act('slow')).text; } finally { if (afield.ledBy === ctx.signal) afield.ledBy = undefined; } }
  };
  const brain = new Brain(fakeRuntime(state).rt, { tickMs: 1e9, goals: [pens], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  now += 7 * 60_000; await brain.tick(); await settle();
  t.notRegex(brain.status(), /pens ran out of time/);
  now += 2 * 60_000; await brain.tick(); await settle();
  t.regex(brain.status(), /stopping pens: pens ran out of time/, 'cut at its own 8 minutes, not at LEAD_TIMEOUT_MS');
  brain.setEnabled(false);
  await settle();
  // a villager lead whose trip nobody beats any more (a dead poll, an old record) is no lead to the clock either
  now = 0;
  const lead: Goal = { ...pens, name: 'lead', timeoutMs: 10 * 60_000 };
  const other = new Brain(fakeRuntime(state).rt, { tickMs: 1e9, goals: [lead], now: () => now });
  other.setEnabled(true);
  await other.tick(); await settle();
  other.worldMemory()!.fetch = { v: 1, journal: [], wards: [], nextId: 4, trip: liveTrip(now) };
  now += 11 * 60_000; await other.tick(); await settle();
  t.regex(other.status(), /stopping lead: lead ran out of time/);
  other.setEnabled(false);
});

test.serial('S1 follow-up Y-1: a lead inside its own section at a yard gate or the lock is cut only at LEAD_TIMEOUT_MS, its beat stale or not (gateIn\'s and lockIn\'s walks and waits before their poll loops); not by a section of the hall\'s, nor once its section has lapsed', async (t) => {
  let now = 0;
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 1000 };
  t.teardown(() => { afield.ledBy = undefined; delete afield.critical; });
  let signal: AbortSignal | undefined;
  // care's 10 minutes: a resume that leads (out.ledBy its own)
  const lead: Goal = {
    name: 'lead', priority: 10, wants: () => 'test', timeoutMs: 10 * 60_000, retryMs: 1000,
    run: async ctx => { signal = ctx.signal; afield.ledBy = ctx.signal; try { return (await ctx.act('slow')).text; } finally { if (afield.ledBy === ctx.signal) afield.ledBy = undefined; } }
  };
  const run = async (why: 'gate' | 'lock' | 'hall', o: { lapsed?: boolean; at?: number } = {}) => {
    now = 0;
    const brain = new Brain(fakeRuntime(state).rt, { tickMs: 1e9, goals: [lead], now: () => now });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    // the trip it leads, its beat 95 s stale at the 11th minute (the walk to the post, the clear wait: no poll yet)
    brain.worldMemory()!.fetch = { v: 1, journal: [], wards: [], nextId: 4, trip: liveTrip(now, { state: why === 'lock' ? 'lock' : 'gate' }) };
    now += o.at ?? 11 * 60_000;
    (brain.worldMemory()!.fetch as FetchMemory).trip!.beat = now - 95_000;
    afield.critical = { by: signal!, until: o.lapsed ? now - 1000 : now + 45_000, why };
    await brain.tick(); await settle();
    const status = brain.status();
    brain.setEnabled(false);
    await settle();
    delete afield.critical;
    return status;
  };
  t.notRegex(await run('gate'), /lead ran out of time/, 'inside its gate step: not cut at the goal\'s 10 minutes');
  t.notRegex(await run('lock'), /lead ran out of time/, 'inside LOCK: not cut');
  t.regex(await run('gate', { at: LEAD_TIMEOUT_MS + 60_000 }), /stopping lead: lead ran out of time/, 'the cap holds inside it');
  t.regex(await run('hall'), /stopping lead: lead ran out of time/, 'a section of the hall\'s is no lead');
  t.regex(await run('gate', { lapsed: true }), /stopping lead: lead ran out of time/, 'a section that has lapsed, its beat stale: cut at its own timeout');
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

test('the snapshot carries the effects on the bot and whether it burns; an older jar sends neither', async (t) => {
  const state = { pos: { x: 0, y: 64, z: 0 }, time: 1000 };
  const { rt } = fakeRuntime(state);
  const seen: Snapshot[] = [];
  const look: Goal = { name: 'look', priority: 10, wants: s => { seen.push(s); return null; }, run: async () => 'looked', timeoutMs: 1000, retryMs: 1000 };
  const effects = [{ name: 'fire_resistance', amplifier: 0, seconds: 160 }, { name: 'strength', amplifier: 1, seconds: -1 }];
  let extra: Record<string, unknown> = { onFire: true, effects };
  const brain = new Brain({ ...rt, status: async () => ({ ...(await rt.status()), ...extra }) }, { tickMs: 1e9, goals: [look] });
  brain.setEnabled(true);
  await brain.tick();
  t.deepEqual(seen.at(-1)?.effects, effects);
  t.true(seen.at(-1)?.onFire);
  // the old jar: no such fields
  extra = {};
  await brain.tick();
  t.deepEqual(seen.at(-1)?.effects, []);
  t.false(seen.at(-1)?.onFire);
  // a malformed list is not trusted item by item
  extra = { effects: [{ name: 'haste', amplifier: 1, seconds: 30 }, null, { amplifier: 0 }] };
  await brain.tick();
  t.deepEqual(seen.at(-1)?.effects, [{ name: 'haste', amplifier: 1, seconds: 30 }]);
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

test('S1 follow-up R6: a run that leads a villager (its trip live) is neither wedge-stopped nor stuck-stopped, said once; its beat lapsed, the watch steps it out as ever', async (t) => {
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
  const lead: Goal = { name: 'villager care', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [lead], now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  const w = brain.worldMemory()!;
  w.fetch = { v: 1, journal: [], wards: [], nextId: 4, trip: liveTrip(now, { state: 'gate' }) };
  const beat = () => { (w.fetch as FetchMemory).trip!.beat = now; };
  now += 5000; beat(); await brain.tick(); await settle();
  now += 20_000; beat(); await brain.tick(); await settle();
  now += 15_000; beat(); await brain.tick(); await settle();
  t.false(calls.includes('cancel'), 'no wedge stop mid-lead');
  t.is(steered.length, 0, 'no step-out beside a lead');
  now += 3.1 * 60_000; beat(); await brain.tick(); await settle();
  t.false(calls.includes('cancel'), 'no stuck stop mid-lead');
  t.notRegex(brain.status(), /looks stuck|stepping out/);
  t.is((brain.status().match(/leading a villager: not stopped \(the lead's own clock and guards end it\)/g) ?? []).length, 1, 'said once for the stand-still');
  // the trip's beat lapsed (nobody leads it any more): the watch is as it was
  now += 100_000; await brain.tick(); await settle();
  t.true(calls.includes('cancel'));
  t.regex(brain.status(), /villager care (is wedged in the oak_fence at 0,64,0: stepping out|looks stuck)/);
  brain.setEnabled(false);
});

test('S1 follow-up R6: with a villager out (a ward in the lock) the wedge step-out makes its steps and digs nothing: its own post stands, said; with none out it is dug as on Nov 13', async (t) => {
  const run = async (fetch?: FetchMemory) => {
    let now = 0;
    const state = { pos: { ...IN_CORNER }, time: 6000 };
    const { rt } = fakeRuntime(state);
    const status = rt.status;
    rt.status = async () => ({ ...(await status()), process: 'Custom Goal' });
    const call = rt.call;
    const steered: unknown[] = [];
    let dug = false;
    rt.call = (async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'world.region' && params.width === 3) return { blocks: dug ? corner3().map((b, i) => (i === 4 || i === 13 ? 'air' : b)) : corner3() };
      if (method === 'steer') {
        steered.push({ x: params.x, z: params.z });
        if (!dug) return { reached: false, distance: 1.49, at: { ...POST } };
        state.pos = { x: Number(params.x), y: 63, z: Number(params.z) };
        return { reached: true, distance: 0.1, at: { x: Math.floor(state.pos.x), y: 63, z: Math.floor(state.pos.z) } };
      }
      if (method === 'dig.here') { dug = true; return { dug: true, block: 'oak_fence', tool: 'diamond_axe' }; }
      return call(method, params);
    }) as ClientRuntime['call'];
    rt.builtNear = () => [{ at: { ...POST }, state: 'oak_fence' }, { at: { ...POST, y: 64 }, state: 'torch' }];
    const round: Goal = { name: 'pens', priority: 10, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
    const brain = new Brain(rt, { tickMs: 1e9, goals: [round], now: () => now });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    if (fetch) brain.worldMemory()!.fetch = fetch;
    now += 5000; await brain.tick(); await settle();
    now += 20_000; await brain.tick(); await settle();
    now += 15_000; await brain.tick(); await settle();
    const said = brain.status();
    brain.setEnabled(false);
    return { dug, steered, said };
  };
  const inLock = {
    key: 'ffeeb80c', uuid: 'ffeeb80c', from: { site: 'village -693,2262', at: { x: -675, y: 71, z: 2249 } }, since: 0, bell: true, where: 'lock' as const,
    last: { at: { x: -556.5, y: 63, z: 2135.5 }, t: 0, tod: 8600, health: 20, profession: 'none' }, health0: 20
  };
  const out = await run({ v: 1, journal: [], wards: [inLock], nextId: 2 });
  t.false(out.dug, 'nothing dug with a villager out');
  t.deepEqual(out.steered, [{ x: -556.5, z: 2170.5 }, { x: -558.5, z: 2171.5 }], 'the two steps made');
  t.regex(out.said, /stopping pens: pens is wedged in the oak_fence at -558,63,2171: stepping out/);
  t.regex(out.said, /wedged in the oak_fence at \(-558, 63, 2171\): could not step out; not dug: a villager is out/);
  // inert: no record, or one with nobody out, digs as before
  for (const fetch of [undefined, { v: 1 as const, journal: [], wards: [], nextId: 1 }]) {
    const as = await run(fetch);
    t.true(as.dug);
    t.regex(as.said, /dug it out, stepped out, put it back/);
  }
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
const inside = (brain: Brain) => brain as unknown as { chained?: unknown; again: boolean; ticking: boolean; running?: { done: Promise<void> } };

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
    await r.brain.tick(); await settle(r.brain);
    t.deepEqual(r.began, ['first']);
    r.at.clock += ms;
    r.end(); await settle(r.brain, () => r.began.length > 1); // no tick() from here
    t.deepEqual(r.began, ['first', 'second'], `${ms} ms`);
    t.regex(r.brain.status(), /- 00:16:42 done first in 2s: through\n- 00:16:42 start second: next\n/, `${ms} ms`);
    t.is(r.at.looks, 2, `${ms} ms`); // the first tick's and the one that followed the run; the second run was over at once: nothing follows it
    r.brain.setEnabled(false);
  }

  // a run that failed after 2.1 s of trying is followed the same way: it is held, the next goal is not kept waiting
  const failed = relay();
  await failed.brain.tick(); await settle(failed.brain);
  failed.at.clock += 2100;
  failed.end(new Error('no way through')); await settle(failed.brain, () => failed.began.length > 1);
  t.deepEqual(failed.began, ['first', 'second']);
  t.regex(failed.brain.status(), /- 00:16:42 failed first: no way through\n- 00:16:42 start second: next\n/);
  failed.brain.setEnabled(false);

  // over sooner (failed after 100 ms; done just short of 2 s; done at once): it did nothing or failed at once, and the
  // next look is the tick's, so nothing goes round faster than the tick does
  for (const [ms, err] of [[100, 'no way through'], [1999, ''], [0, '']] as const) {
    const r = relay();
    await r.brain.tick(); await settle(r.brain);
    r.at.clock += ms;
    r.end(err ? new Error(err) : undefined); await settle(r.brain, () => !inside(r.brain).running);
    t.deepEqual(r.began, ['first'], `${ms} ms`);
    t.is(r.at.looks, 1, `${ms} ms`);
    t.is(inside(r.brain).chained, undefined, `${ms} ms`);
    r.at.clock += 5000;
    await r.brain.tick(); await settle(r.brain); // the 5 s tick
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
  open(); await under; await settle(brain);
  t.is(looks, 2);            // the one that follows: one, not two
  t.deepEqual(began, ['a']); // and it found the run in hand: nothing started beside it
  t.false(inside(brain).again);

  // a run ends (3 s in) while the interval's tick is looking: the tick its end asks for lands on that one, which goes
  // on to start the next goal; the tick that follows finds it running
  clock += 3000;
  shut();
  const looking = brain.tick();
  // (not settled on the brain: its tick waits on the look the test holds; the turns until the tick the end asked for has
  // come and found it under way)
  ends.get('a')!(); await settle(); await turnsUntil(() => !inside(brain).chained && inside(brain).again);
  t.is(looks, 3);
  t.true(inside(brain).again); // asked for, not lost, and not a second tick beside the one under way
  t.deepEqual(began, ['a']);
  open(); await looking; await settle(brain, () => began.length > 1);
  t.is(looks, 4);
  t.deepEqual(began, ['a', 'b']);

  // a run stopped for something more urgent: the tick that follows starts that, and only that (the stopped goal
  // wants to go on, and is not started beside it)
  clock += 3000;
  alarm = true;
  await brain.tick(); await settle(brain, () => began.length > 2);
  t.is(looks, 6);
  t.deepEqual(began, ['a', 'b', 'urgent']);
  t.regex(brain.status(), /stopping b: urgent is more urgent \(alarm\)\n- 00:16:46 stopped b: aborted\n- 00:16:46 start urgent: alarm$/);
  t.is(live, 1);
  await settle(brain);
  t.is(looks, 6); // nothing goes on looking
  t.is(most, 1);  // never two runs at once

  brain.setEnabled(false); await settle(brain);
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
  clock += 5000; await brain.tick(); await settle(brain);
  t.regex(brain.status(), /- 00:16:45 start idle: nothing to do out here: back to the yard$/);
  t.is(swept, 0);
  // home after 9 s: the chore is in reach, and starts in that second with no tick of the test's
  clock += 9000; arrive(); await settle(brain, () => swept > 0);
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

test('F1: no run starts with a full bucket in hand: a run cut short left the lava bucket in it, the next goal\'s first walk is with a sword', async (t) => {
  const calls: string[] = [];
  let held = 'lava_bucket';
  const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  const call = rt.call;
  rt.call = (async (method: string, p: Record<string, unknown> = {}) => {
    if (method === 'inventory') return { items: [{ slot: 0, name: 'lava_bucket', count: 1 }, { slot: 1, name: 'diamond_sword', count: 1 }], held: { name: held, count: 1 } };
    if (method === 'item.select') { held = String(p.name); calls.push(`select ${held}`); return {}; }
    return call(method, p);
  }) as ClientRuntime['call'];
  const walk: Goal = {
    name: 'walk', priority: 50, timeoutMs: 1000, retryMs: 1000, wants: () => 'to the storage house',
    run: async () => { calls.push(`walk with ${held}`); return 'walked'; }
  };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [walk] });
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.deepEqual(calls, ['select diamond_sword', 'walk with diamond_sword']);
  // a harmless hand: nothing asked of the hand at all
  calls.length = 0;
  await brain.tick();
  await settle();
  t.deepEqual(calls, ['walk with diamond_sword']);
});

test('F1: nor with the empty bucket in hand: a pour that took left it there, the next goal\'s first walk is with a sword', async (t) => {
  const calls: string[] = [];
  let held = 'bucket';
  const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  const call = rt.call;
  rt.call = (async (method: string, p: Record<string, unknown> = {}) => {
    if (method === 'inventory') return { items: [{ slot: 0, name: 'bucket', count: 1 }, { slot: 1, name: 'diamond_sword', count: 1 }], held: { name: held, count: 1 } };
    if (method === 'item.select') { held = String(p.name); calls.push(`select ${held}`); return {}; }
    return call(method, p);
  }) as ClientRuntime['call'];
  const walk: Goal = {
    name: 'walk', priority: 50, timeoutMs: 1000, retryMs: 1000, wants: () => 'to the storage house',
    run: async () => { calls.push(`walk with ${held}`); return 'walked'; }
  };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [walk] });
  brain.setEnabled(true);
  await brain.tick();
  await settle();
  t.deepEqual(calls, ['select diamond_sword', 'walk with diamond_sword']);
  brain.setEnabled(false);
});

// ------------------------------------------------------------------------------------------------ the villager fetch's wiring (idle-plan V, S0)

/** The brain's own tools on a stub server (brain-tools.ts): a tool by name, its text. */
function brainTools(brain: Brain, rt: ClientRuntime) {
  const server = { tool: sinon.stub() } as unknown as McpServer;
  registerBrainTools(new ToolFactory(server, { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) }), brain, rt);
  const calls = (server.tool as sinon.SinonStub).getCalls();
  return async (name: string, args: Record<string, unknown> = {}) => ((await calls.find(c => c.args[0] === name)!.args[3](args)).content as { text: string }[]).map(c => c.text).join('\n');
}
const leadTrip = (beat: number): Trip => ({
  id: 7, kind: 'bring', site: 'v:-675,2249', state: 'hop', beat, prep: {}, gate: { at: { x: -565, y: 63, z: 2183 }, side: 'west', inner: { x: -563, y: 63, z: 2183 }, outer: { x: -567, y: 63, z: 2183 }, yard: 31 },
  spare: [], lure: 'fletching_table', hop: { n: 5, replaced: 0 }, avoid: [], times: {}, counts: { hops: 4, misses: 0, wedges: 0, pins: 0 }
});
/** A goal whose run holds on until it is stopped, and then (its exit handler, outside the run; `exitMs` long) shuts a held gate. */
const holding = (name: string, priority: number, wants: () => boolean, section?: { now: () => number }, exitMs = 0): Goal => ({
  name, priority, wants: () => (wants() ? `${name} wants` : null), timeoutMs: 60 * 60_000, retryMs: 1000, cuts: () => false,
  run: async ctx => {
    if (section) afield.critical = { by: ctx.signal, until: section.now() + 6 * 60_000, why: 'hall' };
    try { return (await ctx.act('slow')).text; } finally {
      await brainRun.exit(async () => {
        if (exitMs) await new Promise(r => setTimeout(r, exitMs));
        return ctx.call('gates.release', { x: -556, y: 63, z: 2137, shut: true });
      }).catch(() => undefined);
    }
  }
});

test('wired: out of the hall is a survival goal right after retreat; care after food, never held by the loop watch; the shells before the hall chores; flight alone cuts a critical section', (t) => {
  const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  const names = (new Brain(rt, { tickMs: 1e9 }) as unknown as { goals: Goal[] }).goals.map(g => g.name);
  t.is(names[names.indexOf('retreat') + 1], 'out of the hall');
  t.true(SURVIVAL.has('out of the hall'));
  t.is(names[names.indexOf('food') + 1], 'villager care');
  t.true(names.indexOf('hall shells') >= 0 && names.indexOf('hall shells') < names.indexOf('hall chores'));
  t.deepEqual([...NO_LOOP_HOLD], ['villager care']);
  t.deepEqual([...CRITICAL_CUTS].sort(), ['break out', 'out from under', 'out of a pit', 'recover', 'retreat']);
  t.like(villagerCareGoal, { priority: 62, retryMs: 5000, failHoldMs: 60_000, timeoutMs: 10 * 60_000 });
});

test.serial('D35, E16: a run in a critical section (a chores visit inside the hall) is cut by flight alone: not the stash, the farm, the shelter or food; retreat cuts it, and its exit handler shuts the gate', async (t) => {
  t.teardown(() => { delete afield.critical; });
  let now = 1_000_000;
  const { rt, calls } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  let wanted = new Set(['hall chores']);
  const want = (name: string, priority: number): Goal => ({ name, priority, wants: () => (wanted.has(name) ? `${name} wants` : null), run: async () => `${name} ran`, timeoutMs: 60_000, retryMs: 1000 });
  const goals = [want('retreat', 85), want('shelter', 80), want('food', 76), want('stash', 60), want('farm', 47), holding('hall chores', 30, () => wanted.has('hall chores'), { now: () => now })];
  const brain = new Brain(rt, { tickMs: 1e9, goals, now: () => now });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  t.regex(brain.status(), /Now: hall chores/);
  for (const g of ['stash', 'farm', 'shelter', 'food']) {
    wanted = new Set(['hall chores', g]);
    now += 1000;
    await brain.tick(); await settle();
    t.regex(brain.status(), /Now: hall chores/, g);
    t.false(calls.includes('cancel'), g);
  }
  wanted = new Set(['hall chores', 'retreat']);
  now += 1000;
  await brain.tick(); await settle();
  t.regex(brain.status(), /stopping hall chores: retreat is more urgent/);
  t.true(calls.includes('gates.release'), 'the exit handler shut the gate it held');
  t.is(afield.critical, undefined, 'the section ended with its run');
  brain.setEnabled(false);
  // (the same run with no section of its own: the stash cuts it as ever)
  const b = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  wanted = new Set(['hall chores']);
  const plain = new Brain(b.rt, { tickMs: 1e9, goals: [want('stash', 60), holding('hall chores', 30, () => wanted.has('hall chores'))], now: () => now });
  plain.setEnabled(true);
  await plain.tick(); await settle();
  wanted = new Set(['hall chores', 'stash']);
  await plain.tick(); await settle();
  t.regex(plain.status(), /stopping hall chores: stash is more urgent/);
  plain.setEnabled(false);
});

test.serial('D24: an acting tool is refused while a villager is led or a run is in a critical section (said why); set-autonomy off takes the bot over, the run\'s exit handler first', async (t) => {
  t.teardown(() => { delete afield.critical; });
  let now = 1_000_000;
  const { rt, calls } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  // (an exit handler that takes its time: 60 ms)
  const brain = new Brain(rt, { tickMs: 1e9, goals: [holding('work: villagers', 20, () => true, undefined, 60)], now: () => now });
  const tool = brainTools(brain, rt);
  brain.setEnabled(true);
  await brain.tick(); await settle();
  const world = brain.worldMemory()!;
  world.fetch = { v: 1, journal: [], wards: [], nextId: 8, trip: leadTrip(now) };
  await t.throwsAsync(brain.manual('dig-block'), { message: /^Not now \(dig-block\): a villager is being led \(trip 7, hop 5\), and only flight cuts that short\. set-autonomy \{enabled:false\} takes the bot over \(the run's exit handler runs first\)/ });
  t.false(calls.includes('cancel'));
  t.notRegex(brain.status(), /Paused for the LLM/);
  // a trip nobody drives (its beat 90 s old): the tool takes over as ever
  delete world.fetch.trip;
  const section = new AbortController();
  afield.critical = { by: section.signal, until: now + 60_000, why: 'hall' };
  await t.throwsAsync(brain.manual('place-block'), { message: /^Not now \(place-block\): the bot is inside the villager hall/ });
  // set-autonomy off: the run is stopped and its handler runs (the held gate released shut) before the tool answers
  await tool('set-autonomy', { enabled: false });
  t.false(brain.enabled);
  t.true(calls.includes('gates.release'), 'the exit handler ran before the reply');
  delete afield.critical;
  world.fetch.trip = leadTrip(now - 91_000);
  await t.notThrowsAsync(brain.manual('dig-block'));
});

test.serial('E40: care is never silenced: a row that cannot do its work is a text, not a failure (no hold); three throws hold it a minute, not the night; the loop watch never holds it; a timeout holds it 5 s', async (t) => {
  let now = 1_000_000;
  // (1) the gate will not shut: said, and no hold of the brain's
  {
    const { rt, calls } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
    const call = rt.call;
    rt.call = (async (m: string, p?: Record<string, unknown>) => (m === 'world.region' && p?.width === 1 ? { blocks: ['oak_fence_gate[facing=south,open=true]'] } : call(m, p))) as ClientRuntime['call'];
    const brain = new Brain(rt, { tickMs: 1e9, goals: [villagerCareGoal], now: () => now });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    const g = { x: 2, y: 64, z: 0 };
    fetchOf(brain.worldMemory()!).gates = { at: now, open: [g], leftOpen: [g] };
    now += 6000;
    fetchOf(brain.worldMemory()!).gates!.at = now;
    await brain.tick(); await settle();
    t.regex(brain.status(), /done villager care in 0s: a gate at \(2, 64, 0\) does not read shut/);
    t.notRegex(brain.status(), /Retrying later: .*villager care|failed villager care/);
    t.true(calls.filter(c => c === 'useOn').length >= 1, 'the bridge\'s own click, read back');
    brain.setEnabled(false);
  }
  // (2) three throws in a row: a minute off, not the night
  {
    const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
    let runs = 0;
    const care: Goal = { ...villagerCareGoal, gate: undefined, declines: undefined, urgency: undefined, wants: () => 'a gate left open', run: async () => { runs++; throw new Error('no answer'); } };
    const brain = new Brain(rt, { tickMs: 1e9, goals: [care], now: () => now });
    brain.setEnabled(true);
    for (let i = 0; i < 3; i++) { await brain.tick(); await settle(); now += 6000; }
    t.is(runs, 3);
    t.regex(brain.status(), /villager care failed 3 times in a row: left for 1 min/);
    now += 30_000;
    await brain.tick(); await settle();
    t.is(runs, 3);
    now += 31_000;
    await brain.tick(); await settle();
    t.is(runs, 4, 'back a minute on');
    brain.setEnabled(false);
  }
  // (3) round and round with nothing to show: the loop is seen, nothing is backed off
  {
    const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 6000 });
    let runs = 0, end = () => { /* nothing runs yet */ };
    const care: Goal = { ...villagerCareGoal, gate: undefined, declines: undefined, urgency: undefined, wants: () => 'a gate left open', run: () => new Promise<string>(res => { runs++; end = () => res('the gate does not read shut'); }) };
    const brain = new Brain(rt, { tickMs: 1e9, goals: [care], now: () => now });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    for (let i = 0; i < 6; i++) { now += 2000; end(); await settle(); }
    t.true(runs >= 6, `${runs} runs`);
    t.regex(brain.status(), /LOOP \(spinning\)/);
    t.notRegex(brain.status(), /backed off/);
    brain.setEnabled(false);
  }
  // (4) a run that hangs: stopped at its 10 minutes, and back 5 s on
  {
    const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
    let runs = 0;
    const care: Goal = { ...villagerCareGoal, gate: undefined, declines: undefined, urgency: undefined, wants: () => 'a gate left open', run: async ctx => { runs++; return (await ctx.act('slow')).text; } };
    const brain = new Brain(rt, { tickMs: 1e9, goals: [care], now: () => now });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    now += 10 * 60_000 + 1000;
    await brain.tick(); await settle();
    t.regex(brain.status(), /villager care ran out of time/);
    now += 6000;
    await brain.tick(); await settle();
    t.is(runs, 2);
    brain.setEnabled(false);
  }
});

/** A brain over the pasture (its memory the pasture's world, as brain.json; its runtime the pasture's bridge and tools). */
function brainOn(t: ExecutionContext, p: Pasture, goals: Goal[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-brain-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryFile = path.join(dir, 'brain.json'), logFile = path.join(dir, 'brain.log');
  fs.writeFileSync(memoryFile, JSON.stringify({ 'seed:1': p.world }));
  const answer = (r: { ok: boolean; text: string }) => reply(r.text, !r.ok);
  const rt = {
    actions: new Proxy({}, { get: (_, tool: string) => async (a: Record<string, unknown>) => answer(await p.ctx.act(tool, a)) }),
    call: (async (m: string, q?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      return p.ctx.call(m, q);
    }) as ClientRuntime['call'],
    status: async () => ({ ...(await p.ctx.status()), hashedSeed: '1' }),
    home: () => ({ ...YARD_HOME, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined,
    own: { put: (...a: Parameters<NonNullable<GoalContext['own']>['put']>) => p.ctx.own!.put(...a), take: (...a: Parameters<NonNullable<GoalContext['own']>['take']>) => p.ctx.own!.take(...a) }
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => p.now(), goals, memoryFile, logFile });
  return { brain, rt, said: () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => l.slice(25)) };
}

test.serial('E4: the strict set at the start (the closer on, then the set whole with the lock\'s pair and guard), sent again to a relaunched client; a gate opened across the relaunch is reported; the watch on the brain\'s clock', async (t) => {
  const p = yard({ at: { x: -550, y: 63, z: 2145 } });
  const { brain, said } = brainOn(t, p, []);
  brain.setEnabled(true);
  await brain.tick();
  const world = brain.worldMemory()!;
  const sent = p.log.filter(e => /^gates\./.test(e.name)).map(e => e.name);
  t.deepEqual(sent.slice(0, 3), ['gates.status', 'gates.auto', 'gates.strict']);
  t.like(p.log.find(e => e.name === 'gates.auto')!.params, { enabled: true });
  t.deepEqual(p.log.find(e => e.name === 'gates.strict')!.params, JSON.parse(JSON.stringify(strictSet(world))));
  t.is(p.holds.strictGates().length, strictGates(world).length);
  t.is(p.holds.pairs(), 1);
  t.is(p.holds.guards().length, 1);
  t.true(said().some(l => /^gates: the strict set sent \(at the start\): 7 strict gate\(s\), 1 pair\(s\), 1 guard\(s\)$/.test(l)), said().join('\n'));
  // the next tick: the count is the brain's, nothing sent; the gates read into fetch.gates on the brain's clock
  const n = p.log.length;
  await brain.tick();
  t.false(p.log.slice(n).some(e => e.name === 'gates.strict'));
  t.like(peekFetch(world).gates, { at: T0 + p.log.slice(n).find(e => e.name === 'gates.status')!.t * 50, open: [], leftOpen: [] });
  t.true(p.log.slice(n).some(e => e.name === 'world.entities' && e.params.maxDistance === 128 && e.params.type === undefined), 'a look into the lock');
  // the client relaunched (the brain lives on): its sets are gone, a gate is opened while it is down
  p.kill(true);
  p.swing(YARD_GATES.west, true, 'a player');
  p.restart();
  p.advance(120);
  const m = p.log.length;
  await brain.tick();
  t.deepEqual(p.log.slice(m).filter(e => /^gates\./.test(e.name)).map(e => e.name), ['gates.status', 'gates.auto', 'gates.strict']);
  t.is(p.holds.strictGates().length, strictGates(world).length);
  t.true(said().some(l => /^gates: the strict set sent \(the bridge counted 0, the brain 7: a relaunched client\)/.test(l)));
  // reported by its block state though the closer never took it as the bot's; out of reach: left open
  await brain.tick();
  t.deepEqual(peekFetch(world).gates!.leftOpen, [YARD_GATES.west]);
  t.true(isOpen(p.get(YARD_GATES.west)), 'the bridge only reports it: care shuts it');
  brain.setEnabled(false);
});

test.serial('S1 follow-up R7: the strict gates fewer than the set last sent while a villager trip exists (PREP\'s read on) halt the fetch, said; with no trip and nobody out the fall is only sent on', async (t) => {
  const grow = (world: WorldMemory) => {
    // (the growth's last run: the box 16 farther north, the fence to move out; the north gate is off the box's line)
    const y = world.yard!;
    world.fenceMove = { side: 'north', old: { ...y } };
    world.yard = { ...y, z1: y.z1 - 16 };
  };
  for (const trip of [true, false]) {
    const p = yard({ at: { x: -550, y: 63, z: 2145 } });
    const { brain, said } = brainOn(t, p, []);
    brain.setEnabled(true);
    await brain.tick();
    const world = brain.worldMemory()!;
    t.is(strictGates(world).length, 7);
    world.fetch = { v: 1, method: 'lure', armed: 1, journal: [], wards: [], nextId: 2, ...(trip ? { trip: liveTrip(p.now() - 60 * 60_000, { id: 1, state: 'prep', prep: { read: p.now() - 60_000, kit: p.now() - 60_000 } }) } : {}) };
    grow(world);
    t.is(strictGates(world).length, 6);
    p.advance(20);
    await brain.tick();
    const halt = peekFetch(world).halt;
    if (trip) {
      t.regex(halt?.why ?? '', /^the strict gates fell from 7 to 6 while a villager trip is prep \(trip 1\): the yard's fence or a gate changed under it$/);
      t.true(said().some(l => /^villagers: HALT: the strict gates fell from 7 to 6/.test(l)), said().join('\n'));
    } else {
      t.is(halt, undefined, 'no trip, nobody out: nothing of the fetch\'s');
      t.false(said().some(l => /HALT/.test(l)));
    }
    brain.setEnabled(false);
  }
});

test.serial('E4 end to end: the gate watch finds a gate left open, care cuts the chore that runs and shuts it; a jar with no gate holds sends nothing and the shells build nothing', async (t) => {
  const p = yard({ at: { x: -550, y: 63, z: 2145 } });
  let chores = true;
  const chore: Goal = { name: 'tidy', priority: 34, wants: () => (chores ? 'a stray' : null), timeoutMs: 60 * 60_000, retryMs: 1000,
    run: ctx => new Promise<string>((_, no) => ctx.signal.addEventListener('abort', () => no(new Error('aborted')))) };
  const { brain, said } = brainOn(t, p, [villagerCareGoal, chore]);
  brain.setEnabled(true);
  await brain.tick(); await settle();
  t.regex(brain.status(), /Now: tidy/);
  p.swing(YARD_GATES.west, true, 'a player');
  p.advance(10);
  chores = false;
  await brain.tick(); await settle();
  t.true(said().some(l => /^stopping tidy: villager care is more urgent \(a gate left open at \(-565, 63, 2183\): shut it\)$/.test(l)), said().join('\n'));
  await brain.tick();
  for (let i = 0; i < 5; i++) await settle();
  t.true(said().some(l => /^done villager care in \d+s: shut the yard's west gate at \(-565, 63, 2183\)$/.test(l)), said().join('\n'));
  t.false(isOpen(p.get(YARD_GATES.west)));
  brain.setEnabled(false);
  // the jar before the gate holds: gates.status unknown, nothing sent, nothing written, and the shells decline
  const old = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  const call = old.rt.call;
  const asked: string[] = [];
  old.rt.call = (async (m: string, q?: Record<string, unknown>) => { if (/^gates\./.test(m)) { asked.push(m); throw new Error(`unknown method: ${m}`); } return call(m, q); }) as ClientRuntime['call'];
  let clock = T0;
  const b = new Brain(old.rt, { tickMs: 1e9, now: () => clock, goals: [] });
  const shells = (new Brain(old.rt, { tickMs: 1e9 }) as unknown as { goals: Goal[] }).goals.find(g => g.name === 'hall shells')!;
  b.setEnabled(true);
  await b.tick();
  const w = b.worldMemory()!;
  w.zones = { ...p.world.zones };
  w.yard = { ...p.world.yard! };
  // (a hall with a villager in it: the watch would read the gates every tick, but this bridge never answered)
  w.villages = { sites: [], players: [], hall: { count: 1, at: clock } } as unknown as WorldMemory['villages'];
  for (let i = 0; i < 6; i++) { clock += 5000; await b.tick(); }
  t.deepEqual(asked, ['gates.status'], 'asked once in the minute (first at the second tick: the yard came with it), and nothing sent');
  clock += 36_000;
  await b.tick();
  t.deepEqual(asked, ['gates.status', 'gates.status']);
  b.setEnabled(false);
  t.regex(shells.declines!(snap({ position: { x: -550, y: 63, z: 2145 }, home: { ...YARD_HOME, dimension: 'overworld' }, distHome: 38 }), w)!.text, /^the bridge keeps no strict gates/);
  t.is(w.fetch, undefined, 'no record made for a world on the old jar');
});

test.serial('the look round home (discover) notes who is at work in the hall by the time of day (whose job block is whose), lowers no count on a blind look, and notes the lock', async (t) => {
  const p = yard({ at: { x: -550, y: 63, z: 2145 }, tod: 3000 });
  const table = p.world.zones!['hall:fletching']![0];
  p.villager({ at: { x: table.x, y: table.y, z: table.z + 1 }, id: 9301, profession: 'fletcher', mind: 'still' });
  const { brain } = brainOn(t, p, []);
  brain.setEnabled(true);
  await brain.tick();
  const world = brain.worldMemory()!;
  t.is(world.hallChores?.census?.villagers.length, 1);
  t.deepEqual(Object.keys(world.hallChores?.work ?? {}), ['00000000-0000-4000-8000-000000002455']);
  t.like(lockSeen(world), { villagers: 0 });
  // ten minutes on, just rejoined: every cell reads null and the look sees nobody; the census is kept
  p.advance(10 * 60 * 20 + 20);
  p.blind(400);
  await brain.tick();
  t.is(world.hallChores?.census?.villagers.length, 1, 'a blind look lowers no count');
  brain.setEnabled(false);
});

test.serial('B1: a chores visit with no lock (the hall\'s own gate) is one critical section: `out of the hall` does not cut it with the bot inside; the visit is done and the gate shut behind', async (t) => {
  t.teardown(() => { delete afield.critical; });
  const p = yard({ at: { x: -550, y: 63, z: 2145 }, lock: false, tod: 2000 });
  const table = p.world.zones!['hall:fletching']![0];
  p.villager({ at: { x: table.x, y: table.y, z: table.z + 1 }, id: 9302, profession: 'fletcher', mind: 'still' });
  p.give('stick', 64);
  p.give('emerald', 62);
  const offer = { index: 0, costA: { name: 'stick', count: 32 }, costB: null, result: { name: 'emerald', count: 1 }, uses: 0, maxUses: 16, outOfStock: false };
  // the trade screen held open until the test has ticked the brain with the bot inside
  let reached = () => { /* set below */ };
  const inside = new Promise<void>(r => { reached = r; });
  let go = () => { /* set below */ };
  const held = new Promise<void>(r => { go = r; });
  p.on.call['trade.open'] = async q => { reached(); await held; return { open: true, level: 1, xp: 0, id: q.id, profession: 'fletcher', offers: [{ ...offer }] }; };
  p.on.call['trade.do'] = q => {
    const times = Number(q.times ?? 1);
    p.take('stick', 32 * times);
    p.give('emerald', times);
    return { ok: true, traded: times, count: times, spent: { stick: 32 * times }, stopped: 'done', open: true, offer: { ...offer, uses: times }, level: 1, xp: times };
  };
  p.on.call['trade.close'] = () => ({ ok: true });
  const { brain, said } = brainOn(t, p, [outOfHallGoal, hallChoresGoal]);
  brain.setEnabled(true);
  await brain.tick(); await settle();
  // (the first tick looked into the hall: the census; the next starts the visit)
  if (!/Now: hall chores/.test(brain.status())) { await brain.tick(); await settle(); }
  t.regex(brain.status(), /Now: hall chores/);
  await inside;
  const world = brain.worldMemory()!;
  t.true(inHallBox(world, p.bot.at), `the bot in the hall at ${JSON.stringify(p.bot.at)}`);
  t.like(afield.critical, { why: 'hall' });
  t.is(outOfHallWants(p.look(), world), null, 'a visit under way is left be');
  await brain.tick(); await settle();
  t.regex(brain.status(), /Now: hall chores/);
  t.false(said().some(l => /^stopping hall chores/.test(l)), said().join('\n'));
  go();
  for (let i = 0; i < 10 && /Now: hall chores/.test(brain.status()); i++) await settle();
  t.true(said().some(l => /^done hall chores in \d+s: fletcher: sold 64 sticks for 2 emeralds \(64 now\)/.test(l)), said().join('\n'));
  t.false(inHallBox(world, p.bot.at), 'out of the hall');
  t.false(isOpen(p.get(H)), 'its gate shut behind');
  t.is(afield.critical, undefined, 'the section ended with the visit');
  t.is(outOfHallWants(p.look(), world), null);
  brain.setEnabled(false);
});

test('the debug dumps: a trip\'s (fetch-*) in a folder of their own, 20 kept; the rails\' as before (five and the new one)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dumps-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const { rt } = fakeRuntime({ pos: { x: 0, y: 64, z: 0 }, time: 1000 });
  const dumper: Goal = { name: 'dumper', priority: 10, wants: () => 'dump', timeoutMs: 60_000, retryMs: 0, run: async ctx => { for (let i = 0; i < 25; i++) { now += 1000; ctx.dump!(`fetch-hop${i}`, { i }); ctx.dump!(`extension${i}`, { i }); } return 'dumped'; } };
  const brain = new Brain(rt, { tickMs: 1e9, goals: [dumper], now: () => now, logFile: path.join(dir, 'brain.log') });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  brain.setEnabled(false);
  t.is(fs.readdirSync(path.join(dir, 'fetch-debug')).length, 20);
  t.is(fs.readdirSync(path.join(dir, 'rails-debug')).length, 6);
  t.true(fs.readdirSync(path.join(dir, 'fetch-debug')).every(f => /-fetch-hop\d+\.json$/.test(f)));
});
