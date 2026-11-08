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
  /** what is cut, by kind: logs, ground (dirt, stone...), plants and other */
  cutKinds: Record<string, number>;
  /** natural leaves left to decay by themselves once the trunks are gone (cutting them one by one took most of the time) */
  leaves: number;
  kept: { water: number; built: number };
  /** the kinds of block it cuts ("grass_block", "oak_log"): all Baritone may break doing it, the bot's own walls stay */
  cutNames: string[];
}

const name = (s: string | null | undefined) => (s ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const AIR = /^(air|cave_air|void_air)$/;
/** Not ground: plants, snow layers, trees, torches (a torch goes with the block it stands on). */
const NOT_GROUND = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|pink_petals|wildflowers|bush|firefly_bush|dead_bush|sweet_berry_bush|snow|torch|wall_torch|red_mushroom|brown_mushroom|vine|.*_log|.*_leaves|.*_sapling)$/;
/** Columns to leave whole: water, crops and farmland, furniture and doors. */
const KEEP = /^(water|farmland|wheat|carrots|potatoes|beetroots|crafting_table|furnace|chest|barrel|.*_bed|.*_door|.*_pressure_plate|.*_trapdoor|ladder)$/;

export function planLevel(box: Box, blocks: (string | null)[], level: number, isProtected: (p: Pos) => boolean = () => false, cutLeaves = false,
  fillWater = false): LevelPlan {
  const { width: w, length: l, height: h } = box;
  const at = (x: number, y: number, z: number) => name(blocks[x + z * w + y * w * l]);
  const raw = (x: number, y: number, z: number) => blocks[x + z * w + y * w * l] ?? '';
  const cutKinds: Record<string, number> = {};
  const cutNames = new Set<string>();
  let leaves = 0;
  const L = level - box.y; // the level as a layer index
  const ground: number[] = new Array(w * l).fill(-1);
  const skip: boolean[] = new Array(w * l).fill(false);
  let water = 0, built = 0;
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const c = x + z * w;
    // from the top down to the ground: a build, crop or furniture at or above the level, or open water at any depth,
    // keeps the whole column; below the level they are just ground (a protected fill under a scaffold pillar, water
    // buried under a hill: skipping those left the pillar and the hill standing)
    for (let y = h - 1; y >= 0; y--) {
      const n = at(x, y, z);
      if (AIR.test(n)) continue;
      // water reached from above, before any ground, is open water (a pond, however far below the level): keep it.
      // Water with ground over it never gets here (the scan stops at the ground). Filling "low" water buried the
      // fishing pond under a dirt lid.
      // fillWater: water is just a hole to fill, down to the ground under it
      if (n === 'water') { if (fillWater) continue; skip[c] = true; water++; break; }
      if (KEEP.test(n) || (isProtected({ x: box.x + x, y: box.y + y, z: box.z + z }) && !/torch$/.test(n))) {
        if (y >= L) { skip[c] = true; built++; break; }
        ground[c] = y; // below the level: it is the ground
        break;
      }
      if (!NOT_GROUND.test(n)) { ground[c] = y; break; }
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
        if (AIR.test(n)) continue;
        if (/_leaves$/.test(n) && !/persistent=true/.test(raw(x, y, z)) && !cutLeaves) { leaves++; continue; }
        // plants pop off with the block under them, or get tilled away: cutting them one by one only costs time
        if (NOT_GROUND.test(n) && !/_log$|_leaves$/.test(n)) continue; // (leaves reach here only when cutting them)
        cell[i] = '.'; cut++; lo = Math.min(lo, y); hi = Math.max(hi, y);
        cutNames.add(n);
        const kind = /_log$|_wood$/.test(n) ? 'logs' : /_leaves$/.test(n) ? 'leaves' : NOT_GROUND.test(n) ? 'plants' : 'ground';
        cutKinds[kind] = (cutKinds[kind] ?? 0) + 1;
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
  if (lo === Infinity) return { origin: { x: box.x, y: level, z: box.z }, spec: null, cut, dirt, cobblestone, cutKinds, leaves, kept: { water, built }, cutNames: [...cutNames] };
  const layers: string[][] = [];
  for (let y = lo; y <= hi; y++) {
    const rows: string[] = [];
    for (let z = 0; z < l; z++) rows.push(cell.slice(y * w * l + z * w, y * w * l + z * w + w).join(''));
    layers.push(rows);
  }
  return {
    origin: { x: box.x, y: box.y + lo, z: box.z },
    spec: { palette: { C: 'cobblestone', D: 'dirt' }, layers },
    cut, dirt, cobblestone, cutKinds, leaves, kept: { water, built }, cutNames: [...cutNames]
  };
}
