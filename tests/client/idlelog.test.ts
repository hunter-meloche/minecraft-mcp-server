import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { Brain } from '../../src/client/brain/brain.js';
import { BrainMemory, type WorldMemory } from '../../src/client/brain/memory.js';
import { brainRun, type ClientRuntime } from '../../src/client/tools.js';
import { fromGate, returnIdle, type Decline, type Goal, type Snapshot } from '../../src/client/brain/goals.js';
import { explainIdle, idleOf, tally, tallyRoll, type IdleCause } from '../../src/client/brain/idlelog.js';
import type { Run } from '../../src/client/brain/loops.js';

const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const settle = () => new Promise(r => setTimeout(r, 20));

/** 14:00:00 UTC: the log's lines and the "held until" times below read from here. */
const T0 = Date.UTC(2026, 10, 10, 14, 0, 0);
const HOME = { x: 0, y: 64, z: 0 };

interface State {
  pos: { x: number; y: number; z: number }; time: number;
  sleeping?: boolean; thundering?: boolean; inWorld?: boolean; homeless?: boolean; process?: string;
}

/** A bot in the world `seed:1` with a home at (0, 64, 0). The `slow` tool returns when the test says `finish` (or the brain cancels it). */
function fakeRuntime(state: State) {
  const calls: string[] = [];
  const region = new Array(25 * 11 * 25).fill('air');
  let release: (() => void) | undefined;
  const rt: ClientRuntime = {
    actions: {
      'go-home': async () => { state.pos = { ...HOME }; return reply('Home'); },
      'slow': async () => { await new Promise<void>(r => { release = r; }); await rt.call('status'); return reply('slow done'); }
    },
    call: (async (method: string) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      calls.push(method);
      if (method === 'inventory') return { items: [] };
      if (method === 'world.region') return { blocks: region };
      if (method === 'cancel') { release?.(); return {}; }
      return {};
    }) as ClientRuntime['call'],
    status: async () => ({ inWorld: state.inWorld ?? true, username: 'Bot', screen: null, position: state.pos, block: state.pos, timeOfDay: state.time, hashedSeed: '1',
      dimension: 'overworld', sleeping: !!state.sleeping, thundering: !!state.thundering, process: state.process ?? null, health: 20, food: 20 }),
    home: () => (state.homeless ? undefined : { ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined,
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  };
  return { rt, calls, finish: () => release?.() };
}

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: T0, timeOfDay: 6000, activity: 'work', health: 20, food: 20, position: { ...HOME }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 0,
  home: { ...HOME, dimension: 'overworld' }, distHome: 0, ...over
});
const emptyWorld = (): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96 });

/** A goal that never wants to run, and says why (or doesn't). */
const idler = (name: string, declines?: () => Decline | null): Goal => ({
  name, priority: 5, wants: () => null, ...(declines ? { declines } : {}), run: async () => name, timeoutMs: 60_000, retryMs: 1000
});

/** Today's tally as the brain keeps it. */
const today = (brain: Brain) => idleOf(brain.worldMemory()!).today;
/** The log lines brain-status shows (its last 20), as they were written. */
const recent = (brain: Brain) => { const l = brain.status().split('\n'); return l.slice(l.indexOf('Recent:') + 1).map(x => x.slice(2)); };
/** The line of brain-status that starts so. */
const statusLine = (brain: Brain, start: string) => brain.status().split('\n').find(l => l.startsWith(start));
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idlelog-')), 'brain.json');

// ---- the pure half ----

