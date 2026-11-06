import type { Cell, Pos } from './format.js';

/**
 * What differs between a structure's cells and the world: the plan. Each managed cell is one of
 * - ok: it holds what it should (properties that change by themselves, like a door being open, don't count),
 * - place: it is empty (or holds something a block just replaces: grass, snow, water) and wants a block,
 * - replace: it holds another block (dig it, then place),
 * - restate: it holds the right block the wrong way round (a stair facing the wrong way: dig, then place),
 * - clear: it should be air and isn't,
 * - sign: the sign is there with other text.
 * Container contents never count: a chest is a chest.
 */

export type ChangeKind = 'ok' | 'place' | 'replace' | 'restate' | 'clear' | 'sign';
export interface Change { at: Pos; kind: ChangeKind; want: string; have: string; sign?: string[]; second?: boolean }

const AIR = /^(air|cave_air|void_air)$/;
/** What a placed block simply replaces. */
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|bush|firefly_bush|leaf_litter|snow|vine|glow_lichen|seagrass|tall_seagrass|fire|soul_fire|structure_void|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|allium|lily_of_the_valley|pink_petals|wildflowers)$/;
/** Properties that say how a block was placed; the rest change by themselves (open, powered, a fence's connections). */
const SIGNIFICANT = new Set(['facing', 'half', 'type', 'axis', 'part', 'rotation', 'face', 'attachment', 'hanging']);

const axisOf = (facing: string) => (facing === 'north' || facing === 'south' ? 'z' : 'x');

export function parse(state: string | null | undefined): { id: string; props: Record<string, string> } {
  const s = (state ?? '').replace(/^minecraft:/, '');
  const m = /^([^[]+)(?:\[(.*)\])?$/.exec(s);
  const props: Record<string, string> = {};
  for (const kv of (m?.[2] ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); props[k] = v; }
  return { id: m?.[1] ?? s, props };
}

/**
 * How `have` (the world) compares with `want`: 'same', 'state' (the block, placed another way), 'other' or 'empty'
 * (nothing a block can't just replace). Only the properties that say how it was placed count, and not a chest's
 * single/left/right (that's how chests side by side join).
 */
export function sameBlock(want: string, have: string | null | undefined): 'same' | 'state' | 'other' | 'empty' {
  const w = parse(want), h = parse(have);
  if (!h.id || REPLACEABLE.test(h.id)) return w.id === 'air' ? 'same' : 'empty';
  if (w.id === 'air') return 'other';
  if (w.id !== h.id) return 'other';
  for (const [k, v] of Object.entries(w.props)) {
    if (!SIGNIFICANT.has(k)) continue;
    if (k === 'type' && /chest$/.test(w.id)) continue; // single, left, right: how chests next to each other join
    // a gate faces whichever way it was last opened from: only its line (north-south or east-west) is how it was placed
    if (k === 'facing' && /_fence_gate$/.test(w.id) && h.props.facing && axisOf(h.props.facing) === axisOf(v)) continue;
    if (h.props[k] !== undefined && h.props[k] !== v) return 'state';
  }
  return 'same';
}

const clean = (lines: string[] | undefined) => {
  const l = (lines ?? []).map(s => s.trim());
  while (l.length && !l[l.length - 1]) l.pop();
  return l.join('\n');
};

/**
 * The changes, one per managed cell. `world` holds the block at each cell's position (same order as `cells`; null
 * where the chunk isn't loaded: counted as ok, unknown), `signText` the lines of the signs found, by "x,y,z".
 */
export function diff(cells: Cell[], world: (string | null)[], signText: Record<string, string[]> = {}): Change[] {
  return cells.map((c, i): Change => {
    const have = (world[i] ?? '').replace(/^minecraft:/, '');
    const base = { at: c.at, want: c.want, have, ...(c.sign ? { sign: c.sign } : {}), ...(c.second ? { second: true } : {}) };
    if (world[i] === null || world[i] === undefined) return { ...base, kind: 'ok' };
    // kept clear: plants, snow and water in it count too (an interior full of grass or flooded isn't clear)
    if (c.want === 'air') return { ...base, kind: !have || AIR.test(parse(have).id) ? 'ok' : 'clear' };
    const cmp = sameBlock(c.want, have);
    if (cmp === 'empty') return { ...base, kind: 'place' };
    if (cmp === 'other') return { ...base, kind: 'replace' };
    if (cmp === 'state') return { ...base, kind: 'restate' };
    if (c.sign && clean(signText[`${c.at.x},${c.at.y},${c.at.z}`]) !== clean(c.sign)) return { ...base, kind: 'sign' };
    return { ...base, kind: 'ok' };
  });
}

/** Counts by kind (second halves left out: they come with their other half). */
export function summary(changes: Change[]): Record<ChangeKind, number> {
  const out: Record<ChangeKind, number> = { ok: 0, place: 0, replace: 0, restate: 0, clear: 0, sign: 0 };
  for (const c of changes) if (!c.second) out[c.kind]++;
  return out;
}

/** The changes still to make (not ok, not second halves). */
export const pending = (changes: Change[]) => changes.filter(c => c.kind !== 'ok' && !c.second);
