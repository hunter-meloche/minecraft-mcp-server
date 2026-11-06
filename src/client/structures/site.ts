/**
 * Where to put a structure: every anchor in a scanned area where its footprint fits, scored by the work the ground
 * needs (blocks to cut down to the floor and to fill up to it), trees in the way and the distance from where it's
 * wanted; nothing over water or anything built, and in or out of the yard as asked. The LLM picks from the best
 * few (with the user's wishes), so this ranks rather than decides.
 */

export interface Area { x: number; y: number; z: number; width: number; height: number; length: number }
export interface Candidate {
  anchor: { x: number; y: number; z: number };
  rotation: 0 | 90 | 180 | 270;
  width: number;
  length: number;
  /** blocks above the floor to cut, and holes below it to fill */
  cut: number;
  fill: number;
  trees: number;
  distance: number;
  score: number;
}
export interface SiteOptions {
  /** where it's wanted (default: the area's middle) */
  near?: { x: number; z: number };
  /** the yard (x1..x2, z1..z2) and whether the site must be inside it, outside it, or either */
  yard?: { x1: number; z1: number; x2: number; z2: number };
  where?: 'inside' | 'outside' | 'any';
  /** footprints to keep clear of (other structures, zones), with this many blocks between */
  avoid?: { x: number; z: number; width: number; length: number }[];
  clearance?: number;
  count?: number;
}

const name = (s: string | null | undefined) => (s ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');
const AIRY = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|snow|vine|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|pink_petals|wildflowers|sweet_berry_bush|.*_sapling|torch|wall_torch)$/;
const TREE = /_(log|leaves|wood)$|^(mangrove_roots|bee_nest)$/;
const NATURAL = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|sand|red_sand|gravel|stone|deepslate|granite|diorite|andesite|tuff|calcite|sandstone|red_sandstone|terracotta|snow_block|moss_block|farmland|dirt_path)$/;

export type Column = { kind: 'ground' | 'water' | 'tree' | 'built' | 'unknown'; height: number; trees: number };

/** What tops each column of an area (x fastest, then z, then y): its ground height, or water, a tree, something built. */
export function columns(area: Area, blocks: (string | null)[]): Column[] {
  const { width: w, length: l, height: h } = area;
  const out: Column[] = [];
  for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    let col: Column = { kind: 'unknown', height: area.y, trees: 0 };
    let trees = 0;
    for (let y = h - 1; y >= 0; y--) {
      const raw = blocks[x + z * w + y * w * l];
      if (raw === null || raw === undefined) { col = { kind: 'unknown', height: area.y + y, trees }; break; }
      const n = name(raw);
      if (AIRY.test(n)) continue;
      if (TREE.test(n)) { trees++; continue; }
      if (n === 'water' || n === 'lava' || n === 'ice') { col = { kind: 'water', height: area.y + y, trees }; break; }
      col = { kind: NATURAL.test(n) ? 'ground' : 'built', height: area.y + y, trees };
      break;
    }
    out.push(col);
  }
  return out;
}

/**
 * The best anchors for a footprint of `width` x `length` (at rotation 0; turned ones are tried too when the sides
 * differ). The anchor's y is the floor: the ground's most common height under it, plus one (the design's bottom layer
 * stands on the ground; level it first to sink it in).
 */
