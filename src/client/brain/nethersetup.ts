/**
 * The setup trip into the Nether (P2b of the progression plan, run supervised): the bot's own Nether-side portal. The
 * home portal, lit, comes out at the community's Nether-side portal (some 15 from home's scaled point), most likely
 * in their room. So the bot builds a portal of its own nearer home's scaled point, which the home portal then leads
 * to, which leads back to the home portal, and which takes no one's link (nether.ts netherPortalSpot, spotFault).
 *
 * The nether rung's `setup` work (worktasks.ts), wanted while the switch is on, the home portal is lit and the two
 * sides are not linked yet:
 * 1. the Nether kit fetched at home (mine.ts NETHER_TRIP, and the frame's obsidian: 10, or what a trip cut short left
 *    to place), whole and fed, with time enough left of the day;
 * 2. through the home portal, and a look at where it came out: whose portal, in whose build;
 * 3. at someone's portal nothing is dug, placed or taken in or near their build: out on foot along open cells within
 *    their build's box and 8 more, or back through their portal at once, the setup held a day;
 * 4. its own portal at netherPortalSpot's spot, adapted to the ground there (within 8 of it, at any height within 12 of
 *    the arrival), every candidate checked with spotFault, 16 from anyone's Nether build, 24 from a portal of others
 *    whose overworld side is not known, never over lava or a drop: a 4 x 5 obsidian frame in a hut, dug into the
 *    netherrack where the ground allows (the bot's own hand digs, from the hut's door inward: Baritone may break no
 *    netherrack within 24 of someone's build there, as every kind in a Nether build is theirs), cobblestone where it
 *    is open, lit with flint and steel through use-item-on-block (the bridge arms that use, F1's guard);
 * 5. back through it: out within 8 of the home portal, the two are linked; out elsewhere, the setup is held a day.
 * The walk home from the portal is the work wrapper's, and whatever goes wrong down there the leave nether goal's; a
 * death down there ends the run where it finds itself out of the Nether, with nothing more sent or written.
 *
 * Coordinates are `nether (x, y, z)` and `overworld (x, y, z)` in the lines, as nether.ts says them. Nothing here is
 * used at the module's top level (worktasks.ts reaches it, and this module reaches most of the brain).
 */
import type { InventoryItem } from '../tools.js';
import { foodsFor26 } from '../tools.js';
import { AVOID_UNLESS_ASKED } from '../../food.js';
import { no, type Decline, type GoalContext, type Snapshot } from './goals.js';
import type { Pos, WorldMemory } from './memory.js';
import type { Zone } from './courtesy.js';
import type { WorkResult } from './work.js';
import { clock } from './idlelog.js';
import { readBox } from './milestones.js';
import { freeChestTotals, peekChest, storedStacks, takeFromChests, takeSlot } from './chests.js';
import { COOKS_TO, readyFoodPoints } from './food.js';
import { holdHarmless } from './fluidpick.js';
import { look } from './pockets.js';
import { putAway, stashKeep } from './chores.js';
import { homePortal } from './portal.js';
import { NETHER_BLOCKS, NETHER_TRIP, netherTripKit } from './mine.js';
import {
  NETHER, OVERWORLD, REFUSED_SPOTS, SEARCH, isFirePotion, linkedTo, netherBudgetMs, netherCheck, netherOf, netherPortalSpot, notePortals, peekNether, portalCells,
  scaled, spotFault, type PortalShape, type SetupSpot
} from './nether.js';
import { wearNetherSet } from './netherset.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The frame of its own Nether-side portal: the portal milestone gathered 20, 10 of them for this. */
export const SETUP_OBSIDIAN = 10;
/** How long the setup waits after it came back with nothing it could do (someone's room, no spot, a wrong link). */
export const SETUP_HOLD_MS = DAY;
/** How far round netherPortalSpot's spot the hut may go, across, and up or down from where the bot came out. */
export const SPOT_RADIUS = 8;
export const SPOT_DY = 12;
/** How far the hut keeps from anyone's build in the Nether (their zone's box, its margin and all). */
export const FROM_BUILDS = 16;
/** How far it keeps from a portal of others whose overworld side is not known (a link it cannot judge). */
export const FROM_UNKNOWN = 24;
/** The walk out of someone's build stays within their box and this much more. */
export const WAY_OUT = 8;
/** The bridge's margin round a build's markers on the surface (Foreign.java MARGIN): a portal not scanned yet gets it too. */
const ZONE_MARGIN = 4;
/** Never over a drop deeper than this (Baritone's own fall) nor over lava. */
export const MAX_DROP = 3;
/** Back through its own portal, out this near the home portal: the two are linked. */
export const LINK_RANGE = 8;
/** Blast-proof blocks kept back from the hut for the way home (the Guardian's cover and pillars down there). */
export const BLOCKS_KEPT = 16;
/** Under this health the setup does not set out: the run eats to full and waits out the rest of the healing. */
export const SETUP_HEALTH = 16;
/** What a setup trip needs of the day down there: the way out of the room, the hut, back. */
export const SETUP_WORTH_MS = 4 * MINUTE;
/** What it still needs of that once the kit is fetched at home (the eating and the healing come out of it too). */
export const SETUP_LEAST_MS = 3 * MINUTE;
/** The waits in the run: the healing at home, chunks still loading down there (a test sets them to nothing). */
export const SETUP_WAITS = { pollMs: 2000, healMs: 60_000, loadMs: 1500, loadTries: 4 };

const fmt = (p: { x: number; y: number; z: number }) => `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`;
const pause = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const key = (p: Pos) => `${p.x},${p.y},${p.z}`;
const parse = (k: string): Pos => { const [x, y, z] = k.split(',').map(Number); return { x, y, z }; };
const add = (p: Pos, dx: number, dy: number, dz: number): Pos => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const same = (a: Pos, b: Pos) => a.x === b.x && a.y === b.y && a.z === b.z;

// ------------------------------------------------------------------------------------------------ the ground

/** A box of blocks as world.region reads it (x fastest, then z, then y), null where its chunk is not loaded. */
export interface Grid { x: number; y: number; z: number; width: number; height: number; length: number; blocks: (string | null)[] }

/** each grid's names without `minecraft:` and the state, made once (the choice of a spot asks millions of times) */
const named = new WeakMap<Grid, (string | null)[]>();

/** The block at a place (its name, no `minecraft:`, no state), null outside the box or where it is not loaded. */
export function blockAt(g: Grid, p: Pos): string | null {
  const ix = p.x - g.x, iy = p.y - g.y, iz = p.z - g.z;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= g.width || iy >= g.height || iz >= g.length) return null;
  let names = named.get(g);
  if (!names) named.set(g, names = g.blocks.map(b => (b === null || b === undefined ? null : b.replace(/^minecraft:/, '').replace(/\[.*$/, ''))));
  return names[ix + iz * g.width + iy * g.width * g.length] ?? null;
}

/**
 * The ground as a dig of the bot's own left it: the block at a place read as air from now on (the quartz trip's map
 * of what it dug, netherquartz.ts: its walks and its sight go by the ground as it is, not as the one read had it).
 */
export function setOpen(g: Grid, p: Pos): void {
  const ix = p.x - g.x, iy = p.y - g.y, iz = p.z - g.z;
  if (ix < 0 || iy < 0 || iz < 0 || ix >= g.width || iy >= g.height || iz >= g.length) return;
  const i = ix + iz * g.width + iy * g.width * g.length;
  g.blocks[i] = 'minecraft:air';
  const names = named.get(g);
  if (names) names[i] = 'air';
}

/**
 * What a cell is to the setup: open air; a small plant (passable, gone at a touch: roots, sprouts, fungi, vines); the
 * Nether's own ground the bot may dig (netherrack and the like); anything else solid (kept, never dug: bedrock,
 * debris, obsidian, what someone built; cobblestone, which the Nether never makes, so any there was placed by
 * someone, and the bridge's scan makes no zone of plain cobblestone; gold ore and gilded blackstone, which piglins
 * guard: one dug angers every piglin within 16, golden helmet or not); lava or fire; a block that falls once what
 * holds it up is dug; a portal; or not known (unloaded).
 */
export type Cell = 'open' | 'plant' | 'dig' | 'solid' | 'hot' | 'falls' | 'portal' | 'unknown';
const OPEN = /^(air|cave_air|void_air)$/;
const PLANT = /^(crimson_roots|warped_roots|nether_sprouts|crimson_fungus|warped_fungus|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant|brown_mushroom|red_mushroom)$/;
const DIG = /^(netherrack|crimson_nylium|warped_nylium|soul_sand|soul_soil|basalt|smooth_basalt|blackstone|magma_block|nether_quartz_ore|glowstone|nether_wart_block|warped_wart_block|shroomlight)$/;
/** What only a player puts down in the Nether (cobblestone grows nowhere there): the hut keeps PLACED_GAP from it. */
const PLACED = /^(cobblestone|cobbled_deepslate)$/;
export const PLACED_GAP = 2;
const HOT = /^(lava|fire|soul_fire)$/;
const FALLS = /^(gravel|sand|red_sand|suspicious_gravel|suspicious_sand|.*_concrete_powder)$/;

export function cellOf(b: string | null): Cell {
  if (b === null) return 'unknown';
  if (OPEN.test(b)) return 'open';
  if (b === 'nether_portal') return 'portal';
  if (HOT.test(b)) return 'hot';
  if (PLANT.test(b)) return 'plant';
  if (FALLS.test(b)) return 'falls';
  if (DIG.test(b)) return 'dig';
  return 'solid';
}
/** Feet and head go through it. */
const passable = (c: Cell) => c === 'open' || c === 'plant';
/** Something to stand on, or to place against. */
const firm = (c: Cell) => c === 'dig' || c === 'solid' || c === 'falls';

/** A cell a player can stand in: a floor (not magma: it burns), feet and head clear, no lava or fire round the feet. */
export function standable(g: Grid, p: Pos): boolean {
  const floor = blockAt(g, add(p, 0, -1, 0));
  if (!firm(cellOf(floor)) || floor === 'magma_block') return false;
  if (!passable(cellOf(blockAt(g, p))) || !passable(cellOf(blockAt(g, add(p, 0, 1, 0))))) return false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
    if (cellOf(blockAt(g, add(p, dx, dy, dz))) === 'hot') return false;
  }
  return true;
}

const SIDES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** The cells one walking step from a standing cell: level, a block up (head room for the jump), or a drop of up to 3. */
function stepsFrom(g: Grid, p: Pos): Pos[] {
  const out: Pos[] = [];
  for (const [dx, dz] of SIDES) {
    const q = add(p, dx, 0, dz);
    if (standable(g, q)) { out.push(q); continue; }
    const up = add(q, 0, 1, 0);
    if (standable(g, up) && passable(cellOf(blockAt(g, add(p, 0, 2, 0))))) { out.push(up); continue; }
    // walked off the edge: the column clear down to where it lands
    if (!passable(cellOf(blockAt(g, q))) || !passable(cellOf(blockAt(g, add(q, 0, 1, 0))))) continue;
    for (let drop = 1; drop <= MAX_DROP; drop++) {
      const t = add(q, 0, -drop, 0);
      if (standable(g, t)) { out.push(t); break; }
      if (!passable(cellOf(blockAt(g, t)))) break;
    }
  }
  return out;
}

