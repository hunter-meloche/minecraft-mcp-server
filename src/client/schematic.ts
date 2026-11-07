import zlib from 'zlib';
import nbt from 'prismarine-nbt';

/**
 * Structures as text, turned into Sponge schematic v2 (.schem) files Baritone's builder reads.
 *
 * A spec is a palette of single characters to block states, and layers from the bottom up; each layer is rows along
 * +z, each row characters along +x:
 *   { palette: { L: 'acacia_log[axis=y]', P: 'acacia_planks' },
 *     layers: [ ['LPPPL', 'P...P', 'LPPPL'], ... ] }
 * '.' means air: Baritone clears those cells. Rows of a layer may be shorter than the widest row (padded with air).
 */

export interface StructureSpec {
  palette: Record<string, string>;
  layers: string[][];
}

/** Minecraft 26.3's data version (from level.dat of a 26.3 world); stamped into the schematic. */
export const DATA_VERSION_26_3 = 5023;

export interface Schematic {
  width: number;
  height: number;
  length: number;
  palette: Record<string, number>;
  blocks: number[];
  counts: Record<string, number>;
}

function blockState(name: string): string {
  return name.includes(':') ? name : `minecraft:${name}`;
}

/** Check and lay out a spec: dimensions, palette ids, block indices (x + z*W + y*W*L), and block counts. */
/** A cell to leave as it is: Baritone's skip list holds structure_void, and the checks ignore it. */
export const LEAVE = 'minecraft:structure_void';

/** The half of a two-block block (door top, bed head) that appears when the other half is placed. */
export const secondHalf = (state: string): boolean => /_door\[.*half=upper/.test(state) || /_bed\[.*part=head/.test(state);

export function layoutSpec(spec: StructureSpec): Schematic {
  if (!spec.layers?.length) throw new Error('structure has no layers');
  for (const ch of Object.keys(spec.palette ?? {})) {
    if (ch.length !== 1 || ch === '.') throw new Error(`palette keys must be single characters other than '.': "${ch}"`);
  }
  const height = spec.layers.length;
  const length = Math.max(...spec.layers.map(l => l.length));
  const width = Math.max(...spec.layers.flatMap(l => l.map(r => r.length)));
  const palette: Record<string, number> = { 'minecraft:air': 0 };
  const counts: Record<string, number> = {};
  const blocks = new Array<number>(width * height * length).fill(0);
  spec.layers.forEach((layer, y) => layer.forEach((row, z) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    if (ch === ' ') { // leave whatever is there (Baritone skips structure_void)
      if (!(LEAVE in palette)) palette[LEAVE] = Object.keys(palette).length;
      blocks[x + z * width + y * width * length] = palette[LEAVE];
      return;
    }
    const name = spec.palette[ch];
    if (!name) throw new Error(`layer ${y} row ${z} column ${x}: "${ch}" is not in the palette`);
    const state = blockState(name);
    if (!(state in palette)) palette[state] = Object.keys(palette).length;
    blocks[x + z * width + y * width * length] = palette[state];
    const item = state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
    if (!secondHalf(state)) counts[item] = (counts[item] ?? 0) + 1; // one door or bed item fills both cells
  })));
  return { width, height, length, palette, blocks, counts };
}

/** Varint-encode block palette indices, as Sponge v2 BlockData expects. */
export function varints(values: number[]): number[] {
  const out: number[] = [];
  for (let v of values) {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      out.push(b > 127 ? b - 256 : b); // NBT byte arrays are signed
    } while (v !== 0);
  }
  return out;
}

/** Gzipped Sponge v2 schematic bytes. */
export function writeSchematic(s: Schematic, dataVersion = DATA_VERSION_26_3): Buffer {
  const paletteTag: Record<string, { type: 'int'; value: number }> = {};
  for (const [state, id] of Object.entries(s.palette)) paletteTag[state] = { type: 'int', value: id };
  const root = {
    type: 'compound',
    name: 'Schematic',
    value: {
      Version: { type: 'int', value: 2 },
      DataVersion: { type: 'int', value: dataVersion },
      Width: { type: 'short', value: s.width },
      Height: { type: 'short', value: s.height },
      Length: { type: 'short', value: s.length },
      PaletteMax: { type: 'int', value: Object.keys(s.palette).length },
      Palette: { type: 'compound', value: paletteTag },
      BlockData: { type: 'byteArray', value: varints(s.blocks) },
      Offset: { type: 'intArray', value: [0, 0, 0] }
    }
  };
  return zlib.gzipSync(nbt.writeUncompressed(root as unknown as nbt.NBT));
}

export interface BuildCheck {
  placed: number; total: number; missing: Record<string, number>;
  /** cells holding the right block in the wrong state (a stair facing the wrong way): breaking it gives the item back */
  misplaced: Record<string, number>;
}

