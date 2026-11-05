/**
 * Survey an area from a block grid: surface heights, trees, blocks that look placed (scaffolding, emergency
 * shelters, leftovers) rather than natural, and open pits. Pure functions over a region (x fastest, then z, then y),
 * as world.region returns it.
 */

export interface Box { x: number; y: number; z: number; width: number; height: number; length: number }
export interface Pos { x: number; y: number; z: number }
export interface Cluster { min: Pos; max: Pos; blocks: number; kinds: Record<string, number> }
export interface Pit { x: number; z: number; surface: number; around: number }
export interface Survey {
  surface: { min: number; max: number; median: number };
  trees: number; // columns topped by logs or leaves
  water: number; // columns topped by water
  placed: Cluster[];
  pits: Pit[];
  /** one row per z (north to south), one character per x: what tops each column */
  map: string[];
}

const name = (state: string | null | undefined) => (state ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const AIRY = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|leaf_litter|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|pink_petals|wildflowers|bush|firefly_bush|dead_bush|sweet_berry_bush|snow|torch|wall_torch|red_mushroom|brown_mushroom)$/;
/** Blocks the world doesn't put on the surface by itself: what Baritone scaffolds with and emergency walls are made of. */
const PLACED = /^(cobblestone|cobbled_deepslate|.*_planks|glass|stone_bricks|netherrack|cobblestone_slab|.*_planks_slab)$/;
/** The bot's furniture and farm: never leftovers. */
const KEEP = /^(crafting_table|furnace|chest|barrel|.*_bed|.*_door|.*_pressure_plate|farmland|wheat|carrots|potatoes|beetroots|water|torch|wall_torch|.*_trapdoor|ladder)$/;

export function survey(box: Box, blocks: (string | null)[], isProtected: (p: Pos) => boolean = () => false): Survey {
  const { width: w, length: l, height: h } = box;
  const at = (x: number, y: number, z: number) => (x < 0 || z < 0 || y < 0 || x >= w || z >= l || y >= h ? 'air' : name(blocks[x + z * w + y * w * l]));
  // surface: the highest non-airy, non-tree, non-placed block in each column (natural ground)
  const ground: number[] = new Array(w * l).fill(-1);
  let trees = 0, water = 0;
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    let top = true;
    for (let y = h - 1; y >= 0; y--) {
      const n = at(x, y, z);
      if (AIRY.test(n)) continue;
      if (top) { if (/_log$|_leaves$/.test(n)) trees++; if (n === 'water') water++; top = false; }
      if (/_log$|_leaves$/.test(n) || PLACED.test(n) || KEEP.test(n) || isProtected({ x: box.x + x, y: box.y + y, z: box.z + z })) continue;
      ground[x + z * w] = y;
      break;
    }
  }
  const known = ground.filter(g => g >= 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 0;

  // placed-looking blocks: scaffolding materials anywhere above the ground minus 3, and dirt that floats or stands as a pillar
  const flagged = new Set<number>();
  for (let y = 0; y < h; y++) for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const n = at(x, y, z);
    if (!n || AIRY.test(n) || KEEP.test(n)) continue;
    const g = ground[x + z * w];
    const p = { x: box.x + x, y: box.y + y, z: box.z + z };
    if (isProtected(p)) continue;
    let hit = PLACED.test(n) && y >= Math.min(g, median) - 3;
    if (!hit && /^(dirt|coarse_dirt)$/.test(n) && y > Math.max(g, median) - 1) {
      const sides = [at(x + 1, y, z), at(x - 1, y, z), at(x, y, z + 1), at(x, y, z - 1)].filter(s => AIRY.test(s)).length;
      hit = AIRY.test(at(x, y - 1, z)) || sides >= 3;
    }
    if (hit) flagged.add(x + z * w + y * w * l);
  }
  // group into clusters (touching, including diagonals)
  const placed: Cluster[] = [];
  const seen = new Set<number>();
  for (const start of flagged) {
    if (seen.has(start)) continue;
    const c: Cluster = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity }, blocks: 0, kinds: {} };
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, z = Math.floor(i / w) % l, y = Math.floor(i / (w * l));
      const wx = box.x + x, wy = box.y + y, wz = box.z + z;
      c.blocks++;
      const n = at(x, y, z);
      c.kinds[n] = (c.kinds[n] ?? 0) + 1;
      c.min = { x: Math.min(c.min.x, wx), y: Math.min(c.min.y, wy), z: Math.min(c.min.z, wz) };
      c.max = { x: Math.max(c.max.x, wx), y: Math.max(c.max.y, wy), z: Math.max(c.max.z, wz) };
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || nz < 0 || ny < 0 || nx >= w || nz >= l || ny >= h) continue;
        const j = nx + nz * w + ny * w * l;
        if (flagged.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
      }
    }
    placed.push(c);
  }
  placed.sort((a, b) => b.blocks - a.blocks);

  // pits: columns open to the sky whose ground is 3+ below the median of their 5x5 neighbourhood
  const pits: Pit[] = [];
  for (let z = 2; z < l - 2; z++) for (let x = 2; x < w - 2; x++) {
    const g = ground[x + z * w];
    if (g < 0) continue;
    const around: number[] = [];
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const n = ground[x + dx + (z + dz) * w];
      if ((dx || dz) && n >= 0) around.push(n);
    }
    around.sort((a, b) => a - b);
    const m = around[Math.floor(around.length / 2)] ?? g;
    let open = true;
    for (let y = g + 1; y < h && open; y++) if (!AIRY.test(at(x, y, z))) open = false;
    if (open && m - g >= 3) pits.push({ x: box.x + x, z: box.z + z, surface: box.y + g, around: box.y + m });
  }
  // the map: T tree, ~ water, B the bot's builds and furniture, x placed-looking, else the ground height against the
  // median: 0 level, 1..9 higher, a..i lower (a = 1 below)
  const flaggedCols = new Set([...flagged].map(i => i % (w * l)));
  const map: string[] = [];
  for (let z = 0; z < l; z++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      let top = '';
      let ty = -1;
      for (let y = h - 1; y >= 0 && !top; y--) { const n = at(x, y, z); if (!AIRY.test(n)) { top = n; ty = y; } }
      const prot = ty >= 0 && isProtected({ x: box.x + x, y: box.y + ty, z: box.z + z });
      const g = ground[x + z * w];
      if (/_log$|_leaves$/.test(top)) row += 'T';
      else if (top === 'water') row += '~';
      else if (prot || KEEP.test(top)) row += 'B';
      else if (flaggedCols.has(x + z * w)) row += 'x';
      else if (g < 0) row += '?';
      else { const d = g - median; row += d === 0 ? '0' : d > 0 ? String(Math.min(9, d)) : String.fromCharCode(96 + Math.min(9, -d)); }
    }
    map.push(row);
  }
  return { surface: { min: box.y + (known[0] ?? 0), max: box.y + (known.at(-1) ?? 0), median: box.y + median }, trees, water, placed, pits, map };
}
