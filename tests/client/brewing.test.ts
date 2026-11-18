import test from 'ava';
import {
  BATCH_SLOTS, BOTTLES, BOTTLE_STOCK, BREW_WAITS, POTION_STOCK, ROD_KEEP, WART_KEEP, WEAKNESS_FOR_CURING, brewGoal, brewPlan, brewStand, brewingMilestone,
  brewsInto, inStand, potionCount, potionShort, stageOf, stepsFrom, wartKeep, type BrewPlan, type NoBrew
} from '../../src/client/brain/brewing.js';
import { RECIPES, rawShort, recipeFor, type MilestoneState } from '../../src/client/brain/progress.js';
import { key, remember } from '../../src/client/brain/chests.js';
import { findLandmarks, type Pos, type WorldMemory } from '../../src/client/brain/memory.js';
import { TREE } from '../../src/client/brain/tree.js';
import { projectGoal } from '../../src/client/brain/project.js';
import type { GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import { BREWS_PER_POWDER, brainRun, type BrewStack, type ChestStack, type InventoryItem } from '../../src/client/tools.js';

BREW_WAITS.pollMs = 0;
const MINUTE = 60_000;

// ------------------------------------------------------------------------------------------------ the recipes

/**
 * The brewing's recipes as the 26.3 client jar has them (versions/26.3/26.3.jar, data/minecraft/recipe/*.json, copied as
 * they are): the brain's RECIPES must make the same from the same (a tag of stone crafting materials is any cobblestone).
 */
const JAR: Record<string, unknown> = {
  brewing_stand: { type: 'minecraft:crafting_shaped', key: { '#': '#minecraft:stone_crafting_materials', B: 'minecraft:blaze_rod' }, pattern: [' B ', '###'], result: { id: 'minecraft:brewing_stand' } },
  glass_bottle: { type: 'minecraft:crafting_shaped', key: { '#': 'minecraft:glass' }, pattern: ['# #', ' # '], result: { count: 3, id: 'minecraft:glass_bottle' } },
  blaze_powder: { type: 'minecraft:crafting_shapeless', ingredients: ['minecraft:blaze_rod'], result: { count: 2, id: 'minecraft:blaze_powder' } },
  magma_cream: { type: 'minecraft:crafting_shapeless', ingredients: ['minecraft:blaze_powder', 'minecraft:slime_ball'], result: { id: 'minecraft:magma_cream' } },
  sugar: { type: 'minecraft:crafting_shapeless', group: 'sugar', ingredients: ['minecraft:sugar_cane'], result: { id: 'minecraft:sugar' } },
  fermented_spider_eye: { type: 'minecraft:crafting_shapeless', ingredients: ['minecraft:spider_eye', 'minecraft:brown_mushroom', 'minecraft:sugar'], result: { id: 'minecraft:fermented_spider_eye' } }
};
const TAGS: Record<string, string> = { '#minecraft:stone_crafting_materials': 'cobblestone' };
function fromJar(r: unknown): { makes: number; from: Record<string, number> } {
  const j = r as { key?: Record<string, string>; pattern?: string[]; ingredients?: string[]; result: { count?: number } };
  const ids = j.pattern ? j.pattern.join('').split('').filter(ch => ch !== ' ').map(ch => j.key![ch]) : j.ingredients!;
  const from: Record<string, number> = {};
  for (const id of ids) { const n = TAGS[id] ?? id.replace(/^minecraft:/, ''); from[n] = (from[n] ?? 0) + 1; }
  return { makes: j.result.count ?? 1, from };
}

/** The seven brews of the three long potions (data/minecraft/recipe/brewing/*.json: input contents + reagent -> output contents). */
const BREWS: Record<string, string> = {
  'water+nether_wart': 'awkward', 'awkward+magma_cream': 'fire_resistance', 'awkward+blaze_powder': 'strength', 'awkward+sugar': 'swiftness',
  'fire_resistance+redstone': 'long_fire_resistance', 'strength+redstone': 'long_strength', 'swiftness+redstone': 'long_swiftness'
};

test('the brewing recipes are the 26.3 jar\'s: a stand of a rod and three cobblestone, three bottles of three glass, two powders a rod, magma cream, sugar, the fermented eye', (t) => {
  for (const item of Object.keys(JAR)) {
    t.deepEqual(RECIPES[item], fromJar(JAR[item]), item);
    t.deepEqual(recipeFor(item), RECIPES[item], `${item}: read as it is`);
  }
  // the stand from the stores: the rod is the one thing the trips cannot fetch, deepslate does for the cobblestone
  t.deepEqual(rawShort({ brewing_stand: 1 }, {}), { blaze_rod: 1, cobblestone: 3 });
  t.deepEqual(rawShort({ brewing_stand: 1 }, { blaze_rod: 1, cobbled_deepslate: 64 }), {});
  // magma cream: a slime ball and half a rod; three bottles: three glass (smelted from sand, project.ts SMELTED)
  t.deepEqual(rawShort({ magma_cream: 2 }, { slime_ball: 9 }), { blaze_rod: 1 });
  t.deepEqual(rawShort({ glass_bottle: 3 }, {}), { glass: 3 });
  t.deepEqual(rawShort({ sugar: 1 }, { sugar_cane: 1359 }), {});
  // no rod is made of anything: the fortress brings them
  t.false('blaze_rod' in RECIPES);
});

test('the stock by contents: long fire resistance 6, long strength 3, long swiftness 3; each row\'s way is water, wart, its effect, redstone, as the jar\'s brews go; no splash weakness', (t) => {
  t.deepEqual(POTION_STOCK.map(r => [r.potion, r.want]), [['long_fire_resistance', 6], ['long_strength', 3], ['long_swiftness', 3]]);
  t.false(WEAKNESS_FOR_CURING);
  t.is(BOTTLES, 3);
  for (const row of POTION_STOCK) {
    let contents = 'water';
    for (const ing of stepsFrom(row, 'empty')) {
      t.is(brewsInto(row, ing), BREWS[`${contents}+${ing}`], `${row.potion}: ${contents} + ${ing}`);
      contents = brewsInto(row, ing);
    }
    t.is(contents, row.potion);
    t.deepEqual(stepsFrom(row, 'awkward'), [row.effect, 'redstone']);
    t.deepEqual(stepsFrom(row, 'base'), ['redstone']);
    t.deepEqual(stepsFrom(row, 'long'), []);
    t.is(stageOf(row, row.base), 'base');
    t.is(stageOf(row, 'thick'), undefined);
  }
  t.is(stageOf(POTION_STOCK[0], 'strength'), undefined, 'strength is off the fire resistance\'s way');
});

// ------------------------------------------------------------------------------------------------ a world and a stand

const YARD = { x1: -565, z1: 2119, x2: -533, z2: 2215, y: 62 };
const STAND: Pos = { x: -545, y: 63, z: 2155 };
const WATER: Pos = { x: -545, y: 62, z: 2156 };
const STORE: Pos = { x: -547, y: 63, z: 2180 };
const HOME = { x: -549, y: 63, z: 2183, dimension: 'overworld' };

const potion = (slot: number, contents: string): InventoryItem => ({ slot, name: 'potion', count: 1, potion: contents });
const stack = (slot: number, name: string, count: number, contents?: string): ChestStack => ({ slot, name, count, ...(contents ? { potion: contents } : {}) });
const totalsOf = (stacks: ChestStack[]) => {
  const out: Record<string, number> = {};
  for (const st of stacks) out[st.name] = (out[st.name] ?? 0) + st.count;
  return out;
};

/** The live homestead's workshop (brain.json Nov 18) with the stand put in it, one chest holding `stacks`. */
function brewWorld(stacks: ChestStack[] = [], over: Partial<WorldMemory> = {}): WorldMemory {
  const world = {
    landmarks: { chests: [STORE], farmland: [] }, leash: 96, yard: { ...YARD },
    zones: { 'workshop:stand': [STAND], 'workshop:water': [WATER], workshop: [{ x: -546, y: 62, z: 2152, width: 7, length: 7 }], brewing: [{ ...STAND }] },
    progress: { done: ['workshop', 'nether-portal', 'brewing'], journal: [] }, chestAssign: { [key(STORE)]: 'gear' }, ...over
  } as WorldMemory;
  remember(world, STORE, totalsOf(stacks), stacks.map(st => ({ ...st })));
  return world;
}

const snap = (items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot => {
  const counts = new Map<string, number>();
  for (const i of items) if (i.slot < 36) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: 10 * 60 * MINUTE, timeOfDay: 2000, activity: 'work', health: 20, food: 20, position: { x: -543, y: 63, z: 2160 }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    xpLevel: 20, home: HOME, distHome: 23, ...over
  } as Snapshot;
};

/** A batch's makings in the chest: glass bottles, wart, slime balls, rods, redstone, cane. */
const MAKINGS: ChestStack[] = [stack(0, 'glass_bottle', 3), stack(1, 'nether_wart', 5), stack(2, 'slime_ball', 9), stack(3, 'blaze_rod', 3), stack(4, 'redstone', 64), stack(5, 'sugar_cane', 64)];
const KIT = (): InventoryItem[] => [{ slot: 0, name: 'diamond_sword', count: 1 }, { slot: 1, name: 'diamond_pickaxe', count: 1 }];

/** The brews of the fake stand: what a bottle of these contents becomes with that reagent (water and a reagent but the wart: mundane, as the jar's potion_water_<reagent>). */
const brewOf = (contents: string | undefined, reagent: string | undefined) =>
  (contents && reagent ? BREWS[`${contents}+${reagent}`] ?? (contents === 'water' && /^(magma_cream|redstone|sugar|blaze_powder)$/.test(reagent) ? 'mundane' : undefined) : undefined);

/**
 * The workshop as the mod's Brewing.java and the server would have it, on the pockets (`items`, 0-35): brew.open,
 * brew.status (a brew under way ends at the next look: its 400 ticks; `slow` looks more), brew.put (a potion picked by
 * its contents, a bottle slot one each, the fuel blaze powder only, a brew starting by itself once the ingredient brews a
 * bottle and there is fuel: a powder burnt for 20), brew.take (refused under a brew, into the first free pocket), brew.close
 * (the stand keeps its contents). The glass bottle filled at the water by useOn; the chest (chest.open, withdraw, deposit
 * by slot; take-from-chest by name); craft-item by RECIPES; the careful walks arrive; world.region reads the stand,
 * the water and the floor round it.
 */
function workshopAt(items: InventoryItem[], world: WorldMemory, stacks: ChestStack[], opts: { slow?: number; noWater?: boolean; block?: string } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const inside = stacks.map(st => ({ ...st }));
  const stand = { bottles: [null, null, null] as (BrewStack | null)[], ingredient: null as BrewStack | null, fuel: null as BrewStack | null, fuelUses: 0, ticks: 0, looks: 0 };
  let open = false;
  let held = 'diamond_sword';
  let block = opts.block ?? 'minecraft:brewing_stand[has_bottle_0=false]';
  const at = (k: number) => items.find(i => i.slot === k);
  const ORDER = [...[...Array(27).keys()].map(k => k + 9), ...Array(9).keys()];
  const free = () => ORDER.find(k => !at(k));
  const toPockets = (st: BrewStack): number => {
    const onto = !st.potion && items.find(i => i.slot < 36 && i.name === st.name && !i.potion && i.count + st.count <= 64);
    if (onto) { onto.count += st.count; return onto.slot; }
    const k = free();
    if (k === undefined) throw new Error('inventory full');
    items.push({ ...st, slot: k } as InventoryItem);
    return k;
  };
  const fromPockets = (name: string, count: number, contents?: string, slot?: number): BrewStack => {
    const pick = (slot !== undefined && at(slot)?.name === name && (!contents || at(slot)?.potion === contents) ? at(slot) : undefined)
      ?? items.filter(i => i.slot < 36 && i.name === name && (!contents || i.potion === contents)).sort((a, b) => a.slot - b.slot)[0];
    if (!pick) throw new Error(`no ${name}${contents ? ` (${contents})` : ''} in the pockets`);
    const n = Math.min(count, pick.count);
    pick.count -= n;
    if (!pick.count) items.splice(items.indexOf(pick), 1);
    return { name, count: n, ...(pick.potion ? { potion: pick.potion } : {}) };
  };
  const status = () => ({
    open, at: { ...STAND }, bottles: stand.bottles.map(b => (b ? { ...b } : null)), ingredient: stand.ingredient && { ...stand.ingredient }, fuel: stand.fuel && { ...stand.fuel },
    fuelUses: stand.fuelUses, brewing: stand.ticks > 0, brewTicks: stand.ticks, totalBrewTicks: 400, freePockets: 36 - items.filter(i => i.slot < 36).length
  });
  const start = () => {
    if (stand.ticks || !stand.ingredient || !stand.bottles.some(b => brewOf(b?.potion, stand.ingredient?.name))) return;
    if (stand.fuelUses <= 0 && stand.fuel?.name === 'blaze_powder') {
      stand.fuelUses = BREWS_PER_POWDER;
      stand.fuel.count -= 1;
      if (!stand.fuel.count) stand.fuel = null;
    }
    if (stand.fuelUses <= 0) return;
    stand.fuelUses -= 1;
    stand.ticks = 400;
    stand.looks = 0;
  };
  const tick = () => {
    if (!stand.ticks || ++stand.looks < (opts.slow ?? 1)) return;
    stand.ticks = 0;
    stand.bottles = stand.bottles.map(b => (b && brewOf(b.potion, stand.ingredient?.name) ? { ...b, potion: brewOf(b.potion, stand.ingredient?.name) } : b));
    stand.ingredient!.count -= 1;
    if (!stand.ingredient!.count) stand.ingredient = null;
  };
  const reply = () => ({ slots: 27, free: 27 - inside.length, items: totalsOf(inside), stacks: inside.map(st => ({ ...st })) });
  const chestFree = () => [...Array(27).keys()].find(k => !inside.some(st => st.slot === k))!;
  const take = (name: string, slot: number | undefined, count: number) => {
    const st = inside.find(x => x.slot === slot && x.name === name) ?? inside.find(x => x.name === name);
    if (!st) return { moved: 0 };
    const n = Math.min(count, st.count);
    st.count -= n;
    if (!st.count) inside.splice(inside.indexOf(st), 1);
    toPockets({ name, count: n, ...(st.potion ? { potion: st.potion } : {}) });
    return { moved: n };
  };
  const region = (b: { x: number; y: number; z: number; width?: number; height?: number; length?: number }) => {
    const out: string[] = [];
    for (let y = 0; y < (b.height ?? 1); y++) for (let z = 0; z < (b.length ?? 1); z++) for (let x = 0; x < (b.width ?? 1); x++) {
      const p = { x: b.x + x, y: b.y + y, z: b.z + z };
      out.push(p.x === STAND.x && p.y === STAND.y && p.z === STAND.z ? block
        : p.x === WATER.x && p.y === WATER.y && p.z === WATER.z ? 'minecraft:water[level=0]' : p.y <= WATER.y ? 'minecraft:grass_block' : 'minecraft:air');
    }
    return { blocks: out };
  };
  const ctx = {
    s: snap(items), world, signal: new AbortController().signal,
    progress: (x: string) => { lines.push(`brewing: ${x}`); }, gain: () => undefined,
    status: async () => ({ inWorld: true, username: 'b', screen: null, dimension: 'overworld', position: { x: -543.5, y: 63, z: 2160.5 } }),
    call: (async (m: string, p: Record<string, unknown> = {}) => {
      if (m === 'inventory') return { items: items.map(i => ({ ...i })), held: { name: held } };
      if (m === 'world.region') return region(p as never);
      if (m === 'item.select') { held = String(p.name); return {}; }
      if (m === 'goto') { calls.push(`goto ${p.x},${p.y},${p.z} ${p.range}${p.careful ? ' careful' : ''}`); return { arrived: true }; }
      if (m === 'useOn') {
        calls.push(`useOn ${p.x},${p.y},${p.z} ${held}`);
        if (held !== 'glass_bottle' || opts.noWater) return { used: true, bottle: 'nothing happened (no water filled it)' };
        fromPockets('glass_bottle', 1);
        toPockets({ name: 'potion', count: 1, potion: 'water' });
        return { used: true, bottle: 'filled' };
      }
      if (m.startsWith('brew.')) calls.push(`${m}${Object.keys(p).length ? ` ${JSON.stringify(p)}` : ''}`);
      if (m === 'brew.open') {
        if (!/^minecraft:brewing_stand/.test(block)) throw new Error('no brewing_stand there');
        open = true;
        return status();
      }
      if (m === 'brew.status') { tick(); return open ? status() : { open: false }; }
      if (m === 'brew.put') {
        if (!open) throw new Error('no brewing stand open (brew.open first)');
        const into = String(p.into);
        if (into === 'bottle') {
          const k = stand.bottles.findIndex(b => !b);
          if (k < 0) throw new Error('all three bottle slots hold a bottle');
          if (p.name !== 'potion') throw new Error(`a bottle slot takes only a potion a brew starts from, not ${String(p.name)}`);
          stand.bottles[k] = fromPockets('potion', 1, p.potion as string | undefined, p.slot as number | undefined);
        } else {
          const slot = into === 'fuel' ? 'fuel' : 'ingredient';
          if (slot === 'fuel' && p.name !== 'blaze_powder') throw new Error(`the brewing stand burns only blaze_powder, not ${String(p.name)}`);
          const was = stand[slot];
          if (was && was.name !== p.name) {
            if (stand.ticks) throw new Error('brewing');
            toPockets(was);
            stand[slot] = null;
          }
          const put = fromPockets(String(p.name), Number(p.count ?? 1));
          stand[slot] = stand[slot] ? { ...stand[slot]!, count: stand[slot]!.count + put.count } : put;
        }
        start();
        return { ...status(), into, put: 1, slot: null };
      }
      if (m === 'brew.take') {
        if (stand.ticks && !p.force) throw new Error('brewing (20 s left): take the potions once it is done, or force');
        const taken: InventoryItem[] = [];
        if (p.from === 'ingredient') {
          if (stand.ingredient) taken.push({ ...stand.ingredient, slot: toPockets(stand.ingredient) } as InventoryItem);
          stand.ingredient = null;
          return { ...status(), ok: true, taken };
        }
        stand.bottles = stand.bottles.map(b => { if (b) taken.push({ ...b, slot: toPockets(b) } as InventoryItem); return null; });
        return { ...status(), ok: true, taken };
      }
      if (m === 'brew.close') { const was = open; open = false; return { ok: true, wasOpen: was, stand: null }; }
      if (m === 'chest.open') { calls.push('chest.open'); return reply(); }
      if (m === 'chest.withdraw') return { ...reply(), ...take(String(p.name), p.slot as number | undefined, Number(p.count ?? 64)) };
      if (m === 'chest.deposit') {
        const st = fromPockets(String(p.name), Number(p.count ?? 1), undefined, p.slot as number | undefined);
        inside.push({ ...st, slot: chestFree() } as ChestStack);
        calls.push(`chest.deposit ${st.potion ?? st.name}`);
        return { ...reply(), moved: st.count };
      }
      if (m === 'container.close') return { ok: true };
      return {};
    }) as GoalContext['call'],
    act: (async (tool: string, p: Record<string, unknown> = {}) => {
      calls.push(`${tool} ${p.item ?? p.outputItem ?? ''}${p.count ?? p.amount ? ` x${p.count ?? p.amount}` : ''}`);
      if (tool === 'take-from-chest') {
        const r = take(String(p.item), undefined, Number(p.count ?? 64));
        const holds = Object.entries(totalsOf(inside)).map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing';
        return { ok: true, text: `Took ${r.moved} ${String(p.item)} from the chest at (${STORE.x}, ${STORE.y}, ${STORE.z}). It holds: ${holds}.` };
      }
      if (tool === 'craft-item') {
        const out = String(p.outputItem), times = Number(p.amount ?? 1), r = RECIPES[out];
        const have = (n: string) => items.filter(i => i.slot < 36 && (n === 'cobblestone' ? /^(cobblestone|cobbled_deepslate)$/.test(i.name) : i.name === n)).reduce((a, i) => a + i.count, 0);
        if (!r || Object.entries(r.from).some(([n, k]) => have(n) < k * times)) return { ok: false, text: `missing ingredients for ${out}` };
        for (const [n, k] of Object.entries(r.from)) fromPockets(n, k * times);
        toPockets({ name: out, count: r.makes * times });
        return { ok: true, text: `Crafted ${r.makes * times} ${out}` };
      }
      if (tool === 'place-block') {
        if (!items.some(i => i.slot < 36 && i.name === p.item)) return { ok: true, text: `No ${String(p.item)} in inventory to place` };
        fromPockets(String(p.item), 1);
        block = `minecraft:${String(p.item)}`;
        return { ok: true, text: `Placed minecraft:${String(p.item)} at (${p.x}, ${p.y}, ${p.z}) using up face` };
      }
      return { ok: true, text: 'ok' };
    }) as GoalContext['act']
  } as unknown as GoalContext;
  return { ctx, calls, lines, items, inside, stand, setBlock: (b: string) => { block = b; }, block: () => block };
}

const isPlan = (p: BrewPlan | NoBrew): p is BrewPlan => !('why' in p);

// ------------------------------------------------------------------------------------------------ the plan, pure

test('brewPlan: the first row short whose makings are home; the bottles, the wart, the effect, redstone, and a powder of fuel for an empty stand', (t) => {
  const world = brewWorld(MAKINGS);
  const p = brewPlan(snap(KIT()), world);
  t.true(isPlan(p));
  t.like(p, { from: 'empty', steps: ['nether_wart', 'magma_cream', 'redstone'], fuel: true, bottles: 3, have: 0 });
  t.is((p as BrewPlan).row.potion, 'long_fire_resistance');
  t.is(brewGoal.wants(snap(KIT()), world), 'long_fire_resistance 0/6: nether_wart, magma_cream, redstone (from three bottles filled at the water; a blaze powder for fuel)');
  // the stand's own fuel does the batch: no powder put in
  world.brewing = { fuelUses: 12, fuelCount: 0 };
  t.like(brewPlan(snap(KIT()), world), { fuel: false });
  // six long fire resistance in the chest (by their contents): strength next; a plain one and a strength potion do not count
  const six = [...MAKINGS, ...[6, 7, 8, 9, 10, 11].map(k => stack(k, 'potion', 1, 'long_fire_resistance')), stack(12, 'potion', 1, 'fire_resistance'), stack(13, 'splash_potion', 1, 'long_fire_resistance')];
  const w2 = brewWorld(six);
  t.is(potionCount([], w2, 'long_fire_resistance'), 6);
  t.like(brewPlan(snap(KIT()), w2), { row: POTION_STOCK[1], steps: ['nether_wart', 'blaze_powder', 'redstone'] });
  // all in stock: stocked
  const all = [...six, ...[14, 15, 16].map(k => stack(k, 'potion', 1, 'long_strength')), ...[17, 18].map(k => stack(k, 'potion', 1, 'long_swiftness'))];
  const carriedOne = [...KIT(), potion(20, 'long_swiftness')];
  t.deepEqual(potionShort(carriedOne, brewWorld(all)), []);
  t.like(brewGoal.declines!(snap(carriedOne), brewWorld(all)), { cause: 'stocked', text: 'brewing: the potions are in stock (long_fire_resistance 6/6, long_strength 3/3, long_swiftness 3/3)' });
});

test('brewPlan keeps the last blaze rod (the stand\'s) and the wart farm\'s wart: two kept, and the strip\'s bare cells once it stands', (t) => {
  // one rod home: no powder may come of it (no magma cream, no fuel), and the cane's books share stays too
  const oneRod = MAKINGS.map(st => (st.name === 'blaze_rod' ? { ...st, count: ROD_KEEP } : st));
  const p = brewPlan(snap(KIT()), brewWorld(oneRod));
  t.false(isPlan(p));
  t.regex((p as NoBrew).why, /long_fire_resistance 0\/6: short of blaze powder \(2 wanted, 0 at home, the last rod kept\)/);
  t.regex((p as NoBrew).why, /long_swiftness 0\/3: short of blaze powder \(1 wanted, 0 at home/);
  // two rods: a powder of each... four powders from three rods less the kept one
  t.true(isPlan(brewPlan(snap(KIT()), brewWorld(MAKINGS))));
  // two wart: both kept for replanting
  const twoWart = MAKINGS.map(st => (st.name === 'nether_wart' ? { ...st, count: WART_KEEP } : st));
  t.regex((brewPlan(snap(KIT()), brewWorld(twoWart)) as NoBrew).why, /short of nether wart \(2, 2 kept for the wart farm\)/);
  // the strip standing with 4 cells bare as its round last saw: six kept
  const w = brewWorld(MAKINGS.map(st => (st.name === 'nether_wart' ? { ...st, count: 6 } : st)));
  w.zones!['wart:cell'] = [{ x: 0, y: 63, z: 0 }];
  w.wart = { at: 0, bare: 4 };
  t.is(wartKeep(w), 6);
  t.false(isPlan(brewPlan(snap(KIT()), w)));
  w.wart.bare = 3;
  t.true(isPlan(brewPlan(snap(KIT()), w)));
  // no bottles, no glass and no sand: none
  const dry = MAKINGS.filter(st => st.name !== 'glass_bottle');
  t.regex((brewPlan(snap(KIT()), brewWorld(dry)) as NoBrew).why, /short of 3 bottles \(0 glass or water bottles, 0 glass or sand\)/);
  // water bottles carried do
  t.true(isPlan(brewPlan(snap([...KIT(), potion(9, 'water'), potion(10, 'water'), potion(11, 'water')]), brewWorld(dry))));
});

test('a batch the stand holds midway goes on from where its bottles stand, its row\'s alone; bottles of no row\'s way together are mixed', (t) => {
  t.deepEqual(inStand(['awkward', 'awkward', 'awkward']), { contents: 'awkward' });
  t.like(inStand([null, 'strength', 'strength']), { contents: 'strength', row: POTION_STOCK[1] });
  t.is(inStand(['awkward', 'water', null]), 'mixed');
  t.is(inStand(['thick', null, null]), 'mixed');
  t.is(inStand([null, null, null]), undefined);
  const world = brewWorld(MAKINGS);
  t.like(brewPlan(snap(KIT()), world, ['awkward', 'awkward', 'awkward']), { from: 'awkward', steps: ['magma_cream', 'redstone'], bottles: 0 });
  t.like(brewPlan(snap(KIT()), world, ['swiftness', 'swiftness', 'swiftness']), { row: POTION_STOCK[2], from: 'base', steps: ['redstone'] });
  // the stock met, a batch midway is still finished (its bottles are the stand's otherwise)
  const all = [...MAKINGS, ...[6, 7, 8, 9, 10, 11].map(k => stack(k, 'potion', 1, 'long_fire_resistance')), ...[14, 15, 16].map(k => stack(k, 'potion', 1, 'long_strength')), ...[17, 18, 19].map(k => stack(k, 'potion', 1, 'long_swiftness'))];
  t.like(brewPlan(snap(KIT()), brewWorld(all), ['awkward', 'awkward', null]), { row: POTION_STOCK[0], from: 'awkward' });
});

test('the brewing gate: no stand, a stand gone, the yard, the pockets, the hour; it writes nothing', (t) => {
  const world = brewWorld(MAKINGS);
  const s = snap(KIT());
  const before = JSON.stringify(world);
  for (const tod of [0, 2000, 11000]) { brewGoal.wants(snap(KIT(), { timeOfDay: tod }), world); brewGoal.declines!(snap(KIT(), { timeOfDay: tod }), world); }
  t.is(JSON.stringify(world), before);
  t.like(brewGoal.declines!(s, brewWorld(MAKINGS, { zones: {}, progress: { done: [], journal: [] } })), { cause: 'unneeded', text: 'no brewing stand yet' });
  t.like(brewGoal.declines!(s, brewWorld(MAKINGS, { brewing: { gone: { ...STAND } } })), { cause: 'unneeded', text: 'the brewing stand at (-545, 63, 2155) is gone (the brewing milestone puts one back)' });
  t.like(brewGoal.declines!(snap(KIT(), { position: { x: -520, y: 63, z: 2160 }, distHome: 36 }), world), { cause: 'away' });
  const full = [...KIT(), ...[...Array(28).keys()].map(k => ({ slot: k + 2, name: 'dirt', count: 64 }))];
  t.like(brewGoal.declines!(snap(full), world), { cause: 'pockets', text: `30/36 slots (brewing runs under ${36 - 2 - BATCH_SLOTS + 1})` });
  t.like(brewGoal.declines!(snap(KIT(), { timeOfDay: 11000 }), world), { cause: 'late' });
  // a stand an improvement run put up in the yard will do
  const theirs = brewWorld(MAKINGS, { zones: { 'workshop:water': [WATER] } });
  theirs.landmarks.brewing = { x: -550, y: 63, z: 2170 };
  t.deepEqual(brewStand(theirs), { x: -550, y: 63, z: 2170 });
  theirs.landmarks.brewing = { x: -600, y: 63, z: 2170 };
  t.is(brewStand(theirs), undefined, 'not one outside the yard');
});

// ------------------------------------------------------------------------------------------------ the batch

test('a batch end to end on the stand: three bottles filled at the workshop\'s water, the fuel, wart -> awkward -> fire resistance -> long, taken out and stored by their contents', async (t) => {
  const world = brewWorld(MAKINGS);
  const w = workshopAt(KIT(), world, MAKINGS);
  const r = await brewGoal.run(w.ctx);
  t.is(r, 'brewed 3 long_fire_resistance (water -> awkward -> fire_resistance -> long_fire_resistance); 17 brews left in the fuel; 3 stored; stock long_fire_resistance 3/6, long_strength 0/3, long_swiftness 0/3');
  t.deepEqual(w.calls, [
    `goto ${STAND.x},${STAND.y},${STAND.z} 2 careful`,
    `brew.open ${JSON.stringify(STAND)}`,
    'brew.close',
    'take-from-chest nether_wart x1',
    // the rods the powder may use carried first, the last one kept back from the craft
    'take-from-chest blaze_rod x2', 'craft-item blaze_powder x1', 'take-from-chest slime_ball x1', 'craft-item magma_cream x1',
    'take-from-chest redstone x1',
    'take-from-chest glass_bottle x3',
    // from the floor beside the water (the stand stands on the other side), on foot
    'goto -544,63,2156 0 careful',
    'useOn -545,62,2156 glass_bottle', 'useOn -545,62,2156 glass_bottle', 'useOn -545,62,2156 glass_bottle',
    `brew.open ${JSON.stringify(STAND)}`,
    'brew.put {"into":"fuel","name":"blaze_powder","count":1}',
    'brew.put {"into":"bottle","name":"potion","potion":"water"}', 'brew.put {"into":"bottle","name":"potion","potion":"water"}', 'brew.put {"into":"bottle","name":"potion","potion":"water"}',
    'brew.put {"into":"ingredient","name":"nether_wart","count":1}', 'brew.status',
    'brew.put {"into":"ingredient","name":"magma_cream","count":1}', 'brew.status',
    'brew.put {"into":"ingredient","name":"redstone","count":1}', 'brew.status',
    'brew.take',
    'brew.close',
    'chest.open', 'chest.deposit long_fire_resistance', 'chest.open', 'chest.deposit long_fire_resistance', 'chest.open', 'chest.deposit long_fire_resistance'
  ]);
  t.deepEqual(w.lines.slice(0, 3), ['brewing: the nether_wart brewed the bottles into awkward', 'brewing: the magma_cream brewed the bottles into fire_resistance', 'brewing: the redstone brewed the bottles into long_fire_resistance']);
  // the chest's memory has them by their stacks: counted by contents; the stand's fuel remembered for the next plan
  t.is(potionCount(w.items, world, 'long_fire_resistance'), 3);
  t.like(world.brewing, { bottles: [null, null, null], fuelUses: 17, fuelCount: 0 });
  t.false(w.items.some(i => i.name === 'potion'), 'none left in the pockets');
  t.is(w.items.find(i => i.name === 'blaze_rod')?.count, ROD_KEEP, 'the kept rod carried back (the stash puts it away)');
  // the next batch: the bottles are gone (the trips bring sand), no powder for the fuel needed (17 brews left)
  const next = brewPlan(snap(w.items), world) as NoBrew;
  t.regex(next.why, /^long_fire_resistance 3\/6: short of 3 bottles/);
  t.notRegex(next.why, /^long_fire_resistance[^;]*blaze powder/);
});

test('a batch cut short (a brew under way at the next look): waited out, then on from the stand\'s awkward bottles; no water fetched, no fuel', async (t) => {
  const world = brewWorld(MAKINGS);
  const w = workshopAt(KIT(), world, MAKINGS, { slow: 3 });
  w.stand.bottles = [{ name: 'potion', count: 1, potion: 'water' }, { name: 'potion', count: 1, potion: 'water' }, { name: 'potion', count: 1, potion: 'water' }];
  w.stand.ingredient = { name: 'nether_wart', count: 1 };
  w.stand.fuelUses = 15;
  w.stand.ticks = 200;
  const r = await brewGoal.run(w.ctx);
  t.regex(r, /^brewed 3 long_fire_resistance \(awkward -> fire_resistance -> long_fire_resistance\); 13 brews left in the fuel; 3 stored/);
  t.false(w.calls.some(c => c.startsWith('useOn') || c.includes('"into":"fuel"') || c.includes('"into":"bottle"')));
  t.is(w.calls.filter(c => c === 'brew.status').length, 3 + 3 + 3, 'the brew under way and the two of its own, waited out');
});

test('done potions left in the stand are taken out and stored first; bottles that fill no batch are taken out too', async (t) => {
  const all = [...MAKINGS, ...[6, 7, 8, 9, 10, 11].map(k => stack(k, 'potion', 1, 'long_fire_resistance')), ...[14, 15, 16].map(k => stack(k, 'potion', 1, 'long_strength'))];
  const world = brewWorld(all);
  const w = workshopAt(KIT(), world, all);
  w.stand.bottles = [{ name: 'potion', count: 1, potion: 'long_swiftness' }, { name: 'potion', count: 1, potion: 'long_swiftness' }, { name: 'potion', count: 1, potion: 'long_swiftness' }];
  const r = await brewGoal.run(w.ctx);
  t.is(r, 'took 3 potions out of the stand and stored them; nothing to brew: the potions are in stock (long_fire_resistance 6/6, long_strength 3/3, long_swiftness 3/3)');
  t.is(potionCount([], world, 'long_swiftness'), 3);
});

test('the bottles: a fill the server did not confirm ends it, said; the stand is closed; a stand gone is remembered for the milestone', async (t) => {
  const world = brewWorld(MAKINGS);
  const w = workshopAt(KIT(), world, MAKINGS, { noWater: true });
  await t.throwsAsync(brewGoal.run(w.ctx), { message: '0 of 3 water bottles filled at the workshop\'s water at (-545, 62, 2156): nothing happened (no water filled it)' });
  t.is(w.calls.filter(c => c.startsWith('useOn')).length, 1);
  t.is(w.calls.at(-1), 'brew.close');
  // gone: told, remembered, and the milestone is due again
  const g = brewWorld(MAKINGS);
  const v = workshopAt(KIT(), g, MAKINGS, { block: 'minecraft:air' });
  t.is(await brewGoal.run(v.ctx), 'the brewing stand at (-545, 63, 2155) is gone: the brewing milestone puts one back');
  t.deepEqual(g.brewing?.gone, STAND);
  const m = brewingMilestone(['workshop', 'nether-portal']);
  const view = { s: snap(KIT()), world: g, have: () => 0 };
  t.false(m.done!(view));
  t.true(m.again!(view));
});

// ------------------------------------------------------------------------------------------------ the milestone

test('the brewing milestone: after the workshop and the portal; a blaze rod first (a wait it stops nothing for), the stand crafted, put in the workshop\'s stand cell, bottles', async (t) => {
  const m = TREE.find(x => x.id === 'brewing')!;
  t.deepEqual(m.prereqs, ['workshop', 'nether-portal']);
  t.is(m.title, 'a brewing stand');
  t.deepEqual(m.steps.map(s => s.name), ['a blaze rod from the fortress', 'craft a brewing stand', 'put the brewing stand in the workshop', 'glass bottles for the brewing']);
  // no rod: it waits, and says so (the fortress brings them)
  const world = brewWorld([stack(0, 'cobblestone', 64), stack(1, 'glass_bottle', 6)], { zones: { 'workshop:stand': [STAND], 'workshop:water': [WATER] }, progress: { done: ['workshop', 'nether-portal'], journal: [] } });
  const w = workshopAt(KIT(), world, [stack(0, 'cobblestone', 64), stack(1, 'glass_bottle', 6)], { block: 'minecraft:air' });
  const st: MilestoneState = { step: 0, data: {} };
  const view = { s: snap(KIT()), world, have: () => 0 };
  t.is(m.steps[0].waits!(view), 'brewing waits on a blaze rod (the fortress trips bring them)');
  t.like(await m.steps[0].run(w.ctx, st), { status: 'blocked', text: 'brewing waits on a blaze rod (the fortress trips bring them)', retryMs: 30 * MINUTE });
  t.is(projectGoal([m]).cuts?.(snap(KIT()), world), false, 'the project stops nothing for it');
  // a rod comes home: on
  w.inside.push(stack(2, 'blaze_rod', 1));
  remember(world, STORE, totalsOf(w.inside), w.inside.map(x => ({ ...x })));
  t.is(m.steps[0].waits!(view), undefined);
  t.like(await m.steps[0].run(w.ctx, st), { status: 'done' });
  t.like(await m.steps[1].run(w.ctx, st), { status: 'done', text: 'crafted a brewing stand' });
  t.true(w.calls.includes('craft-item brewing_stand x1'));
  t.is(w.items.find(i => i.name === 'brewing_stand')?.count, 1);
  t.like(await m.steps[2].run(w.ctx, st), { status: 'done', text: 'put the brewing stand in the workshop at (-545, 63, 2155)' });
  t.true(w.calls.includes(`goto ${STAND.x},${STAND.y},${STAND.z} 2 careful`));
  t.true(w.calls.includes('place-block brewing_stand'));
  t.deepEqual(world.zones!.brewing, [STAND]);
  // the bottles for the whole stock (12: nothing else sends the trips for their sand): 6 short, the sand written for the stock trips
  t.is(BOTTLE_STOCK, 12);
  t.like(await m.steps[3].run(w.ctx, st), { status: 'blocked', text: 'glass bottles for the brewing (6 of 12): short of 6 sand', need: { sand: 6 } });
  t.deepEqual(world.progress!.need, { sand: 6 });
  w.inside.push(stack(3, 'glass_bottle', 6));
  remember(world, STORE, totalsOf(w.inside), w.inside.map(x => ({ ...x })));
  t.like(await m.steps[3].run(w.ctx, st), { status: 'done', text: `12 glass bottles for the brewing` });
  // done once the project is past its last step (stepOf 0), and standing again it is the one
  t.true(m.done!(view));
  t.like(await m.steps[2].run(w.ctx, st), { status: 'done', text: 'a brewing stand stands at (-545, 63, 2155)' });
  // something else in the cell: left alone
  w.setBlock('minecraft:chest');
  t.like(await m.steps[2].run(w.ctx, st), { status: 'blocked', text: 'chest stands in the stand\'s cell at (-545, 63, 2155): left alone' });
});

test('a brewing stand the improvement runs put up in the yard counts (findLandmarks sees it); one out of the yard does not', (t) => {
  const box = { x: -550, y: 63, z: 2170, width: 3, height: 1, length: 1 };
  const l = findLandmarks(box, ['minecraft:air', 'minecraft:brewing_stand[has_bottle_0=false]', 'minecraft:air'], HOME);
  t.deepEqual(l.brewing, { x: -549, y: 63, z: 2170 });
  t.false('brewing' in findLandmarks(box, ['minecraft:air', 'minecraft:air', 'minecraft:air'], HOME));
  const m = brewingMilestone(['workshop', 'nether-portal']);
  const world = brewWorld([], { zones: {}, landmarks: { chests: [], farmland: [], brewing: l.brewing } });
  t.true(m.done!({ s: snap([]), world, have: () => 0 }));
  world.landmarks.brewing = { x: -500, y: 63, z: 2170 };
  t.false(m.done!({ s: snap([]), world, have: () => 0 }));
});

// ------------------------------------------------------------------------------------------------ what the review found

test('a run the brain gives up under a brew still closes the stand (outside the run: every call of a run given up is refused)', async (t) => {
  const world = brewWorld(MAKINGS);
  const w = workshopAt(KIT(), world, MAKINGS, { slow: 1000 });
  w.stand.bottles = [{ name: 'potion', count: 1, potion: 'awkward' }, { name: 'potion', count: 1, potion: 'awkward' }, { name: 'potion', count: 1, potion: 'awkward' }];
  w.stand.ingredient = { name: 'magma_cream', count: 1 };
  w.stand.fuelUses = 10;
  w.stand.ticks = 200;
  const abort = new AbortController();
  let looks = 0;
  const inner = w.ctx.call;
  const ctx = {
    ...w.ctx, signal: abort.signal,
    // as tools.ts call has it: a call of a run given up is refused
    call: (async (m: string, p?: Record<string, unknown>) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      if (m === 'brew.status' && ++looks === 2) abort.abort();
      return inner(m, p);
    }) as GoalContext['call']
  } as GoalContext;
  await t.throwsAsync(brainRun.run({ signal: abort.signal }, () => brewGoal.run(ctx)), { message: /aborted/ });
  t.is(w.calls.at(-1), 'brew.close', w.calls.join(' | '));
});

test('a put whose brew the server shows a moment after its reply: looked at again, and the batch goes on', async (t) => {
  const world = brewWorld(MAKINGS);
  const w = workshopAt(KIT(), world, MAKINGS, { slow: 2 });
  const inner = w.ctx.call;
  // the put's reply before the brew's data slot came: brewing false though the stand brews
  w.ctx.call = (async (m: string, p?: Record<string, unknown>) => {
    const r = await inner(m, p);
    return m === 'brew.put' ? { ...(r as object), brewing: false, brewTicks: 0 } : r;
  }) as GoalContext['call'];
  const r = await brewGoal.run(w.ctx);
  t.regex(r, /^brewed 3 long_fire_resistance \(water -> awkward -> fire_resistance -> long_fire_resistance\)/);
});

test('a strength batch with the fuel to put in and one loose powder in the chest: powder for both (the fuel burnt the only one, and the strength had none)', async (t) => {
  const fire = [6, 7, 8, 9, 10, 11].map(k => stack(k, 'potion', 1, 'long_fire_resistance'));
  const stacks = [...MAKINGS, stack(12, 'blaze_powder', 1), ...fire];
  const world = brewWorld(stacks);
  const w = workshopAt(KIT(), world, stacks);
  t.like(brewPlan(snap(KIT()), world), { row: POTION_STOCK[1], from: 'empty', fuel: true });
  const r = await brewGoal.run(w.ctx);
  t.regex(r, /^brewed 3 long_strength \(water -> awkward -> strength -> long_strength\); 17 brews left in the fuel/);
  t.true(w.calls.includes('brew.put {"into":"fuel","name":"blaze_powder","count":1}'));
  t.true(w.calls.includes('brew.put {"into":"ingredient","name":"blaze_powder","count":1}'));
});

test('bottles are made three of three glass: two glass bottles and one sand are no batch (it filled two and failed every 20 min)', (t) => {
  const stacks = [...MAKINGS.filter(st => st.name !== 'glass_bottle'), stack(0, 'glass_bottle', 2), stack(9, 'sand', 1)];
  const world = brewWorld(stacks);
  world.landmarks.furnace = { x: -550, y: 63, z: 2170 };
  const p = brewPlan(snap(KIT()), world);
  t.false(isPlan(p));
  t.regex((p as NoBrew).why, /short of 3 bottles \(2 glass or water bottles, 1 glass or sand\)/);
  // a third sand makes three bottles
  world.chestItems![key(STORE)].sand = 3;
  t.true(isPlan(brewPlan(snap(KIT()), world)));
});

test('the stash\'s text reply forgot the chest\'s potions: the chest looked into first, and nothing brewed for a stock that is there', async (t) => {
  const stocked = [...MAKINGS, ...[6, 7, 8, 9, 10, 11].map(k => stack(k, 'potion', 1, 'long_fire_resistance')),
    ...[14, 15, 16].map(k => stack(k, 'potion', 1, 'long_strength')), ...[17, 18, 19].map(k => stack(k, 'potion', 1, 'long_swiftness'))];
  const world = brewWorld(stocked);
  t.like(brewGoal.declines!(snap(KIT()), world), { cause: 'stocked' });
  // the stash puts one more away by name: its reply says the totals, not the slots
  const inside = [...stocked, stack(20, 'potion', 1, 'long_fire_resistance')];
  remember(world, STORE, totalsOf(inside));
  t.regex(brewGoal.wants(snap(KIT()), world)!, /^long_fire_resistance 0\/6/, 'the memory reads the stock empty');
  const w = workshopAt(KIT(), world, inside);
  const r = await brewGoal.run(w.ctx);
  t.is(r, 'looked into 1 chest; nothing to brew: the potions are in stock (long_fire_resistance 7/6, long_strength 3/3, long_swiftness 3/3)');
  t.false(w.calls.some(c => c.startsWith('brew.')), w.calls.join(' | '));
  t.like(brewGoal.declines!(snap(KIT()), world), { cause: 'stocked' });
});

test('an ingredient left in the stand comes out before the water bottles go in (with them it would brew mundane at once)', async (t) => {
  const world = brewWorld(MAKINGS);
  const w = workshopAt(KIT(), world, MAKINGS);
  w.stand.ingredient = { name: 'redstone', count: 1 };
  const r = await brewGoal.run(w.ctx);
  t.regex(r, /^brewed 3 long_fire_resistance \(water -> awkward -> fire_resistance -> long_fire_resistance\)/);
  const out = w.calls.indexOf('brew.take {"from":"ingredient"}');
  t.true(out > 0 && out < w.calls.indexOf('brew.put {"into":"bottle","name":"potion","potion":"water"}'), w.calls.join(' | '));
});

test('the stand\'s stage is saved as the batch goes: a restart mid-batch keeps the awkward bottles, and the gate with the home\'s last wart in the stand still sends the run to them', async (t) => {
  // the home's last wart beyond the farm's two: one batch's
  const stacks = [...MAKINGS.filter(st => st.name !== 'nether_wart'), stack(1, 'nether_wart', WART_KEEP + 1)];
  const world = brewWorld(stacks);
  const w = workshopAt(KIT(), world, stacks);
  // brain.json as each save wrote it; the run killed (a restart) just after the wart's brew
  const disk: string[] = [];
  (w.ctx as { save?: () => void }).save = () => { disk.push(JSON.stringify(world)); };
  const inner = w.ctx.call;
  w.ctx.call = (async (m: string, p?: Record<string, unknown>) => {
    if (m === 'brew.put' && p?.name === 'magma_cream') throw new Error('the process restarted');
    return inner(m, p);
  }) as GoalContext['call'];
  await t.throwsAsync(brewGoal.run(w.ctx), { message: 'the process restarted' });
  t.true(disk.length >= 2, `saved after the bottles went in and after the wart's brew: ${disk.length}`);
  const after = JSON.parse(disk.at(-1)!) as WorldMemory;
  t.deepEqual(after.brewing?.bottles, ['awkward', 'awkward', 'awkward']);
  // the restarted brain's gate: the wart is in the stand, the plan goes on from the awkward bottles
  const p = brewPlan(snap(w.items), after);
  t.like(p, { from: 'awkward', steps: ['magma_cream', 'redstone'], bottles: 0 });
  t.regex(brewGoal.wants(snap(w.items), after)!, /^long_fire_resistance 0\/6: magma_cream, redstone/);
});

test('a stand holding fewer than three water bottles (a run cut between its puts) is topped up to three before the reagents go in', async (t) => {
  const world = brewWorld(MAKINGS);
  world.brewing = { bottles: ['water', null, null], fuelUses: 0, fuelCount: 0 };
  t.like(brewPlan(snap(KIT()), world), { from: 'water', bottles: 2, steps: ['nether_wart', 'magma_cream', 'redstone'] });
  t.like(brewPlan(snap(KIT()), world, ['water', 'water', 'water']), { from: 'water', bottles: 0 });
  // no bottles at home to top it up with: short of them, said, not one potion brewed of a whole batch's reagents
  const none = brewWorld(MAKINGS.filter(st => st.name !== 'glass_bottle'));
  t.regex((brewPlan(snap(KIT()), none, ['water', null, null]) as NoBrew).why, /short of 2 bottles \(0 glass or water bottles, 0 glass or sand\)/);
  const w = workshopAt(KIT(), world, MAKINGS);
  w.stand.bottles = [{ name: 'potion', count: 1, potion: 'water' }, null, null];
  const r = await brewGoal.run(w.ctx);
  t.regex(r, /^brewed 3 long_fire_resistance \(water -> awkward -> fire_resistance -> long_fire_resistance\)/, w.calls.join(' | '));
  t.is(w.calls.filter(c => c === 'brew.put {"into":"bottle","name":"potion","potion":"water"}').length, 2);
  t.is(w.calls.filter(c => c.startsWith('useOn')).length, 2, 'two filled at the water');
});
