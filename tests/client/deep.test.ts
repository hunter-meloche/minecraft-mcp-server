import test from 'ava';
import { deepTrip, diamondsWanted, oreTrip, setMineLookMs, tripCheck, type OreWant } from '../../src/client/brain/deep.js';
import { workGoals, workOf, workTick } from '../../src/client/brain/work.js';
import { LADDER } from '../../src/client/brain/worktasks.js';
import type { InventoryItem } from '../../src/client/tools.js';
import { kitNeeds } from '../../src/client/brain/kit.js';
import { pockets } from '../../src/client/brain/pockets.js';
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

// ---- full pockets: the run makes its ten slots first ----

/** Home at its east end, and 64 blocks of it to the west. */
const YARD = { x1: -64, z1: -24, x2: 16, z2: 24, y: 64 };
const FOODS = ['apple', 'cooked_porkchop', 'cooked_cod', 'cooked_salmon', 'cookie', 'melon_slice', 'dried_kelp', 'cooked_beef', 'cooked_chicken', 'carrot',
  'baked_potato', 'pumpkin_pie', 'cooked_rabbit', 'cooked_mutton', 'beetroot', 'sweet_berries', 'glow_berries', 'porkchop', 'cod', 'salmon', 'beef'];
/** The kit and 26 slots more, 30 in all: tools and one each of some foods, which the stash keeps, and `loose` stacks of logs. */
const thirty = (loose: number) => [...KIT,
  ...['iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_sword', 'iron_hoe'].map((name, i) => item(4 + i, name)),
  ...FOODS.slice(0, 21 - loose).map((name, i) => item(9 + i, name)),
  ...Array.from({ length: loose }, (_, i) => item(30 - loose + i, 'oak_log', 64))];

/**
 * A game that keeps count, for a run that makes room first: pockets the chest tool takes from (from the first slot
 * on, while the chest has a slot), a bot that walks. `did` has the walks, what was asked of the chest and every other
 * call that is not a look. The walk out to the mine finds no path, so the run ends where the trip sets out.
 */
function yardBot(s: Snapshot, world: WorldMemory, chest: Record<string, number> = {}) {
  let items = s.items.map(i => ({ ...i }));
  let position = { ...s.position };
  const did: string[] = [];
  const taken = () => Object.values(chest).reduce((n, c) => n + Math.ceil(c / 64), 0);
  const ctx = {
    s, world, signal: new AbortController().signal, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null, position, dimension: 'overworld', timeOfDay: s.timeOfDay, sleeping: false }),
    call: (async (method: string, p: { x?: number; y?: number; z?: number; careful?: boolean } = {}) => {
      if (method === 'inventory') return { items: items.map(i => ({ ...i })) };
      if (method !== 'goto') { did.push(method); return { zones: [] }; }
      did.push(`${p.careful ? 'on foot only' : 'out'} to (${p.x}, ${p.z})`);
      if (!p.careful) throw new Error('no path');
      position = { x: p.x!, y: p.y!, z: p.z! };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: { x?: number; y?: number; z?: number; item?: string; count?: number } = {}) => {
      if (tool !== 'store-in-chest') { did.push(tool); return { ok: true, text: 'ok' }; }
      did.push(`store ${a.count} ${a.item}`);
      let moved = 0;
      for (const i of items.filter(x => x.name === a.item && x.slot < 36).sort((x, y) => x.slot - y.slot)) {
        if (moved >= a.count! || taken() >= 27) break;
        const n = Math.min(i.count, a.count! - moved);
        i.count -= n;
        moved += n;
        chest[i.name] = (chest[i.name] ?? 0) + n;
      }
      items = items.filter(i => i.count > 0);
      const holds = Object.entries(chest).map(([name, n]) => `${name} x${n}`).join(', ') || 'nothing';
      return { ok: true, text: `Stored ${moved} ${a.item} in the chest at (${a.x}, ${a.y}, ${a.z})${moved < a.count! ? ' (the chest is full)' : ''}. It holds: ${holds}; ${27 - taken()}/27 slots free.` };
    }
  } as unknown as GoalContext;
  return { ctx, did, used: () => items.filter(i => i.slot < 36).length };
}

test('30 used, kit ready, in the yard: the deep trip wants, and its run makes room first', async (t) => {
  // the trip waited for ten free slots that nothing made: from 27 used there was no deep trip (83.7 min of the idle in
  // brain.log 2026-11-08..10 were on "N free slots < 10"). And it set out from within 16 of home only, in a yard that
  // reaches 64 out
  const west = { position: { x: -60, y: 64, z: 0 }, distHome: 60 };
  // the mine start it remembers is one the yard has since grown over
  const grown = (): WorldMemory => ({ ...home(), yard: YARD, zones: { mine: [{ x: -40, y: 64, z: 0 }] } });
  const s = at(1000, thirty(7), west);
  t.deepEqual(pockets(s, grown(), 'deep'), { used: 30, free: 6, loose: 7 }, 'the fixture: six free, seven stacks of logs to put away');
  t.is(deepTrip.wants(s, grown()), '31 diamond(s) wanted: a deep trip');
  t.is(deepTrip.declines!(s, grown()), null);
  // nothing in them the stash would put away: six free stay six, and the line says what is missing
  const kept = at(1000, thirty(0), west);
  t.deepEqual(pockets(kept, grown(), 'deep'), { used: 30, free: 6, loose: 0 });
  t.is(deepTrip.wants(kept, grown()), null);
  t.deepEqual(deepTrip.declines!(kept, grown()), { cause: 'pockets', text: '30/36 slots, nothing to put away (deep trip needs 10 free)' });
  // no yard drawn, and 60 from home: not where a trip sets out from, whatever the pockets hold
  t.deepEqual(deepTrip.declines!(s, home()), { cause: 'away', text: '60 blocks from home (deep trip works within 40)' });
  t.is(deepTrip.wants(at(1000, thirty(7), { position: { x: -40, y: 64, z: 0 }, distHome: 40 }), home()), '31 diamond(s) wanted: a deep trip');

  // the run: home to the chests on foot, the logs into the chest, and only then out, from a start outside the yard
  const w = grown();
  const out = yardBot(s, w);
  await t.throwsAsync(deepTrip.run(out.ctx), { message: 'no path' });
  t.deepEqual(out.did, ['on foot only to (0, 0)', 'store 448 oak_log', 'foreign.zones', 'out to (0, -64)']);
  t.is(out.used(), 23);
  t.deepEqual(w.chestItems?.['1,64,1'], { oak_log: 448 });
  t.is(w.lastDone?.deep, NOW, 'today\'s trip from where it set out');
  t.deepEqual(w.zones?.mine, [{ x: 0, y: 64, z: -64 }]);

  // the chest was filled since the bot last looked in it: no room made, so no trip, and it is not written down as
  // today's (nor the mine start touched): the gate has the chest's answer from here on
  const stale = grown();
  const full = yardBot(s, stale, { cobblestone: 27 * 64 });
  await t.throwsAsync(deepTrip.run(full.ctx), { message: 'pockets still 30/36 after putting away' });
  t.deepEqual(full.did, ['on foot only to (0, 0)', 'store 448 oak_log']);
  t.is(full.used(), 30);
  t.is(stale.lastDone?.deep, NOW - 60 * MIN);
  t.deepEqual(stale.zones?.mine, [{ x: -40, y: 64, z: 0 }]);
  // the put-away that fell short is written down, but it is not the reason given: the chest, now known to be full, is
  // what says no, and will after the mark has run out
  t.is(stale.lastDone?.['no room: deep'], NOW);
  t.deepEqual(deepTrip.declines!(s, stale), { cause: 'pockets', text: '30/36 slots, nothing to put away (deep trip needs 10 free)' });
  t.deepEqual(deepTrip.declines!({ ...s, now: NOW + 11 * MIN }, stale), { cause: 'pockets', text: '30/36 slots, nothing to put away (deep trip needs 10 free)' });
});

