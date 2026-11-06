import test from 'ava';
import { diamondsWanted, tripCheck } from '../../src/client/brain/deep.js';
import { kitNeeds } from '../../src/client/brain/kit.js';

const item = (slot: number, name: string, count = 1) => ({ slot, name, count });
const world = (chest: Record<string, number> = {}) => ({ landmarks: { chests: [{ x: 0, y: 0, z: 0 }], farmland: [] }, leash: 96, chestItems: { '0,0,0': chest } });

test('diamondsWanted: the whole diamond kit and the table, less what is diamond already and the diamonds there are', (t) => {
  const iron = [item(36, 'iron_pickaxe'), item(37, 'iron_sword'), item(5, 'iron_helmet'), item(6, 'iron_chestplate'), item(7, 'iron_leggings'), item(8, 'iron_boots')];
  t.is(diamondsWanted({ items: iron }, world()), 3 + 2 + 5 + 8 + 7 + 4 + 2);
  t.is(diamondsWanted({ items: [...iron.slice(1), item(36, 'diamond_pickaxe')] }, world({ diamond: 4 })), 2 + 5 + 8 + 7 + 4 + 2 - 4);
});

test('tripCheck: the worst armour piece counts, and a missing one is 0', (t) => {
  const items = [item(5, 'iron_helmet'), item(6, 'iron_chestplate'), item(7, 'iron_leggings')];
  const s = { items, counts: new Map([['torch', 20], ['cobblestone', 40]]), health: 20, food: 20, timeOfDay: 1000, slotsUsed: 10 };
  const c = tripCheck(s as never);
  t.is(c.armorTier, 0);
  t.is(c.torches, 20);
  t.is(c.blocks, 40);
});

test('kit: a sound iron pickaxe with 3 diamonds and sticks about: upgrade to diamond', (t) => {
  const items = [item(36, 'iron_pickaxe'), item(37, 'iron_sword'), item(38, 'iron_axe'), item(39, 'iron_shovel'), item(40, 'iron_hoe'),
    item(5, 'iron_helmet'), item(6, 'iron_chestplate'), item(7, 'iron_leggings'), item(8, 'iron_boots'),
    item(10, 'stone_pickaxe'), item(11, 'stick', 2), item(12, 'torch', 32), item(13, 'cobblestone', 64)];
  const up = kitNeeds(items, { diamond: 3 }).find(n => n.kind === 'pickaxe' && 'why' in n && n.why === 'upgrade');
  t.truthy(up);
  t.like(up, { have: 'iron_pickaxe', bestPossible: 'diamond_pickaxe' });
});