export function rankSites(area: Area, blocks: (string | null)[], width: number, length: number, opts: SiteOptions = {}): Candidate[] {
  const cols = columns(area, blocks);
  const near = opts.near ?? { x: area.x + Math.floor(area.width / 2), z: area.z + Math.floor(area.length / 2) };
  const c = opts.clearance ?? 1;
  const where = opts.where ?? 'any';
  const yard = opts.yard;
  const inYard = (x: number, z: number) => !!yard && x >= yard.x1 && x <= yard.x2 && z >= yard.z1 && z <= yard.z2;
  const shapes: [number, number, 0 | 90][] = [[width, length, 0]];
  if (width !== length) shapes.push([length, width, 90]);
  const found: Candidate[] = [];
  for (const [sw, sl, rotation] of shapes) {
    for (let oz = 0; oz + sl <= area.length; oz++) for (let ox = 0; ox + sw <= area.width; ox++) {
      const ax = area.x + ox, az = area.z + oz;
      if (where !== 'any') {
        const corners = [[ax, az], [ax + sw - 1, az], [ax, az + sl - 1], [ax + sw - 1, az + sl - 1]].map(([x, z]) => inYard(x, z));
        if (where === 'inside' && !corners.every(Boolean)) continue;
        if (where === 'outside' && corners.some(Boolean)) continue;
      }
      if (opts.avoid?.some(r => ax - c < r.x + r.width && r.x < ax + sw + c && az - c < r.z + r.length && r.z < az + sl + c)) continue;
      const heights: number[] = [];
      let trees = 0, bad = false;
      for (let z = oz; z < oz + sl && !bad; z++) for (let x = ox; x < ox + sw; x++) {
        const col = cols[x + z * area.width];
        if (col.kind !== 'ground' && col.kind !== 'tree') { bad = true; break; }
        heights.push(col.height);
        trees += col.trees;
      }
      if (bad) continue;
      const counts = new Map<number, number>();
      for (const hgt of heights) counts.set(hgt, (counts.get(hgt) ?? 0) + 1);
      const ground = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      let cut = 0, fill = 0;
      for (const hgt of heights) { if (hgt > ground) cut += hgt - ground; else fill += ground - hgt; }
      const distance = Math.round(Math.hypot(ax + sw / 2 - near.x, az + sl / 2 - near.z));
      const score = cut + fill + trees * 4 + distance * 0.5;
      found.push({ anchor: { x: ax, y: ground + 1, z: az }, rotation, width: sw, length: sl, cut, fill, trees, distance, score: Math.round(score * 10) / 10 });
    }
  }
  // the best few that don't overlap each other
  found.sort((a, b) => a.score - b.score);
  const out: Candidate[] = [];
  for (const f of found) {
    if (out.length >= (opts.count ?? 5)) break;
    if (out.some(o => f.anchor.x < o.anchor.x + o.width && o.anchor.x < f.anchor.x + f.width && f.anchor.z < o.anchor.z + o.length && o.anchor.z < f.anchor.z + f.length)) continue;
    out.push(f);
  }
  return out;
}

/** A map of the area, one character per column ('.' ground at the median height, 1-9 higher, a-i lower, T tree,
 * ~ water, B built), with candidates 1..n drawn as their numbers' outlines. */
export function siteMap(area: Area, blocks: (string | null)[], picks: Candidate[]): string[] {
  const cols = columns(area, blocks);
  const hs = cols.filter(c => c.kind === 'ground').map(c => c.height).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)] ?? area.y;
  const rows: string[][] = [];
  for (let z = 0; z < area.length; z++) {
    const row: string[] = [];
    for (let x = 0; x < area.width; x++) {
      const c = cols[x + z * area.width];
      const d = c.height - median;
      row.push(c.kind === 'water' ? '~' : c.kind === 'built' ? 'B' : c.kind === 'unknown' ? '?' : c.trees ? 'T'
        : d === 0 ? '.' : d > 0 ? String(Math.min(9, d)) : 'abcdefghi'[Math.min(8, -d - 1)]);
    }
    rows.push(row);
  }
  picks.forEach((p, i) => {
    const mark = String(i + 1);
    for (let z = p.anchor.z; z < p.anchor.z + p.length; z++) for (let x = p.anchor.x; x < p.anchor.x + p.width; x++) {
      const edge = z === p.anchor.z || z === p.anchor.z + p.length - 1 || x === p.anchor.x || x === p.anchor.x + p.width - 1;
      const rz = z - area.z, rx = x - area.x;
      if (edge && rows[rz]?.[rx] !== undefined) rows[rz][rx] = mark;
    }
  });
  return rows.map(r => r.join(''));
}
