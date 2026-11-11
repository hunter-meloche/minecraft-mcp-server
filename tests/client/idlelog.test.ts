import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import { Brain } from '../../src/client/brain/brain.js';
import { BrainMemory, type WorldMemory } from '../../src/client/brain/memory.js';
import { brainRun, type ClientRuntime } from '../../src/client/tools.js';
import { fromGate, returnIdle, type Decline, type Gate, type Goal, type Snapshot } from '../../src/client/brain/goals.js';
import { explainIdle, idleOf, tally, tallyRoll, todayLine, type IdleCause } from '../../src/client/brain/idlelog.js';
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
  const held = new Map([['c', T0 + 90_000], ['a', T0 - 1], ['gone', T0 + 5000], ['d', T0 + 1000], ['e', T0 + 90_000]]);
  t.deepEqual(explainIdle(snap({ health: 8, distHome: 120.4 }), world, goals, held, new Map([['c', 'stuck'], ['a', 'timed out'], ['e', 'stuck']])), [
    { cause: 'away', text: '120 blocks from home, leash 96' },
    { cause: 'health', text: 'health 8, food 20' },
    { cause: 'hold', text: 'd held until 14:00', until: T0 + 1000 }, // a hold nobody gave a reason for still shows
    { cause: 'hold', text: 'e held until 14:01 (stuck)', until: T0 + 90_000 },
    { cause: 'kit', text: 'no pickaxe' }, // c is held as well, but would not run without its hold either: by what it says
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

test('todayLine: how much of today\'s daytime was idle and how much busy to no gain, with yesterday\'s pair once a day is kept; no line before any is counted, and it only reads', (t) => {
  const world = emptyWorld();
  t.is(todayLine(world), undefined);
  t.is(world.idle, undefined); // a brain.json from before the tally gets none made by being asked
  // a day of 500 s: 155 of them idle, 60 busy to no gain
  tally(world, 'idle', 155_000, 'project');
  tally(world, 'empty', 60_000);
  tally(world, 'busy', 285_000);
  t.is(todayLine(world), 'Today: idle 31% of daytime, 12% busy to no gain.'); // no day before it yet
  tallyRoll(world);
  t.is(todayLine(world), undefined); // the morning: nothing counted today, and not "idle 0%"
  tally(world, 'idle', 46_000, 'late');
  tally(world, 'empty', 23_000);
  tally(world, 'busy', 506_000);
  t.is(todayLine(world), 'Today: idle 8% of daytime, 4% busy to no gain (yesterday 31%, 12%).');

  // whatever a brain.json holds under idle: read as far as it is sound, never thrown on, and left as it is
  const read = (idle: unknown) => {
    const w = { ...emptyWorld(), idle } as unknown as WorldMemory;
    const before = JSON.stringify(w);
    const line = todayLine(w);
    t.is(JSON.stringify(w), before);
    return line;
  };
  for (const junk of ['yesterday', 7, null, [1, 2], {}, { today: 5 }, { today: { workMs: 'x' } }, { today: { workMs: -5, idleMs: 3 } }]) t.is(read(junk), undefined, JSON.stringify(junk));
  t.is(read({ today: { workMs: 1000, idleMs: 500, emptyMs: 'x' }, days: 'none' }), 'Today: idle 50% of daytime, 0% busy to no gain.');
  t.is(read({ today: { workMs: 1000, idleMs: 250, emptyMs: 100 }, days: [null, { workMs: 10 }] }), 'Today: idle 25% of daytime, 10% busy to no gain.');
  t.is(read({ today: { workMs: 1000 }, days: [{ workMs: 0, idleMs: 5 }] }), 'Today: idle 0% of daytime, 0% busy to no gain.'); // a day with no daytime is no yesterday
  t.is(read({ today: { workMs: 1000 }, days: [{ workMs: 200, idleMs: 100, emptyMs: 50 }] }), 'Today: idle 0% of daytime, 0% busy to no gain (yesterday 50%, 25%).');
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
  let clock = T0;
  // what the next run is to do, settled as it sets out: it sets out the moment the one before it is over (the hand-over)
  let plan = { bring: 0, lost: false };
  const haul: Goal = {
    name: 'haul', priority: 5, gains: true, wants: () => 'test', timeoutMs: 600_000, retryMs: 1000,
    run: async (ctx) => {
      const { bring, lost } = plan;
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
  plan = { bring: 3, lost: false };
  finish(); await settle();
  t.deepEqual(today(brain), { day: 0, workMs: 5000, idleMs: 0, emptyMs: 5000, by: {} });

  // the same with something to show, 10 s out (it set out as the first came in: no wait between them)
  await tick(); await tick();
  plan = { bring: 0, lost: true };
  finish(); await settle();
  t.deepEqual(today(brain), { day: 0, workMs: 15_000, idleMs: 0, emptyMs: 5000, by: {} });

  // a run that fails with nothing brought in is empty too
  await tick();
  plan = { bring: 1, lost: false };
  finish(); await settle();
  t.deepEqual(today(brain), { day: 0, workMs: 20_000, idleMs: 0, emptyMs: 10_000, by: {} });
  t.is(statusLine(brain, 'Now:'), 'Now: idle (hold): haul held until 14:00 (failed: lost the way).'); // a failure is waited out: nothing set out after it

  // stopped midway (the LLM took over) with 2 in the pockets: what it got counts, and so do the 5 s it waited to set
  // out and the 3 s since the last tick
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
  t.is(statusLine(brain, 'Today:'), undefined); // no daytime counted yet: no line, not "idle 0%"
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
  t.is(statusLine(brain, 'Today:'), 'Today: idle 95% of daytime, 5% busy to no gain.'); // from the tally: 90 s of 95 idle, the trip's 5 s empty; no yesterday yet
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
  t.is(statusLine(brain, 'Today:'), 'Today: idle 100% of daytime, 0% busy to no gain (yesterday 95%, 5%).');
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

// ---- step 2: the hand-over, the watchdog's count, a hold let go early ----

/** The lines that say a hold was let go early. */
const freed = (brain: Brain) => recent(brain).filter(l => /on a hold/.test(l));

test('brain-status on a brain.json with no tally, or with something else under idle: no Today line until daytime is counted, then one, and nothing goes wrong', async (t) => {
  for (const idle of [undefined, 'yesterday', { today: 'none', days: 7 }]) {
    const file = tempFile();
    fs.writeFileSync(file, JSON.stringify({ 'seed:1': { landmarks: { chests: [], farmland: [] }, leash: 96, ...(idle === undefined ? {} : { idle }) } }));
    const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
    let clock = T0;
    const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [idler('quiet')], memoryFile: file });
    brain.setEnabled(true);
    await brain.tick();
    t.is(statusLine(brain, 'Today:'), undefined, JSON.stringify(idle));
    clock += 5000; await brain.tick();
    t.is(statusLine(brain, 'Today:'), 'Today: idle 100% of daytime, 0% busy to no gain.', JSON.stringify(idle));
    t.notRegex(brain.status(), /idle log: |tick failed/);
    brain.setEnabled(false);
  }
});

test('the hand-over books each moment once: the next run sets out in the second the last one ended, and neither\'s time is idle', async (t) => {
  const { rt, finish } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const began: string[] = [];
  const job = (name: string, priority: number): Goal => ({
    name, priority, wants: () => (began.includes(name) ? null : 'once'), timeoutMs: 600_000, retryMs: 1000,
    run: async (ctx) => { began.push(name); return (await ctx.act('slow')).text; }
  });
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [job('first', 9), job('second', 5)] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  clock += 5000; await brain.tick();
  clock += 2000; finish(); await settle(); // 7 s in, between two ticks; no tick() from here to the next run
  t.deepEqual(recent(brain).slice(-2), ['14:00:07 done first in 7s: slow done', '14:00:07 start second: once']);
  clock += 5000; await brain.tick();
  clock += 1000; finish(); await settle(); // 6 s on; the look that follows finds nothing to do
  t.is(recent(brain).at(-1), '14:00:13 done second in 6s: slow done');
  t.deepEqual(today(brain), { day: 0, workMs: 13_000, idleMs: 0, emptyMs: 0, by: {} });
  clock += 5000; await brain.tick();
  t.deepEqual(today(brain), { day: 0, workMs: 18_000, idleMs: 5000, emptyMs: 0, by: { nothing: 5000 } });
  brain.setEnabled(false);
});

test('the walk home counts as idle (away) and does not reset the watchdog: its 3 minutes run from the first look, through the walk', async (t) => {
  const state: State = { pos: { x: 60, y: 64, z: 0 }, time: 6000 };
  const { rt } = fakeRuntime(state);
  let arrive = () => { /* not walking yet */ };
  rt.actions['go-home'] = async () => { await new Promise<void>(r => { arrive = r; }); state.pos = { ...HOME }; return reply('Home'); };
  let clock = T0;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [returnIdle] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  // a minute's walk, 5 blocks between two looks (3 blocks moved start the watchdog's count again, when it is not this walk)
  for (let i = 0; i < 11; i++) { clock += 5000; state.pos = { ...state.pos, x: state.pos.x - 5 }; await brain.tick(); }
  clock += 5000; arrive(); await settle(); // the last 5 blocks, and home
  t.is(recent(brain).at(-1), '14:01:00 done idle in 60s: back home');
  for (let i = 0; i < 23; i++) { clock += 5000; await brain.tick(); }
  t.deepEqual(recent(brain).filter(l => /min by day/.test(l)), []); // 14:02:55
  clock += 5000; await brain.tick(); await settle();
  // 3 minutes after the first look, not 3 after arriving: each walk home used to start them afresh, and a bot that
  // went out and back every few minutes was never idle long enough to be helped
  t.deepEqual(recent(brain).filter(l => /min by day/.test(l)), ['14:03:00 idle 3 min by day: let go of nothing (nothing was held)']);
  t.deepEqual(today(brain), { day: 0, workMs: 180_000, idleMs: 180_000, emptyMs: 0, by: { away: 60_000, nothing: 120_000 } });
  brain.setEnabled(false);
});

test('a minute of idle time on a hold lets one ordinary hold go early: once, its failures still counted, and never a goal left until the morning', async (t) => {
  const state: State = { pos: HOME, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = T0, runs = 0;
  // it fails at once, and waits a minute and a half after each failure
  const flaky: Goal = { name: 'flaky', priority: 5, wants: () => 'wants', timeoutMs: 60_000, retryMs: 90_000, run: async () => { runs++; throw new Error('in the way'); } };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [flaky] });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } await settle(); };
  await brain.tick(); await settle();
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: flaky held until 14:01 (failed: in the way)');
  await ticks(11); // 55 s of standing about for it
  t.is(runs, 1);
  t.deepEqual(freed(brain), []);
  await ticks(1); // the minute is up: it goes again now, not at 14:01:30, and in the same second (no tick() of the test's)
  t.is(runs, 2);
  t.deepEqual(recent(brain).slice(-4), [
    '14:01:00 idle 60s on a hold: let go of flaky (failed: in the way)',
    '14:01:00 start flaky: wants',
    '14:01:00 idle over after 60s: hold 60s',
    '14:01:00 failed flaky: in the way'
  ]);

  // it failed again and is held again: not let go early a second time, or it would be tried every minute all day
  await ticks(12);
  t.is(clock, T0 + 120_000);
  t.is(runs, 2);
  t.is(freed(brain).length, 1);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: flaky held until 14:02 (failed: in the way)');

  // this hold runs its full time, to 14:02:30. The third failure in a row: the early release kept the count
  await ticks(5);
  t.is(runs, 2);
  await ticks(1);
  t.is(runs, 3);
  t.deepEqual(recent(brain).slice(-2), ['14:02:30 flaky failed 3 times in a row: left until the morning', '14:02:30 failed flaky: in the way']);

  // and "until the morning" is not let go early, however long the bot stands about for it (a few steps away, so
  // that the idle watchdog's 3 minutes of standing still, which do let it go, start afresh)
  state.pos = { x: 8, y: 64, z: 0 };
  await ticks(17);
  t.is(runs, 3);
  t.is(freed(brain).length, 1);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: flaky held until 14:17 (3 failures: until morning)');
  t.notRegex(brain.status(), /min by day/);
  // 60 s, 85 s and 85 s on the holds; the 5 s before the third run set out are that run's
  t.deepEqual(today(brain), { day: 0, workMs: 235_000, idleMs: 230_000, emptyMs: 0, by: { hold: 230_000 } });
  brain.setEnabled(false);
});

test('a goal let go early may be let go early again once a hold on it has run its full time', async (t) => {
  const state: State = { pos: HOME, time: 6000 };
  const { rt } = fakeRuntime(state);
  let clock = T0, runs = 0, ok = false;
  const flaky: Goal = {
    name: 'flaky', priority: 5, wants: () => 'wants', timeoutMs: 60_000, retryMs: 90_000,
    run: async () => { runs++; if (ok) { ok = false; return 'fine'; } throw new Error('in the way'); }
  };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [flaky] });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } await settle(); };
  await brain.tick(); await settle();
  await ticks(12); // 14:01:00: let go early, and it fails again
  t.is(runs, 2);
  await ticks(17); // to 14:02:25: held, and not let go a second time
  t.is(runs, 2);
  ok = true;
  state.pos = { x: 8, y: 64, z: 0 }; // (a few steps away: the idle watchdog's 3 minutes start afresh)
  await ticks(1); // 14:02:30: the hold has run out by itself, and this time it works
  t.is(recent(brain).at(-1), '14:02:30 done flaky in 0s: fine');
  await ticks(1); // 14:02:35: and the time after that it does not
  t.is(runs, 4);
  await ticks(11); // 55 s on that hold
  t.is(runs, 4);
  await ticks(1);
  t.is(runs, 5);
  t.deepEqual(freed(brain), [
    '14:01:00 idle 60s on a hold: let go of flaky (failed: in the way)',
    '14:03:35 idle 60s on a hold: let go of flaky (failed: in the way)'
  ]);
  brain.setEnabled(false);
});

