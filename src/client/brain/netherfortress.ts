/**
 * The natural Nether fortress (P3c of the progression plan, stage 3 of the Nether trips, with the user's decisions of
 * Nov 17): blaze rods for the brewing stand (P4), nether wart for the wart farm, some soul sand, and the loot of its
 * chests. The user's decision 6, "go with strict rules": the fortress without potions (stage 3 waited on 2 potions of
 * fire resistance from Nov 15, and the potions wait on the brewing stand, which waits on the blaze rods).
 *
 * Which fortress (fortressWay): only a natural one a scouting leg found (a `fortress` site with its leg: the bridge's
 * Foreign marks a zone `natural` by its palette alone, nothing only a player puts there within 8 of it), by the way that
 * leg walked (its waypoints, the one nearest the fortress the last), and none refused before: the trip refuses one for
 * good where the bridge says something only a player puts there stands within 16 of it (its zone's `strays`: a torch,
 * a sign, a rail, glass...) or a player is seen within 64 of it. Courtesy beside it: nothing taken within 16 of a block
 * only a player puts down there (cobblestone), and a chest only where the fortress itself puts its chests (naturalChest:
 * in a corridor of its nether bricks, a single one, nothing else by it); every walk 16 from every other zone.
 *
 * The strict rules (the user's): it sets out only at full health and food (20 and 20, after the kit's meals and the
 * healing), with the fire gear worn (D1: 20 EPF against fire, the golden helmet's fire protection 4 over the main
 * set's protection 4, netherset.ts fireGear) and a shield. Down
 * there it leaves at once, from wherever it is (fortressStop, looked at between every leg, dig and bout of a fight,
 * and walking back the way it came): under 10 health (half: leave nether's 12 waits for it while the run is under way,
 * nether.ts ownHealth), with the wither on it (a wither
 * skeleton's hit), on any hold (the switch off, a death hold, the fortress trips off), at its time (the rung's day is
 * home by dusk: the leave nether goal's), on the ghast rule (the user's rule b: a ghast within 16 that sees it, one that
 * fired at it, or a hit, as barterDanger has it; a hit while a fortress mob is about is the fight's, and the health rule
 * is what bounds it), and where fire resistance would be needed and none can be drunk: the way on only by lava within 2.
 * The fortress needs no potion to set out ("without potions": its stage gate asks for none), but with brewing (P4) the
 * kit carries one where the chests hold it (mine.ts NETHER_TRIP.firePotions), and the trip drinks it where lava by the
 * way would turn it back (drinkFor: one that lasts the way back, no ghast watching); while the effect lasts past the way
 * back, the ground by lava is walked. Blazes are fought from the shield (the bridge's fight: never walked
 * after by it, the shield up toward their fire and the swing in its gaps, Nether.noChase and blazeSwing); one that holds
 * off out of reach (a blaze that sees the bot only fires) the trip walks in to itself, carefully, over the fortress's
 * ground by its rules (no lava within 2, no drop's edge), and one in the air is let be (blazeStance), wither skeletons with the sword (the fight's own choice of weapon, an axe only where a neutral mob is by: no sweep
 * that would anger it), neither chased off a ledge or over lava (Nether.chaseRefusal). A death on a fortress trip turns
 * the fortress trips off for good until the lead switches them back (nether.ts netherTick, the nether-trips tool's
 * `fortress`), on top of the death ladder that holds every trip.
 *
 * What it brings (fortressWant): blaze rods while the home has fewer than FORTRESS_STOCK's 8 (the brewing stand needs
 * 1: brewingGate opens P4's milestone with one home), nether wart from the fortress's own soul-sand patches while the
 * home has fewer than 8 (FORTRESS_WART_TRIP plants a trip, the rest of the patch left), soul sand dug from under the wart
 * it harvested while the home is short of nether.ts NETHER_STOCK's (FORTRESS_SAND_TRIP a trip), and whatever its
 * natural chests hold (each emptied once: world.nether.fortress.looted). Says `nether: fortress at nether (x, y, z): 3
 * blaze_rod, 4 nether_wart, ...`.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts reaches it, and this module reaches most of the brain).
 */
