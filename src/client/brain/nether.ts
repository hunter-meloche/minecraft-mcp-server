/**
 * The Nether (P2a of the progression plan): what the brain remembers of it, the server's rules for where a portal
 * leads, the way home from it, and the goal that takes the bot home. All of it waits on the nether-trips switch
 * (`world.nether.trips`, off as it ships): with it off nothing here goes through a portal, and the `leave nether`
 * goal, which brings the bot home whenever it finds itself down there, is the only part that ever runs.
 *
 * Coordinates in the Nether are another place's: lines say `nether (x, y, z)` for them and `overworld (x, y, z)` for
 * the home side. Nothing here is used at the module's top level (it reaches portal.ts, food.ts and pockets.ts, which
 * reach most of the brain).
 */
import { no, type Decline, type Goal, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import { daylightLeft } from './schedule.js';
import { clock } from './idlelog.js';
import { out as afield } from './pockets.js';
import { homePortal, ownPortals, tripsOn } from './portal.js';
import { NETHER_BLOCKS, NETHER_TRIP, netherTripKit, type NetherCheck } from './mine.js';
import { readyFoodPoints } from './food.js';
import { freeChestTotals, storedStacks } from './chests.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** one game tick in real ms (budgets are in ms, times of day in ticks: every sum that mixes them goes through these) */
const MS_PER_TICK = 50;
const ticksToMs = (ticks: number) => ticks * MS_PER_TICK;

export const NETHER = 'the_nether';
export const OVERWORLD = 'overworld';

/** A place in words, to the block: `(x, y, z)` (the lines put `nether` or `overworld` before it). */
const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;

// ------------------------------------------------------------------------------------------------ memory

/** A portal as the bridge lists it (portal.list, foreign.portals): its lowest corner, the axis it spans along, its width along it, its height. */
export interface PortalShape { x: number; y: number; z: number; axis: string; width?: number; height?: number }

/** A death in the Nether: when (real ms) and where (Nether coordinates). */
export interface NetherDeath { at: number; where: Pos }

/**
 * The barter work's own (P3a, netherbarter.ts): the hold for the rest of a game day after a piglin turned on the bot
 * (the game day, the idle tally's, when and why), the gold the gold chore smelted on a game day (at most its 64), and
 * the tossed ingots in a row that lay where they fell while a right click then gave one (the server's mobGriefing off:
 * no mob picks up an item then, a piglin neither): from three on the gold goes by hand first.
 */
export interface BarterMemory {
  held?: { day: number; at: number; why: string };
  smelted?: { day: number; n: number };
  untaken?: number;
}

/**
 * Where the setup trip (P2b, nethersetup.ts) builds the bot's own Nether-side portal: the portal's inside, its lowest
 * corner (as portal.list gives a portal), the axis it spans along, the side of its plane the hut's front room is on
 * (+1 or -1 across the axis) and which of the inside's two columns the hut's door is in front of (0 or 1). Kept for
 * a trip cut short (`world.nether.setupSpot`), with `obsidian`: what of its frame is still to place there.
 */
export interface SetupSpot { x: number; y: number; z: number; axis: 'x' | 'z'; side: 1 | -1; door: 0 | 1; obsidian?: number }

/**
 * How a Nether trip ended, as the work wrapper saw it: home through a portal with the two sides linked and no death
 * after doing its work down there (`clean`: it counts for the stages); the same but turned back before any of its work
 * (`turned back`: a ghast in sight, no piglin, no ore; it counts for nothing, and its trip of the day is given back);
 * home through a portal but not linked, not got home through a portal (`stranded`: the leave nether goal took over), a
 * death on it, or stopped before its end.
 */
export type TripEnd = 'clean' | 'turned back' | 'not linked' | 'stranded' | 'a death' | 'cut short';

/**
 * The fortress trips' own (P3c, netherfortress.ts): `off` once a death came on one (the user's strict rules of Nov 17:
 * the trips there stop for good until the lead switches them back, the nether-trips tool's `fortress`), on top of the
 * death ladder that holds every trip; the trip under way, `from` its start and `to` its end (real ms: a death between
 * the two is a death there, booked by netherTick as the runtime tells it, after the run saw itself gone); the natural
 * chests it emptied (never opened again); the fortresses refused for good, and why (a block only a player puts there
 * within 16 of it, a player seen by it).
 */
export interface FortressMemory {
  off?: { at: number; why: string };
  trip?: { from: number; to?: number };
  looted?: Pos[];
  /** by its site, and the box of its zone as the trip saw it (a later leg logs the same fortress by another middle) */
  refused?: (Pos & { why: string; at: number; box?: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number } })[];
}
/** Chests emptied and fortresses refused, kept at most. */
export const FORTRESS_KEPT = 32;
/**
 * A fortress trip whose end was never written is over this long after its start (real ms): its run's end is written
 * only where it stands out of the Nether, and a restart or a crash mid-trip writes none (live, a trip left open would
 * book any later death down there, a barter's or a quartz trip's, as the fortress's and turn the fortress trips off).
 * The nether rung's run stops at 12 min, and the leave nether walk home after a cut takes some more.
 */
export const FORTRESS_TRIP_CAP_MS = 30 * 60_000;

/** Which way a tunnel's step goes across the ground: north (-z), east (+x), south (+z), west (-x). */
export type Heading = 'n' | 'e' | 's' | 'w';
/**
 * One of its tunnels for ancient debris (P3c, nethertunnel.ts): from `start` (a trunk's mouth on the ground by its
 * portal, or the cell of the trunk a branch leaves it at) by its steps, a letter a step (`way`: n e s w a level step
 * that way, N E S W a step down that way), first `head`; `from`: the trunk a branch leaves (its index in the list:
 * tunnels are never taken out of it, so the index holds); `shut`: why its end goes no further (lava ahead, a cave, its
 * length), so later trips go on from another; `cut`: the first of its cells a walk found unsound (lava come by it),
 * past which it and every branch beyond it are let be; `failed`: the end it stood at when a dig or a step there did
 * not go (a timeout, out of sight, a mob in the way: no verdict on the rock), the trip ended and the tunnel left open
 * for the next; a second failure at that same end shuts it (a real blockage does not come back every trip).
 */
export interface Tunnel { start: Pos; head: Heading; way: string; from?: number; shut?: string; cut?: number; failed?: Pos }
/**
 * Its tunnels from its own portal (`portal`: moved, they are let go), the cobblestone it put in their walls against
 * lava (its own, not someone's), and the debris it dug out of their walls (the holes are its own, no caves).
 */
export interface TunnelMemory { portal: Pos; list: Tunnel[]; plugs?: Pos[]; dug?: Pos[] }
/** Tunnels kept at most, the steps of one, and its own plugs (and the debris holes). */
export const TUNNELS_KEPT = 24;
export const TUNNEL_STEPS = 160;
export const PLUGS_KEPT = 64;

/** Kept in brain.json per world (`world.nether`). */
export interface NetherMemory {
  /** the nether-trips switch: anything that goes through a portal waits for it (off, undefined, as it ships) */
  trips?: boolean;
  /** the stage the trips have reached (the ramp, NETHER_STAGES: the nether rung's work opens by it): 0 to start */
  stage: number;
  /**
   * clean trips counted for the stages (NETHER_STAGES): home through a portal, the two sides linked, no death on it, its
   * work done down there (P3b: one turned back before any counts for nothing). Never less than the stage's own count: a
   * death in the Nether drops the stage and puts this back to that stage's
   */
  stageTrips: number;
  /** Nether trips in a row that ended with no death (the probation's; one turned back before its work counts for nothing) */
  cleanTrips: number;
  /** the last Nether trip that went (one that never set out is not one): when it ended, its line, how (brain-status) */
  lastTrip?: { at: number; text: string; end: TripEnd };
  /** the death in the Nether (its time) the regear has seen to: the spare set is put on once a death (regear.ts) */
  regearedFor?: number;
  /** deaths in the Nether, the last 3 days: the holds read them (a death 1 h, two in 24 h a day, three in 3 days off) */
  deaths: NetherDeath[];
  /** real times the Nether trips set out, the last 24 h: the probation's hour */
  starts: number[];
  /** the game day (the idle tally's) and the trips made on it: at most NETHER_PER_DAY */
  tripsToday?: { day: number; n: number };
  /** the bot's own Nether-side portal (P2b builds it at netherPortalSpot), a block of it */
  portal?: Pos;
  /** the home portal and the Nether-side one lead to each other (P2b checks it both ways) */
  linked?: boolean;
  /**
   * the setup trip waits until `until` (real ms), and why: it came out in someone's build with no way out on foot,
   * found no spot for its own portal, or its own portal led back elsewhere. A day: the lead looks in between
   */
  setupHold?: { until: number; why: string };
  /** the spot the setup trip chose for its own portal and hut, kept until the portal stands: a trip cut short goes on there */
  setupSpot?: SetupSpot;
  /**
   * spots for its own portal that a look again on the spot found would not do, and why: never chosen again (live on
   * Nov 14 a re-plan at nether (-77, 91, 269) read "lava or fire by it"; kept, the next trip would have gone back to it
   * first, as the spot chosen before). The last REFUSED_SPOTS of them
   */
  refusedSpots?: (SetupSpot & { why: string; at: number })[];
  /** where the bot stood at its first look in the Nether this time in, and when: the way home with no portal of its own */
  arrival?: Pos;
  enteredAt?: number;
  /** the dimension of the last look (a change to the Nether is an arrival) */
  seenIn?: string;
  /** the lit portals seen that are not its own, by dimension (the bridge keeps its own list for a client session only) */
  seen?: Record<string, PortalShape[]>;
  /**
   * places found down there (the look from its hut, P3b's scouting legs: fortresses, bastions, others' builds, lava
   * lakes, the biomes it walked into, ancient debris with a face open to air); `leg`: the bearing of the scouting leg
   * that found it, whose way leads there (a debris trip goes out by it, netherdebris.ts)
   */
  sites: { kind: string; x: number; y: number; z: number; at?: number; leg?: Bearing }[];
  /** the scouting legs walked out from its own portal (P3b, netherscout.ts), one a bearing: the newest kept */
  legs?: ScoutLeg[];
  /** the barter work's hold, the gold chore's day, how the gold is given (P3a: netherbarter.ts) */
  barter?: BarterMemory;
  /** the fortress trips' switch after a death, the trip under way, the chests emptied, the fortresses refused (P3c: netherfortress.ts) */
  fortress?: FortressMemory;
  /** its tunnels for ancient debris at y 8-22, from its own portal: later trips go on from them (P3c: nethertunnel.ts) */
  tunnels?: TunnelMemory;
  /**
   * the golden helmet as the last look down there saw it, carried or worn: its durability left of all of it, and when.
   * Gone at a later look with no death since, it broke (netherTick says so); let go of once it is seen home with it
   */
  helmet?: { left: number; max: number; at: number };
}

