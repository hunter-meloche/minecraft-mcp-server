import { itemOf } from '../brain/blueprints.js';
import { recipeFor } from '../brain/progress.js';
import { SMELTED } from '../brain/project.js';
import type { Change } from './diff.js';

/**
 * The materials for a set of changes, and where each comes from: carried or in the chests, crafted (planks, sticks,
 * stairs, doors...), smelted (ingots), a stock trip (logs, cobblestone, coal, iron: what the bot mines by itself), or
 * nowhere the bot can get it alone (glass, wool, quartz...: someone has to put it in a chest, or a later version
 * learns to make it).
 */

export type Source = 'have' | 'craft' | 'smelt' | 'gather' | 'missing';
export interface BillLine { item: string; need: number; have: number; source: Source }
export interface SourcedBill { lines: BillLine[]; gather: Record<string, number>; missing: Record<string, number> }

/** What the stock trips bring home by themselves. */
const GATHERABLE = /^(log|[a-z_]+_log|cobblestone|coal|iron_ingot|raw_iron|sand|clay_ball|gravel|andesite|diorite|granite)$/;

/** Items the changes place (a door's top, a bed's head and air left out). */
export function billFor(changes: Change[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) {
    if (c.second || c.want === 'air' || c.kind === 'ok' || c.kind === 'clear') continue;
    const item = itemOf(c.want);
    out[item] = (out[item] ?? 0) + (/_slab\[.*type=double/.test(c.want) ? 2 : 1);
  }
  return out;
}

const generic = (item: string) => (/^(?!stripped_)[a-z_]+_log$/.test(item) ? 'log' : /_planks$/.test(item) ? 'planks'
  : item === 'charcoal' ? 'coal' : item === 'cobbled_deepslate' ? 'cobblestone' : item);

/** Where the bill comes from, given what the bot carries and its chests hold together. */
export function sourceBill(bill: Record<string, number>, have: Record<string, number>): SourcedBill {
  const exact: Record<string, number> = { ...have };
  const pool: Record<string, number> = {};
  for (const [n, k] of Object.entries(have)) { const g = generic(n); pool[g] = (pool[g] ?? 0) + k; }
  const gather: Record<string, number> = {};
  const missing: Record<string, number> = {};
  // take from what there is: a recipe's "planks" or "log" is any of the kind, a design's "oak_planks" only that
  const GROUPS = ['log', 'planks', 'coal', 'cobblestone'];
  const take = (item: string, n: number): number => {
    if (GROUPS.includes(item)) {
      let got = 0;
      for (const [name, k] of Object.entries(exact)) {
        if (got >= n) break;
        if (generic(name) !== item || k <= 0) continue;
        const t = Math.min(k, n - got);
        exact[name] = k - t;
        got += t;
      }
      pool[item] = (pool[item] ?? 0) - got;
      return got;
    }
    const got = Math.min(n, exact[item] ?? 0);
    exact[item] = (exact[item] ?? 0) - got;
    pool[generic(item)] = (pool[generic(item)] ?? 0) - got;
    return got;
  };
  // the source of what's left of `item`, recording raw shortfalls; the worst along the way wins
  const rank: Source[] = ['have', 'craft', 'smelt', 'gather', 'missing'];
  const worst = (a: Source, b: Source) => (rank.indexOf(a) >= rank.indexOf(b) ? a : b);
  const need = (item: string, n: number, depth: number): Source => {
    const left = n - take(item, n);
    if (left <= 0) return 'have';
    const r = recipeFor(item) ?? (item === 'planks' ? { makes: 4, from: { log: 1 } } : undefined);
    if (r && depth < 6) {
      const crafts = Math.ceil(left / r.makes);
      let s: Source = 'craft';
      for (const [inp, k] of Object.entries(r.from)) s = worst(s, need(inp, k * crafts, depth + 1));
      return s;
    }
    if (SMELTED[item]) return worst('smelt', need(SMELTED[item], left, depth + 1));
    if (GATHERABLE.test(item)) { gather[item] = (gather[item] ?? 0) + left; return 'gather'; }
    missing[item] = (missing[item] ?? 0) + left;
    return 'missing';
  };
  const lines = Object.entries(bill).map(([item, n]) => {
    const before = (exact[item] ?? 0);
    const source = need(item, n, 0);
    return { item, need: n, have: Math.min(n, before), source };
  });
  return { lines, gather, missing };
}
