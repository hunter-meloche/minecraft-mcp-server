/**
 * Ancient debris by tunnelling (P3c of the progression plan, stage 3 of the Nether trips, the user's decision 5 of Nov
 * 17: "tunnel for ancient debris at debris depth (y 8-22) under fire resistance"). 26.3 never bares a debris (its
 * ore_ancient_debris features discard every block of it that touches air), so the open-face mining of netherdebris.ts
 * finds none, live and for good: the netherite (P6, 16 debris) comes only out of the rock.
 *
 * Its tunnels (world.nether.tunnels, kept so later trips go on from them): 1x2 tunnels from the ground by its own
 * portal. A trunk's mouth is a cell of that ground within 12 of its portal (not its hut's: HUT_GAP), and the trunk goes
 * down from it as a stair, three blocks a step (the head room a step down needs, no more), wound round a 4x4 column of
 * rock (three steps a side, then right) so the stair stays in its portal's area, down to y 15 (the user's best: 26.3's
 * large debris lies at 8-24, most at 16, the small anywhere from 8 to 119; a tunnel at 15 bares 14 to 17), then
 * level, 32 blocks; branches leave the level
 * trunk every 4 blocks (3 of rock between, each wall seen once), left and right, 24 blocks each, never down or up.
 *
 * A step is dug only where it reads safe, every time on a fresh read of the ground round it (stepFault): through
 * netherrack, basalt and blackstone (and the quartz ore in them) only; nothing open beside it but its own tunnels (a
 * cave beside, or a hole under its next cell, is a fall); no lava or fire within 2 of it (nor ground not loaded); no
 * block that falls over it; nothing within 16 of anyone's build or a natural structure (the bridge's zones down there,
 * asked at every look, and others' portals), none within 2 of cobblestone it did not put there itself, none of its own hut or the ground its
 * portal stands on, none past 48 from its portal. A step that will not do stops that branch (a trunk turns left or
 * right first: it has to get down), and the branch is shut for later trips. The ground read again once a step is dug:
 * lava that shows by the tunnel is plugged with cobblestone and the branch is shut there.
 *
 * Under fire resistance: a potion drunk at the tunnel's face before the first dig (the walk down its own tunnel is
 * read ahead for lava as every walk down there is, and the potion, a barter's 1 in 29, is the trip's to dig by), the
 * effect looked at before every dig (20 s left at the least: the dig and the pickup), and the digging ended while it
 * still lasts out the walk back to its portal. The debris its tunnels bare (beside, over the head, ahead; never one
 * under its own floor, which would leave a hole in the tunnel) is mined by its own hand with a diamond or netherite
 * pickaxe in hand when the debris's own rules hold (netherdebris.ts bareFault: no lava within 2, nothing that falls
 * over it), at most 4 a trip, and picked up where it falls (the tunnel's cell beside it). The fire gear worn
 * (netherset.ts fireGear: 20 EPF against fire, the golden helmet's fire protection 4 over the main set), as the
 * fortress goes.
 *
 * It stops at the trip's 4, its time (the way back kept), the effect running low, on the ghast rule and the barter's
 * other dangers (barterDanger: a hit, a piglin turned, a hoglin or a brute near), on fire, the pockets full or the
 * pickaxe gone; then back along its tunnel to the mouth, over the ground to its hut, and through its own portal. Says
 * `nether: tunnelled N blocks: M ancient debris mined, K picked up`. The open-face mining (netherdebris.ts) is kept
 * as it is.
 *
 * Coordinates are `nether (x, y, z)` in the lines, as nether.ts says them. Nothing here is used at the module's top
 * level (worktasks.ts reaches it, and this module reaches most of the brain).
 */
import type { InventoryItem } from '../tools.js';
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { WorkResult } from './work.js';
import { homePortal } from './portal.js';
import { freeChestTotals } from './chests.js';
import {
  NETHER, PLUGS_KEPT, TUNNELS_KEPT, TUNNEL_STEPS, barterHold, firePotions, gameDay, netherOf, peekNether, portalCells, stageNeeds, type Heading, type Tunnel,
  type TunnelMemory
} from './nether.js';
import { BACK_MS, LAVA_GAP, NEAR, backThroughOwn, barterDanger, barterGround, ghastSees, toOwnPortal, type Seen } from './netherbarter.js';
import { HUT_GAP } from './netherquartz.js';
import { DEBRIS, EFFECT_LEAST_S, bareFault, debrisPick, fetchDebrisKit, fireOf, placeBox, potionSeconds, potionToDrink } from './netherdebris.js';
import { dressedFireGear, fireGear } from './netherset.js';
import {
  FROM_BUILDS, GONE, PLACED_GAP, SETUP_HEALTH, SETUP_WAITS, blockAt, boxGap, boxOf, cellOf, fetchSetupKit, footing, grow, inNether, pathOf, placedIn, readGround, setOpen,
  setupShort, standable, walkAlong, walkFrom, zoneBox, type Box, type Grid, type NetherZone
} from './nethersetup.js';

const MINUTE = 60_000;

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const cellKey = (p: Pos) => `${p.x},${p.y},${p.z}`;
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;
const add = (p: Pos, dx: number, dy: number, dz: number): Pos => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const floorOf = (p: Pos): Pos => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const cellBox = (p: Pos): Box => ({ x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z });
/** Across the ground from a box to a cell, to the block (the radius of its tunnels from its portal). */
const flatGap = (b: Box, p: Pos) => Math.max(0, b.x1 - p.x, p.x - b.x2, b.z1 - p.z, p.z - b.z2);
/** Seconds as the status line says them: `3:00`. */
const minSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------------------------------------------ the rules

/** The depth band (the user's y 8-22) and the height its tunnels run level at (the user's "15 the best"). */
export const TUNNEL_BAND = { low: 8, best: 15, high: 22 } as const;
/**
 * What a tunnel goes through: the Nether's own rock (netherrack, basalt, blackstone), and the quartz ore that veins it
 * (a branch shut at every vein would end most of them: the ore is the netherrack's own, and the home wants quartz).
 * Nothing else: no gold ore (piglins guard it), no gravel or soul sand (they fall, or a soul sand valley's caves lie
 * by them), no magma (it burns, and lava is by it), nothing anyone put there.
 */
const ROCK = /^(netherrack|basalt|smooth_basalt|blackstone|nether_quartz_ore)$/;
/** Its trunks' mouths: within this of its portal (across the ground), and this far from another trunk's mouth. */
export const MOUTH_RADIUS = 12;
const TRUNK_GAP = 8;
/** At a trunk's mouth, the open ground it sets out from: open cells by its first steps that are no cave (at the mouth's height or over it, this near it). */
const MOUTH_OPEN = 4;
/** No cell of its tunnels further than this from its portal, across the ground. */
export const TUNNEL_RADIUS = 48;
/** Trunks at most; a trunk's level part and a branch, blocks; a branch every BRANCH_GAP blocks of a trunk's level part, the first BRANCH_FIRST in. */
export const TRUNKS = 4;
export const TRUNK_LEVEL = 32;
export const BRANCH_LONG = 24;
export const BRANCH_GAP = 4;
const BRANCH_FIRST = 2;
/** A trunk's stair goes this many steps a side round its column of rock, then turns right. */
export const SPIRAL_SIDE = 3;
/** Debris mined a trip at most. */
export const TUNNEL_TRIP = 4;
/** Debris the home wants (P6: four netherite ingots, four scrap each), counting its scrap, ingots and netherite pieces. */
export const DEBRIS_WANT = 16;
/** The time a step of its own tunnel takes on foot, ms (a careful walk's legs of four, a look between). */
export const TUNNEL_STEP_MS = 500;
/** The effect a potion leaves for the digging at the least, s, past the way back and the last dig's 20: a tunnel's end further than that is not gone to. */
export const DIG_LEAST_S = 30;
/** The tunnel trip's whole time, from the kit at home to back through its own portal, and what it still needs after the kit (the nether rung's run stops at 12 min). */
export const TUNNEL_MAX_MS = 10 * MINUTE;
export const TUNNEL_LEAST_MS = 4 * MINUTE;
/** The waits, in looks a pollMs apart (a test sets pollMs to nothing; the counts stand): what a dig dropped has a moment to come down. */
export const TUNNEL_WAITS = { pollMs: 500, dropLooks: 2 };
/** Its tunnels' plugs: blast-proof, no falling block, and what only a player puts down there (so its own are remembered). */
const PLUG = ['cobblestone', 'cobbled_deepslate'] as const;
/** The cells of its own tunnel read and checked ahead at a time on a walk down it; ends of tunnels planned a trip at most. */
const WALK_CHUNK = 12;
const PLANS = 4;

