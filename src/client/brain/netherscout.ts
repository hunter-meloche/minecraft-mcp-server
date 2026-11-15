/**
 * Scouting out from its own Nether-side portal (P3b of the progression plan, stage 2 of the Nether trips, beside the
 * debris): the user's "as far as needed" down there, one leg a trip, bounded by the day and the trip's time.
 *
 * The trip (worktasks.ts NETHER_WORK `scout`, from stage 2 while a bearing is due): the Nether kit at home, through the
 * home portal into its own hut (anywhere else: the link is broken the one way, as the barter has it: straight back,
 * the setup held a day), and one leg out on foot along one of the eight bearings (nether.ts BEARINGS), the least known
 * first: one never walked before one walked, and of those the one with the fewest sites known that way; then each
 * again in turn, the longest ago first, a day after its last (scoutBearing). The leg:
 * - up to 96 out from its portal along the bearing, within 12 of the bearing's line through the portal (and 8 behind
 *   it at most: the way out of its hut's door may start the other way);
 * - on foot over open ground only: a careful walk (the bridge's goto, nothing broken or placed: no tunnelling, no
 *   bridging over lava, no towers) over the ground read 32 ahead at a time (the chunks near the bot are the loaded
 *   ones), by the barter's rules: no lava or fire within 2, at no drop's edge, 16 from every zone the bridge's scan has
 *   down there (anyone's build: courtesy; a natural fortress or bastion: blazes and brutes), asked again at every look;
 * - every walk over ground 2 from every drop's edge (KNOCK_GAP) wherever that goes on: the way back is the way out
 *   again, walked blind, and a ghast come by then finds the bot at no edge a fireball's blast could throw it off; by a
 *   drop's edge (a ledge the only way on) only with no ghast watched;
 * - the barter's ghast rule and the rest of its dangers (barterDanger: a ghast within 16 that sees it, a fireball
 *   coming at it, a hit, a hoglin or a brute near, a piglin turned, on fire: back at once; a ghast within 32 watched,
 *   no drop's edge within 2 meanwhile, and the way on only by one: back as from a danger), looked for between every
 *   4 steps;
 * - turned back once half of what the trip had left as it set foot out of the hut is gone (the way back is the way
 *   out again), at 96, or where the ground goes on no further along the bearing.
 * It reads what it passes into `world.nether.sites`, each with the bearing of the leg that found it (its way leads
 * there): others' builds and the natural fortresses and bastions by the bridge's zones (Foreign's natural flag), the
 * lava lakes of the ground read, the biomes it walks into (the status' biome: a soul sand valley, a crimson or a
 * warped forest), and the ancient debris of its reads with a face open to air and no lava by it, within 24 of a
 * waypoint (the debris trip goes out to it by the way: netherdebris.ts); and the leg into `world.nether.legs` with the
 * way it took (waypoints of the cells it walked, 8 apart), so a later trip can follow a known way. Says `nether: scouted 96 to the north-east: a fortress at nether
 * (x, y, z) (natural), 2 lava lakes`, then walks back along the cells it walked out (the known way: it judged each
 * by the rules as it went out), into its hut and through its own portal.
 *
 * A leg is the trip's work once it got LEG_LEAST (24) out, past what the look from its hut read: only then does the
 * trip count for the stages. One turned back before that by a danger (a watched ghast with the way on only by a drop's
 * edge among them) or by its time counts for nothing and leaves the bearing as it was (the next trip tries it again);
 * one whose ground went no further (the cliff its hut is dug into, a lava lake, someone's build across the way) is
 * kept as walked, so the next trip takes the next bearing.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts reaches it, and this module reaches most of the brain).
 */
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { clock } from './idlelog.js';
import { homePortal } from './portal.js';
import {
  BEARINGS, NETHER, WAYPOINTS, barterHold, gameDay, netherOf, noteSites, peekNether, portalCells, type Bearing, type NetherSite, type ScoutLeg
} from './nether.js';
import { BACK_MS, KNOCK_GAP, LAVA_GAP, backThroughOwn, barterDanger, ghastAbout, ghastWatched, lavaBy, overDrop, toOwnPortal, type Seen } from './netherbarter.js';
import { LAKE_MIN, LOOK_RADIUS } from './netherlook.js';
import { DEBRIS, DEBRIS_DEPTH, DEBRIS_KEPT, DEBRIS_RADIUS, exposedDebrisIn } from './netherdebris.js';
import {
  FROM_BUILDS, GONE, SETUP_HEALTH, SETUP_WAITS, blockAt, boxGap, boxOf, fetchSetupKit, footing, inNether, pathOf, readGround, setupShort, walkAlong,
  walkFrom, zoneBox, type Box, type Grid, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const cellKey = (p: Pos) => `${p.x},${p.y},${p.z}`;
const parse = (k: string): Pos => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const floorOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
const dist3 = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A box's middle, to the block. */
const middle = (b: Box): Pos => ({ x: Math.floor((b.x1 + b.x2) / 2), y: Math.floor((b.y1 + b.y2) / 2), z: Math.floor((b.z1 + b.z2) / 2) });

// ------------------------------------------------------------------------------------------------ the leg's rules

/** How far out from its portal a leg goes along its bearing, at most. */
export const SCOUT_REACH = 96;
/** How far off the bearing's line through its portal a leg may walk, across (a way round a lava pool or a pillar). */
export const CORRIDOR = 12;
/** How far behind its portal along the bearing (its hut's door may face the other way: out of it first). */
export const SCOUT_BEHIND = 8;
/** The ground is read this far ahead of where the bot stands, a time (the next read once it has walked it). */
export const SEGMENT = 32;
/** The read down and up from the bot's feet (a walk climbs a block a step and drops three at most). */
const SEG_DOWN = 12;
const SEG_UP = 12;
/** A read again behind where it stands, along the bearing (a way round may go back a little first). */
const SEG_BACK = 8;
/**
 * A leg that got this far out from its portal is the trip's work (it counts for the stages): past the look's 24 round
 * its hut, which saw that much from the door.
 */
export const LEG_LEAST = LOOK_RADIUS;
/** The scouting's whole time, from the kit at home to back through its own portal (the barter's), and what it still needs after the kit. */
export const SCOUT_MAX_MS = 8 * MINUTE;
export const SCOUT_LEAST_MS = 3 * MINUTE;
/** A bearing walked is due again this long after its leg (the Nether changes slowly: someone's build, a fortress found). */
export const SCOUT_AGAIN_MS = DAY;
/** A waypoint every so many cells of the walk out (then each next one is a careful walk of a few steps on). */
export const WAY_EVERY = 8;
/** Steps a walk leg of the way out (a look between every two). */
const STEP = 4;
/** Walks planned on a leg at most (the ground read again before each): three or four reach 96; the rest are ways round. */
const SCOUT_ROUNDS = 16;
/** Walks that did not arrive (the careful walk could not), and the leg ends there. */
const STUCK_MOST = 2;
/** The bridge's scan reaches 48 round the bot: a zone this near a cell it walked was passed on the way. */
const PASSED = 48;
/** Sites kept from one leg: the builds of others nearest the way, the lava lakes nearest it (every natural one seen is kept). */
const BUILDS_KEPT = 4;
const LAKES_KEPT = 3;
/** The biomes a leg notes as it walks into them (the status' biome at the bot's feet), and their words. */
export const SCOUT_BIOMES: Readonly<Record<string, string>> = { soul_sand_valley: 'soul sand valley', crimson_forest: 'crimson forest', warped_forest: 'warped forest' };

/** A bearing's line through its portal: the portal's middle across the ground and the bearing's way, a block long. */
export interface ScoutFrame { bearing: Bearing; ox: number; oz: number; ux: number; uz: number }

/** The line of a bearing through a portal (its box). */
export function frameOf(portal: Box, bearing: Bearing): ScoutFrame {
  const b = BEARINGS.find(x => x.name === bearing)!;
  const len = Math.hypot(b.dx, b.dz);
  return { bearing, ox: (portal.x1 + portal.x2 + 1) / 2, oz: (portal.z1 + portal.z2 + 1) / 2, ux: b.dx / len, uz: b.dz / len };
}

/** How far out along its bearing a cell is (its middle), from its portal's middle; less than 0 behind it. */
export const outAlong = (f: ScoutFrame, p: { x: number; z: number }): number => (p.x + 0.5 - f.ox) * f.ux + (p.z + 0.5 - f.oz) * f.uz;
/** How far off the bearing's line a cell is (its middle), across. */
export const offLine = (f: ScoutFrame, p: { x: number; z: number }): number => Math.abs((p.z + 0.5 - f.oz) * f.ux - (p.x + 0.5 - f.ox) * f.uz);

/**
 * The box of ground to read for the stretch of a leg from `from` to `to` out along its bearing, pure: the corridor's
 * width and the lava rule's cells round it (and round its ends), from SEG_DOWN under the feet at `y` (and the lava
 * rule's under that floor) to SEG_UP over them.
 */
export function aheadBox(f: ScoutFrame, from: number, to: number, y: number): Box {
  const w = CORRIDOR + LAVA_GAP + 1;
  const xs: number[] = [], zs: number[] = [];
  for (const t of [from - LAVA_GAP - 1, to + LAVA_GAP + 1]) for (const l of [-w, w]) { xs.push(f.ox + t * f.ux - l * f.uz); zs.push(f.oz + t * f.uz + l * f.ux); }
  return {
    x1: Math.floor(Math.min(...xs)), y1: Math.max(1, y - SEG_DOWN - LAVA_GAP - 1), z1: Math.floor(Math.min(...zs)),
    x2: Math.ceil(Math.max(...xs)), y2: Math.min(126, y + SEG_UP), z2: Math.ceil(Math.max(...zs))
  };
}

/**
 * The cells a leg may walk and stand on, pure: within CORRIDOR of its bearing's line, from SCOUT_BEHIND behind its
 * portal to SCOUT_REACH out, and by the barter's rules (netherbarter.ts barterGround): FROM_BUILDS (16) from every
 * zone, no lava or fire within LAVA_GAP, at no drop's edge. Each cell judged once on the ground it was read on.
 */
export function scoutGround(g: Grid, f: ScoutFrame, zones: Box[]): (p: Pos) => boolean {
  const judged = new Map<string, boolean>();
  return p => {
    const k = cellKey(p);
    let ok = judged.get(k);
    if (ok === undefined) {
      const out = outAlong(f, p);
      ok = out >= -SCOUT_BEHIND && out <= SCOUT_REACH && offLine(f, p) <= CORRIDOR && !zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) &&
        !lavaBy(g, p) && !overDrop(g, p);
      judged.set(k, ok);
    }
    return ok;
  };
}