import { brainRun, type InventoryItem, type Status } from '../tools.js';
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { homePortal, tripsOn } from './portal.js';
import { freeChestTotals } from './chests.js';
import {
  FORTRESS_KEPT, NETHER, NETHER_STOCK, OWN_HEALTH_FLOOR, barterHold, deathHold, gameDay, netherOf, ownHealth, peekNether, stageNeeds, type Bearing, type NetherMemory
} from './nether.js';
import {
  BACK_MS, FAR_STEP_MS, FAR_TURN_MS, KNOCK_GAP, backThroughOwn, barterDanger, ghastAbout, ghastWatched, lavaBy, lootWords, overDrop, takesAt, toOwnPortal, type Seen
} from './netherbarter.js';
import { DROP_RANGE, digStance } from './netherquartz.js';
import { fireOf, potionSeconds, potionToDrink } from './netherdebris.js';
import { dressedFireGear, fireGear } from './netherset.js';
import {
  EYE, FROM_BUILDS, GONE, SETUP_HEALTH, SETUP_WAITS, blockAt, boxGap, boxOf, cellOf, clearTo, fetchSetupKit, footing, inNether, pathOf, placedIn, readGround,
  setOpen, setupShort, walkAlong, walkFrom, zoneBox, type Box, type Grid, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const cellKey = (p: Pos) => `${p.x},${p.y},${p.z}`;
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const add = (p: Pos, dx: number, dy: number, dz: number): Pos => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const floorOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
/** A zone as the bridge's foreign.zones has it: a natural one's `strays` (from the jar of P3c on; none from an older one). */
type FortressZone = NetherZone & { strays?: string[] };
const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const across = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const middleOf = (c: Pos): Pos => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
/** The point of a box nearest a cell, to the block. */
const nearestIn = (b: Box, p: Pos): Pos => ({ x: Math.max(b.x1, Math.min(b.x2, p.x)), y: Math.max(b.y1, Math.min(b.y2, p.y)), z: Math.max(b.z1, Math.min(b.z2, p.z)) });

// ------------------------------------------------------------------------------------------------ the rules

/** What the fortress keeps at home (carried and in the chests): blaze rods (the brewing stand takes 1, brewing's powder the rest) and nether wart (the wart farm's seed, P4). */
export const FORTRESS_STOCK = { blaze_rod: 8, nether_wart: 8 } as const;
/** Wart plants harvested a trip at most (a few: the rest of the fortress's patch is left), soul sand dug a trip (only from under wart it harvested), natural chests opened a trip. */
export const FORTRESS_WART_TRIP = 4;
export const FORTRESS_SAND_TRIP = 4;
export const FORTRESS_CHESTS_TRIP = 2;
/** It sets out at this health and food, and no lower (the user's "full health"). */
export const FORTRESS_HEALTH = 20;
export const FORTRESS_FOOD = 20;
/** Under this health it leaves at once (the user's "below half health"). */
export const FORTRESS_LEAVE = 10;
/** The fortress trip's whole time, from the kit at home to back through its own portal, and what it still needs after the kit (the nether rung's run stops at 12 min). */
export const FORTRESS_MAX_MS = 9 * MINUTE;
export const FORTRESS_LEAST_MS = 4 * MINUTE;
/** The fortress's own ground it reads and goes into, round the point of it nearest the way's last waypoint, across and up and down. */
export const FORTRESS_REACH = 24;
const READ_DY = 12;
/** The way's last waypoint is this near the fortress at most (the bridge's scan reaches 48 round the bot: the leg passed it within that). */
export const FORTRESS_APPROACH = 48;
/**
 * Fought when this near and in sight: a blaze (its fire reaches 48), a wither skeleton (a sword's foe at its own reach).
 * A blaze that sees the bot holds its distance and only fires (26.3's BlazeAttackGoal moves it toward its target only
 * within 2 blocks, or once it has lost sight of it), and the bridge never walks after one (Nether.noChase): the trip
 * walks in to it itself, carefully, to a cell of the fortress's ground it may walk within BLAZE_REACH of it and in
 * sight (blazeStance), and only to one on the ground or near it (within BLAZE_LOW over its floor): one higher flies.
 */
export const FOE_RANGE: Readonly<Record<string, number>> = { blaze: 16, wither_skeleton: 8 };
/** The bridge's fight swings within 3.2 (feet to feet) and in sight: the stance it walks to is this near a blaze. */
export const BLAZE_REACH = 3;
/** A blaze's feet at most this over the floor under it: on the ground, or hovering low by it (blazes bob as they fire). */
export const BLAZE_LOW = 2;
/** A hit taken while one of these is within FOE_NEAR is the fight's (the health rule bounds it), not the ghast rule's. */
const FOES = /^(blaze|wither_skeleton|skeleton|magma_cube)$/;
const FOE_NEAR = 24;
/** Fights at one foe that killed nothing, at most: then it is let be (the shield and the Guardian still have it). */
const FOE_TRIES = 2;
/**
 * A fight is fought in bouts of the bridge's fight, a look between them (the strict rules: the wither on it, a ghast by
 * rule b, the health), `bouts` at most (the 20 s a fight had): the bridge's fight stops for none of those itself, and a
 * wither caught 2 s into one 20 s call ticked on for the rest of it.
 */
export const FIGHT_BOUT = { ms: 4_000, bouts: 5 } as const;
/** A player seen within this of the fortress: it is someone's to share, and refused for good (the villages' 64). */
export const PLAYER_NEAR = 64;
/** Nothing taken within this of a block only a player puts down there (the read's cobblestone). */
export const PLACED_CLEAR = 16;
/** Looks it waits at the fortress for a blaze to come into sight (a spawner's) while the rods are short and nothing else is left (some 15 s). */
export const BLAZE_WAIT_LOOKS = 30;
/** The waits, in looks a pollMs apart (a test sets pollMs to nothing; the counts stand). */
export const FORTRESS_WAITS = { pollMs: 500, dropLooks: 2 };
/** Steps a walk leg (a look between every two), and the walks planned again on a known way at most. */
const STEP = 4;
const WAY_REPLANS = 4;
/** The ground read a stretch of a known way at a time: this many waypoints ahead, and round them. */
const WAY_AHEAD = 4;
const STRETCH = { across: 8, down: 12, up: 12 } as const;
/** A blaze's eyes over its feet (26.3's EntityType.BLAZE: 0.6 x 1.8, eyes at 1.53); a wither skeleton's (2.4 tall, 2.1). */
const FOE_EYE: Readonly<Record<string, number>> = { blaze: 1.53, wither_skeleton: 2.1 };

/**
 * The fire resistance a walk by lava must have left beyond the way back (ms): the ground by lava is walked only while
 * the effect outlasts the walk back to its hut by this, and a potion is drunk for it only where it would.
 */
export const FIRE_SPARE_MS = 30_000;
/**
 * The least work a potion drunk must buy beyond the walk it is drunk for (ms): one that ran short at the first look after
 * it (fireShort) was drunk for nothing, the kit's one potion gone and none left for the Guardian's hook.
 */
export const FIRE_WORK_MS = 30_000;

/** A fortress's own blocks round its chests (26.3 NetherFortressPieces: nether bricks, their fence and stairs). */
const FORTRESS_BLOCKS = /^(nether_bricks|nether_brick_fence|nether_brick_stairs)$/;

/**
 * A chest the fortress itself put there, pure: a single chest (26.3's NetherFortressPieces makes one at a time, in the
 * small corridor's left and right turns: createChest at (3, 2, 3) and (1, 2, 3), its loot table NETHER_BRIDGE) on its
 * nether bricks, in a corridor (nether bricks over it within 4, one of them against a side of it), and nothing but the
 * fortress's own blocks and air round it, a block every way. A chest on an open bridge, one of a pair, one with a
 * torch or a sign by it is someone's.
 */
export function naturalChest(g: Grid, p: Pos): boolean {
  if (blockAt(g, p) !== 'chest' || blockAt(g, add(p, 0, -1, 0)) !== 'nether_bricks') return false;
  let roof = false;
  for (let dy = 2; dy <= 4 && !roof; dy++) roof = blockAt(g, add(p, 0, dy, 0)) === 'nether_bricks';
  if (!roof) return false;
  if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => FORTRESS_BLOCKS.test(blockAt(g, add(p, dx, 0, dz)) ?? ''))) return false;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dy && !dz) continue;
    const b = blockAt(g, add(p, dx, dy, dz));
    if (b === null || !(b === 'air' || b === 'cave_air' || FORTRESS_BLOCKS.test(b))) return false;
  }
  return true;
}

/** Nether wart the fortress grows (on its soul sand), pure. */
export const fortressWart = (g: Grid, p: Pos): boolean => blockAt(g, p) === 'nether_wart' && blockAt(g, add(p, 0, -1, 0)) === 'soul_sand';

/**
 * Why the bot must leave the fortress now, or null, pure (the user's strict rules, see the top of the file): under
 * FORTRESS_LEAVE health; the wither on it; a hold (the switch off, a death hold, the fortress trips off); the ghast
 * rule b and the barter's other dangers (barterDanger: a piglin turned, a ghast within 16 that sees it, a ghast's
 * fireball coming at it, a brute or a hoglin near, a hit), where a hit while a fortress mob (FOES) is within FOE_NEAR
 * is the fight's; on fire with no fire resistance on it and no foe by (a blaze's fire is the fight's too).
 */
export function fortressStop(look: { health: number; was: number; effects?: Status['effects']; onFire?: boolean; ents: Seen[]; eyes?: { g: Grid; me: Pos } },
  world: WorldMemory, now: number): { why: string; angry?: true } | null {
  if (look.health < FORTRESS_LEAVE) return { why: `health ${Math.round(look.health)}, under ${FORTRESS_LEAVE}` };
  const effect = (name: string) => (look.effects ?? []).find(e => e.name.replace(/^minecraft:/, '') === name);
  if (effect('wither')) return { why: 'the wither on it' };
  if (!tripsOn(world)) return { why: 'nether trips are off' };
  const held = deathHold({ now }, world);
  if (held) return { why: held.text };
  const off = peekNether(world).fortress?.off;
  if (off) return { why: `fortress trips off: ${off.why}` };
  const fight = look.ents.some(e => FOES.test(e.name) && e.distance <= FOE_NEAR);
  const d = barterDanger(look.ents, look.health, fight ? look.health : look.was, look.eyes);
  if (d) return d;
  // (set alight by a blaze's fire while fighting it: the fight's, bounded by the health rule; alight with no foe by,
  // it stood in fire or by lava)
  if (look.onFire && !effect('fire_resistance') && !fight) return { why: 'on fire, with no fire resistance on it' };
  return null;
}

// ------------------------------------------------------------------------------------------------ which fortress

/** A fortress by a scouting leg's way: the leg's bearing and way, the waypoint it walks out to (its index), the site, the way's blocks to it. */
export interface FortressWay { bearing: Bearing; way: Pos[]; to: number; site: Pos; blocks: number }

