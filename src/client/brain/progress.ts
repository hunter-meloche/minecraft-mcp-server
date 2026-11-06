import type { GoalContext, Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { chestTotals } from './chests.js';

/**
 * The bot's long game: a tree of milestones (a storage house, a fence round the yard, farms, pens, a mine, diamond
 * gear, enchanting) worked through one step at a time whenever its needs leave it free. Each milestone checks the
 * world to see whether it's done, says what it needs (the bill, which the stock trips gather), and runs its steps;
 * a step reports progress, done, or blocked (and why), so a long job spreads over days and survives restarts.
 */

export type StepResult = { status: 'done' | 'progress'; text: string } | { status: 'blocked'; text: string; retryMs?: number };

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
  /** a step that failed: not before (ms) */
  blockedUntil?: Record<string, number>;
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
    if (m.done?.(view)) { p.done.push(m.id); journal(world, s.now, `${m.title}: already in place`); continue; }
    if (!m.prereqs.every(r => p.done.includes(r))) continue;
    if ((p.blockedUntil?.[m.id] ?? 0) > s.now) continue;
    return m;
  }
  return undefined;
}

// ------------------------------------------------------------------------------------------------ materials

/** Crafting recipes for building items: what one craft makes, from what. Wood is any log or planks. */
export const RECIPES: Record<string, { makes: number; from: Record<string, number> }> = {
  planks: { makes: 4, from: { log: 1 } },
  stick: { makes: 4, from: { planks: 2 } },
  chest: { makes: 1, from: { planks: 8 } },
  oak_door: { makes: 3, from: { planks: 6 } },
  oak_fence: { makes: 3, from: { planks: 4, stick: 2 } },
  oak_fence_gate: { makes: 1, from: { planks: 2, stick: 4 } },
  oak_stairs: { makes: 4, from: { planks: 6 } },
  oak_slab: { makes: 6, from: { planks: 3 } },
  torch: { makes: 4, from: { coal: 1, stick: 1 } },
  crafting_table: { makes: 1, from: { planks: 4 } },
  furnace: { makes: 1, from: { cobblestone: 8 } },
  bucket: { makes: 1, from: { iron_ingot: 3 } },
  shears: { makes: 1, from: { iron_ingot: 2 } },
  paper: { makes: 3, from: { sugar_cane: 3 } },
  book: { makes: 1, from: { paper: 3, leather: 1 } },
  bookshelf: { makes: 1, from: { planks: 6, book: 3 } },
  enchanting_table: { makes: 1, from: { book: 1, diamond: 2, obsidian: 4 } },
  ladder: { makes: 3, from: { stick: 7 } },
  stone_hoe: { makes: 1, from: { cobblestone: 2, stick: 2 } }
};
const WOODEN = /^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_(planks|door|fence_gate|fence|stairs|slab)$/;

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
