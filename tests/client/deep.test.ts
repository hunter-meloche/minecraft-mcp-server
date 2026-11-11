import test from 'ava';
import { deepTrip, diamondsWanted, tripCheck } from '../../src/client/brain/deep.js';
import { kitNeeds } from '../../src/client/brain/kit.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const item = (slot: number, name: string, count = 1) => ({ slot, name, count });
const world = (chest: Record<string, number> = {}) => ({ landmarks: { chests: [{ x: 0, y: 0, z: 0 }], farmland: [] }, leash: 96, chestItems: { '0,0,0': chest } });

test('diamondsWanted: the whole diamond kit and the table, less what is diamond already and the diamonds there are', (t) => {
  const iron = [item(0, 'iron_pickaxe'), item(1, 'iron_sword'), item(39, 'iron_helmet'), item(38, 'iron_chestplate'), item(37, 'iron_leggings'), item(36, 'iron_boots')];
  t.is(diamondsWanted({ items: iron }, world()), 3 + 2 + 5 + 8 + 7 + 4 + 2);
  t.is(diamondsWanted({ items: [...iron.slice(1), item(0, 'diamond_pickaxe')] }, world({ diamond: 4 })), 2 + 5 + 8 + 7 + 4 + 2 - 4);
});

test('tripCheck: the worst armour piece counts, and a missing one is 0', (t) => {
  const items = [item(39, 'iron_helmet'), item(38, 'iron_chestplate'), item(37, 'iron_leggings')];
  const s = { items, counts: new Map([['torch', 20], ['cobblestone', 40]]), health: 20, food: 20, timeOfDay: 1000, slotsUsed: 10 };
  const c = tripCheck(s as never);
  t.is(c.armorTier, 0);
  t.is(c.torches, 20);
  t.is(c.blocks, 40);
});

test('kit: a sound iron pickaxe with 3 diamonds and sticks about: upgrade to diamond', (t) => {
  const items = [item(0, 'iron_pickaxe'), item(1, 'iron_sword'), item(2, 'iron_axe'), item(3, 'iron_shovel'), item(4, 'iron_hoe'),
    item(39, 'iron_helmet'), item(38, 'iron_chestplate'), item(37, 'iron_leggings'), item(36, 'iron_boots'),
    item(10, 'stone_pickaxe'), item(11, 'stick', 2), item(12, 'torch', 32), item(13, 'cobblestone', 64)];
  const up = kitNeeds(items, { diamond: 3 }).find(n => n.kind === 'pickaxe' && 'why' in n && n.why === 'upgrade');
  t.truthy(up);
  t.like(up, { have: 'iron_pickaxe', bestPossible: 'diamond_pickaxe' });
});

test('kit: a worn diamond pickaxe carried beside a sound stone one: no upgrade from the chest, and it stays on the bot', async (t) => {
  const { stashPlan } = await import('../../src/client/brain/kit.js');
  const items = [item(0, 'stone_pickaxe'), { slot: 10, name: 'diamond_pickaxe', count: 1, damage: 1550, maxDamage: 1561 }, item(11, 'stone_pickaxe')];
  t.falsy(kitNeeds(items, { diamond_pickaxe: 1 }).find(n => n.kind === 'pickaxe' && 'why' in n && n.why === 'upgrade'));
  t.false(stashPlan(items).deposit.some(d => d.name === 'diamond_pickaxe'));
});

// ---- the goal: when it sets out ----

const NOW = Date.UTC(2026, 10, 10, 14, 0, 0);
const MIN = 60_000;
/** The trip's kit: torches, blocks, bread for 20 food points, a pickaxe, iron armour on. */
const KIT = [item(0, 'torch', 64), item(1, 'cobblestone', 64), item(2, 'bread', 4), item(3, 'iron_pickaxe'),
  item(36, 'iron_boots'), item(37, 'iron_leggings'), item(38, 'iron_chestplate'), item(39, 'iron_helmet')];

/** At home with `items` at `time` of day, well and fed. */
function at(time: number, items = KIT, over: Partial<Snapshot> = {}): Snapshot {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: NOW, timeOfDay: time, activity: activityAt(time), health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
  };
}

/** A home with no diamonds, whose last trip was an hour ago. */
const home = (): WorldMemory => ({
  landmarks: { chests: [{ x: 1, y: 64, z: 1 }], farmland: [] }, leash: 96, chestItems: { '1,64,1': { diamond: 0 } }, lastDone: { deep: NOW - 60 * MIN }
});

/** A run's context on fakes: `call` answers from `calls` (a function may throw), every tool used is noted in `did`. */
function tripCtx(s: Snapshot, world: WorldMemory, calls: Record<string, () => unknown> = {}) {
  const did: string[] = [];
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    call: (async (method: string) => { did.push(method); return calls[method]?.() ?? { zones: [] }; }) as GoalContext['call'],
    act: async (tool: string) => { did.push(tool); return { ok: true, text: 'ok' }; }
  } as unknown as GoalContext;
  return { ctx, did };
}

