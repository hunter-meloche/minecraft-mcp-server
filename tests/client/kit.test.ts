import test from 'ava';
import { KIT, better, carriedKit, enchantLevels, kitNeeds, slotsUsed, stashPlan, tier } from '../../src/client/brain/kit.js';
import type { InventoryItem } from '../../src/client/tools.js';

/** A full kit: diamond tools, a stone spare pickaxe, iron armour worn, torches and cobblestone. */
function kit(): InventoryItem[] {
  return [
    { slot: 0, name: 'diamond_pickaxe', count: 1, damage: 0, maxDamage: 1561 },
    { slot: 1, name: 'diamond_axe', count: 1, damage: 100, maxDamage: 1561 },
    { slot: 2, name: 'diamond_shovel', count: 1, damage: 0, maxDamage: 1561 },
    { slot: 3, name: 'diamond_sword', count: 1, damage: 0, maxDamage: 1561 },
    { slot: 4, name: 'iron_hoe', count: 1, damage: 0, maxDamage: 250 },
    { slot: 5, name: 'stone_pickaxe', count: 1, damage: 10, maxDamage: 131 },
    { slot: 6, name: 'torch', count: 20 },
    { slot: 7, name: 'cobblestone', count: 40 },
    { slot: 36, name: 'iron_boots', count: 1, damage: 0, maxDamage: 195 },
    { slot: 37, name: 'iron_leggings', count: 1, damage: 0, maxDamage: 225 },
    { slot: 38, name: 'iron_chestplate', count: 1, damage: 0, maxDamage: 240 },
    { slot: 39, name: 'iron_helmet', count: 1, damage: 0, maxDamage: 165 },
    { slot: 40, name: 'shield', count: 1, damage: 0, maxDamage: 336 }
  ];
}
const without = (items: InventoryItem[], ...names: string[]) => items.filter(i => !names.includes(i.name));

test('tiers follow Tools.java, with the armour materials slotted in', (t) => {
  t.true(tier('netherite_pickaxe') > tier('diamond_pickaxe'));
  t.true(tier('diamond_pickaxe') > tier('iron_pickaxe'));
  t.true(tier('iron_pickaxe') > tier('stone_pickaxe'));
  t.true(tier('stone_pickaxe') > tier('golden_pickaxe'));
  t.true(tier('golden_pickaxe') > tier('wooden_pickaxe'));
  t.is(tier('chainmail_helmet'), 3);
  t.is(tier('leather_boots'), 1);
  t.is(tier('torch'), 0);
  t.deepEqual(KIT.consumables, { torch: 16, cobblestone: 32 });
});

test('a full kit needs nothing', (t) => {
  t.deepEqual(kitNeeds(kit(), {}), []);
  const { best, spare } = carriedKit(kit());
  t.is(best.pickaxe?.name, 'diamond_pickaxe');
  t.is(spare?.name, 'stone_pickaxe');
  t.is(best.helmet?.slot, 39);
});

test('a worn diamond pickaxe with diamonds in the chest: craft a new one', (t) => {
  const items = kit().map(i => (i.name === 'diamond_pickaxe' ? { ...i, damage: 1500 } : i));
  items.push({ slot: 8, name: 'stick', count: 2 });
  t.deepEqual(kitNeeds(items, { diamond: 3 }).filter(n => n.why !== 'below iron'), [{
    kind: 'pickaxe', spare: true, have: 'diamond_pickaxe', why: 'worn', bestPossible: 'diamond_pickaxe', // the sound stone one is the main pickaxe now
    plan: [{ craft: 'diamond_pickaxe', times: 1, materials: { stick: 2, diamond: 3 }, fromChest: { diamond: 3 } }]
  }]);
});