test('a minute of idle time lets go of a stuck stop\'s hold as it does of a failure\'s: once, and stuck again it waits its 3 minutes out', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000, process: 'Custom Goal' });
  let clock = T0;
  const walk: Goal = { name: 'walk', priority: 5, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 60 * 60_000, retryMs: 1000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [walk] });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } await settle(); };
  /** The run in hand stands for 3 minutes with Baritone at work, and the watchdog stops it. */
  const stick = async () => { clock += 60_000; await brain.tick(); clock += 3.1 * 60_000; await brain.tick(); await settle(); };
  await brain.tick(); await settle();
  await stick();
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: walk held until 14:07 (stuck)'); // 3 minutes from 14:04:06
  await ticks(11); // 55 s of standing about for it
  t.deepEqual(freed(brain), []);
  await ticks(1); // the minute is up: it sets out again now, two minutes before its hold ends
  t.deepEqual(recent(brain).slice(-3), [
    '14:05:06 idle 60s on a hold: let go of walk (stuck)',
    '14:05:06 start walk: test',
    '14:05:06 idle over after 60s: hold 60s'
  ]);

  // stuck again, and held again: this hold is not let go early
  await stick();
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: walk held until 14:12 (stuck)'); // 3 minutes from 14:09:12
  await ticks(13);
  t.is(freed(brain).length, 1);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: walk held until 14:12 (stuck)');
  t.is(recent(brain).filter(l => /start walk/.test(l)).length, 2);
  brain.setEnabled(false);
});

