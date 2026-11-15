/**
 * Ancient debris by its own Nether-side portal and by the known ways of its scouting legs (P3b of the progression
 * plan, stage 2 of the Nether trips, beside the scouting): what the netherite (P6) is made of, mined only under fire
 * resistance.
 *
 * The trip (worktasks.ts NETHER_WORK `debris`, from stage 2 while a potion of fire resistance is in stock: with none
 * the work stays shut and says so): the Nether kit at home, a diamond or netherite pickaxe (ancient debris drops
 * nothing to any other), the potions (one to drink and one more for the Guardian's hook, where the chests hold two: the
 * long ones first, each by its contents), through the home portal into its own hut (anywhere else: the link is broken
 * the one way, as the barter has it: straight back, the setup held a day), and the ground round its portal read. With
 * debris it may mine there, or one a scouting leg saw by the way it walked (a `debris` site with the leg, within 24 of
 * one of the leg's waypoints), it drinks a potion of fire resistance at its portal, in its hut (with nothing to mine,
 * none is drunk: it goes back as it came), and mines:
 * - only debris with a face open to air as the ground read has it, what a player passing would see: no tunnelling
 *   (nothing but the debris is dug). The game never makes debris that touches air (26.3's ore_ancient_debris_large
 *   and _small discard every block of it there), so what it finds is what a ghast's blast or someone's digging bared;
 * - none with lava or fire within 2 of it, nor of the cell it stands on to dig it (fire resistance keeps the burns off,
 *   not the fall into a lava lake, the things it carries, nor the walk back once it has run out);
 * - within 24 of its portal or of the waypoint it walked out to, none more than 4 under that floor (its portal's
 *   bottom row of obsidian, or the waypoint's), nor standing lower; none of its own hut's walls or the ground its
 *   portal stands on; none within 16 of anyone's Nether build or a natural fortress or bastion (and every walk 16 from
 *   them too), none within 2 of a block only a player puts down there; none under a block that falls, no floor over a
 *   hole;
 * - only while the effect has 20 s or more left (the dig and the pickup), looked at before every dig;
 * - at most 4 a trip.
 * Each from a cell a careful walk reaches (nothing broken or placed on the way, never at a drop's edge), with an open
 * face of it in sight and reach, by its own hand (the bridge's dig.here, the pickaxe taken in hand first); what it
 * drops is picked up on foot, never by lava (netherquartz.ts's stance, drop and pickup rules).
 *
 * Out along a way: once round its portal is done, a debris site out by a scouting leg's way is gone to when the trip
 * still has the time for the walk there and back and a barter's worth at it (netherbarter.ts FAR_STEP_MS, FAR_TURN_MS),
 * and the effect the walk out and a dig. The walk follows the leg's waypoints (cells the scouting stood on), the ground
 * read a few waypoints ahead at a time and every leg of it planned by the barter's walking rules (no lava within 2, no
 * drop's edge, 16 from every zone, asked again at every look), 2 from every drop's edge wherever that goes on (by one
 * only with no ghast watched), and comes back along the very cells it walked out; out of the time for the rest of it,
 * it turns back. What is left there to mine is kept as the site, and a site found empty or refused on the fresh look
 * is let go; a way found closed lets go of every debris site of its leg.
 *
 * It stops at the trip's 4 or its time (the way back kept), the effect running low, on any hit taken, a hoglin or a
 * brute near, a ghast within 16 that sees it or a fireball coming at it (the barter's ghast rule, looked for between
 * the legs of every walk too; a ghast further off or behind rock is watched: while one is within 32 the bot walks and
 * digs from no drop's edge within 2, and where only such an edge would do, it goes back as from a danger), the pockets
 * full, the pickaxe gone, or nothing left it may mine; and walks back
 * into its hut and through its own portal. A piglin turned aggressive near it sends it back at once and holds the
 * barter, the quartz, the scouting and the debris for the rest of the game day (netherbarter.ts's hold). Says
 * `nether: mined N ancient debris: M picked up`.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts and netherscout.ts reach it, and this module reaches most of the brain).
 */
