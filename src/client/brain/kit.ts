import { packSlotsUsed, type InventoryItem } from '../tools.js';

/**
 * The kit: the tools, armour and consumables the bot always carries, what it lacks (and how to get it: take it from
 * the home chest, craft it, or gather the materials), and what to leave in the chest or throw away when it gets home.
 * Pure: it only reads the inventory and the chest contents it is given.
 */

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'hoe';
export type ArmourKind = 'helmet' | 'chestplate' | 'leggings' | 'boots';
export type GearKind = ToolKind | ArmourKind;
export type ConsumableKind = 'torch' | 'cobblestone';

/** What the bot carries: one of each gear kind, a spare pickaxe (the one tool whose loss strands it underground), torches and throwaway blocks. Food is the food goal's business. */
export const KIT = {
  gear: ['pickaxe', 'axe', 'shovel', 'sword', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots'] as readonly GearKind[],
  spare: 'pickaxe' as GearKind,
  /** Fewer than this is a need. */
  consumables: { torch: 16, cobblestone: 32 } as Readonly<Record<ConsumableKind, number>>,
  /** More than this goes in the chest. */
  carryMax: { torch: 64, cobblestone: 64 } as Readonly<Record<ConsumableKind, number>>
};

const ARMOUR = new Set<GearKind>(['helmet', 'chestplate', 'leggings', 'boots']);
/** Vanilla recipes: main material and sticks per item. */
const RECIPE: Record<GearKind, { material: number; sticks: number }> = {
  pickaxe: { material: 3, sticks: 2 }, axe: { material: 3, sticks: 2 }, shovel: { material: 1, sticks: 2 },
  sword: { material: 2, sticks: 1 }, hoe: { material: 2, sticks: 2 },
  helmet: { material: 5, sticks: 0 }, chestplate: { material: 8, sticks: 0 }, leggings: { material: 7, sticks: 0 }, boots: { material: 4, sticks: 0 }
};
/** Below this fraction of durability left a tool or piece of armour counts as worn out (it is about to break). */
const WORN = 0.1;

/**
 * Material rank, as Tools.java ranks tools (gold digs fast but wears out in 32 uses, so it ranks below stone), with
 * the armour-only materials slotted in by protection: chainmail and turtle with stone, leather with wood. Copper sits
 * between stone and iron (Tools.java doesn't rank it).
 */
const TIER: Record<string, number> = {
  netherite: 6, diamond: 5, iron: 4, copper: 3.5, stone: 3, chainmail: 3, turtle: 3, golden: 2, wooden: 1, leather: 1
};
const GEAR = /^([a-z_]+?)_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)$/;

/** The gear kind of an item ("diamond_pickaxe" -> pickaxe), or undefined when it isn't kit gear. */
export function gearKind(name: string): GearKind | undefined {
  return GEAR.exec(name)?.[2] as GearKind | undefined;
}

/** An item's material rank (0 when unknown). */
export function tier(name: string): number {
  const m = GEAR.exec(name);
  return m ? TIER[m[1]] ?? 0 : 0;
}

/** Durability left as a fraction (1 when the item doesn't wear, or the inventory didn't say). */
function left(item: InventoryItem): number {
  return item.maxDamage ? (item.maxDamage - (item.damage ?? 0)) / item.maxDamage : 1;
}

export function isWorn(item: InventoryItem): boolean {
  return left(item) < WORN;
}

/** Best first: higher tier, then more durability left. */
const better = (a: InventoryItem, b: InventoryItem) => tier(b.name) - tier(a.name) || left(b) - left(a);

/**
 * The kit items carried (anywhere, worn armour and off-hand included): the best of each kind, and the spare pickaxe
 * (the next best). Sound items come before worn-out ones whatever their tier: a nearly broken diamond pickaxe counted
 * as the best one made the bot fetch a stone pickaxe from the chest over and over, each still "not the best".
 */
export function carriedKit(items: InventoryItem[]): { best: Partial<Record<GearKind, InventoryItem>>; spare?: InventoryItem } {
  const best: Partial<Record<GearKind, InventoryItem>> = {};
  let spare: InventoryItem | undefined;
  for (const kind of KIT.gear) {
    const ofKind = items.filter(i => gearKind(i.name) === kind).sort((a, b) => Number(isWorn(a)) - Number(isWorn(b)) || better(a, b));
    if (ofKind[0]) best[kind] = ofKind[0];
    if (kind === KIT.spare) spare = ofKind[1];
  }
  return { best, spare };
}

// --- materials -------------------------------------------------------------------------------------------------