const DIR: Readonly<Record<Heading, readonly [number, number]>> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
const RIGHT: Readonly<Record<Heading, Heading>> = { n: 'e', e: 's', s: 'w', w: 'n' };
const LEFT: Readonly<Record<Heading, Heading>> = { n: 'w', w: 's', s: 'e', e: 'n' };
export const HEADING_WORD: Readonly<Record<Heading, string>> = { n: 'north', e: 'east', s: 'south', w: 'west' };
const FACES: readonly [number, number, number][] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
const passable = (b: string | null) => { const c = cellOf(b); return c === 'open' || c === 'plant'; };
const firm = (b: string | null) => { const c = cellOf(b); return c === 'dig' || c === 'solid' || c === 'falls'; };

// ------------------------------------------------------------------------------------------------ the tunnels' shape

/** The steps of a tunnel's way, pure: each its heading and whether it goes down. */
const stepsOf = (way: string): { h: Heading; down: boolean }[] => [...way].map(c => ({ h: c.toLowerCase() as Heading, down: c !== c.toLowerCase() }));

/** The standing cells of a tunnel, pure: its start, then where each step of its way ends. */
export function tunnelCells(t: Pick<Tunnel, 'start' | 'way'>): Pos[] {
  const out = [{ ...t.start }];
  for (const s of stepsOf(t.way)) {
    const p = out[out.length - 1];
    out.push(add(p, DIR[s.h][0], s.down ? -1 : 0, DIR[s.h][1]));
  }
  return out;
}

/**
 * A step from a standing cell, pure: the cells it digs (the top first: each is then seen from the one before it) and
 * the cell it ends on. Level: the two ahead at the feet and the head. Down: the three ahead from the head down to the
 * next floor's, the bot's head room as it steps down (Baritone's descend asks the two over the cell it lands in).
 */
export function stepOf(f: Pos, h: Heading, down: boolean): { dig: Pos[]; to: Pos } {
  const a = add(f, DIR[h][0], 0, DIR[h][1]);
  return down ? { dig: [add(a, 0, 1, 0), a, add(a, 0, -1, 0)], to: add(a, 0, -1, 0) } : { dig: [add(a, 0, 1, 0), a], to: a };
}

/** The open cells of its tunnels, pure: every standing cell, the head over it, and over a step down the third it dug. */
export function tunnelOpen(list: readonly Pick<Tunnel, 'start' | 'way'>[]): Set<string> {
  const out = new Set<string>();
  for (const t of list) {
    const cells = tunnelCells(t);
    out.add(cellKey(cells[0])).add(cellKey(add(cells[0], 0, 1, 0)));
    stepsOf(t.way).forEach((s, i) => { for (const c of stepOf(cells[i], s.h, s.down).dig) out.add(cellKey(c)); });
  }
  return out;
}

/** The heading a step from one cell to the next went, across the ground (undefined for no step across). */
const headingOf = (a: Pos, b: Pos): Heading | undefined =>
  (Object.keys(DIR) as Heading[]).find(h => DIR[h][0] === b.x - a.x && DIR[h][1] === b.z - a.z);

/**
 * The headings a tunnel's next step tries, pure, in order. A branch goes straight on only. A trunk above the band's
 * best height winds down round its column: SPIRAL_SIDE steps down a side, then right; straight on, then left, where
 * that will not do. A trunk at the band runs level, straight on, then right, then left.
 */
export function nextHeadings(t: Pick<Tunnel, 'head' | 'way' | 'from'>, f: Pos): Heading[] {
  const last = (t.way.slice(-1).toLowerCase() || t.head) as Heading;
  if (t.from !== undefined) return [last];
  const tail = t.way.slice(-SPIRAL_SIDE);
  if (f.y > TUNNEL_BAND.best && tail.length === SPIRAL_SIDE && [...tail].every(c => c === last.toUpperCase())) return [RIGHT[last], last, LEFT[last]];
  return [last, RIGHT[last], LEFT[last]];
}

/** A step goes down while the cell it starts from is over the band's best height. */
export const goesDown = (f: Pos): boolean => f.y > TUNNEL_BAND.best;

/**
 * What a step's judgement needs besides the ground: its own portal's box (its hut by it), the zones down there (anyone's
 * build, a natural structure), the cobblestone of the read it did not put there itself, its own tunnels' open cells,
 * the holes the debris it dug left in their walls (`holes`: open, its own, no cave), and for a trunk's first steps its
 * mouth (the open ground there is no cave).
 */
export interface TunnelView { portal: Box; zones: Box[]; placed: Pos[]; own: Set<string>; holes?: Set<string>; mouth?: Pos }

/**
 * Why a step may not be dug, pure, or null (see the top of the file), judged on a read of the ground round it: past
 * TUNNEL_RADIUS from its portal; its own hut's ground; within FROM_BUILDS of a zone; a cell to dig that is not the
 * Nether's rock or a debris (open: its own tunnel, or a cave; the ground not loaded); lava or fire within LAVA_GAP of
 * a cell it digs (and three under the cell it lands on, as a walk's lava rule reads); a block that falls over it; no
 * firm floor under the cell it lands on, or magma; an open cell beside a cell it digs that is none of its own (a cave,
 * a fall); within PLACED_GAP of cobblestone it did not put there.
 */