test('too late for a deep trip is a decline, and lastDone.deep is untouched', async (t) => {
  // time at the ore = the day to 11000 less the 2 min home: 3 min of it are there up to time 5000, and no later
  const w = home();
  const asked = JSON.stringify(w);
  t.is(deepTrip.wants(at(5000), w), '31 diamond(s) wanted: a deep trip');
  t.is(deepTrip.declines!(at(5000), w), null);
  for (const [time, text] of [[5001, 'deep trip needs 3 min, 2.9 left'], [5600, 'deep trip needs 3 min, 2.5 left'], [6000, 'deep trip needs 3 min, 2.1 left']] as const) {
    t.is(deepTrip.wants(at(time), w), null, `time ${time}`);
    t.deepEqual(deepTrip.declines!(at(time), w), { cause: 'late', text }, `time ${time}`);
  }
  // past the hour it sets out by: said as before
  t.deepEqual(deepTrip.declines!(at(6001), w), { cause: 'late', text: 'time of day 6001 (deep trip sets out by 6000)' });
  // the hour is the reason only for a trip nothing else keeps at home: no torches, or gone already today
  t.is(deepTrip.declines!(at(5600, KIT.slice(1)), w)?.cause, 'kit');
  t.like(deepTrip.declines!(at(5600), { ...home(), lastDone: { deep: NOW - 5 * MIN } }), { cause: 'unneeded', until: NOW + 15 * MIN });
  t.is(JSON.stringify(w), asked, 'asking wrote nothing down');

  // the day ran out between the gate's yes and the run: no trip, said as a text (no failure that keeps the goal back),
  // nothing asked of the game, and the day is not written down as done: in the morning the trip is due
  const late = tripCtx(at(5600), w);
  t.is(await deepTrip.run(late.ctx), 'no trip today: deep trip needs 3 min, 2.5 left');
  t.deepEqual(late.did, []);
  t.is(JSON.stringify(w), asked);
  t.is(deepTrip.wants(at(1000, KIT, { now: NOW + 12 * MIN }), w), '31 diamond(s) wanted: a deep trip');
});

test('the deep trip is the day\'s once it sets out or finds no side to set out from: a walk that fails counts too', async (t) => {
  // someone's build on every side: nowhere to set out from. It fails, and that was today's try: the gate says "not
  // due" from here on, so a hold let go early (or by the idle watchdog) does not send it to fail again
  const hemmed = home();
  const all = { x1: -300, y1: 0, z1: -300, x2: 300, y2: 128, z2: 300, surface: true };
  const no = tripCtx(at(1000), hemmed, { 'foreign.zones': () => ({ zones: [all] }) });
  await t.throwsAsync(deepTrip.run(no.ctx), { message: /every side of the yard has someone else's build by it/ });
  t.deepEqual(no.did, ['foreign.zones']);
  t.deepEqual(hemmed.lastDone, { deep: NOW });
  t.is(hemmed.zones?.mine, undefined);
  t.is(deepTrip.wants(at(1200), hemmed), null);
  t.like(deepTrip.declines!(at(1200), hemmed), { cause: 'unneeded', text: 'deep trip is not due for 20 min (every 20)' });

  // a clear side: it is today's trip from the moment it sets out, whatever comes of the walk
  const w = home();
  const out = tripCtx(at(1000), w, { goto: () => { throw new Error('no path'); } });
  await t.throwsAsync(deepTrip.run(out.ctx), { message: 'no path' });
  t.deepEqual(out.did, ['foreign.zones', 'goto']);
  t.is(w.lastDone?.deep, NOW);
  t.deepEqual(w.zones?.mine, [{ x: 0, y: 64, z: -56 }]);
  t.like(deepTrip.declines!(at(1200), w), { cause: 'unneeded', text: 'deep trip is not due for 20 min (every 20)' });
});

test('the deep trip sets out exactly when it did before, but for the hour that left under 3 min at the ore', (t) => {
  // before: by day in work time, up to time 6000 (and from 5001 the run gave up, the day written down as done)
  const bad: string[] = [];
  for (let time = 0; time < 24_000; time += 50) {
    for (const time1 of [time, time + 1]) {
      const s = at(time1);
      const want = deepTrip.wants(s, home()), no = deepTrip.declines!(s, home());
      const before = s.activity === 'work' && time1 <= 6000;
      const now = before && time1 <= 5000;
      if ((want !== null) !== now || (no === null) !== now || (no && no.cause !== 'late')) bad.push(`time ${time1}: wants ${JSON.stringify(want)}, declines ${JSON.stringify(no)}`);
      if (before && !now && !/^deep trip needs 3 min, 2\.\d left$/.test(no?.text ?? '')) bad.push(`time ${time1}: ${no?.text}`);
    }
  }
  t.deepEqual(bad.slice(0, 10), []);
});