test('a minute of idle time lets go of the hold of a run that ran out of time: once, and out of time again it waits the hold out', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const slowpoke: Goal = { name: 'slowpoke', priority: 5, wants: () => 'test', run: async ctx => (await ctx.act('slow')).text, timeoutMs: 10_000, retryMs: 120_000 };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [slowpoke] });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } await settle(); };
  await brain.tick(); await settle();
  await ticks(3); // 15 s into a run that has 10
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: slowpoke held until 14:02 (timed out)'); // 2 minutes from 14:00:15
  await ticks(11);
  t.deepEqual(freed(brain), []);
  await ticks(1); // the minute is up: it goes again now, a minute before its hold ends
  t.deepEqual(recent(brain).slice(-3), [
    '14:01:15 idle 60s on a hold: let go of slowpoke (timed out)',
    '14:01:15 start slowpoke: test',
    '14:01:15 idle over after 60s: hold 60s'
  ]);

  // out of time again, and held again: this hold is not let go early
  await ticks(3);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: slowpoke held until 14:03 (timed out)'); // 2 minutes from 14:01:30
  await ticks(13);
  t.is(freed(brain).length, 1);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: slowpoke held until 14:03 (timed out)');
  t.is(recent(brain).filter(l => /start slowpoke/.test(l)).length, 2);
  brain.setEnabled(false);
});

