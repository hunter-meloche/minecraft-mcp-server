import test from 'ava';
import {
  DEBRIS, INGOT_SCRAP, PIECES, SMITH_HOLD_MS, SMITH_SLOTS, TEMPLATE_COPY, TEMPLATE_SPARE, allNetherite, ingotsHome, netheriteMilestone, netheriteNeed,
  SMITH_DROPS_AFTER_MS, pieceToSmith, pieceWaits, smithDropsGoal, smithingTable, templatesHome
} from '../../src/client/brain/netherite.js';
import { RECIPES, rawShort, recipeFor, selfMade, type MilestoneState, type StepResult } from '../../src/client/brain/progress.js';
import { RAW_ORE_IN, SMELTED, oreOut } from '../../src/client/brain/project.js';
import { cooksInto, smelt } from '../../src/client/brain/chores.js';
import { key, remember } from '../../src/client/brain/chests.js';
import { fireGear } from '../../src/client/brain/netherset.js';
import { TREE } from '../../src/client/brain/tree.js';
import type { Pos, WorldMemory } from '../../src/client/brain/memory.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import { NETHERITE_INGOT, NETHERITE_TEMPLATE, netheriteOf, type ChestStack, type InventoryItem, type ItemEnchantment } from '../../src/client/tools.js';

const MINUTE = 60_000;
const en = (s: string): ItemEnchantment[] => s.split(', ').map(x => { const [name, l] = x.split(' '); return { name, level: Number(l) }; });

// ------------------------------------------------------------------------------------------------ the chain's recipes

/**
 * The netherite's recipes as the 26.3 client jar has them (versions/26.3/26.3.jar, data/minecraft/recipe/*.json, copied
 * as they are): the brain's RECIPES must make the same from the same, and SMELTED the scrap from what the furnace takes.
 */
const JAR: Record<string, unknown> = {
  netherite_ingot: {
    type: 'minecraft:crafting_shapeless', group: 'netherite_ingot',
    ingredients: ['minecraft:netherite_scrap', 'minecraft:netherite_scrap', 'minecraft:netherite_scrap', 'minecraft:netherite_scrap', 'minecraft:gold_ingot', 'minecraft:gold_ingot', 'minecraft:gold_ingot', 'minecraft:gold_ingot'],
    result: { id: 'minecraft:netherite_ingot' }
  },
  netherite_upgrade_smithing_template: {
    type: 'minecraft:crafting_shaped', key: { '#': 'minecraft:diamond', C: 'minecraft:netherrack', S: 'minecraft:netherite_upgrade_smithing_template' },
    pattern: ['#S#', '#C#', '###'], result: { count: 2, id: 'minecraft:netherite_upgrade_smithing_template' }
  }
};
const SMELTING = { netherite_scrap: { type: 'minecraft:smelting', cookingtime: 200, experience: 2.0, ingredient: 'minecraft:ancient_debris', result: { id: 'minecraft:netherite_scrap' } } };
function fromJar(r: unknown): { makes: number; from: Record<string, number> } {
  const j = r as { key?: Record<string, string>; pattern?: string[]; ingredients?: string[]; result: { count?: number } };
  const ids = j.pattern ? j.pattern.join('').split('').filter(ch => ch !== ' ').map(ch => j.key![ch]) : j.ingredients!;
  const from: Record<string, number> = {};
  for (const id of ids) { const n = id.replace(/^minecraft:/, ''); from[n] = (from[n] ?? 0) + 1; }
  return { makes: j.result.count ?? 1, from };
}

test('the chain is the 26.3 jar\'s: four scrap and four gold an ingot, seven diamonds, a netherrack and a template two templates, the scrap smelted from ancient debris', (t) => {
  for (const item of Object.keys(JAR)) {
    t.deepEqual(RECIPES[item], fromJar(JAR[item]), item);
    t.deepEqual(recipeFor(item), RECIPES[item], `${item}: read as it is`);
  }
  t.is(SMELTED.netherite_scrap, SMELTING.netherite_scrap.ingredient.replace(/^minecraft:/, ''));
  // the module's own constants, written out (nothing of another module at its top level), are the recipes'
  t.deepEqual({ ...TEMPLATE_COPY, [NETHERITE_TEMPLATE]: 1 }, RECIPES[NETHERITE_TEMPLATE].from);
  t.is(INGOT_SCRAP, RECIPES[NETHERITE_INGOT].from.netherite_scrap);
  t.is(DEBRIS, 'ancient_debris');
  // an ingot from the stores: the scrap is the furnace's, the gold the chests'
  t.deepEqual(rawShort({ netherite_ingot: 1 }, { gold_ingot: 1549 }), { netherite_scrap: 4 });
  t.deepEqual(rawShort({ netherite_ingot: 4 }, { gold_ingot: 1549, netherite_scrap: 16 }), {});
});

test('the template is made of itself: with none at all it is short of one and nothing else (no walk seven deep); with one, the copy\'s diamonds and netherrack', (t) => {
  t.true(selfMade(NETHERITE_TEMPLATE));
  t.false(selfMade(NETHERITE_INGOT));
  t.false(selfMade('stick'));
  t.deepEqual(rawShort({ [NETHERITE_TEMPLATE]: 1 }, {}), { [NETHERITE_TEMPLATE]: 1 });
  t.deepEqual(rawShort({ [NETHERITE_TEMPLATE]: 1 }, { diamond: 2314, netherrack: 31 }), { [NETHERITE_TEMPLATE]: 1 });
  // one there makes two: the one goes into the copy, not toward the count
  t.deepEqual(rawShort({ [NETHERITE_TEMPLATE]: 2 }, { [NETHERITE_TEMPLATE]: 1 }), { diamond: 7, netherrack: 1 });
  t.deepEqual(rawShort({ [NETHERITE_TEMPLATE]: 2 }, { [NETHERITE_TEMPLATE]: 1, diamond: 7, netherrack: 1 }), {});
  t.deepEqual(rawShort({ [NETHERITE_TEMPLATE]: 1 }, { [NETHERITE_TEMPLATE]: 1 }), {});
});

