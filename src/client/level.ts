/**
 * Plan leveling an area to a ground height: cut everything above it, fill below it (cobblestone, dirt on top),
 * leaving whole columns alone where there is water, a crop, furniture, or a block the bot built. Pure: works on a
 * region grid (x fastest, then z, then y) as world.region returns it, and produces a build-structure spec.
 */

import type { Box, Pos } from './survey.js';

export interface LevelPlan {
  origin: Pos;
  spec: { palette: Record<string, string>; layers: string[][] } | null;
  cut: number; dirt: number; cobblestone: number;
  kept: { water: number; built: number };
}

const name = (s: string | null | undefined) => (s ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const AIR = /^(air|cave_air|void_air)$/;
/** Not ground: plants, snow layers, trees, torches (a torch goes with the block it stands on). */
const NOT_GROUND = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|pink_petals|wildflowers|bush|firefly_bush|dead_bush|sweet_berry_bush|snow|torch|wall_torch|red_mushroom|brown_mushroom|vine|.*_log|.*_leaves|.*_sapling)$/;
/** Columns to leave whole: water, crops and farmland, furniture and doors. */
const KEEP = /^(water|farmland|wheat|carrots|potatoes|beetroots|crafting_table|furnace|chest|barrel|.*_bed|.*_door|.*_pressure_plate|.*_trapdoor|ladder)$/;

export function planLevel(box: Box, blocks: (string | null)[], level: number, isProtected: (p: Pos) => boolean = () => false): LevelPlan {
  const { width: w, length: l, height: h } = box;
  const at = (x: number, y: number, z: number) => name(blocks[x + z * w + y * w * l]);
  const L = level - box.y; // the level as a layer index
  const ground: number[] = new Array(w * l).fill(-1);
  const skip: boolean[] = new Array(w * l).fill(false);
  let water = 0, built = 0;
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const c = x + z * w;
    for (let y = h - 1; y >= 0; y--) {
      const n = at(x, y, z);
      if (AIR.test(n)) continue;
      if (KEEP.test(n) || (isProtected({ x: box.x + x, y: box.y + y, z: box.z + z }) && !/torch$/.test(n))) {
        skip[c] = true;
        if (n === 'water') water++; else built++;
        break;
      }
      if (ground[c] < 0 && !NOT_GROUND.test(n)) ground[c] = y;
    }
  }
  let cut = 0, dirt = 0, cobblestone = 0;
  let lo = Infinity, hi = -Infinity;
  const cell: string[] = new Array(w * l * h).fill(' ');
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const c = x + z * w;
    if (skip[c]) continue;
    const g = ground[c];
    for (let y = 0; y < h; y++) {
      const i = c + y * w * l;
      const n = at(x, y, z);
      if (y > L) {
        if (!AIR.test(n)) { cell[i] = '.'; cut++; lo = Math.min(lo, y); hi = Math.max(hi, y); }
      } else if (g >= 0 && y > g) {
        cell[i] = y === L ? 'D' : 'C';
        if (y === L) dirt++; else cobblestone++;
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      } else if (g < 0 && y === L) {
        // no ground in the box (a deep hole): fill just the top, like a lid
        cell[i] = 'D'; dirt++; lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
    }
  }
  if (lo === Infinity) return { origin: { x: box.x, y: level, z: box.z }, spec: null, cut, dirt, cobblestone, kept: { water, built } };
  const layers: string[][] = [];
  for (let y = lo; y <= hi; y++) {
    const rows: string[] = [];
    for (let z = 0; z < l; z++) rows.push(cell.slice(y * w * l + z * w, y * w * l + z * w + w).join(''));
    layers.push(rows);
  }
  return {
    origin: { x: box.x, y: box.y + lo, z: box.z },
    spec: { palette: { C: 'cobblestone', D: 'dirt' }, layers },
    cut, dirt, cobblestone, kept: { water, built }
  };
}
