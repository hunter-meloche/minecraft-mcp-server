import { parse } from './diff.js';
import type { Cell, Design, SignSpec } from './format.js';

/**
 * Scan into a design: what's built in a box becomes the design's cells, so a structure changed by hand (a chest put in,
 * a sign rewritten, a window knocked through) can be taken as it now is. Built blocks only (the user's choice):
 * natural ground under the floor and loose nature (grass, flowers, leaves, snow, water) are left unmanaged, and air
 * isn't managed either. A chest is its block and facing, never what's in it; a sign keeps its text.
 */

export interface Box { x: number; y: number; z: number; width: number; height: number; length: number }

/** Ground the world made: unmanaged where it's the bottom of a column (the terrain under a build). */
const NATURAL = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|mud|clay|sand|red_sand|gravel|stone|deepslate|granite|diorite|andesite|tuff|calcite|dripstone_block|bedrock|.*_ore|sandstone|red_sandstone|terracotta|snow_block|ice|packed_ice|moss_block|netherrack)$/;
/** Never part of a structure (crops too: they grow, and would read as drift every day). */
const LOOSE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|snow|vine|glow_lichen|seagrass|tall_seagrass|kelp|kelp_plant|fire|soul_fire|.*_leaves|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|pink_petals|wildflowers|sweet_berry_bush|.*_sapling|sugar_cane|bamboo|cactus|moss_carpet|structure_void|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|cocoa|nether_wart|torchflower_crop|pitcher_crop)$/;
/** Properties kept in an imported state: how it was placed (the rest change by themselves). */
const KEEP = new Set(['facing', 'half', 'type', 'axis', 'part', 'rotation', 'face', 'attachment', 'hanging']);

/** A world state as a design block: no namespace, only the properties that say how it was placed (not a chest's left/right). */
export function cleanState(state: string): string {
  const { id, props } = parse(state);
  const kept = Object.entries(props).filter(([k]) => KEEP.has(k) && !(k === 'type' && /chest$/.test(id)));
  return kept.length ? `${id}[${kept.map(([k, v]) => `${k}=${v}`).join(',')}]` : id;
}

/** Palette letters: the block's own initial where it's free, then the rest. */
function letters(states: string[]): Map<string, string> {
  const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&*+-=?@^_~<>/|';
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const s of states) {
    const id = parse(s).id;
    const initials = [...id.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|stone|cobblestone)_/, '')].filter(ch => /[a-z]/.test(ch));
    const pick = [initials[0]?.toUpperCase(), initials[0], ...pool].find(ch => ch && !used.has(ch));
    if (!pick) throw new Error('too many kinds of block to give each a letter');
    used.add(pick);
    out.set(s, pick);
  }
  return out;
}

/**
 * The design of what stands in `box`, and where its minimum corner is in the world (its anchor: the corner of what
 * was kept, not of the box). `blocks` as world.region gives them (x fastest, then z, then y), `signs` the sign text
 * found ("x,y,z" -> lines).
 */