test('the early release leaves a loop hold alone, and a held goal that has nothing to do until it has', async (t) => {
  // backed off by the loop watch: it went round in circles, and its 10 minutes are the point
  const spinning = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0, runs = 0;
  const spin: Goal = { name: 'spin', priority: 5, wants: () => 'wants', run: async () => { runs++; return 'nothing to show'; }, timeoutMs: 60_000, retryMs: 1000 };
  const round = new Brain(spinning.rt, { tickMs: 1e9, now: () => clock, goals: [spin] });
  round.setEnabled(true);
  await round.tick(); await settle();
  for (let i = 0; i < 3; i++) { clock += 5000; await round.tick(); await settle(); }
  t.is(statusLine(round, 'Blocked:'), 'Blocked: spin held until 14:10 (loop: spinning)');
  for (let i = 0; i < 20; i++) { clock += 5000; await round.tick(); } // 100 s of standing about for it
  await settle();
  t.is(statusLine(round, 'Now:'), 'Now: idle (hold): spin held until 14:10 (loop: spinning).');
  t.is(runs, 4);
  t.deepEqual(freed(round), []);
  t.is(today(round).by.hold, 100_000);
  round.setEnabled(false);

  // held after a failure, and what it was after is gone: letting it go would start nothing, so the hold stays; when
  // there is something for it again, the minute has long been stood, and it goes at the next look
  const quiet = fakeRuntime({ pos: HOME, time: 6000 });
  let more = true;
  clock = T0; runs = 0;
  const haul: Goal = { name: 'haul', priority: 5, wants: () => (more ? 'a load waits' : null), run: async () => { runs++; throw new Error('lost the way'); }, timeoutMs: 60_000, retryMs: 300_000 };
  const brain = new Brain(quiet.rt, { tickMs: 1e9, now: () => clock, goals: [haul] });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  more = false;
  for (let i = 0; i < 14; i++) { clock += 5000; await brain.tick(); } // 70 s
  await settle();
  t.is(runs, 1);
  t.deepEqual(freed(brain), []);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: haul held until 14:05 (failed: lost the way)');
  more = true;
  clock += 5000; await brain.tick(); await settle();
  t.is(runs, 2);
  t.deepEqual(freed(brain), ['14:01:15 idle 60s on a hold: let go of haul (failed: lost the way)']);
  brain.setEnabled(false);
});

