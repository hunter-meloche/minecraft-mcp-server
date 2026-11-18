import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { farm, furnaceLine, kit, lightArea, lights, packOres, packPlan, PACK_KEEP, smelt, sortStorage, stash, stashKeep, stashList, stock, outsideBy, stockShort, toTheWoods, firstChest } from '../../src/client/brain/chores.js';
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
import { Brain } from '../../src/client/brain/brain.js';
import { NEAR_HOME } from '../../src/client/brain/pockets.js';
import { smeltsPerFuel } from '../../src/tools/furnace-tools.js';

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

test('stash: an enchanted piece stays carried, never put away for a plain one of its tier (worn or carried)', (t) => {
  const sharp = { enchanted: true, enchantments: [{ name: 'sharpness', level: 5 }] };
  const prot = { enchanted: true, enchantments: [{ name: 'protection', level: 4 }] };
  // the plain chestplate worn, the enchanted one carried: the enchanted one is the kit's (the Guardian puts it on)
  const items = [...gear().filter(i => i.slot !== 38), { slot: 38, name: 'diamond_chestplate', count: 1, damage: 0, maxDamage: 528 },
    { slot: 20, name: 'diamond_chestplate', count: 1, damage: 60, maxDamage: 528, ...prot }];
  t.false(stashList(snap(items), world()).deposit.some(e => e.name === 'diamond_chestplate'));
  // two swords carried: store-in-chest takes the first by name, so neither goes (the enchanted one might)
  const swords = [...gear().filter(i => i.name !== 'stone_sword'), { slot: 4, name: 'diamond_sword', count: 1, damage: 0, maxDamage: 1561 },
    { slot: 21, name: 'diamond_sword', count: 1, damage: 90, maxDamage: 1561, ...sharp }];
  t.false(stashList(snap(swords), world()).deposit.some(e => e.name === 'diamond_sword'));
  // a worse sword of another name still goes in the chest: the enchanted diamond one is kept, the iron one put away
  const plainOnly = [...gear().filter(i => i.name !== 'stone_sword'), { slot: 4, name: 'diamond_sword', count: 1, damage: 0, maxDamage: 1561, ...sharp },
    { slot: 21, name: 'iron_sword', count: 1, damage: 0, maxDamage: 250 }];
  t.deepEqual(stashList(snap(plainOnly), world()).deposit.filter(e => /sword/.test(e.name)), [{ name: 'iron_sword', count: 1, slot: 21 }]);
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

test('lights: the band outside the fence leaves out the dark spots a torch it took back had in reach, and is not walked out to again for them', async (t) => {
  // live Nov 13-15: a torch by the west gate at (-567, 63, 2167) lit nothing and came back up 19 rounds running, the
  // same 10 dark spots left each time. Here: a 9 x 9 yard, everything lit but two flowers walled off from all light
  // 6 and 7 west of the fence (a flower takes no torch: the plan puts it on the dirt beside them)
  const yard = { x1: -4, z1: -4, x2: 4, z2: 4, y: 60 };
  const W = 35, H = 13, L = 35, ox = -17, oy = 57, oz = -17;
  const blocks = new Array(W * H * L).fill('air');
  const at = (x: number, y: number, z: number) => (x - ox) + (z - oz) * W + (y - oy) * W * L;
  for (let z = oz; z < oz + L; z++) for (let x = ox; x < ox + W; x++) for (let y = oy; y <= 60; y++) blocks[at(x, y, z)] = 'dirt';
  const walled = [{ x: -10, y: 61, z: 0 }, { x: -11, y: 61, z: 0 }];
  for (const p of walled) blocks[at(p.x, p.y, p.z)] = 'poppy';
  const light = () => blocks.map((_, i) => {
    const x = ox + i % W, y = oy + Math.floor(i / (W * L)), z = oz + Math.floor(i / W) % L;
    return walled.some(p => p.x === x && p.y === y && p.z === z) ? 0 : 15;
  });
  const acts: string[] = [];
  const w = world({ yard });
  const ctx = {
    s: snap([{ slot: 0, name: 'torch', count: 40 }]), world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      if (tool === 'place-block' || tool === 'dig-block') {
        acts.push(`${tool} ${a.x},${a.y},${a.z}`);
        const i = at(Number(a.x), Number(a.y), Number(a.z));
        blocks[i] = tool === 'place-block' ? 'torch' : 'air';
        return { ok: true, text: tool === 'place-block' ? `Placed torch at (${a.x}, ${a.y}, ${a.z})` : 'Dug torch' };
      }
      return { ok: true, text: 'ok' };
    },
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      if (m === 'world.region') return { blocks };
      if (m === 'world.light') return { block: light() };
      if (m === 'status') return { inWorld: true, position: { x: 0, y: 61, z: 0 } };
      return a && {};
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null, position: { x: 0, y: 61, z: 0 } }),
    progress: () => undefined, gain: () => undefined
  } as unknown as GoalContext;
  const r = await lights.run(ctx);
  t.regex(r, /^the yard is lit; outside the fence: 0 torch\(es\), 2 dark spot\(s\) to go/);
  t.is(acts.length, 2);
  t.regex(acts[0], /^place-block /);
  t.is(acts[1], acts[0].replace('place', 'dig'));
  t.deepEqual([...(w.darkIgnore ?? [])].sort(), ['-10,61,0', '-11,61,0']);
  // the next day: no torch for them, no walk out of the gate
  ctx.s = { ...ctx.s, now: ctx.s.now + 21 * 60_000 };
  acts.length = 0;
  t.regex(await lights.run(ctx), /^the yard is lit; outside the fence: 0 torch\(es\), 0 dark spot\(s\) to go/);
  t.deepEqual(acts, []);
});