export function importDesign(name: string, box: Box, blocks: (string | null)[], signs: Record<string, string[]>, opts: { keepTerrain?: boolean } = {}): { design: Design; anchor: { x: number; y: number; z: number } } {
  const { width: w, height: h, length: l } = box;
  const at = (x: number, y: number, z: number) => (blocks[x + z * w + y * w * l] ?? '').replace(/^minecraft:/, '');
  // the terrain under it: in each column, the natural blocks from the bottom up to the first that isn't
  const terrainTop = new Map<string, number>();
  if (!opts.keepTerrain) {
    for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h && NATURAL.test(parse(at(x, y, z)).id)) y++;
      terrainTop.set(`${x},${z}`, y);
    }
  }
  const kept: { x: number; y: number; z: number; state: string }[] = [];
  const signSpecs: SignSpec[] = [];
  for (let y = 0; y < h; y++) for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) {
    const raw = at(x, y, z);
    const id = parse(raw).id;
    if (!id || LOOSE.test(id)) continue;
    if (!opts.keepTerrain && y < (terrainTop.get(`${x},${z}`) ?? 0)) continue;
    const state = cleanState(raw);
    const lines = signs[`${box.x + x},${box.y + y},${box.z + z}`];
    if (/_sign$/.test(id) && lines) { signSpecs.push({ at: [x, y, z], block: state, lines: trimLines(lines) }); continue; }
    kept.push({ x, y, z, state });
  }
  // the top halves of doors and the heads of beds come with their other half
  const all = kept.filter(k => !/_door\[.*half=upper/.test(k.state) && !/_bed\[.*part=head/.test(k.state));
  if (!all.length && !signSpecs.length) throw new Error('nothing built in that box');
  // from the corner of what was kept
  const pts = [...kept, ...signSpecs.map(s => ({ x: s.at[0], y: s.at[1], z: s.at[2] }))];
  const o = { x: Math.min(...pts.map(p => p.x)), y: Math.min(...pts.map(p => p.y)), z: Math.min(...pts.map(p => p.z)) };
  const cells = all.map(k => ({ ...k, x: k.x - o.x, y: k.y - o.y, z: k.z - o.z }));
  for (const s of signSpecs) s.at = [s.at[0] - o.x, s.at[1] - o.y, s.at[2] - o.z];
  const size = { w: w - o.x, h: h - o.y, l: l - o.z };
  const byCount = new Map<string, number>();
  for (const k of cells) byCount.set(k.state, (byCount.get(k.state) ?? 0) + 1);
  const letter = letters([...byCount].sort((a, b) => b[1] - a[1]).map(([s]) => s));
  const grid = new Map(cells.map(k => [`${k.x},${k.y},${k.z}`, letter.get(k.state)!]));
  const rows: string[][] = [];
  for (let y = 0; y < size.h; y++) {
    const layer: string[] = [];
    for (let z = 0; z < size.l; z++) {
      let row = '';
      for (let x = 0; x < size.w; x++) row += grid.get(`${x},${y},${z}`) ?? ' ';
      layer.push(row.replace(/ +$/, ''));
    }
    rows.push(layer);
  }
  const design: Design = {
    version: 1, name,
    description: `imported from (${box.x}, ${box.y}, ${box.z}) ${w}x${h}x${l}`,
    palette: Object.fromEntries([...letter].map(([s, ch]) => [ch, s])),
    parts: [{ layers: { at: [0, 0, 0], rows } }],
    ...(signSpecs.length ? { signs: signSpecs } : {})
  };
  return { design, anchor: { x: box.x + o.x, y: box.y + o.y, z: box.z + o.z } };
}

const trimLines = (lines: string[]) => {
  const l = lines.map(s => s.trim());
  while (l.length && !l[l.length - 1]) l.pop();
  return l;
};

/** What an import changes against the structure's cells before it: cells added, taken out and changed, by kind. */
export function importChanges(before: Cell[], after: Cell[]): { added: Cell[]; removed: Cell[]; changed: { from: Cell; to: Cell }[] } {
  const k = (c: Cell) => `${c.at.x},${c.at.y},${c.at.z}`;
  const was = new Map(before.filter(c => c.want !== 'air').map(c => [k(c), c]));
  const now = new Map(after.filter(c => c.want !== 'air').map(c => [k(c), c]));
  const added = [...now.values()].filter(c => !was.has(k(c)));
  const removed = [...was.values()].filter(c => !now.has(k(c)));
  const changed = [...now.values()].filter(c => was.has(k(c)) && (cleanState(was.get(k(c))!.want) !== cleanState(c.want) || (was.get(k(c))!.sign ?? []).join('\n') !== (c.sign ?? []).join('\n')))
    .map(c => ({ from: was.get(k(c))!, to: c }));
  return { added, removed, changed };
}
