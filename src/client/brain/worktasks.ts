/**
 * The rungs of the work ladder (work.ts runs them): what the bot does with a day that has no job in it, the top rung
 * first. The cane patch grown on the lake shore, cows for the pen while it holds fewer than a pair (out past the
 * leash: the herd is farmed for good) and wild cane while the project waits on cane, the kit for a trip down from out
 * in the yard, the rails home laid, used and taken up where the boat found no way (railshome.ts, behind its rails
 * switch), a villager brought home by boat to its hall (villagemove.ts, behind the villager-moves switch), a trip
 * down for every ore the home keeps, coal from the surface, and in the evening fishing by the lake. Each says why it
 * does not run when it does not; the wrapper books what each brought in and walks home.
 *
 * Gates only read: every total is counted afresh on each look (the chests as last seen with the pockets), so stock
 * that is used, given away or taken opens its target again at once. Nothing here is used at the module's top level:
 * this file and chores.ts, deep.ts, pens.ts and work.ts import each other.
 */
import type { InventoryItem } from '../tools.js';
import { nearHome, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { WorldMemory } from './memory.js';
import { freeChestTotals, key } from './chests.js';
import { DEEP_TRIP, deepTripKit, type KitCheck } from './mine.js';
import { kitDecline, oreTrip, tripCheck, type OreWant } from './deep.js';
import { kitNeeds, tier } from './kit.js';
import { WOODS_DIRS, kitSteps } from './chores.js';
import { ownItems } from './community.js';
import { withSwapped } from './netherset.js';
import { NEAR_HOME } from './pockets.js';
import { STRING_KEEP, allItems, recipeFor, stillShort } from './progress.js';
import { withPacked } from './storage.js';
import { WATER_FROM_HOME, cutStand, dropDeadCells, findWildCane, liveCells, plantCane, wildCane } from './cane.js';
import type { Zone } from './courtesy.js';
import { PEN_FOOD } from './animals.js';
import { IN_SIGHT, cowRange, fetchForPens, penAt } from './pens.js';
import { addSite, dropSite, dryUntil, penCount, sitesOf, tierOf, type WorkResult, type WorkTask } from './work.js';
import { leaveYard } from './yardgates.js';
import { homePortal, tripsOn } from './portal.js';
import { netherKitDecline, peekNether } from './nether.js';
import { setupOpen, setupReady, setupRun } from './nethersetup.js';
import { lookOpen, lookReady, lookRun } from './netherlook.js';
import { barterOpen, barterReady, barterRun } from './netherbarter.js';
import { quartzOpen, quartzReady, quartzRun } from './netherquartz.js';
import { scoutOpen, scoutReady, scoutRun } from './netherscout.js';
import { debrisOpen, debrisReady, debrisRun } from './netherdebris.js';
import { fortressOpen, fortressReady, fortressRun } from './netherfortress.js';
import { tunnelOpenAt, tunnelReady, tunnelRun } from './nethertunnel.js';
import { villagersTask } from './villagemove.js';
import { railsTask } from './railshome.js';
import { eveningFrom, fishDist, fishLate, fishRun, isEvening } from './fish.js';

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
  // (an ore packed into its storage block counts nine a block: chores.ts packOres)
  return withPacked(FAMILY[family].items, item => (s.counts.get(item) ?? 0) + (free[item] ?? 0));
}

/** A deep family's target at this tier. */
export const target = (family: DeepFamily, tierNow: number): number => WORK_STOCK[family] * 2 ** tierNow;
/** The targets of a tier in words (`diamond 32, iron 192, ...`). */
const targets = (tierNow: number) => DEEP.map(f => `${f} ${target(f, tierNow)}`).join(', ');

/**
 * What the deep rung keeps of the family a thing is of, at this tier: the family's items (raw and smelted, counted
 * together as the rung counts them) and its target. None for what no rung mines (emeralds). The donate goal's floor
 * (community.ts): stock given away below it is only mined again.
 */
export function workKeeps(item: string, tierNow: number): { items: readonly string[]; target: number } | undefined {
  const family = DEEP.find(f => FAMILY[f].items.includes(item));
  return family ? { items: FAMILY[family].items, target: target(family, tierNow) } : undefined;
}