/**
 * The eight bearings the scouting legs go out along (netherscout.ts), the compass order: across the ground, north
 * being -z and east +x as the game has them.
 */
export const BEARINGS = [
  { name: 'north', dx: 0, dz: -1 }, { name: 'north-east', dx: 1, dz: -1 }, { name: 'east', dx: 1, dz: 0 }, { name: 'south-east', dx: 1, dz: 1 },
  { name: 'south', dx: 0, dz: 1 }, { name: 'south-west', dx: -1, dz: 1 }, { name: 'west', dx: -1, dz: 0 }, { name: 'north-west', dx: -1, dz: -1 }
] as const;
export type Bearing = typeof BEARINGS[number]['name'];
const isBearing = (v: unknown): v is Bearing => BEARINGS.some(b => b.name === v);

/**
 * A scouting leg (P3b): along which bearing, when it ended (real ms), how far out it got along it (blocks from its
 * portal), why it turned back there, and the way it took: waypoints of the cells it walked out, from its hut on, a
 * few blocks apart (each a cell it stood on, the next a careful walk of a few steps on), so a later trip can follow
 * a known way out there.
 */
export interface ScoutLeg { bearing: Bearing; at: number; reach: number; end: string; way: Pos[] }
/** A leg's waypoints kept at most. */
export const WAYPOINTS = 16;

/** A golden helmet's durability (26.3's ArmorMaterials.GOLD: 7 x 11 for a helmet), where the inventory says none. */
const GOLDEN_HELMET_DURABILITY = 77;

/** Spots of its own portal refused, kept (the oldest let go). */
export const REFUSED_SPOTS = 16;
/**
 * Deaths kept (3 days' worth at most), starts (24 h), portals seen per dimension, sites (the look's and eight legs'
 * of scouting, some four a leg: noteSites lets the lesser kinds go first).
 */
const DEATHS = 32;
const STARTS = 64;
const SEEN = 16;
export const SITES = 32;

// ------------------------------------------------------------------------------------------------ the stages

/** Potions of fire resistance in stock for the bastion (P6): one drunk for it, one more for the way back. */
export const FIRE_POTIONS = 2;

/**
 * The stage ramp (P2b of the progression plan). Stage 0 is the setup (its own Nether-side portal, linked) and then a
 * short look from its hut; each stage after it opens once the clean trips reach its count: 1 after 2 (P3a: barter,
 * quartz), 2 after 4 (P3b: debris, scout), 3 after 6 (P3c: the fortress, the tunnelling for debris; P6: the bastion). A clean trip is one that did
 * its work down there (netherEnd): live on Nov 15 stage 2 came of a barter and a quartz trip that went through to the
 * hut and straight back (ghasts 20 and 12 off), which had shown nothing of what stage 2 asks of the bot.
 *
 * `work` says what each kind of work opened at a stage needs besides (the nether rung's work reads it: worktasks.ts
 * NETHER_WORK): the fortress no potion (the user's decision 6 of Nov 17, "go with strict rules": its own rules in
 * netherfortress.ts; stage 3 waited on 2 potions of fire resistance from Nov 15, and the potions wait on the brewing
 * stand, which waits on the fortress's blaze rods), the bastion FIRE_POTIONS in stock (P6: one drunk for it). The
 * debris drinks one too, and the tunnelling for it at y 8-22 (P3c, the user's decision 5 of Nov 17): their own ready
 * says so (netherdebris.ts, nethertunnel.ts).
 */
export const NETHER_STAGES: readonly { stage: number; trips: number; work: Readonly<Record<string, { potions?: number }>> }[] = [
  { stage: 1, trips: 2, work: { barter: {}, quartz: {} } },
  { stage: 2, trips: 4, work: { scout: {}, debris: {} } },
  { stage: 3, trips: 6, work: { fortress: {}, tunnel: {}, bastion: { potions: FIRE_POTIONS } } }
];

/** What a kind of work down there needs by the ramp, pure: the stage it opens at and the potions of fire resistance in stock it waits on (0: none). Undefined for a kind the ramp does not open (stage 0's setup and look). */
export function stageNeeds(work: string): { stage: number; potions: number } | undefined {
  const at = NETHER_STAGES.find(s => Object.hasOwn(s.work, work));
  return at && { stage: at.stage, potions: at.work[work].potions ?? 0 };
}

/** The clean trips a stage stands at (0 for stage 0): where a death in the Nether puts the count back to. */
export const tripsForStage = (stage: number): number => (stage <= 0 ? 0 : NETHER_STAGES[Math.min(stage, NETHER_STAGES.length) - 1].trips);

/** A drinkable potion of fire resistance, by its contents (never by its name: every potion is `potion`): what the debris trip drinks (netherdebris.ts). */
export const isFirePotion = (i: { name: string; potion?: string }) => i.name === 'potion' && /(^|_)fire_resistance$/.test(i.potion ?? '');

/** Potions carried and in the home chests (by their stacks, as last seen) that `is` takes. */
const firePotionsOf = (items: { name: string; count: number; potion?: string }[], world: WorldMemory, is: (i: { name: string; potion?: string }) => boolean): number =>
  items.filter(is).reduce((a, i) => a + i.count, 0) + storedStacks(world, is).reduce((a, f) => a + f.stack.count, 0);

/** Potions of fire resistance to drink, carried and in the home chests (by their stacks, as last seen). */
export function firePotions(items: { name: string; count: number; potion?: string }[], world: WorldMemory): number {
  return firePotionsOf(items, world, isFirePotion);
}

// ------------------------------------------------------------------------------------------------ the stock

/**
 * What the Nether work keeps at home (P3a of the progression plan), carried and in the chests together: potions of
 * fire resistance until the brewing stand makes them (P4), soul sand for the wart farm, leather for the books, obsidian
 * for a portal made again, ender pearls, and quartz. The barter brings every one of them (quartz too, a few at a time:
 * the quartz work mines it, 32 a trip); what else it brings (gravel, blackstone, nuggets, string, spectral arrows,
 * fire charges, soul speed books or boots) is the stash's to keep or put away, by its own rules.
 *
 * Fire resistance 12, up from 4 (D1, the user's "prioritize getting fire resistance gear for nether in general"): a
 * day's use is 6 (one carried on each of the day's two trips for the Guardian's hook, NETHER_TRIP.firePotions; the
 * debris trip's DEBRIS_POTIONS 2, drunk; the bastion's FIRE_POTIONS 2; the fortress drinks the one it carries only where lava is by its
 * way, P4), and twice that keeps a day of use from
 * emptying the stock. The barter goes on while any target is short (netherShort), so the potions keep it bartering
 * after the rest are met: about 3.4 in 100 barters bring one (the 26.3 jar's piglin_bartering: its two fire resistance
 * entries, 8 + 8 of 469), some two a day at the gold chore's 64 ingots.
 */
export const NETHER_STOCK = { fire_resistance: 12, soul_sand: 16, leather: 16, obsidian: 20, ender_pearl: 16, quartz: 64 } as const;
export type NetherStockKind = keyof typeof NETHER_STOCK;

/**
 * A potion of fire resistance in any of its forms (drunk, splash or lingering: the barter throws both of the first),
 * by its contents, plain or long: never by its name.
 */
export const anyFirePotion = (i: { name: string; potion?: string }) =>
  /^(potion|splash_potion|lingering_potion)$/.test(i.name) && /(^|_)fire_resistance$/.test(i.potion ?? '');

