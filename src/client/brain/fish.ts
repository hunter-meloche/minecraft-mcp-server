/**
 * The evening's rung (worktasks.ts `fish`): fishing by the open water nearest home, from a stand cell on dry land on
 * its shore, once no far rung fits the day. Live on Nov 15 every idle second of the day was the evening's (`late`:
 * about 110 s a day, once the far rungs were past their late bound and the deep window shut), and the evening is
 * what this fills: a catch every 20 to 30 s, xp for the anvil and the enchant chore, and now and then a treasure, an
 * enchanted book among them (Mending is on 26.3's random loot list), which the anvil's plan applies (anvil.ts).
 *
 * Treasure comes only from open water, by 26.3's FishingHook (calculateOpenWater, read in the jar): round the block
 * the hook floats in, the 5 x 5 square of it and the one under it all water source with nothing solid in it (water,
 * seagrass, kelp, a bubble column; no flowing water, no waterlogged slab), and the two over it all air or lily pads,
 * layer by layer: water first, then air, never water again over air. The hook lands a block or so off where it is
 * aimed, so the cast target here has a block more of it round it where the water allows (7 x 7), the game's 5 x 5
 * where it does not, and still water that is no open water (no treasure, fish and junk only) last. The bridge casts
 * at the block it is given: the brain chooses it.
 *
 * What the rung reads and writes: the gates read only (worktasks.ts); the run reads the ground round the water
 * (world.findBlocks, world.region), the builds of others (foreign.zones) and who is about (world.entities), and keeps
 * the water it fished well at as a site (work.sites.fish: its distance is the rung's from then on).
 */