/**
 * Where a walk goes next on a leg, pure: of the cells a walk reaches (`reach`), the one furthest out along the bearing
 * (to the block), then the nearest its line, then the fewest steps. Undefined with none.
 */
export function furthest(f: ScoutFrame, reach: Map<string, { from: string | null; n: number }>): { at: Pos; out: number; n: number } | undefined {
  let best: { at: Pos; out: number; off: number; n: number } | undefined;
  for (const [k, r] of reach) {
    const at = parse(k);
    const out = outAlong(f, at), off = offLine(f, at);
    const a = Math.floor(out), b = best ? Math.floor(best.out) : -Infinity;
    if (!best || a > b || (a === b && (Math.round(off) < Math.round(best.off) || (Math.round(off) === Math.round(best.off) && r.n < best.n)))) best = { at, out, off, n: r.n };
  }
  return best && { at: best.at, out: best.out, n: best.n };
}

/** A leg's waypoints, pure: the first cell (its hut's), one every WAY_EVERY cells walked (more apart on a long way: WAYPOINTS at most), and the last. */
export function waypoints(cells: Pos[]): Pos[] {
  if (!cells.length) return [];
  const step = Math.max(WAY_EVERY, Math.ceil((cells.length - 1) / (WAYPOINTS - 1)));
  const out: Pos[] = [];
  for (let i = 0; i < cells.length - 1; i += step) out.push({ ...cells[i] });
  out.push({ ...cells[cells.length - 1] });
  return out;
}