test('farm: a daily round from the middle of the farmland, wheat baked into bread', async (t) => {
  // (the pens' stock of wheat already in the chest: the harvest's is baked; with less stored the bake leaves the pens
  // theirs, tests/client/wheat.test.ts)
  const w = world({ landmarks: { chests: [CHEST], farmland: [{ x: 4, y: 63, z: 4 }, { x: 6, y: 63, z: 4 }], furnace: undefined }, chestItems: { '1,64,0': { wheat: 16 } } });
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

test('sort: a lava bucket in the wrong chest is carried to its own with a harmless item in hand, not the bucket', async (t) => {
  // the withdraw's shift-click put the bucket in the selected slot (the hotbar fills from its far end)
  const chests = [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }];
  const contents: Record<string, Record<string, number>> = { '1,64,0': { bread: 30, lava_bucket: 1 }, '2,64,0': { stone_pickaxe: 1 }, '3,64,0': {} };
  const w = world({ landmarks: { chests, farmland: [] }, chestItems: contents, chestAssign: { '1,64,0': 'food', '2,64,0': 'gear', '3,64,0': 'ores' } });
  let held = 'nothing';
  const items = [{ slot: 0, name: 'diamond_sword', count: 1 }];
  const acts: string[] = [];
  const reply = (k: string) => `It holds: ${Object.entries(contents[k]).filter(([, v]) => v > 0).map(([n, v]) => `${n} x${v}`).join(', ') || 'nothing'}.`;
  const ctx = {
    s: snap(gear()), world: w, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    call: (async (m: string, p: Record<string, unknown>) => {
      if (m === 'chest.open') return { items: contents[`${p.x},${p.y},${p.z}`] };
      if (m === 'inventory') return { items, held: held === 'nothing' ? null : { name: held, count: 1 } };
      if (m === 'item.select') { held = String(p.name); return {}; }
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const k = `${a.x},${a.y},${a.z}`, item = String(a.item), n = Number(a.count);
      acts.push(`${tool} ${k} ${item} with ${held}`);
      if (tool === 'take-from-chest') {
        contents[k][item] -= n;
        items.push({ slot: 8, name: item, count: n });
        held = item;
        return { ok: true, text: `Took ${n} ${item} from the chest. ${reply(k)}` };
      }
      contents[k][item] = (contents[k][item] ?? 0) + n;
      return { ok: true, text: `Stored ${n} ${item} in the chest. ${reply(k)}` };
    }
  } as unknown as GoalContext;
  t.is(await sortStorage.run(ctx), 'moved 1 kind(s) of things to their own chest');
  t.deepEqual(acts, ['take-from-chest 1,64,0 lava_bucket with nothing', 'store-in-chest 2,64,0 lava_bucket with diamond_sword']);
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

test('smelt: another ore still cooking in the lit furnace is never taken back out for the ore carried: that waits for the load\'s time, then goes in (1ecdb6d took the cooking raw iron out for the raw gold)', async (t) => {
  const items = [{ slot: 0, name: 'raw_gold', count: 20 }, { slot: 1, name: 'coal', count: 5 }];
  const s = snap(items);
  const input: { name: string; count: number } | null = { name: 'raw_iron', count: 9 };
  const calls: string[] = [];
  const acts: Record<string, unknown>[] = [];
  const w = world({ lastDone: { furnace: s.now } });
  const ctx = {
    s, world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown>) => {
      if (tool !== 'smelt-item') return { ok: true, text: '' };
      acts.push(a);
      if (input && input.name !== a.inputItem) return { ok: true, text: `Furnace input slot is occupied by ${input.name}` };
      items[0].count -= Number(a.inputCount);
      return { ok: true, text: `Smelted ${a.inputCount} gold_ingot` };
    },
    call: (async (m: string, a?: { slot?: string }) => {
      calls.push(m);
      if (m === 'inventory') return { items };
      if (m === 'furnace.open') return { open: true, output: null, input, lit: true };
      if (m === 'furnace.take' && a?.slot === 'input') throw new Error('the cooking raw iron taken out');
      return {};
    }) as never,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  };
  t.is(await smelt.run(ctx as never), '20 raw_gold wait: the furnace is cooking 9 raw_iron, done about 10:01:34Z');
  t.is(acts.length, 0);
  t.false(calls.includes('furnace.take'));
  // the furnace's load as it showed it: the gold is not wanted while that cooks (no run that wants again at once),
  // and wanted once its time is up
  t.deepEqual(w.furnaceLoad, { item: 'raw_iron', count: 9, at: s.now });
  t.is(smelt.wants(snap(items, { now: s.now + 60_000 }), w), null);
  t.is(smelt.wants(snap(items, { now: s.now + 9 * 10_500 }), w), '20 raw_gold to smelt');
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

test('kit: full pockets home from a trip down: the haul goes in the chests before the kit takes its materials', async (t) => {
  // live, Nov 14: 36/36 after a deep trip, every take came back empty and the craft after it failed, 4 runs in 30 s
  const items: InventoryItem[] = gear().filter(i => i.name !== 'stone_axe');
  for (let slot = 0; slot < 36; slot++) if (!items.some(i => i.slot === slot)) items.push({ slot, name: 'tuff', count: 64 });
  const w = world({ chestItems: { '1,64,0': { stick: 10 } }, lastDone: { chests: 10 * 60 * 60_000 } });
  const acts: string[] = [];
  const ctx = {
    s: snap(items), world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      acts.push(`${tool} ${String(a.item ?? a.outputItem ?? '')}`);
      if (tool === 'store-in-chest') {
        const n = items.filter(i => i.name === a.item).reduce((k, i) => k + i.count, 0);
        for (let i = items.length - 1; i >= 0; i--) if (items[i].name === a.item) items.splice(i, 1);
        return { ok: true, text: `Stored ${n} ${String(a.item)}` };
      }
      if (tool === 'take-from-chest') {
        if (items.filter(i => i.slot < 36).length >= 36) return { ok: true, text: 'Took 0: the inventory is full' };
        items.push({ slot: 30, name: 'stick', count: Number(a.count) });
        return { ok: true, text: `Took ${Number(a.count)} stick` };
      }
      if (tool === 'craft-item') {
        const sticks = items.find(i => i.name === 'stick');
        if (!sticks) return { ok: false, text: 'Failed: missing ingredients for stone_axe: needs stick x2 (have 0)' };
        items.push({ slot: 31, name: 'stone_axe', count: 1, damage: 0, maxDamage: 131 });
        return { ok: true, text: 'Crafted stone_axe' };
      }
      return { ok: true, text: 'ok' };
    },
    // the chest holds the sticks, whatever went in (looked in first: the kit always does)
    call: (async (m: string) => (m === 'inventory' ? { items: items.map(i => ({ ...i })) } : m === 'chest.open' ? { items: { stick: 10 } } : {})) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld', timeOfDay: 1000 }),
    progress: () => undefined, gain: () => undefined
  } as unknown as GoalContext;
  t.regex(kit.wants(ctx.s, w) ?? '', /axe \(missing\)/);
  const r = await kit.run(ctx);
  t.regex(r, /took|crafted stone_axe/);
  const store = acts.findIndex(a => a === 'store-in-chest tuff');
  t.true(store >= 0, acts.join(' | '));
  t.true(store < acts.findIndex(a => a.startsWith('take-from-chest')), acts.join(' | '));
  t.true(acts.includes('craft-item stone_axe'), acts.join(' | '));
});

test('kit: a run where every step came to nothing fails (held for the retry time), not done and wanted again at once', async (t) => {
  const items = gear().filter(i => i.name !== 'stone_axe').concat([{ slot: 20, name: 'stick', count: 4 }]);
  const ctx = {
    s: snap(items), world: world({ lastDone: { chests: 10 * 60 * 60_000 } }), signal: new AbortController().signal,
    act: async () => ({ ok: false, text: 'Failed: missing ingredients for stone_axe: needs cobblestone x3 (have 0)' }),
    call: (async (m: string) => (m === 'inventory' ? { items } : {})) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as unknown as GoalContext;
  await t.throwsAsync(() => kit.run(ctx), { message: /could not craft stone_axe/ });
});

test('pickFuel: what is carried short of the batch gives way to coal from the chests (2 planks cooked 3 of 46 raw gold)', async (t) => {
  const { pickFuel } = await import('../../src/client/brain/project.js');
  const carried = (o: Record<string, number>) => new Map(Object.entries(o));
  // 2 planks are 3 smelts: coal for the whole batch is fetched, and burnt
  t.deepEqual(pickFuel(carried({ oak_planks: 2 }), {}, { coal: 130 }, 46), { fuel: 'oak_planks', fetch: { name: 'coal', count: 6 } });
  // coal carried short: the rest of it fetched
  t.deepEqual(pickFuel(carried({ coal: 3 }), {}, { coal: 130 }, 46), { fuel: 'coal', fetch: { name: 'coal', count: 3 } });
  // enough carried: nothing fetched (coal first; logs that cover it when no coal is carried)
  t.deepEqual(pickFuel(carried({ oak_log: 40, coal: 6 }), {}, { coal: 130 }, 46), { fuel: 'coal' });
  t.deepEqual(pickFuel(carried({ oak_log: 40 }), {}, { coal: 130 }, 46), { fuel: 'oak_log' });
  // no coal stored: the best carried, some cooking over none; nothing carried: some fetched, as ever
  t.deepEqual(pickFuel(carried({ oak_planks: 2 }), {}, { oak_log: 20 }, 46), { fuel: 'oak_planks' });
  t.deepEqual(pickFuel(carried({}), {}, { oak_log: 20 }, 46), { fetch: { name: 'oak_log', count: 8 } });
  // the bill's own planks are not fuel
  t.deepEqual(pickFuel(carried({ oak_planks: 10 }), { oak_planks: 10 }, {}, 4), {});
});

test('smelt: ore with 2 planks carried fetches coal for it, and burns that', async (t) => {
  const items = [{ slot: 9, name: 'raw_gold', count: 46 }, { slot: 10, name: 'oak_planks', count: 2 }];
  const s = snap(items);
  const acts: [string, Record<string, unknown>][] = [];
  const ctx = {
    s, world: (() => { const w = world({ lastDone: { furnace: s.now }, chestItems: { '1,64,1': { coal: 130 } } }); w.landmarks.chests = [{ x: 1, y: 64, z: 1 }]; return w; })(), signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown>) => {
      acts.push([tool, a]);
      if (tool === 'take-from-chest') { items.push({ slot: 11, name: 'coal', count: Number(a.count) }); return { ok: true, text: `Took ${a.count} coal` }; }
      if (tool === 'smelt-item') items.splice(0, 1);
      return { ok: true, text: 'Smelted 46 gold_ingot' };
    },
    call: (async (m: string) => {
      if (m === 'inventory') return { items };
      if (m === 'furnace.open') return { open: true, output: null, input: null, lit: false };
      return {};
    }) as never,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  };
  await smelt.run(ctx as never);
  // the coal for all of the load (the 46 raw gold go in at once, a stack at most: ORE_BATCH), and it goes
  t.like(acts.find(([n]) => n === 'take-from-chest')?.[1], { item: 'coal', count: 6 });
  t.like(acts.find(([n]) => n === 'smelt-item')?.[1], { inputItem: 'raw_gold', inputCount: 46, fuelItem: 'coal', takeOutput: false });
});

test('smelt: ore a stack a load, loaded and left to cook, the rest when the furnace has room for it; before that next load the furnace\'s turn goes to a build job or the project (the cleanup\'s 4 stone waited an hour behind 46 raw gold and 124 raw iron, Nov 15)', async (t) => {
  const { furnaceTurn, ORE_BATCH } = await import('../../src/client/brain/chores.js');
  const items = [{ slot: 9, name: 'raw_iron', count: 100 }, { slot: 10, name: 'coal', count: 13 }];
  const s = snap(items);
  const w = world({ lastDone: { furnace: s.now - 60_000 } });
  const acts: [string, Record<string, unknown>][] = [];
  const ctx = {
    s, world: w, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown>) => {
      acts.push([tool, a]);
      if (tool !== 'smelt-item') return { ok: true, text: '' };
      const n = Number(a.inputCount);
      items[0].count -= n;
      items[1].count -= Math.ceil(n / 8);
      return { ok: true, text: `Started smelting ${n} raw_iron with ${Math.ceil(n / 8)} coal` };
    },
    call: (async (m: string) => {
      if (m === 'inventory') return { items };
      if (m === 'furnace.open') return { open: true, output: null, input: null, lit: false };
      return {};
    }) as never,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  };
  t.is(ORE_BATCH, 64);
  t.is(await smelt.run(ctx as never), 'loaded 64 raw_iron (8 coal), done about 10:11:12Z; 36 for the next load');
  t.deepEqual(acts.filter(([n]) => n === 'smelt-item').map(([, a]) => [a.inputCount, a.takeOutput]), [[ORE_BATCH, false]]);
  t.deepEqual(w.furnaceLoad, { item: 'raw_iron', count: 64, at: s.now });
  // the rest waits while the input has no room for it: no want, and no turn (the smelt would not load now)
  const soon = snap(items, { now: s.now + 3 * 60_000 });
  t.is(smelt.wants(soon, w), null);
  t.false(furnaceTurn(soon, w, s.now - 1));
  // 36 cooked, room for the 36: the next load is wanted
  const after = snap(items, { now: s.now + 36 * 10_500 });
  t.is(smelt.wants(after, w), '36 raw_iron to smelt');
  // the turn: a job (or the project) that last ran before the load has it, one that has run since has not
  t.true(furnaceTurn(after, w, s.now - 1));
  t.false(furnaceTurn(after, w, s.now + 60_000));
  // not while a smelt run is under way (one started since: a run on its turn would stop it)
  t.false(furnaceTurn(after, { ...w, lastDone: { ...w.lastDone, furnace: after.now } }, s.now - 1));
  // nor with the ore all smelted: nothing to go before; nor away from home (ore a trip mines down the mine is no
  // load's rest, and the job on a turn would cut that trip short)
  t.false(furnaceTurn(snap([{ slot: 10, name: 'coal', count: 5 }], { now: after.now }), w, s.now - 1));
  t.false(furnaceTurn(snap(items, { now: after.now, position: { x: 0, y: 12, z: 0 }, distHome: 52 }), w, s.now - 1));
  // nor after a load that never went in (refused): no load stamped
  const refused = world({ lastDone: { furnace: s.now - 60_000 } });
  const busy = { ...ctx, s: snap(items), world: refused, act: async () => ({ ok: true, text: 'Furnace input slot is occupied by sand' }) };
  await t.throwsAsync(smelt.run(busy as never), { message: /could not smelt raw_iron/ });
  t.false(furnaceTurn(after, refused, s.now - 1));
});

test('smelt: ore carried and the coal in the chests is a batch to smelt (the coal it fetches for a batch all burns: the next waited for the half-hourly look)', (t) => {
  const s = snap([{ slot: 0, name: 'raw_iron', count: 24 }]);
  const w = world({ lastDone: { furnace: s.now - 60_000 }, chestItems: { '1,64,0': { coal: 40 } } });
  t.is(smelt.wants(s, w), '24 raw_iron to smelt');
  // coal a build job holds in the chests is not there to burn
  t.is(smelt.wants(s, { ...w, reserved: { 3: { coal: 40 } } }), null);
});

test('smelt: ore carried and no fuel carried wants only the chests\' coal or charcoal, with a slot free to fetch it into (at 36/36 it took none, said "nothing to smelt" and wanted again, ahead of the stash; their logs cooked 12 of 16)', async (t) => {
  const { furnaceTurn } = await import('../../src/client/brain/chores.js');
  const now = 10 * 60 * 60_000;
  const coal = world({ lastDone: { furnace: now - 60_000 }, chestItems: { '1,64,0': { coal: 40 } } });
  // home from a deep trip, the pockets full: the stash goes first, and makes the room
  const full = snap([{ slot: 0, name: 'raw_iron', count: 40 }, ...Array.from({ length: 35 }, (_, i) => ({ slot: 1 + i, name: 'cobblestone', count: 64 }))]);
  t.is(full.slotsUsed, 36);
  t.is(smelt.wants(full, coal), null);
  t.false(furnaceTurn(full, { ...coal, lastDone: { furnace: now - 60_000, oreBatch: now - 60_000 } }, 0));
  // a slot free: the coal fetched for the batch
  const room = snap([{ slot: 0, name: 'raw_iron', count: 40 }, ...Array.from({ length: 34 }, (_, i) => ({ slot: 1 + i, name: 'cobblestone', count: 64 }))]);
  t.is(smelt.wants(room, coal), '40 raw_iron to smelt');
  // charcoal will do; the yard's logs and planks are no fuel to fetch for ore
  t.is(smelt.wants(room, world({ lastDone: { furnace: now - 60_000 }, chestItems: { '1,64,0': { charcoal: 3 } } })), '40 raw_iron to smelt');
  t.is(smelt.wants(room, world({ lastDone: { furnace: now - 60_000 }, chestItems: { '1,64,0': { oak_log: 64, birch_planks: 40 } } })), null);
  // carried fuel, full or not, as ever
  const withCoal = snap([{ slot: 0, name: 'raw_iron', count: 40 }, { slot: 1, name: 'coal', count: 5 }, ...Array.from({ length: 34 }, (_, i) => ({ slot: 2 + i, name: 'cobblestone', count: 64 }))]);
  t.is(withCoal.slotsUsed, 36);
  t.is(smelt.wants(withCoal, world({ lastDone: { furnace: now - 60_000 } })), '40 raw_iron to smelt');
});

// ---- F6: the smelt loads the furnace and goes (it stood at the furnace through every batch, Nov 15) ----

type Stack = { name: string; count: number } | null;
const COOKS: Record<string, string> = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot', cobblestone: 'stone', beef: 'cooked_beef' };

/**
 * The home in kind for the smelt's runs: the pockets (`items`), a chest's stock (`chest`), and a furnace that cooks an
 * item every 10 s of `g.now` while its fuel lasts, stops with its output full or of another kind, and answers the
 * bridge's look, put and take as the mod does (a take says what the slot held, and moves what fits). smelt-item as the
 * tool does it: fuel for all that is queued, the input a stack at most; with takeOutput it waits at the furnace for the
 * lot, the clock with it. `acts` is what the goals asked for.
 */
function homeGame(items: InventoryItem[], g: { now: number }, chest: Record<string, number> = {}) {
  const f = { input: null as Stack, fuel: null as Stack, output: null as Stack, burn: 0, at: g.now };
  const acts: [string, Record<string, unknown>][] = [];
  const cooksTo = (n: string) => COOKS[n] ?? (/_log$/.test(n) ? 'charcoal' : `cooked_${n}`);
  const lit = () => !!f.input && (f.burn > 0 || !!f.fuel);
  const cook = () => {
    while (f.input && g.now - f.at >= 10_000) {
      const out = cooksTo(f.input.name);
      if (f.output && (f.output.name !== out || f.output.count >= 64)) break;
      if (f.burn <= 0) {
        if (!f.fuel) break;
        f.burn += smeltsPerFuel(f.fuel.name);
        f.fuel = f.fuel.count > 1 ? { ...f.fuel, count: f.fuel.count - 1 } : null;
      }
      f.output = { name: out, count: (f.output?.count ?? 0) + 1 };
      f.burn--;
      f.input = f.input.count > 1 ? { ...f.input, count: f.input.count - 1 } : null;
      f.at += 10_000;
    }
    if (!f.input) f.at = g.now;
  };
  const carried = (n: string) => items.filter(i => i.slot < 36 && i.name === n).reduce((a, i) => a + i.count, 0);
  const add = (name: string, n: number): number => {
    let left = n;
    for (const i of items.filter(x => x.slot < 36 && x.name === name)) { const m = Math.min(64 - i.count, left); i.count += m; left -= m; }
    while (left > 0) {
      const slot = [...Array(36).keys()].find(k => !items.some(i => i.slot === k));
      if (slot === undefined) break;
      items.push({ slot, name, count: Math.min(64, left) });
      left -= Math.min(64, left);
    }
    return n - left;
  };
  const take = (name: string, n: number): number => {
    let got = 0;
    for (const i of items.filter(x => x.slot < 36 && x.name === name)) { const m = Math.min(i.count, n - got); i.count -= m; got += m; }
    items.splice(0, items.length, ...items.filter(i => i.count > 0));
    return got;
  };
  const look = () => { cook(); return { open: true, input: f.input && { ...f.input }, fuel: f.fuel && { ...f.fuel }, output: f.output && { ...f.output }, lit: lit() }; };
  const call = (async (m: string, a: Record<string, unknown> = {}) => {
    if (m === 'inventory') return { items: items.map(i => ({ ...i })) };
    if (m === 'furnace.open' || m === 'furnace.status') return look();
    if (m === 'furnace.take') {
      cook();
      const from = a.slot === 'input' ? 'input' : 'output';
      const st = f[from];
      if (!st) return { took: null };
      const moved = add(st.name, st.count);
      f[from] = st.count > moved ? { ...st, count: st.count - moved } : null;
      return { took: { ...st } };
    }
    return {};
  }) as GoalContext['call'];
  // (the chest's replies say what it holds, as the tools' do: the world's memory of it follows)
  const holds = () => `It holds: ${Object.entries(chest).filter(([, n]) => n > 0).map(([k, n]) => `${k} x${n}`).join(', ') || 'nothing'}.`;
  const act = async (tool: string, a: Record<string, unknown> = {}) => {
    acts.push([tool, a]);
    if (tool === 'take-from-chest') {
      const item = String(a.item);
      const n = Math.min(Number(a.count), chest[item] ?? 0);
      chest[item] = (chest[item] ?? 0) - add(item, n);
      return { ok: true, text: `Took ${n} ${item} from the chest. ${holds()}` };
    }
    if (tool === 'store-in-chest') {
      const item = String(a.item);
      const n = take(item, a.count === undefined ? Infinity : Number(a.count));
      chest[item] = (chest[item] ?? 0) + n;
      return { ok: true, text: `Stored ${n} ${item} in the chest. ${holds()}` };
    }
    if (tool === 'smelt-item') {
      cook();
      const input = String(a.inputItem), fuel = String(a.fuelItem);
      if (f.input && f.input.name !== input) return { ok: true, text: `Furnace input slot is occupied by ${f.input.name}` };
      const wasLit = lit();
      const putCount = Math.min(Number(a.inputCount), carried(input));
      const queued = putCount + (f.input?.count ?? 0);
      const stocked = f.fuel ? f.fuel.count * smeltsPerFuel(f.fuel.name) : 0;
      const addFuel = Math.min(Math.ceil(Math.max(0, queued - stocked) / smeltsPerFuel(fuel)), carried(fuel));
      if (addFuel && (!f.fuel || f.fuel.name === fuel)) f.fuel = { name: fuel, count: (f.fuel?.count ?? 0) + take(fuel, addFuel) };
      const put = take(input, Math.min(putCount, 64 - (f.input?.count ?? 0)));
      if (put) f.input = { name: input, count: (f.input?.count ?? 0) + put };
      if (!wasLit) f.at = g.now;
      if (a.takeOutput === false) return { ok: true, text: `Started smelting ${putCount} ${input}${addFuel ? ` with ${addFuel} ${fuel}` : ''}` };
      g.now += queued * 10_000;
      cook();
      const out = f.output;
      f.output = null;
      if (out) add(out.name, out.count);
      return { ok: true, text: out ? `Smelted ${out.count} ${out.name}` : 'No output' };
    }
    return { ok: true, text: '' };
  };
  const ctx = (s: Snapshot, w: WorldMemory) => ({
    s, world: w, signal: new AbortController().signal, act, call, progress: () => undefined, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null })
  }) as unknown as GoalContext;
  return { f, acts, ctx, call, act, carried };
}
const NOW = 10 * 60 * 60_000;
/** The smelt-item calls a run made: what went in, and whether it waited for the output. */
const smelts = (acts: [string, Record<string, unknown>][]) => acts.filter(([n]) => n === 'smelt-item').map(([, a]) => [a.inputItem, a.inputCount, a.takeOutput]);

test('smelt: no goal of the chores waits at the furnace for its output any more (smelt-item with takeOutput true): the project\'s own few smelts may', (t) => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'client', 'brain', 'chores.ts'), 'utf8');
  t.true(src.includes("'smelt-item'"));
  t.notRegex(src, /takeOutput:\s*true/);
  t.false(smelt.cuts!(snap([{ slot: 0, name: 'raw_gold', count: 31 }, { slot: 1, name: 'coal', count: 4 }]), world()), 'it stops nothing');
});