import type { InventoryItem } from '../tools.js';
import { outsideBy, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { RETURN_AT, daylightLeft } from './schedule.js';
import { freeChestTotals, storedStacks, takeFromChests, takeSlot } from './chests.js';
import { someones, zoneDistance, type Creature, type Zone } from './courtesy.js';
import { makeRod } from './food.js';
import { STRING_KEEP } from './progress.js';
import { addSite, dropSite, needMs, sitesOf, type WorkResult } from './work.js';
import { inFence, leaveYard } from './yardgates.js';

const MS_PER_TICK = 50;
const SECOND = 1000;

const horiz = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const fmt = (p: Pos) => `(${p.x}, ${p.y}, ${p.z})`;
const bare = (b: string | null | undefined) => (b ?? '').replace(/^minecraft:/, '');
const nameOf = (b: string | null | undefined) => bare(b).replace(/\[.*$/, '');
/** Pockets as the bridge says them now (the main 36 slots). */
const pockets = async (ctx: GoalContext): Promise<InventoryItem[]> => ((await ctx.call<{ items?: InventoryItem[] }>('inventory').catch(() => undefined))?.items ?? []).filter(i => i.slot < 36);

// ------------------------------------------------------------------------------------------------ the evening

/** The far rungs' late bound as daylight, ticks: a walk to the leash and back and the least work (work.ts needMs). */
export const farTicks = (leash: number): number => needMs(leash, 'far') / MS_PER_TICK;
/** The time of day the evening starts at: from here no far rung fits the day (8520 at the leash of 96). */
export const eveningFrom = (leash: number): number => RETURN_AT - farTicks(leash);
/**
 * The evening: awake, still work time, and too late for a far rung (the same bound that books the idle time `late`).
 * The morning's half hour before sunrise is no evening: a whole day is left then.
 */
export const isEvening = (s: Pick<Snapshot, 'timeOfDay' | 'activity' | 'sleeping'>, world: Pick<WorldMemory, 'leash'>): boolean =>
  !s.sleeping && s.activity === 'work' && daylightLeft(s.timeOfDay) < farTicks(world.leash);

// ------------------------------------------------------------------------------------------------ where

/** How far from home open water is looked for (as the cane patch looks: the lake east of the yard is 43 out). */
export const FISH_FROM_HOME = 64;
/** No one's build nearer than this to the stand or the water cast into (the yard keeps the same from a build). */
export const FISH_FROM_BUILDS = 16;
/** No player, pet or someone's animal nearer than this to the cast's line: a hook pulls what it catches. */
export const CAST_CLEAR = 8;
/** How far the stand may be from the block cast at (the hook lands 3.5 to 5 off at the pitch a near cast takes). */
const CAST_MAX = 5.5;
/** How far round a found water block the ground is read: the targets within 4 of it, and the stands round each. */
const LOOK = 9;
/** How many places along the water are read at a run, and how far apart. */
const PLACES = 6;
const PLACE_APART = 8;
/**
 * How high over a water block the sky is looked for (cane.ts plantCane reads the same column), how many such columns
 * a run reads at most, and how far over or under home's level water is asked for at all (fluidpick.ts asks by height
 * too: the nearest 256 were a cave's, and the surface ones never came back).
 */
const SKY = 16;
const SKY_LOOKS = 48;
const FISH_BAND = 16;

/**
 * The water cast into: how well it fishes. `open`: the game's open water with a block to spare round it (the hook may
 * land a block off); `edge`: the game's 5 x 5 at the block itself; `still`: still water that is no open water (fish and
 * junk only).
 */
export type Grade = 'open' | 'edge' | 'still';
const GRADES: readonly Grade[] = ['open', 'edge', 'still'];
const GRADE_WORDS: Record<Grade, string> = { open: 'open water', edge: 'open water at the mark (a cast a block off is not)', still: 'still water, not open (no treasure)' };

/**
 * The least time at the water that makes the walk worth it, ms: a catch comes every 20 to 30 s. The ladder's own
 * bound for a near rung (work.ts needMs: there and back and 20 s) leaves 5 s at the water once the run's budget has
 * kept its walk back and its margin, and a run sent out then came home with nothing, its dry mark keeping the rung
 * home for the next two evenings.
 */
export const FISH_LEAST_MS = 30_000;
/** The margin the run's budget keeps before dusk (work.ts budgetFor), ms. */
const DUSK_MARGIN_MS = 15_000;

/**
 * Too little of the day left to fish: the walk to the water `dist` out and back, the run's margin before dusk, and
 * FISH_LEAST_MS at the water do not fit the daylight. Null while they do; a look only.
 */
export function fishLate(s: Pick<Snapshot, 'timeOfDay'>, dist: number): Decline | null {
  const leftMs = daylightLeft(s.timeOfDay) * MS_PER_TICK;
  const needs = 2 * dist / 3 * SECOND + DUSK_MARGIN_MS + FISH_LEAST_MS;
  const min = (ms: number) => (ms / 60_000).toFixed(1);
  return leftMs < needs ? { cause: 'late', text: `${min(leftMs)} min of daylight left (fish needs ${min(needs)}: the walk to the water and back, ${FISH_LEAST_MS / SECOND} s there, and a margin)` } : null;
}

/**
 * How far out the rung's water is, for the day it needs (fishLate; and the ladder's bound for a near rung, work.ts
 * needMs) and the run's budget: the water it last fished well at, else as far as it looks (64, or the leash). A look
 * only, for the gate.
 */
export function fishDist(s: Pick<Snapshot, 'home' | 'position'>, world: WorldMemory): number {
  const home = s.home ?? s.position;
  const known = sitesOf(world, 'fish')[0];
  return known ? Math.round(horiz(known, home)) : Math.min(FISH_FROM_HOME, world.leash);
}

/** A box of blocks read with world.region (x fastest, then z, then y): what the choices below look at. */
export interface View { box: { x: number; y: number; z: number; width: number; height: number; length: number }; blocks: (string | null)[] }

const blockAt = (v: View, x: number, y: number, z: number): string | null => {
  const { box } = v;
  const dx = x - box.x, dy = y - box.y, dz = z - box.z;
  if (dx < 0 || dy < 0 || dz < 0 || dx >= box.width || dy >= box.height || dz >= box.length) return null;
  return v.blocks[dx + dz * box.width + dy * box.width * box.length] ?? null;
};

/** water whose fluid is a source and whose block has no collision box: what the hook's open water counts as water */
const SOURCE_BLOCKS = /^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/;
/**
 * The game's three kinds of block round the hook (FishingHook.getOpenWaterTypeForBlock): air or a lily pad over the
 * water; still water with nothing solid in it (flowing water, or a waterlogged slab or stair, is neither); anything
 * else, which spoils open water. A block not loaded is the last: nothing is said of it.
 */
export function waterKind(b: string | null): 'above' | 'inside' | 'invalid' {
  const n = nameOf(b);
  if (!b) return 'invalid';
  if (n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'lily_pad') return 'above';
  if (n === 'water') return /level=(?!0\b)\d+/.test(bare(b)) ? 'invalid' : 'inside';
  return SOURCE_BLOCKS.test(n) ? 'inside' : 'invalid';
}

/**
 * Open water round `t` (the block the hook floats in, at the water's top) by 26.3's rule, over a square of `r` each
 * way (2 is the game's): the layers from one under it to two over it each all one kind, the first water, and no water
 * over air.
 */
export function openWater(v: View, t: Pos, r = 2): boolean {
  let was: 'above' | 'inside' | undefined;
  for (let dy = -1; dy <= 2; dy++) {
    let layer: 'above' | 'inside' | 'invalid' | undefined;
    for (let dx = -r; dx <= r && layer !== 'invalid'; dx++) for (let dz = -r; dz <= r; dz++) {
      const k = waterKind(blockAt(v, t.x + dx, t.y + dy, t.z + dz));
      if (layer === undefined) layer = k; else if (layer !== k) { layer = 'invalid'; break; }
    }
    if (layer === 'invalid' || layer === undefined) return false;
    if (layer === 'above' && was === undefined) return false;
    if (layer === 'inside' && was === 'above') return false;
    was = layer;
  }
  return true;
}

/**
 * Still water a cast lands in: the block and the 5 x 5 round it water at its level, air over the block (the fish tool's
 * own pond).
 */
const stillWater = (v: View, t: Pos): boolean => {
  if (waterKind(blockAt(v, t.x, t.y + 1, t.z)) !== 'above') return false;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (waterKind(blockAt(v, t.x + dx, t.y, t.z + dz)) !== 'inside') return false;
  return true;
};

/** How well the water at `t` fishes, or undefined: none to cast into there. */
export function gradeOf(v: View, t: Pos): Grade | undefined {
  if (openWater(v, t, 3)) return 'open';
  if (openWater(v, t, 2)) return 'edge';
  return stillWater(v, t) ? 'still' : undefined;
}

/**
 * Ground a stand cell stands on: natural ground (never farmland, a path's crops, leaves, a build's planks: someone's
 * build is kept off by its zone).
 */
const FLOOR = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|muddy_mangrove_roots|moss_block|sand|red_sand|gravel|clay|stone|cobblestone|mossy_cobblestone|deepslate|cobbled_deepslate|andesite|diorite|granite|tuff|calcite|sandstone|red_sandstone|terracotta|[a-z_]+_terracotta|dirt_path|packed_mud|snow_block)$/;
/**
 * What the feet and head may share a stand cell with (the cane module's airy plants; no water: never a stand in it).
 */
const CLEAR = /^(air|cave_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|bush|pink_petals|wildflowers)$/;
const EYE = 1.62;

/**
 * Nothing in the cast's way from the eye at the stand to the top of the block cast at: air, plants, water. A bank, a
 * tree's leaves or a wall would stop the hook short of the water (it lies on the ground then, and is recast).
 */
function clearCast(v: View, stand: Pos, t: Pos): boolean {
  const a = { x: stand.x + 0.5, y: stand.y + EYE, z: stand.z + 0.5 }, b = { x: t.x + 0.5, y: t.y + 1, z: t.z + 0.5 };
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 4);
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const p = blockAt(v, Math.floor(a.x + (b.x - a.x) * f), Math.floor(a.y + (b.y - a.y) * f), Math.floor(a.z + (b.z - a.z) * f));
    if (!(CLEAR.test(nameOf(p)) || waterKind(p) !== 'invalid')) return false;
  }
  return true;
}