/**
 * The lava lakes among lava cells read (`cells`, keys), pure: joined face to face, LAKE_MIN of them at the least (the
 * look's rule), each by its cell nearest the way (`way`), the nearest the way first. The cells come of every read of
 * a leg together: a lake two reads saw is one. With `past`, only a lake that reaches further from the portal than
 * the radius (the look's own read saw those nearer).
 */
export function lakesBy(cells: Set<string>, way: Pos[], past?: { portal: Box; radius: number }): { at: Pos; size: number; off: number }[] {
  const seen = new Set<string>();
  const out: { at: Pos; size: number; off: number }[] = [];
  const gap = (c: Pos) => Math.min(...way.map(w => dist3(c, w)));
  for (const k of cells) {
    if (seen.has(k)) continue;
    seen.add(k);
    const lake: Pos[] = [];
    for (const queue = [parse(k)]; queue.length;) {
      const c = queue.pop()!;
      lake.push(c);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        const qk = cellKey(q);
        if (seen.has(qk) || !cells.has(qk)) continue;
        seen.add(qk);
        queue.push(q);
      }
    }
    if (lake.length < LAKE_MIN) continue;
    if (past && !lake.some(c => boxGap(past.portal, cellBox(c)) > past.radius)) continue;
    const near = way.length ? lake.reduce((a, c) => (gap(c) < gap(a) ? c : a)) : lake[0];
    out.push({ at: near, size: lake.length, off: way.length ? Math.round(gap(near)) : 0 });
  }
  return out.sort((a, b) => a.off - b.off || b.size - a.size);
}