/**
 * How much of a Nether stock kind the home has: carried (the off hand and the armour slots too) and in the chests
 * beyond what the build jobs and the missions hold there; the potions by their stacks as last seen (a chest that
 * answered in text holds none that can be told).
 */
export function netherStock(kind: NetherStockKind, s: Pick<Snapshot, 'items' | 'counts'>, world: WorldMemory, free = freeChestTotals(world)): number {
  if (kind === 'fire_resistance') return firePotionsOf(s.items, world, anyFirePotion);
  return (s.counts.get(kind) ?? 0) + (free[kind] ?? 0);
}

/** The stock kinds of `kinds` under their targets, each with what the home has: the first short first, in NETHER_STOCK's order. */
export function netherShort(s: Pick<Snapshot, 'items' | 'counts'>, world: WorldMemory, kinds: readonly NetherStockKind[] = Object.keys(NETHER_STOCK) as NetherStockKind[]):
  { kind: NetherStockKind; have: number; want: number }[] {
  const free = freeChestTotals(world);
  return kinds.map(kind => ({ kind, have: netherStock(kind, s, world, free), want: NETHER_STOCK[kind] as number })).filter(k => k.have < k.want);
}

/** A stock kind in words: `fire resistance` for the potions, the item's name for the rest. */
export const stockName = (kind: NetherStockKind) => (kind === 'fire_resistance' ? 'fire resistance' : kind);