import type { InventoryItem, Status } from '../tools.js';
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { homePortal } from './portal.js';
import { freeChestTotals, key, storedStacks, takeFromChests, takeSlot } from './chests.js';
import { NETHER, barterHold, firePotions, gameDay, isFirePotion, netherOf, noteSites, peekNether, portalCells, type Bearing } from './nether.js';
import {
  BACK_MS, FAR_STEP_MS, FAR_TURN_MS, GHAST_WATCH, KNOCK_GAP, LAVA_GAP, backThroughOwn, barterDanger, barterGround, ghastAbout, ghastWatched, lavaBy, overDrop, takesAt,
  toOwnPortal, type Seen
} from './netherbarter.js';
import { DROP_RANGE, HUT_GAP, digStance, dropReach } from './netherquartz.js';
import {
  FROM_BUILDS, GONE, PLACED_GAP, SETUP_HEALTH, SETUP_WAITS, blockAt, boxGap, boxOf, cellOf, fetchSetupKit, footing, inBox, inNether, pathOf, placedIn, readGround,
  setOpen, setupShort, walkAlong, walkFrom, zoneBox, type Box, type Cell, type Grid, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const cellKey = (p: Pos) => `${p.x},${p.y},${p.z}`;
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const add = (p: Pos, dx: number, dy: number, dz: number): Pos => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const floorOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
/** Along the ground, to an item where it lies (not its block). */
const across = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** A standing cell's middle, where the bot's feet are once it is there. */
const middleOf = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const passable = (c: Cell) => c === 'open' || c === 'plant';
const firm = (c: Cell) => c === 'dig' || c === 'solid' || c === 'falls';
/** Seconds as the status line says them: `3:00`. */
const minSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------------------------------------------ the rules

/** The block, and what it drops (itself, to a diamond or netherite pickaxe: no fortune, no silk touch to it). */
export const DEBRIS = 'ancient_debris';
/** How far from its own portal, or from the waypoint of a known way it walked out to, the debris is mined: it and the cells it walks and stands on. */
export const DEBRIS_RADIUS = 24;
/** No debris lower than this under that floor (its portal's bottom row of obsidian, or the waypoint's), and no cell it stands on whose floor is. */
export const DEBRIS_DEPTH = 4;
/** Debris mined on a trip at most. */
export const DEBRIS_TRIP = 4;
/** The debris trip's whole time, from the kit at home to back through its own portal (the barter's), and what it still needs after the kit. */
export const DEBRIS_MAX_MS = 8 * MINUTE;
export const DEBRIS_LEAST_MS = 3 * MINUTE;
/** The effect has this long left before a dig, at the least (the dig, some 6 s with a diamond pickaxe, and the pickup). */
export const EFFECT_LEAST_S = 20;
/** Potions of fire resistance a trip carries at most: one to drink at its portal, one for the Guardian's hook (it drinks one when the bot burns without the effect). */
export const DEBRIS_POTIONS = 2;
/** What a potion gives, s: a plain one 3:00, a long one 8:00 (26.3's Potions). */
export const POTION_S: Readonly<Record<string, number>> = { fire_resistance: 180, long_fire_resistance: 480 };
/** The pickaxes that take debris (a lesser one breaks it and it drops nothing), the best first. */
export const DEBRIS_PICKS = ['netherite_pickaxe', 'diamond_pickaxe'] as const;
/** A pickaxe with fewer uses left than this is not taken for the trip. */
export const PICK_LEAST_USES = 2 * DEBRIS_TRIP;
/** Debris sites a scouting leg keeps (the nearest its way). */
export const DEBRIS_KEPT = 4;
/** The waits, in looks a pollMs apart (a test sets pollMs to nothing; the counts stand): what a dig dropped has a moment to come down. */
export const DEBRIS_WAITS = { pollMs: 500, dropLooks: 2 };
/**
 * The ground read a stretch of a known way at a time: this many waypoints ahead, and round them across (the lava
 * rule's 2 and room to go round), down and up (nothing imported is read at the module's top level: the modules reach
 * each other).
 */
const WAY_AHEAD = 4;
const STRETCH = { across: 8, down: 12, up: 12 } as const;
/** Steps a walk leg on a known way (a look between every two), and the walks planned again on it at most (a ghast come, a mob in the way). */
const STEP = 4;
const WAY_REPLANS = 4;

/** The six faces of a block, as offsets. */
const FACES: readonly [number, number, number][] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/**
 * What one read of the ground round the place it mines holds for the debris: the place (its own portal's box, its
 * inside, or the waypoint's cell) and its floor's height, in words for the lines, its own portal's box (its hut is
 * by it), the zones the bridge's scan has down there, and the blocks only a player puts down there (placedIn).
 */
export interface DebrisView { centre: Box; floor: number; where: string; portal: Box; zones: Box[]; placed: Pos[] }

/**
 * Why a debris may not be mined that the ground alone says, pure, or null: lava or fire within LAVA_GAP of it every
 * way (or the ground there not all read: an unloaded chunk might hold either); within PLACED_GAP of a block someone
 * placed; no face open to air (buried: what no player sees, and the dig would be a tunnel's); under a block that falls;
 * a floor (open over it) with no firm ground under it (the dig would open a hole to a drop or a cave).
 */
function bareFault(g: Grid, p: Pos, placed: Pos[]): string | null {
  let unread = false;
  for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dy = -LAVA_GAP; dy <= LAVA_GAP; dy++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) {
    const c = cellOf(blockAt(g, add(p, dx, dy, dz)));
    if (c === 'hot') return `lava or fire within ${LAVA_GAP}`;
    if (c === 'unknown') unread = true;
  }
  if (unread) return 'the ground round it not all read';
  if (placed.some(c => Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y), Math.abs(c.z - p.z)) <= PLACED_GAP)) return `within ${PLACED_GAP} of a block someone placed`;
  if (!FACES.some(([dx, dy, dz]) => cellOf(blockAt(g, add(p, dx, dy, dz))) === 'open')) return 'no face open to air';
  const over = cellOf(blockAt(g, add(p, 0, 1, 0)));
  if (over === 'falls') return 'under a block that falls';
  if (passable(over) && !firm(cellOf(blockAt(g, add(p, 0, -1, 0))))) return 'a floor over a hole';
  return null;
}

/**
 * Why a debris may not be mined, pure, or null (see the top of the file): no debris there; more than DEBRIS_RADIUS
 * from the place; its hut's (within HUT_GAP of its portal); more than DEBRIS_DEPTH under the place's floor; within
 * FROM_BUILDS of a zone; then what the ground says (bareFault: lava or fire within LAVA_GAP, a block someone placed by
 * it, no face open to air, under a block that falls, a floor over a hole). Judged on the ground as read there.
 */
export function debrisFault(g: Grid, p: Pos, v: DebrisView): string | null {
  if (blockAt(g, p) !== DEBRIS) return 'no ancient debris';
  if (boxGap(v.centre, cellBox(p)) > DEBRIS_RADIUS) return `more than ${DEBRIS_RADIUS} from ${v.where}`;
  if (boxGap(v.portal, cellBox(p)) <= HUT_GAP) return 'its own hut\'s, or the ground its portal stands on';
  if (p.y < v.floor - DEBRIS_DEPTH) return `more than ${DEBRIS_DEPTH} under the floor of ${v.where}`;
  if (v.zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS)) return `within ${FROM_BUILDS} of someone's build`;
  return bareFault(g, p, v.placed);
}

/** The debris of a read that it may mine, pure (each that debrisFault passes), and how many of the others fell to each fault. */
export function debrisSurvey(g: Grid, v: DebrisView): { ores: Pos[]; faults: Map<string, number> } {
  const ores: Pos[] = [];
  const faults = new Map<string, number>();
  for (let iy = 0; iy < g.height; iy++) for (let iz = 0; iz < g.length; iz++) for (let ix = 0; ix < g.width; ix++) {
    const p = { x: g.x + ix, y: g.y + iy, z: g.z + iz };
    if (blockAt(g, p) !== DEBRIS) continue;
    const why = debrisFault(g, p, v);
    if (why) faults.set(why, (faults.get(why) ?? 0) + 1);
    else ores.push(p);
  }
  return { ores, faults };
}

/**
 * The debris of a read that the ground alone lets it mine, pure (bareFault passes: a face open to air, no lava or fire
 * within LAVA_GAP, none placed by it, none under a block that falls, no floor over a hole): what a scouting leg notes
 * as it reads the ground ahead (netherscout.ts), for a debris trip to go to by that leg's way.
 */
export function exposedDebrisIn(g: Grid): Pos[] {
  const out: Pos[] = [];
  let placed: Pos[] | undefined;
  for (let iy = 0; iy < g.height; iy++) for (let iz = 0; iz < g.length; iz++) for (let ix = 0; ix < g.width; ix++) {
    const p = { x: g.x + ix, y: g.y + iy, z: g.z + iz };
    if (blockAt(g, p) !== DEBRIS) continue;
    // (the cobblestone of the read, looked for only once a debris is there: most reads hold none)
    if (!bareFault(g, p, placed ??= placedIn(g))) out.push(p);
  }
  return out;
}

/**
 * The cells the debris trip may walk and stand on round a place, pure: the barter's ground (netherbarter.ts
 * barterGround: FROM_BUILDS from every zone, no lava or fire within LAVA_GAP, at no drop's edge) within DEBRIS_RADIUS
 * of the place, and none whose floor is more than DEBRIS_DEPTH under the place's. Each cell judged once; `forget` lets
 * go of the judgements round a cell the trip dug (its own map of the ground changed there).
 */