/** A group of interchangeable items (recipes take any of them), and what to call it when it's short. */
interface Group { match: (n: string) => boolean; order?: string[]; short: string }
const STONE = ['cobblestone', 'cobbled_deepslate', 'blackstone'];
const G = {
  stick: { match: (n: string) => n === 'stick', short: 'stick' },
  planks: { match: (n: string) => n.endsWith('_planks'), short: 'log' },
  log: { match: (n: string) => n.endsWith('_log'), short: 'log' },
  stone: { match: (n: string) => STONE.includes(n), order: STONE, short: 'cobblestone' },
  iron: { match: (n: string) => n === 'iron_ingot', short: 'iron_ingot' },
  diamond: { match: (n: string) => n === 'diamond', short: 'diamond' },
  coal: { match: (n: string) => n === 'coal' || n === 'charcoal', order: ['coal', 'charcoal'], short: 'coal' }
} satisfies Record<string, Group>;
/** Planks a log makes: "stripped_oak_log" -> "oak_planks". */
const planksOf = (log: string) => log.replace(/^stripped_/, '').replace(/_log$/, '_planks');

/** Tool materials, best first; wood last (only when nothing better can be made). Gold and netherite aren't planned. */
const TOOL_TIERS: { prefix: string; group: Group }[] = [
  { prefix: 'diamond', group: G.diamond }, { prefix: 'iron', group: G.iron }, { prefix: 'stone', group: G.stone }, { prefix: 'wooden', group: G.planks }
];
const ARMOUR_TIERS = TOOL_TIERS.slice(0, 2);
/** The cheapest tier worth gathering for: stone tools, iron armour. */
/** The kit is at least iron in these (the hoe can stay stone). */
const IRON_FLOOR: GearKind[] = ['pickaxe', 'axe', 'shovel', 'sword', 'helmet', 'chestplate', 'leggings', 'boots'];
const GATHER_TOOL = 2;
const GATHER_ARMOUR = 1;

/** What's in the bot's inventory and the chest, as it would be after the steps planned so far. */
class Pool {
  constructor(readonly inv = new Map<string, number>(), readonly chest = new Map<string, number>()) {}
  clone(): Pool { return new Pool(new Map(this.inv), new Map(this.chest)); }
  count(name: string): number { return (this.inv.get(name) ?? 0) + (this.chest.get(name) ?? 0); }
  names(g: Group): string[] {
    const all = [...new Set([...this.inv.keys(), ...this.chest.keys()])].filter(n => g.match(n) && this.count(n) > 0);
    return g.order ? g.order.filter(n => all.includes(n)) : all.sort();
  }
  total(g: Group): number { return this.names(g).reduce((s, n) => s + this.count(n), 0); }
  add(name: string, n: number): void { this.inv.set(name, (this.inv.get(name) ?? 0) + n); }
  /** Use n of an item, the carried ones first; returns how many came from the chest. */
  use(name: string, n: number): number {
    const fromInv = Math.min(n, this.inv.get(name) ?? 0);
    this.inv.set(name, (this.inv.get(name) ?? 0) - fromInv);
    this.chest.set(name, (this.chest.get(name) ?? 0) - (n - fromInv));
    return n - fromInv;
  }
}

export interface CraftStep { craft: string; times: number; materials: Record<string, number> }
/**
 * One step towards a need. take: fetch `count` from the home chest. craft: take `fromChest` out of the chest, craft
 * the `first` steps in order (planks from logs, sticks from planks), then craft `craft` `times` times from `materials`.
 * gather: go and get these (log means any *_log; coal can be charcoal).
 */
export type PlanStep =
  | { take: string; count: number }
  | (CraftStep & { first?: CraftStep[]; fromChest?: Record<string, number> })
  | { gather: Record<string, number> };

interface Ctx { first: CraftStep[]; fromChest: Record<string, number>; short: Record<string, number> }
const bump = (r: Record<string, number>, k: string, n: number) => { r[k] = (r[k] ?? 0) + n; };

/** Use n of a group, by name in order; returns what was used. */
function consume(p: Pool, g: Group, n: number, ctx: Ctx): Record<string, number> {
  const used: Record<string, number> = {};
  for (const name of p.names(g)) {
    if (n <= 0) break;
    const k = Math.min(n, p.count(name));
    const chest = p.use(name, k);
    if (chest) bump(ctx.fromChest, name, chest);
    used[name] = k;
    n -= k;
  }
  return used;
}