/**
 * The stand cells (the block the feet are in) to cast at `t` from, by the grade's square: on dry natural ground, the
 * feet one to three over the water's top, feet and head clear, out of the square the grade needs to be water (a bank
 * in it is no open water), within CAST_MAX of the mark, the cast's way clear; and as `keep` allows (the rung's
 * courtesy and the yard's rules). The nearest home first: the shortest walk.
 */
export function standsFor(v: View, t: Pos, grade: Grade, keep: (p: Pos) => boolean, home: { x: number; z: number }): Pos[] {
  const r = grade === 'open' ? 3 : 2;
  const out: Pos[] = [];
  const reach = Math.ceil(CAST_MAX);
  for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) <= r || Math.hypot(dx, dz) > CAST_MAX) continue;
    for (let fy = t.y + 1; fy <= t.y + 3; fy++) {
      const p = { x: t.x + dx, y: fy, z: t.z + dz };
      if (!FLOOR.test(nameOf(blockAt(v, p.x, fy - 1, p.z))) || !CLEAR.test(nameOf(blockAt(v, p.x, fy, p.z))) || !CLEAR.test(nameOf(blockAt(v, p.x, fy + 1, p.z)))) continue;
      if (!keep(p) || !clearCast(v, p, t)) continue;
      out.push(p);
    }
  }
  return out.sort((a, b) => horiz(a, home) - horiz(b, home) || horiz(a, t) - horiz(b, t));
}

/** A place to fish: the block cast at, how well it fishes, and the stand cells to cast from, the best first. */
export interface Cast { target: Pos; grade: Grade; stands: Pos[] }

/**
 * The best cast in a box read round water block `w` (at the water's top): every water block at its level within 4 of
 * it that `water` allows, by its grade, then the shortest walk from home to a stand, then the nearest `w`.
 */