/**
 * A fortress refused for good (a player's block by it, a player seen by it), by its extent: the box of its zone as the
 * trip that refused it saw it (an older entry: its site), and REFUSED_NEAR round that. A site is the middle of the zone
 * as one scouting leg saw it, and a fortress is 100 to 200 across: a later leg that sees more of it logs another site
 * 20 or more from the first, and a refusal by its point alone would let the trip loot it the next day.
 */
const REFUSED_NEAR = 16;
type Refused = NonNullable<NonNullable<NetherMemory['fortress']>['refused']>[number];
const refusedBox = (r: Refused): Box => r.box ?? cellBox(r);
const refusedBy = (list: readonly Refused[], b: Box) => list.find(r => boxGap(refusedBox(r), b) <= REFUSED_NEAR);
const refusedAt = (n: Pick<NetherMemory, 'fortress'>, p: Pos) => !!refusedBy(n.fortress?.refused ?? [], cellBox(p));

/**
 * The fortress a trip goes to by a known way, pure, or undefined: of the `fortress` sites a scouting leg found (natural:
 * the scouting notes only a zone Foreign marks so), none refused, the ones whose leg's way as kept now has a waypoint
 * within FORTRESS_APPROACH of the site; each by that waypoint nearest it; the one of the shortest way there.
 */
export function fortressWay(world: WorldMemory): FortressWay | undefined {
  const n = peekNether(world);
  let best: FortressWay | undefined;
  for (const s of n.sites) {
    if (s.kind !== 'fortress' || !s.leg) continue;
    const site = { x: s.x, y: s.y, z: s.z };
    if (refusedAt(n, site)) continue;
    const leg = (n.legs ?? []).find(l => l.bearing === s.leg);
    if (!leg || leg.way.length < 2) continue;
    let to = -1, gap = Infinity;
    for (let i = 1; i < leg.way.length; i++) {
      const d = dist3(leg.way[i], site);
      if (d < gap) { gap = d; to = i; }
    }
    if (to < 0 || gap > FORTRESS_APPROACH) continue;
    let blocks = 0;
    for (let i = 1; i <= to; i++) blocks += dist3(leg.way[i - 1], leg.way[i]);
    blocks = Math.round(blocks);
    if (!best || blocks < best.blocks) best = { bearing: leg.bearing, way: leg.way.map(p => ({ ...p })), to, site, blocks };
  }
  return best;
}

/** A fortress refused for good, with why and the box of its zone where the trip saw it (the newest kept): never chosen again, by any site within REFUSED_NEAR of it. */
export function refuseFortress(world: WorldMemory, site: Pos, why: string, now: number, box?: Box): void {
  const f = (netherOf(world).fortress ??= {});
  const b = box && { x1: box.x1, y1: box.y1, z1: box.z1, x2: box.x2, y2: box.y2, z2: box.z2 };
  f.refused = [...(f.refused ?? []).filter(r => dist3(r, site) > 8), { ...site, why: why.slice(0, 160), at: now, ...(b ? { box: b } : {}) }].slice(-FORTRESS_KEPT);
}

// ------------------------------------------------------------------------------------------------ the wants

/** How much of a kind the home has: carried and in the chests beyond what the jobs hold. */
const homeHas = (s: Pick<Snapshot, 'counts'>, world: WorldMemory, kind: string, free = freeChestTotals(world)) => (s.counts.get(kind) ?? 0) + (free[kind] ?? 0);

/** What the fortress is wanted for now, pure: the blaze rods or the wart short of FORTRESS_STOCK, each with what the home has; empty when both are met. */
export function fortressWant(s: Pick<Snapshot, 'counts'>, world: WorldMemory): { kind: keyof typeof FORTRESS_STOCK; have: number; want: number }[] {
  const free = freeChestTotals(world);
  return (Object.keys(FORTRESS_STOCK) as (keyof typeof FORTRESS_STOCK)[])
    .map(kind => ({ kind, have: homeHas(s, world, kind, free), want: FORTRESS_STOCK[kind] as number })).filter(k => k.have < k.want);
}

/**
 * P4's brewing milestone may start (its gate, and only that: the brewing stand is P4's): a blaze rod home, carried or
 * in the chests (the stand takes 1). Null when it may, else why not. A look only.
 */
export function brewingGate(s: Pick<Snapshot, 'counts'>, world: WorldMemory): Decline | null {
  return homeHas(s, world, 'blaze_rod') >= 1 ? null : { cause: 'unneeded', text: 'brewing waits on a blaze rod (the fortress trips bring them)' };
}

// ------------------------------------------------------------------------------------------------ the gate

/** The fortress is open from its stage (3: nether.ts NETHER_STAGES, no potion needed), its own portal standing and the two sides linked, and not switched off after a death. */
export function fortressOpen(world: WorldMemory): boolean {
  const n = peekNether(world);
  return n.linked === true && !!n.portal && n.stage >= (stageNeeds('fortress')?.stage ?? Infinity);
}

/**
 * Whether the fortress trip can set out now, pure: not switched off after a death on one (the lead switches them back);
 * not held (a piglin turned on the bot by its portal today: the barter's hold, the way out starts by the same hut); the
 * blaze rods or the wart wanted (fortressWant); a natural fortress known by a scouted way (fortressWay); the fire gear
 * as it will be dressed for the Nether (netherset.ts dressedFireGear: 20 EPF against fire, the golden helmet's fire
 * protection 4 over the main set's protection 4, and every main piece sound); not
 * hurt past what the run heals at home (its full health and food are the run's, after the kit's meals); nothing of the
 * Nether kit short that the chests lack (the setup's own list: the shield among it). The hour is the rung's.
 */