/** Make sure n of a group is in the pool, crafting sticks from planks and planks from logs; records what's short. */
function ensure(p: Pool, g: Group, n: number, ctx: Ctx): boolean {
  const missing = n - p.total(g);
  if (missing <= 0) return true;
  if (g === G.stick) {
    const times = Math.ceil(missing / 4);
    if (!ensure(p, G.planks, times * 2, ctx)) return false;
    ctx.first.push({ craft: 'stick', times, materials: consume(p, G.planks, times * 2, ctx) });
    p.add('stick', times * 4);
    return true;
  }
  if (g === G.planks) {
    const times = Math.ceil(missing / 4);
    const logs = p.total(G.log);
    if (logs < times) { bump(ctx.short, 'log', times - logs); return false; }
    for (const [log, k] of Object.entries(consume(p, G.log, times, ctx))) {
      ctx.first.push({ craft: planksOf(log), times: k, materials: { [log]: k } });
      p.add(planksOf(log), k * 4);
    }
    return true;
  }
  bump(ctx.short, g.short, missing);
  return false;
}

/** Plan crafting `times` of an item from groups; on success the pool is updated. */
function tryCraft(pool: Pool, item: string, times: number, inputs: [Group, number][]): { step: PlanStep; pool: Pool } | { short: Record<string, number> } {
  const p = pool.clone();
  const ctx: Ctx = { first: [], fromChest: {}, short: {} };
  // Sticks first: they take planks a wooden tool also needs, and every input is checked so the shortage list is whole.
  const ok = inputs.map(([g, n]) => ensure(p, g, n, ctx)).every(Boolean);
  if (!ok) return { short: ctx.short };
  const materials: Record<string, number> = {};
  for (const [g, n] of inputs) for (const [name, k] of Object.entries(consume(p, g, n, ctx))) bump(materials, name, k);
  p.add(item, item === 'torch' ? times * 4 : times);
  const step: PlanStep = { craft: item, times, materials };
  if (ctx.first.length) step.first = ctx.first;
  if (Object.keys(ctx.fromChest).length) step.fromChest = ctx.fromChest;
  return { step, pool: p };
}

// --- needs -----------------------------------------------------------------------------------------------------

export interface GearNeed {
  kind: GearKind;
  /** The spare pickaxe rather than the main one. */
  spare?: true;
  /** The worn-out item carried now. */
  have?: string;
  why: 'missing' | 'worn' | 'upgrade' | 'below iron';
  /** The item the plan gets (taken, crafted, or what the gathered materials are for). */
  bestPossible?: string;
  plan: PlanStep[];
}
export interface ConsumableNeed {
  kind: ConsumableKind | 'shield';
  why: 'short' | 'missing';
  carried: number;
  want: number;
  plan: PlanStep[];
}
export type KitNeed = GearNeed | ConsumableNeed;

function planGear(kind: GearKind, pool: Pool): { plan: PlanStep[]; bestPossible?: string; pool: Pool } {
  const { material, sticks } = RECIPE[kind];
  const tiers = ARMOUR.has(kind) ? ARMOUR_TIERS : TOOL_TIERS;
  const inputs = (g: Group): [Group, number][] => (sticks ? [[G.stick, sticks], [g, material]] : [[g, material]]);
  let craft: { item: string; step: PlanStep; pool: Pool } | undefined;
  for (const { prefix, group } of tiers) {
    const item = `${prefix}_${kind}`;
    const r = tryCraft(pool, item, 1, inputs(group));
    if ('step' in r) { craft = { item, ...r }; break; }
  }
  // A usable one in the chest beats crafting one no better (chest items carry no durability: assume they're fine).
  const inChest = [...pool.chest.entries()].filter(([n, c]) => c > 0 && gearKind(n) === kind).map(([n]) => n)
    .sort((a, b) => tier(b) - tier(a))[0];
  if (inChest && tier(inChest) >= (craft ? tier(craft.item) : 0)) {
    const p = pool.clone();
    p.use(inChest, 1);
    p.add(inChest, 1);
    return { plan: [{ take: inChest, count: 1 }], bestPossible: inChest, pool: p };
  }
  if (craft) return { plan: [craft.step], bestPossible: craft.item, pool: craft.pool };
  const cheapest = tiers[ARMOUR.has(kind) ? GATHER_ARMOUR : GATHER_TOOL];
  const r = tryCraft(pool, `${cheapest.prefix}_${kind}`, 1, inputs(cheapest.group));
  return { plan: 'short' in r ? [{ gather: r.short }] : [], bestPossible: `${cheapest.prefix}_${kind}`, pool };
}