test('explainIdle: away and health lead, then each held goal with why and until when, then what the goals say; nobody saying anything is "nothing"', (t) => {
  const world = emptyWorld();
  const goals = [
    idler('a', () => ({ cause: 'stocked', text: 'enough iron' })),
    idler('b', () => { throw new Error('boom'); }), // cannot say why: left out, the others still explain
    idler('c', () => ({ cause: 'kit', text: 'no pickaxe' })),
    idler('d'),
    idler('e', () => null),
    idler('f', () => ({ cause: 'weather' as IdleCause, text: 'not a cause' }))
  ];
  const held = new Map([['c', T0 + 90_000], ['a', T0 - 1], ['gone', T0 + 5000], ['d', T0 + 1000]]);
  t.deepEqual(explainIdle(snap({ health: 8, distHome: 120.4 }), world, goals, held, new Map([['c', 'stuck'], ['a', 'timed out']])), [
    { cause: 'away', text: '120 blocks from home, leash 96' },
    { cause: 'health', text: 'health 8, food 20' },
    { cause: 'hold', text: 'c held until 14:01 (stuck)', until: T0 + 90_000 },
    { cause: 'hold', text: 'd held until 14:00', until: T0 + 1000 }, // a hold nobody gave a reason for still shows
    { cause: 'kit', text: 'no pickaxe' },
    { cause: 'stocked', text: 'enough iron' }
  ]); // a hold that ran out (a), and one on a goal the brain does not choose from (gone), keep nothing from running
  t.deepEqual(explainIdle(snap({ home: undefined, distHome: Infinity }), world, [], new Map(), new Map()), [{ cause: 'away', text: 'no home set' }]);
  t.deepEqual(explainIdle(snap({ distHome: Infinity }), world, [], new Map(), new Map()), [{ cause: 'away', text: 'in another dimension' }]);
  t.deepEqual(explainIdle(snap({ food: 6 }), world, [], new Map(), new Map()), [{ cause: 'health', text: 'health 20, food 6' }]);
  // the gap to close: no goal wants to run and none explains itself
  t.deepEqual(explainIdle(snap(), world, [idler('d'), idler('e', () => null)], new Map(), new Map()), [{ cause: 'nothing', text: 'no goal wants to run, and none says why' }]);
});

test('fromGate: one gate answers both, so a goal wants to run or says why not, never both and never neither', (t) => {
  const g = fromGate(s => (s.slotsUsed >= 36 ? { cause: 'pockets', text: '36/36, nothing to put away' } : { want: 'room for a load' }));
  const world = emptyWorld();
  t.is(g.wants(snap(), world), 'room for a load');
  t.is(g.declines!(snap(), world), null);
  t.is(g.wants(snap({ slotsUsed: 36 }), world), null);
  t.deepEqual(g.declines!(snap({ slotsUsed: 36 }), world), { cause: 'pockets', text: '36/36, nothing to put away' });
});

test('tally: idle time goes under its cause, empty and busy only add to the day; what is no time is not counted', (t) => {
  const world = emptyWorld();
  tally(world, 'idle', 4000, 'late');
  tally(world, 'idle', 1500, 'late');
  tally(world, 'idle', 2000); // no cause given: nobody said why
  tally(world, 'empty', 3000);
  tally(world, 'busy', 10_000);
  for (const bad of [0, -5000, NaN, Infinity]) tally(world, 'idle', bad, 'dry');
  t.deepEqual(world.idle, { today: { day: 0, workMs: 20_500, idleMs: 7500, emptyMs: 3000, by: { late: 5500, nothing: 2000 } }, days: [] });
});

test('the day rollover: the day line, the week kept (at most 7 days, the newest first), and a day with nothing counted not kept', (t) => {
  const world = emptyWorld();
  t.is(tallyRoll(world), ''); // the LLM had the bot all day, or it was off: no line, and no day that would read 0% idle
  t.deepEqual(idleOf(world), { today: { day: 0, workMs: 0, idleMs: 0, emptyMs: 0, by: {} }, days: [] });
  tally(world, 'idle', 30_000, 'late');
  tally(world, 'idle', 12_000, 'dry');
  tally(world, 'idle', 4000, 'pockets');
  tally(world, 'idle', 300, 'kit'); // under half a second: not worth a word
  tally(world, 'empty', 23_000);
  tally(world, 'busy', 505_700);
  t.is(tallyRoll(world), 'day: idle 8% (46s), empty 4% (23s) of 575s: late 30s, dry 12s, pockets 4s');
  t.deepEqual(idleOf(world).today, { day: 1, workMs: 0, idleMs: 0, emptyMs: 0, by: {} });
  tally(world, 'busy', 60_000);
  t.is(tallyRoll(world), 'day: idle 0% (0s), empty 0% (0s) of 60s');
  for (let i = 0; i < 9; i++) { tally(world, 'idle', 1000 * (i + 1), 'late'); tallyRoll(world); }
  const m = idleOf(world);
  t.is(m.today.day, 11);
  t.deepEqual(m.days.map(d => d.day), [10, 9, 8, 7, 6, 5, 4]);
  t.deepEqual(m.days[0], { day: 10, workMs: 9000, idleMs: 9000, emptyMs: 0, by: { late: 9000 } });
});