/** The cells a walk reaches from `starts` over the ground, never into a cell `may` refuses: how it got to each, and in how many steps. */
export function walkFrom(g: Grid, starts: Pos[], may: (p: Pos) => boolean, most = 40_000): Map<string, { from: string | null; n: number }> {
  const seen = new Map<string, { from: string | null; n: number }>();
  const queue: Pos[] = [];
  for (const s of starts) if (standable(g, s) && !seen.has(key(s))) { seen.set(key(s), { from: null, n: 0 }); queue.push(s); }
  for (let i = 0; i < queue.length && seen.size < most; i++) {
    const p = queue[i];
    const n = seen.get(key(p))!.n;
    for (const q of stepsFrom(g, p)) {
      if (seen.has(key(q)) || !may(q)) continue;
      seen.set(key(q), { from: key(p), n: n + 1 });
      queue.push(q);
    }
  }
  return seen;
}

/** The walk to a cell reached, from its start. */
export function pathOf(reach: Map<string, { from: string | null; n: number }>, to: Pos): Pos[] {
  const out: Pos[] = [];
  for (let k: string | null = key(to); k; k = reach.get(k)?.from ?? null) out.unshift(parse(k));
  return out;
}

/** The standing cell a place is in or by (the bot's feet as status gives them, a fraction over a slab or a step). */
export function footing(g: Grid, p: Pos): Pos | undefined {
  const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  for (const dy of [0, 1, -1]) if (standable(g, add(f, 0, dy, 0))) return add(f, 0, dy, 0);
  for (const [dx, dz] of SIDES) for (const dy of [0, 1, -1]) if (standable(g, add(f, dx, dy, dz))) return add(f, dx, dy, dz);
  return undefined;
}

// ------------------------------------------------------------------------------------------------ boxes

export interface Box { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }
export type NetherZone = Zone & { natural?: string };

export const inBox = (b: Box, p: Pos) => p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2 && p.z >= b.z1 && p.z <= b.z2;
export const grow = (b: Box, n: number): Box => ({ x1: b.x1 - n, y1: b.y1 - n, z1: b.z1 - n, x2: b.x2 + n, y2: b.y2 + n, z2: b.z2 + n });
/** Straight-line distance between two boxes (0 where they meet): the shared world's measure (a build 80 down is far off). */
export const boxGap = (a: Box, b: Box) => Math.hypot(Math.max(0, a.x1 - b.x2, b.x1 - a.x2), Math.max(0, a.y1 - b.y2, b.y1 - a.y2), Math.max(0, a.z1 - b.z2, b.z1 - a.z2));
export const boxOf = (cells: Pos[]): Box => ({
  x1: Math.min(...cells.map(c => c.x)), y1: Math.min(...cells.map(c => c.y)), z1: Math.min(...cells.map(c => c.z)),
  x2: Math.max(...cells.map(c => c.x)), y2: Math.max(...cells.map(c => c.y)), z2: Math.max(...cells.map(c => c.z))
});

// ------------------------------------------------------------------------------------------------ the hut

/**
 * Its own portal and the hut round it, in the hut's own terms: `i` along the portal (0 and 1 its inside's columns),
 * `d` out of its plane toward the front (0 the plane), `u` up from the inside's floor (0 the portal's bottom row).
 * - the portal's inside, 2 x 3, kept open; the frame round it, 10 obsidian (no corners: the 26.3 jar's PortalShape
 *   asks only for the bottom, the top and the two sides, of blocks in the nether_portal_frame tag, which is obsidian
 *   alone), and the four corners solid (what stands there, else cobblestone: the sides and the top are placed on them);
 * - the front room, 2 wide, 2 deep and 3 high like the inside (the far end of a portal's step out is 2 out of its
 *   plane: Portal.java stepOut), its roof level with the frame's top, which holds it up;
 * - the door, one wide and two high in the front wall, and the sill under it; the outside cell in front of it, where
 *   the walk there ends;
 * - the shell: every cell beside the inside and the room that is none of these, solid at the end (the netherrack it
 *   is dug into, else cobblestone): the back wall behind the portal, the room's walls, floor and roof;
 * - the floor under the frame's bottom row, which must be the ground itself.
 */
export interface Hut {
  spot: SetupSpot;
  inside: Pos[]; frame: Pos[]; corners: Pos[]; room: Pos[]; door: Pos[]; sill: Pos; shell: Pos[]; under: Pos[]; outside: Pos;
  /** the bottom frame cell the flint and steel lights it from (in front of the door's column) */
  light: Pos;
  /** where the bot stands as it builds (feet): outside, in the door, in the room's second row, in its first */
  stations: Pos[];
  /** the cells it builds or keeps (the outside cell apart) */
  box: Box;
}

/** A hut cell in the world. */
export function hutCell(h: SetupSpot, i: number, d: number, u: number): Pos {
  return h.axis === 'x' ? { x: h.x + i, y: h.y + u, z: h.z + h.side * d } : { x: h.x + h.side * d, y: h.y + u, z: h.z + i };
}

export function hutOf(spot: SetupSpot): Hut {
  const c = (i: number, d: number, u: number) => hutCell(spot, i, d, u);
  const o = spot.door;
  const inside: Pos[] = [], frame: Pos[] = [], room: Pos[] = [];
  for (const u of [0, 1, 2]) for (const i of [0, 1]) inside.push(c(i, 0, u));
  for (const i of [0, 1]) frame.push(c(i, 0, -1));
  for (const u of [0, 1, 2]) for (const i of [-1, 2]) frame.push(c(i, 0, u));
  for (const i of [0, 1]) frame.push(c(i, 0, 3));
  const corners = [c(-1, 0, -1), c(2, 0, -1), c(-1, 0, 3), c(2, 0, 3)];
  for (const d of [1, 2]) for (const u of [0, 1, 2]) for (const i of [0, 1]) room.push(c(i, d, u));
  const door = [c(o, 3, 0), c(o, 3, 1)];
  const sill = c(o, 3, -1);
  const inner = new Set([...inside, ...room].map(key));
  const taken = new Set([...inner, ...door.map(key), ...frame.map(key), ...corners.map(key)]);
  const shell: Pos[] = [];
  const seen = new Set<string>();
  for (const p of [...inside, ...room]) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const q = add(p, dx, dy, dz);
      if (taken.has(key(q)) || seen.has(key(q))) continue;
      seen.add(key(q));
      shell.push(q);
    }
  }
  const under = [-1, 0, 1, 2].map(i => c(i, 0, -2));
  const outside = c(o, 4, 0);
  const stations = [outside, c(o, 3, 0), c(o, 2, 0), c(o, 1, 0)];
  return { spot, inside, frame, corners, room, door, sill, shell, under, outside, light: c(o, 0, -1), stations, box: boxOf([...frame, ...corners, ...shell, ...under, sill, ...door]) };
}

/** Its portal as nether.ts's rules take it: the inside's lowest corner, the axis, 2 x 3. */
export const shapeOf = (s: SetupSpot): PortalShape => ({ x: s.x, y: s.y, z: s.z, axis: s.axis, width: 2, height: 3 });

/** The spot whose outside cell (where the walk ends) is `out`, built along `axis` with its front toward `side`, its door at column `door`. */
export function spotFor(out: Pos, axis: 'x' | 'z', side: 1 | -1, door: 0 | 1): SetupSpot {
  // outside = spot + door along + 4 * side across
  return axis === 'x' ? { x: out.x - door, y: out.y, z: out.z - 4 * side, axis, side, door } : { x: out.x - 4 * side, y: out.y, z: out.z - door, axis, side, door };
}

// ------------------------------------------------------------------------------------------------ judging a spot

/** What a spot asks of the ground, before the build is walked through: the faults that rule it out, else its cost. */
export interface Cost { places: number; obsidian: number; digs: number }

/**
 * All judgeHut reads of the ground: the hut and the ring round it where lava or fire rules it out (2 across and over
 * it, and under it the drop it could fall and one more). A read for a judgement covers this.
 */
export const judgedBox = (hut: Hut): Box => {
  const b = hut.box;
  return { x1: b.x1 - 2, y1: b.y1 - 1 - MAX_DROP, z1: b.z1 - 2, x2: b.x2 + 2, y2: b.y2 + 2, z2: b.z2 + 2 };
};

/** Why the ground at a hut will not do (lava by it, a drop, something in the way...), or what the hut costs there. */
export function judgeHut(g: Grid, hut: Hut, have: { cobblestone: number; obsidian: number }): Cost | { why: string } {
  const cell = (p: Pos) => cellOf(blockAt(g, p));
  const all = [...hut.inside, ...hut.frame, ...hut.corners, ...hut.room, ...hut.door, hut.sill, ...hut.shell, ...hut.under, hut.outside, add(hut.outside, 0, 1, 0), add(hut.outside, 0, -1, 0)];
  if (all.some(p => cell(p) === 'unknown')) return { why: 'not all loaded' };
  // no lava or fire by it, nor under it within the drop it could fall (lava flows into a dug chamber, fire spreads);
  // and every cell of that ring known: one not loaded, or not read, may hold either, and passed as clear it did once
  // (a re-plan on the spot, reading what the first judgement had not, found "lava or fire by it")
  const b = judgedBox(hut);
  let unread = false;
  for (let x = b.x1; x <= b.x2; x++) for (let z = b.z1; z <= b.z2; z++) for (let y = b.y1; y <= b.y2; y++) {
    const c = cell({ x, y, z });
    if (c === 'hot') return { why: 'lava or fire by it' };
    if (c === 'unknown') unread = true;
  }
  if (unread) return { why: 'not all loaded round it' };
  const box = hut.box;
  // nothing that falls once what holds it up is dug: in the hut, or on its roof
  for (let x = box.x1; x <= box.x2; x++) for (let z = box.z1; z <= box.z2; z++) for (let y = box.y1; y <= box.y2 + 1; y++) {
    if (cell({ x, y, z }) === 'falls') return { why: 'gravel or sand in it or on it' };
  }
  if (hut.under.some(p => !firm(cell(p)))) return { why: 'no ground under the frame' };
  if ([...hut.inside, ...hut.room, ...hut.door].some(p => cell(p) === 'solid' || cell(p) === 'portal')) return { why: 'something in the way that is not the bot\'s to dig' };
  if (hut.frame.some(p => (cell(p) === 'solid' && blockAt(g, p) !== 'obsidian') || cell(p) === 'portal')) return { why: 'something in the frame that is not the bot\'s to dig' };
  if ([...hut.corners, ...hut.shell, hut.sill].some(p => cell(p) === 'portal')) return { why: 'a portal in the way' };
  if (!standable(g, hut.outside)) return { why: 'no standing room outside the door' };
  // the floor the bot stands on as it builds: no magma; and where it is open, never over a drop
  const floors = [hut.sill, ...hut.room.filter(p => p.y === hut.spot.y).map(p => add(p, 0, -1, 0))];
  for (const f of floors) {
    if (blockAt(g, f) === 'magma_block') return { why: 'magma underfoot' };
    if (firm(cell(f))) continue;
    let held = false;
    for (let dy = 1; dy <= MAX_DROP; dy++) {
      const c = cell(add(f, 0, -dy, 0));
      if (firm(c)) { held = true; break; }
      if (!passable(c)) break;
    }
    if (!held) return { why: `over a drop of more than ${MAX_DROP}` };
  }
  const open = (p: Pos) => passable(cell(p));
  const walls = [...hut.corners, ...hut.shell, hut.sill];
  const places = walls.filter(open).length;
  const obsidian = hut.frame.filter(p => blockAt(g, p) !== 'obsidian').length;
  // dug: the netherrack (and plants) where the hut is open and where its frame goes; a plant where a wall goes
  const digs = [...hut.inside, ...hut.room, ...hut.door, ...hut.frame].filter(p => cell(p) === 'dig' || cell(p) === 'plant').length +
    walls.filter(p => cell(p) === 'plant').length;
  if (places > have.cobblestone - BLOCKS_KEPT) return { why: `${places} cobblestone to place (${have.cobblestone} carried, ${BLOCKS_KEPT} kept for the way home)` };
  if (obsidian > have.obsidian) return { why: `${obsidian} obsidian for the frame (${have.obsidian} carried)` };
  return { places, obsidian, digs };
}