/**
 * Every home chest looked into: what is in them counts only then (as the stock trips trust them only then). A half-read
 * chest list looks like "nothing stored", and the rungs would go for what the chests already hold. The kit goal looks
 * into them first thing at home.
 */
const allLooked = (world: WorldMemory) => world.landmarks.chests.every(c => !!world.chestItems?.[key(c)]);
const unread: Decline = { cause: 'unneeded', text: 'the chests are not all looked into yet' };

const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

// ------------------------------------------------------------------------------------------------ cane patch

/**
 * The cells the cane patch grows to. Cane grows a block about every 18 min and the round cuts every 20: once grown,
 * some 24 cane a round, the enchanting room's 101 short in under two hours.
 */
export const CANE_CELLS = 24;
/** A live patch this big grows the cane the project waits on: no walks for wild cane then. */
const PATCH_GROWS = 12;
/** A shore found full is looked along again after this long, whatever the patch has: the lake rises and sinks. */
const FULL_FOR = 24 * 60 * MINUTE;

/** Cane carried, and in the chests beyond what a build job holds there: what the patch can be planted with. */
const caneToPlant = (s: Pick<Snapshot, 'counts'>, world: WorldMemory) => (s.counts.get('sugar_cane') ?? 0) + (freeChestTotals(world).sugar_cane ?? 0);

/**
 * Why the patch needs nothing now, or null: whole (24 cells that can grow cane); its shore found full with as many
 * live cells as it has now, under a day ago; or nothing to plant it with.
 */
function patchWhy(s: Snapshot, world: WorldMemory): Decline | null {
  const live = liveCells(world).length;
  if (live >= CANE_CELLS) return { cause: 'unneeded', text: `${live} cells` };
  // (each try at a full shore read every cell and the shore, planted nothing and waited its mark: two tries a
  // 160-min wait for as long as the bot lived, the 30 s release given to it ahead of the coal. A cell lost reopens it)
  const full = world.caneFull;
  if (full && live >= full.cells && s.now >= full.at && s.now - full.at < FULL_FOR) return { cause: 'unneeded', text: `the shore is full at ${full.cells} cells` };
  if (caneToPlant(s, world) < 1) return allLooked(world) ? { cause: 'unneeded', text: 'no cane to plant' } : unread;
  return null;
}

/**
 * Rung 1. The cane patch, grown to 24 cells on the shore of the nearest open water (cane.ts plantCane, the cane
 * milestone's own planting), with cane carried or taken from the chests. First it looks at every cell it has and
 * drops the ones with no water beside them: by Nov 12 the lake had sunk from beside the first five (at y 63) to y
 * 55-56, and the round cut nothing there 77 times in 100. A cell is live unless the bot has seen it dry (the round
 * writes down what it sees, this run what it finds), so the gate reads memory only; and so is a shore found full
 * (world.caneFull: the lake east of the yard holds 20 cells, not 24). How far: the furthest cell it has, or with none
 * as far as open water is looked for.
 */
const canePatch: WorkTask = {
  name: 'cane patch',
  rank: 1,
  reach: 'near',
  room: 'yard',
  budgetMs: 4 * MINUTE,
  variants: (s, world) => {
    if (patchWhy(s, world)) return [];
    const home = s.home ?? s.position;
    const cells = world.zones?.cane ?? [];
    return [{ id: 'shore', dist: cells.length ? Math.round(Math.max(...cells.map(c => horiz(c, home)))) : WATER_FROM_HOME }];
  },
  none: (s, world) => patchWhy(s, world) ?? { cause: 'unneeded', text: 'cane patch: nothing to do' },
  ready: (s, world) => patchWhy(s, world),
  run: async (ctx, _variant, budgetMs, now) => {
    const began = now();
    const dead = await dropDeadCells(ctx, now());
    const parts: string[] = [];
    if (dead.length) {
      const said = `dropped ${dead.length} dry cell(s) (no water beside them): ${dead.map(c => `${c.x},${c.y},${c.z}`).join(' ')}`;
      ctx.progress(said);
      parts.push(`dropped ${dead.length} dry cell(s)`);
    }
    const live = liveCells(ctx.world).length;
    const max = Math.min(CANE_CELLS - live, caneToPlant(ctx.s, ctx.world));
    if (max <= 0) {
      parts.push(live >= CANE_CELLS ? `the patch has its ${live} cells` : 'no cane to plant');
      return { gain: 0, text: parts.join('; ') };
    }
    const r = await plantCane(ctx, max, () => now() - began > budgetMs);
    // the shore planted as far as it goes: written down for the gate (it waits till a cell is lost, or a day)
    if (r.full) ctx.world.caneFull = { cells: live, at: now() };
    else if (r.planted.length) delete ctx.world.caneFull;
    parts.push(r.text);
    return { gain: r.planted.length, text: `${parts.join('; ')} (${liveCells(ctx.world).length} of ${CANE_CELLS} cells)` };
  }
};