test('idleOf: a brain.json from before the tally, or with something else under idle, is put right and counted on from', (t) => {
  const file = tempFile();
  const base = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  const day = (n: number) => ({ day: n, workMs: 1000, idleMs: 0, emptyMs: 0, by: {} });
  fs.writeFileSync(file, JSON.stringify({
    none: base,
    junk: { ...base, idle: 'yesterday' },
    list: { ...base, idle: [1, 2] },
    half: {
      ...base,
      idle: {
        today: { day: 3.7, workMs: 9000, idleMs: '4000', emptyMs: -5, by: { late: 3000, weather: 5, dry: -1, kit: null } },
        days: [null, 7, { day: 2, workMs: 2000, by: 'x' }, ...Array.from({ length: 9 }, (_, i) => day(i))]
      }
    },
    odd: { ...base, idle: { today: 5, days: 'none' } }
  }));
  const mem = new BrainMemory(file);
  const zero = { day: 0, workMs: 0, idleMs: 0, emptyMs: 0, by: {} };
  for (const id of ['none', 'junk', 'list', 'odd']) t.deepEqual(idleOf(mem.world(id)), { today: zero, days: [] }, id);
  const half = idleOf(mem.world('half'));
  t.deepEqual(half.today, { day: 3, workMs: 9000, idleMs: 0, emptyMs: 0, by: { late: 3000 } });
  t.deepEqual(half.days.map(d => d.day), [2, 0, 1, 2, 3, 4, 5]);
  t.deepEqual(half.days[0], { day: 2, workMs: 2000, idleMs: 0, emptyMs: 0, by: {} });
  // and the counting goes on in it, and is what gets saved
  tally(mem.world('junk'), 'idle', 5000, 'late');
  mem.save();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>;
  t.deepEqual(saved.junk.idle, { today: { day: 0, workMs: 5000, idleMs: 5000, emptyMs: 0, by: { late: 5000 } }, days: [] });
});

test('brain.json is saved beside itself and renamed over: a save that dies leaves the old file whole', (t) => {
  const file = tempFile();
  const mem = new BrainMemory(file);
  mem.world('w').leash = 50;
  mem.save();
  t.is((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>).w.leash, 50);
  t.deepEqual(fs.readdirSync(path.dirname(file)), ['brain.json']); // nothing left lying beside it
  // the write cannot be made (a folder sits where the temp file goes): were brain.json written in place, it would
  // hold the new data, or half of it
  fs.mkdirSync(`${file}.tmp`);
  mem.world('w').leash = 60;
  t.throws(() => mem.save());
  t.is((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>).w.leash, 50);
  fs.rmdirSync(`${file}.tmp`);
  mem.save();
  t.is((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>).w.leash, 60);
  t.deepEqual(fs.readdirSync(path.dirname(file)), ['brain.json']);
  // and what was saved is read back
  t.is(new BrainMemory(file).world('w').leash, 60);
});

test('brain.json: the new file is flushed to the disk before it is renamed over the old one', (t) => {
  const file = tempFile();
  const mem = new BrainMemory(file);
  mem.world('w').leash = 50;
  // a power cut cannot be staged here. What can be seen is that the save asks for the flush, and before the rename:
  // without it the filesystem may journal the rename first, and a cut then leaves an empty brain.json (a first run)
  const write = sinon.spy(fs, 'writeFileSync'), rename = sinon.spy(fs, 'renameSync');
  try { mem.save(); } finally { write.restore(); rename.restore(); }
  t.deepEqual(write.args.map(a => [a[0], a[2]]), [[`${file}.tmp`, { flush: true }]]);
  t.deepEqual(rename.args, [[`${file}.tmp`, file]]);
  t.true(write.calledBefore(rename));
  t.is((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>).w.leash, 50);
});

// ---- the brain's half ----