test('the smelt loads the ancient debris carried home and goes, as raw ore: "loaded 6 ancient_debris (1 coal)"; a debris load in the furnace is taken out for the project\'s few', async (t) => {
  t.is(cooksInto(DEBRIS), 'netherite_scrap');
  t.true(RAW_ORE_IN.test('Furnace input slot is occupied by ancient_debris'));
  t.true(RAW_ORE_IN.test('Furnace input slot is occupied by raw_gold'));
  t.false(RAW_ORE_IN.test('Furnace input slot is occupied by sand'));
  const items: InventoryItem[] = [{ slot: 9, name: DEBRIS, count: 6 }, { slot: 10, name: 'coal', count: 3 }];
  const counts = new Map(items.map(i => [i.name, i.count]));
  const s = {
    now: 10 * 60 * MINUTE, timeOfDay: 1000, activity: 'work', health: 20, food: 20, position: { x: 0, y: 64, z: 0 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: 2, home: { x: 0, y: 64, z: 0, dimension: 'overworld' }, distHome: 0
  } as Snapshot;
  const world = { landmarks: { chests: [], farmland: [], furnace: { x: -1, y: 64, z: 0 } }, leash: 96, chestItems: {}, lastDone: { furnace: s.now - MINUTE } } as unknown as WorldMemory;
  t.is(smelt.wants(s, world), '6 ancient_debris to smelt');
  const acts: [string, Record<string, unknown>][] = [];
  const ctx = {
    s, world, signal: new AbortController().signal,
    act: async (tool: string, a: Record<string, unknown>) => {
      acts.push([tool, a]);
      if (tool !== 'smelt-item') return { ok: true, text: '' };
      items[0].count -= Number(a.inputCount);
      items[1].count -= 1;
      return { ok: true, text: `Started smelting ${a.inputCount} ${a.inputItem} with 1 coal` };
    },
    call: (async (m: string) => {
      if (m === 'inventory') return { items: items.filter(i => i.count > 0) };
      if (m === 'furnace.open') return { open: true, output: null, input: null, lit: false };
      return {};
    }) as GoalContext['call'],
    status: async () => ({ inWorld: true, username: 'b', screen: null }),
    progress: () => undefined
  };
  t.is(await smelt.run(ctx as never), 'loaded 6 ancient_debris (1 coal), done about 10:01:03Z');
  t.like(acts.find(([n]) => n === 'smelt-item')?.[1], { inputItem: DEBRIS, inputCount: 6, fuelItem: 'coal', takeOutput: false });
  t.deepEqual(world.furnaceLoad, { item: DEBRIS, count: 6, at: s.now });
  // the project's few (a build's stone) find the debris in the furnace: it comes out into the pockets, the next load
  let back = 0;
  const takes: unknown[] = [];
  const octx = {
    s, world, signal: new AbortController().signal,
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      if (m === 'furnace.open') return { open: true, input: { name: DEBRIS, count: 6 }, output: null, lit: true };
      if (m === 'furnace.take') { takes.push(a); back = 6; return {}; }
      if (m === 'inventory') return { items: back ? [{ slot: 9, name: DEBRIS, count: back }] : [] };
      return {};
    }) as GoalContext['call']
  };
  t.true(await oreOut(octx as never));
  t.deepEqual(takes, [{ slot: 'input' }]);
  t.is(world.furnaceLoad, undefined);
});

// ------------------------------------------------------------------------------------------------ the workshop and the bot

const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const SMITHING: Pos = { x: -541, y: 63, z: 2153 };
const STORE: Pos = { x: -547, y: 63, z: 2180 };
const FURNACE: Pos = { x: -545, y: 63, z: 2185 };
const HOME = { x: -549, y: 63, z: 2183, dimension: 'overworld' };
const INSIDE = { x: -543, y: 63, z: 2160 };

const P4 = 'protection 4, unbreaking 3, mending 1';
/** The main set as worn on Nov 18 (protection 4 on every piece), and the kit's tools and coal. */
const mainSet = (): InventoryItem[] => [
  { slot: 0, name: 'diamond_sword', count: 1, enchantments: en('sharpness 5, unbreaking 3') },
  { slot: 1, name: 'diamond_pickaxe', count: 1, enchantments: en('efficiency 5, fortune 3') },
  { slot: 2, name: 'coal', count: 16 },
  { slot: 36, name: 'diamond_boots', count: 1, enchantments: en(`${P4}, feather_falling 4`), damage: 30, maxDamage: 429, repairCost: 7 },
  { slot: 37, name: 'diamond_leggings', count: 1, enchantments: en(P4), damage: 12, maxDamage: 495, repairCost: 3 },
  { slot: 38, name: 'diamond_chestplate', count: 1, enchantments: en(P4), damage: 40, maxDamage: 528, repairCost: 3 },
  { slot: 39, name: 'diamond_helmet', count: 1, enchantments: en(`${P4}, respiration 3`), damage: 5, maxDamage: 363, repairCost: 7 }
];
/** The Nether helmet in its chest (netherset.ts: fire protection 4 on gold), which the milestone never smiths. */
const NETHER_HELMET: ChestStack = { slot: 20, name: 'golden_helmet', count: 1, enchantments: en('fire_protection 4, unbreaking 3, mending 1') };
const st = (slot: number, name: string, count: number): ChestStack => ({ slot, name, count });
/** The chest as the bastion and the tunnels would have left it: one template, the scrap of four ingots, and the stores. */
const STORES = (): ChestStack[] => [st(0, NETHERITE_TEMPLATE, 1), st(1, 'diamond', 64), st(2, 'netherrack', 31), st(3, 'netherite_scrap', 16), st(4, 'gold_ingot', 64), { ...NETHER_HELMET }];

