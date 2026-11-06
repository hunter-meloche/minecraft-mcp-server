import test from 'ava';
import { breakOut, shelterGoal, wake } from '../../src/client/brain/goals.js';
import { food, larder, recoverGoal, retreat } from '../../src/client/brain/food.js';
import { farm, kit, lights, smelt, stash, stock } from '../../src/client/brain/chores.js';
import { pens } from '../../src/client/brain/pens.js';
import { deepTrip } from '../../src/client/brain/deep.js';
import { treeFarm } from '../../src/client/brain/farming.js';
import { caneRound } from '../../src/client/brain/cane.js';
import { enchantGoal } from '../../src/client/brain/enchant.js';
import { projectGoal } from '../../src/client/brain/project.js';
import { kitNeeds } from '../../src/client/brain/kit.js';
import type { Snapshot } from '../../src/client/brain/goals.js';

// 1 staying alive, 2 the gear, 3 the food stockpile, 4 the home (upkeep and building)
const tiers = [
  [wake, breakOut, recoverGoal(() => undefined), retreat, shelterGoal(), food],
  [kit, smelt, stash],
  [larder, farm, pens],
  [lights, deepTrip, treeFarm, caneRound, enchantGoal, projectGoal([])]
];

test('the tiers: every goal outranks every goal of the tiers below', (t) => {
  for (let i = 0; i + 1 < tiers.length; i++) {
    const low = Math.min(...tiers[i].map(g => g.priority));
    const high = Math.max(...tiers[i + 1].map(g => g.priority));
    t.true(low > high, `tier ${i + 1} (lowest ${low}) above tier ${i + 2} (highest ${high})`);
  }
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items: [], counts: new Map(), slotsUsed: 5,
  home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0, ...over
});

test('stock trips for the gear run with the gear; the rest with the home', (t) => {
  const world = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  // a stone kit: iron wanted for it
  const stone = ['stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'stone_hoe'].map((name, i) => ({ slot: i, name, count: 1 }));
  t.is(stock.urgency!(snap({ items: stone }), world), 64);
  const iron = ['iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_sword', 'stone_hoe', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
    .map((name, i) => ({ slot: i < 5 ? i : 31 + i, name, count: 1 }));
  t.is(stock.urgency!(snap({ items: [...iron, { slot: 20, name: 'torch', count: 32 }, { slot: 21, name: 'cobblestone', count: 64 }, { slot: 22, name: 'stone_pickaxe', count: 1 }, { slot: 40, name: 'shield', count: 1 }] }), world), 33);
});

test('the kit wants at least iron: a stone pickaxe gathers iron for an iron one', (t) => {
  const n = kitNeeds([{ slot: 0, name: 'stone_pickaxe', count: 1 }, { slot: 10, name: 'stick', count: 8 }], {}).find(x => x.kind === 'pickaxe' && x.why === 'below iron');
  t.like(n, { bestPossible: 'iron_pickaxe' });
  t.deepEqual(n!.plan, [{ gather: { iron_ingot: 3 } }]);
});

test('the larder: fed and healthy by day with under 60 food points at home', (t) => {
  const world = { landmarks: { chests: [], farmland: [] }, leash: 96 };
  t.regex(larder.wants(snap({ counts: new Map([['bread', 4]]) }), world) ?? '', /20 food points at home/);
  t.is(larder.wants(snap({ counts: new Map([['bread', 12]]) }), world), null);
  t.is(larder.wants(snap({ health: 10 }), world), null);
});
