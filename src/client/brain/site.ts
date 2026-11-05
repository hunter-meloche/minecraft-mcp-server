/**
 * Where to put the next building. The yard is a leveled area (ground at y = level) that already holds the bot's
 * buildings, farm and paths; a new building needs a patch of plain leveled ground with some room around it, and when
 * the yard has none, the yard grows by a strip on its cheapest dry side. Pure: works on a region grid (x fastest, then
 * z, then y) as world.region returns it, and on callbacks for the world outside it.
 */

import type { Box, Pos } from '../survey.js';

/**
 * What a ground column holds, as far as building on it goes.
 * - free: natural ground exactly at the level with nothing standing on it: build here
 * - built: something the bot built or furniture (protected block, door, chest, bed, fence, torch...) above the ground
 * - farm: farmland or crops
 * - water: water on top
 * - uneven: the ground is not at the level (a hill, a hole, a tree, a stray block): leveling it first is work
 * - path: a dirt path or gravel at the level: walked on, don't build over it
 * - unknown: unloaded (null) before the ground was found
 */
export type CellState = 'free' | 'built' | 'farm' | 'water' | 'uneven' | 'path' | 'unknown';

/** One state per column, cells[(x - grid.x) + (z - grid.z) * width]; x and z are the absolute coordinates of cell 0. */
export interface Grid { x: number; z: number; width: number; length: number; cells: CellState[] }

/** A rectangle in absolute block coordinates: width along x, length along z. */
export interface Rect { x: number; z: number; width: number; length: number }

/** A chosen site; `rotated` when the footprint was turned (asked w x l, placed l x w). */
export interface Site extends Rect { rotated: boolean }

/** Inclusive corner coordinates, the way the yard is stored. */
export interface Area { x1: number; z1: number; x2: number; z2: number }

const name = (s: string | null | undefined) => (s ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
/** Nothing to clear: air and plants, which a build just replaces. */
const AIRY = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|pink_petals|wildflowers|bush|firefly_bush|dead_bush|snow|red_mushroom|brown_mushroom)$/;
/** The bot's furniture and fittings: a column holding one is taken even if the block isn't on the protected list. */
const FURNITURE = /^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|.*_bed|.*_door|.*_trapdoor|.*_fence|.*_fence_gate|.*_wall|torch|wall_torch|lantern|ladder|.*_pressure_plate|composter|.*_sign|.*_wall_sign)$/;
const FARM = /^(farmland|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_.*_stem|sugar_cane)$/;
const PATH = /^(dirt_path|gravel)$/;
/** Ground the world made, good to build on as it is. */
const NATURAL = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|sand|red_sand|clay|stone|deepslate|andesite|diorite|granite|tuff)$/;

/**
 * Classify every column of a region for building. `box` must include y = level (and preferably a few blocks above,
 * so trees and buildings on top are seen). A column is read from the top down: the first thing that isn't air or a
 * plant decides it. Protected blocks and furniture below the level are just ground (fill under a pillar).
 */
export function occupancy(box: Box, blocks: (string | null)[], level: number,
  isProtected: (p: Pos) => boolean = () => false): Grid {
  const { width: w, length: l, height: h } = box;
  const L = level - box.y;
  const cells: CellState[] = new Array(w * l).fill('uneven');
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    let state: CellState = 'uneven'; // nothing solid in the whole column: a pit
    for (let y = h - 1; y >= 0; y--) {
      const raw = blocks[x + z * w + y * w * l];
      if (raw === null || raw === undefined) { state = 'unknown'; break; }
      const n = name(raw);
      if (AIRY.test(n)) continue;
      const mine = isProtected({ x: box.x + x, y: box.y + y, z: box.z + z });
      if ((mine || FURNITURE.test(n)) && y >= L) { state = 'built'; break; }
      if (n === 'water') { state = 'water'; break; }
      if (FARM.test(n)) { state = 'farm'; break; }
      if (y !== L) { state = 'uneven'; break; }
      if (PATH.test(n)) { state = 'path'; break; }
      state = NATURAL.test(n) ? 'free' : 'uneven'; // a stray placed block at the level wants clearing first
      break;
    }
    cells[x + z * w] = state;
  }
  return { x: box.x, z: box.z, width: w, length: l, cells };
}

