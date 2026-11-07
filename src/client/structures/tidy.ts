import type { Compiled } from './format.js';

/**
 * Tidying up after a build job: the blocks Baritone scaffolds with (cobblestone and the stone kinds, the bot's
 * acceptableThrowawayItems) that turn up round the site while the job works, and that the design doesn't place, are
 * dug out. The build tool clears its own scaffold, but only when a package ends normally: one stopped for the pens,
 * the evening or a short block leaves its pillars, and cells the design doesn't manage keep them for good (cobblestone
 * on three home chests' lids, so the kit couldn't open them).
 *
 * What counts as new is judged against a baseline: the throwaway blocks round the site when the job started (natural
 * andesite, the workshop's own cobblestone floor), which are left alone.
 */

export type Box = Compiled['box'];
type P = { x: number; y: number; z: number };

export const THROWAWAY = /^(minecraft:)?(cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff)$/;
/** throwaway kinds that are also natural ground */
const NATURAL = /^(minecraft:)?(andesite|diorite|granite|tuff)$/;
const AIR = /^(minecraft:)?(air|cave_air|void_air)$/;
/** hung on the side of a block */
const SIDE_ATTACHED = /(wall_torch|wall_sign|wall_hanging_sign|wall_banner|ladder|_button|lever|tripwire_hook)/;
/** hanging under a block */
const HANGS = /(lantern|chain|vine|hanging_sign|pointed_dripstone|spore_blossom|hanging_roots)/;

/** How far round the structure's box it looks: Baritone's pillars and bridges stand round the site, not only in it. */
export const TIDY_MARGIN = 6;
export const tidyBox = (b: Box): Box => ({
  x: b.x - TIDY_MARGIN, y: b.y - 2, z: b.z - TIDY_MARGIN,
  width: b.width + 2 * TIDY_MARGIN, height: b.height + 8, length: b.length + 2 * TIDY_MARGIN
});

const key = (p: P) => `${p.x},${p.y},${p.z}`;
const id = (s: string | null | undefined) => (s ?? '').replace(/\[.*$/, '');
const inside = (p: P, b: Box) => p.x >= b.x && p.y >= b.y && p.z >= b.z && p.x < b.x + b.width && p.y < b.y + b.height && p.z < b.z + b.length;

/** A region read (readBox order: x fastest, then z, then y) as a lookup. */
export function regionOf(blocks: (string | null)[], box: Box) {
  const at = (p: P): string | null | undefined => inside(p, box)
    ? blocks[(p.x - box.x) + (p.z - box.z) * box.width + (p.y - box.y) * box.width * box.length] : undefined;
  const each = function* (): Generator<[P, string]> {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b) continue;
      yield [{ x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length }, b];
    }
  };
  return { at, each };
}

/**
 * The throwaway blocks there are now: a job's baseline. With a `seed` (a baseline taken once a job was under way: the
 * structure's import), inside `seed.within` only the seed's are kept, and the natural kinds; outside it, all there are.
 */
export function baseline(blocks: (string | null)[], box: Box, seed?: { keep: string[]; within: Box }): string[] {
  const keep = new Set(seed?.keep ?? []);
  for (const [p, b] of regionOf(blocks, box).each()) {
    if (!THROWAWAY.test(id(b))) continue;
    if (!seed || !inside(p, seed.within) || NATURAL.test(id(b))) keep.add(key(p));
  }
  return [...keep];
}

const STEP: Record<string, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/**
 * The cells each of the design's doors opens onto, in front and behind, at both heights: they must stay walkable,
 * whatever stood there before the job (two cobblestone in front of the cottage's only door kept the bot out of its
 * house and it walled itself in outside every night).
 */