// ------------------------------------------------------------------------------------------------ the build, step by step

/** One thing the build does: a careful step to a station, a dig from where it stands, or a block placed against a face. */
export type HutStep = { do: 'walk'; to: Pos } | { do: 'dig'; at: Pos } | { do: 'place'; at: Pos; item: string; face: string };

/** The faces the bridge's place tries a block's neighbours in (Interact.aimPlace), and which way each lies. */
const FACES: { name: string; dx: number; dy: number; dz: number }[] = [
  { name: 'down', dx: 0, dy: -1, dz: 0 }, { name: 'north', dx: 0, dy: 0, dz: -1 }, { name: 'south', dx: 0, dy: 0, dz: 1 },
  { name: 'east', dx: 1, dy: 0, dz: 0 }, { name: 'west', dx: -1, dy: 0, dz: 0 }, { name: 'up', dx: 0, dy: 1, dz: 0 }
];
/** How far the eye reaches: dig.here's own limit (the interaction range less 0.1), and place's. */
export const DIG_REACH = 4.4;
const PLACE_REACH = 4.5;
export const EYE = 1.62;

type V = { x: number; y: number; z: number };
const eyeOf = (feet: Pos): V => ({ x: feet.x + 0.5, y: feet.y + EYE, z: feet.z + 0.5 });
const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Whether a ray from the eye to a point in the target block meets nothing but open cells before it (a grid walk of
 * the voxels it crosses, as the bridge's clip does with block outlines: a plant in the way stops it too).
 */
export function clearTo(open: (p: Pos) => boolean, from: V, to: V, target: Pos): boolean {
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z);
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity, tdz = dz ? Math.abs(1 / dz) : Infinity;
  let tx = dx > 0 ? (x + 1 - from.x) / dx : dx < 0 ? (from.x - x) / -dx : Infinity;
  let ty = dy > 0 ? (y + 1 - from.y) / dy : dy < 0 ? (from.y - y) / -dy : Infinity;
  let tz = dz > 0 ? (z + 1 - from.z) / dz : dz < 0 ? (from.z - z) / -dz : Infinity;
  for (let n = 0; n < 64; n++) {
    if (x === target.x && y === target.y && z === target.z) return true;
    if (n > 0 && !open({ x, y, z })) return false;
    if (tx <= ty && tx <= tz) { if (tx > 1) return false; x += sx; tx += tdx; }
    else if (ty <= tz) { if (ty > 1) return false; y += sy; ty += tdy; }
    else { if (tz > 1) return false; z += sz; tz += tdz; }
  }
  return false;
}

/**
 * The build walked through on a copy of the ground, pure: the ordered steps that make the hut from what stands, or
 * why it cannot be done from its stations. From outside the door it digs the door (and puts down the sill where it is
 * open), steps in, digs the room's second row, steps on, the first, then the portal's inside and whatever of the frame
 * is netherrack; then from the first row the frame, the corners it lacks, and the shell from the bottom up. Each dig
 * of a face the eye sees within reach (dig.here's rules); each block placed against a neighbour already solid, the
 * face the bridge's place tries first (its own order), within reach. What the bot stands in is never placed.
 */
export function hutSteps(g: Grid, hut: Hut): { steps: HutStep[] } | { why: string } {
  const over = new Map<string, Cell>();
  const cell = (p: Pos): Cell => over.get(key(p)) ?? cellOf(blockAt(g, p));
  const open = (p: Pos) => cell(p) === 'open';
  const steps: HutStep[] = [];
  const kept = new Set([...hut.corners, ...hut.shell, hut.sill].map(key));
  const isFrame = new Set(hut.frame.map(key));
  // dug: the room, the door, the inside, the frame's netherrack; and any plant where a block goes
  const digs = [...hut.door, ...hut.room, ...hut.inside, ...hut.frame, ...hut.corners, ...hut.shell, hut.sill].filter(p => {
    const c = cell(p);
    if (c === 'plant') return true;
    return c === 'dig' && !kept.has(key(p));
  });
  const pending = new Map(digs.map(p => [key(p), p]));
  const canDig = (feet: Pos, p: Pos): boolean => {
    const eye = eyeOf(feet);
    for (const f of FACES) {
      const n = add(p, f.dx, f.dy, f.dz);
      if (!open(n)) continue;
      const fc = { x: p.x + 0.5 + 0.49 * f.dx, y: p.y + 0.5 + 0.49 * f.dy, z: p.z + 0.5 + 0.49 * f.dz };
      if (dist(eye, fc) > DIG_REACH) continue;
      if (clearTo(open, eye, fc, p)) return true;
    }
    return false;
  };
  // the neighbour it is placed against (the face is sent as the one to try first): solid, its face within reach (the
  // bridge clicks a side face 0.25 below its middle)
  const faceFor = (feet: Pos, p: Pos): string | undefined => {
    const eye = eyeOf(feet);
    for (const f of FACES) {
      if (!firm(cell(add(p, f.dx, f.dy, f.dz)))) continue;
      const hit = { x: p.x + 0.5 + 0.5 * f.dx, y: p.y + 0.5 + 0.5 * f.dy - (f.dy === 0 ? 0.25 : 0), z: p.z + 0.5 + 0.5 * f.dz };
      if (dist(eye, hit) <= PLACE_REACH) return f.name;
    }
    return undefined;
  };
  const place = (feet: Pos, p: Pos, item: string): boolean => {
    if (same(p, feet) || same(p, add(feet, 0, 1, 0))) return false;
    const face = faceFor(feet, p);
    if (!face) return false;
    steps.push({ do: 'place', at: p, item, face });
    over.set(key(p), 'solid');
    return true;
  };
  // from each station only the row it opens (well within reach: a dig at the edge of it fails as often as not): from
  // outside the door, from the door the room's second row, from there its first; from the first row all the rest
  const rows = [new Set(hut.door.map(key)), new Set(hut.room.filter((_, i) => i >= 6).map(key)), new Set(hut.room.filter((_, i) => i < 6).map(key))];
  const digFrom = (feet: Pos, only?: Set<string>) => {
    for (let more = true; more;) {
      more = false;
      for (const [k, p] of pending) {
        if ((only && !only.has(k)) || !canDig(feet, p)) continue;
        steps.push({ do: 'dig', at: p });
        over.set(k, 'open');
        pending.delete(k);
        more = true;
      }
    }
  };
  const [outside, ...inward] = hut.stations;
  let at = outside;
  for (const [n, next] of inward.entries()) {
    digFrom(at, rows[n]);
    // the next station: its feet and head dug, and something under it to stand on
    if (!open(next) || !open(add(next, 0, 1, 0))) return { why: `cannot dig the way in at ${fmt(next)} from ${fmt(at)}` };
    const floor = add(next, 0, -1, 0);
    // (a plant there first: a fungus or a vine takes no block placed into it, as roots do)
    if (cell(floor) === 'plant') {
      if (!canDig(at, floor)) return { why: `cannot clear the floor at ${fmt(floor)} from ${fmt(at)}` };
      steps.push({ do: 'dig', at: floor });
      over.set(key(floor), 'open');
      pending.delete(key(floor));
    }
    if (!firm(cell(floor)) && !place(at, floor, 'cobblestone')) return { why: `cannot put the floor down at ${fmt(floor)} from ${fmt(at)}` };
    steps.push({ do: 'walk', to: next });
    at = next;
  }
  digFrom(at);
  if (pending.size) return { why: `cannot see ${[...pending.values()].slice(0, 2).map(fmt).join(', ')} to dig it from ${fmt(at)}` };
  // the frame from the bottom up on its corners, then the corners on top and the top: then the shell, bottom first
  const c = (i: number, u: number) => hutCell(hut.spot, i, 0, u);
  const todo: { p: Pos; item: string }[] = [];
  const need = (p: Pos, item: string) => { if (passable(cell(p)) && !todo.some(t => same(t.p, p))) todo.push({ p, item }); };
  need(c(-1, -1), 'cobblestone'); need(c(2, -1), 'cobblestone');
  need(c(0, -1), 'obsidian'); need(c(1, -1), 'obsidian');
  for (const u of [0, 1, 2]) { need(c(-1, u), 'obsidian'); need(c(2, u), 'obsidian'); }
  need(c(-1, 3), 'cobblestone'); need(c(2, 3), 'cobblestone');
  need(c(0, 3), 'obsidian'); need(c(1, 3), 'obsidian');
  const eye = eyeOf(at);
  const shell = [...hut.shell, hut.sill].filter(p => passable(cell(p)))
    .sort((a, b) => a.y - b.y || dist(eye, { x: a.x + 0.5, y: a.y + 0.5, z: a.z + 0.5 }) - dist(eye, { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 }));
  for (const p of shell) need(p, 'cobblestone');
  while (todo.length) {
    const i = todo.findIndex(t => !!faceFor(at, t.p) && !same(t.p, at) && !same(t.p, add(at, 0, 1, 0)));
    if (i < 0) return { why: `nothing to place ${todo[0].item} at ${fmt(todo[0].p)} against from ${fmt(at)}` };
    // the frame goes in its order: none of it later than a block of the shell
    const firstFrame = todo.findIndex(t => isFrame.has(key(t.p)) || hut.corners.some(q => same(q, t.p)));
    if (firstFrame >= 0 && i > firstFrame) return { why: `nothing to place the frame's ${todo[firstFrame].item} at ${fmt(todo[firstFrame].p)} against` };
    place(at, todo[i].p, todo[i].item);
    todo.splice(i, 1);
  }
  return { steps };
}

/** A hut's steps and cost: the plan the run carries out. */
export interface HutPlan { hut: Hut; steps: HutStep[]; cost: Cost }

/** The whole plan for a spot, or why it will not do: the ground judged, then the build walked through. */
export function planHut(g: Grid, spot: SetupSpot, have: { cobblestone: number; obsidian: number }): HutPlan | { why: string } {
  const hut = hutOf(spot);
  const cost = judgeHut(g, hut, have);
  if ('why' in cost) return cost;
  const s = hutSteps(g, hut);
  if ('why' in s) return s;
  return { hut, steps: s.steps, cost };
}

// ------------------------------------------------------------------------------------------------ choosing the spot