test('smelt: the same ore cooking is topped up with what the input has room for, fuel for what goes in; with no room the ore carried waits, unwanted, till enough has cooked', async (t) => {
  const g = { now: NOW };
  const items: InventoryItem[] = [{ slot: 0, name: 'raw_gold', count: 20 }, { slot: 1, name: 'coal', count: 3 }];
  const h = homeGame(items, g);
  // 36 raw gold loaded a minute ago: 6 cooked, 30 cooking on 4 coal
  Object.assign(h.f, { input: { name: 'raw_gold', count: 30 }, fuel: { name: 'coal', count: 4 }, output: { name: 'gold_ingot', count: 6 }, at: NOW });
  const w = world({ lastDone: { furnace: NOW - 63_000, oreBatch: NOW - 63_000 }, furnaceLoad: { item: 'raw_gold', count: 36, at: NOW - 63_000 } });
  t.is(smelt.wants(snap(items), w), '20 raw_gold to smelt');
  t.is(await smelt.run(h.ctx(snap(items), w)), 'took 6 gold_ingot out of the furnace; loaded 20 raw_gold (3 coal), done about 10:08:45Z');
  t.deepEqual(smelts(h.acts), [['raw_gold', 20, false]]);
  t.deepEqual(h.f.input, { name: 'raw_gold', count: 50 });
  t.deepEqual(w.furnaceLoad, { item: 'raw_gold', count: 50, at: NOW });
  t.is(h.carried('raw_gold'), 0);
  // 30 more home: 45 still to cook leave room for 19, so they wait (no run that would put in a few and want again)
  items.push({ slot: 5, name: 'raw_gold', count: 30 }, { slot: 6, name: 'coal', count: 4 });
  t.is(smelt.wants(snap(items, { now: NOW + 60_000 }), w), null);
  // 34 left to cook: room for the 30
  t.is(smelt.wants(snap(items, { now: NOW + 16 * 10_500 }), w), '30 raw_gold to smelt');
});