export function stepFault(g: Grid, f: Pos, h: Heading, down: boolean, v: TunnelView): string | null {
  const { dig, to } = stepOf(f, h, down);
  const all = [...dig, to];
  if (all.some(c => flatGap(v.portal, c) > TUNNEL_RADIUS)) return `${TUNNEL_RADIUS} from its portal`;
  if (all.some(c => boxGap(v.portal, cellBox(c)) <= HUT_GAP)) return 'its own hut\'s, or the ground its portal stands on';
  if (all.some(c => v.zones.some(z => boxGap(z, cellBox(c)) < FROM_BUILDS))) return `within ${FROM_BUILDS} of someone's build or a natural structure`;
  const mouthGround = (c: Pos) => !!v.mouth && c.y >= v.mouth.y && Math.max(Math.abs(c.x - v.mouth.x), Math.abs(c.z - v.mouth.z)) <= MOUTH_OPEN;
  const mine = new Set(all.map(cellKey));
  const here = new Set([cellKey(f), cellKey(add(f, 0, 1, 0))]);
  for (const c of dig) {
    const b = blockAt(g, c);
    if (b === null) return 'the ground ahead not loaded';
    if (passable(b)) {
      if (v.holes?.has(cellKey(c))) continue;
      if (v.own.has(cellKey(c))) return `its own tunnel ahead at nether ${fmt(c)}`;
      if (!mouthGround(c)) return `a cave ahead at nether ${fmt(c)}`;
    } else if (!ROCK.test(b) && b !== DEBRIS) return `${b} ahead at nether ${fmt(c)} (it tunnels through netherrack, basalt and blackstone only)`;
  }
  const lava = lavaAhead(g, dig, to);
  if (lava) return lava;
  const over = add(dig[0], 0, 1, 0);
  if (cellOf(blockAt(g, over)) === 'falls') return `${blockAt(g, over)} over the way at nether ${fmt(over)} (it falls)`;
  const floor = blockAt(g, add(to, 0, -1, 0));
  if (!firm(floor)) return `a drop ahead at nether ${fmt(add(to, 0, -1, 0))}`;
  if (floor === 'magma_block') return `magma under the way at nether ${fmt(add(to, 0, -1, 0))}`;
  for (const c of dig) {
    if (passable(blockAt(g, c))) continue;
    for (const [dx, dy, dz] of FACES) {
      const n = add(c, dx, dy, dz);
      const k = cellKey(n);
      if (mine.has(k) || here.has(k) || v.own.has(k) || v.holes?.has(k) || mouthGround(n)) continue;
      const b = blockAt(g, n);
      if (b === null) return 'the ground ahead not loaded';
      if (passable(b) || cellOf(b) === 'portal') return `a cave beside the way at nether ${fmt(n)}`;
    }
  }
  const placed = v.placed.find(p => all.some(c => Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y), Math.abs(c.z - p.z)) <= PLACED_GAP));
  if (placed) return `someone's ${blockAt(g, placed) ?? 'block'} by the way at nether ${fmt(placed)}`;
  return null;
}

/**
 * Lava or fire within LAVA_GAP of a step's cells, every way, and three under the cell it ends on (the walks' lava rule:
 * a misstep's and a knock-back's reach), in words, or null; the ground there not loaded is said so.
 */
export function lavaAhead(g: Grid, dig: Pos[], to: Pos): string | null {
  const near = (q: Pos): string | null => {
    const k = cellOf(blockAt(g, q));
    return k === 'hot' ? `lava within ${LAVA_GAP} ahead at nether ${fmt(q)}` : k === 'unknown' ? 'the ground ahead not loaded' : null;
  };
  for (const c of dig) for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dy = -LAVA_GAP; dy <= LAVA_GAP; dy++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) {
    const why = near(add(c, dx, dy, dz));
    if (why) return why;
  }
  for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) {
    const why = near(add(to, dx, -LAVA_GAP - 1, dz));
    if (why) return why;
  }
  return null;
}

/** The ground to read round a step: its cells and where it stands, four across and under, three over (the lava rule's 2 and a block, the ghasts' sight a little way). */
export function stepBox(f: Pos, h: Heading, down: boolean): Box {
  const { dig } = stepOf(f, h, down);
  const b = boxOf([f, add(f, 0, 1, 0), ...dig]);
  return { x1: b.x1 - 4, y1: Math.max(1, b.y1 - 4), z1: b.z1 - 4, x2: b.x2 + 4, y2: Math.min(126, b.y2 + 3), z2: b.z2 + 4 };
}

/**
 * The debris a step bared that it may mine from where the step ends, pure: each face by a cell the step dug, that the
 * debris's own rules pass (netherdebris.ts bareFault: no lava or fire within 2, none placed by it, a face open, nothing
 * that falls over it, no floor over a hole), FROM_BUILDS from every zone, and none under a cell of its tunnels (`floors`:
 * the hole would be in its floor). And how many fell to each fault.
 */
export function baredDebris(g: Grid, dug: Pos[], floors: Set<string>, v: Pick<TunnelView, 'zones' | 'placed'>): { ores: Pos[]; faults: Map<string, number> } {
  const ores: Pos[] = [];
  const faults = new Map<string, number>();
  const seen = new Set<string>();
  for (const c of dug) for (const [dx, dy, dz] of FACES) {
    const p = add(c, dx, dy, dz);
    const k = cellKey(p);
    if (seen.has(k) || blockAt(g, p) !== DEBRIS) continue;
    seen.add(k);
    const why = floors.has(k) ? 'under its tunnel\'s floor' : v.zones.some(z => boxGap(z, cellBox(p)) < FROM_BUILDS) ? `within ${FROM_BUILDS} of someone's build` : bareFault(g, p, v.placed);
    if (why) faults.set(why, (faults.get(why) ?? 0) + 1);
    else ores.push(p);
  }
  return { ores, faults };
}

// ------------------------------------------------------------------------------------------------ the way to a tunnel's end

/** A cell of the way to a tunnel's end: where, and which tunnel's which cell it is. */
export interface WayCell { p: Pos; t: number; k: number }

/**
 * The cells from a trunk's mouth to tunnel `i`'s cell `upto` (its end when not given), pure: down its trunk to where
 * it branches, then along it. Undefined where a walk found one of them unsound (`cut`), or the list does not hold
 * together (a branch whose start is no cell of its trunk).
 */
export function wayTo(list: readonly Tunnel[], i: number, upto?: number, depth = 0): WayCell[] | undefined {
  const t = list[i];
  if (!t || depth > list.length) return undefined;
  const cells = tunnelCells(t);
  const end = upto ?? cells.length - 1;
  if (end < 0 || end >= cells.length || (t.cut !== undefined && t.cut <= end)) return undefined;
  const mine = cells.slice(0, end + 1).map((p, k) => ({ p, t: i, k }));
  if (t.from === undefined) return mine;
  if (t.from >= i) return undefined;
  const at = tunnelCells(list[t.from]).findIndex(c => same(c, t.start));
  const before = at < 0 ? undefined : wayTo(list, t.from, at, depth + 1);
  return before && [...before, ...mine.slice(1)];
}

/** What a trip goes on with: the end of a tunnel still going on, a new branch off a trunk, or a new trunk. */
export type TunnelPlan = { do: 'on'; i: number; way: WayCell[] } | { do: 'branch'; from: number; at: number; head: Heading; way: WayCell[] } | { do: 'trunk' };

/**
 * What a trip goes on with, pure, or undefined with nothing left to dig: the end of a tunnel not shut whose way holds
 * (the nearest by its way first: what was begun is gone on with first); else a branch not dug yet off a trunk's level
 * part, every BRANCH_GAP blocks, left and right (the nearest first); else a new trunk while it has fewer than TRUNKS
 * and the list has room. `fits`: whether a way is one the trip has the time and the effect for (each not that is passed).
 */
export function tunnelPlan(list: readonly Tunnel[], fits: (way: WayCell[]) => boolean = () => true): TunnelPlan | undefined {
  const on = list.flatMap((t, i) => {
    const way = t.shut ? undefined : wayTo(list, i);
    return way ? [{ do: 'on' as const, i, way }] : [];
  }).sort((a, b) => a.way.length - b.way.length);
  const goOn = on.find(p => fits(p.way));
  if (goOn) return goOn;
  if (list.length < TUNNELS_KEPT) {
    const spots: TunnelPlan[] = [];
    list.forEach((t, i) => {
      if (t.from !== undefined) return;
      const cells = tunnelCells(t);
      const level = cells.findIndex((c, k) => k > 0 && c.y === cells[k - 1].y && c.y >= TUNNEL_BAND.low && c.y <= TUNNEL_BAND.high);
      if (level < 0) return;
      for (let k = level + BRANCH_FIRST; k < cells.length; k += BRANCH_GAP) {
        const h = headingOf(cells[k - 1], cells[k]);
        if (!h) continue;
        for (const head of [LEFT[h], RIGHT[h]]) {
          if (list.some(o => o.from === i && same(o.start, cells[k]) && o.head === head)) continue;
          const way = wayTo(list, i, k);
          if (way) spots.push({ do: 'branch', from: i, at: k, head, way });
        }
      }
    });
    const len = (p: TunnelPlan) => ('way' in p ? p.way.length : 0);
    const branch = spots.sort((a, b) => len(a) - len(b)).find(p => 'way' in p && fits(p.way));
    if (branch) return branch;
    if (list.filter(t => t.from === undefined).length < TRUNKS) return { do: 'trunk' };
  }
  return undefined;
}