export const bottomOf = (p: PortalShape) => portalCells(p).filter(c => c.y === p.y);

/**
 * A Nether portal of others whose overworld side is known: an overworld portal seen (not the home one) leads into it,
 * by the server's own rule (nether.ts linkedTo, 16 round the scaled point) among the Nether portals known.
 */
export function overworldSideKnown(p: PortalShape, overworldPortals: PortalShape[], netherPortals: PortalShape[]): boolean {
  return overworldPortals.some(f => bottomOf(f).some(c => linkedTo(scaled(c, NETHER), netherPortals, SEARCH[NETHER])?.portal === p));
}

/** What the choice of a spot reads: the ground, the portals and builds known down there and at home, where to search, what it carries. */
export interface SetupView {
  grid: Grid;
  /** the home portal (portal.list's shape) */
  home: PortalShape;
  /** others' lit portals known in the Nether (the one it came out of among them when it is someone's) and in the overworld */
  netherPortals: PortalShape[];
  overworldPortals: PortalShape[];
  /**
   * the Nether's foreign zones as the bridge has them: the hut keeps FROM_BUILDS from every one (a natural fortress
   * or bastion too: blazes and piglins), and the walks keep out of all but those natural ones
   */
  zones: NetherZone[];
  /** netherPortalSpot's spot: the search goes round it */
  base: Pos;
  /** where the bot came out (the search's heights go round it) */
  arrival: Pos;
  /** the cells the walk to the hut starts from: where it stands, or the end of its way out of someone's build */
  from: Pos[];
  cobblestone: number;
  obsidian: number;
  /** where the cobblestone is the bot's own: its old hut round a portal of its own that went out (built again there) */
  mine?: Box[];
  /** spots a look again on the spot found would not do (world.nether.refusedSpots): never chosen again */
  refused?: SetupSpot[];
}

export interface SetupChoice { plan: HutPlan; path: Pos[]; why: string }

export const zoneBox = (z: NetherZone): Box => ({ x1: z.x1, y1: z.y1, z1: z.z1, x2: z.x2, y2: z.y2, z2: z.z2 });

/** The cells of a grid that hold what only a player puts down in the Nether (PLACED: cobblestone), once over the box. */
export function placedIn(g: Grid): Pos[] {
  const out: Pos[] = [];
  for (let iy = 0; iy < g.height; iy++) for (let iz = 0; iz < g.length; iz++) for (let ix = 0; ix < g.width; ix++) {
    const p = { x: g.x + ix, y: g.y + iy, z: g.z + iz };
    const b = blockAt(g, p);
    if (b && PLACED.test(b)) out.push(p);
  }
  return out;
}

/**
 * Where its own portal goes, pure: of the spots within SPOT_RADIUS of netherPortalSpot's (across) and SPOT_DY of the
 * arrival (up and down), both ways round, either side, the door in either column, those that keep FROM_BUILDS from
 * every Nether zone and FROM_UNKNOWN from a portal of others whose overworld side is not known, PLACED_GAP from any
 * cobblestone (someone's: a plain cobblestone path or wall makes no zone to the bridge's scan, and the hut was dug
 * into one), that spotFault passes (the home portal leads to it, it takes no one's link, it leads back home), whose
 * outside cell a walk reaches on foot from `from` without going into anyone's build, and whose ground and build pass
 * (judgeHut, hutSteps). The one with the fewest blocks to place first (dug into the netherrack: then a ledge; then
 * open ground), then the nearest netherPortalSpot's spot, the nearest the arrival's height, the shortest walk.
 * `prefer`: a spot chosen before (a trip cut short: its cobblestone is the bot's own), taken first while it still
 * does. Never a spot refused before (`refused`). None: why, by how many spots fell to each reason.
 */
