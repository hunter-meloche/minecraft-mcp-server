import { outsideBy } from './goals.js';

/**
 * The mine: where to sink the shaft, whether the bot is fit for a deep trip, and how long it may stay down. Pure:
 * the brain surveys the candidate columns and the snapshot.
 */

export interface MineCandidate {
  x: number; z: number;
  /** Surface height of the column; not finite when no solid ground was found (a cave mouth, a ravine, the void). */
  ground: number;
  /** Water within 3 blocks: a shaft next to water floods. */
  water: boolean;
  /** Inside a protected area (the home, the farm, someone's build). */
  protected: boolean;
}

/**
 * The column to dig the mine at: solid ground, dry, unprotected, and the nearest to home at least `minDist` away (far
 * enough that the shaft and its mobs stay out of the home area, near enough to walk back before dark). Undefined
 * when none qualifies.
 */
export function chooseMineSite<C extends MineCandidate>(home: { x: number; z: number }, candidates: C[], minDist = 40, maxDist = 64): C | undefined {
  const dist = (c: C) => Math.hypot(c.x - home.x, c.z - home.z);
  return candidates
    .filter(c => Number.isFinite(c.ground) && !c.water && !c.protected && dist(c) >= minDist && dist(c) <= maxDist)
    .sort((a, b) => dist(a) - dist(b) || a.x - b.x || a.z - b.z)[0];
}

export interface TripCheck {
  health: number; food: number; readyFoodPoints: number;
  /** Worst armour piece's tier, as kit.ts ranks it (iron = 4); 0 when a piece is missing. */
  armorTier: number;
  torches: number; blocks: number; timeOfDay: number; slotsFree: number;
}

/** What a deep trip needs: enough to heal from a fight, see, block lava and mobs, and bring the ore back by day. */
export const DEEP_TRIP = { health: 18, food: 14, readyFoodPoints: 20, armorTier: 4, torches: 16, blocks: 32, slotsFree: 10, latestStart: 6000 } as const;

/** What the kit asks of the bot itself: everything of a TripCheck but the hour and the pockets. */
export type KitCheck = Omit<TripCheck, 'timeOfDay' | 'slotsFree'>;

/** Every shortfall of the kit: health, food, ready food, armour, torches, blocks, in that order. */
function kitShort(s: KitCheck): string[] {
  const why: string[] = [];
  if (s.health < DEEP_TRIP.health) why.push(`health ${s.health} < ${DEEP_TRIP.health}`);
  if (s.food < DEEP_TRIP.food) why.push(`food ${s.food} < ${DEEP_TRIP.food}`);
  if (s.readyFoodPoints < DEEP_TRIP.readyFoodPoints) why.push(`ready food ${s.readyFoodPoints} < ${DEEP_TRIP.readyFoodPoints} points`);
  if (s.armorTier < DEEP_TRIP.armorTier) why.push('armour below iron');
  if (s.torches < DEEP_TRIP.torches) why.push(`${s.torches} torches < ${DEEP_TRIP.torches}`);
  if (s.blocks < DEEP_TRIP.blocks) why.push(`${s.blocks} blocks < ${DEEP_TRIP.blocks}`);
  return why;
}

/**
 * Whether the bot has the kit for a deep trip, whatever the hour and however full its pockets: the deep trip's own
 * goal asks the pockets rule for the slots (the stash can make them on the way out), and its own clock for the hour.
 */
export function deepTripKit(s: KitCheck): { ok: boolean; why?: string } {
  const why = kitShort(s);
  return why.length ? { ok: false, why: why.join('; ') } : { ok: true };
}

/** Whether to go deep now (the kit, the hour, ten free slots); `why` lists every shortfall so the brain can fix them in one trip home. */
export function deepTripReady(s: TripCheck): { ok: boolean; why?: string } {
  const why = kitShort(s);
  const t = ((s.timeOfDay % 24000) + 24000) % 24000;
  if (t > DEEP_TRIP.latestStart) why.push(`too late in the day (${t}; set out by ${DEEP_TRIP.latestStart})`);
  if (s.slotsFree < DEEP_TRIP.slotsFree) why.push(`${s.slotsFree} free slots < ${DEEP_TRIP.slotsFree}`);
  return why.length ? { ok: false, why: why.join('; ') } : { ok: true };
}

/** Home by this time of day: dusk starts at 12000 and mobs spawn from about 13000. */
export const HOME_BY = 11000;
const MS_PER_TICK = 50;

/** How long to mine before heading back so the walk ends at HOME_BY (0 when it's already time to go). */
export function tripBudgetMs(timeOfDay: number, walkBackMs: number): number {
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return Math.max(0, (HOME_BY - t) * MS_PER_TICK - walkBackMs);
}

/** How far the deep trip's departure point keeps from anyone's build on the surface (Baritone digs nothing near one). */
export const MINE_FROM_BUILDS = 32;
/**
 * How far outside the yard a remembered departure point must stand to be used again. The yard grows and the point
 * does not move: the one in memory, (-549, 63, 2127), had the yard round it, and a shaft sunk there is a hole in the
 * homestead.
 */
export const MINE_FROM_YARD = 30;

type P3 = { x: number; y: number; z: number };

/**
 * Where a deep trip sets out from: the remembered point while it's clear of others' builds on the surface and still
 * well outside the yard; otherwise the first clear one of the four sides of the yard, 40 blocks out (north first: the
 * old default, away from the lake). Undefined when every side has someone's build by it. `distance` measures to the
 * nearest build on the surface.
 */
export function pickMineStart(home: P3, yard: { x1: number; z1: number; x2: number; z2: number } | undefined, kept: P3 | undefined,
  distance: (p: P3) => number): P3 | undefined {
  const clear = (p: P3) => distance(p) >= MINE_FROM_BUILDS;
  if (kept && clear(kept) && (!yard || outsideBy(yard, kept) >= MINE_FROM_YARD)) return kept;
  const out = 40;
  const sides: P3[] = [
    { x: home.x, y: home.y, z: (yard?.z1 ?? home.z - 16) - out },
    { x: (yard?.x2 ?? home.x + 16) + out, y: home.y, z: home.z },
    { x: (yard?.x1 ?? home.x - 16) - out, y: home.y, z: home.z },
    { x: home.x, y: home.y, z: (yard?.z2 ?? home.z + 16) + out }
  ];
  return sides.find(clear);
}