export function fortressReady(s: Snapshot, world: WorldMemory): Decline | null {
  const off = peekNether(world).fortress?.off;
  if (off) return { cause: 'hold', text: `fortress trips off: ${off.why} (until the lead switches them back)` };
  const held = barterHold(world, s.now);
  if (held) return { cause: 'hold', text: `fortress held for the day: ${held.why}` };
  if (!fortressWant(s, world).length) return { cause: 'unneeded', text: `fortress: ${FORTRESS_STOCK.blaze_rod} blaze rods and ${FORTRESS_STOCK.nether_wart} nether wart at home` };
  if (!fortressWay(world)) return { cause: 'unneeded', text: 'fortress: no natural fortress known by a scouted way' };
  const gear = dressedFireGear(s.items, world);
  if (!gear.ok) return { cause: 'kit', text: `fortress: the fire gear is short: ${gear.missing.join('; ')} (the fortress goes only in it)` };
  if (s.health < SETUP_HEALTH) return no.health(s, 'the fortress', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `fortress: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the trip

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];
const freeSlots = (items: InventoryItem[]) => 36 - new Set(items.filter(i => i.slot >= 0 && i.slot < 36).map(i => i.slot)).size;
/** What is carried, by kind (the pockets and the off hand: what a trip brought is told by it). */
const tally = (items: InventoryItem[]) => {
  const m = new Map<string, number>();
  for (const i of items) if (i.slot >= 0 && (i.slot < 36 || i.slot === 40)) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
};

/** A box to read round a cell and a box (the fortress's ground by the way's last waypoint). */
const readBoxFor = (zone: Box, wp: Pos): Box => {
  const c = nearestIn(zone, wp);
  const b = { x1: c.x - FORTRESS_REACH, y1: c.y - READ_DY, z1: c.z - FORTRESS_REACH, x2: c.x + FORTRESS_REACH, y2: c.y + READ_DY, z2: c.z + FORTRESS_REACH };
  return {
    x1: Math.min(b.x1, wp.x - 4), y1: Math.max(1, Math.min(b.y1, wp.y - READ_DY)), z1: Math.min(b.z1, wp.z - 4),
    x2: Math.max(b.x2, wp.x + 4), y2: Math.min(126, Math.max(b.y2, wp.y + READ_DY)), z2: Math.max(b.z2, wp.z + 4)
  };
};
/** The ground to read for a stretch of a known way. */
const stretchBox = (cells: Pos[]): Box => {
  const b = boxOf(cells);
  return {
    x1: b.x1 - STRETCH.across, y1: Math.max(1, b.y1 - STRETCH.down - 3), z1: b.z1 - STRETCH.across,
    x2: b.x2 + STRETCH.across, y2: Math.min(126, b.y2 + STRETCH.up), z2: b.z2 + STRETCH.across
  };
};
/** What stops sight: a block with a collision box. */
const seesThrough = (g: Grid) => (p: Pos) => { const c = cellOf(blockAt(g, p)); return c === 'open' || c === 'plant' || c === 'hot' || c === 'portal' || c === 'unknown'; };

/**
 * The fortress trip (see the top of the file). From home with the Nether kit and the fire gear on, at full health and
 * food (or it does not set out: untried), through the home portal into its own hut, out along the scouting leg's way
 * to its waypoint by the fortress, into the fortress's ground there; the foes fought as they come, its chests, wart
 * and soul sand taken by its rules; back along the way it walked and through its own portal. Gain: the things it
 * brought back. Out of the Nether halfway (a death), it stops at once (netherTick books the death on the trip:
 * world.nether.fortress.trip).
 */
export async function fortressRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, FORTRESS_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to go out from', untried: true };
  const fw = fortressWay(world);
  if (!fw) return { gain: 0, text: 'no natural fortress known by a scouted way', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  // the strict rules at home: full health and food, the fire gear worn (netherset.ts fireGear), a shield (the kit's meals and healing came first)
  const st0 = await ctx.status().catch(() => undefined);
  const kit = await inventory(ctx);
  const why = [
    ...((st0?.health ?? 0) < FORTRESS_HEALTH ? [`health ${Math.round(st0?.health ?? 0)} < ${FORTRESS_HEALTH}`] : []),
    ...((st0?.food ?? 0) < FORTRESS_FOOD ? [`food ${st0?.food ?? 0} < ${FORTRESS_FOOD}`] : []),
    ...fireGear(kit).missing,
    ...(kit.some(i => i.name === 'shield') ? [] : ['no shield'])
  ];
  if (why.length) return { gain: 0, text: `not setting out for the fortress: ${why.join('; ')}`, untried: true };
  if (left() < FORTRESS_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the fortress trip's ${FORTRESS_MAX_MS / MINUTE} min is left`, untried: true };
  }
  // the trip under way, for netherTick: a death from here to its end is a death there
  const f = (netherOf(world).fortress ??= {});
  f.trip = { from: now() };
  // (its own health rule bounds the run: leave nether's 12 waits, and the run walks back the way it came)
  ownHealth.floor = OWN_HEALTH_FLOOR;
  try {
    return await tripThere(ctx, fw, home, own, left, now, tally(kit));
  } finally {
    ownHealth.floor = undefined;
    // (its end only where it stands out of the Nether: cut short down there (leave nether's abort: the dusk, under 6
    // health), the walk home that comes after is the trip's still, and netherTick ends it at the first look home. The
    // look outside the brain's run (brainRun.exit): a run cut short at home, before its portal, has every call of its
    // own refused, and the trip left open 30 min would book a death on the next trip as the fortress's)
    const t = netherOf(world).fortress?.trip;
    if (t && t.to === undefined) {
      const st = await brainRun.exit(() => ctx.status()).catch(() => undefined);
      if (st && st.dimension !== NETHER) t.to = now();
    }
  }
}