// ------------------------------------------------------------------------------------------------ the bearing

/** Which of the eight bearings a place lies along from a point, the nearest its way; none at the point itself. */
export function bearingOf(from: { x: number; z: number }, p: { x: number; z: number }): Bearing | undefined {
  const dx = p.x - from.x, dz = p.z - from.z;
  if (Math.hypot(dx, dz) < 1) return undefined;
  let best: { name: Bearing; dot: number } | undefined;
  for (const b of BEARINGS) {
    const dot = (dx * b.dx + dz * b.dz) / Math.hypot(b.dx, b.dz);
    if (!best || dot > best.dot) best = { name: b.name, dot };
  }
  return best?.name;
}

/**
 * The bearing the next leg goes along, pure (the eight in turn, the least known first): one never walked before one
 * walked; of those never walked, the one with the fewest sites known that way from its portal (the look's builds and
 * lava lakes; the hut's exit is none), then the compass order from the north; of those walked, the longest ago first,
 * once SCOUT_AGAIN_MS (a day) has gone since. With every one walked within that, a decline until the next is due.
 */
export function scoutBearing(world: WorldMemory, now: number): { bearing: Bearing; why: string } | { decline: Decline } {
  const n = peekNether(world);
  const legs = n.legs ?? [];
  const known = new Map<Bearing, number>();
  if (n.portal) {
    for (const site of n.sites) {
      if (site.kind === 'exit') continue;
      const b = bearingOf(n.portal, site);
      if (b) known.set(b, (known.get(b) ?? 0) + 1);
    }
  }
  const all = BEARINGS.map((b, i) => ({ bearing: b.name as Bearing, i, leg: legs.find(l => l.bearing === b.name), known: known.get(b.name) ?? 0 }));
  // (a leg stamped after now: the clock went back; due rather than held for good)
  const due = all.filter(c => !c.leg || now - c.leg.at >= SCOUT_AGAIN_MS || now < c.leg.at);
  if (!due.length) {
    const next = [...all].sort((a, b) => a.leg!.at - b.leg!.at)[0];
    const until = next.leg!.at + SCOUT_AGAIN_MS;
    return { decline: { cause: 'unneeded', text: `every bearing scouted in the last ${SCOUT_AGAIN_MS / HOUR} h (the next, the ${next.bearing}, at ${clock(until)})`, until } };
  }
  due.sort((a, b) => (a.leg ? 1 : 0) - (b.leg ? 1 : 0) || (a.leg?.at ?? 0) - (b.leg?.at ?? 0) || a.known - b.known || a.i - b.i);
  const c = due[0];
  return {
    bearing: c.bearing,
    why: c.leg ? `last scouted ${Math.max(1, Math.round((now - c.leg.at) / HOUR))} h ago, ${c.leg.reach} out` : `never scouted, ${c.known ? plural(c.known, 'site') : 'no site'} known that way`
  };
}

// ------------------------------------------------------------------------------------------------ the gate

/** The scouting is open from stage 2, its own portal standing and the two sides linked. */
export function scoutOpen(world: WorldMemory): boolean {
  const n = peekNether(world);
  return n.linked === true && !!n.portal && n.stage >= 2;
}

/**
 * Whether the scouting can set out now, pure: not held (a piglin turned on the bot by its portal today: the barter's
 * hold, the same piglins round the same hut), a bearing due (scoutBearing), not hurt past what the run heals at home,
 * and nothing of the Nether kit short that the chests lack (the setup's own list). The hour is the rung's.
 */
