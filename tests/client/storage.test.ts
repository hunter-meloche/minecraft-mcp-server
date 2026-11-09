import test from 'ava';
import { CATEGORIES, assignChests, giveChests, type ChestContents, categoryOf, depositPlan, misplaced, stackSize } from '../../src/client/brain/storage.js';

const P = (x: number) => ({ x, y: 64, z: 0 });
const K = (x: number) => `${x},64,0`;

test('categories sort the usual items', (t) => {
  const cases: Record<string, string> = {
    raw_iron: 'ores', iron_ingot: 'ores', gold_nugget: 'ores', diamond: 'ores', coal: 'ores', iron_block: 'ores', 'minecraft:redstone': 'ores',
    cobblestone: 'stone', cobbled_deepslate: 'stone', dirt: 'stone', gravel: 'stone', stone_bricks: 'stone', polished_andesite: 'stone',
    oak_log: 'wood', spruce_planks: 'wood', stick: 'wood', stripped_birch_log: 'wood',
    bread: 'food', cooked_beef: 'food', carrot: 'food', golden_carrot: 'food',
    wheat_seeds: 'farming', oak_sapling: 'farming', wheat: 'farming', sugar_cane: 'farming', bone_meal: 'farming', egg: 'farming',
    rotten_flesh: 'mobdrops', spider_eye: 'mobdrops', bone: 'mobdrops', string: 'mobdrops', leather: 'mobdrops', ender_pearl: 'mobdrops',
    iron_pickaxe: 'gear', diamond_helmet: 'gear', shield: 'gear', bucket: 'gear', water_bucket: 'gear', fishing_rod: 'gear', shears: 'gear', bow: 'gear',
    torch: 'misc', white_wool: 'misc'
  };
  for (const [item, cat] of Object.entries(cases)) t.is(categoryOf(item) as string, cat, item);
});

test('stack sizes come from minecraft-data', (t) => {
  t.is(stackSize('cobblestone'), 64);
  t.is(stackSize('egg'), 16);
  t.is(stackSize('iron_pickaxe'), 1);
});

test('one chest per category, most-needed first when there are too few', (t) => {
  t.deepEqual(assignChests([P(0), P(1), P(2)]), { [K(0)]: 'food', [K(1)]: 'gear', [K(2)]: 'ores' });
  const all = assignChests(CATEGORIES.map((_, i) => P(i)));
  t.deepEqual(Object.values(all), [...CATEGORIES] as string[]);
});

test('existing assignments are kept and a new chest takes a missing category', (t) => {
  const prev = { [K(0)]: 'wood', [K(1)]: 'stone' };
  t.deepEqual(assignChests([P(0), P(1), P(2)], CATEGORIES, {}, prev), { [K(0)]: 'wood', [K(1)]: 'stone', [K(2)]: 'food' });
});

test('a category keeps no second chest while another has none', (t) => {
  const prev = { [K(0)]: 'stone', [K(1)]: 'stone', [K(2)]: 'wood' };
  const contents: ChestContents = { [K(0)]: { cobblestone: 500 }, [K(1)]: { cobblestone: 20 } };
  t.deepEqual(assignChests([P(0), P(1), P(2)], ['stone', 'wood', 'food'], contents, prev), { [K(0)]: 'stone', [K(1)]: 'food', [K(2)]: 'wood' });
});

test('an unassigned chest gets the category it already holds', (t) => {
  const contents: ChestContents = { [K(0)]: { oak_log: 40 }, [K(1)]: { cobblestone: 100, dirt: 3 } };
  t.deepEqual(assignChests([P(0), P(1)], CATEGORIES, contents), { [K(0)]: 'wood', [K(1)]: 'stone' });
});

test('extra chests go to the busiest category', (t) => {
  const cats = ['stone', 'wood'];
  const contents: ChestContents = { [K(0)]: { cobblestone: 1500 }, [K(1)]: { oak_log: 10 } };
  t.deepEqual(assignChests([P(0), P(1), P(2)], cats, contents), { [K(0)]: 'stone', [K(1)]: 'wood', [K(2)]: 'stone' });
  // with nothing seen, extras spread out instead of piling on the first category
  t.deepEqual(Object.values(assignChests([P(0), P(1), P(2), P(3)], cats)), ['stone', 'wood', 'stone', 'wood']);
});

test('deposits go to the category chest, keeping what the kit needs', (t) => {
  const assign = { [K(0)]: 'stone', [K(1)]: 'ores', [K(2)]: 'misc' };
  const items = [
    { slot: 0, name: 'cobblestone', count: 64 }, { slot: 1, name: 'cobblestone', count: 30 },
    { slot: 2, name: 'raw_iron', count: 12 }, { slot: 3, name: 'diamond_pickaxe', count: 1 },
    { slot: 39, name: 'iron_helmet', count: 1 }
  ];
  const plan = depositPlan(items, it => (it.name === 'cobblestone' ? 32 : it.name === 'diamond_pickaxe' ? 1 : 0), assign);
  t.deepEqual(plan.moves, [{ chest: K(0), name: 'cobblestone', count: 62 }, { chest: K(1), name: 'raw_iron', count: 12 }]);
  t.deepEqual(plan.full, []);
  t.deepEqual(plan.unplaced, []);
  const kept = depositPlan(items, new Set(['cobblestone', 'diamond_pickaxe']), assign);
  t.deepEqual(kept.moves, [{ chest: K(1), name: 'raw_iron', count: 12 }]);
});