test('smelt: a load is taken out by the next run once its time is up (wanted for that alone), and forgotten; a furnace that would not open is forgotten too, not wanted again at once', async (t) => {
  const g = { now: NOW };
  const items: InventoryItem[] = [...gear()];
  const h = homeGame(items, g);
  Object.assign(h.f, { output: { name: 'gold_ingot', count: 31 } });
  const w = world({ lastDone: { furnace: NOW - 6 * 60_000, oreBatch: NOW - 6 * 60_000 }, furnaceLoad: { item: 'raw_gold', count: 31, at: NOW - 6 * 60_000 } });
  // still cooking a minute before its time: nothing to do
  t.is(smelt.wants(snap(items, { now: NOW - 6 * 60_000 + 30 * 10_500 }), w), null);
  t.is(smelt.wants(snap(items), w), 'the furnace\'s 31 raw_gold cooked: to take out');
  t.is(await smelt.run(h.ctx(snap(items), w)), 'took 31 gold_ingot out of the furnace');
  t.is(h.carried('gold_ingot'), 31);
  t.is(w.furnaceLoad, undefined);
  t.is(smelt.wants(snap(items, { now: NOW + 5000 }), w), null);
  // the furnace would not open (from the yard, nor walked to): the load forgotten, the half-hourly look takes the rest
  const shut = world({ lastDone: { furnace: NOW - 6 * 60_000 }, furnaceLoad: { item: 'raw_gold', count: 31, at: NOW - 6 * 60_000 } });
  const ctx = { ...h.ctx(snap(items), shut), call: (async (m: string) => { if (m === 'furnace.open') throw new Error('furnace too far to open'); return h.call(m); }) as GoalContext['call'] };
  t.is(await smelt.run(ctx), 'nothing to smelt');
  t.is(shut.furnaceLoad, undefined);
  t.is(smelt.wants(snap(items, { now: NOW + 5000 }), shut), null);
});

