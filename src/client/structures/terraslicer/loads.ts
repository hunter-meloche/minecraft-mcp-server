import type { Station } from './slicer.js';
import { idOf } from './world.js';

/**
 * Restock planning: the station sequence cut into loads, each what the pockets carry from the home chests in one go
 * (a printer's filament changes). Greedy first-fit along the fixed order: a load ends where the next station's items
 * wouldn't fit, which for a fixed order is the fewest loads there can be. Blocks dug out come back into the pockets
 * and take room too; scaffold comes back as it's taken down, so a load carries the most it has standing at once.
 */

export interface Load {
  /** stations [from, to) */
  from: number;
  to: number;
  /** what to take from the chests for it */
  items: Record<string, number>;
  /** the stacks it fills, with what comes back from the digs */
  slots: number;
  /** of `items`, the scaffold blocks (the most it has standing at once: they come back) */
  scaffold: number;
}

/** How many make a stack. */
export function stackSize(item: string): number {
  if (/(_bed|_boat|_chest_boat|minecart|saddle|cake|_shulker_box|potion|totem|elytra|_sword|_pickaxe|_axe|_shovel|_hoe|bow|crossbow|trident|shield|_helmet|_chestplate|_leggings|_boots|bucket$)/.test(item) && item !== 'bucket') return 1;
  if (/(_sign|_hanging_sign|_banner|snowball|egg|ender_pearl|honey_bottle|^bucket$|armor_stand)$/.test(item)) return 16;
  return 64;
}

/** What digging a block puts in the pockets (nothing for glass and leaves, dirt for grass, cobblestone for stone). */
export function dropOf(state: string): string | undefined {
  const id = idOf(state);
  if (/(glass|_leaves$|^ice$|short_grass|tall_grass|fern|dead_bush|^air$|^snow$|^fire$)/.test(id)) return undefined;
  if (/^(grass_block|dirt_path|farmland|podzol|mycelium)$/.test(id)) return 'dirt';
  if (id === 'stone') return 'cobblestone';
  if (id === 'deepslate') return 'cobbled_deepslate';
  return id.replace(/_wall_torch$/, '_torch').replace(/^wall_torch$/, 'torch').replace(/_wall_sign$/, '_sign');
}

const slotsFor = (counts: Record<string, number>) => Object.entries(counts).reduce((n, [item, k]) => n + (k > 0 ? Math.ceil(k / stackSize(item)) : 0), 0);

export function planLoads(stations: Station[], freeSlots = 20, scaffoldItem = 'cobblestone'): Load[] {
  const loads: Load[] = [];
  let cur: { from: number; items: Record<string, number>; back: Record<string, number>; up: number; peak: number } | undefined;
  const fresh = (from: number) => ({ from, items: {} as Record<string, number>, back: {} as Record<string, number>, up: 0, peak: 0 });
  const close = (to: number) => {
    if (!cur) return;
    const items = { ...cur.items };
    if (cur.peak) items[scaffoldItem] = (items[scaffoldItem] ?? 0) + cur.peak;
    loads.push({ from: cur.from, to, items, slots: slotsFor(items) + slotsFor(cur.back), scaffold: cur.peak });
  };
  stations.forEach((s, i) => {
    // what this station adds to a load: items it places, drops from its digs, scaffold up and down
    const items: Record<string, number> = {};
    const back: Record<string, number> = {};
    let up = 0, peak = 0;
    for (const a of s.actions) {
      if (a.scaffold && (a.op === 'pillar' || a.op === 'place')) { up += a.count ?? 1; peak = Math.max(peak, up); continue; }
      if (a.scaffold && (a.op === 'dig' || a.op === 'descend')) { up -= a.count ?? 1; continue; }
      if ((a.op === 'place' || a.op === 'sign') && a.item) items[a.item] = (items[a.item] ?? 0) + 1;
      if (a.op === 'dig') { const d = dropOf(a.state ?? ''); if (d) back[d] = (back[d] ?? 0) + 1; }
    }
    const tryAdd = (l: NonNullable<typeof cur>) => {
      const its = { ...l.items };
      for (const [k, v] of Object.entries(items)) its[k] = (its[k] ?? 0) + v;
      const bk = { ...l.back };
      for (const [k, v] of Object.entries(back)) bk[k] = (bk[k] ?? 0) + v;
      const nPeak = Math.max(l.peak, l.up + peak);
      const withScaffold = { ...its, ...(nPeak ? { [scaffoldItem]: (its[scaffoldItem] ?? 0) + nPeak } : {}) };
      return { fits: slotsFor(withScaffold) + slotsFor(bk) <= freeSlots, its, bk, nPeak };
    };
    if (!cur) cur = fresh(i);
    let t = tryAdd(cur);
    if (!t.fits && i > cur.from) { close(i); cur = fresh(i); t = tryAdd(cur); }
    cur.items = t.its; cur.back = t.bk; cur.peak = t.nPeak; cur.up += up;
  });
  close(stations.length);
  return loads;
}