test('a missing axe with only cobblestone and planks: a stone axe, sticks made from the planks', (t) => {
  const items = [...without(kit(), 'diamond_axe'), { slot: 8, name: 'oak_planks', count: 2 }];
  t.deepEqual(kitNeeds(items, {}), [{
    kind: 'axe', why: 'missing', bestPossible: 'stone_axe',
    plan: [{ craft: 'stone_axe', times: 1, materials: { stick: 2, cobblestone: 3 }, first: [{ craft: 'stick', times: 1, materials: { oak_planks: 2 } }] }]
  }]);
});

test('sticks from logs when there are no planks', (t) => {
  const items = [...without(kit(), 'diamond_sword'), { slot: 8, name: 'stripped_birch_log', count: 1 }];
  const [need] = kitNeeds(items, {});
  t.deepEqual(need.plan, [{
    craft: 'stone_sword', times: 1, materials: { stick: 1, cobblestone: 2 },
    first: [{ craft: 'birch_planks', times: 1, materials: { stripped_birch_log: 1 } }, { craft: 'stick', times: 1, materials: { birch_planks: 2 } }]
  }]);
});

test('no materials: gather for a stone tool, and the throwaway blocks', (t) => {
  const items = without(kit(), 'diamond_sword', 'cobblestone');
  t.deepEqual(kitNeeds(items, {}), [
    { kind: 'sword', why: 'missing', bestPossible: 'stone_sword', plan: [{ gather: { log: 1, cobblestone: 2 } }] },
    { kind: 'cobblestone', why: 'short', carried: 0, want: 32, plan: [{ gather: { cobblestone: 32 } }] }
  ]);
});

test('a usable sword in the chest is taken rather than crafting a worse one', (t) => {
  const items = [...without(kit(), 'diamond_sword'), { slot: 8, name: 'stick', count: 4 }];
  t.deepEqual(kitNeeds(items, { iron_sword: 1, wooden_sword: 2 }), [
    { kind: 'sword', why: 'missing', bestPossible: 'iron_sword', plan: [{ take: 'iron_sword', count: 1 }] }
  ]);
  // ...but diamonds make a better one than the chest's wooden sword.
  const [need] = kitNeeds(items, { wooden_sword: 1, diamond: 2 });
  t.is(need.plan.length, 1);
  t.like(need.plan[0], { craft: 'diamond_sword' });
});

test('wooden tools only when nothing better can be made', (t) => {
  const items = [...without(kit(), 'diamond_shovel', 'cobblestone'), { slot: 8, name: 'oak_planks', count: 3 }];
  const [need] = kitNeeds(items, {});
  t.like(need, { kind: 'shovel', bestPossible: 'wooden_shovel' });
  t.deepEqual(need.plan[0], { craft: 'wooden_shovel', times: 1, materials: { stick: 2, oak_planks: 1 }, first: [{ craft: 'stick', times: 1, materials: { oak_planks: 2 } }] });
});

test('armour: iron from the chest, or gather iron when there is none', (t) => {
  const items = without(kit(), 'iron_helmet', 'iron_boots');
  t.deepEqual(kitNeeds(items, { iron_ingot: 6 }), [
    { kind: 'helmet', why: 'missing', bestPossible: 'iron_helmet', plan: [{ craft: 'iron_helmet', times: 1, materials: { iron_ingot: 5 }, fromChest: { iron_ingot: 5 } }] },
    // One ingot left: not enough for boots.
    { kind: 'boots', why: 'missing', bestPossible: 'iron_boots', plan: [{ gather: { iron_ingot: 3 } }] }
  ]);
});

test('needs share the materials: the spare pickaxe gets what the main one leaves', (t) => {
  const items = [...without(kit(), 'diamond_pickaxe', 'stone_pickaxe'), { slot: 8, name: 'stick', count: 4 }];
  const needs = kitNeeds(items, { diamond: 4 });
  t.like(needs[0], { kind: 'pickaxe', why: 'missing', bestPossible: 'diamond_pickaxe' });
  t.like(needs[1], { kind: 'pickaxe', spare: true, why: 'missing', bestPossible: 'stone_pickaxe' });
  t.deepEqual(needs[1].plan, [{ craft: 'stone_pickaxe', times: 1, materials: { stick: 2, cobblestone: 3 } }]);
});

