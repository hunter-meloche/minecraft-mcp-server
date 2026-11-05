/**
 * Keep the yard lit so monsters don't spawn in it. Since 1.18 hostile mobs spawn only where block light is 0 (sky
 * light only matters at night, and the yard has to be safe at night, so it is ignored), so a torch on the ground is
 * all it takes. Pure: works on a region grid (x fastest, then z, then y) with its block light, as the bridge returns
 * them; the plan uses a simple light model and the caller re-reads the real light after placing.
 */

import type { Box, Pos } from '../survey.js';

export interface TorchPlan {
  /** cells to put a torch in (standing on the block below), in the order chosen */
  torches: Pos[];
  /** spawnable cells before the plan */
  dark: number;
  /** spawnable cells the plan leaves dark (out of reach of any torch spot, or over the max) */
  remaining: number;
}

const name = (s: string | null | undefined) => (s ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
/** No collision: a mob can stand in it (snow here is the thin layer, which mobs spawn through). */
const AIRY = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|blue_orchid|pink_petals|wildflowers|bush|firefly_bush|dead_bush|snow|red_mushroom|brown_mushroom)$/;
/** What a torch can go into: placing into a flower or a mushroom fails, these get replaced. */
const REPLACEABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|leaf_litter|snow)$/;
/**
 * A full solid top monsters spawn on. Conservative on purpose: leaves, glass, ice, slabs, stairs, farmland and paths
 * are left out (no spawns there, or only some mobs, or only some states), so a doubtful block never costs a torch.
 */
const SOLID = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|moss_block|mud|packed_mud|clay|sand|red_sand|gravel|stone|smooth_stone|(polished_)?(granite|diorite|andesite|deepslate|tuff|basalt|blackstone)|cobblestone|mossy_cobblestone|cobbled_deepslate|calcite|dripstone_block|netherrack|end_stone|obsidian|(chiseled_|cut_|smooth_)?(red_)?sandstone|.*_planks|(stripped_)?.*_(log|wood|stem|hyphae)|(.*_)?terracotta|.*_concrete|.*_wool|(.*_)?bricks|.*_tiles|.*_ore|(coal|iron|gold|diamond|emerald|lapis|redstone|snow|hay|bone)_block|bookshelf)$/;
/** Never a full top, whatever the regex above matches by its suffix. */
const PARTIAL = /_(slab|stairs|wall|fence|fence_gate|carpet|pressure_plate|button|trapdoor|door|sign|hanging_sign|banner)$/;
const TORCH = /^(torch|wall_torch|soul_torch|soul_wall_torch)$/;
/** A torch gives 14 at its cell; with 1 lost per block it lights everything within this taxicab distance. */
const REACH = 13;

/** The box around home that the yard checks look at. */
export function yardBox(home: Pos, radius: number, below = 4, above = 8): Box {
  const x = Math.floor(home.x), y = Math.floor(home.y), z = Math.floor(home.z);
  return { x: x - radius, y: y - below, z: z - radius, width: 2 * radius + 1, height: below + above + 1, length: 2 * radius + 1 };
}

/**
 * Indices of cells standing on a solid top: replaceable-only for torch spots, two air-like cells for spawns (a zombie
 * needs headroom). Cells whose neighbours lie outside the box or are unloaded are skipped: unknown is not a spawn.
 */
function grounds(box: Box, blocks: (string | null)[], mask: ((p: Pos) => boolean) | undefined, forTorch: boolean): number[] {
  const { width: w, length: l, height: h } = box;
  const layer = w * l;
  const out: number[] = [];
  for (let y = 1; y < h; y++) for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const i = x + z * w + y * layer;
    const here = blocks[i], under = blocks[i - layer];
    if (here == null || under == null) continue;
    if (!(forTorch ? REPLACEABLE : AIRY).test(name(here))) continue;
    const u = name(under);
    if (!SOLID.test(u) || PARTIAL.test(u)) continue;
    if (!forTorch) {
      if (y + 1 >= h) continue;
      const above = blocks[i + layer];
      if (above == null || !AIRY.test(name(above))) continue;
    }
    if (mask && !mask({ x: box.x + x, y: box.y + y, z: box.z + z })) continue;
    out.push(i);
  }
  return out;
}

/** Cells (where a mob would stand) a hostile mob can spawn in: two air-like cells on a solid top, block light 0. */
export function spawnableCells(box: Box, blocks: (string | null)[], light: number[], opts: { mask?: (p: Pos) => boolean } = {}): Pos[] {
  const { width: w, length: l } = box;
  return grounds(box, blocks, opts.mask, false).filter(i => light[i] === 0).map(i => ({
    x: box.x + (i % w), y: box.y + Math.floor(i / (w * l)), z: box.z + (Math.floor(i / w) % l)
  }));
}