async function tripThere(ctx: GoalContext, fw: FortressWay, home: Pos, own: Pos, left: () => number, now: () => number, before: Map<string, number>): Promise<WorkResult> {
  const world = ctx.world;
  const site = fw.site;
  const to = await toOwnPortal(ctx, home, own, now, 'fortress');
  if ('result' in to) return to.result;
  const { arrived, homeShape } = to;
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const wp = fw.way[fw.to];

  // ---- the zones down there (asked at every look: the bridge's scan follows the bot, 48 round it); every zone seen
  // on the trip kept. The fortress's own is the natural one by the site in the latest answer: Foreign's zones only
  // grow as its scan takes in more chunks (it keeps every chunk it saw), so an earlier answer's is a smaller, older
  // copy of it, and its strays the fewer. The walks keep 16 from every other zone seen, those older copies of the
  // fortress let go of
  const seenZones = new Map<string, FortressZone>();
  let others: Box[] = [];
  let fortress: FortressZone | undefined;
  /** a zone not natural by the site where the latest answer has no natural fortress: the fortress joined someone's build (Foreign's natural is lost with a player's block within 8) */
  let builtBy: FortressZone | undefined;
  /** the fortress was natural in an answer of this trip's (its loss is then a player's build, not a scan that has not reached it) */
  let wasNatural = false;
  const gapToSite = (z: FortressZone) => boxGap(zoneBox(z), cellBox(fw.site));
  const volume = (z: FortressZone) => (z.x2 - z.x1 + 1) * (z.y2 - z.y1 + 1) * (z.z2 - z.z1 + 1);
  const askZones = async (): Promise<boolean> => {
    const r = await ctx.call<{ zones?: FortressZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => undefined);
    if (!r) return false;
    const latest = r.zones ?? [];
    for (const z of latest) seenZones.set(`${z.x1},${z.y1},${z.z1},${z.x2},${z.y2},${z.z2}`, z);
    const natural = latest.filter(z => z.natural === 'fortress' && gapToSite(z) <= 16).sort((a, b) => gapToSite(a) - gapToSite(b) || volume(b) - volume(a))[0];
    builtBy = undefined;
    if (natural) fortress = natural;
    else {
      builtBy = latest.find(z => !z.natural && gapToSite(z) <= 16);
      // (the earlier pick kept only where nothing of the latest answer lies on it: the bridge's scan let go of, not a
      // fortress merged with someone's build)
      if (builtBy || !fortress || latest.some(z => boxGap(zoneBox(z), zoneBox(fortress!)) === 0)) fortress = undefined;
    }
    if (fortress) wasNatural = true;
    const fb = fortress && zoneBox(fortress);
    others = [...seenZones.values()].filter(z => !(fb && z.natural === 'fortress' && boxGap(zoneBox(z), fb) === 0)).map(zoneBox);
    return true;
  };
  /** the fortresses refused before this trip set out (one by this fortress's extent: refused under another site) */
  const refusedBefore = [...(peekNether(world).fortress?.refused ?? [])];
  /** at the fortress (the scan has it as the scouting leg did) */
  let there = false;
  /**
   * Why nothing may be taken from the fortress, by the bridge's latest answer, or undefined (the user's courtesy, at
   * every look: the scan reaches 48 round the bot, and what it takes in as the bot walks in counts as much as what it
   * had): `refuse` the why it is refused for good with. An older jar says no strays: nothing taken, not refused.
   */
  const courtesy = (): { why: string; refuse?: string } | undefined => {
    if (fortress) {
      if (!Array.isArray(fortress.strays)) return { why: `the bridge does not say what of a player's stands within 16 of the fortress at nether ${fmt(site)} (an older jar): nothing taken` };
      if (fortress.strays.length) {
        return { why: `the fortress at nether ${fmt(site)} has ${fortress.strays.slice(0, 4).join(', ')} within 16 of it (a player's): refused for good, nothing taken`, refuse: `${fortress.strays.join(', ')} within 16 of it` };
      }
      const before = refusedBy(refusedBefore, zoneBox(fortress));
      if (before) return { why: `the fortress at nether ${fmt(site)} was refused before by nether ${fmt(before)} (${before.why}): nothing taken`, refuse: `refused before by nether ${fmt(before)}: ${before.why}` };
    } else if (builtBy && (wasNatural || there)) {
      return { why: `someone's build by the fortress at nether ${fmt(site)} (the bridge's zone by it is no natural one): refused for good, nothing taken`, refuse: "someone's build by it" };
    }
    return undefined;
  };
  if (!(await askZones())) {
    const b = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no fortress trip: the bridge did not say where the builds down there are; ${b.text}`, mark: 'same', ...(b.cameBack ? { cameBack: true as const } : {}) };
  }

  // ---- the looks: the strict rules (fortressStop) between every leg of every walk and every dig
  let g = await readGround(ctx, stretchBox([floorOf(to.me), ...fw.way.slice(0, WAY_AHEAD)]));
  let me: Pos = to.me;
  let health = 20;
  let ents: Seen[] = [];
  let stop: string | undefined;
  let angry: string | undefined;
  let unlearnt = false;
  let gone = false;
  let watched = false;
  /** the fire resistance on the bot as the last look saw it, s */
  let fire = 0;
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
    // a player by the fortress: someone's to share; refused for good, and back
    const fb = fortress ? zoneBox(fortress) : cellBox(site);
    const player = ents.find(e => e.name === 'player' && boxGap(fb, cellBox(floorOf(e.position))) <= PLAYER_NEAR);
    if (player) {
      refuseFortress(world, site, `a player seen by it at nether ${fmt(player.position)}`, now(), fortress && zoneBox(fortress));
      stop = `a player seen by the fortress (nether ${fmt(player.position)}): refused for good`;
      return false;
    }
    const c = courtesy();
    if (c) {
      stop = c.why;
      if (c.refuse) refuseFortress(world, site, c.refuse, now(), fortress ? zoneBox(fortress) : builtBy && zoneBox(builtBy));
      else unlearnt = true;
      return false;
    }
    const d = fortressStop({ health, was, effects: st?.effects, onFire: st?.onFire, ents, eyes: { g, me } }, world, now());
    if (d) { stop = d.why; unlearnt = !d.why.startsWith('health') && !d.why.startsWith('the wither'); if (d.angry) angry = d.why; return false; }
    return true;
  };
  /**
   * the ground a walk may go over on the way out: 16 from every zone but the fortress's own (natural: its zone as the
   * bridge has it now may have grown past the last waypoints since the scouting walked them; one no longer natural is
   * among `others`)
   */
  const wayMay = (p: Pos) => !others.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) && (hotOk() || !lavaBy(g, p)) && !overDrop(g, p);
  /** the same with lava let by: what would need fire resistance */
  const wayHot = (p: Pos) => !others.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) && !overDrop(g, p);
  const knockSafe = (p: Pos) => !watched || !overDrop(g, p, KNOCK_GAP);

  // ---- out along the known way, the ground read a few waypoints ahead at a time; the cells walked are the way back
  const walked: Pos[] = [];
  /** the way back to its hut, ms: the cells walked out, and through its portal */
  const backMs = () => walked.length * FAR_STEP_MS + BACK_MS;
  /** the fire resistance on it outlasts the way back (and FIRE_SPARE_MS): the ground by lava may be walked */
  function hotOk(): boolean { return fire * 1000 > backMs() + FIRE_SPARE_MS; }
  /** cells by lava walked under the potion drunk: from then on the way back over them needs the effect too */
  let hotWalked = false;
  /** the walk from where it stands to the nearest cell of the way out, ms (the fortress's ground it walked in over) */
  const toWayMs = () => walked.reduce((n, c) => Math.min(n, dist3(c, me)), Infinity) * FAR_STEP_MS;
  /**
   * Back now, while the fire resistance still covers the way: cells by lava were walked under it, and what is left of
   * it no longer outlasts the walk to the way, the way back and FIRE_SPARE_MS. Only the day's time turned the trip back
   * before, so a plain potion drunk 40 cells out let it work on at the fortress until the effect was gone, and the way
   * back went past the lava it came by with none on it (and, the kit's one potion drunk, none for the Guardian's hook).
   */
  const fireNeed = () => backMs() + toWayMs() + FIRE_SPARE_MS;
  const fireShort = () => hotWalked && fire * 1000 <= fireNeed();
  const FIRE_SHORT = 'the fire resistance drunk now lasts only the way back';
  /**
   * A potion of fire resistance drunk for the way to `what` by lava (P4): the longest carried (by its contents), only
   * one that outlasts the bound fireShort turns the trip back by (fireNeed), the walk `walkMs` to `what` and back to
   * here, and FIRE_WORK_MS of work there, and not with a ghast watching (the trip it may cut short would lose it).
   * Undefined once it took; else why not ("none is drunk": none carried). (Against the way back alone, a plain potion
   * drunk 20 off the way inside the fortress ran short at the first look after it, its walk to the lava not begun.)
   */
  const drinkFor = async (what: string, walkMs: number): Promise<string | undefined> => {
    const potion = potionToDrink(await inventory(ctx));
    if (!potion) return 'none is drunk';
    if (potionSeconds(potion) * 1000 <= fireNeed() + walkMs + FIRE_WORK_MS) return `the potion of ${potion.potion} carried would not last the way there and back`;
    if (watched) return `${ghastAbout(ents)}: no potion drunk for a trip it may cut short`;
    const held = await ctx.call('item.select', { name: potion.name, slot: potion.slot }).then(() => true, () => false);
    if (ctx.signal.aborted) throw new Error('aborted');
    const r = held ? await ctx.call<{ finished?: boolean }>('use', {}, 15_000).catch(() => ({ finished: false })) : undefined;
    if (ctx.signal.aborted) throw new Error('aborted');
    const st = await ctx.status().catch(() => undefined);
    fire = fireOf(st);
    if (fire <= 0) return `the potion of fire resistance did not take${!held ? ' (not taken in hand)' : r?.finished === false ? ' (not drunk)' : ''}`;
    ctx.progress(`fortress: drank a potion of ${potion.potion} for the way to ${what} by lava: ${Math.round(fire)} s of fire resistance`);
    return undefined;
  };
  const start = footing(g, me) ?? floorOf(me);
  walked.push(start);
  const walkOut = async (path: Pos[]): Promise<'ok' | 'stuck' | 'gone' | 'back'> => {
    for (let i = 0; i < path.length - 1;) {
      const j = Math.min(i + STEP, path.length - 1);
      if (i > 0 && !(await watch())) return 'back';
      if (i > 0 && fireShort()) { stop = FIRE_SHORT; unlearnt = true; return 'back'; }
      if (i > 0 && left() < (walked.length + 2) * FAR_STEP_MS + BACK_MS) { stop = `the fortress trip's time is up on the ${fw.bearing} way`; unlearnt = true; return 'back'; }
      const r = await walkAlong(ctx, path.slice(i, j + 1), STEP);
      if (r !== 'ok') return r;
      for (const c of path.slice(i + 1, j + 1)) { walked.push(c); if (lavaBy(g, c)) hotWalked = true; }
      i = j;
    }
    return 'ok';
  };
  ctx.progress(`fortress: out along the ${fw.bearing} way (${fw.blocks} blocks) to nether ${fmt(wp)} for the fortress at nether ${fmt(site)}`);
  let end: string | undefined;
  /** the blocks of the way still to go from where it stands, by its next waypoint `j` */
  const rest = (j: number) => {
    let n = dist3(me, fw.way[Math.min(j, fw.to)]);
    for (let i = j + 1; i <= fw.to; i++) n += dist3(fw.way[i - 1], fw.way[i]);
    return n;
  };
  for (let j = 1, tries = 0; j <= fw.to && !end && !stop && !gone;) {
    if (!(await watch())) break;
    if (fireShort()) { stop = FIRE_SHORT; unlearnt = true; break; }
    // the rest of the way there and back again, and the least of the fortress's work (FAR_TURN_MS: a barter's out there)
    if (left() < (walked.length + 2 * rest(j)) * FAR_STEP_MS + FAR_TURN_MS + BACK_MS) { stop = `the fortress trip's time is up on the ${fw.bearing} way`; unlearnt = true; break; }
    const ahead = fw.way.slice(j, Math.min(fw.to, j + WAY_AHEAD - 1) + 1);
    g = await readGround(ctx, stretchBox([floorOf(me), ...ahead]));
    if (ctx.signal.aborted) throw new Error('aborted');
    const here = footing(g, me);
    if (!here) { end = `no ground under it on the ${fw.bearing} way at nether ${fmt(me)}`; break; }
    const reach = walkFrom(g, [here], p => wayMay(p) && knockSafe(p));
    let k = -1;
    for (let i = ahead.length - 1; i >= 0 && k < 0; i--) if (reach.has(cellKey(ahead[i]))) k = i;
    if (k < 0) {
      if (watched && walkFrom(g, [here], wayMay).has(cellKey(ahead[0]))) { stop = `${ghastAbout(ents)}: the ${fw.bearing} way on only by a drop's edge`; unlearnt = true; break; }
      // the way on only by lava within 2: a potion carried drunk for it (P4), instead of turning back. None carried:
      // closed, as before (the dry mark grows: the fortress asks for no potion, and it would set out again for nothing)
      if (!hotOk() && potionToDrink(await inventory(ctx)) && walkFrom(g, [here], p => wayHot(p) && knockSafe(p)).has(cellKey(ahead[0]))) {
        const why = await drinkFor(`the fortress along the ${fw.bearing} way at nether ${fmt(ahead[0])}`, 2 * rest(j) * FAR_STEP_MS);
        if (!why) continue;
        stop = `fire resistance would be needed (lava within 2 of the ${fw.bearing} way at nether ${fmt(ahead[0])}) and ${why}`;
        unlearnt = true;
        break;
      }
      end = `the ${fw.bearing} way closed by nether ${fmt(ahead[0])}`;
      break;
    }
    const w = await walkOut(pathOf(reach, ahead[k]));
    if (w === 'gone') { gone = true; break; }
    if (w === 'back' && (stop || gone)) break;
    if (w !== 'ok') { if (++tries > WAY_REPLANS) end = `stuck on the ${fw.bearing} way by nether ${fmt(ahead[0])}`; continue; }
    j += k + 1;
  }

  // ---- at the fortress: courtesy first (the look's: its zone as the bridge has it, the strays within 16, someone's
  // build by it), then its ground read
  const got = new Map<string, number>();
  let foes = 0, chests = 0, warts = 0, sand = 0;
  let fortEnd: string | undefined;
  if (!end && !stop && !gone) there = true;
  if (there && (await watch())) {
    fortEnd = fortress ? await atFortress() : `no natural fortress by nether ${fmt(site)} in the bridge's scan from the ${fw.bearing} way`;
  }

  async function atFortress(): Promise<string | undefined> {
    const zb = zoneBox(fortress!);
    g = await readGround(ctx, readBoxFor(zb, wp));
    if (ctx.signal.aborted) throw new Error('aborted');
    const placed = placedIn(g);
    const clearOfPlaced = (p: Pos) => !placed.some(c => dist3(c, p) <= PLACED_CLEAR);
    const inRead = (p: Pos) => p.x >= g.x && p.y >= g.y && p.z >= g.z && p.x < g.x + g.width && p.y < g.y + g.height && p.z < g.z + g.length;
    const fortressMay = (p: Pos) => inRead(p) && !others.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) && !lavaBy(g, p) && !overDrop(g, p);
    /** the same with lava let by: what would need fire resistance */
    const lavaMay = (p: Pos) => inRead(p) && !others.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) && !overDrop(g, p);
    // (by lava too while the fire resistance drunk outlasts the way back)
    const walkable = (p: Pos) => (hotOk() ? lavaMay(p) : fortressMay(p)) && knockSafe(p);
    const looted = new Set((peekNether(world).fortress?.looted ?? []).map(cellKey));
    const tried = new Set<string>();
    /** the wart cells harvested this trip: their soul sand may be dug */
    const harvested: Pos[] = [];
    /** what the home has of a kind with what the trip carries and has brought so far (the chests as last seen) */
    const free = freeChestTotals(world);
    const homeNow = (kind: string) => (before.get(kind) ?? 0) + (got.get(kind) ?? 0) + (free[kind] ?? 0);
    const sandShort = () => homeNow('soul_sand') < NETHER_STOCK.soul_sand;
    const wartWanted = () => homeNow('nether_wart') < FORTRESS_STOCK.nether_wart;
    const rodsWanted = () => homeNow('blaze_rod') < FORTRESS_STOCK.blaze_rod;
    const inZone = (p: Pos) => boxGap(zb, cellBox(p)) === 0;
    /** What came into the pockets since the start, booked. */
    const book = async () => {
      const now2 = tally(await inventory(ctx));
      for (const [n, c] of now2) {
        const more = c - (before.get(n) ?? 0) - (got.get(n) ?? 0);
        if (more > 0) { got.set(n, (got.get(n) ?? 0) + more); ctx.gain(more); }
      }
    };
    const reachFrom = (ok: (p: Pos) => boolean = walkable) => {
      const here = footing(g, me);
      return here ? walkFrom(g, [here], ok) : new Map<string, { from: string | null; n: number }>();
    };
    const between = async () => {
      if (!(await watch())) return false;
      if (fireShort()) { stop = FIRE_SHORT; unlearnt = true; return false; }
      return true;
    };
    /** A walk over the fortress's ground, a look between its legs; one over cells by lava is noted (the way back needs the effect too). */
    const walkIn = (path: Pos[]) => {
      if (path.some(c => lavaBy(g, c))) hotWalked = true;
      return walkAlong(ctx, path, STEP, between);
    };
    /** Items lying within DROP_RANGE of a point (or of the bot), picked up on foot over ground it may walk. */
    const pickUp = async (around: Pos | undefined): Promise<boolean> => {
      const passed = new Set<number>();
      for (let round = 0; round < 6; round++) {
        if (!(await watch())) return false;
        const next = ents.filter(e => e.name === 'item' && !passed.has(e.id) && (around ? dist3(e.position, around) <= DROP_RANGE + 1 : e.distance <= 8))
          .sort((a, b) => dist3(a.position, me) - dist3(b.position, me))[0];
        if (!next) return true;
        if (takesAt(me, next.position)) { passed.add(next.id); await pause(FORTRESS_WAITS.pollMs); continue; }
        const reach = reachFrom();
        const c = floorOf(next.position);
        let best: { p: Pos; n: number } | undefined;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 0; dy++) {
          const q = add(c, dx, dy, dz);
          const r = reach.get(cellKey(q));
          if (r && across(middleOf(q), next.position) <= 1.2 && takesAt(middleOf(q), next.position) && (!best || r.n < best.n)) best = { p: q, n: r.n };
        }
        if (!best || best.n === 0) { passed.add(next.id); continue; }
        const w = await walkIn(pathOf(reach, best.p));
        if (w === 'gone') { gone = true; return false; }
        if (w === 'back') return false;
        if (w === 'stuck') passed.add(next.id);
      }
      return true;
    };
    /** fights that killed nothing, by the foe's id: twice, and it is let be (a blaze that never comes into reach, a fight the bridge refused) */
    const missed = new Map<number, number>();
    const letBe = (e: Seen, why: string) => {
      missed.set(e.id, FOE_TRIES);
      ctx.progress(`fortress: the ${e.name} #${e.id} at nether ${fmt(e.position)} ${why}: let be`);
    };
    /** The cell a blaze hovers over, with its floor under it within BLAZE_LOW of its feet; else why it is not walked in to (it flies higher, over lava, over ground not read). */
    const blazeFloor = (e: Seen): Pos | string => {
      const c = floorOf(e.position);
      for (let dy = 0; dy <= BLAZE_LOW; dy++) {
        const q = add(c, 0, -dy, 0);
        const under = cellOf(blockAt(g, add(q, 0, -1, 0)));
        if (under === 'dig' || under === 'solid' || under === 'falls') return q;
        if (under === 'hot') return 'is over lava';
        if (under !== 'open' && under !== 'plant') return 'is over ground not read';
      }
      return 'is in the air';
    };
    /** Where to stand to fight a blaze: a cell a walk reaches (the fortress's ground by its rules) within BLAZE_REACH of it, its eye in sight; the fewest steps. */
    const blazeStance = (e: Seen, reach: Map<string, { from: string | null; n: number }>): Pos | undefined => {
      const at = blazeFloor(e);
      if (typeof at === 'string') return undefined;
      const eye = { x: e.position.x, y: e.position.y + FOE_EYE.blaze, z: e.position.z };
      let best: { p: Pos; n: number } | undefined;
      for (let dx = -BLAZE_REACH; dx <= BLAZE_REACH; dx++) for (let dz = -BLAZE_REACH; dz <= BLAZE_REACH; dz++) for (let dy = -BLAZE_REACH; dy <= 1; dy++) {
        const q = add(at, dx, dy, dz);
        const r = reach.get(cellKey(q));
        if (!r || (best && r.n >= best.n)) continue;
        if (dist3(middleOf(q), e.position) > BLAZE_REACH || across(middleOf(q), e.position) < 1) continue;
        const mine = { x: q.x + 0.5, y: q.y + EYE, z: q.z + 0.5 };
        if (!clearTo(seesThrough(g), eye, mine, floorOf(mine))) continue;
        best = { p: q, n: r.n };
      }
      return best?.p;
    };
    /** A foe in sight to fight: a blaze within 16, a wither skeleton within 8, the nearest; not one fought twice for nothing. */
    const foe = () => ents.filter(e => FOE_RANGE[e.name] !== undefined && e.distance <= FOE_RANGE[e.name] && (missed.get(e.id) ?? 0) < FOE_TRIES &&
      clearTo(seesThrough(g), { x: e.position.x, y: e.position.y + (FOE_EYE[e.name] ?? 1.5), z: e.position.z }, { x: me.x, y: me.y + EYE, z: me.z }, floorOf({ x: me.x, y: me.y + EYE, z: me.z })))
      .sort((a, b) => a.distance - b.distance)[0];
    const fight = async (e: Seen): Promise<boolean> => {
      type Fought = { outcome?: string; kills?: string[]; dropsAt?: Pos; health?: number };
      let r: Fought = {};
      for (let bout = 0; bout < FIGHT_BOUT.bouts; bout++) {
        // (between bouts: the strict rules looked at, and the foe still about)
        if (bout > 0 && !(await watch())) return false;
        if (bout > 0 && !ents.some(x => x.id === e.id)) break;
        r = await ctx.call<Fought>('fight',
          // (that one by its id: the nearest of its kind may be another, behind a wall or on the corridor below, that the
          // brain never saw in sight or judged the ground to)
          { target: `#${e.id}`, maxDistance: FOE_RANGE[e.name], timeoutMs: FIGHT_BOUT.ms, minHealth: FORTRESS_LEAVE, retreat: false }, FIGHT_BOUT.ms + 10_000)
          .catch((x: Error) => ({ outcome: `failed: ${x.message}` } as Fought));
        if (ctx.signal.aborted) throw new Error('aborted');
        if ((r.kills ?? []).length || r.outcome !== 'timeout') break;
      }
      const kills = (r.kills ?? []).length;
      foes += kills;
      if (!kills) {
        missed.set(e.id, (missed.get(e.id) ?? 0) + 1);
        if (missed.get(e.id)! >= FOE_TRIES) ctx.progress(`fortress: the ${e.name} #${e.id} fought ${FOE_TRIES} times for nothing (${r.outcome ?? 'no answer'}): let be`);
      }
      if (kills) ctx.progress(`fortress: killed ${(r.kills ?? []).join(', ')}`);
      if (!(await watch())) return false;
      if (kills) {
        for (let i = 0; i < FORTRESS_WAITS.dropLooks; i++) { await pause(FORTRESS_WAITS.pollMs); if (!(await watch())) return false; }
        if (!(await pickUp(r.dropsAt ? middleOf(r.dropsAt) : undefined))) return false;
        await book();
      }
      return true;
    };
    /** Where to stand to open a chest: a cell a walk reaches whose eye sees the chest's top within 4.3, the fewest steps. */
    const chestStance = (reach: Map<string, { from: string | null; n: number }>, c: Pos): Pos | undefined => {
      let best: { p: Pos; n: number } | undefined;
      const top = { x: c.x + 0.5, y: c.y + 1, z: c.z + 0.5 };
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 1; dy++) {
        const q = add(c, dx, dy, dz);
        const r = reach.get(cellKey(q));
        if (!r || (best && r.n >= best.n)) continue;
        const eye = { x: q.x + 0.5, y: q.y + EYE, z: q.z + 0.5 };
        if (dist3(eye, top) > 4.3 || !clearTo(seesThrough(g), eye, { x: top.x, y: top.y - 0.01, z: top.z }, c)) continue;
        best = { p: q, n: r.n };
      }
      return best?.p;
    };
    type Target = { kind: 'chest' | 'wart' | 'sand'; at: Pos; stand: Pos; n: number };
    /** What it may take next from where it stands: the natural chests, then the wart, then the soul sand under it; the fewest steps first. */
    const targets = (reach: Map<string, { from: string | null; n: number }>): Target[] => {
      const out: Target[] = [];
      for (let iy = 0; iy < g.height; iy++) for (let iz = 0; iz < g.length; iz++) for (let ix = 0; ix < g.width; ix++) {
        const p = { x: g.x + ix, y: g.y + iy, z: g.z + iz };
        const k = cellKey(p);
        if (tried.has(k) || !inZone(p) || !clearOfPlaced(p)) continue;
        const b = blockAt(g, p);
        if (b === 'chest' && chests < FORTRESS_CHESTS_TRIP && !looted.has(k) && naturalChest(g, p)) {
          const st = chestStance(reach, p);
          if (st) out.push({ kind: 'chest', at: p, stand: st, n: reach.get(cellKey(st))!.n });
        } else if (b === 'nether_wart' && warts < FORTRESS_WART_TRIP && wartWanted() && fortressWart(g, p)) {
          const st = digStance(g, reach, p);
          if (st) out.push({ kind: 'wart', at: p, stand: st.at, n: st.n });
        }
      }
      if (sand < FORTRESS_SAND_TRIP && sandShort()) {
        for (const h of harvested) {
          const p = add(h, 0, -1, 0);
          if (tried.has(cellKey(p)) || blockAt(g, p) !== 'soul_sand') continue;
          const st = digStance(g, reach, p);
          // (never from the cell over it: the dig would drop the bot into its hole)
          if (st && !same(st.at, h)) out.push({ kind: 'sand', at: p, stand: st.at, n: st.n });
        }
      }
      return out.sort((a, b) => (a.kind === 'chest' ? 0 : 1) - (b.kind === 'chest' ? 0 : 1) || a.n - b.n);
    };

    // into the fortress's ground from the waypoint, its lava rule kept: a way in only by lava within 2 would need fire resistance
    const here0 = footing(g, me);
    if (!here0) return `no ground under it by the fortress at nether ${fmt(me)}`;
    let waits = 0;
    while (!stop && !gone) {
      if (left() < walked.length * FAR_STEP_MS + BACK_MS + 10_000) { stop = 'the fortress trip\'s time is up'; break; }
      if (!(await watch())) break;
      if (fireShort()) { stop = FIRE_SHORT; unlearnt = true; break; }
      const e = foe();
      if (e) {
        // a blaze out of the swing's reach: walked in to (it holds off while it sees the bot), or let be
        if (e.name === 'blaze' && dist3(e.position, me) > BLAZE_REACH) {
          const reach = reachFrom();
          const st = blazeStance(e, reach);
          if (!st) { const on = blazeFloor(e); letBe(e, typeof on === 'string' ? on : `has no ground it may walk within ${BLAZE_REACH} of it`); continue; }
          const w = await walkIn(pathOf(reach, st));
          if (w === 'gone') { gone = true; break; }
          if (w === 'back') { if (stop || gone) break; continue; }
          if (w === 'stuck') { missed.set(e.id, (missed.get(e.id) ?? 0) + 1); continue; }
          if (!(await watch())) break;
        }
        if (!(await fight(e))) break;
        continue;
      }
      const items = await inventory(ctx);
      if (freeSlots(items) < 1) { stop = 'pockets full (36/36 slots)'; break; }
      const reach = reachFrom();
      const t = targets(reach)[0];
      if (!t) {
        // the ground with the lava rule let go reaches some: fire resistance would be needed there. A potion carried is
        // drunk for it (P4), where it lasts the way back; else back
        const hot = !hotOk() && targets(reachFrom(p => lavaMay(p) && knockSafe(p)))[0];
        if (hot) {
          const why = await drinkFor(`the ${hot.kind} at nether ${fmt(hot.at)}`, 2 * hot.n * FAR_STEP_MS);
          if (!why) continue;
          stop = `fire resistance would be needed (lava within 2 of the way to the ${hot.kind} at nether ${fmt(hot.at)}) and ${why}`;
          break;
        }
        if (rodsWanted() && waits < BLAZE_WAIT_LOOKS) { waits++; await pause(FORTRESS_WAITS.pollMs); continue; }
        return chests || warts || sand || foes ? 'nothing more it may take by the way in' : `nothing it may take within ${FORTRESS_REACH} of where the ${fw.bearing} way meets it`;
      }
      tried.add(cellKey(t.at));
      const w = await walkIn(pathOf(reach, t.stand));
      if (w === 'gone') { gone = true; break; }
      if (w === 'back') { if (stop || gone) break; continue; }
      if (w === 'stuck') continue;
      if (!(await watch())) break;
      if (t.kind === 'chest') {
        const open = await ctx.call<{ items?: Record<string, number> }>('chest.open', { ...t.at }).catch(() => undefined);
        if (ctx.signal.aborted) throw new Error('aborted');
        if (!open) continue;
        chests += 1;
        let emptied = true;
        for (const [name, n] of Object.entries(open.items ?? {})) {
          if (n <= 0) continue;
          if (freeSlots(await inventory(ctx)) <= 1) { emptied = false; break; }
          const r = await ctx.call<{ items?: Record<string, number> }>('chest.withdraw', { name, count: n }).catch(() => undefined);
          if ((r?.items?.[name] ?? 0) > 0) emptied = false;
        }
        await ctx.call('container.close', {}).catch(() => undefined);
        if (emptied) {
          const fm = (netherOf(world).fortress ??= {});
          fm.looted = [...(fm.looted ?? []), { ...t.at }].slice(-FORTRESS_KEPT);
        }
        await book();
        continue;
      }
      const r = await ctx.call<{ dug?: boolean; reason?: string }>('dig.here', { ...t.at, timeoutMs: 10_000 }, 20_000).catch((x: Error) => ({ dug: false, reason: x.message }));
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!r?.dug) continue;
      setOpen(g, t.at);
      if (t.kind === 'wart') { warts += 1; harvested.push(t.at); } else sand += 1;
      for (let i = 0; i < FORTRESS_WAITS.dropLooks; i++) await pause(FORTRESS_WAITS.pollMs);
      if (!(await pickUp(middleOf(t.at)))) break;
      await book();
    }
    return undefined;
  }

  // ---- done: said, back along the cells it walked out (from the one nearest where it stands), and through its own portal
  if (!gone) {
    const now2 = tally(await inventory(ctx));
    for (const [n, c] of now2) {
      const more = c - (before.get(n) ?? 0) - (got.get(n) ?? 0);
      if (more > 0) { got.set(n, (got.get(n) ?? 0) + more); ctx.gain(more); }
    }
  }
  const gain = [...got.values()].reduce((a, b) => a + b, 0);
  const did = gain || foes ? `fortress at nether ${fmt(site)}: ${lootWords(got) || 'nothing brought'}${foes ? ` (${foes} foe${foes === 1 ? '' : 's'} killed)` : ''}` : `nothing from the fortress at nether ${fmt(site)}`;
  if (gain || foes) ctx.progress(`nether: ${did}`);
  const work = gain || foes ? { worked: true as const } : {};
  if (gone || !(await inNether(ctx))) return { gain, text: gain ? `${did}; ${GONE.text}` : GONE.text, ...work };
  if (angry) {
    (netherOf(world).barter ??= {}).held = { day: gameDay(world), at: now(), why: angry.slice(0, 160) };
    ctx.progress(`nether: ${angry}: back to its portal, the barter, the quartz, the scouting, the debris and the fortress held for the day`);
  }
  const said = stop ?? end ?? fortEnd ?? 'done';
  const mark = { ...(unlearnt && !gain ? { mark: 'same' as const } : {}), ...work };
  const back = [...walked].reverse();
  let w: 'ok' | 'stuck' | 'gone' | 'back' = 'stuck';
  for (let i = 0; i < 2 && w === 'stuck'; i++) {
    const st = await ctx.status().catch(() => undefined);
    if (st) fire = fireOf(st);
    const p = floorOf(st?.position ?? me);
    const from = back.reduce((best, c, n) => (dist3(c, p) < dist3(back[best], p) ? n : best), 0);
    // (from where it stands to the nearest cell of the way first: the fortress's ground it walked in over. By lava too
    // where it came in over lava under the potion (back is the only way now), or while the effect lasts that short walk)
    const here = footing(g, p);
    const hotBack = hotWalked || fire * 1000 > FIRE_SPARE_MS;
    if (here && !same(here, back[from])) {
      const reach = walkFrom(g, [here], c => same(c, back[from]) || (!others.some(z => boxGap(z, cellBox(c)) < FROM_BUILDS) && (hotBack || !lavaBy(g, c)) && !overDrop(g, c)));
      if (reach.has(cellKey(back[from]))) await walkAlong(ctx, pathOf(reach, back[from]), STEP);
    }
    w = await walkAlong(ctx, back.slice(from), STEP);
  }
  if (w === 'gone') return { gain, text: `${did}; ${GONE.text}`, ...work };
  if (w !== 'ok') return { gain, text: `${did}; ${said}; stuck on the way back to its hut`, ...mark };
  const b = await backThroughOwn(ctx, arrived, homeShape, now);
  return { gain, text: `${did}; ${said}; ${b.text}`, ...mark, ...(b.cameBack ? { cameBack: true as const } : {}) };
}