export function doorways(cells: { at: P; want: string }[]): Set<string> {
  const out = new Set<string>();
  for (const c of cells) {
    if (!/_door\[/.test(c.want) || !/half=lower/.test(c.want)) continue;
    const step = STEP[/facing=(\w+)/.exec(c.want)?.[1] ?? ''];
    if (!step) continue;
    for (const s of [1, -1]) for (const dy of [0, 1]) out.add(key({ x: c.at.x + s * step[0], y: c.at.y + dy, z: c.at.z + s * step[1] }));
  }
  return out;
}

/**
 * The scaffold to dig, top down: throwaway blocks not in the baseline, not cells the design manages (the diff sees to
 * those), with nothing standing on them, hanging from them or hung on their sides (a torch on a post stays).
 */
export function strays(blocks: (string | null)[], box: Box, keep: Set<string>, managed: Set<string>, skip: Set<string> = new Set()): P[] {
  const r = regionOf(blocks, box);
  const found: P[] = [];
  for (const [p, b] of r.each()) {
    const k = key(p);
    if (THROWAWAY.test(id(b)) && !keep.has(k) && !managed.has(k) && !skip.has(k)) found.push(p);
  }
  found.sort((a, b) => b.y - a.y || a.x - b.x || a.z - b.z);
  const gone = new Set<string>();
  const out: P[] = [];
  const clear = (p: P) => { const b = r.at(p); return gone.has(key(p)) || (b !== null && b !== undefined && AIR.test(id(b))) || b === undefined; };
  for (const p of found) {
    const above = { ...p, y: p.y + 1 };
    if (!clear(above)) continue;
    const below = r.at({ ...p, y: p.y - 1 });
    if (below && HANGS.test(id(below))) continue;
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => r.at({ x: p.x + dx, y: p.y, z: p.z + dz }));
    if (sides.some(s => s && (SIDE_ATTACHED.test(id(s)) || /lava/.test(id(s))))) continue;
    gone.add(key(p));
    out.push(p);
  }
  return out;
}

/** Feet and head room: air and the plants and bits a player walks through. */
const PASSABLE = /^(minecraft:)?(air|cave_air|short_grass|tall_grass|fern|large_fern|dead_bush|leaf_litter|dandelion|poppy|blue_orchid|allium|azure_bluet|[a-z_]*tulip|oxeye_daisy|cornflower|lily_of_the_valley|wildflowers|pink_petals|torch|wall_torch|snow)$/;
/** Not a floor to stand on: what's open, liquid, too tall (fences, walls, gates) or not solid. */
const NO_FLOOR = /(air$|water|lava|fence|_wall$|_gate|door|torch|sign|carpet|pressure_plate|button|lever|ladder|rail|_bed$|grass$|fern|flower|tulip|poppy|dandelion|petals|leaf_litter|snow$|vine|cobweb|campfire|lantern|chain)/;

/** Within this of the eye (survival reach is 4.5; a little short, for the aim). */
const REACH = 4.2;

/**
 * Where the bot can stand to dig `target` by hand: a solid floor with room for feet and head, the block within reach
 * of the eye (1.62 over the feet), not standing on the target or on scaffold it digs (`gone`). Nearest `from` first.
 */
export function standSpots(blocks: (string | null)[], box: Box, target: P, from: P, gone: Set<string> = new Set(), most = 4): P[] {
  const r = regionOf(blocks, box);
  const open = (p: P) => { const k = key(p); if (gone.has(k)) return true; const b = r.at(p); return b !== null && b !== undefined && PASSABLE.test(id(b)); };
  const floor = (p: P) => { const b = r.at(p); return !!b && !gone.has(key(p)) && !NO_FLOOR.test(id(b)) && key(p) !== key(target); };
  const out: { p: P; d: number }[] = [];
  for (let dy = -5; dy <= 1; dy++) for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    const p = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
    if (!open(p) || !open({ ...p, y: p.y + 1 }) || !floor({ ...p, y: p.y - 1 })) continue;
    const eye = { x: p.x + 0.5, y: p.y + 1.62, z: p.z + 0.5 };
    const near = (v: number, lo: number) => Math.max(lo, Math.min(lo + 1, v));
    const reach = Math.hypot(eye.x - near(eye.x, target.x), eye.y - near(eye.y, target.y), eye.z - near(eye.z, target.z));
    if (reach > REACH) continue;
    out.push({ p, d: Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) + reach * 0.25 });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, most).map(o => o.p);
}