/** The longest line kept of the last trip. */
const TRIP_TEXT = 200;
const ENDS: readonly string[] = ['clean', 'turned back', 'not linked', 'stranded', 'a death', 'cut short'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const posOf = (v: unknown): Pos | undefined => (isObj(v) && fin(v.x) && fin(v.y) && fin(v.z) ? { x: v.x, y: v.y, z: v.z } : undefined);
const shapeOf = (v: unknown): PortalShape | undefined => {
  if (!isObj(v) || !fin(v.x) || !fin(v.y) || !fin(v.z) || (v.axis !== 'x' && v.axis !== 'z')) return undefined;
  return { x: v.x, y: v.y, z: v.z, axis: v.axis, ...(fin(v.width) && v.width > 0 ? { width: v.width } : {}), ...(fin(v.height) && v.height > 0 ? { height: v.height } : {}) };
};

/** A Nether memory as it must be, from whatever brain.json held (nothing, P2a's first `{ trips }`, or something half written). */
function clean(raw: unknown): NetherMemory {
  const r = isObj(raw) ? raw : {};
  const stage = fin(r.stage) && r.stage > 0 ? Math.min(Math.floor(r.stage), NETHER_STAGES.length) : 0;
  const m: NetherMemory = {
    stage,
    // (a stage with fewer clean trips than its own count, from a file before the ramp or a hand's edit: its count)
    stageTrips: Math.max(tripsForStage(stage), fin(r.stageTrips) && r.stageTrips > 0 ? Math.floor(r.stageTrips) : 0),
    cleanTrips: fin(r.cleanTrips) && r.cleanTrips > 0 ? Math.floor(r.cleanTrips) : 0,
    deaths: (Array.isArray(r.deaths) ? r.deaths : []).flatMap(d => {
      const where = isObj(d) ? posOf(d.where) : undefined;
      return isObj(d) && fin(d.at) && where ? [{ at: d.at, where }] : [];
    }).slice(-DEATHS),
    starts: (Array.isArray(r.starts) ? r.starts : []).filter(fin).slice(-STARTS),
    sites: (Array.isArray(r.sites) ? r.sites : []).flatMap(p => (isObj(p) && typeof p.kind === 'string' && posOf(p)
      ? [{ kind: p.kind, ...posOf(p)!, ...(fin(p.at) ? { at: p.at } : {}), ...(isBearing(p.leg) ? { leg: p.leg } : {}) }] : [])).slice(0, SITES)
  };
  if (Array.isArray(r.legs)) {
    // (one a bearing, the newest: a file a hand edited may hold two)
    const legs = (r.legs as unknown[]).flatMap(l => {
      if (!isObj(l) || !isBearing(l.bearing) || !fin(l.at) || !fin(l.reach)) return [];
      const way = (Array.isArray(l.way) ? l.way : []).map(posOf).filter((p): p is Pos => !!p).slice(0, WAYPOINTS);
      return [{ bearing: l.bearing, at: l.at, reach: Math.max(0, Math.round(l.reach)), end: typeof l.end === 'string' ? l.end.slice(0, TRIP_TEXT) : '', way }];
    }).sort((a, b) => b.at - a.at).filter((l, i, all) => all.findIndex(o => o.bearing === l.bearing) === i);
    if (legs.length) m.legs = legs;
  }
  if (typeof r.trips === 'boolean') m.trips = r.trips;
  const t = r.tripsToday;
  if (isObj(t) && fin(t.day) && fin(t.n)) m.tripsToday = { day: t.day, n: Math.max(0, Math.floor(t.n)) };
  const portal = posOf(r.portal);
  if (portal) m.portal = portal;
  if (typeof r.linked === 'boolean') m.linked = r.linked;
  const hold = r.setupHold;
  if (isObj(hold) && fin(hold.until)) m.setupHold = { until: hold.until, why: typeof hold.why === 'string' ? hold.why : '' };
  const isSpot = (s: unknown): s is SetupSpot => isObj(s) && !!posOf(s) && (s.axis === 'x' || s.axis === 'z') && (s.side === 1 || s.side === -1) && (s.door === 0 || s.door === 1);
  const spot = r.setupSpot;
  if (isSpot(spot)) {
    m.setupSpot = { ...posOf(spot)!, axis: spot.axis, side: spot.side, door: spot.door };
    // (a frame's 10 at most)
    if (fin(spot.obsidian) && Number.isInteger(spot.obsidian) && spot.obsidian >= 0 && spot.obsidian <= 10) m.setupSpot.obsidian = spot.obsidian;
  }
  if (Array.isArray(r.refusedSpots)) {
    const refused = (r.refusedSpots as unknown[]).flatMap(s => {
      if (!isSpot(s)) return [];
      const { why, at } = s as unknown as { why?: unknown; at?: unknown };
      return fin(at) ? [{ ...posOf(s)!, axis: s.axis, side: s.side, door: s.door, why: typeof why === 'string' ? why : '', at }] : [];
    });
    if (refused.length) m.refusedSpots = refused.slice(-REFUSED_SPOTS);
  }
  const last = r.lastTrip;
  if (isObj(last) && fin(last.at) && typeof last.text === 'string' && typeof last.end === 'string' && ENDS.includes(last.end)) {
    m.lastTrip = { at: last.at, text: last.text.slice(0, TRIP_TEXT), end: last.end as TripEnd };
  }
  if (fin(r.regearedFor)) m.regearedFor = r.regearedFor;
  const b = r.barter;
  if (isObj(b)) {
    const barter: BarterMemory = {};
    const held = b.held, smelted = b.smelted;
    if (isObj(held) && fin(held.day) && fin(held.at)) barter.held = { day: held.day, at: held.at, why: typeof held.why === 'string' ? held.why.slice(0, TRIP_TEXT) : '' };
    if (isObj(smelted) && fin(smelted.day) && fin(smelted.n)) barter.smelted = { day: smelted.day, n: Math.max(0, Math.floor(smelted.n)) };
    if (fin(b.untaken) && b.untaken > 0) barter.untaken = Math.floor(b.untaken);
    if (Object.keys(barter).length) m.barter = barter;
  }
  const f = r.fortress;
  if (isObj(f)) {
    const fortress: FortressMemory = {};
    if (isObj(f.off) && fin(f.off.at)) fortress.off = { at: f.off.at, why: typeof f.off.why === 'string' ? f.off.why.slice(0, TRIP_TEXT) : '' };
    if (isObj(f.trip) && fin(f.trip.from)) fortress.trip = { from: f.trip.from, ...(fin(f.trip.to) ? { to: f.trip.to } : {}) };
    const looted = (Array.isArray(f.looted) ? f.looted : []).map(posOf).filter((p): p is Pos => !!p).slice(-FORTRESS_KEPT);
    if (looted.length) fortress.looted = looted;
    const refused = (Array.isArray(f.refused) ? f.refused : []).flatMap(x => {
      const p = posOf(x);
      if (!p || !isObj(x) || !fin(x.at)) return [];
      const b = x.box;
      const box = isObj(b) && fin(b.x1) && fin(b.y1) && fin(b.z1) && fin(b.x2) && fin(b.y2) && fin(b.z2) ? { x1: b.x1, y1: b.y1, z1: b.z1, x2: b.x2, y2: b.y2, z2: b.z2 } : undefined;
      return [{ ...p, why: typeof x.why === 'string' ? x.why.slice(0, TRIP_TEXT) : '', at: x.at, ...(box ? { box } : {}) }];
    }).slice(-FORTRESS_KEPT);
    if (refused.length) fortress.refused = refused;
    if (Object.keys(fortress).length) m.fortress = fortress;
  }
  const tn = r.tunnels;
  const tportal = isObj(tn) ? posOf(tn.portal) : undefined;
  if (isObj(tn) && tportal) {
    // (in order, up to the first one that is not sound: a branch names its trunk by its place in the list)
    const list: Tunnel[] = [];
    for (const x of Array.isArray(tn.list) ? tn.list.slice(0, TUNNELS_KEPT) : []) {
      const s = isObj(x) ? posOf(x.start) : undefined;
      if (!isObj(x) || !s || typeof x.head !== 'string' || !/^[nesw]$/.test(x.head) || typeof x.way !== 'string' || !/^[nesw]*$/i.test(x.way)) break;
      const from = fin(x.from) && Number.isInteger(x.from) && x.from >= 0 && x.from < list.length ? x.from : undefined;
      if (x.from !== undefined && from === undefined) break;
      list.push({
        start: s, head: x.head as Heading, way: x.way.slice(0, TUNNEL_STEPS), ...(from !== undefined ? { from } : {}),
        ...(typeof x.shut === 'string' ? { shut: x.shut.slice(0, TRIP_TEXT) } : {}), ...(fin(x.cut) && x.cut >= 0 ? { cut: Math.floor(x.cut) } : {}),
        ...(posOf(x.failed) ? { failed: posOf(x.failed)! } : {})
      });
    }
    const kept = (v: unknown) => (Array.isArray(v) ? v : []).map(posOf).filter((p): p is Pos => !!p).slice(-PLUGS_KEPT);
    const plugs = kept(tn.plugs), dug = kept(tn.dug);
    m.tunnels = { portal: tportal, list, ...(plugs.length ? { plugs } : {}), ...(dug.length ? { dug } : {}) };
  }
  const arrival = posOf(r.arrival);
  if (arrival) m.arrival = arrival;
  if (fin(r.enteredAt)) m.enteredAt = r.enteredAt;
  if (typeof r.seenIn === 'string') m.seenIn = r.seenIn;
  if (isObj(r.seen)) {
    const seen: Record<string, PortalShape[]> = {};
    for (const [dim, list] of Object.entries(r.seen)) {
      const kept = (Array.isArray(list) ? list : []).map(shapeOf).filter((p): p is PortalShape => !!p).slice(0, SEEN);
      if (kept.length) seen[dim] = kept;
    }
    if (Object.keys(seen).length) m.seen = seen;
  }
  const h = r.helmet;
  if (isObj(h) && fin(h.left) && fin(h.max) && fin(h.at)) m.helmet = { left: h.left, max: h.max, at: h.at };
  return m;
}

/** the memories this process has made or checked: written by the writers below from then on */
const sound = new WeakSet<object>();

/**
 * The world's Nether memory, made on first use and put right where brain.json holds something else. For the writers
 * only (the switch, the tick, a trip's start and end): the gates read through peekNether.
 */
export function netherOf(world: WorldMemory): NetherMemory {
  const n: unknown = world.nether;
  if (isObj(n) && sound.has(n)) return n as unknown as NetherMemory;
  const m = clean(n);
  sound.add(m);
  world.nether = m;
  return m;
}

/** The same for a gate: what is there, read and never written (a memory not yet checked is read as a checked copy). */
export function peekNether(world: WorldMemory): NetherMemory {
  const n: unknown = world.nether;
  return isObj(n) && sound.has(n) ? n as unknown as NetherMemory : clean(n);
}

/** The game day as the work queue counts it (the idle tally's day number): the trips per day go by it. */
export const gameDay = (world: WorldMemory): number => { const d: unknown = world.idle?.today?.day; return fin(d) ? d : 0; };

/**
 * The barter work's hold after a piglin turned on the bot (netherbarter.ts), while it holds: for the rest of that game
 * day, and never past a real day (a tally that stood still would hold it for good). A look only. The quartz work by
 * the same portal keeps it too, and writes it the same way (netherquartz.ts): the same piglins round the same hut.
 */
export function barterHold(world: WorldMemory, now: number): { why: string; at: number } | undefined {
  const h = peekNether(world).barter?.held;
  return h && h.day === gameDay(world) && now - h.at < DAY && now >= h.at ? { why: h.why, at: h.at } : undefined;
}

// ------------------------------------------------------------------------------------------------ where a portal leads

/**
 * Where the server looks for the far end of a portal from a point: the point scaled (an eighth into the Nether, eight
 * times back out), its height kept, to the block (floored, as the server's BlockPos.containing). Checked in the 26.3
 * jar: NetherPortalBlock.getPortalDestination scales the entity's own position by DimensionType.getTeleportationScale
 * (1/8 into the Nether, 8 back) and clamps it to the world border. For a block the bot stands in, into the Nether this
 * is exact (anywhere in the block floors the same); back out it is the block's lowest corner, and the bot's place in
 * the block can put it up to 7 further along x and z.
 */
export function scaled(p: Pos, to: string): Pos {
  const s = to === NETHER ? 1 / 8 : 8;
  return { x: Math.floor(p.x * s), y: Math.floor(p.y), z: Math.floor(p.z * s) };
}

/** A portal's blocks (a rectangle: 2 wide and 3 high unless it says otherwise). */
export function portalCells(p: PortalShape): Pos[] {
  const w = p.width ?? 2, h = p.height ?? 3;
  const out: Pos[] = [];
  for (let up = 0; up < h; up++) for (let a = 0; a < w; a++) out.push(p.axis === 'z' ? { x: p.x, y: p.y + up, z: p.z + a } : { x: p.x + a, y: p.y + up, z: p.z });
  return out;
}

/** Its bottom row: the cells the bot stands in as it goes through. */
const bottomCells = (p: PortalShape) => portalCells(p).filter(c => c.y === p.y);

const d2 = (a: Pos, b: Pos) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const square = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

/** How far round the scaled point the server looks for a portal: into the Nether, and back out (PortalForcer). */
export const SEARCH = { [NETHER]: 16, [OVERWORLD]: 128 } as Record<string, number>;

/**
 * The portal the server takes for the far end from `from` (a point already scaled into the dimension the `portals`
 * stand in): of every portal block within `radius` of it in x and in z (a square, at any height), the nearest by
 * straight-line distance, a tie to the lower one. Checked in the 26.3 jar: PortalForcer.findClosestPortalPosition
 * (PoiManager.getInSquare with radius 16 going into the Nether and 128 going out, Comparator distSqr then y). A tie
 * at the same height goes to the portal listed first here (the server's own order is not to be counted on: a caller
 * puts first the one a tie must not be given to). Undefined with none within the square: the server would make a
 * portal of its own there.
 */
export function linkedTo<P extends PortalShape>(from: Pos, portals: P[], radius: number): { portal: P; block: Pos; d2: number } | undefined {
  let best: { portal: P; block: Pos; d2: number } | undefined;
  for (const portal of portals) {
    for (const block of portalCells(portal)) {
      if (square(block, from) > radius) continue;
      const d = d2(block, from);
      if (!best || d < best.d2 || (d === best.d2 && block.y < best.block.y)) best = { portal, block, d2: d };
    }
  }
  return best;
}

/** Where the bot can stand in a Nether portal, scaled out (the corners and the middle of where the server's point can fall). */
function outPoints(p: PortalShape): Pos[] {
  const w = p.width ?? 2;
  // along the portal the bot is anywhere in its bottom row (0.3 in from each end: its half width), across it within
  // its one block (0.3 to 0.7): eight times that, floored
  const along = [Math.floor(8 * 0.3), Math.floor(8 * w / 2), Math.floor(8 * (w - 0.3))];
  const across = [Math.floor(8 * 0.3), Math.floor(8 * 0.7)];
  const out: Pos[] = [];
  for (const a of along) for (const c of across) out.push(p.axis === 'z' ? { x: 8 * p.x + c, y: p.y, z: 8 * p.z + a } : { x: 8 * p.x + a, y: p.y, z: 8 * p.z + c });
  return out;
}

/** Where the server looks from an overworld portal into the Nether: each of its bottom cells scaled (exact). */
const inPoints = (p: PortalShape): Pos[] => bottomCells(p).map(c => scaled(c, NETHER));

/** How far a portal must keep from the scaled point of an overworld portal whose Nether side is not known. */
export const UNKNOWN_SIDE = 24;

/** The three rules of netherPortalSpot, by name: the one a spot breaks first, and how. */
export type SpotRule = 'the home portal leads elsewhere' | "it takes someone's link" | 'it does not lead back home';

function spotRule(spot: PortalShape, home: PortalShape, netherPortals: PortalShape[], overworldPortals: PortalShape[]): { rule: SpotRule; text: string } | null {
  // (a) the home portal, entered from the overworld, comes out at it: it is the nearest within 16 of each point the
  // server can look from (a tie goes to the other: listed first)
  for (const p of inPoints(home)) {
    const won = linkedTo(p, [...netherPortals, spot], SEARCH[NETHER]);
    if (won?.portal !== spot) {
      return { rule: 'the home portal leads elsewhere', text: won ? `the home portal would come out at the nether portal at nether ${fmt(won.portal)}` : `more than ${SEARCH[NETHER]} from home's scaled point nether ${fmt(p)}` };
    }
  }
  // (b) it takes no one's link: an overworld portal whose Nether side is known keeps it (a tie would be the new
  // one's: listed first), and one whose Nether side is not known is kept clear of by UNKNOWN_SIDE
  for (const f of overworldPortals) {
    for (const p of inPoints(f)) {
      const theirs = linkedTo(p, netherPortals, SEARCH[NETHER]);
      if (theirs) {
        if (linkedTo(p, [spot, ...netherPortals], SEARCH[NETHER])?.portal === spot) {
          return { rule: "it takes someone's link", text: `it would take the link of the portal at overworld ${fmt(f)} (its nether side at nether ${fmt(theirs.portal)})` };
        }
      } else if (portalCells(spot).some(c => square(c, p) < UNKNOWN_SIDE)) {
        return { rule: "it takes someone's link", text: `within ${UNKNOWN_SIDE} of nether ${fmt(p)}, where the portal at overworld ${fmt(f)} leads (its nether side not seen)` };
      }
    }
  }
  // (c) and back: from anywhere the bot can stand in it, the home portal is the nearest within 128 of where the
  // server looks (a tie goes to the other: listed first)
  for (const q of outPoints(spot)) {
    const back = linkedTo(q, [...overworldPortals, home], SEARCH[OVERWORLD]);
    if (back?.portal !== home) {
      return { rule: 'it does not lead back home', text: back ? `back through it the bot would come out at the portal at overworld ${fmt(back.portal)}` : `the home portal is more than ${SEARCH[OVERWORLD]} from overworld ${fmt(q)}` };
    }
  }
  return null;
}

/** Why `spot` (a portal of the bot's own on the Nether side) would not do, or null: the three rules of netherPortalSpot. */
export function spotFault(spot: PortalShape, home: PortalShape, netherPortals: PortalShape[], overworldPortals: PortalShape[]): string | null {
  return spotRule(spot, home, netherPortals, overworldPortals)?.text ?? null;
}

/**
 * Where the bot's own Nether-side portal goes (P2b builds it): pure. Of the 2 x 3 portals (either way round, standing
 * at `ys`, default the home portal's own height) within 16 of home's scaled point, the one nearest it that (a) the
 * home portal leads to when entered from the overworld, nearer that point than every Nether portal known (the
 * community's Nether side is some 14 from it: as things stand the home portal comes out there); (b) takes no one's
 * link: for every overworld portal known, its own Nether side stays the nearer to where it leads, and one whose
 * Nether side is not known is kept UNKNOWN_SIDE (24) clear of where it leads; and (c) leads back to the home portal.
 * `home`: the home portal (its lowest corner, axis, size, as portal.list gives it); the others are the portals known
 * that are not the bot's own, in the Nether and in the overworld. The spot is the portal's lowest corner and its
 * axis, with why it was chosen, or none and why.
 */
export function netherPortalSpot(home: PortalShape, netherPortals: PortalShape[], overworldPortals: PortalShape[], opts: { ys?: number[] } = {}):
  { spot?: Pos & { axis: 'x' | 'z' }; why: string } {
  const p = inPoints(home)[0] ?? scaled(home, NETHER);
  const ys = opts.ys?.length ? opts.ys : [p.y];
  const r = SEARCH[NETHER];
  const faults = new Map<SpotRule, number>();
  const found: { spot: PortalShape & { axis: 'x' | 'z' }; d: number }[] = [];
  for (const y of ys) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const axis of ['x', 'z'] as const) {
    const spot = { x: p.x + dx, y, z: p.z + dz, axis, width: 2, height: 3 };
    const fault = spotRule(spot, home, netherPortals, overworldPortals);
    if (fault) { faults.set(fault.rule, (faults.get(fault.rule) ?? 0) + 1); continue; }
    found.push({ spot, d: Math.min(...portalCells(spot).map(c => d2(c, p))) });
  }
  found.sort((a, b) => a.d - b.d || Math.abs(a.spot.x - p.x) + Math.abs(a.spot.z - p.z) - (Math.abs(b.spot.x - p.x) + Math.abs(b.spot.z - p.z)) ||
    a.spot.y - b.spot.y || a.spot.x - b.spot.x || a.spot.z - b.spot.z || (a.spot.axis === 'x' ? -1 : 1));
  const best = found[0];
  const known = `${netherPortals.length} nether and ${overworldPortals.length} overworld portal(s) known`;
  if (!best) {
    const why = [...faults].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n} spots)`).join('; ');
    return { why: `no spot within ${r} of home's scaled point nether ${fmt(p)} will do (${known}): ${why || 'none tried'}` };
  }
  const s = best.spot;
  return {
    spot: { x: s.x, y: s.y, z: s.z, axis: s.axis },
    why: `nether ${fmt(s)} along ${s.axis}, ${Math.sqrt(best.d).toFixed(1)} from home's scaled point nether ${fmt(p)}: the home portal leads to it, ` +
      `it takes no one's link and it leads back home (${known})`
  };
}

