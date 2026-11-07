/**
 * Manners on a shared world (a friend's server; villages anywhere): what isn't the bot's. The client mod finds other
 * players' builds round the bot (zones of the blocks only a player puts down: planks, glass, doors, chests, crops...)
 * and keeps Baritone from breaking anything in them; these are the brain's side of it: the animals that are someone's,
 * the landmarks it mustn't adopt (a friend's chest near home is not home storage), and the places it mustn't settle.
 */

/** An animal as world.entities reports it, with the marks of an owner. */
export interface Creature {
  id: number;
  name: string;
  distance: number;
  /** a name tag */
  named?: boolean;
  /** tamed (a dog, a cat, a horse with a rider's saddle) */
  tamed?: boolean;
  /** on a lead */
  leashed?: boolean;
  /** inside someone else's build (a friend's pen) */
  foreign?: boolean;
  /** how far it is from the nearest of someone else's builds */
  buildDistance?: number;
  position?: { x: number; y: number; z: number };
}

/** How far from anyone's build an animal must be for the bot to hunt it (a friend's cows graze round their farm). */
export const WILD_DISTANCE = 24;
/** How far from anyone's build on the surface home must be, and from the world spawn (a server's spawn protection is 16 round it). */
export const HOME_FROM_BUILDS = 48;
export const HOME_FROM_SPAWN = 24;
/** How far from anything built under ground (mostly mineshafts and dungeons, now and then someone's cellar). */
export const HOME_FROM_UNDERGROUND = 16;
/** How near a build on the surface the yard may grow (its fence a good way off a friend's outermost block). */
export const YARD_FROM_BUILDS = 16;

/**
 * Someone's animal: named, tamed or on a lead anywhere; in their pen or near their builds (theirs, most likely), unless
 * it's in the bot's own yard: its own pens may end up within 24 blocks of a friend's build, and stay its own.
 */
export function someones(e: Creature, yard?: { x1: number; z1: number; x2: number; z2: number }): boolean {
  if (e.named || e.tamed || e.leashed) return true;
  const p = e.position;
  if (yard && p && p.x >= yard.x1 && p.x < yard.x2 + 1 && p.z >= yard.z1 && p.z < yard.z2 + 1) return false;
  return !!(e.foreign || (e.buildDistance !== undefined && e.buildDistance < WILD_DISTANCE));
}

/**
 * Someone else's build as the mod reports it: its box (with a margin), and whether it's on the surface (a house, a farm,
 * a village) or under ground (a mineshaft, a dungeon, a cellar). Older mods leave `surface` out: count those as surface.
 */
export interface Zone {
  x1: number; y1: number; z1: number; x2: number; y2: number; z2: number;
  markers?: number;
  surface?: boolean;
  /** its commonest marker block */
  sample?: string;
  /** its commonest marker blocks, "name xN" */
  kinds?: string[];
}

/** Straight-line distance from a block to a zone's box (0 inside): a mineshaft 80 blocks under the yard is far off. */
export function zoneDistance(p: { x: number; y: number; z: number }, zn: Zone): number {
  return Math.hypot(Math.max(0, zn.x1 - p.x, p.x - zn.x2), Math.max(0, zn.y1 - p.y, p.y - zn.y2), Math.max(0, zn.z1 - p.z, p.z - zn.z2));
}

/** The nearest zone of a kind (surface or under ground) from a block, and how far (Infinity with none). */
export function nearestZone(p: { x: number; y: number; z: number }, zones: Zone[], surface: boolean): { zone?: Zone; distance: number } {
  let best: { zone?: Zone; distance: number } = { distance: Infinity };
  for (const zn of zones) {
    if ((zn.surface ?? true) !== surface) continue;
    const d = zoneDistance(p, zn);
    if (d < best.distance) best = { zone: zn, distance: d };
  }
  return best;
}

/**
 * What's wrong with settling at `at` (for set-home): within 48 of someone's build on the surface, on top of something
 * built under ground (16), or in the spawn's protection.
 */
export function homeProblems(at: { x: number; y: number; z: number }, zones: Zone[], spawn: { x: number; z: number } | undefined): string[] {
  const out: string[] = [];
  const above = nearestZone(at, zones, true);
  if (above.distance < HOME_FROM_BUILDS) {
    out.push(`someone else's build is ${Math.round(above.distance)} blocks away${above.zone?.sample ? ` (${above.zone.sample} round x ${above.zone.x1}..${above.zone.x2}, z ${above.zone.z1}..${above.zone.z2})` : ''}: keep home at least ${HOME_FROM_BUILDS} from anyone's builds (its mining, trees and yard need room, and the yard grows)`);
  }
  const under = nearestZone(at, zones, false);
  if (under.distance < HOME_FROM_UNDERGROUND) {
    out.push(`something built under ground is ${Math.round(under.distance)} blocks away${under.zone?.sample ? ` (${under.zone.sample} at y ${under.zone.y1}..${under.zone.y2})` : ''}: a mineshaft, a dungeon or someone's cellar; keep ${HOME_FROM_UNDERGROUND} from those`);
  }
  if (spawn) {
    const d = Math.hypot(at.x - spawn.x, at.z - spawn.z);
    if (d < HOME_FROM_SPAWN) out.push(`it's ${Math.round(d)} blocks from the world spawn (a server's spawn protection stops a non-op from building within 16 of it)`);
  }
  return out;
}

/** A box overlapping a zone (inclusive bounds). */
export function boxMeetsZone(b: { x: number; y: number; z: number; width: number; height: number; length: number }, z: Zone): boolean {
  return b.x <= z.x2 && b.x + b.width - 1 >= z.x1 && b.y <= z.y2 && b.y + b.height - 1 >= z.y1 && b.z <= z.z2 && b.z + b.length - 1 >= z.z1;
}