export function castsIn(v: View, w: Pos, water: (t: Pos) => boolean, keep: (p: Pos) => boolean, home: { x: number; z: number }): Cast[] {
  const casts: Cast[] = [];
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    const t = { x: w.x + dx, y: w.y, z: w.z + dz };
    if (waterKind(blockAt(v, t.x, t.y, t.z)) !== 'inside' || !water(t)) continue;
    const grade = gradeOf(v, t);
    if (!grade) continue;
    const stands = standsFor(v, t, grade, keep, home);
    if (stands.length) casts.push({ target: t, grade, stands });
  }
  return casts.sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade) || horiz(a.stands[0], home) - horiz(b.stands[0], home) || horiz(a.target, w) - horiz(b.target, w));
}

/**
 * The rung's courtesy and the yard's rules for the stand cells and the water: within the rung's reach of home (the
 * leash, and FISH_FROM_HOME); outside the yard's fence and a block clear of it, so never in or by the yard's own water
 * (the farm's, the workshop's); never on or beside a cell of the cane patch (its stalks stand on the shore the bot
 * would walk); and FISH_FROM_BUILDS from anyone's build, the water too.
 */
export function fishRules(world: WorldMemory, home: { x: number; y: number; z: number }, zones: Zone[]): { keep: (p: Pos) => boolean; water: (t: Pos) => boolean } {
  const reach = Math.min(FISH_FROM_HOME, world.leash);
  const yard = world.yard;
  const cane = world.zones?.cane ?? [];
  const off = (p: Pos) => zones.every(z => zoneDistance(p, z) >= FISH_FROM_BUILDS);
  return {
    keep: p => horiz(p, home) <= reach && (!yard || outsideBy(yard, p) >= 2) && off(p) &&
      !cane.some(c => Math.abs(c.x - p.x) <= 1 && Math.abs(c.z - p.z) <= 1 && Math.abs(c.y - p.y) <= 1),
    water: t => horiz(t, home) <= reach + CAST_MAX && (!yard || outsideBy(yard, t) > 2) && off(t)
  };
}

/**
 * Where to fish this run: the water fished at before first (work.sites.fish), then open water under the sky nearest
 * home (SKY of plain air over it, within FISH_BAND of home's level), a place every PLACE_APART along it, six at most,
 * each read LOOK round. The first place with a cast of the best grade found so far that cannot be bettered (open)
 * ends the look. A remembered place that has no cast now, or no sky over it, is forgotten.
 */
export async function findCast(ctx: GoalContext): Promise<{ cast?: Cast; text: string }> {
  const home = ctx.s.home ?? ctx.s.position;
  const zones = (await ctx.call<{ zones?: Zone[] }>('foreign.zones').catch(() => undefined))?.zones ?? [];
  const rules = fishRules(ctx.world, home, zones);
  const reach = Math.min(FISH_FROM_HOME, ctx.world.leash);
  const read = async (w: Pos): Promise<Cast[]> => {
    const box = { x: w.x - LOOK, y: w.y - 1, z: w.z - LOOK, width: 2 * LOOK + 1, height: 6, length: 2 * LOOK + 1 };
    const blocks = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', box).catch(() => undefined))?.blocks ?? [];
    return castsIn({ box, blocks }, w, rules.water, rules.keep, home);
  };
  // sky over it, or it is a pool under something: findBlocks' openAbove is the one block over it (cave air counts),
  // and a cave's pool 24 east of home, 8 out of the fence under the hill, graded open and won over the lake, the cast
  // made in the dark at dusk or its stand never reached, run after run. Plain air only, all the way up: a cave's is
  // cave air. A block not loaded says nothing
  const underSky = async (w: Pos): Promise<boolean> => {
    const col = (await ctx.call<{ blocks?: (string | null)[] }>('world.region', { x: w.x, y: w.y + 1, z: w.z, width: 1, height: SKY, length: 1 }).catch(() => undefined))?.blocks;
    return Array.isArray(col) && col.every(b => b === null || nameOf(b) === 'air');
  };
  // (the better grade wins; of one grade, the first found: the remembered water, then the nearest home)
  const better = (a: Cast | undefined, b: Cast | undefined) => (b && (!a || GRADES.indexOf(b.grade) < GRADES.indexOf(a.grade)) ? b : a);
  let best: Cast | undefined;
  const known = sitesOf(ctx.world, 'fish')[0];
  if (known) {
    const there = (await underSky(known)) ? (await read(known))[0] : undefined;
    if (there) best = there; else { dropSite(ctx.world, 'fish', known); ctx.progress(`no cast by ${fmt(known)} any more: forgotten`); }
  }
  if (best?.grade === 'open') return { cast: best, text: '' };
  // (the look goes as much further as the bot stands from home, and keeps the water within reach of home: the cane
  // patch's look found nothing from the far end of the yard when it looked round the bot alone)
  const off = Math.ceil(horiz(ctx.s.position, home)) + 16;
  const water = (await ctx.call<{ positions?: Pos[] }>('world.findBlocks', {
    block: 'water', maxDistance: Math.min(128, reach + off), count: 256, openAbove: true, yMin: home.y - FISH_BAND, yMax: home.y + FISH_BAND
  }).catch(() => undefined))?.positions ?? [];
  const allowed = water.filter(rules.water);
  const places: Pos[] = [];
  // (the water round a roofed one at its level is the same pool under the same roof, as like as not: not read again)
  const roofed: Pos[] = [];
  let looks = 0;
  for (const w of allowed.sort((a, b) => horiz(a, home) - horiz(b, home))) {
    if (places.length >= PLACES || looks >= SKY_LOOKS) break;
    if (places.some(p => horiz(p, w) < PLACE_APART) || (known && horiz(known, w) < PLACE_APART)) continue;
    if (roofed.some(r => r.y === w.y && Math.max(Math.abs(r.x - w.x), Math.abs(r.z - w.z)) <= 2)) continue;
    looks++;
    if (!(await underSky(w))) { roofed.push(w); continue; }
    places.push(w);
    best = better(best, (await read(w))[0]);
    if (best?.grade === 'open') break;
  }
  if (best) return { cast: best, text: '' };
  if (places.length) return { text: `no stand to cast from by the water round ${places.map(fmt).join(', ')}` };
  if (roofed.length) return { text: `no water under the sky within ${reach} blocks of home (under a roof: ${roofed.slice(0, 3).map(fmt).join(', ')})` };
  return { text: water.length ? `no water to fish within ${reach} blocks of home outside the yard and ${FISH_FROM_BUILDS} from anyone's build` : `no water under the sky within ${reach} blocks of home` };
}