// ------------------------------------------------------------------------------------------------ cows

/** A pen with this many adults breeds the rest itself (the pens round, up to 6): no fetch then. */
const PAIR = 2;
/** The pens round's count of the pen holds this long (it looks every 6 min by day); older, it is not known. */
const PEN_FRESH = 30 * MINUTE;
/**
 * Blocks a second of the walk home with a cow on the lead, as pens.ts bringIn walks it: a careful leg of 4 blocks
 * (LEAD_LEG: about a second's walking, and a second or so for Baritone to set out and stop), the look at where the
 * bot got to, then heelLead's looks 0.75 s apart until the cow is within 4 again (one or two: the game pulls it in
 * from 6). 4 blocks in 2 to 3 s, 1.5 to 2 a second, slower on the turns at the gates: the slow end, so a fetch that
 * sets out is home by dusk (work.ts needMs: from 200 out 260 s with the walk out at 3 a second and the least work,
 * so it sets out until tod 5800; a side at the cow range, 256, 316 s, until tod 4680). (Here, not in pens.ts: the
 * rung is made at this module's top level.)
 */
const LEAD_PACE = 1.5;

/**
 * What a lead is made from, read off the recipe the run crafts it by (progress.ts RECIPES: five string), so the two
 * cannot drift apart: this said "4 string and a slime ball" while the game took five string and no slime ball.
 */
const leadFrom = (): [string, number][] => Object.entries(recipeFor('lead')?.from ?? {});

/**
 * Something to walk a cow home by, carried or stored (beyond what a build job holds): a lead, or what makes one, or 2
 * wheat to lure one with. The run takes the same in that order (pens.ts holdFor).
 */
function canLead(s: Pick<Snapshot, 'counts'>, world: WorldMemory): boolean {
  const free = freeChestTotals(world);
  const n = (item: string) => (s.counts.get(item) ?? 0) + (free[item] ?? 0);
  const makes = leadFrom();
  return n('lead') >= 1 || (makes.length > 0 && makes.every(([k, v]) => n(k) >= v)) || PEN_FOOD.cow.some(f => n(f) >= 2);
}

/**
 * Why no cow is fetched now, or null: no cow pen with a gate; the chests not all looked into (a half-read list would
 * show nothing to lead a cow home with); the pen with a pair in it as the pens round last counted it (under half an
 * hour ago: older, it is not known, and a look is allowed); nothing to walk a cow home by. Whatever the project needs:
 * the herd is farmed for good (the user, Nov 13: "We need to be farming cows"), and with the leather of the project
 * the only reason, the pen stood empty whenever the project waited on something else.
 */
function cowsWhy(s: Snapshot, world: WorldMemory): Decline | null {
  if (!penAt(world, 'cow')) return { cause: 'unneeded', text: 'no cow pen with a gate' };
  if (!allLooked(world)) return unread;
  const pen = penCount(world, 'cow');
  if (pen && s.now - pen.at < PEN_FRESH && pen.adults >= PAIR) return { cause: 'unneeded', text: `the pen has ${pen.adults} cows (they breed the rest)` };
  if (!canLead(s, world)) {
    const makes = leadFrom().map(([k, v]) => `${v} ${k}`).join(', ');
    return { cause: 'kit', text: `nothing to lead a cow home with (no lead, no ${makes} for one, no wheat)` };
  }
  return null;
}