/** Top up a consumable: from the chest first, then craft (torches), then gather what's still short. */
function planConsumable(kind: ConsumableKind, pool: Pool): { need?: ConsumableNeed; pool: Pool } {
  const want = KIT.consumables[kind];
  const names = kind === 'torch' ? ['torch'] : STONE.slice(0, 2);
  const carried = names.reduce((s, n) => s + (pool.inv.get(n) ?? 0), 0);
  let short = want - carried;
  if (short <= 0) return { pool };
  let p = pool.clone();
  const plan: PlanStep[] = [];
  for (const name of names) {
    const k = Math.min(short, p.chest.get(name) ?? 0);
    if (k <= 0) continue;
    plan.push({ take: name, count: k });
    p.use(name, k);
    p.add(name, k);
    short -= k;
  }
  if (short > 0 && kind === 'torch') {
    const times = Math.ceil(short / 4);
    const r = tryCraft(p, 'torch', times, [[G.stick, times], [G.coal, times]]);
    if ('step' in r) { plan.push(r.step); p = r.pool; } else plan.push({ gather: r.short });
  } else if (short > 0) plan.push({ gather: { cobblestone: short } });
  return { need: { kind, why: 'short', carried, want, plan }, pool: p };
}

/**
 * What the kit lacks, and a plan for each: missing or worn-out gear (best tier first: take a chest item at least as
 * good as anything craftable, else craft the best tier the inventory and chest can make, else gather for the cheapest
 * acceptable tier), then torches and throwaway blocks short of the kit. Needs are planned in order against one pool,
 * so two needs never count on the same diamonds.
 */
export function kitNeeds(items: InventoryItem[], chest: Record<string, number>): KitNeed[] {
  const inv = new Map<string, number>();
  for (const i of items) inv.set(i.name, (inv.get(i.name) ?? 0) + i.count);
  let pool = new Pool(inv, new Map(Object.entries(chest).filter(([, n]) => n > 0)));
  const { best, spare } = carriedKit(items);
  const needs: KitNeed[] = [];
  const gear = (kind: GearKind, have: InventoryItem | undefined, isSpare: boolean) => {
    if (have && !isWorn(have)) return;
    const r = planGear(kind, pool);
    pool = r.pool;
    needs.push({
      kind, ...(isSpare ? { spare: true as const } : {}), ...(have ? { have: have.name } : {}), why: have ? 'worn' : 'missing',
      ...(r.bestPossible ? { bestPossible: r.bestPossible } : {}), plan: r.plan
    });
  };
  for (const kind of KIT.gear) gear(kind, best[kind], false);
  gear(KIT.spare, spare, true);
  // then upgrades from what's left: a sound piece when there's enough for a better one (the diamonds from a deep
  // trip); the old one goes in the chest. Not the spare pickaxe, which is meant to be the cheap one.
  for (const kind of KIT.gear) {
    const have = best[kind];
    if (!have || isWorn(have)) continue;
    const up = planGear(kind, pool);
    const step = up.plan[0];
    if (!step || 'gather' in step || !up.bestPossible || tier(up.bestPossible) <= tier(have.name)) continue;
    // one that good is carried already, worn (the old diamond pickaxe taken back out of the chest over and over)
    if (items.some(i => gearKind(i.name) === kind && tier(i.name) >= tier(up.bestPossible!))) continue;
    pool = up.pool;
    needs.push({ kind, have: have.name, why: 'upgrade', bestPossible: up.bestPossible, plan: up.plan });
  }
  // and at least full iron (the user's floor for a fed, healthy bot): a piece below iron that nothing above covers
  // gathers the iron for it, which the stock trips bring and the smelter turns into ingots
  for (const kind of IRON_FLOOR) {
    if (needs.some(n => n.kind === kind && !('spare' in n && n.spare))) continue;
    const have = best[kind];
    if (have && tier(have.name) >= tier(`iron_${kind}`)) continue;
    const { material, sticks } = RECIPE[kind];
    const r = tryCraft(pool, `iron_${kind}`, 1, sticks ? [[G.stick, sticks], [G.iron, material]] : [[G.iron, material]]);
    if ('step' in r) { pool = r.pool; needs.push({ kind, ...(have ? { have: have.name } : {}), why: 'below iron', bestPossible: `iron_${kind}`, plan: [r.step] }); }
    else needs.push({ kind, ...(have ? { have: have.name } : {}), why: 'below iron', bestPossible: `iron_${kind}`, plan: [{ gather: r.short }] });
  }
  // a shield, always (the Guardian raises it against skeletons and creepers): from the chest, else 6 planks and an iron
  // ingot, else gather for it; ahead of the torches and blocks, after the gear
  if (!items.some(i => i.name === 'shield')) {
    let plan: PlanStep[];
    if ((pool.chest.get('shield') ?? 0) > 0) {
      const p = pool.clone();
      p.use('shield', 1);
      p.add('shield', 1);
      pool = p;
      plan = [{ take: 'shield', count: 1 }];
    } else {
      const r = tryCraft(pool, 'shield', 1, [[G.planks, 6], [G.iron, 1]]);
      if ('step' in r) { pool = r.pool; plan = [r.step]; } else plan = [{ gather: r.short }];
    }
    needs.push({ kind: 'shield', why: 'missing', carried: 0, want: 1, plan });
  }
  for (const kind of ['torch', 'cobblestone'] as const) {
    const r = planConsumable(kind, pool);
    pool = r.pool;
    if (r.need) needs.push(r.need);
  }
  return needs;
}

