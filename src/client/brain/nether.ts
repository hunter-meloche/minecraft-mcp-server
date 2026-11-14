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

/** Kept in brain.json per world (`world.nether`). */
export interface NetherMemory {
  /** the nether-trips switch: anything that goes through a portal waits for it (off, undefined, as it ships) */
  trips?: boolean;
  /** the stage the trips have reached (P2b's ramp opens the nether rung's variants by it): 0 to start */
  stage: number;
  /** Nether trips in a row that ended with no death */
  cleanTrips: number;
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
  /** where the bot stood at its first look in the Nether this time in, and when: the way home with no portal of its own */
  arrival?: Pos;
  enteredAt?: number;
  /** the dimension of the last look (a change to the Nether is an arrival) */
  seenIn?: string;
  /** the lit portals seen that are not its own, by dimension (the bridge keeps its own list for a client session only) */
  seen?: Record<string, PortalShape[]>;
  /** places found down there (P3c: fortresses, bastions) */
  sites: { kind: string; x: number; y: number; z: number; at?: number }[];
}

/** Deaths kept (3 days' worth at most), starts (24 h), portals seen per dimension, sites. */
const DEATHS = 32;
const STARTS = 64;
const SEEN = 16;
const SITES = 16;

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
  const m: NetherMemory = {
    stage: fin(r.stage) && r.stage > 0 ? Math.floor(r.stage) : 0,
    cleanTrips: fin(r.cleanTrips) && r.cleanTrips > 0 ? Math.floor(r.cleanTrips) : 0,
    deaths: (Array.isArray(r.deaths) ? r.deaths : []).flatMap(d => {
      const where = isObj(d) ? posOf(d.where) : undefined;
      return isObj(d) && fin(d.at) && where ? [{ at: d.at, where }] : [];
    }).slice(-DEATHS),
    starts: (Array.isArray(r.starts) ? r.starts : []).filter(fin).slice(-STARTS),
    sites: (Array.isArray(r.sites) ? r.sites : []).flatMap(p => (isObj(p) && typeof p.kind === 'string' && posOf(p)
      ? [{ kind: p.kind, ...posOf(p)!, ...(fin(p.at) ? { at: p.at } : {}) }] : [])).slice(0, SITES)
  };
  if (typeof r.trips === 'boolean') m.trips = r.trips;
  const t = r.tripsToday;
  if (isObj(t) && fin(t.day) && fin(t.n)) m.tripsToday = { day: t.day, n: Math.max(0, Math.floor(t.n)) };
  const portal = posOf(r.portal);
  if (portal) m.portal = portal;
  if (typeof r.linked === 'boolean') m.linked = r.linked;
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
  if (c.health < NETHER_TRIP.health || c.food < NETHER_TRIP.food) return no.health(s, who, NETHER_TRIP.health, NETHER_TRIP.food);
  return { cause: 'kit', text: `${kit.why} (${who} needs the nether kit)` };
}

// ------------------------------------------------------------------------------------------------ the tick

/** A death as the runtime tells it: where, when (real ms), and in which dimension (an older jar: none said). */
export interface DeathSeen { at?: { x: number; y?: number; z: number }; time: number; dimension?: string }

/**
 * The Nether's housekeeping, once a tick before the brain decides (work.ts workTick calls it): a death in the Nether
 * is stamped (the holds read the stamps, a run of clean trips starts again), three in 3 days switch the trips off;
 * the first look in the Nether is where the bot came in (the way home with no portal of its own); old stamps go, and
 * the day's count with its day. Lines for the log.
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
  }
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
  return lines;
}

/** A Nether trip sets out (work.ts runTask): stamped for the probation, counted for the day. */
export function netherStart(world: WorldMemory, now: number): void {
  const n = netherOf(world);
  n.starts.push(now);
  const day = gameDay(world);
  n.tripsToday = { day, n: (n.tripsToday?.day === day ? n.tripsToday.n : 0) + 1 };
}

/**
 * A Nether trip is over: a death since it set out (in any dimension: the way to the portal is the trip's too) puts the
 * run of clean trips back to none; one that ran its course without a death counts towards the probation's three; one
 * cut short before then changes nothing.
 */
export function netherEnd(world: WorldMemory, startedAt: number, death: DeathSeen | undefined, ranItsCourse: boolean): void {
  const n = netherOf(world);
  if (death && fin(death.time) && death.time >= startedAt) n.cleanTrips = 0;
  else if (ranItsCourse) n.cleanTrips += 1;
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
 * Why the bot should go home from the Nether now, or null (never outside it): hurt (health under 12) or hungry (food
 * under 10); the day near its end (home by dusk: LEAVE_LEAD_TICKS before the return home, and at night); the trips
 * held (the switch off, a death hold); a worn piece gone or under 20%; or no work run under way (a restart, the LLM's
 * hand-back, a run that stopped: nothing down there is the bot's to do but a trip's).
 */
export function leaveWhy(s: Snapshot, world: WorldMemory): string | null {
  if (s.dimension !== NETHER) return null;
  if (s.health < LEAVE_HEALTH) return `health ${Math.round(s.health)}: home from the nether`;
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
 * brain-status, `Nether:`: the switch, the stage, the clean trips, the deaths in 3 days, and the portals it knows (the
 * home portal, its own Nether side and whether the two lead to each other, the others seen). A look only.
 */
export function netherLine(world: WorldMemory, now: number): string {
  const n = peekNether(world);
  const deaths = n.deaths.filter(d => now - d.at < NETHER_HOLDS.offWithinMs).length;
  const home = homePortal(world);
  const seen = Object.entries(n.seen ?? {}).map(([dim, l]) => `${l.length} in ${dim === NETHER ? 'the nether' : dim}`).join(', ');
  return `Nether: trips ${tripsOn(world) ? 'on' : 'off'}; stage ${n.stage}, ${n.cleanTrips} clean trip(s), ${deaths} death(s) in 3 days; ` +
    `home portal ${home ? `overworld ${fmt(home)}` : 'none'}, nether side ${n.portal ? `nether ${fmt(n.portal)}` : 'none'}` +
    `${n.portal ? (n.linked ? ' (linked)' : ' (not linked)') : ''}${seen ? `; others' portals seen: ${seen}` : ''}.`;
}
