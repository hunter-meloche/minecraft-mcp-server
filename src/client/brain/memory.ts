import fs from 'fs';
import path from 'path';

/**
 * What the brain remembers about its home, per world (like a villager's memories of its bed and job site): where the
 * bed, chests, furnace and crafting table are, found by looking around home once and kept across restarts.
 */

export interface Pos { x: number; y: number; z: number }

export interface Landmarks {
  bed?: Pos;
  chests: Pos[];
  furnace?: Pos;
  table?: Pos;
  /** farmland cells near home */
  farmland: Pos[];
  /** when these were looked for (ms) */
  foundAt?: number;
}

export interface WorldMemory {
  landmarks: Landmarks;
  /** how far from home a trip may go */
  leash: number;
}

export const DEFAULT_LEASH = 96;

export class BrainMemory {
  private data: Record<string, WorldMemory> = {};

  constructor(private file?: string) {
    if (file) {
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, WorldMemory>; } catch { /* first run */ }
    }
  }

  world(id: string): WorldMemory {
    this.data[id] ??= { landmarks: { chests: [], farmland: [] }, leash: DEFAULT_LEASH };
    const w = this.data[id];
    w.landmarks.chests ??= [];
    w.landmarks.farmland ??= [];
    w.leash ??= DEFAULT_LEASH;
    return w;
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
  }
}

const id = (b: string | null) => (b ?? '').replace(/^minecraft:/, '').replace(/\[.*$/, '');

/**
 * Find the landmarks in a box of blocks read with world.region (x fastest, then z, then y). The bed is its head half,
 * chests and furnaces all (the nearest to `home` first).
 */
export function findLandmarks(box: Pos & { width: number; height: number; length: number }, blocks: (string | null)[], home: Pos): Landmarks {
  const found: Landmarks = { chests: [], farmland: [] };
  const beds: Pos[] = [], furnaces: Pos[] = [], tables: Pos[] = [];
  blocks.forEach((b, i) => {
    const name = id(b);
    if (!name) return;
    const at = { x: box.x + i % box.width, y: box.y + Math.floor(i / (box.width * box.length)), z: box.z + Math.floor(i / box.width) % box.length };
    if (/_bed$/.test(name) && /part=head/.test(b ?? '')) beds.push(at);
    else if (name === 'chest' || name === 'barrel' || name === 'trapped_chest') found.chests.push(at);
    else if (name === 'furnace' || name === 'smoker' || name === 'blast_furnace') furnaces.push(at);
    else if (name === 'crafting_table') tables.push(at);
    else if (name === 'farmland') found.farmland.push(at);
  });
  const near = (a: Pos, b: Pos) => Math.hypot(a.x - home.x, a.y - home.y, a.z - home.z) - Math.hypot(b.x - home.x, b.y - home.y, b.z - home.z);
  found.chests.sort(near);
  found.bed = beds.sort(near)[0];
  found.furnace = furnaces.sort(near)[0];
  found.table = tables.sort(near)[0];
  return found;
}