// ------------------------------------------------------------------------------------------------ its own portals

/**
 * The portals the bridge is told are the bot's own (portal.own: nothing then counts them as anyone's build): the home
 * portal (portal.ts) and its Nether-side one once it has it. The protection sync sends the list whenever it changes
 * or the bridge's status says it has none (a client restart).
 */
export function allOwnPortals(world: WorldMemory): { dimension: string; x: number; y: number; z: number }[] {
  const own = peekNether(world).portal;
  return [...ownPortals(world), ...(own ? [{ dimension: NETHER, ...own }] : [])];
}

/**
 * Remember the lit portals that are not its own seen in a dimension (the bridge's foreign.portals): the bridge keeps
 * them for a client session only, and netherPortalSpot needs the community's both sides, seen far apart and days
 * apart. A portal at the same lowest corner is the same one again; the newest first, SEEN a dimension. One by a
 * portal of its own (2 blocks) is left out: before the bridge has the list of its own (a restart) it may show them.
 */
export function notePortals(world: WorldMemory, dimension: string, portals: PortalShape[]): void {
  const fresh = portals.map(shapeOf).filter((p): p is PortalShape => !!p);
  const own = allOwnPortals(world).filter(o => o.dimension === dimension);
  const mine = (p: PortalShape) => own.some(o => portalCells(p).some(c => square(c, o) <= 2 && Math.abs(c.y - o.y) <= 3));
  const kept = peekNether(world).seen?.[dimension] ?? [];
  const same = (a: PortalShape, b: PortalShape) => a.x === b.x && a.y === b.y && a.z === b.z;
  const next = [...fresh.filter(p => !mine(p)), ...kept.filter(k => !fresh.some(p => same(p, k)) && !mine(k))].slice(0, SEEN);
  // (nothing new: nothing written, and a world that has seen no portal keeps no Nether memory for it)
  if (JSON.stringify(next) === JSON.stringify(kept)) return;
  (netherOf(world).seen ??= {})[dimension] = next;
}

/**
 * A place found down there: a natural `fortress` or `bastion`, someone's `build`, a `lava` lake, the `exit` of its
 * hut, a biome a scouting leg walked into (`soul_sand_valley`, `crimson_forest`, `warped_forest`), an
 * `ancient_debris` a scouting leg saw with a face open to air (the debris trip's, netherdebris.ts); `leg`: the bearing
 * of the scouting leg that found it (its way, world.nether.legs, leads there).
 */
export interface NetherSite { kind: string; x: number; y: number; z: number; leg?: Bearing }

/**
 * How long a site of a kind is kept against the rest when the list is full: the natural ones last (P3c's fortress, P6's
 * bastion), the debris a leg saw with the builds and the hut's exit (the netherite's, and rare: the game makes none
 * that touches air).
 */
const siteRank = (kind: string) => (kind === 'fortress' || kind === 'bastion' ? 0 : kind === 'build' || kind === 'exit' || kind === 'ancient_debris' ? 1 : 2);

/**
 * Places found down there into `world.nether.sites` (the look from its hut, the scouting legs), to the block: the
 * newest first, each in place of one of its kind within 8 of it (the same place seen again: the leg that found it
 * kept when the new sight has none), SITES kept. Over that the oldest of the lowest kind goes first: lava lakes and
 * biomes, then builds, the hut's exit and debris, a natural fortress or bastion last (eight legs of scouting, some four
 * sites each, would otherwise push the fortress P3c is to go to out of the list).
 */
export function noteSites(world: WorldMemory, found: NetherSite[], at: number): void {
  const n = netherOf(world);
  const near = (a: NetherSite, b: NetherSite) => a.kind === b.kind && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 8;
  const fresh = found.map(f => {
    const site = { kind: f.kind, x: Math.floor(f.x), y: Math.floor(f.y), z: Math.floor(f.z) };
    const leg = f.leg ?? n.sites.find(o => near(site, o) && o.leg)?.leg;
    return { ...site, at, ...(leg ? { leg } : {}) };
  });
  const list = [...fresh, ...n.sites.filter(o => !fresh.some(f => near(f, o)))];
  while (list.length > SITES) {
    const worst = Math.max(...list.map(s => siteRank(s.kind)));
    let i = list.length - 1;
    while (siteRank(list[i].kind) !== worst) i--;
    list.splice(i, 1);
  }
  n.sites = list;
}

// ------------------------------------------------------------------------------------------------ holds