test('smelt: no room in the pockets for what the furnace has cooked, no want (the stash goes first, and makes it), nor the furnace\'s turn for a job; room in the stacks of it carried will do', async (t) => {
  const { furnaceTurn } = await import('../../src/client/brain/chores.js');
  const cobble = (n: number, from: number) => Array.from({ length: n }, (_, i): InventoryItem => ({ slot: from + i, name: 'cobblestone', count: 64 }));
  // 36/36: 15 raw gold and coal carried, the load of 31 in the furnace 10 cooked (room for the 15 in its input)
  const full = [{ slot: 0, name: 'raw_gold', count: 15 }, { slot: 1, name: 'coal', count: 5 }, { slot: 2, name: 'gold_ingot', count: 60 }, ...cobble(33, 3)];
  const s = snap(full);
  t.is(s.slotsUsed, 36);
  const w = world({ lastDone: { furnace: NOW - 60_000, stash: NOW - 40 * 60_000 }, furnaceLoad: { item: 'raw_gold', count: 31, at: NOW - 10 * 10_500 } });
  t.is(smelt.wants(s, w), null);
  t.regex(stash.wants(s, w) ?? '', /^36\/36 slots used/);
  // no turn at the furnace for a job or the project either: on it (FURNACE_TURN) it would go ahead of the stash (60)
  // that makes the room, for a load the smelt cannot put in
  const turned = { ...w, lastDone: { furnace: NOW - 60_000, oreBatch: NOW - 60_000 } };
  t.false(furnaceTurn(s, turned, 0));
  // done, and the 31 ingots with nowhere to go: no want either
  t.is(smelt.wants(snap(full, { now: NOW + 10 * 60_000 }), w), null);
  // a slot free: wanted, and the turn is there
  t.is(smelt.wants(snap(full.slice(0, 35)), w), '15 raw_gold to smelt');
  t.true(furnaceTurn(snap(full.slice(0, 35)), turned, 0));
  // or room for the 10 cooked in the gold ingots carried
  t.is(smelt.wants(snap([...full.slice(0, 2), { slot: 2, name: 'gold_ingot', count: 50 }, ...cobble(33, 3)]), w), '15 raw_gold to smelt');
});

test('smelt: raw iron from the chests loads and goes, and while it cooks it counts as the ingots to come (the want is for what is still short, not the same 16 again)', async (t) => {
  const g = { now: NOW };
  const items: InventoryItem[] = [...gear()];
  const chest: Record<string, number> = { raw_iron: 40, coal: 10 };
  const h = homeGame(items, g, chest);
  const w = world({ lastDone: { furnace: NOW - 60_000 }, chestItems: { '1,64,0': chest } });
  t.is(smelt.wants(snap(items), w), '16 raw iron in the chests to smelt for the gear');
  t.is(await smelt.run(h.ctx(snap(items), w)), 'loaded 16 raw_iron (2 coal), done about 10:02:48Z (from the chests)');
  t.deepEqual(smelts(h.acts), [['raw_iron', 16, false]]);
  t.like(w.furnaceLoad, { item: 'raw_iron', count: 16 });
  t.is(smelt.wants(snap(items, { now: NOW + 5000 }), w), '8 raw iron in the chests to smelt for the gear');
});

test('smelt: charcoal from logs loads and goes, and its load counts as the coal to come (no second load of logs while it cooks)', async (t) => {
  const g = { now: NOW };
  const items: InventoryItem[] = [...gear(), { slot: 20, name: 'oak_log', count: 20 }, { slot: 21, name: 'oak_planks', count: 6 }];
  const h = homeGame(items, g);
  const w = world({ lastDone: { furnace: NOW - 60_000 } });
  t.is(smelt.wants(snap(items), w), 'low on coal: charcoal from logs');
  t.is(await smelt.run(h.ctx(snap(items), w)), 'loaded 8 oak_log (6 oak_planks), done about 10:01:24Z (charcoal)');
  t.deepEqual(smelts(h.acts), [['oak_log', 8, false]]);
  t.is(smelt.wants(snap(items, { now: NOW + 5000 }), w), null);
  // cooked and taken out: 8 charcoal, enough
  g.now = NOW + 90_000;
  t.is(await smelt.run(h.ctx(snap(items, { now: g.now }), w)), 'took 8 charcoal out of the furnace');
  t.is(h.carried('charcoal'), 8);
});