test('a tick that starts a goal books no idle time: the wait for it is the run\'s', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const work: Goal = { name: 'work', priority: 5, wants: () => 'test', run: async () => 'ok', timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [work] });
  brain.setEnabled(true);
  for (let i = 0; i < 3; i++) { await brain.tick(); await settle(); clock += 5000; }
  // three runs, each over at once, 5 s apart: ticks would have called none of it idle too, but for the wrong reason
  t.deepEqual(today(brain), { day: 0, workMs: 10_000, idleMs: 0, emptyMs: 0, by: {} });
  t.deepEqual(recent(brain).filter(l => /idle/.test(l)), []);
  brain.setEnabled(false);
});

test('idle time is booked in ms under the cause that leads; a tick that did not look, night, sleep, thunder and no home book nothing', async (t) => {
  const state: State = { pos: HOME, time: 6000 };
  const { rt, calls } = fakeRuntime(state);
  let clock = T0;
  const goals = [
    idler('deep', () => ({ cause: 'late', text: 'deep needs 3 min, 2.1 left' })),
    idler('stash', () => ({ cause: 'pockets', text: '36/36, nothing to put away' })),
    idler('quiet')
  ];
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 12_000, now: () => clock, goals });
  brain.setEnabled(true);
  const tick = async (ms = 5000) => { clock += ms; await brain.tick(); };
  await brain.tick(); // the first look: nothing to count from yet
  t.is(brain.worldMemory()!.idle, undefined);
  await tick();
  await tick(4000);
  t.deepEqual(today(brain), { day: 0, workMs: 9000, idleMs: 9000, emptyMs: 0, by: { pockets: 9000 } }); // real time, not ticks; pockets leads late
  t.is(statusLine(brain, 'Now:'), 'Now: idle (pockets): 36/36, nothing to put away.');
  // a tick that hung, or a clock that jumped: 15 s of it at most
  await tick(40_000);
  t.is(today(brain).idleMs, 24_000);

  // the LLM has the bot: its time is not the autopilot's daytime, and nothing is asked of the game for the tally
  await brain.manual('dig-block');
  calls.length = 0;
  await tick();
  t.deepEqual(calls.filter(c => c !== 'hud.set'), []);
  t.is(statusLine(brain, 'Now:'), 'Now: nothing to do.');
  await tick();
  t.is(today(brain).idleMs, 24_000);
  await tick(); // the lease is over: the 5 s since the last tick count again
  t.is(today(brain).idleMs, 29_000);

  // no look at the world (not in it): not counted, and not made up for afterwards
  state.inWorld = false;
  await tick();
  t.is(today(brain).idleMs, 29_000);
  state.inWorld = true;
  await tick();
  t.is(today(brain).idleMs, 34_000);

  // the evening and the night are not daytime
  state.time = 11_500;
  await tick();
  state.time = 14_000;
  await tick();
  t.is(today(brain).idleMs, 34_000);
  t.is(statusLine(brain, 'Now:'), 'Now: nothing to do.');
  state.time = 6000;
  await tick();
  t.is(today(brain).idleMs, 39_000);

  // asleep by day (the night skipped in a bed, not up yet)
  state.sleeping = true;
  await tick();
  t.is(today(brain).idleMs, 39_000);
  state.sleeping = false;
  await tick();
  t.is(today(brain).idleMs, 44_000);

  // a thunderstorm is rest
  state.thundering = true;
  await tick();
  t.is(today(brain).idleMs, 44_000);
  state.thundering = false;
  await tick();
  t.is(today(brain).idleMs, 49_000);

  // no home: nothing to work from
  state.homeless = true;
  await tick();
  t.is(today(brain).idleMs, 49_000);
  state.homeless = false;
  await tick();
  t.deepEqual(today(brain), { day: 0, workMs: 54_000, idleMs: 54_000, emptyMs: 0, by: { pockets: 54_000 } });
  t.notRegex(brain.status(), /idle log: /); // nothing went wrong in the measuring
  brain.setEnabled(false);
});

