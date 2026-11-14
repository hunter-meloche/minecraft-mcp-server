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

const GEAR = /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots|horse_armor)$|^(shield|bow|crossbow|trident|mace|elytra|bucket|fishing_rod|shears|flint_and_steel|carrot_on_a_stick|warped_fungus_on_a_stick|brush|spyglass|compass|clock|lead|saddle|enchanted_book)$|_bucket$/;
/** Checked before food: rotten flesh and spider eyes are "edible", but nobody wants them in the food chest. */
const MOBDROPS = new Set(['rotten_flesh', 'string', 'spider_eye', 'gunpowder', 'bone', 'arrow', 'leather', 'feather', 'phantom_membrane',
  'ender_pearl', 'slime_ball', 'blaze_rod', 'ghast_tear', 'ink_sac', 'glow_ink_sac', 'rabbit_hide', 'rabbit_foot', 'magma_cream', 'prismarine_shard', 'prismarine_crystals', 'breeze_rod', 'armadillo_scute', 'turtle_scute']);
/** Checked before food too: carrots and potatoes are food (they're eaten more than planted), seeds and saplings are not. */
const FARMING = /_seeds$|_sapling$|_propagule$|^(wheat|sugar_cane|bone_meal|egg|blue_egg|brown_egg|cocoa_beans|pumpkin|melon|cactus|bamboo|hay_block|nether_wart|azalea|flowering_azalea|kelp|sweet_berries_bush)$/;
const ORES = /^raw_|_ingot$|_nugget$|_ore$|^(diamond|emerald|lapis_lazuli|redstone|coal|charcoal|quartz|netherite_scrap|ancient_debris|amethyst_shard)$|^(coal|iron|gold|copper|diamond|emerald|lapis|redstone|netherite|quartz)_block$/;
const WOOD = /_log$|_wood$|_planks$|_stem$|_hyphae$|^stripped_|^(stick|bamboo_block)$/;
const STONE = /^(cobblestone|mossy_cobblestone|cobbled_deepslate|stone|smooth_stone|andesite|diorite|granite|tuff|deepslate|calcite|dripstone_block|sand|red_sand|gravel|dirt|coarse_dirt|rooted_dirt|mud|clay|clay_ball|brick|bricks|netherrack|blackstone|basalt|smooth_basalt|end_stone|sandstone|red_sandstone|terracotta|flint)$|^polished_|_bricks$/;

/**
 * Each item's category, once worked out: the stash's plan is read on every tick it would run (F2: whether anything
 * can go anywhere), and minecraft-data's food list looked up afresh for every name made one plan 4 ms of the bot's
 * core on the live storage house.
 */
const categoryCache = new Map<string, Category>();

/** The category an item is stored under. */
export function categoryOf(name: string): Category {
  const n = bare(name);
  let c = categoryCache.get(n);
  if (c) return c;
  if (GEAR.test(n)) c = 'gear';
  else if (MOBDROPS.has(n)) c = 'mobdrops';
  else if (FARMING.test(n)) c = 'farming';
  else if (foodsFor26()[n]) c = 'food';
  else if (ORES.test(n)) c = 'ores';
  else if (WOOD.test(n)) c = 'wood';
  else if (STONE.test(n)) c = 'stone';
  else c = 'misc';
  categoryCache.set(n, c);
  return c;
}

let stacks: Record<string, { stackSize: number }> | undefined;
/** Items per slot (64 for anything minecraft-data doesn't know). */
export function stackSize(name: string): number {
  stacks ??= (minecraftData('26.3') as unknown as { itemsByName: Record<string, { stackSize: number }> }).itemsByName;
  return stacks[bare(name)]?.stackSize ?? 64;
}

/**
 * Slots a chest's contents take (each item packed into full stacks, as a chest's "store" merges them): never more
 * than the game's, whose stacks of a name can be more than its count packed (things that do not stack together).
 */
export function packedSlots(items: Record<string, number>): number {
  let n = 0;
  for (const [name, count] of Object.entries(items)) n += Math.ceil(count / stackSize(name));
  return n;
}

/**
 * Slots the plans count a home chest as holding: a double chest's second half is room to spare. One seen with every
 * slot used is counted as holding none (chests.ts chestSlots): only the room left in its own stacks is counted then.
 */
export const CHEST_SLOTS = 27;
/** The slots each chest ("x,y,z") is counted as holding: one number for all, or each its own. */
export type ChestSlots = number | ((chest: string) => number);
const slotsOf = (slots: ChestSlots, chest: string) => (typeof slots === 'number' ? slots : slots(chest));

/**
 * How many more of an item fit: the free slots plus the rest of its last partial stack. With no free slot (a chest
 * seen full: `slots` 0) only that rest, which is never more than the game's: the stacks of a name in a chest are
 * never fewer than its count packed.
 */