export function chooseHut(v: SetupView, prefer?: SetupSpot): SetupChoice | { why: string } {
  const zones = v.zones.map(zoneBox);
  const built = v.zones.filter(z => !z.natural).map(zoneBox);
  const reach = walkFrom(v.grid, v.from, p => !built.some(z => inBox(z, p)));
  const unknown = v.netherPortals.filter(p => !overworldSideKnown(p, v.overworldPortals, v.netherPortals));
  const placed = placedIn(v.grid).filter(c => !(v.mine ?? []).some(b => inBox(b, c)));
  const faults = new Map<string, number>();
  const fell = (why: string) => { faults.set(why, (faults.get(why) ?? 0) + 1); };
  const linkFault = new Map<string, string | null>();
  const have = { cobblestone: v.cobblestone, obsidian: v.obsidian };
  const refused = (spot: SetupSpot) => (v.refused ?? []).some(r => r.x === spot.x && r.y === spot.y && r.z === spot.z && r.axis === spot.axis && r.side === spot.side && r.door === spot.door);
  const rule = (spot: SetupSpot, chosenBefore = false): string | null => {
    if (refused(spot)) return 'refused on an earlier trip';
    const hut = hutOf(spot);
    if (zones.some(z => boxGap(hut.box, z) < FROM_BUILDS)) return `within ${FROM_BUILDS} of someone's build`;
    if (!chosenBefore && placed.length) {
      const by = grow(hut.box, PLACED_GAP);
      if (placed.some(c => inBox(by, c))) return `within ${PLACED_GAP} of cobblestone someone placed`;
    }
    const sq = (c: Pos, b: Box) => Math.max(Math.max(0, b.x1 - c.x, c.x - b.x2), Math.max(0, b.z1 - c.z, c.z - b.z2));
    if (unknown.some(p => portalCells(p).some(c => sq(c, hut.box) < FROM_UNKNOWN))) return `within ${FROM_UNKNOWN} of a portal whose overworld side is not known`;
    const lk = `${spot.x},${spot.y},${spot.z},${spot.axis}`;
    if (!linkFault.has(lk)) linkFault.set(lk, spotFault(shapeOf(spot), v.home, v.netherPortals, v.overworldPortals));
    const f = linkFault.get(lk);
    // (by the rule it breaks: the texts name each portal and point, too many to count by)
    if (!f) return null;
    return /^(the home portal would come out|more than)/.test(f) ? 'the home portal would come out elsewhere'
      : /^(back through it|the home portal is more than)/.test(f) ? 'it would not lead back home' : 'it would take someone\'s link';
  };
  const say = (spot: SetupSpot, plan: HutPlan, path: Pos[], first: boolean) => {
    const k = plan.cost;
    return `nether ${fmt(spot)} along ${spot.axis}${first ? ' (chosen before)' : ''}, ${Math.max(Math.abs(spot.x - v.base.x), Math.abs(spot.z - v.base.z))} from nether ${fmt(v.base)}: ` +
      `${k.places} cobblestone to place, ${k.digs} to dig, ${k.obsidian} obsidian; a walk of ${path.length - 1}`;
  };
  if (prefer) {
    const out = hutOf(prefer).outside;
    const plan = reach.has(key(out)) && !rule(prefer, true) ? planHut(v.grid, prefer, have) : undefined;
    if (plan && !('why' in plan)) return { plan, path: pathOf(reach, out), why: say(prefer, plan, pathOf(reach, out), true) };
  }
  const found: { spot: SetupSpot; cost: Cost; n: number }[] = [];
  for (const [k, r] of reach) {
    const out = parse(k);
    for (const axis of ['x', 'z'] as const) for (const side of [1, -1] as const) for (const door of [0, 1] as const) {
      const spot = spotFor(out, axis, side, door);
      if (Math.max(Math.abs(spot.x - v.base.x), Math.abs(spot.z - v.base.z)) > SPOT_RADIUS || Math.abs(spot.y - v.arrival.y) > SPOT_DY) continue;
      const bad = rule(spot);
      if (bad) { fell(bad); continue; }
      const cost = judgeHut(v.grid, hutOf(spot), have);
      if ('why' in cost) { fell(cost.why); continue; }
      found.push({ spot, cost, n: r.n });
    }
  }
  const off = (s: SetupSpot) => Math.max(Math.abs(s.x - v.base.x), Math.abs(s.z - v.base.z));
  found.sort((a, b) => a.cost.places - b.cost.places || off(a.spot) - off(b.spot) || Math.abs(a.spot.y - v.arrival.y) - Math.abs(b.spot.y - v.arrival.y) ||
    a.n - b.n || a.cost.digs - b.cost.digs || a.spot.x - b.spot.x || a.spot.y - b.spot.y || a.spot.z - b.spot.z ||
    (a.spot.axis === b.spot.axis ? 0 : a.spot.axis === 'x' ? -1 : 1) || b.spot.side - a.spot.side || a.spot.door - b.spot.door);
  for (const f of found.slice(0, 400)) {
    const plan = planHut(v.grid, f.spot, have);
    if ('why' in plan) { fell(plan.why.replace(/ at \(.*$/, '')); continue; }
    const path = pathOf(reach, plan.hut.outside);
    return { plan, path, why: say(f.spot, plan, path, false) };
  }
  const why = [...faults].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n})`).join('; ');
  return { why: `no spot within ${SPOT_RADIUS} of nether ${fmt(v.base)} will do (${reach.size} cells reached on foot): ${why || 'none tried'}` };
}

/**
 * The way out of someone's build on foot, pure: along open cells, within their box and WAY_OUT more, to the nearest
 * standing cell in no one's build (the first a walk of fewest steps reaches). Null with none.
 */
export function wayOut(g: Grid, start: Pos, theirs: Box[], zones: Box[]): Pos[] | null {
  const room = theirs.map(b => grow(b, WAY_OUT));
  const reach = walkFrom(g, [start], p => room.some(r => inBox(r, p)));
  for (const k of reach.keys()) {
    const p = parse(k);
    if (!zones.some(z => inBox(z, p))) return pathOf(reach, p);
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the gate

/** The setup is open while the two sides are not known to be linked (a hold after a trip that came back with nothing is its ready's). */
export const setupOpen = (world: WorldMemory): boolean => peekNether(world).linked !== true;

const pickaxes = (names: Iterable<[string, number]>) => [...names].filter(([n]) => n.endsWith('_pickaxe')).reduce((a, [, k]) => a + k, 0);

/**
 * The obsidian the setup still needs for its own portal's frame, pure: none once its portal stands; at a spot a trip
 * cut short chose, what of the frame is still to place there (the run keeps the count as it places: the portal
 * milestone left exactly the 10, and nothing makes more but the nether spares chore, so a trip that put 3 down and
 * stopped must not ask for 10 again); else the whole frame.
 */
export function setupObsidian(world: WorldMemory): number {
  const n = peekNether(world);
  if (n.portal) return 0;
  return n.setupSpot?.obsidian ?? SETUP_OBSIDIAN;
}

/** What the setup's kit is short of, carried and in the chests together (the spare set and what is held for jobs apart): in words. */
export function setupShort(s: Pick<Snapshot, 'counts'>, world: WorldMemory): string[] {
  const free = freeChestTotals(world);
  const has = (n: string) => (s.counts.get(n) ?? 0) + (free[n] ?? 0);
  const short: string[] = [];
  if (has('golden_helmet') < 1) short.push('a golden helmet');
  if (has('shield') < 1) short.push('a shield');
  const picks = pickaxes(s.counts) + pickaxes(Object.entries(free));
  if (picks < NETHER_TRIP.pickaxes) short.push(`${NETHER_TRIP.pickaxes - picks} pickaxe(s)`);
  if (has('flint_and_steel') < NETHER_TRIP.flintAndSteel) short.push('flint and steel');
  const blocks = NETHER_BLOCKS.reduce((a, n) => a + has(n), 0);
  if (blocks < NETHER_TRIP.blocks) short.push(`${NETHER_TRIP.blocks - blocks} blast-proof blocks`);
  // (the frame's obsidian only while its own portal is still to build, and only what of it is still to place)
  const obsidian = setupObsidian(world);
  if (has('obsidian') < obsidian) short.push(`${obsidian - has('obsidian')} obsidian`);
  const food = readyFoodPoints(s.counts) + readyFoodPoints(new Map(Object.entries(free)));
  if (food < NETHER_TRIP.foodPoints) short.push(`${NETHER_TRIP.foodPoints - food} food points`);
  return short;
}

/**
 * Whether the setup can set out now, pure: not while held (a trip that came back with nothing a day ago), not hurt
 * past what the run heals at home (SETUP_HEALTH), nothing of the kit short that the chests do not hold, and the day
 * long enough for the setup's work down there and home by dusk.
 */
export function setupReady(s: Snapshot, world: WorldMemory): Decline | null {
  const hold = peekNether(world).setupHold;
  if (hold && s.now < hold.until) return { cause: 'hold', text: `setup held until ${clock(hold.until)}: ${hold.why}`, until: hold.until };
  if (s.health < SETUP_HEALTH) return no.health(s, 'the nether setup', SETUP_HEALTH, 10);
  const short = setupShort(s, world);
  if (short.length) return { cause: 'kit', text: `setup: short of ${short.join(', ')} (carried or in the chests)` };
  const left = netherBudgetMs(s.timeOfDay);
  if (left < SETUP_WORTH_MS) return { cause: 'late', text: `setup needs ${SETUP_WORTH_MS / MINUTE} min down there and home by dusk, ${(Math.floor(left / (MINUTE / 10)) / 10).toFixed(1)} left` };
  return null;
}

// ------------------------------------------------------------------------------------------------ the kit

type Inv = { items: InventoryItem[] };
const inventory = async (ctx: GoalContext): Promise<InventoryItem[]> => (await ctx.call<Inv>('inventory').catch((): Inv => ({ items: [] }))).items ?? [];
const total = (items: InventoryItem[], names: readonly string[]) => items.filter(i => names.includes(i.name)).reduce((a, i) => a + i.count, 0);
const carried = (items: InventoryItem[], names: readonly string[]) => items.filter(i => i.slot < 36 && names.includes(i.name)).reduce((a, i) => a + i.count, 0);
const freeSlots = (items: InventoryItem[]) => 36 - new Set(items.filter(i => i.slot >= 0 && i.slot < 36).map(i => i.slot)).size;
/** the stored pickaxes the kit may take, the best first */
const PICKS = ['diamond_pickaxe', 'iron_pickaxe', 'netherite_pickaxe', 'stone_pickaxe'];

/** The kit's own things, which nothing at home makes again but the nether spares chore: the fetch looks for them (findKit). */
const KIT_THINGS = ['golden_helmet', 'flint_and_steel', 'obsidian'] as const;

/**
 * Kit things the chests' memory has lost (none in it, or none where it said), looked for in the home chests
 * themselves: each looked into afresh (peekChest), the gear chests first (the stash's for the golden helmet and the
 * flint and steel; with them full it puts them in the first chest with room), until every one is seen or every chest
 * looked into. Live on Nov 15 the barter's fetch took no golden helmet and no flint and steel where the memory had
 * them, the trip did not set out, and the nether spares chore crafted both again; the stash then put the new ones in
 * a stone chest, the gear chests being full. Returns what was seen, and where.
 */
export async function findKit(ctx: GoalContext, names: readonly string[]): Promise<{ name: string; chest: Pos }[]> {
  const want = new Set(names);
  const seen: { name: string; chest: Pos }[] = [];
  const assign = ctx.world.chestAssign ?? {};
  const gear = (c: Pos) => (assign[key(c)] === 'gear' ? 0 : 1);
  for (const c of [...ctx.world.landmarks.chests].sort((a, b) => gear(a) - gear(b))) {
    if (!want.size || ctx.signal.aborted) break;
    const items: Record<string, number> = (await peekChest(ctx, c).catch(() => undefined)) ?? {};
    for (const n of [...want]) if ((items[n] ?? 0) > 0) { seen.push({ name: n, chest: { ...c } }); want.delete(n); }
  }
  return seen;
}

/**
 * The Nether kit at home before the walk to the portal (mine.ts NETHER_TRIP and the frame's obsidian): what is short of
 * it out of the chests (never the spare set: takeFromChests leaves its pieces), food enough for 40 points, room made
 * again for the trip's 12 free slots with the Nether's own keep (the kit and nothing else), the golden helmet last (the
 * home stash would put it away as spare gear) with a potion of fire resistance where the home has one (D1); eaten to
 * full first, healed last, and then, nothing else short, dressed in the Nether set (netherset.ts wearNetherSet: the
 * main set into the chests). The golden helmet, the flint and
 * steel and the frame's obsidian are looked for in the chests (findKit) where neither the pockets nor the memory hold
 * them, and again where a take found none where the memory said. Undefined when the bot is ready, else what it is
 * still short of, said only after all that.
 */
export async function fetchSetupKit(ctx: GoalContext): Promise<string | undefined> {
  // fed first: eaten to full (the Guardian tops up only while nothing goes to waste), before the food is counted. The
  // room keeps the trip's 40 points of food and no more: a meal after it left the kit short (a bread eaten, 35 < 40)
  // and the trip did not set out; the top-up below makes up what the meals ate
  const eatToFull = async () => {
    for (let i = 0; i < 4; i++) {
      const st = await ctx.status().catch(() => undefined);
      if (!st || (st.food ?? 20) >= NETHER_TRIP.food) break;
      const r = await ctx.act('eat', {}).catch((e: unknown) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }));
      // a meal that did not happen says why, and the next try waits a moment (live, Nov 15 04:11Z: "not setting out:
      // food 17 < 18" with bread carried, just after the bot woke; the reason was swallowed)
      if (!/^Ate /.test(r.text)) {
        ctx.progress(`nether kit: no meal: ${r.text.replace(/\s+/g, ' ').slice(0, 120)}`);
        await pause(SETUP_WAITS.pollMs);
        if (ctx.signal.aborted) throw new Error('aborted');
      }
    }
  };
  await eatToFull();
  let items = await inventory(ctx);
  const refresh = async () => { items = await inventory(ctx); };
  // (its own portal standing already, the trip only checks the link: no frame to build; a frame part placed, only the
  // rest is needed, though the whole frame's worth is taken where the chests hold it: a block knocked out since)
  const obsidian = setupObsidian(ctx.world);
  /** the kit's own things it is short of carried: the golden helmet, the fire starter, the frame's obsidian */
  const lacking = (): string[] => KIT_THINGS.filter(n => total(items, [n]) < (n === 'golden_helmet' ? 1 : n === 'flint_and_steel' ? NETHER_TRIP.flintAndSteel : obsidian));
  // what the memory knows of none of: looked for in the chests first, then taken from where the look saw it
  const looked = new Set<string>();
  const seek = async (names: string[]) => { if (!names.length) return; for (const n of names) looked.add(n); await findKit(ctx, names); };
  const free = freeChestTotals(ctx.world);
  await seek(lacking().filter(n => !(free[n] > 0)));
  const takeObsidian = async () => { if (obsidian > 0 && total(items, ['obsidian']) < SETUP_OBSIDIAN) { await takeFromChests(ctx, 'obsidian', SETUP_OBSIDIAN - total(items, ['obsidian'])); await refresh(); } };
  const takeFlint = async () => { if (total(items, ['flint_and_steel']) < NETHER_TRIP.flintAndSteel) { await takeFromChests(ctx, 'flint_and_steel', 1); await refresh(); } };
  await takeObsidian();
  await takeFlint();
  // a take that found none where the memory said (a chest's memory can be wrong): the chests looked into, and taken
  // again. The helmet, taken last, is looked for in the same round where it is not carried: one round for all
  const missed = lacking().filter(n => !looked.has(n));
  if (missed.some(n => n !== 'golden_helmet')) { await seek(missed); await takeObsidian(); await takeFlint(); }
  for (const b of NETHER_BLOCKS) {
    const n = total(items, NETHER_BLOCKS);
    if (n >= NETHER_TRIP.blocks) break;
    if (await takeFromChests(ctx, b, NETHER_TRIP.blocks - n)) await refresh();
  }
  for (const p of PICKS) {
    const n = items.filter(i => i.name.endsWith('_pickaxe')).length;
    if (n >= NETHER_TRIP.pickaxes) break;
    if (await takeFromChests(ctx, p, NETHER_TRIP.pickaxes - n)) await refresh();
  }
  if (!total(items, ['shield'])) { await takeFromChests(ctx, 'shield', 1); await refresh(); }
  const points = () => readyFoodPoints(new Map(items.map(i => [i.name, total(items, [i.name])])));
  const topUpFood = async () => {
    if (points() >= NETHER_TRIP.foodPoints) return;
    const foods = foodsFor26();
    const stored = Object.entries(freeChestTotals(ctx.world))
      .filter(([n]) => foods[n] && !COOKS_TO[n] && !AVOID_UNLESS_ASKED.has(n))
      .sort(([a], [b]) => foods[b].foodPoints - foods[a].foodPoints);
    for (const [name, n] of stored) {
      const want = Math.min(n, Math.ceil((NETHER_TRIP.foodPoints - points()) / foods[name].foodPoints));
      if (want > 0 && await takeFromChests(ctx, name, want)) await refresh();
      if (points() >= NETHER_TRIP.foodPoints) break;
    }
  };
  await topUpFood();
  // the trip's room with the Nether's own keep: its kit and nothing of what the bot carries for life at home (chores.ts
  // stashKeep; with the home kit kept the live room stored nothing and the trip did not set out, 9 slots free of 12)
  const helmet = total(items, ['golden_helmet']) > 0;
  const potion = () => items.some(i => i.slot >= 0 && i.slot < 36 && isFirePotion(i));
  const potionDue = !potion() && storedStacks(ctx.world, isFirePotion).length > 0;
  if (freeSlots(items) < NETHER_TRIP.slotsFree + (helmet ? 0 : 1) + (potionDue ? 1 : 0)) {
    await putAway(ctx, await look(ctx), stashKeep(ctx.world, 'nether')).catch(e => {
      ctx.progress(`making room for the nether kit: ${(e as Error).message}`);
    });
    await refresh();
  }
  if (!helmet) { await takeFromChests(ctx, 'golden_helmet', 1); await refresh(); }
  if (lacking().includes('golden_helmet') && !looked.has('golden_helmet')) { await seek(['golden_helmet']); await takeFromChests(ctx, 'golden_helmet', 1); await refresh(); }
  // a potion of fire resistance for the Guardian's hook (client-mod Nether.fireResistance: drunk the moment the bot
  // burns or stands in lava), on every trip while the home has one: down there every trip may meet lava, a ghast's fire
  // or a fall into a lake. By its slot and its contents (every potion is `potion`), the long one first; the stash's
  // Nether keep keeps it (chores.ts netherKit). None in stock is no reason to stay home: the barter is what brings them
  if (potionDue && !potion()) {
    const f = storedStacks(ctx.world, isFirePotion).sort((a, b) => Number(/^long_/.test(b.stack.potion ?? '')) - Number(/^long_/.test(a.stack.potion ?? '')))[0];
    if (f && await takeSlot(ctx, f.chest, f.stack.slot, Math.min(f.stack.count, NETHER_TRIP.firePotions)).catch(() => 0)) await refresh();
  }
  // fed again just before it goes, and the 40 points made up again if that meal ate into them: the room's walks (the
  // dump spot and back) and a fight at the portal by night cost the points the first meals gave (live, Nov 15:
  // "not setting out: food 17 < 18", twice)
  await eatToFull();
  await refresh();
  await topUpFood();
  await holdHarmless(ctx);
  // whole: the healing that follows the meals
  for (let waited = 0; ; waited += SETUP_WAITS.pollMs) {
    const st = await ctx.status().catch(() => undefined);
    if (!st || (st.health ?? 20) >= NETHER_TRIP.health || waited >= SETUP_WAITS.healMs || !SETUP_WAITS.pollMs) break;
    await pause(SETUP_WAITS.pollMs);
    if (ctx.signal.aborted) throw new Error('aborted');
  }
  const s = await look(ctx);
  const kit = netherTripKit(netherCheck(s));
  const why = [
    ...(kit.ok ? [] : [kit.why!]),
    ...(carried(s.items, ['obsidian']) < obsidian ? [`${carried(s.items, ['obsidian'])} obsidian < ${obsidian}`] : []),
    ...(freeSlots(s.items) < NETHER_TRIP.slotsFree ? [`${freeSlots(s.items)} free slots < ${NETHER_TRIP.slotsFree}`] : [])
  ];
  if (why.length) return why.join('; ');
  // last, once nothing else keeps it home: the Nether set on and the main set in the chests (netherset.ts), so a death
  // down there loses that set only. Never down there: this is the one place the trips dress for it
  return wearNetherSet(ctx);
}

// ------------------------------------------------------------------------------------------------ the run

/** A portal as the bridge lists it. */
export type Listed = PortalShape & { blocks?: number; own?: boolean; distance?: number };
/** portal.enter's reply. */
export interface Entered { ok?: boolean; reason?: string; dimension?: string; position?: Pos; block?: Pos; portal?: Pos | null; arrived?: Listed | null; stepped?: boolean }

export const listPortals = async (ctx: GoalContext, range = 96): Promise<Listed[]> =>
  (await ctx.call<{ portals?: Listed[] }>('portal.list', { range }).catch(() => ({ portals: [] as Listed[] }))).portals ?? [];

/** The setup held a day, and why (the lead looks in between): said in the log. */
export function holdSetup(ctx: GoalContext, now: number, line: string, why: string): void {
  netherOf(ctx.world).setupHold = { until: now + SETUP_HOLD_MS, why };
  ctx.progress(line);
}

/** What a hut that will not do may yet do on another trip: blocks carried short, the ground round it not all loaded. */
const STILL_MAY = /^(not all loaded|\d+ cobblestone to place|\d+ obsidian for the frame)/;

/** A spot for its own portal let go (world.nether.setupSpot) and remembered as refused, with why: chooseHut never takes it again. */
export function refuseSpot(world: WorldMemory, spot: SetupSpot, why: string, now: number): void {
  const n = netherOf(world);
  const same = (r: SetupSpot) => r.x === spot.x && r.y === spot.y && r.z === spot.z && r.axis === spot.axis && r.side === spot.side && r.door === spot.door;
  if (n.setupSpot && same(n.setupSpot)) delete n.setupSpot;
  const kept = (n.refusedSpots ?? []).filter(r => !same(r));
  n.refusedSpots = [...kept, { x: spot.x, y: spot.y, z: spot.z, axis: spot.axis, side: spot.side, door: spot.door, why: why.slice(0, 120), at: now }].slice(-REFUSED_SPOTS);
}

/** Through a portal, the bottom cell of it given, stepping out toward home at the far end. */
export async function enter(ctx: GoalContext, cell: Pos): Promise<Entered> {
  const home = ctx.s.home;
  const r = await ctx.call<Entered>('portal.enter', { ...cell, timeoutMs: 60_000, ...(home ? { toward: { x: home.x, z: home.z } } : {}) }, 90_000)
    .catch((e: Error) => ({ ok: false, reason: e.message } as Entered));
  if (ctx.signal.aborted) throw new Error('aborted');
  return r;
}

/**
 * Still in the Nether (a status that does not answer: taken as so). A death down there wakes the bot at its bed in
 * the overworld at once, past NEAR_HOME, where nothing but survival cuts a trip short: every walk, dig and place the
 * run sent after it went to the Nether's numbers in the overworld, a careful goto toward a point some 1,900 blocks
 * past the leash with no armour on. So the run asks before each.
 */
export const inNether = async (ctx: GoalContext): Promise<boolean> => ((await ctx.status().catch(() => undefined))?.dimension ?? NETHER) === NETHER;
/** What a run says that found itself out of the Nether halfway (nothing held, nothing written: the wrapper walks home, workTick books the death). */
export const GONE: WorkResult = { gain: 0, text: 'not in the nether any more (a death down there?)' };

/**
 * A walk along a path a few cells at a time, careful (nothing broken or placed): `stuck` where a leg did not arrive,
 * `gone` out of the Nether. `between` (the barter's and the quartz's walks out): asked before every leg after the
 * first; `back` once it says no. Their danger rules (a hoglin, a ghast, a piglin turned) lived in a look before and
 * after a walk only: a hoglin come 6 off at the second leg of a walk out to a piglin 40 away was first seen 8 legs on,
 * the bot some 30 cells further from its hut beside it.
 */
export async function walkAlong(ctx: GoalContext, path: Pos[], every = 4, between?: () => Promise<boolean>): Promise<'ok' | 'stuck' | 'gone' | 'back'> {
  for (let i = Math.min(every, path.length - 1), first = true; i > 0; i = i === path.length - 1 ? 0 : Math.min(i + every, path.length - 1), first = false) {
    if (!(await inNether(ctx))) return 'gone';
    if (between && !first && !(await between())) return 'back';
    const p = path[i];
    const r = await ctx.call<{ arrived?: boolean }>('goto', { ...p, range: 0, careful: true, timeoutMs: 30_000 }, 45_000).catch(() => ({ arrived: false }));
    if (ctx.signal.aborted) throw new Error('aborted');
    if (r?.arrived === false) return (await inNether(ctx)) ? 'stuck' : 'gone';
  }
  return 'ok';
}

/**
 * Read a box of the Nether, again while some of it is not loaded yet (a walk out of the portal outruns the chunks), up
 * to `tries` reads (the barter's read out to 96 asks once: its far corners lie past the client's chunks for good).
 */
export async function readGround(ctx: GoalContext, b: Box, tries = SETUP_WAITS.loadTries): Promise<Grid> {
  const box = { x: b.x1, y: b.y1, z: b.z1, width: b.x2 - b.x1 + 1, height: b.y2 - b.y1 + 1, length: b.z2 - b.z1 + 1 };
  let blocks = await readBox(ctx, box);
  for (let i = 1; i < tries && blocks.some(x => x === null); i++) {
    await pause(SETUP_WAITS.loadMs);
    if (ctx.signal.aborted) throw new Error('aborted');
    blocks = await readBox(ctx, box);
  }
  return { ...box, blocks };
}

/**
 * Carry out a hut's steps, from where the walk there ended: false and why where one did not do what it should
 * (`gone`: out of the Nether). Each obsidian placed comes off the frame's count at the spot as it goes (an abort
 * mid-build, by leave nether or the timeout, leaves it right): the next trip's kit asks for the rest only.
 */
async function build(ctx: GoalContext, plan: HutPlan, left: () => number): Promise<string | undefined> {
  for (const step of plan.steps) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (left() < 20_000) return 'out of time';
    if (!(await inNether(ctx))) return 'gone';
    if (step.do === 'walk') {
      const r = await ctx.call<{ arrived?: boolean }>('goto', { ...step.to, range: 0, careful: true, timeoutMs: 15_000 }, 25_000).catch(() => ({ arrived: false }));
      if (r?.arrived === false) return `could not step to ${fmt(step.to)}`;
    } else if (step.do === 'dig') {
      const r = await ctx.call<{ dug?: boolean; reason?: string }>('dig.here', { ...step.at, timeoutMs: 15_000 }, 25_000).catch((e: Error) => ({ dug: false, reason: e.message }));
      if (!r?.dug && r?.reason !== 'air') return `could not dig at ${fmt(step.at)}: ${r?.reason ?? 'no answer'}`;
    } else {
      const r = await ctx.act('place-block', { ...step.at, item: step.item, faceDirection: step.face });
      if (!/^Placed |^There's already a block/.test(r.text)) return `could not place ${step.item} at ${fmt(step.at)}: ${r.text.replace(/\s+/g, ' ').slice(0, 100)}`;
      const spot = netherOf(ctx.world).setupSpot;
      if (step.item === 'obsidian' && /^Placed /.test(r.text) && spot?.obsidian) spot.obsidian -= 1;
    }
  }
  return undefined;
}

/** What is missing of the frame or in its inside, from a fresh read: undefined when it is whole. */
function frameFault(g: Grid, hut: Hut): string | undefined {
  const missing = hut.frame.filter(p => blockAt(g, p) !== 'obsidian');
  const inWay = hut.inside.filter(p => !['air', 'cave_air', 'nether_portal'].includes(blockAt(g, p) ?? ''));
  const why = [missing.length ? `${missing.length} obsidian missing (${missing.slice(0, 2).map(fmt).join(', ')})` : '',
    inWay.length ? `in the way: ${inWay.slice(0, 2).map(p => `${blockAt(g, p) ?? 'unloaded'} at ${fmt(p)}`).join(', ')}` : ''].filter(Boolean);
  return why.length ? why.join('; ') : undefined;
}

/**
 * From home into the Nether by the home portal (the setup's and the look's start): the home portal as the bridge has
 * it, the walk to it on foot with a harmless hand, and through it (no `toward`: the far end steps out where it is
 * safe). In the Nether it says `nether: through the portal at overworld (x, y, z) -> nether (x, y, z)`. What came
 * back from the bridge, or why it did not go (the run is then an untried one: it never went through).
 */
export async function intoNether(ctx: GoalContext, home: Pos): Promise<{ homeShape: Listed; cell: Pos; r: Entered; came: Pos } | { why: string }> {
  // the home portal as the bridge has it (its axis and size: where it leads depends on them)
  const homeShape = (await listPortals(ctx)).find(p => portalCells(p).some(c => same(c, home)));
  if (!homeShape) return { why: `the home portal at overworld ${fmt(home)} is not lit (portal.list does not show it)` };
  const st0 = await ctx.status().catch(() => undefined);
  const me0 = st0?.position ?? ctx.s.position;
  const cell = bottomOf(homeShape).sort((a, b) => Math.hypot(a.x - me0.x, a.z - me0.z) - Math.hypot(b.x - me0.x, b.z - me0.z))[0];
  // a harmless hand on the walk (the flint and steel carried must never be what a door's click uses)
  await holdHarmless(ctx);
  if (Math.hypot(cell.x - me0.x, cell.z - me0.z) > 3) {
    const w = await ctx.call<{ arrived?: boolean }>('goto', { ...cell, range: 2, careful: true, timeoutMs: 60_000 }, 75_000).catch(() => ({ arrived: false }));
    if (ctx.signal.aborted) throw new Error('aborted');
    if (w?.arrived === false) return { why: `no way on foot to the home portal at overworld ${fmt(cell)}` };
  }
  const r = await ctx.call<Entered>('portal.enter', { ...cell, timeoutMs: 60_000 }, 90_000).catch((e: Error) => ({ ok: false, reason: e.message } as Entered));
  if (ctx.signal.aborted) throw new Error('aborted');
  if (!r.ok || r.dimension !== NETHER) {
    return { why: `through the home portal at overworld ${fmt(cell)}: ${r.ok ? `came out in ${r.dimension ?? 'the same place'}` : r.reason ?? 'no answer'}` };
  }
  const came = r.portal ?? r.block ?? r.position ?? ctx.s.position;
  ctx.progress(`nether: through the portal at overworld ${fmt(cell)} -> nether ${fmt(came)}`);
  return { homeShape, cell, r, came };
}

/** The zone a foreign arrival portal stands for while the bridge's scan has none round it yet. */
const NOT_SCANNED = 'nether_portal (not scanned yet)';

/**
 * A portal the server may have made for this very trip, pure: by home's scaled point (within the server's own 16 of
 * it, where the home portal looks for a portal to come out of, nether.ts SEARCH), no other portal known there (its
 * own, or others' seen: the server makes one only where it finds none), and its zones nothing but its own portal
 * blocks (the stand-in for one not scanned yet, or a scan's zone of `nether_portal` markers only, as many as its
 * blocks: a portal the server builds has an obsidian frame and platform, and obsidian is no marker). It is still
 * counted someone's, as the bot cannot tell whose; the line says what it may be, for the lead.
 */
export function maybeServers(arrived: PortalShape, home: PortalShape, theirs: NetherZone[], known: Pos[]): boolean {
  const cells = portalCells(arrived);
  const points = bottomOf(home).map(c => scaled(c, NETHER));
  const near = (c: Pos) => points.some(p => Math.max(Math.abs(c.x - p.x), Math.abs(c.z - p.z)) <= SEARCH[NETHER]);
  const by = cells.some(near) && !known.some(c => near(c) && !cells.some(a => Math.abs(a.x - c.x) <= 1 && Math.abs(a.y - c.y) <= 1 && Math.abs(a.z - c.z) <= 1));
  const lone = (z: NetherZone) => z.sample === NOT_SCANNED ||
    ((z.kinds?.length ? z.kinds.every(k => /^nether_portal x\d+$/.test(k)) : z.sample === 'nether_portal') && (z.markers ?? cells.length) === cells.length);
  return by && theirs.length > 0 && theirs.every(lone);
}

/** `a` lies wholly inside `b`. */
const within = (a: Box, b: Box) => a.x1 >= b.x1 && a.y1 >= b.y1 && a.z1 >= b.z1 && a.x2 <= b.x2 && a.y2 <= b.y2 && a.z2 <= b.z2;

/**
 * The setup trip (see the top of the file). From home with the kit (or it does not set out: untried), through the
 * home portal, out of someone's build on foot or back and held, its own portal and hut at the spot chosen, lit and
 * registered (portal.own, `world.nether.portal`), and back through it: linked, or held a day. Ends where it ends:
 * the work wrapper takes it home (through a portal first, nether.ts netherHome, when it is still down there). Out
 * of the Nether halfway (a death), it stops at once and writes nothing more (GONE).
 */
export async function setupRun(ctx: GoalContext, budgetMs: number, now: () => number): Promise<WorkResult> {
  const began = now();
  const left = () => budgetMs - (now() - began);
  const world = ctx.world;
  const home = homePortal(world);
  if (!home) return { gain: 0, text: 'no home portal lit', untried: true };
  const lacking = await fetchSetupKit(ctx);
  if (lacking) return { gain: 0, text: `not setting out: ${lacking}`, untried: true };
  // (the kit, the eating and the healing came out of the day's time: with too little of it left the trip would walk
  // out through someone's room and over to its spot only to stop at the hut's first step)
  if (left() < SETUP_LEAST_MS) {
    return { gain: 0, text: `not setting out: the kit took ${Math.round((now() - began) / 1000)} s, too little of the day's time is left`, untried: true };
  }
  const went = await intoNether(ctx, home);
  if ('why' in went) return { gain: 0, text: went.why, untried: true };
  const { homeShape, r, came } = went;

  // ---- where it came out: the protection sync for the Nether first (a look does it), then whose portal, whose build
  const st = await ctx.status().catch(() => undefined);
  const me = st?.position ?? r.position ?? came;
  const listed = await listPortals(ctx, 128);
  const block = { x: Math.floor(came.x), y: Math.floor(came.y), z: Math.floor(came.z) };
  const arrived: PortalShape | undefined = r.arrived ?? listed.find(p => portalCells(p).some(c => same(c, block)));
  const n = peekNether(world);
  const ownAt = n.portal;
  const isOwn = (p: PortalShape) => !!ownAt && portalCells(p).some(c => Math.abs(c.x - ownAt.x) <= 1 && Math.abs(c.y - ownAt.y) <= 1 && Math.abs(c.z - ownAt.z) <= 1);
  const arrivalCells = arrived ? portalCells(arrived) : [block];
  const feet = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
  const holds = (z: NetherZone) => [...arrivalCells, feet].some(c => inBox(zoneBox(z), c));
  const askZones = async () => (await ctx.call<{ zones?: NetherZone[] }>('foreign.zones', { dimension: NETHER }).catch(() => ({ zones: [] as NetherZone[] }))).zones ?? [];
  let zones = await askZones();
  // a lit portal of others is always a build to the bridge's scan (its six portal blocks are markers): one it does not
  // show yet is a scan still to come (the protection sync, the chunks): asked again, and if it still shows none, the
  // portal is counted someone's anyway, with the scan's own margin round it
  const foreignArrival = !!arrived && !isOwn(arrived);
  for (let i = 1; foreignArrival && !zones.some(holds) && i < SETUP_WAITS.loadTries; i++) {
    await pause(SETUP_WAITS.loadMs);
    if (ctx.signal.aborted) throw new Error('aborted');
    zones = await askZones();
  }
  const withArrival = (zs: NetherZone[]): NetherZone[] =>
    (foreignArrival && !zs.some(holds) ? [...zs, { ...grow(boxOf(arrivalCells), ZONE_MARGIN), surface: true, sample: NOT_SCANNED }] : zs);
  const notePortalsNow = async () => {
    const seen = (await ctx.call<{ portals?: PortalShape[] }>('foreign.portals', { dimension: NETHER }).catch(() => ({ portals: [] as PortalShape[] }))).portals ?? [];
    notePortals(world, NETHER, foreignArrival && arrived && !seen.some(p => same(p, arrived)) ? [...seen, arrived] : seen);
  };
  zones = withArrival(zones);
  await notePortalsNow();
  let theirs = zones.filter(z => !z.natural && holds(z));
  // nobody's build is walked into (a natural fortress or bastion may be: it is the world's)
  let built = zones.filter(z => !z.natural).map(zoneBox);
  // (one by home's scaled point that holds nothing but itself may be the server's, made as the bot came through)
  const knownCells = () => [...(ownAt ? [ownAt] : []), ...(peekNether(world).seen?.[NETHER] ?? []).flatMap(portalCells)];
  let lone = !!arrived && foreignArrival && maybeServers(arrived, homeShape, theirs, knownCells());
  const LONE = 'a portal by home\'s scaled point that holds nothing but itself, perhaps the server\'s, made for this trip';
  const where = arrived && isOwn(arrived) ? 'its own'
    : lone ? `${LONE} (counted someone's; the lead looks)`
      : theirs.length ? `someone's, in their build (${theirs.map(z => z.sample ?? 'built').join(', ')})` : 'not in anyone\'s build';
  ctx.progress(`nether: came out of the portal at nether ${fmt(arrived ?? came)}: ${where}`);
  const perhaps = () => (lone ? ` (it came out at nether ${fmt(arrived ?? came)}: ${LONE})` : '');
  const back = async (): Promise<{ ok: boolean; text: string }> => {
    if (!arrived) return { ok: false, text: 'no portal to go back through' };
    const b = await enter(ctx, bottomOf(arrived).sort((a, c) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(c.x - me.x, c.z - me.z))[0]);
    return b.ok && b.dimension === OVERWORLD ? { ok: true, text: `back at overworld ${fmt(b.portal ?? b.block ?? b.position ?? came)}` } : { ok: false, text: `back through it: ${b.reason ?? b.dimension ?? 'no answer'}` };
  };

  // ---- the ground round the search and the way out: one read (and its own portal's ground, listed or not)
  const known = peekNether(world);
  // (its own portal as the first list has it, or as the bridge said it came out of it)
  let ownStanding: PortalShape | undefined = ownAt ? listed.find(isOwn) ?? (arrived && isOwn(arrived) ? arrived : undefined) : undefined;
  const overworldPortals = known.seen?.[OVERWORLD] ?? [];
  const at = feet;
  const baseSpot = netherPortalSpot(homeShape, (known.seen?.[NETHER] ?? []).filter(p => !isOwn(p)), overworldPortals, { ys: [at.y] });
  const chosen = known.setupSpot;
  const base: Pos = baseSpot.spot ?? chosen ?? at;
  const spread = SPOT_RADIUS + 6;
  const areaFor = (theirs: NetherZone[]): Box => {
    const parts: Box[] = [
      { x1: base.x - spread, y1: at.y - SPOT_DY - MAX_DROP - 4, z1: base.z - spread, x2: base.x + spread, y2: at.y + SPOT_DY + 6, z2: base.z + spread },
      { x1: at.x - 3, y1: at.y - 4, z1: at.z - 3, x2: at.x + 3, y2: at.y + 4, z2: at.z + 3 },
      ...theirs.map(z => grow(zoneBox(z), WAY_OUT + 1)),
      ...(chosen ? [grow(hutOf(chosen).box, 4)] : []),
      ...(ownAt ? [grow(boxOf([ownAt]), 4)] : []),
      ...(ownStanding ? [grow(boxOf(portalCells(ownStanding)), 4)] : [])
    ];
    const a = boxOf(parts.flatMap(p => [{ x: p.x1, y: p.y1, z: p.z1 }, { x: p.x2, y: p.y2, z: p.z2 }]));
    return { ...a, y1: Math.max(1, a.y1), y2: Math.min(126, a.y2) };
  };
  let area = areaFor(theirs);
  let g = await readGround(ctx, area);
  // the scan again: chunks that came in while the ground was read hold builds the first ask could not show (the
  // bridge's scan reads loaded chunks only), and the hut keeps its 16 from them too; their builds reach past the
  // ground read: read again, wider
  zones = withArrival(await askZones());
  await notePortalsNow();
  theirs = zones.filter(z => !z.natural && holds(z));
  built = zones.filter(z => !z.natural).map(zoneBox);
  lone = !!arrived && foreignArrival && maybeServers(arrived, homeShape, theirs, knownCells());
  const others = (peekNether(world).seen?.[NETHER] ?? []).filter(p => !isOwn(p));
  const wider = areaFor(theirs);
  if (!within(wider, area)) {
    area = wider;
    g = await readGround(ctx, area);
  }
  const start = footing(g, me);

  // ---- someone's build: out of it on foot along open cells, or back at once and held a day
  let from = start ? [start] : [];
  if (theirs.length) {
    const way = start ? wayOut(g, start, theirs.map(zoneBox), built) : null;
    const walked = way ? await walkAlong(ctx, way, 3) : 'stuck';
    if (walked === 'gone') return GONE;
    if (!way || walked !== 'ok') {
      const said = `nether: arrived in someone's build at nether ${fmt(arrived ?? came)} with no way out on foot: back, setup held a day`;
      holdSetup(ctx, now(), said, `arrived in someone's build at nether ${fmt(arrived ?? came)} with no way out on foot`);
      const b = await back();
      return { gain: 0, text: `in someone's build with no way out on foot; ${b.text}; setup held a day`, ...(b.ok ? { cameBack: true as const } : {}) };
    }
    from = [way[way.length - 1]];
    ctx.progress(`nether: out of their build on foot to nether ${fmt(from[0])} (${way.length - 1} steps, nothing dug or placed)`);
  }

  // ---- its own portal: lit (as a list shows it, else as the ground does), not to be told yet, or gone out. A first
  // list made as it came out may miss it (its chunk not in yet): asked again once the ground is read; and the memory
  // of it goes only when its cells are loaded and hold no portal (gone, it is never had back: the bridge would count
  // the bot's own portal and hut someone's, and the frame's obsidian be asked for again)
  if (ownAt && !ownStanding) ownStanding = (await listPortals(ctx, 128)).find(isOwn);
  const ownCells: Pos[] = [];
  if (ownAt) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) ownCells.push(add(ownAt, dx, dy, dz));
  const ownLit = !!ownStanding || ownCells.some(c => blockAt(g, c) === 'nether_portal');
  if (ownAt && !ownLit && ownCells.some(c => blockAt(g, c) === null)) {
    return { gain: 0, text: `its own portal at nether ${fmt(ownAt)} not in sight (its chunks not in): nothing changed` };
  }

  // ---- its own portal stands already (built on an earlier trip): straight to the link's check
  let spot: SetupSpot | undefined;
  if (ownLit && ownAt) {
    if (!(arrived && isOwn(arrived)) || !ownStanding) {
      // the home portal led elsewhere though its own stands: the link is broken the one way, whatever the other does
      // (a portal of someone's nearer home's scaled point now). The lead looks; the way home is the wrapper's, by its own
      netherOf(world).linked = false;
      const said = `nether: not linked: the home portal came out at nether ${fmt(arrived ?? came)}, not at its own at nether ${fmt(ownStanding ?? ownAt)}`;
      holdSetup(ctx, now(), `${said}: setup held a day`, said.replace(/^nether: /, ''));
      return { gain: 0, text: `the home portal came out at nether ${fmt(arrived ?? came)}, not at its own: not linked; setup held a day` };
    }
    spot = { x: ownStanding.x, y: ownStanding.y, z: ownStanding.z, axis: ownStanding.axis === 'z' ? 'z' : 'x', side: 1, door: 0 };
  } else {
    if (ownAt) {
      // remembered, but no lit portal there now (put out, or broken): built again where it was chosen, or anew
      ctx.progress(`nether: its own portal at nether ${fmt(ownAt)} is not lit: building it again`);
      delete netherOf(world).portal;
    }
    if (!chosen && !baseSpot.spot) {
      const said = `nether: no spot for its own portal: ${baseSpot.why}${perhaps()}: setup held a day`;
      holdSetup(ctx, now(), said, `no spot for its own portal (${baseSpot.why.slice(0, 120)})${perhaps()}`);
      return { gain: 0, text: `no spot for its own portal; setup held a day` };
    }
    const kit = await inventory(ctx);
    const view: SetupView = {
      grid: g, home: homeShape, netherPortals: others, overworldPortals, zones, base, arrival: at, from,
      cobblestone: carried(kit, ['cobblestone']), obsidian: carried(kit, ['obsidian']),
      // (the cobblestone round a portal of its own that went out is its old hut's)
      ...(ownAt ? { mine: [grow(boxOf([ownAt]), 4)] } : {}),
      refused: known.refusedSpots ?? []
    };
    const choice = chooseHut(view, chosen);
    if (!('plan' in choice)) {
      const said = `nether: no room for its own portal: ${choice.why}${perhaps()}: setup held a day`;
      holdSetup(ctx, now(), said, `${choice.why.slice(0, 200)}${perhaps()}`);
      return { gain: 0, text: `no room for its own portal by nether ${fmt(base)}; setup held a day` };
    }
    spot = choice.plan.hut.spot;
    // (with what of its frame is still to place: the count goes down as the build places it)
    netherOf(world).setupSpot = { x: spot.x, y: spot.y, z: spot.z, axis: spot.axis, side: spot.side, door: spot.door, obsidian: choice.plan.cost.obsidian };
    ctx.progress(`nether: its own portal goes at ${choice.why}`);
    const walked = await walkAlong(ctx, choice.path);
    if (walked === 'gone') return GONE;
    if (walked === 'stuck') {
      const w = await ctx.call<{ arrived?: boolean }>('goto', { ...choice.plan.hut.outside, range: 0, careful: true, timeoutMs: 45_000 }, 60_000).catch(() => ({ arrived: false }));
      if (ctx.signal.aborted) throw new Error('aborted');
      if (w?.arrived === false) return (await inNether(ctx)) ? { gain: 0, text: `no way on foot to its spot at nether ${fmt(spot)}` } : GONE;
    }
    // the build as planned; where a step did not do what it should, once more from a fresh look at what stands
    let plan: HutPlan | { why: string } = choice.plan;
    for (let round = 0; ; round++) {
      if (round > 0) {
        // (all the judgement reads: the ring round the hut where lava or fire rules it out, and the drop under it)
        const fresh = await readGround(ctx, judgedBox(choice.plan.hut));
        const s2 = await inventory(ctx);
        plan = planHut(fresh, spot, { cobblestone: carried(s2, ['cobblestone']), obsidian: carried(s2, ['obsidian']) });
        const sp = netherOf(world).setupSpot;
        if (sp && !('why' in plan)) sp.obsidian = plan.cost.obsidian;
      }
      if ('why' in plan) {
        // the spot itself will not do, as it stands now: let go and never chosen again (kept, the next trip would go
        // back to it first, the spot chosen before). Not for what is carried or not yet loaded: the spot may still do
        if (STILL_MAY.test(plan.why)) return { gain: 0, text: `the hut at nether ${fmt(spot)} could not be built: ${plan.why}` };
        refuseSpot(world, spot, plan.why, now());
        ctx.progress(`nether: its own portal's spot at nether ${fmt(spot)} refused: ${plan.why}`);
        return { gain: 0, text: `the hut at nether ${fmt(spot)} could not be built: ${plan.why}; that spot refused for good` };
      }
      const why = await build(ctx, plan, left);
      await holdHarmless(ctx);
      if (!why) break;
      if (why === 'gone') return GONE;
      if (why === 'out of time') return { gain: 0, text: `out of time building the hut at nether ${fmt(spot)}: the next trip goes on there`, mark: 'same' };
      if (round >= 1) return { gain: 0, text: `the hut at nether ${fmt(spot)}: ${why}` };
      if (!(await inNether(ctx))) return GONE;
      ctx.progress(`nether: the hut at nether ${fmt(spot)}: ${why}: looking again`);
      // out to the door's outside cell, where a plan's steps start, before planning again from what stands
      await ctx.call('goto', { ...plan.hut.outside, range: 0, careful: true, timeoutMs: 20_000 }, 30_000).catch(() => undefined);
      if (ctx.signal.aborted) throw new Error('aborted');
    }
    const hut = (plan as HutPlan).hut;
    if (!(await inNether(ctx))) return GONE;
    const look2 = await readGround(ctx, grow(hut.box, 1));
    const sp = netherOf(world).setupSpot;
    if (sp) sp.obsidian = hut.frame.filter(p => blockAt(look2, p) !== 'obsidian').length;
    const fault = frameFault(look2, hut);
    if (fault) return { gain: 0, text: `the frame at nether ${fmt(spot)} is not whole: ${fault}` };
    // lit through the bridge's armed use (F1's guard refuses any other use of a fire starter), the hand harmless after
    const u = await ctx.act('use-item-on-block', { ...hut.light, item: 'flint_and_steel', face: 'up' });
    await holdHarmless(ctx);
    const lit = (await listPortals(ctx, 32)).find(p => p.x === spot!.x && p.y === spot!.y && p.z === spot!.z);
    if (!lit) {
      if (!(await inNether(ctx))) return GONE;
      const said = `nether: the frame at nether ${fmt(spot)} did not light (${u.text.replace(/\s+/g, ' ').slice(0, 100)}): setup held a day`;
      holdSetup(ctx, now(), said, `the frame at nether ${fmt(spot)} did not light`);
      return { gain: 0, text: `the frame at nether ${fmt(spot)} did not light; setup held a day` };
    }
    await ctx.call('portal.own', { dimension: NETHER, x: spot.x, y: spot.y, z: spot.z }).catch(() => undefined);
    const mem = netherOf(world);
    mem.portal = { x: spot.x, y: spot.y, z: spot.z };
    delete mem.setupSpot;
    ctx.progress(`nether: built own portal at nether ${fmt(spot)}`);
  }

  // ---- back through its own portal: out by the home portal, the two are linked
  if (!(await inNether(ctx))) return GONE;
  const ownCell = { x: spot.x, y: spot.y, z: spot.z };
  const b = await enter(ctx, ownCell);
  if (!b.ok || b.dimension !== OVERWORLD) return { gain: 0, text: `its own portal at nether ${fmt(spot)} stands; back through it: ${b.ok ? `came out in ${b.dimension ?? 'the same place'}` : b.reason ?? 'no answer'}` };
  const out = b.portal ?? b.block ?? b.position ?? ctx.s.position;
  const homeCells = portalCells(homeShape);
  const linked = homeCells.some(c => Math.hypot(c.x - out.x, c.y - out.y, c.z - out.z) <= LINK_RANGE);
  const mem = netherOf(world);
  mem.linked = linked;
  if (linked) {
    delete mem.setupHold;
    ctx.progress(`nether: linked: home portal overworld ${fmt(home)} <-> nether ${fmt(spot)}`);
    return { gain: 1, text: `its own portal at nether ${fmt(spot)}, linked with the home portal`, cameBack: true, worked: true };
  }
  holdSetup(ctx, now(), `nether: not linked: came out at overworld ${fmt(out)}`, `its own portal at nether ${fmt(spot)} led back to overworld ${fmt(out)}, not home`);
  return { gain: 0, text: `its own portal at nether ${fmt(spot)} led back to overworld ${fmt(out)}: not linked; setup held a day`, cameBack: true };
}
