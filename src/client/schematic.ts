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
    if (ch === '.' || ch === ' ') return;
    const name = spec.palette[ch];
    if (!name) throw new Error(`layer ${y} row ${z} column ${x}: "${ch}" is not in the palette`);
    const state = blockState(name);
    if (!(state in palette)) palette[state] = Object.keys(palette).length;
    blocks[x + z * width + y * width * length] = palette[state];
    const item = state.replace(/^minecraft:/, '').replace(/\[.*$/, '');
    counts[item] = (counts[item] ?? 0) + 1;
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