// ---- one trip, several ores (oreTrip), and the rung and the old goal on it ----

/** Pockets on a fake: `put` adds to a stack of the kind with room, then to the first free slots; `take` from the first slots on. */
function pocket(items: InventoryItem[]) {
  let inv = items.map(i => ({ ...i }));
  const free = () => { for (let slot = 0; slot < 36; slot++) if (!inv.some(i => i.slot === slot)) return slot; return -1; };
  return {
    items: () => inv.map(i => ({ ...i })),
    used: () => inv.filter(i => i.slot < 36).length,
    count: (name: string) => inv.filter(i => i.name === name && i.slot < 36).reduce((n, i) => n + i.count, 0),
    put: (name: string, n: number) => {
      for (const i of inv.filter(x => x.name === name && x.slot < 36 && x.count < 64)) { const k = Math.min(n, 64 - i.count); i.count += k; n -= k; }
      while (n > 0) { const slot = free(); if (slot < 0) return; inv.push({ slot, name, count: Math.min(n, 64) }); n -= 64; }
    },
    take: (name: string, n: number) => {
      let left = n;
      for (const i of inv.filter(x => x.name === name && x.slot < 36).sort((a, b) => a.slot - b.slot)) { const k = Math.min(left, i.count); i.count -= k; left -= k; }
      inv = inv.filter(i => i.count > 0);
      return n - left;
    }
  };
}

/**
 * A trip down on fakes: the walk out arrives (unless `walk` is false), the look round sees nobody's build, and each
 * round of mining brings what `rounds` says and takes as long on the trip's clock (the time asked for, unless it
 * says); a round can also take things away (`take`: a pickaxe worn out), fail as the tool does (`fail`), or be
 * followed by an inventory look that fails (`blind`). `asked` has each round as the trip asked for it (`iron_ore to
 * 20 in 180s`) and each throw (`drop 64 cobbled_deepslate`).
 */