const totalsOf = (stacks: ChestStack[]) => {
  const out: Record<string, number> = {};
  for (const s of stacks) out[s.name] = (out[s.name] ?? 0) + s.count;
  return out;
};

/** The live homestead's workshop (brain.json Nov 18): its smithing table, the misc chest holding `stacks`, the furnace. */
function smithWorld(stacks: ChestStack[], over: Partial<WorldMemory> = {}): WorldMemory {
  const world = {
    landmarks: { chests: [STORE], farmland: [], furnace: FURNACE, smithing: SMITHING }, leash: 96, yard: { ...YARD },
    zones: { 'workshop:smithing': [SMITHING], workshop: [{ x: -546, y: 62, z: 2152, width: 7, length: 7 }] },
    progress: { done: ['workshop', 'nether-portal', 'brewing', 'wart-farm'], journal: [] }, chestAssign: { [key(STORE)]: 'misc' }, ...over
  } as WorldMemory;
  remember(world, STORE, totalsOf(stacks), stacks.map(s => ({ ...s })));
  return world;
}

const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) if (i.slot < 36) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: 10 * 60 * MINUTE, timeOfDay: 2000, activity: 'work', health: 20, food: 20, position: { ...INSIDE }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    xpLevel: 40, home: HOME, distHome: 23, ...over
  } as Snapshot;
};

const TIER: Record<string, number> = { netherite: 6, diamond: 5, golden: 2 };
const tierOf = (name: string) => TIER[name.split('_')[0]] ?? 0;

/**
 * The bot at the workshop as the mod's Smithing.java and the server would have it, on the pockets (`items`, 0-35, worn
 * 36-39): smith.open; smith.put (the table's mayPlace: a template into `template`, a piece into `base`, the ingot into
 * `addition`; with a pocket `slot`, the piece there and no other of the name, else the first of the name; one of it), with a result once all three are in: the
 * netherite piece with every component of the base, its enchantments, damage and repair cost (26.3
 * createWithOriginalComponents); smith.take (refused with no result or another than `expect`: one template, the piece
 * and an ingot used, the result into the first free pocket); smith.close (what the table holds back to the pockets; a
 * held armour slot wears the best of its kind: netherite over diamond); armor.unequip as the mod's (`refuse`: a hostile
 * near). The chest (take-from-chest by name, the reply as the tool's), craft-item by RECIPES (one template copied
 * into two), smelt-item (debris into scrap), the careful walks arrive. Progress lines as brain.log has them.
 */
