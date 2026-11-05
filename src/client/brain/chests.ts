import type { GoalContext } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';

/** The home chests as the brain last saw them (every open updates its memory). */

export const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;

/** What's in a chest (walks up to it first); remembered for planning. */
export async function peekChest(ctx: GoalContext, at: Pos): Promise<Record<string, number>> {
  const open = () => ctx.call<{ items: Record<string, number> }>('chest.open', { ...at });
  try {
    let items: Record<string, number>;
    try { items = (await open()).items; } catch {
      const r = await ctx.act('move-to-position', { ...at, range: 2, timeoutMs: 60_000 });
      if (!r.ok) throw new Error(`could not reach the chest at ${fmt(at)}: ${r.text}`);
      items = (await open()).items;
    }
    remember(ctx.world, at, items);
    return items;
  } finally {
    await ctx.call('container.close').catch(() => undefined);
  }
}

export function remember(world: WorldMemory, at: Pos, items: Record<string, number>): void {
  world.chestItems ??= {};
  world.chestItems[key(at)] = { ...items };
}

/** Everything in the home chests together, as last seen. */
export function chestTotals(world: WorldMemory): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of world.landmarks.chests) {
    for (const [n, k] of Object.entries(world.chestItems?.[key(c)] ?? {})) out[n] = (out[n] ?? 0) + k;
  }
  return out;
}

/** The chests holding an item, as last seen, most first. */
export function chestsWith(world: WorldMemory, item: string): Pos[] {
  return world.landmarks.chests
    .filter(c => (world.chestItems?.[key(c)]?.[item] ?? 0) > 0)
    .sort((a, b) => (world.chestItems![key(b)][item] ?? 0) - (world.chestItems![key(a)][item] ?? 0));
}

/** Parse the "It holds: a x1, b x2" tail of a chest tool's reply into the chest's memory. */
export function rememberReply(world: WorldMemory, at: Pos, text: string): void {
  const m = /It holds: (.*?)(?:;|\.$|$)/.exec(text);
  if (!m) return;
  const items: Record<string, number> = {};
  if (m[1].trim() !== 'nothing') {
    for (const part of m[1].split(', ')) {
      const e = /^(\S+) x(\d+)$/.exec(part.trim());
      if (e) items[e[1]] = Number(e[2]);
    }
  }
  remember(world, at, items);
}

/** Take an item from whichever home chests hold it; returns how many it got. */
export async function takeFromChests(ctx: GoalContext, item: string, count: number): Promise<number> {
  let got = 0;
  for (const c of chestsWith(ctx.world, item)) {
    if (got >= count) break;
    const r = await ctx.act('take-from-chest', { ...c, item, count: count - got });
    rememberReply(ctx.world, c, r.text);
    const m = /^Took (\d+)/.exec(r.text);
    if (m) got += Number(m[1]);
  }
  return got;
}

/** Store an item in the first home chest with room; returns how many went in. */
export async function storeInChests(ctx: GoalContext, item: string, count?: number): Promise<number> {
  let stored = 0;
  for (const c of ctx.world.landmarks.chests) {
    const r = await ctx.act('store-in-chest', { ...c, item, ...(count ? { count: count - stored } : {}) });
    rememberReply(ctx.world, c, r.text);
    const m = /^Stored (\d+)/.exec(r.text);
    if (m) stored += Number(m[1]);
    if (!/the chest is full/.test(r.text) && r.ok) break;
  }
  return stored;
}