/** The death holds: a death in the Nether holds the trips an hour, two in 24 h a day, three in 3 days switch them off. */
export const NETHER_HOLDS = { afterDeathMs: HOUR, twoDeathsMs: DAY, offAfter: 3, offWithinMs: 3 * DAY } as const;
/** Until three trips in a row end well, one an hour at most (the deep trips' probation is two an hour). */
export const NETHER_PROBATION = { clean: 3, perHour: 1 } as const;
/** Nether trips a game day at most: the deep rung's mornings are kept. */
export const NETHER_PER_DAY = 2;

const OFF_LINE = 'nether trips off: 3 deaths in 3 days';

/**
 * What keeps the bot out of the Nether after deaths there, read off the stamps (nothing stored that someone would
 * have to clear by hand): two in 24 h until the older is a day old, one until it is an hour old. The third in 3 days
 * turns the switch off (netherTick, as it comes): that is the hold then, until someone turns it on again.
 */
export function deathHold(s: Pick<Snapshot, 'now'>, world: WorldMemory): Decline | null {
  const deaths = peekNether(world).deaths.map(d => d.at).filter(t => s.now - t < NETHER_HOLDS.offWithinMs).sort((a, b) => a - b);
  const day = deaths.filter(t => s.now - t < NETHER_HOLDS.twoDeathsMs);
  if (day.length >= 2) {
    const until = day[day.length - 2] + NETHER_HOLDS.twoDeathsMs;
    return { cause: 'hold', text: `two deaths in the nether in 24 h: held until ${clock(until)}`, until };
  }
  const last = deaths[deaths.length - 1];
  if (last !== undefined && s.now - last < NETHER_HOLDS.afterDeathMs) {
    const until = last + NETHER_HOLDS.afterDeathMs;
    return { cause: 'hold', text: `a death in the nether: held until ${clock(until)}`, until };
  }
  return null;
}

/** The trips' own pace: one an hour until three in a row end well, and NETHER_PER_DAY a game day. */
export function tripHold(s: Pick<Snapshot, 'now'>, world: WorldMemory): Decline | null {
  const n = peekNether(world);
  const today = n.tripsToday?.day === gameDay(world) ? n.tripsToday.n : 0;
  if (today >= NETHER_PER_DAY) return { cause: 'hold', text: `${today} nether trips today (at most ${NETHER_PER_DAY} a game day)` };
  if (n.cleanTrips >= NETHER_PROBATION.clean) return null;
  const recent = n.starts.filter(t => s.now - t < HOUR).sort((a, b) => a - b);
  if (recent.length < NETHER_PROBATION.perHour) return null;
  const until = recent[recent.length - NETHER_PROBATION.perHour] + HOUR;
  return { cause: 'hold', text: `nether on probation (${n.cleanTrips}/${NETHER_PROBATION.clean} clean): ${NETHER_PROBATION.perHour} trip this hour, next at ${clock(until)}`, until };
}

// ------------------------------------------------------------------------------------------------ the day

/** The bot leaves the Nether this many ticks before the work day's end (a minute): home through the portal by dusk. */
export const LEAVE_LEAD_TICKS = 1200;
/** A trip's way: to the home portal and through it, and at the end back through and home from it, ms. */
export const NETHER_WAY_MS = 2 * MINUTE;
/** The least time down there worth the trip, ms. */
export const NETHER_WORTH_MS = 3 * MINUTE;

/**
 * What a Nether trip setting out at this time of day may spend down there, ms: until the leave nether goal's own time
 * to go home (LEAVE_LEAD_TICKS before the work day's end), less the way there and back. A trip sets out only with
 * NETHER_WORTH_MS of it: until tod 3800.
 */
export const netherBudgetMs = (timeOfDay: number): number => Math.max(0, ticksToMs(daylightLeft(timeOfDay) - LEAVE_LEAD_TICKS) - NETHER_WAY_MS);

// ------------------------------------------------------------------------------------------------ the kit

/** The Nether kit's checklist from a look (mine.ts netherTripKit says what is short). */
export function netherCheck(s: Pick<Snapshot, 'health' | 'food' | 'counts' | 'items'>): NetherCheck {
  const has = (name: string) => s.items.some(i => i.name === name);
  return {
    health: s.health, food: s.food, foodPoints: readyFoodPoints(s.counts),
    goldenHelmet: has('golden_helmet'), shield: has('shield'),
    pickaxes: s.items.filter(i => i.name.endsWith('_pickaxe')).length,
    flintAndSteel: s.counts.get('flint_and_steel') ?? 0,
    blocks: NETHER_BLOCKS.reduce((a, n) => a + (s.counts.get(n) ?? 0), 0)
  };
}

/** Why the bot is not fit or kitted for a Nether trip, or null: hurt or hungry as `health`, the rest as `kit`. */
export function netherKitDecline(s: Snapshot, who = 'nether'): Decline | null {
  const c = netherCheck(s);
  const kit = netherTripKit(c);
  if (kit.ok) return null;
  if (c.health < NETHER_TRIP.health || c.food < NETHER_TRIP.foodLeast) return no.health(s, who, NETHER_TRIP.health, NETHER_TRIP.foodLeast);
  return { cause: 'kit', text: `${kit.why} (${who} needs the nether kit)` };
}

// ------------------------------------------------------------------------------------------------ the tick

/** The next stage's count in words: `1/2 clean trips to stage 1`; at the top, so. */
function toNext(n: Pick<NetherMemory, 'stage' | 'stageTrips'>): string {
  const next = NETHER_STAGES[n.stage];
  if (!next) return 'the top stage';
  return `${n.stageTrips}/${next.trips} clean trips to stage ${next.stage}`;
}

/**
 * A death in the Nether drops the stage by one, never below 1 once the two sides are linked (the setup is not undone:
 * its portal stands), and the clean trips go back to that stage's own count: the next stage is earned again. Gear
 * lost down there is not gone after (the regear wears the spare set). The line, or undefined when nothing changed.
 */
function dropStage(n: NetherMemory): string | undefined {
  const from = n.stage, had = n.stageTrips;
  const to = Math.max(n.linked === true && from >= 1 ? 1 : 0, from - 1);
  n.stage = to;
  n.stageTrips = tripsForStage(to);
  if (to === from && n.stageTrips === had) return undefined;
  return `nether: ${to === from ? `stage ${to} kept` : `stage ${from} -> ${to}`} after the death: ${toNext(n)}`;
}

/**
 * The stage up as its clean trips allow, one line a stage: only with the two sides linked (stage 0 is the setup's).
 * What a kind of work opened there needs besides (the bastion's potions) is its own gate's (NETHER_STAGES `work`).
 */
function raiseStage(n: NetherMemory): string[] {
  const lines: string[] = [];
  for (let next = NETHER_STAGES[n.stage]; next && n.linked === true && n.stageTrips >= next.trips; next = NETHER_STAGES[n.stage]) {
    n.stage = next.stage;
    lines.push(`nether: stage ${next.stage} after ${n.stageTrips} clean trips`);
  }
  return lines;
}

/** A death as the runtime tells it: where, when (real ms), and in which dimension (an older jar: none said). */
export interface DeathSeen { at?: { x: number; y?: number; z: number }; time: number; dimension?: string }

/**
 * The Nether's housekeeping, once a tick before the brain decides (work.ts workTick calls it): a death in the Nether
 * is stamped (the holds read the stamps, a run of clean trips starts again) and drops the stage by one, three in 3
 * days switch the trips off; the stage goes up as its clean trips (and stock) allow; the first look in the Nether is
 * where the bot came in (the way home with no portal of its own); old stamps go, and the day's count with its day.
 * Lines for the log.
 */
export function netherTick(s: Snapshot, world: WorldMemory, d: DeathSeen | undefined): string[] {
  const lines: string[] = [];
  const raw: unknown = world.nether;
  // nothing to keep yet, and nothing to look after: no memory is made for it (a world that never went near the Nether
  // keeps none)
  const nothing = raw === undefined && s.dimension !== NETHER && d?.dimension !== NETHER;
  if (nothing) return lines;
  const n = netherOf(world);
  let fresh = false;
  // only a death still inside the 3 days: the runtime tells the last death on every tick for as long as Node runs, so
  // one already let go below would otherwise be booked again each tick (the line every 5 s, the clean trips held at 0)
  const recent = d !== undefined && fin(d.time) && s.now - d.time < NETHER_HOLDS.offWithinMs;
  if (d && recent && d.dimension === NETHER && d.at && !n.deaths.some(x => x.at === d.time)) {
    const where = { x: Math.floor(d.at.x), y: Math.floor(d.at.y ?? 0), z: Math.floor(d.at.z) };
    n.deaths.push({ at: d.time, where });
    n.cleanTrips = 0;
    fresh = true;
    lines.push(`nether: a death at nether ${fmt(where)}: no trips until ${clock(d.time + NETHER_HOLDS.afterDeathMs)}`);
    const dropped = dropStage(n);
    if (dropped) lines.push(dropped);
    // on a fortress trip (between its start and its end): the fortress trips stop for good, whatever the ladder says
    // after it (the user's strict rules: "trips stop after a death"); the lead switches them back
    const ft = n.fortress?.trip;
    if (ft && d.time >= ft.from && d.time <= (ft.to ?? ft.from + FORTRESS_TRIP_CAP_MS) && !n.fortress?.off) {
      n.fortress!.off = { at: d.time, why: `a death on a fortress trip at nether ${fmt(where)}` };
      lines.push(`nether: a death on a fortress trip: fortress trips off until the lead switches them back`);
    }
  }
  // a fortress trip's end where its run could not write it: cut short down there (leave nether's abort: the dusk,
  // under 6 health), the walk home after it is the trip's still, and it ends at the first look home after the bot went in
  // (a death told a tick late is still inside it); a trip left open by a restart ends at FORTRESS_TRIP_CAP_MS
  const open = n.fortress?.trip;
  if (open && open.to === undefined) {
    const cap = open.from + FORTRESS_TRIP_CAP_MS;
    if (s.now >= cap) open.to = cap;
    else if (s.dimension !== NETHER && (n.enteredAt ?? -Infinity) >= open.from) open.to = s.now;
  }
  lines.push(...raiseStage(n));
  const deaths = n.deaths.filter(x => s.now - x.at < NETHER_HOLDS.offWithinMs);
  if (deaths.length !== n.deaths.length) n.deaths = deaths;
  // as the third in 3 days comes, and only then: turned on again after it (the lead's call), the switch stays on
  if (fresh && n.trips === true && deaths.length >= NETHER_HOLDS.offAfter) {
    n.trips = false;
    lines.push(OFF_LINE);
  }
  const starts = n.starts.filter(t => s.now - t < DAY);
  if (starts.length !== n.starts.length) n.starts = starts;
  if (n.tripsToday && n.tripsToday.day !== gameDay(world)) delete n.tripsToday;
  if (s.dimension !== n.seenIn) {
    if (s.dimension === NETHER) {
      n.arrival = { x: Math.floor(s.position.x), y: Math.floor(s.position.y), z: Math.floor(s.position.z) };
      n.enteredAt = s.now;
    }
    n.seenIn = s.dimension;
  }
  const broke = helmetWatch(s, n, d);
  if (broke) lines.push(broke);
  return lines;
}