function workshop(items: InventoryItem[], world: WorldMemory, stacks: ChestStack[], opts: { refuse?: string; dropAt?: 'template' | 'base' | 'addition' } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const inside = stacks.map(s => ({ ...s }));
  const held = new Set<number>();
  const table: { template?: InventoryItem; base?: InventoryItem; addition?: InventoryItem } = {};
  let open = false;
  const at = (k: number) => items.find(i => i.slot === k);
  const ORDER = [...[...Array(27).keys()].map(k => k + 9), ...Array(9).keys()];
  const toPockets = (s: InventoryItem) => {
    const onto = !s.maxDamage && !s.enchantments?.length && items.find(i => i.slot < 36 && i.name === s.name && !i.enchantments?.length && i.count + s.count <= 64);
    if (onto) { onto.count += s.count; return onto.slot; }
    const k = ORDER.find(n => !at(n));
    if (k === undefined) throw new Error('inventory full');
    items.push({ ...s, slot: k });
    return k;
  };
  const takeOut = (name: string, n: number) => {
    let left = n;
    for (const i of items.filter(x => x.slot < 36 && x.name === name)) {
      const k = Math.min(left, i.count);
      i.count -= k; left -= k;
      if (!i.count) items.splice(items.indexOf(i), 1);
      if (!left) break;
    }
    return n - left;
  };
  const has = (name: string) => items.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0);
  const result = () => (table.template?.name === NETHERITE_TEMPLATE && table.base && netheriteOf(table.base.name) && table.addition?.name === NETHERITE_INGOT
    ? { ...table.base, name: netheriteOf(table.base.name)!, count: 1 } : null);
  const strip = (i?: InventoryItem) => (i ? { name: i.name, count: i.count, ...(i.enchantments ? { enchantments: i.enchantments } : {}) } : null);
  const status = () => ({ open, at: SMITHING, template: strip(table.template), base: strip(table.base), addition: strip(table.addition), result: strip(result() ?? undefined), noRecipe: !!(table.template && table.base && table.addition && !result()) });
  const ctx = {
    s: snap(items), world, signal: new AbortController().signal,
    call: (async (m: string, a: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: items.map(i => ({ ...i })) };
      if (m === 'item.select' || m === 'container.close') return {};
      calls.push(`${m} ${JSON.stringify(a)}`);
      if (m === 'goto') return { arrived: true };
      if (m === 'armor.unequip') {
        if (opts.refuse) throw new Error(opts.refuse);
        const index = { feet: 36, legs: 37, chest: 38, head: 39 }[a.slot as string]!;
        const worn = at(index);
        if (!worn) throw new Error(`nothing worn on the ${String(a.slot)}`);
        const free = ORDER.find(n => !at(n))!;
        worn.slot = free;
        held.add(index);
        return { ok: true, slot: free, name: worn.name, count: 1, holdMs: a.holdMs };
      }
      if (m === 'smith.open') { open = true; return status(); }
      if (m === 'smith.put') {
        if (!open) throw new Error('no smithing table open (smith.open first)');
        const which = a.which as 'template' | 'base' | 'addition';
        const name = a.name as string;
        if (opts.dropAt === which) {
          // a disconnect with the table open: the server throws what is in it on the ground (ItemCombinerMenu.removed)
          open = false;
          for (const k of ['template', 'base', 'addition'] as const) delete table[k];
          throw new Error('not in the world');
        }
        const bySlot = typeof a.slot === 'number' && a.slot >= 0 && a.slot < 36;
        const asked = bySlot ? at(a.slot as number) : undefined;
        const from = bySlot ? (asked?.name === name ? asked : undefined) : items.filter(i => i.slot < 36 && i.name === name).sort((x, y) => x.slot - y.slot)[0];
        if (!from) throw new Error(`no ${name} in inventory${bySlot ? ` slot ${String(a.slot)}` : ''}`);
        const fits = which === 'template' ? /_smithing_template$/.test(name) : which === 'addition' ? name === NETHERITE_INGOT : !!netheriteOf(name);
        if (!fits) throw new Error(`the table's ${which} slot does not take ${name}`);
        if (table[which]) { toPockets(table[which]!); delete table[which]; }
        if (from.count > 1) { from.count--; table[which] = { ...from, count: 1 }; } else { items.splice(items.indexOf(from), 1); table[which] = { ...from }; }
        return { ...status(), which, put: strip(table[which]) };
      }
      if (m === 'smith.take') {
        const r = result();
        if (!r) throw new Error('no result in the smithing table (put the template, the piece and the ingot first)');
        if (a.expect && r.name !== a.expect) throw new Error(`the result is ${r.name}, not ${String(a.expect)}`);
        const from = table.base!.name;
        delete table.template; delete table.base; delete table.addition;
        const slot = toPockets({ ...r, slot: -1 });
        return { ok: true, item: r.name, count: 1, slot, from, enchantments: r.enchantments ?? [], damage: r.damage, maxDamage: r.maxDamage, repairCost: r.repairCost, open };
      }
      if (m === 'smith.close') {
        const was = open;
        for (const k of ['template', 'base', 'addition'] as const) if (table[k]) { toPockets(table[k]!); delete table[k]; }
        open = false;
        const wore: string[] = [];
        const kinds: Record<number, string> = { 36: 'boots', 37: 'leggings', 38: 'chestplate', 39: 'helmet' };
        for (const index of held) {
          if (at(index)) continue;
          const piece = items.filter(i => i.slot < 36 && i.name.endsWith(`_${kinds[index]}`) && i.name !== 'golden_helmet').sort((x, y) => tierOf(y.name) - tierOf(x.name))[0];
          if (piece) { piece.slot = index; wore.push(piece.name); }
        }
        held.clear();
        return { ok: true, wasOpen: was, wore };
      }
      return {};
    }) as GoalContext['call'],
    act: (async (tool: string, p: Record<string, unknown> = {}) => {
      calls.push(`${tool} ${JSON.stringify(p)}`);
      if (tool === 'take-from-chest') {
        const name = p.item as string;
        let left = (p.count as number | undefined) ?? 64;
        let moved = 0;
        for (const s of inside.filter(x => x.name === name)) {
          const k = Math.min(left, s.count);
          s.count -= k; left -= k; moved += k;
          toPockets({ ...s, count: k, slot: -1 });
          if (!s.count) inside.splice(inside.indexOf(s), 1);
          if (!left) break;
        }
        const holds = Object.entries(totalsOf(inside)).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
        return { ok: true, text: `Took ${moved} ${name} from the chest at (${p.x}, ${p.y}, ${p.z}). It holds: ${holds}.` };
      }
      if (tool === 'craft-item') {
        const out = p.outputItem as string;
        const r = RECIPES[out];
        const times = Number(p.amount ?? 1);
        if (!r || Object.entries(r.from).some(([k, v]) => has(k) < v * times)) return { ok: false, text: `Failed: missing ingredients for ${out}` };
        for (const [k, v] of Object.entries(r.from)) takeOut(k, v * times);
        toPockets({ slot: -1, name: out, count: r.makes * times });
        return { ok: true, text: `Successfully crafted ${out} ${times} time(s)` };
      }
      if (tool === 'smelt-item') {
        const input = p.inputItem as string;
        const n = takeOut(input, Number(p.inputCount));
        const outName = Object.entries(SMELTED).find(([, from]) => from === input)![0];
        takeOut(p.fuelItem as string, Math.ceil(n / 8));
        toPockets({ slot: -1, name: outName, count: n });
        return { ok: true, text: `Smelted ${n} ${input} into ${n} ${outName}` };
      }
      return { ok: true, text: 'ok' };
    }) as GoalContext['act'],
    status: async () => ({ inWorld: true, username: 'claudebot', screen: null, position: { ...INSIDE } }),
    progress: (text: string) => { lines.push(text); },
    gain: () => undefined
  } as unknown as GoalContext;
  return { ctx, calls, lines, items, inside, table };
}

const smithCalls = (calls: string[]) => calls.filter(c => /^(smith\.|armor\.unequip)/.test(c));
const MILESTONE = () => TREE.find(m => m.id === 'netherite')!;

// ------------------------------------------------------------------------------------------------ the milestone

test('the netherite milestone: the last of the tree, after the brewing; one step a piece, the chestplate first and the main helmet last', (t) => {
  const m = MILESTONE();
  t.is(TREE.at(-1), m);
  t.is(m.title, 'netherite armour');
  t.deepEqual(m.prereqs, ['brewing']);
  t.deepEqual(PIECES, ['chestplate', 'leggings', 'boots', 'helmet']);
  t.deepEqual(m.steps.map(s => s.name), ['smith the netherite chestplate', 'smith the netherite leggings', 'smith the netherite boots', 'smith the netherite helmet']);
  t.deepEqual(netheriteMilestone(['brewing']).steps.map(s => s.name), m.steps.map(s => s.name));
  t.is(TREE.filter(x => x.id === 'netherite').length, 1);
  const world = smithWorld(STORES());
  t.false(m.done!({ s: snap(mainSet()), world, have: () => 0 }));
  t.deepEqual(smithingTable(world), SMITHING);
  t.deepEqual(smithingTable(smithWorld([], { zones: {} })), SMITHING, 'a smithing table the improvement run put up in the yard');
  t.is(smithingTable(smithWorld([], { zones: {}, landmarks: { chests: [STORE], farmland: [], smithing: { x: -600, y: 63, z: 2153 } } })), undefined, 'not one outside the yard');
});