test('time with the autopilot off is not counted, and no idle streak spans it', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [idler('quiet')] });
  brain.setEnabled(true);
  const tick = async (ms = 5000) => { clock += ms; await brain.tick(); };
  await brain.tick();
  for (let i = 0; i < 4; i++) await tick();
  t.is(statusLine(brain, 'Now:'), 'Now: idle (nothing): no goal wants to run, and none says why.');
  brain.setEnabled(false);
  t.is(statusLine(brain, 'Now:'), 'Now: nothing to do.');
  clock += 2 * 60_000; // (under the 3 minutes of standing still that the idle watchdog acts on: it counts the time off)
  brain.setEnabled(true);
  await tick(1000); // a second after it was switched on: not the 2 minutes off, nor 15 s of them
  t.is(today(brain).idleMs, 20_000);
  await tick();
  t.deepEqual(today(brain), { day: 0, workMs: 25_000, idleMs: 25_000, emptyMs: 0, by: { nothing: 25_000 } });
  t.deepEqual(recent(brain), [
    '14:00:00 autonomy on',
    '14:00:15 idle 15s: nothing: no goal wants to run, and none says why',
    '14:00:20 autonomy off',
    '14:00:20 idle over after 20s: nothing 20s',
    '14:02:20 autonomy on'
  ]);
  brain.setEnabled(false);
});

test('the walk home from nowhere counts as idle time (away)', async (t) => {
  const state: State = { pos: { x: 60, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  let arrive = () => { /* not walking yet */ };
  rt.actions['go-home'] = async () => { await new Promise<void>(r => { arrive = r; }); state.pos = { ...HOME }; return reply('Home'); };
  let clock = T0;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [returnIdle] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  t.regex(statusLine(brain, 'Now:') ?? '', /^Now: idle \(nothing to do out here: back to the yard\) for 0s\.$/);
  clock += 5000; await brain.tick();
  clock += 5000; await brain.tick();
  clock += 2000; arrive(); await settle(); // home between two ticks: the 2 s since the last one are the walk's too
  t.is(recent(brain).at(-1), '14:00:12 done idle in 12s: back home');
  t.deepEqual(today(brain), { day: 0, workMs: 12_000, idleMs: 12_000, emptyMs: 0, by: { away: 12_000 } });
  brain.setEnabled(false);
});

test('a gains goal with no gain is booked empty; with one, also when stopped midway, it is busy time', async (t) => {
  const { rt, finish } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0, bring = 0, lost = false;
  const haul: Goal = {
    name: 'haul', priority: 5, gains: true, wants: () => 'test', timeoutMs: 600_000, retryMs: 1000,
    run: async (ctx) => {
      // as it comes in, not at the end: a run stopped midway keeps what it got
      if (bring) { ctx.gain(bring); ctx.gain(1); ctx.gain(0); ctx.gain(NaN); }
      await ctx.act('slow');
      if (lost) throw new Error('lost the way');
      return `brought ${bring}`;
    }
  };
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => clock, goals: [haul] });
  brain.setEnabled(true);
  const tick = async () => { clock += 5000; await brain.tick(); await settle(); };
  await brain.tick(); await settle();

  // 5 s out, nothing brought back: busy to no gain
  await tick();
  finish(); await settle();
  t.deepEqual(today(brain), { day: 0, workMs: 5000, idleMs: 0, emptyMs: 5000, by: {} });

  // the same with something to show: the wait for it, and the 10 s out
  bring = 3;
  await tick(); await tick();
  finish(); await settle();
  t.deepEqual(today(brain), { day: 0, workMs: 15_000, idleMs: 0, emptyMs: 5000, by: {} });

  // a run that fails with nothing brought in is empty too
  bring = 0; lost = true;
  await tick();
  finish(); await settle();
  t.deepEqual(today(brain), { day: 0, workMs: 20_000, idleMs: 0, emptyMs: 10_000, by: {} });

  // stopped midway (the LLM took over) with 2 in the pockets: what it got counts, and so do the 3 s since the last tick
  bring = 1; lost = false;
  await tick();
  clock += 3000;
  await brain.manual('dig-block'); await settle();
  t.deepEqual(today(brain), { day: 0, workMs: 28_000, idleMs: 0, emptyMs: 10_000, by: {} });

  // what each run brought in is on the loop watch's record of it (not read there yet)
  const runs = (brain as unknown as { loops: { runs: Run[] } }).loops.runs;
  t.deepEqual(runs.map(r => [r.outcome, r.gain]), [['done', undefined], ['done', 4], ['failed', undefined], ['stopped', 2]]);
  brain.setEnabled(false);
});