test('torches: crafted from coal and sticks, else gather coal', (t) => {
  const items = [...without(kit(), 'torch'), { slot: 6, name: 'torch', count: 4 }, { slot: 8, name: 'coal', count: 3 }, { slot: 9, name: 'stick', count: 3 }];
  t.deepEqual(kitNeeds(items, {}), [
    { kind: 'torch', why: 'short', carried: 4, want: 16, plan: [{ craft: 'torch', times: 3, materials: { stick: 3, coal: 3 } }] }
  ]);
  t.deepEqual(kitNeeds([...without(kit(), 'torch'), { slot: 9, name: 'stick', count: 3 }], { torch: 4, charcoal: 1 }), [
    { kind: 'torch', why: 'short', carried: 0, want: 16, plan: [{ take: 'torch', count: 4 }, { gather: { coal: 2 } }] }
  ]);
});

test('throwaway blocks short: from the chest first', (t) => {
  const items = [...without(kit(), 'cobblestone'), { slot: 7, name: 'cobblestone', count: 10 }];
  t.deepEqual(kitNeeds(items, { cobblestone: 15, cobbled_deepslate: 64 }), [
    { kind: 'cobblestone', why: 'short', carried: 10, want: 32, plan: [{ take: 'cobblestone', count: 15 }, { take: 'cobbled_deepslate', count: 7 }] }
  ]);
});

test('stashPlan keeps the kit, food and torches, deposits the rest and drops junk', (t) => {
  const items: InventoryItem[] = [
    ...kit(),
    { slot: 8, name: 'iron_pickaxe', count: 1, damage: 0, maxDamage: 250 },
    { slot: 9, name: 'diamond_axe', count: 1, damage: 1550, maxDamage: 1561 },
    { slot: 10, name: 'torch', count: 64 },
    { slot: 11, name: 'cobblestone', count: 64 },
    { slot: 12, name: 'bread', count: 10 },
    { slot: 13, name: 'leaf_litter', count: 5 },
    { slot: 14, name: 'dirt', count: 64 },
    { slot: 15, name: 'dirt', count: 30 },
    { slot: 16, name: 'rotten_flesh', count: 12 },
    { slot: 17, name: 'oak_sapling', count: 20 },
    { slot: 18, name: 'raw_iron', count: 9 },
    { slot: 19, name: 'fishing_rod', count: 1, damage: 50, maxDamage: 64 },
    { slot: 20, name: 'fishing_rod', count: 1, damage: 0, maxDamage: 64 },
    { slot: 21, name: 'leather_helmet', count: 1, damage: 0, maxDamage: 55 },
    { slot: 40, name: 'shield', count: 1, damage: 0, maxDamage: 336 }
  ];
  const { deposit, drop } = stashPlan(items, { foods: new Set(['bread', 'rotten_flesh']) });
  t.deepEqual(deposit, [
    // The iron pickaxe is now the spare; the stone one, the worn second axe and the leather helmet (iron is worn) go.
    { name: 'stone_pickaxe', count: 1, slot: 5 },
    { name: 'diamond_axe', count: 1, slot: 9 },
    { name: 'fishing_rod', count: 1, slot: 19 },
    { name: 'leather_helmet', count: 1, slot: 21 },
    { name: 'torch', count: 20 },
    { name: 'cobblestone', count: 40 },
    { name: 'raw_iron', count: 9 }
  ]);
  t.deepEqual(drop, [
    { name: 'leaf_litter', count: 5 },
    { name: 'dirt', count: 30 },
    { name: 'rotten_flesh', count: 4 },
    { name: 'oak_sapling', count: 4 }
  ]);
});

test('slotsUsed counts the main inventory only', (t) => {
  t.is(slotsUsed(kit()), 8);
});

