import test from 'ava';
import fs from 'fs';
import path from 'path';
import {
  ANVIL_MAX_COST, ANVIL_ORDER, LOOK_EVERY, TRIED_MS, WANTED, anvilGoal, anvilPlan, bookOfUse, bookOnto, costCap, describe, pairKey, planFor,
  repairUnits, useAnvil, type AnvilJob, type AnvilStack
} from '../../src/client/brain/anvil.js';
import { RECIPES, rawShort, recipeFor } from '../../src/client/brain/progress.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import { key, remember } from '../../src/client/brain/chests.js';
import { brainRun, type ChestStack, type InventoryItem, type ItemEnchantment } from '../../src/client/tools.js';

// ------------------------------------------------------------------------------------------------ the recipes

/**
 * The workshop's recipes as the 26.3 client jar has them (versions/26.3/26.3.jar, data/minecraft/recipe/*.json,
 * copied as they are): the brain's RECIPES must make the same from the same. The lead was wrong once (4 string and a
 * slime ball in the brain, 5 string in the game: no lead crafted, live 2026-11-13).
 */
const JAR: Record<string, unknown> = {
  iron_block: {
    type: 'minecraft:crafting_shaped', category: 'building', key: { '#': 'minecraft:iron_ingot' },
    pattern: ['###', '###', '###'], result: { id: 'minecraft:iron_block' }
  },
  anvil: {
    type: 'minecraft:crafting_shaped', key: { I: 'minecraft:iron_block', i: 'minecraft:iron_ingot' },
    pattern: ['III', ' i ', 'iii'], result: { id: 'minecraft:anvil' }
  },
  smithing_table: {
    type: 'minecraft:crafting_shaped', key: { '#': '#minecraft:planks', '@': 'minecraft:iron_ingot' },
    pattern: ['@@', '##', '##'], result: { id: 'minecraft:smithing_table' }
  }
};