test('the idle log: a line at 15 s, on a new lead cause (never twice in 15 s) and each minute; one when it is over; the day\'s sums in the morning; and brain-status says the same', async (t) => {
  const state: State = { pos: HOME, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = T0, full = true, go = false;
  const goals: Goal[] = [
    { name: 'deep', priority: 5, gains: true, timeoutMs: 60_000, retryMs: 1000, run: async () => 'back',
      ...fromGate(() => (go ? { want: 'morning trip' } : { cause: 'late', text: 'deep needs 3 min, 2.1 left' })) },
    idler('cane', () => ({ cause: 'dry', text: 'cane [south] until 14:32' })),
    idler('stash', () => (full ? { cause: 'pockets', text: '35/36, nothing to put away (kept: lookout load)' } : null))
  ];
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals });
  brain.setEnabled(true);
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } };
  await brain.tick();
  brain.worldMemory()!.progress = { done: [], journal: [], need: { sugar_cane: 98, leather: 38, string: 0 } };
  await tick(2);
  t.deepEqual(recent(brain), ['14:00:00 autonomy on']); // 10 s of it: not worth a line yet
  await tick();
  const first = '14:00:15 idle 15s: pockets: 35/36, nothing to put away (kept: lookout load) | late: deep needs 3 min, 2.1 left | dry: cane [south] until 14:32';
  t.is(recent(brain).at(-1), first);
  t.is(statusLine(brain, 'Now:'), 'Now: idle (pockets): 35/36, nothing to put away (kept: lookout load).');
  t.is(statusLine(brain, 'Idle by cause'), 'Idle by cause today: pockets 100%.');
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: project - short of 98 sugar_cane, 38 leather');

  // the lead flips every tick: no line 5 s and 10 s after the last, one at 15 s (the lead is another by then)
  full = false; await tick();
  full = true; await tick();
  t.is(recent(brain).at(-1), first);
  full = false; await tick();
  const second = '14:00:30 idle 30s: late: deep needs 3 min, 2.1 left | dry: cane [south] until 14:32';
  t.is(recent(brain).at(-1), second);
  // the same lead from here on: the next line a minute after the last
  await tick(11);
  t.is(recent(brain).at(-1), second);
  await tick();
  t.is(recent(brain).at(-1), '14:01:30 idle 90s: late: deep needs 3 min, 2.1 left | dry: cane [south] until 14:32');
  t.is(statusLine(brain, 'Now:'), 'Now: idle (late): deep needs 3 min, 2.1 left.');
  t.is(statusLine(brain, 'Idle by cause'), 'Idle by cause today: late 78%, pockets 22%.');
  t.deepEqual(today(brain), { day: 0, workMs: 90_000, idleMs: 90_000, emptyMs: 0, by: { pockets: 20_000, late: 70_000 } });

  // something to do at last (a trip that brings nothing back: 5 s of empty time)
  go = true;
  await tick(); await settle();
  go = false;
  t.regex(statusLine(brain, 'Today:') ?? '', /^Today: idle \d+% of daytime\.$/); // the old line, from the old count, as it was
  // the night, and the morning after it
  state.time = 13_000;
  await tick();
  state.time = 100;
  await tick();
  t.deepEqual(recent(brain), [
    '14:00:00 autonomy on',
    first,
    second,
    '14:01:30 idle 90s: late: deep needs 3 min, 2.1 left | dry: cane [south] until 14:32',
    '14:01:35 start deep: morning trip',
    '14:01:35 idle over after 90s: late 70s, pockets 20s',
    '14:01:35 done deep in 0s: back',
    '14:01:45 day: idle 95% (90s), empty 5% (5s) of 95s: late 70s, pockets 20s'
  ]);
  const m = idleOf(brain.worldMemory()!);
  t.deepEqual(m.days, [{ day: 0, workMs: 95_000, idleMs: 90_000, emptyMs: 5000, by: { pockets: 20_000, late: 70_000 } }]);
  t.deepEqual(m.today, { day: 1, workMs: 5000, idleMs: 5000, emptyMs: 0, by: { late: 5000 } }); // the new day's first 5 s
  t.is(statusLine(brain, 'Idle by cause'), 'Idle by cause today: late 100%.');
  brain.setEnabled(false);
});