test('a sound pickaxe beats a worn-out better one, so the need is met once a sound one is carried', (t) => {
  const items = [
    { slot: 0, name: 'diamond_pickaxe', count: 1, damage: 1550, maxDamage: 1561 },
    { slot: 1, name: 'stone_pickaxe', count: 1, damage: 0, maxDamage: 131 },
    { slot: 2, name: 'stone_pickaxe', count: 1, damage: 3, maxDamage: 131 }
  ];
  const { best, spare } = carriedKit(items);
  t.is(best.pickaxe?.slot, 1);
  t.is(spare?.slot, 2);
  t.false(kitNeeds(items, {}).some(n => n.kind === 'pickaxe' && n.why !== 'below iron'));
});

test('a shield, always: from the chest, else crafted from 6 planks and an iron ingot, else gathered for', (t) => {
  const bare = kit().filter(i => i.name !== 'shield');
  t.like(kitNeeds(bare, { shield: 1 }).find(n => n.kind === 'shield'), { why: 'missing', plan: [{ take: 'shield', count: 1 }] });
  const crafted = kitNeeds([...bare, { slot: 20, name: 'oak_planks', count: 6 }, { slot: 21, name: 'iron_ingot', count: 1 }], {}).find(n => n.kind === 'shield');
  t.like(crafted!.plan[0], { craft: 'shield', times: 1 });
  t.deepEqual(kitNeeds(bare, {}).find(n => n.kind === 'shield')!.plan, [{ gather: { log: 2, iron_ingot: 1 } }]);
});

test('better(): tier first, then enchantment levels (a curse against), then durability; one the same is a tie', (t) => {
  const sharp = [{ name: 'sharpness', level: 5 }, { name: 'unbreaking', level: 3 }];
  const item = (name: string, damage: number, enchantments?: { name: string; level: number }[]): InventoryItem =>
    ({ slot: 0, name, count: 1, damage, maxDamage: 1561, ...(enchantments ? { enchanted: true, enchantments } : {}) });
  const first = (a: InventoryItem, b: InventoryItem) => [a, b].sort(better)[0];
  // a plain diamond sword over an enchanted iron one: levels never lift a piece into the next tier
  t.is(first(item('iron_sword', 0, sharp), item('diamond_sword', 0)).name, 'diamond_sword');
  // of a tier the enchanted one, even a little worn
  const enchanted = item('diamond_sword', 400, sharp);
  t.is(first(item('diamond_sword', 0), enchanted), enchanted);
  t.is(first(enchanted, item('diamond_sword', 0)), enchanted);
  // more levels first; the same levels: the one with more use left
  t.is(first(item('diamond_sword', 0, [{ name: 'unbreaking', level: 1 }]), enchanted), enchanted);
  const fresh = item('diamond_sword', 10, [{ name: 'unbreaking', level: 3 }, { name: 'sharpness', level: 5 }]);
  t.is(first(enchanted, fresh), fresh);
  // a curse counts against: sharpness 1 and curse of vanishing 1 is level for level a plain one
  t.is(enchantLevels({ enchantments: [{ name: 'sharpness', level: 1 }, { name: 'vanishing_curse', level: 1 }] }), 0);
  const cursed = item('diamond_sword', 50, [{ name: 'sharpness', level: 1 }, { name: 'vanishing_curse', level: 1 }]);
  t.is(first(cursed, item('diamond_sword', 0)).damage, 0);
  // the same in every way: a tie, either way round
  t.is(better(item('diamond_sword', 3, sharp), item('diamond_sword', 3, sharp)), 0);
  t.is(better(item('diamond_sword', 3), item('diamond_sword', 3)), 0);
  // an older jar says only enchanted: that still beats a plain one of the tier
  t.is(enchantLevels({ enchanted: true }), 1);
  t.is(enchantLevels({}), 0);
  const old: InventoryItem = { slot: 0, name: 'diamond_sword', count: 1, damage: 300, maxDamage: 1561, enchanted: true };
  t.is(first(item('diamond_sword', 0), old), old);
});