// ------------------------------------------------------------------------------------------------ the rod

/**
 * A rod in the pockets: carried; else one from the chests, an enchanted one first where the chests' stacks are known
 * (lure and luck of the sea: quicker bites, more treasure; the treasure brings them up now and then); else made of 3
 * sticks and 2 string, never of the string kept for the leads (STRING_KEEP: the pens walk the cows home on them).
 * Undefined once there is one; else why not.
 */
export async function rodToHand(ctx: GoalContext): Promise<{ how?: string; why?: string }> {
  const carried = async () => (await pockets(ctx)).some(i => i.name === 'fishing_rod');
  if (await carried()) return {};
  const enchanted = storedStacks(ctx.world, st => st.name === 'fishing_rod' && !!(st.enchanted || st.enchantments?.length));
  for (const { chest, stack } of enchanted.slice(0, 2)) if (await takeSlot(ctx, chest, stack.slot, 1).catch(() => 0)) return { how: 'took an enchanted fishing rod from the chests' };
  if ((freeChestTotals(ctx.world).fishing_rod ?? 0) > 0 && await takeFromChests(ctx, 'fishing_rod', 1).catch(() => 0)) return { how: 'took a fishing rod from the chests' };
  if (await makeRod(ctx, { keepString: STRING_KEEP, careful: true }) && await carried()) return { how: 'made a fishing rod' };
  return { why: `no fishing rod: none in the chests, and none could be made (3 sticks, 2 string beyond the ${STRING_KEEP} kept for the leads)` };
}

// ------------------------------------------------------------------------------------------------ the catch

/**
 * What a catch is to the stash: food it keeps raw (a stack of each carried, the rest stored; the food goal cooks the
 * cod and salmon only once the chests' ready food runs out), treasure and stock it keeps, junk it throws at the dump.
 */
export type CatchKind = 'food' | 'treasure' | 'stock' | 'junk';
/**
 * 26.3's fishing loot (gameplay/fishing: fish 85, junk 10, treasure 5 in open water only), each by what the stash does
 * with it. Food: carried up to a stack a kind (the pufferfish goes in the chests: it poisons), the rest stored up to
 * the caps (pockets.ts GLUT). Treasure, every piece kept: the enchanted book (the anvil's), the bow and the rod (both
 * enchanted), the name tag, the saddle, the nautilus shell. Stock, kept: the junk table's leather, string, bone, stick,
 * ink sacs, bamboo, the water bottle (the brewing's) and the worn rod (a spare for this rung). Junk, thrown at the dump
 * spot (kit.ts stashPlan): the lily pad, the bowl, the tripwire hook, the leather boots, rotten flesh beyond 8.
 */