/**
 * Rung 2. Cows for the pen while it holds fewer than a pair, whatever the project needs: the herd the pens round
 * breeds and culls is the one route to leather and beef (the pen never held a cow on the friend's server). Where one
 * was last seen first (`in sight`: the pens round's looks and the fetches' write down where wild ones stood), then one
 * side of home a run, out to the cows' range (pens.ts COW_RANGE, 256: past the leash, which everything else keeps;
 * within it every side came back with none, four times and more) and no further. Walked home on a lead (pens.ts
 * fetchForPens), two at once when two graze together; gain is the cows penned. The way home on the lead is slow
 * (LEAD_PACE): the day it needs, its budget and its timeout count it (work.ts needMs), so a fetch that sets out is
 * home by dusk: a side at 256 sets out until tod 4680. The sides are terrain: a side with no cow waits ever longer,
 * and a new range lets their marks go (workTick).
 */
const cows: WorkTask = {
  name: 'cows',
  rank: 2,
  reach: 'far',
  room: 'trip',
  budgetMs: 6 * MINUTE,
  terrain: true,
  range: world => cowRange(world),
  backPace: LEAD_PACE,
  variants: (s, world) => {
    if (cowsWhy(s, world)) return [];
    const home = s.home ?? s.position;
    const range = cowRange(world);
    const seen = sitesOf(world, 'cow').filter(p => horiz(p, home) <= range);
    // (where one was seen is tried ahead of the sides' turn: `first`). Its distance is the farther of the two nearest
    // places, as the day it needs: the fetch walks on to the second when the first holds none (pens.ts toSighting),
    // and by the nearest alone a late run set out for 40 out, walked on to 200 and led a cow home from there at dusk
    const near = seen.map(p => horiz(p, home)).sort((a, b) => a - b).slice(0, 2);
    const sight = near.length ? [{ id: IN_SIGHT, dist: Math.round(near[near.length - 1]), first: true as const }] : [];
    return [...sight, ...WOODS_DIRS.map(id => ({ id, dist: range }))];
  },
  none: (s, world) => cowsWhy(s, world) ?? { cause: 'unneeded', text: 'cows: nothing to do' },
  ready: (s, world) => cowsWhy(s, world),
  run: async (ctx, variant, budgetMs, now) => {
    const began = now();
    return fetchForPens(ctx, variant, { kind: 'cow', enough: () => now() - began > budgetMs, now });
  }
};

// ------------------------------------------------------------------------------------------------ cane (wild)

/**
 * Why no wild cane is wanted now, or null: the chests not all looked into (a half-read list would show the cane
 * short); the project not waiting on cane (what it still lacks of the blocked step's whole bill, against everything
 * carried and stored); or a live patch of 12 cells or more grows it.
 */
function caneWhy(s: Snapshot, world: WorldMemory): Decline | null {
  if (!allLooked(world)) return unread;
  const need = world.progress?.blocked?.need;
  const short = need ? stillShort(need, allItems(s, world)).sugar_cane ?? 0 : 0;
  if (!short) return { cause: 'unneeded', text: need?.sugar_cane ? 'the project has its sugar_cane' : 'the project is not waiting on sugar_cane' };
  const live = liveCells(world).length;
  return live >= PATCH_GROWS ? { cause: 'unneeded', text: `the patch grows it (${live} cells)` } : null;
}

/** a remembered stand's variant id */
const standId = (p: { x: number; z: number }) => `stand ${p.x},${p.z}`;

/**
 * Rung 3. Wild cane for the project while the patch is too small to grow it: a stand found before (work.sites.cane,
 * within the leash), cut from the second block up and its base left to grow again; else one side of home a run,
 * walked out to the leash and no further, and a stand found is cut and remembered. Gain is the cane picked up. The
 * sides are terrain: wild cane was found 1 time in 19 within 96 blocks, so a side with none waits ever longer.
 */