test('a full category overflows to another chest of it, then misc, and is reported', (t) => {
  const assign = { [K(0)]: 'stone', [K(1)]: 'stone', [K(2)]: 'misc' };
  // first stone chest has one partial stack of room; second is full
  const contents: ChestContents = { [K(0)]: { cobblestone: 64 * 26 + 60 }, [K(1)]: { dirt: 64 * 27 } };
  const plan = depositPlan([{ slot: 0, name: 'cobblestone', count: 10 }], new Set(), assign, contents);
  t.deepEqual(plan.moves, [{ chest: K(0), name: 'cobblestone', count: 4 }, { chest: K(2), name: 'cobblestone', count: 6 }]);
  t.deepEqual(plan.full, ['stone']);
});

test('a category with no chest goes to misc, and what fits nowhere stays carried', (t) => {
  const plan = depositPlan([{ slot: 0, name: 'oak_log', count: 5 }], new Set(), { [K(0)]: 'misc' });
  t.deepEqual(plan.moves, [{ chest: K(0), name: 'oak_log', count: 5 }]);
  t.deepEqual(plan.full, ['wood']);
  const none = depositPlan([{ slot: 0, name: 'oak_log', count: 5 }], new Set(), { [K(0)]: 'stone' });
  t.deepEqual(none.moves, []);
  t.deepEqual(none.unplaced, [{ name: 'oak_log', count: 5 }]);
});

test('stacks merge: the chest already holding an item is filled first', (t) => {
  const assign = { [K(0)]: 'stone', [K(1)]: 'stone' };
  const plan = depositPlan([{ slot: 0, name: 'dirt', count: 3 }], new Set(), assign, { [K(1)]: { dirt: 10 } });
  t.deepEqual(plan.moves, [{ chest: K(1), name: 'dirt', count: 3 }]);
});

test('misplaced items move to their own chest, a few at a time', (t) => {
  const assign = { [K(0)]: 'stone', [K(1)]: 'wood', [K(2)]: 'misc' };
  const contents: ChestContents = { [K(0)]: { cobblestone: 50, oak_log: 20, torch: 5, diamond: 2 }, [K(2)]: { dirt: 8 } };
  t.deepEqual(misplaced(assign, contents), [
    { from: K(0), to: K(1), name: 'oak_log', count: 20 },
    { from: K(0), to: K(2), name: 'torch', count: 5 },
    { from: K(2), to: K(0), name: 'dirt', count: 8 }
  ]); // diamonds have no ores chest yet: they stay
  t.is(misplaced(assign, contents, 1).length, 1);
});

test('misplaced moves only what the target has room for', (t) => {
  const assign = { [K(0)]: 'stone', [K(1)]: 'wood' };
  const contents: ChestContents = { [K(0)]: { oak_log: 10 }, [K(1)]: { oak_planks: 64 * 26 } };
  t.deepEqual(misplaced(assign, contents), [{ from: K(0), to: K(1), name: 'oak_log', count: 10 }]);
  const tight: ChestContents = { [K(0)]: { oak_log: 10 }, [K(1)]: { oak_planks: 64 * 27 } };
  t.deepEqual(misplaced(assign, tight), []);
});

test('a chest built for a full category is theirs, not the busiest one\'s', (t) => {
  // the incident: the gear chest full of one-per-slot tools, 881 cobblestone in stone: the new chest went to stone
  const chests = [{ x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }, { x: 2, y: 63, z: 0 }, { x: 3, y: 64, z: 0 }];
  const contents: ChestContents = {
    '0,63,0': { iron_sword: 1, iron_axe: 1, bow: 2 }, '1,63,0': { cobblestone: 881 }, '2,63,0': { oak_log: 900 }, '3,64,0': {}
  };
  const prev = { '0,63,0': 'gear', '1,63,0': 'stone', '2,63,0': 'wood' };
  const before = assignChests(chests, ['gear', 'stone', 'wood'], contents, prev);
  t.not(before['3,64,0'], 'gear'); // what used to happen
  const r = giveChests(before, contents, ['gear'], ['3,64,0']);
  t.is(r.assign['3,64,0'], 'gear');
  t.deepEqual(r.short, []);
  t.is(assignChests(chests, ['gear', 'stone', 'wood'], contents, r.assign)['3,64,0'], 'gear'); // and it stays
});

test('an empty spare chest is lent to a full category before building another', (t) => {
  const assign = { a: 'gear', b: 'stone', c: 'stone', d: 'wood', e: 'misc', f: 'misc' };
  const contents: ChestContents = { a: { bow: 27 }, b: { cobblestone: 64 }, c: {}, d: {}, e: {}, f: {} };
  const r = giveChests(assign, contents, ['gear', 'ores']);
  t.is(r.assign.c, 'gear'); // stone has another chest; wood's only chest and misc stay
  t.is(r.assign.d, 'wood');
  t.deepEqual(r.short, ['ores']);
  t.deepEqual(giveChests({ a: 'gear', c: 'stone' }, { a: {}, c: {} }, ['gear']).short, ['gear']); // stone's only chest
});