export const CATCH: Readonly<Record<string, CatchKind>> = {
  cod: 'food', salmon: 'food', tropical_fish: 'food', pufferfish: 'food',
  enchanted_book: 'treasure', bow: 'treasure', name_tag: 'treasure', saddle: 'treasure', nautilus_shell: 'treasure',
  fishing_rod: 'stock', leather: 'stock', string: 'stock', bone: 'stock', stick: 'stock', ink_sac: 'stock', bamboo: 'stock', potion: 'stock',
  lily_pad: 'junk', bowl: 'junk', tripwire_hook: 'junk', leather_boots: 'junk', rotten_flesh: 'junk'
};
const KIND_WORDS: Record<CatchKind, string> = {
  // (not "cooked": live the bot carries a stack of bread and the chests hold hundreds of loaves, so the food goal
  // never wants, and it takes ready food from the chests before it cooks anything)
  food: 'food: kept raw, carried or stored, cod and salmon cooked by the food goal only once the chests\' ready food runs out',
  treasure: 'treasure: kept', stock: 'kept', junk: 'junk: to the dump'
};

/**
 * What came up, by what the stash does with it: `cod 5, salmon 2 (food: kept raw, ...); enchanted_book 1 (treasure:
 * kept)`. An enchanted rod is treasure.
 */
export function catchWords(got: Record<string, number>, enchantedRods = 0): string {
  const by = new Map<CatchKind, string[]>();
  const add = (kind: CatchKind, text: string) => by.set(kind, [...(by.get(kind) ?? []), text]);
  for (const [name, n] of Object.entries(got).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!(n > 0)) continue;
    if (name === 'fishing_rod' && enchantedRods > 0) {
      add('treasure', `enchanted fishing_rod ${Math.min(n, enchantedRods)}`);
      if (n > enchantedRods) add('stock', `fishing_rod ${n - enchantedRods}`);
      continue;
    }
    add(CATCH[name] ?? 'stock', `${name} ${n}`);
  }
  return (['food', 'treasure', 'stock', 'junk'] as const).filter(k => by.has(k)).map(k => `${by.get(k)!.join(', ')} (${KIND_WORDS[k]})`).join('; ');
}

// ------------------------------------------------------------------------------------------------ the run

/** One call of the bridge's `fish`: at most this long, and this many bites, before the run looks round again. */
const SLICE_MS = 60_000;
const SLICE_BITES = 16;
/** Less of the budget than this left: no other slice. */
const LAST_SLICE_MS = 15_000;
/** Slices in a row with no bite at all: the spot is no good (the casts land on the bank, or under something). */
const QUIET_SLICES = 2;
/**
 * Slices in a row that ended on a hook let go of an animal and brought no bite: no cast out of that line for now (the
 * jar ends a call on such a let-go, and a wild sheep grazing on the shore was hooked again at every cast).
 */
const LET_GO_SLICES = 3;
/** Less of the run than this left for the walk to a stand (and a last slice at the water): the run sets out on none. */
const STAND_LEAST_MS = 10_000;

/**
 * What the bridge's `fish` answers: bites reeled in (each a catch), casts, the pockets' gain by name, how long; and
 * from this jar on, the bites in open water and what a hook caught and was let go.
 */
interface FishReply {
  bites: number; casts: number; gained?: Record<string, number>; seconds?: number; recalled?: string; open?: number; letGo?: string[];
  /** the call ended before a cast with no free slot for its catch (from this jar on) */
  full?: boolean;
  /** the call ended before a cast with a player or someone's animal by its line: who, in nearCast's words (this jar on) */
  blocked?: string;
}

const countsOf = (items: InventoryItem[]) => {
  const m: Record<string, number> = {};
  for (const i of items) m[i.name] = (m[i.name] ?? 0) + i.count;
  return m;
};
const enchantedRodsIn = (items: InventoryItem[]) => items.filter(i => i.name === 'fishing_rod' && (i.enchanted || i.enchantments?.length)).length;

/** The distance from `p` to the segment a-b. */
function toSegment(p: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const len = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
  const f = len ? Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / len)) : 0;
  return Math.hypot(p.x - (a.x + ab.x * f), p.y - (a.y + ab.y * f), p.z - (a.z + ab.z * f));
}

/**
 * Who is too near the cast to cast now: a player, or an animal that is someone's (named, tamed, on a lead, by their
 * builds: courtesy.ts someones), within CAST_CLEAR of the line from the eye to the water. Their words, or undefined;
 * words too when who is about could not be read. The bridge looks again before each recast within a call (Interact.java
 * nearCast: players, named, tamed, on a lead), and ends the call `blocked`.
 */