const cane: WorkTask = {
  name: 'cane',
  rank: 3,
  reach: 'far',
  room: 'trip',
  budgetMs: 6 * MINUTE,
  terrain: true,
  variants: (s, world) => {
    if (caneWhy(s, world)) return [];
    const home = s.home ?? s.position;
    // (a stand found is tried ahead of the sides' turn: `first`)
    const stands = sitesOf(world, 'cane').filter(p => horiz(p, home) <= world.leash).map(p => ({ id: standId(p), dist: Math.round(horiz(p, home)), first: true as const }));
    return [...stands, ...WOODS_DIRS.map(id => ({ id, dist: world.leash }))];
  },
  none: (s, world) => caneWhy(s, world) ?? { cause: 'unneeded', text: 'cane: nothing to do' },
  ready: (s, world) => caneWhy(s, world),
  run: async (ctx, variant, budgetMs, now) => {
    const began = now();
    const enough = () => now() - began > budgetMs;
    const home = ctx.s.home!;
    const zones = (await ctx.call<{ zones?: Zone[] }>('foreign.zones').catch(() => undefined))?.zones ?? [];
    const wild = wildCane(ctx.world, home, zones);
    const visit = async (at: { x: number; y: number; z: number }, found: string): Promise<WorkResult> => {
      const v = await cutStand(ctx, at, wild, enough);
      const where = `(${at.x}, ${at.y}, ${at.z})`;
      // a remembered stand not got to waits its mark, as the land's marks do, and the sides have their turns (held
      // back as a failure, it was chosen first again each time and the sides never ran); a side that found one it
      // could not get to has still been looked along, and the stand is tried as itself next time
      if (v.unreached) return { gain: 0, text: `${found}could not reach the stand at ${where}: ${v.unreached}` };
      // (a stand forgotten takes its mark with it: from a side, the side's own mark stands)
      const forget = found ? {} : { mark: 'forget' as const };
      if (v.theirs !== undefined) { dropSite(ctx.world, 'cane', at); return { gain: 0, text: `${found}someone else's build ${v.theirs} blocks from the stand at ${where}: theirs, left alone and forgotten`, ...forget }; }
      if (v.gone) { dropSite(ctx.world, 'cane', at); return { gain: 0, text: `${found}no cane at ${where} any more: forgotten`, ...forget }; }
      const grown = v.cut ? `cut ${v.cut} stalk(s) above the base, ${v.bases} base(s) left to grow` : `none grown back yet: ${v.bases} base(s) left to grow`;
      return { gain: v.got, text: `${found}${v.got ? `+${v.got} sugar_cane` : 'no cane picked up'} at ${where} (${grown})` };
    };
    if (variant.startsWith('stand ')) {
      const site = sitesOf(ctx.world, 'cane').find(p => standId(p) === variant);
      if (!site) return { gain: 0, text: 'the stand is no longer remembered', mark: 'forget' };
      return visit(site, '');
    }
    const side = variant as (typeof WOODS_DIRS)[number];
    const found = await findWildCane(ctx, side, wild, enough);
    // (a side the run's time cut short was not looked along to its end: its count stays)
    if (!found.at) return { gain: 0, text: found.text, ...(found.short ? { mark: 'same' as const } : {}) };
    addSite(ctx.world, 'cane', found.at);
    const out = Math.round(horiz(found.at, home));
    ctx.progress(`wild cane ${side} at (${found.at.x}, ${found.at.y}, ${found.at.z}), ${out} blocks from home`);
    return visit(found.at, `found wild cane ${side}, ${out} blocks from home: `);
  }
};

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
    const needs = kitNeeds(withSwapped(ownItems(s.items, world), world), freeChestTotals(world)).filter(n => part.kinds.includes(n.kind));
    if (!needs.some(n => n.plan.some(st => 'take' in st || 'craft' in st))) {
      const short: Record<string, number> = {};
      for (const n of needs) for (const st of n.plan) if ('gather' in st) for (const [k, v] of Object.entries(st.gather)) short[k] = (short[k] ?? 0) + v;
      const words = Object.entries(short).map(([k, v]) => `${v} ${k}`).join(', ');
      return { cause: 'kit', text: `${variant}: ${words ? `short of ${words}` : 'nothing in the chests to make them from'}` };
    }
    return nearHome(s, NEAR_HOME) ? { cause: 'unneeded', text: `${variant}: the kit goal sees to them at home` } : null;
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