/**
 * The golden helmet down there, a look at a time: its wear kept while it is carried or worn in the Nether; gone at a
 * later look (down there, or the first one home) with no death since, it broke: golden armour has 77 of durability,
 * and the Guardian wears it whatever comes at it. Said once, the line for the log; the nether spares chore makes
 * another (regear.ts), which is then right to. Live on Nov 15 the first one was in no chest and not carried, and
 * nothing said where it went. Seen home with it, the watch is let go of.
 */
function helmetWatch(s: Snapshot, n: NetherMemory, d: DeathSeen | undefined): string | undefined {
  // (the one worn first: the armour slots come last)
  const gold = s.items.filter(i => i.name === 'golden_helmet').sort((a, b) => b.slot - a.slot)[0];
  const was = n.helmet;
  // (a death since takes it with everything else: no break)
  const diedSince = (at: number) => n.deaths.some(x => x.at >= at) || (d !== undefined && fin(d.time) && d.time >= at);
  if (s.dimension === NETHER && gold) {
    // the look that first tells of a death may still show what the bot carried as it died (work.ts): the watch keeps
    // the look before it, which the first look home then finds the death after
    if (was && diedSince(was.at)) return undefined;
    const max = fin(gold.maxDamage) && gold.maxDamage > 0 ? gold.maxDamage : GOLDEN_HELMET_DURABILITY;
    n.helmet = { left: Math.max(0, max - (fin(gold.damage) ? gold.damage : 0)), max, at: s.now };
    return undefined;
  }
  if (!was) return undefined;
  delete n.helmet;
  if (gold) return undefined;
  if (diedSince(was.at)) return undefined;
  return `nether: the golden helmet broke down there (${was.left}/${was.max} left at the last look, ${clock(was.at)}): the nether spares chore makes another`;
}

/** A Nether trip sets out (work.ts runTask): stamped for the probation, counted for the day. */
export function netherStart(world: WorldMemory, now: number): void {
  const n = netherOf(world);
  n.starts.push(now);
  const day = gameDay(world);
  n.tripsToday = { day, n: (n.tripsToday?.day === day ? n.tripsToday.n : 0) + 1 };
}

/**
 * A start taken back (work.ts runTask): the run never went through the portal (its kit fell short at home, the home
 * portal not listed, no way to it on foot). The setup and the look fetch their kit inside the run, after the stamp:
 * such a run left the yard no more than P2a's gate, which read the kit carried, let it, and costs neither the
 * probation's hour nor one of the day's two trips. A trip turned back before its work (netherEnd's `turned back`) is
 * given back the same way: live on Nov 15 every barter and quartz trip went to the hut and straight back (four times a
 * ghast 12 to 30 off, once no piglin within 48), each one of the day's two.
 */
export function netherUnstart(world: WorldMemory, setOut: number): void {
  const n = netherOf(world);
  const i = n.starts.lastIndexOf(setOut);
  if (i >= 0) n.starts.splice(i, 1);
  const day = gameDay(world);
  if (n.tripsToday?.day === day) {
    if (n.tripsToday.n > 1) n.tripsToday = { day, n: n.tripsToday.n - 1 };
    else delete n.tripsToday;
  }
}

/**
 * How a trip that went ended, as the wrapper saw it: when, its line, whether it came home through a portal itself, and
 * whether its run did its work down there (work.ts WorkResult `worked`: the setup linked, the look done, a barter, an
 * ore mined).
 */
export interface TripSeen { at: number; text: string; cameBack: boolean; worked: boolean }

/**
 * A Nether trip is over: a death since it set out (in any dimension: the way to the portal is the trip's too) puts the
 * run of clean trips back to none; one that ran its course without a death counts towards the probation's three; one
 * cut short before then changes nothing. With `end` (a trip that went: one that never set out has none) it is the
 * last trip, and a clean one (home through a portal, its own run's or netherHome's; no death; the two sides linked
 * at its end; its work done) counts for the stages: the setup that links them is the first, the look after it the
 * second. One that would be clean but did no work down there (turned back by a ghast in sight, no piglin, no ore) is
 * `turned back`: it counts for nothing, neither for the stages nor the probation, and is no failure (the wrapper gives
 * its trip of the day back, as for a run that never went: netherUnstart). How it ended, with `end`.
 */
export function netherEnd(world: WorldMemory, startedAt: number, death: DeathSeen | undefined, ranItsCourse: boolean, end?: TripSeen): TripEnd | undefined {
  const n = netherOf(world);
  const died = !!death && fin(death.time) && death.time >= startedAt;
  const how: TripEnd | undefined = !end ? undefined
    : died ? 'a death' : !ranItsCourse ? 'cut short' : !end.cameBack ? 'stranded' : n.linked !== true ? 'not linked' : !end.worked ? 'turned back' : 'clean';
  if (died) n.cleanTrips = 0;
  else if (ranItsCourse && how !== 'turned back') n.cleanTrips += 1;
  if (!end || !how) return undefined;
  if (how === 'clean') n.stageTrips += 1;
  n.lastTrip = { at: end.at, text: end.text.length > TRIP_TEXT ? `${end.text.slice(0, TRIP_TEXT - 3)}...` : end.text, end: how };
  return how;
}

// ------------------------------------------------------------------------------------------------ home from there


type Listed = PortalShape & { distance?: number; own?: boolean };
interface Entered { ok?: boolean; reason?: string; dimension?: string; position?: Pos; block?: Pos; portal?: Pos | null; stepped?: boolean; note?: string }

/** The portal of a list a point lies in or by (within `by` of one of its blocks), the nearest. */
function portalBy(list: Listed[], p: Pos, by: number): Listed | undefined {
  const near = (q: Listed) => Math.min(...portalCells(q).map(c => Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z)));
  return list.filter(q => near(q) <= by).sort((a, b) => near(a) - near(b))[0];
}

/**
 * From the Nether, home: on foot (a careful walk: nothing placed or broken) to the bot's own Nether-side portal
 * (`world.nether.portal`), else the one it came in by (`arrival`, its first look this time in), else the nearest lit
 * portal in sight, and through it (portal.enter, stepping out toward home at the far end). In the overworld again it
 * says so: `nether: home through the portal at nether (x, y, z) -> overworld (x, y, z)`. Not in the Nether: nothing
 * to do. `ok` false says why it could not.
 */
