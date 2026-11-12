/**
 * The rungs of the work ladder (work.ts runs them): what the bot does with a day that has no job in it, the top rung
 * first. The kit for a trip down from out in the yard, a trip down for every ore the home keeps, and coal from the
 * surface. Each says why it does not run when it does not; the wrapper books what each brought in and walks home.
 *
 * Gates only read: every total is counted afresh on each look (the chests as last seen with the pockets), so stock
 * that is used, given away or taken opens its target again at once. Nothing here is used at the module's top level:
 * this file and chores.ts, deep.ts and work.ts import each other.
 */
import type { InventoryItem } from '../tools.js';
import type { Decline, Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { freeChestTotals, key } from './chests.js';
import { DEEP_TRIP, deepTripKit, type KitCheck } from './mine.js';
import { kitDecline, oreTrip, tripCheck, type OreWant } from './deep.js';
import { kitNeeds, tier } from './kit.js';
import { kitSteps } from './chores.js';
import { ownItems } from './community.js';
import { NEAR_HOME } from './pockets.js';
import { dryUntil, tierOf, type WorkTask } from './work.js';

const MINUTE = 60_000;

/** What the deep rung keeps at home of each ore (carried and in the chests), at tier 0: each tier doubles it. */
export const WORK_STOCK = { diamond: 16, iron: 96, gold: 32, redstone: 64, lapis: 32 } as const;
/** What the surface rung keeps at home. Logs and sand come with the next rungs. */
export const SURFACE_STOCK = { coal: 128 } as const;
export type DeepFamily = keyof typeof WORK_STOCK;
export type SurfaceFamily = keyof typeof SURFACE_STOCK;
export type Family = DeepFamily | SurfaceFamily;

/**
 * Each family's blocks, and the items that count as having it (raw or smelted). The first item is the ore's own drop:
 * what the mine tool counts (deep.ts oreTrip).
 */
const FAMILY: Record<Family, { ores: string; items: readonly string[] }> = {
  diamond: { ores: 'diamond_ore,deepslate_diamond_ore', items: ['diamond'] },
  iron: { ores: 'iron_ore,deepslate_iron_ore', items: ['raw_iron', 'iron_ingot'] },
  gold: { ores: 'gold_ore,deepslate_gold_ore', items: ['raw_gold', 'gold_ingot'] },
  redstone: { ores: 'redstone_ore,deepslate_redstone_ore', items: ['redstone'] },
  lapis: { ores: 'lapis_ore,deepslate_lapis_ore', items: ['lapis_lazuli'] },
  coal: { ores: 'coal_ore,deepslate_coal_ore', items: ['coal', 'charcoal'] }
};
const DEEP = Object.keys(WORK_STOCK) as DeepFamily[];

/** How much of a family the home has: carried, and in the chests beyond what the build jobs and missions hold there. */
export function have(s: Pick<Snapshot, 'counts'>, world: WorldMemory, family: Family, free = freeChestTotals(world)): number {
  return FAMILY[family].items.reduce((n, item) => n + (s.counts.get(item) ?? 0) + (free[item] ?? 0), 0);
}

/** A deep family's target at this tier. */
export const target = (family: DeepFamily, tierNow: number): number => WORK_STOCK[family] * 2 ** tierNow;
/** The targets of a tier in words (`diamond 32, iron 192, ...`). */
const targets = (tierNow: number) => DEEP.map(f => `${f} ${target(f, tierNow)}`).join(', ');

/**
 * Every home chest looked into: what is in them counts only then (as spare time trusts them only then). A half-read
 * chest list looks like "nothing stored", and the rungs would go for what the chests already hold. The kit goal looks
 * into them first thing at home.
 */
const allLooked = (world: WorldMemory) => world.landmarks.chests.every(c => !!world.chestItems?.[key(c)]);
const unread: Decline = { cause: 'unneeded', text: 'the chests are not all looked into yet' };

/** The deep families under their targets, the furthest below first (have / target, then the order above), with what each still wants. */
export function deepShort(s: Pick<Snapshot, 'counts'>, world: WorldMemory, tierNow = tierOf(world)): { family: DeepFamily; want: number }[] {
  const free = freeChestTotals(world);
  return DEEP.map((family, i) => ({ family, i, has: have(s, world, family, free), of: target(family, tierNow) }))
    .filter(r => r.has < r.of)
    .sort((a, b) => a.has / a.of - b.has / b.of || a.i - b.i)
    .map(r => ({ family: r.family, want: r.of - r.has }));
}

/**
 * The tier rule, asked by workTick once a tick: every deep family at its target, with every chest looked into, and the
 * next tier's targets in words (the queue then steps up one tier). Undefined otherwise: a chest not looked into may
 * hold anything, and an empty read must never look like "all met".
 */
export function tierStep(s: Snapshot, world: WorldMemory, tierNow: number): string | undefined {
  if (!allLooked(world) || deepShort(s, world, tierNow).length) return undefined;
  return targets(tierNow + 1);
}

// ------------------------------------------------------------------------------------------------ trip kit

/**
 * The parts of the deep kit the kit goal makes whole (kit.ts kitNeeds: torches, throwaway blocks, armour taken from
 * the chests or crafted; the Guardian puts armour on as soon as it is carried), with the kit's kinds for each and how
 * to count it. The rest of the deep kit is others': ready food the food goal's (by day, wherever the bot is), health
 * and the food bar the Guardian's (it eats), and the spare pickaxe is the kit's but no part of the deep kit.
 */
const PARTS: Record<string, { kinds: readonly string[]; short: (c: KitCheck) => boolean; count: (items: InventoryItem[]) => number }> = {
  torches: {
    kinds: ['torch'],
    short: c => c.torches < DEEP_TRIP.torches,
    count: items => items.filter(i => i.name === 'torch').reduce((n, i) => n + i.count, 0)
  },
  blocks: {
    kinds: ['cobblestone'],
    short: c => c.blocks < DEEP_TRIP.blocks,
    // as the deep kit counts them (deep.ts tripCheck)
    count: items => items.filter(i => ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'].includes(i.name)).reduce((n, i) => n + i.count, 0)
  },
  armour: {
    kinds: ['helmet', 'chestplate', 'leggings', 'boots'],
    short: c => c.armorTier < DEEP_TRIP.armorTier,
    // pieces of iron or better carried or worn, one of each kind
    count: items => ['helmet', 'chestplate', 'leggings', 'boots'].filter(k => items.some(i => i.name.endsWith(`_${k}`) && tier(i.name) >= DEEP_TRIP.armorTier)).length
  }
};

/**
 * Rung 4. The deep kit's parts the kit goal makes whole, from where the kit goal does not go: it works within 10 of
 * home, and the deep rung sets out from anywhere in the yard (the bot wakes by the bed, 16 out). At home the kit goal
 * sees to them; with nothing in the chests to make a part from, the part is what the bot is short of. The run is the
 * kit's own steps for that part (chores.ts kitSteps): nothing is made two ways.
 */
const tripKit: WorkTask = {
  name: 'trip kit',
  rank: 4,
  reach: 'yard',
  room: 'yard',
  budgetMs: 3 * MINUTE,
  variants: (s, world) => {
    if (!allLooked(world)) return [];
    const c = tripCheck(s);
    return Object.entries(PARTS).filter(([, p]) => p.short(c)).map(([id]) => ({ id, dist: 0 }));
  },
  none: (s, world) => {
    if (!allLooked(world)) return unread;
    const kit = deepTripKit(tripCheck(s));
    return { cause: 'unneeded', text: kit.ok ? 'kit ready' : `kit ready but for ${kit.why} (the food goal and the Guardian see to that)` };
  },
  ready: (s, world, variant) => {
    const part = PARTS[variant];
    const needs = kitNeeds(ownItems(s.items, world), freeChestTotals(world)).filter(n => part.kinds.includes(n.kind));
    if (!needs.some(n => n.plan.some(st => 'take' in st || 'craft' in st))) {
      const short: Record<string, number> = {};
      for (const n of needs) for (const st of n.plan) if ('gather' in st) for (const [k, v] of Object.entries(st.gather)) short[k] = (short[k] ?? 0) + v;
      const words = Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ');
      return { cause: 'kit', text: `${variant}: ${words ? `short of ${words}` : 'nothing in the chests to make them from'}` };
    }
    return s.distHome <= NEAR_HOME ? { cause: 'unneeded', text: `${variant}: the kit goal sees to them at home` } : null;
  },
  run: async (ctx, variant) => {
    const part = PARTS[variant];
    const before = part.count(ctx.s.items);
    const did = await kitSteps(ctx, part.kinds);
    const items = (await ctx.call<{ items?: InventoryItem[] }>('inventory').catch(() => undefined))?.items ?? ctx.s.items;
    const gain = Math.max(0, part.count(items) - before);
    return { gain, text: did.join('; ') || 'nothing could be done (materials ran short)' };
  }
};

// ------------------------------------------------------------------------------------------------ deep

/**
 * Rung 5. Down the mine for the ores the home is short of, the furthest below its target first and the others after
 * it on the same trip (deep.ts oreTrip), with the whole deep kit and ten slots free (the pockets rule: the wrapper
 * makes them), for the rest of the day the morning leaves. Every ore at its target is `stocked` until the targets
 * step up a tier.
 */
const deep: WorkTask = {
  name: 'deep',
  rank: 5,
  reach: 'deep',
  room: 'deep',
  // (a deep trip is given the rest of the day instead: work.ts budgetFor)
  budgetMs: 0,
  variants: (s, world) => (allLooked(world) ? deepShort(s, world).map(r => ({ id: r.family, dist: 0 })) : []),
  none: (_s, world) => (allLooked(world) ? { cause: 'stocked', text: `every ore at its target (${targets(tierOf(world))})` } : unread),
  // the deep trip's own words: hurt or hungry as health, the rest of the kit as kit
  ready: s => kitDecline(s, 'deep'),
  run: async (ctx, variant, budgetMs, now) => {
    const short = deepShort(ctx.s, ctx.world);
    // the variant's ore first, then the others still short whose last try here is not waiting out a dry mark
    const wants: OreWant[] = [...short.filter(r => r.family === variant), ...short.filter(r => r.family !== variant && !(dryUntil(ctx.world, `deep:${r.family}`) > now()))]
      .map(r => ({ family: r.family, ...FAMILY[r.family], want: r.want }));
    if (!wants.length) return { gain: 0, text: 'every ore at its target after all' };
    return oreTrip(ctx, { wants, budgetMs, now });
  }
};

// ------------------------------------------------------------------------------------------------ surface

/** A round of the surface mining: between rounds the run looks where the bot has got to, ms. */
const SURFACE_SLICE = 90_000;
/** The most one surface run asks for, as spare time did: the next run goes on from there. */
const SURFACE_WANT = 24;
/** Less of the budget than this left: no other round. */
const SURFACE_LAST = 20_000;
const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Rung 6. Coal from the surface, near home (spare time's way: the mine tool walks out of the home area to the nearest
 * it knows of, here no further than the leash), until the home has 128, 24 at most a run. Where that is is not known
 * (no site is kept yet), so the day must leave time for a walk to the leash and back. The surface ore only: deepslate
 * coal lies deep down, where a trip needs the deep kit, and this rung asks none. In rounds of 90 s, and the run comes
 * back as soon as one finds the bot beyond the leash (within a round Baritone's miner follows the vein where it goes:
 * the mod has no bound on it).
 */
const surface: WorkTask = {
  name: 'surface',
  rank: 6,
  reach: 'far',
  room: 'trip',
  budgetMs: 6 * MINUTE,
  variants: (s, world) => {
    if (!allLooked(world)) return [];
    const free = freeChestTotals(world);
    return (Object.keys(SURFACE_STOCK) as SurfaceFamily[]).filter(f => have(s, world, f, free) < SURFACE_STOCK[f])
      .map(id => ({ id, dist: world.leash }));
  },
  none: (s, world) => {
    if (!allLooked(world)) return unread;
    const free = freeChestTotals(world);
    return { cause: 'stocked', text: (Object.keys(SURFACE_STOCK) as SurfaceFamily[]).map(f => `${f} ${have(s, world, f, free)} (keep ${SURFACE_STOCK[f]})`).join(', ') };
  },
  ready: () => null,
  run: async (ctx, variant, budgetMs, now) => {
    const f = FAMILY[variant as SurfaceFamily];
    const block = f.ores.split(',')[0];
    const began = now();
    const carried = (items: InventoryItem[], names: readonly string[] = f.items) => items.filter(i => i.slot < 36 && names.includes(i.name)).reduce((n, i) => n + i.count, 0);
    const before = carried(ctx.s.items);
    const want = Math.max(1, Math.min(SURFACE_STOCK[variant as SurfaceFamily] - have(ctx.s, ctx.world, variant as SurfaceFamily), SURFACE_WANT));
    let items = ctx.s.items;
    let got = 0;
    let said = '';
    let why = '';
    while (got < want) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const left = budgetMs - (now() - began);
      if (left < SURFACE_LAST) break;
      const slice = Math.min(SURFACE_SLICE, left);
      ctx.progress(`mining ${block} for up to ${want - got} (${Math.round(slice / 1000)} s)`);
      // the mine tool counts what is carried of the ore's own drop: up to that and the want, the want is met
      const r = await ctx.act('mine-blocks', { block, count: carried(items, [f.items[0]]) + want - got, timeoutMs: slice, maxFromHome: ctx.world.leash });
      said = r.text.split('\n')[0].slice(0, 100);
      items = (await ctx.call<{ items?: InventoryItem[] }>('inventory').catch(() => undefined))?.items ?? items;
      const more = Math.max(0, carried(items) - before - got);
      // told round by round: a run the brain stops keeps what it brought in
      if (more) { ctx.gain(more); got += more; }
      // a round with none of it, or one the tool could not do (none in reach within the leash): what there was is had
      if (!more || !r.ok) break;
      const st = await ctx.status().catch(() => undefined);
      if (ctx.s.home && st?.position && horiz(st.position, ctx.s.home) > ctx.world.leash) { why = 'past the leash: back'; break; }
    }
    return { gain: got, text: got ? `+${got} ${variant}${why ? `; ${why}` : ''}` : `nothing gained${said ? ` (${said})` : ''}` };
  }
};

export const LADDER: WorkTask[] = [tripKit, deep, surface];