// --- stash -----------------------------------------------------------------------------------------------------

export interface StashEntry { name: string; count: number; slot?: number }
export interface StashOptions {
  /** Food item names: carried food stays on the bot. */
  foods?: Set<string>;
  /** More item names to keep carrying. */
  keep?: Set<string>;
}

/** Carried up to this many, the rest dropped: junk, or worth a few (dirt fills holes, seeds and saplings replant). */
const DROP_BEYOND: [RegExp, number][] = [
  [/^leaf_litter$/, 0], [/^poisonous_potato$/, 0], [/^rotten_flesh$/, 8], [/^dirt$/, 64], [/^(wheat|beetroot)_seeds$/, 32], [/_sapling$/, 16]
];
/** Kept one of (the extra ones go in the chest). */
const KEEP_ONE = new Set(['fishing_rod', 'bucket', 'water_bucket', 'shield']);

/**
 * What to put in the home chest and what to throw away, from the main inventory (slots 0-35; worn armour and the
 * off-hand are left alone). Kept: the best item of each kit kind and the spare pickaxe, up to 64 torches and 64
 * throwaway blocks, food, one each of fishing rod, bucket, water bucket and shield, and opts.keep. Dropped: junk
 * beyond what's worth keeping. Everything else, worse duplicates of kit gear included, is deposited; gear entries
 * carry their slot, since a kept and a deposited one can share a name.
 */
export function stashPlan(items: InventoryItem[], opts: StashOptions = {}): { deposit: StashEntry[]; drop: StashEntry[] } {
  const deposit: StashEntry[] = [];
  const drop: StashEntry[] = [];
  const { best, spare } = carriedKit(items);
  const keptGear = new Set([...Object.values(best), spare].filter(i => i !== undefined));
  const main = items.filter(i => i.slot >= 0 && i.slot <= 35);
  const totals = new Map<string, number>();
  for (const i of main) {
    if (gearKind(i.name)) {
      if (keptGear.has(i)) continue;
      // a worn one better than the sound one kept stays on the bot and is used until it breaks: put in the chest, the
      // kit took it back out again and again (chest items carry no durability, so it looked like an upgrade)
      const b = best[gearKind(i.name)!];
      if (isWorn(i) && (!b || tier(i.name) > tier(b.name))) continue;
      deposit.push({ name: i.name, count: 1, slot: i.slot });
    } else if (KEEP_ONE.has(i.name) && i.maxDamage) {
      // Damageable, one per slot: keep the one with the most use left.
      const keeper = main.filter(o => o.name === i.name).sort((a, b) => left(b) - left(a))[0];
      if (i !== keeper) deposit.push({ name: i.name, count: i.count, slot: i.slot });
    } else totals.set(i.name, (totals.get(i.name) ?? 0) + i.count);
  }
  for (const [name, count] of totals) {
    // what a project or a build job carries is never junk (a job's dirt for its farmland, its scaffold)
    const junk = opts.keep?.has(name) ? undefined : DROP_BEYOND.find(([re]) => re.test(name));
    if (junk) {
      if (count > junk[1]) drop.push({ name, count: count - junk[1] });
      continue;
    }
    let keep = 0;
    if (opts.foods?.has(name) || opts.keep?.has(name)) keep = count;
    else if (name === 'torch') keep = KIT.carryMax.torch;
    // Throwaway blocks: cobblestone first, deepslate makes up the rest.
    else if (name === 'cobblestone') keep = KIT.carryMax.cobblestone;
    else if (name === 'cobbled_deepslate') keep = Math.max(0, KIT.carryMax.cobblestone - (totals.get('cobblestone') ?? 0));
    else if (KEEP_ONE.has(name)) keep = 1;
    if (count > keep) deposit.push({ name, count: count - keep });
  }
  return { deposit, drop };
}

/** Main-inventory slots in use (0-35: not armour or off-hand). */
export const slotsUsed: (items: { slot: number }[]) => number = packSlotsUsed;