export async function nearCast(ctx: GoalContext, stand: Pos, target: Pos): Promise<string | undefined> {
  const seen = (await ctx.call<{ entities?: (Creature & { position?: Pos })[] }>('world.entities', { maxDistance: 32 }).catch(() => undefined))?.entities;
  // (who is about not read: no cast on a look not had)
  if (!Array.isArray(seen)) return 'could not look round for anyone by the cast';
  const a = { x: stand.x + 0.5, y: stand.y + EYE, z: stand.z + 0.5 }, b = { x: target.x + 0.5, y: target.y + 1, z: target.z + 0.5 };
  for (const e of seen) {
    if (!e.position) continue;
    const theirs = e.name === 'player' || someones(e, ctx.world.yard);
    if (!theirs) continue;
    const d = toSegment(e.position, a, b);
    if (d <= CAST_CLEAR) return `${e.name === 'player' ? 'a player' : `someone's ${e.name}`} ${Math.round(d)} blocks from the cast`;
  }
  return undefined;
}

/**
 * Onto a stand cell, on foot (a careful walk: nothing placed or broken on the way, A11): out of the yard by a gate
 * first when the bot is inside the fence (yardgates.ts), then the walk to the cell itself. The first of three it gets
 * onto; none (`late`) once the walks have left too little of the run for one more and a last slice at the water by
 * `deadline` (three walks of a minute each that stopped short of a bank went on past an evening's 88 s of budget, no
 * cast made); else none at all.
 */
async function toStand(ctx: GoalContext, stands: Pos[], deadline: number, now: () => number): Promise<{ stand?: Pos; late?: true }> {
  const walkMs = () => Math.floor(Math.min(60_000, deadline - now() - LAST_SLICE_MS));
  for (const st of stands.slice(0, 3)) {
    if (walkMs() < STAND_LEAST_MS) return { late: true };
    const here = (await ctx.status().catch(() => undefined))?.position ?? ctx.s.position;
    if (inFence(ctx.world, here) && !inFence(ctx.world, st)) {
      const out = await leaveYard(ctx, st);
      if (out.shut) ctx.progress(`${out.shut}: the walk to the water goes on from here`);
    }
    if (ctx.signal.aborted) throw new Error('aborted');
    const ms = walkMs();
    if (ms < STAND_LEAST_MS) return { late: true };
    const g = await ctx.call<{ arrived?: boolean }>('goto', { ...st, range: 0, careful: true, timeoutMs: ms }, ms + 15_000).catch(() => ({ arrived: false }));
    if (ctx.signal.aborted) throw new Error('aborted');
    if (g.arrived) return { stand: st };
  }
  return {};
}

/**
 * The rung's run: a rod in the pockets, a cast found, the walk to its stand, and then the bridge's `fish` in slices of
 * a minute until the budget is spent, looking round between them: anyone come within CAST_CLEAR of the cast, the
 * pockets full, the rod worn out, two quiet slices, or three let go of an animal end it. Too little of the budget left
 * after the rod for the walk and FISH_LEAST_MS, or before any cast, and it does not fish at all (no dry mark: the
 * water was never tried). Gain is the catches, told slice by slice (a run the brain stops keeps them). The wrapper
 * walks home.
 */