test('with two goals held, the first in the order they are tried is let go, and the other a minute later', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const ran: string[] = [];
  const failing = (name: string, priority: number): Goal => ({
    name, priority, wants: () => 'wants', timeoutMs: 60_000, retryMs: 300_000,
    run: async () => { ran.push(name); throw new Error(`${name} is in the way`); }
  });
  // listed the other way round: the order is the urgency's, as where the next goal is chosen
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [failing('low', 3), failing('high', 7)] });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } await settle(); };
  await brain.tick(); await settle(); // 14:00:00: high fails
  await ticks(1);                     // 14:00:05: low fails; both held for 5 minutes
  t.deepEqual(ran, ['high', 'low']);
  await ticks(11);
  t.deepEqual(ran, ['high', 'low']);
  await ticks(1); // 14:01:05: a minute of it
  t.deepEqual(ran, ['high', 'low', 'high']);
  await ticks(11);
  t.is(ran.length, 3);
  await ticks(1); // 14:02:05: a minute more; high has had its turn
  t.deepEqual(ran, ['high', 'low', 'high', 'low']);
  t.deepEqual(freed(brain), [
    '14:01:05 idle 60s on a hold: let go of high (failed: high is in the way)',
    '14:02:05 idle 60s on a hold: let go of low (failed: low is in the way)'
  ]);
  await ticks(10); // 50 s more: both have been let go once, neither goes again
  t.is(ran.length, 4);
  brain.setEnabled(false);
});