/**
 * Where a new trunk starts, pure: of the cells a walk reaches from where the bot stands over the ground `may` allows
 * (round its portal), those within MOUTH_RADIUS of its portal, not its hut's, TRUNK_GAP from another trunk's mouth, the
 * nearest by the walk first; each heading (the one leading furthest from its portal first) whose first SPIRAL_SIDE + 1
 * steps all pass stepFault on the ground read. Undefined with none, and the most common fault.
 */
export function chooseMouth(g: Grid, start: Pos, may: (p: Pos) => boolean, list: readonly Tunnel[], v: Omit<TunnelView, 'mouth'>):
  { mouth: Pos; head: Heading; walk: Pos[] } | { why: string } {
  const reach = walkFrom(g, [start], may);
  const mouths = list.filter(t => t.from === undefined).map(t => t.start);
  const cells = [...reach.entries()].map(([k, r]) => { const [x, y, z] = k.split(',').map(Number); return { p: { x, y, z }, n: r.n }; })
    .filter(c => flatGap(v.portal, c.p) <= MOUTH_RADIUS && boxGap(v.portal, cellBox(c.p)) > HUT_GAP + 1 &&
      !mouths.some(m => Math.max(Math.abs(m.x - c.p.x), Math.abs(m.z - c.p.z)) < TRUNK_GAP))
    .sort((a, b) => a.n - b.n || a.p.x - b.p.x || a.p.z - b.p.z);
  const faults = new Map<string, number>();
  const centre = { x: (v.portal.x1 + v.portal.x2) / 2, z: (v.portal.z1 + v.portal.z2) / 2 };
  for (const c of cells.slice(0, 200)) {
    const heads = (Object.keys(DIR) as Heading[]).sort((a, b) =>
      Math.hypot(c.p.x + DIR[b][0] - centre.x, c.p.z + DIR[b][1] - centre.z) - Math.hypot(c.p.x + DIR[a][0] - centre.x, c.p.z + DIR[a][1] - centre.z));
    for (const head of heads) {
      const t: Tunnel = { start: c.p, head, way: '' };
      let f = c.p;
      let why: string | null = null;
      for (let i = 0; i <= SPIRAL_SIDE && !why; i++) {
        const own = new Set([...v.own, ...tunnelOpen([t])]);
        const down = goesDown(f);
        const ok = nextHeadings(t, f).find(h => !stepFault(g, f, h, down, { ...v, own, mouth: c.p }));
        if (!ok) { why = stepFault(g, f, nextHeadings(t, f)[0], down, { ...v, own, mouth: c.p }); break; }
        t.way += down ? ok.toUpperCase() : ok;
        f = stepOf(f, ok, down).to;
      }
      if (!why) return { mouth: c.p, head, walk: pathOf(reach, c.p) };
      faults.set(why, (faults.get(why) ?? 0) + 1);
    }
  }
  const top = [...faults].sort((a, b) => b[1] - a[1])[0];
  return { why: cells.length ? `no mouth for a tunnel within ${MOUTH_RADIUS} of its portal${top ? ` (${top[1]} ${top[0]})` : ''}` : `no ground it may walk within ${MOUTH_RADIUS} of its portal, off its hut's` };
}

// ------------------------------------------------------------------------------------------------ the gate

/** Its tunnels as the memory has them, for its own portal (from another portal: none). A look only. */
export function tunnelsFor(world: WorldMemory): Tunnel[] {
  const n = peekNether(world);
  return n.portal && n.tunnels && same(n.tunnels.portal, n.portal) ? n.tunnels.list : [];
}

/** The debris the home has toward DEBRIS_WANT, carried and in the chests: the debris, its scrap, four a netherite ingot and four a netherite piece made. */
export function debrisHome(s: Pick<Snapshot, 'counts'>, world: WorldMemory): number {
  const free = freeChestTotals(world);
  const has = (n: string) => (s.counts.get(n) ?? 0) + (free[n] ?? 0);
  const pieces = ['helmet', 'chestplate', 'leggings', 'boots'].reduce((a, k) => a + has(`netherite_${k}`), 0);
  return has(DEBRIS) + has('netherite_scrap') + 4 * has('netherite_ingot') + 4 * pieces;
}

/** The tunnelling is open from its stage (3: nether.ts NETHER_STAGES), its own portal standing and the two sides linked. */
export function tunnelOpenAt(world: WorldMemory): boolean {
  const n = peekNether(world);
  return n.linked === true && !!n.portal && n.stage >= (stageNeeds('tunnel')?.stage ?? Infinity);
}

/**
 * Whether the tunnel trip can set out now, pure: not held (a piglin turned on the bot by its portal today: the
 * barter's hold); the home short of DEBRIS_WANT; something left to dig (tunnelPlan); a potion of fire resistance in
 * stock (carried or in the chests, by its contents); a diamond or netherite pickaxe (the debris module's own check);
 * the fire gear as it will be dressed for the Nether (netherset.ts dressedFireGear: the fortress's rule); not hurt past what the run heals
 * at home; nothing of the Nether kit short that the chests lack. The hour is the rung's.
 */