export function debrisGround(g: Grid, v: DebrisView): { may: (p: Pos) => boolean; forget: (p: Pos) => void } {
  const judged = new Map<string, boolean>();
  const may = (p: Pos): boolean => {
    const k = cellKey(p);
    let ok = judged.get(k);
    if (ok === undefined) {
      ok = boxGap(v.centre, cellBox(p)) <= DEBRIS_RADIUS && p.y - 1 >= v.floor - DEBRIS_DEPTH && !v.zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) &&
        !lavaBy(g, p) && !overDrop(g, p);
      judged.set(k, ok);
    }
    return ok;
  };
  // (a cell's judgement reads 2 across and 3 under it and the columns open within 2 of it down to their bottom, as the
  // quartz's does: a dug cell is in the judgement of cells 5 round it, and of every cell over it up the read's top)
  const forget = (p: Pos) => {
    for (let dx = -5; dx <= 5; dx++) for (let dy = -5; p.y + dy < g.y + g.height; dy++) for (let dz = -5; dz <= 5; dz++) judged.delete(cellKey(add(p, dx, dy, dz)));
  };
  return { may, forget };
}

/** The box to read round a place (its centre and floor): the radius and the lava rule's 2 round its furthest debris and cell, a block more; down to the lava rule under the lowest; up as high as an eye reaches over the highest cell it may stand on. */
export function placeBox(centre: Box, floor: number): Box {
  const out = DEBRIS_RADIUS + LAVA_GAP + 1;
  return {
    x1: centre.x1 - out, y1: Math.max(1, floor - DEBRIS_DEPTH - LAVA_GAP - 1), z1: centre.z1 - out,
    x2: centre.x2 + out, y2: Math.min(126, floor + 15), z2: centre.z2 + out
  };
}

/** The ground to read for a stretch of a known way: round where it stands and the waypoints ahead (STRETCH across, down and up). */
export function stretchBox(cells: Pos[]): Box {
  const b = boxOf(cells);
  return {
    x1: b.x1 - STRETCH.across, y1: Math.max(1, b.y1 - STRETCH.down - LAVA_GAP - 1), z1: b.z1 - STRETCH.across,
    x2: b.x2 + STRETCH.across, y2: Math.min(126, b.y2 + STRETCH.up), z2: b.z2 + STRETCH.across
  };
}

// ------------------------------------------------------------------------------------------------ the potions and the pickaxe

/** The fire resistance on the bot as a status says it, s (one that never runs out: for ever; none: 0). */
export function fireOf(st: Pick<Status, 'effects'> | undefined): number {
  const e = (st?.effects ?? []).find(x => x.name.replace(/^minecraft:/, '') === 'fire_resistance');
  return !e ? 0 : e.seconds < 0 ? Infinity : e.seconds;
}

/** What a potion of fire resistance gives, s (by its contents: a long one 8:00, the plain 3:00). */
export const potionSeconds = (i: { potion?: string }): number => POTION_S[i.potion ?? ''] ?? POTION_S.fire_resistance;

/** The carried potion of fire resistance it drinks first, pure: the longest (by its contents), then the lowest slot. Undefined with none. */
export function potionToDrink(items: InventoryItem[]): InventoryItem | undefined {
  return items.filter(i => i.slot >= 0 && i.slot < 36 && isFirePotion(i)).sort((a, b) => potionSeconds(b) - potionSeconds(a) || a.slot - b.slot)[0];
}

/** Uses left of a tool (its durability less its wear; one the inventory tells nothing of: for ever). */
const usesLeft = (i: InventoryItem) => (i.maxDamage && i.maxDamage > 0 ? i.maxDamage - (i.damage ?? 0) : Infinity);

/** The carried pickaxe that takes debris, pure: netherite before diamond, the one with the most uses left, PICK_LEAST_USES at least. Undefined with none. */
export function debrisPick(items: InventoryItem[]): InventoryItem | undefined {
  return items.filter(i => i.slot >= 0 && i.slot < 36 && (DEBRIS_PICKS as readonly string[]).includes(i.name) && usesLeft(i) >= PICK_LEAST_USES)
    .sort((a, b) => DEBRIS_PICKS.indexOf(a.name as typeof DEBRIS_PICKS[number]) - DEBRIS_PICKS.indexOf(b.name as typeof DEBRIS_PICKS[number]) || usesLeft(b) - usesLeft(a))[0];
}

// ------------------------------------------------------------------------------------------------ the known ways

/** A debris site out by a scouting leg's way: the leg's bearing and way, the waypoint to walk out to (its index), the site, and the way's blocks to it. */
export interface DebrisWay { bearing: Bearing; way: Pos[]; to: number; site: Pos; blocks: number }

/**
 * The debris site a trip goes to by a known way, pure, or undefined: of the `debris` sites a scouting leg found
 * (world.nether.sites with its leg) further than DEBRIS_RADIUS from its portal (the read round its portal sees those),
 * the ones within DEBRIS_RADIUS of a waypoint of that leg's way as it is kept now (world.nether.legs); each by the
 * waypoint nearest it (the first of a tie); the one of the shortest way there.
 */
export function debrisWay(world: WorldMemory, portal: Box): DebrisWay | undefined {
  const n = peekNether(world);
  let best: DebrisWay | undefined;
  for (const s of n.sites) {
    if (s.kind !== DEBRIS || !s.leg || boxGap(portal, cellBox(s)) <= DEBRIS_RADIUS) continue;
    const leg = (n.legs ?? []).find(l => l.bearing === s.leg);
    if (!leg || leg.way.length < 2) continue;
    const site = { x: s.x, y: s.y, z: s.z };
    let to = -1, gap = Infinity;
    for (let i = 1; i < leg.way.length; i++) {
      const d = boxGap(cellBox(leg.way[i]), cellBox(site));
      if (d < gap) { gap = d; to = i; }
    }
    if (to < 0 || gap > DEBRIS_RADIUS) continue;
    let blocks = 0;
    for (let i = 1; i <= to; i++) blocks += dist3(leg.way[i - 1], leg.way[i]);
    blocks = Math.round(blocks);
    if (!best || blocks < best.blocks) best = { bearing: leg.bearing, way: leg.way.map(p => ({ ...p })), to, site, blocks };
  }
  return best;
}

/** The time a known way of `blocks` takes on foot, ms (the barter's walk past its 48: a careful walk's legs with a look between). */
export const wayMs = (blocks: number): number => blocks * FAR_STEP_MS;

/**
 * The blocks of a known way still to go from where the bot stands to its waypoint `dw.to`, pure: by the nearest of
 * the waypoints from `j` (the next it is to reach) on, and along the way from that one.
 */