function mineBot(items: InventoryItem[], rounds: { add?: Record<string, number>; ms?: number; take?: string[]; fail?: string; blind?: true; y?: number; z?: number }[],
  over: { tod?: number; health?: number; world?: WorldMemory; walk?: false; y?: number } = {}) {
  const clock = { now: NOW, tod: over.tod ?? 0 };
  // where the bot stands, when the test says (`y`: the level at the mine start; a round's `y` is where it leaves the bot)
  const level: { y?: number; z: number } = { y: over.y, z: -56 };
  const position = () => (level.y === undefined ? {} : { position: { x: 0, y: level.y, z: level.z } });
  const bag = pocket(items);
  const asked: string[] = [];
  const gains: number[] = [];
  const world = over.world ?? home();
  let blind = false;
  const ctx = {
    s: at(clock.tod, bag.items()), world, signal: new AbortController().signal, progress: () => undefined, gain: (n: number) => { gains.push(n); },
    status: async () => ({ inWorld: true, username: 'b', screen: null, timeOfDay: clock.tod, health: over.health ?? 20, ...position() }),
    call: (async (method: string) => {
      if (method === 'inventory') {
        if (blind) { blind = false; throw new Error('timed out'); }
        return { items: bag.items() };
      }
      if (method === 'foreign.zones') return { zones: [] };
      if (method === 'goto' && over.walk === false) return { arrived: false };
      if (method === 'status') return position();
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: { block?: string; count?: number; timeoutMs?: number; item?: string } = {}) => {
      if (tool === 'drop-item') { asked.push(`drop ${a.count} ${a.item}`); return { ok: true, text: `Dropped ${bag.take(a.item!, a.count!)} ${a.item}` }; }
      if (tool !== 'mine-blocks') { asked.push(tool); return { ok: true, text: 'ok' }; }
      asked.push(`${a.block!.split(',')[0]} to ${a.count} in ${a.timeoutMs! / 1000}s`);
      const r = rounds.shift() ?? {};
      if (r.fail) return { ok: false, text: r.fail };
      blind = !!r.blind;
      if (r.y !== undefined) level.y = r.y;
      if (r.z !== undefined) level.z = r.z;
      for (const name of r.take ?? []) bag.take(name, 64);
      for (const [name, n] of Object.entries(r.add ?? {})) bag.put(name, n);
      const ms = r.ms ?? a.timeoutMs!;
      clock.now += ms;
      clock.tod += ms / 50;
      const got = Object.entries(r.add ?? {}).map(([n, k]) => `${n} x${k}`).join(', ');
      return { ok: true, text: `Mined for ${ms / 1000}s: ${got || 'nothing gained'}.` };
    }
  } as unknown as GoalContext;
  return { ctx, asked, gains, clock, bag, world, level };
}

const IRON: OreWant = { family: 'iron', ores: 'iron_ore,deepslate_iron_ore', items: ['raw_iron', 'iron_ingot'], want: 20 };
const GOLD: OreWant = { family: 'gold', ores: 'gold_ore,deepslate_gold_ore', items: ['raw_gold', 'gold_ingot'], want: 10 };
const REDSTONE: OreWant = { family: 'redstone', ores: 'redstone_ore,deepslate_redstone_ore', items: ['redstone'], want: 30 };
const LAPIS: OreWant = { family: 'lapis', ores: 'lapis_ore,deepslate_lapis_ore', items: ['lapis_lazuli'], want: 5 };

test.serial('one trip, several ores: the want met moves on while 3 min are left; a slice with none of it marks that family dry and moves on; the budget ends the trip', async (t) => {
  setMineLookMs(0);
  // seven minutes at the ore, from sunrise (the day would allow 7.2): iron in two rounds, then gold, none of it, then
  // redstone; the budget is spent before lapis
  const m = mineBot(KIT, [{ add: { raw_iron: 12 }, ms: 2 * MIN }, { add: { raw_iron: 8 }, ms: MIN }, { ms: MIN }, { add: { redstone: 9 }, ms: 3 * MIN }]);
  const r = await oreTrip(m.ctx, { wants: [IRON, GOLD, REDSTONE, LAPIS], budgetMs: 7 * MIN, now: () => m.clock.now });
  t.deepEqual(r, { gain: 29, text: '+20 raw_iron, +9 redstone; dry: gold' });
  // the second round asks for what it carries of the drop and the rest of the want: it stops when the want is met
  t.deepEqual(m.asked, ['iron_ore to 20 in 180s', 'iron_ore to 20 in 180s', 'gold_ore to 10 in 180s', 'redstone_ore to 30 in 180s']);
  t.deepEqual(m.gains, [12, 8, 9], 'told round by round');
  t.deepEqual(workOf(m.world).dry, { 'deep:gold': { n: 1, at: NOW + 4 * MIN } }, 'gold is marked as the round that found none ended');
  t.deepEqual(m.world.zones?.mine, [{ x: 0, y: 64, z: -56 }]);

  // another ore only with a whole round's time left: iron met with two minutes to go, and no gold begun
  const short = mineBot(KIT, [{ add: { raw_iron: 20 }, ms: 5 * MIN }]);
  t.deepEqual(await oreTrip(short.ctx, { wants: [IRON, GOLD], budgetMs: 7 * MIN, now: () => short.clock.now }), { gain: 20, text: '+20 raw_iron' });
  t.deepEqual(short.asked, ['iron_ore to 20 in 180s']);
  t.deepEqual(workOf(short.world).dry, {});

  // the budget: rounds of three minutes, then what is left of it, then up
  const long = mineBot(KIT, [{ add: { raw_iron: 10 } }, { add: { raw_iron: 10 } }, { add: { raw_iron: 10 } }, { add: { raw_iron: 10 } }]);
  t.deepEqual(await oreTrip(long.ctx, { wants: [{ ...IRON, want: 100 }], budgetMs: 7 * MIN, now: () => long.clock.now }), { gain: 30, text: '+30 raw_iron' });
  t.deepEqual(long.asked, ['iron_ore to 100 in 180s', 'iron_ore to 100 in 180s', 'iron_ore to 100 in 60s']);

  // and the day's clock, whatever the budget said: from time 4000 there are 230 s before the walk up must start
  const late = mineBot(KIT, [{ add: { raw_iron: 10 } }, { add: { raw_iron: 10 } }], { tod: 4000 });
  t.deepEqual(await oreTrip(late.ctx, { wants: [{ ...IRON, want: 100 }], budgetMs: 7 * MIN, now: () => late.clock.now }), { gain: 20, text: '+20 raw_iron' });
  t.deepEqual(late.asked, ['iron_ore to 100 in 180s', 'iron_ore to 100 in 50s']);
});

test.serial('oreTrip comes up early hurt or with no ready food left, and never digs by someone else\'s build', async (t) => {
  setMineLookMs(0);
  // (a trip that never mined is untried: it says nothing of the place, nor counts as one that ended well)
  const hurt = mineBot(KIT, [{ add: { raw_iron: 4 } }], { health: 8 });
  t.deepEqual(await oreTrip(hurt.ctx, { wants: [IRON], budgetMs: 7 * MIN, now: () => hurt.clock.now }), { gain: 0, text: 'nothing gained; health 8: up early', untried: true });
  t.deepEqual(hurt.asked, []);
  // the bread eaten on the way down
  const hungry = mineBot(KIT.filter(i => i.name !== 'bread'), [{ add: { raw_iron: 4 } }]);
  t.deepEqual(await oreTrip(hungry.ctx, { wants: [IRON], budgetMs: 7 * MIN, now: () => hungry.clock.now }), { gain: 0, text: 'nothing gained; no ready food left: up early', untried: true });
  t.deepEqual(workOf(hungry.world).dry, {}, 'not a dry place: it never mined');
  // a build seen from the mine start: no digging, another side next time
  const near = mineBot(KIT, []);
  const build = { x1: -10, y1: 60, z1: -70, x2: 10, y2: 80, z2: -60, surface: true };
  let looks = 0;
  (near.ctx as { call: GoalContext['call'] }).call = (async (method: string) => {
    if (method !== 'foreign.zones') return {};
    // nothing seen from home; the build in sight from the mine start
    return { zones: looks++ ? [build] : [] };
  }) as GoalContext['call'];
  t.deepEqual(await oreTrip(near.ctx, { wants: [IRON], budgetMs: 7 * MIN }), { gain: 0, text: "someone else's build 4 blocks from the mine site: the next trip sets out from another side", untried: true });
  t.deepEqual(near.asked, []);
  t.is(near.world.zones?.mine, undefined);
});

test.serial('oreTrip with no pickaxe left, or a round the mine tool cannot do, comes up and marks no vein dry', async (t) => {
  setMineLookMs(0);
  // the pickaxe wears out in the first round: the trip comes up with what it has, and gold is not marked dry for it
  const KIT1 = KIT.filter(i => !i.name.endsWith('_pickaxe')).concat(item(3, 'iron_pickaxe'));
  const worn = mineBot(KIT1, [{ add: { raw_iron: 6 }, take: ['iron_pickaxe'] }]);
  t.deepEqual(await oreTrip(worn.ctx, { wants: [IRON, GOLD], budgetMs: 7 * MIN, now: () => worn.clock.now }), { gain: 6, text: '+6 raw_iron; no pickaxe left: up early' });
  t.deepEqual(worn.asked, ['iron_ore to 20 in 180s']);
  t.deepEqual(workOf(worn.world).dry, {});
  // none from the start: it never mines, and the trip says nothing of the place
  const none = mineBot(KIT.filter(i => !i.name.endsWith('_pickaxe')), []);
  t.deepEqual(await oreTrip(none.ctx, { wants: [IRON], budgetMs: 7 * MIN }), { gain: 0, text: 'nothing gained; no pickaxe left: up early', untried: true });
  t.deepEqual(none.asked, []);
  // a pickaxe too poor for the ore: the tool cannot do the round, which says nothing of the diamonds; on to the iron,
  // which this pickaxe can mine
  const DIAMOND: OreWant = { family: 'diamond', ores: 'diamond_ore,deepslate_diamond_ore', items: ['diamond'], want: 5 };
  const NEEDS = 'Mining diamond_ore needs an iron pickaxe or better. Craft one first.';
  const poor = mineBot(KIT, [{ fail: NEEDS }, { add: { raw_iron: 20 } }]);
  t.deepEqual(await oreTrip(poor.ctx, { wants: [DIAMOND, IRON], budgetMs: 7 * MIN, now: () => poor.clock.now }),
    { gain: 20, text: `+20 raw_iron; the mine tool could not mine diamond (${NEEDS})` });
  t.deepEqual(poor.asked, ['diamond_ore to 5 in 180s', 'iron_ore to 20 in 180s']);
  t.deepEqual(workOf(poor.world).dry, {});
  // every ore refused: it never mined, and the trip says nothing of the place, nor counts as one that ended well
  const stone = mineBot(KIT, [{ fail: NEEDS }, { fail: 'Mining gold_ore needs an iron pickaxe or better. Craft one first.' }]);
  t.deepEqual(await oreTrip(stone.ctx, { wants: [DIAMOND, GOLD], budgetMs: 7 * MIN, now: () => stone.clock.now }),
    { gain: 0, text: `nothing gained; the mine tool could not mine diamond, gold (${NEEDS})`, untried: true });
  t.deepEqual(stone.asked, ['diamond_ore to 5 in 180s', 'gold_ore to 10 in 180s']);
  t.deepEqual(workOf(stone.world).dry, {});
});

test.serial('the deep rung with a pickaxe too poor for its first ore: no mark on it, the iron after it mined, and only a trip that mined counts', async (t) => {
  setMineLookMs(0);
  const rung = LADDER.find(task => task.name === 'deep')!;
  const NEEDS = 'Mining diamond_ore needs an iron pickaxe or better. Craft one first.';
  // nothing stored: diamonds first, then iron; the tool refuses the diamonds, the iron comes in one round
  const m = mineBot(KIT, [{ fail: NEEDS }, { add: { raw_iron: 96 } }]);
  const [goal] = workGoals(() => undefined, [rung], () => m.clock.now);
  t.is(goal.wants(m.ctx.s, m.world), 'diamond: under ground');
  t.is(await goal.run(m.ctx), `[diamond] +96 raw_iron; dry: gold; the mine tool could not mine diamond (${NEEDS}); back home`);
  t.false('deep:diamond' in workOf(m.world).dry, 'the diamonds are not dry: this pickaxe cannot mine them');
  t.deepEqual(workOf(m.world).next, { deep: 0 });
  t.is(workOf(m.world).deep.clean, 1);
  // every ore refused: no mark, no trip that ended well, and the brain is to hold the rung back (a failure)
  const all = mineBot(KIT, Array.from({ length: 5 }, () => ({ fail: NEEDS })));
  const [again] = workGoals(() => undefined, [rung], () => all.clock.now);
  await t.throwsAsync(again.run(all.ctx), { message: /^\[diamond\] nothing gained; the mine tool could not mine diamond, iron, gold, redstone, lapis \(.*; back home$/ });
  t.deepEqual(workOf(all.world).dry, {});
  t.deepEqual(workOf(all.world).next, {});
  t.deepEqual(workOf(all.world).deep, { starts: [NOW], clean: 0, deaths: [] });
});

test.serial('oreTrip judges no round by an inventory look that failed: the next look tells what both brought', async (t) => {
  setMineLookMs(0);
  // the look after the first round fails; the second round's look shows the 12 of the first and the 8 of the second
  const m = mineBot(KIT, [{ add: { raw_iron: 12 }, blind: true }, { add: { raw_iron: 8 } }]);
  t.deepEqual(await oreTrip(m.ctx, { wants: [IRON], budgetMs: 10 * MIN, now: () => m.clock.now }), { gain: 20, text: '+20 raw_iron' });
  t.deepEqual(m.asked, ['iron_ore to 20 in 180s', 'iron_ore to 20 in 180s']);
  t.deepEqual(m.gains, [20]);
  t.deepEqual(workOf(m.world).dry, {}, 'the round before the failed look is not a dry one');
  // two looks in a row fail: up, rather than mine blind; and with nothing seen, the trip says nothing of the place
  const lost = mineBot(KIT, [{ add: { raw_iron: 2 }, blind: true }, { add: { raw_iron: 2 }, blind: true }, { add: { raw_iron: 2 } }]);
  t.deepEqual(await oreTrip(lost.ctx, { wants: [IRON], budgetMs: 10 * MIN, now: () => lost.clock.now }),
    { gain: 0, text: 'nothing gained (Mined for 180s: raw_iron x2.); the inventory could not be read: up early', untried: true });
  t.is(lost.asked.length, 2);
  t.deepEqual(workOf(lost.world).dry, {});
});

test.serial('oreTrip throws nothing away on the surface: not before it has mined, and not where a walk out stopped short', async (t) => {
  setMineLookMs(0);
  // it sets out carrying three stacks of dirt (a build's leftovers): at the mine start, on the surface, they stay; once
  // it has been down a round, two of them go
  const dirt = [...KIT, item(4, 'dirt', 64), item(5, 'dirt', 64), item(6, 'dirt', 64)];
  const m = mineBot(dirt, [{ add: { raw_iron: 12 } }, { add: { raw_iron: 8 } }]);
  t.deepEqual(await oreTrip(m.ctx, { wants: [IRON], budgetMs: 10 * MIN, now: () => m.clock.now }), { gain: 20, text: '+20 raw_iron; dropped 128 dirt down there' });
  t.deepEqual(m.asked, ['iron_ore to 20 in 180s', 'drop 128 dirt', 'iron_ore to 20 in 180s']);
  // the walk to the mine start stopped short (the storage house door): nothing dropped or dug there, nothing marked,
  // and the start kept for next time
  const held = mineBot(dirt, [{ add: { raw_iron: 12 } }], { walk: false });
  t.deepEqual(await oreTrip(held.ctx, { wants: [IRON], budgetMs: 10 * MIN }), { gain: 0, text: 'could not reach the mine start (0, -56)', untried: true });
  t.deepEqual(held.asked, []);
  t.deepEqual(held.world.zones?.mine, [{ x: 0, y: 64, z: -56 }]);
  t.deepEqual(workOf(held.world).dry, {});
  // a yard that reaches 64 north of home: the north side has no room inside the leash for the mine's chase, and the
  // trip sets out east, 40 beyond the yard (56 out)
  const long = mineBot(KIT, [], { walk: false, world: { ...home(), yard: { x1: -16, z1: -64, x2: 16, z2: 16, y: 63 } } });
  t.like(await oreTrip(long.ctx, { wants: [IRON], budgetMs: 10 * MIN }), { text: 'could not reach the mine start (56, 0)' });
  // a leash that leaves no side 30 beyond the yard: it says so, and not that someone's build is by every side
  const tight = mineBot(KIT, [], { world: { ...home(), leash: 40, yard: { x1: -16, z1: -64, x2: 16, z2: 16, y: 63 } } });
  await t.throwsAsync(oreTrip(tight.ctx, { wants: [IRON], budgetMs: 10 * MIN }), { message: 'no side of the yard has room for a mine start 30 beyond it and 30 inside the leash (40)' });
  t.deepEqual(tight.asked, []);
});

test.serial('oreTrip comes up when a round has taken it past the leash', async (t) => {
  setMineLookMs(0);
  // down at the start, 56 out: the first round follows the iron north to 110 out, past the leash of 96: up, with what
  // it has, and no second round
  const m = mineBot(KIT, [{ add: { raw_iron: 4 }, y: 20, z: -110 }, { add: { raw_iron: 8 } }], { y: 64 });
  t.is(m.world.leash, 96);
  t.deepEqual(await oreTrip(m.ctx, { wants: [IRON], budgetMs: 10 * MIN, now: () => m.clock.now }), { gain: 4, text: '+4 raw_iron; past the leash: up early', upAt: { x: 0, y: 64, z: -56 } });
  t.deepEqual(m.asked, ['iron_ore to 20 in 180s']);
  // within the leash it goes on (95 out)
  const ok = mineBot(KIT, [{ add: { raw_iron: 4 }, y: 20, z: -95 }, { add: { raw_iron: 16 } }], { y: 64 });
  t.like(await oreTrip(ok.ctx, { wants: [IRON], budgetMs: 10 * MIN, now: () => ok.clock.now }), { gain: 20 });
  t.is(ok.asked.length, 2);
});

test.serial('oreTrip comes up when a round has taken it under the yard: the home zone\'s column, any depth', async (t) => {
  setMineLookMs(0);
  // home (0, 64, 0) with no yard known: the bridge's zone is the circle of 24 round home, and its rule holds 6 past it.
  // Down at the start, 56 out: the first round follows the gold to 20 from home, 56 under the ground, where Baritone
  // may break nothing (live: (-534, 8, 2182), an hour). The trip ends there, and no second round is tried
  const m = mineBot(KIT, [{ add: { raw_gold: 4 }, y: 8, z: -20 }, { add: { raw_gold: 8 } }], { y: 64 });
  t.deepEqual(await oreTrip(m.ctx, { wants: [GOLD], budgetMs: 10 * MIN, now: () => m.clock.now }), { gain: 4, text: '+4 raw_gold; under the yard: out to the side first' });
  t.deepEqual(m.asked, ['gold_ore to 10 in 180s']);
  // 31 out (past the margin) it goes on: Baritone may dig there
  const out = mineBot(KIT, [{ add: { raw_gold: 4 }, y: 8, z: -31 }, { add: { raw_gold: 6 } }], { y: 64 });
  t.like(await oreTrip(out.ctx, { wants: [GOLD], budgetMs: 10 * MIN, now: () => out.clock.now }), { gain: 10 });
  t.is(out.asked.length, 2);
  // and so it does in the column within 8 of the ground (a round that ends up by the start's shaft top is no trap)
  const top = mineBot(KIT, [{ add: { raw_gold: 4 }, y: 57, z: -20 }, { add: { raw_gold: 6 } }], { y: 64 });
  t.like(await oreTrip(top.ctx, { wants: [GOLD], budgetMs: 10 * MIN, now: () => top.clock.now }), { gain: 10 });
  // the yard's rectangle, once it is known: under its far end, 40 from home, is under it as well
  const yard = { ...home(), yard: { x1: -16, z1: -60, x2: 16, z2: 16, y: 63 } };
  const far = mineBot(KIT, [{ add: { raw_gold: 4 }, y: 8, z: -60 }, { add: { raw_gold: 6 } }], { y: 64, world: yard });
  t.like(await oreTrip(far.ctx, { wants: [GOLD], budgetMs: 10 * MIN, now: () => far.clock.now }), { gain: 4, text: '+4 raw_gold; under the yard: out to the side first' });
});

test.serial('oreTrip whose last round took it under the yard says so as well: none of it found there, or the want met', async (t) => {
  setMineLookMs(0);
  // the last round follows the gold to 20 from home, 56 down, and finds none: the vein is marked as ever (from this
  // start it is out of reach), and the trip ends saying where it is, which no round's look caught
  const dry = mineBot(KIT, [{ add: { raw_gold: 4 } }, { y: 8, z: -20 }], { y: 64 });
  t.deepEqual(await oreTrip(dry.ctx, { wants: [GOLD], budgetMs: 10 * MIN, now: () => dry.clock.now }), { gain: 4, text: '+4 raw_gold; dry: gold; under the yard: out to the side first' });
  // the round that meets the want, down there
  const met = mineBot(KIT, [{ add: { raw_gold: 10 }, y: 8, z: -20 }], { y: 64 });
  t.deepEqual(await oreTrip(met.ctx, { wants: [GOLD], budgetMs: 10 * MIN, now: () => met.clock.now }), { gain: 10, text: '+10 raw_gold; under the yard: out to the side first' });
  // and the old deep trip goal then does not ask for the walk home, which stops in a second there
  const w = home();
  const m = mineBot([...KIT, item(5, 'diamond', 5)], [{ add: { diamond: 26 }, y: 8, z: -20 }], { tod: 1000, world: w, y: 64 });
  t.is(await deepTrip.run(m.ctx), '+26 diamond; under the yard: out to the side first');
  t.deepEqual(m.asked, ['diamond_ore to 31 in 180s']);
});

test.serial('the old deep trip goal under the yard does not try the walk home: it stops in a second there, and the trip stays open', async (t) => {
  setMineLookMs(0);
  const carried = [...KIT, item(5, 'diamond', 5)];
  const w = home();
  const m = mineBot(carried, [{ add: { diamond: 2 }, y: 8, z: -20 }, { add: { diamond: 2 } }], { tod: 1000, world: w, y: 64 });
  t.is(await deepTrip.run(m.ctx), '+2 diamond; under the yard: out to the side first');
  t.deepEqual(m.asked, ['diamond_ore to 31 in 180s']);
  // not seen home: a death down there is still the trip's (workTick closes it once the bot is home)
  t.not(workOf(w).deep.away, undefined);
});

test.serial('oreTrip that never gets below the mine start throws nothing away up there, and is no trip down', async (t) => {
  setMineLookMs(0);
  // Baritone finds no way to any of the ore: "nothing gained" in seconds, and the bot stands where it was, on the
  // surface at the mine start. Each ore is marked (from here the miner finds none), but nothing is thrown away there
  const dirt = [...KIT, item(4, 'dirt', 64), item(5, 'dirt', 64), item(6, 'dirt', 64)];
  const up = mineBot(dirt, [{ ms: 8000 }, { ms: 8000 }], { y: 64 });
  t.deepEqual(await oreTrip(up.ctx, { wants: [GOLD, IRON], budgetMs: 7 * MIN, now: () => up.clock.now }),
    { gain: 0, text: 'nothing gained (Mined for 8s: nothing gained.); dry: gold, iron; never got below the mine start', untried: true });
  t.deepEqual(up.asked, ['gold_ore to 10 in 180s', 'iron_ore to 20 in 180s']);
  t.deepEqual(Object.keys(workOf(up.world).dry), ['deep:gold', 'deep:iron']);
  // down 50 in its first round, with none of it: the throwing away is down there, and the trip went down
  const down = mineBot(dirt, [{ y: 14 }, { add: { raw_iron: 20 } }], { y: 64 });
  t.deepEqual(await oreTrip(down.ctx, { wants: [GOLD, IRON], budgetMs: 7 * MIN, now: () => down.clock.now }),
    { gain: 20, text: '+20 raw_iron; dry: gold; dropped 128 dirt down there', upAt: { x: 0, y: 64, z: -56 } });
  t.deepEqual(down.asked, ['gold_ore to 10 in 180s', 'drop 128 dirt', 'iron_ore to 20 in 180s']);
  // its one round went down and found none: seen below as it comes up, a trip down all the same
  const last = mineBot(KIT, [{ y: 10 }], { y: 64 });
  t.deepEqual(await oreTrip(last.ctx, { wants: [IRON], budgetMs: 7 * MIN, now: () => last.clock.now }),
    { gain: 0, text: 'nothing gained (Mined for 180s: nothing gained.); dry: iron', upAt: { x: 0, y: 64, z: -56 } });

  // through the deep rung: five ores tried in 40 s from the surface is no trip that ended well, and a failure the
  // brain holds the rung back for (the 30 s release of a dry mark would send it straight out again)
  const rung = LADDER.find(task => task.name === 'deep')!;
  const all = mineBot(KIT, Array.from({ length: 5 }, () => ({ ms: 8000 })), { y: 64 });
  const [goal] = workGoals(() => undefined, [rung], () => all.clock.now);
  await t.throwsAsync(goal.run(all.ctx), { message: '[diamond] nothing gained (Mined for 8s: nothing gained.); dry: diamond, iron, gold, redstone, lapis; never got below the mine start; back home' });
  t.deepEqual(workOf(all.world).deep, { starts: [NOW], clean: 0, deaths: [] });
  t.deepEqual(workOf(all.world).next, {});
  t.deepEqual(all.asked.at(-1), 'go-home');
});

test.serial('oreTrip ends for home at 36/36 after dropping glut, and never drops ore, tools or food', async (t) => {
  setMineLookMs(0);
  // the kit, ore, food, a stack of cobblestone for the climb, and the tuff the project carries: 30 slots
  const project = (): WorldMemory => ({ ...home(), progress: { done: [], journal: [], carry: ['tuff'] } });
  const items = [...KIT, item(4, 'diamond_pickaxe'), item(5, 'diamond', 3), item(6, 'raw_iron', 10), item(7, 'apple', 30), item(8, 'tuff', 64), item(9, 'tuff', 36),
    ...Array.from({ length: 20 }, (_, i) => item(10 + i, ['raw_gold', 'redstone', 'lapis_lazuli', 'emerald', 'flint'][i % 5], 5 + i))];
  t.is(items.filter(i => i.slot < 36).length, 30);
  // the first round brings iron and fills the pockets with deepslate and gravel; the second iron and what no rule throws away
  const m = mineBot(items, [
    { add: { raw_iron: 3, cobbled_deepslate: 128, gravel: 70, granite: 20 } },
    { add: { raw_iron: 2, amethyst_shard: 1, pointed_dripstone: 1, glow_berries: 1, bone: 1 } }
  ], { world: project() });
  t.is(m.bag.used(), 30);
  const r = await oreTrip(m.ctx, { wants: [{ ...IRON, want: 40 }], budgetMs: 7 * MIN, now: () => m.clock.now });
  t.deepEqual(m.asked, [
    'iron_ore to 50 in 180s',
    // a stack of throwaway stone is kept, cobblestone first: here that is the kit's own; and a stack of gravel
    'drop 128 cobbled_deepslate', 'drop 6 gravel', 'drop 20 granite',
    // the 13 raw iron it carries now and the 37 still wanted
    'iron_ore to 50 in 180s'
  ]);
  t.deepEqual(r, { gain: 5, text: '+5 raw_iron; dropped 128 cobbled_deepslate, 6 gravel, 20 granite down there; pockets full: up early' });
  t.is(m.bag.used(), 36);
  for (const name of ['iron_pickaxe', 'diamond_pickaxe', 'torch', 'bread', 'apple', 'diamond', 'raw_iron', 'raw_gold', 'redstone', 'emerald', 'tuff', 'cobblestone']) {
    t.true(m.bag.count(name) > 0, `${name} kept`);
  }
  t.is(m.bag.count('tuff'), 100, 'what the project carries, whatever its count');
  t.is(m.bag.count('cobblestone'), 64, 'the stack of throwaway stone for the climb');
  t.is(m.bag.count('gravel'), 64);
});

test.serial('the old deep trip goal mines its diamonds through oreTrip and counts on probation', async (t) => {
  setMineLookMs(0);
  const w = home();
  // five diamonds carried: the round asks for those and the 26 still wanted (it used to ask for 8, carried ones included)
  const carried = [...KIT, item(5, 'diamond', 5)];
  const s = at(1000, carried);
  t.is(deepTrip.wants(s, w), '26 diamond(s) wanted: a deep trip');
  const run = async (now: number, add: Record<string, number>) => {
    const m = mineBot(carried, [{ add, ms: 10 * MIN }], { tod: 1000, world: w });
    const ctx = { ...m.ctx, s: { ...at(1000, carried), now } } as GoalContext;
    return { text: await deepTrip.run(ctx), m };
  };
  // (each round here takes the rest of the morning: the trip comes up with what it got)
  const first = await run(NOW, { diamond: 4 });
  t.is(first.text, '+4 diamond; back home');
  t.deepEqual(first.m.asked, ['diamond_ore to 31 in 180s', 'go-home']);
  t.is(w.lastDone?.deep, NOW);
  t.deepEqual(workOf(w).deep, { starts: [NOW], clean: 1, deaths: [] }, 'a deep trip like the rung\'s, ended well');

  // a second, 21 min on: two this hour, and the trips are few until three have ended well
  await run(NOW + 21 * MIN, { diamond: 2 });
  t.deepEqual(workOf(w).deep, { starts: [NOW, NOW + 21 * MIN], clean: 2, deaths: [] });
  const later = at(1000, carried, { now: NOW + 42 * MIN });
  t.deepEqual(deepTrip.declines!(later, w), { cause: 'hold', text: 'deep on probation: 2 trips this hour, next at 15:00', until: NOW + 60 * MIN });
  t.is(deepTrip.wants(later, w), null);
  t.is(deepTrip.wants({ ...later, now: NOW + 61 * MIN }, w), '26 diamond(s) wanted: a deep trip');

  // a death on the way: the probation starts again, and the death is booked as one on a deep trip
  const died = { at: { x: 0, z: -80 }, time: NOW + 61 * MIN + 1000 };
  workGoals(() => died, []);
  try {
    const m = mineBot(carried, [{ add: { diamond: 1 }, ms: 10 * MIN }], { tod: 1000, world: w });
    const ctx = { ...m.ctx, s: { ...at(1000, carried), now: NOW + 61 * MIN } } as GoalContext;
    await deepTrip.run(ctx);
  } finally {
    workGoals(() => undefined, []);
  }
  t.deepEqual(workOf(w).deep, { starts: [NOW, NOW + 21 * MIN, NOW + 61 * MIN], clean: 0, deaths: [died.time] });
  // a fruitless round marks the diamonds dry for the deep rung too
  const none = mineBot(carried, [{}], { tod: 1000, world: home() });
  t.is(await deepTrip.run(none.ctx), 'nothing gained (Mined for 180s: nothing gained.); dry: diamond; back home');
  t.deepEqual(Object.keys(workOf(none.world).dry), ['deep:diamond']);
  // a trip that never went down (the walk out stopped short) is today's try, but no trip that ended well
  const short = mineBot(carried, [], { tod: 1000, world: home(), walk: false });
  t.is(await deepTrip.run(short.ctx), 'could not reach the mine start (0, -56); back home');
  t.deepEqual(workOf(short.world).deep, { starts: [NOW], clean: 0, deaths: [] });
  t.is(short.world.lastDone?.deep, NOW);
});

test.serial('the old deep trip goal comes up where it went down before it walks home, and oreTrip says where that is', async (t) => {
  setMineLookMs(0);
  // home (0, 64, 0), no yard: the bridge's zone is the circle of 24 round home and 6 past it, at any depth. The trip
  // goes down at the mine start (0, 64, -56) and its round ends 54 below it; from there Baritone's way home runs under
  // the ground into the column, where it may break nothing (live: (-530, 7, 2189), 55 under the yard)
  const carried = [...KIT, item(5, 'diamond', 5)];
  // (the round takes the rest of the morning's budget and ends at time of day 9400, by day: down there at night the
  // walk home does not climb, homeward.ts)
  const m = mineBot(carried, [{ add: { diamond: 4 }, ms: 7 * MIN, y: 10 }], { tod: 1000, world: home(), y: 64 });
  const walks: string[] = [];
  const ctx = {
    ...m.ctx,
    call: (async (method: string, p: Record<string, unknown> = {}) => {
      // Baritone's walk to a block: there, the way it came
      if (method === 'goto' && !p.xz) { walks.push(`goto ${p.x},${p.y},${p.z}`); m.level.y = Number(p.y); m.level.z = Number(p.z); return { arrived: true }; }
      return m.ctx.call(method, p);
    }) as GoalContext['call'],
    act: async (tool: string, a?: Record<string, unknown>) => {
      if (tool !== 'go-home') return m.ctx.act(tool, a);
      m.asked.push(`go-home from y ${m.level.y}`);
      if ((m.level.y ?? 64) < 56) { m.level.y = 10; m.level.z = -20; return { ok: false, text: 'Stopped 20 blocks from home after 1s' }; }
      m.level.y = 64; m.level.z = 0;
      return { ok: true, text: 'Home' };
    }
  } as GoalContext;
  t.is(await deepTrip.run(ctx), '+4 diamond; back home');
  t.deepEqual(walks, ['goto 0,64,-56']);
  t.deepEqual(m.asked, ['diamond_ore to 31 in 180s', 'go-home from y 64']);
  t.like(workOf(m.world).deep, { clean: 1 });
  // oreTrip itself: the block it stood on at the start, for a trip that went down and is not under the yard
  const r = mineBot(KIT, [{ add: { raw_iron: 20 }, y: 10 }], { y: 64 });
  t.deepEqual(await oreTrip(r.ctx, { wants: [IRON], budgetMs: 7 * MIN, now: () => r.clock.now }), { gain: 20, text: '+20 raw_iron', upAt: { x: 0, y: 64, z: -56 } });
});

test.serial('the old deep trip cut short on its walk home: a death on the way is one on the trip, and once home it is over', async (t) => {
  setMineLookMs(0);
  const carried = [...KIT, item(5, 'diamond', 5)];
  /** a trip that mines its round and comes up; survival (retreat at health 8) cuts the walk home */
  const cut = async (w: WorldMemory) => {
    const m = mineBot(carried, [{ add: { diamond: 4 }, ms: 10 * MIN }], { tod: 1000, world: w });
    const ac = new AbortController();
    const ctx = {
      ...m.ctx, signal: ac.signal,
      act: async (tool: string, a?: Record<string, unknown>) => {
        if (tool !== 'go-home') return m.ctx.act(tool, a);
        ac.abort();
        throw new Error('aborted');
      }
    } as GoalContext;
    await t.throwsAsync(deepTrip.run(ctx), { message: 'aborted' });
  };
  const w = home();
  await cut(w);
  t.like(workOf(w).deep, { starts: [NOW], clean: 1, deaths: [] });
  t.not(workOf(w).deep.away, undefined);
  // the bot dies on the way, 16 out of home after the respawn by the time the queue looks
  const died = { at: { x: 0, z: -80 }, time: NOW + MIN };
  workTick(at(1000, [], { now: NOW + MIN + 5000, position: { x: 0, y: 64, z: -16 }, distHome: 16 }), w, () => died);
  t.like(workOf(w).deep, { clean: 0, deaths: [died.time] });
  t.is(workOf(w).deep.away, undefined);
  // the same cut, but home alive first: a death after that is none of the trip's
  const calm = home();
  await cut(calm);
  workTick(at(1000, [], { now: NOW + MIN }), calm, () => undefined);
  workTick(at(1000, [], { now: NOW + 2 * MIN, position: { x: 0, y: 64, z: -40 }, distHome: 40 }), calm, () => ({ at: { x: 0, z: -40 }, time: NOW + 2 * MIN }));
  t.like(workOf(calm).deep, { clean: 1, deaths: [] });
});

test.serial('the deep rung asks for the kit, the room rule for the slots: 30 used with the kit ready -> work: deep wants and makes room first', async (t) => {
  setMineLookMs(0);
  const rung = LADDER.find(task => task.name === 'deep')!;
  const [goal] = workGoals(() => undefined, [rung], () => NOW);
  const west = { position: { x: -60, y: 64, z: 0 }, distHome: 60 };
  const grown = (): WorldMemory => ({ ...home(), yard: YARD, zones: { mine: [{ x: -40, y: 64, z: 0 }] } });
  const s = at(1000, thirty(7), west);
  // nothing stored: every ore as far below its target, diamonds first
  t.is(goal.wants(s, grown()), 'diamond: under ground');
  // nothing to put away: the room rule says so
  t.deepEqual(goal.declines!(at(1000, thirty(0), west), grown()), { cause: 'pockets', text: '30/36 slots, nothing to put away (deep needs 10 free)' });
  // the kit is the rung's own question, after the room: without torches it says so
  t.deepEqual(goal.declines!(at(1000, thirty(7).filter(i => i.name !== 'torch'), west), grown()),
    { cause: 'kit', text: '0/16 torches (deep needs the deep kit)' });

  // the run: home to the chests on foot, the logs into the chest, and only then out, from a start outside the yard
  const w = grown();
  const out = yardBot(s, w);
  await t.throwsAsync(goal.run(out.ctx), { message: 'no path' });
  t.deepEqual(out.did, ['on foot only to (0, 0)', 'store 448 oak_log', 'foreign.zones', 'out to (0, -64)']);
  t.is(out.used(), 23);
  t.deepEqual(workOf(w).deep.starts, [NOW], 'it set out');
  t.deepEqual(workOf(w).dry, {}, 'a walk that failed has learnt nothing of the place');
});
