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
  /** what each home chest held when last opened, by "x,y,z" */
  chestItems?: Record<string, Record<string, number>>;
  /** when (ms) daily chores last ran, by chore */
  lastDone?: Record<string, number>;
  /** dark spots ("x,y,z") no torch of the lights round reached: left out from then on */
  darkIgnore?: string[];
  /** the long game: milestones done, the one in hand, its journal */
  progress?: import('./progress.js').ProgressMemory;
  /** places the projects made: storage, plots, pens, tree farm, mine entrance ... (kind -> boxes or points) */
  zones?: Record<string, { x: number; y: number; z: number; width?: number; length?: number }[]>;
  /** which home chest ("x,y,z") holds which kind of thing (storage.ts categories) */
  chestAssign?: Record<string, string>;
  /** the label on the sign over each chest ("x,y,z" -> "food1"), as put up or as found */
  chestSigns?: Record<string, string>;
  /** kinds of things with no room left in their chests: the storage needs another chest */
  storageFull?: string[];
  /** built cells ("x,y,z") the repair round failed to put back, and how often */
  repairFails?: Record<string, number>;
  /** the yard as it grows (x1..x2, z1..z2 at ground y) */
  yard?: { x1: number; z1: number; x2: number; z2: number; y: number };
  /** where the bot walks (paths.ts HeatMap.toJSON): its routes, lit by the lights round */
  heat?: import('./paths.js').HeatJSON;
  /** the yard grew past the fence on this side: the fence moves out (its old side comes down, the ring is rebuilt) */
  /** the yard box (x1,z1,x2,z2) the 2-block band outside the fence was last cleared for */
  fenceClearFor?: string;
  fenceMove?: { side: 'north' | 'south' | 'west' | 'east'; old: { x1: number; z1: number; x2: number; z2: number; y: number } };
}

export const DEFAULT_LEASH = 96;

/** The farm's middle, a block above the farmland. */
export function farmCentre(world: WorldMemory): { x: number; y: number; z: number } | undefined {
  const f = world.landmarks.farmland;
  if (!f.length) return undefined;
  const x = f.reduce((a, p) => a + p.x, 0) / f.length, z = f.reduce((a, p) => a + p.z, 0) / f.length;
  return { x: Math.round(x), y: f[0].y + 1, z: Math.round(z) };
}

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