export function wayLeft(dw: DebrisWay, j: number, me: Pos): number {
  let best = j > dw.to ? 0 : Infinity, tail = 0;
  for (let i = dw.to; i >= Math.max(j, 0); i--) {
    best = Math.min(best, dist3(me, dw.way[i]) + tail);
    if (i > 0) tail += dist3(dw.way[i - 1], dw.way[i]);
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ the gate

/** The debris work is open from stage 2, its own portal standing and the two sides linked (its potion is its ready's: it says so). */
export function debrisOpen(world: WorldMemory): boolean {
  const n = peekNether(world);
  return n.linked === true && !!n.portal && n.stage >= 2;
}

/** A pickaxe that takes debris, carried or in the chests, pure. */
const pickInStock = (s: Pick<Snapshot, 'items'>, world: WorldMemory): boolean => {
  if (debrisPick(s.items)) return true;
  const free = freeChestTotals(world);
  return DEBRIS_PICKS.some(n => (free[n] ?? 0) > 0);
};

/**
 * Whether the debris trip can set out now, pure: not held (a piglin turned on the bot by its portal today: the
 * barter's hold), a potion of fire resistance in stock to drink (carried or in the chests, by its contents: with none
 * the work is shut, and says so), a diamond or netherite pickaxe (carried or in the chests), not hurt past what the run
 * heals at home, and nothing of the Nether kit short that the chests lack (the setup's own list). The hour is the rung's.
 */
export function debrisReady(s: Snapshot, world: WorldMemory): Decline | null {
  const held = barterHold(world, s.now);
  if (held) return { cause: 'hold', text: `debris held for the day: ${held.why}` };
  if (firePotions(s.items, world) < 1) return { cause: 'kit', text: 'debris shut: no potion of fire resistance in stock (carried or in the chests)' };
  if (!pickInStock(s, world)) return { cause: 'kit', text: 'debris: no diamond or netherite pickaxe (carried or in the chests): ancient debris drops nothing to any other' };
  if (s.health < SETUP_HEALTH) return no.health(s, 'the debris', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `debris: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the trip

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];
const debrisOf = (items: InventoryItem[]) => items.filter(i => i.slot >= 0 && i.slot < 36 && i.name === DEBRIS).reduce((a, i) => a + i.count, 0);
const potionsOf = (items: InventoryItem[]) => items.filter(i => i.slot >= 0 && i.slot < 36 && isFirePotion(i)).reduce((a, i) => a + i.count, 0);
const freeSlots = (items: InventoryItem[]) => 36 - new Set(items.filter(i => i.slot >= 0 && i.slot < 36).map(i => i.slot)).size;

/**
 * The debris trip's own kit, after the Nether kit (fetchSetupKit made its room): a pickaxe that takes debris out of the
 * chests where none is carried, and the potions of fire resistance up to DEBRIS_POTIONS carried, each by its slot in
 * the chest (takeSlot: by its contents, never by its name: every potion is `potion`), the long ones first. Undefined
 * when it has both, else what it is short of.
 */
async function fetchDebrisKit(ctx: GoalContext): Promise<string | undefined> {
  let items = await inventory(ctx);
  if (!debrisPick(items)) {
    for (const name of DEBRIS_PICKS) if (await takeFromChests(ctx, name, 1).catch(() => 0)) break;
    items = await inventory(ctx);
    if (!debrisPick(items)) return 'no diamond or netherite pickaxe (ancient debris drops nothing to any other)';
  }
  let have = potionsOf(items);
  if (have < DEBRIS_POTIONS) {
    // (the chests' memory looked at afresh before each take: a take opens its chest and remembers it anew, and a
    // stack listed before then may sit in another slot of that memory now)
    const tried = new Set<string>();
    for (let i = 0; i < 2 * DEBRIS_POTIONS && have < DEBRIS_POTIONS && !ctx.signal.aborted; i++) {
      const f = storedStacks(ctx.world, isFirePotion).filter(x => !tried.has(`${key(x.chest)} ${x.stack.slot}`))
        .sort((a, b) => potionSeconds(b.stack) - potionSeconds(a.stack))[0];
      if (!f) break;
      tried.add(`${key(f.chest)} ${f.stack.slot}`);
      have += await takeSlot(ctx, f.chest, f.stack.slot, Math.min(f.stack.count, DEBRIS_POTIONS - have)).catch(() => 0);
    }
    have = potionsOf(await inventory(ctx));
  }
  if (ctx.signal.aborted) throw new Error('aborted');
  return have < 1 ? 'no potion of fire resistance came out of the chests' : undefined;
}

/** A place it mines at: the ground read there, what it may mine there, the ground it may walk, the cell it goes back to from there, the time the way home from there takes. */
interface Place { g: Grid; view: DebrisView; ground: ReturnType<typeof debrisGround>; ores: Pos[]; faults: Map<string, number>; stand: Pos; backMs: number }

/**
 * The debris trip (see the top of the file). From home with the Nether kit, the pickaxe and a potion (or it does not
 * set out: untried), through the home portal into its own hut, a potion drunk there once it has something to mine,
 * out on foot round its portal and along a known way, and back through its own portal at the end; `nether: mined N
 * ancient debris: M picked up` said once it is done. Gain: the debris it brought back. Out of the Nether halfway (a
 * death), it stops at once and writes nothing more.
 */
export async function debrisRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, DEBRIS_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to mine by', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  const short = await fetchDebrisKit(ctx);
  if (short) return { gain: 0, text: `not setting out: ${short}`, untried: true };
  if (left() < DEBRIS_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the debris trip's ${DEBRIS_MAX_MS / MINUTE} min is left`, untried: true };
  }
  const to = await toOwnPortal(ctx, home, own, now, 'debris');
  if ('result' in to) return to.result;
  const { arrived, homeShape } = to;
  if (left() <= BACK_MS) return { gain: 0, text: `out of the debris trip's ${DEBRIS_MAX_MS / MINUTE} min on the way down: no debris` };

  // ---- the ground round its portal (the bridge's scan follows the protection sync: a moment), then the zones down
  // there, asked once the read is in (the bridge's scan reads loaded chunks only) and again at every look (its scan
  // follows the bot, 48 round it, and a known way goes out 96). Every zone seen on the trip is kept (one gone from a
  // later scan is still someone's); the ground it may walk follows them
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const pb = boxOf(portalCells(arrived));
  /** the ground as last read (round its portal, a stretch of a known way, round a waypoint): the looks' ghast sight goes by it */
  let g = await readGround(ctx, placeBox(pb, pb.y1 - 1));
  const seenZones = new Map<string, Box>();
  let zones: Box[] = [];
  /** the place it mines at (round its portal first), and the ground of the stretch of a known way it walks: judged anew as zones come in */
  let place: Place | undefined;
  /** round its portal: the ground read on arrival (the way back to its hut's cell goes over it) */
  let atPortal: Place | undefined;
  let wayMay: ((p: Pos) => boolean) | undefined;
  const placeAt = (grid: Grid, centre: Box, floor: number, where: string, stand: Pos, backMs: number): Place => {
    const view: DebrisView = { centre, floor, where, portal: pb, zones, placed: placedIn(grid) };
    return { g: grid, view, ground: debrisGround(grid, view), ...debrisSurvey(grid, view), stand, backMs };
  };
  const again = (p: Place) => placeAt(p.g, p.view.centre, p.view.floor, p.view.where, p.stand, p.backMs);
  /** The bridge's zones down there added to those seen: false when it did not answer. */
  const askZones = async (): Promise<boolean> => {
    const r = await ctx.call<{ zones?: NetherZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => undefined);
    if (!r) return false;
    let more = false;
    for (const z of (r.zones ?? []).map(zoneBox)) {
      const k = `${z.x1},${z.y1},${z.z1},${z.x2},${z.y2},${z.z2}`;
      if (!seenZones.has(k)) { seenZones.set(k, z); more = true; }
    }
    if (more) {
      zones = [...seenZones.values()];
      // (round its portal, the place it mines at is the one the way back to its hut's cell goes over too)
      if (place) { const was = place; place = again(place); if (was === atPortal) atPortal = place; }
      if (wayMay) wayMay = barterGround(g, pb, zones, Infinity);
    }
    return true;
  };
  // (no word of the builds down there: no rule of 16 from them to dig and walk by. Back through its portal, from where
  // it stands by it)
  if (!(await askZones())) {
    const b = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no debris mined: the bridge did not say where the builds down there are; ${b.text}`, mark: 'same', ...(b.cameBack ? { cameBack: true as const } : {}) };
  }
  const st0 = await ctx.status().catch(() => undefined);
  const start = footing(g, st0?.position ?? to.me);
  if (!start) return { gain: 0, text: `no ground to stand on by its portal at nether ${fmt(arrived)}: no debris` };
  atPortal = placeAt(g, pb, pb.y1 - 1, 'its portal', start, BACK_MS);
  place = atPortal;

  // ---- the looks: where it stands, what is round it, what would send it back (the barter's rules), the effect on it
  let health = st0?.health ?? 20;
  let me: Pos = st0?.position ?? to.me;
  let fire = fireOf(st0);
  let ents: Seen[] = [];
  let stop: string | undefined;
  let angry: string | undefined;
  /** turned back before it learnt anything of the debris there (a danger, the potion that did not take): no dry mark grows */
  let unlearnt = false;
  let gone = false;
  /** a ghast within GHAST_WATCH at the last look: the ground it walks and digs from keeps KNOCK_GAP from drops */
  let watched = false;
  const knockSafe = (grid: Grid, p: Pos) => !watched || !overDrop(grid, p, KNOCK_GAP);
  /** the ground it may walk where it is (a stretch of a known way, or round the place it mines), with no ghast about */
  const plainMay = (p: Pos) => (wayMay ? wayMay(p) : place!.ground.may(p));
  const walkable = (p: Pos) => plainMay(p) && knockSafe(g, p);
  /** A look round (between the legs of every walk too): false when something sends it back (`stop` says what) or it is out of the Nether (`gone`). */
  const watch = async (): Promise<boolean> => {
    if (ctx.signal.aborted) throw new Error('aborted');
    const st = await ctx.status().catch(() => undefined);
    if ((st?.dimension ?? NETHER) !== NETHER) { gone = true; return false; }
    me = st?.position ?? me;
    if (st) fire = fireOf(st);
    await askZones();
    ents = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64 }).catch(() => ({ entities: [] as Seen[] }))).entities ?? [];
    const was = health;
    health = st?.health ?? health;
    watched = ghastWatched(ents);
    const d = barterDanger(ents, health, was, { g, me });
    if (d) { stop = d.why; unlearnt = true; if (d.angry) angry = d.why; return false; }
    if (st?.onFire) { stop = 'on fire'; unlearnt = true; return false; }
    return true;
  };
  /**
   * Between the legs of a walk: a look round, and with a ghast come within GHAST_WATCH since it set out or a zone come
   * in, the rest of the way still on ground it may walk (false with nothing set: the walk is planned again).
   */
  const onTheWay = (path: Pos[]) => {
    const calm = !watched, was = zones;
    return async () => (await watch()) && ((zones === was && (!calm || !watched)) || path.slice(1).every(p => walkable(p)));
  };
  const reachFrom = (ok: (p: Pos) => boolean = walkable) => {
    const here = footing(g, me);
    if (!here) return new Map<string, { from: string | null; n: number }>();
  // (with a ghast watched, the cell it stands on at a drop's edge (a walk planned before it came ended there) is no
  // place to dig, toss or pick up from: only the way off it. The search keeps its start whatever the rule, so the plan
  // made again would pick that very cell, n 0, and the check after the walk let the thing be)
    const reach = walkFrom(g, [here], ok);
    if (watched && !ok(here)) reach.delete(cellKey(here));
    return reach;
  };

  /** What a dig dropped (new items within DROP_RANGE of the debris) picked up on foot, never by lava: false when sent back. */
  const pickUp = async (around: Pos, before: Set<number>): Promise<boolean> => {
    const passed = new Set<number>();
    const waited = new Set<number>();
    for (let round = 0; round < 6; round++) {
      if (!(await watch())) return false;
      const next = ents.filter(e => e.name === 'item' && (e.item ?? DEBRIS) === DEBRIS && !before.has(e.id) && !passed.has(e.id) && dist3(e.position, around) <= DROP_RANGE)
        .sort((a, b) => dist3(a.position, me) - dist3(b.position, me))[0];
      if (!next) return true;
      // (in reach of the pickup where it stands: a look more; still lying there after it, a cell to take it from)
      if (takesAt(me, next.position) && !waited.has(next.id)) { waited.add(next.id); await pause(DEBRIS_WAITS.pollMs); continue; }
      const reach = reachFrom();
      const c = floorOf(next.position);
      let best: { p: Pos; n: number } | undefined;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 0; dy++) {
        const q = add(c, dx, dy, dz);
        const r = reach.get(cellKey(q));
        if (r && across(middleOf(q), next.position) <= 1.2 && takesAt(middleOf(q), next.position) && (!best || r.n < best.n)) best = { p: q, n: r.n };
      }
      // (in a hole it cannot stand by, by lava, at a drop's edge, or where it stands already: left where it lies)
      if (!best || best.n === 0) { passed.add(next.id); continue; }
      const way = pathOf(reach, best.p);
      const w = await walkAlong(ctx, way, STEP, onTheWay(way));
      if (w === 'gone') { gone = true; return false; }
      if (w === 'back') { if (stop || gone) return false; continue; }
      if (w === 'stuck') passed.add(next.id);
    }
    return true;
  };

  // ---- the mining at a place: the debris of fewest steps to a place to dig it from, then the next
  const tried = new Set<string>();
  /** debris whose walk was planned again (a ghast come near): once each */
  const replanned = new Set<string>();
  let dug = 0;
  let refused = 0;
  let got = 0;
  const startDebris = debrisOf(await inventory(ctx));
  /** The debris come into the pockets since the start that is not booked yet, booked. */
  const book = (items: InventoryItem[]) => {
    const more = debrisOf(items) - startDebris - got;
    if (more > 0) { got += more; ctx.gain(more); }
  };
  /** The debris at a place it may mine and dig from a cell a walk reaches (with what it drops in reach), not tried yet, the fewest steps first. */
  const targets = (p: Place, reach: Map<string, { from: string | null; n: number }>) =>
    p.ores.filter(o => !tried.has(cellKey(o))).flatMap(ore => {
      const st = digStance(p.g, reach, ore);
      return st && dropReach(p.g, reach, ore) ? [{ ore, ...st }] : [];
    }).sort((a, b) => a.n - b.n);
  /** Why a place has nothing more for it: none left it may mine, none in sight of ground it may stand on, or none at all (and the most common faults). */
  const doneAt = (p: Place) => {
    const faults = [...p.faults].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(', ');
    return p.ores.some(o => tried.has(cellKey(o))) ? `no more ancient debris it may mine within ${DEBRIS_RADIUS} of ${p.view.where}`
      : p.ores.length ? `none of the ${p.ores.length} ancient debris it may mine within ${DEBRIS_RADIUS} of ${p.view.where} in sight of ground it may stand on`
        : `no ancient debris it may mine within ${DEBRIS_RADIUS} of ${p.view.where}${faults ? ` (${faults})` : ''}`;
  };
  /**
   * With a ghast watched and nothing it may mine from ground 2 from a drop's edge, whether the plain ground has some:
   * then the ghast keeps the bot off it, not the place, and the trip ends as a danger's does (no dry mark grows as for
   * a place found empty): `stop` says so.
   */
  const ghastKeepsOff = (p: Place): boolean => {
    if (!watched || !targets(p, reachFrom(plainMay)).length) return false;
    stop = `${ghastAbout(ents)}: the ancient debris only from a drop's edge`;
    unlearnt = true;
    return true;
  };
  const effectLow = () => (fire > 0 ? `the fire resistance running out (${Math.round(fire)} s left)` : 'no fire resistance on it');
  /** Mine at the place: undefined once something ends the trip (`stop`, `gone`), else why the place has no more for it. */
  const mineAt = async (): Promise<string | undefined> => {
    while (!stop && !gone) {
      const p = place!;
      if (dug >= DEBRIS_TRIP) { stop = `the trip's ${DEBRIS_TRIP} debris mined`; break; }
      if (left() < p.backMs) { stop = 'the debris trip\'s time is up'; break; }
      if (!(await watch())) break;
      if (fire < EFFECT_LEAST_S) { stop = effectLow(); break; }
      const items = await inventory(ctx);
      book(items);
      if (freeSlots(items) < 1) { stop = 'pockets full (36/36 slots)'; break; }
      if (!debrisPick(items)) { stop = 'no diamond or netherite pickaxe left'; break; }
      const reach = reachFrom();
      const target = targets(place!, reach)[0];
      if (!target) return ghastKeepsOff(place!) ? undefined : doneAt(place!);
      const k = cellKey(target.ore);
      tried.add(k);
      const way = pathOf(reach, target.at);
      const walked = await walkAlong(ctx, way, STEP, onTheWay(way));
      if (walked === 'gone') { gone = true; break; }
      // (a ghast come within GHAST_WATCH with a drop's edge ahead, or a zone come in: the debris tried again from a place
      // planned anew, once; a second time, let be)
      const retry = () => { if (!replanned.has(k)) { replanned.add(k); tried.delete(k); } };
      if (walked === 'back') { if (stop || gone) break; retry(); continue; }
      if (walked === 'stuck') continue;
      if (!(await watch())) break;
      // (and come so on the last leg, the bot at a drop's edge: no dig from there, a place off it first)
      const here = footing(g, me);
      if (watched && here && overDrop(g, here, KNOCK_GAP)) { retry(); continue; }
      // (the effect looked at again by the debris itself: the walk to it took its share)
      if (fire < EFFECT_LEAST_S) { stop = effectLow(); break; }
      // the pickaxe in hand: the bridge's dig.here holds the hotbar's best for the block, and a diamond pickaxe left in
      // the backpack is no choice of its: the debris dug by another drops nothing
      const pick = debrisPick(await inventory(ctx));
      if (!pick) { stop = 'no diamond or netherite pickaxe left'; break; }
      const held = await ctx.call('item.select', { name: pick.name, slot: pick.slot }).then(() => true, () => false);
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!held) { stop = `could not take the ${pick.name} in hand`; break; }
      const before = new Set(ents.filter(e => e.name === 'item').map(e => e.id));
      const r = await ctx.call<{ dug?: boolean; reason?: string }>('dig.here', { ...target.ore, timeoutMs: 20_000 }, 30_000)
        .catch((e: Error) => ({ dug: false, reason: e.message }));
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!r?.dug) {
        // (dug by someone since the read: open now. Out of sight after all, someone's, a timeout: said once, let be)
        if (r?.reason === 'air') { setOpen(p.g, target.ore); p.ground.forget(target.ore); continue; }
        if (!refused) ctx.progress(`debris: could not dig the ancient debris at nether ${fmt(target.ore)}: ${(r?.reason ?? 'no answer').slice(0, 100)}`);
        refused += 1;
        continue;
      }
      dug += 1;
      setOpen(p.g, target.ore);
      p.ground.forget(target.ore);
      // ---- what it dropped: a moment for it to come down, then picked up on foot
      let back = false;
      for (let i = 0; i < DEBRIS_WAITS.dropLooks && !back; i++) {
        await pause(DEBRIS_WAITS.pollMs);
        back = !(await watch());
      }
      if (back) break;
      const ok = await pickUp({ x: target.ore.x + 0.5, y: target.ore.y, z: target.ore.z + 0.5 }, before);
      book(await inventory(ctx));
      if (!ok) break;
    }
    return undefined;
  };

  // ---- the known way: out along a scouting leg's waypoints, the ground read a few ahead at a time, every walk on it
  // planned by the barter's rules; the cells it walked out are the way back
  const walked: Pos[] = [];
  /** out at a known way's waypoint, mining round it */
  let outThere = false;
  /**
   * A walk out along a path, STEP steps at a time: before each leg after the first, a look (what sends it back:
   * `back`), the time (`late`: out of it, `back`), and the rest of the way still on ground it may walk (a zone come in
   * since it set out, or a ghast come within GHAST_WATCH with a drop's edge on the way: `back` with nothing set, and
   * the walk is planned again). The cells of every leg it arrived at are the way it walked.
   */
  const walkOut = async (path: Pos[], late: () => boolean): Promise<'ok' | 'stuck' | 'gone' | 'back'> => {
    const was = zones, calm = !watched;
    for (let i = 0; i < path.length - 1;) {
      const j = Math.min(i + STEP, path.length - 1);
      if (i > 0) {
        if (!(await watch())) return 'back';
        if (late()) return 'back';
        if ((zones !== was || (calm && watched)) && !path.slice(i + 1).every(walkable)) return 'back';
      }
      const r = await walkAlong(ctx, path.slice(i, j + 1), STEP);
      if (r !== 'ok') return r;
      for (const c of path.slice(i + 1, j + 1)) walked.push(c);
      i = j;
    }
    return 'ok';
  };
  /** Out along a known way to its waypoint `to`, from its hut's cell: undefined there (or once something ends the trip), else why it went no further. */
  const outAlong = async (dw: DebrisWay): Promise<string | undefined> => {
    walked.push(start);
    let j = 1, tries = 0;
    /**
     * Out of the time to go on: the rest of the way there, a dig, and the way back from there (the cells walked, and
     * the rest of the way again). `fits` asked once, as it set out; a walk leg that does not arrive may take a goto's
     * 45 s, and it tries five, and past the trip's 8 min the rung's timeout would leave the way home to leave nether's
     * free walk, outside these rules. Back then, the site kept (nothing was learnt of it): `stop` says so.
     */
    const late = () => {
      if (left() >= wayMs(walked.length + 2 * wayLeft(dw, j, me)) + FAR_TURN_MS + BACK_MS) return false;
      stop = `the debris trip's time is up on the ${dw.bearing} way`;
      unlearnt = true;
      return true;
    };
    while (j <= dw.to) {
      if (!(await watch())) return undefined;
      if (late()) return undefined;
      const ahead = dw.way.slice(j, Math.min(dw.to, j + WAY_AHEAD - 1) + 1);
      g = await readGround(ctx, stretchBox([floorOf(me), ...ahead]));
      if (ctx.signal.aborted) throw new Error('aborted');
      const may = barterGround(g, pb, zones, Infinity);
      wayMay = may;
      const here = footing(g, me);
      if (!here) return `no ground under it on the ${dw.bearing} way at nether ${fmt(me)}`;
      // the furthest waypoint ahead a walk reaches over ground 2 from every drop's edge: the way back is the cells it
      // walks, walked blind, and a ghast come by then finds it at no edge a blast could throw it off. Where none, over
      // the plain ground; but not with a ghast watched: back as from a danger then, the site kept (the ghast closed the
      // way, not the ground)
      const furthestOf = (reach: Map<string, { from: string | null; n: number }>) => {
        for (let i = ahead.length - 1; i >= 0; i--) if (reach.has(cellKey(ahead[i]))) return i;
        return -1;
      };
      let reach = walkFrom(g, [here], p => may(p) && !overDrop(g, p, KNOCK_GAP));
      let k = furthestOf(reach);
      if (k < 0) {
        reach = walkFrom(g, [here], may);
        k = furthestOf(reach);
        if (k < 0) return `the ${dw.bearing} way closed by nether ${fmt(ahead[0])}`;
        if (watched) { stop = `${ghastAbout(ents)}: the ${dw.bearing} way on only by a drop's edge`; unlearnt = true; return undefined; }
      }
      const w = await walkOut(pathOf(reach, ahead[k]), late);
      if (w === 'gone') { gone = true; return undefined; }
      if (w === 'back' && (stop || gone)) return undefined;
      if (w !== 'ok') { if (++tries > WAY_REPLANS) return `stuck on the ${dw.bearing} way by nether ${fmt(ahead[0])}`; continue; }
      j += k + 1;
    }
    return undefined;
  };
  /**
   * Back to its hut's cell from where it is: out by a known way, first to the waypoint (on the ground read round it,
   * where it mined), then back along the cells it walked out (from the one nearest where it stands; a leg that did not
   * arrive, once more); round its portal, over the ground read there (keeping from drops' edges while a ghast is
   * watched, where there is such a way; else the plain ground's). `none`: no way on foot.
   */
  const toHutCell = async (): Promise<'ok' | 'stuck' | 'gone' | 'none'> => {
    if (walked.length > 1) {
      if (outThere && place) {
        const st = await ctx.status().catch(() => undefined);
        me = st?.position ?? me;
        const p = place, wp = p.stand, here = footing(p.g, me);
        if (here && !same(here, wp)) {
          // (keeping from drops' edges while a ghast is watched, where there is such a way; else the plain ground's, as
          // round its portal)
          const toWp = (ok: (c: Pos) => boolean) => walkFrom(p.g, [here], c => same(c, wp) || ok(c));
          let reach = toWp(c => p.ground.may(c) && knockSafe(p.g, c));
          if (!reach.has(cellKey(wp)) && watched) reach = toWp(p.ground.may);
          if (!reach.has(cellKey(wp))) return 'none';
          const r = await walkAlong(ctx, pathOf(reach, wp), STEP);
          if (r === 'gone') return 'gone';
        }
      }
      const path = [...walked].reverse();
      let r: 'ok' | 'stuck' | 'gone' | 'back' = 'stuck';
      for (let i = 0; i < 2 && r === 'stuck'; i++) {
        const st = await ctx.status().catch(() => undefined);
        const p = floorOf(st?.position ?? me);
        const from = path.reduce((best, c, n) => (dist3(c, p) < dist3(path[best], p) ? n : best), 0);
        r = await walkAlong(ctx, path.slice(from), STEP);
      }
      walked.length = 0;
      outThere = false;
      // (back over the ground round its portal: the looks' sight and the last steps go by it, with every zone seen)
      g = atPortal!.g;
      wayMay = undefined;
      place = atPortal = again(atPortal!);
      if (r === 'gone') return 'gone';
      if (r !== 'ok') return 'stuck';
    }
    const st = await ctx.status().catch(() => undefined);
    if ((st?.dimension ?? NETHER) !== NETHER) return 'gone';
    me = st?.position ?? me;
    const p = atPortal!, here = footing(p.g, me);
    if (!here) return 'none';
    if (same(here, start)) return 'ok';
    const wayBack = (ok: (c: Pos) => boolean) => walkFrom(p.g, [here], c => same(c, start) || ok(c));
    let way = wayBack(c => p.ground.may(c) && knockSafe(p.g, c));
    if (!way.has(cellKey(start)) && watched) way = wayBack(p.ground.may);
    if (!way.has(cellKey(start))) return 'none';
    const r = await walkAlong(ctx, pathOf(way, start), STEP);
    return r === 'gone' ? 'gone' : r === 'ok' ? 'ok' : 'stuck';
  };
  /** The known way's debris, when the trip has the time for the way there and back and a dig, and the effect (`seconds`) lasts out the walk out and a dig. */
  const fits = (dw: DebrisWay | undefined, seconds: number): DebrisWay | undefined =>
    dw && left() >= 2 * wayMs(dw.blocks) + FAR_TURN_MS + BACK_MS && seconds >= wayMs(dw.blocks) / 1000 + EFFECT_LEAST_S ? dw : undefined;
  const tooFar = (dw: DebrisWay) => `the ancient debris by the ${dw.bearing} way at nether ${fmt(dw.site)} too far for the time left`;

  // ---- what there is to mine: round its portal, and out by a known way. With nothing, no potion drunk: back as it came
  const far = debrisWay(world, pb);
  /** why round its portal, and the known way, had no more for it */
  let nearEnd: string | undefined;
  let wayEnd: string | undefined;
  let near = 0;
  let farOk: DebrisWay | undefined;
  const potion = potionToDrink(await inventory(ctx));
  if (await watch()) {
    near = targets(atPortal!, reachFrom()).length;
    farOk = fits(far, Math.max(fire, potion ? potionSeconds(potion) : 0));
    if (!near && !farOk && !ghastKeepsOff(atPortal!)) {
      nearEnd = doneAt(atPortal!);
      stop = far ? `${nearEnd}; ${tooFar(far)}` : `${nearEnd}, and none known by a scouted way`;
    }
  }
  // ---- the drink, at its portal in its hut: the debris is mined only with the effect on it (the Guardian's hook
  // drinks the second carried, if it comes to burn without it). Not with a ghast about: one behind the hut's wall is
  // watched, not fled, and comes in sight a few steps out, and the potion (none in stock on Nov 15, a barter's 1 in
  // 57) would go for nothing; the trip is given back
  const ghast = ents.filter(e => e.name === 'ghast' && e.distance <= GHAST_WATCH).sort((a, b) => a.distance - b.distance)[0];
  if (!stop && !gone && fire < EFFECT_LEAST_S + (farOk ? wayMs(farOk.blocks) / 1000 : 0)) {
    if (!potion) { stop = 'no potion of fire resistance carried'; unlearnt = true; }
    else if (ghast) { stop = `a ghast about (${Math.round(ghast.distance)} off): no potion drunk for a trip it may cut short`; unlearnt = true; }
    else {
      const held = await ctx.call('item.select', { name: potion.name, slot: potion.slot }).then(() => true, () => false);
      if (ctx.signal.aborted) throw new Error('aborted');
      const r = held ? await ctx.call<{ finished?: boolean }>('use', {}, 15_000).catch(() => ({ finished: false })) : undefined;
      if (ctx.signal.aborted) throw new Error('aborted');
      fire = fireOf(await ctx.status().catch(() => undefined));
      if (fire <= 0) {
        stop = `the potion of fire resistance did not take${!held ? ' (not taken in hand)' : r?.finished === false ? ' (not drunk)' : ''}`;
        unlearnt = true;
      } else ctx.progress(`debris: drank a potion of ${potion.potion} at its portal at nether ${fmt(arrived)}: ${minSec(fire)} of fire resistance`);
    }
  }
  // ---- round its portal
  if (!stop && !gone && near) nearEnd = await mineAt();
  // ---- out by a known way: back to its hut's cell first (the way starts there), out along it to the waypoint by the
  // site, the ground read round that, the debris there mined; what is left there to mine kept as the site, the rest
  // let go
  if (!stop && !gone && far) {
    const dw = fits(far, fire);
    if (!dw) wayEnd = tooFar(far);
    else {
      const back = await toHutCell();
      if (back === 'gone') gone = true;
      else if (back !== 'ok') wayEnd = `no way on foot back to its hut to set out along the ${dw.bearing} way`;
      else if (!stop) {
        ctx.progress(`debris: out along the ${dw.bearing} way (${dw.blocks} blocks) to nether ${fmt(dw.way[dw.to])} for the ancient debris at nether ${fmt(dw.site)}`);
        wayEnd = await outAlong(dw);
        if (wayEnd && !stop && !gone) {
          // the way closed since the leg walked it (lava come across it, a zone, a walk that would not go): every debris
          // site of that leg's way lies past it, and each would cost a potion a trip to find it so. Let go (the next
          // scouting of the bearing, a day on, finds what is there again)
          const n = netherOf(world);
          n.sites = n.sites.filter(s => !(s.kind === DEBRIS && s.leg === dw.bearing));
        } else if (!wayEnd && !stop && !gone) {
          const wp = dw.way[dw.to];
          const centre = cellBox(wp);
          const box = placeBox(centre, wp.y - 1);
          g = await readGround(ctx, box);
          if (ctx.signal.aborted) throw new Error('aborted');
          wayMay = undefined;
          place = placeAt(g, centre, wp.y - 1, `the ${dw.bearing} way's waypoint`, wp, wayMs(dw.blocks) + BACK_MS);
          outThere = true;
          wayEnd = await mineAt();
          const p = place;
          const still = targets(p, walkFrom(p.g, [wp], c => p.ground.may(c))).map(t => t.ore).filter(o => debrisFault(p.g, o, p.view) === null);
          const n = netherOf(world);
          n.sites = n.sites.filter(s => !(s.kind === DEBRIS && inBox(box, s)));
          if (still.length) noteSites(world, still.map(o => ({ kind: DEBRIS, ...o, leg: dw.bearing })), now());
        }
      }
    }
  }

  // ---- done: said, and back into the hut (along the cells walked out, where it went out) and through its own portal
  if (!gone) book(await inventory(ctx));
  const did = dug ? `mined ${dug} ancient debris: ${got} picked up${refused ? ` (${refused} it could not dig)` : ''}` : `no ancient debris mined${refused ? ` (${refused} it could not dig)` : ''}`;
  if (dug) ctx.progress(`nether: mined ${dug} ancient debris: ${got ? `${got} picked up` : 'nothing picked up'}`);
  const work = dug ? { worked: true as const } : {};
  if (gone || !(await inNether(ctx))) return { gain: got, text: dug ? `${did}; ${GONE.text}` : GONE.text, ...work };
  if (angry) {
    (netherOf(world).barter ??= {}).held = { day: gameDay(world), at: now(), why: angry.slice(0, 160) };
    ctx.progress(`nether: ${angry}: back to its portal, the barter, the quartz, the scouting and the debris held for the day`);
  }
  const why = `${stop ?? ([nearEnd, wayEnd].filter(Boolean).join('; ') || 'done')}${angry ? ', the barter, the quartz, the scouting and the debris held for the day' : ''}`;
  // (turned back before a debris by what says nothing of the debris there: the wrapper's dry mark must not grow 20,
  // 40, 80, 160 min as for a place found empty: it stays as it was, 20 min at least. A debris mined is the trip's work:
  // only then does it count for the stages)
  const mark = { ...(unlearnt && !dug ? { mark: 'same' as const } : {}), ...work };
  const w = await toHutCell();
  if (w === 'gone') return { gain: got, text: `${did}; ${GONE.text}`, ...work };
  if (w !== 'ok') return { gain: got, text: `${did}; ${why}; ${w === 'stuck' ? 'stuck on the way back to its hut' : 'no way back on foot to its hut'}`, ...mark };
  const b = await backThroughOwn(ctx, arrived, homeShape, now);
  return { gain: got, text: `${did}; ${why}; ${b.text}`, ...mark, ...(b.cameBack ? { cameBack: true as const } : {}) };
}