test('the milestone end to end: each piece off, smithed with its enchantments kept, on again; the template copied before the last one would go, one spare left; the exact log lines; the golden helmet stays gold', async (t) => {
  const m = MILESTONE();
  const items = mainSet();
  const world = smithWorld(STORES());
  const w = workshop(items, world, STORES());
  const state: MilestoneState = { step: 0, data: {} };
  // what the bastion and the tunnels brought is enough: nothing to wait for
  t.is(m.steps[0].waits!({ s: snap(items), world, have: () => 0 }), undefined);
  t.deepEqual(netheriteNeed(items, world), { pieces: [...PIECES], templates: 0, ingots: 0, debris: 0 });

  const r0 = await m.steps[0].run(w.ctx, state);
  t.deepEqual(r0, { status: 'done', text: 'diamond_chestplate -> netherite_chestplate (protection 4, unbreaking 3, mending kept); worn' });
  t.deepEqual(w.lines, [
    'netherite: copied the upgrade template (7 diamonds, 1 netherrack and a template make two): 2 at home, 1 kept spare',
    'netherite: made a netherite_ingot (4 scrap, 4 gold ingots)',
    'took the diamond_chestplate off for the smithing table',
    'smithing: diamond_chestplate -> netherite_chestplate (protection 4, unbreaking 3, mending kept)'
  ]);
  const unequipSlot = JSON.parse(w.calls.find(c => c.startsWith('smith.put {"which":"base"'))!.slice('smith.put '.length)).slot as number;
  t.deepEqual(smithCalls(w.calls), [
    `armor.unequip {"slot":"chest","holdMs":${SMITH_HOLD_MS}}`,
    `smith.open ${JSON.stringify(SMITHING)}`,
    `smith.put {"which":"template","name":"${NETHERITE_TEMPLATE}","count":1}`,
    // the piece armor.unequip took off, by its slot (a spare of its name would be the wrong one)
    `smith.put {"which":"base","name":"diamond_chestplate","slot":${unequipSlot},"count":1}`,
    `smith.put {"which":"addition","name":"${NETHERITE_INGOT}","count":1}`,
    // only the netherite piece is taken: never a trim a stray template would make
    'smith.take {"expect":"netherite_chestplate"}',
    'smith.close {}'
  ]);
  // the copy at a table from one template, seven diamonds and a netherrack; the ingot from four scrap and four gold
  t.true(w.calls.includes(`craft-item {"outputItem":"${NETHERITE_TEMPLATE}","amount":1}`));
  t.true(w.calls.includes(`craft-item {"outputItem":"${NETHERITE_INGOT}","amount":1}`));
  // on foot into the workshop (A11)
  t.true(w.calls.includes(`goto ${JSON.stringify({ ...SMITHING, range: 2, careful: true, timeoutMs: 60_000 })}`));
  // the netherite piece on again, the diamond one's components all there: protection 4, its damage and repair cost
  t.deepEqual(items.find(i => i.slot === 38), { slot: 38, name: 'netherite_chestplate', count: 1, enchantments: en(P4), damage: 40, maxDamage: 528, repairCost: 3 });
  t.false(items.some(i => i.name === 'diamond_chestplate'));
  t.is(templatesHome(items, world), TEMPLATE_SPARE, 'the spare is kept');

  // the rest, one step a run
  for (const k of [1, 2, 3]) {
    state.step = k;
    const r = await m.steps[k].run(w.ctx, state);
    t.is(r.status, 'done', `${m.steps[k].name}: ${(r as StepResult).text}`);
  }
  const smithed = w.lines.filter(l => l.startsWith('smithing: '));
  t.deepEqual(smithed, [
    'smithing: diamond_chestplate -> netherite_chestplate (protection 4, unbreaking 3, mending kept)',
    'smithing: diamond_leggings -> netherite_leggings (protection 4, unbreaking 3, mending kept)',
    'smithing: diamond_boots -> netherite_boots (protection 4, unbreaking 3, mending, feather_falling 4 kept)',
    'smithing: diamond_helmet -> netherite_helmet (protection 4, unbreaking 3, mending, respiration 3 kept)'
  ]);
  t.is(w.lines.filter(l => l.startsWith('netherite: copied')).length, 4, 'four copies of the one looted template');
  t.deepEqual(items.filter(i => i.slot >= 36).sort((a, b) => a.slot - b.slot).map(i => i.name), ['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet']);
  for (const i of items.filter(x => x.slot >= 36)) t.true(i.enchantments!.some(e => e.name === 'protection' && e.level === 4), `${i.name} kept protection 4`);
  // what the chain used: 28 diamonds (regear.ts keeps them), 4 netherrack, the 16 scrap and 16 gold; one template left
  const all = (name: string) => items.filter(i => i.slot < 36 && i.name === name).reduce((a, i) => a + i.count, 0) + (totalsOf(w.inside)[name] ?? 0);
  t.is(all('diamond'), 64 - 4 * TEMPLATE_COPY.diamond);
  t.is(all('netherrack'), 31 - 4);
  t.is(all('netherite_scrap'), 0);
  t.is(all('gold_ingot'), 64 - 16);
  t.is(all(NETHERITE_TEMPLATE), 1);
  t.is(all(NETHERITE_INGOT), 0);
  // the golden Nether helmet never left its chest: it stays gold
  t.like(w.inside.find(s => s.name === 'golden_helmet'), { slot: 20, enchantments: NETHER_HELMET.enchantments });
  t.false(w.calls.some(c => c.includes('golden_helmet')));
  // done, as the world shows it; nothing more wanted of the Nether for it
  t.true(m.done!({ s: snap(items), world, have: () => 0 }));
  t.true(allNetherite(snap(items), world));
  t.deepEqual(netheriteNeed(items, world), { pieces: [], templates: 0, ingots: 0, debris: 0 });
});