export function scoutReady(s: Snapshot, world: WorldMemory): Decline | null {
  const held = barterHold(world, s.now);
  if (held) return { cause: 'hold', text: `scouting held for the day: ${held.why}` };
  const b = scoutBearing(world, s.now);
  if ('decline' in b) return b.decline;
  if (s.health < SETUP_HEALTH) return no.health(s, 'the scouting', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `scout: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the trip

/**
 * The scouting trip (see the top of the file). From home with the Nether kit (or it does not set out: untried),
 * through the home portal into its own hut, one leg out on foot along the bearing due, what it passed kept, back along
 * the way it walked and through its own portal; `nether: scouted N to the <bearing>: ...` said once the leg is walked.
 * Gain: 1 for a leg walked (LEG_LEAST out). Out of the Nether halfway (a death), it stops at once: what the leg had
 * found by then is kept, and nothing more is sent.
 */
export async function scoutRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, SCOUT_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to scout from', untried: true };
  const chosen = scoutBearing(world, began);
  if ('decline' in chosen) return { gain: 0, text: `no bearing to scout: ${chosen.decline.text}`, untried: true };
  const bearing = chosen.bearing;
  const toward = `to the ${bearing}`;
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  if (left() < SCOUT_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the scouting's ${SCOUT_MAX_MS / MINUTE} min is left`, untried: true };
  }
  const to = await toOwnPortal(ctx, home, own, now, 'scouting');
  if ('result' in to) return to.result;
  const { arrived, homeShape } = to;
  if (left() <= BACK_MS) return { gain: 0, text: `out of the scouting's ${SCOUT_MAX_MS / MINUTE} min on the way down: no leg walked ${toward}` };

  // ---- the ground by its portal and the first stretch out (the bridge's scan follows the protection sync: a
  // moment), then the zones down there, asked once the read is in (the bridge's scan reads loaded chunks only) and
  // again at every look: its scan follows the bot, 48 round it, and the leg keeps 16 from each. Every zone seen on the
  // trip is kept (one gone from a later scan is still someone's); the ground it may walk follows them
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const pb = boxOf(portalCells(arrived));
  const f = frameOf(pb, bearing);
  const st0 = await ctx.status().catch(() => undefined);
  let me: Pos = st0?.position ?? to.me;
  let g = await readGround(ctx, aheadBox(f, -SCOUT_BEHIND, SEGMENT, floorOf(me).y));
  const seenZones = new Map<string, NetherZone>();
  let zones: Box[] = [];
  let may = scoutGround(g, f, zones);
  /** a cell at no drop's edge within KNOCK_GAP (the walks' first choice, the only one while a ghast is watched), each judged once on the ground it was read on */
  let knocks = new Map<string, boolean>();
  const knockSafe = (p: Pos) => {
    const k = cellKey(p);
    let ok = knocks.get(k);
    if (ok === undefined) knocks.set(k, ok = !overDrop(g, p, KNOCK_GAP));
    return ok;
  };
  /** a ghast within GHAST_WATCH at the last look: the ground it walks and stands on keeps KNOCK_GAP from drops */
  let watched = false;
  const walkable = (p: Pos) => may(p) && (!watched || knockSafe(p));
  /** The bridge's zones down there added to those seen: false when it did not answer. */
  const askZones = async (): Promise<boolean> => {
    const r = await ctx.call<{ zones?: NetherZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => undefined);
    if (!r) return false;
    let more = false;
    for (const z of r.zones ?? []) {
      const b = zoneBox(z);
      const k = `${b.x1},${b.y1},${b.z1},${b.x2},${b.y2},${b.z2}`;
      if (!seenZones.has(k)) { seenZones.set(k, z); more = true; }
    }
    if (more) { zones = [...seenZones.values()].map(zoneBox); may = scoutGround(g, f, zones); }
    return true;
  };
  /** the lava cells of every read on the leg (its lakes, counted once at its end: a lake two reads saw is one) */
  const lava = new Set<string>();
  const noteLava = (grid: Grid) => {
    for (let y = grid.y; y < grid.y + grid.height; y++) for (let z = grid.z; z < grid.z + grid.length; z++) for (let x = grid.x; x < grid.x + grid.width; x++) {
      if (blockAt(grid, { x, y, z }) === 'lava') lava.add(`${x},${y},${z}`);
    }
  };
  /** the ancient debris of every read on the leg with a face open to air and no lava by it (netherdebris.ts exposedDebrisIn) */
  const debris = new Map<string, Pos>();
  const noteDebris = (grid: Grid) => { for (const p of exposedDebrisIn(grid)) debris.set(cellKey(p), p); };
  noteLava(g);
  noteDebris(g);
  // (no word of the builds down there: no rule of 16 from them to walk by. Back through its portal, from where it
  // stands by it)
  if (!(await askZones())) {
    const b = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no leg walked: the bridge did not say where the builds down there are; ${b.text}`, mark: 'same', ...(b.cameBack ? { cameBack: true as const } : {}) };
  }
  const start = footing(g, me);
  if (!start) return { gain: 0, text: `no ground to stand on by its portal at nether ${fmt(arrived)}: no leg walked ${toward}` };

  // ---- the looks: where it stands, what is round it, what would send it back, the biome it is in
  let health = st0?.health ?? 20;
  let ents: Seen[] = [];
  let stop: string | undefined;
  let angry: string | undefined;
  /** sent back by a danger (not by the ground): the bearing is not found closed */
  let danger = false;
  let gone = false;
  /** the biomes walked into, each where it was first (its cell, how far out) */
  const biomes = new Map<string, { at: Pos; out: number }>();
  /** A look round: false when something sends it back (`stop` says what) or it is out of the Nether (`gone`). */
  const watch = async (): Promise<boolean> => {
    if (ctx.signal.aborted) throw new Error('aborted');
    const st = await ctx.status().catch(() => undefined);
    if ((st?.dimension ?? NETHER) !== NETHER) { gone = true; return false; }
    me = st?.position ?? me;
    await askZones();
    ents = (await ctx.call<{ entities?: Seen[] }>('world.entities', { maxDistance: 64 }).catch(() => ({ entities: [] as Seen[] }))).entities ?? [];
    const was = health;
    health = st?.health ?? health;
    watched = ghastWatched(ents);
    const biome = st?.biome?.replace(/^minecraft:/, '');
    if (biome && Object.hasOwn(SCOUT_BIOMES, biome) && !biomes.has(biome)) { const at = floorOf(me); biomes.set(biome, { at, out: Math.max(0, Math.round(outAlong(f, at))) }); }
    const d = barterDanger(ents, health, was, { g, me });
    if (d) { stop = d.why; danger = true; if (d.angry) angry = d.why; return false; }
    if (st?.onFire) { stop = 'on fire'; danger = true; return false; }
    return true;
  };

  // ---- the leg: walks planned over the ground read ahead, each to the cell furthest out a walk reaches, a look between
  // every STEP steps; the time it turns back at is half of what is left as it sets foot out
  const walked: Pos[] = [start];
  let far = outAlong(f, start);
  let end: string | undefined;
  let timeUp = false;
  const turnAt = now() + left() / 2;
  const out = () => Math.max(0, Math.round(far));
  /**
   * A walk out along a path, a leg of STEP steps at a time: before each leg after the first, the time (past the turn:
   * `back`), a look (what sends it back: `back`), and the rest of the way still on ground it may walk (a zone come in
   * since it set out, or a ghast come within GHAST_WATCH with a drop's edge on the way: `back` with nothing set, and the
   * walk is planned again). The cells of every leg it arrived at are the way it walked.
   */
  const walkOut = async (path: Pos[]): Promise<'ok' | 'stuck' | 'gone' | 'back'> => {
    const was = zones, calm = !watched;
    for (let i = 0; i < path.length - 1;) {
      const j = Math.min(i + STEP, path.length - 1);
      if (i > 0) {
        if (now() >= turnAt) { timeUp = true; return 'back'; }
        if (!(await watch())) return 'back';
        if ((zones !== was || (calm && watched)) && !path.slice(i + 1).every(walkable)) return 'back';
      }
      const r = await walkAlong(ctx, path.slice(i, j + 1), STEP);
      if (r !== 'ok') return r;
      for (const c of path.slice(i + 1, j + 1)) { walked.push(c); far = Math.max(far, outAlong(f, c)); }
      i = j;
    }
    return 'ok';
  };
  /** The ground read again from where it stands, SEG_BACK behind it to SEGMENT ahead along the bearing. */
  const readAhead = async () => {
    const at = footing(g, me) ?? floorOf(me);
    const t = outAlong(f, at);
    g = await readGround(ctx, aheadBox(f, Math.max(-SCOUT_BEHIND, t - SEG_BACK), Math.min(SCOUT_REACH, t + SEGMENT), at.y));
    if (ctx.signal.aborted) throw new Error('aborted');
    may = scoutGround(g, f, zones);
    knocks = new Map();
    noteLava(g);
    noteDebris(g);
  };
  ctx.progress(`scout: a leg ${toward} from its portal at nether ${fmt(arrived)}: ${chosen.why}`);
  let stuck = 0;
  for (let round = 0; !end && !stop && !gone && !timeUp; round++) {
    if (round >= SCOUT_ROUNDS) { end = `${SCOUT_ROUNDS} walks planned, ${out()} out`; break; }
    if (now() >= turnAt) { timeUp = true; break; }
    if (!(await watch())) break;
    if (round > 0) await readAhead();
    const here = footing(g, me);
    if (!here) { end = `no ground under it ${out()} out`; break; }
    const from = outAlong(f, here);
    const outHere = Math.max(out(), Math.round(from));
    // the walk to the cell furthest out over ground 2 from every drop's edge: the way back is these cells again,
    // walked blind (live, ghasts were within 30 of the hut on four trips of five). Where that goes on no further and
    // only the plain ground does (a ledge the way on), over the plain ground; but not with a ghast watched: back as from
    // a danger then, the bearing left as it was (the ghast closed the way, not the ground)
    let reach = walkFrom(g, [here], c => may(c) && knockSafe(c));
    let next = furthest(f, reach);
    if (!next || next.out < from + 2) {
      const plain = walkFrom(g, [here], may);
      const on = furthest(f, plain);
      // (no cell a walk reaches 2 further out than where it stands: the ground goes on no further that way)
      if (!on || on.out < from + 2) { end = `the way on closed ${outHere} out`; break; }
      if (watched) { stop = `${ghastAbout(ents)}: the way on only by a drop's edge, ${outHere} out`; danger = true; break; }
      reach = plain;
      next = on;
    }
    const w = await walkOut(pathOf(reach, next.at));
    if (w === 'gone') { gone = true; break; }
    if (w === 'stuck' && ++stuck >= STUCK_MOST) { end = `stuck ${out()} out`; break; }
    if (far >= SCOUT_REACH - 1) end = `the leg's ${SCOUT_REACH} walked`;
  }
  if (timeUp && !end && !stop) end = `turned back at half its time, ${out()} out`;
  const worked = far >= LEG_LEAST;

  // ---- what it passed: the zones within the bridge's scan of the way, the lava lakes of its reads, the biomes it
  // walked into (the builds and the lakes past the look's own 24 round its portal: the community's room by it, the
  // pool behind it, are the look's); kept with the leg, unless a danger sent it back before it got anywhere (the
  // bearing is tried again as it was)
  const way = waypoints(walked);
  const passed = [...seenZones.values()].filter(z => walked.some(c => boxGap(zoneBox(z), cellBox(c)) <= PASSED));
  const offWay = (b: Box) => Math.min(...walked.map(c => boxGap(b, cellBox(c))));
  const natural = passed.filter(z => !!z.natural).sort((a, b) => offWay(zoneBox(a)) - offWay(zoneBox(b)));
  const builds = passed.filter(z => !z.natural && boxGap(pb, zoneBox(z)) > LOOK_RADIUS).sort((a, b) => offWay(zoneBox(a)) - offWay(zoneBox(b)));
  const lakes = lakesBy(lava, way, { portal: pb, radius: LOOK_RADIUS });
  // (the debris a trip may go out to by this leg's way: within 24 of a waypoint and no more than 4 under its floor,
  // past the 24 round its portal (the debris trip reads that itself every time), 16 from every zone seen; the nearest
  // the way first)
  const byWay = (p: Pos) => way.some(w => boxGap(cellBox(w), cellBox(p)) <= DEBRIS_RADIUS && p.y >= w.y - 1 - DEBRIS_DEPTH);
  const bare = [...debris.values()]
    .filter(p => boxGap(pb, cellBox(p)) > DEBRIS_RADIUS && byWay(p) && !zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS))
    .sort((a, b) => Math.min(...way.map(w => dist3(w, a))) - Math.min(...way.map(w => dist3(w, b))))
    .slice(0, DEBRIS_KEPT);
  const sites: NetherSite[] = [
    ...natural.map(z => ({ kind: z.natural!, ...middle(zoneBox(z)), leg: bearing })),
    ...builds.slice(0, BUILDS_KEPT).map(z => ({ kind: 'build', ...middle(zoneBox(z)), leg: bearing })),
    ...lakes.slice(0, LAKES_KEPT).map(l => ({ kind: 'lava', ...l.at, leg: bearing })),
    ...bare.map(p => ({ kind: DEBRIS, ...p, leg: bearing })),
    ...[...biomes].map(([kind, b]) => ({ kind, ...b.at, leg: bearing }))
  ];
  const found = [
    ...natural.map(z => `a ${z.natural} at nether ${fmt(middle(zoneBox(z)))} (natural)`),
    builds.length ? `${plural(builds.length, 'build of others', 'builds of others')} (the nearest at nether ${fmt(middle(zoneBox(builds[0])))})` : '',
    lakes.length ? plural(lakes.length, 'lava lake') : '',
    bare.length ? `${bare.length} ancient debris with a face open (the nearest at nether ${fmt(bare[0])})` : '',
    ...[...biomes].map(([kind, b]) => `a ${SCOUT_BIOMES[kind]} from ${b.out} out`)
  ].filter(Boolean).join(', ') || 'nothing of note';
  const why = end ?? stop ?? 'done';
  // (turned back at half its time before LEG_LEAST: what it found of the bearing is nothing, as a danger's)
  const cut = danger || timeUp;
  if (worked || (!cut && !gone)) {
    const n = netherOf(world);
    const leg: ScoutLeg = { bearing, at: now(), reach: out(), end: why.slice(0, 120), way };
    n.legs = [leg, ...(n.legs ?? []).filter(l => l.bearing !== bearing)].slice(0, BEARINGS.length);
    if (sites.length) noteSites(world, sites, leg.at);
  }
  const did = worked ? `scouted ${out()} ${toward}: ${found}` : `no leg walked ${toward}`;
  if (worked) ctx.progress(`nether: ${did}`);
  const work = worked ? { worked: true as const } : {};
  if (gone || !(await inNether(ctx))) return { gain: worked ? 1 : 0, text: worked ? `${did}; ${GONE.text}` : GONE.text, ...work };
  if (angry) {
    (netherOf(world).barter ??= {}).held = { day: gameDay(world), at: now(), why: angry.slice(0, 160) };
    ctx.progress(`nether: ${angry}: back to its portal, the barter, the quartz and the scouting held for the day`);
  }
  const said = `${why}${angry ? ', the barter, the quartz and the scouting held for the day' : ''}`;
  // (turned back by a danger or its time before the leg got anywhere: the bearing is not found closed, and the
  // wrapper's dry mark must not grow 20, 40, 80, 160 min as for one that is: the mark stays as it was, 20 min at least.
  // A leg walked is the trip's work: only then does it count for the stages)
  const mark = { ...(cut && !worked ? { mark: 'same' as const } : {}), ...work };

  // ---- back along the cells it walked out, into its hut, and through its own portal: the known way, every cell of it
  // judged by the rules as it went out, 2 from every drop's edge wherever the ground let it (by one only where the
  // ground left no other way, and no ghast was watched: the barter's way back has the plain ground's as its last way
  // too). A walk leg that did not arrive (a mob in the way): once more, from the cell of the way nearest where it stands
  const back = [...walked].reverse();
  let w = await walkAlong(ctx, back, STEP);
  if (w === 'stuck') {
    const st = await ctx.status().catch(() => undefined);
    const p = floorOf(st?.position ?? me);
    const i = back.reduce((best, c, j) => (dist3(c, p) < dist3(back[best], p) ? j : best), 0);
    w = await walkAlong(ctx, back.slice(i), STEP);
  }
  if (w === 'gone') return { gain: worked ? 1 : 0, text: `${did}; ${GONE.text}`, ...work };
  if (w === 'stuck') return { gain: worked ? 1 : 0, text: `${did}; ${said}; stuck on the way back to its hut`, ...mark };
  const b = await backThroughOwn(ctx, arrived, homeShape, now);
  return { gain: worked ? 1 : 0, text: `${did}; ${said}; ${b.text}`, ...mark, ...(b.cameBack ? { cameBack: true as const } : {}) };
}