export interface SitePrefs {
  /** blocks kept between the site and anything built, farmed or wet (default 2) */
  clearance?: number;
  /** prefer the site whose centre is closest to this (absolute coordinates) */
  near?: { x: number; z: number };
  /** rectangles to keep clear of (planned buildings, farm extensions); the site and its clearance must not touch them */
  avoidRect?: Rect[];
}

/** 2D prefix sums of a predicate over the grid, so any rectangle can be counted in O(1). */
function prefix(grid: Grid, test: (s: CellState) => boolean) {
  const W = grid.width + 1;
  const s = new Int32Array(W * (grid.length + 1));
  for (let z = 0; z < grid.length; z++) for (let x = 0; x < grid.width; x++)
    s[(x + 1) + (z + 1) * W] = (test(grid.cells[x + z * grid.width]) ? 1 : 0) + s[x + (z + 1) * W] + s[(x + 1) + z * W] - s[x + z * W];
  /** count over the local rectangle [x0, x1) x [z0, z1), clipped to the grid */
  return (x0: number, z0: number, x1: number, z1: number) => {
    x0 = Math.max(0, x0); z0 = Math.max(0, z0); x1 = Math.min(grid.width, x1); z1 = Math.min(grid.length, z1);
    if (x1 <= x0 || z1 <= z0) return 0;
    return s[x1 + z1 * W] - s[x0 + z1 * W] - s[x1 + z0 * W] + s[x0 + z0 * W];
  };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.z < b.z + b.length && b.z < a.z + a.length;

/**
 * The best place in the grid for a w x l footprint (either way round): every cell 'free', nothing built, farmed or wet
 * within `clearance` of it (paths and unknown cells around it are fine; cells outside the grid aren't checked), and
 * clear of `avoidRect`. Best = centre closest to `near`; ties (or no `near`) go to the site with fewer 'uneven' cells
 * right around it, since those are what leveling has to fix next to the walls. Null when nothing fits.
 */
export function findSite(grid: Grid, w: number, l: number, prefs: SitePrefs = {}): Site | null {
  const c = prefs.clearance ?? 2;
  const notFree = prefix(grid, s => s !== 'free');
  const blocking = prefix(grid, s => s === 'built' || s === 'farm' || s === 'water');
  const uneven = prefix(grid, s => s === 'uneven');
  const shapes: [number, number, boolean][] = [[w, l, false]];
  if (w !== l) shapes.push([l, w, true]);
  let best: { site: Site; dist: number; rough: number } | null = null;
  for (const [sw, sl, rotated] of shapes) {
    for (let z = 0; z + sl <= grid.length; z++) for (let x = 0; x + sw <= grid.width; x++) {
      if (notFree(x, z, x + sw, z + sl)) continue;
      if (blocking(x - c, z - c, x + sw + c, z + sl + c)) continue;
      const site: Site = { x: grid.x + x, z: grid.z + z, width: sw, length: sl, rotated };
      const padded = { x: site.x - c, z: site.z - c, width: sw + 2 * c, length: sl + 2 * c };
      if (prefs.avoidRect?.some(r => overlaps(padded, r))) continue;
      const dist = prefs.near ? Math.hypot(site.x + sw / 2 - prefs.near.x, site.z + sl / 2 - prefs.near.z) : 0;
      const rough = uneven(x - 1, z - 1, x + sw + 1, z + sl + 1);
      if (!best || dist < best.dist - 1e-9 || (Math.abs(dist - best.dist) <= 1e-9 && rough < best.rough))
        best = { site, dist, rough };
    }
  }
  return best?.site ?? null;
}

export type Side = 'north' | 'south' | 'west' | 'east';

export interface GrowOptions {
  /** blocks kept around the footprint inside the new strip (default 2) */
  clearance?: number;
  /** the yard grows in whole tiles of this many blocks (default 8) */
  tile?: number;
  /** water at (x, z): a strip over water is out (the yard would fill the pond) */
  isWater: (x: number, z: number) => boolean;
  /** never grow over these (the lake, a neighbour's land) */
  forbid?: (x: number, z: number) => boolean;
  /** ground height at (x, z), null if unknown; with `level`, counts the cells leveling would have to fix */
  heightAt?: (x: number, z: number) => number | null;
  level?: number;
}

export interface Growth {
  side: Side;
  /** the new strip alone, inclusive corners */
  strip: Area;
  /** the yard with the strip added */
  newYard: Area;
  /** the footprint turned to fit along this side */
  rotated: boolean;
  /** strip cells whose ground isn't at the level (unknown height counts) */
  uneven: number;
  /** total height difference over the strip, to break ties */
  dig: number;
}

/**
 * When no site fits, grow the yard by a strip along one side, as shallow as whole tiles allow while still holding the
 * footprint plus clearance on both sides (so the building keeps its distance from the old yard edge and the new one).
 * The strip spans the whole side, so the yard stays a rectangle. Sides with water or forbidden cells are out; of the
 * rest, the one with the fewest uneven cells wins (then the least digging, then the shallowest strip). Null if no side
 * works.
 */
export function growYard(yard: Area, footprint: { width: number; length: number }, opts: GrowOptions): Growth | null {
  const c = opts.clearance ?? 2;
  const tile = opts.tile ?? 8;
  const forbid = opts.forbid ?? (() => false);
  const spanX = yard.x2 - yard.x1 + 1, spanZ = yard.z2 - yard.z1 + 1;
  let best: Growth | null = null;
  let bestDepth = Infinity;
  for (const side of ['north', 'south', 'west', 'east'] as Side[]) {
    const alongX = side === 'north' || side === 'south'; // the strip runs along x
    const span = alongX ? spanX : spanZ;
    const turns: [number, number, boolean][] = [[footprint.width, footprint.length, false]];
    if (footprint.width !== footprint.length) turns.push([footprint.length, footprint.width, true]);
    for (const [fw, fl, rotated] of turns) {
      const across = alongX ? fw : fl, outward = alongX ? fl : fw;
      if (across + 2 * c > span) continue;
      const depth = Math.ceil((outward + 2 * c) / tile) * tile;
      const strip: Area = side === 'north' ? { x1: yard.x1, x2: yard.x2, z1: yard.z1 - depth, z2: yard.z1 - 1 }
        : side === 'south' ? { x1: yard.x1, x2: yard.x2, z1: yard.z2 + 1, z2: yard.z2 + depth }
          : side === 'west' ? { x1: yard.x1 - depth, x2: yard.x1 - 1, z1: yard.z1, z2: yard.z2 }
            : { x1: yard.x2 + 1, x2: yard.x2 + depth, z1: yard.z1, z2: yard.z2 };
      let ok = true, uneven = 0, dig = 0;
      for (let z = strip.z1; ok && z <= strip.z2; z++) for (let x = strip.x1; x <= strip.x2; x++) {
        if (opts.isWater(x, z) || forbid(x, z)) { ok = false; break; }
        if (opts.heightAt && opts.level !== undefined) {
          const hgt = opts.heightAt(x, z);
          if (hgt === null) uneven++;
          else if (hgt !== opts.level) { uneven++; dig += Math.abs(hgt - opts.level); }
        }
      }
      if (!ok) continue;
      if (!best || uneven < best.uneven || (uneven === best.uneven && (dig < best.dig || (dig === best.dig && depth < bestDepth)))) {
        best = {
          side, strip, rotated, uneven, dig,
          newYard: { x1: Math.min(yard.x1, strip.x1), z1: Math.min(yard.z1, strip.z1), x2: Math.max(yard.x2, strip.x2), z2: Math.max(yard.z2, strip.z2) },
        };
        bestDepth = depth;
      }
    }
  }
  return best;
}