test('the fire gear still holds with the netherite pieces: their protection 4 carried over, the golden helmet\'s fire protection 4 over them is 20 against fire (netherset.ts fireGear)', (t) => {
  const golden = { slot: 39, name: 'golden_helmet', count: 1, enchantments: en('fire_protection 4, unbreaking 3, mending 1') };
  const diamond = mainSet();
  const before = fireGear(diamond, golden);
  // the smithing keeps every component of the base (26.3 createWithOriginalComponents): the same enchantments on netherite
  const smithed = diamond.map(i => (i.slot >= 36 && i.slot <= 38 ? { ...i, name: netheriteOf(i.name)! } : i));
  const after = fireGear(smithed, golden);
  t.deepEqual(before, { epf: 20, ok: true, missing: [] });
  t.deepEqual(after, before);
  // a netherite piece is no less than diamond to the gate, but its protection is what counts: without it, short
  const bare = smithed.map(i => (i.slot === 38 ? { ...i, enchantments: en('unbreaking 3, mending 1') } : i));
  t.like(fireGear(bare, golden), { epf: 16, ok: false });
  t.deepEqual(fireGear(bare, golden).missing, ['fire EPF 16 < 20 (the netherite_chestplate has protection 0 (4 wanted))']);
});

test('a piece waits for what the project cannot bring: no template at home (the bastion\'s), no ingot\'s debris (the tunnels\'), and it says so; it fetches and crafts nothing meanwhile', async (t) => {
  const m = MILESTONE();
  const items = mainSet();
  // no template at all: the bastion's treasure chest has one; the spare rule never makes one of none
  const none = STORES().filter(s => s.name !== NETHERITE_TEMPLATE);
  const world = smithWorld(none);
  const w = workshop(items, world, none);
  const why = `no ${NETHERITE_TEMPLATE} at home: a bastion's treasure chest has one`;
  t.is(pieceWaits('chestplate', items, world), why);
  t.is(m.steps[0].waits!({ s: snap(items), world, have: () => 0 }), why);
  t.deepEqual(await m.steps[0].run(w.ctx, { step: 0, data: {} }), { status: 'blocked', text: why, retryMs: 30 * MINUTE });
  t.deepEqual(w.calls, [], 'no chest, no table, no walk');
  t.deepEqual(netheriteNeed(items, world), { pieces: [...PIECES], templates: 1, ingots: 0, debris: 0 });

  // a template, but only two debris: the ingot's makings are short
  const two = [st(0, NETHERITE_TEMPLATE, 1), st(1, 'diamond', 64), st(2, 'netherrack', 31), st(3, DEBRIS, 2), st(4, 'gold_ingot', 64)];
  const w2 = smithWorld(two);
  t.is(ingotsHome(items, w2), 0);
  t.is(pieceWaits('chestplate', items, w2), `no ${NETHERITE_INGOT} at home, and 2 of the 4 ancient debris (or scrap) one takes: the tunnels bring them`);
  t.deepEqual(netheriteNeed(items, w2), { pieces: [...PIECES], templates: 0, ingots: 4, debris: 14 });
  // scrap and debris together make the ingot's four
  t.is(ingotsHome(items, smithWorld([st(3, DEBRIS, 2), st(4, 'netherite_scrap', 2)])), 1);
  t.is(pieceWaits('chestplate', items, smithWorld([st(0, NETHERITE_TEMPLATE, 1), st(3, DEBRIS, 2), st(4, 'netherite_scrap', 2)])), undefined);
  // the pockets full: it waits for the stash, short, and takes nothing out of the chests meanwhile
  const full = [...mainSet(), ...[...Array(28).keys()].map(k => ({ slot: 3 + k, name: 'cobblestone', count: 64 }))];
  const w3 = workshop(full, smithWorld(STORES()), STORES());
  t.deepEqual(await m.steps[0].run(w3.ctx, { step: 0, data: {} }), { status: 'blocked', text: `pockets: 31/36, the smithing wants ${SMITH_SLOTS} free (the templates, the ingot's makings, the piece)`, retryMs: 5 * MINUTE });
  t.deepEqual(w3.calls, []);
  // a carried template counts as well as a stored one
  t.is(templatesHome([...items, { slot: 5, name: NETHERITE_TEMPLATE, count: 1 }], smithWorld([])), 1);
});

test('a piece is smithed only with mending on it and above the anvil\'s repair line: nothing else repairs a netherite piece (the anvil mends diamond with diamonds), and the upgrade keeps the wear', async (t) => {
  const m = MILESTONE();
  const world = smithWorld(STORES());
  // the live main set: protection 4 and unbreaking 3, no mending (brain.log: no "mending onto" line yet)
  const plain = mainSet().map(i => (i.slot >= 36 ? { ...i, enchantments: (i.enchantments ?? []).filter(e => e.name !== 'mending') } : i));
  const noMending = 'the diamond_chestplate has no mending: nothing else would repair the netherite piece (the anvil mends diamond with diamonds only), it waits for a mending book onto it';
  t.is(pieceWaits('chestplate', plain, world), noMending);
  t.is(m.steps[0].waits!({ s: snap(plain), world, have: () => 0 }), noMending);
  const w = workshop(plain, world, STORES());
  t.deepEqual(await m.steps[0].run(w.ctx, { step: 0, data: {} }), { status: 'blocked', text: noMending, retryMs: 30 * MINUTE });
  t.deepEqual(w.calls, [], 'no chest, no table, no walk');
  // mending on it but worn to 20%: the anvil's diamonds first
  const worn = mainSet().map(i => (i.slot === 38 ? { ...i, damage: 423 } : i));
  t.is(pieceWaits('chestplate', worn, world), 'the diamond_chestplate has 19% of its durability left: the upgrade keeps the wear, it waits for the anvil\'s repair');
  // the next piece is judged on its own: the leggings with mending go on
  t.is(pieceWaits('leggings', worn, world), undefined);
  t.is(pieceWaits('chestplate', mainSet(), world), undefined);
});