/**
 * Greedy torch spots (set cover: each pick lights the most still-dark cells) until no spawnable cell is dark. Torches
 * go on the ground cells themselves, so a torch also fills a spawn spot. The light model ignores walls and the
 * existing light only counts where it already keeps a cell lit, which is enough since it is re-read after placing.
 */
export function planTorches(box: Box, blocks: (string | null)[], light: number[],
  opts: { mask?: (p: Pos) => boolean; prefer?: Pos; max?: number } = {}): TorchPlan {
  const { width: w, length: l } = box;
  const layer = w * l;
  const max = opts.max ?? 32;
  const darkIdx = grounds(box, blocks, opts.mask, false).filter(i => light[i] === 0);
  const cand = grounds(box, blocks, opts.mask, true);
  const D = darkIdx.length, C = cand.length;
  const coords = (idx: number[]) => {
    const xs = new Int32Array(idx.length), ys = new Int32Array(idx.length), zs = new Int32Array(idx.length);
    idx.forEach((i, k) => { xs[k] = i % w; ys[k] = Math.floor(i / layer); zs[k] = Math.floor(i / w) % l; });
    return { xs, ys, zs };
  };
  const d = coords(darkIdx), c = coords(cand);
  const reaches = (a: number, b: number) => Math.abs(c.xs[a] - d.xs[b]) + Math.abs(c.ys[a] - d.ys[b]) + Math.abs(c.zs[a] - d.zs[b]) <= REACH;

  // gain[a]: still-dark cells candidate a would light; kept current by decrementing as cells get lit
  const gain = new Int32Array(C);
  for (let a = 0; a < C; a++) for (let b = 0; b < D; b++) if (reaches(a, b)) gain[a]++;
  // a torch right next to another wastes light: prefer spots away from existing and planned torches
  const crowded = new Uint8Array(C);
  const crowd = (x: number, y: number, z: number) => {
    for (let a = 0; a < C; a++) if (Math.abs(c.xs[a] - x) <= 1 && Math.abs(c.ys[a] - y) <= 1 && Math.abs(c.zs[a] - z) <= 1) crowded[a] = 1;
  };
  blocks.forEach((b, i) => { if (b != null && TORCH.test(name(b))) crowd(i % w, Math.floor(i / layer), Math.floor(i / w) % l); });
  const preferDist = new Float64Array(C);
  if (opts.prefer) {
    const p = opts.prefer;
    for (let a = 0; a < C; a++) preferDist[a] = Math.abs(box.x + c.xs[a] - p.x) + Math.abs(box.y + c.ys[a] - p.y) + Math.abs(box.z + c.zs[a] - p.z);
  }

  const lit = new Uint8Array(D);
  const used = new Uint8Array(C);
  let left = D;
  const picked: number[] = [];
  while (left > 0 && picked.length < max) {
    let best = -1;
    for (let a = 0; a < C; a++) {
      if (used[a] || gain[a] === 0) continue;
      if (best < 0 || gain[a] > gain[best]
        || (gain[a] === gain[best] && (crowded[a] < crowded[best]
          || (crowded[a] === crowded[best] && preferDist[a] < preferDist[best])))) best = a;
    }
    if (best < 0) break; // the rest is out of reach of every torch spot
    used[best] = 1;
    picked.push(best);
    crowd(c.xs[best], c.ys[best], c.zs[best]);
    for (let b = 0; b < D; b++) {
      if (lit[b] || !reaches(best, b)) continue;
      lit[b] = 1; left--;
      for (let a = 0; a < C; a++) if (reaches(a, b)) gain[a]--;
    }
  }
  // greedy's first picks are big and the later ones fill gaps around them, which can leave an early pick with
  // nothing of its own: drop torches whose every cell another torch also lights
  const lights = new Int32Array(D);
  for (const a of picked) for (let b = 0; b < D; b++) if (reaches(a, b)) lights[b]++;
  const keep = picked.filter(a => {
    for (let b = 0; b < D; b++) if (lights[b] === 1 && reaches(a, b)) return true;
    for (let b = 0; b < D; b++) if (reaches(a, b)) lights[b]--;
    return false;
  });
  const torches = keep.map(a => ({ x: box.x + c.xs[a], y: box.y + c.ys[a], z: box.z + c.zs[a] }));
  return { torches, dark: D, remaining: left };
}
