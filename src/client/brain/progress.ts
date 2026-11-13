import type { GoalContext, Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { chestTotals } from './chests.js';
import { COLOURS } from './blueprints.js';

/**
 * The bot's long game: a tree of milestones (a storage house, a fence round the yard, farms, pens, a mine, diamond
 * gear, enchanting) worked through one step at a time whenever its needs leave it free. Each milestone checks the
 * world to see whether it's done, says what it needs (the bill, which the stock trips gather), and runs its steps;
 * a step reports progress, done, or blocked (and why), so a long job spreads over days and survives restarts.
 */

/**
 * What a step comes back with. A blocked one waits `retryMs`; one that is short of materials says so in `need` (what it
 * is short of, as it counted it) and the project then waits longer each time it comes back the same (see backoffMs).
 */
export type StepResult = { status: 'done' | 'progress'; text: string }
  | { status: 'blocked'; text: string; retryMs?: number; need?: Record<string, number> };

export interface Step {
  name: string;
  /** items this step uses (item names; crafted ones are broken down into what stock trips gather) */
  bill?: (ctx: StepView) => Record<string, number>;
  run: (ctx: GoalContext, state: MilestoneState) => Promise<StepResult>;
}

export interface Milestone {
  id: string;
  title: string;
  prereqs: string[];
  /** checked against the world and memory, so restarts and work done by hand count */
  done?: (view: StepView) => boolean;
  steps: Step[];
}

/** What a milestone can see without acting. */
export interface StepView { s: Snapshot; world: WorldMemory; have: (item: string) => number }

export interface MilestoneState {
  step: number;
  /** anything the milestone wants to keep between runs: its site, pieces built, counts */
  data: Record<string, unknown>;
}

export interface ProgressMemory {
  done: string[];
  current?: { id: string } & MilestoneState;
  /** raw materials the current step is short of, for the stock trips */
  need?: Record<string, number>;
  /** items the current step builds with (and their logs): not put away by the stash */
  carry?: string[];
  /** the most of a carried kind the current step could still use (whole stacks): the stash takes the rest */
  carryCap?: Record<string, number>;
  /**
   * Kinds a levelling's fill took out of the chests and has not placed yet (the yard growing). Not a carry: the stash
   * still puts them away as it does any stone, but it never throws them away as junk or as glut.
   */
  fill?: string[];
  /**
   * When a growth last set `fill` (ms). The mark lapses when no try has renewed it for hours (FILL_HOLD in chores.ts):
   * a growth dropped, cancelled or no longer needed never clears it, and dirt and stone would be billed for good.
   */
  fillAt?: number;
  /** a step that failed: not before (ms) */
  blockedUntil?: Record<string, number>;
  /**
   * The step that last came back short of materials: `id` is `milestone/step`, `n` how many times in a row it has,
   * `at` when it last did (blockedUntil of its milestone is then `at` + backoffMs(n)). `need` is what it waits for:
   * for each material it was short of, the TOTAL (carried and in the chests) that covers it, which is what there was
   * when it came back plus the shortfall. What is still short at any moment is stillShort(need, allItems(s, world)).
   */
  blocked?: { id: string; n: number; at: number; need: Record<string, number> };
  journal: { at: number; text: string }[];
}

export function progressOf(world: WorldMemory): ProgressMemory {
  world.progress ??= { done: [], journal: [] };
  world.progress.done ??= [];
  world.progress.journal ??= [];
  return world.progress;
}

export function journal(world: WorldMemory, now: number, text: string): void {
  const p = progressOf(world);
  p.journal.push({ at: now, text });
  if (p.journal.length > 60) p.journal.splice(0, p.journal.length - 60);
}

/** Carried plus in the home chests. */
export function haveFn(s: Snapshot, world: WorldMemory): (item: string) => number {
  const chest = chestTotals(world);
  return (item: string) => (s.counts.get(item) ?? 0) + (chest[item] ?? 0);
}

/** The milestone to work on: the first not done whose prereqs are done (and not blocked for now). */
export function nextMilestone(tree: Milestone[], s: Snapshot, world: WorldMemory): Milestone | undefined {
  const p = progressOf(world);
  const view = { s, world, have: haveFn(s, world) };
  for (const m of tree) {
    if (p.done.includes(m.id)) continue;
    if (m.done?.(view)) {
      p.done.push(m.id);
      journal(world, s.now, `${m.title}: already in place`);
      // (and nothing of it waits for materials any more)
      if (typeof p.blocked?.id === 'string' && milestoneOf(p.blocked.id) === m.id) p.blocked = undefined;
      continue;
    }
    if (!m.prereqs.every(r => p.done.includes(r))) continue;
    if (heldUntil(s, world, m.id) > s.now) continue;
    return m;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ waiting for materials

const MINUTE = 60_000;

/**
 * How long a step short of materials waits after coming back short for the n-th time in a row: 3, 6, 12, then 24 min.
 * It came back every 3 min for as long as it took (the enchanting room's cane and leather: 236 runs of 0 s in a day,
 * each one ahead of the chores), and nothing had changed in between.
 */
export const backoffMs = (n: number): number => Math.min(3 * 2 ** (Math.max(1, Math.floor(n) || 1) - 1), 24) * MINUTE;

/** The step a milestone is at, as the back-off names it, and the milestone of such a name. */
export const stepId = (milestone: string, step: number): string => `${milestone}/${step}`;
export const milestoneOf = (step: string): string => step.slice(0, step.lastIndexOf('/'));

/**
 * The back-off of a milestone: the record of its step short of materials, while the wait that step set is the one
 * standing in blockedUntil. Undefined for another milestone's record, for a brain.json from before there was one, and
 * once the milestone waits for something else (the leveling that failed after the dirt came: that wait runs its time).
 */
export function backoffOf(p: ProgressMemory | undefined, milestone: string): NonNullable<ProgressMemory['blocked']> | undefined {
  const b = p?.blocked;
  if (!b || typeof b.id !== 'string' || milestoneOf(b.id) !== milestone) return undefined;
  if (!Number.isFinite(b.n) || !Number.isFinite(b.at) || !b.need || typeof b.need !== 'object') return undefined;
  return p.blockedUntil?.[milestone] === b.at + backoffMs(b.n) ? b : undefined;
}

/** How many of an item there are in `items` (by name); a recipe's group (any log, any planks) counts every kind of it. */
export function countOf(items: Record<string, number>, item: string): number {
  const group = GROUPS[item];
  if (!group) return items[item] ?? 0;
  return Object.entries(items).reduce((a, [n, k]) => (group.test(n) ? a + k : a), 0);
}

/** What of a back-off's `need` (totals to reach) is not there yet, given everything carried and in the chests. */
export function stillShort(need: Record<string, number>, items: Record<string, number>): Record<string, number> {
  const short: Record<string, number> = {};
  for (const [item, total] of Object.entries(need)) {
    const left = total - countOf(items, item);
    if (left > 0) short[item] = left;
  }
  return short;
}

/**
 * Until when a milestone waits (ms); a time not after `s.now` means it does not. A step that waits for materials is let
 * go early once the chests and the pockets hold everything it was short of. All of it: some of the cane is no reason to
 * try again. Asked by the project's gate every tick, so this is where the met bill is noticed; it only looks.
 */
export function heldUntil(s: Snapshot, world: WorldMemory, milestone: string): number {
  const until = world.progress?.blockedUntil?.[milestone] ?? 0;
  if (!(until > s.now)) return 0;
  try {
    const b = backoffOf(world.progress, milestone);
    if (b && Object.keys(b.need).length && !Object.keys(stillShort(b.need, allItems(s, world))).length) return 0;
  } catch { /* a record that cannot be read: the wait runs its time */ }
  return until;
}

// ------------------------------------------------------------------------------------------------ materials

/** Crafting recipes for building items: what one craft makes, from what. Wood is any log or planks. */
export const RECIPES: Record<string, { makes: number; from: Record<string, number> }> = {
  // a bed of each colour, from three wool of it (wild sheep's wool: the home milestone's bed)
  ...Object.fromEntries(COLOURS.map(c => [`${c}_bed`, { makes: 1, from: { [`${c}_wool`]: 3, planks: 3 } }])),
  planks: { makes: 4, from: { log: 1 } },
  stick: { makes: 4, from: { planks: 2 } },
  chest: { makes: 1, from: { planks: 8 } },
  oak_door: { makes: 3, from: { planks: 6 } },
  oak_fence: { makes: 3, from: { planks: 4, stick: 2 } },
  oak_fence_gate: { makes: 1, from: { planks: 2, stick: 4 } },
  oak_stairs: { makes: 4, from: { planks: 6 } },
  oak_slab: { makes: 6, from: { planks: 3 } },
  oak_sign: { makes: 3, from: { planks: 6, stick: 1 } },
  torch: { makes: 4, from: { coal: 1, stick: 1 } },
  crafting_table: { makes: 1, from: { planks: 4 } },
  furnace: { makes: 1, from: { cobblestone: 8 } },
  bucket: { makes: 1, from: { iron_ingot: 3 } },
  shears: { makes: 1, from: { iron_ingot: 2 } },
  // the cows are walked home to the pen on a lead (pens.ts): two from four string and a slime ball
  lead: { makes: 2, from: { string: 4, slime_ball: 1 } },
  paper: { makes: 3, from: { sugar_cane: 3 } },
  book: { makes: 1, from: { paper: 3, leather: 1 } },
  bookshelf: { makes: 1, from: { planks: 6, book: 3 } },
  enchanting_table: { makes: 1, from: { book: 1, diamond: 2, obsidian: 4 } },
  ladder: { makes: 3, from: { stick: 7 } },
  stone_hoe: { makes: 1, from: { cobblestone: 2, stick: 2 } },
  oak_trapdoor: { makes: 2, from: { planks: 6 } },
  oak_pressure_plate: { makes: 1, from: { planks: 2 } },
  oak_button: { makes: 1, from: { planks: 1 } },
  // building blocks (stone, brick, sand, glass), for the LLM's designs: stone comes from smelting cobblestone, glass
  // from sand, bricks from clay (SMELTED in project.ts)
  stone_bricks: { makes: 4, from: { stone: 4 } },
  stone_slab: { makes: 6, from: { stone: 3 } },
  stone_stairs: { makes: 4, from: { stone: 6 } },
  stone_pressure_plate: { makes: 1, from: { stone: 2 } },
  stone_button: { makes: 1, from: { stone: 1 } },
  stone_brick_slab: { makes: 6, from: { stone_bricks: 3 } },
  stone_brick_stairs: { makes: 4, from: { stone_bricks: 6 } },
  stone_brick_wall: { makes: 6, from: { stone_bricks: 6 } },
  smooth_stone_slab: { makes: 6, from: { smooth_stone: 3 } },
  cobblestone_slab: { makes: 6, from: { cobblestone: 3 } },
  cobblestone_stairs: { makes: 4, from: { cobblestone: 6 } },
  cobblestone_wall: { makes: 6, from: { cobblestone: 6 } },
  bricks: { makes: 1, from: { brick: 4 } },
  brick_slab: { makes: 6, from: { bricks: 3 } },
  brick_stairs: { makes: 4, from: { bricks: 6 } },
  brick_wall: { makes: 6, from: { bricks: 6 } },
  clay: { makes: 1, from: { clay_ball: 4 } },
  glass_pane: { makes: 16, from: { glass: 6 } },
  sandstone: { makes: 1, from: { sand: 4 } },
  sandstone_slab: { makes: 6, from: { sandstone: 3 } },
  sandstone_stairs: { makes: 4, from: { sandstone: 6 } },
  sandstone_wall: { makes: 6, from: { sandstone: 6 } },
  cut_sandstone: { makes: 4, from: { sandstone: 4 } },
  polished_andesite: { makes: 4, from: { andesite: 4 } },
  polished_diorite: { makes: 4, from: { diorite: 4 } },
  polished_granite: { makes: 4, from: { granite: 4 } },
  andesite_slab: { makes: 6, from: { andesite: 3 } },
  andesite_stairs: { makes: 4, from: { andesite: 6 } },
  diorite_slab: { makes: 6, from: { diorite: 3 } },
  diorite_stairs: { makes: 4, from: { diorite: 6 } },
  granite_slab: { makes: 6, from: { granite: 3 } },
  granite_stairs: { makes: 4, from: { granite: 6 } },
  iron_bars: { makes: 16, from: { iron_ingot: 6 } },
  iron_nugget: { makes: 9, from: { iron_ingot: 1 } },
  lantern: { makes: 1, from: { iron_nugget: 8, torch: 1 } }
};
const WOODEN = /^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(planks|door|fence_gate|fence|stairs|slab|sign|trapdoor|pressure_plate|button)$/;

/** The recipe for an item: wooden things of any wood (birch_fence from birch_planks, birch_planks from birch_log). */
export function recipeFor(item: string): { makes: number; from: Record<string, number> } | undefined {
  const m = WOODEN.exec(item);
  if (m) {
    const [, wood, kind] = m;
    if (kind === 'planks') return { makes: 4, from: { [`${wood}_log`]: 1 } };
    const r = RECIPES[`oak_${kind}`];
    return r && { makes: r.makes, from: Object.fromEntries(Object.entries(r.from).map(([k, v]) => [k === 'planks' ? `${wood}_planks` : k, v])) };
  }
  return RECIPES[item];
}

/** The wood the bot has most of, carried and in the chests (logs, and planks at a quarter). */
export function mostWood(items: Record<string, number>): string {
  const woods = new Map<string, number>();
  for (const [n, k] of Object.entries(items)) {
    const m = /^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(log|planks)$/.exec(n);
    if (m) woods.set(m[1], (woods.get(m[1]) ?? 0) + (m[2] === 'log' ? k : k / 4));
  }
  return [...woods].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'oak';
}

/** What the item names in recipes stand for. */
const GROUPS: Record<string, RegExp> = { log: /_log$/, planks: /_planks$/, coal: /^(coal|charcoal)$/, cobblestone: /^(cobblestone|cobbled_deepslate)$/ };
const generic = (item: string) => /_log$/.test(item) ? 'log' : /_planks$/.test(item) ? 'planks' : item === 'charcoal' ? 'coal' : item === 'cobbled_deepslate' ? 'cobblestone' : item;

/**
 * Break a bill down to raw materials, using what's already there (carried or in the chests, crafted items included):
 * what the stock trips must gather. `have` counts by item name; groups (any log, any planks) are summed by the caller's
 * items via `haveItems`.
 */
export function rawShort(bill: Record<string, number>, haveItems: Record<string, number>): Record<string, number> {
  const pool: Record<string, number> = {};
  for (const [n, k] of Object.entries(haveItems)) { const g = generic(n); pool[g] = (pool[g] ?? 0) + k; }
  const short: Record<string, number> = {};
  const need = (item: string, n: number, depth = 0): void => {
    const g = generic(item);
    const use = Math.min(n, pool[g] ?? 0);
    pool[g] = (pool[g] ?? 0) - use;
    let left = n - use;
    if (left <= 0) return;
    const r = RECIPES[g];
    if (!r || depth > 6) { short[g] = (short[g] ?? 0) + left; return; }
    const crafts = Math.ceil(left / r.makes);
    for (const [inp, k] of Object.entries(r.from)) need(inp, k * crafts, depth + 1);
    pool[g] = (pool[g] ?? 0) + crafts * r.makes - left; // leftovers
    left = 0;
  };
  for (const [item, n] of Object.entries(bill)) need(item, n);
  return short;
}

/** Items carried and in the chests together, by name. */
export function allItems(s: Snapshot, world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = { ...chestTotals(world) };
  for (const [n, k] of s.counts) out[n] = (out[n] ?? 0) + k;
  return out;
}

export { GROUPS };