test('smelt: logs burnt as their own fuel (no planks carried) come out of the same stack as the load: the load is what the furnace\'s input holds, not all the logs gone (14 gone were 8 loaded and 6 burnt)', async (t) => {
  const g = { now: NOW };
  const items: InventoryItem[] = [...gear(), { slot: 20, name: 'oak_log', count: 20 }];
  const h = homeGame(items, g);
  const w = world({ lastDone: { furnace: NOW - 60_000 } });
  t.is(await smelt.run(h.ctx(snap(items), w)), 'loaded 8 oak_log (6 oak_log), done about 10:01:24Z (charcoal)');
  t.deepEqual(h.f.input, { name: 'oak_log', count: 8 });
  t.deepEqual(w.furnaceLoad, { item: 'oak_log', count: 8, at: NOW });
  // 10 carried: the fuel goes in first, and 4 are left for the input
  const ten: InventoryItem[] = [...gear(), { slot: 20, name: 'oak_log', count: 10 }];
  const h10 = homeGame(ten, { now: NOW });
  const w10 = world({ lastDone: { furnace: NOW - 60_000 } });
  t.is(await smelt.run(h10.ctx(snap(ten), w10)), 'loaded 4 oak_log (6 oak_log), done about 10:00:42Z (charcoal)');
  t.deepEqual(h10.f.input, { name: 'oak_log', count: 4 });
  t.deepEqual(w10.furnaceLoad, { item: 'oak_log', count: 4, at: NOW });
});

test('smelt: no more goes in than the fuel carried cooks (fuelFor\'s last resort, a few planks: the rest of a load sat unlit, its time reckoned for all of it), the rest kept for the next load; the fuel said is what left the pockets, and none when the fuel slot holds another kind', async (t) => {
  // no coal in the chests: the 2 planks carried cook 3 of the 31 raw gold
  const items: InventoryItem[] = [...gear(), { slot: 20, name: 'raw_gold', count: 31 }, { slot: 21, name: 'oak_planks', count: 2 }];
  const h = homeGame(items, { now: NOW });
  const w = world({ lastDone: { furnace: NOW - 60_000 } });
  t.is(smelt.wants(snap(items), w), '31 raw_gold to smelt');
  t.is(await smelt.run(h.ctx(snap(items), w)), 'loaded 3 raw_gold (2 oak_planks), done about 10:00:31Z; 28 for the next load');
  t.deepEqual(smelts(h.acts), [['raw_gold', 3, false]]);
  t.deepEqual(w.furnaceLoad, { item: 'raw_gold', count: 3, at: NOW });
  t.is(h.carried('raw_gold'), 28);
  // nothing left to burn: no want for the rest (no run that would load nothing and want again)
  t.is(smelt.wants(snap(items, { now: NOW + 5000 }), w), null);
  // coal left in the fuel slot (another goal took the last load out, oreAside) and charcoal carried: smelt-item puts
  // none of the charcoal in, and the line does not say it did
  const more: InventoryItem[] = [...gear(), { slot: 20, name: 'raw_gold', count: 64 }, { slot: 21, name: 'charcoal', count: 8 }];
  const h2 = homeGame(more, { now: NOW });
  Object.assign(h2.f, { fuel: { name: 'coal', count: 5 } });
  t.is(await smelt.run(h2.ctx(snap(more), world({ lastDone: { furnace: NOW - 60_000 } }))), 'loaded 64 raw_gold (none of the charcoal went in), done about 10:11:12Z');
  t.is(h2.carried('charcoal'), 8);
});

test('smelt: the ore cooking comes first, topped up, ahead of another ore carried (that one would wait for the load\'s time): in the want and in the load', async (t) => {
  const items: InventoryItem[] = [{ slot: 0, name: 'raw_iron', count: 10 }, { slot: 1, name: 'raw_gold', count: 10 }, { slot: 2, name: 'coal', count: 10 }];
  const mem = () => world({ lastDone: { furnace: NOW - 30_000 }, furnaceLoad: { item: 'raw_gold', count: 20, at: NOW - 30_000 } });
  t.is(smelt.wants(snap(items), mem()), '10 raw_gold to smelt');
  const h = homeGame(items, { now: NOW });
  Object.assign(h.f, { input: { name: 'raw_gold', count: 20 }, fuel: { name: 'coal', count: 3 }, at: NOW });
  const w = mem();
  t.is(await smelt.run(h.ctx(snap(items), w)), 'loaded 10 raw_gold (1 coal), done about 10:05:15Z');
  t.deepEqual(smelts(h.acts), [['raw_gold', 10, false]]);
  t.deepEqual(h.f.input, { name: 'raw_gold', count: 30 });
  t.is(h.carried('raw_iron'), 10);
});

test('stash: the ore the smelt is to load stays carried, while the furnace holds a load or the chests hold coal for it; a trip\'s room still takes it to the chests', (t) => {
  const items = [...gear(), { slot: 20, name: 'raw_gold', count: 15 }, { slot: 21, name: 'bone', count: 3 }];
  const goes = (w: WorldMemory, kind?: Parameters<typeof stashKeep>[1]) => stashPlan(items, stashKeep(w, kind)).deposit.map(d => d.name);
  const loaded = world({ furnaceLoad: { item: 'raw_gold', count: 64, at: NOW } });
  t.false(goes(loaded).includes('raw_gold'));
  t.true(goes(loaded).includes('bone'));
  t.false(goes(world({ chestItems: { '1,64,0': { coal: 40 } } })).includes('raw_gold'));
  // nothing to burn known and nothing cooking, or no furnace: into the chests as ever
  t.true(goes(world()).includes('raw_gold'));
  t.true(goes({ ...loaded, landmarks: { chests: [CHEST], farmland: [] } }).includes('raw_gold'));
  // making room for a trip: as ever
  t.true(goes(loaded, 'trip').includes('raw_gold'));
});

test('furnaceLine: what the furnace cooks as the smelt left it, for brain-status', (t) => {
  t.is(furnaceLine(world(), NOW), '');
  const w = world({ furnaceLoad: { item: 'raw_gold', count: 31, at: NOW } });
  t.is(furnaceLine(w, NOW), ' (cooking 31 raw_gold, done about 10:05:25Z)');
  t.is(furnaceLine(w, NOW + 10 * 60_000), ' (31 raw_gold cooked, to take out)');
});

/** As the live furnace stands from home ((-542, 63, 2193) from (-549, 63, 2183)): 12 out, past NEAR_HOME. */
const FAR_FURNACE = { x: 7, y: 64, z: 10 };
/** Where a run at the furnace leaves the bot (11.4 from home), by the chest (within 10), and the live bed (15.6). */
const BY_FURNACE = { x: 7, y: 64, z: 9 };
const CHEST_AT = { x: 2, y: 64, z: -3 };
const BY_CHEST = { x: 2, y: 64, z: -2 };
const BED = { x: 12, y: 64, z: 10 };
/** The pockets of 12:04:40Z in kind: 17 kinds of a deep trip's haul beside the kit. */
const HAUL = ['redstone', 'lapis_lazuli', 'diamond', 'emerald', 'flint', 'bone', 'string', 'gunpowder', 'quartz', 'amethyst_shard', 'clay_ball',
  'brick', 'feather', 'leather', 'paper', 'book', 'slime_ball'];

/**
 * The brain over the home in kind (homeGame) with `goals`: the furnace 12 from home, the one chest by home, the bot at
 * `at`, by day. A put-away in the chest and a walk (move-to-position) are walks the brain looks in on: each waits for
 * the next tick, or the brain's cancel; the bot is where its last call put it (at the chest, at the furnace). Ticks
 * every 2.5 s of the clock. `runs` reads the brain's log: its goals' starts, ends and stops, and any LOOP.
 */