/** Split "minecraft:oak_log[axis=y]" into its id (no namespace) and properties. */
export function parseState(state: string): { id: string; props: Record<string, string> } {
  const m = /^(?:minecraft:)?([^[]+)(?:\[(.*)\])?$/.exec(state);
  const props: Record<string, string> = {};
  for (const kv of (m?.[2] ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    props[k.trim()] = (v ?? '').trim();
  }
  return { id: m?.[1] ?? state, props };
}

/** The structure's blocks that the world doesn't have yet, bottom up (then x, then z), so supports come first. */
export function missingCells(layout: Schematic, world: (string | null)[]): Cell[] {
  const byIndex = new Map(Object.entries(layout.palette).map(([state, i]) => [i, { state, ...parseState(state) }]));
  const out: Cell[] = [];
  layout.blocks.forEach((p, i) => {
    if (p === 0) return;
    const want = byIndex.get(p)!;
    if (want.state === LEAVE) return;
    const got = world[i] ? parseState(world[i]!) : null;
    if (got && got.id === want.id && Object.entries(want.props).every(([k, v]) => got.props[k] === v)) return;
    const x = i % layout.width, z = Math.floor(i / layout.width) % layout.length, y = Math.floor(i / (layout.width * layout.length));
    out.push({ x, y, z, state: want.state, id: want.id, ...(want.props.facing ? { facing: want.props.facing } : {}), ...(lying(want.props) ? { axis: want.props.axis } : {}) });
  });
  return out.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
}

/**
 * Compare a laid-out structure with the blocks now in the world (`world`, same x-fastest, z, y order; null = not loaded).
 * Only the structure's blocks count, not its air, and only the properties the spec names (so `oak_log[axis=y]` must stand
 * upright, while plain `oak_planks` matches any planks state).
 */
export function checkBuild(layout: Schematic, world: (string | null)[]): BuildCheck {
  const byIndex = new Map(Object.entries(layout.palette).map(([state, i]) => [i, parseState(state)]));
  const byState = new Map(Object.entries(layout.palette).map(([state, i]) => [i, state]));
  const missing: Record<string, number> = {};
  const misplaced: Record<string, number> = {};
  let placed = 0, total = 0;
  layout.blocks.forEach((p, i) => {
    if (p === 0 || byState.get(p) === LEAVE) return;
    total++;
    const want = byIndex.get(p)!;
    const got = world[i] ? parseState(world[i]!) : null;
    if (got && got.id === want.id && Object.entries(want.props).every(([k, v]) => got.props[k] === v)) placed++;
    else if (!secondHalf(byState.get(p)!)) { // a missing door top or bed head needs no item of its own
      missing[want.id] = (missing[want.id] ?? 0) + 1;
      if (got?.id === want.id) misplaced[want.id] = (misplaced[want.id] ?? 0) + 1;
    }
  });
  return { placed, total, missing, misplaced };
}

export interface FacingCell { x: number; y: number; z: number; state: string; id: string; facing?: string; axis?: string }
/** A structure cell (relative to the minimum corner) and the block it wants. */
export interface Cell { x: number; y: number; z: number; state: string; id: string; facing?: string; axis?: string }

/** A log (pillar, column) lying on its side: Baritone pauses on it ("missing" with a stack in hand), so it's placed by hand. */
const lying = (props: Record<string, string>) => props.axis === 'x' || props.axis === 'z';

/**
 * Split a structure for building: Baritone gets every block except the ones with a `facing` (stairs on a roof edge must be
 * placed from outside the wall, which it can't stand at) and logs lying on their side (Baritone pauses on those as if it
 * had none), which become structure_void (Baritone's skip list holds it);
 * those come back as cells, bottom up, for build-structure to place itself with the right facing.
 */
export function splitDirectional(layout: Schematic): { baritone: Schematic; cells: FacingCell[] } {
  const palette: Record<string, number> = {};
  const remap = new Map<number, number>();
  const directional = new Map<number, string>();
  for (const [state, i] of Object.entries(layout.palette)) {
    const { props } = parseState(state);
    const byHand = !!props.facing || lying(props);
    const keep = byHand ? 'minecraft:structure_void' : state;
    if (byHand) directional.set(i, state);
    if (!(keep in palette)) palette[keep] = Object.keys(palette).length;
    remap.set(i, palette[keep]);
  }
  const cells: FacingCell[] = [];
  const blocks = layout.blocks.map((p, i) => {
    const state = directional.get(p);
    if (state) {
      const { id, props } = parseState(state);
      const x = i % layout.width, z = Math.floor(i / layout.width) % layout.length, y = Math.floor(i / (layout.width * layout.length));
      cells.push({ x, y, z, state, id, ...(props.facing ? { facing: props.facing } : {}), ...(lying(props) ? { axis: props.axis } : {}) });
    }
    return remap.get(p)!;
  });
  cells.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  return { baritone: { ...layout, palette, blocks }, cells };
}

const OPPOSITE: Record<string, string> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/**
 * Which way the player must face to place `id` with `facing`: stairs, doors, fence gates and beds face the way the player
 * looks; most others (furnaces, chests, observers...) face back at the player.
 */
export function placerFacing(id: string, facing: string): string {
  return /stairs|_door$|fence_gate|_bed$/.test(id) ? facing : (OPPOSITE[facing] ?? facing);
}

/** Turn the air cells `keep` picks into leave-as-is cells (blocks the bot placed there itself: a door, furniture). */
export function keepExisting(layout: Schematic, keep: (index: number) => boolean): Schematic {
  if (!layout.blocks.some((b, i) => b === 0 && keep(i))) return layout;
  const palette = { ...layout.palette };
  if (!(LEAVE in palette)) palette[LEAVE] = Object.keys(palette).length;
  return { ...layout, palette, blocks: layout.blocks.map((b, i) => b === 0 && keep(i) ? palette[LEAVE] : b) };
}