test('a held goal says why: a failure (its text, cut short), three in a row until the morning; and the morning lets it go', async (t) => {
  const state: State = { pos: HOME, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = T0, ok = false;
  const flaky: Goal = {
    name: 'flaky', priority: 5, wants: () => 'test', timeoutMs: 60_000, retryMs: 1000,
    run: async () => { if (ok) return 'fine'; throw new Error('no path to the chest at (3, 64, 5):\n   Baritone gave up after 30 s of going round the fence'); }
  };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [flaky] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  // one line, 60 characters of it
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: flaky held until 14:00 (failed: no path to the chest at (3, 64, 5): Baritone gave up after 3)');
  t.is(statusLine(brain, 'Now:'), 'Now: idle (hold): flaky held until 14:00 (failed: no path to the chest at (3, 64, 5): Baritone gave up after 3).');
  clock += 2000;
  t.is(statusLine(brain, 'Blocked:'), undefined); // its second up: held no longer
  await brain.tick(); await settle();
  clock += 2000; await brain.tick(); await settle();
  // 18000 ticks to the morning: a quarter of an hour
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: flaky held until 14:15 (3 failures: until morning)');
  for (let i = 0; i < 3; i++) { clock += 5000; await brain.tick(); }
  t.is(recent(brain).at(-1), '14:00:19 idle 15s: hold: flaky held until 14:15 (3 failures: until morning)');
  t.deepEqual(today(brain).by, { hold: 15_000 });
  // the night skipped in a bed: the morning lets the hold go, and its why with it
  state.time = 12_900; clock += 2000; await brain.tick();
  ok = true;
  state.time = 100; clock += 2000; await brain.tick(); await settle();
  t.is(recent(brain).at(-1), '14:00:23 done flaky in 0s: fine');
  t.is(statusLine(brain, 'Blocked:'), undefined);
  brain.setEnabled(false);
});

test('a held goal says why: out of time', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const slowpoke: Goal = { name: 'slowpoke', priority: 5, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 10_000, retryMs: 120_000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [slowpoke] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  clock += 15_000; await brain.tick(); await settle();
  t.regex(brain.status(), /stopping slowpoke: slowpoke ran out of time/);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: slowpoke held until 14:02 (timed out)');
  brain.setEnabled(false);
});

test('a held goal says why: stuck (no movement for 3 minutes)', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000, process: 'Custom Goal' });
  let clock = T0;
  const walk: Goal = { name: 'walk', priority: 5, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [walk] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  clock += 60_000; await brain.tick();
  clock += 3.1 * 60_000; await brain.tick(); await settle();
  t.regex(brain.status(), /walk looks stuck \(no movement for 3 min at 0,64,0\)/);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: walk held until 14:07 (stuck)'); // 3 minutes from 14:04:06
  brain.setEnabled(false);
});