test('a disconnect at the table (its three thrown on the ground): the record of the job stays, and the drops\' goal picks them up round the table once, then lets it go; a job closed as ever leaves none', async (t) => {
  const m = MILESTONE();
  const world = smithWorld(STORES());
  const w = workshop(mainSet(), world, STORES(), { dropAt: 'addition' });
  let saved = 0;
  (w.ctx as { save?: () => void }).save = () => { saved++; };
  const r = await m.steps[0].run(w.ctx, { step: 0, data: {} });
  t.like(r as StepResult, { status: 'blocked' });
  t.deepEqual(world.smithingOpen?.at, SMITHING);
  t.true(saved >= 1, 'written at once, before the puts');
  // the goal: not while a job may still be at the table, at once for a record from before this process (a restart)
  const s = { ...snap(mainSet()), dimension: 'overworld' };
  const since = world.smithingOpen!.since;
  t.is(smithDropsGoal.wants({ ...s, now: since + 60_000 }, world), null);
  t.truthy(smithDropsGoal.wants({ ...s, now: since + SMITH_DROPS_AFTER_MS }, world));
  t.is(smithDropsGoal.wants({ ...s, now: since + SMITH_DROPS_AFTER_MS, dimension: 'the_nether' }, world), null);
  world.smithingOpen = { at: { ...SMITHING }, since: 0 };
  t.is(smithDropsGoal.wants({ ...s, now: 1000 }, world), `the smithing table at (${SMITHING.x}, ${SMITHING.y}, ${SMITHING.z}) was left with a job in it: pick up what it dropped`);
  const g = workshop(mainSet(), world, STORES());
  const out = await smithDropsGoal.run(g.ctx);
  t.deepEqual(g.calls, [
    `goto ${JSON.stringify({ ...SMITHING, range: 2, careful: true, timeoutMs: 60_000 })}`,
    `collect-items ${JSON.stringify({ ...SMITHING, radius: 4, timeoutMs: 30_000 })}`
  ]);
  t.regex(out, /^the smithing table at .* left with a job in it: ok$/);
  t.false('smithingOpen' in world, 'let go once looked for');
  // a job the table's own close shut: no record left
  const world2 = smithWorld(STORES());
  const ok2 = await m.steps[0].run(workshop(mainSet(), world2, STORES()).ctx, { step: 0, data: {} });
  t.like(ok2 as StepResult, { status: 'done' });
  t.is(world2.smithingOpen, undefined);
});

test('the ingot from debris: the scrap smelted at the furnace first (the template carried, the spare at home: no copy)', async (t) => {
  const m = MILESTONE();
  const items = mainSet();
  const stacks = [st(0, NETHERITE_TEMPLATE, 2), st(1, 'diamond', 64), st(2, 'netherrack', 31), st(3, DEBRIS, 4), st(4, 'gold_ingot', 64)];
  const world = smithWorld(stacks);
  const w = workshop(items, world, stacks);
  const r = await m.steps[0].run(w.ctx, { step: 0, data: {} });
  t.is(r.status, 'done');
  t.like(JSON.parse(w.calls.find(c => c.startsWith('smelt-item'))!.slice('smelt-item '.length)), { ...FURNACE, inputItem: DEBRIS, inputCount: 4, takeOutput: true });
  // two templates at home: one taken for the piece, the other the spare (no copy)
  t.false(w.calls.some(c => c.startsWith(`craft-item {"outputItem":"${NETHERITE_TEMPLATE}"`)));
  t.true(w.calls.includes(`take-from-chest {"x":${STORE.x},"y":${STORE.y},"z":${STORE.z},"item":"${NETHERITE_TEMPLATE}","count":1}`));
  t.is(templatesHome(items, world), 1);
  t.false(w.lines.some(l => l.startsWith('netherite: copied')));
  t.is(items.find(i => i.slot === 38)?.name, 'netherite_chestplate');
});

test('the main helmet: it waits while the Nether swap has it in the chests; the golden helmet is never smithed, and a netherite helmet put away for a trip counts', (t) => {
  const golden: InventoryItem = { slot: 39, name: 'golden_helmet', count: 1, enchantments: en('fire_protection 4, unbreaking 3, mending 1') };
  const dressed = [...mainSet().filter(i => i.slot !== 39), golden];
  const swapped = smithWorld(STORES(), { gearSwap: { wearing: 'nether', stored: [{ name: 'diamond_helmet', chest: STORE, slot: 9, enchantments: en(P4) }], at: 0 } });
  t.is(pieceWaits('helmet', dressed, swapped), 'the main helmet is in the chests for the Nether: it waits for the swap back home');
  t.is(pieceToSmith(dressed, 'helmet'), undefined, 'the golden helmet is no diamond piece');
  t.is(pieceWaits('helmet', dressed, smithWorld(STORES())), 'no diamond_helmet worn or carried to smith');
  // the other pieces go on meanwhile: the swap leaves them on
  t.is(pieceWaits('chestplate', dressed, swapped), undefined);
  // a netherite helmet put away for a trip is the milestone's: done, nothing to wait for
  const netherite = smithWorld(STORES(), { gearSwap: { wearing: 'nether', stored: [{ name: 'netherite_helmet', chest: STORE, slot: 9, enchantments: en(P4) }], at: 0 } });
  const all = dressed.map(i => (i.slot >= 36 && i.slot <= 38 ? { ...i, name: netheriteOf(i.name)! } : i));
  t.is(pieceWaits('helmet', all, netherite), undefined);
  t.true(allNetherite({ items: all }, netherite));
  t.false(allNetherite({ items: all }, smithWorld(STORES())), 'the golden helmet worn is not the netherite one');
});