test('a held goal that would not run anyway is idle for what it says, not for its hold, and the hold\'s minute counts only while it is the hold that keeps it', async (t) => {
  const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0, runs = 0, late = false;
  const gate = (): Gate => (late ? { cause: 'late', text: 'trip needs 3 min, 2.1 left' } : { want: 'time for a trip' });
  const trip: Goal = { name: 'trip', priority: 5, gate, ...fromGate(gate), timeoutMs: 60_000, retryMs: 600_000, run: async () => { runs++; throw new Error('lost the way'); } };
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [trip] });
  brain.setEnabled(true);
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); } await settle(); };
  await brain.tick(); await settle();
  t.is(statusLine(brain, 'Now:'), 'Now: idle (hold): trip held until 14:10 (failed: lost the way).');
  await ticks(6); // half a minute of standing about for the hold
  t.deepEqual(today(brain).by, { hold: 30_000 });
  // too late in the day for it now: its hold keeps nothing from running, and must not lead
  late = true;
  t.is(statusLine(brain, 'Now:'), 'Now: idle (late): trip needs 3 min, 2.1 left.');
  await ticks(14); // 70 s
  t.is(statusLine(brain, 'Now:'), 'Now: idle (late): trip needs 3 min, 2.1 left.');
  t.is(statusLine(brain, 'Retrying later:'), 'Retrying later: trip 500s.'); // the hold itself stands, and is still to be read
  t.deepEqual(today(brain).by, { hold: 30_000, late: 70_000 });
  t.is(runs, 1);
  t.deepEqual(freed(brain), []); // 100 s idle with a goal held, but never a minute for the hold: nothing to let go
  // time for it again: now it is the hold that keeps it, and its minute starts here (the half one from before does not count)
  late = false;
  await ticks(11);
  t.is(runs, 1);
  await ticks(1);
  t.is(runs, 2);
  t.deepEqual(freed(brain), ['14:02:40 idle 60s on a hold: let go of trip (failed: lost the way)']);
  t.deepEqual(today(brain).by, { hold: 90_000, late: 70_000 });
  brain.setEnabled(false);
});

test('a save that cannot be made at a run\'s end is noted once and the next goal still follows at once; the idle tally\'s failing costs the hold\'s minute nothing', async (t) => {
  // the run's end
  const file = tempFile();
  const { rt, finish } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0;
  const began: string[] = [];
  const job = (name: string, priority: number): Goal => ({
    name, priority, wants: () => (began.includes(name) ? null : 'once'), timeoutMs: 600_000, retryMs: 1000,
    run: async (ctx) => { began.push(name); return (await ctx.act('slow')).text; }
  });
  const brain = new Brain(rt, { tickMs: 1e9, now: () => clock, goals: [job('first', 9), job('second', 5)], memoryFile: file });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  fs.mkdirSync(`${file}.tmp`); // a folder sits where the save's temp file goes: a full disk, as far as the save can tell
  clock += 3000; finish(); await settle();
  clock += 3000; finish(); await settle();
  const lines = recent(brain);
  const at = lines.indexOf('14:00:03 done first in 3s: slow done');
  t.regex(lines[at + 1] ?? '', /^14:00:03 idle log: save failed \(noted once\): /);
  t.deepEqual(lines.slice(at + 2), ['14:00:03 start second: once', '14:00:06 done second in 3s: slow done']); // the second failure is not a second line
  t.notRegex(brain.status(), /tick failed/);
  brain.setEnabled(false);

  // standing idle on a hold, with the once-a-minute save of the tally failing on the tick before the hold's minute is up
  const file2 = tempFile();
  const idle = fakeRuntime({ pos: HOME, time: 6000 });
  let go = false, runs = 0;
  clock = T0;
  const haul: Goal = { name: 'haul', priority: 5, wants: () => (go ? 'a load waits' : null), run: async () => { runs++; throw new Error('lost the way'); }, timeoutMs: 60_000, retryMs: 300_000 };
  const other = new Brain(idle.rt, { tickMs: 1e9, now: () => clock, goals: [haul], memoryFile: file2 });
  other.setEnabled(true);
  await other.tick(); // 14:00:00, nothing to do: the tally's minute to its next save runs from here
  go = true;
  clock += 5000; await other.tick(); await settle(); // 14:00:05: haul fails, held for 5 minutes
  fs.mkdirSync(`${file2}.tmp`);
  for (let i = 0; i < 11; i++) { clock += 5000; await other.tick(); } // to 14:01:00, where that save fails
  await settle();
  t.regex(recent(other).at(-1) ?? '', /^14:01:00 idle log: time failed \(noted once\): /);
  t.is(runs, 1);
  clock += 5000; await other.tick(); await settle(); // 14:01:05: 60 s on the hold, the failed tick's 5 among them
  t.is(runs, 2);
  t.deepEqual(freed(other), ['14:01:05 idle 60s on a hold: let go of haul (failed: lost the way)']);
  t.is(today(other).by.hold, 60_000);
  t.notRegex(other.status(), /tick failed/);
  other.setEnabled(false);
});
