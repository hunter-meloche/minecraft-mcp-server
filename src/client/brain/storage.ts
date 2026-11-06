import minecraftData from 'minecraft-data';
import { foodsFor26 } from '../tools.js';
import type { Pos } from './memory.js';

/**
 * Sorted storage: each home chest holds one category of item, so the brain knows where to put things and where to
 * find them without opening every chest, and knows when a category has run out of room (time to build a chest).
 * Pure: it only reads the chest positions and contents it is given.
 */

export type Category = 'stone' | 'wood' | 'ores' | 'food' | 'farming' | 'mobdrops' | 'gear' | 'misc';
/** Every category, most-needed first: when there are fewer chests than categories, the first ones get a chest. */
/** Most needed first: with too few chests, the last ones go without (and their things go in misc). */
export const CATEGORIES: readonly Category[] = ['food', 'gear', 'ores', 'stone', 'wood', 'misc', 'farming', 'mobdrops'];

/** Chest key ("x,y,z") -> category. */
export type ChestAssign = Record<string, string>;
/** Chest key -> item -> count, as last seen. */
export type ChestContents = Record<string, Record<string, number>>;

const keyOf = (p: Pos) => `${p.x},${p.y},${p.z}`;
const bare = (name: string) => name.replace(/^minecraft:/, '');

const GEAR = /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots|horse_armor)$|^(shield|bow|crossbow|trident|mace|elytra|bucket|fishing_rod|shears|flint_and_steel|carrot_on_a_stick|warped_fungus_on_a_stick|brush|spyglass|compass|clock|lead|saddle)$|_bucket$/;
/** Checked before food: rotten flesh and spider eyes are "edible", but nobody wants them in the food chest. */
const MOBDROPS = new Set(['rotten_flesh', 'string', 'spider_eye', 'gunpowder', 'bone', 'arrow', 'leather', 'feather', 'phantom_membrane',
  'ender_pearl', 'slime_ball', 'blaze_rod', 'ghast_tear', 'ink_sac', 'glow_ink_sac', 'rabbit_hide', 'rabbit_foot', 'magma_cream', 'prismarine_shard', 'prismarine_crystals', 'breeze_rod', 'armadillo_scute', 'turtle_scute']);
/** Checked before food too: carrots and potatoes are food (they're eaten more than planted), seeds and saplings are not. */
const FARMING = /_seeds$|_sapling$|_propagule$|^(wheat|sugar_cane|bone_meal|egg|blue_egg|brown_egg|cocoa_beans|pumpkin|melon|cactus|bamboo|hay_block|nether_wart|azalea|flowering_azalea|kelp|sweet_berries_bush)$/;
const ORES = /^raw_|_ingot$|_nugget$|_ore$|^(diamond|emerald|lapis_lazuli|redstone|coal|charcoal|quartz|netherite_scrap|ancient_debris|amethyst_shard)$|^(coal|iron|gold|copper|diamond|emerald|lapis|redstone|netherite|quartz)_block$/;
const WOOD = /_log$|_wood$|_planks$|_stem$|_hyphae$|^stripped_|^(stick|bamboo_block)$/;
const STONE = /^(cobblestone|mossy_cobblestone|cobbled_deepslate|stone|smooth_stone|andesite|diorite|granite|tuff|deepslate|calcite|dripstone_block|sand|red_sand|gravel|dirt|coarse_dirt|rooted_dirt|mud|clay|clay_ball|brick|bricks|netherrack|blackstone|basalt|smooth_basalt|end_stone|sandstone|red_sandstone|terracotta|flint)$|^polished_|_bricks$/;

/** The category an item is stored under. */
export function categoryOf(name: string): Category {
  const n = bare(name);
  if (GEAR.test(n)) return 'gear';
  if (MOBDROPS.has(n)) return 'mobdrops';
  if (FARMING.test(n)) return 'farming';
  if (foodsFor26()[n]) return 'food';
  if (ORES.test(n)) return 'ores';
  if (WOOD.test(n)) return 'wood';
  if (STONE.test(n)) return 'stone';
  return 'misc';
}

let stacks: Record<string, { stackSize: number }> | undefined;
/** Items per slot (64 for anything minecraft-data doesn't know). */
export function stackSize(name: string): number {
  stacks ??= (minecraftData('26.3') as unknown as { itemsByName: Record<string, { stackSize: number }> }).itemsByName;
  return stacks[bare(name)]?.stackSize ?? 64;
}

/** Slots a chest's contents take (each item packed into full stacks, as a chest's "store" merges them). */
function slotsUsed(items: Record<string, number>): number {
  let n = 0;
  for (const [name, count] of Object.entries(items)) n += Math.ceil(count / stackSize(name));
  return n;
}