// ------------------------------------------------------------------------------------------------ nether

/**
 * One kind of work down there: open from a stage of the trips (`world.nether.stage`, which P2b's ramp raises) and
 * while `open` says so, ready as a rung's variant is (reads only), and its run (the trip itself: the wrapper takes
 * the bot home after it).
 */
export interface NetherWork {
  id: string;
  stage: number;
  open?(world: WorldMemory): boolean;
  ready(s: Snapshot, world: WorldMemory): Decline | null;
  run(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult>;
}

/**
 * `setup` (P2b, nethersetup.ts): the bot's own Nether-side portal, built and checked both ways, from stage 0 until the
 * two sides are linked. Its functions are reached at the call: this module and nethersetup.ts import each other's
 * neighbours, and nothing of theirs is read as the modules load.
 */
const setupWork: NetherWork = {
  id: 'setup',
  stage: 0,
  open: world => setupOpen(world),
  ready: (s, world) => setupReady(s, world),
  run: (ctx, budgetMs, now) => setupRun(ctx, budgetMs, now)
};

/**
 * `look` (P2b, netherlook.ts): stage 0's second trip, once the two sides are linked: through to its own hut, a look at
 * the Nether round it (the sites), back. The setup's clean trip and the look's make the 2 that open stage 1 (nether.ts
 * NETHER_STAGES), and the look closes with it.
 */
const lookWork: NetherWork = {
  id: 'look',
  stage: 0,
  open: world => lookOpen(world),
  ready: (s, world) => lookReady(s, world),
  run: (ctx, budgetMs, now) => lookRun(ctx, budgetMs, now)
};

/**
 * `barter` (P3a, netherbarter.ts): from stage 1, by its own portal: gold ingots tossed to piglins within 48 of it, what
 * they throw back picked up, while a barter target (nether.ts NETHER_STOCK) is short and gold over the reserve is
 * there (the gold chore smelts it at home).
 */
const barterWork: NetherWork = {
  id: 'barter',
  stage: 1,
  open: world => barterOpen(world),
  ready: (s, world) => barterReady(s, world),
  run: (ctx, budgetMs, now) => barterRun(ctx, budgetMs, now)
};

/**
 * `quartz` (P3a, netherquartz.ts): from stage 1, by its own portal: nether quartz ore within 24 of it with a face open
 * to air, none by lava, 32 at most a trip, while the home has less quartz than its target (nether.ts NETHER_STOCK).
 * It takes its turn with the barter (the rung's turn goes round its variants).
 */
const quartzWork: NetherWork = {
  id: 'quartz',
  stage: 1,
  open: world => quartzOpen(world),
  ready: (s, world) => quartzReady(s, world),
  run: (ctx, budgetMs, now) => quartzRun(ctx, budgetMs, now)
};

/**
 * `scout` (P3b, netherscout.ts): from stage 2, from its own portal: a leg of up to 96 out on foot along one of the
 * eight bearings (the least known first, then each in turn a day after its last), over open ground by the barter's
 * walking rules, turned back at half its time; what it passes (others' builds, natural fortresses and bastions, lava
 * lakes, the biomes) kept as sites with the way it took.
 */
const scoutWork: NetherWork = {
  id: 'scout',
  stage: 2,
  open: world => scoutOpen(world),
  ready: (s, world) => scoutReady(s, world),
  run: (ctx, budgetMs, now) => scoutRun(ctx, budgetMs, now)
};

/**
 * `debris` (P3b, netherdebris.ts): from stage 2, by its own portal and by the known ways of the scouting legs: ancient
 * debris with a face open to air within 24 of its portal or of a waypoint, none by lava, 4 at most a trip, mined
 * only under the fire resistance it drinks at its portal. With no potion of fire resistance in stock it stays shut,
 * and says so.
 */
const debrisWork: NetherWork = {
  id: 'debris',
  stage: 2,
  open: world => debrisOpen(world),
  ready: (s, world) => debrisReady(s, world),
  run: (ctx, budgetMs, now) => debrisRun(ctx, budgetMs, now)
};

/**
 * `fortress` (P3c, netherfortress.ts): from stage 3 with no potion (the user's strict rules of Nov 17: nether.ts
 * NETHER_STAGES says what each work needs), to a natural fortress a scouting leg found, by that leg's way: at full
 * health and food in the Nether set with a shield, blazes fought from the shield and wither skeletons with the sword,
 * home at once under 10 health, with the wither, on a hold, at its time or where the way on needs fire resistance;
 * blaze rods, a few wart, some soul sand and its chests' loot while the rods or the wart are short. A death on one
 * turns the fortress trips off until the lead switches them back.
 */
const fortressWork: NetherWork = {
  id: 'fortress',
  stage: 3,
  open: world => fortressOpen(world),
  ready: (s, world) => fortressReady(s, world),
  run: (ctx, budgetMs, now) => fortressRun(ctx, budgetMs, now)
};

/**
 * `tunnel` (P3c, nethertunnel.ts, the user's decision 5 of Nov 17): from stage 3, while the home is short of the
 * netherite's 16 ancient debris and a potion of fire resistance is in stock: 1x2 tunnels from its own portal down to
 * y 15 and along it, read ahead (no lava within 2, no cave beside, the Nether's rock only, 16 from every build), the
 * debris they bare mined under the fire resistance it drinks at the tunnel's face, 4 at most a trip; kept so later
 * trips go on from them. The open-face debris (`debris`) stays as it is.
 */
const tunnelWork: NetherWork = {
  id: 'tunnel',
  stage: 3,
  open: world => tunnelOpenAt(world),
  ready: (s, world) => tunnelReady(s, world),
  run: (ctx, budgetMs, now) => tunnelRun(ctx, budgetMs, now)
};

/** The Nether rung's work: stage 0's setup and look, stage 1's barter and quartz, stage 2's scouting and debris, stage 3's fortress and tunnelling; P6 adds the bastion. */
export const NETHER_WORK: readonly NetherWork[] = [setupWork, lookWork, barterWork, quartzWork, scoutWork, debrisWork, fortressWork, tunnelWork];

/** The home portal is lit and the bot's own: the portal milestone is done and the portal known. */
const portalReady = (world: WorldMemory) => (world.progress?.done ?? []).includes('nether-portal') && !!homePortal(world);

/**
 * Rung 4.5 (fractional: the unblockers' rule and the order of the others are as they were). Through the home portal
 * into the Nether, for the work its stage opens (NETHER_WORK), with the Nether kit (mine.ts NETHER_TRIP) and twelve
 * slots free, home by dusk (nether.ts netherBudgetMs), held after deaths down there, on probation until three trips
 * end well, two a game day at most (work.ts). Never while the switch is off or the home portal not lit: then it says
 * `nether trips are off`, or `no nether work yet` while no work is open (linked, and the look done or no portal of
 * its own known, at stage 0).
 */
const nether: WorkTask = {
  name: 'nether',
  rank: 4.5,
  reach: 'nether',
  room: 'nether',
  // (the barter and the quartz take turns: a productive barter kept the turn every morning while the gold chore
  // brought the gold back each afternoon)
  rotate: true,
  // (a Nether trip is given the day instead: work.ts budgetFor)
  budgetMs: 0,
  variants: (_s, world) => {
    if (!tripsOn(world) || !portalReady(world)) return [];
    const stage = peekNether(world).stage;
    return NETHER_WORK.filter(v => v.stage <= stage && (v.open?.(world) ?? true)).map(v => ({ id: v.id, dist: 0 }));
  },
  none: (_s, world) => ({
    cause: 'unneeded',
    text: !tripsOn(world) ? 'nether trips are off' : portalReady(world) ? 'no nether work yet' : 'no nether work yet: the home portal is not lit'
  }),
  // each work's own (the setup and the look fetch what the chests hold of the kit: their ready says what they do not),
  // else the kit carried
  ready: (s, world, variant) => {
    const work = NETHER_WORK.find(v => v.id === variant);
    return work ? work.ready(s, world) : netherKitDecline(s);
  },
  run: async (ctx, variant, budgetMs, now) => {
    const work = NETHER_WORK.find(v => v.id === variant);
    // (a run that got here with no such work never went through)
    return work ? work.run(ctx, budgetMs, now) : { gain: 0, text: `no nether work ${variant}`, untried: true };
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
/** The most one surface run asks for, as the retired spare time did: the next run goes on from there. */
const SURFACE_WANT = 24;
/** Less of the budget than this left: no other round. */
const SURFACE_LAST = 20_000;

/**
 * Rung 6. Coal from the surface, near home (the stock trips' way: the mine tool walks out of the home area to the
 * nearest it knows of, here no further than the leash), until the home has 128, 24 at most a run. Where that is is not
 * known (no site is kept yet), so the day must leave time for a walk to the leash and back. The surface ore only:
 * deepslate coal lies deep down, where a trip needs the deep kit, and this rung asks none. In rounds of 90 s, and the
 * run comes back as soon as one finds the bot beyond the leash (within a round Baritone's miner follows the vein where
 * it goes: the mod has no bound on it).
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
      // where the coal is, Baritone's miner knows, outside the home area: out of the yard by the nearest gate first,
      // not over the fence to it (yardgates.ts)
      await leaveYard(ctx);
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

// ------------------------------------------------------------------------------------------------ fish

/**
 * Why there is no rod to fish with, or null: one carried, one in the chests (beyond what a build job holds there), or
 * the makings of one, 3 sticks and 2 string beyond the leads' (STRING_KEEP: the pens walk the cows home on them; the
 * string comes in only as the mobs drop it). The chests not all looked into: a half-read list shows none.
 */
function rodWhy(s: Snapshot, world: WorldMemory): Decline | null {
  if ((s.counts.get('fishing_rod') ?? 0) > 0) return null;
  if (!allLooked(world)) return unread;
  const free = freeChestTotals(world);
  if ((free.fishing_rod ?? 0) > 0) return null;
  const string = (s.counts.get('string') ?? 0) + (free.string ?? 0);
  const sticks = (s.counts.get('stick') ?? 0) + (free.stick ?? 0);
  if (string - STRING_KEEP >= 2 && sticks >= 3) return null;
  const lack = string - STRING_KEEP < 2 ? `${string} string (a rod takes 2 beyond the ${STRING_KEEP} kept for the leads)` : `${sticks} sticks (a rod takes 3)`;
  return { cause: 'kit', text: `no fishing rod, and ${lack}` };
}

/**
 * Rung 7. The evening's: fishing (fish.ts), once no far rung fits the day (from tod 8520 at the leash of 96: the
 * same bound that books the evening's idle time `late`, about 110 s of every live day on Nov 15) and while the walk to
 * the water and back and half a minute at it (fish.ts fishLate) still fit before the walk home at dusk: no fishing at
 * night. By the open water nearest home (the lake east of the yard), from a stand on its shore reached on foot, with
 * a rod carried, taken from the chests or made (never of the leads' string). Gain is the catches: fish (food),
 * treasure for the anvil (enchanted books: Mending among them), and the junk the stash keeps or throws away (fish.ts
 * CATCH).
 */
const fish: WorkTask = {
  name: 'fish',
  rank: 7,
  reach: 'near',
  room: 'yard',
  budgetMs: 4 * MINUTE,
  variants: (s, world) => (isEvening(s, world) ? [{ id: 'water', dist: fishDist(s, world) }] : []),
  none: (_s, world) => ({ cause: 'unneeded', text: `fish: the evening's, from tod ${Math.ceil(eveningFrom(world.leash))} (no far rung fits the day then)` }),
  // (the hour after the rod: a rung with no rod to fish with is not idle for being late)
  ready: (s, world) => rodWhy(s, world) ?? fishLate(s, fishDist(s, world)),
  run: (ctx, _variant, budgetMs, now) => fishRun(ctx, budgetMs, now)
};

export const LADDER: WorkTask[] = [canePatch, cows, cane, tripKit, railsTask, villagersTask, nether, deep, surface, fish];