test('a held goal says why: wedged in a fence', async (t) => {
  const { rt } = fakeRuntime({ pos: { x: 0.5, y: 64, z: 0.95 }, time: 6000, process: 'Custom Goal' });
  const call = rt.call;
  rt.call = (async (method: string, params?: Record<string, unknown>) => {
    if (method === 'world.region' && params?.width === 3) {
      // the 3x2x3 round the bot: a fence line east-west through its cell, open to the south
      const b = new Array<string>(18).fill('air');
      for (const x of [0, 1, 2]) for (const dy of [0, 1]) b[x + 1 * 3 + dy * 9] = 'oak_fence[east=true,west=true]';
      return { blocks: b };
    }
    if (method === 'steer') return { reached: true };
    return call(method, params);
  }) as ClientRuntime['call'];
  let clock = T0;
  const walk: Goal = { name: 'walk', priority: 5, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [walk] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  clock += 5000; await brain.tick(); await settle();
  clock += 20_000; await brain.tick(); await settle();
  clock += 15_000; await brain.tick(); await settle();
  t.regex(brain.status(), /walk is wedged in the oak_fence at 0,64,0: stepping out/);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: walk held until 14:00 (wedged)'); // 5 s, from 14:00:40
  brain.setEnabled(false);
});

test('a held goal says why: a loop; the morning lets the other holds go with their whys, and puts this one back with its own', async (t) => {
  const state: State = { pos: HOME, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = T0, tried = false;
  const spin: Goal = { name: 'spin', priority: 9, wants: () => 'wants', run: async () => 'nothing to show', timeoutMs: 60_000, retryMs: 1000 };
  const flaky: Goal = { name: 'flaky', priority: 5, wants: () => (tried ? null : 'once'), run: async () => { tried = true; throw new Error('in the way'); }, timeoutMs: 60_000, retryMs: 300_000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [spin, flaky] });
  brain.setEnabled(true);
  const go = async (n: number) => { for (let i = 0; i < n; i++) { await brain.tick(); await settle(); clock += 2000; } };
  await go(6); // spin four times over (14:00:00 to :06), then flaky once (:08)
  t.regex(brain.status(), /LOOP \(spinning\).*spin backed off for 10 min/);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: spin held until 14:10 (loop: spinning) | flaky held until 14:05 (failed: in the way)');
  state.time = 12_900; await go(1);
  state.time = 100; await go(1);
  t.regex(brain.status(), /morning: flaky may try again/);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: spin held until 14:10 (loop: spinning)');
  brain.setEnabled(false);
});

test('the tally is saved when a run ends, and standing idle once a minute at most', async (t) => {
  const file = tempFile();
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0, go = false;
  const work: Goal = { name: 'work', priority: 5, wants: () => (go ? 'test' : null), run: async () => 'ok', timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [work], memoryFile: file });
  brain.setEnabled(true);
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } };
  const saved = () => (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>)['seed:1'].idle?.today;
  await brain.tick();
  await tick(11);
  t.is(saved(), undefined); // 55 s idle: on file is the first look round home, from before anything was counted
  await tick();
  t.deepEqual(saved(), { day: 0, workMs: 60_000, idleMs: 60_000, emptyMs: 0, by: { nothing: 60_000 } });
  await tick(11);
  t.is(saved()?.idleMs, 60_000); // 17,000 ticks a day are not 17,000 writes
  await tick();
  t.is(saved()?.idleMs, 120_000);
  go = true;
  await tick(); await settle();
  t.deepEqual(saved(), { day: 0, workMs: 125_000, idleMs: 120_000, emptyMs: 0, by: { nothing: 120_000 } });
  brain.setEnabled(false);
});

test('a brain.json with something else under idle does not stop the counting', async (t) => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': { landmarks: { chests: [], farmland: [] }, leash: 96, idle: { today: 'none', days: [null, { day: 'x', workMs: 5 }] } } }));
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [idler('quiet')], memoryFile: file });
  brain.setEnabled(true);
  await brain.tick();
  for (let i = 0; i < 2; i++) { clock += 5000; await brain.tick(); }
  t.deepEqual(idleOf(brain.worldMemory()!), { today: { day: 0, workMs: 10_000, idleMs: 10_000, emptyMs: 0, by: { nothing: 10_000 } }, days: [{ day: 0, workMs: 5, idleMs: 0, emptyMs: 0, by: {} }] });
  t.notRegex(brain.status(), /idle log: |tick failed/);
  brain.setEnabled(false);
});

test('a failure in the measuring is noted once and never stops a tick from deciding', async (t) => {
  const file = tempFile();
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0, go = false;
  const work: Goal = { name: 'work', priority: 5, wants: () => (go ? 'test' : null), run: async () => 'ok', timeoutMs: 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [work], memoryFile: file });
  brain.setEnabled(true);
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } };
  await brain.tick();
  // the idle tally's own save cannot be made (a folder sits where its temp file goes)
  fs.mkdirSync(`${file}.tmp`);
  await tick(12);
  t.regex(recent(brain).at(-1) ?? '', /^14:01:00 idle log: time failed \(noted once\): /);
  await tick(12); // and again a minute on: not a second line
  t.is(recent(brain).filter(l => /idle log: /.test(l)).length, 1);
  t.notRegex(brain.status(), /tick failed/);
  t.is(today(brain).idleMs, 120_000); // the counting went on
  fs.rmdirSync(`${file}.tmp`);
  go = true;
  await tick(); await settle();
  t.is(recent(brain).at(-1), '14:02:05 done work in 0s: ok'); // and so did the deciding
  brain.setEnabled(false);
});