export async function netherHome(ctx: GoalContext): Promise<{ ok: boolean; text: string }> {
  const st = await ctx.status();
  if ((st.dimension ?? OVERWORLD) !== NETHER) return { ok: true, text: `not in the nether (${st.dimension ?? OVERWORLD})` };
  const me = st.position ?? ctx.s.position;
  const n = peekNether(ctx.world);
  const listed = (await ctx.call<{ portals?: Listed[] }>('portal.list', { range: 128 }).catch(() => ({ portals: [] as Listed[] }))).portals ?? [];
  if (!listed.length) return { ok: false, text: 'no lit portal in sight' };
  const own = n.portal ? portalBy(listed, n.portal, 4) : undefined;
  const cameBy = !own && n.arrival ? portalBy(listed, n.arrival, 8) : undefined;
  const portal = own ?? cameBy ?? portalBy(listed, me, Infinity)!;
  const which = own ? 'its own portal' : cameBy ? 'the portal it came in by' : 'the nearest portal';
  if (n.portal && !own) ctx.progress(`its own portal at nether ${fmt(n.portal)} is not in sight: ${which} at nether ${fmt(portal)}`);
  // its bottom row's cell nearest the block the bot stands in: where the walk goes in
  const feet = { x: Math.floor(me.x), z: Math.floor(me.z) };
  const off = (c: Pos) => Math.hypot(c.x - feet.x, c.z - feet.z);
  const cell = bottomCells(portal).sort((a, b) => off(a) - off(b))[0];
  if (off(cell) > 3) {
    ctx.progress(`to ${which} at nether ${fmt(cell)}, on foot`);
    const walk = await ctx.call<{ arrived?: boolean }>('goto', { ...cell, range: 2, careful: true, timeoutMs: 90_000 }, 105_000).catch(() => ({ arrived: false }));
    if (ctx.signal.aborted) throw new Error('aborted');
    if (walk?.arrived === false) return { ok: false, text: `no way on foot to ${which} at nether ${fmt(cell)}` };
  }
  const home = ctx.s.home;
  const r = await ctx.call<Entered>('portal.enter', { ...cell, timeoutMs: 60_000, ...(home ? { toward: { x: home.x, z: home.z } } : {}) }, 90_000)
    .catch((e: Error) => ({ ok: false, reason: e.message } as Entered));
  if (ctx.signal.aborted) throw new Error('aborted');
  if (!r.ok) return { ok: false, text: `through ${which} at nether ${fmt(cell)}: ${r.reason ?? 'no answer'}` };
  if ((r.dimension ?? NETHER) !== OVERWORLD) return { ok: false, text: `through ${which} at nether ${fmt(cell)}: came out in ${r.dimension ?? 'the same place'}` };
  const at = r.portal ?? r.block ?? r.position;
  const line = `nether: home through the portal at nether ${fmt(cell)} -> overworld ${at ? fmt(at) : '(unknown)'}`;
  ctx.progress(line);
  return { ok: true, text: `${line}${r.stepped === false ? ` (did not step out: ${r.note ?? 'no safe side'})` : ''}` };
}

// ------------------------------------------------------------------------------------------------ the goal

/** Under this health or food the bot goes home from the Nether, whatever it is doing there. */
const LEAVE_HEALTH = 12;
/**
 * A run down there that bounds the bot's health itself (the fortress: it leaves under its own 10, the user's "below
 * half", and walks back by the cells it walked out, the only way there it knows): while it runs, leaveWhy's health rule
 * waits down to `floor` (the Guardian's emergency at 6), so 12 does not cut the run mid-fight and leave the bot to
 * netherHome's one walk to a portal that may be out of the client's loaded chunks (a fortress some 110 out). Set and
 * cleared by that run (in a finally).
 */
export const ownHealth: { floor?: number } = {};
/** The health down to which a run that bounds its own lets leaveWhy wait (the Guardian's emergency: Guardian.java, health 6 under attack). */
export const OWN_HEALTH_FLOOR = 6;
const LEAVE_FOOD = 10;
/** A worn piece with less left than this goes home (the gold helmet is first: piglins turn on a bot without it). */
const LEAVE_WEAR = 0.2;
const ARMOUR_SLOTS: [number, string][] = [[36, 'boots'], [37, 'leggings'], [38, 'chestplate'], [39, 'helmet']];

/** The worn piece that is gone or nearly worn through, in words; undefined while every piece holds. */
function wornThrough(s: Snapshot): string | undefined {
  for (const [slot, kind] of ARMOUR_SLOTS) {
    const i = s.items.find(x => x.slot === slot);
    if (!i) return `no ${kind} worn`;
    if (i.maxDamage && (i.maxDamage - (i.damage ?? 0)) / i.maxDamage < LEAVE_WEAR) return `the ${i.name} at ${Math.round(100 * (i.maxDamage - (i.damage ?? 0)) / i.maxDamage)}%`;
  }
  return undefined;
}

/**
 * Why the bot should go home from the Nether now, or null (never outside it): hurt (health under 12, under 6 while a
 * run that bounds its own health is under way: ownHealth) or hungry (food under 10); the day near its end (home by dusk: LEAVE_LEAD_TICKS before the return home, and at night); the trips
 * held (the switch off, a death hold); a worn piece gone or under 20%; or no work run under way (a restart, the LLM's
 * hand-back, a run that stopped: nothing down there is the bot's to do but a trip's).
 */
export function leaveWhy(s: Snapshot, world: WorldMemory): string | null {
  if (s.dimension !== NETHER) return null;
  if (s.health < (ownHealth.floor ?? LEAVE_HEALTH)) return `health ${Math.round(s.health)}: home from the nether`;
  if (s.food < LEAVE_FOOD) return `food ${Math.round(s.food)}: home from the nether`;
  const left = daylightLeft(s.timeOfDay);
  if (s.activity !== 'work' || left < LEAVE_LEAD_TICKS) return s.activity === 'work' ? `${(ticksToMs(left) / MINUTE).toFixed(1)} min of daylight left: home by dusk` : `${s.activity === 'rest' ? 'night' : 'evening'}: home from the nether`;
  if (!tripsOn(world)) return 'nether trips are off: home';
  const held = deathHold(s, world);
  if (held) return `${held.text}: home`;
  const worn = wornThrough(s);
  if (worn) return `${worn}: home from the nether`;
  if (!afield.work) return 'in the nether with no trip under way: home';
  return null;
}

/**
 * Leave the Nether (a survival goal, 87: above the retreat): whenever leaveWhy says so, home through a portal
 * (netherHome). When that fails it says `nether: stranded at nether (x, y, z): <why>` once this time in, and tries
 * again every 2 minutes (three failures in a row hold it 2 minutes too, never the night): the maintenance run's
 * operator gets it out by hand (use-portal, a rescue) if it stays.
 */
export function leaveNetherGoal(): Goal {
  /** the time in (enteredAt) the stranded line was said for */
  let said: number | undefined;
  return {
    name: 'leave nether',
    priority: 87,
    timeoutMs: 5 * MINUTE,
    retryMs: 2 * MINUTE,
    failHoldMs: 2 * MINUTE,
    wants: (s, world) => leaveWhy(s, world),
    run: async ctx => {
      const r = await netherHome(ctx);
      if (r.ok) return r.text;
      if (ctx.signal.aborted) throw new Error('aborted');
      const visit = peekNether(ctx.world).enteredAt ?? 0;
      if (said !== visit) {
        said = visit;
        ctx.progress(`nether: stranded at nether ${fmt(ctx.s.position)}: ${r.text}`);
      }
      throw new Error(`stranded: ${r.text}`);
    }
  };
}

// ------------------------------------------------------------------------------------------------ brain-status

/**
 * brain-status, `Nether:`: the switch; the stage and the clean trips to the next one (the probation while it lasts),
 * the deaths in 3 days; the portals it knows (the home portal, its own Nether side and whether the two are linked),
 * the setup's hold while it holds, the others' portals seen, the sites known, the bearings its scouting legs have
 * walked (of the eight), its tunnels for debris and how many still go on; and the last trip, how it ended and its
 * line. A look only.
 */
export function netherLine(world: WorldMemory, now: number): string {
  const n = peekNether(world);
  const deaths = n.deaths.filter(d => now - d.at < NETHER_HOLDS.offWithinMs).length;
  const home = homePortal(world);
  const seen = Object.entries(n.seen ?? {}).map(([dim, l]) => `${l.length} in ${dim === NETHER ? 'the nether' : dim}`).join(', ');
  const probation = n.cleanTrips < NETHER_PROBATION.clean ? `, on probation ${n.cleanTrips}/${NETHER_PROBATION.clean}` : '';
  const hold = n.setupHold && now < n.setupHold.until ? `; setup held until ${clock(n.setupHold.until)}: ${n.setupHold.why}` : '';
  const bh = barterHold(world, now);
  const barterHeld = bh ? `; barter held for the day: ${bh.why}` : '';
  const tl = n.tunnels?.list ?? [];
  const tunnels = tl.length ? `; ${tl.length} tunnel(s) for debris, ${tl.filter(x => !x.shut).length} going on` : '';
  const fortressOff = n.fortress?.off ? `; fortress trips off (${n.fortress.off.why}, ${clock(n.fortress.off.at)}) until the lead switches them back` : '';
  const t = n.lastTrip;
  const last = t ? `; last trip ${Math.max(0, Math.round((now - t.at) / MINUTE))} min ago (${t.end}): ${t.text.replace(/(?<!\.)\.$/, '')}` : '';
  return `Nether: trips ${tripsOn(world) ? 'on' : 'off'}; stage ${n.stage}, ${toNext(n)}${probation}, ${deaths} death(s) in 3 days; ` +
    `home portal ${home ? `overworld ${fmt(home)}` : 'none'}, nether side ${n.portal ? `nether ${fmt(n.portal)}` : 'none'}` +
    `${n.portal ? (n.linked ? ' (linked)' : ' (not linked)') : ''}${hold}${barterHeld}${fortressOff}${seen ? `; others' portals seen: ${seen}` : ''}` +
    `${n.sites.length ? `; ${n.sites.length} site(s) known` : ''}${n.legs?.length ? `; ${n.legs.length}/${BEARINGS.length} bearings scouted` : ''}${tunnels}${last}.`;
}