export function roomFor(items: Record<string, number>, name: string, slots: number): number {
  const stack = stackSize(name);
  const have = items[name] ?? 0;
  const partial = have % stack ? stack - (have % stack) : 0;
  return Math.max(0, slots - packedSlots(items)) * stack + partial;
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

/**
 * Chests for the categories that ran out of room (the stash's `full`). A chest just built for them (`fresh`) is theirs:
 * left to assignChests it went to whichever category had the most items per chest, and that is the stackable stone
 * and wood (881 cobblestone) while the gear chest was full of one-per-slot tools, so the storage goal built a chest
 * "for gear" three times in an hour (13 chests, the gear one still full). Before building, an empty chest (lowest
 * first) of a category that has another chest is lent to a full one. Returns the new assignment and the categories still short.
 */
export function giveChests(assign: ChestAssign, contents: ChestContents, full: readonly string[], fresh: string[] = []): { assign: ChestAssign; short: string[] } {
  const out = { ...assign };
  const short = [...new Set(full)];
  const count = (c: string) => Object.values(out).filter(v => v === c).length;
  for (const k of fresh) {
    const c = short.shift();
    if (!c) break;
    out[k] = c;
  }
  for (const c of [...short]) {
    // the lowest first: the top layer is the one the walk can't always reach
    const empty = Object.keys(out).sort((a, b) => Number(a.split(',')[1]) - Number(b.split(',')[1])).find(k => contents[k] && !Object.values(contents[k]).some(n => n > 0) &&
      !full.includes(out[k]) && out[k] !== 'misc' && count(out[k]) > 1);
    if (!empty) continue;
    out[empty] = c;
    short.splice(short.indexOf(c), 1);
  }
  return { assign: out, short };
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
 * the 36 pack slots are considered: worn armour and the off-hand stay on the bot. `slotsPerChest`: the slots each
 * chest is counted as holding, none for one seen with every slot used (live on Nov 14 the misc chest held 19 kinds in
 * all its 27 slots, 23 of them packed, and the plan sent what fit nowhere else there, run after run: "nothing could be
 * put away").
 */
export function depositPlan(
  items: { name: string; count: number; slot: number }[],
  keep: Set<string> | ((item: { name: string; count: number }) => number),
  assign: ChestAssign,
  contents: ChestContents = {},
  slotsPerChest: ChestSlots = CHEST_SLOTS
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
        const n = Math.min(left, roomFor(work[k], name, slotsOf(slotsPerChest, k)));
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
 * At most `limit` moves per call, so a big sort spreads over several trips home. Room is counted as depositPlan counts
 * it (`slotsPerChest`): into a chest seen full, only what its own stacks still take.
 */
export function misplaced(assign: ChestAssign, contents: ChestContents, limit = 8, slotsPerChest: ChestSlots = CHEST_SLOTS): Move[] {
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
        const n = Math.min(left, roomFor(work[to], name, slotsOf(slotsPerChest, to)));
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
 * The label for each chest ("x,y,z" -> "food1"): numbered within its category, the two halves of a double chest (side
 * by side, same category) sharing one number. The numbers stay put: a chest whose sign (`worn`: the labels the chests
 * wear now) names its present category keeps that number, the first in the order below when two wear the same one;
 * every other chest takes the lowest number of its category that nobody holds. The chests are gone through by y, then
 * x, then z, whatever the order of the list: numbered in list order, the two orders that list is written in (nearest
 * home first after a look round, the storage house's own after it was built on) swapped "tools1" with "tools2" and
 * "stone2" with "stone5" every 20 minutes, and 64 signs were dug out and rewritten in a day.
 */
export function chestLabels(chests: Pos[], assign: ChestAssign, worn: Record<string, string> = {}): Record<string, string> {
  const order = [...chests].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  // what gets one label: a chest, with its other half when the list holds both
  const groups: { cat: Category; keys: string[]; n?: number }[] = [];
  const grouped = new Set<string>();
  for (const c of order) {
    const k = keyOf(c);
    const cat = assign[k] as Category | undefined;
    if (!cat || grouped.has(k)) continue;
    const keys = [k];
    grouped.add(k);
    for (const o of order) {
      const ko = keyOf(o);
      if (o.y === c.y && Math.abs(o.x - c.x) + Math.abs(o.z - c.z) === 1 && assign[ko] === cat && !grouped.has(ko)) { keys.push(ko); grouped.add(ko); }
    }
    groups.push({ cat, keys });
  }
  const held = new Set<string>();
  const hold = (g: { cat: Category; n?: number }, n: number) => { g.n = n; held.add(`${g.cat} ${n}`); };
  // first the numbers already on the signs ...
  for (const g of groups) {
    for (const k of g.keys) {
      const n = worn[k] && categoryOfLabel(worn[k]) === g.cat ? Number(/(\d+)\D*$/.exec(worn[k])?.[1]) : 0;
      if (n >= 1 && !held.has(`${g.cat} ${n}`)) { hold(g, n); break; }
    }
  }
  // ... then the lowest free one for each chest without
  for (const g of groups) {
    if (g.n) continue;
    let n = 1;
    while (held.has(`${g.cat} ${n}`)) n++;
    hold(g, n);
  }
  const out: Record<string, string> = {};
  for (const g of groups) for (const k of g.keys) out[k] = `${LABEL[g.cat] ?? g.cat}${g.n}`;
  return out;
}