function brainAtHome(o: { t0: number; items: InventoryItem[]; at: { x: number; y: number; z: number }; chest: Record<string, number>; mem: Partial<WorldMemory>; goals: Goal[]; furnace?: Partial<{ input: Stack; fuel: Stack; output: Stack }> }) {
  const g = { now: o.t0, pos: o.at, walks: [] as ((go: boolean) => void)[] };
  const h = homeGame(o.items, g, o.chest);
  Object.assign(h.f, o.furnace ?? {}, { at: o.t0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smelt-'));
  const logFile = path.join(dir, 'brain.log'), memoryFile = path.join(dir, 'brain.json');
  const k = `${CHEST_AT.x},${CHEST_AT.y},${CHEST_AT.z}`;
  fs.writeFileSync(memoryFile, JSON.stringify({
    'seed:1': { landmarks: { chests: [CHEST_AT], farmland: [], furnace: FAR_FURNACE, foundAt: o.t0 }, leash: 96, chestItems: { [k]: { ...o.chest } }, chestSize: { [k]: 54 }, ...o.mem }
  }));
  const walk = () => new Promise<boolean>(r => g.walks.push(r));
  const reply = (r: { ok: boolean; text: string }) => ({ content: [{ type: 'text' as const, text: r.text }], isError: !r.ok });
  const act = async (tool: string, a: Record<string, unknown>) => {
    if (tool === 'store-in-chest' || tool === 'take-from-chest') g.pos = BY_CHEST;
    if (tool === 'smelt-item') g.pos = BY_FURNACE;
    if (tool === 'store-in-chest' || tool === 'move-to-position') {
      if (!await walk()) return reply({ ok: false, text: 'cancelled' });
      if (tool === 'move-to-position') { g.pos = { x: Number(a.x), y: Number(a.y), z: Number(a.z) }; return reply({ ok: true, text: 'Arrived' }); }
    }
    return reply(await h.act(tool, a));
  };
  const rt = {
    actions: new Proxy({}, { get: (_, tool: string) => (a: Record<string, unknown> = {}) => act(tool, a) }),
    call: (async (m: string, a?: Record<string, unknown>) => {
      if (m === 'furnace.open') g.pos = BY_FURNACE;
      if (m === 'cancel') { for (const r of g.walks.splice(0)) r(false); return {}; }
      if (m === 'world.region') return { blocks: [] };
      return h.call(m, a);
    }) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: g.pos, block: g.pos, timeOfDay: 1000, hashedSeed: '1',
      dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 }),
    home: () => ({ x: 0, y: 64, z: 0, dimension: 'overworld' }),
    lastDeath: () => undefined, setManualHook: () => undefined, builtNear: () => [], setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  } as unknown as ClientRuntime;
  const brain = new Brain(rt, { tickMs: 1e9, now: () => g.now, goals: o.goals, logFile, memoryFile });
  const settle = () => new Promise(r => setTimeout(r, 20));
  const until = async (end: number) => {
    brain.setEnabled(true);
    await brain.tick(); await settle();
    while (g.now < end) {
      g.now += 2500;
      await brain.tick(); await settle();
      for (const r of g.walks.splice(0)) r(true);
      await settle();
    }
    brain.setEnabled(false);
    await settle();
  };
  const lines = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => l.slice(25));
  const runs = () => lines().filter(l => /^(start|done|stopping|stopped|failed) |LOOP/.test(l))
    .map(l => l.replace(/ in \d+s:/, ':').replace(/done about \d\d:\d\d:\d\dZ/, 'done about T'));
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  return { g, h, brain, until, lines, runs, done };
}
const at1204 = Date.UTC(2026, 10, 15, 12, 4, 40);

test('the LOOP of 12:04-12:10Z replayed: the stash runs to its end, the smelt\'s want for the 31 raw gold stopping it at no walk, and the ore goes in after it, all of it, with nothing waiting at the furnace', async (t) => {
  // live: "start stash: 27/36 slots used", 2 s later "stopping stash: smelt is more urgent (31 raw_gold to smelt)", the
  // smelt 171 s at the furnace for 16, the same again with 15, and the LOOP
  const items: InventoryItem[] = [...gear(), { slot: 13, name: 'raw_gold', count: 31 }, ...HAUL.map((name, i) => ({ slot: 14 + i, name, count: 1 }))];
  t.is(items.filter(i => i.slot < 36).length, 27);
  // the last smelt run of 12:01:47Z (its stamps); the furnace empty, the bot by it; the coal in the chest
  const ran = at1204 - 173_000;
  const r = brainAtHome({ t0: at1204, items, at: BY_FURNACE, chest: { coal: 130 }, mem: { lastDone: { furnace: ran, oreBatch: ran, stash: at1204 - 40 * 60_000 } }, goals: [smelt, stash] });
  await r.until(at1204 + 7 * 60_000);
  t.deepEqual(r.runs(), [
    'start stash: 27/36 slots used',
    'done stash: put 17 item(s) in the chests',
    'start smelt: 31 raw_gold to smelt',
    'done smelt: loaded 31 raw_gold (4 coal), done about T'
  ]);
  // its walks to the chest went by home (within 10), where the smelt wanted all along
  t.true(Math.hypot(BY_CHEST.x, BY_CHEST.z) < NEAR_HOME);
  // the haul in the chest, the raw gold not (it stayed carried for the furnace), all of it in there and cooking
  for (const name of HAUL) t.is(r.h.carried(name), 0, name);
  t.is(r.h.carried('raw_gold'), 0);
  t.is(r.h.f.input?.name, 'raw_gold');
  t.true(r.h.f.input!.count + (r.h.f.output?.count ?? 0) === 31);
  // and nothing waited at the furnace: its smelt-item left the output, the run over at once
  t.deepEqual(smelts(r.h.acts), [['raw_gold', 31, false]]);
  t.true(r.lines().some(l => /^done smelt in 0s: /.test(l)));
  t.like(r.brain.worldMemory()?.furnaceLoad, { item: 'raw_gold', count: 31 });
  // brain-status says so: by now (12:11:40Z) the load's time is up, to be taken out by the next run from home
  t.regex(r.brain.status(), /furnace \(7, 64, 10\) \(31 raw_gold cooked, to take out\)/);
  r.done();
});

test('home from the deep trip with 79 raw gold (11:55:55Z) replayed: a stack goes in, the 15 left wait carried through the stash, and go in once the input has room for them; no run stops another, none waits at the furnace', async (t) => {
  const t0 = Date.UTC(2026, 10, 15, 11, 55, 55);
  const items: InventoryItem[] = [...gear(), { slot: 6, name: 'raw_gold', count: 64 }, { slot: 7, name: 'raw_gold', count: 15 }, ...HAUL.map((name, i) => ({ slot: 14 + i, name, count: 1 }))];
  t.is(items.filter(i => i.slot < 36).length, 28);
  // (the bot home by the chest: the smelt goes first, ahead of the stash)
  const r = brainAtHome({ t0, items, at: BY_CHEST, chest: { coal: 130 }, mem: { lastDone: { furnace: t0 - 40 * 60_000, stash: t0 - 40 * 60_000 } }, goals: [smelt, stash] });
  await r.until(t0 + 5 * 60_000);
  t.deepEqual(r.runs(), [
    'start smelt: 79 raw_gold to smelt',
    'done smelt: loaded 64 raw_gold (8 coal), done about T; 15 for the next load',
    // (the stack's slot came free, and the coal fetched for it all went in)
    'start stash: 27/36 slots used',
    'done stash: put 17 item(s) in the chests',
    'start smelt: 15 raw_gold to smelt',
    'done smelt: took 15 gold_ingot out of the furnace; loaded 15 raw_gold (2 coal), done about T'
  ]);
  t.is(r.h.carried('raw_gold'), 0);
  t.false((r.brain.worldMemory()?.chestItems?.['2,64,-3'] ?? {}).raw_gold! > 0, 'no raw gold in the chest');
  t.deepEqual(smelts(r.h.acts), [['raw_gold', 64, false], ['raw_gold', 15, false]]);
  t.false(r.lines().some(l => /^done smelt in [1-9]/.test(l)));
  r.done();
});