export function tunnelReady(s: Snapshot, world: WorldMemory): Decline | null {
  const held = barterHold(world, s.now);
  if (held) return { cause: 'hold', text: `tunnelling held for the day: ${held.why}` };
  const have = debrisHome(s, world);
  if (have >= DEBRIS_WANT) return { cause: 'stocked', text: `tunnelling: ancient debris enough at home (${have}/${DEBRIS_WANT}, its scrap and netherite counted)` };
  const list = tunnelsFor(world);
  if (!tunnelPlan(list)) return { cause: 'unneeded', text: `tunnelling: every one of its ${list.length} tunnels shut, and no room for more` };
  if (firePotions(s.items, world) < 1) return { cause: 'kit', text: 'tunnelling shut: no potion of fire resistance in stock (carried or in the chests)' };
  const free = freeChestTotals(world);
  if (!debrisPick(s.items) && !['netherite_pickaxe', 'diamond_pickaxe'].some(n => (free[n] ?? 0) > 0)) {
    return { cause: 'kit', text: 'tunnelling: no diamond or netherite pickaxe (carried or in the chests): ancient debris drops nothing to any other' };
  }
  const gear = dressedFireGear(s.items, world);
  if (!gear.ok) return { cause: 'kit', text: `tunnelling: the fire gear is short: ${gear.missing.join('; ')} (it tunnels only in it)` };
  if (s.health < SETUP_HEALTH) return no.health(s, 'the tunnelling', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `tunnelling: short of ${short.join(', ')} (carried or in the chests)` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the trip

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];
const debrisOf = (items: InventoryItem[]) => items.filter(i => i.slot >= 0 && i.slot < 36 && i.name === DEBRIS).reduce((a, i) => a + i.count, 0);
const freeSlots = (items: InventoryItem[]) => 36 - new Set(items.filter(i => i.slot >= 0 && i.slot < 36).map(i => i.slot)).size;
const plugOf = (items: InventoryItem[]) => items.find(i => i.slot >= 0 && i.slot < 36 && (PLUG as readonly string[]).includes(i.name))?.name;

/** Its tunnels for its own portal, written (from another portal: let go, and begun again). */
function tunnelsOf(world: WorldMemory, own: Pos): TunnelMemory {
  const n = netherOf(world);
  if (!n.tunnels || !same(n.tunnels.portal, own)) n.tunnels = { portal: { ...own }, list: [] };
  return n.tunnels;
}

/**
 * The tunnel trip (see the top of the file). From home with the Nether kit, the fire gear on, a pickaxe for debris,
 * a potion and cobblestone (or it does not set out: untried), through the home portal into its own hut, over the
 * ground to a tunnel's mouth, down it to its end, the potion drunk there and the tunnel dug on, branch after branch;
 * back along its tunnel and through its own portal. Gain: the debris it brought back. Out of the Nether halfway (a
 * death), it stops at once and writes nothing more.
 */
export async function tunnelRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => Math.min(budgetMs, TUNNEL_MAX_MS) - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  const own = peekNether(world).portal;
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  if (!own) return { gain: 0, text: 'no portal of its own down there to tunnel from', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  const short = await fetchDebrisKit(ctx);
  if (short) return { gain: 0, text: `not setting out: ${short}`, untried: true };
  const kit = await inventory(ctx);
  const why = [...fireGear(kit).missing, ...(plugOf(kit) ? [] : ['no cobblestone to plug lava with'])];
  if (why.length) return { gain: 0, text: `not setting out to tunnel: ${why.join('; ')}`, untried: true };
  if (left() < TUNNEL_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the tunnel trip's ${TUNNEL_MAX_MS / MINUTE} min is left`, untried: true };
  }
  const to = await toOwnPortal(ctx, home, own, now, 'tunnelling');
  if ('result' in to) return to.result;
  const { arrived, homeShape } = to;
  await pause(SETUP_WAITS.loadMs);
  if (ctx.signal.aborted) throw new Error('aborted');
  const pb = boxOf(portalCells(arrived));
  const mem = tunnelsOf(world, own);

  // ---- the ground round its portal (the walks to and from a trunk's mouth go over it), the zones down there (asked
  // at every look: the bridge's scan follows the bot), every one seen on the trip kept
  const ground = await readGround(ctx, placeBox(pb, pb.y1 - 1));
  /** the ground as last read (round its portal, round a step, a stretch of its tunnel): the looks' ghast sight goes by it */
  let g = ground;
  const seenZones = new Map<string, Box>();
  // others' portals down there kept as builds too (the community's by its hut: a bare portal the bridge's scan may make
  // no zone of), 16 from every cell it digs
  const theirs = (peekNether(world).seen?.[NETHER] ?? []).filter(p => !portalCells(p).some(c => Math.abs(c.x - own.x) <= 1 && Math.abs(c.y - own.y) <= 1 && Math.abs(c.z - own.z) <= 1))
    .map(p => grow(boxOf(portalCells(p)), 1));
  let zones: Box[] = [...theirs];
  let surfaceMay = barterGround(ground, pb, zones, MOUTH_RADIUS + 4);
  const askZones = async (): Promise<boolean> => {
    const r = await ctx.call<{ zones?: NetherZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => undefined);
    if (!r) return false;
    let more = false;
    for (const z of (r.zones ?? []).map(zoneBox)) {
      const k = `${z.x1},${z.y1},${z.z1},${z.x2},${z.y2},${z.z2}`;
      if (!seenZones.has(k)) { seenZones.set(k, z); more = true; }
    }
    if (more) { zones = [...seenZones.values(), ...theirs]; surfaceMay = barterGround(ground, pb, zones, MOUTH_RADIUS + 4); }
    return true;
  };
  if (!(await askZones())) {
    const b = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no tunnelling: the bridge did not say where the builds down there are; ${b.text}`, mark: 'same', ...(b.cameBack ? { cameBack: true as const } : {}) };
  }
  const st0 = await ctx.status().catch(() => undefined);
  const start = footing(ground, st0?.position ?? to.me);
  if (!start) {
    const b = await backThroughOwn(ctx, arrived, homeShape, now);
    return { gain: 0, text: `no ground to stand on by its portal at nether ${fmt(arrived)}: no tunnelling; ${b.text}`, ...(b.cameBack ? { cameBack: true as const } : {}) };
  }

  // ---- the looks: where it stands, what is round it, what would send it back (the barter's rules), the effect on it
  let health = st0?.health ?? 20;
  let me: Pos = st0?.position ?? to.me;
  let fire = fireOf(st0);
  let ents: Seen[] = [];
  let stop: string | undefined;
  let angry: string | undefined;
  let gone = false;
  /** turned back by what says nothing of the rock it tunnels (a danger, the effect, the time): no dry mark grows */
  let unlearnt = false;
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
    const d = barterDanger(ents, health, was, { g, me });
    if (d) { stop = d.why; unlearnt = true; if (d.angry) angry = d.why; return false; }
    if (st?.onFire) { stop = 'on fire'; unlearnt = true; return false; }
    return true;
  };
  /** The effect as the bridge has it now (before every dig): false when out of the Nether. */
  const fireNow = async (): Promise<boolean> => {
    const st = await ctx.status().catch(() => undefined);
    if ((st?.dimension ?? NETHER) !== NETHER) { gone = true; return false; }
    if (st) fire = fireOf(st);
    return true;
  };

  // ---- the ways: over the ground from its hut's cell to a trunk's mouth, and its tunnels' cells from there
  /** the walk over the ground from its hut's cell to a mouth (undefined where none), each found once */
  const surface = new Map<string, Pos[] | undefined>();
  const surfaceTo = (mouth: Pos): Pos[] | undefined => {
    const k = cellKey(mouth);
    if (!surface.has(k)) {
      const reach = walkFrom(ground, [start], c => same(c, mouth) || surfaceMay(c));
      surface.set(k, reach.has(k) ? pathOf(reach, mouth) : undefined);
    }
    return surface.get(k);
  };
  /** where it stands: on the ground by its portal (`at` none: at its hut's cell, or the walk to a mouth), or in a tunnel (the way to the cell it stands on) */
  let at: WayCell[] | undefined;
  const stepS = TUNNEL_STEP_MS / 1000;
  /** The way back from the end of a way to its hut's cell, s: along the tunnel to the mouth and over the ground. */
  const backS = (way: WayCell[]) => ((surfaceTo(way[0].p)?.length ?? 1) - 1 + way.length - 1) * stepS;
  /** The way from where it stands to the end of another, s: back to where the two part (its hut's cell, for another trunk), then out. */
  const toS = (way: WayCell[]) => {
    if (!at) return backS(way);
    let p = 0;
    while (p < at.length && p < way.length && same(at[p].p, way[p].p)) p++;
    return p ? (at.length - p + way.length - p) * stepS : backS(at) + backS(way);
  };
  /**
   * A way out of a tunnel's end that the trip has the time and the effect for: the walk there, a dig's worth, and
   * the way back from there, within the trip's time and within the effect (on it, or the potion it would drink there:
   * the digging ends while the effect lasts out the way back). A trunk whose mouth no walk reaches will not do.
   */
  let potionS = 0;
  const fits = (way: WayCell[]) => {
    if (!surfaceTo(way[0].p)) return false;
    const there = toS(way), back = backS(way);
    const effect = drunk ? fire - there : Math.max(fire - there, potionS);
    return left() >= (there + back + DIG_LEAST_S) * 1000 + BACK_MS && effect >= EFFECT_LEAST_S + back + DIG_LEAST_S;
  };
  /**
   * A walk down a way from cell `from` (where it stands) to `upto`: a stretch of WALK_CHUNK cells at a time, each
   * stretch read first (every cell still one to stand in, no lava within 2 of it: a walk's lava rule), a look between
   * every leg. A cell found unsound cuts its tunnel there for good (`closed`). `ok`, `back` (`stop` says why), `gone`,
   * `stuck`, `closed`.
   */
  const walkDown = async (way: WayCell[], from: number, upto: number): Promise<'ok' | 'back' | 'gone' | 'stuck' | 'closed'> => {
    for (let i = from; i < upto;) {
      const j = Math.min(i + WALK_CHUNK, upto);
      const part = way.slice(i, j + 1);
      const b = boxOf(part.map(c => c.p));
      g = await readGround(ctx, { x1: b.x1 - 3, y1: Math.max(1, b.y1 - 4), z1: b.z1 - 3, x2: b.x2 + 3, y2: Math.min(126, b.y2 + 3), z2: b.z2 + 3 });
      if (ctx.signal.aborted) throw new Error('aborted');
      const bad = part.slice(1).find(c => !standable(g, c.p) || lavaNear(g, c.p));
      if (bad) {
        const t = mem.list[bad.t];
        t.cut = Math.min(t.cut ?? Infinity, bad.k);
        const said = `closed at nether ${fmt(bad.p)}: ${standable(g, bad.p) ? `lava within ${LAVA_GAP} of it` : 'no cell to stand in there any more'}`;
        t.shut ??= said;
        ctx.progress(`tunnel: tunnel ${bad.t + 1} ${said}`);
        return 'closed';
      }
      // (where it is told by the cells it may have reached: a walk cut short goes back from the nearest of them)
      at = way.slice(0, j + 1);
      const r = await walkAlong(ctx, part.map(c => c.p), 4, watch);
      if (r === 'gone') { gone = true; return 'gone'; }
      if (r !== 'ok') return r === 'back' && (stop || gone) ? 'back' : 'stuck';
      i = j;
    }
    return 'ok';
  };
  /** Back along its tunnel to the mouth from where it stands, and over the ground to its hut's cell: no look holds it back (the way home). */
  const toHutCell = async (): Promise<'ok' | 'stuck' | 'gone'> => {
    if (at && at.length) {
      const back = [...at].reverse().map(c => c.p);
      let r: 'ok' | 'stuck' | 'gone' | 'back' = 'stuck';
      for (let i = 0; i < 2 && r === 'stuck'; i++) {
        const st = await ctx.status().catch(() => undefined);
        const p = floorOf(st?.position ?? me);
        const from = back.reduce((best, c, n) => (Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) < Math.hypot(back[best].x - p.x, back[best].y - p.y, back[best].z - p.z) ? n : best), 0);
        r = await walkAlong(ctx, back.slice(from), 4);
      }
      if (r === 'gone') return 'gone';
      if (r !== 'ok') return 'stuck';
      const walk = surfaceTo(at[0].p);
      at = undefined;
      if (walk && walk.length > 1) {
        const w = await walkAlong(ctx, [...walk].reverse(), 4);
        if (w === 'gone') return 'gone';
        if (w !== 'ok') return 'stuck';
      }
      return 'ok';
    }
    return 'ok';
  };
  /** From where it stands to the end of a way: back to where the two part, out along the other (each cell read ahead). */
  const goTo = async (way: WayCell[]): Promise<'ok' | 'back' | 'gone' | 'stuck' | 'closed'> => {
    let p = 0;
    while (at && p < at.length && p < way.length && same(at[p].p, way[p].p)) p++;
    if (!at || !p) {
      if (at) { const r = await toHutCell(); if (r !== 'ok') return r; }
      const walk = surfaceTo(way[0].p);
      if (!walk) return 'stuck';
      if (walk.length > 1) {
        const r = await walkAlong(ctx, walk, 4, watch);
        if (r === 'gone') { gone = true; return 'gone'; }
        if (r !== 'ok') return r === 'back' && (stop || gone) ? 'back' : 'stuck';
      }
      at = way.slice(0, 1);
      p = 1;
    } else if (p < at.length) {
      const back = at.slice(p - 1).reverse().map(c => c.p);
      const r = await walkAlong(ctx, back, 4, watch);
      if (r === 'gone') { gone = true; return 'gone'; }
      if (r !== 'ok') return r === 'back' && (stop || gone) ? 'back' : 'stuck';
      at = at.slice(0, p);
    }
    return walkDown(way, p - 1, way.length - 1);
  };

  // ---- the digging
  let steps = 0, dug = 0, got = 0, refused = 0;
  let drunk = false;
  const startDebris = debrisOf(await inventory(ctx));
  const book = (items: InventoryItem[]) => {
    const more = debrisOf(items) - startDebris - got;
    if (more > 0) { got += more; ctx.gain(more); }
  };
  const placedOf = (grid: Grid) => {
    const plugs = new Set((mem.plugs ?? []).map(cellKey));
    return placedIn(grid).filter(p => !plugs.has(cellKey(p)) && boxGap(pb, cellBox(p)) > HUT_GAP + 2);
  };
  const viewOf = (grid: Grid, mouth?: Pos): TunnelView => ({
    portal: pb, zones, placed: placedOf(grid), own: tunnelOpen(mem.list), holes: new Set((mem.dug ?? []).map(cellKey)), ...(mouth ? { mouth } : {})
  });
  const effectLow = (back: number) => (fire > 0 ? `the fire resistance running low (${Math.round(fire)} s left, the way back ${Math.round(back)} s)` : 'no fire resistance on it');
  /** The potion drunk at the tunnel's face: false (`stop` says why) where it did not take, or none is carried. */
  const drink = async (): Promise<boolean> => {
    const potion = potionToDrink(await inventory(ctx));
    if (!potion) { stop = 'no potion of fire resistance carried'; return false; }
    // (the ghast rule b, as the look before it: only one within 16 that sees it; one further off is watched, not fled)
    const ghast = ents.find(e => e.name === 'ghast' && e.distance <= NEAR.ghast && ghastSees(g, e.position, me));
    if (ghast) { stop = `a ghast in sight (${Math.round(ghast.distance)} off): no potion drunk for a trip it may cut short`; return false; }
    const held = await ctx.call('item.select', { name: potion.name, slot: potion.slot }).then(() => true, () => false);
    if (ctx.signal.aborted) throw new Error('aborted');
    const r = held ? await ctx.call<{ finished?: boolean }>('use', {}, 15_000).catch(() => ({ finished: false })) : undefined;
    if (ctx.signal.aborted) throw new Error('aborted');
    fire = fireOf(await ctx.status().catch(() => undefined));
    if (fire <= 0) { stop = `the potion of fire resistance did not take${!held ? ' (not taken in hand)' : r?.finished === false ? ' (not drunk)' : ''}`; return false; }
    drunk = true;
    ctx.progress(`tunnel: drank a potion of ${potion.potion} at the tunnel's face at nether ${fmt(floorOf(me))}: ${minSec(fire)} of fire resistance`);
    return true;
  };
  /**
   * One block dug from where it stands, the effect looked at first (`isDebris`: the debris pickaxe in hand): undefined,
   * or why not (`stop` set where the trip ends). A step's own cell dug goes into `opened` before anything else (a run
   * cut short right after the dig: digOn keeps them as its own, no cave, for the trip that goes on there).
   */
  const digOne = async (c: Pos, isDebris: boolean, need: number, opened?: Pos[]): Promise<string | undefined> => {
    if (!(await fireNow())) return 'gone';
    if (fire < Math.max(EFFECT_LEAST_S, need)) { stop = effectLow(need - EFFECT_LEAST_S); unlearnt = true; return stop; }
    if (isDebris) {
      const pick = debrisPick(await inventory(ctx));
      if (!pick) { stop = 'no diamond or netherite pickaxe left'; return stop; }
      const held = await ctx.call('item.select', { name: pick.name, slot: pick.slot }).then(() => true, () => false);
      if (ctx.signal.aborted) throw new Error('aborted');
      if (!held) { stop = `could not take the ${pick.name} in hand`; return stop; }
    }
    const r = await ctx.call<{ dug?: boolean; reason?: string }>('dig.here', { ...c, timeoutMs: isDebris ? 20_000 : 10_000 }, isDebris ? 30_000 : 20_000)
      .catch((e: Error) => ({ dug: false, reason: e.message }));
    const open = !!r?.dug || r?.reason === 'air';
    if (open) {
      setOpen(g, c);
      if (isDebris) { dug += 1; mem.dug = [...(mem.dug ?? []), { ...c }].slice(-PLUGS_KEPT); } else opened?.push({ ...c });
    }
    if (ctx.signal.aborted) throw new Error('aborted');
    if (!open) return `could not dig the ${blockAt(g, c) ?? 'block'} at nether ${fmt(c)}: ${(r?.reason ?? 'no answer').slice(0, 100)}`;
    return undefined;
  };
  /** What a debris dig dropped: a moment for it to come down (it is picked up where it falls, the tunnel's cell beside it), booked. */
  const settle = async (): Promise<boolean> => {
    for (let i = 0; i < TUNNEL_WAITS.dropLooks; i++) {
      await pause(TUNNEL_WAITS.pollMs);
      if (!(await watch())) return false;
    }
    book(await inventory(ctx));
    return true;
  };
  const shut = (i: number, why: string) => {
    const t = mem.list[i];
    t.shut = why.slice(0, 200);
    ctx.progress(`tunnel: tunnel ${i + 1} (${t.from === undefined ? 'a trunk' : `a branch of tunnel ${t.from + 1}`}) shut at nether ${fmt(tunnelCells(t).at(-1)!)}: ${why}`);
  };
  /**
   * A dig or a step at the end `f` of tunnel `i` that did not go, and no verdict on the rock (a dig's timeout, out of
   * reach or sight, no answer; a step a mob or a Baritone hiccup stopped): the trip ends there and the tunnel stays
   * open for the next; the second time at that same end, it shuts (a real blockage does not come back every trip). A
   * shut is for good, and four trunks shut on their stair end the tunnelling until someone edits the memory by hand.
   */
  const failedAt = (i: number, f: Pos, why: string): 'shut' | 'end' => {
    const t = mem.list[i];
    if (t.failed && same(t.failed, f)) { delete t.failed; shut(i, `${why} (the second time there)`); return 'shut'; }
    t.failed = { ...f };
    stop = `${why}; tunnel ${i + 1} is gone on with next trip`;
    unlearnt = true;
    return 'end';
  };

  /** Dig on at the end of tunnel `i`, where it stands, till the tunnel shuts (`shut`) or the trip ends (`stop`, `gone`). */
  const digOn = async (i: number): Promise<'shut' | 'end'> => {
    const t = mem.list[i];
    for (;;) {
      const cells = tunnelCells(t);
      const f = cells[cells.length - 1];
      const way = wayTo(mem.list, i)!;
      const back = backS(way);
      if (dug >= TUNNEL_TRIP) { stop = `the trip's ${TUNNEL_TRIP} ancient debris mined`; return 'end'; }
      if (left() < back * 1000 + BACK_MS) { stop = 'the tunnel trip\'s time is up'; unlearnt = true; return 'end'; }
      if (!(await watch())) return 'end';
      const items = await inventory(ctx);
      book(items);
      if (freeSlots(items) < 2) { stop = `pockets full (${36 - freeSlots(items)}/36 slots)`; return 'end'; }
      if (!debrisPick(items)) { stop = 'no diamond or netherite pickaxe left'; return 'end'; }
      const level = [...t.way].filter(c => c === c.toLowerCase()).length;
      const long = t.from === undefined ? TRUNK_LEVEL : BRANCH_LONG;
      if (level >= long) { shut(i, `its ${long} blocks dug`); return 'shut'; }
      if (t.way.length >= TUNNEL_STEPS) { shut(i, `its ${TUNNEL_STEPS} steps dug`); return 'shut'; }
      // the effect: drunk at the face before the first dig, and the digging ended while it lasts out the way back
      const need = EFFECT_LEAST_S + back;
      if (!drunk && fire < need + DIG_LEAST_S && !(await drink())) { unlearnt = true; return 'end'; }
      if (fire < need) { stop = effectLow(back); unlearnt = true; return 'end'; }
      // the next step, judged on a fresh read of the ground round it: straight on (a trunk turns where that will not do)
      const down = goesDown(f);
      const mouth = t.from === undefined ? t.start : undefined;
      let chosen: Heading | undefined;
      let first: string | undefined;
      for (const h of nextHeadings(t, f)) {
        g = await readGround(ctx, stepBox(f, h, down));
        if (ctx.signal.aborted) throw new Error('aborted');
        const why = stepFault(g, f, h, down, viewOf(g, mouth));
        if (!why) { chosen = h; break; }
        first ??= why;
      }
      if (!chosen) { shut(i, first ?? 'nothing ahead it may dig'); return 'shut'; }
      const { dig, to } = stepOf(f, chosen, down);
      /** a debris in the way itself, dug as the step's: it drops into the cell the step ends on */
      let inWay = false;
      /** the step's cells dug: kept as its own (mem.dug, no cave to the trip that goes on there) wherever the step is not, a run cut short included */
      const opened: Pos[] = [];
      let stepped = false;
      try {
        for (const c of dig) {
          if (passable(blockAt(g, c))) continue;
          const debris = blockAt(g, c) === DEBRIS;
          const no = await digOne(c, debris, need, debris ? undefined : opened);
          if (no) {
            if (stop || gone) return 'end';
            // (someone's build, a lit portal's frame: the bridge's verdict on the block, for good; anything else is no
            // verdict on the rock, and the next trip tries again)
            if (/someone else's build|portal's frame/.test(no)) { shut(i, no); return 'shut'; }
            return failedAt(i, f, no);
          }
          inWay ||= debris;
        }
        // read again: lava that shows by the tunnel is plugged, and the branch ends there; lava come within 2 of it ends it too
        g = await readGround(ctx, stepBox(f, chosen, down));
        if (ctx.signal.aborted) throw new Error('aborted');
        // (by the open cells round where it stands: the step's, its head's, the steps before; what it reaches to plug)
        const open = new Set([...tunnelOpen(mem.list), ...dig.map(cellKey)]);
        const lava: Pos[] = [];
        for (const k of open) {
          const [x, y, z] = k.split(',').map(Number);
          if (Math.max(Math.abs(x - f.x), Math.abs(y - f.y - 1), Math.abs(z - f.z)) > 2) continue;
          for (const [dx, dy, dz] of FACES) {
            const q = { x: x + dx, y: y + dy, z: z + dz };
            if (cellOf(blockAt(g, q)) === 'hot' && !lava.some(l => same(l, q))) lava.push(q);
          }
        }
        if (lava.length) {
          const plugged: Pos[] = [];
          for (const q of lava) {
            const item = plugOf(await inventory(ctx));
            if (!item) break;
            const r = await ctx.act('place-block', { ...q, item }).catch((e: Error) => ({ text: e.message }));
            if (ctx.signal.aborted) throw new Error('aborted');
            if (/^Placed /.test(r.text)) { plugged.push(q); mem.plugs = [...(mem.plugs ?? []), { ...q }].slice(-PLUGS_KEPT); }
          }
          ctx.progress(`tunnel: lava showed by the tunnel at nether ${fmt(lava[0])}: ${plugged.length === lava.length ? 'plugged with cobblestone' : `${plugged.length} of ${lava.length} plugged`}`);
          if (plugged.length < lava.length) { stop = `lava by the tunnel at nether ${fmt(lava[0])} it could not plug`; shut(i, `lava showed at nether ${fmt(lava[0])}`); return 'end'; }
          shut(i, `lava showed at nether ${fmt(lava[0])}: plugged`);
          return 'shut';
        }
        const hot = lavaAhead(g, dig, to);
        if (hot) { shut(i, hot); return 'shut'; }
        // the step
        const w = await walkAlong(ctx, [f, to], 1);
        if (w === 'gone') { gone = true; return 'end'; }
        if (w !== 'ok') return failedAt(i, f, `could not step to nether ${fmt(to)}`);
        delete t.failed;
        t.way += down ? chosen.toUpperCase() : chosen;
        stepped = true;
      } finally {
        // (a step left half dug: the trip ended on it, it failed, lava shut it, or the run was cut short mid-step)
        if (!stepped && opened.length) mem.dug = [...(mem.dug ?? []), ...opened].slice(-PLUGS_KEPT);
      }
      steps += 1;
      me = { x: to.x + 0.5, y: to.y, z: to.z + 0.5 };
      at = wayTo(mem.list, i);
      // ---- the debris the step bared, from where it stands now
      const floors = new Set([...mem.list.flatMap(x => tunnelCells(x)), to].map(c => cellKey(add(c, 0, -1, 0))));
      if (inWay && !(await settle())) return 'end';
      const { ores } = baredDebris(g, dig, floors, viewOf(g));
      for (const ore of ores) {
        if (dug >= TUNNEL_TRIP) break;
        const no = await digOne(ore, true, need);
        if (stop || gone) return 'end';
        if (no) { if (!refused) ctx.progress(`tunnel: could not dig the ancient debris at nether ${fmt(ore)}: ${no}`); refused += 1; continue; }
        if (!(await settle())) return 'end';
      }
    }
  };

  // ---- the trip: an end to dig on (planned again as one shuts, PLANS at most), a new trunk where none is left
  const potion = potionToDrink(await inventory(ctx));
  potionS = potion ? potionSeconds(potion) : 0;
  let planned = 0;
  if (await watch()) {
    while (!stop && !gone && planned < PLANS) {
      planned += 1;
      const plan = tunnelPlan(mem.list, fits);
      if (!plan) { stop = mem.list.length ? 'nothing more of its tunnels it may dig within the effect and the time' : 'no tunnel it may dig'; break; }
      let i: number;
      if (plan.do === 'on') i = plan.i;
      else if (plan.do === 'branch') {
        mem.list.push({ start: { ...plan.way[plan.way.length - 1].p }, head: plan.head, way: '', from: plan.from });
        i = mem.list.length - 1;
        ctx.progress(`tunnel: a branch ${HEADING_WORD[plan.head]} off tunnel ${plan.from + 1} at nether ${fmt(plan.way[plan.way.length - 1].p)}`);
      } else {
        if (at) { const r = await toHutCell(); if (r === 'gone') { gone = true; break; } if (r !== 'ok') { stop = 'stuck on the way back up its tunnel'; break; } }
        const m = chooseMouth(ground, start, surfaceMay, mem.list, viewOf(ground));
        if ('why' in m) { stop = m.why; break; }
        mem.list.push({ start: { ...m.mouth }, head: m.head, way: '' });
        i = mem.list.length - 1;
        surface.set(cellKey(m.mouth), m.walk);
        ctx.progress(`tunnel: a new trunk from nether ${fmt(m.mouth)}, heading ${HEADING_WORD[m.head]} and down`);
      }
      const way = wayTo(mem.list, i);
      if (!way) { stop = 'its tunnels do not hold together'; break; }
      const r = await goTo(way);
      if (r === 'gone') { gone = true; break; }
      if (r === 'back' || stop) break;
      if (r === 'stuck') { stop = `stuck on the way to the end of tunnel ${i + 1}`; break; }
      if (r === 'closed') continue;
      if ((await digOn(i)) === 'end') break;
    }
    if (!stop && !gone) stop = 'as much of its tunnels as one trip digs';
  }

  // ---- done: said, back along its tunnel and over the ground into its hut, and through its own portal
  if (!gone) book(await inventory(ctx));
  const did = steps || dug
    ? `tunnelled ${steps} block${steps === 1 ? '' : 's'}: ${dug ? `${dug} ancient debris mined, ${got} picked up` : 'no ancient debris'}${refused ? ` (${refused} it could not dig)` : ''}`
    : 'nothing tunnelled';
  if (steps || dug) ctx.progress(`nether: tunnelled ${steps} block${steps === 1 ? '' : 's'}: ${dug} ancient debris mined, ${got} picked up`);
  const work = steps || dug ? { worked: true as const } : {};
  if (gone || !(await inNether(ctx))) return { gain: got, text: steps || dug ? `${did}; ${GONE.text}` : GONE.text, ...work };
  if (angry) {
    (netherOf(world).barter ??= {}).held = { day: gameDay(world), at: now(), why: angry.slice(0, 160) };
    ctx.progress(`nether: ${angry}: back to its portal, the barter, the quartz, the scouting, the debris and the tunnelling held for the day`);
  }
  const said = `${stop ?? 'done'}${angry ? ', the barter, the quartz, the scouting, the debris and the tunnelling held for the day' : ''}`;
  // (a trip that dug on and found none, or turned back before it learnt anything, says nothing of the rock there: the
  // wrapper's dry mark must not grow as for a place found empty)
  const mark = { ...(!got && (steps || unlearnt) ? { mark: 'same' as const } : {}), ...work };
  const w = await toHutCell();
  if (w === 'gone') return { gain: got, text: `${did}; ${GONE.text}`, ...work };
  if (w !== 'ok') return { gain: got, text: `${did}; ${said}; stuck on the way back up its tunnel`, ...mark };
  const b = await backThroughOwn(ctx, arrived, homeShape, now);
  return { gain: got, text: `${did}; ${said}; ${b.text}`, ...mark, ...(b.cameBack ? { cameBack: true as const } : {}) };
}

/** Lava or fire within LAVA_GAP of a cell of its tunnel it walks, from three under its floor to its head (the walks' rule), or the ground there not read. */
function lavaNear(g: Grid, p: Pos): boolean {
  for (let dy = -LAVA_GAP - 1; dy <= 1; dy++) for (let dx = -LAVA_GAP; dx <= LAVA_GAP; dx++) for (let dz = -LAVA_GAP; dz <= LAVA_GAP; dz++) {
    const c = cellOf(blockAt(g, add(p, dx, dy, dz)));
    if (c === 'hot' || c === 'unknown') return true;
  }
  return false;
}