test('better(): a piece with curse of binding comes after a plain one of its tier, whatever else it has (it never comes off again)', (t) => {
  // the Guardian never puts one on (Combat.bound); counted level for level, protection 4 and binding made 3, above a
  // plain piece, and the kit kept the cursed one as its best
  const binding = [{ name: 'protection', level: 4 }, { name: 'unbreaking', level: 3 }, { name: 'binding_curse', level: 1 }];
  t.true(enchantLevels({ enchantments: binding }) < enchantLevels({}));
  const cursed: InventoryItem = { slot: 12, name: 'diamond_chestplate', count: 1, damage: 0, maxDamage: 528, enchanted: true, enchantments: binding };
  const plain: InventoryItem = { slot: 13, name: 'diamond_chestplate', count: 1, damage: 300, maxDamage: 528 };
  t.is([cursed, plain].sort(better)[0], plain);
  t.is([plain, cursed].sort(better)[0], plain);
  // still a tier above: a cursed diamond piece over a plain iron one
  t.is([{ ...plain, name: 'iron_chestplate' }, cursed].sort(better)[0], cursed);
  const items: InventoryItem[] = [...kit().filter(i => i.slot !== 38), cursed, plain];
  t.is(carriedKit(items).best.chestplate?.slot, 13);
});

test('the kit and the stash keep the enchanted piece over a plain one of its tier, and never put it away for the plain one', (t) => {
  const prot = { enchanted: true, enchantments: [{ name: 'protection', level: 4 }, { name: 'unbreaking', level: 3 }] };
  // a fresh plain chestplate worn and the enchanted one carried, a little used: by durability alone the worn one was
  // the best and the enchanted one went in the chest
  const items: InventoryItem[] = [
    ...kit().filter(i => i.slot !== 38),
    { slot: 38, name: 'diamond_chestplate', count: 1, damage: 0, maxDamage: 528 },
    { slot: 12, name: 'diamond_chestplate', count: 1, damage: 40, maxDamage: 528, ...prot }
  ];
  t.is(carriedKit(items).best.chestplate?.slot, 12);
  t.false(stashPlan(items).deposit.some(e => e.name === 'diamond_chestplate'));
  // both carried: the plain one is what the plan puts away, by its slot, never the enchanted one
  const swords: InventoryItem[] = [
    ...kit().filter(i => i.name !== 'diamond_sword'),
    { slot: 3, name: 'diamond_sword', count: 1, damage: 0, maxDamage: 1561 },
    { slot: 9, name: 'diamond_sword', count: 1, damage: 200, maxDamage: 1561, enchanted: true, enchantments: [{ name: 'sharpness', level: 5 }] }
  ];
  t.is(carriedKit(swords).best.sword?.slot, 9);
  t.deepEqual(stashPlan(swords).deposit.filter(e => e.name === 'diamond_sword'), [{ name: 'diamond_sword', count: 1, slot: 3 }]);
  // the pickaxes: the enchanted one is the main pickaxe, a plain one the spare
  const picks: InventoryItem[] = [
    ...kit().filter(i => !/pickaxe/.test(i.name)),
    { slot: 0, name: 'diamond_pickaxe', count: 1, damage: 0, maxDamage: 1561 },
    { slot: 5, name: 'diamond_pickaxe', count: 1, damage: 90, maxDamage: 1561, enchanted: true, enchantments: [{ name: 'fortune', level: 3 }, { name: 'unbreaking', level: 3 }] }
  ];
  const { best, spare } = carriedKit(picks);
  t.is(best.pickaxe?.slot, 5);
  t.is(spare?.slot, 0);
  t.deepEqual(kitNeeds(picks, {}).filter(n => n.kind === 'pickaxe'), []);
});