/** How many more of an item fit: the free slots plus the rest of its last partial stack. */
function roomFor(items: Record<string, number>, name: string, slots: number): number {
  const stack = stackSize(name);
  const have = items[name] ?? 0;
  const partial = have % stack ? stack - (have % stack) : 0;
  return Math.max(0, slots - slotsUsed(items)) * stack + partial;
}

/** The item count per category in some chests. */
function categoryTotals(contents: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const items of contents) for (const [n, k] of Object.entries(items)) out[categoryOf(n)] = (out[categoryOf(n)] ?? 0) + k;
  return out;
}

/**
 * Which chest holds which category. Stable: a chest keeps the category it had in `previous` (moving a chestful is
 * slow), an unassigned chest that already mostly holds a category gets that one, and the rest go out in chest order.
 * Every category gets one chest (most-needed first, when there are too few); extra chests go to the categories with
 * the most items per chest, so the busiest category is the one that gets a second chest.
 */
export function assignChests(chests: Pos[], categories: readonly string[] = CATEGORIES, contents: ChestContents = {}, previous: ChestAssign = {}): ChestAssign {
  const keys = [...new Set(chests.map(keyOf))];
  const out: ChestAssign = {};
  for (const k of keys) if (previous[k] && categories.includes(previous[k])) out[k] = previous[k];
  const has = (c: string) => Object.values(out).includes(c);
  const free = () => keys.filter(k => !out[k]);
  // a second chest for one category while another has none (and no chest is free): the second one goes back in the
  // pool (with too few chests, stone kept two while food and the tools had none)
  for (const c of categories) {
    if (has(c) || free().length) continue;
    const counts = new Map<string, string[]>();
    for (const [k, v] of Object.entries(out)) counts.set(v, [...(counts.get(v) ?? []), k]);
    const spare = [...counts.values()].filter(ks => ks.length > 1).sort((a, b) => b.length - a.length)[0];
    if (!spare) break;
    const least = spare.sort((a, b) => Object.values(contents[a] ?? {}).reduce((x, y) => x + y, 0) - Object.values(contents[b] ?? {}).reduce((x, y) => x + y, 0))[0];
    delete out[least];
  }

  for (const c of categories) {
    if (has(c)) continue;
    // the unassigned chest already holding the most of this category (and mostly this category)
    let best: string | undefined;
    let bestN = 0;
    for (const k of free()) {
      const totals = categoryTotals([contents[k] ?? {}]);
      const n = totals[c] ?? 0;
      const top = Math.max(0, ...Object.values(totals));
      if (n > 0 && n === top && n > bestN) { best = k; bestN = n; }
    }
    if (best) out[best] = c;
  }
  for (const c of categories) {
    if (has(c)) continue;
    const k = free()[0];
    if (!k) break;
    out[k] = c;
  }
  const totals = categoryTotals(Object.values(contents));
  for (const k of free()) {
    const n = (c: string) => Object.values(out).filter(v => v === c).length;
    const per = (c: string) => (totals[c] ?? 0) / n(c);
    // ties (nothing seen yet) spread the chests out, most-needed categories first
    out[k] = categories.reduce((a, b) => (per(b) > per(a) || (per(b) === per(a) && n(b) < n(a)) ? b : a), categories[0]);
  }
  return out;
}

export interface Deposit { chest: string; name: string; count: number }
export interface DepositPlan {
  moves: Deposit[];
  /** Categories whose own chests had no room left for something: build another chest for them. */
  full: string[];
  /** What fit nowhere (not even misc) and stays carried. */
  unplaced: { name: string; count: number }[];
}

/**
 * What to put in which chest when the bot gets home. Each item goes to its category's chests (one already holding
 * it first, so stacks merge), then to the misc chest, and a category that ran out of room is reported as full.
 * `keep` is the items to keep all of, or how many of an item (counted over all its stacks) to keep carried. Only
 * the 36 pack slots are considered: worn armour and the off-hand stay on the bot.
 */
