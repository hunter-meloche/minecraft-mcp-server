import test from 'ava';
import { farm, kit, lightArea, lights, smelt, sortStorage, stash, stashKeep, stock, outsideBy, stockShort, toTheWoods, firstChest } from '../../src/client/brain/chores.js';
import { stashPlan } from '../../src/client/brain/kit.js';
import { food, makeRod, readyFoodPoints } from '../../src/client/brain/food.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import type { ClientRuntime, InventoryItem } from '../../src/client/tools.js';
import { deepTrip } from '../../src/client/brain/deep.js';
import { billCarry, billCarryCap } from '../../src/client/brain/project.js';
import { enchantRoom } from '../../src/client/brain/blueprints.js';
import { tidyGoal } from '../../src/client/brain/tidy.js';
import { repairGoal } from '../../src/client/brain/repair.js';
import { signsGoal } from '../../src/client/brain/signs.js';
import { EVENING_AT } from '../../src/client/brain/work.js';

const CHEST = { x: 1, y: 64, z: 0 };
const world = (over: Partial<WorldMemory> = {}): WorldMemory => ({
  landmarks: { chests: [CHEST], farmland: [], furnace: { x: -1, y: 64, z: 0 } }, leash: 96, chestItems: { '1,64,0': {} }, ...over
});
const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
  };
};
const gear = (): InventoryItem[] => ['stone_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'stone_hoe']
  .map((name, slot): InventoryItem => ({ slot, name, count: 1, damage: 0, maxDamage: 131 }))
  .concat(['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'].map((name, i) => ({ slot: 36 + i, name, count: 1, damage: 0, maxDamage: 200 })))
  .concat([{ slot: 10, name: 'torch', count: 20 }, { slot: 11, name: 'cobblestone', count: 40 }, { slot: 12, name: 'bread', count: 5 }]);

test('stash: the casting keeps its lava and water buckets, and 5 empty ones at most (9 empties in 9 slots filled the pockets)', (t) => {
  const empties = Array.from({ length: 9 }, (_, i): InventoryItem => ({ slot: 13 + i, name: 'bucket', count: 1 }));
  const items = [...gear(), ...empties, { slot: 22, name: 'water_bucket', count: 1 }, { slot: 23, name: 'lava_bucket', count: 1 }];
  const casting = stashPlan(items, stashKeep(world({ lavaCasting: true }))).deposit;
  t.deepEqual(casting.filter(d => /bucket/.test(d.name)), [{ name: 'bucket', count: 4 }]);
  // casting off: one empty bucket stays, as before
  t.deepEqual(stashPlan(items, stashKeep(world())).deposit.filter(d => d.name === 'bucket'), [{ name: 'bucket', count: 8 }]);
});

test('stash: past the enchanting room\'s obsidian step (or with it built) the casting\'s buckets go in the chest, one kept', (t) => {
  const empties = Array.from({ length: 5 }, (_, i): InventoryItem => ({ slot: 13 + i, name: 'bucket', count: 1 }));
  const items = [...gear(), ...empties];
  const buckets = (w: WorldMemory) => stashPlan(items, stashKeep(w)).deposit.filter(d => d.name === 'bucket');
  // still casting: the obsidian step is the one in hand
  t.deepEqual(buckets(world({ lavaCasting: true, progress: { current: { id: 'enchanting', step: 0, data: {} } } as never })), []);
  // live: the table made, the room waiting on leather at step 2, five empties held the pockets at 33/36 all day
  t.deepEqual(buckets(world({ lavaCasting: true, progress: { current: { id: 'enchanting', step: 2, data: {} } } as never })), [{ name: 'bucket', count: 4 }]);
  t.deepEqual(buckets(world({ lavaCasting: true, zones: { enchanting: [{ x: 0, y: 64, z: 0 }] } })), [{ name: 'bucket', count: 4 }]);
  // the room set aside at step 2 while the band outside the grown yard's fence is cleared: still past its obsidian
  const aside = { current: { id: 'fence-clear', step: 0, data: {} }, aside: { enchanting: { step: 2, data: {} } } };
  t.deepEqual(buckets(world({ lavaCasting: true, progress: aside as never })), [{ name: 'bucket', count: 4 }]);
  // set aside at its obsidian step: casting still
  const early = { current: { id: 'fence-clear', step: 0, data: {} }, aside: { enchanting: { step: 0, data: { obsidianTurn: 1 } } } };
  t.deepEqual(buckets(world({ lavaCasting: true, progress: early as never })), []);
});

test('ready food counts cooked food and bread, not raw meat or poison', (t) => {
  t.is(readyFoodPoints(new Map([['bread', 2], ['cooked_cod', 1], ['beef', 5], ['pufferfish', 3], ['rotten_flesh', 4]])), 2 * 5 + 5);
  t.is(food.wants(snap([{ slot: 0, name: 'bread', count: 4 }]), world()), null); // 20 points: enough
  t.regex(food.wants(snap([{ slot: 0, name: 'bread', count: 1 }]), world()) ?? '', /carrying 5 food points/);
  // at night only from home
  t.is(food.wants(snap([], { activity: 'rest', distHome: 40 }), world()), null);
});

test('stash: when nearly full, or now and then with things to put away; never away from home', (t) => {
  const junk = Array.from({ length: 22 }, (_, i) => ({ slot: 13 + i, name: `oak_log`, count: 64 }));
  t.regex(stash.wants(snap([...gear(), ...junk]), world()) ?? '', /slots used/);
  t.is(stash.wants(snap([...gear(), ...junk], { distHome: 60 }), world()), null);
  t.is(stash.wants(snap(gear()), world()), null);
  t.regex(stash.wants(snap([...gear(), ...junk.slice(0, 3).map((j, i) => ({ ...j, name: ['oak_log', 'bone', 'string'][i] }))]), world()) ?? '', /3 kinds/);
  t.is(stash.wants(snap([...gear(), ...junk.slice(0, 3).map((j, i) => ({ ...j, name: ['oak_log', 'bone', 'string'][i] }))]),
    world({ lastDone: { stash: 10 * 60 * 60_000 - 60_000 } })), null); // put away a minute ago
});

test('stash: really full in the yard, it goes home to stash from the bed 16 out (it sat there at 34/36 all day)', (t) => {
  // live 2026-11-09: the bed is 16 from the home point; awake by it at 34 slots, the at-home stash never ran
  const junk = Array.from({ length: 22 }, (_, i) => ({ slot: 13 + i, name: 'wheat_seeds', count: 64 }));
  // the home's stock all there (no materials trip waits, as live: "nothing to forage for"), and the day's trip down
  // the mine made (that one waits for room too now: below)
  const today = { deep: 10 * 60 * 60_000 - 5 * 60_000 };
  const stocked = world({ chestItems: { '1,64,0': { oak_log: 64, cobblestone: 128, coal: 32, iron_ingot: 32 } }, lastDone: today });
  t.deepEqual(stockShort(snap([...gear(), ...junk], { distHome: 16 }), stocked), []);
  t.is(deepTrip.wants(snap([...gear(), ...junk], { distHome: 16 }), stocked), null);
  t.regex(stash.wants(snap([...gear(), ...junk], { distHome: 16 }), stocked) ?? '', /slots used/);
  t.is(stash.wants(snap([...gear(), ...junk], { distHome: 16, sleeping: true }), stocked), null);
  t.is(stash.wants(snap(gear(), { distHome: 16 }), stocked), null, 'not full: only from home');
  // not again and again from out there: the project's own load keeps it near 33
  const justNow = { ...stocked, lastDone: { ...today, stash: 10 * 60 * 60_000 - 2 * 60_000 } };
  t.is(stash.wants(snap([...gear(), ...junk], { distHome: 16 }), justNow), null);
  t.regex(stash.wants(snap([...gear(), ...junk]), justNow) ?? '', /slots used/, 'at home it still does');
});

test('stash: a trip down the mine waiting for its ten slots sends it home, as a materials trip does; once in 10 min where only the trip asks', (t) => {
  // the kit ready, diamonds wanted, the day young, and 31/36 slots with 22 of them seeds: the deep trip said nothing
  // at all (deepTripReady's ten free slots, a silent null) and nothing sent the stash home from the bed 16 out
  const junk = Array.from({ length: 22 }, (_, i) => ({ slot: 13 + i, name: 'wheat_seeds', count: 64 }));
  const s = snap([...gear(), ...junk], { distHome: 16 });
  const home = { '1,64,0': { oak_log: 64, cobblestone: 128, coal: 32, iron_ingot: 32 } };
  const justNow = world({ chestItems: home, lastDone: { stash: 10 * 60 * 60_000 - 2 * 60_000 } });
  t.regex(deepTrip.wants(s, justNow) ?? '', /diamond\(s\) wanted: a deep trip/, 'five slots free, and the stash can make the ten');
  t.is(stash.wants(s, justNow), '31/36 slots used', 'two minutes after the last one, from the yard');
  // what the project carries on purpose stays under the stash's own limit of 33: the trip is named as the reason
  const carry = (lastDone: Record<string, number> = {}) => world({ chestItems: home, lastDone, progress: { done: [], journal: [], carry: ['oak_planks'] } });
  const planks = snap([...gear(), ...junk.slice(0, 18).map(j => ({ ...j, name: 'oak_planks' })), ...junk.slice(18)], { distHome: 16 });
  const ago = (min: number) => 10 * 60 * 60_000 - min * 60_000;
  t.is(stash.wants(planks, carry()), '31/36 slots used, and the deep trip waits for room', 'never stashed');
  t.is(stash.wants(planks, carry({ stash: ago(11) })), '31/36 slots used, and the deep trip waits for room');
  // once in 10 min: this stash leaves the planks carried (only the trip's own run puts them away), so the trip still
  // waits after it, and every new kind picked up sent the bot home again, for as long as the trip did not get its turn
  t.is(stash.wants(planks, carry({ stash: ago(2) })), null, 'two minutes after the last one');
  t.is(stash.wants(planks, carry({ stash: ago(9) })), null);
  t.regex(deepTrip.wants(planks, carry({ stash: ago(2) })) ?? '', /a deep trip/, 'the trip waits on nobody: its own run makes the room');
  // the trip made today: the yard's own rule again
  t.is(stash.wants(planks, carry({ stash: ago(11), deep: ago(5) })), null);
  // with nothing of its own to put away the stash keeps out of it: the trip's own run makes the room (the carry goes)
  const allCarry = [...gear(), ...junk.map(j => ({ ...j, name: 'oak_planks' }))];
  t.regex(deepTrip.wants(snap(allCarry, { distHome: 16 }), carry()) ?? '', /a deep trip/);
  t.is(stash.wants(snap(allCarry, { distHome: 16 }), carry()), null);
  // asleep, or 50 out with no yard round it: nobody goes anywhere
  t.is(stash.wants(snap([...gear(), ...junk], { distHome: 16, sleeping: true }), justNow), null);
  t.is(stash.wants(snap([...gear(), ...junk], { distHome: 50, position: { x: 50, y: 64, z: 0 } }), justNow), null);
});

test('stash: in the evening it puts things in the chests but leaves the junk dump outside the fence till morning', (t) => {
  // the dump is 8 out from the fence, past IN_YARD in a grown yard: shelter called the bot back each time (a LOOP)
  const dirt = Array.from({ length: 20 }, (_, i) => ({ slot: 13 + i, name: 'dirt', count: 64 }));
  const items = [...gear(), ...dirt]; // 29 slots, all of the extra junk
  t.regex(stash.wants(snap(items), world()) ?? '', /slots used/);
  t.is(stash.wants(snap(items, { activity: 'return' }), world()), null);
  t.is(stash.wants(snap(items, { activity: 'rest' }), world()), null);
  // what goes in the chests still goes in the evening
  const logs = dirt.map(d => ({ ...d, name: 'oak_log' }));
  t.regex(stash.wants(snap([...gear(), ...logs], { activity: 'return' }), world()) ?? '', /slots used/);
});

test('stash: makes room when a build job materials trip waits on the pockets (stock sets out with 3 slots free)', (t) => {
  const seeds = [6, 7, 8, ...Array.from({ length: 22 }, (_, i) => 13 + i)].map(slot => ({ slot, name: 'wheat_seeds', count: 64 }));
  const items = [...gear(), ...seeds]; // 34 slots
  const job = { id: 5, world: 'w', structure: 'home', mode: 'repair' as const, status: 'gathering' as const, createdAt: 0, updatedAt: 0, need: { oak_log: 77 }, carry: ['oak_log'] };
  // the day's trip down the mine made: the materials trip is the only one that waits
  const lastDone = { deep: 10 * 60 * 60_000 - 5 * 60_000 };
  const w = (over: Partial<WorldMemory> = {}) => world({ buildJobs: [job], lastDone, ...over });
  // two slots free and seeds to put away: the trip asks all the same (its run makes the room first). It said nothing
  // from 33 used, and waited for a stash that had its own idea of full
  t.regex(stock.wants(snap(items), w()) ?? '', /77 oak_log/);
  // the stash is the more urgent of the two and goes first. At home at 34 the pockets-full rule fires first; either way it runs
  t.regex(stash.wants(snap(items), w()) ?? '', /a materials trip waits for room|34\/36 slots used/);
  // from the job's site too, 24 blocks out (the plain at-home stash doesn't go that far), and two minutes after the
  // last one (really full out there waits ten)
  const justNow = { ...lastDone, stash: 10 * 60 * 60_000 - 2 * 60_000 };
  t.regex(stash.wants(snap(items, { distHome: 24 }), w()) ?? '', /a materials trip waits for room|34\/36 slots used/);
  t.regex(stash.wants(snap(items, { distHome: 24 }), w({ lastDone: justNow })) ?? '', /a materials trip waits for room|34\/36 slots used/);
  // the job gone and the home's own stock all there: no trip waits, and out there the stash goes once in 10 min
  const stocked = { '1,64,0': { oak_log: 64, cobblestone: 128, coal: 32, iron_ingot: 32 } };
  t.is(stash.wants(snap(items, { distHome: 24 }), w({ lastDone: justNow, buildJobs: [], chestItems: stocked })), null);
  t.regex(stash.wants(snap(items, { distHome: 24 }), w({ buildJobs: [], chestItems: stocked })) ?? '', /34\/36 slots used/);
  t.is(stash.wants(snap(gear(), { distHome: 24 }), w()), null);
});

test('stock at 34/36 with 4 loose slots wants (its run stashes first); at 35/36 with nothing loose it declines pockets', (t) => {
  const job = { id: 5, world: 'w', structure: 'home', mode: 'repair' as const, status: 'gathering' as const, createdAt: 0, updatedAt: 0, need: { oak_log: 77 }, carry: ['oak_log'] };
  const w = world({ buildJobs: [job] });
  // one of each, under the carry cap: food the stash leaves in the pockets
  const meals = ['apple', 'cooked_porkchop', 'cooked_cod', 'cooked_salmon', 'cookie', 'melon_slice', 'dried_kelp', 'cooked_beef', 'cooked_chicken', 'carrot',
    'baked_potato', 'pumpkin_pie', 'cooked_rabbit', 'cooked_mutton', 'beetroot', 'sweet_berries', 'glow_berries', 'porkchop', 'cod', 'salmon', 'beef', 'chicken',
    'potato', 'rabbit', 'mutton', 'tropical_fish', 'honey_bottle'];
  /** `used` slots: the kit, `loose` stacks of bones (all the stash would put away), the rest food it keeps */
  const at = (used: number, loose: number): Snapshot => {
    const items = gear();
    const empty = Array.from({ length: 36 }, (_, slot) => slot).filter(slot => !items.some(i => i.slot === slot));
    for (let i = 0; i < loose; i++) items.push({ slot: empty.shift()!, name: 'bone', count: 64 });
    for (let i = 0; items.filter(x => x.slot < 36).length < used; i++) items.push({ slot: empty.shift()!, name: meals[i], count: 1 });
    return snap(items);
  };
  // the table: 3 free sets out as it stands; with fewer, what the stash could put away decides
  const cases: [number, number, 'wants' | 'pockets'][] = [
    [33, 0, 'wants'], [34, 4, 'wants'], [34, 1, 'wants'], [35, 2, 'wants'], [36, 3, 'wants'],
    [34, 0, 'pockets'], [35, 0, 'pockets'], [35, 1, 'pockets'], [36, 2, 'pockets'], [36, 0, 'pockets']
  ];
  for (const [used, loose, answer] of cases) {
    const s = at(used, loose);
    t.is(s.slotsUsed, used, `the fixture: ${used} slots`);
    const said = stock.wants(s, w);
    const why = stock.declines!(s, w);
    if (answer === 'wants') {
      t.regex(said ?? '', /77 oak_log/, `${used}/36, ${loose} loose`);
      t.is(why, null);
    } else {
      t.is(said, null, `${used}/36, ${loose} loose`);
      // slots the stash would empty, but too few, are said as that: "nothing to put away" only with none
      t.deepEqual(why, { cause: 'pockets', text: `${used}/36 slots, ${loose ? `only ${loose} more to put away` : 'nothing to put away'} (stock needs 3 free)` });
    }
  }
  // the same full pockets with the stash's own chest out of reach (50 out, no yard round the bot): said as that
  const far = { ...at(34, 4), distHome: 50, position: { x: 50, y: 64, z: 0 } };
  t.deepEqual(stock.declines!(far, w), { cause: 'pockets', text: '34/36 slots, the chests out of reach (stock needs 3 free)' });
  // asleep nothing is put away either
  t.is(stock.wants({ ...at(34, 4), sleeping: true }, w), null);
});

test('stash: a project keeps what its bill is crafted from carried, not only the bill itself', (t) => {
  // live 2026-11-09: the enchanting room took books, diamonds and obsidian out of the chests for its table and
  // shelves, the pockets went to 33, the stash put the 26 back, and round again every 15 s for an hour (51 times)
  const carry = billCarry(enchantRoom().bill, 'oak');
  for (const n of ['enchanting_table', 'bookshelf', 'book', 'paper', 'leather', 'sugar_cane', 'diamond', 'obsidian', 'oak_planks', 'oak_log']) t.true(carry.includes(n), n);
  t.false(carry.includes('planks')); // the recipes' any-wood planks are the project's wood
  for (const n of ['iron_nugget', 'iron_ingot', 'raw_iron', 'torch', 'coal', 'stick']) t.true(billCarry({ lantern: 1 }).includes(n), n); // smelted from too
  const fill = Array.from({ length: 22 }, (_, i) => ({ slot: 13 + i, name: 'oak_planks', count: 64 }));
  const items = [...gear(), ...fill, { slot: 6, name: 'book', count: 26 }, { slot: 7, name: 'obsidian', count: 4 }, { slot: 8, name: 'diamond', count: 2 }];
  t.is(snap(items).slotsUsed, 34);
  t.is(stash.wants(snap(items), world({ progress: { carry } } as Partial<WorldMemory>)), null);
  // the old carry (the bill's own items and the wood) let the stash take the ingredients back
  const old = [...Object.keys(enchantRoom().bill), 'oak_log', 'oak_planks', 'stick'];
  t.regex(stash.wants(snap(items), world({ progress: { carry: old } } as Partial<WorldMemory>)) ?? '', /34\/36 slots used/);
});

test('stash: a project keeps only the stacks of its wood its bill could still use (208 logs held the pockets at 31)', (t) => {
  // live 2026-11-09: the enchanting room kept every oak log and plank carried, 4 stacks of logs and 3 of planks, the
  // pockets sat at 31/36, the stock trip for its sugar cane never set out, and the stash cut the farm short each round
  const bill = enchantRoom().bill;
  const carried = (o: Record<string, number>) => new Map(Object.entries(o));
  const bare = billCarryCap(bill, carried({}), 'oak');
  t.is(bare.oak_log, 128); // 16 logs and ~225 planks (walls, shelves, door) from scratch: 73 logs, in whole stacks
  t.true(bare.oak_planks >= 225);
  // planks in hand need no logs: 128 planks carried leave 16 + 25 logs, one stack
  t.is(billCarryCap(bill, carried({ oak_planks: 128 }), 'oak').oak_log, 64);
  t.is(billCarryCap({ birch_planks: 10 }, carried({}), 'birch').birch_log, 64); // never under a stack
  const items: InventoryItem[] = [
    ...gear(),
    ...[13, 14, 15].map(slot => ({ slot, name: 'oak_log', count: 64 })), { slot: 16, name: 'oak_log', count: 16 },
    ...[17, 18].map(slot => ({ slot, name: 'oak_planks', count: 64 })),
    { slot: 19, name: 'sugar_cane', count: 20 }, { slot: 20, name: 'leather', count: 7 }
  ];
  const carry = [...billCarry(bill, 'oak'), 'stick'];
  const s = snap(items);
  const progress = { done: [], journal: [], carry, carryCap: billCarryCap(bill, s.counts, 'oak') };
  const plan = stashPlan(items, stashKeep(world({ progress })));
  t.deepEqual(plan.deposit.filter(d => /oak/.test(d.name)), [{ name: 'oak_log', count: 208 - 64 }]);
  t.false(plan.deposit.some(d => ['sugar_cane', 'leather'].includes(d.name))); // what the trips gather for it stays
  // with no cap (the old memory), everything stayed
  t.false(stashPlan(items, stashKeep(world({ progress: { done: [], journal: [], carry } }))).deposit.some(d => d.name === 'oak_log'));
  // a build job carrying the same wood keeps all of its load
  const job = { id: 5, world: 'w', structure: 'barn', mode: 'apply' as const, status: 'working' as const, phase: 'building' as const, createdAt: 0, updatedAt: 0, carry: ['oak_log'] };
  t.false(stashPlan(items, stashKeep(world({ progress, buildJobs: [job] }))).deposit.some(d => d.name === 'oak_log'));
});

test('smelt: raw ore and fuel at home', (t) => {
  t.regex(smelt.wants(snap([{ slot: 0, name: 'raw_iron', count: 5 }, { slot: 1, name: 'coal', count: 1 }]), world()) ?? '', /5 raw_iron/);
  // no fuel: nothing to smelt, but a furnace not looked at in half an hour gets its finished smelting taken out
  t.regex(smelt.wants(snap([{ slot: 0, name: 'raw_iron', count: 5 }]), world()) ?? '', /check the furnace/);
  const s = snap([{ slot: 0, name: 'raw_iron', count: 5 }]);
  t.is(smelt.wants(s, world({ lastDone: { furnace: s.now - 60_000 } })), null);
});

test('kit: looks in unknown chests first, then wants only what it can take or craft', (t) => {
  t.is(kit.wants(snap(gear()), world({ chestItems: {} })), 'look in the home chests');
  t.is(kit.wants(snap(gear()), world()), null);
  const noAxe = gear().filter(i => i.name !== 'stone_axe');
  t.is(kit.wants(snap(noAxe.filter(i => i.name !== 'cobblestone')), world()), null); // nothing to make it from: stock's job
  t.regex(kit.wants(snap(noAxe.concat([{ slot: 20, name: 'stick', count: 4 }])), world()) ?? '', /axe \(missing\)/);
});

test('stock: the kit\'s gathering first, then the home stock; by day, fit and not too late', (t) => {
  const s = snap(gear().filter(i => i.name !== 'stone_axe' && i.name !== 'cobblestone'));
  const short = stockShort(s, world({ chestItems: { '1,64,0': { oak_log: 40, coal: 20, iron_ingot: 20 } } }));
  t.deepEqual(short.map(x => x.name), ['cobblestone']);
  t.regex(stock.wants(s, world()) ?? '', /short of .*cobblestone/);
  t.is(stock.wants(snap(gear(), { timeOfDay: 10_000 }), world()), null); // too late
  t.is(stock.wants(snap(gear(), { health: 9 }), world()), null);
  t.is(stock.wants(snap(gear()), world({ chestItems: {} })), null); // chests not looked in yet
});

test('lights: torches checked against the real light; one that lit nothing comes back up, and that spot is left out', async (t) => {
  // a 33 x 13 x 33 yard from (-16, 60, -16): dirt at y 60, dark everywhere; real light comes from placed torches
  // (14 less the taxicab distance), except one walled-off cell that stays dark whatever is placed
  const W = 33, H = 13, L = 33, ox = -16, oy = 60, oz = -16;
  const blocks = new Array(W * H * L).fill('air');
  for (let i = 0; i < W * L; i++) blocks[i] = 'dirt';
  const torches: { x: number; y: number; z: number }[] = [];
  const walled = { x: 16, y: 61, z: 16 };
  const light = () => blocks.map((_, i) => {
    const x = ox + i % W, y = oy + Math.floor(i / (W * L)), z = oz + Math.floor(i / W) % L;
    if (x === walled.x && y === walled.y && z === walled.z) return 0;
    return Math.max(0, ...torches.map(p => 14 - Math.abs(p.x - x) - Math.abs(p.y - y) - Math.abs(p.z - z)));
  });
  const acts: string[] = [];
  const w = world();
  const ctx = {
    s: snap([{ slot: 0, name: 'torch', count: 20 }]), world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const p = { x: Number(a.x), y: Number(a.y), z: Number(a.z) };
      acts.push(`${tool} ${p.x},${p.y},${p.z}`);
      if (tool === 'place-block') torches.push(p);
      if (tool === 'dig-block') torches.splice(torches.findIndex(q => q.x === p.x && q.y === p.y && q.z === p.z), 1);
      return { ok: true, text: tool === 'place-block' ? `Placed torch at (${p.x}, ${p.y}, ${p.z})` : 'Dug torch' };
    },
    call: (async (m: string) => (m === 'world.region' ? { blocks } : { block: light() })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as GoalContext;
  t.regex(lights.wants(ctx.s, ctx.world) ?? '', /daily round/);
  const r = await lights.run(ctx);
  t.regex(r, /^yard: placed \d+ torch\(es\); 1 of \d+ dark spot\(s\) left \(left out from now on\)$/);
  t.true(acts.filter(a => a.startsWith('place-block')).every(a => / -?\d+,61,-?\d+$/.test(a)));
  t.deepEqual(w.darkIgnore, ['16,61,16']);
  t.is(lights.wants(ctx.s, ctx.world), null); // done for today
  // the next day: nothing left that a torch could do
  ctx.s = { ...ctx.s, now: ctx.s.now + 21 * 60_000 };
  acts.length = 0;
  t.is(await lights.run(ctx), 'the yard is lit');
  t.deepEqual(acts, []);
});

test('farm: a daily round from the middle of the farmland, wheat baked into bread', async (t) => {
  const w = world({ landmarks: { chests: [CHEST], farmland: [{ x: 4, y: 63, z: 4 }, { x: 6, y: 63, z: 4 }], furnace: undefined } });
  const s = snap(gear());
  t.is(farm.wants(s, w), 'daily round: the farm');
  const acts: string[] = [];
  const ctx = {
    s, world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => { acts.push(`${tool} ${JSON.stringify(a)}`); return { ok: true, text: tool === 'farm' ? 'Harvested wheat x7' : 'ok' }; },
    call: (async () => ({ items: [{ slot: 3, name: 'wheat', count: 7 }] })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as GoalContext;
  t.is(await farm.run(ctx), 'Harvested wheat x7; baked 2 bread');
  t.deepEqual(acts.map(a => a.split(' ')[0]), ['move-to-position', 'farm', 'craft-item']);
  t.regex(acts[0], /"x":5,"y":64,"z":4/);
  t.is(farm.wants(s, w), null);
});

test('stock: a trip that found nothing leaves that resource alone for a while', async (t) => {
  const s = snap(gear());
  const w = world({ chestItems: { '1,64,0': { oak_log: 40, cobblestone: 64, iron_ingot: 20 } } });
  t.deepEqual(stockShort(s, w).map(x => x.name), ['coal']);
  const ctx = {
    s, world: w, signal: new AbortController().signal,
    act: async (tool: string) => ({ ok: true, text: tool === 'mine-blocks' ? 'Stopped after 360s (time limit): nothing gained.' : 'Home' }),
    call: (async () => ({})) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as GoalContext;
  await stock.run(ctx);
  t.deepEqual(stockShort(s, w), []);
  t.deepEqual(stockShort({ ...s, now: s.now + 31 * 60_000 }, w).map(x => x.name), ['coal']);
});

test('stock no longer walks for sugar_cane, and still does for the rest', async (t) => {
  // live 2026-11-10..12: the stock trip walked out for the enchanting room's cane 30 times, a side picked by the clock
  // ("no sugar_cane within 96 blocks of home north/east/south/west"), every half hour the watchdog let its mark go.
  // The work queue's `cane patch` and `cane` rungs have the cane now: stock has nothing to say about it
  const s = snap(gear());
  const stocked = { oak_log: 40, cobblestone: 64, iron_ingot: 20, coal: 30 };
  const caneOnly = world({ chestItems: { '1,64,0': stocked }, progress: { done: [], journal: [], need: { sugar_cane: 113 } } });
  caneOnly.zones = { wildcane: [{ x: 14, y: 63, z: 163 }] };
  t.deepEqual(stockShort(s, caneOnly), []);
  t.is(stock.wants(s, caneOnly), null);
  t.deepEqual(stock.declines!(s, caneOnly), { cause: 'stocked', text: 'nothing short' });

  // the rest as before: the home's own stock, the kit's iron, and what a project is short of besides its cane
  const mixed = world({ chestItems: { '1,64,0': { ...stocked, coal: 3 } }, progress: { done: [], journal: [], need: { sugar_cane: 113, sand: 20 } } });
  t.deepEqual(stockShort(s, mixed).map(x => `${x.short} ${x.name}`), ['20 sand', '13 coal']);
  const acts: string[] = [];
  const ctx = {
    s, world: mixed, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => { acts.push(tool === 'mine-blocks' ? `${tool} ${a.block}` : tool); return { ok: true, text: tool === 'mine-blocks' ? 'Mined for 60s: sand x20.' : 'Home' }; },
    call: (async () => ({ positions: [] })) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as GoalContext;
  await stock.run(ctx);
  // straight to the sand, no walk to the wild cane remembered 163 blocks out; the project's cane is left in its need
  // for the project to post again (and for the cane rungs to read off its blocked step)
  t.deepEqual(acts, ['mine-blocks sand', 'go-home']);
  t.deepEqual(mixed.progress?.need, { sugar_cane: 113 });
  t.deepEqual(stockShort(s, mixed).map(x => x.name), ['coal']);
});

test('lightArea: a torch that lights nothing dark is taken back up', async (t) => {
  // one spot a mob could stand on, walled off from any light; the plan's torch goes on it and does nothing
  const box = { x: -16, y: 60, z: -16, width: 33, height: 13, length: 33 };
  const blocks = new Array(box.width * box.height * box.length).fill('air');
  blocks[16 + 16 * box.width] = 'dirt'; // (0, 60, 0)
  const acts: string[] = [];
  const io = {
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool} ${a.x},${a.y},${a.z}`);
      return { ok: true, text: tool === 'place-block' ? 'Placed torch at (0, 61, 0)' : 'Dug torch' };
    },
    call: (async (m: string) => (m === 'world.region' ? { blocks } : { block: new Array(blocks.length).fill(0) })) as GoalContext['call']
  };
  const r = await lightArea(io, { x: 0, y: 64, z: 0 }, 16, { place: true, max: 5, ignore: new Set() });
  t.deepEqual(acts, ['place-block 0,61,0', 'dig-block 0,61,0']);
  t.deepEqual(r.undone, [{ x: 0, y: 61, z: 0 }]);
  t.deepEqual(r.left, [{ x: 0, y: 61, z: 0 }]);
  t.deepEqual((await lightArea(io, { x: 0, y: 64, z: 0 }, 16, { place: false, max: 5, ignore: new Set(['0,61,0']) })).dark, []);
});

test('lightArea: a yard too big for one region call is read in slabs of whole layers', async (t) => {
  // radius 42 (an 82 x 26 yard): 85 x 85 x 13 = 93925 blocks, over the bridge's 65536 a call
  const calls: { rpc: string; y: number; height: number }[] = [];
  const io = {
    act: async () => ({ ok: true, text: 'Placed torch' }),
    call: (async (m: string, a: { y: number; width: number; height: number; length: number }) => {
      if (a.width * a.height * a.length > 65_536) throw new Error('region too large (max 65536 blocks)');
      calls.push({ rpc: m, y: a.y, height: a.height });
      const n = a.width * a.height * a.length;
      return m === 'world.region' ? { blocks: new Array(n).fill('air') } : { block: new Array(n).fill(15) };
    }) as unknown as GoalContext['call']
  };
  const r = await lightArea(io, { x: 0, y: 64, z: 0 }, 42, { place: false, max: 0, ignore: new Set() });
  t.deepEqual(r.dark, []);
  t.deepEqual(calls.filter(c => c.rpc === 'world.region'), [{ rpc: 'world.region', y: 60, height: 9 }, { rpc: 'world.region', y: 69, height: 4 }]);
  t.is(calls.filter(c => c.rpc === 'world.light').length, 2);
});

test('makeRod: string and sticks from the chest, then a fishing rod', async (t) => {
  const inv = new Map<string, number>([['oak_planks', 4]]);
  const acts: string[] = [];
  const chest: Record<string, number> = { string: 12, stick: 1 };
  const w = world({ chestItems: { '1,64,0': { ...chest } } });
  const ctx = {
    world: w, s: snap([]), signal: new AbortController().signal, progress: () => undefined,
    call: (async () => ({ items: [...inv].map(([name, count], slot) => ({ slot, name, count })) })) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool} ${a.item ?? a.outputItem} ${a.count ?? a.amount}`);
      if (tool === 'take-from-chest') {
        const item = String(a.item), n = Math.min(Number(a.count), chest[item] ?? 0);
        chest[item] -= n;
        inv.set(item, (inv.get(item) ?? 0) + n);
        return { ok: true, text: `Took ${n} ${item} from the chest at (1, 64, 0). It holds: ${Object.entries(chest).filter(([, k]) => k > 0).map(([k, v]) => `${k} x${v}`).join(', ')}.` };
      }
      if (a.outputItem === 'stick') inv.set('stick', (inv.get('stick') ?? 0) + 4);
      return { ok: true, text: 'Successfully crafted' };
    }
  } as unknown as GoalContext;
  t.true(await makeRod(ctx));
  // one stick in the chest: the other two come from planks
  t.deepEqual(acts, ['take-from-chest string 2', 'take-from-chest stick 3', 'craft-item stick 1', 'craft-item fishing_rod 1']);
});

test('sort: things in the wrong chest go to their own', async (t) => {
  const chests = [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }];
  const contents: Record<string, Record<string, number>> = { '1,64,0': { cobblestone: 64, oak_log: 10 }, '2,64,0': { oak_planks: 5 }, '3,64,0': {} };
  const w = world({ landmarks: { chests, farmland: [] }, chestItems: contents, chestAssign: { '1,64,0': 'stone', '2,64,0': 'wood', '3,64,0': 'ores' } });
  t.regex(sortStorage.wants(snap(gear()), w) ?? '', /wrong chest/);
  const acts: string[] = [];
  const reply = (k: string) => `It holds: ${Object.entries(contents[k]).filter(([, v]) => v > 0).map(([n, v]) => `${n} x${v}`).join(', ') || 'nothing'}.`;
  const ctx = {
    s: snap(gear()), world: w, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    call: (async (m: string, p: Record<string, number>) => {
      if (m === 'chest.open') return { items: contents[`${p.x},${p.y},${p.z}`] };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const k = `${a.x},${a.y},${a.z}`, item = String(a.item), n = Number(a.count);
      acts.push(`${tool} ${k} ${item} ${n}`);
      if (tool === 'take-from-chest') { contents[k][item] -= n; return { ok: true, text: `Took ${n} ${item} from the chest. ${reply(k)}` }; }
      contents[k][item] = (contents[k][item] ?? 0) + n;
      return { ok: true, text: `Stored ${n} ${item} in the chest. ${reply(k)}` };
    }
  } as unknown as GoalContext;
  t.is(await sortStorage.run(ctx), 'moved 1 kind(s) of things to their own chest');
  t.deepEqual(acts, ['take-from-chest 1,64,0 oak_log 10', 'store-in-chest 2,64,0 oak_log 10']);
  t.is(sortStorage.wants(snap(gear()), w), null);
});

test('outsideBy: 0 inside the yard, else how far past its edge', (t) => {
  const yard = { x1: 0, z1: 0, x2: 10, z2: 20 };
  t.is(outsideBy(yard, { x: 5, z: 5 }), 0);
  t.is(outsideBy(yard, { x: -3, z: 5 }), 3);
  t.is(outsideBy(yard, { x: 12, z: 30 }), 10);
});

test('dumpSpot: 8 out from the side the bot walks least', async (t) => {
  const { dumpSpot } = await import('../../src/client/brain/chores.js');
  const { HeatMap } = await import('../../src/client/brain/paths.js');
  const yard = { x1: 0, z1: 0, x2: 20, z2: 10, y: 64 };
  const heat = new HeatMap();
  // the walk south to the lake, west and north: east is the quiet side
  for (let i = 0; i < 20; i++) { heat.visit({ x: 10, z: 18 + (i % 2) }); heat.visit({ x: -8 + (i % 2), z: 5 }); heat.visit({ x: 10, z: -8 + (i % 2) }); }
  t.deepEqual(dumpSpot(yard, heat), { x: 28, y: 65, z: 5 });
  // all four, quietest first: the next to try when one can't be reached (the east one was in a stone hill)
  const { dumpSpots } = await import('../../src/client/brain/chores.js');
  const all = dumpSpots(yard, heat);
  t.is(all.length, 4);
  t.deepEqual(all[0], { x: 28, y: 65, z: 5 });
});

test('smelt: ore still carried after the smelt is a failure, not "done" (the 7 raw copper smelted every 5 seconds)', async (t) => {
  const items = [{ slot: 0, name: 'raw_copper', count: 7 }, { slot: 1, name: 'coal', count: 3 }];
  const s = snap(items);
  const ctx = {
    s, world: world({ lastDone: { furnace: s.now } }), signal: new AbortController().signal,
    act: async () => ({ ok: true, text: 'Furnace input slot is occupied by raw_iron' }),
    call: (async (m: string) => {
      if (m === 'inventory') return { items };
      if (m === 'furnace.open') return { open: true, output: null, input: null, lit: true };
      return {};
    }) as never,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  };
  await t.throwsAsync(smelt.run(ctx as never), { message: /could not smelt raw_copper: Furnace input slot is occupied/ });
});

test('toTheWoods: a tree in sight is enough; else the remembered woods; else each side of home in turn, and remembered', async t => {
  const io = (sight: boolean[], found: Record<string, string>) => {
    const acts: string[] = [];
    let look = 0;
    const world = { zones: {} as Record<string, { x: number; y: number; z: number }[]>, leash: 96 };
    return {
      acts, world,
      // (the look, the run's snapshot and its signal are for the walks through the yard's gates: none is known here)
      ctx: {
        world: world as unknown as WorldMemory, progress: () => undefined, s: snap([]), signal: new AbortController().signal,
        status: async () => ({ inWorld: true, username: 'b', screen: null, position: { x: 0, y: 64, z: 0 } }),
        call: (async (m: string) => (m === 'world.findBlocks' ? { positions: sight[look++] ? [{ x: 1, y: 64, z: 1 }] : [] } : {})) as GoalContext['call'],
        act: async (tool: string, a: Record<string, unknown> = {}) => {
          acts.push(tool === 'explore' ? `explore ${a.direction}` : tool);
          return { ok: true, text: tool === 'explore' ? (found[String(a.direction)] ?? 'oak_log not found within 96 blocks') : 'ok' };
        }
      }
    };
  };
  const here = io([true], {});
  t.deepEqual(await toTheWoods(here.ctx, ['oak_log']), { ok: true, text: '' });
  t.deepEqual(here.acts, []);

  const search = io([false], { south: 'Found oak_log at (10, 70, 120), 120 blocks south of where the search began; the bot is at (10, 64, 110).' });
  t.deepEqual(await toTheWoods(search.ctx, ['oak_log']), { ok: true, text: 'found woods south at (10, 120)' });
  t.deepEqual(search.acts, ['explore north', 'go-home', 'explore east', 'go-home', 'explore south', 'move-to-position'], 'and walks up to the trees it saw');
  t.deepEqual(search.world.zones.woods, [{ x: 10, y: 70, z: 120 }]);

  const known = io([false, true], {});
  known.world.zones.woods = [{ x: 10, y: 70, z: 120 }];
  t.deepEqual(await toTheWoods(known.ctx, ['oak_log']), { ok: true, text: 'off to the woods at (10, 120)' });
  t.deepEqual(known.acts, ['move-to-position']);

  // logs in sight that are its own builds: it goes to the woods all the same
  const own = io([true, true], {});
  own.world.zones.woods = [{ x: 10, y: 70, z: 120 }];
  t.deepEqual(await toTheWoods(own.ctx, ['oak_log'], true), { ok: true, text: 'off to the woods at (10, 120)' });
  t.deepEqual(own.acts, ['move-to-position']);

  // its storage house's logs in the zones it keeps are no trees: off to the woods
  const house = io([true, true], {});
  house.world.zones.storage = [{ x: 0, y: 64, z: 0, width: 7, length: 9 } as never];
  house.world.zones.woods = [{ x: 10, y: 70, z: 120 }];
  let looks = 0; // at home only the storage house's log; at the woods a tree
  house.ctx.call = (async () => ({ positions: [looks++ === 0 ? { x: 1, y: 64, z: 1 } : { x: 11, y: 70, z: 121 }] })) as GoalContext['call'];
  const seen = await toTheWoods(house.ctx, ['oak_log']);
  t.deepEqual(seen, { ok: true, text: 'off to the woods at (10, 120)' }, 'the log at (1, 64, 1) is the storage house');

  const none = io([false], {});
  t.false((await toTheWoods(none.ctx, ['oak_log'])).ok);
  t.is(none.acts.filter(a => a.startsWith('explore')).length, 4);
});

test('toTheWoods: a log on the site of a milestone set aside midway is its own, not a tree', async t => {
  // the enchanting room's site, chosen, the room set aside while the band outside the fence is cleared
  const acts: string[] = [];
  let looks = 0;
  const w = {
    zones: { woods: [{ x: 10, y: 70, z: 120 }] }, leash: 96,
    progress: { done: [], journal: [], current: { id: 'fence-clear', step: 0, data: {} }, aside: { enchanting: { step: 2, data: { site: { x: 0, z: 0, width: 7, length: 7, y: 64 } } } } }
  } as unknown as WorldMemory;
  const ctx = {
    world: w, progress: () => undefined, s: snap([]), signal: new AbortController().signal,
    status: async () => ({ inWorld: true, username: 'b', screen: null, position: { x: 0, y: 64, z: 0 } }),
    // at home only a log on the site; at the woods a tree
    call: (async () => ({ positions: [looks++ === 0 ? { x: 3, y: 65, z: 3 } : { x: 11, y: 70, z: 121 }] })) as GoalContext['call'],
    act: async (tool: string) => { acts.push(tool); return { ok: true, text: 'ok' }; }
  };
  t.deepEqual(await toTheWoods(ctx, ['oak_log']), { ok: true, text: 'off to the woods at (10, 120)' }, 'the log at (3, 65, 3) is on the site');
  t.deepEqual(acts, ['move-to-position']);
});

test('stash with no chest at home yet: wanted when full and a chest is carried; firstChest puts one beside home, off the sites', async t => {
  const junk = Array.from({ length: 22 }, (_, i) => ({ slot: 13 + i, name: 'granite', count: 64 }));
  const none = world({ landmarks: { chests: [], farmland: [] }, chestItems: {} });
  t.is(stash.wants(snap([...gear(), ...junk]), none), null, 'nothing to put a chest down with');
  const withChest = snap([...gear(), ...junk, { slot: 35, name: 'chest', count: 8 }]);
  t.regex(stash.wants(withChest, none) ?? '', /slots used/);

  // grass everywhere at y 63, air above; the storage house's site covers x 1..7: the first spot off it is west
  const blocks = Array.from({ length: 243 }, (_, i) => (Math.floor(i / 81) === 0 ? 'grass_block' : 'air'));
  const placed: Record<string, unknown>[] = [];
  const ctx = {
    s: withChest, world: world({
      landmarks: { chests: [], farmland: [] },
      // the storage house's site, picked but not built: only in the project's own data
      progress: { done: [], journal: [], current: { id: 'storage', step: 1, data: { site: { x: 1, z: -4, width: 7, length: 9, y: 63 } } } }
    } as Partial<WorldMemory>),
    call: (async () => ({ blocks })) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => { placed.push({ tool, ...a }); return { ok: true, text: 'Placed chest at somewhere' }; }
  };
  const at = await firstChest(ctx);
  t.truthy(at);
  t.true(at!.x <= -2 || Math.abs(at!.z) >= 2, 'not on the storage site');
  t.true(at!.x < 1, 'off the site');
  t.is(Math.max(Math.abs(at!.x), Math.abs(at!.z)), 2, 'close to home');
  t.like(placed[0], { tool: 'place-block', item: 'chest', y: 64 });
});

test('firstChest: off the site of a milestone set aside midway too', async t => {
  // grass everywhere at y 63, air above; the storage house's site (x -4..4, z -4..-1) kept by a milestone set aside
  const blocks = Array.from({ length: 243 }, (_, i) => (Math.floor(i / 81) === 0 ? 'grass_block' : 'air'));
  const ctx = {
    s: snap([...gear(), { slot: 35, name: 'chest', count: 8 }]), world: world({
      landmarks: { chests: [], farmland: [] },
      progress: { done: [], journal: [], current: { id: 'home', step: 0, data: {} }, aside: { storage: { step: 1, data: { site: { x: -4, z: -4, width: 9, length: 4, y: 63 } } } } }
    } as Partial<WorldMemory>),
    call: (async () => ({ blocks })) as GoalContext['call'],
    act: async () => ({ ok: true, text: 'Placed chest at somewhere' })
  };
  const at = await firstChest(ctx);
  t.truthy(at);
  t.true(at!.z >= 0, `not on the set-aside site: (${at!.x}, ${at!.z})`);
  t.is(Math.max(Math.abs(at!.x), Math.abs(at!.z)), 2, 'close to home');
});

test('stockShort: a project short of oak goes before the home keeping its 32 logs of any kind', t => {
  const logs = [{ slot: 20, name: 'oak_log', count: 30 }];
  const w = world({ progress: { done: [], journal: [], need: { oak_log: 12 } } } as Partial<WorldMemory>);
  const short = stockShort(snap([...gear(), ...logs]), w).map(x => `${x.name} ${x.short}`);
  t.true(short.indexOf('oak_log 12') >= 0 && short.indexOf('oak_log 12') < short.indexOf('log 2'), short.join(', '));
  t.true(short.indexOf('cobblestone 24') > short.indexOf('oak_log 12'), 'the home stock after the project');
});

test('stash: a build job carrying its load is left alone until not a slot is free, then stopped once in 10 min, not at every station', (t) => {
  // live 2026-11-10: the lookout's load filled 35/36 slots; the build goes on with full pockets, and a block dug
  // at each station (a bone here) must not bring the stash back each time
  const load = Array.from({ length: 22 }, (_, i): InventoryItem => ({ slot: 13 + i, name: 'cobblestone', count: 64 }));
  const items = [...gear(), ...load, { slot: 6, name: 'bone', count: 1 }, { slot: 7, name: 'cobblestone', count: 64 }, { slot: 35, name: 'cobblestone', count: 64 }];
  const job = { id: 8, world: 'w', structure: 'lookout', mode: 'apply' as const, status: 'working' as const, phase: 'building' as const, createdAt: 0, updatedAt: 0, carry: ['cobblestone'] };
  const s = snap(items);
  const w = (ago: number) => world({ buildJobs: [job], lastDone: { stash: s.now - ago } });
  // 34/36: two slots still take what the build digs up, so it runs on however long ago the last stash was
  t.is(s.slotsUsed, 34);
  t.is(stash.wants(s, w(11 * 60_000)), null);
  // not a slot left: what it digs up now stays on the ground
  const full = snap([...items, { slot: 8, name: 'string', count: 3 }, { slot: 9, name: 'gunpowder', count: 2 }]);
  t.regex(stash.wants(full, w(11 * 60_000)) ?? '', /36\/36 slots used/);
  t.is(stash.wants(full, w(60_000)), null);
});

test('a round is due in the evening, or when twice overdue, or when no far or deep rung is ready: lights, tidy, repair, signs and sort; a round not yet due is not started', (t) => {
  const NOW = 10 * 60 * 60_000;
  const MIN = 60_000;
  const chests = [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }];
  // each round with something to do: torches carried, a built block to look at, chests without their signs, logs in
  // the stone chest
  const rt = { builtNear: () => [{ at: { x: 2, y: 64, z: 3 }, state: 'oak_planks' }] } as unknown as ClientRuntime;
  const rounds: [Goal, number][] = [[lights, 20], [tidyGoal(rt), 20], [repairGoal(rt), 20], [signsGoal, 20], [sortStorage, 30]];
  // what the third chest holds decides the trips: every ore and the coal at their targets (no trip), no coal (coal
  // from the surface), no iron (a deep trip: the kit carried is whole)
  const FULL = { diamond: 16, raw_iron: 96, raw_gold: 32, redstone: 64, lapis_lazuli: 32, coal: 128 };
  const stores: Record<string, Record<string, number>> = { 'no trip': FULL, 'coal from the surface': { ...FULL, coal: 0 }, 'a deep trip': { ...FULL, raw_iron: 0 } };
  const home = (round: string, ago: number, store: Record<string, number>) => world({
    landmarks: { chests, farmland: [] },
    chestItems: { '1,64,0': { cobblestone: 64, oak_log: 10 }, '2,64,0': { oak_planks: 5 }, '3,64,0': { ...store } },
    chestAssign: { '1,64,0': 'stone', '2,64,0': 'wood', '3,64,0': 'ores' },
    lastDone: { [round]: NOW - ago }
  });
  const at = (timeOfDay: number) => snap(gear(), { now: NOW, timeOfDay });
  const bad: string[] = [];
  for (const [goal, every] of rounds) {
    const due = (time: number, ago: number, store: string) => goal.wants(at(time), home(goal.name, ago * MIN, stores[store])) !== null;
    const expect = (want: boolean, time: number, ago: number, store: string) => {
      if (due(time, ago, store) !== want) bad.push(`${goal.name}: ${ago} min after its last, time ${time}, ${store}: ${want ? 'not due' : 'due'}`);
    };
    // its time is up, by day: a trip that could go comes first
    expect(false, 3000, every + 5, 'coal from the surface');
    expect(false, 3000, every + 5, 'a deep trip');
    // in the evening it is due whatever else could go
    expect(true, EVENING_AT, every + 5, 'coal from the surface');
    expect(true, EVENING_AT, every + 5, 'a deep trip');
    // waited twice its time: due at any hour
    expect(false, 3000, 2 * every, 'a deep trip');
    expect(true, 3000, 2 * every + 1, 'a deep trip');
    // no trip to go on: due as soon as its time is up, as before
    expect(true, 3000, every + 1, 'no trip');
    // not yet its time: never, evening or no trip
    expect(false, EVENING_AT, every - 1, 'no trip');
    expect(false, 3000, every - 1, 'no trip');
  }
  t.deepEqual(bad, []);
});