test('pieceToSmith: the main piece worn first, else the best carried; never a fire protection piece of the old Nether set, nor one bound by its curse', (t) => {
  const worn = mainSet();
  t.is(pieceToSmith(worn, 'chestplate')?.slot, 38);
  const carried: InventoryItem[] = [
    { slot: 4, name: 'diamond_leggings', count: 1 },
    { slot: 5, name: 'diamond_leggings', count: 1, enchantments: en(P4) },
    { slot: 6, name: 'diamond_leggings', count: 1, enchantments: en('fire_protection 4') },
    { slot: 37, name: 'iron_leggings', count: 1 }
  ];
  t.is(pieceToSmith(carried, 'leggings')?.slot, 5);
  t.is(pieceToSmith([{ slot: 6, name: 'diamond_boots', count: 1, enchantments: en('fire_protection 4') }], 'boots'), undefined);
  t.is(pieceToSmith([{ slot: 36, name: 'diamond_boots', count: 1, enchantments: en('binding_curse 1') }], 'boots'), undefined);
});

test('at the table: the piece worn again by the Guardian before the base put (hurt) is not swapped for a spare of its name: the fire-protection chestplate carried is never smithed, the step waits', async (t) => {
  const m = MILESTONE();
  const items = [...mainSet(), { slot: 5, name: 'diamond_chestplate', count: 1, enchantments: en('fire_protection 4') }];
  const w = workshop(items, smithWorld(STORES()), STORES());
  const inner = w.ctx.call;
  w.ctx.call = (async (method: string, a: Record<string, unknown> = {}, ms?: number) => {
    const r = await inner(method, a, ms) as { slot?: number };
    // (the hold gives way while the bot is hurt: the Guardian puts the protection 4 piece back on at once)
    if (method === 'armor.unequip') items.find(i => i.slot === r.slot)!.slot = 38;
    return r;
  }) as GoalContext['call'];
  const r = await m.steps[0].run(w.ctx, { step: 0, data: {} });
  t.deepEqual(r, { status: 'blocked', text: `at the smithing table at (${SMITHING.x}, ${SMITHING.y}, ${SMITHING.z}): the diamond_chestplate went back on before the smithing table had it (hurt, or a fight)`, retryMs: 10 * MINUTE });
  t.false(w.calls.some(c => c.startsWith('smith.take') || c.startsWith('smith.put {"which":"addition"')));
  t.like(items.find(i => i.slot === 5), { name: 'diamond_chestplate', enchantments: en('fire_protection 4') });
  t.like(items.find(i => i.slot === 38), { name: 'diamond_chestplate', enchantments: en(P4) });
  t.false(items.some(i => i.name === 'netherite_chestplate'));
  t.false(w.lines.some(l => l.startsWith('smithing: ')));
});

test('at the table: an unequip refused (a hostile near) leaves the piece on and the step waits, the table closed; a table with no result is left as it was', async (t) => {
  const m = MILESTONE();
  const items = mainSet();
  const world = smithWorld(STORES());
  const w = workshop(items, world, STORES(), { refuse: 'a zombie 6 blocks away: keeping the diamond_chestplate on' });
  const r = await m.steps[0].run(w.ctx, { step: 0, data: {} });
  t.deepEqual(r, { status: 'blocked', text: `at the smithing table at (${SMITHING.x}, ${SMITHING.y}, ${SMITHING.z}): a zombie 6 blocks away: keeping the diamond_chestplate on`, retryMs: 10 * MINUTE });
  t.deepEqual(smithCalls(w.calls), [`armor.unequip {"slot":"chest","holdMs":${SMITH_HOLD_MS}}`, 'smith.close {}']);
  t.is(items.find(i => i.slot === 38)?.name, 'diamond_chestplate');
  // the template and the ingot stay home for the next run: the spare and the copy are carried, nothing was used
  t.is(templatesHome(items, world), 2);
  t.is(items.filter(i => i.name === NETHERITE_INGOT).length, 1);

  // the server shows nothing for the three (a wrong ingot): nothing taken, the three back in the pockets, the piece worn again
  const w2 = workshop(mainSet(), smithWorld(STORES()), STORES());
  const inner = w2.ctx.call;
  w2.ctx.call = (async (method: string, a: Record<string, unknown> = {}, ms?: number) => {
    const r2 = await inner(method, a, ms) as Record<string, unknown>;
    return method === 'smith.put' && a.which === 'addition' ? { ...r2, result: null, noRecipe: true } : r2;
  }) as GoalContext['call'];
  const left = await m.steps[0].run(w2.ctx, { step: 0, data: {} });
  t.like(left, { status: 'blocked', retryMs: 60 * MINUTE });
  t.regex((left as StepResult).text, /^the smithing table shows no result \(template: netherite_upgrade_smithing_template; base: diamond_chestplate \(protection 4, unbreaking 3, mending\); addition: netherite_ingot; result: .*\): the diamond_chestplate is as it was$/);
  t.false(w2.calls.some(c => c.startsWith('smith.take')));
  t.is(w2.items.find(i => i.slot === 38)?.name, 'diamond_chestplate');
  t.false(w2.lines.some(l => l.startsWith('smithing: ')));
});