export async function fishRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const rod = await rodToHand(ctx);
  if (rod.why) return { gain: 0, text: rod.why, untried: true };
  const first = rod.how ? `${rod.how}; ` : '';
  // the rod's time (two chests and the table, on foot) came off the run, and the gate's half a minute at the water
  // (fishLate) did not count it: a rod made late in the window left a slice of a few seconds, or none, and the dry
  // mark of a run that never fished kept the rung home two evenings. Not setting out then: the rod stays carried, and
  // the gate says late on the next tick
  if (rod.how) {
    const spent = now() - began;
    if (budgetMs - spent < fishDist(ctx.s, ctx.world) / 3 * SECOND + FISH_LEAST_MS) {
      return { gain: 0, text: `${rod.how}; not setting out: that took ${Math.round(spent / SECOND)} s, too little of the run is left for the walk and ${FISH_LEAST_MS / SECOND} s at the water`, mark: 'forget' };
    }
  }
  const found = await findCast(ctx);
  if (!found.cast) return { gain: 0, text: `${first}${found.text}` };
  const { target, grade } = found.cast;
  const to = await toStand(ctx, found.cast.stands, began + budgetMs, now);
  // (the run's time spent before a stand was got to says nothing of the water: no dry mark)
  if (to.late) return { gain: 0, text: `${first}too little of the run left to reach a stand by the water at ${fmt(target)}`, untried: true };
  const stand = to.stand;
  if (!stand) return { gain: 0, text: `${first}could not get to a stand by the water at ${fmt(target)} on foot (${found.cast.stands.slice(0, 3).map(fmt).join(', ')} tried)` };
  ctx.progress(`fishing at ${fmt(target)} from ${fmt(stand)}: ${GRADE_WORDS[grade]}`);
  const before = await pockets(ctx);
  let bites = 0, open = 0, openKnown = false, quiet = 0, slices = 0, letGoes = 0;
  let why = '';
  const letGo: string[] = [];
  const fishedFrom = now();
  while (true) {
    if (ctx.signal.aborted) throw new Error('aborted');
    const left = budgetMs - (now() - began);
    if (left < LAST_SLICE_MS) {
      // (got to the stand with too little of the run left for a cast: the water was never fished, no dry mark)
      if (!slices) return { gain: 0, text: `${first}too little of the run left to cast at ${fmt(target)} from ${fmt(stand)}`, untried: true };
      break;
    }
    const near = await nearCast(ctx, stand, target);
    if (near) { why = `${near}: no more casts`; break; }
    const items = await pockets(ctx);
    if (!items.some(i => i.name === 'fishing_rod')) { why = 'the rod wore out'; break; }
    // a slot for each bite of the slice: a treasure stacks with nothing, and one fished up into full pockets lies on
    // the shore (the bridge also ends a call with no free slot: `full`)
    const free = 36 - items.length;
    if (free < 1) { why = 'the pockets are full'; break; }
    const ms = Math.floor(Math.min(SLICE_MS, left));
    let r: FishReply;
    try {
      r = await ctx.call<FishReply>('fish', { ...target, times: Math.min(SLICE_BITES, free), timeoutMs: ms }, ms + 20_000);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      why = `the cast failed: ${(e as Error).message.slice(0, 80)}`;
      break;
    }
    slices++;
    const n = Number.isFinite(r.bites) && r.bites > 0 ? r.bites : 0;
    if (Array.isArray(r.letGo)) letGo.push(...r.letGo);
    // a hook let go of an animal ends the jar's call there (an item caught, its own catch flying in, does not): such a
    // slice is no quiet one, the water was hardly fished. Who it was is looked at before the next cast (nearCast)
    const animal = Array.isArray(r.letGo) ? r.letGo.find(e => e !== 'item') : undefined;
    if (n) { bites += n; ctx.gain(n); quiet = 0; letGoes = 0; } else if (animal) {
      if (++letGoes >= LET_GO_SLICES) { why = `the hook keeps catching the ${animal}: no more casts`; break; }
    } else { quiet++; letGoes = 0; }
    if (typeof r.open === 'number' && r.open >= 0) { open += r.open; openKnown = true; }
    if (r.full) { why = 'the pockets are full'; break; }
    if (typeof r.blocked === 'string' && r.blocked) { why = `${r.blocked}: no more casts`; break; }
    if (quiet >= QUIET_SLICES) { why = `no bite in ${Math.round((now() - fishedFrom) / SECOND)} s${r.recalled ? ` (${r.recalled.slice(0, 100)})` : ''}`; break; }
  }
  const secs = Math.round((now() - fishedFrom) / SECOND);
  const after = await pockets(ctx);
  const was = countsOf(before), is = countsOf(after);
  const got: Record<string, number> = {};
  for (const [name, n] of Object.entries(is)) if (n > (was[name] ?? 0)) got[name] = n - (was[name] ?? 0);
  const rods = Math.max(0, enchantedRodsIn(after) - enchantedRodsIn(before));
  // the water fished well at is the rung's from now on: its distance is the variant's, and the next run reads it first
  if (bites) addSite(ctx.world, 'fish', target);
  const where = `at ${fmt(target)} from ${fmt(stand)} (${GRADE_WORDS[grade]})`;
  const opened = openKnown && bites ? `, ${open} in open water` : '';
  const hooked = letGo.length ? `; let go of the ${[...new Set(letGo)].join(', ')} the hook caught` : '';
  // (the run's time ran out after less than FISH_LEAST_MS at the water, a slower walk than the gate's estimate: a bite
  // comes 5 to 35 s after a cast, so no bite then says nothing of the water. No dry mark: it kept the rung home for
  // the next evening)
  const short = !bites && !why && now() - fishedFrom < FISH_LEAST_MS;
  const end = why ? `; ${why}` : short ? `; too short a try to judge the water (under ${FISH_LEAST_MS / SECOND} s)` : '';
  const text = bites ? `${first}${bites} catch(es) in ${secs} s ${where}${opened}: ${catchWords(got, rods) || 'nothing came to the pockets'}${hooked}${end}`
    : `${first}no catch in ${secs} s ${where}${hooked}${end}`;
  return { gain: bites, text, ...(short ? { mark: 'forget' as const } : !bites && why.endsWith(': no more casts') ? { mark: 'same' as const } : {}) };
}