test('the morning of 16:22:59-16:23:14Z replayed: the villager search walks out by home with raw gold carried and the night\'s load done, the smelt wants there, and stops nothing: it goes when the search is back', async (t) => {
  const t0 = Date.UTC(2026, 10, 15, 16, 22, 59);
  const items: InventoryItem[] = [...gear(), { slot: 13, name: 'raw_gold', count: 21 }];
  // the evening's run loaded 16 raw gold at 16:15:34Z (cooked through the night) and was cut before the rest
  const loaded = Date.UTC(2026, 10, 15, 16, 15, 34);
  const out = [{ x: 6, y: 64, z: 2 }, { x: -16, y: 64, z: 0 }, { x: -60, y: 64, z: 0 }, { x: -16, y: 64, z: 0 }, { x: 1, y: 64, z: 1 }];
  const wanted: (string | null)[] = [];
  let r: ReturnType<typeof brainAtHome> | undefined;
  let searched = false;
  const villagers: Goal = {
    name: 'work: villagers', priority: 17, timeoutMs: 12 * 60_000, retryMs: 5 * 60_000,
    wants: () => (searched ? null : 'west: 384 blocks out'),
    run: async ctx => {
      searched = true;
      for (const p of out) {
        await ctx.act('move-to-position', { ...p, range: 1 });
        // what the smelt says to the brain from here (within 10 of home on the way out and back)
        const here = snap(items, { now: r!.g.now, position: p, distHome: Math.hypot(p.x, p.z) });
        wanted.push(smelt.wants(here, r!.brain.worldMemory()!));
      }
      return 'no village west within the village range (384 from home); back home';
    }
  };
  r = brainAtHome({
    t0, items, at: BED, chest: { coal: 130 }, goals: [smelt, villagers], furnace: { output: { name: 'gold_ingot', count: 16 } },
    mem: { lastDone: { furnace: loaded, oreBatch: loaded, stash: t0 - 5 * 60_000 }, furnaceLoad: { item: 'raw_gold', count: 16, at: loaded } }
  });
  await r.until(t0 + 2 * 60_000);
  // live: "stopping work: villagers: smelt is more urgent (21 raw_gold to smelt)" 4 s in, on its way to the west gate
  t.deepEqual(r.runs(), [
    'start work: villagers: west: 384 blocks out',
    'done work: villagers: no village west within the village range (384 from home); back home',
    'start smelt: 21 raw_gold to smelt',
    'done smelt: took 16 gold_ingot out of the furnace; loaded 21 raw_gold (3 coal), done about T'
  ]);
  t.deepEqual(wanted, ['21 raw_gold to smelt', null, null, null, '21 raw_gold to smelt']);
  t.deepEqual(smelts(r.h.acts), [['raw_gold', 21, false]]);
  r.done();
});

test('pack: a lot of 64 blocks a kind over the keep of 640 loose; under 128 loose, blocks crafted back; the pockets bound both', (t) => {
  // live on Nov 18: 9400 redstone, 6606 lapis, 6249 iron ingots, 3078 diamonds loose, the storage full in two days
  t.deepEqual(packPlan({ redstone: 9400, lapis_lazuli: 6606, iron_ingot: 6249, diamond: 3078, gold_ingot: 1000 }, 14), [
    { item: 'redstone', block: 'redstone_block', blocks: 64 }, { item: 'lapis_lazuli', block: 'lapis_block', blocks: 64 },
    { item: 'iron_ingot', block: 'iron_block', blocks: 64 }, { item: 'diamond', block: 'diamond_block', blocks: 64 }
  ]);
  // a full lot over the keep only: 640 + 575 stays loose
  t.deepEqual(packPlan({ redstone: PACK_KEEP + 575 }, 14), []);
  // not a pocketful free: nothing (9 stacks in, and a slot spare)
  t.deepEqual(packPlan({ redstone: 9400 }, 9), []);
  // the loose ones run low: back up to half the keep (320), 26 blocks for 90
  t.deepEqual(packPlan({ diamond: 90, diamond_block: 300 }, 14), [{ item: 'diamond', block: 'diamond_block', blocks: 26, unpack: true }]);
  t.deepEqual(packPlan({ diamond: 90, diamond_block: 5 }, 14), [{ item: 'diamond', block: 'diamond_block', blocks: 5, unpack: true }]);
  t.deepEqual(packPlan({ diamond: 200, diamond_block: 300 }, 14), []);
});

test('pack: takes nine stacks, crafts 64 blocks at the table, and puts back only what the crafting made and left', async (t) => {
  const chests = [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }];
  const contents: Record<string, Record<string, number>> = { '1,64,0': { redstone: 1300 }, '2,64,0': {}, '3,64,0': {} };
  const w = world({ landmarks: { chests, farmland: [], table: { x: 0, y: 64, z: 1 } }, chestItems: contents, chestAssign: { '1,64,0': 'ores', '2,64,0': 'wood', '3,64,0': 'stone' } });
  // it carries 5 redstone of its own: those stay carried
  const inv = new Map<string, number>([['redstone', 5]]);
  const items = () => [...gear(), ...[...inv].filter(([, n]) => n > 0).map(([name, count], i) => ({ slot: 20 + i, name, count }))];
  t.regex(packOres.wants(snap(gear()), w) ?? '', /^pack 576 redstone into redstone_block$/);
  const acts: string[] = [];
  const reply = (k: string) => `It holds: ${Object.entries(contents[k]).filter(([, v]) => v > 0).map(([n, v]) => `${n} x${v}`).join(', ') || 'nothing'}.`;
  const ctx = {
    s: snap(gear()), world: w, signal: new AbortController().signal, progress: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    call: (async (m: string, p: Record<string, number>) => {
      // (no look into every chest first: 54 of them took the first live run's whole time)
      if (m === 'chest.open') { acts.push(`chest.open ${p.x},${p.y},${p.z}`); return { items: contents[`${p.x},${p.y},${p.z}`] }; }
      if (m === 'inventory') return { items: items() };
      return {};
    }) as GoalContext['call'],
    act: async (tool: string, a: Record<string, unknown> = {}) => {
      const k = `${a.x},${a.y},${a.z}`, item = String(a.item), n = Number(a.count);
      if (tool === 'craft-item') {
        const times = Math.min(Number(a.amount), Math.floor((inv.get('redstone') ?? 0) / 9));
        acts.push(`craft-item ${String(a.outputItem)} ${Number(a.amount)}`);
        inv.set('redstone', (inv.get('redstone') ?? 0) - 9 * times);
        inv.set('redstone_block', (inv.get('redstone_block') ?? 0) + times);
        return { ok: true, text: `Successfully crafted redstone_block ${times} time(s)` };
      }
      acts.push(`${tool} ${k} ${item} ${n}`);
      if (tool === 'take-from-chest') {
        contents[k][item] -= n;
        inv.set(item, (inv.get(item) ?? 0) + n);
        return { ok: true, text: `Took ${n} ${item} from the chest. ${reply(k)}` };
      }
      contents[k][item] = (contents[k][item] ?? 0) + n;
      inv.set(item, (inv.get(item) ?? 0) - n);
      return { ok: true, text: `Stored ${n} ${item} in the chest. ${reply(k)}` };
    }
  } as unknown as GoalContext;
  t.is(await packOres.run(ctx), 'packed 576 redstone into redstone_block');
  t.deepEqual(acts, ['take-from-chest 1,64,0 redstone 576', 'craft-item redstone_block 64', 'store-in-chest 1,64,0 redstone_block 64']);
  t.deepEqual(contents['1,64,0'], { redstone: 724, redstone_block: 64 });
  t.is(inv.get('redstone'), 5);
  // ran just now: not again for a while
  t.is(packOres.wants(snap(gear()), w), null);
});