/** What a shaped recipe takes, by the brain's names (a tag of planks is any planks), and what it makes. */
function fromJar(r: unknown): { makes: number; from: Record<string, number>; grid: { w: number; h: number } } {
  const { key, pattern, result } = r as { key: Record<string, string>; pattern: string[]; result: { count?: number } };
  const from: Record<string, number> = {};
  for (const ch of pattern.join('')) {
    if (ch === ' ') continue;
    const id = key[ch].replace(/^#?minecraft:/, '');
    from[id] = (from[id] ?? 0) + 1;
  }
  return { makes: result.count ?? 1, from, grid: { w: Math.max(...pattern.map(p => p.length)), h: pattern.length } };
}

test('the workshop recipes are the 26.3 jar\'s: an iron block of 9 ingots, an anvil of 3 blocks and 4 ingots, a smithing table of 2 ingots and 4 planks', (t) => {
  for (const item of ['iron_block', 'anvil', 'smithing_table']) {
    const game = fromJar(JAR[item]);
    t.deepEqual(RECIPES[item], { makes: game.makes, from: game.from }, item);
    t.deepEqual(recipeFor(item), RECIPES[item], `${item}: recipeFor reads it as it is (no wood renaming)`);
    // none fits the inventory's 2x2: each is crafted at a table (craft-item walks to one)
    t.true(game.grid.w > 2 || game.grid.h > 2, `${item} needs a table`);
  }
});

test('an anvil is 31 iron, a smithing table 2 iron and a log; what is stored counts first, blocks before ingots', (t) => {
  t.deepEqual(rawShort({ anvil: 1 }, {}), { iron_ingot: 31 });
  t.deepEqual(rawShort({ smithing_table: 1 }, {}), { iron_ingot: 2, log: 1 });
  t.deepEqual(rawShort({ anvil: 1, smithing_table: 1 }, {}), { iron_ingot: 33, log: 1 });
  // the live stores (70 ingots, 3269 oak logs): nothing to gather
  t.deepEqual(rawShort({ anvil: 1, smithing_table: 1 }, { iron_ingot: 70, oak_log: 3269 }), {});
  // an iron block stored is 9 ingots fewer to find: 2 blocks to craft (18) and the 4, less the 10 there
  t.deepEqual(rawShort({ anvil: 1 }, { iron_block: 1, iron_ingot: 10 }), { iron_ingot: 12 });
  // and ingots are never made from blocks (the two recipes would go round and round)
  t.false('iron_ingot' in RECIPES);
});

// ------------------------------------------------------------------------------------------------ the anvil

/** 26.3's data/minecraft/enchantment/*.json, for what the tests use: anvil_cost, max_level, what it goes on, its exclusive set. */
const ENCH: Record<string, { cost: number; max: number; on: RegExp; set?: string }> = {
  mending: { cost: 4, max: 1, on: /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/ },
  unbreaking: { cost: 2, max: 3, on: /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/ },
  efficiency: { cost: 1, max: 5, on: /_(pickaxe|axe|shovel|hoe)$/ },
  fortune: { cost: 4, max: 3, on: /_(pickaxe|axe|shovel|hoe)$/, set: 'mining' },
  silk_touch: { cost: 8, max: 1, on: /_(pickaxe|axe|shovel|hoe)$/, set: 'mining' },
  sharpness: { cost: 1, max: 5, on: /_(sword|axe)$/, set: 'damage' },
  protection: { cost: 1, max: 4, on: /_(helmet|chestplate|leggings|boots)$/, set: 'armor' },
  blast_protection: { cost: 4, max: 4, on: /_(helmet|chestplate|leggings|boots)$/, set: 'armor' },
  thorns: { cost: 8, max: 3, on: /_(helmet|chestplate|leggings|boots)$/ }
};

/**
 * The anvil's result as 26.3's AnvilMenu.createResult works it out, for one piece in the input: a repair with its
 * material (each unit mends a quarter, as many units as it needs of those put, a level each), or a book's enchantments
 * merged (a level more for an equal one, up to the most there is; a level of penalty for each clash with one on the
 * piece; nothing at all when none can go on). The cost adds both stacks' repair costs; at 40 and up there is no result.
 */
/** A stack as an anvil slot shows it: no pocket slot; its enchantments its own copies (the merge changes levels). */
function stackOf(i: InventoryItem): AnvilStack {
  const o: Partial<InventoryItem> = { ...i, ...(i.enchantments ? { enchantments: i.enchantments.map(e => ({ ...e })) } : {}) };
  delete o.slot;
  return o as AnvilStack;
}

/** What mends what in the anvil (the game's #repairs_*_armor and tool material tags, for the tiers the bot has). */
const MATERIAL: Record<string, string> = { diamond: 'diamond', iron: 'iron_ingot', netherite: 'netherite_ingot' };

function combine(input: InventoryItem, add: InventoryItem): { result?: AnvilStack; cost: number; used: number } {
  const base = (input.repairCost ?? 0) + (add.repairCost ?? 0);
  const out = stackOf(input);
  out.enchantments ??= [];
  let points = 0, used = 0;
  if (input.maxDamage && add.name === MATERIAL[input.name.split('_')[0]]) {
    let unit = Math.min(input.damage ?? 0, Math.floor(input.maxDamage / 4));
    if (unit <= 0) return { cost: 0, used: 0 };
    out.damage = input.damage ?? 0;
    while (unit > 0 && used < add.count) {
      out.damage -= unit;
      points++;
      unit = Math.min(out.damage, Math.floor(input.maxDamage / 4));
      used++;
    }
  } else if (add.name === 'enchanted_book') {
    let applied = false, clashed = false;
    for (const e of add.enchantments ?? []) {
      const def = ENCH[e.name];
      const have = out.enchantments!.find(x => x.name === e.name);
      const level = have && have.level === e.level ? e.level + 1 : Math.max(e.level, have?.level ?? 0);
      let fits = def.on.test(input.name);
      for (const other of out.enchantments!) {
        if (other.name !== e.name && def.set && ENCH[other.name]?.set === def.set) { fits = false; points++; }
      }
      if (!fits) { clashed = true; continue; }
      applied = true;
      const next = Math.min(level, def.max);
      if (have) have.level = next; else out.enchantments!.push({ name: e.name, level: next });
      points += Math.max(1, Math.floor(def.cost / 2)) * next;
    }
    if (clashed && !applied) return { cost: 0, used: 0 };
    used = 1;
  } else return { cost: 0, used: 0 };
  if (points <= 0) return { cost: 0, used: 0 };
  const cost = base + points;
  if (cost >= 40) return { cost, used: 0 };
  out.enchanted = !!out.enchantments!.length;
  out.repairCost = 2 * Math.max(input.repairCost ?? 0, add.repairCost ?? 0) + 1;
  return { result: out, cost, used };
}

const ANVIL = { x: -541, y: 63, z: 2214 };
const snap = (items: InventoryItem[]): Snapshot => ({
  now: 10 * 60 * 60_000, timeOfDay: 4000, activity: 'work', health: 20, food: 20, position: { x: -541, y: 63, z: 2212 }, dimension: 'overworld',
  sleeping: false, raining: false, thundering: false, process: null, items, counts: new Map(items.map(i => [i.name, i.count])), slotsUsed: items.length,
  xpLevel: 52, home: { x: -549, y: 63, z: 2183, dimension: 'overworld' }, distHome: 30
} as Snapshot);

/**
 * The anvil as the mod's Anvil.java works it, on the pockets (`items`, inventory indexes 0-35, worn 36-39):
 * - anvil.put: no item of the name in the pockets fails ("no X in inventory"); what the slot held goes back to the
 *   pockets first (shift-click: the first free of 9-35, then the hotbar, onto a stack of the same); the one at `slot`
 *   when it holds the name, else the first by the name (Interact.pick); `count` of it; the reply is the status.
 * - anvil.take: refuses with no result or too few levels; the result to the pockets (shift-click from the result:
 *   the hotbar from 8 down, then 35 down), the levels taken, the piece gone, the additional less what was used; the
 *   anvil worn down to `wear` if given. `refuse`: the server did not hand it over.
 * - anvil.close: what the anvil still holds back to the pockets (shift-clicked out before the close, as the mod does:
 *   so the piece is there to wear at once), the held armour slots wear the best of their kind.
 * - armor.unequip as the mod's: shift-clicked to the first free of 9-35, then the hotbar; `regear`: back on at once.
 */
function anvil(items: InventoryItem[], opts: { level?: number; wear?: string; refuse?: boolean; regear?: boolean } = {}) {
  const calls: string[] = [];
  const held = new Set<number>();
  let level = opts.level ?? 52;
  let open = false;
  const slots: { input?: InventoryItem; additional?: InventoryItem } = {};
  let block = 'anvil';
  const at = (k: number) => items.find(i => i.slot === k);
  const firstFree = (order: number[]) => order.find(k => !at(k));
  const MAIN_FIRST = [...[...Array(27).keys()].map(k => k + 9), ...Array(9).keys()];
  const RESULT_ORDER = [...[...Array(9).keys()].reverse(), ...[...Array(27).keys()].map(k => k + 9).reverse()];
  const toPockets = (st: InventoryItem, order: number[]) => {
    const onto = !st.maxDamage && !st.enchantments?.length && order.map(at).find(i => i && i.name === st.name && !i.enchantments?.length && i.count + st.count <= 64);
    if (onto) { onto.count += st.count; return onto.slot; }
    const k = firstFree(order);
    if (k === undefined) throw new Error('inventory full');
    items.push({ ...st, slot: k });
    return k;
  };
  const strip = (i?: InventoryItem): AnvilStack | null => (i ? stackOf(i) : null);
  const view = () => {
    const c = slots.input && slots.additional ? combine(slots.input, slots.additional) : { cost: 0, used: 0 };
    return { c, status: {
      open, input: strip(slots.input), additional: strip(slots.additional), result: c.result ?? null, cost: c.cost,
      tooExpensive: c.cost >= 40, xpLevel: level, canTake: !!c.result && c.cost > 0 && level >= c.cost && firstFree(MAIN_FIRST) !== undefined
    } };
  };
  const ctx = {
    s: snap(items), world: { landmarks: { chests: [] }, leash: 96 } as unknown as WorldMemory,
    signal: new AbortController().signal,
    act: async () => ({ ok: true, text: 'ok' }),
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      calls.push(`${m} ${JSON.stringify(a)}`);
      if (m === 'armor.unequip') {
        const index = { feet: 36, legs: 37, chest: 38, head: 39 }[a.slot as string]!;
        const worn = at(index);
        if (!worn) throw new Error(`nothing worn on the ${String(a.slot)}`);
        const free = firstFree(MAIN_FIRST);
        if (free === undefined) throw new Error(`no free slot to take the ${worn.name} off into`);
        worn.slot = opts.regear ? index : free;
        held.add(index);
        return { ok: true, slot: free, name: worn.name, count: 1, holdMs: a.holdMs };
      }
      if (m === 'anvil.open') {
        if (!/^(chipped_|damaged_)?anvil$/.test(block)) throw new Error(`no anvil at ${a.x}, ${a.y}, ${a.z} (${block})`);
        open = true;
        return { ...view().status, anvil: block };
      }
      if (m === 'anvil.status') return open ? view().status : { open: false };
      if (m === 'anvil.put') {
        if (!open) throw new Error('no anvil open (anvil.open first)');
        const which = a.which as 'input' | 'additional';
        const name = a.name as string;
        if (!items.some(i => i.slot < 36 && i.name === name)) throw new Error(`no ${name} in inventory`);
        const before = slots[which];
        if (before) { toPockets(before, MAIN_FIRST); delete slots[which]; }
        const asked = typeof a.slot === 'number' ? a.slot : -1;
        const from = at(asked)?.name === name && asked < 36 ? at(asked)! : items.filter(i => i.slot < 36 && i.name === name).sort((x, y) => x.slot - y.slot)[0];
        const n = Math.min(Math.max(1, (a.count as number | undefined) ?? 1), from.count);
        if (n >= from.count) { items.splice(items.indexOf(from), 1); slots[which] = { ...from }; } else { from.count -= n; slots[which] = { ...from, count: n }; }
        return { ...view().status, which, put: strip(slots[which]) };
      }
      if (m === 'anvil.take') {
        const { c } = view();
        if (!c.result) throw new Error(c.cost >= 40 ? `too expensive (cost ${c.cost}; the anvil refuses 40 and up)` : 'no result in the anvil');
        if (level < c.cost) throw new Error(`needs level ${c.cost}, has ${level}`);
        const levelBefore = level;
        if (opts.refuse) return { ok: false, reason: 'the server did not hand the result over', item: c.result.name, cost: c.cost, levelBefore, levelAfter: level, anvil: block };
        level -= c.cost;
        delete slots.input;
        if (slots.additional!.count > c.used) slots.additional!.count -= c.used; else delete slots.additional;
        const slot = toPockets({ ...c.result, slot: -1 } as InventoryItem, RESULT_ORDER);
        if (opts.wear) block = opts.wear;
        if (block === 'air') open = false;
        return { ok: true, item: c.result.name, count: 1, slot, enchantments: c.result.enchantments ?? [], damage: c.result.damage, maxDamage: c.result.maxDamage,
          repairCost: c.result.repairCost, cost: c.cost, used: c.used, levelBefore, levelAfter: level, anvil: block, open };
      }
      if (m === 'anvil.close') {
        const was = open;
        for (const k of ['input', 'additional'] as const) if (slots[k]) { toPockets(slots[k]!, MAIN_FIRST); delete slots[k]; }
        open = false;
        const wore: string[] = [];
        const kinds: Record<number, string> = { 36: 'boots', 37: 'leggings', 38: 'chestplate', 39: 'helmet' };
        for (const index of held) {
          if (at(index)) continue;
          const piece = items.filter(i => i.slot < 36 && i.name.endsWith(`_${kinds[index]}`))
            .sort((x, y) => Number(!!y.enchantments?.length) - Number(!!x.enchantments?.length))[0];
          if (piece) { piece.slot = index; wore.push(piece.name); }
        }
        held.clear();
        return { ok: true, wasOpen: was, wore };
      }
      return {};
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined, gain: () => undefined
  } as unknown as GoalContext;
  return { ctx, calls, items, level: () => level, slots };
}

const en = (s: string): ItemEnchantment[] => s.split(', ').map(x => { const [name, l] = x.split(' '); return { name, level: Number(l) }; });
const count = (items: InventoryItem[], name: string) => items.filter(i => i.name === name && i.slot < 36).reduce((a, i) => a + i.count, 0);

test('anvil: a book onto a carried pickaxe: open, the piece in, the book with it, take, close', async (t) => {
  const items: InventoryItem[] = [
    { slot: 0, name: 'diamond_sword', count: 1, enchanted: true, enchantments: en('unbreaking 3') },
    { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 4, fortune 3, unbreaking 3'), damage: 40, maxDamage: 1561 },
    { slot: 14, name: 'enchanted_book', count: 1, enchantments: en('unbreaking 3') },
    { slot: 15, name: 'enchanted_book', count: 1, enchantments: en('efficiency 5') }
  ];
  const { ctx, calls, level } = anvil(items, { level: 47 });
  const out = await useAnvil(ctx, { at: ANVIL, input: { name: 'diamond_pickaxe', slot: 1 }, additional: { name: 'enchanted_book', slot: 15 }, maxCost: 39 });
  t.deepEqual(calls, [
    `anvil.open ${JSON.stringify(ANVIL)}`,
    'anvil.put {"which":"input","name":"diamond_pickaxe","slot":1,"count":1}',
    'anvil.put {"which":"additional","name":"enchanted_book","slot":15,"count":1}', // the book by its slot: the first by name is unbreaking
    'anvil.take {}',
    'anvil.close {}'
  ]);
  t.true(out.taken);
  if (!out.taken) return;
  t.like(out.take, { item: 'diamond_pickaxe', cost: 5, used: 1, levelBefore: 47, levelAfter: 42, anvil: 'anvil' });
  t.deepEqual(out.take.enchantments, en('efficiency 5, fortune 3, unbreaking 3'));
  t.is(level(), 42);
  // the book used up, the other kept; the pickaxe back in a pocket with the anvil's work on it
  t.deepEqual(items.filter(i => i.name === 'enchanted_book').map(i => i.enchantments), [en('unbreaking 3')]);
  t.like(items.find(i => i.name === 'diamond_pickaxe'), { slot: out.take.slot, repairCost: 1, damage: 40 });
});

test('anvil: a repair puts the diamonds it needs, by count; the server would use no more, but the rest is handed back', async (t) => {
  // 1100 of 1561 worn: a diamond mends a quarter (390), so 3 make it whole: 3 levels and the pickaxe's repair cost 1
  const pickaxe = (): InventoryItem => ({ slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 5, fortune 3, unbreaking 3'), damage: 1100, maxDamage: 1561, repairCost: 1 });
  const items = [pickaxe(), { slot: 20, name: 'diamond', count: 64 }];
  const { ctx, calls } = anvil(items);
  const out = await useAnvil(ctx, { at: ANVIL, input: { name: 'diamond_pickaxe', slot: 1 }, additional: { name: 'diamond', slot: 20, count: 3 }, maxCost: 39 });
  t.true(calls.includes('anvil.put {"which":"additional","name":"diamond","slot":20,"count":3}'));
  t.true(out.taken);
  if (!out.taken) return;
  t.like(out.take, { item: 'diamond_pickaxe', cost: 4, used: 3, damage: 0, repairCost: 3, levelBefore: 52, levelAfter: 48 });
  t.deepEqual(out.take.enchantments, en('efficiency 5, fortune 3, unbreaking 3'));
  t.is(count(items, 'diamond'), 61);
  // four put for a piece three make whole: three used, the same cost, and the fourth back in the pockets at the close
  const more = [pickaxe(), { slot: 20, name: 'diamond', count: 64 }];
  const r = await useAnvil(anvil(more).ctx, { at: ANVIL, input: { name: 'diamond_pickaxe', slot: 1 }, additional: { name: 'diamond', slot: 20, count: 4 }, maxCost: 39 });
  t.like(r.taken ? r.take : {}, { cost: 4, used: 3 });
  t.is(count(more, 'diamond'), 61);
});

test('anvil: a pair with no result (sharpness onto a pickaxe) is not taken: why "no result", both back in the pockets, the anvil closed', async (t) => {
  const items: InventoryItem[] = [
    { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 4, fortune 3') },
    { slot: 14, name: 'enchanted_book', count: 1, enchantments: en('sharpness 5') }
  ];
  const { ctx, calls, level } = anvil(items);
  const out = await useAnvil(ctx, { at: ANVIL, input: { name: 'diamond_pickaxe', slot: 1 }, additional: { name: 'enchanted_book', slot: 14 }, maxCost: 39 });
  t.like(out, { taken: false, why: 'no result', text: "the enchanted_book and the diamond_pickaxe don't combine (no result)" });
  t.false(calls.some(c => c.startsWith('anvil.take')));
  t.is(calls.at(-1), 'anvil.close {}');
  t.is(level(), 52);
  t.is(count(items, 'diamond_pickaxe'), 1);
  t.is(count(items, 'enchanted_book'), 1);
});

test('anvil: never a job at 40 and up: the game shows no result, and it is "too expensive", not a pair that does not combine', async (t) => {
  // worked on many times: repair costs 31 and 7 and the book's 4 levels make 42
  const items: InventoryItem[] = [
    { slot: 2, name: 'diamond_chestplate', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3'), repairCost: 31 },
    { slot: 14, name: 'enchanted_book', count: 1, enchantments: en('protection 4'), repairCost: 7 }
  ];
  const { ctx, calls } = anvil(items);
  const out = await useAnvil(ctx, { at: ANVIL, input: { name: 'diamond_chestplate', slot: 2 }, additional: { name: 'enchanted_book', slot: 14 }, maxCost: 52 });
  t.like(out, { taken: false, why: 'too expensive' });
  t.regex(out.taken ? '' : out.text, /costs 42 \(the anvil refuses 40 and up\)/);
  t.false(calls.some(c => c.startsWith('anvil.take')));
  t.is(ANVIL_MAX_COST, 39);
});

test('anvil: a result dearer than it may spend is left: never above min(maxCost, the level, 39)', async (t) => {
  const chest = (): InventoryItem[] => [
    { slot: 2, name: 'diamond_chestplate', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3, thorns 2'), repairCost: 5 },
    { slot: 14, name: 'enchanted_book', count: 1, enchantments: en('protection 4') }
  ];
  const job: AnvilJob = { at: ANVIL, input: { name: 'diamond_chestplate', slot: 2 }, additional: { name: 'enchanted_book', slot: 14 }, maxCost: 8 };
  // cost 9 (5 of earlier work and 4 for protection 4): over a cap of 8
  const a = anvil(chest());
  const capped = await useAnvil(a.ctx, job);
  t.like(capped, { taken: false, why: 'over the cap', text: 'the enchanted_book onto the diamond_chestplate costs 9, over the 8 levels it may spend' });
  t.false(a.calls.some(c => c.startsWith('anvil.take')));
  // the level is a cap too: at level 8 a cap of 39 is 8
  const low = anvil(chest(), { level: 8 });
  t.like(await useAnvil(low.ctx, { ...job, maxCost: 39 }), { taken: false, why: 'over the cap', text: 'the enchanted_book onto the diamond_chestplate costs 9, over the 8 levels it may spend' });
  t.is(low.level(), 8);
  // within it: taken, level 52 -> 43
  const fine = anvil(chest());
  const ok = await useAnvil(fine.ctx, { ...job, maxCost: 9 });
  t.like(ok.taken ? ok.take : {}, { cost: 9, levelBefore: 52, levelAfter: 43 });
});

/** The live armour on Nov 14: the chestplate and leggings enchanted at the table, worn. */
const wornKit = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_sword', count: 1, enchanted: true, enchantments: en('unbreaking 3') },
  { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 4, fortune 3') },
  { slot: 14, name: 'enchanted_book', count: 1, enchantments: en('protection 4') },
  { slot: 37, name: 'diamond_leggings', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3'), damage: 30, maxDamage: 495 },
  { slot: 38, name: 'diamond_chestplate', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3, thorns 2'), damage: 41, maxDamage: 528, repairCost: 5 }
];
const chestJob: AnvilJob = { at: ANVIL, input: { name: 'diamond_chestplate', slot: 38, worn: 'chest' }, additional: { name: 'enchanted_book', slot: 14 }, maxCost: 39 };

test('anvil: a worn chestplate comes off first (held off for the Guardian), goes in from the slot it went to, and is worn again at the close', async (t) => {
  const items = wornKit();
  const { ctx, calls } = anvil(items);
  const out = await useAnvil(ctx, chestJob);
  t.deepEqual(calls, [
    'armor.unequip {"slot":"chest","holdMs":30000}',
    `anvil.open ${JSON.stringify(ANVIL)}`,
    'anvil.put {"which":"input","name":"diamond_chestplate","slot":9,"count":1}', // the first free of the main pocket
    'anvil.put {"which":"additional","name":"enchanted_book","slot":14,"count":1}',
    'anvil.take {}',
    'anvil.close {}' // ends the hold and wears the best chestplate again: the one with protection 4
  ]);
  t.like(out, { taken: true, wore: ['diamond_chestplate'] });
  t.like(out.taken ? out.take : {}, { cost: 9, levelBefore: 52, levelAfter: 43 });
  t.like(items.find(i => i.name === 'diamond_chestplate'), { slot: 38, enchantments: en('protection 4, unbreaking 3, thorns 2'), repairCost: 11 });
});

test('anvil: a run given up right after the piece came off still closes the anvil, and the piece goes back on', async (t) => {
  // the runtime refuses every call of a run the brain gave up (tools.ts); the close goes outside it
  const items = wornKit();
  const { ctx, calls } = anvil(items);
  const abort = new AbortController();
  const inner = ctx.call;
  ctx.call = (async (m: string, a?: Record<string, unknown>, ms?: number) => {
    if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
    const r = await inner(m, a, ms);
    if (m === 'armor.unequip') abort.abort(); // something more urgent, right after the piece came off
    return r;
  }) as GoalContext['call'];
  await t.throwsAsync(brainRun.run({ signal: abort.signal }, () => useAnvil(ctx, chestJob)), { message: /aborted/ });
  t.deepEqual(calls, ['armor.unequip {"slot":"chest","holdMs":30000}', 'anvil.close {}']);
  t.is(items.find(i => i.name === 'diamond_chestplate')?.slot, 38);
});

test('anvil: a worn piece back on before the put (the hold gave way: hurt) is a failure that says so, and the anvil is closed', async (t) => {
  const { ctx, calls } = anvil(wornKit(), { regear: true });
  await t.throwsAsync(useAnvil(ctx, chestJob), { message: 'the diamond_chestplate went back on before the anvil had it (hurt, or a fight)' });
  t.is(calls.at(-1), 'anvil.close {}');
  t.false(calls.some(c => c.startsWith('anvil.take')));
});

test('anvil: a result that is not what the job was for is left (protection clashes with blast protection: only the thorns would go on)', async (t) => {
  const items: InventoryItem[] = [
    { slot: 2, name: 'diamond_chestplate', count: 1, enchanted: true, enchantments: en('blast_protection 4, unbreaking 3') },
    { slot: 14, name: 'enchanted_book', count: 1, enchantments: en('protection 4, thorns 3') }
  ];
  const { ctx, calls } = anvil(items);
  const wants = (r: AnvilStack) => !!r.enchantments?.some(e => e.name === 'protection' && e.level >= 4);
  const out = await useAnvil(ctx, { at: ANVIL, input: { name: 'diamond_chestplate', slot: 2 }, additional: { name: 'enchanted_book', slot: 14 }, maxCost: 39, wants });
  t.like(out, { taken: false, why: 'not wanted', text: 'the diamond_chestplate it would make (blast_protection 4, unbreaking 3, thorns 3) is not what it was for' });
  t.like(out.taken ? {} : out.status, { cost: 13 }); // a level for the clash and 12 for thorns 3
  t.false(calls.some(c => c.startsWith('anvil.take')));
  t.is(count(items, 'enchanted_book'), 1);
});

test('anvil: a take the server did not hand over is a failure, and the anvil is closed', async (t) => {
  const items = wornKit();
  const { ctx, calls } = anvil(items, { refuse: true });
  await t.throwsAsync(useAnvil(ctx, chestJob), { message: 'the server did not hand the result over' });
  t.is(calls.at(-1), 'anvil.close {}');
  // the piece came back out of the anvil at the close and is worn again
  t.is(items.find(i => i.name === 'diamond_chestplate')?.slot, 38);
});

test('anvil: an anvil worn out by the take says so (air), for the chore to put another down', async (t) => {
  const { ctx } = anvil(wornKit(), { wear: 'air' });
  const out = await useAnvil(ctx, chestJob);
  t.like(out.taken ? out.take : {}, { anvil: 'air', open: false, levelAfter: 43 });
  t.deepEqual(out.wore, ['diamond_chestplate']);
  const chipped = await useAnvil(anvil(wornKit(), { wear: 'chipped_anvil' }).ctx, chestJob);
  t.like(chipped.taken ? chipped.take : {}, { anvil: 'chipped_anvil' });
});

test('anvil: no such piece in the pockets is a failure, and the anvil is closed all the same', async (t) => {
  const { ctx, calls } = anvil([{ slot: 14, name: 'enchanted_book', count: 1, enchantments: en('mending 1') }]);
  await t.throwsAsync(useAnvil(ctx, { at: ANVIL, input: { name: 'diamond_boots' }, additional: { name: 'enchanted_book' }, maxCost: 39 }), { message: 'no diamond_boots in inventory' });
  t.deepEqual(calls, [`anvil.open ${JSON.stringify(ANVIL)}`, 'anvil.put {"which":"input","name":"diamond_boots","count":1}', 'anvil.close {}']);
});

test('the bridge registers every anvil call the brain makes, and the mod starts it', (t) => {
  const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
  const java = fs.readFileSync(path.join(mod, 'Anvil.java'), 'utf8');
  for (const m of ['anvil.open', 'anvil.put', 'anvil.status', 'anvil.take', 'anvil.close']) t.true(java.includes(`s.register("${m}"`), m);
  t.regex(fs.readFileSync(path.join(mod, 'ClaudeBridge.java'), 'utf8'), /Anvil\.register\(server\);/);
  // 26.3 AnvilMenu: 0 the input, 1 the additional, 2 the result, the pockets from 3; too expensive from 40
  t.regex(java, /INPUT = 0, ADDITIONAL = 1, RESULT = 2, OWN_SLOTS = 3;/);
  t.regex(java, /TOO_EXPENSIVE = 40;/);
  // anvil.close shift-clicks an untaken job's piece and book back into the pockets before it closes, and then wears the
  // piece again: the game client's AnvilMenu (ContainerLevelAccess.NULL) hands back nothing on its own close, so the
  // piece was not in the pockets yet when wearHeldAgain looked ("not worn again" in brain.log, the piece on a second later)
  const close = java.slice(java.indexOf('s.register("anvil.close"'));
  const moved = close.search(/new int\[\] \{ INPUT, ADDITIONAL \}\) if \(!menu\.getSlot\(k\)\.getItem\(\)\.isEmpty\(\)\) click\(menu, k, 0, ContainerInput\.QUICK_MOVE\);/);
  t.true(moved > 0, 'the input and additional shift-clicked out');
  t.true(moved < close.indexOf('pl.closeContainer()') && close.indexOf('pl.closeContainer()') < close.indexOf('Guardian.wearHeldAgain(pl, "anvil")'), 'out, then closed, then worn');
});

// ------------------------------------------------------------------------------------------------ the plan

/** The misc chest of the storage house (misc1), where the enchant chore puts its books. */
const STORE = { x: -551, y: 65, z: 2179 };
const book = (slot: number, s: string, repairCost?: number): ChestStack =>
  ({ slot, name: 'enchanted_book', count: 1, enchantments: en(s), ...(repairCost ? { repairCost } : {}) });
const inStore = (stacks: ChestStack[]) => stacks.map(stack => ({ chest: STORE, stack }));
/** The live chestplate on Nov 14: enchanted at the table, worn, its earlier work 5 (as the bridge's test has it). */
const CHESTPLATE: InventoryItem = { slot: 38, name: 'diamond_chestplate', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3, thorns 2'), damage: 41, maxDamage: 528, repairCost: 5 };

test('anvilPlan: a worn piece mended first, then mending, then the books that raise what is wanted; pickaxe, chestplate, leggings, helmet, boots, sword', (t) => {
  t.deepEqual([...ANVIL_ORDER], ['pickaxe', 'chestplate', 'leggings', 'helmet', 'boots', 'sword']);
  const items: InventoryItem[] = [
    { slot: 0, name: 'diamond_sword', count: 1, enchanted: true, enchantments: en('unbreaking 3') },
    { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 4, fortune 3, unbreaking 3'), damage: 1300, maxDamage: 1561 },
    { slot: 20, name: 'diamond', count: 12 },
    { slot: 36, name: 'diamond_boots', count: 1, enchanted: true, enchantments: en('protection 4, depth_strider 3, unbreaking 3') },
    { slot: 37, name: 'diamond_leggings', count: 1, enchanted: true, enchantments: en('protection 3, unbreaking 3') },
    { ...CHESTPLATE },
    { slot: 39, name: 'diamond_helmet', count: 1, enchanted: true, enchantments: en('protection 4, unbreaking 3') }
  ];
  let stored = inStore([book(0, 'sharpness 5'), book(1, 'protection 4'), book(2, 'mending 1'), book(3, 'efficiency 5'), book(4, 'feather_falling 4'),
    book(5, 'protection 4'), book(6, 'respiration 3'), book(7, 'bane_of_arthropods 5')]);
  const done: string[] = [];
  for (let n = 0; n < 12; n++) {
    const p = anvilPlan(items, stored, 100);
    if (!p) break;
    done.push(`${describe(p)}, cost ${p.cost}`);
    // as the anvil leaves it: mended, or the book's enchantments on; the earlier work doubled and one more
    if (p.job === 'repair') p.piece.damage = 0;
    else { p.piece.enchantments = bookOnto(p.piece, p.add)!.enchantments; stored = stored.filter(f => f.stack.slot !== p.add.slot); }
    p.piece.repairCost = 2 * (p.piece.repairCost ?? 0) + 1;
  }
  t.deepEqual(done, [
    'repair the diamond_pickaxe (16% left) with 4 diamonds, cost 4',
    'mending 1 onto the diamond_pickaxe, cost 3',
    'efficiency 5 onto the diamond_pickaxe, cost 8',
    'protection 4 onto the diamond_chestplate (worn), cost 9',
    'protection 4 onto the diamond_leggings (worn), cost 4',
    'respiration 3 onto the diamond_helmet (worn), cost 6',
    'feather_falling 4 onto the diamond_boots (worn), cost 4',
    'sharpness 5 onto the diamond_sword, cost 5'
  ]);
  // what is left: bane of arthropods, which clashes with the sword's sharpness (no result) and is no use to the rest
  t.deepEqual(stored.map(f => f.stack.enchantments), [en('bane_of_arthropods 5')]);
  t.false(bookOfUse(items, stored[0].stack));
});

test('anvilPlan: what each kind wants', (t) => {
  t.deepEqual(WANTED.pickaxe, { mending: 1, unbreaking: 3, efficiency: 5, fortune: 3 });
  t.deepEqual(WANTED.sword, { mending: 1, sharpness: 5, unbreaking: 3, looting: 3 });
  for (const kind of ['chestplate', 'leggings'] as const) t.deepEqual(WANTED[kind], { mending: 1, protection: 4, unbreaking: 3 });
  t.deepEqual(WANTED.helmet, { mending: 1, protection: 4, unbreaking: 3, respiration: 3, aqua_affinity: 1 });
  t.deepEqual(WANTED.boots, { mending: 1, protection: 4, unbreaking: 3, feather_falling: 4, depth_strider: 3 });
});

test('anvilPlan: never a job dearer than min(level, 39), and none of the table\'s 30 levels while a plain piece waits for it', (t) => {
  t.is(costCap([], 52), 39);
  t.is(costCap([], 20), 20);
  const plain: InventoryItem = { slot: 5, name: 'diamond_helmet', count: 1 };
  t.is(costCap([plain], 52), 22);
  t.is(costCap([{ ...plain, slot: 39 }], 52), 22, 'worn too');
  t.is(costCap([plain], 30), 0);
  t.is(costCap([{ slot: 5, name: 'iron_helmet', count: 1 }], 52), 39, 'a plain iron piece is not the table\'s');
  // protection 4 onto the live chestplate: 5 of earlier work and 4
  const stored = inStore([book(3, 'protection 4')]);
  t.is(anvilPlan([CHESTPLATE], stored, 8), undefined);
  t.like(anvilPlan([CHESTPLATE], stored, 9), { job: 'book', cost: 9, cap: 9 });
  t.like(anvilPlan([CHESTPLATE], stored, 52), { cost: 9, cap: 39 });
  t.like(anvilPlan([CHESTPLATE, plain], stored, 52), { cost: 9, cap: 22 });
  t.is(anvilPlan([CHESTPLATE, plain], stored, 38), undefined, '8 to spend above the table\'s 30');
  // never at 40 and up: worked on 31 before and a book worked on 7, mending's 2 make 40; a book worked on 3, 36
  const old = { ...CHESTPLATE, repairCost: 31 };
  t.is(anvilPlan([old], inStore([book(3, 'mending 1', 7)]), 100), undefined);
  t.like(anvilPlan([old], inStore([book(3, 'mending 1', 3)]), 100), { job: 'mending', cost: 36, cap: 39 });
});

test('anvilPlan: a piece worked on 15 times over gets no more books; mending and a repair it still gets', (t) => {
  const pick: InventoryItem = { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 4, fortune 3, unbreaking 3'), damage: 100, maxDamage: 1561, repairCost: 15 };
  t.is(anvilPlan([pick], inStore([book(0, 'efficiency 5')]), 52), undefined);
  t.like(anvilPlan([{ ...pick, repairCost: 7 }], inStore([book(0, 'efficiency 5')]), 52), { job: 'book', cost: 12 });
  t.like(anvilPlan([pick], inStore([book(0, 'efficiency 5'), book(1, 'mending 1')]), 52), { job: 'mending', cost: 17 });
  // 1200 of 1561 worn: four diamonds (390 each), 15 + 4
  t.like(anvilPlan([{ ...pick, damage: 1200 }, { slot: 20, name: 'diamond', count: 64 }], [], 52), { job: 'repair', cost: 19, add: { name: 'diamond', count: 4, slot: 20 } });
});

test('anvilPlan: the diamonds of a repair from a carried stack with enough, else a chest\'s stack, else the chests by count; none, no repair', (t) => {
  const pick: InventoryItem = { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 5, fortune 3, unbreaking 3'), damage: 1100, maxDamage: 1561, repairCost: 1 };
  t.is(repairUnits(pick), 3);
  t.is(repairUnits({ damage: 0, maxDamage: 1561 }), 0);
  t.is(repairUnits({ damage: 1561, maxDamage: 1561 }), 4);
  t.like(anvilPlan([pick, { slot: 20, name: 'diamond', count: 64 }], [], 52), { job: 'repair', cost: 4, add: { name: 'diamond', count: 3, slot: 20 } });
  // two diamonds carried are too few: the chest's stack of 40 (its own slot)
  const p = anvilPlan([pick, { slot: 20, name: 'diamond', count: 2 }], inStore([{ slot: 9, name: 'diamond', count: 40 }]), 52);
  t.deepEqual(p?.add, { name: 'diamond', count: 3, chest: STORE, slot: 9 });
  // no stack known with enough: by count from the chests
  t.deepEqual(anvilPlan([pick], [], 52, { diamonds: 3 })?.add, { name: 'diamond', count: 3 });
  t.is(anvilPlan([pick], [], 52, { diamonds: 2 }), undefined);
  // above 30% left it is no repair; a plain piece is never mended here (the table first)
  t.is(anvilPlan([{ ...pick, damage: 1000 }, { slot: 20, name: 'diamond', count: 64 }], [], 52), undefined);
  t.is(anvilPlan([{ ...pick, enchanted: false, enchantments: undefined }, { slot: 20, name: 'diamond', count: 64 }], [], 52), undefined);
});

test('anvilPlan: a pair that gave nothing is left alone a week; one over the cap is tried again once the cap comes up to its cost', (t) => {
  const b = book(3, 'protection 4');
  const k = pairKey(CHESTPLATE, b);
  t.is(k, 'diamond_chestplate[protection 3,thorns 2,unbreaking 3]+enchanted_book[protection 4]');
  const now = Date.UTC(2026, 10, 14, 12, 0, 0);
  const at = (why: 'no result' | 'not wanted' | 'over the cap' | 'too expensive', ago: number, cost?: number) => ({ [k]: { why, at: now - ago, ...(cost ? { cost } : {}) } });
  for (const why of ['no result', 'not wanted', 'too expensive'] as const) {
    t.is(anvilPlan([CHESTPLATE], inStore([b]), 52, { tried: at(why, 60_000), now }), undefined, why);
    t.like(anvilPlan([CHESTPLATE], inStore([b]), 52, { tried: at(why, TRIED_MS + 1), now }), { key: k }, `${why}: a week on`);
  }
  // another book is another pair, and so is the piece once it changes
  t.like(anvilPlan([CHESTPLATE], inStore([b, book(4, 'protection 4, unbreaking 3')]), 52, { tried: at('no result', 0), now }), { add: { slot: 4 } });
  t.truthy(anvilPlan([{ ...CHESTPLATE, enchantments: en('protection 3, unbreaking 3, thorns 3') }], inStore([b]), 52, { tried: at('no result', 0), now }));
  // over the cap: shown 12, the cap 11 (a plain piece waits at level 41); at 42 the cap is 12
  const plain: InventoryItem = { slot: 5, name: 'diamond_boots', count: 1 };
  t.is(anvilPlan([CHESTPLATE, plain], inStore([b]), 41, { tried: at('over the cap', 0, 12), now }), undefined);
  t.like(anvilPlan([CHESTPLATE, plain], inStore([b]), 42, { tried: at('over the cap', 0, 12), now }), { key: k, cap: 12 });
});

test('anvilPlan: never a book that spoils a piece (shuts out a wanted enchantment, or a curse); one that adds nothing wanted is no job', (t) => {
  const boots: InventoryItem = { slot: 36, name: 'diamond_boots', count: 1, enchanted: true, enchantments: en('feather_falling 4, unbreaking 3') };
  // blast protection would shut protection out for good; frost walker, depth strider
  t.is(anvilPlan([boots], inStore([book(0, 'blast_protection 4')]), 52), undefined);
  t.is(anvilPlan([boots], inStore([book(0, 'frost_walker 2, unbreaking 3')]), 52), undefined);
  t.like(anvilPlan([boots], inStore([book(0, 'blast_protection 4'), book(1, 'protection 3')]), 52), { add: { slot: 1 }, for: en('protection 3') });
  const pick: InventoryItem = { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 5, unbreaking 3') };
  t.is(anvilPlan([pick], inStore([book(0, 'silk_touch 1')]), 52), undefined);
  t.is(anvilPlan([pick], inStore([book(0, 'mending 1, vanishing_curse 1')]), 52), undefined);
  // a book of the bow's: goes on none of it
  t.is(anvilPlan([pick], inStore([book(0, 'power 5, infinity 1')]), 52), undefined);
  // the same level as the piece's at its most (unbreaking 3): nothing raised, no job
  t.is(anvilPlan([pick], inStore([book(0, 'unbreaking 3')]), 52), undefined);
  // a piece with the curse of binding never (it does not come off)
  t.is(anvilPlan([{ ...boots, enchantments: en('feather_falling 4, binding_curse 1') }], inStore([book(0, 'protection 4')]), 52), undefined);
});

test('anvilPlan: a worn piece needs a pocket slot to come off into, and the book from a chest one more', (t) => {
  t.like(anvilPlan([CHESTPLATE], inStore([book(3, 'protection 4')]), 52, { free: 2 }), { add: { chest: STORE } });
  t.is(anvilPlan([CHESTPLATE], inStore([book(3, 'protection 4')]), 52, { free: 1 }), undefined);
  t.like(anvilPlan([CHESTPLATE, { ...book(14, 'protection 4') }], [], 52, { free: 1 }), { add: { slot: 14 } }, 'a carried book takes none');
  t.is(anvilPlan([CHESTPLATE, { ...book(14, 'protection 4') }], [], 52, { free: 0 }), undefined);
});

test('bookOnto works out the cost and the enchantments as the game does (the fake built from 26.3\'s anvil rules)', (t) => {
  const pieces: InventoryItem[] = [
    CHESTPLATE,
    { slot: 1, name: 'diamond_pickaxe', count: 1, enchantments: en('efficiency 4, fortune 3'), repairCost: 3 },
    { slot: 2, name: 'diamond_sword', count: 1, enchantments: en('unbreaking 3') },
    { slot: 3, name: 'diamond_leggings', count: 1, enchantments: en('blast_protection 4, unbreaking 2'), repairCost: 1 }
  ];
  const books = ['protection 4', 'protection 3', 'mending 1', 'unbreaking 3', 'efficiency 5, unbreaking 2', 'fortune 3', 'silk_touch 1', 'sharpness 5, mending 1', 'protection 4, thorns 3', 'blast_protection 4']
    .map((s, i) => book(10 + i, s, i % 3));
  let compared = 0;
  for (const piece of pieces) for (const b of books) {
    const game = combine(piece, b);
    const plan = bookOnto(piece, b);
    const sorted = (l?: ItemEnchantment[]) => [...(l ?? [])].sort((x, y) => x.name.localeCompare(y.name));
    const what = `${piece.name} + ${named(b)}`;
    if (game.result) {
      t.deepEqual({ cost: plan?.cost, enchantments: sorted(plan?.enchantments) }, { cost: game.cost, enchantments: sorted(game.result.enchantments) }, what);
      compared++;
    } else t.true(!plan || plan.cost >= 40, what);
  }
  t.true(compared >= 20);
});
const named = (b: ChestStack) => (b.enchantments ?? []).map(e => `${e.name} ${e.level}`).join(', ');

// ------------------------------------------------------------------------------------------------ the anvil goal

/** The live yard (brain.json, Nov 14); the workshop's anvil and the bot inside the fence near it. */
const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
function workshopWorld(stacks: ChestStack[] = [], over: Partial<WorldMemory> = {}): WorldMemory {
  const world = {
    landmarks: { chests: [STORE], farmland: [], furnace: { x: -545, y: 63, z: 2185 } }, leash: 96, yard: { ...YARD },
    zones: { 'workshop:anvil': [ANVIL], workshop: [{ x: -544, y: 62, z: 2213, width: 7, length: 7 }] },
    progress: { done: ['enchanting', 'workshop'], journal: [] }, chestAssign: { [key(STORE)]: 'misc' }, ...over
  } as WorldMemory;
  remember(world, STORE, totalsOf(stacks), stacks.map(st => ({ ...st })));
  return world;
}
const totalsOf = (stacks: ChestStack[]) => {
  const out: Record<string, number> = {};
  for (const st of stacks) out[st.name] = (out[st.name] ?? 0) + st.count;
  return out;
};

/**
 * The anvil fake above (anvil.*, armor.unequip) in the workshop: the bot's careful walks arrive; world.region reads the
 * anvil's block; the misc chest holds `stacks` (chest.open and chest.withdraw as the mod's: the stack by its slot, into
 * the pockets' first free from the hotbar's end, as a shift-click from a chest goes); take-from-chest, place-block.
 * `noResult`: the server shows nothing for the pair; `unchanged`: its result keeps the piece's own enchantments. Progress
 * lines come out as brain.log has them (`anvil: ...`).
 */
function atWorkshop(items: InventoryItem[], world: WorldMemory, stacks: ChestStack[] = [], opts: { level?: number; wear?: string; noResult?: boolean; unchanged?: boolean; block?: string } = {}) {
  const a = anvil(items, { level: opts.level, wear: opts.wear });
  const lines: string[] = [];
  let block = opts.block ?? 'minecraft:anvil[facing=north]';
  const inside = stacks.map(st => ({ ...st }));
  const reply = () => ({ slots: 27, free: 27 - inside.length, items: totalsOf(inside), stacks: inside.map(st => ({ ...st })) });
  const pocket = () => [8, 7, 6, 5, 4, 3, 2, 1, 0, ...[...Array(27).keys()].map(k => 35 - k)].find(k => !items.some(i => i.slot === k))!;
  const take = (name: string, slot: number | undefined, count: number) => {
    const st = inside.find(x => x.slot === slot && x.name === name) ?? inside.find(x => x.name === name);
    if (!st) return { moved: 0, from: -1 };
    const n = Math.min(count, st.count);
    st.count -= n;
    if (!st.count) inside.splice(inside.indexOf(st), 1);
    const onto = !st.enchantments && items.find(i => i.slot < 36 && i.name === name && !i.enchantments && i.count + n <= 64);
    if (onto) onto.count += n; else items.push({ ...st, count: n, slot: pocket() });
    return { moved: n, from: st.slot };
  };
  const inner = a.ctx.call;
  a.ctx.world = world;
  a.ctx.progress = (text: string) => { lines.push(`${anvilGoal.name}: ${text}`); };
  a.ctx.call = (async (m: string, p: Record<string, unknown> = {}, ms?: number) => {
    if (m === 'goto') { a.calls.push(`goto ${JSON.stringify(p)}`); return { arrived: true }; }
    if (m === 'world.region') return { blocks: [block] };
    if (m === 'inventory') return { items: items.map(i => ({ ...i })) };
    if (m === 'chest.open') { a.calls.push('chest.open'); return reply(); }
    if (m === 'chest.withdraw') {
      a.calls.push(`chest.withdraw ${JSON.stringify(p)}`);
      const moved = take(p.name as string, p.slot as number | undefined, (p.count as number | undefined) ?? 64);
      return { ...reply(), ...moved };
    }
    if (m === 'container.close') return { ok: true };
    const r = await inner(m, p, ms);
    if (m === 'anvil.put' && opts.noResult && p.which === 'additional') return { ...(r as object), result: null, cost: 0 };
    // a result that keeps the piece's own enchantments (what the plan did not foresee)
    const st = r as { input?: AnvilStack; result?: AnvilStack | null };
    if (m === 'anvil.put' && opts.unchanged && p.which === 'additional' && st.result) return { ...st, result: { ...st.result, enchantments: st.input?.enchantments } };
    return r;
  }) as GoalContext['call'];
  a.ctx.act = (async (tool: string, p: Record<string, unknown> = {}) => {
    a.calls.push(`${tool} ${JSON.stringify(p)}`);
    if (tool === 'take-from-chest') {
      const r = take(p.item as string, undefined, (p.count as number | undefined) ?? 64);
      const holds = Object.entries(totalsOf(inside)).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
      return { ok: true, text: `Took ${r.moved} ${String(p.item)} from the chest at (${p.x}, ${p.y}, ${p.z}). It holds: ${holds}.` };
    }
    if (tool === 'place-block') {
      const i = items.findIndex(x => x.slot < 36 && x.name === p.item);
      if (i < 0) return { ok: true, text: `No ${String(p.item)} in inventory to place` };
      items.splice(i, 1);
      block = 'minecraft:anvil[facing=east]';
      return { ok: true, text: `Placed minecraft:anvil at (${p.x}, ${p.y}, ${p.z}) using up face` };
    }
    return { ok: true, text: 'ok' };
  }) as GoalContext['act'];
  return { ...a, lines, inside, setBlock: (b: string) => { block = b; } };
}

/** The live kit with the chestplate worn and no book carried: the books are in the chests. */
const kitOnly = () => wornKit().filter(i => i.name !== 'enchanted_book');

test('anvil goal: protection 4 onto the worn chestplate, the book out of the chest by its slot, the walk on foot, the anvil closed', async (t) => {
  const stacks = [{ slot: 0, name: 'oak_sign', count: 4 }, book(3, 'protection 4')];
  const world = workshopWorld(stacks);
  const w = atWorkshop(kitOnly(), world, stacks);
  t.is(anvilGoal.wants(w.ctx.s, world), 'level 52: protection 4 onto the diamond_chestplate (worn)');
  t.is(await anvilGoal.run(w.ctx), 'protection 4 onto the diamond_chestplate (cost 9, level 52 -> 43); worn again');
  t.deepEqual(w.calls, [
    'chest.open',
    'chest.withdraw {"name":"enchanted_book","slot":3,"count":1}', // that book, not the first by name
    `goto ${JSON.stringify({ ...ANVIL, range: 2, careful: true, timeoutMs: 60_000 })}`, // on foot only
    'armor.unequip {"slot":"chest","holdMs":30000}',
    `anvil.open ${JSON.stringify(ANVIL)}`,
    'anvil.put {"which":"input","name":"diamond_chestplate","slot":9,"count":1}',
    'anvil.put {"which":"additional","name":"enchanted_book","slot":8,"count":1}', // where the shift-click put it
    'anvil.take {}',
    'anvil.close {}'
  ]);
  t.deepEqual(w.lines, ['anvil: took the diamond_chestplate off for the anvil', 'anvil: protection 4 onto the diamond_chestplate (cost 9, level 52 -> 43)']);
  t.like(w.items.find(i => i.name === 'diamond_chestplate'), { slot: 38, enchantments: en('protection 4, unbreaking 3, thorns 2') });
  // the chest's memory without the book; nothing more for the anvil
  t.deepEqual(world.chestStacks![key(STORE)], [{ slot: 0, name: 'oak_sign', count: 4 }]);
  t.is(anvilGoal.wants(w.ctx.s, world), null);
  t.like(anvilGoal.declines!(w.ctx.s, world), { cause: 'unneeded', text: 'nothing for the anvil (level 52, may spend 39)' });
});

test('anvil goal: a worn pickaxe mended with the diamonds it carries: "repaired the diamond_pickaxe with 3 diamonds (cost 4)"', async (t) => {
  const items: InventoryItem[] = [
    { slot: 0, name: 'diamond_sword', count: 1, enchanted: true, enchantments: en('unbreaking 3') },
    { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 5, fortune 3, unbreaking 3'), damage: 1100, maxDamage: 1561, repairCost: 1 },
    { slot: 20, name: 'diamond', count: 64 }
  ];
  const world = workshopWorld();
  const w = atWorkshop(items, world);
  t.is(anvilGoal.wants(w.ctx.s, world), 'level 52: repair the diamond_pickaxe (29% left) with 3 diamonds');
  t.is(await anvilGoal.run(w.ctx), 'repaired the diamond_pickaxe with 3 diamonds (cost 4)');
  t.deepEqual(w.calls.slice(1), [
    `anvil.open ${JSON.stringify(ANVIL)}`,
    'anvil.put {"which":"input","name":"diamond_pickaxe","slot":1,"count":1}',
    'anvil.put {"which":"additional","name":"diamond","slot":20,"count":3}',
    'anvil.take {}',
    'anvil.close {}'
  ]);
  t.deepEqual(w.lines, ['anvil: repaired the diamond_pickaxe with 3 diamonds (cost 4)']);
  t.like(w.items.find(i => i.name === 'diamond_pickaxe'), { damage: 0, repairCost: 3 });
  t.is(w.level(), 48);
});

test('anvil goal: a pair that gives no result is remembered, the next run takes the next book, and it never goes round on them', async (t) => {
  const items = [...kitOnly(), book(14, 'protection 4'), book(15, 'protection 4, thorns 3')];
  const world = workshopWorld();
  const w = atWorkshop(items, world, [], { noResult: true });
  // the cheaper of the two first (9; the thorns add 12)
  t.like(planFor(w.ctx.s, world), { add: { slot: 14 }, cost: 9 });
  t.is(await anvilGoal.run(w.ctx), "left the diamond_chestplate as it was: the enchanted_book and the diamond_chestplate don't combine (no result); worn again");
  t.false(w.calls.some(c => c.startsWith('anvil.take')));
  t.deepEqual(Object.keys(world.anvil!.tried!), ['diamond_chestplate[protection 3,thorns 2,unbreaking 3]+enchanted_book[protection 4]']);
  t.like(world.anvil!.tried![Object.keys(world.anvil!.tried!)[0]], { why: 'no result', at: w.ctx.s.now });
  t.like(planFor(w.ctx.s, world), { piece: { name: 'diamond_chestplate' }, add: { enchantments: en('protection 4, thorns 3') }, cost: 21 });
  // then the leggings with each book, and that is all: four pairs, each tried once
  const runs: string[] = [];
  for (let n = 0; n < 10 && anvilGoal.wants(w.ctx.s, world); n++) runs.push(await anvilGoal.run(w.ctx));
  t.deepEqual(runs.map(r => r.replace(/ as it was: .*/, '')), ['left the diamond_chestplate', 'left the diamond_leggings', 'left the diamond_leggings']);
  t.is(Object.keys(world.anvil!.tried!).length, 4);
  t.is(w.calls.filter(c => c.startsWith('anvil.put {"which":"additional"')).length, 4);
  t.is(planFor(w.ctx.s, world), undefined);
  t.like(anvilGoal.declines!(w.ctx.s, world), { cause: 'unneeded' });
  // both books still carried, the armour worn again
  t.is(w.items.filter(i => i.name === 'enchanted_book').length, 2);
  t.is(w.items.find(i => i.name === 'diamond_chestplate')?.slot, 38);
  t.is(w.items.find(i => i.name === 'diamond_leggings')?.slot, 37);
});

test('anvil goal: a repair never pays with the diamonds a community mission is owed, carried or held in the chests', async (t) => {
  const pick = (): InventoryItem => ({ slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 5, fortune 3, unbreaking 3'), damage: 1100, maxDamage: 1561, repairCost: 1 });
  // a diamond mission: 4 gathered, none delivered yet (a delivery that failed leaves them carried for a while)
  const community = (gathered: number): WorldMemory['community'] => ({
    chests: { community1: { x: 300, y: 64, z: 300 } }, nextId: 2,
    missions: [{ id: 1, item: 'diamond', count: 64, chest: 'community1', gathered, delivered: 0, status: 'active', createdAt: 0, updatedAt: 0 }]
  });
  const owed4 = { community: community(4) };
  // the bot's own: the repair takes 3 of them
  t.like(planFor(snap([pick(), { slot: 20, name: 'diamond', count: 4 }]), workshopWorld()), { job: 'repair', add: { name: 'diamond', count: 3, slot: 20 } });
  // the same 4 owed to the community, and none of its own: no repair
  t.is(planFor(snap([pick(), { slot: 20, name: 'diamond', count: 4 }]), workshopWorld([], owed4)), undefined);
  // 4 more of its own carried: the repair takes those, and the owed 4 stay
  const items = [pick(), { slot: 20, name: 'diamond', count: 4 }, { slot: 21, name: 'diamond', count: 4 }];
  const world = workshopWorld([], owed4);
  t.like(planFor(snap(items), world), { job: 'repair', add: { count: 3, slot: 21 } });
  const w = atWorkshop(items, world);
  t.is(await anvilGoal.run(w.ctx), 'repaired the diamond_pickaxe with 3 diamonds (cost 4)');
  t.true(w.calls.includes('anvil.put {"which":"additional","name":"diamond","slot":21,"count":3}'));
  t.is(count(w.items, 'diamond'), 5);
  t.is(w.items.find(i => i.slot === 20)?.count, 4, 'the community\'s 4 untouched');
  // in the chests: a stack the reserve holds back is no stack to take by its slot, nor by name; one the free count covers is
  const stack = [{ slot: 9, name: 'diamond', count: 4 }];
  t.is(planFor(snap([pick()]), workshopWorld(stack, { reserved: { community: { diamond: 4 } } })), undefined);
  t.is(planFor(snap([pick()]), workshopWorld(stack, { reserved: { community: { diamond: 2 } } })), undefined, '2 free, 3 wanted');
  t.like(planFor(snap([pick()]), workshopWorld(stack, { reserved: { community: { diamond: 1 } } })), { add: { count: 3, chest: STORE, slot: 9 } });
  t.like(planFor(snap([pick()]), workshopWorld(stack)), { add: { count: 3, chest: STORE, slot: 9 } });
});

test('anvil goal: a take that wears the anvil out puts another down there next, from the chests, on foot', async (t) => {
  const stacks = [{ slot: 2, name: 'anvil', count: 1 }];
  const world = workshopWorld(stacks);
  const w = atWorkshop([...kitOnly(), book(14, 'protection 4')], world, stacks, { wear: 'air' });
  t.is(await anvilGoal.run(w.ctx), 'protection 4 onto the diamond_chestplate (cost 9, level 52 -> 43); the anvil wore out: one goes down there next; worn again');
  t.deepEqual(world.anvil!.gone, ANVIL);
  w.setBlock('minecraft:air');
  t.is(anvilGoal.wants(w.ctx.s, world), `put the anvil back at (${ANVIL.x}, ${ANVIL.y}, ${ANVIL.z}) (the last one wore out)`);
  w.calls.length = 0;
  t.is(await anvilGoal.run(w.ctx), `put a new anvil down at (${ANVIL.x}, ${ANVIL.y}, ${ANVIL.z})`);
  t.deepEqual(w.calls, [
    `take-from-chest ${JSON.stringify({ ...STORE, item: 'anvil', count: 1 })}`,
    `goto ${JSON.stringify({ ...ANVIL, range: 3, careful: true, timeoutMs: 60_000 })}`,
    `place-block ${JSON.stringify({ ...ANVIL, item: 'anvil', faceDirection: 'down' })}`
  ]);
  t.is(world.anvil!.gone, undefined);
  // and with no anvil and too little iron: it says so, and waits
  const short = workshopWorld([], { anvil: { gone: { ...ANVIL } } });
  remember(short, STORE, { iron_ingot: 20, raw_iron: 2 });
  t.like(anvilGoal.declines!(w.ctx.s, short), { cause: 'kit', text: `no anvil to put back at (${ANVIL.x}, ${ANVIL.y}, ${ANVIL.z}), nor 31 iron for one` });
  remember(short, STORE, { iron_ingot: 20, raw_iron: 11 });
  t.regex(anvilGoal.wants(w.ctx.s, short) ?? '', /^put the anvil back/);
});

test('anvil goal: an anvil found gone at the walk is written down, not worked at; something else standing there is left alone', async (t) => {
  const world = workshopWorld();
  const w = atWorkshop([...kitOnly(), book(14, 'protection 4')], world, [], { block: 'minecraft:air' });
  t.is(await anvilGoal.run(w.ctx), `the anvil at (${ANVIL.x}, ${ANVIL.y}, ${ANVIL.z}) is gone: one goes down there next`);
  t.false(w.calls.some(c => /^(anvil\.|armor\.)/.test(c)));
  t.deepEqual(world.anvil!.gone, ANVIL);
  w.setBlock('minecraft:oak_planks');
  t.is(await anvilGoal.run(w.ctx), `left the anvil's place at (${ANVIL.x}, ${ANVIL.y}, ${ANVIL.z}) alone: oak_planks stands there now`);
  t.is(world.anvil!.gone, undefined);
});

test('anvil goal: books in a chest whose stacks memory let go of are looked over, then used; not again within the hour', async (t) => {
  const stacks = [book(3, 'protection 4')];
  const world = workshopWorld();
  // the stash put the book in with a tool: memory counts it, and cannot tell which
  remember(world, STORE, { enchanted_book: 1 });
  const w = atWorkshop(kitOnly(), world, stacks);
  t.is(anvilGoal.wants(w.ctx.s, world), 'look over the enchanted books in 1 chest(s)');
  t.is(await anvilGoal.run(w.ctx), 'protection 4 onto the diamond_chestplate (cost 9, level 52 -> 43); worn again');
  t.deepEqual(w.lines, [
    'anvil: looked over the books in 1 chest(s): protection 4 onto the diamond_chestplate (worn)',
    'anvil: took the diamond_chestplate off for the anvil',
    'anvil: protection 4 onto the diamond_chestplate (cost 9, level 52 -> 43)'
  ]);
  t.is(world.anvil!.lookedAt, w.ctx.s.now);
  // memory let go again: within the hour not looked over
  remember(world, STORE, { enchanted_book: 1 });
  t.like(anvilGoal.declines!({ ...w.ctx.s, now: w.ctx.s.now + LOOK_EVERY - 60_000 }, world), { cause: 'unneeded' });
  t.is(anvilGoal.wants({ ...w.ctx.s, now: w.ctx.s.now + LOOK_EVERY }, world), 'look over the enchanted books in 1 chest(s)');
});

test('anvil goal: the gate in its order: no workshop, no anvil, nothing to do, not in the yard, no room, the hour', (t) => {
  const items = [...kitOnly(), book(14, 'protection 4')];
  const s = { ...snap(items), slotsUsed: 3 };
  const world = workshopWorld();
  t.like(anvilGoal.declines!(s, { ...world, progress: { done: ['enchanting'], journal: [] } }), { cause: 'unneeded', text: 'no workshop yet' });
  t.like(anvilGoal.declines!(s, { ...world, zones: {} }), { cause: 'unneeded', text: 'no anvil in the yard' });
  // an anvil the improvement run put up in the yard: the workshop's done rule counts it, and so does the goal
  t.is(anvilGoal.wants(s, { ...world, zones: {}, landmarks: { ...world.landmarks, anvil: { x: -540, y: 63, z: 2150 } } }), 'level 52: protection 4 onto the diamond_chestplate (worn)');
  t.like(anvilGoal.declines!({ ...s, xpLevel: 3 }, world), { cause: 'unneeded', text: 'nothing for the anvil (level 3, may spend 3)' });
  // out past the fence, and under the yard
  t.like(anvilGoal.declines!({ ...s, position: { x: -530, y: 63, z: 2190 }, distHome: 19 }, world), { cause: 'away', text: "19 blocks from home, not in the yard on home's level (the anvil works from the yard)" });
  t.like(anvilGoal.declines!({ ...s, position: { x: -541, y: 30, z: 2212 } }, world), { cause: 'away' });
  // the worn piece off and nothing else to fetch: one slot, and the stash's 2 left: under 34
  t.is(anvilGoal.wants({ ...s, slotsUsed: 33 }, world), 'level 52: protection 4 onto the diamond_chestplate (worn)');
  t.like(anvilGoal.declines!({ ...s, slotsUsed: 34 }, world), { cause: 'pockets', text: '34/36 slots (anvil runs under 34)' });
  t.like(anvilGoal.declines!({ ...s, timeOfDay: 11500, activity: 'return' }, world), { cause: 'late' });
  t.like(anvilGoal.declines!({ ...s, timeOfDay: 11500 }, world), { cause: 'late' });
  // a gate only looks: nothing written
  const before = JSON.stringify(world);
  for (let used = 0; used <= 36; used++) anvilGoal.wants({ ...s, slotsUsed: used }, world);
  t.is(JSON.stringify(world), before);
  t.false(anvilGoal.cuts!(s, world), 'an anvil job waits for what runs to end');
  t.is(anvilGoal.priority, 31);
});

test('anvil goal: a result without what the job was for is not paid for, and the pair is remembered', async (t) => {
  const world = workshopWorld();
  const w = atWorkshop([...kitOnly(), book(14, 'protection 4')], world, [], { unchanged: true });
  t.is(await anvilGoal.run(w.ctx), 'left the diamond_chestplate as it was: the diamond_chestplate it would make (protection 3, unbreaking 3, thorns 2) is not what it was for; worn again');
  t.false(w.calls.some(c => c.startsWith('anvil.take')));
  t.is(w.level(), 52);
  t.like(Object.values(world.anvil!.tried!), [{ why: 'not wanted', cost: 9 }]);
  // the next is the leggings with that book, not the chestplate again
  t.like(planFor(w.ctx.s, world), { piece: { name: 'diamond_leggings' } });
});

test('anvilPlan: books go on the piece in use (the kit\'s best of the kind), not the spare; repairs on either', (t) => {
  const spare: InventoryItem = { slot: 2, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('unbreaking 1'), damage: 1400, maxDamage: 1561 };
  const best: InventoryItem = { slot: 1, name: 'diamond_pickaxe', count: 1, enchanted: true, enchantments: en('efficiency 5, fortune 3, unbreaking 2') };
  t.like(anvilPlan([spare, best], inStore([book(0, 'unbreaking 3')]), 52), { job: 'book', piece: { slot: 1 } });
  t.like(anvilPlan([spare, best, { slot: 20, name: 'diamond', count: 9 }], inStore([book(0, 'unbreaking 3')]), 52), { job: 'repair', piece: { slot: 2 } });
});

test('anvil goal: the book from the chest goes in by what it holds, not the first carried of its name', async (t) => {
  const stacks = [book(3, 'protection 4')];
  const world = workshopWorld(stacks);
  // a book of no use carried already, in the pockets before the one fetched
  const w = atWorkshop([...kitOnly(), book(20, 'bane_of_arthropods 5')], world, stacks);
  t.is(await anvilGoal.run(w.ctx), 'protection 4 onto the diamond_chestplate (cost 9, level 52 -> 43); worn again');
  t.true(w.calls.includes('anvil.put {"which":"additional","name":"enchanted_book","slot":8,"count":1}'));
  t.deepEqual(w.items.filter(i => i.name === 'enchanted_book').map(i => i.enchantments), [en('bane_of_arthropods 5')]);
});