export function depositPlan(
  items: { name: string; count: number; slot: number }[],
  keep: Set<string> | ((item: { name: string; count: number }) => number),
  assign: ChestAssign,
  contents: ChestContents = {},
  slotsPerChest = 27
): DepositPlan {
  const carried = new Map<string, number>();
  for (const it of items) if (it.slot >= 0 && it.slot <= 35) carried.set(it.name, (carried.get(it.name) ?? 0) + it.count);
  const work: ChestContents = {};
  for (const k of Object.keys(assign)) work[k] = { ...(contents[k] ?? {}) };
  const chestsOf = (c: string) => Object.keys(assign).filter(k => assign[k] === c);

  const moves: Deposit[] = [];
  const full = new Set<string>();
  const unplaced: { name: string; count: number }[] = [];
  for (const [name, total] of carried) {
    const kept = keep instanceof Set ? (keep.has(name) ? total : 0) : Math.max(0, keep({ name, count: total }));
    let left = total - Math.min(total, kept);
    if (left <= 0) continue;
    const cat = categoryOf(name);
    const own = chestsOf(cat).sort((a, b) => Number((work[b][name] ?? 0) > 0) - Number((work[a][name] ?? 0) > 0));
    const put = (targets: string[]) => {
      for (const k of targets) {
        if (left <= 0) return;
        const n = Math.min(left, roomFor(work[k], name, slotsPerChest));
        if (n <= 0) continue;
        work[k][name] = (work[k][name] ?? 0) + n;
        moves.push({ chest: k, name, count: n });
        left -= n;
      }
    };
    put(own);
    if (left > 0) {
      full.add(cat);
      if (cat !== 'misc') put(chestsOf('misc'));
    }
    if (left > 0) unplaced.push({ name, count: left });
  }
  return { moves, full: [...full], unplaced };
}

export interface Move { from: string; to: string; name: string; count: number }

/**
 * Moves that sort the chests: items sitting in another category's chest go to their own category's chest, when it
 * has one with room. Items whose category has no chest stay put (the misc chest is their home until one is built).
 * At most `limit` moves per call, so a big sort spreads over several trips home.
 */
export function misplaced(assign: ChestAssign, contents: ChestContents, limit = 8, slotsPerChest = 27): Move[] {
  const work: ChestContents = {};
  for (const k of Object.keys(assign)) work[k] = { ...(contents[k] ?? {}) };
  const moves: Move[] = [];
  for (const from of Object.keys(assign)) {
    for (const [name, count] of Object.entries(contents[from] ?? {})) {
      const cat = categoryOf(name);
      if (assign[from] === cat || count <= 0) continue;
      let left = count;
      const targets = Object.keys(assign).filter(k => assign[k] === cat)
        .sort((a, b) => Number((work[b][name] ?? 0) > 0) - Number((work[a][name] ?? 0) > 0));
      for (const to of targets) {
        if (left <= 0 || moves.length >= limit) break;
        const n = Math.min(left, roomFor(work[to], name, slotsPerChest));
        if (n <= 0) continue;
        work[to][name] = (work[to][name] ?? 0) + n;
        work[from][name] -= n;
        moves.push({ from, to, name, count: n });
        left -= n;
      }
      if (moves.length >= limit) return moves;
    }
  }
  return moves;
}

// ------------------------------------------------------------------------------------------------ labels

/** What a category's chests say on their signs (food1, tools2, ...). */
export const LABEL: Readonly<Record<Category, string>> = {
  stone: 'stone', wood: 'wood', ores: 'ore', food: 'food', farming: 'seeds', mobdrops: 'drops', gear: 'tools', misc: 'misc'
};
const SYNONYM: Record<string, Category> = {
  stone: 'stone', stones: 'stone', blocks: 'stone', wood: 'wood', woods: 'wood', logs: 'wood', ore: 'ores', ores: 'ores', ingots: 'ores',
  food: 'food', foods: 'food', seeds: 'farming', seed: 'farming', farming: 'farming', farm: 'farming', drops: 'mobdrops',
  mobdrops: 'mobdrops', mob: 'mobdrops', tools: 'gear', tool: 'gear', gear: 'gear', armor: 'gear', armour: 'gear',
  misc: 'misc', miscblock: 'misc', miscblocks: 'misc', miscitems: 'misc', other: 'misc'
};

/** The category a sign names ("Food 2", "tools1", "miscBlocks"), or undefined for text that isn't a label. */
export function categoryOfLabel(text: string): Category | undefined {
  return SYNONYM[text.toLowerCase().replace(/[^a-z]/g, '')];
}

/**
 * The label for each chest ("x,y,z" -> "food1"): numbered within its category in chest order, the two halves of a
 * double chest (side by side, same category) sharing one number.
 */
export function chestLabels(chests: Pos[], assign: ChestAssign): Record<string, string> {
  const out: Record<string, string> = {};
  const count = new Map<string, number>();
  for (const c of chests) {
    const k = keyOf(c);
    const cat = assign[k] as Category | undefined;
    if (!cat || out[k]) continue;
    const n = (count.get(cat) ?? 0) + 1;
    count.set(cat, n);
    const label = `${LABEL[cat] ?? cat}${n}`;
    out[k] = label;
    for (const o of chests) {
      if (o.y === c.y && Math.abs(o.x - c.x) + Math.abs(o.z - c.z) === 1 && assign[keyOf(o)] === cat && !out[keyOf(o)]) out[keyOf(o)] = label;
    }
  }
  return out;
}
